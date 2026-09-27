/**
 * #1468 — the tool-output half of #1399's guard.
 *
 * Four user-facing 403 strings told the operator to **do something**: obtain
 * credentials from a grandfathered (pre-Nov-2024) app, as though that were a
 * known working path. The same repository says the opposite in
 * `src/gating.ts` and in `docs/configuration.md`: whether a pre-Nov-2024
 * registration still answers `200` on any of these paths is **unverified**
 * (#1338) — no client id or app age is on record, and the one probe artefact
 * that was ever cited for it (`git show 1a53544:memory/edge-probe-2026-08-26.json`)
 * records `403` for both `/users` paths.
 *
 * So the instruction was falsifiable by the reader and could not be satisfied:
 * do the thing, get another 403, with the server having named a remedy it
 * cannot stand behind. `get_available_markets` is the sharpest case — it names
 * what actually works (market inputs are validated against the bundled
 * ISO 3166-1 alpha-2 list) and *then* tells the reader to go and find
 * grandfathered credentials.
 *
 * ## What this file holds the register to
 *
 * The repo already has the right register, in
 * `src/tools/exhaust2_catalog.ts` and in `graceful403Message()`: a grandfathered
 * registration **may still** read the path, offered as a possibility and
 * marked unverified. #1399 pinned that for the *docs*; nothing pinned it for
 * tool output, which is where a reader is most likely to meet it. The three
 * assertions below are the tool-output half:
 *
 *  1. every one of the four sites **carries the shared hedged clause**;
 *  2. none of them **prescribes** a remedy;
 *  3. the four **agree with each other**, so the register cannot drift apart
 *     the way a comment and its code did.
 *
 * ## Why these drive the tools rather than grepping the source
 *
 * §6: "a test that cannot fail is worse than no test." Each message is obtained
 * by invoking the registered tool against a client that 403s, and the
 * assertion reads the error the caller would actually see. A source grep is
 * kept as a *second* net for a fifth site nobody enumerated, and it takes its
 * detector as an argument so the failing case can be demonstrated rather than
 * assumed — the exact defect #931 records, where a guard imported the function
 * it was checking and so could only ever see the correct input.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { SpotifyApiError } from '../src/client.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerUsersTools } from '../src/tools/users.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The one clause all four sites must carry, verbatim.
 *
 * Distinctive on purpose: the old text contains neither `is unverified` nor
 * `no probe in this repository`, so the old string cannot satisfy this. That
 * is asserted as a control below rather than assumed — `CONTROL` is the text
 * as it stood before #1468, run through the same matchers.
 */
const HEDGED_CLAUSE =
  'Whether a grandfathered (pre-Nov-2024) app registration may still read';
const HEDGED_TAIL =
  'is unverified: no probe in this repository shows a 200 on this path.';

/**
 * The prescriptive form #1468 removed. Deliberately narrow: it matches an
 * *instruction to obtain grandfathered credentials*, not a mention of a
 * grandfathered registration, because the hedged clause names one on purpose.
 */
const PRESCRIBES_REMEDY = /run with credentials from a grandfathered \(pre-Nov-2024\) app/i;

/**
 * The four strings as they stood before #1468, kept as the control input.
 *
 * These are in SOURCE form, not rendered form, because that is what the
 * source-level detector below has to find — and one of the four was written
 * across a `+` concatenation seam, which is precisely the case a per-line scan
 * misses. `CONTROL.get_category` reproduces that seam verbatim.
 */
const CONTROL = {
  'get_user_profile':
    'Spotify returned 403 for the user-profile lookup: Forbidden. GET /users/{id} was removed by ' +
    "Spotify's February 2026 Web API changes; run with credentials from a grandfathered " +
    '(pre-Nov-2024) app if you need it.',
  'get_user_playlists_by_id':
    'Spotify returned 403 for the user-playlists lookup: Forbidden. GET /users/{id}/playlists was ' +
    "removed by Spotify's February 2026 Web API changes; run with credentials from a grandfathered " +
    '(pre-Nov-2024) app if you need it.',
  get_category:
    '`The browse-category lookup (${path}) could not be answered: ${detail} GET /browse/categories/{id} and ` +\n' +
    "      'GET /browse/categories/{id}/playlists were removed by Spotify’s February 2026 Web API changes and ' +\n" +
    "      'have no replacement endpoint, so the category and its playlists cannot be read; run with credentials ' +\n" +
    "      'from a grandfathered (pre-Nov-2024) app if you need them.',",
  get_available_markets:
    'Spotify returned 403 for the markets lookup: Forbidden. GET /markets was removed by Spotify’s ' +
    'February 2026 Web API changes, so the set of markets Spotify serves cannot be read on a current ' +
    'registration; market inputs are validated against the bundled ISO 3166-1 alpha-2 list instead, and ' +
    'the market a lookup runs under comes from its market argument or SPOTIFY_MCP_MARKET. Run with ' +
    'credentials from a grandfathered (pre-Nov-2024) app if you need the served-market list.',
};

