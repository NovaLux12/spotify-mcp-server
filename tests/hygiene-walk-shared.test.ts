/**
 * #897 — `library_hygiene` re-read album metadata the walk already had.
 *
 * ## The defect
 *
 * The tool walks `GET /me/tracks`, groups the rows by `track.album.id`, and
 * then issues one `GET /albums/{id}` per group — up to `ALBUM_LOOKUP_CAP`
 * (200) requests — purely to read two fields:
 *
 * ```ts
 * group.total_tracks = typeof full.total_tracks === 'number' ? full.total_tracks : null;
 * group.album_type   = full.album_type   ?? group.album_type;
 * ```
 *
 * Both are **required members of Spotify's `AlbumBase`**, and the album on a
 * track row is a `SimplifiedAlbumObject`, which is `AlbumBase` plus artists.
 * Every row of the walk was already carrying both. The repo's own
 * `SpotifyAlbumSimple` declared only `{id, name, uri, images}`, so the type
 * system could not see what the wire sends and the fan-in looked necessary.
 *
 * Verified against the published OpenAPI schema
 * (`components/schemas/AlbumBase` lists `album_type` and `total_tracks` under
 * `required`; `SimplifiedAlbumObject` is `allOf: [AlbumBase, {artists}]`;
 * `TrackObject.album` `$ref`s `SimplifiedAlbumObject`) — not from memory, and
 * not from a changelog summary.
 *
 * This is the #1224 cost, not a new one: migrating off the removed `?ids=`
 * batch route was never what would have made the tool cheap, because the
 * request that made it expensive was a re-read, not a batch. Sharing the
 * already-fetched object is.
 *
 * ## What the fix changes, and what it must not change
 *
 * The fan-in is now a FALLBACK: it runs only for groups the walk could not
 * answer. Everything the #1224/#763 contract promised for the read itself is
 * unchanged for the albums that still need it — per-id, width-bounded, capped,
 * 429 degrading to a partial, and a failed read NAMED rather than folded into
 * a zero. Those are the cases asserted below alongside the sharing, because
 * "issue fewer requests" is only a fix if the answer is still the same one.
 *
 * Every case here must fail on the pre-fix tree, and the fixtures are shaped
 * by what Spotify actually sends — a walk row WITH the fields is the case the
 * defect needs, and a walk row WITHOUT them is the case that must still read.
 *
 * Run: node --import tsx --test tests/hygiene-walk-shared.test.ts
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder } from './helpers/stub-client.js';
import { registerLibraryHygieneTools } from '../src/tools/libraryhygiene.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ToolOut = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
};

interface Harness {
  invoke: (name: string, args?: Record<string, unknown>) => Promise<ToolOut>;
  /** Paths of every `GET` the tool issued, in order, with no query string. */
  get reads(): string[];
  client: StubFromResponder;
}

