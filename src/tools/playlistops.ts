/**
 * Playlist power tools (#96): merge_playlists, diff_playlists, overlap_playlists.
 * All three accept playlist references as a bare ID or a spotify:playlist: URI
 * (normalized locally), share response_format/max_results shaping (#51/#53),
 * and expose dry_run (#57). Reads are always safe; only merge_playlists
 * mutates, and its dry_run previews page the sources but never POSTs.
 */
import { z } from 'zod';
import { capFor, runChunkedPlaylistWrite } from '../chunk.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  DryRun,
  PlaylistListFields,
  PlaylistPairFields,
  PlaylistRef,
  batchSummary,
  legacyPlaylistPairFields,
  playlistListInputFields,
  parseSpotifyUri,
  resolveMaxResults,
  resolvePlaylistInput,
  sharedListFields,
  truncateItems,
  withPlaylistInputMetadata,
  withPlaylistInputNote,
  type ResponseFormatValue,
} from '../shaping.js';
import type {
  PlaylistItemObject,
  SpotifyTrack,
  SpotifyEpisode,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  const content: TextContent[] = [{ type: 'text', text }];
  return structured ? { content, structuredContent: structured } : { content };
}

/** Raw-JSON rendering for response_format='json' (#51); shared by all three tools. */
const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

// Hard cap for fetch-all pagination loops (#55), same as playlists.ts.
const FETCH_ALL_CAP = () => getConfig().fetchAllCap;
const PlaylistWalkFields = {
  limit: z.number().int().min(1).max(100).optional().describe('Source page size, 1–100. Default: 100'),
  scan_cap: z.number().int().min(1).max(10_000).optional().describe('Maximum source rows to scan; bounded by SPOTIFY_MCP_FETCH_ALL_CAP'),
};

/**
 * Accept a bare playlist ID or a spotify:playlist: URI and return the raw ID.
 * Every tool in this module funnels its playlist arguments through here.
 */
function normalizePlaylistRef(ref: string): string {
  const parsed = parseSpotifyUri(ref);
  if (parsed && parsed.type === 'playlist') return parsed.id;
  return ref.trim();
}

/** Track identity key for set operations: URI when present, else ID. */
function trackKey(track: SpotifyTrack | SpotifyEpisode): string | null {
  if (track.uri) return track.uri;
  return track.id ?? null;
}

/**
 * The one row shape the merge consumes (#902). `merge_playlists` only ever
 * reads `uri` and `name` from an item, so the walk asks Spotify for exactly
 * those two fields and nothing else. That drops the nested `album`/`artists`
 * payloads a full track object drags in — the reason a 4-source merge of
 * 500-item playlists used to retain megabytes of parsed JSON to build a
 * `uri`/`name` list.
 *
 * `limit` is kept in the projection deliberately even though the walk does
 * not read it for offsets: the client's end-of-data test compares a page's
 * length against `page.limit`, so stripping it would change WHEN a walk
 * stops and silently alter which rows a merge sees. `total` is required for
 * the same reason — without it the truncation verdict degrades to
 * "conservatively truncated".
 */
const MERGE_ITEM_FIELDS = 'items(item(uri,name)),limit,next,total';

/** One source playlist's completed walk, with the verdict that came with it. */
interface SourceWalk {
  /** Rows this source contributed, in playlist order, cut to the source cap. */
  items: PlaylistItemObject[];
  /** Rows are missing — either the cap bound the walk or the server's total outran it. */
  truncated: boolean;
  /** The cap is specifically WHY this walk was truncated (#864). */
  truncatedByCap: boolean;
  /** The source's own row count as Spotify reported it, or null if it reported none. */
  reportedTotal: number | null;
  /** Item-page requests this walk actually spent (#899). */
  requests: number;
}

