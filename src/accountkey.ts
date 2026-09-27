/**
 * The account key that separates per-account on-disk stores.
 *
 * ## Why the token file and not `account_id`
 *
 * Spotify's `account_id` is the obvious key and is the wrong one here. Reading
 * it costs a live `GET /me` (`resolveActingAccount`, `src/actingaccount.ts`),
 * that module is allowed to return `undefined` when the read is throttled or
 * the token is private, and a store keyed on a value that can be missing is a
 * store that silently merges accounts — the exact failure this key exists to
 * prevent. The token file is available synchronously from `client.tokenFile`,
 * so keying by it costs no round trip and cannot come back unreadable.
 *
 * This mirrors `cacheFileNameFor` in `src/cachepersist.ts`, which already keys
 * the persisted read cache the same way. Sharing one derivation means an
 * operator who sees `cache.work.json` can predict `receipts.work.jsonl`, and
 * there is one place to change if the profile naming ever moves.
 *
 * ## The default account keeps the un-keyed name
 *
 * `tokens.json` — the path with no `--profile` and no `SPOTIFY_MCP_PROFILE` —
 * maps to the EMPTY key, so its stores keep their pre-#1364 filenames. An
 * operator with one account and no profile has an existing `mutations.jsonl`
 * and `receipts.jsonl` on disk, and those remain the files that account reads
 * and writes. That is what makes this change shippable with no migration: see
 * the backward-compatibility section of `tests/account-keyed-stores.test.ts`.
 *
 * ## Collision safety
 *
 * `SPOTIFY_MCP_TOKEN_FILE` is operator-supplied and this value goes into a
 * FILENAME, so the key is sanitized rather than trusted. A token file whose
 * name sanitizes away to nothing would otherwise produce the default account's
 * filename and quietly merge into the one store that must never be shared, so
 * that case falls back to a hash of the path.
 *
 * ## Known boundary
 *
 * Two token files in DIFFERENT directories that share a basename resolve to
 * the same key. That is the same boundary the read cache already has, and it
 * is not reachable in practice: `getTokenFile` derives every profile's
 * directory from the one config root the operator selected, so profiles that
 * can be used at once always share a directory and the basenames differ.
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const UNSAFE_RUN = /[^A-Za-z0-9._-]+/g;
const EDGE_PUNCTUATION = /^[-.]+|[-.]+$/g;

/**
 * The per-account filename segment for `tokenFile`.
 *
 * Returns `''` for the default account (whose stores stay un-keyed) and the
 * profile name for a named one, e.g. `'work'`. The value is a bare filename
 * segment: no separator, no traversal, never empty for a non-default account.
 */
export function accountStoreKey(tokenFile: string): string {
  if (!tokenFile) return '';
  const base = basename(tokenFile);
  if (base === '' || base === 'tokens.json') return '';

  const profile =
    base.startsWith('tokens.') && base.endsWith('.json')
      ? base.slice('tokens.'.length, -'.json'.length)
      : base.replace(/\.json$/, '');

  const safe = profile.replace(UNSAFE_RUN, '-').replace(EDGE_PUNCTUATION, '');
  // An empty key here would collide with the DEFAULT account and merge two
  // accounts into one store, so an unusable name gets a path-derived key
  // instead — distinct per file, which is the property that matters.
  return safe === '' ? `x${shortHash(tokenFile)}` : safe;
}

/** A short, stable, filesystem-safe digest used only when a name is unusable. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * The per-account filename for a store: `receipts.jsonl` stays
 * `receipts.jsonl` for the default account and becomes `receipts.work.jsonl`
 * for the `work` profile. The key is spliced in before the extension rather
 * than appended, so a directory listing still groups one store's files by its
 * leading stem.
 */
export function accountFileName(fileName: string, tokenFile: string): string {
  const key = accountStoreKey(tokenFile);
  if (key === '') return fileName;
  const dot = fileName.lastIndexOf('.');
  return dot <= 0
    ? `${fileName}.${key}`
    : `${fileName.slice(0, dot)}.${key}${fileName.slice(dot)}`;
}

/**
 * Every account's filename for one store, derived from the token files present
 * in `tokenDir`. Always includes the default account's un-keyed name, so a
 * caller that erases a store erases all of it rather than the active profile's
 * share.
 *
 * `SPOTIFY_MCP_TOKEN_FILE` is not consulted: a store file left behind by a
 * token file that no longer exists is an orphan no derivation can reach. This
 * mirrors `cachePersistPaths`, which makes the same trade — the caller is told
 * which paths it was handed rather than being promised a sweep.
 */
export function accountFileNames(tokenDir: string, fileName: string): string[] {
  const names = new Set<string>([accountFileName(fileName, join(tokenDir, 'tokens.json'))]);
  let entries: string[];
  try {
    entries = readdirSync(tokenDir);
  } catch {
    // An unreadable or absent token directory costs the other profiles, not
    // the default one, which is already named.
    return [...names];
  }
  for (const entry of entries) {
    if (entry === 'tokens.json' || (entry.startsWith('tokens.') && entry.endsWith('.json'))) {
      names.add(accountFileName(fileName, join(tokenDir, entry)));
    }
  }
  return [...names];
}
