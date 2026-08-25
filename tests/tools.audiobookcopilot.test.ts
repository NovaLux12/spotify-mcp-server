/**
 * Tests for src/tools/audiobookcopilot.ts (#112 idea 4).
 *
 * Stub MCP server + stub SpotifyClient (records every call, returns canned
 * data) — no network. Run:
 *   node --import tsx --test tests/tools.audiobookcopilot.test.ts
 */

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerAudiobookCopilotTools } from '../src/tools/audiobookcopilot.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.playlists-following.test.ts)
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: 'GET' | 'POST' | 'PUT' | 'PUT_RAW' | 'DELETE';
  path: string;
  arg?: unknown;
}

type Responder = (path: string, arg?: unknown) => unknown;

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

type Registrar = (server: McpServer, client: SpotifyClient) => void;

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  let respond: Responder = responder;

  const client = {
    calls,
    setResponder(fn: Responder) {
      respond = fn;
    },
    async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
      calls.push({ method: 'GET', path, arg: params });
      return respond(path, params) as T | null;
    },
    async post<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'POST', path, arg: body });
      return respond(path, body) as T | null;
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return respond(path, body) as T | null;
    },
    async putRaw(path: string, body: string): Promise<void> {
      calls.push({ method: 'PUT_RAW', path, arg: body });
      await respond(path, body);
    },
    async delete<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'DELETE', path, arg: body });
      return respond(path, body) as T | null;
    },
    // Mirrors SpotifyClient.getAllPages pagination semantics.
    async getAllPages<T>(
      path: string,
      params?: Record<string, string>,
      opts?: { maxItems?: number },
    ): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 2000;
      const all: T[] = [];
      let offset = 0;
      for (;;) {
        const page = await this.get<SpotifyPaged<T>>(path, { ...params, offset: String(offset) });
        if (!page || !Array.isArray(page.items)) break;
        all.push(...page.items);
        if (all.length >= maxItems) return all.slice(0, maxItems);
        const limit =
          typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
        offset += limit;
        if (page.items.length === 0 || page.items.length < limit) break;
        if (typeof page.total === 'number' && offset >= page.total) break;
      }
      return all;
    },
  };
  return client;
}

function harness(responder: Responder = () => null) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerAudiobookCopilotTools(fakeServer, client as unknown as SpotifyClient);

  return {
    registered,
    client,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0].text;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** Chapter with a stable duration derived from its index and optional resume point. */
const chapter = (
  n: number,
  opts?: { resume_position_ms?: number; fully_played?: boolean },
) => ({
  id: `ch${n}`,
  name: `Chapter ${n}`,
  uri: `spotify:chapter:ch${n}`,
  chapter_number: n - 1, // API's own 0-based field; tools must NOT rely on it
  duration_ms: HOUR_MS,
  release_date: '2024-01-01',
  explicit: false,
  description: '',
  is_playable: true,
  ...(opts?.resume_position_ms !== undefined || opts?.fully_played !== undefined
    ? {
        resume_point: {
          fully_played: opts?.fully_played ?? false,
          resume_position_ms: opts?.resume_position_ms ?? 0,
        },
      }
    : {}),
});

/** Multi-page chapters endpoint at the 50/page cap: total split across pages. */
const pagedChaptersResponder = (total: number): Responder => (_path, arg) => {
  const params = (arg ?? {}) as Record<string, string>;
  // Non-paging calls (e.g. the PUT play body) are not chapter pages.
  if (params.limit === undefined) return null;
  assert.equal(params.limit, '50');
  const offset = Number(params.offset ?? 0);
  const items = Array.from(
    { length: Math.min(50, Math.max(total - offset, 0)) },
    (_, i) => chapter(offset + i + 1),
  );
  const page: SpotifyPaged<unknown> = {
    items,
    total,
    limit: 50,
    offset,
    next: offset + 50 < total ? `https://api.spotify.com/v1/...?offset=${offset + 50}` : null,
  };
  return page;
};

// ---------------------------------------------------------------------------
// list_all_chapters
// ---------------------------------------------------------------------------

