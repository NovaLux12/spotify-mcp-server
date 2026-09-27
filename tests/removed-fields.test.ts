/**
 * #639 — Spotify's February 2026 response-FIELD removals.
 *
 * The failure this file exists to stop is not "reads a field that is gone". It
 * is AGGREGATING a field that is gone. Every guarded single-value read of a
 * removed field in this repository was already honest — the `?? 0` sites were
 * fixed earlier, and the ones that print a placeholder print a self-describing
 * token. What was not honest was using the field as a bucket key, a group
 * label, a match predicate or a count, because there a placeholder stops being
 * a token and becomes a finding:
 *
 *     const lbl = album.label ?? '(unknown label)';    // swarm3_discovery
 *
 * `label` is gone, so *every successfully-read album* takes the fallback. The
 * census did not report a missing facet; it reported one label called
 * `(unknown label)` containing all N albums, and published
 * `distinct_labels: 1` as a finding about the listener's library. The comment
 * above that line carefully excluded albums whose read FAILED so a failed
 * lookup would not be filed as a real label — and the field removal guaranteed
 * every SUCCESSFUL read was filed there anyway. That is the #803 class one
 * aggregation layer over: a value that could not be read, reported as a
 * measurement.
 *
 * `find_show_by_publisher` was the same bug as a predicate, and worse in a way
 * only a test can show: matching against the constant placeholder meant a real
 * query ("Wondery") returned `0 publisher match(es)` — a false negative dressed
 * as a search — while a query of `"unknown"` matched every row and stamped each
 * `publisher_match: true`. Both directions were reported as a searched answer.
 *
 * So the fixture below is built the way a CURRENT registration answers: albums
 * and shows with no `label` and no `publisher` at all. Every tool that groups or
 * matches on those fields must then report absence as absence. Each test names
 * the fabricated string it is forbidding, and the positive-control tests prove
 * the tools still do real work when a grandfathered registration does send the
 * field — a fix that made every path "unavailable" would pass all of these and
 * be worthless.
 *
 * No network, no token file access, no port binding: stub client and stub
 * McpServer only, exactly as tests/tools.swarm3library.test.ts does it.
 *
 * Run: node --import tsx --test tests/removed-fields.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { installGatedPathContract } from '../src/gating.js';
import {
  FEB_2026_REMOVED_FIELDS,
  FEB_2026_REMOVED_FIELD_NAMES,
  FEB_2026_REMOVED_FIXTURES,
  facetGroups,
  facetUnavailableReason,
  publisherByline,
  removedFieldsFor,
} from '../src/removed.js';
import { registerSwarm3LibraryTools } from '../src/tools/swarm3_library.js';
import { registerSwarm3DiscoveryTools } from '../src/tools/swarm3_discovery.js';
import { registerSwarm3bDiscoveryTools } from '../src/tools/swarm3b_discovery.js';
import { registerSwarm3ShowsTools } from '../src/tools/swarm3_shows.js';
import { collectDoctorReport } from '../src/tools/doctortool.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineOf, splitCommentsAndCode, walkTypeScriptFiles } from './ts-source-scan.js';

// ---------------------------------------------------------------------------
// 1. The transcribed list itself
// ---------------------------------------------------------------------------

describe('the February 2026 removed-field list (#639)', () => {
  /**
   * Written out here rather than imported, so the registry cannot be edited
   * into agreeing with itself. Each entry is `field:types` exactly as the
   * changelog's "Changes to fields" section orders them.
   */
  const TRANSCRIBED = [
    'album_group:album',
    'available_markets:album',
    'label:album',
    'popularity:album',
    'followers:artist',
    'popularity:artist',
    'available_markets:audiobook',
    'publisher:audiobook',
    'available_markets:chapter',
    'available_markets:show',
    'publisher:show',
    'available_markets:track',
    'linked_from:track',
    'popularity:track',
    'country:user',
    'email:user',
    'explicit_content:user',
    'followers:user',
    'product:user',
  ];

  it('matches the changelog transcription, entry for entry', () => {
    const actual = FEB_2026_REMOVED_FIELDS.map((r) => `${r.field}:${[...r.types].join(',')}`).sort();
    assert.deepEqual(actual, [...TRANSCRIBED].sort());
  });

  it('carries a changelog description for every row', () => {
    for (const row of FEB_2026_REMOVED_FIELDS) {
      assert.ok(row.changelog.length > 10, `${row.field} must cite the changelog's own wording`);
    }
  });

  it('does NOT list external_ids, which March 2026 reverted', () => {
    // The single most likely way for this list to be wrong: recording the
    // February `[REMOVED] external_ids` without the March `[REVERTED]` that
    // restored it. Code reading external_ids is CORRECT; asserting its absence
    // here is what stops a future reader "fixing" it into a guard.
    assert.equal(
      FEB_2026_REMOVED_FIELD_NAMES.includes('external_ids'),
      false,
      'album/track external_ids were REVERTED in March 2026 and must not be listed as removed',
    );
  });

  it('does not list playlist followers, which the changelog did not remove', () => {
    // Spotify removed the followers ENDPOINTS (see GATED_FAMILIES and #638),
    // not the `followers` field on a playlist object. The field-removal list
    // and the endpoint-removal list are different tables and must not be
    // merged.
    const playlistRows = FEB_2026_REMOVED_FIELDS.filter((r) => r.types.includes('playlist'));
    assert.deepEqual(playlistRows, []);
  });

  it('has a fixture for every content type a row names', () => {
    for (const row of FEB_2026_REMOVED_FIELDS) {
      for (const type of row.types) {
        assert.ok(
          FEB_2026_REMOVED_FIXTURES[type],
          `type "${type}" has a removal row but no fixture, so its removal is untestable`,
        );
      }
    }
  });

  it('stubs every fixture with the field actually absent', () => {
    // The fixtures are only meaningful if they reproduce the current
    // registration's answer. A fixture that still carried the field would make
    // every assertion below vacuous.
    for (const [type, fixture] of Object.entries(FEB_2026_REMOVED_FIXTURES)) {
      for (const field of removedFieldsFor(type)) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(fixture.base, field),
          false,
          `${type} fixture must NOT carry ${field}`,
        );
      }
    }
  });

  it('answers per-type queries from the same table it publishes', () => {
    assert.deepEqual([...removedFieldsFor('album')].sort(), ['album_group', 'available_markets', 'label', 'popularity']);
    // A type listed twice in one query result means the registry carries a
    // consolidated row AND a per-type row for the same field.
    assert.deepEqual([...removedFieldsFor('show')].sort(), ['available_markets', 'publisher']);
    assert.deepEqual([...removedFieldsFor('user')].sort(), [
      'country', 'email', 'explicit_content', 'followers', 'product',
    ]);
    assert.deepEqual([...removedFieldsFor('playlist')], []);
  });
});

