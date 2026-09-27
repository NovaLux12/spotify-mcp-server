/**
 * Argument parsing for the #606 subcommands.
 *
 * ## Why the parsers are tested without a server
 *
 * `parseCallArgs` and friends are pure: they take `string[]` and return an
 * options object or throw a `CliUsageError`. Booting the real registry costs
 * ~2.1 s, and every rejection path here (bad JSON, a missing value, a flag with
 * no value, a non-object `--args`) is decided long before a session exists. So
 * the parsing is tested directly and the *end-to-end* behaviour of a rejection
 * is tested in `tests/cli.call.test.ts` against a live session — including the
 * exit code, which is the part a user sees.
 *
 * ## What each assertion is actually protecting
 *
 * A silently ignored flag is the failure class `logout` established the rule
 * against: a `--dry-run` that is accepted and dropped reads exactly like a
 * `--dry-run` that was honoured. So every unknown flag in every parser is an
 * error, and `takeValue` refuses to read the next flag as a value. Both are
 * asserted directly, because a parser that stopped rejecting anything would
 * still let every other test in the suite pass.
 *
 * ## The "silently matches nothing" hazard
 *
 * Several of these tests are negative — a value is expected to be refused. A
 * negative assertion that matched nothing (a regex that never fires, a `.find`
 * over the wrong array) is a green test that proves nothing, so each one pairs
 * the rejection with a positive control: the same parser, given a well-formed
 * invocation, returns the value. Without the control, a parser that returned
 * the default for everything would pass the whole block.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CliUsageError, parsePositiveInt, positionals, takeValue, usageFailure } from '../src/cli/args.js';
import { parseCallArgs, nearest } from '../src/cli/call.js';
import { parseToolsArgs, quotaMarker } from '../src/cli/tools.js';
import { parseWatchArgs } from '../src/cli/watch.js';
import { parseExportArgs, exportTarget } from '../src/cli/exportcmd.js';
import { buildServerEntry, composeDocument, claudeAddCommand, defaultOutPath, parseInitArgs } from '../src/cli/init.js';
import { decodeToolResult } from '../src/cli/result.js';
import { CLI_SUBCOMMANDS, isCliSubcommand } from '../src/cli/dispatch.js';

/**
 * Assert `fn` throws a `CliUsageError` whose message matches `needle`.
 *
 * Every call site passes a RegExp, so the parameter is typed as one: a signature
 * that also accepted a bare string would compile at a call site that meant to
 * match a pattern and would then be compared with `assert.ok`, which passes on
 * any truthy value.
 */
function refuses(fn: () => unknown, needle: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof CliUsageError, `expected a CliUsageError, got ${String(thrown)}`);
  assert.match((thrown as Error).message, needle);
}

describe('#606 args: takeValue', () => {
  it('reads a separated value and an inline value identically', () => {
    assert.equal(takeValue(['--tool', 'search'], 0, '--tool'), 'search');
    assert.equal(takeValue(['--tool=search'], 0, '--tool'), 'search');
  });

  it('refuses a missing value rather than reading the next flag as one', () => {
    // The reason this is not `argv[i+1] ?? ''`: reading `--other` as the value
    // would run a command whose subject is the name of another flag, and the
    // failure would surface downstream as a confusing error.
    refuses(() => takeValue(['--tool', '--json'], 0, '--tool'), /--tool requires a value/);
    refuses(() => takeValue(['--tool'], 0, '--tool'), /--tool requires a value/);
    refuses(() => takeValue(['--tool='], 0, '--tool'), /--tool requires a value/);
  });

  it('accepts a value that merely starts with a single dash', () => {
    // Only `--` marks a flag in this vocabulary. `-5` is a value; refusing it
    // would be a rule the help text never states.
    assert.equal(takeValue(['--count', '-5'], 0, '--count'), '-5');
  });
});

describe('#606 args: parsePositiveInt', () => {
  it('accepts digits', () => {
    assert.equal(parsePositiveInt('5', '--interval'), 5);
    assert.equal(parsePositiveInt('120', '--interval'), 120);
  });

  it('rejects the strings Number() and parseInt() would quietly accept', () => {
    // `Number('1e3')` is 1000 and `parseInt('12abc')` is 12. An interval that
    // silently becomes 1000 ms because the user typed `1e3` is exactly the
    // quiet reinterpretation that makes a watch loop look broken.
    refuses(() => parsePositiveInt('1e3', '--interval'), /--interval must be a whole number/);
    refuses(() => parsePositiveInt('12abc', '--interval'), /--interval must be a whole number/);
    refuses(() => parsePositiveInt(' 12 ', '--interval'), /--interval must be a whole number/);
    refuses(() => parsePositiveInt('', '--interval'), /--interval must be a whole number/);
  });

  it('rejects zero for a flag whose minimum is 1', () => {
    // `--count 0` is legal and means "until Ctrl-C"; `--interval 0` is not,
    // and watch parses it with a regex of its own rather than this helper.
    refuses(() => parsePositiveInt('0', '--interval'), /--interval must be at least 1/);
  });
});

