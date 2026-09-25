import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SavedTrackItem, SavedAlbumItem, SpotifyPaged, RecentlyPlayedResponse, SpotifyPlaylistSimple, PlaylistItemObject } from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  DryRun,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { getConfig } from '../config.js';
import { SpotifyApiError } from '../client.js';

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function shapeResult(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}
function cap(args: { max_results?: number }): number {
  return resolveMaxResults(args.max_results, getConfig().maxItems);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function periodKey(date: Date, period: string): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-11
  if (period === 'yearly') return `${y}`;
  if (period === 'monthly') return `${y}-${String(m + 1).padStart(2, '0')}`;
  if (period === 'quarterly') return `${y}-Q${Math.floor(m / 3) + 1}`;
  // weekly: ISO week approx — use Monday start
  const d = new Date(Date.UTC(y, m, date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function enumeratePeriods(period: string, lookback: number, now = new Date()): string[] {
  const keys: string[] = [];
  const n = now;
  for (let i = lookback - 1; i >= 0; i--) {
    const d = new Date(n);
    if (period === 'yearly') d.setUTCFullYear(n.getUTCFullYear() - i);
    else if (period === 'monthly') d.setUTCMonth(n.getUTCMonth() - i);
    else if (period === 'quarterly') d.setUTCMonth(n.getUTCMonth() - i * 3);
    else if (period === 'weekly') d.setUTCDate(n.getUTCDate() - i * 7);
    keys.push(periodKey(d, period));
  }
  return keys;
}

function genresForTrack(track: unknown): string[] {
  const t = track as { artists?: Array<{ name?: string; genres?: string[] }> };
  const artists = t?.artists;
  if (!Array.isArray(artists)) return [];
  const out: string[] = [];
  for (const a of artists) {
    if (Array.isArray((a as { genres?: string[] }).genres)) {
      for (const g of (a as { genres: string[] }).genres) {
        if (typeof g === 'string' && g) out.push(g.toLowerCase());
      }
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Time zone
// ---------------------------------------------------------------------------
/** Day-of-week order for bucket indices; index 0 is Sunday, matching Date#getUTCDay. */
const WEEKDAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Recently-played day/hour buckets, in `zone`, as { day 0=Sun, hour 0-23 }.
 * Intl resolves the offset itself, so the same payload and the same bucket land
 * identically under any host process.env.TZ — the frame is a payload-level
 * choice, never the host's. */
function localDayHour(iso: string, zone: string): { day: number; hour: number } | null {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  let day: number | null = null;
  let hour: number | null = null;
  for (const part of dtf.formatToParts(new Date(iso))) {
    if (part.type === 'weekday') {
      const idx = WEEKDAY_ORDER.indexOf(part.value);
      if (idx >= 0) day = idx;
    } else if (part.type === 'hour') {
      const h = Number.parseInt(part.value, 10);
      if (Number.isFinite(h)) hour = h % 24;
    }
  }
  return day === null || hour === null ? null : { day, hour };
}


// ---------------------------------------------------------------------------
// Registration — 4 tools
// ---------------------------------------------------------------------------
export function registerLibraryAnalyticsTools(server: McpServer, client: SpotifyClient): void {
  // 1. library_coverage_report
  server.tool(
    'library_coverage_report',
    'Report coverage between your saved tracks and playlists: orphan saved tracks (liked but not in any playlist) and unsaved playlist items. Read-only.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      max_playlists: z.number().int().min(1).max(100).optional().describe('How many playlists to scan (default 50, max 100)'),
      include_not_saved: z.boolean().optional().describe('Include unsaved playlist items (default true)'),
      scan_cap: z.number().int().min(1).max(10000).optional().describe('Max items to walk per paginated source; default SPOTIFY_MCP_FETCH_ALL_CAP'),
      dry_run: DryRun,
    },
    async ({ response_format, max_results, max_playlists, include_not_saved, scan_cap, dry_run }) => {
      const rf = response_format;
      const maxResults = cap({ max_results });
      const includeNotSaved = include_not_saved !== false;

      const scanCap = (scan_cap as number | undefined) ?? getConfig().fetchAllCap;
      // dry_run: cost estimate without any API calls
      if (dry_run) {
        const n = max_playlists ?? 50;
        // One page per playlist: the legacy /playlists/{id}/tracks probe is gone,
        // so there is no longer a guaranteed second request per playlist (#738).
        const perPlaylistPages = Math.max(1, Math.ceil(scanCap / 100));
        const estimatedRequests = 2 + n * perPlaylistPages;
        const lines = [
          `[dry run] library_coverage_report would scan ${n} playlist(s) (scan_cap=${scanCap}).`,
          `Cost: ~${estimatedRequests} requests (2 listing walks for /me/tracks + /me/playlists + ${n} × ~${perPlaylistPages} GET /playlists/{id}/items page(s) at scan_cap=${scanCap}, limit 100 per page).`,
          n > 25 ? `Warning: scanning ${n} playlists (>25) may approach rate limits — consider max_playlists ≤25 or a lower scan_cap.` : '',
        ].filter(Boolean);
        const payload = {
          dry_run: true,
          would_scan_playlists: n,
          scan_cap: scanCap,
          per_playlist_pages: perPlaylistPages,
          estimated_requests: estimatedRequests,
          capped_at_scan_cap: true,
        };
        return shapeResult(rf, (lines as string[]).join('\n'), payload);
      }
      // Wrap initial walks + per-playlist walks so a 429 mid-scan can return partial coverage.
      let savedTracks: SavedTrackItem[] = [];
      let allPlaylists: SpotifyPlaylistSimple[] = [];
      let playlists: SpotifyPlaylistSimple[] = [];
      let quotaHit: { retry_after?: number; at_playlist?: string } | null = null;
      try {
        savedTracks = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: scanCap });
        allPlaylists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' }, { maxItems: scanCap });
        playlists = allPlaylists.slice(0, max_playlists ?? 50);
      } catch (e) {
        if (e instanceof SpotifyApiError && e.status === 429) {
          const retryAfter = e.retryAfterSec;
          const lines = [`Quota hit before playlist scan (Retry-After: ${retryAfter ?? 'unknown'}s) — partial coverage unavailable.`];
          const payload = { quota_hit: true, retry_after: retryAfter ?? null, scanned: 0, total_saved: savedTracks.length, playlists_scanned: 0 };
          return shapeResult(rf, lines.join('\n'), payload as unknown as Record<string, unknown>);
        }
        throw e;
      }

      // Collect every playlist item id
      const playlistTrackIds = new Set<string>();
      const unsavedByPlaylist: Array<{ playlist_id: string; playlist_name: string; unsaved_count: number; unsaved_sample: string[] }> = [];
      const playlistItemsById = new Map<string, string[]>(); // playlist id -> track ids
      // A playlist whose items could not be read is neither empty nor scanned:
      // it is recorded so the coverage verdict can say how complete it is (#739).
      const unreadablePlaylists: Array<{ playlist_id: string; name: string | null; error: string }> = [];
      let legacyFallbacks = 0;
      // per-playlist quota guard: break on 429 and keep partial ids
      let quotaAtPlaylist: string | null = null;
      let quotaRetryAfter: number | null = null;
      for (const pl of playlists) {
        if (!pl?.id) continue;
        if (quotaHit) break;
        let items: PlaylistItemObject[] | null = null;
        let failure: unknown = null;
        try {
          // /items is the documented target (CLAUDE.md); the /tracks variant is
          // the legacy path and costs a second request on every empty playlist.
          items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(pl.id)}/items`, { limit: '100' }, { maxItems: scanCap });
        } catch (inner) {
          if (inner instanceof SpotifyApiError && inner.status === 429) {
            quotaAtPlaylist = pl.id;
            quotaRetryAfter = inner.retryAfterSec ?? null;
            quotaHit = { retry_after: quotaRetryAfter ?? undefined, at_playlist: quotaAtPlaylist };
            break;
          }
          failure = inner;
          // Last-resort compatibility probe. It still has to succeed for the
          // playlist to count as read; a fallback that also fails leaves the
          // playlist unreadable rather than empty.
          try {
            items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(pl.id)}/tracks`, { limit: '100' }, { maxItems: scanCap });
            legacyFallbacks++;
          } catch (legacyErr) {
            failure = legacyErr;
            items = null;
          }
        }
        if (items === null) {
          // An unreadable playlist is not an empty one: recording it keeps a 403
          // out of the orphan verdict instead of silently reporting the user's
          // curated tracks as unfiled (#739).
          unreadablePlaylists.push({
            playlist_id: pl.id,
            name: pl.name ?? null,
            error: failure instanceof Error ? failure.message : String(failure),
          });
          continue;
        }
        const ids: string[] = [];
        for (const it of items) {
          const tr = (it as unknown as { track?: { id?: string } }).track ?? (it as unknown as { item?: { id?: string } }).item;
          const id = tr?.id;
          if (id) { playlistTrackIds.add(id); ids.push(id); }
        }
        playlistItemsById.set(pl.id, ids);
      }

      const savedIds = new Set<string>();
      const savedById = new Map<string, SavedTrackItem>();
      for (const s of savedTracks) {
        const id = s?.track?.id;
        if (id) { savedIds.add(id); savedById.set(id, s); }
      }

      // Orphans: saved not in any playlist
      const orphans: Array<{ id: string; name: string; uri: string }> = [];
      for (const s of savedTracks) {
        const id = s?.track?.id;
        if (!id) continue;
        if (!playlistTrackIds.has(id)) {
          orphans.push({ id, name: s.track.name, uri: s.track.uri ?? `spotify:track:${id}` });
        }
      }

      // Unsaved: playlist items not in saved
      if (includeNotSaved) {
        for (const pl of playlists) {
          const ids = playlistItemsById.get(pl.id) ?? [];
          const unsaved: string[] = ids.filter((id) => !savedIds.has(id));
          if (unsaved.length > 0) {
            unsavedByPlaylist.push({
              playlist_id: pl.id,
              playlist_name: pl.name,
              unsaved_count: unsaved.length,
              unsaved_sample: unsaved.slice(0, 5).map((id) => `spotify:track:${id}`),
            });
          }
        }
      }

      const totalSaved = savedTracks.length;
      // An unreadable playlist may be exactly where a saved track lives, so the
      // ratio is a lower bound whenever one exists (#739).
      const coverageRatio = totalSaved === 0 ? 0 : 1 - orphans.length / totalSaved;
      const playlistsAvailable = allPlaylists.length;
      const playlistsSkipped = Math.max(0, playlistsAvailable - playlists.length);
      // Complete only when every available playlist was both selected and read.
      const coverageComplete = unreadablePlaylists.length === 0 && playlistsSkipped === 0;

      const t = truncateItems(orphans, maxResults);
      const pagination = paginationInfo({ total: t.total, returned: t.returned });
      const orphanLabel = coverageComplete
        ? 'Orphan saved tracks (not in any playlist)'
        : 'Orphan saved tracks (among readable playlists) — NOT a full orphan list';

      const lines: string[] = [];
      lines.push(`Library coverage: ${totalSaved} saved track(s) across ${playlists.length} of ${playlistsAvailable} playlist(s).`);
      lines.push(`Coverage: ${(coverageRatio * 100).toFixed(1)}% of saved tracks appear in at least one playlist${coverageComplete ? '.' : ' (lower bound — some playlists were not read).'}`);
      lines.push(`${orphanLabel}: ${t.total}`);
      for (const o of t.items) lines.push(`  • ${o.name} — ${o.uri}`);
      if (t.footer) lines.push(`(${t.footer})`);
      if (includeNotSaved) {
        const totalUnsaved = unsavedByPlaylist.reduce((a, b) => a + b.unsaved_count, 0);
        lines.push(`Unsaved playlist items (in playlists but not saved): ${totalUnsaved}`);
        for (const g of unsavedByPlaylist.slice(0, 10)) {
          lines.push(`  • "${g.playlist_name}" (${g.playlist_id}): ${g.unsaved_count} unsaved — ${g.unsaved_sample.join(', ')}`);
        }
      }

      const truncated = savedTracks.length >= scanCap || playlistsAvailable >= scanCap;
      if (truncated) lines.push(`(scan truncated at scan_cap=${scanCap} — coverage verdict may be incomplete)`);
      if (playlistsSkipped > 0) {
        lines.push(`(only the first ${playlists.length} of ${playlistsAvailable} playlists were scanned — orphans may be over-reported; raise max_playlists)`);
      }
      if (unreadablePlaylists.length > 0) {
        lines.push(`(${unreadablePlaylists.length} playlist(s) could not be read — coverage is a lower bound: ${unreadablePlaylists.map((u) => `${u.name ?? u.playlist_id} (${u.error})`).join(', ')})`);
      }
      if ((max_playlists ?? 50) > 25) lines.push(`(quota note: scanning ${max_playlists ?? 50} playlists — consider dry_run first or lowering max_playlists to ≤25)`);
      if (quotaHit) {
        lines.push(`Quota hit at playlist ${quotaAtPlaylist} (Retry-After: ${quotaRetryAfter ?? 'unknown'}s) — partial coverage returned.`);
      }
      const payload: Record<string, unknown> = {
        ...listStructuredContent(t.items, pagination),
        coverage_ratio: coverageRatio,
        coverage_complete: coverageComplete,
        coverage_ratio_is_lower_bound: !coverageComplete,
        total_saved: totalSaved,
        orphan_count: orphans.length,
        playlists_available: playlistsAvailable,
        playlists_scanned: playlists.length,
        playlists_skipped: playlistsSkipped,
        unreadable_playlists: unreadablePlaylists,
        legacy_fallbacks: legacyFallbacks,
        unsaved_playlist_items: unsavedByPlaylist,
        total_unsaved: unsavedByPlaylist.reduce((a, b) => a + b.unsaved_count, 0),
        scanned: savedTracks.length,
        scan_cap: scanCap,
        truncated,
        ...(quotaHit ? { quota_hit: true, quota_at_playlist: quotaAtPlaylist, retry_after: quotaRetryAfter } : {}),
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 2. listening_heatmap
  server.tool(
    'listening_heatmap',
    'When do you listen? Buckets recently-played tracks into 168 hourly slots (24h x 7d) in the requested time zone (default UTC) and reports peak and least-busy windows. Read-only.',
    {
      response_format: ResponseFormat,
      lookback_days: z.number().int().min(1).max(90).optional().describe('Days of history to bucket (default 28)'),
      limit: z.number().int().min(1).max(50).optional().describe('Recently-played page size (default 50)'),
      timezone: z.string().optional().describe('IANA time zone for the day/hour slots, e.g. Asia/Tokyo (default SPOTIFY_MCP_TIMEZONE, else UTC). Never the host time zone.'),
    },
    async ({ response_format, lookback_days, limit, timezone }) => {
      const rf = response_format;
      const lookbackDays = lookback_days ?? 28;
      const pageSize = limit ?? 50;
      const cutoff = Date.now() - lookbackDays * 86400000;

      // The frame is a payload-level choice, never the host's: with no argument
      // and no SPOTIFY_MCP_TIMEZONE the buckets are UTC, so the same played_at
      // always lands in the same slot regardless of process.env.TZ.
      const zone = timezone ?? process.env.SPOTIFY_MCP_TIMEZONE ?? 'UTC';
      let zoned = true;
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
      } catch {
        zoned = false;
      }
      const zoneUsed = zoned ? zone : 'UTC';

      // Page budget scales with the window: one page per two days, bounded so a
      // long lookback cannot become an unbounded cursor walk. The walk still
      // stops the moment the cutoff is reached, so the budget is a safety valve
      // rather than the normal exit — and when it binds we say so (#740).
      const pageBudget = Math.max(2, Math.min(50, Math.ceil(lookbackDays / 2)));

      // Walk recently-played cursor pages until the cutoff, the cursor ends, or
      // the page budget runs out.
      const allItems: Array<{ played_at: string; track: { name: string; uri: string } }> = [];
      let after: string | undefined;
      let pagesWalked = 0;
      let oldestSeen: string | null = null;
      let budgetExhausted = false;
      for (let p = 0; p < pageBudget; p++) {
        const params: Record<string, string> = { limit: String(pageSize) };
        if (after) params.after = after;
        const res = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', params);
        if (!res || !Array.isArray(res.items) || res.items.length === 0) break;
        pagesWalked++;
        let hitCutoff = false;
        for (const it of res.items) {
          if (!it?.track || !it.played_at) continue;
          const ts = Date.parse(it.played_at);
          if (!Number.isFinite(ts)) continue;
          if (oldestSeen === null || ts < Date.parse(oldestSeen)) oldestSeen = it.played_at;
          if (ts < cutoff) { hitCutoff = true; continue; }
          allItems.push(it as unknown as typeof allItems[number]);
        }
        // next cursor
        after = res.cursors?.after ? String(res.cursors.after) : undefined;
        if (!after) break;
        if (hitCutoff) break;
        if (res.items.length < pageSize) break;
        // A cursor is still open with the budget spent: the oldest plays in the
        // window were never fetched.
        if (p === pageBudget - 1) budgetExhausted = true;
      }
      const truncated = budgetExhausted;

      // 168 buckets: index = day*24 + hour (day 0=Sun), all read in `zoneUsed`.
      const buckets: Array<{ day: number; hour: number; count: number }> = [];
      for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) buckets.push({ day: d, hour: h, count: 0 });
      let unparsed = 0;
      for (const it of allItems) {
        const slot = localDayHour(it.played_at, zoneUsed);
        if (!slot) { unparsed++; continue; }
        const idx = slot.day * 24 + slot.hour;
        if (idx >= 0 && idx < 168) buckets[idx].count++;
      }
      const dayNames = WEEKDAY_ORDER;

      const sorted = [...buckets].sort((a, b) => b.count - a.count);
      const peak = sorted.filter((b) => b.count > 0).slice(0, 5);
      // The genuinely least busy slots: lowest counts, ascending, never the
      // first five idle labels in clock order (#740).
      const quiet = [...buckets].filter((b) => b.count > 0).sort((a, b) => a.count - b.count).slice(0, 5);
      const slotLabel = (b: { day: number; hour: number }) => `${dayNames[b.day]} ${String(b.hour).padStart(2, '0')}:00`;
      // day-parts
      const partCounts: Record<string, number> = { morning: 0, afternoon: 0, evening: 0, night: 0 };
      for (const b of buckets) {
        if (b.hour >= 6 && b.hour < 12) partCounts.morning += b.count;
        else if (b.hour >= 12 && b.hour < 18) partCounts.afternoon += b.count;
        else if (b.hour >= 18 && b.hour < 23) partCounts.evening += b.count;
        else partCounts.night += b.count;
      }
      const topPart = Object.entries(partCounts).sort((a, b) => b[1] - a[1])[0];

      const lines: string[] = [];
      lines.push(`Time zone: ${zoneUsed}${zoned ? '' : ` (requested "${zone}" is not a valid IANA zone — fell back to UTC)`}.`);
      if (allItems.length === 0) {
        lines.push('No recently-played history in the lookback window.');
      } else {
        const windowNote = truncated
          ? `${allItems.length} plays from the ${pagesWalked} most recent page(s) walked — the ${lookbackDays}-day window is NOT fully covered`
          : `${allItems.length} plays covering the ${lookbackDays}-day lookback window`;
        lines.push(`Listening heatmap over ${windowNote}:`);
        lines.push(`Peak window(s): ${peak.map((b) => `${slotLabel(b)} (${b.count})`).join(', ') || 'none'}`);
        if (quiet.length > 0) {
          lines.push(`Least busy slots (non-zero): ${quiet.map((b) => `${slotLabel(b)} (${b.count})`).join(', ')}`);
        } else {
          lines.push('Least busy slots (non-zero): none — every slot with a bucket is equally busy.');
        }
        lines.push(`Top day-part: ${topPart[0]} (${topPart[1]} plays)`);
      }
      if (unparsed > 0) lines.push(`(${unparsed} play(s) had an unreadable played_at and were not bucketed.)`);
      if (truncated) {
        lines.push(`(only the ${pagesWalked} most recent page(s) were walked — lower lookback_days or raise the page budget to cover the full window)`);
      }

      const payload = {
        lookback_days: lookbackDays,
        timezone: zoneUsed,
        total_plays: allItems.length,
        buckets,
        peak_slots: peak,
        quiet_slots: quiet,
        day_parts: partCounts,
        top_day_part: topPart[0],
        pages_walked: pagesWalked,
        page_budget: pageBudget,
        truncated,
        window_covered_from: oldestSeen,
        unparsed_played_at: unparsed,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 3. library_growth_report
  server.tool(
    'library_growth_report',
    'How fast your library is growing — buckets saved tracks/albums/shows/episodes by added_at period (weekly/monthly/yearly). Read-only.',
    {
      response_format: ResponseFormat,
      period: z.enum(['weekly', 'monthly', 'yearly']).optional().describe('Bucket size (default monthly)'),
      lookback: z.number().int().min(1).max(60).optional().describe('How many periods back (default 12)'),
    },
    async ({ response_format, period, lookback }) => {
      const rf = response_format;
      const p = period ?? 'monthly';
      const lb = lookback ?? 12;

      const walkCap = getConfig().fetchAllCap;
      const [tracks, albums] = await Promise.all([
        client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: walkCap }),
        client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: walkCap }),
      ]);
      // Optional collections. A failed walk is 'unavailable', never a zero —
      // "no shows saved" and "the shows call failed" are different answers (#741).
      const partial: Record<string, string> = {};
      let shows: Array<{ added_at: string }> = [];
      let episodes: Array<{ added_at: string }> = [];
      try { shows = await client.getAllPages<{ added_at: string }>('/me/shows', { limit: '50' }, { maxItems: walkCap }); } catch { partial.shows = 'unavailable'; }
      try { episodes = await client.getAllPages<{ added_at: string }>('/me/episodes', { limit: '50' }, { maxItems: walkCap }); } catch { partial.episodes = 'unavailable'; }

      const keys = enumeratePeriods(p, lb);
      const keySet = new Set(keys);
      type Bucket = { period: string; tracks: number; albums: number; shows: number; episodes: number; total: number };
      const map = new Map<string, Bucket>();
      for (const k of keys) map.set(k, { period: k, tracks: 0, albums: 0, shows: 0, episodes: 0, total: 0 });

      let olderThanWindow = 0;
      let undated = 0;
      const bump = (arr: Array<{ added_at: string }>, field: keyof Bucket) => {
        for (const it of arr) {
          if (!it?.added_at) { undated++; continue; }
          const dt = new Date(it.added_at);
          if (Number.isNaN(dt.getTime())) { undated++; continue; }
          const k = periodKey(dt, p);
          // Scanned but saved before the window opened: counted separately so it
          // is never read as an addition inside the window (#741).
          if (!keySet.has(k)) { olderThanWindow++; continue; }
          const b = map.get(k)!;
          (b[field] as number)++;
          b.total++;
        }
      };
      bump(tracks, 'tracks');
      bump(albums, 'albums');
      bump(shows, 'shows');
      bump(episodes, 'episodes');

      const buckets = keys.map((k) => map.get(k)!);
      // deltas vs prior period
      const deltas = buckets.map((b, i) => (i === 0 ? 0 : b.total - buckets[i - 1].total));
      // What the walk returned, versus what the buckets cover. These are two
      // different numbers and used to be reported as one (#741).
      const scannedTotals = {
        tracks: tracks.length,
        albums: albums.length,
        shows: shows.length,
        episodes: episodes.length,
        total: tracks.length + albums.length + shows.length + episodes.length,
      };
      const addedInWindow = buckets.reduce((a, b) => a + b.total, 0);
      // Every one of the four walks is capped at walkCap, so a cap reached on
      // shows or episodes is as much a truncated scan as one reached on tracks
      // or albums. Checking only the first two reported a partial library walk
      // as a complete one (#741).
      const walkCapped = (scannedTotals.tracks >= walkCap
        || scannedTotals.albums >= walkCap
        || scannedTotals.shows >= walkCap
        || scannedTotals.episodes >= walkCap);
      const fastest = [...buckets].sort((a, b) => b.total - a.total)[0] ?? null;

      const lines: string[] = [];
      lines.push(`Library growth (${p}, last ${lb} period(s)): ${addedInWindow} item(s) added in the window.`);
      lines.push(`Scanned: ${scannedTotals.total} saved item(s) walked (tracks ${scannedTotals.tracks}, albums ${scannedTotals.albums}, shows ${scannedTotals.shows}, episodes ${scannedTotals.episodes})${walkCapped ? ` — walk capped at ${walkCap}` : ''}.`);
      if (olderThanWindow > 0) lines.push(`Older than the window: ${olderThanWindow} scanned item(s) were saved before it and are excluded from the buckets.`);
      if (undated > 0) lines.push(`(${undated} scanned item(s) had no usable added_at and were excluded from the buckets.)`);
      for (const [collection, state] of Object.entries(partial)) {
        lines.push(`(${collection} ${state} — excluded from the totals above)`);
      }
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const d = deltas[i];
        const sign = d > 0 ? `+${d}` : `${d}`;
        lines.push(`  ${b.period}: ${b.total} (tracks ${b.tracks}, albums ${b.albums}) delta ${i === 0 ? '—' : sign}`);
      }
      if (fastest) lines.push(`Fastest growth: ${fastest.period} (${fastest.total} adds)`);

      const payload = {
        period: p,
        lookback: lb,
        buckets,
        deltas,
        scanned_totals: scannedTotals,
        added_in_window: addedInWindow,
        older_than_window: olderThanWindow,
        undated_added_at: undated,
        scan_cap: walkCap,
        truncated: walkCapped,
        partial,
        fastest_growth: fastest,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // 4. genre_trends_over_time
  server.tool(
    'genre_trends_over_time',
    'How your taste shifts — per-period top genres via artist genres/tags, with deltas and emerging/declining tags. Read-only.',
    {
      response_format: ResponseFormat,
      period: z.enum(['monthly', 'quarterly']).optional().describe('Bucket size (default monthly)'),
      lookback: z.number().int().min(2).max(24).optional().describe('How many periods back (default 6)'),
      max_results: MaxResults,
    },
    async ({ response_format, period, lookback, max_results }) => {
      const rf = response_format;
      const p = period ?? 'monthly';
      const lb = lookback ?? 6;
      const maxResults = cap({ max_results });

      const tracks = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: getConfig().fetchAllCap });
      const keys = enumeratePeriods(p, lb);
      const keySet = new Set(keys);

      // bucket -> genre -> count
      const bucketGenres = new Map<string, Map<string, number>>();
      for (const k of keys) bucketGenres.set(k, new Map());

      for (const it of tracks) {
        if (!it?.added_at || !it.track) continue;
        const dt = new Date(it.added_at);
        if (Number.isNaN(dt.getTime())) continue;
        const k = periodKey(dt, p);
        if (!keySet.has(k)) continue;
        const genres = genresForTrack(it.track);
        const m = bucketGenres.get(k)!;
        for (const g of genres) m.set(g, (m.get(g) ?? 0) + 1);
      }

      type PeriodRow = { period: string; top_genres: Array<{ genre: string; count: number }>; total_tagged: number };
      const periods: PeriodRow[] = keys.map((k) => {
        const m = bucketGenres.get(k)!;
        const sorted = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const top = sorted.slice(0, maxResults).map(([genre, count]) => ({ genre, count }));
        const total = [...m.values()].reduce((a, b) => a + b, 0);
        return { period: k, top_genres: top, total_tagged: total };
      });

      // deltas: last vs previous period
      const lastMap = bucketGenres.get(keys[keys.length - 1]) ?? new Map();
      const prevMap = keys.length >= 2 ? (bucketGenres.get(keys[keys.length - 2]) ?? new Map()) : new Map();
      const allGenres = new Set([...lastMap.keys(), ...prevMap.keys()]);
      const deltas: Array<{ genre: string; previous: number; current: number; delta: number }> = [];
      for (const g of allGenres) {
        const prev = prevMap.get(g) ?? 0;
        const cur = lastMap.get(g) ?? 0;
        deltas.push({ genre: g, previous: prev, current: cur, delta: cur - prev });
      }
      deltas.sort((a, b) => b.delta - a.delta || a.genre.localeCompare(b.genre));
      const emerging = deltas.filter((d) => d.delta > 0).slice(0, 5);
      const declining = [...deltas].filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5);

      const lines: string[] = [];
      if (tracks.length === 0) {
        lines.push('No saved tracks — nothing to trend.');
      } else {
        lines.push(`Genre trends (${p}, last ${lb} period(s), ${tracks.length} saved tracks):`);
        for (const pr of periods) {
          const top = pr.top_genres.map((g) => `${g.genre}(${g.count})`).join(', ') || '—';
          lines.push(`  ${pr.period}: ${top}`);
        }
        if (emerging.length > 0) lines.push(`Emerging: ${emerging.map((e) => `${e.genre} (+${e.delta})`).join(', ')}`);
        if (declining.length > 0) lines.push(`Declining: ${declining.map((e) => `${e.genre} (${e.delta})`).join(', ')}`);
      }

      const payload = {
        period: p,
        lookback: lb,
        periods,
        deltas,
        emerging,
        declining,
        total_saved_tracks: tracks.length,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );
}
