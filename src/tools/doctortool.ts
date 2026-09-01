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
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { resolveToolsets, isActive } from '../toolsets.js';
import { ResponseFormat } from '../shaping.js';

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

export type DoctorStatus = 'pass' | 'fail' | 'warn' | 'info';

export interface DoctorRow {
  /** Stable check id, e.g. 'token', 'scopes', 'premium', 'rate_limit', 'config'. */
  id: string;
  status: DoctorStatus;
  /** One-line human summary (always rendered). */
  summary: string;
  /** Extra context rendered only in verbose prose mode. */
  detail?: string;
}

export interface DoctorReport {
  /** True when no row has status 'fail' (warns/infos don't fail a diagnostic). */
  ok: boolean;
  rows: DoctorRow[];
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
function scopeRows(tokens: ParsedTokens | null): DoctorRow[] {
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
  const { sets: activeSets } = resolveToolsets(process.env.SPOTIFY_MCP_TOOLSETS);

  // Report granted scopes count vs default
  const grantedList = [...granted].sort().join(', ');

  const gaps: string[] = [];
  for (const req of WRITE_REQUIREMENTS) {
    if (!isActive(req.key, activeSets)) continue;
    const missing = req.scopes.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      gaps.push(`${req.label} (${req.tools}): missing ${missing.join(', ')}`);
    }
  }

  if (gaps.length === 0) {
    return [
      {
        id: 'scopes',
        status: 'pass',
        summary: `all write-requiring tools across active toolsets are covered by the granted scopes (${granted.size} scopes)`,
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
    if (rl.cooldownRemainingMs > 0) {
      rows.push({
        id: 'rate_limit',
        status: 'warn',
        summary: `rate-limit cooldown active — requests wait ${Math.ceil(rl.cooldownRemainingMs / 1000)}s more`,
        detail: `lastThrottleAt=${rl.lastThrottleAt ? new Date(rl.lastThrottleAt).toISOString() : 'n/a'} retryAfterSec=${rl.retryAfterSec ?? 'n/a'}`,
      });
    } else {
      rows.push({ id: 'rate_limit', status: 'pass', summary: 'no active rate-limit cooldown' });
    }
  } catch {
    // Stub/test clients without the accessor: skip the row entirely.
  }

  // Config snapshot summary — include profile/market/scopes.
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

  return rows;
}

/** Best-effort account probe: GET /me for product/country/display name. Never fails health. */
async function accountRows(client: SpotifyClient): Promise<DoctorRow[]> {
  try {
    const me = await client.get<{
      id?: string;
      display_name?: string;
      product?: string;
      country?: string;
    }>('/me');
    if (!me || !me.id) return [];
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
  } catch {
    // Network unavailable or not authenticated — skip silently, local checks still valid.
    return [];
  }
}

/** Run every doctor check. Includes best-effort live account probe when client is network-capable. */
export async function collectDoctorReport(client: SpotifyClient): Promise<DoctorReport> {
  const t = await tokenRows();
  const account = await accountRows(client);
  const rows = [...t.rows, ...scopeRows(t.tokens), ...account, ...staticRows(client)];
  return { ok: rows.every((r) => r.status !== 'fail'), rows };
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
    'Run local diagnostics: token presence/expiry, auth-time scopes vs write tools enabled by active toolsets, Premium gating notes, rate-limit cooldown, and a config snapshot. Read-only, best-effort live account probe for product/country when network available.',
    {
      verbose: z
        .boolean()
        .optional()
        .describe('Include per-check technical detail lines in the prose output'),
      response_format: z.enum(['concise','detailed','json']).optional().describe('Response format: concise (default) returns human-readable text, detailed adds metadata, json returns structured data'),
    },
    async (args) => {
      const report = await collectDoctorReport(client);
      return {
        content: [{ type: 'text', text: renderProse(report, args.verbose === true) }],
        structuredContent: { ...report },
      };
    },
  );
}
