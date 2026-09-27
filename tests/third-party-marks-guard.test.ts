/**
 * Third-party brand-mark guard (#698).
 *
 * This server is an unofficial third-party client for the Spotify Web API.
 * Spotify's Branding Guidelines say of *our* mark: "Your logo should not
 * include, or look similar to the Spotify logo or any of its brand elements
 * (e.g. Spotify Green, the circle, and the waves)" — and of modification:
 * "Its orientation, color, and composition should remain as indicated in this
 * document — there are no exceptions." The same logic runs the other way for
 * every other service this project talks to: stats.fm's Terms Sec. 7.1(g)
 * forbids using their "name, logo or trademarks without our prior written
 * consent", and there is no recorded consent.
 *
 * The regression this guards is a **file literal**, not a behaviour. A mark has
 * no runtime behaviour to assert on: the defect is `#1DB954` sitting in an SVG
 * that nothing imports, or `'spotify-mcp/statsfm'` in a header object. A
 * behavioural test can only cover the files its author happened to think to
 * load, so this is a source scan, and it reads the tree rather than a list.
 *
 * ## Scope, and why it is narrow on purpose
 *
 * The scan covers `assets/**` and `src/**` only. `CONTRIBUTING.md` and
 * `docs/compliance.md` name `#1DB954` and `#1ED760` in order to *prohibit*
 * them, and this file carries the same values as regression fixtures. Widening
 * the scan to those files would make the guard fail on the documents that
 * exist to enforce it — and a policy you are forbidden to write down is not a
 * policy, it is a coincidence.
 *
 * That narrowing is deliberate, not a gap, and it is why the required
 * nominative text is safe: plain-text references to the Spotify Web API,
 * `spotify:` URIs, `open.spotify.com` links and `SPOTIFY_*` variables live in
 * `src/**` and are *required* by Developer Policy Sec. II.4.a. This guard has
 * no rule that could fire on them, because a word used to describe the
 * platform being integrated is not a mark. Deleting those to look careful would
 * be the actual compliance failure.
 *
 * ## Anti-vacuity
 *
 * Almost every assertion below is an *absence*, and an absence assertion is
 * satisfied for free by a scan that reads nothing (AGENTS.md §6: "A test that
 * cannot fail is worse than no test"). Three things stop that here:
 *
 *   1. `scans the real source tree` proves the real scan walked real files and
 *      that the User-Agent rule *matched* live code in `src/lib/statsfm-client.ts`
 *      — the pass is earned, not skipped.
 *   2. The `rejects`/`accepts` tests drive the pure scanner against inputs it
 *      must reject, including the byte-exact contents of the two assets #698
 *      removed. Those are the actual marks, not a synthetic stand-in.
 *   3. Each `rejects` test is paired with an `accepts` twin, so a rule that
 *      degraded into "reject everything" would fail the suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

/**
 * Spotify Green, in every notation an SVG or stylesheet actually uses.
 * #1DB954 is the brand green; #1ED760 is the lighter variant that appears on
 * Spotify's own surfaces. Both are named as restricted brand elements.
 * The `rgb()` triples are the decimal spellings of the same two values — a
 * colour grep that only knows hex is trivially defeated by one function call.
 */
const BANNED_COLOURS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /#\s*(?:1db954|1ed760)\b/i, what: 'Spotify Green (#1DB954 / #1ED760)' },
  { pattern: /rgba?\(\s*29\s*,\s*185\s*,\s*84\b/i, what: 'Spotify Green as rgb(29,185,84)' },
  { pattern: /rgba?\(\s*30\s*,\s*215\s*,\s*96\b/i, what: 'Spotify Green as rgb(30,215,96)' },
];

/**
 * A third-party wordmark, as rendered text. Only ever applied to files under
 * `assets/`, where any occurrence is a reproduction — `assets/` holds artwork
 * for this project and nothing else. It is deliberately not applied to `src/`
 * or the docs, where naming a service in prose is required or legitimate.
 */
const THIRD_PARTY_WORDMARKS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bspotify\b/i, what: 'the Spotify wordmark' },
  { pattern: /last\s*\.?\s*fm\b/i, what: 'the Last.fm wordmark' },
  { pattern: /stats\s*\.?\s*fm\b/i, what: 'the stats.fm wordmark' },
  { pattern: /\bdiscogs\b/i, what: 'the Discogs wordmark' },
];

