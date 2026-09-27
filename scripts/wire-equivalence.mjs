#!/usr/bin/env node
/**
 * Offline wire-equivalence harness (#1481).
 *
 * Registers the whole tool surface against a null-answering stub client,
 * invokes every tool across a fixed argument matrix, and prints the exact
 * serialized `tools/call` result of each — one JSON object per line. Two commits
 * are equivalent when two snapshot files are byte-identical.
 *
 * ## Why this exists
 *
 * PR #1477 (a 45-file, 258-call-site refactor) claimed behavioural equivalence
 * on the strength of "2610 invocations, md5 `f550db9e…` on both sides". That
 * probe was not in the diff. A reviewer could not run the evidence, and the md5
 * was unfalsifiable as stated. The claim happened to be true — reproducing it
 * was the reviewer's labour, not the PR's contribution.
 *
 * This is the third time whole-surface equivalence has been needed (#582, the
 * emit/json-mode work in #895, #1477), and each time the harness was written
 * ad hoc, run, and discarded. A committed harness means the third refactor
 * inherits it.
 *
 * ## Hermeticity is the other half of this issue, and the load-bearing half
 *
 * The #1477 probe wrote 38 files into a developer's real `~/.spotify-mcp/`
 * before it was fixed. It imported server modules first and set `HOME` after,
 * which is too late: every store default resolves through `os.homedir()`, and
 * the import is what triggers the writes.
 *
 * So the ORDER in this file is the design, and it is the reason for two
 * otherwise-odd choices:
 *
 *   1. The sandbox is built **after** the re-exec guard and **before** the
 *      first server import.
 *   2. Every server import is a DYNAMIC `await import(...)`.
 *
 * ES module `import` declarations are hoisted and evaluated before any
 * statement in the module body runs, so a static `import … from '../src/…'`
 * would execute the server's module initialization — and its store writes —
 * before the line that sets `HOME`. A reader "tidying" a dynamic import into a
 * static one reintroduces the exact bug this issue reports, which is why
 * `tests/wire-equivalence.test.ts` asserts the file's static import list as
 * well as running it.
 *
 * The two static imports below are the deliberate exception, and both are safe
 * for a checkable reason rather than by convention: `hermetic-home.mjs`
 * imports only `node:*` and the shared pin table, and `wire-equivalence-core.mjs`
 * imports nothing at all. Neither can reach server code.
 *
 * ## Offline, and offline on purpose
 *
 * There is no network. The client is a stub that answers every verb with a
 * fixed value, so the harness cannot rate-limit, cannot spend quota, and
 * cannot be run at all without credentials — which is what makes it runnable in
 * CI and on demand, unlike `scripts/probe-lib.mjs` and `scripts/edge-probe.mjs`,
 * which #1481 explicitly rules out as the opposite of this.
 *
 * `SPOTIFY_MCP_CONFIRM=never` is set, exactly as `scripts/surface-census.mjs`
 * sets it. This is the documented automation bypass, applied deliberately: the
 * harness must reach a mutating tool's handler rather than stopping at an
 * elicitation prompt nothing can answer. It weakens no gate — the gate is
 * untouched, and the bypass is a value an operator sets explicitly. A harness
 * that refused to set it would measure the prompt, not the tool.
 *
 * ## Usage
 *
 *   node scripts/wire-equivalence.mjs                       # snapshot to stdout
 *   node scripts/wire-equivalence.mjs --out base.jsonl      # snapshot to a file
 *   node scripts/wire-equivalence.mjs --compare a.jsonl b.jsonl
 *
 * `--compare` is what removes the "I ran it on both sides and pasted two md5s"
 * step: it prints every differing invocation by name and exits non-zero.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both static imports are `node:*`-only or pure. See the ordering note above.
import { isInside, sandboxStorePins } from './hermetic-home.mjs';
import { CALL_CASES, FROZEN_NOW_MS, argsForCase, compareSnapshots, digest, formatDiff, serializeRecord } from './wire-equivalence-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Re-exec under tsx, the same shape `scripts/surface-census.mjs` uses.
 *
 * FIRST, before the sandbox is built, because the child is the process that
 * does the work: the parent would otherwise mint a temp directory and pin
 * stores in a process that immediately exits. It also means a mistyped
 * `tsx/esm` import path is a startup failure rather than a per-tool one.
 */
if (!process.env.SPOTIFY_MCP_WIRE_EQUIVALENCE) {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { cwd: ROOT, env: { ...process.env, SPOTIFY_MCP_WIRE_EQUIVALENCE: '1' }, stdio: 'inherit' },
  );
  process.exit(child.status ?? 1);
}

// ---------------------------------------------------------------------------
// THE SANDBOX. Everything above this line is `node:*`; everything below may
// import server code. Do not move a server import above this block.
// ---------------------------------------------------------------------------

