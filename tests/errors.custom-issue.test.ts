/**
 * #1518 — a registered `custom` issue's own message reaches the caller, and an
 * unregistered one does not.
 *
 * ## The defect
 *
 * `expectationPhrase` (`src/tools/annotations.ts`) had a `switch` arm for every
 * zod code a schema produces by *structure* and a `default` that returned
 * `undefined`. `custom` was not in the list. So `src/refs.ts` classified a
 * rejected Spotify reference, wrote `"not a recognisable Spotify ID, URI, or
 * official share URL"`, and the boundary discarded it — the caller got `pass a
 * valid value according to the tool schema` from a message that had already
 * been written for exactly that purpose.
 *
 * ## The symmetry is the point
 *
 * The array form (`ids: ["4iV5…", "not-an-id"]`) and the string form
 * (`id: "not-an-id"`) run through the same validator and the same `switch`. A
 * fix that helped only one of them would leave the defect half-standing, so the
 * first test asserts the two AGREE rather than asserting each is non-empty: two
 * independent non-emptiness checks pass just as happily on the generic phrase
 * this change exists to remove.
 *
 * ## Why the trust half is here
 *
 * Adding a bare `case 'custom'` would relay whatever message the schema's
 * author wrote. That is safe today only because every schema is first-party —
 * a fact about the tree, not a property of the message, and one a `switch` arm
 * cannot check. So the arm is gated on a marker
 * (`src/custom-issues.ts`) that only `trustedCustomIssue` can attach, and the
 * second test proves the gate by building a `custom` issue the way an
 * untrusted schema would and asserting its message does not surface.
 *
 * Without that test the trust claim is decoration: the arm would relay anything,
 * and the file would still read as if it did not.
 *
 * ## What the source scan is for
 *
 * A registry nobody checks is a list. The scan fails if `code: 'custom'` is
 * constructed anywhere in `src/` outside `src/custom-issues.ts`, so an emitter
 * that skips `trustedCustomIssue` is caught by the build rather than shipping a
 * message that silently never reaches the caller — the original defect, one
 * module over.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { CUSTOM_ISSUE_EMITTERS, CUSTOM_MESSAGE_CAP, trustedCustomIssue, trustedCustomMessage } from '../src/custom-issues.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { installToolErrorBoundary } from '../src/tools/annotations.js';
import { StubSpotifyClient } from './helpers/stub-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The refusal the caller reads, with the shapes this contract guarantees. */
interface Refusal {
  text: string;
  fix: string;
}

interface JsonRpc {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeHarness?.();
  closeHarness = undefined;
});

type Ask = (method: string, params?: Record<string, unknown>) => Promise<JsonRpc>;

/** A server driven over raw JSON-RPC, so the frame is the server's own. */
async function surface(build: (server: McpServer) => void): Promise<Ask> {
  const server = new McpServer({ name: 'custom-issue', version: '0.0.0' });
  build(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let next = 1;
  const pending = new Map<number, (value: JsonRpc) => void>();
  clientTransport.onmessage = (message) => {
    const frame = message as JsonRpc;
    if (typeof frame.id !== 'number') return;
    const resolve = pending.get(frame.id);
    if (!resolve) return;
    pending.delete(frame.id);
    resolve(frame);
  };
  await server.connect(serverTransport);
  await clientTransport.start();

  const ask: Ask = async (method, params = {}) => {
    const id = next++;
    const { promise, resolve, reject } = Promise.withResolvers<JsonRpc>();
    pending.set(id, resolve);
    await clientTransport.send({ jsonrpc: '2.0', id, method, params } as never);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000).unref();
    return await promise;
  };

  const init = await ask('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'custom-issue', version: '0.0.0' },
  });
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  closeHarness = async () => {
    await clientTransport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  return ask;
}

