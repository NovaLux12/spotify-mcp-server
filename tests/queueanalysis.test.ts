/**
 * `src/queueanalysis.ts` — the local analyses over one `GET /me/player/queue`
 * read (#847).
 *
 * ## What this module is
 *
 * Eight tools once answered "what is in my queue" from that one endpoint, each
 * with its own request and its own payload. The registrations are gone; the
 * analyses stayed, and `tools/playback.ts` plus `tools/swarm3_playback.ts`
 * compute all of them in ONE pass over ONE read. Nothing here makes a request —
 * every function takes the rows already fetched — which is what lets the
 * one-read contract in SPEC.md be a test rather than a promise.
 *
 * So the whole module is pure and the whole test is direct: no client, no
 * transport, no server. That is the property worth protecting, and the last
 * test in this file protects it.
 *
 * ## The rule every analysis follows: #803
 *
 * A value that could not be read is reported as unreadable with a reason, never
 * coerced into a plausible number. The current track's REMAINING time comes
 * from a SECOND endpoint (`GET /me/player`), so when that read fails the field
 * is `null` with an error beside it, and `estimated_total_wait_ms` is `null`
 * rather than "just the queue runtime" — which would read as "you are already
 * at the last track". Most of the boundaries below are that rule: a `null` that
 * has to stay a `null`, and a `0` that has to stay a `0` because it means
 * something different.
 *
 * Run: node --import tsx --test tests/queueanalysis.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  duplicateAnalysis,
  formatLong,
  formatMs,
  playingRow,
  profileAnalysis,
  queueRows,
  runtimeAnalysis,
  type QueueRow,
} from '../src/queueanalysis.js';
import type { PlaybackState, SpotifyEpisode, SpotifyQueue, SpotifyTrack } from '../src/types/spotify.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function track(overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: 't1',
    name: 'Song',
    uri: 'spotify:track:t1',
    type: 'track',
    duration_ms: 200_000,
    explicit: false,
    artists: [{ id: 'a1', name: 'Artist One', uri: 'spotify:artist:a1' }],
    album: { id: 'al1', name: 'Album One', uri: 'spotify:album:al1', images: [] },
    ...overrides,
  };
}

function episode(overrides: Partial<SpotifyEpisode> = {}): SpotifyEpisode {
  return {
    id: 'e1',
    name: 'Episode',
    uri: 'spotify:episode:e1',
    type: 'episode',
    duration_ms: 3_600_000,
    explicit: false,
    description: '',
    release_date: '2026-01-01',
    show: { id: 's1', name: 'Show One', uri: 'spotify:show:s1' },
    ...overrides,
  };
}

function queue(...items: (SpotifyTrack | SpotifyEpisode)[]): SpotifyQueue {
  return { currently_playing: null, queue: items };
}

/** A row built directly, for the analyses that take rows rather than items. */
function row(position: number, overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    position,
    uri: `spotify:track:r${position}`,
    name: `Row ${position}`,
    subtitle: 'Artist',
    duration_ms: 1000,
    is_episode: false,
    album_name: 'Album',
    show_name: null,
    artist_names: ['Artist'],
    ...overrides,
  };
}

