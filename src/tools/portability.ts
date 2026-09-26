/**
 * Portability (#188 + #192 + #238 + #240 + #223 + #220): save_discover_weekly / save_release_radar
 * (archive personalized playlists) + export_library_json / export_followed_artists
 * + export_profile_state/import_profile_state + export_listening_history
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  DryRun,
  describeDryRun,
  batchSummary,
  CHUNK_CAPS,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { issueReceipt, formatReceipt } from '../receipts.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
// #637: the batch-add gate constant is shared, never re-declared here.
import { BATCH_ADD_ELICIT_THRESHOLD } from './playlistbatch.js';
import { getConfig } from '../config.js';
// mkdir/writeFile stay for import_profile_state, which writes to the server's
// own store paths (scenesFilePath(), historyFilePath()) rather than to a
// caller-supplied destination. chmod is here for the history-file mode
// enforcement in export_profile_state.
import { chmod, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { exportRootDir, resolveOutputPath, writeOutputFile } from '../paths.js';
import { csvTable } from '../csvsafe.js';
import type {
  SpotifyPaged,
  PlaylistItemObject,
  SavedTrackItem,
  SavedAlbumItem,
  SavedShowItem,
  SavedEpisodeItem,
  SpotifyPlaylistSimple,
  FollowedArtistsResponse,
  RecentlyPlayedResponse,
  RecentlyPlayedItem,
} from '../types/spotify.js';
import { scenesFilePath, loadScenes } from './scenes.js';
import { genreTagsPath } from './libraryinsights.js';
import { playbackExtFile } from './playbackext.js';
import { searchHistoryFile } from './searchhistory.js';
import { HISTORY_DIR_MODE, HISTORY_FILE_MODE, historyFilePath, readHistory } from '../history.js';
import { artistWatchlistPath } from './artistwatch.js';

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

function portabilityDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_PORTABILITY_DIR ?? join(homedir(), '.spotify-mcp', 'portability');
}


// ---------------------------------------------------------------------------
// #238: resolve personalized playlist via /me/playlists exact match first
// ---------------------------------------------------------------------------

type ResolvedPlaylist = {
  id: string;
  name: string;
  owner?: { id: string; display_name?: string | null } | null;
  uri?: string;
  source: 'me-playlists' | 'search';
  verified: boolean;
};

async function resolvePlaylistByName(
  client: SpotifyClient,
  name: string,
): Promise<ResolvedPlaylist | null> {
  const playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' });
  const exactLocal = playlists.find((p) => p?.name?.toLowerCase() === name.toLowerCase());
  if (exactLocal) {
    return {
      id: exactLocal.id,
      name: exactLocal.name,
      owner: exactLocal.owner as ResolvedPlaylist['owner'],
      uri: exactLocal.uri,
      source: 'me-playlists',
      verified: true,
    };
  }
  try {
    const res = await client.get<{
      playlists?: { items: Array<{ id: string; name: string; owner?: { id: string; display_name?: string | null }; uri?: string } | null> };
    }>('/search', { q: name, type: 'playlist', limit: '10' });
    const items = res?.playlists?.items ?? [];
    const exact = items.find((p) => p?.name?.toLowerCase() === name.toLowerCase());
    if (exact) {
      return {
        id: exact.id,
        name: exact.name,
        owner: (exact.owner as ResolvedPlaylist['owner']) ?? null,
        uri: exact.uri,
        source: 'search',
        verified: false,
      };
    }
  } catch {
    // search failure -> treat as not found
  }
  return null;
}

async function findArchivePlaylist(client: SpotifyClient, archiveName: string): Promise<string | null> {
  const playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' });
  const found = playlists.find((p) => p?.name?.toLowerCase() === archiveName.toLowerCase());
  return found?.id ?? null;
}

async function savePersonalized(
  client: SpotifyClient,
  args: { sourceName: string; archiveName: string; dry_run?: boolean; response_format: ResponseFormatValue },
): Promise<ToolOut> {
  const rf = args.response_format;
  const resolved = await resolvePlaylistByName(client, args.sourceName);
  if (!resolved) {
    const payload = {
      ok: false as const,
      error: 'source_not_found' as const,
      source: args.sourceName,
      hint: `Could not find "${args.sourceName}" in your library (/me/playlists) or via search. If the playlist exists, pass its ID directly or ensure it is in your library.`,
    };
    const prose = `Could not find "${args.sourceName}" — not in your library and no exact search match. If you know the playlist ID, use it directly.`;
    return shapeResult(rf, prose, payload as unknown as Record<string, unknown>);
  }
  const sourceId = resolved.id;
  const sourceIdentity = {
    source: args.sourceName,
    source_id: sourceId,
    source_name: resolved.name,
    source_owner: resolved.owner ?? null,
    source_uri: resolved.uri ?? `spotify:playlist:${sourceId}`,
    source_url: `https://open.spotify.com/playlist/${sourceId}`,
    source_verified: resolved.verified,
    source_resolution: resolved.source as string,
    ...(resolved.verified ? {} : { warning: 'best-effort/unverified — resolved via public search, not your library; verify the owner before archiving' }),
  };

  const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(sourceId)}/items`, { limit: '100' });
  const uris = items.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string');
  if (uris.length === 0) {
    return shapeResult(rf, `"${args.sourceName}" is empty \u2014 nothing to archive.`, { ok: true, ...sourceIdentity, archived: 0, uris: [] });
  }

  if (args.dry_run) {
    const payload = { ok: true, dry_run: true, ...sourceIdentity, archive: args.archiveName, would_archive: uris.length, uris };
    const preview = describeDryRun(`save ${args.sourceName}`, args.archiveName, [`Would archive ${uris.length} track(s) from "${args.sourceName}" into "${args.archiveName}"`, ...uris.slice(0, 5)]) + (uris.length > 5 ? `\n  …and ${uris.length - 5} more` : '');
    const unverifiedNote = resolved.verified ? '' : `\n[unverified source — resolved via search as ${resolved.name} by ${resolved.owner?.id ?? 'unknown owner'}; verify before archiving]`;
    return shapeResult(rf, preview + unverifiedNote, payload);
  }

  let archiveId = await findArchivePlaylist(client, args.archiveName);
  if (!archiveId) {
    const created = await client.post<{ id: string; uri: string }>(
      '/me/playlists',
      { name: args.archiveName, public: false, description: `Archive of ${args.sourceName} — auto-created` },
    );
    if (!created?.id) throw new Error(`Could not create archive playlist "${args.archiveName}"`);
    archiveId = created.id;
  } else {
    const existing = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(archiveId)}/items`, { limit: '100' });
    const existingUris = existing.map((r) => r?.item?.uri).filter((u): u is string => typeof u === 'string');
    const same = existingUris.length === uris.length && existingUris.every((u, i) => u === uris[i]);
    if (same) {
      return shapeResult(rf, `Archive "${args.archiveName}" already up to date (${uris.length} items) — nothing to do.`, { ok: true, ...sourceIdentity, archive_id: archiveId, archived: 0, idempotent: true, uris });
    }
  }

  let snapshotId: string | undefined;
  for (let start = 0; start < uris.length; start += 100) {
    const chunk = uris.slice(start, start + 100);
    const res =
      start === 0
        ? await client.put<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(archiveId)}/items`, { uris: chunk })
        : await client.post<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(archiveId)}/items`, { uris: chunk });
    if (res?.snapshot_id) snapshotId = res.snapshot_id;
  }

  const receipt = await issueReceipt(client, { kind: 'playlist_items', id: archiveId, uris });
  const unverifiedLine = resolved.verified ? '' : `\n[unverified source — resolved via search; owner: ${resolved.owner?.id ?? 'unknown'}]`;
  const prose = `Archived ${uris.length} track(s) from "${args.sourceName}" → "${args.archiveName}" (ID: ${archiveId})\nSource: ${resolved.name} (${sourceIdentity.source_url}) owner ${resolved.owner?.id ?? 'unknown'} [${resolved.source}]${unverifiedLine}\n${batchSummary(uris.length, uris)}\n${formatReceipt(receipt)}` + (snapshotId ? `\nSnapshot ID: ${snapshotId}` : '');
  return shapeResult(rf, prose, { ok: true, ...sourceIdentity, archive_id: archiveId, archived: uris.length, uris, snapshot_id: snapshotId, receipt: receipt as unknown as Record<string, unknown> });
}

// ---------------------------------------------------------------------------
// #223 helpers: profile state stores
// ---------------------------------------------------------------------------

const PROFILE_STATE_SCHEMA_VERSION = 1;

async function tryReadJson(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// #220 helpers: listening history
// ---------------------------------------------------------------------------

function listeningHistoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_PORTABILITY_DIR ?? join(homedir(), '.spotify-mcp', 'portability');
}

// ---------------------------------------------------------------------------
// #637 + #736: additive restore of a library.json sidecar
// ---------------------------------------------------------------------------

/**
 * The five collections export_library_json writes into library.json (#736).
 * The importer restores every one of them; a key the file does not carry is
 * reported in `absent_keys` instead of being silently treated as "nothing to
 * do", so a partial sidecar can never read as a complete restore.
 */
