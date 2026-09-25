#!/usr/bin/env node
/**
 * Enumerate the finalized default production MCP registry without network I/O.
 *
 * The authoritative surface is the real `src/index.ts` stdio entry, driven by
 * the MCP client SDK. Registration gates and production finalizers therefore
 * run exactly as they do for a host. The same shared registrar manifest used
 * by startup supplies module attribution and schema measurements; its owned
 * names must equal the finalized `tools/list` names exactly.
 *
 * Plain `node scripts/surface-census.mjs` prints JSON. `--write` refreshes
 * generated documentation blocks and `--check` guards them in CI.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (!process.env.SPOTIFY_MCP_SURFACE_CENSUS) {
  const child = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), ...args], {
    cwd: ROOT,
    env: { ...process.env, SPOTIFY_MCP_SURFACE_CENSUS: '1' },
    stdio: 'inherit',
  });
  process.exit(child.status ?? 1);
}
const CENSUS_ENV = Object.freeze({
  SPOTIFY_CLIENT_ID: 'surface-census',
  SPOTIFY_MCP_SURFACE_CENSUS: '1',
  SPOTIFY_MCP_TOKEN_FILE: '',
  SPOTIFY_MCP_TOOLSETS: 'all',
  SPOTIFY_MCP_ENABLE_TOOLS: '',
  SPOTIFY_MCP_DISABLE_TOOLS: '',
  SPOTIFY_MCP_READONLY: '0',
  SPOTIFY_MCP_CONFIRM: 'never',
  SPOTIFY_MCP_MAX_ITEMS: '50',
  SPOTIFY_MCP_FETCH_ALL_CAP: '500',
  SPOTIFY_MCP_FRESHNESS_BUDGET: '25',
  SPOTIFY_MCP_HISTORY: '0',
  SPOTIFY_MCP_PROFILE: '',
  SPOTIFY_SCOPES: '',
  SPOTIFY_MCP_MARKET: '',
});
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SPOTIFY_')) delete process.env[key];
}
Object.assign(process.env, CENSUS_ENV);
const {
  collectModuleSchemaBudgets,
  moduleToolNames,
  registerManifestModule,
  REGISTRAR_MANIFEST,
} = await import('../src/tools/annotations.ts');
const productionManifest = REGISTRAR_MANIFEST.map((module) => ({
  registrar: module.registrar.name || module.key,
  file: module.file,
  key: module.registrationKey,
  ungated: module.alwaysActive === true,
}));
const markerFixtureIndex = args.indexOf('--marker-fixture');
if (markerFixtureIndex >= 0) {
  const fixturePath = args[markerFixtureIndex + 1];
  if (!fixturePath) throw new Error('--marker-fixture requires a JSON file');
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8'));
  const error = inspectGeneratedBlock(fixture.source, fixture.file, fixture.name, fixture.body);
  console.log(JSON.stringify({ error }));
  process.exit(error ? 1 : 0);
}
const manifestArgIndex = args.indexOf('--registration-manifest');
if (manifestArgIndex >= 0) {
  const manifestPath = args[manifestArgIndex + 1];
  if (!manifestPath) throw new Error('--registration-manifest requires a source file');
  console.log(JSON.stringify(productionManifest, null, 2));
  process.exit(0);
}
const { GATED_PATH_PATTERNS, isGatedPath } = await import('../src/tools/exhaust2_enggating.ts');
const census = await readProductionRegistry();
const { namesByModule: moduleNames, manifestToolNames, schemaMeasurements } = await attributeToolsToModules(census.toolNames);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const perModule = countModuleTools(moduleNames);
const toolModuleFiles = Object.keys(perModule).filter((file) => file.startsWith('src/tools/')).length;
const manifestRegistrationKeys = [...new Set(productionManifest.map(({ key }) => key))].sort();
const toolsetRegistrationKeys = [...new Set(allRegistrationKeysFromSource())].sort();
const unconditionalRegistrationKeys = ['doctor'];
const registrationKeyNames = [...new Set([...manifestRegistrationKeys, ...toolsetRegistrationKeys, ...unconditionalRegistrationKeys])].sort();
const schemaBudgets = REGISTRAR_MANIFEST.map((module) => ({
  module: module.key,
  registrationKey: module.registrationKey,
  file: module.file,
  baselineToolCount: module.baseline.toolCount,
  baselineSchemaBytes: module.baseline.schemaBytes,
  maxToolCount: module.ceiling.toolCount,
  maxSchemaBytes: module.ceiling.schemaBytes,
}));
const result = {
  tools: census.toolNames.length,
  toolModuleFiles,
  registrationKeys: registrationKeyNames.length,
  resources: census.resourceUris.length,
  resourceTemplates: census.resourceTemplateUris.length,
  prompts: census.promptNames.length,
  toolNames: census.toolNames,
  manifestToolNames,
  parameterNames: census.parameterNames,
  toolInputSchemas: census.toolInputSchemas,
  resourceUris: census.resourceUris,
  resourceTemplateUris: census.resourceTemplateUris,
  promptNames: census.promptNames,
  registrationKeyNames,
  manifestRegistrationKeys,
  toolsetRegistrationKeys,
  unconditionalRegistrationKeys,
  registrationUnits: productionManifest,
  perModule,
  perModuleSchemaBytes: Object.fromEntries(schemaMeasurements.map((row) => [row.module, row.schemaBytes])),
  schemaMeasurements,
  schemaBudgets,
  toolsetNames: toolsetNamesFromSource(),
  registrySource: 'src/index.ts via stdio tools/list after production finalizers',
};

const architecture = moduleInventory(result);
const packageExcerpt = JSON.stringify({
  type: pkg.type,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
  devDependencies: pkg.devDependencies,
  scripts: pkg.scripts,
}, null, 2);
const shortSurface = `The finalized default MCP registry exposes **${result.tools} tools**, **${result.resources} fixed resources**, **${result.resourceTemplates} resource templates**, and **${result.prompts} prompts**. Toolsets and production gates can trim a configured host; these totals describe the default production \`tools/list\` after finalizers.`;
const blocks = [
  ['README.md', 'surface-census', shortSurface],
  ['ARCHITECTURE.md', 'surface-census', `${shortSurface} The tool surface is attributed to ${result.toolModuleFiles} files under \`src/tools/\`.`],
  ['ARCHITECTURE.md', 'module-map', architecture],
  ['SPEC.md', 'package-contract', ['```json', packageExcerpt, '```'].join('\n')],
  ['SPEC.md', 'tool-surface', toolSurface(result)],
  ['SPEC.md', 'resource-surface', resourceSurface(result)],
  ['SPEC.md', 'prompt-surface', promptSurface(result)],
  ['docs/schema-budgets.md', 'schema-budget-table', schemaBudgetTable(result)],
  ['docs/wave2-composites.md', 'surface-census', wave2Surface(result)],
  ['docs/distribution.md', 'surface-census', distributionSurface(result)],
  ['skills/spotify-exhaustive-feature-sweep/SKILL.md', 'surface-census', skillSurface(result)],
  ['skills/spotify-mcp-competitor-comparison/SKILL.md', 'surface-census', skillSurface(result)],
  ['src/toolsets.ts', 'surface-census', [
    '// Production surface (generated; run `npm run count:tools -- --write` after registry changes):',
    `// ${result.tools} tools, ${result.resources} fixed resources, ${result.resourceTemplates} resource templates, and ${result.prompts} prompts.`,
  ].join('\n')],
];

const drift = checkDocumentation(blocks);
if (args.includes('--write')) {
  for (const [file, name, body] of blocks) writeBlock(join(ROOT, file), name, body);
  const remainingDrift = checkDocumentation(blocks);
  if (remainingDrift.length > 0) {
    console.error(`Documentation remains out of sync after --write (default tools/list: ${result.tools}):\n${remainingDrift.map((line) => `- ${line}`).join('\n')}`);
    process.exitCode = 1;
  }
} else if (args.includes('--check') && drift.length > 0) {
  console.error(`Documentation drift from the finalized production registry (default tools/list: ${result.tools}):\n${drift.map((line) => `- ${line}`).join('\n')}`);
  console.error('Run `npm run count:tools -- --write` after reviewing registry changes.');
  process.exitCode = 1;
}

console.log(JSON.stringify(result, null, 2));
if (process.exitCode) process.exit(process.exitCode);

async function readProductionRegistry() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const tempDir = mkdtempSync(join(tmpdir(), 'spotify-mcp-census-'));
  const tokenFile = join(tempDir, 'tokens.json');
  writeFileSync(tokenFile, JSON.stringify({
    access_token: 'surface-census',
    refresh_token: 'surface-census',
    expires_at: Date.now() + 60 * 60 * 1000,
  }), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx/esm', 'src/index.ts'],
    cwd: ROOT,
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH,
      HOME: tempDir,
      ...CENSUS_ENV,
      SPOTIFY_MCP_TOKEN_FILE: tokenFile,
    },
  });
  const client = new Client({ name: 'surface-census-client', version: '0.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const [toolPage, resourcePage, templatePage, promptPage] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.listPrompts(),
    ]);
    return {
      toolNames: toolPage.tools.map(({ name }) => name).sort(),
      parameterNames: [...new Set(toolPage.tools.flatMap((tool) => Object.keys(tool.inputSchema?.properties ?? {})))].sort(),
      toolInputSchemas: Object.fromEntries(toolPage.tools.map(({ name, inputSchema }) => [name, inputSchema])),
      resourceUris: resourcePage.resources.map(({ uri }) => uri).sort(),
      resourceTemplateUris: templatePage.resourceTemplates.map(({ uriTemplate }) => uriTemplate).sort(),
      promptNames: promptPage.prompts.map(({ name }) => name).sort(),
    };
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(`production tools/list failed: ${error instanceof Error ? error.message : error}${detail ? `\n${detail}` : ''}`);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Attribute the finalized live names through the same shared manifest used by
 * src/index.ts. The direct registration pass also measures each module's
 * current tool count and schema bytes for the generated budget table.
 */
