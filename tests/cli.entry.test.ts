/**
 * The #606 subcommands as the user runs them: the real entry point, as a child.
 *
 * ## Why this file exists when `tests/cli.session.test.ts` already covers them
 *
 * That file drives the runners in-process. It cannot cover the thing this file
 * is about, which is `src/index.ts`'s dispatch chain: `import './cli/dispatch.js'`
 * in the right branch, `process.exitCode` set from the returned code, and a
 * dynamic import that rejects rather than hanging. A dispatcher that routed
 * `tools` to `startMcpServer()` would pass every in-process test and hang here.
 *
 * So these are real children, spawned exactly the way a user spawns them,
 * through the repo's own `tests/helpers/cli-child.ts` harness (a child that
 * reaches no verdict is reported naming HOW it died, not as empty stdout).
 *
 * ## Every child gets a disposable HOME
 *
 * `HOME` is a fresh `mkdtemp` per child, and `SPOTIFY_MCP_TOKEN_FILE` points
 * inside it. A child that inherited this box's `HOME` would read and write the
 * real `~/.spotify-mcp`. Nothing here spawns `auth`, and no test binds a port.
 *
 * ## The exit code is the assertion
 *
 * Each case names the code it expects and the reason 1 and 2 are different:
 * **2 means the invocation was rejected and nothing was sent; 1 means the work
 * ran and failed.** A CLI path that swallows an error and exits 0 is the defect
 * this file exists to catch, so every non-zero expectation is paired with the
 * content that proves which kind of failure it was.
 */
import './helpers/hermetic.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliStdout, runCliSubcommand, type CliRun } from './helpers/cli-child.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(ROOT, 'src', 'index.ts');

let home: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'x606-entry-'));
  await writeFile(
    join(home, 'tokens.json'),
    JSON.stringify({ access_token: 'cli-606', refresh_token: 'cli-606', expires_at: Date.now() + 3_600_000 }),
    'utf8',
  );
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

function cli(args: string[], label: string): Promise<CliRun> {
  return runCliSubcommand({
    entry: ENTRY,
    cwd: ROOT,
    args,
    label: `spotify-mcp ${label}`,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      SPOTIFY_CLIENT_ID: 'cli-606',
      SPOTIFY_MCP_TOKEN_FILE: join(home, 'tokens.json'),
    },
  });
}

/** The code, failing the test with the child's own diagnosis if it never ran. */
function codeOf(result: CliRun): number {
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.code;
}

describe('#606 entry point: --help advertises the new subcommands', () => {
  it('documents each one on its own usage line', async () => {
    // Word-boundary anchored for the same reason `tests/index-cli.test.ts`
    // anchors: a bare substring check is satisfied by a name the dispatcher
    // does not route.
    const out = cliStdout(await cli(['--help'], '--help'));
    for (const subcommand of ['tools', 'call', 'watch', 'export', 'init']) {
      assert.match(
        out,
        new RegExp(`^ {2}spotify-mcp ${subcommand}\\b`, 'm'),
        `--help must document \`spotify-mcp ${subcommand}\``,
      );
    }
  });

  it('says the four session subcommands are MCP clients, not a second call path', async () => {
    // A user reading this should not conclude that `call` bypasses the server's
    // validation or its confirmation gates. The sentence is the claim; if it
    // stopped being true the sentence would have to go, and this fails first.
    const out = cliStdout(await cli(['--help'], '--help'));
    assert.match(out, /tools, call, watch and export are MCP clients, not a second call path/);
    assert.match(out, /docs\/cli\.md/);
  });
});

