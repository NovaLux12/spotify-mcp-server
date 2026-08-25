// Token storage schema
export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Date.now() + expires_in * 1000
}

// Spotify API error body
export interface SpotifyErrorBody {
  error: {
    status: number;
    message: string;
  };
}

// Devices
export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume: boolean;
}

export interface GetDevicesResponse {
  devices: SpotifyDevice[];
}

// Artists
export interface SpotifyArtistSimple {
  id: string;
  name: string;
  uri: string;
}

// Album image
export interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

// Album (simplified for playback)
export interface SpotifyAlbumSimple {
  id: string;
  name: string;
  uri: string;
  images: SpotifyImage[];
}

// Track (as returned in playback state)
export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  type: 'track';
  duration_ms: number;
  explicit: boolean;
  artists: SpotifyArtistSimple[];
  album: SpotifyAlbumSimple;
}

// Episode (podcast, as returned in playback state)
export interface SpotifyEpisode {
  id: string;
  name: string;
  uri: string;
  type: 'episode';
  duration_ms: number;
  explicit: boolean;
  description: string;
  release_date: string;
  resume_point?: {
    fully_played: boolean;
    resume_position_ms: number;
  };
  show: {
    id: string;
    name: string;
    uri: string;
  };
}

// Playback state (GET /me/player)
export interface PlaybackState {
  is_playing: boolean;
  progress_ms: number | null;
  shuffle_state: boolean;
  repeat_state: 'off' | 'context' | 'track';
  timestamp: number;
  device?: SpotifyDevice;
  item: SpotifyTrack | SpotifyEpisode | null;
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown';
  context: {
    type: string;
    uri: string;
  } | null;
}

// Queue (GET /me/player/queue)
export interface SpotifyQueue {
  currently_playing: SpotifyTrack | SpotifyEpisode | null;
  queue: (SpotifyTrack | SpotifyEpisode)[];
}

// Artist (full, from GET /artists/{id})
export interface SpotifyArtistFull {
  id: string;
  name: string;
  uri: string;
  genres: string[];
}

// Album item (used in artist albums listing and search results)
export interface SpotifyAlbumItem {
  id: string;
  name: string;
  uri: string;
  album_type: string;
  release_date: string;
  total_tracks: number;
  artists: SpotifyArtistSimple[];
  images: SpotifyImage[];
}

// Paginated artist albums response
export interface SpotifyArtistAlbumsResponse {
  items: SpotifyAlbumItem[];
  total: number;
  limit: number;
  offset: number;
}

// Simplified track in album tracks listing
export interface SpotifyTrackSimple {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  explicit: boolean;
  track_number: number;
  artists: SpotifyArtistSimple[];
}

// Full album (GET /albums/{id})
export interface SpotifyAlbumFull {
  id: string;
  name: string;
  uri: string;
  album_type: string;
  release_date: string;
  total_tracks: number;
  artists: SpotifyArtistSimple[];
  images: SpotifyImage[];
  tracks: {
    items: SpotifyTrackSimple[];
    total: number;
  };
}

// Simplified show for search results
export interface SpotifyShowSimple {
  id: string;
  name: string;
  uri: string;
  description: string;
  publisher: string;
  total_episodes: number;
}

// Simplified episode for show's episode list and search
export interface SpotifyEpisodeSimple {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  release_date: string;
  explicit: boolean;
  description: string;
  show: SpotifyShowSimple;
  resume_point?: {
    fully_played: boolean;
    resume_position_ms: number;
  };
}

// Full show (GET /shows/{id})
export interface SpotifyShowFull {
  id: string;
  name: string;
  uri: string;
  description: string;
  publisher: string;
  explicit: boolean;
  total_episodes: number;
  languages: string[];
  media_type: string;
  episodes?: {
    items: SpotifyEpisodeSimple[];
    total: number;
  };
}

