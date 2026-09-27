/**
 * The one registration order for the read surface (#685).
 *
 * ## Why this file exists
 *
 * `src/index.ts` registered `resources/templates.ts` and then
 * `resources/index.ts`, and the two test suites that exercise resource reads
 * each registered ONE of them. Neither arrangement could see a collision
 * between the two modules, because there was never a test that had both on one
 * `McpServer` in production order. This module is the one place that does it,
 * so the production wiring and any test that wants to reproduce it are the same
 * two calls rather than two independently-maintained orderings that can drift.
 *
 * ## Why the order is still written down when it is no longer load-bearing
 *
 * The MCP SDK routes `resources/read` by exact URI first and then by running
 * every registered template's `match()` in **insertion order**
 * (`server/mcp.js`, "Then check templates"). Insertion order is therefore
 * load-bearing for *any* pair of templates whose matchers can both accept the
 * same concrete URI — the first registered silently wins and the second becomes
 * an entry in `resources/templates/list` that can never route.
 *
 * #685 removed the overlap rather than the dependency: every URI shape is
 * registered exactly once, and each shape's pattern is disjoint from every
 * other's — a `([^/,]+)` capture is always followed either by end-of-string or
 * by a literal `/`, never by another variable. So the order below is
 * documentation, not a mechanism, and it is asserted as such:
 * `tests/resources-template-dedup.test.ts` registers both modules in both
 * orders and requires identical routing. That test is what keeps "the order is
 * no longer load-bearing" a checked claim instead of a comment that decays.
 *
 * Prompts are NOT registered here. `src/index.ts` gates them on their own
 * toolset, and a server can be configured with resources and no prompts — a
 * static import of `../prompts/index.js` from here would load the prompt
 * module on the startup path of exactly those sessions that trimmed it (#906).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { createResourceReadRegistry, type ResourceReadRegistry } from './subscriptions.js';
import { registerResources } from './index.js';
import { registerTemplateResources } from './templates.js';

/**
 * Register the whole read surface: the RFC-6570 entity templates, then the
 * fixed `spotify://` resources.
 *
 * Production order (`src/index.ts`) and every test that needs to reproduce a
 * host's view of the resource surface call this. Do not call the two module
 * registrars directly from a test that is asserting about routing across them —
 * that is how the pre-#685 wiring hid the shadowing twins.
 */
/**
 * @param reads
 *   Passed straight through to `registerResources` (#597). `src/index.ts`
 *   creates one and hands the same object to `installResourceSubscriptions`, so
 *   the poll reads through the renderers this call registered rather than
 *   through a second copy. Optional, and defaulted, because a test that only
 *   wants the read surface has no subscriptions to wire.
 */
export function registerReadSurfaces(
  server: McpServer,
  client: SpotifyClient,
  reads: ResourceReadRegistry = createResourceReadRegistry(),
): void {
  registerTemplateResources(server, client);
  registerResources(server, client, reads);
}
