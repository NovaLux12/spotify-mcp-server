/**
 * Issue #758, acceptance criterion 2, plus the dead-local half of the same
 * issue: source-text guards over `src/` for the two ways a tool module stops
 * being checked at the boundary where a Spotify payload is read.
 *
 * 1. `as any` — an assertion that erases the type of a value the moment it is
 *    read, which is exactly where the A7-001/A7-002-class reader drift
 *    survives review (#758). The three casts this issue removed were all of
 *    this shape: a field the shared types already model (`SavedTrackItem.track`
 *    IS a `SpotifyTrack`, and that models `album`) read through `as any` so a
 *    rename on either side could not fail the build.
 * 2. A bare `void x;` discard — the statement that made a reader believe a
 *    quota path was handled. The `quotaHit` it papered over in `backup.ts` was
 *    non-null only on a path that had already returned (#758). A discard that
 *    states its reason on the same line is fine (two exist, both documented);
 *    a bare one is not.
 *
 * A per-behaviour test cannot catch either class: both are about what the
 * source does NOT check. So this asserts the structural invariant across the
 * tree, the same source-text evidence pattern
 * `tests/tools.playlist-visibility-grep.test.ts` uses.
 *
 * Not covered, and deliberately so: `: any` annotations (34 in `src/tools`,
 * 30 of them in `playbackintel.ts`) are a separate drain — that module reads
 * untyped `client.get()` results into `any` locals, so its casts go when the
 * locals are typed, not before. `as unknown as T` is a real assertion against a
 * named type and is left alone.
 *
 * Run: node --import tsx --test tests/payload-shape-cast-guard.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TOOLS_DIR = join(SRC_DIR, 'tools');

/** A value re-typed to `any`, i.e. checking switched off at the read. */
const AS_ANY = /\bas\s+any\b/;

/** `void x;` with nothing after it — a discard that explains nothing. */
const BARE_VOID_DISCARD = /^\s*void\s+[A-Za-z_$][\w$]*\s*;\s*$/;

/**
 * Ceilings, per module, for the `as any` reads still to drain (#758 sweep).
 * Every other file under `src/` must be at zero, and a listed module must
 * still be above zero: an entry that reaches zero is stale bookkeeping and
 * gets deleted, so a ceiling can only ever tighten.
 *
 * - `playbackintel.ts` (16): casts on `client.get()` results assigned to
 *   untyped `any` locals, plus a duck-typed `loadPlaybackExt().catch()`.
 * - `playbackext.ts` (4): `detectSessions(raw as any)` and two reads of a
 *   `client.post<{id,uri}>` result through `as any`.
 * - `playlists.ts` (2): `clean_all_playlists` reading its own `dry_run` /
 *   `apply` arguments through `as any`.
 */
const AS_ANY_CEILINGS: Record<string, number> = {
  'playbackintel.ts': 16,
  'playbackext.ts': 4,
  'playlists.ts': 2,
};

