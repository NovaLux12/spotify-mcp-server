#!/usr/bin/env node
/**
 * Documentation link guard (#931).
 *
 * Three cross-document references were reported broken at once, and two of the
 * three had already been fixed by the time this gate existed. That is the point
 * of writing it anyway: a defect class that is fixed once and never gated comes
 * back, and nothing in the tree could tell the difference. This gate makes the
 * class fail loudly instead.
 *
 *   1. **Relative Markdown links resolve.** Every `[text](target)` in a scanned
 *      document must name a file that exists, and any `#fragment` must match a
 *      heading in the file it points at. The original report was two orphaned
 *      `docs/` pages the README's index never named; `checkDocReachability()` in
 *      `scripts/surface-census.mjs` already covers the README-index half, and
 *      this covers the rest -- `docs/` pages linking each other, anchors inside
 *      a page, and the root documents linking into `docs/`.
 *
 *   2. **A heading named from source code exists.** `graceful403Message()` in
 *      `src/gating.ts` renders user-facing prose naming a README section, and
 *      that string is the only place a reader is told where to look after a 403.
 *      The census checked that README *has* a "Registration-gated endpoints"
 *      heading; nothing checked that the message points at it. Those are two
 *      independent strings that must agree, and the failure mode is the message
 *      sending a user after a section that was renamed -- verified real: with
 *      the message pointed at a nonexistent heading, `npm run count:tools --
 *      --check`, `check:doc-tool-names` and `check-no-explicit-any` all exited 0.
 *
 * Deliberately NOT checked, each for a reason that is not convenience:
 *
 *   - **Remote URLs.** `https://developer.spotify.com/...` resolves over the
 *     network. A gate that fetched them would be a flaky gate, and this repo's
 *     convention is that a citation names a URL a reader resolves by hand (the
 *     same rule `tests/source-citation-guard.test.ts` follows for the reverse
 *     direction).
 *   - **Reference-style definitions** (`[label]: url`). The only ones in the
 *     tree are `CHANGELOG.md`'s release-comparison URLs, all remote. An inline
 *     scanner that also resolved definitions would be resolving nothing.
 *   - **Anchors that GitHub generates for a heading the file does not have.**
 *     A bare `#fragment` with no file part is checked against the containing
 *     document, which is the only reading GitHub gives it.
 *
 * `--check-fixture <dir>` runs the same collector over one scratch directory, so
 * a test can plant a broken link and confirm the gate goes red rather than
 * assuming it would (AGENTS.md §6).
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Documents a reader is expected to follow links inside. */
const DOC_ROOTS = ['docs', 'skills'];
const ROOT_DOCS = ['README.md', 'SPEC.md', 'ARCHITECTURE.md', 'AGENTS.md', 'CONTRIBUTING.md'];

/**
 * A user-facing section name rendered by `graceful403Message()`.
 *
 * The message is the most frequently surfaced error in the server and it is the
 * only pointer a blocked caller gets. `checkGatedEndpointTruth()` already
 * requires README to carry a "Registration-gated endpoints" heading -- this
 * asserts the other half, that the rendered string names that same heading.
 */
const GATED_MESSAGE_SECTION = 'Registration-gated endpoints';

/**
 * GitHub's heading anchor: lowercase, drop everything that is not a word
 * character, space or hyphen, then each space becomes its own hyphen.
 *
 * Per-space, not per-run: "1. Goals & Non-Goals" is `#1-goals--non-goals`, and
 * collapsing the run to one hyphen made four real SPEC.md anchors look broken in
 * an earlier draft of this file. That is the exact reason the value is pinned
 * against a real anchor below rather than trusted.
 */
