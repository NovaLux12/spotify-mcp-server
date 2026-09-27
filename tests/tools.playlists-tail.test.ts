/**
 * #881 — behaviour tests for the playlist tools that had NO test reference.
 *
 * Four of the tools in the slice were untested end to end:
 * `get_playlist_snapshot` had no test at all, and `compare_playlist_covers`
 * and `clone_playlist_cover` appeared only in schema/registry checks — the
 * kind of reference that proves a name exists, not that the handler does
 * anything right. `playlist_collab_toggle` and `check_playlist_following`
 * already had real suites (`tools.playlist-collab-gate`,
 * `tools.playlists-following`); they are registered here alongside the rest
 * of the slice, plus the two things those suites do not check — the exact
 * bytes `playlist_collab_toggle` PUTs, and `check_playlist_following`'s
 * render cap.
 *
 * Everything runs against `StatefulPlaylistClient`, so the cover routes and
 * the snapshot route are the same state the other playlist tools commit to.
 *
 * Run: node --import tsx --test tests/tools.playlists-tail.test.ts
 */

import './helpers/hermetic.js';

import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { StatefulPlaylistClient } from './helpers/stub-client.js';
import type { SeededPlaylist, StubCall } from './helpers/stub-client.js';

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

const A = 'A'.repeat(22);
const B = 'B'.repeat(22);

type ToolOut = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOut>;
}

interface Harness {
  stub: StatefulPlaylistClient;
  prompts: string[];
  registered: () => RegisteredTool[];
  invoke: (name: string, args?: Record<string, unknown>) => Promise<ToolOut>;
}