/**
 * Service names that must never appear as a *product token* in an outbound
 * `User-Agent`. Distinct from the wordmark rule: this one is about what we
 * advertise about ourselves to a third party's operator, and it is scoped to
 * `src/**` where header objects are actually written.
 */
const UA_THIRD_PARTY_TOKENS = /stats\s*\.?\s*fm|last\s*\.?\s*fm|discogs|chartmetric|soundcharts|tidal|deezer|bandcamp|soundcloud|musicbrainz/i;

/**
 * The shape this project commits to: a product token, then a parenthesised
 * contact URL. RFC 9110 §10.1.5. Deliberately version-free — see the note on
 * `STATSFM_USER_AGENT` in `src/lib/statsfm-client.ts`.
 */
const NEUTRAL_UA_SHAPE = /^[A-Za-z0-9._-]+ \(\+https:\/\/[^\s)]+\)$/;

/** A `<g>…</g>` block, non-greedy, no nesting assumed. */
const GROUP_BLOCK = /<g\b[^>]*>([\s\S]*?)<\/g>/g;

/** A `<path d="…">` whose `d` is one move plus exactly one curve. */
const SINGLE_CURVE_PATH = /<path\b[^>]*\bd="([^"]*)"/g;

/** A `d` attribute holding a single quadratic or cubic segment and nothing else. */
const ONE_CURVE = /^[Mm][^A-Za-z]*[QC][^A-Za-z]*$/;

/** How many stacked single-curve paths in one group read as "the waves". */
const WAVES_ARC_COUNT = 3;

export type Violation = {
  file: string;
  line: number;
  rule: string;
  detail: string;
};

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function push(
  out: Violation[],
  file: string,
  text: string,
  index: number,
  rule: string,
  detail: string,
): void {
  out.push({ file, line: lineOf(text, index), rule, detail });
}

// ---------------------------------------------------------------------------
// Pure scanner. Everything below this line takes (relPath, text) and returns
// violations, so each rule can be driven against fixtures in both directions.
// ---------------------------------------------------------------------------

function isAsset(relPath: string): boolean {
  return relPath.startsWith('assets/');
}

function isSource(relPath: string): boolean {
  return relPath.startsWith('src/');
}

/** R1 — banned brand colour, in any notation. Applies to assets and source. */
function scanColour(relPath: string, text: string): Violation[] {
  const out: Violation[] = [];
  for (const { pattern, what } of BANNED_COLOURS) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
      push(out, relPath, text, m.index, 'banned-colour', `${what} as "${m[0]}"`);
    }
  }
  return out;
}

/**
 * R2 — the waves geometry, independent of colour.
 *
 * The colour rule alone is defeated by changing one hex. The actual
 * infringement is the *shape* — three stacked arcs in a group — so the shape is
 * what gets scanned. Each counted path is a move plus exactly one `Q`/`C`, so
 * an ordinary icon of three separate straight-edged or compound paths does not
 * match. Known limitation, stated rather than hidden: an SVG that draws three
 * concentric single-curve paths in one group for some unrelated reason would
 * be a false positive. `assets/` is not a busy directory, and the alternative
 * — a colour-only guard — is the one with a known bypass.
 */
function scanWavesGeometry(relPath: string, text: string): Violation[] {
  const out: Violation[] = [];
  for (const g of text.matchAll(GROUP_BLOCK)) {
    const arcs: string[] = [];
    for (const p of g[1].matchAll(SINGLE_CURVE_PATH)) {
      if (ONE_CURVE.test(p[1].trim())) arcs.push(p[1]);
    }
    if (arcs.length >= WAVES_ARC_COUNT) {
      push(
        out, relPath, text, g.index, 'waves-geometry',
        `${arcs.length} stacked single-curve paths in one <g> — the Spotify waves, whatever colour they are drawn in`,
      );
    }
  }
  return out;
}

