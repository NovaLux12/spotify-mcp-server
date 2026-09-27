/**
 * Types for `scripts/lib/mcp-client.mjs`.
 *
 * Same contract as `scripts/hermetic-home.d.mts` — see that file for why a
 * plain-JS script under `scripts/` needs a hand-written sibling. The comment
 * block on the module itself explains why the protocol version is a local
 * constant rather than an import from the SDK; `tests/lib-mcp-client.test.ts` is
 * what keeps that choice honest.
 */
import type { ChildProcess } from 'node:child_process';

import type { HarnessSandbox, SpawnGuard } from './preflight.mjs';

/** Options for {@link connect}. */
export interface ConnectOptions {
  /** Harness name. Shows in errors and names the sandbox directory. */
  label: string;
  /** `clientInfo.name`. Defaults to `label`. */
  name?: string;
  /** `clientInfo.version`. */
  version?: string;
  /** Where `dist/index.js` is resolved from. */
  cwd?: string;
  /** Defaults to {@link MCP_PROTOCOL_VERSION}. */
  protocolVersion?: string;
  /** Per-request bound. Defaults to {@link RPC_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Node args. Defaults to the hermetic `--env-file-if-exists=.env` spawn. */
  args?: string[];
  /** Layered onto the sandbox environment. */
  env?: Record<string, string>;
}

/** A live connection to the built server. */
export interface McpClient {
  /** One JSONL request. Rejects `timeout: <method>` on expiry. */
  rpc(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  /** `tools/call`, returning the raw MCP result. */
  callTool(name: string, args: unknown): Promise<any>;
  /** Join a result's content blocks, as all three harnesses did. */
  textOf(result: unknown): string;
  child: ChildProcess;
  sandbox: HarnessSandbox;
  /** The revision the server actually negotiated, for a report to name. */
  negotiatedVersion: string;
  childState: SpawnGuard;
  /** Reap the child and fail anything still in flight. */
  close(): void;
}

export declare const MCP_PROTOCOL_VERSION: string;
export declare const RPC_TIMEOUT_MS: number;
export declare const ERROR_TEXT_CAP: number;

/** Does this text say the endpoint is app-registration-gated (or removed)? */
export declare function looksGated(text: unknown): boolean;

export declare function connect(options: ConnectOptions): Promise<McpClient>;
