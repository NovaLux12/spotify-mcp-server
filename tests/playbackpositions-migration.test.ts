/**
 * #846 — the three playback-position stores, consolidated.
 *
 * ## What is actually under test
 *
 * The migration's contract is LOSSLESSNESS plus IDEMPOTENCE plus a loud
 * refusal. Each of those is a claim that is easy to state and easy to fake:
 * a test that seeds a store, runs the migration and asserts "some records
 * exist" would pass against a migration that silently dropped two thirds of
 * them. So every test here starts from a REAL legacy fixture — files written
 * in the exact three shapes the shipped writers produced, including the fields
 * the flatteners do not model — and asserts on the SURVIVING RECORDS, not on
 * a count.
 *
 * The three shapes, and what each contributes that the others do not:
 *
 * | origin          | source file                          | unique fields                      |
 * |-----------------|--------------------------------------|------------------------------------|
 * | `playback_state`| playback-ext.json `states`          | `context`, `shuffle`, `repeat`, note |
 * | `checkpoint`    | exhaust2-playback.json `checkpoints` | `note`, auto id `cp-…`             |
 * | `bookmark`      | backups/playback-bookmark-*.json     | `label`, `device_name`, file-per-record |
 *
 * ## Hermeticity
 *
 * `import './helpers/hermetic.js'` is the FIRST statement, before any import
 * of server code, because the store paths resolve through `os.homedir()` and
 * this test's whole subject is writing to them. Every store is additionally
 * relocated by an explicit `SPOTIFY_MCP_*` override into a `mkdtemp` root, so
 * the test is doubly fenced: even a path bug that ignored the overrides would
 * land in the temp home, never the developer's real `~/.spotify-mcp`.
 */
import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPlaybackExtTools } from '../src/tools/playbackext.js';
import {
  findPosition,
  listPositions,
  loadPositionStore,
  migratePlaybackPositions,
  newPositionRecord,
  positionsFile,
  putPosition,
  removePosition,
  SidecarUnreadableError,
  recordFromBookmark,
  recordFromCheckpoint,
  recordFromState,
  type PlaybackPositionRecord,
} from '../src/tools/playbackpositions.js';
import type { SpotifyClient } from '../src/client.js';

// ---------------------------------------------------------------------------
// the legacy fixture: the three real shapes
// ---------------------------------------------------------------------------

/**
 * A `states` entry as `save_playback_state` wrote it (#197/#833). The
 * `context`/`shuffle_state`/`repeat_state` fields are the ones the #833 restore
 * path depends on, and `queue`/`disallows` are the ones no flattener models —
 * they are here so the "nothing is lost" assertion has something to bite on.
 */
const LEGACY_STATE = {
  name: 'evening',
  saved_at: '2026-08-27T20:00:00.000Z',
  note: 'before the album ended',
  playback: {
    is_playing: true,
    progress_ms: 185_000,
    shuffle_state: true,
    repeat_state: 'context',
    item: { uri: 'spotify:track:abc', name: 'Abc', type: 'track' },
    context: { type: 'album', uri: 'spotify:album:alb1' },
    device: { id: 'dev1', name: 'Kitchen', volume_percent: 42 },
    // Not modelled by the canonical record. Present so a test can prove the
    // verbatim `legacy` copy is what preserves them.
    queue: { currently_playing: { uri: 'spotify:track:abc' } },
    disallows: { pausing: false, resuming: true },
  },
};

/** A `checkpoints` entry as `checkpoint_playback` wrote it (#375). */
const LEGACY_CHECKPOINT = {
  id: 'cp-2026-08-27T21:05',
  saved_at: '2026-08-27T21:05:00.000Z',
  note: 'car ride',
  playback: {
    is_playing: true,
    progress_ms: 30_000,
    shuffle_state: false,
    repeat_state: 'off',
    item: { uri: 'spotify:track:t01', name: 'T01', type: 'track' },
    context: { type: 'playlist', uri: 'spotify:playlist:pl1' },
    device: { id: 'dev2', name: 'Car', volume_percent: 55 },
  },
};

