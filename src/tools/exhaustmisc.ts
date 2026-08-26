/**
 * exhaustmisc — mop-up for the 60-issue exhaustive sweep.
 * Implements the final 10 tools not covered by the other 3 streams:
 * 3 truly missing from ship 52-60 (search_within_playlist, search_history_stats,
 * audiobook_progress) + 7 high-value deferred (unsave_orphan_tracks,
 * playlist_to_library, followed_playlists_audit, get_playlist_added_dates,
 * split_playlist, find_duplicate_tracks_across_playlists,
 * remove_from_library_by_playlist).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  ResponseFormat,
  MaxResults,
  DryRun,
  sharedListFields,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
  describeDryRun,
  batchSummary,
  type ResponseFormatValue,
} from '../shaping.js';
import type { PlaylistItemObject, SpotifyPaged } from '../types/spotify.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type ToolOut = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };

function textResult(text: string, structured?: Record<string, unknown>): ToolOut {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}
function emit(fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolOut {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}
function cap(args: { max_results?: number }): number {
  return resolveMaxResults(args.max_results);
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerExhaustMiscTools(server: McpServer, client: SpotifyClient): void {
  // 1. search_within_playlist (#310) — text search inside one playlist (scout-b C1)
  server.tool(
    'search_within_playlist',
    'Text search inside a single playlist (client-side filter over full item walk). Quota: 🟢 GET /playlists/{id}/items paged.',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      query: z.string().min(1).describe('Substring to match against track/episode name, artist, album'),
      market: z.string().optional().describe('Market for track relinking'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const q = args.query.toLowerCase();
      const params: Record<string, string> = { limit: '50' };
      if (args.market) params.market = args.market;
      const all = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(args.playlist_id)}/items`, params);
      const matched = all.filter((row) => {
        const item = row.item as unknown as Record<string, unknown> | null;
        if (!item) return false;
        const name = typeof item.name === 'string' ? item.name.toLowerCase() : '';
        if (name.includes(q)) return true;
        const artists = (item as { artists?: Array<{ name: string }> }).artists;
        if (Array.isArray(artists) && artists.some((a) => a.name.toLowerCase().includes(q))) return true;
        const album = (item as { album?: { name: string } }).album;
        if (album && typeof album.name === 'string' && album.name.toLowerCase().includes(q)) return true;
        const show = (item as { show?: { name: string } }).show;
        if (show && typeof show.name === 'string' && show.name.toLowerCase().includes(q)) return true;
        return false;
      });
      const t = truncateItems(matched, cap(args));
      const pagination = paginationInfo({ total: matched.length, returned: t.items.length });
      const lines: string[] = [
        `Search within playlist ${args.playlist_id}: "${args.query}" — ${matched.length} match(es) of ${all.length} items, showing ${t.items.length}:`,
      ];
      for (let i = 0; i < t.items.length; i++) {
        const row = t.items[i];
        const item = row.item as unknown as Record<string, unknown> | null;
        const name = item && typeof item.name === 'string' ? (item.name as string) : 'unknown';
        const uri = item && typeof item.uri === 'string' ? (item.uri as string) : '';
        lines.push(`  ${i + 1}. ${name} — ${uri}`);
      }
      if (t.footer) lines.push(`(${t.footer})`);
      const structured: Record<string, unknown> = listStructuredContent(t.items as unknown as Record<string, unknown>[], pagination, {
        playlist_id: args.playlist_id,
        query: args.query,
        scanned: all.length,
        matched: matched.length,
      });
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(lines.join('\n'), structured);
    },
  );

  // 2. search_history_stats (#315) — analytics over search sidecar (scout-c C5)
  server.tool(
    'search_history_stats',
    'Analytics over the local search-history sidecar: top queries, type breakdown, recency. Quota: 🟢 local only (no API).',
    {
      top_n: z.number().int().min(1).max(50).optional().describe('Top N queries to show (default 10)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const n = args.top_n ?? 10;
      // Reuse searchhistory sidecar path
      const { searchHistoryFile } = await import('./searchhistory.js');
      const file = searchHistoryFile();
      let entries: Array<{ query: string; types?: string[]; timestamp: string }> = [];
      try {
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(file, 'utf8');
        entries = JSON.parse(raw) as typeof entries;
        if (!Array.isArray(entries)) entries = [];
      } catch {
        entries = [];
      }
      const total = entries.length;
      const byQuery = new Map<string, number>();
      const byType = new Map<string, number>();
      for (const e of entries) {
        byQuery.set(e.query, (byQuery.get(e.query) ?? 0) + 1);
        const types = e.types ?? ['unknown'];
        for (const t of types) byType.set(t, (byType.get(t) ?? 0) + 1);
      }
      const topQueries = [...byQuery.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([query, count]) => ({ query, count }));
      const typeBreakdown = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
      const recent = entries.slice(-5).reverse().map((e) => ({ query: e.query, timestamp: e.timestamp }));
      const structured: Record<string, unknown> = { total, top_queries: topQueries, type_breakdown: typeBreakdown, recent };
      const lines: string[] = [`Search history stats: ${total} searches.`];
      if (topQueries.length) {
        lines.push(`Top queries:`);
        for (const q of topQueries) lines.push(`  "${q.query}" — ${q.count}`);
      }
      if (typeBreakdown.length) lines.push(`By type: ${typeBreakdown.map((t) => `${t.type}:${t.count}`).join(', ')}`);
      if (recent.length) lines.push(`Recent: ${recent.map((r) => `"${r.query}" @ ${r.timestamp}`).join('; ')}`);
      if (total === 0) lines.push('(no search history yet — run search or search_tracks etc. first)');
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(lines.join('\n'), structured);
    },
  );

  // 3. audiobook_progress (#316) — book-level progress rollup (scout-c C7)
  server.tool(
    'audiobook_progress',
    'Audiobook progress rollup: chapters total, played count, current chapter, percent complete. Quota: 🟡 2 GETs (audiobook + chapters).',
    {
      audiobook_id: z.string().min(1).describe('Audiobook ID'),
      market: z.string().optional().describe('Market'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const encId = encodeURIComponent(args.audiobook_id);
      const params: Record<string, string> | undefined = args.market ? { market: args.market } : undefined;
      const audiobook = await client.get<{
        id: string;
        name: string;
        total_chapters: number;
      }>(`/audiobooks/${encId}`, params);
      if (!audiobook) throw new Error('Audiobook not found');
      const chaptersRes = await client.get<SpotifyPaged<{ id: string; chapter_number: number; name: string; resume_point?: { fully_played: boolean } }>>(
        `/audiobooks/${encId}/chapters`,
        { limit: '50', ...(args.market ? { market: args.market } : {}) },
      );
      const chapters = chaptersRes?.items ?? [];
      const played = chapters.filter((c) => c.resume_point?.fully_played).length;
      const total = audiobook.total_chapters ?? chapters.length;
      const pct = total > 0 ? Math.round((played / total) * 100) : 0;
      const nextUnplayed = chapters.find((c) => !c.resume_point?.fully_played) ?? null;
      const structured: Record<string, unknown> = {
        audiobook_id: audiobook.id,
        name: audiobook.name,
        total_chapters: total,
        played_chapters: played,
        percent_complete: pct,
        next_unplayed: nextUnplayed ? { id: nextUnplayed.id, chapter_number: nextUnplayed.chapter_number, name: nextUnplayed.name } : null,
      };
      const text = `Audiobook "${audiobook.name}": ${played}/${total} chapters played (${pct}%).${nextUnplayed ? ` Next: Ch. ${nextUnplayed.chapter_number} "${nextUnplayed.name}"` : ' All played.'}`;
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(text, structured);
    },
  );

  // 4. unsave_orphan_tracks — delete saved tracks not in any playlist
  server.tool(
    'unsave_orphan_tracks',
    'Find saved tracks that appear in no playlist (orphans) and optionally unsave them. Quota: 🟡 walks library + all playlists (capped). Destructive when dry_run=false.',
    {
      dry_run: DryRun,
      max_remove: z.number().int().min(1).max(5000).optional().describe('Max orphans to remove (default 50)'),
      scan_cap: z.number().int().min(1).max(5000).optional().describe('Max saved tracks to scan (default fetchAllCap)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const maxRemove = args.max_remove ?? 50;
      const scanCap = args.scan_cap ?? getConfig().fetchAllCap;
      type SavedTrack = { track: { uri: string; id: string; name: string } };
      const saved = await client.getAllPages<SavedTrack>('/me/tracks', { limit: '50' }, { maxItems: scanCap });
      // Collect all playlist URIs
      const playlists = await client.getAllPages<{ id: string }>('/me/playlists', { limit: '50' });
      const playlistUris = new Set<string>();
      for (const pl of playlists) {
        try {
          const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(pl.id)}/items`, { limit: '50' });
          for (const row of items) {
            const track = row.item as unknown as Record<string, unknown> | null;
            const uri = track && typeof track.uri === 'string' ? (track.uri as string) : null;
            if (uri) playlistUris.add(uri);
          }
        } catch { /* skip inaccessible playlists */ }
      }
      const orphans = saved.filter((s) => !playlistUris.has(s.track.uri)).slice(0, maxRemove);
      const orphanUris = orphans.map((o) => o.track.uri);
      const structured: Record<string, unknown> = {
        scanned: saved.length,
        playlists_scanned: playlists.length,
        orphan_count: orphans.length,
        orphans: orphans.map((o) => ({ uri: o.track.uri, name: o.track.name })),
        dry_run: dryRun,
      };
      if (dryRun) {
        const lines = [describeDryRun('unsave orphan tracks', `${orphans.length} orphan(s) of ${saved.length} saved`, orphanUris)];
        if (orphans.length) lines.push(orphans.map((o) => `  - ${o.track.name} (${o.track.uri})`).join('\n'));
        if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
        return textResult(lines.join('\n'), structured);
      }
      if (orphanUris.length === 0) {
        if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
        return textResult('No orphan tracks to remove.', structured);
      }
      // Spotify DELETE /me/tracks?ids= takes comma-separated ids
      const ids = orphans.map((o) => o.track.id).join(',');
      await client.delete(`/me/tracks?ids=${ids}`);
      const text = `Removed ${orphans.length} orphan track(s): ${batchSummary(orphans.length, orphanUris)}`;
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(text, structured);
    },
  );

  // 5. playlist_to_library — save all tracks of a playlist to Liked Songs
  server.tool(
    'playlist_to_library',
    'Save all tracks of a playlist to your Liked Songs (library). Quota: 🟢 GET playlist items + PUT /me/tracks (chunked 50).',
    {
      playlist_id: z.string().min(1).describe('Source playlist ID'),
      dry_run: DryRun,
      dedupe: z.boolean().optional().describe('Skip tracks already saved (default true)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const dedupe = args.dedupe ?? true;
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(args.playlist_id)}/items`, { limit: '50' });
      const trackUris = items
        .map((row) => (row.item as unknown as Record<string, unknown> | null))
        .filter((t): t is Record<string, unknown> => t !== null && typeof t.uri === 'string' && (t.uri as string).startsWith('spotify:track:'))
        .map((t) => t.uri as string);
      const ids = trackUris.map((u) => u.split(':').pop()!);
      let toSave = ids;
      let skipped = 0;
      if (dedupe && ids.length > 0) {
        // Check which are already saved (batch 50)
        const already = new Set<string>();
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          const res = await client.get<boolean[]>(`/me/tracks/contains`, { ids: chunk.join(',') });
          if (Array.isArray(res)) chunk.forEach((id, idx) => { if (res[idx]) already.add(id); });
        }
        toSave = ids.filter((id) => !already.has(id));
        skipped = ids.length - toSave.length;
      }
      const structured: Record<string, unknown> = {
        playlist_id: args.playlist_id,
        total_in_playlist: trackUris.length,
        to_save: toSave.length,
        skipped_already_saved: skipped,
        dry_run: dryRun,
      };
      if (dryRun) {
        const text = describeDryRun('save playlist tracks to library', `playlist ${args.playlist_id}`, toSave.map((id) => `spotify:track:${id}`));
        const detail = `Would save ${toSave.length} track(s), skip ${skipped} already saved.`;
        if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
        return textResult(`${text}\n${detail}`, structured);
      }
      if (toSave.length === 0) {
        if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
        return textResult(`All ${trackUris.length} tracks already saved — nothing to do.`, structured);
      }
      for (let i = 0; i < toSave.length; i += 50) {
        const chunk = toSave.slice(i, i + 50);
        await client.put('/me/tracks', { ids: chunk });
      }
      const text = `Saved ${toSave.length} track(s) from playlist ${args.playlist_id} to library (skipped ${skipped}).`;
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(text, structured);
    },
  );

  // 6. followed_playlists_audit
  server.tool(
    'followed_playlists_audit',
    'Inventory of followed vs owned playlists: counts, collab, public, follower totals. Quota: 🟢 GET /me/playlists paged.',
    {
      only_followed: z.boolean().optional().describe('Only followed (not owned) playlists (default false)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const me = await client.get<{ id: string }>('/me');
      const myId = me?.id ?? '';
      const all = await client.getAllPages<{
        id: string;
        name: string;
        owner: { id: string };
        collaborative: boolean;
        public: boolean | null;
        tracks: { total: number };
      }>('/me/playlists', { limit: '50' });
      const owned = all.filter((p) => p.owner.id === myId);
      const followed = all.filter((p) => p.owner.id !== myId);
      const list = args.only_followed ? followed : all;
      const t = truncateItems(list, cap(args));
      const pagination = paginationInfo({ total: list.length, returned: t.items.length });
      const collabCount = list.filter((p) => p.collaborative).length;
      const structured: Record<string, unknown> = listStructuredContent(
        t.items as unknown as Record<string, unknown>[],
        pagination,
        { total_playlists: all.length, owned: owned.length, followed: followed.length, collaborative: collabCount },
      );
      const text = `Playlists audit: ${all.length} total — ${owned.length} owned, ${followed.length} followed, ${collabCount} collaborative. Showing ${t.items.length}.`;
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(text, structured);
    },
  );

  // 7. get_playlist_added_dates
  server.tool(
    'get_playlist_added_dates',
    'List when each track was added to a playlist (added_at + added_by). Quota: 🟢 GET /playlists/{id}/items paged.',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      sort: z.enum(['added_asc', 'added_desc']).optional().describe('Sort by added_at (default added_asc)'),
      ...sharedListFields,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const items = await client.getAllPages<PlaylistItemObject & { added_at: string; added_by: { id: string } | null }>(
        `/playlists/${encodeURIComponent(args.playlist_id)}/items`,
        { limit: '50' },
      );
      const sorted = [...items].sort((a, b) => {
        const av = (a as unknown as { added_at?: string }).added_at ?? '';
        const bv = (b as unknown as { added_at?: string }).added_at ?? '';
        return args.sort === 'added_desc' ? bv.localeCompare(av) : av.localeCompare(bv);
      });
      const t = truncateItems(sorted, cap(args));
      const pagination = paginationInfo({ total: sorted.length, returned: t.items.length });
      const mapped = t.items.map((row) => {
        const item = row.item as unknown as Record<string, unknown> | null;
        return {
          name: item && typeof item.name === 'string' ? (item.name as string) : 'unknown',
          uri: item && typeof item.uri === 'string' ? (item.uri as string) : null,
          added_at: (row as unknown as { added_at?: string }).added_at ?? null,
          added_by: (row as unknown as { added_by?: { id: string } }).added_by?.id ?? null,
        };
      });
      const structured: Record<string, unknown> = listStructuredContent(
        mapped as unknown as Record<string, unknown>[],
        pagination,
        { playlist_id: args.playlist_id },
      );
      const lines = [`Added dates for playlist ${args.playlist_id} (${sorted.length} items):`];
      for (const m of mapped) lines.push(`  ${m.added_at ?? '?'} — ${m.name} (${m.uri ?? '?'}) by ${m.added_by ?? '?'}`);
      if (t.footer) lines.push(`(${t.footer})`);
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(lines.join('\n'), structured);
    },
  );

  // 8. split_playlist
  server.tool(
    'split_playlist',
    'Split a playlist into N chunks (new playlists). Quota: 🟡 GET all + N POST /me/playlists + N POST items.',
    {
      playlist_id: z.string().min(1).describe('Source playlist ID'),
      parts: z.number().int().min(2).max(10).describe('Number of parts (2–10)'),
      name_prefix: z.string().optional().describe('Prefix for new playlist names (default: source name)'),
      dry_run: DryRun,
      public: z.boolean().optional().describe('Public flag for new playlists'),
    },
    async (args) => {
      const dryRun = args.dry_run ?? true;
      const encId = encodeURIComponent(args.playlist_id);
      const meta = await client.get<{ name: string; id: string }>(`/playlists/${encId}`);
      const namePrefix = args.name_prefix ?? meta?.name ?? args.playlist_id;
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encId}/items`, { limit: '50' });
      const uris = items
        .map((row) => (row.item as unknown as Record<string, unknown> | null))
        .filter((t): t is Record<string, unknown> => t !== null && typeof t.uri === 'string')
        .map((t) => t.uri as string);
      const chunkSize = Math.ceil(uris.length / args.parts);
      const chunks: string[][] = [];
      for (let i = 0; i < args.parts; i++) chunks.push(uris.slice(i * chunkSize, (i + 1) * chunkSize));
      const structured: Record<string, unknown> = {
        source_playlist_id: args.playlist_id,
        source_name: namePrefix,
        total: uris.length,
        parts: args.parts,
        chunk_sizes: chunks.map((c) => c.length),
        dry_run: dryRun,
      };
      if (dryRun) {
        const text = describeDryRun('split playlist', `playlist ${args.playlist_id} into ${args.parts} parts`, chunks.map((c, i) => `Part ${i + 1}: ${c.length} tracks`));
        return textResult(text, structured);
      }
      const me = await client.get<{ id: string }>('/me');
      const created: Array<{ id: string; name: string }> = [];
      for (let i = 0; i < chunks.length; i++) {
        const name = `${namePrefix} (Part ${i + 1}/${args.parts})`;
        const pl = await client.post<{ id: string }>(`/users/${encodeURIComponent(me!.id)}/playlists`, {
          name,
          public: args.public ?? false,
          description: `Split from ${args.playlist_id} part ${i + 1}/${args.parts}`,
        });
        if (pl && chunks[i].length > 0) {
          for (let j = 0; j < chunks[i].length; j += 100) {
            await client.post(`/playlists/${encodeURIComponent(pl.id)}/tracks`, { uris: chunks[i].slice(j, j + 100) });
          }
        }
        if (pl) created.push({ id: pl.id, name });
      }
      const text = `Split playlist ${args.playlist_id} (${uris.length} tracks) into ${created.length} parts: ${created.map((c) => c.name).join(', ')}`;
      return textResult(text, { ...structured, created });
    },
  );

  // 9. find_duplicate_tracks_across_playlists
  server.tool(
    'find_duplicate_tracks_across_playlists',
    'Find tracks that appear in more than one of the given playlists (cross-playlist dupes). Quota: 🟡 N GETs (one per playlist).',
    {
      playlist_ids: z.array(z.string().min(1)).min(2).max(20).describe('Playlist IDs to compare (2–20)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const uriToPlaylists = new Map<string, Set<string>>();
      const uriToName = new Map<string, string>();
      for (const pid of args.playlist_ids) {
        try {
          const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(pid)}/items`, { limit: '50' });
          for (const row of items) {
            const track = row.item as unknown as Record<string, unknown> | null;
            const uri = track && typeof track.uri === 'string' ? (track.uri as string) : null;
            if (!uri) continue;
            if (!uriToPlaylists.has(uri)) uriToPlaylists.set(uri, new Set());
            uriToPlaylists.get(uri)!.add(pid);
            if (!uriToName.has(uri) && track !== null && typeof (track as Record<string, unknown>).name === 'string') uriToName.set(uri, (track as Record<string, unknown>).name as string);
          }
        } catch { /* skip inaccessible */ }
      }
      const dupes = [...uriToPlaylists.entries()]
        .filter(([, pls]) => pls.size > 1)
        .map(([uri, pls]) => ({ uri, name: uriToName.get(uri) ?? 'unknown', playlists: [...pls], count: pls.size }))
        .sort((a, b) => b.count - a.count);
      const t = truncateItems(dupes, cap(args));
      const pagination = paginationInfo({ total: dupes.length, returned: t.items.length });
      const structured: Record<string, unknown> = listStructuredContent(
        t.items as unknown as Record<string, unknown>[],
        pagination,
        { playlist_ids: args.playlist_ids, duplicate_count: dupes.length },
      );
      const lines = [`Cross-playlist duplicates: ${dupes.length} track(s) appear in >1 of ${args.playlist_ids.length} playlists. Showing ${t.items.length}:`];
      for (const d of t.items) lines.push(`  ${d.name} (${d.uri}) — in ${d.playlists.join(', ')}`);
      if (t.footer) lines.push(`(${t.footer})`);
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(lines.join('\n'), structured);
    },
  );

  // 10. remove_from_library_by_playlist — remove library tracks that are in a playlist
  server.tool(
    'remove_from_library_by_playlist',
    'Remove from Liked Songs any tracks that also appear in a given playlist. Quota: 🟡 2 GETs + DELETE (chunked).',
    {
      playlist_id: z.string().min(1).describe('Playlist ID whose tracks will be removed from library'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const rf = args.response_format as ResponseFormatValue | undefined;
      const dryRun = args.dry_run ?? true;
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(args.playlist_id)}/items`, { limit: '50' });
      const ids = items
        .map((row) => (row.item as unknown as Record<string, unknown> | null))
        .filter((t): t is Record<string, unknown> => t !== null && typeof t.uri === 'string' && (t.uri as string).startsWith('spotify:track:'))
        .map((t) => (t.uri as string).split(':').pop()!);
      // Check which are actually saved
      const savedSet = new Set<string>();
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const res = await client.get<boolean[]>(`/me/tracks/contains`, { ids: chunk.join(',') });
        if (Array.isArray(res)) chunk.forEach((id, idx) => { if (res[idx]) savedSet.add(id); });
      }
      const toRemove = [...savedSet];
      const structured: Record<string, unknown> = {
        playlist_id: args.playlist_id,
        in_playlist: ids.length,
        in_library: savedSet.size,
        to_remove: toRemove.length,
        dry_run: dryRun,
      };
      if (dryRun) {
        const text = describeDryRun('remove from library by playlist', `playlist ${args.playlist_id}`, toRemove.map((id) => `spotify:track:${id}`));
        if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
        return textResult(text, structured);
      }
      if (toRemove.length === 0) {
        if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
        return textResult('No tracks from that playlist are in your library — nothing to remove.', structured);
      }
      for (let i = 0; i < toRemove.length; i += 50) {
        const chunk = toRemove.slice(i, i + 50);
        await client.delete(`/me/tracks?ids=${chunk.join(',')}`);
      }
      const text = `Removed ${toRemove.length} track(s) from library that were in playlist ${args.playlist_id}: ${batchSummary(toRemove.length, toRemove.map((id) => `spotify:track:${id}`))}`;
      if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      return textResult(text, structured);
    },
  );
}
