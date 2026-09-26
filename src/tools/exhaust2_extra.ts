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
import { SPOTIFY_SEARCH_MAX_LIMIT } from './search.js';
import { chunk } from '../chunk.js';
import { getConfig } from '../config.js';
import { fetchCoverJpeg, rankCoverCandidates } from '../cover-image.js';
import { issueReceipt, type Receipt } from '../receipts.js';
import { walkTruncationNotice } from './playlists.js';
import { receiptRecords, receiptsLines, writeVerdict } from './playlistreceipts.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { DryRun, ResponseFormat, describeDryRun, parseSpotifyUri } from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { playlistItemTotal, type SpotifyPlaylistPage } from '../types/spotify.js';

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


/**
 * The paging filter every item walk below sends. `item(uri)` projects each row
 * down to the only field the set algebra reads: the walk before this sent no
 * filter at all, so every row carried a whole TrackObject — name, artists,
 * album, images — to keep one URI from it.
 *
 * `total` and `limit` keep the page ENVELOPE readable, and they are not
 * optional decoration: `getAllPagesWithTruncation` advances its cursor by the
 * page's own `limit` and decides whether a short page really was the end from
 * `total` (#718). Filter them away and a clipped walk is indistinguishable from
 * a complete one — the exact silent truncation this helper now reports.
 */
const URI_FIELDS = 'items(item(uri)),total,limit';

/**
 * One playlist's URIs plus the verdict on whether they are ALL of them (#898).
 *
 * `truncated` is the load-bearing field. Every caller here turns this list
 * into a WRITE — a set-algebra playlist, a search-fill add — so a list that
 * stopped at the cap and read as complete would drop items with nothing to
 * show for it. `truncatedByCap` says the cap is why, which is what an operator
 * can act on by raising SPOTIFY_MCP_FETCH_ALL_CAP.
 */
interface PlaylistUriScan {
  /** The ref as written in the expression/argument, for messages. */
  ref: string;
  name: string | null;
  /** Playlist length as Spotify states it; null when it states none. */
  total: number | null;
  /** URIs read, first-seen order preserved. A PREFIX of the playlist when truncated. */
  uris: string[];
  /** uris.length — what this scan actually holds. */
  returned: number;
  truncated: boolean;
  truncatedByCap: boolean;
  /** The ceiling that applied: getConfig().fetchAllCap. */
  cap: number;
  /**
   * Paged read requests this scan cost (#899): the item pages plus the
   * playlist metadata GET. A caller reporting the read cost of "load this
   * playlist" and then quoting only the item pages would be quoting a number
   * smaller than the work it just did.
   */
  requests: number;
}

/** The shared "this walk stopped early" sentence (#864), or null when it did not. */
function scanNotice(scan: PlaylistUriScan): string | null {
  return walkTruncationNotice(scan.returned, scan.cap, scan.truncated);
}

/** Per-ref scan row as it appears in a tool payload. */
function scanRow(scan: PlaylistUriScan): Record<string, unknown> {
  return {
    ref: scan.ref,
    returned: scan.returned,
    total: scan.total,
    truncated: scan.truncated,
    truncated_by_cap: scan.truncatedByCap,
    scan_cap: scan.cap,
  };
}

/**
 * Sum the refs' stated lengths for a whole-expression figure. `null` unless
 * EVERY ref stated one — a total that silently omits the playlists whose
 * length was unknown would understate the gap it is meant to quantify.
 */
function knownTotal(scans: readonly PlaylistUriScan[]): number | null {
  let sum = 0;
  for (const scan of scans) {
    if (scan.total === null) return null;
    sum += scan.total;
  }
  return sum;
}

/** Walk every distinct ref of a set expression once, keeping each verdict. */
async function scanExpressionRefs(
  client: SpotifyClient,
  refs: readonly string[],
): Promise<PlaylistUriScan[]> {
  const scans: PlaylistUriScan[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    scans.push(await fetchPlaylistUris(client, ref));
  }
  return scans;
}

