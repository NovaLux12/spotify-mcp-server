import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerStatsfmTasteTools,
  __setStatsfmFetchImpl,
  __resetStatsfmFetchImpl,
  __clearFeedbackEntries,
  classifyExposure,
  groupSessions,
  estimateHalfLifeDays,
  summarizeMonths,
  detectEras,
  summarizeDayParting,
  normalizeStreams,
  type TasteStream,
} from '../src/tools/statsfm_taste.js';

// ---------------------------------------------------------------- fixtures

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

function topArtists() {
  return {
    items: [
      { id: 'a1', name: 'Core Band', streams: 120 },
      { id: 'a2', name: 'Second Act', streams: 60 },
      { id: 'a3', name: 'Third Wheel', streams: 30 },
      { id: 'a4', name: 'Dormant Star', streams: 25 },
    ],
  };
}

function topGenres() {
  return {
    items: [
      { name: 'indie rock', count: 200 },
      { name: 'shoegaze', count: 120 },
      { name: 'ambient', count: 80 },
      { name: 'jazz', count: 20 },
      { name: 'krautrock', count: 10 },
    ],
  };
}

function topTracks() {
  return {
    items: [
      { id: 't1', name: 'Hit Single', streams: 90 },
      { id: 't2', name: 'Deep Cut', streams: 40 },
      { id: 't3', name: 'Lost Classic', streams: 35 },
    ],
  };
}

function streamRow(trackId: string, trackName: string, artist: string, iso: string) {
  return {
    track: { id: trackId, name: trackName, artists: [{ name: artist }] },
    playedAt: iso,
  };
}

function recentStreams() {
  return {
    items: [
      streamRow('t1', 'Hit Single', 'Core Band', '2026-09-01T08:00:00Z'),
      streamRow('t1', 'Hit Single', 'Core Band', '2026-09-01T08:04:00Z'),
      streamRow('t9', 'New Thing', 'Fresh Face', '2026-09-01T20:00:00Z'),
      streamRow('t2', 'Deep Cut', 'Second Act', '2026-09-02T09:00:00Z'),
    ],
  };
}

function installFixtures() {
  __setStatsfmFetchImpl(async (url: string) => {
    if (url.includes('/top/artists')) return topArtists();
    if (url.includes('/top/genres')) return topGenres();
    if (url.includes('/top/tracks')) return topTracks();
    if (url.includes('/streams')) return recentStreams();
    throw new Error(`unexpected stats.fm path: ${url}`);
  });
}

function makeHarness() {
  const registered: RegisteredTool[] = [];
  const server = {
    tool: (
      name: string,
      description: string,
      schema: RegisteredTool['schema'],
      handler: RegisteredTool['handler'],
    ) => registered.push({ name, description, schema, handler }),
  };
  registerStatsfmTasteTools(
    server as unknown as Parameters<typeof registerStatsfmTasteTools>[0],
    {} as unknown as Parameters<typeof registerStatsfmTasteTools>[1],
  );
  return { registered };
}

function findTool(registered: RegisteredTool[], name: string): RegisteredTool {
  const tool = registered.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

async function invoke(tool: RegisteredTool, args: Record<string, unknown> = {}) {
  return (tool.handler as (a: Record<string, unknown>) => Promise<ToolContent>)(args);
}

function text(result: ToolContent): string {
  return result.content.map((c) => c.text).join('\n');
}

test.beforeEach(() => {
  installFixtures();
  __clearFeedbackEntries();
});

test.afterEach(() => {
  __resetStatsfmFetchImpl();
  __clearFeedbackEntries();
});

// ------------------------------------------------------------------ registry

test('registers all 8 taste tools', () => {
  const { registered } = makeHarness();
  for (const name of [
    'taste_profile',
    'artist_affinity',
    'exposure_check',
    'listening_eras',
    'listening_sessions',
    'forgotten_favorites',
    'taste_recommendations',
    'record_feedback',
  ]) {
    assert.ok(registered.some((t) => t.name === name), `missing ${name}`);
  }
  assert.equal(registered.length, 8);
});

// ------------------------------------------------------------- taste_profile

test('taste_profile reports core artists, genres, loyalty/novelty, day-parting', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_profile'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Core Band \(120\)/);
  assert.match(out, /indie rock \(200\)/);
  assert.match(out, /loyalty \d+% top-5 \/ novelty \d+%/);
  assert.match(out, /Day-parting/);
  const sc = result.structuredContent as {
    loyaltyVsNovelty: { loyaltyShareTop5: number; recentNoveltyShare: number };
    dayParting: { peak: string };
  };
  assert.ok(sc.loyaltyVsNovelty.loyaltyShareTop5 > 0.8);
  assert.ok(['night', 'morning', 'afternoon', 'evening'].includes(sc.dayParting.peak));
});

