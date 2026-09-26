import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { registerSwarm3SnapshotsTools } from '../src/tools/swarm3_snapshots.js';
import { getConfig, initConfig } from '../src/config.js';
import type { SpotifyClient } from '../src/client.js';

/**
 * #780: `resolveMaxResults` falls back to `getConfig().maxItems`, so
 * SPOTIFY_MCP_MAX_ITEMS caps every list tool that omits max_results — not just
 * the call sites that pass the config-aware fallback themselves. Both a catalog
 * tool and an exhaust2 tool are exercised here so a regression cannot hide in
 * one module: an explicit `getConfig().maxItems` argument at a single call site
 * would make that module pass while the other keeps the old hardcoded default.
 */

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ARTIST = { id: 'a1', name: 'Artist', uri: 'spotify:artist:a1' };
const MAX_ITEMS = 5;

function albums(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `al${i + 1}`,
    name: `Album ${i + 1}`,
    uri: `spotify:album:al${i + 1}`,
    album_type: 'album',
    release_date: '2020-01-01',
    total_tracks: 3,
    artists: [ARTIST],
  }));
}

function tracks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    name: `Track ${i + 1}`,
    uri: `spotify:track:t${i + 1}`,
    duration_ms: 200_000,
    explicit: false,
    track_number: i + 1,
    artists: [ARTIST],
    album: { id: 'al1', name: 'Album 1', release_date: '2020-01-01', album_type: 'album', total_tracks: count },
  }));
}

/**
 * `get_artist_albums` without fetch_all reads one page of at most
 * ARTIST_ALBUM_PAGE_LIMIT albums, so a full page is what makes the configured
 * cap observable on the catalog side.
 */
const PAGE = 10;

function stubClient() {
  return {
    get: async (path: string, params?: Record<string, string>) => {
      // #1224: `track_enrichment_batch` reads per id now — the `?ids=` batch
      // routes are removed — so the per-id legs are served here and the bare
      // `/tracks` / `/albums` / `/artists` branches are gone. A stub that kept
      // them would let a regression back onto the batch route pass unnoticed.
      const oneTrack = /^\/tracks\/(.+)$/.exec(path);
      if (oneTrack) return tracks(40).find((t) => t.id === decodeURIComponent(oneTrack[1])) ?? null;
      const oneAlbum = /^\/albums\/(.+)$/.exec(path);
      if (oneAlbum) {
        const album = albums(40).find((a) => a.id === decodeURIComponent(oneAlbum[1]));
        return album ? { ...album, label: 'Label' } : null;
      }
      // `[^/]+`, not `.+`: `/artists/a1/albums` is a listing, not an artist,
      // and a greedy match would swallow the walk this stub also serves.
      const oneArtist = /^\/artists\/([^/]+)$/.exec(path);
      if (oneArtist) return { ...ARTIST, genres: ['pop'] };
      if (path.endsWith('/tracks')) return { tracks: tracks(40) };
      if (path.endsWith('/albums')) {
        const offset = Number(params?.offset ?? 0);
        return { items: albums(PAGE), total: 40, limit: PAGE, offset };
      }
      return null;
    },
    getAllPages: async () => albums(40),
    getAllPagesWithTruncation: async () => ({ items: tracks(40), truncated: false, pages: 1, stopped: 'exhausted' }),
    put: async () => null,
    post: async () => null,
    delete: async () => null,
  } as unknown as SpotifyClient;
}

function handlerFor(register: (server: McpServer, client: SpotifyClient) => void, name: string, client: SpotifyClient): Handler {
  let captured: Handler | undefined;
  const server = {
    tool(toolName: string, _description: string, _shape: unknown, handler: Handler) {
      if (toolName === name) captured = handler;
    },
  } as unknown as McpServer;
  register(server, client);
  if (!captured) throw new Error(`tool ${name} not registered`);
  return captured;
}

/** The zod shape a tool registered, so the advertised default can be read at runtime. */
function shapeFor(register: (server: McpServer, client: SpotifyClient) => void, name: string, client: SpotifyClient): Record<string, { description?: string }> {
  let captured: Record<string, { description?: string }> | undefined;
  const server = {
    tool(toolName: string, _description: string, shape: Record<string, { description?: string }>, _handler: Handler) {
      if (toolName === name) captured = shape;
    },
  } as unknown as McpServer;
  register(server, client);
  if (!captured) throw new Error(`tool ${name} not registered`);
  return captured;
}