// ---------------------------------------------------------------------------
// 2. The accessor layer
// ---------------------------------------------------------------------------

describe('the removed-field accessor layer (#639)', () => {
  it('puts a row with no value in NO bucket, and reports the coverage', () => {
    const rows = [
      { label: 'Aurora Records' },
      { label: null },
      { label: 'Aurora Records' },
      { label: '   ' },
    ];
    const { groups, reported, missing } = facetGroups(rows, (r) => r.label);
    assert.equal(reported, 2, 'only rows that actually carry a value are reported');
    assert.equal(missing, 2, 'absent and blank both count as missing, not as a value');
    assert.deepEqual([...groups.keys()], ['Aurora Records']);
    assert.equal(groups.get('Aurora Records')!.length, 2);
  });

  it('never invents a bucket name for the whole set', () => {
    // The exact shape of the shipped bug: every row has no label, so the old
    // `?? '(unknown label)'` produced ONE bucket holding everything.
    const rows = [{ label: undefined }, { label: undefined }, { label: undefined }];
    const { groups, reported, missing } = facetGroups(rows, (r) => r.label);
    assert.equal(groups.size, 0, 'a facet nobody reports yields no groups at all');
    assert.equal(reported, 0);
    assert.equal(missing, 3);
  });

  it('trims a value rather than bucketing on its whitespace', () => {
    const { groups } = facetGroups([{ label: '  Aurora  ' }, { label: 'Aurora' }], (r) => r.label);
    assert.deepEqual([...groups.keys()], ['Aurora']);
    assert.equal(groups.get('Aurora')!.length, 2);
  });

  it('drops an absent publisher byline and keeps a real one', () => {
    assert.equal(publisherByline(undefined), '');
    assert.equal(publisherByline(null), '');
    assert.equal(publisherByline(''), '');
    assert.equal(publisherByline('   '), '');
    assert.equal(publisherByline('Wondery'), ' by Wondery');
  });

  it('names the changelog row in the unavailable reason', () => {
    const reason = facetUnavailableReason('label', 'album');
    assert.match(reason, /`label`/);
    assert.match(reason, /album/);
    assert.match(reason, /February 2026/);
  });
});