// ---------------------------------------------------------------- plumbing

type ToolContent = { content: Array<{ type: string; text: string }> };
type RegisteredTool = {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

const FORBIDDEN = new SpotifyApiError(403, 'Forbidden');

/**
 * Registers both modules onto one stub server, with a client that 403s every
 * read. `catalog` and `users` are the two files that carry the four sites.
 */
function gatedHarness() {
  const paths: string[] = [];
  const client = {
    get: async (path: string) => {
      paths.push(path);
      throw FORBIDDEN;
    },
    post: async () => null,
    put: async () => {},
    putRaw: async () => {},
    delete: async () => {},
    getAllPages: async () => [],
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) => registered.push({ name, description, schema, handler }),
    registerTool: () => {
      throw new Error('these two modules register through server.tool() only');
    },
  };
  registerUsersTools(server as never, client as never);
  registerCatalogTools(server as never, client as never);
  return {
    paths,
    async message(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
      const tool = registered.find((t) => t.name === toolName);
      assert.ok(tool, `expected ${toolName} to be registered`);
      // Parse through the schema the way the MCP SDK does, so a fixture that
      // the real resolver would reject cannot pass as a 403 path.
      const parsed = z.object(tool.schema).parse(args) as Record<string, unknown>;
      try {
        await tool.handler(parsed);
      } catch (err) {
        assert.ok(err instanceof Error, `${toolName} rejected with a non-Error`);
        return err.message;
      }
      assert.fail(`${toolName} resolved on a 403 client — the message under test was never produced`);
    },
  };
}

/** The four sites, with the tool that reaches each and the endpoint it names. */
const SITES: ReadonlyArray<{ tool: string; args: Record<string, unknown>; path: string }> = [
  { tool: 'get_user_profile', args: { user_id: 'spotifyuser' }, path: '/users/spotifyuser' },
  {
    tool: 'get_user_playlists_by_id',
    args: { user_id: 'spotifyuser' },
    path: '/users/spotifyuser/playlists',
  },
  { tool: 'get_category', args: { category_id: 'mood' }, path: '/browse/categories/mood' },
  { tool: 'get_available_markets', args: {}, path: '/markets' },
];

// ------------------------------------------------------------------- tests

