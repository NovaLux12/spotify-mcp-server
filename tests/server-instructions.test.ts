/**
 * Server instructions: host guidance on the `initialize` wire (#690).
 *
 * ## The gap this closes
 *
 * #705 put the non-affiliation notice in the `initialize` response and nothing
 * else. The response was still one string away from useful: a host that reads
 * only `initialize` and `tools/list` — the whole payload, before any tool call
 * — was told the project is unaffiliated and nothing about how to use the
 * server. It had to infer the discovery trio, the `dry_run` convention, the
 * toolset knobs and the receipt lifetime by reading 555 KiB of tool schemas,
 * which is exactly where the context budget goes.
 *
 * ## Why the wire test is the one that matters
 *
 * The other assertions here read `SERVER_INSTRUCTIONS` from the module. That
 * is cheap and it catches a string that lost its content, but it passes
 * unchanged if `src/index.ts` computes the constant and then never hands it to
 * `McpServer` — which is the exact regression the `{ instructions }` argument
 * can introduce, and which is invisible to any test that reads the source
 * rather than the process.
 *
 * So the load-bearing test spawns the real server over stdio and reads
 * `initialize.result.instructions` back off the wire. Reverting the fix in
 * `src/index.ts` alone makes it red; reverting the text alone makes it red.
 * Both halves have to be true for it to pass.
 *
 * ## The control, and why it is not decoration
 *
 * A spawn-and-assert harness can be broken in the direction that always
 * passes: if `initialize` rejects, or resolves with a result that has no
 * `instructions` key, a lenient reader returns `undefined` and an `includes`
 * on `undefined` would throw in a way that reads like a broken string rather
 * than a broken server. The first test therefore asserts the field is a
 * non-empty string BEFORE anything asserts on its content, and a fixture server
 * that genuinely omits `instructions` is spawned to prove the harness reports
 * that as the absence it is.
 *
 * Run: node --import tsx --test tests/server-instructions.test.ts
 */
import './helpers/hermetic.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BRANDING_NOTICE, NON_AFFILIATION_NOTICE, SHORT_NON_AFFILIATION_NOTICE } from '../src/branding.js';
import { SERVER_INSTRUCTIONS } from '../src/serverinstructions.js';
import { StdioJsonRpcChild, hermeticServerEnv } from './helpers/stdio-child.js';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_TIMEOUT_MS = 30_000;

/** The issue's own cap. `#690 acceptance criteria: "under ~1 KiB"`. */
const INSTRUCTIONS_BYTE_BUDGET = 1024;

/**
 * The env a spawned server gets.
 *
 * `hermeticServerEnv` builds a fresh `HOME` under the hermetic root and
 * scrubs every `SPOTIFY_*` variable, so nothing here can read or write the
 * real `~/.spotify-mcp`. `SPOTIFY_SCOPES` is deleted rather than emptied:
 * #617 rejects a set-but-empty value, so an empty string is a different code
 * path from absent.
 */
function childEnv(): NodeJS.ProcessEnv {
  const { env } = hermeticServerEnv({ SPOTIFY_SCOPES: undefined }, 'instr690');
  return env;
}

/** `initialize.result.instructions` read off a spawned server process. */
async function initializeInstructions(entry: string): Promise<string | undefined> {
  const child = StdioJsonRpcChild.spawn({
    label: `server-instructions ${entry}`,
    command: process.execPath,
    args: ['--import', 'tsx/esm', entry],
    cwd: ROOT,
    env: childEnv(),
    requestTimeoutMs: CLI_TIMEOUT_MS,
  });
  try {
    const init = await child.initialize('instr690-host');
    return init.result?.instructions as string | undefined;
  } finally {
    await child.dispose();
  }
}

/**
 * The whole-file bound (#1569).
 *
 * This file spawns real child processes, so a child whose tree still holds an
 * inherited stdio write end can keep this process's `PipeWrap` registered and the
 * loop undrainable — the #1365 failure, which is silent and unbounded because the
 * runner is invoked with no `--test-timeout`. See `helpers/file-deadline.ts`.
 *
 * Armed at module scope, above every hook, because a bound a teardown can clear is
 * not a bound. The timer is `unref`'d, so it cannot itself delay this file.
 */