/**
 * Page every item of a playlist, capped by the configured fetch-all cap.
 * Returns items in playlist order, plus the number of HTTP GETs the walk
 * actually spent (#899) — a walk that stops on a short page has read fewer
 * rows than requests, and the caller is told the cost, not a number derived
 * from the row count.
 *
 * `options.fields` narrows what the server sends per page (#902).
 *
 * The request count comes from the client's own `pages`, not from a counter
 * kept here. #899 already counts the requests at the point they fire inside
 * the walk, which includes a request that returned no page array — a cost
 * against the quota that a count taken from returned pages would miss. A
 * second counter alongside it would be the same duplication #1204 removed for
 * `committed_uris`, and could disagree with the client's.
 *
 * The truncation verdict is TAKEN from `getAllPagesWithTruncation`, not
 * re-derived from the row count. `rows.length > cap` only says "the page
 * overflowed"; it cannot see a walk that stopped on a short page while the
 * server's own `total` still counted more rows (#718/#864), and it discards
 * `reportedTotal` — the only number a multi-source caller can sum into the
 * TRUE combined size of its sources.
 */
async function fetchAllItems(
  client: SpotifyClient,
  ref: string,
  options: { limit?: number; scan_cap?: number; fields?: string } = {},
): Promise<SourceWalk> {
  const id = encodeURIComponent(normalizePlaylistRef(ref));
  const cap = Math.min(options.scan_cap ?? FETCH_ALL_CAP(), FETCH_ALL_CAP());
  const pageLimit = Math.min(options.limit ?? 100, 100);
  const walk = await client.getAllPagesWithTruncation<PlaylistItemObject>(
    `/playlists/${id}/items`,
    {
      limit: String(pageLimit),
      ...(options.fields ? { fields: options.fields } : {}),
    },
    {
      // cap + 1 so the walk can SEE the row that overflows the cap and prove
      // the truncation happened; the +1 is dropped below.
      maxItems: cap + 1,
    },
  );
  const items = walk.items.slice(0, cap);
  return {
    items,
    // The walk's own verdict OR the clip applied here. The two answer
    // different questions and only one of them is a truncation: a walk that
    // read a 2-row source end to end is not truncated, but slicing it to a
    // cap of 1 still drops a row the caller expected. Reporting that as
    // "not truncated" is the clipped-walk-reported-as-complete failure
    // AGENTS.md §6 warns about, so the clip counts too.
    truncated: walk.truncated || walk.items.length > cap,
    truncatedByCap: walk.truncatedByCap,
    reportedTotal: walk.reportedTotal,
    requests: walk.pages,
  };
}

/** The read phase's accounting, summed ACROSS sources. */
interface SourceReadSummary {
  /** Per-source rows, in the order the caller listed the sources. */
  lists: PlaylistItemObject[][];
  /** Item-page requests every source walk together spent. */
  requests: number;
  /** Rows are missing from at least one source. */
  truncated: boolean;
  /** The per-source cap is specifically WHY a walk came back short. */
  truncatedByCap: boolean;
  /** Rows actually read, summed across sources — the cap applies per source. */
  rowsRead: number;
  /**
   * The TRUE combined total the sources hold, summed from the counts Spotify
   * reported, or null when any source reported none. Null means unknown, and
   * it must not be rounded to `rowsRead`: that is exactly the "clipped walk
   * reported as complete" failure from AGENTS.md §6 (#718).
   */
  reportedTotal: number | null;
  /** How many sources fed this summary. */
  sourceCount: number;
}

/**
 * Sum a completed set of source walks.
 *
 * `scan_cap` bounds each SOURCE, so the combined row count is a sum and any
 * verdict phrased in terms of the cap alone understates it by the source
 * count. Accumulating here — once, for every tool in this module — is what
 * keeps `merge_playlists` from reporting a four-source merge clipped to one
 * source's cap as though it had read them all (#902).
 */
function summarizeSourceWalks(walks: SourceWalk[]): SourceReadSummary {
  const totals = walks.map((walk) => walk.reportedTotal);
  return {
    lists: walks.map((walk) => walk.items),
    requests: walks.reduce((n, walk) => n + walk.requests, 0),
    truncated: walks.some((walk) => walk.truncated),
    truncatedByCap: walks.some((walk) => walk.truncatedByCap),
    rowsRead: walks.reduce((n, walk) => n + walk.items.length, 0),
    reportedTotal: totals.every((t): t is number => typeof t === 'number')
      ? totals.reduce((a, b) => a + b, 0)
      : null,
    sourceCount: walks.length,
  };
}

