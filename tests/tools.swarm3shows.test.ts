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
}

function show(id: string, publisher = 'Publisher'): Show {
  return {
    id,
    name: `Show ${id}`,
    publisher,
    total_episodes: 100,
  };
}

function episode(showItem: Show, id: string, releaseDate: string): Episode {
  return {
    id,
    name: `Episode ${id}`,
    uri: `spotify:episode:${id}`,
    duration_ms: 1_800_000,
    release_date: releaseDate,
    show: showItem,
  };
}

function harness(options: {
  shows?: Show[];
  episodesByShow?: Record<string, Episode[]>;
  failingShowIds?: ReadonlySet<string>;
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
  const episodeRequests: string[] = [];
  const shelfRequests: string[] = [];
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
