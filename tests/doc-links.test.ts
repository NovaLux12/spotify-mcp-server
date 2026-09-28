/**
 * Documentation link guard (#931).
 *
 * Issue #931 reported three cross-document defects at once: two `docs/` pages
 * the README index never named, a 403 error message pointing at a README
 * section that did not exist, and SPEC.md claiming an availability the README's
 * gated table contradicted. By the time this guard was written the first two
 * were already fixed, which is exactly why the class needed a gate rather than
 * another fix — nothing in the tree could tell the difference between "correct"
 * and "correct again".
 *
 * **The measured reason this file exists.** With `graceful403Message()` in
 * `src/gating.ts` pointed at a nonexistent `README.md#removed-endpoints`:
 *
 * | Gate | Verdict |
 * |---|---|
 * | `npm run count:tools -- --check` | exit 0 — passed |
 * | `npm run check:doc-tool-names` | exit 0 — passed |
 * | `node scripts/check-no-explicit-any.mjs` | exit 0 — passed |
 * | `scripts/check-doc-links.mjs` | exit 1 — caught it |
 *
 * `checkGatedEndpointTruth()` in the census requires README to *have* a
 * "Registration-gated endpoints" heading. It never checked that the message
 * pointed at it, so the two strings could drift apart freely — and the drift is
 * invisible to a reader until they have already hit a 403 and are looking for
 * the section that is not there.
 *
 * The anti-vacuity half matters as much as the classifier: a guard that has
 * never rejected anything is decoration (AGENTS.md §6). So every rule below is
 * driven over a planted fixture, and one test pins the wiring — that
 * `checkDocumentation`-equivalent entry point really reaches the collector, so a
 * correct classifier that is never called cannot pass for a working gate.
 *
 * Run: node --import tsx --test tests/doc-links.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { anchorSlug, anchorsOf, findBrokenLinks, gatedMessageErrors } from '../scripts/check-doc-links.mjs';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Scratch trees live under `os.tmpdir()`: the runner executes files in parallel. */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spotify-mcp-doclinks-'));
}

type Run = { status: number; output: string };

/**
 * Run the guard. Returns its status instead of throwing, so both verdicts assert.
 *
 * `execFileSync` hands back stdout, and this gate writes its findings to stderr,
 * so the success line is read with `spawnSync` instead. An earlier version
 * captured the return value and the count assertion read an empty string --
 * which is how a coverage check passes by asserting nothing.
 */
function runGuard(args: string[] = []): Run {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', 'scripts/check-doc-links.mjs', ...args],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return { status: result.status ?? 1, output: result.stderr ?? '' };
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
  label: 'tests/doc-links.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

describe('documentation link guard (#931)', () => {
  it('ships documentation whose relative links and heading targets all resolve', () => {
    const run = runGuard();
    assert.equal(
      run.status,
      0,
      `Documentation links do not resolve. A link a reader cannot follow is worse than none, because a reader trusts it and does not check:\n${run.output}`,
    );
  });

  it('scans a non-trivial number of documents, so green is not an empty set', () => {
    // The failure this guards against is a collector that finds nothing and
    // reports success over an empty set — indistinguishable, from the outside,
    // from a tree with no broken links (AGENTS.md §6).
    const run = runGuard();
    const scanned = /doc links: (\d+) documents/.exec(run.output);
    assert.ok(scanned, `expected a scanned-document count on the success line, got: ${run.output}`);
    assert.ok(Number(scanned[1]) >= 10, `expected at least 10 documents scanned, got ${scanned[1]}`);
  });
});

describe('relative link resolution', () => {
  it('reports a link to a file that does not exist', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'README.md'), '- [gone](docs/absent.md)\n');
    const broken = findBrokenLinks(
      '- [gone](docs/absent.md)\n',
      'README.md',
      dir,
      dir,
    );
    assert.match(broken.join('\n'), /docs\/absent\.md.*no such file/);
  });

  it('reports an anchor that is not a heading in the file it points at', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'real.md'), '## Present heading\n');
    const source = '- [wrong](docs/real.md#absent-heading)\n';
    const broken = findBrokenLinks(source, 'README.md', dir, dir);
    assert.match(broken.join('\n'), /absent-heading.*no such heading/);
  });

  it('reports a bare fragment that is not a heading in the containing document', () => {
    const source = '# Title\n\n- [self](#no-such-heading)\n';
    const broken = findBrokenLinks(source, 'README.md', process.cwd(), process.cwd());
    assert.match(broken.join('\n'), /no-such-heading.*no such heading in this document/);
  });

  it('accepts links that do resolve, including anchors GitHub derives', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'docs'));
    // One heading per shape the tree actually uses: punctuation, an inline code
    // span, and an explicit `<a id>`. All three are real headings in this repo,
    // so a slug rule that mishandled any of them would be a false RED.
    await writeFile(
      join(dir, 'docs', 'real.md'),
      [
        '## A heading & with punctuation',
        '## Disconnecting: `spotify-mcp logout`',
        '<a id="hand-written"></a>',
        '',
      ].join('\n'),
    );
    const source = [
      '- [punct](docs/real.md#a-heading--with-punctuation)',
      '- [code](docs/real.md#disconnecting-spotify-mcp-logout)',
      '- [explicit](docs/real.md#hand-written)',
      '- [remote](https://example.com/x)',
      '- [mail](mailto:a@b.c)',
      '',
    ].join('\n');
    assert.deepEqual(findBrokenLinks(source, 'README.md', dir, dir), []);
  });

  it('unwraps an angle-bracket destination, which is how a spaced path is written', async () => {
    // GitHub accepts `<path with spaces.md>` as a link destination. Capturing the
    // brackets as part of the path reported a file that exists as missing — a
    // false RED, which is how a gate gets ignored.
    const dir = await scratch();
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'real.md'), '## Present\n');
    const source = '- [ok](<docs/real.md>)\n- [gone](<docs/absent.md>)\n';
    const broken = findBrokenLinks(source, 'README.md', dir, dir);
    assert.equal(broken.length, 1, `expected only the absent file to be reported, got: ${broken.join('; ')}`);
    assert.match(broken[0], /absent\.md/);
  });

  it('goes red on a planted broken link and green once it is restored', async () => {
    // The mutation discipline: a link checker that has never rejected anything
    // is decoration. Both directions are driven, so "it passed" means the
    // fixture was clean and not that the collector was silent.
    const dir = await scratch();
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'real.md'), '## Present\n');
    const good = '- [ok](docs/real.md#present)\n';
    const bad = '- [ok](docs/real.md#present)\n- [broken](docs/real.md#missing)\n';

    await writeFile(join(dir, 'README.md'), good);
    assert.equal(runGuard(['--check-fixture', dir]).status, 0, 'a clean fixture must pass');

    await writeFile(join(dir, 'README.md'), bad);
    const failure = runGuard(['--check-fixture', dir]);
    assert.equal(failure.status, 1, 'a planted broken link must fail the gate');
    assert.match(failure.output, /missing/);

    await writeFile(join(dir, 'README.md'), good);
    assert.equal(runGuard(['--check-fixture', dir]).status, 0, 'restoring the link must go green again');
  });
});

