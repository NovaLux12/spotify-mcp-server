/**
 * Wave-2 taste composites: 11 read-only composite tools over the stats.fm
 * PUBLIC API v1 (no auth), shaping taste data into playlist specs, briefs,
 * and reports. No Spotify writes — playlist-shaped output is a
 * copy-pasteable track list plus a DRY_RUN receipt.
 *
 * Spec: docs/wave2-composites.md
 *
 * Local minimal fetch shim lives inside this module on purpose — do NOT
 * depend on sibling-branch client files. Tests inject fixtures via
 * __setTasteCompositeFetchImpl. Pure shaping reuses the lenient
 * normalizers exported from statsfm_taste.ts.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  MaxResults,
  resolveMaxResults,
  truncateItems,
  paginationInfo,
  listStructuredContent,
} from '../shaping.js';
import {
  normalizeStreams,
  normalizeTopList,
  groupSessions,
  summarizeMonths,
  detectEras,
  summarizeDayParting,
  classifyExposure,
  type TasteStream,
} from './statsfm_taste.js';

// ---------------------------------------------------------------------------
// Local minimal stats.fm fetch shim (own seam; does not share fetchImpl
// with statsfm_taste.ts on purpose so fixtures stay hermetic per module)
// ---------------------------------------------------------------------------

export const TASTE_COMPOSITE_API_BASE = 'https://api.stats.fm/api/v1';

export type TasteCompositeFetchImpl = (url: string) => Promise<unknown>;

async function defaultFetchImpl(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'spotify-mcp/taste-composites',
    },
  });
  if (!res.ok) throw new Error(`stats.fm API HTTP ${res.status} for ${url}`);
  return res.json() as Promise<unknown>;
}

let fetchImpl: TasteCompositeFetchImpl = defaultFetchImpl;

/** Test seam: inject fixture-backed fetch. */
export function __setTasteCompositeFetchImpl(impl: TasteCompositeFetchImpl): void {
  fetchImpl = impl;
}

/** Test seam: restore the live fetch shim. */
export function __resetTasteCompositeFetchImpl(): void {
  fetchImpl = defaultFetchImpl;
}

async function statsfmGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const qs =
    params && Object.keys(params).length > 0
      ? `?${new URLSearchParams(params).toString()}`
      : '';
  return (await fetchImpl(`${TASTE_COMPOSITE_API_BASE}${path}${qs}`)) as T;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const statsfmUserSchema = z
  .string()
  .min(1)
  .describe('stats.fm user ID (or username) — public profile, no auth needed');

const rangeSchema = z
  .enum(['lifetime', 'month', 'week'])
  .optional()
  .describe('stats.fm range window. Default: lifetime');

interface RawItem {
  [k: string]: unknown;
}

function asItems(payload: unknown): RawItem[] {
  if (Array.isArray(payload)) return payload as RawItem[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as RawItem[];
    if (Array.isArray(obj.data)) return obj.data as RawItem[];
  }
  return [];
}

