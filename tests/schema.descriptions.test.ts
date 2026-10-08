/**
 * The prose-default gate (#1621).
 *
 * Epic #567 set an acceptance criterion of **zero prose-only default claims** — a
 * parameter whose description says "Default: 5" while its schema carries no
 * `default: 5`. The gate named in #916's acceptance was this file, and it did not
 * exist, so the criterion had no enforcement anywhere in the tree. The census's
 * `--check` byte-freshness guard does fire on a description change, but it fires
 * on ANY description change and cannot tell "added a default the schema should
 * carry" from "fixed a comma" — which is how 753 of these went unnoticed.
 *
 * ## Why a prose-only default is a defect, not a style preference
 *
 * A host reading `inputSchema.properties.limit.default` gets `5` as a typed
 * value. A host reading "Default: 5" inside a description string has to parse it
 * out of English. The whole point of a schema surface is that the default is
 * machine-readable; 310 of these currently require reading prose.
 *
 * ## Why this is a RATCHET and not a zero assertion
 *
 * Two reasons, and the second is the one that makes the first necessary.
 *
 * 1. **The aggregate payload budget is nearly full.** `SPOTIFY_MCP_TOOLSETS=all`
 *    measures 605,374 B against the 612,000 B ceiling the startup gate enforces —
 *    6,626 B of headroom. Publishing a `default` for each of the remaining 373
 *    prose-only literals costs roughly 15 B each, so the sweep this criterion
 *    asks for is ~5.6 KB and does not fit. It has to be paired with a payload
 *    REDUCTION, which is #1628's product decision about how large a default
 *    surface should be. Asserting zero today would fail on the measurement, and
 *    the only way to make it pass would be to raise the aggregate ceiling —
 *    which is the thing `AGENTS.md` §4 says to avoid and to document when done.
 *
 * 2. **A hand-typed schema default can lie.** The default in the description and
 *    the default the handler applies are two claims, and nothing in a single
 *    mechanical pass proves they agree. `AGENTS.md` §6 records two shipped bugs
 *    shaped exactly like that: a value that could not be read was coerced into a
 *    plausible number, and a parameter was sent under the wrong name. A sweep
 *    that publishes 373 schema defaults from description text would make the
 *    schema assert them too.
 *
 * So the gate pins the exact set, refuses drift in EITHER direction, and the
 * baseline is the worklist. A removal must be a deliberate edit to
 * `PROSE_ONLY_BASELINE` with its reason, which is what makes each reduction
 * reviewable instead of incidental — the same mechanism
 * `tests/payload-casts.test.ts` and `tests/manifest-comment-baseline.test.ts`
 * use, for the same reason.
 *
 * ## What the env-var allowlist is for
 *
 * A default that depends on `SPOTIFY_MCP_FETCH_ALL_CAP` genuinely cannot be a
 * schema literal, and restating it in prose is the right call. Those are not
 * defects and are allow-listed by name, each entry naming the env var that
 * supplies the value — the allowlist is the design, because it forces every
 * exception to state WHY the schema cannot carry the value.
 *
 * Run: node --import tsx --test tests/schema.descriptions.test.ts
 */
import './helpers/hermetic.js';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildFullRegistryServer } from './live-registry.js';
import { finalInputSchema } from '../src/shaping.js';

const REPO_ROOT = join(import.meta.dirname, '..');

interface Tool {
  name: string;
  inputSchema?: unknown;
}

function properties(schema: unknown): Record<string, Record<string, unknown>> {
  const projected = finalInputSchema(schema as never);
  const props = projected?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  return props as Record<string, Record<string, unknown>>;
}

/** Does this description state a default at all? */
const STATES_A_DEFAULT = /defaults?\s*(?:to|:|=)\s*\S/i;

/**
 * The environment variables that legitimately supply a prose-only default.
 *
 * A default that depends on `SPOTIFY_MCP_FETCH_ALL_CAP` genuinely cannot be a
 * schema literal — the value is not knowable at registration time — and
 * restating it in prose is the right call. Those are not defects.
 *
 * The allowlist is the design, and the reason it must exist rather than being a
 * regex is the same reason every other allowlist in this repo exists: it makes
 * each exception STATE ITS REASON. A new env var appearing in a description as
 * the source of a default has to be added here deliberately, and adding it means
 * writing down that the value cannot be a schema literal. Without the set, any
 * `SPOTIFY_MCP_*` token in a description would exempt that parameter from the
 * gate — including a typo, and including a variable that has nothing to do with
 * the parameter's default.
 *
 * Keyed by ENV VAR, not by parameter: `SPOTIFY_MCP_MAX_ITEMS` is one setting read
 * by every tool that walks a collection, and several tools state their cap in
 * terms of a different variable for the same parameter. An entry per parameter
 * would grow every time a module is added, which is the drift the gate is here
 * to stop.
 */
