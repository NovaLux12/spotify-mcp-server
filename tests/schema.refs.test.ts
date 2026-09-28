/**
 * The entity-id reference contract (#914).
 *
 * `src/refs.ts` is the one resolver that turns a bare id, a `spotify:` URI, a
 * `spotify://` link or an open.spotify.com share URL into a bare id. Whether a
 * reference had to be bare used to depend on which module the tool lived in:
 * an agent that learned "URIs work" from a `swarm3_*` tool and then called
 * `get_playlist` with the same reference got a URL-encoded URI in the request
 * path and a 404 that looked like a missing playlist.
 *
 * This file is the gate that makes the invariant enforceable rather than a
 * convention. It has two halves:
 *
 *  1. A source scan over `src/tools/**` that fails when a parameter whose NAME
 *     is id-shaped is declared without a resolver, and is not one of the named
 *     exemptions below. New drift fails CI on the commit that introduces it,
 *     which is the only point at which the cost of fixing it is small.
 *
 *  2. Wire-level tests asserting the resolved bare id — not the caller's
 *     original string — is what reaches the client.
 *
 * ## Why the migration used `spotifyRef` and not `spotifyId`
 *
 * The obvious implementation of the issue's step 2 is to route all ~105
 * parameters through `spotifyId(kind)`. That is correct by the letter of the
 * issue and wrong in effect, and the reason is worth keeping: `spotifyId()`
 * hard-rejects anything that is not exactly 22 URL-safe characters, so
 * migrating every `playlist_id` also turns "the caller passed something that is
 * not a playlist id" from a 404 into a 400 across a third of the tool surface,
 * and it invalidates every test that used a readable fake id like `pl1`.
 *
 * `spotifyRef(schema, kind)` in `src/refs.ts` is the tolerant sibling: it
 * normalises every form the resolver can classify and passes everything else
 * through untouched. That fixes the reported defect — a URI or share URL
 * reaching the path unnormalised — without inventing a new failure mode, and
 * it is why all 105 parameters could be migrated in one change with the
 * existing suite green. SPEC §5.14 states the two policies side by side.
 *
 * The exemptions below are the four id-shaped parameters that are genuinely
 * not Spotify entity references, each with the reason, and the scan fails in
 * both directions: a new bare-string id parameter fails today, and an exemption
 * that has gone stale — or that starts covering a parameter which has since
 * been migrated — fails too.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerSwarm3ShowsTools } from '../src/tools/swarm3_shows.js';
import { registerBrowseTools } from '../src/tools/browse.js';
import { registerAudiobookTools } from '../src/tools/audiobooks.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';
import { spotifyId, spotifyRef } from '../src/refs.js';

const TOOLS_DIR = 'src/tools';

/**
 * Parameter-name shapes that are NOT Spotify entity references.
 *
 * Each entry says why, because "it looked like an id" is exactly the reasoning
 * that put a `device_id` through `spotifyId('track')`. A device id comes from
 * `GET /me/player/devices` and is not a catalog entity; a snapshot, session,
 * receipt, mutation or history id is minted by THIS server; a category is a
 * human label like `party`, not an id at all.
 *
 * A name in this set is exempt from the scan entirely. Adding a name here is a
 * claim that the parameter is not a Spotify entity reference, and it is the
 * claim the test exists to make hard to get wrong.
 */
const NOT_A_SPOTIFY_ENTITY: Readonly<Record<string, string>> = Object.freeze({
  device_id: 'A device id from GET /me/player/devices — not a catalog entity. `GET /me/player` matches on it verbatim.',
  device_ids: 'Device ids from GET /me/player/devices, in the same non-catalog space as device_id.',
  exclude_device_id: 'A device id, negated. Same non-catalog space as device_id.',
  snapshot_id: 'A snapshot id minted by this server (snapshot_playlist / diff_since_snapshot), not a Spotify id.',
  session_id: 'A session id minted by this server, not a Spotify id.',
  receipt_id: 'A mutation receipt id minted by this server, not a Spotify id.',
  mutation_id: 'A mutation-history id minted by this server, not a Spotify id.',
  history_id: 'A history-entry id minted by this server, not a Spotify id.',
  bookmark_id: 'A caller-supplied label for restoring this server\'s own state, not a Spotify id.',
  category_id: 'A browse category label such as `party`, not an id. The endpoint that took it was removed in Feb 2026.',
});

