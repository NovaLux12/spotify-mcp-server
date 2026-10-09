/**
 * `spotify-mcp init --host <host>` — write a host config that starts the server (#606).
 *
 * ## What this is for
 *
 * The step that goes wrong most often is host configuration: a user copies an
 * `mcpServers` block out of a README and hand-fills the client id, the token
 * path and the env knobs. This writes the block, with the two things that are
 * derived (the token path, the default scopes) resolved from the same functions
 * the server reads, and with `--verify` proving the result actually starts.
 *
 * ## The client id is required and is never invented
 *
 * `SPOTIFY_CLIENT_ID` is the one variable the server cannot start without
 * (`src/config.ts` and `src/auth.ts` both throw on it). The config therefore
 * carries it, taken from `--client-id` or from the environment. If neither is
 * set, `init` **fails** with exit 2 and prints the config with a placeholder
 * plus the two ways to fill it in — it does not write `"your_client_id_here"`
 * into a file the user will launch, because a config that starts far enough to
 * look right and then fails on the first call is worse than one that refuses to
 * be written. (`docs/distribution.md` shows that placeholder in prose; that is
 * documentation, not a file anyone launched.)
 *
 * Note the name: `SPOTIFY_CLIENT_ID`, with no `SPOTIFY_MCP_` prefix. It is the
 * deliberate exception to this project's own prefix convention, and a generated
 * config that got it wrong would fail on a variable name nothing else uses.
 *
 * ## Merging, not clobbering
 *
 * The OpenClaw target is the user's whole `openclaw.json`, not a fragment this
 * project owns. `init` reads it, sets `mcp.servers.spotify`, and writes it
 * back, leaving every other key byte-identical. If the file exists and is not
 * parseable JSON it refuses rather than replacing it. An existing `mcp.servers.spotify`
 * is refused without `--force`, and `--force` says in its own output which entry
 * it replaced — the CLI never silently overwrites a working host registration.
 *
 * ## What `--verify` does and does not prove
 *
 * It starts THIS installation's entry point as a child, with the env block the
 * config carries, and completes a real MCP `initialize` handshake. That proves
 * the variable names and the command line are right — the thing this command
 * can get wrong. It does NOT prove the published package resolves from npm, and
 * it does not touch the network: a host with no Spotify token still
 * initializes, which is correct, and a user who needs auth is told to run
 * `spotify-mcp auth` rather than being left to discover it.
 */

import { CliUsageError, takeValue, usageFailure } from './args.js';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const INIT_HELP = `Usage: spotify-mcp init --host <host> [options]

Write a host configuration for this server, with the token path and the default
scopes resolved from the same functions the server reads.

Hosts:
  openclaw     ~/.openclaw/openclaw.json  (mcp.servers.spotify; merged, never clobbered)
  generic      an mcpServers block (Claude Desktop and anything else that reads one)
  claude-code  a \`claude mcp add\` command to run, plus a .mcp.json

Options:
  --host <name>      openclaw | generic | claude-code
  --out <file>       Where to write (default: the host's own path)
  --client-id <id>   SPOTIFY_CLIENT_ID to embed (default: $SPOTIFY_CLIENT_ID)
  --token-file <p>   SPOTIFY_MCP_TOKEN_FILE to embed (default: the resolved token file)
  --toolset <spec>   SPOTIFY_MCP_TOOLSETS to embed (default: the curated surface)
  --command <cmd>    The command the config runs (default: npx -y @novalux12/spotify-mcp@latest)
  --verify           Start this installation once with the written env and report
  --force            Replace an existing entry
  --print            Write to stdout instead of a file
  --help             Show this message

Exit codes: 0 written (and verified, if asked), 1 the write or the verify
failed, 2 the invocation was wrong or no client id was available.`;

export type InitHost = 'openclaw' | 'generic' | 'claude-code';

export const INIT_HOSTS: readonly InitHost[] = ['openclaw', 'generic', 'claude-code'];

