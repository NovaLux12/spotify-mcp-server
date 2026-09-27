/**
 * Playlist batch operations — Stream D (#183, #189, #200).
 */
import { z } from 'zod';
import { capFor, runChunkedPlaylistWrite, chunk } from '../chunk.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { trustedCustomIssue } from '../custom-issues.js';
import { issueReceipt, formatReceipt } from '../receipts.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import { DryRun, PlaylistId, batchSummary, normalizePlaylistReference, parseSpotifyUri, resolveMaxResults, sharedListFields, truncateItems } from '../shaping.js';
import { walkTruncationNotice } from './playlists.js';
import { resolveRequestMarket, withMarketSource } from '../markets.js';
import { isGatedError } from '../gating.js';
import type { PlaylistItemObject, SpotifyTrack, SpotifyEpisode } from '../types/spotify.js';
import { textResult, jsonText } from '../result.js';
export const BATCH_ADD_ELICIT_THRESHOLD = 100;
// #1568: the playlist MOVE family spans two modules. Exported so the swarm3
// move tools (`move_tracks_between_playlists`, `balance_playlist_pairs`) gate
// on this same number instead of a second constant that would drift from it.
export const MOVE_ELICIT_THRESHOLD = 50;
const FETCH_ALL_CAP = () => getConfig().fetchAllCap;
const BATCH_WALK_FIELDS = {
  limit: z.number().int().min(1).max(100).optional().describe('Source page size, 1–100. Default: 100'),
  scan_cap: z.number().int().min(1).max(10_000).optional().describe('Maximum source rows to scan; bounded by SPOTIFY_MCP_FETCH_ALL_CAP'),
};
/**
 * Read a source playlist, reporting whether the walk actually reached the end.
 * A bare array cannot distinguish "read everything" from "stopped at the cap" —
 * and the destructive-set tools in this repo were reworked precisely so a
 * truncated source walk cannot be mistaken for a complete one, so these batch
 * reads get the same cap + 1 probe and drop the probe row.
 */
async function fetchPlaylistItems(
  client: SpotifyClient,
  playlistRef: string,
  options: { limit?: number; scan_cap?: number } = {},
): Promise<{ items: PlaylistItemObject[]; truncated: boolean }> {
  const id = encodeURIComponent(normalizePlaylistReference(playlistRef));
  const cap = Math.min(options.scan_cap ?? FETCH_ALL_CAP(), FETCH_ALL_CAP());
  const pageLimit = Math.min(options.limit ?? 100, 100);
  const walked = await client.getAllPages<PlaylistItemObject>(`/playlists/${id}/items`, { limit: String(pageLimit) }, { maxItems: cap + 1 });
  const truncated = walked.length > cap;
  return { items: truncated ? walked.slice(0, cap) : walked, truncated };
}

interface SavedAlbumRef { id?: string; name?: string; uri?: string; }
interface AlbumTrackRef { uri?: string | null; is_playable?: boolean; }

/**
 * Expand one album into a bounded, fail-closed list of playable track URIs.
 * Album-track objects can contain null URIs when a market blocks a track, so
 * URI shape is validated rather than trusting the collection's declared type.
 */
export async function expandAlbumToTracks(
  client: SpotifyClient,
  album: SavedAlbumRef,
  maxItems = FETCH_ALL_CAP(),
): Promise<string[]> {
  const parsedAlbum = album.uri ? parseSpotifyUri(album.uri) : null;
  const albumId = album.id ?? parsedAlbum?.id;
  if (!albumId) throw new Error('Saved album is missing a valid Spotify album ID or URI');
  const cap = Math.min(FETCH_ALL_CAP(), Math.max(0, Math.floor(maxItems)));
  if (cap === 0) return [];

  const items = await client.getAllPages<AlbumTrackRef>(
    `/albums/${encodeURIComponent(albumId)}/tracks`,
    { limit: '50' },
    { maxItems: cap },
  );
  const tracks: string[] = [];
  for (const item of items) {
    const uri = item?.uri?.trim();
    const parsed = uri ? parseSpotifyUri(uri) : null;
    if (item?.is_playable !== false && parsed?.type === 'track' && parsed.id && uri?.startsWith('spotify:track:')) tracks.push(uri);
    if (tracks.length >= cap) break;
  }
  return tracks;
}

/** A batch source that could not be turned into playable track URIs (#867). */
export interface SourceFailure {
  /** The original URI the caller passed in. */
  source: string;
  /** The URI's parsed source type. */
  type: 'album' | 'artist' | 'playlist';
  /**
   * Why no playable tracks came out of this source:
   *   - `empty`        — the API returned 200 but no rows (or zero usable rows)
   *   - `unplayable`   — the album came back with tracks but every one was
   *                      blocked (`is_playable: false` / null URI), which is the
   *                      shape Spotify returns for region-locked albums
   *   - `gated`        — 403 on an app-registration-gated path (e.g. artist
   *                      top-tracks on newer app registrations)
   *   - `forbidden`    — 403 not in the gated family
   *   - `not_found`    — 404 / 410 (entity gone or never visible to caller)
   *   - `error`        — anything else (5xx, network, malformed body, ...)
   */
  reason: 'empty' | 'unplayable' | 'gated' | 'forbidden' | 'not_found' | 'error';
}

