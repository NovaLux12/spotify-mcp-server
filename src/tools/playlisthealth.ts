import { z } from 'zod';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { SpotifyApiError } from '../client.js';
import { DryRun, ResponseFormat } from '../shaping.js';
import type { PlaylistItemObject } from '../types/spotify.js';
import {
  confirmViaElicitation,
  describeConfirmation,
  requiredConfirmationRefusal,
  REMOVE_ELICIT_THRESHOLD,
} from './confirm.js';
import { diffTrackLists } from './swarm3_snapshots.js';
import type { SnapTrackRow } from './swarm3_snapshots.js';

/** A snapshot row plus its live position, so a diff can report where. */
type PositionedRow = SnapTrackRow & { position: number };

/**
 * Rows for the multiset diff core. Unavailable (null-track) rows carry no URI
 * and are dropped, so a null never participates in counting.
 */
function toDiffRows(
  entries: Array<{ uri: string | null; name: string | null; position: number }>,
): PositionedRow[] {
  const rows: PositionedRow[] = [];
  for (const e of entries) {
    if (e.uri === null) continue;
    rows.push({ uri: e.uri, name: e.name ?? '', added_at: null, position: e.position });
  }
  return rows;
}

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  const content: TextContent[] = [{ type: 'text', text }];
  return structured ? { content, structuredContent: structured } : { content };
}

const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

