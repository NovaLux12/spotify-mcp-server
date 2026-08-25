/**
 * Podcast session composer (#112 idea 3): greedy-packs the user's saved
 * podcast episodes into a listening session of a fixed length in minutes,
 * then (optionally) starts it on a device.
 *
 * Sources, all read-only and pagination-capped at SPOTIFY_MCP_FETCH_ALL_CAP:
 *   - saved episodes        GET /me/episodes
 *   - episodes of saved shows  GET /me/shows → GET /shows/{id}/episodes
 *
 * start_podcast_session documents an honest platform limitation: Spotify's
 * queue API cannot seek — POST /me/player/queue always appends from the
 * episode's beginning. Only the FIRST planned episode can honor a resume
 * offset, via PUT /me/player/play with context_uri+offset; everything after
 * it is queued and will play from the start.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import {
  DryRun,
  MaxResults,
  ResponseFormat,
  describeDryRun,
  resolveMaxResults,
} from '../shaping.js';
import type {
  SavedEpisodeItem,
  SavedShowItem,
  SpotifyEpisodeFull,
  SpotifyEpisodeSimple,
  SpotifyPaged,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };

/** One candidate episode with its remaining-playable time resolved. */
interface PlannedEpisode {
  uri: string;
  name: string;
  show_name: string;
  show_uri: string;
  /** Full episode length. */
  duration_ms: number;
  /** Where playback would resume (0 = from the start). */
  resume_position_ms: number;
  fully_played: boolean;
  /** duration_ms − resume_position_ms when partially played; else duration_ms. */
  remaining_ms: number;
}

interface SessionPlan {
  minutes: number;
  budget_ms: number;
  /** Ordered greedy pack. */
  episodes: PlannedEpisode[];
  /** Sum of remaining_ms across packed episodes. */
  planned_ms: number;
  /** planned_ms / budget_ms, rounded to whole percent. */
  fill_percent: number;
  skipped_fully_played: number;
  /** Total candidates examined before packing stopped. */
  scanned: number;
  stopped_reason:
    | 'next_episode_exceeds_budget'
    | 'candidates_exhausted'
    | 'scan_cap_reached';
}

const Kind = z
  .enum(['episodes', 'shows'])
  .optional()
  .describe(
    "Restrict the source: 'episodes' = your saved episodes only, 'shows' = recent episodes of your saved shows only. Omit to use saved episodes (plus saved shows when saved_only is false)",
  );

const Minutes = z
  .number()
  .int()
  .min(1)
  .max(480)
  .describe('Session length in minutes (1–480)');

const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

function remainingMs(ep: { duration_ms: number; resume_point?: { fully_played: boolean; resume_position_ms: number } }): number {
  if (!ep.resume_point || ep.resume_point.fully_played) return ep.duration_ms;
  return Math.max(0, ep.duration_ms - ep.resume_point.resume_position_ms);
}

function toPlanned(
  ep: Pick<SpotifyEpisodeSimple, 'uri' | 'name' | 'duration_ms' | 'resume_point'> & {
    show_name: string;
    show_uri: string;
  },
): PlannedEpisode {
  return {
    uri: ep.uri,
    name: ep.name,
    show_name: ep.show_name,
    show_uri: ep.show_uri,
    duration_ms: ep.duration_ms,
    resume_position_ms:
      ep.resume_point && !ep.resume_point.fully_played
        ? ep.resume_point.resume_position_ms
        : 0,
    fully_played: Boolean(ep.resume_point?.fully_played),
    remaining_ms: remainingMs(ep),
  };
}

/**
 * Gather candidate episodes. `kind` picks a single source; otherwise saved
 * episodes are used, extended by saved-show episodes when saved_only=false.
 * The combined scan never exceeds fetchAllCap episodes.
 */
