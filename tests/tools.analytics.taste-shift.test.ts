/**
 * Regressions for src/tools/analytics.ts:
 *   #807 taste_shift_report returned Jaccard 1 when both top windows were
 *         empty, so an account with no listening history at all was reported
 *         as having perfectly stable taste. The number was arithmetic on an
 *         empty union, not a measurement — the same fabrication class as #803
 *         (a failed lookup recorded as `0 streams`).
 *
 * Stub-client harness pattern from tools.analytics.walkbounds.test.ts: a fake
 * McpServer captures registrations, a stub SpotifyClient records wire calls
 * and answers from a responder function.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerAnalyticsTools } from '../src/tools/analytics.js';

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

type Responder = (path: string, params?: Record<string, string>) => unknown;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function harness(responder: Responder) {
  const registered: Array<{
    name: string;
    validate: (args: Record<string, unknown>) => Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  }> = [];
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;

  const client = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      return responder(path, params) as T | null;
    },
  };
  registerAnalyticsTools(fakeServer, client as unknown as SpotifyClient);

  const invoke = async (toolName: string, args: Record<string, unknown> = {}) => {
    const tool = registered.find((t) => t.name === toolName);
    assert.ok(tool, `${toolName} should be registered`);
    return tool.handler(tool.validate(args));
  };
  return { invoke };
}

interface DomainPayload {
  window_sizes: { short_term: number; long_term: number };
  jaccard: number | null;
  rising: string[];
  falling: string[];
}
interface TasteShiftPayload {
  ok: boolean;
  window_sizes: { short_term: number; long_term: number };
  tracks: DomainPayload;
  artists: DomainPayload;
}

const payloadOf = (out: ToolResult) => (out.structuredContent ?? {}) as unknown as TasteShiftPayload;
const textOf = (out: ToolResult) => out.content[0].text;

/** Top lists per path+window. Anything not named returns an empty page, so a
 *  fixture only has to spell out the windows it cares about. */
function topResponder(byRange: Record<'/me/top/tracks' | '/me/top/artists', Record<string, string[]>>) {
  return (path: string, params?: Record<string, string>): unknown => {
    const key = path as '/me/top/tracks' | '/me/top/artists';
    const windows = byRange[key];
    if (!windows) return null;
    const ids = windows[params?.time_range ?? ''] ?? [];
    return {
      items: ids.map((id) => ({ id, name: id })),
      total: ids.length,
      limit: 50,
      offset: 0,
      next: null,
    };
  };
}

// ---------------------------------------------------------------------------
// #807 — an empty taste window is missing data, not a perfect match
// ---------------------------------------------------------------------------

