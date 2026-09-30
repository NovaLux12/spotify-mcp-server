/**
 * Tests for MCP Tasks on the multi-minute operations (#600).
 *
 * ## What these tests are for
 *
 * The mechanism is easy to get plausible and hard to get true. A task handle
 * that comes back in milliseconds while a tool that walks a whole library does
 * minutes of work is exactly the shape that makes a background task *skip the
 * confirmation gate*: the handle is the answer to the original `tools/call`,
 * and every human-facing question after that point is asked over a
 * connection the client may already have dropped.
 *
 * So the gate is the centre of this file, not an afterthought. Each gated test
 * asserts THREE things and all three have to hold: the client was actually
 * asked, the writes did not happen, and the task's terminal status says the
 * work did not complete. A test that only checked the status would pass on a
 * server that wrote the rows and then apologised; a test that only checked the
 * writes would pass on one that left the task claiming success forever.
 *
 * ## Harness
 *
 * A real `McpServer`, the real `PersistentTaskStore`, the real
 * `applyTaskSupport` and the real `installToolErrorBoundary`, connected to a
 * real `Client` over `InMemoryTransport`. A hand-rolled stub would not do:
 * `tests/tools.confirm.test.ts` already records why a stub "passes" by never
 * being asked, and the whole point of the boundary is what it does when a
 * client does not advertise a capability.
 */
import './helpers/hermetic.js';

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  GetTaskResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { PersistentTaskStore, TASK_CAPABLE_TOOLS, applyTaskSupport, isTaskCapable } from '../src/tasks.ts';
import { confirmViaElicitation, refusalFor, requiredConfirmationRefusal } from '../src/tools/confirm.ts';
import { HERMETIC_ROOT } from './helpers/hermetic.ts';

// The token file has to exist before `src/client.ts` is imported, because the
// client's first request reads it. Set and written here, ahead of the dynamic
// import below, rather than as a top-level static import of the client.
const TOKEN_DIR = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-tokens-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = join(TOKEN_DIR, 'tokens.json');
writeFileSync(
  process.env.SPOTIFY_MCP_TOKEN_FILE,
  JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000 }),
  'utf8',
);
void HERMETIC_ROOT;

/** One task-capable name, used as the tool the harness registers. */
const GATED_TOOL = 'clean_all_playlists';

interface HarnessOptions {
  /** Omit the capability to model a client that cannot be prompted. */
  advertiseElicitation?: boolean;
  /** Answer the confirmation prompt, or throw to fail the exchange. */
  answer?: { action: 'accept' | 'decline' | 'cancel'; confirm?: boolean } | Error;
  /** How many playlists `/me/playlists` serves before running out. */
  playlistPages?: number;
}

/** Everything a test needs to observe, plus a task-aware client. */
/** The handle a task-augmented `tools/call` answers with. */
interface TaskHandle { taskId: string; status: string; statusMessage?: string }

interface Harness {
  client: Client;
  store: PersistentTaskStore;
  /** Every elicitation/create the client received, in order. */
  prompts: unknown[];
  /** Start a task for `GATED_TOOL` and return the handle. */
  startTask: (args?: Record<string, unknown>) => Promise<TaskHandle>;
  /** Call the tool the ordinary way, with no task field. */
  callSync: (args?: Record<string, unknown>) => Promise<CallToolResult>;
  getTask: (taskId: string) => Promise<{ status: string; statusMessage?: string }>;
  getResult: (taskId: string) => Promise<CallToolResult>;
  cancel: (taskId: string) => Promise<{ status: string }>;
  /** Poll `tasks/get` until terminal, or time out. */
  settle: (taskId: string, timeoutMs?: number) => Promise<{ status: string; statusMessage?: string }>;
  /**
   * Resolve once the detached run has actually finished, and return its result.
   *
   * Not the same as "the task is terminal": `tasks/cancel` sets the status to
   * `cancelled` the moment it arrives, while the work it stopped is still
   * unwinding. Asserting on request counts at that point races the run, and a
   * race is how a test ends up passing for the wrong reason — or failing for
   * one.
   *
   * The gate is the stored result, and deliberately not `store.runningCount`.
   * That counter is populated by `attach`, so a mutation which stops attaching
   * leaves it at 0 for the whole run: a gate built on it returns immediately
   * while the walk is still fetching, the page-count assertion that follows it
   * races and passes by luck, and the test then fails somewhere else entirely
   * on a timing-dependent `tasks/result` error — which is a failure any
   * unrelated bug would also produce. `storeTaskResult` runs only after `run`
   * resolves, so a readable result is a fact about the run rather than about
   * the bookkeeping, and it is blind to whether `attach` was called.
   */
  resultStored: (taskId: string, timeoutMs?: number) => Promise<CallToolResult>;
  /** The number of DELETE requests the client received. */
  deletes: () => number;
  /** The number of GET requests the client received. */
  gets: () => number;
  close: () => Promise<void>;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * A gated, task-capable tool wired the way production wires it.
 *
 * The handler is the shape the real bulk tools have: walk something that
 * spans pages, ask a human, then write. The walk goes through the INHERITED
 * `getAllPages`, so the cancellation check this file exercises is the real one
 * from `src/client.ts` and not a copy of it.
 */
async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const pages = opts.playlistPages ?? 4;
  const prompts: unknown[] = [];
  playlistTotal = pages * 5;
  pageSize = 5;

  // Per-harness baselines: two harnesses can share one test, and the counters
  // are process-wide because `fetch` is. Counting from zero would make the
  // second harness inherit the first one's writes.
  const baseGets = getCalls.length;
  const baseDeletes = deleteCalls.length;