const SIDECAR_COLLECTIONS = [
  { key: 'tracks', kind: 'track' },
  { key: 'albums', kind: 'album' },
  { key: 'shows', kind: 'show' },
  { key: 'episodes', kind: 'episode' },
  { key: 'audiobooks', kind: 'audiobook' },
] as const;

type SidecarKey = (typeof SIDECAR_COLLECTIONS)[number]['key'];

/**
 * A sidecar row is only usable when its `uri` is the canonical library URI
 * for that collection. Spotify ids are 22 base62 characters; a row with
 * anything else is a malformed sidecar, not a library item, and is counted as
 * invalid rather than being turned into an id by string splitting (#637).
 */
function sidecarUriRegex(kind: string): RegExp {
  return new RegExp(`^spotify:${kind}:[A-Za-z0-9]{22}$`);
}

/** Same query shape as library.ts's `libraryUrisParam` (kept in sync there). */
function libraryUrisParam(uris: readonly string[]): Record<string, string> {
  return { uris: uris.join(',') };
}

interface SidecarPlan {
  /** Collections the file actually carries, in export order. */
  readonly present: readonly SidecarKey[];
  /** Collections the file does not carry. */
  readonly absent: readonly SidecarKey[];
  /** Valid, de-duplicated URIs to restore, each owned by one collection. */
  readonly candidates: readonly string[];
  /** Which collection each candidate came from (first occurrence wins). */
  readonly owner: ReadonlyMap<string, SidecarKey>;
  /** Per-collection { in_file, invalid, candidates }, for every one of the five keys. */
  readonly collections: Record<SidecarKey, { in_file: number; invalid: number; candidates: number }>;
  readonly invalid: number;
  readonly invalidSamples: readonly string[];
  readonly inFile: number;
  /**
   * #1008: what the file itself says about its own completeness.
   *
   * `truncated` is the exporter's `truncated` flag verbatim, and it is
   * `null` — not `false` — when the file carries no such flag. A sidecar
   * that never says whether it was capped leaves completeness unknown, and
   * reporting that as "not truncated" would invent a guarantee the file
   * never made. `capReached` keeps only the five collection keys, and
   * `truncatedKeys` is the subset the exporter named as capped (all
   * present keys when the file flags truncation without naming them).
   */
  readonly truncated: boolean | null;
  readonly capReached: Readonly<Partial<Record<SidecarKey, boolean>>>;
  readonly truncatedKeys: readonly SidecarKey[];
  /** The per-type cap the exporter recorded, or null when it recorded none. */
  readonly cap: number | null;
}

/**
 * Read the completeness metadata `export_library_json` writes beside the
 * five collections (#1008). Every field is a value the file actually
 * carries; nothing is inferred from row counts, because a walk that stopped
 * at the cap and a library that was genuinely that size are indistinguishable
 * from the rows alone — only the exporter's own flag distinguishes them.
 */
function readSidecarTruncation(doc: Record<string, unknown>): Pick<SidecarPlan, 'truncated' | 'capReached' | 'truncatedKeys' | 'cap'> {
  const rawCapReached = doc.cap_reached;
  const capReached: Partial<Record<SidecarKey, boolean>> = {};
  if (rawCapReached !== null && typeof rawCapReached === 'object' && !Array.isArray(rawCapReached)) {
    for (const { key } of SIDECAR_COLLECTIONS) {
      const flag = (rawCapReached as Record<string, unknown>)[key];
      if (typeof flag === 'boolean') capReached[key] = flag;
    }
  }
  const cap = typeof doc.cap === 'number' && Number.isFinite(doc.cap) ? doc.cap : null;
  // A boolean is read as written; anything else (absent, null, a string) is
  // unread, and unread stays null rather than collapsing to false.
  const truncated = typeof doc.truncated === 'boolean' ? doc.truncated : null;
  const namedCapped = (Object.keys(capReached) as SidecarKey[]).filter((k) => capReached[k]);
  const truncatedKeys = namedCapped.length > 0
    ? namedCapped
    : truncated === true
      ? [...SIDECAR_COLLECTIONS].map(({ key }) => key)
      : [];
  return { truncated, capReached, truncatedKeys, cap };
}

