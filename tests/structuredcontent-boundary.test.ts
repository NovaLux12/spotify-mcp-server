/**
 * The structuredContent trust boundary (#1343).
 *
 * A cast at a payload boundary is not a type assertion — it is a decision to
 * stop checking. The failure mode is not a compile error; it is a value that
 * is confidently wrong at runtime, because the compiler never saw the payload.
 * That is the same shape as the shipped bugs in `AGENTS.md` §6: a correctly
 * named field carrying a value that was never read (#803), and a field whose
 * declared type the API can contradict, arriving as `undefined` (#804).
 *
 * Each case below pins a *runtime* consequence, not a type-level fact. The
 * compile-time half of this issue is not testable from a test file, and a test
 * that asserted it would be the "assertion derived from the same source as the
 * code under test" decoration `AGENTS.md` §6 warns about. So these assert what
 * a host actually receives, and each one fails on the pre-#1343 source:
 *
 *   - the cooldown payload is `ok: false`, and `library_hygiene` /
 *     `saved_dedupe` declared `ok: true` as a literal type. The cast over the
 *     contradiction is what stopped the compiler noticing.
 *   - an unreadable `added_at` sorted as the OLDEST row, because `?? ''` made
 *     it the smallest string (#803).
 *   - a show with no readable id built the request path `/shows//episodes`.
 *   - the `fetch_all` artist-albums walk published a `href: ''` that no
 *     request ever returned.
 *
 * Run: node --import tsx --test tests/structuredcontent-boundary.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { blankNonCode } from '../scripts/blank-non-code.mjs';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder } from './helpers/stub-client.js';
import { registerLibraryHygieneTools } from '../src/tools/libraryhygiene.js';
import { registerSavedDedupeTools } from '../src/tools/saveddedupe.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';
import { registerExhaust2MiscTools } from '../src/tools/exhaust2_misc.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { readString, readNumber, asRecord, structuredContent } from '../src/shaping.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Stub plumbing — same shape as tests/tools.libraryhygiene.test.ts
// ---------------------------------------------------------------------------

type Responder = (path: string, arg: unknown) => unknown;

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

function harness(register: (server: McpServer, client: never) => void, responder: Responder = () => null) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;
  const stub = new StubFromResponder(responder as LegacyResponder);
  register(fakeServer, stub as never);
  return {
    registered,
    client: stub,
    calls: stub.calls,
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

/** Force `quotaPreflight` to report an active cooldown. */
function withCooldown(client: StubFromResponder, waitSec = 42): void {
  // `getRateLimitStatus` is a prototype method, so it is shadowed on the
  // instance rather than reassigned on the prototype.
  Object.defineProperty(client, 'getRateLimitStatus', {
    value: () => ({ cooldownRemainingMs: waitSec * 1000, requestsTotal: 0 }),
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// The readers themselves
// ---------------------------------------------------------------------------

describe('#1343 — the boundary readers are runtime checks, not assertions', () => {
  it('readString returns the value only when the payload actually carried a string', () => {
    assert.equal(readString({ a: 'x' }, 'a'), 'x');
    // A number where a string was declared is a value the API contradicted,
    // not a string to coerce (#804).
    assert.equal(readString({ a: 7 }, 'a'), undefined);
    assert.equal(readString({ a: null }, 'a'), undefined);
    assert.equal(readString({ a: { b: 1 } }, 'a'), undefined);
    assert.equal(readString({}, 'a'), undefined);
  });

  it('readString walks a dotted path and stops at the first non-object', () => {
    assert.equal(readString({ added_by: { id: 'u1' } }, 'added_by.id'), 'u1');
    assert.equal(readString({ added_by: 'not-an-object' }, 'added_by.id'), undefined);
    assert.equal(readString({ added_by: { id: 5 } }, 'added_by.id'), undefined);
  });

  it('readNumber does not turn an absent or non-numeric count into 0', () => {
    assert.equal(readNumber({ n: 3 }, 'n'), 3);
    // The #803 coercion: a count that could not be read published as 0.
    assert.equal(readNumber({ n: '3' }, 'n'), undefined);
    assert.equal(readNumber({}, 'n'), undefined);
    assert.notEqual(readNumber({}, 'n'), 0);
    // NaN is a number to `typeof` but is not a count anybody read.
    assert.equal(readNumber({ n: Number.NaN }, 'n'), undefined);
  });

  it('asRecord rejects arrays and null, which typeof calls objects', () => {
    assert.equal(asRecord(null), undefined);
    assert.equal(asRecord(undefined), undefined);
    assert.equal(asRecord('str'), undefined);
    // An array admitted here is how a list length becomes a property read.
    assert.equal(asRecord([1, 2, 3]), undefined);
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  });

  it('structuredContent takes a union member without a cast at the call site', () => {
    // The pre-fix shape: `interface AnalysisResult` with `ok: true`, forced
    // through `as unknown as` to reach the wire. A `type` union needs neither.
    const payload = { ok: false, cooldown: true, wait_sec: 3 } as const;
    assert.equal(structuredContent(payload).cooldown, true);
  });
});

// ---------------------------------------------------------------------------
// The `ok: false` / `ok: true` contradiction
// ---------------------------------------------------------------------------

describe('#1343 — a cooldown refusal is `ok: false`, and the type admits it', () => {
  it('library_hygiene reports ok:false with no `scanned` or `groups` on cooldown', async () => {
    const h = harness(registerLibraryHygieneTools as never);
    withCooldown(h.client);
    const out = await h.invoke('library_hygiene');
    const sc = out.structuredContent;
    assert.ok(sc, 'a cooldown refusal must still put a payload on the wire');
    // The pre-fix bug: the payload said `ok: false` while the declared type
    // said `ok: true`, and the cast let both stand.
    assert.equal(sc.ok, false);
    assert.equal(sc.cooldown, true);
    assert.equal(sc.wait_sec, 42);
    assert.equal(sc.requests_made, 0);
    // A refusal is not a completed scan, so the scan-shaped keys must be
    // absent rather than zero-filled.
    assert.ok(!('scanned' in sc), 'a cooldown payload must not claim a scan happened');
    assert.ok(!('groups' in sc), 'a cooldown payload must not claim groups were found');
    // json mode prints the same payload, not a prose lie about it. The prose
    // modes return the gate's own message verbatim, which is not JSON, so ask
    // for the parseable mode explicitly.
    const jsonOut = await h.invoke('library_hygiene', { response_format: 'json' });
    const parsed = JSON.parse(textOf(jsonOut));
    assert.equal(parsed.ok, false);
  });

  it('library_hygiene dry_run issues no requests and claims no scan', async () => {
    const h = harness(registerLibraryHygieneTools as never, () => {
      throw new Error('dry_run must not call the API');
    });
    const out = await h.invoke('library_hygiene', { dry_run: true });
    const sc = out.structuredContent;
    assert.ok(sc);
    assert.equal(sc.ok, true);
    assert.equal(sc.dry_run, true);
    assert.equal(sc.requests_made, 0);
    // The pre-fix bug: this payload was cast to `AnalysisResult`, so it was
    // published under a type claiming `scanned` and `counts` existed.
    assert.ok(!('scanned' in sc), 'a dry run has no scan to report');
    assert.ok(!('counts' in sc), 'a dry run has no counts to report');
    assert.equal(h.calls.length, 0, 'dry_run must issue zero API requests');
  });

  it('saved_dedupe reports ok:false on cooldown', async () => {
    const h = harness(registerSavedDedupeTools as never);
    withCooldown(h.client);
    const out = await h.invoke('find_duplicate_saved_tracks');
    const sc = out.structuredContent;
    assert.ok(sc);
    assert.equal(sc.ok, false);
    assert.equal(sc.cooldown, true);
    assert.equal(sc.wait_sec, 42);
    assert.ok(!('scanned' in sc), 'a cooldown payload must not claim a scan happened');
  });
});

// ---------------------------------------------------------------------------
// #803 — an unreadable date is not the oldest date
// ---------------------------------------------------------------------------

describe('#1343 — an `added_at` that could not be read does not sort as oldest', () => {
  const page = {
    items: [
      { added_at: '2026-03-01T00:00:00Z', item: { name: 'March', uri: 'spotify:track:m' } },
      // Spotify did not say when this was added. Pre-fix it became `''`,
      // which sorts before every real date in an `added_asc` listing.
      { item: { name: 'Undated', uri: 'spotify:track:u' } },
      { added_at: '2026-01-01T00:00:00Z', item: { name: 'January', uri: 'spotify:track:j' } },
    ],
    total: 3,
  };

  it('sorts the undated row last in added_asc and reports it as null', async () => {
    const h = harness(registerExhaustMiscTools as never, (path) =>
      path === '/playlists/pl1/items' ? page : null,
    );
    const out = await h.invoke('get_playlist_added_dates', { playlist_id: 'pl1', sort: 'added_asc' });
    const sc = out.structuredContent as { items: Array<{ name: string; added_at: string | null }> };
    assert.deepEqual(
      sc.items.map((i) => i.name),
      ['January', 'March', 'Undated'],
      'the undated row must sort last, not first',
    );
    const undated = sc.items.find((i) => i.name === 'Undated');
    // The honest representation of "Spotify did not state this".
    assert.equal(undated?.added_at, null);
  });

  it('still sorts the undated row last in added_desc', async () => {
    const h = harness(registerExhaustMiscTools as never, (path) =>
      path === '/playlists/pl1/items' ? page : null,
    );
    const out = await h.invoke('get_playlist_added_dates', { playlist_id: 'pl1', sort: 'added_desc' });
    const sc = out.structuredContent as { items: Array<{ name: string }> };
    assert.deepEqual(sc.items.map((i) => i.name), ['March', 'January', 'Undated']);
  });

  it('reads added_by through the boundary and reports "unknown" for a null author', async () => {
    const h = harness(registerExhaustMiscTools as never, (path) =>
      path === '/playlists/pl1/items'
        ? {
            items: [
              { added_at: '2026-01-01T00:00:00Z', added_by: { id: 'u1' }, item: { name: 'A', uri: 'u' } },
              { added_at: '2026-01-02T00:00:00Z', added_by: null, item: { name: 'B', uri: 'u' } },
            ],
            total: 2,
          }
        : null,
    );
    const out = await h.invoke('get_playlist_added_dates', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { items: Array<{ added_by: string | null }> };
    assert.deepEqual(sc.items.map((i) => i.added_by), ['u1', null]);
  });
});

// ---------------------------------------------------------------------------
// #803 — a show with no readable id is not asked about through `/shows//episodes`
// ---------------------------------------------------------------------------

describe('#1343 — a show with no readable id is skipped, not fetched through `/shows//episodes`', () => {
  it('never builds a `/shows//episodes` path and counts the show as skipped', async () => {
    const seen: string[] = [];
    const h = harness(registerExhaust2MiscTools as never, (path) => {
      seen.push(path);
      if (path === '/me/shows') {
        return {
          items: [
            { show: { id: 'sh1', name: 'Good Show' } },
            { show: { name: 'Id-less Show' } },
          ],
          total: 2,
        };
      }
      return null;
    });
    await h.invoke('morning_briefing', { since_hours: 24 });

    assert.ok(
      !seen.includes('/shows//episodes'),
      `a show with no readable id must not be fetched through /shows//episodes; saw ${JSON.stringify(seen)}`,
    );
    // The readable show is still fetched.
    assert.ok(seen.includes('/shows/sh1/episodes'), 'a readable show id must still be used');
  });
});

// ---------------------------------------------------------------------------
// The artist-albums fetch_all page must not invent fields
// ---------------------------------------------------------------------------

describe('#1343 — the fetch_all walk publishes only what it read', () => {
  // `spotifyId('artist')` enforces 22 base62 characters.
  const ARTIST_ID = '4NHQUGzhtTLFvgF5SZesLK';

  it('omits the `href` the page never returned', async () => {
    // The prose renderer reads album_type / release_date / total_tracks /
    // artists, so the fixture carries a whole album rather than a stub that
    // would fail in the renderer instead of at the boundary under test.
    const album = {
      id: 'al1',
      name: 'One',
      uri: 'spotify:album:al1',
      album_type: 'album',
      release_date: '2026-01-01',
      total_tracks: 10,
      artists: [{ id: 'ar1', name: 'Artist' }],
    };
    const h = harness(registerCatalogTools as never, (path) => {
      if (path === `/artists/${ARTIST_ID}/albums`) {
        return {
          items: [{ added_at: '2026-01-01T00:00:00Z', album }],
          total: 1,
          limit: 50,
          offset: 0,
          next: null,
        };
      }
      return null;
    });
    // json mode is the one that puts the whole page on the wire.
    const out = await h.invoke('get_artist_albums', {
      id: ARTIST_ID,
      fetch_all: true,
      response_format: 'json',
    });
    const sc = out.structuredContent as Record<string, unknown>;
    // Pre-fix the walk synthesized `href: ''` and `previous: null` and cast the
    // whole object, so a host could not tell a fabricated URL from a real one.
    assert.ok(!('href' in sc), 'the walk must not publish an href no request returned');
    assert.equal(Array.isArray(sc.items) ? (sc.items as unknown[]).length : -1, 1);
    // `total` is the number of rows the walk actually returned.
    assert.equal(sc.total, 1);
  });
});

// ---------------------------------------------------------------------------
// The gate: the specific-shape casts must not come back
// ---------------------------------------------------------------------------

describe('#1343 — no payload boundary re-widens untrusted JSON through a bare cast', () => {
  /**
   * The files whose payloads reach `structuredContent`. A cast here is the
   * decision to stop checking; the assertion is that these files make it
   * somewhere a reader can see instead.
   */
  const BOUNDARY_FILES = [
    'src/tools/libraryhygiene.ts',
    'src/tools/saveddedupe.ts',
    'src/tools/backupfirst.ts',
    'src/tools/exhaust2_playback.ts',
    'src/tools/exhaust2_catalog.ts',
    'src/tools/playlistreceipts.ts',
  ];

  /**
   * The casts this issue is about, and only those.
   *
   * `as unknown as Record<string, unknown>` is NOT flagged: widening a payload
   * to the wire's own `Record<string, unknown>` asserts nothing the reader did
   * not already believe, and the issue is explicit that this class is "mostly
   * correct and idiomatic at a boundary". What IS flagged is a cast that
   * claims a *specific* declared shape on the far side of untrusted JSON —
   * `as unknown as AnalysisResult`, `as unknown as { added_at?: string }` —
   * because that is a shape the compiler never saw, and a value in it can be
   * confidently wrong at runtime.
   */
  function specificShapeCasts(source: string): string[] {
    return source
      .split('\n')
      .filter((line) => /as\s+unknown\s+as\s+(?!Record<string, unknown>|unknown\b)/.test(line))
      .map((line) => line.trim());
  }

  it('finds no specific-shape `as unknown as` in the boundary files', () => {
    assert.ok(BOUNDARY_FILES.length > 0, 'an empty file list proves nothing');
    const found: string[] = [];
    for (const rel of BOUNDARY_FILES) {
      blankNonCode(readFileSync(join(ROOT, rel), 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          for (const hit of specificShapeCasts(line)) found.push(`${rel}:${i + 1}: ${hit}`);
        });
    }
    assert.deepEqual(
      found,
      [],
      `untrusted JSON is being widened into a declared shape through a bare cast again. ` +
        `Read it with the boundary helpers in src/shaping.ts (readString / readNumber / ` +
        `asRecord) so an unreadable value is represented as unread (#1343):\n${found.join('\n')}`,
    );
  });

  it('classifies a specific-shape cast and ignores the record widening', () => {
    // A guard that cannot fire is decoration (`AGENTS.md` §6). Drive the same
    // classifier over positive and negative controls, so a future change to
    // the pattern that stops matching is caught here rather than in review.
    const cases: Array<[string, boolean]> = [
      ['const x = payload as unknown as AnalysisResult;', true],
      ['const y = row as unknown as { added_at?: string };', true],
      ['const z = p as unknown as SpotifyTrackWithReleaseDate;', true],
      // The idiomatic widening this issue explicitly leaves alone.
      ['structuredContent: payload as unknown as Record<string, unknown>', false],
      ['const w = v as unknown as unknown;', false],
      ['const n = readString(payload, "added_at");', false],
    ];
    for (const [line, shouldFlag] of cases) {
      const flagged = specificShapeCasts(blankNonCode(line)).length > 0;
      assert.equal(flagged, shouldFlag, `misclassified: ${line}`);
    }
    // A cast named only in a comment is not a cast.
    assert.deepEqual(
      specificShapeCasts(blankNonCode('// removed the `as unknown as Foo` cast here')),
      [],
      'a cast named in a comment must not fail the gate',
    );
  });
});
