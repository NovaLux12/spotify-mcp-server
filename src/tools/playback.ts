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
  parseSpotifyUri,
  validateUris,
} from '../shaping.js';
// #847: the local analyses behind `get_queue`'s `include` parameter. Pure
// functions over rows that were already fetched — this module issues the
// requests, `queueanalysis.ts` only computes.
import {
  duplicateAnalysis,
  formatLong,
  formatMs,
  playingRow,
  profileAnalysis,
  queueRows,
  runtimeAnalysis,
} from '../queueanalysis.js';
import { getConfig } from '../config.js';
import { MARKET_CODE } from '../markets.js';
// #603: the device row renderer is shared with the spotify://player/devices
// resource so the two surfaces cannot drift on the #855 volume guard.
import { deviceLine, DEVICES_EMPTY_MESSAGE } from '../devices.js';
import { emit, formatDuration, formatDurationOrUnknown, type EmitOptions } from '../result.js';

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

/**
 * Human label for the playback context behind the queue (#847, from
 * `describe_queue`): `playlist "Road Trip"` / `album "X"` / the bare URI for
 * any other type, since an artist or a show context has no name worth a
 * second read.
 *
 * Returns null — with the caller reporting why — when the context cannot be
 * resolved. The retired tool swallowed the failure and printed a bare URI,
 * which is a plausible-looking answer for a lookup that never happened (#803).
 */
