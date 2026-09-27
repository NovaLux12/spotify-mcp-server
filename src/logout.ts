/**
 * `spotify-mcp logout` — disconnect this machine from a Spotify account (#704).
 *
 * Before this command there was no supported way to revoke the token and clear
 * the local sidecars: a user who wanted to disconnect had to find each file
 * themselves. This module is that path.
 *
 * Two halves, and the second is the one that can silently fail:
 *
 * 1. **Remote revocation.** Spotify publishes no token-revocation endpoint. The
 *    Web API OpenAPI schema (70 paths, 96 operationIds) has no revoke path, and
 *    the word appears once — in an error description stating revocation is an
 *    event the *user* performs. There is therefore no HTTP call here to make.
 *    Inventing one would be worse than the gap: an endpoint that does not exist
 *    returns 404/410 and would read as success. Logout says plainly that the
 *    token must be revoked by hand at https://www.spotify.com/account/apps/.
 *
 * 2. **Local erasure.** Every store this build can write is resolved through
 *    the module that owns it — no path string is retyped here — and then erased
 *    under the rules below.
 *
 * ## Erasure rules
 *
 * - **Refuse, never delete, a path that is not where the owning module says it
 *   belongs.** Containment is decided on the REAL path (via `realpathAllowingMissing`),
 *   because a check run on the raw string is bypassable by a symlinked parent —
 *   the same class as #623. A symlinked store is refused too: the link is not
 *   ours to follow, and the target is not what the user asked about. So is a
 *   path whose kind is not the kind the owning module declared (#1309): a
 *   directory sitting at `scenes.json` is inside its own store directory by
 *   construction, so containment cannot see it, and moving it would erase a tree
 *   this server never wrote. The refusal names what is actually there.
 * - **Reversible where reversibility is possible.** Sidecars move to the
 *   freedesktop trash (`gio trash`) or, on filesystems that refuse trashing
 *   (tmpfs, some network mounts), into a quarantine directory beside the
 *   original. Nothing is `rm -rf`'d, and no directory is ever removed by
 *   recursion — the whole directory is *moved*, contents and all.
 * - **The token file is the exception.** A revoked-nowhere refresh token sitting
 *   readable in `~/.local/share/Trash/files/` is a live credential, which is the
 *   failure this whole command exists to prevent. It is overwritten and unlinked
 *   instead. This is one known file, not a recursive delete.
 *
 * `logout` is deliberately a CLI command and not an MCP tool: a destructive
 * tool would join the `tools/list` surface and every host would gain the
 * ability to erase the user's own credentials unattended. The argument is the
 * capability, not the size of the surface, so it states no tool count —
 * `scripts/check-doc-tool-counts.mjs` is what would catch one appearing.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';

import { accountsFile } from './accounts.js';
import { cachePendingPath, cachePendingPaths, cachePersistPath, cachePersistPaths } from './cachepersist.js';
import { resolveTokenFile } from './config.js';
import { historyFilePath, historyLedgerPaths } from './history.js';
import { exportRootDir, isInsideRoot, realpathAllowingMissing } from './paths.js';
import { receiptsFilePath, receiptsFilePaths } from './receipts.js';
import { tasksDir } from './tasks.js';
import { artistWatchlistPath } from './tools/artistwatch.js';
import { backupDir } from './tools/backup.js';
import { requiredConfirmationRefusal } from './tools/confirm.js';
import type { ElicitRefusal } from './tools/confirm.js';
import { miscFilePath } from './tools/exhaust2_misc.js';
import { exhaust2PlaybackFile } from './tools/exhaust2_playback.js';
import { watermarkFilePath } from './tools/freshness.js';
import { genreTagsPath } from './tools/libraryinsights.js';
import { portabilityDir } from './tools/portability.js';
import { snapshotDir as playlistHealthSnapshotDir } from './tools/playlisthealth.js';
import { playbackExtFile } from './tools/playbackext.js';
import { scenesFilePath } from './tools/scenes.js';
import { searchHistoryFile } from './tools/searchhistory.js';
import { tasteFeedbackFile } from './tools/statsfm_taste.js';
import { snapshotDir as swarm3SnapshotDir } from './tools/swarm3_snapshots.js';

const run = promisify(execFile);

/** Where a user revokes an app by hand, since no API exists. */
export const MANUAL_REVOCATION_URL = 'https://www.spotify.com/account/apps/';

/** The one store that is overwritten rather than moved — it holds a live credential. */
const CREDENTIAL_STORE_ID = 'token';

export type StoreErasure = 'shred' | 'move';

export interface LocalStore {
  /** Stable key used in output and tests. */
  id: string;
  /** Human name for the store. */
  label: string;
  /** Whether the store is a single file or a directory of files. */
  kind: 'file' | 'dir';
  /** Absolute path as this environment resolves it. */
  path: string;
  /** The directory the owning module places the store in. */
  root: string;
  erasure: StoreErasure;
  /** Env var that relocates it, for the report. Null when there is none. */
  envVar: string | null;
}