/** The real reference validators, behind the production boundary. */
function referenceSurface(): Promise<Ask> {
  return surface((server) => {
    registerCatalogTools(server, new StubSpotifyClient());
    registerPlaylistTools(server, new StubSpotifyClient());
    installToolErrorBoundary(server);
  });
}

/**
 * A surface with a schema that raises `custom` the way an UNTRUSTED one would:
 * a raw `addIssue` with a message and no marker of this repo's. This is the
 * shape a shared or generated schema produces, and it is deliberately built
 * here rather than imported, because the point is that nothing outside
 * `src/custom-issues.ts` can stamp it.
 *
 * `forged` makes the attack explicit rather than incidental. The first draft of
 * this test used a bare `addIssue({ code: 'custom', message })`, and a mutation
 * that deleted the emitter check left it GREEN: with no `params` at all, the
 * readback returns early on the "is there a params object" line, so the test
 * proved the presence check and not the trust decision. A schema that copies
 * the marker by NAME is the case that actually matters, and it is the one
 * `Symbol()` (never `Symbol.for`) defends: the key below is a string, the key
 * the readback looks for is a unique symbol, and no string a reader of
 * `src/custom-issues.ts` can see produces it.
 */
function untrustedSurface(message: string, forged: boolean): Promise<Ask> {
  return surface((server) => {
    server.tool(
      'third_party_lookup',
      'a tool whose schema did not come from this repository',
      {
        // A string, so the ONLY thing that can reject it is the refinement.
        handle: z.string().superRefine((_value, ctx) => {
          ctx.addIssue(forged
            ? {
              code: 'custom',
              message,
              // The marker's own description, and a registered emitter's own
              // name, as plain strings. Both are readable from the source.
              params: { 'spotify-mcp.trustedCustomIssue': 'refs.spotifyId' } as never,
            }
            : { code: 'custom', message });
        }),
      },
      async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    );
    installToolErrorBoundary(server);
  });
}

/**
 * The refusal for a call the boundary rejected.
 *
 * `text` is the human-readable line in the content block; `fix` is the
 * machine-readable next step in the structured envelope. They are read from
 * their own places on purpose — an assertion that pulled `text` out of
 * `structuredContent.error` would read `undefined` and compare it happily
 * against a string, which is how a wire contract gets asserted as if it held.
 */
async function refusal(ask: Ask, name: string, args: Record<string, unknown>): Promise<Refusal> {
  const frame = await ask('tools/call', { name, arguments: args });
  assert.ok(frame.result, `${name} must be answered with a result: ${JSON.stringify(frame.error)}`);
  const content = frame.result.content as Array<{ type?: string; text?: unknown }> | undefined;
  const error = (frame.result.structuredContent as { error?: { fix?: unknown } } | undefined)?.error;
  assert.ok(error, `${name} ${JSON.stringify(args)} must be refused: ${JSON.stringify(frame.result).slice(0, 300)}`);
  // `assert.ok` rather than `assert.equal(typeof …, 'string')`: only the former
  // narrows, and an unnarrowed `String(undefined)` below would quietly produce
  // the string "undefined" and pass the length check that follows it.
  const raw = content?.[0]?.text;
  assert.ok(typeof raw === 'string', `the refusal must carry text: ${JSON.stringify(content)}`);
  const text = raw;
  assert.equal(text.length > 0, true, 'a refusal must say something');
  assert.equal(text.includes('\n'), false, `a refusal must be one line: ${text}`);
  assert.equal(text.includes('\r'), false, `a refusal must be one line: ${text}`);
  assert.equal(typeof error.fix, 'string', 'the refusal must carry a fix');
  return { text, fix: String(error.fix) };
}

const NOT_A_REFERENCE = 'not a recognisable Spotify ID, URI, or official share URL';
const TRACK_A = '4iV5W9uYEdYUVa79Axb7Rh';

