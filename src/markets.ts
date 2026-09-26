import { z } from 'zod';
import type { SpotifyClient } from './client.js';
import { getConfig } from './config.js';
import type { UserProfile } from './types/spotify.js';

/**
 * #595: the default market comes from configuration, not from the account.
 *
 * The chain used to end at `GET /me.country`, and Spotify's February 2026
 * changes removed that field, so on any registration newer than Nov-2024
 * the account lookup could only ever answer "nothing to default from" and
 * the request went out with no `market` at all. `SPOTIFY_MCP_MARKET` is
 * the one source that survives; `/me.country` is consulted only when it
 * is still present, and the negative answer is memoised so the dead
 * round-trip costs one call per process rather than one per lookup.
 */
let profileCountry: Promise<string | undefined> | null = null;

/** Test hook: forget the memoized profile-country lookup. */
export function resetProfileCountryCache(): void {
  profileCountry = null;
}

async function resolveProfileCountry(client: SpotifyClient): Promise<string | undefined> {
  profileCountry ??= client
    .get<UserProfile>('/me')
    .then((user) => user?.country)
    .catch(() => undefined);
  return profileCountry;
}

/**
 * Precedence, in order: the caller's `market` argument, SPOTIFY_MCP_MARKET,
 * then the account country when GET /me still carries one. The source
 * travels with the value, because an absent `market` parameter is not
 * observable from the response otherwise — an agent cannot otherwise
 * read a region-scoped empty catalogue as "nothing is available here".
 */
export async function resolveRequestMarket(
  client: SpotifyClient,
  marketArg: string | undefined,
): Promise<MarketResolution> {
  if (marketArg) return { market: marketArg.toUpperCase(), source: 'argument' };
  const configured = getConfig().market;
  if (configured) return { market: configured, source: 'config' };
  const account = await resolveProfileCountry(client);
  if (account) return { market: account.toUpperCase(), source: 'account' };
  return { source: 'none' };
}

/**
 * #595: ISO 3166-1 alpha-2 country codes, bundled.
 *
 * Market validation used to need a `GET /markets` round-trip, and that
 * endpoint is on Spotify's February 2026 removed list (403 for app
 * registrations newer than Nov-2024), so the round-trip could only ever
 * fail on a current registration. The code list is a fixed standard, not
 * a Spotify fact, so it is compiled in and the network call disappears.
 *
 * This list answers "is this a well-formed ISO 3166-1 alpha-2 code". It
 * does NOT claim the code is a market Spotify serves in — that fact came
 * from `GET /markets` alone and is not derivable from this table.
 */
export const ISO_3166_1_ALPHA_2: readonly string[] = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW',
  'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT',
  'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS',
  'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
];

const ISO_MARKETS: Record<string, true> = Object.fromEntries(
  ISO_3166_1_ALPHA_2.map((code) => [code, true]),
);

/** True when `code` is a well-formed ISO 3166-1 alpha-2 country code. */
export function isIsoMarketCode(code: string): boolean {
  return ISO_MARKETS[code.trim().toUpperCase()] === true;
}

/**
 * Where the market a request actually carried came from.
 *
 * `none` is a real outcome, not a gap: `/me.country` was removed from
 * `GET /me` in Spotify's February 2026 changes, so on a current
 * registration nothing may supply a default and the request goes out
 * with no `market` at all. Callers must be able to tell that apart from
 * "a market was applied", so the source travels with the value (#595).
 */
export type MarketSource = 'argument' | 'config' | 'account' | 'none';

export interface MarketResolution {
  /** The code sent on the wire, absent when `source` is `none`. */
  market?: string;
  source: MarketSource;
}

/** One-line, human-facing statement of a market resolution. */
export function describeMarket(resolution: MarketResolution): string {
  switch (resolution.source) {
    case 'argument':
      return `Market: ${resolution.market} (from the market argument).`;
    case 'config':
      return `Market: ${resolution.market} (from SPOTIFY_MCP_MARKET).`;
    case 'account':
      return `Market: ${resolution.market} (from the account profile).`;
    case 'none':
      return 'No market was applied: the market argument was omitted, SPOTIFY_MCP_MARKET is unset, and GET /me no longer carries a country (removed Feb 2026). Pass market explicitly — results are region-scoped.';
  }
}

// Issue #110: market codes are exactly two letters; lowercase input is
// normalised to uppercase before it reaches the wire. #595 adds the
// bundled ISO 3166-1 membership check, so a typo is rejected locally
// instead of after a `GET /markets` round-trip that now always 403s.
export const MARKET_CODE = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'market must be a 2-letter ISO 3166-1 alpha-2 country code, e.g. "US"')
  .refine((code) => isIsoMarketCode(code), {
    message: 'market must be a country code assigned in ISO 3166-1 alpha-2, e.g. "US"',
  })
  .transform((code) => code.toUpperCase());

/**
 * Add the applied market and its source to a shaped tool result, so a
 * caller reading `structuredContent` can tell a region-scoped answer from
 * an unscoped one. `none` is reported explicitly — the parameter being
 * absent is not observable from the response otherwise.
 */
export function withMarketSource<T extends { structuredContent?: Record<string, unknown> }>(
  result: T,
  resolution: MarketResolution,
): T {
  result.structuredContent = {
    ...result.structuredContent,
    market: resolution.market ?? null,
    market_source: resolution.source,
  };
  return result;
}