describe('queueRows — normalising the upcoming queue', () => {
  it('returns nothing for an empty, absent or malformed queue', () => {
    assert.deepEqual(queueRows(queue()), []);
    assert.deepEqual(queueRows(null), []);
    assert.deepEqual(queueRows(undefined), []);
    // `currently_playing_type` admits `ad` and `unknown` (#852), so the read is
    // not trusted to always carry a well-formed `queue` array.
    assert.deepEqual(queueRows({ currently_playing: null, queue: undefined } as unknown as SpotifyQueue), []);
  });

  it('numbers the first upcoming row 1, not 0', () => {
    const rows = queueRows(queue(track(), track({ id: 't2', uri: 'spotify:track:t2' })));
    assert.deepEqual(rows.map((r) => r.position), [1, 2]);
  });

  it('describes a track by its artists and album', () => {
    const [row] = queueRows(queue(track({
      artists: [
        { id: 'a1', name: 'A', uri: 'spotify:artist:a1' },
        { id: 'a2', name: 'B', uri: 'spotify:artist:a2' },
      ],
    })));
    assert.equal(row?.subtitle, 'A, B');
    assert.equal(row?.album_name, 'Album One');
    assert.equal(row?.show_name, null);
    assert.equal(row?.is_episode, false);
    assert.deepEqual(row?.artist_names, ['A', 'B']);
  });

  it('describes an episode by its show and claims no artist or album', () => {
    const [row] = queueRows(queue(episode()));
    assert.equal(row?.subtitle, 'Show One');
    assert.equal(row?.show_name, 'Show One');
    assert.equal(row?.album_name, null);
    assert.equal(row?.is_episode, true);
    assert.deepEqual(row?.artist_names, []);
  });

  it('names the unknowns rather than leaving a blank where a person reads a value', () => {
    // A track with no artists at all, and an episode with no show. Both are
    // "present but unreadable", and #803 says report them.
    const [noArtists] = queueRows(queue(track({ artists: [] })));
    assert.equal(noArtists?.subtitle, 'unknown artist');
    const [noShow] = queueRows(queue(episode({ show: undefined as unknown as SpotifyEpisode['show'] })));
    assert.equal(noShow?.subtitle, 'episode');
    assert.equal(noShow?.show_name, null);
  });

  it('types a row by what it carries, not by its `type` field', () => {
    // An ad or an unknown row has no `artists`, so it reads as an episode. The
    // declared `type` is deliberately not consulted.
    const ad = { id: 'x', name: 'Ad', uri: '', type: 'track', duration_ms: 30_000 } as unknown as SpotifyTrack;
    const [row] = queueRows(queue(ad));
    assert.equal(row?.is_episode, true);
    assert.equal(row?.uri, '');
  });

  it('substitutes zero and empty string for a field the read did not carry', () => {
    const bare = { id: 'x', name: 'Bare' } as unknown as SpotifyTrack;
    const [row] = queueRows(queue(bare));
    assert.equal(row?.duration_ms, 0);
    assert.equal(row?.uri, '');
    assert.deepEqual(row?.artist_names, []);
  });
});

describe('playingRow — the playing item, counted in the same vocabulary', () => {
  it('is null when nothing is playing', () => {
    assert.equal(playingRow(null), null);
    assert.equal(playingRow(undefined), null);
  });

  it('carries position 0, which is what keeps it out of the 1-based queue', () => {
    // The retired `queue_profile` counted the playing item as part of the
    // queue. Its replacement has to say which way it counts, or the number
    // changes meaning under a name that used to be right — hence 0, not 1.
    const row = playingRow(track());
    assert.equal(row?.position, 0);
    assert.equal(row?.album_name, 'Album One');
  });
});

describe('formatMs / formatLong', () => {
  it('renders m:ss, and h:mm:ss past the hour', () => {
    assert.equal(formatMs(0), '0:00');
    assert.equal(formatMs(999), '0:00', 'sub-second is not a second');
    assert.equal(formatMs(1_000), '0:01');
    assert.equal(formatMs(59_999), '0:59');
    assert.equal(formatMs(60_000), '1:00');
    assert.equal(formatMs(65_000), '1:05');
    assert.equal(formatMs(3_599_999), '59:59');
    assert.equal(formatMs(3_600_000), '1:00:00');
    assert.equal(formatMs(3_661_000), '1:01:01');
  });

  it('floors at zero rather than rendering a negative clock', () => {
    assert.equal(formatMs(-1), '0:00');
    assert.equal(formatMs(-3_600_000), '0:00');
  });

  it('rounds a long total to the nearest minute, for a number a person reads', () => {
    assert.equal(formatLong(0), '0m');
    assert.equal(formatLong(59_000), '1m');
    assert.equal(formatLong(60_000), '1m');
    assert.equal(formatLong(89_000), '1m', '89s is nearer one minute than two');
    assert.equal(formatLong(90_000), '2m');
    assert.equal(formatLong(3_600_000), '1h 0m');
    assert.equal(formatLong(5_400_000), '1h 30m');
    assert.equal(formatLong(3_660_000), '1h 1m');
  });
});

