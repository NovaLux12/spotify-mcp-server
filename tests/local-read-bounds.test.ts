/**
 * #623 — every local file read is validated and bounded.
 *
 * The server reads local documents from two directions: paths a CALLER names
 * (`input_path`, `backup_path`, `before_path`, `after_path`) and paths the
 * server derives for its own stores (tokens, sidecars, snapshots, receipts,
 * history, genre tags, the freshness watermark). Both directions are covered
 * here, against the three hazards the guard closes:
 *
 *   1. outside the allowed read roots — a `..` segment, an absolute path, or a
 *      symlink at any component must be REFUSED, never followed
 *   2. not a regular file — a directory, FIFO, socket or device must be
 *      refused; reading a FIFO blocks the serialized request queue forever
 *   3. over the size cap — an unbounded read exhausts memory, and an over-cap
 *      document is REFUSED, never truncated into a body that reads as complete
 *
 * Two properties are asserted repeatedly because they are the ones a blanket
 * "could not read" would destroy:
 *
 *   - the refusal NAMES which of the three hazards applied
 *   - the sync and async entry points make the same decisions (one guard, not
 *     two that can drift)
 *
 * Every fixture is created under mkdtemp and removed afterwards. No real
 * ~/.spotify-mcp file is read, written, or deleted by this suite.
 */

// Redirects HOME to a disposable temp root so the guard's default read roots
// resolve under a temp directory, not the real $HOME (#1274). Side effect only.
import './helpers/hermetic.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPortabilityTools } from '../src/tools/portability.js';
import { registerRestoreTools } from '../src/tools/restore.js';
import { loadSidecar } from '../src/sidecar.js';
import { readLocalFile, readLocalFileSync } from '../src/paths.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixtures — all under mkdtemp, all removed in afterEach
// ---------------------------------------------------------------------------

let root = '';

/** A second scratch dir, used as the "outside" side of an escape. */
let outside = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'w623-root-'));
  outside = await mkdtemp(join(tmpdir(), 'w623-outside-'));
});

afterEach(async () => {
  delete process.env.SPOTIFY_MCP_ALLOW_PATHS;
  delete process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB;
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Opt `root` in as an allowed read root for the duration of `run`. */
async function inRoot<T>(run: () => Promise<T>): Promise<T> {
  const prev = process.env.SPOTIFY_MCP_ALLOW_PATHS;
  process.env.SPOTIFY_MCP_ALLOW_PATHS = root;
  try {
    return await run();
  } finally {
    if (prev === undefined) delete process.env.SPOTIFY_MCP_ALLOW_PATHS;
    else process.env.SPOTIFY_MCP_ALLOW_PATHS = prev;
  }
}

const validDoc = { tracks: [{ uri: `spotify:track:${'a'.repeat(22)}` }] };

// ---------------------------------------------------------------------------
// Tool harness — the guard is asserted THROUGH the registered handlers, so a
// test cannot pass while a call site quietly bypasses it.
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; content: Array<{ text: string }> }>;
}

/** Minimal client: these reads are all local, so nothing here should be called. */
function stubClient() {
  const calls: string[] = [];
  const notCalled = (name: string) => (...args: unknown[]) => {
    calls.push(name);
    throw new Error(`stub client: ${name} must not be called for a refused local read`);
  };
  return {
    calls,
    client: {
      get: notCalled('get'),
      post: notCalled('post'),
      put: notCalled('put'),
      putRaw: notCalled('putRaw'),
      delete: notCalled('delete'),
      getAllPages: notCalled('getAllPages'),
      getAllPagesWithTruncation: notCalled('getAllPagesWithTruncation'),
    } as unknown as SpotifyClient,
  };
}

function harness() {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, cfg: { description?: string; inputSchema?: z.ZodType<Record<string, unknown>> }, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => (cfg.inputSchema as z.ZodType<Record<string, unknown>>).parse(a), handler });
    },
  } as unknown as McpServer;
  const { client, calls } = stubClient();
  registerPortabilityTools(fakeServer, client);
  registerRestoreTools(fakeServer, client);
  return {
    calls,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const t = registered.find((x) => x.name === name);
      assert.ok(t, `tool ${name} registered`);
      return t.handler(t.validate(args));
    },
  };
}

