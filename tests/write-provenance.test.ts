/**
 * #708 — purpose + provenance when stored Spotify data drives a write.
 *
 * The failure these tests exist to prevent is a record that reads as an
 * answer and is not one. Three ways that happened here and each has a test:
 *
 *  - The write proceeded with no human in the loop — under a threshold, or
 *    through SPOTIFY_MCP_CONFIRM=never — and a `confirmed: true` would have
 *    been a fabrication wearing a compliance label. The consent state is
 *    therefore not a boolean, and every one of the four states is asserted.
 *  - The file declares no creation date, and something plausible was wanted
 *    in that slot. The record says null and NAMES the reason; the mtime a
 *    copy would reset is never used.
 *  - The words shown in the elicitation prompt and the words stored in the
 *    result are generated from one object, so they cannot drift. A test
 *    drives the real restore tool and asserts the prompt's fragments appear
 *    verbatim in the stored note.
 *
 * The file also pins the ENUMERATION: exactly six tools write Spotify state
 * from locally stored Spotify data, and exactly the five modules holding them
 * pass the record through. A seventh call site added without the record, or a
 * module edited to stop recording, fails the census test rather than shipping
 * silently.
 */

import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';

import { registerRestoreTools } from '../src/tools/restore.js';
import { registerImportTools } from '../src/tools/import.js';
import { registerPortabilityTools } from '../src/tools/portability.js';
import { registerSwarm3SnapshotsTools } from '../src/tools/swarm3_snapshots.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import {
  consentAfterGate,
  declaredCreationDate,
  provenanceNote,
  provenancePromptLines,
  type WriteProvenance,
} from '../src/tools/provenance.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

interface RecordedCall {
  method: string;
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg?: unknown) => unknown;

/**
 * Offset paging exactly as the production walk drives it: a page is
 * `{items,total,limit,offset}` and the walk stops when the server's own
 * `total` is satisfied. Recomputing "how many items were there" from an array
 * length instead would let a capped walk look complete.
 */
async function walkPage<T>(
  responder: Responder,
  calls: RecordedCall[],
  path: string,
  params: Record<string, string> | undefined,
  offset: number,
): Promise<SpotifyPaged<T> | null> {
  const arg = { ...params, offset: String(offset) };
  calls.push({ method: 'GET', path, arg });
  return responder(path, arg) as SpotifyPaged<T> | null;
}

function makeStubClient(responder: Responder) {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return responder(path, params) as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return responder(path, body) as T | null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return responder(path, body) as T | null;
    },
    async putRaw(path: string, body: string): Promise<void> {
      calls.push({ method: 'PUT', path, arg: body });
      await responder(path, body);
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, arg: body });
      return responder(path, body) as T | null;
    },
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      const walk = await this.getAllPagesWithTruncation<T>(path, params, opts);
      return walk.items;
    },
    async getAllPagesWithTruncation<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<{ items: T[]; truncated: boolean }> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = [];
      let offset = 0;
      for (;;) {
        const page = await walkPage<T>(responder, calls, path, params, offset);
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) {
          return { items: all.slice(0, maxItems), truncated: all.length > maxItems };
        }
        const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return { items: all, truncated: false };
    },
  };
  return client;
}

interface HarnessOptions {
  responder?: Responder;
  /** 'none' models a host that never advertised elicitation. */
  elicitation?: 'accept' | 'decline' | 'none';
}

/**
 * `prompts` is ordered with the writes, so a test can assert the prompt came
 * BEFORE the first mutating call rather than merely that both happened.
 */