describe('runtimeAnalysis — draining the queue', () => {
  const rows = [row(1, { duration_ms: 1000 }), row(2, { duration_ms: 2000 }), row(3, { duration_ms: 3000 })];

  function state(item: SpotifyTrack | SpotifyEpisode | null, progress: number | null): PlaybackState {
    return {
      is_playing: item !== null,
      progress_ms: progress,
      shuffle_state: false,
      repeat_state: 'off',
      timestamp: 0,
      item,
      currently_playing_type: item === null ? 'track' : item.type,
      context: null,
    };
  }

  it('adds up the rows', () => {
    const a = runtimeAnalysis(rows, state(track(), 0));
    assert.equal(a.upcoming_count, 3);
    assert.equal(a.total_runtime_ms, 6000);
    assert.equal(a.total_runtime_formatted, '0m');
    assert.equal(a.average_runtime_ms, 2000);
    assert.deepEqual(a.longest, { uri: 'spotify:track:r3', name: 'Row 3', duration_ms: 3000 });
    assert.deepEqual(a.shortest, { uri: 'spotify:track:r1', name: 'Row 1', duration_ms: 1000 });
  });

  it('handles an empty queue without dividing by zero or inventing a longest', () => {
    const a = runtimeAnalysis([], state(track(), 0));
    assert.equal(a.upcoming_count, 0);
    assert.equal(a.total_runtime_ms, 0);
    assert.equal(a.average_runtime_ms, 0);
    assert.equal(a.longest, null);
    assert.equal(a.shortest, null);
    assert.deepEqual(a.timeline, []);
  });

  it('breaks a duration tie towards the FIRST row, for longest and shortest alike', () => {
    // Both reductions keep `best` on equality (`>` and `<`, not `>=`), so a tie
    // resolves to the earlier row. Pinned because the other choice is equally
    // defensible and this one is not currently written down anywhere.
    const tied = [row(1, { duration_ms: 5000 }), row(2, { duration_ms: 5000 })];
    const a = runtimeAnalysis(tied, state(track(), 0));
    assert.equal(a.longest?.uri, 'spotify:track:r1');
    assert.equal(a.shortest?.uri, 'spotify:track:r1');
  });

  it('treats a read state with no item as an ANSWERED question, and reports 0', () => {
    // Nothing playing is a fact, not a failure. So this is 0, not null.
    const a = runtimeAnalysis(rows, state(null, null));
    assert.equal(a.current_track_remaining_ms, 0);
    assert.equal(a.estimated_total_wait_ms, 6000);
    assert.equal(a.current_track_remaining_error, null);
  });

  it('reads the remaining time off the current track and its progress', () => {
    const a = runtimeAnalysis(rows, state(track({ duration_ms: 200_000 }), 50_000));
    assert.equal(a.current_track_remaining_ms, 150_000);
    assert.equal(a.estimated_total_wait_ms, 156_000, 'the queue plus what is left of this track');
    assert.equal(a.current_track_remaining_error, null);
  });

  it('clamps an over-reported progress to zero rather than to a negative wait', () => {
    const a = runtimeAnalysis(rows, state(track({ duration_ms: 1000 }), 99_000));
    assert.equal(a.current_track_remaining_ms, 0);
    assert.equal(a.estimated_total_wait_ms, 6000);
  });

  it('reports a FAILED state read as null everywhere, and says why', () => {
    // This is #803. A failed second read is not "the track has finished": it
    // would report a wait of 6000ms as though you were at the last track.
    const a = runtimeAnalysis(rows, null, 'HTTP 503 from GET /me/player');
    assert.equal(a.current_track_remaining_ms, null);
    assert.equal(a.estimated_total_wait_ms, null);
    assert.equal(a.timeline, null, 'every offset is measured from the current position, so all of them are unread');
    assert.equal(a.current_track_remaining_error, 'HTTP 503 from GET /me/player');
    // The parts that did not need the second read are still reported.
    assert.equal(a.upcoming_count, 3);
    assert.equal(a.total_runtime_ms, 6000);
  });

  it('has a reason even when the caller supplies no error text', () => {
    const a = runtimeAnalysis(rows, null);
    assert.equal(a.current_track_remaining_error, 'playback state was not read');
  });

  it('lays the timeline out from the current position', () => {
    const a = runtimeAnalysis(rows, state(track({ duration_ms: 10_000 }), 4_000));
    assert.equal(a.current_track_remaining_ms, 6000);
    assert.deepEqual(a.timeline?.map((t) => t.plays_at_ms), [6000, 7000, 9000]);
    // The timeline is a strict superset of the row, so the union claim in
    // SPEC.md stays honest.
    assert.deepEqual(a.timeline?.[0], { ...rows[0], plays_at_ms: 6000 });
  });
});

