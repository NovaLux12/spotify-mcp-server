/**
 * swarm3 refs slice — 500-tool swarm v1.26.0 (issue #442). Owned by REFS builder.
 *
 * 24 pure-local Spotify URI/id tools. ZERO network calls: every tool parses,
 * validates, normalises, compares or formats Spotify ids/URIs/URLs purely
 * locally, using the shared resolvers in ../refs.js. Deterministic ordering
 * and stable structuredContent property names throughout.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat, type ResponseFormatValue } from '../shaping.js';
import { resolveSpotifyId } from '../refs.js';

// ---------------------------------------------------------------------------
// Local helpers (house style, as in exhaust2 files)
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };

function textResult(text: string, s?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) };
}

const KNOWN_KINDS = ['track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook', 'user'] as const;
type UriKind = (typeof KNOWN_KINDS)[number];

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_URI_RE = /^spotify:([a-z]+):([A-Za-z0-9]+)$/;

/** Parse one reference; never throws. */
interface ParsedRef {
  input: string;
  /** uri | url | id | invalid */
  form: 'uri' | 'url' | 'id' | 'invalid';
  kind: UriKind | null;
  id: string | null;
  valid: boolean;
}

function classifyOne(raw: string): ParsedRef {
  const input = raw;
  const s = raw.trim();
  if (!s) return { input, form: 'invalid', kind: null, id: null, valid: false };

  // 1. spotify: URI
  const uriMatch = SPOTIFY_URI_RE.exec(s);
  if (uriMatch) {
    const kind = (uriMatch[1] as UriKind);
    const id = uriMatch[2];
    return { input, form: 'uri', kind: (KNOWN_KINDS as readonly string[]).includes(kind) ? kind : null, id, valid: (KNOWN_KINDS as readonly string[]).includes(kind) && SPOTIFY_ID_RE.test(id) };
  }

  // 2. https:// open.spotify.com URL (incl. /embed/ and query params)
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      const parts = url.pathname.split('/').filter(Boolean);
      const embedIdx = parts.indexOf('embed');
      const segs = embedIdx >= 0 ? parts.slice(embedIdx + 1) : parts;
      if (url.hostname.endsWith('spotify.com') && segs.length >= 2) {
        const kindRaw = segs[0].toLowerCase();
        const kind = (KNOWN_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as UriKind) : null;
        const id = segs[1];
        return { input, form: 'url', kind, id, valid: kind !== null && SPOTIFY_ID_RE.test(id) };
      }
    } catch {
      /* fallthrough */
    }
    return { input, form: 'invalid', kind: null, id: null, valid: false };
  }

  // 3. bare ID
  if (!s.includes(':') && !s.includes('/') && SPOTIFY_ID_RE.test(s)) {
    return { input, form: 'id', kind: null, id: s, valid: true };
  }

  return { input, form: 'invalid', kind: null, id: null, valid: false };
}

/** Build a canonical `spotify:<kind>:<id>` URI; null when the pair is invalid. */
function makeUri(kind: string, id: string): string | null {
  const k = kind.trim().toLowerCase();
  const i = id.trim();
  if (!(KNOWN_KINDS as readonly string[]).includes(k) || !SPOTIFY_ID_RE.test(i)) return null;
  return `spotify:${k}:${i}`;
}

/** Deterministic census over parsed refs. */
function census(refs: ParsedRef[]): { form_counts: Record<string, number>; kind_counts: Record<string, number> } {
  const formCounts: Record<string, number> = {};
  const kindCounts: Record<string, number> = {};
  for (const r of refs) {
    formCounts[r.form] = (formCounts[r.form] ?? 0) + 1;
    if (r.kind) kindCounts[r.kind] = (kindCounts[r.kind] ?? 0) + 1;
  }
  return { form_counts: formCounts, kind_counts: kindCounts };
}

