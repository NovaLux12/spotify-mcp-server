/**
 * #895 — one shared cap for json-mode and structuredContent payloads.
 *
 * The bug: several tools built a whole payload and handed the SAME object to
 * both machine channels — `content[0].text` as `JSON.stringify(payload, null,
 * 2)` AND `structuredContent: payload` — so the host paid twice for one call,
 * and nothing bounded the rows in either copy. `max_results` reached the prose
 * path and stopped there.
 *
 * The fix: `capRowSections` (src/shaping.ts) caps the row arrays and DISCLOSES
 * what it withheld in a `sections` envelope; `emitOnce` puts the payload in
 * `structuredContent` once and a bounded summary in the text block.
 *
 * Every test here must fail on the pre-fix tree. The size tests use library
 * sizes chosen to actually trip the cap, and each asserts the ABSENCE of a
 * second copy — an assertion that passes on a 12-row fixture is decoration
 * (AGENTS.md §6).
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { StubFromResponder } from './helpers/stub-client.js';
import type { LegacyResponder } from './helpers/stub-client.js';
import { capRowSections, emitOnce } from '../src/shaping.js';
import { registerLibraryHygieneTools } from '../src/tools/libraryhygiene.js';
import { registerSavedDedupeTools } from '../src/tools/saveddedupe.js';
import { registerExhaust2MiscTools } from '../src/tools/exhaust2_misc.js';
import { registerPlaylistOpsTools } from '../src/tools/playlistops.js';
import { registerTasteCompositeTools } from '../src/tools/taste_composites.js';
import { registerStatsfmTools } from '../src/tools/statsfm.js';
import { __setStatsfmFetchImpl, __resetStatsfmFetchImpl } from '../src/tools/statsfm_taste.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Responder = (path: string, params?: Record<string, string>) => unknown;

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

function harness(
  register: (server: McpServer, client: StubFromResponder) => void,
  responder: Responder = () => null,
  elicitResult?: unknown,
) {
  const registered: RegisteredTool[] = [];
  const elicitCalls: Array<{ message: string }> = [];
  const fakeServer = {
    // #1544: `dead_library_finder` deletes `DELETE /me/library` once per
    // candidate, so a qualifying library crosses `REMOVE_ELICIT_THRESHOLD` and
    // the write is gated. Without this block the stub advertises no
    // elicitation capability, `requiredConfirmationRefusal` treats that as a
    // refusal, and the tests below would observe a refusal rather than the
    // write whose response-format independence they exist to pin.
    //
    // `elicitResult` present → the stub advertises elicitation and
    // `elicitInput` resolves to it. Omitted → no capability at all, which is
    // the fail-closed case and is asserted separately below.
    ...(elicitResult !== undefined
      ? {
          // Real McpServer shape: the capability accessor and elicitation both
          // live on the inner Server that McpServer exposes as `.server`.
          server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            async elicitInput(request: { message?: string }) {
              elicitCalls.push({ message: request?.message ?? '' });
              if (elicitResult instanceof Error) throw elicitResult;
              return elicitResult;
            },
          },
        }
      : {}),
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
    // `registerTool` is the SDK's own entry point and several modules use it
    // instead of `server.tool`. A harness that only implements the second one
    // fails at REGISTRATION, not at the assertion under test.
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        // `z.ZodType` unparameterized parses to `unknown`, which is the honest
        // default for an arbitrary schema but not for THIS one: a tool's
        // `inputSchema` is always an object schema, so its output is the args
        // object. Naming the output parameter states that, where the bare cast
        // left the value arriving as `unknown` and every reader had to cast
        // again.
        validate: (args) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;
  const client = new StubFromResponder(responder as LegacyResponder, {
    writes: {
      POST: responder as LegacyResponder,
      PUT: responder as LegacyResponder,
      DELETE: responder as LegacyResponder,
      PUT_RAW: () => undefined,
    },
  });
  register(fakeServer, client);
  return {
    /**
     * The stub itself, so a test can assert on the requests the tool ACTUALLY
     * issued. A disclosure test that can only read the response cannot tell a
     * full write from a capped one — which is the whole defect in #1517, where
     * the reported rows and the deleted rows disagreed and only the write
     * recorded the difference.
     */
    client,
    elicitCalls,
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

/**
 * stats.fm modules register against a module-level client rather than the
 * injected one, so their handler is reached by name and called with the
 * already-defaulted args a zod parse would have produced.
 */
function handlerHarness(
  register: (server: unknown, client: unknown) => void,
  client: unknown = {},
) {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (args: Record<string, unknown>) => never) =>
      handlers.set(name, handler),
  };
  register(server, client);
  return async (name: string, args: Record<string, unknown>) => {
    const handler = handlers.get(name);
    assert.ok(handler, `tool "${name}" should be registered`);
    return handler(args);
  };
}

/**
 * `registerStatsfmTools` takes an INJECTED `{ get }` client rather than the
 * shared stats.fm one, so it needs a fixture-swappable responder. Set
 * `statsfmResponder` before invoking; an unset responder is a test bug, not a
 * silent empty page.
 */
let statsfmResponder: (path: string, params?: Record<string, string>) => unknown = () => {
  throw new Error('statsfmResponder was not set for this test');
};
const statsfmInvoke = handlerHarness(registerStatsfmTools as never, {
  get: async (path: string, params?: Record<string, string>) => statsfmResponder(path, params),
});
const tasteInvoke = handlerHarness(registerTasteCompositeTools as never);
/** Array length at `key`, for either a tool result or a bare shaped payload. */
const rowsOf = (payload: Record<string, unknown>, key: string): unknown[] =>
  (payload[key] ?? []) as unknown[];
const rows = (out: { structuredContent?: Record<string, unknown> }, key: string) =>
  rowsOf(out.structuredContent ?? {}, key);

