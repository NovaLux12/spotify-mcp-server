/**
 * The quick references cannot drift from the variables the server reads (#621).
 *
 * ## Why this exists
 *
 * `--help` listed five variables and `.env.example` listed six, and NEITHER
 * mentioned the three that decide which account is used, what the user is
 * consented to, or which tools exist: `SPOTIFY_MCP_PROFILE`, `SPOTIFY_SCOPES`
 * and `SPOTIFY_MCP_READONLY`. An operator who filled in the copy-to-.env
 * template — which presents itself as complete — still ran with the default
 * profile, the full 17-scope consent grant, and no read-only notice, with
 * nothing in the output to say so. The variables were documented, but only in
 * `docs/configuration.md`, which a support answer can point at and a user
 * never opens.
 *
 * `tests/env-var-truth.test.ts` already guards the OTHER direction: every
 * variable that is ADVERTISED must be READ. That is the half that produces a
 * dead knob. This file guards the half that produces an UNDISCOVERABLE knob —
 * a variable the server honours that the quick references never name — for the
 * set of variables an operator is meant to be able to find from `--help`.
 *
 * ## The direction, and its deliberate limit
 *
 * The mirror direction (every read variable must be documented) is asserted
 * for `DOCUMENTED_ENV_VARS` — the curated quick-reference set — and NOT for
 * every `SPOTIFY_*` the server reads. The server reads far more than an
 * operator should see in `--help`: sidecar paths, retention windows, budget
 * knobs. Widening the assertion to all of them would force `--help` to become
 * the full reference and stop being a quick reference. The full reference stays
 * `docs/configuration.md`, and every registry entry must appear in it too.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOCUMENTED_ENV_VARS, renderEnvHelp } from '../src/config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** An assignment line in .env.example, commented out or not. */
const ENV_ASSIGNMENT = (name: string): RegExp =>
  new RegExp(`^[ \\t]*#?[ \\t]*${name}[ \\t]*=`, 'm');

describe('--help documents the variables it renders (#621)', () => {
  const help = renderEnvHelp();

  it('names the auth, profile, scope and read-only variables', () => {
    // The issue's acceptance criteria, one variable at a time.
    for (const name of [
      'SPOTIFY_MCP_PROFILE',
      'SPOTIFY_SCOPES',
      'SPOTIFY_MCP_READONLY',
    ]) {
      assert.ok(
        help.includes(name),
        `--help does not mention ${name} — it changes which account, what consent, or which tools`,
      );
    }
  });

  it('documents the auth flags that parseAuthArgs accepts', () => {
    // `auth --profile` and `auth --scopes` are parsed and used, but the usage
    // block did not show them, so the only place they appeared was the full
    // reference. These live in the usage section, not the rendered env block.
    const source = read('src/index.ts');
    assert.match(source, /spotify-mcp auth \[--profile <name>\]/);
    assert.match(source, /\[--scopes <list>\]/);
  });

  it('states the value each variable defaults to rather than leaving it implied', () => {
    // A default an operator has to guess is a support question. Asserted
    // positively for the subset that HAS a default, so adding an entry with a
    // null default does not silently skip the check.
    const withDefault = DOCUMENTED_ENV_VARS.filter((v) => v.default !== null);
    assert.ok(withDefault.length >= 5, 'only a few defaults are declared — the check is thin');
    for (const v of withDefault) {
      assert.ok(
        help.includes(`default ${v.default}`),
        `--help does not state the default for ${v.name} (${v.default})`,
      );
    }
  });

  it('scans a real surface (an empty registry would make the checks vacuous)', () => {
    assert.ok(
      DOCUMENTED_ENV_VARS.length >= 10,
      `the registry holds ${DOCUMENTED_ENV_VARS.length} variables — the render is too thin to be a quick reference`,
    );
    assert.ok(
      help.split('\n').length >= 10,
      'renderEnvHelp produced too few rows to be meaningful',
    );
    // Distinctness: a repeated name would render twice and read as two knobs.
    const names = DOCUMENTED_ENV_VARS.map((v) => v.name);
    assert.equal(new Set(names).size, names.length, 'the registry lists a variable twice');
  });
});

describe('.env.example names every quick-reference variable (#621)', () => {
  const example = read('.env.example');

  it('has an assignment line for each one', () => {
    // This is the issue's meta-test: `.env.example` is a copy-me template, so a
    // variable with no line in it is a variable an operator filling in the
    // template will not discover.
    const missing = DOCUMENTED_ENV_VARS
      .filter((v) => !ENV_ASSIGNMENT(v.name).test(example))
      .map((v) => v.name);
    assert.deepEqual(
      missing,
      [],
      'these variables are absent from .env.example: ' + missing.join(', ')
        + '. The template presents itself as complete, so a missing row is a '
        + 'variable nobody sets.',
    );
  });

  it('keeps every variable that was already documented', () => {
    // .env.example is a shared surface several PRs have edited, and entries
    // have been added over time. This change is additive; a row that
    // disappears is as much a regression as one that fails to appear.
    const preserved = [
      'SPOTIFY_CLIENT_ID',
      'SPOTIFY_REDIRECT_URI',
      'SPOTIFY_MCP_TOKEN_FILE',
      'SPOTIFY_HEADLESS',
      'SPOTIFY_REQUEST_TIMEOUT_MS',
      'SPOTIFY_MCP_MAX_ITEMS',
      'SPOTIFY_MCP_FETCH_ALL_CAP',
      'SPOTIFY_MCP_FANOUT_CONCURRENCY',
      'SPOTIFY_MCP_HISTORY',
      'SPOTIFY_MCP_HISTORY_DIR',
      'SPOTIFY_MCP_HISTORY_MAX_BYTES',
    ];
    for (const name of preserved) {
      assert.ok(
        ENV_ASSIGNMENT(name).test(example),
        `${name} was removed from .env.example by this change — it must be additive`,
      );
    }
  });

  it('scans a real surface (a broken pattern would make the check vacuous)', () => {
    const assigned = [...example.matchAll(/^[ \t]*#?[ \t]*(SPOTIFY_[A-Z0-9_]+)[ \t]*=/gm)];
    assert.ok(
      assigned.length >= DOCUMENTED_ENV_VARS.length,
      `.env.example yielded ${assigned.length} assignments for a ${DOCUMENTED_ENV_VARS.length}-variable registry`,
    );
  });
});

describe('the full reference covers the quick reference (#621)', () => {
  const docs = read('docs/configuration.md');

  it('documents every registry variable', () => {
    const missing = DOCUMENTED_ENV_VARS.filter((v) => !docs.includes(v.name)).map((v) => v.name);
    assert.deepEqual(
      missing,
      [],
      'these variables are in --help and .env.example but not in docs/configuration.md: '
        + missing.join(', '),
    );
  });

  it('still carries its "Not used" section, which the env-var guard depends on', () => {
    // tests/env-var-truth.test.ts parses this section by splitting on the
    // heading. Silently renaming it would empty that section's meaning and
    // quietly turn the escape hatch into "anything goes".
    assert.match(docs, /^## Not used$/m, 'docs/configuration.md lost its "## Not used" section');
  });
});
