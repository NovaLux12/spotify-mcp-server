/**
 * Library backup (#159): snapshot the entire reachable library — liked
 * tracks, saved albums/shows/episodes/audiobooks, followed artists and every
 * playlist (with items) — into a timestamped local JSON file, plus a cheap
 * inventory of past snapshots.
 *
 * Backups are READ-ONLY against Spotify: every endpoint hit is a GET. The
 * only write is the local sidecar file (owner-only dir 0700 / file 0600,
 * same hygiene as scenes.json). Restore stays a separate, additive-only
 * concern (#160).
 *
 * Every walk is capped at getConfig().fetchAllCap (SPOTIFY_MCP_FETCH_ALL_CAP,
 * default 500); an explicit max_results argument overrides it for this call.
 */
import { z } from 'zod';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { ResponseFormat, type ResponseFormatValue } from '../shaping.js';
import type {
  FollowedArtistsResponse,
  PlaylistItemObject,
  SavedAlbumItem,
  SavedAudiobookItem,
  SavedEpisodeItem,
  SavedShowItem,
  SavedTrackItem,
  SpotifyPaged,
  SpotifyPlaylistSimple,
} from '../types/spotify.js';

// ---------------------------------------------------------------------------
// Snapshot schema (stable on-disk contract; restore #160 consumes these files)
// ---------------------------------------------------------------------------

/** One saved-library row: full URI, display name, when it was added. */
export interface BackupSavedRow {
  uri: string;
  name: string;
  added_at: string;
}

/** Followed artist row (the follow API carries no added_at). */
export interface BackupArtistRow {
  uri: string;
  name: string;
}

/** One playlist with its paged items (uri + name only). */
export interface BackupPlaylistRow {
  uri: string;
  name: string;
  /** Spotify's own item total when reported (`items.total`), else items.length. */
  item_count: number | null;
  items: Array<{ uri: string; name: string }>;
}

/** Cheap top-level block so list_backups never parses full snapshots. */
export interface BackupMeta {
  created: string;
  notes?: string;
  counts: {
    liked_tracks: number;
    saved_albums: number;
    saved_shows: number;
    saved_episodes: number;
    saved_audiobooks: number;
    followed_artists: number;
    playlists: number;
    playlist_items: number;
  };
}

/**
 * Top-level keys of a backup-*.json file. Order matters only cosmetically;
 * consumers MUST treat unknown keys as forward-compatible additions.
 */
export interface LibraryBackup {
  _meta: BackupMeta;
  liked_tracks: BackupSavedRow[];
  saved_albums: BackupSavedRow[];
  saved_shows: BackupSavedRow[];
  saved_episodes: BackupSavedRow[];
  saved_audiobooks: BackupSavedRow[];
  followed_artists: BackupArtistRow[];
  playlists: BackupPlaylistRow[];
}

// ---------------------------------------------------------------------------
// Sidecar location + sequencing
// ---------------------------------------------------------------------------

/** Backup dir; SPOTIFY_MCP_BACKUP_DIR overrides the whole directory. */
export function backupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_BACKUP_DIR ?? join(homedir(), '.spotify-mcp', 'backups');
}

const BACKUP_FILE_RE = /^backup-(\d{4}-\d{2}-\d{2})-(\d+)\.json$/;

/**
 * Next free sequence for today's date inside dir. Scans existing names so
 * repeated backups the same day never clobber each other.
 */
