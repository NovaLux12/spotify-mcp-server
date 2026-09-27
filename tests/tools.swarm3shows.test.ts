import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3ShowsTools } from '../src/tools/swarm3_shows.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

interface Show {
  id: string;
  name: string;
  publisher: string;
  total_episodes: number;
}

/**
 * A row shaped like a REAL `GET /shows/{id}/episodes` response (#1508).
 *
 * There is deliberately no `show` member. The published OpenAPI schema types
 * that response as `PagingSimplifiedEpisodeObject` → `SimplifiedEpisodeObject`,
 * which is `allOf: [EpisodeBase, { type: object }]` — the second member
 * declares no properties and `EpisodeBase` has no `show`. This fixture used to
 * hand-assemble one WITH a `show`, which is exactly why the shipped bug was
 * invisible to the suite: a test that invents the field cannot observe the API
 * omitting it. `show` now reaches a row only from the request the caller made
 * or from the `/me/shows` shelf row, which is what the harness serves.
 */
interface Episode {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  release_date: string;
  resume_point?: { fully_played: boolean; resume_position_ms: number };
}

function show(id: string, publisher = 'Publisher'): Show {
  return {
    id,
    name: `Show ${id}`,
    publisher,
    total_episodes: 100,
  };
}

function episode(
  id: string,
  releaseDate: string,
  resumePoint?: { fully_played: boolean; resume_position_ms: number },
): Episode {
  return {
    id,
    name: `Episode ${id}`,
    uri: `spotify:episode:${id}`,
    duration_ms: 1_800_000,
    release_date: releaseDate,
    ...(resumePoint ? { resume_point: resumePoint } : {}),
  };
}