function harness(
  seed: Record<string, SeededPlaylist>,
  opts: { elicit?: unknown; canElicit?: boolean; stub?: StatefulPlaylistClient } = {},
): Harness {
  const { canElicit = true, elicit = { action: 'accept', content: { confirm: true } } } = opts;
  const registered: RegisteredTool[] = [];
  const prompts: string[] = [];
  const fakeServer = {
    tool(name: string, description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, description, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, config: { description?: string; inputSchema?: z.ZodType<Record<string, unknown>> }, handler: RegisteredTool['handler']) {
      registered.push({ name, description: config.description ?? '', validate: (a) => (config.inputSchema as z.ZodType<Record<string, unknown>>).parse(a), handler });
    },
    ...(canElicit
      ? {
          server: {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            async elicitInput(request: { message?: string }) {
              prompts.push(request?.message ?? '');
              if (elicit instanceof Error) throw elicit;
              return elicit;
            },
          },
        }
      : {}),
  } as unknown as McpServer;

  const stub = opts.stub ?? new StatefulPlaylistClient();
  for (const [id, seeded] of Object.entries(seed)) stub.seedPlaylist(id, seeded);
  registerPlaylistTools(fakeServer, stub as unknown as SpotifyClient);

  return {
    stub,
    prompts,
    registered: () => registered,
    invoke: async (name, args = {}) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: ToolOut) => out.content[0]?.text ?? '';
const sc = (out: ToolOut) => out.structuredContent ?? {};

const image = (url: string, width: number, height: number) => ({ url, width, height });

describe('#881 the whole slice is registered', () => {
  it('registers all thirteen tools with a description each', () => {
    const h = harness({ [A]: { rows: [] } });
    const byName = new Map(h.registered().map((t) => [t.name, t]));
    for (const name of [
      'playlist_sort',
      'playlist_shuffle',
      'playlist_reverse',
      'playlist_trim',
      'playlist_union',
      'playlist_subtract',
      'playlist_symmetric_difference',
      'playlist_collab_toggle',
      'check_playlist_following',
      'clone_playlist_cover',
      'compare_playlist_covers',
      'get_playlist_snapshot',
    ]) {
      const tool = byName.get(name);
      assert.ok(tool, `${name} should be registered by registerPlaylistTools`);
      assert.ok(tool.description.length > 20, `${name} should carry a real description`);
    }
  });
});

describe('#881 get_playlist_snapshot', () => {
  it('reports the snapshot id, the item count and the name, and writes nothing', async () => {
    const h = harness({ [A]: { rows: ['spotify:track:1', 'spotify:track:2', 'spotify:track:3'], name: 'Road Trip' } });
    try {
      const out = await h.invoke('get_playlist_snapshot', { playlist_id: A });

      // The count comes from the paged envelope's `total`, which the stateful
      // mock derives from the LIVE rows — a `limit: 1` page of a 3-row
      // playlist still says 3, and a tool that read `.items.length` would say 1.
      assert.equal(sc(out).total, 3);
      assert.equal(sc(out).name, 'Road Trip');
      assert.equal(sc(out).snapshot_id, 'snapshot-' + A + '-1');
      assert.match(textOf(out), /snapshot snapshot-/, 'the prose names the receipt, not just the count');
      assert.match(textOf(out), /3 item\(s\)/);

      const itemReads = h.stub.calls.filter((c: StubCall) => c.path === `/playlists/${A}/items`);
      assert.equal(itemReads.length, 1, 'one probe page, not a full walk');
      assert.equal(
        (itemReads[0]?.arg as Record<string, string>).limit,
        '1',
        'the count probe asks for one row and reads `total` — a walk here would burn the quota the description promises',
      );
      assert.deepEqual(
        h.stub.calls.filter((c) => c.method !== 'GET'),
        [],
        'a read-only tool must issue no write',
      );
    } finally {
      /* no session state to release */
    }
  });

  it('accepts a spotify:playlist: URI and normalises it to the bare id on the wire', async () => {
    const h = harness({ [A]: { rows: ['spotify:track:1'] } });
    try {
      const out = await h.invoke('get_playlist_snapshot', { playlist_id: `spotify:playlist:${A}` });
      assert.equal(sc(out).total, 1, 'a URI that was not normalised would have read an unseeded playlist and thrown');
      assert.equal(
        h.stub.calls.every((c) => !c.path.includes('spotify%3A')),
        true,
        'the id on the wire must be the bare id, not an encoded URI',
      );
    } finally {
      /* no session state to release */
    }
  });

  it('a playlist with no snapshot reports null, not a fabricated id', async () => {
    const h = harness({ [A]: { rows: ['spotify:track:1'], receiptReadable: false } });
    try {
      const out = await h.invoke('get_playlist_snapshot', { playlist_id: A });
      assert.equal(sc(out).snapshot_id, null, 'a null receipt must stay null all the way to the payload');
      assert.match(textOf(out), /snapshot none/, 'and the prose must say "none" rather than print an empty value');
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 compare_playlist_covers', () => {
  it('reports the same cover as the same one, with both dimensions', async () => {
    const shared = image('https://i.example/cover.jpg', 640, 640);
    const h = harness({
      [A]: { rows: [], images: [shared] },
      [B]: { rows: [], images: [shared] },
    });
    try {
      const out = await h.invoke('compare_playlist_covers', { playlist_a: A, playlist_b: B });
      assert.equal(sc(out).same, true);
      assert.equal((sc(out).a as { width: number }).width, 640);
      assert.match(textOf(out), /Same: yes/);
      assert.match(textOf(out), /640x640/);
    } finally {
      /* no session state to release */
    }
  });

  it('two different covers are not the same cover', async () => {
    const h = harness({
      [A]: { rows: [], images: [image('https://i.example/a.jpg', 300, 300)] },
      [B]: { rows: [], images: [image('https://i.example/b.jpg', 300, 300)] },
    });
    try {
      const out = await h.invoke('compare_playlist_covers', { playlist_a: A, playlist_b: B });
      assert.equal(sc(out).same, false, 'identical dimensions are not an identical cover');
      assert.match(textOf(out), /Same: no/);
    } finally {
      /* no session state to release */
    }
  });

  it('a mosaic playlist reads as "no custom cover", not as a broken comparison', async () => {
    const h = harness({ [A]: { rows: [], images: [] }, [B]: { rows: [], images: [image('https://i.example/b.jpg', 300, 300)] } });
    try {
      const out = await h.invoke('compare_playlist_covers', { playlist_a: A, playlist_b: B });
      assert.equal(sc(out).a_has_custom, false);
      assert.equal(sc(out).a, null);
      assert.equal(sc(out).same, false, 'a missing cover is not the other playlist\'s cover');
      assert.match(textOf(out), /A \(.+?\): no custom cover \(mosaic\)/);
    } finally {
      /* no session state to release */
    }
  });

  it('json output carries the same verdict the prose does', async () => {
    const shared = image('https://i.example/cover.jpg', 640, 640);
    const h = harness({ [A]: { rows: [], images: [shared] }, [B]: { rows: [], images: [shared] } });
    try {
      const out = await h.invoke('compare_playlist_covers', { playlist_a: A, playlist_b: B, response_format: 'json' });
      const parsed = JSON.parse(textOf(out)) as { same: boolean; a: { url: string } };
      assert.equal(parsed.same, true);
      assert.equal(parsed.a.url, shared.url);
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 clone_playlist_cover', () => {
  /** JPEG SOI + APP0 — the smallest plausible body the validator accepts. */
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x46, 0x46]);
  const originalFetch = globalThis.fetch;

  const withFetch = (body: Buffer, contentType: string) => {
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { 'content-type': contentType } })) as unknown as typeof globalThis.fetch;
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('PUTs the base64 of the fetched JPEG to the target image route', async () => {
    withFetch(JPEG, 'image/jpeg');
    const h = harness({
      [A]: { rows: [], images: [image('https://i.example/source.jpg', 640, 640)] },
      [B]: { rows: [] },
    });
    try {
      const out = await h.invoke('clone_playlist_cover', { source_playlist_id: A, target_playlist_id: B });

      const upload = h.stub.coverUploads.get(`/playlists/${B}/images`);
      assert.equal(typeof upload, 'string', 'a clone that sent nothing left the target with no cover');
      assert.equal(Buffer.from(upload as string, 'base64').toString('hex'), JPEG.toString('hex'), 'the uploaded bytes must be the image that was fetched, unmodified');
      assert.match(textOf(out), /Cloned cover from/);
      assert.match(textOf(out), new RegExp(`→ ${B}`));
      // The read is on the SOURCE; the write is on the TARGET.
      assert.deepEqual(
        h.stub.calls.map((c) => c.method + ' ' + c.path),
        [`GET /playlists/${A}/images`, `PUT_RAW /playlists/${B}/images`],
        'a clone that read the target, or wrote the source, would pass a weaker assertion',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('image_index picks which cover is copied', async () => {
    withFetch(JPEG, 'image/jpeg');
    const h = harness({
      [A]: { rows: [], images: [image('https://i.example/first.jpg', 640, 640), image('https://i.example/second.jpg', 64, 64)] },
      [B]: { rows: [] },
    });
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof globalThis.fetch;
    try {
      await h.invoke('clone_playlist_cover', { source_playlist_id: A, target_playlist_id: B, image_index: 1 });
      assert.deepEqual(seen, ['https://i.example/second.jpg'], 'image_index 1 is the second cover, not the first');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('a dry run fetches nothing and uploads nothing', async () => {
    const h = harness({
      [A]: { rows: [], images: [image('https://i.example/source.jpg', 640, 640)] },
      [B]: { rows: [] },
    });
    try {
      const out = await h.invoke('clone_playlist_cover', {
        source_playlist_id: A,
        target_playlist_id: B,
        dry_run: true,
      });
      assert.match(textOf(out), /\[dry run\]/);
      assert.match(textOf(out), /https:\/\/i\.example\/source\.jpg/);
      assert.equal(h.stub.coverUploads.size, 0, 'a dry run must not upload a cover');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('a source with no custom cover fails before any upload', async () => {
    const h = harness({ [A]: { rows: [], images: [] }, [B]: { rows: [] } });
    try {
      await assert.rejects(
        () => h.invoke('clone_playlist_cover', { source_playlist_id: A, target_playlist_id: B }),
        /no custom cover image/,
      );
      assert.equal(h.stub.coverUploads.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('an out-of-range image_index is refused, and names the range', async () => {
    const h = harness({
      [A]: { rows: [], images: [image('https://i.example/only.jpg', 640, 640)] },
      [B]: { rows: [] },
    });
    try {
      await assert.rejects(
        () => h.invoke('clone_playlist_cover', { source_playlist_id: A, target_playlist_id: B, image_index: 5 }),
        /image_index 5 out of range \(1 image\(s\)\)/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('a non-JPEG body is rejected and nothing is uploaded', async () => {
    // The upload is the whole point of the tool, so a body that is not a JPEG
    // must not reach it — and the cover must not be silently replaced with
    // garbage that only fails when Spotify renders it.
    withFetch(Buffer.from('not a jpeg at all'), 'image/jpeg');
    const h = harness({
      [A]: { rows: [], images: [image('https://i.example/source.jpg', 640, 640)] },
      [B]: { rows: [] },
    });
    try {
      await assert.rejects(
        () => h.invoke('clone_playlist_cover', { source_playlist_id: A, target_playlist_id: B }),
        /magic bytes/i,
      );
      assert.equal(h.stub.coverUploads.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('#881 playlist_collab_toggle — the bytes it PUTs', () => {
  it('sends only the flag that was asked for', async () => {
    const h = harness({ [A]: { rows: [], public: false, collaborative: false } });
    try {
      await h.invoke('playlist_collab_toggle', { playlist_id: A, public: false });
      const put = h.stub.calls.find((c) => c.method === 'PUT' && c.path === `/playlists/${A}`);
      assert.deepEqual(put?.arg, { public: false }, 'sending both flags would clear a flag the caller never named');
    } finally {
      /* no session state to release */
    }
  });

  it('carries both flags when both are named', async () => {
    const h = harness({ [A]: { rows: [], public: false, collaborative: false } });
    try {
      await h.invoke('playlist_collab_toggle', { playlist_id: A, public: false, collaborative: true });
      const put = h.stub.calls.find((c) => c.method === 'PUT' && c.path === `/playlists/${A}`);
      assert.deepEqual(put?.arg, { collaborative: true, public: false });
      assert.equal(h.prompts.length, 1, 'collaborative false→true is a toward-visible flip, so the gate must fire');
    } finally {
      /* no session state to release */
    }
  });

  it('refuses public:true + collaborative:true before any request', async () => {
    const h = harness({ [A]: { rows: [], public: false, collaborative: false } });
    try {
      await assert.rejects(
        () => h.invoke('playlist_collab_toggle', { playlist_id: A, public: true, collaborative: true }),
        /cannot be both public and collaborative/,
      );
      assert.deepEqual(h.stub.calls, [], 'a contradictory request must not cost a GET or a PUT');
    } finally {
      /* no session state to release */
    }
  });

  it('refuses when neither flag is given', async () => {
    const h = harness({ [A]: { rows: [] } });
    try {
      await assert.rejects(
        () => h.invoke('playlist_collab_toggle', { playlist_id: A }),
        /at least one of collaborative or public/,
      );
      assert.deepEqual(h.stub.calls, []);
    } finally {
      /* no session state to release */
    }
  });

  it('a toward-visible flip that is declined writes nothing', async () => {
    const h = harness({ [A]: { rows: [], public: false, collaborative: false } }, { elicit: { action: 'decline' } });
    try {
      const out = await h.invoke('playlist_collab_toggle', { playlist_id: A, public: true });
      assert.equal(sc(out).cancelled, true);
      assert.deepEqual(
        h.stub.calls.filter((c) => c.method === 'PUT'),
        [],
        'a declined privacy flip must not reach the metadata endpoint',
      );
    } finally {
      /* no session state to release */
    }
  });
});

describe('#881 check_playlist_following — the render cap', () => {
  /** Verdict for each URI in the request, so the tool's own mapping is exercised. */
  function followStub(verdicts: boolean[]): StatefulPlaylistClient {
    const stub = new StatefulPlaylistClient();
    stub.route('GET', '/me/library/contains', {
      respond: (call) => {
        const uris = String((call.arg as { uris?: string })?.uris ?? '').split(',').filter(Boolean);
        return uris.map((_, i) => verdicts[i % verdicts.length]!);
      },
    });
    return stub;
  }

  it('renders at most max_results and says how many it left out', async () => {
    const stub = followStub([true, false]);
    const ids = Array.from({ length: 8 }, (_, i) => `p${String(i).padStart(2, '0')}`.padEnd(22, 'x'));

    const out = await harness({}, { stub }).invoke('check_playlist_following', { playlists: ids, max_results: 3 });

    assert.equal((sc(out).results as unknown[]).length, 3, 'the render cap applies to the rows, not the reads');
    assert.equal((sc(out).playlists as string[]).length, 8, 'the requested set is still reported in full');
    assert.match(textOf(out), /8 checked, showing 3/);
    assert.match(textOf(out), /more/, 'a truncated render needs a continuation footer, or the caller reads "3" as the answer');
  });

  it('reads the live library-contains route, in 40-URI requests, and nothing else', async () => {
    const stub = followStub([true]);
    const ids = Array.from({ length: 41 }, (_, i) => `q${String(i).padStart(2, '0')}`.padEnd(22, 'x'));

    await harness({}, { stub }).invoke('check_playlist_following', { playlists: ids });

    const reads = stub.calls;
    assert.deepEqual(
      reads.map((c) => c.path),
      ['/me/library/contains', '/me/library/contains'],
      'only the library-contains route may be read — the follow-contains routes were REMOVED in Feb 2026',
    );
    assert.deepEqual(
      reads.map((c) => String((c.arg as { uris?: string }).uris).split(',').length),
      [40, 1],
      'a 41st uri in one request is a 400 from Spotify',
    );
    assert.ok(
      reads.every((c) => String((c.arg as { uris?: string }).uris).startsWith('spotify:playlist:')),
      'follow state is a library-membership check, so the URIs are playlist URIs',
    );
  });
});
