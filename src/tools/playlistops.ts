/**
 * Playlist power tools (#96): merge_playlists, diff_playlists, overlap_playlists.
 * All three accept playlist references as a bare ID or a spotify:playlist: URI
 * (normalized locally), share response_format/max_results shaping (#51/#53),
 * and expose dry_run (#57). Reads are always safe; only merge_playlists
 * mutates, and its dry_run previews page the sources but never POSTs.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  DryRun,
  batchSummary,
  parseSpotifyUri,
  resolveMaxResults,
  sharedListFields,
  truncateItems,
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
 * Page every item of a playlist through client.getAllPages, capped by the
 * configured fetch-all cap. Returns items in playlist order.
 */
async function fetchAllItems(
  client: SpotifyClient,
  ref: string,
): Promise<PlaylistItemObject[]> {
  const id = encodeURIComponent(normalizePlaylistRef(ref));
  return client.getAllPages<PlaylistItemObject>(
    `/playlists/${id}/items`,
    { limit: '100' },
    { maxItems: FETCH_ALL_CAP() },
  );
}

export function registerPlaylistOpsTools(server: McpServer, client: SpotifyClient): void {
  // merge_playlists
  // Exactly one of target_playlist_id / new_name is enforced via superRefine.
  // When an existing target is given, semantics are APPEND ONLY — the target
  // is never cleared. Duplicates across sources are dropped, keeping the
  // first-seen order across sources.
  server.registerTool(
    'merge_playlists',
    {
      description:
        'Merge multiple playlists into one. Deduplicates tracks across sources (first-seen order wins) and adds them in batches of 100. Pass target_playlist_id to append to an existing playlist (it is NOT cleared) or new_name to create a fresh playlist.',
      inputSchema: z
        .object({
          sources: z
            .array(z.string())
            .min(1)
            .describe('Source playlists as IDs or spotify:playlist: URIs'),
          target_playlist_id: z
            .string()
            .optional()
            .describe('Existing playlist to APPEND into (never cleared), as ID or spotify:playlist: URI'),
          new_name: z.string().optional().describe('Name for a newly created target playlist'),
          public: z.boolean().optional().describe('Visibility of a NEW playlist. Default: false'),
          ...sharedListFields,
          dry_run: DryRun,
        })
        .superRefine((args, ctx) => {
          const hasTarget = args.target_playlist_id !== undefined;
          const hasNew = args.new_name !== undefined;
          if (hasTarget === hasNew) {
            ctx.addIssue({
              code: 'custom',
              path: [hasTarget ? 'new_name' : 'target_playlist_id'],
              message:
                'Provide exactly one of target_playlist_id (append to existing playlist) or new_name (create a new playlist).',
            });
          }
        }),
    },
    async (args) => {
      // Reads are safe in preview mode: page every source up front so the
      // dry-run preview can state exactly which tracks would be added.
      const sourceRefs = args.sources.map(normalizePlaylistRef);
      const sourceLists: PlaylistItemObject[][] = [];
      for (const ref of sourceRefs) {
        sourceLists.push(await fetchAllItems(client, ref));
      }

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
          `[dry run] merge_playlists — nothing was changed.\n${changes.join('\n')}` +
            (duplicates > 0 ? `\n(${duplicates} duplicate(s) across sources would be skipped)` : ''),
          { ok: true, dry_run: true, changes },
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
      let snapshotId: string | undefined;
      let requestCount = 0;
      for (let start = 0; start < merged.length; start += 100) {
        const res = await client.post<{ snapshot_id?: string }>(itemsPath, {
          uris: merged.slice(start, start + 100).map((t) => t.uri),
        });
        requestCount++;
        if (res?.snapshot_id) snapshotId = res.snapshot_id;
      }

      const summary = {
        target_playlist: targetId,
        created_new_playlist: creatingNew,
        sources: sourceRefs,
        added: merged.length,
        duplicates_skipped: duplicates,
        unavailable_items_skipped: unavailable,
        batches_sent: requestCount,
        ...(snapshotId ? { snapshot_id: snapshotId } : {}),
      };

      if (args.response_format === 'json') {
        return textResult(jsonText(summary));
      }

      const lines = [
        `Merged ${merged.length} unique track(s) into ${creatingNew ? 'new playlist' : 'playlist'} ${targetId}` +
          ` across ${requestCount} batch request(s)` +
          (duplicates > 0 ? `; skipped ${duplicates} duplicate(s)` : '') +
          (unavailable > 0 ? `, ${unavailable} unavailable item(s)` : '') +
          '.',
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
      const summaryText = lines.join('\n');
      return textResult(
        snapshotId ? `${summaryText}\nSnapshot ID: ${snapshotId}` : summaryText,
      );
    },
  );

  // diff_playlists
  server.tool(
    'diff_playlists',
    'Compare two playlists fully paged: tracks only in A, only in B (by track ID), and tracks present in both but at different positions. Rendered rows are capped by max_results; totals are always accurate.',
    {
      ...sharedListFields,
      a: z.string().describe('First playlist, as ID or spotify:playlist: URI'),
      b: z.string().describe('Second playlist, as ID or spotify:playlist: URI'),
      dry_run: DryRun,
    },
    async (args) => {
      // This tool never mutates anything, so dry_run changes nothing; it is
      // accepted so agents can pass it uniformly across the family.
      const [aItems, bItems] = await Promise.all([
        fetchAllItems(client, args.a),
        fetchAllItems(client, args.b),
      ]);

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

      if (args.response_format === 'json') {
        return textResult(jsonText({
          a_total: idsA.length,
          b_total: idsB.length,
          only_in_a: onlyInA,
          only_in_b: onlyInB,
          moved,
        }));
      }

      // Rendered rows are capped per section; the counts stay exact (#53).
      const cap = resolveMaxResults(args.max_results);
      const section = (title: string, rows: string[]): string[] => {
        const view = truncateItems(rows, cap);
        const out = ['', `${title} (${rows.length}):`];
        if (view.items.length === 0) out.push('  (none)');
        else out.push(...view.items.map((r) => `  • ${r}`));
        if (view.footer) out.push(`(${view.footer})`);
        return out;
      };

      const lines = [
        `Diff between A (${idsA.length} tracks) and B (${idsB.length} tracks)`,
        ...section('Only in A', onlyInA.map((id) => `${id} @ position ${posA.get(id)}`)),
        ...section('Only in B', onlyInB.map((id) => `${id} @ position ${posB.get(id)}`)),
        ...section(
          'Moved (same track, different position)',
          moved.map((m) => `${m.id} @ A:${m.a_position} → B:${m.b_position}`),
        ),
      ];
      return textResult(lines.join('\n'));
    },
  );

  // overlap_playlists
  server.tool(
    'overlap_playlists',
    'Find tracks shared across playlists: reports how many playlists each track appears in and lists tracks present in at least min_overlap playlists (default: all of them), most-shared first.',
    {
      ...sharedListFields,
      playlists: z
        .array(z.string())
        .min(2)
        .describe('Two or more playlists, as IDs or spotify:playlist: URIs'),
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
      const refs = args.playlists.map(normalizePlaylistRef);
      if (args.min_overlap !== undefined && args.min_overlap > refs.length) {
        throw new Error(
          `min_overlap (${args.min_overlap}) cannot exceed the number of playlists (${refs.length})`,
        );
      }
      const threshold = args.min_overlap ?? refs.length;

      // One full paging pass keeps both the presence sets and display names.
      const itemLists: PlaylistItemObject[][] = [];
      for (const ref of refs) {
        itemLists.push(await fetchAllItems(client, ref));
      }
      const presence = itemLists.map((items) => {
        const ids = new Set<string>();
        for (const item of items) {
          const id = item.item?.id;
          if (id) ids.add(id);
        }
        return ids;
      });

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
          else counts.set(id, { id, name: '', count: 1, firstSeen: firstSeen++ });
        }
      }

      const shared = [...counts.values()]
        .filter((e) => e.count >= threshold)
        .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen);
      for (const entry of shared) {
        for (const items of itemLists) {
          const hit = items.find((i) => i.item?.id === entry.id);
          if (hit?.item) {
            entry.name = hit.item.name;
            break;
          }
        }
      }

      if (args.response_format === 'json') {
        return textResult(jsonText({
          playlists: refs,
          threshold,
          total_shared: shared.length,
          shared: shared.map(({ id, name, count }) => ({ id, name, count })),
        }));
      }

      const view = truncateItems(
        shared.map((e) =>
          `${e.id}${e.name ? ` "${e.name}"` : ''} — in ${e.count}/${refs.length} playlists`,
        ),
        resolveMaxResults(args.max_results),
      );
      const lines = [
        `Tracks present in at least ${threshold} of ${refs.length} playlists: ${shared.length}`,
        ...(view.items.length > 0 ? view.items.map((row) => `  • ${row}`) : ['  (none)']),
      ];
      if (view.footer) lines.push(`(${view.footer})`);
      return textResult(lines.join('\n'));
    },
  );
}
