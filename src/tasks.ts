/**
 * MCP Tasks for the operations that take minutes rather than seconds (#600).
 *
 * ## What this is
 *
 * Every tool in this server answers `tools/call` by running to completion before
 * the response is written. For a single lookup that is the right shape. For a
 * tool that walks `/me/playlists` and then every playlist's items — or all five
 * saved collections in parallel — the call can run for minutes, and every host
 * has its own idea of how long a `tools/call` is allowed to take. A host that
 * gives up and closes the connection does not cancel the work; it just stops
 * reading the answer while the server keeps spending the account's request
 * quota on it.
 *
 * The MCP Tasks extension (`io.modelcontextprotocol/tasks`) exists for exactly
 * this: the caller sends `tools/call` with a `task` field, gets back a
 * `{ task: { taskId, status } }` handle immediately, and polls `tasks/get` until
 * the task reaches a terminal state, then reads `tasks/result`.
 *
 * ## What this deliberately is not
 *
 * **Not a way to skip the confirmation gate.** This is the failure mode the
 * design has to be built around, not a detail to handle later. A task handle
 * returns to the client in milliseconds; the bulk writes that follow happen
 * later, on a connection the client may already have abandoned. If the task
 * path had its own copy of a gated tool's logic, the gate would be exactly the
 * thing a reviewer forgets.
 *
 * So there is no separate background implementation. `startTask` runs *the
 * registered handler* — the same function `tools/call` would have awaited
 * synchronously, with the same `extra`, through the same confirmation
 * boundary. There is no code path in which the writes happen without
 * `confirmViaElicitation` running, because the code that does the writes is the
 * code that asks.
 *
 * That is also why the gate survives a client that cannot prompt. `extra` is
 * carried through to the detached run unchanged, so a client that never
 * advertised elicitation produces the same `'unsupported'` verdict it produces
 * synchronously, and `requiredConfirmationRefusal` fails closed exactly as it
 * does there. `SPOTIFY_MCP_CONFIRM=never` remains the only bypass, and it is
 * honoured identically in both paths. See `tests/tasks.test.ts`.
 *
 * **Not a new source of truth about what happened.** Three specific lies this
 * file is built to refuse, all of the #803/#830 shape:
 *
 * - A task whose work returned an error, or a confirmation refusal, is never
 *   reported `completed`. `completed` means the operation finished and said so.
 *   "Said so" is the operative half: in this server a handler reports failure
 *   as `structuredContent.ok === false`, not as `isError`, so `ok: false` is
 *   read as the failure it is.
 * - A task that was aborted reports `cancelled`, and its stored result says what
 *   the abort is known to have done — a partial run is never presented as a
 *   whole one, and a run that finished before the stop landed is not described
 *   as though it had not.
 * - A task found `working` on disk by a NEW process was interrupted by the
 *   restart and never finished. It is reconciled to `failed` at startup with
 *   that stated in `statusMessage`; it is never carried forward as in-flight,
 *   because nothing is in flight any more.
 *
 * ## Cancellation
 *
 * The SDK's `tasks/cancel` handler only writes `'cancelled'` into the task
 * store and clears the side-channel queue. It does not abort anything: nothing
 * in the SDK knows what work a task is doing. So this store owns an
 * `AbortController` per task, `updateTaskStatus` aborts it when the status
 * becomes `cancelled`, and the signal is what the detached run reads through
 * `runInCancellationContext`.
 *
 * That lands on real work because `src/client.ts` already resolves
 * `currentRequestSignal()` at walk entry and checks it at the top of every
 * page. A cancelled bulk operation therefore stops issuing requests between
 * pages, which is the granularity `getAllPages` has always had (#676).
 *
 * ## Durability
 *
 * `InMemoryTaskStore` is documented by the SDK as unsuitable for production
 * precisely because it loses everything on restart. Task state is one JSON file
 * per task under `SPOTIFY_MCP_TASKS_DIR` (default `~/.spotify-mcp/tasks/`),
 * written temp-and-rename, owner-only, and reconciled on construction.
 *
 * The scope is one process on one machine, which is what this server is: a
 * stdio server with a single account registry. Two servers sharing a task
 * directory would race, so the directory is not intended to be pointed at a
 * shared filesystem.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { CallToolResult, CreateTaskResult, Result, Task, TaskStatus } from '@modelcontextprotocol/sdk/types.js';
import type { CreateTaskOptions, TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/index.js';
import { isTerminal } from '@modelcontextprotocol/sdk/experimental/tasks/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runInCancellationContext } from './cancellation.js';
import { storePath } from './config.js';
import { asRecord } from './shaping.js';

// ---------------------------------------------------------------------------
// The task-capable set, derived from the code and not from the issue
// ---------------------------------------------------------------------------

/**
 * Tools whose cost scales with the size of the account's library, so that a
 * large one can take minutes.
 *
 * The issue (#600) attributed this to `src/client.ts:542-579` and mentioned the
 * stats.fm taste tools. Both claims are wrong against the current tree: that
 * range is the ordinary `get` path, and the `taste` tools read stats.fm, not
 * the Spotify library. What actually takes minutes is an unbounded walk or a
 * bulk write, so the list below is derived by finding those — a `getAllPages`
 * or `getAllPagesWithTruncation` call whose page count is set by how many
 * playlists or saved items the account has, not by a bounded argument.
 *
 * Each entry is a claim about a specific call site, so that a future change to
 * any of them can be checked against the reason it was included:
 *
 * - `clean_all_playlists` — walks `/me/playlists` (`src/tools/playlists.ts:353`)
 *   and then every playlist's items (`:470`) before bulk deletes. Gated at
 *   `REMOVE_ELICIT_THRESHOLD`.
 * - `remove_duplicate_playlist_items` — full items walk per playlist
 *   (`src/tools/playlists.ts:1512`) plus a rescan after each edit (`:1597`).
 *   Gated at `REMOVE_ELICIT_THRESHOLD`.
 * - `restore_library_snapshot` — walks `/me/playlists` to build its restore
 *   plan (`src/tools/restore.ts:587`) before bulk writes. Always asks.
 * - `import_from_sidecar` — walks playlists to reconcile, then bulk-adds.
 *   Gated at `BATCH_ADD_ELICIT_THRESHOLD`.
 * - `export_all_playlists` — `/me/playlists` plus items for each
 *   (`src/tools/portability.ts:150`, `:247`, `:356`).
 * - `export_library_json` — five full saved-collection walks issued together
 *   (`src/tools/portability.ts:1007-1018`), each up to the fetch-all cap.
 * - `backup_library` — the whole-library snapshot, every saved collection plus
 *   every playlist with its items (`src/tools/backup.ts:1011`).
 * - `backup_first` — the same snapshot against the first account.
 * - `library_hygiene` — full `/me/tracks` walk (`src/tools/libraryhygiene.ts:300`).
 * - `find_duplicate_saved_tracks` — full `/me/tracks` walk
 *   (`src/tools/saveddedupe.ts:418`).
 * - `archive_played_episodes` — `/me/episodes` walk
 *   (`src/tools/episodemgmt.ts:101`) plus per-row archives. Gated at
 *   `ARCHIVE_ELICIT_THRESHOLD`.
 *
 * A single lookup is not on this list and must not be added to it: `taskSupport`
 * is a promise to the host about latency, and a promise made about a tool that
 * returns in 40ms is a promise the host cannot use.
 */