/** Count the item rows a prose response actually shows, ignoring headers/footers. */
function proseRows(text: string): number {
  return text.split('\n').filter((line) => /^\s*(•|#\d+\.)/.test(line)).length;
}

function structuredRows(result: ToolResult, key: string): number {
  const rows = result.structuredContent?.[key];
  return Array.isArray(rows) ? rows.length : -1;
}

describe('SPOTIFY_MCP_MAX_ITEMS caps every tool that omits max_results (#780)', () => {
  const previous = process.env.SPOTIFY_MCP_MAX_ITEMS;

  before(() => {
    initConfig({ ...process.env, SPOTIFY_MCP_MAX_ITEMS: String(MAX_ITEMS) });
  });

  after(() => {
    if (previous === undefined) delete process.env.SPOTIFY_MCP_MAX_ITEMS;
    else process.env.SPOTIFY_MCP_MAX_ITEMS = previous;
    initConfig(process.env);
  });

  it('truncates a catalog list tool to the configured cap', async () => {
    const result = await handlerFor(registerCatalogTools, 'get_artist_albums', stubClient())({ id: 'a1' });
    assert.equal(proseRows(result.content[0].text), MAX_ITEMS, 'get_artist_albums prose');
    assert.equal(structuredRows(result, 'items'), MAX_ITEMS, 'get_artist_albums structuredContent');
  });

  it('truncates an exhaust2 list tool to the same configured cap', async () => {
    const result = await handlerFor(registerExhaust2CatalogTools, 'track_enrichment_batch', stubClient())({
      track_ids: tracks(40).map((t) => t.id),
    });
    assert.equal(proseRows(result.content[0].text), MAX_ITEMS, 'track_enrichment_batch prose');
    assert.equal(structuredRows(result, 'tracks'), MAX_ITEMS, 'track_enrichment_batch structuredContent');
  });

  it('reports the same total for both, so the two modules cannot diverge', async () => {
    const client = stubClient();
    const catalog = await handlerFor(registerCatalogTools, 'get_artist_albums', client)({ id: 'a1' });
    const exhaust = await handlerFor(registerExhaust2CatalogTools, 'track_enrichment_batch', client)({
      track_ids: tracks(40).map((t) => t.id),
    });
    assert.equal(proseRows(catalog.content[0].text), proseRows(exhaust.content[0].text));
    assert.equal(proseRows(catalog.content[0].text), MAX_ITEMS);
  });

  it('leaves an explicit max_results ahead of the configured cap', async () => {
    const result = await handlerFor(registerCatalogTools, 'get_artist_albums', stubClient())({ id: 'a1', max_results: 3 });
    assert.equal(proseRows(result.content[0].text), 3);
  });
});

/**
 * A walk-bounded tool (#337 timeline, #350 episode timeline, #349 chapter map)
 * deliberately returns its whole fetch-all walk rather than the
 * SPOTIFY_MCP_MAX_ITEMS page, so its advertised default and its payload must
 * name the bound that actually applies instead of the configured page cap.
 */
describe('walk-bounded catalog tools advertise and disclose the fetch-all bound (#780)', () => {
  const previous = process.env.SPOTIFY_MCP_MAX_ITEMS;

  before(() => {
    initConfig({ ...process.env, SPOTIFY_MCP_MAX_ITEMS: String(MAX_ITEMS) });
  });

  after(() => {
    if (previous === undefined) delete process.env.SPOTIFY_MCP_MAX_ITEMS;
    else process.env.SPOTIFY_MCP_MAX_ITEMS = previous;
    initConfig(process.env);
  });

  const WALK_BOUNDED = ['artist_discography_timeline', 'show_episode_timeline', 'audiobook_chapter_map'];

  for (const tool of WALK_BOUNDED) {
    it(`${tool} advertises the fetch-all bound, not SPOTIFY_MCP_MAX_ITEMS`, () => {
      const shape = shapeFor(registerExhaust2CatalogTools, tool, stubClient());
      assert.match(String(shape.max_results?.description), /SPOTIFY_MCP_FETCH_ALL_CAP/);
      assert.doesNotMatch(String(shape.max_results?.description), /SPOTIFY_MCP_MAX_ITEMS/);
    });
  }

  it('discloses in payload and prose when the discography walk hit the bound', async () => {
    const cap = getConfig().fetchAllCap;
    const client = { ...stubClient(), getAllPages: async () => albums(cap) } as unknown as SpotifyClient;
    const result = await handlerFor(registerExhaust2CatalogTools, 'artist_discography_timeline', client)({ artist_id: 'a1' });
    assert.equal(result.structuredContent?.fetch_all_cap, cap);
    assert.equal(result.structuredContent?.truncated_by_cap, true);
    assert.ok(result.content[0].text.includes('fetch-all cap REACHED'));
    assert.ok(proseRows(result.content[0].text) > MAX_ITEMS, 'the walk is returned whole, not capped at the page size');
  });

  it('reports a complete walk as uncapped when it stopped short of the bound', async () => {
    const cap = getConfig().fetchAllCap;
    const client = { ...stubClient(), getAllPages: async () => albums(cap - 1) } as unknown as SpotifyClient;
    const result = await handlerFor(registerExhaust2CatalogTools, 'artist_discography_timeline', client)({ artist_id: 'a1' });
    assert.equal(result.structuredContent?.truncated_by_cap, false);
    assert.ok(!result.content[0].text.includes('fetch-all cap REACHED'));
  });

  it('discloses the bound on the chapter map payload as well as in prose', async () => {
    const cap = getConfig().fetchAllCap;
    const chapters = Array.from({ length: cap }, (_, i) => ({
      id: `c${i}`,
      name: `Chapter ${i}`,
      uri: `u${i}`,
      chapter_number: i,
      duration_ms: 60_000,
      release_date: '2020',
      explicit: false,
      description: '',
      is_playable: true,
    }));
    const book = {
      id: 'ab1', name: 'Dune', uri: 'u', authors: [{ name: 'FH' }], narrators: [],
      total_chapters: cap, release_date: '2020', description: '', explicit: false,
      media_type: 'audio', languages: ['en'],
    };
    const client = {
      ...stubClient(),
      get: async (path: string) => (path.includes('/chapters') ? null : book),
      getAllPages: async () => chapters,
    } as unknown as SpotifyClient;
    const result = await handlerFor(registerExhaust2CatalogTools, 'audiobook_chapter_map', client)({ audiobook_id: 'ab1' });
    assert.equal(result.structuredContent?.fetch_all_cap, cap);
    assert.equal(result.structuredContent?.truncated_by_cap, true);
    assert.ok(result.content[0].text.includes('fetch-all cap REACHED'));
  });
});

/**
 * A hardcoded fallback is only a defect where the tool ADVERTISES the env var.
 * `MaxResults.describe('Max releases to return (default 40).')` is a contract
 * kept by a literal 40; the same 50 under the shared `MaxResults` fragment
 * promises SPOTIFY_MCP_MAX_ITEMS and is a lie. #780 removed the second kind
 * from 14 call sites across swarm3_snapshots, swarm3b_discovery and
 * statsfm_taste; these pin the pair back together.
 */
describe('the advertised max_results default is the one actually applied (#780)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

  /** Drop comments, keep string literals — descriptions are the thing under test. */
  function stripComments(src: string): string {
    let out = '';
    let quote: string | null = null;
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      const next = src[i + 1];
      if (quote) {
        out += ch;
        if (ch === '\\') { out += next ?? ''; i += 1; }
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
      if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; out += '\n'; continue; }
      if (ch === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i += 1; } i += 1; continue; }
      out += ch;
    }
    return out;
  }

  /** The declaration expression after `max_results:`, up to the property's comma. */
  function declarationAfter(src: string, from: number): string {
    let depth = 0;
    let quote: string | null = null;
    for (let i = from; i < src.length; i += 1) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === ',' && depth <= 0) return src.slice(from, i);
    }
    return src.slice(from);
  }

  /**
   * Does this tool promise SPOTIFY_MCP_MAX_ITEMS? True when it says so in its
   * own text, and also when it uses the shared `MaxResults` fragment bare —
   * that fragment's description is "default: SPOTIFY_MCP_MAX_ITEMS env or 50".
   */
  function promisesEnvVar(declaration: string): boolean {
    if (declaration.includes('SPOTIFY_MCP_MAX_ITEMS')) return true;
    const overridden = /\.\s*describe\(/;
    if (overridden.test(declaration)) return /\.\s*describe\([^)]*SPOTIFY_MCP_MAX_ITEMS/.test(declaration);
    return /^\s*(MaxResults|MaxResultsArgName)\s*$/.test(declaration);
  }

  interface Offence { file: string; tool: string; fallback: string }
  const offences: Offence[] = [];
  const uncovered: string[] = [];
  const unattributed: string[] = [];
  let envVarTools = 0;
  let agreeingTools = 0;

  // Every way a tool gets registered in this tree. `server.tool(` alone was not
  // enough: statsfm_taste.ts reaches the server through a `dualRegister`
  // helper, and a marker set that misses it makes the whole scan blind to that
  // module while still reporting a healthy count (the trap this test bit on).
  const REGISTRATION = /server\s*\.\s*(?:tool|registerTool)\s*\(|\bdualRegister\s*\(/g;
  const LITERAL_FALLBACK = /resolveMaxResults\(\s*[^,()]+,\s*(\d+)\s*\)/g;

  for (const file of readdirSync(join(ROOT, 'src', 'tools')).filter((f) => f.endsWith('.ts')).sort()) {
    const src = stripComments(readFileSync(join(ROOT, 'src', 'tools', file), 'utf8'));
    if (!/max_results\s*:/.test(src)) continue;
    const starts = [...src.matchAll(REGISTRATION)];
    if (starts.length === 0) { uncovered.push(file); continue; }
    // A literal fallback ahead of the first registration is a module-level
    // helper this block walk cannot attribute to any tool, so it would escape
    // the per-tool check below entirely. A module-level `max_results` SCHEMA
    // is fine (playlists.ts shares one); only the call is unattributable.
    for (const call of src.slice(0, starts[0].index!).matchAll(LITERAL_FALLBACK)) {
      unattributed.push(`${file}: ${call[0]}`);
    }
    for (let t = 0; t < starts.length; t += 1) {
      const block = src.slice(starts[t].index!, t + 1 < starts.length ? starts[t + 1].index! : src.length);
      const decl = /max_results\s*:/.exec(block);
      if (!decl) continue;
      const promise = promisesEnvVar(declarationAfter(block, decl.index + decl[0].length));
      if (!promise) { agreeingTools += 1; continue; }
      envVarTools += 1;
      // Both markers take the tool name as their first quoted argument.
      const name = /'([a-z0-9_]+)'/.exec(block)?.[1] ?? '(unparsed)';
      for (const call of block.matchAll(LITERAL_FALLBACK)) {
        offences.push({ file, tool: name, fallback: call[1] });
      }
    }
  }

  it('leaves no env-var-advertising tool with a hardcoded fallback', () => {
    assert.deepEqual(offences, [], `hardcoded fallbacks under an advertised env-var default: ${JSON.stringify(offences)}`);
  });

  it('actually examined the tools it claims to (the scan is not vacuous)', () => {
    assert.ok(envVarTools >= 100, `only ${String(envVarTools)} tools advertise SPOTIFY_MCP_MAX_ITEMS; the scan may not be matching`);
    assert.ok(agreeingTools >= 1, 'the scan classified no max_results declaration at all, so it cannot be discriminating');
  });

  it('reads every module that declares a max_results (no blind spots)', () => {
    assert.deepEqual(uncovered, [], `these modules declare max_results but the scan found no registration in them: ${JSON.stringify(uncovered)}`);
  });

  it('attributes every hardcoded fallback to a scanned tool', () => {
    assert.deepEqual(unattributed, [], `literal fallbacks outside any registration block: ${JSON.stringify(unattributed)}`);
  });
});

/**
 * The two swarm3_snapshots display caps that ignored the env var. Both read
 * local JSON — no Spotify walk, so nothing about them is walk-bounded and the
 * configured cap is simply the right fallback.
 */
describe('local-snapshot display caps honour SPOTIFY_MCP_MAX_ITEMS (#780)', () => {
  const previousEnv = process.env.SPOTIFY_MCP_MAX_ITEMS;
  const previousDir = process.env.SPOTIFY_MCP_SNAPSHOT_DIR;
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spotify-mcp-780-'));
    process.env.SPOTIFY_MCP_SNAPSHOT_DIR = dir;
    process.env.SPOTIFY_MCP_MAX_ITEMS = String(MAX_ITEMS);
    initConfig({ ...process.env, SPOTIFY_MCP_MAX_ITEMS: String(MAX_ITEMS) });
  });

  afterEach(async () => {
    if (previousEnv === undefined) delete process.env.SPOTIFY_MCP_MAX_ITEMS;
    else process.env.SPOTIFY_MCP_MAX_ITEMS = previousEnv;
    if (previousDir === undefined) delete process.env.SPOTIFY_MCP_SNAPSHOT_DIR;
    else process.env.SPOTIFY_MCP_SNAPSHOT_DIR = previousDir;
    initConfig(process.env);
    await rm(dir, { recursive: true, force: true });
  });

  const track = (i: number) => ({ uri: `spotify:track:s${i}`, name: `Track ${i}`, added_at: '2026-01-01T00:00:00Z' });

  async function writeSnap(file: string, id: string, takenAt: string, count: number) {
    const tracks = Array.from({ length: count }, (_, i) => track(i + 1));
    await writeFile(join(dir, file), JSON.stringify({
      _meta: { playlist_id: 'pl1', snapshot_id: id, taken_at: takenAt, track_count: tracks.length },
      tracks,
    }));
  }

  it('caps diff_playlist_snapshots at the configured page, not its old hardcoded 100', async () => {
    await writeSnap('plsnap-pl1-2026-01-01-1.json', 'plsnap-pl1-2026-01-01-1', '2026-01-01T00:00:00Z', 2);
    await writeSnap('plsnap-pl1-2026-02-01-1.json', 'plsnap-pl1-2026-02-01-1', '2026-02-01T00:00:00Z', 12);
    const result = await handlerFor(registerSwarm3SnapshotsTools, 'diff_playlist_snapshots', stubClient())({
      from_snapshot: 'plsnap-pl1-2026-01-01-1',
      to_snapshot: 'plsnap-pl1-2026-02-01-1',
    });
    assert.equal(result.structuredContent?.added_count, 10, 'the diff itself saw the whole change');
    assert.equal(structuredRows(result, 'added'), MAX_ITEMS, 'diff_playlist_snapshots applied the configured cap');
  });

  it('caps snapshot_changelog at the configured page, not its old hardcoded 50', async () => {
    for (let i = 1; i <= 8; i += 1) {
      const day = String(i).padStart(2, '0');
      await writeSnap(`plsnap-pl1-2026-01-${day}-1.json`, `plsnap-pl1-2026-01-${day}-1`, `2026-01-${day}T00:00:00Z`, i);
    }
    const result = await handlerFor(registerSwarm3SnapshotsTools, 'snapshot_changelog', stubClient())({ playlist: 'pl1' });
    assert.equal(result.structuredContent?.total_entries, 8, 'every snapshot pair produced a changelog entry');
    assert.equal(structuredRows(result, 'entries'), MAX_ITEMS, 'snapshot_changelog applied the configured cap');
  });

  it('still lets an explicit max_results win over the configured cap', async () => {
    await writeSnap('plsnap-pl1-2026-01-01-1.json', 'plsnap-pl1-2026-01-01-1', '2026-01-01T00:00:00Z', 2);
    await writeSnap('plsnap-pl1-2026-02-01-1.json', 'plsnap-pl1-2026-02-01-1', '2026-02-01T00:00:00Z', 12);
    const result = await handlerFor(registerSwarm3SnapshotsTools, 'diff_playlist_snapshots', stubClient())({
      from_snapshot: 'plsnap-pl1-2026-01-01-1',
      to_snapshot: 'plsnap-pl1-2026-02-01-1',
      max_results: 2,
    });
    assert.equal(structuredRows(result, 'added'), 2);
  });
});