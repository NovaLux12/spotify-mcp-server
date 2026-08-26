/**
 * freshness radar (#112 idea 2): personal replacement for the removed
 * /browse/new-releases surface. Derives "what's new" from what the user
 * already follows:
 *   albums   — followed artists → newest album page per artist
 *   podcasts — saved shows → newest episode page per show
 *
 * A local watermark file (SPOTIFY_MCP_FRESHNESS_STATE,
 * default ~/.spotify-mcp/freshness.json) supports since='last-check' so
 * agents can ask "everything since I last checked" without tracking dates
 * themselves. After a successful non-dry run the watermark advances to
 * today (UTC) — but only when the scan completed without cap truncation (#239).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import type {
  FollowedArtistsResponse,
  SavedShowItem,
  SpotifyAlbumItem,
  SpotifyEpisodeSimple,
} from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  DryRun,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import type { ResponseFormatValue, PaginationInfo } from '../shaping.js';
import { getConfig } from '../config.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Date + watermark helpers (pure local I/O; no network)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date as YYYY-MM-DD in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** UTC date N days back, YYYY-MM-DD. */
function daysBack(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize Spotify release-date precision ("2026", "2026-05",
 * "2026-05-17") to a comparable YYYY-MM-DD lower bound. Year/month-only
 * dates pad with 01 so they are treated as their earliest possible day —
 * inclusive when filtering against a cutoff.
 */
export function normalizeReleaseDate(raw: string): string {
  if (/^\d{4}$/.test(raw)) return `${raw}-01-01`;
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  return raw.slice(0, 10);
}

function watermarkFilePath(): string {
  return (
    process.env.SPOTIFY_MCP_FRESHNESS_STATE ??
    join(homedir(), '.spotify-mcp', 'freshness.json')
  );
}

/** Read the stored watermark ({ last_check: "YYYY-MM-DD" }), or null. */
async function readWatermark(): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(watermarkFilePath(), 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { last_check?: unknown }).last_check === 'string'
    ) {
      return (parsed as { last_check: string }).last_check;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically advance the watermark to `date`. Temp-file + rename keeps the
 * update crash-safe; the temp file is created 0600 so the final file is too.
 */
async function writeWatermark(date: string): Promise<void> {
  const target = watermarkFilePath();
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify({ last_check: date }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isQuotaError(err: unknown): { quota: boolean; retryAfter: number | undefined } {
  if (err instanceof SpotifyApiError && err.status === 429 && err.reason === 'QUOTA_EXCEEDED') {
    return { quota: true, retryAfter: err.retryAfterSec };
  }
  // Also handle plain objects thrown by test stubs mimicking the shape.
  if (
    err !== null && typeof err === 'object' &&
    (err as { status?: unknown; reason?: unknown }).status === 429 &&
    (err as { reason?: unknown }).reason === 'QUOTA_EXCEEDED'
  ) {
    const ra = (err as { retryAfterSec?: unknown }).retryAfterSec;
    return { quota: true, retryAfter: typeof ra === 'number' ? ra : undefined };
  }
  return { quota: false, retryAfter: undefined };
}

// ---------------------------------------------------------------------------
// Result shaping (same composition pattern as tools/following.ts)
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function shapeResult(
  rf: ResponseFormatValue,
  prose: string,
  payload: Record<string, unknown>,
): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

interface NewReleaseHit {
  kind: 'album' | 'episode';
  id: string;
  name: string;
  uri: string;
  release_date: string;
  /** Normalized YYYY-MM-DD used for cutoff comparison + sorting. */
  date_key: string;
  album_type?: string;
  artist_names?: string[];
  show_name?: string;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerFreshnessTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'whats_new',
    "Personal new-releases radar: derive what's new from followed artists (new albums/singles) "
      + 'and saved shows (new podcast episodes), replacing the removed browse/new-releases surface. '
      + 'WARNING: N followed artists = N+1 API requests (1 follow page + N album lookups); '
      + 'a large library can exhaust small dev-account quotas in one call. Use max_artists to budget '
      + 'and dry_run to preview the cost before running.',
    {
      since: z
        .union([z.string().regex(ISO_DATE_RE, 'Use YYYY-MM-DD or "last-check"'), z.literal('last-check')])
        .optional()
        .describe(
          "Only include releases on/after this date (YYYY-MM-DD), or 'last-check' to resume from "
            + "the stored watermark file (default path ~/.spotify-mcp/freshness.json)",
        ),
      days_back: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .describe('Look this many days back when `since` is omitted. Default: 30'),
      kinds: z
        .array(z.enum(['albums', 'podcasts']))
        .max(2)
        .optional()
        .describe("Which sources to scan. Default: ['albums','podcasts']"),
      max_artists: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          'Per-call budget for artist album lookups (and show episode lookups). Default: 25 '
            + '(or SPOTIFY_MCP_FRESHNESS_BUDGET). Walk caps at this budget and reports truncation. '
            + 'Independent of SPOTIFY_MCP_FETCH_ALL_CAP. WARNING: each lookup is an API request.',
        ),
      response_format: ResponseFormat,
      max_results: MaxResults,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format;
      const kinds = args.kinds ?? ['albums', 'podcasts'];
      const wantAlbums = kinds.includes('albums');
      const wantPodcasts = kinds.includes('podcasts');
      const freshnessBudget = args.max_artists ?? getConfig().freshnessBudget;

      // ---- Cutoff resolution -------------------------------------------------
      let previousWatermark: string | null = null;
      let cutoff: string;
      if (args.since === 'last-check') {
        previousWatermark = await readWatermark();
        cutoff = previousWatermark ?? daysBack(args.days_back ?? 30);
      } else if (args.since) {
        cutoff = args.since;
      } else {
        cutoff = daysBack(args.days_back ?? 30);
      }

      // ---- dry_run: describe the plan, make zero API calls -------------------
      if (args.dry_run) {
        const plan: string[] = [];
        if (wantAlbums) {
          plan.push('walk GET /me/following?type=artist (cursor-paged)');
          plan.push(
            `GET /artists/{id}/albums?limit=10 (Feb-2026 cap) for up to ${freshnessBudget} followed artists (budget max_artists=${freshnessBudget}, fetchAllCap=${getConfig().fetchAllCap})`,
          );
        }
        if (wantPodcasts) {
          plan.push('list saved shows via GET /me/shows');
          plan.push(`GET /shows/{id}/episodes?limit=10 for up to ${freshnessBudget} saved shows (budget max_artists=${freshnessBudget})`);
        }
        plan.push(`advance watermark to ${todayUtc()} (${watermarkFilePath()}) — only if scan completes without cap truncation or quota hit; otherwise watermark held`);
        // Cost estimate line required by #242 — must mention N+1 requests and budget.
        // Since dry_run makes zero API calls, we can only describe the cost model
        // plus the concrete budget cap — the actual followed count is unknown.
        const costEstimateParts: string[] = [];
        if (wantAlbums) {
          costEstimateParts.push(
            `albums: N followed artists → N+1 requests (1 follow page + N album lookups), capped at max_artists=${freshnessBudget} lookups → at most ${freshnessBudget + 1} requests for albums`,
          );
        }
        if (wantPodcasts) {
          costEstimateParts.push(
            `podcasts: M saved shows → M+1 requests (1 show listing + M episode lookups), capped at max_artists=${freshnessBudget} lookups`,
          );
        }
        const costEstimate = costEstimateParts.join('; ');
        const prose =
          `[dry run] whats_new preview — no API calls were made and nothing was changed.\n`
          + `Cutoff: releases on/after ${cutoff}\n`
          + `Kinds: ${kinds.join(', ')}\n`
          + `Cost estimate: ${costEstimate} (budget: max_artists=${freshnessBudget}).\n`
          + `Followed/show counts unknown until executed; walk will cap lookups at max_artists=${freshnessBudget}.\n`
          + 'Planned lookups:\n'
          + plan.map((step) => `  • ${step}`).join('\n');
        return shapeResult(rf, prose, {
          ok: true,
          dry_run: true,
          cutoff,
          kinds,
          previous_watermark: previousWatermark,
          cost_estimate: costEstimate,
          max_artists: freshnessBudget,
          plan,
        });
      }

      const lookupCap = getConfig().fetchAllCap;
      // Effective per-source caps — budget is independent of fetchAllCap but
      // both apply (the smaller wins). Keeps existing FETCH_ALL_CAP semantics
      // while adding the quota budget.
      const artistCap = Math.min(lookupCap, freshnessBudget);
      const showCap = Math.min(lookupCap, freshnessBudget);

      // ---- Albums path: followed artists → newest album page per artist -----
      const albums: NewReleaseHit[] = [];
      let artistLookups = 0;
      let artistsSeen = 0;
      let followTruncatedByCap = false;
      let quotaHit = false;
      let quotaRetryAfter: number | undefined;
      let quotaScannedArtists = 0;

      if (wantAlbums) {
        let after: string | null = null;
        walk: for (;;) {
          if (artistLookups >= artistCap) {
            followTruncatedByCap = after !== null;
            break;
          }
          const params: Record<string, string> = { type: 'artist', limit: '50' };
          if (after) params.after = after;
          let page: FollowedArtistsResponse | null;
          try {
            page = await client.get<FollowedArtistsResponse>('/me/following', params);
          } catch (err) {
            const q = isQuotaError(err);
            if (q.quota) {
              quotaHit = true;
              quotaRetryAfter = q.retryAfter;
              quotaScannedArtists = artistsSeen;
              break;
            }
            throw err;
          }
          if (!page?.artists || !Array.isArray(page.artists.items)) break;
          for (const artist of page.artists.items) {
            if (artistLookups >= artistCap) {
              followTruncatedByCap = true;
              break walk;
            }
            try {
              const res = await client.get<{ items?: SpotifyAlbumItem[] }>(
                `/artists/${encodeURIComponent(artist.id)}/albums`,
                { limit: '10' },
              );
              artistLookups++;
              artistsSeen++;
              for (const album of res?.items ?? []) {
                const dateKey = normalizeReleaseDate(album.release_date ?? '');
                if (!ISO_DATE_RE.test(dateKey) || dateKey < cutoff) continue;
                albums.push({
                  kind: 'album',
                  id: album.id,
                  name: album.name,
                  uri: album.uri,
                  release_date: album.release_date,
                  date_key: dateKey,
                  album_type: album.album_type,
                  artist_names: (album.artists ?? []).map((a) => a.name),
                });
              }
            } catch (err) {
              const q = isQuotaError(err);
              if (q.quota) {
                quotaHit = true;
                quotaRetryAfter = q.retryAfter;
                quotaScannedArtists = artistsSeen;
                break walk;
              }
              throw err;
            }
          }
          after = page.artists.cursors?.after ?? null;
          if (!after) break;
        }
      }

      // ---- Podcasts path: saved shows → newest episode page per show --------
      const episodes: NewReleaseHit[] = [];
      let showLookups = 0;
      let showsSeen = 0;
      let showsTruncatedByCap = false;
      // If quota was hit during albums, skip podcast lookups — quota window
      // won't recover within this call; preserve partial album results instead.
      if (wantPodcasts && !quotaHit) {
        let savedShows: SavedShowItem[];
        try {
          savedShows = await client.getAllPages<SavedShowItem>('/me/shows', { limit: '50' });
        } catch (err) {
          const q = isQuotaError(err);
          if (q.quota) {
            quotaHit = true;
            quotaRetryAfter = q.retryAfter;
            quotaScannedArtists = artistsSeen;
            savedShows = [];
          } else {
            throw err;
          }
        }
        if (!quotaHit) {
          for (const entry of savedShows) {
            if (showLookups >= showCap) {
              showsTruncatedByCap = true;
              break;
            }
            try {
              const res = await client.get<{ items?: SpotifyEpisodeSimple[] }>(
                `/shows/${encodeURIComponent(entry.show.id)}/episodes`,
                { limit: '10' },
              );
              showLookups++;
              showsSeen++;
              for (const ep of res?.items ?? []) {
                const dateKey = normalizeReleaseDate(ep.release_date ?? '');
                if (!ISO_DATE_RE.test(dateKey) || dateKey < cutoff) continue;
                episodes.push({
                  kind: 'episode',
                  id: ep.id,
                  name: ep.name,
                  uri: ep.uri,
                  release_date: ep.release_date,
                  date_key: dateKey,
                  show_name: entry.show.name,
                });
              }
            } catch (err) {
              const q = isQuotaError(err);
              if (q.quota) {
                quotaHit = true;
                quotaRetryAfter = q.retryAfter;
                quotaScannedArtists = artistsSeen;
                break;
              }
              throw err;
            }
          }
        }
      }

      // ---- Merge, sort newest-first (name as tiebreaker), truncate ----------
      const merged = [...albums, ...episodes].sort((a, b) =>
        a.date_key === b.date_key ? a.name.localeCompare(b.name) : b.date_key.localeCompare(a.date_key),
      );
      const maxResults = resolveMaxResults(args.max_results, getConfig().maxItems);
      const t = truncateItems(merged, maxResults);
      const pagination = paginationInfo({
        total: merged.length,
        returned: t.items.length,
        limit: maxResults,
      });

      // ---- Watermark handling (#239) -----------------------------------------
      // Only advance when scan completed WITHOUT cap truncation and WITHOUT
      // quota hit. Truncated scans hold the watermark so next 'since=last-check'
      // does not permanently skip unreached releases.
      const truncated = followTruncatedByCap || showsTruncatedByCap || quotaHit;
      let watermarkAdvanced = false;
      let newWatermark: string | null = null;
      let watermarkReason: string | null = null;
      if (!truncated) {
        newWatermark = todayUtc();
        await writeWatermark(newWatermark);
        watermarkAdvanced = true;
      } else if (quotaHit) {
        watermarkReason = 'quota exceeded mid-walk — partial results returned, watermark held so next since=last-check retries unscanned artists';
      } else {
        watermarkReason = 'scan truncated by cap — watermark held so next since=last-check does not skip unreached releases; raise max_artists or use an explicit since date to continue';
      }

      // ---- Prose rendering ---------------------------------------------------
      const lines: string[] = [`What's new since ${cutoff} (kinds: ${kinds.join(', ')}):`];
      if (t.items.length === 0) {
        lines.push('No new releases found.');
      }
      let currentKind: NewReleaseHit['kind'] | null = null;
      for (const hit of t.items) {
        if (hit.kind !== currentKind) {
          currentKind = hit.kind;
          const count =
            hit.kind === 'album'
              ? albums.filter((a) => a.date_key >= cutoff).length
              : episodes.filter((e) => e.date_key >= cutoff).length;
          lines.push(`${hit.kind === 'album' ? 'Albums' : 'Episodes'} (${count} new):`);
        }
        if (hit.kind === 'album') {
          const artists = hit.artist_names?.length ? hit.artist_names.join(', ') : 'unknown artist';
          lines.push(`  • ${hit.name} — ${artists} | ${hit.release_date} | ${hit.album_type} | URI: ${hit.uri}`);
        } else {
          lines.push(`  • ${hit.name} — ${hit.show_name} | ${hit.release_date} | URI: ${hit.uri}`);
        }
      }
      if (t.footer) lines.push(`(${t.footer})`);

      // Quota notice in prose when hit
      if (quotaHit) {
        const retryMsg = quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : '';
        lines.push(
          `Quota exceeded mid-walk (QUOTA_EXCEEDED). Partial results: ${albums.length + episodes.length} releases from ${artistsSeen} artists / ${showsSeen} shows scanned before quota wall.${retryMsg} Retry after the quota window resets.`,
        );
      }

      const scanSummary: string[] = [];
      if (wantAlbums) {
        scanSummary.push(
          `${artistsSeen} followed artist${artistsSeen === 1 ? '' : 's'} scanned `
            + `(${artistLookups} album lookup${artistLookups === 1 ? '' : 's'}, cap ${artistCap}`
            + `${followTruncatedByCap ? ', reached' : ', not reached'})`,
        );
      }
      if (wantPodcasts) {
        scanSummary.push(
          `${showsSeen} saved show${showsSeen === 1 ? '' : 's'} scanned `
            + `(${showLookups} episode lookup${showLookups === 1 ? '' : 's'}, cap ${showCap}`
            + `${showsTruncatedByCap ? ', reached' : ', not reached'})`,
        );
      }
      lines.push(`Scanned: ${scanSummary.join('; ')}.`);
      if (watermarkAdvanced) {
        lines.push(
          previousWatermark
            ? `Previous watermark: ${previousWatermark}. Watermark advanced to ${newWatermark}.`
            : `No previous watermark. Watermark set to ${newWatermark}.`,
        );
      } else {
        lines.push(
          `Watermark held at ${previousWatermark ?? '(none)'} — ${watermarkReason}`,
        );
        // Always mention that truncated/quota scans did NOT advance
        lines.push(`watermark_advanced: false, watermark_held: true`);
      }

      const extra: Record<string, unknown> = {
        ok: true,
        cutoff,
        kinds,
        previous_watermark: previousWatermark,
        watermark: newWatermark,
        watermark_advanced: watermarkAdvanced,
        watermark_held: !watermarkAdvanced,
        ...(watermarkReason ? { watermark_reason: watermarkReason } : {}),
        counts: { albums: albums.length, episodes: episodes.length },
        lookups: {
          artists_seen: artistsSeen,
          artist_album_calls: artistLookups,
          shows_seen: showsSeen,
          show_episode_calls: showLookups,
          cap: artistCap,
          budget: freshnessBudget,
          fetch_all_cap: lookupCap,
          albums_truncated_by_cap: followTruncatedByCap,
          shows_truncated_by_cap: showsTruncatedByCap,
        },
      };
      if (quotaHit) {
        Object.assign(extra, {
          quota_hit: true,
          retry_after: quotaRetryAfter ?? null,
          scanned_artists: quotaScannedArtists,
        });
      }

      return shapeResult(rf, lines.join('\n'), listStructuredContent(t.items, pagination, extra));
    },
  );
}
