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
  DryRun,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
  batchSummary,
  describeDryRun,
  validateUris,
} from '../shaping.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
// GET /me/player/currently-playing (subset we display)
interface CurrentlyPlayingResponse {
  item: SpotifyTrack | SpotifyEpisode | null;
  progress_ms: number | null;
  is_playing: boolean;
}

function formatItem(item: SpotifyTrack | SpotifyEpisode | SpotifyEpisodeSimple): string {
  if ('artists' in item) {
    const artists = item.artists.map((a) => a.name).join(', ');
    return `"${item.name}" by ${artists} (${formatDuration(item.duration_ms)})`;
  } else {
    return `"${item.name}" — ${item.show.name} (${formatDuration(item.duration_ms)})`;
  }
}

const marketSchema = z
  .string()
  .optional()
  .describe('ISO 3166-1 alpha-2 country code — localises item names; defaults to the account market');

const additionalTypesSchema = z
  .array(z.enum(['track', 'episode']))
  .default(['track', 'episode'])
  .describe("Item types to include in the response. Default: ['track', 'episode']");

/**
 * Emit a mutation result: `json` mode returns a machine-readable echo of what
 * was done (#51/#58); otherwise the human text is returned unchanged.
 */
function mutationResult(
  format: string | undefined,
  echo: Record<string, unknown>,
  text: string,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  if (format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(echo) }],
      structuredContent: echo,
    };
  }
  return { content: [{ type: 'text', text }] };
}

