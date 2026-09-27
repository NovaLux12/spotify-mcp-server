#!/usr/bin/env node
/**
 * Mutation harness for the #872 fix.
 *
 * A mutation that silently fails to apply is indistinguishable from a passing
 * test: the run goes green, and green is the thing the mutation was supposed
 * to take away. So every mutation here:
 *
 *   - ASSERTS its anchor matched exactly once, and aborts the run loudly if it
 *     did not (a 0-match anchor is a mutation that never happened);
 *   - prints the post-mutation state of the file it wrote, and aborts if the
 *     replacement is not present in that file on disk;
 *   - aborts the run if the mutated suite is GREEN, because GREEN here means
 *     the regression tests do not pin that behaviour;
 *   - restores the file afterwards and asserts the restore.
 *
 * `confirm.ts` is mutated as well as `playlists.ts`: the question #872 has to
 * answer is whether the shared fail-closed guard still fails closed, and only a
 * mutation of that file answers it.
 *
 * Run: node scripts/x872-mutate.mjs [mutation-name ...]   (all when omitted)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  src: join(REPO, 'src/tools/playlists.ts'),
  confirm: join(REPO, 'src/tools/confirm.ts'),
};
const TEST = 'tests/tools.playlist-overwrite-gate.test.ts';

/**
 * The unique anchor for the trim gate's refusal block. The comment above it is
 * the handle: `if (refusal) return textResult(...)` on its own occurs seven
 * times in this module.
 */
const REFUSAL_BLOCK = `      // Fails closed: declined, cancelled, a mid-flight elicitation error, and
      // a client that cannot prompt all stop before the first PUT. Only an
      // explicit accept — or SPOTIFY_MCP_CONFIRM=never — writes.
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) return textResult(refusal.message, refusal.payload);`;

/** The unique anchor for the trim gate itself. */
const GATE_OPEN = `if (destructive) {
      const changes = [
        \`Overwrite ALL \${rowCount} existing item(s)`;

/** name -> { file, anchor, replacement, why } */
const MUTATIONS = {
  // 1. Remove the trim gate entirely — the pre-#872 behaviour, verbatim.
  'trim-gate-removed': {
    file: 'src',
    anchor: GATE_OPEN,
    replacement: `if (false) {
      const changes = [
        \`Overwrite ALL \${rowCount} existing item(s)`,
    why: 'the trim overwrite is never confirmed',
  },

  // 2. Confirm without asking: a gate that only LOOKS like a gate. This is
  //    the mutation that proves the tests check for the PROMPT, not merely for
  //    the absence of a throw.
  'trim-confirms-without-prompting': {
    file: 'src',
    anchor: `const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('replace playlist items', playlistId, changes),
      });`,
    replacement: `const verdict = 'confirmed' as const;`,
    why: 'the write is confirmed without ever asking the human',
  },

  // 3. Let the unpromptable client through at the call site.
  'trim-unsupported-verdict-proceeds': {
    file: 'src',
    anchor: REFUSAL_BLOCK,
    replacement: REFUSAL_BLOCK.replace(
      'if (refusal) return textResult(refusal.message, refusal.payload);',
      "if (refusal && verdict !== 'unsupported') return textResult(refusal.message, refusal.payload);",
    ),
    why: "a client that advertised no elicitation capability is served instead of refused",
  },

  // 4. Render the refusal and write anyway — "warn, then do it". Every
  //    message-only assertion would pass this.
  'trim-refusal-still-writes': {
    file: 'src',
    anchor: REFUSAL_BLOCK,
    replacement: REFUSAL_BLOCK.replace(
      'if (refusal) return textResult(refusal.message, refusal.payload);',
      'if (refusal) { /* mutated: report the refusal, then write anyway */ }',
    ),
    why: 'a declined prompt is reported and then ignored',
  },

  // 5. The shared guard stops failing closed: ANY unsupported verdict proceeds.
  //    This is the "did we widen the bypass" question, asked of confirm.ts.
  'confirm-unsupported-always-proceeds': {
    file: 'confirm',
    anchor: "if (verdict === 'unsupported' && process.env.SPOTIFY_MCP_CONFIRM === 'never') return null;",
    replacement: "if (verdict === 'unsupported') return null;",
    why: 'a client that cannot prompt is served without SPOTIFY_MCP_CONFIRM=never',
  },

  // 6. The bypass value itself is loosened from `never` to any non-empty value.
  'confirm-bypass-value-widened': {
    file: 'confirm',
    anchor: "if (verdict === 'unsupported' && process.env.SPOTIFY_MCP_CONFIRM === 'never') return null;",
    replacement: "if (verdict === 'unsupported' && process.env.SPOTIFY_MCP_CONFIRM) return null;",
    why: 'any SPOTIFY_MCP_CONFIRM value, not exactly "never", disables the gate',
  },

  // 7. The mid-flight failure becomes a proceed.
  'confirm-elicitation-failure-proceeds': {
    file: 'confirm',
    anchor: `  } catch {
    // The prompt was attempted and failed — a dead gate must not become an
    // ungated write (#684). Callers refuse on 'error'.
    return 'error';
  }`,
    replacement: `  } catch {
    return 'confirmed';
  }`,
    why: 'a prompt that dies on the wire is treated as an acceptance',
  },

  // 8. Restore the pre-#872 no-op: compare the URI-filtered walk to `keep`.
  //    This is the false "nothing to trim" claim on a playlist bigger than the
  //    walk cap.
  'trim-noop-ignores-the-walk-cap': {
    file: 'src',
    anchor: 'if (readWhole && rowCount <= args.keep) {',
    replacement: 'if (uris.length <= args.keep) {',
    why: 'a capped read is reported as an already-trimmed playlist',
  },

  // 9. Drop the pre-write re-read, so a plan nobody saw can still be committed.
  'trim-recheck-removed': {
    file: 'src',
    anchor: `if (latest.rowCount !== rowCount || latest.uris.join('\\n') !== uris.join('\\n')
      || latest.unavailablePositions.join('\\n') !== unavailablePositions.join('\\n')
      || latestReadWhole !== readWhole) {`,
    replacement: 'if (false) {',
    why: 'a playlist edited while the prompt was open is overwritten anyway',
  },

  // 10. Put the old description back — the issue's original complaint, that
  //     these tools never name the overwrite they perform.
  'trim-description-unnames-the-overwrite': {
    file: 'src',
    anchor: "'Trim playlist to N items (keep first/last/random) by OVERWRITING the playlist: every row outside the kept set is DELETED, and the kept rows are re-written in the new order. An overwrite that deletes rows asks for confirmation first. Quota: 2 walks of the playlist items + 2 metadata GETs + PUT/POST.'",
    replacement: "'Trim playlist to N items (keep first/last/random). Quota: GET all + PUT/POST.'",
    why: 'the description hides the overwrite and quotes a cost it does not pay',
  },

  // 11. Same, for the subtract description the issue also named.
  'subtract-description-unnames-the-overwrite': {
    file: 'src',
    anchor: "'Remove tracks of B..N from A by REWRITING A: one PUT replaces every row with the ones that survive, so any row of A absent from the union is DELETED, and the rows that remain are re-written in order.",
    replacement: "'Remove tracks of B..N from A.",
    why: 'the description says it removes tracks without saying it rewrites the base',
  },
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(MUTATIONS);
for (const name of names) {
  if (!MUTATIONS[name]) {
    console.error(`ABORT: unknown mutation "${name}"`);
    process.exit(2);
  }
}

const originals = Object.fromEntries(
  Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, 'utf8')]),
);
let failed = false;
const results = [];

