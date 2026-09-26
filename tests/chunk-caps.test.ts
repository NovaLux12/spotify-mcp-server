/**
 * #583: the batch-size policy is one table (`src/chunk.ts`), and every batch
 * loop in `src/tools/**` takes its bound from it.
 *
 * Three things are guarded here:
 *  1. the table still equals the limits SPEC.md documents,
 *  2. no module re-declares its own copy of the table, and
 *  3. no `src/tools/**` loop carries a bare numeric batch bound — the
 *     regression that made this issue, since a literal there is exactly how
 *     two call sites for one endpoint drifted apart.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CHUNK_CAPS, capFor, chunk } from '../src/chunk.js';
import type { SpotifyClient } from '../src/client.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerDoctorTool } from '../src/tools/doctortool.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';
import { modifyLibrary } from '../src/tools/exhaust2_misc.js';
import { registerSwarm3MetaTools } from '../src/tools/swarm3_meta.js';
import { initConfig } from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
const TOOLS_DIR = join(ROOT, 'src', 'tools');

initConfig({ SPOTIFY_MCP_SEARCH_HISTORY_FILE: '/tmp/smcp-chunk-caps-test-history.json' });

/**
 * Every `for (...; ...; x += <literal>)` header and every `slice(x, x + <n>)`
 * whose bound is a bare number above 1, reported as `file:line`. A real batch
 * bound is a `capFor(...)` call or a named constant, never a literal; the only
 * literals allowed are ones the line marks `cap-exempt` with a stated reason
 * (a page size, a client-side fan-out width — neither is a request batch cap).
 */
function literalBatchBounds(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  source.split('\n').forEach((text, index) => {
    if (text.includes('cap-exempt:')) return;
    const loopStep = /for\s*\([^;]*;[^;]*;\s*\w+\s*\+=\s*(\d+)\s*\)/.exec(text);
    const sliceEnd = /slice\(\s*\w+\s*,\s*\w+\s*\+\s*(\d+)\s*\)/.exec(text);
    for (const hit of [loopStep, sliceEnd]) {
      if (hit && Number(hit[1]) > 1) out.push({ line: index + 1, text: text.trim() });
    }
  });
  return out;
}

function toolModuleSources(): Array<{ file: string; source: string }> {
  return readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ file: name, source: readFileSync(join(TOOLS_DIR, name), 'utf8') }));
}

/** Minimal client that records the requests a batched write actually issues. */
function recordingClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const record = (method: string) => async (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return null;
  };
  return {
    calls,
    client: {
      get: async () => null,
      getAllPages: async () => [],
      put: record('put'),
      post: record('post'),
      delete: record('delete'),
      ...overrides,
    } as unknown as SpotifyClient,
  };
}

function handlerFor(register: (server: never, client: never) => void, client: unknown, name: string) {
  let captured: ((args: unknown) => Promise<unknown>) | undefined;
  const server = {
    tool(toolName: string, _desc: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) {
      if (toolName === name) captured = handler;
    },
    registerTool(toolName: string, _config: unknown, handler: (args: unknown) => Promise<unknown>) {
      if (toolName === name) captured = handler;
    },
  };
  register(server as never, client as never);
  assert.ok(captured, `${name} was not registered`);
  return captured;
}

/** The `uris`/`ids` array of a recorded write body, narrowed rather than assumed. */
function batchUris(body: unknown, key = 'uris'): string[] {
  assert.ok(body !== null && typeof body === 'object' && key in body, `recorded body must carry ${key}: ${JSON.stringify(body)}`);
  const value = (body as Record<string, unknown>)[key];
  assert.ok(Array.isArray(value), `${key} must be an array: ${JSON.stringify(body)}`);
  return value.filter((u): u is string => typeof u === 'string');
}

