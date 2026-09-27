/**
 * Generated documentation inventory guard (#924, #925, #930).
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Run = { status: number; stdout: string; stderr: string };

/** One subprocess, with its status kept rather than thrown. */
function execRun(argv: string[], env: NodeJS.ProcessEnv = {}): Run {
  try {
    const stdout = execFileSync(process.execPath, argv, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const census = JSON.parse(execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})) as {
  tools: number;
  resources: number;
  resourceTemplates: number;
  prompts: number;
  registrationKeys: number;
  toolModuleFiles: number;
  toolNames: string[];
  manifestToolNames: string[];
  toolInputSchemas: Record<string, { properties?: Record<string, unknown> }>;
  registrationUnits: Array<{ registrar: string; file: string; key: string; ungated: boolean }>;
  registrationKeyNames: string[];
  manifestRegistrationKeys: string[];
  toolsetRegistrationKeys: string[];
  unconditionalRegistrationKeys: string[];
  perModule: Record<string, number>;
  registrySource: string;
};

/**
 * Run `run` against a fresh scratch directory under `os.tmpdir()` (#1383).
 *
 * This used to be `mkdtemp(join(ROOT, '.census-fixture-'))`. The `finally`
 * cleaned up, so the leak only happened on an abnormal exit — but an OOM kill
 * or a SIGKILL at load 60-90 is routine on this box, and the result was an
 * untracked `.census-fixture-*` in the repository root. That is worse than
 * untidy: a clean `git status --porcelain` is this repo's standing assertion
 * that no generated block is stale, so a leaked directory makes a correct change
 * read as a stale one, and every plausible next step — `--write`, a manual
 * block edit — touches the one thing that must never be hand-edited. The
 * census's own marker scan skips dot-entries (#1238), so the census never
 * noticed; only the check whose whole job is to notice a change on disk did.
 *
 * `scratchOutsideRepo` is the assertion that keeps this honest: it runs on
 * every fixture, so moving the directory back under `ROOT` fails here rather
 * than passing silently.
 */
async function withFixtures<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'census-fixture-'));
  // The assertion is inside the `try`, not between the `mkdtemp` and the
  // `try`. Asserting first would throw past the `finally` and leave the
  // directory behind — the guard for the leak would then *be* a leak, which is
  // exactly the shape this issue is about, and it would only show up on the run
  // where the guard had already caught something.
  try {
    assert.ok(
      scratchOutsideRepo(dir),
      `census fixture ${dir} is inside the repository (${relative(ROOT, dir)}); it must live under os.tmpdir() so an abnormal exit cannot leave the working tree dirty (#1383)`,
    );
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Is `path` outside the repository root?
 *
 * `relative` is the test, not a string `startsWith` on the root: a sibling
 * directory that merely shares a name prefix (`/repo-copy`) must count as
 * outside, and a path equal to `ROOT` itself must not. `..` as the first
 * segment is the only way `relative` reports a path above the root it was
 * resolved against, and the empty string means it *is* the root.
 *
 * The `isAbsolute` arm is the Windows cross-drive case, where `relative`
 * cannot relate the two paths and returns the absolute one unchanged.
 */
function scratchOutsideRepo(path: string): boolean {
  const rel = relative(ROOT, path);
  return isAbsolute(rel) || rel.startsWith('..');
}

function runFailure(args: string[], env: NodeJS.ProcessEnv = {}): string {
  const run = execRun(args, env);
  assert.notEqual(run.status, 0, `expected command to fail: ${args.join(' ')}`);
  return `${run.stdout}\n${run.stderr}`;
}

/**
 * A census run with its status kept, because whether it failed is the thing
 * under test in #1436 — `runFailure` cannot be used where the verdict is the
 * assertion.
 */
function runGate(args: string[]): Run {
  return execRun(['scripts/surface-census.mjs', ...args]);
}

/** The label `--no-prose`'s fixture pins, so the assertion can name it exactly. */
const PLANTED_PROSE_LABEL = 'a paragraph no document in this repository contains (#1436 fixture)';

/**
 * The checked-in pin with one impossible entry added (#1436).
 *
 * A *phantom* pin — a paragraph no document contains — rather than a deleted
 * one, so the fixture does not have to remove anything from a document to be
 * out of date. The real pin is copied, never edited: `--prose-sync` writes
 * `scripts/doc-prose-manifest.json`, and a test that pointed the gate at the
 * real file would rewrite a checked-in artifact exactly when the gate is
 * broken.
 */
function driftedProseManifest(): unknown {
  const pin = JSON.parse(readFileSync(join(ROOT, 'scripts', 'doc-prose-manifest.json'), 'utf8')) as {
    files: Record<string, Array<{ hash: string; label: string }>>;
  };
  return {
    ...pin,
    files: {
      ...pin.files,
      // The hash is content-addressed, so a value no document hashes to can
      // only ever be reported as missing — which is what makes this a pin that
      // is out of date by construction rather than by deletion.
      'ARCHITECTURE.md': [...(pin.files['ARCHITECTURE.md'] ?? []), { hash: '1436notacontenthash', label: PLANTED_PROSE_LABEL }],
    },
  };
}

/** The `--check` findings, one per line of the diagnostics block. */
const findings = (run: { stderr: string }): string[] =>
  run.stderr.split('\n').filter((line) => line.startsWith('- '));

/** The three shapes `proseDrift` reports, and nothing else. */
const PROSE_VERDICT = /pinned prose block is no longer|carries hand-written prose|manifest pins prose/;

/** The body between one block's markers, exactly as `inspectGeneratedBlock` slices it. */
function generatedBlockBody(file: string, name: string): string {
  const source = readFileSync(file, 'utf8');
  const start = `<!-- BEGIN:generated ${name} -->`;
  const end = `<!-- END:generated ${name} -->`;
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  assert.ok(startAt >= 0 && endAt > startAt, `${file} has no ${name} block`);
  return source.slice(startAt + start.length, endAt);
}

/** Repository-relative paths that could carry a generated block, skipping build output. */
function walkRepository(directory: string, prefix = ''): string[] {
  const SKIP = new Set(['node_modules', 'dist', '.git', '.tmp']);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) return [];
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walkRepository(join(directory, entry.name), relative) : [relative];
  });
}

