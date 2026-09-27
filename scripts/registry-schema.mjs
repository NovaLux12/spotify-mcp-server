/**
 * `server.json` conformance against the MCP Registry's published JSON Schema.
 *
 * `server.json` carries `"$schema": "https://static.modelcontextprotocol.io/
 * schemas/2025-12-11/server.schema.json"`. Carrying that key is an *annotation*
 * — it tells an editor which schema to load and tells a reader where the
 * contract lives. Nothing in the tree was loading it. The MCP Registry is the
 * one party that does, and it does it at publish time: a manifest that violates
 * the schema is rejected by `mcp-publisher` with an opaque 400, after
 * `npm publish` has already made the release public. That is the worst possible
 * moment to find out, so the check that answers it belongs at PR time, and it
 * has to fail closed.
 *
 * ## Why this module is separate from the CLI
 *
 * `scripts/check-server-schema.mjs` does the I/O — read the manifest, fetch the
 * schema, print, choose an exit code. Everything a test needs to drive both
 * verdicts is here instead, so a test can hand it a planted schema and a
 * planted manifest without a network, a subprocess, or a `git stash`. The two
 * files have one implementation between them, which is what stops the CLI and
 * the test suite from becoming two checkers that can disagree.
 *
 * ## `checkManifest` returns three verdicts, not two
 *
 * `valid` / `invalid` is the obvious pair, and collapsing the third state into
 * either of them is exactly the bug this gate exists to prevent. "The schema
 * host was unreachable" is not "the manifest is fine" — it is *the question was
 * not answered*. Returning it as `valid` makes an outage indistinguishable from
 * a clean run from the outside, which is how a gate becomes decoration after
 * enough outages (AGENTS.md §6). So the third state is `unavailable`, carries
 * the reason, and is non-zero at the CLI.
 *
 * ## Why ajv is a transitive dependency here
 *
 * `ajv` and `ajv-formats` arrive via `@modelcontextprotocol/sdk`, and this
 * repository has deliberately never declared them directly — the same reasoning
 * `tests/registry-meta.test.ts` records. That makes resolution a real failure
 * mode rather than a theoretical one, so it is a first-class result
 * (`unavailable`), not a thrown error: a gate that crashes with a module
 * resolution stack trace is still a red build, but it reads as a broken runner
 * rather than a decision this script made.
 *
 * `strict: false` is required, not a preference. The published schema is
 * draft-07 and carries OpenAPI `example` annotations, which ajv's strict mode
 * rejects as unknown keywords. `addFormats` is still applied so that
 * `format: "uri"` — the keyword guarding `$schema` and `repository.url` — is
 * enforced rather than silently dropped along with the strictness complaint.
 */
import { readFile } from 'node:fs/promises';

/** @typedef {{ status: 'valid' | 'invalid' | 'unavailable', violations: string[], detail: string }} ConformanceVerdict */

/** Bound on the schema fetch so an unreachable host cannot wedge a CI job. */
export const SCHEMA_FETCH_TIMEOUT_MS = 15_000;

const AJV_UNAVAILABLE =
  'ajv/ajv-formats are transitive dependencies of @modelcontextprotocol/sdk and did not resolve';

/** ajv error objects -> one readable line per violation, kept stable enough to assert on. */
export function formatAjvErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return ['the schema produced no error detail to report'];
  return errors.map((error) => `${error.instancePath || '/'} ${error.message} (${error.schemaPath})`);
}

/**
 * Validate a parsed manifest against a parsed schema.
 *
 * Neither argument is read from disk or the network here, so every branch is
 * drivable from a fixture.
 *
 * @param {{ schema: unknown, manifest: unknown }} input
 * @returns {Promise<ConformanceVerdict>} `unavailable` when the schema could
 *   not be compiled; `invalid` when it compiled and rejected the manifest.
 */
export async function checkManifest({ schema, manifest }) {
  let ajv;
  try {
    const [{ default: Ajv }, { default: addFormats }] = await Promise.all([import('ajv'), import('ajv-formats')]);
    ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
  } catch (error) {
    return {
      status: 'unavailable',
      violations: [],
      detail: `${AJV_UNAVAILABLE} (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    // A schema that will not compile is a broken input, not a broken manifest.
    // Reporting it as a manifest violation would send a maintainer to edit a
    // file that is not at fault.
    return {
      status: 'unavailable',
      violations: [],
      detail: `the registry schema did not compile, so nothing was validated (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }

  if (validate(manifest)) {
    return { status: 'valid', violations: [], detail: '' };
  }
  return { status: 'invalid', violations: formatAjvErrors(validate.errors), detail: '' };
}

/**
 * A JSON Schema document is an object. Anything else is a body that happened to
 * parse — `JSON.parse('null')` succeeds and yields `null`, so a proxy, cache or
 * CDN answering `200` with an empty body arrives here as a *successful* fetch.
 *
 * @param {unknown} body
 * @returns {boolean}
 */
function isSchemaDocument(body) {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

/** Name the shape that arrived, so the message says what was received and not only what was wanted. */
function describeBody(body) {
  if (body === null) return 'the body was JSON null';
  if (Array.isArray(body)) return 'the body was a JSON array';
  return `the body was a JSON ${typeof body}`;
}

/**
 * Fetch the schema a manifest declares.
 *
 * Returns the parsed schema or throws with a message that says which URL failed
 * and how — the caller turns either into a non-zero exit.
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function fetchSchema(url, { fetchImpl = fetch, timeoutMs = SCHEMA_FETCH_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(
      `could not fetch ${url} within ${timeoutMs}ms (${error instanceof Error ? error.message : String(error)}); ` +
        'server.json was NOT validated. Re-run once the host is reachable, or pass --schema-file with a local copy of that URL',
    );
  }
  if (!response.ok) {
    throw new Error(`could not fetch ${url}: HTTP ${response.status} ${response.statusText}; server.json was NOT validated`);
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(`could not read the body of ${url} (${error instanceof Error ? error.message : String(error)}); server.json was NOT validated`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${url} did not return JSON (${error instanceof Error ? error.message : String(error)}); server.json was NOT validated`);
  }
  // `200` is not a schema. Returning a non-object here let `ajv.compile(null)`
  // fail downstream, which is reported as "the registry schema did not
  // compile" — i.e. as a fault in `server.json`, the one file that is not at
  // fault. A CDN answering an empty body is an ordinary outage shape, and this
  // gate's whole reason to exist is that "the question was not answered" must
  // not read as either a pass or a violation (#1491).
  if (!isSchemaDocument(body)) {
    throw new Error(`${url} did not return a JSON Schema document (${describeBody(body)}); server.json was NOT validated`);
  }
  return body;
}

/** Read and parse a JSON file, with the path in the error so a typo is obvious. */
export async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`could not read ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}
