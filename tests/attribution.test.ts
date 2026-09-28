/**
 * Rendered-row attribution and the link back to Spotify (#696).
 *
 * ## What is being held here
 *
 * Two policy clauses and the three ways each has historically been satisfied by
 * a line in a document rather than by code. Developer Policy Sec. II.4.a makes
 * attribution mandatory wherever Spotify Content is displayed, and Sec. II.4.b
 * requires the displayed metadata to link back to the applicable entity. This
 * server renders Spotify metadata and nothing else, and until this landed it
 * rendered it uncredited, with bare `spotify:` URIs an agent cannot hand a
 * reader.
 *
 * ## The shape of the proof, and why
 *
 * - **A real tool, over a real MCP round trip.** The end-to-end cases register
 *   the production `search` registrar against a stub client and call it through
 *   an in-memory transport, so what is asserted is the text a host receives —
 *   not the output of the pure helpers, which would pass just as happily if the
 *   boundary were never installed. That is the failure this file is shaped
 *   around: a decoration helper that is correct and unreachable.
 * - **The negative direction is the real one.** `withAttributionFooter` returns
 *   its input untouched when the footer is already there, `linkifyRows` is
 *   idempotent, and the JSON case returns byte-identical text. Those are
 *   properties of a re-applied wrapper, and a test that only ever adds
 *   something cannot observe them.
 * - **A URI this module cannot resolve is left alone.** `spotify:track:trk1` is
 *   not a 22-character entity id, so it gets no link, and the row is asserted
 *   byte-identical around it. A test that used only well-formed ids would pass
 *   against an implementation that fabricated a path for anything shaped like a
 *   URI, which is the #803 failure one field over.
 * - **The documents are compared against the code, not merely present.** The
 *   last describe block reads the configuration reference, pulls the switch it
 *   documents, and drives that value through the real gate. A doc that named a
 *   different variable, or one whose prose contradicted its own table row, is a
 *   separate failure from a doc that is absent, and only the first is caught by
 *   a presence check — the drift shape this repo has shipped before.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SpotifyClient } from '../src/client.js';

import { CONTENT_ATTRIBUTION_NOTICE } from '../src/branding.js';
import { attributionEnv, initConfig, parseAttribution, FALSY_ENV_VALUES } from '../src/config.js';
import { buildMcpServer } from '../src/server.js';
import { resolveToolsets } from '../src/toolsets.js';
import {
  attributeResult,
  attributeText,
  installAttributionBoundary,
  linkifyRows,
  spotifyWebUrl,
  withAttributionFooter,
} from '../src/attribution.js';
import { registerSearchTools } from '../src/tools/search.js';
import { SPOTIFY_REFERENCE_KINDS } from '../src/refs.js';
import { StubSpotifyClient } from './helpers/stub-client.js';
import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

const ROOT = join(import.meta.dirname, '..');

/** Real, 22-character, base62 entity ids — the shape the API actually returns. */
const TRACK_ID = '0VjIjW4GlUZAMYd2vXMi3b';
const ALBUM_ID = '1ATL5GLyefJaxhQzSPVrLX';
const ARTIST_ID = '6v8FB84lnmJs434UJf2Mrm';

/** The footer, counted. "Exactly once" is an assertion, not an aspiration. */
const footerCount = (text: string): number =>
  text.split('\n').filter((line) => line.trim() === CONTENT_ATTRIBUTION_NOTICE).length;

const searchStub = (): SpotifyClient => {
  const searchResponse = {
    tracks: {
      items: [
        {
          name: 'Blinding Lights',
          uri: `spotify:track:${TRACK_ID}`,
          duration_ms: 200_940,
          artists: [{ name: 'The Weeknd' }],
          album: { name: 'After Hours', uri: `spotify:album:${ALBUM_ID}` },
        },
        {
          name: 'Blinding Lights (Live)',
          uri: `spotify:track:${TRACK_ID.slice(0, 21)}X`,
          duration_ms: 218_000,
          artists: [{ name: 'The Weeknd' }],
          album: { name: 'After Hours', uri: `spotify:album:${ALBUM_ID}` },
        },
      ],
      total: 2,
      limit: 2,
      offset: 0,
    },
    artists: {
      items: [{ name: 'The Weeknd', uri: `spotify:artist:${ARTIST_ID}`, genres: ['canadian contemporary r&b'] }],
      total: 1,
      limit: 1,
      offset: 0,
    },
  };
  return {
    get: async (path: string) => (path === '/search' ? searchResponse : null),
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
  } as unknown as SpotifyClient;
};

