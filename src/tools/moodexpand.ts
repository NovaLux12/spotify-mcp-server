/**
 * `expand_mood_to_queries` — the one judgement step the mood prompts used to
 * re-invent in prose, extracted into a testable tool (#598).
 *
 * ## Why this exists
 *
 * Four prompts (`dj`, `playlist_from_mood`, `discover_weekly_alternative`,
 * `crate_digging`) each told the host model, in slightly different words, to
 * turn a mood into search queries. Every one of those is an LLM decision
 * written as English: it cannot be unit-tested, it cannot be inspected, and it
 * changes when the prompt is reworded. This module gives that decision one
 * implementation with one output contract.
 *
 * ## Why MCP sampling, and not a provider call
 *
 * The server has no model-provider dependency — `package.json` carries exactly
 * `@modelcontextprotocol/sdk`, `open` and `zod`, and `grep -rniE
 * "sampling|createMessage" src/` found no SDK call before this module. The
 * only LLM this server can reach is the one the HOST already runs, through the
 * MCP `sampling/createMessage` request, which is why the host's credentials and
 * billing are the ones that apply. Inventing a provider client here would add a
 * dependency, a secret and a second set of failure modes to a server whose
 * whole point is that it holds no model credentials.
 *
 * ## The capability gate
 *
 * `createMessage` in SDK 1.30 does NOT assert the base `sampling` capability
 * when no `tools` are passed (it only checks `capabilities.sampling.tools`), so
 * an ungated call would put a request on the wire against a host that never
 * agreed to answer one. The gate below is therefore ours, and it is checked
 * before the request is built — a non-sampling host issues NO
 * `sampling/createMessage` at all, and gets the static map instead.
 *
 * The static map is not a degraded stub dressed up as an answer: its rows were
 * checked against the real Spotify genre-seed vocabulary, and a mood the map
 * does not carry is reported as `matched: false` with the caller's own words
 * echoed back as keywords, rather than being rounded to the nearest row
 * (AGENTS.md §6 — a lookup that did not happen is named, never guessed).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResponseFormat } from '../shaping.js';

export interface StaticExpansion {
  readonly genres: readonly string[];
  readonly keywords: readonly string[];
  readonly exclude: readonly string[];
}

/**
 * The static fallback table.
 *
 * Every value in `genres` is a real string from Spotify's genre-seed
 * vocabulary — the canonical list behind `GET /recommendations/
 * available-genre-seeds`, which is itself deprecated for post-Nov-2024 apps
 * (AGENTS.md §2) and so cannot be consulted at runtime to check a spelling.
 * That is why the vocabulary was verified once, out of band, rather than being
 * invented here: `pop`, `indie`, `indie-pop`, `alternative`, `alt-rock`,
 * `ambient`, `new-age`, `piano`, `classical`, `electronic`, `edm`, `house`,
 * `techno`, `drum-and-bass`, `dubstep`, `trip-hop`, `chill`, `jazz`, `blues`,
 * `soul`, `funk`, `disco`, `r&b`, `hip-hop`, `gospel`, `afrobeat`, `rock`,
 * `alt-rock`, `punk`, `emo`, `ska`, `grunge`, `garage`, `metal`, `folk`,
 * `country`, `reggae`, `latin`, `bossanova`, `k-pop`, `j-pop` and
 * `singer-songwriter` are all seeds. Words that are NOT seeds —
 * `shoegaze`, `dream-pop`, `lo-fi`, `chillhop` — appear only under
 * `keywords`, which is free text fed to `search`, so the two fields are held
 * to different standards on purpose.
 *
 * Keys are the normalised mood names; `MOOD_LOOKUP` resolves a free-text mood
 * against them.
 */
