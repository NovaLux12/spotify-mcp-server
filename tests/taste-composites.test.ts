import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerTasteCompositeTools,
  __setTasteCompositeFetchImpl,
  __resetTasteCompositeFetchImpl,
} from '../src/tools/taste_composites.js';

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

function streamRow(trackId: string, trackName: string, artist: string, iso: string) {
  return {
    track: { id: trackId, name: trackName, artists: [{ name: artist }] },
    playedAt: iso,
  };
}

const EXPECTED = [
  'taste_to_playlist',
  'taste_daily_brief',
  'taste_era_playlist',
  'taste_forgotten_bangers',
  'taste_obsession_ladder',
  'taste_diamond_rotation',
  'taste_weekly_recap',
  'taste_genre_bridge',
  'taste_novelty_loyalty',
  'taste_listening_clock',
  'taste_revival_queue',
];

function installFixtures() {
  __setTasteCompositeFetchImpl(async (url: string) => {
    if (url.includes('/top/artists')) {
      return {
        items: [
          { id: 'a1', name: 'Core Band', streams: 120 },
          { id: 'a2', name: 'Second Act', streams: 60 },
          { id: 'a3', name: 'Third Wheel', streams: 30 },
          { id: 'a4', name: 'Dormant Star', streams: 25 },
          { id: 'a5', name: 'Old Flame', streams: 20 },
          { id: 'a6', name: 'Deep Diver', streams: 15 },
          { id: 'a7', name: 'Side Quest', streams: 12 },
          { id: 'a8', name: 'Faint Echo', streams: 10 },
          { id: 'a9', name: 'Riser', streams: 8 },
          { id: 'a10', name: 'Sleeper', streams: 6 },
          { id: 'a11', name: 'Ghost Note', streams: 5 },
          { id: 'a12', name: 'Late Bloomer', streams: 4 },
        ],
      };
    }
    if (url.includes('/top/genres')) {
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
    if (url.includes('/top/tracks')) {
      const items = [];
      const core: Array<[string, string, string, number]> = [
        ['t1', 'Hit Single', 'Core Band', 90],
        ['t2', 'Deep Cut', 'Second Act', 40],
        ['t3', 'Lost Classic', 'Dormant Star', 35],
      ];
      for (const [id, name, artist, streams] of core) {
        items.push({
          id,
          name,
          streams,
          track: { id, name, artists: [{ name: artist }] },
          externalIds: { spotify: [`spotify:track:${id}`] },
        });
      }
      // Mid-tier filler ranks 4..60 for diamond mining.
      for (let i = 4; i <= 60; i++) {
        items.push({
          id: `tm${i}`,
          name: `Mid Cut ${i}`,
          streams: 60 - i,
          track: { id: `tm${i}`, name: `Mid Cut ${i}`, artists: [{ name: 'Third Wheel' }] },
        });
      }
      return { items };
    }
    if (url.includes('/streams')) {
      return {
        items: [
          streamRow('t1', 'Hit Single', 'Core Band', '2026-09-06T08:00:00Z'),
          streamRow('t1', 'Hit Single', 'Core Band', '2026-09-06T08:04:00Z'),
          streamRow('t9', 'New Thing', 'Fresh Face', '2026-09-06T20:00:00Z'),
          streamRow('t2', 'Deep Cut', 'Second Act', '2026-09-05T09:00:00Z'),
          streamRow('t1', 'Hit Single', 'Core Band', '2026-08-10T10:00:00Z'),
          streamRow('t2', 'Deep Cut', 'Second Act', '2026-07-05T10:00:00Z'),
          streamRow('t5', 'Spring Song', 'Core Band', '2026-03-05T10:00:00Z'),
        ],
      };
    }
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
  registerTasteCompositeTools(
    server as unknown as Parameters<typeof registerTasteCompositeTools>[0],
    {} as unknown as Parameters<typeof registerTasteCompositeTools>[1],
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
});

test.afterEach(() => {
  __resetTasteCompositeFetchImpl();
});

// --------------------------------------------------------------- registry

test('registers all 11 composite tools', () => {
  const { registered } = makeHarness();
  for (const name of EXPECTED) {
    assert.ok(registered.some((t) => t.name === name), `missing ${name}`);
  }
  assert.equal(registered.length, 11);
});

// ------------------------------------------------------- 1. taste_to_playlist

test('taste_to_playlist emits a DRY RUN list with fallback guidance', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_to_playlist'), {
    statsfm_user: 'demo',
    track_count: 6,
  });
  const out = text(result);
  assert.match(out, /DRY RUN/);
  assert.match(out, /Hit Single/);
  assert.match(out, /externalIds\.spotify/);
  const sc = result.structuredContent as { picks: unknown[]; dryRun: boolean };
  assert.equal(sc.dryRun, true);
  assert.ok(sc.picks.length > 0);
});

