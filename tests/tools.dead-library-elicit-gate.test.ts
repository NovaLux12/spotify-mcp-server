/**
 * #1544: `dead_library_finder`'s commit path is a bulk `/me/library` removal
 * that reaches `modifyLibrary(client, …, 'remove')` with no elicitation.
 *
 * The tool's NAME says "finder", which is what makes this worth a gate rather
 * than a rename: a host or an agent choosing a tool by name would reasonably
 * read `dead_library_finder` as a report. The house invariant is about the
 * SHAPE of the call, not the verb on the tool — `AGENTS.md` §5 gates destructive
 * bulk mutations, and `REMOVE_ELICIT_THRESHOLD` is the bar for exactly this one
 * (`DELETE /me/library` per candidate, bounded by `fetchAllCap`, not by anything
 * the caller chose). So the fix is the gate, and the shape is the one every
 * other removal in the server already uses: count-threshold, then
 * `confirmViaElicitation` → `requiredConfirmationRefusal`.
 *
 * `dry_run` defaults to true and short-circuits BEFORE any read (#896), so the
 * previews here assert that the gate does not change: an omitted flag still
 * costs zero requests and still asks nothing.
 *
 * The fail-closed arms are asserted individually, and the structural guard at
 * the bottom reads the source so a future edit cannot quietly delete the gate
 * while leaving these handler-level tests passing.
 *
 * Hermetic: imports the home helper before any server code.
 */

import './helpers/hermetic.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerExhaust2MiscTools } from '../src/tools/exhaust2_misc.js';
import { classifyToolAnnotations } from '../src/tools/annotations.js';
import { REMOVE_ELICIT_THRESHOLD } from '../src/tools/confirm.js';
import { readFileSync } from 'node:fs';

// Every sidecar the module owns must land in a throwaway dir, not a real home.
const TMP = mkdtempSync(join(tmpdir(), 'dead-library-gate-'));
process.env.SPOTIFY_MCP_EXHAUST2_MISC_FILE = join(TMP, 'exhaust2-misc.json');
process.env.SPOTIFY_MCP_GENRE_TAGS_FILE = join(TMP, 'genre-tags.json');
process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = join(TMP, 'playback-ext.json');
process.env.SPOTIFY_MCP_SCENES_FILE = join(TMP, 'scenes.json');

// SPOTIFY_MCP_CONFIRM=never turns every verdict into "unsupported, proceed",
// which would silently reopen the unpromptable-host arm below. Every suite that
// exercises a gate clears it in afterEach; so does this one.
afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

const ACCEPT = { action: 'accept', content: { confirm: true } };
const DECLINE = { action: 'decline' };

interface ToolOut {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

interface Registered {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
}

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
}

/** Build `count` saved tracks that qualify as dead: old, never played, no playlist. */
function deadTracks(count: number): Array<{ added_at: string; track: { uri: string; name: string } }> {
  return Array.from({ length: count }, (_, i) => ({
    added_at: '2020-01-01T00:00:00Z',
    track: { uri: `spotify:track:dead${i}`, name: `Dead ${i}` },
  }));
}

interface Harness {
  elicitCalls: Array<{ message: string }>;
  calls: Call[];
  invoke: (args: Record<string, unknown>) => Promise<ToolOut>;
}

/**
 * `elicit` omitted → the host advertises NO elicitation capability, which is
 * the fail-closed case. An Error instance → the prompt is attempted and fails
 * on the wire (#684). Otherwise the value is the verdict `elicitInput`
 * resolves to.
 */
