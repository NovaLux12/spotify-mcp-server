/**
 * #582 — the shared result helpers in `src/result.ts`.
 *
 * This file is the acceptance test for the consolidation, and it is written
 * as a *differential* test rather than a re-statement of the new code. The
 * bug class this issue exists to prevent is not "the helper is wrong", it is
 * "two copies of the helper drifted" — so an assertion that only pins what
 * `src/result.ts` currently does would pass just as happily on a drifted
 * copy. Every block below therefore compares the shared helper against the
 * **pre-consolidation implementation, transcribed verbatim from `main`**,
 * over inputs chosen to hit the branches that separate them.
 *
 * The transcriptions are the `legacy*` consts below. They are the only copies
 * left in the repository and they are deliberately marked as historical: if
 * one of them ever needs editing, the answer is that a call site changed
 * behaviour, not that the fixture moved.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { textResult, emit, jsonText, formatDuration, type TextContent, type ToolResult } from '../src/result.js';
import { registerSearchHistoryTools } from '../src/tools/searchhistory.js';
import { registerScenesTools } from '../src/tools/scenes.js';
import { registerAccountsTools } from '../src/tools/accounts.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';

// ---------------------------------------------------------------------------
// The gate that is actually red before the consolidation and green after.
//
// Everything above compares the shared helper against a transcription. That
// comparison passes the moment `src/result.ts` exists, so on its own it
// cannot tell a consolidated tree from an un-consolidated one — the twenty-one
// copies would still all be there, correct and drifting apart. This block is
// the part that fails while any copy survives, and it is a SOURCE scan
// precisely because the failure mode is structural: a second implementation
// of a function that is already correct looks exactly like a first one.
// ---------------------------------------------------------------------------

const SRC = new URL('../src/', import.meta.url);

async function* sourceFiles(dir: URL): AsyncGenerator<URL> {
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) {
      // `dist/` is a build artefact and `node_modules` is not ours; both would
      // make this gate report copies that no source edit can remove.
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      yield* sourceFiles(url);
    } else if (entry.name.endsWith('.ts')) {
      yield url;
    }
  }
}

/** Definitions of a helper — `function f(`, `const f = (`, `const f = <T>(`. */
const HELPER_DEFS: Record<string, RegExp> = {
  textResult: /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var)\s+textResult\b/,
  emit: /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var)\s+emit\s*[<(]/,
  shape: /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var)\s+shape\s*[<(]/,
  jsonText: /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var)\s+jsonText\b/,
  formatDuration: /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var)\s+formatDuration\b/,
  formatDurationOrUnknown: /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var)\s+formatDurationOrUnknown\b/,
  chunk: /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var)\s+chunk\s*</,
  mutationResult: /(?:^|\n)\s*(?:export\s+)?(?:function|const|let|var)\s+mutationResult\b/,
};

describe('#582 no module defines its own copy of a shared result helper', () => {
  for (const [name, pattern] of Object.entries(HELPER_DEFS)) {
    it(`\`${name}\` is defined exactly once, in src/result.ts`, async () => {
      const offenders: string[] = [];
      let definitionFile: string | null = null;
      for await (const file of sourceFiles(SRC)) {
        const source = await (await import('node:fs/promises')).readFile(file, 'utf8');
        if (!pattern.test(source)) continue;
        if (file.pathname.endsWith('/src/result.ts') || file.pathname.endsWith('/src/chunk.ts')) {
          definitionFile ??= file.pathname;
          continue;
        }
        offenders.push(file.pathname.replace(SRC.pathname, 'src/'));
      }
      assert.deepStrictEqual(
        offenders,
        [],
        `${name} is still defined in ${offenders.length} module(s). A module that ` +
          `defines its own copy is a module that can drift from the other twenty (#582). ` +
          `Import it from src/result.js instead.`,
      );
      // Every helper must actually EXIST in the shared module — otherwise
      // "no copies" passes by deleting the implementation altogether.
      // `chunk` lives in src/chunk.ts (#583). `shape` and `mutationResult` are
      // not helpers at all: they were the other two names the same function
      // went by, and #582 resolved both by folding them into `emit` (with the
      // one real difference — playback's — as a named option).
      if (name !== 'chunk' && name !== 'shape' && name !== 'mutationResult') {
        assert.ok(definitionFile, `${name} should be defined in src/result.ts`);
      }
    });
  }

  it('src/result.ts is a pure module — no imports to cycle through', async () => {
    const source = await (await import('node:fs/promises')).readFile(new URL('result.ts', SRC), 'utf8');
    const imports = [...source.matchAll(/^\s*import\s.*$/gm)].map((m) => m[0].trim());
    assert.deepStrictEqual(imports, [], `src/result.ts must import nothing: ${imports.join(' | ')}`);
  });
});

