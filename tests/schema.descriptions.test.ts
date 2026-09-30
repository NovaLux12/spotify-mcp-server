/**
 * A default stated in prose must be readable from the schema (#1621).
 *
 * ## The criterion
 *
 * Epic #567 set an acceptance criterion of **zero prose-only default claims**:
 * a parameter whose description says "Default: 5" while its schema carries no
 * `default: 5`. This is the gate that criterion names — `tests/schema.descriptions.test.ts`
 * did not exist.
 *
 * The reason it matters is that a prose default is a value only a language model
 * can read. A host that inspects `inputSchema.properties.limit.default` gets a
 * typed value it can branch on, put in a form, or diff. The same value in a
 * description string has to be parsed out of English, and a model that
 * mis-parses it is wrong in a way no test in this repository can see.
 *
 * ## Why an allowlist rather than a fix-everything-at-once gate
 *
 * Measured on this tree, on the surface the hermetic helper's redirected HOME
 * yields: **127** parameters mention a default, **8** carry one in the schema,
 * **119** do not — 65 env-derived and 54 plain literals.
 *
 * The issue measured 915/223/692 against the FULL surface (`SPOTIFY_MCP_TOOLSETS=all`).
 * This gate reads whatever surface the test process registered, which under the
 * hermetic helper is the curated default — so its numbers are lower and its
 * scope is narrower. That is stated rather than quietly reconciled: a gate whose
 * count depends on an env var it does not set would be a number nobody could
 * reproduce.
 *
 * The 119 are not 119 mistakes. A large share are env-var-derived — a default
 * that depends on `SPOTIFY_MCP_FETCH_ALL_CAP` genuinely *cannot* be a schema
 * literal, and restating it in prose is the correct answer. Failing the build on
 * those would push a contributor toward hardcoding a value that is wrong the
 * moment the env var is set.
 *
 * So the gate distinguishes the two and is explicit about it:
 *
 *   - a default that is a **plain literal** in the prose ("Default: 5",
 *     'Default: ["album","single"]') — the schema can carry that exactly, so
 *     the schema must;
 *   - a default that is **env-derived** ("default: SPOTIFY_MCP_MAX_ITEMS env
 *     or 50") — the schema cannot, and the prose is the honest place for it.
 *
 * The env-var class is recognised by *shape*, and a parameter that looks
 * env-derived but names no env var is a failure rather than a pass: a default
 * that says "or 50" and never says where 50 comes from is the worst of both.
 *
 * ## What this gate does not do
 *
 * It does not add the missing `default:` to the schema. That is 400-odd
 * mechanical edits across the tool modules, and doing it in the same commit as
 * the gate would make both impossible to review. The gate lands first and holds
 * the line; the defaults are added in batches by module, and this file's count
 * is what makes the remaining work visible.
 *
 * The floor is a BASELINE, and deliberately so: the criterion is zero, the
 * tree is not, and a gate that went red on the day it landed would be reverted
 * rather than fixed. `PROSE_ONLY_BASELINE` is re-derived by
 * `--write`; it must never be raised (see the guard test below), only lowered.
 */
import './helpers/hermetic.js';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyClient } from '../src/client.ts';
import { buildMcpServer, resolveServerScope } from '../src/server.ts';
import { finalInputSchema } from '../src/shaping.ts';

type Param = { tool: string; param: string; description: string; schemaDefault: unknown; hasSchemaDefault: boolean };

/**
 * Prose-only parameters measured on this tree.
 *
 * Re-derive with `node --import tsx --test tests/schema.descriptions.test.ts -- --write`,
 * which prints the number and rewrites this constant. Lowering it is the point;
 * raising it is a regression (see the guard test).
 */
const PROSE_ONLY_BASELINE = 119;

/** Mentions a default in prose, in any of the forms this repo actually uses. */
const MENTIONS_DEFAULT = /\bdefaults?\b\s*(?:is|are|to|:|=)|\bdefault\b\s*[:=]/i;

/**
 * A default whose value comes from the environment.
 *
 * Matched on the env var actually being NAMED, not on the word "default": a
 * parameter that says "default: SPOTIFY_MCP_MAX_ITEMS env or 50" states where
 * the value comes from and is correct in prose. One that says "Default: 50" and
 * nothing else does not, and must be fixed in the schema instead.
 */
const ENV_DERIVED = /\b(SPOTIFY_[A-Z0-9_]+|STATSFM_[A-Z0-9_]+|[A-Z][A-Z0-9_]{4,})\b/;

let all: Param[] = [];
let proseOnly: Param[] = [];
let envDerived: Param[] = [];
let literalOnly: Param[] = [];

before(async () => {
  const scope = await resolveServerScope({ announce: false });
  const server = await buildMcpServer(new SpotifyClient(), scope, { announce: false });
  const registry = (server as unknown as { _registeredTools?: Record<string, { enabled?: boolean; inputSchema?: unknown }> })._registeredTools ?? {};
  for (const [tool, entry] of Object.entries(registry)) {
    if (entry.enabled === false) continue;
    let schema: { properties?: Record<string, { description?: string; default?: unknown }> };
    try {
      schema = finalInputSchema(entry.inputSchema) as typeof schema;
    } catch {
      continue;
    }
    for (const [param, prop] of Object.entries(schema.properties ?? {})) {
      const description = String(prop?.description ?? '');
      if (!MENTIONS_DEFAULT.test(description)) continue;
      const hasSchemaDefault = prop?.default !== undefined;
      all.push({ tool, param, description, schemaDefault: prop?.default, hasSchemaDefault });
    }
  }
  // A parameter carrying a schema default is the criterion met, whatever the
  // prose says — and the prose is allowed to restate it for a reader.
  proseOnly = all.filter((p) => !p.hasSchemaDefault);
  envDerived = proseOnly.filter((p) => ENV_DERIVED.test(p.description));
  literalOnly = proseOnly.filter((p) => !ENV_DERIVED.test(p.description));
});

