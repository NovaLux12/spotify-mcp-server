/**
 * Scope profiles and the narrowed default auth grant (#700).
 *
 * Before this change an unconfigured `auth` run asked for all 17 scopes, five
 * of which mutate Spotify and one of which (`user-read-email`) exposes the
 * account's email to a server with no tool that reads it. Terms Sec. V.3 and
 * the repo's own rule (AGENTS.md §1) both say to request the minimum and never
 * preemptively; nothing enforced either, so the maximal grant was the only
 * behaviour this server could have.
 *
 * The assertions are written two ways, on purpose:
 *
 *   - OVER THE BUILT SCOPE STRING — what `auth` puts on the authorize URL.
 *     Driven through `authScopeRequest`, which is the function `runAuthFlow`
 *     itself calls, so a precedence bug introduced in the CLI wiring fails
 *     here rather than passing against a re-derivation of the rule.
 *
 *   - AS VISIBILITY — which tools a caller holding a given grant can and
 *     cannot see, through the real `registerManifestModules` gate over the
 *     real manifest. Not as configuration, and not by reading `DEFAULT_SCOPES`:
 *     a test that asserts the constant equals itself cannot fail.
 *
 * The granularity the architecture can actually keep is the manifest ROW, not
 * the tool (`scopeKey` / `readOnlySafe`; see #1005, #1009, #1017 and
 * tests/manifest-readonly-rows.test.ts). So the claim under test is "these
 * rows' write tools are withheld, their read tools are not" — never "this one
 * tool needs exactly this one scope". The second claim is not expressible here,
 * and a profile that implied it would be the same defect #1005 shipped.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SpotifyClient } from '../src/client.js';
import { moduleBlockedByScopes, scopesFor } from '../src/scopefilter.js';
import { REGISTRAR_MANIFEST, registerManifestModules } from '../src/tools/annotations.js';
import {
  DEFAULT_SCOPE_PROFILE,
  KNOWN_SPOTIFY_SCOPES,
  SCOPE_PROFILE_NAMES,
  isReadScope,
  renderEnvHelp,
  scopeGroupsFor,
  scopeProfileFor,
  scopesForProfile,
} from '../src/config.ts';
import { authScopeRequest, formatScopePreview, parseAuthArgs } from '../src/auth.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The scope string `auth` would put on the URL, for a given argv + env. */
const requestFor = (argv: string[] = [], env: NodeJS.ProcessEnv = {}): string =>
  authScopeRequest(argv, env).scopes;

const granted = (argv: string[] = [], env: NodeJS.ProcessEnv = {}): string[] =>
  authScopeRequest(argv, env).scopes.split(' ');

/** Register the whole manifest through the production gate for a grant. */
async function visibleTools(grant: readonly string[]): Promise<Set<string>> {
  const server = new McpServer({ name: 'scope-profile-test', version: '0.0.0' });
  const held = scopesFor(grant.join(' '));
  await registerManifestModules(server, new SpotifyClient(), {
    readOnly: false,
    isModuleActive: () => true,
    scopeBlocked: (key) => moduleBlockedByScopes(key, held),
  });
  return new Set(
    Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools),
  );
}

/**
 * The mutation scopes #700 requires an opt-in for, named literally rather than
 * derived from the profile table: the acceptance criterion is a statement
 * about these five names, and a test that reads them back out of the code it
 * is checking cannot fail.
 */
const REQUIRES_OPT_IN = [
  'user-library-modify',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-follow-modify',
  'ugc-image-upload',
] as const;

/** The 17-scope grant this server shipped before #700, spelled out. */
const PRE_700_DEFAULT = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-playback-position',
  'user-top-read',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',
  'ugc-image-upload',
  'user-follow-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
];

