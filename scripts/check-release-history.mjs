#!/usr/bin/env node
/**
 * Release-history gate (#932) — the CLI half.
 *
 * `CHANGELOG.md` is generated. release-please reads its anchor from
 * `.github/release-please-manifest.json`, diffs the Conventional Commits since
 * that version, and writes one section per release. Nothing checked that the
 * result still describes what was actually tagged, so a release whose manifest
 * update never landed produced a tag with no section and the repository said
 * nothing about it. That happened four times here: `v1.27.0`, `v1.27.1`,
 * `v1.28.0` and `v1.28.1` are tagged, and none of them is in the changelog.
 *
 * **The fix is this gate, not an edit to CHANGELOG.md.** Those four gaps cannot
 * be closed by writing the sections — release-please computes each one from the
 * commits between two releases, and those release commits either never existed
 * (`chore: bump version to 1.27.0`) or never updated the manifest (the two
 * `chore(main): release 1.28.x` commits touched package.json, package-lock.json
 * and server.json, and not `.github/release-please-manifest.json`; #547,
 * "sync release-please manifest with package.json (1.28.1)", repaired it, which
 * is why release-please resumed emitting sections at 1.28.2). Backfilling by
 * hand would also break the rule that the changelog is only ever written by a
 * release PR, and it would put a reconstruction in the file where a record
 * belongs. The four are therefore listed in `scripts/release-history.mjs` with
 * the commit that explains each, and this gate fails on the *next* gap.
 *
 * Three directions, because each catches a different failure:
 *
 * - a tag with no section — a release nobody can read the history of;
 * - a section with no tag — a changelog entry for something never released.
 *   The single exemption is the version currently in `package.json`: that is
 *   the release PR in flight, whose tag the merge will create, and CI runs on
 *   the PR before that merge. Exempting it is what lets the gate sit in the
 *   same workflow as the release it is checking.
 * - a `package.json` version with no section — a release that bumped the
 *   package and the manifest but wrote no section.
 *
 * `--tags-file <path>`, `--changelog <path>` and `--package <path>` drive the
 * same comparison over fixtures, so the gate can be proved to fire without
 * creating a tag. The script exits non-zero when it can see no tags at all:
 * `actions/checkout` defaults to `fetch-depth: 1` and fetches none, and a gate
 * that passes because it read an empty list is worse than no gate.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changelogVersions, releaseHistoryErrors, tagVersions, unrecordableReleases } from './release-history.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function flagValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const tagsPath = flagValue('--tags-file');
const changelogPath = flagValue('--changelog') ?? join(ROOT, 'CHANGELOG.md');
const packagePath = flagValue('--package') ?? join(ROOT, 'package.json');

const tags = tagsPath
  ? readFileSync(tagsPath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  : execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

const changelogSource = readFileSync(changelogPath, 'utf8');
const packageVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version;

// A gate that read an empty tag list would pass without having checked
// anything, which reads as coverage. `actions/checkout` defaults to
// `fetch-depth: 1` and fetches no tags, so a shallow CI clone hits exactly
// this. CI runs `git fetch --tags` first; a local clone that has not is told
// so rather than being given a green result.
if (tags.length === 0) {
  console.error(
    'Release-history check found no v* tags, so it compared nothing. A shallow clone (`actions/checkout` defaults to `fetch-depth: 1`) fetches none; run `git fetch --tags` first.',
  );
  process.exit(1);
}

const errors = releaseHistoryErrors({ tags, changelog: changelogSource, packageVersion });
if (errors.length > 0) {
  console.error(`Release-history check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n${errors.map((line) => `- ${line}`).join('\n')}`);
  console.error('CHANGELOG.md is generated: fix a missing section in the release process, never by editing the file.');
  process.exit(1);
}

const { versions } = changelogVersions(changelogSource);
const explained = unrecordableReleases();
console.log(
  `Release history is consistent: ${tagVersions(tags).size} release tags, ${versions.size} CHANGELOG sections, newest ${packageVersion}.`,
);
if (explained.length > 0) {
  console.log(
    `${explained.length} tagged release(s) have no section by construction and are recorded as such: ${explained.map((entry) => entry.version).join(', ')}.`,
  );
}
