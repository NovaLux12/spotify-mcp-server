/**
 * The surface-vocabulary gate (#1626).
 *
 * Epic #567 asked for one vocabulary for "how much of a paginated source to
 * walk", and the registry had fifteen spellings of it. It also asked for the
 * duplicate tool-name families to be resolved. Both of those are real, and both
 * of them share a failure mode this gate is built for: **there was nothing
 * watching.** No lint, no test, no CI step counted cap parameter names, so the
 * long tail grew every time a module was added, and no test would have noticed.
 *
 * ## What this gate asserts, and what it deliberately does not
 *
 * Three things, each a RATCHET rather than a zero assertion:
 *
 *  1. **The cap vocabulary.** Every parameter whose name means "how much of a
 *     paginated source to walk" must be one of a pinned set of names. A sixteenth
 *     spelling fails. This is the part that stops the drift.
 *  2. **The name families.** Two tools whose names normalise to the same stem
 *     must be a family this gate has already seen. A new collision fails.
 *  3. **The no-paging set.** A tool that declares a cap but exposes neither
 *     `offset` nor `fetch_all` is on a pinned list, and that list may not grow.
 *
 * It does NOT assert zero of anything, for the same reason
 * `tests/schema.descriptions.test.ts` does not: the honest state of the surface
 * is 15 cap names, 82 no-paging tools and 3 normalising families, and a gate that
 * demanded zero would be a gate that fails. Pinning the sets is what makes the
 * numbers visible and makes every reduction a deliberate, reviewable edit.
 *
 * ## The ambiguous-pair registry, and why a rename was NOT done
 *
 * The issue's sharpest case was `playlist_intersect` / `playlist_intersection` —
 * "two names for what reads as one operation, and a host cannot tell from the
 * names which is canonical".
 *
 * They are not one operation. `playlist_intersect` is the commit path (an atomic
 * `PUT` replace, "Keep only the tracks present in ALL"); `playlist_intersection`
 * is the read-only analysis (a membership report, which playlists each common
 * track appears in). The decision recorded here is **not to rename either**:
 *
 *  - Both names shipped in v3.0, and a rename is a breaking change for every host
 *    that calls one of them. A readability nit is not worth that, and
 *    `AGENTS.md` §5 makes the retirement ceremony for a name explicit enough that
 *    it is clearly not a thing to do casually.
 *  - The descriptions already say which is which. What was missing was a gate
 *    that KEEPS them saying it — which is what `AMBIGUOUS_PAIRS` below is.
 *
 * So each entry states the one sentence that distinguishes the pair, and the gate
 * fails if a description stops carrying its half of it. That fixes the actual
 * defect (a host cannot tell them apart) without breaking anyone.
 *
 * Run: node --import tsx --test tests/schema.vocabulary.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { buildFullRegistryServer } from './live-registry.js';
import { finalInputSchema } from '../src/shaping.js';
import type { SpotifyClient } from '../src/client.js';

interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A parameter that bounds how much of a paginated source a walk reads. */
const isCapParam = (param: string): boolean =>
  param.endsWith('_cap')
  || param === 'fetch_all'
  || param === 'pages'
  || param === 'max_pages';

/** Parameters that let a caller move through a paginated result. */
const pagingParams = (params: readonly string[]): boolean =>
  params.includes('offset') || params.includes('fetch_all');

/**
 * The suffixes the name-family normaliser strips.
 *
 * These are the repo's own commit-path and reporting conventions, which is why
 * stripping them is safe: `AGENTS.md` §4 states that a `*_plan` tool is a write,
 * so `merge_playlists` and `merge_playlists_plan` are a commit pair BY DESIGN and
 * the pair is not a defect. The gate pins those pairs as seen; it does not
 * pretend they are not there.
 */
const REPORT_SUFFIX = /(report|plan|summary|analysis|details|lint|check|stats)$/;

/**
 * Normalise a tool name to the stem two names share when they differ only by a
 * reporting suffix or by plurality.
 *
 * Deliberately NOT a fuzzy matcher. `playlist_intersect` and
 * `playlist_intersection` do NOT normalise to the same stem under this rule, and
 * they are not supposed to: a gate that merged them through string distance would
 * merge half the surface, and the number of false families it reported would
 * train everyone to ignore it. Pairs this normaliser cannot see live in
 * `AMBIGUOUS_PAIRS`, which is a list a human reviewed.
 */
const stemOf = (name: string): string => name.replace(REPORT_SUFFIX, '').replace(/s$/, '');

