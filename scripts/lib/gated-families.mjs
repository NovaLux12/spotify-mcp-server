/**
 * Load `GATED_FAMILIES` from the BUILT server, for the live gate harnesses.
 *
 * #645: `scripts/tool-gate-check.mjs` kept its own 8-name candidate list, and
 * that list had drifted to the point where two of its names did not exist and
 * two more were unreachable on a default toolset. The authoritative list is
 * `GATED_FAMILIES` in `src/gating.ts` — already the single source the README
 * table, the #330 gauntlet SKIP set and the surface census read — so this
 * module reads THAT rather than restating it.
 *
 * ## Why the BUILT `dist/gating.js` and not `src/`
 *
 * Same rule `scripts/lib/preflight.mjs` and `scripts/hermetic-home.mjs` already
 * follow for the store registry: the harness is about to spawn the
 * `dist/index.js` out of this tree, so the classification it reasons about must
 * be the one that build ships. Reading `src/gating.ts` would let a harness
 * report against a source file that has not been compiled, or that no longer
 * matches the build.
 *
 * It is an ESM import of a compiled `.js`, which is why a missing build is a
 * named error here rather than an `ERR_MODULE_NOT_FOUND` stack: the harness has
 * nothing to check if the tree it would inspect does not exist, and saying so
 * is the difference between a cause and a symptom.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {object} [options]
 * @param {string} [options.root]  Repo root; defaults to this file's parent's parent.
 * @param {string} [options.distRoot] Override for the build to read. Defaults to
 *   `$SPOTIFY_MCP_DIST_ROOT` or `<root>/dist`, matching `hermetic-home.mjs`.
 * @returns {Promise<ReadonlyArray<{id: string, tools: readonly string[], fallback: string, reason: string}>>}
 * @throws when the build is absent or does not export the table.
 */
export async function loadGatedFamilies({ root, distRoot } = {}) {
  const repoRoot = root ?? new URL('../..', import.meta.url).pathname;
  const dist = distRoot ?? process.env.SPOTIFY_MCP_DIST_ROOT ?? join(repoRoot, 'dist');
  const gating = join(dist, 'gating.js');

  if (!existsSync(gating)) {
    throw new Error(
      `tool-gate-check: no built gated-family table at ${gating} — run \`npm run build\` first. `
      + 'The candidate list is derived from the build, so there is nothing to check without it.',
    );
  }

  const mod = await import(pathToFileURL(gating).href);
  const families = mod.GATED_FAMILIES;
  if (!Array.isArray(families) || families.length === 0) {
    throw new Error(
      `tool-gate-check: ${gating} does not export a non-empty GATED_FAMILIES. `
      + 'A build that lost the table would otherwise yield an empty candidate list and a green run.',
    );
  }
  return families;
}
