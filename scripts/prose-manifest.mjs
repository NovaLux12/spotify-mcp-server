/**
 * Hand-written prose integrity (#1384).
 *
 * `ARCHITECTURE.md` interleaves hand-written prose with generated blocks.
 * `writeBlock()` is marker-bounded, so `--write` can only ever replace what sits
 * between a BEGIN/END pair — but a *human* resolving a rebase conflict in that
 * file can take a whole side with `--ours` or `--theirs`, and because the
 * prose the losing side carried was never between markers, the generator has
 * no copy of it and no gate has a claim on it. The result is a document that
 * has silently lost a section of documentation, with `count:tools -- --check`
 * and `check:doc-tool-names` both green.
 *
 * That is what happened during #1350. It was caught only because an agent
 * diffed its own commit, saw a hunk it could not explain, and investigated.
 * That is diligence, not a process.
 *
 * ## Why this is a pin, and why the pin is a separate file
 *
 * The obvious repairs are *move the prose somewhere a conflict cannot reach it*
 * and *pin what the generator does not own*. This module is the second. The
 * first is a real improvement to the failure rate and the wrong answer to the
 * question, for a reason worth keeping: it does not close the class, it
 * relocates it. A hand-written-only file still loses its whole content to a
 * `--theirs`; all that changes is how often somebody rebases across it. And a
 * relocation cannot produce the thing a CI gate produces — an observation.
 *
 * The pin could have lived in a generated block inside each document. That was
 * rejected for a concrete reason, not a stylistic one: the documented recovery
 * for a conflicted mixed file is "take the merge base, then run `--write`".
 * A generated pin is refreshed by `--write`, so `--write` run after a `--theirs`
 * would re-pin the truncated file and report green. The gate would have been
 * defeated by its own repair recipe. So the pin is hand-maintained, lives
 * outside the generated set, and is only ever rewritten by `--prose-sync`.
 *
 * ## Why it is keyed by content hash, not by line numbers
 *
 * Two failure shapes have to be told apart, and an ordered or offset-keyed pin
 * cannot tell them: *adding* prose is the normal case (a new tool adds a
 * contract paragraph) and must never be red, while *losing* prose is the
 * defect. Keying on position makes a single deletion shift every later entry
 * and report the whole file as changed. Keying on the normalized text instead
 * makes addition free, and makes a missing key mean exactly one thing: a
 * paragraph that was in the manifest is not in the file any more.
 *
 * ## Why the label is stored next to the hash
 *
 * A bare hash would answer *that* prose went missing and not *which*, which
 * forces a `git log -p` archaeology dig at exactly the moment someone is
 * deciding whether to restore from the merge base. The label is the first
 * 56 characters of the paragraph, which also makes the manifest diffable by
 * eye: a lost paragraph is a line that visibly disappears from a JSON file
 * rather than a hash that quietly changes.
 */
import { createHash } from 'node:crypto';

/**
 * A `BEGIN:generated` / `END:generated` marker line, in either spelling the
 * repository uses. Mirrors `MARKER_LINE` in `surface-census.mjs` but is
 * deliberately duplicated rather than imported: that script runs the whole MCP
 * server at import time, and this module has to stay importable on its own so
 * the tests can drive the classifier without booting a server.
 */
const MARKER_LINE = /^[ \t]*(?:\/\/[ \t]*|<!--[ \t]*)(BEGIN|END):generated ([a-z0-9][a-z0-9-]*)[ \t]*(?:-->)?[ \t]*$/;

/** A list item, at either a bullet or an ordered marker. */
const LIST_ITEM = /^(?:-{1,2}|\*{1,2}|\d+[.)])\s+/;

