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
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRANDING_NOTICE,
  NON_AFFILIATION_NOTICE,
  SHORT_NON_AFFILIATION_NOTICE,
  TRADEMARK_NOTICE,
} from '../src/branding.js';
import { renderDoctorProse, type DoctorReport } from '../src/tools/doctortool.js';
// Both child harnesses are the shared ones, in `tests/helpers/` (#1379).
//
// This file used to hand-roll both child harnesses — an async spawn plus a
// pending promise for `initialize`, and a promisified `execFile` for the CLI
// — each with its own copy of the signal handling. The `stdio-child.js`
// import that used to sit above was for `describeHostPressure` alone: a file
// can import the correct implementation and still not use it, which is the
// hole #1404's gate was written against. It now uses both, and spawns nothing
// of its own.
//
// One vocabulary for "how did the child end" is borrowed rather than
// re-invented: `classifyChild`/`describeOutcome` are #1335's, and
// `describeHostPressure` is #1366's. A second way to say "killed by SIGKILL" in
// this repo would be the exact drift those helpers exist to stop.
import { cliStdout, runCliSubcommand, type CliRun } from './helpers/cli-child.js';
import { StdioJsonRpcChild } from './helpers/stdio-child.js';

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

/**
 * The `initialize` response, read off a real server process, through the
 * shared harness.
 *
 * This is the assertion the issue's acceptance criteria ask for, and it is
 * deliberately behavioural. Reading `src/index.ts` for the string would pass
 * if the constant were computed and then never handed to `McpServer` — the
 * exact regression `instructions: SERVER_INSTRUCTIONS` can introduce. Spawning
 * and asking is the only version that cannot be fooled.
 *
 * `entry` is a parameter so the harness's own failure paths are reachable from a
 * test — see the "harness" describe block below. A harness that cannot be
 * pointed at a broken server is a harness whose error reporting is untested.
 *
 * ## What moving to the shared harness changed, and what it did not (#1379)
 *
 * The version this replaced hand-rolled the whole path: an async spawn, a
 * buffer, a `Promise.withResolvers` deferred it owned, and its own `exit` and
 * `error` listeners. Three properties of it were worth keeping, and each has an exact
 * counterpart on the surviving side:
 *
 * | the hand-rolled copy                             | where it lives now |
 * |--------------------------------------------------|--------------------|
 * | pre-spawn shape check on the deferred's callbacks | structurally impossible — the caller no longer owns a deferred at all, and the helper's own handlers run through `guardedHandler`, so a throw is reported (`stdio-child.test.ts`) rather than wedging the runner |
 * | callback-independent teardown (the watchdog killed the child itself) | `StdioJsonRpcChild.killNow()` — PID-scoped and `isOwnChild`-checked — plus `dispose()`, which also destroys the three stdio streams. The copy killed the child but never released the pipes, so it kept the `PipeWrap` leak #1365 documents. |
 * | exit handler naming code and signal, with stderr  | the same, via `describeExit`, which additionally carries the pid, #1335's outcome vocabulary and a host-pressure reading |
 *
 * The `makeDeferred` seam is the one thing that has no counterpart and does not
 * need one: it existed so a test could hand the harness the exact broken shape
 * `{promise, resolveWith, rejectWith}` that caused the #1370 wedge. The
 * consolidated harness cannot be handed a broken deferred, because it does not
 * accept one. The class it defended is covered where it now lives — see
 * "a throw inside an event handler is reported, not fatal (#1366)" in
 * `tests/stdio-child.test.ts`, which drives a throwing handler body against a
 * real child and fails if the report goes away.
 */
async function initializeFrom(entry: string): Promise<string | undefined> {
  const env = childEnv();
  delete env.SPOTIFY_SCOPES; // absent, not empty: #617 rejects a set-but-empty value
  const child = StdioJsonRpcChild.spawn({
    label: `branding-guard ${entry}`,
    command: process.execPath,
    args: ['--import', 'tsx/esm', entry],
    cwd: ROOT,
    env,
    requestTimeoutMs: CLI_TIMEOUT_MS,
  });
  try {
    const init = await child.initialize('branding-guard');
    return init.result?.instructions as string | undefined;
  } finally {
    await child.dispose();
  }
}

/** The real server. Thin wrapper so every call site below reads as "the server". */
const initializeInstructions = (): Promise<string | undefined> => initializeFrom('src/index.ts');

const CLI_TIMEOUT_MS = 30_000;
const CLI_ENTRY = path.join(ROOT, 'src', 'index.ts');

