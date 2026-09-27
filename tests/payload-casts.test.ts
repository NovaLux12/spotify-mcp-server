/**
 * The `as unknown as` / `: any` ratchet (#1202).
 *
 * `scripts/check-no-explicit-any.mjs` took `as any` under `src/tools` to zero
 * (#758). What it deliberately left alone is the *other* escape hatch, and
 * #1202 is the remainder of that audit: `as unknown as T` asserts a shape the
 * compiler never saw, and `: any` turns the check off for a value without even
 * naming a shape. `AGENTS.md` §6 is why both are worth a gate rather than a
 * style preference — `library_hygiene` and `saved_dedupe` declared `ok: true`
 * as a literal type and cast a payload saying `ok: false`; `get_playlist_added_dates`
 * laundered an unreadable `added_at` through a cast into `''`, which sorts
 * before every real date.
 *
 * This is a **ratchet**, not a sweep. Each class is counted per file, every
 * file that still holds a count is listed in `BASELINE` with the reason it
 * cannot move yet, and any file not in the table must be at zero. A new cast
 * anywhere is a new entry or a failed build — there is no way to add one
 * quietly. Lowering a number is the whole point; the table moves down and never
 * up.
 *
 * The counts run over `blankNonCode` so a cast *named in a comment* is not a
 * cast. Three of this file's own comment lines mention the patterns, and an
 * earlier draft of this table counted them.
 *
 * Run: node --import tsx --test tests/payload-casts.test.ts
 */

import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../scripts/blank-non-code.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/**
 * A cast that names a SPECIFIC shape on the far side of untrusted JSON.
 *
 * `as unknown as Record<string, unknown>` is excluded on purpose, and this is
 * the distinction the repo already drew in `tests/structuredcontent-boundary.test.ts`:
 * widening a payload to the wire's own `Record<string, unknown>` asserts nothing
 * the reader did not already believe, and `structuredContent()` in `src/shaping.ts`
 * is the blessed form of it. Naming `SpotifyTrackWithReleaseDate` on the far side
 * is a claim about a shape nobody checked.
 */
const SPECIFIC_SHAPE = /as\s+unknown\s+as\s+(?!Record<string, unknown>|unknown\b)/g;

/** A `: any` annotation — a value whose checking is off without a shape being claimed. */
const ANY_ANNOTATION = /:\s*any\b/g;

/** An angle-bracket cast to `any`. */
const ANY_ANGLE = /<any>/g;

export interface CastCounts {
  specificShape: number;
  anyAnnotation: number;
  anyAngle: number;
}

/** Count the three classes in one file's CODE, comments blanked. */
export function countPayloadCasts(source: string): CastCounts {
  const code = blankNonCode(source);
  return {
    specificShape: [...code.matchAll(SPECIFIC_SHAPE)].length,
    anyAnnotation: [...code.matchAll(ANY_ANNOTATION)].length,
    anyAngle: [...code.matchAll(ANY_ANGLE)].length,
  };
}

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) out.push(...sourceFiles(file));
    else if (file.endsWith('.ts')) out.push(file);
  }
  return out.sort();
}

/** Every `.ts` under `src/`, keyed by its repo-relative path. */
function measured(): Map<string, CastCounts> {
  const map = new Map<string, CastCounts>();
  for (const file of sourceFiles(SRC)) {
    map.set(relative(ROOT, file), countPayloadCasts(readFileSync(file, 'utf8')));
  }
  return map;
}

/**
 * The ceiling per file, and why it is still there.
 *
 * `null` for any class means zero, and zero means the file is absent from the
 * table. Every entry is a deliberate decision, not a leftover.
 */