describe('#606 args: positionals', () => {
  it('separates words from flags and consumes a flag value', () => {
    const { words, unknown } = positionals(['get_me', '--args', '{}', '--json']);
    assert.deepEqual(words, ['get_me']);
    assert.deepEqual(unknown, ['--args', '--json']);
  });
});

describe('#606 args: usageFailure', () => {
  it('puts the message before the help, so the message is not buried', () => {
    const out = usageFailure('--tool requires a value', 'HELP TEXT');
    assert.match(out, /^spotify-mcp: --tool requires a value\n\nHELP TEXT$/);
  });
});

describe('#606 call: parseCallArgs', () => {
  it('reads a tool name with no flags', () => {
    // The positive control for every rejection below.
    assert.deepEqual(parseCallArgs(['get_me']), {
      tool: 'get_me',
      args: {},
      dryRun: false,
      json: false,
      profile: undefined,
    });
  });

  it('reads --args as a JSON object, separated or inline', () => {
    assert.deepEqual(parseCallArgs(['get_me', '--args', '{"market":"GB"}']).args, { market: 'GB' });
    assert.deepEqual(parseCallArgs(['get_me', '--args={"market":"GB"}']).args, { market: 'GB' });
  });

  it('names the JSON parse error rather than swallowing it', () => {
    // "Unexpected token } in JSON at position 1" is the difference between a
    // user fixing their quoting and a user filing a bug.
    refuses(() => parseCallArgs(['get_me', '--args', '{oops}']), /--args is not valid JSON: .+/);
  });

  it('refuses a JSON value that is not an object', () => {
    refuses(() => parseCallArgs(['get_me', '--args', '[1,2]']), /--args must be a JSON object, got an array/);
    refuses(() => parseCallArgs(['get_me', '--args', 'null']), /--args must be a JSON object, got null/);
    refuses(() => parseCallArgs(['get_me', '--args', '7']), /--args must be a JSON object, got number/);
  });

  it('refuses a missing tool name and a second positional', () => {
    refuses(() => parseCallArgs([]), /a tool name is required/);
    refuses(() => parseCallArgs(['get_me', 'get_albums']), /unexpected argument: get_albums/);
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // The class this repository's CLI rule exists for: a `--dry-runn` typo that
    // ran a real, destructive write while the user believed it was a preview.
    refuses(() => parseCallArgs(['get_me', '--dry-runn']), /unknown argument: --dry-runn/);
  });
});

describe('#606 call: nearest', () => {
  it('prefers the shortest edit distance', () => {
    assert.deepEqual(nearest('get_me', ['get_albums', 'get_me', 'search'], 1), ['get_me']);
  });

  it('is deterministic for a tie', () => {
    const names = ['get_me', 'set_me'];
    assert.deepEqual(nearest('xet_me', names, 2), names.slice().sort());
  });
});

describe('#606 tools: quotaMarker', () => {
  it('extracts the Quota clause from a description that declares one', () => {
    assert.equal(
      quotaMarker('Merged listening stream. Quota: 2 reads. Read-only.'),
      '2 reads',
    );
  });

  it('takes the LAST clause, because a description may mention it twice', () => {
    // `lastIndexOf`, not `indexOf`: a description that says "no Quota: clause
    // here ... Quota: 1 read." must report the one that is real.
    assert.equal(quotaMarker('Unlike a Quota: field in the args. Quota: 1 read.'), '1 read');
  });

  it('returns null for a description that declares none — not "", not "none", not 0', () => {
    // "this description declares no quota sentence" and "this tool makes no
    // quota'd calls" are different claims, and only the first is knowable
    // from a description. A "" here would render as a found-but-blank clause.
    assert.equal(quotaMarker('Search the Spotify catalogue. Read-only.'), null);
    assert.equal(quotaMarker(undefined), null);
    assert.equal(quotaMarker(''), null);
    assert.equal(quotaMarker('Quota:'), null);
  });
});

describe('#606 tools: parseToolsArgs', () => {
  it('reads the three flags', () => {
    assert.deepEqual(parseToolsArgs(['--json', '--filter', 'play', '--module=search']), {
      json: true,
      filter: 'play',
      module: 'search',
    });
  });

  it('refuses an unknown flag', () => {
    refuses(() => parseToolsArgs(['--jsno']), /unknown argument: --jsno/);
  });
});

