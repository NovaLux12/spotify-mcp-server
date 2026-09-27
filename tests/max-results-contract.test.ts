/**
 * `max_results` means ONE thing: how many rows to RENDER (#886).
 *
 * The defect this file exists for is not a wrong number in a tool; it is one
 * parameter name carrying two different jobs. Everywhere else `max_results` is
 * a display cap applied to a result set the tool has already produced. Four
 * tools used it as something else, and two of them wrote the capped result to
 * a durable file. A caller's reflex to shrink a response is to lower
 * `max_results`, so under the old names that reflex silently truncated a
 * snapshot or a backup on disk while the response looked completely normal.
 *
 * Grouped as:
 *   1. walk invariance — the `fetch_all` cases, where nothing in the response
 *      distinguished a capped walk from a complete one, and the rendered
 *      "total" was really the walked count;
 *   2. the renamed walk caps — `item_cap` / `walk_cap` own the walk, and
 *      lowering `max_results` no longer reaches either tool at all;
 *   3. the guard — no walk anywhere in `src/tools/` may take its cap from
 *      `max_results`, which is the check that stops the class from recurring.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { SpotifyClient } from '../src/client.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerSwarm3SnapshotsTools } from '../src/tools/swarm3_snapshots.js';
import { registerBackupTools } from '../src/tools/backup.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { installToolErrorBoundary } from '../src/tools/annotations.js';
import {
  RETIRED_PLAYLIST_INPUTS_REMOVED_IN,
  RETIRED_WALK_CAP_INPUTS,
  RETIRED_WALK_CAP_INPUTS_REMOVED_IN,
} from '../src/shaping.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type RegisteredTool = {
  name: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};
type Call = { path: string; params?: Record<string, string> };

// ---------------------------------------------------------------- harness

/** A paged album source: `total` items served `limit` at a time by offset. */
function pagedAlbums(total: number, limit = 10) {
  return (_path: string, params?: Record<string, string>) => {
    const off = Number(params?.offset ?? 0);
    const lim = Number(params?.limit ?? limit);
    const end = Math.min(total, off + lim);
    const items = [];
    for (let i = off; i < end; i += 1) {
      items.push({
        id: `alb${i}`,
        name: `Album ${i}`,
        uri: `spotify:album:alb${i}`,
        album_type: 'album',
        release_date: '2026-01-01',
        total_tracks: 3,
        artists: [{ id: 'art1', name: 'Queen' }],
      });
    }
    return { items, total, offset: off, limit: lim, next: end < total ? end : null };
  };
}

function pagedTracks(total: number) {
  return (_path: string, params?: Record<string, string>) => {
    const off = Number(params?.offset ?? 0);
    const lim = Number(params?.limit ?? 20);
    const end = Math.min(total, off + lim);
    const items = [];
    for (let i = off; i < end; i += 1) {
      items.push({
        id: `trk${i}`,
        name: `Track ${i}`,
        uri: `spotify:track:trk${i}`,
        track_number: i + 1,
        duration_ms: 200000,
        artists: [{ id: 'art1', name: 'Queen' }],
      });
    }
    return { items, total, offset: off, limit: lim, next: end < total ? end : null };
  };
}

/**
 * Mirrors `SpotifyClient.getAllPagesWithTruncation` — same cap semantics, same
 * `truncated` / `reportedTotal` verdicts, and the page reads go through the
 * SAME reader the tool's own requests use, so a request count taken from
 * `calls` sees them. A double whose two walk methods disagree would let a
 * handler pass on one path and fail on the other.
 */