armFileDeadline({
  label: 'tests/server-instructions.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

describe('#690 the instructions reach the initialize wire', () => {
  let onTheWire: string | undefined;

  before(async () => {
    onTheWire = await initializeInstructions('src/index.ts');
  });

  after(() => {
    onTheWire = undefined;
  });

  it('is a non-empty string on the response, not a missing key', () => {
    // The precondition every content assertion below rests on. Without it a
    // dropped `{ instructions }` argument and an empty one look identical, and
    // `undefined` would reach the `includes` calls as a confusing TypeError.
    assert.equal(
      typeof onTheWire,
      'string',
      'initialize.result.instructions must be present. The SDK only adds the key when the '
        + 'McpServer was constructed with `{ instructions }` (node_modules/@modelcontextprotocol/sdk '
        + 'server/index.js, `_oninitialize`), so a missing key means src/index.ts stopped passing it.',
    );
    assert.ok(
      (onTheWire ?? '').length > 0,
      'initialize.result.instructions must not be empty. An empty string is dropped by the SDK\'s '
        + 'own `...(this._instructions && { instructions })` spread, so it ships as no field at all.',
    );
  });

  it('is exactly the exported constant, so the two cannot drift', () => {
    assert.equal(
      onTheWire,
      SERVER_INSTRUCTIONS,
      'the wire value must equal the exported SERVER_INSTRUCTIONS. Reading one of two authored '
        + 'copies is how the surface and its test disagree; this is the assertion that says there is '
        + 'only one copy.',
    );
  });

  it('carries the non-affiliation notice, leading (#705 must not regress)', () => {
    assert.ok(
      (onTheWire ?? '').startsWith(BRANDING_NOTICE),
      `the instructions must start with BRANDING_NOTICE. #705 put the notice here because the name `
        + `begins with "Spot", and it is the only surface a host-only agent sees. Leading, not `
        + `merely present, because a host that trims a long string keeps the start. Got: `
        + `${JSON.stringify((onTheWire ?? '').slice(0, 90))}`,
    );
  });

  it('names the discovery trio, so a host can locate a tool without guessing', () => {
    for (const tool of ['find_tool', 'inspect_tool', 'toolset_report']) {
      assert.ok(
        (onTheWire ?? '').includes(tool),
        `the instructions must name ${tool}. It is the pointer that replaces "read 555 KiB of tool `
          + 'schemas to work out which verb applies", and a host that cannot reach it falls back to '
          + 'exactly that.',
      );
    }
  });

  it('states the dry_run convention, and states the playback exception too', () => {
    const text = onTheWire ?? '';
    assert.match(
      text,
      /dry_run/,
      'the instructions must state the dry_run convention. It is the single most consequential '
        + 'thing a host cannot infer: it decides whether an omitted flag previews or commits.',
    );
    // The issue's suggested wording was "destructive tools preview by default; pass dry_run:false
    // to apply". That is FALSE for the playback family, which uses PlaybackDryRun
    // (shaping.ts, #836) and defaults to FALSE -- an omitted dry_run commits. Shipping the issue's
    // sentence would have taught an agent to pass dry_run:false as "the safe explicit form"
    // everywhere, which is precisely the destructive default the flag exists to prevent. So the
    // exception has to be stated, and this is the test that fails if someone "simplifies" the
    // line back to the issue's version.
    assert.match(
      text,
      /playback[^\n]*default[s]? to false/i,
      'the instructions must state that the playback family defaults dry_run to false. '
        + 'PlaybackDryRun (src/shaping.ts) defaults FALSE while DryRunDefault defaults TRUE; a '
        + 'blanket "preview by default" line is wrong for play/pause/skip_next/set_volume/mute, and '
        + 'wrong in the destructive direction. See #836 and the dry_run comment in shaping.ts.',
    );
  });

  it('names both toolset knobs and the receipt lifetime', () => {
    const text = onTheWire ?? '';
    for (const envVar of ['SPOTIFY_MCP_TOOLSETS', 'SPOTIFY_MCP_READONLY']) {
      assert.ok(
        text.includes(envVar),
        `the instructions must name ${envVar}. Both change which tools exist, and a host that does `
          + 'not know may report a capability the server does not actually have.',
      );
    }
    assert.match(
      text,
      /session-scoped/i,
      'the instructions must say receipts are session-scoped. Without it an agent will hold a '
        + 'receipt id across a restart and learn the hard way, via the "unknown or expired receipt" '
        + 'message in src/receipts.ts.',
    );
  });
});

describe('#690 the instructions are fit to send to an agent', () => {
  it('is ASCII', () => {
    // Hosts render this into terminals, logs and system prompts with widely
    // varying fonts and encodings. An em dash or a smart quote is a mojibake
    // line in somebody's agent context, and it is invisible in review because
    // it still reads correctly in the diff.
    const offenders = [...SERVER_INSTRUCTIONS]
      .filter((ch) => ch.codePointAt(0)! > 0x7f)
      .map((ch) => `U+${(ch.codePointAt(0)!).toString(16).toUpperCase().padStart(4, '0')} ${ch}`);
    assert.deepEqual(
      offenders,
      [],
      `the instructions must be ASCII; found ${offenders.join(', ')}.`,
    );
  });

  it(`fits the ${INSTRUCTIONS_BYTE_BUDGET}-byte budget`, () => {
    const bytes = Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8');
    assert.ok(
      bytes < INSTRUCTIONS_BYTE_BUDGET,
      `the instructions are ${bytes} bytes, over the ${INSTRUCTIONS_BYTE_BUDGET} the issue asks for. `
        + 'This string is prepended to every host\'s context on every connection, so it competes '
        + 'with the tool schemas for the same budget. Cut wording, not facts: the dry_run exception '
        + 'and the non-affiliation notice are the two that must survive a trim.',
    );
  });

  it('carries no Spotify mark beyond the plain-text attribution', () => {
    // The only reason the word appears at all is the attribution clause. #698
    // (tests/third-party-marks-guard.test.ts) is the authority on the marks
    // boundary; this is the narrow claim that the runtime string is plain text
    // and does not smuggle a wordmark or a styled variant into a prompt.
    const forbidden = ['▶', '◀', '★', '™', '®', 'Spotify™', '[logo]'];
    for (const mark of forbidden) {
      assert.ok(
        !SERVER_INSTRUCTIONS.includes(mark),
        `the instructions must not contain the mark ${JSON.stringify(mark)}. Plain-text attribution `
          + 'only — this string is rendered by hosts with no control over their styling.',
      );
    }
  });

  it('carries nothing credential-shaped', () => {
    // #699 guards the docs; this string is sent to whoever launched the
    // process, so the same discipline applies at runtime.
    for (const pattern of [/token\s*file/i, /client\s*id/i, /\btokens\.json\b/, /SPOTIFY_CLIENT_ID/]) {
      assert.ok(
        !pattern.test(SERVER_INSTRUCTIONS),
        `the instructions must not mention ${pattern}. This string is handed to every host that `
          + 'launches the server, so it must not invite a credential into the transcript '
          + '(tests/credential-doc-guard.test.ts, #699).',
      );
    }
  });
});

describe('#690 the notice on the wire is the same notice everywhere else', () => {
  /**
   * The issue's "one constant, four surfaces" requirement.
   *
   * #705 already guards the four metadata surfaces against
   * `SHORT_NON_AFFILIATION_NOTICE`; this asserts the thing that is easy to
   * miss, which is that the *runtime* string and those surfaces are talking
   * about the same disclosure. The runtime carries the long form, the capped
   * surfaces carry the short form, and the two only stay related because the
   * long form contains the short form's claims.
   */
  it('the runtime notice and the capped-description notice say the same thing', () => {
    assert.ok(
      SERVER_INSTRUCTIONS.includes(NON_AFFILIATION_NOTICE),
      `the instructions must carry NON_AFFILIATION_NOTICE. Without it the runtime surface and the `
        + 'npm/Registry surfaces are two unrelated claims, and nothing would fail if they diverged.',
    );
    // The relationship between the long and short forms is #705's to assert
    // (it does so in "the two notice forms are one disclosure"), and the short
    // form is 100-character-capped, so it deliberately drops "endorsed by" and
    // "sponsored by". Re-asserting that here would be duplicating #705 with a
    // weaker claim. What is new here is only the join: the single claim the
    // capped form does make -- "not affiliated" -- has to be the same claim the
    // runtime string makes, or the two surfaces are describing different
    // relationships.
    const longForm = NON_AFFILIATION_NOTICE.toLowerCase();
    const shortForm = SHORT_NON_AFFILIATION_NOTICE.toLowerCase();
    assert.ok(
      longForm.includes('not affiliated') && shortForm.includes('not affiliated'),
      `both forms must deny affiliation. The long form reads ${JSON.stringify(NON_AFFILIATION_NOTICE)} `
        + `and the short form ${JSON.stringify(SHORT_NON_AFFILIATION_NOTICE)}; the runtime surface and `
        + 'the Registry/npm surfaces are only the same disclosure if they agree on this claim.',
    );
  });

  it('the four capped surfaces still end with the short form', () => {
    // Not re-implemented here -- #705 owns these and fails if they drift.
    // Asserted as a precondition so a failure below is legible as "the
    // surfaces moved" rather than "the instructions did".
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { description: string };
    const server = JSON.parse(readFileSync(path.join(ROOT, 'server.json'), 'utf8')) as { description: string };
    for (const [name, value] of [['package.json', pkg.description], ['server.json', server.description]] as const) {
      assert.ok(
        value.endsWith(SHORT_NON_AFFILIATION_NOTICE),
        `precondition: ${name} description must still end with the short notice; it reads `
          + `${JSON.stringify(value)}. tests/branding-notice-guard.test.ts owns that assertion.`,
      );
    }
  });
});

describe('#690 the harness can see the field missing', () => {
  it('reports an absent instructions key as an absence, not as empty content', async () => {
    // The control. A spawn-and-assert test that only ever sees a server which
    // does set the field cannot distinguish "the harness works" from "the
    // harness would have passed anyway". This spawns a real server that
    // deliberately omits `instructions` and asserts the read comes back
    // undefined -- the same thing a dropped `{ instructions }` argument in
    // src/index.ts would produce.
    const dir = await mkdtemp(path.join(tmpdir(), 'instr690-noinst-'));
    const entry = path.join(dir, 'no-instructions.mjs');
    // Absolute specifiers, not bare ones: the fixture lives under os.tmpdir()
    // so it is outside this repository, and ESM resolution walks UP from the
    // importing file looking for node_modules. It will not find this worktree's
    // copy, and NODE_PATH is ignored for ESM. Pointing at the resolved file is
    // what makes a scratch-dir fixture able to import the SDK at all.
    const sdk = (rel: string): string =>
      new URL(`node_modules/@modelcontextprotocol/sdk/dist/esm/${rel}`, pathToFileURL(ROOT + '/')).href;
    await writeFile(
      entry,
      [
        `import { McpServer } from '${sdk('server/mcp.js')}';`,
        `import { StdioServerTransport } from '${sdk('server/stdio.js')}';`,
        "const server = new McpServer({ name: 'no-instructions', version: '0.0.0' });",
        'await server.connect(new StdioServerTransport());',
        '',
      ].join('\n'),
      'utf8',
    );

    const child = StdioJsonRpcChild.spawn({
      label: 'server-instructions control',
      command: process.execPath,
      args: [entry],
      cwd: ROOT,
      env: childEnv(),
      requestTimeoutMs: CLI_TIMEOUT_MS,
    });
    try {
      const init = await child.initialize('instr690-control');
      assert.equal(
        init.result?.instructions,
        undefined,
        'precondition: a server built without `{ instructions }` must not emit the key. If this '
          + 'fails the SDK\'s behaviour changed and the wire assertions above are testing less than '
          + 'they claim.',
      );
    } finally {
      await child.dispose();
    }
  });
});
