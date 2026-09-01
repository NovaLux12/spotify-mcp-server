/**
 * exhaust2 extra slice — the final three playlists-surface tools (#398-#400).
 *
 *   #398 playlist_fill_from_search  — grow a playlist to N items from search
 *                                     queries (round-robin, one pick per
 *                                     query per pass; first unseen match wins).
 *   #399 playlist_expression_algebra — mini set-algebra evaluator:
 *                                     `REF ∪ (REF ∩ REF) − REF` → new playlist.
 *   #400 playlist_cover_from_track  — set a playlist cover from a track's
 *                                     album art (position / URI / first-with-art).
 *
 * Conventions: all slice logic lives in this file and nowhere else; pure
 * helpers are exported for tests; every mutation defaults to dry_run TRUE
 * (repo convention: previews are the default); quota lines in descriptions.
 */
import { z } from 'zod';
import { MARKET_CODE } from './catalog.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { DryRun, ResponseFormat, describeDryRun, parseSpotifyUri } from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';

// ---------------------------------------------------------------------------
// local shaping helpers (slice-convention: self-contained)
// ---------------------------------------------------------------------------

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

function shape(rf: ResponseFormatValue, prose: string, payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: rf === 'json' ? jsonText(payload) : prose }],
    structuredContent: payload,
  };
}

/** Accept a bare playlist/track ID or a spotify:<type>: URI; return the raw ID. */
function normalizeRef(ref: string): string {
  const parsed = parseSpotifyUri(ref);
  return parsed?.id ?? ref.trim();
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Fully page a playlist's playable uris (first-seen order preserved). */
async function fetchPlaylistUris(client: SpotifyClient, ref: string): Promise<string[]> {
  const id = normalizeRef(ref);
  const meta = await client.get<{ id?: string; name?: string }>(`/playlists/${encodeURIComponent(id)}`);
  if (!meta) throw new Error(`Playlist "${ref}" not found`);
  const rows = await client.getAllPages<{ added_at?: string; item?: { uri?: string } | null }>(
    `/playlists/${encodeURIComponent(id)}/items`,
    { limit: '100' },
    { maxItems: 10_000 },
  );
  return rows.map((r) => r.item?.uri ?? '').filter((u) => u.startsWith('spotify:'));
}

/** Chunked adds to an existing playlist: POST /playlists/{id}/items, 100/call. */
async function addUrisChunked(client: SpotifyClient, playlistId: string, uris: readonly string[]): Promise<number> {
  let requests = 0;
  for (const part of chunk(uris, 100)) {
    await client.post(`/playlists/${encodeURIComponent(playlistId)}/items`, { uris: part });
    requests++;
  }
  return requests;
}

// ---------------------------------------------------------------------------
// set algebra (pure, exported for tests)
// ---------------------------------------------------------------------------

export type SetExpr =
  | { kind: 'ref'; ref: string }
  | { kind: 'union' | 'inter' | 'diff'; left: SetExpr; right: SetExpr };

const OP_UNION = new Set(['∪', '|', '+']);
const OP_INTER = new Set(['∩', '&']);
const OP_DIFF = new Set(['−', '–', '-']);
const TOKEN_RE = /spotify:playlist:[A-Za-z0-9]+|[A-Za-z0-9]+|[∪|+∩&−–\-()]|\s+/u;

type Token = { t: 'ref'; v: string } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' };

/** Tokenize an algebra expression; throws on any unrecognized character. */
export function tokenizeSetExpression(src: string): Token[] {
  const tokens: Token[] = [];
  let rest = src;
  while (rest.length > 0) {
    const m = TOKEN_RE.exec(rest);
    if (!m) throw new Error(`Unexpected character in expression near: "${rest.slice(0, 12)}"`);
    const tok = m[0];
    if (/^\s+$/.test(tok)) {
      // skip
    } else if (tok === '(') tokens.push({ t: 'lp' });
    else if (tok === ')') tokens.push({ t: 'rp' });
    else if (OP_UNION.has(tok) || OP_INTER.has(tok) || OP_DIFF.has(tok)) tokens.push({ t: 'op', v: tok });
    else tokens.push({ t: 'ref', v: tok });
    rest = rest.slice(tok.length);
  }
  return tokens;
}

/**
 * Parse and collect refs. Grammar (documented in the tool description):
 *   expr  := term ((∪|+|−) term)*      — union and difference, left-assoc
 *   term  := factor ((∩|&) factor)*    — intersection binds tightest
 *   factor := '(' expr ')' | REF
 * REF is a playlist ID or spotify:playlist: URI.
 */
export function parseSetExpression(src: string): { ast: SetExpr; refs: string[] } {
  const tokens = tokenizeSetExpression(src);
  const refs: string[] = [];
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token => {
    const t = tokens[pos];
    if (!t) throw new Error('Unexpected end of expression');
    pos++;
    return t;
  };
  const parseAtom = (): SetExpr => {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'lp') {
      next();
      const inner = parseExpr();
      const close = peek();
      if (!close || close.t !== 'rp') throw new Error('Unbalanced parenthesis in expression');
      next();
      return inner;
    }
    if (t.t === 'ref') {
      next();
      refs.push(t.v);
      return { kind: 'ref', ref: t.v };
    }
    if (t.t === 'op') throw new Error(`Unexpected operator "${t.v}" where a playlist ref was expected`);
    throw new Error(t.t === 'rp' ? 'Unbalanced ")" in expression' : 'Malformed expression');
  };
  const parseTerm = (): SetExpr => {
    let left = parseAtom();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && OP_INTER.has(t.v)) {
        next();
        left = { kind: 'inter', left, right: parseAtom() };
      } else break;
    }
    return left;
  };
  const parseExpr = (): SetExpr => {
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (OP_UNION.has(t.v) || OP_DIFF.has(t.v))) {
        next();
        const kind = OP_UNION.has(t.v) ? 'union' : 'diff';
        left = { kind, left, right: parseTerm() };
      } else break;
    }
    return left;
  };
  const ast = parseExpr();
  if (pos < tokens.length) throw new Error('Trailing input after expression (unbalanced ")"?)');
  return { ast, refs };
}