describe('403 messages do not prescribe a grandfathered app (#1468)', () => {
  const harness = gatedHarness();
  const seen: Record<string, string> = {};

  it('reaches all four sites — the fixtures are not vacuous', async () => {
    for (const site of SITES) {
      const message = await harness.message(site.tool, site.args);
      seen[site.tool] = message;
      // Each message must name the endpoint it is about. A harness that threw
      // a generic SpotifyApiError, or wired the wrong tool to the wrong stub,
      // fails here rather than making every assertion below vacuous.
      assert.ok(
        message.includes('403'),
        `${site.tool} did not report a 403; got: ${message}`,
      );
    }
    // The client really was driven to the four endpoints: a 403 wrapper that
    // short-circuits before the request would leave this list empty.
    assert.deepEqual(harness.paths, SITES.map((s) => s.path));
  });

  it('carries the hedged, unverified clause at every site', async () => {
    for (const site of SITES) {
      const message = seen[site.tool];
      assert.ok(
        message.includes(HEDGED_CLAUSE),
        `${site.tool} does not offer a grandfathered registration as a possibility. ` +
          `Expected the clause "${HEDGED_CLAUSE}…" in: ${message}`,
      );
      assert.ok(
        message.includes(HEDGED_TAIL),
        `${site.tool} offers the possibility without marking it unverified. ` +
          `Expected the tail "${HEDGED_TAIL}" in: ${message}`,
      );
    }
  });

  it('prescribes no remedy at any site', () => {
    for (const site of SITES) {
      assert.doesNotMatch(
        seen[site.tool],
        PRESCRIBES_REMEDY,
        `${site.tool} still tells the operator to run with grandfathered credentials, which is an ` +
          'instruction they can follow and be wrong about. Offer the possibility, mark it unverified.',
      );
    }
  });

  it('leads with the alternative that does work, where one exists', () => {
    // #1468: the markets message already names what the reader can use. The
    // useful half has to come first, or a hedged tail reads as "nothing works".
    const markets = seen.get_available_markets;
    const useful = markets.indexOf('bundled ISO 3166-1 alpha-2 list');
    const hedge = markets.indexOf(HEDGED_CLAUSE);
    assert.ok(useful !== -1, `get_available_markets dropped the working alternative: ${markets}`);
    assert.ok(hedge !== -1, `get_available_markets dropped the hedged clause: ${markets}`);
    assert.ok(
      useful < hedge,
      'get_available_markets must state the working alternative before the unverified possibility, ' +
        `not after it. Order was: ${markets}`,
    );
  });

  it('gives the four sites one register, not two', () => {
    // The divergence this issue is about was between exhaust2_catalog.ts's
    // hedge and these four's instruction. Extracting the clause from the
    // shipped strings — not from a constant in this file — and comparing the
    // four is what stops a future edit reintroducing a second register on one
    // site only.
    //
    // The subject of "may still read" is the one part that legitimately
    // varies: it takes the grammatical object of the sentence the clause sits
    // in ("it" after a profile, "them" after a category and its playlists,
    // "the served-market list" after three preceding nouns). It is a slot, so
    // the frame normalises it — and the substitution is applied to the real
    // text, so a reword, a dropped hedge or an empty slot all produce a
    // different frame and fail here rather than passing on a constant.
    const frames = SITES.map((site) => {
      const text = seen[site.tool];
      const start = text.indexOf(HEDGED_CLAUSE);
      const end = text.indexOf(HEDGED_TAIL, start);
      assert.ok(
        start !== -1 && end !== -1,
        `${site.tool} carries no hedged clause to compare: ${text}`,
      );
      const clause = text.slice(start, end + HEDGED_TAIL.length);
      const subject = clause.slice(HEDGED_CLAUSE.length, clause.length - HEDGED_TAIL.length).trim();
      assert.ok(
        subject.length > 0,
        `${site.tool} reads "may still read is unverified" — the hedge has no subject: ${text}`,
      );
      return clause.replace(subject, '<subject>');
    });

    const distinct = [...new Set(frames)];
    assert.equal(
      distinct.length,
      1,
      `the four 403 messages now carry ${distinct.length} different registers:\n  ${distinct.join('\n  ')}`,
    );
  });

  it('the control fails every assertion above — the old text is not a substitute', () => {
    // The proof the brief asks for. CONTROL is the pre-#1468 text, so a
    // matcher that the shipped strings satisfy and these do not cannot be
    // passing for a reason that has nothing to do with the fix. The remedy is
    // read through the source detector, because that is the matcher that has
    // to survive the `+` seam.
    for (const [tool, oldText] of Object.entries(CONTROL)) {
      assert.ok(
        !oldText.includes(HEDGED_CLAUSE) && !oldText.includes(HEDGED_TAIL),
        `${tool}: CONTROL must predate #1468 — it satisfies the hedged clause`,
      );
      assert.equal(
        prescribesRemedyIn(oldText).length,
        1,
        `${tool}: CONTROL must be flagged by the remedy detector — if it is not, the detector and ` +
          'the old text have drifted apart and the negative assertion proves nothing',
      );
    }
  });
});

/**
 * The source-level net for a fifth site nobody enumerated. The detector takes
 * its text as an argument so the failing case can be shown, per §6 and the
 * #931 lesson — a guard that imports the shipped strings can only ever see the
 * correct input.
 *
 * It scans the *concatenation-joined* source, not one line at a time. The
 * remedy in `browseCategoryUnavailable` is split across two source lines by a
 * `+` seam — `'...cannot be read; run with credentials ' +` then
 * `'from a grandfathered (pre-Nov-2024) app if you need them.'` — so the
 * obvious per-line scan misses one of the four sites this file exists for. A
 * per-line detector is not a weaker guard; it is a different one, and it was
 * measured missing 1 of 4 before this seam handling went in. The control
 * below pins that: all four CONTROL strings must register.
 */
const REMEDY_PHRASE = 'run with credentials from a grandfathered (pre-Nov-2024) app';
/**
 * The phrase is interpolated, so it is escaped first: the parentheses in
 * `(pre-Nov-2024)` are regex metacharacters, and interpolating them raw builds
 * a *capture group* that matches `pre-Nov-2024` without the literal brackets —
 * a detector that silently matches a different string than it names. That was
 * measured, not assumed: the unescaped form found none of the four controls.
 */
