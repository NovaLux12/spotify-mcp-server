/**
 * `server.json` registry-schema gate (#655).
 *
 * Issue #655's second acceptance criterion — "`server.json` validates against
 * the MCP registry schema in CI" — was closed off by a `server.json` carrying a
 * `$schema` key and a test that read the *mirrored* limits of that schema. A
 * `$schema` key is an annotation: it tells an editor what to load and tells a
 * reader where the contract lives. Nothing loaded it. So the file looked
 * schema-annotated, the test suite looked like it checked the schema, and the
 * only party that actually validated the manifest was `mcp-publisher`, at
 * publish time, answering with an opaque 400 after `npm publish` had already
 * made the release public.
 *
 * ## What is asserted here, and why the negative cases are the point
 *
 * A validator that has only ever seen a valid manifest proves nothing — the
 * most convincing way for a check to be decoration is for it to be green on
 * every input (AGENTS.md §6). So both verdicts are driven against the *real*
 * registry schema: the committed manifest must pass, and planted violations
 * (an over-long `description`, a `name` that is not reverse-DNS, a `transport`
 * type the registry does not define, a missing `$schema`) must each be reported
 * and must exit non-zero.
 *
 * Every failure assertion checks the *message*, not just the exit status. A
 * missing script also exits non-zero — with a module-resolution stack trace
 * naming `check-server-schema.mjs` — so a status-only assertion here would
 * report the gate working while it was absent.
 *
 * ## Why the "could not run" cases are asserted at all
 *
 * `checkManifest` has three verdicts, not two: `valid`, `invalid`, and
 * `unavailable`. Collapsing an unreachable schema host into `valid` is the
 * precise bug this gate exists to prevent, so the third state is tested
 * directly against a stubbed `fetch`: an outage must be reported as "NOT
 * validated", and the message must name the URL.
 *
 * ## Network
 *
 * The live-schema cases fetch the URL `server.json` declares. A fetch failure
 * there is recorded with `t.diagnostic` and the case returns, because
 * `t.skip` would break CI's `pass == test` gate and turn one host's outage into
 * a red suite. The outage is *not* silently absorbed: `checkManifest`'s
 * fail-closed behaviour is covered hermetically below, which is what CI's
 * `check-server-schema` step relies on.
 *
 * Run: node --import tsx --test tests/server-schema.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

import { checkManifest, fetchSchema, formatAjvErrors, readJson } from '../scripts/registry-schema.mjs';
import { runServerSchemaCheck } from '../scripts/check-server-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The schema revision the committed manifest pins, read from the manifest rather than repeated. */
const SCHEMA_URL: string = JSON.parse(await readFile(join(ROOT, 'server.json'), 'utf8')).$schema;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Scratch trees live under `os.tmpdir()`: the runner executes files in parallel. */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'spotify-mcp-server-schema-'));
}

type Run = { status: number; output: string };

/**
 * Run the gate as a subprocess and return its status *and* its output.
 *
 * `execFileSync` hands back stdout and throws on a non-zero exit; this gate
 * writes findings to stderr. A helper that only returned a status would make
 * every message assertion below vacuous.
 */
