/**
 * Attribution and the link back to Spotify, on MCP Resources (#1525).
 *
 * ## What is being held here
 *
 * #696 shipped an attribution boundary for tool results. MCP Resources are the
 * other read surface, and it was left outside: `installAttributionBoundary`
 * wraps `server.tool` and `server.registerTool`, while every resource in this
 * server registers through `server.resource` and is served by a read callback
 * the SDK stores at registration time. Roughly 26 render sites in
 * `src/resources/` emit `| URI: <uri>` rows — the same row shape the tool path
 * had been fixing — on a surface a host reaches by reading a URI, naming no
 * tool at all.
 *
 * The decision recorded here is that this is covered, not exempted. The policy
 * obligation is about *displaying Spotify Content* (Developer Policy Sec.
 * II.4.a) and a resource read displays Spotify Content; and unlike the tool
 * path, the resource read path is mechanically reachable from the same kind of
 * registration-time wrap. The evidence that it is reachable is in
 * `installResourceAttributionBoundary`'s header — it was read out of the
 * installed SDK, not assumed, precisely because a boundary that installs and
 * attributes nothing is the failure this file exists to make impossible.
 *
 * ## The shape of the proof, and why
 *
 * - **A real resource read, over a real MCP round trip.** These register the
 *   production `registerResources` surface against a stub client and read
 *   `spotify://me/top/tracks` through an in-memory transport, so what is
 *   asserted is the text a host receives. Driving `attributeResourceResult`
 *   directly would pass just as happily if the boundary were never installed —
 *   a decoration helper that is correct and unreachable is the exact failure
 *   #696 and #1525 are both about.
 * - **The exemptions are asserted, not assumed.** A resource has no `isError`
 *   flag and no `response_format`, but it does have a `?format=json` variant
 *   that must stay byte-identical, and a gated 403/404/429 result that reports
 *   state rather than content and must carry no footer. Both are covered
 *   below, because "cover the surface" that silently starts stamping the
 *   footer onto a raw JSON payload or an HTTP status line is a different bug.
 * - **The marker is proved not to reach the wire.** The gate exemption is a
 *   symbol the renderer sets, so it is asserted absent from the serialized
 *   result a client actually receives. `ReadResourceResultSchema` is a loose
 *   object and a string key WOULD have leaked; that is asserted here so the
 *   decision cannot be quietly reversed into a visible field.
 * - **The contract table is pinned, not merely present.** The last describe
 *   block reads §5.17 and asserts it names the resource surface. A doc that had
 *   been updated and later reverted is a separate failure from a doc that is
 *   absent, and only a content assertion catches the first.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { CONTENT_ATTRIBUTION_NOTICE } from '../src/branding.js';
import {
  attributeResourceResult,
  attributeText,
  installResourceAttributionBoundary,
  markNonContent,
} from '../src/attribution.js';
import { registerResources } from '../src/resources/index.js';

const ROOT = join(import.meta.dirname, '..');

/** Real, 22-character, base62 entity ids — the shape the API actually returns. */
const TRACK_ID = '0VjIjW4GlUZAMYd2vXMi3b';
const ALBUM_ID = '1ATL5GLyefJaxhQzSPVrLX';

/** The footer, counted. "Exactly once" is an assertion, not an aspiration. */
const footerCount = (text: string): number =>
  text.split('\n').filter((line) => line.trim() === CONTENT_ATTRIBUTION_NOTICE).length;

/** The raw `/me/top/tracks` payload, as Spotify returns it. */
const topTracksPayload = (): Record<string, unknown> => ({
  items: [
    {
      name: 'Blinding Lights',
      uri: `spotify:track:${TRACK_ID}`,
      duration_ms: 200_940,
      artists: [{ name: 'The Weeknd' }],
      album: { name: 'After Hours', uri: `spotify:album:${ALBUM_ID}` },
    },
  ],
  total: 1,
  limit: 1,
  offset: 0,
});

/**
 * A stub client for the one endpoint the fixture resource reads.
 *
 * `failWith` throws a `SpotifyApiError`, which is what `resourceError()` in
 * `src/resources/index.ts` recognises and routes into the gated 403/404/429
 * result — the path the attribution exemption exists for.
 */
