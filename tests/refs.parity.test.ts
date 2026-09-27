/**
 * The reference parity table (#915).
 *
 * #915 found two parsers that disagreed on 4 of 10 inputs: `src/refs.ts`, the
 * policy that actually gates API calls, and the tool advertised as the validity
 * oracle. An agent that validated a reference with `parse_spotify_uri` and then
 * passed it to a resolver-backed tool could get contradictory verdicts about
 * the same string — and the tool that claimed to report validity was the one
 * wrong about the acceptance policy.
 *
 * The collapse to a single parser and the six curated tools are already on
 * `main`; what was missing is the guarantee. This is that guarantee: one table
 * of references, fed to the tool AND to the `spotifyId()` schema an entity-id
 * parameter is actually built from, asserting the two return the same verdict
 * and the same bare id.
 *
 * A parity test that only compared the tool to itself would pass forever. The
 * second column here is the real gate — `spotifyId` is what a tool parameter
 * uses, so a tool that says "valid" for a string the schema rejects is exactly
 * the contradiction #915 is about.
 *
 * Run: npx tsx --test tests/refs.parity.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3RefsTools } from '../src/tools/swarm3_refs.js';
import { spotifyId, type SpotifyReferenceKind } from '../src/refs.js';

const TRACK = '4iV5W9uYEdYUVa79Axb7Rh';
const ARTIST = '1Xyo4uUX8QYMxlN46wg0jX';
const PLAYLIST = '37i9dQZF1DWZeKCadgRdKQ';
const USER = 'jacklee';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Register only the six reference tools and return their handlers. */
function harness(): Map<string, (args: Record<string, unknown>) => Promise<ToolResult>> {
  const registered = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      _annotations: unknown,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  registerSwarm3RefsTools(server, {} as SpotifyClient);
  return registered;
}

const h = harness();

async function parseViaTool(input: string, kind: SpotifyReferenceKind): Promise<{ valid: boolean; id: string | null }> {
  const handler = h.get('parse_spotify_uri');
  assert.ok(handler, 'parse_spotify_uri must be registered');
  const result = await handler({ uri: input, expected_kind: kind, response_format: 'json' });
  const payload = result.structuredContent!;
  return { valid: payload.valid === true, id: (payload.id as string | null) ?? null };
}

/**
 * What an entity-id parameter does with the same input.
 *
 * `spotifyId(kind)` is the schema every resolver-backed parameter is built
 * from, so parsing it here is parsing what a real call will do — including the
 * rejection, which is a validation error the caller sees before any request.
 */
function parseViaSchema(input: string, kind: SpotifyReferenceKind): { valid: boolean; id: string | null } {
  const parsed = spotifyId(kind).safeParse(input);
  if (!parsed.success) return { valid: false, id: null };
  return { valid: true, id: parsed.data };
}

interface Case {
  readonly label: string;
  readonly input: string;
  readonly kind: SpotifyReferenceKind;
}

