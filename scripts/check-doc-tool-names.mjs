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
  // #677: the token-endpoint failure classes. RFC 6749 §5.2 error codes the
  // refresh response carries (`invalid_client`, `server_error`) and one
  // category name of this server's own classifier (`network_unreachable`).
  // None is a tool or a parameter; both docs are naming what the token endpoint
  // returns so an operator can tell the failures apart.
  'invalid_client', 'server_error', 'network_unreachable',
  // Enum values and explicitly-removed field names, not parameters.
  'appears_on', 'available_markets',
  // `time_range` enum members of the /me/top/* personalization tools. #807's
  // SPEC entry names them as the windows taste_shift_report compares, and as
  // the two halves of the `window_sizes` it returns.
  'short_term', 'long_term',
  // StructuredContent field names, not parameters: the documented count split.
  'removed_total', 'kept_total', 'source_truncated', 'target_truncated',
  'would_confirm', 'base_read_whole', 'base_unrepresentable',
  // #860: playlist_union / playlist_subtract now report whether the commit
  // will be refused outright, and the union side of the unrepresentable-row
  // count joins its base counterpart above. Both are structuredContent keys
  // about a call's own result, not parameters and not tools.
  'would_refuse', 'target_unrepresentable',
  'removed_uris', 'scan_cap', 'base_playlist', 'target_playlist',
  // #809: create_smart_playlist documents the candidate-pool ceiling it now
  // reports. Both are structuredContent keys on that tool, not parameters and
  // not tools — the description is naming its own output, which is the point.
  'pool_capped', 'pool_cap',
  // #757: restore_library_snapshot documents the snapshot schema version it
  // refuses on. A key inside the file it reads, not a tool or parameter.
  'schema_version',
  // StructuredContent keys the walk/disclosure work added and ARCHITECTURE.md
  // now names. Neither is a tool or a parameter; both are what a call reports
  // back about its own result.
  'fetch_all_cap', 'truncated_by_cap',
  // #697: list_backups reports the on-disk size and the age window of the
  // snapshots it found, so the retention prose in docs/configuration.md can
  // name them. StructuredContent keys on that tool — the doc is describing
  // the tool's own output, not routing to another tool.
  'dir_bytes', 'oldest_created', 'oldest_retention_until',
  // #725: the get_several_* tools publish a `degraded_reason` alongside
  // `degraded: true` so callers can tell a per-item round-trip apart from a
  // clean batch read. StructuredContent keys on every batch tool, not
  // parameters or tools — the README is naming what the tool returns.
  'degraded_reason',
  // #865: the chunked-playlist-write partial-state contract. SPEC.md §5
  // names the fields so a caller can resume a failed multi-chunk write;
  // every one is a structuredContent key on the tool that reports it, not a
  // parameter and not a tool.
  'partial_write_failure', 'attempted_chunks', 'failed_chunk_index',
  'last_committed_chunk_index', 'last_committed_chunk_uris',
  'attempted_uris', 'committed_uris', 'remaining_uris',
  // #688: verify_receipt's structuredContent is the stored Receipt object
  // flattened alongside `found`, and `expect_present` is the field that tells a
  // re-render which direction the mutation went — a caller must be able to
  // branch on it rather than parse prose. A key the tool returns about its own
  // result, not a parameter.
  'expect_present',
  // #713: SPEC.md §5.11 documents the discovery trio's response_format, which
  // means naming the payload each mode serializes. These are the remaining
  // structuredContent keys of find_tool/inspect_tool/toolset_report, joining
  // registered_tools/active_modules/active_toolsets above.
  'total_registered', 'input_schema', 'read_only', 'module_schema_budgets',
  'registration_exclusions', 'batch_caps',
  // #903: balance_playlist_pairs caps its planned-move array at max_results
  // and discloses what the cap withheld, so SPEC.md can name those keys.
  // structuredContent keys on that tool, not tools and not parameters.
  'moves_total', 'moves_returned', 'moves_withheld', 'moves_truncated',
  // #807: taste_shift_report reports the size of each window it compared, so a
  // caller can tell "taste did not change" from "there was nothing to compare"
  // without parsing the prose. A StructuredContent key on that tool, not a
  // parameter — SPEC.md is describing the tool's own output.
  'window_sizes',
  // #781: every offset-paged read publishes the offset to continue from as
  // `pagination.next_offset` in structuredContent, which is the field SPEC.md's
  // shared paging-signal contract names. A key a tool returns about its own
  // page — not a parameter the caller sends, and not a tool.
  'next_offset',
  // #731: search_within_playlist gained a `kind` filter, which made the walk
  // behind it report its own coverage so a capped scan is distinguishable
  // from a narrow one. These are the structuredContent keys it returns about
  // its own result — not tools, and not parameters of anything.
  'scanned_items', 'scan_truncated', 'items_of_unknown_kind',
  // #783: the radar scans report the width their fan-out actually ran at, and
  // which knob supplied it — the request funnel's SPOTIFY_MCP_MAX_CONCURRENCY
  // or this work's own fallback — so docs/configuration.md can name the
  // tunable and its precedence. structuredContent keys describing the tool's
  // own result, not tools and not parameters.
  'fanout_concurrency', 'fanout_concurrency_source',
  // #898: playlist_expression_algebra and playlist_fill_from_search both walk
  // source playlists under SPOTIFY_MCP_FETCH_ALL_CAP and both turn what they
  // read into a write, so each reports whether its reads were whole. The
  // algebra names the clipped refs and the per-ref counts; the fill names its
  // own pre-read and refuses to state a resulting length off a clipped one.
  // structuredContent keys naming a tool's own result, not tools and not
  // parameters.
  'truncated_refs', 'ref_scans', 'existing_truncated', 'existing_scanned',
  'existing_total', 'existing_truncated_by_cap', 'now_total',
  // #899: the bounded playlist lists report what their bound actually bought.
  // SPEC.md names both keys so a caller can see the read cost of a call
  // instead of inferring it from the row count. structuredContent keys on the
  // tools that report them, not tools and not parameters.
  'requests_read', 'search_requests_read',
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
/**
 * Range vocabulary (#720). The JSON-example check already rejects a bad
 * `range` value inside a ```json fence, but the ranges *reference* is prose:
 * docs/statsfm.md told taste-tool callers to pass `week`/`month` while the
 * endpoint tools enforced `weeks`/`months`, and stats.fm itself answers
 * `400 invalid range` for the singular spellings. Prose is where this drift
 * actually lived, so prose is what gets checked.
 *
 * The accepted set is read from the production schemas rather than declared
 * here, so this check cannot drift from the registry it is meant to police.
 *
 * `year` is deliberately absent from the candidate set: `statsfm_recaps`
 * takes an optional calendar `year`, so treating it as a range literal would
 * flag a correct sentence about a different parameter.
 */