// ---------------------------------------------------------------------------
// 3. The tools, driven against a CURRENT registration's answer
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

type Library = Record<string, unknown>;

/**
 * Stub server + stub client. `library` maps a request path to the payload it
 * answers with, or to a thunk when a call must fail.
 */
function harness(library: Library, register: (s: McpServer, c: SpotifyClient) => void) {
  const client = {
    async get<T>(path: string): Promise<T | null> {
      if (!(path in library)) throw new Error(`unstubbed GET ${path}`);
      const entry = library[path];
      return (typeof entry === 'function' ? (entry as () => unknown)() : entry) as T | null;
    },
    async getAllPages<T>(path: string): Promise<T[]> {
      if (!(path in library)) throw new Error(`unstubbed walk of ${path}`);
      const rows = library[path];
      if (!Array.isArray(rows)) throw new Error(`walk of ${path} must be stubbed with rows`);
      return rows as T[];
    },
    getRateLimitStatus: () => ({ cooldownRemainingMs: 0, requestsLastMinute: 0, requestsLastHour: 0, requestsTotal: 0 }),
  };
  installGatedPathContract(client as unknown as SpotifyClient);

  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;
  register(fakeServer, client as unknown as SpotifyClient);

  const invoke = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((t) => t.name === name);
    assert.ok(tool, `tool "${name}" must be registered`);
    const parsed = z.object(tool.schema).parse(args) as Record<string, unknown>;
    const res = await tool.handler(parsed);
    return {
      text: res.content.map((c) => c.text).join('\n'),
      payload: (res.structuredContent ?? {}) as Record<string, never>,
      items: () => ((res.structuredContent as { items?: unknown[] }).items ?? []),
    };
  };
  return { invoke };
}

/** A saved album as a current registration returns it: no `label` anywhere. */
const savableAlbum = (id: string, name: string, releaseDate: string, label?: string) => ({
  added_at: '2026-01-01T00:00:00Z',
  album: {
    id, name, uri: `spotify:album:${id}`, album_type: 'album', release_date: releaseDate,
    total_tracks: 10, label, genres: [], images: [],
    artists: [{ id: 'ar1', name: 'Artist', uri: 'spotify:artist:ar1' }],
    tracks: { total: 10, items: [] },
  },
});

/** A saved show as a current registration returns it: no `publisher`. */
const savableShow = (id: string, name: string, publisher?: string) => ({
  added_at: '2026-01-01T00:00:00Z',
  show: {
    id, name, uri: `spotify:show:${id}`, description: 'd', total_episodes: 12,
    explicit: false, languages: ['en'], media_type: 'programmatic', publisher,
    images: [], publishers: [],
  },
});