function harness(register: (server: McpServer, client: SpotifyClient) => void, options: HarnessOptions = {}) {
  const registered: RegisteredTool[] = [];
  const events: string[] = [];
  const elicitMode = options.elicitation ?? 'accept';
  const prompts: string[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
    registerTool(
      name: string,
      cfg: { description?: string; inputSchema?: z.ZodType },
      handler: RegisteredTool['handler'],
    ) {
      registered.push({ name, validate: (args) => (cfg.inputSchema as z.ZodType).parse(args), handler });
    },
    server: {
      getClientCapabilities: () => (elicitMode === 'none' ? {} : { elicitation: { form: {} } }),
      elicitInput: async (request: { message: string }) => {
        prompts.push(request.message);
        events.push('prompt');
        return elicitMode === 'decline'
          ? { action: 'decline' }
          : { action: 'accept', content: { confirm: true } };
      },
    },
  } as unknown as McpServer;
  const client = makeStubClient(options.responder ?? (() => null));
  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || !['post', 'put', 'putRaw', 'delete'].includes(String(prop))) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        events.push(`${String(prop).toUpperCase()} ${String(args[0])}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  register(fakeServer, wrapped as unknown as SpotifyClient);
  return {
    registered,
    client,
    events,
    prompts,
    invoke: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

/** The two record fields every one of the six must carry. */
function recordOf(out: ToolResult): { note: string; provenance: Record<string, unknown> } {
  const payload = out.structuredContent as Record<string, unknown>;
  assert.ok(payload, 'result must carry structuredContent');
  assert.equal(typeof payload.consent_note, 'string', 'consent_note must be a string');
  const provenance = payload.provenance as Record<string, unknown>;
  assert.ok(provenance && typeof provenance === 'object', 'provenance must be an object');
  return { note: payload.consent_note as string, provenance };
}

const consentOf = (out: ToolResult): Record<string, unknown> =>
  recordOf(out).provenance.consent as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATED = '2026-08-26T10:00:00.000Z';
const TAKEN_AT = '2026-08-20T08:30:00.000Z';
const EXPORTED_AT = '2026-08-15T12:00:00.000Z';

const ENV_KEYS = [
  'SPOTIFY_MCP_ALLOW_PATHS',
  'SPOTIFY_MCP_BACKUP_DIR',
  'SPOTIFY_MCP_SNAPSHOT_DIR',
  'SPOTIFY_MCP_PORTABILITY_DIR',
  'SPOTIFY_MCP_CONFIRM',
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = savedEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

/**
 * A scratch directory, opted into the read roots for the duration of the
 * call. Every fixture lives under mkdtemp and is removed afterwards; nothing
 * here reads or writes a real data dir.
 */
async function withStore<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'spotify-provenance-'));
  const prevAllow = process.env.SPOTIFY_MCP_ALLOW_PATHS;
  const prevBackup = process.env.SPOTIFY_MCP_BACKUP_DIR;
  const prevSnapshot = process.env.SPOTIFY_MCP_SNAPSHOT_DIR;
  const prevPortability = process.env.SPOTIFY_MCP_PORTABILITY_DIR;
  process.env.SPOTIFY_MCP_ALLOW_PATHS = prevAllow
    ? `${prevAllow}${delimiter}${dir}`
    : dir;
  process.env.SPOTIFY_MCP_BACKUP_DIR = dir;
  process.env.SPOTIFY_MCP_SNAPSHOT_DIR = dir;
  process.env.SPOTIFY_MCP_PORTABILITY_DIR = dir;
  try {
    return await run(dir);
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('SPOTIFY_MCP_ALLOW_PATHS', prevAllow);
    restore('SPOTIFY_MCP_BACKUP_DIR', prevBackup);
    restore('SPOTIFY_MCP_SNAPSHOT_DIR', prevSnapshot);
    restore('SPOTIFY_MCP_PORTABILITY_DIR', prevPortability);
    await rm(dir, { recursive: true, force: true });
  }
}

/** A library snapshot whose file declares when it was taken. */
function datedSnapshot() {
  return {
    _meta: { created: CREATED, counts: {} },
    liked_tracks: [
      { uri: 'spotify:track:aaa1', name: 'A', added_at: '2025-01-01' },
      { uri: 'spotify:track:bbb2', name: 'B', added_at: '2025-01-02' },
    ],
  };
}

/** The same snapshot with no `_meta` at all — a file predating the stamp. */
function undatedSnapshot() {
  return {
    liked_tracks: [
      { uri: 'spotify:track:aaa1', name: 'A', added_at: '2025-01-01' },
      { uri: 'spotify:track:bbb2', name: 'B', added_at: '2025-01-02' },
    ],
  };
}

/** A playlist snapshot row, in the shape `take_playlist_snapshot` writes. */
const snapRow = (n: number) => ({ uri: `spotify:track:pl${n}`, name: `Row ${n}` });

function playlistSnapshot(snapshotId: string, trackCount: number) {
  return {
    _meta: {
      snapshot_id: snapshotId,
      playlist_id: 'plLive1',
      taken_at: TAKEN_AT,
      track_count: trackCount,
    },
    tracks: Array.from({ length: trackCount }, (_, i) => snapRow(i + 1)),
  };
}

const livePage = (names: string[]) => ({
  items: names.map((name) => ({ uri: `spotify:track:live${name}`, name })),
  total: names.length,
  limit: 50,
  offset: 0,
});

/**
 * The `restore_library_snapshot` responder. `/me/library/contains` answers from
 * a set the PUT mutates, so a second restore genuinely finds its work done —
 * the same shape tests/tools.portability.test.ts uses.
 */
function libraryRestoreResponder(): Responder {
  const saved = new Set<string>();
  return (path, arg) => {
    if (path === '/me/library/contains') {
      const uris = String((arg as { uris?: string } | undefined)?.uris ?? '').split(',').filter(Boolean);
      return uris.map((u) => saved.has(u));
    }
    if (path === '/me/playlists') {
      return { items: [], total: 0, limit: 50, offset: 0 };
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// The enumeration (#708 covers six tools in five modules)
// ---------------------------------------------------------------------------

/**
 * The full set of tools that write Spotify state from locally stored Spotify
 * data. Every entry is exercised below; `tests/write-provenance.test.ts`'s
 * census test asserts the modules match this list exactly.
 *
 * DELIBERATELY NOT COVERED, and why:
 *  - `import_profile_state` and the other local-to-local tools: they move
 *    data between files and never touch the account, so there is no stored
 *    Spotify Content being used against it.
 *  - The playback sidecar tools (`apply_scene`, `refresh_smart_playlist`,
 *    `playlist_from_tags`, …): they read a locally stored device label, a
 *    volume or a smart-playlist rule. That is a local preference, not stored
 *    Spotify Content written back into the account, and several of them have
 *    no dry run — turning this issue into a gate on them would be a
 *    behavioural change, which #708 explicitly is not.
 */
const RECORDED_TOOLS: ReadonlyArray<{ tool: string; module: string }> = [
  { tool: 'restore_library_snapshot', module: 'restore.ts' },
  { tool: 'import_playlist', module: 'import.ts' },
  { tool: 'import_from_sidecar', module: 'portability.ts' },
  { tool: 'restore_playlist_from_snapshot', module: 'swarm3_snapshots.ts' },
  { tool: 'apply_snapshot_changes', module: 'swarm3_snapshots.ts' },
  { tool: 'playlist_clone_snapshot', module: 'swarm4_playlists.ts' },
];

describe('#708 enumeration', () => {
  it('records the record in exactly the modules that hold a local-data write', async () => {
    const dir = join(process.cwd(), 'src', 'tools');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    const expected = [...new Set(RECORDED_TOOLS.map((r) => r.module))].sort();
    // provenance.ts is where consentFields is DEFINED, so it is the one file
    // that names the function without passing the record to a result.
    const withRecord: string[] = [];
    for (const file of files) {
      if (file === 'provenance.ts') continue;
      const source = await readFile(join(dir, file), 'utf8');
      if (source.includes('consentFields(')) withRecord.push(file);
    }
    assert.deepEqual(withRecord.sort(), expected);
  });

  it('names six tools and no duplicates', () => {
    const names = RECORDED_TOOLS.map((r) => r.tool);
    assert.equal(names.length, 6);
    assert.equal(new Set(names).size, names.length);
  });
});

// ---------------------------------------------------------------------------
// restore_library_snapshot
// ---------------------------------------------------------------------------

describe('restore_library_snapshot records purpose and provenance', () => {
  it('a dry run names the source, the file-declared date, the count and the use', async () => {
    await withStore(async (dir) => {
      const path = join(dir, 'backup-2026-08-26-1.json');
      await writeFile(path, JSON.stringify(datedSnapshot()));
      const h = harness(registerRestoreTools, { responder: libraryRestoreResponder() });

      const out = await h.invoke('restore_library_snapshot', { backup_path: path });
      const { note, provenance } = recordOf(out);

      assert.equal(provenance.source_kind, 'library_snapshot');
      assert.equal(provenance.source_path, path);
      assert.equal(provenance.source_created, CREATED, 'the date is the file-declared _meta.created');
      assert.equal(provenance.source_created_field, '_meta.created');
      assert.equal(provenance.source_missing_date_reason, null);
      assert.equal(provenance.source_items, 2, 'rows the selected categories hold');
      assert.match(String(provenance.purpose), /additively/);
      assert.equal((provenance.consent as Record<string, unknown>).state, 'not_requested');
      assert.match(String((provenance.consent as Record<string, unknown>).because), /dry_run=true/);
      assert.match(note, new RegExp(CREATED));
      assert.match(note, new RegExp(`local file ${path.replace(/[.\\/]/g, '\\$&')}`));
      assert.match(note, /NO HUMAN WAS ASKED/);
    });
  });

  it('a file with no _meta reports no date and NAMES the reason — never the mtime', async () => {
    await withStore(async (dir) => {
      const path = join(dir, 'legacy-snapshot.json');
      await writeFile(path, JSON.stringify(undatedSnapshot()));
      const h = harness(registerRestoreTools, { responder: libraryRestoreResponder() });

      const out = await h.invoke('restore_library_snapshot', { backup_path: path });
      const { note, provenance } = recordOf(out);

      assert.equal(provenance.source_created, null, 'an undeclared date is null, not a guess');
      assert.equal(provenance.source_created_field, null);
      assert.match(String(provenance.source_missing_date_reason), /_meta\.created/);
      assert.match(note, /NOT STATED BY THE FILE/);
      assert.match(note, /_meta\.created/);
      // The literal string the tool used to print. If this comes back, some
      // code has started inventing a date instead of reporting its absence.
      assert.doesNotMatch(note, /unknown date/);
    });
  });

  it('the prompt shows the same facts the record stores (they cannot drift)', async () => {
    await withStore(async (dir) => {
      const path = join(dir, 'backup-2026-08-26-1.json');
      await writeFile(path, JSON.stringify(datedSnapshot()));
      const h = harness(registerRestoreTools, {
        responder: libraryRestoreResponder(),
        elicitation: 'accept',
      });

      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
      });

      assert.equal(h.prompts.length, 1, 'exactly one confirmation prompt');
      const prompt = h.prompts[0];
      const { note, provenance } = recordOf(out);
      assert.equal((provenance.consent as Record<string, unknown>).state, 'confirmed');
      // Every fact the human approved is present, verbatim, in what the audit
      // reads back.
      for (const fragment of [
        `local file ${path}`,
        CREATED,
        '2 item(s) in scope',
        String(provenance.purpose),
      ]) {
        assert.ok(prompt.includes(fragment), `prompt should contain ${fragment}`);
        assert.ok(note.includes(fragment), `record should contain ${fragment}`);
      }
      assert.match(prompt, /no other purpose/);
      // The write happened only after the prompt.
      assert.equal(h.events[0], 'prompt');
    });
  });

  it('SPOTIFY_MCP_CONFIRM=never is recorded as a bypass, never as a confirmation', async () => {
    await withStore(async (dir) => {
      process.env.SPOTIFY_MCP_CONFIRM = 'never';
      const path = join(dir, 'backup-2026-08-26-1.json');
      await writeFile(path, JSON.stringify(datedSnapshot()));
      const h = harness(registerRestoreTools, { responder: libraryRestoreResponder() });

      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
      });

      const consent = consentOf(out);
      assert.equal(consent.state, 'bypassed');
      assert.equal(consent.via, 'SPOTIFY_MCP_CONFIRM=never');
      assert.match(recordOf(out).note, /NO HUMAN WAS ASKED/);
      assert.equal(h.prompts.length, 0, 'the bypass issues no prompt');
    });
  });

  it('a declined prompt is recorded as declined, and nothing is written', async () => {
    await withStore(async (dir) => {
      const path = join(dir, 'backup-2026-08-26-1.json');
      await writeFile(path, JSON.stringify(datedSnapshot()));
      const h = harness(registerRestoreTools, {
        responder: libraryRestoreResponder(),
        elicitation: 'decline',
      });

      const out = await h.invoke('restore_library_snapshot', {
        backup_path: path,
        dry_run: false,
      });

      const consent = consentOf(out);
      assert.equal(consent.state, 'declined');
      assert.match(recordOf(out).note, /declined/);
      assert.equal(
        h.events.filter((e) => e.startsWith('PUT') || e.startsWith('POST')).length,
        0,
        'a declined restore writes nothing',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// import_playlist
// ---------------------------------------------------------------------------

const PLAYLIST_ID = '4uLU6hMCjMI75M1A2tKUQC';

function importResponder(): Responder {
  return (path) => (path === `/playlists/${PLAYLIST_ID}` ? { id: PLAYLIST_ID, name: 'Target' } : null);
}

const m3uOf = (n: number, start = 1) =>
  ['#EXTM3U', ...Array.from({ length: n }, (_, i) => `spotify:track:m3u${String(start + i).padStart(20, '0')}`)].join('\n');

describe('import_playlist records purpose and provenance', () => {
  it('names the file, says the format declares no date, and records the count', async () => {
    await withStore(async (dir) => {
      const path = join(dir, 'list.m3u');
      await writeFile(path, m3uOf(3));
      const h = harness(registerImportTools, { responder: importResponder() });

      const out = await h.invoke('import_playlist', {
        playlist_id: PLAYLIST_ID,
        input_path: path,
      });
      const { note, provenance } = recordOf(out);

      assert.equal(provenance.source_kind, 'import_document');
      assert.equal(provenance.source_path, path);
      assert.equal(provenance.source_created, null, 'M3U declares no creation date');
      assert.match(String(provenance.source_missing_date_reason), /M3U document format declares no creation date/);
      assert.equal(provenance.source_items, 3);
      assert.match(note, /NO HUMAN WAS ASKED/);
      assert.match(note, /under the 100-item confirmation threshold/);
    });
  });

  it('inline content records a null path, not the label "inline content" in a path field', async () => {
    const h = harness(registerImportTools, { responder: importResponder() });
    const out = await h.invoke('import_playlist', {
      playlist_id: PLAYLIST_ID,
      content: m3uOf(2),
    });
    const { note, provenance } = recordOf(out);
    assert.equal(
      provenance.source_path,
      null,
      'there is no file; the field typed as a path must say so rather than hold a label',
    );
    assert.match(note, /inline document \(no file on disk\)/);
    assert.equal(provenance.source_items, 2);
  });

  it('a gated import prompts with the source and the use, and records a confirmation', async () => {
    await withStore(async (dir) => {
      const path = join(dir, 'big.m3u');
      // 100 is BATCH_ADD_ELICIT_THRESHOLD, so this crosses the gate.
      await writeFile(path, m3uOf(100));
      const h = harness(registerImportTools, { responder: importResponder(), elicitation: 'accept' });

      const out = await h.invoke('import_playlist', {
        playlist_id: PLAYLIST_ID,
        input_path: path,
      });

      assert.equal(h.prompts.length, 1);
      const prompt = h.prompts[0];
      const { note, provenance } = recordOf(out);
      assert.equal((provenance.consent as Record<string, unknown>).state, 'confirmed');
      for (const fragment of [`local file ${path}`, '100 item(s) in scope', String(provenance.purpose)]) {
        assert.ok(prompt.includes(fragment), `prompt should contain ${fragment}`);
        assert.ok(note.includes(fragment), `record should contain ${fragment}`);
      }
      assert.equal(h.events[0], 'prompt', 'the prompt precedes the first POST');
    });
  });
});

// ---------------------------------------------------------------------------
// import_from_sidecar
// ---------------------------------------------------------------------------

describe('import_from_sidecar records purpose and provenance', () => {
  /** `/me/library/contains` answered from a set `PUT /me/library?uris=` mutates. */
  function libraryStub(): Responder {
    const saved = new Set<string>();
    return (path, arg) => {
      if (path === '/me/library/contains') {
        const list = String((arg as { uris?: string } | undefined)?.uris ?? '').split(',').filter(Boolean);
        return list.map((u) => saved.has(u));
      }
      if (path.startsWith('/me/library?uris=')) {
        for (const u of new URLSearchParams(path.slice('/me/library?'.length)).get('uris')!.split(',')) {
          saved.add(u);
        }
        return null;
      }
      return null;
    };
  }

  it('reads the exporter\'s own exported_at and records the no-gate case honestly', async () => {
    await withStore(async (dir) => {
      const path = join(dir, 'library.json');
      await writeFile(
        path,
        JSON.stringify({
          exported_at: EXPORTED_AT,
          tracks: [
            { uri: `spotify:track:${'a'.repeat(22)}` },
            { uri: `spotify:track:${'b'.repeat(22)}` },
          ],
        }),
      );
      const h = harness(registerPortabilityTools, { responder: libraryStub() });

      const out = await h.invoke('import_from_sidecar', { input_path: path, dry_run: false });
      const { note, provenance } = recordOf(out);

      assert.equal(provenance.source_kind, 'library_sidecar');
      assert.equal(provenance.source_path, path);
      assert.equal(provenance.source_created, EXPORTED_AT);
      assert.equal(provenance.source_created_field, 'exported_at');
      assert.equal(provenance.source_items, 2);
      assert.equal((provenance.consent as Record<string, unknown>).state, 'not_requested');
      assert.match(String((provenance.consent as Record<string, unknown>).because), /100-item confirmation threshold/);
      assert.match(note, new RegExp(EXPORTED_AT));
    });
  });

  it('a sidecar written by something else declares no date, and the record says which is missing', async () => {
    await withStore(async (dir) => {
      const path = join(dir, 'library.json');
      await writeFile(path, JSON.stringify({ tracks: [{ uri: `spotify:track:${'c'.repeat(22)}` }] }));
      const h = harness(registerPortabilityTools, { responder: libraryStub() });

      const out = await h.invoke('import_from_sidecar', { input_path: path, dry_run: false });
      const { note, provenance } = recordOf(out);

      assert.equal(provenance.source_created, null);
      assert.equal(provenance.source_created_field, null);
      assert.equal(provenance.source_missing_date_reason, "the file's exported_at is absent");
      assert.match(note, /NOT STATED BY THE FILE/);
    });
  });
});

// ---------------------------------------------------------------------------
// The ungated snapshot writers
// ---------------------------------------------------------------------------

describe('snapshot-driven writes record the absence of a gate rather than claiming consent', () => {
  it('restore_playlist_from_snapshot names the snapshot, its taken_at, and that nobody was asked', async () => {
    await withStore(async (dir) => {
      await writeFile(
        join(dir, 'plsnap-live01-2026-08-20-1.json'),
        JSON.stringify(playlistSnapshot('snapA', 3)),
      );
      const h = harness(registerSwarm3SnapshotsTools, {
        responder: (path) => {
          if (/^\/playlists\/plLive1$/.test(path)) return { id: 'plLive1', name: 'Live', items: [] };
          if (path === '/playlists/plLive1/items') return livePage([]);
          return null;
        },
      });

      const out = await h.invoke('restore_playlist_from_snapshot', {
        snapshot: 'plsnap-live01-2026-08-20-1.json',
        dry_run: false,
      });
      const { note, provenance } = recordOf(out);

      assert.equal(provenance.source_kind, 'playlist_snapshot');
      assert.match(String(provenance.source_path), /plsnap-live01-2026-08-20-1\.json$/);
      assert.equal(provenance.source_created, TAKEN_AT);
      assert.equal(provenance.source_items, 3);
      const consent = provenance.consent as Record<string, unknown>;
      assert.equal(consent.state, 'not_requested');
      assert.match(String(consent.because), /no confirmation/);
      assert.match(note, /NO HUMAN WAS ASKED/);
    });
  });

  it('apply_snapshot_changes records BOTH snapshot paths, not just the target state', async () => {
    await withStore(async (dir) => {
      await writeFile(join(dir, 'plsnap-live01-2026-08-20-1.json'), JSON.stringify(playlistSnapshot('snapOld', 1)));
      await writeFile(join(dir, 'plsnap-live01-2026-08-21-1.json'), JSON.stringify(playlistSnapshot('snapNew', 3)));
      const h = harness(registerSwarm3SnapshotsTools, {
        responder: (path) => {
          if (/^\/playlists\/plLive1$/.test(path)) return { id: 'plLive1', name: 'Live', items: [] };
          if (path === '/playlists/plLive1/items') return livePage([]);
          return null;
        },
      });

      const out = await h.invoke('apply_snapshot_changes', {
        from_snapshot: 'plsnap-live01-2026-08-20-1.json',
        to_snapshot: 'plsnap-live01-2026-08-21-1.json',
        dry_run: false,
      });
      const { note, provenance } = recordOf(out);

      assert.match(String(provenance.source_path), /2026-08-21-1\.json$/);
      const related = provenance.source_related_paths as string[];
      assert.equal(related.length, 1, 'a two-snapshot merge has two sources and both must be named');
      assert.match(related[0], /2026-08-20-1\.json$/);
      assert.match(note, /2026-08-20-1\.json/);
      assert.match(note, /2026-08-21-1\.json/);
      assert.equal((provenance.consent as Record<string, unknown>).state, 'not_requested');
    });
  });

  it('playlist_clone_snapshot names the library backup and its _meta.created', async () => {
    await withStore(async (dir) => {
      await writeFile(
        join(dir, 'backup-2026-08-26-1.json'),
        JSON.stringify({
          _meta: { created: CREATED },
          playlists: [
            { name: 'Archived', items: [{ uri: 'spotify:track:c1', name: 'C1' }] },
          ],
        }),
      );
      const h = harness(registerSwarm4PlaylistsTools, {
        responder: (path) => (path === '/me/playlists' ? { id: 'newPl1' } : null),
      });

      const out = await h.invoke('playlist_clone_snapshot', {
        backup_file: 'backup-2026-08-26-1.json',
        playlist_name: 'Archived',
        new_name: 'Archived (restored)',
        dry_run: false,
      });
      const { note, provenance } = recordOf(out);

      assert.equal(provenance.source_kind, 'library_snapshot');
      assert.match(String(provenance.source_path), /backup-2026-08-26-1\.json$/);
      assert.equal(provenance.source_created, CREATED);
      assert.equal(provenance.source_items, 1);
      assert.match(String((provenance.consent as Record<string, unknown>).because), /no confirmation/);
      assert.match(note, new RegExp(CREATED));
    });
  });
});

// ---------------------------------------------------------------------------
// The module itself
// ---------------------------------------------------------------------------

describe('provenance module', () => {
  const base = {
    source: {
      kind: 'library_snapshot' as const,
      path: '/tmp/x.json',
      items: 7,
      created: CREATED,
      created_field: '_meta.created',
    },
    purpose: 'write these rows back into the account',
  };

  const withConsent = (consent: WriteProvenance['consent']): WriteProvenance => ({ ...base, consent });

  it('renders the same facts in the prompt and in the note', () => {
    const p = withConsent({ state: 'confirmed' });
    const note = provenanceNote(p);
    for (const line of provenancePromptLines(p)) {
      // The prompt lays the same facts out across several lines; the note
      // carries the source and the date, so both must agree on them.
      if (line.startsWith('  date:')) assert.ok(note.includes(line.trim().slice('date: '.length)));
      if (line.startsWith('STORED')) assert.ok(note.includes('local file /tmp/x.json'));
      if (line.includes('item(s) in scope')) assert.ok(note.includes('7 item(s) in scope'));
    }
  });

  it('never says a human was asked when none was', () => {
    for (const consent of [
      { state: 'not_requested', because: 'under the threshold' },
      { state: 'bypassed', via: 'SPOTIFY_MCP_CONFIRM=never' },
    ] as const) {
      const note = provenanceNote(withConsent(consent));
      assert.match(note, /NO HUMAN WAS ASKED/);
      assert.doesNotMatch(note, /A human confirmed/);
    }
  });

  it('reads a declared date and names each way of not having one', () => {
    assert.deepEqual(declaredCreationDate({ created: CREATED }, 'created', '_meta.created'), {
      created: CREATED,
      created_field: '_meta.created',
    });
    assert.equal(declaredCreationDate(undefined, 'created', '_meta.created').created, null);
    assert.match(
      String((declaredCreationDate({}, 'created', '_meta.created') as { missing_date_reason: string }).missing_date_reason),
      /_meta\.created is absent/,
    );
    assert.match(
      String((declaredCreationDate({ created: 42 }, 'created', '_meta.created') as { missing_date_reason: string }).missing_date_reason),
      /not a date string/,
    );
  });

  it('distinguishes a refused unpromptable host from the SPOTIFY_MCP_CONFIRM=never bypass', () => {
    // Both present an 'unsupported' verdict. Only the refusal reason tells them
    // apart, and reading the environment instead would record a refused write
    // as an approved one.
    const refused = consentAfterGate('unsupported', {
      refusalReason: 'confirmation_unavailable',
      notRequestedBecause: '',
    });
    assert.equal(refused.state, 'not_requested');
    const bypassed = consentAfterGate('unsupported', {
      notRequestedBecause: '',
    });
    assert.equal(bypassed.state, 'bypassed');
  });
});