export const MOOD_EXPANSION: Readonly<Record<string, StaticExpansion>> = Object.freeze({
  focus: {
    genres: ['ambient', 'new-age', 'piano', 'classical'],
    keywords: ['instrumental', 'focus', 'study', 'no lyrics'],
    exclude: ['live', 'remix', 'cover'],
  },
  coding: {
    genres: ['ambient', 'electronic', 'trip-hop', 'chill'],
    keywords: ['instrumental', 'lofi', 'programming', 'no vocals'],
    exclude: ['live', 'acoustic', 'spoken word'],
  },
  running: {
    genres: ['edm', 'house', 'techno', 'drum-and-bass'],
    keywords: ['workout', 'running', 'cardio', 'high energy'],
    exclude: ['sleep', 'ballad', 'acoustic'],
  },
  workout: {
    genres: ['edm', 'rock', 'punk', 'hip-hop'],
    keywords: ['gym', 'workout', 'pump', 'power'],
    exclude: ['sleep', 'ambient'],
  },
  sleep: {
    genres: ['ambient', 'new-age', 'piano', 'classical'],
    keywords: ['sleep', 'calm', 'quiet', 'sleeping'],
    exclude: ['rock', 'metal', 'punk', 'dance'],
  },
  rainy: {
    genres: ['indie', 'indie-pop', 'folk', 'acoustic'],
    keywords: ['rainy day', 'melancholy', 'shoegaze', 'dream-pop'],
    exclude: ['dance', 'edm', 'party'],
  },
  morning: {
    genres: ['indie-pop', 'pop', 'funk', 'soul'],
    keywords: ['morning', 'sunny', 'feel good', 'upbeat'],
    exclude: ['sleep', 'dark', 'doom'],
  },
  party: {
    genres: ['dance', 'edm', 'house', 'disco'],
    keywords: ['party', 'club', 'banger', 'dance floor'],
    exclude: ['acoustic', 'ballad', 'sleep'],
  },
  sad: {
    genres: ['indie', 'folk', 'classical', 'blues'],
    keywords: ['sad', 'melancholy', 'somber', 'emotional'],
    exclude: ['dance', 'party', 'edm'],
  },
  driving: {
    genres: ['rock', 'electronic', 'alt-rock', 'indie'],
    keywords: ['driving', 'road trip', 'highway', 'cruise'],
    exclude: ['sleep', 'ballad'],
  },
  cooking: {
    genres: ['latin', 'funk', 'soul', 'bossanova'],
    keywords: ['cooking', 'dinner', 'kitchen', 'groove'],
    exclude: ['sleep', 'doom', 'metal'],
  },
  summer: {
    genres: ['pop', 'reggae', 'latin', 'dance'],
    keywords: ['summer', 'pool', 'sunny', 'beach'],
    exclude: ['sad', 'sleep', 'doom'],
  },
  chill: {
    genres: ['chill', 'trip-hop', 'indie-pop', 'singer-songwriter'],
    keywords: ['chill', 'relaxing', 'laid back', 'easy'],
    exclude: ['aggressive', 'metal', 'punk'],
  },
  energizing: {
    genres: ['pop', 'dance', 'edm', 'funk'],
    keywords: ['energizing', 'hype', 'workout', 'uplifting'],
    exclude: ['sleep', 'sad', 'ambient'],
  },
});

/**
 * Multi-word moods that name a row above.
 *
 * `normaliseMood` preserves internal spaces, so the whole-phrase pass finds
 * these directly and the token pass never has to guess which of "deep",
 * "work" or "late" was the one that mattered. These are the phrasings the
 * mood prompts actually use — `playlist_from_mood`'s own description offers
 * "rainy afternoon", "morning run" and "late night coding" as examples — so
 * the table covers the calls it was written for rather than a vocabulary of
 * one-word labels it was never asked for.
 */
const MOOD_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'deep work': 'focus',
  'late night': 'sleep',
  'night drive': 'driving',
  'morning run': 'running',
  'road trip': 'driving',
  'late night coding': 'coding',
  'study session': 'focus',
  'workout pump': 'workout',
  'feel good': 'morning',
  'sunday morning': 'morning',
  'dinner party': 'party',
  'pool party': 'party',
});