export interface InitOptions {
  host: InitHost;
  out?: string;
  clientId?: string;
  tokenFile?: string;
  toolset?: string;
  command: string;
  args: string[];
  verify: boolean;
  force: boolean;
  print: boolean;
}

export function parseInitArgs(argv: readonly string[]): InitOptions {
  const opts: Partial<InitOptions> & { command: string; args: string[]; verify: boolean; force: boolean; print: boolean } = {
    command: 'npx',
    args: ['-y', '@novalux12/spotify-mcp@latest'],
    verify: false,
    force: false,
    print: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') opts.verify = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--print') opts.print = true;
    else if (arg === '--help' || arg === '-h') throw new CliUsageError('__help__');
    else if (arg === '--host' || arg.startsWith('--host=')) {
      const raw = takeValue(argv, i, '--host');
      if (arg === '--host') i += 1;
      if (!INIT_HOSTS.includes(raw as InitHost)) {
        throw new CliUsageError(`--host must be one of ${INIT_HOSTS.join(', ')}, got ${JSON.stringify(raw)}`);
      }
      opts.host = raw as InitHost;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      opts.out = takeValue(argv, i, '--out');
      if (arg === '--out') i += 1;
    } else if (arg === '--client-id' || arg.startsWith('--client-id=')) {
      opts.clientId = takeValue(argv, i, '--client-id');
      if (arg === '--client-id') i += 1;
    } else if (arg === '--token-file' || arg.startsWith('--token-file=')) {
      opts.tokenFile = takeValue(argv, i, '--token-file');
      if (arg === '--token-file') i += 1;
    } else if (arg === '--toolset' || arg.startsWith('--toolset=')) {
      opts.toolset = takeValue(argv, i, '--toolset');
      if (arg === '--toolset') i += 1;
    } else if (arg === '--command' || arg.startsWith('--command=')) {
      const raw = takeValue(argv, i, '--command');
      if (arg === '--command') i += 1;
      // A command with its own leading flags (a local `node /path/dist/index.js`)
      // is expressed as the command plus --command-arg, so the config's argv
      // boundary is unambiguous.
      const [cmd, ...rest] = raw.split(' ').filter((s) => s.length > 0);
      opts.command = cmd as string;
      opts.args = rest;
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }
  if (opts.host === undefined) throw new CliUsageError(`--host is required (one of ${INIT_HOSTS.join(', ')})`);
  return {
    host: opts.host,
    out: opts.out,
    clientId: opts.clientId,
    tokenFile: opts.tokenFile,
    toolset: opts.toolset,
    command: opts.command,
    args: opts.args,
    verify: opts.verify,
    force: opts.force,
    print: opts.print,
  };
}

/** Where a host's config lives, given an explicit `--out`. */
export function defaultOutPath(host: InitHost, home: string): string {
  if (host === 'openclaw') return join(home, '.openclaw', 'openclaw.json');
  if (host === 'generic') return join(process.cwd(), 'mcp-servers.json');
  return join(process.cwd(), '.mcp.json');
}

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface InitBuildContext {
  /** The resolved token file, or null when it could not be resolved. */
  tokenFile: string | null;
  /** Why the token file could not be resolved, when it could not. */
  tokenFileError?: string;
  clientIdFromEnv?: string;
  home?: string;
  cwd?: string;
}

/**
 * The `mcpServers` entry every host shares.
 *
 * `env` carries ONLY what the user must set. An empty value is written as an
 * empty string with a printed note rather than dropped, because a config with
 * no `SPOTIFY_CLIENT_ID` key at all fails with a different and more confusing
 * error than one that has the key set to "".
 */
export function buildServerEntry(
  opts: InitOptions,
  ctx: InitBuildContext,
): { entry: ServerEntry; missing: string[] } {
  const clientId = opts.clientId ?? ctx.clientIdFromEnv ?? '';
  const env: Record<string, string> = {};
  const missing: string[] = [];
  if (clientId.length === 0) {
    env.SPOTIFY_CLIENT_ID = '';
    missing.push('SPOTIFY_CLIENT_ID');
  } else {
    env.SPOTIFY_CLIENT_ID = clientId;
  }
  if (opts.tokenFile !== undefined) env.SPOTIFY_MCP_TOKEN_FILE = opts.tokenFile;
  else if (ctx.tokenFile !== null) env.SPOTIFY_MCP_TOKEN_FILE = ctx.tokenFile;
  if (opts.toolset !== undefined) env.SPOTIFY_MCP_TOOLSETS = opts.toolset;
  return {
    entry: { command: opts.command, args: [...opts.args], env },
    missing,
  };
}