  const spotify = new (await import('../src/client.ts')).SpotifyClient();
  const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-test-'));
  const store = new PersistentTaskStore(dir);

  const server = new McpServer(
    { name: 'tasks-test', version: '0.0.0' },
    { taskStore: store },
  );
  server.server.registerCapabilities({ tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } });

  server.registerTool(
    GATED_TOOL,
    {
      description: 'Test-only stand-in with the shape of a gated bulk operation.',
      inputSchema: z.object({ apply: z.boolean().optional() }),
    },
    async (args: { apply?: boolean }) => {
      // The REAL walk, over the REAL `get`, which is where the between-pages
      // cancellation boundary is enforced. A stubbed client would answer pages
      // without consulting the signal at all, and the cancel test would pass
      // for a reason that has nothing to do with the code under test.
      await spotify.getAllPages('/me/playlists', { limit: String(pageSize) });
      const verdict = await confirmViaElicitation(server, {
        message: 'About to rewrite 1 playlist(s). Proceed?',
        confirmLabel: 'Do it',
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) {
        return {
          content: [{ type: 'text' as const, text: refusal.message }],
          structuredContent: refusal.payload,
        };
      }
      if (args.apply === false) {
        return { content: [{ type: 'text' as const, text: 'dry run' }], structuredContent: { ok: true } };
      }
      await spotify.delete('/me/playlists/p0', {});
      return { content: [{ type: 'text' as const, text: 'removed 1 playlist' }], structuredContent: { ok: true } };
    },
  );

  // One non-capable tool, so "a tool that advertises no task support refuses
  // task augmentation" is a statement about the boundary rather than about a
  // tool that happens not to exist.
  server.registerTool(
    'get_playlist',
    { description: 'Test-only read.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text' as const, text: '[]' }], structuredContent: {} }),
  );

  applyTaskSupport(server);
  const { installToolErrorBoundary } = await import('../src/tools/annotations.ts');
  installToolErrorBoundary(server, { taskStore: store });

  const client = new Client(
    { name: 'tasks-test-client', version: '0.0.0' },
    opts.advertiseElicitation === false ? {} : { capabilities: { elicitation: { form: {} } } },
  );
  if (opts.advertiseElicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params);
      if (opts.answer instanceof Error) throw opts.answer;
      const answer = opts.answer ?? { action: 'accept' as const, confirm: true };
      return answer.action === 'accept'
        ? { action: answer.action, content: { confirm: answer.confirm ?? true } }
        : { action: answer.action };
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Built as a named binding rather than returned as an object literal so the
  // helpers below can call each other; an object literal's methods have no
  // reliable `this` when the object is the return value of an async function.
  const h: Harness = {
    client,
    store,
    prompts,
    startTask: async (args = {}) => {
      // `CallToolRequest` carries an optional `task`, but `Client.callTool`
      // types its params as the non-task shape, so the augmentation has to go
      // through a cast. The handle is then read back off a narrowed view: a
      // task-augmented call answers with `{ task }` and never with `content`,
      // and the assertion below is what proves the server took that branch.
      const res = await client.request(
        { method: 'tools/call', params: { name: GATED_TOOL, arguments: args, task: {} } },
        z.object({ task: z.object({ taskId: z.string(), status: z.string() }).passthrough() }).passthrough(),
      ) as { task?: TaskHandle };
      assert.ok(res.task, 'a task-augmented call must answer with a task handle, not a tool result');
      return res.task;
    },
    callSync: async (args = {}) => await client.callTool({ name: GATED_TOOL, arguments: args }) as CallToolResult,
    getTask: async (taskId) => {
      const res = await client.request({ method: 'tasks/get', params: { taskId } }, GetTaskResultSchema) as never as { status: string; statusMessage?: string };
      return { status: res.status, statusMessage: res.statusMessage };
    },
    getResult: async (taskId) => await client.request(
      { method: 'tasks/result', params: { taskId } },
      CallToolResultSchema,
    ) as never as CallToolResult,
    cancel: async (taskId) => await client.request(
      { method: 'tasks/cancel', params: { taskId } },
      GetTaskResultSchema,
    ) as never as { status: string },
    settle: async (taskId, timeoutMs = 5000) => await settleThrough(() => h.getTask(taskId), taskId, timeoutMs),
    resultStored: async (taskId, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          return await h.getResult(taskId);
        } catch (error) {
          lastError = error;
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      assert.fail(`the run stored no result within ${timeoutMs}ms; last error: ${String(lastError)}`);
    },
    deletes: () => deleteCalls.length - baseDeletes,
    gets: () => getCalls.length - baseGets,
    close: async () => {
      await Promise.all([client.close(), server.close()]);
    },
  };
  return h;
}

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

let getCalls: string[] = [];
let deleteCalls: string[] = [];
let playlistTotal = 20;
let pageSize = 5;
/**
 * Held open while set. The FIRST `/me/playlists` page of a test that wants to
 * cancel mid-walk parks here until the test releases it, so "the walk is in
 * flight when the cancel lands" is a fact the test establishes rather than a
 * race it hopes to win. A spin loop on the request count proved the opposite:
 * under a full-suite run the walk finished before the cancel was even sent, and
 * the test passed with the abort removed from the store.
 */
let firstPageGate: { promise: Promise<void>; release: () => void } | null = null;