function runGate(args: string[] = []): Run {
  const result = spawnSync(process.execPath, ['scripts/check-server-schema.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * The outcome of the live fetch: a schema, or the reason there is none.
 *
 * Tagged rather than nullable, because a bare `null` cannot be told apart from
 * a schema that is present and empty. `fetchSchema` used to hand one back for a
 * `200` whose body was JSON `null` (#1491), so an outage read as a schema.
 */
type LiveSchema = { ok: true; schema: Record<string, any>; reason: string } | { ok: false; schema: null; reason: string };

/**
 * Fetch the real registry schema, resolving rather than rejecting so a live
 * case can record a diagnostic instead of failing on somebody else's outage.
 *
 * The hermetic cases do not use it, so a network-less run still exercises the
 * fail-closed behaviour. `options` is threaded through so the guard below can
 * be driven against planted bodies rather than only against whatever the host
 * happens to answer.
 */
function resolveLiveSchema(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LiveSchema> {
  return fetchSchema(url, options).then(
    (schema) => ({ ok: true, schema: schema as Record<string, any>, reason: '' }),
    (error: unknown) => ({ ok: false, schema: null, reason: errorText(error) }),
  );
}

const realSchema: LiveSchema = await resolveLiveSchema(SCHEMA_URL);

/** Write a copy of the committed manifest, mutated, to a scratch dir. Never touches `server.json`. */
async function malformedCopy(dir: string, name: string, mutate: (manifest: any) => any): Promise<string> {
  const manifest = JSON.parse(await readFile(join(ROOT, 'server.json'), 'utf8'));
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(mutate(manifest), null, 2)}\n`);
  return path;
}

/**
 * The live schema, or `null` after recording why there is not one.
 *
 * A caller that receives `null` returns early, so an outage skips its live
 * cases instead of running them against no schema at all. One value makes one
 * decision, so there is no second condition here that could disagree with this
 * one. The previous version answered a separate boolean over `if (realSchema)`,
 * where `realSchema` was a *promise* — always truthy, so the guard could not
 * fire for any outcome at all, including a rejection (#1491). A guard that
 * cannot return "outage" is not an outage guard, and the suite read somebody
 * else's outage as four manifest failures.
 */
function liveSchemaOrSkip(t: TestContext, live: LiveSchema, reason: string): Record<string, any> | null {
  if (live.ok) return live.schema;
  t.diagnostic(`live registry schema not fetched (${live.reason || reason}); the hermetic cases below still ran`);
  return null;
}

describe('server.json against the registry schema it declares (#655)', () => {
  it('validates the committed manifest against the schema its $schema names', async (t) => {
    const schema = liveSchemaOrSkip(t, realSchema, SCHEMA_URL);
    if (!schema) return;
    // The fetched document must be the real registry schema, not an error page
    // or an empty object that happens to accept everything — without this, the
    // "0 violations" below would be a statement about a 404 body.
    assert.equal(
      schema?.definitions?.ServerDetail?.properties?.description?.maxLength,
      100,
      `the document fetched from ${SCHEMA_URL} is not the registry schema this manifest is written against`,
    );

    const manifest = await readJson(join(ROOT, 'server.json'));
    const verdict = await checkManifest({ schema, manifest });
    assert.equal(
      verdict.status,
      'valid',
      `the committed server.json violates ${SCHEMA_URL}: ${verdict.violations.join('; ') || verdict.detail}`,
    );
  });

  it('goes red on a description past the registry cap, and green once restored', async (t) => {
    const schema = liveSchemaOrSkip(t, realSchema, SCHEMA_URL);
    if (!schema) return;
    const dir = await scratch();
    const schemaFile = join(dir, 'schema.json');
    await writeFile(schemaFile, JSON.stringify(schema));

    // The cap the registry enforces is 100 characters; the notice is carried
    // inside the capability claim precisely so this budget holds. Pushed over,
    // `mcp-publisher` rejects the manifest at publish time.
    const good = await malformedCopy(dir, 'good.json', (manifest) => manifest);
    const clean = await runGate(['--manifest', good, '--schema-file', schemaFile]);
    assert.equal(clean.status, 0, `an untouched copy must pass; it reported: ${clean.output}`);
    assert.match(clean.output, /0 violations/, 'the success line must state that zero violations were found');

    const bad = await malformedCopy(dir, 'long-description.json', (manifest) => ({
      ...manifest,
      description: `${manifest.description} ${'x'.repeat(120)}`,
    }));
    const failure = await runGate(['--manifest', bad, '--schema-file', schemaFile]);
    assert.equal(failure.status, 1, 'a manifest past the registry description cap must fail the gate');
    assert.match(
      failure.output,
      /\/description must NOT have more than 100 characters/,
      `the failure must name the violated keyword, not merely report a non-zero exit: ${failure.output}`,
    );
    assert.match(failure.output, /\/description/, 'the failure must name the offending property');

    // Restored: the committed manifest is still green, so the red above was the
    // planted copy and not a broken gate.
    assert.equal(runGate(['--manifest', good, '--schema-file', schemaFile]).status, 0, 'restoring the copy must go green again');
  });

  it('goes red on a name the registry will not accept as reverse-DNS', async (t) => {
    const schema = liveSchemaOrSkip(t, realSchema, SCHEMA_URL);
    if (!schema) return;
    const dir = await scratch();
    const schemaFile = join(dir, 'schema.json');
    await writeFile(schemaFile, JSON.stringify(schema));
    const bad = await malformedCopy(dir, 'flat-name.json', (manifest) => ({ ...manifest, name: 'spotify-mcp-server' }));

    const failure = await runGate(['--manifest', bad, '--schema-file', schemaFile]);
    assert.equal(failure.status, 1, 'a non reverse-DNS server name must fail the gate');
    assert.match(failure.output, /\/name must match pattern/, `the failure must name the pattern keyword: ${failure.output}`);
  });

  it('goes red on a transport type the registry does not define', async (t) => {
    const schema = liveSchemaOrSkip(t, realSchema, SCHEMA_URL);
    if (!schema) return;
    const dir = await scratch();
    const schemaFile = join(dir, 'schema.json');
    await writeFile(schemaFile, JSON.stringify(schema));
    const bad = await malformedCopy(dir, 'bad-transport.json', (manifest) => {
      manifest.packages[0].transport = { type: 'carrier-pigeon' };
      return manifest;
    });

    const failure = await runGate(['--manifest', bad, '--schema-file', schemaFile]);
    assert.equal(failure.status, 1, 'an undefined transport type must fail the gate');
    assert.match(failure.output, /\/packages\/0\/transport/, `the failure must locate the bad transport: ${failure.output}`);
  });
});

describe('the live-schema outage guard fires, on every failure mode (#1491)', () => {
  // The guard exists so somebody else's outage does not land as a manifest
  // failure. It could not do that: it read `if (realSchema)` on a *promise*,
  // which is always truthy, so it never returned `true` for anything —
  // including a rejected fetch, which the file's own header claimed was
  // covered. "Only rejections were covered" was not the state of the code.
  const answering = (body: string) =>
    ({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(body) }) as unknown as Response;

  it('records a fetch that threw as an outage, with no schema', async () => {
    const live = await resolveLiveSchema('https://example.test/server.schema.json', {
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
      timeoutMs: 50,
    });
    assert.equal(live.ok, false, 'a fetch that threw is an outage, not a schema');
    assert.equal(live.schema, null, 'an outage must not hand the live cases a schema to run against');
    assert.match(live.reason, /was NOT validated/, 'the diagnostic must say the fetch did not run, not that it passed');
  });

  it('records a 200 whose body is JSON null as an outage, with no schema', async () => {
    // The shape that actually happened: the host answered, and the answer was
    // nothing. A resolved `null` used to sail through the truthiness check.
    const live = await resolveLiveSchema('https://example.test/server.schema.json', {
      fetchImpl: () => Promise.resolve(answering('null')),
      timeoutMs: 50,
    });
    assert.equal(live.ok, false, 'a body that parsed to no schema is an outage, however cleanly it fetched');
    assert.equal(live.schema, null);
  });

  it('records a 200 that is not a schema at all as an outage', async () => {
    const live = await resolveLiveSchema('https://example.test/server.schema.json', {
      fetchImpl: () => Promise.resolve(answering('<html>maintenance</html>')),
      timeoutMs: 50,
    });
    assert.equal(live.ok, false, 'an HTML error page served with 200 is an outage, not a schema');
    assert.equal(live.schema, null);
  });

  it('yields the schema when the host really answered with one', async () => {
    // The direction that matters for the guard being trustworthy: a guard that
    // cannot return `false` would skip every live case and this file would
    // report green without ever having read the schema.
    const document = { definitions: { ServerDetail: { properties: { description: { maxLength: 100 } } } } };
    const live = await resolveLiveSchema('https://example.test/server.schema.json', {
      fetchImpl: () => Promise.resolve(answering(JSON.stringify(document))),
      timeoutMs: 50,
    });
    assert.equal(live.ok, true, 'a real schema document is not an outage');
    assert.deepEqual(live.schema, document);
  });

  it('yields no schema for an outage and records a diagnostic; yields the schema otherwise', () => {
    const diagnostics: string[] = [];
    const t = { diagnostic: (message: string) => void diagnostics.push(message) } as unknown as TestContext;
    const outage: LiveSchema = { ok: false, schema: null, reason: 'could not fetch … server.json was NOT validated' };

    assert.equal(liveSchemaOrSkip(t, outage, 'https://example.test/s.json'), null, 'an outage must skip the live case');
    assert.equal(diagnostics.length, 1, 'the skip must be recorded, not silent');
    assert.match(diagnostics[0], /was NOT validated/, 'the diagnostic must carry the fetch failure reason');
    assert.match(diagnostics[0], /hermetic cases below still ran/, 'the diagnostic must say what still ran');

    diagnostics.length = 0;
    const present: LiveSchema = { ok: true, schema: { definitions: {} }, reason: '' };
    assert.deepEqual(
      liveSchemaOrSkip(t, present, 'https://example.test/s.json'),
      present.schema,
      'a fetched schema must run the case with the schema itself',
    );
    assert.deepEqual(diagnostics, [], 'a live case that runs must not claim the network was unavailable');
  });
});

describe('a manifest with nothing to validate against is a failure, not a pass', () => {
  it('fails a manifest that declares no $schema', async () => {
    // The smallest form of the bug this gate closes: a manifest whose `$schema`
    // is absent cannot be validated, and reporting that as success is exactly
    // how "it has a $schema key" came to be mistaken for "it is validated".
    const dir = await scratch();
    const manifestPath = await malformedCopy(dir, 'no-schema.json', (manifest) => {
      delete manifest.$schema;
      return manifest;
    });

    const result = await runServerSchemaCheck({ manifestPath, schemaPath: join(dir, 'unused.json') });
    assert.equal(result.ok, false, 'a manifest with no $schema must not report success');
    assert.match(result.message, /declares no \$schema/, `the message must say why: ${result.message}`);
  });

  it('fails a manifest whose $schema is not a string', async () => {
    const dir = await scratch();
    const manifestPath = await malformedCopy(dir, 'numeric-schema.json', (manifest) => {
      manifest.$schema = 20251211;
      return manifest;
    });

    const result = await runServerSchemaCheck({ manifestPath, schemaPath: join(dir, 'unused.json') });
    assert.equal(result.ok, false, 'a non-string $schema must not report success');
    assert.match(result.message, /declares no \$schema/);
  });

  it('fails a manifest that is not valid JSON, naming the file', async () => {
    const dir = await scratch();
    const manifestPath = join(dir, 'truncated.json');
    await writeFile(manifestPath, '{ "name": ');

    const run = runGate(['--manifest', manifestPath, '--schema-file', join(dir, 'unused.json')]);
    assert.equal(run.status, 1, 'unparseable JSON must fail the gate');
    assert.match(run.output, /truncated\.json is not valid JSON/, `the message must name the file: ${run.output}`);
  });
});

describe('the gate fails closed when it cannot run', () => {
  it('reports an unreachable schema host as "NOT validated", not as valid', async () => {
    const url = 'https://static.modelcontextprotocol.invalid.example/server.schema.json';
    await assert.rejects(
      fetchSchema(url, { fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')), timeoutMs: 50 }),
      (error: Error) => {
        assert.match(error.message, /was NOT validated/, 'the message must distinguish "not checked" from "passed"');
        assert.match(error.message, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the message must name the URL');
        assert.match(error.message, /--schema-file/, 'the message must offer the offline remedy');
        return true;
      },
    );
  });

  it('reports a non-2xx response as "NOT validated"', async () => {
    const notFound = { ok: false, status: 404, statusText: 'Not Found' } as unknown as Response;
    await assert.rejects(
      fetchSchema('https://example.test/server.schema.json', { fetchImpl: () => Promise.resolve(notFound), timeoutMs: 50 }),
      /HTTP 404 Not Found; server\.json was NOT validated/,
    );
  });

  it('reports a non-JSON response as "NOT validated"', async () => {
    const html = { ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve('<html>maintenance</html>') } as unknown as Response;
    await assert.rejects(
      fetchSchema('https://example.test/server.schema.json', { fetchImpl: () => Promise.resolve(html), timeoutMs: 50 }),
      /did not return JSON \(.*\); server\.json was NOT validated/,
    );
  });

  it('reports a body that parsed but is not a schema as "NOT validated" (#1491)', async () => {
    // `JSON.parse('null')` succeeds, so a `200` carrying an empty body used to
    // return from `fetchSchema` as a *successful* fetch. The null then reached
    // `ajv.compile`, which cannot compile it, and that was reported as "the
    // registry schema did not compile" — a fault in `server.json`, which is
    // the one file not at fault. Every body that parses to a non-object is the
    // same outage shape, so every one of them must be rejected here.
    const bodies: [string, string][] = [
      ['null', 'null'],
      ['an array', '[]'],
      ['a number', '42'],
      ['a string', '"maintenance"'],
      ['a boolean', 'true'],
    ];
    for (const [label, body] of bodies) {
      const response = { ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(body) } as unknown as Response;
      await assert.rejects(
        fetchSchema('https://example.test/server.schema.json', { fetchImpl: () => Promise.resolve(response), timeoutMs: 50 }),
        (error: Error) => {
          assert.match(error.message, /did not return a JSON Schema document/, `a body of ${label} must not count as a fetched schema`);
          assert.match(error.message, /was NOT validated/, 'the message must distinguish "not checked" from "passed"');
          assert.match(
            error.message,
            /the body was (JSON null|a JSON (array|number|string|boolean))/,
            `the message must name what arrived, not only what was wanted: ${error.message}`,
          );
          return true;
        },
        `a 200 whose body is ${label} must be reported as an outage`,
      );
    }
  });

  it('reports a schema that will not compile as unavailable, not as a manifest violation', async () => {
    // A broken schema is a broken input. Blaming the manifest for it would send
    // a maintainer to edit a file that is not at fault.
    const verdict = await checkManifest({ schema: { type: 'not-a-json-schema-type' }, manifest: { name: 'a/b' } });
    assert.equal(verdict.status, 'unavailable');
    assert.match(verdict.detail, /did not compile/);
  });

  it('surfaces an unavailable verdict as a non-zero result at the gate', async () => {
    const result = await runServerSchemaCheck({ manifestPath: join(ROOT, 'server.json'), schemaPath: join(ROOT, 'package.json') });
    assert.equal(result.ok, false, 'a manifest validated against a schema that will not compile must not report success');
    assert.match(result.message, /was NOT validated/, `the message must say the check did not run: ${result.message}`);
  });
});

describe('checkManifest on planted inputs, in both directions', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', pattern: '^[a-z]+/[a-z]+$' }, count: { type: 'integer' } },
  };

  it('reports valid for a manifest the schema accepts', async () => {
    const verdict = await checkManifest({ schema, manifest: { name: 'acme/widget', count: 3 } });
    assert.equal(verdict.status, 'valid');
    assert.deepEqual(verdict.violations, []);
  });

  it('reports the property, the keyword and the schema path for a violation', async () => {
    const verdict = await checkManifest({ schema, manifest: { name: 'flat', count: 'three' } });
    assert.equal(verdict.status, 'invalid');
    const joined = verdict.violations.join('\n');
    assert.match(joined, /\/name must match pattern/, 'the violation must name the instance path and the keyword');
    assert.match(joined, /\/count must be integer/, 'allErrors must be on, so both violations are reported');
    assert.match(joined, /#\/properties\/name\/pattern/, 'the schema path must be reported so a reader can look it up');
  });

  it('never reports a missing error list as an empty pass', () => {
    // `validate(manifest) === true` with no `.errors` is the shape that turns a
    // formatting bug into a silent green.
    assert.deepEqual(formatAjvErrors(null), ['the schema produced no error detail to report']);
    assert.deepEqual(formatAjvErrors([]), ['the schema produced no error detail to report']);
    assert.equal(formatAjvErrors([{ instancePath: '/a', message: 'is bad', schemaPath: '#/x' }])[0], '/a is bad (#/x)');
  });
});

describe('the gate is wired into CI at PR time and at publish time', () => {
  /**
   * The exact command both workflows run.
   *
   * Asserting on this literal — rather than on each file containing *some*
   * invocation — is what stops the two call sites drifting into two different
   * checks. Editing one workflow's command changes the string and fails here.
   */
  const GATE_COMMAND = 'node scripts/check-server-schema.mjs';

  it('ci.yml runs the gate on pull requests, before the test suite', async () => {
    const workflow = await readFile(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.ok(
      workflow.includes('pull_request'),
      'ci.yml must run on pull_request, or a schema violation is only discovered at a release',
    );
    assert.ok(workflow.includes(GATE_COMMAND), `ci.yml must run \`${GATE_COMMAND}\` at PR time`);
    const gateAt = workflow.indexOf(GATE_COMMAND);
    const suiteAt = workflow.indexOf('npm run test:coverage');
    assert.ok(suiteAt > gateAt, 'the gate must run before the test suite, so a violation is reported first');
  });

  it('publish.yml runs the same gate over the version-synced manifest', async () => {
    const workflow = await readFile(join(ROOT, '.github/workflows/publish.yml'), 'utf8');
    assert.ok(workflow.includes(GATE_COMMAND), `publish.yml must run \`${GATE_COMMAND}\` before handing server.json to the registry`);

    // After the version sync, because the sync is what produces the bytes that
    // reach mcp-publisher. Validating the pre-sync file would leave the one
    // transformation this workflow applies to the manifest unchecked.
    const syncAt = workflow.indexOf('Sync server.json version from tag');
    assert.ok(syncAt > -1, 'publish.yml must still sync server.json from the tag');
    const gateAt = workflow.indexOf(GATE_COMMAND);
    assert.ok(gateAt > syncAt, 'the gate must run after the server.json version sync, over the manifest that is published');

    const publishAt = workflow.indexOf('./mcp-publisher publish');
    assert.ok(gateAt < publishAt, 'the gate must run before the registry publish, not after it');
  });

  it('both call sites name the same command, so they cannot drift apart', async () => {
    const occurrences = await Promise.all(
      ['ci.yml', 'publish.yml'].map(async (name) => {
        const workflow = await readFile(join(ROOT, '.github/workflows', name), 'utf8');
        return workflow.split(GATE_COMMAND).length - 1;
      }),
    );
    assert.deepEqual(occurrences, [1, 1], `each workflow must run the gate exactly once; found ${occurrences.join(' and ')}`);
  });

  it('the gate needs its dependencies installed wherever it runs', async () => {
    // ajv/ajv-formats arrive transitively via @modelcontextprotocol/sdk. The
    // registry publish job historically ran no install, so a gate there would
    // have resolved nothing and reported "unavailable" — a red build on every
    // release, or, if the failure were ever softened, a silently skipped check.
    const workflow = await readFile(join(ROOT, '.github/workflows/publish.yml'), 'utf8');
    const gateAt = workflow.indexOf(GATE_COMMAND);
    const registryJob = workflow.indexOf('publish-mcp-registry:');
    assert.ok(registryJob > -1 && gateAt > registryJob, 'the gate must live in the publish-mcp-registry job');
    const installAt = workflow.indexOf('npm ci', registryJob);
    assert.ok(
      installAt > -1 && installAt < gateAt,
      'the publish-mcp-registry job must install dependencies before the gate, so ajv resolves',
    );
    // The job used to run no Node at all — a prebuilt binary and the registry.
    // The gate is JS, so pinning the runtime keeps a runner-image default
    // change from deciding whether a release validates.
    assert.ok(
      workflow.indexOf('actions/setup-node@', registryJob) > registryJob &&
        workflow.indexOf('actions/setup-node@', registryJob) < gateAt,
      'the publish-mcp-registry job must pin a Node runtime before the gate',
    );
  });
});