/** Fully page a playlist's playable uris (first-seen order preserved). */
async function fetchPlaylistUris(client: SpotifyClient, ref: string): Promise<PlaylistUriScan> {
  const id = normalizeRef(ref);
  const meta = await client.get<{ id?: string; name?: string } & SpotifyPlaylistPage>(
    `/playlists/${encodeURIComponent(id)}`,
  );
  if (!meta) throw new Error(`Playlist "${ref}" not found`);
  const cap = getConfig().fetchAllCap;
  const walk = await client.getAllPagesWithTruncation<{ item?: { uri?: string } | null }>(
    `/playlists/${encodeURIComponent(id)}/items`,
    { limit: '100', fields: URI_FIELDS },
    { maxItems: cap },
  );
  const uris = walk.items.map((r) => r.item?.uri ?? '').filter((u) => u.startsWith('spotify:'));
  const metaTotal = playlistItemTotal(meta);
  return {
    ref,
    name: meta.name ?? null,
    // The walk's own `total` is the page it actually read; the playlist object's
    // count is the fallback when that page was filtered or omitted one. Neither
    // being a number means Spotify stated no length, which is `null` — not 0.
    total:
      walk.reportedTotal
      ?? (metaTotal !== undefined && Number.isFinite(metaTotal) ? metaTotal : null),
    uris,
    returned: uris.length,
    truncated: walk.truncated,
    truncatedByCap: walk.truncatedByCap,
    cap,
    // +1 for the metadata GET above.
    requests: walk.pages + 1,
  };
}

/**
 * Chunked adds to an existing playlist, CHUNK_CAPS.playlist_writes uris per POST.
 * Each chunk is verified with its own receipt (#879) so a write the API accepts
 * and then drops cannot be reported as a completed change.
 */
async function addUrisChunked(
  client: SpotifyClient,
  playlistId: string,
  uris: readonly string[],
): Promise<{ requests: number; receipts: Receipt[] }> {
  let requests = 0;
  const receipts: Receipt[] = [];
  for (const part of chunk(uris, 'playlist_writes')) {
    await client.post(`/playlists/${encodeURIComponent(playlistId)}/items`, { uris: part });
    requests++;
    receipts.push(await issueReceipt(client, { kind: 'playlist_items', id: playlistId, uris: [...part] }));
  }
  return { requests, receipts };
}

// ---------------------------------------------------------------------------
type TrackSearchPage = {
  uris: string[];
  hasMore: boolean;
};

/** Fetch one Spotify /search track page without ever exceeding the live API cap. */
async function fetchTrackSearchPage(
  client: SpotifyClient,
  query: string,
  offset: number,
  market: string | undefined,
): Promise<TrackSearchPage> {
  const body = await client.get<{
    tracks?: { items?: Array<{ uri?: string } | null>; total?: number };
  }>('/search', {
    q: query,
    type: 'track',
    limit: String(SPOTIFY_SEARCH_MAX_LIMIT),
    ...(offset > 0 ? { offset: String(offset) } : {}),
    ...(market ? { market } : {}),
  });
  const items = body?.tracks?.items ?? [];
  const nextOffset = offset + items.length;
  const total = body?.tracks?.total;
  return {
    uris: items
      .map((track) => track?.uri ?? '')
      .filter((uri) => uri.startsWith('spotify:')),
    hasMore:
      items.length === SPOTIFY_SEARCH_MAX_LIMIT &&
      nextOffset <= 1000 &&
      (total === undefined || nextOffset < total),
  };
}

// set algebra (pure, exported for tests)
// ---------------------------------------------------------------------------

type SetExpr =
  | { kind: 'ref'; ref: string }
  | { kind: 'union' | 'inter' | 'diff'; left: SetExpr; right: SetExpr };

const OP_UNION = new Set(['∪', '|', '+']);
const OP_INTER = new Set(['∩', '&']);
const OP_DIFF = new Set(['−', '–', '-']);
const TOKEN_RE = /spotify:playlist:[A-Za-z0-9]+|[A-Za-z0-9]+|[∪|+∩&−–\-()]|\s+/u;

type Token = { t: 'ref'; v: string } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' };

