/**
 * `statsfm_recent_streams` named range buckets (#730).
 *
 * ## Why this test exists
 *
 * The bug this guards is not "the bucket computed the wrong edge". It is that
 * the bucket would have been a **header with no filter under it**.
 *
 * `/users/{id}/streams/recent` ignores the window parameters it is given.
 * Probed live 2026-09-27 against three public profiles (`rohan`, `spotify`,
 * `lars`), `?after=4102444800000` (the year 2100) and `?before=1000000000000`
 * (2001) each return the same rows as the unfiltered read — as do `limit=1`,
 * `limit=5` and `offset=100`, so the route is a fixed unpaged recent window.
 * The same probe confirms the bounds ARE honoured on `/users/{id}/streams`, on
 * `/users/{id}/top/*` and on the per-entity `/stats` aggregate, so this is a
 * per-route fact.
 *
 * So a tool that resolved `range: 'month'` to `after`/`before` and forwarded
 * them would have answered "streams this month" with the unfiltered page and a
 * confident header. Every assertion here is therefore about the rows that come
 * BACK, not about the parameters that go out.
 *
 * ## A second thing this pins: the two range vocabularies are not one enum
 *
 * The issue asked for `range` to be added to the *shared* ranking schema. That
 * cannot be done: `range` on the ranking tools is forwarded verbatim to a
 * stats.fm query parameter, and upstream answers
 * `400 {"message":"invalid range"}` for `year` (re-verified for this issue
 * alongside `years`, `12months`, `52weeks`, `all`, `allTime`, `since`). Putting
 * `year` in that enum would advertise a value that fails on every call, which
 * is the exact regression `statsfm-range-enum.test.ts` was written to prevent.
 * The buckets are therefore a separate vocabulary that is resolved locally.
 *
 * The expectations below are literal strings, never computed from the source's
 * own arrays — a test that recomputes its expectation from the enum it checks
 * passes whatever the enum becomes.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';

import { registerStatsfmTools } from '../src/tools/statsfm.js';

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean }; description?: string }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type Call = { path: string; params?: Record<string, string> };

function makeHarness(responder: (path: string, params?: Record<string, string>) => unknown) {
  const calls: Call[] = [];
  const client = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return responder(path, params);
    },
  };
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: RegisteredTool['schema'],
      handler: RegisteredTool['handler'],
    ) => registered.push({ name, description, schema, handler }),
  };
  registerStatsfmTools(
    server as unknown as Parameters<typeof registerStatsfmTools>[0],
    client as unknown as Parameters<typeof registerStatsfmTools>[1],
  );
  const find = (name: string) => {
    const t = registered.find((x) => x.name === name);
    assert.ok(t, `tool ${name} must be registered`);
    return t;
  };
  const text = (r: ToolContent) => r.content.map((c) => c.text).join('\n');
  return { calls, registered, find, text };
}

/** A fixed "now" for every window assertion: 2026-09-27T12:00:00.000Z. */
const NOW_ISO = '2026-09-27T12:00:00.000Z';
const NOW = Date.parse(NOW_ISO);

/**
 * Rows spanning every bucket edge, relative to NOW:
 *   prev-year  2025-12-31T23:59:59Z   outside `year`
 *   jan-1      2026-01-01T00:00:00Z   the first instant of `year` (inclusive)
 *   sep-1      2026-09-01T00:00:00Z   the first instant of `month`
 *   sun-27     2026-09-27T09:00:00Z   a Sunday, i.e. the day before the ISO week
 *   mon-28     2026-09-28T00:00:00Z   the first instant of the ISO week (future vs NOW)
 *   today      2026-09-27T00:00:00Z   the first instant of `today`
 *   older      2026-09-26T23:00:00Z   yesterday — outside `today`
 *   no-time    (no readable endTime)
 */
function mixedFixture() {
  const row = (id: string, endTime: string) => ({
    id,
    endTime,
    playedMs: 200000,
    trackId: 1,
    trackName: `track-${id}`,
    albumId: 9,
    artistIds: [1],
  });
  return {
    items: [
      row('prev-year', '2025-12-31T23:59:59.000Z'),
      row('jan-1', '2026-01-01T00:00:00.000Z'),
      row('sep-1', '2026-09-01T00:00:00.000Z'),
      row('today', '2026-09-27T00:00:00.000Z'),
      row('older', '2026-09-26T23:00:00.000Z'),
      row('yesterday-noon', '2026-09-26T12:00:00.000Z'),
      { id: 'no-time', playedMs: 1000, trackId: 2, trackName: 'track-no-time', artistIds: [] },
    ],
  };
}

