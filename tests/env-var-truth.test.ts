/**
 * Environment-variable truth guard (#590).
 *
 * This server has no unified env registry: variables are read wherever they
 * are needed, and advertised in a tool description, in `.env.example`, or in
 * docs/configuration.md. Nothing connected the two sides, so a variable could
 * be documented without ever being read — `SPOTIFY_MCP_SHOWRADAR_BUDGET` was
 * named in `show_new_episodes`'s `max_shows` description while the handler
 * only ever read the shared freshness budget, and `SPOTIFY_MCP_RECEIPTS` had a
 * row in the configuration table promising a JSONL store that no code has ever
 * implemented. An operator who follows either promise gets identical behaviour
 * and no diagnostic, which on a host where env is the only configuration
 * surface is indistinguishable from a broken deployment.
 *
 * ## What this asserts, and what it deliberately does not
 *
 * ONE direction: every advertised variable is read by the server.
 *
 * The mirror (every read variable is advertised) is NOT asserted here.
 * `SPOTIFY_MCP_BACKUP_RETENTION_DAYS` is read at src/paths.ts and documented by
 * the open PR #1043; enforcing the mirror here would redden this guard for
 * another unit's pending work, or force this file to duplicate a doc row
 * somebody else owns. The mirror becomes enforceable once that row lands.
 *
 * Two exclusions, both structural rather than hardcoded name lists:
 *
 *  - a `SPOTIFY_*` identifier that is *declared* in src/ (`SPOTIFY_ID_RE`,
 *    `SPOTIFY_SEARCH_MAX_LIMIT`, `SPOTIFY_REFERENCE_KINDS`, …) is a module
 *    constant, not an environment variable, and is not an advertisement;
 *  - a variable named in the configuration reference's "## Not used" section
 *    (currently `SPOTIFY_CLIENT_SECRET`, which the PKCE flow never sends) is
 *    documented *as unsupported*, which is the opposite of a promise. A test
 *    below fails if that section is ever used to excuse a variable the code
 *    does read, so the escape hatch cannot quietly absorb a real knob.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A bare `SPOTIFY_MCP_FOO` token. The trailing class forbids the `SPOTIFY_MCP_` prefix fragments used in prose. */
const ENV_TOKEN = /\b(SPOTIFY_[A-Z0-9_]*[A-Z0-9])\b/g;
/** A read: `process.env.X` or a `NodeJS.ProcessEnv` parameter named `env`. */
const ENV_READ = /\b(?:process\.env|env)\.(SPOTIFY_[A-Z0-9_]+)\b/g;
/** A module-level declaration: a constant named like an env var is not an env var. */
const ENV_DECLARED =
  /\b(?:const|let|var|function|class|interface|type|enum)\s+(SPOTIFY_[A-Z0-9_]+)\b/g;
/** An assignment line in .env.example, commented or not. */
const ENV_ASSIGNED = /^[ \t]*#?[ \t]*(SPOTIFY_[A-Z0-9_]+)[ \t]*=/gm;

/** ROOT-anchored read, used at every corpus call site so a path is never built twice. */
function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function filesUnder(relativeDir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(rel);
    }
  };
  walk(relativeDir);
  return out.sort();
}

/** Where each env-shaped token appears, so a failure names the promise. */
function collect(map: Map<string, string[]>, name: string, where: string): void {
  const hits = map.get(name);
  if (hits) hits.push(where);
  else map.set(name, [where]);
}

function collectAll(map: Map<string, string[]>, pattern: RegExp, text: string, where: string): void {
  for (const match of text.matchAll(pattern)) collect(map, match[1]!, where);
}

/** Every `SPOTIFY_*` name the server actually reads. */
function readVariables(): Set<string> {
  const sources = [...filesUnder('src', ['.ts']), ...filesUnder('scripts', ['.mjs', '.js'])];
  const out = new Set<string>();
  for (const file of sources) for (const name of read(file).matchAll(ENV_READ)) out.add(name[1]!);
  return out;
}

/** `SPOTIFY_*` names declared as module identifiers — constants, not configuration. */
function declaredIdentifiers(): Set<string> {
  const out = new Set<string>();
  for (const file of filesUnder('src', ['.ts'])) {
    for (const name of read(file).matchAll(ENV_DECLARED)) out.add(name[1]!);
  }
  return out;
}

/**
 * Every `SPOTIFY_*` name an operator can be shown: source comments and
 * descriptions, .env.example, and the prose docs an agent reads before
 * configuring the server.
 */
function advertisedVariables(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of filesUnder('src', ['.ts'])) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        for (const match of line.matchAll(ENV_TOKEN)) collect(out, match[1]!, `${file}:${i + 1}`);
      });
  }
  collectAll(out, ENV_ASSIGNED, read('.env.example'), '.env.example');
  const docs = ['README.md', 'SPEC.md', 'PRIVACY.md', ...filesUnder('docs', ['.md']), ...filesUnder('skills', ['.md'])];
  for (const file of docs) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        for (const match of line.matchAll(ENV_TOKEN)) collect(out, match[1]!, `${file}:${i + 1}`);
      });
  }
  return out;
}

/** Names the configuration reference lists as deliberately unsupported. */
function documentedAsUnsupported(): Set<string> {
  const text = read('docs/configuration.md');
  const section = text.split(/^## Not used$/m)[1];
  assert.ok(section, 'docs/configuration.md lost its "## Not used" section');
  const out = new Set<string>();
  for (const match of section.matchAll(ENV_TOKEN)) out.add(match[1]!);
  return out;
}

describe('advertised environment variables (#590)', () => {
  const readSet = readVariables();
  const declared = declaredIdentifiers();
  const advertised = advertisedVariables();
  const unsupported = documentedAsUnsupported();

  it('reads every variable it advertises', () => {
    const unkept: string[] = [];
    for (const [name, where] of [...advertised].sort()) {
      if (readSet.has(name) || declared.has(name) || unsupported.has(name)) continue;
      unkept.push(`${name} — advertised at ${where.slice(0, 4).join(', ')}`);
    }
    assert.deepEqual(
      unkept,
      [],
      'These variables are advertised to an operator but read by no code, so setting '
        + 'them changes nothing:\n  ' + unkept.join('\n  ')
        + '\nEither give each one a read path, or stop advertising it.',
    );
  });

  it('uses the "## Not used" section only for variables the code truly ignores', () => {
    const excused = [...unsupported].filter((name) => readSet.has(name)).sort();
    assert.deepEqual(
      excused,
      [],
      'docs/configuration.md lists these under "## Not used" but the server reads them, '
        + 'so the section denies a knob that works: ' + excused.join(', '),
    );
  });

  it('scans a real surface (a broken pattern would make the guard vacuous)', () => {
    assert.ok(readSet.size >= 30, `only ${readSet.size} env reads found — the read pattern is too narrow`);
    assert.ok(advertised.size >= 40, `only ${advertised.size} advertised names found — the scan is too narrow`);
    const exampleVars = [...read('.env.example').matchAll(ENV_ASSIGNED)].map((m) => m[1]!);
    assert.ok(exampleVars.length >= 8, `.env.example yielded ${exampleVars.length} variables; the assignment pattern is too narrow`);
    assert.ok(readSet.has('SPOTIFY_CLIENT_ID'), 'SPOTIFY_CLIENT_ID is not in the read set');
    assert.ok(declared.has('SPOTIFY_ID_RE'), 'the declared-identifier exclusion is not matching src/refs.ts');
  });
});