const CASES: readonly Case[] = [
  { label: 'bare track id', input: TRACK, kind: 'track' },
  { label: 'bare id of a different kind', input: ARTIST, kind: 'track' },
  { label: 'short bare id', input: 'short5', kind: 'track' },
  { label: 'bare user id (non-fixed length)', input: USER, kind: 'track' },
  { label: 'spotify:track URI', input: `spotify:track:${TRACK}`, kind: 'track' },
  { label: 'spotify:artist URI against kind track', input: `spotify:artist:${ARTIST}`, kind: 'track' },
  { label: 'spotify:user URI against kind track', input: `spotify:user:${USER}`, kind: 'track' },
  { label: 'spotify:// link', input: `spotify://track/${TRACK}`, kind: 'track' },
  { label: 'spotify:// link of a different kind', input: `spotify://artist/${ARTIST}`, kind: 'track' },
  { label: 'share URL', input: `https://open.spotify.com/track/${TRACK}`, kind: 'track' },
  { label: 'localised share URL', input: `https://open.spotify.com/intl-de/track/${TRACK}`, kind: 'track' },
  { label: 'share URL with a query', input: `https://open.spotify.com/track/${TRACK}?si=abcdef`, kind: 'track' },
  { label: 'lookalike host', input: `https://open.spotify.com.evil.test/track/${TRACK}`, kind: 'track' },
  { label: 'unrelated host', input: `https://example.com/track/${TRACK}`, kind: 'track' },
  { label: 'empty id', input: 'spotify:track:', kind: 'track' },
  { label: 'unknown kind', input: `spotify:constructor:${TRACK}`, kind: 'track' },
  { label: 'Object.prototype key as a kind', input: `spotify:toString:${TRACK}`, kind: 'track' },
  { label: 'kind mismatch', input: `spotify:playlist:${PLAYLIST}`, kind: 'track' },
  { label: 'prose', input: 'not a reference at all', kind: 'track' },
  { label: 'whitespace', input: '   ', kind: 'track' },
  { label: 'uppercase scheme', input: `SPOTIFY:TRACK:${TRACK}`, kind: 'track' },
  { label: 'trailing slash on a URI', input: `spotify:track:${TRACK}/`, kind: 'track' },
  { label: '21 characters', input: TRACK.slice(0, 21), kind: 'track' },
  { label: '23 characters', input: TRACK + 'x', kind: 'track' },
  { label: 'id containing a dash', input: '4iV5W9uYEdYUVa79Axb-Rh', kind: 'track' },
  { label: 'the matching kind asked for as playlist', input: `spotify:playlist:${PLAYLIST}`, kind: 'playlist' },
  { label: 'a bare id asked for as artist', input: ARTIST, kind: 'artist' },
  { label: 'a user reference asked for as user', input: `spotify:user:${USER}`, kind: 'user' },
];

describe('#915 parse_spotify_uri and the entity-id resolver agree', () => {
  it('the table is big enough to be worth having', () => {
    // The issue asks for 20. A table that shrank to a handful of easy rows
    // would still pass while the disagreement it was written to catch returned
    // in a row nobody thought to add.
    assert.ok(CASES.length >= 20, `the parity table has ${CASES.length} rows; #915 asks for at least 20`);
    assert.ok(
      new Set(CASES.map((c) => c.label)).size === CASES.length,
      'two rows share a label — a failure would be ambiguous about which input caused it',
    );
  });

  it('returns the same verdict and the same bare id for every reference', async () => {
    const disagreements: string[] = [];
    for (const testCase of CASES) {
      const viaTool = await parseViaTool(testCase.input, testCase.kind);
      const viaSchema = parseViaSchema(testCase.input, testCase.kind);
      if (viaTool.valid !== viaSchema.valid) {
        disagreements.push(
          `${testCase.label}: tool says ${viaTool.valid ? 'valid' : 'invalid'}, schema says ${viaSchema.valid ? 'valid' : 'invalid'} `
          + `(input ${JSON.stringify(testCase.input)}, kind ${testCase.kind})`,
        );
        continue;
      }
      if (viaTool.valid && viaTool.id !== viaSchema.id) {
        disagreements.push(
          `${testCase.label}: tool resolved to ${viaTool.id}, schema resolved to ${viaSchema.id}`,
        );
      }
    }
    assert.deepEqual(
      disagreements,
      [],
      'the validity oracle and the resolver disagreed — an agent would get one answer from one and a different one from the other',
    );
  });

  it('accepts all four documented forms and rejects a lookalike host', async () => {
    // Stated separately from the table so the policy the descriptions promise
    // is asserted directly, not only as an agreement between two readers of
    // the same function.
    for (const input of [
      TRACK,
      `spotify:track:${TRACK}`,
      `spotify://track/${TRACK}`,
      `https://open.spotify.com/track/${TRACK}`,
    ]) {
      assert.equal((await parseViaTool(input, 'track')).valid, true, `${input} is a documented form and must parse`);
    }
    assert.equal(
      (await parseViaTool(`https://open.spotify.com.evil.test/track/${TRACK}`, 'track')).valid,
      false,
      'a lookalike host must be rejected — accepting it is how a phishing link reaches the API',
    );
  });

  it('an unknown kind is rejected rather than inherited from Object.prototype', async () => {
    // `KIND_BY_NAME` is a Map, not an object literal, precisely so
    // `spotify:constructor:<id>` cannot resolve. If that ever regresses to a
    // plain object, this row is the one that notices.
    for (const kind of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const result = await parseViaTool(`spotify:${kind}:${TRACK}`, 'track');
      assert.equal(result.valid, false, `spotify:${kind}: must not classify as a valid reference`);
    }
  });
});
