/**
 * The one in-process MCP session every `spotify-mcp` subcommand rides on (#606).
 *
 * ## Why the CLI is an MCP client and not a second call path
 *
 * `tools`, `call`, `watch` and `export` all need to answer the same question a
 * host answers: *what does this server actually do right now, under my
 * environment?* A CLI that reached into the registrars directly could only
 * answer it by re-deriving every gate the server applies — the toolset
 * resolution, the scope filter, the read-only gate, the naming policy, the
 * per-module and aggregate schema budgets, the annotations, the error boundary
 * — and the first one it forgot would be a CLI reporting a surface no host can
 * see. Issue #606's own acceptance criterion is "`tools --json` output matches
 * `tools/list` (same names, same count)", and there is exactly one way to hold
 * that true forever: be `tools/list`.
 *
 * So this module builds the *production* server through
 * `buildMcpServer`/`resolveServerScope` — the same two functions
 * `startMcpServer` uses, exported for this — and connects a real SDK `Client`
 * to it over `InMemoryTransport`. Everything a host gets, a subcommand gets:
 * the same zod validation, the same closed input schemas, the same
 * `structuredContent.error` envelope, the same refusal on a tool the caller may
 * not run.
 *
 * ## Why in-process rather than spawning `dist/index.js` over stdio
 *
 * `scripts/surface-census.mjs` spawns a child for exactly this reason in one
 * case only: it must measure the *published* `dist`. A subcommand is not
 * measuring a published artifact, it is answering a question, and a child costs
 * a second process, a second full registry boot (~2.1 s measured) and a second
 * copy of every tool module. The transport is the only difference and neither
 * side can observe it: `InMemoryTransport` is the same `Transport` interface
 * the census and `tests/conditional.test.ts` already use against production
 * code.
 *
 * ## The elicitation capability is conditional, and that is the safety property
 *
 * `src/tools/confirm.ts` fails **closed** when the connected client cannot
 * prompt: `confirmViaElicitation` returns `'unsupported'` and
 * `requiredConfirmationRefusal` refuses. So the question this module answers
 * is not "how do I prompt" but "when may I claim I can". The answer is *only*
 * when stdin is a TTY:
 *
 *   - TTY stdin, no `--yes` → the capability is advertised and the handler
 *     asks the human on stderr, exactly as a host would.
 *   - non-TTY stdin (a pipe, CI, `$(...)`) → the capability is **not**
 *     advertised, so every gated tool takes the fail-closed refusal. A
 *     scripted `spotify-mcp call` cannot wave through a destructive write by
 *     accident, and the refusal names itself in the result.
 *   - `--yes` is deliberately NOT implemented. The only sanctioned bypass is
 *     `SPOTIFY_MCP_CONFIRM=never`, it already works through the unchanged MCP
 *     path, and a second flag here would be a second mechanism that could
 *     drift from the first.
 *
 * The capability is advertised through the `Client` constructor, not by
 * installing a handler: `confirm.ts` reads
 * `server.server.getClientCapabilities()?.elicitation`, so a handler without
 * the capability would look like it could prompt while the gate still refuses.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';

import { buildMcpServer, resolveServerScope } from '../server.js';
import { SpotifyClient } from '../client.js';
import { initConfig } from '../config.js';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

export interface CliIo {
  /** Whether a human is present to answer an elicitation prompt. */
  readonly isInteractive: boolean;
  /** Write a line to stderr. Prompts go here so stdout stays machine-readable. */
  readonly warn: (line: string) => void;
  /** Ask a yes/no question. Resolves to true only on an explicit yes. */
  readonly confirm: (message: string) => Promise<boolean>;
  /** Write the command's own output to stdout. */
  readonly write: (text: string) => void;
}

/**
 * The production IO. `confirm` reads one line from a real TTY stdin; a read
 * error, an EOF, or anything that is not an explicit yes answers `false`, so
 * an interrupted prompt refuses rather than proceeds.
 */
export const defaultCliIo: CliIo = {
  isInteractive: Boolean(process.stdin.isTTY),
  warn: (line) => { process.stderr.write(line.endsWith('\n') ? line : `${line}\n`); },
  confirm: (message) =>
    new Promise<boolean>((resolve) => {
      process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (chunk: string) => {
        resolve(/^\s*y(es)?\s*$/i.test(String(chunk)));
      });
    }),
  write: (text) => { process.stdout.write(text); },
};

export interface CliSessionOptions {
  /** Injected by tests; defaults to a real client over the real network layer. */
  readonly spotifyClient?: SpotifyClient;
  readonly io?: CliIo;
  /**
   * The token file this session's client loads, resolved by the dispatcher from
   * `--profile` through `getTokenFile()` (#606).
   *
   * Passed explicitly rather than left to the client's own argv-aware
   * `getTokenFilePath()` default, for the reason in `takeProfileFlag`: a flag's
   * behaviour should be a property of the code that read the flag, not of argv
   * reaching a module that was never told about it. Omit it and the client does
   * exactly what `spotify-mcp` itself does — same precedence, same file.
   */
  readonly tokenFile?: string;
}

/**
 * A live MCP session plus the handles a subcommand needs to shut it down.
 *
 * `server` is exposed for the one thing a `Client` cannot answer: which
 * manifest module owns each registered name, which `tools` reads from
 * `moduleToolNames` rather than from anything on the wire.
 *
 * `spotifyClient` is exposed so `--profile` can be proved rather than assumed:
 * it is the object whose `tokenFile` the flag decides, and a test that cannot
 * read it back is a test that only checks the flag did not crash.
 */
export interface CliSession {
  readonly client: Client;
  readonly server: Awaited<ReturnType<typeof buildMcpServer>>;
  readonly spotifyClient: SpotifyClient;
  readonly io: CliIo;
  close(): Promise<void>;
}

/**
 * Build the production registry and connect a real client to it.
 *
 * `announce: false` on both derivations is the whole reason a subcommand can
 * own stdout: the startup banner goes to stderr for a server whose operator
 * will read it, and is suppressed for a command whose stdout is a document
 * someone is about to pipe into `jq`. The gates themselves are untouched —
 * `assertModuleSchemaBudgets` and `assertAggregateSurfaceBudget` still throw
 * out of `buildMcpServer`, which is why a surface that is over budget fails
 * `spotify-mcp tools --json` instead of being reported.
 */
export async function openCliSession(options: CliSessionOptions = {}): Promise<CliSession> {
  const io = options.io ?? defaultCliIo;
  // Same first call `startMcpServer` makes, and for the same reason: every
  // `getConfig()` reader below resolves against it.
  initConfig();
  const scope = await resolveServerScope({ announce: false });
  const spotifyClient = options.spotifyClient
    ?? (options.tokenFile === undefined ? new SpotifyClient() : new SpotifyClient({ tokenFile: options.tokenFile }));
  const server = await buildMcpServer(spotifyClient, scope, { announce: false });

  const client = new Client(
    { name: 'spotify-mcp-cli', version },
    // See the header: the capability is the claim `confirm.ts` reads, so it is
    // advertised only when a human can actually answer. A non-TTY invocation
    // deliberately takes the fail-closed refusal on every gated tool.
    { capabilities: io.isInteractive ? { elicitation: {} } : {} },
  );

  if (io.isInteractive) {
    client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
      const accepted = await io.confirm(`${request.params.message} [y/N]`);
      if (!accepted) return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    spotifyClient,
    io,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