/** A fence delimiter, in either backtick or tilde form. */
const FENCE = /^[ \t]*(?:```|~~~)/;

/**
 * The `note` stamped into the manifest on creation. Kept here rather than in
 * the census script so the file that describes the pin is the same file that
 * writes it.
 */
const MANIFEST_NOTE = [
  'HAND-MAINTAINED. Not generated, and `npm run count:tools -- --write` does not touch it.',
  '',
  'Each entry is one paragraph of hand-written prose that sits OUTSIDE a BEGIN:generated/END:generated',
  'block, keyed by a content hash so that adding prose is free and only a paragraph that disappeared can',
  'fail. Regenerate with `npm run count:tools -- --prose-sync`; that command refuses to drop a pinned',
  'entry and will tell you so, which is the entire point — see scripts/prose-manifest.mjs for why this pin',
  'cannot live in a generated block.',
].join('\n');

/**
 * Normalize a document's line endings.
 *
 * Only ever applied to text that already passed through git, so this is about
 * a checkout that materialised CRLF rather than about document content. A
 * newline flip must not read as every paragraph in the file having changed.
 */
const normalizeNewlines = (text) => text.replace(/\r\n?/g, '\n');

/**
 * Which lines of `source` sit inside a generated block.
 *
 * Depth is tracked rather than toggled so a malformed or unbalanced pair still
 * hides *something* — an unterminated block means everything after the stray
 * BEGIN is generator territory, which is the safe direction: over-hiding makes
 * the gate blind, and `markerTreeReport` already fails unbalanced pairs loudly.
 */
function generatedLineMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(MARKER_LINE);
    if (match) {
      if (match[1] === 'BEGIN') {
        depth++;
        mask[i] = true;
      } else {
        depth--;
        mask[i] = true;
      }
      continue;
    }
    mask[i] = depth > 0;
  }
  return mask;
}

/**
 * Split a document into its hand-written prose units.
 *
 * A unit is a blank-line-delimited chunk, further split at list-item
 * boundaries, with fenced blocks kept whole. Those three rules are each
 * load-bearing:
 *
 *  - **Blank-line chunks**, so a paragraph is one unit and a reword inside it
 *    is one change rather than a cascade.
 *  - **List-item boundaries**, because the highest-value prose in these
 *    documents is numbered and bulleted. `ARCHITECTURE.md`'s eleven-step
 *    request pipeline is eleven separate one-line items; without this rule a
 *    `--theirs` that dropped step 5 would report a *modification* of the whole
 *    list instead of a named missing step.
 *  - **Fenced blocks atomic**, so a mermaid diagram is one unit. Splitting on
 *    the blank lines inside a diagram made an early draft report four deleted
 *    blocks where there was one edited one — noisier, and it names a paragraph
 *    that was never a paragraph.
 */
export function splitProseUnits(source) {
  const lines = normalizeNewlines(source).split('\n');
  const mask = generatedLineMask(lines);
  const units = [];
  let current = [];
  let fenced = false;

  const flush = () => {
    const text = current.join('\n').trim();
    if (text !== '') units.push(text);
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) {
      flush();
      continue;
    }
    const line = lines[i];
    if (FENCE.test(line)) fenced = !fenced;
    // A blank line inside a fence is diagram syntax, not a paragraph break.
    if (!fenced && LIST_ITEM.test(line) && current.length > 0) flush();
    if (/^[ \t]*$/.test(line)) {
      if (!fenced) flush();
      else current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return units;
}

/**
 * The human-facing name of a prose unit: its first 56 characters with the
 * markdown scaffolding that would render as noise removed.
 *
 * Stored beside the hash so a gate failure names the paragraph instead of
 * printing a digest the reader has to take on trust.
 */
export function proseUnitLabel(text) {
  const flat = text
    .replace(/```[a-z]*/g, ' ')
    .replace(/^\s*[#>*+-]+\s*/gm, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 56 ? `${flat.slice(0, 56)}…` : flat;
}

/** A short content digest. 16 hex characters is 64 bits over ~1.2k units. */
export function proseUnitHash(text) {
  return createHash('sha256').update(normalizeNewlines(text).trim()).digest('hex').slice(0, 16);
}

/** The pinned identity of every hand-written unit in one document. */
export function describeDocument(source) {
  const seen = new Map();
  for (const text of splitProseUnits(source)) {
    const hash = proseUnitHash(text);
    // Two byte-identical paragraphs are one key. The manifest is a set, so a
    // duplicated paragraph appears once; losing one copy of it is not
    // reported, which is the accepted cost of a content-addressed key.
    if (!seen.has(hash)) seen.set(hash, proseUnitLabel(text));
  }
  return [...seen.entries()].map(([hash, label]) => ({ hash, label }));
}

const indexByHash = (entries) => new Map(entries.map((entry) => [entry.hash, entry]));

/**
 * Compare a manifest against the documents as they now stand.
 *
 * The two failure classes are deliberately not told apart, because nothing in
 * the tree can tell them apart: a reworded paragraph and a deleted one are the
 * same fact — a pinned key is gone. Guessing which one it was from unit counts
 * or line counts is the reasoning error this whole file exists to warn about
 * (AGENTS.md §6: a value that cannot be read must not be coerced into a
 * plausible answer). The message names both readings and hands over the
 * decision, because the decision is the reader's.
 *
 * Coverage is reconciled here rather than trusted: a mixed document that no
 * manifest entry claims is reported, so adding a new file with a generated
 * block cannot quietly arrive ungated.
 */
export function proseDrift(manifest, documents) {
  const errors = [];
  const claimed = new Set();
  const current = new Set();

  for (const [file, source] of Object.entries(documents)) {
    const units = describeDocument(source);
    for (const unit of units) current.add(`${file}:${unit.hash}`);

    const pinned = manifest.files?.[file];
    if (!pinned) {
      errors.push(
        `${file}: carries hand-written prose outside its generated blocks but no manifest entry claims it — `
        + 'nothing would notice prose lost here. Run `npm run count:tools -- --prose-sync`.',
      );
      continue;
    }
    claimed.add(file);

    const present = indexByHash(units);
    const missing = pinned.filter((entry) => !present.has(entry.hash));
    for (const entry of missing) {
      errors.push(
        `${file}: pinned prose block is no longer in the file — "${entry.label}". `
        + 'A reword or a deliberate deletion is legitimate: `npm run count:tools -- --prose-sync --retire "<reason>"` '
        + 'records it. A paragraph that vanished because a conflict here was resolved with --ours or --theirs is not: '
        + 'the generator only owns the text between the markers, so it cannot restore this. '
        + 'Restore the paragraph by hand from the side you dropped (`git show <ref>:ARCHITECTURE.md`, and the same '
        + 'for every other mixed file), and only then run `npm run count:tools -- --write` — `--write` repairs the '
        + 'generated blocks and exits 1 for exactly as long as this paragraph is missing.',
      );
    }
  }

  // A manifest entry for a file that no longer carries prose is not an error —
  // the file may have been deleted outright, and its generated blocks go with
  // it. But an entry naming a file that exists with *no* generated block is a
  // stale pin, and one naming a path nothing has is a typo.
  for (const file of Object.keys(manifest.files ?? {})) {
    if (claimed.has(file)) continue;
    if (file in documents) continue;
    errors.push(
      `${file}: the manifest pins prose here but the document was not scanned. `
      + 'A pin for a file that does not exist can never fail, so it reports green forever.',
    );
  }

  const pinnedCount = Object.values(manifest.files ?? {}).reduce((total, entries) => total + entries.length, 0);

  return {
    errors,
    currentCount: current.size,
    pinnedCount,
    // Which documents the comparison actually read. Without this a scan that
    // found nothing at all would report the same clean verdict as one that
    // checked all ten files, and only the count can tell them apart.
    files: Object.keys(documents).sort(),
  };
}

/**
 * Rebuild a manifest from the documents as they stand, carrying every pinned
 * key forward that is still present and refusing to drop the ones that are not.
 *
 * The refusal is the whole point. A `--prose-sync` that silently accepted a
 * vanished key would let `--prose-sync` do to the pin exactly what `--theirs`
 * did to the document, one command later. Losing prose has to be a named,
 * dated, reasoned act recorded in the manifest, so that the act is visible in
 * the diff that a reviewer reads.
 */
export function syncProseManifest(manifest, documents, { retire, date, reason }) {
  // Stamped on creation and preserved thereafter, and placed first, so the file
  // says what it is to whoever opens it. A pin sitting next to a generator and
  // its `--write` flag looks, at a glance, like one more generated artifact —
  // and deleting it would look like regenerating it.
  const { note, ...carried } = manifest;
  const next = { note: note ?? MANIFEST_NOTE, ...carried, files: {} };
  const dropped = [];

  for (const [file, source] of Object.entries(documents)) {
    const units = describeDocument(source);
    next.files[file] = units;
    const present = indexByHash(units);
    for (const entry of manifest.files?.[file] ?? []) {
      if (!present.has(entry.hash)) dropped.push({ file, ...entry });
    }
  }
  // Pins whose document is gone are retired too, so a `--retire` run cannot
  // leave a file entry behind that will fail the "not scanned" check above.
  for (const file of Object.keys(manifest.files ?? {})) {
    if (file in documents) continue;
    for (const entry of manifest.files[file]) dropped.push({ file, ...entry });
  }

  if (dropped.length > 0 && !retire) {
    return {
      manifest: next,
      dropped,
      retired: [],
      refused: true,
    };
  }

  const retired = retire
    ? dropped.map((entry) => ({ ...entry, date, reason }))
    : [];
  if (retired.length > 0) {
    next.retired = [...(manifest.retired ?? []), ...retired].sort((a, b) =>
      `${a.file}:${a.hash}`.localeCompare(`${b.file}:${b.hash}`));
  } else if (manifest.retired) {
    next.retired = manifest.retired;
  }

  return { manifest: next, dropped, retired, refused: false };
}
