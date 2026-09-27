import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  PlaybackState,
  SpotifyQueue,
  GetDevicesResponse,
  SpotifyTrack,
  SpotifyEpisode,
  SpotifyEpisodeSimple,
  SearchResponse,
} from '../types/spotify.js';
import {
  ResponseFormat,
  MaxResults,
  PlaybackDryRun,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
  batchSummary,
  describeDryRun,
  validateUris,
} from '../shaping.js';
import { getConfig } from '../config.js';
import { MARKET_CODE } from '../markets.js';
// #603: the device row renderer is shared with the spotify://player/devices
// resource so the two surfaces cannot drift on the #855 volume guard.
import { deviceLine, DEVICES_EMPTY_MESSAGE } from '../devices.js';
import { emit, textResult, formatDuration, formatDurationOrUnknown, type EmitOptions } from '../result.js';
// #848: the two sidecar stores and the one device resolver. This module is in
// the `core` toolset, so it must not import a sibling TOOL module — a static
// import of one would evaluate that module's whole registrar in every core
// session, undoing the lazy loading from #906. Both live here for that reason.
import {
  loadPlaybackExt,
  loadExhaust2Store,
  saveExhaust2Store,
  matchDevice,
  loadDeviceLabels,
  resolveDeviceHint,
} from '../playbackstores.js';

// #595: these parameters used to advertise a default that resolved from the
// account country, and Spotify's February 2026 changes removed `country`
// from GET /me — so nothing on the account side can supply one. The
// surviving default is SPOTIFY_MCP_MARKET, applied here.
const requestMarket = (marketArg: string | undefined): string | undefined =>
  marketArg ?? getConfig().market ?? undefined;

// GET /me/player/currently-playing (subset we display)
interface CurrentlyPlayingResponse {
  item: SpotifyTrack | SpotifyEpisode | null;
  progress_ms: number | null;
  is_playing: boolean;
}

/**
 * The player state admits item kinds beyond track/episode (`currently_playing_type`
 * includes 'ad' and 'unknown'), and the typed unions do not model them (#852).
 * Render structurally so an ad never reaches a `item.show.name` dereference.
 */
type RenderableItem = {
  type?: string;
  name?: string;
  uri?: string;
  duration_ms?: number;
  artists?: Array<{ name?: string }>;
  album?: { name?: string; images?: Array<{ url?: string }> };
  show?: { name?: string };
};

function formatItem(item: RenderableItem): string {
  const name = item.name ?? 'Untitled';
  const duration =
    typeof item.duration_ms === 'number' && Number.isFinite(item.duration_ms)
      ? ` (${formatDuration(item.duration_ms)})`
      : '';
  if (item.artists) {
    const artists = item.artists.map((a) => a.name ?? 'unknown artist').join(', ');
    return `"${name}" by ${artists || 'unknown artist'}${duration}`;
  }
  if (item.show) {
    return `"${name}" — ${item.show.name ?? 'unknown show'}${duration}`;
  }
  return `"${name}" (${item.type ?? 'unknown type'})${duration}`;
}

const marketSchema = MARKET_CODE
  .optional()
  .describe(
    'ISO 3166-1 alpha-2 country code — localises item names; lowercase input is uppercased; defaults to SPOTIFY_MCP_MARKET',
  );

const additionalTypesSchema = z
  .array(z.enum(['track', 'episode']))
  .default(['track', 'episode'])
  .describe("Item types to include in the response. Default: ['track', 'episode']");

/**
 * The two ways this module's mutation results have always differed from the
 * house `emit`: the `json` body is compact (no indent), and the prose body
 * does not also carry the echo as `structuredContent` (#51/#58). Both are
 * contract, not drift, so both are named parameters on the shared helper
 * rather than a fork — see `src/result.ts`.
 */
const MUTATION_EMIT: EmitOptions = { jsonIndent: 0, proseCarriesPayload: false };

interface HandoffStep {
  method: 'PUT';
  path: string;
  body?: Record<string, unknown>;
  /** Human rendering of this call, shown verbatim in the dry run. */
  text: string;
}

interface HandoffPlan {
  /** The wire calls, in order. Dry run renders these; the commit replays them. */
  steps: HandoffStep[];
  willResume: boolean;
  progress: number | null;
  wasPlaying: boolean;
}

/** See {@link planFullStateTransfer}: the same idea, plus what it must recover. */
interface FullStatePlan {
  steps: HandoffStep[];
  play: boolean;
  progress: number;
  wasPlaying: boolean;
  itemUri: string | null;
  deviceId: string;
}

/**
 * The calls a transfer makes, derived from the captured state and the
 * arguments alone (#841, widened by #848).
 *
 * The dry run renders exactly this list and the execute path replays it
 * verbatim, so a plan can never promise a resume the commit does not perform.
 * That property is why the four transfer tools this replaced could not simply
 * be deleted: each had its own plan, and a caller of any one of them needed
 * its plan to survive.
 */