/** R3 — a third-party wordmark reproduced as artwork. `assets/` only. */
function scanWordmark(relPath: string, text: string): Violation[] {
  const out: Violation[] = [];
  if (!isAsset(relPath)) return out;
  for (const { pattern, what } of THIRD_PARTY_WORDMARKS) {
    const m = pattern.exec(text);
    if (m) push(out, relPath, text, m.index, 'wordmark-in-asset', `${what} set as text in an asset`);
  }
  return out;
}

/**
 * A `user-agent` header site. Returns every site with the raw value, so a test
 * can assert the rule *matched* — an absence rule that silently stopped
 * matching is indistinguishable from a clean tree.
 */
export type UaSite = { file: string; line: number; value: string; literal: string | null };

const UA_SITE = /['"`]?user-agent['"`]?\s*:\s*('[^']*'|"[^"]*"|`[^`]*`|[A-Za-z_$][\w$]*)/gi;

export function findUaSites(text: string, relPath: string): UaSite[] {
  const out: UaSite[] = [];
  for (const m of text.matchAll(UA_SITE)) {
    const value = m[1];
    const isLiteral = /^['"`]/.test(value);
    out.push({
      file: relPath,
      line: lineOf(text, m.index),
      value: isLiteral ? value.slice(1, -1) : value,
      literal: isLiteral ? value.slice(1, -1) : null,
    });
  }
  return out;
}

/** `const NAME = 'value'` in the same file, for resolving an indirection. */
const CONST_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*('[^']*'|"[^"]*")/g;

function resolveLocalConst(text: string, name: string): string | null {
  for (const m of text.matchAll(CONST_DECL)) {
    if (m[1] === name) return m[2].slice(1, -1);
  }
  return null;
}

/**
 * R4 — outbound `User-Agent` hygiene, `src/**` only.
 *
 * Two independent failures, both checked:
 *   a. the value carries a third-party product token; and
 *   b. the value is not the committed neutral shape.
 *
 * A site whose value is an identifier rather than a literal is followed to its
 * declaration in the same file, so `headers: { 'user-agent': STATSFM_USER_AGENT }`
 * is judged by what that constant holds, not waved through as "not a literal".
 */
function scanUserAgent(relPath: string, text: string, sites: UaSite[]): Violation[] {
  const out: Violation[] = [];
  if (!isSource(relPath)) return out;

  for (const site of sites) {
    let value = site.value;
    if (site.literal === null) {
      const resolved = resolveLocalConst(text, site.value);
      if (resolved === null) {
        push(out, relPath, text, 0, 'ua-unresolvable',
          `'user-agent' is set from "${site.value}", which this guard cannot resolve to a literal in the same file`);
        continue;
      }
      value = resolved;
    }

    if (UA_THIRD_PARTY_TOKENS.test(value)) {
      out.push({
        file: relPath, line: site.line, rule: 'ua-third-party-token',
        detail: `User-Agent "${value}" names a third-party service; the product token must be this project's own name`,
      });
    }
    if (!NEUTRAL_UA_SHAPE.test(value)) {
      out.push({
        file: relPath, line: site.line, rule: 'ua-not-neutral',
        detail: `User-Agent "${value}" is not the committed neutral form \`product-name (+https://contact-url)\``,
      });
    }
  }
  return out;
}

/** Every rule, for one file. */
export function findMarkViolations(relPath: string, text: string, sites: UaSite[] = findUaSites(text, relPath)): Violation[] {
  return [
    ...scanColour(relPath, text),
    ...scanWavesGeometry(relPath, text),
    ...scanWordmark(relPath, text),
    ...scanUserAgent(relPath, text, sites),
  ];
}