/**
 * Reduce a mood string to a lookup key: lowercase, punctuation to spaces,
 * collapsed whitespace, trimmed.
 *
 * Stopwords are dropped at MATCH time rather than here, so
 * `MOOD_EXPANSION`'s keys stay readable in the source above.
 */
function normaliseMood(mood: string): string {
  return mood.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Words that carry no mood signal, so they must not decide a match. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
  'some', 'very', 'really', 'quite', 'playlist', 'music', 'vibe', 'mood',
  'song', 'songs', 'tracks', 'track', 'me', 'my', 'i', 'want', 'need', 'like',
  'something', 'stuff', 'this', 'that', 'it', 'is', 'are', 'be', 'but', 'so',
]);

/**
 * Resolve a free-text mood against {@link MOOD_EXPANSION}.
 *
 * Three passes, in order: the whole normalised mood as a key, an alias from
 * {@link MOOD_ALIASES}, then each significant token in turn. A mood the table
 * does not carry returns `undefined` — never the closest row, because "sombre
 * techno funeral" must not be answered with the `chill` row and presented as a
 * match.
 */
export function lookupStaticExpansion(mood: string): { key: string; expansion: StaticExpansion } | undefined {
  const normalised = normaliseMood(mood);
  if (normalised === '') return undefined;
  const direct = MOOD_EXPANSION[normalised];
  if (direct) return { key: normalised, expansion: direct };
  const alias = MOOD_ALIASES[normalised];
  if (alias && MOOD_EXPANSION[alias]) return { key: normalised, expansion: MOOD_EXPANSION[alias] };
  for (const token of normalised.split(' ')) {
    if (STOPWORDS.has(token)) continue;
    const hit = MOOD_EXPANSION[token];
    if (hit) return { key: token, expansion: hit };
  }
  return undefined;
}

/**
 * The output contract, in one place, and the ONLY thing a model response is
 * allowed to become.
 *
 * Not `.strict()`: an extra key is chatter, not a wrong shape, and failing the
 * whole call over one would spend a retry on a difference that changes nothing
 * about the three arrays. A missing key, a non-array, a non-string element or
 * an over-long list all fail, because each of those would leave a caller
 * holding a number or a list the model never actually produced (AGENTS.md §6).
 */
export const MoodExpansionShape = z.object({
  genres: z.array(z.string().min(1)).max(8),
  keywords: z.array(z.string().min(1)).max(12),
  exclude: z.array(z.string().min(1)).max(8),
});

export type MoodExpansion = z.infer<typeof MoodExpansionShape>;

/** The instruction sent with each attempt. The retry appends to it, never replaces. */
const OUTPUT_CONTRACT =
  'Reply with ONE JSON object and nothing else — no prose, no explanation, no markdown fence.\n' +
  'Its shape is exactly: {"genres": string[], "keywords": string[], "exclude": string[]}\n' +
  'genres: 2-5 Spotify genre names or broad genre phrases. keywords: 2-6 free-text search terms. ' +
  'exclude: 0-3 terms to steer a search AWAY from (word only, no "not"). All three arrays must be present.';

function samplingPrompt(mood: string, attempt: number): string {
  const base =
    `Expand this listening mood into search terms for a music search engine: "${mood}".\n${OUTPUT_CONTRACT}`;
  // The retry says what actually happened. A bare re-send of the same prompt
  // would let a model that misread the contract misread it again.
  return attempt === 0
    ? base
    : `${base}\nYour previous reply was not valid JSON in that shape. Return the JSON object alone.`;
}