const SANDBOX_PREFIX = 'spotify-mcp-wire-';
const sandbox = buildSandbox();

function buildSandbox() {
  const home = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
  const storeDir = join(home, '.spotify-mcp');
  // `mkdtemp` creates the root and nothing under it; every store resolves as
  // `<storeDir>/…`, so the directory itself has to exist before the pins and
  // the token stub are written.
  mkdirSync(storeDir, { recursive: true });

  // `os.homedir()` reads `process.env.HOME` on every call on POSIX, so this
  // relocates every `join(homedir(), '.spotify-mcp', …)` default at once —
  // including the stores with no override of their own. `USERPROFILE` is the
  // Windows spelling and CI runs there.
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  // Every `SPOTIFY_*` the parent carried is dropped first, so an inherited
  // `SPOTIFY_MCP_BACKUP_DIR=/somewhere/real` cannot point a store outside the
  // sandbox. Then the pins go on, from the SAME table the live harness scripts
  // use (`scripts/hermetic-home.mjs`), so the two cannot drift apart on which
  // variables confine a store. No `.env` is read, so a line in one cannot
  // defeat the pins either.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SPOTIFY_')) delete process.env[key];
  }
  Object.assign(process.env, sandboxStorePins(storeDir));
  // The automation bypass, and the other two knobs the census also pins. Set
  // after the delete above, which is why it survives.
  process.env.SPOTIFY_MCP_CONFIRM = 'never';
  process.env.SPOTIFY_CLIENT_ID = 'wire-equivalence';

  // The harness reads no network and no credentials, so the token file is a
  // synthetic stub rather than a copy of anything real. It is written INSIDE
  // the sandbox; nothing outside it is ever read.
  writeFileSync(join(storeDir, 'tokens.json'), JSON.stringify({
    access_token: 'wire-equivalence',
    refresh_token: 'wire-equivalence',
    expires_at: 4_102_444_800_000,
  }), { mode: 0o600 });

  // Locale and time zone are PINNED, not masked. `toLocaleString()` reaches the
  // wire from five call sites (src/tools/statsfm.ts, src/tools/personalization.ts,
  // src/resources/index.ts) and would otherwise make a snapshot
  // machine-dependent. Pinning keeps the artifact portable AND leaves a genuine
  // locale bug visible as a difference between two commits — which masking
  // would erase. This is the issue's own instruction, and the reason it is
  // right: a locale difference in output is a real finding, not noise.
  process.env.TZ = 'UTC';
  process.env.LANG = 'en_US.UTF-8';
  process.env.LC_ALL = 'en_US.UTF-8';

  return { home, storeDir };
}

/**
 * Throws unless every store in the server's own registry resolves inside the
 * sandbox.
 *
 * The real comparison, not a spot check: it asks `storePath()` — the server's
 * own resolver — where each of the eighteen local stores would land under the
 * environment about to be used, and requires all of them to be under the
 * sandbox. A wrong pin, a store added without a pin, or a `HOME` that never got
 * redirected all stop the run here rather than after the first write.
 *
 * Re-reads `os.homedir()` rather than trusting the assignment above: "HOME was
 * assigned" is the kind of assertion that passes whether or not it worked.
 */
export async function assertHermetic(home) {
  const { LOCAL_STORES, storePath } = await import('../src/config.js');
  if (homedir() !== home) {
    throw new Error(
      `wire-equivalence: HOME was redirected to ${home} but os.homedir() reports ${homedir()}. Every store ` +
        'default resolves through homedir(); continuing would write to the real home.',
    );
  }
  const pins = sandboxStorePins(join(home, '.spotify-mcp'));
  const uncovered = [...new Set(LOCAL_STORES.map((entry) => entry.envVar))].filter((variable) => !(variable in pins));
  if (uncovered.length > 0) {
    throw new Error(
      `wire-equivalence: the store registry names ${uncovered.join(', ')}, which the shared pin table does not ` +
        'cover. A store would resolve through an inherited value. Add the pin before taking a snapshot.',
    );
  }
  const escaped = LOCAL_STORES
    .map((entry) => ({ id: entry.id, path: storePath(entry.id, process.env) }))
    .filter((entry) => !isInside(home, entry.path));
  if (escaped.length > 0) {
    throw new Error(
      `wire-equivalence: refusing to register tools whose local stores resolve outside ${home}:\n  ` +
        escaped.map((entry) => `${entry.id} → ${entry.path}`).join('\n  ') +
        "\nA harness that writes outside its sandbox is a write to the developer's real ~/.spotify-mcp.",
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// From here on, server code may be imported. Do not move a server import above
// the sandbox block.
// ---------------------------------------------------------------------------

/**
 * Replace the clock and `Math.random`, before the module graph is built.
 *
 * `src/receipts.ts:309` computes its `bootId` at MODULE SCOPE from
 * `Date.now()`, so a clock frozen after the import would not reach it — the
 * same import-ordering hazard as `HOME`, in a second dimension.
 *
 * A frozen clock and a seeded RNG are preferred over masking both: masking a
 * shuffled ORDER erases the one property the shuffle exists to produce, while
 * a seed fixes it without hiding it. Two commits that shuffle differently
 * still differ. The returned function restores both, so the process is not left
 * in a state that would confuse a caller.
 */
function pinNondeterminism() {
  const RealDate = Date;
  const now = RealDate.parse('2026-01-02T03:04:05.000Z');
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args) => (args.length === 0 ? new target(now) : new target(...args)),
    get: (target, property, receiver) => (property === 'now' ? () => now : Reflect.get(target, property, receiver)),
  });

  // mulberry32: small, seeded, and reproducible, so two runs consume the
  // identical sequence and a shuffle that reaches the wire comes out in the
  // identical order.
  let state = 0x1481_0001;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    globalThis.Date = RealDate;
  };
}

