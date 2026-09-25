#!/usr/bin/env node
/**
 * Reject snake_case references in documentation that look like MCP tool names
 * but are absent from the finalized default production `tools/list` registry.
 *
 * The checker intentionally uses backtick-delimited identifiers: prose remains
 * free-form, while executable examples and name lists become contracts. Tool
 * names come from scripts/surface-census.mjs, so this checker and the count
 * guard consume the same finalized production registry. Prompt names and the
 * explicit parameter/resource allowlists below are documented non-tool names.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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
  'response_format', 'snapshot_id', 'statsfm_user', 'swarm3_library',
  'time_range', 'to_genre', 'token_refresh', 'top_limit', 'track_count',
  'user_id', 'volume_percent', 'web_search',
]);
const nonToolAllowlist = new Set([...prompts, ...resources, ...parameterAllowlist]);
const markdownFiles = [
  'README.md',
  'SPEC.md',
  'ARCHITECTURE.md',
  ...walk(join(ROOT, 'docs')),
  ...walk(join(ROOT, 'skills')),
].filter((file) => file.endsWith('.md')).sort();
const errors = [];
const seen = new Map();

for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    const name = match[1];
    if (tools.has(name) || nonToolAllowlist.has(name)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    const key = `${relative(ROOT, file)}:${line}:${name}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      errors.push(`${relative(ROOT, file)}:${line}: undocumented snake_case tool reference \`${name}\` (not in finalized tools/list or explicit non-tool allowlist)`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Documentation tool-name check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n${errors.map((line) => `- ${line}`).join('\n')}`);
  console.error('Use a finalized production tool name, a documented prompt/resource, or add a deliberate parameter to the explicit allowlist.');
  process.exitCode = 1;
} else {
  console.log(`Documentation tool names match the finalized default production registry (${tools.size} tools; ${prompts.size} prompts; ${resources.size} fixed resources).`);
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
