# Cookbook — copy-paste agent recipes

<!-- BEGIN:generated recipe-index -->
**11** recipes you can paste to an agent (or run turn by turn) against SpotifyMCP. Each states the tools it uses and what you get. Recipe 1 is the flagship: stats.fm taste in, Spotify playlist out.
<!-- END:generated recipe-index -->

Conventions: JSON tool args are shown inline; replace `PLAYLIST_ID` and IDs with yours. Which identity argument a stats.fm tool takes is a property of the tool, not of its prefix: the endpoint tools take `user_id`, the seven network-backed taste tools in `src/tools/statsfm_taste.ts` take `statsfm_user`, and the `taste_*` composites follow their own schema (most take `statsfm_user`; `taste_shift_report` and `taste_checkpoint` read your Spotify top lists and take none). Catalog/search tools and the local `statsfm_record_feedback`/`record_feedback` pair are identity-free. Check the tool's own schema rather than inferring from the name. Identity is per call unless you set `STATSFM_USER_ID` to supply the default (an explicit argument still wins; with neither, the call fails rather than guessing a profile) — never infer it from the Spotify account. Preview Spotify writes with `dry_run: true` when the tool supports it, show the human what will change, and get explicit confirmation immediately before every write or destructive action.

## 1. Taste profile → playlist (flagship)

Build a playlist that sounds like you, from stats.fm evidence instead of vibes.

> Risk: creates a new playlist and bulk-adds tracks to it; preview first via `dry_run: true` on both `create_playlist` and `add_to_playlist`.

```text
1. Call statsfm_streams_stats with `user_id: "<your-statsfm-user-id>"`; if the imported history is thin, say so and stop.
2. Call statsfm_taste_profile with `statsfm_user: "<your-statsfm-user-id>"`, `range: "lifetime"`, and `response_format: "json"`.
3. Call statsfm_top_genres with `user_id: "<your-statsfm-user-id>"` and `range: "months"`; note which genres are surging versus the lifetime baseline.
4. Ask the human to approve the playlist name, then preview `create_playlist` with `name: "Taste Profile — YYYY-MM"`, `public: false`, and `dry_run: true`; commit the same arguments without `dry_run` only after confirmation.
5. For each of the top 3 genres, pick a seed artist for that genre from the taste profile, then call `search_tracks` with that artist as `query` and `limit: 2`: one anchor (a top artist) and one discovery (an artist not in the top artists). `search_tracks` takes free text only — it is `GET /search?type=track&q=…` and has no genre facet, so a genre has to reach it as an artist name, not as a genre name.
6. Preview add_to_playlist with the created `playlist_id`, the selected track `uris` array, and `dry_run: true`; commit the same arguments without `dry_run` only after the human confirms.
7. Reply with the playlist link, the genre split (from the taste profile, not from the search results), and which picks were discovery versus anchor.
```

Why it works: lifetime gives identity, the current month gives momentum, and the anchor/discovery split keeps the list familiar but not stale. Full walkthrough with a worked example: [taste showcase](taste.md).

## 2. Morning briefing

> Risk: queues a track to your active device; preview first via `dry_run: true` on `add_to_queue`.

```text
1. Call whats_new with `since: "last-check"` and `dry_run: true` to preview the lookup budget.
2. Call statsfm_recent_streams with `user_id: "<your-statsfm-user-id>"` and `limit: 10` for overnight context.
3. Summarize new releases from followed artists and what actually got played overnight.
4. If asked to queue a result, first preview add_to_queue with the selected track or episode `uri`, the confirmed active `device_id`, and `dry_run: true`; commit the same arguments without `dry_run` only after explicit confirmation.
```

## 3. Duplicate cleanup sweep

> Risk: bulk-deletes duplicate occurrences from a playlist; preview first via `dry_run: true` on `remove_duplicate_playlist_items`.

```text
1. Call find_duplicates_in_playlist with `playlist_id: "PLAYLIST_ID"` and report the groups; this finder is read-only and does not accept `dry_run`.
2. Ask the human which occurrences to remove—never bulk-delete unasked.
3. Preview remove_duplicate_playlist_items with `playlist_id: "PLAYLIST_ID"` and `dry_run: true`; commit the same arguments without `dry_run` only after the human confirms the preview. The tool keeps the first occurrence of each track and removes later repeats; bulk removals of 10+ items ask for confirmation via elicitation.
4. The tool's post-mutation re-scan verifies the cleanup actually landed — there is no separate receipt to look up.
```

## 4. Library hygiene pass

> Risk: bulk-saves missing album tracks to your library and tags outliers; preview first via `dry_run: true` on `save_to_library` and `tag_management`.

