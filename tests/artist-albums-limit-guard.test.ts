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
 *
 * Since #900 the scan covers **all** of `src/`, not just `src/tools/`. The
 * canonical artist-release probe landed in `src/artistreleases.ts` and the
 * resource templates already had their own copy in `src/resources/templates.ts`
 * — two live call sites in directories this guard did not read, so a `limit`
 * above the cap in either would have passed. Coverage that stops at a directory
 * boundary is coverage that stops exactly where the next contributor writes.
 */
import './helpers/hermetic.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(process.cwd(), 'src');
const TOOLS_DIR = join(SRC_DIR, 'tools');
const MAX_LIMIT = 10;

/** The endpoint's documented `limit` maximum. Asserted against the schema constant. */
const ARTIST_ALBUM_PAGE_LIMIT = 10;

type Violation = { file: string; line: number; text: string; limit: number };

/** `/artists/<something>/albums`, allowing for `encodeURIComponent(id)` and template holes. */
const ARTIST_ALBUMS_PATH = /`\/artists\/\$\{[^}]+\}\/albums`/;

/** Every `.ts` file under `dir`, recursively, as paths relative to `dir`. */
function tsFilesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...tsFilesUnder(dir, rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

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
  for (const rel of tsFilesUnder(dir)) {
    const source = readFileSync(join(dir, rel), 'utf8');

    for (const m of source.matchAll(new RegExp(ARTIST_ALBUMS_PATH.source, 'g'))) {
      const line = source.slice(0, m.index).split('\n').length;
      const params = paramsObjectAfter(source, m.index + m[0].length);
      for (const lm of params.matchAll(/\blimit:\s*(?:String\()?\s*'?(\d+)'?/g)) {
        const limit = Number(lm[1]);
        if (limit > MAX_LIMIT) {
          found.push({
            file: rel,
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

test('the widened scan reaches the call sites outside src/tools/', () => {
  // The anti-vacuity test above only proves the scanner matches *somewhere*.
  // This proves the #900 widening actually took: the canonical probe in
  // `src/artistreleases.ts` and the resource template walk in
  // `src/resources/templates.ts` are outside `src/tools/`, and a scan scoped to
  // that one directory would never read either of them.
  const outsideTools = tsFilesUnder(SRC_DIR).filter(
    (f) => !f.startsWith('tools/') && ARTIST_ALBUMS_PATH.test(readFileSync(join(SRC_DIR, f), 'utf8')),
  );
  assert.ok(
    outsideTools.includes('artistreleases.ts'),
    `expected the widened scan to read src/artistreleases.ts; files outside src/tools/ carrying the path: ${outsideTools.join(', ') || '(none)'}`,
  );
  assert.ok(
    outsideTools.includes('resources/templates.ts'),
    `expected the widened scan to read src/resources/templates.ts; files outside src/tools/ carrying the path: ${outsideTools.join(', ') || '(none)'}`,
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
  const violations = scanSource(SRC_DIR);
  assert.deepEqual(
    violations,
    [],
    violations.length
      ? violations
          .map((v) => `src/${v.file}:${v.line} sends limit=${v.limit} (> ${MAX_LIMIT}) — ${v.text}`)
          .join('\n')
      : '',
  );
});

test('every artist-albums page-size constant under src/ agrees with the schema maximum', () => {
  // The literal scan above is blind to a *named* constant: `String(SOME_CONST)`
  // contains no digits, so a private copy of the cap that drifts to 50 is
  // invisible to it. There is one such copy today —
  // `src/resources/templates.ts` declares its own `ARTIST_ALBUMS_PAGE_LIMIT`
  // — and #1209's whole finding was that the knowledge was in the repo and the
  // call sites were not consulting it. A third name for the same number, in a
  // directory the guard did not read, is that defect waiting to recur.
  //
  // This asserts agreement, not identity: a private copy that says 10 passes,
  // because it is not currently wrong. Collapsing it onto the shared constant
  // is a separate cleanup; this test's job is to make the drift loud when it
  // happens, not to fail the build over a name.
  const declared: Array<{ file: string; name: string; value: number }> = [];
  for (const rel of tsFilesUnder(SRC_DIR)) {
    const source = readFileSync(join(SRC_DIR, rel), 'utf8');
    for (const m of source.matchAll(/\b(ARTIST\w*ALBUM\w*LIMIT)\s*(?::[^=]+)?=\s*(\d+)/g)) {
      declared.push({ file: rel, name: m[1], value: Number(m[2]) });
    }
  }

  // Anti-vacuity: the scan must find the two declarations that exist today, or
  // a regex that silently stopped matching would make the rest pass for free.
  assert.ok(
    declared.length >= 2,
    `expected at least 2 declared artist-albums page-size constants under src/, found ${declared.length}: ${declared.map((d) => d.file).join(', ')}`,
  );

  const wrong = declared.filter((d) => d.value !== ARTIST_ALBUM_PAGE_LIMIT);
  assert.deepEqual(
    wrong,
    [],
    wrong
      .map((d) => `src/${d.file}: ${d.name} = ${d.value}, but the schema maximum is ${ARTIST_ALBUM_PAGE_LIMIT}`)
      .join('\n'),
  );
});

test('the canonical probe derives its limit from the shared constant', () => {
  // `src/artistreleases.ts` (#900) is the one module whose entire job is to be
  // the single place this request is written down. It originally declared its
  // own `ARTIST_RELEASE_PROBE_LIMIT = 10` — a fourth name for the same number,
  // in the module most likely to be read as authoritative. This pins the
  // derivation so a second literal cannot be reintroduced there.
  const probe = readFileSync(join(SRC_DIR, 'artistreleases.ts'), 'utf8');
  assert.match(
    probe,
    /import \{ ARTIST_ALBUM_PAGE_LIMIT \} from '\.\/tools\/catalog\.js'/,
    'artistreleases.ts must import the shared cap from tools/catalog.ts',
  );
  assert.match(
    probe,
    /export const ARTIST_RELEASE_PROBE_LIMIT = ARTIST_ALBUM_PAGE_LIMIT;/,
    'ARTIST_RELEASE_PROBE_LIMIT must alias the shared constant, not declare its own value',
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
