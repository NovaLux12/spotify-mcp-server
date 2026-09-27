# Taste showcase — from stats to playlist

An anonymized end-to-end run of the [flagship recipe](cookbook.md#1-taste-profile--playlist-flagship): stats.fm evidence in, Spotify playlist out. Every name below is fictional — "Listener A" stands in for any account with a completed history import.

## Tool naming

The eight taste-intelligence tools live under the `taste` toolset. The `statsfm_*` names are the only ones registered:

| Tool | Retired alias (removed in v3.0) |
|---|---|
| `statsfm_taste_profile` | `taste_profile` |
| `statsfm_artist_affinity` | `artist_affinity` |
| `statsfm_exposure_check` | `exposure_check` |
| `statsfm_listening_eras` | `listening_eras` |
| `statsfm_listening_sessions` | `listening_sessions` |
| `statsfm_forgotten_favorites` | `forgotten_favorites` |
| `statsfm_taste_recommendations` | `taste_recommendations` |
| `statsfm_record_feedback` | `record_feedback` |

The right-hand column is a migration table, not a menu: those names were each a duplicate registration of the tool to their left and are no longer advertised (#908). `SPOTIFY_MCP_LEGACY_ALIASES=1` still dispatches them for a release.

Network-backed taste tools take the identity as `statsfm_user` (`user_id` is a deprecated alias until v2.2). The local-only `statsfm_record_feedback` is the identity-free exception: it never contacts stats.fm, and it persists each verdict to a local sidecar at `~/.spotify-mcp/taste-feedback.json` rather than keeping it in memory. Where `range` is accepted, taste tools use the same three values as the endpoint tools — `weeks`, `months`, and `lifetime` — because they send the same stats.fm query parameter. User-scoped endpoint tools take the same `statsfm_user` argument; see the [stats.fm tool reference](statsfm.md#ranges).

`statsfm_taste_profile` with `response_format: "json"` returns raw stats.fm payloads under exactly these top-level keys: `topArtists`, `topGenres`, `topTracks`, and `recentStreams`. The server does not translate that JSON mode into the summary fields used by its concise and detailed modes.

> **Live-shape handling:** stats.fm's live top-list payloads are wrapped — `entry.artist`, `entry.track`, `entry.album`, and `entry.genre.tag`. Concise and detailed profile modes resolve those nested names. Older flat shapes (`{ name }`, a bare genre string) come from fixtures rather than the live API, but the normalizer still tolerates them. JSON mode remains raw as described above.

## The starting point

Listener A has streamed for about three years and imported that history into stats.fm. `statsfm_streams_stats` summarizes the imported history, while `statsfm_recaps` provides calendar-year views. The question: *what does A actually sound like, and can that become a playlist worth keeping?*

## Step 1 — inspect aggregate history

```json
{ "tool": "statsfm_streams_stats", "statsfm_user": "<your-statsfm-user-id>", "response_format": "json" }
```

The result contains aggregate stream totals, listening duration, and catalog cardinality; optionally bound it with Unix-millisecond `after` and `before` values. It does not report import coverage, stream gaps, or the newest stream. Use `statsfm_recaps` when you need a calendar-year view.

## Step 2 — pull the taste profile

```json
{ "tool": "statsfm_taste_profile", "statsfm_user": "<your-statsfm-user-id>", "range": "lifetime", "response_format": "json" }
```

With `response_format: "json"`, the raw payloads appear under `topArtists`, `topGenres`, `topTracks`, and `recentStreams`. With the default concise format, the text and structured summary derive core artists, genres, loyalty versus novelty, and UTC day-parting from those upstream lists. The profile clock is UTC, so use it as a listening-shape signal rather than claiming the listener's local time zone.

## Step 3 — find the momentum

```json
{ "tool": "statsfm_top_genres", "statsfm_user": "<your-statsfm-user-id>", "range": "months" }
```

This month: alt-r&b climbing past indie folk, dream pop fading. Identity is indie folk; momentum is alt-r&b. The playlist should honor both — familiar core, current edge.

## Step 4 — create the playlist (dry run, then real)

```json
{ "tool": "create_playlist", "name": "Taste Profile — September", "public": false, "dry_run": true }
```

Preview looks right — re-run with `dry_run: false`.

## Step 5 — pick tracks: anchors + discovery

For each of the top 3 genres (indie folk, ambient, alt-r&b), one anchor and one discovery pick:

| Genre | Anchor (from profile) | Discovery (new artist, same orbit) |
|---|---|---|
| indie folk | Anchor One — best-known track via `search_tracks` | a lesser-known folk opener from a `search_tracks "indie folk"` walk with `offset` past the best-known results |
| ambient | Anchor Two — longest saved track | an ambient deep cut surfaced by `search_deep` |
| alt-r&b | Anchor Three — this month's most-streamed | a cross-genre alt-r&b pick outside the top artists |

Discovery candidates get cross-checked against lifetime tops — anything already overplayed is demoted (recipe step from [discovery injection](cookbook.md#7-discovery-injection-no-recommendations-endpoint)).

## Step 6 — add, verify, narrate

```json
{ "tool": "add_to_playlist", "playlist_id": "PLAYLIST_ID", "uris": ["spotify:track:..."], "dry_run": true }
```

`add_to_playlist` takes `uris` (1–100 Spotify track or episode URIs). Commit for real, then call `verify_receipt` with the receipt id. Final reply to the human:

> 6 tracks, 3 genres: indie folk roots, ambient middle, alt-r&b edge. Anchors keep it yours; discoveries keep it alive. Late-night order — it follows the UTC clock signal from your profile.

## What this proves

- stats.fm supplies the **evidence** (genres, anchors, UTC listening shape) that this flow uses.
- Spotify supplies the **action** (search, create, add, receipt).
- The examples contain placeholders and fictional names rather than real IDs, but network-backed calls necessarily send the supplied stats.fm identifier to stats.fm.

## See also

- [Cookbook flagship recipe](cookbook.md#1-taste-profile--playlist-flagship) — the paste-ready version
- [stats.fm second source](statsfm.md) — ranges, limits, privacy
- [Wave-2 composites](wave2-composites.md) — taste-driven playlist specs and reports
- [FAQ](faq.md) — when a step errors