function planTransfer(
  args: {
    device_id: string;
    volume?: number;
    play?: boolean;
    preserve_position?: boolean;
    restore_shuffle_repeat?: boolean;
  },
  state:
    | {
        is_playing?: boolean;
        progress_ms?: number | null;
        item?: { uri?: string } | null;
        context?: { uri?: string | null } | null;
        shuffle_state?: boolean;
        repeat_state?: string;
      }
    | null
    | undefined,
): HandoffPlan {
  const progress = typeof state?.progress_ms === 'number' ? state.progress_ms : null;
  const wasPlaying = state?.is_playing === true;
  const itemUri = state?.item?.uri;
  const contextUri = state?.context?.uri ?? undefined;
  const trackLabel = itemUri ?? 'nothing playing';
  const deviceId = args.device_id;

  // Transfer first, and without forcing play: forcing it restarts the track,
  // which is the whole thing `preserve_position` exists to prevent. So the
  // `play` flag rides in the body only when nothing is being preserved — in
  // preserve mode the resume step below is what starts playback, and sending
  // `play: true` here as well would restart the track the resume is about to
  // seek into.
  const transferBody: Record<string, unknown> = { device_ids: [deviceId] };
  if (args.play !== undefined && !args.preserve_position) transferBody.play = args.play;
  // The arrival clause describes the `play` flag, and the paused parenthetical
  // appears only when a player read actually happened. A bare transfer never
  // fetches `/me/player`, so "(paused)" there would be a claim about a value
  // nobody looked up — the same failure as a failed lookup recorded as a
  // plausible number (#803), one layer up.
  const capturedState = args.preserve_position === true || args.restore_shuffle_repeat === true;
  const arrival =
    args.preserve_position === true
      ? 'resume at the captured position'
      : args.play === undefined
        ? 'maintain current play state'
        : `${args.play ? 'force play' : 'stay paused'} on arrival`;
  const steps: HandoffStep[] = [
    {
      method: 'PUT',
      path: '/me/player',
      body: transferBody,
      text: `Transfer playback to device ${deviceId} — ${arrival}${capturedState && !wasPlaying ? ' (the captured session was paused)' : ''}`,
    },
  ];

  // One truthiness test, shared by the flag and the step it gates: an empty
  // uri would otherwise advertise `will_resume: true` with no play step to
  // back it up — the same plan/payload divergence this plan exists to remove.
  const willResume =
    args.preserve_position === true &&
    Boolean(itemUri) &&
    progress !== null &&
    progress > 0 &&
    (wasPlaying || args.play === true);
  if (willResume && itemUri && progress !== null) {
    steps.push({
      method: 'PUT',
      path: `/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
      body: {
        position_ms: progress,
        ...(contextUri ? { context_uri: contextUri, offset: { uri: itemUri } } : { uris: [itemUri] }),
      },
      text: `Resume at ${formatDuration(progress)} into ${trackLabel}`,
    });
  }

  // shuffle and repeat are restored AFTER the resume, not before: resuming
  // into a context can reset the modes on the target device, so restoring them
  // first would have the resume undo the restore. (#668: the two spellings of
  // the device parameter differ because these two paths already carry a `?`;
  // using the leading-`?` form after `?state=` produced two question marks and
  // Spotify read `device_id` as part of the `state` value.)
  if (args.restore_shuffle_repeat === true) {
    if (typeof state?.shuffle_state === 'boolean') {
      steps.push({
        method: 'PUT',
        path: `/me/player/shuffle?state=${state.shuffle_state}&device_id=${encodeURIComponent(deviceId)}`,
        text: `Restore shuffle = ${state.shuffle_state}`,
      });
    }
    if (state?.repeat_state) {
      steps.push({
        method: 'PUT',
        path: `/me/player/repeat?state=${encodeURIComponent(state.repeat_state)}&device_id=${encodeURIComponent(deviceId)}`,
        text: `Restore repeat = ${state.repeat_state}`,
      });
    }
  }

  if (args.volume !== undefined) {
    steps.push({
      method: 'PUT',
      path: `/me/player/volume?${new URLSearchParams({
        volume_percent: String(args.volume),
        device_id: deviceId,
      })}`,
      text: `Set target volume to ${args.volume}`,
    });
  }

  return { steps, willResume, progress, wasPlaying };
}

/**
 * The FULL-STATE plan: transfer, resume, seek, and put the modes back.
 *
 * `transfer_playback_with_state` (#668) had its own planner, and three things
 * in it that the handoff-style plan above does not have:
 *
 *   - `play` DEFAULTS to true in the transfer body (a "with state" transfer is
 *     a request to keep listening, not to move a paused session);
 *   - there is always a SEPARATE `seek` after the resume, so a position lands
 *     even when the resume plays a fresh start;
 *   - each step is attempted even if an earlier one failed, and the failures
 *     are NAMED.
 *
 * That last one is why this is a second planner rather than a flag on the
 * first. A planner that advertises a list the executor may skip, or that aborts
 * on the first refusal, is a plan that can lie — which is the #841 failure the
 * first planner exists to make impossible. Keeping the two shapes separate
 * keeps both promises exact.
 */
function planFullStateTransfer(
  args: { device_id: string; play?: boolean; volume?: number },
  state:
    | {
        is_playing?: boolean;
        progress_ms?: number | null;
        item?: { uri?: string } | null;
        shuffle_state?: boolean;
        repeat_state?: string;
      }
    | null
    | undefined,
): FullStatePlan {
  const deviceId = args.device_id;
  const enc = encodeURIComponent(deviceId);
  const progress = typeof state?.progress_ms === 'number' ? state.progress_ms : 0;
  const wasPlaying = state?.is_playing === true;
  const itemUri = state?.item?.uri ?? null;
  const play = args.play ?? true;

  const steps: HandoffStep[] = [
    {
      method: 'PUT',
      path: '/me/player',
      body: { device_ids: [deviceId], play },
      text: `Transfer playback to device ${deviceId} — ${play ? 'force play' : 'stay paused'} on arrival`,
    },
  ];
  if (itemUri && play) {
    steps.push({
      method: 'PUT',
      path: `/me/player/play?device_id=${enc}`,
      body: { uris: [itemUri], position_ms: progress },
      text: `Resume ${itemUri}`,
    });
  }
  steps.push({
    method: 'PUT',
    path: `/me/player/seek?position_ms=${progress}&device_id=${enc}`,
    text: `Seek to ${formatDuration(progress)} on ${deviceId}`,
  });
  // The two spellings of the device parameter, because these two paths already
  // carry a `?`: `?device_id=` opens a query, `&device_id=` appends to one.
  // Using the leading-`?` form after `?state=` produced two question marks and
  // Spotify read `device_id` as part of the `state` value (#668).
  if (typeof state?.shuffle_state === 'boolean') {
    steps.push({
      method: 'PUT',
      path: `/me/player/shuffle?state=${state.shuffle_state}&device_id=${enc}`,
      text: `Restore shuffle = ${state.shuffle_state}`,
    });
  }
  if (state?.repeat_state) {
    steps.push({
      method: 'PUT',
      path: `/me/player/repeat?state=${encodeURIComponent(state.repeat_state)}&device_id=${enc}`,
      text: `Restore repeat = ${state.repeat_state}`,
    });
  }
  if (args.volume !== undefined) {
    steps.push({
      method: 'PUT',
      path: `/me/player/volume?${new URLSearchParams({ volume_percent: String(args.volume), device_id: deviceId })}`,
      text: `Set target volume to ${args.volume}`,
    });
  }
  return { steps, play, progress, wasPlaying, itemUri, deviceId };
}

export function registerPlaybackTools(server: McpServer, client: SpotifyClient): void {
  // get_now_playing
  server.tool(
    'get_now_playing',
    'Full device/session state for what is playing right now — item, progress, plus shuffle/repeat mode, active device, and volume. For a lightweight item+progress poll use get_currently_playing instead.',
    {
      market: marketSchema,
      additional_types: additionalTypesSchema,
      response_format: ResponseFormat,
    },
    async (args) => {
      const types = args.additional_types ?? ['track', 'episode'];
      const params: Record<string, string> = { additional_types: types.join(',') };
      const market = requestMarket(args.market);
      if (market !== undefined) params.market = market;

      // A 304 here means the origin confirmed the stored payload is still
      // current (#601): same answer, no re-download. Say so instead of
      // letting a watch loop infer a change from an identical payload.
      let unchanged = false;
      const state = await client.get<PlaybackState>('/me/player', params, {
        onNotModified: () => { unchanged = true; },
      });

      if (!state || !state.item) {
        return { content: [{ type: 'text', text: 'Nothing is currently playing.' }] };
      }

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(state) }],
          structuredContent: unchanged ? { ...state, unchanged: true } : { ...state },
        };
      }

      const { is_playing, progress_ms, shuffle_state, repeat_state, device } = state;
      const item: RenderableItem = state.item;
      const detailed = args.response_format === 'detailed';

      const lines: string[] = [];

      // One renderer for every item kind: `ad` / `unknown` items have no
      // artists and no show, and must not be dereferenced as episodes (#852).
      lines.push(`Now ${is_playing ? 'playing' : 'paused'}: ${formatItem(item)}`);
      if (item.artists) {
        if (item.album?.name) {
          lines.push(`Album: ${item.album.name}`);
        }
        const art = item.album?.images?.[0]?.url;
        if (art) {
          lines.push(`Art: ${art}`);
        }
      } else if (item.show?.name) {
        lines.push(`Show: ${item.show.name}`);
      }

      // A null progress_ms legitimately means "at the start" -> 0:00; only the
      // duration is genuinely unknown for items that omit it (ads, unknown).
      lines.push(`Progress: ${formatDuration(progress_ms ?? 0)} / ${formatDurationOrUnknown(item.duration_ms)}`);
      if (device) {
        lines.push(`Device: ${device.name} (${device.type})`);
        if (device.volume_percent !== null && device.volume_percent !== undefined) {
          lines.push(`Volume: ${device.volume_percent}%`);
        }
        if (detailed && device.id) {
          lines.push(`Device ID: ${device.id}`);
        }
      } else {
        lines.push('Device: none active');
      }
      if (detailed && state.context?.uri) {
        lines.push(`Context: ${state.context.uri}`);
      }
      lines.push(`Shuffle: ${shuffle_state ? 'on' : 'off'} | Repeat: ${repeat_state}`);
      lines.push(`URI: ${item.uri ?? 'unknown'}`);

      if (unchanged) lines.push('Unchanged since your last read (validated by ETag; no re-download).');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_currently_playing
  server.tool(
    'get_currently_playing',
    'Lightweight poll of what is playing right now: the item and progress only. For full session state (shuffle/repeat mode, active device, volume) use get_now_playing instead.',
    {
      market: marketSchema,
      additional_types: additionalTypesSchema,
      response_format: ResponseFormat,
    },
    async (args) => {
      const types = args.additional_types ?? ['track', 'episode'];
      const params: Record<string, string> = { additional_types: types.join(',') };
      const market = requestMarket(args.market);
      if (market !== undefined) params.market = market;

      let unchanged = false;
      const cp = await client.get<CurrentlyPlayingResponse>(
        '/me/player/currently-playing',
        params,
        { onNotModified: () => { unchanged = true; } },
      );

      if (!cp || !cp.item) {
        return { content: [{ type: 'text', text: 'Nothing is currently playing.' }] };
      }

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(cp) }],
          structuredContent: unchanged ? { ...cp, unchanged: true } : { ...cp },
        };
      }

      const lines = [
        `${cp.is_playing ? 'Playing' : 'Paused'}: ${formatItem(cp.item)}`,
        `Progress: ${formatDuration(cp.progress_ms ?? 0)} / ${formatDurationOrUnknown(cp.item.duration_ms)}`,
        `URI: ${cp.item.uri ?? 'unknown'}`,
      ];
      if (args.response_format === 'detailed' && 'album' in cp.item && cp.item.album?.name) {
        lines.push(`Album: ${cp.item.album.name}`);
      }

      if (unchanged) lines.push('Unchanged since your last read (validated by ETag; no re-download).');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // play_from_search
  server.tool(
    'play_from_search',
    "Search Spotify by name and immediately play the best match. Works for songs and podcast episodes — no URI needed.",
    {
      query: z.string().describe('Search text, e.g. a song title or podcast episode name'),
      search_type: z
        .enum(['track', 'episode'])
        .default('track')
        .describe("What to search for: 'track' (song) or 'episode' (podcast episode)"),
      device_id: z.string().optional().describe('Target device ID; uses active device if omitted'),
      market: MARKET_CODE
        .optional()
        .describe('ISO 3166-1 alpha-2 country code — affects availability/relinking of results; defaults to SPOTIFY_MCP_MARKET'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      const params: Record<string, string> = {
        q: args.query,
        type: args.search_type,
        limit: '10',
      };
      const market = requestMarket(args.market);
      if (market) params.market = market;

      const results = await client.get<SearchResponse>('/search', params);

      // Spotify can return literal `null` rows inside items[] (issue #28).
      // Skip them, then prefer a candidate that is actually playable in the
      // requested market over blindly taking the first row.
      const rows =
        (args.search_type === 'track' ? results?.tracks?.items : results?.episodes?.items) ?? [];
      const candidates = rows.filter(Boolean) as (SpotifyTrack | SpotifyEpisodeSimple)[];
      // `is_playable` is only present when a market filter resolved playability.
      const playable = (c: SpotifyTrack | SpotifyEpisodeSimple): boolean =>
        !('is_playable' in c && c.is_playable === false);
      const match = candidates.find(playable) ?? candidates[0];

      if (!match) {
        return { content: [{ type: 'text', text: `No playable results found for ${args.query}` }] };
      }

      const detail =
        'artists' in match
          ? formatItem(match) + ` from the album "${match.album.name}"`
          : formatItem(match);

      // dry_run (#57): the read-only search above resolved the concrete match;
      // stop here instead of overwriting queue state via PUT /me/player/play.
      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: describeDryRun('start playback', match.uri, [detail]) }],
        };
      }

      const path = args.device_id
        ? `/me/player/play?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/play';
      await client.put(path, { uris: [match.uri] });

      return emit(args.response_format, `Now playing: ${detail}`, { action: 'play', uri: match.uri }, MUTATION_EMIT);
    },
  );

  // play
  server.tool(
    'play',
    'Start or resume playback. Optionally target specific content.',
    {
      context_uri: z.string().optional().describe('Spotify URI for an album, artist, or playlist'),
      uris: z
        .array(z.string())
        .max(100)
        .optional()
        .describe('Up to 100 track/episode URIs to play as an ad-hoc queue'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Index within an album/playlist context to start from. ' +
            'Ignored for ad-hoc uris; not valid for artist contexts (use offset_uri instead).',
        ),
      offset_uri: z
        .string()
        .optional()
        .describe('Track URI inside the context to start from — required for artist contexts, where a numeric index is rejected'),
      position_ms: z.number().int().min(0).optional().describe('Seek position to start at (ms)'),
      device_id: z.string().optional().describe('Target device ID; uses active device if omitted'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      // Issue #23: mutual exclusion must hold even for an empty uris array,
      // and an empty array is never a valid request body.
      if (args.context_uri && args.uris) {
        throw new Error('Provide either context_uri or uris, not both.');
      }
      if (args.uris && args.uris.length === 0) {
        throw new Error('uris must contain at least one track/episode URI.');
      }

      // Issue #24: offset.position only applies to album/playlist contexts;
      // it is ignored for ad-hoc uris and invalid for artist contexts.
      if ((args.offset !== undefined || args.offset_uri !== undefined) && args.uris) {
        throw new Error('offset is ignored when playing ad-hoc uris — reorder the uris array instead.');
      }
      if ((args.offset !== undefined || args.offset_uri !== undefined) && !args.context_uri) {
        throw new Error(
          args.offset !== undefined
            ? 'offset requires a context_uri — it selects a position within an album/playlist context and does nothing for ad-hoc uris.'
            : 'offset_uri requires a context_uri — it starts at a track inside that context (e.g. an artist page) and cannot queue ad-hoc uris; pass uris instead.',
        );
      }

      const path = args.device_id
        ? `/me/player/play?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/play';

      const contextUri = args.context_uri;
      const body: Record<string, unknown> = {};
      if (contextUri) body.context_uri = contextUri;
      if (args.uris) body.uris = args.uris;
      if (args.offset_uri !== undefined) {
        body.offset = { uri: args.offset_uri };
      } else if (args.offset !== undefined) {
        if (contextUri?.startsWith('spotify:artist:')) {
          throw new Error(
            'Numeric offset is not valid for artist contexts — pass offset_uri with a track URI instead.',
          );
        }
        body.offset = { position: args.offset };
      }
      if (args.position_ms !== undefined) body.position_ms = args.position_ms;

      // dry_run (#57): validate URIs/targets and describe exactly what WOULD
      // be queued without replacing the current playback state.
      if (args.dry_run) {
        const candidateUris = args.uris ?? (contextUri ? [contextUri] : []);
        const { valid, invalid } = validateUris(candidateUris);
        if (invalid.length > 0) {
          throw new Error(`Invalid Spotify URI(s): ${invalid.join(', ')}`);
        }
        const target = contextUri ?? (valid.length > 0 ? `${valid.length} queued URI(s)` : 'current or active playback');
        const changes = valid.map((uri) => `queue ${uri}`);
        if (args.offset_uri) changes.push(`start at ${args.offset_uri}`);
        if (args.offset !== undefined) changes.push(`start at index ${args.offset}`);
        if (args.position_ms !== undefined) {
          changes.push(`seek to ${formatDuration(args.position_ms)} on start`);
        }
        return {
          content: [{ type: 'text', text: describeDryRun('start playback', target, changes) }],
        };
      }

      await client.put(path, Object.keys(body).length > 0 ? body : undefined);
      // #58: echo the batch so the agent has an audit trail of what was queued.
      const summary = args.uris ? `\n${batchSummary(args.uris.length, args.uris)}` : '';
      return emit(
        args.response_format,
        `Playback started.${summary}`,
        { action: 'play', ...body }, MUTATION_EMIT
      );
    },
  );

  // pause
  server.tool(
    'pause',
    'Pause playback on the active device',
    {
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: describeDryRun('pause', args.device_id ?? 'the active device', []) }],
        };
      }
      const path = args.device_id
        ? `/me/player/pause?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/pause';
      await client.put(path);
      return emit(
        args.response_format,
        'Playback paused.',
        { action: 'pause', device_id: args.device_id }, MUTATION_EMIT
      );
    },
  );

  // skip_next
  server.tool(
    'skip_next',
    'Skip to the next track in the queue or context.',
    {
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      // dry_run (#57): skipping advances past the current queue item — show
      // what would happen without consuming it (#58-style audit preview).
      if (args.dry_run) {
        return {
          content: [{
            type: 'text',
            text: describeDryRun('skip to next track', args.device_id ?? 'the active device', []),
          }],
        };
      }
      const path = args.device_id
        ? `/me/player/next?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/next';
      await client.post(path);
      return emit(
        args.response_format,
        'Skipped to next track.',
        { action: 'skip_next', device_id: args.device_id }, MUTATION_EMIT
      );
    },
  );

  // skip_previous
  server.tool(
    'skip_previous',
    'Skip to the previous track. If more than 3 seconds in, restarts the current track first.',
    {
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      if (args.dry_run) {
        return {
          content: [{
            type: 'text',
            text: describeDryRun('skip to previous track', args.device_id ?? 'the active device', []),
          }],
        };
      }
      const path = args.device_id
        ? `/me/player/previous?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/previous';
      await client.post(path);
      return emit(
        args.response_format,
        'Skipped to previous track.',
        { action: 'skip_previous', device_id: args.device_id }, MUTATION_EMIT
      );
    },
  );

  // seek
  server.tool(
    'seek',
    'Seek to a position in the current track',
    {
      position_ms: z.number().int().min(0).describe('Position in milliseconds'),
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: describeDryRun('seek', `position ${formatDuration(args.position_ms)} on ${args.device_id ?? 'the active device'}`, [`PUT /me/player/seek?position_ms=${args.position_ms}${args.device_id ? `&device_id=${args.device_id}` : ''}`]) }],
        };
      }
      const params = new URLSearchParams({ position_ms: String(args.position_ms) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/seek?${params}`);
      return emit(
        args.response_format,
        `Seeked to ${formatDuration(args.position_ms)}.`,
        { action: 'seek', position_ms: args.position_ms, device_id: args.device_id }, MUTATION_EMIT
      );
    },
  );

  // set_volume (#848) — the ONE volume writer.
  //
  // Eight tools used to write PUT /me/player/volume, each with its own naming
  // convention and its own subset of the argument space. They are one tool
  // here, selected by `op`:
  //
  //   (op omitted) + volume_percent   set one device          (was set_volume)
  //   (op omitted) + delta_step       nudge relative          (was volume_step)
  //   op: 'level'  + volume_percent   fan out over device_ids (was apply_volume_plan)
  //   op: 'level', no volume_percent  copy the active level   (was room_level)
  //   op: 'mute'                      0, remembering the level (was mute)
  //   op: 'unmute'                    restore what mute kept  (was unmute)
  //   op: 'preset'                    apply stored sidecar presets (was apply_device_presets)
  //
  // The two that survive it — volume_ramp and schedule_wind_down — stay
  // separate because they are not one-shot writes: they run an in-process timer
  // and answer with a handle, which is a different contract from "set a number".
  server.tool(
    'set_volume',
    'Set playback volume on one device, on a selection of devices, or across every live device. `volume_percent` sets an absolute level; `delta_step` nudges the current level by a signed step. `op` picks the variant: "mute" drops to 0 and remembers the level, "unmute" restores what mute remembered, "preset" applies the per-device presets stored by set_device_volume_preset, and "level" with no volume_percent copies the active device\'s level to the others. Quota: 1 write for a single device; 1 read + N writes when fanning out.',
    {
      op: z
        .enum(['level', 'mute', 'unmute', 'preset'])
        .optional()
        .describe('Variant: "level" (default) set or copy a level, "mute", "unmute", "preset"'),
      volume_percent: z.number().int().min(0).max(100).optional().describe('Absolute level 0–100. Mutually exclusive with delta_step.'),
      delta_step: z.number().int().min(-100).max(100).optional().describe('Signed nudge, e.g. +10 or -10, clamped to 0–100. Mutually exclusive with volume_percent.'),
      device_id: z.string().optional().describe('Device ID for a single-device write (default: the active device)'),
      device_ids: z.array(z.string().min(1)).optional().describe('For op "level" with volume_percent: fan out to these device ids or names. Mutually exclusive with all_devices.'),
      all_devices: z.boolean().optional().describe('For op "level" with volume_percent: set every volume-capable device, not a named selection.'),
      exclude_device_id: z.string().optional().describe('For op "level" with no volume_percent: leave this device untouched while levelling the rest'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      const fmt = args.response_format;
      const op = (args.op ?? 'level') as 'level' | 'mute' | 'unmute' | 'preset';
      const { volume_percent: target, delta_step: delta, device_id: deviceId, device_ids: deviceIds, exclude_device_id: excludeId, all_devices: allDevices } = args;

      // Every refusal below happens BEFORE any Spotify request, and every one
      // of them names the fields that collided. "Provide only one of X / Y"
      // without the second name is a guess the caller has to make twice.
      if (target !== undefined && delta !== undefined) {
        return textResult(`Provide only one of volume_percent and delta_step, not both.`, { ok: false, error: 'conflicting_inputs', fields: ['volume_percent', 'delta_step'] });
      }
      if (op !== 'level') {
        const stray = [
          ...(target !== undefined ? ['volume_percent'] : []),
          ...(delta !== undefined ? ['delta_step'] : []),
          ...(deviceIds !== undefined ? ['device_ids'] : []),
          ...(excludeId !== undefined ? ['exclude_device_id'] : []),
          ...(allDevices !== undefined ? ['all_devices'] : []),
        ];
        if (stray.length > 0) {
          return textResult(`op "${op}" takes only device_id, response_format and dry_run — ${stray.join(', ')} ${stray.length === 1 ? 'has' : 'have'} no meaning here.`, { ok: false, error: 'unsupported_for_op', op, fields: stray });
        }
      }
      if (deviceIds !== undefined && excludeId !== undefined) {
        return textResult(`Provide only one of device_ids and exclude_device_id — one selects the devices to level, the other names one to skip.`, { ok: false, error: 'conflicting_inputs', fields: ['device_ids', 'exclude_device_id'] });
      }
      if (deviceIds !== undefined && allDevices) {
        return textResult(`Provide only one of device_ids and all_devices — one names the devices to level, the other means every volume-capable one.`, { ok: false, error: 'conflicting_inputs', fields: ['device_ids', 'all_devices'] });
      }
      if (excludeId !== undefined && (target !== undefined || delta !== undefined)) {
        return textResult(`exclude_device_id means "copy the active device's level to the others", so it cannot be combined with volume_percent or delta_step.`, { ok: false, error: 'conflicting_inputs', fields: ['exclude_device_id', ...(target !== undefined ? ['volume_percent'] : ['delta_step'])] });
      }
      if ((deviceIds !== undefined || allDevices) && (target === undefined || op !== 'level')) {
        const selector = allDevices ? 'all_devices' : 'device_ids';
        return textResult(`${selector} fans one volume_percent out across devices; pass volume_percent with it.`, { ok: false, error: 'missing_input', fields: ['volume_percent'] });
      }
      // The empty-request refusal keys on `op` being ABSENT, not on every
      // level input being absent. `op: 'level'` with no `volume_percent` is the
      // documented room-level copy (`room_level`'s whole contract), and the
      // guard as first written could not tell that request from a caller who
      // sent `{}` — so it refused the retired name's own forwarding. A caller
      // who named a variant has said what they want; only a caller who named
      // nothing is ambiguous.
      if (args.op === undefined && target === undefined && delta === undefined && deviceIds === undefined && excludeId === undefined && !allDevices) {
        return textResult(`Provide volume_percent to set a level, or delta_step to nudge one.`, { ok: false, error: 'missing_input', fields: ['volume_percent', 'delta_step'] });
      }

      const volumePath = (percent: number, id?: string | null): string => {
        // #830: Spotify declares `volume_percent`, not `volume`. Getting this
        // wrong is a silent no-op in some paths and a 400 in others.
        const params = new URLSearchParams({ volume_percent: String(percent) });
        if (id) params.set('device_id', id);
        return `/me/player/volume?${params}`;
      };

      // --- op: preset (was apply_device_presets) ---------------------------
      if (op === 'preset') {
        const store = await loadPlaybackExt();
        const presets = Object.entries(store.devicePresets).filter(([, v]) => typeof v.volume === 'number');
        if (presets.length === 0) {
          return textResult('No volume presets stored. Use set_device_volume_preset first.', { ok: true, applied: 0 });
        }
        if (args.dry_run) {
          const lines = presets.map(([id, p]) => `  - ${id}: volume ${p.volume}`);
          return textResult(`[dry run] Would apply ${presets.length} preset(s):\n${lines.join('\n')}`, { ok: true, dry_run: true, applied: 0, presets: presets.length });
        }
        let applied = 0;
        const failed: string[] = [];
        for (const [id, p] of presets) {
          try { await client.put(volumePath(p.volume!, id)); applied++; } catch { failed.push(id); }
        }
        return textResult(`Applied ${applied}/${presets.length} volume presets${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`, { ok: failed.length === 0, applied, failed });
      }

      // --- op: unmute (was unmute) -----------------------------------------
      if (op === 'unmute') {
        const store = await loadExhaust2Store();
        let targetId: string | null = deviceId ?? null;
        let memory = targetId ? store.muteMemory[targetId] ?? null : store.muteMemory.active ?? null;
        if (!memory && !targetId) {
          // No explicit device: fall back to the most recent mute anywhere.
          const entries = Object.values(store.muteMemory).sort((a, b) => b.muted_at.localeCompare(a.muted_at));
          memory = entries[0] ?? null;
          targetId = memory?.device_id ?? null;
        }
        const volume = memory?.volume ?? 50;
        const source = memory ? 'remembered by mute' : 'no memory — default 50%';
        if (args.dry_run) {
          const steps = [`PUT ${volumePath(volume, targetId)} (${source})`];
          return { content: [{ type: 'text', text: describeDryRun('unmute', targetId ?? 'active device', steps) }], structuredContent: { ok: true, dry_run: true, plan: steps, volume, source } };
        }
        await client.put(volumePath(volume, targetId));
        return emit(fmt, `Unmuted → volume ${volume}% (${source}).`, { ok: true, dry_run: false, volume, source, device_id: targetId });
      }

      // --- op: mute (was mute) ----------------------------------------------
      if (op === 'mute') {
        const state = await client.get<PlaybackState>('/me/player');
        if (!state?.device && !deviceId) {
          return textResult('No active device — pass device_id to mute a specific device (volume memory is per device id).', { ok: false, error: 'no_active_device' });
        }
        const targetId = deviceId ?? state?.device?.id ?? null;
        const deviceName = state?.device?.name ?? null;
        const previous = typeof state?.device?.volume_percent === 'number' ? state.device.volume_percent : 50;
        const memoryKey = targetId ?? 'active';
        if (args.dry_run) {
          const steps = [`Remember current volume ${previous}% for ${deviceName ?? targetId ?? 'active device'}`, `PUT ${volumePath(0, targetId)}`];
          return { content: [{ type: 'text', text: describeDryRun('mute', deviceName ?? targetId ?? 'active device', steps) }], structuredContent: { ok: true, dry_run: true, plan: steps, previous_volume: previous } };
        }
        await client.put(volumePath(0, targetId)); // remember only after the mute lands — a failed PUT must leave prior memory intact (#843)
        const store = await loadExhaust2Store();
        store.muteMemory[memoryKey] = { volume: previous, muted_at: new Date().toISOString(), device_id: targetId, device_name: deviceName };
        await saveExhaust2Store(store);
        return emit(fmt, `Muted ${deviceName ?? targetId ?? 'active device'} (was ${previous}% — remembered for unmute).`, { ok: true, dry_run: false, previous_volume: previous, device_id: targetId, remembered_for: memoryKey });
      }

      // --- op: level, copying the active device (was room_level) -----------
      if (target === undefined && delta === undefined && !allDevices) {
        const res = await client.get<GetDevicesResponse>('/me/player/devices');
        const devices = (res?.devices ?? []).filter((d) => d.id);
        const active = devices.find((d) => d.is_active && typeof d.volume_percent === 'number');
        if (!active) return textResult('No active device reporting a volume — cannot level the room.', { ok: false, error: 'no_active_device' });
        const targets = devices.filter((d) => d.id !== active.id && d.id !== excludeId && !d.is_restricted);
        if (targets.length === 0) return textResult('No other live devices to level.', { ok: true, applied: 0 });
        if (args.dry_run) {
          const steps = targets.map((d) => `PUT ${volumePath(active.volume_percent!, d.id)} ("${d.name}")`);
          return { content: [{ type: 'text', text: describeDryRun('room level', `${targets.length} device(s) @ ${active.volume_percent}%`, steps) }], structuredContent: { ok: true, dry_run: true, source: { id: active.id, name: active.name, volume: active.volume_percent }, targets: targets.map((d) => ({ id: d.id, name: d.name })) } };
        }
        let applied = 0;
        const failed: string[] = [];
        for (const d of targets) {
          try { await client.put(volumePath(active.volume_percent!, d.id!)); applied++; } catch { failed.push(d.name); }
        }
        return emit(fmt, `Room levelled: ${applied}/${targets.length} device(s) → ${active.volume_percent}%${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`, { ok: failed.length === 0, source: { id: active.id, name: active.name, volume: active.volume_percent }, applied, total: targets.length, failed });
      }

      // --- op: level, fanning out (was apply_volume_plan) ------------------
      //
      // `apply_volume_plan` treated an OMITTED selection as "every
      // volume-capable device", so the collapse needs an explicit spelling for
      // that: forwarding `apply_volume_plan { volume: 25 }` to the single-device
      // branch would quietly narrow a four-device write to the active one, and
      // the caller would be told three writes succeeded that never happened.
      if (allDevices || deviceIds !== undefined) {
        if (target === undefined) {
          // Unreachable: the input checks above already refused `device_ids`
          // without `volume_percent`. Checked rather than cast so a future edit
          // to those checks cannot turn a missing level into a PUT of
          // `volume_percent=undefined`.
          return textResult('device_ids needs volume_percent.', { ok: false, error: 'missing_input', fields: ['volume_percent'] });
        }
        const res = await client.get<GetDevicesResponse>('/me/player/devices');
        const devices = res?.devices ?? [];
        const { labels } = await loadDeviceLabels();
        // One request for the whole fan-out, and the SAME precedence the
        // single-hint resolver uses — an earlier draft re-derived the name match
        // inline, which is exactly how the three resolvers drifted in the first
        // place.
        const hints = deviceIds ?? [];
        const resolved = hints.map((hint) => matchDevice(devices, hint, labels));
        const pool = allDevices ? devices : resolved.filter((d): d is NonNullable<typeof d> => d !== null);
        const missing = hints.filter((_, i) => resolved[i] === null);
        if (pool.length === 0) {
          return textResult(`No device matches ${hints.map((h) => `"${h}"`).join(', ')}. Available: ${devices.map((d) => d.name).join(', ') || 'no devices'}`, { ok: false, error: 'device_not_found', requested: hints });
        }
        // `PUT /me/player/volume?device_id=` with an empty value addresses the
        // wrong device (or 400s), so id-less entries are dropped — and counted,
        // so the caller is told how many were skipped rather than seeing fewer
        // devices written than it asked for.
        const capable = pool.filter((d) => d.supports_volume);
        const targets = capable.filter((d): d is typeof d & { id: string } => d.id !== null);
        const skippedNoId = capable.length - targets.length;
        const skippedNote = skippedNoId === 0 ? '' : ` — skipped ${skippedNoId} volume-capable device${skippedNoId === 1 ? '' : 's'} with no device id`;
        if (args.dry_run) {
          const steps = targets.map((d) => `PUT /me/player/volume?volume_percent=${target} on "${d.name}" (device ${d.id})`);
          // `devices` is the field `plan_volume_level_across_devices` published
          // and callers read to learn WHICH speakers a level would land on. It
          // survives the collapse so a forwarded call still answers the question
          // it used to answer.
          // NOT MUTATION_EMIT: a plan's `steps`/`devices`/`skipped_no_id` are
          // what the caller reads, and `plan_volume_level_across_devices`
          // published them in prose mode. Dropping them would mean a forwarded
          // call got a preview with nothing in it to check.
          return emit(fmt, describeDryRun('apply volume plan', `${targets.length} device(s) → ${target}%${skippedNote}`, steps), { dry_run: true, volume: target, steps, devices: targets.map((d) => d.id), skipped_no_id: skippedNoId, unresolved: missing }, { jsonIndent: 0 });
        }
        const applied: string[] = [];
        const failed: string[] = [];
        for (const d of targets) {
          try { await client.put(volumePath(target, d.id)); applied.push(d.name); } catch { failed.push(d.name); }
        }
        return emit(fmt, `Volume set to ${target}% on ${applied.length}/${targets.length} device(s)${skippedNote}${failed.length ? ` — failed: ${failed.join(', ')}` : ''}.`, { applied: true, volume: target, applied_devices: applied, failed_devices: failed, skipped_no_id: skippedNoId, unresolved: missing });
      }

      // --- op: level, one device (was set_volume, or volume_step by delta) --
      if (delta !== undefined) {
        const player = await client.get<PlaybackState>('/me/player');
        const cur = typeof player?.device?.volume_percent === 'number' ? player.device.volume_percent : 50;
        const stepped = Math.max(0, Math.min(100, cur + delta));
        if (args.dry_run) {
          return { content: [{ type: 'text', text: describeDryRun('volume step', `${delta > 0 ? '+' : ''}${delta}`, [`Volume ${cur} → ${stepped}`]) }], structuredContent: { ok: true, dry_run: true, from: cur, step: delta, to: stepped } };
        }
        // volume_step defaulted an unset device to the ACTIVE device's id, so
        // the write lands where the caller was already listening. Preserved
        // here: forwarding a name-only delta step would otherwise change which
        // device got quieter.
        const qs = new URLSearchParams({ volume_percent: String(stepped) });
        if (deviceId) qs.set('device_id', deviceId);
        else if (player?.device?.id) qs.set('device_id', player.device.id);
        await client.put(`/me/player/volume?${qs}`);
        return emit(fmt, `Volume ${cur} → ${stepped} (step ${delta > 0 ? '+' : ''}${delta}).`, { ok: true, from: cur, step: delta, to: stepped });
      }

      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: describeDryRun('set volume', `${target}% on ${deviceId ?? 'the active device'}`, [`PUT /me/player/volume?volume_percent=${target}${deviceId ? `&device_id=${deviceId}` : ''}`]) }],
        };
      }
      await client.put(volumePath(target as number, deviceId));
      return emit(
        fmt,
        `Volume set to ${target}%.`,
        { action: 'set_volume', volume_percent: target, device_id: deviceId }, MUTATION_EMIT
      );
    },
  );

  // set_shuffle
  server.tool(
    'set_shuffle',
    'Enable or disable shuffle mode',
    {
      state: z.boolean().describe('true = shuffle on, false = shuffle off'),
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: describeDryRun('set shuffle', `${args.state ? 'on' : 'off'} on ${args.device_id ?? 'the active device'}`, [`PUT /me/player/shuffle?state=${args.state}${args.device_id ? `&device_id=${args.device_id}` : ''}`]) }],
        };
      }
      const params = new URLSearchParams({ state: String(args.state) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/shuffle?${params}`);
      return emit(
        args.response_format,
        `Shuffle ${args.state ? 'on' : 'off'}.`,
        { action: 'set_shuffle', state: args.state, device_id: args.device_id }, MUTATION_EMIT
      );
    },
  );

  // set_repeat
  server.tool(
    'set_repeat',
    'Set repeat mode: off, context (repeat playlist/album), or track (repeat single track)',
    {
      state: z.enum(['off', 'context', 'track']).describe('Repeat mode'),
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: describeDryRun('set repeat', `${args.state} on ${args.device_id ?? 'the active device'}`, [`PUT /me/player/repeat?state=${args.state}${args.device_id ? `&device_id=${args.device_id}` : ''}`]) }],
        };
      }
      const params = new URLSearchParams({ state: args.state });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/repeat?${params}`);
      return emit(
        args.response_format,
        `Repeat set to ${args.state}.`,
        { action: 'set_repeat', state: args.state, device_id: args.device_id }, MUTATION_EMIT
      );
    },
  );

  // get_queue
  server.tool(
    'get_queue',
    'Get the current playback queue.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const queue = await client.get<SpotifyQueue>('/me/player/queue');

      if (!queue) {
        return { content: [{ type: 'text', text: 'No active playback session.' }] };
      }

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(queue) }],
          structuredContent: { ...queue },
        };
      }

      const upNext = Array.isArray(queue.queue) ? queue.queue : [];
      const shaped = truncateItems(upNext, resolveMaxResults(args.max_results));
      const detailed = args.response_format === 'detailed';

      const lines: string[] = [];

      if (queue.currently_playing) {
        lines.push(`Currently playing: ${formatItem(queue.currently_playing)}`);
      } else {
        lines.push('Currently playing: nothing');
      }

      if (upNext.length === 0) {
        lines.push('\nQueue is empty.');
      } else {
        lines.push('\nUp next:');
        shaped.items.forEach((item, i) => {
          lines.push(`  ${i + 1}. ${formatItem(item)}`);
          if (detailed && item.uri) lines.push(`      URI: ${item.uri}`);
        });
        if (shaped.footer) {
          lines.push(`  (${shaped.footer})`);
        }
      }

      // The queue endpoint has no paging — a truncated snapshot must not
      // advertise a next_offset that would mislead agents (#110 finding 13).
      const pagination = {
        total: null as number | null,
        offset: 0,
        limit: null as number | null,
        returned: upNext.length,
        next_offset: null,
      };
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, {
          currently_playing: queue.currently_playing,
          truncated: shaped.truncated,
          remaining: shaped.remaining,
        }),
      };
    },
  );

  // add_to_queue
  server.tool(
    'add_to_queue',
    'Add a track or episode to the end of the playback queue.',
    {
      uri: z.string().describe('Spotify track or episode URI (e.g. spotify:track:...)'),
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      // dry_run (#57): validate the URI and preview the append — no POST.
      if (args.dry_run) {
        const { valid, invalid } = validateUris([args.uri], ['track', 'episode']);
        if (invalid.length > 0) {
          throw new Error(`Invalid Spotify track/episode URI: ${invalid[0]}`);
        }
        return {
          content: [{
            type: 'text',
            text: describeDryRun('add to queue', valid[0], [`append ${valid[0]} to the end of the queue`]),
          }],
        };
      }
      const params = new URLSearchParams({ uri: args.uri });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.post(`/me/player/queue?${params}`);
      return emit(
        args.response_format,
        `Added ${args.uri} to queue.`,
        { action: 'add_to_queue', uri: args.uri, device_id: args.device_id }, MUTATION_EMIT
      );
    },
  );

  // get_devices
  server.tool(
    'get_devices',
    "List available Spotify Connect devices. The same rows are readable as a resource with no tool call at spotify://player/devices ('?format=json' returns the raw API object).",
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const result = await client.get<GetDevicesResponse>('/me/player/devices');

      if (!result || result.devices.length === 0) {
        return {
          content: [{
            type: 'text',
            text: DEVICES_EMPTY_MESSAGE,
          }],
        };
      }

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      }

      const shaped = truncateItems(result.devices, resolveMaxResults(args.max_results));

      // #603: the row renderer is shared with the spotify://player/devices
      // resource, so the two surfaces cannot drift on the #855 volume guard.
      const lines = shaped.items.map((d) => deviceLine(d));
      if (shaped.footer) lines.push(`(${shaped.footer})`);

      const pagination = paginationInfo({
        total: result.devices.length,
        offset: 0,
        limit: null,
        returned: result.devices.length,
      });
      return {
        content: [{ type: 'text', text: `Devices:\n${lines.join('\n')}` }],
        structuredContent: listStructuredContent(shaped.items, pagination),
      };
    },
  );

  // transfer_playback (#848) — the ONE transfer tool.
  //
  // Four tools used to move playback, each a subset of what is here:
  //
  //   transfer_playback                  a raw PUT, track restarts at 0:00
  //   handoff                            + preserve track and position, + volume
  //   switch_device                      resolve a NAME, default play:true
  //   transfer_playback_with_state       + restore shuffle and repeat
  //
  // `device` is resolved through the one server resolver (id, then the label
  // stored by rename_device, then a case-insensitive name substring), which is
  // why this now costs one extra read: the raw transfer used to take an id on
  // faith and let Spotify be the one to reject it.
  server.tool(
    'transfer_playback',
    'Move playback to a different Spotify Connect device, named by exact id, by the label you gave it, or by a case-insensitive name substring. A plain transfer restarts the track at 0:00 on the target; `preserve_position: true` carries the current track and play position across instead, and `restore_shuffle_repeat: true` re-applies the current shuffle and repeat modes on the target. Quota: 1 read to resolve the device, then 1–4 writes depending on the flags.',
    {
      device: z.string().min(1).describe('Target device: exact id, sidecar label, or case-insensitive name substring'),
      play: z.boolean().optional().describe('Force play (true) or arrive paused (false); omit to preserve the current play state. With preserve_position, true also resumes a session that is currently paused.'),
      preserve_position: z.boolean().optional().describe('Resume the current track at its current position on the target instead of restarting it (default: false)'),
      restore_shuffle_repeat: z.boolean().optional().describe('Re-apply the current shuffle and repeat modes on the target (default: false)'),
      volume: z.number().int().min(0).max(100).optional().describe('Volume to set on the target after transfer, 0–100'),
      device_id: z.string().optional().describe('DEPRECATED: use `device`'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      const fmt = args.response_format;
      // `device_id` used to be this tool's only device argument, and the
      // boundary folds it into `device` before this runs (see
      // DEPRECATED_INPUT_ALIASES) — so by here there is exactly one name to
      // read, and reading a second would be the drift the fold exists to stop.
      const hint = args.device as string;

      const { device, devices, labelLookupFailed } = await resolveDeviceHint(client, hint);
      if (!device?.id) {
        // A sidecar that would not read is named here, because the device the
        // caller meant may be the one whose LABEL could not be checked. Saying
        // "no match" without that caveat would report a definite answer to a
        // question that was only partly asked.
        const caveat = labelLookupFailed
          ? ' (the local device-label store could not be read, so a saved label was not checked: ' + labelLookupFailed + ')'
          : '';
        return textResult(
          `No device matches "${hint}"${caveat}. Available: ${devices.map((d) => d.name).join(', ') || 'no devices'}`,
          { ok: false, error: 'device_not_found', requested: hint, available: devices.map((d) => ({ id: d.id, name: d.name })) },
        );
      }
      const deviceId = device.id;
      const label = device.name;

      // Preview and commit read the SAME plan (#841): the dry run renders it,
      // the execute path replays it, so the two cannot disagree.
      const state = (args.preserve_position || args.restore_shuffle_repeat)
        ? await client.get<PlaybackState>('/me/player')
        : null;
      // `restore_shuffle_repeat` is the full-state mode: it means "put the
      // session back exactly as it was", which is `transfer_playback_with_state`
      // #668, not a flag on the handoff plan. Two planners, two shapes, so each
      // plan can describe exactly what its executor does (#841).
      const fullState = args.restore_shuffle_repeat === true;
      const handoffPlan: HandoffPlan | null = fullState
        ? null
        : planTransfer({
            device_id: deviceId,
            play: args.play,
            volume: args.volume,
            preserve_position: args.preserve_position,
            restore_shuffle_repeat: args.restore_shuffle_repeat,
          }, state);
      const fullPlan: FullStatePlan | null = fullState
        ? planFullStateTransfer({ device_id: deviceId, play: args.play, volume: args.volume }, state)
        : null;

      if (args.dry_run && fullPlan) {
        const fp = fullPlan;
        return {
          content: [{ type: 'text', text: describeDryRun('transfer playback with state', `${label} (${deviceId})`, fp.steps.map((s) => s.text)) }],
          structuredContent: {
            ok: true,
            dry_run: true,
            device_id: deviceId,
            device_name: label,
            requested: hint,
            captured: { track_uri: fp.itemUri, position_ms: fp.progress, was_playing: fp.wasPlaying },
            steps: fp.steps,
          },
        };
      }

      if (args.dry_run) {
        // Unreachable while `fullState` is true — the branch above returned —
        // and narrowed here rather than cast, so a future edit that lets the
        // full-state dry run fall through is a type error instead of a
        // `null.steps` at runtime.
        const plan = handoffPlan!;
        // structuredContent is present even on a dry run, and not just for
        // tidiness: the deprecation stamp in the boundary attaches its notice to
        // both channels or neither, so a dry run without it could not tell a
        // caller that they used a deprecated input.
        return {
          content: [{ type: 'text', text: describeDryRun('transfer playback', `${label} (${deviceId})`, plan.steps.map((s) => s.text)) }],
          structuredContent: {
            ok: true,
            dry_run: true,
            device_id: deviceId,
            device_name: label,
            requested: hint,
            will_resume: plan.willResume,
            was_playing: plan.wasPlaying,
            volume: args.volume ?? null,
            restore_shuffle_repeat: args.restore_shuffle_repeat === true,
            plan: plan.steps,
          },
        };
      }

      if (fullPlan) {
        // Every step is attempted, and a failure is NAMED rather than thrown:
        // the transfer itself succeeded, and a caller that was told "the whole
        // thing failed" would retry a move that already happened. The seek
        // after a refused resume is a recovery, so it is only issued when the
        // resume actually failed.
        const fp = fullPlan;
        const failed: string[] = [];
        const enc = encodeURIComponent(fp.deviceId);
        await client.put('/me/player', { device_ids: [fp.deviceId], play: fp.play }).catch(() => {
          failed.push('transfer');
        });
        // The seek is UNCONDITIONAL, exactly as `planFullStateTransfer`
        // advertises it. An earlier draft issued it only as a recovery from a
        // refused resume, which meant the plan listed a step the executor
        // skipped on the happy path — the #841 divergence the two planners
        // exist to make impossible, and a behaviour loss against
        // `transfer_playback_with_state`, which always issued it: a resume that
        // silently landed at 0:00 would have been reported as a clean
        // full-state transfer.
        if (fp.itemUri && fp.play) {
          await client.put(`/me/player/play?device_id=${enc}`, { uris: [fp.itemUri], position_ms: fp.progress }).catch(() => {
            // A refused resume is not itself a failed step: the seek below is
            // what puts the position back, and it is issued either way.
          });
        }
        try {
          await client.put(`/me/player/seek?position_ms=${fp.progress}&device_id=${enc}`);
        } catch {
          failed.push('seek');
        }
        if (typeof state?.shuffle_state === 'boolean') {
          await client.put(`/me/player/shuffle?state=${state.shuffle_state}&device_id=${enc}`).catch(() => {
            failed.push('shuffle');
          });
        }
        if (state?.repeat_state) {
          await client
            .put(`/me/player/repeat?state=${encodeURIComponent(state.repeat_state)}&device_id=${enc}`)
            .catch(() => {
              failed.push('repeat');
            });
        }
        if (args.volume !== undefined) {
          await client
            .put(`/me/player/volume?${new URLSearchParams({ volume_percent: String(args.volume), device_id: fp.deviceId })}`)
            .catch(() => {
              failed.push('volume');
            });
        }
        return emit(
          fmt,
          `Playback transferred to ${label} with state restored${failed.length ? ` (failed steps: ${failed.join(', ')})` : ''}.`,
          {
            transferred: failed.length === 0,
            device_id: deviceId,
            device_name: label,
            requested: hint,
            captured: { track_uri: fp.itemUri, position_ms: fp.progress, was_playing: fp.wasPlaying },
            failed_steps: failed,
            volume: args.volume,
          },
          MUTATION_EMIT,
        );
      }

      const plan = handoffPlan!;
      for (const step of plan.steps) {
        await client.put(step.path, step.body);
      }

      return emit(
        fmt,
        `Playback transferred to ${label}` +
          (plan.willResume && plan.progress !== null ? ` at ${formatDuration(plan.progress)}` : '') +
          (args.volume !== undefined ? ` (volume ${args.volume})` : '') +
          '.',
        {
          action: 'transfer_playback',
          device_id: deviceId,
          device_name: label,
          requested: hint,
          resumed_at_ms: plan.willResume ? plan.progress : null,
          was_playing: plan.wasPlaying,
          volume: args.volume,
        }, MUTATION_EMIT
      );
    },
  );
}