const BASELINE: Record<string, { specificShape?: number; anyAnnotation?: number; anyAngle?: number; reason: string }> = {
  'src/tools/annotations.ts': {
    specificShape: 7,
    reason:
      'Five reach a private field on the SDK server or its low-level server — the tool registry, the prompt registry, ' +
      'the request-handler map — and one more reads `__spotifyModuleSchemaBudgets`, a field this module sets itself. ' +
      'The last is the error boundary returning `ServerResult`. None of them is a Spotify payload: they are internal to ' +
      'this process. Four of the five `_registeredTools` reads now go through `registeredToolEntries` / ' +
      '`schemaRegistryEntries`, which is the change this row\'s earlier wording predicted was separate; the fifth reads ' +
      'an intersection of both entry shapes for the annotation pass and still declares its own. Two functions rather than ' +
      'one generic on purpose — `readRegistry<T>()` would name its result type once and return whatever was asked for.',
  },
  'src/gating.ts': {
    specificShape: 5,
    reason:
      'Five casts onto the SDK client and onto the error objects the gate itself creates: `client as unknown as ' +
      'Record<string, unknown>` to swap `client.get` for a wrapper, and `err as unknown as GatedPathAnnotation` to ' +
      'stamp fields this module then reads back. The stamped errors are built here, so the shape is not a claim ' +
      'about anything off the wire.',
  },
  'src/tools/statsfm_taste.ts': {
    specificShape: 1,
    anyAnnotation: 3,
    anyAngle: 1,
    reason:
      'The `specificShape` cast is the stub-server shim used by the toolset tests, and the three `: any` / one ' +
      '`<any>` are that same shim\'s `handler: (args: any) => Promise<any>` signature plus its `params`/`handler` ' +
      'parameters. Left for the module that owns the shim, not here.',
  },
  'src/tools/swarm3_meta.ts': {
    specificShape: 2,
    reason:
      'Both reach the private `_registeredTools` and `__spotifyModuleSchemaBudgets` fields on the server object — ' +
      'the same internal-registry read as `annotations.ts`, in a second module. One accessor would serve both.',
  },
  'src/cancellation.ts': { specificShape: 1, reason: 'Reaches a private field on the SDK server to read the in-flight request map. Not a Spotify payload.' },
  // `src/index.ts` held a row here for the tool-naming policy check's private
  // registry read. That call site now goes through `registeredToolNames()` in
  // `src/tools/annotations.ts` — the one place that reads the field — so the
  // row is deleted rather than moved. A ratchet that gets edited upward to
  // accommodate a move is not a ratchet.
  'src/progress.ts': { specificShape: 1, reason: 'Reaches the SDK server\'s private tool registry to attach progress notifications. Not a Spotify payload.' },
  'src/tools/doctortool.ts': { specificShape: 1, reason: 'Same private-registry read as `annotations.ts`, for the diagnostic report.' },
  'src/tools/playbackintel.ts': {
    anyAnnotation: 24,
    anyAngle: 1,
    reason:
      'The largest `: any` concentration left, and every one of the 24 is a `client.get(...)` / `client.getAllPages(...)` ' +
      'result read through `any` — payload reads, which is why they are the next target rather than the last. This ' +
      'change fixed the four modules where one shared reader could be written and proven; `playbackintel.ts` reads ' +
      'player state, a queue, a search result and four entity types, and each needs its own shape decided against ' +
      'the wire rather than against a guessed type. Doing it as a batch here is exactly the shallow sweep the ' +
      'scope note warns against.',
  },
};

