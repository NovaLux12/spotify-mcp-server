/**
 * The batch-size policy for the whole server, in one place (#512, #583).
 *
 * Every loop that splits a write or a bulk read into per-request batches must
 * take its bound from {@link CHUNK_CAPS} via {@link capFor}, not from a
 * literal. A literal here and there is how two call sites for the same
 * endpoint drifted apart (#624) and how a wrong number turns into a silent
 * partial batch or a 400 from Spotify.
 *
 * The values are the documented Spotify per-request limits:
 *   - `GET/POST/DELETE /playlists/{id}/items` takes 100 uris or positions.
 *   - `PUT|DELETE /me/library` takes 40 uris; the read
 *     `GET /me/library/contains` takes 50, so the two are separate keys.
 *   - `PUT /me/tracks`, `GET /me/library/contains`, `GET /artists?ids=` and
 *     `/me/following` pages take 50.
 *   - `GET /albums?ids=` / `PUT /me/albums` are batched at 20.
 *
 * Pure module: no imports.
 */

/**
 * Per-request batch caps, keyed by the thing being sent. Changing a value
 * here changes the number of requests every batched tool issues, so it is a
 * reviewed, single-place policy change rather than a per-call-site edit.
 */
export const CHUNK_CAPS = {
  tracks: 50, albums: 20, artists: 50, episodes: 50, shows: 50, audiobooks: 50, chapters: 50,
  playlist_writes: 100, library_writes: 40, library_reads: 50, followed: 50,
} as const;

/** One key of {@link CHUNK_CAPS}. */
export type ChunkCapKind = keyof typeof CHUNK_CAPS;

/** The batch cap for `kind`, as a number a loop can step by. */
export function capFor(kind: ChunkCapKind): number {
  return CHUNK_CAPS[kind];
}

/** Split `items` into per-request batches of at most `kind`'s cap. */
export function chunk<T>(items: readonly T[], kind: ChunkCapKind): T[][] {
  const size = capFor(kind);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
