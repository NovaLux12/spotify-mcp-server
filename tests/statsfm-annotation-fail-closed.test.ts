/**
 * #1600 — the `statsfm_` family must fail CLOSED.
 *
 * Every other read is admitted by a verb prefix, and a verb allowlist is
 * fail-closed: a name nobody anticipated is a write. `statsfm_` was the one
 * exception, and it was a PRODUCT prefix being read as a verb. Every
 * `statsfm_*` name therefore matched `READ_ONLY_PREFIXES` — the `statsfm`
 * alternative that was listed for it, and, redundantly, the plain `stats`
 * alternative that was not — and was advertised to hosts as `readOnlyHint:
 * true` without anyone having read its handler.
 *
 * The two writers that exist today are held in place by OVERRIDES rows, so
 * nothing is currently mis-advertised. That is exactly the shape that is unsafe:
 * the safety property is "a human remembered", and a human does not have to
 * remember. A hand list is only a gate if something fails when it is wrong, and
 * nothing did.
 *
 * This file is deliberately BEHAVIOURAL. It builds the real registry through
 * the shared manifest pass, annotates it with the same `applyToolAnnotations`
 * the server runs at startup, plants hypothetical writers with the `extra`
 * seam, and reads the resulting `readOnlyHint` VALUE off the registered entry.
 * A source-text assertion could only ever re-state the rule; the rule is the
 * thing under suspicion here. The repo has the scar for it — a guard that
 * projects to `Object.keys` passed against a tool committing on an omitted flag
 * — and the same applies to an allowlist check that reads the list it is
 * checking.
 *
 * No Spotify traffic, no credentials, no port. Every path here is in-process.
 */

import './helpers/hermetic.js';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  applyToolAnnotations,
  DESTRUCTIVE_PREFIXES,
  READ_ONLY_PREFIXES,
  STATSFM_READ_ONLY,
} from '../src/tools/annotations.js';
import { buildFullRegistryServer } from './live-registry.js';

interface Row {
  name: string;
  readOnly: boolean;
  destructive: boolean | undefined;
}

/** The live registry, annotated exactly as the server annotates it at startup. */
async function liveRows(extra?: (server: McpServer) => void): Promise<Row[]> {
  const server = await buildFullRegistryServer(extra ? { extra } : {});
  applyToolAnnotations(server);
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { annotations?: Record<string, boolean> }>;
  })._registeredTools ?? {};
  return Object.entries(registry).map(([name, entry]) => ({
    name,
    readOnly: entry.annotations?.readOnlyHint === true,
    destructive: entry.annotations?.destructiveHint,
  }));
}

function rowFor(rows: Row[], name: string): Row {
  const row = rows.find((r) => r.name === name);
  assert.ok(row, `${name} is not registered`);
  return row;
}

let LIVE: Row[] = [];
before(async () => {
  LIVE = await liveRows();
});