function harness(responder: LegacyResponder): Harness {
  const registered: RegisteredTool[] = [];
  const client = new StubFromResponder(responder);
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType<Record<string, unknown>> },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => (config.inputSchema ? config.inputSchema.parse(args) : args),
        handler,
      });
    },
  } as unknown as McpServer;

  registerLibraryHygieneTools(fakeServer, client);

  return {
    client,
    get reads() {
      return client.calls.filter((c) => c.method === 'GET').map((c) => c.path);
    },
    async invoke(name, args = {}) {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} was not registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One saved track whose album is a REAL `SimplifiedAlbumObject`.
 *
 * `walkCarriesTotals` is the switch the whole file turns on:
 *   - `true`  — what Spotify sends, and what the pre-fix tree threw away;
 *   - `false` — what the pre-fix type implied, kept so the fallback stays
 *               covered by a test rather than by hope.
 */
interface AlbumSpec {
  id: string;
  name: string;
  /** Tracks liked out of `totalTracks` — set to drive the coverage finding. */
  likedCount: number;
  totalTracks: number;
  albumType?: string;
  walkCarriesTotals?: boolean;
  /** Make the per-id read fail, to prove the failure is still named. */
  readFails?: boolean;
}

function savedTrackRow(album: AlbumSpec, n: number, carry: boolean) {
  return {
    added_at: '2026-01-01T00:00:00Z',
    track: {
      id: `${album.id}_t${n}`,
      name: `Track ${n}`,
      uri: `spotify:track:${album.id}_t${n}`,
      type: 'track',
      duration_ms: 200_000,
      explicit: false,
      artists: [{ id: `ar_${album.id}`, name: `Artist ${album.id}` }],
      album: {
        id: album.id,
        name: album.name,
        uri: `spotify:album:${album.id}`,
        images: [],
        ...(carry
          ? {
            // `AlbumBase` requires both of these; `SimplifiedAlbumObject` is
            // `AlbumBase` + artists, so every real walk row has them.
            album_type: album.albumType ?? 'album',
            total_tracks: album.totalTracks,
            release_date: '2026-01-01',
            release_date_precision: 'day',
            artists: [{ id: `ar_${album.id}`, name: `Artist ${album.id}` }],
          }
          : {}),
      },
    },
  };
}

/** The full `AlbumObject` the per-id route answers with. */
function fullAlbum(album: AlbumSpec) {
  return {
    id: album.id,
    name: album.name,
    uri: `spotify:album:${album.id}`,
    album_type: album.albumType ?? 'album',
    release_date: '2026-01-01',
    release_date_precision: 'day',
    total_tracks: album.totalTracks,
    images: [],
    artists: [{ id: `ar_${album.id}`, name: `Artist ${album.id}` }],
  };
}

/**
 * A `/me/tracks` responder plus a recorder of every per-id album read.
 *
 * The per-id route is REGISTERED in every case, including the ones that expect
 * it never to be called — a stub that throws on an unmodelled path is how a
 * test tells "the tool did not read this" apart from "the fixture made that
 * impossible".
 */
function library(specs: AlbumSpec[]) {
  const byId = new Map(specs.map((a) => [a.id, a]));
  const rows = specs.flatMap((a) =>
    Array.from({ length: a.likedCount }, (_, i) =>
      savedTrackRow(a, i + 1, a.walkCarriesTotals !== false)),
  );
  const albumReads: string[] = [];

  const responder: LegacyResponder = (path, arg) => {
    if (path === '/me/tracks') {
      // Paging is honoured, not faked: the stub inherits the PRODUCTION
      // `getAllPages`, so a responder that ignored `offset` would hand the
      // same page back on every hop and count each album's likes twice. That
      // is a fixture lie, not a finding — §6.
      const params = (arg ?? {}) as { offset?: string; limit?: string };
      const limit = Number(params.limit ?? 50);
      const offset = Number(params.offset ?? 0);
      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        limit,
        offset,
      };
    }
    const perId = /^\/albums\/(.+)$/.exec(path);
    if (perId) {
      const id = decodeURIComponent(perId[1]);
      albumReads.push(id);
      const spec = byId.get(id);
      if (!spec) return null;
      if (spec.readFails) throw new Error(`404 album ${id} not found`);
      return fullAlbum(spec);
    }
    return undefined;
  };

  return { responder, albumReads };
}

function albums(n: number, over: Partial<AlbumSpec> = {}): AlbumSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `alb${i}`,
    name: `Album ${i}`,
    likedCount: 8,
    totalTracks: 10,
    ...over,
  }));
}

type AlbumLookups = {
  made: number;
  requests: number;
  shared_from_walk: number;
  truncated_by_cap: boolean;
  unresolved: Array<{ id: string; reason: string; status: number | null }>;
};

type Payload = {
  scanned: { album_groups: number; liked_tracks: number };
  album_lookups: AlbumLookups;
  counts: { near_complete: number; orphaned_singles: number };
  groups: Array<{ album_id: string; total_tracks: number | null; coverage: number | null; album_type: string | null }>;
  near_complete: Array<{ album_id: string; total_tracks: number; coverage: number }>;
};

function payloadOf(out: ToolOut): Payload {
  assert.ok(out.structuredContent, 'the tool published no structuredContent');
  return out.structuredContent as unknown as Payload;
}

const perIdAlbumReads = (h: Harness) => h.reads.filter((p) => /^\/albums\/.+/.test(p));

// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------