async function gatherCandidates(client: SpotifyClient, kind?: 'episodes' | 'shows', savedOnly = true): Promise<PlannedEpisode[]> {
  const cap = getConfig().fetchAllCap;
  const wantSavedEpisodes = kind !== 'shows';
  const wantShowEpisodes = kind === 'shows' || !savedOnly;

  const out: PlannedEpisode[] = [];
  const seen = new Set<string>();

  if (wantSavedEpisodes) {
    const saved = await client.getAllPages<SavedEpisodeItem>('/me/episodes', {
      limit: '50',
    }, { maxItems: cap });
    for (const item of saved) {
      if (out.length >= cap) break;
      const ep = item.episode as SpotifyEpisodeFull;
      if (seen.has(ep.uri)) continue;
      seen.add(ep.uri);
      out.push(toPlanned({ ...ep, show_name: ep.show.name, show_uri: ep.show.uri }));
    }
  }

  if (wantShowEpisodes && out.length < cap) {
    const shows = await client.getAllPages<SavedShowItem>('/me/shows', { limit: '50' }, {
      maxItems: cap,
    });
    for (const entry of shows) {
      if (out.length >= cap) break;
      // Bounded probe per show: newest page only — a session composer wants
      // recent episodes, not every archive back-catalogue.
      const res = await client.get<SpotifyPaged<SpotifyEpisodeSimple>>(
        `/shows/${encodeURIComponent(entry.show.id)}/episodes`,
        { limit: '25' },
      );
      for (const ep of res?.items ?? []) {
        if (out.length >= cap) break;
        if (!ep || seen.has(ep.uri)) continue;
        seen.add(ep.uri);
        out.push(
          toPlanned({
            ...ep,
            show_name: entry.show.name,
            show_uri: entry.show.uri,
          }),
        );
      }
    }
  }

  return out;
}

/** Greedy in-order pack: take each playable episode that fits, stop at the first overrun. */
export function packSession(candidates: PlannedEpisode[], minutes: number): SessionPlan {
  const budgetMs = minutes * 60_000;
  let left = budgetMs;
  let plannedMs = 0;
  let skippedFullyPlayed = 0;
  let scanned = 0;
  let stopped: SessionPlan['stopped_reason'] = 'candidates_exhausted';
  const episodes: PlannedEpisode[] = [];

  for (const ep of candidates) {
    scanned++;
    if (ep.fully_played || ep.remaining_ms <= 0) {
      skippedFullyPlayed++;
      continue;
    }
    if (ep.remaining_ms <= left) {
      episodes.push(ep);
      plannedMs += ep.remaining_ms;
      left -= ep.remaining_ms;
      if (left === 0) {
        stopped = 'next_episode_exceeds_budget';
        break;
      }
    } else {
      stopped = 'next_episode_exceeds_budget';
      break;
    }
  }

  return {
    minutes,
    budget_ms: budgetMs,
    episodes,
    planned_ms: plannedMs,
    fill_percent: budgetMs > 0 ? Math.round((plannedMs / budgetMs) * 100) : 0,
    skipped_fully_played: skippedFullyPlayed,
    scanned,
    stopped_reason: stopped,
  };
}

function planFooter(plan: SessionPlan): string {
  const reason =
    plan.stopped_reason === 'candidates_exhausted'
      ? 'all candidates considered'
      : plan.stopped_reason === 'scan_cap_reached'
        ? `stopped at scan cap (${getConfig().fetchAllCap})`
        : 'next unplayed episode exceeds the remaining budget';
  return `Total: ${formatDuration(plan.planned_ms)} planned (${plan.fill_percent}% of ${plan.minutes} min budget) · ${plan.episodes.length} episode(s) · ${plan.skipped_fully_played} fully played skipped · ${reason}`;
}

function renderPlan(plan: SessionPlan, detailed: boolean): string {
  if (plan.episodes.length === 0) {
    return 'No playable episodes fit this session — nothing saved fits or remains unplayed.';
  }
  const lines: string[] = [`Podcast session plan (${plan.minutes} min):`];
  plan.episodes.forEach((ep, i) => {
    const resume =
      ep.resume_position_ms > 0
        ? ` resumes at ${formatDuration(ep.resume_position_ms)}`
        : '';
    lines.push(
      `${i + 1}. "${ep.name}" — ${ep.show_name} | ${formatDuration(ep.remaining_ms)} of ${formatDuration(ep.duration_ms)}${resume} | URI: ${ep.uri}`,
    );
    if (detailed) lines.push(`   Show URI: ${ep.show_uri}`);
  });
  lines.push('', planFooter(plan));
  return lines.join('\n');
}

const queueParams = (uri: string, deviceId?: string): string => {
  const params = new URLSearchParams({ uri });
  if (deviceId) params.set('device_id', deviceId);
  return params.toString();
};

