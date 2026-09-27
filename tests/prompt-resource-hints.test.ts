import './helpers/hermetic.js';

/**
 * #715 — a prompt must not advertise a resource the server, as configured,
 * will not serve.
 *
 * ## The defect
 *
 * `prompts` and `resources` are INDEPENDENT toolsets (`src/toolsets.ts`), so a
 * host may serve the whole prompt surface with no resources registered at all
 * — `SPOTIFY_MCP_TOOLSETS=prompts` is enough, and so are
 * `SPOTIFY_MCP_ENABLE_TOOLS=prompts` and `SPOTIFY_MCP_DISABLE_TOOLS=resources`.
 * Measured on the compiled server before this fix (see
 * `src/prompts/index.ts` for the derivation), those three are the ONLY
 * mechanisms that produce the hazard: `moduleBlockedByScopes` is false for
 * `resources` and `prompts` under every grant (neither appears in
 * `WRITE_SCOPE_REQUIREMENTS`), and neither is in `REGISTRAR_MANIFEST`, so
 * `SPOTIFY_MCP_READONLY` cannot remove them either.
 *
 * Before this fix, three prompt bodies named `spotify://` URIs
 * unconditionally, and twelve of the fourteen prompts share a footer that names
 * one. In a trimmed configuration every one of those hints resolved to nothing —
 * and a hint that points at nothing is worse than no hint, because the agent
 * routes work toward it and then finds an absence it cannot explain. This is
 * `AGENTS.md` §6: a correctly named payload field can still lie about its
 * value.
 *
 * ## What the degraded hint says instead
 *
 * Not a resource, and not a tool: the 429 the agent is ALREADY holding. The tool
 * error boundary maps a 429 to `kind: 'rate_limited'` and puts the parsed
 * `Retry-After` in both the message text and `structuredContent.error.retryAfterSec`
 * (`src/tools/annotations.ts`), so the guidance is actionable with no second
 * surface reachable. A tool name was rejected deliberately: every tool module
 * sits behind its own toolset key, so naming one would reproduce this exact
 * defect one level down.
 *
 * ## Why the enumeration is asserted, not indexed
 *
 * A previous regression test in this repo passed at HEAD because
 * `const [x] = findAll(...)` bound the wrong element. Every test below compares
 * the FULL SET of `spotify://` occurrences and the FULL prompt enumeration, so a
 * test that binds one element cannot pass while another still names a URI.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { findUndeclaredPromptArgs, findUnknownPromptTools, promptSurface } from './live-registry.js';
import { StdioJsonRpcChild, hermeticServerEnv } from './helpers/stdio-child.js';

const REPO_ROOT = join(import.meta.dirname, '..');

/**
 * The complete prompt surface, hand-listed. Every prompt is here, so a new
 * prompt cannot join the surface without this test noticing that the degraded
 * assertions below cover it too.
 */
const ALL_PROMPTS = [
  'artist_deep_dive',
  'crate_digging',
  'discover_weekly_alternative',
  'dj',
  'listening_recap',
  'migrate_library',
  'morning_briefing',
  'music_briefing',
  'music_taste_summary',
  'playlist_audit',
  'playlist_from_mood',
  'podcast_catchup',
  'triage_liked_songs',
  'weekly_digest',
];

/** Every `spotify://` URI a prompt may name when resources ARE registered. */
const KNOWN_RESOURCE_URIS = new Set([
  'spotify://me/rate-limit',
  'spotify://me/top/artists',
  'spotify://me/top/tracks',
]);

/**
 * Every `spotify://` occurrence in a rendered body, in document order.
 *
 * Returned whole rather than as a `findAll(...)[0]`: a positional destructure is
 * how a test ends up asserting against the wrong element and passing anyway.
 * `spotify://me/top/tracks?time_range=short_term&limit=5` is returned as its
 * full form so a query-string variant cannot slip past an equality check on the
 * bare path.
 */
