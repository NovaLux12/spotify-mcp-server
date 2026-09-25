# Cookbook — copy-paste agent recipes

Ten recipes you can paste to an agent (or run turn by turn) against SpotifyMCP. Each states the tools it uses and what you get. Recipe 1 is the flagship: stats.fm taste in, Spotify playlist out.

Conventions: JSON tool args are shown inline; replace `PLAYLIST_ID` and IDs with yours. User-scoped stats.fm endpoint tools require an explicit `user_id`; network-backed taste tools require an explicit `statsfm_user`; catalog/search tools and local `statsfm_record_feedback`/`record_feedback` are identity-free. Identity is per call—never infer it from the Spotify account. Preview Spotify writes with `dry_run: true` when the tool supports it, show the human what will change, and get explicit confirmation immediately before every write or destructive action. There is no `STATSFM_USER_ID` setting.

## 1. Taste profile → playlist (flagship)

Build a playlist that sounds like you, from stats.fm evidence instead of vibes.

```text
1. Call statsfm_streams_stats with `user_id: "<your-statsfm-user-id>"`; if the imported history is thin, say so and stop.
2. Call statsfm_taste_profile with `statsfm_user: "<your-statsfm-user-id>"`, `range: "lifetime"`, and `response_format: "json"`.
3. Call statsfm_top_genres with `user_id: "<your-statsfm-user-id>"` and `range: "months"`; note which genres are surging versus the lifetime baseline.
4. Ask the human to approve the playlist name, then preview `create_playlist` with `name: "Taste Profile — YYYY-MM"`, `public: false`, and `dry_run: true`; commit the same arguments without `dry_run` only after confirmation.
5. For each of the top 3 genres, call `search_tracks` with a genre- or artist-based `query` and `limit: 2`: request one anchor (an artist from the taste profile) and one discovery (an artist not in the top artists).
6. Preview add_to_playlist with the created `playlist_id`, the selected track `uris` array, and `dry_run: true`; commit the same arguments without `dry_run` only after the human confirms.
7. Reply with the playlist link, the genre split, and which picks were discovery versus anchor.
```

Why it works: lifetime gives identity, the current month gives momentum, and the anchor/discovery split keeps the list familiar but not stale. Full walkthrough with a worked example: [taste showcase](taste.md).

## 2. Morning briefing

```text
1. Call whats_new with `since: "last-check"` and `dry_run: true` to preview the lookup budget.
2. Call statsfm_recent_streams with `user_id: "<your-statsfm-user-id>"` and `limit: 10` for overnight context.
3. Summarize new releases from followed artists and what actually got played overnight.
4. If asked to queue a result, first preview add_to_queue with the selected track or episode `uri`, the confirmed active `device_id`, and `dry_run: true`; commit the same arguments without `dry_run` only after explicit confirmation.
```

## 3. Duplicate cleanup sweep

```text
1. Call find_duplicates_in_playlist with `playlist_id` set to `PLAYLIST_ID` and report the groups; this finder is read-only and does not accept `dry_run`.
2. Ask the human which occurrences to remove—never bulk-delete unasked.
3. On confirmation, preview remove_from_playlist with `playlist_id: "PLAYLIST_ID"`, a `uris` array of `{ "uri": "...", "positions": [2, 5] }` entries from the confirmed groups, and `dry_run: true`; commit the same arguments without `dry_run` only after the human confirms the preview.
4. Call verify_receipt with the returned `receipt_id` and report what landed.
```

## 4. Library hygiene pass

```text
1. Call library_hygiene and library_genre_report. When a specific saved genre tag needs checking, call filter_by_genre with a `genre` string and `kind: "tracks"` or `kind: "albums"`.
2. Report orphaned singles (tracks whose album isn't saved) and near-complete albums.
3. For each near-complete album, ask whether to save the full album. On yes, preview save_items with the missing track `uris` array and `dry_run: true`, then commit the same arguments without `dry_run` only after confirmation.
4. To tag an outlier, preview tag_management with `action: "add"`, the exact library `artist` name, a non-empty `tags` array, and `dry_run: true`; commit the same arguments without `dry_run` only after confirmation. filter_by_genre can find those tags next time.
```

