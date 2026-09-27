/**
 * Empty `--profile` / `--scopes` values must be errors, not "unset" (#617).
 *
 * Two auth flags conflated *absent* with *present-but-empty*:
 *
 *   - `parseAuthArgs` accepted `--profile=` and a dangling trailing `--profile`,
 *     and `getTokenFile` then read the empty name as falsy, so
 *     `spotify-mcp auth --profile "$UNSET_VAR"` wrote tokens into the shared
 *     default file while the operator believed a named profile was created.
 *   - `parseScopesString` / `parseScopes` returned `null` for an empty value and
 *     `resolveScopes` read `null` as "not set", substituting the 17-scope
 *     DEFAULT_SCOPES — every mutation scope, the widest consent set, the exact
 *     opposite of the minimum-scope discipline in AGENTS.md §1.
 *
 * The argv grid, the scope parsers, and the precedence order in `resolveScopes`
 * are all covered here, plus an end-to-end run of the real CLI asserting it
 * exits non-zero and writes no token file into a sandboxed HOME.
 */

import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { parseAuthArgs, parseScopesString, resolveScopes, getTokenFile } =
  await import('../src/auth.ts');
const { parseScopes, loadConfig, DEFAULT_SCOPES } = await import('../src/config.ts');

const PROFILE_ERROR = /--profile requires a name matching \[A-Za-z0-9\._-\]\+/;
const SCOPES_ERROR = /--scopes was given but contained no scope names/;

/** Env keys the token-file and scope resolution read; saved/restored per test. */
const ENV_KEYS = [
  'SPOTIFY_MCP_TOKEN_FILE',
  'SPOTIFY_MCP_PROFILE',
  'SPOTIFY_SCOPES',
] as const;

let saved: Map<string, string | undefined>;