async function resolveContextLabel(
  client: SpotifyClient,
  state: PlaybackState | null,
): Promise<string | null> {
  const ctx = state?.context?.uri;
  if (!ctx) return null;
  const parsed = parseSpotifyUri(ctx);
  if (!parsed) return ctx;
  try {
    if (parsed.type === 'playlist') {
      const playlist = await client.get<{ name?: string } | null>(`/playlists/${parsed.id}`, { fields: 'name' });
      return playlist?.name ? `playlist "${playlist.name}"` : ctx;
    }
    if (parsed.type === 'album') {
      const album = await client.get<{ name?: string } | null>(`/albums/${parsed.id}`);
      return album?.name ? `album "${album.name}"` : ctx;
    }
  } catch {
    // The context URI is still the truth about what is playing; the NAME is
    // what could not be read, so the URI is the honest answer and the reason
    // is reported beside it rather than substituted for it.
    return ctx;
  }
  return ctx;
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

/**
 * The calls a handoff makes, derived from the captured state and the arguments
 * alone (#841). The dry run renders exactly this list and the execute path
 * replays it verbatim, so a plan can never promise a resume the commit does
 * not perform. The resume is gated on the session having been PLAYING — a
 * paused session is handed over still paused, unless the caller asks for it
 * with `play: true`.
 */
function planHandoff(
  args: { device_id: string; volume?: number; play?: boolean },
  state:
    | {
        is_playing?: boolean;
        progress_ms?: number | null;
        item?: { uri?: string } | null;
        context?: { uri?: string | null } | null;
      }
    | null
    | undefined,
): HandoffPlan {
  const progress = typeof state?.progress_ms === 'number' ? state.progress_ms : null;
  const wasPlaying = state?.is_playing === true;
  const itemUri = state?.item?.uri;
  const contextUri = state?.context?.uri ?? undefined;
  const trackLabel = itemUri ?? 'nothing playing';

  // Transfer first, without forcing play: forcing it restarts the track.
  const steps: HandoffStep[] = [
    {
      method: 'PUT',
      path: '/me/player',
      body: { device_ids: [args.device_id] },
      text: `Transfer playback to device ${args.device_id}${wasPlaying ? '' : ' (paused)'}`,
    },
  ];

  // One truthiness test, shared by the flag and the step it gates: an empty
  // uri would otherwise advertise `will_resume: true` with no play step to
  // back it up — the same plan/payload divergence this plan exists to remove.
  const willResume =
    Boolean(itemUri) && progress !== null && progress > 0 && (wasPlaying || args.play === true);
  if (willResume && itemUri && progress !== null) {
    steps.push({
      method: 'PUT',
      path: `/me/player/play?device_id=${encodeURIComponent(args.device_id)}`,
      body: {
        position_ms: progress,
        ...(contextUri ? { context_uri: contextUri, offset: { uri: itemUri } } : { uris: [itemUri] }),
      },
      text: `Resume at ${formatDuration(progress)} into ${trackLabel}`,
    });
  }

  if (args.volume !== undefined) {
    steps.push({
      method: 'PUT',
      path: `/me/player/volume?${new URLSearchParams({
        volume_percent: String(args.volume),
        device_id: args.device_id,
      })}`,
      text: `Set target volume to ${args.volume}`,
    });
  }

  return { steps, willResume, progress, wasPlaying };
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

  // set_volume
  server.tool(
    'set_volume',
    'Set playback volume (0–100)',
    {
      volume_percent: z.number().int().min(0).max(100).describe('Volume level 0–100'),
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: describeDryRun('set volume', `${args.volume_percent}% on ${args.device_id ?? 'the active device'}`, [`PUT /me/player/volume?volume_percent=${args.volume_percent}${args.device_id ? `&device_id=${args.device_id}` : ''}`]) }],
        };
      }
      const params = new URLSearchParams({ volume_percent: String(args.volume_percent) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/volume?${params}`);
      return emit(
        args.response_format,
        `Volume set to ${args.volume_percent}%.`,
        { action: 'set_volume', volume_percent: args.volume_percent, device_id: args.device_id }, MUTATION_EMIT
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

  // get_queue — #847. This is the ONE queue-content entry point. It absorbed
  // describe_queue, get_queue_snapshot, queue_runtime_report,
  // queue_duplicate_check, predict_next_tracks and queue_profile, all of which
  // read the same endpoint once and answered a slightly different question.
  //
  // The three analyses are LOCAL (`src/queueanalysis.ts`), so `include` costs
  // no extra Spotify request except the one `GET /me/player` the current
  // track's remaining time needs. The queue endpoint itself is read exactly
  // once per call no matter which view or includes are asked for — that is
  // asserted on a stub call log in tests/queue.tools.test.ts, not just
  // promised here.
  server.tool(
    'get_queue',
    'Read the playback queue. Use this for queue CONTENTS (what is playing, what is up next, how long it runs, what repeats). Use peek_next for a short lookahead. Quota: 1 read; view=enriched and include=runtime add one GET /me/player, and the context label adds one catalog read.',
    {
      response_format: ResponseFormat,
      max_results: MaxResults,
      view: z.enum(['raw', 'enriched']).default('raw')
        .describe("'raw' (default) = the queue as returned. 'enriched' = plus the source context (playlist/album name) and total time remaining."),
      include: z.array(z.enum(['runtime', 'duplicates', 'profile'])).default([])
        .describe('Local analyses over the same single read, no extra request except runtime: runtime = total/avg/longest/shortest, time left on the current track, and a per-item timeline of when each row starts playing; duplicates = repeated rows and the runtime they waste; profile = unique artists/albums/shows, track-vs-episode mix, longest single-artist run.'),
    },
    async (args) => {
      const queue = await client.get<SpotifyQueue>('/me/player/queue');

      if (!queue) {
        return { content: [{ type: 'text', text: 'No active playback session.' }] };
      }

      const includes = new Set((args.include as string[] | undefined) ?? []);
      const enriched = args.view === 'enriched';
      const wantsRuntime = includes.has('runtime');

      // A bare `view=raw` with no `include` must answer exactly what it
      // answered before #847, so the fast path returns before any of this.
      if (!enriched && includes.size === 0 && args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(queue) }],
          structuredContent: { ...queue },
        };
      }

      const upNext = Array.isArray(queue.queue) ? queue.queue : [];
      const shaped = truncateItems(upNext, resolveMaxResults(args.max_results));
      const detailed = args.response_format === 'detailed';
      // Analyses run over the FULL queue, never the truncated slice: a total
      // that quietly covered only the first `max_results` rows is a wrong
      // number wearing the right field name (#803).
      const rows = queueRows(queue);

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

      const extra: Record<string, unknown> = {
        currently_playing: queue.currently_playing,
        truncated: shaped.truncated,
        remaining: shaped.remaining,
      };

      // One `GET /me/player` serves BOTH the enriched context URI and the
      // runtime's current-track position, so asking for both still costs one.
      let state: PlaybackState | null = null;
      let stateError: string | null = null;
      let stateRead = false;
      if (enriched || wantsRuntime) {
        stateRead = true;
        try {
          state = await client.get<PlaybackState>('/me/player');
        } catch (error) {
          stateError = error instanceof Error ? error.message : String(error);
        }
      }

      if (enriched) {
        const totalRemaining = rows.reduce((sum, r) => sum + r.duration_ms, 0);
        extra.context_label = await resolveContextLabel(client, state);
        extra.total_remaining_ms = totalRemaining;
        extra.total_remaining_formatted = formatLong(totalRemaining);
        // Both read paths answered, or said why they did not. `context_label`
        // being null while `context_unresolved_reason` names the failure is the
        // difference between "there is no context" and "the lookup broke".
        if (state === null && stateError !== null) extra.context_unresolved_reason = stateError;
        lines.splice(1, 0, ...(extra.context_label ? [`Source: ${extra.context_label}`] : []));
        lines.push(`\nTotal remaining: ${extra.total_remaining_formatted} across ${rows.length} item(s)`);
      }

      if (wantsRuntime) {
        const runtime = runtimeAnalysis(rows, state, stateError);
        Object.assign(extra, { runtime });
        lines.push(
          `\nRuntime: ${runtime.upcoming_count} upcoming · total ${formatMs(runtime.total_runtime_ms)} · avg ${formatMs(runtime.average_runtime_ms)}`,
        );
        lines.push(
          `  Longest: ${runtime.longest ? `"${runtime.longest.name}" (${formatMs(runtime.longest.duration_ms)})` : '—'} · Shortest: ${runtime.shortest ? `"${runtime.shortest.name}" (${formatMs(runtime.shortest.duration_ms)})` : '—'}`,
        );
        if (runtime.current_track_remaining_ms === null) {
          // Say it is unread, do not print a 0 that reads as "the current
          // track is over" (#803).
          lines.push(`  Current track remaining: unknown — ${runtime.current_track_remaining_error}`);
        } else {
          lines.push(`  Current track remaining: ${formatMs(runtime.current_track_remaining_ms)} · est. total wait ${formatMs(runtime.estimated_total_wait_ms ?? 0)}`);
        }
      }

      if (includes.has('duplicates')) {
        const dupes = duplicateAnalysis(rows);
        Object.assign(extra, { duplicates: dupes });
        lines.push(
          dupes.duplicate_groups.length
            ? `\nDuplicates: ${dupes.duplicate_groups.length} group(s) · ${dupes.total_redundant} redundant · ${formatMs(dupes.wasted_runtime_ms)} wasted`
            : '\nDuplicates: none',
        );
        for (const group of dupes.duplicate_groups) {
          lines.push(`  - "${group.name}" ×${group.occurrences} at ${group.positions.join(', ')} (${formatMs(group.wasted_runtime_ms)} wasted)`);
        }
        if (dupes.unreadable_rows) {
          lines.push(`  ${dupes.unreadable_rows} row(s) carry no URI and could not be compared`);
        }
      }

      if (includes.has('profile')) {
        // Counted over the playing item too, which is what the retired
        // `queue_profile` did — a profile that changed meaning on the way in
        // would be a different answer under a name that used to be right.
        const profile = profileAnalysis(rows, playingRow(queue.currently_playing));
        Object.assign(extra, { profile });
        lines.push(
          `\nProfile: ${profile.total} item(s) · ${profile.tracks} track(s) / ${profile.episodes} episode(s)`,
        );
        lines.push(
          `  unique artists: ${profile.unique_artists} | albums: ${profile.unique_albums} | shows: ${profile.unique_shows}`,
        );
        lines.push(
          profile.longest_artist_block
            ? `  longest single-artist run: ${profile.longest_artist_block.artist} ×${profile.longest_artist_block.tracks}`
            : '  longest single-artist run: none',
        );
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, extra),
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

  // transfer_playback
  server.tool(
    'transfer_playback',
    'Move playback to a different Spotify Connect device',
    {
      device_id: z.string().describe('Target device ID to transfer playback to'),
      play: z.boolean().optional().describe('Force play immediately (default: maintain current state)'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      // dry_run (#57): moving playback interrupts whatever is streaming on the
      // target — preview it instead of issuing PUT /me/player.
      if (args.dry_run) {
        return {
          content: [{
            type: 'text',
            text: describeDryRun(
              'transfer playback',
              args.device_id,
              [args.play === undefined ? 'maintain current play state' : `${args.play ? 'force play' : 'stay paused'} on arrival`],
            ),
          }],
        };
      }
      const body: Record<string, unknown> = { device_ids: [args.device_id] };
      if (args.play !== undefined) body.play = args.play;
      await client.put('/me/player', body);
      return emit(
        args.response_format,
        `Playback transferred to device ${args.device_id}.`,
        { action: 'transfer_playback', device_ids: [args.device_id], play: args.play }, MUTATION_EMIT
      );
    },
  );

  // handoff (#112 idea 9): move playback to another device preserving track
  // and position, optionally normalizing volume — raw transfer_playback
  // restarts the track at 0:00 and ignores the new device's volume scale.
  server.tool(
    'handoff',
    'Move playback to another device preserving the current track and play position (and optionally set the target volume) — a lossless "move to the kitchen speaker". A paused session stays paused on arrival unless play: true is passed to resume it at the captured position.',
    {
      device_id: z.string().describe('Target device ID to hand playback off to'),
      volume: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Volume to set on the target device after transfer, 0–100'),
      play: z
        .boolean()
        .optional()
        .describe('Resume playback on the target even if the session is currently paused (default: preserve the current play state)'),
      response_format: ResponseFormat,
      dry_run: PlaybackDryRun,
    },
    async (args) => {
      const state = await client.get<{
        is_playing?: boolean;
        progress_ms?: number | null;
        item?: { uri?: string } | null;
        context?: { uri?: string | null } | null;
      }>('/me/player');

      // Preview and commit read the SAME plan (#841): the dry run renders it,
      // the execute path replays it, so the two cannot disagree.
      const plan = planHandoff(args, state);

      if (args.dry_run) {
        return {
          content: [
            { type: 'text', text: describeDryRun('handoff', args.device_id, plan.steps.map((s) => s.text)) },
          ],
          structuredContent: {
            ok: true,
            dry_run: true,
            device_id: args.device_id,
            will_resume: plan.willResume,
            was_playing: plan.wasPlaying,
            volume: args.volume ?? null,
            plan: plan.steps,
          },
        };
      }

      for (const step of plan.steps) {
        await client.put(step.path, step.body);
      }

      return emit(
        args.response_format,
        `Handed off to device ${args.device_id}` +
          (plan.willResume && plan.progress !== null ? ` at ${formatDuration(plan.progress)}` : '') +
          (args.volume !== undefined ? ` (volume ${args.volume})` : '') +
          '.',
        {
          action: 'handoff',
          device_id: args.device_id,
          resumed_at_ms: plan.willResume ? plan.progress : null,
          was_playing: plan.wasPlaying,
          volume: args.volume,
        }, MUTATION_EMIT
      );
    },
  );
}
