import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type {
  PlaybackState,
  SpotifyQueue,
  SpotifyPlaylistSimple,
  SpotifyTrack,
  SpotifyEpisode,
  RecentlyPlayedResponse,
  UserProfile,
  SpotifyArtistFull,
} from '../types/spotify.js';

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatItem(item: SpotifyTrack | SpotifyEpisode): string {
  if (item.type === 'track') {
    const artists = item.artists.map((a) => a.name).join(', ');
    return `"${item.name}" by ${artists} (${formatDuration(item.duration_ms)}) | URI: ${item.uri}`;
  }
  if (item.type === 'episode') {
    return `"${item.name}" — ${item.show.name} (${formatDuration(item.duration_ms)}) | URI: ${item.uri}`;
  }
  return `"${(item as { type?: string }).type ?? 'unknown'}" (unsupported item)`;
}

export function registerResources(server: McpServer, client: SpotifyClient): void {
  // spotify://me — current user profile
  server.resource(
    'me',
    'spotify://me',
    { description: 'Current user profile' },
    async () => {
      const profile = await client.get<UserProfile>('/me');
      if (!profile) throw new Error('Could not retrieve user profile');
      return {
        contents: [{
          uri: 'spotify://me',
          text: `User: ${profile.display_name ?? profile.id}\nID: ${profile.id}\nURI: ${profile.uri}`,
          mimeType: 'text/plain',
        }],
      };
    },
  );

  // spotify://player/state — current playback state
  server.resource(
    'player-state',
    'spotify://player/state',
    { description: 'Current Spotify playback state' },
    async () => {
      const state = await client.get<PlaybackState>('/me/player');
      if (!state || !state.item) {
        return {
          contents: [{ uri: 'spotify://player/state', text: 'Nothing is currently playing.', mimeType: 'text/plain' }],
        };
      }
      const { item, is_playing, progress_ms, shuffle_state, repeat_state, device } = state;
      const lines: string[] = [];
      if (item.type === 'track') {
        const artists = item.artists.map((a) => a.name).join(', ');
        lines.push(`${is_playing ? 'Playing' : 'Paused'}: "${item.name}" by ${artists}`);
        lines.push(`Album: ${item.album.name}`);
      } else if (item.type === 'episode') {
        lines.push(`${is_playing ? 'Playing' : 'Paused'}: "${item.name}" (${item.show.name})`);
      } else {
        lines.push(`${is_playing ? 'Playing' : 'Paused'}: "${(item as { type?: string }).type ?? 'unknown'}" (unsupported item)`);
      }
      if (device) {
        lines.push(`Device: ${device.name} (${device.type})`);
      } else {
        lines.push('Device: none active');
      }
      lines.push(`Shuffle: ${shuffle_state ? 'on' : 'off'} | Repeat: ${repeat_state}`);
      lines.push(`URI: ${item.uri}`);
      return {
        contents: [{ uri: 'spotify://player/state', text: lines.join('\n'), mimeType: 'text/plain' }],
      };
    },
  );

  // spotify://player/queue — current queue
  server.resource(
    'player-queue',
    'spotify://player/queue',
    { description: 'Current playback queue' },
    async () => {
      const queue = await client.get<SpotifyQueue>('/me/player/queue');
      if (!queue) {
        return {
          contents: [{ uri: 'spotify://player/queue', text: 'No active playback session.', mimeType: 'text/plain' }],
        };
      }
      const lines: string[] = [];
      if (queue.currently_playing) {
        lines.push(`Currently playing: ${formatItem(queue.currently_playing)}`);
      }
      if (queue.queue.length === 0) {
        lines.push('Queue is empty.');
      } else {
        lines.push('Up next:');
        queue.queue.slice(0, 20).forEach((item, i) => {
          lines.push(`  ${i + 1}. ${formatItem(item)}`);
        });
        if (queue.queue.length > 20) lines.push(`  ... and ${queue.queue.length - 20} more`);
      }
      return {
        contents: [{ uri: 'spotify://player/queue', text: lines.join('\n'), mimeType: 'text/plain' }],
      };
    },
  );

  // spotify://me/top/tracks — top tracks (medium term)
  server.resource(
    'top-tracks',
    'spotify://me/top/tracks',
    { description: "User's top tracks (medium term)" },
    async () => {
      const result = await client.get<{ items: SpotifyTrack[] }>('/me/top/tracks', {
        time_range: 'medium_term',
        limit: '20',
      });
      if (!result) throw new Error('Could not retrieve top tracks');
      const lines = result.items.map((track, i) => {
        const artists = track.artists.map((a) => a.name).join(', ');
        return `  ${i + 1}. "${track.name}" by ${artists} | URI: ${track.uri}`;
      });
      return {
        contents: [{
          uri: 'spotify://me/top/tracks',
          text: `Top tracks (medium term):\n${lines.join('\n')}`,
          mimeType: 'text/plain',
        }],
      };
    },
  );

  // spotify://me/top/artists — top artists (medium term)
  server.resource(
    'top-artists',
    'spotify://me/top/artists',
    { description: "User's top artists (medium term)" },
    async () => {
      const result = await client.get<{ items: SpotifyArtistFull[] }>('/me/top/artists', {
        time_range: 'medium_term',
        limit: '20',
      });
      if (!result) throw new Error('Could not retrieve top artists');
      const lines = result.items.map((artist, i) => {
        const genres = Array.isArray(artist.genres) && artist.genres.length > 0 ? artist.genres.join(', ') : 'no genres';
        return `  ${i + 1}. ${artist.name} — ${genres} | URI: ${artist.uri}`;
      });
      return {
        contents: [{
          uri: 'spotify://me/top/artists',
          text: `Top artists (medium term):\n${lines.join('\n')}`,
          mimeType: 'text/plain',
        }],
      };
    },
  );

  // spotify://me/recently-played — last 20 played tracks
  server.resource(
    'recently-played',
    'spotify://me/recently-played',
    { description: 'Last 20 recently played tracks' },
    async () => {
      const result = await client.get<RecentlyPlayedResponse>('/me/player/recently-played', {
        limit: '20',
      });
      if (!result) throw new Error('Could not retrieve recently played');
      const lines = result.items.map((item) => {
        const artists = item.track.artists.map((a) => a.name).join(', ');
        const playedAt = new Date(item.played_at).toLocaleString();
        return `  • "${item.track.name}" by ${artists} — ${playedAt} | URI: ${item.track.uri}`;
      });
      return {
        contents: [{
          uri: 'spotify://me/recently-played',
          text: `Recently played:\n${lines.join('\n')}`,
          mimeType: 'text/plain',
        }],
      };
    },
  );

  // spotify://me/playlists — all user playlists
  server.resource(
    'playlists',
    'spotify://me/playlists',
    { description: 'All user playlists (names and IDs)' },
    async () => {
      const playlists = await client.getAllPages<SpotifyPlaylistSimple>('/me/playlists', {
        limit: '50',
      });
      if (playlists.length === 0) {
        return {
          contents: [{ uri: 'spotify://me/playlists', text: 'No playlists found.', mimeType: 'text/plain' }],
        };
      }
      const lines = playlists.map((pl) => {
        const trackCount = pl.tracks?.total ?? 0;
        return `  • "${pl.name}" (${trackCount} tracks) | ID: ${pl.id} | URI: ${pl.uri}`;
      });
      return {
        contents: [{
          uri: 'spotify://me/playlists',
          text: `Playlists (${playlists.length} total):\n${lines.join('\n')}`,
          mimeType: 'text/plain',
        }],
      };
    },
  );

}
