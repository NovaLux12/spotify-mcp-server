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

interface Episode {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  release_date: string;
  show: Show;
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
  showItem: Show,
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
    show: showItem,
    ...(resumePoint ? { resume_point: resumePoint } : {}),
  };
}

function harness(options: {
  shows?: Show[];
  episodesByShow?: Record<string, Episode[]>;
  failingShowIds?: ReadonlySet<string>;
  searchPage?: { items: Show[]; total?: number };
  savedEpisodeIds?: ReadonlySet<string>;
  containsFails?: boolean;
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
      if (path === '/me/episodes/contains') {
        if (options.containsFails) throw new Error('library check unavailable');
        const ids = String(params?.ids ?? '').split(',');
        return ids.map((id) => savedEpisodeIds.has(id)) as T;
      }
      const match = /^\/shows\/([^/]+)\/episodes$/.exec(path);
      if (!match) return null;
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
  };

  registerSwarm3ShowsTools(fakeServer, client as unknown as SpotifyClient);
  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  return {
    byName,
    episodeRequests,
    shelfRequests,
    getCalls,
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
        daily: [episode(daily, 'feb', '2026-02-01'), episode(daily, 'jan', '2026-01-31')],
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
        leap: [episode(leapShow, 'march', '2024-03-01'), episode(leapShow, 'february', '2024-02-28')],
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
          episode(inboxShow, 'after', '2026-09-02'),
          episode(inboxShow, 'boundary', '2026-09-01'),
          episode(inboxShow, 'before', '2026-08-31'),
          episode(inboxShow, 'year-only', '2026'),
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
      episodesByShow: { good: [episode(good, 'ge', '2026-09-20')] },
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
    const h = briefHarness(episode(fresh, 'finished', '2026-09-20', {
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
    const h = briefHarness(episode(fresh, 'partial', '2026-09-20', {
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
    const h = briefHarness(episode(fresh, 'untouched', '2026-09-20', {
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
    const h = briefHarness(episode(fresh, 'no-resume', '2026-09-20'));

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

  it('reports an unreadable library check as unavailable rather than as not saved', async () => {
    const h = briefHarness(
      episode(fresh, 'unstarted', '2026-09-20', { fully_played: false, resume_position_ms: 0 }),
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
      episode(fresh, 'kept', '2026-09-20', { fully_played: false, resume_position_ms: 0 }),
      { savedEpisodeIds: ['kept'] },
    );

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload;

    assert.equal(payload.brief[0].saved_in_library, true);
    assert.equal(payload.brief[0].unlistened, false);
    assert.match(out.content[0].text, /\[saved, NEW — unplayed \(resume 0:00\)\]/);
  });

  it('discloses the library-leg request count instead of charging it silently', async () => {
    // 6 shows x 20 recent episodes each = 120 episode ids, which at 50 ids per
    // /me/episodes/contains request is 3 library calls on top of 6 show lookups.
    const many = Array.from({ length: 6 }, (_, i) => show(`s${i + 1}`, 'Network'));
    const episodesByShow = Object.fromEntries(
      many.map((s, i) => [
        s.id,
        Array.from({ length: 20 }, (_, j) =>
          episode(s, `e${i + 1}-${j + 1}`, '2026-09-20', { fully_played: false, resume_position_ms: 0 })),
      ]),
    );
    const h = harness({ shows: many, episodesByShow, savedEpisodeIds: new Set<string>() });

    const out = await h.invoke('show_recommendation_brief', { since: '2026-09-01' });
    const payload = out.structuredContent as BriefPayload & {
      shows_checked: number;
      new_episodes: number;
      library_requests: number;
    };

    const containsCalls = h.getCalls.filter((c) => c.path === '/me/episodes/contains');
    assert.equal(containsCalls.length, 3);
    assert.equal(payload.library_requests, 3);
    assert.equal(payload.shows_checked, 6);
    assert.equal(payload.new_episodes, 120);
    assert.match(out.content[0].text, /Quota: 6 show lookup\(s\) \+ 3 \/me\/episodes\/contains call\(s\)/);
    assert.match(out.content[0].text, /lower max_shows to cut the library leg/);
  });

  it('never derives episode state from the music recently-played feed', async () => {
    const h = briefHarness(episode(fresh, 'finished', '2026-09-20', {
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
      h.getCalls.some((c) => c.path === '/me/episodes/contains'),
      'library state comes from /me/episodes/contains',
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
});
