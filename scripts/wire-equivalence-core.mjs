/**
 * The pure half of the wire-equivalence harness (#1481).
 *
 * This module is deliberately side-effect free: it imports NOTHING from `src/`,
 * touches no filesystem, and reads no environment. That is what lets
 * `tests/wire-equivalence.test.ts` import it directly and drive the comparison
 * over a synthetic pair, which is the only way to prove the comparison can go
 * red without mutating the working tree mid-suite. The half that DOES import
 * server code — and therefore MUST have redirected `HOME` first — lives in
 * `scripts/wire-equivalence.mjs`.
 *
 * ## What "wire equivalence" means here
 *
 * For each tool, for each argument case, the harness records the exact
 * `tools/call` result a real MCP host would receive: `content`,
 * `structuredContent`, and `isError`, crossed through the SDK — not the handler
 * called directly. Two commits are equivalent when the two snapshot files are
 * byte-identical.
 */

/**
 * The instant every `Date` reads as.
 *
 * A frozen clock rather than a mask. `new Date()` and `Date.now()` appear at
 * 147 call sites in `src/`, and several of them reach the wire (a receipt's
 * `created_at`, a search-history record's `timestamp`, a freshness watermark).
 * Masking a timestamp hides a *change* to one; freezing the clock makes the
 * whole class reproducible, so a refactor that starts emitting a different date
 * is caught as a real difference rather than normalized away.
 *
 * Chosen to be a fixed, ordinary instant — 2026-01-02T03:04:05.000Z. Not the
 * epoch, because `new Date(0)` is a value several code paths special-case
 * (falsy checks, "is this the zero date" guards), and a harness whose baseline
 * only passes because every date is zero is not measuring the tree.
 */
export const FROZEN_NOW_MS = Date.parse('2026-01-02T03:04:05.000Z');

/**
 * The seed for `Math.random`.
 *
 * Fixed, and therefore reproducible. `src/tools/exhaust2_playlists.ts:270` and
 * `src/tools/playlists.ts:2643` run a Fisher–Yates shuffle that reaches the
 * wire as an item ORDER, so an unseeded harness would report a difference on
 * every run and be useless.
 *
 * Seeding is strictly better than the masking the issue proposed for this
 * site, and the reason is worth recording: a mask applied to shuffled output
 * has to erase the *order* to be safe, which erases the one property the
 * shuffle exists to produce. A seed fixes the order without hiding it — two
 * commits that shuffle differently still differ. `Math.random` is replaced
 * rather than re-seeded per call, so the sequence is consumed in the same order
 * on both sides; a refactor that adds a `Math.random()` call before a shuffle
 * changes that order and is correctly reported as a difference.
 */
export const RANDOM_SEED = 0x1481_0001;

/**
 * The value masks, as ordered `[pattern, replacement]` pairs.
 *
 * ## Why a mask list at all, when the clock and the RNG are pinned
 *
 * Three sources of per-run entropy are NOT reachable from `Date` or
 * `Math.random`, so they cannot be frozen:
 *
 *   - `crypto.randomBytes` / `crypto.randomUUID` from `node:crypto`, which the
 *     server imports by name. Monkey-patching a builtin's ESM named export from
 *     outside is not something a harness can do reliably, and a harness that
 *     claimed to would be a claim nobody could check.
 *   - the sandbox path itself, which is a fresh `mkdtemp` on every run and is
 *     named in tool output that reports which file it read or wrote.
 *
 * So those are masked, and the list is EXPLICIT and DOCUMENTED per the issue's
 * own instruction — the failure this issue exists to prevent was a mask
 * described as "the receipt id" that silently missed a second, unrelated id
 * shape. Each entry below names the site it covers.
 *
 * ## What is deliberately NOT here
 *
 * `toLocaleString()` output. `src/tools/statsfm.ts:577,1058`,
 * `src/tools/personalization.ts:232` and `src/resources/index.ts:651,1106`
 * format dates through the ambient locale and time zone, which would make a
 * snapshot machine-dependent. The issue's instruction is the right one: a
 * locale difference in output is a real finding, not noise, so the harness
 * PINS `TZ` and `LC_ALL`/`LANG` in the child environment rather than masking
 * the string. That way the snapshot is portable AND a genuine locale bug still
 * shows up as a difference between two commits made on differently configured
 * machines.
 */