function walkDouble(
  get: (p: string, q?: Record<string, string>) => Promise<unknown>,
  fetchAllCap = 500,
) {
  async function walk<T>(
    path: string,
    params?: Record<string, string>,
    o?: { maxItems?: number },
  ): Promise<{ items: T[]; truncated: boolean; reportedTotal: number | null }> {
    const maxItems = o?.maxItems ?? fetchAllCap;
    const all: T[] = [];
    let offset = 0;
    let lastTotal: number | null = null;
    for (;;) {
      const page = await get(path, { ...params, offset: String(offset) }) as
        | { items?: T[]; total?: number; limit?: number } | null;
      if (!page || !Array.isArray(page.items)) break;
      if (typeof page.total === 'number') lastTotal = page.total;
      all.push(...page.items);
      if (all.length >= maxItems) {
        return { items: all.slice(0, maxItems), truncated: true, reportedTotal: lastTotal };
      }
      const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
      offset += limit;
      if (page.items.length === 0 || page.items.length < limit) break;
      if (typeof page.total === 'number' && offset >= page.total) break;
    }
    return {
      items: all,
      truncated: lastTotal !== null && all.length < lastTotal,
      reportedTotal: lastTotal,
    };
  }
  return {
    getAllPagesWithTruncation: walk,
    getAllPages: async <T,>(p: string, q?: Record<string, string>, o?: { maxItems?: number }) =>
      (await walk<T>(p, q, o)).items,
  };
}

function makeHarness(
  register: (s: never, c: never) => void,
  respond?: (path: string, params?: Record<string, string>) => unknown,
  fetchAllCap = 500,
) {
  const calls: Call[] = [];
  const get = async (path: string, params?: Record<string, string>) => {
    calls.push(params === undefined ? { path } : { path, params });
    return respond ? respond(path, params) : null;
  };
  const client = {
    get,
    post: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    ...walkDouble(get, fetchAllCap),
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (name: string, _d: string, schema: RegisteredTool['schema'], handler: RegisteredTool['handler']) =>
      registered.push({ name, schema, handler }),
  };
  register(server as never, client as never);
  return { registered, calls };
}