describe('saved_albums_by_label never files a removed field under a bucket (#639)', () => {
  const library = (withLabel?: string) => ({
    '/me/albums': [savableAlbum('a1', 'One', '2020-01-01', withLabel), savableAlbum('a2', 'Two', '2021-01-01', withLabel)],
  });

  it('reports available:false, not one "(no label in payload)" bucket (#639)', async () => {
    const { invoke } = harness(library(), registerSwarm3LibraryTools);
    const { text, payload } = await invoke('saved_albums_by_label', { response_format: 'concise' });
    assert.equal(payload.available, false, 'the facet is gone, and the tool must say so');
    assert.equal(payload.reason as string, facetUnavailableReason('label', 'album'));
    assert.equal(payload.distinct_labels as number, 0);
    assert.deepEqual(payload.items ?? [], [], 'no fabricated bucket may be published');
    assert.doesNotMatch(text, /\(no label in payload\)/, 'the #639 placeholder must not appear');
  });

  it('publishes the coverage that makes the totals checkable', async () => {
    const { invoke } = harness(library(), registerSwarm3LibraryTools);
    const { payload } = await invoke('saved_albums_by_label', { response_format: 'json' });
    assert.equal(payload.albums_without_label as number, 2);
    assert.equal(payload.albums_labelled as number, 0);
  });

  it('POSITIVE CONTROL: still ranks real labels when a registration sends them', async () => {
    // The point of the fix is not "always unavailable". A grandfathered
    // registration still returns the field, and the tool must keep working.
    const { invoke } = harness({
      '/me/albums': [savableAlbum('a1', 'One', '2020-01-01', 'Aurora Records'), savableAlbum('a2', 'Two', '2021-01-01', 'Aurora Records')],
    }, registerSwarm3LibraryTools);
    const { text, payload } = await invoke('saved_albums_by_label', { response_format: 'concise' });
    assert.equal(payload.distinct_labels as number, 1);
    assert.match(text, /Aurora Records: 2/);
    assert.equal(payload.available, undefined, 'a real facet is not reported unavailable');
  });

  it('POSITIVE CONTROL: discloses partial coverage rather than over-claiming', async () => {
    const { invoke } = harness({
      '/me/albums': [savableAlbum('a1', 'One', '2020-01-01', 'Aurora Records'), savableAlbum('a2', 'Two', '2021-01-01')],
    }, registerSwarm3LibraryTools);
    const { text, payload } = await invoke('saved_albums_by_label', { response_format: 'concise' });
    assert.equal(payload.albums_labelled as number, 1);
    assert.equal(payload.albums_without_label as number, 1);
    assert.match(text, /1\/2 saved albums/, 'a partial census must state its coverage');
  });
});

describe('saved_shows_publisher_census never groups by a removed field (#639)', () => {
  const library = (publisher?: string) => ({ '/me/shows': [savableShow('s1', 'Show One', publisher), savableShow('s2', 'Show Two', publisher)] });

  it('reports available:false, not one "(unknown publisher)" bucket', async () => {
    const { invoke } = harness(library(), registerSwarm3ShowsTools);
    const { text, payload } = await invoke('saved_shows_publisher_census', { response_format: 'concise' });
    assert.equal(payload.available, false);
    assert.equal(payload.reason as string, facetUnavailableReason('publisher', 'show'));
    assert.equal(payload.distinct_publishers as number, 0);
    assert.deepEqual(payload.publishers ?? [], []);
    assert.doesNotMatch(text, /\(unknown publisher\)/, 'the #639 placeholder must not appear');
    assert.doesNotMatch(text, /1 distinct publisher/, 'no fabricated publisher count may be printed');
  });

  it('POSITIVE CONTROL: still censuses real publishers when a registration sends them', async () => {
    const { invoke } = harness(library('Wondery'), registerSwarm3ShowsTools);
    const { text, payload } = await invoke('saved_shows_publisher_census', { response_format: 'concise' });
    assert.equal(payload.distinct_publishers as number, 1);
    assert.match(text, /Wondery: 2 show\(s\)/);
  });
});