describe('list_all_chapters', () => {
  it('walks every 50-chapter page of a long book into one complete table', async () => {
    const h = harness(pagedChaptersResponder(120));

    const out = await h.invoke('list_all_chapters', { audiobook_id: 'book1' });

    // Three upstream pages: offsets 0, 50, 100 — all at the endpoint cap.
    const gets = h.client.calls.filter((c) => c.method === 'GET');
    assert.equal(gets.length, 3);
    assert.deepEqual(gets.map((c) => (c.arg as Record<string, string>).offset), ['0', '50', '100']);

    const text = textOf(out);
    assert.match(text, /\(120 total\)/);
    // First and last rows present with 1-based numbering across pages.
    assert.match(text, /1\. "Chapter 1"/);
    assert.match(text, /50\. "Chapter 50"/);
    assert.match(text, /120\. "Chapter 120"/);
    // No truncation footer — the whole table is the deliverable.
    assert.doesNotMatch(text, /more —/);
  });

  it('renders duration and resume_point per row when present', async () => {
    const h = harness((_path, arg) => {
      const offset = Number(((arg ?? {}) as Record<string, string>).offset ?? 0);
      if (offset > 0) return { items: [], total: 2, limit: 50, offset, next: null };
      return {
        items: [
          chapter(1, { resume_position_ms: 900_000 }),
          chapter(2, { fully_played: true }),
        ],
        total: 2,
        limit: 50,
        offset: 0,
        next: null,
      };
    });

    const out = await h.invoke('list_all_chapters', { audiobook_id: 'book1' });
    const text = textOf(out);
    assert.match(text, /1\. "Chapter 1" \(1h 0m\) \| resume at 15m 0s \| URI: spotify:chapter:ch1/);
    assert.match(text, /2\. "Chapter 2" \(1h 0m\) \| fully played \| URI: spotify:chapter:ch2/);

    const structured = out.structuredContent!;
    const pagination = structured.pagination as { total: number; next_offset: number | null };
    assert.equal(pagination.total, 2);
    assert.equal(pagination.next_offset, null);
    assert.equal((structured.items as unknown[]).length, 2);
  });

  it('json mode returns the raw assembled payload', async () => {
    const h = harness(pagedChaptersResponder(60));
    const out = await h.invoke('list_all_chapters', { audiobook_id: 'book1', response_format: 'json' });

    const raw = JSON.parse(textOf(out)) as {
      audiobook_id: string;
      total: number;
      items: Array<{ chapter: number; name: string; uri: string; duration_ms: number }>;
    };
    assert.equal(raw.audiobook_id, 'book1');
    assert.equal(raw.total, 60);
    assert.equal(raw.items.length, 60);
    assert.equal(raw.items[0].chapter, 1);
    assert.equal(raw.items[59].chapter, 60);
    assert.deepEqual(out.structuredContent, raw);
  });

  it('throws a clear error when the audiobook does not exist', async () => {
    const h = harness(() => null);
    await assert.rejects(
      h.invoke('list_all_chapters', { audiobook_id: 'nope' }),
      /not found or has no chapters/,
    );
  });
});

// ---------------------------------------------------------------------------
// jump_to_chapter
// ---------------------------------------------------------------------------

describe('jump_to_chapter', () => {
  it('maps a 1-based chapter to PUT play with context_uri + offset.uri', async () => {
    const h = harness(pagedChaptersResponder(55));

    const out = await h.invoke('jump_to_chapter', { audiobook_id: 'book1', chapter: 51 });

    const put = h.client.calls.find((c) => c.method === 'PUT');
    assert.ok(put, 'expected one PUT call');
    assert.equal(put.path, '/me/player/play');
    assert.deepEqual(put.arg, {
      context_uri: 'spotify:audiobook:book1',
      offset: { uri: 'spotify:chapter:ch51' }, // second page, 1-based index 51
    });
    assert.match(textOf(out), /Playing chapter 51 of 55: "Chapter 51"/);
  });

  it('chapter 1 targets the first chapter; last chapter works too', async () => {
    const h = harness(pagedChaptersResponder(2));

    await h.invoke('jump_to_chapter', { audiobook_id: 'book1', chapter: 1 });
    const firstPut = h.client.calls.find((c) => c.method === 'PUT');
    assert.deepEqual(firstPut!.arg, {
      context_uri: 'spotify:audiobook:book1',
      offset: { uri: 'spotify:chapter:ch1' },
    });

    h.client.calls.length = 0;
    await h.invoke('jump_to_chapter', { audiobook_id: 'book1', chapter: 2 });
    const lastPut = h.client.calls.find((c) => c.method === 'PUT');
    assert.deepEqual(lastPut!.arg, {
      context_uri: 'spotify:audiobook:book1',
      offset: { uri: 'spotify:chapter:ch2' },
    });
  });

  it('appends device_id as a query parameter when given', async () => {
    const h = harness(pagedChaptersResponder(1));
    await h.invoke('jump_to_chapter', { audiobook_id: 'book1', chapter: 1, device_id: 'dev-9' });
    const put = h.client.calls.find((c) => c.method === 'PUT');
    assert.equal(put!.path, '/me/player/play?device_id=dev-9');
  });

  it('rejects an out-of-range chapter without touching playback', async () => {
    const h = harness(pagedChaptersResponder(18));
    await assert.rejects(
      h.invoke('jump_to_chapter', { audiobook_id: 'book1', chapter: 19 }),
      /has only 18 chapters; cannot jump to chapter 19/,
    );
    assert.ok(!h.client.calls.some((c) => c.method === 'PUT'));
  });

  it('dry_run previews the exact play body and issues no mutation', async () => {
    const h = harness(pagedChaptersResponder(30));

    const out = await h.invoke('jump_to_chapter', {
      audiobook_id: 'book1',
      chapter: 7,
      dry_run: true,
    });

    const text = textOf(out);
    assert.match(text, /^\[dry run\] start playback on spotify:chapter:ch7 — nothing was changed\./);
    assert.match(text, /Play chapter 7: "Chapter 7"/);
    assert.match(text, /context_uri=spotify:audiobook:book1, offset\.uri=spotify:chapter:ch7/);
    assert.ok(!h.client.calls.some((c) => c.method === 'PUT'));
    assert.equal((out.structuredContent as { dry_run: boolean }).dry_run, true);
    assert.equal((out.structuredContent as { ok: boolean }).ok, true);
  });
});

