/**
 * Tests for `src/markets.ts` (#657) — the market-defaulting chain, the
 * market-gated error hint, and the bundled ISO 3166-1 table.
 *
 * The module had no importing test, and it is the single place every
 * region-scoped call site resolves its `market`. The failure paths it owns:
 *
 *   1. The negative `/me` answer is MEMOISED. Spotify removed `country` from
 *      `GET /me` in Feb 2026, so on a current registration the lookup can only
 *      ever answer "nothing to default from" — and the module's own comment
 *      says the dead round-trip must cost one call per process, not one per
 *      lookup. An un-memoised chain issues a GET /me before every market-gated
 *      tool call, forever.
 *   2. A FAILED `/me` memoises as `undefined` rather than rejecting. An
 *      unhandled rejection there would take down a read-only lookup that had
 *      nothing to ask the account in the first place.
 *   3. The market-gated hint fires ONLY for a market this server defaulted. A
 *      caller who supplied `market: "XX"` already knows what they asked for,
 *      and telling them the endpoint is market-gated is noise that hides the
 *      real error.
 *   4. `source: 'none'` is a real outcome, not a gap, and it must be
 *      reportable — an absent `market` parameter is not observable from the
 *      response, which is how a region-scoped empty catalogue reads as
 *      "nothing is available here".
 *
 * Env is driven through `initConfig(env)` with a synthetic object, never
 * `process.env`, so nothing here depends on — or disturbs — the developer's own
 * configuration.
 *
 * Run: node --import tsx --test tests/markets.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyApiError } from '../src/client.ts';
import { initConfig } from '../src/config.ts';
import {
  ISO_3166_1_ALPHA_2,
  MARKET_CODE,
  describeMarket,
  getWithMarketFallback,
  isIsoMarketCode,
  resetProfileCountryCache,
  resolveRequestMarket,
  withMarketHint,
  withMarketSource,
  type MarketResolution,
} from '../src/markets.ts';

/** A config env with no market configured, so the chain falls through to /me. */
const envWithoutMarket = { SPOTIFY_CLIENT_ID: 'test', HOME: '/nonexistent-home-for-test' } as NodeJS.ProcessEnv;

interface GetCall { path: string; params?: Record<string, string> }

/** Stub client that records every GET and answers `/me` from `profile`. */
function stubClient(profile: unknown | Error) {
  const calls: GetCall[] = [];
  return {
    calls,
    /** GETs other than the `/me` profile lookup, i.e. the call under test. */
    wire: () => calls.filter((c) => c.path !== '/me'),
    client: {
      get: async <T>(path: string, params?: Record<string, string>): Promise<T | null> => {
        calls.push({ path, params });
        if (profile instanceof Error) throw profile;
        return profile as T;
      },
    } as unknown as import('../src/client.ts').SpotifyClient,
  };
}

/**
 * Stub that serves `/me` and fails everything else, so a market hint can be
 * observed on a request that actually carried a defaulted market. Making both
 * paths fail would instead drive the chain to source "none" and prove nothing.
 */
function stubWithProfileAndFailure(country: string, error: unknown) {
  const calls: GetCall[] = [];
  return {
    calls,
    wire: () => calls.filter((c) => c.path !== '/me'),
    client: {
      get: async <T>(path: string, params?: Record<string, string>): Promise<T | null> => {
        calls.push({ path, params });
        if (path === '/me') return { country } as T;
        throw error;
      },
    } as unknown as import('../src/client.ts').SpotifyClient,
  };
}

beforeEach(() => {
  // The memo is module-level state, so each test starts from a cold process.
  resetProfileCountryCache();
  initConfig(envWithoutMarket);
});

describe('#657 markets: MARKET_CODE rejects what is not an ISO 3166-1 alpha-2 code', () => {
  it('accepts and upper-cases a well-formed code', () => {
    assert.equal(MARKET_CODE.parse('us'), 'US', 'lowercase is normalised before the wire');
    assert.equal(MARKET_CODE.parse('GB'), 'GB');
    assert.equal(MARKET_CODE.parse('De'), 'DE');
  });

  it('rejects a two-letter code ISO 3166-1 never assigned', () => {
    // The membership check is the point of #595: the old validation needed a
    // `GET /markets` round-trip, and that endpoint is on Spotify's Feb 2026
    // removed list, so a typo is caught locally instead of after a call that
    // can only 403.
    assert.throws(() => MARKET_CODE.parse('ZZ'), /ISO 3166-1/);
    assert.throws(() => MARKET_CODE.parse('XX'), /ISO 3166-1/);
    assert.throws(() => MARKET_CODE.parse('AA'), /ISO 3166-1/);
  });

  it('rejects a code that is not two letters, naming the shape', () => {
    for (const bad of ['', 'U', 'USA', 'U1', '1S', 'U S']) {
      assert.throws(() => MARKET_CODE.parse(bad), /market/, `${JSON.stringify(bad)} must be rejected`);
    }
  });
});

