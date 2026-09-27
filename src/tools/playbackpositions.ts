/**
 * The canonical playback-position record (#846).
 *
 * Three unrelated sidecars each persisted "where was I listening" in their own
 * shape, under their own key scheme, with their own id generator:
 *
 * | store                          | key shape                | id                        | note field |
 * |--------------------------------|--------------------------|---------------------------|------------|
 * | `exhaust2-playback.json`       | `checkpoints` map        | `cp-YYYY-MM-DDTHH:MM`     | `note`     |
 * | `playback-extensions.json`     | `states` map             | the caller's slot name    | `name`     |
 * | `backups/playback-bookmark-*.json` | one file per record  | ISO with `:`/`.` → `-`   | `label`    |
 *
 * Nothing could list them together and a position saved by one tool could not
 * be continued by another. This module owns ONE record shape and the one-time
 * migration that imports all three into it.
 *
 * ## Losslessness is the contract
 *
 * The flattened fields below are what the readers need, but two of the three
 * legacy shapes stored a WHOLE `PlaybackState` object, and flattening it would
 * throw away whatever this module failed to anticipate. So every migrated
 * record keeps its original under `legacy`, verbatim. The migration therefore
 * cannot lose a field even if the flattening is wrong — the wrongness would be
 * visible in the canonical fields while the bytes remain recoverable.
 *
 * ## Idempotency is keyed on provenance, not on a marker file
 *
 * Each record carries `origin` + `origin_id` — the store it came from and the
 * key it had there. A re-run skips any record whose pair is already present,
 * so "run it twice" changes nothing and imports zero, with no separate
 * `migrated: true` flag that could disagree with what is actually in the file.
 * That also means a user who ADDS a bookmark after the migration still gets it
 * picked up by a later run, which a boolean marker would have permanently
 * skipped.
 *
 * ## Reads refuse rather than clobber
 *
 * Every legacy read goes through `loadSidecar`, so an unparseable sidecar is
 * preserved and surfaced. `migratePlaybackPositions` treats that as fatal and
 * writes NOTHING: a half-finished migration that drops the readable records
 * behind an unreadable one is worse than no migration, and the user still has
 * every original file on disk to retry from.
 */
import { chmod, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadSidecar, preserveUnreadableSidecar, SidecarUnreadableError } from '../sidecar.js';
import { storePath } from '../config.js';
import { ownStoreRoots, readLocalFile } from '../paths.js';
import type { PlaybackState } from '../types/spotify.js';

/** Which legacy store a record was imported from, or written by. */
export type PositionOrigin = 'playback_state' | 'checkpoint' | 'bookmark';

/**
 * The one record shape every playback-position tool reads and writes.
 *
 * Every field is present on every record. A caller must not have to test
 * "which of the three stores did this come from" before it can read a
 * position, because that test is the divergence this module exists to remove.
 */
export interface PlaybackPositionRecord {
  /** Canonical, unique within the store. Stable for the life of the record. */
  id: string;
  /** Caller-supplied name/label, where the source had one. */
  label: string | null;
  /** Caller-supplied note, where the source had one. */
  note: string | null;
  /** ISO 8601. Taken from `saved_at` / `captured_at`; `saved_at` is the field name. */
  saved_at: string;
  device_id: string | null;
  device_name: string | null;
  track_uri: string | null;
  track_name: string | null;
  position_ms: number;
  is_playing: boolean;
  context_uri: string | null;
  shuffle_state: boolean | null;
  repeat_state: string | null;
  origin: PositionOrigin;
  /**
   * The key the record had in its source store. Together with `origin` this
   * is the idempotency key: a re-run skips a record whose pair is already
   * present. It is also how a migrated record is found again by the id the
   * tool that created it originally reported.
   */
  origin_id: string;
  /**
   * The source record, verbatim, for records that came from a legacy store.
   * `null` on records this server wrote, which have no legacy form.
   *
   * This is the reason the migration cannot be lossy: the two legacy shapes
   * that stored a full `PlaybackState` keep every field of it here, so a
   * flattening bug costs a reader a default, never the user's data.
   */
  legacy: unknown;
}

