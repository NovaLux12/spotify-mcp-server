/**
 * The mutation ledger and the receipt store are account-keyed (#1364).
 *
 * Before this, `historyFilePath()` and `receiptsFilePath()` resolved a
 * DIRECTORY and wrote one file under it, and the live receipt store was a
 * single module-level `Map`. Nothing in either path carried an account, so a
 * process that switched accounts on one machine kept writing both accounts'
 * mutations to the same ledger, and a receipt id minted under account A was
 * redeemable under account B. SPEC §5.13 recorded the gap rather than
 * half-fixing it; this closes it.
 *
 * ## The account key is the TOKEN FILE, not `account_id`
 *
 * The obvious key is Spotify's `account_id`, and it is the wrong one here for
 * a reason worth stating: reading it costs a live `GET /me`
 * (`src/actingaccount.ts`), that module is allowed to return `undefined` when
 * the read is throttled or the token is private, and a store keyed on a value
 * that can come back missing is a store that silently merges accounts. These
 * stores follow the one that already shipped — the persisted read cache, keyed
 * off the token file by `cacheFileNameFor` (`src/cachepersist.ts`) — so there
 * is one derivation on the box rather than a second one that can disagree.
 * See `src/accountkey.ts`.
 *
 * ## What these tests pin
 *
 * 1. A receipt written under account A does not verify under account B — in
 *    memory, which is the store that is live in the DEFAULT configuration
 *    (`SPOTIFY_MCP_RECEIPTS` is opt-in), and on disk.
 * 2. The DEFAULT account keeps the pre-existing un-keyed filenames. That is
 *    the backward-compatibility contract: an operator with one account and no
 *    profile has a `mutations.jsonl` and a `receipts.jsonl` on disk, and after
 *    this change those files are still the ones that account reads and writes.
 *    No migration, no rename, no "receipt not found" regression.
 * 3. A pre-existing, pre-account-keying `receipts.jsonl` still resolves — for
 *    the default account, which is the only account whose store it ever was.
 *    A named profile does NOT see it: those lines predate any attribution, and
 *    reading them for a profile is the leak this fixes.
 *
 * ## A note on assertions
 *
 * No assertion here compares receipt IDs across accounts. `__resetReceiptStoreForTests`
 * resets `nextSeq` while `bootId` is fixed for the process, so two issues
 * around a reset can share an ID — a test that leaned on ID distinctness
 * passed against the broken implementation. These assert on the URIs the
 * receipt carries instead, which no id scheme can make ambiguous.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { accountStoreKey } from '../src/accountkey.js';
import {
  __resetReceiptStoreForTests,
  getAllReceipts,
  isReceiptsPersistent,
  issueReceipt,
  receiptMissMessage,
  receiptsFilePath,
  verifyReceipt,
  type Receipt,
  type ReceiptClient,
} from '../src/receipts.js';
import { appendHistory, historyFilePath, readHistory } from '../src/history.js';
import { localStorePaths } from '../src/logout.js';
import type { SpotifyClient } from '../src/client.js';
import {
  loadManifestRegistrars,
  registerManifestModule,
  REGISTRAR_MANIFEST,
} from '../src/tools/annotations.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A receipt client for one account.
 *
 * `tokenFile` is what identifies the account, and it is the same field the
 * real `SpotifyClient` carries. Answering every `/me/library/contains` flag
 * true makes a save verify, so the fixture exercises the real happy path.
 */
function stubClient(tokenFile: string): ReceiptClient {
  return {
    tokenFile,
    get: <T>(_path: string, params?: Record<string, string>): Promise<T | null> =>
      Promise.resolve(
        (params?.uris ?? '').split(',').map(() => true) as unknown as T,
      ),
  } as ReceiptClient;
}

/** The URIs a receipt carries, for assertions that must not lean on IDs. */
function urisOf(receipts: Receipt[]): string[][] {
  return receipts.map((r) => r.uris ?? []);
}

/**
 * Run `body` with the receipt/history env pointed at a fresh temp dir, and two
 * named accounts.
 *
 * Every store this touches is under `mkdtemp`, never under the real `$HOME`:
 * `SPOTIFY_MCP_RECEIPTS_DIR` / `SPOTIFY_MCP_HISTORY_DIR` are set explicitly,
 * and `tests/helpers/hermetic.ts` has already moved `$HOME` itself.
 */
