/**
 * #1481 — the wire-equivalence harness must be committed, reproducible, and
 * hermetic, and its comparison must be shown to detect a difference.
 *
 * ## What the issue reports, and what each half here answers
 *
 * The issue makes two claims about the missing harness, and they fail
 * differently:
 *
 *  1. **"a 258-call-site refactor shipped an unreproducible md5."** The probe
 *     was not in the diff, so a reviewer could not re-run it. The fix is a
 *     committed harness whose output is byte-stable — asserted here by running
 *     the real script TWICE and comparing the two files with `cmp`, because
 *     "the digest is printed" is not "the digest is reproducible".
 *
 *  2. **"its ad-hoc probe wrote to the real `~/.spotify-mcp/`."** Fixed by
 *     `HOME` being redirected before any server import. An assertion that
 *     `process.env.HOME` was assigned cannot see a file written, so this file
 *     checks the WRITES: it hands the harness a `HOME` that is a throwaway
 *     fixture, and requires the store a write-capable tool produces to land in
 *     the harness's own sandbox rather than the fixture.
 *
 * ## The anti-vacuity rule, and how it is honoured three times over
 *
 * AGENTS.md §6: "a test that cannot fail is worse than no test". A comparison
 * that always reports "no differences" passes forever and is worth nothing, so
 * every claim below is shown going red:
 *
 *   - `compareSnapshots` is a pure function, driven here over a synthetic pair
 *     that differs in each of the four ways it reports. The source it is
 *     checked against is a literal in this file, not a re-derivation.
 *   - the `maskValues` test asserts a mask FIRES by feeding it a string
 *     carrying all four shapes, and separately asserts a near-miss
 *     (`rcpt_1`, the pre-#587 bare counter) is NOT masked.
 *   - `synthesizeRequiredArgs` is driven against a schema literal and compared
 *     to a hand-written expectation, so it is not asserting zod's own output
 *     back at itself.
 *
 * ## The behavioural half runs the real script, and the structural half
 * inspects it
 *
 * A green test that only ever exercised a copy of the logic would not tell a
 * reviewer the committed script works. So the anti-vacuity and determinism
 * cases below `spawn` `scripts/wire-equivalence.mjs` as a process and read the
 * files it writes. The structural case then reads that same file's SOURCE and
 * refuses a static `../src/` or `../dist/` import — because ES module imports
 * are hoisted, a static server import would run the server's module
 * initialization, and its store writes, before the `HOME` redirect at the top
 * of the module body. That is the exact defect #1477 shipped, and it is
 * invisible to every other assertion here.
 *
 * Nothing in this file reads, lists, writes or truncates a real
 * `~/.spotify-mcp`. `tests/helpers/hermetic.js` has already redirected the
 * suite's own `HOME` to a temp root by the time this runs, and the "real home"
 * the sandbox assertions compare against is a fresh `mkdtemp` fixture.
 */

import './helpers/hermetic.js';

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CALL_CASES,
  argsForCase,
  compareSnapshots,
  digest,
  formatDiff,
  maskValues,
  parseSnapshot,
  serializeRecord,
  synthesizeRequiredArgs,
  VALUE_MASKS,
} from '../scripts/wire-equivalence-core.mjs';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'scripts/wire-equivalence.mjs');

/** Everything this file creates lives under the OS temp root, and nowhere else. */
const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/**
 * The whole-file bound (#1569).
 *
 * This file spawns real child processes, so a child whose tree still holds an
 * inherited stdio write end can keep this process's `PipeWrap` registered and the
 * loop undrainable — the #1365 failure, which is silent and unbounded because the
 * runner is invoked with no `--test-timeout`. See `helpers/file-deadline.ts`.
 *
 * Armed at module scope, above every hook, because a bound a teardown can clear is
 * not a bound. The timer is `unref`'d, so it cannot itself delay this file.
 */