export const TASK_CAPABLE_TOOLS: readonly string[] = Object.freeze([
  'archive_played_episodes',
  'backup_first',
  'backup_library',
  'clean_all_playlists',
  'export_all_playlists',
  'export_library_json',
  'find_duplicate_saved_tracks',
  'import_from_sidecar',
  'library_hygiene',
  'remove_duplicate_playlist_items',
  'restore_library_snapshot',
]);

const TASK_CAPABLE = new Set(TASK_CAPABLE_TOOLS);

/** Whether `name` is registered as task-capable. */
export function isTaskCapable(name: string): boolean {
  return TASK_CAPABLE.has(name);
}

/**
 * Stamp `execution.taskSupport = 'optional'` on the task-capable tools.
 *
 * `optional`, not `required`: a client that does not implement the tasks
 * extension calls these tools exactly as it always has, and gets exactly the
 * synchronous answer it always got. `required` would break every existing host
 * on a server that gained a feature they never asked for.
 *
 * This is the only place that advertises the capability, and it writes into the
 * registry rather than into the `tools/list` projection, so the wire and the
 * registry cannot disagree — `installToolErrorBoundary` publishes
 * `entry.execution` as it stands.
 */
export function applyTaskSupport(server: McpServer): { total: number; stamped: number; unknown: string[] } {
  // Widened to the wire's own `Record<string, unknown>` and narrowed with
  // `asRecord`, rather than asserted into a shape the compiler never saw: the
  // claim being made is only "there is a record here keyed by tool name", and
  // `asRecord` returns the SAME object, so writing `execution` back is a write
  // to the registry rather than to a copy.
  const registry = asRecord((server as unknown as Record<string, unknown>)._registeredTools);
  if (!registry) {
    throw new Error('Spotify MCP tool registry is unavailable; refusing to start without its task boundary');
  }
  let stamped = 0;
  const unknown: string[] = [];
  for (const name of TASK_CAPABLE_TOOLS) {
    const entry = asRecord(registry[name]);
    if (!entry) {
      // A toolset that is off leaves its name unregistered. That is a supported
      // configuration, not a manifest bug, so it is reported and not thrown on.
      unknown.push(name);
      continue;
    }
    // `tool()` and `registerTool()` both hard-code `{ taskSupport: 'forbidden' }`
    // onto every entry, so `execution` is never absent here and treating it as
    // "already decided" would silently stamp nothing at all. Overwriting a
    // value that is neither `forbidden` nor already ours would mean some other
    // code decided this tool's task contract, and that must not be papered over.
    const current = asRecord(entry.execution)?.taskSupport;
    if (current !== undefined && current !== 'forbidden' && current !== 'optional') {
      throw new Error(
        `Tool ${name} already declares taskSupport: ${String(current)}; refusing to overwrite a task contract this server did not write.`,
      );
    }
    if (current === 'optional') continue;
    entry.execution = { taskSupport: 'optional' };
    stamped++;
  }
  return { total: Object.keys(registry).length, stamped, unknown };
}