function planSidecarRestore(doc: Record<string, unknown>): SidecarPlan {
  const present: SidecarKey[] = [];
  const absent: SidecarKey[] = [];
  const invalidByKey = {} as Record<SidecarKey, number>;
  const validByKey = {} as Record<SidecarKey, string[]>;
  const candidates: string[] = [];
  const owner = new Map<string, SidecarKey>();
  const invalidSamples: string[] = [];
  let invalid = 0;
  let inFile = 0;

  for (const { key, kind } of SIDECAR_COLLECTIONS) {
    const rows = doc[key];
    if (!Array.isArray(rows)) {
      absent.push(key);
      invalidByKey[key] = 0;
      validByKey[key] = [];
      continue;
    }
    present.push(key);
    inFile += rows.length;
    const regex = sidecarUriRegex(kind);
    const valid: string[] = [];
    let bad = 0;
    for (const row of rows) {
      const uri = (row as { uri?: unknown } | null | undefined)?.uri;
      if (typeof uri === 'string' && regex.test(uri)) {
        valid.push(uri);
      } else {
        bad++;
        if (invalidSamples.length < 5) invalidSamples.push(`${key}: ${JSON.stringify(uri ?? null)}`);
      }
    }
    invalidByKey[key] = bad;
    invalid += bad;
    validByKey[key] = valid;
    for (const uri of valid) {
      if (owner.has(uri)) continue; // a URI shared by two keys is restored once, under the first key
      owner.set(uri, key);
      candidates.push(uri);
    }
  }

  const collections = {} as Record<SidecarKey, { in_file: number; invalid: number; candidates: number }>;
  for (const { key } of SIDECAR_COLLECTIONS) {
    collections[key] = {
      in_file: Array.isArray(doc[key]) ? (doc[key] as unknown[]).length : 0,
      invalid: invalidByKey[key],
      candidates: validByKey[key].length,
    };
  }

  const truncation = readSidecarTruncation(doc);
  return { present, absent, candidates, owner, collections, invalid, invalidSamples, inFile, ...truncation };
}

/**
 * Which of `uris` the library does not already hold. The unified
 * `/me/library/contains` endpoint is the ungated, type-agnostic drop-in for the
 * per-type contains calls; a malformed or short reply fails closed rather than
 * reporting every item as missing.
 */
async function findMissingLibraryUris(client: SpotifyClient, uris: readonly string[]): Promise<string[]> {
  const present = new Set<string>();
  for (let i = 0; i < uris.length; i += CHUNK_CAPS.library_writes) {
    const chunk = uris.slice(i, i + CHUNK_CAPS.library_writes);
    const flags = await client.get<boolean[]>('/me/library/contains', libraryUrisParam(chunk));
    if (!Array.isArray(flags) || flags.length !== chunk.length) {
      throw new Error('Could not check library state (/me/library/contains)');
    }
    chunk.forEach((uri, idx) => {
      if (flags[idx]) present.add(uri);
    });
  }
  return uris.filter((uri) => !present.has(uri));
}

/** Per-key counts over all five collections, counting only owned candidates. */
function countByCollection(plan: SidecarPlan, subset: (uri: string) => boolean): Record<SidecarKey, number> {
  const counts: Record<SidecarKey, number> = { tracks: 0, albums: 0, shows: 0, episodes: 0, audiobooks: 0 };
  for (const uri of plan.candidates) {
    if (subset(uri)) counts[plan.owner.get(uri) as SidecarKey]++;
  }
  return counts;
}
/**
 * #1008: prose for what the sidecar itself says about its completeness.
 *
 * Three states, none of them collapsed into a fourth:
 *  - `truncated: true` — the exporter says it stopped at the cap, so this
 *    restore covers a subset of the library and the missing rows are named.
 *  - `truncated: false` — the exporter says the walk finished.
 *  - `truncated: null` — the file carries no flag, so whether the export
 *    was capped is UNKNOWN. It is reported as unknown, never as complete.
 */
function truncationDisclosure(plan: SidecarPlan, inputPath: string): string {
  if (plan.truncated === true) {
    const keys = plan.truncatedKeys.length > 0 ? plan.truncatedKeys.join(', ') : 'unknown';
    const cap = plan.cap !== null ? ` at the per-type cap of ${plan.cap}` : '';
    return `This sidecar is TRUNCATED: ${inputPath} was written${cap} and only covers part of the library — capped collections: ${keys}. Restoring it adds what the file holds, never the rows left out of it; re-export with a raised SPOTIFY_MCP_FETCH_ALL_CAP for the rest.`;
  }
  if (plan.truncated === null) {
    return `${inputPath} carries no truncation flag, so whether the export was capped is UNKNOWN — the restore below covers exactly the ${plan.inFile} row(s) in the file and completeness of the source export cannot be confirmed from it.`;
  }
  return `This sidecar reports a complete export (truncated: false), so the restore below covers the full ${plan.inFile} row(s) it carries.`;
}

/** The disclosure fields every import_from_sidecar payload carries. */
function truncationPayload(plan: SidecarPlan) {
  return {
    sidecar_truncated: plan.truncated,
    cap_reached: plan.capReached,
    truncated_collections: plan.truncatedKeys,
    cap: plan.cap,
  };
}

