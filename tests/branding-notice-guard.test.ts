/**
 * Non-affiliation notice guard (#705).
 *
 * The project keeps the name "SpotifyMCP" for v2 as a recorded, accepted risk
 * against Spotify's Developer Policy Sec. VI.2 — see
 * `docs/compliance.md#naming-decision-2026-09-18`. That decision is only
 * defensible if nobody can be left thinking this is an official integration, so
 * the notice has to be on every surface, and the whole failure mode of a
 * compliance notice is that it decays silently: the notice is added, a
 * surface is added later, and the new surface ships without it, and nothing
 * fails.
 *
 * This guard is what makes that a red test instead of a habit. It asserts one
 * exported constant against every surface that must carry it, and — the part
 * that matters most — it reads the MCP `initialize` response and the CLI's own
 * stdout back off a *spawned process* rather than off the source text. A file
 * that stops containing the words is caught; so is `src/index.ts` quietly
 * dropping the constant while the docs stay correct, which is the failure a
 * grep-based guard cannot see.
 *
 * It sits alongside `tests/distribution-channel-guard.test.ts` (a guard for
 * the surfaces themselves rather than for the words on them) and
 * `tests/registry-meta.test.ts`, which owns the 100-character-capped
 * description this file asserts only the tail of. Nothing here re-authors the
 * canonical description, and nothing here edits a release-please-owned file.
 *
 * Run: node --import tsx --test tests/branding-notice-guard.test.ts
 */
import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  BRANDING_NOTICE,
  NON_AFFILIATION_NOTICE,
  SHORT_NON_AFFILIATION_NOTICE,
  TRADEMARK_NOTICE,
} from '../src/branding.js';
import { renderDoctorProse, type DoctorReport } from '../src/tools/doctortool.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  description: string;
};
const server = JSON.parse(readFileSync(path.join(ROOT, 'server.json'), 'utf8')) as {
  description: string;
};
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const distribution = readFileSync(path.join(ROOT, 'docs/distribution.md'), 'utf8');
const compliance = readFileSync(path.join(ROOT, 'docs/compliance.md'), 'utf8');

/** The registry's `ServerDetail.description` cap — the reason two forms exist. */
const REGISTRY_DESCRIPTION_MAX = 100;

function readRepoFile(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function listFilesIn(relativeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk(relativeDir);
  return out.sort();
}

/** Body of a `## <heading>` section, trimmed. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `no "## ${heading}" section found`);
  const rest = md.slice(start + `## ${heading}\n`.length);
  const end = rest.indexOf('\n## ');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * Unwrap a hard-wrapped markdown blurb. Without this the check reads zero
 * occurrences of a sentence the file does carry — the failure mode that made
 * the original surface inventory wrong in the first place.
 */
function unwrap(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^>\s?/, ''))
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** README prose above the first generated block: headings and badges are not the one-liner. */
function readmeOneLiner(): string {
  const generated = readme.indexOf('<!-- BEGIN:generated');
  assert.notEqual(generated, -1, 'README.md must keep its generated block markers');
  for (const line of readme.slice(0, generated).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('![')) continue;
    if (trimmed.startsWith('[') || trimmed.startsWith('>') || trimmed === '---') continue;
    return trimmed;
  }
  throw new Error('README.md has no prose one-liner above the first generated block');
}

// ---------------------------------------------------------------- subprocesses

let home: string;

before(async () => {
  // An isolated HOME. Nothing here may read or write the real ~/.spotify-mcp.
  home = await mkdtemp(path.join(tmpdir(), 'x705-branding-'));
  await writeFile(
    path.join(home, 'tokens.json'),
    JSON.stringify({ access_token: 'branding-test', refresh_token: 'branding-test', expires_at: Date.now() + 3_600_000 }),
    'utf8',
  );
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    SPOTIFY_CLIENT_ID: 'branding-test',
    SPOTIFY_MCP_TOKEN_FILE: path.join(home, 'tokens.json'),
  };
  return { ...env, ...extra };
}

interface JsonRpc {
  id?: number;
  result?: { instructions?: string; serverInfo?: { name?: string; version?: string } };
  error?: { code: number; message: string };
}

/**
 * The `initialize` response, read off a real server process.
 *
 * This is the assertion the issue's acceptance criteria ask for, and it is
 * deliberately behavioural. Reading `src/index.ts` for the string would pass
 * if the constant were computed and then never handed to `McpServer` — the
 * exact regression `instructions: SERVER_INSTRUCTIONS` can introduce. Spawning
 * and asking is the only version that cannot be fooled.
 */