// ---------------------------------------------------------------------------
// Real-tree scan
// ---------------------------------------------------------------------------

/** Files under `dir`, recursively, relative to `dir`. Missing dir → []. */
function filesUnder(dir: string, prefix = ''): string[] {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** The two surfaces this guard owns. `assets/` may legitimately be absent. */
function guardedFiles(): string[] {
  return [
    ...filesUnder('assets').map((f) => `assets/${f}`),
    ...filesUnder('src').filter((f) => f.endsWith('.ts')).map((f) => `src/${f}`),
  ].sort();
}

interface TreeScan {
  files: string[];
  violations: Violation[];
  uaSites: UaSite[];
}

function scanTree(): TreeScan {
  const files = guardedFiles();
  const violations: Violation[] = [];
  const uaSites: UaSite[] = [];
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const sites = findUaSites(text, rel);
    uaSites.push(...sites);
    violations.push(...findMarkViolations(rel, text, sites));
  }
  return { files, violations, uaSites };
}

const tree = scanTree();

const describeViolations = (vs: Violation[]): string =>
  vs.map((v) => `  ${v.file}:${v.line} [${v.rule}] ${v.detail}`).join('\n');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The byte-exact contents of the two assets #698 removed, recovered from
 * origin/main. These are the real marks, not a synthetic stand-in: a guard
 * proven only against invented fixtures has been proven against nothing in
 * particular. md5 of each is asserted below so an "update the fixture" edit
 * cannot quietly replace a real mark with a harmless one.
 */
const REMOVED_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="SpotifyMCP dual-note mark">
  <title>SpotifyMCP — dual-note mark</title>
  <!-- Original mark: two overlapping eighth notes. Green nods to Spotify,
       amber to stats.fm. Drawn from circles, rounded stems and a shared beam. -->
  <rect width="128" height="128" rx="28" fill="#121212"/>
  <!-- Back note (amber) -->
  <g fill="#FFB454">
    <ellipse cx="72" cy="92" rx="16" ry="12"/>
    <rect x="83" y="34" width="7" height="58" rx="3.5"/>
  </g>
  <!-- Shared beam -->
  <rect x="45" y="30" width="46" height="9" rx="4.5" fill="#FFB454" transform="rotate(-8 68 34)"/>
  <!-- Front note (green) -->
  <g fill="#1DB954">
    <ellipse cx="46" cy="96" rx="16" ry="12"/>
    <rect x="57" y="36" width="7" height="60" rx="3.5"/>
  </g>
</svg>
`;

const REMOVED_STRIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 96" role="img" aria-label="Attribution: Spotify, stats.fm, Last.fm prior art">
  <title>Attribution strip — Spotify, stats.fm, Last.fm prior art</title>
  <rect width="640" height="96" rx="16" fill="#121212"/>
  <!-- Spotify: three arcs (original nod, not the logo) -->
  <g stroke="#1DB954" stroke-width="5" fill="none" stroke-linecap="round">
    <path d="M28 62 Q60 50 92 62"/>
    <path d="M30 50 Q60 39 90 50"/>
    <path d="M32 38 Q60 28 88 38"/>
  </g>
  <text x="108" y="60" font-family="sans-serif" font-size="22" fill="#FFFFFF">Spotify</text>
  <!-- stats.fm: bar-chart glyph -->
  <g fill="#FFB454">
    <rect x="248" y="56" width="10" height="18" rx="2"/>
    <rect x="262" y="46" width="10" height="28" rx="2"/>
    <rect x="276" y="36" width="10" height="38" rx="2"/>
  </g>
  <text x="298" y="60" font-family="sans-serif" font-size="22" fill="#FFFFFF">stats.fm</text>
  <!-- Last.fm: scrobble-dot chain (prior art nod) -->
  <g fill="#D51007">
    <circle cx="448" cy="52" r="8"/>
    <circle cx="470" cy="52" r="8"/>
    <circle cx="492" cy="52" r="8" opacity="0.45"/>
  </g>
  <text x="508" y="60" font-family="sans-serif" font-size="22" fill="#FFFFFF">Last.fm</text>
  <text x="28" y="86" font-family="sans-serif" font-size="12" fill="#9E9E9E">Data &amp; artwork belong to their services. Taste graphs pioneered by Last.fm.</text>
</svg>
`;

