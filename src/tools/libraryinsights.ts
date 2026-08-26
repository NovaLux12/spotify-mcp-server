import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { SavedTrackItem, SavedAlbumItem } from '../types/spotify.js';
import { getConfig } from '../config.js';
import {
  ResponseFormat,
  MaxResults,
  DryRun,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
  type ResponseFormatValue,
} from '../shaping.js';

// ---------------------------------------------------------------------------
// Library genre auto-tags + smart filters (issue #112 idea 1)
//
// VARIANT NOTE — sidecar tags. Live probe (2026-08-25, real user token):
// search-artist rows omit the `genres` key entirely and GET /artists/{id}
// returns `"genres": null`, so genre affinity cannot be derived from any
// Spotify surface this server may call. The shipped design therefore stores
// user-declared genre tags in a local JSON sidecar and joins them against
// the saved library (tracks + albums) for reporting and filtering.
//
// Sidecar layout (SPOTIFY_MCP_GENRE_TAGS_FILE overrides the path):
//   { "version": 1, "tags": { "<Artist Name>": ["pop", "indie"] } }
// Artist-name lookups are case-insensitive; the first-seen spelling wins.
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Emit a tool result (#51/#52): json mode stringifies the machine twin. */
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

/** Per-call cap: explicit max_results wins over SPOTIFY_MCP_MAX_ITEMS (#53). */
function cap(args: { max_results?: number }): number {
  return resolveMaxResults(args.max_results, getConfig().maxItems);
}

// ---------------------------------------------------------------------------
// Sidecar tag store
// ---------------------------------------------------------------------------

export interface GenreTagStore {
  version: 1;
  /** Artist display name → declared genre tags (lowercased values). */
  tags: Record<string, string[]>;
}

export function genreTagsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_GENRE_TAGS_FILE ?? join(homedir(), '.spotify-mcp', 'genre-tags.json');
}


/** Read the sidecar; a missing or unreadable file is an empty store, never a crash. */
export function loadGenreTags(path: string = genreTagsPath()): GenreTagStore {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GenreTagStore>;
    if (raw && typeof raw === 'object' && raw.tags && typeof raw.tags === 'object') {
      const tags: Record<string, string[]> = {};
      for (const [artist, genres] of Object.entries(raw.tags)) {
        if (typeof artist !== 'string' || !Array.isArray(genres)) continue;
        const clean = [...new Set(genres.filter((g): g is string => typeof g === 'string'))];
        if (clean.length > 0) tags[artist] = clean;
      }
      return { version: 1, tags };
    }
  } catch {
    // ENOENT / corrupt JSON / permission issue: treat as no tags yet.
  }
  return { version: 1, tags: {} };
}

function saveGenreTags(store: GenreTagStore, path: string = genreTagsPath()): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/** Find the stored key matching `artist` case-insensitively, or null. */
function findArtistKey(tags: Record<string, string[]>, artist: string): string | null {
  const needle = artist.trim().toLowerCase();
  for (const key of Object.keys(tags)) {
    if (key.toLowerCase() === needle) return key;
  }
  return null;
}

/** Tags declared for `artist` (case-insensitive), or []. */
function tagsForArtist(tags: Record<string, string[]>, artist: string): string[] {
  const key = findArtistKey(tags, artist);
  return key ? tags[key] : [];
}

// ---------------------------------------------------------------------------
// Saved-library scanning
// ---------------------------------------------------------------------------

/** One aggregated row per genre tag across the saved library. */
export interface GenreRow {
  genre: string;
  /** Saved tracks with at least one tagged artist carrying this genre. */
  tracks: number;
  /** Saved albums with at least one tagged artist carrying this genre. */
  albums: number;
  /** tracks + albums. */
  total: number;
  /** Distinct tagged artists carrying this genre, first-seen order. */
  artists: string[];
}

interface ScanResult {
  rows: GenreRow[];
  savedTracksTotal: number;
  savedAlbumsTotal: number;
  untaggedArtists: string[];
}

