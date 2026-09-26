/**
 * Every `GET /artists/{id}/albums` read must send a `limit` at or below the
 * endpoint's documented maximum of 10 (#1209).
 *
 * This is a source-scanning guard rather than a behavioural one, deliberately.
 * The defect was never a wrong calculation — it was a *literal* (`'20'`, `'50'`)
 * at a call site that had no reason to know about the endpoint's cap. Three
 * separate call sites carried one, and the correct clamp already existed in
 * `catalog.ts` and was used correctly at eight other sites in the same file. A
 * behavioural test can only cover the call sites its author happened to invoke;
 * this guard covers every call site that exists now *and* every one added later.
 *
 * The scan is deliberately narrow: it only inspects the object literal passed as
 * the `params` argument of a `.get(`/`.getAllPages(`/`.post(` call whose path
 * matches `/artists/.../albums`, so an unrelated `limit: '50'` elsewhere cannot
 * fail it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS_DIR = join(process.cwd(), 'src', 'tools');
const MAX_LIMIT = 10;

/** The endpoint's documented `limit` maximum. Asserted against the schema constant. */
const ARTIST_ALBUM_PAGE_LIMIT = 10;

type Violation = { file: string; line: number; text: string; limit: number };

/** `/artists/<something>/albums`, allowing for `encodeURIComponent(id)` and template holes. */
const ARTIST_ALBUMS_PATH = /`\/artists\/\$\{[^}]+\}\/albums`/;

/**
 * The params object literal that follows a path literal, up to its balanced
 * close. A fixed line window is not safe here: consecutive calls sit a few
 * lines apart, so a window wide enough to catch a multi-line params object
 * also reaches the *next* call and would attribute its `limit` to this one.
 * That produced a false positive against correct code during development.
 */
function paramsObjectAfter(source: string, from: number): string {
  const start = source.indexOf('{', from);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

function scanSource(dir: string): Violation[] {
  const found: Violation[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(join(dir, entry.name), 'utf8');

    for (const m of source.matchAll(new RegExp(ARTIST_ALBUMS_PATH.source, 'g'))) {
      const line = source.slice(0, m.index).split('\n').length;
      const params = paramsObjectAfter(source, m.index + m[0].length);
      for (const lm of params.matchAll(/\blimit:\s*(?:String\()?\s*'?(\d+)'?/g)) {
        const limit = Number(lm[1]);
        if (limit > MAX_LIMIT) {
          found.push({
            file: entry.name,
            line,
            text: m[0].replace(/`/g, ''),
            limit,
          });
        }
      }
    }
  }
  return found;
}

test('the guard scans at least one known call site, so it is not vacuous', () => {
  // If the regex or the window ever stops matching, every other test in this
  // file would pass for the wrong reason. A test that cannot fail is worse
  // than no test (AGENTS.md §6) — so prove the scanner is live.
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
  const hits = files.filter((f) =>
    ARTIST_ALBUMS_PATH.test(readFileSync(join(TOOLS_DIR, f), 'utf8')),
  );
  assert.ok(
    hits.length >= 5,
    `expected the /artists/{id}/albums path to appear in at least 5 tool modules, found ${hits.length}: ${hits.join(', ')}`,
  );
});

test('the schema constant this guard encodes is the one the code uses', () => {
  const catalog = readFileSync(join(TOOLS_DIR, 'catalog.ts'), 'utf8');
  const m = catalog.match(/ARTIST_ALBUM_PAGE_LIMIT\s*=\s*(\d+)/);
  assert.ok(m, 'ARTIST_ALBUM_PAGE_LIMIT must still be declared in src/tools/catalog.ts');
  assert.equal(
    Number(m[1]),
    ARTIST_ALBUM_PAGE_LIMIT,
    'this guard hardcodes the schema maximum; if the constant moves, the two must be reconciled deliberately, not silently',
  );
});

test('no /artists/{id}/albums read sends a limit above the schema maximum', () => {
  const violations = scanSource(TOOLS_DIR);
  assert.deepEqual(
    violations,
    [],
    violations.length
      ? violations
          .map(
            (v) =>
              `src/tools/${v.file}:${v.line} sends limit=${v.limit} (> ${MAX_LIMIT}) — ${v.text}`,
          )
          .join('\n')
      : '',
  );
});

test('the two sites fixed in #1209 now derive their limit, not a literal', () => {
  // The scan above would still pass if someone replaced `'50'` with `'10'`. These
  // assertions pin the stronger property: the value comes from the shared
  // constant, so a change to the schema maximum propagates instead of drifting.
  //
  // Scoped to the artist-albums call specifically. `swarm3_discovery.ts` carries
  // `limit: '50'` on `/me/albums` and `/albums/{id}/tracks`, where 50 is a
  // legitimate value for those endpoints — a whole-file literal grep would
  // flag correct code.
  const swarm = readFileSync(join(TOOLS_DIR, 'swarm3_discovery.ts'), 'utf8');
  assert.match(
    swarm,
    /import \{ ARTIST_ALBUM_PAGE_LIMIT \} from '\.\/catalog\.js'/,
    'swarm3_discovery.ts must import the shared constant rather than re-deriving the cap',
  );
  const walk = swarm.slice(swarm.indexOf('async function walkArtistAlbums'));
  assert.match(
    walk.slice(0, walk.indexOf('\n}')),
    /limit:\s*String\(ARTIST_ALBUM_PAGE_LIMIT\)/,
    'walkArtistAlbums must send the shared constant, not a literal',
  );

  const queueops = readFileSync(join(TOOLS_DIR, 'queueops.ts'), 'utf8');
  assert.match(
    queueops,
    /import \{ ARTIST_ALBUM_PAGE_LIMIT \} from '\.\/catalog\.js'/,
    'queueops.ts must import the shared constant rather than re-deriving the cap',
  );
  const fallback = queueops.slice(queueops.indexOf("type === 'artist'"));
  assert.match(
    fallback,
    /\/artists\/\$\{id\}\/albums`,\s*\{ limit: String\(ARTIST_ALBUM_PAGE_LIMIT\) \}/,
    "queueops.ts's artist fallback must send the shared constant, not a literal",
  );
});
