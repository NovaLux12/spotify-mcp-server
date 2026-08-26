/**
 * Tests for SPOTIFY_HEADLESS=1 paste-URL auth flow (PR #7).
 *
 * Covers:
 *   - isHeadlessMode() reads SPOTIFY_HEADLESS env var correctly
 *     (positive, unset, and non-"1" values).
 *   - parseCallbackUrl() extracts the authorization code from a valid
 *     pasted redirect URL.
 *   - parseCallbackUrl() rejects state mismatches, malformed URLs,
 *     Spotify-returned `error` params, and missing `code` params.
 *
 * Run with: npm test   (uses node:test + tsx)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isHeadlessMode, parseCallbackUrl } from '../src/auth.ts';

describe('isHeadlessMode (SPOTIFY_HEADLESS env var gate)', () => {
  const ORIGINAL = process.env.SPOTIFY_HEADLESS;

  before(() => {
    // Start each test from a clean slate.
    delete process.env.SPOTIFY_HEADLESS;
  });

  after(() => {
    // Restore original env so we don't leak across test files.
    if (ORIGINAL === undefined) {
      delete process.env.SPOTIFY_HEADLESS;
    } else {
      process.env.SPOTIFY_HEADLESS = ORIGINAL;
    }
  });

  it('returns true when SPOTIFY_HEADLESS=1', () => {
    process.env.SPOTIFY_HEADLESS = '1';
    assert.equal(isHeadlessMode(), true);
  });

  it('returns false when SPOTIFY_HEADLESS is unset (negative: redirect flow used)', () => {
    delete process.env.SPOTIFY_HEADLESS;
    assert.equal(isHeadlessMode(), false);
  });

  it('returns false for non-"1" values (e.g. "true", "yes", "0")', () => {
    // #232: isHeadlessMode now aligns with truthyEnv (1/true/yes/on case-insensitive)
    // So "true", "yes", "on" (and case variants) are truthy; "0", "" are falsy.
    for (const v of ['true', 'TRUE', 'yes', 'YES', 'on', 'ON', 'True', 'Yes', 'On']) {
      process.env.SPOTIFY_HEADLESS = v;
      assert.equal(isHeadlessMode(), true, `SPOTIFY_HEADLESS=${JSON.stringify(v)} should enable headless mode (truthyEnv)`);
    }
    for (const v of ['0', '', 'false', 'no', 'off', '  ']) {
      process.env.SPOTIFY_HEADLESS = v;
      assert.equal(isHeadlessMode(), false, `SPOTIFY_HEADLESS=${JSON.stringify(v)} should NOT enable headless mode`);
    }
  });
});

describe('parseCallbackUrl (pasted-URL extraction & validation)', () => {
  const STATE = 'expected-state-token-abc123';

  it('extracts the authorization code from a valid pasted redirect URL', () => {
    const pasted =
      'http://127.0.0.1:8888/callback?code=AQD_xyz123&state=' +
      encodeURIComponent(STATE);
    const { code } = parseCallbackUrl(pasted, STATE);
    assert.equal(code, 'AQD_xyz123');
  });

  it('extracts the code when extra query params are present', () => {
    const pasted =
      'http://127.0.0.1:8888/callback' +
      '?code=AQD_real_code' +
      '&state=' + encodeURIComponent(STATE) +
      '&utm_source=test';
    const { code } = parseCallbackUrl(pasted, STATE);
    assert.equal(code, 'AQD_real_code');
  });

  it('throws on state mismatch (CSRF protection)', () => {
    const pasted =
      'http://127.0.0.1:8888/callback?code=AQD&state=wrong-state';
    assert.throws(
      () => parseCallbackUrl(pasted, STATE),
      /State mismatch/,
    );
  });

  it('throws on a malformed (non-URL) pasted value', () => {
    assert.throws(
      () => parseCallbackUrl('not a url at all', STATE),
      /not a valid URL/,
    );
  });

  it('throws when Spotify returned an `error` param (e.g. access_denied)', () => {
    const pasted =
      'http://127.0.0.1:8888/callback' +
      '?error=access_denied' +
      '&state=' + encodeURIComponent(STATE);
    assert.throws(
      () => parseCallbackUrl(pasted, STATE),
      /Spotify auth error.*access_denied/,
    );
  });

  it('throws when the pasted URL has no `code` param', () => {
    const pasted =
      'http://127.0.0.1:8888/callback?state=' + encodeURIComponent(STATE);
    assert.throws(
      () => parseCallbackUrl(pasted, STATE),
      /No authorization code/,
    );
  });
});