// ---------------------------------------------------------------------------
// The durable store
// ---------------------------------------------------------------------------

const TASK_DIR_MODE = 0o700;
const TASK_FILE_MODE = 0o600;
/** Terminal task records kept on disk, so the directory cannot grow without bound. */
const MAX_TASK_RECORDS = 200;
/** Default lifetime of a task record when the caller asks for none. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Default suggested poll interval for a task, in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 2000;

/** What this store keeps per task, on one file. */
interface TaskRecord {
  task: Task;
  /** The tool that owns the task; the store's own provenance, not the wire's. */
  toolName: string;
  /** JSON-RPC request id that created the task, kept for diagnostics. */
  requestId: string | number;
  /** Stored once the task reaches a terminal state, if it produced one. */
  result?: Result;
  /** The transport session the task belongs to, when there was one. */
  sessionId?: string;
}

/**
 * Where task records live.
 *
 * A thin delegation to the `tasks` entry in `LOCAL_STORES`, not a second copy
 * of the default: `store-paths.test.ts` enforces that a store path is spelled
 * in exactly one place, and a second spelling is how the registry that `logout`
 * erases and this path drift apart.
 */
export function tasksDir(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('tasks', env);
}

/**
 * Whether it is safe for the constructor to reconcile a store rooted here.
 *
 * `reconcile()` is destructive by design: it renames every unparseable record
 * to `.corrupt` and drops every terminal record past its TTL. That is correct
 * for a real restart of a real server, and wrong for every other caller that
 * happens to construct the store — because "the previous process died" is a
 * claim about a process, and nothing in the filesystem establishes it (#1635).
 *
 * The failure this guards was reported as a mystery: an empty `tasks/`
 * directory appeared in a real `~/.spotify-mcp/` at a time its author was not
 * working, and the only process that had done it was a script importing server
 * code without a sandbox home. Nothing about that run looked wrong. `mkdirSync`
 * succeeding and `reconcile()` finding nothing to quarantine are exactly what a
 * healthy startup looks like, so the destructive default was silent — and on a
 * home that *did* hold in-flight records it would have renamed a user's real
 * `working` tasks to `.corrupt` and deleted their expired ones.
 *
 * So the store refuses to touch records it cannot justify touching. It creates
 * the directory and says so on stderr; it does not read, rename, rewrite or
 * delete a single record. A real `npm run dev` is unaffected in every way a
 * user can observe except one: the first start after a crash leaves the
 * previous run's `working` records alone instead of settling them, and the
 * message says why and names the opt-out.
 *
 * ## Why not simply "is this a temp dir?"
 *
 * Checking for `/tmp` would be a guess about where sandboxes live, and it
 * would be wrong for every one of them: a container, a devcontainer, a CI
 * runner with a custom `TMPDIR`, and a user who relocated their home to
 * somewhere else entirely. The hermetic helper redirects `HOME`, so the tests
 * that matter resolve under the temp root while the *resolved path* is
 * compared, not the string that produced it.
 *
 * ## Why not "is this the real home?"
 *
 * That is the same guess pointed the other way — it would forbid the one
 * caller that is entitled to reconcile. A user running the server normally is
 * not a hazard; a *second* process standing a store up beside a real install
 * is. The distinguishing question is not where the data is but whether the
 * caller has claimed it, which is what the opt-out below records.
 */