/** A `playback-bookmark-*.json` file as `capture_playback_position` wrote it (#223). */
const LEGACY_BOOKMARK = {
  id: '2026-08-27T21-55-00-000Z',
  captured_at: '2026-08-27T21:55:00.000Z',
  label: 'morning',
  device_id: 'dev3',
  device_name: 'Phone',
  track_uri: 'spotify:track:t02',
  track_name: 'T02',
  position_ms: 90_000,
  is_playing: true,
  context_uri: 'spotify:album:alb2',
};

let dir: string;
let extFile: string;
let exhaustFile: string;
let backupsDir: string;

/** Write the three legacy stores, each populated with the shape above. */
async function seedLegacyStores(): Promise<void> {
  await writeFile(
    extFile,
    JSON.stringify({ states: { evening: LEGACY_STATE }, devicePresets: {}, sessions: {}, smartRules: {} }, null, 2),
    'utf8',
  );
  await writeFile(
    exhaustFile,
    JSON.stringify({ muteMemory: {}, episodeBookmarks: {}, checkpoints: { 'cp-2026-08-27T21:05': LEGACY_CHECKPOINT } }, null, 2),
    'utf8',
  );
  await writeFile(join(backupsDir, 'playback-bookmark-2026-08-27T21-55-00-000Z.json'), JSON.stringify(LEGACY_BOOKMARK, null, 2), 'utf8');
  // A file that is NOT a bookmark. The migration must ignore it, not choke on
  // it and not rename it.
  await writeFile(join(backupsDir, 'backup-2026-08-27-1.json'), '{}', 'utf8');
}

function allRecords(): PlaybackPositionRecord[] {
  return Object.values(loadCache);
}

let loadCache: Record<string, PlaybackPositionRecord> = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'positions-846-'));
  extFile = join(dir, 'playback-ext.json');
  exhaustFile = join(dir, 'exhaust2-playback.json');
  backupsDir = join(dir, 'backups');
  await mkdir(backupsDir, { recursive: true });
  process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = extFile;
  process.env.SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE = exhaustFile;
  process.env.SPOTIFY_MCP_BACKUP_DIR = backupsDir;
  loadCache = {};
});

