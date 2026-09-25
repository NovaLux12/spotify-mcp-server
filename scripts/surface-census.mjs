#!/usr/bin/env node
/**
 * Enumerate the finalized default production MCP registry without network I/O.
 *
 * The authoritative surface is the real `src/index.ts` stdio entry, driven by
 * the MCP client SDK. Registration gates and production finalizers therefore
 * run exactly as they do for a host. A separate source-derived registrar pass
 * supplies module attribution only; its names are intersected with the live
 * `tools/list` names so it can never inflate the headline.
 *
 * Plain `node scripts/surface-census.mjs` prints JSON. `--write` refreshes
 * generated documentation blocks and `--check` guards them in CI.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const census = await readProductionRegistry();
const moduleNames = await attributeToolsToModules(census.toolNames);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const perModule = countModuleTools(moduleNames);
const toolModuleFiles = Object.keys(perModule).filter((file) => file.startsWith('src/tools/')).length;
const registrationKeyNames = [...new Set(allRegistrationKeysFromSource())].sort();
const result = {
  tools: census.toolNames.length,
  toolModuleFiles,
  registrationKeys: registrationKeyNames.length,
  resources: census.resourceUris.length,
  resourceTemplates: census.resourceTemplateUris.length,
  prompts: census.promptNames.length,
  toolNames: census.toolNames,
  resourceUris: census.resourceUris,
  resourceTemplateUris: census.resourceTemplateUris,
  promptNames: census.promptNames,
  registrationKeyNames,
  perModule,
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
  ['ARCHITECTURE.md', 'surface-census', `${shortSurface} The tool surface is attributed to ${result.toolModuleFiles} files under \`src/tools/\` plus the inline \`verify_receipt\` registration in \`src/index.ts\`.`],
  ['ARCHITECTURE.md', 'module-map', architecture],
  ['SPEC.md', 'package-contract', ['```json', packageExcerpt, '```'].join('\n')],
  ['SPEC.md', 'tool-surface', toolSurface(result)],
  ['SPEC.md', 'resource-surface', resourceSurface(result)],
  ['SPEC.md', 'prompt-surface', promptSurface(result)],
  ['docs/distribution.md', 'surface-census', distributionSurface(result)],
  ['docs/wave2-composites.md', 'surface-census', wave2Surface(result)],
  ['skills/spotify-exhaustive-feature-sweep/SKILL.md', 'surface-census', skillSurface(result)],
  ['skills/spotify-mcp-competitor-comparison/SKILL.md', 'surface-census', skillSurface(result)],
  ['src/toolsets.ts', 'surface-census', [
    '// Production surface (generated; run `npm run count:tools -- --write` after registry changes):',
    `// ${result.tools} tools, ${result.resources} fixed resources, ${result.resourceTemplates} resource templates, and ${result.prompts} prompts.`,
  ].join('\n')],
];

const drift = checkDocumentation(blocks);
if (args.includes('--check') && drift.length > 0) {
  console.error(`Documentation drift from the finalized production registry (default tools/list: ${result.tools}):\n${drift.map((line) => `- ${line}`).join('\n')}`);
  console.error('Run `npm run count:tools -- --write` after reviewing registry changes.');
  process.exitCode = 1;
} else if (args.includes('--write')) {
  for (const [file, name, body] of blocks) writeBlock(join(ROOT, file), name, body);
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
      SPOTIFY_CLIENT_ID: 'surface-census',
      SPOTIFY_MCP_TOKEN_FILE: tokenFile,
      SPOTIFY_MCP_TOOLSETS: 'all',
      SPOTIFY_MCP_ENABLE_TOOLS: '',
      SPOTIFY_MCP_DISABLE_TOOLS: '',
      SPOTIFY_MCP_READONLY: '0',
      SPOTIFY_MCP_CONFIRM: 'never',
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
 * Discover registrars from the same import manifest used by src/index.ts.
 * This pass exists only to attribute final live names to files. Its output is
 * intersected with the production registry above before becoming perModule.
 */
