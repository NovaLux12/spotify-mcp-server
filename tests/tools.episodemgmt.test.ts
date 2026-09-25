import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEpisodeMgmtTools } from '../src/tools/episodemgmt.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { verifyReceipt } from '../src/receipts.js';
type EpisodeItem = {
  episode: {
    id: string;
    uri: string;
    name: string;
    resume_point: { fully_played: boolean };
  };
  added_at: string;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: unknown) => Promise<ToolResult>;
};

type CapturingServer = {
  tool(
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (args: unknown) => Promise<ToolResult>,
  ): void;
  server?: {
    getClientCapabilities(): { elicitation: { form: Record<string, never> } };
    elicitInput(): Promise<ElicitationAnswer>;
  };
};

type ElicitationAnswer =
  | { action: 'accept'; content?: { confirm?: unknown } }
  | { action: 'decline' | 'cancel' }
  | Error;

function playedEpisodes(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    episode: {
      id: `ep${i}`,
      uri: `spotify:episode:ep${i}`,
      name: `Ep ${i}`,
      resume_point: { fully_played: true },
    },
    added_at: '2026-01-01',
  }));
}

/**
 * `pager` shapes what the library walk does, because #746 is entirely about
 * the scan the tool trusts: 'missing' drops the pager off the client and
 * 'walk_failed' rejects mid-walk. A library longer than `limit` needs no
 * mode — just pass more episodes than the limit.
 */
type PagerMode = 'normal' | 'missing' | 'walk_failed';

function harness(overrides: { episodes?: EpisodeItem[]; answer?: ElicitationAnswer; stillPresent?: string[]; pager?: PagerMode; walkError?: Error; libraryTotal?: number | null } = {}) {
  const dels: string[] = [];
  let prompts = 0;
  const episodes: EpisodeItem[] = overrides.episodes ?? [
    { episode: { id: 'ep1', uri: 'spotify:episode:ep1', name: 'Ep 1', resume_point: { fully_played: true } }, added_at: '2026-01-01' },
    { episode: { id: 'ep2', uri: 'spotify:episode:ep2', name: 'Ep 2', resume_point: { fully_played: false } }, added_at: '2026-01-02' },
    { episode: { id: 'ep3', uri: 'spotify:episode:ep3', name: 'Ep 3', resume_point: { fully_played: true } }, added_at: '2026-01-03' },
  ];
  const client = {
    async get(path: string, params?: Record<string, string>) {
      if (path === '/me/episodes') {
        // `libraryTotal` shapes what the non-paging client says about the size
        // of the library relative to the one page it can return: the default is
        // "this page is all of it", a number is a real truncation, and null
        // omits `total` entirely so the tool has to admit it cannot tell.
        const total = overrides.libraryTotal === undefined ? episodes.length : overrides.libraryTotal;
        return total === null ? { items: episodes } : { items: episodes, total };
      }
      // Receipt verification refetch: /me/library/contains?uris=a,b
      if (path === '/me/library/contains') {
        const asked = (params?.uris ?? '').split(',');
        const present = new Set(overrides.stillPresent ?? []);
        return asked.map((u) => present.has(u));
      }
      return null;
    },
    async getAllPages(_path: string, _params?: Record<string, string>, opts?: { maxItems?: number }) {
      if (overrides.pager === 'walk_failed') {
        // The real error class, not a hand-rolled object with the right field
        // names: describeScanError reads status/retryAfterSec off whatever the
        // client throws, and only a real SpotifyApiError proves that contract.
        throw overrides.walkError ?? new SpotifyApiError(429, 'API rate limit reached', 12, 'QUOTA_EXCEEDED');
      }
      // Mirrors the real getAllPages contract: it stops at maxItems and slices,
      // so asking for cap+1 is how a caller detects the library runs longer.
      return episodes.slice(0, opts?.maxItems ?? episodes.length);
    },
    async delete(path: string) { dels.push(path); return null; },
    async put(path: string) { return null; },
  } as unknown as SpotifyClient;
  if (overrides.pager === 'missing') {
    delete (client as unknown as Record<string, unknown>).getAllPages;
  }
  const registered: RegisteredTool[] = [];
  const server: CapturingServer = {
    tool(name, _description, schema, handler) {
      registered.push({ name, schema, handler });
    },
  };
  if (overrides.answer !== undefined) {
    server.server = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      async elicitInput() {
        prompts += 1;
        if (overrides.answer instanceof Error) throw overrides.answer;
        return overrides.answer;
      },
    };
  }
  // Test double implements only the registration and elicitation surface used here.
  registerEpisodeMgmtTools(server as unknown as McpServer, client);
  const invoke = async (name: string, args: unknown) => {
    const tool = registered.find((entry) => entry.name === name);
    assert.ok(tool, `tool ${name} not found`);
    return tool.handler(z.object(tool.schema).parse(args));
  };
  return {
    registered,
    dels,
    invoke,
    get promptCount() { return prompts; },
  };
}

