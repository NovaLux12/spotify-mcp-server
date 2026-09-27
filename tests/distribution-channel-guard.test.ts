/**
 * Distribution-channel guard (#710).
 *
 * `smithery.yaml` used to ship as a six-line `start` block and nothing else, so
 * the repository advertised a hosted Smithery listing that could not work. The
 * listing is now retired, and this guard is what keeps the retirement honest.
 *
 * The reason it cannot work is structural, not cosmetic. This server's OAuth
 * is native-app PKCE: `validateRedirectUri` accepts only a plain-HTTP loopback
 * URL, and the callback listener binds `127.0.0.1`/`::1` exclusively. On a
 * hosted instance the browser redirect resolves to the *user's* loopback, not
 * the container's, so the authorization code never reaches the server; tokens
 * are then written to that instance's own `~/.spotify-mcp/tokens.json`. A
 * listing that prompted for `SPOTIFY_CLIENT_ID` would start cleanly and fail
 * at PKCE, which is worse than having no listing at all — it advertises a
 * capability that does not work. `docs/distribution.md` records the posture.
 *
 * The guard therefore fails if the manifest comes back, if any surface outside
 * that one doc starts treating Smithery as a live channel again, if the
 * `area:distribution` labeler section names a file that no longer exists (the
 * dead glob this retirement left behind), or if the recorded posture is
 * dropped from the doc.
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { proseUnitHash, proseUnitLabel, splitProseUnits } from '../scripts/prose-manifest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const RETIRED_MANIFEST = 'smithery.yaml';

/** The one file allowed to name the retired channel: it records the decision. */
const POSTURE_DOC = 'docs/distribution.md';

/** Matches the retired channel's name, wherever it appears. Not global. */
const RETIRED_CHANNEL = /smithery/i;

/**
 * One exemption from the retired-channel scan, and everything an exemption
 * has to be able to answer about itself.
 */
type DerivedSurfaceExemption = {
  /** The repo-relative file that is allowed to name the retired channel. */
  path: string;
  /**
   * The guarded document whose pinned prose it quotes. This is load-bearing
   * rather than documentation: an exemption is only sound while the source it
   * derives from is itself read by this guard, and a source that is not in
   * `CHANNEL_SURFACES` is not read by anything here.
   */
  derivedFrom: string;
  /** Why this file may name the channel. Required — see the check below. */
  reason: string;
};