interface StoreDefinition {
  id: string;
  label: string;
  kind: LocalStore['kind'];
  envVar: string | null;
  erasure: StoreErasure;
  resolve: (env: NodeJS.ProcessEnv) => string;
  /**
   * Set when the owning module can name MORE THAN ONE file for this store — the
   * persisted read cache is one file per account (#1300). Each path becomes its
   * own store and gets its own id, so every one of them is planned, refused, and
   * reported on individually; leaving the second account's file out would be
   * invisible in the report, which is the failure this whole module is about.
   * `resolve` still runs, and supplies the paths when `expand` is absent.
   */
  expand?: (env: NodeJS.ProcessEnv) => string[];
}

/**
 * Every local store, in the order the report lists them.
 *
 * Each `resolve` is the resolver the owning module already uses. A path string
 * retyped here would drift the moment that module changed, and the drift would
 * be silent: logout would report success while a live token stayed on disk.
 *
 * ## Relationship to `LOCAL_STORES` (#711)
 *
 * The PATH of every store here is decided in `src/config.ts`, which lists all
 * of them in `LOCAL_STORES`. This table is the *erasure* half: which of them to
 * delete, in what order, by shredding or by moving aside — decisions no path
 * registry can make, because "may this be erased" is a policy question and
 * "where does it live" is a fact about one machine.
 *
 * So the two lists are not redundant and neither subsumes the other, which
 * means the interesting property is that they AGREE. `tests/store-paths.test.ts`
 * asserts it, and asserts the differences by name: `cache` /
 * `cache-pending-marker` resolve through `getTokenFilePath()` in `auth.ts`,
 * which also reads argv, so `config.ts` cannot own them. That difference is a
 * fact about where a path is DECIDED, and it is permanent.
 *
 * The other direction has no permanent answer, so it has no named map.
 * `accounts` and `taste-feedback` were registered stores that this list did
 * not erase (#1434) — a coverage gap, not a policy, and the test recorded it
 * rather than fixing it. A gap recorded in a test is still a gap: the suite
 * passed on the strength of the difference being DECLARED, so `logout` reported
 * a clean sweep while leaving behind the record of which accounts exist on this
 * machine and every stats.fm verdict the user had accumulated. They are erased
 * here now, and `NOT_ERASED_BY_LOGOUT` in that test is empty; a store added to
 * one list and not the other now fails the suite instead of being excused.
 */
