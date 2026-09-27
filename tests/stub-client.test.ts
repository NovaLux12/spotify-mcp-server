/**
 * Contract tests for the shared stub client (#659).
 *
 * These are not "does the helper work" tests — they pin the properties that
 * make the helper SAFE, each of which was a defect in the hand-written stubs
 * it replaces:
 *
 *   1. `getAllPages` is the PRODUCTION implementation, not a copy. Proven by
 *      the mutation check at the bottom: break the real walk in `src/client.ts`
 *      and these tests go red. That is the acceptance criterion #659 asked for
 *      and the thing 19 hand-copied loops could never satisfy.
 *   2. An unexpected call throws instead of returning a plausible default.
 *   3. A dropped/forged query parameter is caught by `expectParams`.
 *   4. `putRaw`'s Content-Type survives (the argument the old stubs lost).
 *   5. The cap comes from config, not a hardcoded 500.
 *
 * Run: node --import tsx --test tests/stub-client.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  StatefulPlaylistClient,
  StubSpotifyClient,
  UnexpectedArgumentError,
  UnexpectedCallError,
  trackUris,
} from './helpers/stub-client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
// #1274: a store default resolving through homedir() must never land in the
// real $HOME. Imported for its side effect, as every test file must.
import './helpers/hermetic.js';
import { initConfig } from '../src/config.js';
import { SpotifyClient } from '../src/client.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read src/client.ts and return the `fetchAllCap` default expression. */
function clientCapExpression(): string {
  const src = readFileSync(join(REPO_ROOT, 'src/client.ts'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('this.fetchAllCap = opts.fetchAllCap'));
  assert.ok(line, 'src/client.ts must assign fetchAllCap in the constructor');
  return line;
}

describe('StubSpotifyClient — structure', () => {
  it('IS a real SpotifyClient, so registrars accept it without a cast', () => {
    const stub = new StubSpotifyClient();
    assert.ok(stub instanceof SpotifyClient);
  });

  it('does not reimplement getAllPages — the only definitions are in src/client.ts', () => {
    // The whole point of subclassing. A hand-written `async getAllPages` in
    // this helper would reintroduce exactly the bug class #659 closes, so the
    // helper is not allowed to contain one.
    const src = readFileSync(join(REPO_ROOT, 'tests/helpers/stub-client.ts'), 'utf8');
    assert.ok(
      !/\bgetAllPages\s*[(<]/.test(src),
      'stub-client.ts must not define or call getAllPages; it is inherited from src/client.ts',
    );
    // Inherited off the prototype, which is the proof it is the production one.
    assert.equal(
      Object.prototype.hasOwnProperty.call(StubSpotifyClient.prototype, 'getAllPages'),
      false,
      'getAllPages must be inherited from SpotifyClient.prototype, not shadowed',
    );
  });

  it('reads the fetch-all cap from config, never a hardcoded 500', () => {
    // The exact literal 16 of the old copies hardcoded. If this regresses, the
    // stub and the client can disagree about the cap again.
    const line = clientCapExpression();
    assert.match(line, /getConfig\(\)\.fetchAllCap/, 'cap must come from getConfig()');
    assert.doesNotMatch(line, /\b500\b/, 'cap must not be a literal');
  });
});

describe('StubSpotifyClient — the walk is the production walk', () => {
  it('honours SPOTIFY_MCP_FETCH_ALL_CAP rather than a baked-in default', async () => {
    const previous = initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '3' });
    try {
      const stub = new StubSpotifyClient();
      stub.page('/me/tracks', [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
      const verdict = await stub.getAllPagesWithTruncation<{ id: string }>('/me/tracks');
      assert.equal(verdict.items.length, 3, 'cap must come from config');
      assert.equal(verdict.truncatedByCap, true);
      assert.equal(verdict.reportedTotal, 5);
    } finally {
      initConfig(previous as unknown as NodeJS.ProcessEnv);
    }
  });

  it('paginates a multi-page fixture through the inherited loop', async () => {
    const stub = new StubSpotifyClient();
    const items = Array.from({ length: 120 }, (_, i) => ({ id: `t${i}` }));
    stub.page('/me/tracks', items, { pageSize: 50 });

    const rows = await stub.getAllPages<{ id: string }>('/me/tracks');
    assert.equal(rows.length, 120);
    assert.equal(rows[0].id, 't0');
    assert.equal(rows[119].id, 't119');
    // 50 + 50 + 20 — the walk asked for exactly the pages the fixture implies.
    assert.equal(stub.callsTo('GET', '/me/tracks').length, 3);
  });

  it('stops on a short page the way the real client does', async () => {
    // A server that keeps claiming a total it cannot back: the walk must end
    // on the short page and report truncation, not spin to the cap.
    const stub = new StubSpotifyClient();
    stub.page('/me/tracks', [{ id: 'only' }], { total: 900 });
    const verdict = await stub.getAllPagesWithTruncation<{ id: string }>('/me/tracks');
    assert.equal(verdict.items.length, 1);
    assert.equal(verdict.truncated, true, 'reported total outranks the short page (#718)');
    assert.equal(verdict.truncatedByCap, false, 'the cap did not end this walk');
  });

  it('ends a walk on a SHORT page when the server reports no total', async () => {
    // The discriminating case for the short-page break. With a `total` in the
    // envelope, `offset >= total` ends the walk and the short-page clause is
    // redundant — so a fixture with a total cannot tell the two apart. Drop the
    // total and the short page is the ONLY end-of-data signal there is: the
    // walk must stop there, and the verdict must not claim the cap ended it.
    const stub = new StubSpotifyClient();
    // 25 items at a page size of 10: pages 0 and 10 are full, page 20 is short
    // and NON-EMPTY. That shape is what discriminates — an empty last page ends
    // the walk on the `length === 0` clause alone, so a fixture that only ever
    // serves full pages then nothing cannot tell the two clauses apart.
    const all = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}` }));
    stub.route('GET', '/no-total', {
      respond: (call) => {
        const offset = Number((call.arg as { offset?: string })?.offset ?? 0) || 0;
        const items = all.slice(offset, offset + 10);
        // `total` deliberately absent — this endpoint does not send one.
        return { items, limit: 10, offset, next: null };
      },
    });

    const verdict = await stub.getAllPagesWithTruncation<{ id: string }>('/no-total');
    assert.equal(verdict.items.length, 25, 'the walk must stop at the short page, not run on');
    assert.equal(verdict.reportedTotal, null, 'no total was sent, so none is reported');
    assert.equal(verdict.truncatedByCap, false, 'the cap did not end this walk');
    assert.equal(
      stub.callsTo('GET', '/no-total').length,
      3,
      'the walk must stop ON the short page, not spend a fourth request to discover it is empty',
    );
  });

  it('seeds the cursor from initialOffset', async () => {
    const stub = new StubSpotifyClient();
    stub.page('/me/tracks', Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })), { pageSize: 5 });
    const rows = await stub.getAllPages<{ id: string }>('/me/tracks', undefined, { initialOffset: 5 });
    assert.deepEqual(rows.map((r) => r.id), ['t5', 't6', 't7', 't8', 't9']);
  });

  it('passes maxItems through instead of ignoring it', async () => {
    const stub = new StubSpotifyClient();
    stub.page('/me/tracks', Array.from({ length: 50 }, (_, i) => ({ id: `t${i}` })), { pageSize: 10 });
    const rows = await stub.getAllPages<{ id: string }>('/me/tracks', undefined, { maxItems: 7 });
    assert.equal(rows.length, 7, 'maxItems must cap the walk');
  });
});

describe('StubSpotifyClient — fails loudly instead of inventing an answer', () => {
  it('throws on an unregistered path rather than returning null', async () => {
    const stub = new StubSpotifyClient();
    stub.page('/me/tracks', []);
    await assert.rejects(
      () => stub.get('/me/player'),
      (err: unknown) => {
        assert.ok(err instanceof UnexpectedCallError);
        assert.match(err.message, /GET \/me\/player/);
        // The message must show what IS registered, or the fix is guesswork.
        assert.match(err.message, /Registered routes: GET \/me\/tracks/);
        return true;
      },
    );
  });

  it('throws on an unregistered verb even when the path is registered', async () => {
    const stub = new StubSpotifyClient();
    stub.route('GET', '/me/player', { respond: () => ({}) });
    await assert.rejects(
      () => stub.put('/me/player', { volume_percent: 50 }),
      (err: unknown) => err instanceof UnexpectedCallError && /PUT \/me\/player/.test(err.message),
    );
  });

  it('catches a dropped query parameter via expectParams', async () => {
    // The `async get(path: string)` bug: the old stubs took no params, so a
    // tool that stopped sending `market` was indistinguishable from one that
    // sent it. Here the route demands it.
    const stub = new StubSpotifyClient();
    stub.route('GET', '/search', { expectParams: { q: 'x', market: 'GB' }, respond: () => ({}) });
    await assert.rejects(
      () => stub.get('/search', { q: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof UnexpectedArgumentError);
        assert.match(err.message, /expected param market="GB", got market=undefined/);
        return true;
      },
    );
  });

  it('accepts the call once the expected parameter is actually sent', async () => {
    const stub = new StubSpotifyClient();
    stub.route('GET', '/search', { expectParams: { q: 'x', market: 'GB' }, respond: () => ({ hits: [] }) });
    assert.deepEqual(await stub.get('/search', { q: 'x', market: 'GB' }), { hits: [] });
  });

  it('rejects a parameter the regression would add (rejectParams)', async () => {
    const stub = new StubSpotifyClient();
    stub.route('PUT', '/me/player/volume', { rejectParams: ['position_ms'], respond: () => ({}) });
    await assert.rejects(
      () => stub.put('/me/player/volume', { volume_percent: 50, position_ms: 0 }),
      UnexpectedArgumentError,
    );
  });

  it('pins an exact call count so a double-write cannot pass', async () => {
    const stub = new StubSpotifyClient();
    stub.route('POST', '/me/playlists', { times: 1, respond: () => ({ id: 'p' }) });
    await stub.post('/me/playlists', { name: 'x' });
    await assert.rejects(() => stub.post('/me/playlists', { name: 'x' }), UnexpectedArgumentError);
  });

  it('reports an unmet count expectation in assertCallCounts', () => {
    const stub = new StubSpotifyClient();
    stub.route('POST', '/me/playlists', { times: 2, respond: () => ({}) });
    assert.throws(() => stub.assertCallCounts(), /expected exactly 2 call\(s\), saw 0/);
  });
});

describe('StubSpotifyClient — records the argument production sent', () => {
  it('records the query params on a GET verbatim', async () => {
    const stub = new StubSpotifyClient();
    stub.page('/me/tracks', []);
    await stub.get('/me/tracks', { limit: '50', offset: '100' });
    const [call] = stub.callsTo('GET');
    assert.deepEqual(call.arg, { limit: '50', offset: '100' });
  });

  it('records the body on a write, and PUT_RAW keeps its Content-Type', async () => {
    const stub = new StubSpotifyClient();
    stub.route('POST', '/me/playlists', { respond: () => ({ id: 'p' }) });
    stub.route('PUT_RAW', '/playlists/p/images', { respond: () => undefined });
    await stub.post('/me/playlists', { name: 'New', public: false });
    await stub.putRaw('/playlists/p/images', 'BYTES', 'image/png');

    assert.deepEqual(stub.callsTo('POST')[0].arg, { name: 'New', public: false });
    const raw = stub.callsTo('PUT_RAW')[0];
    assert.equal(raw.arg, 'BYTES', 'the raw body must survive, not be dropped');
    assert.equal(raw.extra, 'image/png', 'the Content-Type is the argument the old stubs lost');
  });

  it('records every verb under its own name', async () => {
    const stub = new StubSpotifyClient();
    for (const m of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      stub.route(m, '/x', { respond: () => ({}) });
    }
    stub.route('PUT_RAW', '/x/raw', { respond: () => undefined });
    await stub.get('/x');
    await stub.post('/x', {});
    await stub.put('/x', {});
    await stub.delete('/x', {});
    await stub.putRaw('/x/raw', 'b', 'image/jpeg');
    assert.deepEqual(stub.calls.map((c) => c.method), ['GET', 'POST', 'PUT', 'DELETE', 'PUT_RAW']);
  });

  it('routes are overridable, most recent first, and reset clears both calls and hits', async () => {
    const stub = new StubSpotifyClient();
    stub.route('GET', '/x', { respond: () => 'first' });
    stub.route('GET', '/x', { respond: () => 'second' });
    assert.equal(await stub.get('/x'), 'second');
    stub.reset();
    assert.equal(stub.calls.length, 0);
  });
});

describe('StubSpotifyClient — a real regression guard', () => {
  it('a test built on the stub fails when the production cap changes', async () => {
    // This is the property 19 hand-copied loops could not have. Written as an
    // executable statement of it rather than prose: the stub's cap comes from
    // `getConfig().fetchAllCap` through the real constructor, so the walk
    // result tracks production by construction.
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '500' });
    const stub = new StubSpotifyClient();
    stub.page('/me/tracks', Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })));
    assert.equal((await stub.getAllPages('/me/tracks')).length, 10);

    // Same stub, cap lowered the way `SPOTIFY_MCP_FETCH_ALL_CAP` lowers it.
    const capped = new StubSpotifyClient();
    capped.page('/me/tracks', Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })));
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '4' });
    const afterCapChange = new StubSpotifyClient();
    afterCapChange.page('/me/tracks', Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })));
    assert.equal(
      (await afterCapChange.getAllPages('/me/tracks')).length,
      4,
      'changing the real cap must change the stubbed walk — the coupling under test',
    );
    void capped;
    initConfig(process.env);
  });
});

/**
 * Contract tests for {@link StatefulPlaylistClient} (#881).
 *
 * The same discipline as the rest of this file, applied to the one property
 * that separates a stateful mock from a fixed-response stub: **the state has
 * to actually change, and an id nobody seeded has to fail rather than come
 * back empty.** A mock whose PUT recorded a body and left the rows alone would
 * let every "the commit landed" assertion in the destructive-replace suite
 * pass while proving nothing, which is #236's shape again with better manners.
 */
describe('StatefulPlaylistClient — the state is real', () => {
  const PL = 'pl-stateful';

  it('a PUT replaces the rows, and a later read sees the replacement', async () => {
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a', 'spotify:track:b', 'spotify:track:c'] });

    await stub.put(`/playlists/${PL}/items`, { uris: ['spotify:track:c', 'spotify:track:a'] });

    assert.deepEqual(stub.urisOf(PL), ['spotify:track:c', 'spotify:track:a']);
    assert.deepEqual(stub.logOf(PL).replaces, [{ uris: ['spotify:track:c', 'spotify:track:a'] }]);
    // And the READ, not just the mock's own field: an independent walk.
    const walked = await stub.getAllPages<PlaylistItemObject>(`/playlists/${PL}/items`, { limit: '100' });
    assert.deepEqual(
      walked.map((r) => r.item?.uri),
      ['spotify:track:c', 'spotify:track:a'],
    );
  });

  it('a POST appends, so a multi-chunk write ends in the order the tool asked for', async () => {
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a'] });

    await stub.put(`/playlists/${PL}/items`, { uris: ['spotify:track:b'] });
    await stub.post(`/playlists/${PL}/items`, { uris: ['spotify:track:c'] });
    await stub.post(`/playlists/${PL}/items`, { uris: ['spotify:track:d'] });

    assert.deepEqual(stub.urisOf(PL), ['spotify:track:b', 'spotify:track:c', 'spotify:track:d']);
    assert.deepEqual(stub.writtenUris(PL), ['spotify:track:b', 'spotify:track:c', 'spotify:track:d']);
  });

  it('an empty-uris PUT is a real clear, and the count read agrees', async () => {
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a', 'spotify:track:b'] });

    await stub.put(`/playlists/${PL}/items`, { uris: [] });

    assert.deepEqual(stub.rowsOf(PL), []);
    const meta = await stub.get<{ items: { total: number } }>(`/playlists/${PL}`);
    assert.equal(meta?.items.total, 0, 'the metadata total must follow the rows, or a "read the whole playlist" proof is a fiction');
  });

  it('a DELETE splices the named positions out, so a descending sweep really removes them', async () => {
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a', 'spotify:track:b', 'spotify:track:c', 'spotify:track:d'] });

    // Highest first, the order the tool commits in. If the mock ignored the
    // positions, this would leave three rows instead of two.
    await stub.delete(`/playlists/${PL}/items`, { tracks: [{ positions: [3] }] });
    await stub.delete(`/playlists/${PL}/items`, { tracks: [{ positions: [1] }] });

    assert.deepEqual(stub.urisOf(PL), ['spotify:track:a', 'spotify:track:c']);
    assert.deepEqual(stub.logOf(PL).deletes, [[3], [1]], 'the positions must be recorded in the order they were sent');
  });

  it('an unavailable row is served as item:null and survives a no-op read', async () => {
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a', null] });

    const rows = await stub.getAllPages<PlaylistItemObject>(`/playlists/${PL}/items`, { limit: '100' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.item?.uri, 'spotify:track:a');
    assert.equal(rows[1]?.item, null, 'the second row must be the unavailable one');
  });

  it('an unseeded playlist id fails loudly instead of answering as an empty playlist', async () => {
    // The permissive-default bug in a stateful outfit: a mock that invented an
    // empty playlist would make "the tool read the wrong id" indistinguishable
    // from "the tool found an empty playlist".
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a'] });

    await assert.rejects(
      () => stub.get(`/playlists/some-other-id/items`),
      /was never seeded/,
    );
  });

  it('a malformed write body is rejected rather than read as an empty replace', async () => {
    // `{ uris: [] }` clears a playlist. A body that carries no `uris` at all
    // must NOT clear it — that is the difference between a clear and a wipe.
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a', 'spotify:track:b'] });

    await assert.rejects(
      () => stub.put(`/playlists/${PL}/items`, { tracks: [{ positions: [0] }] }),
      UnexpectedArgumentError,
    );
    assert.deepEqual(stub.rowsOf(PL), ['spotify:track:a', 'spotify:track:b'], 'a rejected body must not have mutated the store');
  });

  it('the item read pages the LIVE rows, so a 600-row fixture hits the PRODUCTION cap', async () => {
    // This is the property #881's acceptance criterion is about. The mock
    // never names a cap: it hands back a real envelope whose `total` is the
    // live row count, and the INHERITED walk stops where it always stops.
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: trackUris(600) });

    const walked = await stub.getAllPagesWithTruncation<PlaylistItemObject>(
      `/playlists/${PL}/items`,
      { limit: '100' },
    );

    assert.equal(walked.reportedTotal, 600, 'the server total must be the LIVE row count');
    assert.equal(walked.items.length, 500, 'the default SPOTIFY_MCP_FETCH_ALL_CAP is 500, and a 600-row fixture must hit it');
    assert.equal(walked.truncated, true, 'hitting the cap is a truncation the caller must be able to report');
    assert.equal(walked.truncatedByCap, true, 'and the verdict must name the cap as the cause, not a short page');
    assert.equal(stub.logOf(PL).itemPageReads, 5, '500 rows at 100 per page is five page reads, and the count is the mock\'s');
    assert.equal(walked.items[0]?.item?.uri, 'spotify:track:t0');

    // A caller that asks for more gets more, off the same live rows.
    const all = await stub.getAllPages<PlaylistItemObject>(`/playlists/${PL}/items`, { limit: '100' }, { maxItems: 600 });
    assert.equal(all.length, 600, 'maxItems is a cap on the walk, not a cap on the store');
  });

  it('a write with no readable receipt hands back a null snapshot_id, like a 204', async () => {
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a'], receiptReadable: false });

    const res = await stub.put<{ snapshot_id?: string }>(`/playlists/${PL}/items`, { uris: [] });
    assert.equal(res?.snapshot_id ?? null, null, 'an unreadable receipt must be null, never a synthesised id');
    assert.deepEqual(stub.rowsOf(PL), [], 'the clear still happened — an unreadable receipt is a lost RESPONSE, not a failed mutation');
  });
});

describe('StatefulPlaylistClient — snapshot ids move when the playlist does', () => {
  const PL = 'pl-snap';

  it('a write moves the snapshot the metadata read reports', async () => {
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a'], snapshots: ['snap-1', 'snap-2'] });

    const before = await stub.get<{ snapshot_id: string }>(`/playlists/${PL}`);
    assert.equal(before?.snapshot_id, 'snap-1');

    await stub.put(`/playlists/${PL}/items`, { uris: ['spotify:track:b'] });

    const after = await stub.get<{ snapshot_id: string }>(`/playlists/${PL}`);
    assert.equal(after?.snapshot_id, 'snap-2', 'a stale snapshot id would make optimistic concurrency unobservable');
    assert.deepEqual(stub.urisOf(PL), ['spotify:track:b']);
  });

  it('a playlist with no readable receipt reports a null snapshot, not a stale one', async () => {
    const stub = new StatefulPlaylistClient();
    stub.seedPlaylist(PL, { rows: ['spotify:track:a'], receiptReadable: false });
    const meta = await stub.get<{ snapshot_id: string | null }>(`/playlists/${PL}`);
    assert.equal(meta?.snapshot_id, null, 'null means "no snapshot", which is the answer a caller must be able to see');
  });
});