/**
 * Ordered set ops over uri lists (first-seen order preserved):
 *   union  — left, then right-only appended
 *   inter  — left filtered to the right set
 *   diff   — left minus the right set
 */
export function evalSetExpression(ast: SetExpr, resolve: (ref: string) => readonly string[]): string[] {
  const walk = (node: SetExpr): string[] => {
    if (node.kind === 'ref') return [...resolve(node.ref)];
    const left = walk(node.left);
    const right = walk(node.right);
    const rightSet = new Set(right);
    if (node.kind === 'union') {
      const seen = new Set(left);
      return [...left, ...right.filter((u) => !seen.has(u))];
    }
    if (node.kind === 'inter') return left.filter((u) => rightSet.has(u));
    return left.filter((u) => !rightSet.has(u));
  };
  const out = walk(ast);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// round-robin search picks (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface RoundRobinPick {
  query_index: number;
  query: string;
  uri: string;
}

/**
 * Cycle the queries, one unseen pick per query per pass, until `target`
 * picks or a full pass yields nothing new. queryUris[i] is the ordered
 * result list for queries[i].
 */
export function pickRoundRobin(
  queryUris: readonly (readonly string[])[],
  queries: readonly string[],
  target: number,
  exclude: ReadonlySet<string>,
): RoundRobinPick[] {
  const picks: RoundRobinPick[] = [];
  const taken = new Set<string>(exclude);
  const cursor = new Array<number>(queryUris.length).fill(0);
  for (let pass = 0; pass < 50 && picks.length < target; pass++) {
    let anyNew = false;
    for (let i = 0; i < queryUris.length && picks.length < target; i++) {
      const list = queryUris[i];
      while (cursor[i] < list.length && taken.has(list[cursor[i]]!)) cursor[i]++;
      if (cursor[i] < list.length) {
        const uri = list[cursor[i]]!;
        cursor[i]++;
        taken.add(uri);
        picks.push({ query_index: i, query: queries[i]!, uri });
        anyNew = true;
      }
    }
    if (!anyNew) break;
  }
  return picks;
}