function harness(options: {
  shows?: Show[];
  episodesByShow?: Record<string, Episode[]>;
  /**
   * `GET /episodes/{id}` bodies, keyed by episode id. This is the ONE episode
   * shape whose `show` the OpenAPI schema actually declares — `EpisodeObject`
   * is `allOf: [EpisodeBase, …]` and adds `show` as REQUIRED — so it is the
   * only place a show name may be read off the payload (#1508). A value of
   * `null` models a deleted show, which `SpotifyEpisodeRow` documents.
   */
  episodesById?: Record<string, unknown>;
  failingShowIds?: ReadonlySet<string>;
  searchPage?: { items: Show[]; total?: number };
  savedEpisodeIds?: ReadonlySet<string>;
  containsFails?: boolean;
  /**
   * Replaces the `/me/library/contains` body outright, so a test can hand the
   * tool a response that is not one boolean per requested URI — the shape that
   * used to be read positionally as "none of these are saved" (#638).
   */
  containsBody?: unknown;
} = {}) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;

  const shows = options.shows ?? [];
  const episodesByShow = options.episodesByShow ?? {};
  const failingShowIds = options.failingShowIds ?? new Set<string>();
  const savedEpisodeIds = options.savedEpisodeIds ?? new Set<string>();
  const episodeRequests: string[] = [];
  const shelfRequests: string[] = [];
  const getCalls: Array<{ path: string; params: Record<string, string> }> = [];
  const writes: Array<{ method: 'put' | 'delete'; path: string }> = [];
  const client = {
    async getAllPages<T>(path: string): Promise<T[]> {
      shelfRequests.push(path);
      if (path === '/me/shows') {
        return shows.map((item) => ({ added_at: '2026-01-01T00:00:00Z', show: item })) as unknown as T[];
      }
      if (path === '/me/episodes') return [] as unknown as T[];
      return [] as unknown as T[];
    },
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      getCalls.push({ path, params: params ?? {} });
      if (path === '/search') {
        const page = options.searchPage;
        if (!page) return null;
        const offset = Number(params?.offset ?? 0);
        const limit = Number(params?.limit ?? page.items.length);
        return { shows: { items: page.items.slice(offset, offset + limit), total: page.total } } as T;
      }
      // #638: `GET /me/episodes/contains` was removed; the library check reads
      // `GET /me/library/contains` with `spotify:episode:` URIs. Serving the
      // old path here would have made every migrated read look like a failure
      // rather than a 404, which is how the two shapes drifted unnoticed.
      if (path === '/me/library/contains') {
        if (options.containsFails) throw new Error('library check unavailable');
        if ('containsBody' in options) return options.containsBody as T;
        const uris = String(params?.uris ?? '').split(',').filter(Boolean);
        return uris.map((uri) => savedEpisodeIds.has(uri.replace(/^spotify:episode:/, ''))) as T;
      }
      const match = /^\/shows\/([^/]+)\/episodes$/.exec(path);
      if (!match) {
        const one = /^\/episodes\/([^/]+)$/.exec(path);
        if (one) {
          const id = decodeURIComponent(one[1]);
          const body = options.episodesById?.[id];
          return (body === undefined ? null : body) as T;
        }
        return null;
      }
      const showId = decodeURIComponent(match[1]);
      episodeRequests.push(showId);
      if (failingShowIds.has(showId)) {
        throw Object.assign(new Error('rate limited'), { status: 429, retryAfterSec: 3 });
      }
      const items = episodesByShow[showId] ?? [];
      return {
        items: items.slice(0, Number(params?.limit ?? items.length)),
        total: items.length,
      } as T;
    },
    async put<T>(path: string): Promise<T | null> {
      writes.push({ method: 'put', path });
      return null;
    },
    async delete<T>(path: string): Promise<T | null> {
      writes.push({ method: 'delete', path });
      return null;
    },
  };

  registerSwarm3ShowsTools(fakeServer, client as unknown as SpotifyClient);
  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  return {
    byName,
    episodeRequests,
    shelfRequests,
    getCalls,
    writes,
    async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is registered`);
      return tool.handler(tool.validate(args));
    },
    validate(name: string, args: Record<string, unknown>): Record<string, unknown> {
      const tool = byName.get(name);
      assert.ok(tool, `${name} is registered`);
      return tool.validate(args);
    },
  };
}

describe('swarm3 show date handling', () => {
  it('computes month-boundary cadence and next release in UTC', async () => {
    const daily = show('daily');
    const h = harness({
      shows: [daily],
      episodesByShow: {
        daily: [episode('feb', '2026-02-01'), episode('jan', '2026-01-31')],
      },
    });

    const out = await h.invoke('shows_release_calendar', { max_shows: 1 });
    const payload = out.structuredContent as {
      calendar: Array<{ cadence_days: number | null; next_expected: string | null }>;
    };

    assert.equal(payload.calendar[0].cadence_days, 1);
    assert.equal(payload.calendar[0].next_expected, '2026-02-02');
  });

  it('computes leap-day cadence deterministically', async () => {
    const leapShow = show('leap');
    const h = harness({
      shows: [leapShow],
      episodesByShow: {
        leap: [episode('march', '2024-03-01'), episode('february', '2024-02-28')],
      },
    });

    const out = await h.invoke('shows_release_calendar', { max_shows: 1 });
    const payload = out.structuredContent as {
      calendar: Array<{ cadence_days: number | null; next_expected: string | null }>;
    };

    assert.equal(payload.calendar[0].cadence_days, 2);
    assert.equal(payload.calendar[0].next_expected, '2024-03-03');
  });

  it('rejects non-ISO and impossible since values before issuing requests', () => {
    const h = harness({ shows: [show('s1')] });

    assert.throws(
      () => h.validate('get_newly_released_episodes', { since: 'last tuesday' }),
      /YYYY-MM-DD/,
    );
    assert.throws(
      () => h.validate('get_newly_released_episodes', { since: '2026-02-30' }),
      /real calendar date/i,
    );
    assert.deepEqual(h.episodeRequests, []);
    assert.deepEqual(h.shelfRequests, []);
  });

  it('filters inclusively and does not treat year precision as a later day', async () => {
    const inboxShow = show('inbox');
    const h = harness({
      shows: [inboxShow],
      episodesByShow: {
        inbox: [
          episode('after', '2026-09-02'),
          episode('boundary', '2026-09-01'),
          episode('before', '2026-08-31'),
          episode('year-only', '2026'),
        ],
      },
    });

    const out = await h.invoke('get_newly_released_episodes', { since: '2026-09-01' });
    const payload = out.structuredContent as { total_new: number; episodes: Array<{ id: string }> };

    assert.equal(payload.total_new, 2);
    assert.deepEqual(payload.episodes.map((item) => item.id), ['after', 'boundary']);
  });
});

describe('publisher_portfolio request budget', () => {
  it('rejects a portfolio request budget above the bounded maximum', () => {
    const h = harness();

    assert.throws(() => h.validate('publisher_portfolio', { max_shows: 201 }));
  });

  it('issues exactly max_shows episode requests and discloses the skipped remainder', async () => {
    const shows = Array.from({ length: 100 }, (_, index) => show(`s${index + 1}`));
    const h = harness({ shows });

    const out = await h.invoke('publisher_portfolio', { max_shows: 10, max_results: 10 });
    const payload = out.structuredContent as {
      shows_total: number;
      shows_checked: number;
      shows_scanned: number;
      shows_skipped: number;
      budget_truncated: boolean;
      truncated: boolean;
    };

    assert.equal(h.episodeRequests.length, 10);
    assert.deepEqual(h.episodeRequests, shows.slice(0, 10).map((item) => item.id));
    assert.equal(payload.shows_total, 100);
    assert.equal(payload.shows_checked, 10);
    assert.equal(payload.shows_skipped, 90);
    assert.equal(payload.shows_scanned, 10);
    assert.equal(payload.budget_truncated, true);
    assert.equal(payload.truncated, false);
    assert.match(out.content[0].text, /shows_checked: 10 of 100/);
    assert.match(out.content[0].text, /90 show\(s\) skipped by max_shows budget/);
  });

  it('returns partial portfolio results and names a show lookup that failed', async () => {
    const good = show('good', 'Good Publisher');
    const gated = show('gated', 'Gated Publisher');
    const h = harness({
      shows: [good, gated],
      episodesByShow: { good: [episode('ge', '2026-09-20')] },
      failingShowIds: new Set([gated.id]),
    });

    const out = await h.invoke('publisher_portfolio', { max_shows: 2 });
    const payload = out.structuredContent as {
      shows_checked: number;
      shows_failed: number;
      failed_shows: Array<{ id: string; name: string; error: string }>;
      portfolio: Array<{ publisher: string; sampled_episodes: number }>;
    };

    assert.equal(payload.shows_checked, 2);
    assert.equal(payload.shows_failed, 1);
    assert.equal(payload.failed_shows[0].id, 'gated');
    assert.equal(payload.failed_shows[0].name, 'Show gated');
    assert.match(payload.failed_shows[0].error, /rate limited/);
    assert.deepEqual(payload.portfolio, [{
      publisher: 'Good Publisher',
      show_count: 1,
      shows: ['Show good'],
      listed_episodes: 100,
      sampled_episodes: 1,
      sampled_runtime_ms: 1_800_000,
      avg_episode_ms: 1_800_000,
    }]);
  });
});

// #818 — the listen-next label is derived from play state, never from the
// absence of a library/history flag. A finished episode read one line earlier
// must not render as NEW.
describe('show_recommendation_brief play-state labelling (#818)', () => {
  const fresh = show('s1', 'Network');

  function briefHarness(ep: Episode, extra: { savedEpisodeIds?: string[]; containsFails?: boolean } = {}) {
    return harness({
      shows: [fresh],
      episodesByShow: { s1: [ep] },
      savedEpisodeIds: new Set(extra.savedEpisodeIds ?? []),
      containsFails: extra.containsFails,
    });
  }

  type BriefRow = {
    id: string;
    saved_in_library: boolean | null;
    play_state: string;
    play_state_label: string;
    unlistened: boolean;
    undetermined: boolean;
  };
  type BriefPayload = {
    unlistened: number;
    undetermined: number;
    library_checked: boolean;
    brief: BriefRow[];
  };

  it('renders a fully played, unsaved episode as played — never NEW', async () => {
    const h = briefHarness(episode('finished', '2026-09-20', {
      fully_played: true,
      resume_position_ms: 0,
    }));

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload;

    assert.equal(payload.brief[0].id, 'finished');
    assert.equal(payload.brief[0].play_state, 'played');
    assert.equal(payload.brief[0].saved_in_library, false);
    assert.equal(payload.brief[0].unlistened, false);
    assert.match(out.content[0].text, /Episode finished \[played\]/);
    assert.doesNotMatch(out.content[0].text, /NEW/);
  });

  it('renders a partially played episode as in progress with its offset', async () => {
    const h = briefHarness(episode('partial', '2026-09-20', {
      fully_played: false,
      resume_position_ms: 900_000,
    }));

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload;

    assert.equal(payload.brief[0].play_state, 'in_progress');
    assert.match(out.content[0].text, /\[in progress \(15 min in\)\]/);
    assert.doesNotMatch(out.content[0].text, /NEW/);
  });

  it('renders an explicitly unstarted episode as NEW', async () => {
    const h = briefHarness(episode('untouched', '2026-09-20', {
      fully_played: false,
      resume_position_ms: 0,
    }));

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload;

    assert.equal(payload.brief[0].play_state, 'new');
    assert.equal(payload.brief[0].unlistened, true);
    assert.equal(payload.unlistened, 1);
    assert.match(out.content[0].text, /\[NEW — unplayed \(resume 0:00\)\]/);
  });

  it('withholds the label with a reason when Spotify returns no resume_point', async () => {
    const h = briefHarness(episode('no-resume', '2026-09-20'));

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload;

    assert.equal(payload.brief[0].play_state, 'unknown');
    assert.equal(payload.brief[0].unlistened, false);
    assert.equal(payload.brief[0].undetermined, true);
    assert.equal(payload.unlistened, 0);
    assert.equal(payload.undetermined, 1);
    // The positive NEW claim must be absent; the reason must be present.
    assert.doesNotMatch(out.content[0].text, /NEW —/);
    assert.match(out.content[0].text, /\[play state unknown — Spotify returned no resume_point\]/);
  });

  it('withholds the label when resume_point carries no readable offset', async () => {
    // `fully_played: false` with the offset absent or null: unreadable data, not an
    // observed 0:00. A `?? 0` here would print a resume position nobody reported.
    const absent = episode('no-offset', '2026-09-20', {
      fully_played: false,
    } as Episode['resume_point']);
    const nulled = episode('null-offset', '2026-09-20', {
      fully_played: false,
      resume_position_ms: null as unknown as number,
    });

    for (const ep of [absent, nulled]) {
      const h = briefHarness(ep);

      const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
      const payload = out.structuredContent as BriefPayload;

      assert.equal(payload.brief[0].play_state, 'unknown', `${ep.id}: unreadable offset is not a play state`);
      assert.equal(payload.brief[0].unlistened, false, `${ep.id}: not placed in the listen-next queue`);
      assert.equal(payload.brief[0].undetermined, true, `${ep.id}: the caller can see it is undetermined`);
      assert.equal(payload.unlistened, 0);
      assert.equal(payload.undetermined, 1);
      assert.doesNotMatch(out.content[0].text, /NEW/);
      assert.doesNotMatch(out.content[0].text, /resume 0:00/);
      assert.match(out.content[0].text, /\[play state unknown — Spotify returned no resume_point offset\]/);
    }
  });

  it('counts a /me/library/contains call that failed after being issued', async () => {
    const h = briefHarness(
      episode('unstarted', '2026-09-20', { fully_played: false, resume_position_ms: 0 }),
      { containsFails: true },
    );

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload & { library_requests: number };

    // The call was issued and consumed quota, so the disclosure must survive the throw.
    assert.equal(h.getCalls.filter((c) => c.path === '/me/library/contains').length, 1);
    assert.equal(payload.library_requests, 1);
    assert.equal(payload.library_checked, false);
    assert.match(out.content[0].text, /Quota: 1 show lookup\(s\) \+ 1 \/me\/library\/contains call\(s\)/);
  });

  it('reports an unreadable library check as unavailable rather than as not saved', async () => {
    const h = briefHarness(
      episode('unstarted', '2026-09-20', { fully_played: false, resume_position_ms: 0 }),
      { containsFails: true },
    );

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload;

    assert.equal(payload.library_checked, false);
    assert.equal(payload.brief[0].saved_in_library, null);
    assert.equal(payload.brief[0].unlistened, false);
    assert.equal(payload.unlistened, 0);
    assert.match(out.content[0].text, /\[library state unknown, NEW — unplayed \(resume 0:00\)\]/);
    assert.match(out.content[0].text, /library check unavailable/);
  });

  it('marks a library-saved episode saved and never unlistened', async () => {
    const h = briefHarness(
      episode('kept', '2026-09-20', { fully_played: false, resume_position_ms: 0 }),
      { savedEpisodeIds: ['kept'] },
    );

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload;

    assert.equal(payload.brief[0].saved_in_library, true);
    assert.equal(payload.brief[0].unlistened, false);
    assert.match(out.content[0].text, /\[saved, NEW — unplayed \(resume 0:00\)\]/);
  });

  it('discloses the library-leg request count instead of charging it silently', async () => {
    // 6 shows x 20 recent episodes each = 120 episode ids, which at 50 uris per
    // /me/library/contains request is 3 library calls on top of 6 show lookups.
    const many = Array.from({ length: 6 }, (_, i) => show(`s${i + 1}`, 'Network'));
    const episodesByShow = Object.fromEntries(
      many.map((s, i) => [
        s.id,
        Array.from({ length: 20 }, (_, j) =>
          episode(`e${i + 1}-${j + 1}`, '2026-09-20', { fully_played: false, resume_position_ms: 0 })),
      ]),
    );
    const h = harness({ shows: many, episodesByShow, savedEpisodeIds: new Set<string>() });

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload & {
      shows_checked: number;
      new_episodes: number;
      library_requests: number;
    };

    const containsCalls = h.getCalls.filter((c) => c.path === '/me/library/contains');
    assert.equal(containsCalls.length, 3);
    assert.equal(payload.library_requests, 3);
    assert.equal(payload.shows_checked, 6);
    assert.equal(payload.new_episodes, 120);
    // The read cap is its own policy key (50), and the requests must honour it.
    for (const call of containsCalls) {
      assert.ok(
        (call.params.uris ?? '').split(',').filter(Boolean).length <= 50,
        `library read of ${call.params.uris} exceeds the 50-uri /me/library/contains cap`,
      );
    }
    assert.match(out.content[0].text, /Quota: 6 show lookup\(s\) \+ 3 \/me\/library\/contains call\(s\)/);
    assert.match(out.content[0].text, /lower max_shows to cut the library leg/);
  });

  it('never derives episode state from the music recently-played feed', async () => {
    const h = briefHarness(episode('finished', '2026-09-20', {
      fully_played: true,
      resume_position_ms: 0,
    }));

    await h.invoke('show_recommendation_brief', { since: '2026-09-01' });

    assert.deepEqual(
      h.getCalls.filter((c) => c.path === '/me/player/recently-played'),
      [],
      'the brief must not read episode state from the music history feed',
    );
    assert.ok(
      h.getCalls.some((c) => c.path === '/me/library/contains'),
      'library state comes from /me/library/contains',
    );
    // The removed per-type read must not come back: a 404 on it in the field
    // would be reported to the caller as an unreadable library check.
    assert.deepEqual(
      h.getCalls.filter((c) => c.path === '/me/episodes/contains'),
      [],
      'GET /me/episodes/contains was removed by the Feb 2026 changelog',
    );
  });
});

// #822 — the publisher search page bound is real (never above the Feb-2026
// /search cap) and disclosed whenever it stops the scan short of the catalogue.
describe('find_show_by_publisher search bound (#822)', () => {
  const network = Array.from({ length: 10 }, (_, i) => show(`p${i + 1}`, 'Wondery Network'));

  it('requests a /search page within the shared Feb-2026 cap by default and when asked', async () => {
    const h = harness({ searchPage: { items: network, total: 120 } });

    await h.invoke('find_show_by_publisher', { query: 'wondery' });
    await h.invoke('find_show_by_publisher', { query: 'wondery', limit: 3 });

    const searchCalls = h.getCalls.filter((c) => c.path === '/search');
    assert.equal(searchCalls.length, 2);
    for (const call of searchCalls) {
      const limit = Number(call.params.limit);
      assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 10, `recorded limit ${call.params.limit} breaks the /search cap`);
    }
    assert.deepEqual(searchCalls.map((c) => c.params.limit), ['10', '3']);
  });

  it('rejects a page size above the shared /search cap at the schema', () => {
    const h = harness();

    assert.throws(() => h.validate('find_show_by_publisher', { query: 'wondery', limit: 50 }));
    assert.doesNotThrow(() => h.validate('find_show_by_publisher', { query: 'wondery', limit: 10 }));
  });

  it('discloses a short scan instead of claiming a complete publisher census', async () => {
    const h = harness({ searchPage: { items: network, total: 120 } });

    const out = await h.invoke('find_show_by_publisher', { query: 'wondery' });
    const payload = out.structuredContent as {
      catalog_scanned: number;
      catalogue_total: number | null;
      scan_complete: boolean;
      search_limit: number;
      search_offset: number;
    };

    assert.equal(payload.catalog_scanned, 10);
    assert.equal(payload.catalogue_total, 120);
    assert.equal(payload.scan_complete, false);
    assert.equal(payload.search_limit, 10);
    assert.equal(payload.search_offset, 0);
    assert.match(out.content[0].text, /PARTIAL page/);
    assert.doesNotMatch(out.content[0].text, /complete page/);
    assert.match(out.content[0].text, /raise offset to scan deeper/);
  });

  it('calls the page complete only when the whole catalogue was scanned', async () => {
    const h = harness({ searchPage: { items: network.slice(0, 4), total: 4 } });

    const out = await h.invoke('find_show_by_publisher', { query: 'wondery', limit: 10, offset: 0 });
    const payload = out.structuredContent as { catalogue_total: number | null; scan_complete: boolean };

    assert.equal(payload.catalogue_total, 4);
    assert.equal(payload.scan_complete, true);
    assert.match(out.content[0].text, /4 of 4 catalogue row\(s\) examined/);
    assert.doesNotMatch(out.content[0].text, /PARTIAL page/);
  });

  it('refuses to call the scan complete when the envelope reports no total', async () => {
    const h = harness({ searchPage: { items: network.slice(0, 4) } });

    const out = await h.invoke('find_show_by_publisher', { query: 'wondery', limit: 10 });
    const payload = out.structuredContent as { catalogue_total: number | null; scan_complete: boolean };

    assert.equal(payload.catalogue_total, null);
    assert.equal(payload.scan_complete, false);
    assert.match(out.content[0].text, /UNVERIFIED/);
  });

  it('offsets into the catalogue when the caller pages', async () => {
    const page = Array.from({ length: 30 }, (_, i) => show(`p${i + 1}`, 'Wondery Network'));
    const h = harness({ searchPage: { items: page, total: 120 } });

    const out = await h.invoke('find_show_by_publisher', { query: 'wondery', limit: 10, offset: 20 });
    const payload = out.structuredContent as { catalog_scanned: number; search_offset: number; scan_complete: boolean };

    const searchCall = h.getCalls.find((c) => c.path === '/search');
    assert.equal(searchCall?.params.offset, '20');
    assert.equal(payload.search_offset, 20);
    assert.equal(payload.catalog_scanned, 10);
    assert.equal(payload.scan_complete, false);
    assert.match(out.content[0].text, /30 of 120 catalogue row\(s\) examined/);
  });

  it('counts examined rows the same way on every page, so the figure never goes backwards', async () => {
    const page = Array.from({ length: 25 }, (_, i) => show(`p${i + 1}`, 'Wondery Network'));
    const h = harness({ searchPage: { items: page, total: 25 } });
    const counts: number[] = [];
    const complete: boolean[] = [];

    for (const offset of [0, 10, 20]) {
      const out = await h.invoke('find_show_by_publisher', { query: 'wondery', limit: 10, offset });
      const text = out.content[0].text;
      const examined = Number(/Scan: (\d+) of 25 catalogue row\(s\) examined/.exec(text)?.[1]);
      counts.push(examined);
      const row = out.structuredContent as { scan_complete: boolean };
      complete.push(row.scan_complete);
      // A 5-row page at offset 20 must not report 5 of 25 examined.
      assert.notEqual(examined, 5, `offset ${offset} reported only this page's rows`);
    }

    // Paging deeper examines strictly more of the catalogue: 10, 20, then all 25.
    assert.deepEqual(counts, [10, 20, 25]);
    assert.deepEqual(complete, [false, false, true]);
    const last = await h.invoke('find_show_by_publisher', { query: 'wondery', limit: 10, offset: 20 });
    assert.match(last.content[0].text, /25 of 25 catalogue row\(s\) examined/);
    assert.match(last.content[0].text, /complete page/);
  });

  it('refuses to certify a complete scan when the offset pages past the catalogue', async () => {
    const page = Array.from({ length: 25 }, (_, i) => show(`p${i + 1}`, 'Wondery Network'));
    const h = harness({ searchPage: { items: page, total: 25 } });

    const out = await h.invoke('find_show_by_publisher', { query: 'wondery', limit: 10, offset: 100 });
    const payload = out.structuredContent as {
      catalog_scanned: number;
      catalogue_total: number | null;
      scan_complete: boolean;
    };

    // Zero rows examined is not a publisher census: scan_complete must be false
    // even though offset alone satisfies the bound.
    assert.equal(payload.catalog_scanned, 0);
    assert.equal(payload.catalogue_total, 25);
    assert.equal(payload.scan_complete, false);
    assert.match(out.content[0].text, /0 of 25 catalogue row\(s\) examined/);
    assert.match(out.content[0].text, /PARTIAL page/);
    assert.doesNotMatch(out.content[0].text, /complete page/);
    assert.match(out.content[0].text, /at or past the end of the 25-row catalogue/);
    assert.match(out.content[0].text, /reads as absent/);
  });
});

