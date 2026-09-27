/**
 * The security properties of the opt-in HTTP transport, end to end (#599).
 *
 * ## What this file is for
 *
 * A transport test that only proves "it serves tools when allowed" passes
 * against an implementation that also serves them when NOT allowed, which is
 * the only failure that matters here. So every test below asserts a property
 * that must HOLD, in this order of severity:
 *
 *  1. **Default config starts no listener at all** — and the stdio default is
 *     byte-for-byte the path it was before this issue.
 *  2. **An unauthenticated request is refused**, and the refusal leaks nothing:
 *     not a tool name, not a session id, not a hint about what to try next.
 *  3. **A wrong token is refused** the same way as no token, so the response is
 *     not an oracle.
 *  4. **A non-loopback bind is refused** unless a second, separate opt-in is
 *     also present.
 *  5. **The token never appears in stdout or stderr**, and neither does the
 *     Spotify access/refresh token.
 *  6. **The body ceiling and the rate limit are real** on a live socket.
 *
 * ## Every listener here binds port 0
 *
 * Port 8888 is the OAuth callback redirect's port and is off limits; the fixed
 * alternative would be worse, because this box runs the same suite for a dozen
 * agents at once. Every server below is started with `SPOTIFY_MCP_HTTP_PORT=0`
 * and the kernel-assigned port is read out of the server's own startup line.
 * A hardcoded port in this file is a bug, not a style choice.
 *
 * ## Red-without-the-fix
 *
 * Each negative test is driven through a real child process, so reverting the
 * matching guard in `src/http.ts` turns it red — there is no stub to keep in
 * sync. `tests/http.config.test.ts` covers the same guards as pure functions.
 */
import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticServerEnv } from './helpers/stdio-child.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Clears the length rule so it exercises the transport, not the length rule. */
const TOKEN = 'e2e-bearer-token-0123456789abcdef';

/** A token fixture whose material must never reach a log line. */
const SPOTIFY_ACCESS_TOKEN = 'spotify-access-token-DO-NOT-LEAK-a1b2c3';
const SPOTIFY_REFRESH_TOKEN = 'spotify-refresh-token-DO-NOT-LEAK-d4e5f6';

let home: string;
let tokenFile: string;

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'x599-http-'));
  tokenFile = path.join(home, 'tokens.json');
  await writeFile(tokenFile, JSON.stringify({
    access_token: SPOTIFY_ACCESS_TOKEN,
    refresh_token: SPOTIFY_REFRESH_TOKEN,
    expires_at: Date.now() + 3_600_000,
  }), 'utf8');
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

interface Started {
  readonly child: ChildProcessWithoutNullStreams;
  /** Kernel-assigned port, or null when the server never bound one. */
  readonly port: number | null;
  readonly url: string | null;
  readonly output: () => string;
  readonly exited: Promise<{ code: number | null; output: string }>;
}

const LIVE_LISTEN_LINE = /Streamable HTTP transport listening on (http:\/\/[^\s]+)/;

/**
 * Spawn the real entry point and wait for either a listening URL or an exit.
 *
 * `hermeticServerEnv` deletes every `SPOTIFY_*` the outer shell carries, so a
 * developer with `SPOTIFY_MCP_TRANSPORT` exported cannot make these tests pass
 * or fail by their own environment.
 */
async function startServer(
  overrides: Record<string, string | undefined>,
  label: string,
  /**
   * How long to wait for the listening line. Pass a SHORT one when the test
   * asserts that no listener appears: a stdio server never prints it, so the
   * default window turns "correctly not listening" into a minute of polling
   * per case. It is still a bound, not a sleep — the loop exits the moment the
   * child dies, which is how the refusal cases settle in well under a second.
   */
  readyTimeoutMs = 30_000,
): Promise<Started> {
  const { env, home: childHome } = hermeticServerEnv(
    { SPOTIFY_MCP_TOKEN_FILE: tokenFile, ...overrides },
    label,
  );
  const child = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
    cwd: ROOT,
    env,
    // stdin stays OPEN. A stdio server treats EOF on stdin as "the host went
    // away" and exits, so `ignore` would make the stdio-default assertions
    // below measure a process that shut itself down rather than a server that
    // chose not to listen.
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  let output = '';
  const collect = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const exited = new Promise<{ code: number | null; output: string }>((resolve) => {
    child.once('exit', (code) => resolve({ code, output }));
  });

  // Readiness is the startup line OR a dead process, whichever comes first —
  // never a bare timer (see tests/helpers/stdio-child.ts's header on why a
  // watchdog is the second settlement path, not the first).
  const ready = await Promise.race([
    (async () => {
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        const match = LIVE_LISTEN_LINE.exec(output);
        if (match) return match[1] as string;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    })(),
    exited.then((e) => (e.output.match(LIVE_LISTEN_LINE)?.[1] ?? null)),
  ]);

  const url = ready;
  const port = url ? Number(new URL(url).port) : null;
  return {
    child,
    port,
    url,
    output: () => output,
    exited,
  };
}