const STORE_DEFINITIONS: StoreDefinition[] = [
  {
    id: CREDENTIAL_STORE_ID,
    label: 'OAuth tokens',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_TOKEN_FILE',
    erasure: 'shred',
    resolve: (env) => resolveTokenFile(env),
  },
  {
    id: 'accounts',
    label: 'Account registry',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_ACCOUNTS_FILE',
    // `move`, not `shred`: this file names token-file PATHS and account ids,
    // never token material, so leaving it recoverable costs nothing and a
    // user who logs out by mistake can put it back. Only `CREDENTIAL_STORE_ID`
    // holds a live refresh token, and it is the only store that is shredded.
    erasure: 'move',
    resolve: (env) => accountsFile(env),
  },
  {
    id: 'mutations',
    label: 'Mutation history',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_HISTORY_DIR',
    erasure: 'move',
    // `resolve` is the single-file answer, correct on a machine with one
    // account; `expand` is what actually runs, because a machine with profiles
    // has one ledger per profile and leaving those behind would orphan them.
    //
    // It keys off `resolveTokenFile(env)`, the same resolver the credential
    // store above uses (#1385). Naming no token file resolved to the DEFAULT
    // account's ledger, so on `SPOTIFY_MCP_PROFILE=work` this would have
    // reported the default account's file as the active account's mutation
    // history. `expand` masked it by always winning, but the answer was wrong
    // and the store no longer tolerates an unnamed account.
    //
    // `expand` names the rotated generation beside each live ledger too
    // (#703). Rotation moves the live file to `mutations.jsonl.1` and starts a
    // fresh one, so the archive is the OLDER half of the same audit trail —
    // erasing the live file alone would report a clean sweep and leave half
    // the trail on disk, which is the outcome this command exists to prevent.
    resolve: (env) => historyFilePath(env, resolveTokenFile(env)),
    expand: (env) => historyLedgerPaths(env),
  },
  {
    id: 'receipts',
    label: 'Write receipts',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_RECEIPTS_DIR',
    erasure: 'move',
    // One trail per account, for the same reason as the mutation ledger above.
    // Keyed off the same `resolveTokenFile(env)` as that entry, and the same
    // credential store, so all three name one account rather than three
    // independent guesses at it (#1385).
    resolve: (env) => receiptsFilePath(env, resolveTokenFile(env)),
    expand: (env) => receiptsFilePaths(env),
  },
  {
    id: 'tasks',
    label: 'MCP task records',
    kind: 'dir',
    envVar: 'SPOTIFY_MCP_TASKS_DIR',
    // `move` for the reason the receipt ledger gives: a task record says which
    // tool ran and what it did, which is a description of the user's library
    // and their own operation history, but it is recoverable history rather than
    // a live credential. Nothing in it can be replayed against Spotify.
    erasure: 'move',
    resolve: (env) => tasksDir(env),
  },
  {
    id: 'scenes',
    label: 'Scenes',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_SCENES_FILE',
    erasure: 'move',
    resolve: (env) => scenesFilePath(env),
  },
  {
    id: 'genre-tags',
    label: 'Genre tags',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_GENRE_TAGS_FILE',
    erasure: 'move',
    resolve: (env) => genreTagsPath(env),
  },
  {
    id: 'playback-extensions',
    label: 'Playback extensions',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_PLAYBACKEXT_FILE',
    erasure: 'move',
    resolve: (env) => playbackExtFile(env),
  },
  {
    id: 'search-history',
    label: 'Search history',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_SEARCH_HISTORY_FILE',
    erasure: 'move',
    resolve: (env) => searchHistoryFile(env),
  },
  {
    id: 'artist-watchlist',
    label: 'Artist watchlist',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_DATA_DIR',
    erasure: 'move',
    resolve: (env) => artistWatchlistPath(env),
  },
  {
    id: 'taste-feedback',
    label: 'stats.fm taste feedback',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_TASTE_FEEDBACK_FILE',
    // Identity-free, like every other store here: the entries are subject ids,
    // ratings and timestamps. `move` for the same reason as the account
    // registry — there is no credential in this file to shred, and the
    // verdicts are the user's own accumulated data, so a recoverable move is
    // the right default. It resolves through the data directory, so it is a
    // CHILD of the kept container and is erased individually by the nesting
    // rule rather than with it.
    erasure: 'move',
    resolve: (env) => tasteFeedbackFile(env),
  },
  {
    id: 'freshness',
    label: 'Freshness watermark',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_FRESHNESS_STATE',
    erasure: 'move',
    resolve: (env) => watermarkFilePath(env),
  },
  {
    id: 'exhaust2-misc',
    label: 'Extended sidecar (misc)',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_EXHAUST2_MISC_FILE',
    erasure: 'move',
    resolve: (env) => miscFilePath(env),
  },
  {
    id: 'exhaust2-playback',
    label: 'Extended sidecar (playback)',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE',
    erasure: 'move',
    resolve: (env) => exhaust2PlaybackFile(env),
  },
  {
    id: 'backups',
    label: 'Backups',
    kind: 'dir',
    envVar: 'SPOTIFY_MCP_BACKUP_DIR',
    erasure: 'move',
    resolve: (env) => backupDir(env),
  },
  {
    id: 'playlist-snapshots',
    label: 'Playlist snapshots',
    kind: 'dir',
    envVar: 'SPOTIFY_MCP_SNAPSHOT_DIR',
    erasure: 'move',
    resolve: (env) => swarm3SnapshotDir(env),
  },
  {
    id: 'playlist-health-snapshots',
    label: 'Playlist health snapshots',
    kind: 'dir',
    envVar: 'SPOTIFY_MCP_DATA_DIR',
    erasure: 'move',
    resolve: (env) => playlistHealthSnapshotDir(env),
  },
  {
    id: 'portability',
    label: 'Portability export/import state',
    kind: 'dir',
    envVar: 'SPOTIFY_MCP_PORTABILITY_DIR',
    erasure: 'move',
    resolve: (env) => portabilityDir(env),
  },
  {
    id: 'cache',
    label: 'Persisted read cache',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_DATA_DIR',
    erasure: 'move',
    // `resolve` is the single-file answer, correct on a machine with one
    // account; `expand` is what actually runs, because the active profile's file
    // is only ever one of the files a machine with profiles has.
    resolve: (env) => cachePersistPath(env),
    expand: (env) => cachePersistPaths(env),
  },
  {
    id: 'cache-pending-marker',
    label: 'Persisted read cache: pending-save marker',
    kind: 'file',
    envVar: 'SPOTIFY_MCP_DATA_DIR',
    erasure: 'move',
    // `expand` for the same reason the cache above has it (#1356). With only
    // `resolve`, logout named the ACTIVE profile's marker and left every other
    // profile's behind — and a marker that outlives the cache it describes is
    // read by the next start of that profile as a session that died mid-save,
    // which reports a loss of data the operator just deliberately erased.
    resolve: (env) => cachePendingPath(env),
    expand: (env) => cachePendingPaths(env),
  },
  {
    id: 'exports',
    label: 'Exports',
    kind: 'dir',
    envVar: 'SPOTIFY_MCP_EXPORT_DIR',
    erasure: 'move',
    resolve: (env) => exportRootDir(env),
  },
];

export interface StorePathsOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Mirrors `spotify-mcp auth --profile`. */
  profile?: string;
}

/**
 * The one environment a run is against.
 *
 * Both halves of `logout` have to agree on it, and they used to disagree: the
 * store paths were resolved from a caller-supplied `env` while the
 * home-directory refusal in {@link planErasure} fell back to `os.homedir()`,
 * the *process* home. One resolution, handed to both (#1358).
 */
export function resolveStoreEnv(options: StorePathsOptions = {}): NodeJS.ProcessEnv {
  return options.profile && options.profile.length > 0
    ? { ...(options.env ?? process.env), SPOTIFY_MCP_PROFILE: options.profile }
    : (options.env ?? process.env);
}

/**
 * Resolve every store for an environment.
 *
 * The token resolver is `resolveTokenFile` — config.ts is the authority for the
 * token path in this checkout (there is no `dataDir` field on the config type
 * yet); every other path comes from the module that writes it.
 *
 * A definition that `expand`s contributes one store per path, each with the file
 * name in its id. The id is a map key in {@link planErasure}'s real-path
 * bookkeeping, so two stores sharing one id would make the second overwrite the
 * first and the containment check would then be reasoning about the wrong file.
 */