/**
 * Run a one-shot CLI subcommand, through the shared harness.
 *
 * The harness itself — the three-way outcome, the re-spelling of an async
 * `execFile` failure into #1335's vocabulary, and the report that tells a signal
 * kill from a hang from a child that never started — moved to
 * `tests/helpers/cli-child.ts` in #1379. What stays here is the two things that
 * are properties of *this* test and not of the harness: the fixture env, and
 * the fact that the entry point is the real server.
 *
 * The `options` seam is narrower than the copy's. It had `entry` so the #1378
 * regression tests could point it at a fixture; those tests moved with the
 * harness to `tests/cli-child.test.ts`, so the only option left here is the env
 * override, which the runtime-surface cases below do not use. A seam with no
 * caller is a second place for the harness's behaviour to live.
 */
function cli(args: string[], options: { readonly env?: NodeJS.ProcessEnv } = {}): Promise<CliRun> {
  return runCliSubcommand({
    entry: CLI_ENTRY,
    cwd: ROOT,
    env: childEnv(options.env),
    args,
    timeoutMs: CLI_TIMEOUT_MS,
  });
}

/**
 * Does this file build its own child harness, or delegate to `tests/helpers/`?
 *
 * ## Why this is a test and not a comment
 *
 * #1379 is a *consolidation*, and a refactor has no behaviour to regress — so
 * the only thing that can go red is the thing being removed. A comment saying
 * "this file delegates now" is a claim with no teeth; the next person copying a
 * child-spawning block back in would not notice, and the file would be back to
 * two harnesses with two copies of the signal handling — which is the state
 * #1366 was fixed in one place and left alive in the other.
 *
 * ## What it is deliberately *not*
 *
 * This is one predicate about one file. It is not a suite-wide gate, and it
 * should not grow into one: a general "every test file must delegate" scan is
 * #1404's gate, on the branch that fixes #1404 and #1405, asking a different
 * question — does a file that spawns a child *have* a signal-naming `exit`
 * listener, rather than does it *own* a harness. Two scans with adjacent scope
 * and different questions are two conventions to keep in step. This one asserts
 * the single claim #1379 makes about the single file #1379 names.
 *
 * ## Why the needles are assembled from parts
 *
 * The rule below is run against **this file's own source**, and the negative
 * fixtures further down have to *contain* the shapes they test for. Written as
 * literals, each needle would match its own fixture — and the check would be
 * red forever, for a reason that has nothing to do with the harnesses. So the
 * two needles are built by joining halves, and no comment in this file may
 * spell either of them out in full. That is a real constraint on this file, and
 * it is the price of a self-applicable check.
 */

/** The async spawn call, not the synchronous one, and not a method call. */
const ASYNC_SPAWN = new RegExp(`(^|[^\\w.])${'sp' + 'awn'}\\(`);

/** `execFile` wrapped by `promisify` — the one-shot CLI harness's shape. */
const PROMISIFIED_EXEC_FILE = new RegExp(`promisify\\(\\s*${'exec' + 'File'}\\s*\\)`);

/** The two modules the harnesses now live in. */
const DELEGATES_TO = ['./helpers/stdio-child.js', './helpers/cli-child.js'] as const;

/**
 * The needles, for the fixtures that have to spell them out.
 *
 * Using these keeps a fixture and the rule it is testing in step: the fixture
 * emits the real text at runtime, and this file never carries it at rest.
 */
const NEEDLE = {
  spawn: `${'sp' + 'awn'}(`,
  promisifiedExec: `promisify(${'exec' + 'File'})`,
} as const;

/**
 * The three fault strings.
 *
 * Named rather than inlined so the negative fixtures can assert the exact text
 * the rule produces. A fixture that re-typed the expected string would go stale
 * the moment a message is reworded, and would then be asserting its own copy
 * instead of the rule's.
 */
const FAULT = {
  ownsStdio: `calls \`${NEEDLE.spawn}\` itself, so it owns a stdio child harness rather than delegating`,
  ownsCli: 'wraps execFile in promisify, so it owns a one-shot CLI child harness rather than delegating',
  missingImport: (specifier: string): string =>
    `does not import \`${specifier}\`, so it cannot be delegating to the shared harness`,
} as const;

function childHarnessFaults(source: string): string[] {
  const faults: string[] = [];
  if (ASYNC_SPAWN.test(source)) faults.push(FAULT.ownsStdio);
  if (PROMISIFIED_EXEC_FILE.test(source)) faults.push(FAULT.ownsCli);
  for (const specifier of DELEGATES_TO) {
    if (!source.includes(`from '${specifier}'`)) faults.push(FAULT.missingImport(specifier));
  }
  return faults;
}

// ------------------------------------------------------------------ the guard