/**
 * Walk BOTH saved lists end-to-end and aggregate per-genre stats from the
 * sidecar. An item contributes once per distinct genre even when several of
 * its artists share that genre; repeated appearances of the same artist are
 * deduplicated into one entry per row's artist list.
 */
async function scanLibraryGenres(client: SpotifyClient): Promise<ScanResult> {
  const [savedTracks, savedAlbums] = await Promise.all([
    client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: getConfig().fetchAllCap }),
    client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: getConfig().fetchAllCap }),
  ]);

  const store = loadGenreTags();
  const byGenre = new Map<string, GenreRow>();
  const untagged = new Set<string>();

  const creditItem = (artists: Array<{ name: string }>, isTrack: boolean): void => {
    if (!Array.isArray(artists)) return;
    // Per-item genre set so a genre is counted once even with duplicate artists.
    const genresHere = new Set<string>();
    const artistsPerGenre = new Map<string, string[]>();
    for (const a of artists) {
      if (!a || typeof a.name !== 'string') continue;
      const genres = tagsForArtist(store.tags, a.name);
      if (genres.length === 0) {
        untagged.add(a.name);
        continue;
      }
      for (const g of genres) {
        genresHere.add(g);
        const seen = artistsPerGenre.get(g) ?? [];
        if (!seen.includes(a.name)) seen.push(a.name);
        artistsPerGenre.set(g, seen);
      }
    }
    for (const g of genresHere) {
      let row = byGenre.get(g);
      if (!row) {
        row = { genre: g, tracks: 0, albums: 0, total: 0, artists: [] };
        byGenre.set(g, row);
      }
      if (isTrack) row.tracks += 1;
      else row.albums += 1;
      row.total += 1;
      for (const name of artistsPerGenre.get(g) ?? []) {
        if (!row.artists.includes(name)) row.artists.push(name);
      }
    }
  };

  for (const item of savedTracks) {
    if (item?.track?.artists) creditItem(item.track.artists, true);
  }
  for (const item of savedAlbums) {
    if (item?.album?.artists) creditItem(item.album.artists, false);
  }

  const rows = [...byGenre.values()].sort(
    (a, b) => b.total - a.total || a.genre.localeCompare(b.genre),
  );
  return {
    rows,
    savedTracksTotal: savedTracks.length,
    savedAlbumsTotal: savedAlbums.length,
    untaggedArtists: [...untagged].sort((a, b) => a.localeCompare(b)),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLibraryInsightsTools(server: McpServer, client: SpotifyClient): void {
  // -------------------------------------------------------------------------
  // library_genre_report — per-genre counts over the saved library
  // -------------------------------------------------------------------------
  server.tool(
    'library_genre_report',
    'Aggregate your saved library by user-declared genre tags. Scans all saved tracks and albums, joins each item\'s artists against your tag sidecar (see tag_management), and reports per-genre track/album counts plus the contributing artists. Genres are unavailable from Spotify itself, so only artists you have tagged appear here.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async ({ response_format, max_results }) => {
      const rf = response_format;
      const scan = await scanLibraryGenres(client);
      const maxResults = cap({ max_results });

      if (scan.savedTracksTotal === 0 && scan.savedAlbumsTotal === 0) {
        const payload = {
          ...listStructuredContent([], paginationInfo({ total: 0, returned: 0 })),
          library: { saved_tracks_total: 0, saved_albums_total: 0 },
          untagged_artists: [],
        };
        return shapeResult(rf, 'Your saved library (tracks + albums) is empty — nothing to report.', payload);
      }

      const t = truncateItems(scan.rows, maxResults);
      const pagination = paginationInfo({
        total: t.total,
        returned: t.returned,
      });

      const header =
        `Genre report over ${scan.savedTracksTotal} saved track(s), ` +
        `${scan.savedAlbumsTotal} saved album(s):\n`;
      const lines: string[] = [];
      if (t.items.length === 0) {
        lines.push('No tagged artists found — use tag_management to declare genres first.');
      } else {
        for (const row of t.items) {
          const top = row.artists.slice(0, 5).join(', ');
          const more = row.artists.length > 5 ? ` (+${row.artists.length - 5} more)` : '';
          lines.push(`• ${row.genre}: ${row.tracks} track(s), ${row.albums} album(s) — ${top}${more}`);
        }
      }
      if (t.footer) lines.push(`(${t.footer})`);
      if (scan.untaggedArtists.length > 0) {
        const preview = scan.untaggedArtists.slice(0, 5).join(', ');
        const rest = scan.untaggedArtists.length > 5 ? '…' : '';
        lines.push(
          `Untagged artists (${scan.untaggedArtists.length}): ${preview}${rest} — tag them with tag_management.`,
        );
      }

      const payload = {
        ...listStructuredContent(t.items, pagination),
        library: {
          saved_tracks_total: scan.savedTracksTotal,
          saved_albums_total: scan.savedAlbumsTotal,
        },
        untagged_artists: scan.untaggedArtists,
      };
      return shapeResult(rf, header + lines.join('\n'), payload);
    },
  );

  // -------------------------------------------------------------------------
  // filter_by_genre — matching saved URIs, ready for playlist building
  // -------------------------------------------------------------------------
  server.tool(
    'filter_by_genre',
    'List URIs of your saved tracks or albums whose artists carry a given genre tag (case-insensitive tag-name match against your sidecar). Output is directly usable as create_playlist / add_to_playlist input. Read-only.',
    {
      genre: z.string().min(1).describe('Genre tag to match (case-insensitive, e.g. "pop")'),
      kind: z.enum(['tracks', 'albums']).describe('Which saved collection to filter'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async ({ genre, kind, response_format, max_results }) => {
      const rf = response_format;
      const maxResults = cap({ max_results });
      const wanted = genre.trim().toLowerCase();
      const tagStore = loadGenreTags().tags;

      const matches: string[] = [];
      if (kind === 'tracks') {
        const saved = await client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: getConfig().fetchAllCap });
        for (const item of saved) {
          const artists = item?.track?.artists;
          if (!Array.isArray(artists)) continue;
          if (artists.some((a) => tagsForArtist(tagStore, a.name).includes(wanted))) {
            if (item.track.id) matches.push(`spotify:track:${item.track.id}`);
          }
        }
      } else {
        const saved = await client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: getConfig().fetchAllCap });
        for (const item of saved) {
          const artists = item?.album?.artists;
          if (!Array.isArray(artists)) continue;
          if (artists.some((a) => tagsForArtist(tagStore, a.name).includes(wanted))) {
            if (item.album.id) matches.push(`spotify:album:${item.album.id}`);
          }
        }
      }

      const t = truncateItems(matches, maxResults);
      const pagination = paginationInfo({ total: t.total, returned: t.returned });

      const lines: string[] = [
        `Saved ${kind} matching genre "${genre}": ${t.total}`,
        ...t.items.map((uri, i) => `${i + 1}. ${uri}`),
      ];
      if (t.footer) lines.push(`(${t.footer})`);

      const payload = {
        ...listStructuredContent(t.items, pagination),
        genre: wanted,
        kind,
      };
      return shapeResult(rf, lines.join('\n'), payload);
    },
  );

  // -------------------------------------------------------------------------
  // tag_management — add/remove genre tags per artist (sidecar mutation)
  // -------------------------------------------------------------------------
  server.tool(
    'tag_management',
    'Declare or retract genre tags for an artist in your local sidecar (~/.spotify-mcp/genre-tags.json), which library_genre_report and filter_by_genre consume. add requires at least one tag; remove drops the listed tags, or the artist entirely when none are listed. Supports dry_run preview.',
    {
      action: z.enum(['add', 'remove']).describe('add tags to an artist, or remove tags/artist'),
      artist: z.string().min(1).describe('Artist name exactly as it appears in your library'),
      tags: z.array(z.string().min(1)).optional().describe('Tags to add/remove; omit on remove to drop the artist entirely'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async ({ action, artist, tags, dry_run, response_format }) => {
      const rf = response_format;
      const name = artist.trim();
      if (name.length === 0) throw new Error('artist must not be blank');
      if (action === 'add' && (!tags || tags.length === 0)) {
        throw new Error("add requires at least one tag — e.g. tags: ['pop']");
      }

      const store = loadGenreTags();
      const existingKey = findArtistKey(store.tags, name);
      const current = existingKey ? store.tags[existingKey] : [];

      if (action === 'remove' && (!tags || tags.length === 0)) {
        // Whole-artist removal.
        if (dry_run) {
          const payload = {
            ok: true,
            dry_run: true,
            action,
            artist: existingKey ?? name,
            removed_tags: current,
            remaining_tags: [],
            changes: [`Remove artist "${existingKey ?? name}" and tags [${current.join(', ')}]`],
          };
          return shapeResult(
            rf,
            `[dry run] Would remove artist "${existingKey ?? name}" (tags: ${
              current.join(', ') || 'none'
            }). Nothing was changed.`,
            payload,
          );
        }
        if (!existingKey) {
          return shapeResult(
            rf,
            `No tags recorded for "${name}" — nothing to remove.`,
            { ok: true, dry_run: false, artist: name, remaining_tags: [] },
          );
        }
        delete store.tags[existingKey];
        saveGenreTags(store);
        return shapeResult(
          rf,
          `Removed artist "${existingKey}" and their tags (${current.join(', ')}).`,
          { ok: true, dry_run: false, artist: existingKey, removed_tags: current, remaining_tags: [] },
        );
      }

      const incoming = (tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);

      if (action === 'add') {
        const merged = [...current];
        for (const t of incoming) if (!merged.includes(t)) merged.push(t);
        const added = merged.filter((t) => !current.includes(t));
        const key = existingKey ?? name;
        const summary = `Add [${added.join(', ')}] to "${key}" → tags [${merged.join(', ')}]`;
        if (dry_run) {
          const payload = {
            ok: true,
            dry_run: true,
            action,
            artist: key,
            current_tags: current,
            resulting_tags: merged,
            changes: [summary],
          };
          return shapeResult(rf, `[dry run] ${summary}. Nothing was changed.`, payload);
        }
        store.tags[key] = merged;
        saveGenreTags(store);
        return shapeResult(
          rf,
          `Tagged "${key}" with [${merged.join(', ')}]${
            added.length < incoming.length ? ` (${incoming.length - added.length} already present)` : ''
          }.`,
          { ok: true, dry_run: false, artist: key, added_tags: added, resulting_tags: merged },
        );
      }

      // action === 'remove' with specific tags. An artist left with zero
      // tags drops out of the store entirely (loader never yields empties).
      const keep = current.filter((t) => !incoming.includes(t));
      const dropped = current.filter((t) => incoming.includes(t));
      if (dry_run) {
        const summary =
          keep.length > 0
            ? `Drop [${dropped.join(', ')}] from "${existingKey ?? name}" → tags [${keep.join(', ')}]`
            : `Drop [${dropped.join(', ')}] from "${existingKey ?? name}" → artist now untagged (entry removed)`;
        const payload = {
          ok: true,
          dry_run: true,
          action,
          artist: existingKey ?? name,
          current_tags: current,
          resulting_tags: keep,
          changes: [summary],
        };
        return shapeResult(rf, `[dry run] ${summary}. Nothing was changed.`, payload);
      }
      if (!existingKey) {
        return shapeResult(
          rf,
          `No tags recorded for "${name}" — nothing to remove.`,
          { ok: true, dry_run: false, artist: name, removed_tags: [], remaining_tags: [] },
        );
      }
      if (keep.length > 0) store.tags[existingKey] = keep;
      else delete store.tags[existingKey];
      saveGenreTags(store);
      return shapeResult(
        rf,
        keep.length > 0
          ? `Removed [${dropped.join(', ')}] from "${existingKey}" → tags [${keep.join(', ')}].`
          : `Removed all tags from "${existingKey}" — artist is now untagged.`,
        {
          ok: true,
          dry_run: false,
          artist: existingKey,
          removed_tags: dropped,
          remaining_tags: keep,
        },
      );
    },
  );
}