const ENV_VARS_THAT_SUPPLY_A_DEFAULT: ReadonlySet<string> = new Set([
  'SPOTIFY_MCP_FETCH_ALL_CAP',
  'SPOTIFY_MCP_FRESHNESS_BUDGET',
  'SPOTIFY_MCP_MARKET',
  'SPOTIFY_MCP_MAX_ITEMS',
  'SPOTIFY_MCP_SHOWRADAR_BUDGET',
  'SPOTIFY_MCP_PORTABILITY_DIR',
  'SPOTIFY_MCP_EXPORT_DIR',
]);

/** Does this description attribute its stated default to an env var? */
function envVarsNamed(description: string): string[] {
  return [...description.matchAll(/SPOTIFY_MCP_[A-Z_]+/g)].map((match) => match[0]);
}

/**
 * The pinned worklist: every `tool.parameter` whose description states a literal
 * default while its published schema carries none.
 *
 * GENERATED from the live registry and committed here, in the same spirit as
 * `tests/registry-surface.json`. It is not hand-typed, so it cannot silently
 * disagree with the surface. Reduce it by removing entries as the schemas gain
 * their `default`, and the count falling in the PR body is the whole point.
 */
const BASELINE_PATH = join(REPO_ROOT, 'tests', 'prose-only-defaults.json');

function baseline(): string[] {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as string[];
}

/** The live set, in the same `tool.parameter` form. */
async function liveProseOnlyLiterals(): Promise<Map<string, string>> {
  const server = await buildFullRegistryServer();
  const registry = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(registry)) {
    for (const [param, def] of Object.entries(properties(entry.inputSchema))) {
      const description = typeof def.description === 'string' ? def.description : '';
      if (!STATES_A_DEFAULT.test(description)) continue;
      if (def.default !== undefined) continue;
      // Environment-derived: the description names a variable the gate knows
      // supplies this value, so the schema cannot carry a literal.
      if (envVarsNamed(description).some((envVar) => ENV_VARS_THAT_SUPPLY_A_DEFAULT.has(envVar))) continue;
      out.set(`${name}.${param}`, description);
    }
  }
  return out;
}

describe('prose-only default claims (#1621)', () => {
  it('every parameter stating a literal default carries a schema default, or is on the worklist', async () => {
    const live = await liveProseOnlyLiterals();
    const pinned = new Set(baseline());

    // Drift UP is the failure this gate exists for: a new tool (or a reworded
    // description) that adds a prose-only default the schema does not carry.
    const added = [...live.keys()].filter((key) => !pinned.has(key)).sort();
    assert.deepEqual(
      added.slice(0, 25),
      [],
      `${added.length} prose-only default claim(s) are not in the baseline — the schema must carry the default, `
      + `or the entry must be added to tests/prose-only-defaults.json with a stated reason:\n  ${added.slice(0, 25).join('\n  ')}`,
    );

    // Drift DOWN is asserted too, but as a stale baseline rather than a failure
    // of the schema: a pinned entry that no longer exists means somebody
    // published the `default` without updating the worklist, and the next
    // reader would be told the number is larger than it is.
    const gone = [...pinned].filter((key) => !live.has(key)).sort();
    assert.deepEqual(
      gone,
      [],
      `${gone.length} baseline entr(ies) no longer describe the surface — remove them from `
      + `tests/prose-only-defaults.json so the count in the docs is the real one`,
    );
  });

  it('an env-derived default names an env var this gate knows, and nothing else may borrow the exemption', async () => {
    const server = await buildFullRegistryServer();
    const registry = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;

    const unknownVars = new Map<string, string[]>();
    const proseOnlyLiterals: Array<{ key: string; param: string; description: string }> = [];
    for (const [name, entry] of Object.entries(registry)) {
      for (const [param, def] of Object.entries(properties(entry.inputSchema))) {
        const description = typeof def.description === 'string' ? def.description : '';
        if (!STATES_A_DEFAULT.test(description)) continue;
        if (def.default !== undefined) continue;
        // A description that attributes its default to a variable the gate does
        // not know is claiming an exemption nobody granted. Either the variable
        // is new and belongs in the set above, or the parameter's default is a
        // literal that belongs in the schema.
        for (const envVar of envVarsNamed(description)) {
          if (!ENV_VARS_THAT_SUPPLY_A_DEFAULT.has(envVar)) {
            const list = unknownVars.get(envVar) ?? [];
            list.push(`${name}.${param}`);
            unknownVars.set(envVar, list);
          }
        }
        if (envVarsNamed(description).length === 0) proseOnlyLiterals.push({ key: `${name}.${param}`, param, description });
      }
    }
    assert.deepEqual(
      [...unknownVars].map(([envVar, where]) => `${envVar} (${where.slice(0, 3).join(', ')})`),
      [],
      'a description attributes its default to an env var this gate does not know about',
    );
  });

  it('the count in the report matches the worklist, so neither can age', async () => {
    const live = await liveProseOnlyLiterals();
    const pinned = baseline();
    // The report is the baseline's own size. Asserting the two agree is what
    // stops a hand-edited "441" in a doc from surviving a change to the schema
    // — the #562 drift this whole gate exists to prevent.
    assert.equal(pinned.length, live.size, 'the worklist length and the live count must agree');
    assert.deepEqual([...pinned].sort(), [...live.keys()].sort(), 'the worklist is the live set, entry for entry');
  });
});