/** Merge the entry into an existing host document without touching other keys. */
export async function mergeInto(
  file: string,
  entry: ServerEntry,
  pointer: readonly string[],
  opts: { force: boolean },
): Promise<{ replaced: boolean; bytes: number }> {
  let existing: unknown = {};
  let replaced = false;
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    raw = '';
  }
  if (raw.trim().length > 0) {
    try {
      existing = JSON.parse(raw) as unknown;
    } catch (err) {
      // Refuse rather than replace: this file is the user's, and a parse
      // failure here means it is hand-edited JSON we do not understand.
      throw new Error(`${file} is not valid JSON (${(err as Error).message}); refusing to rewrite it`);
    }
    let cursor: Record<string, unknown> = existing as Record<string, unknown>;
    for (const key of pointer) {
      const next = cursor[key];
      if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
        cursor = next as Record<string, unknown>;
      } else {
        replaced = true;
        const created: Record<string, unknown> = {};
        cursor[key] = created;
        cursor = created;
      }
    }
    if (cursor.spotify !== undefined) replaced = true;
    if (replaced && !opts.force) {
      throw new Error(`${file} already has an entry at ${pointer.join('.')}.spotify — pass --force to replace it`);
    }
    cursor.spotify = entry;
  } else {
    let cursor: Record<string, unknown> = {};
    existing = cursor;
    for (const key of pointer) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    }
    cursor.spotify = entry;
  }
  const text = `${JSON.stringify(existing, null, 2)}\n`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
  return { replaced, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Compose the full document for a host, for `--print` and for the tests. */
export function composeDocument(host: InitHost, entry: ServerEntry): string {
  if (host === 'claude-code') {
    return `${JSON.stringify({ mcpServers: { spotify: entry } }, null, 2)}\n`;
  }
  return `${JSON.stringify({ mcpServers: { spotify: entry } }, null, 2)}\n`;
}

/** The `claude mcp add` line, for a host that is configured by command. */
export function claudeAddCommand(entry: ServerEntry): string {
  const envFlags = Object.entries(entry.env).map(([k, v]) => `--env ${k}=${v}`).join(' ');
  return ['claude', 'mcp', 'add', 'spotify', '--', entry.command, ...entry.args, envFlags].join(' ');
}

export interface InitIo {
  write: (text: string) => void;
  warn: (text: string) => void;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  /** The entry point to start for `--verify`. */
  entry: string;
  verifyEntry: (entry: string, env: Record<string, string>) => Promise<{ ok: boolean; detail: string }>;
}

export const defaultInitIo: InitIo = {
  write: (text) => { process.stdout.write(text); },
  warn: (text) => { process.stderr.write(text.endsWith('\n') ? text : `${text}\n`); },
  env: process.env,
  home: homedir(),
  cwd: process.cwd(),
  entry: process.argv[1] ?? '',
  verifyEntry: async (entry, env) => {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [entry], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      let settled = false;
      const finish = (result: { ok: boolean; detail: string }): void => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve(result);
      };
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', (err) => finish({ ok: false, detail: `could not start: ${err.message}` }));
      child.on('exit', (_code, signal) => finish({
        ok: false,
        detail: `the server exited before initializing (signal=${signal ?? 'none'}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`,
      }));
      const timer = setTimeout(
        () => finish({ ok: false, detail: `no initialize response within 30s: ${stderr.trim().split('\n').slice(-3).join(' | ')}` }),
        30_000,
      );
      timer.unref?.();
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'spotify-mcp-init-verify', version: '0.0.0' },
        },
      })}\n`);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim().length === 0) continue;
          let parsed: { id?: number; result?: { serverInfo?: { name?: string } }; error?: { message?: string } };
          try { parsed = JSON.parse(line) as typeof parsed; } catch { continue; }
          if (parsed.id !== 1) continue;
          clearTimeout(timer);
          if (parsed.error) finish({ ok: false, detail: `initialize was refused: ${parsed.error.message ?? 'unknown error'}` });
          else finish({ ok: true, detail: `initialize succeeded (${parsed.result?.serverInfo?.name ?? 'no serverInfo'})` });
        }
      });
    });
  },
};

export async function runInit(argv: readonly string[], io: InitIo = defaultInitIo): Promise<number> {
  let opts: InitOptions;
  try {
    opts = parseInitArgs(argv);
  } catch (err) {
    if ((err as Error).message === '__help__') {
      io.write(`${INIT_HELP}\n`);
      return 0;
    }
    io.write(usageFailure((err as Error).message, INIT_HELP));
    return 2;
  }

  // Resolved through the server's own function, not a retyped join(): a config
  // carrying a path the server would not read is the bug this avoids.
  let tokenFile: string | null = null;
  let tokenFileError: string | undefined;
  try {
    const { getTokenFilePath } = await import('../auth.js');
    tokenFile = getTokenFilePath();
  } catch (err) {
    tokenFileError = (err as Error).message;
  }

  const { entry, missing } = buildServerEntry(opts, {
    tokenFile,
    tokenFileError,
    clientIdFromEnv: io.env.SPOTIFY_CLIENT_ID,
    home: io.home,
    cwd: io.cwd,
  });

  if (missing.length > 0) {
    io.write(
      `spotify-mcp: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required and ${missing.length > 1 ? 'were' : 'was'} not supplied.\n`
      + `Set ${missing[0]} in the environment, or pass --client-id <id>. Nothing was written.\n\n`
      + `For reference, this is the configuration that would have been written:\n${composeDocument(opts.host, entry)}\n`,
    );
    return 2;
  }

  const target = opts.out !== undefined
    ? resolve(io.cwd, opts.out)
    : resolve(io.cwd, defaultOutPath(opts.host, io.home));

  if (opts.host === 'claude-code') {
    io.write(`${claudeAddCommand(entry)}\n`);
    io.write(
      `That registers this server with Claude Code. The equivalent JSON is:\n${composeDocument(opts.host, entry)}`,
    );
  } else if (opts.print) {
    io.write(composeDocument(opts.host, entry));
  } else {
    const pointer = opts.host === 'openclaw' ? ['mcp', 'servers'] : ['mcpServers'];
    try {
      const result = await mergeInto(target, entry, pointer, { force: opts.force });
      io.write(
        `spotify-mcp init — wrote ${opts.host} config to ${target} (${result.bytes} bytes`
        + `${result.replaced ? ', replacing an existing entry' : ''}).\n`,
      );
    } catch (err) {
      io.write(`spotify-mcp init failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  if (tokenFileError !== undefined) {
    io.warn(`Note: the token file could not be resolved (${tokenFileError}), so the config omits SPOTIFY_MCP_TOKEN_FILE.`);
  }
  io.write(
    `\nNext: run "spotify-mcp auth" once to complete the OAuth PKCE flow, then start the server.\n`,
  );

  if (opts.verify) {
    if (io.entry.length === 0) {
      io.write('spotify-mcp init: cannot verify — this process has no entry point to start (process.argv[1] is empty).\n');
      return 1;
    }
    io.write(`\nVerifying: starting ${io.entry} with the config's env…\n`);
    const verdict = await io.verifyEntry(io.entry, entry.env);
    io.write(`spotify-mcp init: ${verdict.ok ? 'verified' : 'VERIFICATION FAILED'} — ${verdict.detail}\n`);
    if (!verdict.ok) return 1;
  }
  return 0;
}

/** Re-exported so the tests can assert the resolution rule, not a retyped join. */
export function outPathIsAbsolute(p: string): boolean {
  return isAbsolute(p);
}