const topTracksStub = (failWith?: number): SpotifyClient => ({
  get: async (path: string) => {
    if (failWith !== undefined) throw new SpotifyApiError(failWith, 'stubbed failure');
    return path.startsWith('/me/top/tracks') ? topTracksPayload() : null;
  },
  post: async () => null,
  put: async () => null,
  delete: async () => null,
  getAllPages: async () => [],
  // The gated 403/404/429 path in `renderWithApiErrors` reads this before
  // building its result. Without it the read throws instead of returning the
  // status line the exemption is about.
  getRateLimitStatus: () => ({
    lastThrottleAt: null,
    retryAfterSec: null,
    cooldownRemainingMs: 0,
    requestsTotal: 0,
    requestsLastMinute: 0,
    requestsLastHour: 0,
  }),
} as unknown as SpotifyClient);

/**
 * Read a resource through a real MCP client, with the resource attribution
 * boundary installed. This is the acceptance criterion itself, not a proxy for
 * it: the text read back is the text a host renders.
 */
async function readResource(
  uri: string,
  options: { env?: NodeJS.ProcessEnv; failWith?: number } = {},
): Promise<{ text: string; raw: Record<string, unknown> }> {
  const env = options.env ?? {};
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const server = new McpServer({ name: 'resource-attribution-test', version: '0.0.0' });
  try {
    installResourceAttributionBoundary(server);
    registerResources(server, topTracksStub(options.failWith));
    const client = new Client({ name: 'resource-attribution-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.readResource({ uri });
      const entry = result.contents[0] as { text?: string };
      return { text: entry?.text ?? '', raw: result as unknown as Record<string, unknown> };
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

describe('the footer, on a real resource read (#1525)', () => {
  it('attributes a resource read and links every rendered row back to Spotify', async () => {
    const { text } = await readResource('spotify://me/top/tracks?time_range=short_term&limit=1');

    assert.equal(footerCount(text), 1, `expected exactly one footer in:\n${text}`);
    assert.ok(
      text.trimEnd().endsWith(CONTENT_ATTRIBUTION_NOTICE),
      `footer should be the last line of:\n${text}`,
    );
    // The row itself, from the real renderer, now carries the link inline.
    assert.match(
      text,
      new RegExp(`URI: spotify:track:${TRACK_ID} \\(https://open\\.spotify\\.com/track/${TRACK_ID}\\)`),
      `row should link back to its track in:\n${text}`,
    );
    // And the bare URI survives: the link is added, the handle is not replaced.
    assert.ok(text.includes(`spotify:track:${TRACK_ID}`), 'the bare URI must remain in the row');
  });

  it('covers the fixed entry AND the template entry, which register separately', async () => {
    // `registerResource` in `src/resources/index.ts` makes TWO registrations per
    // parameterised resource: a fixed entry at the bare URI, and a
    // `ResourceTemplate` at `{?format,…}`. The SDK's `resources/read` handler
    // tries the fixed map first and falls through to the templates, so these
    // two URIs are served by two different registered callbacks. A boundary
    // that wrapped one registration method but not the other — or that had been
    // applied by editing renderers — would pass a test that read only the first.
    const fixed = await readResource('spotify://me/top/tracks');
    const templated = await readResource('spotify://me/top/tracks?time_range=short_term&limit=1');

    assert.equal(footerCount(fixed.text), 1, `fixed entry, got:\n${fixed.text}`);
    assert.equal(footerCount(templated.text), 1, `template entry, got:\n${templated.text}`);
    assert.match(fixed.text, /open\.spotify\.com\/track\//, 'fixed entry row must link back');
    assert.match(templated.text, /open\.spotify\.com\/track\//, 'template entry row must link back');
  });

  it('drops both when SPOTIFY_MCP_ATTRIBUTION is off, and the switch is exact', async () => {
    const { text } = await readResource('spotify://me/top/tracks?time_range=short_term&limit=1', {
      env: { SPOTIFY_MCP_ATTRIBUTION: '0' },
    });
    assert.equal(footerCount(text), 0, `no footer expected in:\n${text}`);
    assert.ok(
      !text.includes('https://open.spotify.com/'),
      `no link expected in:\n${text}`,
    );
    // Opt-OUT direction: an unrecognised value is not a request to remove a
    // mandatory disclosure, so the footer stays.
    const onTypo = await readResource('spotify://me/top/tracks?time_range=short_term&limit=1', {
      env: { SPOTIFY_MCP_ATTRIBUTION: 'enabled' },
    });
    assert.equal(footerCount(onTypo.text), 1, 'an unrecognised value must leave attribution on');
  });
});

describe('what is deliberately not attributed on the resource path', () => {
  it('leaves the ?format=json variant byte-identical — it is the raw API payload', async () => {
    const { text, raw } = await readResource('spotify://me/top/tracks?time_range=short_term&format=json');
    assert.equal(
      text,
      JSON.stringify(topTracksPayload(), null, 2),
      'the json variant must be returned byte-for-byte, with no footer and no rewritten URI',
    );
    assert.equal(footerCount(text), 0);
    assert.ok(!text.includes('https://open.spotify.com/'), 'no reconstructed link in a raw payload');
    assert.equal((raw.contents as Array<{ mimeType?: string }>)[0]?.mimeType, 'application/json');
  });

  it('decides on the declared mimeType, so text/plain prose that IS valid JSON is still attributed', () => {
    // This is the case that separates "the resource path decides structurally"
    // from "the resource path re-runs the tool path's JSON probe", and it is
    // not a hypothetical: with `attributeText` in place this body parsed
    // cleanly, was returned byte-identical, and carried no footer at all. The
    // declared `mimeType` is the only evidence a resource read has, and
    // `json()` is the only thing in `src/resources/` that sets
    // `application/json` — so `text/plain` means the renderer said "prose", and
    // a parse is only a fallback for a surface that does not say.
    const attributed = attributeResourceResult({
      contents: [{ uri: 'spotify://x', text: '{"a":1}', mimeType: 'text/plain' }],
    }) as { contents: Array<{ text: string }> };

    assert.equal(footerCount(attributed.contents[0].text), 1, 'declared prose must be attributed');
    // And the tool path keeps its own rule, which is the parse: a tool result
    // has no declared type to read, so anything that parses stays untouched.
    assert.equal(attributeText('{"a":1}'), '{"a":1}', 'the tool path is unchanged by this');
  });

  it('still attributes prose that merely opens with a brace', () => {
    const attributed = attributeResourceResult({
      contents: [{ uri: 'spotify://x', text: '{ not json at all', mimeType: 'text/plain' }],
    }) as { contents: Array<{ text: string }> };
    assert.equal(footerCount(attributed.contents[0].text), 1);
  });

  it('leaves a gated 403/404/429 result alone — it reports state, not content', async () => {
    for (const status of [403, 404, 429]) {
      const { text } = await readResource('spotify://me/top/tracks?time_range=short_term&limit=1', {
        failWith: status,
      });
      assert.equal(footerCount(text), 0, `a ${status} result must not be footed; got:\n${text}`);
      assert.match(text, new RegExp(`\\(${status}\\)`), `expected the ${status} status line in:\n${text}`);
    }
  });

  it('keeps the exemption marker off the wire, in every gated result', async () => {
    // `ReadResourceResultSchema` is a LOOSE object, so a string-keyed marker
    // would be validated through and serialized to the host as an undocumented
    // response field. The symbol cannot be. Asserted against the real wire
    // shape so the choice cannot be reversed into a visible field later.
    const { raw } = await readResource('spotify://me/top/tracks?time_range=short_term&limit=1', {
      failWith: 404,
    });
    const serialized = JSON.stringify(raw);
    assert.ok(
      !serialized.includes('attributionNonContent') && !serialized.includes('attribution'),
      `the marker must never reach the host; got: ${serialized}`,
    );
    assert.deepEqual(
      Object.keys(raw).filter((key) => key !== 'contents'),
      [],
      'a gated read must carry no field beyond `contents`',
    );
  });

  it('returns by identity when there is nothing to attribute', () => {
    const notAResult = { contents: 'not an array' };
    assert.equal(attributeResourceResult(notAResult), notAResult);
    assert.equal(attributeResourceResult(null), null);
    assert.equal(attributeResourceResult(undefined), undefined);
    const noText = { contents: [{ uri: 'spotify://x', blob: 'AA==' }] };
    assert.equal(attributeResourceResult(noText), noText, 'a blob entry has no rendered text');
  });

  it('does not put a second footer on a result that already carries one', async () => {
    const once = attributeResourceResult(
      markNonContent({ contents: [{ uri: 'u', text: 'x', mimeType: 'text/plain' }] }),
    );
    // The marked read is returned by identity — the boundary never edits it.
    assert.equal(
      (once as { contents: Array<{ text: string }> }).contents[0].text,
      'x',
      'a marked result must be returned untouched',
    );
  });

  it('does not mutate the result it was handed', () => {
    const block = { uri: 'spotify://x', text: `URI: spotify:track:${TRACK_ID}`, mimeType: 'text/plain' };
    const original = { contents: [block] };
    const attributed = attributeResourceResult(original) as { contents: Array<{ text: string }> };
    assert.equal(block.text, `URI: spotify:track:${TRACK_ID}`, 'the input block must be untouched');
    assert.notEqual(attributed.contents[0], block, 'a new entry must be built');
    assert.notEqual(attributed, original, 'a new result must be built');
  });
});

describe('a URI the resource path cannot resolve', () => {
  it('leaves an unresolvable token byte-identical', () => {
    // `spotify:track:trk1` is not a 22-character base62 entity id. The row is
    // unchanged around it — no shortened path, no guessed kind. A test using
    // only well-formed ids would pass against an implementation that fabricated
    // a link for anything shaped like a URI, which is the #803 failure.
    const attributed = attributeResourceResult({
      contents: [{ uri: 'u', text: '| URI: spotify:track:trk1', mimeType: 'text/plain' }],
    }) as { contents: Array<{ text: string }> };
    assert.match(attributed.contents[0].text, /\| URI: spotify:track:trk1\n/);
    assert.ok(!attributed.contents[0].text.includes('open.spotify.com/track/trk1'));
  });
});

describe('the contract the documentation states', () => {
  it('names the resource surface in §5.17, so the coverage cannot be quietly reverted', () => {
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
    const section = spec.slice(spec.indexOf('### 5.17 Attribution and the link back to Spotify'));
    assert.ok(section.length > 0, '§5.17 must exist');
    assert.match(
      section,
      /resource/i,
      '§5.17 must say something about resources — a reader told how the link-back is '
        + 'discharged has no way to learn a surface discharges nothing',
    );
    assert.match(section, /spotify:\/\//, '§5.17 must name the resource surface it now covers');
  });

  it('records the resource decision in the compliance document, not only in a comment', () => {
    const compliance = readFileSync(join(ROOT, 'docs/compliance.md'), 'utf8');
    assert.match(compliance, /resource/i, 'docs/compliance.md must record the resource decision');
  });

  it('installs the boundary in src/index.ts, and before the read surfaces register', () => {
    // Everything above drives `installResourceAttributionBoundary` directly, so
    // on its own it would stay green if `src/index.ts` never called it — the
    // boundary correct, tested and unreachable, which is the exact failure this
    // issue is about. There is no test in this tree that stands up the real
    // server, so the install site is pinned as source instead.
    //
    // The ORDER is the load-bearing half. The SDK stores a resource's read
    // callback when it registers and dispatches through that stored reference
    // on `resources/read`, so an installer called after `registerReadSurfaces()`
    // wraps nothing and reports success. A boundary that silently does nothing
    // is worse than one that is absent, so the constraint is asserted rather
    // than left to a comment in `src/index.ts`.
    const source = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    const install = source.indexOf('installResourceAttributionBoundary(server)');
    // Anchored on the dynamic IMPORT, not on the identifier. The bare name
    // appears in this file's own explanatory comment — which sits ABOVE the
    // install, and made a first draft of this assertion read a comment as the
    // registration and fail against correct code. A positional assertion over
    // prose has to name the call, or it measures whoever wrote the comment.
    const register = source.indexOf("await import('./resources/register.js')");

    assert.ok(install >= 0, 'src/index.ts must install the resource attribution boundary');
    assert.ok(register >= 0, 'the read surfaces must still be registered in src/index.ts');
    assert.ok(
      install < register,
      'the boundary must be installed BEFORE the read surfaces register — the SDK stores the '
        + 'read callback at registration time, so a later install wraps nothing',
    );
  });
});