export function registerPortabilityTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'save_discover_weekly',
    'Archive your Discover Weekly into a regular playlist (creates or overwrites the archive). Resolves Discover Weekly via /me/playlists exact match first, falling back to search (unverified); dry_run previews; idempotent if archive already matches. Result echoes source identity (owner, url, verified).',
    {
      archive_name: z.string().optional().default('Discover Weekly Archive').describe('Archive playlist name (created if missing, overwritten if present)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => savePersonalized(client, { sourceName: 'Discover Weekly', archiveName: args.archive_name, dry_run: args.dry_run, response_format: args.response_format }),
  );

  server.tool(
    'save_release_radar',
    'Archive your Release Radar into a regular playlist (creates or overwrites the archive). Resolves Release Radar via /me/playlists exact match first, falling back to search (unverified); dry_run previews; idempotent if archive already matches. Result echoes source identity (owner, url, verified).',
    {
      archive_name: z.string().optional().default('Release Radar Archive').describe('Archive playlist name (created if missing, overwritten if present)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => savePersonalized(client, { sourceName: 'Release Radar', archiveName: args.archive_name, dry_run: args.dry_run, response_format: args.response_format }),
  );

  server.tool(
    'export_library_json',
    'Export your full library (saved tracks, albums, shows, episodes, audiobooks) to a local directory as JSON or CSV sidecar files. Respects SPOTIFY_MCP_FETCH_ALL_CAP per type; when capped, reports cap_reached + truncated and a prose footer ("first N of … — raise SPOTIFY_MCP_FETCH_ALL_CAP").',
    {
      output_dir: z.string().optional().describe('Local directory to write into, confined to the output root (default ~/.spotify-mcp/portability, set SPOTIFY_MCP_PORTABILITY_DIR to move it)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json (single file) or csv (one file per type)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      // #622: the caller's output_dir is symlink-resolved and must stay inside
      // the configured root; a relative value is taken as root-relative.
      const { dir } = await resolveOutputPath({
        root: portabilityDir(),
        target: args.output_dir ?? '.',
        tool: 'export_library_json',
        kind: 'directory',
      });
      const cap = getConfig().fetchAllCap;

      const [tracks, albums, shows, episodes] = await Promise.all([
        client.getAllPages<SavedTrackItem>('/me/tracks', { limit: '50' }, { maxItems: cap }),
        client.getAllPages<SavedAlbumItem>('/me/albums', { limit: '50' }, { maxItems: cap }),
        client.getAllPages<SavedShowItem>('/me/shows', { limit: '50' }, { maxItems: cap }),
        client.getAllPages<SavedEpisodeItem>('/me/episodes', { limit: '50' }, { maxItems: cap }),
      ]);
      let audiobooks: Array<{ added_at: string; audiobook: { uri: string; name: string } }> = [];
      try {
        audiobooks = await client.getAllPages<{ added_at: string; audiobook: { uri: string; name: string } }>('/me/audiobooks', { limit: '50' }, { maxItems: cap });
      } catch {
        audiobooks = [];
      }

      const capReached = {
        tracks: tracks.length >= cap,
        albums: albums.length >= cap,
        shows: shows.length >= cap,
        episodes: episodes.length >= cap,
        audiobooks: audiobooks.length >= cap,
      };
      const truncated = Object.values(capReached).some(Boolean);

      if (args.format === 'csv') {
        const writeCsv = async (name: string, rows: string[][], headers: string[]) => {
          const p = join(dir, `${name}.csv`);
          await writeOutputFile(p, csvTable(headers, rows));
          return { path: p, rows: rows.length };
        };
        const results = await Promise.all([
          writeCsv('tracks', tracks.map((r) => [r.track.uri, r.track.name, r.track.artists.map((a) => a.name).join(';'), r.added_at]), ['uri', 'name', 'artists', 'added_at']),
          writeCsv('albums', albums.map((r) => [r.album.uri, r.album.name, r.added_at]), ['uri', 'name', 'added_at']),
          writeCsv('shows', shows.map((r) => [r.show.uri, r.show.name, r.added_at]), ['uri', 'name', 'added_at']),
          writeCsv('episodes', episodes.map((r) => [r.episode.uri, r.episode.name, r.added_at]), ['uri', 'name', 'added_at']),
          writeCsv('audiobooks', audiobooks.map((r) => [r.audiobook.uri, r.audiobook.name, r.added_at]), ['uri', 'name', 'added_at']),
        ]);
        const total = tracks.length + albums.length + shows.length + episodes.length + audiobooks.length;
        const cappedTypes = Object.entries(capReached).filter(([, v]) => v).map(([k]) => k).join(', ');
        const footer = truncated ? ` [truncated — first ${cap} per type; capped types: ${cappedTypes} — raise SPOTIFY_MCP_FETCH_ALL_CAP for the full library]` : '';
        const payload = { ok: true, dir, format: 'csv', total, counts: { tracks: tracks.length, albums: albums.length, shows: shows.length, episodes: episodes.length, audiobooks: audiobooks.length }, cap_reached: capReached, truncated, cap, files: results.map((r) => r.path) };
        return shapeResult(rf, `Exported library to ${dir} as CSV (${total} items across ${results.length} files).${footer}`, payload);
      }

      const doc = {
        exported_at: new Date().toISOString(),
        counts: { tracks: tracks.length, albums: albums.length, shows: shows.length, episodes: episodes.length, audiobooks: audiobooks.length },
        cap_reached: capReached,
        truncated,
        cap,
        tracks: tracks.map((r) => ({ uri: r.track.uri, name: r.track.name, artists: r.track.artists.map((a) => a.name), added_at: r.added_at })),
        albums: albums.map((r) => ({ uri: r.album.uri, name: r.album.name, added_at: r.added_at })),
        shows: shows.map((r) => ({ uri: r.show.uri, name: r.show.name, added_at: r.added_at })),
        episodes: episodes.map((r) => ({ uri: r.episode.uri, name: r.episode.name, added_at: r.added_at })),
        audiobooks: audiobooks.map((r) => ({ uri: r.audiobook.uri, name: r.audiobook.name, added_at: r.added_at })),
      };
      const filePath = join(dir, 'library.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(filePath, body);
      const bytes = Buffer.byteLength(body);
      const cappedTypes = Object.entries(capReached).filter(([, v]) => v).map(([k]) => k).join(', ');
      const footer = truncated ? ` [truncated — first ${cap} per type; capped types: ${cappedTypes} — raise SPOTIFY_MCP_FETCH_ALL_CAP for the full library]` : '';
      const payload = { ok: true, dir, file: filePath, format: 'json', bytes, counts: doc.counts, cap_reached: capReached, truncated, cap, total: tracks.length + albums.length + shows.length + episodes.length + audiobooks.length };
      return shapeResult(rf, `Exported library to ${filePath} (${payload.total} items, ${bytes} bytes).${footer}`, payload);
    },
  );

  server.tool(
    'export_followed_artists',
    'Export your followed artists to a local directory as JSON or CSV. Fields: uri, name, genres. The file\'s exported_at is the export time, not a per-artist follow date (Spotify does not expose followed_at).',
    {
      output_dir: z.string().optional().describe('Local directory to write into, confined to the output root (default ~/.spotify-mcp/portability, set SPOTIFY_MCP_PORTABILITY_DIR to move it)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json or csv'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { dir } = await resolveOutputPath({
        root: portabilityDir(),
        target: args.output_dir ?? '.',
        tool: 'export_followed_artists',
        kind: 'directory',
      });
      const cap = getConfig().fetchAllCap;

      const artists: Array<{ uri: string; name: string; genres: string[] }> = [];
      let after: string | undefined;
      while (artists.length < cap) {
        const params: Record<string, string> = { type: 'artist', limit: '50' };
        if (after) params.after = after;
        const page = await client.get<FollowedArtistsResponse>('/me/following', params);
        const items = page?.artists?.items ?? [];
        if (items.length === 0) break;
        for (const a of items) artists.push({ uri: a.uri, name: a.name, genres: a.genres ?? [] });
        after = page?.artists?.cursors?.after ?? undefined;
        if (!page?.artists?.next || !after) break;
      }
      if (artists.length > cap) artists.length = cap;

      const exportedAt = new Date().toISOString();
      const capReached = artists.length >= cap;
      const truncated = capReached;

      if (args.format === 'csv') {
        const headers = ['uri', 'name', 'genres'];
        const rows = artists.map((a) => [a.uri, a.name, a.genres.join(';')]);
        const lines = csvTable(headers, rows);
        const filePath = join(dir, 'followed_artists.csv');
        await writeOutputFile(filePath, lines);
        const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP for the full list]` : '';
        const payload = { ok: true, dir, file: filePath, format: 'csv', total: artists.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt };
        return shapeResult(rf, `Exported ${artists.length} followed artist(s) to ${filePath} as CSV.${footer}`, payload);
      }

      const doc = { exported_at: exportedAt, total: artists.length, cap_reached: capReached, truncated, cap, artists: artists.map((a) => ({ uri: a.uri, name: a.name, genres: a.genres })) };
      const filePath = join(dir, 'followed_artists.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(filePath, body);
      const bytes = Buffer.byteLength(body);
      const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP for the full list]` : '';
      return shapeResult(rf, `Exported ${artists.length} followed artist(s) to ${filePath} (${bytes} bytes).${footer}`, { ok: true, dir, file: filePath, format: 'json', bytes, total: artists.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt });
    },
  );

  // -------------------------------------------------------------------------
  // #223: export_profile_state / import_profile_state
  // -------------------------------------------------------------------------

  server.tool(
    'export_profile_state',
    'Export local sidecar stores (scenes, genre-tags, playback-ext, search-history, mutations, artist-watchlist) to a single schema-versioned JSON archive. artist-watchlist is ~/.spotify-mcp/artist-watchlist.json; SPOTIFY_MCP_DATA_DIR overrides that directory.',
    {
      output_dir: z.string().optional().describe('Directory to write the archive into, confined to the output root (default ~/.spotify-mcp/exports, set SPOTIFY_MCP_EXPORT_DIR to move it)'),
      include_history: z.boolean().optional().default(false).describe('Include mutation history JSONL (can be large)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { dir } = await resolveOutputPath({
        root: exportRootDir(),
        target: args.output_dir ?? '.',
        tool: 'export_profile_state',
        kind: 'directory',
      });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = join(dir, `profile-state-${ts}.json`);

      const stores: Record<string, unknown> = {};
      const counts: Record<string, number> = {};

      // scenes
      const scenes = await tryReadJson(scenesFilePath());
      if (scenes && typeof scenes === 'object') {
        stores.scenes = scenes;
        counts.scenes = Object.keys(scenes as Record<string, unknown>).length;
      } else {
        stores.scenes = null;
        counts.scenes = 0;
      }

      // genre-tags
      const genreTags = await tryReadJson(genreTagsPath());
      if (genreTags && typeof genreTags === 'object' && (genreTags as Record<string, unknown>).tags) {
        stores.genre_tags = genreTags;
        const tags = (genreTags as { tags: Record<string, unknown> }).tags;
        counts.genre_tags = Object.keys(tags).length;
      } else if (genreTags) {
        stores.genre_tags = genreTags;
        counts.genre_tags = 0;
      } else {
        stores.genre_tags = null;
        counts.genre_tags = 0;
      }

      // playback-ext
      const playbackExt = await tryReadJson(playbackExtFile());
      if (playbackExt && typeof playbackExt === 'object') {
        stores.playback_ext = playbackExt;
        const pe = playbackExt as Record<string, unknown>;
        counts.playback_ext_states = pe.states ? Object.keys(pe.states as Record<string, unknown>).length : 0;
        counts.playback_ext_sessions = pe.sessions ? Object.keys(pe.sessions as Record<string, unknown>).length : 0;
      } else {
        stores.playback_ext = null;
        counts.playback_ext_states = 0;
        counts.playback_ext_sessions = 0;
      }

      // search-history
      const searchHistory = await tryReadJson(searchHistoryFile());
      if (Array.isArray(searchHistory)) {
        stores.search_history = searchHistory;
        counts.search_history = searchHistory.length;
      } else if (searchHistory && typeof searchHistory === 'object' && Array.isArray((searchHistory as Record<string, unknown>).entries)) {
        const entries = (searchHistory as { entries: unknown[] }).entries;
        stores.search_history = entries;
        counts.search_history = entries.length;
      } else {
        stores.search_history = searchHistory ?? null;
        counts.search_history = 0;
      }

      // artist-watchlist (same path the artist-watch tools write, #764)
      const watchlist = await tryReadJson(artistWatchlistPath());
      if (watchlist && typeof watchlist === 'object') {
        stores.artist_watchlist = watchlist;
        const wl = watchlist as { watchlists?: Record<string, unknown> };
        counts.artist_watchlist = wl.watchlists ? Object.keys(wl.watchlists).length : 0;
      } else {
        stores.artist_watchlist = null;
        counts.artist_watchlist = 0;
      }

      // mutations history (optional) — bounded tail read (#628)
      if (args.include_history) {
        const records = await readHistory();
        stores.mutations_history = records.length > 0 ? records : null;
        counts.mutations_history = records.length;
      }

      const doc = {
        schema_version: PROFILE_STATE_SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        include_history: !!args.include_history,
        watchlist_path: artistWatchlistPath(),
        counts,
        stores,
      };

      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(filePath, body);
      const bytes = Buffer.byteLength(body);
      const payload = { ok: true, path: filePath, bytes, counts, schema_version: PROFILE_STATE_SCHEMA_VERSION };
      return shapeResult(rf, `Exported profile state to ${filePath} (${bytes} bytes) — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')}.`, payload);
    },
  );

  server.tool(
    'import_profile_state',
    'Restore local sidecar stores from a profile-state archive. Merge adds to existing stores; overwrite replaces them. Refuses archives newer than this server\'s schema version.',
    {
      input_path: z.string().describe('Path to the profile-state archive JSON file'),
      mode: z.enum(['merge', 'overwrite']).optional().default('merge').describe('merge = add to existing stores; overwrite = replace them'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      let doc: Record<string, unknown>;
      try {
        const raw = await readFile(args.input_path, 'utf8');
        doc = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`Could not read archive "${args.input_path}": ${e instanceof Error ? e.message : String(e)}`);
      }
      const schemaVersion = doc.schema_version as number | undefined;
      if (typeof schemaVersion === 'number' && schemaVersion > PROFILE_STATE_SCHEMA_VERSION) {
        throw new Error(`Archive schema version ${schemaVersion} is newer than this server's ${PROFILE_STATE_SCHEMA_VERSION} — please update the server before importing.`);
      }
      const stores = doc.stores as Record<string, unknown> | undefined;
      if (!stores || typeof stores !== 'object') {
        throw new Error('Archive missing stores object');
      }

      const allowedKeys = new Set(['scenes', 'genre_tags', 'playback_ext', 'search_history', 'artist_watchlist', 'mutations_history']);
      const results: Record<string, string> = {};

      const writeStore = async (filePath: string, data: unknown) => {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      };

      const mergeOrOverwrite = async (
        label: string,
        filePath: string,
        incoming: unknown,
        isRecord: boolean,
      ): Promise<void> => {
        if (incoming == null) return;
        if (args.mode === 'overwrite') {
          await writeStore(filePath, incoming);
          results[label] = 'overwritten';
          return;
        }
        // merge
        const existing = await tryReadJson(filePath);
        if (isRecord && existing && typeof existing === 'object' && incoming && typeof incoming === 'object') {
          // For record stores, merge keys (incoming wins on conflict)
          const merged = { ...(existing as Record<string, unknown>), ...(incoming as Record<string, unknown>) };
          // Special handling for nested record shapes
          // genre_tags: { version, tags: {...} } -> merge tags
          if (label === 'genre_tags') {
            const eTags = (existing as { tags?: Record<string, unknown> }).tags ?? {};
            const iTags = (incoming as { tags?: Record<string, unknown> }).tags ?? {};
            (merged as Record<string, unknown>).tags = { ...(eTags as Record<string, unknown>), ...(iTags as Record<string, unknown>) };
          }
          // playback_ext: { states, devicePresets, sessions, ... } -> merge each sub-record
          if (label === 'playback_ext') {
            for (const sub of ['states', 'devicePresets', 'sessions', 'smartRules']) {
              const eSub = (existing as Record<string, unknown>)[sub];
              const iSub = (incoming as Record<string, unknown>)[sub];
              if (eSub && typeof eSub === 'object' && iSub && typeof iSub === 'object') {
                (merged as Record<string, unknown>)[sub] = { ...(eSub as Record<string, unknown>), ...(iSub as Record<string, unknown>) };
              }
            }
          }
          // artist_watchlist: { watchlists: {...} } -> merge watchlists
          if (label === 'artist_watchlist') {
            const eWl = (existing as { watchlists?: Record<string, unknown> }).watchlists ?? {};
            const iWl = (incoming as { watchlists?: Record<string, unknown> }).watchlists ?? {};
            (merged as Record<string, unknown>).watchlists = { ...(eWl as Record<string, unknown>), ...(iWl as Record<string, unknown>) };
          }
          await writeStore(filePath, merged);
          results[label] = 'merged';
        } else if (Array.isArray(existing) && Array.isArray(incoming)) {
          // search_history: array — concat
          const merged = [...existing, ...incoming];
          await writeStore(filePath, merged);
          results[label] = 'merged';
        } else if (existing == null) {
          await writeStore(filePath, incoming);
          results[label] = 'created';
        } else {
          // Fallback: overwrite if shapes don't match merge expectations
          await writeStore(filePath, incoming);
          results[label] = 'overwritten';
        }
      };

      for (const [key, value] of Object.entries(stores)) {
        if (!allowedKeys.has(key)) continue; // ignore unknown keys
        if (value == null) continue;
        switch (key) {
          case 'scenes':
            await mergeOrOverwrite('scenes', scenesFilePath(), value, true);
            break;
          case 'genre_tags':
            await mergeOrOverwrite('genre_tags', genreTagsPath(), value, true);
            break;
          case 'playback_ext':
            await mergeOrOverwrite('playback_ext', playbackExtFile(), value, true);
            break;
          case 'search_history':
            await mergeOrOverwrite('search_history', searchHistoryFile(), value, false);
            break;
          case 'artist_watchlist':
            await mergeOrOverwrite('artist_watchlist', artistWatchlistPath(), value, true);
            break;
          case 'mutations_history': {
            if (Array.isArray(value)) {
              const histPath = historyFilePath();
              await mkdir(dirname(histPath), { recursive: true, mode: HISTORY_DIR_MODE });
              // Mode arguments only apply at creation, so re-assert after the
              // write: a pre-existing or copied-in ledger must not stay
              // group/world-readable (#628).
              await chmod(dirname(histPath), HISTORY_DIR_MODE);
              if (args.mode === 'overwrite') {
                const lines = (value as unknown[]).map((r) => JSON.stringify(r)).join('\n') + '\n';
                await writeFile(histPath, lines, { encoding: 'utf8', mode: HISTORY_FILE_MODE });
                results.mutations_history = 'overwritten';
              } else {
                const lines = (value as unknown[]).map((r) => JSON.stringify(r)).join('\n') + '\n';
                const { appendFile } = await import('node:fs/promises');
                try {
                  await appendFile(histPath, lines, { encoding: 'utf8', mode: HISTORY_FILE_MODE } as unknown as Record<string, unknown>);
                } catch {
                  await writeFile(histPath, lines, { encoding: 'utf8', mode: HISTORY_FILE_MODE });
                }
                results.mutations_history = 'merged';
              }
              await chmod(histPath, HISTORY_FILE_MODE);
            }
            break;
          }
        }
      }

      const payload = { ok: true, mode: args.mode, input_path: args.input_path, results };
      return shapeResult(rf, `Imported profile state from ${args.input_path} (mode: ${args.mode}) — ${Object.entries(results).map(([k, v]) => `${k}:${v}`).join(', ') || 'nothing to import'}.`, payload);
    },
  );

  // -------------------------------------------------------------------------
  // #220: export_listening_history
  // -------------------------------------------------------------------------

  server.tool(
    'export_listening_history',
    'Export your listening history (recently played) to a JSON or CSV sidecar by walking /me/player/recently-played with before-cursor pagination. Respects SPOTIFY_MCP_FETCH_ALL_CAP; writes file 0600 and reports path + counts. Analogous to export_library_json.',
    {
      output_dir: z.string().optional().describe('Local directory to write into, confined to the output root (default ~/.spotify-mcp/portability, set SPOTIFY_MCP_PORTABILITY_DIR to move it)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format: json or csv'),
      limit: z.number().int().min(1).max(10000).optional().describe('Alias for max_items'),
      max_items: z.number().int().min(1).max(10000).optional().describe('Max history items to export (default: SPOTIFY_MCP_FETCH_ALL_CAP)'),
      before: z.string().optional().describe('Cursor: only return items played before this timestamp (milliseconds since epoch or ISO string)'),
      after: z.string().optional().describe('Cursor: only return items played after this timestamp (milliseconds since epoch or ISO string)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { dir } = await resolveOutputPath({
        root: listeningHistoryDir(),
        target: args.output_dir ?? '.',
        tool: 'export_listening_history',
        kind: 'directory',
      });
      const cap = args.max_items ?? args.limit ?? getConfig().fetchAllCap;

      const items: RecentlyPlayedItem[] = [];
      let before: string | undefined = args.before;
      // after cursor is not natively supported for pagination but we filter
      const afterMs = args.after ? new Date(args.after).getTime() : undefined;
      const beforeMsInitial = args.before ? new Date(args.before).getTime() : undefined;

      while (items.length < cap) {
        const params: Record<string, string> = { limit: '50' };
        if (before) params.before = before;
        // Spotify's recently-played cursor is milliseconds since epoch
        // If before was an ISO string, convert to ms string
        if (before && Number.isNaN(Number(before))) {
          const ms = new Date(before).getTime();
          if (Number.isFinite(ms)) params.before = String(ms);
        }
        const page = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', params);
        const pageItems = page?.items ?? [];
        if (pageItems.length === 0) break;

        for (const item of pageItems) {
          if (afterMs !== undefined) {
            const playedMs = new Date(item.played_at).getTime();
            if (Number.isFinite(playedMs) && playedMs <= afterMs) continue;
          }
          items.push(item);
          if (items.length >= cap) break;
        }
        if (items.length >= cap) break;
        // Advance cursor: use the oldest item's played_at as next before
        const oldest = pageItems.at(-1);
        const nextBefore = page?.cursors?.before ?? (oldest ? String(new Date(oldest.played_at).getTime()) : undefined);
        if (!nextBefore || nextBefore === before) break;
        // Stop if we've gone past the after cursor (time-based)
        if (afterMs !== undefined && oldest) {
          const oldestMs = new Date(oldest.played_at).getTime();
          if (Number.isFinite(oldestMs) && oldestMs <= afterMs) break;
        }
        if (pageItems.length < 50) break;
        before = nextBefore;
      }
      if (items.length > cap) items.length = cap;

      const exportedAt = new Date().toISOString();
      const capReached = items.length >= cap;
      const truncated = capReached;

      if (args.format === 'csv') {
        const headers = ['played_at', 'timestamp', 'track', 'artist', 'album', 'uri'];
        const rows = items.map((it) => [
          it.played_at,
          String(new Date(it.played_at).getTime()),
          it.track?.name ?? '',
          (it.track?.artists ?? []).map((a) => a.name).join(';'),
          it.track?.album?.name ?? '',
          it.track?.uri ?? '',
        ]);
        const lines = csvTable(headers, rows);
        const filePath = join(dir, 'listening_history.csv');
        await writeOutputFile(filePath, lines);
        const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP or max_items for more]` : '';
        const payload = { ok: true, dir, file: filePath, format: 'csv', total: items.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt };
        return shapeResult(rf, `Exported ${items.length} listening-history item(s) to ${filePath} as CSV.${footer}`, payload);
      }

      const doc = {
        exported_at: exportedAt,
        total: items.length,
        cap_reached: capReached,
        truncated,
        cap,
        items: items.map((it) => ({
          played_at: it.played_at,
          timestamp: new Date(it.played_at).getTime(),
          track: it.track?.name ?? '',
          artist: (it.track?.artists ?? []).map((a) => a.name).join(', '),
          album: it.track?.album?.name ?? '',
          uri: it.track?.uri ?? '',
          context: it.context ?? null,
        })),
      };
      const filePath = join(dir, 'listening_history.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(filePath, body);
      const bytes = Buffer.byteLength(body);
      const footer = truncated ? ` [truncated — first ${cap}; raise SPOTIFY_MCP_FETCH_ALL_CAP or max_items for more]` : '';
      return shapeResult(rf, `Exported ${items.length} listening-history item(s) to ${filePath} (${bytes} bytes).${footer}`, { ok: true, dir, file: filePath, format: 'json', bytes, total: items.length, cap_reached: capReached, truncated, cap, exported_at: exportedAt });
    },
  );

  // export_all_playlists — collection export (issue sweep #2)
  server.tool(
    'export_all_playlists',
    'Export every owned (or all) playlist with metadata + items to a sidecar file. Quota: GET /me/playlists + N×GET /playlists/{id}/items; capped by fetchAllCap.',
    {
      output_dir: z.string().optional().describe('Local directory to write into, confined to the output root (default ~/.spotify-mcp/portability, set SPOTIFY_MCP_PORTABILITY_DIR to move it)'),
      format: z.enum(['json', 'csv']).optional().default('json').describe('Output format'),
      include_items: z.boolean().optional().default(true).describe('Include track items per playlist'),
      scope: z.enum(['owned', 'all']).optional().default('all').describe('owned = only playlists you own'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const { dir } = await resolveOutputPath({
        root: portabilityDir(),
        target: args.output_dir ?? '.',
        tool: 'export_all_playlists',
        kind: 'directory',
      });
      const cap = getConfig().fetchAllCap;
      const me = await client.get<{ id?: string }>('/me');
      const myId = me?.id as string | undefined;
      let playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', { limit: '50' }, { maxItems: cap });
      if (args.scope === 'owned' && myId) playlists = playlists.filter((p) => p?.owner?.id === myId);
      const exportedAt = new Date().toISOString();
      let playlistRows: Array<{ id: string; name: string; uri: string; total: number; items: Array<{ uri: string; name: string }> }> = playlists.map((p) => ({ id: p.id, name: p.name, uri: p.uri, total: p.items?.total ?? 0, items: [] }));
      if (args.include_items !== false) {
        for (const row of playlistRows) {
          try {
            const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(row.id)}/items`, { limit: '100' }, { maxItems: cap });
            row.items = items.map((r) => ({ uri: (r?.item as { uri?: string })?.uri ?? '', name: (r?.item as { name?: string })?.name ?? '' })).filter((x) => x.uri);
          } catch { row.items = []; }
        }
      }
      if (args.format === 'csv') {
        const headers = ['playlist_id', 'playlist_name', 'item_uri', 'item_name'];
        const rows: string[][] = [];
        for (const pl of playlistRows) {
          if (pl.items.length === 0) rows.push([pl.id, pl.name, '', '']);
          else for (const it of pl.items) rows.push([pl.id, pl.name, it.uri, it.name]);
        }
        const lines = csvTable(headers, rows);
        const fp = join(dir, 'playlists.csv');
        await writeOutputFile(fp, lines);
        return shapeResult(rf, `Exported ${playlistRows.length} playlist(s) (${rows.length} rows) to ${fp}.`, { ok: true, dir, file: fp, format: 'csv', total: playlistRows.length, rows: rows.length });
      }
      const doc = { exported_at: exportedAt, total: playlistRows.length, scope: args.scope, playlists: playlistRows };
      const fp = join(dir, 'playlists.json');
      const body = `${JSON.stringify(doc, null, 2)}\n`;
      await writeOutputFile(fp, body);
      return shapeResult(rf, `Exported ${playlistRows.length} playlist(s) to ${fp} (${Buffer.byteLength(body)} bytes).`, { ok: true, dir, file: fp, format: 'json', bytes: Buffer.byteLength(body), total: playlistRows.length, scope: args.scope });
    },
  );

  // library_snapshot_diff — diff two sidecar files locally
  server.tool(
    'library_snapshot_diff',
    'Diff two portability/library sidecar JSON files (library.json or playlists.json): added/removed counts + samples. Quota: 🟢 local only (no API).',
    {
      before_path: z.string().describe('Path to before snapshot JSON'),
      after_path: z.string().describe('Path to after snapshot JSON'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
      const before = await readJson(args.before_path);
      const after = await readJson(args.after_path);
      const extractUris = (doc: Record<string, unknown>): Set<string> => {
        const s = new Set<string>();
        for (const k of ['tracks', 'albums', 'shows', 'episodes', 'audiobooks', 'artists', 'playlists']) {
          const arr = doc[k] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(arr)) for (const r of arr) { const u = (r.uri ?? r.id) as string | undefined; if (u) s.add(String(u)); }
        }
        // playlists nested items
        const pls = doc.playlists as Array<{ items?: Array<{ uri: string }> }> | undefined;
        if (Array.isArray(pls)) for (const pl of pls) for (const it of (pl.items ?? [])) if (it?.uri) s.add(it.uri);
        return s;
      };
      const bSet = extractUris(before as Record<string, unknown>);
      const aSet = extractUris(after as Record<string, unknown>);
      const added = [...aSet].filter((x) => !bSet.has(x));
      const removed = [...bSet].filter((x) => !aSet.has(x));
      const payload = { ok: true, before: args.before_path, after: args.after_path, added_count: added.length, removed_count: removed.length, added_sample: added.slice(0, 10), removed_sample: removed.slice(0, 10) };
      const prose = `Diff: +${added.length} added, -${removed.length} removed. Added sample: ${added.slice(0, 3).join(', ') || '—'}; Removed sample: ${removed.slice(0, 3).join(', ') || '—'}`;
      return shapeResult(rf, prose, payload);
    },
  );

  // history_search — search portability sidecar filenames + mutation history
  server.tool(
    'history_search',
    'Search local portability/backups for files matching a query (filename substring). Quota: 🟢 local only (no API).',
    {
      query: z.string().optional().describe('Substring to match (default: all)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dir = portabilityDir();
      let files: string[] = [];
      try { files = await readdir(dir); } catch { files = []; }
      const q = (args.query ?? '').toLowerCase();
      const matched = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
      const payload = { ok: true, dir, total: files.length, matched_count: matched.length, files: matched.slice(0, 50) };
      return shapeResult(rf, `Found ${matched.length}/${files.length} file(s) matching "${args.query ?? ''}" in ${dir}.`, payload);
    },
  );

  // import_from_sidecar — additive restore from sidecar (dry_run defaults true)
  server.tool(
    'import_from_sidecar',
    'Additive restore from a library.json sidecar written by export_library_json: re-adds every missing saved item across all five collections (tracks, albums, shows, episodes, audiobooks) through the unified PUT /me/library endpoint, skipping items the library already holds. Rows whose uri is not a canonical spotify:<kind>:<22-char id> URI are counted as invalid and never sent. Collections the file does not carry are named in absent_keys. The exporter\'s own truncated / cap_reached flags are surfaced as sidecar_truncated + truncated_collections: a capped sidecar restores only the rows it holds and says so, and a file with no flag reports completeness as UNKNOWN rather than complete. dry_run=true by default. Quota: 🟢 local read + 🟡 contains-check + writes when dry_run=false (chunked).',
    {
      input_path: z.string().optional().describe('Path to sidecar JSON (default: <portability>/library.json)'),
      dry_run: z.boolean().optional().default(true).describe('Preview only, making no API calls at all. Writes happen only when explicitly set to false.'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const inputPath = args.input_path ?? join(portabilityDir(), 'library.json');
      const raw = await readFile(inputPath, 'utf8');
      const doc = JSON.parse(raw) as Record<string, unknown>;
      // #736: every collection the exporter writes is planned, not just tracks.
      const plan = planSidecarRestore(doc);

      const absentLine = plan.absent.length > 0
        ? `${inputPath} has no ${plan.absent.join(' / ')} key — nothing to restore for ${plan.absent.join(' / ')}.`
        : '';
      const invalidLine = plan.invalid > 0
        ? `${plan.invalid} invalid row(s) skipped (not a canonical spotify:<kind>:<22-char id> URI): ${plan.invalidSamples.join('; ')}`
        : '';
      const truncationLine = truncationDisclosure(plan, inputPath);

      // Dry run: local read only — no contains-check, no write, same per-collection plan.
      if (args.dry_run !== false) {
        const would_import = {} as Record<SidecarKey, number>;
        for (const { key } of SIDECAR_COLLECTIONS) would_import[key] = plan.collections[key].candidates;
        const payload = {
          ok: true,
          dry_run: true,
          executed: false,
          input: inputPath,
          present_keys: plan.present,
          absent_keys: plan.absent,
          collections: plan.collections,
          would_import,
          total_in_file: plan.inFile,
          invalid: plan.invalid,
          invalid_samples: plan.invalidSamples,
          sample: plan.candidates.slice(0, 5),
          ...truncationPayload(plan),
        };
        const lines = [
          `Would restore ${plan.candidates.length} item(s) from ${plan.present.length} collection(s): ${plan.present.join(', ') || '—'}`,
          ...plan.candidates.slice(0, 5).map((u) => u),
        ];
        if (plan.candidates.length > 5) lines.push(`…and ${plan.candidates.length - 5} more`);
        if (absentLine) lines.push(absentLine);
        if (invalidLine) lines.push(invalidLine);
        lines.push(truncationLine);
        return shapeResult(rf, describeDryRun('import_from_sidecar', inputPath, lines), payload);
      }

      if (plan.candidates.length === 0) {
        const payload = {
          ok: true,
          dry_run: false,
          executed: true,
          input: inputPath,
          present_keys: plan.present,
          absent_keys: plan.absent,
          collections: plan.collections,
          imported: countByCollection(plan, () => false),
          added: 0,
          skipped_existing: 0,
          invalid: plan.invalid,
          invalid_samples: plan.invalidSamples,
          total_in_file: plan.inFile,
          ...truncationPayload(plan),
        };
        return shapeResult(
          rf,
          `Import from ${inputPath}: added 0 item(s) — the sidecar carried no valid library URI to restore.${truncationLine} ${absentLine ? `${absentLine} ` : ''}${invalidLine ? ` ${invalidLine}` : ''}`,
          payload,
        );
      }

      // #637: one contains-check over the whole candidate set, then one gated,
      // chunked write through the unified endpoint. No deprecated per-type PUT.
      const missing = await findMissingLibraryUris(client, plan.candidates);
      const addedSet = new Set(missing);
      const imported = countByCollection(plan, (u) => addedSet.has(u));
      const skippedByCollection = countByCollection(plan, (u) => !addedSet.has(u));
      const skippedExisting = plan.candidates.length - missing.length;

      if (missing.length >= BATCH_ADD_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('restore library items from', inputPath, [
            `Re-add ${missing.length} item(s) across ${Object.entries(imported).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', ')}:`,
            ...missing.slice(0, 10).map((u) => `  - ${u}`),
            ...(missing.length > 10 ? [`  (…and ${missing.length - 10} more)`] : []),
            // #1008: the operator confirms a write, so the subset they are
            // agreeing to has to be visible in the prompt, not only afterwards.
            ...(plan.truncated === true || plan.truncated === null
              ? [`  NOTE — ${truncationLine}`]
              : []),
          ]),
          confirmLabel: 'Restore library',
        });
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return shapeResult(rf, refusal.message, refusal.payload);
      }

      for (let i = 0; i < missing.length; i += CHUNK_CAPS.library_writes) {
        const chunk = missing.slice(i, i + CHUNK_CAPS.library_writes);
        await client.put(`/me/library?${new URLSearchParams(libraryUrisParam(chunk)).toString()}`);
      }

      // #736: the import is invertible through undo_last_mutation. A run that
      // wrote nothing mints no receipt — an empty-uri receipt would report
      // VERIFIED with after=0 and imply a save that never happened.
      const receipt = missing.length > 0 ? await issueReceipt(client, { kind: 'library', uris: missing }) : null;
      const payload = {
        ok: true,
        dry_run: false,
        executed: true,
        input: inputPath,
        present_keys: plan.present,
        absent_keys: plan.absent,
        collections: plan.collections,
        imported,
        added: missing.length,
        skipped_existing: skippedExisting,
        skipped_by_collection: skippedByCollection,
        invalid: plan.invalid,
        invalid_samples: plan.invalidSamples,
        total_in_file: plan.inFile,
        sample: missing.slice(0, 5),
        ...truncationPayload(plan),
        ...(receipt ? { receipt: receipt.receipt_id } : {}),
      };
      const summary = Object.entries(imported)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}: ${n}`)
        .join(', ');
      const prose = [
        `Import from ${inputPath}: added ${missing.length} item(s) to Your Library (${summary || 'none'}) across ${plan.present.length} collection(s).`,
        skippedExisting > 0 ? `${skippedExisting} item(s) were already in the library and were left untouched.` : '',
        invalidLine,
        absentLine,
        truncationLine,
        batchSummary(missing.length, missing),
        ...(receipt ? [formatReceipt(receipt)] : []),
      ]
        .filter((l) => l !== '')
        .join('\n');
      return shapeResult(rf, prose, payload);
    },
  );
}
