import { z } from 'zod';
import { ARTIST_ALBUM_PAGE_LIMIT, MARKET_CODE } from './catalog.js';
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
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifySpotifyReference } from '../refs.js';

/**
 * Store plumbing (#764).
 *
 * This sidecar is the only store in the server whose persistence was silently
 * best-effort: every write error was swallowed, a corrupt file read as an empty
 * store, and the path resolved against the host's cwd. A watchlist could
 * therefore vanish with a confident `1 added`, or be invisible purely because
 * the server was launched from a different directory. Persistence here is
 * honest in both directions: a write that fails is reported as a failure, and
 * an unreadable file is reported as unreadable instead of being reset.
 */

/** The file, named for the caller so a failure is never anonymous. */
export function artistWatchlistPath(env: NodeJS.ProcessEnv = process.env): string {
  // Aligned with every other sidecar (~/.spotify-mcp), with
  // SPOTIFY_MCP_DATA_DIR kept as the documented directory override.
  const dir = env.SPOTIFY_MCP_DATA_DIR?.trim();
  return join(dir ? dir : join(homedir(), '.spotify-mcp'), 'artist-watchlist.json');
}

/**
 * Pre-v2 location, resolved against the process cwd. Read as a fallback so a
 * watchlist built before the path was aligned is picked up rather than
 * reported as an empty list (#764).
 */
const LEGACY_WATCHLIST_PATH = join('./data', 'artist-watchlist.json');

/**
 * Copy the bytes of a sidecar we could not use to `<path>.corrupt[N]`, 0600.
 *
 * Never overwrites an existing copy: the corruption report points the user at
 * that copy to repair from, so a later, different corrupt state must not
 * clobber the first one's evidence. `flag: 'wx'` makes the O_EXCL guarantee
 * the probe loop relies on. Best-effort — a read-only directory must not mask
 * the corruption report itself, and the original still names the file to fix.
 */
async function quarantineCorruptSidecar(path: string): Promise<string | undefined> {
  for (let n = 1; n <= 50; n += 1) {
    const backup = n === 1 ? `${path}.corrupt` : `${path}.corrupt.${n}`;
    try {
      await writeFile(backup, await readFile(path), { mode: 0o600, flag: 'wx' });
      await chmod(backup, 0o600);
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return undefined;
    }
  }
  return undefined;
}

/** Tail of a corruption report: where the preserved copy is, and that we stopped. */
function quarantineNote(backup: string | undefined): string {
  if (backup === undefined) {
    return 'It was left untouched — repair or move it aside, then retry; watchlists stay blocked so '
      + 'your existing artists cannot be overwritten.';
  }
  const earlier = backup.endsWith('.corrupt')
    ? ''
    : ` An earlier detection's copy is still at ${backup.replace(/\.corrupt\.\d+$/, '.corrupt')}, `
      + 'kept intact so the original post-crash state was not overwritten.';
  return `Its exact bytes were preserved at ${backup} and it was left untouched — repair or move it `
    + `aside, then retry; watchlists stay blocked so your existing artists cannot be overwritten.${earlier}`;
}

/**
 * Parse one sidecar file. Only an ABSENT file is the bootstrap case; a file that
 * exists but cannot be read, parsed, or recognised is corruption and is
 * reported with its path. Coercing either to "no watchlist" would let the next
 * `watch_artists` write replace a user's lists with a one-artist stub and
 * report success — the same class of coercion #759 and #839 exist to end.
 */
async function readStoreFile(path: string): Promise<WatchlistStore> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // ENOENT propagates so the caller can decide between the legacy path and an
    // empty store; every other read failure is corruption.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    throw new Error(
      `Watchlist sidecar ${path} could not be read (${(err as Error).message}). `
      + quarantineNote(await quarantineCorruptSidecar(path)),
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Includes the zero-length file a crash mid-write leaves behind.
    throw new Error(
      `Watchlist sidecar ${path} is not valid JSON (${(err as Error).message}). `
      + quarantineNote(await quarantineCorruptSidecar(path)),
      { cause: err },
    );
  }

  // Unchecked cast held in a named const: JSON.parse yielded `unknown` and the
  // `watchlists` member is validated immediately below.
  const candidate = parsed as { watchlists?: unknown };
  const lists = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? candidate.watchlists
    : undefined;
  if (lists === null || typeof lists !== 'object' || Array.isArray(lists)) {
    throw new Error(
      `Watchlist sidecar ${path} is not a watchlist store: expected `
      + '{"watchlists":{"<name>":{"artists":["<artist_id>"],"lastChecked":null,"seen":{}}}}. '
      + quarantineNote(await quarantineCorruptSidecar(path)),
    );
  }
  return { watchlists: lists as Record<string, WatchlistEntry> };
}

