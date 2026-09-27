#!/usr/bin/env node
/**
 * `server.json` registry-schema gate (#655).
 *
 * `server.json` has carried a `$schema` URL since it was added. Carrying the
 * key is not the same as validating against it, and the difference is the
 * whole point of this gate: nothing loaded that URL, so the manifest's
 * conformance was decided by whichever party happened to parse it last. The
 * MCP Registry is that party, at publish time, and it answers with an opaque
 * 400 — *after* `npm publish` has made the release public. Issue #655 asked for
 * the schema to be validated in CI so that the answer arrives at PR time,
 * where it costs a red check instead of a half-published release.
 *
 * ## Live-fetch, not vendored — and what that costs
 *
 * The schema is fetched from the URL `server.json` itself declares, every run.
 * The alternative was a copy of the schema committed to this repository.
 *
 *   - **A vendored copy rots silently.** Nobody re-fetches it, so it keeps
 *     passing long after the registry publishes a revision that would reject
 *     the manifest. The failure surfaces at `mcp-publisher`, at a release, with
 *     no diff to read. The rot is invisible until it is expensive.
 *   - **Live-fetching makes the build depend on `static.modelcontextprotocol.io`
 *     being up.** An outage of that host turns this step red on every PR. That
 *     is the accepted cost, and it is a cheap one: the failure names the URL,
 *     the elapsed budget and the reason, it is attributable to one host, and
 *     re-running once the host recovers is the whole remedy. Compare it to the
 *     vendored failure, which is not attributable, not re-runnable, and only
 *     visible after a release is half out.
 *
 *   The drift this cannot catch is stated rather than hidden: a *new* dated
 *   revision appearing upstream is not a failure here, because this validates
 *   the revision `server.json` pins. `tests/registry-meta.test.ts` owns that
 *   pin, and it fails when `$schema` moves.
 *
 * ## It fails closed
 *
 * Three ways to end without an answer — the schema host is unreachable, the
 * response is not JSON, ajv does not resolve — all exit non-zero. The gate does
 * not report success for a check it did not perform, and it does not have an
 * environment-variable bypass. A skip switch here would be a switch that
 * eventually ships set.
 *
 * ## Where it runs
 *
 * `ci.yml`, at PR time — the primary, because a manifest that violates the
 * schema should never reach a review. `publish.yml`, in the registry job and
 * *after* its `server.json` version sync — a backstop over the exact bytes
 * handed to `mcp-publisher`. Both call sites name this file; the logic is in
 * `scripts/registry-schema.mjs` and shared with the test suite, so there is one
 * checker rather than two that can disagree.
 *
 * `--manifest <path>` and `--schema-file <path>` drive the same code over
 * fixtures. That is what lets a test prove the gate goes red on a planted
 * violation without editing `server.json` and without a network (AGENTS.md §6:
 * a gate that has only ever seen a valid file proves nothing).
 *
 * Run: node scripts/check-server-schema.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { checkManifest, fetchSchema, readJson } from './registry-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function flagValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/**
 * Run the gate once. Exported so a test can call it directly, and used as the
 * single body of the CLI below — there is no second implementation to drift.
 */
export async function runServerSchemaCheck({ manifestPath, schemaPath } = {}) {
  const manifestFile = manifestPath ?? join(ROOT, 'server.json');
  const manifest = await readJson(manifestFile);

  // The exact failure this gate exists to catch, in its smallest form: a
  // manifest with no `$schema` has nothing to validate against, and reporting
  // that as a pass is how "it has a $schema key" came to be read as "it is
  // validated".
  const schemaUrl = manifest?.$schema;
  if (typeof schemaUrl !== 'string' || schemaUrl.length === 0) {
    return {
      ok: false,
      message: `${manifestFile} declares no $schema, so there is nothing to validate it against.`,
    };
  }

  const schema = schemaPath ? await readJson(schemaPath) : await fetchSchema(schemaUrl);
  const verdict = await checkManifest({ schema, manifest });

  if (verdict.status === 'unavailable') {
    return { ok: false, message: `server.json was NOT validated against ${schemaUrl}: ${verdict.detail}` };
  }
  if (verdict.status === 'invalid') {
    return {
      ok: false,
      message: `server.json violates ${schemaUrl} (${verdict.violations.length} violation(s)):\n${verdict.violations
        .map((line) => `- ${line}`)
        .join('\n')}`,
    };
  }
  return { ok: true, message: `server.json validates against ${schemaUrl} (0 violations).` };
}

async function main() {
  let result;
  try {
    result = await runServerSchemaCheck({ manifestPath: flagValue('--manifest'), schemaPath: flagValue('--schema-file') });
  } catch (error) {
    // Reading the manifest or the schema failed. Also non-zero: a gate that
    // cannot read its input has not validated anything.
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
  process.exit(0);
}

// `realpathSync` on both sides so a symlinked checkout still compares equal and
// does not re-enter main on import — without this, importing the gate from a
// test would run it and exit the test process.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
