# Cookbook — copy-paste agent recipes

Ten recipes you can paste to an agent (or run turn by turn) against SpotifyMCP. Each states the tools it uses and what you get. Recipe 1 is the flagship: stats.fm taste in, Spotify playlist out.

Conventions: preview every write with `dry_run: true`; JSON tool args shown inline; replace `PLAYLIST_ID` and user IDs with yours. stats.fm endpoint tools require `user_id`; taste tools require `statsfm_user`. There is no `STATSFM_USER_ID` setting.

## 1. Taste profile → playlist (flagship)

Build a playlist that sounds like you, from stats.fm evidence instead of vibes.

```text
1. Call statsfm_streams_stats with user_id "<your-statsfm-user-id>"; if the imported history is thin, say so and stop.
2. Call statsfm_taste_profile with statsfm_user "<your-statsfm-user-id>", range "lifetime", response_format "json".
3. Call statsfm_top_genres with user_id "<your-statsfm-user-id>", range "months" — note which genres are surging versus the lifetime baseline.
4. Create a private playlist named "Taste Profile — <Month Year>" with create_playlist, dry_run first, then for real.
5. For each of the top 3 genres, call search_tracks for 2 representative tracks:
   one anchor (an artist from the taste profile) and one discovery (an artist not in the top artists).
6. Add the picks with add_to_playlist, using its `uris` array, and preview before committing.
7. Reply with the playlist link, the genre split, and which picks were discovery versus anchor.
```

Why it works: lifetime gives identity, the current month gives momentum, and the anchor/discovery split keeps the list familiar but not stale. Full walkthrough with a worked example: [taste showcase](taste.md).

## 2. Morning briefing

```text
1. Call whats_new with since "last-check" and dry_run true to preview the lookup budget.
2. Call statsfm_recent_streams with user_id "<your-statsfm-user-id>" and limit 10 for overnight context.
3. Summarize new releases from followed artists and what actually got played overnight.
4. If asked, queue one new release on the active device after confirming the device first.
```

## 3. Duplicate cleanup sweep

```text
1. Call find_duplicates_in_playlist on PLAYLIST_ID with dry_run true and report the groups.
2. Ask the human which groups to dedupe — never bulk-delete unasked.
3. Call remove_from_playlist with playlist_id and the confirmed `uris` array (elicitation will confirm at 10+).
4. Call verify_receipt on the returned receipt id and report what landed.
```

## 4. Library hygiene pass

```text
1. Call library_hygiene and library_genre_report.
2. Report orphaned singles (tracks whose album isn't saved) and near-complete albums.
3. For each near-complete album, ask whether to save the full album. On yes, call save_items for the missing track URIs.
4. Tag remaining outliers with tag_management so filter_by_genre can find them next time.
```

## 5. Podcast catch-up session

```text
1. Call whats_new with kinds ["podcasts"], since "last-check", and dry_run true (or use the podcast_catchup prompt).
2. Call plan_podcast_session with a 45-minute time box.
3. Present the plan; on approval, call start_podcast_session on the chosen device.
4. If no device is active, list devices and ask the user to open Spotify first.
```

## 6. Playlist merge without tears

```text
1. Call playlist_diff with playlist_a_id SOURCE_A and playlist_b_id SOURCE_B, response_format json.
2. Show only-in-A, only-in-B, and overlap counts.
3. On approval, call merge_playlists with sources [SOURCE_A, SOURCE_B] and dry_run true, then commit.
4. Run playlist_overlap_matrix afterwards to prove the merge converged.
```

`whats_new` accepts `since` as `YYYY-MM-DD` or the literal `last-check`; use one of those exact forms.

## 7. Discovery injection (no recommendations endpoint)

Spotify retired recommendations; this is the honest replacement.

```text
1. Call grow_playlist on PLAYLIST_ID — it finds tracks co-occurring in your OTHER playlists.
2. Cross-check each candidate with statsfm_top_tracks using user_id "<your-statsfm-user-id>" and range "lifetime"; demote anything already overplayed.
3. Add the top 5 survivors with add_to_playlist, using its `uris` array (dry_run, then commit).
4. Report the evidence chain per track: which playlists it co-occurred in.
```

## 8. Taste compatibility check

There is no cross-user taste-comparison tool. Use the registered social and per-user tools to compare public profiles without inventing a compatibility score.

```text
1. Call statsfm_friends for each public user ID, then call statsfm_top_artists for both IDs.
2. Call statsfm_top_genres for both sides if the overlap needs explaining.
3. Report shared artists and genre overlap, clearly separating observed overlap from your interpretation.
4. If asked, build a playlist from your own profile with recipe 1 and share it.
```

## 9. When-listening audit

```text
1. Call taste_listening_clock with statsfm_user "<your-statsfm-user-id>" and response_format json.
2. Call listening_report for the same window for the Spotify-side totals.
3. Compare: note where the two counters agree and where they diverge (different windows — say so).
4. Suggest one scene: save_scene "late-night-low" if the clock shows heavy 23:00–01:00 listening.
```

## 10. Read-only demo for a guest

Safe to run on someone else's account or a shared screen — zero writes.

```text
1. Set SPOTIFY_MCP_READONLY=1 (or use a host config with it set) before starting.
2. Call get_me, statsfm_resolve_user, and statsfm_taste_profile with the guest's explicit statsfm_user argument.
3. Call listening_report and whats_new with dry_run true for live color.
4. Narrate the taste: genres, anchors, and clock. Offer recipe 1 as the follow-up — on their own account.
```

## See also

- [stats.fm second source](statsfm.md) — setup, cheat sheet, gotchas
- [Taste showcase](taste.md) — recipe 1 worked end to end
- [FAQ](faq.md) — when a recipe step errors
