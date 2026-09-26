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
const censusFileIndex = process.argv.indexOf('--census-file');
if (censusFileIndex >= 0 && !process.argv[censusFileIndex + 1]) {
  throw new Error('--census-file requires a JSON file');
}
const census = JSON.parse(censusFileIndex >= 0
  ? readFileSync(resolve(process.argv[censusFileIndex + 1]), 'utf8')
  : execFileSync(process.execPath, ['scripts/surface-census.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const tools = new Set(census.toolNames);
const prompts = new Set(census.promptNames);
const resources = new Set(census.resourceUris);
/**
 * Names a doc may backtick that are NOT production tool parameters: auth/OAuth
 * field names, doctor/report row keys, and env-var fragments. Real parameters
 * are not listed — they come from `census.parameterNames`, so a parameter that
 * production drops stops being allowlisted the moment it does, instead of
 * surviving here and masking real drift.
 */
const parameterAllowlist = new Set([
  ...(census.parameterNames ?? []),
  'account_premium', 'active_modules', 'active_toolsets', 'authorization_code',
  'budget_shrunk', 'client_id', 'client_secret', 'code_challenge',
  'code_verifier', 'expires_at', 'expires_in', 'invalid_grant', 'rate_limit',
  'redirect_uri', 'refresh_token', 'registered_tools', 'requests_made',
  'requests_planned', 'token_refresh', 'web_search',
  // Enum values and explicitly-removed field names, not parameters.
  'appears_on', 'available_markets',
  // StructuredContent field names, not parameters: the documented count split.
  'removed_total', 'kept_total', 'source_truncated', 'target_truncated',
  'would_confirm', 'base_read_whole', 'base_unrepresentable',
  'removed_uris', 'scan_cap', 'base_playlist', 'target_playlist',
  // #809: create_smart_playlist documents the candidate-pool ceiling it now
  // reports. Both are structuredContent keys on that tool, not parameters and
  // not tools — the description is naming its own output, which is the point.
  'pool_capped', 'pool_cap',
]);
/** Registration keys are module names, not tools; docs legitimately name them. */
const registrationKeyNames = new Set(census.registrationKeyNames ?? []);
/**
 * Tool names this release RETIRED. A migration note has to be able to name what
 * it replaces; every other retired name still fails the gate, so this cannot
 * become a graveyard.
 */
const retiredToolNames = new Set(['get_show_episodes']);
const documentedMetadata = new Set([
  'toolset_trimmed', 'scope_filtered', 'read_only_hidden',
  'deprecated_inputs', 'deprecation_note', 'auth', 'forbidden', 'not_found',
  'rate_limited', 'unavailable', 'statsfm_resource_not_found', 'conflict',
  'unknown_param', 'unknown_tool', 'playlist_changed_since_read',
]);
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
  const found = checkDocumentToolContracts(source, file);
  for (const error of found) errors.push(error);
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
    checkModuleMapEntries(file, source, registry);
  } finally {
    errors.push = originalPush;
  }
  return unique(found);
}

function checkBacktickToolNames(file, source, registry = census) {
  const knownTools = new Set(registry.toolNames);
  const knownNonTools = new Set([...registry.promptNames, ...registry.resourceUris, ...parameterAllowlist, ...documentedMetadata, ...(registry.registrationKeyNames ?? registrationKeyNames), ...retiredToolNames]);
  for (const match of source.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    const name = match[1];
    if (knownTools.has(name) || knownNonTools.has(name)) continue;
    errors.push(`${relative(ROOT, file)}:${lineAt(source, match.index)}: undocumented snake_case tool reference \`${name}\``);
  }
}

/**
 * Module maps (`playlists.ts  # get_playlist, add_to_playlist, …`) are tool
 * contracts too: the tree in SPEC.md §11 listed four tools that no longer
 * exist, and every other matcher missed it because the names appear neither
 * in backticks nor in a json fence nor in an Inputs table.
 */
function checkModuleMapEntries(file, source, registry = census) {
  const knownTools = new Set(registry.toolNames);
  const knownNonTools = new Set([...registry.promptNames, ...registry.resourceUris, ...parameterAllowlist, ...documentedMetadata, ...(registry.registrationKeyNames ?? registrationKeyNames), ...retiredToolNames]);
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const entry = /^\s*(?:[│|├└─\s])*([a-z0-9_]+\.ts)\s+#\s*(.+?)\s*$/.exec(lines[index]);
    if (!entry) continue;
    for (const name of entry[2].match(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g) ?? []) {
      if (knownTools.has(name) || knownNonTools.has(name)) continue;
      errors.push(`${relative(ROOT, file)}:${index + 1}: module map for ${entry[1]} names unknown tool \`${name}\``);
    }
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
  const properties = registry.toolInputSchemas?.[example.tool]?.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(args)) {
      validateExampleValue(file, line, example.tool, key, value, properties[key]);
    }
  }
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

function validateExampleValue(file, line, tool, pathName, value, schema) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} example value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  const expectedType = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
  if (expectedType.length > 0 && !expectedType.includes(actualType) && !(expectedType.includes('number') && actualType === 'integer')) {
    errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} example value ${JSON.stringify(value)} is not ${expectedType.join('|')}`);
    return;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} example is below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} example exceeds maximum ${schema.maximum}`);
  }
  if (actualType === 'object' && schema.properties && typeof schema.properties === 'object') {
    for (const requiredKey of schema.required ?? []) {
      if (!Object.hasOwn(value, requiredKey)) errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} is missing required ${requiredKey}`);
    }
  }
  if (actualType === 'array' && schema.items) {
    value.forEach((item, index) => validateExampleValue(file, line, tool, `${pathName}[${index}]`, item, schema.items));
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
