/**
 * swarm4 playlists slice — feature swarm v1.25.0 (issues #420–#437).
 *
 * Owned by the fix/swarm4-playlists builder. All tools in this slice are
 * registered here and nowhere else. NOTE: this is NOT tools/playlistops.ts —
 * that file owns merge_playlists/diff_playlists/overlap_playlists (#96).
 *
 * House conventions honoured here:
 *   • shaping.ts helpers only (resolveMaxResults / truncateItems / getAllPages
 *     via the client) — nothing hand-rolled.
 *   • Every mutating tool carries `dry_run` (default TRUE) and performs the
 *     read side + returns a deterministic PLAN when true (#57).
 *   • Playlist item ops use /playlists/{id}/items (Feb-2026 path).
 *   • Order rewrites are atomic: PUT replaces (≤100 URIs per call), the
 *     remainder appends via POST through the serialized client queue,
 *     mirroring replace_playlist_items on main.
 *   • Full-sequence rewrites REFUSE to run when the playlist contains
 *     unavailable items (empty uri) — a rewrite would silently drop them.
 *   • No deprecated endpoints (SPEC §9).
 */
import { z } from 'zod';
import {
  DuplicateMatchByParam,
  IncludeFeaturedParam,
  classifyArtistReference,
  dedupeItems,
  resolveMatchBy,
  trackMatchesArtist,
} from '../playlistmatch.js';
import { capFor, chunk } from '../chunk.js';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { backupDir } from './backup.js';
import { assertPlaylistRewriteReadable, assertPlaylistRewritable, unavailableRowPositions } from './rewritable.js';
import {
  ResponseFormat,
  MaxResults,
  PlaylistPairFields,
  batchSummary,
  describeDryRun,
  parseSpotifyUri,
  resolveMaxResults,
  resolvePlaylistInput,
  sharedListFields,
  truncateItems,
  untrusted,
  withPlaylistInputMetadata,
  withPlaylistInputNote,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import type {
  PlaylistItemObject,
  SpotifyEpisode,
  SpotifyTrack,
} from '../types/spotify.js';
import type { LibraryBackup } from './backup.js';
import { diffTrackLists } from './swarm3_snapshots.js';
import type { SnapTrackRow } from './swarm3_snapshots.js';
import { isMissingFileRefusal, ownStoreRoots, readLocalFile } from '../paths.js';
import { positionDesc, positionSchema } from '../positionbase.js';
import { consentFields, declaredCreationDate, provenanceNote, provenancePromptLines, type WriteProvenance } from './provenance.js';
import { emit } from '../result.js';
import { spotifyRef } from '../refs.js';

type TextContent = { type: 'text'; text: string };
;

// ---------------------------------------------------------------------------
// Shared shaping helpers
// ---------------------------------------------------------------------------

/** #51/#52 shaping: json mode stringifies the payload; payload rides as structuredContent. */
/** `dry_run` fragment defaulting to TRUE (repo convention: previews are the default). */
const DryRunDefault = z
  .boolean()
  .optional()
  .default(true)
  .describe(
    'Preview only: perform the read side and return a PLAN without changing anything. '
      + 'Pass false to commit. Default true',
  );

const PublicFlag = z
  .boolean()
  .optional()
  .describe('New playlists public? Default false (private)');

const IncludeFullOrder = z
  .boolean()
  .optional()
  .describe('Opt in to the full planned order; otherwise structuredContent is capped');

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Accept a bare playlist ID or a spotify:playlist: URI; return the raw ID. */
function normalizePlaylistRef(ref: string): string {
  const parsed = parseSpotifyUri(ref);
  if (parsed && parsed.type === 'playlist') return parsed.id;
  return ref.trim();
}

/** Accept a bare artist ID or spotify:artist: URI; return the raw ID. */
function normalizeArtistRef(ref: string): string {
  const parsed = parseSpotifyUri(ref);
  if (parsed && parsed.type === 'artist') return parsed.id;
  return ref.trim();
}

/**
 * The outcome of one playlist item walk: the rows it read, and the verdict on
 * whether it read ALL of them.
 *
 * #1362: a bare `PlaylistItemObject[]` cannot tell "this is the whole playlist"
 * from "this is the first `cap` rows of it", and every committing tool in this
 * slice builds a URI list from it and PUTs the whole list back. On a playlist
 * larger than the cap the unread rows are simply ABSENT from the PUT, and an
 * absent row in a full-content replace is a deleted row. So the verdict travels
 * with the rows instead of being dropped.
 */
interface PlaylistWalk {
  items: PlaylistItemObject[];
  /** The walk stopped short of the end of the playlist. */
  truncated: boolean;
  /**
   * The CAP is what truncated the walk, rather than the walk ending on a short
   * page while Spotify's own `total` still counted rows past it (#718/#864).
   *
   * #1388: the ten rewrites only ever REFUSE, and a refusal names the cap as
   * the remedy, so the distinction is invisible to them. `playlist_balance`
   * discloses instead, and a disclosure that says "truncated at the cap" when
   * the cap never bound the walk sends the caller to raise a ceiling that
   * would not have helped.
   */
  truncatedByCap: boolean;
  /** The ceiling that produced the truncation, so a refusal can name it. */
  cap: number;
  /** Spotify's own `items.total` when the walk saw a page carrying one. */
  reportedTotal: number | null;
}

/** Page every item of a playlist (playlist order), capped by the fetch-all cap. */
async function fetchAllItems(client: SpotifyClient, ref: string): Promise<PlaylistWalk> {
  const id = encodeURIComponent(normalizePlaylistRef(ref));
  const cap = getConfig().fetchAllCap;
  // One row PAST the cap is what lets the walk see the row that overflows it
  // and prove the truncation happened; the probe is dropped again below. A
  // `rows.length >= cap` test reports every exact-cap playlist as truncated and
  // would refuse work the tool can actually do correctly.
  const walk = await client.getAllPagesWithTruncation<PlaylistItemObject>(
    `/playlists/${id}/items`,
    { limit: '100' },
    { maxItems: cap + 1 },
  );
  const overflowedCap = walk.items.length > cap;
  return {
    items: walk.items.slice(0, cap),
    // The walk's own verdict OR the clip applied above. `walk.truncated` alone
    // cannot see the cap+1 case: the client stops once `all.length` reaches
    // `maxItems`, and with maxItems === cap+1 a playlist of exactly cap+1 rows
    // is not itself an overflow, so only the clip proves it (#718/#864).
    truncated: walk.truncated || overflowedCap,
    // The clip is itself a cap overflow — the walk holds more rows than the cap
    // admits — so on that path the cap is the cause even where the walk's own
    // attribution had not fired.
    truncatedByCap: walk.truncatedByCap || overflowedCap,
    cap,
    reportedTotal: walk.reportedTotal,
  };
}

const isTrack = (p: SpotifyTrack | SpotifyEpisode | null | undefined): p is SpotifyTrack =>
  p?.type === 'track';
const isEpisode = (p: SpotifyTrack | SpotifyEpisode | null | undefined): p is SpotifyEpisode =>
  p?.type === 'episode';

interface LoadedPlaylist {
  id: string;
  name: string | null;
  items: PlaylistItemObject[];
  /**
   * #1362: the walk's own verdict, and the ceiling that produced it. Carried on
   * the loaded playlist because the committing tools all commit through ONE
   * atomic full-content replace, so a truncated walk is not a smaller answer —
   * it is a smaller answer the playlist is then made to match, and the rows past
   * the cap are deleted. `cap` is here so the refusal can name the boundary
   * rather than saying "some rows were missed".
   */
  truncated: boolean;
  /**
   * Whether the CAP is the reason, as opposed to a walk that ended on a short
   * page while the server's `total` still counted more. `playlist_balance`
   * discloses the verdict rather than refusing it, and a disclosure that
   * attributes a short read to a ceiling that never bound it points the caller
   * at the wrong knob (#1388).
   */
  truncatedByCap: boolean;
  cap: number;
  /**
   * Spotify's own item count, read from the metadata this already fetched — so
   * the refusal can say "at least N more rows were never read" instead of
   * leaving the size of the unread region unknown. Undefined when the metadata
   * carried no count; never substituted with the count that could be read.
   */
  total?: number;
}

/** Playlist metadata + fully paged items; fails fast on a missing playlist. */
async function loadPlaylistFull(client: SpotifyClient, ref: string): Promise<LoadedPlaylist> {
  const id = normalizePlaylistRef(ref);
  const meta = await client.get<{ id?: string; name?: string; items?: { total?: number }; tracks?: { total?: number } }>(
    `/playlists/${encodeURIComponent(id)}`,
  );
  if (!meta) throw new Error(`Playlist "${ref}" not found`);
  const walk = await fetchAllItems(client, id);
  // `items` is the current field on a playlist object; `tracks` is the
  // deprecated spelling still served by some responses. Whichever carried a
  // number is used, and neither is ever defaulted to `walk.items.length` —
  // that count IS the truncated one, so substituting it would let the refusal
  // report the shortfall as "nothing was missed".
  const reported = meta.items?.total ?? meta.tracks?.total ?? walk.reportedTotal;
  return {
    id,
    name: meta.name ?? null,
    items: walk.items,
    truncated: walk.truncated,
    truncatedByCap: walk.truncatedByCap,
    cap: walk.cap,
    ...(typeof reported === 'number' ? { total: reported } : {}),
  };
}

/**
 * Atomic overwrite: PUT replaces the whole playlist (≤100 URIs per call), so
 * the first chunk does the replacement and any remainder is appended via POST
 * — mirroring replace_playlist_items on main.
 *
 * #1362: the target arrives as the WHOLE `LoadedPlaylist`, not as a bare id,
 * so the write cannot be reached by a read whose verdict was never checked.
 * Every one of the ten call sites builds `uris` from `p.items` and targets
 * `p.id`, which makes this the single point where "the read was whole" and
 * "the write is about to happen" are provably the same playlist. The
 * truncation refusal is re-asserted here as the structural backstop: a new
 * tool added later inherits it by calling this function, instead of having to
 * remember a second guard. The per-tool `assertPlaylistReadWhole(p)` ahead of
 * the `dry_run` branch is not redundant with this one — it is the only
 * enforcement a dry run can reach, since a preview issues no write.
 */
async function atomicReplace(
  client: SpotifyClient,
  target: LoadedPlaylist,
  uris: readonly string[],
): Promise<{ requests: number; snapshot_id?: string }> {
  assertPlaylistReadWhole(target);
  const path = `/playlists/${encodeURIComponent(target.id)}/items`;
  let snapshotId: string | undefined;
  let requests = 0;
  const writeCap = capFor('playlist_writes');
  for (let start = 0; start < uris.length; start += writeCap) {
    const chunk = uris.slice(start, start + writeCap);
    const res =
      start === 0
        ? await client.put<{ snapshot_id?: string }>(path, { uris: chunk })
        : await client.post<{ snapshot_id?: string }>(path, { uris: chunk });
    if (res?.snapshot_id) snapshotId = res.snapshot_id;
    requests++;
  }
  return { requests, snapshot_id: snapshotId };
}

/** Create a playlist under /me/playlists. */
async function createPlaylist(
  client: SpotifyClient,
  name: string,
  isPublic: boolean,
  description?: string,
): Promise<string> {
  const body: Record<string, unknown> = { name, public: isPublic };
  if (description) body.description = description;
  const created = await client.post<{ id?: string }>('/me/playlists', body);
  if (!created?.id) throw new Error('Could not create playlist');
  return created.id;
}

/** Append URIs in ≤100-URI chunks; returns request accounting. */
async function addUrisChunked(
  client: SpotifyClient,
  targetId: string,
  uris: readonly string[],
): Promise<{ requests: number; snapshot_id?: string }> {
  const path = `/playlists/${encodeURIComponent(targetId)}/items`;
  let snapshotId: string | undefined;
  let requests = 0;
  const writeCap = capFor('playlist_writes');
  for (let start = 0; start < uris.length; start += writeCap) {
    const res = await client.post<{ snapshot_id?: string }>(path, {
      uris: uris.slice(start, start + writeCap),
    });
    if (res?.snapshot_id) snapshotId = res.snapshot_id;
    requests++;
  }
  return { requests, snapshot_id: snapshotId };
}

/** Fisher–Yates over a copy (sampling helper). */
function shuffleArr<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** mulberry32 PRNG — small, fast, deterministic for a given uint32 seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `4312000` ms → `1:11:52`-style clock for prose plans. */
function msToClock(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Today as `YYYY-MM-DD` (default playlist names). */
function formatDateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

interface OpRow {
  /** Empty string when the item is unavailable (removed from catalog). */
  uri: string;
  name: string;
  kind: 'track' | 'episode' | 'unavailable';
  durationMs: number | null;
  addedAt: string;
  /** Track artist names, in track order. Episodes: show name. */
  artists: string[];
  artistIds: string[];
  album: string | null;
}

/** Flatten paged playlist entries into rich rows. */
function toRows(items: readonly PlaylistItemObject[]): OpRow[] {
  return items.map((entry) => {
    const p = entry.item;
    if (isTrack(p)) {
      return {
        uri: p.uri,
        name: p.name,
        kind: 'track' as const,
        durationMs: p.duration_ms,
        addedAt: entry.added_at ?? '',
        artists: (p.artists ?? []).map((a) => a.name),
        artistIds: (p.artists ?? []).map((a) => a.id),
        album: p.album?.name ?? null,
      };
    }
    if (isEpisode(p)) {
      return {
        uri: p.uri,
        name: p.name,
        kind: 'episode' as const,
        durationMs: p.duration_ms,
        addedAt: entry.added_at ?? '',
        artists: p.show?.name ? [p.show.name] : [],
        artistIds: [],
        album: null,
      };
    }
    return {
      uri: '',
      name: '(unavailable)',
      kind: 'unavailable' as const,
      durationMs: null,
      addedAt: entry.added_at ?? '',
      artists: [],
      artistIds: [],
      album: null,
    };
  });
}

/**
 * Guard for every committing tool in this slice: the write path is a full
 * atomic replace, so unavailable items (empty uri) would silently vanish.
 * The predicate itself is shared with swarm3_playlistops.ts and playlists.ts
 * (#860) — this is only the LoadedPlaylist-shaped wrapper around it.
 *
 * #1388: the verdict is passed through so the quoted count is marked as a
 * lower bound when the walk was short. For the ten committing tools this is
 * unreachable — `assertPlaylistReadWhole` refuses a truncated read first, in
 * every one of them — but `playlist_balance` discloses truncation instead of
 * refusing it, so this is the one place the unavailable-row refusal can meet a
 * short read. `contains 1 unavailable item(s)` off a walk that stopped at the
 * cap is a count of the rows that were read presented as a count of the
 * playlist, which is the fault #1362 was filed on. `playlists.ts` already
 * threads `truncated` through for the same reason.
 */
function assertRewritable(p: LoadedPlaylist): void {
  assertPlaylistRewritable(plName(p), unavailableRowPositions(p.items), { truncated: p.truncated });
}

/**
 * #1362 — the truncation half of the guard, for the ten tools here that commit
 * one atomic full-content replace.
 *
 * A SEPARATE predicate from {@link assertRewritable} that composes with it, on
 * the rule `rewritable.ts` states: the two guards answer different questions
 * and neither relaxes the other. #860 asks "can every row read be put back by
 * URI?". #1362 asks "were all the rows read at all?". A caller told the first
 * needs `remove_unavailable_playlist_items`; a caller told the second needs a
 * higher `SPOTIFY_MCP_FETCH_ALL_CAP`, and sending them to the wrong remedy is
 * how a workaround gets applied to the wrong fault.
 *
 * It REFUSES rather than disclosing, and that is the whole point. A truncated
 * walk is not a preview of a correct answer — the rewrite is COMPUTED from the
 * rows that were read, so on a truncated read the result is a DIFFERENT answer,
 * not a smaller one: a reverse of the first 500 rows, a dedupe that never saw
 * rows 501–600, a runtime filter that kept a track because the tracks that
 * should have displaced it were past the cap. A warning is acceptable where
 * something else stands between the short read and the damage (a mandatory
 * elicitation on every destructive impact, which is why `playlists.ts` can
 * disclose inside `playlist_union`'s confirmation prompt). None of these ten
 * tools has such a gate on this path, and the write they guard is a full
 * replace: there is no partial-damage outcome to warn about, only rows the
 * user still had yesterday and will not have after this call returns.
 *
 * It fires before the dry-run branch too, alongside `assertRewritable`. A
 * preview that renders "would reverse 500 items" for a 600-row playlist is a
 * preview of a commit that will be refused, and `dry_run` here already refuses
 * the sibling unavailable-row fault for the same reason.
 */
function assertPlaylistReadWhole(p: LoadedPlaylist): void {
  assertPlaylistRewriteReadable(plName(p), {
    truncated: p.truncated,
    rowCount: p.items.length,
    cap: p.cap,
    total: p.total,
  });
}

/**
 * #1388 — the counterpart to {@link assertPlaylistReadWhole} for the ONE tool
 * in this slice that has nothing to protect: `playlist_balance` reads a
 * playlist, splits what it read, and writes the parts to NEW playlists. The
 * source is never touched, so there is no atomic full replace for a short read
 * to be mistaken for, and nothing the caller had before the call is gone after
 * it.
 *
 * That is the whole reason this tool discloses where its ten siblings refuse.
 * The refusal in `rewritable.ts` is argued on irreversibility — "there is no
 * partial-damage outcome to warn about, only rows the user still had" — and
 * none of that transfers to a copy. Refusing here would also mean that a
 * caller who cannot raise `SPOTIFY_MCP_FETCH_ALL_CAP` (a hosted server, a
 * fixed env) can never split a playlist larger than the cap at all, which is a
 * functional hole bought with no safety.
 *
 * What DOES transfer is the requirement that the answer not overstate its
 * scope, because the split is computed from the rows that were read: a
 * round-robin deal of the first 500 of 600 rows deals the first 500 rows, and
 * "every part samples the whole span" is then a claim about a span the caller
 * never had. So this returns the disclosure and the tool puts it in front of
 * the answer, never behind it, in both the dry run and the commit.
 *
 * Returns '' on a whole read, so callers can prepend it unconditionally and
 * pay nothing when the read was complete.
 */
function describeSplitCoverage(p: LoadedPlaylist, rowsRead: number): string {
  if (!p.truncated) return '';
  // `truncated_by_cap` is not decoration: a walk that ended on a short page
  // while Spotify's `total` still counted more was never capped, and telling
  // the caller to raise the cap would send them to a knob that changes nothing.
  const via = p.truncatedByCap
    ? `the item walk stopped at the fetch-all cap of ${p.cap} row(s)`
    : 'the item walk ended before the last row Spotify reported, so the cap never bound it';
  // An unread `items.total` is never rounded down to the rows that were read:
  // that substitution is the exact claim this disclosure exists to stop (#718).
  const size = typeof p.total === 'number'
    ? `read ${rowsRead} of ${p.total} row(s), so at least ${Math.max(0, p.total - rowsRead)} of them are NOT in these parts`
    : `read ${rowsRead} row(s), and the playlist's own size was not readable, so the size of the unread region is unknown`;
  return `PARTIAL SPLIT — ${via}: ${size}. The source playlist is unchanged and still holds every row; `
    + `raise SPOTIFY_MCP_FETCH_ALL_CAP above this playlist's row count and re-run to cover the rest.`;
}

/** "Name — Artist" style display label for a row. */
function rowLabel(r: OpRow): string {
  const who = r.artists.length > 0 ? ` — ${r.artists.join(', ')}` : '';
  // #1422: the track title and every credited artist name are third-party
  // text. Marking here rather than at each of the dozen `${rowLabel(...)}`
  // sites in this file is deliberate — `rowLabel` is the single point where a
  // row becomes a sentence, so a tool added later inherits the marking by
  // being formatted through it. `untrusted()`'s own contract says to delimit
  // at the template site and never by mutating the row, and it does: `r` is
  // untouched, and the `OpRow` that rides in `structuredContent` keeps its
  // names verbatim.
  return untrusted(`${r.name}${who}`);
}

/**
 * A playlist's display name for prose (#1422).
 *
 * The name is Spotify-supplied — anyone who can share a playlist can choose it
 * — and this file renders it into the sentence that confirms a mutation the
 * model has just made, which is the one place injected text is hardest to
 * discount. So it is marked.
 *
 * The `p.id` fallback deliberately is NOT. An id is a base62 string Spotify
 * allocated; there is nothing in it for a model to be steered by, and marking
 * it would be noise in every sentence that happens to name a playlist with no
 * title — which teaches the next reader to skim past the marker. The rule is
 * "mark what a person can choose", and only the name is that.
 */
function plName(p: { id: string; name: string | null }): string {
  return p.name ? untrusted(p.name) : p.id;
}

/** Truncate a row list into prose lines + footer, honoring max_results. */
function renderRows(rows: readonly OpRow[], maxResults: number, marker = '✓'): string[] {
  const view = truncateItems(rows, maxResults);
  const lines = view.items.map((r, i) => `  ${marker} ${i + 1}. ${rowLabel(r)} [${r.uri}]`);
  if (view.footer) lines.push(`  (${view.footer})`);
  return lines;
}

/** Budget a structuredContent array and disclose exactly what the cap withheld. */
function budgetedArray<T>(
  items: readonly T[],
  maxResults: number,
  field = 'items',
  includeFull = false,
): {
  value: T[];
  total: number;
  returned: number;
  withheld: number;
  truncated: boolean;
  disclosure: Record<string, unknown>;
} {
  const cap = includeFull ? items.length : maxResults;
  const view = truncateItems(items, cap);
  return {
    value: view.items,
    total: view.total,
    returned: view.returned,
    withheld: view.remaining,
    truncated: view.truncated,
    disclosure: {
      [`${field}_total`]: view.total,
      [`${field}_returned`]: view.returned,
      [`${field}_withheld`]: view.remaining,
      [`${field}_truncated`]: view.truncated,
    },
  };
}

// ---------------------------------------------------------------------------
// Backup-file helpers (snapshots live in backupDir from ./backup.js)
// ---------------------------------------------------------------------------

const SNAPSHOT_RE = /^backup-\d{4}-\d{2}-\d{2}-\d+\.json$/;

interface SnapshotSummary {
  file: string;
  created: string | null;
  playlists: number;
  playlistItems: number;
  likedTracks: number;
}

async function listSnapshotFiles(): Promise<string[]> {
  const dir = backupDir();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => SNAPSHOT_RE.test(n)).sort();
}

async function readSnapshot(file: string): Promise<LibraryBackup> {
  const path = join(backupDir(), file);
  let raw: string;
  try {
    // #623: `file` is a snapshot name the caller may have supplied, and the
    // path is built from the backup dir. Confined, regular-file-only and
    // size-capped.
    raw = await readLocalFile({ roots: ownStoreRoots(path), tool: 'library backup snapshot', target: path });
  } catch (err) {
    // #1617: only a genuinely ABSENT file is "not found". The guard's three
    // refusals — outside the read roots, not a regular file, over the size cap
    // — are a different diagnosis, and reporting them as "not found" is what
    // told a caller to go looking somewhere else. Each carries the reason and
    // the roots it checked, so it rethrows unchanged.
    if (!isMissingFileRefusal(err)) throw err;
    const all = await listSnapshotFiles();
    const hint = all.length > 0
      ? ` Available snapshots: ${all.slice(0, 8).join(', ')}${all.length > 8 ? '…' : ''}`
      : ` No snapshots found in ${backupDir()} — run backup_library first.`;
    throw new Error(`Snapshot "${file}" not found.${hint}`);
  }
  const parsed = JSON.parse(raw) as LibraryBackup;
  if (!Array.isArray(parsed?.playlists)) {
    throw new Error(`Snapshot "${file}" is malformed (no playlists array).`);
  }
  return parsed;
}

/** Find one playlist inside a snapshot: exact name first, then case-insensitive substring. */
function findSnapshotPlaylist(
  snap: LibraryBackup,
  file: string,
  wanted: string,
): { uri: string; name: string; item_count: number | null; items: Array<{ uri: string; name: string }> } {
  const wantedLc = wanted.trim().toLowerCase();
  const exact = snap.playlists.find((p) => p.name.toLowerCase() === wantedLc);
  const row = exact ?? snap.playlists.find((p) => p.name.toLowerCase().includes(wantedLc));
  if (!row) {
    const names = snap.playlists.map((p) => p.name).slice(0, 12).join(', ');
    throw new Error(
      `Playlist "${wanted}" not found in snapshot ${file}. ` +
        `Playlists present: ${untrusted(names)}${snap.playlists.length > 12 ? '…' : ''}`,
    );
  }
  return { uri: row.uri, name: row.name, item_count: row.item_count, items: row.items };
}

// ---------------------------------------------------------------------------
// Registration — 18 tools, issues #420–#437
// ---------------------------------------------------------------------------

export function registerSwarm4PlaylistsTools(server: McpServer, client: SpotifyClient): void {
  // -----------------------------------------------------------------------
  // #420 playlist_sort
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_resequence',
    'Sort a playlist in place — by track name, artist, album, duration, or date added — written '
      + 'back as one atomic replace. Episodes sort last (no artist/album key). '
      + 'Quota: 2 GETs + 1 PUT.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to sort, as ID or spotify:playlist: URI'), 'playlist'),
      sort_by: z
        .enum(['name', 'artist', 'album', 'duration', 'added_at'])
        .describe('Sort key. artist/album use the first artist / album name'),
      direction: z
        .enum(['asc', 'desc'])
        .optional()
        .default('asc')
        .describe('Sort direction. Default asc'),
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
      const key = (r: OpRow): string | number | null => {
        switch (args.sort_by) {
          case 'name': return r.name;
          case 'artist': return r.artists[0] ?? null;
          case 'album': return r.album;
          case 'duration': return r.durationMs;
          case 'added_at': return r.addedAt ? Date.parse(r.addedAt) : null;
        }
      };
      const sign = args.direction === 'desc' ? -1 : 1;
      const keyed = rows.map((r) => ({ r, k: key(r) }));
      // #861: a key every row shares (an album sort over an all-episode
      // playlist, a name sort over one track repeated) cannot move anything,
      // and the commit path is a full atomic replace. Refuse before the
      // write rather than rewrite the playlist to its own order and report
      // a sort that never happened.
      const distinct = new Set(keyed.map(({ k }) => `${typeof k}:${k}`));
      if (rows.length > 1 && distinct.size <= 1) {
        return emit(
          rf,
          `Refused to sort "${plName(p)}" by ${args.sort_by}: no comparable values — all ${rows.length} item(s) share the same ${args.sort_by} value, so the sort would not change the order. Nothing was changed.`,
          {
            ok: false,
            reason: 'no_comparable_values',
            playlist: p.id,
            playlist_name: p.name,
            sort_by: args.sort_by,
            direction: args.direction,
            items: rows.length,
            distinct_values: distinct.size,
            changed: false,
            dry_run: args.dry_run,
          },
        );
      }
      const sorted = keyed.sort((a, b) => {
        const ka = a.k;
        const kb = b.k;
        if (ka === null && kb === null) return 0;
        if (ka === null) return 1; // nulls last regardless of direction
        if (kb === null) return -1;
        if (typeof ka === 'number' && typeof kb === 'number') return sign * (ka - kb);
        return sign * collator.compare(String(ka), String(kb));
      }).map(x => x.r);
      const uris = sorted.map((r) => r.uri);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const prose = [
        `${args.direction === 'desc' ? 'Descending' : 'Ascending'} sort of "${plName(p)}" by ${args.sort_by}:`,
        `  ${rows.length} item(s) would be reordered.`,
        '',
        ...renderRows(sorted, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        sort_by: args.sort_by,
        direction: args.direction,
        items: rows.length,
        order: orderBudget.value,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun(`sort by ${args.sort_by}`, plName(p), prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Sorted "${plName(p)}" by ${args.sort_by} (${args.direction}), ${rows.length} item(s).\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #421 playlist_rotate
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_rotate',
    'Rotate a playlist by N positions: positive N moves the first N items to the end, negative N '
      + 'moves the last |N| to the front (wraps around). Written as one atomic replace. '
      + 'Quota: 2 GETs + 1 PUT.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to rotate, as ID or spotify:playlist: URI'), 'playlist'),
      positions: z
        .number()
        .int()
        .describe('Rotation amount; positive = first N move to end, negative = last |N| move to front'),
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      const n = rows.length;
      if (n === 0) {
        return emit(rf, `"${plName(p)}" is empty — nothing to rotate.`, { ok: true, items: 0 });
      }
      const shift = ((args.positions % n) + n) % n;
      const rotated = [...rows.slice(shift), ...rows.slice(0, shift)];
      const uris = rotated.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const firstNew = rotated[0] ? rowLabel(rotated[0]) : '(empty)';
      const prose = [
        `Rotate "${plName(p)}" by ${args.positions} (effective ${shift} of ${n}):`,
        `  new first item: ${firstNew}`,
        ...renderRows(rotated, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        positions: args.positions,
        effective_shift: shift,
        items: n,
        order: orderBudget.value,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('rotate', plName(p), prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Rotated "${plName(p)}" by ${args.positions} — now starts with "${firstNew}".\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #422 playlist_shuffle
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_seed_shuffle',
    'Shuffle a playlist in place (Fisher–Yates) with an optional deterministic seed — same seed, '
      + 'same order, so you can preview and commit the exact same shuffle. Unavailable items are '
      + 'kept, pinned at the end. Quota: 2 GETs + 1 PUT.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to shuffle, as ID or spotify:playlist: URI'), 'playlist'),
      seed: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Deterministic seed (0–2^31): the same seed produces the same shuffle. Omit for random'),
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      const rand = args.seed !== undefined ? mulberry32(args.seed) : Math.random;
      const shuffled = shuffleArr(rows, rand);
      const uris = shuffled.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const prose = [
        `Shuffle "${plName(p)}"${args.seed !== undefined ? ` (seed ${args.seed} — reproducible)` : ''}:`,
        `  ${rows.length} item(s), order randomized.`,
        ...renderRows(shuffled, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        seed: args.seed ?? null,
        items: rows.length,
        order: orderBudget.value,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('shuffle', plName(p), prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Shuffled "${plName(p)}" (${rows.length} item(s)${args.seed !== undefined ? `, seed ${args.seed}` : ''}).\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #423 playlist_reverse
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_flip_order',
    'Reverse a playlist: last item becomes first, written as one atomic replace. The standard '
      + 'fix for imports that arrived backwards. Quota: 2 GETs + 1 PUT.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to reverse, as ID or spotify:playlist: URI'), 'playlist'),
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      const reversed = [...rows].reverse();
      const uris = reversed.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const prose = [
        `Reverse "${plName(p)}":`,
        `  ${rows.length} item(s); first becomes "${rows.length ? rowLabel(reversed[0]) : '(empty)'}".`,
        ...renderRows(reversed, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        items: rows.length,
        order: orderBudget.value,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('reverse', plName(p), prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Reversed "${plName(p)}" (${rows.length} item(s)).\n` + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #424 playlist_move_block
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_move_block',
    'Move a contiguous block of items (1-based start + count) so its first item lands at a target '
      + 'position expressed in the ORIGINAL numbering. The rest of the playlist closes up around '
      + 'it. Written as one atomic replace. Quota: 2 GETs + 1 PUT.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to edit, as ID or spotify:playlist: URI'), 'playlist'),
      // #883: the 1-based half of the playlist surface. These three are human
      // slot numbers, not wire values — the handler subtracts 1 before it
      // touches the API — so the base is the one thing standing between a
      // natural-language "move track 4" and an off-by-one that succeeds.
      start: positionSchema('one', 'Position of the first item to move'),
      count: z.number().int().min(1).optional().default(1).describe('How many contiguous items to move. Default 1'),
      to_position: positionSchema('one', 'Position, in the ORIGINAL numbering, where the block should land'),
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      const n = rows.length;
      const start = args.start;
      const count = Math.min(args.count, n - start + 1);
      if (start > n || count < 1) {
        return emit(rf, `Position ${args.start} is out of range for "${plName(p)}" (${n} item(s)).`, {
          ok: false,
          items: n,
        });
      }
      const t = Math.min(Math.max(args.to_position - 1, 0), Math.max(n - 1, 0));
      const block = rows.slice(start - 1, start - 1 + count);
      const rest = [...rows];
      rest.splice(start - 1, count);
      // Three-way: a target inside the block itself keeps the block where it is,
      // which is the no-op the order check below catches. Collapsing this to a
      // two-way `t < start - 1 ? t : t - count` would instead reorder the block
      // for an inside-block target.
      const idx = t < start - 1 ? t : t >= start - 1 + count ? t - count : start - 1;
      const moved = [...rest];
      moved.splice(Math.min(idx, moved.length), 0, ...block);
      const uris = moved.map((r) => r.uri);
      // A rewrite that changes nothing must not touch the playlist at all: the
      // replace would rebuild the exact URI sequence already stored, while still
      // costing a write request and, per a6-rewrite-unavailable-guard, risking a
      // silent drop of unavailable rows. Comparing the computed order with the
      // current one — rather than testing only "target inside the block" — also
      // catches a block that lands immediately past itself and resolves back to
      // the same order. Mirrors playlist_swap_positions for identical positions.
      if (uris.length === n && uris.every((uri, i) => uri === rows[i].uri)) {
        return emit(rf, `Move is a no-op: the resulting order is unchanged (target position ${args.to_position} → slot ${t + 1}, block ${start}–${start + count - 1}); no write was issued.`, {
          ok: true,
          no_op: true,
          playlist: p.id,
          playlist_name: p.name,
          start,
          count,
          to_position: args.to_position,
          items: n,
          dry_run: args.dry_run,
        });
      }
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const prose = [
        `Move items ${start}–${start + count - 1} to original position ${args.to_position}:`,
        `  block: ${block.map(rowLabel).join(' | ')}`,
        ...renderRows(moved, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        start,
        count,
        to_position: args.to_position,
        items: n,
        order: orderBudget.value,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('move block', plName(p), prose), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Moved ${count} item(s) in "${plName(p)}" (start ${start} → position ${args.to_position}).\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #425 playlist_swap_positions
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_swap_positions',
    'Swap the items at two 1-based positions — e.g. flip tracks 3 and 7. Positions may be any '
      + 'two distinct slots in the playlist. Written as one atomic replace. '
      + 'Quota: 2 GETs + 1 PUT.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to edit, as ID or spotify:playlist: URI'), 'playlist'),
      position_a: positionSchema('one', 'First position'),
      position_b: positionSchema('one', 'Second position'),
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      const n = rows.length;
      if (args.position_a > n || args.position_b > n) {
        return emit(rf, `Positions ${args.position_a}/${args.position_b} out of range for "${plName(p)}" (${n} item(s)).`, {
          ok: false,
          items: n,
        });
      }
      if (args.position_a === args.position_b) {
        return emit(rf, 'position_a and position_b are identical — nothing to swap.', { ok: true, no_op: true, items: n });
      }
      const a = args.position_a - 1;
      const b = args.position_b - 1;
      const swapped = [...rows];
      [swapped[a], swapped[b]] = [swapped[b], swapped[a]];
      const uris = swapped.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const prose = [
        `Swap positions ${args.position_a} ↔ ${args.position_b} in "${plName(p)}":`,
        `  ${args.position_a}: ${rowLabel(rows[a])} → ${rowLabel(rows[b])}`,
        `  ${args.position_b}: ${rowLabel(rows[b])} → ${rowLabel(rows[a])}`,
        ...renderRows(swapped, max),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        position_a: args.position_a,
        position_b: args.position_b,
        items: n,
        order: orderBudget.value,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('swap positions', plName(p), prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Swapped positions ${args.position_a} ↔ ${args.position_b} in "${plName(p)}".\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #426 playlist_dedupe_advanced
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_dedupe_advanced',
    'Remove duplicate items from a playlist under the `match_by` rule the other duplicate tools use: '
      + '`uri` (exact copies, the default), `name_artist` (same name and credited artists, catching a '
      + 're-add of the same song from a different release), or `name` (same title only). Choose '
      + 'keep-first or keep-last. Written as one atomic replace. Quota: 2 GETs + 1 PUT. '
      + 'See the duplicate-matching vocabulary in SPEC section 4.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to dedupe, as ID or spotify:playlist: URI'), 'playlist'),
      keep: z.enum(['first', 'last']).optional().default('first').describe('Which occurrence to keep. Default first'),
      match_by: DuplicateMatchByParam,
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      // #885: one key function, so `groups` here is the same number
      // find_duplicates_in_playlist reports for the same rule. This tool used
      // to carry its own `match_by: uri|name` enum with a bare-name key that
      // no other tool used, and reported no group count at all.
      const matchBy = resolveMatchBy(args).matchBy;
      const { kept, removed, groups } = dedupeItems(
        rows.map((r) => ({ ...r, artistNames: r.artists })),
        matchBy,
        args.keep,
      );
      const finalRows = kept;
      const uris = finalRows.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const removedBudget = budgetedArray(removed.map((r) => r.uri), max, 'removed');
      const prose = [
        `Dedupe "${plName(p)}" (match by ${matchBy}, keep ${args.keep}):`,
        `  ${removed.length} duplicate(s) in ${groups} group(s) would be removed, ${finalRows.length} item(s) kept.`,
        ...(removed.length > 0 ? ['', 'Removed:', ...renderRows(removed, max, '✗')] : []),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        match_by: matchBy,
        keep: args.keep,
        removed: removedBudget.value,
        removed_count: removed.length,
        duplicate_groups: groups,
        kept_count: finalRows.length,
        order: orderBudget.value,
        ...removedBudget.disclosure,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('dedupe', plName(p), prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Deduped "${plName(p)}": removed ${removed.length} duplicate(s), ${finalRows.length} item(s) kept.\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #427 playlist_remove_artist
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_remove_artist',
    'Remove every track by one artist from a playlist. The reference is matched against every credited '
      + 'artist id AND artist name (case-insensitive), so an id, a spotify:artist: URI, an '
      + 'open.spotify.com URL and a plain name all work; `include_featured=false` narrows that to the '
      + 'primary artist. The same rule and the same `include_featured` are used by '
      + 'playlist_exclude_artists, playlist_keep_only and playlist_artist_heat, so they agree on the '
      + 'track count. See the artist-matching vocabulary in SPEC section 4. '
      + 'Shows exactly what would go. Quota: 2 GETs + 1 PUT when committing.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to edit, as ID or spotify:playlist: URI'), 'playlist'),
      artist: z
        .string()
        .describe('Artist name (case-insensitive) or artist ID / spotify:artist: URI'),
      include_featured: IncludeFeaturedParam,
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      // #885: the shared matcher. This tool used to branch on whether the
      // reference *looked* like an id — id-shaped meant compare ids only,
      // anything else compare names only — so a reference that was both (a
      // numeric artist name) matched nothing, and a valid id was never tried
      // against the credit names.
      const reference = classifyArtistReference(args.artist);
      const matches = (r: OpRow): boolean =>
        trackMatchesArtist(
          r.artists.map((name, index) => ({ name, id: r.artistIds[index] })),
          reference,
          args.include_featured,
        ).matched;
      const kept = rows.filter((r) => !matches(r));
      const removed = rows.filter(matches);
      const uris = kept.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const removedBudget = budgetedArray(removed.map((r) => r.uri), max, 'removed');
      const label = reference.id ?? `"${args.artist}"`;
      const prose = [
        `Remove ${label} from "${plName(p)}":`,
        `  ${removed.length} track(s) would be removed, ${kept.length} kept.`,
        ...(removed.length > 0 ? ['', 'Removed:', ...renderRows(removed, max, '✗')] : []),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        artist: reference.id ?? args.artist,
        artist_matched_by: reference.form,
        include_featured: args.include_featured,
        removed_count: removed.length,
        kept_count: kept.length,
        removed_uris: removedBudget.value,
        order: orderBudget.value,
        ...removedBudget.disclosure,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('remove artist', plName(p), prose.slice(1)), payload);
      }
      if (removed.length === 0) {
        // #885: a zero-match result has to be attributable. Before, an id-shaped
        // reference that matched nothing and a name that matched nothing
        // produced the same sentence, and the caller could not tell a genuine
        // absence from a reference compared against the wrong field.
        return emit(
          rf,
          `No tracks by ${label} found in "${plName(p)}" — matched on ${reference.form === 'name' ? 'credited artist name' : 'artist id'}, `
            + `${args.include_featured ? 'every credit' : 'primary credit only'}. Playlist unchanged.`,
          { ...payload, no_op: true },
        );
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Removed ${removed.length} track(s) by ${label} from "${plName(p)}".\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #428 playlist_keep_artist
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_keep_artist',
    'Inverse filter: keep ONLY tracks by one artist in a playlist and drop everything else. The '
      + 'reference is matched against every credited artist id AND artist name (case-insensitive), so an '
      + 'id, a spotify:artist: URI, an open.spotify.com URL and a plain name all work; '
      + '`include_featured=false` narrows that to the primary artist. Same rule and same '
      + '`include_featured` as playlist_remove_artist, so the two agree on the track count. '
      + 'Optionally keep podcast episodes too (they have no artist). One atomic replace. '
      + 'Quota: 2 GETs + 1 PUT. See the artist-matching vocabulary in SPEC section 4.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to edit, as ID or spotify:playlist: URI'), 'playlist'),
      artist: z.string().describe('Artist name (case-insensitive) or artist ID / spotify:artist: URI'),
      include_featured: IncludeFeaturedParam,
      keep_episodes: z
        .boolean()
        .optional()
        .default(false)
        .describe('Also keep podcast episodes (they have no artist). Default false'),
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      const reference = classifyArtistReference(args.artist);
      const label = reference.id ?? `"${args.artist}"`;
      const byArtist = (r: OpRow): boolean =>
        trackMatchesArtist(
          r.artists.map((name, index) => ({ name, id: r.artistIds[index] })),
          reference,
          args.include_featured,
        ).matched;
      const kept = rows.filter((r) => byArtist(r) || (args.keep_episodes && r.kind === 'episode'));
      const removed = rows.filter((r) => !kept.includes(r));
      const uris = kept.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const prose = [
        `Keep only ${label} in "${plName(p)}":`,
        `  ${kept.length} track(s) kept, ${removed.length} removed${args.keep_episodes ? ' (episodes kept)' : ''}.`,
        ...(kept.length > 0 ? ['', 'Kept:', ...renderRows(kept, max)] : []),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        artist: reference.id ?? args.artist,
        artist_matched_by: reference.form,
        include_featured: args.include_featured,
        kept_count: kept.length,
        removed_count: removed.length,
        order: orderBudget.value,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('keep artist', plName(p), prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `"${plName(p)}" now holds only ${kept.length} item(s) (kept ${label}).\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #429 playlist_filter_runtime
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_filter_runtime',
    'Keep only items whose duration falls inside a window (e.g. min_sec 120 → drop intros/interludes; '
      + 'max_sec 360 → drop 6-minute epics). At least one bound required. One atomic replace. '
      + 'Quota: 2 GETs + 1 PUT.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to filter, as ID or spotify:playlist: URI'), 'playlist'),
      min_sec: z.number().int().min(0).optional().describe('Minimum duration in seconds'),
      max_sec: z.number().int().min(1).optional().describe('Maximum duration in seconds'),
      dry_run: DryRunDefault,
      include_full_order: IncludeFullOrder,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      if (args.min_sec === undefined && args.max_sec === undefined) {
        return emit(rf, 'Provide min_sec, max_sec, or both.', { ok: false });
      }
      if (args.min_sec !== undefined && args.max_sec !== undefined && args.min_sec > args.max_sec) {
        return emit(rf, `min_sec (${args.min_sec}) is greater than max_sec (${args.max_sec}).`, { ok: false });
      }
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertPlaylistReadWhole(p);
      assertRewritable(p);
      const rows = toRows(p.items);
      const inWindow = (r: OpRow): boolean =>
        r.durationMs !== null &&
        (args.min_sec === undefined || r.durationMs >= args.min_sec * 1000) &&
        (args.max_sec === undefined || r.durationMs <= args.max_sec * 1000);
      const kept = rows.filter(inWindow);
      const removed = rows.filter((r) => !inWindow(r));
      const totalMs = kept.reduce((s, r) => s + (r.durationMs ?? 0), 0);
      const uris = kept.map((r) => r.uri);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const orderBudget = budgetedArray(uris, max, 'items', args.include_full_order);
      const removedBudget = budgetedArray(removed.map((r) => r.uri), max, 'removed');
      const window = [
        args.min_sec !== undefined ? `≥ ${msToClock(args.min_sec * 1000)}` : null,
        args.max_sec !== undefined ? `≤ ${msToClock(args.max_sec * 1000)}` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      const prose = [
        `Filter "${plName(p)}" to duration ${window}:`,
        `  ${kept.length} item(s) kept (runtime ${msToClock(totalMs)}), ${removed.length} removed.`,
        ...(removed.length > 0 ? ['', 'Removed:', ...renderRows(removed, max, '✗')] : []),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        min_sec: args.min_sec ?? null,
        max_sec: args.max_sec ?? null,
        kept_count: kept.length,
        removed_count: removed.length,
        kept_runtime_ms: totalMs,
        removed_uris: removedBudget.value,
        order: orderBudget.value,
        ...removedBudget.disclosure,
        ...orderBudget.disclosure,
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        return emit(rf, describeDryRun('runtime filter', plName(p), prose.slice(1)), payload);
      }
      const res = await atomicReplace(client, p, uris);
      return emit(
        rf,
        `Filtered "${plName(p)}": ${kept.length} item(s) kept (runtime ${msToClock(totalMs)}), ${removed.length} removed.\n`
          + batchSummary(uris.length, uris),
        { ...payload, dry_run: false, requests: res.requests, snapshot_id: res.snapshot_id ?? null },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #430 playlist_chunk_preview
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_chunk_preview',
    'Read-only pagination preview: how a playlist splits into write-sized chunks (the 100-URI '
      + 'replace limit) or any custom size — per-chunk position ranges, first/last items, and '
      + 'item counts. Plan batched edits before running them. Quota: 2 GETs.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to preview, as ID or spotify:playlist: URI'), 'playlist'),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(100)
        .describe('Items per chunk to simulate. Default 100 (the atomic-replace limit)'),
      // #883: the only 1-based parameter named `offset` in the surface. It kept
      // that name from #110, which standardised parameter NAMES; the base was
      // out of scope there, so every other offset in this server is 0-based and
      // this one silently is not. Naming it `offset` and numbering it from 1 is
      // the exact trap #883 describes, so the base sentence is now mandatory on
      // it like on every other position.
      offset: positionSchema('one', 'Item position to start the first chunk at', { defaultValue: 1 }),
      chunks_to_show: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(5)
        .describe('How many chunks to detail. Default 5'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      const rows = toRows(p.items);
      const start = Math.min(args.offset, Math.max(rows.length, 1));
      const total = rows.slice(start - 1).length;
      const chunkCount = total === 0 ? 0 : Math.ceil(total / args.page_size);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const shown = Math.min(args.chunks_to_show, chunkCount, max);
      const lines: string[] = [];
      for (let c = 0; c < shown; c++) {
        const from = start + c * args.page_size;
        const to = Math.min(from + args.page_size - 1, start + total - 1);
        const first = rows[from - 1];
        const last = rows[to - 1];
        lines.push(
          `  chunk ${c + 1}: positions ${from}–${to} (${to - from + 1} items) — ` +
            `first "${rowLabel(first)}" / last "${rowLabel(last)}"`,
        );
      }
      if (chunkCount > shown) lines.push(`  … ${chunkCount - shown} more chunk(s) not shown.`);
      const prose = [
        `Chunk preview for "${plName(p)}" (page_size ${args.page_size}, offset ${start}):`,
        `  ${rows.length} item(s) total → ${chunkCount} chunk(s).`,
        ...(lines.length > 0 ? ['', ...lines] : ['  (nothing to preview)']),
      ];
      return emit(rf, prose.join('\n'), {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        items: rows.length,
        offset: start,
        page_size: args.page_size,
        chunk_count: chunkCount,
        chunks: Array.from({ length: shown }, (_, c) => {
          const from = start + c * args.page_size;
          const to = Math.min(from + args.page_size - 1, start + total - 1);
          return { first_position: from, last_position: to, items: to - from + 1 };
        }),
        chunks_total: chunkCount,
        chunks_returned: shown,
        chunks_withheld: chunkCount - shown,
        chunks_truncated: chunkCount > shown,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #431 playlist_diff
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_diff',
    'Compare two playlists: what is only in A, only in B, and in both — plus whether the shared '
      + 'tracks appear in the same relative order. Read-only. Quota: 4 GETs.',
    {
      ...PlaylistPairFields,
      ...sharedListFields,
    },
    async (args) => {
      const input = resolvePlaylistInput(args, { kind: 'pair', aliases: [['playlist_a_id', 'playlist_b_id']] });
      const [playlistA, playlistB] = input.values;
      const rf = args.response_format;
      const a = await loadPlaylistFull(client, playlistA);
      const b = await loadPlaylistFull(client, playlistB);
      const rowsA = toRows(a.items);
      const rowsB = toRows(b.items);
      const setA = new Map<string, OpRow>();
      rowsA.forEach((r) => { if (r.uri) setA.set(r.uri, r); });
      const setB = new Map<string, OpRow>();
      rowsB.forEach((r) => { if (r.uri) setB.set(r.uri, r); });
      const onlyA = rowsA.filter((r) => r.uri && !setB.has(r.uri));
      const onlyB = rowsB.filter((r) => r.uri && !setA.has(r.uri));
      const common = rowsA.filter((r) => r.uri && setB.has(r.uri));
      const orderB = rowsB.filter((r) => r.uri && setA.has(r.uri)).map((r) => r.uri);
      const sameOrder = common.map((r) => r.uri).join('|') === orderB.join('|');
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const onlyABudget = budgetedArray(onlyA.map((r) => r.uri), max, 'only_in_a');
      const onlyBBudget = budgetedArray(onlyB.map((r) => r.uri), max, 'only_in_b');
      const prose = [
        `Diff "${plName(a)}" (${rowsA.length}) vs "${plName(b)}" (${rowsB.length}):`,
        `  common: ${common.length} · only in A: ${onlyA.length} · only in B: ${onlyB.length}`,
        `  shared tracks in same relative order: ${sameOrder ? 'yes' : 'no'}`,
        ...(onlyA.length > 0 ? ['', `Only in "${plName(a)}":`, ...renderRows(onlyA, max, 'A')] : []),
        ...(onlyB.length > 0 ? ['', `Only in "${plName(b)}":`, ...renderRows(onlyB, max, 'B')] : []),
      ];
      const payload = {
        ok: true,
        playlist_a: { id: a.id, name: a.name, items: rowsA.length },
        playlist_b: { id: b.id, name: b.name, items: rowsB.length },
        common_count: common.length,
        only_in_a: onlyABudget.value,
        only_in_b: onlyBBudget.value,
        ...onlyABudget.disclosure,
        ...onlyBBudget.disclosure,
        same_order: sameOrder,
      };
      return emit(rf, withPlaylistInputNote(prose.join('\n'), input), withPlaylistInputMetadata(payload, input));
    },
  );

  // -----------------------------------------------------------------------
  // #432 playlist_history
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_history',
    'List local backup snapshots (from backup_library): filename, created timestamp, per-snapshot counts.',
    {
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const files = await listSnapshotFiles();
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const view = truncateItems(files, max);
      const rows: SnapshotSummary[] = [];
      for (const file of view.items) {
        try {
          const snap = await readSnapshot(file);
          rows.push({
            file,
            created: snap._meta?.created ?? null,
            playlists: snap._meta?.counts?.playlists ?? snap.playlists.length,
            playlistItems: snap._meta?.counts?.playlist_items ?? 0,
            likedTracks: snap._meta?.counts?.liked_tracks ?? snap.liked_tracks.length,
          });
        } catch {
          rows.push({ file, created: null, playlists: -1, playlistItems: -1, likedTracks: -1 });
        }
      }
      const prose = [
        `Backup snapshots in ${backupDir()}: ${files.length} file(s).`,
        ...(rows.length > 0
          ? [
              '',
              ...rows.map(
                (r) =>
                  `  • ${r.file} — created ${r.created ?? '?'} · ${r.playlists < 0 ? 'unreadable' : `${r.playlists} playlists`}`
                    + `${r.playlists >= 0 ? ` / ${r.playlistItems} items / ${r.likedTracks} liked tracks` : ''}`,
              ),
              view.footer ? `  (${view.footer})` : '',
            ].filter(Boolean)
          : ['  (none yet — run backup_library to create one)']),
      ];
      return emit(rf, prose.join('\n'), {
        ok: true,
        backup_dir: backupDir(),
        snapshot_count: files.length,
        snapshots: rows.map((r) => ({
          file: r.file,
          created: r.created,
          playlists: r.playlists,
          playlist_items: r.playlistItems,
          liked_tracks: r.likedTracks,
        })),
        snapshots_total: files.length,
        snapshots_returned: rows.length,
        snapshots_withheld: files.length - rows.length,
        snapshots_truncated: files.length > rows.length,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #433 playlist_snapshot_detail
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_snapshot_detail',
    'Inspect one playlist inside a local backup snapshot: its item_count as recorded plus the '
      + 'full item list (truncated by max_results). Read-only, no API calls.',
    {
      backup_file: z.string().describe('Snapshot file name, e.g. backup-2026-08-28-1.json (see playlist_history)'),
      playlist_name: z
        .string()
        .describe('Playlist name inside the snapshot (exact match first, then case-insensitive substring)'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const snap = await readSnapshot(args.backup_file);
      const row = findSnapshotPlaylist(snap, args.backup_file, args.playlist_name);
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const pseudoRows: OpRow[] = row.items.map((it) => ({
        uri: it.uri,
        name: it.name,
        kind: 'track',
        durationMs: null,
        addedAt: '',
        artists: [],
        artistIds: [],
        album: null,
      }));
      const itemBudget = budgetedArray(row.items, max);
      const prose = [
        `"${untrusted(row.name)}" in snapshot ${args.backup_file}:`,
        `  recorded item_count: ${row.item_count ?? row.items.length} · items stored: ${row.items.length}`,
        '',
        ...renderRows(pseudoRows, max),
      ];
      return emit(rf, prose.join('\n'), {
        ok: true,
        backup_file: args.backup_file,
        playlist: row.uri,
        playlist_name: row.name,
        recorded_item_count: row.item_count,
        items_stored: row.items.length,
        items: itemBudget.value,
        ...itemBudget.disclosure,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #434 playlist_clone_snapshot
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_clone_snapshot',
    'Restore a playlist from a local backup snapshot as a NEW playlist (never overwrites the '
      + 'live one — clone, don\'t clobber). Items restore by URI; catalog-removed items are '
      + 'skipped by Spotify automatically. The result records the snapshot path, the date the file '
      + 'declares, and the use made of it (consent_note; no confirmation gate). '
      + 'Quota: 0 GETs + create + chunked adds.',
    {
      backup_file: z.string().describe('Snapshot file name, e.g. backup-2026-08-28-1.json (see playlist_history)'),
      playlist_name: z.string().describe('Playlist name inside the snapshot to clone'),
      new_name: z.string().optional().describe('Name for the new playlist. Default "<name> (restored YYYY-MM-DD)"'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const snap = await readSnapshot(args.backup_file);
      const row = findSnapshotPlaylist(snap, args.backup_file, args.playlist_name);
      const uris = row.items.map((it) => it.uri).filter(Boolean);
      const name = args.new_name ?? `${row.name} (restored ${formatDateStamp()})`;
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const pseudoRows: OpRow[] = row.items
        .filter((it) => it.uri)
        .map((it) => ({
          uri: it.uri,
          name: it.name,
          kind: 'track' as const,
          durationMs: null,
          addedAt: '',
          artists: [],
          artistIds: [],
          album: null,
        }));
      const itemBudget = budgetedArray(uris, max);
      // #1422: `name` and `row.name` are both third-party — the snapshot
      // recorded whatever the playlist was called. The purpose sentence names
      // both, and it is rendered in TWO channels: `provenance`/`consent_note` in
      // `structuredContent`, and `provenanceNote` in the prose. Marking the
      // string at construction would put markers in the payload a programmatic
      // consumer reads, which `untrusted()` forbids, so the sentence is a
      // function of its marking and only the PROSE copy is marked.
      const purpose = (mark: (s: string) => string): string =>
        `create a NEW Spotify playlist "${mark(name)}" holding the ${uris.length} item(s) this local library `
        + 'snapshot records for the playlist ' + `"${mark(row.name)}" — the live playlist is not read or modified`;
      // #708: the snapshot is a library backup file, so the declared date is
      // `_meta.created`. A file predating the schema that stamps it declares
      // none, and the record names the reason instead of borrowing the mtime.
      const provenanceBase = {
        source: {
          kind: 'library_snapshot' as const,
          path: join(backupDir(), args.backup_file),
          items: uris.length,
          ...declaredCreationDate(snap._meta, 'created', '_meta.created'),
        },
        purpose: purpose((s) => s),
      };
      const prov = (consent: WriteProvenance['consent']): WriteProvenance => ({ ...provenanceBase, consent });
      const consent = prov({
        state: 'not_requested',
        because: args.dry_run
          ? 'dry_run=true — nothing was written and no confirmation was requested'
          : 'this tool asks for no confirmation: the write is the single explicit request the caller already made, and no prompt is issued before it',
      });
      const payload = {
        ok: true,
        backup_file: args.backup_file,
        source_playlist: row.name,
        new_name: name,
        items: uris.length,
        uris: itemBudget.value,
        ...itemBudget.disclosure,
        dry_run: args.dry_run,
        ...consentFields(consent),
      };
      if (args.dry_run) {
        // `describeDryRun` delimits both its target and every change, so the
        // raw `name` here is already marked on the way out.
        return emit(rf, describeDryRun('clone from snapshot', `new playlist "${name}"`, [
          ...provenancePromptLines(provenanceBase),
          `Create "${name}" with ${uris.length} item(s) from snapshot ${args.backup_file}:`,
          ...renderRows(pseudoRows, max),
        ]), payload);
      }
      const created = await createPlaylist(client, name, args.public ?? false, `Restored from snapshot ${args.backup_file}`);
      const add = uris.length > 0 ? await addUrisChunked(client, created, uris) : { requests: 0 };
      return emit(
        rf,
        `Cloned "${untrusted(row.name)}" from snapshot ${args.backup_file} into new playlist ${created} `
          + `("${untrusted(name)}", ${uris.length} item(s), ${add.requests} add request(s)).\n`
          // The PROSE copy of the sentence is the marked one; the payload copy
          // in `consent_fields` above keeps the raw names.
          + `#708 ${provenanceNote({ ...consent, purpose: purpose((s) => untrusted(s)) })}`,
        { ...payload, dry_run: false, playlist_id: created, requests: add.requests },
      );
    },
  );

  // -----------------------------------------------------------------------
  // #435 playlist_changelog
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_changelog',
    'Diff ONE playlist across two backup snapshots (older → newer): tracks added, removed, and '
      + 'kept — plus whether the kept tracks were reordered. The "what changed since last week" '
      + 'view. Read-only, no API calls.',
    {
      backup_file_a: z.string().describe('OLDER snapshot file name (baseline)'),
      backup_file_b: z.string().describe('NEWER snapshot file name (comparison)'),
      playlist_name: z.string().describe('Playlist name to compare (exact first, then substring)'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const snapA = await readSnapshot(args.backup_file_a);
      const snapB = await readSnapshot(args.backup_file_b);
      const rowA = findSnapshotPlaylist(snapA, args.backup_file_a, args.playlist_name);
      const rowB = findSnapshotPlaylist(snapB, args.backup_file_b, args.playlist_name);
      // Multiset semantics, not set membership: gaining or losing one copy of a
      // duplicated URI is a real changelog entry, so counts are compared per URI.
      const rowsA: SnapTrackRow[] = rowA.items.map((it) => ({ uri: it.uri, name: it.name, added_at: null }));
      const rowsB: SnapTrackRow[] = rowB.items.map((it) => ({ uri: it.uri, name: it.name, added_at: null }));
      const diff = diffTrackLists(rowsA, rowsB);
      const added = diff.added.map((r) => r.uri);
      const removed = diff.removed.map((r) => r.uri);
      // Kept = the occurrences both sides share; the surplus copies are exactly
      // the added/removed rows the diff already reported.
      const removedRows = new Set(diff.removed);
      const addedRows = new Set(diff.added);
      const keptA = rowsA.filter((r) => !removedRows.has(r)).map((r) => r.uri);
      const keptB = rowsB.filter((r) => !addedRows.has(r)).map((r) => r.uri);
      const reordered = keptA.join('|') !== keptB.join('|');
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const asRows = (uris: readonly string[], names: Map<string, string>): OpRow[] =>
        uris.map((u) => ({
          uri: u,
          name: names.get(u) ?? u,
          kind: 'track' as const,
          durationMs: null,
          addedAt: '',
          artists: [],
          artistIds: [],
          album: null,
        }));
      const nameMap = new Map<string, string>();
      for (const p of [...snapA.playlists, ...snapB.playlists]) {
        for (const it of p.items) nameMap.set(it.uri, it.name);
      }
      const addedBudget = budgetedArray(added.map((u) => ({ uri: u, name: nameMap.get(u) ?? u })), max, 'added');
      const removedBudget = budgetedArray(removed.map((u) => ({ uri: u, name: nameMap.get(u) ?? u })), max, 'removed');
      const prose = [
        `Changelog for "${untrusted(rowA.name)}" — ${args.backup_file_a} → ${args.backup_file_b}:`,
        `  ${rowA.items.length} → ${rowB.items.length} items · +${added.length} added / -${removed.length} removed / ${keptA.length} kept`,
        reordered ? '  kept tracks were REORDERED between snapshots.' : '  kept tracks kept their relative order.',
        ...(added.length > 0 ? ['', 'Added:', ...renderRows(asRows(added, nameMap), max, '+')] : []),
        ...(removed.length > 0 ? ['', 'Removed:', ...renderRows(asRows(removed, nameMap), max, '-')] : []),
      ];
      return emit(rf, prose.join('\n'), {
        ok: true,
        playlist: rowA.uri,
        playlist_name: rowA.name,
        baseline_file: args.backup_file_a,
        comparison_file: args.backup_file_b,
        items_before: rowA.items.length,
        items_after: rowB.items.length,
        added: addedBudget.value,
        removed: removedBudget.value,
        ...addedBudget.disclosure,
        ...removedBudget.disclosure,
        kept_count: keptA.length,
        reordered,
      });
    },
  );

  // -----------------------------------------------------------------------
  // #436 playlist_pair_check
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_pair_check',
    'Pairwise relationship report for two playlists: sizes, overlap, Jaccard similarity, and '
      + 'sampled candidates from each side that the other lacks (for merging or splitting '
      + 'decisions). Read-only. Quota: 4 GETs.',
    {
      ...PlaylistPairFields,
      ...sharedListFields,
    },
    async (args) => {
      const input = resolvePlaylistInput(args, { kind: 'pair', aliases: [['playlist_a_id', 'playlist_b_id']] });
      const [playlistA, playlistB] = input.values;
      const rf = args.response_format;
      const a = await loadPlaylistFull(client, playlistA);
      const b = await loadPlaylistFull(client, playlistB);
      const rowsA = toRows(a.items).filter((r) => r.uri);
      const rowsB = toRows(b.items).filter((r) => r.uri);
      const setA = new Set(rowsA.map((r) => r.uri));
      const setB = new Set(rowsB.map((r) => r.uri));
      const overlap = rowsA.filter((r) => setB.has(r.uri));
      const onlyA = rowsA.filter((r) => !setB.has(r.uri));
      const onlyB = rowsB.filter((r) => !setA.has(r.uri));
      const union = setA.size + setB.size - overlap.length;
      const jaccard = union === 0 ? 1 : overlap.length / union;
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const onlyABudget = budgetedArray(onlyA.map((r) => r.uri), max, 'only_in_a');
      const onlyBBudget = budgetedArray(onlyB.map((r) => r.uri), max, 'only_in_b');
      const prose = [
        `Pair check "${plName(a)}" (${rowsA.length}) ↔ "${plName(b)}" (${rowsB.length}):`,
        `  overlap ${overlap.length} · Jaccard ${jaccard.toFixed(3)} · only-A ${onlyA.length} · only-B ${onlyB.length}`,
        ...(onlyA.length > 0 ? ['', `"${plName(a)}" lacks (from B):`, ...renderRows(onlyA, max, '→')] : []),
        ...(onlyB.length > 0 ? ['', `"${plName(b)}" lacks (from A):`, ...renderRows(onlyB, max, '→')] : []),
      ];
      const payload = {
        ok: true,
        playlist_a: { id: a.id, name: a.name, items: rowsA.length },
        playlist_b: { id: b.id, name: b.name, items: rowsB.length },
        overlap_count: overlap.length,
        only_in_a: onlyABudget.value,
        only_in_b: onlyBBudget.value,
        ...onlyABudget.disclosure,
        ...onlyBBudget.disclosure,
        jaccard: Number(jaccard.toFixed(4)),
      };
      return emit(rf, withPlaylistInputNote(prose.join('\n'), input), withPlaylistInputMetadata(payload, input));
    },
  );

  // -----------------------------------------------------------------------
  // #437 playlist_balance
  // -----------------------------------------------------------------------
  server.tool(
    'playlist_balance',
    'Split a playlist into N balanced new playlists: sequential chunks (part 1 = first third, …) '
      + 'or interleave (round-robin deal, so every part samples the whole span). Creates N new '
      + 'playlists; the source is left untouched. The span is what the read returned: a playlist '
      + 'larger than the fetch-all cap (SPOTIFY_MCP_FETCH_ALL_CAP) is only partly covered, and the '
      + 'response says so via truncated/rows_read/reported_total. Quota: 2 GETs + N creates + chunked adds.',
    {
      playlist_id: spotifyRef(z.string().describe('Playlist to split, as ID or spotify:playlist: URI'), 'playlist'),
      parts: z.number().int().min(2).max(10).describe('How many playlists to create (2–10)'),
      strategy: z
        .enum(['sequential', 'interleave'])
        .optional()
        .default('interleave')
        .describe('sequential = contiguous chunks in order; interleave = round-robin deal. Default interleave'),
      name_prefix: z
        .string()
        .optional()
        .describe('Name prefix for the new playlists. Default "<source name> — Part"'),
      public: PublicFlag,
      dry_run: DryRunDefault,
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format;
      const p = await loadPlaylistFull(client, args.playlist_id);
      assertRewritable(p);
      const rows = toRows(p.items);
      const n = rows.length;
      // #1388: the coverage of what is about to be split, computed BEFORE the
      // early return so the branch that refuses a split cannot state the
      // playlist's size as a number it never read. `items` is gone rather than
      // redefined: a caller that saw `items: 500` here had no way to know it
      // was the cap, and adding a second count beside `items` would have kept
      // two ways to read the same wrong claim.
      //
      // #1423: the two fields are named for the convention, not for this tool.
      // `rows_read` / `reported_total` is the repo-wide pair for "rows a
      // bounded walk returned" beside "the collection's own reported size" —
      // merge_playlists and remove_unavailable_playlist_items use it, and
      // take_playlist_snapshot uses the same `reported_total`. This tool
      // shipped `items_read` / `items_total`, which put a fourth spelling on
      // the wire and made `items_read` mean two unrelated things (here,
      // playlist item rows; on listening_streaks, listening-history entries).
      // `items_total` was worse than a duplicate name: it is a RELEASED key on
      // fifteen sibling tools, where `budgetedArray` emits it to say what a
      // per-call `max_results` display cap withheld — a different mechanism
      // entirely. Both names here were unreleased, so the rename costs no
      // caller anything and separates the two mechanisms.
      const coverage = describeSplitCoverage(p, n);
      const scope = {
        rows_read: n,
        reported_total: typeof p.total === 'number' ? p.total : null,
        truncated: p.truncated,
        // Named only when they mean something: a whole read was not capped, so
        // a `fetch_all_cap` on it would read as though the cap bound the walk.
        ...(p.truncated ? { truncated_by_cap: p.truncatedByCap, fetch_all_cap: p.cap } : {}),
      };
      if (n < args.parts) {
        const size = p.truncated
          ? `only ${n} of ${typeof p.total === 'number' ? p.total : 'an unknown number of'} item(s) could be read`
          : `has ${n} item(s)`;
        return emit(
          rf,
          `${coverage ? `${coverage}\n` : ''}"${plName(p)}" ${size} — fewer than the ${args.parts} parts requested.`,
          { ok: false, ...scope },
        );
      }
      const prefix = args.name_prefix ?? `${p.name ?? 'Playlist'} — Part`;
      const buckets: OpRow[][] = Array.from({ length: args.parts }, () => []);
      if (args.strategy === 'sequential') {
        const base = Math.floor(n / args.parts);
        const rem = n % args.parts;
        let at = 0;
        for (let i = 0; i < args.parts; i++) {
          const size = base + (i < rem ? 1 : 0);
          buckets[i] = rows.slice(at, at + size);
          at += size;
        }
      } else {
        rows.forEach((r, i) => buckets[i % args.parts].push(r));
      }
      const max = resolveMaxResults(args.max_results, getConfig().maxItems);
      const bucketBudgets = buckets.map((b) => budgetedArray(b.map((r) => r.uri), max));
      const names = buckets.map((_, i) => `${prefix} ${i + 1}`);
      // The disclosure leads, in the preview as well as the commit: a dry run
      // that says "would affect 500 items" for a 600-row playlist is the same
      // false count as a commit, one step earlier, and the caller commits on
      // the plan. It sits above `describeDryRun`'s own header rather than
      // inside its change list, so it is not elided as one long change line.
      const prose = [
        ...buckets.map(
          (b, i) => `  "${untrusted(names[i])}": ${b.length} item(s), runtime ${msToClock(b.reduce((s, r) => s + (r.durationMs ?? 0), 0))}`,
        ),
        ...buckets.flatMap((b, i) => [``, `Part ${i + 1}:`, ...renderRows(b, max)]),
      ];
      const payload = {
        ok: true,
        playlist: p.id,
        playlist_name: p.name,
        parts: args.parts,
        strategy: args.strategy,
        ...scope,
        names,
        buckets: bucketBudgets.map((b) => b.value),
        bucket_totals: bucketBudgets.map((b) => b.total),
        bucket_items_returned: bucketBudgets.map((b) => b.returned),
        bucket_items_withheld: bucketBudgets.map((b) => b.withheld),
        bucket_items_truncated: bucketBudgets.map((b) => b.truncated),
        dry_run: args.dry_run,
      };
      if (args.dry_run) {
        const plan = describeDryRun('balance split', plName(p), prose);
        return emit(rf, coverage ? `${coverage}\n${plan}` : plan, payload);
      }
      const created: string[] = [];
      let requests = 0;
      for (let i = 0; i < args.parts; i++) {
        const id = await createPlaylist(client, names[i], args.public ?? false, `Part ${i + 1} of ${args.parts} (from ${p.name ?? p.id})`);
        created.push(id);
        const add = buckets[i].length > 0 ? await addUrisChunked(client, id, buckets[i].map((r) => r.uri)) : { requests: 0 };
        requests += 1 + add.requests;
      }
      const summary = [
        ...(coverage ? [coverage] : []),
        `Split "${plName(p)}" into ${args.parts} new playlists${p.truncated ? ' (a partial split — see above)' : ''}:`,
        ...buckets.map((b, i) => `  • "${untrusted(names[i])}" (${created[i]}): ${b.length} item(s)`),
      ].join('\n');
      return emit(rf, summary, { ...payload, dry_run: false, playlist_ids: created, requests });
    },
  );
}