/** Tokenize an algebra expression; throws on any unrecognized character. */
function tokenizeSetExpression(src: string): Token[] {
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

interface RoundRobinPick {
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
  while (picks.length < target) {
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
// cover candidates — pure helpers live in src/cover-image.ts and are imported
// at the top of this file. `rankCoverCandidates` is re-exported below for
// backwards compatibility with existing tests (#880).
// ---------------------------------------------------------------------------

type CoverImage = import('../types/spotify.js').SpotifyImage;
export { rankCoverCandidates };

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerExhaust2ExtraTools(server: McpServer, client: SpotifyClient): void {
  // 1. playlist_fill_from_search (#398)
  server.tool(
    'playlist_fill_from_search',
    'Grow a playlist to N items from search queries you supply: round-robin one pick per query per pass, first unseen track match wins, pages each query in Spotify-compliant 10-result requests, then performs chunked adds. Complements listening-data grow_playlist. Quota: one or more 10-result search pages per query + chunked adds, after a capped pre-read of the current items; a capped pre-read reports existing_truncated and an unknown resulting length.',
    {
      playlist_id: z.string().describe('Playlist to grow (ID or spotify:playlist: URI)'),
      // #899: the bound is a READ-COST ceiling — one `/search` page walk per
      // query — so the rejection names that rather than a bare item count. A
      // CSV string normalises through the same bound, so it cannot carry a
      // longer list than the array form allows.
      queries: z.preprocess(
        (value) =>
          typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter(Boolean) : value,
        z
          .array(z.string().min(1))
          .min(1, { error: 'At least 1 search query required' })
          .max(25, { error: 'playlist_fill_from_search runs a separate paged search per query: max 25 per call' }),
      ).describe('Search queries, cycled round-robin (1–25)'),
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
      // The scan carries the playlist's own length, so the separate meta GET
      // this used to make first is redundant — one request per call saved.
      const scan = await fetchPlaylistUris(client, args.playlist_id);
      const existing = new Set(scan.uris);
      // #899: every read this call spends, so `requests_read` is a TOTAL and
      // not a phase-scoped fragment. Two things read before the first search:
      // the scan's own `/playlists/{id}` metadata read and that call's
      // item-page walk — both already inside `scan.requests`. Reporting only
      // the search pages under a field called `requests_read` would be a
      // smaller number wearing a total's name.
      const setupRequests = scan.requests;
      const perQuery: string[][] = args.queries.map(() => []);
      const nextOffsets = args.queries.map(() => 0);
      const pagesFetched = args.queries.map(() => 0);
      const exhausted = args.queries.map(() => false);
      const target = args.target_count ?? 20;

      const fetchNextPage = async (queryIndex: number): Promise<void> => {
        if (exhausted[queryIndex]) return;
        const page = await fetchTrackSearchPage(
          client,
          args.queries[queryIndex]!,
          nextOffsets[queryIndex]!,
          args.market,
        );
        const seen = new Set(perQuery[queryIndex]);
        for (const uri of page.uris) {
          if (!seen.has(uri)) {
            perQuery[queryIndex]!.push(uri);
            seen.add(uri);
          }
        }
        nextOffsets[queryIndex] = nextOffsets[queryIndex]! + SPOTIFY_SEARCH_MAX_LIMIT;
        pagesFetched[queryIndex] = pagesFetched[queryIndex]! + 1;
        exhausted[queryIndex] = !page.hasMore;
      };

      for (let i = 0; i < args.queries.length; i++) await fetchNextPage(i);
      let picks = pickRoundRobin(perQuery, args.queries, target, existing);
      while (picks.length < target) {
        const pending = exhausted.findIndex((done) => !done);
        if (pending === -1) break;
        await fetchNextPage(pending);
        picks = pickRoundRobin(perQuery, args.queries, target, existing);
      }
      const byQuery = new Map<number, number>();
      for (const p of picks) byQuery.set(p.query_index, (byQuery.get(p.query_index) ?? 0) + 1);
      // #898: the playlist's real length and the length actually READ are two
      // different numbers, and this walk is capped. Printing the read count as
      // the playlist length — or letting an incomplete read drive the
      // already-present exclusion set, which then re-adds items that were
      // there — is the silent-truncation bug this payload now names.
      const totalPhrase = scan.total === null
        ? 'playlist length unknown'
        : `playlist has ${scan.total} item(s)`;
      const readPhrase = scan.truncated
        ? `${scan.returned} item(s) readable (walk stopped at the cap, ${scan.cap})`
        : `${scan.returned} item(s) readable`;
      const planLines = [
        `Playlist "${scan.name ?? id}" — ${totalPhrase}; ${readPhrase}; ${existing.size} already present + ${picks.length} search pick(s):`,
        ...args.queries.map((q, i) => `  [${i}] "${q}" → ${byQuery.get(i) ?? 0} pick(s) (of ${perQuery[i]?.length ?? 0} candidate(s) across ${pagesFetched[i] ?? 0} page(s))`),
        // #899: the read cost reaches the prose too — a cost that only exists
        // in structuredContent does not reach a reader who only sees the text.
        `(Read cost: ${setupRequests + pagesFetched.reduce((total, n) => total + n, 0)} paged read request(s) across ${args.queries.length} quer${args.queries.length === 1 ? 'y' : 'ies'}.)`,
      ];
      const notice = scanNotice(scan);
      const payload: Record<string, unknown> = {
        ok: true,
        playlist: id,
        playlist_name: scan.name,
        existing: existing.size,
        existing_scanned: scan.returned,
        existing_total: scan.total,
        existing_truncated: scan.truncated,
        existing_truncated_by_cap: scan.truncatedByCap,
        scan_cap: scan.cap,
        target,
        added: picks.length,
        // #899: the read cost the `queries` array implies, counted as a TOTAL
        // of every paged read this call issued.
        requests_read: setupRequests
          + pagesFetched.reduce((total, n) => total + n, 0),
        search_requests_read: pagesFetched.reduce((total, n) => total + n, 0),
        per_query: Object.fromEntries(args.queries.map((q, i) => [q, byQuery.get(i) ?? 0])),
        picks,
        candidates_per_query: args.queries.map((query, query_index) => ({
          query_index,
          query,
          candidates: perQuery[query_index]?.length ?? 0,
          pages_searched: pagesFetched[query_index] ?? 0,
          candidate_uris: perQuery[query_index] ?? [],
          exhausted: exhausted[query_index] ?? true,
        })),
      };
      if (dry) {
        return shape(
          rf,
          `${describeDryRun('fill from search', id, planLines)}\n${picks.slice(0, 10).map((p) => `  + ${p.uri} (via "${p.query}")`).join('\n')}${picks.length > 10 ? `\n  … ${picks.length - 10} more` : ''}${notice ? `\n${notice}` : ''}`,
          { ...payload, dry_run: true },
        );
      }
      if (picks.length === 0) throw new Error('No unseen tracks matched any query — nothing to add.');
      const add = await addUrisChunked(client, id, picks.map((p) => p.uri));
      const receiptLines = receiptsLines(add.receipts);
      // Only a COMPLETE pre-read can state the playlist's new length. A capped
      // read is missing rows, so `existing.size + picks` is arithmetic over a
      // number nobody verified — and a pick that was already there is now in
      // the write twice. Say "unknown" rather than print a total (#803 class).
      const nowTotal = scan.truncated ? null : existing.size + picks.length;
      const truncationProse = scan.truncated
        ? ` Resulting length unknown: only the first ${scan.returned} item(s) were read, so a pick may already have been in the playlist.`
        : '';
      const prose = `Added ${picks.length} track(s) to "${scan.name ?? id}" (${add.requests} add request(s)); playlist now ${nowTotal ?? 'unknown'} item(s).${truncationProse}`;
      return shape(
        rf,
        receiptLines ? `${prose}\n${receiptLines}` : prose,
        { ...payload, ...writeVerdict(add.receipts, picks.length), dry_run: false, requests: add.requests, now_total: nowTotal, receipts: receiptRecords(add.receipts) },
      );
    },
  );

  // 2. playlist_expression_algebra (#399)
  server.tool(
    'playlist_expression_algebra',
    'Mini set-algebra over playlists: `REF ∪ (REF ∩ REF) − REF` → NEW playlist. Operators: ∩ (binds tightest), then ∪ and − left-assoc; ASCII aliases | + for union, & for intersection. Refs are playlist IDs or spotify:playlist: URIs; results dedupe preserving first-seen order. Each ref costs 1 GET plus up to SPOTIFY_MCP_FETCH_ALL_CAP/100 URI-only item pages. Quota: 1 + item pages per ref, then 1 create + chunked adds. A ref stopped at the cap sets truncated=true with total and returned; the result is then incomplete.',
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
      const scans = await scanExpressionRefs(client, refs);
      const sets = new Map<string, string[]>(scans.map((s) => [s.ref, s.uris]));
      const sizes: Record<string, number> = Object.fromEntries(scans.map((s) => [s.ref, s.returned]));
      // #899: this walks every distinct ref in the expression, so the read
      // cost is a real per-ref figure and worth reporting rather than
      // describing as "N GETs" where N counted refs, not requests.
      const readRequests = scans.reduce((sum, s) => sum + s.requests, 0);
      const result = evalSetExpression(ast, (ref) => sets.get(ref) ?? []);
      if (result.length === 0) throw new Error('Expression evaluates to an empty set — nothing to write.');
      // #898: the whole expression is computed from whatever each ref's walk
      // read, so a clipped ref silently drops rows out of the union, the
      // intersection and the difference alike. One `truncated: true` over the
      // refs, plus per-ref total/returned, is what lets the agent decide
      // whether to raise SPOTIFY_MCP_FETCH_ALL_CAP or re-run the expression.
      const clipped = scans.filter((s) => s.truncated);
      const truncated = clipped.length > 0;
      const returned = scans.reduce((sum, s) => sum + s.returned, 0);
      const truncationFields: Record<string, unknown> = {
        truncated,
        total: knownTotal(scans),
        returned,
        truncated_refs: clipped.map((s) => s.ref),
        ref_scans: scans.map(scanRow),
        scan_cap: getConfig().fetchAllCap,
      };
      const refPhrase = (s: PlaylistUriScan): string => (s.truncated
        ? `${s.ref} (${s.returned} of ${s.total ?? '?'} item(s) — TRUNCATED)`
        : `${s.ref} (${s.returned} item(s))`);
      const planLines = [
        `Refs: ${scans.map(refPhrase).join(', ')}`,
        `Result: ${result.length} unique item(s)`,
        ...(truncated
          ? [`⚠ ${clipped.length} of ${scans.length} ref walk(s) stopped at the cap — the result is computed from a partial read of those refs.`]
          : []),
      ];
      if (dry) {
        return shape(
          rf,
          `${describeDryRun('expression algebra', args.target_name, planLines)}\n${result.slice(0, 10).map((u) => `  · ${u}`).join('\n')}${result.length > 10 ? `\n  … ${result.length - 10} more` : ''}`,
          { ok: true, dry_run: true, expression: args.expression, refs, sizes, result_count: result.length, result_preview: result.slice(0, 25), requests_read: readRequests, ...truncationFields },
        );
      }
      const created = await client.post<{ id?: string }>('/me/playlists', {
        name: args.target_name,
        public: args.public ?? false,
      });
      const createdId = created?.id;
      if (!createdId) throw new Error('Playlist creation returned no id');
      const add = await addUrisChunked(client, createdId, result);
      const receiptLines = receiptsLines(add.receipts);
      const truncationProse = truncated
        ? ` The result is INCOMPLETE: ${clipped.map((s) => `"${s.ref}" (${s.returned} of ${s.total ?? '?'} read)`).join(', ')} stopped at the fetch-all cap.`
        : '';
      const prose = `Created "${args.target_name}" (${createdId}) with ${result.length} item(s) from the expression (${add.requests} add request(s)).${truncationProse}`;
      return shape(
        rf,
        receiptLines ? `${prose}\n${receiptLines}` : prose,
        { ...writeVerdict(add.receipts, result.length), dry_run: false, playlist: createdId, name: args.target_name, result_count: result.length, refs, sizes, requests: add.requests, requests_read: readRequests, receipts: receiptRecords(add.receipts), ...truncationFields },
      );
    },
  );

  // 3. playlist_cover_from_track (#400)
  server.tool(
    'playlist_cover_from_track',
    'Set the playlist cover from a track album art: pick by position in the playlist, pass any track URI, or default to the first track with art. Fetches the image (largest JPEG candidate ≤ 256 KB) and PUTs /playlists/{id}/images. Quota: GET + PUT (+1 image fetch, disclosed).',
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
      const meta = await client.get<{ id?: string; name?: string } & SpotifyPlaylistPage>(`/playlists/${encodeURIComponent(id)}`);
      if (!meta) throw new Error(`Playlist "${args.playlist_id}" not found`);
      // The playlist's real length, as reported by the playlist object. The
      // item walk below is bounded, so its row count can never stand in here.
      // #589: `items.total` is canonical and `tracks.total` is the pre-Feb-2026
      // spelling; reading only the latter reported "length unknown" for every
      // playlist on the current payload shape.
      const rawTotal = playlistItemTotal(meta);
      const playlistTotal = rawTotal !== undefined && Number.isFinite(rawTotal) ? rawTotal : null;
      const totalPhrase = playlistTotal === null
        ? 'playlist length unknown'
        : `playlist has ${playlistTotal} item(s)`;

      let trackUri = args.track_uri ?? null;
      let images: CoverImage[] = [];
      let source = '';
      // Items actually fetched below; 0 when the walk never runs (track_uri path).
      let itemsScanned = 0;
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
        itemsScanned = rows.length;
        const candidates = args.position != null
          ? [rows[idx]].filter(Boolean)
          : rows;
        if (args.position != null && !candidates[0]) {
          throw new Error(`Position ${args.position} is beyond the ${itemsScanned} item(s) scanned (${totalPhrase})`);
        }
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
        throw new Error(`No track with album art found in the ${itemsScanned} item(s) scanned (${totalPhrase}). Pass track_uri or position, or add a track with art first.`);
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
          { ok: true, dry_run: true, playlist: id, track: trackUri, source, candidates: ranked, items_scanned: itemsScanned, playlist_total: playlistTotal },
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
            { ok: true, dry_run: false, playlist: id, track: trackUri, source, image_url: candidate.url, bytes, items_scanned: itemsScanned, playlist_total: playlistTotal },
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
