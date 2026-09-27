/**
 * Lane registry tools (#727).
 *
 * Two read-only tools, deliberately one module because they share one load of
 * the manifest and one playlist-read rule:
 *
 *  - `list_lanes` — the view of the mapping, so a host can verify it WITHOUT
 *    performing a write. This is the acceptance criterion that matters most: the
 *    failure #727 describes is a host writing to a playlist it cannot identify,
 *    and the cheapest cure is being able to ask first.
 *  - `lane_status` — does a lane's playlist still resolve, and how far has it
 *    drifted from the last playlist-health snapshot.
 *
 * The write-side rule is deliberately NOT here. It is `resolveLaneTarget` in
 * `src/lanes.ts`, so a lane-targeted write in any module reaches the same rule
 * without importing a tool module. Both tools are read-only — they issue
 * `GET /playlists/{id}` reads and no write of any kind, which is why the
 * manifest row is `readOnlySafe`.
 *
 * ## Why these report a FAILED lookup as a failed lookup
 *
 * They read each lane's playlist and report the item count. A lane whose
 * playlist 404s (deleted, or transferred away) is reported with the reason and
 * EXCLUDED from the counts — never as "0 tracks", which is the #803 shape: a
 * value that could not be read coerced into a plausible number, which tells the
 * caller a deleted playlist is an empty one. Every summary count is a count of
 * lanes that were actually CHECKED, with the unchecked ones named separately,
 * so "0 drifted" can be read correctly next to "2 lanes could not be read".
 * The snapshot comparison is likewise UNKNOWN when there is no snapshot, not
 * "up to date".
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { playlistItemTotal, type SpotifyPlaylistPage } from '../types/spotify.js';
import { ResponseFormat, MaxResults, resolveMaxResults, truncateItems } from '../shaping.js';
import { textResult } from '../result.js';
import { SpotifyApiError } from '../client.js';
import { loadLanes, resolveLane, lanesFilePath, type LaneManifest } from '../lanes.js';
import { snapshotDir } from './playlisthealth.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * One lane, resolved and described. `known` is false when the name is not in
 * the manifest at all — the row is still returned so `list_lanes` can show a
 * caller what it asked about next to what exists.
 */
interface LaneRow {
  lane: string;
  known: boolean;
  playlist_id: string | null;
  description: string | null;
  /** Item count from a successful read; null when the read failed or the lane is unknown. */
  track_count: number | null;
  /** Why the count is null. Never empty when track_count is null. */
  unreadable_reason: string | null;
}

/**
 * A short description of a failed playlist read.
 *
 * Only the status and Spotify's own reason code — never `err.message`, which an
 * upstream error body can fill with private ids. Same redaction rule as
 * `taste_playlist.ts`.
 */
function readFailureMessage(err: unknown): string {
  if (err instanceof SpotifyApiError) {
    return `HTTP ${err.status}${err.reason ? ` (${err.reason})` : ''}`;
  }
  return err instanceof Error ? err.name : 'unknown error';
}

/**
 * The item count for one playlist, or the reason it could not be read.
 *
 * `GET /playlists/{id}` carries the count in the playlist object itself, so this
 * is ONE request per lane rather than a paged walk of the items — the count is
 * needed, not the rows. A failure is returned as a reason and never as a zero:
 * the caller distinguishes "empty playlist" from "cannot tell".
 *
 * The count comes from {@link playlistItemTotal}, NOT from a hand-rolled read
 * of `tracks.total`. Spotify moved that field to `items.total` in Feb 2026 and
 * marked the old spelling upstream-deprecated, so a tool that reads `tracks`
 * alone reports every current playlist as UNREADABLE — a total of zero lanes
 * checked, from a server that read every playlist successfully.
 */
async function playlistTrackCount(
  client: SpotifyClient,
  playlistId: string,
): Promise<{ count: number } | { reason: string }> {
  try {
    const playlist = await client.get<SpotifyPlaylistPage>(
      `/playlists/${encodeURIComponent(playlistId)}`,
    );
    const total = playlistItemTotal(playlist);
    if (total === undefined || !Number.isFinite(total)) {
      return { reason: 'playlist read returned no items.total' };
    }
    return { count: total };
  } catch (err) {
    return { reason: `playlist read failed: ${readFailureMessage(err)}` };
  }
}

/** One playlist-health snapshot header, as far as this tool needs it. */
interface SnapshotHeader {
  playlist_id: string;
  snapshot_id: string;
  created_at: string;
  total: number;
}

/**
 * The most recent health snapshot per playlist id.
 *
 * A snapshot file that cannot be read or parsed is SKIPPED rather than
 * reported: the question `lane_status` answers is "what was the last thing we
 * recorded for this playlist", and an unreadable older file does not change the
 * answer. Reporting it as "snapshot unreadable" would make one damaged file
 * hide every newer snapshot behind it, which is a worse answer, not a more
 * honest one.
 */
