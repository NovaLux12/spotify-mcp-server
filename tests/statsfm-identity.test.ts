/**
 * The stats.fm identity contract (`STATSFM_USER_ID`) — #927.
 *
 * ## Why this file exists
 *
 * Two halves of #927 arrived together, and only one of them was a doc fix.
 * The docs had spent several passes claiming there was no identity setting
 * (`docs/statsfm.md` and `docs/cookbook.md` both asserted it, and the claim
 * was true: `grep -rn STATSFM_USER_ID src/` returned nothing). The variable is
 * now implemented, so those sentences were rewritten — which means the
 * behaviour is now load-bearing and needs a test that would fail if it were
 * removed, not a test that merely restates the prose.
 *
 * ## The property that is easy to get wrong
 *
 * Admitting an env default means making the argument `.optional()`, and that
 * **deletes the SDK's own required-field validation**. Before this change, a
 * call with no `user_id` was rejected by the SDK before a handler ran. After it,
 * nothing rejects the call except our own guard. So the guard is the entire
 * safety property, and there are two ways to lose it:
 *
 *  1. a handler that reads the argument without resolving it, quietly sending
 *     `undefined` into a URL path (`/users/undefined/top/tracks` — a real
 *     request against the wrong resource, not an error); and
 *  2. a "helpful" fallback that substitutes a placeholder when the id is
 *     missing, which converts a refusal into a confident answer about
 *     somebody else's public profile. That is the #997 shape — an unreadable
 *     value rendered as a plausible one — and it is the reason this resolver
 *     throws.
 *
 * Test 1 below is written to fail if a handler stops resolving. Test 2 pins
 * the throw. Both are mutation-tested in the PR description.
 *
 * ## Hermeticity
 *
 * `STATSFM_USER_ID` is read through `getConfig()`, which is a process-wide
 * snapshot. Every test that depends on it installs one explicitly with
 * `initConfig({})` or `initConfig({ STATSFM_USER_ID: ... })` and never mutates
 * `process.env`, so these tests cannot leak a configured id into the rest of
 * the suite — and cannot be reordered into a state where one another's config
 * is still in force. The `~/.spotify-mcp` stores are relocated by the
 * `hermetic.js` import below, which is also what keeps this file off the real
 * `taste-feedback.json`.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { initConfig, getConfig, parseStatsfmUserId } from '../src/config.js';
import { resolveStatsfmUserId } from '../src/lib/statsfm-client.js';
import { registerStatsfmTools } from '../src/tools/statsfm.js';
import { registerStatsfmTasteTools } from '../src/tools/statsfm_taste.js';
import {
  registerTasteCompositeTools,
  __setTasteCompositeFetchImpl,
  __resetTasteCompositeFetchImpl,
} from '../src/tools/taste_composites.js';
import type { SpotifyClient } from '../src/client.js';

// ---------------------------------------------------------------- fixtures

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

/** Every stats.fm path any registrar asked for, across one test. */
type PathLog = string[];

/**
 * A stats.fm client that records the paths it was asked for and answers each
 * with a shape the real API uses (`{ item }` / `{ items }`). It is deliberately
 * a bare object rather than a `StatsfmClient`: the identity contract is about
 * which path segment gets built, and asserting on the recorded path is the
 * only way to see the difference between `/users/martijn/...` and
 * `/users/undefined/...`.
 */
function recordingStatsfmClient(paths: PathLog) {
  return {
    async get(path: string): Promise<unknown> {
      paths.push(path);
      if (/\/top\/genres$/.test(path)) return { items: [{ tag: 'ambient', name: 'Ambient', streams: 10 }] };
      if (/\/top\//.test(path)) return { items: [{ artist: { name: 'A' }, track: { name: 'T' }, streams: 5 }] };
      if (/\/streams\/current$/.test(path)) return { item: null };
      if (/\/streams\/stats$/.test(path)) {
        return { item: { totalStreams: 1, totalMs: 1000, uniqueArtists: 1, uniqueTracks: 1 } };
      }
      if (/\/friends\/count$/.test(path)) return { item: 3 };
      return { item: { userId: 'u-1', customId: 'martijn', displayName: 'Martijn' } };
    },
  };
}

/** Collect the tools a registrar registers, without a network. */
function collect(register: (server: unknown, client: unknown) => void, client: unknown): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  const server = {
    tool: (name: string, _desc: string, schema: RegisteredTool['schema'], handler: RegisteredTool['handler']) =>
      registered.set(name, { name, schema, handler }),
  };
  register(server as never, client as never);
  return registered;
}

/** The SpotifyClient the composites registrar takes; identity is not its concern. */
function spotifyStubClient(): unknown {
  return {
    get: async () => ({ items: [] }),
    post: async () => ({}),
    put: async () => ({}),
    delete: async () => ({}),
  };
}