```text
1. Call library_hygiene and library_genre_report. When a specific saved genre tag needs checking, call filter_by_genre with a `genre` string and `kind: "tracks"` or `kind: "albums"`.
2. Report orphaned singles (tracks whose album isn't saved) and near-complete albums.
3. For each near-complete album, ask whether to save the full album. On yes, preview save_to_library with the missing track `uris` array and `dry_run: true`, then commit the same arguments without `dry_run` only after confirmation.
4. To tag an outlier, preview tag_management with `action: "add"`, the exact library `artist` name, a non-empty `tags` array, and `dry_run: true`; commit the same arguments without `dry_run` only after confirmation. filter_by_genre can find those tags next time.
```

## 5. Podcast catch-up session

> Risk: starts a podcast session on the chosen device; preview first via `dry_run: true` on `start_podcast_session`.

```text
1. Call whats_new with `kinds: ["podcasts"]`, `since: "last-check"`, and `dry_run: true`, or use the registered podcast_catchup prompt — its arguments are `days` (default 7), `per_show_limit` (default 3) and `max_shows` (default 25), all optional, and it has no `since` argument.
2. Call plan_podcast_session with `minutes: 45`.
3. Present the plan; on approval, preview start_podcast_session with `minutes: 45`, the chosen `device_id`, and `dry_run: true`, then commit the same arguments without `dry_run` only after confirmation.
4. If no device is active, call get_devices and ask the user to open Spotify first.
```

## 6. Playlist merge without tears

> Risk: merges sources into a destination playlist, appending to it when `target_playlist_id` names an existing one — `merge_playlists` is append-only and never clears the target — or creating a new playlist when `new_name` is given; preview first via `dry_run: true` on `merge_playlists`.

```text
1. Call diff_playlists with `playlist_a` set to `SOURCE_A`, `playlist_b` set to `SOURCE_B`, and `response_format: "json"`.
2. Show the common, only-in-A, and only-in-B counts and whether their shared tracks have the same relative order.
3. Choose a destination and get explicit human approval. Call merge_playlists with `playlists: ["SOURCE_A", "SOURCE_B"]`, exactly one valid destination—`new_name: "Merged Playlist"` for a new playlist or `target_playlist_id: "DESTINATION_ID"` for an existing playlist—and `dry_run: true`; show the preview and get confirmation again before committing without `dry_run`.
4. Call overlap_playlists with `playlists: ["SOURCE_A", "SOURCE_B", "DESTINATION_ID"]` to inspect convergence.
```

`whats_new` accepts `since` only as `YYYY-MM-DD` or the literal `last-check`; relative phrases are invalid. Its watermark is tracked per kind, so an `albums`-only call never moves the mark a `podcasts` call reads, and an explicit `YYYY-MM-DD` `since` never writes the watermark at all — use `last-check` (or a plain `days_back` window) when the call is meant to move the incremental mark. See `docs/configuration.md` § Freshness and local sidecars.

## 7. Discovery injection (no recommendations endpoint)

`/recommendations` is blocked on app registrations created after November 2024, and this server ships no tool that calls it; this recipe builds candidates from your own library instead.

> Risk: bulk-adds candidate tracks to a playlist; preview first via `dry_run: true` on `add_to_playlist`.

```text
1. Call grow_playlist with `playlist_id: "PLAYLIST_ID"`; it finds tracks co-occurring in your OTHER playlists.
2. Cross-check each candidate with statsfm_top_tracks using `user_id: "<your-statsfm-user-id>"` and `range: "lifetime"`; demote anything already overplayed.
3. Preview add_to_playlist with `playlist_id: "PLAYLIST_ID"`, the top 5 surviving track `uris` array, and `dry_run: true`, then commit the same arguments without `dry_run` only after confirmation.
4. Report the evidence chain per track: which playlists it co-occurred in.
```

## 8. Taste compatibility check

There is no cross-user taste-comparison tool. Use the registered social and per-user tools to compare public profiles without inventing a compatibility score.

> Risk: read-only — no Spotify or sidecar writes.

```text
1. Call statsfm_friends for each explicit public `user_id`, then call statsfm_top_artists with `user_id` set to each of the two public stats.fm IDs.
2. Call statsfm_top_genres with each of those two explicit `user_id` values if the overlap needs explaining.
3. Report shared artists and genre overlap, clearly separating observed overlap from your interpretation.
4. If asked, build a playlist from your own profile with recipe 1 and share it.
```

## 9. When-listening audit

> Risk: `save_scene` writes to the local sidecar at `~/.spotify-mcp/scenes.json`. The tool does NOT accept `dry_run`, so explicit human approval is the only gate — do not call it without a "yes" on the latest suggestion.

> Step 2 uses the ungated re-presentations on purpose. `listening_report` and the other derived listening metrics register only under `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS`; if the host has that set, `listening_report` gives the same totals in one call.

