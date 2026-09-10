/**
 * Registry metadata sync — server.json (MCP Registry manifest) must track
 * package.json. The 1.29.0/1.30.0 releases shipped with server.json pinned at
 * 1.28.1 because release-please only bumps package.json/package-lock; the
 * publish workflow re-syncs the version ephemerally at tag time, but the
 * committed manifest is what reviewers and registry validators read.
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
