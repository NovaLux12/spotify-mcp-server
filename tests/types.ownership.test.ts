/**
 * Sole ownership of Spotify response shapes (#589).
 *
 * `src/types/spotify.ts` is the one place a Spotify API response shape is
 * declared. These four rules are what makes that true over time rather than
 * true only on the commit that established it:
 *
 *   1. SHADOW    — no module may declare a name the shared file exports. A
 *                  same-named local shape is how `audiobookcopilot`'s
 *                  `PlaybackState` ended up modelling a three-field subset of
 *                  the real one.
 *   2. WIDENING  — no module may widen a shared shape (an `extends` of one, or
 *                  an intersection with one). That is the album-payload class
 *                  the audit found in three private copies, and the track-row
 *                  class in two. Pure unions of shared names and indexed
 *                  accesses (`X['items']`) add no field, so they cannot drift
 *                  and are exempt.
 *   3. PAGED ONCE — `SpotifyPaged` is the only declaration of the paged wrapper,
 *                  and no type argument re-spells its four paging fields
 *                  inline. `PlaylistItemsResponse` and
 *                  `SpotifyArtistAlbumsResponse` must stay aliases of it.
 *   4. ALBUM ONCE — `copyrights` marks a widened album payload, so exactly one
 *                  declaration of it may exist: `SpotifyAlbumRow`. A copy
 *                  reintroduced under any other name fails here.
 *
 * A structural copy of a shared shape under a *different* name (a narrowed
 * `SpotifyAlbumFull` called `AlbumItem`, say) references no shared name and so
 * cannot be caught by rule 2. That residue is what the manual sweep in #589
 * found; the rules above close the re-introduction path, not the whole class.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { playlistItemTotal } from '../src/types/spotify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = 'src/types/spotify.ts';

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

const read = (abs: string): string => readFileSync(abs, 'utf8');
const rel = (abs: string): string => relative(ROOT, abs).split('\\').join('/');

/**
 * Blank out comments and string/template literals in place, so brace counting
 * and identifier scanning cannot be fooled by prose or by a `}` inside a
 * template literal. Newlines survive, so offsets still point at the original.
 */
function stripLiterals(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let k = i + 1;
      while (k < n && src[k] !== quote) k += src[k] === '\\' ? 2 : 1;
      blank(i, Math.min(k + 1, n));
      i = k + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

interface Declaration {
  file: string;
  name: string;
  keyword: 'interface' | 'type' | 'class';
  /** Full declaration text, literals blanked. */
  text: string;
  /** `extends ...` clause, or '' when there is none. */
  heritage: string;
  /**
   * The type expressions this declaration is built from: the whole right-hand
   * side of a `type` alias, or each member annotation of an `interface`. Scoped
   * to type positions on purpose — a whole class body contains `&&`, and a
   * rule that reads that as a type intersection is worse than no rule.
   */
  typeExpressions: string[];
  /** Member names of an object-literal-shaped declaration body. */
  members: string[];
}

/**
 * Read one type expression starting at `from`: forward until a `,` or `;` or
 * newline at nesting depth zero, tracking `{`, `(`, `[` and generic brackets.
 */
function typeExpression(src: string, from: number): string {
  let depth = 0;
  for (let k = from; k < src.length; k++) {
    const c = src[k]!;
    const prev = k > 0 ? src[k - 1]!.trim() : '';
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      if (depth === 0) return src.slice(from, k);
      depth--;
    } else if (c === '<' && /[\w$>\]]/.test(prev)) depth++;
    else if (c === '>') {
      if (depth > 0) depth--;
    } else if (depth === 0 && (c === ',' || c === ';' || c === '\n')) {
      return src.slice(from, k);
    }
  }
  return src.slice(from);
}

/** Type expressions of an `interface` body: one per annotated member. */
function memberTypes(body: string): string[] {
  const out: string[] = [];
  const MEMBER = /^[ \t]*([A-Za-z_$][\w$]*)[? \t]*:/gm;
  for (const m of body.matchAll(MEMBER)) {
    out.push(typeExpression(body, m.index + m[0].length));
  }
  return out;
}

const DECL = /^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(interface|type|class)[ \t]+([A-Za-z_$][\w$]*)/gm;