function reconcilePermitted(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // Exact compare, no trim, matching `SPOTIFY_MCP_CONFIRM` in
  // `src/tools/confirm.ts`. The bypass that skips a destructive step is
  // spelled one way and only one way; tolerating `'never '` would mean a
  // shell that appends a stray character arms it anyway, and the whole point
  // of requiring the value to be typed deliberately is that it cannot happen
  // by accident. An earlier draft of this used `.trim()`, and the near-miss
  // test caught it.
  if (env.SPOTIFY_MCP_ALLOW_REAL_HOME_STORES === 'never') return true;
  return isSandboxedHome(dir, env);
}

/**
 * True when `dir` resolves inside a home that is not the caller's real one.
 *
 * Compares *resolved* paths on both sides. The real home is captured through
 * `homedir()` on every call rather than at module load, for the reason
 * `storeDir()` in `config.ts` documents: the hermetic helper redirects `HOME`
 * after import, and a constant captured earlier would pin the answer to the
 * pre-redirect home and read as "not sandboxed" in every test.
 */
function isSandboxedHome(dir: string, env: NodeJS.ProcessEnv): boolean {
  let realHome: string;
  try {
    realHome = realpathSync.native(homedir());
  } catch {
    return false;
  }
  // Windows and macOS both hand out a case-insensitive or symlinked home
  // (`/Users/x` vs `/System/Volumes/Data/Users/x`), so a string compare of two
  // unresolved paths reports a sandbox as real. `realpathSync.native` collapses
  // both sides; the case fold is applied only where the platform is
  // case-insensitive, because on Linux two paths differing only in case are two
  // different directories and folding them would hide a real one.
  const fold = process.platform === 'win32' || process.platform === 'darwin' ? (p: string) => p.toLowerCase() : (p: string) => p;
  const target = fold(safeRealpath(dir));
  if (target === fold(realHome)) return false;
  // A store may sit below the home rather than at it (`~/.spotify-mcp/tasks`),
  // so the real home containing the store is the case that matters, and it is
  // the one a test redirecting HOME to a temp root gets right.
  return !isInside(target, fold(realHome));
}

/** `realpath` that yields the input unchanged rather than throwing. */
function safeRealpath(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return resolve(target);
  }
}

/** True when `child` is `parent` or sits below it. Both already folded. */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * A `TaskStore` that survives a process restart.
 *
 * One JSON file per task. Writes go through a temp file and a rename so a
 * reader never sees a half-written record, and a record that fails to parse is
 * moved aside rather than deleted — a corrupt file that vanishes is a record
 * that cannot be explained afterwards.
 */
export class PersistentTaskStore implements TaskStore {
  private readonly dir: string;
  /** In-flight work, keyed by task id. This is what `tasks/cancel` reaches. */
  private readonly running = new Map<string, AbortController>();
  /** Serialises writes to one task file within this process. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(dir: string = tasksDir()) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: TASK_DIR_MODE });
    chmodSync(dir, TASK_DIR_MODE);
    // The destructive half, behind a guard (#1635). Creating the directory is
    // safe and keeps a first run working; everything below can rename a
    // user's records to `.corrupt` and delete their expired ones, so it only
    // runs for a caller that has established it is the process those records
    // belong to.
    if (reconcilePermitted(dir)) {
      this.reconcile();
      return;
    }
    process.emitWarning(
      `Task store at ${dir} was left untouched: reconciling it renames unparseable records to ` +
        '.corrupt and drops terminal records past their TTL, and this process cannot establish that it ' +
        'is the server those records belong to (#1635). Set SPOTIFY_MCP_ALLOW_REAL_HOME_STORES=never ' +
        'to reconcile a real store, or point HOME at a sandbox.',
      'TaskStoreReconcileSkipped',
    );
  }

  /** Absolute path of the record for `taskId`. */
  recordPath(taskId: string): string {
    return join(this.dir, `${taskId}.json`);
  }