describe('#657 markets: the bundled ISO table', () => {
  it('is well-formed, upper-case, and free of duplicates', () => {
    // A duplicated or lower-case entry would make the membership check depend
    // on insertion order.
    const seen = new Set<string>();
    for (const code of ISO_3166_1_ALPHA_2) {
      assert.match(code, /^[A-Z]{2}$/, `${code} is not an upper-case alpha-2 code`);
      assert.equal(code, code.toUpperCase());
      assert.equal(seen.has(code), false, `${code} appears twice`);
      seen.add(code);
    }
    assert.ok(ISO_3166_1_ALPHA_2.length > 200, 'the table is a country list, not a handful of markets');
  });

  it('contains the codes a default-market install actually uses', () => {
    for (const code of ['US', 'GB', 'DE', 'JP', 'BR', 'AU', 'CA', 'IN']) {
      assert.equal(isIsoMarketCode(code), true, `${code} is assigned in ISO 3166-1`);
    }
  });

  it('is case- and whitespace-insensitive, and rejects unassigned codes', () => {
    assert.equal(isIsoMarketCode('gb'), true);
    assert.equal(isIsoMarketCode(' gb '), true);
    assert.equal(isIsoMarketCode('ZZ'), false);
    assert.equal(isIsoMarketCode('G'), false);
    assert.equal(isIsoMarketCode('GBR'), false);
  });
});

describe('#657 markets: resolveRequestMarket precedence', () => {
  it('prefers the caller argument and does not consult config or the account', async () => {
    initConfig({ ...envWithoutMarket, SPOTIFY_MCP_MARKET: 'DE' });
    resetProfileCountryCache();
    const { client, calls } = stubClient({ country: 'fr' });
    assert.deepEqual(await resolveRequestMarket(client, 'jp'), { market: 'JP', source: 'argument' });
    assert.equal(calls.length, 0, 'an explicit market needs no account lookup');
  });

  it('falls back to SPOTIFY_MCP_MARKET before the account', async () => {
    initConfig({ ...envWithoutMarket, SPOTIFY_MCP_MARKET: 'DE' });
    resetProfileCountryCache();
    const { client, calls } = stubClient({ country: 'fr' });
    assert.deepEqual(await resolveRequestMarket(client, undefined), { market: 'DE', source: 'config' });
    assert.equal(calls.length, 0, 'the config value is the second link, so /me is not called');
  });

  it('falls back to the account country, upper-cased, when nothing else applies', async () => {
    const { client, calls } = stubClient({ country: 'fr' });
    assert.deepEqual(await resolveRequestMarket(client, undefined), { market: 'FR', source: 'account' });
    assert.deepEqual(calls, [{ path: '/me', params: undefined }], 'the chain asked /me exactly once');
  });

  it('reports source "none" when /me carries no country', async () => {
    // `/me.country` was removed in Feb 2026, so this is the common outcome on
    // a current registration, and it is the case the source field exists for.
    const { client } = stubClient({ display_name: 'Jack' });
    assert.deepEqual(await resolveRequestMarket(client, undefined), { source: 'none' });
  });

  it('reports source "none" when /me itself fails', async () => {
    const { client } = stubClient(new SpotifyApiError(401, 'The access token expired'));
    assert.deepEqual(
      await resolveRequestMarket(client, undefined),
      { source: 'none' },
      'a failed profile read degrades to no default rather than rejecting the lookup',
    );
  });
});

describe('#657 markets: the profile-country memo (#595)', () => {
  it('costs one /me call per process, not one per lookup', async () => {
    // The module's stated contract: the dead round-trip must be paid once.
    // Six sequential lookups that each re-issue GET /me is the regression.
    const { client, calls } = stubClient({ country: 'fr' });
    for (let i = 0; i < 6; i += 1) {
      await resolveRequestMarket(client, undefined);
    }
    assert.equal(calls.length, 1, `expected a single memoised /me call, saw ${calls.length}`);
  });

  it('memoises the FAILED lookup too, so a rejecting /me is not re-issued', async () => {
    const { client, calls } = stubClient(new SpotifyApiError(403, 'Forbidden'));
    for (let i = 0; i < 4; i += 1) {
      assert.deepEqual(await resolveRequestMarket(client, undefined), { source: 'none' });
    }
    assert.equal(calls.length, 1, 'the negative answer is the expensive one; it is the one memoised');
  });

  it('resetProfileCountryCache clears the memo', async () => {
    const first = stubClient({ country: 'fr' });
    await resolveRequestMarket(first.client, undefined);
    assert.equal(first.calls.length, 1);
    resetProfileCountryCache();
    const second = stubClient({ country: 'fr' });
    await resolveRequestMarket(second.client, undefined);
    assert.equal(second.calls.length, 1, 'after a reset the chain re-reads /me');
  });
});