describe('publisher_portfolio never keys a portfolio on a removed field (#639)', () => {
  it('reports available:false rather than a fabricated portfolio with a runtime', async () => {
    const { invoke } = harness({
      '/me/shows': [savableShow('s1', 'Show One'), savableShow('s2', 'Show Two')],
      '/shows/s1/episodes': [{ id: 'e1', name: 'Ep', duration_ms: 1800000, release_date: '2026-01-01', explicit: false }],
      '/shows/s2/episodes': [{ id: 'e2', name: 'Ep', duration_ms: 1800000, release_date: '2026-01-01', explicit: false }],
    }, registerSwarm3ShowsTools);
    const { text, payload } = await invoke('publisher_portfolio', { response_format: 'concise' });
    assert.equal(payload.available, false);
    assert.equal(payload.reason as string, facetUnavailableReason('publisher', 'show'));
    assert.deepEqual(payload.portfolio ?? [], []);
    assert.doesNotMatch(text, /\(unknown publisher\)/);
    // The strongest form of the old bug: a real sampled RUNTIME attached to a
    // publisher that does not exist.
    assert.doesNotMatch(text, /sampled runtime/, 'no runtime may be attributed to a fabricated publisher');
  });
});

describe('find_show_by_publisher reports an absent facet as "not searched" (#639)', () => {
  const library = (publisher?: string) => ({
    '/search': {
      shows: {
        total: 2,
        items: [savableShow('s1', 'Wondery Daily', publisher).show, savableShow('s2', 'Other Show', publisher).show],
      },
    },
  });

  it('reports publisher_matches:null, NOT 0 — a zero reads as "none found"', async () => {
    const { invoke } = harness(library(), registerSwarm3ShowsTools);
    const { text, payload } = await invoke('find_show_by_publisher', { query: 'Wondery', response_format: 'json' });
    assert.equal(payload.publisher_facet_available, false);
    assert.equal(payload.publisher_matches, null, 'null = not searched; 0 = none found. They are different facts.');
    assert.equal(payload.reason as string, facetUnavailableReason('publisher', 'show'));
  });

  it('does not let a query of "unknown" mark every row a publisher match', async () => {
    // The false-positive direction: matching the CONSTANT placeholder meant
    // `'(unknown publisher)'.includes('unknown')` was true for every row, and
    // every row was stamped `publisher_match: true` and rendered with a star.
    const { invoke } = harness(library(), registerSwarm3ShowsTools);
    const { text, payload } = await invoke('find_show_by_publisher', { query: 'unknown', response_format: 'json' });
    assert.equal(payload.publisher_facet_available, false);
    for (const row of payload.shows as Array<{ publisher_match: boolean }>) {
      assert.equal(row.publisher_match, false, 'no row may be marked a publisher match on a facet that was not searched');
    }
    assert.doesNotMatch(text, /★/, 'the publisher-match legend and stars must be gone when nothing was matched');
  });

  it('still matches on publisher when a registration sends the field', async () => {
    const { invoke } = harness({
      '/search': {
        shows: {
          total: 2,
          items: [
            savableShow('s1', 'Wondery Daily', 'Wondery').show,
            savableShow('s2', 'Other Show', 'Elsewhere').show,
          ],
        },
      },
    }, registerSwarm3ShowsTools);
    const { text, payload } = await invoke('find_show_by_publisher', { query: 'Wondery', response_format: 'concise' });
    assert.equal(payload.publisher_facet_available, true);
    assert.equal(payload.publisher_matches as number, 1, 'exactly the one show actually published by Wondery');
    assert.match(text, /★/, 'a real publisher match is still marked as one');
  });
});

