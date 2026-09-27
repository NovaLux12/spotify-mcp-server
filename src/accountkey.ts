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
 * ## An EMPTY token file is refused, not treated as the default account
 *
 * The default account reaches the empty key by a real PATH ending in
 * `tokens.json`. It never reaches it by being handed `''`: `client.tokenFile`
 * is `opts.tokenFile ?? getTokenFilePath()` (`src/client.ts`), so it is always
 * a path, and every profile's path is derived by `getTokenFile` from the one
 * config root. An empty `tokenFile` therefore carries no information at all —
 * it can only mean the caller never said which account it is acting as.
 *
 * Returning `''` for it was fail-open (#1385): the empty key is the DEFAULT
 * account's key, so an unwired caller silently read and wrote the one store
 * that must never be shared, and re-merged the accounts #1364 separated — with
 * no error, because a receipt minted under one account still verified under
 * the other. This throws instead. A missing account becomes a loud failure at
 * the point of construction rather than a silent data-integrity bug, and the
 * companion change makes `tokenFile` REQUIRED on the stores and registrars
 * that key by account, so the common case is a compile error rather than a
 * throw.
 *
 * The two are not the same input and must not be conflated again: the default
 * account is `~/.spotify-mcp/tokens.json` → `''`, and no real caller
 * produces the `''` that is refused here.
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
 *
 * Throws when `tokenFile` is empty or not a string. The empty KEY is reserved
 * for the default account and is reached only by naming that account's actual
 * token file, so an empty argument is not "the default account" — it is a
 * caller that never identified itself, and answering it with the default
 * account's key is the cross-account merge this whole module exists to
 * prevent (#1385). See the module header for the full argument.
 */
export function accountStoreKey(tokenFile: string): string {
  if (typeof tokenFile !== 'string' || tokenFile.trim() === '') {
    throw new Error(
      'Refusing to derive an account store key from an empty token file. ' +
        'Pass the acting account\'s token file (`client.tokenFile`), which is always a path. ' +
        'The default account is identified by its own `tokens.json` path, not by an empty string — ' +
        'answering an unidentified caller with the default account\'s store silently merges accounts (#1385).',
    );
  }
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