/**
 * `albums` near-complete albums, each with 8 of 10 tracks saved (coverage 0.8,
 * inside the 0.7-0.99 near_complete band), served paged like the real API plus
 * the per-id `GET /albums/{id}` fan-in.
 *
 * The size of `albums` is the test's real variable: 40 albums and 400 albums
 * must produce the SAME number of returned rows at the same `max_results`, and
 * different `sections.*.total`. A fixture whose "large" library fits under the
 * cap proves nothing (AGENTS.md §6).
 */
function hygieneLibrary(albums: number) {
  const tracks: unknown[] = [];
  const albumTable: Record<string, unknown> = {};
  for (let i = 0; i < albums; i += 1) {
    const ids = Array.from({ length: 10 }, (_, n) => `t${i}_${n}`);
    for (const id of ids.slice(0, 8)) {
      tracks.push({
        added_at: '2026-01-01T00:00:00Z',
        track: {
          id, name: `Track ${id}`, uri: `spotify:track:${id}`, type: 'track',
          duration_ms: 200_000, explicit: false,
          artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
          album: { id: `alb${i}`, name: `Album ${i}`, uri: `spotify:album:alb${i}` },
        },
      });
    }
    albumTable[`alb${i}`] = {
      id: `alb${i}`, name: `Album ${i}`, uri: `spotify:album:alb${i}`,
      album_type: 'album', release_date: '2026-01-01', total_tracks: 10,
      artists: [{ id: `ar${i}`, name: `Artist ${i}` }], images: [],
      tracks: {
        items: ids.map((id, n) => ({
          id, name: `Track ${id}`, uri: `spotify:track:${id}`, duration_ms: 200_000,
          explicit: false, track_number: n + 1, artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
        })),
        total: 10,
      },
    };
  }
  const responder = (path: string, params?: Record<string, string>) => {
    if (path === '/me/tracks') {
      const limit = 50;
      const offset = Number(params?.offset ?? 0);
      return { items: tracks.slice(offset, offset + limit), total: tracks.length, limit, offset };
    }
    const single = /^\/albums\/(.+)$/.exec(path);
    if (single) return albumTable[decodeURIComponent(single[1])] ?? null;
    return null;
  };
  return responder;
}

/**
 * A saved library with `distinct` songs saved twice each — `distinct` exact
 * duplicate groups. The two saves of a song need DIFFERENT uris: the group key
 * is ISRC + album + duration + normalized name, so two copies of the same uri
 * collapse to one row and no group forms at all.
 */
function dedupeLibrary(distinct: number) {
  const save = (id: string, isrc: string, album: string) => ({
    added_at: '2026-01-01T00:00:00Z',
    track: {
      id, name: `Song ${isrc}`, uri: `spotify:track:${id}`, type: 'track',
      duration_ms: 200_000, explicit: false,
      artists: [{ id: 'ar1', name: 'Artist One' }],
      album: { id: album, name: `Album ${album}`, uri: `spotify:album:${album}` },
      external_ids: { isrc },
    },
  });
  const items: unknown[] = [];
  for (let i = 0; i < distinct; i += 1) {
    const isrc = `ISRC${String(i).padStart(4, '0')}`;
    const album = `alb${i}`;
    items.push(save(`x${i}a`, isrc, album), save(`x${i}b`, isrc, album));
  }
  return (path: string, params?: Record<string, string>) => {
    if (path !== '/me/tracks') return null;
    const limit = Number(params?.limit ?? 50);
    const offset = Number(params?.offset ?? 0);
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  };
}

// ---------------------------------------------------------------------------
// The helper itself
// ---------------------------------------------------------------------------