export function localStorePaths(options: StorePathsOptions = {}): LocalStore[] {
  const cwd = options.cwd ?? process.cwd();
  const env = resolveStoreEnv(options);

  return STORE_DEFINITIONS.flatMap((def) => {
    const paths = (def.expand ? def.expand(env) : [def.resolve(env)]).map((p) => resolve(p));
    // An `expand`er always yields ids carrying the file name, even when it
    // yields exactly one: the count is a property of the machine's profiles, not
    // of the store, and an id that changed shape with it would not be a stable
    // key for a report or a test.
    return paths.map((path) => ({
      id: def.expand ? `${def.id}:${basename(path)}` : def.id,
      label: def.label,
      kind: def.kind,
      path,
      root: def.kind === 'dir' ? path : dirname(path),
      erasure: def.erasure,
      envVar: def.envVar,
    }));
  });
}

export type EraseDecision =
  | { store: LocalStore; action: 'erase' }
  | { store: LocalStore; action: 'absent' }
  | { store: LocalStore; action: 'keep'; reason: string }
  | { store: LocalStore; action: 'refuse'; reason: string };

export interface PlanOptions {
  home?: string;
  /**
   * The environment the stores were resolved from — the same object
   * {@link localStorePaths} was handed.
   *
   * `home` alone is not the whole story, and leaving it to be the whole story
   * is the bug this closes (#1358). A store path comes from one of two places:
   * an explicit `SPOTIFY_MCP_*` override, which is relative to *this*
   * environment's `HOME`, or a module default, which falls through to
   * `os.homedir()` and therefore to the *process* home. A caller that supplied
   * an env had the first kind redirected and the second kind checked against a
   * root it never named, so a store that resolved to the home it had declared
   * was approved for erasure.
   */
  env?: NodeJS.ProcessEnv;
  /** `--keep-backups`: the backup library is user data, not session state. */
  keepBackups?: boolean;
}

/**
 * Every home this run's store paths could sit at, resolved once.
 *
 * A store is refused if it is any of them, so supplying an `env` can only make
 * the guard stricter. Replacing the process home with the declared one instead
 * would be a loosening: the stores with no override of their own still resolve
 * through `os.homedir()`, and those are exactly the ones the process-home check
 * was written for.
 */
function eraseGuardHomes(options: PlanOptions): string[] {
  const candidates = [homedir(), options.env?.HOME, options.home];
  return [
    ...new Set(
      candidates
        .filter((home): home is string => typeof home === 'string' && home.length > 0)
        .map((home) => resolve(home)),
    ),
  ];
}

/**
 * Decide, per store, whether it may be erased — without touching it.
 *
 * The refusal rule lives here and nowhere else, so every path that could be
 * erased passes the same check regardless of which code path asked.
 */
export async function planErasure(
  stores: LocalStore[],
  options: PlanOptions = {},
): Promise<EraseDecision[]> {
  const homes = eraseGuardHomes(options);
  const decisions: (EraseDecision | null)[] = [];
  // Real path per store, needed by the containment check below even for stores
  // that turn out to be absent.
  const reals = new Map<string, string>();

  for (const store of stores) {
    if (options.keepBackups && store.id === 'backups') {
      decisions.push({ store, action: 'keep', reason: 'kept by --keep-backups' });
      continue;
    }

    const rootReal = await realpathAllowingMissing(store.root);
    const pathReal = await realpathAllowingMissing(store.path);
    reals.set(store.id, pathReal);

    let info;
    try {
      // lstat, not stat: a symlinked store must be visible as a link here.
      info = await fs.lstat(store.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        decisions.push({ store, action: 'absent' });
      } else {
        decisions.push({
          store,
          action: 'refuse',
          reason: `cannot inspect: ${(err as Error).message}`,
        });
      }
      continue;
    }

    if (info.isSymbolicLink()) {
      let target = 'unreadable target';
      try {
        target = await fs.realpath(store.path);
      } catch {
        /* a broken link is still a link */
      }
      decisions.push({
        store,
        action: 'refuse',
        reason: `is a symlink to ${target}; refusing to erase through a link`,
      });
      continue;
    }

    if (!isInsideRoot(rootReal, pathReal)) {
      decisions.push({
        store,
        action: 'refuse',
        reason: `resolves to ${pathReal}, outside its own store directory ${rootReal}`,
      });
      continue;
    }

    // Belt-and-braces. A misconfigured env var can point a store at a directory
    // that has no business being erased, and none of the above would catch it
    // because the path would be inside its own root by construction.
    const refusal = dangerousEraseTarget(pathReal, rootReal, homes);
    if (refusal) {
      decisions.push({ store, action: 'refuse', reason: refusal });
      continue;
    }

    // A file-kind store whose path is a directory is refused (#1309). Checked
    // last of the refusals on purpose: the reason this branch produces reads the
    // directory, and it should only ever read one already shown to sit inside
    // its own store directory.
    if (store.kind === 'file' && !info.isFile()) {
      decisions.push({
        store,
        action: 'refuse',
        reason: await unexpectedKindReason(store, info),
      });
      continue;
    }

    decisions.push(null); // resolved in the second pass
  }

  // Second pass: a directory store that *contains* another store is kept, not
  // erased. This is not hypothetical — `SPOTIFY_MCP_DATA_DIR` is itself the
  // playlist health snapshot directory, so with that variable set that store
  // resolves to the data directory, and the stores that resolve through that
  // variable sit INSIDE it.
  //
  // The relationship is parent-and-child, not superset. The data directory is a
  // PARENT of the stores `SPOTIFY_MCP_DATA_DIR` relocates; every other store on
  // this list still resolves under `~/.spotify-mcp/` whatever the variable says.
  // An earlier version of this comment called it "the data directory holding
  // every other store", which is false, and the falsehood was copied verbatim
  // into `docs/configuration.md` from here — which is the argument for not
  // restating a number in prose at all. The count the user is shown is the
  // `nested` length below, and that one is computed.
  //
  // Erasing the parent would take the children with it, which is the opposite
  // of the enumerate-then-remove promise this command makes. It is reported
  // under "Not erased" rather than silently dropped, and it is not a failure:
  // the container is a directory, and the stores inside it are erased
  // individually.
  for (let i = 0; i < stores.length; i += 1) {
    if (decisions[i] !== null) continue;
    const store = stores[i]!;
    const mine = reals.get(store.id)!;
    const nested = stores
      .filter((other) => other.id !== store.id)
      .filter((other) => {
        const theirs = reals.get(other.id);
        return theirs !== undefined && (theirs === mine || isInsideRoot(mine, theirs));
      })
      .map((other) => other.id);

    decisions[i] =
      nested.length > 0
        ? {
            store,
            action: 'keep',
            reason: `is the data directory itself, holding ${nested.length} other store(s); those were erased individually`,
          }
        : { store, action: 'erase' };
  }

  return decisions as EraseDecision[];
}