export interface PlaybackPositionStore {
  positions: Record<string, PlaybackPositionRecord>;
  /** Set when the file existed but could not be turned into a store (#839). */
  load_error?: string;
  preserved_as?: string | null;
}

/**
 * The canonical store lives inside the playback-extensions sidecar, under its
 * own top-level key.
 *
 * A new key rather than a reuse of `states`: `states` already backs
 * `save_playback_state` / `restore_playback_state` and holds a whole
 * `PlaybackState` object that the #833 restore path reads, so overwriting it
 * with flattened records would be a data-loss bug in its own right. The other
 * four keys in that file (`devicePresets`, `sessions`, `smartRules`,
 * `showDigest`) are untouched by this migration for the same reason.
 */
export function positionsFile(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('playback-extensions', env);
}

/** The bookmarks directory — one JSON file per record, `playback-bookmark-<id>.json`. */
export function bookmarkDir(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('backups', env);
}

const BOOKMARK_PREFIX = 'playback-bookmark-';
const BOOKMARK_SUFFIX = '.json';

function emptyPositionStore(): PlaybackPositionStore {
  return { positions: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositionStore(parsed: unknown): PlaybackPositionStore {
  if (!isPlainObject(parsed)) throw new Error('top level is not a JSON object');
  // `positions` must be an object; the other keys belong to the playback-ext
  // sidecar and are deliberately not validated here — their own module owns
  // them, and re-validating would make this one a second, drifting copy.
  if (parsed.positions !== undefined && !isPlainObject(parsed.positions)) {
    throw new Error('"positions" is not a JSON object');
  }
  return { positions: (parsed.positions ?? {}) as Record<string, PlaybackPositionRecord> };
}

/**
 * Read the canonical store.
 *
 * ENOENT is an empty store. Every other failure preserves the bytes and
 * throws `SidecarUnreadableError` — the shared #839 policy, so this module
 * cannot drift into the silent-empty-store bug the other loaders had.
 */
export async function loadPositionStore(env: NodeJS.ProcessEnv = process.env): Promise<PlaybackPositionStore> {
  return loadSidecar<PlaybackPositionStore>(positionsFile(env), emptyPositionStore, parsePositionStore);
}

/**
 * Persist the canonical store.
 *
 * Rewrites the WHOLE playback-extensions file, so the caller must pass a store
 * that was loaded through `loadPositionStore` — the other four keys ride along
 * untouched in the parsed object rather than being dropped by a partial write.
 */
export async function savePositionStore(
  store: PlaybackPositionStore,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = positionsFile(env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // `load_error`/`preserved_as` describe this call, not store content.
  const { load_error: _e, preserved_as: _p, ...rest } = isPlainObject(raw) ? (raw as Record<string, unknown>) : {};
  const merged = { ...rest, positions: store.positions };
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
}

// ---------------------------------------------------------------------------
// flattening — the three legacy shapes onto the one record
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Pull the fields a `PlaybackState` carries, tolerating a null state. */
function fromPlaybackState(state: PlaybackState | null | undefined): {
  device_id: string | null;
  device_name: string | null;
  track_uri: string | null;
  track_name: string | null;
  position_ms: number;
  is_playing: boolean;
  context_uri: string | null;
  shuffle_state: boolean | null;
  repeat_state: string | null;
} {
  return {
    device_id: str(state?.device?.id),
    device_name: str(state?.device?.name),
    track_uri: str(state?.item?.uri),
    track_name: str(state?.item?.name),
    position_ms: num(state?.progress_ms, 0),
    is_playing: state?.is_playing === true,
    context_uri: str(state?.context?.uri),
    shuffle_state: typeof state?.shuffle_state === 'boolean' ? state.shuffle_state : null,
    repeat_state: str(state?.repeat_state),
  };
}

/** A `checkpoints` entry in `exhaust2-playback.json` (#375). */
export function recordFromCheckpoint(key: string, raw: unknown): PlaybackPositionRecord {
  const cp = isPlainObject(raw) ? raw : {};
  return {
    id: str(cp.id) ?? key,
    label: null,
    note: str(cp.note),
    saved_at: str(cp.saved_at) ?? new Date(0).toISOString(),
    ...fromPlaybackState(cp.playback as PlaybackState | null),
    origin: 'checkpoint',
    origin_id: key,
    legacy: raw,
  };
}

/** A `states` entry in `playback-extensions.json` (#197). */
export function recordFromState(key: string, raw: unknown): PlaybackPositionRecord {
  const snap = isPlainObject(raw) ? raw : {};
  return {
    id: str(snap.name) ?? key,
    label: str(snap.name) ?? key,
    note: str(snap.note),
    saved_at: str(snap.saved_at) ?? new Date(0).toISOString(),
    ...fromPlaybackState(snap.playback as PlaybackState | null),
    origin: 'playback_state',
    origin_id: key,
    legacy: raw,
  };
}

/** One `playback-bookmark-<id>.json` file under the backup dir (#223). */
export function recordFromBookmark(key: string, raw: unknown): PlaybackPositionRecord {
  const bm = isPlainObject(raw) ? raw : {};
  return {
    id: str(bm.id) ?? key,
    label: str(bm.label),
    note: null,
    saved_at: str(bm.captured_at) ?? new Date(0).toISOString(),
    device_id: str(bm.device_id),
    device_name: str(bm.device_name),
    track_uri: str(bm.track_uri),
    track_name: str(bm.track_name),
    position_ms: num(bm.position_ms, 0),
    is_playing: bm.is_playing === true,
    context_uri: str(bm.context_uri),
    // The bookmark shape never recorded shuffle/repeat. `null`, not `false`:
    // "not captured" and "captured as off" are different answers.
    shuffle_state: null,
    repeat_state: null,
    origin: 'bookmark',
    origin_id: key,
    legacy: raw,
  };
}

/**
 * Build a record for something written by this server rather than migrated.
 * Same shape, `legacy: null` because there is no legacy form to keep.
 */
export function newPositionRecord(
  fields: Omit<PlaybackPositionRecord, 'legacy' | 'shuffle_state' | 'repeat_state' | 'is_playing'> &
    Partial<Pick<PlaybackPositionRecord, 'shuffle_state' | 'repeat_state' | 'is_playing' | 'note'>>,
): PlaybackPositionRecord {
  return {
    ...fields,
    is_playing: fields.is_playing ?? false,
    shuffle_state: fields.shuffle_state ?? null,
    repeat_state: fields.repeat_state ?? null,
    legacy: null,
  };
}

// ---------------------------------------------------------------------------
// the migration
// ---------------------------------------------------------------------------

/** A record that could not be read, and why. Never silently dropped. */
export interface UnreadableRecord {
  origin: PositionOrigin;
  origin_id: string;
  reason: string;
}

export interface MigrationResult {
  /** Records added to the canonical store by THIS run. Zero on a re-run. */
  imported: number;
  /** Records already present under the same `origin`+`origin_id`. */
  already_present: number;
  /** How many records each source contributed this run. */
  per_source: Record<PositionOrigin, number>;
  /** Legacy bookmark files renamed to `.migrated` by this run. */
  bookmark_files_marked: string[];
  /**
   * Records that could not be read. They are NOT in `imported` and NOT in
   * `already_present`; they are listed here with a reason so a caller can
   * never read a count that silently excludes them.
   */
  unreadable: UnreadableRecord[];
  /** Total records now in the canonical store, migrated and native. */
  total: number;
  /** Human-readable source of each fatal refusal; null when the run proceeded. */
  refused: string | null;
}

/** The id scheme this module issues for new records. */
export function newPositionId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function provenanceKey(record: Pick<PlaybackPositionRecord, 'origin' | 'origin_id'>): string {
  return `${record.origin}\u0000${record.origin_id}`;
}

/**
 * A stable id that cannot collide with a record already in the store.
 *
 * A legacy record may already occupy the id we would mint, so a plain
 * `positions[id] = record` would silently overwrite it. Appending a counter
 * makes the write a no-conflict operation, and the suffix is only ever reached
 * when a collision was real.
 */
function placeRecord(
  positions: Record<string, PlaybackPositionRecord>,
  record: PlaybackPositionRecord,
): string {
  let id = record.id;
  let n = 1;
  while (Object.hasOwn(positions, id)) {
    n += 1;
    id = `${record.id}-${n}`;
  }
  const placed = { ...record, id };
  positions[id] = placed;
  return id;
}

/**
 * Import every legacy playback-position record into the canonical store.
 *
 * Idempotent, lossless, and refuses rather than partially applying:
 *
 * - A legacy sidecar that exists but cannot be parsed is FATAL. Nothing is
 *   written. The originals are still on disk, so the user can repair and
 *   retry; a run that imported the readable half would instead leave two
 *   disagreeing stores and no way to tell which record lived where.
 * - A missing legacy file is NOT an error. It is the first-run case.
 * - A single unparseable bookmark FILE among many is not fatal either: it is
 *   recorded in `unreadable` with its reason and the other records still
 *   migrate. Aborting a 400-record migration over one bad file would be a
 *   worse outcome than importing 399 and naming the one that did not make it.
 * - Legacy bookmark files are RENAMED to `.migrated`, never unlinked. The
 *   bytes stay on disk; only the name changes, so nothing is destroyed and a
 *   user who wants the old layout back can rename them.
 */
export async function migratePlaybackPositions(env: NodeJS.ProcessEnv = process.env): Promise<MigrationResult> {
  const per_source: Record<PositionOrigin, number> = { playback_state: 0, checkpoint: 0, bookmark: 0 };
  const result: MigrationResult = {
    imported: 0,
    already_present: 0,
    per_source,
    bookmark_files_marked: [],
    unreadable: [],
    total: 0,
    refused: null,
  };

  /**
   * Refuse, reporting NOTHING imported.
   *
   * The counters are zeroed on every refusal because by then the run may
   * already have counted records it staged in memory — the readable states map
   * is processed before the checkpoint file is read. Reporting those counts
   * alongside a refusal would tell the caller records were imported when not
   * a byte was written, which is precisely the "a count that silently lies"
   * failure this repo keeps shipping. A refused run imported zero.
   */
  const refuse = (message: string): MigrationResult => {
    result.refused = message;
    result.imported = 0;
    result.already_present = 0;
    per_source.playback_state = 0;
    per_source.checkpoint = 0;
    per_source.bookmark = 0;
    result.bookmark_files_marked = [];
    return result;
  };

  // Load the canonical store first. If IT is unreadable we cannot even know
  // what is already there, so writing anything would risk a duplicate or an
  // overwrite; refuse before touching a legacy file.
  //
  // This does NOT go through `loadSidecar`, because the migration needs the
  // RAW parsed object as well as the validated view: `states` is a legacy key
  // in this very file, and re-reading it through a second loader could observe
  // a different version of the file than the one about to be rewritten. One
  // read, two views. The #839 preservation policy is applied by hand here so
  // the refusal path behaves exactly like every other sidecar loader's.
  let canonicalRaw: Record<string, unknown>;
  let store: PlaybackPositionStore;
  const canonicalFile = positionsFile(env);
  let canonicalText: string | null;
  try {
    canonicalText = await readLocalFile({ roots: ownStoreRoots(canonicalFile), tool: 'playback positions', target: canonicalFile });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const preservedAs = await preserveUnreadableSidecar(canonicalFile);
      return refuse(`${canonicalFile} could not be read (${describe(err)}); nothing was written${
        preservedAs ? ` and its bytes were preserved at ${preservedAs}` : ''
      }`);
    }
    canonicalText = null;
  }
  if (canonicalText === null) {
    store = emptyPositionStore();
    canonicalRaw = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonicalText);
    } catch (err) {
      const preservedAs = await preserveUnreadableSidecar(canonicalFile);
      return refuse(`${canonicalFile} is not valid JSON (${describe(err)}); nothing was written${
        preservedAs ? ` and its bytes were preserved at ${preservedAs}` : ''
      }`);
    }
    try {
      store = parsePositionStore(parsed);
    } catch (err) {
      const preservedAs = await preserveUnreadableSidecar(canonicalFile);
      return refuse(`${canonicalFile} is not a readable store (${describe(err)}); nothing was written${
        preservedAs ? ` and its bytes were preserved at ${preservedAs}` : ''
      }`);
    }
    canonicalRaw = parsed as Record<string, unknown>;
  }

  const seen = new Set(
    Object.values(store.positions).map((r) => provenanceKey({ origin: r.origin, origin_id: r.origin_id })),
  );

  // --- the two map-shaped sidecars -----------------------------------------
  // The playback-extensions one is the SAME file as the canonical store, so it
  // is read from the bytes already in hand rather than re-read: a second read
  // could observe a different file, and merging the two views is exactly the
  // write-the-wrong-thing bug.
  let stateEntries: Record<string, unknown> | null;
  try {
    stateEntries = mapOf(canonicalRaw, 'states');
  } catch (err) {
    const preservedAs = await preserveUnreadableSidecar(canonicalFile);
    return refuse(`${canonicalFile} holds a "states" that is not a JSON object (${describe(err)}); nothing was written${
      preservedAs ? ` and its bytes were preserved at ${preservedAs}` : ''
    }`);
  }

  const mapSources: Array<{ origin: PositionOrigin; entries: Record<string, unknown> | null; file: string }> = [
    { origin: 'playback_state', entries: stateEntries, file: canonicalFile },
    { origin: 'checkpoint', entries: null, file: storePath('exhaust2-playback', env) },
  ];

  for (const source of mapSources) {
    if (source.entries === null) {
      // A separate file: ENOENT is the first-run case, anything else is fatal.
      let text: string;
      try {
        text = await readLocalFile({ roots: ownStoreRoots(source.file), tool: 'playback positions', target: source.file });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        const preservedAs = await preserveUnreadableSidecar(source.file);
        return refuse(`${source.file} could not be read (${describe(err)}); nothing was written${
          preservedAs ? ` and its bytes were preserved at ${preservedAs}` : ''
        }`);
      }
      try {
        source.entries = mapOf(JSON.parse(text), 'checkpoints');
      } catch (err) {
        const preservedAs = await preserveUnreadableSidecar(source.file);
        return refuse(`${source.file} is not a readable store (${describe(err)}); nothing was written${
          preservedAs ? ` and its bytes were preserved at ${preservedAs}` : ''
        }`);
      }
      if (source.entries === null) continue;
    }
    for (const [key, raw] of Object.entries(source.entries)) {
      const record = source.origin === 'checkpoint' ? recordFromCheckpoint(key, raw) : recordFromState(key, raw);
      const pk = provenanceKey(record);
      if (seen.has(pk)) {
        result.already_present += 1;
        continue;
      }
      seen.add(pk);
      placeRecord(store.positions, record);
      result.imported += 1;
      per_source[source.origin] += 1;
    }
  }

  // --- the one-file-per-record bookmark store ------------------------------
  const dir = bookmarkDir(env);
  let names: string[];
  try {
    names = (await readdir(dir))
      .filter((f) => f.startsWith(BOOKMARK_PREFIX) && f.endsWith(BOOKMARK_SUFFIX))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return refuse(`${dir} could not be listed (${describe(err)}); nothing was written`);
    }
    names = [];
  }

  for (const name of names) {
    const file = join(dir, name);
    const key = name.slice(BOOKMARK_PREFIX.length, -BOOKMARK_SUFFIX.length);
    let parsed: unknown;
    try {
      // Confined to the bookmark directory, regular files only, size-capped —
      // the same #623 guard the live reader uses.
      parsed = JSON.parse(await readLocalFile({ roots: ownStoreRoots(file), tool: 'playback bookmark', target: file }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // gone under us; nothing to migrate
      result.unreadable.push({ origin: 'bookmark', origin_id: key, reason: describe(err) });
      continue;
    }
    const record = recordFromBookmark(key, parsed);
    const pk = provenanceKey(record);
    if (seen.has(pk)) {
      result.already_present += 1;
    } else {
      seen.add(pk);
      placeRecord(store.positions, record);
      result.imported += 1;
      per_source.bookmark += 1;
    }
    // Marked whether it was already present or newly imported: on a re-run the
    // record IS present, and the file still needs to stop being a live
    // bookmark, or the store would keep two sources for one record.
    const marked = `${file}.migrated`;
    try {
      await rename(file, marked);
      result.bookmark_files_marked.push(marked);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        result.unreadable.push({ origin: 'bookmark', origin_id: key, reason: `imported, but the file could not be marked: ${describe(err)}` });
      }
    }
  }

  if (result.imported > 0 || result.bookmark_files_marked.length > 0) {
    await savePositionStore(store, canonicalRaw, env);
  }
  result.total = Object.keys(store.positions).length;
  return result;
}