// ---------------------------------------------------------------------------
// where_was_i
// ---------------------------------------------------------------------------

describe('where_was_i', () => {
  const BOOK_TOTAL = 24;

  /** Responder serving chapters plus an optional playback state. */
  const withState = (state: unknown): Responder => (path, arg) => {
    if (path === '/me/player') return state;
    assert.equal(path, '/audiobooks/book1/chapters');
    return pagedChaptersResponder(BOOK_TOTAL)(path, arg);
  };

  it('matches mid-book playback and reports position, remaining chapters and time', async () => {
    // Listening to chapter 3, halfway through.
    const h = harness(
      withState({
        item: { uri: 'spotify:chapter:ch3' },
        progress_ms: 1_800_000,
        is_playing: true,
      }),
    );

    const out = await h.invoke('where_was_i', { audiobook_id: 'book1' });

    const text = textOf(out);
    assert.match(text, /Chapter 3 of 24: "Chapter 3"/);
    assert.match(text, /Position in chapter: 30m 0s of 1h 0m/);
    assert.match(text, /21 chapters remaining/);
    // Left: 30m in this chapter + 21 full hours.
    assert.match(text, /Listening time left: 21h 30m\./);

    const structured = out.structuredContent as {
      status: string;
      current_chapter: { number: number; position_ms: number; remaining_ms: number };
      chapters_remaining: number;
      listening_time_remaining_ms: number;
    };
    assert.equal(structured.status, 'playing');
    assert.equal(structured.current_chapter.number, 3);
    assert.equal(structured.current_chapter.remaining_ms, HOUR_MS - 1_800_000);
    assert.equal(structured.chapters_remaining, 21);
    assert.equal(structured.listening_time_remaining_ms, HOUR_MS - 1_800_000 + 21 * HOUR_MS);
  });

  it('reports nothing playing gracefully when /me/player is empty', async () => {
    const h = harness(withState(null));

    const out = await h.invoke('where_was_i', { audiobook_id: 'book1' });

    const text = textOf(out);
    assert.match(text, /Nothing is currently playing\./);
    assert.match(text, /Next up when you start: Chapter 1 "Chapter 1"/);
    assert.equal((out.structuredContent as { status: string }).status, 'nothing_playing');

    // Only reads: two GETs (chapters walk + player state), no mutations.
    assert.ok(h.client.calls.every((c) => c.method === 'GET'));
  });

  it('treats playback outside the book as not started (chapter 1 next)', async () => {
    const h = harness(
      withState({
        item: { uri: 'spotify:track:somewhere-else' },
        progress_ms: 40_000,
        is_playing: false,
      }),
    );

    const out = await h.invoke('where_was_i', { audiobook_id: 'book1' });

    const text = textOf(out);
    assert.match(text, /not currently listening to this audiobook/);
    assert.match(text, /you will begin at Chapter 1 "Chapter 1"/);
    assert.equal((out.structuredContent as { status: string }).status, 'not_started');
  });

  it('handles chapters without resume_point and missing progress_ms', async () => {
    const h = harness(
      withState({
        item: { uri: 'spotify:chapter:ch1' },
        progress_ms: null,
        is_playing: false,
      }),
    );

    const out = await h.invoke('where_was_i', { audiobook_id: 'book1' });
    const text = textOf(out);
    assert.match(text, /Chapter 1 of 24: "Chapter 1"/);
    assert.match(text, /Position in chapter: 0s of 1h 0m/);
    assert.equal((out.structuredContent as { status: string }).status, 'paused');
  });

  it('reports finished-book edge: last chapter fully consumed leaves zero time', async () => {
    const h = harness(
      withState({
        item: { uri: `spotify:chapter:ch${BOOK_TOTAL}` },
        progress_ms: HOUR_MS,
        is_playing: false,
      }),
    );

    const out = await h.invoke('where_was_i', { audiobook_id: 'book1' });
    const structured = out.structuredContent as {
      chapters_remaining: number;
      listening_time_remaining_ms: number;
    };
    assert.equal(structured.chapters_remaining, 0);
    assert.equal(structured.listening_time_remaining_ms, 0);
    assert.match(textOf(out), /Listening time left: 0s\./);
  });
});
