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
 *   - `PUT /me/tracks`, `GET /me/library/contains` and `/me/following` pages
 *     take 50.
 *   - `GET /albums?ids=` / `PUT /me/albums` are batched at 20.
 *   - `artists: 50` no longer describes a request Spotify will serve. Spotify's
 *     February 2026 changelog removed the multi-id artist lookup (#1004), so
 *     the key now bounds the `get_several_artists` request size only; the
 *     per-id replacement reads one artist at a time and is faned out by
 *     `ARTIST_FANOUT_WIDTH` in `tools/catalog.ts`, not from here.
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

/**
 * Partial-write state for a multi-chunk playlist write that failed
 * mid-batch (#865). The caller learns:
 *   - `attempted_chunks` — total chunks the call planned to issue
 *   - `failed_chunk_index` — zero-based index of the chunk whose request rejected
 *   - `last_committed_chunk_index` — `-1` if no chunk landed, else the last one that did
 *   - `last_committed_chunk_uris` — `[]` if nothing landed, else the URIs of the last successful chunk
 *   - `committed_uris` — how many URIs landed ACROSS ALL committed chunks
 *   - `error` — the message the throwing request carried (Spotify's `error.message` when present)
 * Combined with the input URI list a retry can skip the already-committed prefix.
 *
 * `committed_uris` is not `last_committed_chunk_uris.length`: that array holds
 * ONE chunk, so the two agree only when exactly one chunk committed (i.e. the
 * second chunk of the write rejected). Reading the total off the last chunk
 * understates a 4-chunk write that died on its fourth chunk as "100 committed"
 * when 300 were, and a retry built on that number re-adds the already-committed
 * prefix (#865 follow-up).
 */
export interface PlaylistPartialWriteFailure {
  ok: false;
  partial_write_failure: true;
  attempted_chunks: number;
  failed_chunk_index: number;
  last_committed_chunk_index: number;
  last_committed_chunk_uris: string[];
  committed_uris: number;
  error: string;
}

export type ChunkedPlaylistWriteResult =
  | { ok: true; chunks: number; snapshot_id: string | undefined }
  | PlaylistPartialWriteFailure;

/**
 * Execute a multi-chunk playlist write and surface what committed when the
 * loop aborts before the last chunk (#865). `performChunk` is called once per
 * chunk and receives the chunk's URI slice plus its zero-based index; it may
 * be a POST, a PUT, or a DELETE — the orchestrator only cares that a thrown
 * error stops the loop and is reported. `chunkSize` is normally
 * {@link capFor}('playlist_writes'), but callers pass the cap they used so the
 * `attempted_chunks` count matches the loop.
 *
 * On success: `{ ok: true, chunks, snapshot_id }`. The `snapshot_id` is the
 * last response that carried one — Spotify only returns it on mutation
 * endpoints, and the most recent is the one that authorises the next write.
 *
 * On failure: a {@link PlaylistPartialWriteFailure} that names the failed
 * chunk and the URIs of the last chunk that DID commit. The caller is then
 * responsible for shaping the tool's prose and structuredContent; the helper
 * never throws on chunk failure.
 */
export async function runChunkedPlaylistWrite(
  uris: string[],
  chunkSize: number,
  performChunk: (chunk: string[], chunkIndex: number) => Promise<{ snapshot_id?: string } | null | undefined>,
): Promise<ChunkedPlaylistWriteResult> {
  // A zero-length write is "all chunks committed, none planned" rather than a
  // partial-failure — callers that compute `attempted_chunks` for prose can
  // divide by zero otherwise.
  if (uris.length === 0) return { ok: true, chunks: 0, snapshot_id: undefined };
  const totalChunks = Math.ceil(uris.length / chunkSize);
  let snapshot_id: string | undefined;
  let lastCommittedChunkIndex = -1;
  let lastCommittedChunkUris: string[] = [];
  // Every committed chunk is a prefix of `uris`, so the committed count is the
  // running total of chunk lengths — not the last chunk's length.
  let committedUris = 0;
  for (let i = 0; i < uris.length; i += chunkSize) {
    const chunk = uris.slice(i, i + chunkSize);
    const chunkIndex = i / chunkSize;
    try {
      const res = await performChunk(chunk, chunkIndex);
      if (res?.snapshot_id) snapshot_id = res.snapshot_id;
      lastCommittedChunkIndex = chunkIndex;
      lastCommittedChunkUris = chunk;
      committedUris += chunk.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        partial_write_failure: true,
        attempted_chunks: totalChunks,
        failed_chunk_index: chunkIndex,
        last_committed_chunk_index: lastCommittedChunkIndex,
        last_committed_chunk_uris: lastCommittedChunkUris,
        committed_uris: committedUris,
        error: message,
      };
    }
  }
  return { ok: true, chunks: totalChunks, snapshot_id };
}