function mapOf(parsed: unknown, key: string): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) return null;
  const value = parsed[key];
  if (value === undefined) return null;
  if (!isPlainObject(value)) throw new Error(`"${key}" is not a JSON object`);
  return value;
}

/**
 * Ids of the legacy per-file bookmarks, in the same order the old
 * `list_playback_bookmarks` reported them.
 *
 * `bookmarkDir` is `storePath('backups', env)`, which is exactly what
 * `backupDir()` in ./backup.js returns — `backupDir` delegates to
 * `paths.backupRootDir`, which is the same call. The bookmark files have not
 * moved; only the record shape around them is being consolidated.
 */
export function legacyBookmarkPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  // Defensive: ids were generated here, but a caller can craft one that
  // escapes the directory. Sanitising before the join — plus the #623 guard on
  // the read side — is what keeps the path inside the bookmark dir.
  return join(bookmarkDir(env), `${BOOKMARK_PREFIX}${id.replace(/[^A-Za-z0-9._-]/g, '_')}${BOOKMARK_SUFFIX}`);
}

export async function legacyBookmarkIds(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    return (await readdir(bookmarkDir(env)))
      .filter((f) => f.startsWith(BOOKMARK_PREFIX) && f.endsWith(BOOKMARK_SUFFIX))
      .map((f) => f.slice(BOOKMARK_PREFIX.length, -BOOKMARK_SUFFIX.length))
      .sort();
  } catch {
    // ENOENT — no bookmark directory yet, which is a first run, not a fault.
    return [];
  }
}

