/**
 * `taste_to_playlist` — the one writer in the taste composite family (#1009).
 *
 * Split out of taste_composites.ts so the manifest can give it its own row:
 * `readOnlySafe: false` and `scopeKey: 'playlists'`. The flag is per manifest
 * row, not per tool, so while this tool lived in the same registrar as ten
 * pure-read stats.fm tools the only way to keep it out of a read-only session
 * was to hide the whole family — and the alternative, flipping the shared
 * flag, would have hidden all ten reads instead. Neither is honest; one row
 * per safety class is.
 *
 * The shared stats.fm shaping helpers stay in taste_composites.ts (exported)
 * so both rows describe the same taste data the same way; the commit-path
 * helpers below are used by nothing else and moved with the tool.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
} from '../shaping.js';
import { capFor } from '../chunk.js';
import { normalizeStreams } from './statsfm_taste.js';
import { readOnlyModeEnabled } from './annotations.js';
import {
  DEAD_STATSFM_IDS,
  SPOTIFY_FALLBACK_GUIDANCE,
  statsfmGet,
  statsfmUserSchema,
  DryRunDefault,
  picksFromTopTracks,
  picksFromStreams,
  renderPicks,
  textOut,
  type TrackPick,
} from './taste_composites.js';

/**
 * Commit-path replacement for SPOTIFY_FALLBACK_GUIDANCE. By the time a
 * commit prints, every id-less pick has already been looked up, so the
 * preview's "search them by name" advice sends the caller back for tracks
 * the playlist just created already holds.
 *
 * It deliberately does not name `unresolved[]` / `search_errors[]` in prose:
 * the per-track lines carry their own explanations, and printing the bare
 * tokens here would leave them in the text of a run where both arrays are
 * empty — which reads as a report of misses that did not happen.
 */
const SPOTIFY_COMMIT_GUIDANCE =
  `${DEAD_STATSFM_IDS} Every id-less pick above was looked up before the playlist was created, so `
  + 'a row reported as not added either matched nothing or had its lookup fail — resolve those '
  + 'yourself, and do not re-search or re-add the rows that are in the playlist.';

/** A stats.fm external id that already carries a URI passes through; a bare id is wrapped. */
function spotifyTrackUri(raw: string): string {
  const id = raw.trim();
  return /^spotify:(track|local):/i.test(id) ? id : `spotify:track:${id}`;
}

/**
 * Outcome of one /search GET for a pick that carried no usable stats.fm id.
 * `uri` set → resolved. `error` set → the lookup itself failed, so whether
 * Spotify has the track is UNKNOWN and must never be reported as a miss.
 */
interface SearchOutcome {
  uri: string | null;
  error: string | null;
}

/**
 * A short description of a failed lookup. Only the status and Spotify's own
 * reason code are quoted — never `err.message`, which upstream error bodies
 * can fill with private ids and query values (same redaction rule as
 * lib/statsfm-client.ts).
 */
function searchFailureMessage(err: unknown): string {
  if (err instanceof SpotifyApiError) {
    return `search failed: HTTP ${err.status}${err.reason ? ` (${err.reason})` : ''}`;
  }
  return `search failed: ${err instanceof Error ? err.name : 'unknown error'}`;
}

/**
 * One /search GET for a pick that carried no usable stats.fm id.
 *
 * Only a 404 or an empty `tracks.items` means "search matched nothing" — a
 * real answer from Spotify's index. Every other outcome (401, 429, 403, 5xx,
 * transport) is a FAILED lookup, not a missing track, and is returned in
 * `error` so the caller can say so; folding it into `uri: null` would report
 * an expired token as a track that does not exist, and would print a "0
 * found" count for searches that never returned.
 */
