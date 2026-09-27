/**
 * #898 — `fetchPlaylistUris` honours SPOTIFY_MCP_FETCH_ALL_CAP, asks for URIs
 * only, and DISCLOSES a capped walk.
 *
 * These run the slice against the REAL `SpotifyClient` over a stubbed fetch,
 * not the route-table fake in tools.exhaust2extra.test.ts. The bug this covers
 * is a walk that stops early and hands callers a short list they read as the
 * whole playlist, so the walk loop, the cap and the truncation verdict are
 * exactly the things a hand-rolled fake would be asserting against itself.
 *
 * The facts pinned here:
 *   1. the cap is getConfig().fetchAllCap, not a hard-coded 10,000 (20x the
 *      default) — a two-ref expression over big playlists is a few GETs, not 200;
 *   2. item pages request `items(item(uri))`, never a nested track object;
 *   3. a walk that stops at the cap says so, with total and returned, in BOTH
 *      the dry-run payload and the one that follows a write.
 *
 * Every playlist here is bigger than one page. A single-page fixture cannot
 * produce a truncation at all, so a suite made only of them would pass against
 * the pre-fix code untouched.
 *
 * Run with: node --import tsx --test tests/exhaust2extra-fetchcap.test.ts
 *
 * NOTE: the token path is resolved per call by getTokenFilePath(), so the env
 * vars MUST be set before the dynamic imports below.
 */

import './helpers/hermetic.js';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tokenDir = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-fetchcap-test-'));
const tokenFile = path.join(tokenDir, 'tokens.json');
process.env.SPOTIFY_MCP_TOKEN_FILE = tokenFile;
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';

const { SpotifyClient } = await import('../src/client.ts');
const { initConfig } = await import('../src/config.ts');
const { registerExhaust2ExtraTools } = await import('../src/tools/exhaust2_extra.ts');

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; handler: (a: Record<string, unknown>) => Promise<ToolContent> };

// ---------------------------------------------------------------------------
// Spotify stand-in
// ---------------------------------------------------------------------------

interface Playlist {
  name: string;
  uris: string[];
  /** Omit `total` from item pages, to prove the field filter is load-bearing. */
  hideItemTotal?: boolean;
  /** Omit the count from the playlist object too — nothing states a length. */
  hideMetaTotal?: boolean;
}

let recorded: Array<{ url: string; method: string }> = [];
let playlists: Record<string, Playlist> = {};
/** What `POST /me/playlists` created and what has since been written to it. */
let created: { id: string; uris: string[] } | null = null;
/** Uris the search stub offers; kept outside the playlists so they are unseen. */
let searchUris: string[] = [];

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PAGE_SIZE = 100;

/** One item page as a `fields=items(item(uri)),total,limit` page renders it. */
function itemPage(uris: string[], offset: number, pl: Playlist) {
  return json({
    items: uris.slice(offset, offset + PAGE_SIZE).map((uri) => ({ item: { uri } })),
    limit: PAGE_SIZE,
    offset,
    ...(pl.hideItemTotal ? {} : { total: uris.length }),
    ...(offset + PAGE_SIZE < uris.length ? { next: `https://api.spotify.com/v1/playlists/x/items?offset=${offset + PAGE_SIZE}` } : {}),
  });
}

