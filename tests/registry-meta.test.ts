/**
 * Registry metadata sync — server.json (MCP Registry manifest) must track
 * package.json. The 1.29.0/1.30.0 releases shipped with server.json pinned at
 * 1.28.1 because release-please only bumps package.json/package-lock; the
 * publish workflow re-syncs the version ephemerally at tag time, but the
 * committed manifest is what reviewers and registry validators read.
 *
 * The same drift class hit the description: npm, the MCP Registry, the README
 * one-liner and the docs blurbs each claimed something different (#655). One
 * canonical sentence is authored in docs/distribution.md and pinned here, plus
 * an offline subset of the registry schema's ServerDetail limits.
 *
 * Run with: node --import tsx --test tests/registry-meta.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8'));
const docs = readFileSync(path.join(root, 'docs/distribution.md'), 'utf8');
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');

/**
 * Constraints mirrored from ServerDetail in
 * https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 * (definitions.ServerDetail / definitions.BaseMetadata). Mirrored rather than
 * fetched so the guard runs offline; the pinned $schema assertion below fails
 * loudly if the manifest is bumped to a revision whose limits differ.
 */
const MIRRORED_REGISTRY_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const REGISTRY_NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const REGISTRY_TITLE_MAX = 100;
const REGISTRY_DESCRIPTION_MAX = 100;
const REGISTRY_VERSION_MAX = 255;

const textLength = (value: string): number => Array.from(value).length;

/** `Canonical <label>: <value>` marker lines authored in docs/distribution.md. */
function canonicalMarker(label: string): string {
  const matches = [...docs.matchAll(new RegExp(`^Canonical ${label}: (.+)$`, 'gm'))];
  assert.equal(
    matches.length,
    1,
    `docs/distribution.md must declare exactly one "Canonical ${label}:" marker line, found ${matches.length}`,
  );
  const value = matches[0]![1]!.trim();
  assert.ok(value.length > 0, `"Canonical ${label}:" marker line must not be empty`);
  return value;
}

/** Body of a `## <heading>` section, trimmed. */
function docsSection(heading: string): string {
  const start = docs.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `docs/distribution.md is missing the "## ${heading}" section`);
  const rest = docs.slice(start + `## ${heading}\n`.length);
  const end = rest.indexOf('\n## ');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** Unwrap a markdown blurb: drop blockquote markers, join wrapped lines with single spaces. */
function unwrap(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^>\s?/, ''))
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** README prose above the first generated block: headings, badges, rules and quotes are not the one-liner. */
function readmeOneLiner(md: string): string {
  const generated = md.indexOf('<!-- BEGIN:generated');
  assert.notEqual(generated, -1, 'README.md must keep its generated block markers');
  for (const line of md.slice(0, generated).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('![')) continue;
    if (trimmed.startsWith('[') || trimmed.startsWith('>') || trimmed === '---') continue;
    return trimmed;
  }
  throw new Error('README.md has no prose one-line description above the first generated block');
}

/** README lines that are not inside a `<!-- BEGIN:generated -->` block. */
function readmeAuthoredLines(md: string): string[] {
  const authored: string[] = [];
  let insideGenerated = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('<!-- BEGIN:generated')) insideGenerated = true;
    if (!insideGenerated) authored.push(line);
    if (line.startsWith('<!-- END:generated')) insideGenerated = false;
  }
  return authored;
}
describe('registry metadata sync', () => {
  it('server.json version tracks package.json version', () => {
    assert.equal(
      server.version,
      pkg.version,
      `server.json version (${server.version}) must equal package.json version (${pkg.version})`,
    );
  });

  it('server.json npm package version tracks package.json version', () => {
    assert.ok(Array.isArray(server.packages) && server.packages.length > 0, 'server.json must list at least one package');
    assert.equal(
      server.packages[0].version,
      pkg.version,
      `server.json packages[0].version (${server.packages[0].version}) must equal package.json version (${pkg.version})`,
    );
  });

  it('server.json identifiers track package.json name', () => {
    assert.equal(
      server.packages[0].identifier,
      pkg.name,
      `server.json packages[0].identifier (${server.packages[0].identifier}) must equal package.json name (${pkg.name})`,
    );
    if (typeof pkg.mcpName === 'string') {
      assert.equal(
        server.name,
        pkg.mcpName,
        `server.json name (${server.name}) must equal package.json mcpName (${pkg.mcpName})`,
      );
    }
  });
});