export function registerPlaybackTools(server: McpServer, client: SpotifyClient): void {
  // get_now_playing
  server.tool(
    'get_now_playing',
    'Get the currently playing track or episode and full playback state',
    {
      market: marketSchema,
      additional_types: additionalTypesSchema,
      response_format: ResponseFormat,
    },
    async (args) => {
      const types = args.additional_types ?? ['track', 'episode'];
      const params: Record<string, string> = { additional_types: types.join(',') };
      if (args.market !== undefined) params.market = args.market;

      const state = await client.get<PlaybackState>('/me/player', params);

      if (!state || !state.item) {
        return { content: [{ type: 'text', text: 'Nothing is currently playing.' }] };
      }

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(state) }],
          structuredContent: { ...state },
        };
      }

      const { item, is_playing, progress_ms, shuffle_state, repeat_state, device } = state;
      const detailed = args.response_format === 'detailed';

      const lines: string[] = [];

      if (item.type === 'track') {
        const artists = item.artists.map((a) => a.name).join(', ');
        lines.push(`Now ${is_playing ? 'playing' : 'paused'}: "${item.name}" by ${artists}`);
        lines.push(`Album: ${item.album.name}`);
        if (item.album.images[0]) {
          lines.push(`Art: ${item.album.images[0].url}`);
        }
      } else {
        lines.push(`Now ${is_playing ? 'playing' : 'paused'}: "${item.name}"`);
        lines.push(`Show: ${item.show.name}`);
      }

      const progress = progress_ms ?? 0;
      lines.push(`Progress: ${formatDuration(progress)} / ${formatDuration(item.duration_ms)}`);
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
      lines.push(`URI: ${item.uri}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // get_currently_playing
  server.tool(
    'get_currently_playing',
    'Lightweight poll of what is playing right now: the item, progress, and playing state',
    {
      market: marketSchema,
      additional_types: additionalTypesSchema,
      response_format: ResponseFormat,
    },
    async (args) => {
      const types = args.additional_types ?? ['track', 'episode'];
      const params: Record<string, string> = { additional_types: types.join(',') };
      if (args.market !== undefined) params.market = args.market;

      const cp = await client.get<CurrentlyPlayingResponse>(
        '/me/player/currently-playing',
        params,
      );

      if (!cp || !cp.item) {
        return { content: [{ type: 'text', text: 'Nothing is currently playing.' }] };
      }

      if (args.response_format === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(cp) }],
          structuredContent: { ...cp },
        };
      }

      const lines = [
        `${cp.is_playing ? 'Playing' : 'Paused'}: ${formatItem(cp.item)}`,
        `Progress: ${formatDuration(cp.progress_ms ?? 0)} / ${formatDuration(cp.item.duration_ms)}`,
        `URI: ${cp.item.uri}`,
      ];
      if (args.response_format === 'detailed' && 'album' in cp.item && cp.item.album?.name) {
        lines.push(`Album: ${cp.item.album.name}`);
      }

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
      market: z
        .string()
        .optional()
        .describe('ISO 3166-1 alpha-2 country code — affects availability/relinking of results; defaults to the account market'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const params: Record<string, string> = {
        q: args.query,
        type: args.search_type,
        limit: '10',
      };
      if (args.market) params.market = args.market;

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

      return mutationResult(args.response_format, { action: 'play', uri: match.uri }, `Now playing: ${detail}`);
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
      dry_run: DryRun,
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
        throw new Error('offset requires a context_uri.');
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
      return mutationResult(
        args.response_format,
        { action: 'play', ...body },
        `Playback started.${summary}`,
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
    },
    async (args) => {
      const path = args.device_id
        ? `/me/player/pause?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/pause';
      await client.put(path);
      return mutationResult(
        args.response_format,
        { action: 'pause', device_id: args.device_id },
        'Playback paused.',
      );
    },
  );

  // skip_next
  server.tool(
    'skip_next',
    'Skip to the next track in the queue or context',
    {
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: DryRun,
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
      return mutationResult(
        args.response_format,
        { action: 'skip_next', device_id: args.device_id },
        'Skipped to next track.',
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
      dry_run: DryRun,
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
      return mutationResult(
        args.response_format,
        { action: 'skip_previous', device_id: args.device_id },
        'Skipped to previous track.',
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
    },
    async (args) => {
      const params = new URLSearchParams({ position_ms: String(args.position_ms) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/seek?${params}`);
      return mutationResult(
        args.response_format,
        { action: 'seek', position_ms: args.position_ms, device_id: args.device_id },
        `Seeked to ${formatDuration(args.position_ms)}.`,
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
    },
    async (args) => {
      const params = new URLSearchParams({ volume_percent: String(args.volume_percent) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/volume?${params}`);
      return mutationResult(
        args.response_format,
        { action: 'set_volume', volume_percent: args.volume_percent, device_id: args.device_id },
        `Volume set to ${args.volume_percent}%.`,
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
    },
    async (args) => {
      const params = new URLSearchParams({ state: String(args.state) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/shuffle?${params}`);
      return mutationResult(
        args.response_format,
        { action: 'set_shuffle', state: args.state, device_id: args.device_id },
        `Shuffle ${args.state ? 'on' : 'off'}.`,
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
    },
    async (args) => {
      const params = new URLSearchParams({ state: args.state });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/repeat?${params}`);
      return mutationResult(
        args.response_format,
        { action: 'set_repeat', state: args.state, device_id: args.device_id },
        `Repeat set to ${args.state}.`,
      );
    },
  );

  // get_queue
  server.tool(
    'get_queue',
    'Get the current playback queue',
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

      const pagination = paginationInfo({
        total: upNext.length,
        offset: 0,
        limit: null,
        returned: upNext.length,
      });
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
    'Add a track or episode to the end of the playback queue',
    {
      uri: z.string().describe('Spotify track or episode URI (e.g. spotify:track:...)'),
      device_id: z.string().optional().describe('Target device ID'),
      response_format: ResponseFormat,
      dry_run: DryRun,
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
      return mutationResult(
        args.response_format,
        { action: 'add_to_queue', uri: args.uri, device_id: args.device_id },
        `Added ${args.uri} to queue.`,
      );
    },
  );

  // get_devices
  server.tool(
    'get_devices',
    'List available Spotify Connect devices',
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
            text: 'No devices found. Open Spotify on a device to make it available.',
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

      const lines = shaped.items.map((d) => {
        const active = d.is_active ? ' [ACTIVE]' : '';
        const volume = d.volume_percent !== null ? `, volume: ${d.volume_percent}%` : '';
        return `• ${d.name} (${d.type})${active}${volume} — ID: ${d.id ?? 'n/a'}`;
      });
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
      dry_run: DryRun,
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
      return mutationResult(
        args.response_format,
        { action: 'transfer_playback', device_ids: [args.device_id], play: args.play },
        `Playback transferred to device ${args.device_id}.`,
      );
    },
  );

  // handoff (#112 idea 9): move playback to another device preserving track
  // and position, optionally normalizing volume — raw transfer_playback
  // restarts the track at 0:00 and ignores the new device's volume scale.
  server.tool(
    'handoff',
    'Move playback to another device preserving the current track and play position (and optionally set the target volume) — a lossless "move to the kitchen speaker"',
    {
      device_id: z.string().describe('Target device ID to hand playback off to'),
      volume: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Volume to set on the target device after transfer, 0–100'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const state = await client.get<{
        is_playing?: boolean;
        progress_ms?: number | null;
        item?: { uri?: string } | null;
        context?: { uri?: string | null } | null;
      }>('/me/player');

      const progress = typeof state?.progress_ms === 'number' ? state.progress_ms : null;
      const wasPlaying = state?.is_playing === true;
      const itemUri = state?.item?.uri;
      const contextUri = state?.context?.uri ?? undefined;
      const trackLabel = itemUri ?? 'nothing playing';

      const steps: string[] = [
        `Transfer playback to device ${args.device_id}${wasPlaying ? '' : ' (paused)'}`,
      ];
      if (progress !== null && progress > 0) {
        steps.push(`Resume at ${formatDuration(progress)} into ${trackLabel}`);
      }
      if (args.volume !== undefined) {
        steps.push(`Set target volume to ${args.volume}`);
      }

      if (args.dry_run) {
        return {
          content: [{ type: 'text', text: describeDryRun('handoff', args.device_id, steps) }],
          structuredContent: { ok: true, dry_run: true, steps },
        };
      }

      // 1) Transfer without forcing play (avoids restarting the track).
      await client.put('/me/player', { device_ids: [args.device_id] });
      // 2) Resume at the captured position if something was mid-flight.
      if (itemUri && progress !== null && progress > 0 && wasPlaying) {
        const playBody: Record<string, unknown> = {
          position_ms: progress,
          ...(contextUri ? { context_uri: contextUri, offset: { uri: itemUri } } : { uris: [itemUri] }),
        };
        await client.put(`/me/player/play?device_id=${encodeURIComponent(args.device_id)}`, playBody);
      }
      // 3) Optional volume normalization on the target.
      if (args.volume !== undefined) {
        await client.put(
          `/me/player/volume?${new URLSearchParams({ volume: String(args.volume), device_id: args.device_id })}`,
        );
      }

      return mutationResult(
        args.response_format,
        {
          action: 'handoff',
          device_id: args.device_id,
          resumed_at_ms: progress,
          was_playing: wasPlaying,
          volume: args.volume,
        },
        `Handed off to device ${args.device_id}` +
          (progress !== null && progress > 0 ? ` at ${formatDuration(progress)}` : '') +
          (args.volume !== undefined ? ` (volume ${args.volume})` : '') +
          '.',
      );
    },
  );
}
