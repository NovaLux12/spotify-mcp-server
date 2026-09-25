/**
 * Curated local Spotify-reference tools (#915).
 *
 * All parsing delegates to the single policy in ../refs.js. These tools make
 * no Spotify API calls; their purpose is inspection and canonicalisation.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat } from '../shaping.js';
import {
  classifySpotifyReference,
  SPOTIFY_REFERENCE_KINDS,
  spotifyUri,
  type SpotifyReferenceClassification,
  type SpotifyReferenceKind,
} from '../refs.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function result(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function parse(input: string, expectedKind?: SpotifyReferenceKind): SpotifyReferenceClassification {
  return classifySpotifyReference(input, expectedKind);
}

function canonical(input: string, expectedKind?: SpotifyReferenceKind): string | null {
  return spotifyUri(input, expectedKind);
}

function census(rows: SpotifyReferenceClassification[], groupBy: 'form' | 'kind'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = groupBy === 'form' ? row.form : row.kind ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Register the six non-redundant local reference tools. */
export function registerSwarm3RefsTools(server: McpServer, _client: SpotifyClient): void {
  server.tool(
    'parse_spotify_uri',
    'Parse and validate one Spotify ID, spotify: URI, spotify:// link, or official open.spotify.com share URL using the same policy as entity-id tools.',
    {
      uri: z.string().min(1).describe('Spotify reference to parse'),
      expected_kind: z.enum(SPOTIFY_REFERENCE_KINDS).optional().describe('Require this entity kind'),
      response_format: ResponseFormat,
    },
    { readOnlyHint: true, idempotentHint: true },
    async (args) => {
      const parsed = parse(args.uri, args.expected_kind);
      return result({
        input: parsed.input,
        form: parsed.form,
        kind: parsed.kind,
        id: parsed.id,
        valid: parsed.valid,
        canonical_uri: parsed.valid && parsed.kind && parsed.id ? `spotify:${parsed.kind}:${parsed.id}` : null,
        error: parsed.error,
      });
    },
  );

  server.tool(
    'parse_spotify_uris',
    'Parse and validate up to 500 Spotify references using the shared single-source policy.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('Spotify references to parse'),
      expected_kind: z.enum(SPOTIFY_REFERENCE_KINDS).optional().describe('Require this entity kind for every reference'),
      response_format: ResponseFormat,
    },
    { readOnlyHint: true, idempotentHint: true },
    async (args) => {
      const rows = args.uris.map((uri) => {
        const parsed = parse(uri, args.expected_kind);
        return {
          input: parsed.input,
          form: parsed.form,
          kind: parsed.kind,
          id: parsed.id,
          valid: parsed.valid,
          canonical_uri: parsed.valid && parsed.kind && parsed.id ? `spotify:${parsed.kind}:${parsed.id}` : null,
          error: parsed.error,
        };
      });
      return result({
        count: rows.length,
        valid: rows.filter((row) => row.valid).length,
        invalid: rows.filter((row) => !row.valid).length,
        results: rows,
      });
    },
  );

  server.tool(
    'format_spotify_uri',
    'Validate an entity kind and Spotify ID pair, then format its canonical spotify: URI.',
    {
      kind: z.enum(SPOTIFY_REFERENCE_KINDS).describe('Spotify entity kind'),
      id: z.string().min(1).describe('Spotify ID (exactly 22 Base62 characters for catalog kinds; user IDs may be non-fixed)'),
      response_format: ResponseFormat,
    },
    { readOnlyHint: true, idempotentHint: true },
    async (args) => {
      const canonicalUri = canonical(`spotify:${args.kind}:${args.id}`, args.kind);
      const error = canonicalUri
        ? null
        : `invalid Spotify ${args.kind} ID: expected ${args.kind === 'user' ? 'one or more URL-safe' : 'exactly 22 base62'} characters`;
      return result({ kind: args.kind, id: args.id, canonical_uri: canonicalUri, valid: canonicalUri !== null, error });
    },
  );

  server.tool(
    'canonicalize_spotify_uri',
    'Canonicalise up to 500 equivalent Spotify IDs, URIs, links, and official share URLs to spotify:<kind>:<id>.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('Spotify references to canonicalise'),
      expected_kind: z.enum(SPOTIFY_REFERENCE_KINDS).optional().describe('Kind used to canonicalise bare IDs'),
      response_format: ResponseFormat,
    },
    { readOnlyHint: true, idempotentHint: true },
    async (args) => {
      const rows = args.uris.map((input) => {
        const canonicalUri = canonical(input, args.expected_kind);
        return { input, canonical_uri: canonicalUri, valid: canonicalUri !== null };
      });
      return result({ count: rows.length, rows });
    },
  );

  server.tool(
    'dedupe_spotify_uris',
    'Deduplicate equivalent Spotify references by canonical URI, preserving first-seen order and retaining invalid inputs as distinct entries.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('Spotify references to deduplicate'),
      expected_kind: z.enum(SPOTIFY_REFERENCE_KINDS).optional().describe('Kind used to interpret bare IDs; typed references retain their own kind'),
      response_format: ResponseFormat,
    },
    { readOnlyHint: true, idempotentHint: true },
    async (args) => {
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const input of args.uris) {
        const parsed = parse(input, args.expected_kind);
        const key = parsed.valid && parsed.id
          ? parsed.kind ? `valid:${parsed.kind}:${parsed.id}` : `untyped:${parsed.id}`
          : `invalid:${input}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(parsed.valid ? input.trim() : input);
        }
      }
      return result({ count_in: args.uris.length, count_out: unique.length, duplicates_removed: args.uris.length - unique.length, unique });
    },
  );

  server.tool(
    'spotify_uri_stats',
    'Summarise Spotify references by validity, form, or entity kind using the shared parser.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('Spotify references to profile'),
      group_by: z.enum(['form', 'kind']).default('form').describe('Grouping dimension'),
      expected_kind: z.enum(SPOTIFY_REFERENCE_KINDS).optional().describe('Kind used to interpret bare IDs'),
      response_format: ResponseFormat,
    },
    { readOnlyHint: true, idempotentHint: true },
    async (args) => {
      const rows = args.uris.map((uri) => parse(uri, args.expected_kind));
      return result({
        total: rows.length,
        valid: rows.filter((row) => row.valid).length,
        invalid: rows.filter((row) => !row.valid).length,
        group_by: args.group_by,
        counts: census(rows, args.group_by),
      });
    },
  );
}
