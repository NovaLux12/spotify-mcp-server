import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
import { SpotifyApiError } from '../src/client.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';
interface RegisteredTool { name: string; validate: (args: Record<string, unknown>) => Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>; }
type Responder = (path: string, arg: unknown) => unknown;
/**
 * Narrow a validated argument bag to the record the harness's `validate`
 * contract promises. zod v4 types `ZodType.parse` as returning `unknown`
 * because a schema can validate to any output; the tools here register object
 * schemas, so the record IS the output — and asserting it here says so by name
 * rather than letting an unchecked `unknown` flow into every `args.x` read.
 */
const asArgs = (value: unknown, tool: string): Record<string, unknown> => {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${tool} validated its input to ${value === null ? 'null' : typeof value}, not an argument object`,
  );
  return value as Record<string, unknown>;
};
function makeHarness(responder: Responder) {
  const registered: RegisteredTool[] = [];
  const fakeServer = { tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) { registered.push({ name, validate: (args) => z.object(schema).parse(args), handler }); }, registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: RegisteredTool['handler']) { registered.push({ name, validate: (args) => asArgs((config.inputSchema as z.ZodType).parse(args), name), handler }); }, } as unknown as McpServer;
  const client = { async get<T>(path: string, params?: Record<string, string>): Promise<T | null> { return responder(path, params) as T | null; }, async getAllPages<T>(path: string, _params?: Record<string, string>): Promise<T[]> { const result = responder(path, _params); if (Array.isArray(result)) return result as T[]; return []; }, // #1310/#1311: the item walk moved to the truncation-aware variant, which
    // is the only way to tell "the playlist has exactly cap rows" from "I
    // stopped at the cap". It delegates to the SAME `getAllPages` above rather
    // than paging again, so every per-test override of `getAllPages` below
    // still drives it — a second implementation here would answer differently
    // from the one the tests are written against. These fixtures are all far
    // below the cap and report no page envelope, so the verdict is "read
    // whole"; the cap-bound cases live in tools.playlists-truncated-rewrite.
    async getAllPagesWithTruncation<T>(this: { getAllPages: <U>(p: string, q?: Record<string, string>) => Promise<U[]> }, path: string, _params?: Record<string, string>, opts?: { maxItems?: number }): Promise<{ items: T[]; truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null; pages: number }> { const items = await this.getAllPages<T>(path, _params); const max = opts?.maxItems ?? items.length; const truncated = items.length > max; return { items: truncated ? items.slice(0, max) : items, truncated, truncatedByCap: truncated, reportedTotal: items.length, pages: 1 }; }, async delete<T>(path: string, body?: unknown): Promise<T | null> { return responder(path, { body }) as T | null; }, } as unknown as SpotifyClient;
  return { registered, client, server: fakeServer, invoke: async (name: string, args: Record<string, unknown>) => { const tool = registered.find((t) => t.name === name)!; assert.ok(tool, `tool ${name} registered`); return tool.handler(tool.validate(args)); }, };
}
const mkTrack = (id: string, overrides: Record<string, unknown> = {}) => ({ added_at: '2026-01-15T10:00:00Z', added_by: { id: 'user1' }, item: { type: 'track' as const, id, name: `Track ${id}`, uri: `spotify:track:${id}`, duration_ms: 200000, artists: [{ name: `Artist ${id}` }], ...overrides }, }) as unknown as PlaylistItemObject;
const mkUnavailable = () => ({ added_at: '2026-01-15T10:00:00Z', item: null }) as unknown as PlaylistItemObject;
const mkLocal = () => ({ added_at: '2026-01-15T10:00:00Z', item: { type: 'track', id: 'local1', name: 'Local', uri: 'spotify:local:Artist:Album:Track:123', duration_ms: 180000, artists: [{ name: 'Local Artist' }], is_local: true }, }) as unknown as PlaylistItemObject;

/**
 * #1555: a harness that stages the case this fix is about — a walk that
 * returns a correct PREFIX of the playlist plus a verdict saying it stopped.
 * `makeHarness`'s walk always reports a complete read, so it cannot express
 * "500 of 900 rows examined", which is the whole defect.
 */
function makeCappedHarness(
  items: PlaylistItemObject[],
  verdict: { truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null },
  meta: unknown = null,
) {
  const registered: RegisteredTool[] = [];
  const fakeServer = { tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) { registered.push({ name, validate: (args) => z.object(schema).parse(args), handler }); }, registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType }, handler: RegisteredTool['handler']) { registered.push({ name, validate: (args) => (config.inputSchema as z.ZodType).parse(args), handler }); }, } as unknown as McpServer;
  const client = {
    async get<T>(path: string): Promise<T | null> { return (meta as T | null); },
    async getAllPages<T>(): Promise<T[]> { return items as unknown as T[]; },
    async getAllPagesWithTruncation<T>(): Promise<{ items: T[]; truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null }> {
      return { items: items as unknown as T[], ...verdict };
    },
    async delete<T>(): Promise<T | null> { return null; },
  } as unknown as SpotifyClient;
  return { registered, client, server: fakeServer, invoke: async (name: string, args: Record<string, unknown>) => { const tool = registered.find((t) => t.name === name)!; assert.ok(tool, `tool ${name} registered`); return tool.handler(tool.validate(args)); } };
}
let tmpDir = ''; let origDataDir: string | undefined;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ph-test-')); origDataDir = process.env.SPOTIFY_MCP_DATA_DIR; process.env.SPOTIFY_MCP_DATA_DIR = tmpDir; });
afterEach(() => { if (origDataDir === undefined) delete process.env.SPOTIFY_MCP_DATA_DIR; else process.env.SPOTIFY_MCP_DATA_DIR = origDataDir; try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
describe('playlist_health_check', () => {
  it('healthy playlist — no issues', async () => { const items = [mkTrack('a'), mkTrack('b'), mkTrack('c')]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { healthy: boolean; issues: unknown[]; total: number }; assert.equal(sc.healthy, true); assert.equal(sc.issues.length, 0); assert.equal(sc.total, 3); });
  it('detects unavailable items', async () => { const items = [mkTrack('a'), mkUnavailable(), mkTrack('c')]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { issues: Array<{ type: string; positions: number[] }> }; const unav = sc.issues.find((i) => i.type === 'unavailable')!; assert.ok(unav); assert.deepEqual(unav.positions, [1]); });
  it('detects local files', async () => { const items = [mkTrack('a'), mkLocal()]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { issues: Array<{ type: string }> }; assert.ok(sc.issues.some((i) => i.type === 'local')); });
  it('detects duplicates', async () => { const items = [mkTrack('a'), mkTrack('b'), mkTrack('a')]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { issues: Array<{ type: string; positions: number[] }>; duplicate_groups: unknown[] }; const dup = sc.issues.find((i) => i.type === 'duplicate')!; assert.ok(dup); assert.deepEqual(dup.positions.sort((a,b)=>a-b), [0,2]); assert.equal(sc.duplicate_groups.length, 1); });
  // #1202: `row.item` came through `row.item as unknown as Record<string, unknown>
  // | null | undefined`. A row whose `item` is an ARRAY is a record to that
  // cast — `typeof [] === 'object'` — so it read as a healthy, playable track
  // with `uri: undefined` and `is_local: false`, and was filed as neither
  // unavailable nor local. `asRecord` rejects it, and the row is reported as
  // what it is: an item this run could not read.
  it('a row whose item is not an object is an unavailable position, not a healthy track', async () => {
    const items = [
      mkTrack('a'),
      { added_at: '2026-01-15T10:00:00Z', item: ['not', 'an', 'object'] } as unknown as PlaylistItemObject,
      mkTrack('c'),
    ];
    const h = makeHarness(() => items);
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { issues: Array<{ type: string; positions: number[] }>; healthy: boolean };
    const unav = sc.issues.find((i) => i.type === 'unavailable');
    assert.ok(unav, 'the unreadable row is reported as unavailable');
    assert.deepEqual(unav.positions, [1]);
    assert.equal(sc.healthy, false);
  });
  it('empty playlist', async () => { const h = makeHarness(() => []); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' }); const sc = out.structuredContent as { issues: Array<{ type: string }>; healthy: boolean }; assert.equal(sc.healthy, false); assert.ok(sc.issues.some((i) => i.type === 'empty')); });

  // ---- #1555: the capped read ------------------------------------------------
  // `healthy` is derived entirely from the rows that came back. Under the cap
  // the rows it did NOT get are exactly the ones that might have carried the
  // fault, so a clean prefix cannot support `healthy: true`.
  it('a capped read does not report healthy (#1555)', async () => {
    const items = [mkTrack('a'), mkTrack('b'), mkTrack('c')];
    const h = makeCappedHarness(items, { truncated: true, truncatedByCap: true, reportedTotal: 900 });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { healthy: boolean | null; total: number | null; items_examined: number; items_truncated: boolean; truncated_by_cap: boolean; issues: unknown[] };
    // null, not true: not clean, not faulty, not established.
    assert.equal(sc.healthy, null);
    // The size is what Spotify stated (900), not the 3 rows that came back.
    assert.equal(sc.total, 900);
    assert.equal(sc.items_examined, 3);
    assert.equal(sc.items_truncated, true);
    assert.equal(sc.truncated_by_cap, true);
    // No fault was found in what WAS examined — that stays true and visible.
    assert.equal(sc.issues.length, 0);
  });

  it('a capped read that DID find issues reports false, and says the audit was bounded (#1555)', async () => {
    const items = [mkTrack('a'), mkUnavailable(), mkTrack('c')];
    const h = makeCappedHarness(items, { truncated: true, truncatedByCap: true, reportedTotal: 900 });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { healthy: boolean | null; total: number | null; items_examined: number };
    // A found fault is a found fault whatever the cap did.
    assert.equal(sc.healthy, false);
    assert.equal(sc.total, 900);
    assert.match(out.content[0].text, /audit bounded: 3 of 900/);
  });

  it('prose does not claim health it could not establish (#1555)', async () => {
    const items = [mkTrack('a'), mkTrack('b')];
    const h = makeCappedHarness(items, { truncated: true, truncatedByCap: true, reportedTotal: 900 });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' });
    // The old string was "is healthy: 2 tracks, no issues" — a 2-row prefix
    // wearing a whole playlist's name.
    assert.doesNotMatch(out.content[0].text, /is healthy/);
    assert.match(out.content[0].text, /health NOT established/);
    assert.match(out.content[0].text, /2 row\(s\) examined/);
    assert.match(out.content[0].text, /SPOTIFY_MCP_FETCH_ALL_CAP/);
  });

  it('a complete read still reports healthy true (#1555 — the fix narrows nothing)', async () => {
    const items = [mkTrack('a'), mkTrack('b'), mkTrack('c')];
    const h = makeCappedHarness(items, { truncated: false, truncatedByCap: false, reportedTotal: 3 });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { healthy: boolean | null; total: number | null; items_truncated: boolean };
    assert.equal(sc.healthy, true);
    assert.equal(sc.total, 3);
    assert.equal(sc.items_truncated, false);
    assert.match(out.content[0].text, /is healthy: 3 track\(s\), no issues/);
  });

  it('a truncated read that is short WITHOUT the cap says so (#718 — the two caps differ)', async () => {
    // The walk ended on a short page while the server's total still counts
    // more. Blaming the cap here would name a ceiling that never bound it.
    const items = [mkTrack('a'), mkTrack('b')];
    const h = makeCappedHarness(items, { truncated: true, truncatedByCap: false, reportedTotal: 900 });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { healthy: boolean | null; truncated_by_cap: boolean };
    assert.equal(sc.healthy, null);
    assert.equal(sc.truncated_by_cap, false);
    assert.match(out.content[0].text, /ended short of the end/);
    assert.doesNotMatch(out.content[0].text, /cap ended the read/);
  });

  it('total is null, not 0, when Spotify states no count (#1555)', async () => {
    const items = [mkTrack('a'), mkTrack('b')];
    // No walk total and no metadata: the length is unknown, not zero and not 2.
    const h = makeCappedHarness(items, { truncated: false, truncatedByCap: false, reportedTotal: null }, null);
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { healthy: boolean | null; total: number | null; items_examined: number };
    assert.equal(sc.total, null);
    assert.equal(sc.items_examined, 2);
    // A complete walk is still a complete walk even with no stated total.
    assert.equal(sc.healthy, true);
    assert.match(out.content[0].text, /length unknown \(2 row\(s\) examined\)/);
  });

  it('falls back to the playlist object when the walk states no total (#1555)', async () => {
    const items = [mkTrack('a'), mkTrack('b')];
    const h = makeCappedHarness(
      items,
      { truncated: false, truncatedByCap: false, reportedTotal: null },
      { items: { total: 640 } },
    );
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('playlist_health_check', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { total: number | null };
    assert.equal(sc.total, 640);
  });
});
describe('get_playlist_followers', () => {
  it('returns follower count', async () => { const h = makeHarness((path) => { if (path === '/playlists/pl1') return { id: 'pl1', name: 'My Mix', followers: { total: 42 }, owner: { id: 'owner1', display_name: 'Owner' } }; return null; }); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('get_playlist_followers', { playlist_id: 'pl1' }); const sc = out.structuredContent as { followers_total: number }; assert.equal(sc.followers_total, 42); });
  it('includes owner profile when requested', async () => { const h = makeHarness((path) => { if (path === '/playlists/pl1') return { id: 'pl1', name: 'My Mix', followers: { total: 5 }, owner: { id: 'owner1', display_name: 'Owner' } }; if (path === '/users/owner1') return { id: 'owner1', display_name: 'Owner' }; return null; }); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('get_playlist_followers', { playlist_id: 'pl1', include_profiles: true }); const sc = out.structuredContent as { owner_profile: unknown }; assert.ok(sc.owner_profile); });

  // #638: `GET /users/{id}` was removed in Feb 2026, so `include_profiles:
  // true` fails on every current registration. The failure used to be
  // swallowed whole -- `catch { ownerProfile = null }` plus a conditional
  // spread -- which made a caller that ASKED for the profile unable to tell
  // "unavailable" from "not requested". These three tests pin the disclosure.
  it('discloses the failed owner-profile read instead of silently omitting it (#638)', async () => {
    const h = makeHarness((path) => {
      if (path === '/playlists/pl1') return { id: 'pl1', name: 'My Mix', followers: { total: 42 }, owner: { id: 'owner1', display_name: 'Owner' } };
      if (path === '/users/owner1') throw new SpotifyApiError(403, 'Forbidden');
      return null;
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('get_playlist_followers', { playlist_id: 'pl1', include_profiles: true });
    const sc = out.structuredContent as { followers_total: number; owner_profile?: unknown; owner_profile_error?: string };
    // The follower count is read from /playlists/{id} and is unaffected.
    assert.equal(sc.followers_total, 42);
    assert.equal(sc.owner_profile, undefined, 'a failed read must not be rendered as a profile');
    // ...and the failure is stated, in the payload and in the prose.
    assert.ok(sc.owner_profile_error, 'a requested-but-unreadable profile must be disclosed in structuredContent');
    assert.match(sc.owner_profile_error!, /Forbidden/);
    assert.match(sc.owner_profile_error!, /removed by Spotify's February 2026/);
    assert.match(out.content[0].text, /Owner profile unavailable/);
    assert.match(out.content[0].text, /February 2026/);
  });

  it('reports an empty owner-profile body as unreadable too, not as no profile (#638)', async () => {
    const h = makeHarness((path) => {
      if (path === '/playlists/pl1') return { id: 'pl1', name: 'My Mix', followers: { total: 7 }, owner: { id: 'owner1', display_name: 'Owner' } };
      return null; // /users/owner1 answers with an empty body
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('get_playlist_followers', { playlist_id: 'pl1', include_profiles: true });
    const sc = out.structuredContent as { owner_profile?: unknown; owner_profile_error?: string };
    assert.equal(sc.owner_profile, undefined);
    assert.match(sc.owner_profile_error ?? '', /empty response/);
  });

  it('says nothing about the profile when none was requested (#638)', async () => {
    // The disclosure must not fire on the default path: a caller who did not
    // ask for a profile has no unmet request to be told about.
    const h = makeHarness((path) => {
      if (path === '/playlists/pl1') return { id: 'pl1', name: 'My Mix', followers: { total: 42 }, owner: { id: 'owner1', display_name: 'Owner' } };
      throw new Error(`unexpected call to ${path}`);
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('get_playlist_followers', { playlist_id: 'pl1' });
    const sc = out.structuredContent as Record<string, unknown>;
    assert.ok(!('owner_profile' in sc));
    assert.ok(!('owner_profile_error' in sc));
    assert.equal(sc.followers_total, 42);
  });
});
describe('playlist_collaboration_report', () => {
  // `added_by` is a real field of a `GET /playlists/{id}/items` row and the tool
  // reads it (src/tools/playlisthealth.ts:224 asks the walk for
  // `PlaylistItemObject & { added_by?: { id: string } }`). The base
  // `PlaylistItemObject` does not declare it, so the test spelled its own
  // widening via `PlaylistItemObject['added_by']` — an indexed access on a
  // property that does not exist, which is why it needed a double cast. Naming
  // the same widening the source names removes both.
  type ContributorRow = PlaylistItemObject & { added_by?: { id: string } };
  const row = (id: string, user: string, addedAt: string): ContributorRow => ({
    added_at: addedAt,
    added_by: { id: user },
    item: { type: 'track', id, name: `T${id}`, uri: `spotify:track:${id}`, duration_ms: 1000, artists: [] },
  } as unknown as ContributorRow);
  it('rolls up contributors with counts and timestamps', async () => { const items: ContributorRow[] = [ row('1', 'alice', '2026-01-01T00:00:00Z'), row('2', 'bob', '2026-01-02T00:00:00Z'), row('3', 'alice', '2026-01-03T00:00:00Z') ]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const out = await h.invoke('playlist_collaboration_report', { playlist_id: 'pl1' }); const sc = out.structuredContent as { contributors: Array<{ user_id: string; count: number }>; most_active: string }; assert.equal(sc.contributors.length, 2); assert.equal(sc.contributors[0].user_id, 'alice'); assert.equal(sc.contributors[0].count, 2); assert.equal(sc.most_active, 'alice'); });
});
describe('find_duplicate_playlists dry_run + quota', () => {
  it('dry_run returns cost estimate without calls', async () => {
    let calls = 0;
    const h = makeHarness(() => { calls++; return []; });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('find_duplicate_playlists', { dry_run: true, max_playlists: 10, scan_cap: 100 });
    assert.equal(calls, 0);
    assert.equal((out.structuredContent as Record<string, unknown>).dry_run, true);
    assert.equal((out.structuredContent as Record<string, unknown>).estimated_requests, 11);
    assert.match(out.content[0].text, /dry run/);
  });
  it('quota partial recovery returns groups so far', async () => {
    const { SpotifyApiError } = await import('../src/client.js');
    const h2 = makeHarness(() => []);
    let calls2 = 0;
    (h2.client as unknown as Record<string, unknown>).getAllPages = async (path: string) => {
      if (path === '/me/playlists') return [{ id: 'pl1', name: 'P1' }, { id: 'pl2', name: 'P2' }] as unknown[];
      if (path.startsWith('/playlists/')) {
        calls2++;
        if (calls2 === 2) throw new SpotifyApiError(429, 'quota', 30);
        return [{ item: { uri: 'spotify:track:t1' } }] as unknown[];
      }
      return [];
    };
    h2.registered.length = 0;
    const { registerPlaylistHealthTools: reg2 } = await import('../src/tools/playlisthealth.js');
    // need fresh server to avoid duplicate registration from before
    const h3 = makeHarness(() => []);
    let c3 = 0;
    (h3.client as unknown as Record<string, unknown>).getAllPages = async (path: string) => {
      if (path === '/me/playlists') return [{ id: 'pl1', name: 'P1' }, { id: 'pl2', name: 'P2' }] as unknown[];
      if (path.startsWith('/playlists/')) { c3++; if (c3 === 2) throw new SpotifyApiError(429, 'quota', 30); return [{ item: { uri: 'spotify:track:t1' } }] as unknown[]; }
      return [];
    };
    reg2(h3.server as unknown as McpServer, h3.client);
    const out = await h3.invoke('find_duplicate_playlists', { max_playlists: 2 });
    assert.equal((out.structuredContent as Record<string, unknown>).quota_hit, true);
    assert.match(out.content[0].text, /quota hit/i);
  });
  it('excludes an unreadable playlist from duplicate groups and reports its reason', async () => {
    const h = makeHarness(() => []);
    (h.client as unknown as Record<string, unknown>).getAllPages = async (path: string) => {
      if (path === '/me/playlists') return [{ id: 'plForbidden', name: 'Private Mix' }, { id: 'plEmpty1', name: 'Empty One' }, { id: 'plEmpty2', name: 'Empty Two' }] as unknown[];
      if (path.startsWith('/playlists/plForbidden')) throw new SpotifyApiError(403, 'Insufficient client scope');
      if (path.startsWith('/playlists/')) return [] as unknown[];
      return [];
    };
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('find_duplicate_playlists', { max_playlists: 3 });
    const sc = out.structuredContent as {
      groups: Array<{ type: string; playlists: Array<{ id: string }> }>;
      failed_count: number;
      unreadable: Array<{ id: string; error: string }>;
      empty_playlists: Array<{ id: string }>;
    };
    // A failed fetch is not an empty playlist: it must not group with the two
    // real empty ones, and it must not be silently dropped either.
    assert.equal(sc.groups.length, 0);
    assert.equal(sc.failed_count, 1);
    assert.deepEqual(sc.unreadable.map((u) => u.id), ['plForbidden']);
    assert.match(sc.unreadable[0].error, /Insufficient client scope/);
    assert.deepEqual(sc.empty_playlists.map((p) => p.id), ['plEmpty1', 'plEmpty2']);
    assert.match(out.content[0].text, /unreadable: "Private Mix" \(plForbidden\) — Insufficient client scope/);
    assert.doesNotMatch(out.content[0].text, /plForbidden\) ↔/);
  });
});

describe('snapshot + diff + list', () => {
  it('snapshot round-trip creates file and list finds it', async () => { const items = [mkTrack('a'), mkTrack('b')]; const h = makeHarness(() => items); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); const snap = await h.invoke('snapshot_playlist', { playlist_id: 'pl1', snapshot_id: 'snap1' }); const sc = snap.structuredContent as { snapshot_id: string }; assert.equal(sc.snapshot_id, 'snap1'); const list = await h.invoke('list_playlist_snapshots', { playlist_id: 'pl1' }); const lsc = list.structuredContent as { count: number }; assert.equal(lsc.count, 1); });
  it('diff detects added, removed, and reordered', async () => { const initialItems = [mkTrack('a'), mkTrack('b'), mkTrack('c')]; let currentItems: PlaylistItemObject[] = initialItems; const h = makeHarness(() => currentItems); registerPlaylistHealthTools(h.server as unknown as McpServer, h.client); await h.invoke('snapshot_playlist', { playlist_id: 'pl1', snapshot_id: 'snap1' }); currentItems = [mkTrack('c'), mkTrack('a'), mkTrack('d')]; const diff = await h.invoke('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'snap1' }); const sc = diff.structuredContent as { added: unknown[]; removed: unknown[]; reordered: unknown[] }; assert.equal(sc.added.length, 1); assert.equal(sc.removed.length, 1); assert.ok(sc.reordered.length > 0); });
  it('reports a swapped duplicate occurrence instead of "no change" (#876 multiset)', async () => {
    // Snapshot and live hold the same URI set {a, b}; only the counts differ.
    let currentItems: PlaylistItemObject[] = [mkTrack('a'), mkTrack('a'), mkTrack('b')];
    const h = makeHarness(() => currentItems);
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    await h.invoke('snapshot_playlist', { playlist_id: 'pl1', snapshot_id: 'dup1' });
    currentItems = [mkTrack('a'), mkTrack('b'), mkTrack('b')];
    const diff = await h.invoke('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'dup1' });
    const sc = diff.structuredContent as {
      added: Array<{ uri: string }>; removed: Array<{ uri: string }>;
      added_count: number; removed_count: number; same_multiset: boolean; has_changes: boolean;
    };
    assert.equal(sc.added_count, 1);
    assert.equal(sc.removed_count, 1);
    assert.deepEqual(sc.added.map((a) => a.uri), ['spotify:track:b']);
    assert.deepEqual(sc.removed.map((r) => r.uri), ['spotify:track:a']);
    assert.equal(sc.same_multiset, false);
    assert.equal(sc.has_changes, true);
    assert.match(diff.content[0].text, /added: spotify:track:b/);
  });
  it('reports an extra copy of an already-present track (#876 multiset)', async () => {
    let currentItems: PlaylistItemObject[] = [mkTrack('a'), mkTrack('b')];
    const h = makeHarness(() => currentItems);
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    await h.invoke('snapshot_playlist', { playlist_id: 'pl1', snapshot_id: 'dup2' });
    currentItems = [mkTrack('a'), mkTrack('b'), mkTrack('a')];
    const diff = await h.invoke('diff_since_snapshot', { playlist_id: 'pl1', snapshot_id: 'dup2' });
    const sc = diff.structuredContent as { added: Array<{ uri: string; position: number }>; added_count: number; removed_count: number; same_multiset: boolean };
    assert.equal(sc.added_count, 1);
    assert.equal(sc.removed_count, 0);
    assert.deepEqual(sc.added, [{ uri: 'spotify:track:a', position: 2 }]);
    assert.equal(sc.same_multiset, false);
  });
});

  it('redacts filesystem errors and caller-provided URL or path sentinels', async () => {
    const h = makeHarness(() => []);
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    await assert.rejects(
      h.invoke('diff_since_snapshot', {
        playlist_id: 'https://example.test/SENTINEL_PLAYLIST?token=secret',
        snapshot_id: '/home/alice/SENTINEL_SNAPSHOT.json',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // "not found" keeps it a client error the caller can act on; the ids
        // themselves stay out (one is a caller URL, the other a local path).
        assert.equal(error.message, 'Snapshot not found for the requested playlist.');
        return true;
      },
    );
  });

describe('remove_unavailable_playlist_items', () => {
  it('deletes only validated unavailable positions highest first and verifies the rescan', async () => {
    let items: PlaylistItemObject[] = [mkTrack('a'), mkUnavailable(), mkTrack('b'), mkUnavailable(), mkTrack('c')];
    const writes: Array<Record<string, unknown>> = [];
    const h = makeHarness((path, arg) => {
      if (arg && typeof arg === 'object' && 'body' in arg) {
        const body = arg.body as { tracks: Array<{ positions: number[] }> };
        const position = body.tracks[0].positions[0];
        writes.push(body);
        items.splice(position, 1);
        return { snapshot_id: 'snap1' };
      }
      assert.equal(path, '/playlists/pl1/items');
      return items;
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1', max_removals: 2 });
    const sc = out.structuredContent as { ok: boolean; removed: number; removed_positions: number[] };
    assert.equal(sc.ok, true);
    assert.equal(sc.removed, 2);
    assert.deepEqual(writes.map((body) => (body.tracks as Array<{ positions: number[] }>)[0].positions[0]), [3, 1]);
    assert.ok(writes.every((body) => !('uri' in (body.tracks as Array<Record<string, unknown>>)[0])));
    assert.deepEqual(sc.removed_positions, [1, 3]);
  });

  it('returns failure when DELETE does not change the unavailable rows', async () => {
    const h = makeHarness((_path, arg) => arg && typeof arg === 'object' && 'body' in arg
      ? { snapshot_id: 'snap1' }
      : [mkUnavailable(), mkTrack('a')]);
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { ok: boolean; removed: number; remaining_unavailable: number; remaining_positions: number[] };
    assert.equal(sc.ok, false);
    assert.equal(sc.removed, 0);
    assert.equal(sc.remaining_unavailable, 1);
    assert.deepEqual(sc.remaining_positions, [0]);
  });

  it('defaults the destructive cap to all detected unavailable rows with the explicit automation bypass', async () => {
    const previousConfirm = process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    try {
      let items: PlaylistItemObject[] = Array.from({ length: 101 }, mkUnavailable);
      let writes = 0;
      const h = makeHarness((_path, arg) => {
        if (arg && typeof arg === 'object' && 'body' in arg) {
          writes++;
          items = [];
          return { snapshot_id: 'snap1' };
        }
        return items;
      });
      registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
      const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1' });
      assert.equal(writes, 101);
      assert.equal((out.structuredContent as { ok: boolean }).ok, true);
    } finally {
      if (previousConfirm === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = previousConfirm;
    }
  });

  it('does not write during dry run', async () => {
    let writes = 0;
    const h = makeHarness((_path, arg) => {
      if (arg && typeof arg === 'object' && 'body' in arg) { writes++; return {}; }
      return [mkUnavailable(), mkTrack('a')];
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1', dry_run: true });
    assert.equal(writes, 0);
    assert.equal((out.structuredContent as { dry_run: boolean }).dry_run, true);
  });

  it('reports verification unavailable when the post-write rescan fails', async () => {
    let gets = 0;
    const h = makeHarness((_path, arg) => {
      if (arg && typeof arg === 'object' && 'body' in arg) return { snapshot_id: 'snap1' };
      gets++;
      if (gets === 1) return [mkUnavailable(), mkTrack('a')];
      throw new Error('SENTINEL_HEALTH https://example.test/raw?token=secret /home/alice/private.json', { cause: new Error('nested private path') });
    });
    registerPlaylistHealthTools(h.server as unknown as McpServer, h.client);
    const out = await h.invoke('remove_unavailable_playlist_items', { playlist_id: 'pl1' });
    const sc = out.structuredContent as { ok: boolean; verification: string; removed: null };
    assert.equal(sc.ok, false);
    assert.equal(sc.verification, 'unavailable');
    assert.equal(sc.removed, null);
    const publicText = JSON.stringify(out);
    for (const secret of ['SENTINEL_HEALTH', 'token=secret', '/home/alice', 'nested private path']) {
      assert.equal(publicText.includes(secret), false, `post-write failure leaked ${secret}`);
    }
  });
});
