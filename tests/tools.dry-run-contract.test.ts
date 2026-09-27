/**
 * The playback `dry_run` contract (#836).
 *
 * Two contradictory contracts used to ship under one parameter name. The 13
 * `exhaust2_playback` mutations defaulted an omitted `dry_run` to a preview;
 * `playback.ts` / `queueops.ts` / `playbackext.ts` / `playbackintel.ts` /
 * `scenes.ts` defaulted it to a commit; and `swarm3_playback` declared a
 * private `DryRunDefault` defaulting to TRUE while the shared fragment it
 * imported from `shaping.ts` advertised no default at all. An agent that
 * learned "omitted means preview" from `set_volume` would commit a destructive
 * write through `play`, and a host building a tool catalogue from the schema
 * could not warn the user either way.
 *
 * The fix is one convention for the playback set: omitting `dry_run` COMMITS,
 * and the published schema says so with `default: false`. These tests read the
 * live registry over tools/list — the same path a host uses — so they assert
 * the wire contract rather than the source text that produced it.
 *
 * Run: node --import tsx --test tests/tools.dry-run-contract.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SpotifyClient } from '../src/client.js';
import { REGISTRAR_MANIFEST, loadManifestRegistrars } from '../src/tools/annotations.js';

/**
 * The playback mutation modules. `scopeKey: 'playback'` is the manifest's own
 * grouping, so this list is derived from it rather than hand-maintained — a
 * new playback module is covered by construction instead of by remembering to
 * edit a constant.
 */
const PLAYBACK_MODULES = new Set(
  REGISTRAR_MANIFEST.filter((m) => m.scopeKey === 'playback').map((m) => m.key),
);

/** Every registered tool in the playback set that accepts `dry_run`. */
interface PlaybackDryRunTool {
  name: string;
  module: string;
  defaultValue: unknown;
  hasDefault: boolean;
  description: string;
}

async function playbackDryRunTools(): Promise<PlaybackDryRunTool[]> {
  const stub = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
  } as unknown as SpotifyClient;
  const server = new McpServer({ name: 'dry-run-contract-probe', version: '0.0.0' });

  // Record which module registers each tool by wrapping the public
  // registration methods; registration itself still runs on the real server,
  // so tools/list reads the genuine registry.
  const moduleByTool = new Map<string, string>();
  const observed = new Set<string>();
  const wrappable = server as unknown as {
    tool: (...args: unknown[]) => unknown;
    registerTool: (...args: unknown[]) => unknown;
  };
  const origTool = wrappable.tool.bind(server);
  const origRegisterTool = wrappable.registerTool.bind(server);
  wrappable.tool = (...args: unknown[]) => {
    observed.add(args[0] as string);
    return origTool(...args);
  };
  wrappable.registerTool = (...args: unknown[]) => {
    observed.add(args[0] as string);
    return origRegisterTool(...args);
  };
  // The manifest holds thunks, not imported registrars (#906), so this pass
  // loads them first — the same two steps `startMcpServer` runs. Registering
  // straight off the raw manifest would call `undefined`.
  const loaded = await loadManifestRegistrars(REGISTRAR_MANIFEST, {
    readOnly: false,
    isModuleActive: () => true,
    scopeBlocked: () => false,
  });
  for (const { key, registrar } of loaded) {
    assert.ok(registrar, `${key} has no loaded registrar`);
    const before = new Set(observed);
    registrar(server, stub);
    for (const name of observed) if (!before.has(name)) moduleByTool.set(name, key);
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dry-run-contract-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools
      .filter((t) => PLAYBACK_MODULES.has(moduleByTool.get(t.name) ?? ''))
      .map((t) => {
        const prop = (t.inputSchema?.properties as Record<string, { default?: unknown }> | undefined)
          ?.dry_run;
        return {
          name: t.name,
          module: moduleByTool.get(t.name) ?? '',
          hasDefault: prop !== undefined && 'default' in prop,
          defaultValue: prop?.default,
          description: t.description ?? '',
        };
      })
      // Only tools that actually expose `dry_run` are in scope; a playback
      // tool without the field is a different guard's business.
      .filter((t) => t.hasDefault || t.defaultValue !== undefined);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe('playback dry_run contract (#836)', () => {
  it('every playback tool that declares dry_run declares it as default:false', async () => {
    const tools = await playbackDryRunTools();
    assert.ok(tools.length > 0, 'no playback dry_run tools found — the probe is vacuous');

    // Group by the fragment each tool actually published, so a tool that
    // silently keeps a private default is named rather than averaged away.
    const wrong = tools.filter((t) => t.defaultValue !== false);
    assert.deepEqual(
      wrong.map((t) => `${t.name} (${t.module}) = ${JSON.stringify(t.defaultValue)}`).sort(),
      [],
      'playback tools must all publish dry_run default:false',
    );
  });

  it('covers the tools the issue named, not just the ones that were already correct', async () => {
    const names = new Set((await playbackDryRunTools()).map((t) => t.name));
    // The preview-by-default tools from the issue. If this list ever needs
    // shrinking, the fix is a deliberate contract change, not a silent one.
    // #848 folded six of these into two survivors, so the list names the
    // survivor and the op that stands in for the retired name. Listing the
    // retired names here would be a check that can never pass; listing the
    // survivors is the same contract expressed in the vocabulary that exists.
    for (const name of [
      'set_volume', // was mute, unmute, room_level and apply_volume_plan
      'transfer_playback', // was switch_device
      'surprise_me',
      'skip_n',
      'pause_everywhere',
      'volume_ramp',
      'episode_resume',
      'queue_next_episode',
      'queue_replace_via_playlist',
      'continue_last',
      'sleep_timer',
      'resume_playback_position',
    ]) {
      assert.ok(names.has(name), `${name} must be in the playback set with a published dry_run default`);
    }
  });

  it('no playback tool still describes itself as previewing by default', async () => {
    const stale = (await playbackDryRunTools()).filter((t) =>
      /preview by default|dry_run defaults to true|dry_run=true to commit/i.test(t.description),
    );
    assert.deepEqual(
      stale.map((t) => t.name).sort(),
      [],
      'these playback tools still claim an omitted dry_run previews',
    );
  });

  it('publishes the same default for set_volume/queue_replace_via_playlist as for play/pause', async () => {
    const byName = new Map((await playbackDryRunTools()).map((t) => [t.name, t]));
    for (const name of ['set_volume', 'queue_replace_via_playlist', 'play', 'pause']) {
      assert.equal(byName.get(name)?.defaultValue, false, `${name} must publish default:false`);
    }
  });
});
