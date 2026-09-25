# Taste showcase — from stats to playlist

An anonymized end-to-end run of the [flagship recipe](cookbook.md#1-taste-profile--playlist-flagship): stats.fm evidence in, Spotify playlist out. Every name below is fictional — "Listener A" stands in for any account with a completed history import.

## Tool naming

The eight taste-intelligence tools live under the `taste` toolset with canonical **`statsfm_*`** names. Each has a registered legacy alias pointing to the same handler, so either name in a pair below works.

| Canonical (preferred) | Legacy alias |
|---|---|
| `statsfm_taste_profile` | `taste_profile` |
| `statsfm_artist_affinity` | `artist_affinity` |
| `statsfm_exposure_check` | `exposure_check` |
| `statsfm_listening_eras` | `listening_eras` |
| `statsfm_listening_sessions` | `listening_sessions` |
| `statsfm_forgotten_favorites` | `forgotten_favorites` |
| `statsfm_taste_recommendations` | `taste_recommendations` |
| `statsfm_record_feedback` | `record_feedback` |

Network-backed taste tools require an explicit `statsfm_user` string. The local-only `statsfm_record_feedback` / `record_feedback` pair is the identity-free exception: it stores entries in process memory and never contacts stats.fm. Taste schemas use the singular range values `week`, `month`, and `lifetime` where `range` is accepted. User-scoped endpoint tools use plural `weeks` and `months` and require `user_id`; see the [stats.fm tool reference](statsfm.md#ranges).

`statsfm_taste_profile` with `response_format: "json"` returns raw stats.fm payloads under exactly these top-level keys: `topArtists`, `topGenres`, `topTracks`, and `recentStreams`. The server does not translate that JSON mode into the summary fields used by its concise and detailed modes.

> **Live-shape handling:** concise and detailed profile modes resolve nested stats.fm entity names such as `entry.artist`, `entry.track`, and `entry.album`, while genres may be bare strings. JSON mode remains raw as described above.

## The starting point

Listener A has streamed for about three years and imported that history into stats.fm. `statsfm_streams_stats` summarizes the imported history, while `statsfm_recaps` provides calendar-year views. The question: *what does A actually sound like, and can that become a playlist worth keeping?*

## Step 1 — inspect aggregate history

```json
{ "tool": "statsfm_streams_stats", "user_id": "<your-statsfm-user-id>", "response_format": "json" }
```

The result contains aggregate stream totals, listening duration, and catalog cardinality; optionally bound it with Unix-millisecond `after` and `before` values. It does not report import coverage, stream gaps, or the newest stream. Use `statsfm_recaps` when you need a calendar-year view.

## Step 2 — pull the taste profile

```json
{ "tool": "statsfm_taste_profile", "statsfm_user": "<your-statsfm-user-id>", "range": "lifetime", "response_format": "json" }
```

With `response_format: "json"`, the raw payloads appear under `topArtists`, `topGenres`, `topTracks`, and `recentStreams`. With the default concise format, the text and structured summary derive core artists, genres, loyalty versus novelty, and UTC day-parting from those upstream lists. The profile clock is UTC, so use it as a listening-shape signal rather than claiming the listener's local time zone.

## Step 3 — find the momentum

```json
{ "tool": "statsfm_top_genres", "user_id": "<your-statsfm-user-id>", "range": "months" }
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
| indie folk | Anchor One — best-known track via `search_tracks` | a lesser-known folk opener from `grow_playlist` candidates |
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