async function attributeToolsToModules(liveToolNames) {
  const source = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
  const imports = new Map();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/tools\/([^'"]+)\.js['"]/g)) {
    const [, symbols, file] = match;
    for (const specifier of symbols.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const symbol = parts[1] ?? parts[0];
      if (/^[A-Za-z0-9_]+$/.test(symbol)) imports.set(symbol, `src/tools/${file}.ts`);
    }
  }
  const live = new Set(liveToolNames);
  const attributed = new Map();
  const clientStub = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
    getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
  };

  for (const [file] of toolModuleFilesFromSource()) {
    const names = new Set();
    try {
      const moduleUrl = pathToFileURL(join(ROOT, file)).href;
      const loaded = await import(`${moduleUrl}?surface-census=${Date.now()}`);
      for (const [symbol, registrar] of Object.entries(loaded)) {
        if (!imports.has(symbol) || typeof registrar !== 'function') continue;
        const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
        const server = new McpServer({ name: `module-census-${basename(file, '.ts')}`, version: '0.0.0' });
        const originalTool = server.tool.bind(server);
        const originalRegisterTool = server.registerTool.bind(server);
        server.tool = (name, ...rest) => { names.add(name); return originalTool(name, ...rest); };
        server.registerTool = (name, ...rest) => { names.add(name); return originalRegisterTool(name, ...rest); };
        registrar(server, clientStub);
        for (const name of names) {
          if (!live.has(name)) continue;
          const owners = attributed.get(name) ?? [];
          owners.push(file);
          attributed.set(name, owners);
        }
        names.clear();
        await server.close().catch(() => undefined);
      }
    } catch (error) {
      throw new Error(`failed to attribute ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const missing = liveToolNames.filter((name) => name !== 'verify_receipt' && !attributed.has(name));
  if (missing.length > 0) {
    throw new Error(`finalized tools/list contains ${missing.length} name(s) absent from the src/index.ts registrar manifest: ${missing.join(', ')}`);
  }
  const ambiguous = [...attributed].filter(([, owners]) => owners.length > 1);
  if (ambiguous.length > 0) {
    throw new Error(`finalized tool names have ambiguous module attribution: ${ambiguous.map(([name, owners]) => `${name} (${owners.join(', ')})`).join('; ')}`);
  }
  const namesByModule = new Map(toolModuleFilesFromSource().map(([file]) => [file, []]));
  for (const [name, owners] of attributed) namesByModule.get(owners[0]).push(name);
  namesByModule.set('src/index.ts', liveToolNames.includes('verify_receipt') ? ['verify_receipt'] : []);
  return namesByModule;
}

function toolModuleFilesFromSource() {
  return readdirSync(join(ROOT, 'src/tools'))
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .map((file) => [`src/tools/${file}`]);
}

function countModuleTools(namesByModule) {
  return Object.fromEntries([...namesByModule].map(([file, names]) => [file, names.length]));
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
    const description = firstDescription(source, basename(file, '.ts'), sentenceSegmenter)
      .replaceAll('|', '\\|')
      .replace(/\s+/g, ' ');
    const registered = census.perModule[file] ?? 0;
    const noun = registered === 1 ? 'tool' : 'tools';
    return `| \`${file}\` | ${description} (${registered} registered ${noun}) | ${source.split('\n').length - 1} |`;
  });
  return ['| File | Responsibility | LOC |', '|---|---|---:|', ...rows].join('\n');
}

function inventoryFiles() {
  return [
    ...readdirSync(join(ROOT, 'src')).filter((file) => file.endsWith('.ts')).map((file) => `src/${file}`),
    ...readdirSync(join(ROOT, 'src/lib')).filter((file) => file.endsWith('.ts')).map((file) => `src/lib/${file}`),
    ...readdirSync(join(ROOT, 'src/tools')).filter((file) => file.endsWith('.ts')).map((file) => `src/tools/${file}`),
  ].sort();
}

function firstDescription(source, fallback, segmenter) {
  const doc = /^\/\*\*\s*\n([\s\S]*?)\n\s*\*\//.exec(source);
  if (!doc) return `Runtime module for ${fallback}.`;
  const lines = doc[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trim());
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
  return `The finalized default MCP registry exposes **${census.tools} tools** (${census.tools - 1} attributed to the ${census.toolModuleFiles} files under \`src/tools/\`, plus inline \`verify_receipt\`), organized by ${census.registrationKeys} registration keys and ${census.toolsetNames} named toolsets. Registration keys: ${census.registrationKeyNames.map((key) => `\`${key}\``).join(', ')}. \`node scripts/surface-census.mjs\` derives the authoritative inventory by starting the real \`src/index.ts\` stdio entry and calling \`tools/list\`, \`resources/list\`, \`resources/templates/list\`, and \`prompts/list\` after production gates and finalizers, without network access.`;
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

function checkDocumentation(blocks) {
  const errors = [];
  for (const [file, name, body] of blocks) {
    const expected = renderedBlock(file, name, body);
    const actual = readFileSync(join(ROOT, file), 'utf8');
    if (!actual.includes(expected)) errors.push(`${file}: generated ${name} block is stale`);
  }
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
  for (const endpoint of ['/artists/{id}/top-tracks', '/me/{type}/contains']) {
    if (!readme.includes(endpoint)) errors.push(`README.md: missing gated endpoint ${endpoint}`);
  }
  if (!spec.includes('GATED_PATH_PATTERNS') || !spec.includes('/artists/{id}/top-tracks') || !spec.includes('/me/{type}/contains')) {
    errors.push('SPEC.md: endpoint constraints do not name GATED_PATH_PATTERNS and the gated batch/top-tracks families');
  }
  const heading = '### Registration-gated endpoints';
  if (!readme.includes(heading)) errors.push('README.md: missing Registration-gated endpoints heading');
  return errors;
}

function writeBlock(file, name, body) {
  const [start, end] = markers(file, name);
  const expected = `${start}\n${body}\n${end}`;
  const source = readFileSync(file, 'utf8');
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(source)) throw new Error(`${relative(ROOT, file)}: missing generated ${name} markers`);
  writeFileSync(file, source.replace(pattern, expected));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