/**
 * The migration ledger: entity-id parameters still declared as plain strings.
 *
 * The issue asked for every entity-id parameter to be routed through the
 * shared resolver, and that is now done: this table is EMPTY. It is kept,
 * along with the test that fails when it goes stale, because the alternative
 * is a gate that only knows how to say "add a row" and not how to say
 * "delete the row" — and a ledger that can only grow is how a migration
 * quietly stops being one.
 *
 * What replaced it, and why the migration was safe, is in `spotifyRef()` in
 * `src/refs.ts`: normalise what the resolver can classify, pass through
 * everything else untouched. Routing all 105 parameters through the STRICT
 * `spotifyId()` would have been correct by the letter of the issue and wrong
 * in effect — it converts a 404 for a malformed id into a 400 across the
 * largest part of the tool surface, and breaks every fixture that uses a
 * readable fake id. The defect the issue actually reports is that a `spotify:`
 * URI or a share URL reached the request path unnormalised, so normalising is
 * the fix and rejecting is not.
 */
const NOT_YET_MIGRATED: Readonly<Record<string, readonly string[]>> = Object.freeze({});

/**
 * The four id-shaped parameters that are genuinely NOT Spotify entity
 * references, keyed by `tool.parameter` because the NAME alone cannot tell them
 * apart from the ones that must be migrated.
 *
 * `id` is the interesting one: it is a real entity id on `get_audiobook` and a
 * local receipt id on `receipt_lookup`, and `id` alone says nothing about
 * which. Naming the tool is what lets the gate admit `get_audiobook`'s `id` and
 * refuse `receipt_lookup`'s, which is the same rule the NOT_A_SPOTIFY_ENTITY
 * name table applies one level up.
 *
 * The key is the TOOL, not a line number, deliberately. A `file:line` key is
 * the obvious choice and it is wrong: every import added above a declaration
 * shifts it, so an unrelated edit silently re-points the exemption at a
 * different parameter — or at nothing, which reads as a stale entry rather
 * than as the silent hole it is.
 */
const NOT_A_SPOTIFY_ENTITY_AT: Readonly<Record<string, string>> = Object.freeze({
  // `receipt_lookup` is local and makes zero API calls: `id` is a receipt id
  // minted by this server (`rcpt_…-N`), matched against `r.receipt_id`. Running
  // it through the resolver would make every real receipt id 400.
  'receipt_lookup.id': 'receipt_lookup `id` — a receipt id minted by this server, matched locally against r.receipt_id. Not a Spotify reference.',
  // `format_spotify_uri` IS the validity oracle. Its `id` is the thing being
  // judged: it deliberately accepts text that is not a valid reference so it
  // can answer `valid: false` with a reason. Normalising it first would make
  // the tool unable to report the invalid case it exists to report.
  'format_spotify_uri.id': 'format_spotify_uri `id` — the validity oracle itself. It must accept text that is not a valid reference in order to return valid:false; normalising it first would hide the rejection it exists to report.',
  // `get_chapter` targets /chapters/{id}. A chapter is not one of the eight
  // kinds in SPOTIFY_REFERENCE_KINDS and has no shareable spotify: URI, so
  // there is no reference form for the resolver to normalise — wrapping it
  // would be a no-op that only satisfied this gate.
  'get_chapter.id': 'get_chapter `id` — a chapter id from /chapters/{id}. Chapters are not a SPOTIFY_REFERENCE_KINDS member and have no shareable URI, so there is no reference form to normalise.',
  // `check_following_artists.ids` already normalises: its HANDLER maps every
  // element through normalizeArtistReference (allowShortIds, so the short ids
  // these tools have always accepted keep working). The correctness lives in
  // the handler rather than the schema, which this gate is closing — but
  // moving it would drop allowShortIds and break those short ids.
  'check_following_artists.ids': 'check_following_artists `ids` — already normalised by normalizeArtistIds in the handler, with allowShortIds so the short ids this tool has always accepted keep working. Hoisting it into the schema would drop that allowance.',
});

/** Names exempt because they are not Spotify entity references. */
const EXEMPT_NAMES: ReadonlySet<string> = new Set(Object.keys(NOT_A_SPOTIFY_ENTITY));