/** Balance braces from the first `{` of a declaration to its match. */
function bodyEnd(src: string, from: number): number {
  const start = src.indexOf('{', from);
  if (start === -1) {
    const semi = src.indexOf(';', from);
    return semi === -1 ? src.length : semi;
  }
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return src.length;
}
function declarations(abs: string): Declaration[] {
  const src = stripLiterals(read(abs));
  const found: Declaration[] = [];
  for (const m of src.matchAll(DECL)) {
    const [full, keyword, name] = m;
    const end = bodyEnd(src, m.index + full.length);
    const text = src.slice(m.index, end);
    const open = text.indexOf('{');
    const body = open === -1 ? '' : text.slice(open);
    const members = open === -1 ? [] : [...body.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)[? \t]*[?:]/gm)].map((mm) => mm[1]);
    const head = text.slice(0, open === -1 ? text.length : open);
    const heritage = /\bextends\b/.test(head) ? typeExpression(head, head.indexOf('extends') + 'extends'.length) : '';
    const typeExpressions =
      keyword === 'class'
        ? [] // a class body is code, not a type expression
        : keyword === 'type'
          ? [typeExpression(text, text.indexOf('=') + 1)]
          : [heritage, ...memberTypes(body)];
    found.push({
      file: rel(abs),
      name: name!,
      keyword: keyword as Declaration['keyword'],
      text,
      heritage,
      typeExpressions: typeExpressions.filter(Boolean),
      members,
    });
  }
  return found;
}

const allFiles = sourceFiles(join(ROOT, 'src'));
const outsideShared = allFiles.filter((f) => rel(f) !== SHARED);
const sharedDecls = declarations(join(ROOT, SHARED));
const sharedNames = new Set(
  [...read(join(ROOT, SHARED)).matchAll(/^export[ \t]+(?:declare[ \t]+)?(?:interface|type|class|function|const)[ \t]+([A-Za-z_$][\w$]*)/gm)].map(
    (m) => m[1]!,
  ),
);
const mentions = (text: string, name: string) => new RegExp(`(^|[^\\w$.])${name}([^\\w$]|$)`).test(text);