/**
 * The consolidation itself, tested (#1379).
 *
 * The rest of this file proves the *behaviour* survived the move — the notice is
 * still read off a real process, and a dead one is still reported with its
 * cause. None of that can tell the difference between one harness and two, so
 * the property that actually regressed when a second copy creeps back in gets
 * its own case, read off this file's own source.
 */
describe('this file delegates its child harnesses instead of owning them (#1379)', () => {
  it('builds neither a stdio nor a CLI child harness of its own', () => {
    // The regression, driven rather than described. On `origin/main` this file
    // called the async spawn itself for `initializeFrom` and promisified
    // `execFile` for `cli()`, each with its own copy of the exit handling — so
    // a `SIGKILL` was reported one way here and another way in
    // `tests/helpers/stdio-child.ts`, and #1366 was fixed in one and left alive
    // in the other.
    const faults = childHarnessFaults(readRepoFile('tests/branding-notice-guard.test.ts'));
    assert.deepEqual(
      faults,
      [],
      `tests/branding-notice-guard.test.ts must use the shared harnesses in tests/helpers/. `
        + `${faults.join('; ')}. Two harnesses for one job drift: the next #1366-class defect gets `
        + `fixed in whichever file its reporter happened to open, and the reader gets a different `
        + `answer depending on the file the failure came from.`,
    );
  });

  it('rejects a file that hand-rolls a stdio child, and says why', () => {
    // The negative fixture, and the reason the predicate above is not a
    // tautology. This is the shape that was deleted, reduced to the lines the
    // predicate reads: the two call shapes, and no import of the stdio helper —
    // the exact state of this file before the consolidation. Built from
    // `NEEDLE` so this file does not carry the text the rule is looking for.
    const faults = childHarnessFaults([
      `const run = ${NEEDLE.promisifiedExec};`,
      `const child = ${NEEDLE.spawn}process.execPath, entry);`,
      "import { cliStdout } from './helpers/cli-child.js';",
    ].join('\n'));

    assert.deepEqual(
      faults,
      [
        FAULT.ownsStdio,
        FAULT.ownsCli,
        FAULT.missingImport('./helpers/stdio-child.js'),
      ],
      'a hand-rolled stdio child must be reported, and the report must name the missing import too',
    );
  });

  it('rejects a file that delegates to only one of the two harnesses', () => {
    // The half-migrated state, which is the one a partial fix produces and the
    // one the real file once sat in: it imported `stdio-child.js` for
    // `describeHostPressure` and still owned both spawn paths. That is the
    // specific hole #1404's gate was written against — a file can import the
    // correct implementation and still not use it — so it needs its own case.
    const faults = childHarnessFaults([
      "import { describeHostPressure } from './helpers/stdio-child.js';",
      `const child = ${NEEDLE.spawn}process.execPath, argv);`,
    ].join('\n'));

    assert.ok(
      faults.includes(FAULT.ownsStdio),
      'importing the helper for one function must not be mistaken for delegating to it',
    );
    assert.ok(
      faults.includes(FAULT.missingImport('./helpers/cli-child.js')),
      'a file with no CLI harness at all is a different problem from one that owns its own',
    );
  });
});