describe('heading anchors', () => {
  it('derives the same anchor GitHub does for a real SPEC.md heading', () => {
    // Pinned against a live anchor rather than against this file's own output:
    // SPEC.md's own table of contents spells it `#1-goals--non-goals`, with two
    // hyphens, which is what makes the per-space rule load-bearing.
    assert.equal(anchorSlug('1. Goals & Non-Goals'), '1-goals--non-goals');
  });

  it('drops inline code from the anchor, because GitHub renders it as markup', () => {
    assert.equal(anchorSlug('Disconnecting: `spotify-mcp logout`'), 'disconnecting-spotify-mcp-logout');
  });

  it('collects explicit anchors as well as headings', () => {
    const anchors = anchorsOf('## One\n\n<a id="two"></a>\n');
    assert.ok(anchors.has('one'));
    assert.ok(anchors.has('two'));
  });
});

describe('the 403 message points at a section that exists', () => {
  /** The real README, and the real message the server renders on a gated 403. */
  async function realInputs(): Promise<{ rendered: string; readme: string }> {
    const [{ graceful403Message }, { SpotifyApiError }] = await Promise.all([
      import('../src/gating.js'),
      import('../src/client.js'),
    ]);
    return {
      rendered: graceful403Message('/markets', new SpotifyApiError(403, 'Forbidden')),
      readme: readFileSync(join(ROOT, 'README.md'), 'utf8'),
    };
  }

  it('accepts the shipped message, which names a heading README has', async () => {
    const { rendered, readme } = await realInputs();
    assert.deepEqual(gatedMessageErrors(rendered, readme), []);
  });

  it('rejects a message pointed at a section README does not have', async () => {
    // The regression, driven through the function the gate itself calls. This
    // is the test that makes the guard bite: an earlier version only ever
    // exercised the shipped message, so neutering the check to `return []` left
    // the whole file green.
    const { readme } = await realInputs();
    const drifted = 'Spotify returned 403 for /markets. see README "Removed endpoints" (README.md#removed-endpoints) for the full list.';
    const errors = gatedMessageErrors(drifted, readme);
    assert.ok(errors.length > 0, 'a message pointing at a nonexistent section must be rejected');
    assert.match(errors.join('\n'), /removed-endpoints.*not a heading/);
  });

  it('rejects a message that names the section in prose but points elsewhere', () => {
    // The two halves of the message are independent strings, so each can drift
    // on its own. Checking only the anchor would pass this.
    const readme = '## Registration-gated endpoints\n';
    const halfDrifted = 'see README "Registration-gated endpoints" (README.md#somewhere-else) for the full list.';
    assert.match(gatedMessageErrors(halfDrifted, readme).join('\n'), /somewhere-else/);
  });

  it('rejects a message that cites no anchor at all', () => {
    // A reader who hits a 403 and is told to "see the README" with nowhere to
    // go is the failure this whole guard exists to prevent.
    const errors = gatedMessageErrors('see the README for the full list.', '## Registration-gated endpoints\n');
    assert.match(errors.join('\n'), /no longer names a README anchor/);
  });

  it('rejects a README that no longer carries the heading the message names', async () => {
    // The other direction: the section was renamed in README and the message
    // still points at the old name. `checkGatedEndpointTruth()` in the census
    // requires the heading to exist, so this is the pair that keeps the two
    // documents from drifting apart.
    const { rendered } = await realInputs();
    const errors = gatedMessageErrors(rendered, '# SpotifyMCP\n\n## Requirements\n');
    assert.ok(errors.length > 0, 'a README without the named heading must be rejected');
  });

  it('reads the contract from src/gating.ts, which owns the message', () => {
    // `src/tools/exhaust2_enggating.ts` re-exports the classifier for historical
    // import paths but registers no tools; the 403 message moved to
    // `src/gating.ts` in #791. A guard reading the message from the old module
    // would be reading something that no longer owns it.
    const source = readFileSync(join(ROOT, 'src', 'gating.ts'), 'utf8');
    assert.match(source, /export function graceful403Message/);
    assert.ok(existsSync(join(ROOT, 'scripts', 'check-doc-links.mjs')));
  });
});