async function attributeToolsToModules(liveToolNames) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'module-census', version: '0.0.0' });
  const clientStub = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
    getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
  };
  const namesByModule = new Map(REGISTRAR_MANIFEST.map((module) => [module.file, []]));
  const attributed = new Map();

  try {
    for (const module of REGISTRAR_MANIFEST) {
      registerManifestModule(server, clientStub, module, {
        readOnly: false,
        isModuleActive: () => true,
        scopeBlocked: () => false,
      });
      for (const name of moduleToolNames(server, module.key)) {
        const owners = attributed.get(name) ?? [];
        owners.push(module.file);
        attributed.set(name, owners);
        namesByModule.get(module.file).push(name);
      }
    }

    const live = new Set(liveToolNames);
    const missing = liveToolNames.filter((name) => !attributed.has(name));
    const extra = [...attributed.keys()].filter((name) => !live.has(name)).sort();
    if (missing.length > 0) {
      throw new Error(`finalized tools/list contains ${missing.length} name(s) absent from the shared registrar manifest: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      throw new Error(`shared registrar manifest owns ${extra.length} name(s) absent from finalized tools/list: ${extra.join(', ')}`);
    }
    const ambiguous = [...attributed].filter(([, owners]) => owners.length > 1);
    if (ambiguous.length > 0) {
      throw new Error(`finalized tool names have ambiguous module attribution: ${ambiguous.map(([name, owners]) => `${name} (${owners.join(', ')})`).join('; ')}`);
    }

    return {
      namesByModule,
      manifestToolNames: [...attributed.keys()].sort(),
      schemaMeasurements: collectModuleSchemaBudgets(server),
    };
  } finally {
    await server.close().catch(() => undefined);
  }
}

function countModuleTools(namesByModule) {
  return Object.fromEntries([...namesByModule].map(([file, names]) => [file, names.length]));
}


function schemaBudgetTable(census) {
  const measured = new Map(census.schemaMeasurements.map((row) => [row.module, row]));
  const rows = census.schemaBudgets.map((budget) => {
    const live = measured.get(budget.module);
    return `| ${budget.module} | ${live?.toolCount ?? 0} | ${formatInteger(live?.schemaBytes ?? 0)} | ${budget.baselineToolCount} | ${formatInteger(budget.baselineSchemaBytes)} | ${budget.maxToolCount} | ${formatInteger(budget.maxSchemaBytes)} |`;
  });
  return [
    '| Module | Tools | Schema bytes | Baseline tools | Baseline bytes | Effective tool ceiling | Effective byte ceiling |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows,
  ].join('\n');
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function checkSchemaBudgetTruth(census) {
  const errors = [];
  const measurements = new Map(census.schemaMeasurements.map((row) => [row.module, row]));
  for (const budget of census.schemaBudgets) {
    const measured = measurements.get(budget.module);
    if (!measured) {
      errors.push(`docs/schema-budgets.md: shared registrar manifest module ${budget.module} has no registry measurement`);
      continue;
    }
    if (measured.toolCount !== budget.baselineToolCount || measured.schemaBytes !== budget.baselineSchemaBytes) {
      errors.push(`src/tools/annotations.ts: ${budget.module} baseline is ${budget.baselineToolCount} tools/${budget.baselineSchemaBytes}B, measured ${measured.toolCount} tools/${measured.schemaBytes}B`);
    }
  }
  return errors;
}

function allRegistrationKeysFromSource() {
  const { allRegistrationKeys } = parseToolsetsModule();
  return allRegistrationKeys;
}

function toolsetNamesFromSource() {
  const { TOOLSETS } = parseToolsetsModule();
  return Object.keys(TOOLSETS).length;
}

function parseToolsetsModule() {
  const source = readFileSync(join(ROOT, 'src/toolsets.ts'), 'utf8');
  const block = /export const TOOLSETS:[\s\S]*?= \{([\s\S]*?)\} as const;/.exec(source)?.[1];
  if (!block) throw new Error('src/toolsets.ts: cannot derive TOOLSETS');
  const names = [...block.matchAll(/^\s{2}([a-z][a-z0-9]*):\s*\[([^\]]*)\]/gm)].map((match) => [match[1], [...match[2].matchAll(/'([^']+)'/g)].map((key) => key[1])]);
  return {
    TOOLSETS: Object.fromEntries(names),
    allRegistrationKeys: names.flatMap(([, keys]) => keys),
  };
}

function moduleInventory(census) {
  const files = inventoryFiles();
  const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const rows = files.map((file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const description = firstDescription(source, file, sentenceSegmenter)
      .replaceAll('|', '\\|')
      .replace(/\s+/g, ' ');
    const registered = census.perModule[file] ?? 0;
    const noun = registered === 1 ? 'tool' : 'tools';
    return `| \`${file}\` | ${description} (${registered} registered ${noun}) | ${source.split('\n').length - 1} |`;
  });
  return ['| File | Responsibility | LOC |', '|---|---|---:|', ...rows].join('\n');
}

