import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySpotifyReference,
  normaliseToId,
  resolveSpotifyId,
  spotifyId,
} from '../src/refs.js';
import { registerSwarm3RefsTools } from '../src/tools/swarm3_refs.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';

const ID = '4iV5W9uYEdYUVa79Axb7Rh';
const EQUIVALENT_TRACK_REFERENCES = [
  ID,
  `spotify:track:${ID}`,
  `spotify://track/${ID}`,
  `spotify://track:${ID}`,
  `https://open.spotify.com/track/${ID}`,
  `https://open.spotify.com/track/${ID}?si=tracking`,
  `https://open.spotify.com/embed/track/${ID}`,
  `https://open.spotify.com/intl-de/track/${ID}`,
];

function makeRefsHarness() {
  const registered: Array<{
    name: string;
    description: string;
    schema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    }>;
  }> = [];
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, { safeParse(value: unknown): { success: boolean } }>,
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      }>,
    ) {
      registered.push({ name, description, schema, handler });
    },
  } as unknown as McpServer;
  registerSwarm3RefsTools(server, {} as SpotifyClient);
  return {
    registered,
    async invoke(name: string, args: Record<string, unknown>) {
      const tool = registered.find((candidate) => candidate.name === name);
      assert.ok(tool, `expected ${name} to be registered`);
      return tool.handler(args);
    },
  };
}

describe('shared Spotify reference policy', () => {
  const equivalent = EQUIVALENT_TRACK_REFERENCES;
  for (const reference of equivalent) {
    it(`normalises ${reference} to the bare ID`, () => {
      assert.equal(resolveSpotifyId(reference), ID);
      assert.equal(normaliseToId(reference), ID);
    });
  }

  it('rejects hostile and non-official URL hosts before resolution', () => {
    for (const reference of [
      `https://example.com/track/${ID}`,
      `https://open.spotify.com.example.com/track/${ID}`,
      `http://open.spotify.com/track/${ID}`,
    ]) {
      const parsed = classifySpotifyReference(reference);
      assert.equal(parsed.valid, false, reference);
      assert.equal(resolveSpotifyId(reference), null, reference);
    }
  });

  it('enforces ID and entity-kind boundaries', () => {
    assert.equal(classifySpotifyReference('short5').valid, false);
    assert.equal(classifySpotifyReference(`${ID}x`).valid, false);
    assert.equal(classifySpotifyReference(`spotify:device:${ID}`).valid, false);
    assert.equal(classifySpotifyReference(`https://open.spotify.com/device/${ID}`).valid, false);

    const mismatch = classifySpotifyReference(`spotify:album:${ID}`, 'track');
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.error ?? '', /expected track, received album/);
  });

  it('spotifyId normalises equivalent references and rejects hostile input', () => {
    assert.equal(spotifyId('track').parse(`https://open.spotify.com/track/${ID}`), ID);
    assert.equal(spotifyId('track').safeParse(`https://example.com/track/${ID}`).success, false);
    assert.equal(spotifyId('track').safeParse(`spotify:album:${ID}`).success, false);
  });
});

describe('curated reference tool surface', () => {
  it('registers exactly six non-redundant tools', () => {
    const names = makeRefsHarness().registered.map((tool) => tool.name);
    assert.deepEqual(names, [
      'parse_spotify_uri',
      'parse_spotify_uris',
      'format_spotify_uri',
      'canonicalize_spotify_uri',
      'dedupe_spotify_uris',
      'spotify_uri_stats',
    ]);
  });

  it('parses and canonicalises equivalent references identically', async () => {
    const harness = makeRefsHarness();
    const result = await harness.invoke('parse_spotify_uris', {
      uris: EQUIVALENT_TRACK_REFERENCES,
      expected_kind: 'track',
    });
    assert.equal(result.structuredContent?.valid, EQUIVALENT_TRACK_REFERENCES.length);
    for (const row of result.structuredContent?.results as Array<{ id: string; canonical_uri: string }>) {
      assert.equal(row.id, ID);
      assert.equal(row.canonical_uri, `spotify:track:${ID}`);
    }
  });

  it('deduplicates equivalent references by canonical URI', async () => {
    const result = await makeRefsHarness().invoke('dedupe_spotify_uris', {
      uris: [ID, `spotify:track:${ID}`, `https://open.spotify.com/track/${ID}?si=x`],
    });
    assert.deepEqual(result.structuredContent, {
      count_in: 3,
      count_out: 1,
      duplicates_removed: 2,
      unique: [ID],
    });
  });

  it('reports invalid references in batches instead of throwing', async () => {
    const result = await makeRefsHarness().invoke('parse_spotify_uris', {
      uris: [`https://example.com/track/${ID}`, `spotify:device:${ID}`],
    });
    assert.equal(result.structuredContent?.valid, 0);
    assert.equal((result.structuredContent?.results as unknown[]).length, 2);
  });
});