export function anchorSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Every anchor the document publishes: its ATX headings, plus explicit `<a id>`. */
export function anchorsOf(source) {
  const anchors = new Set();
  for (const match of source.matchAll(/^#{1,6}\s+(.*)$/gm)) {
    // Inline code is not part of the rendered text, so it is not part of the
    // anchor: "Disconnecting: `spotify-mcp logout`" anchors without the backticks.
    anchors.add(anchorSlug(match[1].replace(/`/g, '')));
  }
  for (const match of source.matchAll(/<a\s+(?:name|id)="([^"]+)"/gi)) anchors.add(match[1]);
  return anchors;
}

/**
 * An inline link or image, with its optional title stripped.
 *
 * `[^)\s]+` cannot span the closing paren, so a destination containing one
 * (`(foo(bar))`) would be mis-parsed; no link in the tree needs that, and
 * widening it risks matching across a sentence. Angle-bracket destinations are
 * unwrapped instead, which is the form a path with a space takes.
 */
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) files.push(...walk(file));
    else files.push(file);
  }
  return files;
}

export function scannedDocs(root = ROOT) {
  const files = [
    ...ROOT_DOCS.map((name) => join(root, name)),
    ...DOC_ROOTS.flatMap((dir) => (existsSync(join(root, dir)) ? walk(join(root, dir)) : [])),
  ];
  return files.filter((file) => file.endsWith('.md') && existsSync(file)).sort();
}

/**
 * Every relative link in `source` that does not resolve.
 *
 * `docDir` is the directory the links in `source` are relative to; the anchors
 * of a target file are read from disk, so the check is over real headings rather
 * than a list the gate maintains.
 */
export function findBrokenLinks(source, docFile, docDir, root = ROOT) {
  const broken = [];
  for (const match of source.matchAll(LINK)) {
    const target = match[1];
    // Remote (any `scheme:`) and protocol-relative targets are resolved over
    // the network, not from the tree, so they are out of scope by design. A bare
    // `#frag` is not: it names a heading in this same document, and GitHub
    // resolves it there.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const [path, fragment] = target.split('#');
    const line = source.slice(0, match.index).split('\n').length;
    if (path === '') {
      if (fragment === undefined) continue;
      if (!anchorsOf(source).has(fragment.toLowerCase())) {
        broken.push(`${docFile}:${line}  ->  ${target}  (no such heading in this document)`);
      }
      continue;
    }
    const resolvedPath = resolve(docDir, path);
    if (!existsSync(resolvedPath)) {
      broken.push(`${docFile}:${line}  ->  ${target}  (no such file)`);
      continue;
    }
    if (fragment === undefined || fragment === '') continue;
    if (!resolvedPath.endsWith('.md')) continue;
    if (!anchorsOf(readFileSync(resolvedPath, 'utf8')).has(fragment.toLowerCase())) {
      broken.push(`${docFile}:${line}  ->  ${target}  (no such heading in ${relative(root, resolvedPath)})`);
    }
  }
  return broken;
}

/** Every broken relative link across the scanned documents. */
export function findBrokenDocLinks(root = ROOT) {
  const broken = [];
  for (const file of scannedDocs(root)) {
    broken.push(...findBrokenLinks(readFileSync(file, 'utf8'), relative(root, file), dirname(file), root));
  }
  return broken;
}

/**
 * Everything wrong with a 403 message that points somewhere a reader cannot go.
 *
 * Takes the RENDERED message and the README it points at, rather than reading
 * either itself. Two reasons, both learned the hard way in this file's own
 * first draft:
 *
 *   - A check that re-typed the section title would be asserting against its
 *     own transcription (AGENTS.md §6). Here the title arrives in the string
 *     the server actually shows a blocked caller.
 *   - Taking both inputs as arguments is what lets a test drive this function
 *     with a message pointed at a section that does not exist. A version that
 *     imported `graceful403Message()` internally could only ever be exercised
 *     against the shipped message, so neutering it to `return []` left all
 *     fourteen tests green -- a guard proven not to bite.
 */
export function gatedMessageErrors(rendered, readmeSource) {
  const readmeAnchors = anchorsOf(readmeSource);
  const errors = [];
  if (!readmeAnchors.has(anchorSlug(GATED_MESSAGE_SECTION))) {
    errors.push(`README.md: has no heading "${GATED_MESSAGE_SECTION}", which the 403 message sends readers to`);
  }
  // The message names the section twice -- as prose and as an anchor. Both are
  // checked, because either one alone can be the half that drifts.
  const cited = [...rendered.matchAll(/README\.md#([\w-]+)/g)].map((match) => match[1]);
  if (cited.length === 0) {
    errors.push('src/gating.ts: graceful403Message() no longer names a README anchor, so a blocked caller is sent nowhere');
  }
  for (const anchor of cited) {
    if (!readmeAnchors.has(anchor.toLowerCase())) {
      errors.push(`src/gating.ts: graceful403Message() points at README.md#${anchor}, which is not a heading in README.md`);
    }
  }
  if (!rendered.includes(GATED_MESSAGE_SECTION)) {
    errors.push(`src/gating.ts: graceful403Message() does not name the "${GATED_MESSAGE_SECTION}" section in its prose`);
  }
  return errors;
}

/**
 * `gatedMessageErrors` over the real message and the real README.
 *
 * The message is imported and CALLED, so a rename in `src/gating.ts` is what
 * this sees -- the string is assembled from concatenated literals and there is
 * no exported constant to compare against.
 */
export async function checkGatedMessageTarget() {
  const { graceful403Message } = await import('../src/gating.ts');
  const { SpotifyApiError } = await import('../src/client.ts');
  const rendered = graceful403Message('/markets', new SpotifyApiError(403, 'Forbidden'));
  return gatedMessageErrors(rendered, readFileSync(join(ROOT, 'README.md'), 'utf8'));
}

const fixtureIndex = process.argv.indexOf('--check-fixture');
if (fixtureIndex >= 0) {
  const fixtureDir = resolve(process.argv[fixtureIndex + 1] ?? '');
  if (!existsSync(fixtureDir)) throw new Error(`--check-fixture requires a directory, got ${fixtureDir}`);
  const broken = [];
  for (const file of walk(fixtureDir).filter((name) => name.endsWith('.md')).sort()) {
    broken.push(...findBrokenLinks(readFileSync(file, 'utf8'), relative(fixtureDir, file), dirname(file), fixtureDir));
  }
  for (const error of broken) console.error(error);
  process.exit(broken.length > 0 ? 1 : 0);
}

/**
 * Run the gate. Only when this file is the entry point.
 *
 * `tests/doc-links.test.ts` imports `findBrokenLinks` and `anchorSlug` from
 * here. Without this guard the module body ran on import, printed its own
 * verdict and called `process.exit(0)` — which ended the test process during
 * module loading, so the file reported `tests 1, pass 1` and none of the cases
 * below had executed. A green run that ran nothing is the exact outcome
 * AGENTS.md §6 warns about, reached the boring way.
 */
async function main() {
  const errors = findBrokenDocLinks();
  errors.push(...await checkGatedMessageTarget());
  for (const error of errors) console.error(error);
  if (errors.length === 0) {
    console.error(`doc links: ${scannedDocs().length} documents, every relative link and heading target resolves`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}

// `realpathSync` on both sides so a symlinked checkout (or tsx's resolved
// module URL) still compares equal and does not re-enter main on import.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