test('taste_profile json mode returns raw payloads', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_profile'), {
    statsfm_user: 'demo',
    response_format: 'json',
  });
  const parsed = JSON.parse(text(result)) as Record<string, unknown>;
  assert.ok(parsed.topArtists);
  assert.ok(parsed.recentStreams);
});

// ------------------------------------------------------------ artist_affinity

test('artist_affinity computes intensity tier + half-life', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'artist_affinity'), {
    statsfm_user: 'demo',
    artist: 'Core Band',
  });
  const out = text(result);
  assert.match(out, /favorite/);
  assert.match(out, /half-life/);
  const sc = result.structuredContent as { tier: string; lifetimeStreams: number };
  assert.equal(sc.tier, 'favorite');
  assert.equal(sc.lifetimeStreams, 120);
});

test('artist_affinity reports unheard for unknown artists', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'artist_affinity'), {
    statsfm_user: 'demo',
    artist: 'Nobody Ever',
  });
  assert.match(text(result), /unheard/);
  assert.equal((result.structuredContent as { tier: string }).tier, 'unheard');
});

// ------------------------------------------------------------ exposure_check

test('exposure ladder thresholds classify correctly', () => {
  assert.equal(classifyExposure(0), 'unheard');
  assert.equal(classifyExposure(2), 'sampled');
  assert.equal(classifyExposure(9), 'explored');
  assert.equal(classifyExposure(49), 'established');
  assert.equal(classifyExposure(50), 'favorite');
});

test('exposure_check cites lifetime + recent evidence', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'exposure_check'), {
    statsfm_user: 'demo',
    subject: 'Dormant Star',
  });
  const out = text(result);
  assert.match(out, /established/);
  assert.match(out, /25 lifetime streams/);
});

// ------------------------------------------------------------ listening_eras

test('detectEras splits on top-artist turnover and volume shifts', () => {
  const eras = detectEras([
    { month: '2026-01', streams: 100, topArtist: 'A', uniqueArtists: 5 },
    { month: '2026-02', streams: 110, topArtist: 'A', uniqueArtists: 6 },
    { month: '2026-03', streams: 105, topArtist: 'B', uniqueArtists: 4 },
    { month: '2026-04', streams: 20, topArtist: 'B', uniqueArtists: 2 },
  ]);
  assert.equal(eras.length, 3);
  assert.equal(eras[0].startMonth, '2026-01');
  assert.equal(eras[0].endMonth, '2026-02');
  assert.equal(eras[1].signatureArtist, 'B');
  assert.equal(eras[0].boundaryReason, 'history start');
});

test('listening_eras renders era lines', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'listening_eras'), {
    statsfm_user: 'demo',
  });
  assert.match(text(result), /Listening eras for demo/);
});

// -------------------------------------------------------- listening_sessions

test('groupSessions splits on gaps larger than the threshold', () => {
  const base = Date.parse('2026-09-01T10:00:00Z');
  const mk = (name: string, offsetMin: number): TasteStream => ({
    trackId: name,
    trackName: name,
    artistNames: ['X'],
    playedAtMs: base + offsetMin * 60_000,
  });
  const sessions = groupSessions([mk('a', 0), mk('b', 10), mk('c', 60)], 30);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].streams, 2);
  assert.equal(sessions[1].streams, 1);
});

