/**
 * Types for `scripts/lib/preflight.mjs`.
 *
 * Same contract as `scripts/hermetic-home.d.mts`: the module is plain
 * JavaScript because it runs before any build step, but a test importing it is
 * covered by the ratcheting typecheck gate (#1408), which refuses a NEW test
 * file that arrives with type errors. Without this declaration the import is
 * TS7016 and every parameter downstream becomes an implicit `any`.
 *
 * These are declarations of the real exports, not a widening. If a signature
 * here drifts from the implementation the test fails at the call site instead
 * of degrading to `any` — which is the whole point of the gate.
 */

/** One unmet precondition, and the command that meets it. */
export interface MissingPrecondition {
  /** `build` | `registry` | `credentials` | `client-id` */
  id: string;
  /** What is wrong, naming the path. */
  problem: string;
  /** The command that fixes it. */
  fix: string;
}

/**
 * The two events `guardChild` subscribes to.
 *
 * Narrower than `ChildProcess` deliberately: the guard reads nothing else, and
 * a declaration demanding the full 16-property type would make the guard
 * untestable without a stub that fakes a process. A real `ChildProcess`
 * satisfies this.
 */
export interface SpawnTarget {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** What a refused run needs to say. */
export interface SpawnGuard {
  /** The first cause — a spawn `error` wins over the `exit` that follows it. */
  failure(): Error | null;
  /** False once the child has been seen to exit. */
  alive(): boolean;
}

/** Where the built server is resolved from, honouring the same override. */
export declare function distRootFor(root: string, env?: NodeJS.ProcessEnv): string;

export declare function collectMissing(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MissingPrecondition[]>;

export declare function formatFailure(label: string, missing: MissingPrecondition[]): string;

export declare function assertPreconditions(options?: {
  label?: string;
  root: string;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  exit?: (code: number) => void;
}): Promise<MissingPrecondition[]>;

export declare function guardChild(
  child: SpawnTarget,
  options?: { label?: string; onFail?: (err: Error) => void },
): SpawnGuard;
