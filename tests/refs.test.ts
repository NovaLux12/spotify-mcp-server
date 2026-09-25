import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySpotifyReference,
  normaliseToId,
  resolveSpotifyId,
  spotifyId,
  spotifyUri,
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
  `https://open.spotify.com/intl-de/embed/track/${ID}`,
  `https://open.spotify.com/embed/intl-de/track/${ID}`,
  `https://open.spotify.com/INTL-DE/TRACK/${ID}?utm_source=share`,
  `https://open.spotify.com/embed/track/${ID}#now-playing`,
  `  spotify:track:${ID}  `,
];
const PARITY_REFERENCES = [
  ...EQUIVALENT_TRACK_REFERENCES,
  `spotify:user:wizzler`,
  `spotify://user/user_name-1`,
  `https://open.spotify.com/user/wizzler`,
  `https://open.spotify.com/intl-fr/embed/user/user_name-1`,
  `https://open.spotify.com/embed/intl-fr/user/user_name-1`,
  `https://open.spotify.com/track/${ID.slice(0, 21)}`,
  `spotify:track:${ID}x`,
  `https://example.com/track/${ID}`,
  `https://open.spotify.com.example.com/track/${ID}`,
  `http://open.spotify.com/track/${ID}`,
  `https://open.spotify.com/device/${ID}`,
  `https://open.spotify.com/track/${ID}/extra`,
  `spotify:device:${ID}`,
  `spotify:track:${ID}?x=1`,
  `spotify:track:${ID}/extra`,
];

function makeRefsHarness() {
  const registered: Array<{
    name: string;
    description: string;
    annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
    schema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
    }>;
  }> = [];
  type Handler = (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, { safeParse(value: unknown): { success: boolean } }>,
      annotationsOrHandler: Handler | { readOnlyHint?: boolean; idempotentHint?: boolean },
      maybeHandler?: Handler,
    ) {
      const handler = typeof annotationsOrHandler === 'function' ? annotationsOrHandler : maybeHandler!;
      const annotations = typeof annotationsOrHandler === 'function' ? undefined : annotationsOrHandler;
      registered.push({ name, description, annotations, schema, handler });
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
  it('keeps parser and canonicalizer verdicts in parity across 20+ cases', () => {
    const invalid = new Set([
      `https://open.spotify.com/track/${ID.slice(0, 21)}`,
      `spotify:track:${ID}x`,
      `https://example.com/track/${ID}`,
      `https://open.spotify.com.example.com/track/${ID}`,
      `http://open.spotify.com/track/${ID}`,
      `https://open.spotify.com/device/${ID}`,
      `https://open.spotify.com/track/${ID}/extra`,
      `spotify:device:${ID}`,
      `spotify:track:${ID}?x=1`,
      `spotify:track:${ID}/extra`,
    ]);
    for (const reference of PARITY_REFERENCES) {
      assert.equal(classifySpotifyReference(reference).valid, !invalid.has(reference), reference);
    }
    const cases = [
      [ID, 'track'],
      [`spotify:track:${ID}`, 'track'],
      [`spotify://track/${ID}`, 'track'],
      [`https://open.spotify.com/track/${ID}`, 'track'],
      [`https://open.spotify.com/embed/track/${ID}`, 'track'],
      [`https://open.spotify.com/intl-de/track/${ID}`, 'track'],
      [`https://open.spotify.com/intl-de/embed/track/${ID}`, 'track'],
      [`https://open.spotify.com/embed/intl-de/track/${ID}`, 'track'],
      ['spotify:user:wizzler', 'user'],
      ['spotify://user/user_name-1', 'user'],
      ['https://open.spotify.com/user/wizzler', 'user'],
      ['https://open.spotify.com/embed/intl-fr/user/user_name-1', 'user'],
      ['user_name-1', 'user'],
      [ID, 'album'],
      [`spotify:album:${ID}`, 'album'],
      [`https://open.spotify.com/album/${ID}`, 'album'],
      [`https://open.spotify.com/embed/intl-de/artist/${ID}`, 'artist'],
      [`https://open.spotify.com/intl-de/embed/playlist/${ID}`, 'playlist'],
      [`spotify:show:${ID}`, 'show'],
      [`spotify:episode:${ID}`, 'episode'],
      [`spotify:audiobook:${ID}`, 'audiobook'],
    ] as const;
    for (const [reference, kind] of cases) {
      const parsed = classifySpotifyReference(reference, kind);
      assert.equal(parsed.valid, true, reference);
      assert.equal(spotifyUri(reference, kind), `spotify:${kind}:${parsed.id}`, reference);
    }
  });

  it('canonicalizes bare IDs only when expected_kind is supplied', () => {
    assert.equal(spotifyUri(ID), null);
    assert.equal(spotifyUri(ID, 'playlist'), `spotify:playlist:${ID}`);
  });
});

describe('curated reference tool surface', () => {
  it('registers exactly six non-redundant read-only tools', () => {
    const tools = makeRefsHarness().registered;
    const names = tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'parse_spotify_uri',
      'parse_spotify_uris',
      'format_spotify_uri',
      'canonicalize_spotify_uri',
      'dedupe_spotify_uris',
      'spotify_uri_stats',
    ]);
    for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
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
  it('deduplicates by full kind and ID and preserves invalid whitespace', async () => {
    const result = await makeRefsHarness().invoke('dedupe_spotify_uris', {
      uris: [ID, `spotify:track:${ID}`, `spotify:album:${ID}`, ' bad ', ' bad ', 'bad'],
    });
    assert.deepEqual(result.structuredContent?.unique, [ID, `spotify:track:${ID}`, `spotify:album:${ID}`, ' bad ', 'bad']);
  });
  it('uses expected_kind to deduplicate a bare ID with its typed URI', async () => {
    const result = await makeRefsHarness().invoke('dedupe_spotify_uris', {
      uris: [ID, `spotify:track:${ID}`],
      expected_kind: 'track',
    });
    assert.deepEqual(result.structuredContent?.unique, [ID]);
  });

  it('deduplicates equivalent references by canonical URI', async () => {
    const result = await makeRefsHarness().invoke('dedupe_spotify_uris', {
      uris: [ID, `spotify:track:${ID}`, `https://open.spotify.com/track/${ID}?si=x`],
      expected_kind: 'track',
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