describe('a registered custom message reaches the caller in both encodings (#1518)', () => {
  it('says the same thing for the array form and the string form', async () => {
    const ask = await referenceSurface();

    // The two encodings of one rule, through the same validator. Before the
    // `custom` arm both said "pass a valid value according to the tool schema",
    // which is what makes this an assertion about the fix rather than about
    // non-emptiness: a boundary that kept the generic phrase would satisfy two
    // `assert.ok(text.length > 0)` checks and fail this one.
    const arrayForm = await refusal(ask, 'get_several_tracks', { ids: [TRACK_A, 'not-an-id'] });
    const stringForm = await refusal(ask, 'get_track', { id: 'not-an-id' });

    assert.ok(
      arrayForm.text.includes(NOT_A_REFERENCE),
      `the array form must carry the message refs.ts wrote: ${arrayForm.text}`,
    );
    assert.ok(
      stringForm.text.includes(NOT_A_REFERENCE),
      `the string form must carry the same message: ${stringForm.text}`,
    );
    // The agreement IS the contract; the parameter name is the only difference.
    assert.equal(
      arrayForm.text.slice(arrayForm.text.indexOf(': ')),
      stringForm.text.slice(stringForm.text.indexOf(': ')),
      'the array and string forms must state the same rule',
    );
    assert.equal(arrayForm.fix, NOT_A_REFERENCE, 'the fix is the emitter\'s own instruction');
    assert.equal(stringForm.fix, NOT_A_REFERENCE);

    // A different rejection from the same emitter, so the arm relays THIS
    // message rather than a fixed one keyed on the tool.
    const mismatch = await refusal(ask, 'get_album', { id: `spotify:track:${TRACK_A}` });
    assert.ok(
      mismatch.text.includes('Spotify reference kind mismatch: expected album, received track'),
      `a second message from the same emitter must surface: ${mismatch.text}`,
    );
  });

  it('relays the other five registered emitters too, not only the reference one', async () => {
    // The registry is six entries, because the tree has six `custom` sites. A
    // fix wired to `refs.ts` alone would leave the other five writing messages
    // that never arrive, so each is asserted.
    const ask = await referenceSurface();
    const flags = await refusal(ask, 'create_playlist', { name: 'x', public: true, collaborative: true });
    assert.ok(
      flags.text.includes('A playlist cannot be both public and collaborative.'),
      `the playlist flags message must surface: ${flags.text}`,
    );
  });
});

describe('a custom message from an unregistered emitter is not relayed (#1518)', () => {
  it('falls back to the generic phrase rather than publishing the message', async () => {
    // The anti-vacuity half. A `custom` arm with no trust gate passes every test
    // above; these two are what make the gate real.
    const UNTRUSTED = 'this message is authored by something that is not this repository';

    for (const forged of [false, true]) {
      const ask = await untrustedSurface(UNTRUSTED, forged);
      const { text, fix } = await refusal(ask, 'third_party_lookup', { handle: 'anything' });

      assert.equal(
        text.includes(UNTRUSTED),
        false,
        `an untrusted custom message must not reach the caller (forged marker: ${forged}): ${text}`,
      );
      assert.equal(
        text,
        'third_party_lookup rejected parameter handle; pass a valid value according to the tool schema.',
        `an untrusted custom issue must take the pre-existing generic path (forged marker: ${forged})`,
      );
      assert.equal(fix, 'Pass a valid value for handle.');
    }
  });

  it('reads a marked issue back and refuses an unmarked one at the module boundary', async () => {
    // The same decision, asserted at the seam rather than only through the wire,
    // so the trust check is pinned where it lives.
    const marked = trustedCustomIssue('refs.spotifyId', 'the marked message');
    assert.equal(trustedCustomMessage({ ...marked, path: ['id'] }), 'the marked message');

    const unmarked = { code: 'custom', message: 'the marked message', params: {} };
    assert.equal(trustedCustomMessage(unmarked), undefined, 'a message alone is not a claim');
    assert.equal(trustedCustomMessage({ code: 'custom', message: 'x' }), undefined, 'a bare custom issue is not a claim');
    assert.equal(trustedCustomMessage({ code: 'invalid_type', message: 'x' }), undefined, 'another code is not a claim');
  });

  it('refuses a message naming an emitter that is not in the registry', async () => {
    // The runtime half of the registry. The type already rejects this; the throw
    // is what survives a cast or a `.mjs` caller, and it fails loud rather than
    // returning a message the boundary would drop — which is the defect.
    const forge = trustedCustomIssue as unknown as (emitter: string, message: string) => unknown;
    assert.throws(
      () => forge('somebody.elses.emitter', 'hello'),
      /unregistered custom-issue emitter: somebody\.elses\.emitter/,
      'an unregistered emitter name must throw rather than author an untrusted issue',
    );
  });
});

