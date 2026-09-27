/**
 * One duplicate and artist matching vocabulary across the playlist tools (#885).
 *
 * Regression: the five duplicate tools and the four artist tools each carried
 * their own rule. `playlist_health_check` grouped on URI alone,
 * `find_duplicates_in_playlist` counted an exact-URI group and a relinked
 * group as two separate groups, `playlist_dedupe_advanced` had its own
 * `match_by: uri|name` enum keyed on bare name, and `remove_duplicate_playlist_items`
 * and `clean_all_playlists` flipped an `include_relinked` boolean that
 * combined both. Artist-side, `playlist_artist_heat` credited only
 * `artists[0]` while the exclusion and removal tools matched any credit, and
 * `playlist_exclude_artists` compared the caller's reference against
 * `artist.id` only — so a NAME matched nothing and the tool reported a
 * confident "nothing to remove".
 *
 * The parity test below is the acceptance criterion: for one fixture and one
 * `match_by`, every duplicate tool reports the same group count, and every
 * artist tool agrees on the track count for the same `include_featured`.
 *
 * Run: npx tsx --test tests/playlistmatch.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { PlaylistItemObject } from '../src/types/spotify.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';

// ---------------------------------------------------------------------------
// The fixture the issue asks for: a URI repeat, a relink, and a featured credit
// ---------------------------------------------------------------------------

const A_ID = 'aaaaaaaaaaaaaaaaaaaaaa';
const B_ID = 'bbbbbbbbbbbbbbbbbbbbbb';
const C_ID = 'cccccccccccccccccccccc';
const D_ID = 'dddddddddddddddddddddd';
const E_ID = 'eeeeeeeeeeeeeeeeeeeeee';
const F_ID = 'ffffffffffffffffffffff';
const PLAYLIST_ID = 'pl885fixture';
const ARTIST_ID = '1111111111111111111111';
const FEATURE_ID = '2222222222222222222222';
const ALPHA_ID = '3333333333333333333333';
const BETA_ID = '4444444444444444444444';

interface FixtureItem {
  id: string;
  name: string;
  artistIds: string[];
  artistNames: string[];
}

const FIXTURE: FixtureItem[] = [
  // A repeated exactly — same URI twice. One `uri` group.
  { id: A_ID, name: 'Repeated', artistIds: [ARTIST_ID], artistNames: ['Repeated Artist'] },
  { id: A_ID, name: 'Repeated', artistIds: [ARTIST_ID], artistNames: ['Repeated Artist'] },
  // A relink of the same song: same name and artist, different URI. The third
  // member of the name_artist group, invisible to the uri rule.
  { id: B_ID, name: 'Repeated', artistIds: [ARTIST_ID], artistNames: ['Repeated Artist'] },
  // The discriminating row: 'Guest Star' is PRIMARY here and 'Repeated Artist'
  // is only FEATURED. A primary-artist-only rule cannot see 'Repeated Artist'
  // on this track, which is what separates the two include_featured values.
  { id: C_ID, name: 'Feature', artistIds: [FEATURE_ID, ARTIST_ID], artistNames: ['Guest Star', 'Repeated Artist'] },
  // A different song by the guest artist.
  { id: D_ID, name: 'Guest solo', artistIds: [FEATURE_ID], artistNames: ['Guest Star'] },
  // Two DIFFERENT songs that happen to share a title. Only the widest `name`
  // rule collapses them; `name_artist` must not, and a tool that groups on
  // bare name alone reports a duplicate here that does not exist.
  { id: E_ID, name: 'Cover', artistIds: [ALPHA_ID], artistNames: ['Alpha'] },
  { id: F_ID, name: 'Cover', artistIds: [BETA_ID], artistNames: ['Beta'] },
];

function playlistItems(): PlaylistItemObject[] {
  return FIXTURE.map((entry) => ({
    added_at: '2026-01-01T00:00:00Z',
    item: {
      type: 'track',
      uri: `spotify:track:${entry.id}`,
      id: entry.id,
      name: entry.name,
      duration_ms: 200_000,
      artists: entry.artistNames.map((name, index) => ({ id: entry.artistIds[index]!, name })),
    },
  } as unknown as PlaylistItemObject));
}

// ---------------------------------------------------------------------------
// Harness: one stub playlist served to every tool
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

interface Registered {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: Handler;
}

function makeClient(): SpotifyClient {
  const items = playlistItems();
  // The one playlist the fixture lives in, as `/me/playlists` reports it. A
  // stub that returned the item rows for that path would make clean_all scan
  // zero playlists and report a clean account, which is the shape of a silent
  // no-op this whole change exists to remove.
  const playlistList = [{ id: PLAYLIST_ID, name: 'Fixture', owner: { display_name: 'Jack' } }];
  const rowsFor = (path: string) => (path === '/me/playlists' ? playlistList : items);
  return {
    async get<T>(path: string): Promise<T | null> {
      if (path.startsWith('/playlists/') && path.endsWith('/items')) return null as T;
      if (path.includes('/items')) return null as T;
      if (path.includes('/tracks')) return [] as unknown as T;
      return { id: PLAYLIST_ID, name: 'Fixture', items } as unknown as T;
    },
    async getAllPages<T>(path?: string): Promise<T[]> {
      return structuredClone(rowsFor(path ?? '')) as T[];
    },
    async getAllPagesWithTruncation<T>(path?: string): Promise<{ items: T[]; truncated: boolean }> {
      return { items: structuredClone(rowsFor(path ?? '')) as T[], truncated: false };
    },
    async put<T>(): Promise<T | null> {
      return { snapshot_id: 'snap' } as T;
    },
    async delete<T>(): Promise<T | null> {
      return { snapshot_id: 'snap' } as T;
    },
  } as unknown as SpotifyClient;
}

function harness(): { invoke: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>> } {
  const registered: Registered[] = [];
  const server = {
    tool(
      name: string,
      _description: string,
      schema: Record<string, z.ZodTypeAny>,
      annotationsOrHandler: unknown,
      maybeHandler?: Handler,
    ) {
      const handler = (typeof annotationsOrHandler === 'function' ? annotationsOrHandler : maybeHandler) as Handler;
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
    registerTool(name: string, config: { inputSchema?: z.ZodType }, handler: Handler) {
      registered.push({ name, validate: (args) => (config.inputSchema as z.ZodType).parse(args), handler });
    },
    async elicitInput() {
      return { action: 'accept', content: { confirm: true } };
    },
    server: { getClientCapabilities: () => ({ elicitation: { form: {} } }) },
  } as unknown as McpServer;

  const client = makeClient();
  registerPlaylistTools(server, client);
  registerPlaylistHealthTools(server, client);
  registerSwarm4PlaylistsTools(server, client);
  registerExhaust2PlaylistsTools(server, client);

  return {
    async invoke(name, args = {}) {
      const tool = registered.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} should be registered`);
      const result = await tool.handler(tool.validate(args));
      return result.structuredContent ?? {};
    },
  };
}

// ---------------------------------------------------------------------------
// Expected counts, derived by hand from the fixture
// ---------------------------------------------------------------------------
//
// Positions:      0:A  1:A  2:B(relink of A)  3:C  4:D  5:E  6:F
// match_by=uri         -> {A}                  -> 1 group
// match_by=name_artist -> {A,A,B}              -> 1 group
// match_by=name        -> {A,A,B}  {E,F}       -> 2 groups
//
// The counts are all different, so a tool that ignores `match_by` and keeps its
// own private rule cannot accidentally agree: pre-#885, `playlist_health_check`
// reported 1/1/1 (it had no rule), `playlist_dedupe_advanced` reported 1/?/2
// (bare-name key), and `find_duplicates_in_playlist` counted the relink
// separately from the exact repeat.
const DUPLICATE_GROUPS: Record<string, number> = { uri: 1, name_artist: 1, name: 2 };

describe('#885 every duplicate tool groups under the same rule', () => {
  const h = harness();

  it('playlist_health_check, find_duplicates_in_playlist, playlist_dedupe_advanced, '
    + 'remove_duplicate_playlist_items and clean_all_playlists agree for every match_by', async () => {
    for (const [matchBy, expected] of Object.entries(DUPLICATE_GROUPS)) {
      const health = await h.invoke('playlist_health_check', { playlist_id: PLAYLIST_ID, match_by: matchBy });
      assert.equal(health.match_by, matchBy, `health echoed the wrong rule for ${matchBy}`);
      assert.equal(
        (health.issues as Array<{ type: string; count: number }>).find((i) => i.type === 'duplicate')?.count,
        expected,
        `playlist_health_check group count under ${matchBy}`,
      );

      const found = await h.invoke('find_duplicates_in_playlist', { playlist_id: PLAYLIST_ID, match_by: matchBy, response_format: 'json' });
      assert.equal(found.match_by, matchBy, `find_duplicates echoed the wrong rule for ${matchBy}`);
      assert.equal((found.items as unknown[]).length, expected, `find_duplicates_in_playlist group count under ${matchBy}`);

      const dedupe = await h.invoke('playlist_dedupe_advanced', { playlist_id: PLAYLIST_ID, match_by: matchBy, dry_run: true });
      assert.equal(dedupe.duplicate_groups, expected, `playlist_dedupe_advanced group count under ${matchBy}`);

      const removed = await h.invoke('remove_duplicate_playlist_items', { playlist_id: PLAYLIST_ID, match_by: matchBy, dry_run: true });
      assert.equal(removed.duplicate_groups, expected, `remove_duplicate_playlist_items group count under ${matchBy}`);

      const clean = await h.invoke('clean_all_playlists', { match_by: matchBy, dry_run: true });
      // Report mode lists the dirty playlists under `items` (listStructuredContent),
      // and only falls back to a flat `results` when the account scanned clean —
      // so read whichever the tool returned rather than assuming one shape.
      const rows = (clean.items ?? clean.results) as Array<{ duplicate_groups: number }>;
      assert.equal(clean.match_by, matchBy, `clean_all echoed the wrong rule for ${matchBy}`);
      assert.equal(rows[0]?.duplicate_groups, expected, `clean_all_playlists group count under ${matchBy}`);
    }
  });

  it('the fixture really does contain duplicates, so a zero would mean a matcher that matched nothing', async () => {
    const found = await h.invoke('find_duplicates_in_playlist', {
      playlist_id: PLAYLIST_ID,
      match_by: 'uri',
      response_format: 'json',
    });
    assert.equal((found.items as unknown[]).length > 0, true);
  });

  it('match_by is required to be one of the three published rules, on every tool', async () => {
    for (const name of [
      'playlist_health_check',
      'find_duplicates_in_playlist',
      'playlist_dedupe_advanced',
      'remove_duplicate_playlist_items',
      'clean_all_playlists',
    ]) {
      await assert.rejects(
        () => h.invoke(name, { playlist_id: PLAYLIST_ID, match_by: 'album_name' } as never),
        /match_by/,
        `${name} should reject an unpublished rule by name`,
      );
    }
  });
});

describe('#885 every artist tool agrees on the track count', () => {
  const h = harness();

  it('include_featured=true counts the featured credit; false does not', async () => {
    // "Repeated Artist" is credited on rows 0, 1, 2 (repeat + relink) and
    // only FEATURED on row 3. "Guest Star" is primary on rows 3 and 4.
    for (const includeFeatured of [true, false]) {
      const heat = await h.invoke('playlist_artist_heat', {
        playlist_id: PLAYLIST_ID,
        include_featured: includeFeatured,
        response_format: 'json',
      });
      const top = (heat.top_artists as Array<{ name: string; tracks: number }>);
      assert.equal(
        top.find((a) => a.name === 'Repeated Artist')?.tracks,
        includeFeatured ? 4 : 3,
        `heat count for Repeated Artist, include_featured=${includeFeatured}`,
      );
      // "Guest Star" is primary on both of its rows, so the primary-only rule
      // sees the same two — which is why the row above, not this one, has to
      // carry the discriminating weight.
      assert.equal(top.find((a) => a.name === 'Guest Star')?.tracks, 2, 'heat count for Guest Star');
      assert.equal(heat.include_featured, includeFeatured, 'heat echoed the wrong rule');
    }
  });

  it('playlist_remove_artist and playlist_exclude_artists remove the same tracks the heat map counted', async () => {
    for (const includeFeatured of [true, false]) {
      const heat = await h.invoke('playlist_artist_heat', {
        playlist_id: PLAYLIST_ID,
        include_featured: includeFeatured,
        response_format: 'json',
      });
      const heatCount = (heat.top_artists as Array<{ name: string; tracks: number }>)
        .find((a) => a.name === 'Repeated Artist')?.tracks;

      // A bare 22-character id, the form most callers actually paste. Before
      // #885 the shared resolver was only consulted for `spotify:artist:` and
      // URL forms, so a bare id fell through to the name branch, matched no
      // credit, and reported a confident zero.
      const removed = await h.invoke('playlist_remove_artist', {
        playlist_id: PLAYLIST_ID,
        artist: ARTIST_ID,
        include_featured: includeFeatured,
        dry_run: true,
      });
      assert.equal(removed.artist_matched_by, 'id', 'a bare id must resolve through the reference policy');
      assert.equal(removed.removed_count, heatCount, `remove_artist disagreed with heat at include_featured=${includeFeatured}`);

      const excluded = await h.invoke('playlist_exclude_artists', {
        playlist_id: PLAYLIST_ID,
        artist_ids: [ARTIST_ID],
        include_featured: includeFeatured,
        dry_run: true,
      });
      assert.equal(excluded.removals, heatCount, `exclude_artists disagreed with heat at include_featured=${includeFeatured}`);
    }
  });

  it('an artist NAME matches, where the id-only comparison matched nothing (#885)', async () => {
    // The defect: playlist_exclude_artists compared the normalised reference
    // against `artist.id` only, so 'Repeated Artist' never equalled an id and
    // the tool reported zero removals — a confident answer built on a
    // comparison that could not have matched. Under the shared rule the name
    // matches all four of its credits, the same four playlist_artist_heat
    // counts with include_featured=true.
    const byName = await h.invoke('playlist_exclude_artists', {
      playlist_id: PLAYLIST_ID,
      artist_ids: ['Repeated Artist'],
      dry_run: true,
    });
    assert.equal(byName.removals, 4, 'a plain artist name must match credited artist names');
    assert.deepEqual(byName.unmatched_artists, [], 'the name reference matched, so it is not unmatched');

    const removedByName = await h.invoke('playlist_remove_artist', {
      playlist_id: PLAYLIST_ID,
      artist: 'Repeated Artist',
      dry_run: true,
    });
    assert.equal(removedByName.artist_matched_by, 'name', 'a plain name must not be resolved as an id');
    assert.equal(removedByName.removed_count, 4, 'playlist_remove_artist must match a plain name too');
  });

  it('a reference that matches nothing says so, instead of reporting a clean playlist', async () => {
    const result = await h.invoke('playlist_exclude_artists', {
      playlist_id: PLAYLIST_ID,
      artist_ids: ['Repeated Artist', 'Nobody At All'],
      dry_run: true,
    });
    // The keys are the normalised references the caller sent, so a name
    // reference is echoed as its normalised name and an id reference as its id.
    // What matters is that the two lists partition the input, so a caller can
    // always tell "this artist has no track here" from "this reference matched
    // but was deduped away".
    assert.deepEqual(result.unmatched_artists, ['nobody at all'], 'the unmatched reference must be named, not folded into a zero');
    assert.deepEqual(result.matched_artists, ['repeated artist'], 'the matched reference must be attributed');
  });

  it('playlist_keep_only and playlist_move_to_top select the same rows the heat map counted', async () => {
    const heat = await h.invoke('playlist_artist_heat', {
      playlist_id: PLAYLIST_ID,
      include_featured: true,
      response_format: 'json',
    });
    const heatCount = (heat.top_artists as Array<{ name: string; tracks: number }>)
      .find((a) => a.name === 'Repeated Artist')?.tracks;
    assert.equal(heatCount, 4);

    const kept = await h.invoke('playlist_keep_only', {
      playlist_id: PLAYLIST_ID,
      keep_by: 'artist',
      artist: 'Repeated Artist',
      include_featured: true,
      dry_run: true,
    });
    assert.equal(kept.kept_count, heatCount, 'keep_only must select exactly the rows heat counted');

    const moved = await h.invoke('playlist_move_to_top', {
      playlist_id: PLAYLIST_ID,
      artist: 'Repeated Artist',
      include_featured: true,
      dry_run: true,
    });
    assert.equal(moved.matched ?? moved.moved, heatCount, 'move_to_top must select the same rows');
  });
});

describe('#885 the retired include_relinked alias', () => {
  const h = harness();

  it('still maps true/false onto the published rules, on both tools that had it', async () => {
    for (const name of ['remove_duplicate_playlist_items', 'clean_all_playlists']) {
      const legacyTrue = await h.invoke(name, { playlist_id: PLAYLIST_ID, include_relinked: true, dry_run: true });
      assert.equal(legacyTrue.match_by, 'name_artist', `${name}: true meant URI-or-relink`);
      assert.deepEqual(legacyTrue.deprecated_inputs, ['include_relinked'], `${name}: the legacy input must be reported`);
      assert.match(legacyTrue.deprecation_note as string, /match_by=name_artist/, `${name}: the note must name the replacement`);

      const legacyFalse = await h.invoke(name, { playlist_id: PLAYLIST_ID, include_relinked: false, dry_run: true });
      assert.equal(legacyFalse.match_by, 'uri', `${name}: false meant URI only`);
      assert.deepEqual(legacyFalse.deprecated_inputs, ['include_relinked'], `${name}: the legacy input must be reported`);
    }
  });

  it('refuses a disagreement by naming both sides rather than silently picking one', async () => {
    // Before the resolver this was undecidable rather than refused: the shared
    // `match_by` carried a zod `.default('uri')`, so zod always populated the
    // field and every legacy call looked like a disagreement. Dropping the
    // schema default is what makes "the caller said nothing" and "the caller
    // said uri" distinguishable again.
    await assert.rejects(
      () => h.invoke('remove_duplicate_playlist_items', {
        playlist_id: PLAYLIST_ID,
        include_relinked: true,
        match_by: 'uri',
        dry_run: true,
      }),
      /match_by[\s\S]*include_relinked/,
      'a conflicting pair must fail by name',
    );
  });

  it('accepts a redundant pair that agrees, and a canonical call carries no deprecation', async () => {
    const agreed = await h.invoke('remove_duplicate_playlist_items', {
      playlist_id: PLAYLIST_ID,
      include_relinked: false,
      match_by: 'uri',
      dry_run: true,
    });
    assert.equal(agreed.match_by, 'uri');
    assert.deepEqual(agreed.deprecated_inputs, ['include_relinked'], 'the legacy input was still used and must be reported');

    const canonical = await h.invoke('remove_duplicate_playlist_items', {
      playlist_id: PLAYLIST_ID,
      match_by: 'uri',
      dry_run: true,
    });
    assert.equal(canonical.deprecated_inputs, undefined, 'a canonical call must not claim a deprecation');
    assert.equal(canonical.deprecation_note, undefined, 'a canonical call must not carry a note');
  });

  it('and a caller that omits both gets the one published default, not a per-tool guess', async () => {
    for (const name of [
      'playlist_health_check',
      'find_duplicates_in_playlist',
      'playlist_dedupe_advanced',
      'remove_duplicate_playlist_items',
      'clean_all_playlists',
    ]) {
      const result = await h.invoke(name, { playlist_id: PLAYLIST_ID, dry_run: true });
      assert.equal(result.match_by, 'uri', `${name} invented its own default`);
    }
  });
});