function inventoryFiles() {
  return walkFiles(join(ROOT, 'src'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => relative(ROOT, file))
    .sort();
}

function firstDescription(source, fallback, segmenter) {
  const doc = /^\/\*\*\s*\n([\s\S]*?)\n\s*\*\//.exec(source);
  const leadingComments = /^(?:\/\/[^\n]*\n)+/.exec(source)?.[0];
  const lines = doc
    ? doc[1].split('\n').map((line) => line.replace(/^\s*\* ?/, '').trim())
    : (leadingComments ?? '').split('\n').map((line) => line.replace(/^\/\/ ?/, '').trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  const paragraph = [];
  for (const line of lines) {
    if (line === '') break;
    paragraph.push(line);
  }
  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  return [...segmenter.segment(text)][0]?.segment.trim() || `Runtime module for ${fallback}.`;
}

function toolSurface(census) {
  return `The finalized default MCP registry exposes **${census.tools} tools** (all ${census.tools} attributed to the ${census.toolModuleFiles} files under \`src/tools/\`), organized by ${census.registrationKeys} registration keys and ${census.toolsetNames} named toolsets. Registration keys: ${census.registrationKeyNames.map((key) => `\`${key}\``).join(', ')}. \`node scripts/surface-census.mjs\` derives the authoritative inventory by starting the real \`src/index.ts\` stdio entry and calling \`tools/list\`, \`resources/list\`, \`resources/templates/list\`, and \`prompts/list\` after production gates and finalizers, without network access.`;
}