/** Track names in the order the tool rendered them. */
function titles(out: ToolContent): string[] {
  const list = (out.structuredContent?.items ?? []) as Array<{ trackName?: string }>;
  return list.map((r) => r.trackName ?? '');
}

/** Run a call with the clock pinned, restoring it afterwards. */
async function withClock<T>(at: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => at;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

// ------------------------------------------------------------------ schema

test('statsfm_recent_streams declares the range bucket parameter', () => {
  const h = makeHarness(() => ({ items: [] }));
  const tool = h.find('statsfm_recent_streams');
  assert.ok(
    tool.schema.range,
    'statsfm_recent_streams must declare `range` (#730 asks for named buckets)',
  );
  for (const value of ['today', 'week', 'month', 'year', 'lifetime']) {
    assert.equal(
      tool.schema.range.safeParse(value).success,
      true,
      `range "${value}" must be accepted`,
    );
  }
  assert.equal(tool.schema.range.safeParse(undefined).success, true, 'range must stay optional');
  for (const value of ['weeks', 'months']) {
    assert.equal(
      tool.schema.range.safeParse(value).success,
      false,
      `range "${value}" is the upstream RANKING vocabulary, not this tool's — it must be rejected here`,
    );
  }
});

test('the range parameter description names every accepted value', () => {
  const h = makeHarness(() => ({ items: [] }));
  const description = h.find('statsfm_recent_streams').schema.range.description ?? '';
  for (const value of ['today', 'week', 'month', 'year', 'lifetime']) {
    assert.match(
      description,
      new RegExp(value),
      `the range parameter description must name "${value}" — a host surfaces this, not the enum`,
    );
  }
  assert.match(description, /after/, 'the description must state that an explicit bound wins');
});

test('the bucket vocabulary is not the upstream ranking vocabulary', () => {
  // The regression this pins is a *shared* enum: `year` upstream is a 400, and
  // `weeks`/`months` are rolling upstream windows with no local meaning. Each
  // list must reject the other's members.
  const h = makeHarness(() => ({ items: [] }));
  const range = h.find('statsfm_recent_streams').schema.range;
  for (const value of ['weeks', 'months', 'all-time', '6months']) {
    assert.equal(
      range.safeParse(value).success,
      false,
      `recent_streams range must reject "${value}"`,
    );
  }
  // And the ranking tools must not have grown the bucket values.
  for (const name of ['statsfm_top_tracks', 'statsfm_top_artists', 'statsfm_top_albums', 'statsfm_top_genres']) {
    const schema = h.find(name).schema.range;
    assert.ok(schema, `${name} must declare range`);
    for (const value of ['today', 'year']) {
      assert.equal(
        schema.safeParse(value).success,
        false,
        `${name} forwards range to stats.fm, which answers 400 invalid range for "${value}"`,
      );
    }
  }
});

// ---------------------------------------------------------------- filtering

test('range: month keeps only rows inside the current UTC month', async () => {
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'month', response_format: 'json' }),
  );
  const resolved = out.structuredContent?.range_resolved as { after: string; timezone: string; applied: string };
  assert.equal(resolved.after, '2026-09-01T00:00:00.000Z', 'month must resolve to the 1st at 00:00 UTC');
  assert.equal(resolved.timezone, 'UTC');
  assert.equal(resolved.applied, 'range');
  assert.deepEqual(
    titles(out).sort(),
    ['track-older', 'track-sep-1', 'track-today', 'track-yesterday-noon'].sort(),
    'only the September rows may survive a month bucket',
  );
  assert.equal(
    out.structuredContent?.unreadable_timestamps,
    1,
    'the row with no readable time is excluded from the window, not counted into it',
  );
});

