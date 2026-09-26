/**
 * Issue #716: every prompt's described tool call must use real tool names and
 * real parameter names.
 *
 * Renders every registered prompt through the real MCP routing and parses each
 * body for tool mentions — both bare (`get_artist_top_tracks`) and call-form
 * (`show_new_episodes (days=7, per_show_limit=3, max_shows=25)`). Each named
 * tool must exist in the live tools/list registry; each named argument inside
 * parens must exist in the tool's inputSchema.properties.
 *
 * A parameter name that does not match the schema is a wasted turn for the
 * agent (Spotify returns 400) and a silent regression after any of these:
 *   - tool arguments get renamed (#596 already caught this for /search limits)
 *   - an endpoint is removed and a fallback does not update its parameter list
 *   - a 403-on-removed-endpoint hint is forgotten and the prompt re-prescribes
 *     the same dead call
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The registry pass, the non-tool allow-list and the prompt-text extraction
// all live in tests/live-registry.ts (#670). This file used to carry its own
// copies, which is the same second-hand-maintained-list problem it exists to
// catch: the two NON_TOOL sets had already drifted by one entry.
import {
  ARG_PATTERN,
  buildFullRegistryServer,
  collectToolSchemas,
  extractBody,
  promptSurface,
} from './live-registry.js';

// ---------------------------------------------------------------- fixtures

/** Rendered prompt body by prompt name, from the shared registry pass. */
async function renderAllPrompts(): Promise<Map<string, string>> {
  return (await promptSurface()).prompts;
}

// ---------------------------------------------------------------- tests

test('every prompt names real tools that exist in the registry (#716)', async () => {
  const schemas = collectToolSchemas(await buildFullRegistryServer());
  const rendered = await renderAllPrompts();
  assert.ok(rendered.size >= 14, `expected the full prompt registry, saw ${rendered.size}`);

  const missing: string[] = [];
  for (const [name, body] of rendered) {
    const { bareTools } = extractBody(body);
    for (const tool of bareTools) {
      if (!schemas.has(tool)) missing.push(`${name}: unknown tool '${tool}'`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `prompts reference tools that are not in tools/list:\n${missing.join('\n')}`,
  );
});

test('every prompt call-form argument is declared by the tool schema (#716)', async () => {
  const schemas = collectToolSchemas(await buildFullRegistryServer());
  const rendered = await renderAllPrompts();

  const badArgs: string[] = [];
  let checked = 0;
  for (const [name, body] of rendered) {
    const { calls } = extractBody(body);
    for (const { tool, args } of calls) {
      const props = schemas.get(tool);
      if (!props) continue; // covered by the bare-tool test
      for (const arg of args) {
        checked += 1;
        if (!props.has(arg)) badArgs.push(`${name}: ${tool}(${arg}=…) — '${arg}' not in ${tool} schema`);
      }
    }
  }
  // Without this the test passes on a regex that matches nothing.
  assert.ok(checked >= 4, `expected call-form argument matches across prompts, saw ${checked}`);
  assert.deepEqual(
    badArgs,
    [],
    `prompts name arguments their tool's inputSchema rejects:\n${badArgs.join('\n')}`,
  );
});

test('podcast_catchup prompt uses show_new_episodes parameter names (#716)', async () => {
  const rendered = await renderAllPrompts();
  const body = rendered.get('podcast_catchup');
  assert.ok(body, 'podcast_catchup should be registered');
  // show_new_episodes schema: days, per_show_limit, max_shows, cost_preview, ...
  assert.match(body, /\bshow_new_episodes\s*\(/, 'podcast_catchup must call show_new_episodes');
  const match = /\bshow_new_episodes\s*\(([^)]*)\)/.exec(body);
  assert.ok(match, 'show_new_episodes call has an argument list');
  const args = [...match[1].matchAll(ARG_PATTERN)].map((m) => m[1]);
  for (const required of ['days', 'per_show_limit', 'max_shows']) {
    assert.ok(args.includes(required), `podcast_catchup show_new_episodes call missing '${required}'`);
  }
  // The pre-fix prompts used 'since' and 'max_per_show'; either in a
  // call-form or echoed in prose means the fix has regressed.
  assert.doesNotMatch(body, /\bsince\s*=/, 'podcast_catchup must not name the invented `since` parameter');
  assert.doesNotMatch(body, /\bmax_per_show\b/, 'podcast_catchup must not name the invented `max_per_show` parameter');
});

test('music_briefing release-fetch path is get_followed_artists + get_artist_albums, not artist_release_digest alone (#716)', async () => {
  const rendered = await renderAllPrompts();
  const body = rendered.get('music_briefing');
  assert.ok(body, 'music_briefing should be registered');
  // artist_release_digest reads a local watchlist sidecar; it is NOT a
  // release-fetch tool from followed artists, so the prompt must steer the
  // agent at get_followed_artists + get_artist_albums instead.
  assert.match(body, /\bget_followed_artists\b/, 'music_briefing must name get_followed_artists for new releases');
  assert.match(body, /\bget_artist_albums\b/, 'music_briefing must name get_artist_albums for per-artist release enumeration');
  // artist_release_digest is mentioned as a sidecar-hint fallback so users
  // with a watchlist know about it, but it must NOT appear before
  // get_followed_artists in the prescription — i.e. the prompt's release
  // section opens with the followed-artists path.
  const followedPos = body.search(/\bget_followed_artists\b/);
  const digestPos = body.search(/\bartist_release_digest\b/);
  assert.ok(followedPos >= 0, 'get_followed_artists must appear');
  assert.ok(digestPos >= 0, 'artist_release_digest should be acknowledged as a sidecar fallback');
  assert.ok(
    followedPos < digestPos,
    `get_followed_artists must precede artist_release_digest in music_briefing, saw followedPos=${followedPos} digestPos=${digestPos}`,
  );
});

test('get_artist_top_tracks prompts carry a 403 / Feb 2026 fallback note (#716)', async () => {
  const rendered = await renderAllPrompts();
  for (const name of ['artist_deep_dive', 'crate_digging']) {
    const body = rendered.get(name);
    assert.ok(body, `${name} should be registered`);
    assert.match(body, /\bget_artist_top_tracks\b/, `${name} must name get_artist_top_tracks`);
    assert.match(
      body,
      /\b403\b/,
      `${name} must warn that get_artist_top_tracks may 403 (Feb 2026 endpoint removal)`,
    );
    assert.match(
      body,
      /\bFebruary 2026\b/,
      `${name} must cite the February 2026 removal as the reason for the fallback`,
    );
  }
});

test('migrate_library and triage_liked_songs check playlists with fetch_all=true (#716)', async () => {
  const rendered = await renderAllPrompts();
  for (const name of ['migrate_library', 'triage_liked_songs']) {
    const body = rendered.get(name);
    assert.ok(body, `${name} should be registered`);
    // Either the call-form `get_user_playlists (fetch_all=true)` or the prose
    // explanation is acceptable, but `fetch_all=true` must appear on the
    // get_user_playlists mention — a single-page walk would miss deeper names.
    const callPattern = /\bget_user_playlists\b[^.]*?\bfetch_all=true\b/s;
    assert.match(
      body,
      callPattern,
      `${name} must call get_user_playlists with fetch_all=true so a deeper name match is not missed`,
    );
  }
});