/**
 * Every position the user has, in the one record shape, WITHOUT requiring the
 * migration to have run.
 *
 * The canonical store is the source of truth. A legacy bookmark file whose
 * `origin_id` is not in the store is appended so the list is still complete on
 * a pre-migration install — a user who has never run the migration must not
 * see their bookmarks disappear from the one tool that lists them. Those rows
 * carry `legacy` and an `origin` of `bookmark`, so they are indistinguishable
 * from migrated ones apart from having no canonical `id` of their own.
 *
 * Records are sorted by `saved_at` because the old listing sorted by filename
 * and the old ids were timestamps, so the two orderings agreed in practice;
 * `saved_at` is the honest sort key for ids that need not be timestamps.
 */
export async function listPositions(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlaybackPositionRecord[]> {
  const store = await loadPositionStore(env);
  const records = Object.values(store.positions);
  const known = new Set(records.map((r) => `${r.origin} ${r.origin_id}`));

  // The two legacy MAPS, for an install that has not migrated. A read failure
  // here is skipped rather than raised: a listing is a read, and refusing to
  // list because one *other* store is corrupt would be a worse answer than a
  // listing with that store's rows missing. `migrate_playback_positions` is
  // where a refusal belongs, and it does name what it could not read.
  for (const [origin, file, key, flatten] of [
    ['playback_state', positionsFile(env), 'states', recordFromState],
    ['checkpoint', storePath('exhaust2-playback', env), 'checkpoints', recordFromCheckpoint],
  ] as const) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readLocalFile({ roots: ownStoreRoots(file), tool: 'playback positions', target: file }));
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const entries = parsed[key];
    if (!isPlainObject(entries)) continue;
    for (const [k, raw] of Object.entries(entries)) {
      if (known.has(`${origin} ${k}`)) continue;
      records.push(flatten(k, raw));
    }
  }

  // And the legacy per-file bookmarks.
  for (const id of await legacyBookmarkIds(env)) {
    if (known.has(`bookmark ${id}`)) continue;
    // One unreadable legacy file must not hide every other bookmark. The
    // migration names it with its reason; the listing just skips it, which is
    // what the pre-#846 reader did too.
    const record = await readLegacyBookmarkFile(id, env);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.saved_at.localeCompare(b.saved_at));
}

