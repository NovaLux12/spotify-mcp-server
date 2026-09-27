/**
 * Types for `scripts/lib/gated-families.mjs`.
 *
 * Same contract as `scripts/lib/mcp-client.d.mts` — see that file for why a
 * plain-JS module under `scripts/` needs a hand-written sibling.
 */

/** The subset of `GatedFamily` the harness reads. */
export interface GatedFamilyRow {
  /** Family id, stable. */
  id: string;
  /** Shipped tools that issue a request against this family. */
  tools: readonly string[];
  /** What the server does on 403. */
  fallback: 'replaced' | 'explained';
  /** Why a 403 is expected. */
  reason: 'removal' | 'gated';
}

/**
 * Read `GATED_FAMILIES` out of the built server.
 *
 * @throws when the build is absent or the table is missing/empty.
 */
export declare function loadGatedFamilies(options?: {
  root?: string;
  distRoot?: string;
}): Promise<readonly GatedFamilyRow[]>;