function initializeInstructions(): Promise<string | undefined> {
  const baseEnv = childEnv();
  delete baseEnv.SPOTIFY_SCOPES; // absent, not empty: #617 rejects a set-but-empty value
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/index.ts'], {
    cwd: ROOT,
    env: baseEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const { promise, resolve: settle, reject: fail } = Promise.withResolvers<string | undefined>();
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    stderr += c;
  });
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as JsonRpc;
      if (msg.id === 1) {
        if (msg.error) fail(new Error(`initialize failed: ${msg.error.code} ${msg.error.message}`));
        else settle(msg.result?.instructions);
      }
    }
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'branding-guard', version: '1.0.0' },
      },
    })}\n`,
  );
  // Watchdog only: the server is a separate process whose timers cannot be
  // faked from here, so a real deadline is the only way to fail fast instead
  // of wedging the suite.
  setTimeout(() => fail(new Error(`timeout waiting for initialize\nstderr:\n${stderr}`)), 30_000).unref();
  // The child is external, so tear it down on both outcomes: end stdin so a
  // healthy server exits on its own, and SIGKILL shortly after so a wedged one
  // cannot hold the runner open. The `.catch` is load-bearing — `finally()`
  // returns a *new* promise, and a watchdog rejection with no handler on that
  // derivative is an unhandled rejection that takes the suite down instead of
  // failing one assertion.
  void promise
    .finally(() => {
      child.stdin.end();
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    })
    .catch(() => {});
  return promise;
}

const CLI_TIMEOUT_MS = 30_000;

/**
 * Run a one-shot CLI subcommand and return whatever it printed.
 *
 * A non-zero exit is returned rather than thrown: `doctor` exits 1 whenever
 * any check fails, and with a fixture token it always will. The notice is
 * printed on the banner *before* the report is collected, so the partial
 * output of a failed run is still the thing under test — which is why a
 * killed child returns its stdout instead of an empty string.
 */
async function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx/esm', path.join(ROOT, 'src', 'index.ts'), ...args],
      { cwd: ROOT, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', env: childEnv(extraEnv) },
    );
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string };
    return e.stdout ?? '';
  }
}

// ------------------------------------------------------------------ the guard

describe('non-affiliation notice: the runtime surfaces (#705)', () => {
  it('a host-only agent receives the notice in its initialize instructions', async () => {
    const instructions = await initializeInstructions();
    assert.equal(
      instructions,
      BRANDING_NOTICE,
      'the initialize response must carry the exported BRANDING_NOTICE verbatim. This is the ' +
        'only surface a host-only agent sees — no README, no npm page, no repository — and a ' +
        'notice that exists only in documents does not reach one. Pass it as ' +
        '{ instructions } to the McpServer constructor (src/index.ts); a string computed but ' +
        'not handed over fails here and nowhere else.',
    );
  });

  it("spotify_doctor's rendered prose opens with the notice", () => {
    const report: DoctorReport = {
      ok: true,
      rows: [{ id: 'token', status: 'pass', summary: 'token present' }],
      surface: {} as DoctorReport['surface'],
    };
    const prose = renderDoctorProse(report, true);
    const lines = prose.split('\n');
    assert.equal(lines[0], 'Spotify doctor — 1 check(s), no failures', 'precondition: the summary line leads');
    assert.equal(
      lines[1],
      BRANDING_NOTICE,
      "spotify_doctor's prose header must be the exported BRANDING_NOTICE. This is the " +
        'agent-facing identity line and the text users paste into issue reports; both the tool ' +
        'and the CLI subcommand render through this function, so neither can drift from it.',
    );
  });

  it('the CLI doctor banner carries the notice, above the Configuration block', async () => {
    const stdout = await cli(['doctor']);
    // Position, not `includes`. The rendered report *also* carries the notice
    // (see the prose test above), so a bare substring check is satisfied by the
    // report and passes with the banner line deleted — an assertion that
    // cannot fail. The banner is its own claim: it is what a reader sees
    // before scrolling to any row, so it is asserted as its own line.
    const lines = stdout.split('\n');
    assert.match(
      lines[0] ?? '',
      /^spotify-mcp \d+\.\d+\.\d+/,
      `precondition: the doctor opens with the version banner; got ${JSON.stringify(lines[0])}`,
    );
    assert.equal(
      lines[1],
      NON_AFFILIATION_NOTICE,
      '`spotify-mcp doctor` must print the non-affiliation notice on the banner, directly under ' +
        'the version line. That output is what a user pastes into a bug thread, and the banner is ' +
        'what is read while deciding whether this is an official Spotify integration. Print it from ' +
        'the exported constant (src/index.ts), not as a hand-typed sentence.',
    );
  });

  it('the --help banner carries the notice, directly under the title line', async () => {
    const stdout = await cli(['--help']);
    const lines = stdout.split('\n');
    assert.equal(
      lines[0],
      'spotify-mcp — MCP server for the Spotify Web API',
      'precondition: help opens with the title line',
    );
    assert.equal(
      lines[1],
      BRANDING_NOTICE,
      '`spotify-mcp --help` must carry the full branding notice as its second line. The help text ' +
        'is the first thing a prospective installer reads, and the name it opens with is the one ' +
        'Policy Sec. VI.2 objects to.',
    );
  });

  it('the notice is not a hand-typed second copy anywhere in src/', () => {
    const offenders = listFilesIn('src').filter((file) => {
      if (file === 'src/branding.ts') return false;
      return readRepoFile(file).includes('Not affiliated with');
    });
    assert.deepEqual(
      offenders,
      [],
      `the notice wording belongs to src/branding.ts alone. These files author their own copy: ` +
        `${offenders.join(', ')}. A per-surface paraphrase is exactly the drift the single ` +
        `constant exists to prevent, and no grep for the exact string would catch it.`,
    );
  });
});

describe('non-affiliation notice: the metadata surfaces (#705)', () => {
  /**
   * The short form, on every surface whose value IS the description. The
   * sentence itself is owned by `CANONICAL_DESCRIPTION` in
   * `tests/registry-meta.test.ts`; this asserts only that what actually ships
   * ends in this guard's copy of the tail, which is what ties the two
   * constants to each other without duplicating either.
   */
  const shortSurfaces = (): Array<[string, string]> => [
    ['package.json description', pkg.description],
    ['server.json description', server.description],
    ['README.md one-liner', readmeOneLiner()],
    ['docs/distribution.md short blurb', unwrap(section(distribution, 'Short blurb (directories)'))],
  ];

  it('the short form is the tail of every capped description, and fits the cap', () => {
    const bad = shortSurfaces()
      .filter(([, value]) => !value.endsWith(SHORT_NON_AFFILIATION_NOTICE))
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
    assert.deepEqual(
      bad,
      [],
      `these surfaces do not end with the non-affiliation notice (${SHORT_NON_AFFILIATION_NOTICE}): ` +
        `${bad.join(' | ')}. A user who installs from npm or the MCP Registry reads only this text.`,
    );
    for (const [name, value] of shortSurfaces()) {
      assert.ok(
        value.length <= REGISTRY_DESCRIPTION_MAX,
        `${name} is ${value.length} chars; the MCP Registry caps description at ${REGISTRY_DESCRIPTION_MAX}. ` +
          'Appending the notice must not push a mirror over the cap — shorten the capability claim instead.',
      );
    }
  });

  it('the long blurb leads with the notice rather than burying it', () => {
    // A prefix, not a suffix: the long description continues into a capability
    // tour, so "ends with" is the wrong predicate for it. `includes` is what
    // keeps the guarantee honest — the notice must be *inside* the blurb, and
    // the blurb is what a directory card is pasted from.
    const long = unwrap(section(distribution, 'Long description (Glama / PulseMCP style)'));
    assert.ok(
      long.startsWith('Spotify Web API MCP:') && long.includes(SHORT_NON_AFFILIATION_NOTICE),
      `docs/distribution.md long description must lead with the capability claim and carry ` +
        `${SHORT_NON_AFFILIATION_NOTICE} inside it; it currently reads: ${long.slice(0, 160)}…`,
    );
  });

  it('the README pairs the notice with the Developer Terms link', () => {
    assert.ok(
      readme.includes(SHORT_NON_AFFILIATION_NOTICE) && readme.includes('developer.spotify.com/terms'),
      'README.md must carry the non-affiliation notice alongside the Spotify Developer Terms link',
    );
  });

  it('the two notice forms are one disclosure, not two competing claims', () => {
    // The cap is the only reason the short form exists; the long form must
    // therefore be a superset in meaning. A long form that dropped "unofficial"
    // or narrowed "not affiliated" to something else would be a weaker claim
    // on exactly the surfaces a first-time reader sees.
    assert.ok(
      NON_AFFILIATION_NOTICE.startsWith('Independent, unofficial project.'),
      'the long form must open by denying official status — that is the impression Policy Sec. VI.2 ' +
        'is about, and the first-glance answer to it.',
    );
    for (const clause of ['not affiliated', 'endorsed by', 'sponsored by']) {
      assert.ok(
        NON_AFFILIATION_NOTICE.toLowerCase().includes(clause),
        `the long form must deny ${clause}: Terms Sec. IX.7 forbids suggesting endorsement, which is a ` +
          'claim about how the product reads rather than about who runs it',
      );
    }
    assert.equal(
      BRANDING_NOTICE,
      `${NON_AFFILIATION_NOTICE} ${TRADEMARK_NOTICE}`,
      'BRANDING_NOTICE must be the two sentences joined — surfaces with room carry the trademark ' +
        'sentence too, and it is composed here rather than re-typed at each call site',
    );
    assert.ok(
      SHORT_NON_AFFILIATION_NOTICE.length < NON_AFFILIATION_NOTICE.length,
      `the short form (${SHORT_NON_AFFILIATION_NOTICE}) must be the shortened one; if it is not, the ` +
        'two forms have been swapped and the cap argument no longer holds',
    );
  });
});

describe('the recorded name decision (#705)', () => {
  const naming = (): string => section(compliance, 'Naming decision (2026-09-18)');
  const noticeDoc = (): string => section(compliance, 'The non-affiliation notice');

  it('states the date, both options, the choice and the accepted risk', () => {
    const doc = naming();
    for (const required of [
      '2026-09-18',
      'should not begin with',
      'Sec. VI.2',
      'Option A',
      'Option B',
    ]) {
      assert.ok(
        doc.includes(required),
        `docs/compliance.md "Naming decision (2026-09-18)" must record ${JSON.stringify(required)}. ` +
          'A decision log that omits the rejected option, or the date, is a rationale without a ' +
          'decision, and the next maintainer cannot tell which parts are load-bearing.',
      );
    }
    assert.match(
      doc,
      /Decision: Option B/i,
      'the page must say which option was taken, not merely describe both',
    );
  });

  it('records the re-check trigger', () => {
    const doc = naming();
    assert.match(
      doc,
      /Re-check trigger/i,
      'docs/compliance.md must carry the re-check trigger: the decision is only valid while the ' +
        'conditions that justified it hold, and a reader needs to know what invalidates it',
    );
    assert.match(
      doc,
      /directory|marketplace|listing/i,
      'the trigger must name a distribution channel — that is the concrete event that reopens the question',
    );
  });

  it('is linked from the distribution checklist, where a channel is actually added', () => {
    const checklist = section(distribution, 'Claim checklist');
    assert.match(
      checklist,
      /name re-check/i,
      'docs/distribution.md § Claim checklist must carry the name re-check. Recording the trigger ' +
        'only in docs/compliance.md puts it one hop from the person about to submit a listing.',
    );
    assert.ok(
      checklist.includes('compliance.md'),
      'the checklist item must link to docs/compliance.md, which holds the decision itself',
    );
  });

  it('documents the notice wording, both forms, and the surfaces that must carry them', () => {
    const doc = noticeDoc();
    for (const required of ['src/branding.ts', SHORT_NON_AFFILIATION_NOTICE, 'initialize', '100']) {
      assert.ok(
        doc.includes(required),
        `docs/compliance.md "The non-affiliation notice" must record ${JSON.stringify(required)} — ` +
          'the single source, the capped form, the host-only surface, or the cap that forces two forms',
      );
    }
  });

  it('names the surfaces deliberately excluded, so an absence is not read as an oversight', () => {
    const doc = noticeDoc();
    for (const excluded of ['SECURITY.md', 'CODE_OF_CONDUCT.md', '--version']) {
      assert.ok(
        doc.includes(excluded),
        `docs/compliance.md must name ${excluded} among the surfaces that deliberately do not carry ` +
          'the notice, with the reason. An unlisted absence is indistinguishable from a gap, and the ' +
          'next maintainer either re-litigates it or silently adds the notice to --version and breaks ' +
          'the scripts that parse it.',
      );
    }
  });
});