/** Declaration sites exempt because they are not Spotify entity references. */
const EXEMPT_SITES: ReadonlySet<string> = new Set(Object.keys(NOT_A_SPOTIFY_ENTITY_AT));

/**
 * A parameter name is id-shaped if it is `id`/`ids` or ends `_id`/`_ids`.
 *
 * The middle group admits underscores, so `target_playlist_id` counts. A
 * pattern that only matched a single word before the suffix would miss every
 * multi-word id in the codebase — and a gate that undercounts is a gate that
 * reports success while the drift it exists to catch goes unrecorded.
 */
const ID_SHAPED = /^(id|ids|[a-z][a-z0-9_]*_ids?)$/;

/**
 * Shared schemas that already resolve through the reference policy but are not
 * written as a `spotifyId(...)` call at the declaration site.
 *
 * `PlaylistRef` / `PlaylistId` in `src/shaping.ts` normalise through
 * `classifySpotifyReference` in a `.transform`, so a tool using them satisfies
 * the contract this file is about. They are named here rather than pattern-
 * matched so that a new shared schema has to be classified on purpose: an
 * unrecognized factory in a spot should be a failure, not a silent pass.
 */
const SHARED_RESOLVER_SCHEMAS: ReadonlySet<string> = new Set(['PlaylistId', 'PlaylistRef']);

/**
 * Factories that route a value through the shared reference policy.
 *
 * `spotifyRef` is listed alongside `spotifyId` because both go through
 * `src/refs.ts`, and the scan must recognise BOTH: a gate whose alternation
 * only knows the strict factory reports every migrated parameter as plain
 * drift, and the first person to run it would "fix" 105 correct declarations
 * by unwrapping them.
 */
const RESOLVER_FACTORIES: ReadonlySet<string> = new Set(['spotifyId', 'spotifyRef', 'spotifyIdArray']);

/** The kinds `src/refs.ts` can resolve. */
const REFERENCE_KINDS = new Set([
  'track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook', 'user',
]);

interface Declaration {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** The zod factory as written, e.g. `z.string()` or `spotifyRef`. */
  readonly factory: string;
  /**
   * The tool the parameter belongs to, from the nearest preceding
   * `server.tool(`/`registerTool(` name literal, or `''` if the declaration
   * sits outside a registration.
   */
  readonly tool: string;
}

