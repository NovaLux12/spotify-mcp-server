/**
 * queueops (#194, #202, #224, #231): queue_playlist + save_queue_as_playlist.
 * queue_reorder / queue_remove / queue_clear were removed in #231 — those
 * endpoints do not exist (only GET and POST /me/player/queue are real).
 */
import { z } from 'zod';
import { capFor } from '../chunk.js';
import { issueReceipt, type Receipt } from '../receipts.js';
import { receiptRecords, receiptsLines, writeVerdict } from './playlistreceipts.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError } from '../client.js';
import type { SpotifyClient } from '../client.js';
import { PlaybackDryRun, describeDryRun, parseSpotifyUri, readString, ResponseFormat } from '../shaping.js';
import { graceful403Message, isRemovedEndpointFailure } from '../gating.js';
import { ARTIST_ALBUM_PAGE_LIMIT } from './catalog.js';
import type { SpotifyPaged, SpotifyTrack } from '../types/spotify.js';
import { textResult, emit } from '../result.js';
import { spotifyRef } from '../refs.js';

interface QueueFailure {
  uri: string;
  reason: string;
}

interface QueueBatchResult {
  queued: number;
  failed: QueueFailure[];
}

function queueFailureReason(error: unknown): string {
  const record = error !== null && typeof error === 'object'
    ? error as { status?: unknown; message?: unknown }
    : undefined;
  const status = error instanceof SpotifyApiError
    ? error.status
    : typeof record?.status === 'number'
      ? record.status
      : undefined;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : error === undefined || error === null
        ? 'unknown error'
        : String(error);
  const label = status === 429
    ? 'rate limited'
    : status === 404
      ? 'not found'
      : status === 403
        ? 'forbidden'
        : status === 401
          ? 'unauthorized'
          : undefined;
  if (status !== undefined) {
    const suffix = rawMessage && !rawMessage.toLowerCase().includes(label ?? '')
      ? `: ${rawMessage}`
      : '';
    return `${status} ${label ?? 'request failed'}${suffix}`;
  }
  return rawMessage || 'unknown error';
}

export async function addToQueueBatch(client: SpotifyClient, uris: string[], deviceId?: string): Promise<QueueBatchResult> {
  let queued = 0;
  const failed: QueueFailure[] = [];
  for (const uri of uris) {
    try {
      const params = new URLSearchParams({ uri });
      if (deviceId) params.set('device_id', deviceId);
      await client.post(`/me/player/queue?${params}`);
      queued++;
    } catch (error) {
      failed.push({ uri, reason: queueFailureReason(error) });
    }
  }
  return { queued, failed };
}