describe('duplicateAnalysis — repeated rows and the runtime they waste', () => {
  it('reports nothing for an empty or duplicate-free queue', () => {
    const a = duplicateAnalysis([]);
    assert.deepEqual(a, { duplicate_groups: [], total_redundant: 0, wasted_runtime_ms: 0, unreadable_rows: 0 });
    const unique = duplicateAnalysis([row(1), row(2, { uri: 'spotify:track:other' })]);
    assert.deepEqual(unique.duplicate_groups, []);
    assert.equal(unique.total_redundant, 0);
  });

  it('groups by URI and counts every repeat but the first as waste', () => {
    const rows = [
      row(1, { uri: 'u', duration_ms: 1000 }),
      row(2, { uri: 'v', duration_ms: 1000 }),
      row(3, { uri: 'u', duration_ms: 2000 }),
      row(4, { uri: 'u', duration_ms: 4000 }),
    ];
    const a = duplicateAnalysis(rows);
    assert.equal(a.duplicate_groups.length, 1);
    assert.deepEqual(a.duplicate_groups[0], {
      uri: 'u',
      name: 'Row 1',
      occurrences: 3,
      positions: [1, 3, 4],
      // The repeats' own durations — the first play is not waste.
      wasted_runtime_ms: 6000,
    });
    assert.equal(a.total_redundant, 2);
    assert.equal(a.wasted_runtime_ms, 6000);
  });

  it('orders groups by where the repeat first appears', () => {
    const rows = [
      row(1, { uri: 'b' }),
      row(2, { uri: 'a' }),
      row(3, { uri: 'a' }),
      row(4, { uri: 'b' }),
    ];
    assert.deepEqual(duplicateAnalysis(rows).duplicate_groups.map((g) => g.uri), ['b', 'a']);
  });

  it('counts a row with no URI as unreadable rather than grouping it', () => {
    // An ad row has no URI. Grouping them would make every ad in the queue a
    // "duplicate" of every other, which is a fabricated finding; skipping them
    // silently would be #803 in the other direction. They are counted.
    const a = duplicateAnalysis([row(1, { uri: '' }), row(2, { uri: '' }), row(3, { uri: 'u' }), row(4, { uri: 'u' })]);
    assert.equal(a.unreadable_rows, 2);
    assert.equal(a.duplicate_groups.length, 1);
    assert.equal(a.duplicate_groups[0]?.positions.length, 2);
  });
});

