/**
 * Shared helpers for the standalone live probe scripts (#646).
 *
 * Both `scripts/edge-probe.mjs` and `scripts/contains-check.mjs` talk to a real
 * Spotify account on a real developer app registration, and both write a report
 * a human is expected to paste into an issue. That makes three properties
 * load-bearing rather than cosmetic, so they live here once and are asserted
 * directly by `tests/probe-scripts.test.ts`:
 *
 *  - **Redaction.** The account's Spotify user id, display name and email must
 *    not reach a report, a path, or a line of stdout. `redactSnippet` scrubs
 *    the id out of a response body whether that body is JSON or prose, and
 *    blanks the identity keys a Spotify profile object carries.
 *  - **Report paths.** A report is written 0600 into a 0700 directory, under a
 *    name that carries the run's timestamp so two runs cannot clobber each
 *    other, and a caller-supplied path is validated rather than interpolated.
 *  - **Quota.** A 429 is answered with the `Retry-After` the server actually
 *    sent — honoured to the millisecond, doubled on a repeat — and a probe that
 *    never escapes the penalty window ends the run as a quota wall instead of
 *    firing the rest of the sweep into it.
 *
 * The backoff numbers deliberately mirror `src/client.ts` (`RETRY_BACKOFF_BASE_MS`
 * 250, `RETRY_AFTER_FALLBACK_SEC` 1, `MAX_ATTEMPTS` 3) so a probe and the
 * server it shares a registration with fail the same way.
 */

/** Dispatches one probe may consume, shared by the 429 and 5xx ladders. */
export const MAX_ATTEMPTS = 3;

/** First-retry 5xx backoff base; the ladder is 250 ms, then 500 ms. */
export const RETRY_BACKOFF_BASE_MS = 250;

/** Wait used when a `Retry-After` header is absent or unparsable. */
export const RETRY_AFTER_FALLBACK_SEC = 1;

/**
 * Longest a probe will sit on a `Retry-After`. Spotify's own ceiling is far
 * lower, so anything past this is a header we do not understand; a run that
 * honours it literally would hang for minutes, and the quota wall is the honest
 * outcome either way.
 */
export const RETRY_SLEEP_CAP_SEC = 60;

/** Gateways where a re-send is safe: the request was rejected, not applied. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/** Placeholder substituted for a value that identifies the probed account. */
const REDACTED = '<redacted>';

/**
 * Profile fields a Spotify user object carries. Blanked rather than dropped so
 * a reader can still see that the field was present, and so the snippet's shape
 * still says which endpoint answered. `type` and `followers` are deliberately
 * absent: neither identifies anybody, and blanking them would cost the snippet
 * the part a reader actually uses to tell a profile from a playlist.
 */
const IDENTITY_KEYS = new Set([
  'id', 'uri', 'display_name', 'email', 'country', 'product', 'username',
  'external_urls', 'images', 'href',
]);

/** Seconds to wait before re-sending, parsed from a `Retry-After` header. */
export function parseRetryAfterSeconds(header, now = Date.now()) {
  const raw = (header ?? '').trim();
  if (raw.length === 0) return RETRY_AFTER_FALLBACK_SEC;
  // delta-seconds, fractional included — a truncating parse would read "0.5"
  // as "retry immediately".
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : RETRY_AFTER_FALLBACK_SEC;
  }
  // The HTTP-date form. `Date.parse` reads a bare signed number as a year, so
  // the branch requires a letter — every legal HTTP-date form has one.
  if (!/[A-Za-z]/.test(raw)) return RETRY_AFTER_FALLBACK_SEC;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return RETRY_AFTER_FALLBACK_SEC;
  return Math.max(0, (at - now) / 1000);
}

/**
 * The account's own id, reduced to a non-reversible digest. A report is meant
 * to be shareable, so it needs to say *which* account ran without saying who
 * that is; a truncated prefix would still narrow a 22-character id a long way.
 * An unreadable `/v1/me` is null, not an empty string — an empty `user` field
 * reads like an id and is not one.
 */