for (const name of names) {
  const { file, anchor, replacement, why } = MUTATIONS[name];
  const path = FILES[file];
  const original = originals[file];
  const occurrences = original.split(anchor).length - 1;
  if (occurrences !== 1) {
    console.error(`ABORT: mutation "${name}" anchor matched ${occurrences} times in ${file}, expected exactly 1`);
    failed = true;
    continue;
  }
  const mutated = original.replace(anchor, replacement);
  if (mutated === original) {
    console.error(`ABORT: mutation "${name}" produced no change (silent no-op)`);
    failed = true;
    continue;
  }
  writeFileSync(path, mutated);
  const onDisk = readFileSync(path, 'utf8');
  const landed = onDisk === mutated && onDisk.includes(replacement);
  console.log(`\n=== mutation ${name} (${file}) — ${why} ===`);
  console.log(`    anchor matched: ${occurrences} | replacement on disk after write: ${landed}`);
  if (!landed) {
    console.error(`ABORT: mutation "${name}" did not land in ${file}`);
    failed = true;
    continue;
  }
  let red = false;
  let detail = '';
  try {
    execFileSync('npx', ['tsx', '--test', TEST], { cwd: REPO, stdio: 'pipe' });
    detail = 'GREEN';
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    detail = `RED (${(out.match(/^✖ /gm) ?? []).length} failing test(s))`;
    red = true;
  }
  console.log(`    RESULT: ${detail}`);
  if (!red) {
    console.error(`    NOT DETECTED: the regression tests pass without this fix`);
    failed = true;
  }
  results.push({ name, file, result: red ? 'RED' : 'GREEN' });
  writeFileSync(path, original);
}

for (const [k, p] of Object.entries(FILES)) {
  const restored = readFileSync(p, 'utf8') === originals[k];
  console.log(`\nsource restored (${k}): ${restored}`);
  if (!restored) {
    console.error(`ABORT: ${p} was not restored`);
    failed = true;
  }
}
console.log('\n| mutation | file | result |');
console.log('|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.file} | ${r.result} |`);
if (failed) {
  console.error('\nMUTATION RUN FAILED — see the ABORT / NOT DETECTED lines above.');
  process.exit(1);
}
console.log('\nall mutations RED — every claim in the fix is pinned by a test.');