/**
 * The one-line disclosure for a read phase whose source walks came back short.
 *
 * Returns '' when nothing was dropped, so callers can append it
 * unconditionally. When every source reported a total, the line names BOTH
 * the rows actually read and the true combined total the sources hold — a
 * merge of four 500-item playlists under a 100-row cap reads 400 of 2,000,
 * and saying only "reached the cap of 100 rows" would report a tenth of the
 * work as a whole merge. When a source reported no total the sum is unknown,
 * so the line falls back to the per-source cap and says the totals may be
 * incomplete rather than asserting a number nobody reported (#718).
 */
function describeSourceTruncation(read: SourceReadSummary, sourceCap: number): string {
  if (!read.truncated) return '';
  const via =
    read.truncatedByCap
      ? `Source scan stopped at the cap of ${sourceCap} row(s) per source`
      : 'A source walk ended before the last row Spotify reported';
  if (read.reportedTotal === null) {
    return `(${via} across ${read.sourceCount} source playlist(s); ${read.rowsRead} row(s) read, totals may be incomplete.)`;
  }
  const missing = Math.max(0, read.reportedTotal - read.rowsRead);
  return `(${via} across ${read.sourceCount} source playlist(s): read ${read.rowsRead} of ${read.reportedTotal} row(s), so ${missing} row(s) are NOT in this result. Raise scan_cap or narrow the sources to include them.)`;
}