describe('capRowSections (#895)', () => {
  it('caps every named array to the same row budget and discloses each one', () => {
    const payload = {
      ok: true,
      a: Array.from({ length: 500 }, (_, i) => `a${i}`),
      b: Array.from({ length: 3 }, (_, i) => `b${i}`),
      untouched: Array.from({ length: 400 }, (_, i) => `u${i}`),
    };
    const out = capRowSections(payload, ['a', 'b'], 10);

    assert.equal(rowsOf(out, 'a').length, 10, 'the big section is capped');
    assert.equal(rowsOf(out, 'b').length, 3, 'a section under the cap is untouched');
    assert.equal(rowsOf(out, 'untouched').length, 400, 'unnamed keys are not capped');

    // The totals are the pre-cap truth, which is the whole point: 500 is what
    // the scan found even though 10 rows shipped.
    const sections = out.sections as Record<string, { returned: number; total: number; truncated: boolean }>;
    assert.deepEqual(sections.a, { returned: 10, total: 500, truncated: true });
    assert.deepEqual(sections.b, { returned: 3, total: 3, truncated: false });
    assert.equal(out.truncated, true, 'the payload-level flag says rows were withheld HERE');
  });

  it('leaves the input object alone and does not truncate when everything fits', () => {
    const items = ['x', 'y'];
    const payload = { items, total: 2 };
    const out = capRowSections(payload, ['items'], 10);

    assert.notEqual(out, payload, 'a new object is returned');
    assert.equal(payload.items.length, 2, 'the input is not mutated in place');
    assert.equal(out.truncated, false);
  });

  it('reports a non-array key as unreadable rather than coercing it to []', () => {
    // #804: a value that could not be read must not become a plausible one.
    // `null` is not "zero rows found" — it is "the scan could not read it".
    const out = capRowSections({ candidates: null, ok: true }, ['candidates'], 5);

    assert.equal(out.candidates, null, 'the unreadable value is left exactly as produced');
    const section = (out.sections as Record<string, { unreadable?: boolean; total: number }>).candidates;
    assert.equal(section.unreadable, true);
    assert.equal(section.total, 0, 'an unreadable key claims no rows, because it read none');
  });

  it('withholds a named key entirely and says how to get it back', () => {
    const out = capRowSections(
      { groups: Array.from({ length: 60 }, (_, i) => ({ i })), near: [] },
      ['near'],
      10,
      ['groups'],
    );

    assert.equal('groups' in out, false, 'the withheld key is gone from the payload');
    const section = (out.sections as Record<string, { withheld?: boolean; total: number; available_via?: string }>).groups;
    assert.equal(section.withheld, true);
    assert.equal(section.total, 60, 'the withheld total is still the truth');
    assert.equal(section.available_via, "response_format: 'json'");
    assert.equal(out.truncated, true);
  });

  it('caps each section to max_results independently, and withholds a named key whole', () => {
    // The name of this test used to say the opposite of what it asserted: it
    // was called "one shared budget, not per-section" and its comment called
    // 10+10 rows at a cap of 10 "a lie about the shape of the limit", while
    // the assertions pinned 10 and 10. The contract is per-section and it is
    // deliberate — `capRowSections`'s own docstring and SPEC.md:657 both state
    // that each named array is capped to `max_results` in its own right, which
    // is what the prose path already renders and what each tool's description
    // promises. A shared budget would silently starve a section the caller can
    // see described in full. A test named for the contract it contradicts
    // invites the next reader to "fix" the helper to match its title.
    //
    // So the two properties are pinned together, because they are what the
    // helper actually promises: a named array is SLICED to the cap, and a
    // `withhold`-ed key is DELETED whole and reported with its exact total.
    const out = capRowSections(
      {
        a: Array.from({ length: 300 }, (_, i) => i),
        b: Array.from({ length: 300 }, (_, i) => i),
        raw: Array.from({ length: 300 }, (_, i) => i),
      },
      ['a', 'b'],
      10,
      ['raw'],
    );

    const sections = out.sections as Record<
      string,
      { returned: number; total: number; truncated?: boolean; withheld?: boolean }
    >;
    // Per-section, not per-payload: each named array gets the full cap.
    assert.equal(sections.a.returned, 10);
    assert.equal(sections.b.returned, 10);
    assert.equal(rowsOf(out, 'a').length, 10, 'and the rows really are sliced, not just reported');
    assert.equal(rowsOf(out, 'b').length, 10);
    // Withheld is a different mechanism: the key is gone, and its true size is
    // stated. `total: 0` there would read as "the scan found nothing" (#803).
    assert.equal('raw' in out, false, 'a withheld key is deleted, not sliced');
    assert.equal(sections.raw.withheld, true);
    assert.equal(sections.raw.total, 300);
    // The totals are pre-cap for all three, so no row is lost from the count.
    assert.equal(sections.a.total + sections.b.total + sections.raw.total, 900);
  });
});

describe('emitOnce (#895)', () => {
  it('puts the payload in structuredContent and a non-JSON summary in the text block', () => {
    const raw = capRowSections(
      { items: Array.from({ length: 200 }, (_, i) => ({ i })), total: 200 },
      ['items'],
      10,
    );
    const out = emitOnce(raw, (payload) => {
      const s = payload.sections as Record<string, { returned: number; total: number }>;
      return `items: ${s.items.returned}/${s.items.total}. Full payload in structuredContent.`;
    });

    assert.deepEqual(out.structuredContent, raw, 'the payload is attached once, unchanged');
    assert.equal(out.content.length, 1);
    assert.throws(() => JSON.parse(out.content[0].text), 'the text block is not a second copy');
    assert.ok(out.content[0].text.length < JSON.stringify(raw).length,
      'the summary is the smaller of the two strings');
  });
});

// ---------------------------------------------------------------------------
// Call sites. Each asserts the SIZE the fix is about, on a library big enough
// to trip the cap — a 3-row fixture would pass with or without the fix.
// ---------------------------------------------------------------------------

describe('library_hygiene json mode (#895)', () => {
  it('sizes the payload by max_results, not by how big the library is', async () => {
    // `response_format: 'json'` is the documented bulk export for this tool and
    // deliberately returns the whole analysis (issue #895, AC1). The cap that
    // has to hold regardless of library size is the one on the human-facing
    // modes, which is where the 60-90 KB payload the issue measured came from.
    const small = await harness(registerLibraryHygieneTools, hygieneLibrary(40)).invoke(
      'library_hygiene',
      { max_results: 10, response_format: 'detailed' },
    );
    const large = await harness(registerLibraryHygieneTools, hygieneLibrary(60)).invoke(
      'library_hygiene',
      { max_results: 10, response_format: 'detailed' },
    );

    assert.equal(rows(small, 'near_complete').length, 10, 'a 40-album library returns exactly max_results rows');
    assert.equal(rows(large, 'near_complete').length, 10, 'a 60-album library returns the SAME number of rows');

    const smallSec = small.structuredContent!.sections as Record<string, { returned: number; total: number }>;
    const largeSec = large.structuredContent!.sections as Record<string, { returned: number; total: number }>;
    assert.equal(smallSec.near_complete.total, 40, 'the pre-cap total of the small library');
    assert.equal(largeSec.near_complete.total, 60, 'the pre-cap total of the large library');
    assert.equal(
      small.structuredContent!.near_complete === large.structuredContent!.near_complete,
      false,
      'two different libraries — the row counts above are not one shared constant',
    );
  });

  it('emits the json payload once, with a summary in the text block', async () => {
    const out = await harness(registerLibraryHygieneTools, hygieneLibrary(60)).invoke(
      'library_hygiene',
      { max_results: 10, response_format: 'json' },
    );
    const payload = JSON.stringify(out.structuredContent, null, 2);

    assert.notEqual(textOf(out), payload, 'the text block is not a stringify of the payload');
    assert.throws(() => JSON.parse(textOf(out)), 'the text block is not a second JSON copy');
    assert.ok(
      textOf(out).length * 4 < payload.length,
      `summary ${textOf(out).length} B must be far smaller than payload ${payload.length} B`,
    );
  });

  it('discloses withheld groups instead of shipping them', async () => {
    const out = await harness(registerLibraryHygieneTools, hygieneLibrary(60)).invoke(
      'library_hygiene',
      { max_results: 10, response_format: 'detailed' },
    );
    const sections = out.structuredContent!.sections as Record<
      string,
      { withheld?: boolean; total: number; available_via?: string }
    >;

    assert.equal('groups' in out.structuredContent!, false,
      'a capped call must not carry the full album-group scan beside the cap');
    assert.equal(sections.groups.withheld, true);
    assert.equal(sections.groups.total, 60, 'the exact group total survives the withholding');
    assert.equal(sections.groups.available_via, "response_format: 'json'");
  });
});

