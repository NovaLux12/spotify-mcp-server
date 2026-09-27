/**
 * Playlist follow/unfollow (#1005, #1099), split out of playlistmisc.ts.
 *
 * These tools are the only ones in the family that call PUT/DELETE
 * /me/library with a `spotify:playlist:` URI, and that endpoint authorises
 * THREE alternative scopes — `user-library-modify`, `user-follow-modify` or
 * `playlist-modify-public`. Sharing playlistmisc's `playlists` requirement
 * (`playlist-modify-public|private`) advertised a tool the granted scopes
 * could not authorise: a caller holding only the playlist scopes saw the tool
 * in tools/list and got a raw 403 on every call. Giving the pair its own
 * registrar row lets the manifest carry the full either-of list (scopeKey
 * `playlistfollow` in src/scopefilter.ts) instead of a guess.
 *
 * ## Why the names are `follow_playlist` / `unfollow_playlist` (#1099)
 *
 * They used to be `pin_playlist` / `unpin_playlist`, and the names were a lie
 * from the start rather than a Feb 2026 casualty. The endpoint they replaced,
 * PUT/DELETE /playlists/{id}/followers, was a FOLLOW: it added the caller to
 * the playlist's followers. Nothing ever pinned. Feb 2026 removed that endpoint
 * and routed both directions through /me/library, which for a playlist URI is
 * a save — so the code did a follow, the name said pin, and the only place a
 * caller could learn the difference was prose inside the description.
 *
 * The artist trap does NOT apply here, and that is worth stating because it is
 * the reason the sibling family was left alone. GET /me/library/contains
 * accepts `spotify:artist:` URIs while PUT/DELETE /me/library does not, so
 * following an ARTIST is unexpressible as a write and follow_artists is being
 * removed for a real reason. Playlist URIs are accepted by BOTH halves, so the
 * write half migrated cleanly and what remains is purely a naming defect.
 *
 * The old names stay callable for one release as deprecated aliases, per
 * AGENTS.md §5, and each is registered against the SAME handler as its
 * replacement — not a copy — so the alias cannot drift in behaviour, and in
 * particular cannot become a way around the confirmation gate.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import {
  ResponseFormat,
  DryRun,
  describeDryRun,
  NO_INPUT_DEPRECATION,
  resolveDeprecatedToolName,
  withPlaylistInputMetadata,
  withPlaylistInputNote,
} from '../shaping.js';
import type { ResponseFormatValue } from '../shaping.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';

type ToolOut = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/** What a deprecated-name call carries: the resolution, or the canonical one. */
type Deprecation = ReturnType<typeof resolveDeprecatedToolName> | typeof NO_INPUT_DEPRECATION;

function shapeResult(
  rf: ResponseFormatValue,
  prose: string,
  payload: Record<string, unknown>,
  deprecation: Deprecation = NO_INPUT_DEPRECATION,
): ToolOut {
  const text = rf === 'json' ? JSON.stringify(payload, null, 2) : prose;
  return {
    content: [{ type: 'text', text: withPlaylistInputNote(text, deprecation) }],
    structuredContent: withPlaylistInputMetadata(payload, deprecation),
  };
}

/**
 * follow_playlist is opt-OUT of preview (#870), so the default lives here rather
 * than in the shared DryRun default (true): following a playlist is a write to
 * the caller's library, and #870's finding was that this family in particular
 * was committing while callers believed they were previewing.
 *
 * Pass dry_run: false to execute the follow. `true` returns the plan and
 * issues no request.
 */
const FollowDryRun = DryRun.default(true).describe(
  'Preview only (default): pass dry_run: false to execute the follow.',
);

// Feb 2026: Spotify removed the playlist-followers endpoints outright and folded
// playlist following into the unified library endpoints, whose documented URI
// list explicitly includes spotify:playlist:{id}. So a follow is saving the
// playlist URI to the library and an unfollow is removing it. The replacement
// takes no request body, so the old `public` visibility flag has no equivalent:
// `false` is rejected outright, and `true` is accepted for call-site
// compatibility but reaches neither the request nor the confirmation prompt —
// a library save is inherently private, so claiming "public: true" at the
// moment the user authorises the write is a lie, not a default.
function playlistLibraryPath(playlistId: string): string {
  const uris = new URLSearchParams({ uris: `spotify:playlist:${playlistId}` }).toString();
  return `/me/library?${uris}`;
}

/** The `public` flag is a call-site leftover, not a knob: reject it before any I/O. */
function rejectInvisibleFlag(name: string, value: unknown): void {
  if (value === false) {
    throw new Error(
      `${name} cannot honour public=false: the Feb 2026 replacement PUT /me/library has no visibility parameter. Omit \`public\` or pass true.`,
    );
  }
}

const followSchema = {
  playlist_id: z.string().describe('Playlist ID to follow'),
  public: z
    .boolean()
    .optional()
    .describe('Must be true or omitted; the library endpoint has no visibility parameter.'),
  dry_run: FollowDryRun,
  response_format: ResponseFormat,
} as const;

const unfollowSchema = {
  playlist_id: z.string().describe('Playlist ID to unfollow'),
  dry_run: DryRun,
  response_format: ResponseFormat,
} as const;

type FollowArgs = z.infer<z.ZodObject<typeof followSchema>>;
type UnfollowArgs = z.infer<z.ZodObject<typeof unfollowSchema>>;