describe('non-affiliation notice: the runtime surfaces (#705)', () => {
  it('a host-only agent receives the notice in its initialize instructions', async () => {
    const instructions = await initializeInstructions();
    // `startsWith`, not `===`. #690 appends the host guidance (the discovery
    // trio, the dry_run convention, the toolset knobs, the receipt lifetime)
    // to this string, so equality would fail the moment guidance is added and
    // would have had to be deleted to add it. The claim this test exists to
    // make is that the notice REACHES the host verbatim and cannot be skipped
    // — which is position, not identity: a host that trims a long string
    // keeps the start, so a notice demoted to the last paragraph of a prompt
    // is exactly the failure #705 was filed to prevent.
    assert.ok(
      instructions?.startsWith(BRANDING_NOTICE),
      'the initialize response must lead with the exported BRANDING_NOTICE. This is the ' +
        'only surface a host-only agent sees — no README, no npm page, no repository — and a ' +
        `notice that exists only in documents does not reach one. Got: ${JSON.stringify(instructions)}`,
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
    const stdout = cliStdout(await cli(['doctor']));
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
    const stdout = cliStdout(await cli(['--help']));
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

/**
 * The stdio path, tested (#1366, re-pointed at the shared harness by #1379).
 *
 * The file above is only trustworthy if the process it spawns fails the way a
 * test should fail. It did not, once: the callbacks destructured out of
 * `Promise.withResolvers` were `undefined`, calling one inside the stdout
 * handler threw, and an exception on a stream is not routed to the assertion
 * machinery. The promise then never settled, so the teardown chained to
 * `finally` never ran, the child was never killed, and its ref'd stdio pipes
 * held the runner open — the runner died reporting nothing and the run leaked
 * for 35 minutes.
 *
 * **What changed when the harness moved, and why one case is gone.** The first
 * case this block used to hold drove `initializeFrom` with the exact broken
 * shape the first draft destructured — `{promise, resolveWith, rejectWith}` —
 * through a `makeDeferred` seam, and asserted the harness refused it before
 * spawning anything. That seam was the *only* reason a caller could supply a
 * malformed deferred at all. `StdioJsonRpcChild` does not take one: it owns its
 * own settlement, so the class is unreachable from here rather than merely
 * guarded against. The class itself is covered where it now lives — "a throw
 * inside an event handler is reported, not fatal (#1366)" in
 * `tests/stdio-child.test.ts` drives a throwing handler body against a real
 * child and fails if the report goes away.
 *
 * The cases below are about the *product* boundary, and they are the point of
 * this file: a real server process that dies before answering must fail with
 * its cause, in the caller's own stack, promptly, and it must say which of the
 * two ways it died. They stay here rather than folding into the helper's own
 * test file because what they protect is this guard reading the notice off a
 * real child.
 */
describe('the stdio path fails with a cause (#1366)', () => {
  it('rejects with the exit code when the server dies before answering', async () => {
    // A module that does not exist: node starts, fails to resolve it, and
    // exits non-zero without writing a frame. That is the same shape as a
    // child that fell over during module load, which is the case #1366 is about.
    await assert.rejects(
      () => initializeFrom('src/no-such-entry-point.ts'),
      (err: Error) => {
        // The helper's wording is #1335's vocabulary plus the pid and a
        // host-pressure line; the copy's own phrasing ("exited before
        // answering initialize") is gone, and these assertions were re-pointed
        // at the surviving text rather than loosened.
        assert.match(
          err.message,
          /the server process exited 1 \(code=1 signal=null pid=\d+\)/,
          `a dead child must be reported with its exit code, got: ${err.message}`,
        );
        assert.match(
          err.message,
          /branding-guard src\/no-such-entry-point\.ts/,
          `the report must name the child it was waiting on, got: ${err.message}`,
        );
        assert.doesNotMatch(
          err.message,
          /timed out after/,
          'the watchdog fired instead of the exit handler — the harness is still discarding the cause',
        );
        return true;
      },
    );
  });

  it('names the signal when the child is killed mid-request, not an exit code', async () => {
    // The other way a child dies, and the one the whole helper exists for.
    // Under load this is what a loaded box produces, and it is the case where
    // `code` is `null`: a report built from the exit code alone would say
    // "exited with code null" and file an OOM kill under a clean exit, which is
    // the #1405 defect one layer down from here.
    const dir = await mkdtemp(path.join(tmpdir(), 'x1379-sigkill-'));
    const entry = path.join(dir, 'dies.mjs');
    await writeFile(entry, 'process.kill(process.pid, "SIGKILL");\n', 'utf8');
    try {
      const started = Date.now();
      await assert.rejects(
        () => initializeFrom(entry),
        (err: Error) => {
          assert.match(
            err.message,
            /the server process killed by SIGKILL \(code=null signal=SIGKILL pid=\d+\)/,
            `a signal-killed child must be named by its signal, got: ${err.message}`,
          );
          assert.doesNotMatch(
            err.message,
            /timed out after/,
            'the watchdog fired instead of the exit handler — a kill is being reported as a hang',
          );
          return true;
        },
      );
      // And promptly: this is the case that used to sit out the full watchdog.
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 20_000, `a signalled child must reject on the exit event, took ${elapsed}ms`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects within the watchdog, not after it', async () => {
    // The point of the exit handler is that a dead child fails in the child's
    // lifetime. If this ever takes 30 s the assertion above is passing for the
    // wrong reason, so the deadline is asserted rather than left to the runner.
    const started = process.hrtime.bigint();
    await assert.rejects(() => initializeFrom('src/no-such-entry-point.ts'));
    const elapsedMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    assert.ok(
      elapsedMs < 20_000,
      `a dead child must reject promptly, took ${elapsedMs}ms — that is the watchdog, not the exit handler`,
    );
  });

  it('the real server still answers through the same path', async () => {
    // The control. Without it the two tests above would also pass against a
    // harness that rejects unconditionally and instantly, which is the shape a
    // "fix" written as `fail()` in the spawn would take.
    const instructions = await initializeFrom('src/index.ts');
    assert.ok(
      instructions?.startsWith(BRANDING_NOTICE),
      'precondition: the real server still answers initialize; got ' + JSON.stringify(instructions),
    );
  });
});