describe('find_duplicate_saved_tracks json mode (#895)', () => {
  it('is the bulk export: json mode returns the whole analysis despite max_results', async () => {
    // #895's AC1: "`response_format: 'json'` still returns the full analysis",
    // and SPEC.md's #895 entry says the same for this tool and
    // `library_hygiene` together. The previous version of this test asserted
    // the OPPOSITE (40 groups in, 5 rows out), which pinned a contract
    // violation and invited the next agent to "fix" the module back to it.
    const out = await harness(registerSavedDedupeTools, dedupeLibrary(40)).invoke(
      'find_duplicate_saved_tracks',
      { max_results: 5, response_format: 'json' },
    );

    const groups = rows(out, 'groups') as Array<{ kind: string }>;
    assert.equal(groups.length, 40, 'json mode is the bulk export — every group ships');
    assert.equal(groups.every((g) => g.kind === 'exact'), true, 'the fixture really produced duplicate groups');
    assert.equal('sections' in out.structuredContent!, false, 'an uncapped bulk export has no cap envelope');

    // The payload still rides once, in structuredContent, beside a bounded
    // summary. The double-echo this PR removed is the property under test here,
    // and it is independent of whether the rows were capped.
    const payload = JSON.stringify(out.structuredContent, null, 2);
    assert.notEqual(textOf(out), payload, 'no second copy in the text block');
    assert.throws(() => JSON.parse(textOf(out)), 'the text block is not a second JSON copy');
    assert.ok(textOf(out).length * 4 < payload.length);
  });

  it('caps the prose modes to the same max_results, with the pre-cap total disclosed', async () => {
    // The other half of the contract, and the one the json test above used to
    // (wrongly) stand in for. The cap is a property of the PROSE modes here:
    // that is where the `max_results` promise in the tool description is
    // written, so this is where it has to hold.
    const out = await harness(registerSavedDedupeTools, dedupeLibrary(40)).invoke(
      'find_duplicate_saved_tracks',
      { max_results: 5, response_format: 'detailed' },
    );

    assert.equal(rows(out, 'groups').length, 5, '40 groups in, 5 rows out — the cap fired');
    const section = (out.structuredContent!.sections as Record<string, { returned: number; total: number }>).groups;
    assert.equal(section.returned, 5);
    assert.equal(section.total, 40, 'the pre-cap group total is disclosed, not dropped');
    assert.equal(out.structuredContent!.truncated, true);
  });
});