/**
 * The near-identical name pairs the stem normaliser cannot see, and the one
 * sentence each pair's descriptions must keep saying.
 *
 * A pair belongs here only while two conditions hold: the names normalise
 * differently (so no other gate will see them) AND a host can tell them apart
 * only by reading the descriptions. The `mustSay` half is the assertion — it is
 * what stops the pair drifting back into being indistinguishable.
 */
const AMBIGUOUS_PAIRS: readonly { readonly pair: readonly [string, string]; readonly mustSay: readonly [RegExp, RegExp] }[] = [
  {
    // The issue's sharpest case. Not renamed; see this file's header for why.
    pair: ['playlist_intersect', 'playlist_intersection'],
    mustSay: [
      /atomic replace|replace/i,
      /read-only|report/i,
    ],
  },
];

/** Read the live registry the way a full-scope install builds it. */
async function liveSurface(): Promise<Record<string, Tool>> {
  const server = await buildFullRegistryServer();
  return (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
}

function paramsOf(tool: Tool): string[] {
  const props = finalInputSchema(tool.inputSchema)?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.keys(props as Record<string, unknown>);
}

describe('cap vocabulary (#1626)', () => {
  it('every cap-shaped parameter name is one the gate has already seen', async () => {
    const surface = await liveSurface();
    const seen = new Set<string>();
    for (const [name, tool] of Object.entries(surface)) {
      for (const param of paramsOf(tool)) {
        if (isCapParam(param)) seen.add(param);
      }
    }
    // The pinned vocabulary. Ordered by count at the time it was measured, which
    // is the information a reader wants first: `scan_cap` has won and the other
    // fourteen are the long tail. Unifying them is a product decision (the issue
    // is explicit that `scan_cap`, a count, and `fetch_all`, a boolean, are not
    // even the same concept); refusing a SIXTEENTH spelling is what is actionable
    // today.
    const known = new Set([
      'scan_cap', 'fetch_all', 'pages', 'artists_cap', 'saved_cap',
      'saved_album_cap', 'saved_track_cap', 'walk_cap', 'max_pages', 'fresh_cap',
      'liked_cap', 'per_playlist_cap', 'first_degree_cap', 'candidates_cap',
      'item_cap',
    ]);
    const unknown = [...seen].filter((param) => !known.has(param)).sort();
    assert.deepEqual(
      unknown,
      [],
      `a new cap parameter name would be the sixteenth spelling of "how much of a paginated source to walk". `
      + `Add it to the vocabulary here only after deciding whether it is a synonym for an existing name:\n  ${unknown.join('\n  ')}`,
    );
    // And a name the vocabulary still carries but the surface no longer uses is
    // a stale row, not a free pass: the next author would read the vocabulary as
    // the live surface.
    const retired = [...known].filter((param) => !seen.has(param)).sort();
    assert.deepEqual(retired, [], `cap names in the vocabulary that no registered tool declares: ${retired.join(', ')}`);
  });
});

describe('duplicate name families (#1626)', () => {
  it('a new collision between two tool names fails the gate', async () => {
    const surface = await liveSurface();
    const families = new Map<string, string[]>();
    for (const name of Object.keys(surface)) {
      families.set(stemOf(name), [...(families.get(stemOf(name)) ?? []), name]);
    }
    const collisions = [...families.values()]
      .filter((members) => members.length > 1)
      .map((members) => [...members].sort())
      .sort();

    // The pinned set, measured on the merged tree. Every one of these is a
    // commit pair or a plural twin that the repo's own conventions create on
    // purpose, so the gate records them rather than failing on them.
    const known = [
      ['parse_spotify_uri', 'parse_spotify_uris'],
      ['show_backlog_plan', 'show_backlog_report'],
      ['snapshot_integrity_check', 'snapshot_integrity_report'],
    ];
    assert.deepEqual(
      collisions,
      known,
      'a new pair of tools whose names normalise to the same stem. Either rename one, or add it to the '
      + `pinned list with a stated reason:\n  ${JSON.stringify(collisions)}`,
    );
  });

  it('an ambiguous pair keeps saying what distinguishes it', async () => {
    const surface = await liveSurface();
    for (const entry of AMBIGUOUS_PAIRS) {
      for (let index = 0; index < entry.pair.length; index += 1) {
        const name = entry.pair[index]!;
        const tool = surface[name];
        assert.ok(tool, `${name} must be registered; it is named in AMBIGUOUS_PAIRS`);
        assert.match(
          tool.description ?? '',
          entry.mustSay[index]!,
          `${name}'s description must keep saying what distinguishes it from ${entry.pair[1 - index]!} — `
          + 'that sentence is the only thing letting a host tell the pair apart',
        );
      }
    }
  });

  /**
   * Every name this gate pins is also CALLED, through a real MCP client.
   *
   * The pinned lists above name tools, and `tests/tool.coverage.test.ts` treats
   * a name appearing in a test source as evidence the tool is exercised. Naming
   * a tool in a regression pin is not that — it is evidence somebody thought
   * about it — so the three names the two gates share get a real invocation
   * here, and the `KNOWN_UNTESTED` entries come out honestly rather than being
   * deleted to satisfy a count.
   *
   * The discriminating assertion is that each call reaches the handler and
   * returns the shared envelope: a tool whose handler threw would surface as an
   * MCP error rather than a structured result, and a tool that never ran would
   * return nothing at all.
   */
  it('every pinned family member answers a real call', async () => {
    const server = new McpServer({ name: 'vocab-invocation', version: '0.0.0' });
    const client = {
      get: async () => null,
      post: async () => null,
      put: async () => null,
      delete: async () => null,
      getAllPages: async () => [],
    } as unknown as SpotifyClient;
    // Registered through their own registrars rather than through the manifest so
    // this test does not depend on which toolsets are active: the question is
    // whether these three answer, not whether a trim let them register.
    const { registerExhaust2PlaylistsTools } = await import('../src/tools/exhaust2_playlists.js');
    const { registerSwarm3PlaylistopsTools } = await import('../src/tools/swarm3_playlistops.js');
    const { registerSwarm3SnapshotsTools } = await import('../src/tools/swarm3_snapshots.js');
    const { registerSwarm3RefsTools } = await import('../src/tools/swarm3_refs.js');
    const { registerShowRadarTools } = await import('../src/tools/showradar.js');
    const { registerSwarm3ShowsTools } = await import('../src/tools/swarm3_shows.js');
    registerExhaust2PlaylistsTools(server, client);
    registerSwarm3PlaylistopsTools(server, client);
    registerSwarm3SnapshotsTools(server, client);
    registerSwarm3RefsTools(server, client);
    registerShowRadarTools(server, client);
    registerSwarm3ShowsTools(server, client);

    // Exactly the names the pinned lists above hold that had no invocation
    // anywhere in the suite. The rest of each family already has its own test
    // file, and naming them here as well would be the false claim this test
    // exists to avoid making.
    const named = [
      ...AMBIGUOUS_PAIRS.flatMap((entry) => entry.pair),
      'snapshot_integrity_check',
      'snapshot_integrity_report',
    ];

    const mcp = new Client({ name: 'vocab-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      const listed = (await mcp.listTools()).tools.map((tool) => tool.name);
      for (const name of named) {
        assert.ok(listed.includes(name), `${name} must be registered for this gate to invoke it`);
      }
      for (const name of named) {
        // `arguments: {}` on purpose. Each of these declares its inputs as
        // optional or already-resolved, so an empty call is a legal one, and a
        // tool that refuses it does so through the shared envelope.
        const result = (await mcp.callTool({ name, arguments: {} })) as CallToolResult;
        assert.ok(
          Array.isArray(result.content) && result.content.length > 0,
          `${name} returned no content blocks — the handler did not run`,
        );
      }
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});

describe('capped reads with no way to page (#1626)', () => {
  it('the set of cap-declaring tools with neither offset nor fetch_all may not grow', async () => {
    const surface = await liveSurface();
    const cappedWithoutPaging: string[] = [];
    for (const [name, tool] of Object.entries(surface)) {
      const params = paramsOf(tool);
      const declaresCap = params.some(isCapParam);
      const mentionsCap = /\bcap\b|truncat|paging|pagination/i.test(tool.description ?? '');
      if ((declaresCap || mentionsCap) && !pagingParams(params)) cappedWithoutPaging.push(name);
    }
    cappedWithoutPaging.sort();

    // Measured on the merged tree: 82 tools. The issue put this at 150 under a
    // looser keyword filter and then corrected itself to "150 of 175" under a
    // stated one; this is the figure for the filter asserted here, which is the
    // one that can be checked. The issue asked for a decision about which of
    // them are bounded BY DESIGN and which are an oversight — that is a
    // per-module review, not a regex, so this gate pins the set and refuses
    // growth while it happens.
    assert.equal(
      cappedWithoutPaging.length,
      82,
      'a new capped read with no paging. Either give it `offset` or `fetch_all`, or record here that it is '
      + 'bounded by design, with the reason',
    );
    assert.ok(
      cappedWithoutPaging.includes('playlist_union'),
      'the anchor case: playlist_union is a capped walk with no paging, and if it starts declaring one the '
      + 'set has moved and this assertion has to be re-derived',
    );
  });
});