async function latestSnapshots(env: NodeJS.ProcessEnv): Promise<Map<string, SnapshotHeader>> {
  const latest = new Map<string, SnapshotHeader>();
  const dir = snapshotDir(env);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return latest; // no snapshot directory at all is "nothing recorded yet"
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, entry), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      const playlistId = record.playlist_id;
      const snapshotId = record.snapshot_id;
      const createdAt = record.created_at;
      const total = record.total;
      if (typeof playlistId !== 'string' || typeof snapshotId !== 'string') continue;
      if (typeof createdAt !== 'string' || typeof total !== 'number' || !Number.isFinite(total)) continue;
      const existing = latest.get(playlistId);
      // ISO-8601 sorts lexicographically, so the newest `created_at` wins
      // without a Date parse that a malformed stamp could make NaN.
      if (!existing || createdAt > existing.created_at) {
        latest.set(playlistId, { playlist_id: playlistId, snapshot_id: snapshotId, created_at: createdAt, total });
      }
    } catch {
      continue; // unreadable or unparseable file: skipped, as documented
    }
  }
  return latest;
}

/** Build the row for one lane, resolving the name and reading its playlist. */
async function laneRow(
  client: SpotifyClient,
  manifest: LaneManifest,
  name: string,
): Promise<LaneRow> {
  const resolution = resolveLane(manifest, name);
  if (!resolution.ok) {
    return {
      lane: name,
      known: false,
      playlist_id: null,
      description: null,
      track_count: null,
      unreadable_reason: resolution.message,
    };
  }
  const entry = manifest[resolution.lane];
  const outcome = await playlistTrackCount(client, resolution.playlistId);
  return {
    lane: resolution.lane,
    known: true,
    playlist_id: resolution.playlistId,
    description: entry.description ?? null,
    track_count: 'count' in outcome ? outcome.count : null,
    unreadable_reason: 'count' in outcome ? null : outcome.reason,
  };
}

function renderRow(row: LaneRow): string {
  if (!row.known) return `${row.lane}: UNKNOWN — ${row.unreadable_reason}`;
  const described = row.description ? ` — ${row.description}` : '';
  const count = row.track_count === null
    ? `UNREADABLE (${row.unreadable_reason})`
    : `${row.track_count} track${row.track_count === 1 ? '' : 's'}`;
  return `${row.lane}: ${row.playlist_id}${described} — ${count}`;
}