  /**
   * Settle every record a previous process left behind.
   *
   * A record still marked `working` or `input_required` when this process
   * started describes work that is not running and will never resume. The two
   * honest readings are "cancelled" and "failed"; `failed` is chosen because
   * the cause is the restart, not a decision anybody made, and the message
   * says so. Carrying it forward as `working` would be the #803 lie in its
   * purest form: a `tasks/get` that reports live progress for a task with no
   * process behind it.
   *
   * Terminal records past their TTL are dropped, newest first, until the cap is
   * met.
   */
  private reconcile(): void {
    const records: TaskRecord[] = [];
    for (const file of this.readRecordFiles()) {
      const record = this.readRecord(file);
      if (!record) {
        this.quarantine(file);
        continue;
      }
      records.push(record);
    }
    const retained = records
      .filter((r) => isTerminal(r.task.status) && !this.expired(r))
      .sort((a, b) => a.task.createdAt < b.task.createdAt ? 1 : -1)
      .slice(0, MAX_TASK_RECORDS);
    const keep = new Set(retained.map((r) => r.task.taskId));

    for (const record of records) {
      const { taskId } = record.task;
      if (keep.has(taskId)) {
        this.writeRecord(record);
        continue;
      }
      if (isTerminal(record.task.status)) {
        this.discard(taskId);
        continue;
      }
      this.writeRecord({
        ...record,
        task: {
          ...record.task,
          status: 'failed',
          statusMessage: `Interrupted: the server restarted while this ${record.toolName} task was still ${record.task.status}. The work did not finish, and this task will not resume.`,
          lastUpdatedAt: new Date().toISOString(),
        },
      });
    }
  }

  /** True when a terminal record is older than its own TTL. */
  private expired(record: TaskRecord): boolean {
    if (record.task.ttl === null) return false;
    const created = Date.parse(record.task.createdAt);
    if (Number.isNaN(created)) return false;
    return Date.now() - created > record.task.ttl;
  }