test('the bucket is enforced in the rows, not merely announced', async () => {
  // The load-bearing assertion. A tool that forwarded the window upstream and
  // trusted the response would return every row here — the fixture is built so
  // that "announced a month but returned all seven" is the obvious failure.
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'month', response_format: 'json' }),
  );
  const returned = out.structuredContent?.items as unknown[];
  assert.equal(returned.length, 4, 'a month bucket must drop the January and December rows');
  assert.equal(
    (out.structuredContent?.returned_before_window as number),
    7,
    'the pre-window count must report what stats.fm actually returned',
  );
  assert.ok(
    (out.structuredContent?.excluded_by_window as number) >= 2,
    'excluded rows must be counted, not silently dropped',
  );
});

test('range: today resolves to 00:00 UTC of the current day', async () => {
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'today', response_format: 'json' }),
  );
  const resolved = out.structuredContent?.range_resolved as { after: string };
  assert.equal(resolved.after, '2026-09-27T00:00:00.000Z');
  assert.deepEqual(
    titles(out),
    ['track-today'],
    'only rows at or after midnight UTC today may survive',
  );
});

test('range: week resolves to Monday 00:00 UTC (ISO week start)', async () => {
  // 2026-09-27 is a Sunday, so the ISO week containing it began Mon 2026-09-21.
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'week', response_format: 'json' }),
  );
  const resolved = out.structuredContent?.range_resolved as { after: string };
  assert.equal(resolved.after, '2026-09-21T00:00:00.000Z', 'week must start on Monday, not Sunday');
});

test('range: year resolves to 1 January 00:00 UTC and is inclusive', async () => {
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'year', response_format: 'json' }),
  );
  const resolved = out.structuredContent?.range_resolved as { after: string };
  assert.equal(resolved.after, '2026-01-01T00:00:00.000Z');
  assert.ok(
    titles(out).includes('track-jan-1'),
    'the first instant of the year is inside the year bucket (lower bound inclusive)',
  );
  assert.ok(
    !titles(out).includes('track-prev-year'),
    'the last instant of the previous year is outside',
  );
});

test('range: lifetime applies no window at all', async () => {
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'lifetime', response_format: 'json' }),
  );
  const resolved = out.structuredContent?.range_resolved as { after: string | null; before: string | null; applied: string };
  assert.equal(resolved.after, null);
  assert.equal(resolved.before, null);
  assert.equal(resolved.applied, 'unbounded');
  assert.equal((out.structuredContent?.items as unknown[]).length, 7, 'lifetime must not filter');
});

// --------------------------------------------------------------- precedence

test('an explicit after/before wins over range', async () => {
  // The issue's second acceptance criterion, asserted with both supplied.
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({
      user_id: 'u',
      range: 'month',
      after: Date.parse('2026-09-26T00:00:00.000Z'),
      before: Date.parse('2026-09-27T00:00:00.000Z'),
      response_format: 'json',
    }),
  );
  const resolved = out.structuredContent?.range_resolved as { after: string; before: string; applied: string; requested: string };
  assert.equal(resolved.applied, 'explicit', 'the explicit bound must be recorded as the one applied');
  assert.equal(resolved.requested, 'month', 'the requested bucket is still echoed');
  assert.equal(resolved.after, '2026-09-26T00:00:00.000Z', 'the explicit bound must not be replaced by the bucket edge');
  assert.equal(resolved.before, '2026-09-27T00:00:00.000Z');
  assert.deepEqual(
    titles(out),
    ['track-older', 'track-yesterday-noon'].sort(),
    'only rows inside the explicit window may survive',
  );
});

test('a bucket still supplies the edge the caller left open', async () => {
  // `range` alongside ONE explicit bound is a real combination, not a
  // contradiction: "this month, up to that instant".
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({
      user_id: 'u',
      range: 'month',
      before: Date.parse('2026-09-27T00:00:00.000Z'),
      response_format: 'json',
    }),
  );
  const resolved = out.structuredContent?.range_resolved as { after: string; before: string };
  assert.equal(resolved.after, '2026-09-01T00:00:00.000Z', 'the bucket supplies the open lower edge');
  assert.equal(resolved.before, '2026-09-27T00:00:00.000Z', 'the explicit upper edge is kept');
  assert.ok(
    !titles(out).includes('track-today'),
    'the row at the excluded upper edge must be filtered out',
  );
});