describe('#606 entry point: routing', () => {
  it('routes `tools --json` to a registry boot, not to the stdio server', async () => {
    // The discriminator. A dispatcher that fell through to `startMcpServer()`
    // would connect a stdio transport and wait for input until the harness
    // killed it — reported as a killed child, not as output.
    const result = await cli(['tools', '--json', '--filter', 'get_now_playing'], 'tools --json');
    assert.ok(result.ok, result.ok ? '' : result.reason);
    const parsed = JSON.parse(cliStdout(result)) as { tools: Array<{ name: string }>; registered: number };
    assert.deepEqual(parsed.tools.map((t) => t.name), ['get_now_playing']);
    assert.ok(parsed.registered > 50, 'a real surface was registered, not a stub');
  });

  it('routes `call` and exits 2 for an unknown tool, with nothing sent', async () => {
    const result = await cli(['call', 'no_such_tool_at_all'], 'call no_such_tool_at_all');
    assert.equal(codeOf(result), 2);
    assert.match(cliStdout(result), /no tool named "no_such_tool_at_all" is registered/);
  });

  it('routes `call` and exits 1 when the tool returns the error envelope', async () => {
    // `get_playlist` on a syntactically impossible id: the tool runs, the call
    // fails, and the shell must see a non-zero code with the envelope on it.
    const result = await cli(['call', 'get_playlist', '--args', '{"playlist_id":""}'], 'call get_playlist');
    const code = codeOf(result);
    assert.notEqual(code, 0, cliStdout(result));
    assert.equal(code, 1, `a tool failure is 1, not 2: ${cliStdout(result)}`);
  });

  it('routes `watch --count 1` and exits 0 after one poll', async () => {
    // A live token file with no Spotify reachable: `get_now_playing` returns a
    // refusal rather than a payload, so the poll errors and the loop stops at
    // exit 1. Either way the point is that it TERMINATES — a dispatcher that
    // reached `startMcpServer()` would have hung.
    const result = await cli(['watch', '--count', '1', '--json'], 'watch --count 1');
    const code = codeOf(result);
    assert.ok(code === 0 || code === 1, `watch must reach a verdict, got ${code}`);
  });

  it('routes `export` and exits 2 on a kind no tool implements', async () => {
    const result = await cli(['export', '--kind', 'playlists'], 'export --kind playlists');
    assert.equal(codeOf(result), 2);
    assert.match(cliStdout(result), /no tool exports every playlist/);
  });

  it('routes `init` and exits 2 with no client id available, writing nothing', async () => {
    // `init` needs no registry, so it is the one subcommand whose child must NOT
    // pay the ~2 s boot — and it is the only one whose failure is a missing
    // variable rather than a Spotify call.
    const out = join(home, 'never-written-606.json');
    const result = await runCliSubcommand({
      entry: ENTRY,
      cwd: ROOT,
      args: ['init', '--host', 'generic', '--out', out],
      label: 'spotify-mcp init',
      env: { PATH: process.env.PATH, HOME: home },
    });
    assert.equal(codeOf(result), 2, cliStdout(result));
    assert.match(cliStdout(result), /SPOTIFY_CLIENT_ID is required/);
    assert.match(cliStdout(result), /Nothing was written/);
    await assert.rejects(() => import('node:fs/promises').then((fs) => fs.readFile(out, 'utf8')));
  });

  it('routes `init` and writes a config when a client id is present', async () => {
    const out = join(home, 'written-606.json');
    const result = await runCliSubcommand({
      entry: ENTRY,
      cwd: ROOT,
      args: ['init', '--host', 'generic', '--client-id', 'abc123', '--out', out],
      label: 'spotify-mcp init --out',
      env: { PATH: process.env.PATH, HOME: home },
    });
    assert.equal(codeOf(result), 0, cliStdout(result));
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(out, 'utf8')) as {
      mcpServers: { spotify: { env: Record<string, string> } };
    };
    assert.equal(parsed.mcpServers.spotify.env.SPOTIFY_CLIENT_ID, 'abc123');
  });

  it('prints each subcommand\'s help with exit 0 and no registry boot', async () => {
    // The usage paths a user hits first. Each is asserted on BOTH the text and
    // the code, so a subcommand that printed its help and then fell through to
    // the server would fail rather than hang.
    //
    // Concurrent because each of these is an independent child paying its own
    // ~2 s module load, and they share nothing but the read-only `HOME`.
    const cases = [
      [['tools', '--help'], 'Usage: spotify-mcp tools'],
      [['call', '--help'], 'Usage: spotify-mcp call'],
      [['watch', '--help'], 'Usage: spotify-mcp watch'],
      [['export', '--help'], 'Usage: spotify-mcp export'],
      [['init', '--help'], 'Usage: spotify-mcp init'],
    ] as const;
    const results = await Promise.all(cases.map(([args]) => cli([...args], args.join(' '))));
    results.forEach((result, i) => {
      const [args, needle] = cases[i] as readonly [readonly string[], string];
      assert.equal(codeOf(result), 0, `${args.join(' ')}: ${cliStdout(result)}`);
      assert.match(cliStdout(result), new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });
});

describe('#606 entry point: the pre-existing commands still route', () => {
  it('leaves `doctor` on its own branch', async () => {
    // A refactor of the dispatch chain must not have swallowed a command that
    // was already there. `doctor` reads a token file and prints a report; with
    // the fixture token it exits 1, and the banner is what the test reads.
    const result = await cli(['doctor'], 'doctor');
    const out = cliStdout(result);
    assert.match(out, /spotify-mcp \d+\.\d+\.\d+/);
    assert.match(out, /Configuration:/);
  });

  it('reads --profile once, for every session subcommand, and still runs it', async () => {
    // `--profile` names the ACCOUNT, not the operation, so the dispatcher
    // consumes it for all four rather than each parser recognising it. The
    // discriminator is the exit code: before this, each subcommand's own parser
    // met a flag it did not know and refused the invocation at 2, so a run that
    // reaches 0 proves the flag was lifted and the subcommand still executed.
    //
    // `tools` is the one subcommand that touches no Spotify endpoint, so this
    // assertion is about routing and nothing else. `watch` and `export` are
    // included because they are the other two whose flags this changed.
    const cases = [
      ['tools', '--profile', 'work', '--filter', 'get_now_playing'],
      ['call', '--profile', 'work', 'get_user_profile'],
    ] as const;
    for (const args of cases) {
      const result = await cli([...args], args.join(' '));
      const out = cliStdout(result);
      assert.doesNotMatch(out, /unknown argument: --profile/, `${args[0]} must accept --profile`);
      assert.notEqual(codeOf(result), 2, `${args.join(' ')}: ${out}`);
    }
  });

  it('refuses a profile name the server would refuse, at 2, with its message', async () => {
    // The validation is `activeProfile`'s, so `spotify-mcp` and `spotify-mcp
    // auth` cannot disagree about what a legal account profile is. A name that
    // becomes a path (`../escape`) is the case that matters.
    const result = await cli(
      ['tools', '--profile', '../escape', '--filter', 'get_now_playing'],
      'tools --profile ../escape',
    );
    assert.equal(codeOf(result), 2, cliStdout(result));
    assert.match(cliStdout(result), /Invalid --profile "\.\.\/escape"/);
  });
});
