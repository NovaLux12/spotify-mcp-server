/**
 * #658 — `undo_mutation`, `undo_last_mutation` and `verify_receipt` at the TOOL
 * level: arguments, receipt shape, `structuredContent`, and the failure modes.
 *
 * `tests/tools.undo.test.ts` already drives the direction inversion and the
 * confirmation gate, but it reaches the handlers through a bare Map and hands
 * them arguments directly, so the SCHEMA never runs. This file closes the rest:
 * every call goes `handler(validate(args))`, so an argument the tool does not
 * actually accept is rejected here rather than in production.
 *
 * The four cases that matter most for a receipt tool, because it is the surface
 * an agent trusts after a bulk mutation:
 *
 *   1. the happy path — the exact wire shape of the rollback;
 *   2. an id that was never issued;
 *   3. an id whose ledger entry has been EVICTED (the FIFO cap) — which must
 *      not resolve to a *different* mutation, and must not be reported as a
 *      verdict about whether the write landed;
 *   4. an undo that fails PARTWAY — the case where a receipt tool is most
 *      likely to lie, because "3 of 4 chunks deleted" is not "undone".
 *
 * Hermetic by construction: the receipt ledger is a real local store, so the
 * whole file runs with `SPOTIFY_MCP_RECEIPTS_DIR` pointed at an `mkdtemp`
 * directory and the persistence/TTL flags cleared. Nothing here can reach the
 * developer's `~/.spotify-mcp/`. No network, no port, no token file.
 *
 * KNOWN GAP, deliberately NOT ratified here: both undo tools declare
 * `response_format` in their schema but neither handler reads it — `json` mode
 * returns the same prose as `concise`, where SPEC's shared-controls section
 * promises "raw API payload as JSON text". No test below asserts anything about
 * `response_format`'s effect, because a passing assertion would enshrine the
 * mismatch. Reported to the maintainers rather than pinned.
 */
// Must precede every other import: this redirects HOME for the whole process,
// so anything resolved at module-load time sees the sandbox, not the real one.
import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import {
  __resetReceiptStoreForTests,
  getAllReceipts,
  isReceiptsPersistent,
  issueReceipt,
  MAX_RECEIPTS,
  receiptMissMessage,
  receiptsFilePath,
  verifyReceipt,
  type ReceiptClient,
} from '../src/receipts.js';
import { registerUndoTools } from '../src/tools/undo.js';
import {
  applyToolAnnotations,
  loadManifestRegistrars,
  registerManifestModule,
  REGISTRAR_MANIFEST,
} from '../src/tools/annotations.js';

// ---------------------------------------------------------------------------
// Ledger isolation
// ---------------------------------------------------------------------------

/**
 * The receipt store is a real, persisted, developer-owned local file. Point it
 * at a throwaway directory for this whole file and turn persistence OFF, so the
 * tests exercise the in-memory ledger and no code path can append to — or
 * rehydrate from — `~/.spotify-mcp/receipts.jsonl`.
 */
const ledgerDir: string = mkdtempSync(join(tmpdir(), 'undo-receipts-658-'));
const REAL_HOME_LEDGER = join(homedir(), '.spotify-mcp', 'receipts.jsonl');

before(() => {
  process.env.SPOTIFY_MCP_RECEIPTS_DIR = ledgerDir;
  delete process.env.SPOTIFY_MCP_RECEIPTS;
  delete process.env.SPOTIFY_MCP_HISTORY_DIR;
  delete process.env.SPOTIFY_MCP_RECEIPTS_TTL_HOURS;
});

after(() => {
  rmSync(ledgerDir, { recursive: true, force: true });
});

beforeEach(() => {
  // A fresh in-memory store per test: the FIFO scan, the eviction branch and
  // the "no new receipt was issued" assertions all read the whole ledger, so a
  // receipt left behind by a sibling test would make them measure nothing.
  __resetReceiptStoreForTests();
});

// ---------------------------------------------------------------------------
// Harness — a fake server whose tool()/registerTool() capture the registration
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  /** The tool's declared input shape, as the registrar passed it. */
  shape: z.ZodRawShape;
  validate: (args: unknown) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOutput>;
}