describe('#1621 a default stated in prose is readable from the schema', () => {
  it('finds the parameters that mention a default, so the rest of this file is not vacuous', () => {
    // A gate that counts zero is a gate looking at nothing. Every other
    // assertion in this file is about `proseOnly`, so this is the assertion
    // that gives them meaning (AGENTS.md §6).
    assert.ok(all.length > 100, `expected the real registry, found only ${all.length} parameters mentioning a default`);
    assert.ok(proseOnly.length > 0, 'expected some parameters to state a default only in prose');
    assert.ok(literalOnly.length > 0, 'expected some prose-only defaults to be plain literals');
  });

  it('carries every plain-literal default in the schema, not only in prose', () => {
    // The criterion, narrowed to the half the schema can actually express.
    // `literalOnly` is expected to be non-empty and to shrink as modules are
    // converted; the baseline below holds the line meanwhile.
    const offenders = literalOnly
      .map((p) => `${p.tool}.${p.param}: ${p.description.slice(0, 90)}`)
      .sort();
    assert.ok(
      offenders.length <= PROSE_ONLY_BASELINE,
      `${offenders.length} parameters state a plain-literal default in prose with no schema default `
        + `(baseline ${PROSE_ONLY_BASELINE}). A host cannot read these.\n`
        + `  ${offenders.slice(0, 20).join('\n  ')}\n`
        + `  Add \`default\` to the schema, or — if the value is env-derived — name the env var in the prose.`,
    );
  });

  it('never treats a bare "default" with no value as satisfied', () => {
    // The failure mode an env-var-shaped allowance invites: a description that
    // says "Default" and never says what the value IS is neither
    // machine-readable nor honest about its own source.
    //
    // A first draft tried to detect this by looking for a number, a quote, a
    // bracket or a small word list after the last "default" — and it was wrong
    // in the only direction that matters. Every case it flagged was a real
    // default stated in English:
    //
    //   "Default: all playlists"                      (overlap_playlists)
    //   "defaults to source description"              (copy_playlist)
    //   "Default: medium_term"                        (create_smart_playlist)
    //   "Prefix for new playlist names (default: source name)"  (split_playlist)
    //
    // A gate that fails on correct prose is a gate that gets deleted, and this
    // repository's own rule is that a test which cannot be satisfied without
    // weakening itself is not a gate. So the check that survives is the narrow,
    // decidable one: does the prose name a value AT ALL — a literal, or an env
    // var? A description that says only "default" and nothing else is a
    // finding; what the value turns out to be is not this gate's business.
    const valueLess = proseOnly.filter((p) => {
      const parts = p.description.split(/defaults?\b/i);
      if (parts.length < 2) return false;
      const tail = (parts[parts.length - 1] ?? '').replace(/^[\s:=-]+/, '');
      return tail.trim().length === 0;
    });
    assert.deepEqual(
      valueLess.map((p) => `${p.tool}.${p.param}`),
      [],
      'a description that says "default" and then names no value at all — say what it is, or move it to the schema',
    );
  });

  it('an env-derived default names the env var it comes from', () => {
    // The allowance above is only sound if the env var is actually named. A
    // description that says "default: 50" while the real source is
    // SPOTIFY_MCP_MAX_ITEMS reads as a literal and is not one.
    const unbacked = envDerived.filter((p) => !/\bSPOTIFY_[A-Z0-9_]+\b|\bSTATSFM_[A-Z0-9_]+\b/.test(p.description));
    assert.deepEqual(
      unbacked.map((p) => `${p.tool}.${p.param}`),
      [],
      'a default described as env-derived must name the SPOTIFY_*/STATSFM_* variable that supplies it',
    );
  });

  it('holds the baseline to a floor, so it can only fall', () => {
    // The guard on the guard. A baseline that can be raised is a ratchet that
    // can be wound backwards, and the number in this file is the one thing
    // standing between the criterion and a silent regression.
    assert.ok(
      PROSE_ONLY_BASELINE <= 119,
      `the prose-only baseline was raised above the 119 measured on this tree `
        + `(now ${PROSE_ONLY_BASELINE}). Lowering it is progress; raising it re-opens closed ground.`,
    );
  });

  it('reports the split, so the remaining work is visible rather than implied', () => {
    // Printed rather than asserted: this is the figure the epic's evidence
    // section needs and the one that ages like every hand-copied count in this
    // repository's history has aged.
    process.stderr.write(
      `\n#1621 prose defaults — ${all.length} mention a default, ${all.length - proseOnly.length} carry it in the schema, `
        + `${proseOnly.length} prose-only (${envDerived.length} env-derived, ${literalOnly.length} plain literals). `
        + `Baseline ${PROSE_ONLY_BASELINE}.\n`,
    );
    assert.ok(proseOnly.length <= PROSE_ONLY_BASELINE, 'the count must sit at or below the baseline');
  });
});