function resourceSurface(census) {
  return `The finalized default registry contains **${census.resources} fixed resources** and **${census.resourceTemplates} resource templates**. Fixed URIs: ${census.resourceUris.map((uri) => `\`${uri}\``).join(', ')}. Template URIs: ${census.resourceTemplateUris.map((uri) => `\`${uri}\``).join(', ')}.`;
}

function promptSurface(census) {
  return `The finalized default registry exposes **${census.prompts} prompts**: ${census.promptNames.map((name) => `\`${name}\``).join(', ')}.`;
}

function distributionSurface(census) {
  return `- Surface: ${census.tools} tools, ${census.resources} fixed resources, ${census.resourceTemplates} resource templates, and ${census.prompts} prompts in the finalized default production registry (toolsets can trim a configured host); aligned with Spotify's current Web API plus the stats.fm public API (read-only, no auth). The registry-derived counts replace historical release snapshots; v1.30.0 added the taste composite briefs, playlist specs, and reports described in \`docs/wave2-composites.md\`.`;
}

function wave2Surface(census) {
  return `Current default production surface: **${census.tools} tools**, including the shipped taste composites documented below. Earlier release totals in this page's history are not current registry truth; regenerate this block with \`npm run count:tools -- --write\`.`;
}

function skillSurface(census) {
  return `Current default production baseline: **${census.tools} tools**, **${census.resources} fixed resources**, **${census.resourceTemplates} resource templates**, and **${census.prompts} prompts**. Regenerate with \`npm run count:tools -- --write\`; never substitute historical prose.`;
}