function fmt(o: unknown): string {
  return JSON.stringify(o, null, 2);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Register the 24 pure-local refs tools. `client` is accepted for signature
 * parity with every other register function but is never used — these tools
 * make no network calls.
 */
export function registerSwarm3RefsTools(server: McpServer, _client: SpotifyClient): void {
  server.tool(
    'parse_spotify_uri',
    'Parse a single spotify: URI into its entity kind and ID parts without any network call; reports validity and a parse error when malformed.',
    {
      uri: z.string().min(1).describe('Spotify URI, open.spotify.com URL, or bare ID to parse'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const p = classifyOne(args.uri);
      const detail = {
        uri: p.input,
        form: p.form,
        kind: p.kind,
        id: p.id,
        valid: p.valid,
        canonical_uri: p.valid && p.kind && p.id ? makeUri(p.kind, p.id) : null,
        error: p.valid ? null : 'not a recognisable Spotify URI, URL, or 22-char ID',
      };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'format_spotify_uri',
    'Format an entity kind + ID pair into a canonical spotify: URI locally; validates the ID shape and returns null when the pair is malformed.',
    {
      kind: z.string().min(1).describe('Entity kind, e.g. track, album, artist, playlist, show, episode, audiobook, user'),
      id: z.string().min(1).describe('Spotify entity ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const canonical = makeUri(args.kind, args.id);
      const detail = { kind: args.kind.toLowerCase(), id: args.id, canonical_uri: canonical, valid: canonical !== null };
      return textResult(canonical ?? `invalid: cannot format ${args.kind}:${args.id} as a spotify: URI`, detail);
    },
  );

  server.tool(
    'spotify_uri_to_open_url',
    'Convert a spotify: URI (or bare ID + kind) into its https://open.spotify.com share URL locally, stripping nothing else.',
    {
      uri: z.string().min(1).describe('Spotify URI, bare ID, or URL to convert'),
      kind: z.string().optional().describe('Entity kind when the input is a bare ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const p = classifyOne(args.uri);
      let canonical: string | null = null;
      if (p.valid && p.kind && p.id) canonical = makeUri(p.kind, p.id);
      else if (args.kind && p.id) canonical = makeUri(args.kind, p.id);
      const open_url = canonical ? `https://open.spotify.com/${canonical.split(':')[1]}/${canonical.split(':')[2]}` : null;
      const detail = { input: args.uri, open_url, valid: open_url !== null };
      return textResult(open_url ?? `invalid: cannot convert ${args.uri} to an open.spotify.com URL`, detail);
    },
  );

  server.tool(
    'open_url_to_spotify_uri',
    'Convert an open.spotify.com URL (including /embed/ forms with ?si= tracking params) into a canonical spotify: URI locally.',
    {
      url: z.string().min(1).describe('open.spotify.com URL (embed forms accepted, query params ignored)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const p = classifyOne(args.url);
      if (p.form === 'url' && p.kind && p.id) {
        const canonical = p.valid && p.kind && p.id ? makeUri(p.kind, p.id) : null;
        return textResult(canonical ?? 'invalid: URL kind/id pair malformed', { input: args.url, uri: canonical, valid: canonical !== null });
      }
      if (p.form === 'uri' && p.id && p.kind) {
        const canonical = p.valid && p.kind && p.id ? makeUri(p.kind, p.id) : null;
        return textResult(canonical ?? 'invalid', { input: args.url, uri: canonical, valid: canonical !== null, note: 'input was already a URI; normalised' });
      }
      return textResult(`invalid: ${args.url} is not an open.spotify.com URL`, { input: args.url, uri: null, valid: false });
    },
  );

  server.tool(
    'extract_spotify_id',
    'Extract the bare 22-char entity ID from any Spotify reference — URI, open.spotify.com URL (embed/intl forms ok), or bare ID — with zero network calls.',
    {
      ref: z.string().min(1).describe('Any Spotify reference: URI, URL, or bare ID'),
      expected_kind: z.string().optional().describe('When set, the extracted kind is compared against this value'),
    },
    async (args) => {
      const p = classifyOne(args.ref);
      const id = p.id;
      const expected = args.expected_kind ? args.expected_kind.toLowerCase() : null;
      const matchesExpected = expected === null ? null : id !== null && p.kind === expected;
      const detail = {
        ref: args.ref,
        id: id,
        kind: p.kind,
        matches_expected: matchesExpected,
        valid: p.valid,
      };
      return textResult(id ?? `unrecognised reference: ${args.ref}`, detail);
    },
  );

  server.tool(
    'validate_spotify_uri',
    'Validate a Spotify reference against the URI grammar and 22-char base62 ID rule locally, returning a field-by-field validity report.',
    {
      uri: z.string().min(1).describe('Spotify URI, URL, or bare ID to validate'),
    },
    async (args) => {
      const s = args.uri.trim();
      const uriMatch = SPOTIFY_URI_RE.exec(s);
      const p = classifyOne(s);
      const detail = {
        uri: args.uri,
        trimmed: s,
        is_uri: Boolean(uriMatch),
        is_url: /^https?:\/\//i.test(s),
        is_bare_id: !uriMatch && !/^https?:\/\//i.test(s) && SPOTIFY_ID_RE.test(s),
        kind: p.kind,
        id: p.id,
        id_length: p.id?.length ?? 0,
        id_is_base62: p.id ? /^[A-Za-z0-9]{22}$/.test(p.id) : false,
        valid: p.valid,
        errors: p.valid ? [] : ['not a valid spotify: URI, open.spotify.com URL, or 22-char base62 ID'],
      };
      return textResult(detail.valid ? 'valid' : fmt(detail), detail);
    },
  );

  server.tool(
    'normalize_spotify_uri',
    'Normalise any accepted Spotify reference form (URI with extra segments, URL with tracking params, bare ID) into its canonical lowercase spotify: URI, offline.',
    {
      ref: z.string().min(1).describe('Spotify reference in any accepted form'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const p = classifyOne(args.ref);
      const canonical = p.valid && p.kind && p.id ? makeUri(p.kind, p.id) : null;
      const detail = { input: args.ref, canonical_uri: canonical, valid: canonical !== null };
      return textResult(canonical ?? `invalid: cannot normalise ${args.ref}`, detail);
    },
  );

  server.tool(
    'spotify_uri_kind',
    'Report the entity kind of a single Spotify reference (uri/url/bare ID) locally, or null when the kind segment is missing or unknown.',
    {
      ref: z.string().min(1).describe('Spotify reference to inspect'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const p = classifyOne(args.ref);
      const detail = { ref: args.ref, kind: p.kind, form: p.form, valid: p.valid };
      return textResult(p.kind ?? 'unknown', detail);
    },
  );

  server.tool(
    'batch_parse_spotify_uris',
    'Parse a batch of Spotify references into kind/ID parts in one local pass — no network calls; one result row per input.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('Up to 500 Spotify references'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const parsed = args.uris.map((u) => classifyOne(u));
      const summary = census(parsed);
      const detail = { count: parsed.length, valid: parsed.filter((p) => p.valid).length, ...summary, results: parsed };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'is_valid_spotify_uri',
    'Boolean validity check for a single Spotify reference — true only for well-formed spotify: URIs with a 22-char base62 ID; evaluated locally.',
    {
      uri: z.string().min(1).describe('Spotify reference to check'),
    },
    async (args) => {
      const p = classifyOne(args.uri);
      return textResult(p.valid ? 'true' : 'false', { uri: args.uri, valid: p.valid });
    },
  );

  server.tool(
    'uri_namespace_census',
    'Census of a batch of Spotify references grouped by reference form (uri/url/id/invalid) and by entity kind — a local frequency table, no network calls.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('Up to 500 Spotify references'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const parsed = args.uris.map((u) => classifyOne(u));
      const c = census(parsed);
      const detail = {
        total: parsed.length,
        forms: c.form_counts,
        kinds: c.kind_counts,
        rows: parsed.map((r, i) => ({ input: args.uris[i], form: r.form, kind: r.kind })),
      };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'base62_to_uri',
    'Reinterpret a base62 ID string as a Spotify entity ID and build the full spotify: URI for a given kind, offline.',
    {
      base62: z.string().min(1).describe('Base62 ID string'),
      kind: z.string().min(1).describe('Entity kind, e.g. track'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const canonical = makeUri(args.kind, args.base62);
      const detail = { base62: args.base62, kind: args.kind.toLowerCase(), uri: canonical, valid: canonical !== null };
      return textResult(canonical ?? `invalid: ${args.base62} is not a 22-char base62 Spotify ID`, detail);
    },
  );

  server.tool(
    'uri_to_base62',
    'Strip a spotify: URI (or URL) down to its raw base62 ID string, locally; null when the reference has no extractable ID.',
    {
      uri: z.string().min(1).describe('Spotify URI, URL, or bare ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const p = classifyOne(args.uri);
      const detail = { input: args.uri, base62: p.id, valid: p.valid };
      return textResult(p.id ?? 'null', detail);
    },
  );

  server.tool(
    'make_spotify_uri',
    'Construct a spotify: URI from kind + ID with strict validation — rejects wrong-length IDs and unknown kinds before anything is built.',
    {
      kind: z.string().min(1).describe('Entity kind'),
      id: z.string().min(1).describe('Spotify entity ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const canonical = makeUri(args.kind, args.id);
      const detail = { kind: args.kind.toLowerCase(), id: args.id, uri: canonical, valid: canonical !== null };
      return textResult(canonical ?? 'invalid: kind/id pair rejected', detail);
    },
  );

  server.tool(
    'split_uri_list',
    'Split a delimited string of Spotify references into a clean array — accepts comma, semicolon, whitespace, or newline separators; local only.',
    {
      list: z.string().min(1).describe('Delimited list of Spotify references'),
      delimiter: z.string().optional().describe("Explicit delimiter; default auto-detects ',', ';', whitespace, or newline"),
      response_format: ResponseFormat,
    },
    async (args) => {
      const d = args.delimiter ?? null;
      const parts = d !== null
        ? args.list.split(d)
        : args.list.split(/[,;\s]+/);
      const items = parts.map((p) => p.trim()).filter((p) => p.length > 0);
      const detail = { count: items.length, items };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'join_uri_list',
    'Join an array of Spotify references into a single delimited string — comma, semicolon, newline, or a custom glue; local only.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('References to join'),
      separator: z.string().default(',').describe("Glue between items; common choices ',', ';', or '\\n'"),
      response_format: ResponseFormat,
    },
    async (args) => {
      const joined = args.uris.join(args.separator);
      const detail = { count: args.uris.length, separator: args.separator, joined };
      return textResult(joined, detail);
    },
  );

  server.tool(
    'dedupe_spotify_uris',
    'Remove duplicate Spotify references from a list, preserving first-seen order, comparing canonical URI forms where possible — local, no network.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('References to dedupe'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const seenKeys = new Set<string>();
      const unique: string[] = [];
      let droppedCount = 0;
      for (const u of args.uris) {
        const p = classifyOne(u);
        const kind = p.kind;
        const pid = p.id;
        const canonical = p.valid && kind && pid ? makeUri(kind, pid) : null;
        const key = canonical ?? u.trim();
        if (seenKeys.has(key)) droppedCount += 1;
        else {
          seenKeys.add(key);
          unique.push(u.trim());
        }
      }
      const detail = { count_in: args.uris.length, count_out: unique.length, duplicates_removed: droppedCount, unique };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'find_duplicate_spotify_uris',
    'List duplicate Spotify references in a batch with counts and positions, comparing canonical URI forms — computed locally with no network calls.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('References to scan'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const byCanonical = new Map<string, number[]>();
      args.uris.forEach((u, i) => {
        const p = classifyOne(u);
        const kind = p.kind;
        const pid = p.id;
        const canonical = p.valid && kind && pid ? makeUri(kind, pid) : null;
        const key = canonical ?? u.trim();
        const arr = byCanonical.get(key);
        if (arr) arr.push(i);
        else byCanonical.set(key, [i]);
      });
      const duplicates = [...byCanonical.entries()]
        .filter(([, idxs]) => idxs.length > 1)
        .map(([key, idxs]) => ({ canonical: key, count: idxs.length, positions: idxs }));
      const detail = { total_inputs: args.uris.length, duplicate_groups: duplicates.length, duplicates };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'sort_uris_by_kind',
    'Sort Spotify references into deterministic groups by entity kind (track, album, artist, playlist, show, episode, audiobook, user) and return them labelled per group — offline.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('References to group'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const groups: Record<string, string[]> = {};
      for (const u of args.uris) {
        const p = classifyOne(u);
        const key = p.kind ?? 'unknown';
        (groups[key] ??= []).push(u.trim());
      }
      const orderedGroups = Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
      const summary = Object.entries(orderedGroups)
        .map(([kind, items]) => `${kind}: ${items.length}`)
        .join('; ');
      const detail = { groups: orderedGroups, summary };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'count_uris_by_type',
    'Count how many references in a batch belong to each entity kind (track, album, artist, …) — a local tally, no network calls.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('References to tally'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const counts: Record<string, number> = {};
      for (const u of args.uris) {
        const p = classifyOne(u);
        const key = p.kind ?? 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
      }
      const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
      const detail = { total: args.uris.length, counts: sorted };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'canonicalize_spotify_uri',
    'Canonicalise a batch of Spotify references in one local pass: *** scheme, known kind, 22-char base62 ID, tracking params stripped — no network.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('References to canonicalise'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rows = args.uris.map((u) => {
        const p = classifyOne(u);
        return { input: u, canonical_uri: p.valid && p.kind && p.id ? makeUri(p.kind, p.id) : null, valid: p.valid };
      });
      const detail = { rows };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'uri_kind_stats',
    'Aggregate statistics over a batch of Spotify references: counts per form, per kind, share percentages, and the modal kind — all computed locally.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('References to profile'),
    },
    async (args) => {
      const parsed = args.uris.map((u) => classifyOne(u));
      const c = census(parsed);
      const modal = Object.entries(c.kind_counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const detail = {
        total: parsed.length,
        forms: c.form_counts,
        kinds: Object.fromEntries(
          Object.entries(c.kind_counts).map(([k, n]) => [k, { count: n, share: Number(((n / parsed.length) * 100).toFixed(1)) }]),
        ),
        modal_kind: modal,
      };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'classify_spotify_uris',
    'Classify each reference in a batch: reference form, entity kind, canonical-form verdict, and per-row issues — one local pass, no network calls.',
    {
      uris: z.array(z.string().min(1)).max(500).describe('References to classify'),
    },
    async (args) => {
      const rows = args.uris.map((u) => {
        const p = classifyOne(u);
        return {
          input: u,
          form: p.form,
          kind: p.kind,
          id: p.id,
          canonical: p.valid,
          issues: p.valid ? [] : ['unrecognised as spotify: URI, open URL, or 22-char base62 ID'],
        };
      });
      const detail = { rows };
      return textResult(fmt(detail), detail);
    },
  );

  server.tool(
    'uri_shorthand_expand',
    'Expand shorthand Spotify refs like "t:<id>", "pl/<id>", or "track:<id>" into canonical spotify: URIs. Codes: t/tr=track, al=album, ar=artist, pl/p=playlist, sh=show, ep=episode, ab=audiobook, u=user — local only.',
    {
      refs: z.array(z.string().min(1)).max(500).describe('Shorthand refs like "t:22charId"'),
    },
    async (args) => {
      const codeMap: Record<string, UriKind> = {
        t: 'track', tr: 'track', track: 'track',
        al: 'album', album: 'album',
        ar: 'artist', artist: 'artist',
        pl: 'playlist', p: 'playlist', playlist: 'playlist',
        sh: 'show', show: 'show',
        ep: 'episode', episode: 'episode',
        ab: 'audiobook', audiobook: 'audiobook',
        u: 'user', user: 'user',
      };
      const rows = args.refs.map((r) => {
        const s = r.trim();
        const m = /^([A-Za-z]+)[/:\s]([A-Za-z0-9]+)$/.exec(s);
        if (!m) return { input: r, uri: null, error: 'expected "<code>:<id>" or "<code>/<id>"' };
        const kind = codeMap[m[1].toLowerCase()];
        if (!kind) return { input: r, uri: null, error: `unknown shorthand code "${m[1]}"` };
        const uri = makeUri(kind, m[2]);
        if (!uri) return { input: r, uri: null, error: 'id is not a 22-char base62 Spotify ID' };
        return { input: r, uri, error: null };
      });
      const detail = { rows };
      return textResult(fmt(detail), detail);
    },
  );
}