describe('label_explorer and label_discography_explorer never bucket a removed field (#639)', () => {
  it('label_explorer reports available:false when no album carries a label', async () => {
    const { invoke } = harness({
      '/me/albums': [savableAlbum('a1', 'One', '2020-01-01'), savableAlbum('a2', 'Two', '2021-01-01')],
      '/albums/a1': savableAlbum('a1', 'One', '2020-01-01').album,
      '/albums/a2': savableAlbum('a2', 'Two', '2021-01-01').album,
    }, registerSwarm3DiscoveryTools);
    const { text, payload } = await invoke('label_explorer', { response_format: 'json' });
    assert.equal(payload.available, false);
    assert.equal(payload.reason as string, facetUnavailableReason('label', 'album'));
    assert.equal(payload.distinct_labels as number, 0);
    assert.deepEqual(payload.labels ?? [], []);
    assert.doesNotMatch(text, /\(unknown label\)/);
  });

  it('label_explorer still censuses when a registration sends the field', async () => {
    const withLabel = (id: string, name: string) => savableAlbum(id, name, '2020-01-01', 'Aurora Records').album;
    const { invoke } = harness({
      '/me/albums': [savableAlbum('a1', 'One', '2020-01-01', 'Aurora Records'), savableAlbum('a2', 'Two', '2021-01-01', 'Aurora Records')],
      '/albums/a1': withLabel('a1', 'One'),
      '/albums/a2': withLabel('a2', 'Two'),
    }, registerSwarm3DiscoveryTools);
    const { payload } = await invoke('label_explorer', { response_format: 'json' });
    assert.equal(payload.available, undefined);
    assert.equal(payload.distinct_labels as number, 1);
  });

  it('label_discography_explorer reports available:false when no release carries a label', async () => {
    // spotifyId() validates a 22-char base62 id, so the fixture uses one.
    const ARTIST = '4aGhxSJJKtOGYe0ZQBS1eT';
    const { invoke } = harness({
      // The discography walk is a getAllPages, so the stub is the row list.
      [`/artists/${ARTIST}/albums`]: [
        { id: 'a1', name: 'One', uri: 'spotify:album:a1', album_type: 'album', release_date: '2020-01-01', total_tracks: 10, artists: [], images: [] },
      ],
      '/albums/a1': savableAlbum('a1', 'One', '2020-01-01').album,
    }, registerSwarm3bDiscoveryTools);
    const { text, payload } = await invoke('label_discography_explorer', { artist_id: ARTIST, response_format: 'json' });
    assert.equal(payload.available, false);
    assert.equal(payload.reason as string, facetUnavailableReason('label', 'album'));
    assert.deepEqual(payload.items ?? [], []);
    assert.doesNotMatch(text, /\(unknown label\)/);
  });
});

describe('doctor does not derive a Premium verdict from a removed field (#639)', () => {
  const client = (me: Record<string, unknown>) =>
    ({
      async get<T>(): Promise<T | null> { return me as unknown as T; },
      getRateLimitStatus: () => ({ cooldownRemainingMs: 0, requestsLastMinute: 0, requestsLastHour: 0, requestsTotal: 0 }),
    }) as unknown as SpotifyClient;

  it('emits the account_premium row when /me carries no product', async () => {
    // The silent-drop bug: `product` was coerced to 'unknown', matched neither
    // branch of an if/else-if with no else, and the `account_premium` row
    // VANISHED — a caller scanning for a Premium verdict saw nothing and could
    // read the silence as "no problem found".
    const report = await collectDoctorReport(client({ id: 'u1', display_name: 'Listener' }));
    const row = report.rows.find((r) => r.id === 'account_premium');
    assert.ok(row, 'the account_premium row must be present even when the tier is unknowable');
    assert.match(row.summary, /not determinable/);
    assert.match(row.summary, /February 2026/, 'the row must say why it is undeterminable');
  });

  it('never prints a fabricated product=unknown key/value reading', async () => {
    const report = await collectDoctorReport(client({ id: 'u1', display_name: 'Listener' }));
    const account = report.rows.find((r) => r.id === 'account');
    assert.ok(account);
    assert.doesNotMatch(account.summary, /product=unknown/);
    assert.doesNotMatch(account.detail ?? '', /product=unknown/);
    assert.match(account.summary, /product=not returned/);
  });

  it('POSITIVE CONTROL: still reports a real Premium verdict when product is present', async () => {
    const report = await collectDoctorReport(client({ id: 'u1', display_name: 'Listener', product: 'premium' }));
    const row = report.rows.find((r) => r.id === 'account_premium');
    assert.equal(row?.status, 'pass');
    assert.match(row!.summary, /Premium/);
  });

  it('POSITIVE CONTROL: still reports a real Free verdict when product is present', async () => {
    const report = await collectDoctorReport(client({ id: 'u1', display_name: 'Listener', product: 'free' }));
    const row = report.rows.find((r) => r.id === 'account_premium');
    assert.equal(row?.status, 'info');
    assert.match(row!.summary, /Free/);
  });
});