describe('#657 markets: withMarketHint', () => {
  const hintMarket = 'US';
  const notASpotifyError = new Error('socket hang up');

  it('adds the hint for a 404 on a market THIS server defaulted', () => {
    const original = new SpotifyApiError(404, 'Not found.');
    const out = withMarketHint(original, hintMarket, undefined, 'Search') as Error;
    assert.notEqual(out, original, 'the hint replaces the bare error');
    assert.match(out.message, /Spotify returned 404 for this lookup using market US\./);
    assert.match(out.message, /Search is market-gated/);
    assert.equal(out.cause, original, 'the original error rides along as cause');
  });

  it('adds the hint for a 400 as well as a 404', () => {
    for (const status of [400, 404]) {
      const out = withMarketHint(new SpotifyApiError(status, 'x'), hintMarket, undefined) as Error;
      assert.match(out.message, new RegExp(`Spotify returned ${status}`), `status ${status} needs the hint`);
    }
  });

  it('stays silent when the CALLER supplied the market', () => {
    // The caller already knows what they asked for; the hint would be noise
    // standing between them and the real error.
    const original = new SpotifyApiError(404, 'Not found.');
    assert.equal(withMarketHint(original, hintMarket, 'us'), original, 'no hint for a caller-supplied market');
  });

  it('stays silent for a status that is not a market-gating signal', () => {
    for (const status of [401, 403, 429, 500]) {
      const original = new SpotifyApiError(status, 'x');
      assert.equal(withMarketHint(original, hintMarket, undefined), original, `status ${status} must pass through`);
    }
  });

  it('stays silent for a non-Spotify error, and when no market was applied', () => {
    assert.equal(withMarketHint(notASpotifyError, hintMarket, undefined), notASpotifyError);
    const noMarket = new SpotifyApiError(404, 'Not found.');
    assert.equal(withMarketHint(noMarket, undefined, undefined), noMarket, 'source "none" is not a default to explain');
  });

  it('defaults the subject to "This endpoint" so a caller that omits it still gets a sentence', () => {
    const out = withMarketHint(new SpotifyApiError(404, 'x'), hintMarket, undefined) as Error;
    assert.match(out.message, /This endpoint is market-gated/);
  });
});

describe('#657 markets: getWithMarketFallback', () => {
  it('applies the resolved market to the wire params and reports its source', async () => {
    initConfig({ ...envWithoutMarket, SPOTIFY_MCP_MARKET: 'DE' });
    resetProfileCountryCache();
    const { client, wire } = stubClient({ country: 'fr' });
    const out = await getWithMarketFallback(client, '/browse/categories', undefined);
    assert.deepEqual(out.market, { market: 'DE', source: 'config' });
    assert.deepEqual(wire(), [{ path: '/browse/categories', params: { market: 'DE' } }]);
  });

  it('omits the market param entirely when nothing supplied one', async () => {
    const { client, wire } = stubClient({ display_name: 'Jack' });
    const out = await getWithMarketFallback(client, '/search', undefined);
    assert.deepEqual(out.market, { source: 'none' });
    assert.deepEqual(wire(), [{ path: '/search', params: {} }], 'no market key at all, not an empty one');
  });

  it('merges extra params without letting them overwrite the resolved market', async () => {
    // `extraParams` is caller data and the market is the module's decision, so
    // a caller-supplied `market` in the extras must not win. The guard is that
    // the resolved market is assigned AFTER the spread — flip that order and a
    // caller could redirect a region-scoped lookup.
    const { client, wire } = stubClient({ display_name: 'Jack' });
    await getWithMarketFallback(client, '/search', 'us', { q: 'radiohead', market: 'GB' });
    assert.deepEqual(wire(), [{ path: '/search', params: { q: 'radiohead', market: 'US' } }]);
  });

  it('passes the data through on success', async () => {
    const { client } = stubClient({ items: [{ id: '1' }] });
    const out = await getWithMarketFallback<{ items: unknown[] }>(client, '/search', 'us');
    assert.deepEqual(out.data, { items: [{ id: '1' }] });
  });

  it('rethrows the market-hinted error, with the original as cause', async () => {
    // The profile answers, so the chain defaults to FR and the request that
    // fails is the market-gated one the hint exists for.
    const { client } = stubWithProfileAndFailure('fr', new SpotifyApiError(404, 'Not found.'));
    await assert.rejects(
      () => getWithMarketFallback(client, '/search', undefined, {}, 'Search'),
      (err: Error) => {
        assert.match(err.message, /market FR/, 'the hint names the market that was actually sent');
        assert.match(err.message, /Search is market-gated/);
        assert.ok(err.cause instanceof SpotifyApiError, 'cause is the original API error');
        return true;
      },
    );
  });

  it('rethrows a market-gated error unannotated when the caller supplied the market', async () => {
    const { client, wire } = stubWithProfileAndFailure('fr', new SpotifyApiError(404, 'Not found.'));
    await assert.rejects(
      () => getWithMarketFallback(client, '/search', 'us', {}, 'Search'),
      (err: unknown) => err instanceof SpotifyApiError && err.message === 'Not found.',
    );
    assert.deepEqual(wire(), [{ path: '/search', params: { market: 'US' } }], 'precondition: the market went out');
  });

  it('rethrows an unannotated error untouched', async () => {
    const { client } = stubWithProfileAndFailure('fr', new TypeError('fetch failed'));
    await assert.rejects(
      () => getWithMarketFallback(client, '/search', undefined),
      (err: unknown) => err instanceof TypeError && err.message === 'fetch failed',
    );
  });
});