/**
 * Surfaces that are *derived from* a document this guard already reads (#1384,
 * bounded in #1437).
 *
 * `scripts/doc-prose-manifest.json` pins the hand-written prose of every
 * generated-block document by recording the first 56 characters of each
 * paragraph, so a label can quote a sentence from `docs/distribution.md`
 * — including the one that records this retirement, and nothing else. Excluded
 * for the same reason `CHANGELOG.md` is, and on the same grounds: a derived
 * copy cannot present the retired channel as live in any way its source does
 * not already, and the source is read by this guard.
 *
 * Deliberately a named list rather than a path pattern. A `*.json`-shaped
 * exclusion would quietly cover the next artifact added to `scripts/`, and this
 * guard's whole value is that nothing new acquires an exemption by accident.
 *
 * ## Why a name was not enough (#1437)
 *
 * The first version of this list was `string[]`, and the only check on it was
 * that each file contains the token somewhere. That is not a bound — it is the
 * shape of the thing #1437 is about. "This file is exempt, and it mentions the
 * token" is satisfied by a file that *hand-writes* "Smithery is the supported
 * deployment target" into a free-text field; the old test could not tell that
 * from a label the generator derived, and would have gone green. An exemption
 * with no bound on it is an invitation, and the next person to hit a guard they
 * cannot satisfy has a documented, apparently-sanctioned way to make it go away.
 *
 * So the exemption is now **self-limiting**, and it is limiting itself against
 * the attack it is actually exposed to rather than against a filename:
 *
 *  - **The mention must be derived, not asserted.** Every occurrence of the
 *    token in the exempted file must be a string that this repository's own
 *    `proseUnitLabel()` produces from a paragraph of its declared `derivedFrom`
 *    document, *and* that paragraph's hash must be pinned for that file in
 *    `doc-prose-manifest.json`. That is a proof of derivation recomputed from
 *    the live source, so it cannot be satisfied by typing. A retirement reason,
 *    a label, or a key is only exempt while it is what `--prose-sync` would
 *    write.
 *  - **A reason is mandatory, and must be a sentence.** The shape of the entry
 *    is an object, so `path` alone does not typecheck as an entry, and a reason
 *    under `MIN_EXEMPTION_REASON_CHARS` is treated as the placeholder it is.
 *    This mirrors `--prose-sync --retire`, which is the other place in this
 *    repository where an exemption has to be justified in the diff.
 *  - **The list is capped.** One artifact needs an exemption today. Reaching
 *    for a second one has to be a one-line edit to a named constant that says
 *    what it is for, which is the same defensive shape as
 *    `SPOTIFY_MCP_CONFIRM=never` being the only value that bypasses
 *    confirmation: the bypass should not be reachable by accident.
 *
 * ## When this exemption must be deleted
 *
 * The exemption is permanent in the sense that nothing expires it on a date.
 * It is not permanent in the sense that it survives losing its premise, and
 * that is the whole of the condition, in three parts. Delete the entry when
 * any of these becomes true:
 *
 *  1. `derivedFrom` stops naming a document this guard reads. The premise was
 *     "the source is read by this guard"; if the source leaves `CHANNEL_SURFACES`
 *     the derivation proves nothing and the entry must go.
 *  2. The exempted file stops quoting pinned prose from that source. The
 *     derivation test below reports it, and the fix is deletion, not a widened
 *     rule — an exemption nobody needs is one nobody notices widening.
 *  3. The file stops naming the retired channel at all. Also a deletion. An
 *     entry that survives its own justification is a free pass for the next
 *     person.
 *
 * Nothing else removes it, and nothing renews it. In particular, a reworded
 * `derivedFrom` paragraph does **not** require a new entry: `--prose-sync`
 * rewrites the label, the derivation still holds, and the guard stays green.
 * That asymmetry is deliberate — the bound is on the exemption becoming
 * unjustified, not on prose being edited.
 */
const DERIVED_SURFACES: readonly DerivedSurfaceExemption[] = [
  {
    path: 'scripts/doc-prose-manifest.json',
    derivedFrom: 'docs/distribution.md',
    reason:
      'It is a derived copy, not a surface: every string in it that names the '
      + 'retired channel is a `proseUnitLabel` of a pinned `docs/distribution.md` '
      + 'paragraph, and this guard already reads that document in full.',
  },
];

/**
 * How many derived surfaces may hold an exemption. One does.
 *
 * The cap is not a limit on how many artifacts *could* be exempt — it is the
 * friction that makes a second exemption a decision. Raising it is a one-line
 * edit to a constant whose name states the count, so it shows up in the diff of
 * whatever PR wanted the exemption and cannot be done as a side effect of
 * hitting a gate.
 */
const MAX_DERIVED_SURFACE_EXEMPTIONS = 1;

/**
 * A reason shorter than this is a placeholder, and a placeholder is what a list
 * carries when nobody had a reason. `--prose-sync --retire` has no floor either
 * — that is a real gap in the other mechanism, not a precedent for one here.
 */
const MIN_EXEMPTION_REASON_CHARS = 40;

/** Files permitted to mention the retired channel, and why each one is. */
const ALLOWED_TO_MENTION = new Set([POSTURE_DOC, ...DERIVED_SURFACES.map((e) => e.path)]);

/**
 * Surfaces that would make a reader (or a release job) believe a hosted
 * Smithery listing is live. `CHANGELOG.md` is absent on purpose — it is
 * generated by release-please and its history is not ours to rewrite.
 */