describe('src/types/spotify.ts owns the response shapes', () => {
  it('exports the shapes the tool modules import, so the gate is not vacuous', () => {
    // A gate that matches nothing is a gate that cannot fail. These are the
    // names the widening migrations in #589 moved here; if one disappears, the
    // migrations have nothing to import and the gate has stopped testing.
    for (const name of [
      'SpotifyPaged',
      'SpotifyItemsPage',
      'PlaylistItemsResponse',
      'SpotifyArtistAlbumsResponse',
      'SpotifyAlbumRow',
      'SpotifyArtistAlbumRow',
      'SpotifyTrackRow',
      'SpotifyTrackWithReleaseDate',
      'SpotifyAudiobookRow',
      'SpotifyChapterRow',
      'SpotifyEpisodeRow',
      'SpotifyArtistRow',
      'SpotifyPlaylistRow',
      'SpotifyPlaylistWithImages',
      'SpotifyPlaylistVisibilityRow',
      'SpotifySearchResults',
      'SpotifyVolumeTarget',
      'SavedAlbumRow',
      'SavedTrackRow',
      'SpotifyPlaylistPage',
      'playlistItemTotal',
    ]) {
      assert.ok(sharedNames.has(name), `${SHARED} must export ${name}`);
    }
    assert.ok(sharedNames.size >= 50, `expected the shared module to be the owner, saw ${sharedNames.size} exports`);
  });

  it('rule 1 — no module declares a name the shared file exports', () => {
    const shadows: string[] = [];
    for (const file of outsideShared) {
      for (const d of declarations(file)) {
        if (sharedNames.has(d.name)) shadows.push(`${d.file}: ${d.keyword} ${d.name} shadows a ${SHARED} export`);
      }
    }
    assert.deepEqual(shadows, [], `local shapes that shadow a shared response shape:\n${shadows.join('\n')}`);
  });

  it('rule 2 — no module widens a shared shape', () => {
    const widenings: string[] = [];
    for (const file of outsideShared) {
      for (const d of declarations(file)) {
        if (sharedNames.has(d.name)) continue; // rule 1's finding
        for (const expr of d.typeExpressions) {
          if (d.heritage && expr === d.heritage) {
            const base = [...sharedNames].find((n) => mentions(expr, n));
            if (base) widenings.push(`${d.file}: ${d.keyword} ${d.name} extends ${base} — declare the widened row in ${SHARED}`);
            break;
          }
          if (!expr.includes('&')) continue; // a plain reference, not a widening
          const base = [...sharedNames].find((n) => mentions(expr, n));
          if (base) {
            widenings.push(
              `${d.file}: ${d.keyword} ${d.name} widens ${base} — declare the widened row in ${SHARED}`,
            );
            break;
          }
        }
      }
    }
    assert.deepEqual(widenings, [], `shared response shapes widened outside ${SHARED}:\n${widenings.join('\n')}`);
  });

  it('rule 3 — the paged wrapper is declared once and never re-spelled inline', () => {
    const PAGED = ['items', 'total', 'limit', 'offset'];
    const declared: string[] = [];
    for (const file of allFiles) {
      for (const d of declarations(file)) {
        if (d.keyword !== 'interface') continue;
        if (PAGED.every((f) => d.members.includes(f))) declared.push(`${d.file}: ${d.name}`);
      }
    }
    assert.deepEqual(declared, [`${SHARED}: SpotifyPaged`], 'the paged wrapper must be declared exactly once');

    // A response alias stays an alias; a re-expanded interface is the drift.
    for (const alias of ['PlaylistItemsResponse', 'SpotifyArtistAlbumsResponse']) {
      const d = sharedDecls.find((x) => x.name === alias);
      assert.ok(d, `${SHARED} must still export ${alias}`);
      assert.match(
        d.text,
        /=\s*SpotifyPaged\s*</,
        `${alias} must be an alias of SpotifyPaged<T>, not a re-expanded copy of its fields`,
      );
    }

    // Inline re-spellings: a type argument carrying the whole paging field set.
    const inline: string[] = [];
    const INLINE_ARG = /<\s*\{([^<>{}]*(?:\{[^<>]*\}[^<>{}]*)*)\}\s*>/g;
    for (const file of outsideShared) {
      const src = stripLiterals(read(file));
      for (const m of src.matchAll(INLINE_ARG)) {
        const fields = new Set([...m[1]!.matchAll(/([A-Za-z_$][\w$]*)\??\s*:/g)].map((mm) => mm[1]!));
        if (PAGED.every((f) => fields.has(f))) {
          const line = src.slice(0, m.index).split('\n').length;
          inline.push(`${rel(file)}:${line}: inline type argument re-spells the paged wrapper — use SpotifyPaged<T>`);
        }
      }
    }
    assert.deepEqual(inline, [], `paged wrapper re-spelled inline:\n${inline.join('\n')}`);
  });

  it('rule 4 — the widened album payload is declared once', () => {
    // `copyrights` is the marker: only the full album object and the album row
    // declare it. A private copy reintroduced under any other name shows up
    // here, which is the whole point — the three album-payload copies the audit
    // found were indistinguishable from each other by name.
    const copies: string[] = [];
    for (const file of allFiles) {
      for (const d of declarations(file)) {
        if (d.members.includes('copyrights')) copies.push(`${d.file}: ${d.name}`);
      }
    }
    assert.deepEqual(
      copies.sort(),
      [`${SHARED}: SpotifyAlbumRow`, `${SHARED}: SpotifyAudiobookFull`].sort(),
      'the album-payload widening must be declared only in the shared module; a private copy re-adds the Feb-2026 rename problem',
    );
  });
});

describe('playlistItemTotal reads the canonical page, falls back to the legacy one', () => {
  it('prefers items.total even when a legacy tracks.total disagrees', () => {
    // The two spellings cannot both be right; the canonical one wins, and the
    // disagreement is not silently averaged or picked at random.
    assert.equal(playlistItemTotal({ items: { total: 7 }, tracks: { total: 9 } }), 7);
  });

  it('falls back to tracks.total for a payload that still carries only the legacy page', () => {
    assert.equal(playlistItemTotal({ tracks: { total: 4 } }), 4);
  });

  it('returns undefined — never 0 — when the payload states no length', () => {
    // A length Spotify did not report is unknown, not empty: 0 would be read as
    // "this playlist is empty" by every caller that formats the number.
    assert.equal(playlistItemTotal({}), undefined);
    assert.equal(playlistItemTotal({ items: null, tracks: null }), undefined);
    assert.equal(playlistItemTotal({ items: {} }), undefined);
    assert.equal(playlistItemTotal(null), undefined);
    assert.equal(playlistItemTotal(undefined), undefined);
  });

  it('reads an empty playlist as zero, because zero was actually stated', () => {
    assert.equal(playlistItemTotal({ items: { total: 0 } }), 0);
  });
});
