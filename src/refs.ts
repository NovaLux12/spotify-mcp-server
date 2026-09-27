/**
 * Shared Spotify reference parser and resolver.
 *
 * A reference is a bare catalog ID (or non-fixed user identifier), a
 * canonical spotify: URI, a spotify:// link, or an official
 * open.spotify.com share URL. All accepted forms are normalised to the same
 * bare ID. Unsupported hosts and entity kinds are rejected instead of being
 * passed to the Spotify API.
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

/**
 * The subset of the kind vocabulary that `GET /search` accepts as a `type`.
 *
 * `user` is a reference kind but not a searchable one, so this list is one
 * shorter than {@link SPOTIFY_REFERENCE_KINDS}; `satisfies` makes that
 * narrowing a compile error the moment a member stops being a real kind. This
 * is the one definition of "searchable kinds" (#584): the search schemas read
 * it instead of re-spelling the same seven-element list, which had been
 * duplicated across search.ts, searchdive.ts, catalog.ts and
 * exhaust2_catalog.ts. The emitted JSON Schema is unchanged — `z.enum` over a
 * readonly tuple and over the same literals produce identical bytes.
 */
export const SPOTIFY_SEARCHABLE_KINDS = [
  'track',
  'artist',
  'album',
  'playlist',
  'show',
  'episode',
  'audiobook',
] as const satisfies readonly SpotifyReferenceKind[];

export type SpotifySearchableKind = (typeof SPOTIFY_SEARCHABLE_KINDS)[number];

type SpotifyReferenceForm = 'id' | 'uri' | 'url' | 'invalid';

export interface SpotifyReferenceClassification {
  input: string;
  form: SpotifyReferenceForm;
  kind: SpotifyReferenceKind | null;
  id: string | null;
  valid: boolean;
  error: string | null;
}

