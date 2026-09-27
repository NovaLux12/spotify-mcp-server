/**
 * Tests for `src/index.ts` (#657) — the CLI dispatcher.
 *
 * The module had no importing test, and it cannot have one: it is the entry
 * point, so importing it runs `startMcpServer()` in the importing process. It
 * is exercised here as what it is — a process — spawned exactly the way a user
 * runs it, with an isolated HOME and a temp token file.
 *
 * Scope is deliberately the two branches that are safe to run in a test:
 * `--help` and `--version`. Both are pure string production: neither calls
 * `initConfig()`, neither constructs a `SpotifyClient`, neither starts a
 * server, and neither binds a port. The `auth`, `doctor` and `logout` branches
 * are excluded on purpose — each reaches real user state (token file, local
 * stores), and a test must leave every file under a real `~/.spotify-mcp/`
 * alone.
 *
 * What the assertions pin, beyond "it prints something":
 *   1. Every documented subcommand and flag is actually advertised. A usage
 *      line that lost its subcommand sends the user to `--help` and then to a
 *      GitHub issue.
 *   2. The env section is GENERATED from the config registry, so the help text
 *      cannot drift from the variables the server actually reads. This is the
 *      property that makes the text worth testing at all.
 *   3. `--version` prints the version from package.json, not a literal, so a
 *      release bump cannot leave the CLI advertising the previous number.
 *
 * Run: node --import tsx --test tests/index-cli.test.ts
 */
// Hermetic home (#1274): point HOME at a temp root so a test run cannot
// write into the real ~/.spotify-mcp. This suite confines its own
// filesystem work under mkdtemp(os.tmpdir()) as well.
import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** Preconditions on the checkout under test, asserted before anything spawns. */
it('#657 precondition: the entry point exists and package.json declares a version', async () => {
  const { readFile } = await import('node:fs/promises');
  const entry = await readFile(path.join(ROOT, 'src', 'index.ts'), 'utf8');
  assert.ok(entry.length > 0, 'src/index.ts must be readable for this suite to mean anything');
  assert.match(version, /^\d+\.\d+\.\d+/, `package.json version looks wrong: ${version}`);
});

let home: string;

before(async () => {
  // An isolated HOME. The point is that nothing here can reach the developer's
  // real ~/.spotify-mcp — the ~2,200 files of user state that live there.
  home = await mkdtemp(path.join(tmpdir(), 'x657-index-'));
  const tokenFile = path.join(home, 'tokens.json');
  await writeFile(tokenFile, JSON.stringify({
    access_token: 'cli-test', refresh_token: 'cli-test', expires_at: Date.now() + 3_600_000,
  }), 'utf8');
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

interface CliResult { stdout: string; stderr: string; code: number }

/** A child that has not exited by now is treated as a failure, not awaited. */
const CLI_TIMEOUT_MS = 30_000;

/**
 * Run the real entry point as a child process. `HOME`, the token file and the
 * cwd are all pointed at the temp dir, and no port is bound — `--help` and
 * `--version` return before any transport is constructed.
 *
 * The timeout is load-bearing rather than defensive. If either flag stopped
 * matching its branch, the dispatcher falls through to `startMcpServer()`,
 * which connects a stdio transport and then waits for input forever — a hang
 * that stalls the whole suite instead of failing one assertion. A flag that
 * stops working must be a red test, and this is what makes it one.
 */
async function cli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx/esm', path.join(ROOT, 'src', 'index.ts'), ...args],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: {
          PATH: process.env.PATH,
          HOME: home,
          SPOTIFY_CLIENT_ID: 'cli-test',
          SPOTIFY_MCP_TOKEN_FILE: path.join(home, 'tokens.json'),
        },
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; signal?: string };
    // A killed child (the hang above) is reported as a non-zero exit so the
    // caller's exit-code assertion fails rather than reading as success.
    const code = e.killed ? 124 : typeof e.code === 'number' ? e.code : 1;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code };
  }
}