/**
 * Wait for a child to exit, BOUNDED.
 *
 * Every refusal test below asserts that a server which must NOT start, did not
 * start. If the guard it is testing is removed, that server starts and listens
 * — and a bare `await server.exited` then waits for a process that is perfectly
 * healthy and never going anywhere. The mutation is caught, but the run hangs
 * until the suite's own timeout, which reports a timeout rather than the
 * property that broke. A bound turns that into a named failure.
 */
async function awaitExit(server: Started, ms = 20_000): Promise<{ code: number | null; output: string }> {
  const TIMED_OUT = Symbol('timed-out');
  const result = await Promise.race([
    server.exited,
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),
  ]);
  if (result === TIMED_OUT) {
    assert.fail(
      `the server was still running after ${ms}ms and had bound ${server.url ?? 'nothing'}. `
      + `A configuration this test expects to be refused started instead.\nstderr:\n${server.output()}`,
    );
  }
  return result;
}

/** Reap a child by the PID we recorded. Never a pattern match — see the header. */
function stop(server: Started | null): void {
  server?.child.kill('SIGKILL');
  server?.child.stdout.destroy();
  server?.child.stderr.destroy();
}

/**
 * A raw HTTP exchange, written onto a socket byte by byte.
 *
 * `fetch` is unusable for most of what this file asserts. It normalises the
 * request path (so `/../mcp` never reaches the server as written), it refuses
 * to send a body whose length disagrees with a `content-length` header (so the
 * under-declaring case cannot be expressed), and it reports a status code the
 * test never asked for. Each of those is a client behaviour standing between
 * the test and the property, so the request bytes are assembled here instead.
 */
