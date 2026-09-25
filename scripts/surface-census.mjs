#!/usr/bin/env node
/**
 * Enumerate the real MCP registry without opening a network connection.
 *
 * Plain `node scripts/surface-census.mjs` re-executes this file with tsx so a
 * clean checkout needs no build step. `--write` refreshes generated documentation
 * blocks; `--check` is the CI drift guard.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (!process.env.SPOTIFY_MCP_SURFACE_CENSUS) {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), ...args], {
    cwd: ROOT,
    env: { ...process.env, SPOTIFY_MCP_SURFACE_CENSUS: '1' },
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { z } = await import('zod');
const { TOOLSETS, allRegistrationKeys } = await import('../src/toolsets.ts');
const { registerPlaybackTools } = await import('../src/tools/playback.ts');
const { registerSearchTools } = await import('../src/tools/search.ts');
const { registerCatalogTools } = await import('../src/tools/catalog.ts');
const { registerPersonalizationTools } = await import('../src/tools/personalization.ts');
const { registerLibraryTools } = await import('../src/tools/library.ts');
const { registerFollowingTools } = await import('../src/tools/following.ts');
const { registerAudiobookTools } = await import('../src/tools/audiobooks.ts');
const { registerPlaylistTools } = await import('../src/tools/playlists.ts');
const { registerUsersTools } = await import('../src/tools/users.ts');
const { registerPlaylistOpsTools } = await import('../src/tools/playlistops.ts');
const { registerLibraryInsightsTools } = await import('../src/tools/libraryinsights.ts');
const { registerFreshnessTools } = await import('../src/tools/freshness.ts');
const { registerSearchDeepTool } = await import('../src/tools/searchdive.ts');
const { registerPodcastSessionTools } = await import('../src/tools/podcastsession.ts');
const { registerAudiobookCopilotTools } = await import('../src/tools/audiobookcopilot.ts');
const { registerScenesTools } = await import('../src/tools/scenes.ts');
const { registerPlaylistDnaTools } = await import('../src/tools/playlistdna.ts');
const { registerAnalyticsTools } = await import('../src/tools/analytics.ts');
const { registerExportTools } = await import('../src/tools/export.ts');
const { registerImportTools } = await import('../src/tools/import.ts');
const { registerSmartTools } = await import('../src/tools/smart.ts');
const { registerShowRadarTools } = await import('../src/tools/showradar.ts');
const { registerSavedDedupeTools } = await import('../src/tools/saveddedupe.ts');
const { registerBackupTools } = await import('../src/tools/backup.ts');
const { registerRestoreTools } = await import('../src/tools/restore.ts');
const { registerUndoTools } = await import('../src/tools/undo.ts');
const { registerBackupFirstTools } = await import('../src/tools/backupfirst.ts');
const { registerLibraryHygieneTools } = await import('../src/tools/libraryhygiene.ts');
const { registerBrowseTools } = await import('../src/tools/browse.ts');
const { registerArtistWatchTools } = await import('../src/tools/artistwatch.ts');
const { registerLibraryAnalyticsTools } = await import('../src/tools/libraryanalytics.ts');
const { registerPlaylistHealthTools } = await import('../src/tools/playlisthealth.ts');
const { registerPlaylistBatchTools } = await import('../src/tools/playlistbatch.ts');
const { registerPlaylistMiscTools } = await import('../src/tools/playlistmisc.ts');
const { registerPortabilityTools } = await import('../src/tools/portability.ts');
const { registerQueueOpsTools } = await import('../src/tools/queueops.ts');
const { registerPlaybackExtTools } = await import('../src/tools/playbackext.ts');
const { registerPlaybackIntelTools } = await import('../src/tools/playbackintel.ts');
const { registerSearchHistoryTools } = await import('../src/tools/searchhistory.ts');
const { registerExhaustMiscTools } = await import('../src/tools/exhaustmisc.ts');
const { registerExhaust2CatalogTools } = await import('../src/tools/exhaust2_catalog.ts');
const { registerExhaust2PlaybackTools } = await import('../src/tools/exhaust2_playback.ts');
const { registerExhaust2PlaylistsTools } = await import('../src/tools/exhaust2_playlists.ts');
const { registerExhaust2MiscTools } = await import('../src/tools/exhaust2_misc.ts');
const { registerExhaust2EnggatingTools } = await import('../src/tools/exhaust2_enggating.ts');
const { registerExhaust2ExtraTools } = await import('../src/tools/exhaust2_extra.ts');
const { registerEpisodeMgmtTools } = await import('../src/tools/episodemgmt.ts');
const { registerDoctorTool } = await import('../src/tools/doctortool.ts');
const { registerSwarm3PlaybackTools } = await import('../src/tools/swarm3_playback.ts');
const { registerSwarm3PlaylistopsTools } = await import('../src/tools/swarm3_playlistops.ts');
const { registerSwarm3DiscoveryTools } = await import('../src/tools/swarm3_discovery.ts');
const { registerSwarm3bDiscoveryTools } = await import('../src/tools/swarm3b_discovery.ts');
const { registerSwarm4PlaylistsTools } = await import('../src/tools/swarm4_playlists.ts');
const { registerSwarm3LibraryTools } = await import('../src/tools/swarm3_library.ts');
const { registerSwarm3ShowsTools } = await import('../src/tools/swarm3_shows.ts');
const { registerSwarm3AnalyticsTools } = await import('../src/tools/swarm3_analytics.ts');
const { registerStatsfmTasteTools } = await import('../src/tools/statsfm_taste.ts');
const { registerTasteCompositeTools } = await import('../src/tools/taste_composites.ts');
const { registerSwarm3RefsTools } = await import('../src/tools/swarm3_refs.ts');
const { registerSwarm3SnapshotsTools } = await import('../src/tools/swarm3_snapshots.ts');
const { registerSwarm3MetaTools } = await import('../src/tools/swarm3_meta.ts');
const { registerStatsfmTools } = await import('../src/tools/statsfm.ts');
const { registerResources } = await import('../src/resources/index.ts');
const { registerTemplateResources } = await import('../src/resources/templates.ts');
const { registerPrompts } = await import('../src/prompts/index.ts');
const { formatReceipt, verifyReceipt } = await import('../src/receipts.ts');

const modules = [
  ['src/tools/playback.ts', 'playback', registerPlaybackTools],
  ['src/tools/search.ts', 'search', registerSearchTools],
  ['src/tools/catalog.ts', 'catalog', registerCatalogTools],
  ['src/tools/personalization.ts', 'personalization', registerPersonalizationTools],
  ['src/tools/analytics.ts', 'personalization', registerAnalyticsTools],
  ['src/tools/statsfm_taste.ts', 'taste', registerStatsfmTasteTools],
  ['src/tools/taste_composites.ts', 'tastecomposites', registerTasteCompositeTools],
  ['src/tools/libraryhygiene.ts', 'library', registerLibraryHygieneTools],
  ['src/tools/restore.ts', 'library', registerRestoreTools],
  ['src/tools/backup.ts', 'library', registerBackupTools],
  ['src/tools/browse.ts', 'browse', registerBrowseTools],
  ['src/tools/artistwatch.ts', 'artistwatch', registerArtistWatchTools],
  ['src/tools/searchhistory.ts', 'searchhistory', registerSearchHistoryTools],
  ['src/tools/exhaustmisc.ts', 'playlists', registerExhaustMiscTools],
  ['src/tools/exhaust2_catalog.ts', 'exhaust2catalog', registerExhaust2CatalogTools],
  ['src/tools/exhaust2_playback.ts', 'exhaust2playback', registerExhaust2PlaybackTools],
  ['src/tools/exhaust2_playlists.ts', 'exhaust2playlists', registerExhaust2PlaylistsTools],
  ['src/tools/exhaust2_misc.ts', 'exhaust2misc', registerExhaust2MiscTools],
  ['src/tools/exhaust2_enggating.ts', 'exhaust2enggating', registerExhaust2EnggatingTools],
  ['src/tools/exhaust2_extra.ts', 'exhaust2extra', registerExhaust2ExtraTools],
  ['src/tools/libraryanalytics.ts', 'libraryanalytics', registerLibraryAnalyticsTools],
  ['src/tools/portability.ts', 'portability', registerPortabilityTools],
  ['src/tools/episodemgmt.ts', 'episodemgmt', registerEpisodeMgmtTools],
  ['src/tools/playlisthealth.ts', 'playlisthealth', registerPlaylistHealthTools],
  ['src/tools/playlistbatch.ts', 'playlistbatch', registerPlaylistBatchTools],
  ['src/tools/playlistmisc.ts', 'playlistmisc', registerPlaylistMiscTools],
  ['src/tools/queueops.ts', 'queueops', registerQueueOpsTools],
  ['src/tools/playbackext.ts', 'playbackext', registerPlaybackExtTools],
  ['src/tools/playbackintel.ts', 'playbackintel', registerPlaybackIntelTools],
  ['src/tools/doctortool.ts', 'doctor', registerDoctorTool],
  ['src/tools/swarm3_playback.ts', 'swarm3playback', registerSwarm3PlaybackTools],
  ['src/tools/swarm3_playlistops.ts', 'swarm3playlistops', registerSwarm3PlaylistopsTools],
  ['src/tools/swarm3_discovery.ts', 'swarm3discovery', registerSwarm3DiscoveryTools],
  ['src/tools/swarm3b_discovery.ts', 'swarm3bdiscovery', registerSwarm3bDiscoveryTools],
  ['src/tools/swarm3_library.ts', 'swarm3library', registerSwarm3LibraryTools],
  ['src/tools/swarm3_shows.ts', 'swarm3shows', registerSwarm3ShowsTools],
  ['src/tools/swarm3_analytics.ts', 'swarm3analytics', registerSwarm3AnalyticsTools],
  ['src/tools/swarm3_refs.ts', 'swarm3refs', registerSwarm3RefsTools],
  ['src/tools/swarm3_snapshots.ts', 'swarm3snapshots', registerSwarm3SnapshotsTools],
  ['src/tools/swarm3_meta.ts', 'swarm3meta', registerSwarm3MetaTools],
  ['src/tools/swarm4_playlists.ts', 'swarm4playlists', registerSwarm4PlaylistsTools],
  ['src/tools/statsfm.ts', 'statsfm', registerStatsfmTools],
  ['src/tools/following.ts', 'following', registerFollowingTools],
  ['src/tools/audiobooks.ts', 'audiobooks', registerAudiobookTools],
  ['src/tools/playlists.ts', 'playlists', registerPlaylistTools],
  ['src/tools/users.ts', 'users', registerUsersTools],
  ['src/tools/library.ts', 'library', registerLibraryTools],
  ['src/tools/playlistops.ts', 'playlists', registerPlaylistOpsTools],
  ['src/tools/playlistdna.ts', 'playlists', registerPlaylistDnaTools],
  ['src/tools/export.ts', 'playlists', registerExportTools],
  ['src/tools/import.ts', 'playlists', registerImportTools],
  ['src/tools/smart.ts', 'playlists', registerSmartTools],
  ['src/tools/showradar.ts', 'library', registerShowRadarTools],
  ['src/tools/saveddedupe.ts', 'library', registerSavedDedupeTools],
  ['src/tools/libraryinsights.ts', 'library', registerLibraryInsightsTools],
  ['src/tools/freshness.ts', 'following', registerFreshnessTools],
  ['src/tools/searchdive.ts', 'search', registerSearchDeepTool],
  ['src/tools/podcastsession.ts', 'library', registerPodcastSessionTools],
  ['src/tools/audiobookcopilot.ts', 'audiobooks', registerAudiobookCopilotTools],
  ['src/tools/scenes.ts', 'playback', registerScenesTools],
  ['src/tools/backupfirst.ts', 'library', registerBackupFirstTools],
  ['src/tools/undo.ts', 'library', registerUndoTools],
];

const clientStub = {
  get: async () => null,
  post: async () => null,
  put: async () => null,
  delete: async () => null,
  getAllPages: async () => [],
  getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
};
const server = new McpServer({ name: 'surface-census', version: '0.0.0' });
const observed = new Set();
const moduleByTool = new Map();
const perModule = Object.fromEntries(modules.map(([file]) => [file, 0]));

for (const [file, , register] of modules) {
  const surface = server;
  const originalTool = surface.tool.bind(surface);
  const originalRegisterTool = surface.registerTool.bind(surface);
  const before = observed.size;
  surface.tool = (...registrationArgs) => {
    const name = registrationArgs[0];
    observed.add(name);
    moduleByTool.set(name, file);
    return originalTool(...registrationArgs);
  };
  surface.registerTool = (...registrationArgs) => {
    const name = registrationArgs[0];
    observed.add(name);
    moduleByTool.set(name, file);
    return originalRegisterTool(...registrationArgs);
  };
  if (register === registerStatsfmTools) register(server);
  else register(server, clientStub);
  perModule[file] = observed.size - before;
}
server.tool('verify_receipt',
  'Verify that a previous mutation actually landed on Spotify by looking up its receipt',
  { receipt_id: z.string().min(1).describe('Receipt ID from a receipt-bearing mutation result') },
  async ({ receipt_id: receiptId }) => {
    const receipt = verifyReceipt(receiptId);
    return { content: [{ type: 'text', text: receipt ? formatReceipt(receipt) : `Unknown receipt "${receiptId}".` }] };
  });
moduleByTool.set('verify_receipt', 'src/index.ts');
perModule['src/index.ts'] = 1;
registerTemplateResources(server, clientStub);
registerResources(server, clientStub);
registerPrompts(server);

const client = new Client({ name: 'surface-census-client', version: '0.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);

try {
  const [toolPage, resourcePage, templatePage, promptPage] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listResourceTemplates(),
    client.listPrompts(),
  ]);
  const toolNames = toolPage.tools.map(({ name }) => name).sort();
  const resourceUris = resourcePage.resources.map(({ uri }) => uri).sort();
  const resourceTemplateUris = templatePage.resourceTemplates.map(({ uriTemplate }) => uriTemplate).sort();
  const promptNames = promptPage.prompts.map(({ name }) => name).sort();
  const registrationKeys = [...new Set(allRegistrationKeys)].sort();
  const toolModuleFiles = readdirSync(join(ROOT, 'src/tools')).filter((file) => file.endsWith('.ts')).length;
  const census = {
    tools: toolNames.length,
    toolModuleFiles,
    registrationKeys: registrationKeys.length,
    resources: resourceUris.length,
    resourceTemplates: resourceTemplateUris.length,
    prompts: promptNames.length,
    toolNames,
    resourceUris,
    resourceTemplateUris,
    promptNames,
    registrationKeyNames: registrationKeys,
    perModule,
    toolsetNames: Object.keys(TOOLSETS).length,
  };

  const architecture = moduleInventory(census);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const packageExcerpt = JSON.stringify({
    type: pkg.type,
    engines: pkg.engines,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    scripts: pkg.scripts,
  }, null, 2);
  const blocks = [
    ['ARCHITECTURE.md', 'surface-census', architectureSurface(census)],
    ['ARCHITECTURE.md', 'module-map', architecture],
    ['SPEC.md', 'package-contract', ['```json', packageExcerpt, '```'].join('\n')],
    ['SPEC.md', 'tool-surface', toolSurface(census)],
    ['SPEC.md', 'resource-surface', resourceSurface(census)],
    ['SPEC.md', 'prompt-surface', promptSurface(census)],
  ];
  const drift = checkBlocks(blocks);
  if (args.includes('--check') && drift.length > 0) {
    console.error(`Documentation drift from the live registry:\n${drift.map((line) => `- ${line}`).join('\n')}`);
    console.error('Run `node --import tsx/esm scripts/surface-census.mjs --write` after reviewing registry changes.');
    process.exitCode = 1;
  } else if (args.includes('--write')) {
    for (const [file, name, body] of blocks) writeBlock(join(ROOT, file), name, body);
  }
  console.log(JSON.stringify(census, null, 2));
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}

function moduleInventory(census) {
  const files = [
    ...readdirSync(join(ROOT, 'src')).filter((file) => file.endsWith('.ts')).map((file) => `src/${file}`),
    ...readdirSync(join(ROOT, 'src/lib')).filter((file) => file.endsWith('.ts')).map((file) => `src/lib/${file}`),
    ...readdirSync(join(ROOT, 'src/tools')).filter((file) => file.endsWith('.ts')).map((file) => `src/tools/${file}`),
  ].sort();
  const rows = files.map((file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const doc = /^\/\*\*\s*\n([\s\S]*?)\n\s*\*\//.exec(source);
    const firstSentence = doc?.[1]
      ?.split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .find(Boolean);
    const registered = census.perModule[file] ?? 0;
    const description = firstSentence?.replaceAll('|', '\\|') ?? `Runtime module for ${basename(file, '.ts')}.`;
    const responsibility = `${description} (${registered} registered tools)`;
    return `| \`${file}\` | ${responsibility} | ${source.split('\n').length - 1} |`;
  });
  return ['| File | Responsibility | LOC |', '|---|---|---:|', ...rows].join('\n');
}

function architectureSurface(census) {
  return `The default profile registers **${census.tools} tools** from ${census.toolModuleFiles} files under \`src/tools/\` plus the inline \`verify_receipt\` tool. The live surface also contains **${census.resources} fixed resources**, **${census.resourceTemplates} resource templates**, and **${census.prompts} prompts**; only modules active for the granted toolsets and scopes register at runtime. These values come from the live MCP registry, not a static estimate.`;
}

function toolSurface(census) {
  return `The live default MCP registry exposes **${census.tools} tools** (${census.tools - 1} from the ${census.toolModuleFiles} files under \`src/tools/\`, plus inline \`verify_receipt\`), organized by ${census.registrationKeys} registration keys and ${census.toolsetNames} named toolsets. Registration keys: ${census.registrationKeyNames.map((key) => `\`${key}\``).join(', ')}. \`node scripts/surface-census.mjs\` derives this inventory from real \`tools/list\`, \`resources/list\`, \`resources/templates/list\`, and \`prompts/list\` calls without network access.`;
}

function resourceSurface(census) {
  return `The live registry contains **${census.resources} fixed resources** and **${census.resourceTemplates} resource templates**. Fixed URIs: ${census.resourceUris.map((uri) => `\`${uri}\``).join(', ')}. Template URIs: ${census.resourceTemplateUris.map((uri) => `\`${uri}\``).join(', ')}.`;
}

function promptSurface(census) {
  return `The live registry exposes **${census.prompts} prompts**: ${census.promptNames.map((name) => `\`${name}\``).join(', ')}.`;
}

function markers(name) {
  return [`<!-- BEGIN:generated ${name} -->`, `<!-- END:generated ${name} -->`];
}

function renderedBlock(name, body) {
  const [start, end] = markers(name);
  return `${start}\n${body}\n${end}`;
}

function checkBlocks(blocks) {
  const errors = [];
  for (const [file, name, body] of blocks) {
    const expected = renderedBlock(name, body);
    const actual = readFileSync(join(ROOT, file), 'utf8');
    if (!actual.includes(expected)) errors.push(`${file}: generated ${name} block is stale`);
  }
  return errors;
}

function writeBlock(file, name, body) {
  const [start, end] = markers(name);
  const expected = `${start}\n${body}\n${end}`;
  const source = readFileSync(file, 'utf8');
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(source)) throw new Error(`${file}: missing generated ${name} markers`);
  writeFileSync(file, source.replace(pattern, expected));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
