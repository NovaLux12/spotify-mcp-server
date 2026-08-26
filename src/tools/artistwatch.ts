import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import { getConfig } from '../config.js';
import {
  DryRun,
  ResponseFormat,
  sharedListFields,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type AlbumItem = {
  id: string;
  name: string;
  uri: string;
  album_type: string;
  release_date: string;
  total_tracks: number;
  artists: Array<{ id: string; name: string }>;
};

type WatchlistEntry = {
  artists: string[];
  createdAt: string;
  lastChecked: string | null;
  seen: Record<string, string[]>;
};

type WatchlistStore = {
  watchlists: Record<string, WatchlistEntry>;
};

function dataFilePath(): string {
  const cfg = getConfig() as unknown as Record<string, unknown>;
  const dir = (typeof cfg.dataDir === 'string' && cfg.dataDir) ? cfg.dataDir as string : (process.env.SPOTIFY_MCP_DATA_DIR || './data');
  return join(dir, 'artist-watchlist.json');
}

async function loadStore(): Promise<WatchlistStore> {
  const fp = dataFilePath();
  try {
    const raw = await readFile(fp, 'utf8');
    const parsed = JSON.parse(raw) as WatchlistStore;
    if (!parsed.watchlists || typeof parsed.watchlists !== 'object') return { watchlists: {} };
    return parsed;
  } catch {
    return { watchlists: {} };
  }
}

async function saveStore(store: WatchlistStore): Promise<void> {
  const fp = dataFilePath();
  try {
    await mkdir(join(fp, '..'), { recursive: true });
  } catch {}
  try {
    await writeFile(fp, JSON.stringify(store, null, 2), 'utf8');
  } catch {}
}

function ensureList(store: WatchlistStore, name: string): WatchlistEntry {
  if (!store.watchlists[name]) {
    store.watchlists[name] = { artists: [], createdAt: new Date().toISOString(), lastChecked: null, seen: {} };
  }
  return store.watchlists[name];
}

function isNewRelease(album: AlbumItem, lookbackDays?: number): boolean {
  if (lookbackDays === undefined || lookbackDays === null) return true;
  const d = new Date(album.release_date);
  if (Number.isNaN(d.getTime())) return true;
  const now = Date.now();
  const diff = now - d.getTime();
  return diff >= 0 && diff <= lookbackDays * 24 * 60 * 60 * 1000;
}

function isQuotaError(err: unknown): { quota: boolean; retryAfter: number | undefined } {
  if (err instanceof SpotifyApiError && err.status === 429 && err.reason === 'QUOTA_EXCEEDED') {
    return { quota: true, retryAfter: err.retryAfterSec };
  }
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

export function registerArtistWatchTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'get_artist_discography',
    'Get filtered discography for an artist (GET /artists/{id}/albums with album-type filtering)',
    {
      artist_id: z.string().describe('Spotify artist ID'),
      album_types: z.array(z.enum(['album', 'single', 'appears_on', 'compilation'])).optional().describe('Filter to these album types. Default: all'),
      include_groups: z.array(z.enum(['album', 'single', 'appears_on', 'compilation'])).optional().describe('Alias for album_types (Spotify include_groups)'),
      limit: z.number().int().min(1).max(50).optional().describe('Results per page, 1–50. Default: 20'),
      offset: z.number().int().min(0).optional().describe('Offset'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      ...sharedListFields,
    },
    async (args) => {
      const types = (args.album_types ?? args.include_groups ?? undefined) as string[] | undefined;
      const includeGroups = types ? types.join(',') : undefined;
      const params: Record<string, string> = {
        limit: String(args.limit ?? 20),
        offset: String(args.offset ?? 0),
      };
      if (includeGroups) params.include_groups = includeGroups;
      if (args.market) params.market = args.market;
      const data = await client.get<{ items: AlbumItem[]; total: number; limit: number; offset: number }>(
        `/artists/${encodeURIComponent(args.artist_id)}/albums`,
        params,
      );
      const items = data?.items ?? [];
      const filtered = types ? items.filter((a) => types.includes(a.album_type)) : items;
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { items: filtered, total: data?.total ?? filtered.length };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      if (filtered.length === 0) {
        return {
          content: [{ type: 'text', text: `No releases found for artist "${args.artist_id}"${types ? ` (filter: ${types.join(',')})` : ''}.` }],
          structuredContent: listStructuredContent([], paginationInfo({ total: 0, returned: 0 })),
        };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(filtered, cap);
      const label = types ? `Discography for "${args.artist_id}" [${types.join(',')}] (${filtered.length}):` : `Discography for "${args.artist_id}" (${data?.total ?? filtered.length} total):`;
      const lines = [label];
      trunc.items.forEach((al) => lines.push(`  \u2022 "${al.name}" (${al.album_type}, ${al.release_date}) | URI: ${al.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(trunc.items, paginationInfo({ total: data?.total ?? filtered.length, offset: args.offset, limit: args.limit ?? null, returned: trunc.items.length })),
      };
    },
  );

  server.tool(
    'resolve_artist',
    'Resolve an artist name or URI to a Spotify artist ID via search',
    {
      query: z.string().describe('Artist name, spotify:artist: URI, or search query'),
      limit: z.number().int().min(1).max(10).optional().describe('Search results to consider, 1–10. Default: 5'),
      ...sharedListFields,
    },
    async (args) => {
      const uriMatch = /^spotify:artist:(.+)$/.exec(args.query.trim());
      if (uriMatch) {
        const id = uriMatch[1];
        if (args.response_format === 'json') {
          const raw: Record<string, unknown> = { id, uri: args.query.trim(), name: null };
          return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
        }
        return { content: [{ type: 'text', text: `Resolved "${args.query}" \u2192 artist ID: ${id} | URI: spotify:artist:${id}` }], structuredContent: { id, uri: `spotify:artist:${id}` } };
      }
      const limit = args.limit ?? 5;
      const data = await client.get<{ artists: { items: Array<{ id: string; name: string; uri: string; genres?: string[]; popularity?: number }>; total: number } }>('/search', {
        q: args.query,
        type: 'artist',
        limit: String(limit),
      });
      const items = data?.artists?.items?.filter(Boolean) ?? [];
      if (items.length === 0) {
        return { content: [{ type: 'text', text: `No artists found for "${args.query}".` }] };
      }
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { query: args.query, items };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(items, cap);
      const lines = [`Artists matching "${args.query}" (${items.length}):`];
      trunc.items.forEach((a, i) => {
        const marker = i === 0 ? ' \u2190 top match' : '';
        lines.push(`  ${i + 1}. ${a.name} (id: ${a.id}) | URI: ${a.uri}${marker}`);
      });
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      const top = trunc.items[0] as { id: string; uri: string; name: string };
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { query: args.query, resolved: { id: top.id, uri: top.uri, name: top.name }, items: trunc.items, pagination: paginationInfo({ total: items.length, returned: trunc.items.length }) },
      };
    },
  );

  server.tool(
    'save_artist_new_releases',
    'Find new releases for an artist and save unsaved albums to Your Library (diffs against /me/albums/contains)',
    {
      artist_id: z.string().describe('Spotify artist ID'),
      limit: z.number().int().min(1).max(50).optional().describe('Albums to fetch, 1–50. Default: 20'),
      market: z.string().optional().describe('ISO 3166-1 alpha-2 country code'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const data = await client.get<{ items: AlbumItem[] }>(
        `/artists/${encodeURIComponent(args.artist_id)}/albums`,
        { include_groups: 'album,single', limit: String(args.limit ?? 20), offset: '0', ...(args.market ? { market: args.market } : {}) },
      );
      const albums = data?.items ?? [];
      if (albums.length === 0) {
        return { content: [{ type: 'text', text: `No releases found for artist "${args.artist_id}".` }] };
      }
      const ids = albums.map((a) => a.id);
      let contains: boolean[] = [];
      try {
        const res = await client.get<boolean[]>('/me/albums/contains', { ids: ids.join(',') });
        contains = Array.isArray(res) ? res : [];
      } catch {
        contains = ids.map(() => false);
      }
      const toSave = albums.filter((_, i) => !contains[i]);
      if (toSave.length === 0) {
        const msg = `All ${albums.length} releases for "${args.artist_id}" are already in Your Library.`;
        if (args.response_format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify({ artist_id: args.artist_id, total: albums.length, saved: 0, ids: [] }, null, 2) }], structuredContent: { artist_id: args.artist_id, total: albums.length, saved: 0, ids: [] } };
        }
        return { content: [{ type: 'text', text: msg }], structuredContent: { artist_id: args.artist_id, total: albums.length, saved: 0 } };
      }
      for (let i = 0; i < toSave.length; i += 20) {
        const chunk = toSave.slice(i, i + 20).map((a) => a.id);
        await (client as unknown as { put(path: string, body?: unknown): Promise<void> }).put('/me/albums', { ids: chunk });
      }
      const msg = `Saved ${toSave.length} new release(s) for "${args.artist_id}": ${toSave.map((a) => `"${a.name}"`).join(', ')}`;
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { artist_id: args.artist_id, total: albums.length, saved: toSave.length, ids: toSave.map((a) => a.id) };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      return { content: [{ type: 'text', text: msg }], structuredContent: { artist_id: args.artist_id, total: albums.length, saved: toSave.length, ids: toSave.map((a) => a.id) } };
    },
  );

  server.tool(
    'watch_artists',
    'Add artists to a local watchlist sidecar for new-release polling',
    {
      artist_ids: z.array(z.string().min(1)).min(1).describe('Spotify artist IDs to watch'),
      name: z.string().optional().describe('Watchlist name. Default: "default"'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const listName = args.name ?? 'default';
      const store = await loadStore();
      const entry = ensureList(store, listName);
      const before = entry.artists.length;
      for (const id of args.artist_ids as string[]) {
        if (!entry.artists.includes(id)) entry.artists.push(id);
      }
      await saveStore(store);
      const added = entry.artists.length - before;
      let msg = `Watchlist "${listName}": ${added} added, ${entry.artists.length} total.`;
      if (entry.artists.length > 50) {
        msg += ` Warning: watchlist has ${entry.artists.length} artists — check_artist_releases will cap at max_artists (default 25) and each check costs 1 request per artist. Consider using a smaller watchlist or raising max_artists explicitly.`;
      }
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { name: listName, added, total: entry.artists.length, artists: [...entry.artists] };
        if (entry.artists.length > 50) (raw as Record<string, unknown>).warning = `watchlist exceeds 50 artists (${entry.artists.length}); polling will be capped`;
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      return { content: [{ type: 'text', text: msg }], structuredContent: { name: listName, added, total: entry.artists.length, artists: [...entry.artists], ...(entry.artists.length > 50 ? { warning: `watchlist exceeds 50 artists (${entry.artists.length})` } : {}) } };
    },
  );

  server.tool(
    'check_artist_releases',
    'Check watched artists for new releases since last check (or within lookback_days). '
      + 'WARNING: N artists in watchlist = N API requests. Use max_artists to budget and dry_run to preview cost.',
    {
      watchlist_name: z.string().optional().describe('Watchlist name. Default: "default"'),
      lookback_days: z.number().int().min(1).max(365).optional().describe('Only consider releases from the last N days'),
      limit: z.number().int().min(1).max(50).optional().describe('Albums per artist to fetch, 1–50. Default: 10'),
      max_artists: z.number().int().min(1).max(200).optional().describe(
        'Per-call budget for artist lookups. Default: 25 (or SPOTIFY_MCP_FRESHNESS_BUDGET). '
          + 'Truncates to max_artists and reports watchlist_size / artists_scanned / truncated.',
      ),
      dry_run: DryRun,
      ...sharedListFields,
    },
    async (args) => {
      const listName = args.watchlist_name ?? 'default';
      const store = await loadStore();
      const entry = store.watchlists[listName];
      if (!entry || entry.artists.length === 0) {
        return { content: [{ type: 'text', text: `Watchlist "${listName}" is empty \u2014 add artists with watch_artists first.` }] };
      }
      const watchlistSize = entry.artists.length;
      const budget = args.max_artists ?? getConfig().freshnessBudget;
      const effectiveCap = Math.min(budget, getConfig().fetchAllCap);
      const truncated = watchlistSize > effectiveCap;
      const artistsToCheck = entry.artists.slice(0, effectiveCap);

      if (args.dry_run) {
        const costEstimate = `${watchlistSize} artists in watchlist "${listName}" \u2192 ${artistsToCheck.length} album lookups (capped at max_artists=${budget}, effective ${effectiveCap} with fetchAllCap=${getConfig().fetchAllCap}) → ${artistsToCheck.length} requests`;
        const prose =
          `[dry run] check_artist_releases preview — no API calls were made and nothing was changed.\n`
          + `Watchlist "${listName}": ${watchlistSize} artists total, would check ${artistsToCheck.length} (cap ${effectiveCap}).\n`
          + `Cost estimate: ${costEstimate}${truncated ? ` (${watchlistSize - effectiveCap} artists would be skipped — raise max_artists to check all)` : ''}.`;
        return {
          content: [{ type: 'text', text: prose }],
          structuredContent: {
            ok: true,
            dry_run: true,
            watchlist: listName,
            watchlist_size: watchlistSize,
            would_check: artistsToCheck.length,
            capped_at: effectiveCap,
            max_artists: budget,
            truncated,
            cost_estimate: costEstimate,
            artists: artistsToCheck,
          },
        };
      }

      let quotaHit = false;
      let quotaRetryAfter: number | undefined;
      let quotaScanned = 0;
      const perArtist: Array<{ artist_id: string; newReleases: AlbumItem[] }> = [];
      for (const artistId of artistsToCheck) {
        try {
          const data = await client.get<{ items: AlbumItem[] }>(`/artists/${encodeURIComponent(artistId)}/albums`, {
            include_groups: 'album,single',
            limit: String(args.limit ?? 10),
            offset: '0',
          });
          const items = data?.items ?? [];
          const seen = new Set(entry.seen[artistId] ?? []);
          const filtered = items.filter((al) => !seen.has(al.id) && isNewRelease(al, args.lookback_days));
          perArtist.push({ artist_id: artistId, newReleases: filtered });
        } catch (err) {
          const q = isQuotaError(err);
          if (q.quota) {
            quotaHit = true;
            quotaRetryAfter = q.retryAfter;
            quotaScanned = perArtist.length;
            break;
          }
          throw err;
        }
      }
      const successfulScanned = perArtist.length;
      const artistsScanned = quotaHit ? quotaScanned : successfulScanned;
      // Only mark seen for successful lookups
      for (const { artist_id, newReleases } of perArtist) {
        if (!entry.seen[artist_id]) entry.seen[artist_id] = [];
        for (const al of newReleases) if (!entry.seen[artist_id].includes(al.id)) entry.seen[artist_id].push(al.id);
      }
      if (perArtist.length > 0) {
        entry.lastChecked = new Date().toISOString();
        await saveStore(store);
      }
      const allNew = perArtist.flatMap((p) => p.newReleases.map((al) => ({ artist_id: p.artist_id, album: al })));
      const baseExtra = {
        watchlist: listName,
        watchlist_size: watchlistSize,
        artists_scanned: artistsScanned,
        truncated,
        truncated_by_budget: truncated,
        max_artists: budget,
        effective_cap: effectiveCap,
        ...(quotaHit ? { quota_hit: true, retry_after: quotaRetryAfter ?? null, quota_scanned: quotaScanned } : {}),
      };
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { ...baseExtra, new_releases: allNew, total: allNew.length };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      if (allNew.length === 0) {
        let msg = `No new releases for watchlist "${listName}"${args.lookback_days ? ` (last ${args.lookback_days} days)` : ''}. Scanned ${artistsScanned}/${watchlistSize} artists${truncated ? ` (capped at ${effectiveCap})` : ''}.`;
        if (quotaHit) msg += ` Quota exceeded mid-scan (QUOTA_EXCEEDED) after ${quotaScanned} artists.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''} Partial results.`;
        return { content: [{ type: 'text', text: msg }], structuredContent: { ...baseExtra, total: 0, items: [] } };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(allNew, cap);
      const lines = [`New releases for watchlist "${listName}" (${allNew.length}):`];
      trunc.items.forEach(({ artist_id, album }) => lines.push(`  \u2022 "${album.name}" by ${artist_id} (${album.album_type}, ${album.release_date}) | URI: ${album.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      if (truncated) lines.push(`Truncated by budget: scanned ${effectiveCap} of ${watchlistSize} artists (max_artists=${budget}). Raise max_artists to check all.`);
      if (quotaHit) {
        const retryMsg = quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : '';
        lines.push(`Quota exceeded mid-scan (QUOTA_EXCEEDED) after ${quotaScanned} artists — partial results.${retryMsg}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { ...baseExtra, total: allNew.length, items: trunc.items, pagination: paginationInfo({ total: allNew.length, returned: trunc.items.length }) },
      };
    },
  );

  server.tool(
    'artist_release_digest',
    'Show a digest of new releases since the last check for a watchlist. '
      + 'WARNING: N artists = N requests. Use max_artists to budget and dry_run to preview.',
    {
      watchlist_name: z.string().optional().describe('Watchlist name. Default: "default"'),
      max_artists: z.number().int().min(1).max(200).optional().describe(
        'Per-call budget for artist lookups. Default: 25 (or SPOTIFY_MCP_FRESHNESS_BUDGET).',
      ),
      dry_run: DryRun,
      ...sharedListFields,
    },
    async (args) => {
      const listName = args.watchlist_name ?? 'default';
      const store = await loadStore();
      const entry = store.watchlists[listName];
      if (!entry || entry.artists.length === 0) {
        return { content: [{ type: 'text', text: `Watchlist "${listName}" is empty.` }] };
      }
      const watchlistSize = entry.artists.length;
      const budget = args.max_artists ?? getConfig().freshnessBudget;
      const effectiveCap = Math.min(budget, getConfig().fetchAllCap);
      const truncated = watchlistSize > effectiveCap;
      const artistsToCheck = entry.artists.slice(0, effectiveCap);

      if (args.dry_run) {
        const costEstimate = `${watchlistSize} artists in watchlist "${listName}" \u2192 ${artistsToCheck.length} album lookups (capped at max_artists=${budget}, effective ${effectiveCap} with fetchAllCap=${getConfig().fetchAllCap}) → ${artistsToCheck.length} requests`;
        const prose =
          `[dry run] artist_release_digest preview — no API calls were made.\n`
          + `Watchlist "${listName}": ${watchlistSize} artists total, would check ${artistsToCheck.length} (cap ${effectiveCap}).\n`
          + `Cost estimate: ${costEstimate}${truncated ? ` (${watchlistSize - effectiveCap} artists would be skipped)` : ''}.`;
        return {
          content: [{ type: 'text', text: prose }],
          structuredContent: {
            ok: true,
            dry_run: true,
            watchlist: listName,
            watchlist_size: watchlistSize,
            would_check: artistsToCheck.length,
            capped_at: effectiveCap,
            max_artists: budget,
            truncated,
            cost_estimate: costEstimate,
            artists: artistsToCheck,
          },
        };
      }

      let quotaHit = false;
      let quotaRetryAfter: number | undefined;
      let quotaScanned = 0;
      const perArtist: Array<{ artist_id: string; releases: AlbumItem[] }> = [];
      for (const artistId of artistsToCheck) {
        try {
          const data = await client.get<{ items: AlbumItem[] }>(`/artists/${encodeURIComponent(artistId)}/albums`, {
            include_groups: 'album,single',
            limit: '10',
            offset: '0',
          });
          const items = data?.items ?? [];
          const seen = new Set(entry.seen[artistId] ?? []);
          const unseen = items.filter((al) => !seen.has(al.id));
          if (unseen.length) perArtist.push({ artist_id: artistId, releases: unseen });
        } catch (err) {
          const q = isQuotaError(err);
          if (q.quota) {
            quotaHit = true;
            quotaRetryAfter = q.retryAfter;
            quotaScanned = perArtist.length;
            break;
          }
          throw err;
        }
      }
      const allUnseen = perArtist.flatMap((p) => p.releases.map((al) => ({ artist_id: p.artist_id, album: al })));
      const baseExtra = {
        watchlist: listName,
        watchlist_size: watchlistSize,
        artists_scanned: quotaHit ? quotaScanned : artistsToCheck.length,
        truncated,
        truncated_by_budget: truncated,
        max_artists: budget,
        effective_cap: effectiveCap,
        lastChecked: entry.lastChecked,
        ...(quotaHit ? { quota_hit: true, retry_after: quotaRetryAfter ?? null } : {}),
      };
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { ...baseExtra, lastChecked: entry.lastChecked, digest: allUnseen };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      if (allUnseen.length === 0) {
        const when = entry.lastChecked ? ` (last checked ${entry.lastChecked})` : '';
        let msg = `No unseen releases for watchlist "${listName}"${when}. Scanned ${quotaHit ? quotaScanned : artistsToCheck.length}/${watchlistSize} artists${truncated ? ` (capped at ${effectiveCap})` : ''}.`;
        if (quotaHit) msg += ` Quota exceeded after ${quotaScanned} artists.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''}`;
        return { content: [{ type: 'text', text: msg }], structuredContent: { ...baseExtra, total: 0 } };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(allUnseen, cap);
      const lines = [`Release digest for "${listName}" \u2014 ${allUnseen.length} unseen${entry.lastChecked ? ` since ${entry.lastChecked}` : ''}:`];
      trunc.items.forEach(({ artist_id, album }) => lines.push(`  \u2022 "${album.name}" by ${artist_id} (${album.release_date}) | URI: ${album.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      if (truncated) lines.push(`Truncated by budget: scanned ${effectiveCap} of ${watchlistSize} artists (max_artists=${budget}).`);
      if (quotaHit) lines.push(`Quota exceeded mid-scan after ${quotaScanned} artists — partial results.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''}`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { ...baseExtra, total: allUnseen.length, items: trunc.items },
      };
    },
  );
}