describe('#657 markets: describeMarket', () => {
  it('names the source for each of the three places a market can come from', () => {
    assert.equal(
      describeMarket({ market: 'JP', source: 'argument' }),
      'Market: JP (from the market argument).',
    );
    assert.equal(
      describeMarket({ market: 'DE', source: 'config' }),
      'Market: DE (from SPOTIFY_MCP_MARKET).',
    );
    assert.equal(
      describeMarket({ market: 'FR', source: 'account' }),
      'Market: FR (from the account profile).',
    );
  });

  it('spells out the source "none" outcome rather than saying nothing', () => {
    // The whole point of carrying the source: an absent market is invisible on
    // the wire, so a region-scoped empty answer otherwise reads as "nothing
    // exists". This sentence is the disclosure.
    const line = describeMarket({ source: 'none' });
    assert.match(line, /No market was applied/);
    assert.match(line, /SPOTIFY_MCP_MARKET is unset/);
    assert.match(line, /removed Feb 2026/);
    assert.match(line, /Pass market explicitly/);
    assert.match(line, /region-scoped/);
  });

  it('says which source produced a market for every MarketSource value', () => {
    const sources = ['argument', 'config', 'account', 'none'] as const;
    for (const source of sources) {
      const resolution: MarketResolution = source === 'none' ? { source } : { market: 'US', source };
      const line = describeMarket(resolution);
      assert.ok(line.length > 0, `source ${source} produced an empty line`);
      assert.ok(line.endsWith('.'), `source ${source} produced a truncated line: ${line}`);
    }
  });
});

describe('#657 markets: withMarketSource', () => {
  it('adds the market and its source to structuredContent', () => {
    const result = withMarketSource(
      { structuredContent: { tracks: 3 } },
      { market: 'US', source: 'argument' },
    );
    assert.deepEqual(result.structuredContent, {
      tracks: 3,
      market: 'US',
      market_source: 'argument',
    });
  });

  it('reports market as null when none was applied, so the key is always present', () => {
    // The parameter being absent is not observable from the response, so the
    // key must exist with an explicit null rather than being omitted.
    const result = withMarketSource({ structuredContent: {} }, { source: 'none' });
    assert.deepEqual(result.structuredContent, { market: null, market_source: 'none' });
    assert.equal('market' in result.structuredContent!, true);
  });

  it('preserves the fields the result already carried', () => {
    const result = withMarketSource(
      { structuredContent: { items: [], page: 2 } },
      { market: 'GB', source: 'config' },
    );
    assert.equal(result.structuredContent!.items !== undefined, true);
    assert.equal(result.structuredContent!.page, 2);
  });

  it('tolerates a result that had no structuredContent at all', () => {
    const result = withMarketSource({} as { structuredContent?: Record<string, unknown> }, {
      market: 'DE',
      source: 'config',
    });
    assert.deepEqual(result.structuredContent, { market: 'DE', market_source: 'config' });
  });
});