export function redactUser(uid) {
  const raw = (uid ?? '').trim();
  if (raw === '') return null;
  // A short, stable, non-reversible tag. Not a credential, so a plain digest of
  // the id is enough; the salt would be lost the moment the report is copied.
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `acct:${hash.toString(16).padStart(8, '0')}`;
}

/** Substitute the digest for the id wherever it appears in a string. */
function scrubId(text, uid) {
  const raw = (uid ?? '').trim();
  if (raw === '') return text;
  return text.split(raw).join(REDACTED);
}

/** Blank the identity keys of one parsed JSON node, recursing into children. */
function redactNode(node, uid) {
  if (Array.isArray(node)) return node.map((item) => redactNode(item, uid));
  // A leaf keeps its JSON type. Coercing to string would turn a status code
  // into `"429"`, which is a different value in a report whose whole job is
  // recording what the endpoint answered.
  if (node === null || typeof node !== 'object') {
    return typeof node === 'string' ? scrubId(node, uid) : node;
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = IDENTITY_KEYS.has(key) ? REDACTED : redactNode(value, uid);
  }
  return out;
}

/**
 * A response body safe to put in a report: identity keys blanked, the account
 * id gone, whitespace collapsed and truncated.
 *
 * A body that parses as JSON is redacted structurally, so a profile object
 * loses its fields. A body that does not (an HTML error page, a bare
 * `no such user: <id>`) is scrubbed as text, which is why this is not
 * `JSON.parse(body)` on its own.
 */
export function redactSnippet(body, uid) {
  const text = typeof body === 'string' ? body : String(body ?? '');
  let redacted;
  try {
    redacted = JSON.stringify(redactNode(JSON.parse(text), uid));
  } catch {
    redacted = scrubId(text, uid);
  }
  return redacted.replace(/\s+/g, ' ').slice(0, 120);
}

/** Classification label for a probe result, or null for a status we retry. */
export function classify(status) {
  if (status === 404) return 'DEAD';
  if (status === 405) return 'EXISTS(wrong-method)';
  if (status === 401) return 'AUTH-REQUIRED';
  if (status === 403) return 'GATED/REMOVED';
  if (status === 429) return 'QUOTA';
  if (status >= 200 && status < 300) return 'ALIVE';
  if (status === 400) return 'EXISTS(bad-params?)';
  return `HTTP-${status}`;
}

/**
 * Resolve the report path.
 *
 * A caller-supplied path is validated rather than interpolated: it has to be a
 * non-empty, single-line, `.json` name, and it may not be an existing
 * directory. The default is `memory/edge-probe-<timestamp>.json`, where the
 * timestamp is the run's own — the literal date the script used to carry was
 * written when the file was authored, so a later run overwrote a file whose
 * name claimed a day that had nothing to do with it.
 */
export function resolveReportPath(raw, { root, runAt, existsSync, isDirectory, force = false }) {
  if (raw === undefined) {
    const stamp = String(runAt).replace(/\.\d+Z$/, '').replace(/:/g, '-');
    return `${root}/memory/edge-probe-${stamp}.json`;
  }
  if (typeof raw !== 'string' || raw.trim() === '' || raw !== raw.trim()) {
    throw new Error('report path must be a non-empty .json file name');
  }
  // A newline or a tab in a path is either a mistake or an attempt to smuggle a
  // second command past anything that later logs the path.
  if (/[\n\r\t\0]/.test(raw)) {
    throw new Error('report path must be a single-line .json file name');
  }
  if (!/\.json$/.test(raw)) {
    throw new Error(`report path must end in .json, got ${JSON.stringify(raw)}`);
  }
  if (isDirectory(raw)) {
    throw new Error(`report path is an existing directory: ${raw}`);
  }
  if (!force && existsSync(raw)) {
    throw new Error(`report path already exists: ${raw} (pass --force to overwrite)`);
  }
  return raw;
}

/**
 * Fill a probe's `{{placeholder}}` slots for the *request*.
 *
 * `{{uid}}` resolves to the account's real id here, because the two
 * `/v1/users/{id}` probes are asking whether that endpoint is app-gated for
 * this registration, and a request against a redacted id would 404 for a reason
 * that has nothing to do with the question. Redaction belongs to the recorded
 * path — see `redactPath`.
 */
