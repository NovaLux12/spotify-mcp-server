/**
 * Unit tests for src/cover-image.ts (#880).
 *
 * The three Spotify playlist cover tools (`upload_playlist_cover`,
 * `clone_playlist_cover`, `playlist_cover_from_track`) used to each fetch or
 * accept a JPEG with divergent validation. They now share
 * `validateCoverJpegBuffer` and `fetchCoverJpeg` from src/cover-image.ts, so
 * the helpers are tested directly here rather than only through the tool
 * handlers.
 *
 * Three invariants must hold:
 *   - a non-JPEG response is rejected before the body is buffered or PUT,
 *   - the 256 KB cap and JPEG magic-bytes check are enforced together, and
 *   - a stalled CDN aborts after `spotifyRequestTimeoutMs`, not after a
 *     process-level hang.
 *
 * The timeout test overrides the request timeout via `initConfig` (the same
 * pattern other tests in the repo use for SPOTIFY_* env hooks); the global
 * fetch is stubbed to return a never-resolving promise, so the only way the
 * helper can complete is by going through `AbortSignal.timeout`.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  COVER_MAX_BYTES,
  fetchCoverJpeg,
  validateCoverJpegBuffer,
} from '../src/cover-image.js';
import { initConfig } from '../src/config.js';

// JPEG SOI + first APP0 marker segment — the smallest plausible JPEG body.
const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x46, 0x46]);

describe('validateCoverJpegBuffer (#880)', () => {
  it('rejects empty buffers', () => {
    assert.throws(() => validateCoverJpegBuffer(Buffer.alloc(0)), /empty/);
  });

  it('rejects payloads without JPEG magic bytes', () => {
    // PNG signature starts with 0x89, not the JPEG SOI (0xFF 0xD8).
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.throws(() => validateCoverJpegBuffer(png), /magic bytes/i);
  });

  it('rejects payloads over the 256 KB cap', () => {
    const oversized = Buffer.alloc(COVER_MAX_BYTES + 1);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    assert.throws(() => validateCoverJpegBuffer(oversized), /256 KB/);
  });

  it('accepts a valid JPEG under the cap', () => {
    const { bytes } = validateCoverJpegBuffer(VALID_JPEG);
    assert.equal(bytes, VALID_JPEG.length);
  });
});

describe('fetchCoverJpeg (#880)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects a non-JPEG content-type before buffering the body', async () => {
    // The real guard runs on content-type before the body is read; a leaked
    // read would let a 200 PNG slip past, so the test asserts on the message
    // only — there is no portable way to confirm "not read" without mocking
    // internals the helper does not expose.
    globalThis.fetch = (async () => new Response('not a jpeg', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    } as ResponseInit)) as typeof fetch;
    await assert.rejects(
      () => fetchCoverJpeg('https://img/cover.png'),
      /not JPEG/,
    );
  });

  it('rejects a JPEG content-type whose body is not actually a JPEG', async () => {
    // content-type lies; only the magic-bytes check can catch it.
    const fakeJpeg = Buffer.from('this is just text, not a real JPEG body');
    globalThis.fetch = (async () => new Response(fakeJpeg, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    } as ResponseInit)) as typeof fetch;
    await assert.rejects(
      () => fetchCoverJpeg('https://img/lie.jpg'),
      /magic bytes/i,
    );
  });

  it('rejects a 2xx JPEG body that exceeds the 256 KB cap', async () => {
    const oversized = Buffer.alloc(COVER_MAX_BYTES + 1, 0);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    globalThis.fetch = (async () => new Response(oversized, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    } as ResponseInit)) as typeof fetch;
    await assert.rejects(
      () => fetchCoverJpeg('https://img/huge.jpg'),
      /256 KB/,
    );
  });

  it('returns the decoded buffer and bytes for a valid JPEG', async () => {
    globalThis.fetch = (async () => new Response(VALID_JPEG, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    } as ResponseInit)) as typeof fetch;
    const { buf, bytes } = await fetchCoverJpeg('https://img/ok.jpg');
    assert.equal(bytes, VALID_JPEG.length);
    assert.equal(buf.toString('hex'), VALID_JPEG.toString('hex'));
  });

  it('fails fast on a stalled CDN via AbortSignal.timeout, not a process hang', async () => {
    // Drop the timeout to 50ms so the test is quick. The fetch stub mirrors
    // what a stalled real fetch looks like: it listens on the AbortSignal
    // passed in `init`, and only rejects when that signal fires. A helper
    // that forgot to wire the signal through (the bug we are guarding against)
    // would hang forever, while one that does wire it rejects cleanly here.
    const prevTimeout = process.env.SPOTIFY_REQUEST_TIMEOUT_MS;
    process.env.SPOTIFY_REQUEST_TIMEOUT_MS = '50';
    initConfig(process.env);
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const reason = init.signal?.reason;
        reject(reason ?? new DOMException('Aborted', 'AbortError'));
      });
    })) as typeof fetch;
    // A real stalled fetch holds an open socket, which keeps the event loop
    // alive until the abort timer fires. This stub holds no handle, so on
    // Node 22 the unref'd `AbortSignal.timeout` timer lets the loop drain
    // first and node:test cancels the suite with "Promise resolution is still
    // pending but the event loop has already resolved". The keepAlive handle
    // below stands in for that socket, so the test measures the same thing on
    // every supported Node version.
    const keepAlive = setInterval(() => {}, 10);
    try {
      const start = Date.now();
      await assert.rejects(
        () => fetchCoverJpeg('https://stalled.invalid/cover.jpg'),
        /timed out/i,
      );
      const elapsed = Date.now() - start;
      // Generous bound — slow CI could legitimately add a few hundred ms —
      // but the test must finish in seconds, not minutes.
      assert.ok(elapsed < 5_000, `fetch should abort in ms, not hang (took ${elapsed}ms)`);
    } finally {
      clearInterval(keepAlive);
      if (prevTimeout === undefined) delete process.env.SPOTIFY_REQUEST_TIMEOUT_MS;
      else process.env.SPOTIFY_REQUEST_TIMEOUT_MS = prevTimeout;
      initConfig(process.env);
    }
  });
});