armFileDeadline({
  label: 'tests/wire-equivalence.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** Run the real harness. A non-zero status is returned, not thrown, so a
 *  `--compare` that correctly fails can be asserted on. */
function runHarness(args: string[], env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// The argument matrix
// ---------------------------------------------------------------------------

describe('the argument matrix is synthesized from each tool\'s own schema', () => {
  // A schema literal, not one produced by the code under test: the point is
  // that the synthesis reads `required` and `properties` and nothing else.
  const SCHEMA = {
    type: 'object',
    required: ['query', 'limit', 'market', 'types', 'detail', 'flag', 'nested', 'mode', 'kind', 'uri'],
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
      market: { type: 'string' },
      types: { type: 'array' },
      detail: { type: 'string' },
      flag: { type: 'boolean' },
      nested: { type: 'object' },
      mode: { type: 'string', enum: ['a', 'b'] },
      kind: { type: 'string' },
      uri: { type: 'string' },
    },
  } as Record<string, unknown>;

  it('fills every required property, by name where it knows one and by shape where it does not', () => {
    assert.deepEqual(synthesizeRequiredArgs(SCHEMA), {
      // BY_NAME wins over the by-type default: `query` is a by-name fixture
      // because "wire-equivalence" is a worse search term than a real-looking
      // one, and the point is to reach handler logic rather than zod.
      query: 'daft punk',
      // `limit` is BOTH a by-name fixture and a by-type one; the by-name table
      // is checked first, so 1 wins. Asserted explicitly so a reordering of
      // those two branches cannot pass unnoticed.
      limit: 1,
      market: 'GB',
      types: ['track'],
      detail: 'wire-equivalence',
      flag: true,
      nested: {},
      // An enum's FIRST value, so the argument is one the schema accepts.
      mode: 'a',
      kind: 'track',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    });
  });

  it('omits a required property it has no value for, rather than guessing', () => {
    // A property with no `type` and no `enum` cannot be synthesized safely.
    // Guessing would produce an argument the schema rejects for a reason that
    // has nothing to do with what is being compared.
    const out = synthesizeRequiredArgs({ type: 'object', required: ['mystery'], properties: { mystery: {} } });
    assert.deepEqual(out, {});
  });

  it('tolerates a schema with no required list and no properties', () => {
    assert.deepEqual(synthesizeRequiredArgs({ type: 'object' }), {});
    assert.deepEqual(synthesizeRequiredArgs({}), {});
  });

  it('sends response_format ONLY to a tool that declares it', () => {
    const declares = { type: 'object', properties: { query: { type: 'string' }, response_format: { type: 'string' } } };
    const doesNot = { type: 'object', properties: { query: { type: 'string' } } };
    // A tool that does not declare it runs with `additionalProperties: false`
    // (src/shaping.ts:26), so sending it would make every case measure the
    // same rejection instead of the tool.
    assert.deepEqual(argsForCase(declares, 'json'), { response_format: 'json' });
    assert.deepEqual(argsForCase(doesNot, 'json'), {});
    assert.deepEqual(argsForCase(doesNot, 'detailed'), {});
    // `empty` is empty for every tool, declared or not.
    assert.deepEqual(argsForCase(declares, 'empty'), {});
    // `required` never carries a format, whatever the tool declares.
    assert.deepEqual(argsForCase(declares, 'required'), {});
  });

  it('gives every tool every case, and keeps the format cases distinct', () => {
    // For a tool that HAS a required argument, all five cases must produce
    // five different argument objects — otherwise one case is measuring the
    // same thing as another and the invocation count overstates the coverage.
    const withRequired = {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, response_format: { type: 'string' } },
    };
    const shapes = CALL_CASES.map((callCase) => JSON.stringify(argsForCase(withRequired, callCase)));
    assert.equal(new Set(shapes).size, CALL_CASES.length, `cases collapse to the same arguments: ${shapes.join(' ')}`);

    // For a tool with NOTHING required, `empty` and `required` are genuinely
    // the same call — there is no argument to fill. That is a property of the
    // matrix, not a defect, and it is asserted here so a future change that
    // made it silently untrue would be caught.
    const noRequired = { type: 'object', properties: { response_format: { type: 'string' } } };
    assert.deepEqual(argsForCase(noRequired, 'empty'), argsForCase(noRequired, 'required'));
    // The format cases still differ from one another, and from both.
    const formats = CALL_CASES.filter((c) => c !== 'empty' && c !== 'required').map((c) => argsForCase(noRequired, c));
    assert.deepEqual(
      formats.map((args) => args.response_format),
      ['json', 'detailed', 'concise'],
    );
  });
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

describe('the per-run value masks are explicit and each one fires', () => {
  it('masks the sandbox path, the receipt boot id, the search-history id, and a temp-file name', () => {
    const line = JSON.stringify({
      path: '/tmp/spotify-mcp-wire-abc123/.spotify-mcp/backups/x.json',
      receipt_id: 'rcpt_mfk3n1a2b3c4-7',
      search: 'sh_mfk3n1_a2b3c4d5',
      tmp: '/store/.spotify-mcp/freshness.json.4242.00112233445566ff.tmp',
    });
    const masked = maskValues(line);
    assert.ok(masked.includes('<SANDBOX>'), 'the sandbox path must be masked');
    assert.ok(masked.includes('rcpt_<BOOT>-7'), 'the receipt boot id must be masked and the sequence number kept');
    assert.ok(masked.includes('sh_<ID>'), 'the search-history id must be masked — it is NOT a receipt id');
    assert.ok(masked.includes('.<PID>.<RAND>.tmp'), 'a temp-file suffix must be masked');
    assert.ok(!masked.includes('spotify-mcp-wire-'), 'no sandbox path may survive');
    assert.ok(!masked.includes('a2b3c4d5'), 'no search-history hex may survive');
  });

  it('leaves the pre-#587 bare receipt counter alone', () => {
    // `rcpt_1` is a real id shape (src/receipts.ts:534 keeps reading the
    // pre-#587 store). A mask greedy enough to catch it would also mask the
    // sequence number out of a modern id, which is the half that must survive.
    assert.equal(maskValues('rcpt_1'), 'rcpt_1');
    assert.equal(maskValues('rcpt_9-12'), 'rcpt_<BOOT>-12');
  });

  it('leaves an ordinary value alone', () => {
    // A mask that fires on ordinary output is a mask that hides real changes.
    assert.equal(maskValues('Added spotify:track:4uLU6hMCjMI75M1A2tKUQC to queue.'), 'Added spotify:track:4uLU6hMCjMI75M1A2tKUQC to queue.');
  });

  it('declares every mask as a documented pattern/replacement pair', () => {
    for (const [pattern, replacement] of VALUE_MASKS) {
      assert.ok(pattern instanceof RegExp, 'a mask must be a RegExp');
      assert.equal(typeof replacement, 'string');
    }
    assert.ok(VALUE_MASKS.length >= 4, 'the four per-run sources the issue names are all present');
  });
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

describe('the comparison reports each way two snapshots can differ', () => {
  const base = [
    { tool: 'alpha', callCase: 'empty', args: {}, result: { content: [{ type: 'text', text: 'one' }] } },
    { tool: 'beta', callCase: 'required', args: { id: 'x' }, result: { content: [{ type: 'text', text: 'two' }] } },
    { tool: 'gamma', callCase: 'json', args: {}, result: { content: [{ type: 'text', text: 'three' }] } },
  ]
    .map(serializeRecord)
    .join('\n');
  const baseText = `${base}\n`;

  it('reports no differences for two identical snapshots', () => {
    const diff = compareSnapshots(baseText, baseText);
    assert.deepEqual(diff.changed, []);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.reordered, false);
    assert.equal(digest(baseText), digest(baseText));
    assert.match(formatDiff(diff), /no differences/);
  });

  it('CHANGED names the tool and the case whose bytes moved', () => {
    const head = [
      { tool: 'alpha', callCase: 'empty', args: {}, result: { content: [{ type: 'text', text: 'ONE' }] } },
      { tool: 'beta', callCase: 'required', args: { id: 'x' }, result: { content: [{ type: 'text', text: 'two' }] } },
      { tool: 'gamma', callCase: 'json', args: {}, result: { content: [{ type: 'text', text: 'three' }] } },
    ]
      .map(serializeRecord)
      .join('\n');
    const diff = compareSnapshots(baseText, `${head}\n`);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]!.tool, 'alpha');
    assert.equal(diff.changed[0]!.callCase, 'empty');
    assert.ok(diff.changed[0]!.before.includes('one'));
    assert.ok(diff.changed[0]!.after.includes('ONE'));
    // The report a reviewer reads names the invocation, not a line number.
    assert.match(formatDiff(diff), /CHANGED {2}alpha \[empty\]/);
  });

  it('ADDED and REMOVED are reported, not silently absorbed', () => {
    const short = `${baseText.trimEnd().split('\n')[0]}\n`;

    const added = compareSnapshots(short, baseText);
    assert.equal(added.added.length, 2);
    assert.deepEqual(added.added.map((entry) => entry.tool).sort(), ['beta', 'gamma']);
    assert.equal(added.removed.length, 0);
    assert.match(formatDiff(added), /ADDED {4}beta \[required\]/);

    const removed = compareSnapshots(baseText, short);
    assert.equal(removed.removed.length, 2);
    assert.equal(removed.added.length, 0);
    assert.match(formatDiff(removed), /REMOVED {2}beta \[required\]/);
  });

  it('REORDERED is its own verdict: the same bytes in a different order still differ', () => {
    // `tools/list` order is registration order and a host can render from it,
    // so this is a real difference rather than cosmetics.
    const lines = baseText.trimEnd().split('\n');
    const diff = compareSnapshots(baseText, `${[lines[2], lines[0], lines[1]].join('\n')}\n`);
    assert.equal(diff.reordered, true);
    assert.equal(diff.changed.length, 0, 'reordering is not a content change');
    assert.match(formatDiff(diff), /REORDERED/);
  });

  it('shows a changed line AROUND the difference, not a prefix of it', () => {
    // The case that forced this. The `<tools/list>` record is the whole schema
    // surface in one line — 579 KB on the current tree — so a one-word
    // description edit lands hundreds of kilobytes in. Clipping both sides to
    // a fixed prefix printed two identical-looking lines and named a
    // difference without showing it.
    const line = (tail: string) =>
      serializeRecord({ tool: 'wide', callCase: 'empty', args: {}, result: { blob: 'x'.repeat(5000), tail } });
    const diff = compareSnapshots(`${line('old')}\n`, `${line('new')}\n`);

    // Assert the premise first: the difference is far outside any prefix clip.
    // Without this the assertions below would pass just as well on the old,
    // broken formatter.
    assert.ok(line('old').indexOf('old') > 4000, 'the difference must sit past the window\'s reach');

    const report = formatDiff(diff);
    assert.match(report, /first difference at char \d+/);
    const rendered = report
      .split('\n')
      .filter((l) => l.startsWith('  - ') || l.startsWith('  + '))
      .map((l) => l.slice(4));
    assert.equal(rendered.length, 2);
    assert.notEqual(rendered[0], rendered[1], 'the report showed two identical sides for a real difference');
    assert.ok(rendered[0]!.includes('old'), 'the "-" side must show the old text');
    assert.ok(rendered[1]!.includes('new'), 'the "+" side must show the new text');
    assert.ok(rendered[0]!.includes('chars in'), 'the window must be marked as a clip');
  });

  it('keeps a prefix clip for ADDED, which has no "first difference"', () => {
    const entry = { tool: 'new', callCase: 'empty', after: serializeRecord({ tool: 'new', callCase: 'empty', args: {}, result: { note: 'hello' } }) };
    const report = formatDiff({ changed: [], added: [entry], removed: [], reordered: false, counts: {} as never }, 20);
    assert.match(report, /ADDED {4}new \[empty\]/);
    assert.ok(report.includes('chars)'), 'a long ADDED line is still clipped');
    assert.ok(!report.includes('first difference'), 'ADDED must not claim an offset');
  });

  it('refuses a corrupt snapshot rather than reading it as a missing tool', () => {
    // A snapshot whose line 4 is corrupt would otherwise compare as "that tool
    // is absent from one side" — a finding about the file, reported as a
    // finding about the code.
    assert.throws(() => parseSnapshot('{"tool":"a"}\nnot json\n'), /snapshot line 2 is not JSON/);
  });

  it('is stable on an empty snapshot and round-trips through parse/serialize', () => {
    assert.equal(compareSnapshots('', '').counts.head, 0);
    const parsed = parseSnapshot(baseText);
    assert.deepEqual(parsed.map(serializeRecord), baseText.trimEnd().split('\n'));
  });
});

// ---------------------------------------------------------------------------
// Structural — the import-order invariant, which nothing else can see
// ---------------------------------------------------------------------------

describe('the harness cannot reach the real home through import order', () => {
  /**
   * Static server imports, which ES module hoisting would evaluate BEFORE the
   * `HOME` redirect in the module body.
   */
  function staticServerImports(source: string): string[] {
    const offenders: string[] = [];
    // Both static forms: `import x from '…'` and the bare side-effect
    // `import '…'`. The bare form is the dangerous one — it binds nothing and
    // does nothing except RUN THE MODULE, which is precisely the write this
    // issue is about — so a regex that only matched the `from` form would pass
    // the one line that matters most. A DYNAMIC `await import('…')` is the
    // whole point of the file's shape and is deliberately not matched.
    for (const match of source.matchAll(/^\s*import\s+(?:[^;'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]!;
      if (specifier.startsWith('../src/') || specifier.startsWith('../dist/') || specifier.startsWith('/src/')) {
        offenders.push(specifier);
      }
    }
    return offenders;
  }

  it('has no static server import, and the check is shown to fire on one', () => {
    const source = readFileSync(HARNESS, 'utf8');
    assert.deepEqual(
      staticServerImports(source),
      [],
      'a static import of server code runs the server\'s store writes before the HOME redirect — that is the #1477 defect',
    );
    // Anti-vacuity: the same function, driven on a synthetic copy with exactly
    // the line it must reject. A check that cannot go red is a comment.
    const broken = source.replace(
      "import { isInside, sandboxStorePins } from './hermetic-home.mjs';",
      "import { isInside, sandboxStorePins } from './hermetic-home.mjs';\nimport '../src/config.js';",
    );
    assert.deepEqual(staticServerImports(broken), ['../src/config.js']);
  });

  it('redirects HOME and pins every store before the first server import', () => {
    // Ordering as a source property, because ordering is the defect: the
    // redirect has to appear before the first DYNAMIC server import too.
    const source = readFileSync(HARNESS, 'utf8');
    const redirect = source.indexOf('process.env.HOME = home;');
    const firstServerImport = source.search(/await import\('\.\.\/src\//);
    assert.ok(redirect > 0, 'the HOME redirect must exist');
    assert.ok(firstServerImport > 0, 'the harness must import server code dynamically');
    assert.ok(redirect < firstServerImport, `HOME is redirected at ${redirect} but server code is imported at ${firstServerImport}`);
  });

  it('binds no port: the transport is in-process', () => {
    // A harness that opened a socket would need a port, and a fixed one would
    // collide with a developer's own server on 8888.
    const source = readFileSync(HARNESS, 'utf8');
    assert.ok(source.includes('InMemoryTransport'), 'the client must be connected over InMemoryTransport');
    assert.ok(!/listen\(|createServer\(/.test(source), 'the harness must not open a listening socket');
  });
});

// ---------------------------------------------------------------------------
// Behavioural — the real script, run as a process
// ---------------------------------------------------------------------------

describe('the committed harness is reproducible and sandboxed', () => {
  it('produces byte-identical snapshots on two consecutive runs', () => {
    // The issue's central complaint: an md5 a reviewer could not reproduce.
    // Two real runs of the real script, compared byte for byte.
    const dir = scratch('wire-equiv-determinism-');
    const first = join(dir, 'a.jsonl');
    const second = join(dir, 'b.jsonl');

    const runOne = runHarness(['--out', first]);
    assert.equal(runOne.status, 0, `first run failed: ${runOne.stderr}`);
    const runTwo = runHarness(['--out', second]);
    assert.equal(runTwo.status, 0, `second run failed: ${runTwo.stderr}`);

    const a = readFileSync(first, 'utf8');
    const b = readFileSync(second, 'utf8');
    assert.equal(digest(a), digest(b), 'the digest differed between two runs of an unchanged tree');
    assert.equal(a, b, 'the two snapshots are not byte-identical');
    // And a snapshot must not be empty — a harness that recorded nothing would
    // be byte-identical to itself forever.
    assert.ok(a.trimEnd().split('\n').length > 500, `only ${a.trimEnd().split('\n').length} invocations were recorded`);
  });

  it('--compare exits 0 on identical snapshots and names a difference when one exists', () => {
    const dir = scratch('wire-equiv-compare-');
    const base = join(dir, 'base.jsonl');
    const run = runHarness(['--out', base]);
    assert.equal(run.status, 0, `capture failed: ${run.stderr}`);

    const same = runHarness(['--compare', base, base]);
    assert.equal(same.status, 0, 'comparing a snapshot with itself must succeed');
    assert.match(same.stdout, /no differences/);

    // Now the anti-vacuity half: perturb the CAPTURED artifact, not the source.
    // A comparison that cannot detect a real byte difference is the failure
    // this whole issue is about, so it is demonstrated rather than assumed.
    const head = join(dir, 'head.jsonl');
    const lines = readFileSync(base, 'utf8').trimEnd().split('\n');
    const target = lines.findIndex((line) => line.includes('"tool":"add_to_queue"') && line.includes('"required"'));
    assert.ok(target >= 0, 'expected a captured add_to_queue/required invocation to perturb');
    lines[target] = lines[target]!.replace('to queue.', 'to the queue.');
    writeFileSync(head, `${lines.join('\n')}\n`);

    const differs = runHarness(['--compare', base, head]);
    assert.equal(differs.status, 1, 'a changed byte must make --compare exit non-zero');
    assert.match(differs.stdout, /CHANGED {2}add_to_queue \[required\]/);
    assert.notEqual(digest(readFileSync(base, 'utf8')), digest(readFileSync(head, 'utf8')));
  });

  it('writes nothing into a HOME it was handed, and puts its sandbox elsewhere', () => {
    // The #1477 defect, observed rather than assumed. The fixture is a
    // stand-in for "the developer's real home" — a fresh mkdtemp — so this
    // asserts the behaviour without any test pointing at an actual one.
    const dir = scratch('wire-equiv-home-');
    const fixtureHome = join(dir, 'fixture-home');
    const out = join(dir, 'snapshot.jsonl');
    mkdirSync(fixtureHome, { recursive: true });

    const run = runHarness(['--out', out], { HOME: fixtureHome, USERPROFILE: fixtureHome });
    assert.equal(run.status, 0, `capture failed: ${run.stderr}`);

    // The negative leg, which is what makes the positive leg mean anything:
    // the fixture is checked for ANY entry, so a write is caught even one
    // whose name nobody thought to look for.
    const leaked = readdirSync(fixtureHome);
    assert.deepEqual(leaked, [], `the harness wrote into the HOME it was handed: ${leaked.join(', ')}`);
    assert.ok(!existsSync(join(fixtureHome, '.spotify-mcp')), 'a .spotify-mcp directory appeared in the handed-over home');

    // The positive leg: the harness DID build a sandbox of its own, somewhere
    // else, and the snapshot names that path (masked) rather than the fixture.
    const text = readFileSync(out, 'utf8');
    assert.ok(text.includes('<SANDBOX>'), 'the snapshot should show a masked sandbox path, so stores were used');
    assert.ok(!text.includes(fixtureHome), 'the snapshot must not name the handed-over home');
  });

  it('fails CLOSED on a missing snapshot, and never reports "no differences"', () => {
    // The hazard: a comparison that did not run and a comparison that agreed
    // are the same exit code if the first is allowed to pass. A mistyped path
    // has to be loud and non-zero, and it must not print the green line.
    const dir = scratch('wire-equiv-missing-');
    const absent = join(dir, 'never-written.jsonl');
    const run = runHarness(['--compare', absent, absent]);
    assert.equal(run.status, 2, 'a missing snapshot must not be a success');
    assert.doesNotMatch(run.stdout, /no differences/);
    assert.match(run.stderr, /no snapshot at/);
    assert.ok(run.stderr.includes(absent), 'the error must name the file that is missing');
    assert.ok(!existsSync(absent), 'the harness must not create the file it was asked for');
  });

  it('refuses an unknown flag instead of silently ignoring it', () => {
    // A mistyped `--ouy` that quietly wrote to stdout would leave a reviewer
    // believing they had a file on disk.
    const run = runHarness(['--ouy', '/tmp/nope.jsonl']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown option --ouy/);
  });
});