## 5. Podcast catch-up session

```text
1. Call whats_new with `kinds: ["podcasts"]`, `since: "last-check"`, and `dry_run: true`, or use the registered podcast_catchup prompt with its required `since: "YYYY-MM-DD"`.
2. Call plan_podcast_session with `minutes: 45`.
3. Present the plan; on approval, preview start_podcast_session with `minutes: 45`, the chosen `device_id`, and `dry_run: true`, then commit the same arguments without `dry_run` only after confirmation.
4. If no device is active, call get_devices and ask the user to open Spotify first.
```

## 6. Playlist merge without tears

```text
1. Call diff_playlists with `playlist_a` set to `SOURCE_A`, `playlist_b` set to `SOURCE_B`, and `response_format: "json"`.
2. Show the common, only-in-A, and only-in-B counts and whether their shared tracks have the same relative order.
3. Choose a destination and get explicit human approval. Call merge_playlists with `playlists: ["SOURCE_A", "SOURCE_B"]`, exactly one valid destination—`new_name: "Merged Playlist"` for a new playlist or `target_playlist_id: "DESTINATION_ID"` for an existing playlist—and `dry_run: true`; show the preview and get confirmation again before committing without `dry_run`.
4. Call overlap_playlists with `playlists: ["SOURCE_A", "SOURCE_B", "DESTINATION_ID"]` to inspect convergence.
```

`whats_new` accepts `since` only as `YYYY-MM-DD` or the literal `last-check`; relative phrases are invalid.

## 7. Discovery injection (no recommendations endpoint)

Spotify retired recommendations; this is the honest replacement.

```text
1. Call grow_playlist with `playlist_id: "PLAYLIST_ID"`; it finds tracks co-occurring in your OTHER playlists.
2. Cross-check each candidate with statsfm_top_tracks using `user_id: "<your-statsfm-user-id>"` and `range: "lifetime"`; demote anything already overplayed.
3. Preview add_to_playlist with `playlist_id: "PLAYLIST_ID"`, the top 5 surviving track `uris` array, and `dry_run: true`, then commit the same arguments without `dry_run` only after confirmation.
4. Report the evidence chain per track: which playlists it co-occurred in.
```

## 8. Taste compatibility check

There is no cross-user taste-comparison tool. Use the registered social and per-user tools to compare public profiles without inventing a compatibility score.

```text
1. Call statsfm_friends for each explicit public `user_id`, then call statsfm_top_artists with `user_id` set to each of the two public stats.fm IDs.
2. Call statsfm_top_genres with each of those two explicit `user_id` values if the overlap needs explaining.
3. Report shared artists and genre overlap, clearly separating observed overlap from your interpretation.
4. If asked, build a playlist from your own profile with recipe 1 and share it.
```

## 9. When-listening audit

```text
1. Call taste_listening_clock with `statsfm_user: "<your-statsfm-user-id>"` and `response_format: "json"`.
2. Call listening_report with `time_range: "long_term"` for the Spotify-side totals.
3. Compare: note where the two counters agree and where they diverge (different windows — say so).
4. If the clock shows heavy 23:00–01:00 listening, suggest that scene to the human. Only after they approve the local sidecar write, call save_scene with `name: "late-night-low"`, `volume: 40`, `shuffle: false`, and `repeat: "off"`.
```

## 10. Read-only demo for a guest

Safe to run on someone else's account or a shared screen — zero writes.

```text
1. Set SPOTIFY_MCP_READONLY=1 (or use a host config with it set) before starting.
2. Call get_me; resolve the guest's explicit public stats.fm identity with statsfm_resolve_user and `user_id: "<guest-statsfm-user-id>"`; then call statsfm_taste_profile with `statsfm_user: "<guest-statsfm-user-id>"`.
3. Call listening_report and preview whats_new with `dry_run: true` for live color; neither step writes.
4. Narrate the taste: genres, anchors, and clock. Offer recipe 1 as the follow-up — on their own account.
```

## See also

- [stats.fm second source](statsfm.md) — setup, cheat sheet, gotchas
- [Taste showcase](taste.md) — recipe 1 worked end to end
- [FAQ](faq.md) — when a recipe step errors