function idShapedDeclarations(): Declaration[] {
  const found: Declaration[] = [];
  for (const entry of readdirSync(TOOLS_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const file = join(TOOLS_DIR, entry);
    const lines = readFileSync(file, 'utf8').split('\n');
    // A registration names its tool in the first string literal at or after the
    // `server.tool(` call — usually the NEXT line, because the repo writes it
    // one-argument-per-line. Reading only the call's own line attributes every
    // schema to '', which silently disarms the tool-keyed exemption table.
    const REGISTER = /\b(?:server\.)?(?:registerTool|tool)\s*\(/;
    const NAME_LITERAL = /['"]([a-z][a-z0-9_]*)['"]/;
    let tool = '';
    lines.forEach((text, index) => {
      if (REGISTER.test(text)) {
        const sameLine = NAME_LITERAL.exec(text.slice(text.indexOf('(')));
        const nextLine = sameLine ? null : NAME_LITERAL.exec(lines[index + 1] ?? '');
        const found_ = sameLine ?? nextLine;
        tool = found_ ? found_[1]! : '';
      }
      // A tool-parameter declaration: `<name>: <zod factory>` at the top level of
      // a schema object literal. Anchored to the start of a line so a handler
      // destructuring or a hand-rolled object cannot be mistaken for one. The
      // factory alternation admits a bare capitalised schema name because
      // `registerTool({ inputSchema: z.object({ … }) })` puts several
      // declarations on one line, and it admits `spotifyRef` alongside
      // `spotifyId` because the migration uses the tolerant one.
      const match = /^(\s*)([a-z][a-z0-9_]*):\s*(z\.[A-Za-z]+|spotifyId[A-Za-z]*|spotifyRef|[A-Z][A-Za-z0-9]*)\b/.exec(text);
      if (!match) return;
      const name = match[2]!;
      if (!ID_SHAPED.test(name)) return;
      found.push({ file, line: index + 1, name, factory: match[3]!, tool });
    });
  }
  return found;
}

/** The `tool.parameter` key the site-level exemption table is written against. */
function siteOf(declaration: Declaration): string {
  return `${declaration.tool}.${declaration.name}`;
}

/**
 * The full declaration text, from the matched name to the comma that ends the
 * property — a declaration can wrap onto continuation lines, and judging only
 * the first line would let a resolver on line 1 vouch for a plain string below.
 */
function declarationText(declaration: Declaration): string {
  const lines = readFileSync(declaration.file, 'utf8').split('\n');
  let text = lines[declaration.line - 1] ?? '';
  let end = declaration.line - 1;
  while (!/,\s*$/.test(text.trim()) && end + 1 < lines.length) {
    end++;
    text += ' ' + lines[end]!.trim();
  }
  return text;
}

/**
 * True when the declaration's VALUE is rooted at a shared resolver.
 *
 * This is structural, not a substring search, on purpose. A gate that greps the
 * line for `spotifyRef(` is satisfied by a description that merely mentions it
 * — `playlist_id: z.string().describe('prefer spotifyRef(x)')` would pass
 * while the parameter took the caller's URI verbatim, which is the exact defect
 * this file exists to catch (AGENTS.md §6: a check that cannot fail is worse
 * than none).
 *
 * So the value is unwrapped through the chain that can legitimately sit on top
 * of a resolver — `z.array(...)` for a list of references, and trailing
 * `.min()/.max()/.optional()/.describe()` — and what remains must START with a
 * resolver factory. Anything else is plain.
 */
function isResolverBacked(declaration: Declaration): boolean {
  if (RESOLVER_FACTORIES.has(declaration.factory)) return true;
  if (SHARED_RESOLVER_SCHEMAS.has(declaration.factory)) return true;

  // Take the value expression: everything after the first `name:`.
  const text = declarationText(declaration);
  const colon = text.indexOf(':');
  if (colon < 0) return false;
  let value = text.slice(colon + 1).trim().replace(/,$/, '').trim();

  // Peel the array wrapper, if any, so `z.array(spotifyRef(...))` is judged on
  // its element schema rather than on the array factory.
  const arrayOpen = value.indexOf('z.array(');
  if (arrayOpen === 0) {
    let depth = 0;
    let close = -1;
    for (let i = value.length - 1; i >= 0; i--) {
      if (value[i] === ')') depth++;
      else if (value[i] === '(') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) return false;
    value = value.slice('z.array('.length, close).trim();
  }

  // Then require the innermost schema to BE a resolver call.
  return /^spotifyRef[A-Za-z]*\s*\(|^spotifyId[A-Za-z]*\s*\(|^(PlaylistRef|PlaylistId)\b/.test(value);
}

describe('#914 no entity-id parameter is declared as a plain string', () => {
  const allDeclarations = idShapedDeclarations();
  const declarations = allDeclarations.filter(
    (d) => !EXEMPT_NAMES.has(d.name) && !EXEMPT_SITES.has(siteOf(d)),
  );

  it('found the id-shaped parameters it is gating', () => {
    // A scan that silently matched nothing would report success forever. This
    // is the same failure as the `playlist_exclude_artists` id-only comparison
    // #885 removed, one layer up: a check that cannot fail is worse than none.
    assert.ok(
      declarations.length > 50,
      `the scan only found ${declarations.length} id-shaped parameters — it is not reading the schemas`,
    );
    assert.ok(
      declarations.some((d) => isResolverBacked(d)),
      'no resolver-backed parameter was found either; the factory pattern is stale',
    );
  });

  it('every entity-id parameter is routed through the shared resolver', () => {
    // This is the issue's acceptance criterion, and it is the assertion the
    // migration is written to satisfy: no id-shaped parameter is left taking
    // the caller's string verbatim. It was 105 sites when this landed.
    const unlisted = declarations
      .filter((d) => !isResolverBacked(d))
      .map((d) => `${siteOf(d)} ${d.name}`);
    assert.deepEqual(
      unlisted,
      [],
      'these id-shaped parameters are neither resolver-backed, nor exempt, nor on the migration ledger — '
        + 'route them through spotifyRef(schema, kind) or say in NOT_A_SPOTIFY_ENTITY_AT why they are not Spotify ids',
    );
  });

  it('the migration ledger is empty, because the migration is done', () => {
    // The ledger is the gate's memory of outstanding work. It is empty now, and
    // the assertion is that it stays that way: a parameter that drifts back to
    // a plain string is caught by the assertion above, and a row that
    // outlives its parameter is caught here. A ledger that can only grow is
    // how a migration quietly stops being one.
    assert.deepEqual(
      Object.entries(NOT_YET_MIGRATED).flatMap(([, names]) => [...names]),
      [],
      'the migration ledger is non-empty — either a parameter came back, or a row was missed',
    );
  });

  it('every exemption is live, and still earns its place', () => {
    // Two failure modes, one assertion each, because an exemption table can rot
    // in both directions:
    //
    //  - A row naming a parameter that no longer exists exempts nothing while
    //    claiming to, so the gate's real coverage reads larger than it is.
    //  - A row covering a parameter that has since been MIGRATED is a hole: the
    //    row keeps passing, and the parameter it describes is now normalised,
    //    so the reason written next to it is stale and misleading.
    //
    // The second is the one that matters after a migration, which is why an
    // exemption is checked for being still-PLAIN rather than merely present.
    const all = idShapedDeclarations();
    const orphans = [...EXEMPT_SITES].filter((site) => !all.some((d) => siteOf(d) === site));
    assert.deepEqual(
      orphans,
      [],
      'NOT_A_SPOTIFY_ENTITY_AT names a tool.parameter that no longer exists — delete the entry',
    );
    for (const site of EXEMPT_SITES) {
      const declaration = all.find((d) => siteOf(d) === site);
      assert.ok(declaration, `${site} is exempt but no longer declares an id-shaped parameter`);
      assert.ok(
        !isResolverBacked(declaration),
        `${site} is listed as an exemption but its parameter now goes through the resolver — delete the row`,
      );
    }
    const declaredNames = new Set(all.map((d) => d.name));
    const staleNames = [...EXEMPT_NAMES].filter((name) => !declaredNames.has(name));
    assert.deepEqual(
      staleNames,
      [],
      'NOT_A_SPOTIFY_ENTITY names parameters that are no longer id-shaped — delete the entry',
    );
  });

  it('every exemption carries the reason it is not a Spotify entity', () => {
    for (const [name, reason] of Object.entries(NOT_A_SPOTIFY_ENTITY)) {
      assert.ok(reason.length > 20, `${name} is exempt without a reason someone can check`);
    }
    for (const [site, reason] of Object.entries(NOT_A_SPOTIFY_ENTITY_AT)) {
      assert.ok(reason.length > 40, `${site} is exempt without a reason someone can check`);
    }
  });

  it('the resolver is only ever asked for a kind refs.ts knows', () => {
    // A typo'd kind would not throw at build time — `spotifyId('playlst')`
    // compiles — it would reject every reference at runtime, which reads as
    // "this tool is broken" rather than "this schema is wrong".
    for (const entry of readdirSync(TOOLS_DIR).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(TOOLS_DIR, entry), 'utf8');
      for (const match of source.matchAll(/spotifyId(?:Array)?(?:<[^>]*>)?\(\s*'([a-z]+)'\s*\)/g)) {
        assert.ok(
          REFERENCE_KINDS.has(match[1]!),
          `${entry}: spotifyId('${match[1]}') is not one of the kinds src/refs.ts resolves`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The wire-level half: what actually reaches the request path
// ---------------------------------------------------------------------------

const TRACK_ID = '4iV5W9uYEdYUVa79Axb7Rh';
const PLAYLIST_ID = '37i9dQZF1DWZeKCadgRdKQ';
const SHOW_ID = '4rOoJ6Egrf8K2IrywzwOMk';
const ARTIST_ID = '1Xyo4uUX8QYMxlN46wg0jX';
const AUDIOBOOK_ID = '2cT4LhTTyVbJucVTWiP8Kp';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function recordingHarness(): {
  invoke: (name: string, args: Record<string, unknown>) => Promise<void>;
  paths: string[];
} {
  const paths: string[] = [];
  const registered: Array<{ name: string; schema: z.ZodTypeAny; handler: Handler }> = [];
  const server = {
    tool(name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) {
      registered.push({ name, schema: z.object(schema), handler });
    },
    registerTool(name: string, config: { inputSchema?: z.ZodType }, handler: Handler) {
      registered.push({ name, schema: (config.inputSchema ?? z.object({})) as z.ZodTypeAny, handler });
    },
    server: { getClientCapabilities: () => ({ elicitation: { form: {} } }) },
  } as unknown as McpServer;

  const client = {
    async get<T>(path: string): Promise<T | null> {
      paths.push(path);
      return null as T;
    },
    // Every client read that can carry a path records it. Stubbing only `get`
    // would make a tool that walks pages (playlist_health_check) look like it
    // made no request at all, and the wire assertion would pass or fail for a
    // reason that has nothing to do with reference resolution.
    async getAllPages<T>(path: string): Promise<T[]> {
      paths.push(path);
      return [];
    },
    async getAllPagesWithTruncation<T>(path: string): Promise<{ items: T[]; truncated: boolean }> {
      paths.push(path);
      return { items: [], truncated: false };
    },
  } as unknown as SpotifyClient;

  registerPlaylistTools(server, client);
  registerCatalogTools(server, client);
  registerSwarm3ShowsTools(server, client);
  // The modules the migration newly covered. The issue named three tools that
  // were already resolver-backed by #1428, so pinning only those would leave
  // the 105 parameters this commit changed with no behavioural evidence at all.
  registerBrowseTools(server, client);
  registerAudiobookTools(server, client);
  registerSwarm3PlaylistopsTools(server, client);
  registerPlaylistHealthTools(server, client);

  return {
    paths,
    async invoke(name, args) {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `${name} should be registered`);
      // The 404 path is fine here: the assertion is on the path, not the result.
      // `ZodTypeAny.parse` returns `unknown`; the handler takes a record.
      // The 404 path is fine here, so the payload is never read - but the
      // argument is still the validated object, and saying so is cheaper
      // than a cast at the `parse` site.
      const parsed: unknown = tool.schema.parse(args);
      await tool.handler((parsed ?? {}) as Record<string, unknown>).catch(() => undefined);
    },
  };
}

describe('#914 a reference reaches the wire as a bare id', () => {
  it('get_track, get_playlist and list_show_episodes all resolve a URI and a share URL', async () => {
    // The wire probes from the issue, as a test. Each tool is given the same
    // entity in all four accepted forms and the path is asserted to contain
    // only the bare id — never `spotify%3A` or `open.spotify.com`.
    const cases: Array<{ tool: string; key: string; id: string; uri: string; url: string }> = [
      {
        tool: 'get_track',
        key: 'id',
        id: TRACK_ID,
        uri: `spotify:track:${TRACK_ID}`,
        url: `https://open.spotify.com/track/${TRACK_ID}`,
      },
      {
        tool: 'get_playlist',
        key: 'playlist_id',
        id: PLAYLIST_ID,
        uri: `spotify:playlist:${PLAYLIST_ID}`,
        url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      },
      {
        tool: 'list_show_episodes',
        key: 'show_id',
        id: SHOW_ID,
        uri: `spotify:show:${SHOW_ID}`,
        url: `https://open.spotify.com/show/${SHOW_ID}`,
      },
    ];

    for (const { tool, key, id, uri, url } of cases) {
      for (const [form, reference] of [['bare id', id], ['URI', uri], ['share URL', url]] as const) {
        const h = recordingHarness();
        await h.invoke(tool, { [key]: reference });
        const entity = h.paths.find((p) => !p.endsWith('/items') && p !== '/me/playlists');
        assert.ok(entity, `${tool} (${form}) made no request at all — the failure would look like a 404`);
        assert.ok(
          entity.includes(`/${id}`),
          `${tool} (${form}) put ${JSON.stringify(entity)} on the wire; expected it to contain /${id}`,
        );
        assert.ok(
          !entity.includes('spotify%3A') && !entity.includes('open.spotify.com'),
          `${tool} (${form}) sent the reference unnormalised: ${entity}`,
        );
      }
    }
  });

  it('a spotify:// link resolves too, not just the two forms above', async () => {
    const h = recordingHarness();
    await h.invoke('get_track', { id: `spotify://track/${TRACK_ID}` });
    const path = h.paths.find((p) => p.startsWith('/tracks/'));
    assert.ok(path?.includes(`/${TRACK_ID}`), `spotify:// link was not normalised: ${path}`);
  });

  it('the tools the migration newly covered send a bare id too', async () => {
    // The half of the acceptance criteria the issue could not previously check.
    // Before this commit `get_artist_genres`, `get_audiobook_chapters`,
    // `sort_playlist_plan` and `playlist_health_check` interpolated their
    // parameter straight into the path, so all four put
    // `spotify%3Aartist%3A…` on the wire and 404'd as if the entity were
    // missing. They are drawn from four different modules on purpose: a single
    // module would pass while the other 100 declarations stayed unfixed.
    const cases: Array<{ tool: string; key: string; kind: string; id: string; args?: Record<string, unknown> }> = [
      { tool: 'get_artist_genres', key: 'artist_id', kind: 'artist', id: ARTIST_ID },
      { tool: 'get_audiobook_chapters', key: 'id', kind: 'audiobook', id: AUDIOBOOK_ID },
      { tool: 'sort_playlist_plan', key: 'playlist_id', kind: 'playlist', id: PLAYLIST_ID },
      { tool: 'playlist_health_check', key: 'playlist_id', kind: 'playlist', id: PLAYLIST_ID },
    ];

    for (const { tool, key, kind, id, args } of cases) {
      for (const [form, reference] of [
        ['bare id', id],
        ['URI', `spotify:${kind}:${id}`],
        ['share URL', `https://open.spotify.com/${kind}/${id}`],
      ] as const) {
        const h = recordingHarness();
        await h.invoke(tool, { [key]: reference, ...args });
        // Pick the path that carries the reference rather than the first one
        // sent: a couple of these handlers resolve a market first (`GET /me`),
        // and asserting on `paths[0]` would test the probe and pass vacuously.
        const path = h.paths.find((p) => p !== '/me');
        assert.ok(path, `${tool} (${form}) made no entity request at all — the failure would look like a 404`);
        assert.ok(
          path.includes(`/${id}`),
          `${tool} (${form}) put ${JSON.stringify(path)} on the wire; expected it to contain /${id}`,
        );
        assert.ok(
          !path.includes('spotify%3A') && !path.includes('open.spotify.com'),
          `${tool} (${form}) sent the reference unnormalised: ${path}`,
        );
      }
    }
  });

  it('an id this server cannot classify is still passed through, not rejected', () => {
    // The half that makes the migration behaviour-preserving. `spotifyId`
    // (strict) would 400 on `pl1`; `spotifyRef` (tolerant) hands it to Spotify
    // exactly as the caller wrote it, so the failure stays the 404 it was
    // before this commit. Without this assertion the fix would be "reject
    // malformed ids", which is a different, release-visible change wearing the
    // same diff — and the fixtures across this suite use short fake ids
    // precisely because that is what these tools have always accepted.
    const schema = z.object({ playlist_id: spotifyRef(z.string().describe('p'), 'playlist') });
    assert.equal(schema.parse({ playlist_id: 'pl1' }).playlist_id, 'pl1');
    assert.equal(schema.parse({ playlist_id: 'My Playlist' }).playlist_id, 'My Playlist');
    // And the strict helper is untouched, so the modules that already used it
    // keep rejecting what they always rejected.
    assert.equal(spotifyId('playlist').safeParse('pl1').success, false);
    assert.equal(spotifyId('playlist').safeParse(PLAYLIST_ID).success, true);
  });

  it('a kind mismatch is left visible rather than silently reinterpreted', () => {
    // A `spotify:track:` handed to a playlist parameter must NOT become a bare
    // track id: that would turn "you named the wrong kind" into "that playlist
    // does not exist", which is the same class of defect this migration exists
    // to remove. It goes to Spotify as written and 404s on its own terms.
    const schema = z.object({ playlist_id: spotifyRef(z.string().describe('p'), 'playlist') });
    const trackUri = `spotify:track:${TRACK_ID}`;
    assert.equal(schema.parse({ playlist_id: trackUri }).playlist_id, trackUri);
  });
});