describe('#897 library_hygiene shares the album metadata the walk already carried', () => {
  it('issues no GET /albums/{id} when the walk rows carry the totals', async () => {
    // 40 albums × 8 liked of 10 — every one of them a near-complete finding, so
    // a tool that simply stopped reading would still have to produce them from
    // somewhere. It produces them from the walk.
    const specs = albums(40);
    const { responder } = library(specs);
    const h = harness(responder);

    const out = await h.invoke('library_hygiene', { response_format: 'json' });
    const p = payloadOf(out);

    assert.deepEqual(
      perIdAlbumReads(h),
      [],
      'the walk already carried total_tracks and album_type for every album; re-reading them is the defect',
    );
    assert.equal(p.album_lookups.requests, 0, 'no per-id request was issued');
    assert.equal(p.album_lookups.made, 0, 'no album needed the fallback read');
    assert.equal(p.album_lookups.shared_from_walk, 40, 'all 40 album groups were answered by the walk');
    assert.equal(p.scanned.album_groups, 40);
  });

  it('produces the same findings from the walk as the read produced', async () => {
    // The assertion that matters: "fewer requests" is not a fix if the answer
    // changed. Every group must still carry the total, the coverage and the
    // album type, and the near-complete rollup must be the full 40.
    const { responder } = library(albums(40));
    const out = await harness(responder).invoke('library_hygiene', { response_format: 'json' });
    const p = payloadOf(out);

    assert.equal(p.groups.length, 40);
    assert.ok(
      p.groups.every((g) => g.total_tracks === 10),
      'every group kept its track total, read off the walk',
    );
    assert.ok(
      p.groups.every((g) => g.coverage !== null && Math.abs((g.coverage as number) - 0.8) < 1e-9),
      'coverage is 8/10 for every group, so the ratio was computed against a real total',
    );
    assert.ok(
      p.groups.every((g) => g.album_type === 'album'),
      'album_type came from the walk too, not left null',
    );
    assert.equal(p.counts.near_complete, 40, 'all 40 albums are 70–99% liked and are still reported');
    assert.deepEqual(
      p.near_complete.map((f) => f.total_tracks),
      Array.from({ length: 40 }, () => 10),
      'no finding reports a total the walk did not supply',
    );
  });

  it('says a zero-request run is complete rather than leaving the reader to guess', async () => {
    // `requests: 0` alone is ambiguous — it reads the same as "found nothing".
    // The count that disambiguates it is part of the contract now.
    const { responder } = library(albums(3));
    // A human-facing mode: in `json` mode the text block is the #895 summary,
    // and the sentence under test is only ever written to a reader.
    const out = await harness(responder).invoke('library_hygiene');
    const text = out.content.map((c) => c.text).join('\n');

    assert.match(
      text,
      /3 of 3 albums took their track total from the \/me\/tracks walk itself and needed no lookup at all\./,
      'the prose names how many albums the walk answered',
    );
  });
});

// ---------------------------------------------------------------------------
// What the fix must not break: the fallback
// ---------------------------------------------------------------------------

