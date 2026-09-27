/**
 * SPOTIFY_MCP_READONLY: one parse, one reader, one disclosure (#611).
 *
 * The flag is the hard read-only guarantee — it hides every write-capable
 * registration module, so an operator who sets it and does not get it is
 * running a write-capable server while believing otherwise. That is why this
 * test exists rather than a test that merely covers a line.
 *
 * ## What the bug actually was, by the time this was written
 *
 * The issue body describes an inline `['1','true','yes']` list with no trim in
 * `src/index.ts`, so `SPOTIFY_MCP_READONLY=on` was silently ignored. The code
 * had already moved: the gate is `readOnlyModeEnabled()` in
 * `src/tools/annotations.ts` and it was ALREADY calling `config.truthyEnv`, so
 * that particular impact was gone. What survived was the part that matters
 * more, and is what this test pins:
 *
 *  - `SPOTIFY_MCP_READONLY` was in no config field, so it reached no
 *    validation or diagnostic path;
 *  - the CLI `doctor` — the artefact the project tells users to paste when
 *    reporting a problem — printed everything except the one flag that
 *    explains a missing tool surface;
 *  - `src/auth.ts` held a SECOND copy of the truthy table, so `on` could mean
 *    one thing to auth and another to the gate;
 *  - a value naming no boolean (`enabled`, `readonly`, `y`) read as OFF with
 *    no output at all.
 *
 * ## The property under test
 *
 * Not "truthyEnv returns true for `on`" — that is a fact about a list. The
 * property is that ONE function decides, and everything that reports or gates
 * on the flag routes through it, so a second copy cannot creep back in. The
 * last test in this file is the one that would catch that: it reads the source
 * and fails if any module other than config.ts can reach the variable.
 */

import './helpers/hermetic.js';

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  parseReadOnly,
  readOnlyEnv,
  falsyEnv,
  unrecognisedBooleanEnv,
  TRUTHY_ENV_VALUES,
} from '../src/config.ts';
import { readOnlyModeEnabled } from '../src/tools/annotations.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every spelling the shared rule accepts, plus the spellings it must reject. */
const TRUTHY_CASES = ['1', 'true', 'yes', 'on', 'ON', 'On', 'TRUE', ' yes ', '\ttrue\n'] as const;
const FALSY_CASES = ['0', 'false', 'no', 'off', 'OFF', ' 0 ', 'no', 'Off'] as const;
/** Set, non-empty, and neither table — a typo, which must warn and read OFF. */
const TYPO_CASES = ['maybe', 'enabled', 'readonly', 'y', '2', 't', 'truthy', 'onn'] as const;

describe('SPOTIFY_MCP_READONLY parsing (#611)', () => {
  it('reads every accepted spelling as true, through loadConfig', () => {
    for (const raw of TRUTHY_CASES) {
      assert.equal(
        loadConfig({ SPOTIFY_MCP_READONLY: raw }).readonly,
        true,
        `SPOTIFY_MCP_READONLY=${JSON.stringify(raw)} must enable read-only mode`,
      );
    }
  });

  it('reads every explicit falsy spelling as false, through loadConfig', () => {
    for (const raw of FALSY_CASES) {
      assert.equal(
        loadConfig({ SPOTIFY_MCP_READONLY: raw }).readonly,
        false,
        `SPOTIFY_MCP_READONLY=${JSON.stringify(raw)} must NOT enable read-only mode`,
      );
    }
  });

  it('reads an unset or empty value as false without warning', () => {
    const warnings: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]): void => { warnings.push(args.join(' ')); };
    try {
      assert.equal(loadConfig({}).readonly, false);
      assert.equal(loadConfig({ SPOTIFY_MCP_READONLY: '' }).readonly, false);
      assert.equal(loadConfig({ SPOTIFY_MCP_READONLY: '   ' }).readonly, false);
    } finally {
      console.error = real;
    }
    assert.deepEqual(
      warnings,
      [],
      'an operator who did not set the flag must not be warned about it on every start',
    );
  });

  it('treats a typo as OFF but says so, naming the accepted values', () => {
    // The warning is the whole point of the typo branch: silently downgrading a
    // safety switch to off is the failure this exists to prevent, and an
    // operator who wrote `enabled` needs to learn that no boolean was read.
    for (const raw of TYPO_CASES) {
      const warnings: string[] = [];
      const real = console.error;
      console.error = (...args: unknown[]): void => { warnings.push(args.join(' ')); };
      let parsed: boolean;
      try {
        parsed = loadConfig({ SPOTIFY_MCP_READONLY: raw }).readonly;
      } finally {
        console.error = real;
      }
      assert.equal(parsed, false, `SPOTIFY_MCP_READONLY=${JSON.stringify(raw)} must not read as true`);
      assert.equal(
        warnings.length,
        1,
        `SPOTIFY_MCP_READONLY=${JSON.stringify(raw)} produced ${warnings.length} warnings, expected exactly 1`,
      );
      assert.match(warnings[0]!, /SPOTIFY_MCP_READONLY/);
      assert.match(warnings[0]!, new RegExp(raw), 'the warning must name the value it rejected');
      for (const accepted of TRUTHY_ENV_VALUES) {
        assert.ok(
          warnings[0]!.includes(accepted),
          `the warning must name ${accepted} as an accepted spelling`,
        );
      }
    }
  });

  it('does not fail startup on a typo — a read-only host stays up', () => {
    // Deliberately NOT an error. Refusing to start would take a working server
    // offline over a cosmetic mistake; the wrong outcome to choose for a
    // safety flag is silent-off, which the warning above addresses.
    const real = console.error;
    console.error = (): void => {};
    try {
      assert.doesNotThrow(() => parseReadOnly('enabled'));
    } finally {
      console.error = real;
    }
  });
});