describe('profileAnalysis — the composition of the queue', () => {
  it('is all zeroes for an empty queue, and no artist block', () => {
    assert.deepEqual(profileAnalysis([]), {
      total: 0,
      tracks: 0,
      episodes: 0,
      unique_artists: 0,
      unique_albums: 0,
      unique_shows: 0,
      longest_artist_block: null,
    });
  });

  it('counts distinct artists, albums and shows', () => {
    const rows = [
      row(1, { artist_names: ['A'], album_name: 'Album 1' }),
      row(2, { artist_names: ['A'], album_name: 'Album 1' }),
      row(3, { artist_names: ['B'], album_name: 'Album 2' }),
      row(4, { is_episode: true, show_name: 'Show 1', artist_names: [], album_name: null }),
    ];
    const p = profileAnalysis(rows);
    assert.equal(p.total, 4);
    assert.equal(p.tracks, 3);
    assert.equal(p.episodes, 1);
    assert.equal(p.unique_artists, 2);
    assert.equal(p.unique_albums, 2);
    assert.equal(p.unique_shows, 1);
  });

  it('excludes an episode from the artist and album counts', () => {
    const p = profileAnalysis([row(1, { is_episode: true, show_name: 'Show 1', artist_names: ['Ghost'], album_name: 'Ghost Album' })]);
    assert.equal(p.unique_artists, 0);
    assert.equal(p.unique_albums, 0);
    assert.equal(p.unique_shows, 1);
  });

  it('names an unknown show rather than dropping it from the count', () => {
    const p = profileAnalysis([row(1, { is_episode: true, show_name: null }), row(2, { is_episode: true, show_name: null })]);
    assert.equal(p.unique_shows, 1);
  });

  it('finds the longest run of one artist, counted on the first artist', () => {
    const rows = [
      row(1, { artist_names: ['A', 'Feature'] }),
      row(2, { artist_names: ['A'] }),
      row(3, { artist_names: ['A'] }),
      row(4, { artist_names: ['B'] }),
      row(5, { artist_names: ['B'] }),
    ];
    assert.deepEqual(profileAnalysis(rows).longest_artist_block, { artist: 'A', tracks: 3 });
  });

  it('breaks a run on a row with no artist, so a blank is not a continuation', () => {
    const rows = [
      row(1, { artist_names: ['A'] }),
      row(2, { artist_names: [] }),
      row(3, { artist_names: ['A'] }),
    ];
    assert.deepEqual(profileAnalysis(rows).longest_artist_block, { artist: 'A', tracks: 1 });
  });

  it('does not let LEADING blank rows out-rank a real artist', () => {
    // The direction a run-in-the-middle test cannot see. A blank row advances
    // the run counter, so if a blank were allowed to set the block, the two
    // leading blanks would bank a length of 2 that the single real artist
    // after them cannot beat — and the answer would silently become "no block"
    // for a queue that plainly has an artist in it.
    const rows = [
      row(1, { is_episode: true, artist_names: [] }),
      row(2, { is_episode: true, artist_names: [] }),
      row(3, { artist_names: ['A'] }),
    ];
    assert.deepEqual(profileAnalysis(rows).longest_artist_block, { artist: 'A', tracks: 1 });
  });

  it('reports no block at all when nothing in the queue names an artist', () => {
    const rows = [row(1, { is_episode: true, artist_names: [] }), row(2, { is_episode: true, artist_names: [] })];
    assert.equal(profileAnalysis(rows).longest_artist_block, null);
  });

  it('counts the playing item only when the caller asks for it, and counts it first', () => {
    // This is the flag the retired `queue_profile` used to bake in. It is a
    // parameter because the two callers want different answers, and guessing
    // which is "the" one is how the two old payloads drifted apart.
    const rows = [row(1, { artist_names: ['A'] }), row(2, { artist_names: ['B'] })];
    const playing = playingRow(track());
    assert.equal(playing?.position, 0);

    const without = profileAnalysis(rows);
    assert.equal(without.total, 2);
    assert.equal(without.unique_artists, 2);

    const withPlaying = profileAnalysis(rows, playing);
    assert.equal(withPlaying.total, 3);
    // The playing item is FIRST, and its artist ('Artist One') is not either
    // upcoming one, so every run in the list is length 1 and the first wins.
    assert.deepEqual(withPlaying.longest_artist_block, { artist: 'Artist One', tracks: 1 });
  });

  it('extends a run when the playing item shares the first upcoming artist', () => {
    const rows = [row(1, { artist_names: ['A'] }), row(2, { artist_names: ['A'] })];
    const playing = playingRow(track({ artists: [{ id: 'a1', name: 'A', uri: 'spotify:artist:a1' }] }));
    assert.deepEqual(profileAnalysis(rows, playing).longest_artist_block, { artist: 'A', tracks: 3 });
  });
});

describe('these analyses make no request', () => {
  it('imports nothing but types, so there is no client to call', () => {
    // The one-read contract in SPEC.md is only checkable because every function
    // here is pure. That is not something a behavioural test can see, so this
    // asserts the thing that guarantees it: the module's ONLY import is a
    // type-only one, which the compiler erases, so `src/client.js` is never
    // even loaded. A value import added here — the way a request would be
    // introduced — fails this.
    //
    // `Function.length` would have been the wrong instrument: it counts only
    // the parameters before the first default, so `runtimeAnalysis`'s
    // `stateError = null` reads as arity 2 and the assertion would be about
    // default parameters rather than about requests.
    const source = readFileSync(join(REPO_ROOT, 'src', 'queueanalysis.ts'), 'utf8');
    const imports = [...source.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)];
    assert.ok(imports.length > 0, 'the module must still declare its types');
    for (const [, typeOnly, specifier] of imports) {
      assert.equal(typeOnly?.trim(), 'type', `every import must be type-only: ${specifier}`);
      assert.equal(specifier, './types/spotify.js');
    }
  });

  it('reports a failed state read as unread, with the whole analysis still computed', () => {
    // The functional half of the same claim: the function needs no client to
    // produce a complete answer about everything the one read did cover.
    const a = runtimeAnalysis([row(1, { duration_ms: 1000 })], null, 'unread');
    assert.equal(a.current_track_remaining_ms, null);
    assert.equal(a.timeline, null);
    assert.equal(a.total_runtime_ms, 1000);
    assert.equal(a.upcoming_count, 1);
  });
});