// Full episode (GET /episodes/{id})
export interface SpotifyEpisodeFull {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  release_date: string;
  explicit: boolean;
  description: string;
  languages: string[];
  audio_preview_url: string | null;
  resume_point?: {
    fully_played: boolean;
    resume_position_ms: number;
  };
  show: {
    id: string;
    name: string;
    uri: string;
  };
}

// Simplified chapter in an audiobook's chapter listing
export interface SpotifyChapterSimple {
  id: string;
  name: string;
  uri: string;
  chapter_number: number;
  duration_ms: number;
  release_date: string;
  explicit: boolean;
  description: string;
  is_playable: boolean;
}

// Full chapter (GET /chapters/{id})
export interface SpotifyChapterFull extends SpotifyChapterSimple {
  html_description: string;
  languages: string[];
  images: SpotifyImage[];
  audio_preview_url: string | null;
  resume_point?: {
    fully_played: boolean;
    resume_position_ms: number;
  };
}

// Simplified audiobook (saved library listing; GET /audiobooks/{id} base object)
export interface SpotifyAudiobookSimple {
  id: string;
  name: string;
  uri: string;
  authors: { name: string }[];
  narrators: { name: string }[];
  publisher?: string;
  edition?: string;
  total_chapters: number;
  description: string;
  explicit: boolean;
  media_type: string;
  languages: string[];
}

// Full audiobook (GET /audiobooks/{id})
export interface SpotifyAudiobookFull extends SpotifyAudiobookSimple {
  images: SpotifyImage[];
  copyrights: { text: string; type: string }[];
  chapters?: {
    items: SpotifyChapterSimple[];
    total: number;
  };
}

// Saved audiobook item (from GET /me/audiobooks)
export interface SavedAudiobookItem {
  added_at: string;
  audiobook: SpotifyAudiobookSimple;
}

// Paged response wrapper
export interface SpotifyPaged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
}

// Recently played item
export interface RecentlyPlayedItem {
  track: SpotifyTrack;
  played_at: string; // ISO 8601
  context: { type: string; uri: string } | null;
}

export interface RecentlyPlayedResponse {
  items: RecentlyPlayedItem[];
  cursors: { before: string; after: string } | null;
  next: string | null;
}

// Simplified playlist for search results
export interface SpotifyPlaylistSimple {
  id: string;
  name: string;
  uri: string;
  description: string | null;
  owner: { display_name: string | null; id: string };
  tracks: { total: number };
}

// Search response (GET /search)
export interface SearchResponse {
  tracks?: { items: SpotifyTrack[]; total: number };
  artists?: { items: SpotifyArtistFull[]; total: number };
  albums?: { items: SpotifyAlbumItem[]; total: number };
  playlists?: { items: SpotifyPlaylistSimple[]; total: number };
  shows?: { items: SpotifyShowSimple[]; total: number };
  episodes?: { items: SpotifyEpisodeSimple[]; total: number };
}

// Saved library items
export interface SavedTrackItem {
  added_at: string;
  track: SpotifyTrack;
}

export interface SavedAlbumItem {
  added_at: string;
  album: SpotifyAlbumFull;
}

export interface SavedShowItem {
  added_at: string;
  show: SpotifyShowSimple;
}

export interface SavedEpisodeItem {
  added_at: string;
  episode: SpotifyEpisodeFull;
}

// User profile (GET /me)
export interface UserProfile {
  id: string;
  display_name: string | null;
  uri: string;
  external_urls: { spotify: string };
  email?: string | null;
  country?: string;
  product?: string;
}

// Playlist item (from GET /playlists/{id}/items)
export interface PlaylistItemObject {
  added_at: string;
  track: SpotifyTrack | SpotifyEpisode | null;
}

export interface PlaylistItemsResponse {
  items: PlaylistItemObject[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
}

// Followed artists (cursor-based pagination, GET /me/following?type=artist)
export interface FollowedArtistsResponse {
  artists: {
    items: SpotifyArtistFull[];
    cursors: { after: string } | null;
    next: string | null;
    total: number;
  };
}