interface ToolOutput {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A stub server that records every registration as `{name, validate, handler}`
 * and nothing else. `validate` runs the tool's OWN declared schema, so an
 * argument the tool does not accept fails the call the way a host's would,
 * rather than being handed to a handler that ignores it.
 *
 * It carries the elicitation-capable inner host the confirmation gate resolves
 * (`server.server`, per #684) and records every prompt, so a test can assert
 * that a destructive rollback ASKED first. `canConfirm: false` models a client
 * that never advertised the capability — the gate must then refuse.
 */
function fakeServer(opts: { canConfirm?: boolean } = {}): {
  server: McpServer;
  tools: CapturedTool[];
  prompts: Array<{ message: string }>;
} {
  const tools: CapturedTool[] = [];
  const prompts: Array<{ message: string }> = [];
  const capture = (
    name: string,
    descriptionOrConfig: unknown,
    schemaOrHandler: unknown,
    maybeHandler?: unknown,
  ) => {
    // Two call shapes: tool(name, description, shape, handler) and
    // registerTool(name, config, handler).
    const handler = maybeHandler ?? schemaOrHandler;
    const shape = maybeHandler === undefined ? descriptionOrConfig : schemaOrHandler;
    const parse = maybeHandler === undefined
      ? (args: unknown) => args
      : (args: unknown) => z.object(shape as z.ZodRawShape).parse(args);
    tools.push({
      name,
      shape: (maybeHandler === undefined ? descriptionOrConfig : schemaOrHandler) as z.ZodRawShape,
      validate: parse,
      handler: handler as CapturedTool['handler'],
    });
    return { name };
  };
  const server = {
    tool: (name: string, description: string, shape: z.ZodRawShape, handler: CapturedTool['handler']) =>
      capture(name, description, shape, handler),
    registerTool: (name: string, config: { inputSchema?: z.ZodType }, handler: CapturedTool['handler']) =>
      capture(name, config, config.inputSchema, handler),
    server: opts.canConfirm === false
      ? undefined
      : {
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: async (request: { message: string }) => {
          prompts.push({ message: request.message });
          return { action: 'accept', content: { confirm: true } };
        },
      },
  } as unknown as McpServer;
  return { server, tools, prompts };
}

/** Invoke a captured tool exactly as a host would: validate, then handle. */
async function invoke(
  tools: CapturedTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutput> {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool "${name}" must be registered; got ${tools.map((t) => t.name).join(', ')}`);
  return tool.handler(tool.validate(args));
}

// ---------------------------------------------------------------------------
// Stub Spotify over a mutable account
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  arg?: unknown;
}

interface StubAccount {
  client: SpotifyClient;
  calls: RecordedCall[];
  saved: Set<string>;
  playlists: Record<string, string[]>;
}

function stubClient(): StubAccount {
  const calls: RecordedCall[] = [];
  const saved = new Set<string>();
  const playlists: Record<string, string[]> = {};
  /** Fails the Nth write of the given method, to model a mid-undo failure. */
  const faults = new Map<string, { at: number; seen: number; message: string }>();

  const playlistIdOf = (path: string): string | null => {
    const match = /^\/playlists\/([^/]+)\/items$/.exec(path);
    return match ? decodeURIComponent(match[1]!) : null;
  };
  const urisIn = (path: string): string[] =>
    (new URLSearchParams(path.split('?')[1] ?? '').get('uris') ?? '').split(',').filter(Boolean);

  const client = {
    // The receipt store is keyed by the acting account's token file (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    async get(path: string, params?: Record<string, string>): Promise<unknown> {
      calls.push({ method: 'GET', path, arg: params });
      if (path === '/me/library/contains') {
        return (params?.uris ?? '').split(',').filter(Boolean).map((uri) => saved.has(uri));
      }
      const id = playlistIdOf(path);
      if (id === null) return {}; // playlist_meta reads resolve
      playlists[id] ??= [];
      const offset = Number(params?.offset ?? '0');
      const limit = Number(params?.limit ?? '100');
      const page = playlists[id]!.slice(offset, offset + limit);
      return {
        items: page.map((uri) => ({ item: { uri } })),
        total: playlists[id]!.length,
        next: offset + limit < playlists[id]!.length ? 'more' : undefined,
      };
    },
    async post(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'POST', path, arg });
      const id = playlistIdOf(path);
      if (id !== null) {
        playlists[id] = [...(playlists[id] ?? []), ...stringList(arg, 'uris')];
      }
      return { snapshot_id: 'snap-post' };
    },
    async put(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'PUT', path, arg });
      for (const uri of urisIn(path)) saved.add(uri);
      return null;
    },
    async delete(path: string, arg?: unknown): Promise<unknown> {
      calls.push({ method: 'DELETE', path, arg });
      const fault = faults.get('DELETE');
      if (fault) {
        fault.seen += 1;
        if (fault.seen === fault.at) throw new Error(fault.message);
      }
      if (path.startsWith('/me/library?')) {
        for (const uri of urisIn(path)) saved.delete(uri);
        return null;
      }
      const id = playlistIdOf(path);
      if (id !== null) {
        playlists[id] = (playlists[id] ?? []).filter((uri) => !stringList(arg, 'tracks').includes(uri));
      }
      return { snapshot_id: 'snap-delete' };
    },
  } as unknown as SpotifyClient;

  return {
    client,
    calls,
    saved,
    playlists,
    // Exposed for the partial-failure test only.
    ...({ failDeleteAt: (at: number, message: string) => faults.set('DELETE', { at, seen: 0, message }) } as object),
  };
}

function stringList(body: unknown, key: string): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const writes = (calls: RecordedCall[]): RecordedCall[] => calls.filter((c) => c.method !== 'GET');
const textOf = (out: ToolOutput): string => out.content.map((c) => c.text).join('\n');
const track = (n: string) => `spotify:track:${n}`;

/** Both undo tools, registered on a fake server, over a stub account. */
function harness(account: StubAccount, opts: { canConfirm?: boolean } = {}) {
  const { server, tools, prompts } = fakeServer(opts);
  registerUndoTools(server, account.client);
  return { tools, prompts };
}

// ---------------------------------------------------------------------------
// verify_receipt — reached through the SHIPPED manifest wiring
// ---------------------------------------------------------------------------

/**
 * `registerVerifyReceiptTool` is a private function in `src/tools/annotations.ts`,
 * wired in through the manifest rather than exported. Loading the real manifest
 * row is the only way a test can reach the registration that actually ships, and
 * it costs no production change — which is what the issue asked for instead of
 * the inline `src/index.ts` handler it was written against.
 */
async function verifyReceiptTool(): Promise<CapturedTool> {
  const { server, tools } = fakeServer();
  const context = { readOnly: false, disableOverrides: new Set<string>(), isModuleActive: () => true, scopeBlocked: () => false };
  const module = REGISTRAR_MANIFEST.find((m) => m.key === 'receipts');
  assert.ok(module, 'the receipts module must be in the registrar manifest');
  for (const loaded of await loadManifestRegistrars([module], context)) {
    // A real client, not `undefined` (#1385): the receipt store is keyed by
    // client.tokenFile, so registering without one is now a hard failure rather
    // than a silent read of the default account's store.
    registerManifestModule(server, { tokenFile: DEFAULT_TOKEN_FILE } as unknown as SpotifyClient, loaded, context);
  }
  const tool = tools.find((t) => t.name === 'verify_receipt');
  assert.ok(tool, 'verify_receipt must be registered by the receipts manifest module');
  return tool;
}

/** A minimal read-only client — enough for `issueReceipt`'s verification walk. */
const readOnlyClient = (rows: (path: string, params?: Record<string, string>) => unknown): ReceiptClient => ({
  // Named account: the receipt store is keyed by it (#1385), so a stub that
  // declared none used to be filed under the default account.
  tokenFile: DEFAULT_TOKEN_FILE,
  async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
    return rows(path, params) as T | null;
  },
});

/** Fill the ledger past its FIFO cap and return the evicted id. */
async function overflowLedger(
  make: (index: number) => Promise<{ receipt_id: string }>,
  count = MAX_RECEIPTS + 1,
): Promise<{ firstId: string; lastId: string }> {
  const first = await make(0);
  for (let i = 1; i < count; i++) await make(i);
  const last = await make(count - 1);
  return { firstId: first.receipt_id, lastId: last.receipt_id };
}

// ===========================================================================

describe('#658 undo_mutation arguments and the happy path', () => {
  it('requires a receipt_id — the schema rejects a call that omits it', async () => {
    const account = stubClient();
    const { tools } = harness(account);
    // No `.catch(() => undefined)`: a schema failure must surface as a failure.
    assert.throws(
      () => tools.find((t) => t.name === 'undo_mutation')!.validate({}),
      /receipt_id/,
      'undo_mutation cannot run without the id of the receipt to invert',
    );
    assert.throws(
      () => tools.find((t) => t.name === 'undo_mutation')!.validate({ receipt_id: '' }),
      /receipt_id/,
      'an empty id is not an id',
    );
  });

  it('defaults dry_run to true in the declared schema, so a missing flag previews', async () => {
    const account = stubClient();
    account.saved.add(track('a'));
    const { tools } = harness(account);
    const undo = tools.find((t) => t.name === 'undo_mutation')!;

    const validated = undo.validate({ receipt_id: 'rcpt_abc-1' }) as Record<string, unknown>;
    assert.equal(validated.dry_run, true,
      'the schema must advertise the safe default, not just honour it in the handler');

    const receipt = await issueReceipt(readOnlyClient((path) =>
      (path === '/me/library/contains'
        ? (account.saved.has(track('a')) ? [true] : [false])
        : {})), { kind: 'library', uris: [track('a')], expectPresent: true });

    const out = await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id });
    assert.equal(out.structuredContent?.dry_run, true);
    assert.deepEqual(writes(account.calls), [], 'a default call writes nothing');
  });

  it('inverts a library save with one DELETE /me/library and reports the post-state', async () => {
    const account = stubClient();
    account.saved.add(track('a'));
    account.saved.add(track('b'));
    const { tools } = harness(account);

    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains'
        ? [track('a'), track('b')].map((u) => account.saved.has(u))
        : {}), { kind: 'library', uris: [track('a'), track('b')], expectPresent: true });
    assert.equal(receipt.direction, 'added', 'precondition: the receipt records an addition');

    const out = await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, true, textOf(out));
    assert.equal(out.structuredContent?.undone_receipt, receipt.receipt_id);
    assert.equal(out.structuredContent?.direction, 'added');
    assert.equal(out.structuredContent?.inverted_to, 'remove');
    assert.equal(out.structuredContent?.verified, true);
    assert.equal(out.structuredContent?.requests, 1);
    assert.deepEqual(out.structuredContent?.expected_absent, [track('a'), track('b')]);
    assert.deepEqual(out.structuredContent?.expected_present, [], 'nothing should remain expected');

    const wire = writes(account.calls);
    assert.deepEqual(wire.map((c) => `${c.method} ${c.path.split('?')[0]}`), ['DELETE /me/library']);
    assert.deepEqual(
      new URLSearchParams(wire[0]!.path.split('?')[1] ?? '').get('uris')?.split(',').sort(),
      [track('a'), track('b')].sort(),
      'the uris ride the query string, which is the form /me/library documents',
    );
    assert.equal(wire[0]!.arg, undefined, 'the unified library delete takes no request body');
    assert.equal(account.saved.size, 0, 'both rows really are gone');
  });

  it('issues a receipt for the post-state so the rollback is itself verifiable', async () => {
    const account = stubClient();
    account.saved.add(track('a'));
    const { tools } = harness(account);
    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains' ? [true] : {}),
    { kind: 'library', uris: [track('a')], expectPresent: true });

    const out = await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(out.structuredContent?.ok, true, textOf(out));

    const newReceipt = out.structuredContent?.receipt as { receipt_id?: string; verified?: boolean } | null;
    assert.ok(newReceipt?.receipt_id, 'the rollback hands back a receipt of its own');
    assert.equal(newReceipt.verified, true, 'and it is a VERIFIED one — the reads below confirm it');
    assert.equal(getAllReceipts(DEFAULT_TOKEN_FILE).length, 2, 'the ledger grew by exactly one entry');
  });
});

// ---------------------------------------------------------------------------

describe('#658 a destructive undo still asks before it deletes', () => {
  it('elicits confirmation on the execute path, and writes nothing until it is accepted', async () => {
    const account = stubClient();
    account.saved.add(track('a'));
    const { tools, prompts } = harness(account);
    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains' ? [true] : {}),
    { kind: 'library', uris: [track('a')], expectPresent: true });

    const out = await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, true, textOf(out));
    assert.equal(prompts.length, 1, 'the rollback must ask exactly once');
    assert.match(prompts[0]!.message, /undo mutation/);
    assert.match(prompts[0]!.message, /your library/,
      'the prompt must name the target the user is about to lose rows from');
    assert.equal(writes(account.calls).length, 1, 'and exactly one write follows the acceptance');
  });

  it('asks nothing on the dry-run preview — the preview itself changes nothing', async () => {
    const account = stubClient();
    account.saved.add(track('a'));
    const { tools, prompts } = harness(account);
    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains' ? [true] : {}),
    { kind: 'library', uris: [track('a')], expectPresent: true });

    const out = await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id });

    assert.equal(out.structuredContent?.dry_run, true);
    assert.equal(prompts.length, 0, 'a preview must not spend the user\'s attention on a prompt');
    assert.deepEqual(writes(account.calls), []);
  });

  it('refuses the rollback outright when the client cannot prompt, with dry_run: false set', async () => {
    const account = stubClient();
    account.saved.add(track('a'));
    const { tools } = harness(account, { canConfirm: false });
    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains' ? [true] : {}),
    { kind: 'library', uris: [track('a')], expectPresent: true });

    const out = await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'confirmation_unavailable',
      'an unanswerable prompt is a refusal, never a silent proceed');
    assert.deepEqual(writes(account.calls), [],
      'the point of the gate: the rollback is genuinely unissued, not merely reported as cancelled');
    assert.equal(account.saved.has(track('a')), true);
  });
});

// ---------------------------------------------------------------------------

describe('#658 undo_mutation misses: unknown and evicted receipt ids', () => {
  it('refuses an id that was never issued, and names it as a lookup failure', async () => {
    const account = stubClient();
    const { tools } = harness(account);
    const ghost = 'rcpt_zzzzzzzz-4242';

    assert.equal(verifyReceipt(ghost, DEFAULT_TOKEN_FILE), undefined, 'precondition: the ledger holds no such id');

    const out = await invoke(tools, 'undo_mutation', { receipt_id: ghost, dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'unknown_receipt');
    assert.equal(textOf(out), receiptMissMessage(ghost, process.env, DEFAULT_TOKEN_FILE),
      'the miss message must be the shared one, naming the store scope');
    assert.match(textOf(out), /session-scoped/,
      'a miss says something about the LOOKUP; it must not read as a verdict on the write');
    assert.deepEqual(writes(account.calls), [], 'an unknown id is not a licence to delete something');
    assert.equal(getAllReceipts(DEFAULT_TOKEN_FILE).length, 0, 'and it issues no receipt');
  });

  it('refuses an id whose ledger entry has been evicted — without resolving it to a later mutation', async () => {
    const account = stubClient();
    const { tools } = harness(account);
    // A handful of live rows: if a missed id were resolved to some other
    // receipt, a DELETE would land against these and shrink the set.
    for (let i = 0; i < 5; i++) account.saved.add(track(`overflow${i}`));
    const savedBefore = account.saved.size;

    // Overrun the FIFO cap so the FIRST receipt falls out. This is the shape a
    // long session produces, and the case where a Map lookup that "found
    // something" would be worst: the agent's undo would reverse a mutation the
    // user never asked about.
    const { firstId, lastId } = await overflowLedger((i) => issueReceipt(
      readOnlyClient((path) => (path === '/me/library/contains' ? [true] : {})),
      { kind: 'library', uris: [track(`overflow${i}`)], expectPresent: true },
    ));

    // Preconditions, asserted so the test cannot pass while measuring nothing.
    assert.ok(savedBefore > 0, 'precondition: there are live rows a stray write would destroy');
    assert.equal(getAllReceipts(DEFAULT_TOKEN_FILE).length, MAX_RECEIPTS, 'the ledger is capped, not unbounded');
    assert.equal(verifyReceipt(firstId, DEFAULT_TOKEN_FILE), undefined, 'the oldest receipt really was evicted');
    assert.equal(verifyReceipt(lastId, DEFAULT_TOKEN_FILE)?.receipt_id, lastId, 'the newest receipt really survived');

    const out = await invoke(tools, 'undo_mutation', { receipt_id: firstId, dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'unknown_receipt');
    assert.equal(out.structuredContent?.undone_receipt, undefined,
      'the tool must not attribute the miss to some other receipt');
    assert.match(textOf(out), /Unknown or expired receipt/);
    assert.deepEqual(writes(account.calls), [],
      'an evicted id is a miss, not a licence to delete the newest mutation instead');
    assert.equal(account.saved.size, savedBefore, 'no library row was touched');
  });

  it('refuses a non-reversible kind, naming the kind rather than guessing an inverse', async () => {
    const account = stubClient();
    const { tools } = harness(account);

    const meta = await issueReceipt(readOnlyClient(() => ({ uri: 'spotify:playlist:pl1' })), {
      kind: 'playlist_meta', id: 'pl1', uris: [track('a')],
    });
    assert.equal(meta.kind, 'playlist_meta', 'precondition: a metadata receipt is not invertible');

    const out = await invoke(tools, 'undo_mutation', { receipt_id: meta.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'not_reversible');
    assert.equal(out.structuredContent?.kind, 'playlist_meta');
    assert.match(textOf(out), /not reversible/);
    assert.deepEqual(writes(account.calls), []);
  });

  it('refuses a reversible receipt that records no URIs rather than issuing an empty write', async () => {
    const account = stubClient();
    const { tools } = harness(account);

    const empty = await issueReceipt(readOnlyClient(() => ({})),
      { kind: 'library', uris: [], expectPresent: true });
    assert.equal(empty.uris.length, 0, 'precondition: the receipt carries nothing to invert');

    const out = await invoke(tools, 'undo_mutation', { receipt_id: empty.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'no_uris');
    assert.match(textOf(out), /no stored URIs/);
    assert.deepEqual(writes(account.calls), [],
      'an empty undo must not become a `DELETE /me/library?uris=` with nothing in it');
  });
});

// ---------------------------------------------------------------------------

describe('#658 undo_last_mutation selects the newest REVERSIBLE receipt', () => {
  it('picks the newest entry that can actually be inverted, skipping the rest', async () => {
    const account = stubClient();
    for (const uri of [track('old'), track('new')]) account.saved.add(uri);
    const { tools } = harness(account);

    const responder = (path: string) => (path === '/me/library/contains' ? [true, true] : {});
    // Seeded oldest-first, because the ledger is insertion-ordered and the scan
    // walks it backwards. The two entries newer than the expected target are
    // both traps: a metadata receipt is not invertible, and a reversible kind
    // carrying no uris has nothing to invert. The zero-uri one is deliberately
    // the NEWEST entry, so a scan that forgot that guard would land on it
    // first and report `no_uris` instead of undoing anything.
    const oldest = await issueReceipt(readOnlyClient(responder),
      { kind: 'library', uris: [track('old')], expectPresent: true });
    const chosen = await issueReceipt(readOnlyClient(responder),
      { kind: 'library', uris: [track('new')], expectPresent: true });
    const meta = await issueReceipt(readOnlyClient(() => ({ uri: 'spotify:playlist:pl1' })),
      { kind: 'playlist_meta', id: 'pl1', uris: [track('new')] });
    const empty = await issueReceipt(readOnlyClient(responder),
      { kind: 'library', uris: [], expectPresent: true });

    // Preconditions, asserted so the test cannot pass while measuring nothing.
    assert.deepEqual(
      getAllReceipts(DEFAULT_TOKEN_FILE).map((r) => r.receipt_id),
      [oldest.receipt_id, chosen.receipt_id, meta.receipt_id, empty.receipt_id],
      'precondition: the ledger is in the order this test reasons about',
    );
    assert.equal(getAllReceipts(DEFAULT_TOKEN_FILE).at(-1)?.receipt_id, empty.receipt_id,
      'precondition: the zero-uri entry really is the newest, so the guard is load-bearing');

    const out = await invoke(tools, 'undo_last_mutation', { dry_run: false });

    assert.equal(out.structuredContent?.ok, true, textOf(out));
    assert.equal(out.structuredContent?.undone_receipt, chosen.receipt_id,
      'the newest entry that can actually be inverted wins — not the oldest, and not either trap above');
    assert.deepEqual(writes(account.calls).map((c) => c.path.split('?')[0]), ['/me/library']);
    assert.deepEqual(
      new URLSearchParams(writes(account.calls)[0]!.path.split('?')[1] ?? '').get('uris')?.split(','),
      [track('new')],
      'the write targets the chosen receipt, not the one after it',
    );
    assert.ok(account.saved.has(track('old')), 'the older mutation is left alone');
  });

  it('reports no_reversible when nothing in the ledger can be inverted', async () => {
    const account = stubClient();
    const { tools } = harness(account);
    await issueReceipt(readOnlyClient(() => ({ uri: 'spotify:playlist:pl1' })),
      { kind: 'playlist_meta', id: 'pl1', uris: [track('a')] });
    assert.equal(getAllReceipts(DEFAULT_TOKEN_FILE).length, 1, 'precondition: the ledger is not empty');

    const out = await invoke(tools, 'undo_last_mutation', { dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'no_reversible');
    assert.match(textOf(out), /No reversible mutation found/);
    assert.deepEqual(writes(account.calls), []);
  });

  it('reports no_reversible on an empty ledger rather than inventing a target', async () => {
    const account = stubClient();
    const { tools } = harness(account);
    assert.equal(getAllReceipts(DEFAULT_TOKEN_FILE).length, 0, 'precondition: the ledger really is empty');

    const out = await invoke(tools, 'undo_last_mutation', { dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'no_reversible');
    assert.deepEqual(writes(account.calls), []);
  });

  it('takes no receipt_id — the two undo tools have different arguments', async () => {
    const account = stubClient();
    const { tools } = harness(account);
    const last = tools.find((t) => t.name === 'undo_last_mutation')!;
    // Assert the DECLARED shape, not the parsed output: an optional key the
    // caller omitted is absent from a parse result, so asserting on the parse
    // would pass even if the schema grew a parameter nobody exercises.
    assert.deepEqual(Object.keys(last.shape).sort(), ['dry_run', 'response_format'],
      'undo_last_mutation selects its own target; it must not accept an id it would ignore');

    const targeted = tools.find((t) => t.name === 'undo_mutation')!;
    assert.deepEqual(Object.keys(targeted.shape).sort(), ['dry_run', 'receipt_id', 'response_format'],
      'undo_mutation is the one that names its target');
    assert.equal(targeted.shape.receipt_id.isOptional(), false,
      'the id is required — there is no default receipt to fall back on');
  });
});

// ---------------------------------------------------------------------------

describe('#658 a partial undo reports the partial, and issues no receipt', () => {
  // The failure this whole section exists for: a rollback is several requests,
  // and a receipt tool that reports "undone" after the second of four chunks
  // deleted tells the agent to stop checking. Worse, a receipt issued for the
  // half-finished state would let a LATER verify_receipt confirm it.

  /** 41 uris at the documented 40-uri library cap = two DELETE requests. */
  const fortyOne = Array.from({ length: 41 }, (_, i) => track(`t${i}`));

  it('reports the split between attempted and completed when a later chunk fails', async () => {
    const account = stubClient();
    for (const uri of fortyOne) account.saved.add(uri);
    const { tools } = harness(account);
    (account as unknown as { failDeleteAt: (at: number, m: string) => void })
      .failDeleteAt(2, 'SENTINEL 502 from api.spotify.com');

    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains' ? fortyOne.map(() => true) : {}),
    { kind: 'library', uris: fortyOne, expectPresent: true });
    const ledgerBefore = getAllReceipts(DEFAULT_TOKEN_FILE).length;

    const out = await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, false, 'a half-finished rollback is not a success');
    assert.equal(out.structuredContent?.reason, 'partial_write_failure');
    assert.equal(out.structuredContent?.completed_requests, 1, 'the first chunk did land');
    assert.equal(out.structuredContent?.attempted_requests, 2);
    assert.equal(out.structuredContent?.undone_receipt, undefined,
      'the tool must not claim it undid the whole receipt');
    assert.match(textOf(out), /partial write/);
    assert.doesNotMatch(textOf(out), /^Undid /m,
      'the success sentence is exactly what a half-done rollback must not print');

    // The account is genuinely half-changed — which is why the tool says so.
    assert.equal(account.saved.size, 1, 'only the first chunk was applied; the rest are still saved');

    assert.equal(getAllReceipts(DEFAULT_TOKEN_FILE).length, ledgerBefore,
      'a failed rollback issues NO receipt: nothing here may certify a half-applied state');
    const published = JSON.stringify(out);
    for (const secret of ['SENTINEL', 'api.spotify.com', '502']) {
      assert.equal(published.includes(secret), false, `the failure detail leaked ${secret}`);
    }
  });

  it('reports zero completed when the FIRST chunk fails, and still issues no receipt', async () => {
    const account = stubClient();
    for (const uri of fortyOne) account.saved.add(uri);
    const { tools } = harness(account);
    (account as unknown as { failDeleteAt: (at: number, m: string) => void })
      .failDeleteAt(1, 'SENTINEL connection reset');

    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains' ? fortyOne.map(() => true) : {}),
    { kind: 'library', uris: fortyOne, expectPresent: true });
    const ledgerBefore = getAllReceipts(DEFAULT_TOKEN_FILE).length;

    const out = await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id, dry_run: false });

    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'partial_write_failure');
    assert.equal(out.structuredContent?.completed_requests, 0);
    assert.equal(out.structuredContent?.attempted_requests, 1,
      'the request was ATTEMPTED — that is what distinguishes it from a rollback that never started');
    assert.equal(getAllReceipts(DEFAULT_TOKEN_FILE).length, ledgerBefore);
    assert.equal(account.saved.size, 41, 'nothing was removed');
  });

  it('a receipt for the pre-undo state is still resolvable — the miss did not corrupt the ledger', async () => {
    const account = stubClient();
    account.saved.add(track('a'));
    const { tools } = harness(account);
    (account as unknown as { failDeleteAt: (at: number, m: string) => void })
      .failDeleteAt(1, 'SENTINEL connection reset');

    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains' ? [true] : {}),
    { kind: 'library', uris: [track('a')], expectPresent: true });

    await invoke(tools, 'undo_mutation', { receipt_id: receipt.receipt_id, dry_run: false });
    assert.equal(verifyReceipt(receipt.receipt_id, DEFAULT_TOKEN_FILE)?.receipt_id, receipt.receipt_id,
      'the original receipt survives the failed rollback, so the agent can still inspect it');
  });
});

// ---------------------------------------------------------------------------

describe('#658 verify_receipt at the tool level', () => {
  it('flattens a found receipt beside a single found flag', async () => {
    const tool = await verifyReceiptTool();
    const receipt = await issueReceipt(readOnlyClient((path) =>
      path === '/me/library/contains' ? [true] : {}),
    { kind: 'library', uris: [track('a')], expectPresent: true });

    const out = await tool.handler(tool.validate({ receipt_id: receipt.receipt_id }));

    assert.notEqual(out.isError, true, 'a receipt the ledger holds is not an error');
    assert.equal(out.structuredContent?.found, true);
    // The receipt's own fields stay FLAT, not nested under a `receipt` key.
    assert.equal(out.structuredContent?.receipt_id, receipt.receipt_id);
    assert.equal(out.structuredContent?.verified, true);
    assert.equal(out.structuredContent?.kind, 'library');
    assert.deepEqual(out.structuredContent?.uris, [track('a')]);
    assert.equal(out.structuredContent?.expect_present, true);
    assert.match(textOf(out), /VERIFIED \(library\)/);
  });

  it('isError on an id that was never issued — a failed LOOKUP, not a verdict on the write', async () => {
    const tool = await verifyReceiptTool();
    const ghost = 'rcpt_zzzzzzzz-9';
    assert.equal(verifyReceipt(ghost, DEFAULT_TOKEN_FILE), undefined, 'precondition: the ledger holds no such id');

    const out = await tool.handler(tool.validate({ receipt_id: ghost }));

    assert.equal(out.isError, true,
      'without isError a host rendering green reads this as "the write was checked and is fine"');
    assert.equal(out.structuredContent?.found, false);
    assert.equal(out.structuredContent?.receipt_id, ghost);
    assert.equal(out.structuredContent?.reason, 'unknown');
    assert.equal(out.structuredContent?.receipts_kept, MAX_RECEIPTS);
    assert.equal(textOf(out), receiptMissMessage(ghost, process.env, DEFAULT_TOKEN_FILE));
  });

  it('isError on an EVICTED id, and the same for its undo — both fail the same way', async () => {
    const account = stubClient();
    const { tools } = harness(account);
    const verify = await verifyReceiptTool();

    const { firstId, lastId } = await overflowLedger((i) => issueReceipt(
      readOnlyClient((path) => (path === '/me/library/contains' ? [true] : {})),
      { kind: 'library', uris: [track(`o${i}`)], expectPresent: true },
    ));
    assert.equal(verifyReceipt(firstId, DEFAULT_TOKEN_FILE), undefined, 'precondition: the oldest receipt was evicted');
    assert.equal(verifyReceipt(lastId, DEFAULT_TOKEN_FILE)?.receipt_id, lastId, 'precondition: the newest survived');

    const verified = await verify.handler(verify.validate({ receipt_id: firstId }));
    assert.equal(verified.isError, true);
    assert.equal(verified.structuredContent?.found, false);

    const undone = await invoke(tools, 'undo_mutation', { receipt_id: firstId, dry_run: false });
    assert.equal(undone.structuredContent?.reason, 'unknown_receipt');
    assert.deepEqual(writes(account.calls), [],
      'neither tool may act on a receipt the ledger no longer holds');
  });

  it('rejects a malformed id at the schema, naming the expected shape', async () => {
    const tool = await verifyReceiptTool();
    for (const bad of ['recpt_1', 'receipt-4', '4', 'rcpt_', '']) {
      assert.throws(
        () => tool.validate({ receipt_id: bad }),
        /rcpt_<bootId>-<n>/,
        `id ${JSON.stringify(bad)} is a mistyped CALL, not an unknown receipt`,
      );
    }
  });

  it('accepts the pre-#587 bare counter a persisted ledger can still hold', async () => {
    const tool = await verifyReceiptTool();
    const receipt = await issueReceipt(readOnlyClient(() => ({})),
      { kind: 'playlist_meta', id: 'pl1', uris: [] });
    const legacyId = receipt.receipt_id.replace(/^rcpt_[0-9a-z]+-/, 'rcpt_');
    assert.match(legacyId, /^rcpt_\d+$/, 'precondition: this id has the pre-#587 shape');

    const validated = tool.validate({ receipt_id: legacyId }) as Record<string, unknown>;
    assert.equal(validated.receipt_id, legacyId, 'the schema accepts it');
    const out = await tool.handler(tool.validate({ receipt_id: legacyId }));
    // It is well-formed, so it reaches the store; nothing seeded a receipt under
    // that id, so the answer is a miss — the point is that the SCHEMA let it by.
    assert.equal(out.structuredContent?.found, false);
  });
});

// ---------------------------------------------------------------------------

describe('#658 undo is annotated as a destructive write', () => {
  /**
   * The annotations are what a host auto-approves on, so they are read off the
   * real `McpServer` registry through the real `applyToolAnnotations` — the same
   * two calls `src/index.ts` makes at startup.
   */
  function annotationsFor(): Record<string, Record<string, unknown>> {
    const server = new McpServer({ name: 'undo-annotations', version: '0.0.0' });
    registerUndoTools(server, stubClient().client);
    const applied = applyToolAnnotations(server);
    assert.equal(applied.total, applied.annotated, 'every registered tool must be annotated');
    const registry = (server as unknown as {
      _registeredTools: Record<string, { annotations?: Record<string, unknown> }>;
    })._registeredTools;
    const out: Record<string, Record<string, unknown>> = {};
    for (const name of ['undo_mutation', 'undo_last_mutation']) {
      assert.ok(registry[name], `${name} must be registered`);
      out[name] = registry[name]!.annotations ?? {};
    }
    return out;
  }

  it('marks both undo tools destructive, and never read-only', () => {
    const annotations = annotationsFor();
    for (const [name, a] of Object.entries(annotations)) {
      assert.equal(a.readOnlyHint, undefined,
        `${name} deletes real library/playlist rows; an absent readOnlyHint means false, which is the truth`);
      assert.equal(a.destructiveHint, true,
        `${name} issues DELETE /me/library and DELETE /playlists/{id}/items — a host that trusts ` +
        'destructiveHint to auto-approve must not be told a rollback is safe');
    }
  });

  it('keeps verify_receipt read-only, so the three receipt tools are not one verdict', async () => {
    const server = new McpServer({ name: 'verify-annotations', version: '0.0.0' });
    const context = { readOnly: false, disableOverrides: new Set<string>(), isModuleActive: () => true, scopeBlocked: () => false };
    const module = REGISTRAR_MANIFEST.find((m) => m.key === 'receipts');
    assert.ok(module, 'the receipts module must be in the registrar manifest');
    for (const loaded of await loadManifestRegistrars([module], context)) {
      // A real client, not `undefined` (#1385): the receipt store is keyed by
    // client.tokenFile, so registering without one is now a hard failure rather
    // than a silent read of the default account's store.
    registerManifestModule(server, { tokenFile: DEFAULT_TOKEN_FILE } as unknown as SpotifyClient, loaded, context);
    }
    applyToolAnnotations(server);
    const registry = (server as unknown as {
      _registeredTools: Record<string, { annotations?: Record<string, unknown> }>;
    })._registeredTools;
    const annotations = registry.verify_receipt?.annotations;
    assert.ok(annotations, 'verify_receipt must be registered and annotated');
    assert.equal(annotations.readOnlyHint, true, 'it reads the in-process ledger and writes nothing');
    assert.equal(annotations.destructiveHint, undefined,
      'a read states no destructiveHint; an explicit false would be a claim it destroys something');
  });
});

describe('#658 the tests never touch the developer ledger', () => {
  it('resolves the receipt trail inside the throwaway directory, not ~/.spotify-mcp', () => {
    const path = receiptsFilePath(process.env, DEFAULT_TOKEN_FILE);
    assert.equal(path.startsWith(ledgerDir), true,
      `the ledger path must be sandboxed, got ${path}`);
    assert.notEqual(path, REAL_HOME_LEDGER,
      'this suite must never be able to read or append the real ~/.spotify-mcp/receipts.jsonl');
    assert.equal(isReceiptsPersistent(), false,
      'persistence is off, so no test in this file can write a trail at all');
  });
});