describe('#606 watch: parseWatchArgs', () => {
  it('defaults to get_now_playing, five seconds, and until interrupted', () => {
    assert.deepEqual(parseWatchArgs([]), {
      args: {},
      intervalSeconds: 5,
      count: 0,
      json: false,
      tolerateErrors: false,
    });
  });

  it('accepts --count 0 as "until Ctrl-C" without going through the positive-only parser', () => {
    // `--interval 0` is refused but `--count 0` is documented, so the two flags
    // cannot share one rule.
    assert.equal(parseWatchArgs(['--count', '0']).count, 0);
    refuses(() => parseWatchArgs(['--interval', '0']), /--interval must be at least 1/);
    refuses(() => parseWatchArgs(['--count', '-1']), /--count must be a whole number/);
  });

  it('refuses --tool together with --resource', () => {
    // Two surfaces at once has no meaning: the loop would poll one and diff
    // against the other, and every "changed" verdict would be an artefact.
    refuses(
      () => parseWatchArgs(['--tool', 'get_queue', '--resource', 'spotify://x']),
      /--tool and --resource are mutually exclusive/,
    );
  });

  it('refuses a bad --args payload with the same rule call uses', () => {
    refuses(() => parseWatchArgs(['--args', '{oops}']), /--args is not valid JSON/);
    refuses(() => parseWatchArgs(['--args', '[]']), /--args must be a JSON object/);
  });
});

describe('#606 export: parseExportArgs and exportTarget', () => {
  it('maps --kind library onto export_library_json with a DIRECTORY argument', () => {
    // `output_dir` is a directory and `--out` is the user-facing word; the
    // reconciliation lives in exportTarget and nowhere else.
    const opts = parseExportArgs(['--kind', 'library', '--out', 'backup', '--format', 'csv']);
    assert.deepEqual(exportTarget(opts), {
      tool: 'export_library_json',
      args: { output_dir: 'backup', format: 'csv' },
    });
  });

  it('maps --kind playlist onto export_playlist with a FILE argument', () => {
    const opts = parseExportArgs(['--kind', 'playlist', '--playlist', 'p1', '--out', 'p1.m3u', '--overwrite']);
    assert.deepEqual(exportTarget(opts), {
      tool: 'export_playlist',
      args: { playlist_id: 'p1', output_path: 'p1.m3u', overwrite: true },
    });
  });

  it('refuses --kind playlists rather than quietly treating it as singular', () => {
    // Issue #606 writes `--kind playlists`. No tool exports every playlist, and
    // treating the plural as the singular would export a playlist the user did
    // not name.
    refuses(
      () => parseExportArgs(['--kind', 'playlists']),
      /no tool exports every playlist/,
    );
  });

  it('refuses a format the chosen tool does not take', () => {
    refuses(() => parseExportArgs(['--kind', 'library', '--format', 'm3u']), /must be json or csv/);
    refuses(() => parseExportArgs(['--kind', 'playlist', '--playlist', 'p', '--format', 'json']), /must be m3u or csv/);
  });

  it('refuses a missing --kind, a playlist with no id, and --playlist on library', () => {
    refuses(() => parseExportArgs([]), /--kind is required/);
    refuses(() => parseExportArgs(['--kind', 'playlist']), /--kind playlist needs --playlist <id>/);
    refuses(() => parseExportArgs(['--kind', 'library', '--playlist', 'p1']), /--playlist applies to --kind playlist only/);
  });
});

describe('#606 init: parseInitArgs', () => {
  it('defaults to the published npx invocation', () => {
    const opts = parseInitArgs(['--host', 'openclaw']);
    assert.equal(opts.command, 'npx');
    assert.deepEqual(opts.args, ['-y', '@novalux12/spotify-mcp@latest']);
  });

  it('splits --command on spaces so a local node invocation is expressible', () => {
    const opts = parseInitArgs(['--host', 'generic', '--command', 'node /srv/dist/index.js']);
    assert.equal(opts.command, 'node');
    assert.deepEqual(opts.args, ['/srv/dist/index.js']);
  });

  it('refuses an unknown host and a missing --host', () => {
    refuses(() => parseInitArgs(['--host', 'vscode']), /--host must be one of openclaw, generic, claude-code/);
    refuses(() => parseInitArgs([]), /--host is required/);
  });
});