  private readRecordFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  private readRecord(file: string): TaskRecord | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.dir, file), 'utf8'));
      if (!isTaskRecord(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private quarantine(file: string): void {
    try {
      renameSync(join(this.dir, file), join(this.dir, `${file}.corrupt`));
    } catch {
      /* a file we cannot move is a file we cannot explain; leave it alone */
    }
  }

  private writeRecord(record: TaskRecord): void {
    const file = this.recordPath(record.task.taskId);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(this.dir, { recursive: true, mode: TASK_DIR_MODE });
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: TASK_FILE_MODE });
    // A creation-time mode leaves a pre-existing file readable by others, so
    // the final file is re-asserted owner-only after the rename, exactly as the
    // receipts trail does it.
    renameSync(tmp, file);
    chmodSync(file, TASK_FILE_MODE);
  }

  private discard(taskId: string): void {
    try {
      rmSync(this.recordPath(taskId), { force: true });
    } catch {
      /* pruning is housekeeping; failing to prune must not fail a task */
    }
  }

  /**
   * Serialise the read-modify-write of one task's record.
   *
   * The store is reachable from the request handler, the detached worker, and
   * the SDK's `tasks/cancel` handler at the same time, and each of those does
   * read-then-write. Without this, a status update landing between another's
   * read and write is silently lost — which for a cancel means a cancelled task
   * that never stops.
   */
  private serialise<T>(taskId: string, fn: () => Promise<T> | T): Promise<T> {
    const prior = this.chains.get(taskId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.chains.set(taskId, next.catch(() => undefined));
    return next;
  }

  async createTask(taskParams: CreateTaskOptions, requestId: string | number, request: unknown, sessionId?: string): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      taskId: randomUUID(),
      status: 'working',
      // The caller may ask for a longer lifetime than we keep; capping it is the
      // store's documented prerogative, and the value actually in force is
      // what the Task carries back, so the client can see the cap it got.
      ttl: Math.min(taskParams.ttl ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS),
      createdAt: now,
      lastUpdatedAt: now,
      pollInterval: taskParams.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
      statusMessage: 'Started.',
    };
    const record: TaskRecord = {
      task,
      toolName: toolNameOf(request),
      requestId: typeof requestId === 'number' ? requestId : String(requestId),
      ...(sessionId === undefined ? null : { sessionId }),
    };
    this.writeRecord(record);
    return task;
  }

  async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
    return this.readRecord(`${taskId}.json`)?.task ?? null;
  }

  async storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result, _sessionId?: string): Promise<void> {
    await this.serialise(taskId, () => {
      const record = this.requireRecord(taskId);
      record.result = result;
      // A cancel that arrived while the work was finishing is not undone by the
      // work finishing. The client asked to stop; the task reads `cancelled`,
      // and the result it can still fetch is the real one.
      const terminal = isTerminal(record.task.status) ? record.task.status : status;
      record.task = {
        ...record.task,
        status: terminal,
        statusMessage: describeTerminal(terminal, result),
        lastUpdatedAt: new Date().toISOString(),
      };
      this.writeRecord(record);
      if (terminal === 'cancelled') this.abort(taskId);
    });
  }

  async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
    const record = this.requireRecord(taskId);
    if (record.result === undefined) {
      // The SDK reaches this for any terminal task. Saying "no result" without
      // saying why would read as a server fault; the reason is the whole point.
      throw new Error(
        `Task ${taskId} is ${record.task.status} and stored no result.` +
        (record.task.statusMessage ? ` ${record.task.statusMessage}` : ''),
      );
    }
    return record.result;
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, statusMessage?: string, _sessionId?: string): Promise<void> {
    await this.serialise(taskId, () => {
      const record = this.requireRecord(taskId);
      record.task = {
        ...record.task,
        status,
        ...(statusMessage === undefined ? null : { statusMessage }),
        lastUpdatedAt: new Date().toISOString(),
      };
      this.writeRecord(record);
      // This is the hook `tasks/cancel` pulls. The SDK's own cancel handler
      // only writes the status and clears the side-channel queue; nothing in
      // the SDK knows what work the task is doing, so the abort has to start
      // here or the bulk write keeps running with nobody reading the answer.
      if (status === 'cancelled') this.abort(taskId);
    });
  }

  async listTasks(cursor?: string, _sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const all: Task[] = [];
    for (const file of this.readRecordFiles()) {
      const record = this.readRecord(file);
      if (record) all.push(record.task);
    }
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const start = cursor === undefined ? 0 : Math.max(0, all.findIndex((t) => t.taskId === cursor) + 1);
    const page = all.slice(start, start + MAX_TASK_RECORDS);
    const next = start + MAX_TASK_RECORDS < all.length ? page[page.length - 1]?.taskId : undefined;
    return next === undefined ? { tasks: page } : { tasks: page, nextCursor: next };
  }

  private requireRecord(taskId: string): TaskRecord {
    const record = this.readRecord(`${taskId}.json`);
    if (!record) throw new Error(`Task not found: ${taskId}`);
    return record;
  }

  // -- the abort registry ---------------------------------------------------

  /**
   * Register the controller for a task that is about to start running, and
   * return the signal the detached run must be given.
   *
   * A cancel can land between `createTask` and this call, because the client
   * learns the task id from the first response and can answer before the work
   * has been scheduled. Attaching therefore re-reads the record: a task that is
   * already cancelled is aborted on the spot rather than being started and
   * then stopped at the next page boundary, which would still have issued the
   * first page's requests.
   */
  async attach(taskId: string): Promise<AbortSignal> {
    const record = this.readRecord(`${taskId}.json`);
    if (!record) throw new Error(`Task not found: ${taskId}`);
    if (record.task.status === 'cancelled') {
      return AbortSignal.abort();
    }
    const controller = new AbortController();
    this.running.set(taskId, controller);
    return controller.signal;
  }

  /** Drop the controller for a finished task. */
  detach(taskId: string): void {
    this.running.delete(taskId);
  }

  private abort(taskId: string): void {
    const controller = this.running.get(taskId);
    if (!controller || controller.signal.aborted) return;
    controller.abort(new Error(`Task ${taskId} was cancelled.`));
  }

  /** Test-only: whether a controller is still attached for `taskId`. */
  hasController(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Test-only: the number of attached controllers. */
  get runningCount(): number {
    return this.running.size;
  }
}

function isTaskRecord(value: unknown): value is TaskRecord {  if (value === null || typeof value !== 'object') return false;
  const record = value as { task?: { taskId?: unknown; status?: unknown; createdAt?: unknown } };
  return typeof record.task?.taskId === 'string'
    && typeof record.task.status === 'string'
    && typeof record.task.createdAt === 'string';
}

/** The `statusMessage` a terminal task carries, read off its own result. */
function describeTerminal(status: TaskStatus, result: Result): string {
  if (status === 'cancelled') return cancelMessage(result);
  if (status === 'failed') {
    const text = firstText(result);
    return text ? `Failed: ${text}` : 'Failed.';
  }
  return 'Finished.';
}

function firstText(result: Result): string | undefined {
  if (result === null || typeof result !== 'object' || !('content' in result)) return undefined;
  const content = (result as CallToolResult).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const value = (part as { text?: unknown }).text;
      if (typeof value === 'string' && value.length > 0) return value.slice(0, 400);
    }
  }
  return undefined;
}

