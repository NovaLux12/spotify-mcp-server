/**
 * Regression: deep_cuts_finder's single-exclusion set was a walk frozen at a
 * literal 200 releases (#821). An artist with more singles than that had real
 * singles exported as "deep cuts" while the prose promised tracks "neither the
 * title track nor released as singles" — and nothing in the payload said the
 * walk was short.
 *
 * The bound is now the configured fetch-all cap, the walk reports its own
 * truncation verdict, and that verdict reaches both prose and payload.
 * album_track_explorer's parallel literal-50 ceiling is bound and disclosed the
 * same way, so the family has one contract.
 *
 * Run: node --import tsx --test tests/tools.swarm3b-deep-cuts.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { initConfig } from '../src/config.js';
import { registerSwarm3bDiscoveryTools } from '../src/tools/swarm3b_discovery.js';

type ToolOut = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
};

interface Release {
  id: string;
  name: string;
  release_date: string;
  album_type: string;
}

interface Track {
  id: string;
  name: string;
  track_number: number;
  duration_ms: number;
}

function track(name: string, trackNumber: number, durationMs = 200_000): Track {
  return { id: `t-${name}`, name, track_number: trackNumber, duration_ms: durationMs };
}

/** A studio album: title track at 3, one buried non-single track at 4. */
function albumTracks(name: string, extras: Track[] = []): { tracks: { items: Track[] } } {
  return {
    tracks: {
      items: [
        track(`${name} opener`, 1, 1000),
        track(`${name} second`, 2, 1000),
        track(name, 3, 1000),
        track(`${name} buried gem`, 4),
        ...extras,
      ],
    },
  };
}

interface Options {
  singles?: Release[];
  albums?: Release[];
  /** Track names carried by each single, keyed by single id. */
  singleTracks?: Record<string, string[]>;
  /** Extra album tracks (positions 5+) keyed by album id. */
  albumExtras?: Record<string, Track[]>;
  /** Server-reported total for the singles walk; > bound ⇒ truncated. */
  singlesTotal?: number;
  fetchAllCap?: number;
}

function registerWithCap(client: unknown, fetchAllCap: number | undefined): RegisteredTool[] {
  if (fetchAllCap !== undefined) initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: String(fetchAllCap) });
  else initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '' });
  return registerWith(client);
}

function registerWith(client: unknown): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;
  registerSwarm3bDiscoveryTools(fakeServer, client as SpotifyClient);
  return registered;
}