describe('diff_playlists / overlap_playlists (#895)', () => {
  // Spotify ids are 22 base62 characters; anything else is refused before a
  // single request is made.
  const PAIR_A = 'Q'.repeat(22);
  const PAIR_B = 'R'.repeat(22);

  const item = (id: string) => ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track', id, name: `Track ${id}`, uri: `spotify:track:${id}`,
      duration_ms: 200_000, artists: [{ name: `Artist ${id}` }],
    },
  });

  /** Two 400-track playlists that share nothing: 800 differing rows to cap. */
  const disjointResponder = () => (path: string, arg?: unknown) => {
    const match = /^\/playlists\/([^/]+)\/items$/.exec(path);
    if (!match) return null;
    const prefix = match[1] === PAIR_A ? 'a' : 'b';
    const all = Array.from({ length: 400 }, (_, i) => item(`${prefix}${i}`));
    const offset = Number((arg as Record<string, string> | undefined)?.offset ?? 0);
    return { items: all.slice(offset, offset + 100), total: 400, limit: 100, offset, next: null };
  };

  it('caps each section to max_results and reports the exact pre-cap totals', async () => {
    const out = await harness(registerPlaylistOpsTools, disjointResponder()).invoke(
      'diff_playlists',
      { playlist_a: PAIR_A, playlist_b: PAIR_B, max_results: 10, response_format: 'json' },
    );
    const sections = out.structuredContent!.sections as Record<string, { returned: number; total: number; truncated: boolean }>;

    assert.equal(sections.only_in_a.returned, 10, '400 rows in, max_results out');
    assert.equal(sections.only_in_a.total, 400, 'the pre-cap total is the truth, not the row count');
    assert.equal(sections.only_in_b.returned, 10);
    assert.equal(sections.only_in_b.total, 400);
    assert.equal(sections.moved.total, 0, 'a disjoint pair has no moved rows, and that is reported');
    assert.equal(rows(out, 'only_in_a').length, 10);
    assert.equal(rows(out, 'only_in_b').length, 10);
    assert.equal(out.structuredContent!.truncated, true, 'the payload flag reports rows withheld HERE');
    assert.equal(out.structuredContent!.a_total, 400, 'the walk totals are untouched by the row cap');
  });

  it('caps overlap rows and keeps total_shared exact', async () => {
    // Overlap counts tracks present in at least `threshold` playlists, so the
    // disjoint fixture above would prove nothing here — it shares nothing.
    // This one shares 400 of 400 in both playlists.
    const sharedResponder = () => (path: string, arg?: unknown) => {
      const match = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (!match) return null;
      const all = Array.from({ length: 400 }, (_, i) => item(`c${i}`));
      const offset = Number((arg as Record<string, string> | undefined)?.offset ?? 0);
      return { items: all.slice(offset, offset + 100), total: 400, limit: 100, offset, next: null };
    };
    const out = await harness(registerPlaylistOpsTools, sharedResponder()).invoke(
      'overlap_playlists',
      { playlists: [PAIR_A, PAIR_B], threshold: 2, max_results: 10, response_format: 'json' },
    );
    const sections = out.structuredContent!.sections as Record<string, { returned: number; total: number }>;

    assert.equal(rows(out, 'shared').length, 10, '400 shared rows in, max_results out');
    assert.equal(sections.shared.total, 400, 'the pre-cap total is the truth');
    assert.equal(out.structuredContent!.total_shared, 400, 'and total_shared agrees with sections');
  });

  it('names the source-walk cap `truncated_by_cap`, not `truncated`', async () => {
    const out = await harness(registerPlaylistOpsTools, disjointResponder()).invoke(
      'diff_playlists',
      { playlist_a: PAIR_A, playlist_b: PAIR_B, max_results: 10, response_format: 'json' },
    );
    // Two different quantities, two names. A complete walk is not a truncated
    // walk, and a capped payload is not a capped walk — one flag cannot say both.
    assert.equal(out.structuredContent!.truncated_by_cap, false, 'the walk finished inside scan_cap');
    assert.equal(out.structuredContent!.truncated, true, 'the PAYLOAD dropped rows');
  });

  it('emits the diff and overlap payloads once, not twice', async () => {
    for (const [name, args] of [
      ['diff_playlists', { playlist_a: PAIR_A, playlist_b: PAIR_B }],
      ['overlap_playlists', { playlists: [PAIR_A, PAIR_B], threshold: 2 }],
    ] as const) {
      const out = await harness(registerPlaylistOpsTools, disjointResponder()).invoke(name, {
        ...args, max_results: 10, response_format: 'json',
      });
      const payload = JSON.stringify(out.structuredContent, null, 2);
      assert.notEqual(textOf(out), payload, `${name}: the text block is not a second copy`);
      assert.throws(() => JSON.parse(textOf(out)), `${name}: the text block is not JSON at all`);
      assert.match(textOf(out), /structuredContent/, `${name}: the text block points at the payload`);
    }
  });
});