afterEach(() => {
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

describe('episodemgmt', () => {
  it('registers exactly 1 tool (archive_played_episodes)', () => {
    const h = harness(); assert.equal(h.registered.length, 1);
    assert.ok(h.registered.some((entry) => entry.name === 'archive_played_episodes'));
  });
  it('does not register phantom mark_episode_played', () => {
    const h = harness();
    assert.ok(!h.registered.some((entry) => entry.name === 'mark_episode_played'), 'mark_episode_played should be removed');
  });
  it('accepts a legacy confirm input but never lets it authorise the delete', async () => {
    // No `answer` override: the client advertises no elicitation capability, so
    // the verdict is 'unsupported' — the exact case the old boolean bypassed.
    const h = harness({ episodes: playedEpisodes(51) });
    const tool = h.registered[0];
    assert.ok(tool);
    // Accepted so a 1.31.0 caller is not rejected with unknown_param...
    assert.ok(tool.schema.confirm, 'legacy confirm input must still be accepted');
    // ...but it must not stand in for a human: with no elicitation capability
    // the write is refused exactly as it would be without the flag.
    const out = await h.invoke('archive_played_episodes', { confirm: true });
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.reason, 'confirmation_unavailable');
    assert.deepEqual(h.dels, [], 'confirm:true must not authorise the delete');
    assert.deepEqual(out.structuredContent?.deprecated_inputs, ['confirm']);
  });
  it('archive_played_episodes reports no played when none fully_played', async () => {
    const h = harness({ episodes: [{ episode: { id: 'x', uri: 'spotify:episode:x', name: 'X', resume_point: { fully_played: false } }, added_at: '2026-01-01' }] });
    const out = await h.invoke('archive_played_episodes', {});
    assert.match(out.content[0].text, /No fully-played/i);
  });
  it('archive_played_episodes dry_run previews without prompting or writing', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: new Error('must not prompt') });
    const out = await h.invoke('archive_played_episodes', { dry_run: true });
    assert.match(out.content[0].text, /dry run/i);
    assert.equal(h.promptCount, 0);
    assert.deepEqual(h.dels, []);
  });
  it('refuses >50 episodes without elicitation support and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51) });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.cancelled, true);
    assert.equal(out.structuredContent.reason, 'confirmation_unavailable');
    assert.equal(h.promptCount, 0);
    assert.deepEqual(h.dels, []);
  });
  it('refuses a declined confirmation and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: { action: 'decline' } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.cancelled, true);
    assert.equal(h.promptCount, 1);
    assert.deepEqual(h.dels, []);
  });
  it('treats accept without confirm=true as declined and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: { action: 'accept', content: {} } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.cancelled, true);
    assert.equal(h.promptCount, 1);
    assert.deepEqual(h.dels, []);
  });
  it('refuses a transport error and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: new Error('elicitation transport failed') });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.cancelled, true);
    assert.equal(out.structuredContent.reason, 'elicitation_failed');
    assert.equal(h.promptCount, 1);
    assert.deepEqual(h.dels, []);
  });
  it('archives >50 episodes only after an explicit accepted confirmation', async () => {
    const h = harness({ episodes: playedEpisodes(51), answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, true);
    assert.equal(out.structuredContent.removed, 51);
    assert.equal(h.promptCount, 1);
    assert.equal(h.dels.length, 2);
  });
  it('SPOTIFY_MCP_CONFIRM=never explicitly bypasses prompting and archives >50 episodes', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const h = harness({ episodes: playedEpisodes(51), answer: { action: 'decline' } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, true);
    assert.equal(out.structuredContent.removed, 51);
    assert.equal(h.promptCount, 0);
    assert.equal(h.dels.length, 2);
  });
  it('a successful archive issues a removal receipt verify_receipt can resolve', async () => {
    const h = harness({ episodes: playedEpisodes(3) });
    const out = await h.invoke('archive_played_episodes', {});
    const receipt = out.structuredContent.receipt as { receipt_id?: string };
    assert.ok(receipt?.receipt_id, 'successful archive must surface a receipt id');
    // Same process, same in-module store: this is what verify_receipt reads.
    const stored = verifyReceipt(receipt.receipt_id!);
    assert.ok(stored, 'receipt id must resolve in the receipt store');
    assert.equal(stored!.kind, 'library');
    assert.deepEqual(stored!.uris, ['spotify:episode:ep0', 'spotify:episode:ep1', 'spotify:episode:ep2']);
  });
  it('the archive receipt records the episodes as expected ABSENT', async () => {
    const h = harness({ episodes: playedEpisodes(3) });
    const out = await h.invoke('archive_played_episodes', {});
    const receipt = out.structuredContent.receipt as Record<string, unknown>;
    // A removal receipt: direction removed (so undo re-adds) and no still-present
    // uris once the refetch confirms they are gone.
    assert.equal(receipt.direction, 'removed');
    assert.equal(receipt.verified, true);
    assert.deepEqual(receipt.missing, []);
    assert.match(out.content[0].text, /confirmed absent/i);
  });
  it('an archive that only partly landed reports the still-present uri', async () => {
    const h = harness({ episodes: playedEpisodes(3), stillPresent: ['spotify:episode:ep1'] });
    const out = await h.invoke('archive_played_episodes', {});
    const receipt = out.structuredContent.receipt as Record<string, unknown>;
    assert.equal(receipt.verified, false);
    assert.deepEqual(receipt.missing, ['spotify:episode:ep1']);
    assert.match(out.content[0].text, /still-present uris: spotify:episode:ep1/);
  });
  it('json response_format keeps the text parseable and carries the receipt in structuredContent', async () => {
    const h = harness({ episodes: playedEpisodes(3) });
    const out = await h.invoke('archive_played_episodes', { response_format: 'json' });
    // json stays machine-parseable: no receipt prose leaks into the text
    // (same contract as library.ts mutationOutVerified).
    const parsed = JSON.parse(out.content[0].text) as { removed: number };
    assert.equal(parsed.removed, 3);
    assert.doesNotMatch(out.content[0].text, /VERIFIED|confirmed absent/);
    const receipt = out.structuredContent.receipt as { receipt_id?: string };
    assert.ok(receipt.receipt_id, 'json mode must still expose the receipt via structuredContent');
    assert.ok(verifyReceipt(receipt.receipt_id!));
  });
  it('issues no receipt on any refused or dry-run path', async () => {
    const refused = harness({ episodes: playedEpisodes(51) });
    const r = await refused.invoke('archive_played_episodes', {});
    assert.equal(r.structuredContent.ok, false);
    assert.equal(r.structuredContent.receipt, undefined);
    const dry = harness({ episodes: playedEpisodes(3) });
    const d = await dry.invoke('archive_played_episodes', { dry_run: true });
    assert.equal(d.structuredContent.receipt, undefined);
  });

  // #746: a scan that fails or truncates must never be reported as a total, and
  // must never drive a destructive write.

  it('reports a walk that failed as a partial scan carrying the reason', async () => {
    const h = harness({ episodes: playedEpisodes(51), pager: 'walk_failed', answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.scan_complete, false);
    assert.equal(out.structuredContent.partial_scan, true);
    assert.equal(out.structuredContent.scan_failure, 'walk_failed');
    // The reason must survive to the caller: a 429 and a 500 need different
    // next steps, and "scan failed" alone throws that away.
    assert.match(String(out.structuredContent.partial_scan_reason), /rate limit/i);
    assert.match(String(out.structuredContent.partial_scan_reason), /429/);
    assert.match(String(out.structuredContent.partial_scan_reason), /Retry-After: 12s/);
    assert.match(out.content[0].text, /rate limit/i);
    // The old bug verbatim: a failed read reported as a clean empty library.
    assert.doesNotMatch(out.content[0].text, /No fully-played episodes in library/i);
    // The reason must describe this tool's retained state, not assert something
    // about the walk. getAllPages fetches page by page and only discards what it
    // accumulated when a page throws, so "nothing was read" is a claim about the
    // world that can be false. Pinned so the honest wording cannot regress.
    const reason = String(out.structuredContent.partial_scan_reason);
    assert.match(reason, /retained/i);
    assert.doesNotMatch(reason, /before any episode was read|was not read at all|nothing was read|never read at all/i);
    // Same rule on the prose half: the old defect shipped as two sentences in
    // two places, so pinning only the reason would let the prose regress alone.
    assert.doesNotMatch(out.content[0].text, /no episode was read|nothing was read|not read at all|never read at all/i);
  });

  it('refuses the destructive path on a failed walk and performs zero writes', async () => {
    const h = harness({ episodes: playedEpisodes(51), pager: 'walk_failed', answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.ok, false);
    assert.equal(out.structuredContent.reason, 'scan_incomplete');
    assert.deepEqual(h.dels, [], 'a failed scan must never authorise a delete');
    // The scan gate runs before elicitation: prompting a human to approve a
    // list built on a scan the tool could not finish is still a bad delete.
    assert.equal(h.promptCount, 0);
    // Nothing was removed, so a removal receipt would be a lie.
    assert.equal(out.structuredContent.receipt, undefined);
  });

  it('never reports a partial scan count as a total', async () => {
    // 60 saved, asked for 50: the walk is capped, so 51 rows come back and the
    // remaining 9 were never read.
    const h = harness({ episodes: playedEpisodes(60), answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', { limit: 50 });
    assert.equal(out.structuredContent.scan_failure, 'limit_reached');
    assert.equal(out.structuredContent.scan_complete, false);
    assert.match(String(out.structuredContent.partial_scan_reason), /requested limit of 50/);
    assert.deepEqual(h.dels, []);
    // 'played' and 'would_remove' are the total-shaped fields. On an untrusted
    // scan they would read as "that is everything", which is the false clean
    // bill this issue is about, so the count is explicitly scoped instead.
    assert.equal(out.structuredContent.played, undefined);
    assert.equal(out.structuredContent.would_remove, undefined);
    assert.equal(out.structuredContent.removed, undefined);
    // The cap+1 probe row exists only to prove truncation and must never reach
    // the numerator: the report claims `cap` read, so the played count can
    // never exceed it. This is the invariant the earlier revision violated.
    assert.equal(out.structuredContent.played_among_scanned, 50);
    assert.ok(
      Number(out.structuredContent.played_among_scanned) <= Number(out.structuredContent.scanned),
      `played_among_scanned (${out.structuredContent.played_among_scanned}) must not exceed scanned (${out.structuredContent.scanned})`,
    );
    assert.match(out.content[0].text, /refused/i);
    assert.match(out.content[0].text, /never read/i);
  });

  it('a library of exactly the limit is a complete scan, not a truncated one', async () => {
    // The off-by-one boundary: getAllPages stops at maxItems, so a library of
    // exactly `cap` is genuinely complete and must still be archivable. Guards
    // against a `>=` truncation check that would gate every at-limit caller.
    const h = harness({ episodes: playedEpisodes(50) });
    const out = await h.invoke('archive_played_episodes', { limit: 50 });
    assert.equal(out.structuredContent.scan_complete, true);
    assert.equal(out.structuredContent.ok, true);
    assert.equal(out.structuredContent.removed, 50);
    assert.equal(h.dels.length, 1);
  });

  it('archives a one-page read whose own response says it is the whole library', async () => {
    // The no_pager branch used to say "the rest of the library was never
    // scanned" on the strength of one page, which is a claim about the library
    // the tool never measured. `total` travels in the same response, so when the
    // page holds that many rows the read did cover the library and refusing
    // would be refusing an archive the tool can vouch for.
    const h = harness({ episodes: playedEpisodes(3), pager: 'missing', answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.scan_complete, true);
    assert.equal(out.structuredContent.scan_failure, undefined);
    assert.equal(out.structuredContent.scanned, 3);
    assert.equal(out.structuredContent.removed, 3);
    assert.equal(h.dels.length, 1);
  });

  it('discloses a page shorter than the reported library total as partial', async () => {
    // Same branch, a client that admits the page is short: here the truncation
    // IS an observation (120 reported, 3 delivered), so the partial report and
    // the refusal are both warranted.
    const h = harness({ episodes: playedEpisodes(3), pager: 'missing', libraryTotal: 120, answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.scan_failure, 'no_pager');
    assert.equal(out.structuredContent.scan_complete, false);
    assert.equal(out.structuredContent.scanned, 3);
    assert.equal(out.structuredContent.played_among_scanned, 3);
    assert.match(String(out.structuredContent.partial_scan_reason), /cannot page through the library/);
    // The number the tool actually holds is the only one that may be quoted.
    assert.match(String(out.structuredContent.partial_scan_reason), /120/);
    assert.deepEqual(h.dels, [], 'a short page is not the whole library, so it must not delete');
  });

  it('never contradicts its own reason when a short page retains no rows', async () => {
    // The zero-retained branch is the one clause that talks about what the
    // scan knows rather than about what it read. On this shape the reason
    // printed immediately before it says the library holds 120 saved
    // episodes, so a zero-retained clause claiming nothing is known about the
    // library denies the sentence in front of it. Assert the shape, not just
    // the clause: the walk-failed tests all use a reason that carries no
    // library size, so none of them can expose the contradiction.
    const h = harness({ episodes: [], pager: 'missing', libraryTotal: 120, answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.scan_failure, 'no_pager');
    assert.equal(out.structuredContent.scan_complete, false);
    assert.equal(out.structuredContent.scanned, 0);
    assert.equal(out.structuredContent.played_among_scanned, 0);
    // The size the tool holds is what makes the ignorance claim contradictory.
    assert.match(String(out.structuredContent.partial_scan_reason), /120/);
    assert.doesNotMatch(out.content[0].text, /nothing is known about the library|no episode was read|nothing was read|not read at all|never read at all/i);
    assert.deepEqual(h.dels, [], 'an empty page is not the whole library, so it must not delete');
  });

  it('never claims a truncation the response did not report when total is absent', async () => {
    // A client that returns no `total` leaves the tool unable to tell whether
    // the page is the whole library. That is a fact about this tool, so it is
    // the only thing the reason may say: asserting "the rest of the library was
    // never scanned" here is the unobserved claim this branch used to make.
    const h = harness({ episodes: playedEpisodes(3), pager: 'missing', libraryTotal: null, answer: { action: 'accept', content: { confirm: true } } });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.scan_failure, 'no_pager');
    assert.equal(out.structuredContent.scan_complete, false);
    const reason = String(out.structuredContent.partial_scan_reason);
    assert.match(reason, /cannot tell whether/i);
    assert.doesNotMatch(reason, /never scanned|rest of the library|never read/i);
    assert.doesNotMatch(out.content[0].text, /never scanned|rest of the library/i);
    // Same standard on the prose: it may only speak about this scan.
    assert.match(out.content[0].text, /cannot show that the whole library was covered/i);
    assert.deepEqual(h.dels, [], 'an unverifiable page must not delete');
  });

  it('a partial dry run previews the read episodes and writes nothing', async () => {
    const h = harness({ episodes: playedEpisodes(60), answer: new Error('must not prompt') });
    const out = await h.invoke('archive_played_episodes', { dry_run: true, limit: 50 });
    assert.equal(out.structuredContent.dry_run, true);
    assert.equal(out.structuredContent.scan_complete, false);
    assert.equal(out.structuredContent.scanned, 50);
    assert.equal(out.structuredContent.played_among_scanned, 50);
    assert.ok(
      Number(out.structuredContent.played_among_scanned) <= Number(out.structuredContent.scanned),
      `played_among_scanned (${out.structuredContent.played_among_scanned}) must not exceed scanned (${out.structuredContent.scanned})`,
    );
    assert.match(out.content[0].text, /PARTIAL SCAN/i);
    assert.match(out.content[0].text, /partial scan/i);
    assert.deepEqual(h.dels, []);
    assert.equal(h.promptCount, 0);
  });

  it('a partial dry run does not present a failed scan as a clean bill', async () => {
    // The nastiest shape: the walk dies and the one page it could still read
    // happens to hold nothing played. Reporting "would remove nothing" there is
    // the original false clean bill in dry-run clothing.
    const h = harness({
      episodes: [{ episode: { id: 'x', uri: 'spotify:episode:x', name: 'X', resume_point: { fully_played: false } }, added_at: '2026-01-01' }],
      pager: 'walk_failed',
    });
    const out = await h.invoke('archive_played_episodes', { dry_run: true });
    assert.equal(out.structuredContent.scan_complete, false);
    // The count is this tool's own retained total, never a claim about how much
    // of the walk succeeded: a failed walk retains no rows by construction, and
    // even that is this scan's state, not a statement that the walk read none.
    assert.equal(out.structuredContent.scanned, 0, 'a failed walk retains no episode rows');
    assert.match(out.content[0].text, /PARTIAL SCAN/i);
    assert.match(out.content[0].text, /unread remainder may still contain fully-played episodes/i);
    assert.deepEqual(h.dels, []);
  });

  it('keeps the deprecated-confirm notice on the partial refusal path', async () => {
    // The new early return must not swallow the deprecation notice a legacy
    // caller needs to learn that `confirm: true` authorised nothing.
    const h = harness({ episodes: playedEpisodes(60) });
    const out = await h.invoke('archive_played_episodes', { limit: 50, confirm: true });
    assert.equal(out.structuredContent.reason, 'scan_incomplete');
    assert.deepEqual(out.structuredContent.deprecated_inputs, ['confirm']);
    assert.match(out.content[0].text, /no longer authorises the delete/);
    assert.deepEqual(h.dels, []);
  });

  it('an untruncated scan reports a total and still deletes with a receipt', async () => {
    const h = harness({ answer: new Error('must not prompt') });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.scan_complete, true);
    assert.equal(out.structuredContent.ok, true);
    assert.equal(out.structuredContent.scanned, 3);
    assert.equal(out.structuredContent.removed, 2);
    assert.equal(h.dels.length, 1);
    // The complete path must still receipt; the guard sits before it, not on it.
    const receipt = out.structuredContent.receipt as { receipt_id?: string };
    assert.ok(receipt.receipt_id);
  });

  it('a successful complete walk finding nothing played still says so', async () => {
    // Control for the refusals above: if this ever stops passing, the partial
    // assertions could be passing vacuously.
    const h = harness({ episodes: [{ episode: { id: 'x', uri: 'spotify:episode:x', name: 'X', resume_point: { fully_played: false } }, added_at: '2026-01-01' }] });
    const out = await h.invoke('archive_played_episodes', {});
    assert.equal(out.structuredContent.scan_complete, true);
    assert.equal(out.structuredContent.played, 0);
    assert.match(out.content[0].text, /No fully-played episodes in library \(scanned 1\)/);
    assert.deepEqual(h.dels, []);
  });
});