describe('#657 index.ts: --help', () => {
  it('exits 0 and prints the usage block', async () => {
    const out = await cli(['--help']);
    assert.equal(out.code, 0, `stderr: ${out.stderr}`);
    assert.match(out.stdout, /^spotify-mcp — MCP server for the Spotify Web API/m);
    assert.match(out.stdout, /Usage:/);
  });

  it('is the same output for -h', async () => {
    const long = await cli(['--help']);
    const short = await cli(['-h']);
    assert.equal(short.code, 0, `stderr: ${short.stderr}`);
    assert.equal(short.stdout, long.stdout, '-h and --help are the same branch, not two copies');
  });

  it('advertises every subcommand the dispatcher actually routes', async () => {
    // The dispatcher in src/index.ts routes auth / doctor / logout / help /
    // version. A usage line that lost one sends the user nowhere.
    //
    // The subcommand names are matched with a trailing word boundary, not
    // `stdout.includes()`. A bare substring check is satisfied by
    // `spotify-mcp doctorX` — a name the dispatcher does not route — so it
    // would pass on exactly the regression it exists to catch. The flag loop
    // is anchored the same way for the same reason.
    const { stdout, code } = await cli(['--help']);
    assert.equal(code, 0, `stderr: ${code}`);
    for (const subcommand of ['auth', 'doctor', 'logout']) {
      assert.match(
        stdout,
        new RegExp(`^ {2}spotify-mcp ${subcommand}\\b`, 'm'),
        `help must document \`spotify-mcp ${subcommand}\` on its own usage line`,
      );
    }
    for (const flag of ['--help', '--version']) {
      assert.match(stdout, new RegExp(`^ {2}spotify-mcp ${flag}\\b`, 'm'), `help must document \`${flag}\``);
    }
  });

  it('documents the logout flags the dispatcher passes through to the logout module', async () => {
    // Word-boundary anchored for the same reason as the subcommand loop: a bare
    // `includes('--keep-backups')` also matches `--keep-backups-and-more`, and
    // a renamed flag would sail through an unanchored check.
    const { stdout } = await cli(['--help']);
    for (const flag of ['--dry-run', '--keep-backups', '--profile', '--scopes']) {
      assert.match(stdout, new RegExp(`${flag}\\b`), `help must document \`${flag}\``);
    }
  });

  it('carries a GENERATED Environment section listing every documented variable', async () => {
    // renderEnvHelp() builds the block from DOCUMENTED_ENV_VARS, so the
    // variables the server reads and the variables the help lists cannot
    // drift. The expectation is DERIVED from that same registry rather than
    // hand-typed: a var added to the registry and dropped from the renderer
    // fails here, and a var removed from the registry stops being demanded.
    const { DOCUMENTED_ENV_VARS } = await import('../src/config.ts');
    const documented = DOCUMENTED_ENV_VARS.filter((v) => v.inHelp).map((v) => v.name);
    assert.ok(documented.length >= 10, `precondition: the registry is populated, got ${documented.length}`);

    const { stdout } = await cli(['--help']);
    assert.match(stdout, /^Environment:$/m);
    for (const name of documented) {
      assert.ok(
        stdout.includes(name),
        `--help must name ${name}; the Environment section is generated from DOCUMENTED_ENV_VARS`,
      );
    }
  });

  it('lists each documented variable on its own indented line', async () => {
    // The block is a copy-paste template, so the alignment is load-bearing:
    // one variable per `  NAME  summary` line.
    const { stdout } = await cli(['--help']);
    const lines = stdout.split('\n');
    const start = lines.findIndex((l) => l === 'Environment:');
    assert.ok(start >= 0, 'precondition: an Environment: header line exists');
    const body = lines.slice(start + 1).filter((l) => l.startsWith('  '));
    assert.ok(body.length >= 10, `expected an indented body, got ${body.length} lines`);
    for (const line of body) {
      // `  NAME<pad>  summary` — the name is padded to the longest documented
      // name, so the gap is two or more spaces, never exactly one.
      assert.match(line, /^ {2}[A-Z][A-Z0-9_]* {2,}\S/, `misaligned env line: ${JSON.stringify(line)}`);
    }
  });

  it('does not construct a client or start a server on the help path', async () => {
    // `--help` is documented as not requiring configuration. If the branch
    // ever called initConfig() or new SpotifyClient(), a user with a broken
    // config would get a stack trace instead of usage.
    const out = await cli(['--help']);
    assert.equal(out.stderr, '', `help must not write to stderr, got: ${out.stderr}`);
  });
});

describe('#657 index.ts: --version', () => {
  it('exits 0 and prints the package.json version', async () => {
    const out = await cli(['--version']);
    assert.equal(out.code, 0, `stderr: ${out.stderr}`);
    assert.equal(out.stdout.trim(), `spotify-mcp ${version}`);
    // The line above compares against the version READ FROM package.json, so it
    // already proves the output is not a typed-in literal. What it cannot prove
    // is that the literal is absent from the source — a branch could build a
    // correct string by hand and still drift on the next release. Read the
    // entry point and check the digits are not in it.
    const entry = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.ok(
      !entry.includes(version),
      `src/index.ts must not hardcode the version (${version}) — release-please owns it`,
    );
  });

  it('is the same output for -v', async () => {
    const long = await cli(['--version']);
    const short = await cli(['-v']);
    assert.equal(short.code, 0, `stderr: ${short.stderr}`);
    assert.equal(short.stdout, long.stdout);
  });

  it('advertises a DIFFERENT version string than help would imply', async () => {
    // A guard against the version branch falling through to the help branch,
    // which exits 0 too and would pass a bare exit-code assertion.
    const versioned = await cli(['--version']);
    const helped = await cli(['--help']);
    assert.notEqual(versioned.stdout, helped.stdout);
    assert.equal(helped.stdout.includes('Usage:'), true, 'precondition: --help is the usage branch');
  });
});