describe('the default auth grant asks for no mutation scope (#700)', () => {
  it('excludes every mutating scope and the email scope, with no arguments at all', () => {
    // The issue's acceptance criterion, asserted over the built string rather
    // than over a constant: `auth` with a clean environment and an empty argv.
    const scopes = requestFor();
    for (const scope of [...REQUIRES_OPT_IN, 'user-read-email'] as const) {
      assert.equal(
        scopes.split(' ').includes(scope),
        false,
        `a clean \`auth\` run still requests ${scope}`,
      );
    }
  });

  it('requests strictly fewer scopes than the pre-#700 default', () => {
    const scopes = requestFor().split(' ');
    assert.ok(
      scopes.length < PRE_700_DEFAULT.length,
      `the default grant is ${scopes.length} scopes, not narrower than the old ${PRE_700_DEFAULT.length}`,
    );
    // And it must not have quietly added anything the old list did not carry.
    for (const scope of scopes) {
      assert.ok(PRE_700_DEFAULT.includes(scope), `${scope} is new and not part of the pre-#700 vocabulary`);
    }
  });

  it('keeps the reads and playback control a first-time user actually needs', () => {
    // A default that protects against writes by removing the reads is not a
    // minimum grant, it is a broken one. Named literally for the same reason
    // as above.
    for (const scope of [
      'user-read-private',
      'user-read-playback-state',
      'user-read-currently-playing',
      'user-read-recently-played',
      'user-read-playback-position',
      'user-top-read',
      'user-library-read',
      'user-follow-read',
      'playlist-read-private',
      'playlist-read-collaborative',
      'user-modify-playback-state',
    ]) {
      assert.ok(requestFor().split(' ').includes(scope), `the default grant dropped ${scope}`);
    }
  });

  it('leaves every scope in the default readable or playback-control', () => {
    for (const scope of requestFor().split(' ')) {
      assert.ok(
        isReadScope(scope) || scope === 'user-modify-playback-state',
        `${scope} is in the default grant but is neither a read nor playback control`,
      );
    }
  });
});

describe('the opt-in spellings all reach the write tools', () => {
  it('`--scopes full` is the maximal grant', () => {
    assert.deepEqual(requestFor(['--scopes', 'full']).split(' ').sort(), [...PRE_700_DEFAULT].sort());
  });

  it('`--scope-profile write` reaches every mutating scope', () => {
    const scopes = requestFor(['--scope-profile', 'write']).split(' ');
    for (const scope of REQUIRES_OPT_IN) {
      assert.ok(scopes.includes(scope), `--scope-profile write does not request ${scope}`);
    }
    assert.equal(scopes.includes('user-read-email'), false, 'the write profile should not ask for the email scope');
  });

  it('`SPOTIFY_MCP_SCOPE_PROFILE` and `--scope-profile` name the same set', () => {
    assert.deepEqual(
      requestFor(['--scope-profile', 'full']),
      requestFor([], { SPOTIFY_MCP_SCOPE_PROFILE: 'full' }),
    );
  });

  it('an explicit list still beats a profile, in both spellings', () => {
    const list = 'user-read-private user-library-read';
    assert.equal(requestFor(['--scopes', list]), list);
    assert.equal(requestFor([], { SPOTIFY_SCOPES: list }), list);
    // The CLI list beats the env profile too — highest precedence first.
    assert.equal(
      requestFor(['--scopes', list], { SPOTIFY_MCP_SCOPE_PROFILE: 'full' }),
      list,
    );
    // And the env list beats the CLI profile.
    assert.equal(
      requestFor(['--scope-profile', 'full'], { SPOTIFY_SCOPES: list }),
      list,
    );
  });

  it('reports which profile and which knob produced the request', () => {
    const clean = authScopeRequest([], {});
    assert.equal(clean.profile, 'core');
    assert.equal(clean.source, 'default profile "core"');
    const opted = authScopeRequest(['--scope-profile', 'write'], {});
    assert.equal(opted.profile, 'write');
    assert.equal(opted.source, '--scope-profile');
  });

  it('refuses an unknown or empty profile instead of falling back to a wider one', () => {
    // #617's shape: a set-but-unusable value must not be read as "unset",
    // because the fall-through here is to a WIDER grant than the user asked for.
    assert.throws(() => authScopeRequest(['--scope-profile', 'wrte'], {}), /Unknown scope profile/);
    assert.throws(() => authScopeRequest(['--scope-profile', ''], {}), /requires a profile name/);
    assert.throws(
      () => authScopeRequest([], { SPOTIFY_MCP_SCOPE_PROFILE: 'nope' }),
      /Unknown scope profile/,
    );
  });

  it('keeps --scope-profile from being read as the account --profile', () => {
    // Two different things are called "profile". `--scope-profile=work` must
    // not select an account named work, and must not be a syntax error.
    const args = parseAuthArgs(['--scope-profile=write', '--profile=work']);
    assert.equal(args.scopeProfile, 'write');
    assert.equal(args.profile, 'work');
  });
});

