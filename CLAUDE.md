# SpotifyMCP — Claude Code Rules

You are helping build an MCP server that wraps the Spotify Web API. Follow these rules at all times.

## Spotify API Reference

Always refer to the official Spotify OpenAPI specification for endpoint paths, parameters, and response schemas:

- **OpenAPI schema**: https://developer.spotify.com/reference/web-api/open-api-schema.yaml
- **API reference**: https://developer.spotify.com/documentation/web-api/reference

Do not guess endpoint paths, query parameter names, or response field names. Look them up.

## Authorization

- Use **Authorization Code with PKCE** for all user-specific data (the standard flow for this MCP server).
  - Reference: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- The **Authorization Code flow** (with client secret on a secure backend) is also acceptable if a backend component is added.
  - Reference: https://developer.spotify.com/documentation/web-api/tutorials/code-flow
- Use **Client Credentials** only for non-user, public catalog data (no user context).
- **Never use the Implicit Grant flow** — it is deprecated by Spotify.

## Redirect URIs

- Always use `https://` redirect URIs in production.
- For local development, use `http://127.0.0.1` (not `http://localhost`).
- Never use wildcard URIs.
- Reference: https://developer.spotify.com/documentation/web-api/concepts/redirect_uri

## OAuth Scopes

- Request only the **minimum scopes** required for the feature being built.
- Do not request broad scopes preemptively "just in case."
- Reference: https://developer.spotify.com/documentation/web-api/concepts/scopes

## Token Management

- Store tokens securely (local file with restricted permissions, never in source control).
- **Never expose the Client Secret in client-side or committed code.**
- Always implement token refresh so the app does not break when access tokens expire (they expire after 1 hour).
- Reference: https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens

## Rate Limiting

- On HTTP **429 Too Many Requests**: read the `Retry-After` header and wait that many seconds before retrying.
- Use **exponential backoff** for repeated failures.
- Never retry immediately in a tight loop.

## Spotify API Deprecations

The OpenAPI schema flags several endpoint families as deprecated. For this project they fall into two buckets — check here before wrapping anything:

Playlist item management targets `/playlists/{id}/items` (the `/tracks` variants are the legacy path); every playlist tool in this server already uses `/items`.

### Blocked for post-Nov-2024 apps — not used here

These fail at runtime on app registrations created after November 2024. Never wrap them; this server deliberately ships no tools for them:

| Endpoint | Status |
|---|---|
| `GET /recommendations`, `GET /recommendations/available-genre-seeds` | Blocked for post-Nov-2024 apps |
| `GET /artists/{id}/related-artists` | Blocked for post-Nov-2024 apps |
| `GET /audio-features/{id}`, `GET /audio-analysis/{id}` | Blocked for post-Nov-2024 apps |
| `GET /browse/categories` | Live — wrapped by get_categories / get_category_playlists |
| `GET /browse/new-releases`, `GET /browse/featured-playlists` | Blocked/removed — do not use |
| Lyrics endpoints | Not available via the Web API — do not use |

### Schema-flagged deprecated but verified operational — wrapped with graceful 403 handling

Verified live against the 2026 schema for this project's app registration. Kept during transition; each wrapper catches Spotify's 403 and degrades gracefully rather than surfacing a raw failure:

| Endpoint | Wrapped by |
|---|---|
| `GET /artists/{id}/top-tracks` | `get_artist_top_tracks` (#38) |
| Batch `GET /albums?ids=` / `/artists?ids=` / `/episodes?ids=` / `/shows?ids=` / `/audiobooks?ids=` / `/chapters?ids=` | `get_several_*` tools (#43) |
| Per-type library writes `PUT/DELETE /me/tracks|albums|shows|episodes` and `GET /me/{type}s/contains` | `save_items` / `remove_saved_items` / `check_saved_items`; prefer the unified `/me/library` tools (`save_to_library` / `remove_from_library` / `check_in_library`, #37) for new work |
| `PUT/DELETE /me/following?type=artist`, `GET /me/following/contains` | `follow_artists` / `unfollow_artists` / `check_following_artists` |

## Error Handling

- Handle all HTTP error codes documented in the OpenAPI schema.
- Read the `error.message` field from Spotify error responses and surface it meaningfully.
- Key codes to handle explicitly:
  - `401` — token expired, attempt refresh and retry once
  - `403` — forbidden (commonly: Premium required) — tell the user clearly
  - `404` — entity not found
  - `429` — rate limited — see rate limiting rules above
  - `503` — Spotify service unavailable — retry with backoff

## Developer Terms of Service

- Do not cache Spotify content beyond what is needed for immediate use.
- Always attribute content to Spotify where displayed.
- Do not use the API to train machine learning models on Spotify data.
- Reference: https://developer.spotify.com/terms