const RANGE_CANDIDATES = new Set([
  'today', 'day', 'days', 'week', 'weeks', 'month', 'months',
  '6month', '6months', 'all-time', 'all_time', 'alltime',
]);

/** A line that says these values are *rejected* is not documenting them. */
const RANGE_REJECTION = /\b400\b|\brejects?\b|rejected\b|not\s+accepted|\bnot\s+valid\b|\binvalid\b/i;

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
    checkRangeEnumLiterals(file, source, registry);
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

function productionRangeEnum(registry) {
  const values = new Set();
  for (const schema of Object.values(registry.toolInputSchemas ?? {})) {
    const range = schema?.properties?.range;
    if (range && Array.isArray(range.enum)) for (const value of range.enum) values.add(value);
  }
  return values;
}

function checkRangeEnumLiterals(file, source, registry = census) {
  const accepted = productionRangeEnum(registry);
  if (accepted.size === 0) return;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\brange\b/i.test(lines[index]) || RANGE_REJECTION.test(lines[index])) continue;
    for (const match of lines[index].matchAll(/`([^`\n]+)`/g)) {
      const literal = match[1].trim().toLowerCase();
      if (!RANGE_CANDIDATES.has(literal) || accepted.has(literal)) continue;
      errors.push(`${relative(ROOT, file)}:${index + 1}: documented range value \`${match[1]}\` is not one of the production range enum (${[...accepted].sort().join(', ')})`);
    }
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
