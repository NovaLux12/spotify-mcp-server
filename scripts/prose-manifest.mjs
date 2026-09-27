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
 * ## And where the surplus *is* a finding: `--prose-report`
 *
 * "Must never be red" is a claim about `errors` and about `--check`, and both
 * still hold. It is not a claim that the surplus goes unreported. An unpinned
 * paragraph is prose the guard cannot watch: no key, so a later deletion or
 * reword of *that* paragraph raises nothing — which is how four `AGENTS.md`
 * lessons reached `main` unpinned in #1523 while the gate read clean.
 *
 * So the surplus is reported by `coverage.unpinned` here, and
 * `scripts/surface-census.mjs` turns it into a non-zero exit for
 * `--prose-report` alone. One command clears it (`--prose-sync`, which adds the
 * key and retires nothing), which is the property that keeps this a report
 * rather than a barrier: the cost of the finding is one command, paid in the
 * same commit as the paragraph.
 *
 * ## Why the label is stored next to the hash
 *
 * A bare hash would answer *that* prose went missing and not *which*, which
 * forces a `git log -p` archaeology dig at exactly the moment someone is
 * deciding whether to restore from the merge base. The label is the first
 * 56 characters of the paragraph, which also makes the manifest diffable by
 * eye: a lost paragraph is a line that visibly disappears from a JSON file
 * rather than a hash that quietly changes.
 *
 * ## Why a reword and a deletion are two records and not one
 *
 * A content hash cannot tell a reworded paragraph from a deleted one — both are
 * a key that is no longer in the file, and that is not a shortcoming of the key,
 * it is the only fact a content-addressed pin has. So the *records* have to carry
 * the distinction the key cannot, and there are exactly two of them because there
 * are exactly two things that happened:
 *
 *  - `reanchored` — this text replaced that text, and **both are in the tree**.
 *    It is refused when the replacement is not in the file, which is the whole
 *    asymmetry: a reanchor can only describe a tree that exists, so it can never
 *    be the way prose comes back. Restoring is hand-work from the ref you
 *    dropped, and the refusal says so rather than offering a second spelling of
 *    it.
 *  - `retired` — that text is gone. No successor is named, because there is none.
 *
 * Before this, the only record that could be written was the second one, so a
 * corrected sentence produced a manifest entry asserting a deletion — a false
 * record, in the one file whose value is that its records can be trusted, and it
 * reads to the next author as a decision. That is why `reanchorStanding` is read
 * by `--prose-report` and not merely written: a list nothing checks is the same
 * class of problem as a paragraph nothing pins.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
  '',
  '`retired` and `reanchored` are the two ways a pinned paragraph is allowed to stop being pinned, and they',
  'are different facts. A reword in place is `--prose-sync --reanchor "<file>:<hash>" --to "<new prose>"',
  '--why "<why>"`, which records the old and the new hash and refuses unless the replacement is already in',
  'the file. A deletion is `--prose-sync --retire "<reason>"`. Neither restores prose that is gone: that is',
  'hand-work from the ref you dropped.',
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
 * The two failure classes are deliberately not told apart **in what is
 * detected**, because nothing in the tree can tell them apart: a reworded
 * paragraph and a deleted one are the same fact — a pinned key is gone. Guessing
 * which one it was from unit counts or line counts is the reasoning error this
 * whole file exists to warn about (AGENTS.md §6: a value that cannot be read
 * must not be coerced into a plausible answer). What they *need* is told apart
 * from the moment on: the message names both readings and points at the two
 * commands that record them, because the decision is the reader's and it is a
 * decision the manifest then has to be able to represent.
 *
 * Coverage is reconciled here rather than trusted: a mixed document that no
 * manifest entry claims is reported, so adding a new file with a generated
 * block cannot quietly arrive ungated.
 */