describe('generated architecture and specification inventory', () => {
  it('passes the offline documentation drift guard', async () => {
    // `--no-prose` is load-bearing, and the reason is #1436. This test asserts
    // the *architecture* — which modules register, which keys exist, that the
    // generated counts are current. It used to shell out to a bare `--check`,
    // which also reconciles `scripts/doc-prose-manifest.json`: a hand-maintained
    // documentation pin whose job is catching prose lost to a `--theirs`. So a
    // reworded ARCHITECTURE.md reddened a test that reads no documentation, and
    // the reflex on a red you cannot explain is to re-run it or relax it rather
    // than to look. A check's input set should be no wider than the thing it
    // checks.
    //
    // The flag removes nothing this test is here for: every gate in
    // `checkDocumentation()` except the prose reconciliation still runs, and
    // `prose-integrity is severed from this gate` below proves that by showing
    // the difference is *exactly* the prose verdicts. The prose pin keeps its
    // own full `--check` assertion in `tests/doc-prose-integrity.test.ts`, so
    // moving the edge out of this file drops no coverage.
    await withFixtures(async (dir) => {
      const file = join(dir, 'census.json');
      await writeFile(file, JSON.stringify(census));
      execFileSync(process.execPath, ['scripts/surface-census.mjs', '--check', '--no-prose', '--census-file', file], { cwd: ROOT, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
      execFileSync('npm', ['run', 'check:docs-counts', '--', '--no-prose'], { cwd: ROOT, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 });
    });
  });

  it('prose-integrity is severed from this gate (#1436)', async () => {
    // The evidence for the claim in the comment above, and the test that fails
    // if `--no-prose` is ever removed or silently turned into a no-op.
    //
    // It is a *differential*, not an "exits 0" assertion. `--check` is red on
    // this tree for a reason that has nothing to do with either flag — the
    // checked-in prose pin is stale (#1439) — so asserting a clean exit here
    // would be asserting something about the repository's health and nothing
    // about the flag. Instead: run the same command twice over the same
    // deliberately-drifted pin and compare the two error sets. The flag must
    // remove the prose verdicts and nothing else.
    //
    // The pin is drifted in a scratch copy rather than the real manifest,
    // because `--prose-sync` *writes* the checked-in pin — a test that pointed
    // at it would rewrite a repository artifact precisely when the gate is
    // broken, which is the one moment it must not move. Hence `--prose-manifest`.
    await withFixtures(async (dir) => {
      const censusFile = join(dir, 'census.json');
      await writeFile(censusFile, JSON.stringify(census));
      const pinFile = join(dir, 'doc-prose-manifest.json');
      await writeFile(pinFile, JSON.stringify(driftedProseManifest()));

      const withProse = runGate(['--check', '--census-file', censusFile, '--prose-manifest', pinFile]);
      const withoutProse = runGate(['--check', '--no-prose', '--census-file', censusFile, '--prose-manifest', pinFile]);

      // The planted pin is really out of date, and the real gate says so.
      assert.ok(
        withProse.stderr.includes(PLANTED_PROSE_LABEL),
        `precondition: the planted pin was not reported by the real --check:\n${withProse.stderr}`,
      );

      // The comparison is a set difference in both directions rather than an
      // "exits 0" assertion, because a tree can be red for reasons that have
      // nothing to do with either flag — and because a classifier that decides
      // which findings are "prose ones" is a second thing that can be wrong.
      const before = findings(withProse);
      const after = findings(withoutProse);
      const removed = before.filter((line) => !after.includes(line));
      const added = after.filter((line) => !before.includes(line));

      assert.ok(removed.length > 0, 'the flag removed no finding at all, so nothing was severed');
      assert.ok(
        removed.some((line) => line.includes(PLANTED_PROSE_LABEL)),
        `the flag did not remove the planted pin's own verdict; it removed:\n${removed.join('\n')}`,
      );
      // Every removed verdict is a prose one, and every verdict that has
      // nothing to do with prose survives the flag byte for byte. Together
      // these two say the flag's entire effect is to drop the prose
      // reconciliation — not the staleness comparison, not the schema budgets,
      // not the gated-endpoint scan.
      assert.deepEqual(
        removed.filter((line) => !PROSE_VERDICT.test(line)),
        [],
        'the flag removed a verdict that is not about prose',
      );
      assert.deepEqual(added, [], 'the flag changed or added a verdict that has nothing to do with prose');
    });
  });

  it('derives headline counts from the finalized production stdio registry', () => {
    assert.match(census.registrySource, /src\/index\.ts via stdio tools\/list after production finalizers/);
    assert.equal(
      Object.entries(census.perModule).reduce((sum, [file, count]) => sum + (file.startsWith('src/tools/') ? count : 0), 0),
      census.tools,
    );
  });
  it('attributes the finalized registry exactly through the shared registrar manifest', () => {
    assert.deepEqual(census.manifestToolNames, census.toolNames);
  });

  it('exports every production tool input schema', () => {
    assert.equal(Object.keys(census.toolInputSchemas).length, census.tools);
    for (const name of census.toolNames) {
      assert.ok(census.toolInputSchemas[name]?.properties, `${name} is missing tools/list inputSchema.properties`);
    }
  });

  it('derives registration keys from the production registrar manifest, including ungated units', () => {
    const doctor = census.registrationUnits.find(({ registrar }) => registrar === 'registerDoctorTool');
    assert.deepEqual(doctor, {
      registrar: 'registerDoctorTool',
      file: 'src/tools/doctortool.ts',
      key: 'doctor',
      ungated: true,
    });
    // Recomputing the union from the same three census fields would restate the
    // producer and could not fail. Assert the properties instead: every key is
    // covered by at least one source, the list is sorted and duplicate-free, and
    // both ungated modules are present.
    const union = new Set([
      ...census.manifestRegistrationKeys,
      ...census.toolsetRegistrationKeys,
      ...census.unconditionalRegistrationKeys,
    ]);
    assert.equal(census.registrationKeyNames.length, census.registrationKeys);
    assert.equal(new Set(census.registrationKeyNames).size, census.registrationKeys, 'registration keys must be unique');
    assert.deepEqual(census.registrationKeyNames, [...census.registrationKeyNames].sort(), 'registration keys must be sorted');
    // Assert coverage, not the union itself: recomputing it from the same three
    // census fields would restate the producer and could not fail. Every unit
    // the manifest declares must appear in the emitted key list.
    for (const unit of census.registrationUnits) {
      assert.ok(census.registrationKeyNames.includes(unit.key), `manifest unit ${unit.key} missing from registrationKeyNames`);
      if (unit.ungated === true) {
        assert.ok(census.unconditionalRegistrationKeys.includes(unit.key), `${unit.key} is ungated but not listed as unconditional`);
      }
    }
    assert.equal(union.size, census.registrationKeys, 'the three key sources must cover every registration key exactly once');
    assert.ok(census.unconditionalRegistrationKeys.includes('doctor'), 'doctor registers unconditionally');
    assert.ok(census.unconditionalRegistrationKeys.includes('swarm3meta'), 'the toolset report registers unconditionally');

  });

  it('documents the live tools/list, resources, templates, and prompts totals', () => {
    const architecture = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
    for (const claim of [
      `**${census.tools} tools**`,
      `**${census.resources} fixed resources**`,
      `**${census.resourceTemplates} resource templates**`,
      `**${census.prompts} prompts**`,
    ]) {
      assert.ok(architecture.includes(claim), `ARCHITECTURE.md is missing ${claim}`);
      assert.ok(spec.includes(claim), `SPEC.md is missing ${claim}`);
    }
  });

  it('keeps SPEC top-level numbering sequential and its TOC synchronized', () => {
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
    const toc = [...spec.matchAll(/^(\d+)\. \[[^\]]+\]\(#(\d+)-/gm)].map((match) => [Number(match[1]), Number(match[2])]);
    const sections = [...spec.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
    const expected = Array.from({ length: 13 }, (_, index) => index + 1);
    assert.deepEqual(toc, expected.map((ordinal) => [ordinal, ordinal]));
    assert.deepEqual(sections, expected);
  });

  it('checks documented tool names and schemas against the production registry', async () => {
    await withFixtures(async (dir) => {
      const file = join(dir, 'census.json');
      await writeFile(file, JSON.stringify(census));
      execFileSync(process.execPath, ['scripts/check-doc-tool-names.mjs', '--census-file', file], { cwd: ROOT, stdio: 'pipe' });
    });
  });

  it('rejects unknown documented tools and wrong-tool arguments', async () => {
    await withFixtures(async (dir) => {
      const censusFile = join(dir, 'census.json');
      await writeFile(censusFile, JSON.stringify(census));
      const cases = [
        { name: 'unknown tool', source: 'Call not_a_real_tool with `query: "x"`.', expected: /unknown tool/ },
        { name: 'wrong-tool JSON argument', source: '```json\n{"tool":"get_me","playlist_id":"x"}\n```', expected: /not an input parameter of .*get_me/ },
        { name: 'wrong-tool call argument', source: 'Call get_me with `playlist_id: "x"`.', expected: /not an input parameter of .*get_me/ },
      ];
      for (const fixture of cases) {
        const file = join(dir, `${fixture.name.replaceAll(' ', '-')}.md`);
        await writeFile(file, fixture.source);
        assert.match(runFailure(['scripts/check-doc-tool-names.mjs', '--check-fixture', file, '--census-file', censusFile]), fixture.expected);
      }
    });
  });

  it('AGENTS.md §3 names every generated block that exists in the tree (#1231)', () => {
    // The expected side is scanned from the tree, not read back out of the
    // script's `blocks` array, so this cannot pass by restating the code under
    // test. It fails if a block is added with `--write` skipped, and it fails
    // if the rendered list is hand-mangled. It does NOT catch the reverse —
    // a marker pair left in a file with no `blocks` entry is invisible to
    // `--check`, because `--check` only inspects what `blocks` names.
    const listed = new Set<string>();
    for (const line of generatedBlockBody(join(ROOT, 'AGENTS.md'), 'generated-blocks').split('\n')) {
      const [, file, names] = /^-\s+`([^`]+)`:\s*(.+)$/.exec(line) ?? [];
      if (!file) continue;
      for (const name of names.matchAll(/`([^`]+)`/g)) listed.add(`${file}:${name[1]}`);
    }

    const inTree = new Set<string>();
    for (const relative of walkRepository(ROOT)) {
      const source = readFileSync(join(ROOT, relative), 'utf8');
      for (const marker of source.matchAll(/^\/\/ BEGIN:generated ([a-z0-9-]+)$/gm)) inTree.add(`${relative}:${marker[1]}`);
      for (const marker of source.matchAll(/^<!-- BEGIN:generated ([a-z0-9-]+) -->$/gm)) inTree.add(`${relative}:${marker[1]}`);
    }
    // The list is rendered from `blocks` and deliberately omits its own entry.
    inTree.delete('AGENTS.md:generated-blocks');

    assert.ok(listed.size > 0, 'AGENTS.md §3 rendered an empty generated-block list');
    assert.ok(
      listed.has('README.md:gated-endpoints'),
      "AGENTS.md §3 no longer names README.md's gated-endpoints block, the entry #1226 added",
    );
    assert.deepEqual([...listed].sort(), [...inTree].sort());
  });

  it('requires exactly one valid marker pair for every generated block', async () => {
    await withFixtures(async (dir) => {
      const name = 'surface-census';
      const body = 'current';
      const start = '<!-- BEGIN:generated surface-census -->';
      const end = '<!-- END:generated surface-census -->';
      const valid = `${start}\ncurrent\n${end}`;
      const cases = [
        { name: 'missing', source: 'current', expected: /exactly one.*found 0/ },
        { name: 'stale', source: valid.replace('current', 'old'), expected: /stale/ },
        { name: 'duplicate start', source: `${valid}\n${start}`, expected: /found 2/ },
        { name: 'duplicate end', source: `${valid}\n${end}`, expected: /found 2/ },
      ];
      for (const fixture of cases) {
        const file = join(dir, `${fixture.name.replaceAll(' ', '-')}.json`);
        await writeFile(file, JSON.stringify({ source: fixture.source, file: 'README.md', name, body }));
        assert.match(runFailure(['scripts/surface-census.mjs', '--marker-fixture', file]), fixture.expected);
      }
    });
  });
});
