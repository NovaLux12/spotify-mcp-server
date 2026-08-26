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
        const perPlaylistPages = Math.max(1, Math.ceil(scanCap / 100));
        const estimatedRequests = 2 + n * perPlaylistPages;
        const lines = [
          `[dry run] library_coverage_report would scan ${n} playlist(s) (scan_cap=${scanCap}).`,
          `Cost: ~${estimatedRequests} requests (2 listing walks for /me/tracks + /me/playlists + ${n} × ~${perPlaylistPages} page(s) per playlist at scan_cap=${scanCap}, limit 100 per page).`,
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

      // per-playlist quota guard: break on 429 and keep partial ids
      let quotaAtPlaylist: string | null = null;
      let quotaRetryAfter: number | null = null;
      for (const pl of playlists) {
        if (!pl?.id) continue;
        if (quotaHit) break;
        let items: PlaylistItemObject[] = [];
        try {
          try {
            items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(pl.id)}/tracks`, { limit: '100' }, { maxItems: scanCap });
            if (items.length === 0) {
              const alt = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(pl.id)}/items`, { limit: '100' }, { maxItems: scanCap });
              if (alt.length > 0) items = alt;
            }
          } catch (inner) {
            if (inner instanceof SpotifyApiError && inner.status === 429) throw inner;
            items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(pl.id)}/items`, { limit: '100' }, { maxItems: scanCap }).catch(() => []);
          }
        } catch (e) {
          if (e instanceof SpotifyApiError && e.status === 429) {
            quotaAtPlaylist = pl.id;
            quotaRetryAfter = e.retryAfterSec ?? null;
            quotaHit = { retry_after: quotaRetryAfter ?? undefined, at_playlist: quotaAtPlaylist };
            break;
          }
          items = [];
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
      const coverageRatio = totalSaved === 0 ? 0 : 1 - orphans.length / totalSaved;

      const t = truncateItems(orphans, maxResults);
      const pagination = paginationInfo({ total: t.total, returned: t.returned });

      const lines: string[] = [];
      lines.push(`Library coverage: ${totalSaved} saved track(s) across ${playlists.length} playlist(s).`);
      lines.push(`Coverage: ${(coverageRatio * 100).toFixed(1)}% of saved tracks appear in at least one playlist.`);
      lines.push(`Orphan saved tracks (not in any playlist): ${t.total}`);
      for (const o of t.items) lines.push(`  \u2022 ${o.name} \u2014 ${o.uri}`);
      if (t.footer) lines.push(`(${t.footer})`);
      if (includeNotSaved) {
        const totalUnsaved = unsavedByPlaylist.reduce((a, b) => a + b.unsaved_count, 0);
        lines.push(`Unsaved playlist items (in playlists but not saved): ${totalUnsaved}`);
        for (const g of unsavedByPlaylist.slice(0, 10)) {
          lines.push(`  \u2022 "${g.playlist_name}" (${g.playlist_id}): ${g.unsaved_count} unsaved \u2014 ${g.unsaved_sample.join(', ')}`);
        }
      }

      const truncated = savedTracks.length >= scanCap || allPlaylists.length >= scanCap;
      if (truncated) lines.push(`(scan truncated at scan_cap=${scanCap} — coverage verdict may be incomplete)`);
      if ((max_playlists ?? 50) > 25) lines.push(`(quota note: scanning ${max_playlists ?? 50} playlists — consider dry_run first or lowering max_playlists to ≤25)`);
      if (quotaHit) {
        lines.push(`Quota hit at playlist ${quotaAtPlaylist} (Retry-After: ${quotaRetryAfter ?? 'unknown'}s) — partial coverage returned.`);
      }
      const payload: Record<string, unknown> = {
        ...listStructuredContent(t.items, pagination),
        coverage_ratio: coverageRatio,
        total_saved: totalSaved,
        orphan_count: orphans.length,
        playlists_scanned: playlists.length,
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
    'When do you listen? Buckets recently-played tracks into 168 hourly slots (24h x 7d) and reports peak/quiet windows. Read-only.',
    {
      response_format: ResponseFormat,
      lookback_days: z.number().int().min(1).max(90).optional().describe('Days of history to bucket (default 28)'),
      limit: z.number().int().min(1).max(50).optional().describe('Recently-played page size (default 50)'),
    },
    async ({ response_format, lookback_days, limit }) => {
      const rf = response_format;
      const lookbackDays = lookback_days ?? 28;
      const cutoff = Date.now() - lookbackDays * 86400000;

      // Walk recently-played cursor pages until cutoff or 5 pages
      const allItems: Array<{ played_at: string; track: { name: string; uri: string } }> = [];
      let after: string | undefined;
      for (let p = 0; p < 5; p++) {
        const params: Record<string, string> = { limit: String(limit ?? 50) };
        if (after) params.after = after;
        const res = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', params);
        if (!res || !Array.isArray(res.items) || res.items.length === 0) break;
        let hitCutoff = false;
        for (const it of res.items) {
          if (!it?.track || !it.played_at) continue;
          const ts = Date.parse(it.played_at);
          if (Number.isFinite(ts) && ts < cutoff) { hitCutoff = true; continue; }
          allItems.push(it as unknown as typeof allItems[number]);
        }
        // next cursor
        after = res.cursors?.after ? String(res.cursors.after) : undefined;
        if (!after) break;
        if (hitCutoff) break;
        if (res.items.length < (limit ?? 50)) break;
      }

      // 168 buckets: index = day*24 + hour (day 0=Sun UTC)
      const buckets: Array<{ day: number; hour: number; count: number }> = [];
      for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) buckets.push({ day: d, hour: h, count: 0 });
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      for (const it of allItems) {
        const dt = new Date(it.played_at);
        const day = dt.getUTCDay();
        const hour = dt.getUTCHours();
        const idx = day * 24 + hour;
        if (idx >= 0 && idx < 168) buckets[idx].count++;
      }

      const sorted = [...buckets].sort((a, b) => b.count - a.count);
      const peak = sorted.filter((b) => b.count > 0).slice(0, 5);
      const quiet = [...buckets].filter((b) => b.count === 0).slice(0, 5);
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
      if (allItems.length === 0) {
        lines.push('No recently-played history in the lookback window.');
      } else {
        lines.push(`Listening heatmap over ${allItems.length} plays in the last ${lookbackDays} day(s):`);
        lines.push(`Peak window(s): ${peak.map((b) => `${dayNames[b.day]} ${String(b.hour).padStart(2, '0')}:00 (${b.count})`).join(', ') || 'none'}`);
        if (quiet.length > 0) lines.push(`Quietest slots: ${quiet.map((b) => `${dayNames[b.day]} ${String(b.hour).padStart(2, '0')}:00`).join(', ')}`);
        lines.push(`Top day-part: ${topPart[0]} (${topPart[1]} plays)`);
      }

      const payload = {
        lookback_days: lookbackDays,
        total_plays: allItems.length,
        buckets,
        peak_slots: peak,
        quiet_slots: quiet,
        day_parts: partCounts,
        top_day_part: topPart[0],
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

      const [tracks, albums] = await Promise.all([
        client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: getConfig().fetchAllCap }),
        client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: getConfig().fetchAllCap }),
      ]);
      // optional shows/episodes — tolerate missing scope
      let shows: Array<{ added_at: string }> = [];
      let episodes: Array<{ added_at: string }> = [];
      try { shows = await client.getAllPages<{ added_at: string }>('/me/shows', { limit: '50' }, { maxItems: getConfig().fetchAllCap }); } catch { /* no scope */ }
      try { episodes = await client.getAllPages<{ added_at: string }>('/me/episodes', { limit: '50' }, { maxItems: getConfig().fetchAllCap }); } catch { /* no scope */ }

      const keys = enumeratePeriods(p, lb);
      const keySet = new Set(keys);
      type Bucket = { period: string; tracks: number; albums: number; shows: number; episodes: number; total: number };
      const map = new Map<string, Bucket>();
      for (const k of keys) map.set(k, { period: k, tracks: 0, albums: 0, shows: 0, episodes: 0, total: 0 });

      const bump = (arr: Array<{ added_at: string }>, field: keyof Bucket) => {
        for (const it of arr) {
          if (!it?.added_at) continue;
          const dt = new Date(it.added_at);
          if (Number.isNaN(dt.getTime())) continue;
          const k = periodKey(dt, p);
          if (!keySet.has(k)) continue;
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
      const totalsByType = {
        tracks: tracks.length,
        albums: albums.length,
        shows: shows.length,
        episodes: episodes.length,
        total: tracks.length + albums.length + shows.length + episodes.length,
      };
      const fastest = [...buckets].sort((a, b) => b.total - a.total)[0] ?? null;

      const lines: string[] = [];
      lines.push(`Library growth (${p}, last ${lb} period(s)): ${totalsByType.total} item(s) total in lookback.`);
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
        totals: totalsByType,
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