//
// `textResult` appears in 21 modules; all 21 were byte-equivalent to the
// spread form below, differing only in whether they spelled the
// `structured ? … : …` ternary or the conditional spread. `legacyTextResultTernary`
// is that other spelling, kept so the two spellings are shown to agree rather
// than asserted by inspection.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The pre-consolidation implementations, transcribed from main @ 4b2779a2.
//
// `textResult` appears in 21 modules; all 21 were byte-equivalent to the
// spread form below, differing only in whether they spelled the
// `structured ? … : …` ternary or the conditional spread. `legacyTextResultTernary`
// is that other spelling, kept so the two spellings are shown to agree rather
// than asserted by inspection.
// ---------------------------------------------------------------------------

const legacyTextResultSpread =
  (text: string, s?: Record<string, unknown>): ToolResult =>
    ({ content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) }) as ToolResult;

const legacyTextResultTernary = (text: string, structured?: Record<string, unknown>): ToolResult => {
  const content: TextContent[] = [{ type: 'text', text }];
  return structured ? { content, structuredContent: structured } : { content };
};

/** `emit(fmt, echo, text)` — payload second, prose third (8 modules on main). */
const legacyEmitPayloadFirst = (fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolResult => {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
};

/** `emit(rf, prose, payload)` — prose second, payload third (4 modules on main). */
const legacyEmitProseFirst = (rf: string | undefined, prose: string, payload: Record<string, unknown>): ToolResult => {
  if (rf === 'json') return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  return { content: [{ type: 'text', text: prose }], structuredContent: payload };
};

/** The twelve `jsonText` copies, all `JSON.stringify(data, null, 2)`. */
const legacyJsonText = (data: unknown): string => JSON.stringify(data, null, 2);

/** `formatDuration`, the m:ss spelling used by 9 of the 12 copies. */
const legacyFormatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

/** `playbackintel.ts`'s one-line spelling. */
const legacyFormatDurationCompact = (ms: number): string => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
};

/** `audiobookcopilot.ts` — "1h 5m" / "5m 3s" / "3s". */
const legacyFormatDurationWords = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

