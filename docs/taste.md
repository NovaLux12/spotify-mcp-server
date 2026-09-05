# Taste showcase — from stats to playlist

An anonymized end-to-end run of the [flagship recipe](cookbook.md#1-taste-profile--playlist-flagship): stats.fm evidence in, Spotify playlist out. Every name below is fictional — "Listener A" stands in for any account with a completed history import.

## The starting point

Listener A has streamed for about three years, imported fully into stats.fm (`statsfm_history_status` reports continuous coverage, oldest stream 2023). The question: *what does A actually sound like, and can that become a playlist worth keeping?*

## Step 1 — check coverage

```json
{ "tool": "statsfm_history_status" }
```

Result (abridged): coverage continuous, no gaps longer than a week, newest stream yesterday. Lifetime ranges are trustworthy — proceed.

## Step 2 — pull the taste profile

```json
{ "tool": "statsfm_taste_profile", "range": "lifetime", "response_format": "json" }
```

Result (abridged, anonymized):

```json
{
  "top_genres": ["indie folk", "ambient", "alt-r&b", "jazz rap", "dream pop"],
  "anchor_artists": ["Anchor One", "Anchor Two", "Anchor Three"],
  "listening_clock_note": "heavy 22:00-01:00, steady weekday afternoons",
  "diversity_note": "narrow core (5 genres > 70% of streams), long tail of electronic one-offs"
}
```

## Step 3 — find the momentum

```json
{ "tool": "statsfm_top_genres", "range": "month" }
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
{ "tool": "add_to_playlist", "playlist_id": "PLAYLIST_ID", "track_uris": ["..."], "dry_run": true }
```

Commit for real, then `verify_receipt` on the receipt id. Final reply to the human:

> 6 tracks, 3 genres: indie folk roots, ambient middle, alt-r&b edge. Anchors keep it yours; discoveries keep it alive. Late-night order — it plays 22:00 → 01:00 like your clock.

## What this proves

- stats.fm supplies the **evidence** (genres, anchors, clock) Spotify's bounded top-item ranges can't.
- Spotify supplies the **action** (search, create, add, receipt).
- Neither side leaks identity: no real artist, track, or user ID appears anywhere above — the same flow works on any account.

## See also

- [Cookbook flagship recipe](cookbook.md#1-taste-profile--playlist-flagship) — the paste-ready version
- [stats.fm second source](statsfm.md) — ranges, limits, privacy
- [FAQ](faq.md) — when a step errors