// ---------------------------------------------------------------------------
// cover candidates (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface CoverImage {
  url: string;
  width?: number | null;
  height?: number | null;
}

/** Largest-first cover candidates (by width, unknown-width last, stable). */
export function rankCoverCandidates(images: readonly CoverImage[]): CoverImage[] {
  return [...images]
    .map((img, i) => ({ img, i }))
    .sort((a, b) => (b.img.width ?? -1) - (a.img.width ?? -1) || a.i - b.i)
    .map(({ img }) => img);
}

/** Fetch a URL as a JPEG buffer within Spotify's 256 KB cover limit. */
async function fetchCoverJpeg(url: string): Promise<{ buf: Buffer; bytes: number }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch cover image ${url}: ${resp.status}`);
  const type = resp.headers.get('content-type') ?? '';
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!type.includes('jpeg') && !type.includes('jpg')) {
    throw new Error(`Cover candidate is ${type || 'unknown type'}, not JPEG — Spotify covers require JPEG`);
  }
  if (buf.length > 256 * 1024) throw new Error(`Cover image exceeds 256 KB (${buf.length} bytes)`);
  if (buf.length === 0) throw new Error('Cover image is empty');
  return { buf, bytes: buf.length };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerExhaust2ExtraTools(server: McpServer, client: SpotifyClient): void {
  // 1. playlist_fill_from_search (#398)
  server.tool(
    'playlist_fill_from_search',
    'Grow a playlist to N items from search queries you supply: round-robin one pick per query per pass, first unseen track match wins, chunked adds. Complements listening-data grow_playlist. Quota: 🟡 len(queries) searches + chunked adds.',
    {
      playlist_id: z.string().describe('Playlist to grow (ID or spotify:playlist: URI)'),
      queries: z.array(z.string().min(1)).min(1).max(25).describe('Search queries, cycled round-robin (1–25)'),
      target_count: z.number().int().min(1).max(500).optional()
        .describe('Grow the playlist until it reaches this many NEW items. Default 20'),
      market: MARKET_CODE.optional().describe('ISO 3166-1 alpha-2 market for search, e.g. \'US\''),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dry = args.dry_run ?? true;
      const id = normalizeRef(args.playlist_id);
      const meta = await client.get<{ id?: string; name?: string }>(`/playlists/${encodeURIComponent(id)}`);
      if (!meta) throw new Error(`Playlist "${args.playlist_id}" not found`);
      const existing = new Set(await fetchPlaylistUris(client, id));
      const perQuery: string[][] = [];
      for (const q of args.queries) {
        const body = await client.get<{ tracks?: { items?: Array<{ uri?: string }> } }>(
          '/search',
          { q, type: 'track', limit: '20', ...(args.market ? { market: args.market } : {}) },
        );
        perQuery.push((body?.tracks?.items ?? []).map((t) => t.uri ?? '').filter((u) => u.startsWith('spotify:')));
      }
      const picks = pickRoundRobin(perQuery, args.queries, args.target_count ?? 20, existing);
      const byQuery = new Map<number, number>();
      for (const p of picks) byQuery.set(p.query_index, (byQuery.get(p.query_index) ?? 0) + 1);
      const planLines = [
        `Playlist "${meta.name ?? id}" (${existing.size} item(s)) + ${picks.length} search pick(s):`,
        ...args.queries.map((q, i) => `  [${i}] "${q}" → ${byQuery.get(i) ?? 0} pick(s) (of ${perQuery[i]?.length ?? 0} result(s))`),
      ];
      const payload: Record<string, unknown> = {
        ok: true,
        playlist: id,
        playlist_name: meta.name ?? null,
        existing: existing.size,
        target: args.target_count ?? 20,
        added: picks.length,
        per_query: Object.fromEntries(args.queries.map((q, i) => [q, byQuery.get(i) ?? 0])),
        picks,
      };
      if (dry) {
        return shape(
          rf,
          `${describeDryRun('fill from search', id, planLines)}\n${picks.slice(0, 10).map((p) => `  + ${p.uri} (via "${p.query}")`).join('\n')}${picks.length > 10 ? `\n  … ${picks.length - 10} more` : ''}`,
          { ...payload, dry_run: true },
        );
      }
      if (picks.length === 0) throw new Error('No unseen tracks matched any query — nothing to add.');
      const requests = await addUrisChunked(client, id, picks.map((p) => p.uri));
      return shape(
        rf,
        `Added ${picks.length} track(s) to "${meta.name ?? id}" (${requests} add request(s)); playlist now ${existing.size + picks.length} item(s).`,
        { ...payload, dry_run: false, requests, now_total: existing.size + picks.length },
      );
    },
  );

  // 2. playlist_expression_algebra (#399)
  server.tool(
    'playlist_expression_algebra',
    'Mini set-algebra over playlists: `REF ∪ (REF ∩ REF) − REF` → NEW playlist. Operators: ∩ (binds tightest), then ∪ and − left-assoc; ASCII aliases | + for union, & for intersection. Refs are playlist IDs or spotify:playlist: URIs; results dedupe preserving first-seen order. Quota: 🟢 N GETs + 1 write.',
    {
      expression: z.string().min(3).describe(
        'Set expression, e.g. "37i9dQZF1DXcBWIGoYBM5M ∪ (4bKpVbPAsKv0aSsbIm2Ggt ∩ 6mtXbPAsKv0aSsbIm2Ggt) − 1a2B3cD4e5F6g7H8i9J0kL". '
          + 'Operators: ∪ (or | or +) union, ∩ (or &) intersection, − (or - or –) difference; parentheses for grouping.',
      ),
      target_name: z.string().min(1).describe('Name for the NEW playlist holding the result'),
      public: z.boolean().optional().describe('Public visibility for the new playlist. Default: private'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dry = args.dry_run ?? true;
      const { ast, refs } = parseSetExpression(args.expression);
      const sets = new Map<string, string[]>();
      const sizes: Record<string, number> = {};
      for (const ref of refs) {
        if (sets.has(ref)) continue;
        const uris = await fetchPlaylistUris(client, ref);
        sets.set(ref, uris);
        sizes[ref] = uris.length;
      }
      const result = evalSetExpression(ast, (ref) => sets.get(ref) ?? []);
      if (result.length === 0) throw new Error('Expression evaluates to an empty set — nothing to write.');
      const planLines = [
        `Refs: ${refs.map((r) => `${r} (${sizes[r]} item(s))`).join(', ')}`,
        `Result: ${result.length} unique item(s)`,
      ];
      if (dry) {
        return shape(
          rf,
          `${describeDryRun('expression algebra', args.target_name, planLines)}\n${result.slice(0, 10).map((u) => `  · ${u}`).join('\n')}${result.length > 10 ? `\n  … ${result.length - 10} more` : ''}`,
          { ok: true, dry_run: true, expression: args.expression, refs, sizes, result_count: result.length, result_preview: result.slice(0, 25) },
        );
      }
      const created = await client.post<{ id?: string }>('/me/playlists', {
        name: args.target_name,
        public: args.public ?? false,
      });
      const createdId = created?.id;
      if (!createdId) throw new Error('Playlist creation returned no id');
      const requests = await addUrisChunked(client, createdId, result);
      return shape(
        rf,
        `Created "${args.target_name}" (${createdId}) with ${result.length} item(s) from the expression (${requests} add request(s)).`,
        { ok: true, dry_run: false, playlist: createdId, name: args.target_name, result_count: result.length, refs, sizes, requests },
      );
    },
  );

  // 3. playlist_cover_from_track (#400)
  server.tool(
    'playlist_cover_from_track',
    'Set the playlist cover from a track album art: pick by position in the playlist, pass any track URI, or default to the first track with art. Fetches the image (largest JPEG candidate ≤ 256 KB) and PUTs /playlists/{id}/images. Quota: 🟢 GET + PUT (+1 image fetch, disclosed).',
    {
      playlist_id: z.string().describe('Playlist to re-cover (ID or spotify:playlist: URI)'),
      track_uri: z.string().optional().describe('Any track (spotify:track: URI or bare ID) whose album art to use. Overrides position'),
      position: z.number().int().min(0).optional().describe('0-based playlist position of the track to source art from'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue;
      const dry = args.dry_run ?? true;
      const id = normalizeRef(args.playlist_id);
      const meta = await client.get<{ id?: string; name?: string }>(`/playlists/${encodeURIComponent(id)}`);
      if (!meta) throw new Error(`Playlist "${args.playlist_id}" not found`);

      let trackUri = args.track_uri ?? null;
      let images: CoverImage[] = [];
      let source = '';
      if (trackUri) {
        const tid = normalizeRef(trackUri);
        const t = await client.get<{ uri?: string; name?: string; album?: { images?: CoverImage[] } }>(`/tracks/${encodeURIComponent(tid)}`);
        if (!t) throw new Error(`Track "${args.track_uri}" not found`);
        images = t.album?.images ?? [];
        trackUri = t.uri ?? `spotify:track:${tid}`;
        source = `track URI ${trackUri}`;
      } else {
        const rows = await client.getAllPages<{ item?: { type?: string; uri?: string; name?: string; album?: { images?: CoverImage[] } } | null }>(
          `/playlists/${encodeURIComponent(id)}/items`,
          { limit: '100' },
          { maxItems: 500 },
        );
        const idx = args.position ?? -1;
        const candidates = args.position != null
          ? [rows[idx]].filter(Boolean)
          : rows;
        if (args.position != null && !candidates[0]) throw new Error(`Position ${args.position} out of range (${rows.length} item(s))`);
        for (const row of candidates) {
          const item = row?.item;
          if (item?.type !== 'track' || !item.uri) continue;
          const albumImages = item.album?.images ?? [];
          if (albumImages.length === 0) continue;
          trackUri = item.uri;
          images = albumImages;
          source = args.position != null ? `position ${args.position}` : 'first track with art';
          break;
        }
      }
      if (!trackUri || images.length === 0) {
        throw new Error('No track with album art found (pass track_uri or position, or add a track with art first)');
      }
      const ranked = rankCoverCandidates(images);
      if (dry) {
        return shape(
          rf,
          describeDryRun('cover from track', id, [
            `Source: ${source}`,
            `Track: ${trackUri}`,
            `Cover candidates (largest first): ${ranked.map((i) => `${i.url} (${i.width ?? '?'}px)`).join(', ')}`,
            'Next commit: fetch the largest JPEG ≤ 256 KB and PUT /playlists/{id}/images.',
          ]),
          { ok: true, dry_run: true, playlist: id, track: trackUri, source, candidates: ranked },
        );
      }
      let lastError: unknown = null;
      for (const candidate of ranked) {
        try {
          const { buf, bytes } = await fetchCoverJpeg(candidate.url);
          await client.putRaw(`/playlists/${encodeURIComponent(id)}/images`, buf.toString('base64'));
          return shape(
            rf,
            `Cover of "${meta.name ?? id}" set from ${trackUri} via ${source} (${candidate.width ?? '?'}px, ${bytes} B).`,
            { ok: true, dry_run: false, playlist: id, track: trackUri, source, image_url: candidate.url, bytes },
          );
        } catch (err) {
          lastError = err;
        }
      }
      throw new Error(
        `No cover candidate worked: ${ranked.length} candidate(s) tried. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    },
  );
}