/** The `as any` ceiling for a src-relative path; 0 for everything unlisted. */
function ceilingFor(name: string): number {
  return AS_ANY_CEILINGS[name.replace(/^tools\//, '')] ?? 0;
}

/**
 * Remove comments and string/template literals so the cast guard matches CODE.
 *
 * Comment text is documentation, and a module is allowed to say in prose that
 * it used to carry a cast. Quoted text is stripped for the same reason: a
 * payload-shape name inside a string is not a cast either. The scanner tracks
 * quote state so a `//` inside a URL string does not swallow the rest of the
 * line — the one way a naive strip would hide a real hit.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = '';
  let inBlock = false;
  for (const line of src.split('\n')) {
    let clean = '';
    let i = 0;
    let quote: string | null = null;
    while (i < line.length) {
      const two = line.slice(i, i + 2);
      if (inBlock) {
        if (two === '*/') { inBlock = false; i += 2; } else { i += 1; }
        continue;
      }
      if (quote) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === quote) { quote = null; }
        i += 1;
        continue;
      }
      if (two === '/*') { inBlock = true; i += 2; continue; }
      if (two === '//') break;
      if (line[i] === "'" || line[i] === '"' || line[i] === '`') { quote = line[i]!; i += 1; continue; }
      clean += line[i];
      i += 1;
    }
    out += `${clean}\n`;
  }
  return out;
}

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesIn(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

function relative(file: string): string {
  return file.slice(SRC_DIR.length + 1);
}

function format(hits: Array<{ line: number; text: string }>): string {
  return hits.map((h) => `L${h.line} ${h.text}`).join(' | ');
}

export function asAnyHits(src: string): Array<{ line: number; text: string }> {
  return stripCommentsAndStrings(src)
    .split('\n')
    .flatMap((text, i) => (AS_ANY.test(text) ? [{ line: i + 1, text: text.trim() }] : []));
}

/**
 * Discards are matched on the RAW line, comments included: what separates a
 * documented discard from a bare one is precisely the reason written after
 * it, so stripping comments first would erase the distinction.
 */
export function bareVoidDiscards(src: string): Array<{ line: number; text: string }> {
  return src
    .split('\n')
    .flatMap((text, i) => (BARE_VOID_DISCARD.test(text) ? [{ line: i + 1, text: text.trim() }] : []));
}

describe('#758 grep guard: payload shapes are read with types, not assertions', () => {
  it('detects a cast and does not flag the shapes it must ignore', () => {
    // Non-vacuity: if the detector could not tell these apart, the invariants
    // below would pass on every tree, including the broken one.
    assert.equal(asAnyHits('const name = (tr as any).album?.name;').length, 1);
    // One line, two casts — the duck-typed client read #758 deleted, which is
    // reported as the one offending line it is.
    const twoCasts = asAnyHits('if ((client as any).getAllPages) { items = await (client as any).getAllPages("/me/episodes"); }');
    assert.equal(twoCasts.length, 1);
    assert.equal(twoCasts[0]!.text.split('as any').length - 1, 2);
    // A real assertion against a named type is still checked by the compiler.
    assert.equal(asAnyHits('receipt: receipt as unknown as Record<string, unknown>').length, 0);
    // A doc comment may name the pattern it removed; prose is not a cast.
    assert.equal(asAnyHits('/** the three `as any` reads this replaces */\nconst album = 1;').length, 0);
    // Nor is a payload-shape name that happens to live in a string.
    assert.equal(asAnyHits('throw new Error("refusing to read the track as any");').length, 0);
    // Nor a URL, whose `//` must not hide what follows it on the line.
    assert.equal(asAnyHits("const href = 'https://open.spotify.com'; const n = (tr as any).album.name;").length, 1);
  });

  it('separates a documented discard from a bare one', () => {
    assert.equal(bareVoidDiscards('        void round;').length, 1);
    // The two surviving discards state why they are there.
    assert.equal(
      bareVoidDiscards('  void _client; // stats.fm public API needs no Spotify client; kept for index.ts uniformity').length,
      0,
    );
    // A variable that is simply unused is not a discard statement at all.
    assert.equal(bareVoidDiscards('  let round = 0;\n  round++;').length, 0);
  });

  it('no module reads a payload through `as any` above its ceiling', () => {
    const over = tsFilesIn(SRC_DIR).flatMap((file) => {
      const name = relative(file);
      const hits = asAnyHits(readFileSync(file, 'utf8'));
      const ceiling = ceilingFor(name);
      if (hits.length <= ceiling) return [];
      return [`${name}: ${hits.length} > ${ceiling} — ${format(hits)}`];
    });
    assert.deepEqual(
      over,
      [],
      `payload reads re-typed to \`any\` above their #758 ceiling: ${over.join('; ')}`,
    );
  });

  it('every ceiling is still owed casts, and no file outside the map carries one', () => {
    for (const [name, ceiling] of Object.entries(AS_ANY_CEILINGS)) {
      const hits = asAnyHits(readFileSync(join(TOOLS_DIR, name), 'utf8'));
      assert.ok(
        hits.length > 0 && hits.length <= ceiling,
        `${name} carries ${hits.length} \`as any\` reads against a ceiling of ${ceiling} — ` +
          'drain them and delete the ceiling entry rather than raising it',
      );
    }
    // A NEW module is not a place a cast may be introduced: only the listed
    // modules are, and each of those is already at or under its ceiling.
    const unlisted = tsFilesIn(SRC_DIR).flatMap((file) => {
      const name = relative(file);
      if (ceilingFor(name) > 0) return [];
      return asAnyHits(readFileSync(file, 'utf8')).map((h) => `${name}:${h.line} ${h.text}`);
    });
    assert.deepEqual(unlisted, [], `\`as any\` outside the #758 ceiling map: ${unlisted.join(' | ')}`);
  });

  it('no bare `void x;` discard survives anywhere in src', () => {
    const found = tsFilesIn(SRC_DIR).flatMap((file) =>
      bareVoidDiscards(readFileSync(file, 'utf8')).map((h) => `${relative(file)}:${h.line} ${h.text}`),
    );
    assert.deepEqual(
      found,
      [],
      `discards that state no reason (an unhandled quota path reads as handled): ${found.join(' | ')}`,
    );
  });
});
