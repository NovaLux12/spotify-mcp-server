import { z } from 'zod';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig, storePath } from '../config.js';
import { SpotifyApiError } from '../client.js';
import { DryRun, ResponseFormat, readString, playlistRowItem, playlistRowUris } from '../shaping.js';
import { DuplicateMatchByParam, groupDuplicates, matchableFromPlaylistItems, resolveMatchBy } from '../playlistmatch.js';
import type { PlaylistItemObject, SpotifyPlaylistPage } from '../types/spotify.js';
import { playlistTotalFromWalk } from '../types/spotify.js';
import {
  confirmViaElicitation,
  describeConfirmation,
  requiredConfirmationRefusal,
  REMOVE_ELICIT_THRESHOLD,
} from './confirm.js';
import { diffTrackLists } from './swarm3_snapshots.js';
import type { SnapTrackRow } from './swarm3_snapshots.js';
import { ownStoreRoots, readLocalFile } from '../paths.js';
import { textResult, jsonText } from '../result.js';
import { spotifyRef } from '../refs.js';

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

export function snapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  // Deliberately NOT via `getConfig()`. A config snapshot is read once at
  // startup and cached for the life of the process, so consulting it would
  // answer a caller that handed us its own `env` from state that caller never
  // supplied — and this resolver's result is used to ERASE files (#1358, #711).
  //
  // This branch used to read a `dataDir` field off that snapshot, guarded by
  // `env === process.env` so it could only fire for a caller that had NOT
  // supplied an env. The field does not exist on `SpotifyMcpConfig`, so it was
  // dead — but it was dead in the one direction that matters, because the day
  // someone adds a `dataDir` field meaning "the data directory", it resolves to
  // `~/.spotify-mcp` and silently moves every playlist-health snapshot out of
  // `playlist-snapshots/` and into the directory that holds every other store.
  //
  // The registry row keeps the distinction that field would have destroyed:
  // `SPOTIFY_MCP_DATA_DIR` sets this directory, and its DEFAULT is
  // `~/.spotify-mcp/playlist-snapshots`, not `~/.spotify-mcp`.
  return storePath('playlist-health-snapshots', env);
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
    'Audit a playlist for unavailable, local, duplicate, and empty issues (read-only). Duplicates are '
      + 'grouped by the same `match_by` rule the other duplicate tools use (`uri` default, `name_artist`, '
      + '`name`) and the rule is echoed as `match_by`, so this count and '
      + 'find_duplicates_in_playlist\'s count are the same number. '
      + 'See the duplicate-matching vocabulary in SPEC section 4.',
    {
      playlist_id: spotifyRef(z.string().min(1).describe('Playlist ID'), 'playlist'),
      match_by: DuplicateMatchByParam,
      response_format: ResponseFormat,
    },
    async (args) => {
      const playlistId = args.playlist_id;
      const encId = encodeURIComponent(playlistId);
      // #1555: this walk is capped by fetchAllCap, and `healthy` is derived
      // entirely from the rows it returns — so the rows the cap excluded are
      // exactly the rows that might have carried the fault. Take the verdict
      // with the rows, and the playlist's real length from the metadata read
      // rather than from the walk's row count.
      const walk = await client.getAllPagesWithTruncation<PlaylistItemObject>(
        `/playlists/${encId}/items`, { limit: '100' }, { maxItems: getConfig().fetchAllCap },
      );
      const items = walk.items;
      // The walk's own page total is the canonical source; the playlist object
      // is the fallback. Null, not 0, when Spotify states neither.
      const meta = await client.get<SpotifyPlaylistPage>(`/playlists/${encId}`);
      const total = playlistTotalFromWalk(
        { fetched: items.length, truncated: walk.truncated, truncatedByCap: walk.truncatedByCap, reportedTotal: walk.reportedTotal },
        meta,
      );
      const issues: Array<{ type: string; count: number; positions: number[]; description: string }> = [];
      // Disclosed on every return path, healthy or not: a caller reading `total`
      // alone cannot otherwise tell a complete audit from a bounded one.
      const auditScope = {
        items_examined: items.length,
        items_truncated: walk.truncated,
        truncated_by_cap: walk.truncatedByCap,
      };
      if (items.length === 0) {
        issues.push({ type: 'empty', count: 1, positions: [], description: 'Playlist is empty' });
        const text = `Health check for playlist ${playlistId}: 1 issue — empty playlist.`;
        return textResult(text, { playlist_id: playlistId, total, ...auditScope, issues, healthy: false });
      }
      const unavailablePositions: number[] = [];
      const localPositions: number[] = [];
      for (let i = 0; i < items.length; i++) {
        const row = items[i];
        const track = playlistRowItem(row);
        if (track === null) {
          unavailablePositions.push(i);
          continue;
        }
        const uri = readString(track, 'uri');
        const isLocal = track.is_local === true || (uri !== undefined && uri.startsWith('spotify:local:'));
        if (isLocal) localPositions.push(i);
      }
      if (unavailablePositions.length > 0) {
        issues.push({ type: 'unavailable', count: unavailablePositions.length, positions: unavailablePositions, description: `${unavailablePositions.length} unavailable track(s)` });
      }
      if (localPositions.length > 0) {
        issues.push({ type: 'local', count: localPositions.length, positions: localPositions, description: `${localPositions.length} local file(s)` });
      }
      // #885: duplicates are grouped by the shared rule, not by a private URI
      // map. Under the default `uri` rule this is exactly the old behaviour
      // (a group per repeated URI), but a caller that widens the rule to
      // `name_artist` now sees the same group count here as in
      // find_duplicates_in_playlist, instead of a number this tool could not
      // produce at all.
      const matchBy = resolveMatchBy(args).matchBy;
      const dupGroups = groupDuplicates(
        matchableFromPlaylistItems(items as PlaylistItemObject[]),
        matchBy,
      ).map((group) => ({
        key: group.key,
        uris: [...new Set(group.occurrences.map((occurrence) => occurrence.uri))],
        positions: group.occurrences.map((occurrence) => occurrence.position),
      }));
      const dupPositions = dupGroups.flatMap((group) => group.positions).sort((a, b) => a - b);
      if (dupPositions.length > 0) {
        issues.push({ type: 'duplicate', count: dupGroups.length, positions: dupPositions, description: `${dupGroups.length} duplicate group(s) under match_by=${matchBy} across ${dupPositions.length} positions` });
      }
      // #1555: a capped read cannot support `healthy: true`. The verdict is
      // derived entirely from the rows that came back, so a playlist whose
      // 501st track is the duplicate reports "healthy" on the strength of the
      // 500 that were examined. `null` is the honest third value — not clean,
      // not faulty, simply not established — and it is what a caller must be
      // able to tell apart from a real pass. A completed read still answers
      // true/false exactly as before.
      const healthy: boolean | null = issues.length > 0 ? false : walk.truncated ? null : true;
      const structured = { playlist_id: playlistId, match_by: matchBy, total, ...auditScope, issues, duplicate_groups: dupGroups, healthy };
      const sizePhrase = total === null
        ? `length unknown (${items.length} row(s) examined)`
        : `${total} track(s)`;
      let text: string;
      if (healthy === true) text = `Playlist ${playlistId} is healthy: ${sizePhrase}, no issues.`;
      else if (healthy === null) {
        // "Healthy, of the 500 rows I looked at" is a weaker claim than the
        // old one and is the true one. Name what was not examined.
        text = `Playlist ${playlistId}: no issues in the ${items.length} row(s) examined, `
          + `but the read stopped short of all ${total ?? 'stated'} — health NOT established `
          + `(${walk.truncatedByCap ? `the fetch-all cap ended the read` : 'the read ended short of the end'}). `
          + `Raise SPOTIFY_MCP_FETCH_ALL_CAP to audit the whole playlist.`;
      } else {
        const summary = issues.map((iss) => `${iss.type}(${iss.count})`).join(', ');
        const boundedNote = walk.truncated
          ? ` (audit bounded: ${items.length} of ${total ?? 'stated'} row(s) examined)`
          : '';
        text = `Health check for playlist ${playlistId}: ${sizePhrase}, ${issues.length} issue type(s): ${summary}${boundedNote}.\n${jsonText(structured)}`;
      }
      return textResult(text, structured);
    },
  );

  server.tool(
    'get_playlist_followers',
    'Get follower count for a playlist, optionally including public owner profile',
    {
      playlist_id: spotifyRef(z.string().min(1).describe('Playlist ID'), 'playlist'),
      include_profiles: z.boolean().optional().describe('If true, fetch the owner public profile'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const encId = encodeURIComponent(args.playlist_id);
      const playlist = await client.get<{ id: string; name: string; followers: { total: number }; owner: { id: string; display_name: string | null } }>(`/playlists/${encId}`);
      if (!playlist) throw new Error('Playlist not found');
      const total = playlist.followers?.total ?? 0;
      let ownerProfile: unknown = null;
      // #638: `GET /users/{id}` was removed by Spotify in February 2026 and
      // 403s on any current registration, so the `include_profiles: true` path
      // fails on essentially every live credential. That failure used to be
      // swallowed whole: `catch { ownerProfile = null }` and a `...(ownerProfile
      // ? {...} : {})` spread meant a caller who explicitly ASKED for the owner
      // profile got a result identical to one that had declined to fetch it —
      // an omitted field, not a disclosed failure. The follower count itself is
      // read from `/playlists/{id}` and is unaffected. The requested-but-
      // unreadable case is now stated, in both the prose line and the payload,
      // so a caller can tell "no profile returned" from "profile unavailable".
      let ownerProfileError: string | null = null;
      if (args.include_profiles) {
        try {
          ownerProfile = await client.get(`/users/${encodeURIComponent(playlist.owner.id)}`);
          if (!ownerProfile) ownerProfileError = 'empty response';
        } catch (err) {
          ownerProfileError = err instanceof Error ? err.message : String(err);
        }
      }
      const structured: Record<string, unknown> = {
        playlist_id: playlist.id,
        name: playlist.name,
        followers_total: total,
        owner: playlist.owner,
        ...(ownerProfile ? { owner_profile: ownerProfile } : {}),
        ...(args.include_profiles && !ownerProfile
          ? {
              owner_profile_error:
                `${ownerProfileError ?? 'unavailable'}. GET /users/{id} was removed by Spotify's February 2026 ` +
                'Web API changes, so the public owner profile cannot be read on a current app registration; ' +
                'the follower count above is read from GET /playlists/{id} and is unaffected.',
            }
          : {}),
      };
      let text = `Playlist "${playlist.name}" has ${total} follower${total === 1 ? '' : 's'}.`;
      if (ownerProfile) text += `\n${jsonText(ownerProfile)}`;
      else if (args.include_profiles) {
        text += `\nOwner profile unavailable: ${ownerProfileError ?? 'unavailable'}. GET /users/{id} was removed by Spotify's February 2026 Web API changes.`;
      }
      return textResult(text, structured);
    },
  );

  server.tool(
    'playlist_collaboration_report',
    'Report who added what to a playlist (counts + first/last timestamps, most-active)',
    {
      playlist_id: spotifyRef(z.string().min(1).describe('Playlist ID'), 'playlist'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const encId = encodeURIComponent(args.playlist_id);
      const items = await client.getAllPages<PlaylistItemObject & { added_by?: { id: string } }>(`/playlists/${encId}/items`, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
      const byUser = new Map<string, { count: number; first: string | null; last: string | null }>();
      for (const row of items) {
        // #1343: this was a double cast — `row` to `Record<string, unknown>` and
        // then straight back to a declared shape — for a field the generic
        // already types as `added_by?: { id: string }`. A row added by nobody
        // reads as `unknown` here, which is a display label, not a count; the
        // per-contributor tally is unaffected.
        const uid = row.added_by?.id ?? 'unknown';
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
    'Snapshot a playlist\'s current URIs+positions+timestamp to a sidecar JSON file (legacy, simple path playlistId→file). For transactional local snapshots with plsnapi naming, diff, and bundle tooling, use take_playlist_snapshot instead.',
    {
      playlist_id: spotifyRef(z.string().min(1).describe('Playlist ID'), 'playlist'),
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
          const track = playlistRowItem(row);
          return { uri: readString(track, 'uri') ?? null, position: idx, name: readString(track, 'name') ?? null };
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
      playlist_id: spotifyRef(z.string().min(1).describe('Playlist ID'), 'playlist'),
      snapshot_id: z.string().min(1).describe('Snapshot ID to compare against'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const filePath = snapshotPath(args.playlist_id, args.snapshot_id);
      let snapshot: SnapshotData;
      // "not found" is what makes this a client error the caller can act on
      // (a wrong or expired snapshot id), but the ids themselves must not be
      // echoed: one is a caller-supplied URL and the other a local path.
      // #623: the snapshot path is built from caller-supplied ids, so it is
      // confined to the snapshot directory, must be a regular file, and is
      // size-capped. A refusal is reported as "not found" — the same class of
      // answer as a wrong id, and the file's own path is never echoed.
      try { snapshot = JSON.parse(await readLocalFile({ roots: ownStoreRoots(filePath), tool: 'playlist_health', target: filePath })) as SnapshotData; } catch { throw new Error('Snapshot not found for the requested playlist.'); }
      const encId = encodeURIComponent(args.playlist_id);
      const current = await client.getAllPages<PlaylistItemObject>(`/playlists/${encId}/items`, { limit: '100' }, { maxItems: getConfig().fetchAllCap });
      // Multiset semantics, not set membership: a playlist that gains or loses
      // one copy of a duplicated URI IS changed, and `same_multiset` may only be
      // true when the per-URI counts match exactly.
      const snapRows = toDiffRows(snapshot.items.map((it) => ({ uri: it.uri, name: it.name, position: it.position })));
      const currRows = toDiffRows(current.map((row, idx) => {
        const t = playlistRowItem(row);
        return {
          uri: readString(t, 'uri') ?? null,
          name: readString(t, 'name') ?? null,
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
      playlist_id: spotifyRef(z.string().min(1).describe('Playlist ID or Spotify URL/URI'), 'playlist'),
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
      // #1311: this walk had no probe budget, so it could not tell "the
      // playlist has exactly `fetchAllCap` items" from "I stopped at
      // `fetchAllCap`" — and `verification: 'verified'` below means "I re-read
      // the live playlist and it is clean", which is a claim about the WHOLE
      // playlist. `cap + 1` is the same probe #1310's rewrite family uses: one
      // row past the cap is the only way to see the row that overflows it.
      const cap = getConfig().fetchAllCap;
      const walk = await client.getAllPagesWithTruncation<PlaylistItemObject>(itemsPath, { limit: '100' }, { maxItems: cap + 1 });
      const items = walk.items.slice(0, cap);
      // The walk's own verdict OR the clip applied above — `items.length` alone
      // cannot see a walk that ended on a short page while Spotify's own
      // `total` still counted more rows (#718/#864).
      const truncated = walk.truncated || walk.items.length > cap;
      const unreadFrom = items.length;
      const unavailable: Array<{ position: number }> = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]?.item;
        if (item === null || item === undefined) unavailable.push({ position: i });
      }
      if (unavailable.length === 0) {
        // #1311: the all-clear. Issuing it over a truncated walk is the false
        // claim this issue is filed on — the tool read the first `cap` rows,
        // found them clean, and reported the playlist clean. So the verdict
        // here is bounded by what was read, and it NAMES the unread region:
        // an unavailable row past position `unreadFrom` is invisible here and
        // still sitting in the playlist.
        if (truncated) {
          return textResult(
            `No unavailable items in the first ${unreadFrom} row(s) of playlist ${playlistId}, but the walk stopped at the fetch-all cap of ${cap} row(s) — rows from 0-based position ${unreadFrom} onward were not read, so the playlist is NOT verified clean and unavailable rows past the cap may still be present. Raise SPOTIFY_MCP_FETCH_ALL_CAP above this playlist's row count and re-run.`,
            {
              ok: false,
              reason: 'walk_truncated',
              playlist_id: playlistId,
              total: items.length,
              rows_read: unreadFrom,
              scan_cap: cap,
              truncated: true,
              unread_from_position: unreadFrom,
              unavailable_count: 0,
              removed: 0,
              removed_positions: [],
              verification: 'partial',
            },
          );
        }
        return textResult(`No unavailable items in playlist ${playlistId} (${items.length} tracks).`, { ok: true, playlist_id: playlistId, total: items.length, rows_read: unreadFrom, scan_cap: cap, truncated: false, unavailable_count: 0, removed: 0, removed_positions: [], verification: 'verified' });
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
        return textResult(
          `[dry run] Would remove ${toRemove.length} unavailable item(s) from playlist ${playlistId} at positions ${positions.join(', ')}.`
            + (truncated ? ` The walk stopped at the fetch-all cap of ${cap} row(s), so this removal set is incomplete — rows from 0-based position ${unreadFrom} onward were not read.` : ''),
          { ok: true, dry_run: true, playlist_id: playlistId, would_remove: toRemove.length, removed_positions: positions, verification: 'dry_run', truncated, scan_cap: cap, rows_read: unreadFrom, ...(truncated ? { unread_from_position: unreadFrom } : {}) },
        );
      }
      if (toRemove.length >= REMOVE_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('remove unavailable rows from playlist', playlistId, [
            `Remove ${toRemove.length} unavailable row(s) at positions ${positions.join(', ')}:`,
            // #1311: the prompt authorises deleting rows it found by position.
            // If the walk stopped at the cap, the set is a partial view of the
            // playlist and a bulk delete over it deserves to say so — the gate
            // stays exactly as fail-closed as it was, this only adds a line.
            ...(truncated ? [`The walk stopped at the fetch-all cap of ${cap} row(s); rows from 0-based position ${unreadFrom} onward were not read, so unavailable rows may remain past the cap.`] : []),
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
      let afterTruncated: boolean;
      let afterRowsRead: number;
      try {
        // #1311: the re-read carries the same `cap + 1` probe. It was the
        // obvious place to catch an unavailable row the first walk missed, and
        // it was bounded the same way, so a `verified` verdict here meant "the
        // first `cap` rows are clean" on a playlist that may be much longer.
        const rescan = await client.getAllPagesWithTruncation<PlaylistItemObject>(itemsPath, { limit: '100' }, { maxItems: cap + 1 });
        after = rescan.items.slice(0, cap);
        afterTruncated = rescan.truncated || rescan.items.length > cap;
        afterRowsRead = after.length;
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
      const readWhole = !truncated && !afterTruncated;
      const allRemoved = removed === toRemove.length && remainingPositions.length === 0;
      // Three distinct verdicts, and conflating any two of them is the bug
      // #1310/#1311 are about:
      //   verified — the whole playlist was read, before and after, and is clean.
      //   partial  — a walk stopped at the cap, so the read certifies the rows
      //              it reached and NOTHING about the rest. Not `failed`: the
      //              re-read did not find rows it never saw.
      //   failed   — the whole playlist was read and unavailable rows are still
      //              there. That is a real negative result, and saying `partial`
      //              instead would hide a removal that did not take.
      const verification = readWhole ? (allRemoved ? 'verified' : 'failed') : 'partial';
      const result = { playlist_id: playlistId, removed, removed_positions: positions, remaining_unavailable: remainingPositions.length, remaining_positions: remainingPositions, snapshot_id: snapshotId, verification, truncated: !readWhole, scan_cap: cap, rows_read: afterRowsRead, ...(!readWhole ? { unread_from_position: afterRowsRead } : {}) };
      if (verification === 'partial') {
        const seen = remainingPositions.length;
        return textResult(
          `Removed ${removed} unavailable item(s) from playlist ${playlistId}, but the verification is BOUNDED: only ${afterRowsRead} of the playlist's row(s) could be read${afterTruncated ? ' and the walk stopped at the fetch-all cap' : ''}, so rows from 0-based position ${afterRowsRead} onward are UNVERIFIED${seen > 0 ? ` and ${seen} unavailable row(s) seen in that range remain at positions ${remainingPositions.join(', ')}` : ''}. Unavailable rows past the cap may still be present — raise SPOTIFY_MCP_FETCH_ALL_CAP above this playlist's row count and re-run.`,
          { ok: false, reason: 'walk_truncated', ...result },
        );
      }
      if (verification === 'failed') {
        return textResult(`Post-write verification failed for playlist ${playlistId}: ${remainingPositions.length} unavailable row(s) remain at positions ${remainingPositions.join(', ')}.`, { ok: false, ...result });
      }
      return textResult(`Removed ${removed} unavailable item(s) from playlist ${playlistId}. Remaining unavailable: ${remainingPositions.length}. Snapshot: ${snapshotId ?? 'n/a'}`, { ok: true, ...result });
    },
  );

  server.tool(
    'find_duplicate_playlists',
    'Scan your playlists for exact and near-duplicate track sets. Exact = identical URI sets (order-insensitive); near = Jaccard overlap >= threshold. Read-only.',
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
          for (const u of playlistRowUris(items)) uris.add(u);
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
      playlist_id: spotifyRef(z.string().optional().describe('If provided, only snapshots for this playlist'), 'playlist'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const dir = snapshotDir();
      let files: string[] = [];
      try { files = await readdir(dir); } catch { files = []; }
      let jsonFiles = files.filter((f) => f.endsWith('.json'));
      if (args.playlist_id) { const prefix = `${sanitizeId(args.playlist_id)}__`; jsonFiles = jsonFiles.filter((f) => f.startsWith(prefix)); }
      const snapshots: Array<{ snapshot_id: string; playlist_id: string; created_at: string; total: number; file: string }> = [];
      // #623: same guard per file — a snapshot name is server-listed, but the
      // bytes behind it are still confined, regular-file-only and size-capped,
      // so a FIFO under a snapshot name is skipped rather than opened.
      for (const f of jsonFiles) { try { const raw = await readLocalFile({ roots: ownStoreRoots(dir), tool: 'playlist_snapshots', target: join(dir, f) }); const data = JSON.parse(raw) as SnapshotData; snapshots.push({ snapshot_id: data.snapshot_id, playlist_id: data.playlist_id, created_at: data.created_at, total: data.total, file: join(dir, f) }); } catch { /* skip */ } }
      snapshots.sort((a, b) => a.created_at.localeCompare(b.created_at));
      const structured = { snapshots, count: snapshots.length };
      const text = snapshots.length === 0 ? 'No snapshots found.' : `Found ${snapshots.length} snapshot(s):\n${snapshots.map((s) => `  ${s.playlist_id}/${s.snapshot_id} — ${s.total} items @ ${s.created_at}`).join('\n')}`;
      return textResult(text, structured);
    },
  );
}
