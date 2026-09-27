/**
 * #1568 — the four bulk playlist-item removals that asked nothing at any size.
 *
 * ## The inversion this pins shut
 *
 * `remove_from_playlist` gates at 10 and `remove_duplicate_playlist_items` at
 * 50. Beside them, four tools deleted from `/playlists/{id}/items` in a
 * chunked loop with NO confirmation gate at any size:
 *
 * | Tool | Max removed in one call | Threshold now |
 * |---|---|---|
 * | `remove_playlist_range` | a whole `[start, end)` range | 10 (REMOVE) |
 * | `playlist_exclude_artists` | every excluded position | 10 (REMOVE) |
 * | `move_tracks_between_playlists` | `max_results`, max 2000 | 50 (MOVE) |
 * | `balance_playlist_pairs` | `max_results` per playlist, max 2000 | 50 (MOVE) |
 *
 * The larger the removal, the less it asked. This file drives the real
 * handlers against a real `StubSpotifyClient` and asserts, per tool, the four
 * arms that a gate can get wrong: below the threshold it must NOT prompt, at
 * or above it it MUST, and both refusal arms — a decline and a host that
 * cannot prompt — must produce ZERO DELETEs.
 *
 * ## The number in the prompt is the number in the write (#803)
 *
 * The strongest assertion here is `promptNamesTheDeletedCount`: it counts the
 * rows out of the bodies the client actually received, and requires the prompt
 * to name that number. A prompt built from a plan size, or from a walk's row
 * count, would disagree with the write and still look correct — which is the
 * #803 failure mode in a new place, so the expectation is derived from the
 * write, never from a constant the code also uses.
 *
 * ## Thresholds are literals here, not imports
 *
 * The behaviour tests hard-code 10 and 50 so a future edit to either constant
 * fails this file rather than silently redefining "the threshold". A separate
 * test pins the constants to those literals, so raising one is a visible,
 * deliberate act with a failing test to update — not a change that quietly
 * moves what the suite proves.
 *
 * ## What is deliberately NOT tested
 *
 * `dry_run` still defaults to true on all four (asserted below), and
 * `restore_playlist_from_snapshot` / `apply_snapshot_changes` are still
 * ungated on purpose — that is a recorded decision with a `NO_GATE` constant
 * in `swarm3_snapshots.ts`, not an oversight, and this change does not touch
 * it.
 *
 * Hermetic: imports the home helper before any server code.
 */

import './helpers/hermetic.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject, SpotifyPaged } from '../src/types/spotify.js';
import { makeStubClient, type StubCall } from './helpers/stub-client.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';
import { REMOVE_ELICIT_THRESHOLD } from '../src/tools/confirm.js';
import { MOVE_ELICIT_THRESHOLD } from '../src/tools/playlistbatch.js';

// `SPOTIFY_MCP_CONFIRM=never` turns every verdict into "unsupported, proceed",
// which would silently reopen the unpromptable-host arms. Every suite that
// exercises a gate clears it, and so does this one.
afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

const ACCEPT = { action: 'accept', content: { confirm: true } };
const DECLINE = { action: 'decline' };

/** The removal thresholds, as literals, so this file is not defined by the code it tests. */
const REMOVE_AT = 10;
const MOVE_AT = 50;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ToolOut {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

interface Registered {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
}

interface PlaylistState {
  id: string;
  name: string;
  items: PlaylistItemObject[];
}

/** A credited track row. Every field the four tools read is set explicitly. */
function row(id: string, artistId = `artist-${id}`, artistName = `Artist ${id}`): PlaylistItemObject {
  return {
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      id,
      uri: `spotify:track:${id}`,
      name: `Track ${id}`,
      duration_ms: 200_000,
      artists: [{ id: artistId, name: artistName }],
      album: { id: `album-${id}`, name: `Album ${id}` },
    },
  } as unknown as PlaylistItemObject;
}

/** `n` distinct tracks, each by its own artist. */
const distinctRows = (n: number) => Array.from({ length: n }, (_, i) => row(`t${i}`));

/**
 * A 22-char base62 playlist id — the shape `normalizePlaylistReference`
 * insists on, so the fixtures exercise the real reference path rather than a
 * lenient shortcut a broken gate could hide behind.
 */
const PL = (n: number) => String(n).padStart(22, '0');
const PL_RANGE = PL(1);
const PL_SRC = PL(2);
const PL_DST = PL(3);
const PL_BIG = PL(4);
const PL_SMALL = PL(5);