/**
 * Pull the JSON object out of a model reply.
 *
 * A fence is stripped because models emit one constantly and a fence is
 * packaging, not a malformed answer. Nothing else is repaired: no regex hunts
 * for a `{...}` substring, and no field is defaulted. If the remainder is not
 * JSON in the declared shape, the attempt failed — which is the outcome the
 * caller is told about.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(body);
}

/** A model reply that cannot be parsed, or parsed into the wrong shape. */
class InvalidExpansion extends Error {
  constructor(readonly detail: string) {
    super(`sampling response was not the declared JSON shape: ${detail}`);
    this.name = 'InvalidExpansion';
  }
}

async function sampleExpansion(
  server: McpServer,
  mood: string,
  maxTokens: number,
): Promise<{ expansion: MoodExpansion; model: string | null; attempts: number }> {
  let lastDetail = 'no attempt was made';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // `maxTokens` is required by the protocol; a generous ceiling for a
    // three-array object, and the reason a truncated reply surfaces as a
    // parse failure rather than as a short list.
    const result = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: samplingPrompt(mood, attempt) } }],
      maxTokens,
    });
    const content = result?.content;
    if (!content || content.type !== 'text') {
      lastDetail = `model returned ${content ? `a ${content.type} block` : 'no content block'}, expected text`;
      continue;
    }
    try {
      const parsed = MoodExpansionShape.parse(extractJson(content.text));
      return { expansion: parsed, model: result.model ?? null, attempts: attempt + 1 };
    } catch (error) {
      // Two different claims, kept apart because "the JSON was wrong" and "the
      // JSON was well-formed but not what was asked for" need different fixes.
      // Both are bounded: the zod side by the array limits, the parse side by
      // the slice, so a model cannot fill the host's log by returning a novel.
      lastDetail =
        error instanceof z.ZodError
          ? `JSON parsed but did not match the shape (${error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')})`
          : `reply was not JSON (${String((error as Error).message).slice(0, 120)})`;
    }
  }
  throw new InvalidExpansion(lastDetail);
}

/** The structured failure every unreadable model response returns. */
function samplingFailed(tool: string, detail: string): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text:
          `expand_mood_to_queries could not read a usable expansion from the host model after 2 attempts: ${detail}. ` +
          'Nothing was guessed and no fallback was substituted — call it on a host that advertises sampling, or search with your own terms.',
      },
    ],
    structuredContent: {
      error: {
        tool,
        kind: 'sampling_invalid_response',
        reason: 'model_response_not_usable',
        fix: 'Retry on a sampling-capable host, or run the searches with your own keywords.',
      },
      detail,
      attempts: 2,
      returned: null,
    },
    isError: true,
  };
}

/** Does this host advertise the base `sampling` capability? */
export function hostSupportsSampling(server: McpServer): boolean {
  return Boolean(server.server.getClientCapabilities()?.sampling);
}

function render(mood: string, payload: Record<string, unknown>, format: 'concise' | 'detailed' | 'json'): string {
  if (format === 'json') return JSON.stringify(payload, null, 2);
  const source = payload.source as string;
  const headline =
    source === 'sampling'
      ? `Mood "${mood}" expanded by the host model${payload.model ? ` (${payload.model})` : ''} after ${payload.attempts} sampling call${payload.attempts === 1 ? '' : 's'}:`
      : payload.matched === true
        ? `Mood "${mood}" expanded from the built-in map (row: ${payload.matched_key}):`
        : `Mood "${mood}" is not in the built-in map, so only your own words are returned as keywords — no genre was guessed:`;
  const lines = [headline];
  for (const field of ['genres', 'keywords', 'exclude'] as const) {
    const values = payload[field] as string[];
    lines.push(`  ${field}: ${values.length > 0 ? values.join(', ') : '(none)'}`);
  }
  if (format === 'detailed') {
    lines.push(`  source: ${source}`);
    if (payload.note) lines.push(`  note: ${payload.note}`);
    if (payload.detail) lines.push(`  detail: ${payload.detail}`);
  }
  if (source === 'static_map') {
    lines.push(
      payload.matched === true
        ? '  Source: static map — this host did not advertise the sampling capability, so no sampling/createMessage was sent.'
        : '  Source: static map miss. Search with the keywords above, or broaden the mood.',
    );
  }
  return lines.join('\n');
}