describe('canonical description sync (#655)', () => {
  // Resolved inside each test so a missing/duplicated marker fails one assertion
  // at a time instead of aborting the whole file at import time.
  const canonicalShort = (): string => canonicalMarker('short description');
  const canonicalNotice = (): string => canonicalMarker('non-affiliation notice');

  it('npm, registry, README and the docs blurb all carry the identical description', () => {
    const surfaces: Array<[string, string]> = [
      ['package.json', pkg.description],
      ['server.json', server.description],
      ['README.md one-liner', readmeOneLiner(readme)],
      ['docs/distribution.md short blurb', unwrap(docsSection('Short blurb (directories)'))],
    ];
    const distinct = [...new Set(surfaces.map(([, value]) => value))];
    assert.equal(
      distinct.length,
      1,
      `the server is described ${distinct.length} different ways: ${surfaces
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
        .join(' | ')}`,
    );
  });

  it('docs/distribution.md authors one canonical short description within the registry limit', () => {
    const short = canonicalShort();
    assert.ok(
      textLength(short) <= REGISTRY_DESCRIPTION_MAX,
      `canonical short description is ${textLength(short)} chars; the MCP Registry caps description at ${REGISTRY_DESCRIPTION_MAX}`,
    );
  });

  it('package.json description equals the canonical short description', () => {
    const short = canonicalShort();
    assert.equal(
      pkg.description,
      short,
      `package.json description (${pkg.description}) must equal the canonical description (${short})`,
    );
  });

  it('server.json description equals the canonical short description', () => {
    const short = canonicalShort();
    assert.equal(
      server.description,
      short,
      `server.json description (${server.description}) must equal the canonical description (${short})`,
    );
  });

  it('docs short blurb equals the canonical short description', () => {
    const short = canonicalShort();
    const blurb = unwrap(docsSection('Short blurb (directories)'));
    assert.equal(
      blurb,
      short,
      `docs/distribution.md short blurb (${blurb}) must equal the canonical description (${short})`,
    );
  });

  it('docs long description opens with the canonical short description', () => {
    const short = canonicalShort();
    const long = unwrap(docsSection('Long description (Glama / PulseMCP style)'));
    assert.ok(
      long.startsWith(short),
      `docs/distribution.md long description must open with the canonical description (${short}); it starts with: ${long.slice(0, short.length + 20)}`,
    );
  });

  it('README one-line description equals the canonical short description', () => {
    const short = canonicalShort();
    const oneLiner = readmeOneLiner(readme);
    assert.equal(
      oneLiner,
      short,
      `README.md one-line description (${oneLiner}) must equal the canonical description (${short})`,
    );
  });

  it('canonical description embeds the canonical non-affiliation notice', () => {
    const notice = canonicalNotice();
    const short = canonicalShort();
    assert.ok(
      short.includes(notice),
      `canonical description (${short}) must contain the notice verbatim: ${notice}`,
    );
  });

  it('README pairs the non-affiliation notice with the Developer Terms link', () => {
    const notice = canonicalNotice();
    const disclosures = readmeAuthoredLines(readme).filter(
      (line) => line.includes(notice) && line.includes('developer.spotify.com/terms'),
    );
    assert.ok(
      disclosures.length > 0,
      `README.md must carry the non-affiliation notice (${notice}) alongside the Spotify Developer Terms link`,
    );
  });
});


describe('server.json registry schema conformance (#655)', () => {
  it('declares the schema revision whose limits are mirrored by this suite', () => {
    assert.equal(
      server.$schema,
      MIRRORED_REGISTRY_SCHEMA,
      `server.json $schema (${server.$schema}) must equal the mirrored schema (${MIRRORED_REGISTRY_SCHEMA})`,
    );
  });

  it('satisfies the required ServerDetail string fields', () => {
    assert.match(server.name, REGISTRY_NAME_PATTERN, `server.json name (${server.name}) must be reverse-DNS`);
    assert.ok(
      textLength(server.description) >= 1 && textLength(server.description) <= REGISTRY_DESCRIPTION_MAX,
      `server.json description must be 1..${REGISTRY_DESCRIPTION_MAX} chars, got ${textLength(server.description)}`,
    );
    assert.ok(
      textLength(server.version) >= 1 && textLength(server.version) <= REGISTRY_VERSION_MAX,
      `server.json version must be 1..${REGISTRY_VERSION_MAX} chars, got ${textLength(server.version)}`,
    );
  });

  it('satisfies the optional title length limit', () => {
    if (server.title === undefined) return;
    assert.ok(
      textLength(server.title) >= 1 && textLength(server.title) <= REGISTRY_TITLE_MAX,
      `server.json title must be 1..${REGISTRY_TITLE_MAX} chars, got ${textLength(server.title)}`,
    );
  });

  it('describes the npm package with a stdio transport', () => {
    const npmPackage = server.packages.find((entry: { registryType?: string }) => entry.registryType === 'npm');
    assert.ok(npmPackage, 'server.json must list an npm package');
    assert.equal(npmPackage.identifier, pkg.name);
    assert.equal(npmPackage.version, pkg.version);
    assert.equal(npmPackage.transport?.type, 'stdio');
  });
});