export function registerPlaylistOpsTools(server: McpServer, client: SpotifyClient): void {
  // merge_playlists
  // Exactly one of target_playlist_id / new_name is enforced after playlist
  // input resolution, so conflicting canonical/legacy names fail first.
  // When an existing target is given, semantics are APPEND ONLY — the target
  // is never cleared. Duplicates across sources are dropped, keeping the
  // first-seen order across sources.
  server.registerTool(
    'merge_playlists',
    {
      description:
        'Merge multiple playlists into one. Deduplicates tracks across sources (first-seen order wins) and adds them in batches of 100. Pass target_playlist_id to append to an existing playlist (it is NOT cleared) or new_name to create a fresh playlist.',
      inputSchema: z.object({
        ...playlistListInputFields(['sources'], { min: 1, max: 10, limitReason: 'merge_playlists pages every source before it writes' }),
        target_playlist_id: PlaylistRef.optional().describe('Existing playlist to APPEND into (never cleared)'),
        new_name: z.string().optional().describe('Name for a newly created target playlist'),
        public: z.boolean().optional().describe('Visibility of a NEW playlist. Default: false'),
        ...sharedListFields,
        ...PlaylistWalkFields,
        dry_run: DryRun,
      }),
    },
    async (args) => {
      const input = resolvePlaylistInput(args, { kind: 'list', aliases: ['sources'] });
      const hasTarget = args.target_playlist_id !== undefined;
      const hasNew = args.new_name !== undefined;
      if (hasTarget === hasNew) {
        throw new Error('Invalid arguments: provide exactly one of target_playlist_id (append to existing playlist) or new_name (create a new playlist).');
      }
      // Reads are safe in preview mode: page every source up front so the
      // dry-run preview can state exactly which tracks would be added.
      //
      // #902: the walks start in the SAME tick, so all four sources' first
      // pages are in flight before any source's second page — the read phase
      // interleaves instead of paying each source's full round trip in
      // series. `Promise.all` preserves result order, so the walks are still
      // consumed in the order the caller listed them and the first-seen
      // order across sources is unchanged.
      const sourceRefs = input.values;
      const sourceWalks = await Promise.all(
        sourceRefs.map((ref) => fetchAllItems(client, ref, { ...args, fields: MERGE_ITEM_FIELDS })),
      );
      const sourceCap = Math.min(args.scan_cap ?? FETCH_ALL_CAP(), FETCH_ALL_CAP());
      // #902: one accumulation across every source, so a merge of N capped
      // sources reports N caps' worth of rows and the true combined total
      // rather than a single source's worth.
      const read = summarizeSourceWalks(sourceWalks);
      const { lists: sourceLists, requests: readRequests, truncated, truncatedByCap, rowsRead, reportedTotal } = read;
      // The single sentence both dry_run and the real write append, so the
      // preview and the outcome cannot describe the same walk differently.
      const truncationNote = describeSourceTruncation(read, sourceCap);

      // Dedupe by track key preserving first-seen order across sources.
      const seen = new Set<string>();
      const merged: Array<{ uri: string; name: string }> = [];
      let duplicates = 0;
      let unavailable = 0;
      for (const items of sourceLists) {
        for (const item of items) {
          const track = item.item;
          if (!track) {
            unavailable++;
            continue;
          }
          const key = trackKey(track);
          if (!key || seen.has(key)) {
            duplicates++;
            continue;
          }
          seen.add(key);
          merged.push({ uri: track.uri, name: track.name });
        }
      }

      const creatingNew = args.new_name !== undefined;
      const targetDesc = creatingNew
        ? `new playlist "${args.new_name}"`
        : args.target_playlist_id!;

      // Issue #57/#79: deterministic preview, no mutating call is made.
      if (args.dry_run) {
        const changes =
          merged.length > 0
            ? [
                creatingNew
                  ? `Would create ${args.public ? 'public' : 'private'} playlist "${args.new_name}" and add ${merged.length} track(s):`
                  : `Would append ${merged.length} track(s) to playlist ${targetDesc}:`,
                ...merged.map((t) => `  - ${t.uri} "${t.name}"`),
              ]
            : [`No unique tracks found across ${sourceRefs.length} source playlist(s); nothing would be added.`];
        return textResult(
          withPlaylistInputNote(
            `[dry run] merge_playlists — nothing was changed.\n${changes.join('\n')}` +
              (duplicates > 0 ? `\n(${duplicates} duplicate(s) across sources would be skipped)` : '') +
              (truncationNote ? `\n${truncationNote}` : '') +
              // #899: a dry run walks every source for real, so it spends the
              // read budget a real merge would. A preview that hid that would
              // understate the cost of the call it is previewing. Kept
              // unconditional — the truncation note above only speaks when
              // rows were dropped, but the read cost is incurred either way.
              `\n(Read cost: ${readRequests} paged read request(s) across ${sourceRefs.length} source playlist(s).)`,
            input,
          ),
          withPlaylistInputMetadata({
            ok: true,
            dry_run: true,
            changes,
            playlists: sourceRefs,
            truncated,
            truncated_by_cap: truncatedByCap,
            rows_read: rowsRead,
            reported_total: reportedTotal,
            scan_cap: sourceCap,
            requests_read: readRequests,
          }, input),
        );
      }

      // Resolve/create the target.
      let targetId: string;
      if (creatingNew) {
        const created = await client.post<{ id: string }>('/me/playlists', {
          name: args.new_name,
          public: args.public ?? false,
        });
        if (!created?.id) throw new Error('Could not create playlist');
        targetId = created.id;
      } else {
        targetId = normalizePlaylistRef(args.target_playlist_id!);
      }

      // Append in batches of 100 (Spotify's per-request URI cap).
      const itemsPath = `/playlists/${encodeURIComponent(targetId)}/items`;
      const mergedUris = merged.map((t) => t.uri);
      const writeCap = capFor('playlist_writes');
      // #865: a merge that dies on batch N leaves the target holding a
      // partial merge. Report the committed prefix so a retry resumes at the
      // right offset instead of re-appending everything already there.
      const write = await runChunkedPlaylistWrite(mergedUris, writeCap, (chunk) =>
        client.post<{ snapshot_id?: string }>(itemsPath, { uris: chunk }),
      );
      if (!write.ok) {
        const committedCount = write.committed_uris;
        const lastUri = write.last_committed_chunk_uris[write.last_committed_chunk_uris.length - 1];
        const prose = write.failed_chunk_index === 0
          ? `merge_playlists aborted before any track landed on playlist ${targetId}: ${write.error}. Nothing was merged.`
          : `Partial merge into playlist ${targetId}: chunks 1–${write.failed_chunk_index} committed (${committedCount} track(s)), batch ${write.failed_chunk_index + 1} of ${write.attempted_chunks} failed.${lastUri ? ` Last URI committed: ${lastUri}.` : ''} Retry the remaining ${mergedUris.length - committedCount} track(s); the committed prefix is already on the playlist. (${write.error})`;
        // #1204: `...write` already carries `committed_uris` as the running
        // total across every committed chunk, so this site does NOT override
        // it — re-deriving the number here is what #1204 removed.
        const payload = withPlaylistInputMetadata({ ...write, target_playlist: targetId, attempted_uris: mergedUris.length, remaining_uris: mergedUris.length - committedCount, playlists: sourceRefs, duplicates_skipped: duplicates, unavailable_items_skipped: unavailable, truncated, truncated_by_cap: truncatedByCap, rows_read: rowsRead, reported_total: reportedTotal, scan_cap: sourceCap, requests_read: readRequests, created_new_playlist: creatingNew }, input);
        return textResult(args.response_format === 'json' ? jsonText(payload) : withPlaylistInputNote(prose, input), payload);
      }
      const snapshotId = write.snapshot_id;
      const requestCount = write.chunks;

      const summary = {
        ok: true,
        dry_run: args.dry_run ?? false,
        truncated,
        truncated_by_cap: truncatedByCap,
        rows_read: rowsRead,
        reported_total: reportedTotal,
        scan_cap: sourceCap,
        limit: args.limit ?? null,
        target_playlist: targetId,
        created_new_playlist: creatingNew,
        playlists: sourceRefs,
        added: merged.length,
        duplicates_skipped: duplicates,
        unavailable_items_skipped: unavailable,
        requests_read: readRequests,
        batches_sent: requestCount,
        ...(snapshotId ? { snapshot_id: snapshotId } : {}),
      };

      if (args.response_format === 'json') {
        const payload = withPlaylistInputMetadata(summary, input);
        return textResult(jsonText(payload), payload);
      }

      const lines = [
        `Merged ${merged.length} unique track(s) into ${creatingNew ? 'new playlist' : 'playlist'} ${targetId}` +
          ` across ${requestCount} batch request(s)` +
          ` (after ${readRequests} source page request(s))` +
          (duplicates > 0 ? `; skipped ${duplicates} duplicate(s)` : '') +
          (unavailable > 0 ? `, ${unavailable} unavailable item(s)` : '') +
          `. Read cost: ${readRequests} paged read request(s) across ${sourceRefs.length} source playlist(s).`,
        batchSummary(merged.length, merged.map((t) => t.uri)),
      ];
      const view = truncateItems(
        merged.map((t) => `${t.uri} "${t.name}"`),
        resolveMaxResults(args.max_results),
      );
      if (view.items.length > 0) {
        lines.push('');
        lines.push(...view.items.map((row) => `  • ${row}`));
        if (view.footer) lines.push(`(${view.footer})`);
      }
      if (truncationNote) lines.push(truncationNote);
      const summaryText = lines.join('\n');
      return textResult(
        withPlaylistInputNote(snapshotId ? `${summaryText}\nSnapshot ID: ${snapshotId}` : summaryText, input),
        withPlaylistInputMetadata(summary, input),
      );
    },
  );

  // diff_playlists
  server.tool(
    'diff_playlists',
    'Compare two playlists up to the configured source cap: tracks only in A, only in B (by track ID), and tracks present in both but at different positions. Rendered rows are capped by max_results; truncation metadata reports when source walks hit scan_cap.',
    {
      ...sharedListFields,
      ...PlaylistWalkFields,
      ...PlaylistPairFields,
      ...legacyPlaylistPairFields([['a', 'b']]),
      dry_run: DryRun,
    },
    async (args) => {
      const input = resolvePlaylistInput(args, { kind: 'pair', aliases: [['a', 'b']] });
      const [playlistA, playlistB] = input.values;
      // This tool never mutates anything, so dry_run changes nothing; it is
      // accepted so agents can pass it uniformly across the family.
      const [aWalk, bWalk] = await Promise.all([
        fetchAllItems(client, playlistA, args),
        fetchAllItems(client, playlistB, args),
      ]);
      const aItems = aWalk.items;
      const bItems = bWalk.items;
      const sourceCap = Math.min(args.scan_cap ?? FETCH_ALL_CAP(), FETCH_ALL_CAP());
      const read = summarizeSourceWalks([aWalk, bWalk]);
      // #899: both sides are walked in parallel, so the cost is their sum.
      const { requests: requestsRead, truncated } = read;
      const truncationNote = describeSourceTruncation(read, sourceCap);

      // First-occurrence position map over track IDs.
      const posA = new Map<string, number>();
      const idsA: string[] = [];
      aItems.forEach((item, i) => {
        const id = item.item?.id;
        if (!id) return;
        idsA.push(id);
        if (!posA.has(id)) posA.set(id, i);
      });
      const posB = new Map<string, number>();
      const idsB: string[] = [];
      bItems.forEach((item, i) => {
        const id = item.item?.id;
        if (!id) return;
        idsB.push(id);
        if (!posB.has(id)) posB.set(id, i);
      });

      const setB = new Set(idsB);
      const setA = new Set(idsA);
      const onlyInA = idsA.filter((id) => !setB.has(id));
      const onlyInB = idsB.filter((id) => !setA.has(id));
      const moved: Array<{ id: string; a_position: number; b_position: number }> = [];
      for (const [id, aPos] of posA) {
        const bPos = posB.get(id);
        if (bPos !== undefined && bPos !== aPos) {
          moved.push({ id, a_position: aPos, b_position: bPos });
        }
      }
      moved.sort((x, y) => x.a_position - y.a_position);

      const cap = resolveMaxResults(args.max_results);
      const renderedCount = Math.min(onlyInA.length, cap) + Math.min(onlyInB.length, cap) + Math.min(moved.length, cap);
      const truncation = { returned: renderedCount, total: onlyInA.length + onlyInB.length + moved.length };
      if (args.response_format === 'json') {
        const payload = withPlaylistInputMetadata({
          ok: true,
          dry_run: args.dry_run ?? false,
          truncated,
          scan_cap: sourceCap,
          playlist_a: playlistA,
          playlist_b: playlistB,
          a_total: idsA.length,
          b_total: idsB.length,
          only_in_a: onlyInA,
          only_in_b: onlyInB,
          moved,
          truncation,
          requests_read: requestsRead,
        }, input);
        return textResult(jsonText(payload), payload);
      }

      // Rendered rows are capped per section; the counts stay exact (#53).
      const section = (title: string, rows: string[]): string[] => {
        const view = truncateItems(rows, cap);
        const out = ['', `${title} (${rows.length}):`];
        if (view.items.length === 0) out.push('  (none)');
        else out.push(...view.items.map((r) => `  • ${r}`));
        if (view.footer) out.push(`(${view.footer})`);
        return out;
      };

      const lines = [
        `Diff between A (playlist_a=${playlistA}, ${idsA.length} tracks) and B (playlist_b=${playlistB}, ${idsB.length} tracks)`,
        ...section('Only in A', onlyInA.map((id) => `${id} @ position ${posA.get(id)}`)),
        ...section('Only in B', onlyInB.map((id) => `${id} @ position ${posB.get(id)}`)),
        ...section(
          'Moved (same track, different position)',
          moved.map((m) => `${m.id} @ A:${m.a_position} → B:${m.b_position}`),
        ),
      ];
      if (truncationNote) lines.push(truncationNote);
      // #899: the read cost is incurred whether or not rows were dropped.
      lines.push(`(Read cost: ${requestsRead} paged read request(s) across both playlists.)`);
      return textResult(withPlaylistInputNote(lines.join('\n'), input), withPlaylistInputMetadata({
        ok: true,
        dry_run: args.dry_run ?? false,
        truncated,
        scan_cap: sourceCap,
        playlist_a: playlistA,
        playlist_b: playlistB,
        a_total: idsA.length,
        b_total: idsB.length,
        only_in_a: onlyInA,
        only_in_b: onlyInB,
        moved,
        truncation,
        requests_read: requestsRead,
      }, input));
    },
  );

  // overlap_playlists
  server.tool(
    'overlap_playlists',
    'Find tracks shared across playlists: reports how many playlists each track appears in and lists tracks present in at least min_overlap playlists (default: all of them), most-shared first.',
    {
      ...sharedListFields,
      ...PlaylistWalkFields,
      ...PlaylistListFields,
      min_overlap: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Minimum number of playlists a track must appear in. Default: all playlists'),
      dry_run: DryRun,
    },
    async (args) => {
      // Read-only analysis; dry_run is accepted for uniformity and is a no-op.
      const input = resolvePlaylistInput(args, { kind: 'list', aliases: [] });
      const refs = input.values;
      if (args.min_overlap !== undefined && args.min_overlap > refs.length) {
        throw new Error(
          `min_overlap (${args.min_overlap}) cannot exceed the number of playlists (${refs.length})`,
        );
      }
      const threshold = args.min_overlap ?? refs.length;

      // One full paging pass keeps both the presence sets and display names.
      const read = summarizeSourceWalks(
        await Promise.all(refs.map((ref) => fetchAllItems(client, ref, args))),
      );
      const itemLists = read.lists;
      // #899: this tool is read-only, so the walk IS the cost of the call.
      const { requests: requestsRead } = read;
      const sourceCap = Math.min(args.scan_cap ?? FETCH_ALL_CAP(), FETCH_ALL_CAP());
      const { truncated } = read;
      const truncationNote = describeSourceTruncation(read, sourceCap);
      // One pass records presence and, at the same time, the display name each
      // track is FIRST seen under (#903). First-seen-wins is exactly what the
      // old per-entry scan did — it walked itemLists in order and took the
      // first `find` hit — so the resolved name is unchanged, without the
      // O(shared x playlists x items) rescan.
      const presence: Set<string>[] = [];
      const firstNameById = new Map<string, string>();
      for (const items of itemLists) {
        const ids = new Set<string>();
        for (const item of items) {
          const track = item.item;
          if (!track) continue;
          const id = track.id;
          if (!id) continue;
          ids.add(id);
          if (!firstNameById.has(id)) firstNameById.set(id, track.name);
        }
        presence.push(ids);
      }

      interface Shared {
        id: string;
        name: string;
        count: number;
        firstSeen: number;
      }
      const counts = new Map<string, Shared>();
      let firstSeen = 0;
      for (const ids of presence) {
        for (const id of ids) {
          const entry = counts.get(id);
          if (entry) entry.count++;
          else counts.set(id, { id, name: firstNameById.get(id) ?? '', count: 1, firstSeen: firstSeen++ });
        }
      }

      const shared = [...counts.values()]
        .filter((e) => e.count >= threshold)
        .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen);

      const cap = resolveMaxResults(args.max_results);
      const view = truncateItems(
        shared.map((e) => `${e.id}${e.name ? ` "${e.name}"` : ''} — in ${e.count}/${refs.length} playlists`),
        cap,
      );
      const truncation = { returned: view.items.length, total: shared.length };
      if (args.response_format === 'json') {
        const payload = withPlaylistInputMetadata({
          ok: true,
          dry_run: args.dry_run ?? false,
          truncated,
          scan_cap: sourceCap,
          playlists: refs,
          threshold,
          total_shared: shared.length,
          shared: shared.map(({ id, name, count }) => ({ id, name, count })),
          truncation,
          requests_read: requestsRead,
        }, input);
        return textResult(jsonText(payload), payload);
      }

      const lines = [
        `Tracks present in at least ${threshold} of ${refs.length} playlists: ${shared.length}`,
        ...(view.items.length > 0 ? view.items.map((row) => `  • ${row}`) : ['  (none)']),
      ];
      if (view.footer) lines.push(`(${view.footer})`);
      if (truncationNote) lines.push(truncationNote);
      // #899: read-only, so this is the whole cost of the call. Unconditional —
      // the truncation note above only speaks when rows were dropped.
      lines.push(`(Read cost: ${requestsRead} paged read request(s) across ${refs.length} playlist(s).)`);
      return textResult(withPlaylistInputNote(lines.join('\n'), input), withPlaylistInputMetadata({
        ok: true,
        dry_run: args.dry_run ?? false,
        truncated,
        scan_cap: sourceCap,
        playlists: refs,
        threshold,
        total_shared: shared.length,
        shared: shared.map(({ id, name, count }) => ({ id, name, count })),
        truncation,
        requests_read: requestsRead,
      }, input));
    },
  );
}
