/**
 * Executing-path coverage for the two `swarm3_refs` handlers that #668 found
 * were registered but never invoked.
 *
 * `format_spotify_uri` and `spotify_uri_stats` appeared in `tests/refs.test.ts`
 * and `tests/tools.discovery.test.ts` only inside a `deepEqual` list of
 * registered NAMES, so the suite proved they exist and never called them —
 * the exact "exercises the code around them, not them" shape the issue
 * describes. Both are now driven through their declared schema.
 *
 * Note on the module's shape, which corrects the issue's framing: `swarm3_refs`
 * takes its `SpotifyClient` as `_client` and never uses it. All six tools are
 * local classification/canonicalisation over `../refs.js` and make **no**
 * Spotify call, so there is no wire call here to assert — the contract is the
 * parsed output. The client stub below throws if anything reaches it, which is
 * the assertion that would catch a future tool in this module starting to call
 * the API without the file saying so.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3RefsTools } from '../src/tools/swarm3_refs.js';

const ID = '4iV5W9uYEdYUVa79Axb7Rh';
const SHORT_ID = '4iV5W9uYEdYUVa79Axb7'; // 21 base62 characters

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type Registered = {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const invoked = new Set<string>();

function makeHarness() {
  const registered: Registered[] = [];
  const server = {
    // This module registers the FIVE-argument form —
    // tool(name, description, schema, annotations, handler). A stub that reads
    // only four arguments captures `annotations` in the handler slot and every
    // case below then throws `handler is not a function` (#659's bug class).
    // Both forms are accepted and the handler slot is asserted to be callable,
    // so a change of arity fails here rather than silently.
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      annotationsOrHandler: Registered['handler'] | Record<string, unknown>,
      maybeHandler?: Registered['handler'],
    ) {
      const handler = typeof annotationsOrHandler === 'function' ? annotationsOrHandler : maybeHandler;
      assert.equal(
        typeof handler,
        'function',
        `tool "${name}" registered without a callable handler — the stub dropped an argument`,
      );
      registered.push({ name, schema, handler: handler as Registered['handler'] });
    },
  } as unknown as McpServer;

  // Any call at all is a defect for this module, so the stub fails loudly
  // rather than returning a plausible-looking empty response.
  const client = new Proxy(
    {},
    {
      get(_t, prop) {
        return () => {
          throw new Error(`swarm3_refs made a client.${String(prop)}() call; the module is local-only by design`);
        };
      },
    },
  ) as unknown as SpotifyClient;

  registerSwarm3RefsTools(server, client);

  return {
    names: () => registered.map((t) => t.name),
    find: (name: string) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" must be registered — a missing tool makes every case below vacuous`);
      return tool;
    },
    invoke: async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" must be registered`);
      invoked.add(name);
      return tool.handler(z.object(tool.schema).parse(args) as Record<string, unknown>);
    },
    text: (r: ToolResult) => r.content.map((c) => c.text).join('\n'),
    structured: (r: ToolResult) => r.structuredContent as Record<string, unknown>,
  };
}

// ===========================================================================
// format_spotify_uri
// ===========================================================================

describe('#668 format_spotify_uri', () => {
  it('formats a valid 22-character catalog id into its canonical URI', async () => {
    const h = makeHarness();
    const out = await h.invoke('format_spotify_uri', { kind: 'track', id: ID });
    const sc = h.structured(out);
    assert.equal(sc.valid, true);
    assert.equal(sc.canonical_uri, `spotify:track:${ID}`);
    assert.equal(sc.error, null);
    assert.deepEqual({ kind: sc.kind, id: sc.id }, { kind: 'track', id: ID });
  });

  it('rejects a 21-character id and says the rule it applied', async () => {
    const h = makeHarness();
    const out = await h.invoke('format_spotify_uri', { kind: 'track', id: SHORT_ID });
    const sc = h.structured(out);
    assert.equal(sc.valid, false);
    assert.equal(sc.canonical_uri, null);
    assert.equal(
      sc.error,
      'invalid Spotify track ID: expected exactly 22 base62 characters',
      'the message must name the rule, and must differ from the user-kind message',
    );
  });

  it('applies the user-kind length rule instead of the catalog one', async () => {
    const h = makeHarness();
    // A user id is not 22 characters — that is legal for `user` and only there.
    const ok = h.structured(await h.invoke('format_spotify_uri', { kind: 'user', id: 'wizzler' }));
    assert.equal(ok.valid, true);
    assert.equal(ok.canonical_uri, 'spotify:user:wizzler');

    const bad = h.structured(await h.invoke('format_spotify_uri', { kind: 'user', id: 'not a user id!' }));
    assert.equal(bad.valid, false);
    assert.equal(bad.error, 'invalid Spotify user ID: expected one or more URL-safe characters');
  });

  it('rejects a non-base62 character in an otherwise well-sized id', async () => {
    const h = makeHarness();
    const sc = h.structured(await h.invoke('format_spotify_uri', { kind: 'album', id: `${'4'.repeat(21)}!` }));
    assert.equal(sc.valid, false);
    assert.equal(sc.canonical_uri, null);
  });

  it('rejects an unknown kind at the schema, before the handler runs', async () => {
    const h = makeHarness();
    // The enum is the schema's job; assert it fails rather than silently passing.
    await assert.rejects(
      () => h.invoke('format_spotify_uri', { kind: 'device', id: ID }),
      /invalid|expected|kind/i,
      'an entity kind outside the eight Spotify kinds must be refused by the schema',
    );
  });
});

// ===========================================================================
// spotify_uri_stats
// ===========================================================================

describe('#668 spotify_uri_stats', () => {
  const MIXED = [
    ID, // bare id
    `spotify:track:${ID}`, // uri
    `https://open.spotify.com/track/${ID}`, // url
    'not-a-spotify-thing', // invalid
    `spotify:album:${ID}`, // uri, a different kind
  ];

  it('counts validity across the batch', async () => {
    const h = makeHarness();
    const out = await h.invoke('spotify_uri_stats', { uris: MIXED });
    const sc = h.structured(out);
    assert.equal(sc.total, 5);
    assert.equal(sc.valid, 4);
    assert.equal(sc.invalid, 1);
    assert.equal(sc.group_by, 'form', 'form is the documented default');
  });

  it('groups by form by default and counts each spelling', async () => {
    const h = makeHarness();
    const sc = h.structured(await h.invoke('spotify_uri_stats', { uris: MIXED }));
    assert.deepEqual(sc.counts, { id: 1, invalid: 1, uri: 2, url: 1 });
  });

  it('groups by kind when asked, and reports the dimension it used', async () => {
    const h = makeHarness();
    const sc = h.structured(await h.invoke('spotify_uri_stats', { uris: MIXED, group_by: 'kind' }));
    assert.equal(sc.group_by, 'kind');
    // Grouping by kind reads `row.kind`, which is null for a bare id with no
    // expected_kind AND for an unparseable input — so both land in `unknown`.
    // Note this differs from grouping by `form`, where a bad input's form is
    // literally 'invalid'; that asymmetry is the contract, not a slip.
    assert.deepEqual(sc.counts, { album: 1, track: 2, unknown: 2 });
    assert.equal(sc.invalid, 1, 'the unparseable input is still counted invalid');
  });

  it('returns zeroed counts for an empty list instead of throwing', async () => {
    const h = makeHarness();
    const sc = h.structured(await h.invoke('spotify_uri_stats', { uris: [] }));
    assert.equal(sc.total, 0);
    assert.equal(sc.valid, 0);
    assert.equal(sc.invalid, 0);
    assert.deepEqual(sc.counts, {});
  });

  it('counts an all-invalid batch at zero valid', async () => {
    const h = makeHarness();
    const sc = h.structured(await h.invoke('spotify_uri_stats', {
      uris: ['nope', 'https://example.com/track/x'],
      group_by: 'kind',
    }));
    assert.equal(sc.total, 2);
    assert.equal(sc.valid, 0);
    assert.equal(sc.invalid, 2);
    assert.deepEqual(sc.counts, { unknown: 2 });
  });

  it('applies expected_kind to a bare id and rejects a typed reference of another kind', async () => {
    const h = makeHarness();
    const sc = h.structured(await h.invoke('spotify_uri_stats', {
      uris: [ID, `spotify:user:${ID}`, `spotify:track:${ID}`],
      expected_kind: 'track',
      group_by: 'kind',
    }));
    // The bare id borrows the caller's kind; the two typed references keep
    // their own, and the one that contradicts the constraint is invalid — but
    // it is invalid *while still declaring* `user`, so it groups as `user`
    // rather than as `unknown`. Grouping reads `row.kind`, not `row.valid`.
    assert.equal(sc.valid, 2);
    assert.equal(sc.invalid, 1);
    assert.deepEqual(sc.counts, { track: 2, user: 1 });
  });
});

// ===========================================================================
// Anti-vacuity
// ===========================================================================

describe('#668 swarm3_refs anti-vacuity', () => {
  it('registers exactly the six local reference tools', () => {
    const names = makeHarness().names();
    assert.deepEqual(names, [
      'parse_spotify_uri',
      'parse_spotify_uris',
      'format_spotify_uri',
      'canonicalize_spotify_uri',
      'dedupe_spotify_uris',
      'spotify_uri_stats',
    ]);
  });

  it('classifies all six as read-only, so a host never prompts for local parsing', async () => {
    const { classifyToolAnnotations } = await import('../src/tools/annotations.js');
    for (const name of makeHarness().names()) {
      assert.deepEqual(
        classifyToolAnnotations(name),
        { readOnlyHint: true, idempotentHint: true },
        `${name} is local classification with no API or filesystem write`,
      );
    }
  });

  it('leaves no handler unclaimed: every registered tool is driven here or by tests/refs.test.ts', () => {
    // Runs after the cases above, so `invoked` is complete. It is an `it`, not
    // an `after` hook, so a name-filtered debugging run skips it instead of
    // reporting a false failure against tools it never got to exercise.
    const COVERED_IN_REFS_TEST = new Set([
      'parse_spotify_uri',
      'parse_spotify_uris',
      'canonicalize_spotify_uri',
      'dedupe_spotify_uris',
    ]);
    const unclaimed = makeHarness().names().filter((n) => !invoked.has(n) && !COVERED_IN_REFS_TEST.has(n));
    assert.deepEqual(
      unclaimed,
      [],
      `these swarm3_refs handlers are registered but no test invokes them: ${unclaimed.join(', ')}`,
    );
    assert.deepEqual([...invoked].sort(), ['format_spotify_uri', 'spotify_uri_stats']);
  });
});