async function searchTrackUri(client: SpotifyClient, pick: TrackPick): Promise<SearchOutcome> {
  type SearchHits = { tracks?: { items?: Array<{ uri?: string; id?: string }> } };
  let res: SearchHits | null;
  try {
    res = await client.get<SearchHits>('/search', { q: `${pick.artist} ${pick.title}`, type: 'track', limit: '1' });
  } catch (err) {
    // A 404 is Spotify saying "nothing here"; anything else is a failed call.
    if (err instanceof SpotifyApiError && err.status === 404) return { uri: null, error: null };
    return { uri: null, error: searchFailureMessage(err) };
  }
  const first = res?.tracks?.items?.[0];
  if (first?.uri) return { uri: first.uri, error: null };
  if (first?.id) return { uri: spotifyTrackUri(first.id), error: null };
  return { uri: null, error: null };
}
export function registerTastePlaylistTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'taste_to_playlist',
    'Taste profile → playlist: blend lifetime tops with recent streams into a track list. '
      + 'dry_run (default true) returns the plan and issues NO Spotify write; dry_run=false '
      + 'creates the playlist in your library and adds the tracks that resolve to a Spotify id '
      + '(unresolvable ones come back under unresolved[], never silently dropped). '
      + 'A failed lookup (401/429/5xx) surfaces as search_errors[], or blocked: search_failed. '
      + 'Quota: 2 stats.fm GETs when previewing; + up to track_count /search GETs, 1 create and '
      + 'chunked adds when committing.',
    {
      statsfm_user: statsfmUserSchema,
      track_count: z.number().int().min(1).max(50).optional().describe('Tracks to list. Default: 20'),
      seed: z.enum(['core', 'recent', 'mixed']).optional().describe('Blend seed. Default: mixed'),
      dry_run: DryRunDefault,
      playlist_name: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Name for the playlist created when dry_run=false. Default: "Taste: <user> (<seed>)"'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const seed = args.seed ?? 'mixed';
      const n = args.track_count ?? 20;
      const dryRun = args.dry_run ?? true;
      const [tracksRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, { range: 'lifetime', limit: String(Math.max(n, 20)) }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '200' }),
      ]);
      const core = picksFromTopTracks(tracksRaw, 'lifetime top');
      const recent = picksFromStreams(normalizeStreams(streamsRaw), 'recent stream');
      let blended: TrackPick[];
      if (seed === 'core') blended = core;
      else if (seed === 'recent') blended = recent;
      else {
        blended = [];
        const seen = new Set<string>();
        const push = (p: TrackPick): void => {
          const k = `${p.artist} — ${p.title}`.toLowerCase();
          if (seen.has(k)) return;
          seen.add(k);
          blended.push(p);
        };
        const max = Math.max(core.length, recent.length);
        for (let i = 0; i < max; i++) {
          if (i < core.length) push(core[i]);
          if (blended.length >= n) break;
          if (i < recent.length) push(recent[i]);
          if (blended.length >= n) break;
        }
      }
      const shaped = truncateItems(blended, resolveMaxResults(args.max_results, n));
      const { lines, missing } = renderPicks(shaped.items);
      if (blended.length === 0) {
        const empty = { topTracks: tracksRaw, recentStreams: streamsRaw, dryRun, picks: [] as TrackPick[], missing };
        if (args.response_format === 'json') {
          return { content: [{ type: 'text', text: JSON.stringify(empty) }], structuredContent: { ...empty } };
        }
        return textOut([`No taste data for "${u}" — check the stats.fm user ID.`], {
          user: u, seed, dryRun, picks: [], missing: [],
          pagination: paginationInfo({ total: 0, offset: 0, limit: null, returned: 0 }),
        });
      }

      // ---- preview: no Spotify client call is made anywhere on this path ----
      if (dryRun) {
        const out = [
          `DRY RUN — playlist spec for ${u} (seed ${seed}, ${shaped.items.length} tracks; no Spotify writes performed):`,
          ...lines,
          SPOTIFY_FALLBACK_GUIDANCE,
        ];
        if (missing.length > 0) out.push(`missing[]: ${missing.join(' · ')}`);
        if (shaped.footer) out.push(`(${shaped.footer})`);
        const preview = {
          ok: true, user: u, seed, dryRun,
          picks: shaped.items, missing,
          pagination: paginationInfo({ total: blended.length, offset: 0, limit: null, returned: blended.length }),
        };
        if (args.response_format === 'json') {
          const raw = { ...preview, topTracks: tracksRaw, recentStreams: streamsRaw };
          return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
        }
        return textOut(out, preview);
      }

      // ---- commit: dry_run=false means the write actually happens ----
      if (readOnlyModeEnabled()) {
        return textOut(
          ['Refused to write: SPOTIFY_MCP_READONLY mode is active, so nothing was created. '
            + 'Re-run with dry_run=true for the plan, or drop read-only mode to commit.'],
          { ok: false, user: u, seed, dryRun, blocked: 'read_only_mode' },
        );
      }
      const defaultName = `Taste: ${u} (${seed})`;
      // Spotify caps names at 100 chars; a long stats.fm user id must not blow the request.
      const name = ((args.playlist_name ?? defaultName).trim() || defaultName).slice(0, 100);
      const uris: string[] = [];
      // unresolved[] = Spotify searched and matched nothing. searchErrors[] =
      // the lookup itself failed, so the track's existence on Spotify is unknown.
      const unresolved: string[] = [];
      const searchErrors: string[] = [];
      let searches = 0;
      // Commit rows are rendered from the outcome, not from the pre-search pick
      // shape renderPicks sees: a `[search: search_tracks "…"]` row on a track
      // that is already in the playlist just created is an instruction to
      // re-add what was added.
      const pickedLines: string[] = [];
      for (const [i, p] of shaped.items.entries()) {
        const label = `${i + 1}. ${p.artist} — ${p.title}`;
        if (p.spotifyId) {
          uris.push(spotifyTrackUri(p.spotifyId));
          pickedLines.push(`${label} [${p.spotifyId}]`);
          continue;
        }
        searches++;
        const outcome = await searchTrackUri(client, p);
        if (outcome.error) {
          searchErrors.push(`${p.artist} — ${p.title} [${outcome.error}]`);
          pickedLines.push(`${label} [lookup FAILED — existence unknown]`);
        } else if (outcome.uri) {
          uris.push(outcome.uri);
          pickedLines.push(`${label} [${outcome.uri}]`);
        } else {
          unresolved.push(`${p.artist} — ${p.title}`);
          pickedLines.push(`${label} [search matched nothing — NOT added]`);
        }
      }
      // Past this point every id-less pick has been looked up, so the preview's
      // `missing` (no stats.fm id) is stale: a pick /search then resolved is
      // now IN the playlist, and calling it missing sends the caller to
      // re-add what was just added. `notAdded` is the real remainder.
      // Reaching a blocked branch means uris is empty, which can only happen
      // when no pick carried an id, so notAdded still names every pick.
      const notAdded = [...unresolved, ...searchErrors];
      if (uris.length === 0 && searchErrors.length > 0) {
        // Not every search errored: `searches` also counts the lookups that ran
        // and came back empty, and those are in unresolved[]. Reporting
        // `searches` here would tell the caller a track that Spotify actually
        // searched for and found nothing had also failed.
        const failed = searchErrors.length === searches
          ? `all ${searches} track search${searches === 1 ? '' : 'es'} failed`
          : `${searchErrors.length} of ${searches} track searches failed`;
        const blockedLines = [
          `Nothing written: ${failed}, so no pick could be looked up on Spotify `
            + 'and no playlist was created. That is a Spotify auth/quota/transport '
            + 'failure, not a statement about the tracks.',
        ];
        if (unresolved.length > 0) {
          blockedLines.push(`unresolved[] (search ran, matched nothing — not a failure): ${unresolved.join(' · ')}`);
        }
        return textOut(blockedLines, {
          ok: false, user: u, seed, dryRun, blocked: 'search_failed',
          search_errors: searchErrors, unresolved, picks: shaped.items, missing: notAdded,
        });
      }
      if (uris.length === 0) {
        return textOut(
          [`Nothing written: none of the ${shaped.items.length} picks resolved to a Spotify id `
            + `(${searches} searched, 0 found), so no playlist was created.`],
          {
            ok: false, user: u, seed, dryRun, blocked: 'no_resolvable_tracks',
            search_errors: searchErrors, unresolved, picks: shaped.items, missing: notAdded,
          },
        );
      }
      const created = await client.post<{ id?: string; external_urls?: { spotify?: string } }>('/me/playlists', {
        name,
        public: false,
        description: `stats.fm taste blend for ${u} (seed ${seed})`,
      });
      const playlistId = created?.id;
      if (!playlistId) {
        return textOut(
          [`Nothing written: Spotify accepted the create request for "${name}" but returned no playlist id, `
            + 'so no items were added.'],
          { ok: false, user: u, seed, dryRun, blocked: 'create_returned_no_id', picks: shaped.items },
        );
      }
      let adds = 0;
      let snapshotId: string | undefined;
      const writeCap = capFor('playlist_writes');
      for (let start = 0; start < uris.length; start += writeCap) {
        const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
        const chunk = uris.slice(start, start + writeCap);
        const res = start === 0
          ? await client.put<{ snapshot_id?: string }>(path, { uris: chunk })
          : await client.post<{ snapshot_id?: string }>(path, { uris: chunk });
        if (res?.snapshot_id) snapshotId = res.snapshot_id;
        adds++;
      }
      const url = created.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlistId}`;
      const committed = {
        ok: true, user: u, seed, dryRun,
        playlist: {
          id: playlistId, name, url,
          added: uris.length, requested: shaped.items.length, snapshot_id: snapshotId,
        },
        unresolved,
        search_errors: searchErrors,
        requests: { searches, create: 1, adds },
        picks: shaped.items, missing: notAdded,
        pagination: paginationInfo({ total: blended.length, offset: 0, limit: null, returned: blended.length }),
      };
      const out = [
        `COMMITTED — dry_run=false: created playlist "${name}" (${url}) with ${uris.length} of `
          + `${shaped.items.length} tracks.`
          + (searchErrors.length > 0
            ? ` PARTIAL: ${searchErrors.length} lookup${searchErrors.length === 1 ? '' : 's'} FAILED — `
              + 'those tracks may well exist; see search_errors[].'
            : ''),
        ...pickedLines,
        SPOTIFY_COMMIT_GUIDANCE,
      ];
      if (unresolved.length > 0) {
        out.push(`unresolved[] (no Spotify id, search matched nothing — not added): ${unresolved.join(' · ')}`);
      }
      if (searchErrors.length > 0) {
        out.push(`search_errors[] (lookup FAILED — existence unknown, not added): ${searchErrors.join(' · ')}`);
      }
      out.push(`requests: ${searches} search + 1 create + ${adds} add.`);
      if (shaped.footer) out.push(`(${shaped.footer})`);
      if (args.response_format === 'json') {
        const raw = { ...committed, topTracks: tracksRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      return textOut(out, committed);
    },
  );
}