/** True when the resolved path is one that must never be erased, whatever the store says. */
function dangerousEraseTarget(
  pathReal: string,
  rootReal: string,
  homes: readonly string[],
): string | null {
  if (pathReal === parse(pathReal).root) return 'is a filesystem root';
  if (homes.includes(pathReal)) return 'is the home directory';
  if (pathReal !== rootReal && isInsideRoot(pathReal, rootReal)) {
    return `is an ancestor of its own store directory ${rootReal}`;
  }
  return null;
}

/**
 * How many entries a refusal names before it counts the rest.
 *
 * The point of naming them is that the user can recognise the path and decide
 * for themselves. The cap keeps a store pointed at something large — a home
 * directory, a checkout — from turning one refusal line into a page of output.
 */
const MAX_NAMED_ENTRIES = 12;

/**
 * Refuse a file-kind store whose path is not a file (#1309).
 *
 * `logout` erases by the *declared* kind, and a `kind: 'file'` path that is a
 * **directory** passed both refusals that did exist — the symlink rule, and
 * containment, which a directory at `scenes.json` satisfies by construction
 * because its own root is `dirname(path)`. The whole tree was moved while the
 * report named one path, the directory, and nothing inside it.
 * `docs/configuration.md` promises every removed path is printed so the report
 * can be checked against the disk, and for that shape it was not.
 *
 * The refusal, not the erasure, is the point: the path is not what the user was
 * asked about, which is the same ground the symlink rule refuses one branch
 * above, and a stale store is a far cheaper outcome than erased user data. So
 * the reason names what is actually there — a directory the user may not
 * recognise is not something to leave for them to work out alone.
 *
 * **The reverse is deliberately not a refusal.** A `kind: 'dir'` path holding a
 * regular file is erased, because the harm is not symmetric: this side removes
 * exactly one inode, at the store's own path, non-recursively and reversibly,
 * and that path is what the user asked about. Refusing it would mean logout
 * could never clear that store and would exit non-zero forever over a
 * leftover. What it gets is the naming fix in {@link storeContents} — before
 * this, a file at a dir-kind path was erased and reported as `[]` files, a path
 * removed and named by nothing.
 */
async function unexpectedKindReason(store: LocalStore, info: Stats): Promise<string> {
  // Neither a file nor a directory — a fifo, socket or device node. Nothing
  // worth enumerating, and the shape alone is reason enough to stop.
  if (!info.isDirectory()) {
    return 'is not a regular file, which is the kind this store is declared to be; refusing rather than erasing a path of a kind nothing here wrote';
  }

  const entries = await readdirEntries(store.path);
  return (
    'is a directory, not a file, which is the kind this store is declared to be; ' +
    `refusing rather than moving it. ${await describeEntries(entries)}`
  );
}

/** Read the top level only. A refusal names contents, it does not walk them. */
async function readdirEntries(path: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function describeEntries(entries: Dirent[] | null): Promise<string> {
  if (entries === null) return 'its contents could not be read';
  if (entries.length === 0) return 'it is empty';
  const names = entries
    .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, MAX_NAMED_ENTRIES);
  const more = names.length - shown.length;
  const noun = names.length === 1 ? 'entry' : 'entries';
  // "top level" is load-bearing. The path is printed above, so the user can go
  // and look, but a report that read as an inventory would be making a promise
  // this does not keep.
  return `it holds ${names.length} top-level ${noun}: ${shown.join(', ')}${
    more > 0 ? `, and ${more} more` : ''
  }`;
}