/** Run `body` with the resolution env cleared, then restore exactly as found. */
function withCleanEnv<T>(body: () => T): T {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  try {
    return body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeEach(() => {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('--profile argv grid (#617)', () => {
  it('resolves a separated name to tokens.<name>.json', () => {
    withCleanEnv(() => {
      assert.equal(parseAuthArgs(['--profile', 'work']).profile, 'work');
      assert.match(getTokenFile(parseAuthArgs(['--profile', 'work']).profile), /tokens\.work\.json$/);
    });
  });

  it('resolves an --profile=name form to tokens.<name>.json', () => {
    withCleanEnv(() => {
      assert.equal(parseAuthArgs(['--profile=work']).profile, 'work');
      assert.match(getTokenFile(parseAuthArgs(['--profile=work']).profile), /tokens\.work\.json$/);
    });
  });

  it('rejects --profile= instead of falling back to the default token file', () => {
    withCleanEnv(() => {
      assert.throws(() => parseAuthArgs(['--profile=']), PROFILE_ERROR);
    });
  });

  it('rejects a dangling trailing --profile instead of dropping it silently', () => {
    withCleanEnv(() => {
      assert.throws(() => parseAuthArgs(['auth', '--profile']), PROFILE_ERROR);
    });
  });

  it('rejects an empty or whitespace-only name in the separated form', () => {
    withCleanEnv(() => {
      // The exact shape of `auth --profile "$UNSET_VAR"`.
      assert.throws(() => parseAuthArgs(['--profile', '']), PROFILE_ERROR);
      assert.throws(() => parseAuthArgs(['--profile', '   ']), PROFILE_ERROR);
    });
  });

  it('still rejects a name with unsafe characters rather than accepting it', () => {
    withCleanEnv(() => {
      const parsed = parseAuthArgs(['--profile=../escape']);
      assert.equal(parsed.profile, '../escape');
      // Character-level validation is unchanged and still fail-closed.
      assert.throws(() => getTokenFile(parsed.profile), /Invalid --profile/);
    });
  });
});

describe('--scopes argv grid (#617)', () => {
  it('accepts a narrow explicit list and does not widen it to the defaults', () => {
    withCleanEnv(() => {
      assert.equal(
        resolveScopes(parseAuthArgs(['--scopes=user-read-email']).scopes),
        'user-read-email',
      );
    });
  });

  it('rejects --scopes= instead of requesting every default scope', () => {
    withCleanEnv(() => {
      assert.throws(() => parseAuthArgs(['--scopes=']), SCOPES_ERROR);
    });
  });

  it('rejects a dangling trailing --scopes and the empty separated form', () => {
    withCleanEnv(() => {
      assert.throws(() => parseAuthArgs(['--scopes']), SCOPES_ERROR);
      assert.throws(() => parseAuthArgs(['--scopes', '']), SCOPES_ERROR);
      assert.throws(() => parseAuthArgs(['--scopes', '  ']), SCOPES_ERROR);
    });
  });
});

describe('scope parsing: absent is not the same as empty (#617)', () => {
  it('resolveScopes(undefined, undefined) still returns the full default set', () => {
    withCleanEnv(() => {
      const resolved = resolveScopes(undefined, undefined);
      assert.equal(resolved, DEFAULT_SCOPES.join(' '));
      assert.equal(resolved.split(' ').length, 17);
    });
  });

  it('resolveScopes picks up the env value when the CLI is absent', () => {
    withCleanEnv(() => {
      assert.equal(resolveScopes(undefined, 'user-read-email'), 'user-read-email');
    });
  });

  it('an empty CLI scope string never builds the DEFAULT_SCOPES request', () => {
    withCleanEnv(() => {
      for (const empty of ['', ' ', ',', '  ,  ']) {
        assert.throws(
          () => resolveScopes(empty, undefined),
          /--scopes was given but contained no scope names/,
          `--scopes=${JSON.stringify(empty)} must not fall back to the defaults`,
        );
      }
    });
  });

  it('a set-but-empty SPOTIFY_SCOPES never builds the DEFAULT_SCOPES request', () => {
    withCleanEnv(() => {
      for (const empty of ['', ' ', ',', ' , , ']) {
        assert.throws(
          () => resolveScopes(undefined, empty),
          /SPOTIFY_SCOPES was given but contained no scope names/,
          `SPOTIFY_SCOPES=${JSON.stringify(empty)} must not fall back to the defaults`,
        );
      }
    });
  });

  it('parseScopesString/parseScopes return null only for an absent value', () => {
    withCleanEnv(() => {
      assert.equal(parseScopesString(undefined), null);
      assert.equal(parseScopes(undefined), null);
      assert.deepEqual(parseScopesString('user-read-email'), ['user-read-email']);
      assert.throws(() => parseScopesString(''), /contained no scope names/);
      assert.throws(() => parseScopes(' '), /contained no scope names/);
    });
  });

  it('a set-but-empty SPOTIFY_SCOPES fails config load instead of loading defaults', () => {
    withCleanEnv(() => {
      assert.throws(
        () => loadConfig({ SPOTIFY_SCOPES: ' ' }),
        /SPOTIFY_SCOPES was given but contained no scope names/,
      );
      // Absence is still the documented way to get the defaults.
      assert.deepEqual(loadConfig({}).scopes, null);
    });
  });

  it('an unknown scope is still named in the error', () => {
    withCleanEnv(() => {
      assert.throws(() => resolveScopes('not-a-real-scope', undefined), /Unknown scope/);
      assert.throws(() => parseScopes('not-a-real-scope'), /Unknown scope in SPOTIFY_SCOPES/);
    });
  });
});

describe('the auth CLI exits non-zero and writes no token file (#617)', () => {
  const CASES = [
    { name: '--profile=', argv: ['auth', '--profile='], error: PROFILE_ERROR },
    { name: 'dangling --profile', argv: ['auth', '--profile'], error: PROFILE_ERROR },
    { name: '--profile ""', argv: ['auth', '--profile', ''], error: PROFILE_ERROR },
    { name: '--scopes=', argv: ['auth', '--scopes='], error: SCOPES_ERROR },
    { name: 'dangling --scopes', argv: ['auth', '--scopes'], error: SCOPES_ERROR },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name} fails before any token is written`, () => {
      const home = mkdtempSync(path.join(tmpdir(), 'spotify-mcp-617-home-'));
      // Explicitly absent, not empty: an exported-but-empty value is a
      // different (now-rejected) state, and must not be what this run sees.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SPOTIFY_CLIENT_ID: 'test-client-id',
      };
      for (const key of ENV_KEYS) delete env[key];
      try {
        const result = spawnSync(
          process.execPath,
          ['--import', 'tsx', 'src/index.ts', ...testCase.argv],
          { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env },
        );
        assert.equal(result.signal, null, `the CLI must exit, not be killed (${result.signal})`);
        assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}`);
        assert.match(result.stderr, testCase.error);
        // The dangerous outcome was a tokens.json in the shared default location.
        assert.equal(
          existsSync(path.join(home, '.spotify-mcp', 'tokens.json')),
          false,
          'no default token file may be created by a rejected --profile',
        );
        assert.equal(
          existsSync(path.join(home, '.spotify-mcp')),
          false,
          'the token directory must not be created at all',
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