/** Assert a rejection whose message matches — and return the message. */
async function refuses(promise: Promise<unknown>, pattern: RegExp, what: string): Promise<string> {
  let message = '';
  await assert.rejects(
    promise,
    (err: Error) => {
      message = err.message;
      assert.match(message, pattern, `${what}: unexpected refusal message — ${message}`);
      return true;
    },
    `${what}: expected a refusal matching ${pattern}`,
  );
  return message;
}

// ===========================================================================
// HAZARD 1 — outside the allowed read roots
// ===========================================================================

describe('hazard 1: a path outside the allowed read roots is refused, not followed', () => {
  it('library_snapshot_diff refuses /etc/passwd on either side, naming the roots', async () => {
    const h = harness();
    const good = join(root, 'a.json');
    await writeFile(good, JSON.stringify(validDoc), 'utf8');

    const msg = await refuses(
      inRoot(() => h.invoke('library_snapshot_diff', { before_path: good, after_path: '/etc/passwd' })),
      /refusing to read outside the allowed read roots/,
      'after_path=/etc/passwd',
    );
    assert.ok(msg.includes(root), `refusal must name the allowed root, got: ${msg}`);

    await refuses(
      inRoot(() => h.invoke('library_snapshot_diff', { before_path: '/etc/passwd', after_path: good })),
      /refusing to read outside the allowed read roots/,
      'before_path=/etc/passwd',
    );
  });

  it('library_snapshot_diff refuses a .. escape that lands outside the root', async () => {
    const h = harness();
    const secret = join(outside, 'secret.json');
    await writeFile(secret, JSON.stringify({ tracks: [{ uri: 'spotify:track:leaked' }] }), 'utf8');
    const escape = join(root, '..', join(root.split('/').pop() as string, '..', join(outside.split('/').pop() as string), 'secret.json'));

    await refuses(
      inRoot(() => h.invoke('library_snapshot_diff', { before_path: escape, after_path: escape })),
      /refusing to read outside the allowed read roots/,
      '.. escape',
    );
  });

  it('library_snapshot_diff refuses a SYMLINK inside the root that points out of it', async () => {
    const h = harness();
    const secret = join(outside, 'secret.json');
    await writeFile(secret, JSON.stringify({ tracks: [{ uri: 'spotify:track:leaked' }] }), 'utf8');
    const link = join(root, 'looks-innocent.json');
    await symlink(secret, link);

    const msg = await refuses(
      inRoot(() => h.invoke('library_snapshot_diff', { before_path: link, after_path: link })),
      /refusing to read outside the allowed read roots/,
      'symlink escaping the root',
    );
    // The target path is named, so the operator can see WHERE it resolved to.
    assert.ok(msg.includes(secret), `refusal must name what it resolved to, got: ${msg}`);
  });

  it('import_profile_state refuses an input_path outside the roots', async () => {
    const h = harness();
    const stray = join(outside, 'archive.json');
    await writeFile(stray, JSON.stringify({ schema_version: 1, stores: {} }), 'utf8');
    await refuses(
      inRoot(() => h.invoke('import_profile_state', { input_path: stray, mode: 'merge' })),
      /import_profile_state: refusing to read outside the allowed read roots/,
      'import_profile_state outside roots',
    );
  });

  it('import_from_sidecar refuses an input_path outside the roots', async () => {
    const h = harness();
    const stray = join(outside, 'library.json');
    await writeFile(stray, JSON.stringify(validDoc), 'utf8');
    await refuses(
      inRoot(() => h.invoke('import_from_sidecar', { input_path: stray })),
      /import_from_sidecar: refusing to read outside the allowed read roots/,
      'import_from_sidecar outside roots',
    );
  });

  it('restore_library_snapshot refuses a backup_path outside the roots', async () => {
    const h = harness();
    const stray = join(outside, 'snapshot.json');
    await writeFile(stray, JSON.stringify({ _meta: {}, liked_tracks: [] }), 'utf8');
    await refuses(
      inRoot(() => h.invoke('restore_library_snapshot', { backup_path: stray, categories: ['liked_tracks'], dry_run: true })),
      /restore_library_snapshot: refusing to read outside the allowed read roots/,
      'restore_library_snapshot outside roots',
    );
  });

  it('a refusal is reached BEFORE any Spotify call, and the target is never parsed', async () => {
    const h = harness();
    const stray = join(outside, 'library.json');
    // Deliberately NOT valid JSON: if the guard ran after the read/parse, this
    // would surface as a parse error rather than a root refusal.
    await writeFile(stray, 'this is not json at all', 'utf8');
    await refuses(
      inRoot(() => h.invoke('import_from_sidecar', { input_path: stray })),
      /refusing to read outside the allowed read roots/,
      'root refusal precedes parsing',
    );
    assert.deepEqual(h.calls, [], 'no API call may be made for a refused local read');
  });

  it('a file INSIDE the root is still read (the guard is not simply refusing everything)', async () => {
    const h = harness();
    const a = join(root, 'before.json');
    const b = join(root, 'after.json');
    const uri = (c: string) => `spotify:track:${c.repeat(22)}`;
    await writeFile(a, JSON.stringify({ tracks: [{ uri: uri('a') }] }), 'utf8');
    await writeFile(b, JSON.stringify({ tracks: [{ uri: uri('b') }] }), 'utf8');
    const out = await inRoot(() => h.invoke('library_snapshot_diff', { before_path: a, after_path: b }));
    assert.equal(out.structuredContent?.added_count, 1);
    assert.equal(out.structuredContent?.removed_count, 1);
  });
});

