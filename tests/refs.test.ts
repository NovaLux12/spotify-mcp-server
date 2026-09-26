import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySpotifyReference,
  normaliseToId,
  resolveSpotifyId,
  spotifyId,
  spotifyUri,
} from '../src/refs.js';
import { normalizePlaylistReference, resolvePlaylistInput } from '../src/shaping.js';
import { registerSwarm3RefsTools } from '../src/tools/swarm3_refs.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as McpServerImpl } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { installToolErrorBoundary } from '../src/tools/annotations.js';
import { registerSwarm3AnalyticsTools } from '../src/tools/swarm3_analytics.js';
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

describe('playlist reference shaping', () => {
  const secondId = 'B'.repeat(22);
  const equivalent = [
    ID,
    `spotify:playlist:${ID}`,
    `spotify://playlist/${ID}`,
    `https://open.spotify.com/playlist/${ID}`,
    `https://open.spotify.com/embed/playlist/${ID}`,
    `https://open.spotify.com/intl-de/playlist/${ID}`,
    `https://open.spotify.com/intl-de/embed/playlist/${ID}`,
    `https://open.spotify.com/embed/intl-de/playlist/${ID}`,
  ];

  it('uses the canonical resolver grammar for every accepted playlist form', () => {
    for (const reference of equivalent) {
      const canonical = classifySpotifyReference(reference, 'playlist');
      assert.equal(canonical.valid, true, reference);
      assert.equal(normalizePlaylistReference(reference), canonical.id, reference);
    }
  });

  it('rejects malformed IDs, wrong kinds, insecure URLs, and hostile hosts', () => {
    for (const reference of [
      'short',
      ID.slice(0, 21),
      `${ID}x`,
      `spotify:track:${ID}`,
      `spotify:device:${ID}`,
      `spotify:playlist:${ID}?si=tracking`,
      `http://open.spotify.com/playlist/${ID}`,
      `https://example.com/playlist/${ID}`,
      `https://open.spotify.com.example.com/playlist/${ID}`,
      `https://open.spotify.com/device/${ID}`,
      `https://open.spotify.com/playlist/${ID}/extra`,
    ]) {
      assert.equal(classifySpotifyReference(reference, 'playlist').valid, false, reference);
      assert.throws(() => normalizePlaylistReference(reference), undefined, reference);
    }
  });

  it('preserves documented one-release aliases after canonical normalization', () => {
    const resolved = resolvePlaylistInput(
      { sources: [`spotify:playlist:${ID}`, `https://open.spotify.com/embed/intl-de/playlist/${secondId}`] },
      { kind: 'list', aliases: ['sources'] },
    );
    assert.deepEqual(resolved.values, [ID, secondId]);
    assert.deepEqual(resolved.deprecatedInputs, ['sources']);
    assert.match(resolved.deprecationNote ?? '', /use playlists.*Alias support/);
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

  // #825: the share-URL host must match exactly. These are the near misses a
  // suffix/substring/case-insensitive-but-loose check would let through.
  const HOST_TABLE: Array<{ url: string; accepted: boolean }> = [
    { url: `https://open.spotify.com/track/${ID}`, accepted: true },
    { url: `https://OPEN.SPOTIFY.COM/track/${ID}`, accepted: true },
    { url: `https://open.spotify.com:443/track/${ID}`, accepted: true },
    { url: `https://open.spotify.com.evil.test/track/${ID}`, accepted: false },
    { url: `https://open.spotify.com.example.com/track/${ID}`, accepted: false },
    { url: `https://OPEN.SPOTIFY.COM.EVIL.TEST/track/${ID}`, accepted: false },
    { url: `https://open.spotify.com.co/track/${ID}`, accepted: false },
    { url: `https://open.spotify.co/track/${ID}`, accepted: false },
    { url: `https://notopen.spotify.com/track/${ID}`, accepted: false },
    { url: `https://sub.open.spotify.com/track/${ID}`, accepted: false },
    { url: `https://open.spotify.com./track/${ID}`, accepted: false },
    { url: `https://open.spotify.com@evil.test/track/${ID}`, accepted: false },
    { url: `https://evil.test/open.spotify.com/track/${ID}`, accepted: false },
  ];

  it('accepts only the exact open.spotify.com host and refuses lookalikes', async () => {
    const harness = makeRefsHarness();
    for (const { url, accepted } of HOST_TABLE) {
      const parsed = (await harness.invoke('parse_spotify_uri', { uri: url, expected_kind: 'track' }))
        .structuredContent!;
      assert.equal(parsed.valid, accepted, url);
      if (accepted) {
        assert.equal(parsed.id, ID, url);
        assert.equal(parsed.canonical_uri, `spotify:track:${ID}`, url);
        continue;
      }
      // The lookalike must be refused outright, not resolved to an entity:
      // no id, no kind, no canonical URI leaks through any surface.
      assert.equal(parsed.id, null, url);
      assert.equal(parsed.kind, null, url);
      assert.equal(parsed.canonical_uri, null, url);

      const canonicalised = (await harness.invoke('canonicalize_spotify_uri', {
        uris: [url],
        expected_kind: 'track',
      })).structuredContent as { rows: Array<{ valid: boolean; canonical_uri: string | null }> };
      assert.deepEqual(canonicalised.rows, [{ input: url, canonical_uri: null, valid: false }], url);
    }
  });
});

// #584: the kind a schema declares is the kind the reference must carry. The
// resolver, the URI canonicalizer and the Zod schema all have to agree, and the
// disagreement has to be visible at the tool boundary as a validation error —
// an agent must never learn about a wrong entity kind by provoking a Spotify
// 404 (ids share one base62 space, so the request can even succeed).
describe('expectedKind enforcement (#584)', () => {
  const ARTIST_ID = '4iV5W9uYEdYUVa79Axb7Rh';
  const ALBUM_FORMS = [
    `spotify:album:${ARTIST_ID}`,
    `spotify://album/${ARTIST_ID}`,
    `https://open.spotify.com/album/${ARTIST_ID}`,
    `https://open.spotify.com/intl-de/embed/album/${ARTIST_ID}`,
  ];

  it('resolveSpotifyId returns null for every wrong-kind reference form', () => {
    for (const reference of ALBUM_FORMS) {
      assert.equal(resolveSpotifyId(reference, 'artist'), null, reference);
      assert.equal(spotifyUri(reference, 'artist'), null, reference);
      const parsed = classifySpotifyReference(reference, 'artist');
      assert.equal(parsed.valid, false, reference);
      assert.match(parsed.error ?? '', /expected artist, received album/, reference);
    }
  });

  it('spotifyId(expectedKind) rejects a wrong-kind URL and URI, accepts a bare id', () => {
    for (const reference of ALBUM_FORMS) {
      const rejected = spotifyId('artist').safeParse(reference);
      assert.equal(rejected.success, false, reference);
      assert.match(rejected.error?.issues[0]?.message ?? '', /expected artist, received album/, reference);
    }
    // A bare 22-character id carries no kind evidence, so the declared kind is
    // a caller constraint rather than a mismatch: it still has to pass.
    assert.equal(spotifyId('artist').parse(ARTIST_ID), ARTIST_ID);
    assert.equal(spotifyId('artist').parse(`spotify:artist:${ARTIST_ID}`), ARTIST_ID);
    assert.equal(spotifyId('artist').parse(`https://open.spotify.com/artist/${ARTIST_ID}`), ARTIST_ID);
  });

  it('every declared kind rejects every other kind, symmetrically', () => {
    const kinds = [
      'track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook', 'user',
    ] as const;
    for (const expected of kinds) {
      for (const actual of kinds) {
        // A well-formed 22-character id in every kind, so the only thing that
        // can reject these is the kind check and nothing else.
        assert.equal(spotifyId(expected).parse(`spotify:${expected}:${ARTIST_ID}`), ARTIST_ID);
        if (expected === actual) continue;
        assert.equal(
          spotifyId(expected).safeParse(`spotify:${actual}:${ARTIST_ID}`).success,
          false,
          `${expected} must refuse ${actual}`,
        );
      }
    }
  });

  async function boundaryHarness() {
    const requests: string[] = [];
    const client = {
      async get<T>(path: string): Promise<T | null> {
        requests.push(path);
        if (path === '/me/player/recently-played') {
          return { items: [], cursors: null, next: null } as unknown as T;
        }
        if (path === '/me/top/artists') return { items: [] } as unknown as T;
        return null;
      },
      async getAllPages<T>(): Promise<T[]> {
        requests.push('getAllPages');
        return [] as unknown as T[];
      },
    };
    const server = new McpServerImpl({ name: 'refs-boundary', version: '0.0.0' });
    registerSwarm3AnalyticsTools(server, client as unknown as SpotifyClient);
    installToolErrorBoundary(server);
    const mcp = new Client({ name: 'refs-boundary-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    return {
      requests,
      async deepDive(artist: string) {
        requests.length = 0;
        const result = await mcp.callTool({ name: 'deep_dive_report', arguments: { artist } });
        return {
          result: result as {
            isError?: boolean;
            content: Array<{ text: string }>;
            structuredContent?: Record<string, unknown>;
          },
          spotifyRequests: [...requests],
        };
      },
      async close() {
        await mcp.close();
        await server.close();
      },
    };
  }

  it('a tool boundary refuses a wrong-kind reference without calling Spotify', async () => {
    const harness = await boundaryHarness();
    try {
      for (const artist of ALBUM_FORMS) {
        const { result, spotifyRequests } = await harness.deepDive(artist);
        assert.equal(result.isError, true, artist);
        const error = result.structuredContent?.error as Record<string, unknown> | undefined;
        assert.equal(error?.kind, 'validation', artist);
        assert.equal(error?.param, 'artist', artist);
        assert.equal(error?.reason, 'validation_failed', artist);
        // The decisive half: the handler never ran, so this is a rejection and
        // not a Spotify 404 for a real-looking but wrong entity.
        assert.deepEqual(spotifyRequests, [], artist);
      }

      // The same tool accepts the two forms that carry artist evidence, and
      // both reach the client — so the guard is discriminating, not a blanket
      // refusal that would hide the tool.
      for (const artist of [ARTIST_ID, `spotify:artist:${ARTIST_ID}`, `https://open.spotify.com/artist/${ARTIST_ID}`]) {
        const { result, spotifyRequests } = await harness.deepDive(artist);
        assert.notEqual(result.isError, true, artist);
        assert.equal(
          (result.structuredContent as { artist_id?: string } | undefined)?.artist_id,
          ARTIST_ID,
          artist,
        );
        assert.ok(spotifyRequests.length > 0, artist);
      }
    } finally {
      await harness.close();
    }
  });
});