/**
 * `n` distinct tracks that are ALL credited to one artist — the fixture
 * `playlist_exclude_artists` needs, since a varied cast would put each artist
 * below the threshold and the gate would never be reached.
 */
const oneArtistRows = (n: number) =>
  Array.from({ length: n }, (_, i) => row(`x${i}`, 'artist-0', 'Artist 0'));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ITEMS_PATH = /^\/playlists\/([^/]+)\/items$/;
const META_PATH = /^\/playlists\/([^/]+)$/;

/**
 * `elicit` omitted → the host advertises NO elicitation capability, which is
 * the fail-closed case. An `Error` → the prompt is attempted and fails on the
 * wire (#684). Otherwise the value is what `elicitInput` resolves to.
 */
function harness(playlists: PlaylistState[], elicit?: unknown) {
  const registered: Registered[] = [];
  const prompts: string[] = [];

  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, cfg: { description?: string; inputSchema?: z.ZodType }, handler: Registered['handler']) {
      registered.push({ name, validate: (a) => (cfg.inputSchema as z.ZodType).parse(a), handler });
    },
    ...(elicit !== undefined
      ? {
          // Real McpServer shape: the capability accessor and `elicitInput`
          // both live on the inner Server exposed as `.server`.
          server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            async elicitInput(request: { message?: string }) {
              prompts.push(request?.message ?? '');
              if (elicit instanceof Error) throw elicit;
              return elicit;
            },
          },
        }
      : {}),
  } as unknown as McpServer;

  // The store is REAL: a DELETE splices rows out, so "the write landed" and
  // "the rows are still there" are observations rather than a stub's opinion.
  const store = new Map(playlists.map((p) => [p.id, [...p.items]]));
  const names = new Map(playlists.map((p) => [p.id, p.name]));

  const client = makeStubClient(
    [
      [
        'GET',
        META_PATH,
        {
          respond: (call) => {
            const id = decodeURIComponent(META_PATH.exec(call.path)![1]!);
            const items = store.get(id);
            if (!items) return null;
            return { id, name: names.get(id) ?? id, items: { total: items.length }, tracks: { total: items.length } };
          },
        },
      ],
      [
        'GET',
        ITEMS_PATH,
        {
          respond: (call) => {
            const id = decodeURIComponent(ITEMS_PATH.exec(call.path)![1]!);
            const items = store.get(id);
            if (!items) return null;
            const offset = Number((call.arg as { offset?: string })?.offset ?? 0);
            const limit = Number((call.arg as { limit?: string })?.limit ?? 100);
            const page = items.slice(offset, offset + limit);
            return { items: page, limit, offset, next: null, total: items.length } as unknown as SpotifyPaged<PlaylistItemObject>;
          },
        },
      ],
      ['POST', ITEMS_PATH, { respond: () => ({ snapshot_id: 'snap' }) }],
      [
        'DELETE',
        ITEMS_PATH,
        {
          respond: (call) => {
            const id = decodeURIComponent(ITEMS_PATH.exec(call.path)![1]!);
            const items = store.get(id) ?? [];
            const tracks = (call.arg as { tracks?: Array<{ uri?: string; positions?: number[] }> })?.tracks ?? [];
            // A bare-uri DELETE drops every copy of that uri; a positional one
            // drops the named positions. The mock applies what it was sent, so
            // a tool that sent the wrong shape leaves a visible residue.
            const doomed = new Set<number>();
            for (const t of tracks) {
              if (Array.isArray(t.positions) && t.positions.length > 0) {
                for (const pos of t.positions) doomed.add(pos);
              } else {
                items.forEach((entry, position) => {
                  if (entry.item?.uri === t.uri) doomed.add(position);
                });
              }
            }
            store.set(id, items.filter((_, position) => !doomed.has(position)));
            return { snapshot_id: 'snap' };
          },
        },
      ],
      // The receipts re-read after every write; without this the strict stub
      // throws on a path the test never registered.
      ['GET', '/me/library/contains', { respond: () => [] }],
    ],
    { fetchAllCap: 5000 },
  );

  registerSwarm3PlaylistopsTools(fakeServer, client as unknown as SpotifyClient);
  registerExhaust2PlaylistsTools(fakeServer, client as unknown as SpotifyClient);

  return {
    prompts,
    store,
    calls: client.calls,
    rowsLeft: (id: string) => (store.get(id) ?? []).length,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions shared by all four tools
// ---------------------------------------------------------------------------

const deletes = (calls: readonly StubCall[]) =>
  calls.filter((c) => c.method === 'DELETE' && ITEMS_PATH.test(c.path));

/**
 * Rows removed by the DELETEs the client actually received.
 *
 * This is derived from the WRITE, not from a plan or a constant — which is the
 * whole point: the prompt has to name this number, and a test that recomputed
 * its expectation from the same field the code used would prove nothing.
 */
function deletedRowCount(calls: readonly StubCall[]): number {
  let n = 0;
  for (const call of deletes(calls)) {
    const tracks = (call.arg as { tracks?: Array<{ positions?: unknown }> })?.tracks ?? [];
    for (const t of tracks) n += Array.isArray(t.positions) && t.positions.length > 0 ? t.positions.length : 1;
  }
  return n;
}

/**
 * The one assertion with real teeth against #803: the number the prompt names
 * must be the number of rows the write removes.
 */
function promptNamesTheDeletedCount(prompts: string[], calls: readonly StubCall[], label: string): void {
  assert.equal(prompts.length, 1, `${label}: expected exactly one prompt`);
  const written = deletedRowCount(calls);
  assert.ok(written > 0, `${label}: the accepted write must have deleted rows, or this proves nothing`);
  assert.match(
    prompts[0]!,
    new RegExp(`\\b${written}\\b`),
    `${label}: the prompt must name the ${written} row(s) the write actually removes`,
  );
}

const textOf = (out: ToolOut) => out.content.map((c) => c.text).join('\n');
const sc = (out: ToolOut) => out.structuredContent as Record<string, unknown>;

// ---------------------------------------------------------------------------
// The four tools, each with the four arms
// ---------------------------------------------------------------------------

/** A fixture plus the arguments that commit exactly `removals` rows. */
interface Scenario {
  label: string;
  tool: string;
  threshold: number;
  build: (rows: number) => { playlists: PlaylistState[]; args: Record<string, unknown> };
}

const SCENARIOS: Scenario[] = [
  {
    label: 'remove_playlist_range',
    tool: 'remove_playlist_range',
    threshold: REMOVE_AT,
    build: (removals) => ({
      playlists: [{ id: PL_RANGE, name: 'Range', items: distinctRows(removals + 5) }],
      args: { playlist_id: PL_RANGE, start: 0, end: removals, dry_run: false, response_format: 'json' },
    }),
  },
  {
    label: 'move_tracks_between_playlists',
    tool: 'move_tracks_between_playlists',
    threshold: MOVE_AT,
    build: (removals) => ({
      playlists: [
        { id: PL_SRC, name: 'Source', items: distinctRows(removals) },
        { id: PL_DST, name: 'Dest', items: distinctRows(2) },
      ],
      args: {
        source_playlist_id: PL_SRC,
        destination_playlist_id: PL_DST,
        match_uris: distinctRows(removals).map((r) => r.item!.uri),
        dry_run: false,
        response_format: 'json',
      },
    }),
  },
  {
    label: 'balance_playlist_pairs',
    tool: 'balance_playlist_pairs',
    threshold: MOVE_AT,
    build: (removals) => {
      // A donor of `2 * removals` rows against an empty receiver balances to
      // floor(2n / 2) = n, so the surplus — the number of rows actually
      // deleted — is exactly `removals`.
      const size = removals * 2;
      return {
        playlists: [
          { id: PL_BIG, name: 'Big', items: distinctRows(size) },
          { id: PL_SMALL, name: 'Small', items: [] },
        ],
        args: { playlists: [PL_BIG, PL_SMALL], dry_run: false, response_format: 'json' },
      };
    },
  },
  {
    label: 'playlist_exclude_artists',
    tool: 'playlist_exclude_artists',
    threshold: REMOVE_AT,
    build: (removals) => ({
      playlists: [{ id: PL_RANGE, name: 'Purge', items: oneArtistRows(removals) }],
      args: { playlist_id: PL_RANGE, artist_ids: ['Artist 0'], dry_run: false, response_format: 'json' },
    }),
  },
];

/** The playlist a scenario deletes from — the one whose rows must not move. */
const SOURCE_OF: Record<string, string> = {
  remove_playlist_range: PL_RANGE,
  move_tracks_between_playlists: PL_SRC,
  balance_playlist_pairs: PL_BIG,
  playlist_exclude_artists: PL_RANGE,
};

for (const scenario of SCENARIOS) {
  describe(`#1568 ${scenario.label} confirmation gate`, () => {
    const run = (removals: number, elicit?: unknown) => {
      const { playlists, args } = scenario.build(removals);
      const h = harness(playlists, elicit);
      return { h, args };
    };

    it('prompts at the threshold and names the count it will delete', async () => {
      const { h, args } = run(scenario.threshold, ACCEPT);
      await h.invoke(scenario.tool, args);
      promptNamesTheDeletedCount(h.prompts, h.calls, scenario.label);
    });

    it('prompts above the threshold too', async () => {
      const { h, args } = run(scenario.threshold * 2, ACCEPT);
      await h.invoke(scenario.tool, args);
      promptNamesTheDeletedCount(h.prompts, h.calls, `${scenario.label} (over threshold)`);
    });

    it('a count below the threshold commits without prompting', async () => {
      const below = scenario.threshold - 1;
      const { h, args } = run(below, ACCEPT);
      const out = await h.invoke(scenario.tool, args);
      assert.equal(h.prompts.length, 0, 'below the threshold there is nothing to ask about');
      assert.equal(
        deletedRowCount(h.calls),
        below,
        'a small commit must still land — the gate must not turn small removals into no-ops',
      );
      assert.notEqual(sc(out).cancelled, true, 'an unprompted small commit is not a cancellation');
    });

    it('a DECLINED prompt refuses with zero DELETEs', async () => {
      const { h, args } = run(scenario.threshold, DECLINE);
      const source = SOURCE_OF[scenario.tool]!;
      const before = [...(h.store.get(source) ?? [])];
      const out = await h.invoke(scenario.tool, args);

      assert.equal(deletes(h.calls).length, 0, 'a decline must stop every DELETE');
      assert.equal(h.prompts.length, 1, 'the prompt must actually have been shown');
      assert.deepEqual(
        [...(h.store.get(source) ?? [])],
        before,
        'nothing was removed from the source playlist either',
      );
      assert.equal(sc(out).ok, false);
      assert.equal(sc(out).cancelled, true);
      assert.match(textOf(out), /Cancelled/i);
    });

    it('a host that CANNOT prompt refuses with zero DELETEs', async () => {
      // No elicitation capability advertised at all: the fail-closed case.
      const { h, args } = run(scenario.threshold);
      const out = await h.invoke(scenario.tool, args);

      assert.equal(h.prompts.length, 0, 'an unpromptable host is never prompted');
      assert.equal(deletes(h.calls).length, 0, 'an unpromptable host must get zero DELETEs');
      assert.equal(sc(out).ok, false);
      assert.equal(sc(out).cancelled, true);
      assert.equal(sc(out).reason, 'confirmation_unavailable');
    });

    it('a prompt that THROWS mid-flight refuses with zero DELETEs (#684)', async () => {
      const { h, args } = run(scenario.threshold, new Error('wire died'));
      const out = await h.invoke(scenario.tool, args);

      assert.equal(deletes(h.calls).length, 0, 'a dead gate must not become an ungated write');
      assert.equal(sc(out).ok, false);
      assert.equal(sc(out).cancelled, true);
      assert.equal(sc(out).reason, 'elicitation_failed');
    });

    it('a malformed elicitation result is a refusal, never an accept', async () => {
      // `isElicitResult` rejects anything without an `action`: a host that
      // answers with an unrecognised shape has not said yes.
      const { h, args } = run(scenario.threshold, { content: { confirm: true } });
      const out = await h.invoke(scenario.tool, args);
      assert.equal(deletes(h.calls).length, 0);
      assert.equal(sc(out).cancelled, true);
    });

    it('every refusal arm classifies the same way — a result, never a throw', async () => {
      // AGENTS.md §5: failing to establish confirmation is a result carrying a
      // `reason`, not an exception. Each arm runs through the real handler, so
      // this cannot pass by asserting a shape the handler never produces.
      const arms: Array<{ label: string; elicit: unknown; reason: unknown }> = [
        { label: 'declined', elicit: DECLINE, reason: undefined },
        { label: 'unsupported (cannot prompt)', elicit: undefined, reason: 'confirmation_unavailable' },
        { label: 'error (prompt threw)', elicit: new Error('boom'), reason: 'elicitation_failed' },
      ];
      for (const arm of arms) {
        const { h, args } = run(scenario.threshold, arm.elicit);
        const out = await h.invoke(scenario.tool, args); // a throw here fails the test
        assert.equal(sc(out).ok, false, `${scenario.label}/${arm.label}: ok must be false`);
        assert.equal(sc(out).cancelled, true, `${scenario.label}/${arm.label}: cancelled must be true`);
        assert.equal(sc(out).reason, arm.reason, `${scenario.label}/${arm.label}: reason must match the contract`);
        assert.equal(deletes(h.calls).length, 0, `${scenario.label}/${arm.label}: must stop the write`);
      }
    });

    it('SPOTIFY_MCP_CONFIRM=never is the only bypass, and only as exactly "never"', async () => {
      process.env.SPOTIFY_MCP_CONFIRM = 'never';
      const never = run(scenario.threshold); // still cannot prompt
      await never.h.invoke(scenario.tool, never.args);
      assert.equal(never.h.prompts.length, 0, 'the bypass must not prompt');
      assert.ok(
        deletedRowCount(never.h.calls) > 0,
        'the documented automation bypass still commits',
      );

      // A near-miss is not the bypass: anything else must still fail closed.
      process.env.SPOTIFY_MCP_CONFIRM = 'no';
      const other = run(scenario.threshold);
      const refused = await other.h.invoke(scenario.tool, other.args);
      assert.equal(deletes(other.h.calls).length, 0, 'only the exact value "never" bypasses the gate');
      assert.equal(sc(refused).reason, 'confirmation_unavailable');
    });

    it('an omitted dry_run still previews: no prompt, no DELETE', async () => {
      // The gate is not a default change: an omitted flag is still a plan.
      const { playlists, args } = scenario.build(scenario.threshold * 3);
      const { dry_run, ...omitted } = args;
      assert.equal(dry_run, false, 'the scenario must actually be a commit');
      const h = harness(playlists, ACCEPT);
      const out = await h.invoke(scenario.tool, omitted);

      assert.equal(h.prompts.length, 0, 'a preview asks nothing');
      assert.equal(deletes(h.calls).length, 0, 'a preview writes nothing');
      assert.equal(sc(out).dry_run, true);
    });
  });
}

// ---------------------------------------------------------------------------
// The thresholds themselves, and the record the fix rests on
// ---------------------------------------------------------------------------

describe('#1568 threshold constants', () => {
  it('the removal tools use the shared REMOVE threshold, unchanged at 10', () => {
    assert.equal(REMOVE_ELICIT_THRESHOLD, REMOVE_AT);
  });

  it('the move tools reuse the existing MOVE threshold, unchanged at 50', () => {
    // The issue's point: `move_tracks_between_playlists` and
    // `balance_playlist_pairs` are the move family by name and by operation,
    // so they take playlistbatch's number rather than a second one that could
    // drift. If this ever fails, a new constant was introduced.
    assert.equal(MOVE_ELICIT_THRESHOLD, MOVE_AT);
  });
});

describe('#1568 the gates are present in the source', () => {
  // Handler-level tests can all pass while a future edit deletes the gate and
  // a different code path takes over. This reads the source so the gate cannot
  // be quietly removed — the same guard #1544 used.
  const SRC = fileURLToPath(new URL('..', import.meta.url));
  const read = (p: string) => readFileSync(new URL(p, `file://${SRC}`), 'utf8');

  const cases: Array<{ file: string; tool: string; threshold: string }> = [
    { file: 'src/tools/swarm3_playlistops.ts', tool: 'remove_playlist_range', threshold: 'REMOVE_ELICIT_THRESHOLD' },
    { file: 'src/tools/exhaust2_playlists.ts', tool: 'playlist_exclude_artists', threshold: 'REMOVE_ELICIT_THRESHOLD' },
    { file: 'src/tools/swarm3_playlistops.ts', tool: 'move_tracks_between_playlists', threshold: 'MOVE_ELICIT_THRESHOLD' },
    { file: 'src/tools/swarm3_playlistops.ts', tool: 'balance_playlist_pairs', threshold: 'MOVE_ELICIT_THRESHOLD' },
  ];

  for (const { file, tool, threshold } of cases) {
    it(`${tool} gates on ${threshold} via the shared fail-closed guard`, () => {
      const src = read(file);
      // Slice the tool's own registration so the assertion is about THIS
      // handler and not about a neighbour that happens to share the file.
      const at = src.indexOf(`'${tool}'`);
      assert.ok(at > 0, `${tool} should be registered in ${file}`);
      const next = src.indexOf("server.tool(\n    '", at + 1);
      const body = src.slice(at, next > 0 ? next : src.length);

      assert.match(body, /confirmViaElicitation\(/, `${tool} must ask through elicitation`);
      assert.match(
        body,
        /requiredConfirmationRefusal\(/,
        `${tool} must route through the shared fail-closed guard, not a hand-rolled branch`,
      );
      assert.match(body, new RegExp(threshold), `${tool} must gate on ${threshold}`);
      assert.doesNotMatch(
        body,
        /SPOTIFY_MCP_CONFIRM/,
        `${tool} must not re-implement the bypass; confirm.ts owns that decision`,
      );
    });
  }
});
