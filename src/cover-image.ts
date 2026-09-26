/**
 * Shared cover-image helpers for the three playlist cover tools (#880).
 *
 * Background: the three Spotify playlist cover tools each fetched (or accepted)
 * a JPEG with divergent validation:
 *   - upload_playlist_cover checked the `/9j` base64 magic prefix and the
 *     256 KB decoded size cap, but never went to the network.
 *   - clone_playlist_cover used the global `fetch` with no timeout, only
 *     enforced the 256 KB cap, and never checked content-type or magic bytes.
 *   - playlist_cover_from_track used the global `fetch`, enforced the cap and
 *     the content-type, but again no timeout.
 *
 * All three landed on the same 256 KB Spotify-imposed cap and the same intent
 * (PUT /playlists/{id}/images expects a JPEG body), so this module owns the
 * validation in one place. `fetchCoverJpeg` additionally goes through
 * `fetchWithTimeout`, so a stalled CDN host fails fast on timeout instead of
 * hanging the calling process.
 *
 * The helpers operate on `SpotifyImage` from the shared types module so they
 * stay aligned with the rest of the surface (#4 of AGENTS.md).
 */
import { fetchWithTimeout, SpotifyApiError } from './client.js';
import type { SpotifyImage } from './types/spotify.js';

/** Spotify caps PUT /playlists/{id}/images at 256 KB (#880). */
export const COVER_MAX_BYTES = 256 * 1024;

/** JPEG SOI (0xFFD8) — first two bytes every real JPEG starts with. */
const JPEG_MAGIC = [0xff, 0xd8];

function isJpegMagic(buf: Uint8Array): boolean {
  return buf.length >= 2 && buf[0] === JPEG_MAGIC[0] && buf[1] === JPEG_MAGIC[1];
}

/**
 * Validate an already-decoded cover buffer.
 *
 * Used by upload_playlist_cover (which receives base64 directly) and as the
 * tail of `fetchCoverJpeg`. Returns the byte length so the caller can report
 * it; throws an Error whose message names the failure cause.
 */
export function validateCoverJpegBuffer(buf: Uint8Array): { bytes: number } {
  if (buf.length === 0) throw new Error('Cover image is empty');
  if (!isJpegMagic(buf)) {
    throw new Error('Cover image does not look like a JPEG (magic bytes are not FFD8)');
  }
  if (buf.length > COVER_MAX_BYTES) {
    throw new Error(`Cover image exceeds the ${COVER_MAX_BYTES} byte (256 KB) cap (got ${buf.length})`);
  }
  return { bytes: buf.length };
}

/**
 * Fetch a URL as a JPEG buffer within Spotify's 256 KB cover limit.
 *
 * Uses `fetchWithTimeout` so a stalled CDN aborts after `spotifyRequestTimeoutMs`
 * instead of hanging the calling process (#880). The pre-PUT guards — content
 * type, JPEG magic bytes, and the size cap — run in that order so a non-JPEG
 * response is rejected without buffering the body and without burning the
 * spotifyRequestTimeoutMs on a buffer that cannot be uploaded anyway.
 *
 * Throws an Error whose message names the failure cause; upstream SpotifyApiError
 * surfaces unchanged so callers that care about timeouts (HTTP 408) can still
 * distinguish them from validation failures.
 */
export async function fetchCoverJpeg(url: string): Promise<{ buf: Buffer; bytes: number }> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(url, { method: 'GET' });
  } catch (err) {
    // Re-throw SpotifyApiError (timeout) untouched so the existing 408 contract
    // is preserved. Wrap anything else so the caller sees a single shape.
    if (err instanceof SpotifyApiError) throw err;
    throw new Error(`Failed to fetch cover image ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resp.ok) throw new Error(`Failed to fetch cover image ${url}: ${resp.status}`);

  const type = resp.headers.get('content-type') ?? '';
  if (!type.includes('jpeg') && !type.includes('jpg')) {
    throw new Error(`Cover candidate is ${type || 'unknown type'}, not JPEG — Spotify covers require JPEG`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  // content-type is the cheap pre-check; magic bytes are the only proof the
  // payload is actually a JPEG. Both are required.
  validateCoverJpegBuffer(buf);
  return { buf, bytes: buf.length };
}

/** Largest-first cover candidates (by width, unknown-width last, stable). */
export function rankCoverCandidates(images: readonly SpotifyImage[]): SpotifyImage[] {
  return [...images]
    .map((img, i) => ({ img, i }))
    .sort((a, b) => (b.img.width ?? -1) - (a.img.width ?? -1) || a.i - b.i)
    .map(({ img }) => img);
}
