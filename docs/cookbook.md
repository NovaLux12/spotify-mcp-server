# Cookbook — copy-paste agent recipes

Ten recipes you can paste to an agent (or run turn by turn) against SpotifyMCP. Each states the tools it uses and what you get. Recipe 1 is the flagship: stats.fm taste in, Spotify playlist out.

Conventions: `dry_run: true` first on every write; JSON tool args shown inline; replace `PLAYLIST_ID` / user IDs with yours. stats.fm recipes assume `STATSFM_USER_ID` is set — see [stats.fm setup](statsfm.md#setup).

## 1. Taste profile → playlist (flagship)

Build a playlist that sounds like you, from stats.fm evidence instead of vibes.

```text
1. Call statsfm_history_status. If coverage is thin, say so and stop — don't build on empty data.
2. Call statsfm_taste_profile with range "lifetime", response_format "json".
3. Call statsfm_top_genres with range "month" — note which genres are surging vs the lifetime baseline.
4. Create a private playlist named "Taste Profile — <Month Year>" (create_playlist, dry_run first, then for real).
5. For each of the top 3 genres, search catalog (search_tracks) for 2 representative tracks:
   one anchor (an artist from the taste profile) and one discovery (an artist NOT in the top artists).
6. Add the picks with add_to_playlist (dry_run preview, then commit).
7. Reply with the playlist link, the genre split, and which picks were discovery vs anchor.
```

Why it works: lifetime gives identity, month gives momentum, and the anchor/discovery split keeps the list familiar but not stale. Full walkthrough with a worked example: [taste showcase](taste.md).

## 2. Morning briefing

```text
1. Call whats_new with since "last-check" (dry_run first to preview the lookup budget).
2. Call statsfm_recent_streams with limit 10 for overnight context.
3. Summarize: new releases from followed artists + what actually got played overnight.
4. If asked, queue one new release on the active device (play tool, confirm device first).
```

## 3. Duplicate cleanup sweep

```text
1. Call find_duplicates on PLAYLIST_ID with dry_run true and report the groups.
2. Ask the human which group(s) to dedupe — never bulk-delete unasked.
3. Call remove_from_playlist with the confirmed URIs (elicitation will confirm at 10+).
4. Call verify_receipt on the returned receipt id and report what landed.
```

## 4. Library hygiene pass

```text
1. Call library_hygiene and library_genre_report.
2. Report orphaned singles (tracks whose album isn't saved) and near-complete albums.
3. For each near-complete album, ask: save the full album? On yes, save_items for the missing tracks.
4. Tag remaining outliers with tag_management so filter_by_genre finds them next time.
```

## 5. Podcast catch-up session

```text
1. Call whats_new scoped to shows (or podcast_catchup prompt) with since "last Monday".
2. Call plan_podcast_session with a 45-minute time box.
3. Present the plan; on approval, start_podcast_session on the chosen device.
4. If no device is active, list devices and ask the user to open Spotify first.
```

## 6. Playlist merge without tears

```text
1. Call playlist_diff on SOURCE_A vs SOURCE_B, response_format json.
2. Show: only-in-A, only-in-B, overlap counts.
3. On approval, merge_playlists (or add_to_playlist from the diff) with dry_run preview first.
4. Run playlist_overlap afterwards to prove the merge converged.
```

## 7. Discovery injection (no recommendations endpoint)

Spotify retired recommendations; this is the honest replacement.

```text
1. Call grow_playlist on PLAYLIST_ID — it finds tracks co-occurring in your OTHER playlists.
2. Cross-check each candidate with statsfm_top_tracks (range "lifetime"): demote anything already overplayed.
3. Add the top 5 survivors with add_to_playlist (dry_run, then commit).
4. Report the evidence chain per track: which playlists it co-occurred in.
```

## 8. Taste compatibility check

```text
1. Call statsfm_compare_taste with your user id and THEIR_USER_ID.
2. Call statsfm_top_genres for both sides if the overlap needs explaining.
3. Report: shared artists/tracks, genre overlap, and one playlist idea straddling both tastes.
4. If asked, build that playlist (see recipe 1) and share it.
```

## 9. When-listening audit

```text
1. Call statsfm_listening_clock, response_format json.
2. Call listening_report for the same window for the Spotify-side totals.
3. Compare: note where the two counters agree and where they diverge (different windows — say so).
4. Suggest one scene: e.g. save_scene "late-night-low" (low volume, shuffle on) if the clock shows heavy 23:00–01:00 listening.
```

## 10. Read-only demo for a guest

Safe to run on someone else's account or a shared screen — zero writes.

```text
1. Set SPOTIFY_MCP_READONLY=1 (or use a host config with it set) before starting.
2. Call get_me, statsfm_get_profile, and statsfm_taste_profile.
3. Call listening_report and whats_new (dry_run) for live color.
4. Narrate the taste: genres, anchors, clock. Offer recipe 1 as the follow-up — on their own account.
```

## See also

- [stats.fm second source](statsfm.md) — setup, cheat sheet, gotchas
- [Taste showcase](taste.md) — recipe 1 worked end to end
- [FAQ](faq.md) — when a recipe step errors