async function withAccounts<T>(
  vars: Record<string, string>,
  body: (ctx: { dir: string; def: string; work: string }) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'acct-keyed-'));
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({
    ...vars,
    SPOTIFY_MCP_RECEIPTS_DIR: dir,
    SPOTIFY_MCP_HISTORY_DIR: dir,
  })) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  __resetReceiptStoreForTests();
  try {
    return await body({ dir, def: join(dir, 'tokens.json'), work: join(dir, 'tokens.work.json') });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetReceiptStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}

const PERSIST_ON = { SPOTIFY_MCP_RECEIPTS: '1' };
const PERSIST_OFF = { SPOTIFY_MCP_RECEIPTS: '' };
const HISTORY_ON = { SPOTIFY_MCP_HISTORY: '1' };

// ---------------------------------------------------------------------------
// The key itself
// ---------------------------------------------------------------------------

describe('accountStoreKey', () => {
  it('is empty for the default account, so its store keeps its existing filename', () => {
    assert.equal(accountStoreKey('/home/x/.spotify-mcp/tokens.json'), '');
  });

  it('is the profile name for a named profile, matching the read cache', () => {
    assert.equal(accountStoreKey('/home/x/.spotify-mcp/tokens.work.json'), 'work');
    assert.equal(accountStoreKey('/tmp/elsewhere/tokens.kitchen.json'), 'kitchen');
  });

  it('separates two accounts that would otherwise share one store', () => {
    assert.notEqual(
      accountStoreKey('/home/x/.spotify-mcp/tokens.json'),
      accountStoreKey('/home/x/.spotify-mcp/tokens.work.json'),
    );
  });

  it('never emits a path separator or a traversal segment', () => {
    // An `SPOTIFY_MCP_TOKEN_FILE` is operator-supplied and goes through this
    // function to build a FILENAME. A key of `../../escape` would write outside
    // the store directory, so the key is sanitized rather than trusted.
    for (const raw of [
      '/tmp/tokens.../../../escape.json',
      '/tmp/tokens.a/b.json',
      '/tmp/tokens..json',
    ]) {
      const key = accountStoreKey(raw);
      assert.ok(!key.includes('/'), `key ${JSON.stringify(key)} contains a separator`);
      assert.ok(
        key !== '..' && key !== '.',
        `key ${JSON.stringify(key)} is a traversal segment`,
      );
    }
  });

  it('gives two unconventional token files distinct keys', () => {
    // The fall-through shape (a custom `SPOTIFY_MCP_TOKEN_FILE`) must not
    // collapse two different files onto one store.
    assert.notEqual(
      accountStoreKey('/tmp/alpha/tokens.jsonx'),
      accountStoreKey('/tmp/alpha/tokens.other'),
    );
  });

  it('never hands a non-default account the default account\'s key', () => {
    // The empty key means "the un-keyed store". A named account that sanitised
    // down to the empty key would merge into it, which is the defect itself.
    for (const raw of [
      '/tmp/alpha/tokens.json',
      '/tmp/alpha/tokens..json',
      '/tmp/alpha/tokens.!.json',
    ]) {
      const key = accountStoreKey(raw);
      if (basename(raw) === 'tokens.json') {
        assert.equal(key, '', `${raw} is the default account and keeps the un-keyed name`);
      } else {
        assert.notEqual(key, '', `${raw} must not resolve to the default account's store`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Receipts: the cross-account attestation
// ---------------------------------------------------------------------------

describe('the receipt store is account-keyed (#1364)', () => {
  it('a receipt issued under one account does not verify under another', async () => {
    await withAccounts(PERSIST_OFF, async ({ def, work }) => {
      const issued = await issueReceipt(stubClient(work), {
        kind: 'library',
        uris: ['spotify:track:private-to-work'],
      });

      // One process, one in-memory store, two accounts. Persistence is OFF
      // here deliberately: the live `Map` IS the store in the default
      // configuration, so this is the path that matters most.
      assert.ok(
        verifyReceipt(issued.receipt_id, work),
        'the issuing account still sees its own receipt',
      );
      assert.equal(
        verifyReceipt(issued.receipt_id, def),
        undefined,
        'a receipt minted under another account must not verify',
      );
    });
  });

  it('getAllReceipts returns only the acting account\'s receipts', async () => {
    await withAccounts(PERSIST_OFF, async ({ def, work }) => {
      await issueReceipt(stubClient(work), { kind: 'library', uris: ['spotify:track:to-work'] });
      await issueReceipt(stubClient(def), { kind: 'library', uris: ['spotify:track:to-default'] });

      assert.deepEqual(urisOf(getAllReceipts(work)), [['spotify:track:to-work']]);
      assert.deepEqual(urisOf(getAllReceipts(def)), [['spotify:track:to-default']]);
    });
  });

  it('each account writes its own receipt file when persistence is on', async () => {
    await withAccounts(PERSIST_ON, async ({ dir, def, work }) => {
      assert.equal(isReceiptsPersistent(), true);
      const workFile = receiptsFilePath(process.env, work);
      const defFile = receiptsFilePath(process.env, def);
      assert.notEqual(workFile, defFile, 'two accounts must not share one trail');

      const issued = await issueReceipt(stubClient(work), {
        kind: 'library',
        uris: ['spotify:track:to-work'],
      });
      const workLines = readFileSync(workFile, 'utf8').trim().split('\n');
      assert.equal(workLines.length, 1);
      assert.equal((JSON.parse(workLines[0]!) as Receipt).receipt_id, issued.receipt_id);
      assert.throws(
        () => readFileSync(defFile),
        'the other account\'s trail must not exist',
      );
      assert.deepEqual(readdirSync(dir), ['receipts.work.jsonl'], 'the only trail written is the work\'s');
    });
  });

  it('a receipt on disk reloads only for the account that wrote it', async () => {
    await withAccounts(PERSIST_ON, async ({ def, work }) => {
      const issued = await issueReceipt(stubClient(work), {
        kind: 'library',
        uris: ['spotify:track:to-work'],
      });
      __resetReceiptStoreForTests(); // restart: everything now comes off disk

      assert.ok(verifyReceipt(issued.receipt_id, work), 'persistence round-trips for its owner');
      assert.equal(
        verifyReceipt(issued.receipt_id, def),
        undefined,
        'and stays invisible to the other account',
      );
    });
  });

  it('the miss message names the ACTING account\'s file, not another account\'s', async () => {
    await withAccounts(PERSIST_ON, async ({ def, work }) => {
      const message = receiptMissMessage('rcpt_gone-1', process.env, work);
      assert.ok(message.includes(receiptsFilePath(process.env, work)), message);
      assert.ok(
        !message.includes(receiptsFilePath(process.env, def)),
        'the miss must not point the reader at another account\'s trail',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('a store written before accounts existed still works', () => {
  it('the two accounts\' files are separate files, not one file with two writers', async () => {
    await withAccounts(PERSIST_ON, async ({ dir, def, work }) => {
      // The default account's two are byte-for-byte the paths a pre-#1364
      // install has on disk. That is the whole no-migration argument.
      assert.equal(receiptsFilePath(process.env, def), join(dir, 'receipts.jsonl'));
      assert.equal(historyFilePath(process.env, def), join(dir, 'mutations.jsonl'));
      assert.equal(receiptsFilePath(process.env, work), join(dir, 'receipts.work.jsonl'));
      assert.equal(historyFilePath(process.env, work), join(dir, 'mutations.work.jsonl'));
    });
  });

  it('a legacy un-keyed receipts.jsonl still resolves for the default account', async () => {
    await withAccounts(PERSIST_ON, async ({ dir, def, work }) => {
      // A line in the shape a pre-#1364 build wrote: no account field, because
      // the format had nowhere to put one.
      const legacy = {
        receipt_id: 'rcpt_legacy-1',
        kind: 'library',
        verified: true,
        missing: [],
        uris: ['spotify:track:from-before'],
        issued_at: Date.now(),
      } satisfies Receipt;
      writeFileSync(join(dir, 'receipts.jsonl'), `${JSON.stringify(legacy)}\n`);

      __resetReceiptStoreForTests(); // a fresh process reading the old file
      assert.ok(
        verifyReceipt('rcpt_legacy-1', def),
        'an existing install must not start reporting its own receipts as unknown',
      );
      assert.equal(
        verifyReceipt('rcpt_legacy-1', work),
        undefined,
        'but an unattributable legacy line is not handed to a named profile either',
      );
    });
  });

  it('a legacy un-keyed mutations.jsonl still reads for the default account', async () => {
    await withAccounts(HISTORY_ON, async ({ dir, def }) => {
      const legacy = {
        ts: new Date().toISOString(),
        who: 'agent',
        method: 'POST',
        path: '/playlists/{id}/items',
      };
      writeFileSync(join(dir, 'mutations.jsonl'), `${JSON.stringify(legacy)}\n`);

      const records = await readHistory({ tokenFile: def });
      assert.equal(records.length, 1, 'the pre-existing ledger is still readable');
      assert.equal(records[0]!.path, '/playlists/{id}/items');
    });
  });

  it('a named profile does not read the legacy un-keyed mutations.jsonl', async () => {
    await withAccounts(HISTORY_ON, async ({ dir, work }) => {
      const legacy = {
        ts: new Date().toISOString(),
        who: 'agent',
        method: 'POST',
        path: '/playlists/{id}/items',
      };
      writeFileSync(join(dir, 'mutations.jsonl'), `${JSON.stringify(legacy)}\n`);

      assert.deepEqual(
        await readHistory({ tokenFile: work }),
        [],
        'lines written before accounts existed are not attributable, so they are not served to a profile',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

describe('the mutation ledger is account-keyed (#1364)', () => {
  it('two accounts writing the same method/path land in two ledgers', async () => {
    await withAccounts(HISTORY_ON, async ({ dir, def, work }) => {
      await appendHistory({ method: 'POST', path: '/playlists/pl1/items' }, def);
      await appendHistory({ method: 'POST', path: '/playlists/pl1/items' }, work);

      assert.equal((await readHistory({ tokenFile: def })).length, 1);
      assert.equal((await readHistory({ tokenFile: work })).length, 1);
      assert.deepEqual(
        readdirSync(dir)
          .filter((n) => n.startsWith('mutations'))
          .sort(),
        ['mutations.jsonl', 'mutations.work.jsonl'],
      );
    });
  });

  it('a record names the account that wrote it', async () => {
    await withAccounts(HISTORY_ON, async ({ dir, work }) => {
      await appendHistory({ method: 'DELETE', path: '/me/library' }, work);
      const raw = readFileSync(join(dir, 'mutations.work.jsonl'), 'utf8').trim();
      assert.equal((JSON.parse(raw) as { account?: string }).account, 'work');
    });
  });
});

// ---------------------------------------------------------------------------
// The shipped wiring, not just the store API
// ---------------------------------------------------------------------------

describe('verify_receipt is account-keyed through the shipped manifest wiring', () => {
  /**
   * The `receipts` manifest row, registered the way `src/index.ts` registers
   * it. `registerVerifyReceiptTool` is private in `src/tools/annotations.ts`,
   * so going through the manifest is the only way to reach the registration
   * that actually ships.
   *
   * The `client` argument is the point of this test. An earlier version of the
   * registrar dropped it, and a test that registered with `undefined` as the
   * client could not have told the difference: every account would read as the
   * default one and the suite would stay green over the defect.
   */
  async function verifyReceiptToolFor(tokenFile: string): Promise<{
    name: string;
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    }>;
  }> {
    const tools: Array<{
      name: string;
      handler: (args: Record<string, unknown>) => Promise<never>;
    }> = [];
    const server = {
      tool: (
        name: string,
        _description: string,
        _shape: unknown,
        handler: (args: Record<string, unknown>) => Promise<never>,
      ) => {
        tools.push({ name, handler });
        return { name };
      },
    };

    const context = {
      readOnly: false,
      isModuleActive: () => true,
      scopeBlocked: () => false,
    };
    const module = REGISTRAR_MANIFEST.find((m) => m.key === 'receipts');
    assert.ok(module, 'the receipts module must be in the registrar manifest');
    for (const loaded of await loadManifestRegistrars([module], context)) {
      registerManifestModule(
        server as never,
        // Only the `tokenFile` matters to this tool, and it is the same field
        // the real `SpotifyClient` carries and re-points on `switchAccount`.
        { tokenFile } as unknown as SpotifyClient,
        loaded,
        context,
      );
    }
    const tool = tools.find((t) => t.name === 'verify_receipt');
    assert.ok(tool, 'verify_receipt must be registered by the receipts manifest module');
    return tool as never;
  }

  it('refuses another account\'s receipt id instead of attesting to it', async () => {
    await withAccounts(PERSIST_OFF, async ({ def, work }) => {
      const issued = await issueReceipt(stubClient(work), {
        kind: 'library',
        uris: ['spotify:track:private-to-work'],
      });

      const asWork = await verifyReceiptToolFor(work);
      const asDefault = await verifyReceiptToolFor(def);

      const own = await asWork.handler({ receipt_id: issued.receipt_id });
      assert.equal(own.isError, undefined, 'the issuing account still resolves its own receipt');
      assert.equal(own.structuredContent?.found, true);

      // This is the assertion that fails against the unwired registrar: with
      // the client dropped, both tools read the same default-account store and
      // the second call would answer `found: true` with work's receipt.
      const foreign = await asDefault.handler({ receipt_id: issued.receipt_id });
      assert.equal(foreign.isError, true, 'another account\'s receipt id is a miss, not an attestation');
      assert.equal(foreign.structuredContent?.found, false);
      assert.equal(foreign.structuredContent?.reason, 'unknown');
    });
  });
});

// ---------------------------------------------------------------------------
// Erasure reaches every account, not just the active one
// ---------------------------------------------------------------------------

describe('logout covers every account\'s store, not just the active one', () => {
  /**
   * A `mkdtemp` home holding two accounts' token files, with no per-store env
   * overrides — the production layout, where each default is
   * `join(homedir(), '.spotify-mcp', …)`. No store filename is typed below;
   * the paths are the ones the store modules report.
   *
   * `HOME` is set process-wide because the store defaults are derived from
   * `homedir()`, which reads the real environment rather than an `env`
   * argument — the same reason `logout.cache.test.ts` pins it, and the reason
   * this must not read the developer's real `~/.spotify-mcp`.
   *
   * The token files have to exist: the store name is derived from the token
   * FILE, so an account with no token file is an account with no store to
   * enumerate, exactly as `cachePersistPaths` treats a missing token file.
   */
  function sandbox(): { env: NodeJS.ProcessEnv; restore: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'acct-keyed-home-'));
    mkdirSync(join(root, '.spotify-mcp'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, '.spotify-mcp', 'history'), { recursive: true, mode: 0o700 });
    for (const name of ['tokens.json', 'tokens.work.json']) {
      writeFileSync(
        join(root, '.spotify-mcp', name),
        JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: 1 }),
        { mode: 0o600 },
      );
    }
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    return {
      env: { HOME: root, USERPROFILE: root },
      restore: () => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  /** The paths logout's registry carries for one store, across all accounts. */
  function covered(stores: { id: string; path: string }[], base: string): string[] {
    return stores
      .filter((s) => s.id === base || s.id.startsWith(`${base}:`))
      .map((s) => basename(s.path))
      .sort();
  }

  it('lists a ledger and a receipt trail for both accounts', () => {
    const box = sandbox();
    try {
      const stores = localStorePaths({ env: box.env });

      // Without the `expand` these are single-file answers: only the DEFAULT
      // account's ledger is listed, and every other account's ledger is
      // orphaned on disk while logout reports success — the failure #1300
      // found for the persisted read cache.
      assert.deepEqual(covered(stores, 'mutations'), ['mutations.jsonl', 'mutations.work.jsonl']);
      assert.deepEqual(covered(stores, 'receipts'), ['receipts.jsonl', 'receipts.work.jsonl']);
    } finally {
      box.restore();
    }
  });
});