const CHANNEL_SURFACES = [
  'README.md',
  'package.json',
  'server.json',
  'knip.json',
  '.release-please-config.json',
  ...listFilesIn('.github'),
  ...listFilesIn('scripts'),
  ...listFilesIn('src'),
  ...listFilesIn('skills'),
  ...listFilesIn('docs'),
];

function listFilesIn(relativeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk(relativeDir);
  return out.sort();
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** The shape of the hand-maintained prose pin the derivation is proved against. */
type ProsePin = { files?: Record<string, { hash: string; label: string }[]> };

/**
 * Every string in a parsed JSON document that names the retired channel, keys
 * included.
 *
 * Keys are walked on purpose. In JSON a mention can only live inside a string,
 * so a key is a place a mention can hide from a values-only walk — and the
 * cheapest way to smuggle a sentence past a derivation check is to put it
 * somewhere the check does not look.
 */
function channelMentionsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (RETIRED_CHANNEL.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) channelMentionsIn(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      channelMentionsIn(key, out);
      channelMentionsIn(item, out);
    }
  }
  return out;
}

/**
 * Check every derived-surface exemption against the tree as it actually stands,
 * and return what is wrong with it.
 *
 * Three properties make the result evidence rather than decoration, and each
 * answers a way this could have been a test that cannot fail:
 *
 *  - **The verdict is derived, not declared.** A mention passes only if it is
 *    a label `proseUnitLabel()` produces from a paragraph of the entry's own
 *    `derivedFrom`, recomputed from the live document — not from the exempted
 *    file's own idea of what it should say, and not from a recomputation of the
 *    same fields the check is verifying. The pin is read too, so a paragraph
 *    that is real but no longer pinned is reported separately from one that was
 *    never derived at all.
 *  - **`mentions` is returned alongside `errors`.** An entry whose file stopped
 *    naming the channel yields zero errors here, which is indistinguishable
 *    from a scan that matched nothing. The count is what tells them apart, and
 *    the caller asserts on it — the same reason `proseDrift()` returns `files`.
 *  - **Both directions run over real inputs.** The caller asserts `[]` on the
 *    real tree and drives a non-empty result through this same function with
 *    planted mentions, so a check that always returned `[]` would fail the
 *    suite.
 */