function harness(savedCount: number, elicit?: unknown): Harness {
  const registered: Registered[] = [];
  const elicitCalls: Array<{ message: string }> = [];
  const calls: Call[] = [];

  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    ...(elicit !== undefined
      ? {
          // Real McpServer shape: the capability accessor and `elicitInput`
          // both live on the inner Server exposed as `.server`.
          server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            async elicitInput(request: { message?: string }) {
              elicitCalls.push({ message: request?.message ?? '' });
              if (elicit instanceof Error) throw elicit;
              return elicit;
            },
          },
        }
      : {}),
  } as unknown as McpServer;

  const client = {
    tokenFile: join(TMP, 'tokens.json'),
    get: async (path: string) => {
      calls.push({ method: 'GET', path });
      return path.includes('recently-played') ? { items: [], next: null } : null;
    },
    getAllPages: async (path: string) => {
      calls.push({ method: 'GET', path });
      if (path.startsWith('/me/tracks')) return deadTracks(savedCount);
      if (path === '/me/playlists') return [];
      return [];
    },
    put: async (path: string) => {
      calls.push({ method: 'PUT', path });
      return null;
    },
    post: async (path: string) => {
      calls.push({ method: 'POST', path });
      return null;
    },
    delete: async (path: string) => {
      calls.push({ method: 'DELETE', path });
      return null;
    },
    getRateLimitStatus: () => ({ cooldownRemainingMs: 0, lastThrottleAt: null, retryAfterSec: null }),
  } as unknown as SpotifyClient;

  registerExhaust2MiscTools(fakeServer, client);

  const tool = registered.find((t) => t.name === 'dead_library_finder');
  assert.ok(tool, 'dead_library_finder must be registered');

  return {
    elicitCalls,
    calls,
    invoke: async (args) => tool.handler(tool.validate(args)),
  };
}

const textOf = (out: ToolOut) => out.content[0].text;
const deletesOf = (h: Harness) => h.calls.filter((c) => c.method === 'DELETE');
const libraryDeletes = (h: Harness) =>
  deletesOf(h).filter((c) => c.path.startsWith('/me/library'));

/** The commit path, i.e. the branch that actually reaches the write. */
const COMMIT = { min_age_days: 30, dry_run: false, response_format: 'concise' as const };