export type EraseStatus = 'erased' | 'refused' | 'failed';

export interface EraseOutcome {
  store: LocalStore;
  status: EraseStatus;
  /** How it was removed. */
  mechanism?: 'shred' | 'gio-trash' | 'quarantine';
  /** Where a moved store went — the trash, or the quarantine path. */
  destination?: string;
  /** Every path the store covered, so the report can name what was removed. */
  files: string[];
  reason?: string;
}

/** Recursively list the files a directory store would take with it. */
export async function enumerateFiles(target: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(target, entry.name);
    if (entry.isDirectory()) out.push(...(await enumerateFiles(full)));
    else out.push(full);
  }
  return out;
}

/** Quarantine directory for stores the filesystem will not let us trash. */
function quarantineDir(target: string, stamp: string): string {
  return join(dirname(target), `.spotify-mcp-logout-quarantine-${stamp}`);
}

/**
 * Every path a move will take with it, for the report.
 *
 * Asked of the filesystem rather than of the store's declared `kind`, because
 * the declared kind is exactly the thing that can be wrong (#1309). Two shapes
 * it gets wrong:
 *
 * - a regular file at a `kind: 'dir'` path. `enumerateFiles` on a file is `[]`,
 *   so the path was moved and the report named no files at all.
 * - anything moved by `gio trash`. The store is gone from its own path by the
 *   time an after-the-move enumeration could run, and the trash is not somewhere
 *   this process can walk, so that enumeration returned `[]` too.
 *
 * So it is read once, before the move, and handed back by {@link moveAside}.
 */
async function storeContents(path: string): Promise<string[]> {
  try {
    const info = await fs.lstat(path);
    if (info.isDirectory()) return await enumerateFiles(path);
  } catch {
    /* unreadable or already gone: name the path we tried to move */
  }
  return [path];
}

/**
 * Overwrite then unlink a single file.
 *
 * Never called on a directory: a recursive delete is the one thing this command
 * must never do, because a store path can be a directory the user pointed at.
 */
async function shredFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(path, 'r+');
  } catch (err) {
    return `could not open for overwrite: ${(err as Error).message}`;
  }
  try {
    const stats = await handle.stat();
    if (stats.size > 0) {
      // One pass of zeros. SSD/flash garbage collection makes multi-pass
      // shredding theatre; the goal is that the bytes are not still readable.
      await handle.write(Buffer.alloc(stats.size), 0, stats.size, 0);
      await handle.sync();
    }
    await handle.truncate(0);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    return `could not overwrite: ${(err as Error).message}`;
  }
  await handle.close().catch(() => undefined);
  try {
    await fs.unlink(path);
  } catch (err) {
    return `overwrote but could not unlink: ${(err as Error).message}`;
  }
  return null;
}

/**
 * Move a store out of the way, reversibly.
 *
 * Tries the freedesktop trash first, then a quarantine directory beside the
 * original (same filesystem, so `rename` cannot fail with EXDEV). If both
 * refuse, the store is left untouched and the failure is reported — there is no
 * unlink fallback.
 *
 * What the store covered is enumerated here, before the move, and handed back
 * for the report. Enumerating afterwards cannot answer the question: a trashed
 * store is gone from `store.path` and the trash has no destination we can walk,
 * and a store whose declared kind does not match what is there has nothing to
 * walk in the first place — a regular file at a `kind: 'dir'` path enumerates
 * as no files at all, which is a path removed and named by nothing (#1309).
 */
async function moveAside(
  store: LocalStore,
  stamp: string,
  allowGioTrash: boolean,
): Promise<
  | { mechanism: 'gio-trash' | 'quarantine'; destination?: string; files: string[] }
  | { error: string }
> {
  const files = await storeContents(store.path);
  let trashFailure: string | null = null;

  if (allowGioTrash) {
    try {
      await run('gio', ['trash', '--', store.path]);
      return { mechanism: 'gio-trash', files };
    } catch (err) {
      trashFailure = (err as Error).message.split('\n')[0];
    }
  }

  try {
    const qdir = quarantineDir(store.path, stamp);
    await fs.mkdir(qdir, { recursive: true, mode: 0o700 });
    const destination = join(qdir, basename(store.path));
    await fs.rename(store.path, destination);
    return { mechanism: 'quarantine', destination, files };
  } catch (err) {
    const why = (err as Error).message.split('\n')[0];
    return {
      error: trashFailure
        ? `gio trash failed (${trashFailure}) and quarantine failed (${why}); left in place`
        : `quarantine failed (${why}); left in place`,
    };
  }
}

export interface EraseOptions {
  stamp?: string;
  /** Tests set this false to exercise the quarantine path directly. */
  allowGioTrash?: boolean;
}