/**
 * Stamp every file in the sandbox with the frozen clock's filesystem times.
 *
 * ## Why the clock proxy is not enough
 *
 * `Date` is frozen in JavaScript, but a tool that lists a directory reports
 * `stat().mtime` — and that value comes from the FILESYSTEM, which the proxy
 * cannot reach. The first run of this harness was not byte-reproducible for
 * exactly this reason, and the diff named `history_search` reporting
 * `"mtime":"2026-09-27T15:59:24.167Z"` on one run and `…15:59:30.615Z` on the
 * next. Masking the ISO string would have hidden it; the honest fix is that the
 * harness OWNS its sandbox and can therefore pin the metadata in it.
 *
 * Called after every invocation, not once at the end, because a tool's write
 * is visible to the NEXT tool's read. Normalizing at the end would leave every
 * intra-run ordering intact and only fix the last writer.
 *
 * `ENOENT` is swallowed rather than thrown: a tool that creates and deletes a
 * temp file inside the same invocation can lose the race with this walk, and
 * that is not a harness failure.
 */
function normalizeSandboxTimes() {
  const frozen = FROZEN_NOW_MS / 1000;
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // the tool removed the directory it made
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      try {
        if (!statSync(path).isFile()) continue;
        utimesSync(path, frozen, frozen);
      } catch {
        // A file that vanished between the readdir and the stat.
      }
    }
  };
  walk(sandbox.storeDir);
}

const restoreClock = pinNondeterminism();

/**
 * A client that answers every verb the same way.
 *
 * The census's registration-only stub, plus the verbs the tools reach for that
 * registration alone never calls (`putRaw`, `getAllPagesWithTruncation`,
 * `switchAccount`, `drainPendingRequests`). `getRateLimitStatus` reports the
 * "never throttled" shape: a fabricated cooldown would make every tool that
 * reports one measure the fabrication.
 */
function stubClient() {
  return {
    tokenFile: join(sandbox.storeDir, 'tokens.json'),
    get: async () => null,
    post: async () => null,
    put: async () => null,
    putRaw: async () => undefined,
    delete: async () => null,
    getAllPages: async () => [],
    getAllPagesWithTruncation: async () => ({ items: [], truncated: false }),
    getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
    switchAccount: async () => false,
    drainPendingRequests: async () => undefined,
  };
}

/**
 * Register the whole surface and invoke every tool across the case matrix.
 *
 * @returns {Promise<string>} The snapshot: one JSON object per line.
 */
