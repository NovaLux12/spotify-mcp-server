/**
 * Scope-aware module gating (#111 item 6).
 *
 * At auth time the granted scopes are persisted on tokens.json (`scope`,
 * see exchangeCodeForTokens in auth.ts). This module maps registration keys
 * to the write scopes each write-capable module needs, so the orchestrator
 * can hide modules whose mutations would only fail at the API with 403.
 *
 * Read-only modules have no entry here and are never blocked.
 */

/**
 * Registration key → required write scopes. A requirement list is
 * "either-of": the module is available when AT LEAST ONE listed scope was
 * granted (e.g. playlists works with playlist-modify-public OR
 * playlist-modify-private; it only hides when neither was granted).
 */
export const WRITE_SCOPE_REQUIREMENTS: Record<string, string[]> = {
  playback: ['user-modify-playback-state'],
  playlists: ['playlist-modify-public', 'playlist-modify-private'],
  library: ['user-library-modify'],
  following: ['user-follow-modify'],
};

/**
 * Parse a space-separated scope string (as persisted on TokenData.scope or
 * returned by the Spotify token endpoint) into a Set. Undefined/empty input
 * yields an empty set — matching the pre-gating behaviour where every
 * registered module stays visible.
 */
export function scopesFor(granted: string | undefined): Set<string> {
  return new Set(
    (granted ?? '')
      .split(' ')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Whether the write-capable module `key` must be hidden: true only when the
 * module HAS scope requirements and NONE of them are satisfied by `granted`.
 * Unknown/read-only keys and an empty granted set without requirements are
 * never blocked.
 */
export function moduleBlockedByScopes(key: string, granted: Set<string>): boolean {
  // Fail-open: no persisted scope info (pre-#111 token files, or tokens.json
  // hand-edited without the field) means we cannot prove a module would fail,
  // so keep today's behaviour of registering everything.
  if (granted.size === 0) return false;
  const required = WRITE_SCOPE_REQUIREMENTS[key];
  if (!required || required.length === 0) return false;
  return !required.some((scope) => granted.has(scope));
}