// ===========================================================================
// HAZARD 2 — not a regular file
// ===========================================================================

describe('hazard 2: only regular files are read (a directory, FIFO, or device is refused)', () => {
  it('library_snapshot_diff refuses a directory by name instead of failing with EISDIR', async () => {
    const h = harness();
    const good = join(root, 'a.json');
    await writeFile(good, JSON.stringify(validDoc), 'utf8');
    const dir = join(root, 'not-a-file');
    await mkdir(dir);

    const msg = await refuses(
      inRoot(() => h.invoke('library_snapshot_diff', { before_path: good, after_path: dir })),
      /is a directory, not a regular file/,
      'directory',
    );
    assert.ok(msg.includes(dir), 'the refusal names what it refused', );
  });

  it('library_snapshot_diff refuses a FIFO rather than blocking the server on its first read', async () => {
    const h = harness();
    const good = join(root, 'a.json');
    await writeFile(good, JSON.stringify(validDoc), 'utf8');
    const fifo = join(root, 'pipe.json');
    await execFileAsync('mkfifo', [fifo]);
    assert.ok(lstatSync(fifo).isFIFO(), 'fixture really is a FIFO');

    // No writer is ever attached. If the tool opened the FIFO, this call would
    // hang until the test timeout instead of returning a refusal.
    await refuses(
      inRoot(() => h.invoke('library_snapshot_diff', { before_path: good, after_path: fifo })),
      /is a FIFO, not a regular file/,
      'FIFO',
    );
  });

  it('import_profile_state refuses a FIFO', async () => {
    const h = harness();
    const fifo = join(root, 'archive.json');
    await execFileAsync('mkfifo', [fifo]);
    await refuses(
      inRoot(() => h.invoke('import_profile_state', { input_path: fifo, mode: 'merge' })),
      /is a FIFO, not a regular file/,
      'import_profile_state FIFO',
    );
  });

  it('import_from_sidecar refuses a FIFO', async () => {
    const h = harness();
    const fifo = join(root, 'library.json');
    await execFileAsync('mkfifo', [fifo]);
    await refuses(
      inRoot(() => h.invoke('import_from_sidecar', { input_path: fifo })),
      /is a FIFO, not a regular file/,
      'import_from_sidecar FIFO',
    );
  });

  it('restore_library_snapshot refuses a FIFO', async () => {
    const h = harness();
    const fifo = join(root, 'snapshot.json');
    await execFileAsync('mkfifo', [fifo]);
    await refuses(
      inRoot(() => h.invoke('restore_library_snapshot', { backup_path: fifo, categories: ['liked_tracks'], dry_run: true })),
      /is a FIFO, not a regular file/,
      'restore_library_snapshot FIFO',
    );
  });

  it('the shared sidecar loader refuses a FIFO planted where a store belongs', async () => {
    // The server-derived direction: nothing in the call names this path, so the
    // guard is the only thing standing between a FIFO and an endless read.
    const fifo = join(root, 'search-history.json');
    await execFileAsync('mkfifo', [fifo]);
    await assert.rejects(
      loadSidecar(fifo, () => ({ ok: true }), (v: unknown) => v as { ok: boolean }),
      (err: Error) => {
        assert.match(err.message, /is a FIFO, not a regular file/);
        return true;
      },
    );
  });

  it('the shared sidecar loader reports WHICH hazard applied, not a bare errno', async () => {
    const fifo = join(root, 'store.json');
    await execFileAsync('mkfifo', [fifo]);
    await assert.rejects(
      loadSidecar(fifo, () => ({ ok: true }), (v: unknown) => v as { ok: boolean }),
      (err: Error) => {
        // The hazard is named; "read failed: undefined" or a blanket message
        // would tell the operator nothing about what to fix.
        assert.ok(!/read failed: undefined/.test(err.message), `errno-shaped message: ${err.message}`);
        assert.match(err.message, /FIFO/);
        return true;
      },
    );
  });
});