function rawRequest(
  port: number,
  init: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    /** Send no Content-Length and no body, i.e. a bare header block. */
    headersOnly?: boolean;
    /** Frame the body as one HTTP chunk, so no Content-Length is needed. */
    chunked?: boolean;
  },
): Promise<{ status: number; headers: Record<string, string>; text: string; error?: string }> {
  const method = init.method ?? 'POST';
  const path = init.path ?? '/mcp';
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    'content-type': 'application/json',
    // Keep-alive would leave the socket open after a 413, and these tests
    // settle on `close`. One connection per exchange is fine at this scale.
    connection: 'close',
    ...(init.headers ?? {}),
  };
  const body = init.body ?? '';
  if (!init.headersOnly && !init.chunked && !('content-length' in headers) && !('transfer-encoding' in headers)) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  const head = [`${method} ${path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');

  return new Promise((resolve) => {
    const socket = connect(port, () => {
      socket.write(head);
      if (init.chunked) {
        if (body) socket.write(`${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`);
        socket.write('0\r\n\r\n');
      } else if (body && !init.headersOnly) {
        socket.write(body);
      }
    });
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', (error: Error) => resolve({ status: 0, headers: {}, text: '', error: error.message }));
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      const headText = split === -1 ? raw : raw.slice(0, split);
      const text = split === -1 ? '' : raw.slice(split + 4);
      const lines = headText.split('\r\n');
      const status = Number.parseInt(lines[0]?.split(' ')[1] ?? '0', 10) || 0;
      const parsed: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        if (at > 0) parsed[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      resolve({ status, headers: parsed, text });
    });
  });
}

function connect(port: number, onReady: () => void): Socket {
  const socket = new Socket();
  socket.connect(port, '127.0.0.1', onReady);
  return socket;
}

const AUTHORIZED = { authorization: `Bearer ${TOKEN}` };

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'x599-security', version: '0.0.0' },
  },
});

describe('the default configuration starts no listener (#599)', () => {
  it('leaves the default on stdio, serving tools with no HTTP variable set', async () => {
    // The regression this file exists to prevent: an opt-in that quietly
    // became the default. The default path must be the stdio path, and it must
    // work — an "opt-in" that also broke the default would be worse than either.
    const server = await startServer({}, 'http-default-off', 8_000);
    try {
      assert.equal(server.url, null, `the default configuration bound a listener: ${server.output()}`);
      // Prove the process is the stdio server and not a crashed one: a server
      // that refused to start would also bind nothing.
      const { StdioJsonRpcChild } = await import('./helpers/stdio-child.js');
      const child = StdioJsonRpcChild.spawn({
        label: 'http-default-stdio',
        command: 'node',
        args: ['--import', 'tsx', 'src/index.ts'],
        cwd: ROOT,
        env: hermeticServerEnv({ SPOTIFY_MCP_TOKEN_FILE: tokenFile }, 'http-default-stdio').env,
      });
      try {
        const names = await child.toolNames();
        assert.ok(names.includes('get_me'), `the stdio default served ${names.length} tools without get_me`);
      } finally {
        await child.dispose();
      }
    } finally {
      stop(server);
    }
  });

  it('ignores an HTTP token that would be refused on the http path', async () => {
    // If the stdio branch validated HTTP variables, this server would exit 1.
    // A three-character token is refused outright on the http path.
    const server = await startServer({ SPOTIFY_MCP_HTTP_TOKEN: 'abc' }, 'http-stdio-ignores', 8_000);
    try {
      assert.equal(server.url, null);
      const stillRunning = await Promise.race([
        server.exited.then(() => 'exited'),
        new Promise((r) => setTimeout(() => r('running'), 1_500)),
      ]);
      assert.equal(stillRunning, 'running', `the default path died on an HTTP variable it never uses:\n${server.output()}`);
    } finally {
      stop(server);
    }
  });
});

describe('a non-loopback bind is refused without a second opt-in (#599)', () => {
  it('exits non-zero and binds nothing', async () => {
    const server = await startServer({
      SPOTIFY_MCP_TRANSPORT: 'http',
      SPOTIFY_MCP_HTTP_TOKEN: TOKEN,
      SPOTIFY_MCP_HTTP_BIND: '0.0.0.0',
    }, 'http-nonloopback', 8_000);
    try {
      const { code, output } = await awaitExit(server);
      assert.equal(server.url, null, 'a refused bind must not leave a listener up');
      assert.equal(code, 1, `expected a non-zero exit, got ${code}:\n${output}`);
      assert.match(output, /not a loopback address/);
      assert.match(output, /SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK/);
    } finally {
      stop(server);
    }
  });
});

describe('an unauthenticated listener refuses to start (#599)', () => {
  it('exits non-zero, and never reaches a registry', async () => {
    const server = await startServer({ SPOTIFY_MCP_TRANSPORT: 'http' }, 'http-no-token', 8_000);
    try {
      const { code, output } = await awaitExit(server);
      assert.equal(server.url, null, 'the listener started with no credential');
      assert.equal(code, 1, `expected a non-zero exit, got ${code}:\n${output}`);
      assert.match(output, /requires a bearer token/);
      // It must not have registered anything on the way to refusing. The
      // toolset banner is printed by registration; its absence is the proof
      // that the refusal happens before the surface exists.
      assert.doesNotMatch(output, /active toolsets|tool annotations applied/);
    } finally {
      stop(server);
    }
  });
});

describe('the authenticated listener serves a real MCP session (#599)', () => {
  let server: Started | null = null;
  let port: number;

  before(async () => {
    server = await startServer({
      SPOTIFY_MCP_TRANSPORT: 'http',
      SPOTIFY_MCP_HTTP_TOKEN: TOKEN,
      SPOTIFY_MCP_HTTP_PORT: '0',
    }, 'http-authenticated');
    assert.ok(server.url, `the authenticated listener never came up:\n${server.output()}`);
    assert.ok(server.port && server.port > 0, 'the listener must report a kernel-assigned port');
    port = server.port;
    assert.notEqual(port, 8888, 'a test must never bind the OAuth callback port');
  });

  after(() => stop(server));

  it('refuses a request with no Authorization header, and discloses nothing', async () => {
    const response = await rawRequest(port, { body: INITIALIZE });
    assert.equal(response.status, 401);
    assert.match(response.headers['www-authenticate'] ?? '', /Bearer/);
    // An MCP endpoint that answers an unauthenticated caller is a disclosure
    // of ~590 tool schemas describing writes against a real account. The
    // refusal must name no tool, no session and no count.
    for (const leak of ['get_me', 'mcp-session-id', 'tools', 'session', 'spotify-mcp']) {
      assert.doesNotMatch(response.text, new RegExp(leak, 'i'), `the 401 body leaked ${leak}`);
    }
    assert.equal(response.headers['mcp-session-id'], undefined, 'a 401 must not open a session');
  });

  it('refuses a wrong token exactly as it refuses none', async () => {
    const wrong = await rawRequest(port, { headers: { authorization: 'Bearer wrong-token-entirely' }, body: INITIALIZE });
    const none = await rawRequest(port, { body: INITIALIZE });
    assert.equal(wrong.status, 401);
    assert.equal(none.status, 401);
    // Identical apart from a nonce-free body: a difference here would be an
    // oracle telling an attacker which half of the guess was right.
    assert.equal(wrong.text, none.text);
  });

  it('refuses a near-miss token, so the comparison is not a prefix match', async () => {
    const response = await rawRequest(port, { headers: { authorization: `Bearer ${TOKEN}x` }, body: INITIALIZE });
    assert.equal(response.status, 401);
  });

  it('refuses a non-bearer scheme carrying the right token', async () => {
    const response = await rawRequest(port, { headers: { authorization: `Basic ${TOKEN}` }, body: INITIALIZE });
    assert.equal(response.status, 401);
  });

  it('serves 404 off the configured path, so the surface is not sprayed', async () => {
    // Authentication is not the only boundary: an unauthenticated caller must
    // not be able to walk paths to find one that skips the check.
    for (const probe of ['/', '/mcp/extra', '/../mcp', '/health']) {
      const response = await rawRequest(port, { path: probe, body: INITIALIZE });
      assert.equal(response.status, 404, `expected 404 for ${probe}, got ${response.status}`);
      assert.doesNotMatch(response.text, /get_me|serverInfo/);
    }
  });

  it('completes initialize, tools/list and a tools/call over Streamable HTTP', async () => {
    // The positive control. Without it, the negative tests above would be
    // satisfied by a server that serves nothing to anyone.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'x599-e2e', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: AUTHORIZED },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.length > 100, `only ${listed.tools.length} tools were served`);
      assert.ok(listed.tools.some((t) => t.name === 'get_me'), 'get_me is missing from the HTTP tool list');

      // A real call, so the session is proven to route to a working client
      // rather than merely answering the handshake.
      //
      // The call is EXPECTED to fail, and asserting `isError === false` would
      // be asserting that the sandbox has a working Spotify app. What actually
      // has to be true is that the call reached the tool layer and came back
      // through the repo's own structured error contract: the fixture client id
      // is not a real app, so the token endpoint refuses it. A transport-level
      // failure cannot produce `kind: "auth"` with a Spotify `fix` string — only
      // a call that was really dispatched and really reached accounts.spotify.com.
      const result = await client.callTool({ name: 'get_me', arguments: {} });
      const envelope = (result.structuredContent as { error?: { tool?: string; kind?: string } } | undefined)?.error;
      assert.equal(envelope?.tool, 'get_me', `tools/call did not reach the tool layer: ${JSON.stringify(result).slice(0, 400)}`);
      assert.equal(envelope?.kind, 'auth', `expected the Spotify auth envelope, got ${JSON.stringify(envelope)}`);
      // The Spotify credential must not be in the payload either.
      assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK/);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('refuses a POST naming a session id that was never issued', async () => {
    // Silently starting a new session for an unknown id would let a client
    // that lost its session state mint a fresh registry per request.
    const response = await rawRequest(port, {
      headers: { ...AUTHORIZED, 'mcp-session-id': '00000000-0000-4000-8000-000000000000' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(response.status, 404);
  });

  it('caps a chunked body, where the STREAM is the only thing to count', async () => {
    // A network endpoint with no body cap is a memory-exhaustion vector.
    //
    // Chunked is the shape that actually tests it, and it is worth being
    // explicit about why the obvious alternative cannot: a body that
    // under-declares its Content-Length is cut off by Node's HTTP parser at the
    // declared boundary, so the surplus never reaches the handler as this
    // request's body. Chunked carries no such claim, so the only thing standing
    // between an unbounded body and the heap is the running count.
    const oversized = 'x'.repeat(2 * 1_048_576);
    const response = await rawRequest(port, {
      headers: { ...AUTHORIZED, 'transfer-encoding': 'chunked' },
      body: oversized,
      chunked: true,
    });
    assert.equal(response.status, 413, `expected 413, got ${response.status}: ${response.error ?? response.text}`);
  });

  it('refuses a body that declares itself oversized, before reading it', async () => {
    const response = await rawRequest(port, {
      headers: { ...AUTHORIZED, 'content-length': String(64 * 1_048_576) },
      body: '{}',
    });
    assert.equal(response.status, 413, `expected 413, got ${response.status}: ${response.error ?? ''}`);
  });

});

describe('a flood is rate limited (#599)', () => {
  let server: Started | null = null;
  let port: number;

  before(async () => {
    // A five-per-minute budget rather than the 600 default: the property under
    // test is that the limiter fires at all, and spending 700 real requests to
    // prove it is a minute of wall clock for no extra coverage. The DEFAULT
    // value is asserted in tests/http.config.test.ts.
    server = await startServer({
      SPOTIFY_MCP_TRANSPORT: 'http',
      SPOTIFY_MCP_HTTP_TOKEN: TOKEN,
      SPOTIFY_MCP_HTTP_PORT: '0',
      SPOTIFY_MCP_HTTP_RATE_LIMIT: '5',
    }, 'http-rate-limit');
    assert.ok(server.url, `the rate-limited listener never came up:\n${server.output()}`);
    port = server.port as number;
  });

  after(() => stop(server));

  it('limits an unauthenticated flood, so guessing the token is throttled too', async () => {
    // Deliberately NO Authorization header. The limiter runs before the
    // credential check on purpose: an unauthenticated attacker who could guess
    // at the token without a budget would have an unlimited oracle. A 429 here
    // is the proof that the order in src/http.ts is the one that holds.
    let limited = false;
    for (let i = 0; i < 40 && !limited; i += 1) {
      const response = await rawRequest(port, { body: INITIALIZE });
      if (response.status === 429) {
        limited = true;
        assert.ok(response.headers['retry-after'], 'a 429 must carry Retry-After');
      }
      // 401 is the refusal and 429 is the throttle; anything else — above all
      // a 200 — is a flood that got served.
      assert.ok(
        response.status === 401 || response.status === 429,
        `request ${i} answered ${response.status} (${response.error ?? response.text}) — a flood must be refused or throttled, never served`,
      );
    }
    assert.ok(limited, '40 unauthenticated requests from one address were never rate limited');
  });
});

describe('neither credential reaches the log (#599)', () => {
  it('prints the listening URL without the bearer token or the Spotify tokens', async () => {
    const server = await startServer({
      SPOTIFY_MCP_TRANSPORT: 'http',
      SPOTIFY_MCP_HTTP_TOKEN: TOKEN,
      SPOTIFY_MCP_HTTP_PORT: '0',
    }, 'http-no-log-leak');
    try {
      assert.ok(server.url, `the listener never came up:\n${server.output()}`);
      // Give the startup line and any refusal a chance to land.
      await new Promise((r) => setTimeout(r, 300));
      const output = server.output();
      assert.doesNotMatch(output, new RegExp(TOKEN), 'the bearer token was written to stdout/stderr');
      assert.doesNotMatch(output, new RegExp(SPOTIFY_ACCESS_TOKEN), 'the Spotify access token was logged');
      assert.doesNotMatch(output, new RegExp(SPOTIFY_REFRESH_TOKEN), 'the Spotify refresh token was logged');
      // The URL IS printed — it is the operator's only way to find the port,
      // and it carries no credential.
      assert.match(output, /Streamable HTTP transport listening on http:\/\/127\.0\.0\.1:\d+\/mcp/);
    } finally {
      stop(server);
    }
  });

  it('keeps the bearer token out of a configuration refusal too', async () => {
    const server = await startServer({
      SPOTIFY_MCP_TRANSPORT: 'http',
      SPOTIFY_MCP_HTTP_TOKEN: TOKEN,
      SPOTIFY_MCP_HTTP_BIND: '203.0.113.7',
    }, 'http-refusal-no-leak', 8_000);
    try {
      const { output } = await awaitExit(server);
      assert.doesNotMatch(output, new RegExp(TOKEN), 'a refusal echoed the bearer token');
      assert.match(output, /not a loopback address/);
    } finally {
      stop(server);
    }
  });
});
