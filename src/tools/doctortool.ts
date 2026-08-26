/**
 * spotify_doctor (#111 idea 9): the CLI `doctor` command (runDoctor in
 * index.ts) as an in-server TOOL so MCP agents can self-diagnose the most
 * common failure class — missing/expired tokens, scope gaps between the
 * auth-time grant and the write tools exposed by the active toolsets,
 * Premium gating they cannot introspect, and an active rate-limit cooldown.
 *
 * A diagnostic: ALWAYS succeeds. Every check becomes a pass/fail/warn/info
 * row; the report is "ok" when no row failed. Never touches the network —
 * unlike the CLI probe, this reads local state only.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { resolveToolsets, isActive } from '../toolsets.js';

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
// Checks
// ---------------------------------------------------------------------------

interface ParsedTokens {
  expires_at?: unknown;
  scope?: unknown;
}

/** Token + expiry check. Returns the parsed token JSON for downstream checks. */
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
        },
      ],
      tokens: null,
    };
  }

  if (typeof tokens.expires_at !== 'number') {
    return {
      rows: [
        {
          id: 'token',
          status: 'fail',
          summary: `token file ${tokenFile} has no numeric expires_at`,
        },
      ],
      tokens,
    };
  }

  const secLeft = Math.round((tokens.expires_at - Date.now()) / 1000);
  if (secLeft <= 0) {
    return {
      rows: [
        {
          id: 'token',
          status: 'warn',
          summary: `token EXPIRED (${new Date(tokens.expires_at).toISOString()}, ${-secLeft}s ago) — next API call attempts an automatic refresh`,
          detail: `expires_at=${tokens.expires_at} seconds_remaining=${secLeft}`,
        },
      ],
      tokens,
    };
  }
  if (secLeft < 60) {
    return {
      rows: [
        {
          id: 'token',
          status: 'warn',
          summary: `token expiring in ${secLeft}s — will auto-refresh on next use`,
          detail: `expires_at=${new Date(tokens.expires_at).toISOString()} seconds_remaining=${secLeft}`,
        },
      ],
      tokens,
    };
  }
  return {
    rows: [
      {
        id: 'token',
        status: 'pass',
        summary: `token valid, expires ${new Date(tokens.expires_at).toISOString()} (in ${Math.floor(secLeft / 3600)}h ${Math.floor((secLeft % 3600) / 60)}m)`,
        detail: `expires_at=${tokens.expires_at} seconds_remaining=${secLeft}`,
      },
    ],
    tokens,
  };
}

/** Auth-time scopes vs the write tools enabled by the active toolsets. */
function scopeRows(tokens: ParsedTokens | null): DoctorRow[] {
  if (!tokens) return [];
  // TokenData historically persisted no `scope` field; newer saves may carry
  // the raw space-separated grant alongside the tokens.
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
        summary: 'all write-requiring tools across active toolsets are covered by the auth-time scopes',
      },
    ];
  }
  return [
    {
      id: 'scopes',
      status: 'warn',
      summary: `${gaps.length} write capability group(s) lack required scopes — affected tools will 403 until you re-run "spotify-mcp auth"`,
      detail: gaps.join('; '),
    },
  ];
}

function staticRows(client: SpotifyClient): DoctorRow[] {
  const rows: DoctorRow[] = [];

  // Premium gating cannot be introspected from local state — point at the
  // profile field that can answer it.
  rows.push({
    id: 'premium',
    status: 'info',
    summary:
      'Premium requirement not introspectable: set_volume/seek need a Premium account — verify via get_me (product field should be "premium")',
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

  // Config snapshot summary.
  const cfg = getConfig();
  rows.push({
    id: 'config',
    status: 'pass',
    summary: `token_file=${cfg.tokenFile} fetch_all_cap=${cfg.fetchAllCap} max_items=${cfg.maxItems} history=${cfg.historyEnabled ? 'enabled' : 'disabled'}`,
  });

  return rows;
}

/** Run every doctor check against local state (never the network). */
export async function collectDoctorReport(client: SpotifyClient): Promise<DoctorReport> {
  const t = await tokenRows();
  const rows = [...t.rows, ...scopeRows(t.tokens), ...staticRows(client)];
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
    'Run local diagnostics: token presence/expiry, auth-time scopes vs write tools enabled by active toolsets, Premium gating notes, rate-limit cooldown, and a config snapshot. Read-only, never calls the Spotify API.',
    {
      verbose: z
        .boolean()
        .optional()
        .describe('Include per-check technical detail lines in the prose output'),
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
