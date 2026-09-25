/**
 * Issue #871, acceptance criterion 2: a grep guard asserting that no playlist
 * tool can widen an EXISTING playlist's visibility without going through the
 * shared elicitation gate.
 *
 * The bypass this closes was silent precisely because the guard lived on ONE
 * tool: `playlist_collab_toggle` could widen visibility with no prompt while
 * `update_playlist` — the tool the privacy rationale (#157) is written about —
 * prompted correctly. A per-tool behavioral test cannot catch that class of
 * regression, so this asserts the structural invariant across the whole
 * `src/tools/` tree instead, the same source-text evidence pattern
 * `tests/mutations.conformance.test.ts:112-116` uses.
 *
 * Scope is deliberately narrow. "Widening visibility" means PUTting a
 * `public`/`collaborative` flag to the playlist METADATA endpoint
 * (`PUT /playlists/{id}`). Deliberately NOT counted:
 *
 *   - creation (`create_playlist` / `copy_playlist` POST `/me/playlists`): the
 *     playlist has no prior visibility to widen;
 *   - `pin_playlist` (playlistmisc.ts:97), which PUTs `public` to
 *     `/playlists/{id}/followers` — that is the FOLLOWER's visibility, the
 *     caller's own follow state, not the playlist's;
 *   - item/image rewrites (`PUT /playlists/{id}/items`, `/images`), which carry
 *     no visibility flags at all.
 *
 * Run: node --import tsx --test tests/tools.playlist-visibility-grep.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A tool registration starts here; its name is the first string argument. */
const REGISTRATION = /server\.(?:tool|registerTool)\(\s*\n?\s*['"]([^'"]+)['"]/g;

/** The tool takes a caller-supplied visibility flag. */
const VISIBILITY_PARAM = /\b(?:public|collaborative)\s*:\s*z\.boolean/;

/** A PUT aimed at the playlist metadata endpoint itself. */
const PUT_PLAYLIST_METADATA =
  /client\.put(?:<[^>]*>)?\(\s*`\/playlists\/\$\{[^`]*?\}`(?!\$\{[^}]*\}\s*(?:`?\/)?(followers|items|images))/;

/** The gate every such write must route through. */
const GATE = 'confirmViaElicitation';

export function registrationChunks(src: string): Array<{ name: string; chunk: string }> {
  const matches = [...src.matchAll(REGISTRATION)];
  return matches.map((match, i) => ({
    name: match[1]!,
    chunk: src.slice(match.index!, i + 1 < matches.length ? matches[i + 1]!.index! : src.length),
  }));
}

export function widensVisibility(chunk: string): boolean {
  return VISIBILITY_PARAM.test(chunk) && PUT_PLAYLIST_METADATA.test(chunk);
}

function playlistToolSources(): Array<{ file: string; src: string }> {
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools');
  return readdirSync(toolsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, src: readFileSync(join(toolsDir, f), 'utf8') }));
}

describe('#871 grep guard: existing-playlist visibility writes are gated', () => {
  it('the detector flags an ungated visibility write and clears a gated one', () => {
    // Non-vacuity: if `widensVisibility` could not tell these apart, the
    // invariant below would pass on every tree, including the broken one.
    const ungated = `
      server.tool('x', 'd', { playlist_id: z.string(), public: z.boolean().optional() }, async (a) => {
        await client.put(\`/playlists/\${id}\`, { public: a.public });
      });
    `;
    const gated = `
      server.tool('x', 'd', { playlist_id: z.string(), public: z.boolean().optional() }, async (a) => {
        await confirmViaElicitation(server, { message: 'm' });
        await client.put(\`/playlists/\${id}\`, { public: a.public });
      });
    `;
    assert.equal(widensVisibility(ungated), true);
    assert.equal(widensVisibility(gated), true);
    assert.ok(!ungated.includes(GATE), 'the ungated fixture must not contain the gate');
    assert.ok(gated.includes(GATE));
  });

  it('ignores creation, follower-visibility, and item rewrites', () => {
    // Creation POSTs rather than PUTs, so the playlist has no prior visibility.
    assert.equal(
      widensVisibility(
        "server.tool('create_playlist', 'd', { public: z.boolean(), collaborative: z.boolean() }, " +
          "async () => { await client.post('/me/playlists', { public: true }); });",
      ),
      false,
    );
    // pin_playlist writes the CALLER's follow state, not the playlist's flags.
    assert.equal(
      widensVisibility(
        "server.tool('pin_playlist', 'd', { public: z.boolean().optional() }, async (a) => { " +
          'await client.put(`/playlists/${id}/followers`, { public: a.public }); });',
      ),
      false,
    );
    // An item rewrite carries no visibility flag.
    assert.equal(
      widensVisibility(
        "server.tool('playlist_sort', 'd', { public: z.boolean() }, async () => { " +
          'await client.put(`/playlists/${id}/items`, { uris: [] }); });',
      ),
      false,
    );
  });

  it('every tool that widens an existing playlist goes through the gate', () => {
    const ungated = playlistToolSources()
      .flatMap(({ file, src }) =>
        registrationChunks(src)
          .filter(({ chunk }) => widensVisibility(chunk) && !chunk.includes(GATE))
          .map(({ name }) => `${file}: ${name}`),
      );
    assert.deepEqual(
      ungated,
      [],
      `playlist visibility writes that bypass ${GATE}: ${ungated.join(', ')}`,
    );
  });

  it('finds both known visibility writers, so the guard is not matching nothing', () => {
    // A literal expectation, not a value recomputed from the tree: if a future
    // refactor made every chunk stop matching, this fails loudly instead of
    // letting the invariant above pass vacuously.
    const found = playlistToolSources()
      .flatMap(({ src }) =>
        registrationChunks(src)
          .filter(({ chunk }) => widensVisibility(chunk))
          .map(({ name }) => name),
      )
      .sort();
    assert.deepEqual(found, ['playlist_collab_toggle', 'update_playlist']);
  });
});
