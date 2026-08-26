import { z } from 'zod';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import type { PlaylistItemObject } from '../types/spotify.js';

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
    },
    async (args) => {
      const playlistId = args.playlist_id;
      const encId = encodeURIComponent(playlistId);
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encId}/items`);
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
    },
    async (args) => {
      const encId = encodeURIComponent(args.playlist_id);
      const items = await client.getAllPages<PlaylistItemObject & { added_by?: { id: string } }>(`/playlists/${encId}/items`);
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
    'Snapshot a playlist\'s current URIs+positions+timestamp to a sidecar JSON file',
    {
      playlist_id: z.string().min(1).describe('Playlist ID'),
      snapshot_id: z.string().optional().describe('Custom snapshot ID (default: timestamp)'),
    },
    async (args) => {
      const encId = encodeURIComponent(args.playlist_id);
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${encId}/items`);
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
    },
    async (args) => {
      const filePath = snapshotPath(args.playlist_id, args.snapshot_id);
      let snapshot: SnapshotData;
      try { snapshot = JSON.parse(await readFile(filePath, 'utf8')) as SnapshotData; } catch { throw new Error(`Snapshot "${args.snapshot_id}" not found for playlist "${args.playlist_id}"`); }
      const encId = encodeURIComponent(args.playlist_id);
      const current = await client.getAllPages<PlaylistItemObject>(`/playlists/${encId}/items`);
      const currentUris = current.map((row) => { const t = row.item as unknown as Record<string, unknown> | null | undefined; return t && typeof t.uri === 'string' ? (t.uri as string) : null; });
      const snapUris = snapshot.items.map((it) => it.uri);
      const snapSet = new Set(snapUris.filter((u): u is string => u !== null));
      const currSet = new Set(currentUris.filter((u): u is string => u !== null));
      const added: Array<{ uri: string; position: number }> = [];
      currentUris.forEach((uri, idx) => { if (uri !== null && !snapSet.has(uri)) added.push({ uri, position: idx }); });
      const removed: Array<{ uri: string; position: number }> = [];
      snapUris.forEach((uri, idx) => { if (uri !== null && !currSet.has(uri)) removed.push({ uri, position: idx }); });
      const snapPos = new Map<string, number>();
      snapUris.forEach((uri, idx) => { if (uri !== null && !snapPos.has(uri)) snapPos.set(uri, idx); });
      const currPos = new Map<string, number>();
      currentUris.forEach((uri, idx) => { if (uri !== null && !currPos.has(uri)) currPos.set(uri, idx); });
      const reordered: Array<{ uri: string; from: number; to: number }> = [];
      for (const uri of currSet) if (snapSet.has(uri)) { const from = snapPos.get(uri)!; const to = currPos.get(uri)!; if (from !== to) reordered.push({ uri, from, to }); }
      const structured = { playlist_id: args.playlist_id, snapshot_id: args.snapshot_id, snapshot_total: snapshot.total, current_total: current.length, added, removed, reordered, added_count: added.length, removed_count: removed.length, reordered_count: reordered.length, has_changes: added.length > 0 || removed.length > 0 || reordered.length > 0, same_multiset: added.length === 0 && removed.length === 0 };
      let text: string;
      if (!structured.has_changes) text = `No changes since snapshot ${args.snapshot_id} (playlist ${args.playlist_id}, ${current.length} items).`;
      else { const parts: string[] = []; if (added.length) parts.push(`added: ${added.map((a) => a.uri).join(', ')}`); if (removed.length) parts.push(`removed: ${removed.map((r) => r.uri).join(', ')}`); if (reordered.length) parts.push(`reordered: ${reordered.map((r) => `${r.uri} ${r.from}→${r.to}`).join(', ')}`); text = `Diff for playlist ${args.playlist_id} vs snapshot ${args.snapshot_id}: ${current.length} now vs ${snapshot.total} then.\n${parts.join('\n')}`; }
      return textResult(text, structured);
    },
  );

  server.tool(
    'list_playlist_snapshots',
    'List stored snapshots (optionally filtered by playlist_id)',
    {
      playlist_id: z.string().optional().describe('If provided, only snapshots for this playlist'),
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
