#!/usr/bin/env node
/**
 * Validate executable tool references in documentation against the finalized
 * default production registry. Tool names and JSON input schemas come from
 * scripts/surface-census.mjs, so count and name contracts share one source.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const census = JSON.parse(execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
}));
const tools = new Set(census.toolNames);
const prompts = new Set(census.promptNames);
const resources = new Set(census.resourceUris);
const parameterAllowlist = new Set([
  ...(census.parameterNames ?? []),
  'account_premium', 'active_modules', 'active_toolsets', 'additional_types',
  'appears_on', 'authorization_code', 'available_markets', 'budget_shrunk',
  'check_duplicates', 'client_id', 'client_secret', 'code_challenge',
  'code_verifier', 'context_uri', 'device_id', 'dry_run', 'era_index',
  'expires_at', 'expires_in', 'fetch_all', 'from_genre', 'include_external',
  'include_groups', 'insert_before', 'invalid_grant', 'jpeg_base64',
  'max_artists', 'max_results', 'offset_uri', 'playlist_id', 'position_ms',
  'queue_size', 'range_length', 'range_start', 'rate_limit', 'redirect_uri',
  'refresh_token', 'registered_tools', 'requests_made', 'requests_planned',
  'response_format', 'search_type', 'snapshot_id', 'statsfm_user', 'swarm3_library',
  'time_range', 'to_genre', 'token_refresh', 'top_limit', 'track_count',
  'user_id', 'volume_percent', 'web_search',
]);
const documentedMetadata = new Set([
  'toolset_trimmed', 'scope_blocked', 'read_only_hidden',
  'deprecated_inputs', 'deprecation_note',
]);
const nonToolAllowlist = new Set([...prompts, ...resources, ...parameterAllowlist, ...documentedMetadata]);
const markdownFiles = [
  'README.md',
  'SPEC.md',
  'ARCHITECTURE.md',
  ...walk(join(ROOT, 'docs')),
  ...walk(join(ROOT, 'skills')),
].filter((file) => file.endsWith('.md')).sort();
const errors = [];

function checkDocumentToolContracts(source, file, registry = census) {
  return collectDocumentToolContractErrors(source, file, registry);
}

if (process.argv.includes('--check-fixture')) {
  const fixturePath = process.argv[process.argv.indexOf('--check-fixture') + 1];
  const found = checkDocumentToolContracts(readFileSync(resolve(fixturePath), 'utf8'), fixturePath, census);
  for (const error of found) console.error(error);
  process.exit(found.length > 0 ? 1 : 0);
}

for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8');
  checkBacktickToolNames(file, source);
  checkJsonToolExamples(file, source);
  checkCallRecipes(file, source);
  checkToolArgumentTables(file, source);
}

if (errors.length > 0) {
  console.error(`Documentation tool contract check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n${unique(errors).map((line) => `- ${line}`).join('\n')}`);
  console.error('Use a finalized production tool and only arguments declared by that tool’s production inputSchema.');
  process.exitCode = 1;
} else {
  console.log(`Documentation tool contracts match the finalized production registry (${tools.size} tools and schemas checked).`);
}

function collectDocumentToolContractErrors(source, file, registry) {
  const found = [];
  const collect = (error) => found.push(error);
  const originalPush = errors.push;
  errors.push = collect;
  try {
    checkBacktickToolNames(file, source, registry);
    checkJsonToolExamples(file, source, registry);
    checkCallRecipes(file, source, registry);
    checkToolArgumentTables(file, source, registry);
  } finally {
    errors.push = originalPush;
  }
  return unique(found);
}

function checkBacktickToolNames(file, source, registry = census) {
  const knownTools = new Set(registry.toolNames);
  const knownNonTools = new Set([...registry.promptNames, ...registry.resourceUris, ...parameterAllowlist, ...documentedMetadata]);
  for (const match of source.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    const name = match[1];
    if (knownTools.has(name) || knownNonTools.has(name)) continue;
    errors.push(`${relative(ROOT, file)}:${lineAt(source, match.index)}: undocumented snake_case tool reference \`${name}\``);
  }
}

function checkJsonToolExamples(file, source, registry = census) {
  for (const match of source.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    let value;
    try {
      value = JSON.parse(match[1]);
    } catch (error) {
      if (!/['\"]tool['\"]\s*:/.test(match[1])) continue;
      errors.push(`${relative(ROOT, file)}:${lineAt(source, match.index)}: invalid JSON tool example (${error instanceof Error ? error.message : error})`);
      continue;
    }
    visitJsonToolExamples(value, file, lineAt(source, match.index), registry);
  }
}

function visitJsonToolExamples(value, file, line, registry) {
  if (Array.isArray(value)) {
    for (const entry of value) visitJsonToolExamples(entry, file, line, registry);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.tool === 'string') validateToolArguments(file, line, value, registry);
  for (const entry of Object.values(value)) visitJsonToolExamples(entry, file, line, registry);
}

function checkCallRecipes(file, source, registry = census) {
  for (const match of source.matchAll(/\b(?:Call|call)\s+`?([a-z][a-z0-9_]*)`?\s+with\s+([^\n.;]+)/g)) {
    const [, tool, tail] = match;
    const line = lineAt(source, match.index);
    if (!registry.toolNames.includes(tool)) {
      errors.push(`${relative(ROOT, file)}:${line}: Call recipe names unknown tool \`${tool}\``);
      continue;
    }
    const args = Object.fromEntries([...tail.matchAll(/`([a-z][a-z0-9_]*)\s*:/g)].map((arg) => [arg[1], true]));
    if (Object.keys(args).length > 0) validateArgumentKeys(file, line, tool, args, registry);
  }
}

function checkToolArgumentTables(file, source, registry = census) {
  const lines = source.split('\n');
  let activeTool = null;
  let inInputs = false;
  for (let index = 0; index < lines.length; index++) {
    const heading = /^#{3,4}\s+`([a-z][a-z0-9_]*)`/.exec(lines[index]);
    if (heading) {
      activeTool = registry.toolNames.includes(heading[1]) ? heading[1] : null;
      inInputs = false;
      continue;
    }
    if (/^###\s+/.test(lines[index])) {
      activeTool = null;
      inInputs = false;
      continue;
    }
    if (/^\*\*Inputs:\*\*/.test(lines[index])) {
      inInputs = true;
      continue;
    }
    if (/^\*\*(?:Returns|Notes):\*\*/.test(lines[index])) inInputs = false;
    if (!activeTool || !inInputs) continue;
    const row = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/.exec(lines[index]);
    if (row) validateArgumentKeys(file, index + 1, activeTool, { [row[1]]: true }, registry);
  }
}

function validateToolArguments(file, line, example, registry) {
  if (!registry.toolNames.includes(example.tool)) {
    errors.push(`${relative(ROOT, file)}:${line}: JSON example names unknown tool \`${example.tool}\``);
    return;
  }
  const args = example.arguments && typeof example.arguments === 'object' && !Array.isArray(example.arguments)
    ? example.arguments
    : Object.fromEntries(Object.entries(example).filter(([key]) => key !== 'tool'));
  validateArgumentKeys(file, line, example.tool, args, registry);
}

function validateArgumentKeys(file, line, tool, args, registry) {
  const schema = registry.toolInputSchemas?.[tool];
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') {
    errors.push(`${relative(ROOT, file)}:${line}: production tools/list has no inputSchema.properties for \`${tool}\``);
    return;
  }
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) {
      errors.push(`${relative(ROOT, file)}:${line}: \`${key}\` is not an input parameter of \`${tool}\` (schema: ${Object.keys(properties).sort().join(', ')})`);
    }
  }
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function unique(values) {
  return [...new Set(values)];
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) files.push(...walk(file));
    else files.push(file);
  }
  return files;
}