/** The `structuredContent` record a result carries, or undefined. */
function structuredRecord(result: Result | undefined): Record<string, unknown> | undefined {
  if (result === null || result === undefined || typeof result !== 'object') return undefined;
  if (!('structuredContent' in result)) return undefined;
  const structured = (result as CallToolResult).structuredContent;
  if (structured === null || typeof structured !== 'object') return undefined;
  return structured as Record<string, unknown>;
}

/**
 * The `statusMessage` for a cancelled run, claimed only as far as the result goes.
 *
 * `signal.aborted` says a human asked to stop. It does not say the stop landed
 * before the last write: a cancel that arrives while the handler is already
 * returning aborts a run whose work is done, and "the run stopped partway" over a
 * stored `{ok: true, removed: 3, total: 3}` asserts something that did not
 * happen — the same class of claim as a `0 streams` for a page that would not
 * read. The stored result is the evidence, so the message reports what it shows,
 * and says plainly that it shows nothing when that is the case.
 */
function cancelMessage(result: Result | undefined): string {
  if (structuredRecord(result)?.ok === true) {
    return 'Cancelled after the work finished: the stored result reports the operation completed before the stop landed.';
  }
  const text = result === undefined ? undefined : firstText(result);
  return text === undefined
    ? 'Cancelled; the run produced no result, so whether the work finished is not established.'
    : `Cancelled; the stored result does not report the work as complete — ${text}`;
}

// ---------------------------------------------------------------------------
// Starting a task
// ---------------------------------------------------------------------------

/** The pieces `startTask` needs from the `tools/call` boundary. */
export interface TaskStartRequest {
  /** Parsed handler arguments. */
  args: unknown;
  /** The `extra` the SDK built for this request, carried through unchanged. */
  extra: unknown;
  /** The `tools/call` request, for provenance in the record. */
  request: unknown;
  /** The `task` field the caller sent, if any. */
  taskParams: CreateTaskOptions;
  /** The store this server was started with. */
  store: PersistentTaskStore;
  /**
   * Runs the registered handler. Same function the synchronous path awaits.
   *
   * The task's abort signal is passed in rather than captured, because the
   * controller does not exist until `startTask` has persisted the task and
   * checked it for a cancel that arrived in between.
   */
  run: (signal: AbortSignal) => Promise<CallToolResult>;
}

/**
 * Start `run` in the background and return the `CreateTaskResult` handle.
 *
 * The task's terminal status is decided by what `run` actually did, never by
 * the fact that it returned:
 *
 * - it threw, or returned a result with `isError` or a non-refusal
 *   `structuredContent.ok === false` → `failed`
 * - it returned a confirmation refusal → `cancelled` when a human said no,
 *   `failed` when consent could not be established at all, because "we could
 *   not ask" and "the user declined" are different facts
 * - the task's own controller aborted → `cancelled`
 * - anything else → `completed`
 *
 * A refusal is detected structurally (`structuredContent.ok === false` with
 * `cancelled: true`), which is the shape `requiredConfirmationRefusal` builds
 * in `src/tools/confirm.ts`. A tool that has no confirmation gate never
 * produces it, so this cannot misread an ordinary result.
 */
export async function startTask(request: TaskStartRequest): Promise<CreateTaskResult> {
  const { store, run, extra } = request;
  const task = await store.createTask(request.taskParams, requestIdOf(request.request), request.request, sessionIdOf(extra));
  const created: CreateTaskResult = { task };

  void (async () => {
    let signal: AbortSignal;
    try {
      signal = await store.attach(task.taskId);
    } catch {
      // `attach` only fails when the record vanished underneath us. Nothing
      // ran, so there is nothing truthful to report; the task reads as failed.
      return;
    }
    try {
      const result = await runInCancellationContext(signal, () => run(signal));
      const outcome = terminalOutcome(result, signal);
      // The SDK's `storeTaskResult` only speaks 'completed' and 'failed', so a
      // cancelled run is written as failed first and then restated as
      // cancelled. The restatement is the one the client reads, and it is the
      // honest one: the run did not fail, a human stopped it.
      await store.storeTaskResult(
        task.taskId,
        outcome.status === 'completed' ? 'completed' : 'failed',
        result,
      );
      if (outcome.status === 'cancelled') {
        await store.updateTaskStatus(task.taskId, 'cancelled', outcome.message);
      }
    } catch (error) {
      const cancelled = signal.aborted;
      // No result to read: the run threw. The message can say it was cancelled
      // and that the throw is the reason, and it cannot say the work stopped
      // partway, because a run can throw on its way out of a finished write.
      const message = cancelled
        ? cancelMessage(undefined)
        : `Failed: ${errorText(error)}`;
      const status: TaskStatus = cancelled ? 'cancelled' : 'failed';
      // A failure still gets a result, so `tasks/result` answers with the reason
      // instead of the store's "stored no result" error — but the STATUS is the
      // failed one, so nothing reads as completed that did not complete.
      await store.storeTaskResult(task.taskId, 'failed', failureResult(message));
      await store.updateTaskStatus(task.taskId, status, message);
    } finally {
      store.detach(task.taskId);
    }
  })();

  return created;
}