function derivedSurfaceErrors(
  entries: readonly DerivedSurfaceExemption[],
  read: (relativePath: string) => string,
  pin: ProsePin,
): { errors: string[]; mentions: number } {
  const errors: string[] = [];
  let mentions = 0;

  for (const entry of entries) {
    let raw: string;
    try {
      raw = read(entry.path);
    } catch {
      errors.push(
        `${entry.path} holds a derived-surface exemption but cannot be read. An `
          + 'exemption naming a file that does not exist reports green forever. '
          + 'Delete the entry, or restore the file.',
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push(
        `${entry.path} holds a derived-surface exemption but is not valid JSON, so `
          + 'its mentions cannot be proved derived: '
          + `${(error as Error).message}. An exemption that cannot be checked is `
          + 'not an exemption.',
      );
      continue;
    }

    const found = channelMentionsIn(parsed);
    mentions += found.length;

    let source: string;
    try {
      source = read(entry.derivedFrom);
    } catch {
      errors.push(
        `${entry.path} claims to be derived from ${entry.derivedFrom}, which cannot `
          + 'be read. The exemption is sound only while its source is a document '
          + 'this guard reads, so it cannot be checked and must be deleted.',
      );
      continue;
    }

    // Recomputed from the live source, so the exempt file has no way to satisfy
    // this by describing itself. A mention that is a real, pinned label passes;
    // anything typed by hand does not.
    const labelToHash = new Map(
      splitProseUnits(source).map((unit) => [proseUnitLabel(unit), proseUnitHash(unit)]),
    );
    const pinned = new Set((pin.files?.[entry.derivedFrom] ?? []).map((row) => row.hash));

    for (const mention of found) {
      const hash = labelToHash.get(mention);
      if (hash === undefined) {
        errors.push(
          `${entry.path} names the retired channel in a string that is not derived `
            + `from ${entry.derivedFrom}: "${truncate(mention)}". A derived-surface `
            + 'exemption covers quoted pinned prose only — a label, a field, a key. '
            + 'Hand-written text here means the file is making its own claim, which '
            + 'is the thing this guard exists to stop. Delete the text, or delete the '
            + 'entry from DERIVED_SURFACES if this file is no longer derived.',
        );
        continue;
      }
      if (!pinned.has(hash)) {
        errors.push(
          `${entry.path} names the retired channel with a label that is derived from `
            + `${entry.derivedFrom} but whose paragraph (${hash}) is not pinned in `
            + 'scripts/doc-prose-manifest.json. The exemption is bounded on the '
            + 'paragraph being *pinned*, not merely present. Run '
            + '`npm run count:tools -- --prose-sync` to pin it, or delete the entry '
            + 'if the pin was retired deliberately.',
        );
      }
    }
  }

  return { errors, mentions };
}

/** Keep a planted sentence readable in a failure message without dumping it whole. */
function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

describe('retired hosted distribution channels (#710)', () => {
  it('carries no Smithery manifest', () => {
    assert.equal(
      existsSync(path.join(ROOT, RETIRED_MANIFEST)),
      false,
      `${RETIRED_MANIFEST} is back. This server's PKCE redirect is loopback-only ` +
        `(src/auth.ts), so a hosted instance can never receive the browser callback. ` +
        `Re-adding the file advertises a listing that cannot authenticate. If remote ` +
        `OAuth has been implemented since, re-open #710 rather than restoring the ` +
        `six-line version.`,
    );
  });

  it('treats no surface as a live Smithery channel but the posture doc', () => {
    const offenders = CHANNEL_SURFACES.filter(
      (file) => !ALLOWED_TO_MENTION.has(file) && RETIRED_CHANNEL.test(readRepoFile(file)),
    );
    assert.deepEqual(
      offenders,
      [],
      `Only ${[...ALLOWED_TO_MENTION].join(', ')} may name the retired channel `
        + `(${POSTURE_DOC} records the decision; the rest quote pinned prose from a `
        + `document this guard reads — see the derived-surface exemptions below). `
        + `These surfaces present it as live: ${offenders.join(', ')}.`,
    );
  });

  it('keeps every derived-surface exemption load-bearing', () => {
    // An exemption that no longer applies is not neutral — it is an
    // unexplained hole in a guard, and the next person to widen `DERIVED_SURFACES`
    // will point at it as precedent. So each one is required to still name the
    // token: an entry whose file no longer mentions the channel is a free pass
    // for whoever comes next, and the fix is deletion rather than a rule that
    // grows to accommodate it.
    for (const entry of DERIVED_SURFACES) {
      const mentions = channelMentionsIn(JSON.parse(readRepoFile(entry.path)));
      assert.ok(
        mentions.length > 0,
        `${entry.path} is exempted from the retired-channel scan but no longer names `
          + 'it. Remove it from DERIVED_SURFACES — an exemption nobody needs is an '
          + 'exemption nobody will notice widening.',
      );
    }
  });

  it('records the retired posture in the distribution doc', () => {
    const doc = readRepoFile(POSTURE_DOC);
    assert.match(
      doc,
      /not pursuing a hosted listing/i,
      `${POSTURE_DOC} must state that the hosted Smithery listing is not being ` +
        `pursued, so the decision is recorded rather than implied by a missing file.`,
    );
  });
});

/**
 * The bound on `DERIVED_SURFACES` (#1437).
 *
 * `DERIVED_SURFACES` is an exemption from a guard, and an exemption with no
 * bound on it is a standing invitation: the next person to hit a gate they
 * cannot satisfy has a documented, apparently-sanctioned way to make it go
 * away. The first version of this list was `string[]` with one assertion on it
 * — the file contains the token somewhere — which is not a bound at all. A
 * free-text field reading "Smithery is the supported deployment target" satisfies
 * it, so the guard would have gone green on a file making its own claim.
 *
 * These tests are the bound. They are grouped separately from the #710 suite
 * above because they guard a *mechanism* rather than a fact about the tree:
 * the clean tree has to pass through the same `derivedSurfaceErrors()` the
 * planted cases go through, so a comparison that returned `[]` unconditionally
 * fails here rather than reporting success forever.
 */
describe('derived-surface exemption is bounded (#1437)', () => {
  const pin = JSON.parse(readRepoFile('scripts/doc-prose-manifest.json')) as ProsePin;

  it('reads a non-empty set of mentions, so a scan that matched nothing cannot pass', () => {
    // Without this, a check that found zero mentions would be indistinguishable
    // from a clean one. The count is the evidence that the comparison ran over
    // real text rather than over an empty set.
    const { errors, mentions } = derivedSurfaceErrors(DERIVED_SURFACES, readRepoFile, pin);
    assert.deepEqual(errors, [], errors.join('\n'));
    assert.ok(
      mentions > 0,
      `derivedSurfaceErrors() found no mention of the retired channel in any exempted `
        + `file, so the clean verdict above is the same verdict a broken scan would `
        + `give. Exempted files: ${DERIVED_SURFACES.map((e) => e.path).join(', ')}.`,
    );
  });

  it('proves every mention is a pinned label of the document the entry declares', () => {
    const { errors } = derivedSurfaceErrors(DERIVED_SURFACES, readRepoFile, pin);
    assert.deepEqual(
      errors,
      [],
      `${errors.length} derived-surface exemption problem(s) on the real tree. `
        + 'Each means an exempted file is naming the retired channel in text this '
        + 'guard cannot trace to pinned prose in a document it already reads — see '
        + 'the "When this exemption must be deleted" comment on DERIVED_SURFACES.',
    );
  });

  it('rejects a hand-written mention that the old token-presence check accepted', () => {
    // The regression this issue is about, driven through the real comparison.
    // A retirement reason is the natural smuggling route: `--prose-sync` writes
    // free text there, and the old check could not tell a hand-written reason
    // from a generated label.
    const planted = JSON.stringify({
      files: {
        'docs/distribution.md': [{ hash: 'abc123', label: 'Something else' }],
      },
      retired: [
        {
          file: 'docs/distribution.md',
          reason:
            'rewrote the claim checklist; Smithery is now the recommended way to '
            + 'deploy this server',
        },
      ],
    });
    const { errors, mentions } = derivedSurfaceErrors(
      [{ path: 'artifact.json', derivedFrom: 'docs/distribution.md', reason: 'planted' }],
      (p) => (p === 'artifact.json' ? planted : readRepoFile(p)),
      { files: { 'docs/distribution.md': [{ hash: 'abc123', label: 'Something else' }] } },
    );

    assert.equal(mentions, 1, 'the planted mention was not found, so nothing was proved');
    assert.equal(errors.length, 1, `expected exactly one derived-surface error, got: ${errors.join(' | ')}`);
    assert.match(errors[0], /not derived from docs\/distribution\.md/);
  });

  it('separates a real-but-unpinned label from one that was never derived', () => {
    // Both states are silent in the old check. Reporting them as one message
    // would be the "a value that cannot be read coerced into a plausible
    // answer" bug (AGENTS.md §6): the two need different fixes — pin the
    // paragraph, or delete the entry.
    const source = readRepoFile('docs/distribution.md');
    const unpinned = channelMentionsIn(
      JSON.parse(readRepoFile('scripts/doc-prose-manifest.json')),
    );
    assert.ok(unpinned.length > 0, 'no mention to build the fixture from');

    const label = unpinned[0];
    const { errors } = derivedSurfaceErrors(
      [{ path: 'artifact.json', derivedFrom: 'docs/distribution.md', reason: 'planted' }],
      (p) => (p === 'artifact.json' ? JSON.stringify({ label }) : source),
      { files: {} },
    );

    assert.equal(errors.length, 1, `expected one error, got: ${errors.join(' | ')}`);
    assert.match(errors[0], /not pinned in scripts\/doc-prose-manifest\.json/);
  });

  it('rejects an exemption whose source this guard does not read', () => {
    for (const entry of DERIVED_SURFACES) {
      assert.ok(
        entry.derivedFrom === POSTURE_DOC || CHANNEL_SURFACES.includes(entry.derivedFrom),
        `${entry.path} claims to be derived from ${entry.derivedFrom}, which is not a `
          + `document this guard reads. The exemption's whole premise is that the `
          + `source is already covered; from an uncovered source it covers nothing. `
          + `Delete the entry, or add the source to the allowlist deliberately.`,
      );
    }
  });

  it('requires every entry to name a surface the scan actually reads', () => {
    // An exemption for a file outside `CHANNEL_SURFACES` is a no-op that reads
    // like a hole: it looks like an opening, and it opens nothing.
    for (const entry of DERIVED_SURFACES) {
      assert.ok(
        CHANNEL_SURFACES.includes(entry.path),
        `${entry.path} holds a derived-surface exemption but is not a scanned channel `
          + 'surface, so the exemption grants nothing. Add it to CHANNEL_SURFACES or '
          + 'delete the entry.',
      );
      assert.ok(
        existsSync(path.join(ROOT, entry.path)),
        `${entry.path} holds a derived-surface exemption but does not exist.`,
      );
    }
  });

  it('requires a stated reason long enough to be one', () => {
    for (const entry of DERIVED_SURFACES) {
      const reason = entry.reason.trim();
      assert.ok(
        reason.length >= MIN_EXEMPTION_REASON_CHARS,
        `${entry.path} holds a derived-surface exemption with a ${reason.length}-character `
          + `reason, under the ${MIN_EXEMPTION_REASON_CHARS} floor. A bare path is not a `
          + 'justification — the exemption is the thing the next person will point at, '
          + 'so it has to say why it is sound, in the diff.',
      );
    }
  });

  it('caps the list, so a second exemption is a deliberate edit', () => {
    assert.ok(
      DERIVED_SURFACES.length <= MAX_DERIVED_SURFACE_EXEMPTIONS,
      `DERIVED_SURFACES holds ${DERIVED_SURFACES.length} entries, over the cap of `
        + `${MAX_DERIVED_SURFACE_EXEMPTIONS} (`
        + `${DERIVED_SURFACES.map((e) => e.path).join(', ')}). Raising the cap is a `
        + 'deliberate edit to a named constant, and it should be one — but do it in '
        + 'the PR that adds the entry, and say what the new source is.',
    );
  });
});

describe('area:distribution labeler paths (#710)', () => {
  it('names only files that exist', () => {
    const labeler = readRepoFile('.github/labeler.yml');
    // The section is the run of indented lines beneath its key.
    const section = labeler.match(/^area:distribution:\n((?:[ \t].*\n?)*)/m);
    assert.ok(section, '.github/labeler.yml no longer has an area:distribution section');

    const globs = [...section![1].matchAll(/any-glob-to-any-file:\s*(\S+)/g)].map(
      (m) => m[1],
    );
    assert.ok(globs.length > 0, 'area:distribution matches no paths at all');

    const missing = globs
      .map((glob) => glob.split('*')[0].replace(/\/+$/, ''))
      .filter((literal) => literal !== '' && !existsSync(path.join(ROOT, literal)));
    assert.deepEqual(
      missing,
      [],
      `area:distribution globs point at paths that do not exist: ${missing.join(', ')}. ` +
        `A retired manifest leaves a dead glob behind; that is what this catches.`,
    );
  });
});