function markers(file, name) {
  if (file.endsWith('.ts')) {
    return [`// BEGIN:generated ${name}`, `// END:generated ${name}`];
  }
  return [`<!-- BEGIN:generated ${name} -->`, `<!-- END:generated ${name} -->`];
}

function renderedBlock(file, name, body) {
  const [start, end] = markers(file, name);
  return `${start}\n${body}\n${end}`;
}

export function inspectGeneratedBlock(source, file, name, body) {
  const [start, end] = markers(file, name);
  const startCount = source.split(start).length - 1;
  const endCount = source.split(end).length - 1;
  if (startCount !== 1) return `${file}: expected exactly one ${start} marker, found ${startCount}`;
  if (endCount !== 1) return `${file}: expected exactly one ${end} marker, found ${endCount}`;
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (endAt <= startAt) return `${file}: generated ${name} end marker precedes its start marker`;
  const actual = source.slice(startAt, endAt + end.length);
  if (actual !== renderedBlock(file, name, body)) return `${file}: generated ${name} block is stale`;
  return null;
}

function checkDocumentation(blocks) {
  const errors = [];
  for (const [file, name, body] of blocks) {
    const error = inspectGeneratedBlock(readFileSync(join(ROOT, file), 'utf8'), file, name, body);
    if (error) errors.push(error);
  }
  errors.push(...checkSchemaBudgetTruth(result));
  errors.push(...checkSpecStructure());
  errors.push(...checkDocReachability());
  errors.push(...checkGatedEndpointTruth());
  return errors;
}

