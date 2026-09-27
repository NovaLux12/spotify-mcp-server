/**
 * No comment under `src/` may cite a repo path that does not exist (#1260).
 *
 * The header of `src/gating.ts` cited a probe artefact as the evidence for
 * the entire registration-gated error contract -- the runtime classification
 * of eight endpoint families, three of which shipped tools call. The file was
 * not in the repository and never was: `.gitignore` excludes `memory/*` apart
 * from three whitelisted sweep reports, so the probe wrote its result to a
 * path git silently dropped, and the comment kept pointing at it.
 *
 * A citation a reader cannot follow is worse than no citation, because a
 * reader trusts it and does not check. It is also the failure AGENTS.md §2
 * names -- a family listed as "verified operational" that "was true when
 * written and false within months" -- with the evidence removed and nobody
 * able to notice.
 *
 * Scope. Only *directory-qualified* paths with a source extension are checked.
 * A bare `catalog.ts` is ambiguous (any sibling module could be meant) and is
 * left alone; `tools/catalog.ts`, `scripts/surface-census.mjs` and
 * `docs/faq.md` are unambiguous claims about a file in this repository, and
 * those must resolve. Resolution tries the repo root, `src/`, the citing
 * file's own directory and its parent, which is how a human reads these
 * comments.
 *
 * Deliberate exclusions, each for a reason that is not "it was inconvenient":
 *
 *   - URLs. `https://developer.spotify.com/...yaml` is a citation too, but it
 *     resolves over the network and is checked by reading, not by stat().
 *   - `~/...` paths. The sidecar files under `~/.spotify-mcp/` are user state
 *     that is *supposed* to live outside the repository. Demanding they be
 *     committed would be demanding the opposite of correct.
 *   - `.js` specifiers. `./backup.js` and `../refs.js` are compiled ESM import
 *     specifiers; the source file is `.ts`.
 *   - Comments. The guard is about what a comment asserts. `gating.ts` names
 *     the removed artefact in prose to explain why it was removed, and that
 *     sentence is not a live citation.
 *
 * Run: node --import tsx --test tests/source-citation-guard.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { scanFile, walkTypeScriptFiles } from './ts-source-scan.js';

const REPO_ROOT = process.cwd();

/**
 * A directory-qualified path ending in a source extension.
 *
 * `.js` is absent on purpose (compiled specifiers); a leading `./` or `../`
 * is allowed and is resolved relative to the citing file.
 */
const CITED_PATH = /(?<![\w:/-])((?:\.\.\/|\.\/)?[\w.-]+\/[\w./-]*[\w-]+\.(?:ts|mjs|json|md))(?!\w)/g;

type Dangling = { path: string; line: number; cited: string };

/**
 * Resolve a cited path the way a reader would: against the repository root,
 * `src/`, the citing file's directory, and that directory's parent.
 */
export function resolvesToRepoFile(cited: string, citingFile: string): boolean {
  const bases = [REPO_ROOT, join(REPO_ROOT, 'src'), dirname(join(REPO_ROOT, citingFile)), dirname(dirname(join(REPO_ROOT, citingFile)))];
  return bases.some((base) => existsSync(resolve(base, cited)));
}

/**
 * True when the match is part of a URL, or names user state outside the repo.
 *
 * `at` is the match offset in `comment`, because the `~/` prefix is not
 * captured. The pattern starts one character *after* the dot -- for
 * `~/.spotify-mcp/scenes.json` the lookbehind rejects a start on the dot (it
 * follows a `/`) and accepts one on `s`, so the match begins with
 * `spotify-mcp/` and the text in front of it is `~/.`. Home-anchoring
 * therefore has to be read off the preceding characters, not off the capture.
 */
function isExcluded(cited: string, at: number, comment: string): boolean {
  if (cited.startsWith('~/')) return true;
  const before = comment.slice(0, at);
  // `~`, `~/` or `~/.` immediately in front of the match: a home-relative path.
  if (/~\/?\.?$/.test(before.slice(-3))) return true;
  return /:\/\/\S*$/.test(before);
}