test('explicit bounds are still forwarded upstream and are honoured locally', async () => {
  // The wire behaviour is unchanged (a stats.fm that later honours them must
  // not be double-filtered into an empty result), and the local filter is what
  // makes them true today.
  const h = makeHarness(() => mixedFixture());
  await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({
      user_id: 'u',
      after: Date.parse('2026-09-26T00:00:00.000Z'),
      before: Date.parse('2026-09-27T00:00:00.000Z'),
    }),
  );
  const call = h.calls.at(-1);
  assert.equal(call?.params?.after, String(Date.parse('2026-09-26T00:00:00.000Z')));
  assert.equal(call?.params?.before, String(Date.parse('2026-09-27T00:00:00.000Z')));
});

// ------------------------------------------------------------------ honesty

test('a row with no readable time is excluded and counted, never guessed', async () => {
  // AGENTS.md §6: a value the API could contradict the declared type of must
  // fall back to something that cannot itself be wrong. A row whose time is
  // unreadable cannot be placed in a window, so it is reported — not silently
  // counted in and not silently dropped.
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'year', response_format: 'json' }),
  );
  assert.equal(out.structuredContent?.unreadable_timestamps, 1, 'the unreadable row must be counted');
  assert.ok(
    !titles(out).includes('track-no-time'),
    'an unreadable row must not be reported as inside the window',
  );
});

test('the window does not claim to cover history the page cannot have', async () => {
  // `/streams/recent` returns a fixed recent page. A `year` bucket over a page
  // spanning two days has not measured a year, and the payload has to say so
  // rather than let "range: year" imply a complete answer.
  //
  // This needs its own fixture: `mixedFixture` starts in December 2025, so its
  // page DOES reach back past 1 January and there is no shortfall to report.
  // The case is a page that is entirely inside the requested window.
  const h = makeHarness(() => ({
    items: [
      { id: 'a', endTime: '2026-09-26T23:00:00.000Z', playedMs: 1000, trackId: 1, trackName: 'track-a', artistIds: [] },
      { id: 'b', endTime: '2026-09-27T09:00:00.000Z', playedMs: 1000, trackId: 1, trackName: 'track-b', artistIds: [] },
    ],
  }));
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'year', response_format: 'json' }),
  );
  assert.equal(out.structuredContent?.page_may_not_cover_window, true);
  assert.equal(out.structuredContent?.page_oldest, '2026-09-26T23:00:00.000Z');
  assert.equal(out.structuredContent?.page_newest, '2026-09-27T09:00:00.000Z');
  assert.deepEqual(titles(out), ['track-a', 'track-b'], 'both rows are inside the year');

  const prose = h.text(await withClock(NOW, () => h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'year' })));
  assert.match(
    prose,
    /not a full count for the window/,
    'the shortfall must be stated in prose too, not only in the payload',
  );
});

test('a page that reaches back past the window start does not claim a shortfall', async () => {
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'month', response_format: 'json' }),
  );
  assert.equal(
    out.structuredContent?.page_may_not_cover_window,
    false,
    'the fixture page starts in December, so it does reach back past 1 September',
  );
});

test('the resolved window is echoed in prose as well as in the payload', async () => {
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({ user_id: 'u', range: 'month' }),
  );
  const text = h.text(out);
  assert.match(text, /2026-09-01T00:00:00\.000Z/, 'prose must name the applied lower edge');
  assert.match(text, /UTC/, 'prose must state the timezone rule');
  assert.match(text, /Window: month/, 'prose must name the bucket that was applied');
});

test('an unmatched window is reported as no results, not as an error', async () => {
  const h = makeHarness(() => mixedFixture());
  const out = await withClock(NOW, () =>
    h.find('statsfm_recent_streams').handler({
      user_id: 'u',
      after: Date.parse('2030-01-01T00:00:00.000Z'),
      response_format: 'json',
    }),
  );
  assert.deepEqual(out.structuredContent?.items, [], 'a window matching nothing is an empty list');
  assert.equal(out.structuredContent?.returned_before_window, 7, 'the page still arrived intact');
  assert.ok(
    (out.structuredContent?.excluded_by_window as number) > 0,
    'every row is excluded by a future lower bound, and that is counted',
  );
});