export const VALUE_MASKS = Object.freeze([
  // The sandbox root, e.g. /tmp/spotify-mcp-wire-XXXXXX. Every store path a
  // tool reports resolves under it.
  [/spotify-mcp-wire-[A-Za-z0-9]+/g, '<SANDBOX>'],
  // Receipt ids: `rcpt_<bootId>-<n>` (src/receipts.ts:929). The boot id is
  // `${Date.now().toString(36)}${randomBytes(3).toString('hex')}` — a frozen
  // clock fixes the base-36 half and `randomBytes` fixes nothing, so the whole
  // boot id is masked and the SEQUENCE number is preserved. Preserving `<n>`
  // is the point: a refactor that changes how many receipts a call mints, or
  // the order it mints them in, is a real difference and stays visible.
  [/\brcpt_[0-9a-z]+-(\d+)\b/gi, 'rcpt_<BOOT>-$1'],
  // Search-history ids: `sh_<base36>_<8 hex>` (src/tools/searchhistory.ts:107).
  // NOT a receipt id and not reachable by the pattern above — a mask described
  // as "the id" would miss this, which is the specific trap #1481 names.
  [/\bsh_[0-9a-z]+_[0-9a-f]+\b/g, 'sh_<ID>'],
  // Atomic-write temp names: `<path>.<pid>.<16 hex>.tmp`
  // (src/tools/freshness.ts:289, src/tools/artistwatch.ts:216,
  //  src/tools/statsfm_taste.ts:652, src/auth.ts:682). Transient by
  // construction — a run that reports one is a run that leaked a temp file,
  // and masking the name would hide that as well, so only the two variable
  // segments are replaced.
  [/\.(\d+)\.[0-9a-f]{16}\.tmp\b/g, '.<PID>.<RAND>.tmp'],
]);

/**
 * Apply every mask, in order, to one already-serialized JSON string.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskValues(text) {
  let out = text;
  for (const [pattern, replacement] of VALUE_MASKS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * One `tools/call` invocation, as recorded in a snapshot line.
 *
 * @typedef {object} WireRecord
 * @property {string} tool     The tool name, exactly as registered.
 * @property {string} callCase Which argument case produced this result.
 * @property {unknown} args    The arguments sent, after `maskValues`.
 * @property {unknown} result  The `tools/call` result, after `maskValues`.
 */

/**
 * The argument matrix, as case names.
 *
 * A case is a SHAPE, not a per-tool fixture: `required` is synthesized from
 * each tool's own published `inputSchema`, so a tool added tomorrow is covered
 * without a line being written here. That is the same no-hand-maintained-list
 * rule the census follows, and for the same reason — a hand-typed table of 587
 * tools is a table that is wrong the moment a tool is added.
 *
 * `empty` is not filler. A large share of the surface is reached through an
 * argument-validation failure, and the exact wording and `kind` of that
 * failure is wire output a refactor can change.
 */
export const CALL_CASES = Object.freeze(['empty', 'required', 'json', 'detailed', 'concise']);

/**
 * Placeholder values for a JSON-Schema property, chosen by shape.
 *
 * A fixture, and treated as one: a value here that a tool rejects produces a
 * validation error, which is itself a deterministic wire result. Nothing in
 * the harness claims these arguments are *valid* — it claims they are
 * REPRODUCIBLE, which is the property a byte-diff needs.
 */
const BY_TYPE = Object.freeze({
  string: 'wire-equivalence',
  number: 1,
  integer: 1,
  boolean: true,
});

/**
 * Per-property overrides, for the shapes where the by-type default is
 * obviously the wrong domain and a validation error would make the case
 * measure only the validator.
 *
 * Keyed by property NAME, so they apply to every tool that declares that name —
 * `playlist_id` is a playlist id in one tool and in the next. Deliberately
 * short: the goal is a handful of cases that reach handler logic rather than
 * zod, not a complete fixture library.
 */
const BY_NAME = Object.freeze({
  id: '4uLU6hMCjMI75M1A2tKUQC',
  uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  query: 'daft punk',
  q: 'daft punk',
  market: 'GB',
  country: 'GB',
  playlist_id: '37i9dQZF1DXcBWIGoYBM5M',
  device_id: 'wire-device',
  device: 'wire-device',
  types: ['track'],
  kind: 'track',
  limit: 1,
});

/**
 * Synthesize an argument object satisfying a tool's `required` list.
 *
 * Reads the FINALIZED input schema — the same `tools/list` payload a host
 * validates against — rather than the zod source, so the harness cannot
 * disagree with the published contract about which arguments are required.
 *
 * @param {Record<string, unknown>} schema  A `finalInputSchema` result.
 * @returns {Record<string, unknown>}
 */