export function registerLaneTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'list_lanes',
    'List the lane registry: every lane name defined in the lane manifest, the playlist it resolves to, '
      + 'and that playlist\'s current track count. Read-only verification of a lane mapping WITHOUT writing '
      + 'anything — use this before a lane-targeted write to confirm a label points where you expect. '
      + 'A lane whose playlist could not be read is reported as UNREADABLE with the reason, never as 0 tracks. '
      + `Manifest: ${lanesFilePath().replace(process.env.HOME ?? '~', '~')}.`,
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const manifest = await loadLanes();
      const names = Object.keys(manifest).sort();
      const rows: LaneRow[] = [];
      for (const name of names) rows.push(await laneRow(client, manifest, name));
      const shaped = truncateItems(rows, resolveMaxResults(args.max_results, rows.length));
      const unreadable = rows.filter((r) => r.unreadable_reason !== null);
      const payload = {
        ok: true,
        manifest: lanesFilePath(),
        lane_count: rows.length,
        lanes: shaped.items,
        unreadable_lane_count: unreadable.length,
        ...(unreadable.length > 0
          ? { unreadable_lanes: unreadable.map((r) => ({ lane: r.lane, reason: r.unreadable_reason })) }
          : {}),
        pagination: { total: rows.length, returned: shaped.items.length, ...(shaped.footer ? { footer: shaped.footer } : {}) },
      };
      const lines = [
        rows.length === 0
          ? `No lanes defined (manifest ${lanesFilePath()} is empty or absent). Pass target_playlist_id directly.`
          : `Lanes (${rows.length}) from ${lanesFilePath()}:`,
        ...shaped.items.map(renderRow),
      ];
      if (unreadable.length > 0) {
        lines.push(
          `${unreadable.length} lane(s) could not be read and are listed as UNREADABLE above — that is a failed `
          + 'lookup, not an empty playlist.',
        );
      }
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      }
      return textResult(lines.join('\n'), payload);
    },
  );

  server.tool(
    'lane_status',
    'Check one or more lanes: does the lane resolve, does its playlist still exist, how many tracks does it '
      + 'hold, and how far it has drifted from the last playlist-health snapshot. Read-only — performs no write '
      + 'and no playlist mutation. A lane that cannot be resolved or whose playlist cannot be read is reported '
      + 'as such with the reason, and is EXCLUDED from the summary counts rather than counted as empty.',
    {
      lane: z
        .string()
        .min(1)
        .optional()
        .describe('A single lane name. Omit to report on every lane in the registry'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const manifest = await loadLanes();
      const snapshots = await latestSnapshots(process.env);
      const names = args.lane ? [args.lane] : Object.keys(manifest).sort();
      const rows: LaneRow[] = [];
      for (const name of names) rows.push(await laneRow(client, manifest, name));

      // Staleness is per-row and only where both sides exist. `unknown` here
      // means "no snapshot recorded", which is not the same claim as "up to
      // date" — collapsing the two would report a lane that has never been
      // snapshotted as current.
      const status = rows.map((row) => {
        if (!row.known) {
          return { ...row, snapshot_id: null, snapshot_total: null, snapshot_taken_at: null, drift: null, staleness: 'lane_unknown' as const };
        }
        const snap = row.playlist_id ? snapshots.get(row.playlist_id) : undefined;
        if (!snap) {
          return { ...row, snapshot_id: null, snapshot_total: null, snapshot_taken_at: null, drift: null, staleness: 'no_snapshot' as const };
        }
        if (row.track_count === null) {
          return { ...row, snapshot_id: snap.snapshot_id, snapshot_total: snap.total, snapshot_taken_at: snap.created_at, drift: null, staleness: 'unreadable' as const };
        }
        const drift = row.track_count - snap.total;
        return {
          ...row,
          snapshot_id: snap.snapshot_id,
          snapshot_total: snap.total,
          snapshot_taken_at: snap.created_at,
          drift,
          staleness: drift === 0 ? ('unchanged' as const) : ('drifted' as const),
        };
      });

      const shaped = truncateItems(status, resolveMaxResults(args.max_results, status.length));
      const unresolved = status.filter((s) => !s.known);
      const unreadable = status.filter((s) => s.known && s.track_count === null);
      const withoutSnapshot = status.filter((s) => s.staleness === 'no_snapshot');
      const drifted = status.filter((s) => s.staleness === 'drifted');

      const payload = {
        ok: true,
        manifest: lanesFilePath(),
        lane_count: status.length,
        lanes: shaped.items,
        // Every count below is a count of lanes that were CHECKED, with the
        // unchecked ones named separately — so "0 drifted" can be read
        // correctly next to "2 lanes could not be read".
        resolved_lane_count: status.length - unresolved.length,
        unresolved_lane_count: unresolved.length,
        unreadable_lane_count: unreadable.length,
        no_snapshot_lane_count: withoutSnapshot.length,
        drifted_lane_count: drifted.length,
        ...(unresolved.length > 0
          ? { unresolved_lanes: unresolved.map((s) => ({ lane: s.lane, reason: s.unreadable_reason })) }
          : {}),
        ...(unreadable.length > 0
          ? { unreadable_lanes: unreadable.map((s) => ({ lane: s.lane, reason: s.unreadable_reason })) }
          : {}),
        pagination: { total: status.length, returned: shaped.items.length, ...(shaped.footer ? { footer: shaped.footer } : {}) },
      };

      const lines = [
        status.length === 0
          ? `No lanes to report on (manifest ${lanesFilePath()} is empty or absent).`
          : `Lane status (${status.length} checked) from ${lanesFilePath()}:`,
        ...shaped.items.map((s) => {
          const base = renderRow(s);
          if (s.staleness === 'no_snapshot') return `${base} — no snapshot recorded, drift UNKNOWN`;
          if (s.staleness === 'unreadable') return `${base} — drift UNKNOWN (playlist unreadable)`;
          if (s.staleness === 'lane_unknown') return `${base}`;
          return `${base} — snapshot ${s.snapshot_id} (${s.snapshot_total} at ${s.snapshot_taken_at}), `
            + `drift ${s.drift === null ? 'UNKNOWN' : s.drift >= 0 ? `+${s.drift}` : s.drift}`;
        }),
      ];
      if (unresolved.length > 0) {
        lines.push(`${unresolved.length} lane(s) did not resolve — see unresolved_lanes[].`);
      }
      if (unreadable.length > 0) {
        lines.push(`${unreadable.length} lane(s) had an unreadable playlist — that is a failed lookup, not an empty playlist.`);
      }
      if (withoutSnapshot.length > 0) {
        lines.push(`${withoutSnapshot.length} lane(s) have no health snapshot, so their drift is UNKNOWN rather than zero.`);
      }
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      if (args.response_format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      }
      return textResult(lines.join('\n'), payload);
    },
  );
}