/**
 * Answer a stats.fm URL, recording the path. Used as the fetch-impl seam for
 * the taste modules, which read through the shared client rather than an
 * injected one.
 */
function statsfmResponse(url: string, paths: PathLog): Response {
  const parsed = new URL(url);
  paths.push(parsed.pathname);
  const body = statsfmBody(parsed.pathname);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Live-shaped stats.fm envelopes: `{ item }` for singles, `{ items }` for lists. */
function statsfmBody(pathname: string): unknown {
  if (/\/top\/genres$/.test(pathname)) return { items: [{ tag: 'ambient', name: 'Ambient', streams: 10 }] };
  if (/\/top\//.test(pathname)) return { items: [{ artist: { name: 'A' }, track: { name: 'T' }, streams: 5 }] };
  if (/\/streams\/current$/.test(pathname)) return { item: null };
  if (/\/streams\/stats$/.test(pathname)) {
    return { item: { totalStreams: 1, totalMs: 1000, uniqueArtists: 1, uniqueTracks: 1 } };
  }
  if (/\/friends\/count$/.test(pathname)) return { item: 3 };
  if (/\/streams\/recent$/.test(pathname)) return { items: [] };
  return { item: { userId: 'u-1', customId: 'martijn', displayName: 'Martijn' } };
}

// ---------------------------------------------------------------- the unit

test('parseStatsfmUserId treats unset, empty and whitespace-only as unset', () => {
  // These four all mean "the caller did not configure an identity", and each
  // one used to be a plausible-looking string that would have been sent as a
  // real profile name.
  assert.equal(parseStatsfmUserId(undefined), null);
  assert.equal(parseStatsfmUserId(''), null);
  assert.equal(parseStatsfmUserId('   '), null);
  assert.equal(parseStatsfmUserId('\t\n '), null);
});

test('parseStatsfmUserId keeps a real id verbatim, trimmed but not otherwise rewritten', () => {
  // No case-folding: stats.fm ids and customIds are opaque, and there is no
  // authority in this repo for their canonical spelling. Guessing one would
  // 404 against a real profile and read as "no such user".
  assert.equal(parseStatsfmUserId('martijn'), 'martijn');
  assert.equal(parseStatsfmUserId('  martijn  '), 'martijn');
  assert.equal(parseStatsfmUserId('Martijn'), 'Martijn');
  assert.equal(parseStatsfmUserId('a-b_c.1'), 'a-b_c.1');
});

test('resolveStatsfmUserId prefers the explicit argument over the environment', () => {
  initConfig({ STATSFM_USER_ID: 'from-env' });
  assert.equal(resolveStatsfmUserId('explicit', 'user_id'), 'explicit');
});

test('resolveStatsfmUserId falls back to STATSFM_USER_ID when no argument is given', () => {
  initConfig({ STATSFM_USER_ID: 'from-env' });
  assert.equal(resolveStatsfmUserId(undefined, 'user_id'), 'from-env');
});

test('resolveStatsfmUserId ignores a blank argument rather than treating it as an answer', () => {
  // A caller sending `user_id: ""` has told us nothing. Preferring the blank
  // over the configured default would send an empty segment upstream.
  initConfig({ STATSFM_USER_ID: 'from-env' });
  assert.equal(resolveStatsfmUserId('', 'user_id'), 'from-env');
  assert.equal(resolveStatsfmUserId('   ', 'user_id'), 'from-env');
});

test('resolveStatsfmUserId throws naming BOTH ways to supply the id, and the argument this tool declares', () => {
  initConfig({});
  // The message is the whole error surface now that the field is optional, so
  // it is asserted on both halves: the instruction and the tool-specific
  // argument name. Getting the second half wrong sends the reader to a field
  // the tool does not have.
  for (const param of ['user_id', 'statsfm_user'] as const) {
    assert.throws(
      () => resolveStatsfmUserId(undefined, param),
      (err: Error) => {
        assert.match(err.message, /no stats\.fm user id/);
        assert.match(err.message, new RegExp(`pass ${param}`));
        assert.match(err.message, /STATSFM_USER_ID/);
        return true;
      },
    );
  }
});

test('resolveStatsfmUserId throws rather than substituting a placeholder', () => {
  // The #997 shape. A fallback here would turn "you did not tell me who" into
  // a confident 200 about somebody else's public profile.
  initConfig({});
  let threw = false;
  try {
    resolveStatsfmUserId(undefined, 'user_id');
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'an unresolved identity must be a refusal, never a guess');
});

// ------------------------------------------- the acceptance criteria, end to end

test('ACCEPTANCE: with STATSFM_USER_ID set and no per-call argument, statsfm_top_genres returns data', async () => {
  initConfig({ STATSFM_USER_ID: 'martijn' });
  const paths: PathLog = [];
  const tools = collect(registerStatsfmTools, recordingStatsfmClient(paths));

  const result = await tools.get('statsfm_top_genres')!.handler({ response_format: 'json' });

  // The load-bearing assertion: the configured id reached the URL. `undefined`
  // in this position would be a live request for a profile named "undefined".
  assert.ok(
    paths.some((p) => p === '/users/martijn/top/genres'),
    `expected /users/martijn/top/genres, got ${JSON.stringify(paths)}`,
  );
  assert.ok(!paths.some((p) => p.includes('undefined')), 'no path may contain an unresolved identity');
  assert.equal(result.content[0]?.type, 'text');
});

test('ACCEPTANCE: with STATSFM_USER_ID set and no per-call argument, taste_listening_clock returns data', async () => {
  initConfig({ STATSFM_USER_ID: 'martijn' });
  const paths: PathLog = [];
  // The taste modules read through the process-wide shared client rather than
  // an injected one (see `statsfmGet` in statsfm_taste.ts), so the seam under
  // test here is the fetch impl, not the client argument.
  __setTasteCompositeFetchImpl(async (url) => statsfmResponse(url, paths));
  try {
    const tools = collect(registerTasteCompositeTools, spotifyStubClient());
    await tools.get('taste_listening_clock')!.handler({ response_format: 'json' });

    assert.ok(
      paths.some((p) => p.includes('/users/martijn/')),
      `expected a /users/martijn/ read, got ${JSON.stringify(paths)}`,
    );
    assert.ok(!paths.some((p) => p.includes('undefined')), 'no path may contain an unresolved identity');
  } finally {
    __resetTasteCompositeFetchImpl();
  }
});

test('ACCEPTANCE: with the variable unset and no argument, the call fails naming STATSFM_USER_ID', async () => {
  initConfig({});
  const paths: PathLog = [];
  const tools = collect(registerStatsfmTools, recordingStatsfmClient(paths));

  await assert.rejects(
    () => tools.get('statsfm_top_genres')!.handler({ response_format: 'json' }),
    // #1318: the message names the CANONICAL field. Sending the reader to a
    // deprecated spelling is a message that outlives its own advice.
    /no stats\.fm user id: pass statsfm_user or set STATSFM_USER_ID/,
  );
  // And it must fail BEFORE the network: a refusal that still issued a request
  // is not a refusal.
  assert.deepEqual(paths, [], 'a missing identity must not reach the network');
});

test('the same error names statsfm_user for the tools that declare that spelling', async () => {
  initConfig({});
  const paths: PathLog = [];
  const tools = collect(registerStatsfmTasteTools, recordingStatsfmClient(paths));

  await assert.rejects(
    () => tools.get('statsfm_taste_profile')!.handler({ range: 'lifetime' }),
    /no stats\.fm user id: pass statsfm_user or set STATSFM_USER_ID/,
  );
  assert.deepEqual(paths, []);
});

// ------------------------------------- the property that fails if a guard is dropped

test('NO HANDLER SKIPS THE GUARD: every registered stats.fm tool either resolves the identity or takes none', async () => {
  /*
   * This is the test that fails if someone adds a tool and forgets the guard,
   * and it is the reason the guard is written as a helper call rather than
   * inline at each site: an inline guard has no inventory to check against,
   * while this one enumerates the real registry.
   *
   * Each tool is called with NO identity argument and the variable unset. Two
   * outcomes are legitimate: it throws our error (it guards), or it never
   * issues a user path (it takes no identity, or another required argument
   * failed first). What must never happen is a request carrying an unresolved
   * id — that is a live call for a profile named "undefined", not an error.
   *
   * It earned its keep during development: this assertion is what caught the
   * one handler that read the identity through `(args as J).user_id as string`,
   * which the type checker and a grep for `args.user_id` both missed because
   * the cast hid it.
   */
  initConfig({});

  const registrars: Array<[string, (s: unknown, c: unknown) => void]> = [
    ['statsfm', registerStatsfmTools],
    ['taste', registerStatsfmTasteTools],
    ['tastecomposites', registerTasteCompositeTools],
  ];

  for (const [label, register] of registrars) {
    // Both the injected-client path (statsfm.ts) and the shared-fetch path
    // (the taste modules) are recorded, so no module escapes the inventory by
    // reading through a different seam.
    const paths: PathLog = [];
    const client = recordingStatsfmClient(paths);
    __setTasteCompositeFetchImpl(async (url) => statsfmResponse(url, paths));
    try {
      for (const [name, tool] of collect(register, client)) {
        // Only the tools that DECLARE an identity argument are in scope here; a
        // tool with no such argument has nothing to resolve and is covered by
        // the catalog/no-identity path instead.
        const declaresIdentity = 'user_id' in tool.schema || 'statsfm_user' in tool.schema;
        if (!declaresIdentity) continue;

        const before = paths.length;
        try {
          await tool.handler({});
        } catch (err) {
          assert.match(
            (err as Error).message,
            /no stats\.fm user id/,
            `${label}/${name} threw something other than the identity error: ${(err as Error).message}`,
          );
        }
        const issued = paths.slice(before).filter((p) => p.includes('/users/'));
        for (const p of issued) {
          assert.ok(
            !p.includes('undefined'),
            `${label}/${name} issued a request with an unresolved identity: ${p}`,
          );
          assert.ok(
            /\/users\/[^/]+\//.test(p) || /\/users\/[^/]+$/.test(p),
            `${label}/${name} issued a malformed user path: ${p}`,
          );
        }
      }
    } finally {
      __resetTasteCompositeFetchImpl();
    }
  }
});

test('the identity argument is optional in the published schema, and the description says why', async () => {
  // If this ever becomes required again, `STATSFM_USER_ID` is dead config and
  // the doctor row is lying. Asserted on the JSON Schema a host actually
  // receives from `tools/list` — the same surface the census measures — rather
  // than on prose, so a schema change cannot pass unnoticed.
  initConfig({ STATSFM_USER_ID: 'martijn' });
  const tools = collect(registerStatsfmTools, recordingStatsfmClient([]));
  const shape = tools.get('statsfm_top_genres')!.schema;
  assert.ok(shape, 'statsfm_top_genres must declare a schema');

  const jsonSchema = z.toJSONSchema(z.object(shape)) as {
    required?: string[];
    properties?: Record<string, { description?: string }>;
  };

  // #1318: `statsfm_user` is canonical and `user_id` is the deprecated alias
  // beside it. BOTH must stay out of `required` — `STATSFM_USER_ID` supplies
  // the default for either spelling, and a required field would put the SDK's
  // own error in front of the one that names the variable.
  for (const field of ['statsfm_user', 'user_id'] as const) {
    assert.ok(
      !(jsonSchema.required ?? []).includes(field),
      `${field} must not be advertised as required: ${JSON.stringify(jsonSchema.required)}`,
    );
  }

  // The reason a caller has to look past the schema for the requirement is
  // recorded where the host actually reads it. Asserted on the CANONICAL
  // field: it is the one a host choosing between two names will read.
  assert.match(
    jsonSchema.properties?.statsfm_user?.description ?? '',
    /STATSFM_USER_ID/,
    'the published description must name the default, or the host cannot know why the argument is optional',
  );
});

test('doctor reports whether the identity is configured and never echoes the value', async () => {
  // A doctor report is the kind of output that gets pasted into a public issue,
  // so presence is reportable and the handle itself is not. Driven through the
  // exported report builder rather than by poking at internals.
  const { collectDoctorReport } = await import('../src/tools/doctortool.js');
  const client = {
    get: async () => ({}),
    post: async () => ({}),
    put: async () => ({}),
    delete: async () => ({}),
  } as unknown as SpotifyClient;

  initConfig({ STATSFM_USER_ID: 'martijn-private-handle' });
  const configured = await collectDoctorReport(client);
  const configRow = configured.rows.find((r) => r.id === 'config');
  assert.ok(configRow, 'doctor must emit a config row');
  assert.match(configRow.summary, /statsfm_user_id=set/);
  assert.ok(
    !configRow.summary.includes('martijn-private-handle'),
    `the doctor config row must not echo the handle: ${configRow.summary}`,
  );

  initConfig({});
  const unset = await collectDoctorReport(client);
  const unsetRow = unset.rows.find((r) => r.id === 'config');
  assert.ok(unsetRow, 'doctor must emit a config row when unset too');
  assert.match(unsetRow.summary, /statsfm_user_id=unset/);
});

test('initConfig with no STATSFM_USER_ID leaves statsfmUserId null, so the argument stays required', async () => {
  initConfig({});
  assert.equal(getConfig().statsfmUserId, null);

  const paths: PathLog = [];
  const tools = collect(registerStatsfmTools, recordingStatsfmClient(paths));
  // Which is observable: the tool refuses rather than guessing.
  await assert.rejects(() => tools.get('statsfm_top_artists')!.handler({}), /STATSFM_USER_ID/);
});

test('loadConfig trims the value it reads from the env family it is documented in', () => {
  initConfig({ STATSFM_USER_ID: '  spaced  ' });
  assert.equal(getConfig().statsfmUserId, 'spaced');
});
