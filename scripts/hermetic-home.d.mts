/**
 * Types for `scripts/hermetic-home.mjs`.
 *
 * The helper is plain JavaScript because it is a Node script that runs before
 * any build step, but a test importing it is typechecked by the ratcheting
 * gate introduced in #1408, and that gate refuses a NEW test file that arrives
 * with type errors. Without this file every importer gets TS7016 (the `.mjs`
 * module implicitly types as `any`) plus a cascade of implicit-`any`
 * parameters — the two errors this declaration removes from
 * `tests/harness-hermetic-home.test.ts`.
 *
 * This is a declaration of the real exports, not a widening. If a signature
 * here stops matching the implementation, the test fails at the call site
 * rather than quietly degrading to `any` — which is the point of the gate.
 */
import type { ChildProcess } from 'node:child_process';

/** A disposable home plus the environment confined to it. */
export interface HarnessSandbox {
  /** The `mkdtemp` root that stands in for the developer's `$HOME`. */
  home: string;
  /** `home/.spotify-mcp` — where every pinned store resolves. */
  storeDir: string;
  /** The exact environment a harness child is spawned with. */
  env: Record<string, string>;
  /** Where the copied token file was written, or null when there was none. */
  tokenFile: string;
  /** The copy, or null when the developer has not run `npm run auth`. */
  seeded: string | null;
  /** Remove the sandbox. Idempotent. */
  cleanup(): void;
}

export declare const REPO_ROOT: string;

/** Is `candidate` `root` itself, or something under it? Both resolved first. */
export declare function isInside(root: string, candidate: string): boolean;

/** Every store variable, pinned to its documented default under `storeDir`. */
export declare function sandboxStorePins(storeDir: string): Record<string, string>;

/** Throws unless every store in the registry resolves inside `home` under `env`. */
export declare function assertStoresInsideSandbox(
  env: Record<string, string>,
  home: string,
): Promise<true>;

export declare function createHarnessHome(options?: {
  label?: string;
  realEnv?: NodeJS.ProcessEnv;
}): Promise<HarnessSandbox>;

export declare function spawnHarnessServer(options: {
  label: string;
  args: string[];
  cwd?: string;
  stdio?: Array<'pipe' | 'inherit' | 'ignore'>;
  env?: Record<string, string>;
}): Promise<{ child: ChildProcess; sandbox: HarnessSandbox }>;