test('listening_sessions honors a custom gap', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'listening_sessions'), {
    statsfm_user: 'demo',
    gap_minutes: 30,
  });
  const out = text(result);
  assert.match(out, /sessions from 4 streams/);
  assert.equal(
    (result.structuredContent as { sessionCount: number }).sessionCount,
    3,
  );
});

// ------------------------------------------------------- forgotten_favorites

test('forgotten_favorites surfaces lifetime tops missing from recent', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'forgotten_favorites'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Lost Classic/);
  assert.match(out, /Revival pick/);
});

// ----------------------------------------------------- taste_recommendations

test('taste_recommendations emits bridges with evidence + risks', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_recommendations'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Bridge from indie rock/);
  assert.match(out, /Evidence:/);
  assert.match(out, /Risk:/);
  const sc = result.structuredContent as { coreGenres: string[] };
  assert.deepEqual(sc.coreGenres, ['indie rock', 'shoegaze', 'ambient']);
});

// ------------------------------------------------------------ record_feedback

test('record_feedback stores local-only verdicts and lists them', async () => {
  const { registered } = makeHarness();
  const tool = findTool(registered, 'record_feedback');
  const stored = await invoke(tool, {
    subject_type: 'artist',
    subject: 'Core Band',
    rating: 'love',
    note: 'peak era',
  });
  assert.match(text(stored), /Recorded #1: \[love\] artist:Core Band/);
  const listed = await invoke(tool, { action: 'list' });
  assert.match(text(listed), /#1 \[love\] artist:Core Band — peak era/);
});

test('record_feedback rejects record without required fields', async () => {
  const { registered } = makeHarness();
  await assert.rejects(
    invoke(findTool(registered, 'record_feedback'), { subject: 'X' }),
    /requires subject_type, subject, and rating/,
  );
});

// ------------------------------------------------------------------ pure bits

test('estimateHalfLifeDays follows median/ln2', () => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  const mk = (ageDays: number): TasteStream => ({
    trackId: 't',
    trackName: 't',
    artistNames: [],
    playedAtMs: now - ageDays * 86_400_000,
  });
  // median age 10d → 10/ln2 ≈ 14.4d
  assert.equal(estimateHalfLifeDays([mk(2), mk(10), mk(18)], now), 14.4);
  assert.equal(estimateHalfLifeDays([], now), null);
});

test('summarizeMonths rolls streams into month buckets', () => {
  const mk = (iso: string, artist: string): TasteStream => ({
    trackId: iso,
    trackName: iso,
    artistNames: [artist],
    playedAtMs: Date.parse(iso),
  });
  const months = summarizeMonths([
    mk('2026-01-05T00:00:00Z', 'A'),
    mk('2026-01-06T00:00:00Z', 'A'),
    mk('2026-02-01T00:00:00Z', 'B'),
  ]);
  assert.equal(months.length, 2);
  assert.equal(months[0].topArtist, 'A');
  assert.equal(months[0].streams, 2);
});

test('summarizeDayParting buckets UTC hours', () => {
  const mk = (iso: string): TasteStream => ({
    trackId: iso,
    trackName: iso,
    artistNames: [],
    playedAtMs: Date.parse(iso),
  });
  const parts = summarizeDayParting([
    mk('2026-09-01T02:00:00Z'),
    mk('2026-09-01T08:00:00Z'),
    mk('2026-09-01T14:00:00Z'),
    mk('2026-09-01T20:00:00Z'),
  ]);
  assert.deepEqual(parts, { night: 1, morning: 1, afternoon: 1, evening: 1 });
});

test('normalizeStreams drops undated rows and sorts ascending', () => {
  const rows = normalizeStreams({
    items: [
      { track: { id: 'b', name: 'B', artists: [{ name: 'X' }] }, playedAt: '2026-09-02T00:00:00Z' },
      { track: { id: 'a', name: 'A', artists: [{ name: 'X' }] }, playedAt: '2026-09-01T00:00:00Z' },
      { track: { id: 'z', name: 'Z' } },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.trackName),
    ['A', 'B'],
  );
});
