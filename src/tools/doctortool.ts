/**
 * spotify_doctor (#111 idea 9 + #228): the CLI `doctor` command (runDoctor in
 * index.ts) as an in-server TOOL so MCP agents can self-diagnose the most
 * common failure class — missing/expired tokens, scope gaps between the
 * auth-time grant and the write tools exposed by the active toolsets,
 * Premium gating they cannot introspect, and an active rate-limit cooldown.
 *
 * A diagnostic: ALWAYS succeeds. Every check becomes a pass/fail/warn/info
 * row; the report is "ok" when no row failed. Network is best-effort for
 * account info — local checks never require it.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  TOOLSETS,
  allRegistrationKeys,
  isModuleActive,
  resolveToolOverrides,
  resolveToolsets,
} from '../toolsets.js';
import { moduleBlockedByScopes } from '../scopefilter.js';
import { historyWriteStatus } from '../history.js';
import { ResponseFormat } from '../shaping.js';
import { readOnlyModeEnabled, REGISTRAR_MANIFEST } from './annotations.js';

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

type DoctorStatus = 'pass' | 'fail' | 'warn' | 'info';

interface DoctorRow {
  /** Stable check id, e.g. 'token', 'scopes', 'premium', 'rate_limit', 'config'. */
  id: string;
  status: DoctorStatus;
  /** One-line human summary (always rendered). */
  summary: string;
  /** Extra context rendered only in verbose prose mode. */
  detail?: string;
  /** Diagnostic phase that produced an exceptional row. */
  phase?: string;
  /** Machine-readable diagnostic message for probe failures. */
  message?: string;
}

interface DoctorReport {
  /** True when no row has status 'fail' (warns/infos don't fail a diagnostic). */
  ok: boolean;
  rows: DoctorRow[];
  surface: DoctorSurface;
}

interface DoctorSurface {
  registry_available: boolean;
  registered_tools: number;
  total_modules: number;
  active_modules: string[];
  exposed_modules: string[];
  hidden_by_trim: string[];
  hidden_by_scopes: string[];
  hidden_by_readonly: string[];
  active_sets: string[];
  inactive_sets: string[];
  unknown_toolsets: string[];
  enable_overrides: string[];
  disable_overrides: string[];
  unknown_enable_overrides: string[];
  unknown_disable_overrides: string[];
  read_only: boolean;
}


/** Status → glyph used by the prose renderer. */
const GLYPH: Record<DoctorStatus, string> = { pass: '✓', fail: '✗', warn: '⚠', info: 'ℹ' };

// ---------------------------------------------------------------------------
// Write-tool scope requirements, keyed by REGISTRATION KEY (same keys as
// src/toolsets.ts TOOLSETS entries) so gating follows the active toolsets.
// ---------------------------------------------------------------------------

interface WriteRequirement {
  key: string;
  /** Human description of what breaks when these scopes are missing. */
  label: string;
  tools: string;
  scopes: readonly string[];
}