function resourceUris(body: string): string[] {
  // Stops at whitespace and at every character that can only be punctuation in
  // these bodies — including `.`, which the resource sentences end on. Leaving
  // it in produced `spotify://me/rate-limit.` and a false "not a resource".
  return [...body.matchAll(/spotify:\/\/[^\s'";,.)]+/g)].map((m) => m[0]);
}

/** The three prompts that named a resource in prose of their own, before #715. */
const PROMPTS_WITH_OWN_RESOURCE_PROSE = ['artist_deep_dive', 'dj', 'music_taste_summary'];

// ---------------------------------------------------------------------------
// The trimmed configuration — the one the issue is about
// ---------------------------------------------------------------------------

test('#715: with the resources module trimmed, NO prompt names a spotify:// URI', async () => {
  const surface = await promptSurface({ resourceHints: false });

  // The full enumeration, so this cannot pass by asserting one prompt.
  assert.deepEqual([...surface.prompts.keys()].sort(), ALL_PROMPTS, 'the whole prompt surface must be covered');

  const offenders: string[] = [];
  for (const [name, body] of surface.prompts) {
    for (const uri of resourceUris(body)) offenders.push(`${name}: ${uri}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these prompts advertise a resource in a configuration that registers none. '
      + 'A hint that resolves to nothing is worse than no hint: the agent routes work toward it and '
      + 'finds an absence it cannot explain. Degrade the hint, do not delete the guidance.',
  );
});

test('#715: the trimmed prompts are DEGRADED, not silent', async () => {
  const surface = await promptSurface({ resourceHints: false });

  // Twelve prompts share the footer, so this is where the guidance lives.
  const dj = surface.prompts.get('dj');
  assert.ok(dj, 'dj must be present');
  assert.match(
    dj,
    /structuredContent\.error\.retryAfterSec/,
    'the degraded rate-limit clause must name the mechanism that survives the trim: the 429 the '
      + 'agent is already holding. Deleting the sentence would leave the agent with no wait guidance.',
  );

  // The three prompts with their own resource prose must have lost it too.
  for (const name of PROMPTS_WITH_OWN_RESOURCE_PROSE) {
    const body = surface.prompts.get(name);
    assert.ok(body, `${name} must be present`);
    assert.ok(
      /retryAfterSec|structuredContent/.test(body),
      `${name} had a bespoke resource sentence; the degraded form must still say where the wait is`,
    );
  }

  // The music_taste_summary shortcut is REPLACED, not dropped: the agent still
  // wants a cheap snapshot, and get_top_tracks is a tool, so a `resources` trim
  // cannot remove it. Its args are named in the tool's own vocabulary, so the
  // call survives the undeclared-argument gate below.
  const summary = surface.prompts.get('music_taste_summary');
  assert.ok(summary, 'music_taste_summary must be present');
  assert.match(
    summary,
    /get_top_tracks \(time_range=medium_term, limit=20\)/,
    'the zero-tool-call resource shortcut must degrade to the equivalent tool call, not disappear',
  );
});

test('#715: the trimmed prompts still name only real tools and declared arguments', async () => {
  const surface = await promptSurface({ resourceHints: false });
  assert.deepEqual(findUnknownPromptTools(surface), [], 'degraded text must not invent a tool name');
  assert.deepEqual(
    findUndeclaredPromptArgs(surface),
    [],
    'the replacement shortcut must name arguments get_top_tracks actually declares',
  );
});

// ---------------------------------------------------------------------------
// The default configuration — the degradation must not leak into it
// ---------------------------------------------------------------------------

test('#715: with resources registered, the resource hints are unchanged and complete', async () => {
  const surface = await promptSurface({ resourceHints: true });

  assert.deepEqual([...surface.prompts.keys()].sort(), ALL_PROMPTS);

  const seen = new Set<string>();
  for (const [name, body] of surface.prompts) {
    for (const occurrence of resourceUris(body)) {
      // A query string is part of a valid hint (`…/top/tracks?time_range=…`
      // is a parameterised read of a resource this server does register), so
      // the check is on the BASE URI. `resourceUris` returns the whole
      // occurrence precisely so a query form cannot be mistaken for a bare one.
      const base = occurrence.split('?')[0];
      assert.ok(
        KNOWN_RESOURCE_URIS.has(base),
        `${name} names ${occurrence}, whose base ${base} is not a resource this server registers`,
      );
      seen.add(base);
    }
  }
  // The full set, not one of the three: if a future change degraded the default
  // surface, this is where it shows.
  assert.deepEqual(
    [...seen].sort(),
    [...KNOWN_RESOURCE_URIS].sort(),
    'the default surface must still name every resource hint it did before',
  );
});

test('#715: the degradation is confined to the prompts that named a resource', async () => {
  const withResources = await promptSurface({ resourceHints: true });
  const without = await promptSurface({ resourceHints: false });

  // These two never carried the shared footer and never named a resource of
  // their own, so they are SUPPOSED to render byte-identically in both
  // configurations. Asserting they change would be asserting the bug.
  const PROMPTS_WITH_NO_RESOURCE_CLAUSE = ['music_briefing', 'triage_liked_songs'];
  for (const name of PROMPTS_WITH_NO_RESOURCE_CLAUSE) {
    assert.equal(
      withResources.prompts.get(name),
      without.prompts.get(name),
      `${name} never named a resource, so trimming resources must not alter it`,
    );
  }

  // Every other prompt is compared, not one. The footer is shared by twelve of
  // them, so a partial comparison would miss most of the surface by
  // construction.
  const changed = ALL_PROMPTS
    .filter((name) => !PROMPTS_WITH_NO_RESOURCE_CLAUSE.includes(name))
    .filter((name) => withResources.prompts.get(name) !== without.prompts.get(name));
  assert.deepEqual(
    changed.sort(),
    ALL_PROMPTS.filter((n) => !PROMPTS_WITH_NO_RESOURCE_CLAUSE.includes(n)).sort(),
    'every prompt carrying a resource clause must render differently when resources are absent',
  );
});

// ---------------------------------------------------------------------------
// The wiring — is `resourceHints` derived from the configuration, or hard-coded?
// ---------------------------------------------------------------------------

/**
 * Spawn a real server under a given env and render one prompt from it.
 *
 * The in-process tests above pass `resourceHints` by hand, which means they
 * cannot see whether `src/index.ts` passes the RIGHT value — a hard-coded
 * `true` would leave every one of them green. This boots the actual entry point.
 */
async function renderFromServer(env: Record<string, string | undefined>, prompt: string): Promise<string> {
  const child = StdioJsonRpcChild.spawn({
    label: `#715 ${JSON.stringify(env)}`,
    command: 'node',
    args: ['--import', 'tsx/esm', 'src/index.ts'],
    cwd: REPO_ROOT,
    env: hermeticServerEnv(env, 'p715').env,
  });
  try {
    await child.initialize('p715');
    const res = await child.request('prompts/get', { name: prompt, arguments: { artist: 'x' } });
    assert.equal(res.error, undefined, `prompts/get ${prompt} failed: ${JSON.stringify(res.error)}`);
    const messages = (res.result as { messages?: Array<{ content: { text?: string } }> }).messages ?? [];
    return messages.map((m) => m.content.text ?? '').join('\n');
  } finally {
    await child.dispose();
  }
}

test('#715: SPOTIFY_MCP_TOOLSETS=prompts serves prompts whose hints are degraded', async () => {
  const body = await renderFromServer({ SPOTIFY_MCP_TOOLSETS: 'prompts' }, 'artist_deep_dive');
  assert.deepEqual(
    resourceUris(body),
    [],
    'a server started with TOOLSETS=prompts registers no resources, so its prompts must not name one',
  );
  assert.match(body, /retryAfterSec/, 'and the degraded clause must point at the 429 the call carries');
});

test('#715: a resources override is enough to degrade the prompts too', async () => {
  // The other measured mechanism. `all` plus a per-key disable is a completely
  // different code path from a set-level trim, and it produces the same hazard.
  const body = await renderFromServer(
    { SPOTIFY_MCP_TOOLSETS: 'all', SPOTIFY_MCP_DISABLE_TOOLS: 'resources' },
    'artist_deep_dive',
  );
  assert.deepEqual(resourceUris(body), [], 'DISABLE_TOOLS=resources must degrade the prompt hints too');
  assert.match(body, /retryAfterSec/);
});

test('#715: the default server still names the rate-limit resource', async () => {
  const body = await renderFromServer({}, 'artist_deep_dive');
  assert.ok(
    resourceUris(body).includes('spotify://me/rate-limit'),
    'the DEFAULT configuration registers resources, so its prompts must still name them — '
      + 'the degradation is confined to the trimmed configuration',
  );
});