/** Every directory-qualified source path cited in a `src/` comment that does not resolve. */
export function findDanglingCitations(root = 'src'): Dangling[] {
  const dangling: Dangling[] = [];
  for (const rel of walkTypeScriptFiles(root)) {
    const file = scanFile(rel);
    for (const comment of file.comments) {
      for (const match of comment.matchAll(CITED_PATH)) {
        const cited = match[1];
        if (isExcluded(cited, match.index, comment)) continue;
        if (resolvesToRepoFile(cited, rel)) continue;
        dangling.push({ path: rel, line: lineOfComment(file.source, comment), cited });
      }
    }
  }
  return dangling;
}

function lineOfComment(source: string, comment: string): number {
  return source.slice(0, source.indexOf(comment)).split('\n').length;
}

describe('source-citation guard (#1260)', () => {
  it('ships no src/ comment citing a path that is not in the repository', () => {
    const dangling = findDanglingCitations();
    assert.deepEqual(
      dangling,
      [],
      `Comments cite files that do not exist. A citation a reader cannot follow is worse than none, because a reader trusts it and does not check (#1260):\n${dangling
        .map((d) => `  ${d.path}:${d.line}  ->  ${d.cited}`)
        .join('\n')}`,
    );
  });

  it('scans a real surface, and resolves real citations', () => {
    // Proves the walk found the right files and that citations are actually
    // being resolved -- otherwise an empty result would be indistinguishable
    // from a regex that matches nothing. Named files rather than a hardcoded
    // count, so the assertion keeps its meaning as the tree grows.
    const files = walkTypeScriptFiles('src');
    for (const expected of ['src/gating.ts', 'src/toolsets.ts', 'src/tools/taste_composites.ts', 'src/client.ts']) {
      assert.ok(files.includes(expected), `expected ${expected} in the scanned set (${files.length} files)`);
    }
    assert.ok(files.length > 50, `expected the real src/ tree, saw only ${files.length} files`);

    // A citation that is live in the tree today and must stay live.
    assert.ok(
      resolvesToRepoFile('scripts/surface-census.mjs', 'src/tools/annotations.ts'),
      'scripts/surface-census.mjs is a live citation and must resolve',
    );
    assert.ok(
      resolvesToRepoFile('tools/catalog.ts', 'src/markets.ts'),
      'a src/tools/ relative citation must resolve',
    );
  });

  it('flags the exact citation #1260 removed, so the detector can fire', () => {
    // Verbatim from the old header. If this stops being flagged, the guard
    // above has been silently disarmed (AGENTS.md §6).
    const historical = ' * app-registration-gated endpoint family (probed 2026-08-26,\n * memory/edge-probe-2026-08-26.json).\n';
    const found = [...historical.matchAll(CITED_PATH)]
      .filter((m) => !isExcluded(m[1], m.index, historical))
      .map((m) => m[1]);
    assert.deepEqual(found, ['memory/edge-probe-2026-08-26.json']);
    assert.equal(
      resolvesToRepoFile('memory/edge-probe-2026-08-26.json', 'src/gating.ts'),
      false,
      'the removed artefact must not resolve, or the guard proves nothing',
    );
  });

  it('excludes URLs and user state outside the repository, for stated reasons', () => {
    const url = 'see https://developer.spotify.com/documentation/web-api/references/changes/february-2026 for the removals';
    for (const m of url.matchAll(CITED_PATH)) {
      assert.ok(isExcluded(m[1], m.index, url), `a URL path must not be checked as a repo file: ${m[1]}`);
    }
    const home = 'the sidecar lives at ~/.spotify-mcp/scenes.json at runtime';
    for (const m of home.matchAll(CITED_PATH)) {
      assert.ok(isExcluded(m[1], m.index, home), `a ~ path must not be checked as a repo file: ${m[1]}`);
    }
    // And the real ones in the tree are genuinely excluded rather than absent.
    const scenes = scanFile('src/tools/scenes.ts');
    assert.ok(
      scenes.comments.some((c) => c.includes('~/.spotify-mcp/scenes.json')),
      'expected the documented user-state citation to still be present',
    );
  });
});