/** Best-effort Spotify id extraction (externalIds.spotify[] are often dead). */
function spotifyIdOf(raw: RawItem): string | null {
  const ext = raw.externalIds as Record<string, unknown> | undefined;
  const fromExt = ext?.spotify;
  if (typeof fromExt === 'string' && fromExt.length > 0) return fromExt;
  if (Array.isArray(fromExt) && typeof fromExt[0] === 'string') return fromExt[0] as string;
  for (const k of ['spotifyId', 'spotify_id', 'spotifyUri', 'uri']) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

interface TrackPick {
  artist: string;
  title: string;
  spotifyId: string | null;
  evidence: string;
}

function trackNameOf(raw: RawItem): string {
  if (typeof raw.name === 'string' && raw.name.length > 0) return raw.name;
  const t = raw.track as RawItem | undefined;
  if (t && typeof t.name === 'string' && t.name.length > 0) return t.name as string;
  return 'unknown track';
}

function artistOf(raw: RawItem): string {
  const t = (raw.track as RawItem | undefined) ?? raw;
  const list = t.artists;
  if (Array.isArray(list)) {
    const names = (list as RawItem[])
      .map((a) => (typeof a === 'string' ? a : typeof a.name === 'string' ? (a.name as string) : ''))
      .filter((n) => n.length > 0);
    if (names.length > 0) return names.join(', ');
  }
  for (const k of ['artistName', 'artist']) {
    const v = t[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return 'unknown artist';
}

/** Build TrackPicks from a raw top-tracks payload (preserves Spotify ids). */
function picksFromTopTracks(payload: unknown, evidence: string): TrackPick[] {
  return asItems(payload).map((raw) => ({
    artist: artistOf(raw),
    title: trackNameOf(raw),
    spotifyId: spotifyIdOf(raw),
    evidence,
  }));
}

/** Build TrackPicks from normalized recent streams. */
function picksFromStreams(streams: TasteStream[], evidence: string): TrackPick[] {
  const seen = new Set<string>();
  const out: TrackPick[] = [];
  for (const s of streams) {
    const key = `${s.artistNames.join(', ')} — ${s.trackName}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      artist: s.artistNames.join(', ') || 'unknown artist',
      title: s.trackName,
      spotifyId: null,
      evidence,
    });
  }
  return out;
}

export const SPOTIFY_FALLBACK_GUIDANCE =
  'stats.fm externalIds.spotify[] are often dead (~12%) — if a URI 404s, run search_tracks "Artist - Title" and take the top result. Rows under missing[] had no Spotify id at all: search them by name.';

function renderPicks(picks: TrackPick[]): { lines: string[]; missing: string[] } {
  const lines: string[] = [];
  const missing: string[] = [];
  picks.forEach((p, i) => {
    const label = `${i + 1}. ${p.artist} — ${p.title}`;
    if (p.spotifyId) lines.push(`${label} [${p.spotifyId}]`);
    else {
      lines.push(`${label} [search: search_tracks "${p.artist} - ${p.title}"]`);
      missing.push(`${p.artist} — ${p.title}`);
    }
  });
  return { lines, missing };
}

interface ToolOut {
  [k: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function textOut(lines: string[], structured?: Record<string, unknown>): ToolOut {
  const out: ToolOut = { content: [{ type: 'text', text: lines.join('\n') }] };
  if (structured) out.structuredContent = structured;
  return out;
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Registration — 11 composite tools, all taste_ prefixed, all read-only
// ---------------------------------------------------------------------------

export function registerTasteCompositeTools(server: McpServer, _client: SpotifyClient): void {
  void _client; // stats.fm public API needs no Spotify client; kept for index.ts uniformity

  // ---- 1. taste_to_playlist ----
  server.tool(
    'taste_to_playlist',
    'Taste profile → playlist track list (DRY RUN first): blend lifetime tops with recent streams into a copy-pasteable track list. Read-only — never writes to Spotify.',
    {
      statsfm_user: statsfmUserSchema,
      track_count: z.number().int().min(1).max(50).optional().describe('Tracks to list. Default: 20'),
      seed: z.enum(['core', 'recent', 'mixed']).optional().describe('Blend seed. Default: mixed'),
      dry_run: z.boolean().optional().describe('Preview only (default true). False still only returns the list — writes happen via Spotify tools.'),
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
      if (args.response_format === 'json') {
        const raw = { topTracks: tracksRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
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
      const header = dryRun
        ? `DRY RUN — playlist spec for ${u} (seed ${seed}, ${shaped.items.length} tracks; no Spotify writes performed):`
        : `Playlist spec for ${u} (seed ${seed}, ${shaped.items.length} tracks; create via Spotify create_playlist + add_to_playlist):`;
      const out = [header, ...lines, SPOTIFY_FALLBACK_GUIDANCE];
      if (missing.length > 0) out.push(`missing[]: ${missing.join(' · ')}`);
      if (shaped.footer) out.push(`(${shaped.footer})`);
      if (blended.length === 0) return textOut([`No taste data for "${u}" — check the stats.fm user ID.`]);
      return textOut(out, {
        user: u, seed, dryRun, picks: shaped.items, missing,
        pagination: paginationInfo({ total: blended.length, offset: 0, limit: null, returned: blended.length }),
      });
    },
  );

  // ---- 2. taste_daily_brief ----
  server.tool(
    'taste_daily_brief',
    'Yesterday (or a given date) in brief: top-3 tracks, 2 revival picks, novelty share vs the lifetime core. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('UTC date YYYY-MM-DD. Default: yesterday'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const u = args.statsfm_user;
      const day = args.date ?? ymd(Date.now() - 86_400_000);
      const [artistsRaw, tracksRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, { range: 'lifetime', limit: '20' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, { range: 'lifetime', limit: '50' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topArtists: artistsRaw, topTracks: tracksRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const streams = normalizeStreams(streamsRaw);
      const dayStreams = streams.filter((s) => ymd(s.playedAtMs) === day);
      const core = new Set(normalizeTopList(artistsRaw).slice(0, 20).map((a) => a.name.toLowerCase()));
      const counts = new Map<string, { label: string; n: number }>();
      for (const s of dayStreams) {
        const label = `${s.artistNames.join(', ') || 'unknown artist'} — ${s.trackName}`;
        const e = counts.get(label.toLowerCase()) ?? { label, n: 0 };
        e.n += 1;
        counts.set(label.toLowerCase(), e);
      }
      const top3 = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 3);
      const lifetimeTop = normalizeTopList(tracksRaw);
      const dayNames = new Set(dayStreams.map((s) => s.trackName.toLowerCase()));
      const revivals = lifetimeTop.filter((t) => !dayNames.has(t.name.toLowerCase())).slice(0, 2);
      const novel = dayStreams.filter((s) => !s.artistNames.some((a) => core.has(a.toLowerCase())));
      const novelty = dayStreams.length > 0 ? novel.length / dayStreams.length : 0;
      const lines = [
        `Daily brief for ${u} — ${day}: ${dayStreams.length} streams.`,
        top3.length > 0
          ? `Top 3: ${top3.map((t, i) => `${i + 1}. ${t.label} (×${t.n})`).join(' · ')}`
          : 'Top 3: no dated streams that day.',
        revivals.length > 0
          ? `Revivals: ${revivals.map((r) => `${r.name} (${r.count} lifetime)`).join(' · ')}`
          : 'Revivals: none — everything lifetime-top was played.',
        `Novelty share: ${(novelty * 100).toFixed(0)}% of the day outside the lifetime core.`,
      ];
      return textOut(lines, {
        user: u, date: day, streams: dayStreams.length,
        top3: top3.map((t) => ({ label: t.label, plays: t.n })),
        revivals, noveltyShare: Math.round(novelty * 1000) / 1000,
      });
    },
  );

  // ---- 3. taste_era_playlist ----
  server.tool(
    'taste_era_playlist',
    'Era window → representative track list: pick a listening era and get its playlist spec. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      era_index: z.number().int().min(0).optional().describe('Era index (0 = oldest). Default: latest'),
      track_count: z.number().int().min(1).max(50).optional().describe('Tracks to list. Default: 15'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const [tracksRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, { range: 'lifetime', limit: '100' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topTracks: tracksRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const streams = normalizeStreams(streamsRaw);
      const months = summarizeMonths(streams);
      if (months.length === 0) return textOut([`No dated streams for "${u}" — cannot build eras.`]);
      const eras = detectEras(months);
      const idx = args.era_index ?? eras.length - 1;
      if (idx < 0 || idx >= eras.length) {
        return textOut([`Era ${idx} out of range for ${u} — ${eras.length} era(s) (0–${eras.length - 1}).`]);
      }
      const era = eras[idx];
      const inEra = streams.filter((s) => {
        const m = ymd(s.playedAtMs).slice(0, 7);
        return m >= era.startMonth && m <= era.endMonth;
      });
      const picks = picksFromStreams(inEra.reverse(), `era ${era.startMonth}→${era.endMonth}`);
      // De-dupe preserving order, fall back to lifetime tops when the era window is thin.
      const seen = new Set<string>();
      const deduped = picks.filter((p) => {
        const k = `${p.artist} — ${p.title}`.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const fallback = picksFromTopTracks(tracksRaw, 'lifetime top (era fallback)');
      for (const p of fallback) {
        if (deduped.length >= (args.track_count ?? 15)) break;
        const k = `${p.artist} — ${p.title}`.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(p);
      }
      const shaped = truncateItems(deduped, resolveMaxResults(args.max_results, args.track_count ?? 15));
      const { lines, missing } = renderPicks(shaped.items);
      const out = [
        `Era playlist for ${u} — era ${idx + 1}/${eras.length}: ${era.startMonth} → ${era.endMonth} (${era.months}mo, signature ${era.signatureArtist}, ~${era.avgStreamsPerMonth}/mo):`,
        ...lines,
        SPOTIFY_FALLBACK_GUIDANCE,
      ];
      if (missing.length > 0) out.push(`missing[]: ${missing.join(' · ')}`);
      return textOut(out, { user: u, era, picks: shaped.items, missing });
    },
  );

  // ---- 4. taste_forgotten_bangers ----
  server.tool(
    'taste_forgotten_bangers',
    'Forgotten-bangers playlist spec: lifetime tops missing from the recent sample, ranked with a revival pick. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      top_limit: z.number().int().min(5).max(100).optional().describe('Lifetime top tracks to scan. Default: 50'),
      track_count: z.number().int().min(1).max(50).optional().describe('Bangers to list. Default: 15'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const [topRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, { range: 'lifetime', limit: String(args.top_limit ?? 50) }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topTracks: topRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const top = normalizeTopList(topRaw);
      const rawTops = asItems(topRaw);
      const streams = normalizeStreams(streamsRaw);
      const recentIds = new Set(streams.map((s) => s.trackId.toLowerCase()));
      const recentNames = new Set(streams.map((s) => s.trackName.toLowerCase()));
      const forgottenIdx = top
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => !recentIds.has(t.id.toLowerCase()) && !recentNames.has(t.name.toLowerCase()));
      const picks: TrackPick[] = forgottenIdx.map(({ t, i }) => {
        const raw = rawTops[i] ?? {};
        return {
          artist: artistOf(raw) !== 'unknown artist' ? artistOf(raw) : t.name,
          title: trackNameOf(raw) !== 'unknown track' ? trackNameOf(raw) : t.name,
          spotifyId: spotifyIdOf(raw),
          evidence: `${t.count} lifetime streams, absent from last ${streams.length}`,
        };
      });
      const shaped = truncateItems(picks, resolveMaxResults(args.max_results, args.track_count ?? 15));
      if (picks.length === 0) {
        return textOut([`No forgotten bangers for ${u} — every lifetime top-${top.length} track appears in the recent sample.`]);
      }
      const { lines, missing } = renderPicks(shaped.items);
      const out = [
        `Forgotten bangers for ${u}: ${picks.length} of lifetime top-${top.length} absent from the last ${streams.length} streams.`,
        ...lines,
        `Revival pick: replay "${shaped.items[0].artist} — ${shaped.items[0].title}".`,
        SPOTIFY_FALLBACK_GUIDANCE,
      ];
      if (missing.length > 0) out.push(`missing[]: ${missing.join(' · ')}`);
      if (shaped.footer) out.push(`(${shaped.footer})`);
      const pagination = paginationInfo({ total: picks.length, offset: 0, limit: null, returned: picks.length });
      return {
        content: [{ type: 'text', text: out.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, { missing, scannedTop: top.length }),
      };
    },
  );

  // ---- 5. taste_obsession_ladder ----
  server.tool(
    'taste_obsession_ladder',
    'Obsession ladder: artists ranked by stream share, each with an exposure tier. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      range: rangeSchema,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const range = args.range ?? 'lifetime';
      const artistsRaw = await statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, { range, limit: '50' });
      if (args.response_format === 'json') {
        const raw = { topArtists: artistsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const artists = normalizeTopList(artistsRaw);
      if (artists.length === 0) return textOut([`No artist data for "${u}" (range ${range}).`]);
      const total = artists.reduce((s, a) => s + a.count, 0);
      const ladder = artists.map((a, i) => ({
        rank: i + 1,
        artist: a.name,
        streams: a.count,
        share: total > 0 ? Math.round((a.count / total) * 1000) / 1000 : 0,
        tier: classifyExposure(a.count),
      }));
      const shaped = truncateItems(ladder, resolveMaxResults(args.max_results));
      const lines = [`Obsession ladder for ${u} (range ${range}, ${artists.length} artists, ${total} streams):`];
      shaped.items.forEach((e) => {
        lines.push(`  ${e.rank}. ${e.artist} — ${(e.share * 100).toFixed(1)}% (${e.streams}) [${e.tier}]`);
      });
      if (shaped.footer) lines.push(`(${shaped.footer})`);
      const pagination = paginationInfo({ total: ladder.length, offset: 0, limit: null, returned: ladder.length });
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, { user: u, range }),
      };
    },
  );

  // ---- 6. taste_diamond_rotation ----
  server.tool(
    'taste_diamond_rotation',
    'Diamond-mining rotation: mid-tier lifetime tracks (rank ~20–60) absent from recent streams — deep cuts to re-polish. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      track_count: z.number().int().min(1).max(30).optional().describe('Diamonds to list. Default: 10'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const [topRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, { range: 'lifetime', limit: '60' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topTracks: topRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const top = normalizeTopList(topRaw);
      const rawTops = asItems(topRaw);
      const streams = normalizeStreams(streamsRaw);
      const recentNames = new Set(streams.map((s) => s.trackName.toLowerCase()));
      const mid = top
        .map((t, i) => ({ t, i }))
        .filter(({ t, i }) => i >= 19 && !recentNames.has(t.name.toLowerCase()));
      const picks: TrackPick[] = mid.map(({ t, i }) => {
        const raw = rawTops[i] ?? {};
        return {
          artist: artistOf(raw) !== 'unknown artist' ? artistOf(raw) : t.name,
          title: trackNameOf(raw) !== 'unknown track' ? trackNameOf(raw) : t.name,
          spotifyId: spotifyIdOf(raw),
          evidence: `lifetime rank #${i + 1} (${t.count} streams), absent from last ${streams.length}`,
        };
      });
      const shaped = truncateItems(picks, resolveMaxResults(args.max_results, args.track_count ?? 10));
      if (picks.length === 0) {
        return textOut([`No diamonds in rotation for ${u} — mid-tier lifetime tracks all appear in the recent sample (or fewer than 20 lifetime tops).`]);
      }
      const { lines, missing } = renderPicks(shaped.items);
      const out = [`Diamond rotation for ${u} (${picks.length} deep cuts):`, ...lines, SPOTIFY_FALLBACK_GUIDANCE];
      if (missing.length > 0) out.push(`missing[]: ${missing.join(' · ')}`);
      if (shaped.footer) out.push(`(${shaped.footer})`);
      return textOut(out, { user: u, picks: shaped.items, missing });
    },
  );

  // ---- 7. taste_weekly_recap ----
  server.tool(
    'taste_weekly_recap',
    'Week-in-review brief: stream count, top artists/tracks of the window, busiest day, novelty share. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      days: z.number().int().min(1).max(30).optional().describe('Window in days back from now. Default: 7'),
      response_format: ResponseFormat,
    },
    async (args) => {
      const u = args.statsfm_user;
      const days = args.days ?? 7;
      const [artistsRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, { range: 'lifetime', limit: '20' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topArtists: artistsRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const cutoff = Date.now() - days * 86_400_000;
      const window = normalizeStreams(streamsRaw).filter((s) => s.playedAtMs >= cutoff);
      if (window.length === 0) return textOut([`No streams for ${u} in the last ${days}d.`]);
      const artistCounts = new Map<string, number>();
      const trackCounts = new Map<string, { label: string; n: number }>();
      const dayCounts = new Map<string, number>();
      for (const s of window) {
        for (const a of s.artistNames.length > 0 ? s.artistNames : ['unknown']) {
          artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
        }
        const label = `${s.artistNames.join(', ') || 'unknown artist'} — ${s.trackName}`;
        const e = trackCounts.get(label.toLowerCase()) ?? { label, n: 0 };
        e.n += 1;
        trackCounts.set(label.toLowerCase(), e);
        const d = ymd(s.playedAtMs);
        dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
      }
      const topArtists = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const topTracks = [...trackCounts.values()].sort((a, b) => b.n - a.n).slice(0, 3);
      const busiest = [...dayCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const sessions = groupSessions(window);
      const core = new Set(normalizeTopList(artistsRaw).slice(0, 20).map((a) => a.name.toLowerCase()));
      const novel = window.filter((s) => !s.artistNames.some((a) => core.has(a.toLowerCase())));
      const novelty = novel.length / window.length;
      const lines = [
        `Weekly recap for ${u} (last ${days}d): ${window.length} streams across ${sessions.length} sessions.`,
        `Top artists: ${topArtists.map(([a, n]) => `${a} (×${n})`).join(' · ')}.`,
        `Top tracks: ${topTracks.map((t) => `${t.label} (×${t.n})`).join(' · ')}.`,
        `Busiest day: ${busiest[0]} (${busiest[1]} streams). Novelty share: ${(novelty * 100).toFixed(0)}%.`,
      ];
      return textOut(lines, {
        user: u, days, streams: window.length, sessions: sessions.length,
        topArtists: topArtists.map(([a, n]) => ({ artist: a, plays: n })),
        topTracks, busiestDay: busiest[0], noveltyShare: Math.round(novelty * 1000) / 1000,
      });
    },
  );

  // ---- 8. taste_genre_bridge ----
  server.tool(
    'taste_genre_bridge',
    'Genre-bridge playlist spec: picks spanning two genres with evidence + risk per pick. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      from_genre: z.string().min(1).optional().describe('Start genre (substring). Default: lifetime #1'),
      to_genre: z.string().min(1).optional().describe('Target genre (substring). Default: most novel adjacent genre'),
      track_count: z.number().int().min(2).max(30).optional().describe('Picks to list. Default: 8'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const [genresRaw, tracksRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/genres`, { range: 'lifetime', limit: '15' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, { range: 'lifetime', limit: '60' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '200' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topGenres: genresRaw, topTracks: tracksRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const genres = normalizeTopList(genresRaw);
      if (genres.length === 0) return textOut([`No genre data for "${u}".`]);
      const from = args.from_genre
        ? (genres.find((g) => g.name.toLowerCase().includes(args.from_genre!.toLowerCase())) ?? genres[0])
        : genres[0];
      const to = args.to_genre
        ? (genres.find((g) => g.name.toLowerCase().includes(args.to_genre!.toLowerCase())) ?? genres[Math.min(3, genres.length - 1)])
        : (genres.slice(3)[0] ?? genres[genres.length - 1]);
      const streams = normalizeStreams(streamsRaw);
      const recentNames = new Set(streams.map((s) => s.trackName.toLowerCase()));
      const rawTops = asItems(tracksRaw);
      const tops = normalizeTopList(tracksRaw);
      // Alternate underexplored (not recent) with familiar (recent) picks.
      const fresh = tops.map((t, i) => ({ t, i })).filter(({ t }) => !recentNames.has(t.name.toLowerCase()));
      const familiar = tops.map((t, i) => ({ t, i })).filter(({ t }) => recentNames.has(t.name.toLowerCase()));
      const want = args.track_count ?? 8;
      const picks: TrackPick[] = [];
      for (let i = 0; picks.length < want && (i < fresh.length || i < familiar.length); i++) {
        for (const src of [fresh, familiar]) {
          if (picks.length >= want || i >= src.length) continue;
          const { t, i: ri } = src[i];
          const raw = rawTops[ri] ?? {};
          picks.push({
            artist: artistOf(raw) !== 'unknown artist' ? artistOf(raw) : t.name,
            title: trackNameOf(raw) !== 'unknown track' ? trackNameOf(raw) : t.name,
            spotifyId: spotifyIdOf(raw),
            evidence: `${t.count} lifetime streams; bridge ${from.name} → ${to.name}`,
          });
        }
      }
      const shaped = truncateItems(picks, resolveMaxResults(args.max_results, want));
      const { lines, missing } = renderPicks(shaped.items);
      const out = [
        `Genre bridge for ${u}: ${from.name} (${from.count}) → ${to.name} (${to.count}). Evidence: ${to.name} ranks adjacent but underexplored vs core ${from.name}. Risk: start with one playlist, skip if the first 3 tracks bounce.`,
        ...lines,
        SPOTIFY_FALLBACK_GUIDANCE,
      ];
      if (missing.length > 0) out.push(`missing[]: ${missing.join(' · ')}`);
      if (picks.length === 0) return textOut([`Not enough track data for "${u}" to build a genre bridge.`]);
      return textOut(out, { user: u, from, to, picks: shaped.items, missing });
    },
  );

  // ---- 9. taste_novelty_loyalty ----
  server.tool(
    'taste_novelty_loyalty',
    'Loyalty-vs-novelty report: top-5 share, recent-outside-core share, and a verdict (comfort / balanced / explorer). Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      range: rangeSchema,
      response_format: ResponseFormat,
    },
    async (args) => {
      const u = args.statsfm_user;
      const range = args.range ?? 'lifetime';
      const [artistsRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, { range, limit: '20' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '200' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topArtists: artistsRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const artists = normalizeTopList(artistsRaw);
      const streams = normalizeStreams(streamsRaw);
      if (artists.length === 0) return textOut([`No artist data for "${u}" (range ${range}).`]);
      const total = artists.reduce((s, a) => s + a.count, 0);
      const top5 = artists.slice(0, 5).reduce((s, a) => s + a.count, 0);
      const loyalty = total > 0 ? top5 / total : 0;
      const core = new Set(artists.slice(0, 20).map((a) => a.name.toLowerCase()));
      const novel = streams.filter((s) => !s.artistNames.some((a) => core.has(a.toLowerCase())));
      const novelty = streams.length > 0 ? novel.length / streams.length : 0;
      const verdict = loyalty > 0.7 && novelty < 0.2 ? 'comfort' : novelty > 0.5 ? 'explorer' : 'balanced';
      const lines = [
        `Novelty vs loyalty for ${u} (range ${range}): loyalty ${(loyalty * 100).toFixed(0)}% top-5, novelty ${(novelty * 100).toFixed(0)}% recent-outside-core (n=${streams.length}).`,
        `Verdict: ${verdict} — ${verdict === 'comfort' ? 'deep in the core catalog; schedule a discovery session.' : verdict === 'explorer' ? 'roaming wide; anchor the next playlist with top-5 artists.' : 'healthy mix of staples and new ground.'}`,
      ];
      return textOut(lines, {
        user: u, range,
        loyaltyShareTop5: Math.round(loyalty * 1000) / 1000,
        recentNoveltyShare: Math.round(novelty * 1000) / 1000,
        recentStreamsSampled: streams.length, verdict,
      });
    },
  );

  // ---- 10. taste_listening_clock ----
  server.tool(
    'taste_listening_clock',
    'Listening-clock summary: day-part split (UTC), peak window, and a sequencing note for playlist order. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      response_format: ResponseFormat,
    },
    async (args) => {
      const u = args.statsfm_user;
      const streamsRaw = await statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' });
      if (args.response_format === 'json') {
        const raw = { streams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const streams = normalizeStreams(streamsRaw);
      if (streams.length === 0) return textOut([`No dated streams for "${u}" — no clock to summarize.`]);
      const parts = summarizeDayParting(streams);
      const peak = (Object.entries(parts) as Array<[keyof typeof parts, number]>).sort((a, b) => b[1] - a[1])[0];
      const seqNote =
        peak[0] === 'night' ? 'Sequence slow → slower: late-night order, ambient tail.'
        : peak[0] === 'morning' ? 'Sequence bright openers first: morning energy, upbeat head.'
        : peak[0] === 'afternoon' ? 'Sequence steady mid-tempo: afternoon work-friendly arc.'
        : 'Sequence warm-up → peak → wind-down: evening arc.';
      const lines = [
        `Listening clock for ${u} (last ${streams.length} streams, UTC): night ${parts.night} / morning ${parts.morning} / afternoon ${parts.afternoon} / evening ${parts.evening} — peak: ${peak[0]}.`,
        seqNote,
      ];
      return textOut(lines, { user: u, dayParting: { ...parts, peak: peak[0] }, sequencingNote: seqNote, sampled: streams.length });
    },
  );

  // ---- 11. taste_revival_queue ----
  server.tool(
    'taste_revival_queue',
    'Revival queue builder: ordered re-listen queue from forgotten favorites + dormant-affinity artists, each with a search_tracks fallback line. Read-only, no auth.',
    {
      statsfm_user: statsfmUserSchema,
      queue_size: z.number().int().min(1).max(30).optional().describe('Queue length. Default: 10'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const u = args.statsfm_user;
      const [tracksRaw, artistsRaw, streamsRaw] = await Promise.all([
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/tracks`, { range: 'lifetime', limit: '50' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/top/artists`, { range: 'lifetime', limit: '30' }),
        statsfmGet<unknown>(`/users/${encodeURIComponent(u)}/streams`, { limit: '500' }),
      ]);
      if (args.response_format === 'json') {
        const raw = { topTracks: tracksRaw, topArtists: artistsRaw, recentStreams: streamsRaw };
        return { content: [{ type: 'text', text: JSON.stringify(raw) }], structuredContent: { ...raw } };
      }
      const tops = normalizeTopList(tracksRaw);
      const rawTops = asItems(tracksRaw);
      const artists = normalizeTopList(artistsRaw);
      const streams = normalizeStreams(streamsRaw);
      const recentNames = new Set(streams.map((s) => s.trackName.toLowerCase()));
      const recentArtists = new Set(streams.flatMap((s) => s.artistNames.map((a) => a.toLowerCase())));
      const queue: TrackPick[] = [];
      tops.forEach((t, i) => {
        if (recentNames.has(t.name.toLowerCase())) return;
        const raw = rawTops[i] ?? {};
        queue.push({
          artist: artistOf(raw) !== 'unknown artist' ? artistOf(raw) : t.name,
          title: trackNameOf(raw) !== 'unknown track' ? trackNameOf(raw) : t.name,
          spotifyId: spotifyIdOf(raw),
          evidence: `forgotten favorite: ${t.count} lifetime streams`,
        });
      });
      for (const a of artists.slice(10, 20)) {
        if (queue.length >= (args.queue_size ?? 10)) break;
        if (recentArtists.has(a.name.toLowerCase())) continue;
        queue.push({
          artist: a.name,
          title: `(top track by ${a.name} — search_tracks "${a.name} top")`,
          spotifyId: null,
          evidence: `dormant affinity: ${a.count} lifetime streams, absent from last ${streams.length}`,
        });
      }
      const shaped = truncateItems(queue, resolveMaxResults(args.max_results, args.queue_size ?? 10));
      if (queue.length === 0) {
        return textOut([`Revival queue for ${u} is empty — nothing dormant in the lifetime tops.`]);
      }
      const { lines, missing } = renderPicks(shaped.items);
      const out = [
        `Revival queue for ${u} (${queue.length} items — oldest cravings first):`,
        ...lines,
        SPOTIFY_FALLBACK_GUIDANCE,
      ];
      if (missing.length > 0) out.push(`missing[]: ${missing.join(' · ')}`);
      if (shaped.footer) out.push(`(${shaped.footer})`);
      const pagination = paginationInfo({ total: queue.length, offset: 0, limit: null, returned: queue.length });
      return {
        content: [{ type: 'text', text: out.join('\n') }],
        structuredContent: listStructuredContent(shaped.items, pagination, { user: u, missing }),
      };
    },
  );
}