describe('#1600: the statsfm family fails closed', () => {
  it('does not advertise a hypothetical stats.fm writer as read-only', async () => {
    // Four shapes of the same mistake. `statsfm_jukebox_style_sync` has no
    // mutating verb and no destructive verb, so under the pre-fix rule it was
    // granted read-only on its name alone and nothing in the tree had to notice.
    const hypotheticalWrites = [
      'statsfm_jukebox_style_sync',
      'statsfm_mark_album_played',
      'statsfm_push_playlists',
      'statsfm_replay_streams',
    ];

    const rows = await liveRows((server) => {
      for (const name of hypotheticalWrites) {
        server.registerTool(name, {
          description: 'A stats.fm writer that does not exist yet.',
          inputSchema: { dry_run: z.boolean().optional() },
        }, async () => ({ content: [], structuredContent: {} }));
      }
    });

    const planted = rows.filter((r) => hypotheticalWrites.includes(r.name)).map((r) => r.name);
    assert.equal(planted.length, hypotheticalWrites.length,
      `the planted tools did not all reach the registry: [${planted.join(', ')}]`);

    // Assert the PREMISE against the real regex, not a copy of it: every one of
    // these names matches the read-verb allowlist. Without this the assertion
    // below could pass because the names are boring rather than because the
    // family rule works.
    for (const name of hypotheticalWrites) {
      assert.equal(READ_ONLY_PREFIXES.test(name), true,
        `${name} no longer matches READ_ONLY_PREFIXES — this test can no longer fail`);
    }

    const advertised = rows
      .filter((r) => hypotheticalWrites.includes(r.name) && r.readOnly)
      .map((r) => r.name);
    assert.deepEqual(advertised, [],
      `unclassified stats.fm writers advertised read-only: [${advertised.join(', ')}]`);
  });

  it('still states a destructiveHint on the writes it does not grant', async () => {
    // MCP defaults `destructiveHint` to true, so the SAFE default for a write is
    // to say so explicitly rather than stay silent — and failing out of the
    // family must not make a tool look *less* destructive than its own verb
    // proves. Both halves are checked: the field is present on every write, and
    // a destructive verb still reads as destructive.
    const names = ['statsfm_jukebox_style_sync', 'statsfm_delete_playlists', 'statsfm_purge_history'];
    const rows = await liveRows((server) => {
      for (const name of names) {
        server.registerTool(name, { description: 'Unclassified stats.fm tool.', inputSchema: {} },
          async () => ({ content: [], structuredContent: {} }));
      }
    });
    for (const name of names) {
      const row = rowFor(rows, name);
      assert.notEqual(row.readOnly, true, `${name} advertised read-only`);
      assert.notEqual(row.destructive, undefined, `${name} states no destructiveHint`);
    }
    assert.equal(rowFor(rows, 'statsfm_delete_playlists').destructive, true,
      'a destructive verb in the name must still classify as destructive');
    assert.equal(rowFor(rows, 'statsfm_purge_history').destructive, true,
      'a destructive verb in the name must still classify as destructive');
    assert.equal(DESTRUCTIVE_PREFIXES.test('statsfm_jukebox_style_sync'), false,
      'the non-destructive premise of the first case no longer holds');
  });

  it('keeps all 37 real stats.fm reads read-only', () => {
    const reads = LIVE.filter((r) => r.name.startsWith('statsfm_') && r.readOnly).map((r) => r.name);
    assert.equal(reads.length, 37, `expected the read half of the 39-tool family, got ${reads.length}`);
    // The 37 real reads and the 2 real writes are exactly the 39-tool family.
    assert.equal(new Set(reads).size, reads.length, 'duplicate names in the derived read set');
  });

  it('keeps the two known stats.fm writers as writers', () => {
    for (const name of ['statsfm_jukebox', 'statsfm_record_feedback']) {
      const row = rowFor(LIVE, name);
      assert.notEqual(row.readOnly, true, `${name} advertised read-only`);
      assert.equal(row.destructive, false, `${name} must explicitly be non-destructive`);
    }
  });

  it('holds the allowlist to the live family in both directions', () => {
    // Otherwise a new stats.fm tool silently classifies as a write, and the
    // first person to notice is a user asking why it vanished from
    // SPOTIFY_MCP_READONLY.
    const family = LIVE.filter((r) => r.name.startsWith('statsfm_')).map((r) => r.name);
    const derived = new Set(family.filter((n) => LIVE.find((r) => r.name === n)?.readOnly === true));
    const missing = [...derived].filter((n) => !STATSFM_READ_ONLY.has(n)).sort();
    const extra = [...STATSFM_READ_ONLY].filter((n) => !derived.has(n)).sort();
    assert.deepEqual(missing, [], `classified read-only but absent from STATSFM_READ_ONLY: [${missing.join(', ')}]`);
    assert.deepEqual(extra, [], `in STATSFM_READ_ONLY but not a read-only registered tool: [${extra.join(', ')}]`);
    assert.equal(family.length, 39, `expected the 39-tool family, got ${family.length}`);
  });

  it('leaves the `stats` read verbs alone', () => {
    // The obvious over-correction is to delete `stats` from the allowlist
    // instead of special-casing the family. That would break real tools whose
    // names have nothing to do with stats.fm.
    for (const name of ['stats_tracks', 'stats_weekly_listeners']) {
      assert.equal(READ_ONLY_PREFIXES.test(name), true,
        `${name} must still be admitted by the verb allowlist`);
    }
  });
});