describe('the truthy/falsy tables are one shared vocabulary', () => {
  it('treats a spelling as falsy exactly when it is not truthy', () => {
    // `falsyEnv` backs the opt-OUT flags (search history). It must be the
    // complement in the sense that matters: no value may be in both tables,
    // or an opt-in flag and an opt-out flag would disagree on it.
    for (const raw of [...TRUTHY_CASES, ...FALSY_CASES, ...TYPO_CASES]) {
      assert.ok(
        !(TRUTHY_ENV_VALUES.includes(raw.trim().toLowerCase()) && falsyEnv(raw)),
        `${JSON.stringify(raw)} is in both tables`,
      );
    }
  });

  it('keeps "off" and "0" from inverting a safety switch', () => {
    // The failure this guards is a reader grabbing the wrong table:
    // SPOTIFY_MCP_READONLY=off must mean OFF, not "on, because off is in the
    // list somewhere".
    assert.equal(readOnlyEnv({ SPOTIFY_MCP_READONLY: 'off' }), false);
    assert.equal(readOnlyEnv({ SPOTIFY_MCP_READONLY: '0' }), false);
    assert.equal(readOnlyEnv({ SPOTIFY_MCP_READONLY: 'no' }), false);
    assert.equal(readOnlyEnv({ SPOTIFY_MCP_READONLY: 'false' }), false);
  });

  it('separates a typo from a deliberate choice', () => {
    for (const raw of TYPO_CASES) {
      assert.equal(unrecognisedBooleanEnv(raw), true, `${raw} should be unrecognised`);
    }
    for (const raw of [...TRUTHY_CASES, ...FALSY_CASES]) {
      assert.equal(unrecognisedBooleanEnv(raw), false, `${raw} should be recognised`);
    }
    for (const raw of [undefined, '', '   ']) {
      assert.equal(unrecognisedBooleanEnv(raw), false, 'unset is an answer, not a typo');
    }
  });
});

describe('the gate and the disclosure cannot disagree', () => {
  const saved = process.env.SPOTIFY_MCP_READONLY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SPOTIFY_MCP_READONLY;
    else process.env.SPOTIFY_MCP_READONLY = saved;
  });

  it('reports the same value the registration gate acted on', () => {
    // The CLI doctor prints `readOnlyModeEnabled()`, not a config field, so the
    // row states what registration actually did. This test is what keeps that
    // true: it drives BOTH across the whole table and requires one answer.
    for (const raw of [...TRUTHY_CASES, ...FALSY_CASES]) {
      process.env.SPOTIFY_MCP_READONLY = raw;
      const gate = readOnlyModeEnabled();
      assert.equal(
        gate,
        readOnlyEnv(),
        `the gate and its own reader disagreed on ${JSON.stringify(raw)}`,
      );
      assert.equal(
        loadConfig({ SPOTIFY_MCP_READONLY: raw }).readonly,
        gate,
        `the snapshot and the gate disagreed on ${JSON.stringify(raw)} — doctor reports the gate, `
          + 'so a drift here means a future reader could report a flag the registry ignored',
      );
    }
  });

  it('reacts to a mid-session change rather than a startup snapshot', () => {
    // `readOnlyModeEnabled` is consulted at registration AND on every
    // write-capable call, and spotify_doctor builds a registry in-process to
    // report a surface. A snapshot bound at startup would answer about a
    // different moment than the gate that actually ran.
    process.env.SPOTIFY_MCP_READONLY = '0';
    assert.equal(readOnlyModeEnabled(), false);
    process.env.SPOTIFY_MCP_READONLY = '1';
    assert.equal(readOnlyModeEnabled(), true);
  });
});