export function synthesizeRequiredArgs(schema) {
  const properties = (schema && typeof schema === 'object' ? schema.properties : null) ?? {};
  const required = (schema && typeof schema === 'object' && Array.isArray(schema.required) ? schema.required : []);
  const out = {};
  for (const name of required) {
    if (typeof name !== 'string') continue;
    const property = (typeof properties === 'object' && properties !== null ? properties[name] : null) ?? {};
    if (Object.hasOwn(BY_NAME, name)) {
      out[name] = BY_NAME[name];
      continue;
    }
    if (Array.isArray(property.enum) && property.enum.length > 0) {
      out[name] = property.enum[0];
      continue;
    }
    if (property.type === 'array') {
      out[name] = [];
      continue;
    }
    if (property.type === 'object') {
      out[name] = {};
      continue;
    }
    const byType = BY_TYPE[property.type];
    if (byType !== undefined) out[name] = byType;
    // No type and no enum: omit it. Guessing here would produce an argument
    // the schema rejects for a reason unrelated to what is being compared.
  }
  return out;
}

/**
 * Build the argument object for one case of one tool.
 *
 * @param {Record<string, unknown>} schema The tool's finalized input schema.
 * @param {string} callCase                 One of {@link CALL_CASES}.
 * @returns {Record<string, unknown>}
 */
export function argsForCase(schema, callCase) {
  if (callCase === 'empty') return {};
  const base = synthesizeRequiredArgs(schema);
  // The three format cases only differ for a tool that DECLARES
  // `response_format`. Sending it to a tool that does not would be rejected by
  // `additionalProperties: false` (src/shaping.ts:26) and every case would
  // measure the same rejection.
  const declaresFormat =
    schema && typeof schema === 'object' && typeof schema.properties === 'object' && schema.properties !== null
      ? Object.hasOwn(schema.properties, 'response_format')
      : false;
  if (callCase === 'required' || !declaresFormat) return base;
  return { ...base, response_format: callCase };
}

/**
 * Serialize a record to its one-line snapshot form.
 *
 * `JSON.stringify` with a stable key order — the record's own insertion order
 * — and masks applied to the RESULT. Masking the serialized string rather than
 * the object is deliberate: a masked value can appear in a nested position
 * this function has never heard of, and string-level masking is the only rule
 * that does not need to be taught each one.
 *
 * @param {WireRecord} record
 * @returns {string}
 */
export function serializeRecord(record) {
  return maskValues(JSON.stringify(record));
}

/**
 * Parse a snapshot file back into records, for the comparison.
 *
 * Fails loudly on a malformed line rather than skipping it: a snapshot whose
 * line 4 is corrupt would otherwise compare as "the tool is missing from one
 * side", which is a finding about the snapshot, reported as a finding about
 * the code.
 *
 * @param {string} text
 * @returns {WireRecord[]}
 */
export function parseSnapshot(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (cause) {
        throw new Error(`snapshot line ${index + 1} is not JSON: ${cause.message}`, { cause });
      }
    });
}

/**
 * Compare two snapshots and describe every difference.
 *
 * Keyed on `tool` + `callCase`, so a difference names the invocation rather
 * than a line number — the point of the artifact is to tell a reviewer WHICH
 * call changed, and a line number moves the moment a tool is added.
 *
 * Four outcomes, all reported:
 *   - `changed`  — present on both sides, different bytes.
 *   - `added`    — present only on the head side (a new tool or a new case).
 *   - `removed`  — present only on the base side.
 *   - `reordered`— the same set, in a different order. Reported separately
 *     because `tools/list` order is registration order and a host's rendering
 *     can depend on it, so it is a real difference rather than cosmetics.
 *
 * @param {string} baseText
 * @param {string} headText
 * @returns {{changed: object[], added: object[], removed: object[], reordered: boolean, counts: object}}
 */