// ---------------------------------------------------------------------------
// 4. A static guard over the placeholders themselves
// ---------------------------------------------------------------------------

/**
 * A placeholder standing in for a field Spotify removed.
 *
 * The rule is deliberately shaped around the FALLBACK, not around the words.
 * The broad version — "these strings may not appear in src/" — is unsound,
 * and it is worth being explicit about why, because a guard that fires on the
 * wrong thing is worse than no guard:
 *
 *   - `publisherByline('Unknown publisher')` is a REAL publisher name, and
 *     `labelOf('No Label in Payload')` a real label. A word ban rejects both.
 *   - `label` and `country` and `publisher` are used throughout this tree as
 *     ordinary local identifiers — device-preset labels, mood-template labels,
 *     `args.country` MARKET parameters. A ban on the identifier cannot tell
 *     those from a removed album field.
 *
 * What is actually wrong is SUBSTITUTION: `x.field ?? '(unknown label)'`. That
 * is the shape that converts an absent value into a bucket key, a byline or a
 * count, and it is unambiguous — a `??`/`||` immediately followed by one of
 * these literal placeholders is never anything else. So the guard matches the
 * fallback form only.
 */
const FABRICATED_PLACEHOLDER =
  /(?:\?\?|\|\|)\s*(['"`])\s*(?:\((?:unknown label|unknown publisher|no label in payload)\)|Unknown publisher|unknown publisher)\s*\1/g;

describe('no fabricated stand-in for a removed field reaches a caller (#639)', () => {
  it('ships none in caller-facing text under src/', () => {
    const hits: string[] = [];
    for (const rel of walkTypeScriptFiles('src')) {
      const source = readFileSync(rel, 'utf8');
      const { code } = splitCommentsAndCode(source);
      for (const m of code.matchAll(FABRICATED_PLACEHOLDER)) {
        hits.push(`${rel}:${lineOf(source, m.index)} ${code.slice(m.index, m.index + m[0].length)}`);
      }
    }
    assert.deepEqual(hits, [], `fabricated placeholders for removed fields must not survive:\n${hits.join('\n')}`);
  });

  it('would fire on the exact shapes #639 removed', () => {
    for (const historical of [
      "album.label ?? '(unknown label)'",
      "a.label ?? '(no label in payload)'",
      "show.publisher ?? '(unknown publisher)'",
      "show.publisher ?? 'unknown publisher'",
      "ab.publisher ?? 'Unknown publisher'",
      "return show.publisher || '(unknown publisher)';",
    ]) {
      FABRICATED_PLACEHOLDER.lastIndex = 0;
      assert.ok(
        FABRICATED_PLACEHOLDER.test(historical),
        `detector must match the historical shape: ${historical}`,
      );
    }
  });

  it('does not flag a real publisher or label name, nor an ordinary identifier', () => {
    for (const text of [
      "publisherByline('Wondery')",
      "publisherByline('Unknown publisher')",
      "releaseTypeOf({ album_type: 'Album' })",
      "const devicePresets = [{ label: 'Living Room' }];",
      "if (args.country) params.country = args.country;",
      "label: 'Focus'",
    ]) {
      FABRICATED_PLACEHOLDER.lastIndex = 0;
      assert.equal(FABRICATED_PLACEHOLDER.test(text), false, `must not flag: ${text}`);
    }
  });

  it('is looking at a real source surface', () => {
    const files = walkTypeScriptFiles('src');
    assert.ok(files.length > 20, `expected to scan a real tree, saw ${files.length} files`);
  });
});