// ===========================================================================
// HAZARD 3 — over the size cap, refused rather than truncated
// ===========================================================================

describe('hazard 3: an over-cap document is refused, never truncated into a body that reads as complete', () => {
  /** ~1.8 MB of structurally valid snapshot JSON. */
  const oversized = () => {
    const rows = Array.from({ length: 40_000 }, (_, i) => ({ uri: `spotify:track:${String(i).padStart(22, '0')}` }));
    return JSON.stringify({ tracks: rows });
  };

  it('the over-cap fixture really is over the cap it is tested against', () => {
    // A fixture that quietly shrank below the ceiling would make every
    // over-cap case below pass for the wrong reason — nothing was refused
    // because nothing was oversized. Assert the premise, not the outcome.
    assert.ok(
      Buffer.byteLength(oversized(), 'utf8') > 1024 * 1024,
      'oversized() must exceed the 1 MB ceiling these tests set',
    );
  });

  it('library_snapshot_diff refuses an over-cap file and names the limit', async () => {
    const h = harness();
    const big = join(root, 'big.json');
    await writeFile(big, oversized(), 'utf8');
    const small = join(root, 'small.json');
    await writeFile(small, JSON.stringify(validDoc), 'utf8');
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';

    const msg = await refuses(
      inRoot(() => h.invoke('library_snapshot_diff', { before_path: big, after_path: small })),
      /over the 1048576-byte document limit/,
      'over-cap library_snapshot_diff',
    );
    assert.match(msg, /SPOTIFY_MCP_MAX_DOCUMENT_MB/, 'the message must be actionable');
  });

  it('an over-cap file yields NO counts at all — not a truncated, plausible-looking diff', async () => {
    const h = harness();
    const big = join(root, 'big.json');
    await writeFile(big, oversized(), 'utf8');
    const small = join(root, 'small.json');
    await writeFile(small, JSON.stringify(validDoc), 'utf8');
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';

    let payload: Record<string, unknown> | undefined;
    await assert.rejects(
      inRoot(async () => {
        const out = await h.invoke('library_snapshot_diff', { before_path: big, after_path: small });
        payload = out.structuredContent;
        return out;
      }),
      /over the .* document limit/,
    );
    // The #803 failure mode: a read that could not complete must not hand back
    // a value that reads as a complete one.
    assert.equal(payload, undefined, 'no partial diff may be returned for a refused read');
  });

  it('import_profile_state refuses an over-cap archive', async () => {
    const h = harness();
    const big = join(root, 'archive.json');
    await writeFile(big, JSON.stringify({ schema_version: 1, stores: { scenes: oversized() } }), 'utf8');
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    await refuses(
      inRoot(() => h.invoke('import_profile_state', { input_path: big, mode: 'merge' })),
      /over the 1048576-byte document limit/,
      'over-cap import_profile_state',
    );
  });

  it('import_from_sidecar refuses an over-cap sidecar', async () => {
    const h = harness();
    const big = join(root, 'library.json');
    await writeFile(big, oversized(), 'utf8');
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    await refuses(
      inRoot(() => h.invoke('import_from_sidecar', { input_path: big })),
      /over the 1048576-byte document limit/,
      'over-cap import_from_sidecar',
    );
  });

  it('restore_library_snapshot refuses an over-cap snapshot', async () => {
    const h = harness();
    const big = join(root, 'snapshot.json');
    await writeFile(big, oversized(), 'utf8');
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    await refuses(
      inRoot(() => h.invoke('restore_library_snapshot', { backup_path: big, categories: ['liked_tracks'], dry_run: true })),
      /over the 1048576-byte document limit/,
      'over-cap restore_library_snapshot',
    );
  });

  it('a file just under the cap is read normally (the cap is a limit, not a refusal)', async () => {
    const h = harness();
    const a = join(root, 'before.json');
    const b = join(root, 'after.json');
    await writeFile(a, JSON.stringify(validDoc), 'utf8');
    await writeFile(b, JSON.stringify(validDoc), 'utf8');
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    const out = await inRoot(() => h.invoke('library_snapshot_diff', { before_path: a, after_path: b }));
    assert.equal(out.structuredContent?.added_count, 0);
  });
});