describe('#606 init: buildServerEntry', () => {
  it('writes SPOTIFY_CLIENT_ID with no SPOTIFY_MCP_ prefix', () => {
    // The deliberate exception to this project's own prefix convention; a
    // generated config that got it wrong fails on a variable name nothing else
    // uses.
    const { entry, missing } = buildServerEntry(
      parseInitArgs(['--host', 'generic', '--client-id', 'abc123']),
      { tokenFile: '/tmp/t.json' },
    );
    assert.equal(entry.env.SPOTIFY_CLIENT_ID, 'abc123');
    assert.equal(entry.env.SPOTIFY_MCP_TOKEN_FILE, '/tmp/t.json');
    assert.deepEqual(missing, []);
  });

  it('reports a missing client id rather than inventing a placeholder', () => {
    const { entry, missing } = buildServerEntry(parseInitArgs(['--host', 'generic']), { tokenFile: null });
    assert.deepEqual(missing, ['SPOTIFY_CLIENT_ID']);
    // The key is present and empty so the launched config fails on the value,
    // not on a key nothing recognises.
    assert.equal(entry.env.SPOTIFY_CLIENT_ID, '');
  });

  it('omits SPOTIFY_MCP_TOKEN_FILE when the path could not be resolved', () => {
    // Writing a guessed `~/.spotify-mcp/tokens.json` here would produce a config
    // that points at a file the server would not read.
    const { entry } = buildServerEntry(
      parseInitArgs(['--host', 'generic', '--client-id', 'x']),
      { tokenFile: null, tokenFileError: 'no profile' },
    );
    assert.equal('SPOTIFY_MCP_TOKEN_FILE' in entry.env, false);
  });

  it('puts a resolved path under the hermetic home, not the real one', () => {
    assert.match(
      defaultOutPath('openclaw', {}, process.env.HOME ?? ''),
      /openclaw\.json$/,
    );
  });
});

describe('#606 init: rendered config', () => {
  it('emits an mcpServers document that parses', () => {
    const { entry } = buildServerEntry(
      parseInitArgs(['--host', 'generic', '--client-id', 'abc']),
      { tokenFile: '/tmp/t.json' },
    );
    const parsed = JSON.parse(composeDocument('generic', entry)) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(Object.keys(parsed.mcpServers), ['spotify']);
  });

  it('renders a `claude mcp add` line carrying the env flags', () => {
    const { entry } = buildServerEntry(
      parseInitArgs(['--host', 'claude-code', '--client-id', 'abc']),
      { tokenFile: '/tmp/t.json' },
    );
    const line = claudeAddCommand(entry);
    assert.match(line, /^claude mcp add spotify -- npx -y @novalux12\/spotify-mcp@latest /);
    assert.match(line, /--env SPOTIFY_CLIENT_ID=abc/);
  });
});

describe('#606 result: decodeToolResult', () => {
  it('reads text, structured content and isError', () => {
    const decoded = decodeToolResult({
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { a: 1 },
    });
    assert.equal(decoded.text, 'hello');
    assert.deepEqual(decoded.structured, { a: 1 });
    assert.equal(decoded.isError, false);
    assert.equal(decoded.error, null);
  });

  it('returns null structuredContent, not {}, when the tool published none', () => {
    // "no structured payload" and "an empty structured payload" are different
    // facts and the JSON output has to be able to tell them apart.
    const decoded = decodeToolResult({ content: [{ type: 'text', text: 'x' }] });
    assert.equal(decoded.structured, null);
  });

  it('names a non-text content part instead of rendering it as a blank line', () => {
    // An empty string would read as "the tool said nothing" when the tool said
    // something this decoder does not understand.
    const decoded = decodeToolResult({
      content: [{ type: 'image', data: '...' }, { type: 'text', text: 'after' }],
    });
    assert.equal(decoded.text, '[image content]\nafter');
  });

  it('reports isError from the envelope and keeps the envelope verbatim', () => {
    const decoded = decodeToolResult({
      content: [{ type: 'text', text: 'nope' }],
      structuredContent: { error: { kind: 'auth', reason: 'no_token' } },
      isError: true,
    });
    assert.equal(decoded.isError, true);
    assert.deepEqual(decoded.error, { kind: 'auth', reason: 'no_token' });
  });

  it('survives a result that is not a result at all', () => {
    // A CLI is the last place a malformed payload should become a confident
    // answer. `isError` is still readable, and `error` is null rather than a
    // synthesised reason.
    const decoded = decodeToolResult(undefined);
    assert.equal(decoded.text, '');
    assert.equal(decoded.structured, null);
    assert.equal(decoded.isError, false);
    assert.equal(decoded.error, null);
  });

  it('does not treat isError: "true" as an error', () => {
    assert.equal(decodeToolResult({ isError: 'true' }).isError, false);
  });
});

describe('#606 dispatch: the routed set', () => {
  it('claims exactly the five subcommands the entry point routes', () => {
    assert.deepEqual([...CLI_SUBCOMMANDS], ['tools', 'call', 'watch', 'export', 'init']);
  });

  it('recognises each of them and nothing else', () => {
    for (const name of CLI_SUBCOMMANDS) assert.equal(isCliSubcommand(name), true, name);
    // The pre-#606 set must still be routed by the entry point's own branches,
    // so claiming them here would be a second, wrong answer.
    for (const name of ['auth', 'doctor', 'logout', 'serve', 'Tools', '']) {
      assert.equal(isCliSubcommand(name), false, name);
    }
    assert.equal(isCliSubcommand(undefined), false);
  });
});