/** Per-source-type counts of tracks contributed to the resolved list (#867). */
export interface ResolvedPerSource {
  track: number;
  episode: number;
  album: number;
  artist: number;
  playlist: number;
}

export interface ResolvedSources {
  /** Every playable track URI produced by the sources, in input order. */
  resolved: string[];
  /** Every source that did not contribute playable tracks (#867). */
  failed: SourceFailure[];
  /** URIs that could not be parsed as a known Spotify URI shape. */
  invalid: string[];
  /** Resolved track-URI counts grouped by the source type that produced them. */
  resolvedPerSource: ResolvedPerSource;
}

/**
 * Classify a Spotify error into the small set of reasons we surface to callers
 * (#867). Anything that is not a recognisable Spotify API error collapses to
 * `error` so the disclosure does not pretend the platform named a code it did not.
 */
function classifySourceError(err: unknown): SourceFailure['reason'] {
  if (!(err instanceof SpotifyApiError)) return 'error';
  if (err.status === 404 || err.status === 410) return 'not_found';
  if (err.status === 403) return isGatedError(err) ? 'gated' : 'forbidden';
  return 'error';
}

/** Human-facing label for a SourceFailure reason (#867). */
function describeFailureReason(reason: SourceFailure['reason']): string {
  switch (reason) {
    case 'empty':
      return 'empty';
    case 'unplayable':
      return 'region-locked (no playable tracks in this market)';
    case 'gated':
      return 'endpoint not available for this app registration';
    case 'forbidden':
      return 'forbidden by Spotify';
    case 'not_found':
      return 'not found';
    case 'error':
      return 'Spotify returned an error';
  }
}

async function resolveSourceUris(
  client: SpotifyClient,
  uris: string[],
  options: { limit?: number; scan_cap?: number; market?: string } = {},
  onTruncated?: (truncated: boolean) => void,
): Promise<ResolvedSources> {
  const resolved: string[] = [];
  const failed: SourceFailure[] = [];
  const invalid: string[] = [];
  const resolvedPerSource: ResolvedPerSource = { track: 0, episode: 0, album: 0, artist: 0, playlist: 0 };

  // Resolve market once for the whole batch. The artist top-tracks endpoint
  // requires a market; pre-fix we hardcoded 'US', so artist picks were always
  // the US chart regardless of the caller's account (#867). Prefer the caller's
  // `market` argument, then SPOTIFY_MCP_MARKET, then the account country, and
  // fall back to `from_token` so the request still carries a region code.
  const marketResolution = await resolveRequestMarket(client, options.market);
  const marketParam = marketResolution.market ?? 'from_token';

  for (const raw of uris) {
    const parsed = parseSpotifyUri(raw);
    if (!parsed) { invalid.push(raw); continue; }
    if (parsed.type === 'track') { resolved.push(`spotify:track:${parsed.id}`); resolvedPerSource.track++; continue; }
    if (parsed.type === 'episode') { resolved.push(`spotify:episode:${parsed.id}`); resolvedPerSource.episode++; continue; }
    if (parsed.type === 'album') {
      try {
        const tracks = await expandAlbumToTracks(client, { id: parsed.id }, options.scan_cap ?? FETCH_ALL_CAP());
        if (tracks.length > 0) { resolved.push(...tracks); resolvedPerSource.album += tracks.length; continue; }
        // expandAlbumToTracks already filtered to playable URIs, so an empty
        // result is either genuinely empty or every track came back with
        // `is_playable: false` / null URI (region-locked). Probe one row so
        // the disclosure can name the difference (#867).
        let unplayable = false;
        try {
          const probe = await client.get<{ items?: AlbumTrackRef[] }>(
            `/albums/${encodeURIComponent(parsed.id)}/tracks`,
            { limit: '1' },
          );
          const items = probe?.items ?? [];
          unplayable = items.length > 0 && items.every((t) => t?.is_playable === false || !t?.uri);
        } catch { /* fall through to 'empty' */ }
        failed.push({ source: raw, type: 'album', reason: unplayable ? 'unplayable' : 'empty' });
      } catch (err) {
        failed.push({ source: raw, type: 'album', reason: classifySourceError(err) });
      }
      continue;
    }
    if (parsed.type === 'artist') {
      try {
        const top = await client.get<{ tracks?: Array<{ uri: string }> }>(
          `/artists/${encodeURIComponent(parsed.id)}/top-tracks`,
          { market: marketParam },
        );
        const ts = top?.tracks ?? [];
        if (ts.length > 0) {
          let added = 0;
          for (const t of ts) if (t?.uri) { resolved.push(t.uri); added++; }
          resolvedPerSource.artist += added;
        } else {
          failed.push({ source: raw, type: 'artist', reason: 'empty' });
        }
      } catch (err) {
        failed.push({ source: raw, type: 'artist', reason: classifySourceError(err) });
      }
      continue;
    }
    if (parsed.type === 'playlist') {
      try {
        const { items, truncated } = await fetchPlaylistItems(client, parsed.id, options);
        onTruncated?.(truncated);
        let added = 0;
        for (const entry of items) if (entry.item?.uri) { resolved.push(entry.item.uri); added++; }
        if (added > 0) {
          resolvedPerSource.playlist += added;
        } else {
          failed.push({ source: raw, type: 'playlist', reason: 'empty' });
        }
      } catch (err) {
        failed.push({ source: raw, type: 'playlist', reason: classifySourceError(err) });
      }
      continue;
    }
    invalid.push(raw);
  }
  return { resolved, failed, invalid, resolvedPerSource };
}
function dedupeUris(uris: string[]): { unique: string[]; duplicates: number } { const seen = new Set<string>(); const unique: string[] = []; let duplicates = 0; for (const u of uris) { if (seen.has(u)) { duplicates++; continue; } seen.add(u); unique.push(u); } return { unique, duplicates }; }