function responder(rawUrl: string, init: RequestInit): Response {
  const url = new URL(rawUrl);
  const method = String(init.method ?? 'GET').toUpperCase();
  const pathname = url.pathname.replace(/^\/v1/, '');
  recorded.push({ url: rawUrl, method });

  const segments = pathname.split('/').filter(Boolean);
  if (method === 'GET' && segments[0] === 'playlists' && segments.length === 2) {
    const pl = playlists[segments[1]!];
    if (!pl) return json({ error: { status: 404, message: 'Not found' } }, 404);
    return json({ id: segments[1], name: pl.name, ...(pl.hideMetaTotal ? {} : { items: { total: pl.uris.length } }) });
  }

  if (method === 'GET' && segments[0] === 'playlists' && segments.length === 3 && segments[2] === 'items') {
    const id = segments[1]!;
    const pl = id === created?.id ? { name: 'Created', uris: created.uris } : playlists[id];
    if (!pl) return json({ error: { status: 404, message: 'Not found' } }, 404);
    return itemPage(pl.uris, Number(url.searchParams.get('offset') ?? 0), pl);
  }

  if (method === 'POST' && pathname === '/me/playlists') {
    created = { id: 'created-1', uris: [] };
    return json({ id: 'created-1', name: 'Created' }, 201);
  }

  if (method === 'POST' && segments[0] === 'playlists' && segments[2] === 'items') {
    const body = JSON.parse(String(init.body ?? '{}')) as { uris?: string[] };
    if (created && segments[1] === created.id) created.uris.push(...(body.uris ?? []));
    return json({ snapshot_id: 'snap-1' }, 201);
  }

  if (method === 'GET' && pathname === '/search') {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return json({ tracks: { items: searchUris.slice(offset, offset + 10).map((uri) => ({ uri })), total: searchUris.length, offset, limit: 10 } });
  }

  return json({ error: { status: 404, message: `unrouted ${method} ${pathname}` } }, 404);
}

async function seedTokens(): Promise<void> {
  await writeFile(
    tokenFile,
    JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
    'utf8',
  );
}

function makeServer(registered: RegisteredTool[]): unknown {
  return {
    tool: (name: string, description: string, _schema: unknown, handler: RegisteredTool['handler']) =>
      registered.push({ name, description, handler }),
  };
}

function register(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerExhaust2ExtraTools(makeServer(registered), new SpotifyClient());
  return registered;
}

function handlerFor(registered: RegisteredTool[], name: string): RegisteredTool['handler'] {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool!.handler;
}

function descriptionOf(registered: RegisteredTool[], name: string): string {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool!.description;
}

function text(r: ToolContent): string {
  return r.content.map((c) => c.text).join('\n');
}

/** Item-page GETs one ref cost. The tool's quota claim is about these. */
function itemPageRequests(ref: string): Array<{ url: string; method: string }> {
  return recorded.filter((r) => r.method === 'GET' && r.url.includes(`/playlists/${ref}/items`));
}

/** Run `fn` with the process-wide config rebound, then restore it. */
async function withConfig<T>(cap: string, fn: () => Promise<T>): Promise<T> {
  initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: cap });
  try {
    return await fn();
  } finally {
    initConfig();
  }
}

function urisFor(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `spotify:track:${prefix}${i + 1}`);
}

beforeEach(async () => {
  await rm(tokenFile, { force: true });
  await seedTokens();
  recorded = [];
  playlists = {};
  searchUris = [];
  created = null;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => responder(String(url), init)) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  initConfig();
});

// ---------------------------------------------------------------------------
// the cap
// ---------------------------------------------------------------------------

test('algebra reads one item page per ref when SPOTIFY_MCP_FETCH_ALL_CAP=100', async () => {
  playlists = {
    aaa: { name: 'A', uris: urisFor('a', 250) },
    bbb: { name: 'B', uris: urisFor('b', 250) },
  };
  const registered = register();

  await withConfig('100', async () => {
    const r = await handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa ∪ bbb', target_name: 'Union' });
    assert.equal((r.structuredContent as Record<string, unknown>).dry_run, true);
  });

  // 100 rows is exactly one 100-row page, so one page per ref answers it. The
  // pre-fix walk asked for maxItems: 10_000 and would have spent three per ref
  // here — and a hundred per ref on the 10k-item playlists the issue names.
  assert.equal(itemPageRequests('aaa').length, 1);
  assert.equal(itemPageRequests('bbb').length, 1);
  assert.equal(created, null, 'a dry run must not create anything');
});