export function dominantQueueFailureReason(failed: QueueFailure[]): string | undefined {
  if (failed.length === 0) return undefined;
  const causeCounts = new Map<string, number>();
  for (const failure of failed) {
    const cause = failure.reason.match(/^\d{3} (?:rate limited|not found|forbidden|unauthorized|request failed)/)?.[0]
      ?? failure.reason.split(':', 1)[0];
    causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
  }
  return [...causeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function formatQueueFailures(failed: QueueFailure[]): string {
  if (failed.length === 0) return '';
  const dominant = dominantQueueFailureReason(failed);
  const shown = failed.slice(0, 3).map((failure) => `${failure.uri} — ${failure.reason}`).join('; ');
  const remainder = failed.length > 3 ? `; +${failed.length - 3} more` : '';
  return `${failed.length} failed (dominant: ${dominant}; ${shown}${remainder})`;
}

/** The app-registration-gated read the artist branch of `queue_playlist` starts from (#1225). */
const TOP_TRACKS_ENDPOINT = '/artists/{id}/top-tracks';

/**
 * Why a gated or removed answer to the artist top-tracks read falls back to
 * the albums walk, and what the caller has to be told about it.
 *
 * Whether that call answers at all is a property of the app registration, not
 * of the artist: the live OpenAPI schema still publishes the path flagged
 * `deprecated: true` with a documented 403, while Spotify's February 2026
 * changelog lists the same path as [REMOVED] with no replacement — the
 * three-way disagreement SPEC.md §`get_artist_top_tracks` records. So the
 * albums walk beneath that read is the right answer either way.
 *
 * But falling through *silently* would report an album-derived queue as an
 * artist top-tracks selection, which is this repo's own #803 class: a
 * correctly named field that lies about a read that never happened. So the
 * note names which read failed and where the tracks actually came from.
 */
function topTracksUnavailableNote(err: unknown): string {
  const status = err instanceof SpotifyApiError ? err.status : undefined;
  const why = status === 403
    ? graceful403Message(TOP_TRACKS_ENDPOINT, err as SpotifyApiError)
    : (
      `Spotify answered ${status} for ${TOP_TRACKS_ENDPOINT}, the shape a removed endpoint returns: the February 2026 ` +
      'Web API changelog lists this path as [REMOVED] with no replacement named, while the current OpenAPI schema ' +
      'still publishes it flagged `deprecated: true`.'
    );
  return (
    `${why} Either way it is the app registration rather than the artist, so that call returned no tracks at all — ` +
    'the tracks queued below come from the artist’s most recent albums, NOT from a top-tracks read.'
  );
}

/** Which read actually produced the URIs, for an artist source (#1225). */
type ArtistResolveVia = 'top_tracks' | 'albums';

interface ResolvedUris {
  uris: string[];
  sourceType: string;
  total: number;
  /** Artist sources only: which read supplied the URIs. */
  via?: ArtistResolveVia;
  /** Set only when a read failed and a fallback supplied the URIs. */
  note?: string;
}

async function resolveUris(client: SpotifyClient, sourceUri: string, limit: number): Promise<ResolvedUris> {
  const parsed = parseSpotifyUri(sourceUri);
  if (!parsed) throw new Error(`Invalid Spotify URI: ${sourceUri}`);
  const type = parsed.type;
  const id = parsed.id;
  let uris: string[] = [];
  let total = 0;
  let via: ArtistResolveVia | undefined;
  let note: string | undefined;
  if (type === 'playlist') {
    const items = await client.getAllPages<{ item?: unknown; track?: unknown }>(
      `/playlists/${id}/items`, { limit: '100' }, { maxItems: limit },
    );
    // Feb 2026 renamed the nested playable from `track` to `item`, so both
    // are read. `readString` is what replaced `(r: any) => r.item ?? r.track`
    // cast to `SpotifyTrack[]` (#1202): the old line declared a row type and
    // then threw it away with `any`, so a row whose `item` was a bare URI
    // string or an object without `uri` produced `t.uri === undefined`,
    // `.filter(Boolean)` dropped it silently, and `total` reported a number
    // lower than the row count with nothing saying a row had gone missing.
    for (const row of items) {
      const uri = readString(row.item, 'uri') ?? readString(row.track, 'uri');
      if (uri !== undefined) uris.push(uri);
    }
    total = uris.length;
    uris = uris.slice(0, limit);
  } else if (type === 'album') {
    const page = await client.get<SpotifyPaged<SpotifyTrack>>(`/albums/${id}/tracks`, { limit: String(Math.min(limit, 50)) });
    const items = page?.items ?? [];
    uris = items.map((t) => t.uri).filter(Boolean).slice(0, limit);
    total = page?.total ?? uris.length;
  } else if (type === 'artist') {
    via = 'top_tracks';
    try {
      const top = await client.get<{ tracks: SpotifyTrack[] }>(`/artists/${id}/top-tracks`, { market: 'from_token' });
      uris = (top?.tracks ?? []).map((t) => t.uri).filter(Boolean).slice(0, limit);
      total = uris.length;
    } catch (err) {
      // `isRemovedEndpointFailure` is the shared predicate from `src/gating.ts`
      // and is the right one here precisely because the endpoint is
      // registration-dependent rather than simply gone: it matches the 403 the
      // installed gating contract annotates AND a bare un-annotated 403 (the
      // same class, contract simply not installed), plus the 404/410 a removed
      // path answers with. A genuine missing artist still surfaces, because
      // the albums walk below 404s on it too. Anything else — 5xx, transport —
      // rethrows untouched, so an unrelated failure is never degraded away.
      if (!isRemovedEndpointFailure(err)) throw err;
      note = topTracksUnavailableNote(err);
    }
    if (uris.length === 0) {
      via = 'albums';
      const albums = await client.get<SpotifyPaged<{ id: string }>>(`/artists/${id}/albums`, { limit: String(ARTIST_ALBUM_PAGE_LIMIT) });
      for (const al of (albums?.items ?? []).slice(0, 5)) {
        const tr = await client.get<SpotifyPaged<SpotifyTrack>>(`/albums/${al.id}/tracks`, { limit: '20' });
        for (const t of tr?.items ?? []) { if (t?.uri) uris.push(t.uri); if (uris.length >= limit) break; }
        if (uris.length >= limit) break;
      }
      total = uris.length;
      uris = uris.slice(0, limit);
    }
  } else if (type === 'track' || type === 'episode') {
    uris = [sourceUri];
    total = 1;
  } else {
    throw new Error(`Unsupported source type: ${type} — use playlist, album, artist, track or episode`);
  }
  return { uris, sourceType: type, total, via, note };
}

export function registerQueueOpsTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'queue_playlist',
    'Queue all tracks from a playlist/album/artist URI in order (cap 200). mode=append adds to end; mode=replace is not supported — Spotify has no queue-clear endpoint.',
    {
      source_uri: z.string().describe('Source Spotify URI (playlist/album/artist/track/episode)'),
      mode: z.enum(['append', 'replace']).default('append').describe('append: add to end; replace: not supported — returns ok:false with guidance'),
      limit: z.number().int().min(1).max(200).optional().describe('Max tracks to queue (cap 200). Default 100.'),
      dry_run: PlaybackDryRun,
      response_format: ResponseFormat,
      device_id: z.string().optional().describe('Target device id for queue adds'),
    },
    async (args) => {
      // #231: mode=replace must refuse — there is no queue-clear endpoint, so
      // silently appending as "replace" is misleading.
      if (args.mode === 'replace') {
        const guidance = 'Spotify Web API has no queue-clear endpoint — mode=replace cannot be honoured. Use mode=append, or create a playlist with the desired order and play it via the play tool with context_uri.';
        return textResult(guidance, { ok: false, mode: 'replace', guidance, source_uri: args.source_uri });
      }
      const cap = Math.min(args.limit ?? 100, 200);
      const parsed = parseSpotifyUri(args.source_uri as string);
      if (!parsed) throw new Error(`Invalid Spotify URI: ${args.source_uri}`);
      const { uris, sourceType, total, via, note } = await resolveUris(client, args.source_uri as string, cap);
      // #1225: a gated/removed top-tracks answer falls back to the artist's
      // albums, and every exit carries that disclosure — `resolved_via` says
      // which read produced the list, `note` says why the other one did not.
      // Without it an album-derived queue would be reported as a top-tracks
      // selection, which is the #803 class.
      const sourceDisclosure = {
        resolved_via: via ?? null,
        note: note ?? null,
      };
      if (uris.length === 0) {
        return textResult(
          `No tracks found for ${args.source_uri} (${sourceType}).${note ? `\n${note}` : ''}`,
          { ok: true, source_uri: args.source_uri, source_type: sourceType, total: 0, queued: 0, ...sourceDisclosure },
        );
      }
      if (args.dry_run) {
        const preview = uris.slice(0, 5);
        const text = describeDryRun('queue_playlist', args.source_uri as string, [`${args.mode} ${uris.length} tracks (source: ${sourceType}, total ${total})`, ...preview]);
        return { content: [{ type: 'text', text: note ? `${text}\n${note}` : text }] };
      }
      const { queued, failed } = await addToQueueBatch(client, uris, args.device_id as string | undefined);
      const failureSummary = formatQueueFailures(failed);
      const text = `Queued ${queued}/${uris.length} tracks from ${sourceType} ${args.source_uri} (mode=${args.mode})${failureSummary ? ` — ${failureSummary}` : ''}${note ? `\n${note}` : ''}`;
      return emit(args.response_format as string | undefined, text, { ok: true, source_uri: args.source_uri, source_type: sourceType, mode: args.mode, total, queued, failed, dominant_cause: dominantQueueFailureReason(failed) ?? null, ...sourceDisclosure });
    },
  );

  // #224: save_queue_as_playlist — capture current queue as durable playlist
  server.tool(
    'save_queue_as_playlist',
    'Capture the current playback queue as a durable playlist. Reads GET /me/player/queue, creates (or appends to) a playlist, adds URIs in batches of 100 preserving order. Handles mixed track/episode URIs.',
    {
      name: z.string().optional().describe('Name for the new playlist (required when creating; omit when target_playlist_id is given)'),
      target_playlist_id: spotifyRef(z.string().optional().describe('Existing playlist ID to append to (alternative to name — when given, URIs are appended to this playlist)'), 'playlist'),
      description: z.string().optional().describe('Playlist description (when creating a new playlist)'),
      include_current: z.boolean().default(true).describe('Include the currently-playing track/episode as the first item (default true)'),
      include_episodes: z.boolean().default(true).describe('Include episodes in the saved playlist (default true — set false for tracks only)'),
      dry_run: PlaybackDryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const includeCurrent = (args.include_current as boolean | undefined) ?? true;
      const includeEpisodes = (args.include_episodes as boolean | undefined) ?? true;
      const name = args.name as string | undefined;
      const targetId = args.target_playlist_id as string | undefined;

      if (!name && !targetId) {
        throw new Error('Provide either name (to create a new playlist) or target_playlist_id (to append to an existing one).');
      }

      // Fetch current queue
      const queueData = await client.get<{
        currently_playing?: { uri?: string; type?: string; id?: string } | null;
        queue?: Array<{ uri?: string; type?: string; id?: string }>;
      }>('/me/player/queue');

      if (!queueData) {
        return textResult('Could not read the current queue — is something playing? GET /me/player/queue returned no data.', { ok: false, reason: 'no_queue_data' });
      }

      const collected: string[] = [];
      if (includeCurrent && queueData.currently_playing?.uri) {
        const cur = queueData.currently_playing;
        const isEpisode = cur.type === 'episode' || cur.uri?.includes(':episode:');
        if (includeEpisodes || !isEpisode) collected.push(cur.uri!);
      }
      for (const item of queueData.queue ?? []) {
        if (!item?.uri) continue;
        const isEpisode = item.type === 'episode' || item.uri.includes(':episode:');
        if (!includeEpisodes && isEpisode) continue;
        collected.push(item.uri);
      }

      if (collected.length === 0) {
        const hint = !includeEpisodes && (queueData.queue ?? []).some((q) => q.type === 'episode')
          ? ' (queue contained only episodes and include_episodes was false)'
          : '';
        return textResult(`Queue is empty — nothing to save${hint}. Start playback or queue some tracks first.`, { ok: true, empty: true, count: 0 });
      }

      if (args.dry_run) {
        const preview = collected.slice(0, 5);
        const target = targetId ? `playlist ${targetId}` : `new playlist "${name}"`;
        return { content: [{ type: 'text', text: describeDryRun('save_queue_as_playlist', target, [`would save ${collected.length} items from queue`, ...preview]) }] };
      }

      let playlistId: string;
      let playlistUrl: string | undefined;
      let snapshotId: string | undefined;

      if (targetId) {
        playlistId = targetId;
      } else {
        // #638: `POST /users/{user_id}/playlists` was removed by Spotify's
        // February 2026 changes; `POST /me/playlists` is the documented
        // replacement and needs no user id, so the `/me` read that only
        // existed to interpolate one is gone too. The body shape is
        // identical to `create_playlist`'s, which already posts here.
        const created = await client.post<{ id: string; external_urls?: { spotify?: string }; snapshot_id?: string }>(
          '/me/playlists',
          { name: name!, description: (args.description as string | undefined) ?? `Saved from queue on ${new Date().toISOString().slice(0, 10)}`, public: false },
        );
        if (!created?.id) throw new Error('Failed to create playlist');
        playlistId = created.id;
        playlistUrl = created.external_urls?.spotify;
        snapshotId = created.snapshot_id;
      }

      // Add URIs in batches of CHUNK_CAPS.playlist_writes. Use /items — /tracks
      // was retired for post-Nov-2024 registrations (#840, see SPEC §Playlist
      // items path).
      let added = 0;
      let lastSnapshot: string | undefined = snapshotId;
      const writeCap = capFor('playlist_writes');
      const receipts: Receipt[] = [];
      for (let i = 0; i < collected.length; i += writeCap) {
        const batch = collected.slice(i, i + writeCap);
        const res = await client.post<{ snapshot_id?: string }>(`/playlists/${playlistId}/items`, { uris: batch });
        added += batch.length;
        if (res?.snapshot_id) lastSnapshot = res.snapshot_id;
        // Each batch is verified against a re-read of the playlist (#879).
        receipts.push(await issueReceipt(client, { kind: 'playlist_items', id: playlistId, uris: batch }));
      }

      const isNew = !targetId;
      const receiptLines = receiptsLines(receipts);
      const prose = isNew
        ? `Saved ${added} items from queue to new playlist "${name}" (${playlistId})${playlistUrl ? ` — ${playlistUrl}` : ''}.`
        : `Appended ${added} items from queue to playlist ${playlistId}.`;
      const text = receiptLines ? `${prose}\n${receiptLines}` : prose;

      return emit(args.response_format as string | undefined, text, {
        ...writeVerdict(receipts, added),
        playlist_id: playlistId,
        playlist_url: playlistUrl,
        snapshot_id: lastSnapshot,
        count: added,
        uris: collected,
        is_new: isNew,
        receipts: receiptRecords(receipts),
      });
    },
  );

  server.tool(
    'batch_add_to_queue',
    'Add multiple URIs to the playback queue in one shot. POSTs each URI to /me/player/queue and returns a summary of queued/failed counts. Quota: N writes (one POST per URI).',
    {
      uris: z.array(z.string()).min(1).max(200).describe('Spotify track/episode URIs to queue (1–200)'),
      device_id: z.string().optional().describe('Target device id'),
      dry_run: PlaybackDryRun,
      response_format: ResponseFormat,
    },
    async (args) => {
      const uriList = args.uris as string[];
      for (const uri of uriList) {
        const parsed = parseSpotifyUri(uri);
        if (!parsed || (parsed.type !== 'track' && parsed.type !== 'episode')) {
          throw new Error(`Invalid Spotify track/episode URI: ${uri}`);
        }
      }
      if (args.dry_run) {
        return { content: [{ type: 'text', text: describeDryRun('batch_add_to_queue', `${uriList.length} URIs to queue`, [`Would queue ${uriList.length} URI(s)`]) }] };
      }
      const { queued, failed } = await addToQueueBatch(client, uriList, args.device_id as string | undefined);
      const failureSummary = formatQueueFailures(failed);
      const text = `Queued ${queued}/${uriList.length} tracks${failureSummary ? ` — ${failureSummary}` : ''}`;
      return emit(args.response_format as string | undefined, text, { ok: true, queued, failed, total: uriList.length, dominant_cause: dominantQueueFailureReason(failed) ?? null });
    },
  );
}