export function compareSnapshots(baseText, headText) {
  const base = parseSnapshot(baseText);
  const head = parseSnapshot(headText);
  const key = (record) => `${record.tool} ${record.callCase}`;

  const baseByKey = new Map(base.map((record) => [key(record), record]));
  const headByKey = new Map(head.map((record) => [key(record), record]));

  const changed = [];
  for (const [id, baseRecord] of baseByKey) {
    const headRecord = headByKey.get(id);
    if (!headRecord) continue; // reported as `removed`
    const before = serializeRecord(baseRecord);
    const after = serializeRecord(headRecord);
    if (before !== after) changed.push({ tool: baseRecord.tool, callCase: baseRecord.callCase, before, after });
  }

  const added = [...headByKey.entries()]
    .filter(([id]) => !baseByKey.has(id))
    .map(([, record]) => ({ tool: record.tool, callCase: record.callCase, after: serializeRecord(record) }));
  const removed = [...baseByKey.entries()]
    .filter(([id]) => !headByKey.has(id))
    .map(([, record]) => ({ tool: record.tool, callCase: record.callCase, before: serializeRecord(record) }));

  // Order is compared on the KEY sequence, so a reordering is detected even
  // when every record is byte-identical.
  const reordered = base.length === head.length && base.map(key).join('\n') !== head.map(key).join('\n');

  return {
    changed,
    added,
    removed,
    reordered,
    counts: { base: base.length, head: head.length, changed: changed.length, added: added.length, removed: removed.length },
  };
}

/**
 * A one-line-per-difference human report.
 *
 * ## Why the changed case shows an OFFSET rather than a prefix
 *
 * The first version of this clipped both sides to a fixed prefix, which is
 * useless on the longest line in the file. The `<tools/list>` record is the
 * whole schema surface in one line — 579 KB on the current tree — and a
 * one-word description edit lands hundreds of kilobytes in. The report showed
 * two identical-looking 200-character prefixes and named the difference
 * without showing it, which is the one thing a diff exists to do.
 *
 * So a changed entry is rendered around the FIRST byte that differs, with the
 * offset printed. Added and removed entries keep the prefix clip: there is no
 * "first difference" between a string and nothing, and the beginning of a new
 * invocation is the part worth reading.
 *
 * The full record is always in the snapshot files, which is where a reviewer
 * goes for the whole thing.
 *
 * @param {{changed: object[], added: object[], removed: object[], reordered: boolean}} diff
 * @param {number} [width] Window size in characters, centred on the difference.
 * @returns {string}
 */
export function formatDiff(diff, width = 200) {
  const clip = (text) => (text.length > width ? `${text.slice(0, width)}… (${text.length} chars)` : text);

  /**
   * The first index at which two strings differ, or -1 when one is a prefix of
   * the other (a pure insertion or deletion, where the divergence is the end).
   */
  const firstDifference = (before, after) => {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1) {
      if (before.charCodeAt(index) !== after.charCodeAt(index)) return index;
    }
    return before.length === after.length ? -1 : shared;
  };

  /**
   * A window of `text` centred on `centre`, marked up so the reader can see
   * where the clip begins and ends.
   */
  const around = (text, centre) => {
    const start = Math.max(0, centre - Math.floor(width / 2));
    const end = Math.min(text.length, start + width);
    const prefix = start > 0 ? `…${start} chars in… ` : '';
    const suffix = end < text.length ? ` …${text.length - end} chars more` : '';
    return `${prefix}${text.slice(start, end)}${suffix}`;
  };

  const lines = [];
  for (const entry of diff.changed) {
    const at = firstDifference(entry.before, entry.after);
    lines.push(`CHANGED  ${entry.tool} [${entry.callCase}]${at < 0 ? '' : `  (first difference at char ${at})`}`);
    lines.push(`  - ${at < 0 ? clip(entry.before) : around(entry.before, at)}`);
    lines.push(`  + ${at < 0 ? clip(entry.after) : around(entry.after, at)}`);
  }
  for (const entry of diff.added) lines.push(`ADDED    ${entry.tool} [${entry.callCase}]\n  + ${clip(entry.after)}`);
  for (const entry of diff.removed) lines.push(`REMOVED  ${entry.tool} [${entry.callCase}]\n  - ${clip(entry.before)}`);
  if (diff.reordered) lines.push('REORDERED  the same invocations appeared in a different order');
  if (lines.length === 0) return 'wire-equivalence: no differences\n';
  return `${lines.join('\n')}\n`;
}

/**
 * A deterministic 32-bit digest of a snapshot, for a one-line summary.
 *
 * FNV-1a rather than a crypto hash: this is a change DETECTOR for a local
 * artifact, not a security primitive, and the point of printing it is that a
 * reviewer can paste one number and have it be reproducible from a committed
 * harness. A digest that cannot be recomputed by anyone else is the exact
 * failure #1481 reports.
 *
 * @param {string} text
 * @returns {string} 8 lowercase hex characters.
 */
export function digest(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