test('a cap between page boundaries stops mid-walk', async () => {
  playlists = { aaa: { name: 'A', uris: urisFor('a', 250) } };
  const registered = register();

  await withConfig('200', async () => {
    await handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa', target_name: 'Copy' });
  });

  // 200 rows at 100 per page is two requests, 50 rows short of the 250 there.
  assert.equal(itemPageRequests('aaa').length, 2);
});

test('a cap no higher than the playlist walks every page and claims no truncation', async () => {
  playlists = { aaa: { name: 'A', uris: urisFor('a', 250) } };
  const registered = register();

  const r = await withConfig('500', () =>
    handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa', target_name: 'Copy' }));
  const p = r.structuredContent as Record<string, unknown>;

  assert.equal(itemPageRequests('aaa').length, 3);
  assert.equal(p.truncated, false);
  assert.equal(p.returned, 250);
  assert.equal(p.total, 250);
});

test('a cap that lands exactly on the reported total is not a truncation', async () => {
  playlists = { aaa: { name: 'A', uris: urisFor('a', 200) } };
  const registered = register();

  const r = await withConfig('200', () =>
    handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa', target_name: 'Copy' }));
  const p = r.structuredContent as Record<string, unknown>;

  assert.equal(itemPageRequests('aaa').length, 2);
  assert.equal(p.truncated, false, '200 rows read, 200 rows reported — nothing is missing');
  assert.equal(p.returned, 200);
  // truncated_by_cap is NOT the same question as truncated, and collapsing
  // them would report a complete playlist as clipped: the cap is what ENDED
  // the walk here, but it cut nothing off. A caller that reads the cap flag
  // alone as "rows are missing" is wrong on this exact boundary.
  const scan = (p.ref_scans as Array<Record<string, unknown>>)[0]!;
  assert.equal(scan.truncated_by_cap, true, 'the cap ended the walk at exactly the total');
  assert.equal(scan.truncated, false, 'and it cut nothing off');
});

// ---------------------------------------------------------------------------
// URI-only projection
// ---------------------------------------------------------------------------

test('algebra item pages request item(uri) only — no nested track object', async () => {
  playlists = { aaa: { name: 'A', uris: urisFor('a', 250) } };
  const registered = register();

  await withConfig('500', () =>
    handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa', target_name: 'Copy' }));

  const pages = itemPageRequests('aaa');
  assert.equal(pages.length, 3, 'a 250-row playlist at cap 500 walks every page');
  for (const call of pages) {
    // Asserted on the raw request URL, where the filter is percent-encoded.
    assert.match(call.url, /fields=items%28item%28uri%29%29%2Ctotal%2Climit/);
    const fields = new URL(call.url).searchParams.get('fields') ?? '';
    assert.deepEqual(fields.split(',').sort(), ['items(item(uri))', 'limit', 'total']);
    // The pre-fix walk sent no `fields` at all, so every row carried a whole
    // TrackObject — name, artists, album, images — for a URI list.
    for (const trackField of ['name', 'album', 'artists', 'images', 'track(', 'added_by', 'added_at']) {
      assert.ok(!fields.includes(trackField), `item(uri) projection must not ask for ${trackField}: ${fields}`);
    }
  }
});

test('a page that omits total still yields the real length and a truncation verdict', async () => {
  // `total` is in the filter for a reason: the walk reads it to tell a short
  // page that was the end from one that was not. Strip it and the length must
  // come from the playlist object, and the verdict must still fire.
  playlists = { aaa: { name: 'A', uris: urisFor('a', 250), hideItemTotal: true } };
  const registered = register();

  const r = await withConfig('100', () =>
    handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa', target_name: 'Copy' }));
  const p = r.structuredContent as Record<string, unknown>;

  assert.equal(p.truncated, true);
  assert.equal(p.returned, 100);
  assert.equal((p.ref_scans as Array<Record<string, unknown>>)[0]?.total, 250);
});

test('a playlist that states no length anywhere reports total null, not a guess', async () => {
  playlists = { aaa: { name: 'A', uris: urisFor('a', 3), hideItemTotal: true, hideMetaTotal: true } };
  const registered = register();

  const r = await withConfig('500', () =>
    handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa', target_name: 'Copy' }));
  const p = r.structuredContent as Record<string, unknown>;

  // 0 would read as "an empty playlist" and 3 as "this is all of it"; neither
  // was read anywhere, so the honest value is null.
  assert.equal(p.total, null);
  assert.equal(p.returned, 3);
  assert.equal((p.ref_scans as Array<Record<string, unknown>>)[0]?.total, null);
});

// ---------------------------------------------------------------------------
// the disclosure
// ---------------------------------------------------------------------------

test('a capped ref walk is reported with truncated, total and returned', async () => {
  playlists = {
    aaa: { name: 'A', uris: urisFor('a', 250) },
    bbb: { name: 'B', uris: urisFor('b', 250) },
  };
  const registered = register();

  const r = await withConfig('100', () =>
    handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa ∪ bbb', target_name: 'Union' }));
  const p = r.structuredContent as Record<string, unknown>;

  assert.equal(p.truncated, true);
  assert.equal(p.total, 500, 'the two refs really hold 500 items between them');
  assert.equal(p.returned, 200, 'only the first 100 of each ref were read');
  assert.deepEqual(p.truncated_refs, ['aaa', 'bbb']);
  assert.equal(p.scan_cap, 100);
  assert.deepEqual(p.ref_scans, [
    { ref: 'aaa', returned: 100, total: 250, truncated: true, truncated_by_cap: true, scan_cap: 100 },
    { ref: 'bbb', returned: 100, total: 250, truncated: true, truncated_by_cap: true, scan_cap: 100 },
  ]);
  // Prose too: a payload field nobody reads is not a disclosure.
  assert.match(text(r), /TRUNCATED/);
  assert.match(text(r), /aaa \(100 of 250 item\(s\)/);
  assert.match(text(r), /partial read/);
});

test('the WRITE result of a capped expression says it is incomplete', async () => {
  playlists = {
    aaa: { name: 'A', uris: urisFor('a', 250) },
    bbb: { name: 'B', uris: urisFor('b', 250) },
  };
  const registered = register();

  const r = await withConfig('100', () =>
    handlerFor(registered, 'playlist_expression_algebra')({
      expression: 'aaa ∪ bbb', target_name: 'Union', dry_run: false,
    }));
  const p = r.structuredContent as Record<string, unknown>;

  // The write happened, and it wrote 200 of a 500-item expression. That gap is
  // what the payload must carry — a silent short list is not a fix.
  assert.equal(p.dry_run, false);
  assert.equal(p.result_count, 200);
  assert.equal(p.truncated, true);
  assert.equal(p.total, 500);
  assert.equal(p.returned, 200);
  assert.equal(created?.uris.length, 200);
  assert.match(text(r), /INCOMPLETE/);
  assert.match(text(r), /"aaa" \(100 of 250 read\)/);
});

test('a walk that read every row reports no truncation', async () => {
  playlists = {
    aaa: { name: 'A', uris: urisFor('a', 3) },
    bbb: { name: 'B', uris: urisFor('b', 3) },
  };
  const registered = register();

  const r = await withConfig('500', () =>
    handlerFor(registered, 'playlist_expression_algebra')({ expression: 'aaa ∪ bbb', target_name: 'Union' }));
  const p = r.structuredContent as Record<string, unknown>;

  assert.equal(p.truncated, false);
  assert.equal(p.total, 6);
  assert.equal(p.returned, 6);
  assert.deepEqual(p.truncated_refs, []);
  assert.equal(p.result_count, 6);
  assert.doesNotMatch(text(r), /TRUNCATED/);
  // A verdict that fired unconditionally would pass every capped case above
  // while telling the caller every small playlist is incomplete too.
  assert.deepEqual(p.ref_scans, [
    { ref: 'aaa', returned: 3, total: 3, truncated: false, truncated_by_cap: false, scan_cap: 500 },
    { ref: 'bbb', returned: 3, total: 3, truncated: false, truncated_by_cap: false, scan_cap: 500 },
  ]);
});

// ---------------------------------------------------------------------------
// playlist_fill_from_search — the same walk, the other caller
// ---------------------------------------------------------------------------

test('fill_from_search reports a capped pre-read instead of a shortened length', async () => {
  playlists = { mix1: { name: 'Mix', uris: urisFor('m', 250) } };
  searchUris = urisFor('z', 2);
  const registered = register();

  const r = await withConfig('100', () =>
    handlerFor(registered, 'playlist_fill_from_search')({ playlist_id: 'mix1', queries: ['alpha'], target_count: 2 }));
  const p = r.structuredContent as Record<string, unknown>;

  assert.equal(p.existing_truncated, true);
  assert.equal(p.existing_truncated_by_cap, true);
  assert.equal(p.existing_scanned, 100);
  assert.equal(p.existing_total, 250);
  assert.equal(p.scan_cap, 100);
  // The plan used to print the walked count as the playlist's length. Under a
  // 10,000 cap that was nearly always true; under a lowered one it becomes a
  // claim about a 250-item playlist that no call made.
  assert.match(text(r), /playlist has 250 item\(s\)/);
  assert.match(text(r), /TRUNCATED/);
  assert.doesNotMatch(text(r), /playlist has 100 item\(s\)/);
});

test('fill_from_search will not state a resulting length off a capped pre-read', async () => {
  playlists = { mix1: { name: 'Mix', uris: urisFor('m', 250) } };
  // Both candidates sit outside the playlist entirely, so the "already
  // present" set built from the capped read cannot see them and one is picked.
  searchUris = ['spotify:track:new1', 'spotify:track:new2'];
  const registered = register();

  const r = await withConfig('100', () =>
    handlerFor(registered, 'playlist_fill_from_search')({
      playlist_id: 'mix1', queries: ['alpha'], target_count: 1, dry_run: false,
    }));
  const p = r.structuredContent as Record<string, unknown>;

  assert.equal(p.existing_truncated, true);
  // 100 + 1 would be arithmetic over a read missing 150 rows. `null` is the
  // only value here nobody would have to take on trust.
  assert.equal(p.now_total, null);
  assert.match(text(r), /Resulting length unknown/);
  assert.match(text(r), /may already have been in the playlist/);
});

test('fill_from_search states a resulting length when the pre-read was whole', async () => {
  playlists = { mix1: { name: 'Mix', uris: urisFor('m', 3) } };
  searchUris = ['spotify:track:new1'];
  const registered = register();

  const r = await withConfig('500', () =>
    handlerFor(registered, 'playlist_fill_from_search')({
      playlist_id: 'mix1', queries: ['alpha'], target_count: 1, dry_run: false,
    }));
  const p = r.structuredContent as Record<string, unknown>;

  assert.equal(p.existing_truncated, false);
  assert.equal(p.existing_scanned, 3);
  assert.equal(p.existing_total, 3);
  assert.doesNotMatch(text(r), /Resulting length unknown/);
  assert.equal(p.now_total, 4);
});

// ---------------------------------------------------------------------------
// the description has to price the walk
// ---------------------------------------------------------------------------

test('the algebra description states the per-ref page cost and the disclosure', () => {
  const desc = descriptionOf(register(), 'playlist_expression_algebra');
  assert.match(desc, /SPOTIFY_MCP_FETCH_ALL_CAP\/100/, `quota must price the item pages per ref: ${desc}`);
  assert.match(desc, /truncated=true/, `the disclosure must be advertised: ${desc}`);
  assert.doesNotMatch(desc, /Quota: 🟢 N GETs \+ 1 write\./, 'the old line hid the page-per-ref multiplier');
});