describe('the CLI doctor reports the flag (#611)', () => {
  /**
   * Run `spotify-mcp doctor` and return its stdout.
   *
   * Doctor exits non-zero without a token file, and the live probe fails, but
   * the Configuration block is printed before either — which is the whole
   * point: the report a user pastes when asking for help has to carry the flag
   * even when everything else is broken. Asserting on the process's stdout
   * rather than on a function return is deliberate; a test that called the
   * row-builder directly would still pass with the row deleted from the CLI.
   */
  function runDoctor(env: NodeJS.ProcessEnv): string {
    const home = mkdtempSync(path.join(tmpdir(), 'spotify-mcp-doctor-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/index.ts', 'doctor'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 120_000,
          // An empty HOME means no token file, so no real account is contacted
          // by this test and no machine-local token is read.
          env: { ...process.env, HOME: home, USERPROFILE: home, SPOTIFY_CLIENT_ID: 'test-client-id', ...env },
        },
      );
      assert.equal(result.signal, null, `doctor must exit, not be killed (${result.signal})`);
      return result.stdout;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('prints a readonly row set to yes', () => {
    const out = runDoctor({ SPOTIFY_MCP_READONLY: '1' });
    assert.match(
      out,
      /^\s*readonly\s+yes$/m,
      `doctor did not report readonly yes. Output was:\n${out}`,
    );
  });

  it('prints a readonly row set to no when the flag is off', () => {
    // Asserted for the negative case as well: a row that always said `yes`
    // would satisfy the test above, and an operator would have no way to tell
    // a real read-only session from a broken report.
    const out = runDoctor({ SPOTIFY_MCP_READONLY: '' });
    assert.match(
      out,
      /^\s*readonly\s+no$/m,
      `doctor did not report readonly no. Output was:\n${out}`,
    );
  });

  it('accepts the spellings the shared table accepts, in the real CLI', () => {
    // The in-process tests prove the parse; this proves the REPORT carries it.
    // `on` is the spelling the original inline parser silently ignored.
    for (const raw of ['on', 'ON', ' yes ']) {
      const out = runDoctor({ SPOTIFY_MCP_READONLY: raw });
      assert.match(
        out,
        /^\s*readonly\s+yes$/m,
        `doctor misreported SPOTIFY_MCP_READONLY=${JSON.stringify(raw)} as off. Output was:\n${out}`,
      );
    }
  });

});

describe('the doctor assertions carry the output they assert on (#1334)', () => {
  /**
   * Every `assert.match` over the doctor's stdout in the block above asserts
   * against a value it just captured. When such an assertion fails, the only
   * evidence available is its message, so the message has to carry that value.
   *
   * One of the three omitted it: the message named the flag spelling that was
   * misreported and nothing else, which cannot distinguish a missing row, a
   * wrong row, and truncated stdout. The fix is an interpolation; this test is
   * what stops it being reverted by a well-meaning edit.
   */
  function doctorAssertions(text: string): { found: string[]; missing: string[] } {
    // Anchored on the describe title, not a line number: line numbers move with
    // every edit above, and a check that silently misses is worse than none.
    const anchor = "describe('the CLI doctor reports the flag (#611)'";
    const start = text.indexOf(anchor);
    assert.notEqual(start, -1, 'the doctor describe block must still exist in this file');
    const rest = text.slice(start + anchor.length);
    const end = rest.indexOf('\ndescribe(');
    const block = rest.slice(0, end === -1 ? undefined : end);
    const found = [...block.matchAll(/assert\.match\(\s*out,\s*\/[^\n]*?\/[gimsuy]*\s*,\s*`([^`]*)`/g)]
      .map((m) => m[1]!);
    return { found, missing: found.filter((m) => !/\$\{out\}/.test(m)) };
  }

  it('names the captured output in every doctor failure message', () => {
    const { found, missing } = doctorAssertions(
      readFileSync(path.join(ROOT, 'tests/config-readonly.test.ts'), 'utf8'),
    );
    // Without a floor, a broken extractor yields `missing: []` and this passes
    // for the wrong reason — a scan that found nothing is not a clean scan.
    assert.ok(found.length >= 3, `only ${found.length} doctor assertions found — the extractor is too narrow`);
    assert.deepEqual(
      missing,
      [],
      'every doctor assertion must interpolate the output it asserts on into its message, '
        + 'or a failure leaves no evidence of what was printed. Messages missing it: '
        + missing.join(' | '),
    );
  });

  it('goes red on an assertion that omits the output (the check can fail)', () => {
    // The assertion above is a source scan, so it is worth proving the scan
    // discriminates: same shape as the real block, with one message stripped.
    const doctorAssertion = (message: string) => `describe('the CLI doctor reports the flag (#611)', () => {
      const out = runDoctor({});
      assert.match(
        out,
        /^\\s*readonly\\s+yes$/m,
        \`${message}\`,
      );
    });`;
    const stripped = doctorAssertion('doctor misreported SPOTIFY_MCP_READONLY="ON" as off');
    assert.deepEqual(
      doctorAssertions(stripped).missing,
      ['doctor misreported SPOTIFY_MCP_READONLY="ON" as off'],
      'a message without the output must be reported as missing, or the guard above cannot fail',
    );
    assert.deepEqual(
      doctorAssertions(doctorAssertion('as off. Output was:\\n${out}')).missing,
      [],
      'the same message WITH the output must pass, or the guard rejects the fix too',
    );
  });
});

describe('no second copy of the flag can come back (#611 acceptance)', () => {
  /** src/*.ts, one level of nesting — the tool modules included. */
  function sourceFiles(): { file: string; text: string }[] {
    const out: { file: string; text: string }[] = [];
    for (const entry of readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.push({ file: `src/${entry.name}`, text: readFileSync(path.join(ROOT, 'src', entry.name), 'utf8') });
        continue;
      }
      if (!entry.isDirectory()) continue;
      for (const child of readdirSync(path.join(ROOT, 'src', entry.name), { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith('.ts')) {
          const rel = `src/${entry.name}/${child.name}`;
          out.push({ file: rel, text: readFileSync(path.join(ROOT, rel), 'utf8') });
        }
      }
    }
    return out;
  }

  it('confines every read of the variable to src/config.ts', () => {
    const readers: string[] = [];
    for (const { file, text } of sourceFiles()) {
      // A read is an access through an env object. A mention in prose is not.
      const reads = text.match(/(?:process\.env|env)\.SPOTIFY_MCP_READONLY\b/g) ?? [];
      if (reads.length > 0) readers.push(`${file} (${reads.length})`);
    }
    assert.deepEqual(
      readers,
      ['src/config.ts (2)'],
      'SPOTIFY_MCP_READONLY must be read in exactly one module. Found readers in: '
        + readers.join(', ')
        + '. A second reader is a second answer to "is this session read-only", '
        + 'and the two can differ on any spelling the tables disagree about.',
    );
  });

  it('scans a real surface (a broken glob would make the guard vacuous)', () => {
    // Without this, renaming a directory or emptying the pattern above would
    // make the assertion above pass for the wrong reason: an empty reader list
    // is not `['src/config.ts (2)']`, but a *silently skipped scan* is.
    const files = sourceFiles();
    assert.ok(files.length > 50, `only ${files.length} source files scanned — the walk is too narrow`);
    const configText = files.find((f) => f.file === 'src/config.ts')?.text ?? '';
    assert.match(
      configText,
      /export function readOnlyEnv/,
      'src/config.ts no longer defines readOnlyEnv — the reader list above is stale',
    );
    assert.ok(
      files.some((f) => f.file === 'src/tools/annotations.ts'),
      'the scan no longer reaches src/tools, where the gate lives',
    );
  });
});