describe('taste_shift_report empty windows (#807)', () => {
  it('reports insufficient history, not Jaccard 1, when every window is empty', async () => {
    // A fresh app registration: Spotify answers 200 with zero items everywhere.
    const { invoke } = harness(topResponder({
      '/me/top/tracks': { short_term: [], long_term: [] },
      '/me/top/artists': { short_term: [], long_term: [] },
    }));

    const out = await invoke('taste_shift_report', {});
    const payload = payloadOf(out);

    assert.equal(payload.tracks.jaccard, null, 'two empty track windows have no similarity to measure');
    assert.equal(payload.artists.jaccard, null, 'two empty artist windows have no similarity to measure');
    assert.equal(payload.window_sizes.short_term, 0);
    assert.equal(payload.window_sizes.long_term, 0);
    assert.equal(payload.tracks.window_sizes.short_term, 0);
    assert.equal(payload.tracks.window_sizes.long_term, 0);
    assert.match(
      textOf(out),
      /insufficient history to compare/,
      'the prose must not read as a stable-taste verdict',
    );
    assert.doesNotMatch(
      textOf(out),
      /Jaccard 1\b/,
      'no branch may print the maximum similarity for windows that hold nothing',
    );
  });

  it('returns 0 — not 1 — when one side of a pair is empty', async () => {
    // Dormant listener: long-term history exists, the short window is gone.
    const { invoke } = harness(topResponder({
      '/me/top/tracks': { short_term: [], long_term: ['t1', 't2'] },
      '/me/top/artists': { short_term: ['a1', 'a2'], long_term: ['a1', 'a2'] },
    }));

    const out = await invoke('taste_shift_report', {});
    const payload = payloadOf(out);

    assert.equal(payload.tracks.jaccard, 0, 'nothing in the populated set is in the empty one');
    assert.equal(payload.tracks.window_sizes.short_term, 0);
    assert.equal(payload.tracks.window_sizes.long_term, 2);
    assert.equal(payload.window_sizes.short_term, 2, 'the total counts the populated short window');
    assert.equal(payload.window_sizes.long_term, 4);
    assert.match(
      textOf(out),
      /insufficient history to compare/,
      'an empty side makes the comparison incomplete even when the other computes',
    );
    assert.match(textOf(out), /tracks Jaccard 0,/, 'the side that did compute still reports its value');
    assert.match(textOf(out), /artists Jaccard 1;/, 'and so does the fully-populated one');
  });

  it('keeps the populated-pairs arithmetic identical to the pre-fix formula', async () => {
    // short_term {t1,t2,t3,t4} vs long_term {t3,t4,t5} → 2/5 = 0.4.
    const { invoke } = harness(topResponder({
      '/me/top/tracks': { short_term: ['t1', 't2', 't3', 't4'], long_term: ['t3', 't4', 't5'] },
      '/me/top/artists': { short_term: ['a1', 'a2', 'a3', 'a4'], long_term: ['a3', 'a4', 'a5'] },
    }));

    const out = await invoke('taste_shift_report', {});
    const payload = payloadOf(out);

    assert.equal(payload.tracks.jaccard, 0.4);
    assert.equal(payload.artists.jaccard, 0.4);
    assert.deepEqual(payload.tracks.rising, ['t1', 't2']);
    assert.deepEqual(payload.tracks.falling, ['t5']);
    assert.equal(payload.window_sizes.short_term, 8);
    assert.equal(payload.window_sizes.long_term, 6);
    assert.match(textOf(out), /tracks Jaccard 0\.4, artists Jaccard 0\.4\./);
    assert.doesNotMatch(textOf(out), /insufficient history/, 'two populated windows need no disclaimer');
  });

  it('reports the same key set on the empty and populated paths', async () => {
    const empty = payloadOf(await harness(topResponder({
      '/me/top/tracks': { short_term: [], long_term: [] },
      '/me/top/artists': { short_term: [], long_term: [] },
    })).invoke('taste_shift_report', {}));
    const populated = payloadOf(await harness(topResponder({
      '/me/top/tracks': { short_term: ['t1', 't2'], long_term: ['t2', 't3'] },
      '/me/top/artists': { short_term: ['a1'], long_term: ['a1'] },
    })).invoke('taste_shift_report', {}));

    assert.deepEqual(Object.keys(empty).sort(), Object.keys(populated).sort());
    assert.deepEqual(Object.keys(empty.tracks).sort(), Object.keys(populated.tracks).sort());
    assert.deepEqual(Object.keys(empty.artists).sort(), Object.keys(populated.artists).sort());
    assert.deepEqual(Object.keys(empty.window_sizes).sort(), Object.keys(populated.window_sizes).sort());
  });

  it('treats a Spotify response of null like an empty window, not a failure', async () => {
    // The stub client answers `null` the way a bodyless/short response would;
    // that is a zero-item read, and the report must say so rather than throw.
    const { invoke } = harness(() => null);

    const out = await invoke('taste_shift_report', {});
    const payload = payloadOf(out);

    assert.equal(payload.tracks.jaccard, null);
    assert.equal(payload.artists.jaccard, null);
    assert.equal(payload.window_sizes.short_term, 0);
    assert.equal(payload.window_sizes.long_term, 0);
    assert.match(textOf(out), /insufficient history to compare/);
  });
});