const WRITE_REQUIREMENTS: readonly WriteRequirement[] = [
  {
    key: 'playback',
    label: 'playback control',
    tools: 'play, pause, seek, set_volume, skip_next/previous, set_repeat/shuffle',
    scopes: ['user-modify-playback-state'],
  },
  {
    key: 'playlists',
    label: 'playlist mutations',
    tools: 'create_playlist, track add/remove/reorder, upload_playlist_cover',
    scopes: ['playlist-modify-public', 'playlist-modify-private'],
  },
  {
    key: 'library',
    label: 'library mutations',
    tools: 'save_to_library, remove_from_library',
    scopes: ['user-library-modify'],
  },
  {
    key: 'following',
    label: 'artist follow state',
    tools: 'follow_artists, unfollow_artists',
    scopes: ['user-follow-modify'],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTtl(secLeft: number): string {
  if (secLeft <= 0) return `expired ${-secLeft}s ago — refresh due (next API call will auto-refresh; if refresh fails, re-run "spotify-mcp auth")`;
  if (secLeft < 60) return `expiring in ${secLeft}s`;
  const mins = Math.floor(secLeft / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `valid (~${hours}h ${mins % 60}m left)`;
  return `valid (~${mins}m left)`;
}

interface ParsedTokens {
  expires_at?: unknown;
  scope?: unknown;
  refresh_token?: unknown;
  access_token?: unknown;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Token + expiry + refresh-token check. Returns parsed JSON for downstream checks. */
async function tokenRows(): Promise<{ rows: DoctorRow[]; tokens: ParsedTokens | null }> {
  const tokenFile = getConfig().tokenFile;
  let raw: string;
  try {
    raw = await readFile(tokenFile, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      rows: [
        {
          id: 'token',
          status: 'fail',
          summary:
            code === 'ENOENT'
              ? `no token file at ${tokenFile} — run "spotify-mcp auth" first`
              : `token file ${tokenFile} unreadable (${err instanceof Error ? err.message : String(err)})`,
          detail: `token_file=${tokenFile}`,
        },
      ],
      tokens: null,
    };
  }

  let tokens: ParsedTokens;
  try {
    tokens = JSON.parse(raw) as ParsedTokens;
  } catch {
    return {
      rows: [
        {
          id: 'token',
          status: 'fail',
          summary: `token file ${tokenFile} is corrupted — run "spotify-mcp auth" again`,
          detail: `token_file=${tokenFile}`,
        },
      ],
      tokens: null,
    };
  }

  const rows: DoctorRow[] = [];

  // File path row (informational, always present when file exists)
  const hasRefresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0;

  if (typeof tokens.expires_at !== 'number') {
    rows.push({
      id: 'token',
      status: 'fail',
      summary: `token file ${tokenFile} has no numeric expires_at`,
      detail: `token_file=${tokenFile} refresh_token=${hasRefresh ? 'present' : 'missing'}`,
    });
    return { rows, tokens };
  }

  const secLeft = Math.round((tokens.expires_at - Date.now()) / 1000);
  const ttl = formatTtl(secLeft);
  const refreshNote = hasRefresh ? 'refresh_token present' : 'refresh_token MISSING — re-run auth';

  if (secLeft <= 0) {
    rows.push({
      id: 'token',
      status: 'warn',
      summary: `token EXPIRED (${ttl}) — file: ${tokenFile}`,
      detail: `expires_at=${new Date(tokens.expires_at).toISOString()} seconds_remaining=${secLeft} ${refreshNote} token_file=${tokenFile}`,
    });
  } else if (secLeft < 60) {
    rows.push({
      id: 'token',
      status: 'warn',
      summary: `token ${ttl} — file: ${tokenFile} — will auto-refresh on next use`,
      detail: `expires_at=${new Date(tokens.expires_at).toISOString()} seconds_remaining=${secLeft} ${refreshNote} token_file=${tokenFile}`,
    });
  } else {
    const mins = Math.floor(secLeft / 60);
    const hours = Math.floor(mins / 60);
    const compatTtl = `in ${hours}h ${mins % 60}m`;
    rows.push({
      id: 'token',
      status: 'pass',
      summary: `token valid, expires ${new Date(tokens.expires_at).toISOString()} (${compatTtl}, ${ttl}) — file: ${tokenFile}`,
      detail: `expires_at=${tokens.expires_at} seconds_remaining=${secLeft} ${refreshNote} token_file=${tokenFile}`,
    });
  }

  // Separate refresh-token row when missing (warn, not fail — token may still be valid)
  if (!hasRefresh) {
    rows.push({
      id: 'token_refresh',
      status: 'warn',
      summary: 'refresh_token missing — token cannot auto-refresh after expiry; re-run "spotify-mcp auth"',
    });
  }

  return { rows, tokens };
}

/** Auth-time scopes vs the write tools enabled by the active toolsets. */
function scopeRows(tokens: ParsedTokens | null, surface: DoctorSurface): DoctorRow[] {
  if (!tokens) return [];
  if (typeof tokens.scope !== 'string') {
    return [
      {
        id: 'scopes',
        status: 'warn',
        summary: 'scopes unknown (pre-upgrade token file) — cannot compare auth-time grant against write tools',
        detail: 'Re-run "spotify-mcp auth" to persist the granted scopes for this check.',
      },
    ];
  }

  const granted = new Set(tokens.scope.split(/\s+/).filter(Boolean));
  // Report granted scopes count vs default
  const grantedList = [...granted].sort().join(', ');

  const gaps: string[] = [];
  for (const req of WRITE_REQUIREMENTS) {
    if (!surface.exposed_modules.includes(req.key)) continue;
    const missing = req.scopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      gaps.push(`${req.label} (${req.tools}): missing ${missing.join(', ')}`);
    }
  }

  if (gaps.length === 0) {
    return [
      {
        id: 'scopes',
        status: 'pass',
        summary: `all write-requiring tools on the exposed surface are covered by the granted scopes (${granted.size} scopes)`,
        detail: `granted: ${grantedList}`,
      },
    ];
  }
  return [
    {
      id: 'scopes',
      status: 'warn',
      summary: `${gaps.length} write capability group(s) lack required scopes — affected tools will 403 until you re-run "spotify-mcp auth"`,
      detail: `${gaps.join('; ')} | granted: ${grantedList}`,
    },
  ];
}

/** Modules hidden by scope, keyed by the same scope-owner passed in index.ts. */
const SCOPE_OWNER_BY_MODULE: Record<string, string> = {
  playback: 'playback',
  queueops: 'playback',
  playbackext: 'playback',
  playbackintel: 'playback',
  exhaust2playback: 'playback',
  swarm3playback: 'playback',
  playlists: 'playlists',
  exhaust2playlists: 'playlists',
  exhaust2extra: 'playlists',
  playlisthealth: 'playlists',
  playlistbatch: 'playlists',
  playlistmisc: 'playlists',
  swarm3playlistops: 'playlists',
  swarm3snapshots: 'playlists',
  swarm4playlists: 'playlists',
  library: 'library',
  exhaust2misc: 'library',
  libraryanalytics: 'library',
  portability: 'library',
  episodemgmt: 'library',
  swarm3library: 'library',
  following: 'following',
};

const ALWAYS_REGISTERED_MODULES: readonly string[] = ['spotify_doctor', 'swarm3meta'];

interface ToolRegistryHolder {
  _registeredTools?: Record<string, { enabled?: boolean }>;
}

/**
 * Registration modules hidden in READONLY mode. Derived from the registrar
 * manifest's own `readOnlySafe` flag — the exact predicate `index.ts` applies
 * (`readOnly && module.readOnlySafe !== true`) — because a hand-copied list
 * silently drifts: the doctor happily reports a new write module as
 * always-visible, and a read-only one as hidden.
 */
// Lazy: annotations.ts imports this module, so touching REGISTRAR_MANIFEST at
// module scope reads it while it is still initialising (TDZ).
function readOnlyHiddenModules(): ReadonlySet<string> {
  return new Set(
    REGISTRAR_MANIFEST.filter((module) => module.readOnlySafe !== true).map((module) => module.registrationKey),
  );
}

function readOnlyEnabled(): boolean {
  return readOnlyModeEnabled();
}

function registeredToolCount(server: McpServer): { available: boolean; count: number } {
  const holder = server as unknown as ToolRegistryHolder;
  const registry = holder._registeredTools;
  if (!registry || typeof registry !== 'object') return { available: false, count: 0 };
  return {
    available: true,
    count: Object.values(registry).filter((tool) => tool?.enabled !== false).length,
  };
}

function surfaceFor(server: McpServer, tokens: ParsedTokens | null): DoctorSurface {
  const { available, count } = registeredToolCount(server);
  const toolsets = resolveToolsets(process.env.SPOTIFY_MCP_TOOLSETS);
  const overrides = resolveToolOverrides(
    process.env.SPOTIFY_MCP_ENABLE_TOOLS,
    process.env.SPOTIFY_MCP_DISABLE_TOOLS,
  );
  const allKeys = [...new Set([...allRegistrationKeys, ...ALWAYS_REGISTERED_MODULES])].sort();
  const alwaysActive = new Set<string>(ALWAYS_REGISTERED_MODULES);
  const activeModules = allKeys.filter(
    (key) => alwaysActive.has(key) || isModuleActive(key, toolsets.sets, overrides),
  );
  const activeModuleSet = new Set(activeModules);
  const granted = new Set(
    typeof tokens?.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [],
  );
  const hiddenByScopes = activeModules.filter((key) => {
    const scopeOwner = SCOPE_OWNER_BY_MODULE[key];
    return scopeOwner !== undefined && moduleBlockedByScopes(scopeOwner, granted);
  });
  const readOnly = readOnlyEnabled();
  const scopeHidden = new Set(hiddenByScopes);
  const readOnlyHidden = readOnly ? readOnlyHiddenModules() : new Set<string>();
  const hiddenByReadonly = readOnly
    ? activeModules.filter((key) => !scopeHidden.has(key) && readOnlyHidden.has(key))
    : [];
  const hiddenByReadonlySet = new Set(hiddenByReadonly);
  const exposedModules = activeModules.filter(
    (key) => !scopeHidden.has(key) && !hiddenByReadonlySet.has(key),
  );

  return {
    registry_available: available,
    registered_tools: count,
    total_modules: allKeys.length,
    active_modules: activeModules,
    exposed_modules: exposedModules,
    hidden_by_trim: allKeys.filter((key) => !activeModuleSet.has(key)),
    hidden_by_scopes: hiddenByScopes,
    hidden_by_readonly: hiddenByReadonly,
    active_sets: Object.keys(TOOLSETS).filter((set) => toolsets.sets.has(set)),
    inactive_sets: Object.keys(TOOLSETS).filter((set) => !toolsets.sets.has(set)),
    unknown_toolsets: toolsets.unknown,
    enable_overrides: [...overrides.enable].sort(),
    disable_overrides: [...overrides.disable].sort(),
    unknown_enable_overrides: overrides.unknown.enable,
    unknown_disable_overrides: overrides.unknown.disable,
    read_only: readOnly,
  };
}

function surfaceRow(surface: DoctorSurface): DoctorRow {
  const trim = surface.hidden_by_trim.length;
  const scopes = surface.hidden_by_scopes.length;
  const readonly = surface.hidden_by_readonly.length;
  const unknown = surface.unknown_toolsets.length
    + surface.unknown_enable_overrides.length
    + surface.unknown_disable_overrides.length;
  const details = [
    `active_sets=${surface.active_sets.join(',') || '(none)'}`,
    `inactive_sets=${surface.inactive_sets.join(',') || '(none)'}`,
    `hidden_by_trim=${surface.hidden_by_trim.join(',') || '(none)'}`,
    `hidden_by_scopes=${surface.hidden_by_scopes.join(',') || '(none)'}`,
    `hidden_by_readonly=${surface.hidden_by_readonly.join(',') || '(none)'}`,
    `enable_overrides=${surface.enable_overrides.join(',') || '(none)'}`,
    `disable_overrides=${surface.disable_overrides.join(',') || '(none)'}`,
    `read_only=${surface.read_only}`,
  ];
  if (unknown > 0) {
    details.push(
      `unknown_toolsets=${surface.unknown_toolsets.join(',') || '(none)'}`,
      `unknown_enable_overrides=${surface.unknown_enable_overrides.join(',') || '(none)'}`,
      `unknown_disable_overrides=${surface.unknown_disable_overrides.join(',') || '(none)'}`,
    );
  }
  return {
    id: 'surface',
    status: surface.registry_available
      ? surface.unknown_toolsets.length > 0 && surface.active_sets.length === 0
        ? 'fail'
        : trim + scopes + readonly + unknown > 0 ? 'warn' : 'pass'
      : 'fail',
    summary: surface.registry_available
      ? `live registry: ${surface.registered_tools} tool(s); toolset/overrides hide ${trim} module(s), scopes hide ${scopes}, READONLY hides ${readonly}${surface.unknown_toolsets.length > 0 ? `; unknown toolsets: ${surface.unknown_toolsets.join(',')}` : ''}`
      : 'live registry unavailable — registered tool count cannot be determined',
    detail: details.join(' '),
  };
}

/**
 * Mutation-history trail health (#591). The ledger is what history_search and
 * the undo family read, and a lost append is invisible in the file itself —
 * an unwritable directory leaves a trail that reads as complete. So the
 * resolved path and the write-failure count are reported here, and any lost
 * append is a `fail` row: the audit trail is not trustworthy.
 */
function historyRow(): DoctorRow {
  const history = historyWriteStatus();
  if (!history.enabled) {
    return {
      id: 'history',
      status: 'info',
      summary: `mutation history disabled — no audit trail is being written (${history.path})`,
    };
  }
  if (history.failures > 0) {
    return {
      id: 'history',
      status: 'fail',
      summary:
        `mutation history writes failed ${history.failures} time(s) — the trail at ` +
        `${history.path} is incomplete, so history_search and undo may be missing records`,
      detail: `last_failure=${history.last_failure ?? 'unknown'}`,
    };
  }
  return {
    id: 'history',
    status: 'pass',
    summary: `mutation history enabled — ${history.path} (0 write failures)`,
  };
}

function staticRows(client: SpotifyClient): DoctorRow[] {
  const rows: DoctorRow[] = [];

  rows.push({
    id: 'premium',
    status: 'info',
    summary:
      'Premium requirement not introspectable from local state alone: playback control (play/pause/seek/volume/queue) requires Premium — verify via get_me product field or run doctor with live probe',
  });
  try {
    const rl = client.getRateLimitStatus();
    const usage = 'requestsTotal' in rl && typeof rl.requestsTotal === 'number'
      ? `requests_total=${rl.requestsTotal} requests_last_min=${rl.requestsLastMinute ?? 'n/a'} requests_last_hour=${rl.requestsLastHour ?? 'n/a'}`
      : null;
    if (rl.cooldownRemainingMs > 0) {
      rows.push({
        id: 'rate_limit',
        status: 'warn',
        summary: `rate-limit cooldown active — requests wait ${Math.ceil(rl.cooldownRemainingMs / 1000)}s more${usage ? ` (${usage})` : ''}`,
        detail: `lastThrottleAt=${rl.lastThrottleAt ? new Date(rl.lastThrottleAt).toISOString() : 'n/a'} retryAfterSec=${rl.retryAfterSec ?? 'n/a'}${usage ? ` ${usage}` : ''}`,
      });
    } else {
      rows.push({
        id: 'rate_limit',
        status: 'pass',
        summary: usage ? `no active rate-limit cooldown (${usage})` : 'no active rate-limit cooldown',
      });
    }
  } catch {
    // Stub/test clients without the accessor: skip the row entirely.
  }

  const cfg = getConfig();
  const parts = [
    `token_file=${cfg.tokenFile}`,
    `fetch_all_cap=${cfg.fetchAllCap}`,
    `max_items=${cfg.maxItems}`,
    `history=${cfg.historyEnabled ? 'enabled' : 'disabled'}`,
  ];
  if (cfg.profile) parts.push(`profile=${cfg.profile}`);
  if (cfg.market) parts.push(`market=${cfg.market}`);
  if (cfg.scopes) parts.push(`scopes_override=${cfg.scopes.join(',')}`);
  rows.push({
    id: 'config',
    status: 'pass',
    summary: parts.join(' '),
  });

  rows.push(historyRow());

  return rows;
}

/** Live account probe: report classified failures rather than silently omitting them. */
async function accountRows(client: SpotifyClient): Promise<DoctorRow[]> {
  try {
    const me = await client.get<{
      id?: string;
      display_name?: string;
      product?: string;
      country?: string;
    }>('/me');
    if (!me?.id) {
      return [{
        id: 'account_probe',
        status: 'info',
        phase: 'account_probe',
        message: 'live probe returned no account id',
        summary: 'live probe returned no account id',
      }];
    }
    const rows: DoctorRow[] = [];
    const product = me.product ?? 'unknown';
    const country = me.country ?? 'unknown';
    const name = me.display_name ?? me.id;
    rows.push({
      id: 'account',
      status: 'info',
      summary: `account: ${name} (${me.id}) product=${product} country=${country}`,
      detail: `display_name=${name} id=${me.id} product=${product} country=${country}`,
    });
    if (product === 'free' || product === 'open') {
      rows.push({
        id: 'account_premium',
        status: 'info',
        summary: 'account is Free — playback control (play/pause/skip/seek/volume/queue) will 403; Premium required for those tools',
      });
    } else if (product === 'premium') {
      rows.push({
        id: 'account_premium',
        status: 'pass',
        summary: 'account is Premium — playback control available',
      });
    }
    return rows;
  } catch (error) {
    if (error instanceof SpotifyApiError) {
      const message = `live probe failed: ${error.status} ${error.message}`;
      if (error.status === 401 || error.status === 403) {
        return [{
          id: 'account_probe',
          status: 'fail',
          phase: 'account_probe',
          message,
          summary: `${message} — token rejected; re-run "spotify-mcp auth"`,
        }];
      }
      if (error.status === 429) {
        const wait = error.retryAfterSec == null ? '' : `; retry after ${error.retryAfterSec}s`;
        return [{
          id: 'account_probe',
          status: 'warn',
          phase: 'account_probe',
          message,
          summary: `${message}${wait}`,
        }];
      }
      if (error.status === 408) {
        return [{
          id: 'account_probe',
          status: 'info',
          phase: 'account_probe',
          message: `live probe skipped (network timeout): ${error.message}`,
          summary: `live probe skipped (network timeout): ${error.message}`,
        }];
      }
      return [{
        id: 'account_probe',
        status: 'fail',
        phase: 'account_probe',
        message,
        summary: message,
      }];
    }
    const message = error instanceof Error ? error.message : String(error);
    return [{
      id: 'account_probe',
      status: 'info',
      phase: 'account_probe',
      message: `live probe skipped (network): ${message}`,
      summary: `live probe skipped (network): ${message}`,
    }];
  }
}

/** Run every doctor check. Includes best-effort live account probe when client is network-capable. */
async function collectDoctorReport(
  client: SpotifyClient,
  server?: McpServer,
): Promise<DoctorReport> {
  const tokens = await tokenRows();
  const surface = server
    ? surfaceFor(server, tokens.tokens)
    : {
      registry_available: false,
      registered_tools: 0,
      total_modules: new Set([...allRegistrationKeys, ...ALWAYS_REGISTERED_MODULES]).size,
      active_modules: [],
      exposed_modules: [],
      hidden_by_trim: [],
      hidden_by_scopes: [],
      hidden_by_readonly: [],
      active_sets: [],
      inactive_sets: Object.keys(TOOLSETS),
      unknown_toolsets: [],
      enable_overrides: [],
      disable_overrides: [],
      unknown_enable_overrides: [],
      unknown_disable_overrides: [],
      read_only: readOnlyEnabled(),
    } satisfies DoctorSurface;
  const account = await accountRows(client);
  const rows = [
    ...tokens.rows,
    ...scopeRows(tokens.tokens, surface),
    ...account,
    ...staticRows(client),
    surfaceRow(surface),
  ];
  return { ok: rows.every((row) => row.status !== 'fail'), rows, surface };
}

// ---------------------------------------------------------------------------
// Rendering + registration
// ---------------------------------------------------------------------------

function renderProse(report: DoctorReport, verbose: boolean): string {
  const lines = [`Spotify doctor — ${report.rows.length} check(s), ${report.ok ? 'no failures' : 'FAILURES PRESENT'}`, ''];
  for (const row of report.rows) {
    lines.push(`${GLYPH[row.status]} [${row.id}] ${row.summary}`);
    if (verbose && row.detail) lines.push(`    ${row.detail}`);
  }
  return lines.join('\n');
}

/**
 * Register the single `spotify_doctor` diagnostic tool. No gating: a doctor
 * must be reachable even when every other toolset is trimmed away.
 */
export function registerDoctorTool(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'spotify_doctor',
    'Run read-only diagnostics: token presence/expiry, auth-time scopes vs write tools enabled by active toolsets, Premium gating, rate-limit cooldown, config state, visible account details when reachable, and the live registered-tool surface with toolset/scope/READONLY trim causes. The only live request is GET /me; no mutation requests are issued.',
    {
      verbose: z
        .boolean()
        .optional()
        .describe('Include per-check technical detail lines when response_format is concise'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const report = await collectDoctorReport(client, server);
      const text = args.response_format === 'json'
        ? JSON.stringify(report, null, 2)
        : renderProse(
          report,
          args.response_format === 'detailed' || args.verbose === true,
        );
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...report },
      };
    },
  );
}