// #638 — the library check is answered through GET /me/library/contains, and
// every one of its callers turns that answer into a claim about the caller's
// own library: "saved", "not saved", "nothing to remove". A body that is not
// one boolean per requested URI cannot support any of those claims — it says
// nothing at all. So a malformed body must make the tool REJECT, and it must
// never reach a caller as "not saved" or "removed 0".
describe('library check is fail-closed on a malformed /me/library/contains body (#638)', () => {
  // Each shape is one a real response has taken: no body at all, a short array
  // (a truncated page), a non-boolean element, and an error envelope.
  const MALFORMED: Array<[label: string, body: unknown]> = [
    ['null body', null],
    ['short array', [true]],
    ['long array', [true, false, true, false]],
    ['non-boolean element', [true, 'yes', false]],
    ['error envelope', { error: { status: 403, message: 'Forbidden' } }],
  ];

  // `spotifyIdArray` rejects anything that is not a 22-character base62 id,
  // so these are spelled out at the real id width rather than shortened.
  const ids = ['ep00000000000000000001', 'ep00000000000000000002', 'ep00000000000000000003'];
  const shortIds = ['e1', 'e2', 'e3'];
  const showIds = ['sh00000000000000000001', 'sh00000000000000000002'];

  it('check_episode_saved rejects instead of reporting "0 of 3 saved"', async () => {
    for (const [label, body] of MALFORMED) {
      const h = harness({ containsBody: body });
      await assert.rejects(
        h.invoke('check_episode_saved', { episode_ids: ids }),
        /not one boolean per requested URI/,
        label,
      );
      // The old `contains?.[i] === true` returned a confident "0 of 3 saved"
      // for every one of these shapes; the number is the whole claim.
      assert.deepEqual(h.writes, [], label);
    }
  });

  it('remove_saved_episode rejects and removes nothing on an unreadable check', async () => {
    for (const [label, body] of MALFORMED) {
      for (const dryRun of [true, false]) {
        const h = harness({ containsBody: body });
        await assert.rejects(
          h.invoke('remove_saved_episode', { episode_ids: ids, dry_run: dryRun }),
          /not one boolean per requested URI/,
          `${label} (dry_run=${dryRun})`,
        );
        // The old `(contains ?? [])` read every id as not-saved, so the tool
        // reported "Removed 0 saved episode(s); skipped 3 not-saved id(s)" —
        // and on the commit path it had just told the caller the truth about
        // their own library was "none of these are in it".
        assert.deepEqual(h.writes, [], `${label} (dry_run=${dryRun}): nothing may be removed`);
      }
    }
  });

  it('remove_saved_episode dry run on a well-formed check still names what it would remove', async () => {
    // The control for the refusals above: a readable check is unaffected, so
    // the fail-closed assertions cannot be passing vacuously.
    const h = harness({ savedEpisodeIds: new Set([ids[0], ids[2]]) });
    const out = await h.invoke('remove_saved_episode', { episode_ids: ids, dry_run: true });
    const payload = out.structuredContent as { removable: string[]; not_saved: string[] };
    assert.deepEqual(payload.removable, [ids[0], ids[2]]);
    assert.deepEqual(payload.not_saved, [ids[1]]);
    assert.deepEqual(h.writes, []);
  });

  it('remove_saved_shows rejects on a malformed check rather than skipping every show', async () => {
    for (const [label, body] of MALFORMED) {
      const h = harness({ containsBody: body });
      await assert.rejects(
        h.invoke('remove_saved_shows', { show_ids: showIds, dry_run: false }),
        /not one boolean per requested URI/,
        label,
      );
      assert.deepEqual(h.writes, [], label);
    }
  });

  it('check_episode_saved still answers from a well-formed body of the right length', async () => {
    const h = harness({ savedEpisodeIds: new Set([ids[0], ids[2]]) });
    const out = await h.invoke('check_episode_saved', { episode_ids: ids });
    const payload = out.structuredContent as {
      results: Array<{ episode_id: string; saved: boolean }>;
      saved_count: number;
    };
    assert.deepEqual(payload.results, [
      { episode_id: ids[0], saved: true },
      { episode_id: ids[1], saved: false },
      { episode_id: ids[2], saved: true },
    ]);
    assert.equal(payload.saved_count, 2);
  });

  it('the listen-next brief reports a short check as unavailable, never as "not saved"', async () => {
    // `fetchSavedEpisodeIdSet` catches the throw and reports `library_checked:
    // false` rather than rejecting — the brief has a disclosed soft answer for
    // an unreadable leg, and that is the one it must use. A short array used
    // to be accepted (only `Array.isArray` was checked), which silently
    // narrowed the saved set and pushed un-read episodes into the queue.
    const fresh = show('s1', 'Network');
    const episodes = shortIds.map((id) =>
      episode(id, '2026-09-20', { fully_played: false, resume_position_ms: 0 }),
    );
    const h = harness({
      shows: [fresh],
      episodesByShow: { s1: episodes },
      containsBody: [true],
    });

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as {
      library_checked: boolean;
      unlistened: number;
      brief: Array<{ id: string; saved_in_library: boolean | null; unlistened: boolean }>;
    };

    assert.equal(payload.library_checked, false, 'a short body is not a readable check');
    assert.equal(payload.unlistened, 0, 'nothing may enter the listen-next queue on an unread check');
    assert.equal(payload.brief.length, 3);
    for (const row of payload.brief) {
      assert.equal(row.saved_in_library, null, `${row.id}: unknown, not "not saved"`);
      assert.equal(row.unlistened, false, row.id);
    }
    assert.match(out.content[0].text, /library check unavailable/);
  });
});