interface ClassifySpotifyReferenceOptions {
  /**
   * Compatibility escape hatch for API fields that historically accept an
   * unvalidated ID component inside a spotify: URI. Entity-id schemas do not
   * enable this and therefore retain the strict 22-character boundary.
   */
  allowShortIds?: boolean;
}

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
// This is the only Spotify URI grammar in src. Entity-specific ID checks
// happen after extraction so user identifiers can remain non-fixed length.
const SPOTIFY_URI_RE = /^spotify:(?:([a-z]+):([^\/?#]+)|\/\/([a-z]+)[/:]([^\/?#]+))$/i;
const SPOTIFY_USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/**
 * The single definition of the kind vocabulary, as a `Map` rather than an
 * object literal. A plain object inherits every `Object.prototype` key, so
 * `KIND_BY_NAME['constructor']` used to resolve to the `Object` constructor:
 * `spotify:constructor:<id>` classified as a valid reference whose "kind" was
 * a function, and `spotifyUri` round-tripped it into a
 * `spotify:function Object() { [native code] }:<id>` URI. A `Map` has no
 * prototype chain, so membership is exactly the vocabulary above.
 */
const KIND_BY_NAME: ReadonlyMap<string, SpotifyReferenceKind> = new Map(
  SPOTIFY_REFERENCE_KINDS.map((kind) => [kind, kind]),
);

function invalid(
  input: string,
  form: SpotifyReferenceForm,
  error: string,
): SpotifyReferenceClassification {
  return { input, form, kind: null, id: null, valid: false, error };
}

function knownKind(value: string): SpotifyReferenceKind | null {
  return KIND_BY_NAME.get(value.toLowerCase()) ?? null;
}

function validId(id: string, kind: SpotifyReferenceKind, allowShortIds: boolean): boolean {
  if (kind === 'user') return SPOTIFY_USER_ID_RE.test(id);
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
  if (!validId(id, kind, allowShortIds)) {
    const lengthRule = kind === 'user'
      ? 'one or more URL-safe'
      : allowShortIds ? 'one or more' : 'exactly 22';
    return invalid(input, form, `invalid Spotify ${kind} ID: expected ${lengthRule} characters`);
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

  // Spotify's localized embed routes can put the locale and embed marker in
  // either order: /intl-xx/embed/kind/id and /embed/intl-xx/kind/id.
  const segments = url.pathname.split('/').filter(Boolean);
  while (segments[0]?.toLowerCase() === 'embed' || /^intl-[a-z]{2}$/i.test(segments[0] ?? '')) {
    segments.shift();
  }
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

  const bare = (expectedKind === 'user' ? SPOTIFY_USER_ID_RE : /^[A-Za-z0-9]+$/).exec(value);
  if (bare) {
    if (!validId(value, expectedKind ?? 'track', options.allowShortIds ?? false)) {
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
  if (value.toLowerCase().startsWith('spotify:')) {
    return invalid(input, 'uri', 'malformed Spotify URI');
  }
  return invalid(input, 'invalid', 'not a recognisable Spotify ID, URI, or official share URL');
}

/** Resolve a valid Spotify reference to its bare ID, or null on rejection. */
export function resolveSpotifyId(input: string, expectedKind?: SpotifyReferenceKind): string | null {
  const parsed = classifySpotifyReference(input, expectedKind);
  return parsed.valid ? parsed.id : null;
}

/** Format a classification without classifying the same reference twice. */
export function spotifyUriFromClassification(parsed: SpotifyReferenceClassification): string | null {
  return parsed.valid && parsed.kind && parsed.id ? `spotify:${parsed.kind}:${parsed.id}` : null;
}

/** Resolve a reference to its canonical spotify:<kind>:<id> URI. */
export function spotifyUri(
  input: string,
  expectedKind?: SpotifyReferenceKind,
  options: ClassifySpotifyReferenceOptions = {},
): string | null {
  return spotifyUriFromClassification(classifySpotifyReference(input, expectedKind, options));
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
export function spotifyId(expectedKind?: SpotifyReferenceKind): z.ZodType<string> {
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
  );
}

/** Array form of {@link spotifyId}. */
export function spotifyIdArray(expectedKind?: SpotifyReferenceKind): z.ZodArray<z.ZodType<string>> {
  return z.array(spotifyId(expectedKind));
}

/**
 * Normalise a caller-supplied reference to its bare ID, or return it unchanged
 * when it is not one this resolver can classify.
 *
 * This is the tolerant half of the policy {@link spotifyId} enforces, and it
 * exists because the two answer different questions:
 *
 *  - `spotifyId` is a VALIDATOR. It rejects anything that is not a well-formed
 *    reference for `expectedKind`, so a caller that sent a name where an id
 *    belonged gets a 400 naming the rule.
 *  - `spotifyRef` is a NORMALISER. It answers only "what does this string
 *    refer to", and for a string it cannot classify it has no opinion — it
 *    returns the input and lets Spotify decide whether the entity exists.
 *
 * The distinction is the whole reason the entity-id parameters could be
 * migrated at all (#914). Routing all of them through `spotifyId` would have
 * been correct-by-the-letter and wrong in effect: it converts a 404 for a
 * malformed id into a 400 across the largest part of the tool surface, and
 * several of the parameters legitimately carry values this server never
 * classified (see the call sites that keep a name-matching fallback). The
 * defect the issue actually reports is that a `spotify:` URI or an
 * open.spotify.com URL reached the request path unnormalised and 404'd as if
 * the entity were missing — so normalising is the fix, and rejecting is not.
 *
 * The transform is a `z.preprocess` over the caller's own schema, which under
 * the SDK's `pipeStrategy: 'input'` unwraps to exactly that schema. The
 * emitted JSON Schema is byte-identical to the un-wrapped form, so migrating a
 * parameter does not move the per-module schema budget (see AGENTS.md §4).
 *
 * Not exported: {@link spotifyRef} is the only sanctioned way to declare one of
 * these, so an exported raw normaliser would be a second door into the same
 * policy for a caller to reach past the schema layer.
 */
function normaliseSpotifyRef(
  value: unknown,
  expectedKind?: SpotifyReferenceKind,
): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  // A kind mismatch deliberately falls through unchanged. Reducing a
  // `spotify:track:` handed to a playlist parameter to its bare ID would turn
  // "you named the wrong kind" into "that playlist does not exist", which is
  // the same class of defect this migration exists to remove. Passing the
  // original through lets the 404 name what the caller actually sent.
  return resolveSpotifyId(trimmed, expectedKind) ?? trimmed;
}

/**
 * Wrap a caller's own zod schema so it receives a normalised bare reference
 * (#914).
 *
 * The inner schema is passed through untouched, which is what keeps this
 * behaviour-preserving: `.min(1)`, `.optional()` and the caller's own
 * `.describe(...)` all keep their exact semantics, and an id this server
 * cannot classify is handed to Spotify as the caller wrote it.
 */
export function spotifyRef<SCHEMA extends z.ZodType>(
  schema: SCHEMA,
  expectedKind?: SpotifyReferenceKind,
): z.ZodType<z.output<SCHEMA>, z.input<SCHEMA>> {
  return z.preprocess((value) => normaliseSpotifyRef(value, expectedKind), schema);
}
