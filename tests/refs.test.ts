import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpotifyId, normaliseToId } from '../src/refs.js';
import { registerSwarm3RefsTools } from '../src/tools/swarm3_refs.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';

describe('refs — resolveSpotifyId', () => {
  const cases: Array<[string, string | null]> = [
    // Bare ID
    ['4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    // spotify: URI
    ['spotify:track:4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    ['spotify:playlist:37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DX0XUsuxWHRQd'],
    ['spotify:album:6akEvsycLGftJxYudPjmq', '6akEvsycLGftJxYudPjmq'],
    ['spotify:episode:512ojhOuo1ktJprKbVcKyQ', '512ojhOuo1ktJprKbVcKyQ'],
    // open.spotify.com URLs
    ['https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    ['https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd?si=abc123', '37i9dQZF1DX0XUsuxWHRQd'],
    ['https://open.spotify.com/album/6akEvsycLGftJxYudPjmq?si=xyz', '6akEvsycLGftJxYudPjmq'],
    ['https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ', '512ojhOuo1ktJprKbVcKyQ'],
    ['https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?utm_source=copy', '4iV5W9uYEdYUVa79Axb7Rh'],
    // embed URL
    ['https://open.spotify.com/embed/track/4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    // spotify:// scheme
    ['spotify://track/4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    ['spotify://playlist:37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DX0XUsuxWHRQd'],
    // Whitespace trimming
    ['  spotify:track:4iV5W9uYEdYUVa79Axb7Rh  ', '4iV5W9uYEdYUVa79Axb7Rh'],
    ['  https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh  ', '4iV5W9uYEdYUVa79Axb7Rh'],
  ];
  for (const [input, expected] of cases) {
    it(`resolves ${JSON.stringify(input)} → ${expected}`, () => {
      assert.equal(resolveSpotifyId(input), expected);
    });
  }
  it('returns null for unrecognised input', () => {
    assert.equal(resolveSpotifyId('not-a-spotify-ref'), null);
    assert.equal(resolveSpotifyId(''), null);
  });
  it('normaliseToId round-trips share URL to bare ID', () => {
    assert.equal(normaliseToId('https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?si=abc'), '4iV5W9uYEdYUVa79Axb7Rh');
  });
  it('normaliseToId passes through bare ID unchanged', () => {
    assert.equal(normaliseToId('4iV5W9uYEdYUVa79Axb7Rh'), '4iV5W9uYEdYUVa79Axb7Rh');
  });
});

// ------------------------------------------------------------------
// swarm3 refs tools: batch_parse_spotify_uris + uri_namespace_census
// ------------------------------------------------------------------

function makeRefsHarness() {
  const registered: Array<{ name: string; description: string; schema: Record<string, { safeParse(v: unknown): { success: boolean } }>; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }> }> = [];
  const calls: Array<{ method: string; path: string }> = [];
  const server = {
    tool(name: string, description: string, schema: Record<string, { safeParse(v: unknown): { success: boolean } }>, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>) {
      registered.push({ name, description, schema, handler });
    },
  } as unknown as McpServer;
  const client = {
    async get(_path: string) { calls.push({ method: 'GET', path: _path }); return null; },
  } as unknown as SpotifyClient;
  registerSwarm3RefsTools(server, client);
  const findTool = (name: string) => {
    const tool = registered.find((t) => t.name === name);
    assert.ok(tool, `expected tool ${name} to be registered`);
    return tool;
  };
  return { registered, calls, findTool, invoke: async (name: string, args: Record<string, unknown>) => {
    const tool = findTool(name);
    return tool.handler(args);
  }, text: (r: { content: Array<{ type: string; text: string }> }) => r.content[0].text };
}

describe('batch_parse_spotify_uris', () => {
  it('parses a 500-URI batch at the cap without error', async () => {
    const h = makeRefsHarness();
    const uris = Array.from({ length: 500 }, (_, i) => `spotify:track:${String(i).padStart(22, '0')}`);
    const result = await h.invoke('batch_parse_spotify_uris', { uris });
    const parsed = JSON.parse(h.text(result));
    assert.equal(parsed.count, 500);
    assert.equal(parsed.valid, 500);
    assert.equal(parsed.results.length, 500);
  });

  it('handles mixed valid/invalid URIs — reports valid count and invalid entries', async () => {
    const h = makeRefsHarness();
    const uris = [
      'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
      'spotify:album:6akEvsycLGftJxYudPjmq',
      'not-a-uri',
      'https://open.spotify.com/artist:art1', // malformed URL (colon in path)
      '',
    ];
    const result = await h.invoke('batch_parse_spotify_uris', { uris });
    const parsed = JSON.parse(h.text(result));
    assert.equal(parsed.count, 5);
    assert.ok(parsed.valid < 5, 'some entries should be invalid');
    assert.ok(parsed.results.some((r: Record<string, unknown>) => r.valid === false), 'at least one result should be invalid');
  });

  it('accepts an empty array (no .min(1) on schema) and returns zero counts', async () => {
    const h = makeRefsHarness();
    const result = await h.invoke('batch_parse_spotify_uris', { uris: [] });
    const parsed = JSON.parse(h.text(result));
    assert.equal(parsed.count, 0);
    assert.equal(parsed.valid, 0);
    assert.deepEqual(parsed.results, []);
  });

  it('rejects arrays exceeding 500 entries via schema', async () => {
    const h = makeRefsHarness();
    const uris = Array.from({ length: 501 }, (_, i) => `spotify:track:${String(i).padStart(22, '0')}`);
    const schema = h.findTool('batch_parse_spotify_uris').schema.uris;
    assert.equal(schema.safeParse(uris).success, false, 'schema max(500) must reject 501 URIs');
  });

  it('structuredContent carries census breakdown', async () => {
    const h = makeRefsHarness();
    const uris = [
      'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
      'spotify:track:6akEvsycLGftJxYudPjmq',
      'spotify:album:alb123456789012345678',
      'not-a-uri',
    ];
    const result = await h.invoke('batch_parse_spotify_uris', { uris });
    assert.ok(result.structuredContent, 'structuredContent must be present');
    assert.equal(result.structuredContent.count, 4);
    assert.ok(result.structuredContent.form_counts, 'form_counts must be present');
  });
});

describe('uri_namespace_census', () => {
  it('returns empty counts for an empty input array', async () => {
    const h = makeRefsHarness();
    const result = await h.invoke('uri_namespace_census', { uris: [] });
    const parsed = JSON.parse(h.text(result));
    assert.equal(parsed.total, 0);
    assert.deepEqual(parsed.forms, {});
    assert.deepEqual(parsed.kinds, {});
  });

  it('groups mixed URI types into form and kind counts', async () => {
    const h = makeRefsHarness();
    const uris = [
      'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
      'spotify:album:6akEvsycLGftJxYudPjmq',
      'https://open.spotify.com/artist:art1', // malformed URL
      '4iV5W9uYEdYUVa79Axb7Rh', // bare id
      'spotify:episode:512ojhOuo1ktJprKbVcKyQ',
    ];
    const result = await h.invoke('uri_namespace_census', { uris });
    const parsed = JSON.parse(h.text(result));
    assert.equal(parsed.total, 5);
    // forms: at least uri, id, invalid present
    assert.ok(parsed.forms.uri >= 2, 'at least 2 URIs expected');
    assert.ok(parsed.forms.id >= 1, 'at least 1 bare id expected');
    assert.ok(parsed.forms.invalid >= 1, 'at least 1 invalid expected');
    // kinds: track, album, episode present
    assert.equal(parsed.kinds.track, 1);
    assert.equal(parsed.kinds.album, 1);
    assert.equal(parsed.kinds.episode, 1);
  });

  it('structuredContent rows mirror the input order', async () => {
    const h = makeRefsHarness();
    const uris = ['spotify:track:4iV5W9uYEdYUVa79Axb7Rh', 'nonsense', 'spotify:album:alb123456789012345678'];
    const result = await h.invoke('uri_namespace_census', { uris });
    assert.ok(result.structuredContent);
    const rows = result.structuredContent.rows as Array<{ input: string; form: string; kind: string | null }>;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].input, 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh');
    assert.equal(rows[0].form, 'uri');
    assert.equal(rows[1].form, 'invalid');
    assert.equal(rows[2].form, 'uri');
  });
});