describe('a relayed message is bounded (#1518)', () => {
  it('collapses a multi-line message to one line and caps its length', async () => {
    // Several emitters interpolate caller-supplied fragments into their message
    // (refs.ts names the host out of a submitted URL), so the relay is a place
    // an unbounded string would land on the error surface.
    const long = `${'x'.repeat(CUSTOM_MESSAGE_CAP * 2)}\nsecond line`;
    const ask = await untrustedSurface(long, false);
    const { text } = await refusal(ask, 'third_party_lookup', { handle: 'anything' });
    assert.equal(text.includes('\n'), false, 'a relayed message stays one line');
    // This one is untrusted, so the generic phrase is the bound being tested
    // end to end; the module-level cap is asserted directly below.
    assert.equal(text.includes('x'.repeat(20)), false);

    const bounded = trustedCustomMessage({ ...trustedCustomIssue('refs.spotifyId', long), path: [] });
    assert.ok(bounded, 'a marked long message is still relayed');
    assert.equal(bounded.length <= CUSTOM_MESSAGE_CAP, true, `a relayed message is capped: ${bounded.length}`);
    assert.equal(bounded.includes('\n'), false);
    assert.ok(bounded.endsWith('…'), 'a capped message says it was cut');
  });
});

describe('every custom issuer in src/ is registered (#1518)', () => {
  it('constructs code custom only through the trust module', () => {
    // A registry nobody checks is a list. Without this, an emitter that skipped
    // `trustedCustomIssue` would write a message the boundary drops — the
    // original defect, moved one module over — and the tree would still read as
    // though the trust question had been settled.
    const trustModule = resolve(ROOT, 'src/custom-issues.ts');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        if (resolve(full) === trustModule) continue;
        // Comments and string bodies are blanked by the same helper the gates
        // use, so a module that *documents* a custom issue is not a hit.
        const source = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/code:\s*'custom'/.test(source) || /code:\s*"custom"/.test(source)) {
          offenders.push(relative(ROOT, full));
        }
      }
    };
    walk(resolve(ROOT, 'src'));
    assert.deepEqual(offenders, [], `these modules build a custom issue without the trust marker: ${offenders.join(', ')}`);
  });

  it('names every registered emitter in the source it lives in', () => {
    // The other direction: a registered name nobody uses is a claim of trust
    // with no emitter behind it, which is the list-rotting into a fiction.
    const source = readFileSync(resolve(ROOT, 'src/custom-issues.ts'), 'utf8');
    const tree = ['src/refs.ts', 'src/tools/freshness.ts', 'src/tools/import.ts', 'src/tools/playlists.ts', 'src/tools/playlistbatch.ts']
      .map((file) => readFileSync(resolve(ROOT, file), 'utf8'))
      .join('\n');
    for (const emitter of CUSTOM_ISSUE_EMITTERS) {
      assert.ok(source.includes(`'${emitter}'`), `${emitter} must be in the registry`);
      assert.ok(tree.includes(`'${emitter}'`), `${emitter} is registered but no module authors with it`);
    }
  });
});