describe('dead_library_finder (#895)', () => {
  it('caps the dead-track rows and keeps the exact pre-cap count', async () => {
    const responder = (path: string) => {
      if (path === '/me/tracks') return { items: [], total: 0 };
      if (path === '/me/player/recently-played') return { items: [], next: null };
      if (path === '/me/playlists') return { items: [], total: 0 };
      if (path.startsWith('/playlists/')) return { items: [], total: 0 };
      return null;
    };
    const out = await harness(registerExhaust2MiscTools, responder).invoke(
      'dead_library_finder',
      { dry_run: false, max_results: 10, response_format: 'json' },
    );
    const sections = out.structuredContent!.sections as Record<string, { returned: number; total: number }> | undefined;

    // The empty-library fixture trips the cap at 0 rows, so this asserts the
    // ENVELOPE is present and consistent, not that a cap fired.
    assert.ok(sections, 'a capped tool must publish the sections envelope');
    assert.equal(sections!.candidates.returned, rows(out, 'candidates').length);
    assert.equal(sections!.candidates.total, out.structuredContent!.count,
      'sections.candidates.total and count are the same number, not two guesses');
    assert.notEqual(textOf(out), JSON.stringify(out.structuredContent, null, 2));
  });

  // -------------------------------------------------------------------------
  // #1517 — the cap must not be the only record of what was DELETED.
  //
  // The test above cannot catch that class of bug: an EMPTY library produces
  // zero candidates, so no cap ever fires and every assertion here is about
  // the envelope, not about a row list that was cut down. This block fires the
  // cap on purpose and then checks the two things that have to stay in step —
  // the rows the tool reports, and the URIs it actually sent to
  // DELETE /me/library.
  // -------------------------------------------------------------------------

  /** A library of `n` tracks that are all old, unplayed and unlisted. */
  const deadLibraryResponder = (n: number): Responder => (path: string) => {
    if (path === '/me/tracks') {
      return {
        items: Array.from({ length: n }, (_, i) => ({
          added_at: '2020-01-01T00:00:00Z',
          track: { uri: `spotify:track:dead${i}`, name: `Dead ${i}` },
        })),
        total: n, limit: 50, offset: 0, next: null,
      };
    }
    if (path === '/me/player/recently-played') return { items: [], next: null };
    if (path === '/me/playlists') return { items: [], total: 0 };
    if (path.startsWith('/playlists/')) return { items: [], total: 0 };
    if (path.startsWith('/me/library')) return { ok: true };
    return null;
  };

  /** Every URI the handler actually deleted, decoded out of the DELETE calls. */
  const deletedUris = (client: StubFromResponder): string[] =>
    client.calls
      .filter((c) => c.method === 'DELETE' && c.path.startsWith('/me/library'))
      .flatMap((c) => decodeURIComponent(c.path.split('uris=')[1] ?? '').split(',').filter(Boolean));

  const DEAD = 500;
  const CAP = 10;
  const allDeadUris = Array.from({ length: DEAD }, (_, i) => `spotify:track:dead${i}`);
  /** #1544: the verdict that lets the gated write proceed. */
  const accept = { action: 'accept', content: { confirm: true } };

  it('deletes every eligible track and says so, in every response format', async () => {
    // The write is `max_results`-independent by contract: `MaxResults` is
    // documented as a cap on what is RETURNED, and the deletion is not a
    // return. If this ever starts deleting `CAP` rows, the tool silently
    // unsaves fewer tracks than the scan found — a caller who lowered
    // `max_results` to shrink a reply would have changed their library.
    const seen: string[][] = [];
    for (const rf of ['concise', 'detailed', 'json'] as const) {
      const h = harness(registerExhaust2MiscTools, deadLibraryResponder(DEAD), accept);
      const out = await h.invoke('dead_library_finder', { dry_run: false, max_results: CAP, response_format: rf });
      assert.equal(out.structuredContent!.count, DEAD, `${rf}: the eligible set is the whole library`);
      assert.equal(out.structuredContent!.removed, DEAD, `${rf}: and all of it was removed`);
      seen.push(deletedUris(h.client));
    }
    for (const uris of seen) {
      assert.deepEqual(uris, allDeadUris, 'DELETE /me/library received every dead track, in order');
    }
  });

  it('withholds the deleted-track record from the prose modes and names where to get it', async () => {
    const h = harness(registerExhaust2MiscTools, deadLibraryResponder(DEAD), accept);
    const out = await h.invoke(
      'dead_library_finder',
      { dry_run: false, max_results: CAP, response_format: 'concise' },
    );
    const sections = out.structuredContent!.sections as Record<string, {
      returned: number; total: number; truncated: boolean; withheld?: boolean; available_via?: string;
    }>;

    // The audit trail is gone from THIS payload, and the payload says so in the
    // helper's own vocabulary rather than by omission.
    assert.equal('details' in out.structuredContent!, false, 'a withheld key is deleted, not sliced');
    assert.equal(sections.details.withheld, true);
    assert.equal(sections.details.returned, 0, 'nothing of the record shipped here');
    assert.equal(sections.details.total, DEAD, 'the exact pre-cap count is still the truth');
    assert.equal(sections.details.available_via, "response_format: 'json'");
    assert.equal(out.structuredContent!.truncated, true, 'rows were withheld from THIS payload');

    // `candidates` stays capped rather than withheld: same rows as `details`,
    // same slice, so the human-facing modes keep a sample without the
    // disclosure being published twice.
    assert.equal(rows(out, 'candidates').length, CAP, 'the sample is still bounded by max_results');
    assert.equal(sections.candidates.returned, CAP);
    assert.equal(sections.candidates.total, DEAD);
    assert.equal(sections.candidates.withheld, undefined, 'a capped section is not a withheld one');
  });

  it('returns the whole deleted-track record under response_format: json', async () => {
    // This is the assertion the pre-fix tree fails. Before #1517 `details` was
    // capped here too, so `max_results: 10` shipped 10 of 500 rows and named
    // no way to get the other 490 — the exact shape #1517 reports.
    const h = harness(registerExhaust2MiscTools, deadLibraryResponder(DEAD), accept);
    const out = await h.invoke(
      'dead_library_finder',
      { dry_run: false, max_results: CAP, response_format: 'json' },
    );
    const sections = out.structuredContent!.sections as Record<string, {
      returned: number; total: number; truncated: boolean; withheld?: boolean;
    }>;

    const detail = rows(out, 'details') as Array<{ uri: string; name: string }>;
    assert.equal(detail.length, DEAD, 'the record of what was removed is reachable in full');
    assert.deepEqual(detail.map((d) => d.uri), allDeadUris, 'and it is the set that was deleted');
    assert.equal(sections.details.returned, DEAD, 'the envelope agrees rather than restating the cap');
    assert.equal(sections.details.total, DEAD);
    assert.equal(sections.details.truncated, false, 'a complete record is marked complete');
    assert.equal(out.structuredContent!.truncated, false, 'nothing was withheld from this payload');

    // The #895 envelope still ships in json — a reader of this tool's json
    // output has always found `sections` here, and dropping it to match
    // `saveddedupe`'s `bulk ||` short-circuit would be a second breaking shape
    // change on top of the one #1517 already requires.
    assert.ok(sections.candidates, 'sections is published in json as well as the prose modes');
  });

  it('does not claim a truncation when the scan found nothing to withhold', async () => {
    // `capRowSections` reports `{ withheld: true, truncated: true, total }` for
    // any key it is handed, including an EMPTY array. Withholding an empty
    // `details` would tell a caller that rows were withheld from a scan that
    // found none — #803 again, in the flag rather than the value, and one this
    // call site would have introduced by being the first to pass a `withhold`
    // list that could be empty.
    for (const rf of ['concise', 'json'] as const) {
      const h = harness(registerExhaust2MiscTools, deadLibraryResponder(0));
      const out = await h.invoke('dead_library_finder', { dry_run: false, response_format: rf });
      const sections = out.structuredContent!.sections as Record<string, {
        returned: number; total: number; truncated: boolean; withheld?: boolean;
      }>;

      assert.equal(sections.details.total, 0, `${rf}: nothing was eligible`);
      assert.equal(sections.details.withheld, undefined, `${rf}: nothing was withheld, so nothing is claimed withheld`);
      assert.equal(sections.details.truncated, false, `${rf}: an empty scan is not a truncated one`);
      assert.equal(out.structuredContent!.truncated, false, `${rf}: the payload flag agrees`);
      assert.deepEqual(deletedUris(h.client), [], `${rf}: and nothing was deleted`);
    }
  });
});

// ---------------------------------------------------------------------------
// stats.fm: the shared collection envelope, and the raw composites beside it.
// These two modules talk to stats.fm over a module-level client, so they are
// driven through the parsed-payload fetch seam rather than a client stub.
// ---------------------------------------------------------------------------

