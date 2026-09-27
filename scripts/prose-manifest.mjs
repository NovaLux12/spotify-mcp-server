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