describe('#1544 dead_library_finder removal elicitation gate', () => {
  // -------------------------------------------------------------------------
  // The gate exists at all.
  // -------------------------------------------------------------------------

  it('prompts once and removes only on accept, naming the count it found', async () => {
    const h = harness(REMOVE_ELICIT_THRESHOLD, ACCEPT);
    const out = await h.invoke(COMMIT);

    assert.equal(h.elicitCalls.length, 1, 'a removal of threshold size must ask exactly once');
    // The prompt has to be answerable: the scan already ran, so the count is
    // known and must appear in the question.
    assert.match(
      h.elicitCalls[0].message,
      new RegExp(`\\b${REMOVE_ELICIT_THRESHOLD}\\b`),
      'the prompt must name how many tracks are about to be unsaved',
    );
    assert.match(h.elicitCalls[0].message, /unsave/i);

    // `library_writes` chunks at 40, so 10 candidates is one DELETE.
    assert.equal(libraryDeletes(h).length, 1);
    assert.equal((out.structuredContent as { removed?: number }).removed, REMOVE_ELICIT_THRESHOLD);
  });

  it('a candidate count below the threshold proceeds unprompted', async () => {
    // The other side of the threshold: gating must not make small libraries
    // prompt, or the constant stops meaning what AGENTS.md says it means.
    const below = REMOVE_ELICIT_THRESHOLD - 1;
    const h = harness(below, ACCEPT);
    const out = await h.invoke(COMMIT);

    assert.equal(h.elicitCalls.length, 0, 'below the threshold there is nothing to ask about');
    assert.equal(libraryDeletes(h).length, 1);
    assert.equal((out.structuredContent as { removed?: number }).removed, below);
  });

  // -------------------------------------------------------------------------
  // Fail-closed arms. Each one must produce ZERO library writes.
  // -------------------------------------------------------------------------

  it('a host that cannot prompt is a REFUSAL, not a silent proceed', async () => {
    const h = harness(REMOVE_ELICIT_THRESHOLD); // no elicitation capability at all
    const out = await h.invoke(COMMIT);

    assert.equal(libraryDeletes(h).length, 0, 'an unpromptable host must get zero deletes');
    assert.equal(h.elicitCalls.length, 0);
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.ok, false);
    assert.equal(sc.cancelled, true);
    assert.equal(sc.reason, 'confirmation_unavailable');
  });

  it('a prompt that throws mid-flight is a REFUSAL', async () => {
    const h = harness(REMOVE_ELICIT_THRESHOLD, new Error('wire died'));
    const out = await h.invoke(COMMIT);

    assert.equal(libraryDeletes(h).length, 0, 'a dead gate must not become an ungated write (#684)');
    const sc = out.structuredContent as Record<string, unknown>;
    assert.equal(sc.ok, false);
    assert.equal(sc.cancelled, true);
    assert.equal(sc.reason, 'elicitation_failed');
  });

  it('every refusal arm classifies the same way — a result, never a throw', async () => {
    // AGENTS.md §5 and SPEC §Confirmation-refusal payload contract: a failure to
    // establish confirmation is a result carrying a `reason`, not an exception.
    // Each arm is driven through the real handler so this cannot pass by
    // asserting a shape the handler never produces.
    const arms: Array<{ label: string; elicit: unknown; reason: string | undefined }> = [
      { label: 'declined', elicit: DECLINE, reason: undefined },
      { label: 'unsupported (cannot prompt)', elicit: undefined, reason: 'confirmation_unavailable' },
      { label: 'error (prompt threw)', elicit: new Error('boom'), reason: 'elicitation_failed' },
    ];

    for (const arm of arms) {
      const h = harness(REMOVE_ELICIT_THRESHOLD, arm.elicit);
      const out = await h.invoke(COMMIT); // a throw here fails the test
      const sc = out.structuredContent as Record<string, unknown>;

      assert.equal(sc.ok, false, `${arm.label}: ok must be false`);
      assert.equal(sc.cancelled, true, `${arm.label}: cancelled must be true`);
      assert.equal(sc.reason, arm.reason, `${arm.label}: reason must match the contract table`);
      assert.equal(
        libraryDeletes(h).length,
        0,
        `${arm.label}: every refusal arm must stop the write`,
      );
      assert.equal(out.structuredContent?.removed, undefined, `${arm.label}: nothing was removed`);
    }
  });

  it('a malformed elicitation result is a refusal, never an accept', async () => {
    // `isElicitResult` rejects anything without an `action`; a host that
    // answers with an unrecognised shape has not said yes.
    const h = harness(REMOVE_ELICIT_THRESHOLD, { content: { confirm: true } });
    const out = await h.invoke(COMMIT);

    assert.equal(libraryDeletes(h).length, 0);
    assert.equal((out.structuredContent as Record<string, unknown>).cancelled, true);
  });

  it('SPOTIFY_MCP_CONFIRM=never is the only bypass, and it must be exactly "never"', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const never = harness(REMOVE_ELICIT_THRESHOLD); // still cannot prompt
    const out = await never.invoke(COMMIT);
    assert.equal(never.elicitCalls.length, 0, 'the bypass must not prompt');
    assert.equal(libraryDeletes(never).length, 1, 'the documented automation bypass still writes');
    assert.equal((out.structuredContent as { removed?: number }).removed, REMOVE_ELICIT_THRESHOLD);

    // Anything else is not the bypass: a near-miss must still fail closed.
    process.env.SPOTIFY_MCP_CONFIRM = 'no';
    const other = harness(REMOVE_ELICIT_THRESHOLD);
    const refused = await other.invoke(COMMIT);
    assert.equal(libraryDeletes(other).length, 0, 'only the exact value "never" bypasses the gate');
    assert.equal(
      (refused.structuredContent as Record<string, unknown>).reason,
      'confirmation_unavailable',
    );
  });

  // -------------------------------------------------------------------------
  // The gate must not disturb the #896 short-circuit or the dry-run default.
  // -------------------------------------------------------------------------

  it('an omitted dry_run still previews: zero requests, zero prompts', async () => {
    const h = harness(REMOVE_ELICIT_THRESHOLD * 3, ACCEPT);
    const out = await h.invoke({ min_age_days: 30, response_format: 'concise' });

    assert.equal(h.calls.length, 0, 'the dry run must not walk /me/tracks or /me/playlists');
    assert.equal(libraryDeletes(h).length, 0);
    assert.equal(h.elicitCalls.length, 0, 'a preview asks nothing');
    assert.match(textOf(out), /\[dry run\]/);
  });

  it('an explicit dry_run:false reaches the scan and then the gate', async () => {
    const h = harness(REMOVE_ELICIT_THRESHOLD, DECLINE);
    await h.invoke(COMMIT);

    assert.ok(
      h.calls.some((c) => c.path.startsWith('/me/tracks')),
      'the committing path must still scan — the prompt comes after the scan, not instead of it',
    );
  });

  // -------------------------------------------------------------------------
  // Annotations: orthogonal to the gate, and currently stating the opposite of
  // the truth. `dead` matches no entry in either prefix list, so the
  // name-driven fallback hands a tool that deletes the user's library
  // `destructiveHint: false` — the #1100 failure mode.
  // -------------------------------------------------------------------------

  it('the annotation states destructiveHint explicitly', () => {
    const ann = classifyToolAnnotations('dead_library_finder');
    assert.equal(ann.destructiveHint, true, 'a bulk unsave must not be advertised as safe to auto-approve');
    // readOnlyHint stays ABSENT (MCP defaults it false), which is the truth for
    // a write — asserting it is undefined rather than false keeps the row
    // minimal and stops a future edit from also claiming it is a read.
    assert.equal(ann.readOnlyHint, undefined);
  });

  it('the read-only gate still hides it', () => {
    // SPOTIFY_MCP_READONLY hides write-capable tools. A tool whose only signal
    // is destructiveHint: true and no readOnlyHint must not be treated as a
    // read — otherwise the sweep calls a tool that deletes their library.
    const ann = classifyToolAnnotations('dead_library_finder');
    assert.notEqual(ann.readOnlyHint, true, 'must not be classified read-only');
  });

  // -------------------------------------------------------------------------
  // Structural guard: the handler-level tests above all go through the same
  // registration, so a future edit that deletes the gate call AND updates this
  // file's expectations could pass. This reads the source instead.
  // -------------------------------------------------------------------------

  it('the remove branch in the source is gated', () => {
    const src = readFileSync(new URL('../src/tools/exhaust2_misc.ts', import.meta.url), 'utf8');
    const registration = /server\.(?:tool|registerTool)\(\s*\n?\s*'dead_library_finder'/;
    const start = src.search(registration);
    assert.notEqual(start, -1, 'dead_library_finder must still be registered under that name');
    const rest = src.slice(start);
    const next = rest.slice(1).search(/server\.(?:tool|registerTool)\(\s*\n?\s*'/);
    const chunk = next === -1 ? rest : rest.slice(0, next + 1);

    const removeAt = chunk.indexOf("'remove')");
    assert.notEqual(removeAt, -1, 'the commit path must still call modifyLibrary(…, \'remove\')');

    const before = chunk.slice(0, removeAt);
    assert.match(before, /confirmViaElicitation\(/, 'the removal must be preceded by an elicitation');
    assert.match(
      before,
      /requiredConfirmationRefusal\(/,
      'the elicitation verdict must go through the shared fail-closed guard',
    );
    assert.match(
      before,
      /REMOVE_ELICIT_THRESHOLD/,
      'the gate must reuse the existing threshold constant, not a new one',
    );
    // A hand-rolled verdict check would reintroduce the #1237 split.
    assert.equal(
      /if\s*\(\s*verdict\s*===/.test(before),
      false,
      'the verdict must be decided by requiredConfirmationRefusal, not inline',
    );
  });
});