/** The loaded store, where it came from, and the file every write must target. */
type LoadedStore = { store: WatchlistStore; path: string; migratedFrom: string | undefined };

/**
 * Read the watchlist, falling back to the legacy cwd-relative file only when the
 * current one is genuinely absent. `path` is always the CURRENT location, so a
 * migrated store is rewritten there by the caller's next save.
 */
async function loadStore(): Promise<LoadedStore> {
  const path = artistWatchlistPath();
  try {
    return { store: await readStoreFile(path), path, migratedFrom: undefined };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (path !== LEGACY_WATCHLIST_PATH) {
    try {
      return { store: await readStoreFile(LEGACY_WATCHLIST_PATH), path, migratedFrom: LEGACY_WATCHLIST_PATH };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return { store: { watchlists: {} }, path, migratedFrom: undefined };
}

/** A load that failed, kept as data so the tool can report it in its own words. */
type StoreRead = { ok: true } & LoadedStore | { ok: false; error: string };

/**
 * Load the store for a tool call.
 *
 * A corruption report is the whole answer when the sidecar cannot be read, so
 * it is returned rather than thrown: the process-wide tool boundary turns a
 * thrown error into a generic "invalid arguments" envelope, which would name
 * the wrong cause and drop the path the user has to repair.
 */
async function readStoreForTool(): Promise<StoreRead> {
  try {
    return { ok: true, ...(await loadStore()) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** The failure result every watchlist tool returns for an unreadable store. */
function storeUnreadable(error: string) {
  return {
    content: [{ type: 'text' as const, text: `Watchlist could not be read: ${error}` }],
    structuredContent: { ok: false, persisted: false, reason: 'store_unreadable', error },
    isError: true,
  };
}

/**
 * Persist the sidecar atomically: temp file in the SAME directory, fsync, then
 * rename over the target. The rename is the only mutation of the real path, so a
 * crash before it leaves the previous store intact rather than a truncated one.
 * Temp file and target are owner-only (0600) and re-asserted after creation,
 * because a creation-time mode is masked by umask. Failures THROW — the caller
 * owes the agent a persistence failure rather than a success line (#764).
 */
async function saveStore(store: WatchlistStore, path: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
      await handle.sync(); // on disk before the rename can publish them
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    // Never strand a partial temp file for the next write to trip over.
    try { await unlink(tmp); } catch { /* nothing left to clean up */ }
    throw err;
  }
}

/** Prose for a write that did not land, naming the file and the reason. */
function persistFailureNote(path: string, error: unknown): string {
  return `NOT saved: writing ${path} failed (${(error as Error).message}). `
    + 'Nothing was persisted — fix the path or its permissions and re-run.';
}

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

/**
 * Why a per-artist scan stopped early, or null when this artist merely failed
 * and the scan should continue. SpotifyApiError has already retried each of
 * these once internally, so anything that reaches here is persistent: keeping
 * the loop going would only spend the rest of the budget on requests that
 * cannot succeed.
 */
type ScanStop = { kind: 'quota' | 'rate_limit' | 'auth'; retryAfter: number | undefined };

function scanStopReason(err: unknown): ScanStop | null {
  const q = isQuotaError(err);
  if (q.quota) return { kind: 'quota', retryAfter: q.retryAfter };
  const api = err !== null && typeof err === 'object' ? (err as { status?: unknown; retryAfterSec?: unknown }) : null;
  const ra = api?.retryAfterSec;
  const retryAfter = typeof ra === 'number' ? ra : undefined;
  if (api?.status === 429) return { kind: 'rate_limit', retryAfter };
  if (api?.status === 401) return { kind: 'auth', retryAfter: undefined };
  return null;
}

/**
 * A watched artist whose release lookup failed. It stays out of the results
 * list and is reported on its own: an artist that could not be read is not an
 * artist with zero new releases (#772).
 */
type ArtistLookupFailure = {
  artist_id: string;
  reason: string;
  status?: number;
  spotify_reason?: string;
};

function describeLookupFailure(err: unknown): Omit<ArtistLookupFailure, 'artist_id'> {
  const api = err as { status?: unknown; reason?: unknown } | null;
  const message = err instanceof Error && err.message ? err.message : String(err);
  return {
    reason: message,
    ...(typeof api?.status === 'number' ? { status: api.status } : {}),
    ...(typeof api?.reason === 'string' ? { spotify_reason: api.reason } : {}),
  };
}

/** One line naming every unreadable artist and why, so the bad id is actionable. */
function failureNote(failures: ArtistLookupFailure[]): string {
  const detail = failures.map((f) => `${f.artist_id} (${f.reason})`).join(', ');
  return `${failures.length} watched artist(s) could not be read and are excluded from these results: ${detail}.`;
}

export function registerArtistWatchTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'get_artist_discography',
    'Get filtered discography for an artist (GET /artists/{id}/albums with album-type filtering)',
    {
      artist_id: z.string().describe('Spotify artist ID'),
      album_types: z.array(z.enum(['album', 'single', 'appears_on', 'compilation'])).optional().describe('Filter to these album types. Default: all'),
      include_groups: z.array(z.enum(['album', 'single', 'appears_on', 'compilation'])).optional().describe('Alias for album_types (Spotify include_groups)'),
      limit: z.number().int().min(1).max(ARTIST_ALBUM_PAGE_LIMIT).optional().describe(`Results per page, 1–${ARTIST_ALBUM_PAGE_LIMIT}. Default: ${ARTIST_ALBUM_PAGE_LIMIT}`),
      offset: z.number().int().min(0).optional().describe('Offset'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      ...sharedListFields,
    },
    async (args) => {
      const types = (args.album_types ?? args.include_groups ?? undefined) as string[] | undefined;
      const includeGroups = types ? types.join(',') : undefined;
      const params: Record<string, string> = {
        limit: String(Math.min(args.limit ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)),
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
      const parsed = classifySpotifyReference(args.query, 'artist', { allowShortIds: true });
      if (parsed.valid && parsed.form === 'uri' && parsed.id) {
        const id = parsed.id;
        if (args.response_format === 'json') {
          const raw: Record<string, unknown> = { id, uri: `spotify:artist:${id}`, name: null };
          return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
        }
        return { content: [{ type: 'text', text: `Resolved "${args.query}" → artist ID: ${id} | URI: spotify:artist:${id}` }], structuredContent: { id, uri: `spotify:artist:${id}` } };
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
    'Find new releases for an artist and save unsaved albums to Your Library (diffs against /me/library/contains)',
    {
      artist_id: z.string().describe('Spotify artist ID'),
      limit: z.number().int().min(1).max(ARTIST_ALBUM_PAGE_LIMIT).optional().describe(`Albums to fetch, 1–${ARTIST_ALBUM_PAGE_LIMIT}. Default: ${ARTIST_ALBUM_PAGE_LIMIT}`),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 country code, e.g. \'US\''),
      response_format: ResponseFormat,
    },
    async (args) => {
      const data = await client.get<{ items: AlbumItem[] }>(
        `/artists/${encodeURIComponent(args.artist_id)}/albums`,
        { include_groups: 'album,single', limit: String(Math.min(args.limit ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)), offset: '0', ...(args.market ? { market: args.market } : {}) },
      );
      const albums = data?.items ?? [];
      if (albums.length === 0) {
        return { content: [{ type: 'text', text: `No releases found for artist "${args.artist_id}".` }] };
      }
      const ids = albums.map((a) => a.id);
      // Saving is a mutation: an unavailable or ambiguous contains response
      // must never be interpreted as "unsaved".  Require one strict boolean
      // per requested URI before issuing any PUT.
      const res = await client.get<unknown>('/me/library/contains', {
        uris: ids.map((id) => `spotify:album:${id}`).join(','),
      });
      if (
        !Array.isArray(res)
        || res.length !== ids.length
        || res.some((value) => typeof value !== 'boolean')
      ) {
        throw new Error('Unable to verify Your Library saved state; no albums were saved.');
      }
      const contains = res;
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
    'Add artists to a watchlist sidecar for new-release polling. File ~/.spotify-mcp/artist-watchlist.json (SPOTIFY_MCP_DATA_DIR overrides); a failed write is reported, not swallowed.',
    {
      artist_ids: z.array(z.string().min(1)).min(1).describe('Spotify artist IDs to watch'),
      name: z.string().optional().describe('Watchlist name. Default: "default"'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const listName = args.name ?? 'default';
      const read = await readStoreForTool();
      if (!read.ok) return storeUnreadable(read.error);
      const { store, path, migratedFrom } = read;
      const entry = ensureList(store, listName);
      const before = entry.artists.length;
      for (const id of args.artist_ids as string[]) {
        if (!entry.artists.includes(id)) entry.artists.push(id);
      }
      const added = entry.artists.length - before;
      // A watchlist that was never written is a lie the agent will act on, so a
      // failed save is the whole answer: no `N added` line survives it (#764).
      try {
        await saveStore(store, path);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Watchlist "${listName}": ${added} would be added, ${entry.artists.length} in total, but ${persistFailureNote(path, err)}` }],
          structuredContent: {
            ok: false,
            persisted: false,
            name: listName,
            added,
            total: entry.artists.length,
            artists: [...entry.artists],
            path,
            error: (err as Error).message,
          },
          isError: true,
        };
      }
      let msg = `Watchlist "${listName}": ${added} added, ${entry.artists.length} total (saved to ${path}).`;
      if (migratedFrom) msg += ` Migrated from the legacy location ${migratedFrom}.`;
      if (entry.artists.length > 50) {
        msg += ` Warning: watchlist has ${entry.artists.length} artists — check_artist_releases will cap at max_artists (default 25) and each check costs 1 request per artist. Consider using a smaller watchlist or raising max_artists explicitly.`;
      }
      const base: Record<string, unknown> = { name: listName, added, total: entry.artists.length, artists: [...entry.artists], persisted: true, path, ...(migratedFrom ? { migrated_from: migratedFrom } : {}) };
      if (entry.artists.length > 50) base.warning = `watchlist exceeds 50 artists (${entry.artists.length}); polling will be capped`;
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(base, null, 2) }], structuredContent: base };
      }
      return { content: [{ type: 'text', text: msg }], structuredContent: base };
    },
  );

  server.tool(
    'check_artist_releases',
    'Check watched artists for new releases since last check (or within lookback_days). '
      + 'WARNING: N artists in watchlist = N API requests. Use max_artists to budget and dry_run to preview cost. '
      + 'Unreadable artists are listed in `failures` with the reason and excluded from the results; artists_scanned counts artists examined, not those with new releases.',
    {
      watchlist_name: z.string().optional().describe('Watchlist name. Default: "default"'),
      lookback_days: z.number().int().min(1).max(365).optional().describe('Only consider releases from the last N days'),
      limit: z.number().int().min(1).max(ARTIST_ALBUM_PAGE_LIMIT).optional().describe(`Albums per artist to fetch, 1–${ARTIST_ALBUM_PAGE_LIMIT}. Default: ${ARTIST_ALBUM_PAGE_LIMIT}`),
      max_artists: z.number().int().min(1).max(200).optional().describe(
        'Per-call artist lookup budget. Default: 25 (or SPOTIFY_MCP_FRESHNESS_BUDGET). '
          + 'Reports watchlist_size / artists_scanned / truncated.',
      ),
      dry_run: DryRun,
      ...sharedListFields,
    },
    async (args) => {
      const listName = args.watchlist_name ?? 'default';
      const read = await readStoreForTool();
      if (!read.ok) return storeUnreadable(read.error);
      const { store, path, migratedFrom } = read;
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
            path,
            ...(migratedFrom ? { migrated_from: migratedFrom } : {}),
          },
        };
      }

      let quotaHit = false;
      let quotaRetryAfter: number | undefined;
      let rateLimited = false;
      let rateRetryAfter: number | undefined;
      let authFailed = false;
      let quotaScanned = 0;
      // Artists actually attempted, counted apart from the result list: a scan
      // that examined N artists must report N even when none of them had
      // anything new, and a quota wall must not read as "scanned 0" (#771).
      let artistsScanned = 0;
      const failures: ArtistLookupFailure[] = [];
      const perArtist: Array<{ artist_id: string; newReleases: AlbumItem[] }> = [];
      for (const artistId of artistsToCheck) {
        artistsScanned++;
        try {
          const data = await client.get<{ items: AlbumItem[] }>(`/artists/${encodeURIComponent(artistId)}/albums`, {
            include_groups: 'album,single',
            limit: String(Math.min(args.limit ?? ARTIST_ALBUM_PAGE_LIMIT, ARTIST_ALBUM_PAGE_LIMIT)),
            offset: '0',
          });
          const items = data?.items ?? [];
          const seen = new Set(entry.seen[artistId] ?? []);
          const filtered = items.filter((al) => !seen.has(al.id) && isNewRelease(al, args.lookback_days));
          perArtist.push({ artist_id: artistId, newReleases: filtered });
        } catch (err) {
          const stop = scanStopReason(err);
          if (stop) {
            // A rate limit or a dead token is not this artist's fault and not
            // per-artist: stop spending the budget on requests that cannot
            // succeed, keeping everything collected so far.
            if (stop.kind === 'quota') {
              quotaHit = true;
              quotaRetryAfter = stop.retryAfter;
            } else if (stop.kind === 'rate_limit') {
              rateLimited = true;
              rateRetryAfter = stop.retryAfter;
            } else {
              authFailed = true;
            }
            quotaScanned = artistsScanned;
            break;
          }
          // One stale or mistyped id in a persisted watchlist must not cost the
          // caller every other artist's results: record it and keep scanning (#772).
          failures.push({ artist_id: artistId, ...describeLookupFailure(err) });
        }
      }
      const artistsRead = perArtist.length;
      // Only mark seen for successful lookups
      for (const { artist_id, newReleases } of perArtist) {
        if (!entry.seen[artist_id]) entry.seen[artist_id] = [];
        for (const al of newReleases) if (!entry.seen[artist_id].includes(al.id)) entry.seen[artist_id].push(al.id);
      }
      // A scan whose `seen` bookkeeping never reached disk reports the same
      // releases next time; say so rather than let a clean result imply the
      // watchlist advanced (#764).
      let persistError: string | undefined;
      if (perArtist.length > 0) {
        entry.lastChecked = new Date().toISOString();
        try {
          await saveStore(store, path);
        } catch (err) {
          persistError = (err as Error).message;
        }
      }
      const persistNote = persistError === undefined ? '' : ` ${persistFailureNote(path, persistError)}`;
      const persistExtra = persistError === undefined
        ? { persisted: true, path, ...(migratedFrom ? { migrated_from: migratedFrom } : {}) }
        : { persisted: false, path, error: persistError };
      const allNew = perArtist.flatMap((p) => p.newReleases.map((al) => ({ artist_id: p.artist_id, album: al })));
      const baseExtra = {
        watchlist: listName,
        watchlist_size: watchlistSize,
        artists_scanned: artistsScanned,
        artists_read: artistsRead,
        artists_failed: failures.length,
        failures,
        truncated,
        truncated_by_budget: truncated,
        max_artists: budget,
        effective_cap: effectiveCap,
        ...(quotaHit ? { quota_hit: true, retry_after: quotaRetryAfter ?? null, quota_scanned: quotaScanned } : {}),
        ...(rateLimited ? { rate_limited: true, retry_after: rateRetryAfter ?? null, rate_limit_scanned: quotaScanned } : {}),
        ...(authFailed ? { auth_error: true, auth_error_scanned: quotaScanned } : {}),
        ...persistExtra,
      };
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { ...baseExtra, new_releases: allNew, total: allNew.length };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      if (allNew.length === 0) {
        // Nothing readable at all is a failed scan, not a clean "no releases".
        const readNothing = artistsRead === 0 && (failures.length > 0 || quotaHit || rateLimited || authFailed);
        let msg = readNothing
          ? `No releases could be read for watchlist "${listName}" — ${artistsRead} of ${artistsScanned} attempted artists were readable.`
          : `No new releases for watchlist "${listName}"${args.lookback_days ? ` (last ${args.lookback_days} days)` : ''}. Scanned ${artistsScanned}/${watchlistSize} artists${truncated ? ` (capped at ${effectiveCap})` : ''}.`;
        if (quotaHit) msg += ` Quota exceeded mid-scan (QUOTA_EXCEEDED) after ${quotaScanned} artists.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''} Partial results.`;
        if (rateLimited) msg += ` Rate limited (429) after ${quotaScanned} artists.${rateRetryAfter != null ? ` Retry-After: ${rateRetryAfter}s.` : ''} Partial results.`;
        if (authFailed) msg += ' Spotify rejected the access token (401) after a refresh — re-run `spotify-mcp auth`. Partial results.';
        if (failures.length > 0) msg += ` ${failureNote(failures)}`;
        if (persistNote) msg += persistNote;
        return { content: [{ type: 'text', text: msg }], structuredContent: { ...baseExtra, total: 0, items: [] } };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(allNew, cap);
      const lines = [`New releases for watchlist "${listName}" (${allNew.length}) — scanned ${artistsScanned}/${watchlistSize} artists${failures.length > 0 ? `, ${failures.length} unreadable` : ''}:`];
      trunc.items.forEach(({ artist_id, album }) => lines.push(`  \u2022 "${album.name}" by ${artist_id} (${album.album_type}, ${album.release_date}) | URI: ${album.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      if (truncated) lines.push(`Truncated by budget: scanned ${artistsScanned} of ${watchlistSize} artists (max_artists=${budget}). Raise max_artists to check all.`);
      if (quotaHit) {
        const retryMsg = quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : '';
        lines.push(`Quota exceeded mid-scan (QUOTA_EXCEEDED) after ${quotaScanned} artists — partial results.${retryMsg}`);
      }
      if (rateLimited) {
        const retryMsg = rateRetryAfter != null ? ` Retry-After: ${rateRetryAfter}s.` : '';
        lines.push(`Rate limited (429) after ${quotaScanned} artists — partial results.${retryMsg}`);
      }
      if (authFailed) lines.push('Spotify rejected the access token (401) after a refresh — re-run `spotify-mcp auth`. Partial results.');
      if (failures.length > 0) lines.push(failureNote(failures));
      if (persistNote) lines.push(persistNote.trim());
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { ...baseExtra, total: allNew.length, items: trunc.items, pagination: paginationInfo({ total: allNew.length, returned: trunc.items.length }) },
      };
    },
  );

  server.tool(
    'artist_release_digest',
    'Show a digest of new releases since the last check for a watchlist. '
      + 'WARNING: N artists = N requests. Use max_artists to budget and dry_run to preview. '
      + 'Unreadable artists are listed in `failures` with the reason; artists_scanned counts artists examined, not those with new releases.',
    {
      watchlist_name: z.string().optional().describe('Watchlist name. Default: "default"'),
      max_artists: z.number().int().min(1).max(200).optional().describe(
        'Per-call artist lookup budget. Default: 25 (or SPOTIFY_MCP_FRESHNESS_BUDGET).',
      ),
      dry_run: DryRun,
      ...sharedListFields,
    },
    async (args) => {
      const listName = args.watchlist_name ?? 'default';
      const read = await readStoreForTool();
      if (!read.ok) return storeUnreadable(read.error);
      const { store, path, migratedFrom } = read;
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
            path,
            ...(migratedFrom ? { migrated_from: migratedFrom } : {}),
          },
        };
      }

      let quotaHit = false;
      let quotaRetryAfter: number | undefined;
      let rateLimited = false;
      let rateRetryAfter: number | undefined;
      let authFailed = false;
      let quotaScanned = 0;
      // perArtist holds only artists that had something unseen, so it cannot
      // stand in for scan accounting: count attempts and readable artists
      // separately or a 25-artist scan with 1 hit reports "scanned 0" (#771).
      let artistsScanned = 0;
      let artistsRead = 0;
      const failures: ArtistLookupFailure[] = [];
      const perArtist: Array<{ artist_id: string; releases: AlbumItem[] }> = [];
      for (const artistId of artistsToCheck) {
        artistsScanned++;
        try {
          const data = await client.get<{ items: AlbumItem[] }>(`/artists/${encodeURIComponent(artistId)}/albums`, {
            include_groups: 'album,single',
            limit: String(ARTIST_ALBUM_PAGE_LIMIT),
            offset: '0',
          });
          artistsRead++;
          const items = data?.items ?? [];
          const seen = new Set(entry.seen[artistId] ?? []);
          const unseen = items.filter((al) => !seen.has(al.id));
          if (unseen.length) perArtist.push({ artist_id: artistId, releases: unseen });
        } catch (err) {
          const stop = scanStopReason(err);
          if (stop) {
            if (stop.kind === 'quota') {
              quotaHit = true;
              quotaRetryAfter = stop.retryAfter;
            } else if (stop.kind === 'rate_limit') {
              rateLimited = true;
              rateRetryAfter = stop.retryAfter;
            } else {
              authFailed = true;
            }
            quotaScanned = artistsScanned;
            break;
          }
          // Same tolerance as check_artist_releases: a stale id is named, the
          // rest of the digest still lands (#772).
          failures.push({ artist_id: artistId, ...describeLookupFailure(err) });
        }
      }
      const allUnseen = perArtist.flatMap((p) => p.releases.map((al) => ({ artist_id: p.artist_id, album: al })));
      const baseExtra = {
        watchlist: listName,
        watchlist_size: watchlistSize,
        artists_scanned: artistsScanned,
        artists_read: artistsRead,
        artists_failed: failures.length,
        failures,
        truncated,
        truncated_by_budget: truncated,
        max_artists: budget,
        effective_cap: effectiveCap,
        lastChecked: entry.lastChecked,
        watchlist_path: path,
        ...(migratedFrom ? { migrated_from: migratedFrom } : {}),
        ...(quotaHit ? { quota_hit: true, retry_after: quotaRetryAfter ?? null, quota_scanned: quotaScanned } : {}),
        ...(rateLimited ? { rate_limited: true, retry_after: rateRetryAfter ?? null, rate_limit_scanned: quotaScanned } : {}),
        ...(authFailed ? { auth_error: true, auth_error_scanned: quotaScanned } : {}),
      };
      if (args.response_format === 'json') {
        const raw: Record<string, unknown> = { ...baseExtra, lastChecked: entry.lastChecked, digest: allUnseen };
        return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }], structuredContent: raw };
      }
      if (allUnseen.length === 0) {
        const when = entry.lastChecked ? ` (last checked ${entry.lastChecked})` : '';
        const readNothing = artistsRead === 0 && (failures.length > 0 || quotaHit || rateLimited || authFailed);
        let msg = readNothing
          ? `No releases could be read for watchlist "${listName}" — none of the ${artistsScanned} attempted artists were readable.`
          : `No unseen releases for watchlist "${listName}"${when}. Scanned ${artistsScanned}/${watchlistSize} artists${truncated ? ` (capped at ${effectiveCap})` : ''}.`;
        if (quotaHit) msg += ` Quota exceeded after ${quotaScanned} artists.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''}`;
        if (rateLimited) msg += ` Rate limited (429) after ${quotaScanned} artists.${rateRetryAfter != null ? ` Retry-After: ${rateRetryAfter}s.` : ''}`;
        if (authFailed) msg += ' Spotify rejected the access token (401) after a refresh — re-run `spotify-mcp auth`.';
        if (failures.length > 0) msg += ` ${failureNote(failures)}`;
        return { content: [{ type: 'text', text: msg }], structuredContent: { ...baseExtra, total: 0 } };
      }
      const cap = resolveMaxResults(args.max_results);
      const trunc = truncateItems(allUnseen, cap);
      // The digest is read as a partial-results signal, so it states the
      // coverage it actually has instead of only the headline count (#771).
      const lines = [`Release digest for "${listName}" \u2014 ${allUnseen.length} unseen${entry.lastChecked ? ` since ${entry.lastChecked}` : ''} (scanned ${artistsScanned}/${watchlistSize} artists${failures.length > 0 ? `, ${failures.length} unreadable` : ''}):`];
      trunc.items.forEach(({ artist_id, album }) => lines.push(`  \u2022 "${album.name}" by ${artist_id} (${album.release_date}) | URI: ${album.uri}`));
      if (trunc.footer) lines.push('', `(${trunc.footer})`);
      if (truncated) lines.push(`Truncated by budget: scanned ${artistsScanned} of ${watchlistSize} artists (max_artists=${budget}).`);
      if (quotaHit) lines.push(`Quota exceeded mid-scan after ${quotaScanned} artists — partial results.${quotaRetryAfter != null ? ` Retry-After: ${quotaRetryAfter}s.` : ''}`);
      if (rateLimited) lines.push(`Rate limited (429) after ${quotaScanned} artists — partial results.${rateRetryAfter != null ? ` Retry-After: ${rateRetryAfter}s.` : ''}`);
      if (authFailed) lines.push('Spotify rejected the access token (401) after a refresh — re-run `spotify-mcp auth`. Partial results.');
      if (failures.length > 0) lines.push(failureNote(failures));
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { ...baseExtra, total: allUnseen.length, items: trunc.items },
      };
    },
  );
}
