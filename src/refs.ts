/**
 * refs (#226): shared resolver accepting bare ID, spotify: URI,
 * https://open.spotify.com/... share URLs, and spotify://... links.
 * Normalises to a bare Spotify ID. Used via zod z.preprocess at schema layer.
 */
import { z } from 'zod';

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_URI_RE = /^spotify:(track|album|artist|playlist|show|episode|audiobook|user):([A-Za-z0-9]+)$/;
// spotify:// scheme: spotify://track/ID  or spotify://playlist:ID
const SPOTIFY_SCHEME_RE = /^spotify:\/\/([a-z]+)[:/]([A-Za-z0-9]+)/i;

/** Extract the entity kind from the URL path segment, e.g. "track", "playlist". */
function kindFromPathSegment(seg: string): string | null {
  const known = new Set(['track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook', 'user']);
  return known.has(seg.toLowerCase()) ? seg.toLowerCase() : null;
}

/**
 * Normalise a Spotify reference (bare ID, spotify: URI, open.spotify.com URL,
 * or spotify:// scheme) to a bare ID. Returns null when unrecognised.
 *
 * When `expectedKind` is supplied, a mismatch still returns the ID — callers
 * that need strict kind-checking can validate separately. IDs inside URIs/URLs
 * are compared case-insensitively for kind but the raw ID string is returned
 * as-is (IDs are case-sensitive).
 */
export function resolveSpotifyId(input: string, expectedKind?: string): string | null {
  const s = input.trim();
  if (!s) return null;

  // 1. Bare ID (22 alphanumeric chars is the canonical Spotify length, but
  //    some audiobook/show IDs are shorter — accept 1+ alphanumeric).
  //    We accept bare 22-char IDs eagerly; shorter bare strings are only
  //    accepted if they look hex-ish — but to stay permissive just pass through
  //    any single token without separators as a candidate ID.
  //    Simpler rule: bare ID = 22-char base62 or any non-URL/non-URI token.
  //    For robustness: if no separators and not a URL/URI prefix, treat as ID.
  if (!s.includes(':') && !s.includes('/') && SPOTIFY_ID_RE.test(s)) return s;
  // Single-token bare IDs that are shorter (some legacy/show IDs): accept if
  // alphanumeric only and 5+ chars, no colons/slashes.
  if (!s.includes(':') && !s.includes('/') && /^[A-Za-z0-9]{5,}$/.test(s)) return s;

  // 2. spotify: URI
  const uriMatch = SPOTIFY_URI_RE.exec(s);
  if (uriMatch) return uriMatch[2];

  // 3. spotify:// scheme
  const schemeMatch = SPOTIFY_SCHEME_RE.exec(s);
  if (schemeMatch) return schemeMatch[2];

  // 4. https://open.spotify.com/... URLs (incl. with ?si=, ?utm_source, etc.)
  //    Covers: https://open.spotify.com/track/ID[?si=...]
  try {
    const url = new URL(s);
    if (url.hostname === 'open.spotify.com' || url.hostname.endsWith('.spotify.com')) {
      const parts = url.pathname.split('/').filter(Boolean); // e.g. ["track","ID"] or ["embed","track","ID"]
      // Handle /embed/track/ID as well
      const embedIdx = parts.indexOf('embed');
      const segs = embedIdx >= 0 ? parts.slice(embedIdx + 1) : parts;
      if (segs.length >= 2) {
        const kind = kindFromPathSegment(segs[0]);
        if (kind) return segs[1];
        // Fallback: second segment that looks like an ID
        if (/^[A-Za-z0-9]{5,}$/.test(segs[1])) return segs[1];
      } else if (segs.length === 1 && SPOTIFY_ID_RE.test(segs[0])) {
        // Rare bare path like /ID
        return segs[0];
      }
    }
  } catch {
    // not a URL — fall through
  }

  // 5. Fallback: extract ID from any URL-like string containing /<kind>/<id>
  const pathIdMatch = /\/(track|album|artist|playlist|show|episode|audiobook)\/([A-Za-z0-9]{5,})/i.exec(s);
  if (pathIdMatch) return pathIdMatch[2];

  return null;
}

/**
 * Normalise to ID or pass through unchanged when unrecognised (so the tool
 * can still try the raw value or produce a better error). Use with
 * z.preprocess — kept permissive by design.
 */
export function normaliseToId(input: unknown): string {
  if (typeof input !== 'string') return String(input ?? '');
  const id = resolveSpotifyId(input);
  return id ?? input.trim();
}

/**
 * Zod schema helper: preprocess any Spotify reference to a bare ID string.
 * Keeps validation (min length) after preprocessing so every entity-id param
 * benefits without per-tool edits.
 *
 * Usage:  playlist_id: spotifyId()   // replaces z.string().min(1)
 */
export function spotifyId(expectedKind?: string): z.ZodString {
  return z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      return resolveSpotifyId(v, expectedKind) ?? v.trim();
    },
    z.string().min(1).describe('Spotify ID, URI (spotify:...), or open.spotify.com URL — all resolve to the same entity'),
  ) as unknown as z.ZodString;
}

/**
 * Like spotifyId but for arrays of IDs/URIs/URLs (e.g. track_ids).
 */
export function spotifyIdArray(expectedKind?: string): z.ZodArray<z.ZodString> {
  return z.array(spotifyId(expectedKind));
}