describe('the profiles are derived, so they cannot contradict each other', () => {
  it('nests read ⊆ core ⊆ write ⊆ full', () => {
    let previous: string[] = [];
    for (const name of SCOPE_PROFILE_NAMES) {
      const scopes = [...scopesForProfile(name)];
      for (const scope of previous) {
        assert.ok(
          scopes.includes(scope),
          `${name} omits ${scope}, which the narrower profile granted — the nesting is broken`,
        );
      }
      previous = scopes;
    }
    assert.equal(
      new Set(previous).size,
      PRE_700_DEFAULT.length,
      'the profiles do not together cover the old default',
    );
  });

  it('recognises a grant by the profile it matches, and does not guess', () => {
    assert.equal(scopeProfileFor(scopesForProfile('core')), 'core');
    assert.equal(scopeProfileFor(scopesForProfile('full')), 'full');
    // A hand-narrowed list matches nothing, and that must be a null, not a
    // crash and not a wrong label.
    assert.equal(scopeProfileFor(['user-read-private']), null);
    assert.equal(scopeProfileFor([]), null);
  });

  it('names every scope in the default profile in a group with a rationale', () => {
    // The pre-consent printout is only useful if every scope is explained.
    const groups = scopeGroupsFor(requestFor().split(' '));
    const explained = new Set(groups.flatMap((g) => [...g.scopes]));
    for (const scope of requestFor().split(' ')) {
      assert.ok(explained.has(scope), `${scope} would be requested with no explanation shown to the user`);
    }
    for (const group of groups) {
      assert.ok(group.rationale.length > 0, `group ${group.group} has no rationale`);
    }
  });

  it('marks the non-read groups in the preview so they can be declined', () => {
    const preview = formatScopePreview(authScopeRequest(['--scope-profile', 'write'], {}));
    assert.match(preview, /not a read: this group can change or expose data/);
    const readPreview = formatScopePreview(authScopeRequest(['--scope-profile', 'read'], {}));
    assert.equal(
      /not a read/.test(readPreview),
      false,
      'the read profile warned about writes it does not request',
    );
  });

  it('keeps every scope requestable even though the default no longer asks', () => {
    for (const scope of PRE_700_DEFAULT) {
      assert.ok(KNOWN_SPOTIFY_SCOPES.has(scope as never), `${scope} is no longer requestable at all`);
    }
  });
});

describe('a caller sees the right surface for the default grant', () => {
  const DEFAULT_GRANT = granted();

  it('withholds the write tools the default does not authorise', async () => {
    const names = await visibleTools(DEFAULT_GRANT);
    for (const tool of [
      'save_to_library',
      'remove_from_library',
      'create_playlist',
      'add_to_playlist',
      'remove_from_playlist',
      'update_playlist',
      'upload_playlist_cover',
      'follow_playlist',
      'unfollow_playlist',
      'pin_playlist',
      'unpin_playlist',
    ]) {
      assert.equal(names.has(tool), false, `${tool} advertised to a grant that cannot authorise it`);
    }
  });

  it('keeps the reads on those same rows', async () => {
    // The scope filter splits a row rather than dropping it, so a narrowed
    // grant must cost the writes and nothing else. `get_playlist` and
    // `get_saved_tracks` live in rows gated on the very scopes the default
    // withholds, and are the reads that gate would otherwise take with them.
    const names = await visibleTools(DEFAULT_GRANT);
    for (const tool of ['get_playlist', 'get_playlist_items', 'get_saved_tracks', 'get_now_playing', 'play', 'pause']) {
      assert.ok(names.has(tool), `the default grant lost ${tool}`);
    }
  });

  it('keeps every readOnlySafe row whole, because the manifest says it cannot write', async () => {
    // This is the row-not-tool unit made visible. Before #700 a user had to
    // hand-narrow SPOTIFY_SCOPES to hit it; after #700 EVERY fresh auth run
    // scope-filters these rows, so the name-driven classifier was dropping
    // reads (`whats_new`, `library_coverage_report`, `saved_albums_by_year`,
    // ...) that the grant authorises — an unknown-tool error for a call the
    // caller was entitled to make. Each name below is a tool in a row the
    // manifest marks `readOnlySafe` and whose scopeKey IS blocked by this
    // grant, so every one of them fails without the exemption.
    const names = await visibleTools(DEFAULT_GRANT);
    for (const tool of [
      'whats_new',
      'library_coverage_report',
      'library_growth_report',
      'genre_trends_over_time',
      'saved_albums_by_year',
      'saved_track_age_report',
      'list_backups',
      'backup_library',
    ]) {
      assert.ok(names.has(tool), `${tool} withheld from a grant that authorises it`);
    }
  });

  it('gives a caller who opted in the full write surface back', async () => {
    const opted = await visibleTools(granted(['--scope-profile', 'write']));
    for (const tool of ['save_to_library', 'create_playlist', 'upload_playlist_cover', 'pin_playlist']) {
      assert.ok(opted.has(tool), `--scope-profile write still withholds ${tool}`);
    }
  });
});