export function fillPath(rawPath, token, uid = '') {
  return rawPath
    .replace('{{uid}}', uid)
    .replace('{{track}}', token.track)
    .replace('{{album}}', token.album)
    .replace('{{show}}', token.show)
    .replace('{{episode}}', token.episode)
    .replace('{{artist}}', token.artist);
}

/**
 * The same path as it will appear in a report: the account id replaced, the
 * public catalogue seed ids left alone. A report is a shareable artifact, and
 * a recorded request URL is as identifying as a recorded user id.
 */
export function redactPath(path, uid) {
  return scrubId(path, uid);
}

/** The `setTimeout` promise the scripts sleep on; injected so tests can record. */
export function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Publish a token store atomically (#1459).
 *
 * A probe refresh is not a side effect of reading — it is the one place a probe
 * script writes to the operator's LIVE credential store, and the value it writes
 * may carry a refresh token Spotify has just rotated. A bare `writeFileSync`
 * straight onto that path can therefore leave a truncated file behind, and a
 * truncated `tokens.json` is an unreadable one: the operator is left needing a
 * full `npm run auth` re-run to recover a credential the old file still held.
 *
 * The shape is the one `src/auth.ts` already uses for this exact file, and the
 * one `src/receipts.ts`, `src/cachepersist.ts`, `src/tools/libraryinsights.ts`,
 * `src/tools/freshness.ts` and `src/tools/statsfm_taste.ts` use for their own
 * stores: write a temp file in the SAME directory, fsync it, then `rename(2)`
 * over the target. The rename is the only mutation of the real path, so a crash
 * before it leaves the previous store intact rather than a half-written one.
 *
 * The temp name carries the pid, so two probes refreshing at once cannot collide
 * on one sidecar, and it is removed in a `finally` so a failed write cannot
 * strand a partial file for the next run to trip over.
 */
export async function writeTokenStore(tokenFile, tokens) {
  const { open, rename, unlink, chmod } = await import('node:fs/promises');
  const { basename, dirname, join } = await import('node:path');
  const directory = dirname(tokenFile);
  const tmpFile = join(
    directory,
    `.${basename(tokenFile, '.json')}.${process.pid}.tmp`,
  );
  let created = false;
  try {
    // 'wx' fails rather than following a pre-existing symlink at the temp path,
    // and 0o600 keeps a rotated refresh token off other accounts on the host.
    const handle = await open(tmpFile, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
      // Durable before the rename can publish it: without the sync, a crash
      // after the rename can leave the new NAME over old bytes.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpFile, tokenFile);
    if (process.platform !== 'win32') await chmod(tokenFile, 0o600);
  } finally {
    if (created) {
      await unlink(tmpFile).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    }
  }
}

/**
 * Run the probe sweep and return the report object. Never throws for an HTTP
 * status — a probe that cannot be sent is recorded, because a sweep that dies
 * halfway leaves a report that lies about how far it got.
 *
 * `fetchImpl`, `sleep`, `now` and `log` are parameters rather than globals so
 * the decisions this makes — the wait, the ladder, the redaction — are
 * observable in a test without a live account and without real time passing.
 */
export async function runProbes({
  probes,
  token,
  fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => Date.now(),
  runAt = () => new Date().toISOString(),
  log = () => {},
  intervalMs = 800,
  attemptTimeoutMs = 15_000,
}) {
  const uid = await readAccountId({ fetchImpl, token, log });
  const bearer = `Bearer ${token.access ?? ''}`;
  const results = [];
  let quotaWall = false;

  for (const [label, method, rawPath] of probes) {
    if (quotaWall) {
      results.push({ label, path: redactPath(fillPath(rawPath, token, uid), uid), status: 0, cls: 'NOT-RUN', ms: 0, snippet: '' });
      continue;
    }

    // Two paths on purpose: the request goes to the real id, the report
    // records the redacted one. Collapsing them either probes a placeholder or
    // writes the account id into a file people paste into issues.
    const path = fillPath(rawPath, token, uid);
    const recordedPath = redactPath(path, uid);
    const started = now();
    let throttled = 0;
    let attempt = 0;
    let out = null;
    // Declared out here so the row built after the retry loop reads the last
    // attempt, whichever way the loop exited.
    let status = 0;
    let body = '';
    let error = null;

    for (;;) {
      const sent = now();
      let response = null;
      body = '';
      error = null;
      try {
        response = await fetchImpl(`https://api.spotify.com${path}`, {
          method,
          headers: { Authorization: bearer },
          signal: AbortSignal.timeout(attemptTimeoutMs),
        });
        body = await response.text();
      } catch (cause) {
        error = cause instanceof Error ? cause.name : 'Error';
      }

      status = response?.status ?? 0;
      if (error === null && status !== 429 && !RETRYABLE_STATUSES.has(status)) break;

      if (attempt >= MAX_ATTEMPTS - 1) {
        // Out of attempts. A probe that never escaped 429 is a quota wall for
        // the whole sweep, not a label on one row: continuing would fire the
        // remaining probes straight into the penalty window.
        if (status === 429) {
          quotaWall = true;
          out = { label, path: recordedPath, status, cls: 'QUOTA', ms: now() - started, snippet: redactSnippet(body, uid) };
          log(`QUOTA WALL at ${label} after ${attempt + 1} attempts — ending the sweep; the rest are recorded NOT-RUN`);
        } else if (error !== null) {
          out = { label, path: recordedPath, status: 0, cls: `ERR:${error}`, ms: now() - started, snippet: '' };
        } else {
          out = { label, path: recordedPath, status, cls: classify(status), ms: now() - started, snippet: redactSnippet(body, uid) };
        }
        break;
      }

      let waitMs;
      if (status === 429) {
        // A repeat inside the same penalty window gets a longer wait: the
        // server's own advice did not clear it last time.
        const advised = Math.min(parseRetryAfterSeconds(response?.headers?.get('retry-after') ?? null, now()), RETRY_SLEEP_CAP_SEC);
        waitMs = Math.min(advised * 1000 * 2 ** throttled, RETRY_SLEEP_CAP_SEC * 1000);
        throttled += 1;
        log(`429 at ${label} — waiting ${Math.round(waitMs / 1000)}s (Retry-After) before retrying`);
      } else {
        waitMs = RETRY_BACKOFF_BASE_MS * 2 ** attempt;
        log(`${error === null ? status : error} at ${label} — backing off ${waitMs}ms`);
      }
      attempt += 1;
      await sleep(waitMs);
      log(`   (${label} resumed ${now() - sent}ms after the failure)`);
    }

    if (out === null) {
      // `let`, not `const`: an ALIVE row whose body is empty is reclassified
      // below. A 200 with a zero-length body is a real answer this sweep has to
      // record, and it arrives after the request was already sent — the
      // expensive place to lose a sweep to a throw.
      let cls = status === 0 ? `ERR:${error}` : classify(status);
      if (cls === 'ALIVE' && String(body).trim().length < 3) cls = 'ALIVE(empty)';
      out = { label, path: recordedPath, status, cls, ms: now() - started, snippet: redactSnippet(body, uid) };
    }
    results.push(out);
    log(`[${out.cls.padEnd(22)}] ${String(out.status).padEnd(3)} ${out.label.padEnd(36)} ${out.ms}ms`);
    if (!quotaWall && intervalMs > 0) await sleep(intervalMs);
  }

  return {
    runAt: runAt(),
    user: redactUser(uid),
    quotaWall,
    total: results.length,
    results,
  };
}

/** The account id, read once from `/v1/me` and never kept past redaction. */
async function readAccountId({ fetchImpl, token, log }) {
  try {
    const res = await fetchImpl('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token.access ?? ''}` },
    });
    const me = await res.json();
    return typeof me?.id === 'string' ? me.id : '';
  } catch (cause) {
    // A failed /v1/me is not fatal: the sweep can still classify every endpoint
    // it probes, it just cannot use a real id in a path. There is no real id to
    // use now anyway — {{uid}} is redacted either way.
    log(`/v1/me unreadable (${cause instanceof Error ? cause.name : 'Error'}) — continuing without it`);
    return '';
  }
}