export async function nextBackupSeq(dir: string, dateStamp: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const n of names) {
    const m = BACKUP_FILE_RE.exec(n);
    if (m && m[1] === dateStamp) max = Math.max(max, Number(m[2]));
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// Collection (read-only GETs, all walks capped)
// ---------------------------------------------------------------------------



/**
 * Offset-walk a standard Spotify paged endpoint up to `cap` items using the
 * raw client get (not getAllPages) so every page stays observable in tests
 * and the cap applies uniformly across heterogeneous endpoints.
 */
async function walkOffset<T>(
  client: SpotifyClient,
  path: string,
  cap: number,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  // Hard iteration bound so a misbehaving server can never loop forever.
  while (out.length < cap && offset < cap * 2) {
    const page = await client.get<SpotifyPaged<T>>(path, {
      limit: '50',
      offset: String(offset),
    });
    if (!page || !Array.isArray(page.items)) break;
    out.push(...page.items);
    if (!page.next || page.items.length === 0) break;
    offset += page.items.length;
  }
  if (out.length > cap) out.length = cap;
  return out;
}

async function walkSaved(
  client: SpotifyClient,
  path: string,
  key: 'track' | 'album' | 'show' | 'episode' | 'audiobook',
  cap: number,
): Promise<BackupSavedRow[]> {
  type Row = { added_at: string } & Record<string, { uri: string; name: string }>;
  const rows = await walkOffset<Row>(client, path, cap);
  return rows
    .filter((r) => r[key] !== undefined && r[key] !== null)
    .map((r) => ({ uri: r[key].uri, name: r[key].name, added_at: r.added_at }));
}

/** Cursor-walk followed artists (after-cursor pagination, not offsets). */
async function walkFollowedArtists(
  client: SpotifyClient,
  cap: number,
): Promise<BackupArtistRow[]> {
  const out: BackupArtistRow[] = [];
  let after: string | undefined;
  while (out.length < cap) {
    const params: Record<string, string> = { type: 'artist', limit: '50' };
    if (after) params.after = after;
    const page = await client.get<FollowedArtistsResponse>('/me/following', params);
    const items = page?.artists?.items ?? [];
    if (items.length === 0) break;
    out.push(...items.map((a) => ({ uri: a.uri, name: a.name })));
    after = page?.artists?.cursors?.after ?? undefined;
    if (!page?.artists?.next || !after) break;
  }
  if (out.length > cap) out.length = cap;
  return out;
}

/** Per-playlist item cap (#159): at most 500 items snapshotted per playlist. */
const PLAYLIST_ITEMS_CAP = 500;

function playlistItemRows(rows: PlaylistItemObject[], cap: number): BackupPlaylistRow['items'] {
  const out: Array<{ uri: string; name: string }> = [];
  for (const r of rows) {
    if (out.length >= cap) break;
    // Local tracks removed by Spotify surface as null items — skip them.
    const item = r.item;
    if (!item || typeof item !== 'object') continue;
    if (typeof item.uri !== 'string' || typeof item.name !== 'string') continue;
    out.push({ uri: item.uri, name: item.name });
  }
  return out;
}

/** Page one playlist's items up to min(cap, PLAYLIST_ITEMS_CAP). */
async function collectPlaylistItems(
  client: SpotifyClient,
  playlistId: string,
  cap: number,
): Promise<{ items: BackupPlaylistRow['items']; truncated: boolean }> {
  const limit = Math.min(cap, PLAYLIST_ITEMS_CAP);
  const out: Array<{ uri: string; name: string }> = [];
  let offset = 0;
  while (out.length < limit && offset < limit * 2) {
    const page = await client.get<SpotifyPaged<PlaylistItemObject>>(
      `/playlists/${playlistId}/items`,
      { limit: '100', offset: String(offset) },
    );
    if (!page || !Array.isArray(page.items)) break;
    out.push(...playlistItemRows(page.items, limit));
    if (!page.next || page.items.length === 0) break;
    offset += page.items.length;
  }
  return { items: out.slice(0, limit), truncated: out.length >= limit };
}

/** Gather the full library snapshot via read-only GETs. */
export async function collectSnapshot(client: SpotifyClient, cap: number): Promise<Omit<LibraryBackup, '_meta'>> {
  const [liked, albums, shows, episodes, audiobooks, artists, playlists] = await Promise.all([
    walkSaved(client, '/me/tracks', 'track', cap),
    walkSaved(client, '/me/albums', 'album', cap),
    walkSaved(client, '/me/shows', 'show', cap),
    walkSaved(client, '/me/episodes', 'episode', cap),
    walkSaved(client, '/me/audiobooks', 'audiobook', cap),
    walkFollowedArtists(client, cap),
    walkOffset<SpotifyPlaylistSimple>(client, '/me/playlists', cap),
  ]);

  const playlistRows: BackupPlaylistRow[] = [];
  for (const p of playlists) {
    if (!p || typeof p.uri !== 'string') continue;
    const { items } = await collectPlaylistItems(client, p.id, cap);
    const reported =
      p.items && typeof p.items === 'object' && typeof (p.items as { total?: unknown }).total === 'number'
        ? (p.items.total as number)
        : null;
    playlistRows.push({
      uri: p.uri,
      name: typeof p.name === 'string' ? p.name : '',
      item_count: reported ?? items.length,
      items,
    });
  }

  return {
    liked_tracks: liked,
    saved_albums: albums,
    saved_shows: shows,
    saved_episodes: episodes,
    saved_audiobooks: audiobooks,
    followed_artists: artists,
    playlists: playlistRows,
  };
}

function metaCounts(snap: Omit<LibraryBackup, '_meta'>): BackupMeta['counts'] {
  return {
    liked_tracks: snap.liked_tracks.length,
    saved_albums: snap.saved_albums.length,
    saved_shows: snap.saved_shows.length,
    saved_episodes: snap.saved_episodes.length,
    saved_audiobooks: snap.saved_audiobooks.length,
    followed_artists: snap.followed_artists.length,
    playlists: snap.playlists.length,
    playlist_items: snap.playlists.reduce((n, p) => n + p.items.length, 0),
  };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Emit a tool result: json mode stringifies the payload; twin always attached. */
function shapeResult(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolOut {
  return {
    content: [{ type: 'text', text: rf === 'json' ? JSON.stringify(payload, null, 2) : prose }],
    structuredContent: payload,
  };
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBackupTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'backup_library',
    'Snapshot your ENTIRE library to a local JSON file (read-only against Spotify): liked tracks, saved albums/shows/episodes/audiobooks, followed artists, and every playlist with its items. Walks capped at SPOTIFY_MCP_FETCH_ALL_CAP (default 500 per category). Files land in SPOTIFY_MCP_BACKUP_DIR (default ~/.spotify-mcp/backups), mode 0600.',
    {
      notes: z.string().optional().describe('Free-text note stored in the snapshot _meta block'),
      response_format: ResponseFormat,
      max_results: z
        .number()
        .int()
        .positive()
        .max(2000)
        .optional()
        .describe('Per-category walk cap for THIS call (default: SPOTIFY_MCP_FETCH_ALL_CAP)'),
    },
    async (args) => {
      const cap = args.max_results ?? getConfig().fetchAllCap;

      const collected = await collectSnapshot(client, cap);
      const created = new Date().toISOString();
      const snapshot: LibraryBackup = {
        _meta: {
          created,
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
          counts: metaCounts(collected),
        },
        ...collected,
      };

      const dir = backupDir();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const dateStamp = created.slice(0, 10);
      const seq = await nextBackupSeq(dir, dateStamp);
      const file = join(dir, `backup-${dateStamp}-${seq}.json`);
      const body = `${JSON.stringify(snapshot, null, 2)}\n`;
      // 'wx' refuses to clobber even if sequencing raced another writer.
      await writeFile(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

      const c = snapshot._meta.counts;
      const payload: Record<string, unknown> = {
        ok: true,
        file,
        bytes: Buffer.byteLength(body),
        counts: c,
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
      };
      if (args.response_format === 'json') {
        // Full snapshot as the text body; the summary twin stays on
        // structuredContent so cheap consumers never re-parse the blob.
        return {
          content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
          structuredContent: payload,
        };
      }
      const prose =
        `Library backup written → ${file} (${formatBytes(payload.bytes as number)})\n` +
        `- Liked tracks: ${c.liked_tracks}\n` +
        `- Saved albums: ${c.saved_albums}\n` +
        `- Saved shows: ${c.saved_shows}\n` +
        `- Saved episodes: ${c.saved_episodes}\n` +
        `- Saved audiobooks: ${c.saved_audiobooks}\n` +
        `- Followed artists: ${c.followed_artists}\n` +
        `- Playlists: ${c.playlists} (${c.playlist_items} items)`;
      return shapeResult(args.response_format, prose, payload);
    },
  );

  server.tool(
    'list_backups',
    'List previous library backups (newest first) with path, creation date, size, and the _meta.counts summary from each snapshot',
    { response_format: ResponseFormat },
    async (args) => {
      const dir = backupDir();
      let names: string[] = [];
      try {
        names = (await readdir(dir)).filter((n) => BACKUP_FILE_RE.test(n));
      } catch {
        names = [];
      }

      if (names.length === 0) {
        return shapeResult(
          args.response_format,
          `No backups found in ${dir}. Run backup_library first.`,
          { ok: true, dir, backups: [] },
        );
      }

      const backups = (
        await Promise.all(
          names.map(async (name) => {
            const path = join(dir, name);
            try {
              const [st, parsed] = await Promise.all([
                stat(path),
                readFile(path, 'utf8').then(
                  (raw) => JSON.parse(raw) as Partial<LibraryBackup>,
                ),
              ]);
              return {
                path,
                created: parsed._meta?.created ?? st.mtime.toISOString(),
                ...(parsed._meta?.notes !== undefined ? { notes: parsed._meta.notes } : {}),
                bytes: st.size,
                counts: parsed._meta?.counts ?? null,
              };
            } catch {
              // Unreadable/corrupt entry: still listed, but unsummarized.
              return { path, created: null, bytes: null, counts: null, notes: undefined };
            }
          }),
        )
      ).sort((a, b) => {
        const ta = a.created ? Date.parse(a.created) : Number.NEGATIVE_INFINITY;
        const tb = b.created ? Date.parse(b.created) : Number.NEGATIVE_INFINITY;
        return tb - ta || b.path.localeCompare(a.path);
      });

      const lines = [`Backups in ${dir} (newest first):`];
      for (const b of backups) {
        const bits = [
          b.created ?? 'unknown date',
          b.bytes !== null ? formatBytes(b.bytes) : 'unreadable',
        ];
        if (b.notes) bits.push(`notes: "${b.notes}"`);
        if (b.counts) {
          bits.push(
            `tracks ${b.counts.liked_tracks}, playlists ${b.counts.playlists}` +
              ` (${b.counts.playlist_items} items), artists ${b.counts.followed_artists}`,
          );
        }
        lines.push(`- ${b.path} — ${bits.join(' · ')}`);
      }

      return shapeResult(args.response_format, lines.join('\n'), {
        ok: true,
        dir,
        count: backups.length,
        backups,
      });
    },
  );
}