afterEach(async () => {
  delete process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE;
  delete process.env.SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE;
  delete process.env.SPOTIFY_MCP_BACKUP_DIR;
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. losslessness — the primary claim
// ---------------------------------------------------------------------------

describe('#846 the migration preserves every record', () => {
  it('imports all three legacy shapes with their data intact', async () => {
    await seedLegacyStores();
    const result = await migratePlaybackPositions();

    assert.equal(result.refused, null, 'a readable legacy set must not be refused');
    assert.equal(result.imported, 3, `expected one record per legacy shape, got: ${JSON.stringify(result.per_source)}`);
    assert.deepEqual(result.per_source, { playback_state: 1, checkpoint: 1, bookmark: 1 });
    assert.deepEqual(result.unreadable, [], 'nothing was unreadable');

    loadCache = (await loadPositionStore()).positions;
    const records = allRecords();
    assert.equal(records.length, 3);

    // --- the playback_state record ---
    const state = records.find((r) => r.origin === 'playback_state');
    assert.ok(state, 'the states entry must survive');
    assert.equal(state.id, 'evening');
    assert.equal(state.label, 'evening');
    assert.equal(state.note, 'before the album ended');
    assert.equal(state.saved_at, '2026-08-27T20:00:00.000Z');
    assert.equal(state.track_uri, 'spotify:track:abc');
    assert.equal(state.track_name, 'Abc');
    assert.equal(state.position_ms, 185_000);
    assert.equal(state.is_playing, true);
    assert.equal(state.context_uri, 'spotify:album:alb1');
    assert.equal(state.device_id, 'dev1');
    assert.equal(state.device_name, 'Kitchen');
    assert.equal(state.shuffle_state, true);
    assert.equal(state.repeat_state, 'context');
    assert.equal(state.origin_id, 'evening');

    // The fields NO flattener models. This is the assertion that would fail if
    // the migration dropped the verbatim copy and relied on the flatten.
    const legacyState = state.legacy as typeof LEGACY_STATE;
    assert.equal(legacyState.playback.queue.currently_playing.uri, 'spotify:track:abc', 'the unmodelled queue field must survive');
    assert.equal(legacyState.playback.disallows.resuming, true, 'the unmodelled disallows field must survive');
    assert.deepEqual(legacyState, LEGACY_STATE, 'the whole original record is kept verbatim');

    // --- the checkpoint record ---
    const cp = records.find((r) => r.origin === 'checkpoint');
    assert.ok(cp, 'the checkpoint must survive');
    assert.equal(cp.id, 'cp-2026-08-27T21:05');
    assert.equal(cp.note, 'car ride');
    assert.equal(cp.track_uri, 'spotify:track:t01');
    assert.equal(cp.position_ms, 30_000);
    assert.equal(cp.context_uri, 'spotify:playlist:pl1');
    assert.equal(cp.device_name, 'Car');
    assert.equal(cp.label, null, 'a checkpoint has no label field; it must not borrow one');
    assert.deepEqual(cp.legacy, LEGACY_CHECKPOINT);

    // --- the bookmark record ---
    const bm = records.find((r) => r.origin === 'bookmark');
    assert.ok(bm, 'the bookmark must survive');
    assert.equal(bm.id, '2026-08-27T21-55-00-000Z');
    assert.equal(bm.label, 'morning');
    assert.equal(bm.track_uri, 'spotify:track:t02');
    assert.equal(bm.position_ms, 90_000);
    assert.equal(bm.device_name, 'Phone');
    assert.equal(bm.saved_at, '2026-08-27T21:55:00.000Z');
    // "never recorded shuffle" is not "recorded as off" — conflating them
    // would make a migrated bookmark claim something the source never said.
    assert.equal(bm.shuffle_state, null, 'a bookmark never recorded shuffle; that is unknown, not false');
    assert.equal(bm.repeat_state, null);
    assert.deepEqual(bm.legacy, LEGACY_BOOKMARK);
  });

  it('leaves the OTHER keys of playback-ext.json untouched', async () => {
    await writeFile(
      extFile,
      JSON.stringify({
        states: { evening: LEGACY_STATE },
        devicePresets: { dev1: { label: 'Kitchen', volume: 42 } },
        sessions: { s1: { id: 's1', tags: ['focus'], created_at: '2026-08-01T00:00:00.000Z', tracks: ['spotify:track:x'] } },
        smartRules: { r1: { source: 'top_tracks' } },
        showDigest: { playlist_id: 'pl9', last_saved: '2026-08-20T00:00:00.000Z' },
      }),
      'utf8',
    );
    await migratePlaybackPositions();

    const onDisk = JSON.parse(await readFile(extFile, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.deepEqual(onDisk.devicePresets, { dev1: { label: 'Kitchen', volume: 42 } }, 'device presets are a different feature and must not be erased');
    assert.deepEqual(onDisk.sessions, { s1: { id: 's1', tags: ['focus'], created_at: '2026-08-01T00:00:00.000Z', tracks: ['spotify:track:x'] } });
    assert.deepEqual(onDisk.smartRules, { r1: { source: 'top_tracks' } });
    assert.deepEqual(onDisk.showDigest, { playlist_id: 'pl9', last_saved: '2026-08-20T00:00:00.000Z' });
    assert.deepEqual(onDisk.states, { evening: LEGACY_STATE }, 'the legacy states map is read, not consumed');
  });

  it('renames the legacy bookmark file rather than deleting it', async () => {
    await seedLegacyStores();
    const result = await migratePlaybackPositions();

    const before = (await readdir(backupsDir)).sort();
    assert.deepEqual(before, ['backup-2026-08-27-1.json', 'playback-bookmark-2026-08-27T21-55-00-000Z.json.migrated']);
    // The bytes are still there and still parse. A migration that destroyed the
    // original would be unrecoverable if the flattening were ever found wrong.
    const preserved = JSON.parse(await readFile(join(backupsDir, 'playback-bookmark-2026-08-27T21-55-00-000Z.json.migrated'), 'utf8'));
    assert.deepEqual(preserved, LEGACY_BOOKMARK, 'the renamed file still holds the original bytes');
    assert.equal(result.bookmark_files_marked.length, 1);
  });

  it('writes the canonical store 0600', async () => {
    await seedLegacyStores();
    await migratePlaybackPositions();
    assert.equal((await stat(positionsFile())).mode & 0o777, 0o600, 'a position store is personal listening history');
  });
});

// ---------------------------------------------------------------------------
// 2. idempotence — the second acceptance criterion
// ---------------------------------------------------------------------------

describe('#846 the migration is idempotent', () => {
  it('a second run imports zero and changes no record', async () => {
    await seedLegacyStores();
    const first = await migratePlaybackPositions();
    assert.equal(first.imported, 3);

    const afterFirst = (await loadPositionStore()).positions;
    const snapshot = JSON.stringify(afterFirst);

    const second = await migratePlaybackPositions();
    assert.equal(second.imported, 0, 'a re-run must import nothing');
    // TWO, not three: the bookmark's file was renamed to `.migrated` by the
    // first run, so there is no longer a legacy bookmark FILE to re-read. It
    // is counted in neither bucket because it is not a candidate any more —
    // the record it produced is in `total`, which is what the assertion below
    // checks. Asserting 3 here would be asserting that a file which no longer
    // exists gets read.
    assert.equal(second.already_present, 2, 'the two still-present map sources are recognised as already imported');
    assert.equal(second.total, 3, 'a re-run must not duplicate or lose a record');
    assert.deepEqual(second.per_source, { playback_state: 0, checkpoint: 0, bookmark: 0 });
    assert.equal(second.refused, null);
    assert.deepEqual(second.bookmark_files_marked, [], 'there is no bookmark file left to mark');

    const afterSecond = (await loadPositionStore()).positions;
    assert.equal(JSON.stringify(afterSecond), snapshot, 'the store must be byte-identical after a re-run');
  });

  it('a third run is still zero, and the store never grows', async () => {
    await seedLegacyStores();
    await migratePlaybackPositions();
    await migratePlaybackPositions();
    const third = await migratePlaybackPositions();
    assert.equal(third.imported, 0);
    assert.equal(third.total, 3);
  });

  it('a record added to a legacy store AFTER a run is picked up by the next one', async () => {
    // The property a boolean `migrated: true` marker would destroy: marking
    // the store as done is not the same as having imported what is in it now.
    await seedLegacyStores();
    await migratePlaybackPositions();

    const later = { ...LEGACY_CHECKPOINT, id: 'cp-2026-08-28T09:00', saved_at: '2026-08-28T09:00:00.000Z' };
    const store = JSON.parse(await readFile(exhaustFile, 'utf8')) as Record<string, unknown>;
    (store.checkpoints as Record<string, unknown>)['cp-2026-08-28T09:00'] = later;
    await writeFile(exhaustFile, JSON.stringify(store, null, 2), 'utf8');

    const again = await migratePlaybackPositions();
    assert.equal(again.imported, 1, 'a checkpoint saved after the first run is a new record');
    assert.equal(again.already_present, 2, 'the two map sources that are still there');
    assert.equal(again.total, 4);
  });

  it('does not overwrite a canonical record whose id a legacy record would claim', async () => {
    // The collision the collision-avoiding `placeRecord` exists for. The
    // pre-existing record is written BY HAND, not produced by the migration,
    // so the assertion is not comparing the code under test against itself.
    //
    // `states` and `positions` live in the SAME file, so this is ONE write: an
    // earlier draft wrote the two keys in sequence and the second write
    // silently erased the first, which made the test pass for the wrong
    // reason — it was asserting against a store whose pre-existing record had
    // never been written at all.
    await writeFile(
      extFile,
      JSON.stringify(
        {
          states: { evening: LEGACY_STATE },
          positions: {
            evening: {
              id: 'evening', label: null, note: null, saved_at: '2026-09-01T00:00:00.000Z',
              device_id: null, device_name: null, track_uri: 'spotify:track:keep', track_name: 'Keep',
              position_ms: 7, is_playing: true, context_uri: null, shuffle_state: null, repeat_state: null,
              origin: 'bookmark', origin_id: 'pre-existing', legacy: null,
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await migratePlaybackPositions();
    assert.equal(result.refused, null);
    assert.equal(result.imported, 1);
    const positions = (await loadPositionStore()).positions;
    assert.equal(positions.evening.track_uri, 'spotify:track:keep', 'the pre-existing record keeps its id');
    assert.equal(positions['evening-2'].track_uri, 'spotify:track:abc', 'the imported record is placed beside it, not on top');
    assert.equal(positions['evening-2'].origin_id, 'evening');
  });
});

// ---------------------------------------------------------------------------
// 3. loud refusal — the corruption half
// ---------------------------------------------------------------------------

describe('#846 a store it cannot read is refused, not clobbered', () => {
  it('refuses and writes nothing when the checkpoint store is unparseable', async () => {
    await seedLegacyStores();
    const before = await readFile(extFile, 'utf8');
    await writeFile(exhaustFile, '{not json', 'utf8');

    const result = await migratePlaybackPositions();
    assert.ok(result.refused, 'an unparseable legacy store must refuse');
    assert.match(result.refused, /exhaust2-playback\.json/);
    assert.match(result.refused, /nothing was written/);
    assert.equal(result.imported, 0, 'a refusal must not partially apply');

    // The readable half is still readable, and NOTHING was rewritten — a
    // partial import would leave two disagreeing stores.
    assert.equal(await readFile(extFile, 'utf8'), before, 'the canonical store must be untouched on a refusal');
  });

  it('preserves the unparseable bytes and leaves the original in place', async () => {
    await seedLegacyStores();
    await writeFile(exhaustFile, '{not json', 'utf8');
    const result = await migratePlaybackPositions();

    assert.match(result.refused!, /preserved at/, 'the refusal must name where the bytes went');
    const preserved = /preserved at (\S+)/.exec(result.refused!);
    assert.ok(preserved, `refusal did not name a preserved path: ${result.refused}`);
    assert.equal(await readFile(preserved[1], 'utf8'), '{not json');
    assert.equal(await readFile(exhaustFile, 'utf8'), '{not json', 'the original is left where it was');
  });

  it('refuses when the CANONICAL store is unparseable, even with a healthy legacy set', async () => {
    await seedLegacyStores();
    await writeFile(extFile, '{"positions": {oops', 'utf8');

    const result = await migratePlaybackPositions();
    assert.ok(result.refused, 'an unreadable canonical store must refuse before touching anything else');
    assert.equal(result.imported, 0);
    // The whole point: it did not decide the store was empty and start fresh.
    assert.equal(await readFile(extFile, 'utf8'), '{"positions": {oops');
  });

  it('refuses when the canonical store holds a positions key of the wrong shape', async () => {
    await seedLegacyStores();
    await writeFile(extFile, JSON.stringify({ positions: ['not', 'a', 'map'] }), 'utf8');

    const result = await migratePlaybackPositions();
    assert.ok(result.refused, 'a well-formed JSON file with a wrong-shaped key is still unreadable');
    assert.match(result.refused!, /not a JSON object/);
    assert.equal(result.imported, 0);
  });

  it('a missing legacy store is the first-run case, not a failure', async () => {
    // Nothing seeded at all: no playback-ext.json, no exhaust2, no backups dir.
    const result = await migratePlaybackPositions();
    assert.equal(result.refused, null);
    assert.equal(result.imported, 0);
    assert.equal(result.already_present, 0);
    assert.equal(result.total, 0);
  });

  it('names an unreadable bookmark and still migrates the rest', async () => {
    // One bad file among good ones is NOT fatal: refusing would strand the
    // other 399 records over a single typo. It is named with its reason and
    // counted separately, so no total can be read as "everything migrated".
    await seedLegacyStores();
    await writeFile(join(backupsDir, 'playback-bookmark-broken.json'), '{oops', 'utf8');
    await writeFile(
      join(backupsDir, 'playback-bookmark-good.json'),
      JSON.stringify({ ...LEGACY_BOOKMARK, id: 'good', captured_at: '2026-08-27T22:00:00.000Z' }),
      'utf8',
    );

    const result = await migratePlaybackPositions();
    assert.equal(result.refused, null, 'one bad file must not abort the whole migration');
    // FOUR, not three: `seedLegacyStores` already contributed a bookmark, so
    // the good one is a second. Counting them here rather than hardcoding the
    // number keeps the assertion tied to what was seeded.
    assert.equal(result.imported, 4, 'states + checkpoint + the seeded bookmark + the good bookmark');
    assert.equal(result.unreadable.length, 1);
    assert.equal(result.unreadable[0].origin, 'bookmark');
    assert.equal(result.unreadable[0].origin_id, 'broken');
    assert.ok(result.unreadable[0].reason.length > 0, 'an unreadable record must carry a reason');

    const positions = (await loadPositionStore()).positions;
    assert.ok(positions.good, 'the readable bookmark still migrated');
    // The bad file was NOT renamed, so the user can still repair it.
    assert.ok(
      (await readdir(backupsDir)).includes('playback-bookmark-broken.json'),
      'an unmigrated file must stay exactly where it was',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. the flatteners, in isolation
// ---------------------------------------------------------------------------

describe('#846 the flatteners', () => {
  it('tolerate a null playback state rather than throwing', () => {
    // A checkpoint saved with nothing playing stores `playback: null`. The
    // flattener must produce a record, not a TypeError — a throw here would
    // abort a migration over one empty record and lose every other one.
    const record = recordFromCheckpoint('cp-empty', { id: 'cp-empty', saved_at: '2026-08-27T21:05:00.000Z', playback: null });
    assert.equal(record.track_uri, null);
    assert.equal(record.position_ms, 0);
    assert.equal(record.is_playing, false);
    assert.equal(record.shuffle_state, null);
    assert.equal(record.origin, 'checkpoint');
  });

  it('tolerate a non-object record', () => {
    for (const make of [recordFromCheckpoint, recordFromState, recordFromBookmark]) {
      const record = make('k', null);
      assert.equal(record.id, 'k');
      assert.equal(record.position_ms, 0);
      assert.equal(record.track_uri, null);
    }
  });

  it('two origins can mint the same id, which is why placement is collision-checked', () => {
    // `recordFromState` takes its id from the record's own `name` field, and
    // `recordFromBookmark` from its `id` field — so a caller who names a slot
    // the way another tool auto-names a bookmark produces two records with one
    // id. The collision is real, and the assertion that they really collide
    // comes FIRST so this test cannot pass while proving nothing.
    const a = recordFromState('ignored-key', { ...LEGACY_STATE, name: 'shared' });
    const b = recordFromBookmark('ignored-key', { ...LEGACY_BOOKMARK, id: 'shared' });
    assert.equal(a.id, 'shared');
    assert.equal(b.id, 'shared');
    // `origin_id` is the key the record had in ITS OWN store, so these two
    // genuinely share it — which is why the idempotency key is the PAIR and
    // not the id alone. A dedupe keyed on `origin_id` would silently drop one
    // of these two records on a re-run; keyed on the pair, neither is skipped.
    assert.equal(a.origin_id, b.origin_id);
    assert.notEqual(a.origin, b.origin, 'the origin is what distinguishes them');
  });
});

// ---------------------------------------------------------------------------
// 5. the tools over the migrated store
// ---------------------------------------------------------------------------

function toolHarness() {  const registered: { name: string; schema: unknown; handler: (a: unknown) => Promise<unknown> }[] = [];
  const server = {
    tool(n: string, _d: string, sch: unknown, h: (a: unknown) => Promise<unknown>) {
      registered.push({ name: n, schema: sch, handler: h });
    },
  } as unknown as McpServer;
  registerPlaybackExtTools(server, { tokenFile: 'tokens.json' } as unknown as SpotifyClient);
  return {
    registered,
    async invoke(name: string, args: Record<string, unknown> = {}) {
      const t = registered.find((r) => r.name === name);
      assert.ok(t, `${name} is not registered`);
      return t.handler(z.object(t.schema as never).parse(args)) as Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown> }>;
    },
  };
}

describe('#846 the tools read the canonical record', () => {
  it('migrate_playback_positions is registered', () => {
    const h = toolHarness();
    assert.ok(h.registered.map((r) => r.name).includes('migrate_playback_positions'));
  });

  it('migrate_playback_positions reports a refusal rather than claiming success', async () => {
    await seedLegacyStores();
    await writeFile(exhaustFile, '{oops', 'utf8');
    const h = toolHarness();

    const out = await h.invoke('migrate_playback_positions');
    assert.match(out.content[0].text, /refused/i);
    const echo = out.structuredContent as Record<string, unknown>;
    assert.equal(echo.imported, 0);
    assert.ok(echo.refused);
  });
});

// ---------------------------------------------------------------------------
// 6. the reader/writer API the four thin wrappers are built on
//
// `list_playback_bookmarks`, `resume_playback_position`,
// `delete_playback_bookmark` and `continue_last` are thin wrappers over the
// three functions below, so these are where their behaviour is pinned. The
// acceptance criterion in the issue is the first test: a checkpoint saved by
// `checkpoint_playback` shows up in the bookmark listing and resolves by the
// id that tool handed out.
// ---------------------------------------------------------------------------

describe('#846 the canonical store is listable and addressable', () => {
  it('a migrated checkpoint is listed alongside a bookmark and a snapshot, and resolves by its legacy id', async () => {
    await seedLegacyStores();
    await migratePlaybackPositions();

    const records = await listPositions();
    const origins = records.map((r) => r.origin).sort();
    assert.deepEqual(origins, ['bookmark', 'checkpoint', 'playback_state'],
      'all three legacy stores must be visible through one listing');

    // The issue's criterion: the checkpoint is findable by the id
    // `checkpoint_playback` printed, without learning a new id scheme.
    const found = await findPosition('cp-2026-08-27T21:05');
    assert.ok(found, 'the checkpoint is addressable by the id its writer reported');
    assert.equal(found!.origin, 'checkpoint');
    assert.equal(found!.track_uri, LEGACY_CHECKPOINT.playback.item.uri);
    assert.equal(found!.position_ms, LEGACY_CHECKPOINT.playback.progress_ms);

    // And the same listing the bookmark tool serves contains it too.
    assert.ok(records.some((r) => r.id === found!.id), 'the checkpoint is in the same listing as the bookmark');
  });

  it('the listing works BEFORE the migration, so no saved position becomes unreachable', async () => {
    await seedLegacyStores();
    // Deliberately no migratePlaybackPositions() call.
    const records = await listPositions();
    const origins = records.map((r) => r.origin).sort();
    assert.deepEqual(origins, ['bookmark', 'checkpoint', 'playback_state'],
      'a pre-migration install must still list every position it has');

    // These two agree, which is what makes the pre-migration fallback safe to
    // merge with the migrated rows: after a migration there is one bookmark
    // record, not two.
    await migratePlaybackPositions();
    const after = await listPositions();
    assert.equal(after.length, 3, 'migrating does not double the listing');
    assert.equal(after.filter((r) => r.origin === 'bookmark').length, 1);
  });

  it('findPosition falls back to a legacy bookmark file, then stops at a real absence', async () => {
    await seedLegacyStores();
    // No migration: the bookmark exists only as a file.
    const fromFile = await findPosition('2026-08-27T21-55-00-000Z');
    assert.ok(fromFile, 'an un-migrated bookmark file is still addressable');
    assert.equal(fromFile!.origin, 'bookmark');
    assert.equal(await findPosition('no-such-position'), null, 'a genuinely absent id is null, not a throw');
  });

  it('putPosition adds a record and keeps the sibling keys the #833 restore path needs', async () => {
    await seedLegacyStores();
    await migratePlaybackPositions();
    const before = JSON.parse(await readFile(extFile, 'utf8')) as Record<string, unknown>;
    assert.ok(before.states, 'the fixture has a states map to protect');

    const placed = await putPosition(newPositionRecord({
      id: 'fresh-1', label: 'morning', note: null, saved_at: '2026-09-27T08:00:00.000Z',
      device_id: 'dev1', device_name: 'Laptop', track_uri: 'spotify:track:xyz',
      track_name: 'Xyz', position_ms: 1234, is_playing: true, context_uri: null,
      shuffle_state: null, repeat_state: null, origin: 'bookmark', origin_id: 'fresh-1',
    }));

    const after = JSON.parse(await readFile(extFile, 'utf8')) as Record<string, unknown>;
    assert.equal((after.positions as Record<string, unknown>).fresh1, undefined);
    assert.ok(after.states, 'states survived the write — restore_playback_state still has its data');
    assert.ok(after.devicePresets, 'devicePresets survived');
    assert.equal(placed.id, 'fresh-1');
    assert.equal((await findPosition('fresh-1'))?.position_ms, 1234);
  });

  it('a writer refuses an unreadable store rather than replacing it with a one-record store', async () => {
    await seedLegacyStores();
    await migratePlaybackPositions();
    const good = await readFile(extFile, 'utf8');
    await writeFile(extFile, '{"positions": {oops', 'utf8');

    await assert.rejects(
      () => putPosition(newPositionRecord({
        id: 'x', label: null, note: null, saved_at: '2026-09-27T08:00:00.000Z',
        device_id: null, device_name: null, track_uri: null, track_name: null,
        position_ms: 0, is_playing: false, context_uri: null, shuffle_state: null,
        repeat_state: null, origin: 'bookmark', origin_id: 'x',
      })),
      SidecarUnreadableError,
      'a store that exists but cannot be read must not be written over',
    );
    // And the bytes are still exactly what the user had, plus the preserved copy.
    const after = await readFile(extFile, 'utf8');
    assert.equal(after, '{"positions": {oops', 'the original file is left in place');
    assert.notEqual(good, after);
    assert.ok(JSON.parse(good).positions, 'the pre-corruption store had records to lose');
  });

  it('removePosition deletes by canonical id or by legacy origin_id, and reports an honest absence', async () => {
    await seedLegacyStores();
    await migratePlaybackPositions();

    const byOrigin = await removePosition('cp-2026-08-27T21:05');
    assert.equal(byOrigin?.origin, 'checkpoint');
    assert.equal(await findPosition('cp-2026-08-27T21:05'), null, 'it is gone by either id');

    const rest = await listPositions();
    assert.equal(rest.length, 2, 'only the checkpoint went');
    assert.equal(await removePosition('cp-2026-08-27T21:05'), null, 'a second delete is null, not a throw');
  });
});