/**
 * Read the playback-extensions file ONCE, as both the raw parsed object and
 * the validated record map.
 *
 * Two observations of the same file could disagree — a concurrent writer
 * landing between them would mean the record map said one thing and the
 * preserved sibling keys another, and the write would silently drop a key. So
 * every read-modify-write in this module goes through here, and the writer
 * gets the raw object it needs for the untouched keys from the same read.
 *
 * Refuses the way `loadPositionStore` refuses, for the same reason: a writer
 * must never turn a populated-but-unreadable file into a one-record store.
 */
async function readStoreWithRaw(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: PlaybackPositionStore; raw: unknown }> {
  const file = positionsFile(env);
  let raw: unknown = {};
  try {
    // #623 guard, same roots and caps the sibling sidecar readers use.
    raw = JSON.parse(await readLocalFile({ roots: ownStoreRoots(dirname(file)), tool: 'playback positions', target: file }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT is the FIRST-RUN case and the only one a writer may write over:
    // an absent store is an empty store. Every other failure refuses, and that
    // includes a JSON.parse SyntaxError, which carries no errno at all — a
    // branch keyed on "has a code and is not ENOENT" would read a corrupt file
    // as an empty store and overwrite it with one record, which is the exact
    // silent clobber the shared sidecar policy exists to prevent.
    if (code === 'ENOENT') return { store: emptyPositionStore(), raw: {} };
    const preservedAs = await preserveUnreadableSidecar(file).catch(() => null);
    throw new SidecarUnreadableError(file, describe(err), preservedAs);
  }
  try {
    return { store: parsePositionStore(raw), raw };
  } catch (err) {
    const preservedAs = await preserveUnreadableSidecar(file).catch(() => null);
    throw new SidecarUnreadableError(file, describe(err), preservedAs);
  }
}

/**
 * Add a record to the canonical store, keeping every other key in the
 * playback-extensions file as it found them, and return it as stored (with the
 * id it was actually placed under, which may differ from the one supplied if
 * that id was taken).
 */
export async function putPosition(
  record: PlaybackPositionRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlaybackPositionRecord> {
  const { store, raw } = await readStoreWithRaw(env);
  const id = placeRecord(store.positions, record);
  await savePositionStore(store, raw, env);
  return store.positions[id];
}

/** Remove one record by canonical id or legacy `origin_id`. Returns what went. */
export async function removePosition(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlaybackPositionRecord | null> {
  const { store, raw } = await readStoreWithRaw(env);
  const key = store.positions[id] !== undefined
    ? id
    : Object.keys(store.positions).find((k) => store.positions[k].origin_id === id);
  if (key === undefined) return null;
  const removed = store.positions[key];

  // The legacy copy has to go too, or the delete lies: `listPositions` falls
  // back to the un-migrated source, so removing only the canonical row would
  // leave the position visible in the very listing it was just deleted from.
  // The migration imports but never deletes, so every imported record still
  // has a live original behind it.
  //
  // Legacy FIRST, so a failure there means nothing was deleted at all rather
  // than the canonical copy gone and the legacy one still resurrecting it.
  // For a `playback_state` the legacy map IS the canonical file, so this hands
  // back a `raw` with the `states` entry already dropped — saving the one it
  // read first would silently resurrect the snapshot the user just deleted.
  const nextRaw = await deleteLegacyCopy(removed, raw, env);

  delete store.positions[key];
  await savePositionStore(store, nextRaw, env);
  return removed;
}

/**
 * Drop the pre-migration original of a record, so it cannot be re-listed.
 *
 * Only the ONE key the record came from is touched, in place, and a store that
 * cannot be read refuses rather than being rewritten — a delete must never be
 * the thing that costs the user the rest of a file.
 */
async function deleteLegacyCopy(
  record: PlaybackPositionRecord,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (record.origin === 'bookmark') {
    // `.migrated` files are left alone: the migration only renames, and a
    // second unlink here would destroy a file the store now owns.
    await unlink(legacyBookmarkPath(record.origin_id, env)).catch(() => undefined);
    return raw;
  }
  if (record.origin === 'checkpoint') {
    await deleteFromLegacyMap(storePath('exhaust2-playback', env), 'checkpoints', record.origin_id);
    return raw;
  }
  // `playback_state`: `states` shares the canonical file, so the entry is
  // dropped in the caller's `raw` and rides along in the same write rather
  // than needing a second read-modify-write of one file.
  if (isPlainObject(raw) && isPlainObject(raw.states)) {
    delete raw.states[record.origin_id];
  }
  return raw;
}

/** Delete one key from a legacy map, in place, refusing an unreadable store. */
async function deleteFromLegacyMap(
  file: string,
  key: string,
  originId: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readLocalFile({ roots: ownStoreRoots(file), tool: 'playback positions', target: file }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    const preservedAs = await preserveUnreadableSidecar(file).catch(() => null);
    throw new SidecarUnreadableError(file, describe(err), preservedAs);
  }
  const entries = mapOf(parsed, key);
  if (entries === null || !Object.hasOwn(entries, originId)) return;
  delete entries[originId];
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
}

/**
 * Find a canonical record by the id a tool reported when it created it.
 *
 * Two ids can name the same record: the canonical `id` the migration assigned,
 * and the `origin_id` the legacy store used. Both are accepted, because the
 * whole point of the migration is that an id handed out by
 * `checkpoint_playback` before the migration still resolves afterwards — a
 * caller holding `cp-2026-08-27T21:05` must not have to learn a new scheme to
 * continue the position it saved.
 *
 * The canonical `id` is tried across the whole store first, so an id collision
 * with a legacy `origin_id` cannot shadow a real record.
 *
 * A legacy bookmark FILE is the last resort, so a resume works on an install
 * that has never run the migration. That is the same policy `listPositions`
 * applies, and for the same reason: consolidating the format must not make a
 * position the user already saved unreachable in the meantime.
 */
export async function findPosition(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlaybackPositionRecord | null> {
  const store = await loadPositionStore(env);
  const direct = store.positions[id];
  if (direct) return direct;
  for (const record of Object.values(store.positions)) {
    if (record.origin_id === id) return record;
  }
  return readLegacyBookmarkFile(id, env);
}

/** One legacy bookmark file, flattened, or null if absent/unreadable. */
async function readLegacyBookmarkFile(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlaybackPositionRecord | null> {
  const dir = bookmarkDir(env);
  const file = legacyBookmarkPath(id, env);
  try {
    const raw = JSON.parse(await readLocalFile({ roots: ownStoreRoots(dir), tool: 'playback bookmark', target: file }));
    return { ...recordFromBookmark(id, raw), id };
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code) return `read failed: ${code}`;
  return err instanceof Error ? err.message : String(err);
}

export { SidecarUnreadableError };