export async function captureSnapshot() {
  await assertHermetic(sandbox.home);

  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { REGISTRAR_MANIFEST, loadManifestRegistrars, registerManifestModule } = await import('../src/tools/annotations.js');

  const server = new McpServer({ name: 'wire-equivalence', version: '0.0.0' });
  // Every module registers, unconditionally — the census's context, asking for
  // the whole surface rather than the curated default. A snapshot of the
  // default would miss every tool a `SPOTIFY_MCP_TOOLSETS=all` host sees, and
  // those are exactly the tools a refactor consolidates.
  const context = { readOnly: false, isModuleActive: () => true, scopeBlocked: () => false };
  for (const module of await loadManifestRegistrars(REGISTRAR_MANIFEST, context)) {
    registerManifestModule(server, stubClient(), module, context);
  }

  // InMemoryTransport binds no port. `listTools()` rather than reaching into
  // `_registeredTools`, so the argument matrix is synthesized from the schema
  // a host actually validates against — the harness cannot disagree with the
  // published contract about which arguments are required.
  const client = new Client({ name: 'wire-equivalence-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const lines = [];
  try {
    const { tools } = await client.listTools();
    const ordered = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // The `tools/list` payload itself is one snapshot line, and it is there
    // because of a measured gap rather than for tidiness. A description edit
    // and a `required` edit are wire changes a host sees at registration, and
    // NOTHING else in this repository catches them: `npm run count:tools --
    // --check` compares each module's bytes against a CEILING, so a
    // description that changes without crossing the ceiling passes. Verified
    // by perturbing `PAGED_WALK_LIST_REASON` (src/shaping.ts:397) and getting
    // exit 0 from both the harness as first written and the census.
    lines.push(serializeRecord({ tool: '<tools/list>', callCase: 'schema', args: null, result: { tools: ordered } }));
    for (const tool of ordered) {
      for (const callCase of CALL_CASES) {
        lines.push(await invoke(client, tool.name, tool.inputSchema ?? {}, callCase));
      }
    }
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * One invocation, one snapshot line.
 *
 * A tool that throws, hangs, or returns something unserializable must STILL
 * produce a line: a snapshot that silently omits an invocation compares equal
 * when a refactor made a tool uncallable, which is the worst possible failure
 * for a tool whose entire job is to catch that. So a failure is RECORDED as
 * the result — and the difference between "the tool answered" and "the tool
 * blew up" is then visible in the diff.
 */
async function invoke(client, name, schema, callCase) {
  const args = argsForCase(schema, callCase);
  let result;
  try {
    result = await withDeadline(client.callTool({ name, arguments: args }), name);
  } catch (error) {
    result = { harness_error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  normalizeSandboxTimes();
  return serializeRecord({ tool: name, callCase, args, result });
}

/**
 * Bound one invocation.
 *
 * Without this, a single tool awaiting a network timeout the stub never refuses
 * turns a 3,000-call snapshot into a hang, and a harness that hangs is one
 * nobody runs. A timeout is recorded as `harness_timeout`, so a tool that
 * starts hanging is a DIFF rather than a stall.
 */
function withDeadline(promise, tool) {
  return new Promise((resolve_, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness_timeout: ${tool} did not answer within 20s`)), 20_000);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve_(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse argv. An unknown flag is a usage error rather than a silent no-op: a
 * mistyped `--ouy` that quietly wrote to stdout would produce a snapshot the
 * reviewer believed they had on disk.
 */
function parseArgv(argv) {
  const options = { out: undefined, compare: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      options.out = argv[++index];
      if (options.out === undefined) usage('--out needs a file path');
    } else if (arg === '--compare') {
      const base = argv[++index];
      const head = argv[++index];
      if (base === undefined || head === undefined) usage('--compare needs two snapshot files');
      options.compare = [base, head];
    } else if (arg.startsWith('-')) {
      usage(`unknown option ${arg}`);
    } else {
      usage(`unexpected argument ${arg}`);
    }
  }
  return options;
}

function usage(message) {
  process.stderr.write(`wire-equivalence: ${message}\n`);
  process.stderr.write('usage: node scripts/wire-equivalence.mjs [--out <file>] [--compare <base.jsonl> <head.jsonl>]\n');
  process.exit(2);
}

const options = parseArgv(process.argv.slice(2));

if (options.compare) {
  const [basePath, headPath] = options.compare;
  // Named explicitly rather than left to `readFileSync`, because the failure
  // this guards is a silent one: a mistyped path that surfaced as a raw ENOENT
  // stack exited non-zero, which is fail-closed, but a reviewer who skimmed it
  // could reasonably read "crashed" as "did not run" — and a comparison that
  // did not run is a comparison that did not disagree. Saying which file is
  // missing, and how to produce one, is the difference between a stopped run
  // and a green one.
  for (const path of [basePath, headPath]) {
    if (!existsSync(path)) {
      process.stderr.write(
        `wire-equivalence: no snapshot at ${path}\n`
        + 'Produce one with:  node scripts/wire-equivalence.mjs --out <file>\n',
      );
      process.exit(2);
    }
  }
  const base = readFileSync(basePath, 'utf8');
  const head = readFileSync(headPath, 'utf8');
  const diff = compareSnapshots(base, head);
  process.stdout.write(formatDiff(diff));
  process.stdout.write(
    `wire-equivalence: ${diff.counts.head} invocations, digest ${digest(head)} ` +
      `(base ${diff.counts.base}, digest ${digest(base)})\n`,
  );
  const identical =
    diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0 && !diff.reordered;
  process.exitCode = identical ? 0 : 1;
} else {
  const snapshot = await captureSnapshot();
  if (options.out) {
    writeFileSync(options.out, snapshot);
    process.stderr.write(
      `wire-equivalence: ${snapshot.trimEnd().split('\n').length} invocations, digest ${digest(snapshot)} → ${options.out}\n`,
    );
  } else {
    process.stdout.write(snapshot);
  }
}

restoreClock();
process.exit(process.exitCode ?? 0);