export async function eraseStore(
  store: LocalStore,
  options: EraseOptions = {},
): Promise<EraseOutcome> {
  const stamp = options.stamp ?? 'quarantine';
  const allowGioTrash = options.allowGioTrash ?? true;

  if (store.erasure === 'shred') {
    const error = await shredFile(store.path);
    if (error) return { store, status: 'failed', files: [store.path], reason: error };
    return { store, status: 'erased', mechanism: 'shred', files: [store.path] };
  }

  const moved = await moveAside(store, stamp, allowGioTrash);
  if ('error' in moved) {
    return { store, status: 'failed', files: [store.path], reason: moved.error };
  }
  return {
    store,
    status: 'erased',
    mechanism: moved.mechanism,
    destination: moved.destination,
    files: moved.files,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface LogoutOptions {
  dryRun: boolean;
  keepBackups: boolean;
  profile?: string;
  /** `--purge-data`: requested explicitly. Erasure is unconditional, so this records the ask. */
  purgeData?: boolean;
}

export class LogoutUsageError extends Error {}

/**
 * Parse logout's flags. An unrecognised flag is an error, not a no-op: a
 * silently ignored `--force` would look like the command honoured it.
 */
export function parseLogoutArgs(argv: string[]): LogoutOptions {
  const opts: LogoutOptions = { dryRun: false, keepBackups: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--keep-backups') opts.keepBackups = true;
    // `--purge-data` is the AC's spelling of what logout already does: it
    // erases every local store unless a narrower flag says otherwise. It is
    // accepted, and recorded, so a script that asks for erasure explicitly
    // does not have to know that erasure is unconditional (#703). It changes
    // no decision below; `--keep-backups` and `--profile` still narrow the
    // sweep, and this flag does not widen it.
    else if (arg === '--purge-data') opts.purgeData = true;
    else if (arg === '--profile') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new LogoutUsageError('--profile requires a profile name');
      }
      opts.profile = value;
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (value.length === 0) throw new LogoutUsageError('--profile requires a profile name');
      opts.profile = value;
    } else {
      throw new LogoutUsageError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export const LOGOUT_HELP = `Usage: spotify-mcp logout [options]

Disconnect this machine: erase every local store and tell you how to revoke the
Spotify access token. Spotify publishes no token-revocation API, so the token
itself must be revoked by hand — logout prints the address.

Options:
  --dry-run          List what would be erased; erase nothing
  --purge-data       Erase the local stores (the default; accepted so a script
                     can ask for it explicitly)
  --keep-backups     Leave the backups/ library in place
  --profile <name>   Act on a named profile (as with \`auth --profile\`)`;

/** One line per store, whatever the action. */
function storeLine(id: string, label: string, action: string, detail: string): string {
  return `  ${id.padEnd(26)} ${action.padEnd(12)} ${label} — ${detail}`;
}

/**
 * Render the report. Returns a string rather than printing so the tests can
 * assert on exactly what a user is shown.
 */
export function renderReport(
  decisions: EraseDecision[],
  outcomes: EraseOutcome[],
  opts: { dryRun: boolean },
): string {
  const lines: string[] = [];
  lines.push('spotify-mcp logout');
  lines.push('');
  lines.push(
    'Spotify has no token-revocation API. Revoke this app by hand, otherwise the',
    'access it was just granted stays live:',
    `  ${MANUAL_REVOCATION_URL}  →  Connected Apps  →  Remove`,
    '',
  );

  if (opts.dryRun) {
    lines.push('Dry run — nothing was erased.', '');
    for (const d of decisions) {
      if (d.action === 'erase') {
        lines.push(storeLine(d.store.id, d.store.label, 'would erase', d.store.path));
      } else if (d.action === 'keep') {
        lines.push(storeLine(d.store.id, d.store.label, 'kept', d.reason));
      } else if (d.action === 'absent') {
        lines.push(storeLine(d.store.id, d.store.label, 'absent', d.store.path));
      } else {
        lines.push(storeLine(d.store.id, d.store.label, 'REFUSED', d.reason));
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  lines.push('Erased:');
  for (const o of outcomes) {
    if (o.status !== 'erased') continue;
    const how =
      o.mechanism === 'shred'
        ? 'overwritten and unlinked'
        : o.mechanism === 'gio-trash'
          ? 'moved to trash'
          : `moved to ${o.destination}`;
    lines.push(storeLine(o.store.id, o.store.label, 'erased', how));
    for (const file of o.files) lines.push(`      ${file}`);
  }

  const notErased = outcomes.filter((o) => o.status !== 'erased');
  const skipped = decisions.filter(
    (d) => d.action === 'keep' || d.action === 'refuse' || d.action === 'absent',
  );
  if (skipped.length > 0) {
    lines.push('');
    lines.push('Not erased:');
    for (const d of skipped) {
      if (d.action === 'keep') {
        lines.push(storeLine(d.store.id, d.store.label, 'kept', d.reason));
      } else if (d.action === 'absent') {
        lines.push(storeLine(d.store.id, d.store.label, 'absent', 'not present'));
      } else {
        lines.push(storeLine(d.store.id, d.store.label, 'REFUSED', d.reason));
      }
    }
  }
  if (notErased.some((o) => o.status === 'failed')) {
    lines.push('');
    lines.push('Some stores could not be erased and are still on disk:');
    for (const o of notErased) {
      if (o.status !== 'failed') continue;
      lines.push(storeLine(o.store.id, o.store.label, 'FAILED', o.reason ?? 'unknown'));
    }
  }

  const quarantined = outcomes.filter((o) => o.mechanism === 'quarantine');
  if (quarantined.length > 0) {
    lines.push('');
    lines.push(
      'Recoverable copies (empty them once you are sure you do not want them):',
    );
    for (const o of quarantined) lines.push(`  ${o.destination}`);
  }

  // A refused store is still on disk, and it produces no outcome — only
  // `action: 'erase'` stores are ever handed to `eraseStore` — so counting
  // outcomes alone printed "Local stores cleared" directly beneath a list of
  // stores that were not cleared. The exit code has always counted refusals
  // (see `runLogout`); this line now agrees with it.
  const refusedCount = decisions.filter((d) => d.action === 'refuse').length;
  const incomplete = notErased.length > 0 || refusedCount > 0;

  lines.push('');
  lines.push(
    incomplete
      ? 'Logout incomplete — see the stores above that are still on disk.'
      : 'Local stores cleared. `spotify-mcp auth` reconnects.',
  );
  lines.push(`Revoke the Spotify access token at ${MANUAL_REVOCATION_URL}`);
  lines.push('');
  return lines.join('\n');
}

export interface LogoutIo {
  isInteractive: boolean;
  ask: (prompt: string) => Promise<string>;
  write: (text: string) => void;
}

export const defaultLogoutIo: LogoutIo = {
  isInteractive: Boolean(process.stdin.isTTY),
  ask: (prompt) =>
    new Promise((resolveAnswer) => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (chunk) => resolveAnswer(String(chunk)));
      process.stderr.write(prompt);
    }),
  write: (text) => process.stdout.write(text),
};

/**
 * Run `logout`. Returns the process exit code; it never calls process.exit, so
 * a test can drive the whole command.
 */
export async function runLogout(
  argv: string[],
  io: LogoutIo = defaultLogoutIo,
  options: { env?: NodeJS.ProcessEnv; cwd?: string; allowGioTrash?: boolean } = {},
): Promise<number> {
  let opts: LogoutOptions;
  try {
    opts = parseLogoutArgs(argv);
  } catch (err) {
    io.write(`${(err as Error).message}\n\n${LOGOUT_HELP}\n`);
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Resolved once and handed to both halves. This used to be passed only to the
  // store paths, so a caller-supplied `HOME` redirected where the stores were
  // read from while the home-directory refusal in `planErasure` still ran
  // against `os.homedir()` — and a store resolving to the home the caller had
  // declared was approved for erasure (#1358). The profile override is already
  // folded in here, so `localStorePaths` needs nothing else.
  const env = resolveStoreEnv({ env: options.env, profile: opts.profile });
  let stores: LocalStore[];
  try {
    stores = localStorePaths({ env, cwd: options.cwd });
  } catch (err) {
    io.write(`Cannot resolve the Spotify profile: ${(err as Error).message}\n`);
    return 2;
  }

  const decisions = await planErasure(stores, { keepBackups: opts.keepBackups, env });
  const outcomes: EraseOutcome[] = [];

  if (opts.dryRun) {
    io.write(renderReport(decisions, outcomes, { dryRun: true }));
    return 0;
  }

  const toErase = decisions.filter((d): d is Extract<EraseDecision, { action: 'erase' }> =>
    d.action === 'erase',
  );

  if (toErase.length > 0) {
    const refusal = await confirmErasure(toErase, io);
    if (refusal) {
      io.write(`${refusal.message}\n`);
      return 1;
    }
  }

  for (const decision of toErase) {
    outcomes.push(
      await eraseStore(decision.store, {
        stamp,
        allowGioTrash: options.allowGioTrash,
      }),
    );
  }

  io.write(renderReport(decisions, outcomes, { dryRun: false }));
  // A refusal or a failure is a non-zero exit: reporting success while a live
  // token stayed on disk is the exact bug this command was written to close.
  // Refusals are counted here, not just failures, because a refused store is
  // precisely a store that is still on disk.
  const refused = decisions.some((d) => d.action === 'refuse');
  return refused || outcomes.some((o) => o.status !== 'erased') ? 1 : 0;
}

/**
 * Ask before erasing, then hand the verdict to the existing gate.
 *
 * The gate is not reimplemented here. A TTY maps to 'confirmed'/'declined', a
 * non-TTY to 'unsupported', and a read error to 'error' — the same three
 * answers `confirmViaElicitation` produces — so the fail-closed behaviour and
 * the `SPOTIFY_MCP_CONFIRM=never` bypass are the ones already in force for
 * destructive MCP tools. A second mechanism here could drift from that one.
 */
async function confirmErasure(
  toErase: Extract<EraseDecision, { action: 'erase' }>[],
  io: LogoutIo,
): Promise<ElicitRefusal | null> {
  if (process.env.SPOTIFY_MCP_CONFIRM === 'never') {
    return requiredConfirmationRefusal('unsupported');
  }
  if (!io.isInteractive) {
    return requiredConfirmationRefusal('unsupported');
  }

  io.write(
    [
      'About to erase:',
      ...toErase.map((d) => `- ${d.store.id}: ${d.store.path}`),
      '',
      'Spotify cannot revoke the token for you; you must still do that by hand.',
      'Proceed? [y/N] ',
    ].join('\n'),
  );

  let answer: string;
  try {
    answer = await io.ask('');
  } catch {
    return requiredConfirmationRefusal('error');
  }
  const verdict = /^\s*y(es)?\s*$/i.test(answer) ? 'confirmed' : 'declined';
  return requiredConfirmationRefusal(verdict);
}