function harness(options: Options = {}) {
  const singles = options.singles ?? [];
  const albums = options.albums ?? [];
  const singleTracks = options.singleTracks ?? {};
  const extras = options.albumExtras ?? {};
  const singlesWalks: number[] = [];

  const meta = (r: Release, withTracks: { tracks: { items: Track[] } }) => ({ ...r, ...withTracks });

  const client = {
    async get(path: string, params: Record<string, string> = {}) {
      if (path === '/albums') {
        const ids = new Set((params.ids ?? '').split(','));
        return {
          albums: [
            ...albums.filter((a) => ids.has(a.id)).map((a) => meta(a, albumTracks(a.name, extras[a.id] ?? []))),
            ...singles.filter((s) => ids.has(s.id)).map((s) =>
              meta(s, { tracks: { items: (singleTracks[s.id] ?? []).map((n, i) => track(n, i + 1, 180_000)) } })),
          ],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    // Same semantics as getAllPagesWithTruncation, minus the verdict. The
    // pre-fix code called the bare walk, so it has to walk correctly here —
    // otherwise the test would fail on a missing method instead of on the
    // defect.
    async getAllPages<T>(_path: string, params: Record<string, string>, opts?: { maxItems?: number }) {
      const isSingles = params.include_groups === 'single';
      const rows = isSingles ? singles : albums;
      const maxItems = opts?.maxItems ?? 0;
      if (isSingles) singlesWalks.push(maxItems);
      return rows.slice(0, maxItems) as T[];
    },
    async getAllPagesWithTruncation<T>(_path: string, params: Record<string, string>, opts?: { maxItems?: number }) {
      const isSingles = params.include_groups === 'single';
      const rows = isSingles ? singles : albums;
      const maxItems = opts?.maxItems ?? 0;
      if (isSingles) singlesWalks.push(maxItems);
      const truncated = isSingles && (options.singlesTotal ?? rows.length) > maxItems;
      return { items: (truncated ? rows.slice(0, maxItems) : rows) as T[], truncated };
    },
  };

  // getConfig() is memoised, so the cap has to be injected through initConfig
  // rather than the environment once the process is up.
  const prev = { ...process.env };
  const registered = registerWithCap(client, options.fetchAllCap);
  process.env = prev;

  return {
    singlesWalks,
    call: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} not registered`);
      return tool.handler(tool.validate(args));
    },
    names: (res: ToolOut) => (res.structuredContent!.items as Array<{ name: string }>).map((r) => r.name),
  };
}

const ARTIST_ID = 'aBcDeFgHiJkLmNoPqRsTuV';
const ALBUM_ID = 'VwXyZ0123456789AbCdEfG';
const ALBUM: Release = { id: ALBUM_ID, name: 'Record One', release_date: '2020-01-01', album_type: 'album' };

describe('deep_cuts_finder bounds and discloses the single-exclusion walk (#821)', () => {
  it('excludes a track carried by a scanned single', async () => {
    const h = harness({
      albums: [ALBUM],
      singles: [{ id: 's1', name: 'Promo', release_date: '2019-01-01', album_type: 'single' }],
      singleTracks: { s1: ['Promo Song'] },
      albumExtras: { [ALBUM_ID]: [track('Promo Song', 5)] },
    });
    const res = await h.call('deep_cuts_finder', { artist_id: ARTIST_ID });
    const names = h.names(res);
    assert.ok(!names.includes('Promo Song'), 'a track on a scanned single must not be a deep cut');
    assert.ok(names.includes('Record One buried gem'), 'the non-single album track must still be listed');
    assert.equal(res.structuredContent!.singles_scanned, 1);
    assert.equal(res.structuredContent!.singles_bound, 500);
    assert.equal(res.structuredContent!.singles_capped, false);
    assert.match(res.content[0]!.text, /exclusion checked against all 1 single/);
  });

  it('bounds the singles walk by the configured fetch cap, not a frozen 200', async () => {
    const h = harness({ albums: [ALBUM], singles: [] });
    await h.call('deep_cuts_finder', { artist_id: ARTIST_ID });
    assert.deepEqual(h.singlesWalks, [500], 'default bound must be SPOTIFY_MCP_FETCH_ALL_CAP (500)');
  });

  it('clamps both a lower configured cap and a caller max_singles to it', async () => {
    const h = harness({ albums: [ALBUM], singles: [], fetchAllCap: 30 });
    const res = await h.call('deep_cuts_finder', { artist_id: ARTIST_ID, max_singles: 500 });
    assert.deepEqual(h.singlesWalks, [30], 'max_singles must clamp down to the configured cap');
    assert.equal(res.structuredContent!.singles_bound, 30);

    const h2 = harness({ albums: [ALBUM], singles: [], fetchAllCap: 900 });
    await h2.call('deep_cuts_finder', { artist_id: ARTIST_ID, max_singles: 40 });
    assert.deepEqual(h2.singlesWalks, [40], 'a smaller max_singles wins when under the cap');
  });

  it('scans 250 singles in full and lists none of their tracks as deep cuts', async () => {
    const singles: Release[] = [];
    const singleTracks: Record<string, string[]> = {};
    const hitNames: string[] = [];
    for (let i = 0; i < 250; i++) {
      singles.push({ id: `s${i}`, name: `Single ${i}`, release_date: `${2000 + i}-01-01`, album_type: 'single' });
      singleTracks[`s${i}`] = [`Hit ${i}`];
      hitNames.push(`Hit ${i}`);
    }
    // One album carrying every single's track at position 5+. Pre-fix this
    // walk read only the first 200 singles, so 50 of them leaked into the
    // deep-cut list under a prose line that claimed none could.
    const h = harness({
      albums: [ALBUM],
      singles,
      singleTracks,
      albumExtras: { [ALBUM_ID]: hitNames.map((n, i) => track(n, 5 + i)) },
      singlesTotal: 250,
    });
    const res = await h.call('deep_cuts_finder', { artist_id: ARTIST_ID, cuts_per_album: 10 });
    const leaked = h.names(res).filter((n) => /^Hit \d+$/.test(n));
    assert.deepEqual(leaked, [], 'no track from a scanned single may be listed as a deep cut');
    assert.equal(res.structuredContent!.singles_scanned, 250);
    assert.equal(res.structuredContent!.singles_capped, false);
  });

  it('reports singles_capped and drops the absolute exclusion claim when bounded', async () => {
    const singles: Release[] = [];
    const singleTracks: Record<string, string[]> = {};
    for (let i = 0; i < 900; i++) {
      singles.push({ id: `s${i}`, name: `Single ${i}`, release_date: `${2000 + i}-01-01`, album_type: 'single' });
      singleTracks[`s${i}`] = [`Hit ${i}`];
    }
    const h = harness({ albums: [ALBUM], singles, singleTracks, singlesTotal: 900 });
    const res = await h.call('deep_cuts_finder', { artist_id: ARTIST_ID });
    // Prose first: on pre-fix code this is the line that lies, and the payload
    // assertions below only exist once the verdict is reported at all.
    const text = res.content[0]!.text;
    assert.doesNotMatch(text, /singles excluded/, 'a bounded walk must not claim absolute exclusion');
    assert.match(text, /may contain them/);
    assert.equal(res.structuredContent!.singles_capped, true);
    assert.equal(res.structuredContent!.singles_scanned, 500);
    assert.equal(res.structuredContent!.singles_bound, 500);
  });
});

describe('album_track_explorer discloses its comparison bound', () => {
  it('walks to the configured cap and flags a bounded comparison', async () => {
    const discography: Release[] = [];
    for (let i = 0; i < 120; i++) {
      discography.push({ id: `d${i}`, name: `Rec ${i}`, release_date: `${2000 + i}-01-01`, album_type: 'single' });
    }
    const albumTrackList = [track('Record One opener', 1, 1000), track('Record One second', 2, 1000)];
    const walkBounds: number[] = [];
    const client = {
      async get(path: string, params: Record<string, string> = {}) {
        if (path === '/albums') {
          const ids = new Set((params.ids ?? '').split(','));
          return {
            albums: discography.filter((d) => ids.has(d.id)).map((d) => ({ ...d, tracks: { items: [track(`Rec ${d.id.slice(1)}`, 1, 1000)] } })),
          };
        }
        if (path === `/albums/${ALBUM_ID}`) {
          return { id: ALBUM_ID, name: 'Record One', release_date: '2020-01-01', total_tracks: 2, artists: [{ id: ARTIST_ID }], label: 'Test', tracks: { items: [] } };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      async getAllPages<T>(path: string) {
        if (path.endsWith('/tracks')) return albumTrackList as T[];
        return discography.slice(0, 50) as T[];
      },
      async getAllPagesWithTruncation<T>(_p: string, _q: Record<string, string>, opts?: { maxItems?: number }) {
        walkBounds.push(opts?.maxItems ?? -1);
        return { items: discography as T[], truncated: false };
      },
    };
    const registered = registerWith(client);
    const tool = registered.find((t) => t.name === 'album_track_explorer')!;
    const res = await tool.handler(tool.validate({ album_id: ALBUM_ID }));
    assert.equal(walkBounds[0], 500, 'explorer walk must follow the configured cap, not a literal 50');
    assert.equal(res.structuredContent!.releases_compared, 50);
    assert.equal(res.structuredContent!.comparison_capped, true, 'only 50 of 120 other releases are compared');
    assert.match(res.content[0]!.text, /comparison bounded/);
  });
});