function checkSpecStructure() {
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
  const toc = [...spec.matchAll(/^(\d+)\. \[[^\]]+\]\(#(\d+)-/gm)].map((match) => [Number(match[1]), Number(match[2])]);
  const sections = [...spec.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
  const expected = Array.from({ length: 13 }, (_, index) => index + 1);
  const errors = [];
  if (toc.some(([ordinal, target]) => ordinal !== target)) errors.push('SPEC.md: TOC ordinal does not match its heading target');
  if (JSON.stringify(sections) !== JSON.stringify(expected)) errors.push(`SPEC.md: top-level sections are ${sections.join(', ')}; expected ${expected.join(', ')}`);

  const references = [];
  const referenceFiles = [join(ROOT, 'ARCHITECTURE.md'), ...walkFiles(join(ROOT, 'src')).filter((file) => file.endsWith('.ts')), ...readdirSync(join(ROOT, 'skills')).map((name) => join(ROOT, 'skills', name, 'SKILL.md'))];
  for (const file of referenceFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/SPEC(?:\s+section|\s*§)\s*(\d+(?:\.\d+)?)/gi)) references.push({ file, section: match[1] });
  }
  const headings = new Set([...spec.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*)(?:\.|\s)/gm)].map((match) => match[1]));
  for (const { file, section } of references) {
    if (!headings.has(section)) errors.push(`${relative(ROOT, file)}: SPEC section ${section} does not exist`);
  }
  return errors;
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(file) : [file];
  });
}

function checkDocReachability() {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const errors = [];
  for (const file of readdirSync(join(ROOT, 'docs')).filter((name) => name.endsWith('.md')).sort()) {
    if (!readme.includes(`](docs/${file})`)) errors.push(`README.md: docs/${file} is not reachable from the Docs list`);
  }
  return errors;
}

function checkGatedEndpointTruth() {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
  const errors = [];
  const cases = [
    ['/browse/categories', true], ['/browse/categories/party/playlists', true],
    ['/browse/new-releases', true], ['/markets', true],
    ['/artists/artist-id/top-tracks', true], ['/users/user-id', true],
    ['/me/albums/contains', true], ['/me/tracks/contains', true],
    ['/me/episodes/contains', true], ['/me/shows/contains', true],
    ['/me/audiobooks/contains', true], ['/me/following/contains', true],
    ['/playlists/playlist-id/followers/contains', true],
    ['/me/player/playback-state', false], ['/tracks/track-id', false],
  ];
  for (const [path, expected] of cases) {
    if (isGatedPath(path) !== expected) errors.push(`GATED_PATH_PATTERNS: ${path} classified as ${isGatedPath(path)}, expected ${expected}`);
  }
  if (GATED_PATH_PATTERNS.length !== 7) errors.push(`GATED_PATH_PATTERNS: expected 7 exported patterns, found ${GATED_PATH_PATTERNS.length}`);
  for (const endpoint of ['/artists/{id}/top-tracks', '/me/{type}/contains']) {
    if (!readme.includes(endpoint)) errors.push(`README.md: missing gated endpoint ${endpoint}`);
  }
  if (!spec.includes('GATED_PATH_PATTERNS') || !spec.includes('/artists/{id}/top-tracks') || !spec.includes('/me/{type}/contains')) {
    errors.push('SPEC.md: endpoint constraints do not name GATED_PATH_PATTERNS and the gated batch/top-tracks families');
  }
  if (!readme.includes('### Registration-gated endpoints')) {
    errors.push('README.md: missing Registration-gated endpoints heading/anchor');
  }
  return errors;
}

function writeBlock(file, name, body) {
  const [start, end] = markers(file, name);
  const expected = `${start}\n${body}\n${end}`;
  const source = readFileSync(file, 'utf8');
  const startCount = source.split(start).length - 1;
  const endCount = source.split(end).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`${relative(ROOT, file)}: generated ${name} requires exactly one start and end marker (found ${startCount}/${endCount})`);
  }
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  writeFileSync(file, source.replace(pattern, expected));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