/**
 * One handler per operation, registered under the canonical name AND the
 * deprecated alias. Sharing the handler is the whole point: an alias that
 * duplicated the body would be free to drift, and the first thing to drift in a
 * copy of a gated write is the gate.
 */
async function followHandler(
  server: McpServer,
  client: SpotifyClient,
  /** The name the caller actually used, for errors and the confirmation prompt. */
  called: string,
  args: FollowArgs,
  deprecation: Deprecation,
): Promise<ToolOut> {
  const rf = args.response_format as ResponseFormatValue;
  rejectInvisibleFlag(called, args.public);
  if (args.dry_run) {
    const payload = { ok: true, dry_run: true, playlist_id: args.playlist_id, would_follow: true };
    return shapeResult(rf, describeDryRun('follow playlist', args.playlist_id, [`Save playlist ${args.playlist_id} to your library`]), payload, deprecation);
  }
  const verdict = await confirmViaElicitation(server, {
    message: describeConfirmation('follow playlist', args.playlist_id, [
      `Save playlist ${args.playlist_id} to your library`,
    ]),
  });
  const refusal = requiredConfirmationRefusal(verdict);
  if (refusal) return shapeResult(rf, refusal.message, refusal.payload, deprecation);
  await client.put(playlistLibraryPath(args.playlist_id));
  const payload = { ok: true, playlist_id: args.playlist_id, followed: true };
  return shapeResult(rf, `Saved playlist ${args.playlist_id} to your library.`, payload, deprecation);
}

async function unfollowHandler(
  server: McpServer,
  client: SpotifyClient,
  called: string,
  args: UnfollowArgs,
  deprecation: Deprecation,
): Promise<ToolOut> {
  const rf = args.response_format as ResponseFormatValue;
  if (args.dry_run) {
    const payload = { ok: true, dry_run: true, playlist_id: args.playlist_id, would_unfollow: true };
    return shapeResult(rf, describeDryRun('unfollow playlist', args.playlist_id, [`Remove playlist ${args.playlist_id} from your library`]), payload, deprecation);
  }
  const verdict = await confirmViaElicitation(server, {
    message: describeConfirmation('unfollow playlist', args.playlist_id, [`Remove playlist ${args.playlist_id} from your library`]),
  });
  // #1100: the shared fail-closed guard, so this half of the pair refuses in the
  // same shape as follow_playlist. The hand-rolled branches this replaced threw
  // on 'error' and on an unpromptable host, so a host that distinguished the
  // two got a machine-readable `reason` from one tool and a bare exception from
  // its own inverse. BEHAVIOUR CHANGE: 'error' now RETURNS a refusal result
  // instead of throwing — a failure to establish confirmation is a refusal, not
  // an exceptional condition. Nothing about the gate is weakened: every verdict
  // other than 'confirmed' still stops the write, and SPOTIFY_MCP_CONFIRM=never
  // remains the only bypass. #1099 re-registers this same handler under the
  // deprecated `unpin_playlist` alias, so the always-ask gate covers both names.
  const refusal = requiredConfirmationRefusal(verdict);
  if (refusal) return shapeResult(rf, refusal.message, refusal.payload, deprecation);
  await client.delete(playlistLibraryPath(args.playlist_id));
  return shapeResult(rf, `Removed playlist ${args.playlist_id} from your library.`, { ok: true, playlist_id: args.playlist_id, followed: false }, deprecation);
}

export function registerPlaylistFollowTools(server: McpServer, client: SpotifyClient): void {
  // Canonical names. No deprecation resolution: a call that used them carries
  // neither `deprecated_inputs` nor `deprecation_note`.
  server.tool(
    'follow_playlist',
    'Follow a playlist — save it to your Spotify library — via PUT /me/library. Spotify removed the playlist-followers endpoints in Feb 2026; this is the only way to follow a playlist. Supports dry_run (default true); writes require confirmation unless SPOTIFY_MCP_CONFIRM=never.',
    followSchema,
    async (args) => followHandler(server, client, 'follow_playlist', args, NO_INPUT_DEPRECATION),
  );

  server.tool(
    'unfollow_playlist',
    'Unfollow a playlist — remove it from your Spotify library — via DELETE /me/library. Always asks before writing unless SPOTIFY_MCP_CONFIRM=never.',
    unfollowSchema,
    async (args) => unfollowHandler(server, client, 'unfollow_playlist', args, NO_INPUT_DEPRECATION),
  );

  // #1099: one-release aliases. Identical schema, identical handler, plus the
  // deprecation resolution so the result tells the caller what to move to.
  server.tool(
    'pin_playlist',
    'DEPRECATED, removed in 2.1 — use follow_playlist. This tool never pinned anything; it has always saved the playlist to your Spotify library via PUT /me/library.',
    followSchema,
    async (args) => followHandler(server, client, 'pin_playlist', args, resolveDeprecatedToolName('pin_playlist', 'follow_playlist')),
  );

  server.tool(
    'unpin_playlist',
    'DEPRECATED, removed in 2.1 — use unfollow_playlist. This tool never unpinned anything; it has always removed the playlist from your Spotify library via DELETE /me/library.',
    unfollowSchema,
    async (args) => unfollowHandler(server, client, 'unpin_playlist', args, resolveDeprecatedToolName('unpin_playlist', 'unfollow_playlist')),
  );
}
