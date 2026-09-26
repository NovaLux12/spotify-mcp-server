// Token storage schema
export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Date.now() + expires_in * 1000
  scope?: string; // space-separated granted scopes persisted at auth time (#111 item 6); absent in older token files
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

// Paginated artist albums response. Feb 2026: /artists/{id}/albums returns the
// same paged object as every other offset/limit listing, so this is an alias of
// the one canonical paged wrapper rather than a second copy of its five fields.
// A second copy is how the `next` field went missing from this one.
export type SpotifyArtistAlbumsResponse = SpotifyPaged<SpotifyAlbumItem>;

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
  // Feb 2026: publisher removed from Show payloads for new app registrations.
  publisher?: string;
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
  // Feb 2026: publisher removed from Show payloads for new app registrations.
  publisher?: string;
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

/**
 * The count-only page Spotify uses where there is no offset paging to describe:
 * every `/search` section, and the show/album episode listings. It is a strict
 * subset of `SpotifyPaged<T>`, so a payload that does carry `limit`/`offset`/
 * `next` is still readable through the wider wrapper.
 */
export interface SpotifyItemsPage<T> {
  items: T[];
  total: number;
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

// Simplified playlist (search rows and /me/playlists listings).
// Feb 2026: `tracks` renamed to paged `items`; search rows may also be null
// (curated playlists filtered per-slot).
export interface SpotifyPlaylistSimple {
  id: string;
  name: string;
  uri: string;
  description: string | null;
  owner: { display_name: string | null; id: string };
  items?: { total: number } | null;
}

// Search response (GET /search)
export interface SearchResponse {
  tracks?: SpotifyItemsPage<SpotifyTrack>;
  artists?: SpotifyItemsPage<SpotifyArtistFull>;
  albums?: SpotifyItemsPage<SpotifyAlbumItem>;
  playlists?: SpotifyItemsPage<SpotifyPlaylistSimple | null>;
  shows?: SpotifyItemsPage<SpotifyShowSimple>;
  episodes?: SpotifyItemsPage<SpotifyEpisodeSimple>;
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

// `/me/albums` and `/me/tracks` return the library listing rows, not the full
// album/track objects: the album is the listing row (label, no embedded track
// page) and the track carries its album's release metadata.

/** `/me/albums` row. */
export interface SavedAlbumRow {
  added_at: string;
  album: SpotifyAlbumRow;
}

/** `/me/tracks` row. */
export interface SavedTrackRow {
  added_at: string;
  track: SpotifyTrackRow;
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
// One row of GET /playlists/{id}/items. Feb 2026 renamed the nested playable
// from `track` to `item` (rows for episodes use episode objects here too).
export interface PlaylistItemObject {
  added_at: string;
  item?: SpotifyTrack | SpotifyEpisode | null;
}

// Playlist items page (GET /playlists/{id}/items) — structurally identical to
// SpotifyPaged<PlaylistItemObject>, so it is an alias and not a third copy of
// the paged wrapper's five fields.
export type PlaylistItemsResponse = SpotifyPaged<PlaylistItemObject>;

// Followed artists (cursor-based pagination, GET /me/following?type=artist)
export interface FollowedArtistsResponse {
  artists: {
    items: SpotifyArtistFull[];
    cursors: { after: string } | null;
    next: string | null;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Response widenings (#589)
//
// Each shape below is a row or envelope the Web API really returns but that the
// simplified types above cannot express. They are declared HERE, once, so that a
// payload change is a one-file edit plus its consumers: a module that needs a
// widened row imports the name instead of re-deriving the widening locally.
// `tests/types.ownership.test.ts` fails the build if one is redeclared.
// ---------------------------------------------------------------------------

/**
 * Album row as listings and `/albums/{id}` return it: the simplified item
 * widened with label, copyrights, genres and the embedded track page. All four
 * are optional because the same row shape covers `/albums?ids=` (a requested
 * subset of fields) and the full album object.
 */
export interface SpotifyAlbumRow extends SpotifyAlbumItem {
  label?: string;
  copyrights?: Array<{ text?: string; type?: string }>;
  genres?: string[];
  tracks?: { items: SpotifyTrackSimple[]; total: number };
}

/** `/artists/{id}/albums` row: the album row plus the release-group discriminator. */
export interface SpotifyArtistAlbumRow extends SpotifyAlbumRow {
  album_group?: string;
}

/**
 * Track row from `/tracks?ids=`, `/search` and album track listings: the
 * playback-shaped track with the album widened to its release metadata and the
 * external-id/playability fields a full track object carries.
 */
export interface SpotifyTrackRow extends Omit<SpotifyTrack, 'album'> {
  album: SpotifyAlbumSimple & {
    release_date?: string;
    release_date_precision?: string;
    album_type?: string;
    total_tracks?: number;
  };
  external_ids?: { isrc?: string; upc?: string };
  is_playable?: boolean;
  album_type?: string;
}

/**
 * Track whose album carries a release date — the shape `/me/top/tracks` and
 * `/me/player/recently-played` rows really have, where the album is wider than
 * `SpotifyAlbumSimple` claims. `Record<string, unknown>` keeps the unmodelled
 * album fields readable instead of forcing a cast at every call site.
 */
export type SpotifyTrackWithReleaseDate = SpotifyTrack & {
  album: { release_date?: string; name?: string } & Record<string, unknown>;
};

/** Audiobook row from `/search` and `/audiobooks?ids=`: narrators may be absent. */
export interface SpotifyAudiobookRow extends Omit<SpotifyAudiobookSimple, 'narrators'> {
  release_date?: string;
  narrators?: Array<{ name: string }>;
}

/** Chapter row from `/audiobooks/{id}/chapters`, which carries the resume point. */
export type SpotifyChapterRow = SpotifyChapterSimple & Pick<SpotifyChapterFull, 'resume_point'>;

/**
 * Episode row from `/episodes/{id}`, defensive about the two fields a payload
 * can leave out: `release_date` is null for an unscheduled episode and `show`
 * is null for a deleted one. `SpotifyEpisodeFull` declares neither as nullable,
 * so a reader that must survive both needs this row rather than a private copy
 * of the episode object under a different name.
 */
export interface SpotifyEpisodeRow {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  release_date: string | null;
  description: string;
  show: { id: string; name: string; uri?: string } | null;
}

/**
 * `GET /playlists/{id}` row, which exposes the public/collaborative flags a
 * listing row does not — the pair a toward-visible change is detected from
 * before an `update_playlist` PUT (#157).
 */
export interface SpotifyPlaylistVisibilityRow extends SpotifyPlaylistWithImages {
  public?: boolean | null;
  collaborative?: boolean;
}

/** `/me/top/artists` row: the full artist plus the follower and popularity counts. */
export interface SpotifyArtistRow extends SpotifyArtistFull {
  followers?: { total: number };
  popularity?: number;
}

/**
 * `/me/playlists` listing row (#762). Spotify documents `owner` on a playlist
 * object, but a deleted user or a private wrapper playlist returns
 * `owner: null`, which the simplified type does not admit — so the listing row
 * is its own shared shape rather than a local widening.
 */
export interface SpotifyPlaylistRow extends Omit<SpotifyPlaylistSimple, 'owner'> {
  owner: SpotifyPlaylistSimple['owner'] | null;
}

/** Playlist row that also carries images (listing endpoints do; search rows may not). */
export interface SpotifyPlaylistWithImages extends SpotifyPlaylistSimple {
  images?: SpotifyImage[] | null;
}

/** `/search` envelope including the audiobook section, which `SearchResponse` omits. */
export interface SpotifySearchResults extends SearchResponse {
  audiobooks?: { items: SpotifyAudiobookSimple[]; total: number };
}

/** Device eligible for a volume write: `id` is narrowed from nullable to present. */
export interface SpotifyVolumeTarget extends SpotifyDevice {
  id: string;
}

/**
 * The count-bearing page of a playlist object, in both spellings. Spotify
 * deprecated `PlaylistObject.tracks` in Feb 2026 in favour of `items` (which is
 * a PagingPlaylistTrackObject, and PagingObject requires `total`), so a
 * grandfathered payload can still carry only the upstream-deprecated page.
 */
export interface SpotifyPlaylistPage {
  items?: { total?: number } | null;
  /** Upstream-deprecated since Feb 2026; read only as a fallback. */
  tracks?: { total?: number } | null;
}

/**
 * How many rows a playlist object reports, preferring the canonical `items` page
 * and falling back to the legacy `tracks` page. Returns `undefined` when the
 * payload carries neither — a length Spotify did not state is not zero, and
 * callers must say "unknown" rather than print a number they did not read.
 */
export function playlistItemTotal(
  playlist: SpotifyPlaylistPage | null | undefined,
): number | undefined {
  const canonical = playlist?.items?.total;
  if (typeof canonical === 'number') return canonical;
  const legacy = playlist?.tracks?.total;
  return typeof legacy === 'number' ? legacy : undefined;
}