describe('#583 — CHUNK_CAPS is the single batch-size policy', () => {
  it('matches the per-request limits SPEC.md documents for the get_several_* family', () => {
    const rows = [...SPEC.matchAll(/\|\s*`get_several_(\w+)`\s*\|\s*`GET \/\w+\?ids=…`\s*\|\s*(\d+)\s*\|/g)];
    assert.equal(rows.length, 7, 'SPEC.md must still tabulate all seven get_several_* caps');
    const documented = Object.fromEntries(rows.map(([, kind, cap]) => [kind, Number(cap)]));
    assert.deepEqual(
      {
        tracks: CHUNK_CAPS.tracks,
        albums: CHUNK_CAPS.albums,
        artists: CHUNK_CAPS.artists,
        episodes: CHUNK_CAPS.episodes,
        shows: CHUNK_CAPS.shows,
        audiobooks: CHUNK_CAPS.audiobooks,
        chapters: CHUNK_CAPS.chapters,
      },
      documented,
    );
  });

  it('matches the limits SPEC.md documents for library writes and playlist item writes', () => {
    const libraryWrite = /required, max (\d+) — track, album, episode, show, audiobook/.exec(SPEC);
    assert.ok(libraryWrite, 'SPEC.md must still state the /me/library write cap');
    assert.equal(CHUNK_CAPS.library_writes, Number(libraryWrite[1]));

    const playlistWrite = /Track or episode URIs, max (\d+) per call/.exec(SPEC);
    assert.ok(playlistWrite, 'SPEC.md must still state the playlist item write cap');
    assert.equal(CHUNK_CAPS.playlist_writes, Number(playlistWrite[1]));
  });

  it('caps GET /me/library/contains reads separately from library writes', () => {
    // The read endpoint takes 50 and the write takes 40; conflating them is the
    // drift #624 found, so the two keys must stay distinct values.
    assert.equal(CHUNK_CAPS.library_reads, 50);
    assert.equal(CHUNK_CAPS.library_writes, 40);
    assert.notEqual(CHUNK_CAPS.library_reads, CHUNK_CAPS.library_writes);
  });

  it('capFor resolves every declared kind to the table value', () => {
    for (const kind of Object.keys(CHUNK_CAPS) as Array<keyof typeof CHUNK_CAPS>) {
      assert.equal(capFor(kind), CHUNK_CAPS[kind], `capFor('${kind}') must be the table value`);
    }
  });

  it('chunk splits into ceil(n / cap) full batches and keeps the order and every item', () => {
    const items = Array.from({ length: 120 }, (_, i) => `spotify:track:t${i}`);
    const batches = chunk(items, 'tracks');
    assert.deepEqual(batches.map((b) => b.length), [50, 50, 20]);
    assert.deepEqual(batches.flat(), items);
    assert.deepEqual(chunk([], 'tracks'), []);
    assert.deepEqual(chunk(items.slice(0, 50), 'tracks'), [items.slice(0, 50)]);
  });

  it('no src/tools module carries a bare numeric batch bound', () => {
    const offenders: string[] = [];
    for (const { file, source } of toolModuleSources()) {
      for (const hit of literalBatchBounds(source)) offenders.push(`${file}:${hit.line} ${hit.text}`);
    }
    assert.deepEqual(offenders, [], 'these loops batch by literal; take the bound from capFor(kind)');
  });

  it('the literal-batch rule rejects a newly added `i += 100` loop', () => {
    // Negative control: the rule above must be able to fail, or the guard that
    // uses it proves nothing.
    const planted = [
      'async function saveAll(client, uris) {',
      '  for (let i = 0; i < uris.length; i += 100) {',
      '    await client.put(`/me/tracks`, { ids: uris.slice(i, i + 100) });',
      '  }',
      '}',
    ].join('\n');
    const found = literalBatchBounds(planted);
    assert.equal(found.length, 2, 'the loop step and its slice end are both literal bounds');
    assert.ok(found.every((hit) => hit.line === 2 || hit.line === 3));
  });

  it('the literal-batch rule accepts a cap-sourced loop and a marked exemption', () => {
    const sourced = [
      "const writeCap = capFor('playlist_writes');",
      'for (let start = 0; start < uris.length; start += writeCap) {',
      '  await client.post(path, { uris: uris.slice(start, start + writeCap) });',
      '}',
      'for (let offset = 0; offset < cap; offset += 50) { // cap-exempt: page size',
    ].join('\n');
    assert.deepEqual(literalBatchBounds(sourced), []);
  });

  it('CHUNK_CAPS is consumed across the tool surface, not declared once', () => {
    const consumers = toolModuleSources()
      .filter(({ source }) => /\bcapFor\(|CHUNK_CAPS\./.test(source))
      .map(({ file }) => file);
    assert.ok(
      consumers.length >= 20,
      `expected the caps to be wired into the batch loops, found only ${consumers.length}: ${consumers.join(', ')}`,
    );
    for (const file of consumers) {
      assert.match(readFileSync(join(TOOLS_DIR, file), 'utf8'), /from '\.\.\/chunk\.js'/, `${file} must import from chunk.ts`);
    }
  });

  it('the shaping and catalog modules no longer declare their own copy of the table', () => {
    assert.doesNotMatch(
      readFileSync(join(ROOT, 'src', 'shaping.ts'), 'utf8'),
      /export const CHUNK_CAPS/,
      'CHUNK_CAPS lives in chunk.ts; shaping.ts may only consume it',
    );
    assert.doesNotMatch(
      readFileSync(join(TOOLS_DIR, 'catalog.ts'), 'utf8'),
      /const SEVERAL_LIMITS/,
      'the get_several_* caps must come from chunk.ts, not a second local table',
    );
  });

  it('every declared cap kind is read by at least one call site', () => {
    const catalog = readFileSync(join(TOOLS_DIR, 'catalog.ts'), 'utf8');
    // The get_several_* family resolves its seven caps generically: the kind is
    // a compile-time union that is handed to chunk()/capFor(), so those keys are
    // read without ever being named. The union is the contract, so it is parsed
    // here rather than assumed.
    const union = /type SeveralKind = Extract<ChunkCapKind, ([^>]+)>/.exec(catalog);
    assert.ok(union, 'catalog.ts must derive SeveralKind from ChunkCapKind');
    const generic = new Set(
      union[1].split('|').map((k) => k.trim().replace(/^'|'$/g, '')),
    );
    assert.match(catalog, /chunk\(ids, kind\)/, 'the several-chunk loop must go through the shared helper');

    const sources = [
      ...toolModuleSources().map(({ source }) => source),
      readFileSync(join(ROOT, 'src', 'shaping.ts'), 'utf8'),
    ].join('\n');
    const unused = (Object.keys(CHUNK_CAPS) as Array<keyof typeof CHUNK_CAPS>)
      .filter((kind) => !generic.has(kind) && !new RegExp(`capFor\\('${kind}'\\)|CHUNK_CAPS\\.${kind}\\b`).test(sources));
    assert.deepEqual(unused, [], 'a cap nobody reads is a second policy statement waiting to drift');
  });
});

describe('#583 — request counts per operation are unchanged', () => {
  it('a 120-track playlist_to_library still issues 3 PUT /me/tracks of 50/50/20', async () => {
    const { client, calls } = recordingClient({
      getAllPages: async () => Array.from({ length: 120 }, (_, i) => ({ item: { uri: `spotify:track:t${i}`, name: `T${i}` } })),
      get: async () => new Array(120).fill(false),
    });
    const handler = handlerFor(registerExhaustMiscTools as never, client, 'playlist_to_library');
    await handler({ playlist_id: 'pl1', response_format: 'concise', dry_run: false });

    const saves = calls.filter((c) => c.method === 'put' && c.path === '/me/tracks');
    assert.equal(saves.length, 3, 'a 120-track save is 3 batched writes, not 120');
    assert.deepEqual(saves.map((c) => batchUris(c.body, 'ids').length), [50, 50, 20]);
    const written = saves.flatMap((c) => batchUris(c.body, 'ids'));
    assert.equal(new Set(written).size, 120, 'every track lands exactly once across the batches');
  });

  it('a 120-uri library save still issues 3 PUT /me/library of 40/40/40', async () => {
    const { client, calls } = recordingClient();
    const uris = Array.from({ length: 120 }, (_, i) => `spotify:track:t${i}`);
    const saved = await modifyLibrary(client, uris, 'save');

    assert.equal(saved, 120, 'the reported count is what the API acknowledged, not what was sent');
    const puts = calls.filter((c) => c.method === 'put');
    assert.equal(puts.length, 3);
    for (const put of puts) {
      const encoded = put.path.split('uris=')[1] ?? '';
      assert.equal(decodeURIComponent(encoded).split(',').length, 40, 'a /me/library write carries 40 uris');
    }
  });

  it('a 100-uri library removal still issues 3 DELETE /me/library, not 2', async () => {
    const { client, calls } = recordingClient();
    const uris = Array.from({ length: 100 }, (_, i) => `spotify:track:t${i}`);
    await modifyLibrary(client, uris, 'remove');

    const deletes = calls.filter((c) => c.method === 'delete');
    assert.equal(deletes.length, 3, 'the write cap is 40, so 100 uris is 40+40+20');
    const sizes = deletes.map((d) => decodeURIComponent(d.path.split('uris=')[1] ?? '').split(',').length);
    assert.deepEqual(sizes, [40, 40, 20]);
  });

  it('the get_several_* chunking still splits 120 track ids into 50/50/20 requests', async () => {
    const { client, calls } = recordingClient({
      get: async (path: string, params?: Record<string, string>) => {
        calls.push({ method: 'get', path, body: params });
        return { tracks: (params?.ids ?? '').split(',').map((id) => ({ id })) };
      },
    });
    const handler = handlerFor(registerCatalogTools as never, client, 'get_several_tracks');
    const res = (await handler({
      ids: Array.from({ length: 120 }, (_, i) => `t${i}`),
      response_format: 'json',
    })) as { structuredContent?: { items?: unknown[] } };

    const batches = calls.filter((c) => c.path === '/tracks');
    assert.deepEqual(
      batches.map((b) => (b.body as Record<string, string>).ids.split(',').length),
      [50, 50, 20],
    );
    assert.equal(res.structuredContent?.items?.length, 120, 'every id survives the merge in order');
  });
});

describe('#583 — the operator surface prints the resolved caps', () => {
  it('spotify_doctor reports the batch caps on its config row', async () => {
    const server = new McpServer({ name: 'caps-doctor', version: '0.0.0' });
    registerDoctorTool(server, recordingClient().client);
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, never>) => Promise<{ content: Array<{ text: string }>; structuredContent: { rows?: Array<{ id: string; summary: string }> } }> }> })._registeredTools.spotify_doctor;
    const report = await tool.handler({ response_format: 'json' });
    const config = report.structuredContent.rows?.find((row) => row.id === 'config');
    assert.ok(config, 'the doctor report must carry a config row');
    assert.match(config.summary, /batch_caps=tracks:50,/);
    assert.match(config.summary, new RegExp(`library_writes:${CHUNK_CAPS.library_writes}`));
    assert.match(config.summary, new RegExp(`playlist_writes:${CHUNK_CAPS.playlist_writes}`));
  });

  it('toolset_report lists every cap and echoes the table as structured data', async () => {
    const server = new McpServer({ name: 'caps', version: '0.0.0' });
    registerSwarm3MetaTools(server);
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (a: Record<string, never>) => Promise<{ content: Array<{ text: string }>; structuredContent: { batch_caps: unknown } }> }> })._registeredTools.toolset_report;
    const result = await tool.handler({});
    assert.deepEqual(result.structuredContent.batch_caps, CHUNK_CAPS);
    assert.match(result.content[0].text, /Batch caps \(per request\):/);
    assert.match(result.content[0].text, new RegExp(`playlist_writes: ${CHUNK_CAPS.playlist_writes} per request`));
  });
});