/**
 * Call the production `search` tool through a real MCP client, with the
 * attribution boundary installed. This is the acceptance criterion itself, not
 * a proxy for it: the text read back is the text a host renders.
 */
async function callSearch(env: NodeJS.ProcessEnv = {}): Promise<{ text: string; structured?: Record<string, unknown> }> {
  const previous = { ...env };
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const server = new McpServer({ name: 'attribution-test', version: '0.0.0' });
  try {
    installAttributionBoundary(server);
    registerSearchTools(server, searchStub());
    const client = new Client({ name: 'attribution-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'blinding lights' } });
      const content = result.content as Array<{ type: string; text?: string }>;
      return {
        text: content.find((block) => block.type === 'text')?.text ?? '',
        structured: result.structuredContent as Record<string, unknown> | undefined,
      };
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

describe('the footer, on a real tool call (#696)', () => {
  it('attributes the result and links every rendered row back to Spotify', async () => {
    const { text, structured } = await callSearch();

    // Acceptance criterion 1, first half.
    assert.ok(
      text.includes('Music data supplied by Spotify'),
      `the rendered search result carried no attribution:\n${text}`,
    );
    // Acceptance criterion 3, over a MULTI-section result — the two sections
    // here are tracks and artists, so a footer emitted per section would read
    // two here rather than one.
    assert.equal(footerCount(text), 1, `expected the footer exactly once, got:\n${text}`);

    // Acceptance criterion 2, first half: a link for each row, not one link
    // for the result.
    assert.ok(
      text.includes(`https://open.spotify.com/track/${TRACK_ID}`),
      `the track row carries no link back to Spotify:\n${text}`,
    );
    assert.ok(
      text.includes(`https://open.spotify.com/artist/${ARTIST_ID}`),
      `the artist row carries no link back to Spotify:\n${text}`,
    );
    // And the structured half is untouched: the bare URI is still what a
    // programmatic consumer matches on.
    const tracks = (structured?.sections as Record<string, { items: Array<{ uri: string }> }> | undefined)?.tracks?.items ?? [];
    assert.equal(tracks[0]?.uri, `spotify:track:${TRACK_ID}`,
      'structuredContent must keep the bare spotify: URI, not the rendered link');
  });

  it('drops both when SPOTIFY_MCP_ATTRIBUTION is off, and the switch is exact', async () => {
    // Acceptance criterion 1, second half.
    const off = await callSearch({ SPOTIFY_MCP_ATTRIBUTION: '0' });
    assert.ok(
      !off.text.includes('Music data supplied by Spotify'),
      `SPOTIFY_MCP_ATTRIBUTION=0 still emitted the footer:\n${off.text}`,
    );
    assert.ok(
      !off.text.includes('https://open.spotify.com/'),
      `SPOTIFY_MCP_ATTRIBUTION=0 still emitted row links:\n${off.text}`,
    );
    // …and the tool still works. A switch that broke the call would satisfy the
    // two assertions above and nothing else.
    assert.match(off.text, /Blinding Lights/);

    // Every documented falsy spelling, not just the one in the issue.
    for (const value of FALSY_ENV_VALUES) {
      const result = await callSearch({ SPOTIFY_MCP_ATTRIBUTION: value });
      assert.ok(
        !result.text.includes('Music data supplied by Spotify'),
        `SPOTIFY_MCP_ATTRIBUTION=${value} was not honoured as OFF`,
      );
    }

    // On is the default, and an unrecognised value must not read as "off" —
    // the opposite direction from SPOTIFY_MCP_READONLY, and getting it wrong
    // would silently remove a legally required disclosure.
    for (const value of ['', '1', 'on', 'true', 'enabled', 'banana']) {
      const result = await callSearch({ SPOTIFY_MCP_ATTRIBUTION: value });
      assert.ok(
        result.text.includes('Music data supplied by Spotify'),
        `SPOTIFY_MCP_ATTRIBUTION=${JSON.stringify(value)} must leave attribution ON, since only `
          + `${FALSY_ENV_VALUES.join('/')} reads as off`,
      );
    }
  });

  it('is one boundary on every module, not one edit per row renderer', async () => {
    // The anti-vacuity check for the whole file: the boundary has to be a
    // wrapper that reached a callback registered by a module this change never
    // touched. `search.ts` is the file the issue cited, and it is unchanged.
    const { text } = await callSearch();
    assert.match(text, /TRACKS \(2 total\)/);
    assert.match(text, /ARTISTS \(1 total\)/);
    assert.ok(text.trimEnd().endsWith(CONTENT_ATTRIBUTION_NOTICE),
      `the footer belongs on the last line, not buried mid-result:\n${text}`);
  });
});

describe('the link back to Spotify', () => {
  it('resolves a share URL for every reference kind', () => {
    // `satisfies` in src/attribution.ts makes this total at compile time, so a
    // new kind cannot ship unlinked. The assertion is what proves the mapping
    // is not silently empty for a kind nobody exercised.
    for (const kind of SPOTIFY_REFERENCE_KINDS) {
      const url = spotifyWebUrl(`spotify:${kind}:${TRACK_ID}`);
      assert.equal(url, `https://open.spotify.com/${kind}/${TRACK_ID}`,
        `${kind} must have a share URL; the OpenAPI schema gives every one of these objects an external_urls`);
    }
  });

  it('refuses rather than guesses when the URI is not one it can resolve', () => {
    // A short id, an unknown kind, a malformed URI: each returns null, and the
    // caller leaves the token alone. Fabricating a path for any of them is the
    // #803 failure — a value that could not be read turned into a plausible one.
    for (const uri of [
      'spotify:track:trk1',
      'spotify:widget:0VjIjW4GlUZAMYd2vXMi3b',
      'spotify:track:',
      'spotify:track',
      '0VjIjW4GlUZAMYd2vXMi3b',
      'not a uri at all',
    ]) {
      assert.equal(spotifyWebUrl(uri), null, `${uri} must not produce a fabricated link`);
    }
  });

  it('leaves an unresolvable token byte-identical', () => {
    const row = '  • "Blinding Lights" by The Weeknd — After Hours (3:20) | URI: spotify:track:trk1';
    assert.equal(linkifyRows(row), row,
      'a row whose URI cannot be resolved must come back unchanged, not rewritten');
  });

  it('links each token beside its own URI, so a multi-URI line needs no inference', () => {
    const linked = linkifyRows(
      `  (2 items affected: spotify:track:${TRACK_ID}, spotify:album:${ALBUM_ID})`,
    );
    assert.equal(
      linked,
      `  (2 items affected: spotify:track:${TRACK_ID} (https://open.spotify.com/track/${TRACK_ID}), `
        + `spotify:album:${ALBUM_ID} (https://open.spotify.com/album/${ALBUM_ID}))`,
    );
  });

  it('is idempotent, and does not duplicate a link a tool already rendered', () => {
    const once = linkifyRows(`URI: spotify:track:${TRACK_ID}`);
    assert.equal(linkifyRows(once), once, 'a second pass must add nothing');
    // A tool that renders the link itself keeps its own spelling and gains no
    // second copy — including Spotify's `?si=` share parameter, which the
    // already-present scan reads as the same entity rather than as a different
    // URL string. A duplicate link is a cosmetic wart; a rewritten one that
    // drops the caller's tracking parameter is not.
    const already = `URI: spotify:track:${TRACK_ID} — https://open.spotify.com/track/${TRACK_ID}?si=abc`;
    assert.equal(linkifyRows(already), already);
    assert.equal(linkifyRows(already).match(/open\.spotify\.com/g)?.length, 1);
  });
});

describe('what is deliberately not attributed', () => {
  it('leaves a json text block byte-identical — it is the raw API payload', () => {
    // SPEC §5 promises `response_format: 'json'` returns "the raw API payload as
    // JSON text", and the truncation boundary goes out of its way to keep that
    // text parseable. A footer appended here would break `JSON.parse` for every
    // host relying on the promise, and would make the payload no longer the
    // API's response. The link-back is met in this mode by the payload's own
    // `external_urls.spotify`, which is Spotify's canonical link rather than a
    // reconstruction of it.
    const json = JSON.stringify({ tracks: { items: [{ uri: `spotify:track:${TRACK_ID}` }] } }, null, 2);
    assert.equal(attributeText(json), json);
    assert.doesNotThrow(() => JSON.parse(attributeText(json)));
  });

  it('still attributes prose that merely opens with a brace', () => {
    // The other side of the same rule. A prefix sniff would classify this as a
    // document and drop the footer from a rendered result.
    const prose = `{ "note": "prose, not a payload" }\nURI: spotify:track:${TRACK_ID}`;
    const out = attributeText(prose);
    assert.ok(out.includes('Music data supplied by Spotify'));
    assert.ok(out.includes(`https://open.spotify.com/track/${TRACK_ID}`));
  });

  it('leaves an error result alone', () => {
    // A validation refusal names this project's schema, not Spotify's content.
    // A footer on every result is how an attribution stops being read.
    const refusal = { content: [{ type: 'text', text: 'unknown_param: playlistname' }], isError: true };
    assert.equal(attributeResult(refusal), refusal, 'the input is returned by identity');
  });

  it('returns by identity when there is nothing to attribute', () => {
    // Note what is NOT here: a plain prose result. A text block always earns
    // the footer, including one that says "nothing to add" — that is a
    // rendered result and Sec. II.4.a does not carve out empty ones.
    for (const result of [
      { content: [{ type: 'text', text: 'refused' }], isError: true },
      { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] },
      { content: [] },
      { structuredContent: { ok: true } },
      'not a result',
      null,
    ]) {
      assert.equal(attributeResult(result), result, `${JSON.stringify(result)} must pass through unchanged`);
    }
  });

  it('does not put a second footer on a result that already carries one', () => {
    const once = withAttributionFooter('Some rendered result.');
    assert.equal(footerCount(once), 1);
    assert.equal(withAttributionFooter(once), once);
    // A track TITLED with the phrase is not a footer, and must not satisfy the
    // check — otherwise a result about such a track silently loses its
    // attribution.
    const titled = '  • "Music data supplied by Spotify." by Someone (3:00) | URI: spotify:track:'
      + TRACK_ID;
    assert.equal(footerCount(withAttributionFooter(titled)), 1,
      'a line that merely contains the phrase must not be read as the footer');
  });

  it('does not mutate the result it was handed', () => {
    const original = { content: [{ type: 'text', text: `URI: spotify:track:${TRACK_ID}` }] };
    const snapshot = JSON.stringify(original);
    const attributed = attributeResult(original) as typeof original;
    assert.notEqual(attributed, original);
    assert.equal(JSON.stringify(original), snapshot, 'the input result was mutated');
  });
});

describe('the switch the documentation names', () => {
  it('reads the same variable the configuration reference documents', () => {
    // The drift shape: a doc that describes a switch the code does not have is
    // indistinguishable from one that has it, to a reader. So the variable name
    // is read out of the document and driven through the real gate.
    const reference = readFileSync(join(ROOT, 'docs/configuration.md'), 'utf8');
    const row = /^\|[ \t]*`(SPOTIFY_[A-Z0-9_]+)`[ \t]*\|[^\n]*attribution/im.exec(reference);
    assert.ok(row, 'docs/configuration.md must carry a summary-table row for the attribution switch');
    const name = row[1] as string;

    // Read the OFF value the same row documents, and honour it.
    const offValue = /`?(0|false|no|off)`?/i.exec(row[0].replace(/`(?:0|false|no|off)`/i, ''))
      ?? /`(0|false|no|off)`/i.exec(row[0]);
    assert.ok(offValue, `the ${name} row must name the value that turns it off, so a reader knows which to set`);
    const documentedOff = (offValue[1] as string).toLowerCase();

    assert.equal(attributionEnv({ [name]: documentedOff } as NodeJS.ProcessEnv), false,
      `${name}=${documentedOff} is documented as turning attribution OFF, and the gate must agree`);
    assert.equal(attributionEnv({ [name]: '1' } as NodeJS.ProcessEnv), true);
    assert.equal(attributionEnv({} as NodeJS.ProcessEnv), true, 'the default must be ON');

    // The warning names the direction it fell, so a typo reads differently from
    // a deliberate off.
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
    try {
      assert.equal(parseAttribution('enabled'), true, 'an unrecognised value must leave attribution ON');
    } finally {
      console.error = originalError;
    }
    assert.equal(logged.length, 1, 'an unrecognised value must warn');
    assert.match(logged[0] as string, /SPOTIFY_MCP_ATTRIBUTION/);
    assert.match(logged[0] as string, /stays ON/);
  });
});

/**
 * The `/search` payload the install-site test serves, in the same shape
 * `searchStub()` above returns — the tool's own reader is what turns it into
 * rows, and those rows are what the boundary has to decorate.
 */
const searchPayload = (): Record<string, unknown> => ({
  tracks: {
    items: [{
      name: 'Blinding Lights',
      uri: `spotify:track:${TRACK_ID}`,
      duration_ms: 200_940,
      artists: [{ name: 'The Weeknd' }],
      album: { name: 'After Hours', uri: `spotify:album:${ALBUM_ID}` },
    }],
    total: 1,
    limit: 1,
    offset: 0,
  },
  artists: { items: [], total: 0, limit: 1, offset: 0 },
  albums: { items: [], total: 0, limit: 1, offset: 0 },
});

/**
 * Call `search` through the PRODUCTION server, not a hand-built one.
 *
 * `buildMcpServer` is what `src/index.ts` runs for every host, so it is the only
 * call site where "the boundary is installed" is a claim about the product. The
 * scope is passed explicitly rather than derived: `resolveToolsets('all')` so
 * every module registers, an empty `grantedScopes` because
 * `moduleBlockedByScopes` fails OPEN on an empty set, and `readOnly: false`.
 * Nothing here reads the developer's exported `SPOTIFY_*` — the three that
 * would change the answer are pinned and restored.
 */
async function callSearchOnProductionServer(): Promise<{ text: string; structured?: Record<string, unknown> }> {
  const pinned: Record<string, string> = {
    // Pinned rather than left unset: `attributionEnv()` reads process.env
    // directly, so a developer with `SPOTIFY_MCP_ATTRIBUTION=0` exported would
    // otherwise turn this into a test that passes for the wrong reason.
    SPOTIFY_MCP_ATTRIBUTION: '1',
    // A path under the hermetic home that does not exist. The acting-account
    // echo probes the token file before it will call `/me`; pointing it at a
    // developer's real `SPOTIFY_MCP_TOKEN_FILE` would have this test read a real
    // credentials file, which is the one thing the hermetic home exists to stop.
    SPOTIFY_MCP_TOKEN_FILE: DEFAULT_TOKEN_FILE,
    SPOTIFY_CLIENT_ID: 'attribution-install-test',
  };
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(pinned)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    // Before the factory, not after: `getConfig()` snapshots process.env on
    // first read, and several registrars read it during registration.
    initConfig();
    const stub = new StubSpotifyClient();
    stub.get_('/search', { respond: () => searchPayload() });
    const { sets: activeSets } = resolveToolsets('all');
    const server = await buildMcpServer(
      stub,
      {
        activeSets,
        overrides: { enable: new Set<string>(), disable: new Set<string>() },
        grantedScopes: new Set<string>(),
        readOnly: false,
      },
      { announce: false },
    );
    const client = new Client({ name: 'attribution-install-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'blinding lights' } });
      const content = result.content as Array<{ type: string; text?: string }>;
      return {
        text: content.find((block) => block.type === 'text')?.text ?? '',
        structured: result.structuredContent as Record<string, unknown> | undefined,
      };
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('the install site, on the production server (#1610)', () => {
  it('attributes a tool result through the factory a host actually gets', async () => {
    // Every other case in this file builds its own `McpServer` and calls
    // `installAttributionBoundary` itself. That is what makes the boundary's
    // BEHAVIOUR provable, and it is exactly why the file said nothing about
    // whether the boundary is ever installed: delete the one call in
    // `buildMcpServer` and the whole file stays green. The decoration is
    // correct, tested, and unreachable — the failure #696 was written against,
    // and the one a test that only ever exercises its own fixture cannot see.
    //
    // So this case goes through `buildMcpServer` and reads the text off the
    // wire, which is the same criterion as every case above it and the one
    // place the install site is observable at all. It is deliberately NOT a
    // source-text assertion over `src/server.ts`, which is how the sibling
    // #1525 boundary is pinned: reading the source proves the source contains a
    // call, not that the call does anything, and that fallback was chosen only
    // because standing the real server up was thought to be unavailable. It is
    // available — `buildMcpServer` is a factory, and
    // `tests/cli.session.test.ts` already stands it up in-process.
    const { text, structured } = await callSearchOnProductionServer();

    // `footerCount` rather than a `text.includes(...)`, so the assertion is on
    // the constant and not on a second hand-typed copy of it.
    assert.equal(footerCount(text), 1, `expected the footer exactly once, got:\n${text}`);
    assert.ok(
      text.includes(`https://open.spotify.com/track/${TRACK_ID}`),
      `the row carries no link back to Spotify:\n${text}`,
    );
    // The structured half is untouched by the boundary, which is the point of
    // it being a boundary and not a renderer change: a programmatic consumer
    // still matches on the bare URI.
    const tracks = (structured?.sections as Record<string, { items?: Array<{ uri?: string }> }> | undefined)
      ?.tracks?.items ?? [];
    assert.equal(
      tracks[0]?.uri,
      `spotify:track:${TRACK_ID}`,
      'the boundary must not rewrite the structured payload a caller parses',
    );
  });
});