describe('payload-cast ratchet (#1202)', () => {
  it('the collector counts the three classes and ignores comments', () => {
    // A ratchet whose collector silently stopped matching would pass forever.
    // Drive it over positive and negative controls, including the comment case
    // that produced a wrong number the first time this table was written.
    const cases: Array<[string, CastCounts]> = [
      ['const x = payload as unknown as AnalysisResult;', { specificShape: 1, anyAnnotation: 0, anyAngle: 0 }],
      ['const y = row.item as unknown as Record<string, unknown> | null;', { specificShape: 0, anyAnnotation: 0, anyAngle: 0 }],
      ['const z = p as unknown as Record<string, unknown>;', { specificShape: 0, anyAnnotation: 0, anyAngle: 0 }],
      ['const w = v as unknown as unknown;', { specificShape: 0, anyAnnotation: 0, anyAngle: 0 }],
      ['const h = (r: any) => r.a;', { specificShape: 0, anyAnnotation: 1, anyAngle: 0 }],
      ['const t = data as any;', { specificShape: 0, anyAnnotation: 0, anyAngle: 0 }],
      ['const u = client.get<any>(path);', { specificShape: 0, anyAnnotation: 0, anyAngle: 1 }],
      ['// const a = payload as unknown as AnalysisResult;', { specificShape: 0, anyAnnotation: 0, anyAngle: 0 }],
      ['/* const b: any = 1; */', { specificShape: 0, anyAnnotation: 0, anyAngle: 0 }],
      ["const c = 'as unknown as Nothing';", { specificShape: 0, anyAnnotation: 0, anyAngle: 0 }],
    ];
    for (const [source, expected] of cases) {
      assert.deepEqual(countPayloadCasts(source), expected, `misclassified: ${source}`);
    }
  });

  it('every file holding a cast is in BASELINE, with a stated reason', () => {
    const offenders: string[] = [];
    for (const [file, counts] of measured()) {
      const total = counts.specificShape + counts.anyAnnotation + counts.anyAngle;
      if (total > 0 && !(file in BASELINE)) {
        offenders.push(
          `${file}: specificShape=${counts.specificShape} anyAnnotation=${counts.anyAnnotation} anyAngle=${counts.anyAngle}`,
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `A file holds a payload cast and is not in the ratchet table. Add it with a reason, or remove the cast — ` +
        `a cast cannot be added without a decision recorded here:\n${offenders.join('\n')}`,
    );
  });

  it('every BASELINE entry is still a live file with a reason, and holds a count', () => {
    const files = measured();
    const stale: string[] = [];
    for (const [file, entry] of Object.entries(BASELINE)) {
      if (!files.has(file)) stale.push(`${file}: listed in BASELINE but the file does not exist`);
      else {
        const counts = files.get(file)!;
        const held = counts.specificShape + counts.anyAnnotation + counts.anyAngle;
        if (held === 0) stale.push(`${file}: listed in BASELINE but holds no casts — delete the entry`);
      }
      if (entry.reason.trim().length < 40) stale.push(`${file}: needs a real reason, not a placeholder`);
    }
    assert.deepEqual(stale, [], `stale ratchet rows:\n${stale.join('\n')}`);
  });

  it('no file exceeds its ratchet ceiling', () => {
    const over: string[] = [];
    for (const [file, entry] of Object.entries(BASELINE)) {
      const counts = measured().get(file);
      if (!counts) continue;
      for (const cls of ['specificShape', 'anyAnnotation', 'anyAngle'] as const) {
        const ceiling = entry[cls] ?? 0;
        if (counts[cls] > ceiling) over.push(`${file}: ${cls} is ${counts[cls]}, ceiling ${ceiling}`);
      }
    }
    assert.deepEqual(
      over,
      [],
      `A payload cast was added above its ratchet ceiling, and raising the ceiling is not the fix. Which remedy applies ` +
        `depends on what the cast reaches, and the two are not interchangeable. A cast onto a SPOTIFY payload — the ` +
        `kind that reaches the wire — is fixed by widening src/types/spotify.ts, or by narrowing the read through ` +
        `readString / readNumber / asRecord, so the value is marked rather than defaulted. A cast onto a private field ` +
        `of the SDK server or its low-level server reaches nothing on the wire; it is fixed by routing every reader of ` +
        `that field through one named accessor, so the shape is declared once instead of at each site. Check which one ` +
        `you are looking at before picking a remedy:\n${over.join('\n')}`,
    );
  });

  it('the modules this change cleaned are at zero and cannot go back up', () => {
    // The specific rows are already covered by the ceiling test; this one names
    // them so a reader of a future failure knows which fixes these were, and so
    // deleting a BASELINE entry is itself a visible act.
    const cleaned = [
      'src/tools/exhaustmisc.ts',
      'src/tools/playlisthealth.ts',
      'src/tools/swarm3_library.ts',
      'src/tools/swarm3_analytics.ts',
      'src/tools/queueops.ts',
      'src/types/spotify.ts',
    ];
    const files = measured();
    const dirty: string[] = [];
    for (const file of cleaned) {
      const counts = files.get(file);
      if (!counts) { dirty.push(`${file}: missing`); continue; }
      const total = counts.specificShape + counts.anyAnnotation + counts.anyAngle;
      if (total > 0) dirty.push(`${file}: ${total} cast(s) came back`);
      if (file in BASELINE) dirty.push(`${file}: is back in the ratchet table`);
    }
    assert.deepEqual(dirty, [], `a cleaned module regressed:\n${dirty.join('\n')}`);
  });

  it('totals are at or below the numbers measured at main when this landed', () => {
    // #1202 was filed with raw-grep counts taken over comments as well as code,
    // and they have moved since. These are the CODE-ONLY totals measured at
    // `origin/main` (f3b6ee80) with this file's own collector — the real current
    // figures, not the filing's. Where they differ from the issue, they are
    // lower for the raw-grep reason and, in one case, higher:
    //
    //   specific-shape `as unknown as`  issue 114 → measured 24
    //   `: any` annotations             issue  38 → measured 28
    //   `<any>` casts                   issue   1 → measured  2
    //
    // The last one is the issue UNDERCOUNTING: there are two angle-bracket
    // casts on main, not one — `statsfm_taste.ts:838` (which the issue names)
    // and `playbackintel.ts:491`. Ratcheting to the filing's 1 would have
    // failed the build on arrival, which is a good way to be wrong loudly.
    const files = measured();
    let specificShape = 0;
    let anyAnnotation = 0;
    let anyAngle = 0;
    for (const counts of files.values()) {
      specificShape += counts.specificShape;
      anyAnnotation += counts.anyAnnotation;
      anyAngle += counts.anyAngle;
    }
    const atMain = { specificShape: 24, anyAnnotation: 28, anyAngle: 2 };
    assert.ok(
      specificShape <= atMain.specificShape,
      `specific-shape \`as unknown as\` grew past the main baseline: ${specificShape} > ${atMain.specificShape}`,
    );
    assert.ok(
      anyAnnotation <= atMain.anyAnnotation,
      `\`any\` annotations grew past the main baseline: ${anyAnnotation} > ${atMain.anyAnnotation}`,
    );
    assert.ok(anyAngle <= atMain.anyAngle, `\`<any>\` casts grew past the main baseline: ${anyAngle} > ${atMain.anyAngle}`);
  });
});