// ===========================================================================
// The three refusals are DISTINGUISHABLE
// ===========================================================================

describe('a refusal names the actual reason — three hazards, three messages', () => {
  it('out-of-root, not-a-regular-file and over-the-cap do not collapse into one message', async () => {
    // out of root
    const stray = join(outside, 'x.json');
    await writeFile(stray, JSON.stringify(validDoc), 'utf8');
    const outsideMsg = await refuses(
      inRoot(() => readLocalFile({ roots: [root], tool: 't', target: stray })),
      /outside the allowed read roots/,
      'hazard 1',
    );

    // not a regular file
    const fifo = join(root, 'f.json');
    await execFileAsync('mkfifo', [fifo]);
    const typeMsg = await refuses(
      readLocalFile({ roots: [root], tool: 't', target: fifo }),
      /not a regular file/,
      'hazard 2',
    );

    // over the cap
    const big = join(root, 'b.json');
    await writeFile(big, 'x'.repeat(2 * 1024 * 1024), 'utf8');
    process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
    const capMsg = await refuses(
      readLocalFile({ roots: [root], tool: 't', target: big }),
      /over the .* document limit/,
      'hazard 3',
    );

    // A blanket "could not read" for three different failures is the bug this
    // issue is about, so the three messages must be genuinely different.
    assert.notEqual(outsideMsg, typeMsg);
    assert.notEqual(typeMsg, capMsg);
    assert.notEqual(outsideMsg, capMsg);
  });
});

// ===========================================================================
// One guard: the sync and async entry points agree
// ===========================================================================

describe('the sync and async paths make the same decisions', () => {
  const cases: Array<{ name: string; build: () => Promise<{ path: string }> }> = [
    {
      name: 'outside the roots',
      build: async () => {
        const stray = join(outside, 's.json');
        await writeFile(stray, 'x', 'utf8');
        return { path: stray };
      },
    },
    {
      name: 'a directory',
      build: async () => {
        const dir = join(root, 'd');
        await mkdir(dir);
        return { path: dir };
      },
    },
    {
      name: 'a FIFO',
      build: async () => {
        const fifo = join(root, 'p');
        await execFileAsync('mkfifo', [fifo]);
        return { path: fifo };
      },
    },
    {
      name: 'over the cap',
      build: async () => {
        const big = join(root, 'b');
        await writeFile(big, 'x'.repeat(2 * 1024 * 1024), 'utf8');
        return { path: big };
      },
    },
  ];

  for (const c of cases) {
    it(`both refuse ${c.name} with the same reason`, async () => {
      const { path } = await c.build();
      process.env.SPOTIFY_MCP_MAX_DOCUMENT_MB = '1';
      const opts = { roots: [root], tool: 't', target: path };
      let asyncMsg = '';
      await assert.rejects(readLocalFile(opts), (e: Error) => { asyncMsg = e.message; return true; });
      let syncMsg = '';
      assert.throws(() => readLocalFileSync(opts), (e: Error) => { syncMsg = e.message; return true; });
      assert.equal(syncMsg, asyncMsg, `sync and async disagree on ${c.name}`);
    });
  }

  it('both read an in-root file identically', async () => {
    const file = join(root, 'ok.json');
    await writeFile(file, 'hello', 'utf8');
    const opts = { roots: [root], tool: 't', target: file };
    assert.equal(await readLocalFile(opts), readLocalFileSync(opts));
  });
});

// ===========================================================================
// A missing file is still a first run, not a corruption
// ===========================================================================

describe('the guard does not turn a first run into an error', () => {
  it('an absent store is ENOENT, so loadSidecar still returns the empty value', async () => {
    const missing = join(root, 'never-written.json');
    const value = await loadSidecar(missing, () => ({ empty: true }), (v: unknown) => v as { empty: boolean });
    assert.deepEqual(value, { empty: true });
  });

  it('an absent caller path is a clean ENOENT refusal, not a root refusal', async () => {
    const h = harness();
    const missing = join(root, 'nope.json');
    await refuses(
      inRoot(() => h.invoke('import_from_sidecar', { input_path: missing })),
      /no readable file at/,
      'missing in-root path',
    );
  });
});