const REMEDY_AT = new RegExp(REMEDY_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

/**
 * The text the detector actually scans.
 *
 * Two transformations, each earning its place by a measured failure:
 *
 *  1. `+` concatenation seams are joined. `browseCategoryUnavailable` splits
 *     its remedy across two source lines (`` … `+\n  '…' ``), so a per-line
 *     scan finds 3 of the 4 sites this file exists for. Both quote styles are
 *     matched — that seam joins a template literal to a single-quoted string,
 *     and a single-quote-only pattern misses it, which is how the first
 *     version of this detector shipped broken.
 *  2. Runs of spaces and tabs are collapsed, because joining a seam onto a
 *     literal that already ends in a space leaves a double space inside the
 *     phrase. Newlines are NOT collapsed: they stay hard boundaries, so a match
 *     can never be assembled out of two unrelated lines.
 */
function scanable(source: string): string {
  return source.replace(/['"`]\s*\+\s*\n\s*['"`]/g, ' ').replace(/[ \t]+/g, ' ');
}

/**
 * The line a hit sits on, anchored on the text that FOLLOWS the phrase. The
 * phrase itself is not a usable anchor for the seam case — that is exactly the
 * one where it does not appear verbatim in the file — while its tail does.
 *
 * The search starts at `minLine` rather than at the top of the file, because
 * two of the four sites end in the identical `if you need it.',` and a plain
 * `indexOf` reported both as the first one's line. `minLine` is the hit's line
 * in the *scanned* text, and collapsing a seam only ever removes a newline, so
 * the original line is at or after it — which makes the anchor both correct
 * and monotone. (Measured: an earlier version named three lines for four hits.)
 */
function anchorLine(source: string, tail: string, minLine: number): number {
  const from = lineStart(source, minLine);
  for (let n = Math.min(40, tail.length); n >= 12; n--) {
    const head = tail.slice(0, n).trimEnd();
    if (head.length < 12) continue;
    const at = source.indexOf(head, from);
    if (at !== -1) return source.slice(0, at).split('\n').length;
  }
  return 0;
}

/** Byte offset of the first character of `line` (1-based). */
function lineStart(source: string, line: number): number {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = source.indexOf('\n', at);
    if (nl === -1) return source.length;
    at = nl + 1;
  }
  return at;
}

/** Widens to the enclosing string literal, never crossing a quote or newline. */
function widen(text: string, from: number, to: number): [number, number] {
  const boundary = (ch: string): boolean => /['";\n]/.test(ch);
  let start = from;
  while (start > 0 && from - start < 200 && !boundary(text[start - 1])) start--;
  let end = to;
  while (end < text.length && end - to < 200 && !boundary(text[end])) end++;
  return [start, end];
}

function prescribesRemedyIn(source: string): Array<{ line: number; text: string }> {
  const text = scanable(source);
  const found: Array<{ line: number; text: string }> = [];
  for (const m of text.matchAll(REMEDY_AT)) {
    const at = m.index as number;
    const [start, end] = widen(text, at, at + REMEDY_PHRASE.length);
    const scanLine = text.slice(0, at).split('\n').length;
    found.push({
      line: anchorLine(source, text.slice(at + REMEDY_PHRASE.length, end), scanLine),
      text: text.slice(start, end).trim(),
    });
  }
  return found;
}

describe('no source under src/ prescribes a grandfathered app (#1468)', () => {
  const sourceFiles = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(full);
    }
    return found;
  };

  const files = sourceFiles(join(ROOT, 'src'));

  it('scans a real source surface — the walk is not vacuous', () => {
    assert.ok(
      files.length > 20,
      `the source walk found only ${files.length} .ts files. If that is ever true the scan is not ` +
        'covering the code it is meant to guard.',
    );
    // The detector must fire on the text it is looking for. Without this a
    // broken detector — a bad regex, an over-escaped pattern — reads as a
    // clean tree, which is the failure mode §6 warns about. All four CONTROL
    // strings must register, including the one a per-line scan misses because
    // of the `+` seam.
    for (const [tool, oldText] of Object.entries(CONTROL)) {
      assert.equal(
        prescribesRemedyIn(oldText).length,
        1,
        `the source detector does not match the remedy in CONTROL.${tool} — it would miss that site`,
      );
    }
    // And the seam handling is what makes the fourth one findable: the same
    // detector, run line by line, is the weaker guard. This is the measured
    // defect — the first version of the scan found 3 of the 4 sites.
    assert.equal(
      CONTROL.get_category.split('\n').filter((l) => PRESCRIBES_REMEDY.test(l)).length,
      0,
      'CONTROL.get_category was expected to be split across lines by a `+` seam; if it no longer is, ' +
        'the seam handling is no longer exercised and the detector is untested on it',
    );
    assert.equal(
      prescribesRemedyIn(CONTROL.get_category).length,
      1,
      'the seam-joined scan no longer finds the remedy the per-line scan misses',
    );
  });

  it('finds no line prescribing grandfathered credentials', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const hits = prescribesRemedyIn(readFileSync(file, 'utf8'));
      for (const hit of hits) {
        offenders.push(`${file.slice(ROOT.length + 1)}:${hit.line}: ${hit.text}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a user-facing string still tells the operator to obtain credentials from a grandfathered ' +
        'app. Whether such a registration still answers 200 is unverified (#1338) — no client id or ' +
        'app age is on record here, and the one probe artefact once cited for it records 403. Offer ' +
        'the possibility and mark it unverified, as src/tools/exhaust2_catalog.ts does. Offending ' +
        `lines:\n  ${offenders.join('\n  ')}`,
    );
  });
});