describe('statsfm json mode (#895)', () => {
  const streamRow = (i: number) => ({
    track: { id: `t${i}`, name: `Track ${i}` },
    artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
    playedAt: 1_700_000_000_000 + i,
  });

  /** `count` real stream rows, served as `{ items }` — the live route shape. */
  const streamsFixture = (count: number) => {
    statsfmResponder = () => ({
      items: Array.from({ length: count }, (_, i) => streamRow(i)),
    });
  };

  it('caps the shared collection envelope at max_results and discloses the total', async () => {
    streamsFixture(500);
    const out = await statsfmInvoke('statsfm_recent_streams', {
      user_id: 'alice', limit: 500, max_results: 20, response_format: 'json',
    });

    assert.equal(rows(out, 'items').length, 20, '500 streams in, 20 rows out');
    const section = (out.structuredContent!.sections as Record<string, { returned: number; total: number }>).items;
    assert.equal(section.returned, 20);
    assert.equal(section.total, 500, 'the pre-cap total is disclosed, not silently dropped');
    assert.equal(out.structuredContent!.truncated, true);

    assert.throws(() => JSON.parse(textOf(out)), 'the raw 500-stream page is not echoed as text');
    assert.ok(textOf(out).length < 500, 'the text block is a summary, not a payload copy');
  });

  it('keeps payload size flat as the upstream page grows', async () => {
    const sizeAt = async (count: number) => {
      streamsFixture(count);
      const out = await statsfmInvoke('statsfm_recent_streams', {
        user_id: 'alice', limit: count, max_results: 20, response_format: 'json',
      });
      return JSON.stringify(out.structuredContent).length;
    };
    const small = await sizeAt(100);
    const large = await sizeAt(500);
    // Not an equality: the payload carries the exact totals, so a bigger page
    // makes the DISCLOSURE longer. It must not make it grow with the rows.
    assert.equal(large < small * 1.2, true, `${large} B must stay within 20% of ${small} B`);
  });
});

describe('taste composite json mode (#895)', () => {
  it('caps every raw upstream collection in the composite and emits it once', async () => {
    // The issue measured `GET /users/{u}/streams?limit=500` at 124,127 bytes.
    const bigPage = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({
      track: { id: `t${i}`, name: `Track ${i}` }, artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
      playedAt: 1_700_000_000_000 + i, duration: 200_000, platform: 'spotify',
    })) });
    __setStatsfmFetchImpl(async (url: string) => {
      if (url.includes('/streams')) return bigPage(500);
      if (url.includes('/top/tracks')) return { items: bigPage(50).items };
      return { items: bigPage(20).items };
    });
    try {
      const out = await tasteInvoke('taste_daily_brief', {
        statsfm_user: 'alice', max_results: 10, response_format: 'json',
      });
      const payload = out.structuredContent!;
      const sections = payload.sections as Record<string, { returned: number; total: number }>;

      for (const [key, total] of [['topArtists', 20], ['topTracks', 50], ['recentStreams', 500]] as const) {
        assert.equal(sections[key].returned, 10, `${key} is capped to max_results`);
        assert.equal(sections[key].total, total, `${key} discloses its pre-cap total`);
      }
      assert.equal(out.structuredContent!.truncated, true);
      assert.throws(() => JSON.parse(textOf(out)));
      assert.ok(
        JSON.stringify(payload).length < 10_000,
        `500-stream composite must be under 10 KB, got ${JSON.stringify(payload).length}`,
      );
    } finally {
      __resetStatsfmFetchImpl();
    }
  });
});

// ---------------------------------------------------------------------------
// #1480 — `sections` must describe the payload that actually ships.
//
// The #895 test above is GREEN on the #1480 tree, and that is the whole point:
// its fixture wraps every collection in `{ items: [...] }`, which is the one
// shape the writeback happened to handle. stats.fm can also answer with a BARE
// array — `asItems` in `taste_composites.ts` and in `statsfm_taste.ts` both
// accept one, so the module's own standards treat it as expected — and against
// that shape `jsonUpstream` assigned the capped array onto a `.items` property
// of the original array. `JSON.stringify` drops non-index properties, so the
// cap was computed, published in `sections`, and thrown away: the tool claimed
// `{"returned":10,"total":500,"truncated":true}` while shipping all 500 rows.
//
// Every assertion below reads the JSON-SERIALIZED payload, not the object. That
// is the wire the host receives, and it is the only view in which the bug is
// visible at all: on the raw object the uncapped rows and the discarded
// `items` property are both still there, so a length check against the object
// would pass on the broken tree.
// ---------------------------------------------------------------------------