function holdFirstPage(): { release: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  firstPageGate = { promise, release: () => open() };
  return { release: () => open() };
}
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  getCalls = [];
  deleteCalls = [];
  firstPageGate = null;
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const href = String(url);
    if (method === 'DELETE') {
      deleteCalls.push(href);
      return new Response(null, { status: 200 });
    }
    if (method !== 'GET') return jsonResponse({});
    getCalls.push(href);
    if (!href.includes('/me/playlists')) return jsonResponse({});
    const offset = Number(new URL(href).searchParams.get('offset') ?? 0) || 0;
    if (firstPageGate && offset === 0) {
      await firstPageGate.promise;
    }
    const items = Array.from(
      { length: Math.max(0, Math.min(pageSize, playlistTotal - offset)) },
      (_, i) => ({ id: `p${offset + i}`, name: `Playlist ${offset + i}`, tracks: { total: 0 } }),
    );
    return jsonResponse({
      items,
      total: playlistTotal,
      limit: pageSize,
      offset,
      next: offset + pageSize < playlistTotal ? `offset=${offset + pageSize}` : null,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

before(() => {
  assert.ok(process.env.SPOTIFY_MCP_TOKEN_FILE, 'the token file must be set before the client is imported');
});

after(() => {
  globalThis.fetch = realFetch;
});

/** Poll a task's status until it is terminal, or fail saying what it stayed at. */
async function settleThrough(
  read: () => Promise<{ status: string; statusMessage?: string }>,
  taskId: string,
  timeoutMs = 5000,
): Promise<{ status: string; statusMessage?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!TERMINAL.has(last.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
    last = await read();
  }
  assert.ok(TERMINAL.has(last.status), `task ${taskId} never reached a terminal state; last status ${last.status}`);
  return last;
}

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('#600 a task cannot be a way to skip the confirmation gate', () => {
  it('a client that cannot be prompted is refused, writes nothing, and the task does not report success', async () => {
    const h = await harness({ advertiseElicitation: false });
    try {
      const { taskId } = await h.startTask();
      const settled = await h.settle(taskId);

      // 1. The writes did not happen. This is the assertion the whole feature
      //    turns on: the tool is the one that does the deleting, and it was
      //    reached over a channel the client had already left.
      assert.equal(h.deletes(), 0, 'a task performed a write it was never confirmed for');

      // 2. It is not dressed up as success.
      assert.notEqual(settled.status, 'completed', 'an unprompted task reported completed');
      assert.equal(settled.status, 'failed', 'consent that was never established must read as failed, not cancelled');

      // 3. The task still answers, and says what happened, so `tasks/result`
      //    gives a reader the real reason rather than a store error.
      const result = await h.getResult(taskId);
      assert.match(textOf(result), /nothing was changed/i);
    } finally {
      await h.close();
    }
  });

  it('a client that declines is refused, writes nothing, and the task reads as cancelled', async () => {
    const h = await harness({ answer: { action: 'decline' } });
    try {
      const { taskId } = await h.startTask();
      const settled = await h.settle(taskId);

      assert.equal(h.prompts.length, 1, 'the background run must still ask the human, not assume consent');
      assert.equal(h.deletes(), 0, 'a declined task still wrote');
      // "A human said no" and "we could not ask" are different facts and must
      // not collapse into one status.
      assert.equal(settled.status, 'cancelled');
    } finally {
      await h.close();
    }
  });

  it('a prompt that fails mid-flight is a refusal, not a proceed', async () => {
    const h = await harness({ answer: new Error('the client vanished') });
    try {
      const { taskId } = await h.startTask();
      const settled = await h.settle(taskId);
      assert.equal(h.deletes(), 0, 'a task whose prompt failed still wrote');
      assert.equal(settled.status, 'failed');
    } finally {
      await h.close();
    }
  });

  it('confirms and writes when the client does answer', async () => {
    // The other direction, and it matters: a gate that refuses everything is
    // as broken as one that prompts in name only.
    const h = await harness({ answer: { action: 'accept', confirm: true } });
    try {
      const { taskId } = await h.startTask();
      const settled = await h.settle(taskId);
      assert.equal(settled.status, 'completed');
      assert.equal(h.deletes(), 1);
    } finally {
      await h.close();
    }
  });

  it('SPOTIFY_MCP_CONFIRM=never still bypasses, and only for the exact value', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const h = await harness({ advertiseElicitation: false });
    try {
      const { taskId } = await h.startTask();
      const settled = await h.settle(taskId);
      assert.equal(settled.status, 'completed', 'the sanctioned automation bypass stopped working');
      assert.equal(h.deletes(), 1);
    } finally {
      await h.close();
    }

    process.env.SPOTIFY_MCP_CONFIRM = 'yes-please';
    const strict = await harness({ advertiseElicitation: false });
    try {
      const { taskId } = await strict.startTask();
      const settled = await strict.settle(taskId);
      assert.equal(settled.status, 'failed', 'a near-miss value bypassed the gate');
      assert.equal(strict.deletes(), 0);
    } finally {
      await strict.close();
    }
  });

  it('the synchronous path is unchanged: it still prompts, and it still writes', async () => {
    // The task path is an addition. If a client sends no `task` field it must
    // get exactly what it got before, elicitation included — which is the
    // property that lets `taskSupport` be 'optional' rather than 'required'.
    const h = await harness();
    try {
      const result = await h.callSync();
      assert.equal(h.prompts.length, 1);
      assert.equal(h.deletes(), 1);
      assert.equal(result.isError, undefined);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

describe('#600 a task handle comes back before the work is done', () => {
  it('answers with a handle, not a result, and only a task-capable tool gets one', async () => {
    const h = await harness();
    try {
      const { taskId, status } = await h.startTask();
      assert.ok(taskId, 'no taskId in the handle');
      // The handle is what makes the multi-minute case work, so it must not
      // wait for the work. `working` is the state the SDK hands back.
      assert.ok(['working', 'input_required', 'completed'].includes(status), `unexpected initial status ${status}`);
      await h.settle(taskId);
    } finally {
      await h.close();
    }
  });

  it('refuses task augmentation on a tool that advertises none', async () => {
    const h = await harness();
    try {
      // A THROWN refusal, not a returned one: the SDK validates any response
      // to a `task`-carrying request against `CreateTaskResultSchema`, so a
      // CallToolResult refusal would be replaced by an opaque -32602 before
      // the client ever read the sentence explaining it.
      await assert.rejects(
        () => h.client.callTool({ name: 'get_playlist', arguments: {}, task: {} } as never),
        /does not support MCP tasks/,
        'a non-capable tool ran a task-augmented call instead of refusing',
      );
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('#600 tasks/cancel stops the work', () => {
  it('stops issuing requests at the next page boundary and reports cancelled', async () => {
    // The first page is held open, so the walk is provably mid-flight when the
    // cancel is sent. Everything after that is a fact about the run, not a
    // race: the page in flight completes, and the next one is either requested
    // or it is not.
    const h = await harness({ playlistPages: 8 });
    try {
      const gate = holdFirstPage();
      const { taskId } = await h.startTask();
      while (h.gets() < 1) await new Promise((r) => setTimeout(r, 1));

      const cancelled = await h.cancel(taskId);
      assert.equal(cancelled.status, 'cancelled', 'tasks/cancel did not report the cancellation');
      gate.release();

      const settled = await h.settle(taskId);
      assert.equal(settled.status, 'cancelled', 'a cancelled task did not say so');
      assert.notEqual(settled.status, 'completed');

      // Wait for the run to END before counting requests. `tasks/cancel`
      // already made the task terminal; the work it stopped is still going.
      // The gate is the stored result, so it holds whether or not the run ever
      // attached a controller — see `resultStored`.
      await h.resultStored(taskId);
      assert.equal(h.gets(), 1, `the walk requested a second page after the cancel (${h.gets()} pages fetched)`);
      assert.equal(h.deletes(), 0, 'a cancelled task went on to write');
      assert.match(textOf(await h.getResult(taskId)), /stopped partway|cancel/i);
    } finally {
      await h.close();
    }
  });

  it('a task already cancelled before it starts does no work at all', async () => {
    // The race this covers: the client learns the task id from the first
    // response and can answer `tasks/cancel` before the server has scheduled
    // anything. Attaching to a cancelled record must not start the work.
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-race-'));
    const store = new PersistentTaskStore(dir);
    try {
      const task = await store.createTask({}, 'req-1', { id: 'req-1', params: { name: GATED_TOOL } });
      await store.updateTaskStatus(task.taskId, 'cancelled', 'Client cancelled task execution.');
      const signal = await store.attach(task.taskId);
      assert.equal(signal.aborted, true, 'attaching to a cancelled task handed back a live signal');
    } finally {
      await store.detach('');
    }
  });
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

describe('#600 task state survives a restart', () => {
  it('a finished task is still readable by the next process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-durable-'));
    const first = new PersistentTaskStore(dir);
    const task = await first.createTask({}, 'req-1', { id: 'req-1', params: { name: 'backup_library' } });
    await first.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'snapshot written' }],
    });

    // A brand new store object over the same directory is what the next
    // process gets; InMemoryTaskStore would have answered null here.
    const second = new PersistentTaskStore(dir);
    const reloaded = await second.getTask(task.taskId);
    assert.equal(reloaded?.status, 'completed');
    const result = await second.getTaskResult(task.taskId);
    assert.match(textOf(result as CallToolResult), /snapshot written/);
  });

  it('a task interrupted by the restart is failed with the reason, never carried forward as working', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-interrupted-'));
    const first = new PersistentTaskStore(dir);
    const task = await first.createTask({}, 'req-1', { id: 'req-1', params: { name: 'clean_all_playlists' } });
    // The process dies here: the record on disk still says `working`.

    const second = new PersistentTaskStore(dir);
    const reloaded = await second.getTask(task.taskId);
    assert.equal(reloaded?.status, 'failed', 'a task with no process behind it is still reported as in flight');
    assert.match(reloaded?.statusMessage ?? '', /restart/i);
    assert.match(reloaded?.statusMessage ?? '', /will not resume/i);
    // Naming the tool is what makes the message a diagnosis rather than a
    // shrug, so the reconciliation has to know which operation it lost.
    assert.match(reloaded?.statusMessage ?? '', /clean_all_playlists/);
  });

  it('asks for a result a task never produced and is told which state it is in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-noresult-'));
    const store = new PersistentTaskStore(dir);
    const task = await store.createTask({}, 'req-1', { id: 'req-1', params: { name: 'backup_library' } });
    await assert.rejects(
      () => store.getTaskResult(task.taskId),
      /working/,
      'a task with no result answered with a bare failure instead of naming its state',
    );
  });
});

// ---------------------------------------------------------------------------
// The destructive half, behind a guard
// ---------------------------------------------------------------------------

describe('#1635 constructing the store cannot settle a real home', () => {
  /**
   * A record in each of the three states `reconcile()` acts on: unparseable
   * (renamed to `.corrupt`), in-flight (rewritten to `failed`), and terminal
   * past its TTL (deleted). One fixture covers all three because the claim
   * under test is about the *record set*, not about one code path.
   */
  function seedRealHomeStore(dir: string): { corrupt: string; working: string; expired: string } {
    const files = {
      corrupt: join(dir, 'corrupt.json'),
      working: join(dir, 'working.json'),
      expired: join(dir, 'expired.json'),
    };
    writeFileSync(files.corrupt, '{ this is not json', 'utf8');
    writeFileSync(
      files.working,
      JSON.stringify({
        task: { taskId: 'working', status: 'working', toolName: 'backup_library', createdAt: new Date().toISOString(), ttl: null },
        toolName: 'backup_library',
        requestId: 'req-1',
      }),
      'utf8',
    );
    writeFileSync(
      files.expired,
      JSON.stringify({
        task: {
          taskId: 'expired',
          status: 'completed',
          toolName: 'backup_library',
          // An hour old against a one-second TTL: terminal and past it.
          createdAt: new Date(Date.now() - 3_600_000).toISOString(),
          ttl: 1000,
        },
        toolName: 'backup_library',
        requestId: 'req-1',
      }),
      'utf8',
    );
    return files;
  }

  /**
   * Construct a store in a child process whose `HOME` is `dirname(dirname(dir))`,
   * so the store really does resolve under that process's own home, and report
   * what the constructor did.
   *
   * The child inherits no `SPOTIFY_MCP_ALLOW_REAL_HOME_STORES` from this
   * process: the fixture takes it as an argument and sets or deletes it
   * itself, so a test that has just set the variable in-process cannot leak
   * into the case that must refuse.
   */
  function runChild(dir: string, optOut: string, home?: string, useDefault = false): {
    files: string[];
    quarantined: string[];
    workingStatus: string | null;
    warnings: string[];
  } {
    // `home` defaults to the home the store would default to, so the common
    // case needs no argument. `useDefault` asks the child to construct the
    // store WITHOUT naming a directory — the refusal path, because naming one
    // is itself a claim and a claimed store reconciles.
    const childHome = home ?? dirname(dirname(dir));
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        new URL('./fixtures/task-store-reconcile-child.ts', import.meta.url).pathname,
        dir,
        optOut,
        ...(useDefault ? ['default'] : []),
      ],
      { encoding: 'utf8', env: { ...process.env, HOME: childHome, USERPROFILE: childHome }, stdio: 'pipe' },
    );
    return JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
      files: string[];
      quarantined: string[];
      workingStatus: string | null;
      warnings: string[];
    };
  }

  it('leaves every record alone when the store defaults into a home it does not own', () => {
    // The reported case, exactly: a script imports server code, constructs the
    // store, and the store resolves `tasksDir()` — a real `~/.spotify-mcp/
    // tasks`. A `working` record is work that "is not running and will never
    // resume", true of a real restart and not something an unrelated process
    // gets to decide.
    //
    // The child constructs the store WITHOUT naming a directory, because
    // naming one is itself a claim and a claimed store reconciles. That is the
    // shape `src/server.ts` takes on every `buildMcpServer`.
    const home = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-home-'));
    const dir = join(home, '.spotify-mcp', 'tasks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    seedRealHomeStore(dir);
    try {
      const report = runChild(dir, '-', home, true);

      // None of the three destructive outcomes may have happened.
      assert.deepEqual(report.quarantined, [], 'an unparseable record must not be renamed to .corrupt');
      assert.ok(report.files.includes('corrupt.json'), 'the unparseable record must still be where it was');
      assert.ok(report.files.includes('expired.json'), 'a terminal record past its TTL must not be dropped');
      assert.equal(report.workingStatus, 'working', 'an in-flight record must survive, not be rewritten to failed');

      // Silent is the part that made this expensive: mkdirSync succeeding and
      // reconcile() finding nothing look identical to a healthy startup.
      assert.equal(report.warnings.length, 1, `expected exactly one warning, got ${report.warnings.length}`);
      assert.match(report.warnings[0], /left untouched/i);
      // The message has to be actionable, not a shrug.
      assert.match(report.warnings[0], /SPOTIFY_MCP_ALLOW_REAL_HOME_STORES=never/, 'the warning must name the opt-out');
      assert.match(report.warnings[0], new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'and name the path it declined to touch');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reconciles a real home when the caller opts in explicitly', () => {
    // The legitimate caller: a user running the server normally, who *does*
    // want the previous crash's records settled. The opt-out is the value
    // `never` and nothing else, mirroring `SPOTIFY_MCP_CONFIRM` in §5 of
    // AGENTS.md — a near-miss string must not silently re-arm the destructive
    // default.
    //
    // Same store, same home, default path — the two arms differ by one
    // environment variable and nothing else.
    const home = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-optin-'));
    const dir = join(home, '.spotify-mcp', 'tasks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    seedRealHomeStore(dir);
    try {
      const report = runChild(dir, 'never', home, true);
      assert.deepEqual(report.quarantined, ['corrupt.json.corrupt'], 'an opted-in store does quarantine an unparseable record');
      assert.ok(!report.files.includes('expired.json'), 'and does drop a terminal record past its TTL');
      assert.equal(report.workingStatus, 'failed', 'and does settle an in-flight record as failed');
      assert.deepEqual(report.warnings, [], 'and does so without complaining about it');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reconciles when the caller NAMES the store, with no opt-out', () => {
    // The other claim. A caller that passes a directory has chosen it — a test
    // fixture, a container layout, an operator who set SPOTIFY_MCP_DATA_DIR —
    // and is entitled to have its records settled. The existing
    // restart-durability suite depends on this and is the reason the guard
    // asks about the claim rather than about the path.
    const home = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-claimed-'));
    const dir = join(home, 'chosen-store');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    seedRealHomeStore(dir);
    try {
      const report = runChild(dir, '-', home, false);
      assert.deepEqual(report.quarantined, ['corrupt.json.corrupt'], 'a named store reconciles as it always did');
      assert.ok(!report.files.includes('expired.json'));
      assert.deepEqual(report.warnings, [], 'and does not warn about a store the caller claimed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a near-miss opt-out value does not re-arm the destructive default', () => {
    // 'always', 'yes' and '1' are all plausible things for a caller to write.
    // None of them is the documented value, so none may arm it — a gate that
    // accepts a near-miss is a gate whose failure mode is a surprise on a
    // user's real records.
    const home = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-nearmiss-'));
    const dir = join(home, '.spotify-mcp', 'tasks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      for (const value of ['always', 'yes', '1', 'NEVER', 'never ', '']) {
        seedRealHomeStore(dir);
        const report = runChild(dir, value, home, true);
        assert.deepEqual(
          report.quarantined,
          [],
          `"${value}" must not be accepted as the opt-out; only the exact value "never" is`,
        );
        assert.equal(report.workingStatus, 'working', `and "${value}" must leave the in-flight record alone`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reconciles the DEFAULT store path when HOME has been redirected', () => {
    // The case that matters most and the one an earlier draft of this test got
    // wrong. It constructed the store in a bare `mkdtemp` directory, which is
    // merely *a* non-home path — so it proved "not under a home reconciles",
    // not "under a REDIRECTED home reconciles". A regression that broke the
    // guard specifically for a sandboxed HOME — the hermetic suite, every
    // container, every CI sandbox — would have sailed past it.
    //
    // So this redirects HOME for real, in a child, and asks for the store at
    // its default location rather than passing one in. That is precisely what
    // `src/server.ts` does on every `buildMcpServer`.
    const home = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-redirect-'));
    const dir = join(home, '.spotify-mcp', 'tasks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    seedRealHomeStore(dir);
    try {
      const report = runChild(dir, '-');
      // Redirected home, so the guard treats it as a sandbox and reconciles —
      // the same as before the fix, and the behaviour every test in this
      // repository depends on.
      assert.deepEqual(report.quarantined, ['corrupt.json.corrupt'], 'a redirected HOME must reconcile as it always did');
      assert.ok(!report.files.includes('expired.json'), 'and drop a terminal record past its TTL');
      assert.equal(report.workingStatus, 'failed', 'and settle an in-flight record');
      assert.deepEqual(report.warnings, [], 'and not warn about a store it legitimately owns');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still creates the directory, with its mode, when it refuses to reconcile', () => {
    // The guard is on the destructive half only. A first run against a home
    // that has no `tasks/` directory yet must still work, and the directory
    // must still be owner-only — `mkdirSync`/`chmodSync` run before the check.
    // Without this, "refuse to touch records" could quietly degrade into
    // "refuse to work".
    const home = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-mkdir-'));
    const dir = join(home, '.spotify-mcp', 'tasks');
    try {
      const store = new PersistentTaskStore(dir);
      assert.ok(existsSync(dir), 'the store directory is created even when the reconcile is refused');
      assert.equal(store.recordPath('x'), join(dir, 'x.json'), 'and the store is usable against it');
      // 0o700, and only meaningful on POSIX — the same guard `src/auth.ts`
      // applies around its own chmod calls.
      if (process.platform !== 'win32') {
        assert.equal(statSync(dir).mode & 0o777, 0o700, 'the directory is still owner-only');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Honesty about what happened
// ---------------------------------------------------------------------------

describe('#600 a task reports what actually happened', () => {
  it('a run that throws is failed, with the reason, and is never completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-throw-'));
    const store = new PersistentTaskStore(dir);
    const { startTask } = await import('../src/tasks.ts');
    const task = await startTask({
      args: {},
      extra: {},
      request: { id: 'req-1', params: { name: 'backup_library' } },
      taskParams: {},
      store,
      run: async () => { throw new Error('rate limit after 3 pages'); },
    });
    const { taskId } = task.task;
    const settled = await settleThrough(async () => {
      const { tasks } = await store.listTasks();
      return tasks[0] ?? { status: 'working' };
    }, taskId);
    assert.equal(settled.status, 'failed');
    assert.match(settled.statusMessage ?? '', /rate limit after 3 pages/);
  });

  it('a run that returns an error result is failed, not completed', async () => {
    // The #803 shape, at the level the task store can see: the handler came
    // back, and what it came back with was a failure.
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-errresult-'));
    const store = new PersistentTaskStore(dir);
    const { startTask } = await import('../src/tasks.ts');
    const task = await startTask({
      args: {},
      extra: {},
      request: { id: 'req-1', params: { name: 'backup_library' } },
      taskParams: {},
      store,
      run: async () => ({ content: [{ type: 'text', text: 'walk hit a malformed page' }], isError: true }),
    });
    const { taskId } = task.task;
    const settled = await settleThrough(async () => {
      const { tasks } = await store.listTasks();
      return tasks[0] ?? { status: 'working' };
    }, taskId);
    assert.equal(settled.status, 'failed');
    assert.match(settled.statusMessage ?? '', /malformed page/);
  });

  it('a run that finishes normally is completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-ok-'));
    const store = new PersistentTaskStore(dir);
    const { startTask } = await import('../src/tasks.ts');
    const task = await startTask({
      args: {},
      extra: {},
      request: { id: 'req-1', params: { name: 'backup_library' } },
      taskParams: {},
      store,
      run: async () => ({ content: [{ type: 'text', text: 'done' }], structuredContent: { ok: true } }),
    });
    const { taskId } = task.task;
    const settled = await settleThrough(async () => {
      const { tasks } = await store.listTasks();
      return tasks[0] ?? { status: 'working' };
    }, taskId);
    assert.equal(settled.status, 'completed');
  });

  it('capping the TTL is reported back, not silently applied', async () => {
    // The SDK says the store may override the requested TTL and that the value
    // actually in force is what the Task carries. Silently shortening a client's
    // requested lifetime is how a task disappears under a poller.
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-ttl-'));
    const store = new PersistentTaskStore(dir);
    const task = await store.createTask({ ttl: 90 * 24 * 60 * 60 * 1000 }, 'req-1', { id: 'req-1', params: { name: 'backup_library' } });
    assert.ok((task.ttl ?? 0) < 90 * 24 * 60 * 60 * 1000, 'the cap was applied but not reported back on the Task');
    assert.equal(typeof task.ttl, 'number');
  });
});

// ---------------------------------------------------------------------------
// The status, as distinct from the payload
// ---------------------------------------------------------------------------

describe('#600 a status is not completed just because a result came back', () => {
  // `src/result.ts` makes an absent `isError` mean `false` and most tools never
  // set it, so `isError` is NOT this server's failure signal. A handler that
  // did no work at all — a quota cooldown after any 429, an unreadable identity —
  // hands back `{ok: false}` with no `isError`, and the status is the only new
  // surface a client is invited to read. A stored payload stays honest and
  // stays fetchable either way; what was wrong was `completed` and `Finished.`
  // over a run that made zero requests.

  /** Start a task whose run resolves to exactly `result`, and settle it. */
  async function settleResult(
    prefix: string,
    tool: string,
    result: CallToolResult,
  ): Promise<{ status: string; statusMessage?: string; stored: CallToolResult }> {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const store = new PersistentTaskStore(dir);
    const { startTask } = await import('../src/tasks.ts');
    const task = await startTask({
      args: {},
      extra: {},
      request: { id: 'req-1', params: { name: tool } },
      taskParams: {},
      store,
      run: async () => result,
    });
    const { taskId } = task.task;
    const settled = await settleThrough(async () => {
      const { tasks } = await store.listTasks();
      return tasks[0] ?? { status: 'working' };
    }, taskId);
    return { ...settled, stored: await store.getTaskResult(taskId) as CallToolResult };
  }

  it('a quota-cooldown ok:false is failed, and the message is the tool\'s own words', async () => {
    // The shape `library_hygiene` and `find_duplicate_saved_tracks` return
    // whenever `quotaPreflight` blocks, which is after any 429.
    const { status, statusMessage, stored } = await settleResult(
      'spotify-mcp-tasks-cooldown-',
      'library_hygiene',
      {
        content: [{ type: 'text', text: 'Quota cooldown active — 412 album lookups were not attempted. Retry in 30s.' }],
        structuredContent: { ok: false, cooldown: true, wait_sec: 30, requests_made: 0, requests_planned: 412 },
      },
    );
    assert.equal(status, 'failed', 'a run that made zero requests reported completed');
    assert.match(statusMessage ?? '', /cooldown active/i, 'the status dropped the reason the tool gave');
    // The payload was always honest and must stay readable — this is about the
    // status, not about hiding the result from anyone who goes looking.
    assert.equal((stored.structuredContent as { requests_made?: number }).requests_made, 0);
  });

  it('an unreadable-identity ok:false is failed, with the tool\'s own words', async () => {
    // `export_all_playlists` with scope=owned, when `GET /me` will not read.
    const { status, statusMessage } = await settleResult(
      'spotify-mcp-tasks-identity-',
      'export_all_playlists',
      {
        content: [{ type: 'text', text: 'Refused to export with scope=owned: your user id could not be read. Nothing was exported.' }],
        structuredContent: {
          ok: false,
          error: 'GET /me could not be read (401)',
          scope_applied: false,
          total: 0,
          playlists_exported: 0,
        },
      },
    );
    assert.equal(status, 'failed', 'a run that exported nothing reported completed');
    assert.match(statusMessage ?? '', /user id could not be read/i);
  });

  it('a genuine refusal still reads as a refusal, and the ok:false arm does not eat it', async () => {
    // Both halves, built by the real guards rather than by hand, because the
    // two are different facts: a human said no, or consent was never
    // obtainable. `refusalOf` has to run before the general `ok: false` test,
    // or a decline — which is `ok: false` too — would be reported as a server
    // failure instead of as the human stopping it.
    const declined = refusalFor('declined');
    assert.ok(declined);
    const declineResult = await settleResult('spotify-mcp-tasks-declined-', 'clean_all_playlists', {
      content: [{ type: 'text', text: declined.message }],
      structuredContent: declined.payload,
    });
    assert.equal(declineResult.status, 'cancelled', 'a decline stopped reading as a decline');
    assert.match(declineResult.statusMessage ?? '', /declined/i);

    const unavailable = requiredConfirmationRefusal('unsupported');
    assert.ok(unavailable);
    const unavailableResult = await settleResult('spotify-mcp-tasks-unavailable-', 'clean_all_playlists', {
      content: [{ type: 'text', text: unavailable.message }],
      structuredContent: unavailable.payload,
    });
    assert.equal(unavailableResult.status, 'failed', 'consent never obtainable stopped reading as failed');
    // `Failed: <the tool's own words>`, because `storeTaskResult` runs
    // `describeTerminal`, which reads the refusal's own message. That is the
    // text a reader wants here: it names unavailability and says nothing was
    // changed, where a generic string would say neither.
    assert.match(unavailableResult.statusMessage ?? '', /^Failed: .*unavailable/i);
  });

  it('a real isError result still reads failed, with the Failed: prefix', async () => {
    const { status, statusMessage } = await settleResult('spotify-mcp-tasks-iserror-', 'backup_library', {
      content: [{ type: 'text', text: 'walk hit a malformed page' }],
      isError: true,
    });
    assert.equal(status, 'failed');
    assert.match(statusMessage ?? '', /^Failed: .*malformed page/);
  });

  it('a cancel that lands after the last write does not claim the run stopped partway', async () => {
    // The window: a human cancels, and the handler is already returning. The
    // stored result is `{ok: true, removed: 3, total: 3}` — the work finished.
    // `signal.aborted` is still true, so the status is `cancelled`, which is
    // right; the message claiming "the run stopped partway" is not, because the
    // run is the one thing that demonstrably did not stop partway.
    const dir = mkdtempSync(join(tmpdir(), 'spotify-mcp-tasks-late-cancel-'));
    const store = new PersistentTaskStore(dir);
    const { startTask } = await import('../src/tasks.ts');
    const task = await startTask({
      args: {},
      extra: {},
      request: { id: 'req-1', params: { name: 'clean_all_playlists' } },
      taskParams: {},
      store,
      run: async () => {
        // Stand in for the last write completing, then the cancel arriving
        // before the handler hands its result back.
        const { tasks } = await store.listTasks();
        await store.updateTaskStatus(tasks[0].taskId, 'cancelled', 'Client cancelled task execution.');
        return {
          content: [{ type: 'text', text: 'removed 3 of 3 playlists' }],
          structuredContent: { ok: true, removed: 3, total: 3 },
        };
      },
    });
    const { taskId } = task.task;
    const settled = await settleThrough(async () => {
      const { tasks } = await store.listTasks();
      return tasks[0] ?? { status: 'working' };
    }, taskId);
    assert.equal(settled.status, 'cancelled', 'a cancel was asked for, so the task is cancelled');
    assert.doesNotMatch(
      settled.statusMessage ?? '',
      /stopped partway/i,
      'the message claims a partial run over a stored result that says all 3 of 3 were removed',
    );
    assert.match(settled.statusMessage ?? '', /completed/i, 'the message does not say what the result shows');
    // The real result is still there for anyone who fetches it.
    const stored = await store.getTaskResult(taskId) as CallToolResult;
    assert.equal((stored.structuredContent as { total?: number }).total, 3);
  });
});

// ---------------------------------------------------------------------------
// The advertised surface
// ---------------------------------------------------------------------------

describe('#600 the advertised task surface is the real one', () => {
  it('every listed name exists, and nothing outside the list claims task support', async () => {
    // Registering a name that no module owns would be a silent no-op: the
    // stamp is skipped, no host is told, and the tool stays slow.
    const { SpotifyClient } = await import('../src/client.ts');
    const { registerManifestModules, applyToolAnnotations } = await import('../src/tools/annotations.ts');
    const server = new McpServer({ name: 'tasks-surface', version: '0.0.0' });
    await registerManifestModules(server, new SpotifyClient(), {
      readOnly: false,
      disableOverrides: new Set<string>(),
      isModuleActive: () => true,
      scopeBlocked: () => false,
    });
    applyToolAnnotations(server);
    const { stamped, unknown } = applyTaskSupport(server);

    assert.deepEqual(unknown, [], 'these task-capable names are not registered by any module');
    assert.equal(stamped, TASK_CAPABLE_TOOLS.length);

    const { installToolErrorBoundary } = await import('../src/tools/annotations.ts');
    installToolErrorBoundary(server);
    const client = new Client({ name: 'tasks-surface-client', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      // `taskSupport: 'forbidden'` is already on EVERY tool — `tool()` and
      // `registerTool()` both hard-code it — so the wire is full of it. What
      // must match the list exactly is the set that says tasks are supported.
      const advertised = tools
        .filter((t) => (t as { execution?: { taskSupport?: string } }).execution?.taskSupport === 'optional')
        .map((t) => t.name)
        .sort();
      assert.deepEqual(advertised, [...TASK_CAPABLE_TOOLS].sort(), 'tools/list and the task-capable list disagree');
      for (const tool of tools) {
        const support = (tool as { execution?: { taskSupport?: string } }).execution?.taskSupport;
        if (support !== 'optional') continue;
        // 'optional' is the whole reason existing hosts keep working. A
        // regression to 'required' would break every client that never
        // implemented the extension.
        assert.equal(support, 'optional', `${tool.name} advertises ${support}, which would break non-task hosts`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the server advertises the tasks capability it actually implements', async () => {
    const h = await harness();
    try {
      const caps = h.client.getServerCapabilities() as { tasks?: { list?: unknown; cancel?: unknown; requests?: { tools?: { call?: unknown } } } } | undefined;
      assert.ok(caps?.tasks, 'the server does not advertise the tasks capability it implements');
      assert.ok(caps.tasks.list, 'tasks/list is implemented but not advertised');
      assert.ok(caps.tasks.cancel, 'tasks/cancel is implemented but not advertised');
      assert.ok(caps.tasks.requests?.tools?.call, 'tools/call task creation is implemented but not advertised');
    } finally {
      await h.close();
    }
  });
});

describe('#600 isTaskCapable and the store agree with each other', () => {
  it('the predicate is a pure lookup over the exported list', () => {
    for (const name of TASK_CAPABLE_TOOLS) assert.equal(isTaskCapable(name), true, name);
    assert.equal(isTaskCapable('search'), false);
    assert.equal(isTaskCapable('get_playlist'), false);
  });

  it('the list is frozen, so a module cannot widen it at runtime', () => {
    assert.throws(() => {
      (TASK_CAPABLE_TOOLS as string[]).push('anything');
    });
  });
});

// ---------------------------------------------------------------------------

/** Concatenated text of a tool result. */
function textOf(result: CallToolResult): string {
  return (result.content as Array<{ type: string } & Record<string, unknown>>)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

// The refusal builders are imported for the record: this file asserts against
// the shape `requiredConfirmationRefusal` produces, so a change to it should
// fail here rather than silently turn every refusal into a success.
void refusalFor;