export function registerMoodExpandTools(server: McpServer): void {
  server.tool(
    'expand_mood_to_queries',
    'Turn a free-text listening mood into search terms (genres, keywords, terms to avoid) for search. ' +
      'Uses the host model via MCP sampling when the host advertises the sampling capability; otherwise returns ' +
      'a built-in static map. Calls no Spotify endpoint and changes nothing. ' +
      'A model reply that cannot be parsed returns isError after one retry — it is never replaced by a guess.',
    {
      mood: z
        .string()
        // `trim()` before `min(1)`, because a whitespace-only mood is not a
        // short mood. Without it "   " passes the length check, normalises to
        // "", and comes back from the static-map path as three empty arrays
        // with matched=false — a successful answer to a question nobody asked,
        // which reads to the caller as "this mood expands to nothing" rather
        // than "you sent nothing". Rejecting it says which of the two happened.
        .trim()
        .min(1)
        .describe('The mood or vibe to expand, in free text (e.g. "rainy afternoon", "late night coding")'),
      max_tokens: z
        .number()
        .int()
        .min(64)
        .max(4096)
        .optional()
        .describe('Token ceiling for the sampling call. Default: 512. Ignored on the static-map path'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const mood = args.mood.trim();
      const format = args.response_format ?? 'concise';

      // --- the gate. Checked before anything is built, so a host that never
      // advertised sampling sees no request at all.
      if (!hostSupportsSampling(server)) {
        const hit = lookupStaticExpansion(mood);
        const payload: Record<string, unknown> = {
          mood,
          source: 'static_map',
          // `false` is a fact about the lookup, and it is the whole point:
          // a caller that cannot tell a miss from a hit will read `genres: []`
          // as "this mood has no genre affinity", which is a claim nobody made.
          matched: hit !== undefined,
          matched_key: hit?.key ?? null,
          genres: hit ? [...hit.expansion.genres] : [],
          keywords: hit ? [...hit.expansion.keywords] : mood.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6),
          exclude: hit ? [...hit.expansion.exclude] : [],
        };
        // Set only on a miss. A hit needs no note; a miss needs one, because
        // `genres: []` is otherwise indistinguishable from "this mood has no
        // genre affinity", which is a claim the table never made.
        if (!hit) payload.note = 'No built-in row matched this mood; keywords are the mood words themselves.';
        return {
          content: [{ type: 'text' as const, text: render(mood, payload, format) }],
          structuredContent: payload,
        };
      }

      try {
        const { expansion, model, attempts } = await sampleExpansion(
          server,
          mood,
          args.max_tokens ?? 512,
        );
        const payload: Record<string, unknown> = {
          mood,
          source: 'sampling',
          model,
          attempts,
          matched: true,
          matched_key: null,
          genres: expansion.genres,
          keywords: expansion.keywords,
          exclude: expansion.exclude,
        };
        return {
          content: [{ type: 'text' as const, text: render(mood, payload, format) }],
          structuredContent: payload,
        };
      } catch (error) {
        if (error instanceof InvalidExpansion) return samplingFailed('expand_mood_to_queries', error.detail);
        // A transport-level failure (host refused, timeout, disconnected) is
        // not the same claim as a model that answered unusably, and it is
        // named as such rather than folded into it.
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text:
                `expand_mood_to_queries could not reach the host model for sampling: ${message}. ` +
                'The static map is not substituted here because a host that advertised sampling and then failed is a different situation from one that never offered it.',
            },
          ],
          structuredContent: {
            error: {
              tool: 'expand_mood_to_queries',
              kind: 'sampling_failed',
              reason: 'sampling_request_failed',
              fix: 'Check the host model configuration, or run the searches with your own keywords.',
            },
            detail: message.slice(0, 200),
            returned: null,
          },
          isError: true,
        };
      }
    },
  );
}