describe('the readOnlySafe exemption is an enforced claim, not a promise', () => {
  it('no readOnlySafe row registers a Spotify write', () => {
    // The exemption in `moduleRegistrationStatus` trusts `readOnlySafe` to mean
    // "nothing in this row writes". tests/manifest-readonly-rows.test.ts
    // checks the same invariant per registration chunk; this copy exists so a
    // reader of THIS file sees that the fail-open is fenced, and so the
    // exemption cannot be widened to a row whose file the other suite's
    // pattern does not reach.
    const offenders: string[] = [];
    for (const module of REGISTRAR_MANIFEST) {
      if (module.readOnlySafe !== true) continue;
      if (!module.file.startsWith('src/tools/')) continue; // `receipts` is local to annotations.ts
      const src = readFileSync(join(REPO_ROOT, module.file), 'utf8');
      if (/\.(post|put|delete|patch|putRaw)\s*(<[\s\S]*?>)?\s*\(/.test(src)) {
        offenders.push(module.key);
      }
    }
    assert.deepEqual(offenders, [], 'rows claiming readOnlySafe while calling a Spotify write: ' + offenders.join(', '));
  });

  it('exempts a readOnlySafe row from the scope filter even when its scopeKey is blocked', () => {
    // The structural form of the assertion above, at the gate: `freshness` is
    // readOnlySafe and carries scopeKey `following`, which needs
    // `user-follow-modify`. A read grant blocks that key, so the row is only
    // whole because of the exemption.
    const freshness = REGISTRAR_MANIFEST.find((m) => m.key === 'freshness');
    assert.ok(freshness, 'the freshness row vanished from the manifest');
    assert.equal(freshness.readOnlySafe, true);
    assert.equal(
      moduleBlockedByScopes(freshness.scopeKey ?? '', scopesFor('user-read-private')),
      true,
      'the following scope key is no longer blocked for a read grant — this test stopped exercising the exemption',
    );
  });
});

describe('the profile is discoverable without reading the source (#700 acceptance)', () => {
  // #621's finding, applied here: a knob that is documented only in the full
  // reference is a knob an operator never finds, and a DEFAULT that is not
  // stated is a default an operator has to guess. Both surfaces are asserted
  // rather than trusted, because both are hand-maintained prose.
  const help = renderEnvHelp();
  const usage = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');

  it('names the profile variable, its four names, and the default in --help', () => {
    assert.ok(help.includes('SPOTIFY_MCP_SCOPE_PROFILE'), '--help never names SPOTIFY_MCP_SCOPE_PROFILE');
    for (const name of SCOPE_PROFILE_NAMES) {
      assert.ok(help.includes(name), `--help does not name the "${name}" profile`);
    }
    assert.match(help, /Default "core"|default "core"/i, '--help does not state the default profile');
  });

  it('shows --scope-profile in the auth usage line', () => {
    assert.match(usage, /spotify-mcp auth \[--profile <name>\]/);
    assert.match(usage, /\[--scope-profile <name>\]/, 'the auth usage line omits --scope-profile');
    assert.match(usage, /\[--scopes <list>\]/);
  });

  it('documents the profiles and the new default in the full reference and the template', () => {
    for (const [label, rel] of [
      ['docs/configuration.md', 'docs/configuration.md'],
      ['SPEC.md', 'SPEC.md'],
      ['.env.example', '.env.example'],
    ] as const) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      assert.ok(
        text.includes('SPOTIFY_MCP_SCOPE_PROFILE') || text.includes('scope profile'),
        `${label} never mentions the scope profile`,
      );
      assert.ok(text.includes('core'), `${label} never names the default profile`);
    }
  });
});