describe('#897 the per-id fallback still runs, and still fails loudly', () => {
  it('still reads single-candidates, whose orphan check needs a track listing', async () => {
    // The one consumer the walk genuinely cannot satisfy. `orphaned_singles`
    // compares a release's full `tracks.items` against the liked set, and a
    // `SimplifiedAlbumObject` carries no track list at all — so a single still
    // has to be read, or its listing is simply absent and the check runs
    // against nothing.
    //
    // This is the case a naive "read only what the walk could not answer"
    // version gets wrong: the walk DOES answer a single's total, so that
    // version skips the read and drops the album from the orphan population.
    const longAlbums = albums(20);
    const singles = [
      { id: 'sgl0', name: 'Single 0', likedCount: 1, totalTracks: 2, albumType: 'single' },
      { id: 'sgl1', name: 'Single 1', likedCount: 1, totalTracks: 1, albumType: 'single' },
    ];
    const { responder, albumReads } = library([...longAlbums, ...singles]);
    const h = harness(responder);

    const out = await h.invoke('library_hygiene', { response_format: 'json' });
    const p = payloadOf(out);

    assert.deepEqual(
      albumReads.sort(),
      ['sgl0', 'sgl1'],
      'the two singles are read for their track listing; the twenty long albums are not',
    );
    assert.equal(p.album_lookups.shared_from_walk, 20, 'the walk answered the twenty long albums');
    assert.equal(p.counts.near_complete, 20, 'only the long albums are 70–99% liked');
    assert.equal(
      p.counts.orphaned_singles,
      2,
      'both singles are still reported as orphaned, so the orphan check saw their listings',
    );
  });

  it('reads only the albums whose walk row carried no total', async () => {
    // The pre-fix type claimed no walk row ever carried these, and every other
    // fixture in the suite still models that. The fallback is what keeps those
    // libraries correct, so it has to keep running.
    const specs = [
      ...albums(3, { id: 'withtotal' }),
      ...albums(2, { walkCarriesTotals: false, id: 'nototal' }),
    ];
    // Keep ids distinct.
    const withTotal = specs.slice(0, 3).map((a, i) => ({ ...a, id: `wt${i}` }));
    const withoutTotal = specs.slice(3).map((a, i) => ({ ...a, id: `nt${i}` }));
    const { responder, albumReads } = library([...withTotal, ...withoutTotal]);
    const h = harness(responder);

    const out = await h.invoke('library_hygiene', { response_format: 'json' });
    const p = payloadOf(out);

    assert.deepEqual(
      perIdAlbumReads(h).map((p2) => decodeURIComponent(p2.split('/').pop() as string)).sort(),
      ['nt0', 'nt1'],
      'exactly the two albums the walk could not answer were read per id',
    );
    assert.equal(albumReads.length, 2);
    assert.equal(p.album_lookups.made, 2);
    assert.equal(p.album_lookups.requests, 2);
    assert.equal(p.album_lookups.shared_from_walk, 3, 'the three the walk answered cost nothing');
    assert.equal(p.counts.near_complete, 5, 'all five albums are still reported near-complete');
    assert.ok(
      p.groups.every((g) => g.total_tracks === 10),
      'the read albums and the shared albums agree on the total',
    );
  });

  it('names a failed read instead of reporting the album as having no tracks', async () => {
    // The #803 shape: a lookup that could not be read must not become a zero.
    // Sharing must not become a second way to lose the disclosure.
    const specs = [
      { id: 'good1', name: 'Good 1', likedCount: 8, totalTracks: 10 },
      { id: 'good2', name: 'Good 2', likedCount: 8, totalTracks: 10 },
      { id: 'gone', name: 'Gone', likedCount: 8, totalTracks: 10, walkCarriesTotals: false, readFails: true },
    ];
    const { responder } = library(specs);
    const h = harness(responder);

    const out = await h.invoke('library_hygiene', { response_format: 'json' });
    const p = payloadOf(out);

    assert.equal(p.album_lookups.unresolved.length, 1, 'the unreadable album is named');
    assert.equal(p.album_lookups.unresolved[0].id, 'gone');
    assert.ok(
      p.album_lookups.unresolved[0].reason.length > 0,
      'the unresolved entry carries a reason, not just an id',
    );

    const gone = p.groups.find((g) => g.album_id === 'gone');
    assert.ok(gone, 'the group is still present in the scan');
    assert.equal(gone!.total_tracks, null, 'its total is unknown, not 0');
    assert.equal(gone!.coverage, null, 'no coverage ratio was computed from an unknown total');
    assert.equal(
      p.near_complete.some((f) => f.album_id === 'gone'),
      false,
      'an album whose total could not be read is excluded from the findings, not reported as complete',
    );
    assert.equal(p.counts.near_complete, 2, 'the two readable albums are still reported');
  });

  it('does not accept a nonsensical zero as an answer', async () => {
    // `total_tracks: 0` is what an unreadable field can decay into. Treating it
    // as truth would drop the album from the findings with no disclosure at
    // all — the read is the honest answer.
    const specs = [
      { id: 'zeroed', name: 'Zeroed', likedCount: 8, totalTracks: 10 },
      { id: 'real', name: 'Real', likedCount: 8, totalTracks: 10 },
    ];
    // Overwrite the walk rows so one album carries a zero total.
    const { responder, albumReads } = library(specs);
    const zeroed = harness((path, arg, method) => {
      if (path === '/me/tracks') {
        const page = responder(path, arg, method) as { items: Array<{ track: { album: Record<string, unknown> } }> };
        return {
          ...page,
          items: page.items.map((row) =>
            row.track.album.id === 'zeroed' ? { ...row, track: { ...row.track, album: { ...row.track.album, total_tracks: 0 } } } : row,
          ),
        };
      }
      return responder(path, arg, method);
    });

    const out = await zeroed.invoke('library_hygiene', { response_format: 'json' });
    const p = payloadOf(out);

    assert.deepEqual(
      albumReads,
      ['zeroed'],
      'a zero total is not an answer — that album still goes to the per-id read',
    );
    assert.equal(p.album_lookups.shared_from_walk, 1, 'only the album with a usable total was shared');
    assert.equal(p.counts.near_complete, 2, 'both albums end up reported once the zero is replaced by a real read');
  });
});

// ---------------------------------------------------------------------------
// The dry-run preview
// ---------------------------------------------------------------------------

describe('#897 the dry-run preview budgets the fallback, not the old fan-in', () => {
  it('marks the album figure an upper bound, since the walk normally answers', async () => {
    const out = await harness(() => undefined).invoke('library_hygiene', { dry_run: true });
    const text = out.content.map((c) => c.text).join('\n');

    assert.match(text, /at most ~\d+ requests, 0 made/, 'the cost is stated as a worst case');
    assert.match(
      text,
      /each \/me\/tracks row already carries its album's track total/,
      'the preview says why the fan-in is a fallback rather than the expected cost',
    );
  });
});
