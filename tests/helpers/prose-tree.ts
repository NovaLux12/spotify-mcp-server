/**
 * The tree a test claims to be syncing the prose pin against (#1440).
 *
 * `--prose-sync` reads the real working tree and refuses when it cannot vouch
 * for it — a dirty pinned document, or a branch that does not contain
 * `origin/main` (see `tests/prose-provenance.test.ts` for why). That is the
 * behaviour under test, and it is also a fact about the machine the suite runs
 * on: this repository has roughly twenty agents working in sibling worktrees,
 * and a test that asserted success without saying which tree it meant would go
 * red on a contributor's machine because somebody else had a document open.
 *
 * So every test that drives `--prose-sync` states its tree through
 * `--prose-provenance`, and the constant below is the one that means "a clean
 * tree on a branch that already contains `origin/main`" — the ordinary case
 * where a sync should simply work. Tests that are *about* a stale tree build
 * their own reading from this one by spreading it and changing the field they
 * are exercising, so a new field added here cannot silently change what an
 * unrelated test is proving.
 *
 * This is a substitute for the *reading*, not for the decision: the refusal
 * code in `scripts/surface-census.mjs` is reached either way, which is the
 * whole point — a correct check that is never reached is the failure this issue
 * is about.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A real commit, an `origin/main` it already contains, nothing uncommitted, on a branch. */
export const CLEAN_TREE = {
  usable: true,
  head: 'a'.repeat(40),
  upstream: 'b'.repeat(40),
  behind: false,
  detached: false,
  dirty: [] as string[],
  note: '',
};

/**
 * Write a provenance reading where the census CLI can be pointed at it.
 *
 * Returns the path rather than taking one, so the call site reads
 * `--prose-provenance ${await writeProvenanceFile(dir, CLEAN_TREE)}` and the
 * scratch directory stays the only thing a test has to name.
 */
export async function writeProvenanceFile(dir: string, reading: Record<string, unknown> = CLEAN_TREE): Promise<string> {
  const path = join(dir, 'provenance.json');
  await writeFile(path, JSON.stringify(reading, null, 2));
  return path;
}
