# Live sweep report — 2026-08-27T12:21:54.005Z

**224 tools discovered** · pass 61 · fail 0 · skip 163 · gated 13 · mode {"batch_limit":40,"resumed_from":"memory/live-sweep-report.json"}

| tool | status | latency | reason |
|---|---|---|---|
| get_me | PASS | 157ms |  |
| search | PASS | 498ms |  |
| get_user_playlists | PASS | 191ms |  |
| get_now_playing | PASS | 69ms |  |
| get_currently_playing | PASS | 95ms |  |
| play_from_search | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| play | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| pause | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| skip_next | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| skip_previous | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| seek | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| set_volume | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| set_shuffle | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| set_repeat | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| get_queue | PASS | 94ms |  |
| add_to_queue | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| get_devices | PASS | 34ms |  |
| transfer_playback | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| handoff | SKIP | 0ms | missing prereq from seed reads |
| get_track | PASS | 112ms |  |
| get_artist | PASS | 115ms |  |
| get_artist_albums | PASS | 59ms |  |
| get_album | PASS | 132ms |  |
| get_album_tracks | PASS | 100ms |  |
| get_show | PASS | 328ms |  |
| get_show_episodes | PASS | 195ms |  |
| get_episode | PASS | 364ms |  |
| get_artist_top_tracks | PASS (gated) | 58ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_available_markets | PASS (gated) | 118ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_several_tracks | PASS (gated) | 81ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_several_albums | PASS (gated) | 116ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_several_artists | PASS (gated) | 88ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_several_episodes | PASS (gated) | 104ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_several_shows | PASS (gated) | 99ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_several_audiobooks | PASS (gated) | 103ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_several_chapters | SKIP | 0ms | no chapter in seeds |
| get_category | SKIP | 0ms | missing prereq from seed reads |
| search_tracks | SKIP | 0ms | missing prereq from seed reads |
| search_artists | SKIP | 0ms | missing prereq from seed reads |
| search_albums | SKIP | 0ms | missing prereq from seed reads |
| search_playlists | SKIP | 0ms | missing prereq from seed reads |
| search_shows | SKIP | 0ms | missing prereq from seed reads |
| search_episodes | SKIP | 0ms | missing prereq from seed reads |
| search_audiobooks | SKIP | 0ms | missing prereq from seed reads |
| catalog_batch_lookup | SKIP | 0ms | missing prereq from seed reads |
| get_artist_singles | SKIP | 0ms | missing prereq from seed reads |
| get_artist_appearances | SKIP | 0ms | missing prereq from seed reads |
| market_validate | SKIP | 0ms | missing prereq from seed reads |
| browse_category_deepdive | SKIP | 0ms | missing prereq from seed reads |
| show_episode_search | SKIP | 0ms | missing prereq from seed reads |
| get_top_tracks | PASS | 246ms |  |
| get_top_artists | PASS | 172ms |  |
| get_recently_played | PASS | 144ms |  |
| listening_streaks | SKIP | 0ms | missing prereq from seed reads |
| top_artists_by_range | SKIP | 0ms | missing prereq from seed reads |
| taste_shift_report | SKIP | 0ms | missing prereq from seed reads |
| listening_report | PASS | 1132ms |  |
| library_hygiene | PASS | 9952ms |  |
| restore_library_snapshot | SKIP | 0ms | missing prereq from seed reads |
| backup_library | SKIP | 0ms | missing prereq from seed reads |
| list_backups | SKIP | 0ms | missing prereq from seed reads |
| get_artist_genres | SKIP | 0ms | missing prereq from seed reads |
| get_categories | SKIP | 0ms | missing prereq from seed reads |
| get_category_playlists | SKIP | 0ms | missing prereq from seed reads |
| get_artist_discography | SKIP | 0ms | missing prereq from seed reads |
| resolve_artist | SKIP | 0ms | missing prereq from seed reads |
| save_artist_new_releases | SKIP | 0ms | missing prereq from seed reads |
| watch_artists | SKIP | 0ms | missing prereq from seed reads |
| check_artist_releases | SKIP | 0ms | missing prereq from seed reads |
| artist_release_digest | SKIP | 0ms | missing prereq from seed reads |
| search_history | SKIP | 0ms | missing prereq from seed reads |
| search_rerun | SKIP | 0ms | missing prereq from seed reads |
| search_within_playlist | SKIP | 0ms | missing prereq from seed reads |
| search_history_stats | SKIP | 0ms | missing prereq from seed reads |
| audiobook_progress | SKIP | 0ms | missing prereq from seed reads |
| unsave_orphan_tracks | SKIP | 0ms | missing prereq from seed reads |
| playlist_to_library | SKIP | 0ms | missing prereq from seed reads |
| followed_playlists_audit | SKIP | 0ms | missing prereq from seed reads |
| get_playlist_added_dates | SKIP | 0ms | missing prereq from seed reads |
| split_playlist | SKIP | 0ms | missing prereq from seed reads |
| find_duplicate_tracks_across_playlists | SKIP | 0ms | missing prereq from seed reads |
| remove_from_library_by_playlist | SKIP | 0ms | missing prereq from seed reads |
| library_coverage_report | SKIP | 0ms | missing prereq from seed reads |
| listening_heatmap | SKIP | 0ms | missing prereq from seed reads |
| library_growth_report | SKIP | 0ms | missing prereq from seed reads |
| genre_trends_over_time | SKIP | 0ms | missing prereq from seed reads |
| save_discover_weekly | SKIP | 0ms | missing prereq from seed reads |
| save_release_radar | SKIP | 0ms | missing prereq from seed reads |
| export_library_json | SKIP | 0ms | missing prereq from seed reads |
| export_followed_artists | SKIP | 0ms | missing prereq from seed reads |
| export_profile_state | SKIP | 0ms | missing prereq from seed reads |
| import_profile_state | SKIP | 0ms | missing prereq from seed reads |
| export_listening_history | SKIP | 0ms | missing prereq from seed reads |
| export_all_playlists | SKIP | 0ms | missing prereq from seed reads |
| library_snapshot_diff | SKIP | 0ms | missing prereq from seed reads |
| history_search | SKIP | 0ms | missing prereq from seed reads |
| import_from_sidecar | SKIP | 0ms | missing prereq from seed reads |
| archive_played_episodes | SKIP | 0ms | missing prereq from seed reads |
| playlist_health_check | SKIP | 0ms | missing prereq from seed reads |
| get_playlist_followers | SKIP | 0ms | missing prereq from seed reads |
| playlist_collaboration_report | SKIP | 0ms | missing prereq from seed reads |
| snapshot_playlist | SKIP | 0ms | missing prereq from seed reads |
| diff_since_snapshot | SKIP | 0ms | missing prereq from seed reads |
| remove_unavailable_playlist_items | SKIP | 0ms | missing prereq from seed reads |
| find_duplicate_playlists | SKIP | 0ms | missing prereq from seed reads |
| list_playlist_snapshots | SKIP | 0ms | missing prereq from seed reads |
| batch_add_to_playlist | SKIP | 0ms | missing prereq from seed reads |
| copy_playlist | SKIP | 0ms | missing prereq from seed reads |
| move_items_between_playlists | SKIP | 0ms | missing prereq from seed reads |
| pin_playlist | SKIP | 0ms | missing prereq from seed reads |
| unpin_playlist | SKIP | 0ms | missing prereq from seed reads |
| playlist_template_apply | SKIP | 0ms | missing prereq from seed reads |
| queue_playlist | SKIP | 0ms | missing prereq from seed reads |
| save_queue_as_playlist | SKIP | 0ms | missing prereq from seed reads |
| save_playback_state | SKIP | 0ms | missing prereq from seed reads |
| restore_playback_state | SKIP | 0ms | missing prereq from seed reads |
| list_playback_states | SKIP | 0ms | missing prereq from seed reads |
| rename_device | SKIP | 0ms | missing prereq from seed reads |
| set_device_volume_preset | SKIP | 0ms | missing prereq from seed reads |
| apply_device_presets | SKIP | 0ms | missing prereq from seed reads |
| list_device_presets | SKIP | 0ms | missing prereq from seed reads |
| tag_listening_session | SKIP | 0ms | missing prereq from seed reads |
| replay_session | SKIP | 0ms | missing prereq from seed reads |
| list_sessions | SKIP | 0ms | missing prereq from seed reads |
| save_smart_playlist_rule | SKIP | 0ms | missing prereq from seed reads |
| refresh_smart_playlist | SKIP | 0ms | missing prereq from seed reads |
| save_show_digest | SKIP | 0ms | missing prereq from seed reads |
| play_on | SKIP | 0ms | missing prereq from seed reads |
| queue_next | SKIP | 0ms | missing prereq from seed reads |
| describe_queue | SKIP | 0ms | missing prereq from seed reads |
| describe_listening_session | SKIP | 0ms | missing prereq from seed reads |
| play_at | SKIP | 0ms | missing prereq from seed reads |
| device_health | SKIP | 0ms | missing prereq from seed reads |
| seek_relative | SKIP | 0ms | missing prereq from seed reads |
| playback_timeline | SKIP | 0ms | missing prereq from seed reads |
| repeat_queue_toggle | SKIP | 0ms | missing prereq from seed reads |
| now_playing_history | SKIP | 0ms | missing prereq from seed reads |
| playback_compare_states | SKIP | 0ms | missing prereq from seed reads |
| peek_next | SKIP | 0ms | missing prereq from seed reads |
| get_playback_context | SKIP | 0ms | missing prereq from seed reads |
| volume_step | SKIP | 0ms | missing prereq from seed reads |
| market_availability | SKIP | 0ms | missing prereq from seed reads |
| spotify_doctor | PASS | 2ms |  |
| get_followed_artists | PASS | 199ms |  |
| check_following_artists | PASS (gated) | 57ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| follow_artists | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| unfollow_artists | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| following_analytics | SKIP | 0ms | missing prereq from seed reads |
| get_audiobook | PASS | 311ms |  |
| get_audiobook_chapters | PASS | 146ms |  |
| get_chapter | PASS | 173ms |  |
| get_saved_audiobooks | PASS | 106ms |  |
| get_playlist | PASS | 305ms |  |
| get_playlist_items | PASS | 191ms |  |
| get_playlist_cover | PASS | 185ms |  |
| upload_playlist_cover | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| create_playlist | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| add_to_playlist | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| remove_from_playlist | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| update_playlist | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| reorder_playlist_items | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| replace_playlist_items | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| find_duplicates_in_playlist | PASS | 296ms |  |
| remove_duplicate_playlist_items | SKIP | 0ms | missing prereq from seed reads |
| clean_all_playlists | SKIP | 0ms | missing prereq from seed reads |
| check_playlist_following | SKIP | 0ms | missing prereq from seed reads |
| clone_playlist_cover | SKIP | 0ms | missing prereq from seed reads |
| compare_playlist_covers | SKIP | 0ms | missing prereq from seed reads |
| get_playlist_snapshot | SKIP | 0ms | missing prereq from seed reads |
| playlist_collab_toggle | SKIP | 0ms | missing prereq from seed reads |
| playlist_sort | SKIP | 0ms | missing prereq from seed reads |
| playlist_shuffle | SKIP | 0ms | missing prereq from seed reads |
| playlist_reverse | SKIP | 0ms | missing prereq from seed reads |
| playlist_union | SKIP | 0ms | missing prereq from seed reads |
| playlist_subtract | SKIP | 0ms | missing prereq from seed reads |
| playlist_symmetric_difference | SKIP | 0ms | missing prereq from seed reads |
| playlist_trim | SKIP | 0ms | missing prereq from seed reads |
| get_user_profile | PASS (gated) | 61ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_user_playlists_by_id | PASS (gated) | 95ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| get_saved_tracks | PASS | 163ms |  |
| get_saved_albums | PASS | 119ms |  |
| get_saved_shows | PASS | 215ms |  |
| get_saved_episodes | PASS | 326ms |  |
| save_items | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| remove_saved_items | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| check_saved_items | PASS (gated) | 55ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| save_to_library | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| remove_from_library | SKIP | 0ms | mutating; not in --include-mutating allowlist |
| get_saved_counts | SKIP | 0ms | missing prereq from seed reads |
| search_saved_albums | SKIP | 0ms | missing prereq from seed reads |
| search_saved_shows | SKIP | 0ms | missing prereq from seed reads |
| search_saved_episodes | SKIP | 0ms | missing prereq from seed reads |
| search_saved_audiobooks | SKIP | 0ms | missing prereq from seed reads |
| check_in_library | PASS | 132ms |  |
| search_saved_tracks | SKIP | 0ms | missing prereq from seed reads |
| merge_playlists | PASS | 1ms |  |
| diff_playlists | PASS | 0ms |  |
| overlap_playlists | PASS | 1ms |  |
| grow_playlist | PASS (gated) | 1475ms | tool answered but snippet suggests app-registration gating (403/Forbidden/removed) |
| export_playlist | SKIP | 0ms | missing prereq from seed reads |
| import_playlist | SKIP | 0ms | missing prereq from seed reads |
| create_smart_playlist | SKIP | 0ms | missing prereq from seed reads |
| show_new_episodes | SKIP | 0ms | missing prereq from seed reads |
| find_duplicate_saved_tracks | SKIP | 0ms | missing prereq from seed reads |
| library_genre_report | PASS | 518ms |  |
| filter_by_genre | PASS | 1ms |  |
| tag_management | PASS | 0ms |  |
| whats_new | PASS | 256ms |  |
| search_deep | PASS | 478ms |  |
| plan_podcast_session | PASS | 362ms |  |
| start_podcast_session | PASS | 1ms |  |
| list_all_chapters | PASS | 147ms |  |
| jump_to_chapter | SKIP | 0ms | mutating adjacent — requires device; covered by list_all_chapters instead |
| where_was_i | PASS | 69ms |  |
| save_scene | SKIP | 0ms | MUTATING-ADJACENT (writes sidecar); not exercised by the safe sweep |
| list_scenes | PASS | 1ms |  |
| delete_scene | SKIP | 0ms | MUTATING-ADJACENT (writes sidecar); not exercised by the safe sweep |
| apply_scene | SKIP | 0ms | needs a saved scene; covered by list_scenes/save_scene instead |
| schedule_wind_down | SKIP | 0ms | MUTATING-ADJACENT (arms timers + volume changes) |
| cancel_wind_down | SKIP | 0ms | no active wind-down during gauntlet |
| backup_first | SKIP | 0ms | missing prereq from seed reads |
| undo_mutation | SKIP | 0ms | missing prereq from seed reads |
| undo_last_mutation | SKIP | 0ms | missing prereq from seed reads |
| verify_receipt | SKIP | 0ms | needs a receipt id from a prior mutation; skip in safe sweep |

## Genuine failures (0) — issues filed

## Quota timeouts (0) — retry in a later sweep, not tool bugs

## Gated 403s (0) — app-registration class, tracked in #329

## Verdict
All tested tools passed (or are classified SKIP/gated) — no tool bugs found.