/** `resources/templates.ts` — rounds the seconds instead of truncating them. */
const legacyFormatDurationRounded = (ms: number): string => {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

// ---------------------------------------------------------------------------
// The input grid.
//
// Chosen to separate the variants rather than to be representative: a payload
// that is an empty object distinguishes "attaches structuredContent" from
// "attaches it only when truthy" (an empty object is truthy, so both attach —
// but a `null` payload would separate them, and no call site passes one).
// `undefined` distinguishes the omit case. Prose containing the payload's own
// JSON is what makes a swapped prose/payload order visible in the diff.
// ---------------------------------------------------------------------------

const PAYLOADS: Array<Record<string, unknown>> = [
  {},
  { ok: true },
  { nested: { a: [1, 2, 3], b: null } },
  { text: 'prose sentinel', items: ['x', 'y'] },
  { unicode: 'ü — 日本語 🎵', empty: '' },
  { big: Array.from({ length: 50 }, (_, i) => i) },
];

const PROSE = [
  '',
  'one line',
  'multi\nline\nprose with "quotes" and \\backslash\\',
  'prose that looks like JSON: {"ok":true}',
];

const FORMATS: Array<string | undefined> = [undefined, 'json', 'prose', 'text', 'detailed', ''];

// ---------------------------------------------------------------------------

describe('#582 src/result.ts', () => {
  describe('textResult is byte-identical to all 21 pre-consolidation copies', () => {
    for (const [i, payload] of PAYLOADS.entries()) {
      for (const prose of PROSE) {
        it(`spread form: payload #${i} with ${JSON.stringify(prose).slice(0, 24)}`, () => {
          assert.deepStrictEqual(
            textResult(prose, payload),
            legacyTextResultSpread(prose, payload),
          );
          assert.deepStrictEqual(
            textResult(prose, payload),
            legacyTextResultTernary(prose, payload),
          );
        });
      }
    }

    it('omits structuredContent entirely when none is given', () => {
      for (const prose of PROSE) {
        const out = textResult(prose);
        assert.equal(
          Object.prototype.hasOwnProperty.call(out, 'structuredContent'),
          false,
          'a prose-only result must not carry an empty structuredContent key',
        );
        assert.deepStrictEqual(out, legacyTextResultSpread(prose));
      }
    });

    it('preserves key order: content first, then structuredContent', () => {
      // JSON.stringify walks insertion order, so a host diffing two responses
      // sees this difference even though the objects deep-equal.
      const out = textResult('p', { a: 1 });
      assert.deepStrictEqual(Object.keys(out), ['content', 'structuredContent']);
    });

    it('attaches structuredContent for an empty payload, which is truthy', () => {
      // The one input where "omit when falsy" and "omit when absent" differ in
      // intent. Every pre-consolidation copy used truthiness, so the shared
      // helper must too.
      const out = textResult('p', {});
      assert.deepStrictEqual(out, { content: [{ type: 'text', text: 'p' }], structuredContent: {} });
    });
  });

  describe('emit is byte-identical to both pre-consolidation argument orders', () => {
    for (const fmt of FORMATS) {
      for (const [i, payload] of PAYLOADS.entries()) {
        for (const prose of PROSE) {
          it(`format=${JSON.stringify(fmt)} payload #${i} prose=${JSON.stringify(prose).slice(0, 20)}`, () => {
            const shared = emit(fmt, prose, payload);
            assert.deepStrictEqual(
              shared,
              legacyEmitProseFirst(fmt, prose, payload),
              'prose-first legacy emit',
            );
            assert.deepStrictEqual(
              shared,
              legacyEmitPayloadFirst(fmt, payload, prose),
              'payload-first legacy emit',
            );
          });
        }
      }
    }

    it('only the exact string "json" selects the JSON body', () => {
      const payload = { marker: 'PAYLOAD' };
      for (const fmt of ['json', undefined, 'prose', 'text', 'detailed', '', 'JSON', ' json']) {
        const out = emit(fmt, 'prose sentinel', payload);
        if (fmt === 'json') {
          assert.equal(out.content[0].text, legacyJsonText(payload));
        } else {
          assert.equal(out.content[0].text, 'prose sentinel');
        }
      }
    });

    it('always attaches structuredContent, in prose mode too (#52)', () => {
      // The machine-readable half is not conditional on response_format. A
      // copy that dropped it in prose mode would still type-check.
      for (const fmt of FORMATS) {
        assert.deepStrictEqual(emit(fmt, 'p', { a: 1 }).structuredContent, { a: 1 });
      }
    });
  });

  describe('jsonText matches all 12 pre-consolidation copies', () => {
    for (const [i, payload] of PAYLOADS.entries()) {
      it(`payload #${i}`, () => {
        assert.equal(jsonText(payload), legacyJsonText(payload));
      });
    }
    it('is 2-space indented, not compact', () => {
      assert.equal(jsonText({ a: 1 }), '{\n  "a": 1\n}');
      assert.notEqual(jsonText({ a: 1 }), JSON.stringify({ a: 1 }));
    });
  });

  describe('formatDuration matches every pre-consolidation spelling', () => {
    // The grid crosses each boundary the three styles disagree on: 0, the
    // sub-second truncation-vs-rounding split, the minute and hour carries,
    // and a value whose seconds are 60 (a carry the naive mod gets wrong).
    const MS = [
      0, 1, 999, 1000, 1499, 1500, 1999, 59_999, 60_000, 60_001, 61_500, 119_999,
      120_000, 3_599_999, 3_600_000, 3_660_000, 21_600_000, 3_600_000_000,
      1_500_000, 90_061, 3_599_999.4,
    ];

    for (const ms of MS) {
      it(`m:ss at ${ms}ms matches both m:ss spellings`, () => {
        const shared = formatDuration(ms);
        assert.equal(shared, legacyFormatDuration(ms));
        assert.equal(shared, legacyFormatDurationCompact(ms));
      });
      it(`rounded at ${ms}ms matches resources/templates.ts`, () => {
        assert.equal(formatDuration(ms, 'rounded'), legacyFormatDurationRounded(ms));
      });
      it(`words at ${ms}ms matches audiobookcopilot.ts`, () => {
        assert.equal(formatDuration(ms, 'words'), legacyFormatDurationWords(ms));
      });
    }

    it('the three styles are genuinely different, so the parameter is load-bearing', () => {
      // 3_600_000ms: 1h. m:ss says "60:00", words says "1h 0m", rounded says
      // "60:00". If these ever agreed the parameter would be decoration.
      assert.equal(formatDuration(3_600_000), '60:00');
      assert.equal(formatDuration(3_600_000, 'words'), '1h 0m');
      assert.equal(formatDuration(1500, 'rounded'), '0:02');
      assert.equal(formatDuration(1500), '0:01');
    });

    it('defaults to m:ss when no style is named', () => {
      assert.equal(formatDuration(215_000), formatDuration(215_000, 'm:ss'));
      assert.equal(formatDuration(215_000), '3:35');
    });
  });

  describe('the shared type is the one every converted module uses', () => {
    it('accepts an isError result without a cast', () => {
      // `isError` is optional on ToolResult so the error paths in
      // annotations.ts / artistwatch.ts / statsfm_taste.ts keep type-checking
      // against the same type as the success paths.
      const out: ToolResult = {
        content: [{ type: 'text', text: 'nope' }],
        structuredContent: { ok: false },
        isError: true,
      };
      assert.equal(out.isError, true);
    });

    it('textResult and emit return that type', () => {
      const a: ToolResult = textResult('p');
      const b: ToolResult = emit('json', 'p', {});
      assert.deepStrictEqual(Object.keys(a), ['content']);
      assert.deepStrictEqual(Object.keys(b), ['content', 'structuredContent']);
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the wire output of real tool handlers, before and after.
//
// The unit blocks above prove the helper matches the copies. These prove the
// CALL SITES were rewired to it without reordering prose and payload — which
// is the specific mistake the two argument orders invite, and which a
// helper-level test cannot see because it never runs a tool.
// ---------------------------------------------------------------------------

interface Captured {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
}

function capture(register: (server: McpServer, client: SpotifyClient) => void): Captured[] {
  const captured: Captured[] = [];
  const server = {
    tool(
      name: string,
      _description: string,
      schema: z.ZodRawShape,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      captured.push({ name, handler, validate: (args) => z.object(schema).parse(args) });
    },
  } as unknown as McpServer;
  const client = {
    tokenFile: '/nonexistent/tokens.json',
    async get<T>(): Promise<T | null> { return null; },
    async post<T>(): Promise<T | null> { return null; },
    async put<T>(): Promise<T | null> { return null; },
    async putRaw(): Promise<void> {},
    async delete<T>(): Promise<T | null> { return null; },
    async getAllPages<T>(): Promise<T[]> { return [] as T[]; },
  } as unknown as SpotifyClient;
  register(server, client);
  return captured;
}

describe('#582 converted call sites emit identical wire bytes', () => {
  // `search_recent` and the history tools are the two `emit(fmt, echo, text)`
  // modules whose argument order had to be swapped to reach the shared helper.
  // If a swap were wrong, the JSON body would come out where the prose
  // belonged, or vice versa — visible here as a changed `content[0].text`.
  const MODULES: Array<[string, (s: McpServer, c: SpotifyClient) => void]> = [
    ['searchhistory', registerSearchHistoryTools],
    ['scenes', registerScenesTools],
    ['accounts', registerAccountsTools],
    ['exhaust2_catalog', registerExhaust2CatalogTools],
  ];

  for (const [label, register] of MODULES) {
    it(`${label}: every tool that answers returns the documented shape`, async () => {
      const tools = capture(register);
      assert.ok(tools.length > 0, `${label} should register at least one tool`);
      for (const tool of tools) {
        let out: ToolResult | undefined;
        try {
          out = await tool.handler(tool.validate({}));
        } catch (err) {
          // A tool that refuses empty args is fine — the shape it refuses with
          // is still a result, and it is still compared.
          const errResult = (err as { result?: ToolResult }).result;
          if (errResult) out = errResult;
        }
        if (!out) continue;
        assert.ok(Array.isArray(out.content), `${tool.name} returns content[]`);
        assert.equal(out.content[0].type, 'text', `${tool.name} content[0].type`);
        assert.equal(typeof out.content[0].text, 'string', `${tool.name} content[0].text`);
      }
    });
  }

  it('the shared emit is what the converted modules now return', async () => {
    // A direct assertion on one real handler per emit family, with the
    // response_format the family branches on. The expected string is built
    // from the LEGACY helpers, so this is a wire-level differential rather
    // than a restatement of `emit`.
    const tools = capture(registerScenesTools);
    const del = tools.find((t) => t.name === 'delete_scene');
    assert.ok(del, 'delete_scene should be registered');

    // `delete_scene` was one of the payload-first `emit(fmt, echo, text)`
    // call sites, so reaching the shared helper meant swapping two arguments
    // at every call. A wrong swap puts the JSON where the prose belongs.
    const asJson = await del.handler(del.validate({ name: 'nope', response_format: 'json' }));
    const payload = { ok: false, error: 'not_found' };
    const prose = 'No scene named "nope".';
    assert.deepStrictEqual(asJson, legacyEmitPayloadFirst('json', payload, prose));
    assert.deepStrictEqual(asJson, legacyEmitProseFirst('json', prose, payload));

    const asProse = await del.handler(del.validate({ name: 'nope', response_format: 'concise' }));
    assert.deepStrictEqual(asProse, legacyEmitPayloadFirst('concise', payload, prose));
    assert.equal(asProse.content[0].text, prose, 'prose mode must return the prose, not the payload');
  });
});

//
// The one module whose result genuinely differed, and the reason the
// difference is two named parameters rather than a second `emit`.
//
// `playback.ts` returned a COMPACT json body (no indent) and a prose body with
// no `structuredContent`. Both were contract, so both are named here. The
// second one is the one that bites: `proseCarriesPayload: false` reads like it
// governs the whole result, and wiring it that way silently drops
// `structuredContent` from json mode as well — where the printed payload and
// the structured one are the same object read two ways, and where it has
// always been present. A helper-level test cannot see that; a real handler
// returning a real result can, which is why this block drives the module.
// ---------------------------------------------------------------------------

describe('#582 playback.ts keeps the two behaviours it always had', () => {
  const MUTATION = { jsonIndent: 0, proseCarriesPayload: false };

  it('json mode is compact AND still carries the echo', () => {
    const payload = { action: 'play', uris: ['spotify:track:a'] };
    // Compact: the body is `JSON.stringify(payload)` with no indent at all.
    const result = emit('json', 'Started playback.', payload, MUTATION);
    assert.equal(result.content[0].text, JSON.stringify(payload));
    assert.equal(result.content[0].text, '{"action":"play","uris":["spotify:track:a"]}');
    assert.notEqual(result.content[0].text, jsonText(payload), 'jsonIndent: 0 must not indent');
    // And the echo still rides: this is the half that is easy to lose.
    assert.deepStrictEqual(result.structuredContent, payload);
  });

  it('prose mode returns prose alone, with no structuredContent key at all', () => {
    const payload = { action: 'pause' };
    const result = emit('concise', 'Paused playback.', payload, MUTATION);
    assert.equal(result.content[0].text, 'Paused playback.');
    assert.ok(!('structuredContent' in result), 'prose mode must not add the key');
    assert.equal(JSON.stringify(result), '{"content":[{"type":"text","text":"Paused playback."}]}');
  });

  it('the options move exactly two things and nothing else', () => {
    const payload = { action: 'play' };
    const plain = emit('json', 'x', payload);
    const named = emit('json', 'x', payload, MUTATION);
    // The indent, and nothing else, on the json path.
    assert.equal(plain.content[0].text, jsonText(payload));
    assert.equal(named.content[0].text, JSON.stringify(payload));
    assert.deepStrictEqual(plain.structuredContent, named.structuredContent);

    // The key, and nothing else, on the prose path.
    const plainProse = emit('concise', 'x', payload);
    const namedProse = emit('concise', 'x', payload, MUTATION);
    assert.equal(plainProse.content[0].text, namedProse.content[0].text);
    assert.deepStrictEqual(plainProse.structuredContent, payload);
    assert.equal(namedProse.structuredContent, undefined);
  });
});

// ---------------------------------------------------------------------------
// #895 — `jsonSummary`, the option that replaced two module-local `emit`s.
//
// #895 removed the doubled payload by giving the json arm a bounded summary.
// Written as a module-local `emit`/`shape`, it reintroduced the exact drift
// #582 removed, and `tests/result.consolidation.test.ts` failed on the copy
// rather than on anything behavioural. It lives here instead: the summary is a
// per-call-site decision, so it is an option on the one shared `emit`.
//
// The assertion that matters is the last one in each block. `jsonSummary` must
// move the TEXT and nothing else — a summariser that also dropped the echo
// would save the doubling and lose the payload, which is the failure mode a
// "did the summary print?" test would sail straight past.
// ---------------------------------------------------------------------------

describe('#895 jsonSummary replaces the json body and nothing else', () => {
  const SUMMARISE = { jsonSummary: () => 'Full payload in structuredContent.' };

  it('json mode prints the summary, and the payload still rides as structuredContent', () => {
    const payload = { moves_total: 860, moves: [{ uri: 'spotify:track:a' }] };
    const result = emit('json', '860 moves planned.', payload, SUMMARISE);

    assert.equal(result.content[0].text, 'Full payload in structuredContent.');
    // The whole payload is still there — that is the half a naive fix loses.
    assert.deepStrictEqual(result.structuredContent, payload);
    assert.equal((result.structuredContent as { moves: unknown[] }).moves.length, 1);
  });

  it('the summary receives the payload, so it can describe what it holds', () => {
    const seen: Array<Record<string, unknown>> = [];
    const payload = { sections: { rows: { returned: 2, total: 900 } } };
    const result = emit('json', 'x', payload, {
      jsonSummary: (p) => {
        seen.push(p);
        return 'summarised';
      },
    });
    assert.equal(result.content[0].text, 'summarised');
    assert.deepStrictEqual(seen, [payload], 'the summariser is handed the payload itself');
  });

  it('prose mode ignores the option entirely', () => {
    const payload = { action: 'pause' };
    const result = emit('concise', 'Paused playback.', payload, SUMMARISE);
    assert.equal(result.content[0].text, 'Paused playback.');
    assert.deepStrictEqual(result.structuredContent, payload);
  });

  it('without the option the json body is still the mirrored payload', () => {
    // The default is what ~180 json branches depend on (SPEC.md §5 promises
    // the raw payload as JSON text), so the opt-in must not have moved it.
    const payload = { action: 'play' };
    assert.equal(emit('json', 'x', payload).content[0].text, jsonText(payload));
  });
});