export function proseDrift(manifest, documents) {
  const errors = [];
  const claimed = new Set();
  // `${file}:${hash}` -> the unit, so the surplus can be reported with the label
  // a reader needs instead of a hash they have to look up.
  const current = new Map();
  const pinnedKeys = new Set();
  const missingUnits = [];

  for (const [file, source] of Object.entries(documents)) {
    const units = describeDocument(source);
    for (const unit of units) {
      current.set(`${file}:${unit.hash}`, { file, hash: unit.hash, label: unit.label });
    }

    const pinned = manifest.files?.[file];
    if (!pinned) {
      errors.push(
        `${file}: carries hand-written prose outside its generated blocks but no manifest entry claims it — `
        + 'nothing would notice prose lost here. Run `npm run count:tools -- --prose-sync`.',
      );
      continue;
    }
    claimed.add(file);
    for (const entry of pinned) pinnedKeys.add(`${file}:${entry.hash}`);

    const present = indexByHash(units);
    const missing = pinned.filter((entry) => !present.has(entry.hash));
    for (const entry of missing) {
      missingUnits.push({ file, hash: entry.hash, label: entry.label });
      errors.push(
        `${file}: pinned prose block is no longer in the file — "${entry.label}". `
        + 'The pin is keyed by content, so a reword and a deletion look identical here, and they need different '
        + 'commands. Reworded in place — the paragraph is still in the file, under new text — is '
        + '`npm run count:tools -- --prose-sync --reanchor "${file}:${entry.hash}" --to "<new prose>" --why "<why>"`, '
        + 'which records the old and the new hash and refuses unless the replacement is already in the file. '
        + 'Deliberately deleted is `npm run count:tools -- --prose-sync --retire "<reason>"`, which records the '
        + 'reason and the date and names no successor. '
        + 'A paragraph that vanished because a conflict here was resolved with --ours or --theirs is neither: '
        + 'the generator only owns the text between the markers, so it cannot restore this, and neither operation '
        + 'will pretend to. '
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
    // The two counts above, reconciled by direction, so that no caller has to
    // subtract them and guess which way round the difference goes. The pin is a
    // subset of what the walk found, and the surplus is one of two opposite
    // facts: a unit no pin claims is prose the manifest has never seen, which
    // is ordinary work and must never be red; a pin no unit answers is prose a
    // file no longer carries, and each of those is already in `errors` above.
    //
    // This is reported rather than left to arithmetic because the two are not
    // the same magnitude — `unpinned.length` is `currentCount - pinnedCount`
    // only while nothing is missing and every pinned file was scanned — and a
    // reader given two totals and one difference has to decide which of them
    // they are looking at. #1460 shipped a test that compared the totals
    // directly, so adding a paragraph turned the suite red with a message
    // blaming a deletion, and the misdiagnosis survived into #1412. The
    // direction is now named here, where the facts are.
    coverage: {
      // Prose the walk found that no pin claims. Free by design, so this is
      // never an error and `--prose-sync` is the only reason to act on it.
      unpinned: [...current.values()]
        .filter((unit) => !pinnedKeys.has(`${unit.file}:${unit.hash}`))
        .sort((a, b) => `${a.file}:${a.hash}`.localeCompare(`${b.file}:${b.hash}`)),
      // Pins the walk did not find. In the same order as the "pinned prose
      // block is no longer in the file" entries in `errors`, one for one.
      missing: missingUnits,
    },
    // Which documents the comparison actually read. Without this a scan that
    // found nothing at all would report the same clean verdict as one that
    // checked all ten files, and only the count can tell them apart.
    files: Object.keys(documents).sort(),
  };
}

/**
 * A unit hash, as it appears in a manifest.
 *
 * `--to` accepts either a hash or the replacement prose itself, and telling the
 * two apart needs a shape rather than a lookup: the author has the text in front
 * of them, and the hash is what `--prose-report` printed a moment earlier. A
 * paragraph whose entire text is sixteen hex characters would be misread, which
 * is a cost worth paying for not having to reconstruct a paragraph that is
 * already sitting in the file.
 */
const HASH_SHAPE = /^[0-9a-f]{16}$/;

/** The unit a `--to` value names, or null when the file does not contain it. */
function resolveReplacement(value, units) {
  const candidate = HASH_SHAPE.test(value) ? value : proseUnitHash(value);
  return units.find((unit) => unit.hash === candidate) ?? null;
}

/**
 * Resolve the reanchor requests of one run into records, and refuse the rest.
 *
 * This is where the asymmetry of a reanchor is enforced, and it is worth stating
 * plainly because it is the entire difference between this and a retirement:
 * **the replacement has to be in the file.** Every refusal below is that one
 * check seen from a different side.
 *
 * The consequence is that a reanchor can only ever *describe* a tree, never
 * *produce* one. If the paragraph was genuinely deleted there is no replacement
 * text to point at, so the command refuses — which is correct, because restoring
 * prose is hand-work from the ref you dropped, and a flag that quietly did it
 * would be a second, worse spelling of `git show`. The same check refuses in the
 * other direction: a reanchor whose subject is still sitting in the file is
 * claiming a transition that has not happened yet.
 *
 * Pure: it writes nothing, returns the records it would write, and every refusal
 * is a `{ kind, key, message }` the CLI can print verbatim. That is what lets the
 * refusal be tested against the real command rather than a copy of its logic.
 */
export function resolveReanchors(manifest, documents, requests) {
  const resolved = [];
  const alreadyApplied = [];
  const refusals = [];

  for (const request of requests) {
    const key = `${request.file}:${request.hash}`;

    const source = documents[request.file];
    if (source === undefined) {
      refusals.push({
        kind: 'unscanned',
        key,
        message: `${request.file} was not scanned, so the replacement cannot be checked against it.\n`
          + 'A reanchor asserts that both texts are in the tree, and that assertion needs the tree. This file is\n'
          + 'not a mixed document, so nothing here can have reworded it — re-run `npm run count:tools -- --prose-sync`\n'
          + 'without the override that replaced it.',
      });
      continue;
    }

    const units = describeDocument(source);
    const replacement = resolveReplacement(request.to, units);
    if (!replacement) {
      // The anti-vacuity refusal, and the one the whole operation turns on.
      refusals.push({
        kind: 'replacement-absent',
        key,
        message: `${key} → "${request.to}" cannot be a reanchor: the replacement is not in ${request.file}.\n`
          + 'A reanchor records that this text replaced that text and that **both are in the tree**. That condition\n'
          + 'is the operation: it is what stops a reanchor being a quiet way to drop a pin, and it is why restoring\n'
          + 'prose is not something a flag does. If you meant to delete the paragraph, that is\n'
          + '`npm run count:tools -- --prose-sync --retire "<reason>"` — a different record, with no successor.\n'
          + 'If you meant to restore it, the bytes are in the ref you dropped: `git show <ref>:${request.file}`.\n'
          + 'If you have already written the replacement and it is still reported absent, pass the paragraph\'s\n'
          + 'hash instead of its text — `npm run count:tools -- --prose-report` lists what it found.',
      });
      continue;
    }

    // Idempotence, checked against the RECORD rather than against the pin — and
    // that ordering is the whole reason it works. By the time the same command
    // runs a second time, the paragraph it names has left `files` on purpose,
    // so a pin lookup would refuse a re-run of a reanchor that had already
    // succeeded. Comparing `to` is what separates that from a *second*
    // transition, which is refused rather than chained: a genuine second reword
    // reanchors the replacement, not the paragraph that has already been
    // replaced.
    const prior = (manifest.reanchored ?? []).find((entry) => entry.file === request.file && entry.hash === request.hash);
    if (prior) {
      if (prior.to === replacement.hash) {
        alreadyApplied.push({ ...prior, requested: key });
        continue;
      }
      refusals.push({
        kind: 'chained',
        key,
        message: `${key} was already reanchored to ${request.file}:${prior.to} on ${prior.date}.\n`
          + 'Recording a second replacement for it would claim a second transition that did not happen, and the two\n'
          + 'records would disagree about what the paragraph says now.\n'
          + 'A genuine second reword is a reanchor of the *replacement*: '
          + `--reanchor "${request.file}:${prior.to}" --to "<newer prose>" --why "<why>".`,
      });
      continue;
    }

    const pinned = (manifest.files?.[request.file] ?? []).find((entry) => entry.hash === request.hash);
    if (!pinned) {
      refusals.push({
        kind: 'unpinned',
        key,
        message: `${key} is not a pinned paragraph, so there is nothing to reanchor.\n`
          + 'A reanchor replaces one pin with another; naming a paragraph no pin claims is a typo, and treating it\n'
          + 'as a reword would write a record about a paragraph the manifest never held.\n'
          + 'The pinned keys are in the `files` array of scripts/doc-prose-manifest.json, one per paragraph, and\n'
          + '`npm run count:tools -- --prose-report` prints the ones currently missing as "<file>:<hash>".',
      });
      continue;
    }

    if (units.some((unit) => unit.hash === request.hash)) {
      refusals.push({
        kind: 'source-present',
        key,
        message: `${key} is still in ${request.file}, byte for byte, so it has not been reworded.\n`
          + 'A reanchor records a replacement. The paragraph it names is still the pinned one, so the record would\n'
          + 'be false on its face — the same false record a retirement of a live paragraph is.',
      });
      continue;
    }

    if ((manifest.files?.[request.file] ?? []).some((entry) => entry.hash === replacement.hash)) {
      refusals.push({
        kind: 'replacement-pinned',
        key: `${request.file}:${replacement.hash}`,
        message: `${request.file}:${replacement.hash} is already a pinned paragraph, so reanchoring onto it would\n`
          + 'record a replacement that the pin had already claimed independently of this paragraph.\n'
          + 'A reanchor has to name a paragraph that is new to the pin, or the record says the two are one sentence\n'
          + 'when the manifest says they were separate. Reword to text no pin has yet seen.',
      });
      continue;
    }

    resolved.push({
      file: request.file,
      hash: request.hash,
      label: pinned.label,
      to: replacement.hash,
      toLabel: replacement.label,
      reason: request.reason,
    });
  }

  return { resolved, alreadyApplied, refusals };
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
 *
 * `corrects` names the `file:hash` of a retirement record this one supersedes,
 * and is the only way to record that an earlier reason was false (#1502) — see
 * `retirementStanding`, which is what makes the correction load-bearing. It is
 * carried onto every record this run writes, so a run that retires several
 * paragraphs at once states once which earlier claim they collectively answer.
 *
 * `reanchors` are the records `resolveReanchors` already accepted. Their sources
 * are subtracted from the drop list rather than refused, which is the whole
 * point of the operation: the paragraph did leave the pin, but it is in the file
 * under different text and a retirement would say it is gone.
 */
export function syncProseManifest(manifest, documents, { retire, date, reason, corrects, reanchors = [] }) {
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

  // A reanchored paragraph is not a drop. It left the pin, and it is in the file
  // under different text — which is why the operation exists and why a
  // retirement of it would be the false record #1527 is about. Subtracted here
  // rather than in `resolveReanchors` because only this function knows which
  // pins the walk actually lost: a reanchor request that names a paragraph the
  // file still carries is refused there, so anything reaching this list is a
  // paragraph the tree really did drop.
  //
  // Above the refusal below, deliberately. A reanchor and a retirement are two
  // answers to "this pin is gone", and the question the refusal asks is
  // "is anything gone that nobody has explained" — a paragraph with a reanchor
  // has been explained, so counting it in that question would make the operation
  // unreachable: every reanchored paragraph would hold its own sync hostage.
  const reanchoredFrom = new Set(reanchors.map((entry) => `${entry.file}:${entry.hash}`));
  const unrecorded = dropped.filter((entry) => !reanchoredFrom.has(`${entry.file}:${entry.hash}`));

  if (unrecorded.length > 0 && !retire) {
    return {
      manifest: next,
      dropped,
      retired: [],
      allRetired: manifest.retired ?? [],
      reanchored: [],
      allReanchored: manifest.reanchored ?? [],
      correction: null,
      unknownCorrection: null,
      refused: true,
    };
  }

  const retired = retire
    ? unrecorded.map((entry) => ({ ...entry, date, reason }))
    : [];

  // A correction is its OWN record, not a field on whatever this run happened to
  // retire (#1502). It has to be: the false reason is discovered long after the
  // run that wrote it, at a moment when nothing is being dropped — so a
  // `--corrects` that only took effect alongside a fresh retirement would be
  // unreachable exactly when it is needed. And a newly-retired paragraph is a
  // DIFFERENT paragraph; stamping the correction onto it would make a record
  // about paragraph X claim to answer for paragraph Y.
  let correction = null;
  if (corrects !== undefined && corrects !== null) {
    const target = (manifest.retired ?? []).find((entry) => retirementKey(entry) === corrects);
    if (!target) {
      return {
        manifest: next,
        dropped,
        retired: [],
        allRetired: manifest.retired ?? [],
        reanchored: [],
        allReanchored: manifest.reanchored ?? [],
        correction: null,
        unknownCorrection: corrects,
        refused: true,
      };
    }
    // The correction needs an identity of its OWN, and it cannot be the target's:
    // a record is keyed by `file:hash`, so a correction carrying the file and hash
    // it corrects is indistinguishable from the record it retracts — two entries
    // at one key, and `corrects` pointing at itself. That is not a data shape, it
    // is the cycle the reader refuses, and it means a correction can never
    // succeed.
    //
    // So the correction is keyed by the hash of the REASON it carries. That is
    // unique per distinct reason, it is derived from the claim rather than
    // assigned, and it makes the collision impossible by construction: correcting
    // a record with a different reason produces a different key, and correcting
    // it with the SAME reason it already has is a no-op that the reader can see
    // as one. The `file` and `label` are carried through so the entry still reads
    // as "this paragraph, and here is what actually happened to it" — a reader
    // scanning the array is looking for the paragraph, not the bookkeeping.
    correction = {
      file: target.file,
      hash: proseUnitHash(reason),
      label: target.label,
      date,
      reason,
      corrects,
    };
  }

  const added = correction ? [...retired, correction] : retired;
  if (added.length > 0) {
    next.retired = [...(manifest.retired ?? []), ...added].sort((a, b) =>
      `${a.file}:${a.hash}`.localeCompare(`${b.file}:${b.hash}`));
  } else if (manifest.retired) {
    next.retired = manifest.retired;
  }

  // Same two questions for the reanchor list, and the same split: what this run
  // added, and what the file holds afterwards. `retired` and `reanchored` are
  // kept in separate arrays rather than merged because a reader has to be able to
  // tell "this text was replaced by that text" from "this text is gone", and a
  // merged list with a discriminator re-introduces exactly the ambiguity the two
  // arrays remove.
  if (reanchors.length > 0) {
    next.reanchored = [...(manifest.reanchored ?? []), ...reanchors]
      .map((entry) => ({ ...entry, date }))
      .sort((a, b) => `${a.file}:${a.hash}`.localeCompare(`${b.file}:${b.hash}`));
  } else if (manifest.reanchored) {
    next.reanchored = manifest.reanchored;
  }

  // `retired` stays "the records THIS RUN added" — the census counts it to report
  // what the run did, and widening it to the whole set would make that line report
  // every retirement ever recorded. `allRetired` is the whole post-write set, which
  // is what a reader needs: a correction names a record that is usually NOT one of
  // the new ones, so handing back only the additions would make every correction
  // look like it corrects nothing.
  return {
    manifest: next,
    dropped,
    retired: added,
    allRetired: next.retired ?? [],
    reanchored: reanchors,
    allReanchored: next.reanchored ?? [],
    correction,
    unknownCorrection: null,
    refused: false,
  };
}

/**
 * The `file:hash` key a `corrects` field names (#1502).
 *
 * A hash alone is not the key: the same prose text can be pinned in two files, and
 * a correction that named only the hash would be ambiguous about which record it
 * retracts — the same way two documents agreeing about nothing is not agreement.
 */
export function retirementKey(entry) {
  return `${entry.file}:${entry.hash}`;
}

/**
 * The retirements a reader should still believe, and the ones a later record
 * retracts (#1502).
 *
 * A retirement reason is a claim about *why* prose left a file, and a false one
 * is worse than a stale one: the manifest's whole purpose is to be a trustworthy
 * record, so a reason that turns out to be untrue is a live defect in the one
 * file whose value is that it can be trusted. The existing remedy was to write a
 * second, contradictory record — which leaves a reader holding two entries and no
 * way to tell which to believe, and leaves the false claim in place permanently.
 *
 * So a record may carry `corrects`, naming the `file:hash` it supersedes. This
 * function treats a superseded reason as not load-bearing, which is what makes it
 * *retractable* rather than merely contradicted. Neither record is rewritten: the
 * claim that was made, and when, is the evidence a later reader most needs, and
 * deleting it would destroy the record that a false reason was ever written.
 *
 * A `corrects` naming a record that is not in the manifest is not silently
 * ignored. It is returned in `unknown` so the caller can refuse: a correction of
 * nothing is a claim about no tree, which is the #1439 shape.
 *
 * Corrections are resolved transitively, so a correction of a correction
 * retracts the original too. A record that corrects itself is reported in
 * `cyclic` rather than resolved — there is no consistent reading of that, and
 * picking one silently would be a guess.
 */
export function retirementStanding(manifest) {
  const all = manifest.retired ?? [];
  const keys = new Set(all.map(retirementKey));
  const correctedBy = new Map();
  const unknown = [];
  const cyclic = [];

  for (const entry of all) {
    if (entry.corrects === undefined || entry.corrects === null) continue;
    if (!keys.has(entry.corrects)) {
      unknown.push({ corrects: entry.corrects, by: retirementKey(entry) });
      continue;
    }
    if (entry.corrects === retirementKey(entry)) {
      cyclic.push(retirementKey(entry));
      continue;
    }
    const prior = correctedBy.get(entry.corrects) ?? [];
    prior.push(retirementKey(entry));
    correctedBy.set(entry.corrects, prior);
  }

  // A record is retracted exactly when some record names it in `corrects` — which
  // is the whole rule, and it is already transitive without a walk. A corrects B
  // and C corrects B retracts B; A corrects B and C corrects A retracts both A and
  // B, leaving C. A recursive walk is what got this wrong first: it also retracted
  // the corrections, so a correction of a false reason was itself not load-bearing
  // and the manifest was left asserting only the original falsehood.
  const retracted = new Set(correctedBy.keys());

  return {
    active: all.filter((entry) => !retracted.has(retirementKey(entry))),
    retracted: all.filter((entry) => retracted.has(retirementKey(entry))),
    correctedBy,
    unknown,
    cyclic,
  };
}

/**
 * The `file:hash` a reanchor record is identified by — the paragraph it
 * replaced, which is the same identity a retirement of that paragraph carries.
 */
export function reanchorKey(entry) {
  return `${entry.file}:${entry.hash}`;
}

/**
 * What a reader should make of the `reanchored` list, and the three ways it can
 * be false.
 *
 * A list nothing checks is not a record, it is a comment: it would be written on
 * every reword and never read, which is the same class of problem as a paragraph
 * nobody pins. So `--prose-report` reads it and this is what it checks. All three
 * failures are about the **records disagreeing with each other**, never about the
 * documents' current state, and that boundary is deliberate:
 *
 *  - **cyclic** — `to === hash`, a paragraph recorded as replacing itself. No CLI
 *    can produce one (`resolveReanchors` refuses a subject that is still in the
 *    file), so it means a hand-edited or half-merged manifest, which is exactly
 *    the case a reader of the file cannot see.
 *  - **malformed** — a record with no `to`, no reason or no date. A retirement
 *    without a reason is the artefact the whole mechanism exists to prevent, and
 *    a reanchor without one is the same artefact wearing a different word.
 *  - **contradicted** — a paragraph carrying an active retirement *and* a
 *    reanchor. The two records say opposite things about the same unit, and one
 *    of them is the false record #1527 is about. Only active retirements count:
 *    a retracted one is history, and history is allowed to be wrong, which is
 *    what `corrects` is for.
 *
 * What is deliberately *not* an error: a record whose replacement is no longer in
 * the tree. Reverting a reword is legitimate — the paragraph comes back and the
 * replacement goes — and the only in-tool remedy for that would be hand-editing
 * the manifest, which this file is never allowed to do. A gate with no exit is a
 * gate that gets ignored, so `detached` is reported and read, not failed on.
 */
export function reanchorStanding(manifest) {
  const all = manifest.reanchored ?? [];
  const pinned = new Set();
  for (const [file, entries] of Object.entries(manifest.files ?? {})) {
    for (const entry of entries) pinned.add(`${file}:${entry.hash}`);
  }
  const reanchoredAway = new Set(all.map(reanchorKey));
  // Only retirements a reader should still act on. A retracted one is superseded
  // by a later, named claim, so pairing it with a reanchor is not a contradiction.
  const activeRetirements = new Set(retirementStanding(manifest).active.map(retirementKey));

  const active = [];
  const superseded = [];
  const detached = [];
  const contradicted = [];
  const malformed = [];
  const cyclic = [];

  for (const entry of all) {
    const key = reanchorKey(entry);
    if (typeof entry.to !== 'string' || entry.to === '' || typeof entry.reason !== 'string' || entry.reason.trim() === ''
      || typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      malformed.push({ reanchor: key, why: !entry.to ? 'it names no replacement (`to`)' : !entry.reason ? 'it carries no reason' : 'it carries no date' });
      continue;
    }
    if (entry.to === entry.hash) {
      cyclic.push(key);
      continue;
    }
    if (activeRetirements.has(key)) {
      contradicted.push({
        reanchor: key,
        retirement: key,
        why: 'the same paragraph is recorded as reworded to new text and as deleted',
      });
      continue;
    }
    // A reworded paragraph that was itself reworded: the first record is still
    // true, and the second is the one a reader acts on.
    if (reanchoredAway.has(`${entry.file}:${entry.to}`) && !pinned.has(`${entry.file}:${entry.to}`)) {
      superseded.push(entry);
      continue;
    }
    (pinned.has(`${entry.file}:${entry.to}`) ? active : detached).push(entry);
  }

  return { active, superseded, detached, contradicted, malformed, cyclic };
}

/**
 * Stamp the tree this manifest was generated from into the manifest itself.
 *
 * A retirement record is a permanent claim about *why* prose left a file, and a
 * `--reason` string is a claim about a tree. Nothing in the claim said which
 * tree, so once it was written the claim could not be checked against anything
 * — which is what let #1439 ship. This is the smallest thing that makes the
 * claim falsifiable after the fact: `git log -1 --format=%H scripts/doc-prose-manifest.json`
 * already knows the commit, but only for the *current* content, and a reader
 * looking at a bad reason needs the answer without a bisect.
 *
 * `upstream` and `behind` are recorded too because they are the difference
 * between "this tree was current" and "this tree predates a docs PR", and that
 * difference is exactly what a later reader cannot reconstruct from a SHA.
 *
 * `base` is recorded beside `head` rather than instead of it (#1482). Both are
 * facts: `head` is the tree the author was looking at, `base` is the commit that
 * tree was built on and therefore the one that survives the merge. Keeping only
 * one of them would mean either a stamp that a squash-merge orphans on the way
 * in, or a record that cannot name the tree a retirement was decided against —
 * and the second is the claim this block exists to make checkable.
 */
export function stampProvenance(manifest, { head, base, upstream, behind }) {
  return {
    ...manifest,
    provenance: { head, base: base ?? null, upstream: upstream ?? null, behind: Boolean(behind) },
  };
}

/**
 * The warning for a stamp that cannot survive a merge, or null when it can.
 *
 * A tree with no merge base — no `origin/main`, or two unrelated histories — has
 * no commit that is an ancestor of both sides, so the only stamp it can produce
 * names a branch tip and is orphaned by the next squash-merge. That is not a
 * defect in the tree, and refusing over it would break the case `--allow-stale`
 * exists for, so this is a warning rather than a refusal: the write is allowed
 * to proceed, and the author is told the cost before they commit it rather than
 * discovering it as a red `main`.
 */
export function provenanceStampWarning(prov) {
  if (!prov.usable || prov.head === null || prov.base !== null) return null;
  return `This tree shares no commit with ${short(prov.upstream)}, so the manifest is being stamped with a branch tip.\n`
    + 'That stamp is orphaned by the squash-merge that lands it, and the follow-up re-stamp it needs is a\n'
    + 'red main in the window between the two merges. If there is a commit on both sides — merge or rebase\n'
    + 'origin/main, then re-run — the stamp will name it instead and survive on its own.';
}

/**
 * What `surface-census.mjs` passes in, decided by `gitProvenanceIn` below.
 *
 * @typedef {object} GitProvenance
 * @property {boolean} usable       A commit was identified and git answered.
 * @property {string|null} head     `HEAD`'s commit, or null.
 * @property {string|null} base      The commit `HEAD` and `origin/main` last share, or null.
 * @property {string|null} upstream `origin/main`'s commit, or null when unresolvable.
 * @property {boolean} behind       `origin/main` is not an ancestor of `HEAD`.
 * @property {boolean} detached     `HEAD` is not on a branch.
 * @property {string[]} dirty       Repo-relative paths of pinned documents (or the
 *                                  manifest itself) with uncommitted changes.
 * @property {string} note          Why provenance is unusable, when it is.
 */

/**
 * Read the provenance of the working tree in `dir` (#1440).
 *
 * Every failure here degrades to `usable: false` with a `note` rather than
 * throwing: this runs on a source tarball, in a shallow CI checkout, and on a
 * machine without git, and the caller's job is to *refuse* on a tree it cannot
 * vouch for — not to crash before it gets the chance to explain itself.
 *
 * `dirty` is filtered to the paths the pin actually depends on. A dirty
 * `src/tools/foo.ts` cannot make a prose retirement false, and refusing on it
 * would train people to pass `--allow-stale` out of habit until the flag stops
 * meaning anything.
 */
export function gitProvenanceIn(dir, { docFiles = [], manifestPath = '' } = {}) {
  const git = (...argv) => {
    const result = spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8' });
    if (result.error || result.status !== 0) return null;
    return result.stdout.replace(/\n$/, '');
  };

  const head = git('rev-parse', 'HEAD');
  if (!head) {
    return {
      usable: false, head: null, base: null, upstream: null, behind: false, detached: false, dirty: [],
      note: `${dir} is not a git working tree (or has no commits), so there is no tree to record provenance against.`,
    };
  }

  const upstream = git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main');
  // `--is-ancestor` exits 0 for yes, 1 for no, 128 for "no such object", and
  // `git()` collapses every non-zero to null — so 1 and 128 read the same here.
  // That is deliberate and the opposite of `headContains` in the census, which
  // has to tell them apart. Two different questions are being asked: on the
  // write path "can this tree vouch for itself?" collapses to no if anything is
  // unclear, and a tree that cannot prove it contains upstream is exactly the
  // tree whose absences are suspect. The read path asks "is the recorded commit
  // still in my history?", where 128 means the checkout is shallow and failing
  // it would redden every CI run.
  const behind = upstream ? git('merge-base', '--is-ancestor', upstream, head) === null : false;
  // The one commit both histories agree on (#1482), and the only stamp that
  // survives whatever the merge does. `HEAD` is not: this repository
  // squash-merges, so a stamp naming the branch tip is orphaned by the very
  // merge that lands the prose it describes. `merge-base` is an ancestor of
  // `HEAD` *and* of `origin/main`, and `main` only ever grows, so it is an
  // ancestor of the merged result under a squash, a rebase-merge or a true
  // merge. Null when the two histories share nothing, which is the degenerate
  // case and is left null rather than substituted — see `provenanceStampRefusal`.
  const base = upstream ? git('merge-base', head, upstream) : null;
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');

  const watched = new Set([...docFiles, ...(manifestPath ? [manifestPath] : [])]);
  const dirty = [];
  for (const line of (git('status', '--porcelain') ?? '').split('\n')) {
    if (line === '') continue;
    // Porcelain v1: two status columns, a space, then the path. Renames read
    // `old -> new`; the new path is the one on disk, so split on the arrow. A
    // path containing a space is quoted by git, and the quotes have to come off
    // or it would never match a watched path — which would fail to *refuse*, the
    // direction a parse slip must not err in.
    const path = line.slice(3).trim().split(' -> ').pop().replace(/^"(.*)"$/, '$1');
    if (watched.has(path)) dirty.push(path);
  }
  dirty.sort();

  return {
    usable: true,
    head,
    base,
    upstream,
    behind,
    detached: branch === null,
    dirty,
    note: upstream
      ? ''
      : 'refs/remotes/origin/main does not resolve, so this tree cannot be compared against the branch it will merge into.',
  };
}

/**
 * The staleness cases `--prose-sync` has to refuse (#1440).
 *
 * Enumerated rather than guessed at, because "stale" is not one condition and a
 * guard written for the case that was observed stops working on the next one:
 *
 *  1. **Uncommitted changes to a pinned document or the manifest.** The sync
 *     reads bytes that are in no commit. Commit the work, or finish the sync
 *     against a commit that exists.
 *  2. **The tree is behind `origin/main`.** The branch predates a docs PR, so
 *     prose that PR reworded is simply *absent here* — the sync retires it and
 *     records a reason about a reword that this tree never saw. This is the
 *     #1439 shape exactly, and it is the case a "did you mean to delete this?"
 *     prompt cannot catch, because from inside the stale tree the deletion
 *     looks real.
 *  3. **No `origin/main` to compare against.** A shallow CI checkout, a
 *     detached local clone with no remote, a source tarball. Case 2 cannot be
 *     excluded, so it is treated as case 2.
 *  4. **No usable tree at all.** No git, no commits, not a repository.
 *
 * Cases 1 and 4 have no legitimate override — the sync has no tree to record
 * provenance against, and stamping a guess would be the false record the pin
 * exists to prevent. Cases 2 and 3 are *situations*, not defects: a feature
 * branch genuinely may not have merged a docs PR yet, and the honest answer is
 * to let the author proceed while making the cost of proceeding permanent and
 * visible. That is what `--allow-stale "<why>"` does — it does not silence the
 * warning, it moves it into `provenance` where a reviewer reads it next to the
 * reason it qualifies.
 *
 * The two classes come back separately so the caller can render them
 * differently: a hard refusal has no escape, a soft one names the override.
 * Collapsing them into one list is how a gate ends up with a documented bypass
 * that applies to the case it was written for.
 */
export function proseSyncRefusals(prov, { allowStale = null } = {}) {
  if (!prov.usable) {
    return { hard: [`Cannot record which tree this manifest came from: ${prov.note}`], soft: [] };
  }
  const hard = [];
  const soft = [];

  if (prov.dirty.length > 0) {
    hard.push(
      `Uncommitted changes in ${prov.dirty.length} file(s) the pin depends on:\n`
      + prov.dirty.map((path) => `- ${path}`).join('\n')
      + '\nA retirement decided against bytes that are in no commit describes a tree that never existed. '
      + 'Commit the work (or `git checkout --` it) and re-run. There is no override for this: '
      + 'the manifest is stamped with a commit, and there is no commit here to name.',
    );
  }
  if (prov.detached) {
    soft.push(
      'HEAD is detached, so the commit stamped into the manifest names no branch and a bad retirement '
      + 'recorded from here cannot be traced back to a merge that was supposed to cause it.',
    );
  }
  if (prov.behind || prov.upstream === null) {
    soft.push(
      `This tree is behind the branch it will merge into: `
      + (prov.behind
        ? `this branch does not contain origin/main (${short(prov.upstream)}).`
        : prov.note)
      + '\nProse that a docs PR reworded is simply absent here, and a sync against this tree records that '
      + 'as a deletion whose reason describes a change this tree never saw. #1439 shipped two of those.\n'
      + 'Rebase or merge origin/main and re-run. If this tree is genuinely the right one — you are syncing '
      + 'deliberately before a docs PR lands, or upstream has moved on and your branch is correct — re-run '
      + 'with --allow-stale "<why>" and the reason is recorded in the manifest\'s provenance block for a '
      + 'reviewer to read next to the retirement it qualifies.',
    );
  }

  return allowStale ? { hard, soft: [] } : { hard, soft };
}

/** The short form of a SHA used in messages, or a placeholder for a missing one. */
export const short = (sha) => (sha ? String(sha).slice(0, 7) : '(unknown)');

/**
 * Check a manifest's recorded provenance against the tree it now sits in.
 *
 * This is the read side of #1440 and it is deliberately asymmetric with the
 * write side. The write refuses; this *reports*, because at check time the
 * honest verdicts are three and not two:
 *
 *  - **verified** — the commit the pin was built on is an ancestor of `HEAD`.
 *    The tree the manifest was generated from is still in this history.
 *  - **rewritten** — it is not an ancestor. The pin was generated from a tree
 *    that is in neither this branch's history nor the branch it merges into,
 *    so the retirement reasons in it are claims about a tree nothing here
 *    carries. This is an error: re-run `--prose-sync`.
 *  - **unverifiable** — the commit object is not present, which is the normal
 *    state of a `fetch-depth: 1` CI checkout and of any `--check` on a fresh
 *    clone. Not an error, because a gate that goes red because a CI checkout
 *    is shallow is a gate people learn to ignore.
 *
 * ## Which commit is the subject, and why the branch tip is not (#1482)
 *
 * The subject is `provenance.base` — the commit `HEAD` and `origin/main` last
 * shared — and the branch tip is a fallback for a manifest stamped before the
 * base was recorded. This is the whole fix, and the reason it is not a
 * convenience is that the tip is *never* the right subject in this repository:
 * `main` squash-merges, so a commit that is a branch tip at sync time is an
 * interior commit of the squash and is an ancestor of nothing afterwards. The
 * gate asked "is the tip still here?", the answer on the merged result was
 * always no, and the consequence was a `main` that went red on every PR
 * carrying prose — on a tree whose pinned paragraphs were all present, which
 * the same run had just confirmed. #1482 hit that on five PRs and paid for it
 * with an identical two-line follow-up each time.
 *
 * The base is the right subject because it is the newest commit both histories
 * contain: an ancestor of the branch that ran the sync *and* of the branch it
 * merges into, and `main` only ever grows. Whatever the merge does to the
 * branch's own commits, it cannot unmake a commit `main` already had.
 *
 * ## What this gives up, stated plainly
 *
 * Asking about the base cannot distinguish a squash-merge from a rebase, and
 * cannot see an amend — the branch tip is a strictly more sensitive witness, and
 * on a rebased branch it would have fired where the base does not. That is the
 * price, and it is a price in *diagnosis* rather than in coverage: a rebase can
 * only change the tree by pulling in commits from the branch it lands on, and
 * every paragraph those commits could have dropped is a pinned paragraph
 * `proseDrift` reports as missing, by content hash, in the same run. The
 * content question is answered from the documents; the commit question was only
 * ever a proxy for it, and the proxy is what was wrong.
 *
 * The branch tip is still recorded, so the "was this tree rewritten" question
 * can still be *asked* — of somebody holding the objects — and the `verified`
 * detail says out loud when the tip is the one that is missing.
 *
 * `ancestor` is injected rather than shelled out to so the caller decides what
 * "ancestor" costs to determine and this stays testable without a repository.
 * A manifest with no `base` is judged on `head` alone, which is the pre-#1482
 * behaviour and the conservative direction: it can report `rewritten` where the
 * base would not.
 */
export function proseProvenanceVerdict(manifest, { ancestor }) {
  const recorded = manifest.provenance?.head ?? null;
  const base = manifest.provenance?.base ?? null;
  const subject = base ?? recorded;
  if (!subject) {
    return {
      status: 'unrecorded',
      error: null,
      detail: 'this manifest predates provenance recording, so the tree it was generated from is unknown. '
        + 'Run `npm run count:tools -- --prose-sync` to stamp it.',
    };
  }
  const verdict = ancestor(subject);
  if (verdict === true) {
    // The tip is asked about only for the sentence, never for the verdict: a
    // missing tip is the normal state of this repository after a squash-merge,
    // and saying so is worth one more `--is-ancestor` on a run that has already
    // shelled out to git and booted the server.
    //
    // `ancestor` answers three ways, and the third is not silence. A checkout
    // that cannot walk the history — a `fetch-depth: 1` CI clone, which is how
    // this repository is always tested — cannot tell "the tip is gone" from "I
    // have never heard of the tip", and returns null for both. Rendering that
    // the same as "nothing was lost" is the failure this paragraph exists to
    // prevent: `verified` then reads as if the branch tip were still reachable,
    // which is exactly the claim the sentence was added to qualify. So the
    // unknown is stated, and the tip is named in that statement too.
    const tipKnown = base && recorded !== base;
    const tipVerdict = tipKnown ? ancestor(recorded) : null;
    return {
      status: 'verified',
      error: null,
      detail: `generated from a tree on ${short(subject)}, still in this branch's history.`
        + (tipVerdict === false
          ? ` The branch tip it was generated from (${short(recorded)}) is not in this history, which is what a `
            + 'squash-merge does to a branch; the prose it pinned is reconciled separately, by content.'
          : tipVerdict === null && tipKnown
            ? ` Whether the branch tip it was generated from (${short(recorded)}) is in this history could not be `
              + 'determined here — a shallow checkout cannot walk back far enough to say — so nothing is claimed '
              + 'about it either way.'
            : ''),
    };
  }
  if (verdict === false) {
    return {
      status: 'rewritten',
      error: `this manifest was generated from a tree on ${short(subject)}, which is not an ancestor of HEAD — this branch contains neither that commit nor the one the tree was built on, so the pin describes prose no tree here has carried. `
        + 'Re-run `npm run count:tools -- --prose-sync` against the current tree.',
      detail: '',
    };
  }
  return {
    status: 'unverifiable',
    error: null,
    detail: `generated from ${short(subject)}, whose object is not in this checkout, so ancestry cannot be checked. `
      + 'This is expected on a shallow CI clone; it is not evidence either way.',
  };
}

/**
 * Read documents as they are at a ref, for the evidence half of the `--prose-sync`
 * refusal (#1440).
 *
 * A file absent at that ref is **omitted**, not returned as an empty string: a
 * document that does not exist upstream is a different fact from one that exists
 * and is empty, and the caller has to be able to tell them apart.
 */
export function readFilesAtRef(dir, ref, files) {
  const out = {};
  for (const file of files) {
    const result = spawnSync('git', ['-C', dir, 'show', `${ref}:${file}`], { encoding: 'utf8' });
    if (result.error || result.status !== 0) continue;
    out[file] = result.stdout;
  }
  return out;
}

/**
 * Which of the paragraphs a run is about to retire are *still present upstream*.
 *
 * A retirement reason is a claim about why a paragraph left. When the reason is
 * "upstream reworded it", that claim is false if the paragraph is sitting
 * unchanged in the file on the branch this will merge into — it cannot have been
 * removed here by a change that is not here yet.
 *
 * Matched by **content hash**, not by label prefix: a partial reword keeps the
 * opening and changes the tail, and matching the label would report that
 * legitimate retirement as contradicted — refusing the tool's actual job.
 */
export function contradictedByUpstream(dropped, upstreamDocuments) {
  const contradicted = [];
  for (const entry of dropped) {
    const source = upstreamDocuments[entry.file];
    if (source === undefined) continue;
    if (describeDocument(source).some((unit) => unit.hash === entry.hash)) contradicted.push(entry);
  }
  return contradicted;
}