function snapshotDir(): string {
  const cfg = getConfig() as unknown as Record<string, unknown>;
  if (typeof cfg.dataDir === 'string' && cfg.dataDir.length > 0) return cfg.dataDir as string;
  const envDir = process.env.SPOTIFY_MCP_DATA_DIR;
  if (envDir && envDir.length > 0) return envDir;
  return join(homedir(), '.spotify-mcp', 'playlist-snapshots');
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function snapshotPath(playlistId: string, snapshotId: string): string {
  return join(snapshotDir(), `${sanitizeId(playlistId)}__${sanitizeId(snapshotId)}.json`);
}

interface SnapshotData {
  playlist_id: string;
  snapshot_id: string;
  created_at: string;
  total: number;
  items: Array<{ uri: string | null; position: number; name: string | null }>;
}

async function ensureSnapshotDir(): Promise<void> {
  try {
    await mkdir(snapshotDir(), { recursive: true });
  } catch {
    // best-effort
  }
}

export function registerPlaylistHealthTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'playlist_health_check',
    'Audit a playlist for unavailable, local, duplicate, and empty issues (read-only)',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const playlistId = args.playlist_id;
      const encId = encodeURIComponent(playlistId);
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encId}/items`, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
      const issues: Array<{ type: string; count: number; positions: number[]; description: string }> = [];
      if (items.length === 0) {
        issues.push({ type: 'empty', count: 1, positions: [], description: 'Playlist is empty' });
        const text = `Health check for playlist ${playlistId}: 1 issue — empty playlist.`;
        return textResult(text, { playlist_id: playlistId, total: 0, issues, healthy: false });
      }
      const unavailablePositions: number[] = [];
      const localPositions: number[] = [];
      const uriToPositions = new Map<string, number[]>();
      for (let i = 0; i < items.length; i++) {
        const row = items[i];
        const track = row.item as unknown as Record<string, unknown> | null | undefined;
        if (!track) {
          unavailablePositions.push(i);
          continue;
        }
        const uri = typeof track.uri === 'string' ? (track.uri as string) : null;
        const isLocal = (track as Record<string, unknown>).is_local === true || (uri !== null && uri.startsWith('spotify:local:'));
        if (isLocal) localPositions.push(i);
        if (uri) {
          const arr = uriToPositions.get(uri) ?? [];
          arr.push(i);
          uriToPositions.set(uri, arr);
        }
      }
      if (unavailablePositions.length > 0) {
        issues.push({ type: 'unavailable', count: unavailablePositions.length, positions: unavailablePositions, description: `${unavailablePositions.length} unavailable track(s)` });
      }
      if (localPositions.length > 0) {
        issues.push({ type: 'local', count: localPositions.length, positions: localPositions, description: `${localPositions.length} local file(s)` });
      }
      const dupPositions: number[] = [];
      const dupGroups: Array<{ uri: string; positions: number[] }> = [];
      for (const [uri, positions] of uriToPositions) {
        if (positions.length > 1) {
          dupGroups.push({ uri, positions });
          dupPositions.push(...positions);
        }
      }
      dupPositions.sort((a, b) => a - b);
      if (dupPositions.length > 0) {
        issues.push({ type: 'duplicate', count: dupGroups.length, positions: dupPositions, description: `${dupGroups.length} duplicate URI(s) across ${dupPositions.length} positions` });
      }
      const healthy = issues.length === 0;
      const structured = { playlist_id: playlistId, total: items.length, issues, duplicate_groups: dupGroups, healthy };
      let text: string;
      if (healthy) text = `Playlist ${playlistId} is healthy: ${items.length} tracks, no issues.`;
      else {
        const summary = issues.map((iss) => `${iss.type}(${iss.count})`).join(', ');
        text = `Health check for playlist ${playlistId}: ${items.length} tracks, ${issues.length} issue type(s): ${summary}.\n${jsonText(structured)}`;
      }
      return textResult(text, structured);
    },
  );

  server.tool(
    'get_playlist_followers',
    'Get follower count for a playlist, optionally including public owner profile',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      include_profiles: z.boolean().optional().describe('If true, fetch the owner public profile'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const encId = encodeURIComponent(args.playlist_id);
      const playlist = await client.get<{ id: string; name: string; followers: { total: number }; owner: { id: string; display_name: string | null } }>(`/playlists/${encId}`);
      if (!playlist) throw new Error('Playlist not found');
      const total = playlist.followers?.total ?? 0;
      let ownerProfile: unknown = null;
      if (args.include_profiles) {
        try { ownerProfile = await client.get(`/users/${encodeURIComponent(playlist.owner.id)}`); } catch { ownerProfile = null; }
      }
      const structured: Record<string, unknown> = { playlist_id: playlist.id, name: playlist.name, followers_total: total, owner: playlist.owner, ...(ownerProfile ? { owner_profile: ownerProfile } : {}) };
      let text = `Playlist "${playlist.name}" has ${total} follower${total === 1 ? '' : 's'}.`;
      if (ownerProfile) text += `\n${jsonText(ownerProfile)}`;
      return textResult(text, structured);
    },
  );

  server.tool(
    'playlist_collaboration_report',
    'Report who added what to a playlist (counts + first/last timestamps, most-active)',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const encId = encodeURIComponent(args.playlist_id);
      const items = await client.getAllPages<PlaylistItemObject & { added_by?: { id: string } }>(`/playlists/${encId}/items`, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
      const byUser = new Map<string, { count: number; first: string | null; last: string | null }>();
      for (const row of items) {
        const addedBy = (row as unknown as Record<string, unknown>).added_by as { id?: string } | undefined;
        const uid = addedBy?.id ?? 'unknown';
        const ts: string | null = typeof row.added_at === 'string' ? row.added_at : null;
        const entry = byUser.get(uid) ?? { count: 0, first: ts, last: ts };
        entry.count += 1;
        if (ts) {
          if (!entry.first || ts < entry.first) entry.first = ts;
          if (!entry.last || ts > entry.last) entry.last = ts;
        }
        byUser.set(uid, entry);
      }
      const contributors = [...byUser.entries()].map(([user_id, v]) => ({ user_id, ...v })).sort((a, b) => b.count - a.count);
      const mostActive = contributors[0]?.user_id ?? null;
      const structured = { playlist_id: args.playlist_id, total: items.length, contributors, most_active: mostActive };
      let text: string;
      if (contributors.length === 0) text = `Playlist ${args.playlist_id} has no items.`;
      else {
        const lines = contributors.map((c) => `  ${c.user_id}: ${c.count} (first: ${c.first ?? '?'}, last: ${c.last ?? '?'})`);
        text = `Collaboration report for playlist ${args.playlist_id} (${items.length} items, ${contributors.length} contributor(s), most active: ${mostActive}):\n${lines.join('\n')}`;
      }
      return textResult(text, structured);
    },
  );

  server.tool(
    'snapshot_playlist',
    'Snapshot a playlist\'s current URIs+positions+timestamp to a sidecar JSON file (legacy, simple path playlistId→file). For transactional local snapshots with plsnapi naming, diff, and bundle tooling, use take_playlist_snapshot instead. Also covers: playlist snapshot (legacy).',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      snapshot_id: z.string().optional().describe('Custom snapshot ID (default: timestamp)'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const encId = encodeURIComponent(args.playlist_id);
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encId}/items`, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
      const snapId = args.snapshot_id ?? new Date().toISOString().replace(/[:.]/g, '-');
      const data: SnapshotData = {
        playlist_id: args.playlist_id, snapshot_id: snapId, created_at: new Date().toISOString(), total: items.length,
        items: items.map((row, idx) => {
          const track = row.item as unknown as Record<string, unknown> | null | undefined;
          const uri = track && typeof track.uri === 'string' ? (track.uri as string) : null;
          const name = track && typeof track.name === 'string' ? (track.name as string) : null;
          return { uri, position: idx, name };
        }),
      };
      await ensureSnapshotDir();
      const filePath = snapshotPath(args.playlist_id, snapId);
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      const structured = { playlist_id: args.playlist_id, snapshot_id: snapId, total: items.length, file: filePath };
      return textResult(`Snapshot ${snapId} saved for playlist ${args.playlist_id} (${items.length} items) → ${filePath}`, structured);
    },
  );

  server.tool(
    'diff_since_snapshot',
    'Compare current playlist state to a stored snapshot',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      snapshot_id: z.string().min(1).describe('Snapshot ID to compare against'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const filePath = snapshotPath(args.playlist_id, args.snapshot_id);
      let snapshot: SnapshotData;
      // "not found" is what makes this a client error the caller can act on
      // (a wrong or expired snapshot id), but the ids themselves must not be
      // echoed: one is a caller-supplied URL and the other a local path.
      try { snapshot = JSON.parse(await readFile(filePath, 'utf8')) as SnapshotData; } catch { throw new Error('Snapshot not found for the requested playlist.'); }
      const encId = encodeURIComponent(args.playlist_id);
      const current = await client.getAllPages<PlaylistItemObject>(`/playlists/${encId}/items`, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
      // Multiset semantics, not set membership: a playlist that gains or loses
      // one copy of a duplicated URI IS changed, and `same_multiset` may only be
      // true when the per-URI counts match exactly.
      const snapRows = toDiffRows(snapshot.items.map((it) => ({ uri: it.uri, name: it.name, position: it.position })));
      const currRows = toDiffRows(current.map((row, idx) => {
        const t = row.item as unknown as Record<string, unknown> | null | undefined;
        return {
          uri: t && typeof t.uri === 'string' ? (t.uri as string) : null,
          name: t && typeof t.name === 'string' ? (t.name as string) : null,
          position: idx,
        };
      }));
      const diff = diffTrackLists(snapRows, currRows);
      // The diff hands back the same row objects, so positions are recovered
      // from the input rows rather than re-derived from the arrays.
      const snapPosition = new Map<SnapTrackRow, number>();
      for (const r of snapRows) snapPosition.set(r, r.position);
      const currPosition = new Map<SnapTrackRow, number>();
      for (const r of currRows) currPosition.set(r, r.position);
      const added = diff.added.map((r) => ({ uri: r.uri, position: currPosition.get(r) ?? -1 }));
      const removed = diff.removed.map((r) => ({ uri: r.uri, position: snapPosition.get(r) ?? -1 }));
      // Reordering is a first-occurrence question, so this stays set-based.
      const snapSet = new Set(snapRows.map((r) => r.uri));
      const currSet = new Set(currRows.map((r) => r.uri));
      const snapPos = new Map<string, number>();
      snapRows.forEach((r) => { if (!snapPos.has(r.uri)) snapPos.set(r.uri, r.position); });
      const currPos = new Map<string, number>();
      currRows.forEach((r) => { if (!currPos.has(r.uri)) currPos.set(r.uri, r.position); });
      const reordered: Array<{ uri: string; from: number; to: number }> = [];
      for (const uri of currSet) if (snapSet.has(uri)) { const from = snapPos.get(uri)!; const to = currPos.get(uri)!; if (from !== to) reordered.push({ uri, from, to }); }
      const sameMultiset = diff.added_count === 0 && diff.removed_count === 0;
      const structured = { playlist_id: args.playlist_id, snapshot_id: args.snapshot_id, snapshot_total: snapshot.total, current_total: current.length, added, removed, reordered, added_count: added.length, removed_count: removed.length, reordered_count: reordered.length, unchanged_count: diff.unchanged_count, has_changes: added.length > 0 || removed.length > 0 || reordered.length > 0, same_multiset: sameMultiset };
      let text: string;
      if (!structured.has_changes) text = `No changes since snapshot ${args.snapshot_id} (playlist ${args.playlist_id}, ${current.length} items).`;
      else { const parts: string[] = []; if (added.length) parts.push(`added: ${added.map((a) => a.uri).join(', ')}`); if (removed.length) parts.push(`removed: ${removed.map((r) => r.uri).join(', ')}`); if (reordered.length) parts.push(`reordered: ${reordered.map((r) => `${r.uri} ${r.from}→${r.to}`).join(', ')}`); text = `Diff for playlist ${args.playlist_id} vs snapshot ${args.snapshot_id}: ${current.length} now vs ${snapshot.total} then.\n${parts.join('\n')}`; }
      return textResult(text, structured);
    },
  );


  server.tool(
    'remove_unavailable_playlist_items',
    'Remove unavailable (null track) rows from a playlist — actionable companion to playlist_health_check. Targets only unavailable occurrences by validated position, highest first, so healthy copies are preserved. Read-only dry_run preview available.',
    {
      playlist_id: z.string().min(1).describe('Playlist ID or Spotify URL/URI'),
      dry_run: z.boolean().optional().describe('Preview only — no writes'),
      max_removals: z.number().int().min(1).optional().describe('Destructive cap: maximum unavailable playlist rows to remove; defaults to all detected unavailable rows'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const raw = args.playlist_id;
      let playlistId = raw;
      try { const m = raw.match(/playlist\/([a-zA-Z0-9]+)/); if(m) playlistId = m[1]; const m2 = raw.match(/spotify:playlist:([a-zA-Z0-9]+)/); if(m2) playlistId = m2[1]; } catch {}
      const encId = encodeURIComponent(playlistId);
      const itemsPath = `/playlists/${encId}/items`;
      const items = await client.getAllPages<PlaylistItemObject>(itemsPath, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
      const unavailable: Array<{ position: number }> = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]?.item;
        if (item === null || item === undefined) unavailable.push({ position: i });
      }
      if (unavailable.length === 0) {
        return textResult(`No unavailable items in playlist ${playlistId} (${items.length} tracks).`, { ok: true, playlist_id: playlistId, total: items.length, unavailable_count: 0, removed: 0, removed_positions: [], verification: 'verified' });
      }
      const toRemove = unavailable.slice(0, args.max_removals ?? unavailable.length);
      // Validate every target before the first write. Unavailable rows have no
      // URI; sending a made-up URI would target the wrong Spotify resource.
      for (const row of toRemove) {
        const item = items[row.position]?.item;
        if (!Number.isSafeInteger(row.position) || row.position < 0 || row.position >= items.length || (item !== null && item !== undefined)) {
          return textResult(`Cannot remove unavailable items: invalid or stale position ${row.position}.`, { ok: false, playlist_id: playlistId, verification: 'invalid_target' });
        }
      }
      const positions = toRemove.map((row) => row.position);
      if (args.dry_run) {
        return textResult(`[dry run] Would remove ${toRemove.length} unavailable item(s) from playlist ${playlistId} at positions ${positions.join(', ')}.`, { ok: true, dry_run: true, playlist_id: playlistId, would_remove: toRemove.length, removed_positions: positions, verification: 'dry_run' });
      }
      if (toRemove.length >= REMOVE_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('remove unavailable rows from playlist', playlistId, [
            `Remove ${toRemove.length} unavailable row(s) at positions ${positions.join(', ')}:`,
          ]),
        });
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return textResult(refusal.message, refusal.payload);
      }
      // Delete from the end so earlier positions do not shift. A position-only
      // track object is intentional: Spotify returned null for these rows, so
      // there is no legitimate URI to send.
      let snapshotId: string | null = null;
      for (const row of [...toRemove].sort((a, b) => b.position - a.position)) {
        const result = await client.delete<{ snapshot_id?: string }>(itemsPath, { tracks: [{ positions: [row.position] }] });
        if (result?.snapshot_id) snapshotId = result.snapshot_id;
      }
      let after: PlaylistItemObject[];
      try {
        after = await client.getAllPages<PlaylistItemObject>(itemsPath, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
      } catch {
        return textResult(`Removal write completed, but post-write verification is unavailable for playlist ${playlistId}.`, {
          ok: false,
          playlist_id: playlistId,
          verification: 'unavailable',
          verification_unavailable: true,
          removed: null,
          removed_positions: null,
          remaining_positions: null,
          snapshot_id: snapshotId,
          error: 'post_write_verification_unavailable',
        });
      }
      const remainingPositions: number[] = [];
      for (let i = 0; i < after.length; i++) {
        const item = after[i]?.item;
        if (item === null || item === undefined) remainingPositions.push(i);
      }
      const removed = unavailable.length - remainingPositions.length;
      const verified = removed === toRemove.length && remainingPositions.length === 0;
      const result = { playlist_id: playlistId, removed, removed_positions: positions, remaining_unavailable: remainingPositions.length, remaining_positions: remainingPositions, snapshot_id: snapshotId, verification: verified ? 'verified' : 'failed' };
      if (!verified) {
        return textResult(`Post-write verification failed for playlist ${playlistId}: ${remainingPositions.length} unavailable row(s) remain at positions ${remainingPositions.join(', ')}.`, { ok: false, ...result });
      }
      return textResult(`Removed ${removed} unavailable item(s) from playlist ${playlistId}. Remaining unavailable: ${remainingPositions.length}. Snapshot: ${snapshotId ?? 'n/a'}`, { ok: true, ...result });
    },
  );

  server.tool(
    'find_duplicate_playlists',
    'Scan your playlists for exact and near-duplicate track sets. Exact = identical URI sets (order-insensitive); near = Jaccard overlap >= threshold. Read-only. Also covers: find_duplicates_in_playlist, find_duplicate_tracks_across_playlists — See also: find_duplicates_in_playlist, find_duplicate_tracks_across_playlists.',
    {
      threshold: z.number().min(0).max(1).optional().default(0.85).describe('Jaccard threshold for near-duplicates (default 0.85)'),
      max_playlists: z.number().int().min(1).max(100).optional().describe('How many playlists to scan (default 50, max 100)'),
      scan_cap: z.number().int().min(1).max(10000).optional().describe('Max items walked per playlist (default fetchAllCap)'),
      dry_run: DryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const cap2 = args.scan_cap ?? getConfig().fetchAllCap;
      const threshold = args.threshold ?? 0.85;
      // dry_run: cost estimate without calls
      if (args.dry_run) {
        const p = args.max_playlists ?? 50;
        const perPages = Math.max(1, Math.ceil(cap2 / 100));
        const estimatedRequests = 1 + p * perPages;
        const lines = [
          `[dry run] find_duplicate_playlists would scan ${p} playlist(s) (scan_cap=${cap2}, threshold=${threshold}).`,
          `Cost: ~${estimatedRequests} requests (1 listing for /me/playlists + ${p} × ~${perPages} page(s) per playlist).`,
          p > 25 ? `Warning: scanning ${p} playlists (>25) may hit rate limits — consider a lower max_playlists or scan_cap.` : '',
        ].filter(Boolean);
        return textResult((lines as string[]).join('\n'), { dry_run: true, would_scan_playlists: p, scan_cap: cap2, threshold, per_playlist_pages: perPages, estimated_requests: estimatedRequests });
      }
      // cap + 1 as a probe: `all.length >= cap2` reports truncation for a user
      // who happens to own exactly cap2 playlists, and this listing really did
      // reach the end. The probe row is dropped before anything uses the list.
      const walked = await client.getAllPages<import('../types/spotify.js').SpotifyPlaylistSimple>('/me/playlists', { limit: '50' }, { maxItems: cap2 + 1 });
      const truncated = walked.length > cap2;
      const all = truncated ? walked.slice(0, cap2) : walked;
      const playlists = all.slice(0, args.max_playlists ?? 50);
      // Fetch track sets with quota partial recovery. A non-429 failure is NOT
      // an empty playlist: recording it as one would group it with every other
      // empty set under the key '' and invent a duplicate. Failures are kept
      // aside and reported; they never enter the comparison pass.
      const sets: Array<{ id:string; name:string; uris:Set<string> }> = [];
      const failed: Array<{ id:string; name:string; error:string }> = [];
      let quotaHit = false;
      let quotaRetryAfter: number | null = null;
      let quotaAtPlaylist: string | null = null;
      for (const pl of playlists) {
        if(!pl.id) continue;
        if (quotaHit) break;
        try {
          const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encodeURIComponent(pl.id)}/items`, { limit: '100' }, { maxItems: cap2 });
          const uris = new Set<string>();
          for (const it of items) {
            const u = (it.item as unknown as Record<string, unknown> | null | undefined)?.uri;
            if (typeof u === 'string') uris.add(u);
          }
          sets.push({ id: pl.id, name: pl.name, uris });
        } catch (e) {
          if (e instanceof SpotifyApiError && e.status === 429) { quotaHit = true; quotaRetryAfter = e.retryAfterSec ?? null; quotaAtPlaylist = pl.id; break; }
          failed.push({ id: pl.id, name: pl.name, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // Empty playlists are reported, never compared: two of them share the
      // grouping key '' and would otherwise be called exact duplicates.
      const empties = sets.filter((s) => s.uris.size === 0);
      const comparable = sets.filter((s) => s.uris.size > 0);
      const groups: Array<{ type:string; playlists:Array<{id:string;name:string}>; overlap:number; shared:number; union:number }> = [];
      const exactGroups = new Map<string, typeof comparable>();
      for(const s of comparable){ const key=[...s.uris].sort().join('|'); const arr=exactGroups.get(key)??[]; arr.push(s); exactGroups.set(key, arr); }
      for(const [, arr] of exactGroups){ if(arr.length>1) groups.push({ type:'exact', playlists: arr.map(a=>({id:a.id,name:a.name})), overlap:1, shared: arr[0].uris.size, union: arr[0].uris.size }); }
      // near duplicates pairwise
      for(let i=0;i<comparable.length;i++) for(let j=i+1;j<comparable.length;j++){
        const a=comparable[i], b=comparable[j];
        // skip if already exact group
        const keyA=[...a.uris].sort().join('|'), keyB=[...b.uris].sort().join('|'); if(keyA===keyB) continue;
        let inter=0; for(const u of a.uris) if(b.uris.has(u)) inter++;
        const union=a.uris.size+b.uris.size-inter; const jacc=union===0?0:inter/union;
        if(jacc>=threshold) groups.push({ type:'near', playlists: [{id:a.id,name:a.name},{id:b.id,name:b.name}], overlap: Number(jacc.toFixed(3)), shared: inter, union });
      }
      const lines=[`Scanned ${sets.length + failed.length} playlist(s)${truncated?` (truncated at ${cap2})`:''}: ${groups.length} duplicate group(s) (threshold ${threshold})${failed.length > 0 ? ` — ${failed.length} unreadable, excluded from comparison` : ''}${quotaHit ? ` — quota hit at ${quotaAtPlaylist} (Retry-After ${quotaRetryAfter ?? 'unknown'}s), partial results` : ''}`];
      for(const g of groups) lines.push(`  ${g.type} overlap=${g.overlap} shared=${g.shared}/${g.union}: ${g.playlists.map(p=>'"'+p.name+'" ('+p.id+')').join(' ↔ ')}`);
      for(const f of failed) lines.push(`  unreadable: "${f.name}" (${f.id}) — ${f.error}`);
      if (empties.length > 0) lines.push(`  empty, not compared: ${empties.map(p=>'"'+p.name+'" ('+p.id+')').join(', ')}`);
      return textResult(lines.join('\n'), { ok:true, scanned: sets.length + failed.length, compared: comparable.length, failed_count: failed.length, unreadable: failed, empty_playlists: empties.map((p) => ({ id: p.id, name: p.name })), requested: playlists.length, total_playlists: all.length, truncated, threshold, groups, ...(quotaHit ? { quota_hit: true, quota_at_playlist: quotaAtPlaylist, retry_after: quotaRetryAfter } : {}) });
    },
  );

  server.tool(
    'list_playlist_snapshots',
    'List stored snapshots (optionally filtered by playlist_id)',
    {
      playlist_id: z.string().optional().describe('If provided, only snapshots for this playlist'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const dir = snapshotDir();
      let files: string[] = [];
      try { files = await readdir(dir); } catch { files = []; }
      let jsonFiles = files.filter((f) => f.endsWith('.json'));
      if (args.playlist_id) { const prefix = `${sanitizeId(args.playlist_id)}__`; jsonFiles = jsonFiles.filter((f) => f.startsWith(prefix)); }
      const snapshots: Array<{ snapshot_id: string; playlist_id: string; created_at: string; total: number; file: string }> = [];
      for (const f of jsonFiles) { try { const raw = await readFile(join(dir, f), 'utf8'); const data = JSON.parse(raw) as SnapshotData; snapshots.push({ snapshot_id: data.snapshot_id, playlist_id: data.playlist_id, created_at: data.created_at, total: data.total, file: join(dir, f) }); } catch { /* skip */ } }
      snapshots.sort((a, b) => a.created_at.localeCompare(b.created_at));
      const structured = { snapshots, count: snapshots.length };
      const text = snapshots.length === 0 ? 'No snapshots found.' : `Found ${snapshots.length} snapshot(s):\n${snapshots.map((s) => `  ${s.playlist_id}/${s.snapshot_id} — ${s.total} items @ ${s.created_at}`).join('\n')}`;
      return textResult(text, structured);
    },
  );
}
