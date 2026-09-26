/**
 * exhaust2 enggating slice -- now a registration placeholder only (#791).
 *
 * The graceful-403 gating contract this slice used to install (the #329
 * app-registration-gated class; #428 browse_403_graceful, #429
 * gated_surface_selfflag) is cross-cutting: it is implemented at the shared
 * SpotifyClient's `get` choke point (getAllPages walks route through
 * `this.get`, so one wrapper covers every paging helper) and it decides what
 * a caller sees for every gated path.
 *
 * Registering that install as a tool module coupled a cross-cutting error
 * mapping to this module's toolset key: `SPOTIFY_MCP_DISABLE_TOOLS=
 * exhaust2enggating`, `SPOTIFY_MCP_TOOLSETS=playback` (which trims the
 * `catalog` set that carries this key), or a hand-built host toolset all
 * removed it, so the same 403 surfaced a raw Spotify message on one host and
 * the graceful explanation on another. The contract therefore lives in
 * `src/gating.ts` and is installed unconditionally by
 * `installGatedPathContract` from the client construction path in
 * `src/index.ts`.
 *
 * This module still exists, and still re-exports the classifier, because the
 * surface census (`scripts/surface-census.mjs`, guarded by
 * `tests/arch-inventory.test.ts`) imports `GATED_PATH_PATTERNS` and
 * `isGatedPath` from this path. It registers zero tools by design.
 *
 * Composition tests in tests/exhaust2_enggating.test.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';

export { GATED_PATH_PATTERNS, graceful403Message, isGatedPath } from '../gating.js';

/**
 * Slice registration. Registers no tools: the gating contract is installed
 * unconditionally from the client construction path (#791), so it must not be
 * reachable through a toolset key.
 */
export function registerExhaust2EnggatingTools(_server: McpServer, _client: SpotifyClient): void {
  // Intentionally empty -- see the module docstring.
}
