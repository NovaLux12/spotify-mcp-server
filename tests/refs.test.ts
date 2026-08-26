import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpotifyId, normaliseToId } from '../src/refs.js';

describe('refs — resolveSpotifyId', () => {
  const cases: Array<[string, string | null]> = [
    // Bare ID
    ['4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    // spotify: URI
    ['spotify:track:4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    ['spotify:playlist:37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DX0XUsuxWHRQd'],
    ['spotify:album:6akEvsycLGftJxYudPjmq', '6akEvsycLGftJxYudPjmq'],
    ['spotify:episode:512ojhOuo1ktJprKbVcKyQ', '512ojhOuo1ktJprKbVcKyQ'],
    // open.spotify.com URLs
    ['https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    ['https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd?si=abc123', '37i9dQZF1DX0XUsuxWHRQd'],
    ['https://open.spotify.com/album/6akEvsycLGftJxYudPjmq?si=xyz', '6akEvsycLGftJxYudPjmq'],
    ['https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ', '512ojhOuo1ktJprKbVcKyQ'],
    ['https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?utm_source=copy', '4iV5W9uYEdYUVa79Axb7Rh'],
    // embed URL
    ['https://open.spotify.com/embed/track/4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    // spotify:// scheme
    ['spotify://track/4iV5W9uYEdYUVa79Axb7Rh', '4iV5W9uYEdYUVa79Axb7Rh'],
    ['spotify://playlist:37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DX0XUsuxWHRQd'],
    // Whitespace trimming
    ['  spotify:track:4iV5W9uYEdYUVa79Axb7Rh  ', '4iV5W9uYEdYUVa79Axb7Rh'],
    ['  https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh  ', '4iV5W9uYEdYUVa79Axb7Rh'],
  ];
  for (const [input, expected] of cases) {
    it(`resolves ${JSON.stringify(input)} → ${expected}`, () => {
      assert.equal(resolveSpotifyId(input), expected);
    });
  }
  it('returns null for unrecognised input', () => {
    assert.equal(resolveSpotifyId('not-a-spotify-ref'), null);
    assert.equal(resolveSpotifyId(''), null);
  });
  it('normaliseToId round-trips share URL to bare ID', () => {
    assert.equal(normaliseToId('https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?si=abc'), '4iV5W9uYEdYUVa79Axb7Rh');
  });
  it('normaliseToId passes through bare ID unchanged', () => {
    assert.equal(normaliseToId('4iV5W9uYEdYUVa79Axb7Rh'), '4iV5W9uYEdYUVa79Axb7Rh');
  });
});
