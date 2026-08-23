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

export function registerPlaybackTools(server: McpServer, client: SpotifyClient): void {
  // get_now_playing
  server.tool(
    'get_now_playing',
    'Get the currently playing track or episode and full playback state',
    {},
    async () => {
      const state = await client.get<PlaybackState>('/me/player');

      if (!state || !state.item) {
        return { content: [{ type: 'text', text: 'Nothing is currently playing.' }] };
      }

      const { item, is_playing, progress_ms, shuffle_state, repeat_state, device } = state;

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
      lines.push(`Device: ${device.name} (${device.type})`);
      if (device.volume_percent !== null) {
        lines.push(`Volume: ${device.volume_percent}%`);
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
    {},
    async () => {
      const cp = await client.get<CurrentlyPlayingResponse>('/me/player/currently-playing');

      if (!cp || !cp.item) {
        return { content: [{ type: 'text', text: 'Nothing is currently playing.' }] };
      }

      const lines = [
        `${cp.is_playing ? 'Playing' : 'Paused'}: ${formatItem(cp.item)}`,
        `Progress: ${formatDuration(cp.progress_ms ?? 0)} / ${formatDuration(cp.item.duration_ms)}`,
        `URI: ${cp.item.uri}`,
      ];

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
    },
    async (args) => {
      const results = await client.get<SearchResponse>('/search', {
        q: args.query,
        type: args.search_type,
        limit: '5',
      });

      let match: SpotifyTrack | SpotifyEpisodeSimple | undefined;
      if (args.search_type === 'track') {
        match = results?.tracks?.items[0];
      } else {
        match = results?.episodes?.items[0];
      }

      if (!match) {
        return { content: [{ type: 'text', text: `No results found for ${args.query}` }] };
      }

      const path = args.device_id
        ? `/me/player/play?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/play';
      await client.put(path, { uris: [match.uri] });

      const detail =
        'artists' in match
          ? formatItem(match) + ` from the album "${match.album.name}"`
          : formatItem(match);
      return { content: [{ type: 'text', text: `Now playing: ${detail}` }] };
    },
  );

  // play
  server.tool(
    'play',
    'Start or resume playback. Optionally target specific content.',
    {
      context_uri: z.string().optional().describe('Spotify URI for an album, artist, or playlist'),
      uris: z.array(z.string()).optional().describe('Up to 100 track/episode URIs to play as an ad-hoc queue'),
      offset: z.number().int().min(0).optional().describe('Index within context to start from'),
      position_ms: z.number().int().min(0).optional().describe('Seek position to start at (ms)'),
      device_id: z.string().optional().describe('Target device ID; uses active device if omitted'),
    },
    async (args) => {
      const path = args.device_id
        ? `/me/player/play?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/play';

      const body: Record<string, unknown> = {};
      if (args.context_uri) body.context_uri = args.context_uri;
      if (args.uris) body.uris = args.uris;
      if (args.offset !== undefined) body.offset = { position: args.offset };
      if (args.position_ms !== undefined) body.position_ms = args.position_ms;

      await client.put(path, Object.keys(body).length > 0 ? body : undefined);
      return { content: [{ type: 'text', text: 'Playback started.' }] };
    },
  );

  // pause
  server.tool(
    'pause',
    'Pause playback on the active device',
    {
      device_id: z.string().optional().describe('Target device ID'),
    },
    async (args) => {
      const path = args.device_id
        ? `/me/player/pause?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/pause';
      await client.put(path);
      return { content: [{ type: 'text', text: 'Playback paused.' }] };
    },
  );

  // skip_next
  server.tool(
    'skip_next',
    'Skip to the next track in the queue or context',
    {
      device_id: z.string().optional().describe('Target device ID'),
    },
    async (args) => {
      const path = args.device_id
        ? `/me/player/next?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/next';
      await client.post(path);
      return { content: [{ type: 'text', text: 'Skipped to next track.' }] };
    },
  );

  // skip_previous
  server.tool(
    'skip_previous',
    'Skip to the previous track. If more than 3 seconds in, restarts the current track first.',
    {
      device_id: z.string().optional().describe('Target device ID'),
    },
    async (args) => {
      const path = args.device_id
        ? `/me/player/previous?device_id=${encodeURIComponent(args.device_id)}`
        : '/me/player/previous';
      await client.post(path);
      return { content: [{ type: 'text', text: 'Skipped to previous track.' }] };
    },
  );

  // seek
  server.tool(
    'seek',
    'Seek to a position in the current track',
    {
      position_ms: z.number().int().min(0).describe('Position in milliseconds'),
      device_id: z.string().optional().describe('Target device ID'),
    },
    async (args) => {
      const params = new URLSearchParams({ position_ms: String(args.position_ms) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/seek?${params}`);
      return { content: [{ type: 'text', text: `Seeked to ${formatDuration(args.position_ms)}.` }] };
    },
  );

  // set_volume
  server.tool(
    'set_volume',
    'Set playback volume (0–100)',
    {
      volume_percent: z.number().int().min(0).max(100).describe('Volume level 0–100'),
      device_id: z.string().optional().describe('Target device ID'),
    },
    async (args) => {
      const params = new URLSearchParams({ volume_percent: String(args.volume_percent) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/volume?${params}`);
      return { content: [{ type: 'text', text: `Volume set to ${args.volume_percent}%.` }] };
    },
  );

  // set_shuffle
  server.tool(
    'set_shuffle',
    'Enable or disable shuffle mode',
    {
      state: z.boolean().describe('true = shuffle on, false = shuffle off'),
      device_id: z.string().optional().describe('Target device ID'),
    },
    async (args) => {
      const params = new URLSearchParams({ state: String(args.state) });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/shuffle?${params}`);
      return { content: [{ type: 'text', text: `Shuffle ${args.state ? 'on' : 'off'}.` }] };
    },
  );

  // set_repeat
  server.tool(
    'set_repeat',
    'Set repeat mode: off, context (repeat playlist/album), or track (repeat single track)',
    {
      state: z.enum(['off', 'context', 'track']).describe('Repeat mode'),
      device_id: z.string().optional().describe('Target device ID'),
    },
    async (args) => {
      const params = new URLSearchParams({ state: args.state });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.put(`/me/player/repeat?${params}`);
      return { content: [{ type: 'text', text: `Repeat set to ${args.state}.` }] };
    },
  );

  // get_queue
  server.tool(
    'get_queue',
    'Get the current playback queue',
    {},
    async () => {
      const queue = await client.get<SpotifyQueue>('/me/player/queue');

      if (!queue) {
        return { content: [{ type: 'text', text: 'No active playback session.' }] };
      }

      const lines: string[] = [];

      if (queue.currently_playing) {
        lines.push(`Currently playing: ${formatItem(queue.currently_playing)}`);
      } else {
        lines.push('Currently playing: nothing');
      }

      if (queue.queue.length === 0) {
        lines.push('\nQueue is empty.');
      } else {
        lines.push('\nUp next:');
        const shown = queue.queue.slice(0, 20);
        shown.forEach((item, i) => {
          lines.push(`  ${i + 1}. ${formatItem(item)}`);
        });
        if (queue.queue.length > 20) {
          lines.push(`  ... and ${queue.queue.length - 20} more`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // add_to_queue
  server.tool(
    'add_to_queue',
    'Add a track or episode to the end of the playback queue',
    {
      uri: z.string().describe('Spotify track or episode URI (e.g. spotify:track:...)'),
      device_id: z.string().optional().describe('Target device ID'),
    },
    async (args) => {
      const params = new URLSearchParams({ uri: args.uri });
      if (args.device_id) params.set('device_id', args.device_id);
      await client.post(`/me/player/queue?${params}`);
      return { content: [{ type: 'text', text: `Added ${args.uri} to queue.` }] };
    },
  );

  // get_devices
  server.tool(
    'get_devices',
    'List available Spotify Connect devices',
    {},
    async () => {
      const result = await client.get<GetDevicesResponse>('/me/player/devices');

      if (!result || result.devices.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No devices found. Open Spotify on a device to make it available.',
          }],
        };
      }

      const lines = result.devices.map((d) => {
        const active = d.is_active ? ' [ACTIVE]' : '';
        const volume = d.volume_percent !== null ? `, volume: ${d.volume_percent}%` : '';
        return `• ${d.name} (${d.type})${active}${volume} — ID: ${d.id ?? 'n/a'}`;
      });

      return { content: [{ type: 'text', text: `Devices:\n${lines.join('\n')}` }] };
    },
  );

  // transfer_playback
  server.tool(
    'transfer_playback',
    'Move playback to a different Spotify Connect device',
    {
      device_id: z.string().describe('Target device ID to transfer playback to'),
      play: z.boolean().optional().describe('Force play immediately (default: maintain current state)'),
    },
    async (args) => {
      const body: Record<string, unknown> = { device_ids: [args.device_id] };
      if (args.play !== undefined) body.play = args.play;
      await client.put('/me/player', body);
      return { content: [{ type: 'text', text: `Playback transferred to device ${args.device_id}.` }] };
    },
  );
}