describe('taste composite json mode — the capped value is what ships (#1480)', () => {
  const streamRow = (i: number) => ({
    track: { id: `t${i}`, name: `Track ${i}` },
    artists: [{ id: `ar${i}`, name: `Artist ${i}` }],
    playedAt: 1_700_000_000_000 + i,
    duration: 200_000,
    platform: 'spotify',
  });
  const streamRows = (n: number) => Array.from({ length: n }, (_, i) => streamRow(i));

  interface Section { returned: number; total: number; truncated: boolean; unreadable?: boolean }

  /**
   * The rows a caller can actually count at `key` in the serialized payload: the
   * key itself when the collection shipped bare, its `items` when it shipped
   * wrapped. The two shapes are the whole class, so the row count has to be
   * read the same way for both or the test only ever exercises one.
   */
  function shippedRows(wire: Record<string, unknown>, key: string): unknown[] {
    const value = wire[key];
    if (Array.isArray(value)) return value;
    const items = (value as { items?: unknown } | null)?.items;
    return Array.isArray(items) ? items : [];
  }

  it('caps a BARE-ARRAY collection, which it previously computed and then discarded', async () => {
    // `/streams` answers with a bare array — no `{ items: [...] }` wrapper. The
    // other two stay wrapped so one call covers both shapes.
    __setStatsfmFetchImpl(async (url: string) => {
      if (url.includes('/streams')) return streamRows(500);
      if (url.includes('/top/tracks')) return { items: streamRows(50) };
      return { items: streamRows(20) };
    });
    try {
      const out = await tasteInvoke('taste_daily_brief', {
        statsfm_user: 'alice', max_results: 10, response_format: 'json',
      });
      const wire = JSON.parse(JSON.stringify(out.structuredContent)) as Record<string, unknown>;
      const sections = wire.sections as Record<string, Section>;

      // The disclosure is the thing that used to lie, so it is stated first and
      // exactly: the section still reports the pre-cap total, and `truncated`
      // still means "rows were withheld from THIS payload".
      assert.deepEqual(
        { returned: sections.recentStreams.returned, total: sections.recentStreams.total, truncated: sections.recentStreams.truncated },
        { returned: 10, total: 500, truncated: true },
        'the section discloses the cap it claims to have applied',
      );
      assert.equal(wire.truncated, true);

      // Then the claim is checked against the wire. Pre-fix this is 500.
      assert.ok(Array.isArray(wire.recentStreams), 'a bare array stays a bare array');
      assert.equal(shippedRows(wire, 'recentStreams').length, 10, 'the bare array ships 10 of 500 rows');
      assert.equal(
        shippedRows(wire, 'recentStreams').length, sections.recentStreams.returned,
        'the wire and the section agree — the disclosure is not a claim about a payload that did not happen',
      );
      assert.equal(shippedRows(wire, 'topTracks').length, 10, 'the wrapped collection is still capped');
      assert.equal(
        shippedRows(wire, 'topArtists').length, 10, 'the sibling wrapped collection is still capped',
      );
      assert.ok(
        JSON.stringify(wire).length < 10_000,
        `the capped payload must stay bounded, got ${JSON.stringify(wire).length} B`,
      );
    } finally {
      __resetStatsfmFetchImpl();
    }
  });

  it('holds the wire to every section across all three upstream shapes', async () => {
    // The general defect is "a cap that was computed and not applied", so the
    // invariant is asserted for EVERY key rather than for the one that broke:
    // whatever a section claims to have returned is what the caller can count.
    // This is the check the issue asks for, and it is the one that catches the
    // NEXT call site that lifts a value out of a wrapper and forgets to put the
    // capped one back.
    const shapes = [
      { label: 'bare array', page: (n: number) => streamRows(n) },
      { label: '{ items: [] }', page: (n: number) => ({ items: streamRows(n) }) },
      { label: '{ data: [] }', page: (n: number) => ({ data: streamRows(n) }) },
    ] as const;

    for (const { label, page } of shapes) {
      __setStatsfmFetchImpl(async (url: string) => {
        if (url.includes('/streams')) return page(500);
        if (url.includes('/top/tracks')) return page(50);
        return page(20);
      });
      try {
        const out = await tasteInvoke('taste_daily_brief', {
          statsfm_user: 'alice', max_results: 10, response_format: 'json',
        });
        const wire = JSON.parse(JSON.stringify(out.structuredContent)) as Record<string, unknown>;
        const sections = wire.sections as Record<string, Section>;
        const keys = Object.keys(sections);
        assert.ok(keys.length > 0, `${label}: the payload carries sections`);

        for (const key of keys) {
          if (sections[key].unreadable) continue;
          assert.equal(
            shippedRows(wire, key).length, sections[key].returned,
            `${label}: ${key} ships ${sections[key].returned} rows and claims to ship that many`,
          );
        }
      } finally {
        __resetStatsfmFetchImpl();
      }
    }
  });

  it('passes a collection it could not read through WHOLE rather than as []', async () => {
    // #804, and the reason the fix is a shape switch rather than a coercion.
    // `{ data: [...] }` is not a shape `jsonUpstream` lifts, so the helper calls
    // it unreadable — and unreadable means untouched: the rows stay, the
    // wrapper stays, and nothing claims a cap was applied to them. Rewriting
    // this to `[]` would be the #803 bug in a different costume.
    __setStatsfmFetchImpl(async (url: string) => {
      if (url.includes('/streams')) return { data: streamRows(500) };
      if (url.includes('/top/tracks')) return streamRows(50);
      return { items: streamRows(20) };
    });
    try {
      const out = await tasteInvoke('taste_daily_brief', {
        statsfm_user: 'alice', max_results: 10, response_format: 'json',
      });
      const wire = JSON.parse(JSON.stringify(out.structuredContent)) as Record<string, unknown>;
      const sections = wire.sections as Record<string, Section>;

      const unreadable = wire.recentStreams as { data?: unknown[] };
      assert.ok(Array.isArray(unreadable.data), 'the wrapper is not collapsed to an array');
      assert.equal(unreadable.data.length, 500, 'the unread rows are not dropped');
      assert.equal(sections.recentStreams.unreadable, true, 'and they are reported unreadable');
      assert.equal(sections.recentStreams.returned, 0, 'an unreadable key claims no rows, because it read none');
      assert.equal(
        sections.recentStreams.truncated, false,
        'no cap was applied, so nothing claims one was',
      );
      // The keys that WERE readable are still capped — one unreadable
      // collection must not disarm the cap on its siblings.
      assert.equal(shippedRows(wire, 'topTracks').length, 10);
      assert.equal(shippedRows(wire, 'topArtists').length, 10);
      assert.equal(wire.truncated, true, 'the top-level flag tracks the capped siblings');
    } finally {
      __resetStatsfmFetchImpl();
    }
  });
});