function findTool(registered: RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

const invoke = (tool: RegisteredTool, args: Record<string, unknown> = {}) => tool.handler(args);
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');
const sc = (r: ToolResult) => r.structuredContent as Record<string, unknown>;
/** The pagination block's server-side total — Spotify's count, not a walked length. */
const pageTotal = (r: ToolResult) =>
  ((sc(r).pagination as { total?: number } | undefined) ?? {}).total;

// ------------------------------------------------- 1. the walk never moved

test('#886 get_artist_albums fetch_all: max_results does not shorten the walk, and the total is Spotify’s', async () => {
  // 1200 albums, 10 per page, fetch-all cap 500. Under the old code the walk
  // took `max_results` as its cap, so it read ONE page and then reported
  // "3 total" for an artist with 1200 albums.
  const { registered, calls } = makeHarness(registerCatalogTools, pagedAlbums(1200));
  const result = await invoke(findTool(registered, 'get_artist_albums'), {
    id: 'art1',
    fetch_all: true,
    max_results: 3,
  });

  const albumReads = calls.filter((c) => c.path === '/artists/art1/albums');
  assert.equal(albumReads.length, 50, 'max_results must not shorten the walk: 500 items at 10 per page');

  const out = sc(result);
  assert.equal(out.walked, 500, 'the walk covers the fetch-all cap, not max_results');
  assert.equal(out.truncated_by_cap, true, 'the walk stopped at the cap and says so');
  // The walked count is NOT the artist's discography. Reading `total` as 500
  // here is the lie #830 was filed about in another shape.
  assert.equal(pageTotal(result), 1200, 'the reported total is Spotify’s, not the walked count');
  assert.match(text(result), /fetch-all cap 500 reached/, 'prose discloses the cap');
  assert.match(text(result), /walked 500 of 1200/);
});

test('#886 get_album_tracks fetch_all: max_results does not shorten the walk', async () => {
  const { registered, calls } = makeHarness(registerCatalogTools, pagedTracks(1200));
  const result = await invoke(findTool(registered, 'get_album_tracks'), {
    id: 'alb1',
    fetch_all: true,
    max_results: 3,
  });

  const reads = calls.filter((c) => c.path === '/albums/alb1/tracks');
  assert.equal(reads.length, 25, 'max_results must not shorten the walk: 500 items at 20 per page');
  assert.equal(sc(result).walked, 500);
  assert.equal(pageTotal(result), 1200);
  assert.match(text(result), /walked 500 of 1200/);
});

test('#886 fetch_all renders every walked row; max_results does not re-slice it', async () => {
  // `renderList` re-slices by `maxResults`. Under fetch_all the handler
  // returns everything it walked and says so in its own prose, so re-slicing
  // would put "showing 3" beside 500 rows in the same response.
  const { registered } = makeHarness(registerCatalogTools, pagedAlbums(1200));
  const result = await invoke(findTool(registered, 'get_artist_albums'), {
    id: 'art1',
    fetch_all: true,
    max_results: 3,
  });
  const rows = (sc(result).items ?? []) as unknown[];
  assert.equal(rows.length, 500, 'the response is not re-sliced by max_results under fetch_all');
});

// ------------------------------------- 2. the walk caps have their own names

test('#886 take_playlist_snapshot bounds its walk by item_cap, and max_results is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'w886-snap-'));
  const { registered } = makeHarness(registerSwarm3SnapshotsTools, (_p, params) => {
    const off = Number(params?.offset ?? 0);
    const items = [];
    for (let i = off; i < Math.min(1000, off + 100); i += 1) {
      items.push({ added_at: '2026-01-01T00:00:00Z', item: { uri: `spotify:track:t${i}`, name: `T${i}`, type: 'track' } });
    }
    return { items, total: 1000, offset: off, limit: 100, next: off + 100 < 1000 ? off + 100 : null };
  });
  try {
    const tool = findTool(registered, 'take_playlist_snapshot');
    assert.ok('item_cap' in tool.schema, 'the walk cap is declared under its own name');
    assert.ok(!('max_results' in tool.schema), 'max_results no longer reaches a walk that writes a file');

    // Lowering the display cap must not shrink the walk. The old name is
    // simply not in the schema, so this is the "caller reaches for the wrong
    // knob" case: it cannot reach the walk at all.
    const result = await invoke(tool, { playlist: 'pl1', max_results: 3, dry_run: false });
    assert.equal(sc(result).item_walk_cap, 500, 'max_results does not become the walk cap');
    assert.equal(sc(result).track_count, 500, 'the walk still covers the fetch-all cap');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('#886 the renamed walk caps', () => {
  it('take_playlist_snapshot honours item_cap, and the dry run advertises it', async () => {
    const { registered } = makeHarness(registerSwarm3SnapshotsTools, (_p, params) => {
      const off = Number(params?.offset ?? 0);
      const items = [];
      for (let i = off; i < Math.min(1000, off + 100); i += 1) {
        items.push({ added_at: '2026-01-01T00:00:00Z', item: { uri: `spotify:track:t${i}`, name: `T${i}`, type: 'track' } });
      }
      return { items, total: 1000, offset: off, limit: 100, next: off + 100 < 1000 ? off + 100 : null };
    });
    const tool = findTool(registered, 'take_playlist_snapshot');
    const planned = await invoke(tool, { playlist: 'pl1', item_cap: 120, dry_run: true });
    assert.equal(sc(planned).item_walk_cap, 120, 'item_cap bounds the walk');
    const done = await invoke(tool, { playlist: 'pl1', item_cap: 120, dry_run: false });
    assert.equal(sc(done).item_walk_cap, 120, 'the commit walk honours the advertised cap');
    assert.equal(sc(done).track_count, 120, 'the walk stopped where item_cap said');
  });

  it('backup_library bounds its per-category walk by walk_cap, and max_results is gone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'w886-backup-'));
    const previous = process.env.SPOTIFY_MCP_BACKUP_DIR;
    process.env.SPOTIFY_MCP_BACKUP_DIR = home;
    try {
      const { registered } = makeHarness(registerBackupTools, () => ({ items: [], total: 0 }));
      const tool = findTool(registered, 'backup_library');
      assert.ok('walk_cap' in tool.schema, 'the walk cap is declared under its own name');
      assert.ok(!('max_results' in tool.schema), 'max_results no longer reaches a walk that writes a file');

      // A dry run: it walks nothing, so this reads the CAP off the payload
      // rather than counting pages. Lowering the display cap must not move it.
      const viaDisplay = await invoke(tool, { dry_run: true, max_results: 3 });
      assert.equal(sc(viaDisplay).cap, 500, 'max_results does not become the walk cap');
      const viaWalkCap = await invoke(tool, { dry_run: true, walk_cap: 7 });
      assert.equal(sc(viaWalkCap).cap, 7, 'walk_cap bounds the walk');
    } finally {
      if (previous === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
      else process.env.SPOTIFY_MCP_BACKUP_DIR = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------- 3. the guard

/**
 * The check that stops the class from recurring.
 *
 * A behavioural test covers the tools this issue found. It cannot cover the
 * next tool where somebody reaches for `max_results` as a work cap, so the
 * invariant is asserted over the SOURCE instead: no walk in `src/tools/` may
 * take its `maxItems` from `max_results`.
 *
 * This reads the real files rather than the registry, because the defect is a
 * dataflow the published schema does not show — `max_results` looks identical
 * in both the good and the bad case, and only the value handed to the walk
 * differs. A registry-level assertion would pass on the broken tree.
 */
test('#886 no walk in src/tools takes its cap from max_results', async () => {
  const toolsDir = new URL('../src/tools/', import.meta.url);
  const { readdir: list } = await import('node:fs/promises');
  const files = (await list(toolsDir)).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 40, `expected the tools directory to be populated, saw ${files.length} files`);

  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(new URL(file, toolsDir), 'utf8');
    // Every `maxItems:` a walk is given, with the expression that supplies it.
    for (const match of source.matchAll(/maxItems:\s*([^,\n}]+)/g)) {
      const value = match[1] ?? '';
      if (/\bmax_results\b/.test(value)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file}:${line}  maxItems: ${value.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'max_results is a display cap; a walk that takes its ceiling from it silently\n'
    + 'truncates durable output. Give the walk its own named cap (see walkCap in\n'
    + 'src/shaping.ts).\n  ' + offenders.join('\n  '),
  );
});

// ------------------------------------------- 4. the withdrawal, not a typo

/**
 * What a 2.x caller actually receives.
 *
 * The behavioural tests above call handlers directly, which cannot see this at
 * all: zod strips an undeclared key before a handler runs, so a direct call
 * with a retired `max_results` simply ignores it. The refusal is made at the
 * request boundary, so proving it needs a real `callTool` — the same reason
 * `tests/schema.playlist-params.test.ts` builds an in-memory client.
 *
 * The kind is the point. Left to the generic unknown-parameter path, the reply
 * is `unknown_param` / `parameter_not_accepted` and "use only parameters
 * advertised by the tool schema" — a claim the server never had `max_results`.
 * It did: 2.1.2 published it on both tools, SPEC.md documented it, and its own
 * description said it was the walk cap. A caller upgrading is following a
 * contract, not mistyping, so AGENTS §5 puts it in the `retired_input` class
 * with the playlist spellings, and the refusal has to name what to send
 * instead. Two tools retired the SAME name for DIFFERENT successors, so naming
 * the replacement is not a formality — a generic message sends the caller back
 * to the schema to work out which of `item_cap` / `walk_cap` they wanted.
 */
describe('#886 the retired walk caps are refused as retired, not as unknown', () => {
  async function boundary() {
    const calls: string[] = [];
    const client = {
      get: async (path: string) => { calls.push(path); return { items: [], total: 0 }; },
      getAllPages: async (path: string) => { calls.push(path); return []; },
    } as unknown as SpotifyClient;
    const server = new McpServer({ name: 'max-results-contract', version: '0.0.0' });
    registerSwarm3SnapshotsTools(server, client);
    registerBackupTools(server, client);
    installToolErrorBoundary(server);
    const caller = new Client({ name: 'contract-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([caller.connect(ct), server.connect(st)]);
    return {
      calls,
      invoke: async (name: string, args: Record<string, unknown>) =>
        (await caller.callTool({ name, arguments: args })) as unknown as {
          isError?: boolean;
          content: Array<{ text: string }>;
          structuredContent?: { error?: { kind?: string; reason?: string } };
        },
    };
  }

  const CASES: Array<[string, string, string]> = [
    ['take_playlist_snapshot', 'item_cap', 'playlist'],
    ['backup_library', 'walk_cap', 'notes'],
  ];

  for (const [tool, canonical, extraKey] of CASES) {
    it(`${tool} refuses a retired max_results by naming ${canonical}`, async () => {
      const h = await boundary();
      const args: Record<string, unknown> = { max_results: 5 };
      if (extraKey === 'playlist') args.playlist = '4uLU6hMCjMI75M1A2tKUQC';
      else args.notes = 'x';
      const result = await h.invoke(tool, args);
      const message = result.content.map((c) => c.text).join(' ');

      assert.equal(result.isError, true, `${tool} accepted a retired max_results`);
      assert.ok(message.includes('max_results'), `refusal did not name what was sent: ${message}`);
      assert.ok(message.includes(canonical), `refusal did not name ${canonical}: ${message}`);
      // The literal, not a regex built from the constant the message is built
      // from: a string a caller greps for must not be derived from its own
      // source, or it cannot fail however the release is re-dated.
      assert.match(message, /removed as a walk cap in v3\.0/, `refusal did not state the release: ${message}`);
      assert.equal(
        result.structuredContent?.error?.kind,
        'validation',
        `${tool} refusal was not a typed validation error`,
      );
      assert.equal(
        result.structuredContent?.error?.reason,
        'retired_input',
        `${tool} refusal fell through to the unknown-parameter path`,
      );
      assert.deepEqual(h.calls, [], `${tool} reached Spotify before refusing a retired input`);
    });
  }

  it('never claims the server never had the name', async () => {
    const h = await boundary();
    const result = await h.invoke('take_playlist_snapshot', {
      playlist: '4uLU6hMCjMI75M1A2tKUQC',
      max_results: 5,
    });
    const message = result.content.map((c) => c.text).join(' ');
    assert.doesNotMatch(
      message,
      /does not accept parameter|only parameters advertised/,
      'the generic unknown-parameter text asserts the server never had max_results, which is false',
    );
  });

  it('leaves a call that omits it entirely alone', async () => {
    const h = await boundary();
    const result = await h.invoke('take_playlist_snapshot', {
      playlist: '4uLU6hMCjMI75M1A2tKUQC',
      dry_run: true,
    });
    assert.notEqual(result.structuredContent?.error?.reason, 'retired_input', 'a clean call was refused');
  });

  it('promises one removal release across both retirement tables', () => {
    // Two named constants so neither table has to lie about what it governs,
    // and one asserted value so they cannot drift into two different promises.
    assert.equal(RETIRED_WALK_CAP_INPUTS_REMOVED_IN, RETIRED_PLAYLIST_INPUTS_REMOVED_IN);
  });

  it('records a distinct successor per tool, not one shared name', () => {
    const canonicals = new Set(Object.values(RETIRED_WALK_CAP_INPUTS).map((r) => r.canonical));
    assert.equal(canonicals.size, Object.keys(RETIRED_WALK_CAP_INPUTS).length);
  });
});