/** Decide a task's terminal status from what its run returned. */
function terminalOutcome(result: CallToolResult, signal: AbortSignal): { status: TaskStatus; message?: string } {
  if (signal.aborted) {
    // First, and it stays first: a refusal or an `ok: false` that arrives from
    // work the cancel already killed would otherwise be read as the run's own
    // verdict rather than the stop a human asked for.
    return { status: 'cancelled', message: cancelMessage(result) };
  }
  const refusal = refusalOf(result);
  if (refusal) {
    return refusal === 'declined'
      ? { status: 'cancelled', message: 'The confirmation prompt was declined; nothing was changed.' }
      : { status: 'failed', message: 'Confirmation could not be established, so nothing was changed.' };
  }
  if (result?.isError === true) {
    return { status: 'failed', message: `Failed: ${firstText(result) ?? 'the tool reported an error.'}` };
  }
  // `ok: false` that is not a refusal is this codebase's failure signal, and it
  // is NOT a synonym for `isError`: `src/result.ts` makes an absent `isError`
  // mean `false` and most tools never set it, so a handler can report that it
  // did nothing and still hand back a result MCP calls a success. The quota
  // cooldown in `library_hygiene` and `find_duplicate_saved_tracks` is that
  // shape — `ok: false, cooldown: true, requests_made: 0` — and it arrives after
  // any 429, which is routine rather than exotic; `export_all_playlists` returns
  // it when the account identity will not read. Both modules say in their own
  // comments that a host must be able to read `ok === true` as "the scan
  // completed", which is only true if this arm exists. Without it a run that did
  // no work at all reads `completed` and `Finished.`, the one thing this file's
  // header promises never to report. A refusal is already gone by this point, so
  // `ok: false` here never reclassifies a decline.
  if (structuredRecord(result)?.ok === false) {
    return { status: 'failed', message: `Failed: ${firstText(result) ?? 'the tool reported that it did not complete.'}` };
  }
  return { status: 'completed' };
}

/**
 * The confirmation refusal a result carries, or null.
 *
 * `declined` is a human saying no; the other two are consent never having been
 * obtainable. `ElicitRefusal.payload` omits `reason` for the declined case, so
 * the absence of the field is the discriminator rather than a guess.
 */
function refusalOf(result: CallToolResult): 'declined' | 'unavailable' | null {
  const structured = result?.structuredContent;
  if (structured === null || typeof structured !== 'object') return null;
  const payload = structured as { ok?: unknown; cancelled?: unknown; reason?: unknown };
  if (payload.ok !== false || payload.cancelled !== true) return null;
  return payload.reason === undefined ? 'declined' : 'unavailable';
}

/** A result that says what went wrong, for a run that never produced one. */
function failureResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'the task raised a non-Error value.';
}

function requestIdOf(request: unknown): string | number {
  if (request !== null && typeof request === 'object' && 'id' in request) {
    const id = (request as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return 'unknown';
}

/**
 * The tool a task belongs to, read off the request that created it.
 *
 * Named rather than left blank so the restart reconciliation can say which
 * operation was interrupted: "this `backup_library` task was still working" is
 * a diagnosis, and "this task was still working" is a shrug.
 */
function toolNameOf(request: unknown): string {
  if (request !== null && typeof request === 'object' && 'params' in request) {
    const name = (request as { params?: { name?: unknown } }).params?.name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'unknown';
}

function sessionIdOf(extra: unknown): string | undefined {
  if (extra !== null && typeof extra === 'object' && 'sessionId' in extra) {
    const id = (extra as { sessionId?: unknown }).sessionId;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/** Test-only: drop a task's file and in-memory trace. */
export function __resetTaskStoreForTests(dir: string): void {
  for (const file of readdirSync(dir)) {
    try {
      statSync(join(dir, file));
      rmSync(join(dir, file), { force: true });
    } catch {
      /* nothing to remove */
    }
  }
}
