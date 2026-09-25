/**
 * Shared Spotify reference parser and resolver.
 *
 * A reference is a bare 22-character Spotify ID, a canonical spotify: URI,
 * a spotify:// link, or an official open.spotify.com share URL. All accepted
 * forms are normalised to the same bare ID. Unsupported hosts and entity
 * kinds are rejected instead of being passed to the Spotify API.
 */
import { z } from 'zod';

export const SPOTIFY_REFERENCE_KINDS = [
  'track',
  'album',
  'artist',
  'playlist',
  'show',
  'episode',
  'audiobook',
  'user',
] as const;

export type SpotifyReferenceKind = (typeof SPOTIFY_REFERENCE_KINDS)[number];
export type SpotifyReferenceForm = 'id' | 'uri' | 'url' | 'invalid';

export interface SpotifyReferenceClassification {
  input: string;
  form: SpotifyReferenceForm;
  kind: SpotifyReferenceKind | null;
  id: string | null;
  valid: boolean;
  error: string | null;
}

export interface ClassifySpotifyReferenceOptions {
  /**
   * Compatibility escape hatch for API fields that historically accept an
   * unvalidated ID component inside a spotify: URI. Entity-id schemas do not
   * enable this and therefore retain the strict 22-character boundary.
   */
  allowShortIds?: boolean;
}

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_URI_RE = /^spotify:(?:([a-z]+):([A-Za-z0-9]+)|\/\/([a-z]+)[/:]([A-Za-z0-9]+))$/i;
const KIND_BY_NAME: Record<string, SpotifyReferenceKind> = {
  track: 'track',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  show: 'show',
  episode: 'episode',
  audiobook: 'audiobook',
  user: 'user',
};

function invalid(
  input: string,
  form: SpotifyReferenceForm,
  error: string,
): SpotifyReferenceClassification {
  return { input, form, kind: null, id: null, valid: false, error };
}

function knownKind(value: string): SpotifyReferenceKind | null {
  return KIND_BY_NAME[value.toLowerCase()] ?? null;
}

function validId(id: string, allowShortIds: boolean): boolean {
  return SPOTIFY_ID_RE.test(id) || (allowShortIds && /^[A-Za-z0-9]+$/.test(id));
}

function finish(
  input: string,
  form: 'id' | 'uri' | 'url',
  rawKind: string,
  id: string,
  expectedKind: SpotifyReferenceKind | undefined,
  allowShortIds: boolean,
): SpotifyReferenceClassification {
  const kind = knownKind(rawKind);
  if (!kind) return invalid(input, form, `unsupported Spotify entity kind: ${rawKind}`);
  if (!validId(id, allowShortIds)) {
    const lengthRule = allowShortIds ? 'one or more' : 'exactly 22';
    return invalid(input, form, `invalid Spotify ${kind} ID: expected ${lengthRule} base62 characters`);
  }
  if (expectedKind && kind !== expectedKind) {
    return {
      input,
      form,
      kind,
      id,
      valid: false,
      error: `Spotify reference kind mismatch: expected ${expectedKind}, received ${kind}`,
    };
  }
  return { input, form, kind, id, valid: true, error: null };
}

function classifyUrl(
  input: string,
  value: string,
  expectedKind: SpotifyReferenceKind | undefined,
): SpotifyReferenceClassification {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(input, 'url', 'malformed URL');
  }
  if (url.protocol !== 'https:') {
    return invalid(input, 'url', 'Spotify share URLs must use https');
  }
  if (url.hostname.toLowerCase() !== 'open.spotify.com') {
    return invalid(input, 'url', `unsupported Spotify share URL host: ${url.hostname}`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0]?.toLowerCase() === 'embed') segments.shift();
  if (/^intl-[a-z]{2}$/i.test(segments[0] ?? '')) segments.shift();

  if (segments.length !== 2) {
    return invalid(input, 'url', 'Spotify share URL must contain exactly one entity kind and ID');
  }
  return finish(input, 'url', segments[0]!, segments[1]!, expectedKind, false);
}

/** Classify and validate a Spotify entity reference using the shared policy. */
export function classifySpotifyReference(
  reference: string,
  expectedKind?: SpotifyReferenceKind,
  options: ClassifySpotifyReferenceOptions = {},
): SpotifyReferenceClassification {
  const input = reference;
  const value = reference.trim();
  if (!value) return invalid(input, 'invalid', 'reference must not be empty');

  const bare = /^[A-Za-z0-9]+$/.exec(value);
  if (bare) {
    if (!validId(value, options.allowShortIds ?? false)) {
      return invalid(input, 'id', 'invalid Spotify ID: expected exactly 22 base62 characters');
    }
    // A bare ID carries no entity-kind evidence, so an expected kind is a
    // caller constraint rather than a mismatch.
    return { input, form: 'id', kind: expectedKind ?? null, id: value, valid: true, error: null };
  }

  const uri = SPOTIFY_URI_RE.exec(value);
  if (uri) {
    return finish(
      input,
      'uri',
      uri[1] ?? uri[3]!,
      uri[2] ?? uri[4]!,
      expectedKind,
      options.allowShortIds ?? false,
    );
  }

  if (/^https?:\/\//i.test(value)) {
    return classifyUrl(input, value, expectedKind);
  }
  if (/^spotify:/i.test(value)) {
    return invalid(input, 'uri', 'malformed Spotify URI');
  }
  return invalid(input, 'invalid', 'not a recognisable Spotify ID, URI, or official share URL');
}

/** Resolve a valid Spotify reference to its bare ID, or null on rejection. */
export function resolveSpotifyId(input: string, expectedKind?: SpotifyReferenceKind): string | null {
  const parsed = classifySpotifyReference(input, expectedKind);
  return parsed.valid ? parsed.id : null;
}

/** Resolve a reference to its canonical spotify:<kind>:<id> URI. */
export function spotifyUri(
  input: string,
  expectedKind?: SpotifyReferenceKind,
  options: ClassifySpotifyReferenceOptions = {},
): string | null {
  const parsed = classifySpotifyReference(input, expectedKind, options);
  return parsed.valid && parsed.kind && parsed.id
    ? `spotify:${parsed.kind}:${parsed.id}`
    : null;
}

/** Normalise valid references; retain rejected text so Zod can report it. */
export function normaliseToId(input: unknown): string {
  if (typeof input !== 'string') return String(input ?? '');
  return resolveSpotifyId(input) ?? input.trim();
}

/**
 * Zod helper for Spotify entity IDs. Invalid hosts, malformed kinds, bad IDs,
 * and typed-kind mismatches fail schema validation before a handler can call
 * the Spotify API.
 */
export function spotifyId(expectedKind?: SpotifyReferenceKind): z.ZodString {
  const description = expectedKind
    ? `Spotify ${expectedKind} ID, spotify:${expectedKind}: URI, or open.spotify.com/${expectedKind} URL`
    : 'Spotify ID, spotify: URI, or open.spotify.com share URL';
  return z.preprocess(
    (value) => {
      if (typeof value !== 'string') return value;
      return resolveSpotifyId(value, expectedKind) ?? value.trim();
    },
    z.string().min(1).superRefine((value, context) => {
      const parsed = classifySpotifyReference(value, expectedKind);
      if (!parsed.valid) {
        context.addIssue({ code: 'custom', message: parsed.error ?? 'invalid Spotify reference' });
      }
    }).describe(description),
  ) as unknown as z.ZodString;
}

/** Array form of {@link spotifyId}. */
export function spotifyIdArray(expectedKind?: SpotifyReferenceKind): z.ZodArray<z.ZodString> {
  return z.array(spotifyId(expectedKind));
}