/**
 * One read row of the source playlist, carrying the 0-based position the row
 * occupied. A move targets these positions instead of the bare URI, because a
 * bare URI removes EVERY occurrence of that track (#866) — which silently
 * discards the intentional repeats a DJ set or a hook-heavy playlist carries.
 */
interface SourceRow {
  entry: PlaylistItemObject;
  uri: string;
  position: number;
}
/**
 * Group `failed` entries by their source-type so a structured payload can carry
 * one number per type instead of the full list (#867). Order is fixed so a
 * reader comparing two runs is not bitten by object-key iteration order.
 */
function countFailuresByType(failed: SourceFailure[]): { album: number; artist: number; playlist: number } {
  const out = { album: 0, artist: 0, playlist: 0 };
  for (const f of failed) out[f.type]++;
  return out;
}
/**
 * Prose block listing each failed source with its reason, used when a batch
 * resolves to zero tracks or when a partial batch wants to call out what was
 * dropped (#867). Kept short — the structured payload carries the full list.
 */
function formatFailedSources(failed: SourceFailure[]): string {
  if (failed.length === 0) return '';
  return failed.map((f) => `  - ${f.source} (${f.type}, ${describeFailureReason(f.reason)})`).join('\n');
}
export function registerPlaylistBatchTools(server: McpServer, client: SpotifyClient): void {
  server.registerTool('batch_add_to_playlist', { description: 'Add tracks from multiple source URIs (tracks, albums, artists, playlists) to a target playlist in one call. Dedupes within the batch and optionally against the existing playlist. Batches writes in groups of 100. Dry-run previews without writing. Elicitation for 100+ tracks.', inputSchema: z.object({ target_playlist_id: PlaylistId.describe('Target playlist ID, spotify:playlist: URI, or URL'), source_uris: z.array(z.string()).min(1).describe('Source URIs: spotify:track:, spotify:album:, spotify:artist:, spotify:playlist:'), dedupe: z.boolean().optional().default(true).describe('Deduplicate (within batch and against target). Default: true'), dry_run: DryRun, ...BATCH_WALK_FIELDS, ...sharedListFields }) }, async (args) => {
    const targetId = args.target_playlist_id; const dedupe = args.dedupe ?? true;
    let sourceTruncated = false; let targetTruncated = false;
    // Resolve the market for the whole batch once, then re-use it both for
    // the artist top-tracks calls inside resolveSourceUris and for the
    // market/market_source disclosure on the final result (#867).
    const marketResolution = await resolveRequestMarket(client, undefined);
    const { resolved, failed, invalid, resolvedPerSource } = await resolveSourceUris(client, args.source_uris, args, (truncated) => { sourceTruncated ||= truncated; });
    const failedPerSource = countFailuresByType(failed);
    if (resolved.length === 0) {
      if (invalid.length > 0) throw new Error(`No valid track URIs resolved from sources. Invalid: ${invalid.join(', ')}`);
      const failedBlock = formatFailedSources(failed);
      const text = `No tracks resolved from ${args.source_uris.length} source(s); nothing to add.${failed.length > 0 ? `\n${failedBlock}` : ''}`;
      return withMarketSource(textResult(text, {
        ok: true,
        added: 0,
        duplicates_skipped: 0,
        skipped_empty: failed.length,
        failed,
        failed_per_source: failedPerSource,
        resolved_per_source: resolvedPerSource,
      }), marketResolution);
    }
    let deduped: string[]; let duplicates = 0; if (dedupe) { const r = dedupeUris(resolved); deduped = r.unique; duplicates = r.duplicates; } else deduped = resolved;
    let skippedExisting = 0; let toAdd = deduped; if (dedupe) { const { items: existing, truncated } = await fetchPlaylistItems(client, targetId, args); targetTruncated ||= truncated; const present = new Set<string>(); for (const item of existing) if (item.item?.uri) present.add(item.item.uri); const filtered: string[] = []; for (const u of deduped) { if (present.has(u)) skippedExisting++; else filtered.push(u); } toAdd = filtered; }
    // #864: the target walk is a cap+1 probe, so `targetTruncated` is exact —
    // but the commit path below reported neither flag, so a batch deduped
    // against a truncated read came back looking like a clean dedupe.
    const scanCap = Math.min(args.scan_cap ?? FETCH_ALL_CAP(), FETCH_ALL_CAP());
    const notice = targetTruncated
      ? walkTruncationNotice(scanCap, scanCap, true)
      : sourceTruncated
        ? `source walk(s) stopped at cap ${scanCap} — resolved tracks are a lower bound; raise SPOTIFY_MCP_FETCH_ALL_CAP to expand the rest`
        : null;
    if (args.dry_run) {
      const view = truncateItems(toAdd, resolveMaxResults(args.max_results));
      const changes = toAdd.length > 0 ? [`Would add ${toAdd.length} track(s) to playlist ${targetId}:`, ...view.items.map((u) => `  - ${u}`), ...(view.footer ? [`(${view.footer})`] : [])] : [`No new tracks to add to playlist ${targetId}${duplicates + skippedExisting > 0 ? ` (${duplicates + skippedExisting} duplicate(s) skipped)` : ''}.`];
      const failedBlock = formatFailedSources(failed);
      const text = `[dry run] batch_add_to_playlist — nothing was changed.\n${changes.join('\n')}` + (failed.length > 0 ? `\nSource(s) that resolved nothing:\n${failedBlock}` : '') + (notice ? `\n${notice}` : '');
      return withMarketSource(textResult(text, {
        ok: true,
        dry_run: true,
        changes: view.items,
        total: toAdd.length,
        returned: view.items.length,
        duplicates_skipped: duplicates,
        existing_skipped: skippedExisting,
        skipped_empty: failed.length,
        failed,
        failed_per_source: failedPerSource,
        resolved_per_source: resolvedPerSource,
        source_truncated: sourceTruncated,
        target_truncated: targetTruncated,
        scan_cap: scanCap,
      }), marketResolution);
    }
    if (toAdd.length === 0) return withMarketSource(textResult(`All ${resolved.length} resolved track(s) already present or duplicates — nothing added.` + (failed.length > 0 ? `\nSource(s) that resolved nothing:\n${formatFailedSources(failed)}` : '') + (notice ? `\n${notice}` : ''), { ok: true, added: 0, duplicates_skipped: duplicates + skippedExisting, skipped_empty: failed.length, failed, failed_per_source: failedPerSource, resolved_per_source: resolvedPerSource, source_truncated: sourceTruncated, target_truncated: targetTruncated, scan_cap: scanCap }), marketResolution);
    if (toAdd.length >= BATCH_ADD_ELICIT_THRESHOLD) { const verdict = await confirmViaElicitation(server, { message: describeConfirmation('add tracks to playlist', targetId, [`Add ${toAdd.length} track(s) from ${args.source_uris.length} source(s):`, ...toAdd.slice(0, 10), ...(toAdd.length > 10 ? [`(…and ${toAdd.length - 10} more)`] : [])]) }); const refusal = requiredConfirmationRefusal(verdict); if (refusal) return textResult(refusal.message, refusal.payload); }
    const path = `/playlists/${encodeURIComponent(targetId)}/items`; const writeCap = capFor('playlist_writes');
    // #865: a multi-chunk add that fails partway must report what already
    // landed so a retry can resume from the right offset; the older loop
    // either swallowed the error or threw without the chunk index.
    const addResult = await runChunkedPlaylistWrite(toAdd, writeCap, (chunk) => client.post<{ snapshot_id?: string }>(path, { uris: chunk }));
    if (!addResult.ok) {
      const committedCount = addResult.committed_uris;
      const lastUri = addResult.last_committed_chunk_uris[addResult.last_committed_chunk_uris.length - 1];
      const committedUpTo = lastUri ? ` Last URI committed: ${lastUri}.` : '';
      const prose = `Partial write to playlist ${targetId}: ${addResult.failed_chunk_index === 0 ? 'the first chunk failed' : `chunks 1–${addResult.failed_chunk_index} committed (${committedCount} URI(s))`}, chunk ${addResult.failed_chunk_index + 1} of ${addResult.attempted_chunks} failed.${committedUpTo} Retry the remaining ${toAdd.length - committedCount} URI(s); the committed prefix is already on the playlist. (${addResult.error})`;
      return textResult(prose, { ...addResult, target_playlist: targetId, attempted_uris: toAdd.length, committed_uris: committedCount, remaining_uris: toAdd.length - committedCount });
    }
    const snapshotId = addResult.snapshot_id; const batches = addResult.chunks;
    const receipt = await issueReceipt(client, { kind: 'playlist_items', id: targetId, uris: toAdd });
    const lines = [`Added ${toAdd.length} track(s) to playlist ${targetId} across ${batches} batch(es)` + (duplicates + skippedExisting > 0 ? `; skipped ${duplicates + skippedExisting} duplicate(s)` : '') + '.', batchSummary(toAdd.length, toAdd)];
    if (failed.length > 0) lines.push(`Source(s) that resolved nothing:\n${formatFailedSources(failed)}`);
    if (notice) lines.unshift(notice);
    if (args.response_format === 'json') return withMarketSource(textResult(jsonText({ ok: true, target_playlist: targetId, added: toAdd.length, batches, snapshot_id: snapshotId, duplicates_skipped: duplicates + skippedExisting, skipped_empty: failed.length, failed, failed_per_source: failedPerSource, resolved_per_source: resolvedPerSource, source_truncated: sourceTruncated, target_truncated: targetTruncated, scan_cap: scanCap, scan_notice: notice })), marketResolution);
    const view = truncateItems(toAdd, resolveMaxResults(args.max_results)); if (view.items.length > 0) { lines.push(''); lines.push(...view.items.map((u) => `  • ${u}`)); if (view.footer) lines.push(`(${view.footer})`); } lines.push(formatReceipt(receipt)); const text = snapshotId ? `${lines.join('\n')}\nSnapshot ID: ${snapshotId}` : lines.join('\n'); return withMarketSource(textResult(text, { ok: true, target_playlist: targetId, added: toAdd.length, skipped_duplicates: duplicates + skippedExisting, skipped_empty: failed.length, failed, failed_per_source: failedPerSource, resolved_per_source: resolvedPerSource, source_truncated: sourceTruncated, target_truncated: targetTruncated, scan_cap: scanCap, snapshot_id: snapshotId, receipt: receipt as unknown as Record<string, unknown> }), marketResolution);
  });
  server.registerTool('copy_playlist', { description: 'Duplicate an existing playlist into a new playlist, preserving track order. Creates the new playlist then adds tracks in batches of 100. Dry-run reports what would be created.', inputSchema: z.object({ source_playlist_id: PlaylistId.describe('Source playlist ID, spotify:playlist: URI, or URL'), new_name: z.string().min(1).describe('Name for the new playlist'), description: z.string().optional().describe('Description for the new playlist (defaults to source description)'), public: z.boolean().optional().describe('Public flag for the new playlist. Default: false'), collaborative: z.boolean().optional().describe('Collaborative flag. Default: false'), dry_run: DryRun, ...BATCH_WALK_FIELDS, ...sharedListFields }).superRefine((args, ctx) => { if (args.public === true && args.collaborative === true) ctx.addIssue({ ...trustedCustomIssue('playlistbatch.copyPlaylistFlags', 'A playlist cannot be both public and collaborative. Set public to false when collaborative is true.'), path: ['collaborative'] }); }) }, async (args) => {
    const sourceId = args.source_playlist_id;
    const meta = await client.get<{ id?: string; name?: string; description?: string | null }>(`/playlists/${encodeURIComponent(sourceId)}`); if (!meta) throw new Error(`Source playlist "${args.source_playlist_id}" not found`);
    const { items, truncated: sourceTruncated } = await fetchPlaylistItems(client, sourceId, args); const uris: string[] = []; let unavailable = 0; for (const entry of items) if (entry.item?.uri) uris.push(entry.item.uri); else unavailable++;
    if (args.dry_run) { const lines = [`[dry run] copy_playlist — nothing was changed.`, `Would create ${args.collaborative ? 'collaborative' : args.public ? 'public' : 'private'} playlist "${args.new_name}"` + (args.description ? ` — "${args.description}"` : meta.description ? ` — "${meta.description}"` : '') + ` with ${uris.length} track(s) from "${meta.name ?? sourceId}"` + (unavailable > 0 ? ` (${unavailable} unavailable item(s) skipped)` : '') + '.']; if (uris.length > 0) lines.push(...uris.map((u) => `  - ${u}`)); return textResult(lines.join('\n'), { ok: true, dry_run: true, source_playlist: sourceId, source_name: meta.name ?? null, would_create: args.new_name, track_count: uris.length, unavailable_skipped: unavailable, source_truncated: sourceTruncated, uris }); }
    const body: Record<string, unknown> = { name: args.new_name, public: args.public ?? false, collaborative: args.collaborative ?? false }; const desc = args.description ?? meta.description ?? undefined; if (desc !== undefined) body.description = desc;
    const created = await client.post<{ id: string; uri?: string; external_urls?: { spotify?: string } }>('/me/playlists', body); if (!created?.id) throw new Error('Could not create playlist'); const newId = created.id;
    // #865: copy_playlist creates the destination then chunks the add — the
    // older loop crashed on chunk N with no way to tell which URIs already
    // landed. Surface the same partial_write_failure contract as the other
    // multi-chunk writes so a retry can resume from the right offset.
    const writeCap = capFor('playlist_writes');
    const addResult = await runChunkedPlaylistWrite(uris, writeCap, (chunk) => client.post<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(newId)}/items`, { uris: chunk }));
    if (!addResult.ok) {
      const committedCount = addResult.committed_uris;
      const lastUri = addResult.last_committed_chunk_uris[addResult.last_committed_chunk_uris.length - 1];
      const committedUpTo = lastUri ? ` Last URI committed: ${lastUri}.` : '';
      const prose = `Partial copy to new playlist ${newId}: ${addResult.failed_chunk_index === 0 ? 'the first chunk failed' : `chunks 1–${addResult.failed_chunk_index} committed (${committedCount} URI(s))`}, chunk ${addResult.failed_chunk_index + 1} of ${addResult.attempted_chunks} failed.${committedUpTo} Retry the remaining ${uris.length - committedCount} URI(s); the committed prefix is already on the new playlist. (${addResult.error})`;
      return textResult(prose, { ...addResult, source_playlist: sourceId, new_playlist: newId, attempted_uris: uris.length, committed_uris: committedCount, remaining_uris: uris.length - committedCount });
    }
    const snapshotId = addResult.snapshot_id; const batches = addResult.chunks;
    const receipt = await issueReceipt(client, { kind: 'playlist_items', id: newId, uris });
    const lines = [`Copied playlist "${meta.name ?? sourceId}" (${uris.length} track(s)) to new playlist "${args.new_name}" (${newId})` + ` across ${batches} batch(es)` + (unavailable > 0 ? `; ${unavailable} unavailable item(s) skipped` : '') + '.', batchSummary(uris.length, uris)]; if (args.response_format === 'json') return textResult(jsonText({ ok: true, source_playlist: sourceId, new_playlist: newId, track_count: uris.length, batches, snapshot_id: snapshotId }));
    const view = truncateItems(uris, resolveMaxResults(args.max_results)); if (view.items.length > 0) { lines.push(''); lines.push(...view.items.map((u) => `  • ${u}`)); if (view.footer) lines.push(`(${view.footer})`); } lines.push(formatReceipt(receipt)); const text = snapshotId ? `${lines.join('\n')}\nSnapshot ID: ${snapshotId}` : lines.join('\n'); return textResult(text, { ok: true, source_playlist: sourceId, new_playlist: newId, track_count: uris.length, snapshot_id: snapshotId, receipt: receipt as unknown as Record<string, unknown> });
  });
  server.registerTool('move_items_between_playlists', { description: 'Bulk rehome items between playlists. Mode copy keeps the source intact; mode move removes from source after copying — by playlist position, removing exactly the transferred occurrences and leaving any other copy in the source. Supports dedupe against target and optional name/artist filter.', inputSchema: z.object({ source_playlist_id: PlaylistId.describe('Source playlist ID, spotify:playlist: URI, or URL'), target_playlist_id: PlaylistId.describe('Target playlist ID, spotify:playlist: URI, or URL'), mode: z.enum(['copy', 'move']).default('copy').describe('copy = leave source intact; move = remove from source after copy'), dedupe: z.boolean().optional().default(true).describe('Skip tracks already in target. Default: true'), filter: z.string().optional().describe('Optional substring filter: only transfer tracks whose name or artist name contains this string (case-insensitive)'), dry_run: DryRun, ...BATCH_WALK_FIELDS, ...sharedListFields }) }, async (args) => {
    const sourceId = args.source_playlist_id; const targetId = args.target_playlist_id; const dedupe = args.dedupe ?? true;
    let sourceTruncated = false;
    const firstRead = await fetchPlaylistItems(client, sourceId, args);
    sourceTruncated ||= firstRead.truncated;
    const sourceItems = firstRead.items;
    if (sourceItems.length === 0) return textResult(`Source playlist ${sourceId} is empty — nothing to ${args.mode}.`, { ok: true, moved: 0, source: sourceId, target: targetId });
    // #866: a source playlist may hold the same track more than once, and a
    // move has to take out exactly the occurrences it copied. The array index
    // of a read row IS its 0-based playlist position, so capture it HERE,
    // before the filter pass — `filter()` returns a new array, and an index
    // taken afterwards would address the wrong row. Rows without a URI are
    // dropped here because they can never be transferred or targeted.
    const sourceRows: SourceRow[] = [];
    sourceItems.forEach((entry, position) => { const uri = entry.item?.uri; if (uri) sourceRows.push({ entry, uri, position }); });
    let rows = sourceRows;
    if (args.filter) { const needle = args.filter.toLowerCase(); rows = rows.filter(({ entry }) => { const t = entry.item; if (!t) return false; const name = (t.name ?? '').toLowerCase(); if (name.includes(needle)) return true; if ('artists' in t && Array.isArray((t as SpotifyTrack).artists)) return (t as SpotifyTrack).artists.some((a) => a.name.toLowerCase().includes(needle)); if ('show' in t && (t as SpotifyEpisode).show?.name) return (t as SpotifyEpisode).show.name.toLowerCase().includes(needle); return false; }); if (rows.length === 0) return textResult(`No tracks in source playlist ${sourceId} matched filter "${args.filter}" — nothing to ${args.mode}.`, { ok: true, moved: 0, filter: args.filter }); }
    const seenWithin = new Set<string>(); const orderedUris: string[] = []; const orderedRows: SourceRow[] = []; let dupWithin = 0; for (const row of rows) { if (dedupe && seenWithin.has(row.uri)) { dupWithin++; continue; } seenWithin.add(row.uri); orderedUris.push(row.uri); orderedRows.push(row); }
    const orderedCount = orderedUris.length;
    let skippedExisting = 0; let transferRows = orderedRows; let targetTruncated = false; if (dedupe) { const { items: targetItems, truncated } = await fetchPlaylistItems(client, targetId, args); targetTruncated ||= truncated; const targetSet = new Set<string>(); for (const entry of targetItems) if (entry.item?.uri) targetSet.add(entry.item.uri); const filtered: SourceRow[] = []; for (const row of orderedRows) { if (targetSet.has(row.uri)) skippedExisting++; else filtered.push(row); } transferRows = filtered; }
    const toTransfer = transferRows.map((r) => r.uri);
    if (toTransfer.length === 0) { const reason = skippedExisting > 0 || dupWithin > 0 ? `all ${orderedCount} track(s) already in target or duplicates — nothing to ${args.mode}` : 'no transferable tracks'; return textResult(`${reason}.`, { ok: true, moved: 0, skipped_duplicates: skippedExisting + dupWithin }); }
    if (args.dry_run) { const view = truncateItems(toTransfer, resolveMaxResults(args.max_results)); const action = args.mode === 'move' ? 'move' : 'copy'; const dest = args.mode === 'move' ? `${sourceId} → ${targetId} (removing from source)` : `${sourceId} → ${targetId}`; return textResult(`[dry run] move_items_between_playlists — nothing was changed.\nWould ${action} ${toTransfer.length} track(s): ${dest}\n` + view.items.map((u) => `  - ${u}`).join('\n') + (view.footer ? `\n(${view.footer})` : '') + (skippedExisting + dupWithin > 0 ? `\n(${skippedExisting + dupWithin} duplicate(s) skipped)` : '') + (args.mode === 'move' ? `\nWould remove ${toTransfer.length} occurrence(s) from ${sourceId}, each addressed by playlist position, so other copies of the same track stay in the source.` : ''), { ok: true, dry_run: true, mode: args.mode, source: sourceId, target: targetId, would_transfer: toTransfer.length, would_remove_occurrences: args.mode === 'move' ? toTransfer.length : 0, uris: view.items, total: toTransfer.length, returned: view.items.length, skipped_duplicates: skippedExisting + dupWithin, source_truncated: sourceTruncated, target_truncated: targetTruncated }); }
    // #866: the removal is planned up front, from the source rows that were
    // actually transferred, and ordered by DESCENDING position. There is no
    // runtime re-check of the plan against the read: the positions ARE indices
    // the walk produced, so any comparison here would be comparing the
    // derivation with itself and could never fail. The property that actually
    // makes the chunked delete safe is the ordering, and it is asserted where it
    // is observable — on the requests, in tests/tools.playlistbatch.test.ts.
    const removals: Array<{ uri: string; position: number }> = args.mode === 'move'
      ? transferRows.map((r) => ({ uri: r.uri, position: r.position })).sort((a, b) => b.position - a.position)
      : [];
    if (toTransfer.length >= MOVE_ELICIT_THRESHOLD) { const verdict = await confirmViaElicitation(server, { message: describeConfirmation(`${args.mode} tracks between playlists`, `${sourceId} → ${targetId}`, [`${args.mode === 'move' ? 'Move' : 'Copy'} ${toTransfer.length} track(s) from ${sourceId} to ${targetId}:`, ...toTransfer.slice(0, 10), ...(toTransfer.length > 10 ? [`(…and ${toTransfer.length - 10} more)`] : []), ...(args.mode === 'move' ? ['Each is removed from the source by playlist position, so any other copy of the same track stays put.'] : [])]) }); const refusal = requiredConfirmationRefusal(verdict); if (refusal) return textResult(refusal.message, refusal.payload); }
    // #865: the add is chunked, so it can fail mid-batch and leave the target
    // holding a prefix with no way to tell which URIs landed. `runChunkedPlaylistWrite`
    // reports the failed chunk and the committed prefix, so a retry resumes at the
    // right offset instead of duplicating what already transferred.
    const writeCap = capFor('playlist_writes');
    const addResult = await runChunkedPlaylistWrite(toTransfer, writeCap, (chunk) => client.post<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(targetId)}/items`, { uris: chunk }));
    if (!addResult.ok) {
      const committedCount = addResult.committed_uris;
      const lastUri = addResult.last_committed_chunk_uris[addResult.last_committed_chunk_uris.length - 1];
      const committedUpTo = lastUri ? ` Last URI committed to target: ${lastUri}.` : '';
      const prose = `Partial ${args.mode} from ${sourceId} → ${targetId}: ${addResult.failed_chunk_index === 0 ? 'the first add chunk failed' : `${addResult.failed_chunk_index} add chunk(s) committed to target (${committedCount} URI(s))`}, add chunk ${addResult.failed_chunk_index + 1} of ${addResult.attempted_chunks} failed.${committedUpTo} Retry the remaining ${toTransfer.length - committedCount} URI(s); the committed target prefix is already there. (${addResult.error})`;
      return textResult(prose, { ...addResult, mode: args.mode, source: sourceId, target: targetId, step: 'add', attempted_uris: toTransfer.length, committed_uris: committedCount, remaining_uris: toTransfer.length - committedCount });
    }
    const addSnapshot = addResult.snapshot_id; const addBatches = addResult.chunks;
    // #866: each transferred occurrence is removed with `{ uri, positions: [p] }`,
    // ordered DESCENDING. Descending is what makes multi-entry requests safe
    // under either reading of the endpoint: a removal only re-indexes rows ABOVE
    // it, so every later entry in the same request — and every later request —
    // still addresses the row it was planned against. The old bare-URI delete had
    // no position to order and took out every repeat of the track.
    let removeSnapshot: string | undefined; let removedOccurrences = 0; let removeBatches = 0;
    if (args.mode === 'move') {
      // #865's partial-write contract, carrying #866's positional payload. The
      // chunk rows are recovered BY INDEX, not by looking a URI up: with
      // `dedupe: false` the same URI can appear twice in `removals` at two
      // different positions, and a uri→position map would collapse those two
      // distinct occurrences into one and silently drop a removal.
      const removeResult = await runChunkedPlaylistWrite(removals.map((r) => r.uri), writeCap, (chunkUris, chunkIndex) => {
        const start = chunkIndex * writeCap;
        const chunkRows = removals.slice(start, start + chunkUris.length);
        return client.delete<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(sourceId)}/items`, { tracks: chunkRows.map((r) => ({ uri: r.uri, positions: [r.position] })) });
      });
      if (!removeResult.ok) {
        const committedCount = removeResult.committed_uris;
        const lastUri = removeResult.last_committed_chunk_uris[removeResult.last_committed_chunk_uris.length - 1];
        const committedUpTo = lastUri ? ` Last occurrence removed from source: ${lastUri}.` : '';
        const prose = `Partial ${args.mode} from ${sourceId} → ${targetId}: target add succeeded for all ${toTransfer.length} URI(s), but ${removeResult.failed_chunk_index === 0 ? 'the first remove chunk failed' : `remove chunks 1–${removeResult.failed_chunk_index} completed (${committedCount} occurrence(s))`}, remove chunk ${removeResult.failed_chunk_index + 1} of ${removeResult.attempted_chunks} failed.${committedUpTo} ${committedCount} occurrence(s) now exist on BOTH playlists; retry the remaining ${removals.length - committedCount} removal(s) against ${sourceId}. (${removeResult.error})`;
        return textResult(prose, { ...removeResult, mode: args.mode, source: sourceId, target: targetId, step: 'remove', attempted_occurrences: removals.length, committed_occurrences: committedCount, remaining_occurrences: removals.length - committedCount, snapshot_id: addSnapshot });
      }
      removeSnapshot = removeResult.snapshot_id; removedOccurrences = removals.length; removeBatches = removeResult.chunks;
    }
    if (args.mode === 'move' && removedOccurrences !== toTransfer.length) throw new Error(`Copied ${toTransfer.length} track(s) from ${sourceId} to ${targetId} but removed ${removedOccurrences} source occurrence(s) — the counts disagree, so re-read the source playlist before retrying.`);
    const receipt = await issueReceipt(client, { kind: 'playlist_items', id: targetId, uris: toTransfer });
    const actionLabel = args.mode === 'move' ? 'Moved' : 'Copied'; const lines = [`${actionLabel} ${toTransfer.length} track(s) from ${sourceId} to ${targetId} across ${addBatches} batch(es)` + (skippedExisting + dupWithin > 0 ? `; skipped ${skippedExisting + dupWithin} duplicate(s)` : '') + (args.filter ? ` (filter: "${args.filter}")` : '') + '.', batchSummary(toTransfer.length, toTransfer)]; if (args.mode === 'move') lines.push(`Removed ${removedOccurrences} occurrence(s) from the source by playlist position; any other copy of the same track was left in place.`); if (args.response_format === 'json') return textResult(jsonText({ ok: true, mode: args.mode, source: sourceId, target: targetId, transferred: toTransfer.length, removed_occurrences: removedOccurrences, add_batches: addBatches, remove_batches: removeBatches, snapshot_id: addSnapshot, remove_snapshot: removeSnapshot }));
    const view = truncateItems(toTransfer, resolveMaxResults(args.max_results)); if (view.items.length > 0) { lines.push(''); lines.push(...view.items.map((u) => `  • ${u}`)); if (view.footer) lines.push(`(${view.footer})`); } lines.push(formatReceipt(receipt)); let snapLine = ''; if (addSnapshot) snapLine += `\nSnapshot ID: ${addSnapshot}`; if (removeSnapshot) snapLine += `\nSource snapshot ID: ${removeSnapshot}`; return textResult(`${lines.join('\n')}${snapLine}`, { ok: true, mode: args.mode, source: sourceId, target: targetId, transferred: toTransfer.length, removed_occurrences: removedOccurrences, snapshot_id: addSnapshot, receipt: receipt as unknown as Record<string, unknown> });
  });
}