```text
1. Call taste_listening_clock with `statsfm_user: "<your-statsfm-user-id>"` and `response_format: "json"`.
2. Call get_recently_played with `limit: 50` for the Spotify-side plays, and read the `played_at` timestamps yourself.
3. Compare: note where the two counters agree and where they diverge (different windows — say so).
4. If the clock shows heavy 23:00–01:00 listening, suggest that scene to the human. Only after they approve the local sidecar write, call save_scene with `name: "late-night-low"`, `volume: 40`, `shuffle: false`, and `repeat: "off"`.
```

## 10. Read-only demo for a guest

Safe to run on someone else's account or a shared screen — zero writes.

> Risk: read-only — set `SPOTIFY_MCP_READONLY=1` so write-capable tools are hidden from the registry, and every step below is read-only by construction.

```text
1. Set SPOTIFY_MCP_READONLY=1 (or use a host config with it set) before starting.
2. Call get_me; resolve the guest's public stats.fm identity with `statsfm_resolve_user`, passing their stats.fm user id or customId as `user_id`; then call statsfm_taste_profile with `statsfm_user` set to that same id.
3. Call get_recently_played and preview whats_new with `dry_run: true` for live color; neither step writes.
4. Narrate the taste: genres, anchors, and clock. Offer recipe 1 as the follow-up — on their own account.
```

## 11. Poll near-real-time state cheaply (ETag watch loop)

Live playback state changes constantly but usually not at all between two polls seconds apart. Reads carry the `ETag` Spotify returns, and the next read of the same key sends `If-None-Match`: an unchanged resource comes back **304** with no body, and the server answers with the payload it already holds. The watch loop is the client doing this for you — all you write is the interval and the branch.

> Risk: read-only — pure ETag poll, no writes.

```text
1. Every 5 seconds, call get_now_playing with `response_format: "json"`.
2. Read `unchanged` from structuredContent. Absent means Spotify sent a fresh
   body — act on it. `true` means the ETag still matched, nothing moved, and
   you paid no re-download: stay quiet and poll again.
3. Escalate only on a fresh body: narrate the track change, and stop the loop
   when a poll says nothing is playing.
```

The same applies to `get_currently_playing` (lightweight poll). A 304 never surfaces as an empty result — the payload is the state you already had, with one addition: `unchanged: true` is set on the 304 branch and is absent on a fresh body, so it is the only field to branch on. That field is in `structuredContent`, which these two tools emit only under `response_format: "json"`; the default `concise` mode reports the same thing as a trailing prose line. Catalog reads (`get_album`, `get_artist`, …) are additionally cached for 5 minutes, and a 304 within the 60-minute validator window refreshes the cache entry instead of re-downloading it. One caveat for watch loops: any mutation you make (pause, skip, volume) drops the stored validators, so the next poll is a full read — which is the correct answer right after a change you caused.

## Undo tools

Receipt-bearing mutations of *items* — playlist adds and removals, library saves and removals — can be reverted. The receipt ID returned by the tool is the handle for the rollback, and a verify step confirms the receipt itself. Playlist-metadata receipts (the `playlist_meta` kind issued by `create_playlist`, `update_playlist` and `playlist_template_apply`) are **not** reversible: `undo_mutation` refuses them outright, and `undo_last_mutation` skips past them, so a `create_playlist` receipt is a record of what happened, not a handle. The undo surface is five tools; none of them mutate Spotify until the human approves the rollback.

- `verify_receipt` — looks up a receipt by ID and reports its recorded URIs and verification state. Read-only, and registered unconditionally (not trimmed by `SPOTIFY_MCP_TOOLSETS` or the scope filter), because a session that just made the write must be able to verify it. `structuredContent.found` tells the two outcomes apart; an unknown or expired id also sets `isError`, so a miss is a failed *lookup*, never evidence about the mutation.
- `undo_mutation` — inverts a specific mutation by receipt ID. Add/save receipts roll back as a removal, removal receipts as a re-add. Playlist add undos target only the rows the add created — never every copy of the URI. Defaults to `dry_run: true`; execute needs elicitation confirmation and is refused when the host cannot prompt (`SPOTIFY_MCP_CONFIRM=never` bypasses).
- `undo_last_mutation` — same inversion semantics as `undo_mutation`, target = the most recent reversible receipt.
- `undo_preview` — dry-run for `undo_mutation`: the before/after diff and the inversion calls a revert *would* make, without executing. Read-only, and it issues no receipt of its own. With `check: true` on a playlist-items receipt it makes one read (`GET /playlists/{id}`) to check the current state; nothing else is left to undo.
- `receipt_lookup` — find receipts by id, by an issue date (`since`), or by an affected URI. Local only, zero API calls — this is how you get a receipt ID when you did not keep the one the tool returned.

Prefer `undo_last_mutation` after a single speculative write; reach for `undo_mutation` (with the receipt ID the previous step returned) when the rollback you want is not the latest mutation.

## See also

- [stats.fm second source](statsfm.md) — setup, cheat sheet, gotchas
- [Taste showcase](taste.md) — recipe 1 worked end to end
- [FAQ](faq.md) — when a recipe step errors