/** A neutral project mark: same dual-note idea, no third-party palette. */
const NEUTRAL_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Dual-note mark">
  <title>Dual-note mark</title>
  <rect width="128" height="128" rx="28" fill="#121212"/>
  <g fill="#FFB454">
    <ellipse cx="72" cy="92" rx="16" ry="12"/>
    <rect x="83" y="34" width="7" height="58" rx="3.5"/>
  </g>
  <rect x="45" y="30" width="46" height="9" rx="4.5" fill="#FFB454" transform="rotate(-8 68 34)"/>
</svg>
`;

/** Three straight-edged paths in one group — must NOT read as the waves. */
const ORDINARY_SHAPES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <g fill="#8ab4f8">
    <path d="M4 4 L20 4 L20 20 Z"/>
    <path d="M24 4 L40 4 L40 20 Z"/>
    <path d="M44 4 L60 4 L60 20 Z"/>
  </g>
</svg>
`;

const rulesIn = (vs: Violation[]): string[] => [...new Set(vs.map((v) => v.rule))].sort();

// ---------------------------------------------------------------------------

describe('third-party brand marks and the outbound User-Agent (#698)', () => {
  describe('the real tree', () => {
    it('scans the real source tree, so the absence below is not free', () => {
      // The absence assertions in this file are worth nothing if the scan read
      // zero files. Prove it read the tree, and prove the User-Agent rule
      // actually MATCHED live code — a rule that stopped matching would leave
      // the clean result below looking identical to a correct one.
      assert.ok(
        tree.files.length > 50,
        `expected the guard to walk the real source tree, found ${tree.files.length} files`,
      );
      assert.ok(
        tree.files.includes('src/lib/statsfm-client.ts'),
        `src/lib/statsfm-client.ts must be inside the guard's scope; scanned: ${tree.files.slice(0, 5).join(', ')}`,
      );
      assert.ok(
        tree.uaSites.length >= 1,
        'expected the User-Agent rule to match at least one live `user-agent` header in src/; it matched none, so that rule is not live',
      );
      assert.ok(
        tree.uaSites.some((s) => s.file === 'src/lib/statsfm-client.ts'),
        `expected a User-Agent site in src/lib/statsfm-client.ts; found: ${tree.uaSites.map((s) => `${s.file}:${s.line}`).join(', ') || '(none)'}`,
      );
    });

    it('no tracked asset or source file carries a third-party mark', () => {
      assert.deepEqual(
        tree.violations,
        [],
        tree.violations.length
          ? `Third-party mark or User-Agent token reintroduced (#698):\n${describeViolations(tree.violations)}`
          : '',
      );
    });

    it('the removed assets are gone and nothing still points at them', () => {
      // `assets/logo.svg` and `assets/attribution-strip.svg` were deleted. A
      // dangling reference would be a broken link in a README, but a *live*
      // reference would be worse: it would put the mark back on the next
      // regeneration. The npm `files` list was checked by hand too — it is
      // `["dist"]`, so neither asset was ever published to npm.
      for (const gone of ['assets/logo.svg', 'assets/attribution-strip.svg']) {
        let stillThere = true;
        try {
          statSync(join(ROOT, gone));
        } catch {
          stillThere = false;
        }
        assert.equal(stillThere, false, `${gone} must not come back (#698)`);

        const referrers = tree.files.filter((f) =>
          readFileSync(join(ROOT, f), 'utf8').includes(gone),
        );
        assert.deepEqual(
          referrers, [],
          `${gone} was deleted but is still referenced by: ${referrers.join(', ')}`,
        );
      }
    });
  });

  describe('the User-Agent rule, driven in both directions', () => {
    const scan = (body: string, rel = 'src/lib/example.ts') =>
      findMarkViolations(rel, `const HOST = 'https://api.example.com';\n${body}\n`);

    it('rejects a third-party product token — the exact value #698 removed', () => {
      const vs = scan(`const UA = 'spotify-mcp/statsfm';\nconst h = { 'user-agent': UA };`);
      assert.ok(
        rulesIn(vs).includes('ua-third-party-token'),
        `expected ua-third-party-token for 'spotify-mcp/statsfm', got: ${JSON.stringify(vs)}`,
      );
    });

    it('rejects a third-party token written directly in the header object', () => {
      const vs = scan(`const h = { 'user-agent': 'spotify-mcp/statsfm-taste' };`);
      assert.ok(
        rulesIn(vs).includes('ua-third-party-token'),
        `expected ua-third-party-token, got: ${JSON.stringify(vs)}`,
      );
    });

    it('rejects a bare token with no contact URL', () => {
      const vs = scan(`const h = { 'user-agent': 'spotify-mcp' };`);
      assert.ok(
        rulesIn(vs).includes('ua-not-neutral'),
        `expected ua-not-neutral for a UA with no contact URL, got: ${JSON.stringify(vs)}`,
      );
    });

    it('rejects a User-Agent that cannot be resolved to a literal', () => {
      // An indirection into a value this guard cannot read would otherwise pass
      // for free — the same failure mode as scanning nothing.
      const vs = scan(`import { SECRET_UA } from './somewhere.js';\nconst h = { 'user-agent': SECRET_UA };`);
      assert.ok(
        rulesIn(vs).includes('ua-unresolvable'),
        `expected ua-unresolvable, got: ${JSON.stringify(vs)}`,
      );
    });

    it('accepts the neutral form, including through a constant indirection', () => {
      const vs = scan(
        `const UA = 'spotify-mcp (+https://github.com/NovaLux12/spotify-mcp-server)';\nconst h = { 'user-agent': UA };`,
      );
      assert.deepEqual(vs, [], `the neutral form must pass cleanly: ${describeViolations(vs)}`);
    });

    it('does not fire on headers this project must keep — the Spotify API calls', () => {
      // The control that keeps the guard from becoming a compliance failure in
      // the other direction. Describing the platform is required, not
      // prohibited: an `Authorization` header against api.spotify.com, a
      // `spotify:` URI and an `open.spotify.com` link are the project working.
      const body = [
        `const res = await client.get('/me/player', { headers: { authorization: 'Bearer ' + token } });`,
        `const uri = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';`,
        `const link = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';`,
      ].join('\n');
      assert.deepEqual(
        scan(body), [],
        `required nominative references must never be flagged: ${describeViolations(scan(body))}`,
      );
    });
  });

  describe('the mark rules, driven in both directions', () => {
    it('rejects the byte-exact assets #698 removed', () => {
      const logo = findMarkViolations('assets/logo.svg', REMOVED_LOGO_SVG);
      assert.ok(
        rulesIn(logo).includes('banned-colour'),
        `assets/logo.svg used Spotify Green and must be rejected; got: ${JSON.stringify(rulesIn(logo))}`,
      );
      assert.ok(
        rulesIn(logo).includes('wordmark-in-asset'),
        `assets/logo.svg set the Spotify wordmark as text and must be rejected; got: ${JSON.stringify(rulesIn(logo))}`,
      );

      const strip = findMarkViolations('assets/attribution-strip.svg', REMOVED_STRIP_SVG);
      assert.deepEqual(
        rulesIn(strip).sort(),
        ['banned-colour', 'waves-geometry', 'wordmark-in-asset'],
        `assets/attribution-strip.svg must trip all three mark rules; got: ${JSON.stringify(rulesIn(strip))}`,
      );
    });

    it('rejects the waves geometry whatever colour it is drawn in', () => {
      // Recolouring the mark is the obvious bypass of a colour-only guard, so
      // the shape rule has to fire on a mark that is otherwise clean.
      const recoloured = REMOVED_STRIP_SVG.replace(/#1DB954/g, '#00FF66');
      const vs = findMarkViolations('assets/strip.svg', recoloured);
      assert.ok(
        rulesIn(vs).includes('waves-geometry'),
        `a recoloured waves glyph must still be rejected; got: ${JSON.stringify(rulesIn(vs))}`,
      );
      assert.ok(
        !rulesIn(vs).includes('banned-colour'),
        'the recoloured fixture must be clean on the colour rule, or it is not testing what it claims',
      );
    });

    it('rejects each banned colour notation', () => {
      for (const notation of ['#1DB954', '#1db954', '  #1ED760  ', 'rgb(29,185,84)', 'rgba(30, 215, 96, 0.5)']) {
        const vs = findMarkViolations('assets/x.svg', `<svg><rect fill="${notation}"/></svg>`);
        assert.ok(
          rulesIn(vs).includes('banned-colour'),
          `expected ${notation} to be rejected as a banned colour; got: ${JSON.stringify(vs)}`,
        );
      }
    });

    it('accepts a neutral project mark', () => {
      const vs = findMarkViolations('assets/logo.svg', NEUTRAL_LOGO_SVG);
      assert.deepEqual(vs, [], `a neutral-palette mark must pass: ${describeViolations(vs)}`);
    });

    it('accepts ordinary shapes — the rule discriminates, it does not reject all art', () => {
      const vs = findMarkViolations('assets/icons.svg', ORDINARY_SHAPES_SVG);
      assert.deepEqual(
        vs, [],
        `three straight-edged paths in a group are not the waves; the geometry rule must not fire: ${describeViolations(vs)}`,
      );
    });

    it('accepts a source file that mentions Spotify only in prose', () => {
      const vs = findMarkViolations(
        'src/tools/search.ts',
        `// Queries the Spotify Web API. Returns spotify: URIs for the caller.\nconst brand = 'Spotify Web API';\n`,
      );
      assert.deepEqual(
        vs, [],
        `plain-text nominative references are required by Policy II.4.a and must not be flagged: ${describeViolations(vs)}`,
      );
    });
  });

  describe('the policy is written down, not just enforced', () => {
    // An enforcement rule nobody can read is a rule nobody follows. These are
    // presence assertions, so unlike the ones above they cannot pass vacuously.
    const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

    it('CONTRIBUTING.md states the brand-mark constraint and keeps attribution', () => {
      const c = read('CONTRIBUTING.md');
      assert.match(c, /## Brand marks, wordmarks, and attribution/,
        'CONTRIBUTING.md must carry the brand-mark section');
      assert.match(c, /1DB954/i, 'the constraint must name the banned colour concretely');
      assert.match(c, /1ED760/i, 'both Spotify Green notations must be named');
      assert.match(c, /User-Agent/, 'the constraint must cover the outbound User-Agent too');
      assert.match(c, /not affiliated with, endorsed by, or sponsored by/i,
        'the section must state the non-affiliation direction, not just the prohibition');
    });

    it('docs/compliance.md names the official asset and its size and exclusion-zone rules', () => {
      const d = read('docs/compliance.md');
      assert.match(d, /branding-guidelines/i,
        'docs/compliance.md must point at the official Branding Guidelines');
      assert.match(d, /full logo/i,
        'the attribution policy must specify the FULL logo, not the bare icon');
      assert.match(d, /70\s*px/i, 'the documented minimum size for the full logo must be stated');
      assert.match(d, /exclusion zone/i, 'the exclusion-zone rule must be stated');
      assert.match(d, /20\s*mm/i, 'the print minimum size must be stated alongside the digital one');
      assert.match(d, /do not (?:draw|vendor)|never (?:draw|vendor)|not vendor/i,
        'the policy must say the mark is referenced by URL, not redrawn or vendored');
    });
  });
});