export function registerPodcastSessionTools(server: McpServer, client: SpotifyClient): void {
  // plan_podcast_session
  server.tool(
    'plan_podcast_session',
    "Greedy-pack your saved podcast episodes into a listening session of a given length. Episodes play their remaining time (duration minus resume position); fully played ones are skipped. Scanning stops at the first unplayed episode that doesn't fit.",
    {
      minutes: Minutes,
      kind: Kind,
      saved_only: z
        .boolean()
        .optional()
        .describe('When no kind is set, include recent episodes of saved shows too. Default: true (saved episodes only)'),
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const fmt = args.response_format;
      const plan = packSession(
        await gatherCandidates(client, args.kind, args.saved_only ?? true),
        args.minutes,
      );
      if (fmt === 'json') {
        return {
          content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }],
          structuredContent: { ...plan },
        };
      }
      const view = plan.episodes.slice(0, resolveMaxResults(args.max_results));
      const shown: SessionPlan = { ...plan, episodes: view };
      return {
        content: [{ type: 'text', text: renderPlan(shown, fmt === 'detailed') }],
        structuredContent: { ...plan },
      };
    },
  );

  // start_podcast_session
  server.tool(
    'start_podcast_session',
    "Plan a podcast session (see plan_podcast_session) and start it on a device. Limitation: Spotify cannot apply resume offsets when queueing — only the first episode can start at its resume point (via PUT /me/player/play on its show context); later episodes are appended to the queue and play from the beginning. With dry_run, nothing is played or queued.",
    {
      minutes: Minutes,
      kind: Kind,
      saved_only: z
        .boolean()
        .optional()
        .describe('When no kind is set, include recent episodes of saved shows too. Default: true (saved episodes only)'),
      device_id: z.string().optional().describe('Target device ID; omit for the active device'),
      dry_run: DryRun,
      response_format: ResponseFormat,
      max_results: MaxResults,
    },
    async (args) => {
      const plan = packSession(
        await gatherCandidates(client, args.kind, args.saved_only ?? true),
        args.minutes,
      );
      if (plan.episodes.length === 0) {
        return {
          content: [{ type: 'text', text: renderPlan(plan, false) }],
          structuredContent: { ...plan, ok: false },
        };
      }

      const [first] = plan.episodes;
      // Resumable first → it starts via PUT play and only the rest is queued.
      // Otherwise every planned URI is queued uniformly (all play from the
      // start — Spotify has no seek-on-enqueue).
      const queueUris =
        first.resume_position_ms > 0 ? plan.episodes.slice(1) : plan.episodes;
      const target = args.device_id ?? 'the active device';
      const changes = [
        `start "${first.name}" on ${target}${first.resume_position_ms > 0 ? ` at ${formatDuration(first.resume_position_ms)}` : ''}`,
        ...queueUris.map((ep) => `queue ${ep.uri}`),
      ];
      // dry_run (#57): reads above resolved the concrete plan; stop before any
      // mutating call so queue/playback state stays untouched.
      if (args.dry_run) {
        return {
          content: [{
            type: 'text',
            text: describeDryRun(`start a ${plan.minutes}-minute podcast session`, target, changes),
          }],
          structuredContent: {
            ok: true,
            dry_run: true,
            device_id: args.device_id ?? null,
            ...plan,
          },
        };
      }

      if (first.resume_position_ms > 0) {
        // Resume path: PUT /me/player/play on the episode's show context with
        // a URI offset — the one place Spotify honors a starting position.
        const body: Record<string, unknown> = {
          context_uri: first.show_uri,
          offset: { uri: first.uri },
        };
        const suffix = args.device_id ? `?device_id=${encodeURIComponent(args.device_id)}` : '';
        await client.put(`/me/player/play${suffix}`, body);
      }
      // Queue the remaining URIs. Queue adds always begin at the episode
      // start — no seek exists on enqueue.
      for (const ep of queueUris) {
        await client.post(`/me/player/queue?${queueParams(ep.uri, args.device_id)}`);
      }
      const summary = [
        `Started ${plan.minutes}-minute podcast session on ${target}:`,
        ...changes.map((c) => `  • ${c}`),
        '',
        planFooter(plan),
        'Note: only the first episode honored its resume position; queued episodes play from the start.',
      ].join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: { ok: true, device_id: args.device_id ?? null, ...plan },
      };
    },
  );
}