// -------------------------------------------------------- 2. taste_daily_brief

test('taste_daily_brief reports top3 + revivals + novelty', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_daily_brief'), {
    statsfm_user: 'demo',
    date: '2026-09-06',
  });
  const out = text(result);
  assert.match(out, /Daily brief for demo — 2026-09-06/);
  assert.match(out, /Top 3:/);
  assert.match(out, /Revivals:/);
  assert.match(out, /Novelty share:/);
});

// -------------------------------------------------------- 3. taste_era_playlist

test('taste_era_playlist renders an era window with tracks', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_era_playlist'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Era playlist for demo/);
  assert.match(out, /signature/);
});

test('taste_era_playlist rejects an out-of-range era', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_era_playlist'), {
    statsfm_user: 'demo',
    era_index: 99,
  });
  assert.match(text(result), /out of range/);
});

// --------------------------------------------------- 4. taste_forgotten_bangers

test('taste_forgotten_bangers surfaces a revival pick', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_forgotten_bangers'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Forgotten bangers for demo/);
  assert.match(out, /Revival pick/);
});

// --------------------------------------------------- 5. taste_obsession_ladder

test('taste_obsession_ladder ranks artists with tiers', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_obsession_ladder'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Obsession ladder for demo/);
  assert.match(out, /Core Band/);
  assert.match(out, /\[favorite\]/);
});

// --------------------------------------------------- 6. taste_diamond_rotation

test('taste_diamond_rotation lists mid-tier deep cuts', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_diamond_rotation'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Diamond rotation for demo/);
  assert.match(out, /Mid Cut/);
});

// -------------------------------------------------------- 7. taste_weekly_recap

test('taste_weekly_recap summarizes a wide window', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_weekly_recap'), {
    statsfm_user: 'demo',
    days: 900,
  });
  const out = text(result);
  assert.match(out, /Weekly recap for demo/);
  assert.match(out, /Busiest day:/);
});

// -------------------------------------------------------- 8. taste_genre_bridge

test('taste_genre_bridge spans two genres with evidence', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_genre_bridge'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Genre bridge for demo/);
  assert.match(out, /indie rock/);
});

// ----------------------------------------------------- 9. taste_novelty_loyalty

test('taste_novelty_loyalty reports a verdict', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_novelty_loyalty'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Novelty vs loyalty for demo/);
  assert.match(out, /Verdict: (comfort|balanced|explorer)/);
});

// ----------------------------------------------------- 10. taste_listening_clock

test('taste_listening_clock reports day parts and a peak', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_listening_clock'), {
    statsfm_user: 'demo',
  });
  const out = text(result);
  assert.match(out, /Listening clock for demo/);
  assert.match(out, /peak:/);
  const sc = result.structuredContent as { dayParting: { peak: string } };
  assert.ok(['night', 'morning', 'afternoon', 'evening'].includes(sc.dayParting.peak));
});

// ------------------------------------------------------ 11. taste_revival_queue

test('taste_revival_queue builds an ordered queue', async () => {
  const { registered } = makeHarness();
  const result = await invoke(findTool(registered, 'taste_revival_queue'), {
    statsfm_user: 'demo',
    queue_size: 5,
  });
  const out = text(result);
  assert.match(out, /Revival queue for demo/);
});

// ------------------------------------------------------------------ empty data

test('composites degrade gracefully on empty data', async () => {
  __setTasteCompositeFetchImpl(async () => ({ items: [] }));
  const { registered } = makeHarness();
  for (const name of EXPECTED) {
    const result = await invoke(findTool(registered, name), { statsfm_user: 'demo' });
    assert.ok(text(result).length > 0, `${name} produced no output on empty data`);
  }
});