/**
 * #1508 — the show identity is not on an episode row.
 *
 * The `Episode` fixture at the top of this file already has no `show` member,
 * so every test below drives the real wire shape: `GET /shows/{id}/episodes`
 * returns `PagingSimplifiedEpisodeObject`, whose items are
 * `SimplifiedEpisodeObject` = `allOf: [EpisodeBase, { type: object }]`, and
 * `EpisodeBase` has no `show`. The old code read `e.show?.id ?? ''` and
 * `e.show?.name ?? '(unknown show)'` off that shape, so every value below was
 * the fabricated fallback, permanently, with nothing to fail.
 */
describe('episode rows carry the show the caller asked for, not a fabricated one (#1508)', () => {
  // `spotifyId()` validates 22 base62 characters, so the ids below are shaped
  // like real ones rather than the short labels the other suites use.
  const SHOW_ID = '4rOoJ6EgrbZ2Kyx2sUXZpA';
  const EPISODE_ID = '5Xt5DXGzch68nYYamXrNxZ';

  it('threads the caller show_id onto list_show_episodes rows and never claims an unknown show', async () => {
    const h = harness({
      episodesByShow: { [SHOW_ID]: [episode('e1', '2026-09-20'), episode('e2', '2026-09-19')] },
    });

    const out = await h.invoke('list_show_episodes', { show_id: SHOW_ID });
    const payload = out.structuredContent as {
      episodes: Array<{ id: string; showId: string | null; showName: string | null }>;
    };

    assert.equal(payload.episodes.length, 2);
    for (const row of payload.episodes) {
      assert.equal(row.showId, SHOW_ID, `${row.id}: the id the caller requested is known`);
      // #1508: never '' and never '(unknown show)'. null is the honest answer
      // for a field this endpoint does not carry.
      assert.equal(row.showName, null, `${row.id}: no show name was read, so none is claimed`);
      assert.notEqual(row.showName, '');
      assert.notEqual(row.showName, '(unknown show)');
    }
  });

  it('never prints "Latest episode of (unknown show):" from get_show_latest_episode', async () => {
    const h = harness({ episodesByShow: { [SHOW_ID]: [episode('e1', '2026-09-20')] } });

    const out = await h.invoke('get_show_latest_episode', { show_id: SHOW_ID });
    const text = out.content[0].text;

    assert.doesNotMatch(text, /unknown show/i, 'a value nobody read is not printed as one');
    assert.match(text, /Latest episode of show \w+:/, 'the id the caller supplied is the honest label');
    const payload = out.structuredContent as { episode: { showId: string | null; showName: string | null } };
    assert.equal(payload.episode.showId, SHOW_ID);
    assert.equal(payload.episode.showName, null);
  });

  it('labels cross-show rows with the shelf show name the walk already held', async () => {
    const alpha = show('alpha');
    const beta = show('beta');
    const h = harness({
      shows: [alpha, beta],
      episodesByShow: {
        alpha: [episode('a1', '2026-09-20')],
        beta: [episode('b1', '2026-09-20')],
      },
    });

    const out = await h.invoke('show_activity_feed', { eps_per_show: 1, max_shows: 2 });
    const payload = out.structuredContent as {
      episodes: Array<{ id: string; showId: string | null; showName: string | null }>;
    };
    const byId = new Map(payload.episodes.map((r) => [r.id, r]));

    // `/me/shows` returned the full SimplifiedShowObject, so both the id and
    // the name were already in hand — no second read, and no default.
    assert.equal(byId.get('a1')?.showId, 'alpha');
    assert.equal(byId.get('a1')?.showName, 'Show alpha');
    assert.equal(byId.get('b1')?.showId, 'beta');
    assert.equal(byId.get('b1')?.showName, 'Show beta');
    assert.doesNotMatch(out.content[0].text, /unknown show/i);
  });

  it('labels the backlog and the new-episode inbox from the shelf, not from the episode', async () => {
    const solo = show('solo');
    const h = harness({
      shows: [solo],
      episodesByShow: { solo: [episode('s1', '2026-09-20', { fully_played: false, resume_position_ms: 0 })] },
    });

    const backlog = await h.invoke('show_backlog_plan', { eps_per_show: 1, max_shows: 1 });
    const backlogRows = (backlog.structuredContent as { plan: Array<{ showName: string | null }> }).plan;
    assert.deepEqual(backlogRows.map((r) => r.showName), ['Show solo']);
    assert.doesNotMatch(backlog.content[0].text, /unknown show/i);

    const inbox = await h.invoke('get_newly_released_episodes', { since: '2026-09-01', max_shows: 1 });
    const inboxRows = (inbox.structuredContent as { episodes: Array<{ showName: string | null }> }).episodes;
    assert.deepEqual(inboxRows.map((r) => r.showName), ['Show solo']);
    assert.doesNotMatch(inbox.content[0].text, /unknown show/i);
  });

  it('reads the show off GET /episodes/{id}, the one shape that carries one', async () => {
    const h = harness({
      episodesById: {
        [EPISODE_ID]: {
          id: EPISODE_ID,
          name: 'Episode e1',
          uri: `spotify:episode:${EPISODE_ID}`,
          duration_ms: 1_800_000,
          release_date: '2026-09-20',
          explicit: false,
          description: 'desc',
          languages: ['en'],
          show: { id: SHOW_ID, name: 'The Real Show', uri: `spotify:show:${SHOW_ID}` },
        },
      },
    });

    const out = await h.invoke('get_episode_details', { episode_id: EPISODE_ID });
    const payload = out.structuredContent as { showId: string | null; showName: string | null };

    assert.equal(payload.showId, SHOW_ID);
    assert.equal(payload.showName, 'The Real Show');
    assert.match(out.content[0].text, /"Episode e1" \(The Real Show\)/);
  });

  it('reports a deleted show as absent rather than guessing, even on the full shape', async () => {
    const h = harness({
      episodesById: {
        [EPISODE_ID]: {
          id: EPISODE_ID,
          name: 'Episode e1',
          uri: `spotify:episode:${EPISODE_ID}`,
          duration_ms: 1_800_000,
          release_date: '2026-09-20',
          explicit: false,
          description: 'desc',
          languages: ['en'],
          // `EpisodeObject` requires `show`, but `SpotifyEpisodeRow` already
          // documents it arriving null for a deleted one — the type is a claim
          // about the wire, not a guarantee of it, so the read is defensive.
          show: null,
        },
      },
    });

    const out = await h.invoke('get_episode_details', { episode_id: EPISODE_ID });
    const payload = out.structuredContent as { showId: string | null; showName: string | null };

    assert.equal(payload.showId, null, 'a null show is disclosed, not defaulted');
    assert.equal(payload.showName, null);
    assert.doesNotMatch(out.content[0].text, /unknown show/i);
  });
});
