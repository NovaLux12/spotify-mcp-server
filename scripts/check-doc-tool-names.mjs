#!/usr/bin/env node
/**
 * Validate executable tool references in documentation against the finalized
 * default production registry. Tool names and JSON input schemas come from
 * scripts/surface-census.mjs, so count and name contracts share one source.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const censusFileIndex = process.argv.indexOf('--census-file');
if (censusFileIndex >= 0 && !process.argv[censusFileIndex + 1]) {
  throw new Error('--census-file requires a JSON file');
}
const census = JSON.parse(censusFileIndex >= 0
  ? readFileSync(resolve(process.argv[censusFileIndex + 1]), 'utf8')
  : execFileSync(process.execPath, ['scripts/surface-census.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const tools = new Set(census.toolNames);
const prompts = new Set(census.promptNames);
const resources = new Set(census.resourceUris);
/**
 * Tool names the SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS opt-in withholds (#695).
 *
 * These are NOT in `census.toolNames` and not in `retiredToolNames`, and the
 * distinction matters. A retired name was deleted; a gated one is still
 * shipped and still callable — it is simply not part of the DEFAULT surface,
 * which is the surface this gate validates docs against. So `docs/compliance.md`
 * and SPEC.md have to be able to name them while explaining the gate, and the
 * README must be able to stop naming them.
 *
 * The list is MEASURED, not declared: the census registers every module twice
 * and diffs the two name sets (see `measureGatedSurface`). A hand-typed copy
 * would outlive a rename and keep validating a name for a tool that no longer
 * exists — the same failure mode `parameterAllowlist` was rebuilt to avoid
 * (#1283), which is why real parameters come from `census.parameterNames`.
 *
 * A missing key degrades to an empty set, so a census file generated before
 * this field existed fails the gate loudly on the first backticked gated name
 * rather than silently accepting it.
 */
const gatedToolNames = (registry = census) => registry.gatedToolNames ?? [];
/**
 * Names a doc may backtick that are NOT production tool parameters: auth/OAuth
 * field names, doctor/report row keys, and env-var fragments. Real parameters
 * are not listed — they come from `census.parameterNames`, so a parameter that
 * production drops stops being allowlisted the moment it does, instead of
 * surviving here and masking real drift.
 */
const parameterAllowlist = new Set([
  ...(census.parameterNames ?? []),
  'account_premium', 'active_modules', 'active_toolsets', 'authorization_code',
  'budget_shrunk', 'client_id', 'client_secret', 'code_challenge',
  'code_verifier', 'expires_at', 'expires_in', 'invalid_grant', 'rate_limit',
  'redirect_uri', 'refresh_token', 'registered_tools', 'requests_made',
  // #602: the other half of the OAuth token pair, named in SPEC.md §5.13 to
  // state the one thing the account registry never stores. An API field name
  // a doc has to mention in order to promise its absence.
  'access_token',
  // #581: the doctor is now one report behind two entry points, and SPEC.md
  // and the doctor skill name what each one cannot agree on. These are the
  // `DoctorSurface` structuredContent keys and the live-probe row id — a
  // report describing its own output, not tools and not parameters.
  'account_probe', 'active_sets', 'exposed_modules', 'hidden_by_trim',
  'inactive_sets',
  // #715: the same kind of key — a `DoctorSurface` field, reported because a
  // deployment that trimmed the `resources` toolset still serves prompts, and
  // their resource hints are degraded. A report describing its own output.
  'prompts_without_resources',
  'requests_planned', 'token_refresh', 'web_search',
  // #703: the `history` doctor row's `fields` keys (#703 gives the mutation
  // ledger a row cap, a retention window, and a purge command, so a host can
  // read the row's numbers without parsing a sentence). A report describing
  // its own output, same category as the `DoctorSurface` keys above.
  'history_purge', 'history_rows', 'history_max_rows', 'history_retention_days',
  'history_oldest_ts',
  // #677: the token-endpoint failure classes. RFC 6749 §5.2 error codes the
  // refresh response carries (`invalid_client`, `server_error`) and one
  // category name of this server's own classifier (`network_unreachable`).
  // None is a tool or a parameter; both docs are naming what the token endpoint
  // returns so an operator can tell the failures apart.
  'invalid_client', 'server_error', 'network_unreachable',
  // Enum values and explicitly-removed field names, not parameters.
  'appears_on', 'available_markets',
  // #639: the rest of the February 2026 [REMOVED] field names, which SPEC.md
  // and the `get_me` contract now name so a caller does not go looking for a
  // field the API no longer sends. Same category as `available_markets` above:
  // a removed API field, never a tool and never a request parameter.
  'album_group', 'explicit_content', 'linked_from',
  // #696: the one API field SPEC.md §5.17 and docs/compliance.md name when they
  // say where the link back to Spotify comes from in `response_format: 'json'`
  // mode — `external_urls`, and specifically its `spotify` member, is the
  // canonical link every entity object already carries. A response field, never
  // a tool and never a request parameter: the same category as
  // `available_markets` above, named because a doc has to say where the link
  // comes from when it declines to construct one.
  'external_urls',
  // #639: the coverage keys the removed-field rollups publish alongside their
  // buckets, so a census that could only group some of its rows says how many
  // it actually reached instead of reporting a total that does not add up.
  // structuredContent keys describing a call's own output, not parameters.
  'albums_labelled', 'albums_without_label',
  'shows_with_publisher', 'shows_without_publisher',
  'releases_labelled', 'releases_without_label',
  // `time_range` enum members of the /me/top/* personalization tools. #807's
  // SPEC entry names them as the windows taste_shift_report compares, and as
  // the two halves of the `window_sizes` it returns. #603's resource
  // parameters section names `medium_term` for the same reason: it is the
  // documented default of the `?time_range` resource parameter, not a tool.
  'short_term', 'long_term', 'medium_term',
  // #885: the `match_by` enum member that is the point of the whole
  // vocabulary — SPEC §4.0.5 has to name all three rules, and the other two
  // (`uri`, `name`) are single words the scanner ignores. An enum value of a
  // real parameter, same category as `short_term` above.
  'name_artist',
  // #885: the two `playlist_exclude_artists` structuredContent keys that
  // partition the caller's references. They exist so a caller can tell "this
  // artist has no track here" from "this reference matched nothing", and
  // SPEC §4.0.5 has to name them to promise that. A call's own output
  // describing itself, not a request parameter — same category as the
  // `DoctorSurface` rows above.
  'matched_artists', 'unmatched_artists',
  // #846: the fields of the one canonical playback-position record, plus two
  // keys the migration report publishes. SPEC §5.1 has to name them to state
  // the contract: which field means "not captured" (shuffle_state/repeat_state
  // are null, not false), that origin_id is half the idempotency key, and that
  // already_present is what a second run reports. They describe a store's own
  // rows and a report's own output — the same category as the
  // `DoctorSurface` and coverage keys above, not tool parameters. `captured_at`
  // is named only to say the field is GONE, which is the #639 removed-field
  // case: a caller reading an old payload must be able to look the name up.
  'already_present', 'captured_at', 'is_playing', 'origin_id',
  'playback_state', 'repeat_state', 'saved_at', 'shuffle_state',
  // #597: the `/me/player` playback position, and the rate-limit request
  // counter. SPEC §6.5 has to name both, and for the same reason it names
  // `is_playing` above: the contract is about what is DELIBERATELY NOT a
  // change, and a doc cannot promise that a field is excluded from a
  // comparison without writing the field's name. Same category — response
  // fields of a resource, not tool parameters. `progress_ms` is the
  // continuously-advancing one the `player/state` vector excludes, and
  // `requests_total` is the `me/rate-limit` JSON key whose counter the
  // `me/rate-limit` vector excludes.
  'progress_ms', 'requests_total',
  // #847: the `get_queue` structuredContent keys SPEC §5.1 and §5.15 name.
  // The queue-read collapse put six tools' answers under `runtime`,
  // `duplicates` and `profile`, and a migration note has to name the fields
  // it is promising still exist — including the `timeline` row shape and the
  // two nullability clauses that keep a failed read from becoming a number.
  // A call's own output describing itself, not request parameters, the same
  // category as `matched_artists` above and the `DoctorSurface` rows.
  // `queue_length` is the one entry that is a RETIRED tool's field: §5.15 names
  // it to say it does not come across, and a migration note cannot promise or
  // deny a field by writing it in a code span the gate refuses to read.
  'context_label', 'current_track_remaining_error',
  'current_track_remaining_ms', 'duration_ms', 'estimated_total_wait_ms',
  'is_episode', 'plays_at_ms', 'queue_length', 'total_remaining_ms',
  'total_runtime_ms',
  // #602: the account registry's own vocabulary. `account_id` and
  // `display_name` are the two keys the acting-account echo adds to EVERY
  // tool result; the rest are `list_accounts` / `switch_account`
  // structuredContent keys and one registry-file key on disk. A report
  // describing its own output, not tools and not request parameters — the
  // same category as the `DoctorSurface` rows above.
  'account_id', 'display_name', 'active_account_id', 'active_display_name',
  'active_token_file', 'acting_account_id', 'acting_display_name',
  'registry_file', 'token_file', 'identity_note', 'registration_warning',
  'last_used',
  // #603: Spotify API field names the new resource contracts name, and one
  // structuredContent key. `played_at` is the field the
  // `spotify://me/recently-played` cursor is derived from; `is_active` is the
  // `SpotifyDevice` flag the player-devices resource prints; `truncation_note`
  // is the key the capped-walk JSON payload has carried since #718. None is a
  // tool and none is a request parameter — a doc naming a response field is
  // describing the wire format, which is the thing this gate exists to keep
  // consistent with the schema.
  'played_at', 'is_active', 'truncation_note',
  // StructuredContent field names, not parameters: the documented count split.
  'removed_total', 'kept_total', 'source_truncated', 'target_truncated',
  'would_confirm', 'base_read_whole', 'base_unrepresentable',
  // #860: playlist_union / playlist_subtract now report whether the commit
  // will be refused outright, and the union side of the unrepresentable-row
  // count joins its base counterpart above. Both are structuredContent keys
  // about a call's own result, not parameters and not tools.
  'would_refuse', 'target_unrepresentable',
  // #1279: the doctor detail key reporting a cache save that a hard-killed
  // process never wrote. It is a key in the `cache` row's `detail` string, not
  // a tool and not a request parameter — SPEC.md and docs/configuration.md are
  // naming the field the doctor emits so an operator can recognise a lost save
  // rather than a healthy session.
  'cache_persist_lost',
  // #895: the `response_cap` receipt that rides with a byte-capped result.
  // Every one of these is a structuredContent key describing a call's own
  // output — what the ceiling was, what the payload actually measured, and
  // which top-level fields were withheld. None is a tool and none is a request
  // parameter; SPEC.md is naming the fields the cap emits, which is the point.
  'response_cap', 'response_capped', 'cap_bytes', 'actual_bytes',
  'retained_fields', 'omitted_fields', 'omitted_field_count',
  'removed_uris', 'scan_cap', 'base_playlist', 'target_playlist',
  // #724: the whats_new watermark is per kind, so these are the on-disk key
  // the sidecar carries and the two structuredContent keys a call uses to say
  // where its cutoff came from and that it read a pre-2.2 flat file. They name
  // a call's own state and a file's own shape — not tools, not parameters.
  'last_check', 'cutoff_reason', 'legacy_watermark_migrated_from',
  // #902: merge_playlists' result shape, documented in SPEC.md §5.6 so a
  // merge that read a fraction of its sources says how large that fraction is.
  // structuredContent keys on that tool, not parameters and not tools.
  // `requests_read` is allowlisted below with `search_requests_read` (#899),
  // and `truncated_by_cap` is allowlisted further down with `fetch_all_cap` —
  // one entry each, not two, for keys more than one PR reports.
  'created_new_playlist', 'duplicates_skipped',
  'unavailable_items_skipped', 'batches_sent',
  'rows_read', 'reported_total',
  // #1423: the neighbours of the bounded-read disclosure that are NOT part of
  // it, named in SPEC.md §5 so a new tool does not reinvent one of them as a
  // fourth spelling. All four are structuredContent keys naming a result the
  // call reports about its own work — `item_walk_cap` is take_playlist_snapshot's
  // ceiling beside `reported_total`; the three `<entity>_scanned` keys count
  // entities a scan examined and carry no total beside them, which is exactly
  // why they are not `rows_read`.
  'item_walk_cap',
  // `cap_reached` is take_playlist_snapshot's truncation verdict, named beside
  // `reported_total` because the tool writes a snapshot file rather than
  // answering a question about a live read, so it says "the cap was reached"
  // instead of carrying a `truncated` flag. A structuredContent key on that
  // tool, on the same reasoning as `item_walk_cap` above.
  'cap_reached',
  'playlists_scanned', 'saved_albums_scanned', 'releases_scanned',
  // #1423 again, for the family the same paragraph rules out: fifteen
  // `swarm4_playlists` tools emit `<field>_total` / `_returned` / `_withheld`
  // / `_truncated` through `budgetedArray`, which builds the key by computation
  // so no literal for it exists anywhere in the tree. `items_total` is the
  // common one and is a released structuredContent key. `swarm4_playlists` is
  // the MODULE those tools live in — a source file, named because the
  // distinction only matters to someone editing that file. Neither is a tool or
  // a parameter.
  'items_total', 'swarm4_playlists',
  // #1388, RENAMED by #1423: playlist_balance's coverage fields. The tool
  // splits what its bounded walk returned, so it reports how much it read and
  // how large the source playlist is. It shipped `items_read` / `items_total`;
  // #1423 moved it onto the repo-wide pair `rows_read` / `reported_total`
  // (allowlisted above) so one name means the same thing everywhere, and
  // dropped `items_total` entirely — it is now a dead spelling.
  //
  // `items_read` stays allowlisted for exactly one tool: `listening_streaks`,
  // which counts /me/player/recently-played history entries rather than
  // collection rows, carries no reported total, and shipped in v2.1.0 — so it
  // is a released wire-contract key that #1423 deliberately did not rename.
  // A new appearance of this name in a doc is the thing to look at.
  'items_read',
  // #1311: remove_unavailable_playlist_items' bounded-verdict fields. The
  // tool reports `verification: partial` over a walk that stopped at the cap
  // and names where the unread region starts, so a caller can tell a bounded
  // verdict from a real all-clear. structuredContent keys, like the three
  // above and on the same reasoning.
  'unread_from_position',
  // #809: create_smart_playlist documents the candidate-pool ceiling it now
  // reports. Both are structuredContent keys on that tool, not parameters and
  // not tools — the description is naming its own output, which is the point.
  'pool_capped', 'pool_cap',
  // #757: restore_library_snapshot documents the snapshot schema version it
  // refuses on. A key inside the file it reads, not a tool or parameter.
  'schema_version',
  // #708: the purpose + provenance record every write driven by stored Spotify
  // data publishes. `consent_note` is the sentence, the `source_*` keys are the
  // fields beside it, and `not_requested` is a value of `consent.state` — the
  // state a write is in when no prompt was issued. `exported_at` and
  // `taken_at` are the two other declared-date fields the record reads, named
  // so a caller knows which field of which file the date came from. All are
  // structuredContent keys or stored-file fields describing a call's own
  // result, not tools and not request parameters.
  'consent_note', 'source_kind', 'source_path', 'source_related_paths',
  'source_created', 'source_created_field', 'source_missing_date_reason',
  'source_items', 'not_requested', 'exported_at', 'taken_at',
  // #1006: the six per-entity stats.fm tools report the measured total
  // separately from the play sample read beside it, and SPEC.md names both so
  // a sample's span is never read as the entity's whole history. Every one is
  // a structuredContent key on those tools — the doc is describing what a call
  // reports about its own result, not routing to another tool.
  'sample_limit', 'sample_returned', 'sample_truncated', 'sample_oldest',
  'sample_newest', 'sample_unreadable_reason',
  // #730: the keys `statsfm_recent_streams` reports about the window it
  // applied. `range_resolved` echoes the applied UTC edges so a caller can
  // verify them; the counts separate what stats.fm returned from what the
  // window kept, so a filtered page is not read as a count for the period; and
  // the two page keys carry the observed span, because the route returns a
  // fixed unpaged recent page and a bucket wider than that page is a filter
  // rather than a measurement. Every one is a structuredContent key on that
  // tool — a call describing its own result, not a tool or a request parameter.
  'range_resolved', 'returned_before_window', 'returned_after_window',
  'excluded_by_window', 'unreadable_timestamps',
  'page_oldest', 'page_newest', 'page_may_not_cover_window',
  // #839: the local-sidecar corruption contract. SPEC.md and
  // docs/configuration.md now say what a caller gets when a sidecar exists but
  // cannot be read — the file and the parse failure, where the bytes were
  // preserved, and how many searches were dropped while it was unreadable.
  // All three are structuredContent keys on the reporting tool.
  'load_error', 'preserved_as', 'refused_writes',
  // StructuredContent keys the walk/disclosure work added and ARCHITECTURE.md
  // now names. Neither is a tool or a parameter; both are what a call reports
  // back about its own result.
  'fetch_all_cap', 'truncated_by_cap',
  // #697: list_backups reports the on-disk size and the age window of the
  // snapshots it found, so the retention prose in docs/configuration.md can
  // name them. StructuredContent keys on that tool — the doc is describing
  // the tool's own output, not routing to another tool.
  'dir_bytes', 'oldest_created', 'oldest_retention_until',
  // #725: the get_several_* tools publish a `degraded_reason` alongside
  // `degraded: true` so callers can tell a per-item round-trip apart from a
  // clean batch read. StructuredContent keys on every batch tool, not
  // parameters or tools — the README is naming what the tool returns.
  'degraded_reason',
  // #851: market_availability now reports Spotify's own per-market
  // `is_playable` and counts the markets that returned no such field, instead
  // of the deprecated `available_markets` (allowlisted above). SPEC.md §5.1
  // documents the three-valued contract, which is exactly why the doc has to
  // name these two — they are structuredContent keys describing a call's own
  // result, not parameters and not tools.
  'is_playable', 'playable_unknown_count', 'available_count', 'playable_count',
  // #865: the chunked-playlist-write partial-state contract. SPEC.md §5
  // names the fields so a caller can resume a failed multi-chunk write;
  // every one is a structuredContent key on the tool that reports it, not a
  // parameter and not a tool.
  'partial_write_failure', 'attempted_chunks', 'failed_chunk_index',
  'last_committed_chunk_index', 'last_committed_chunk_uris',
  'attempted_uris', 'committed_uris', 'remaining_uris',
  // #688: verify_receipt's structuredContent is the stored Receipt object
  // flattened alongside `found`, and `expect_present` is the field that tells a
  // re-render which direction the mutation went — a caller must be able to
  // branch on it rather than parse prose. A key the tool returns about its own
  // result, not a parameter.
  'expect_present',
  // #658: SPEC.md §5.11 documents the two undo tools, which until then had no
  // contract at all. Two kinds of name enter the doc and neither is a tool or a
  // parameter: the receipt KINDS the scan filters on (`playlist_items` and
  // `playlist_meta` are values of the stored receipt's `kind`, not tool names),
  // and the `reason` / structuredContent keys an undo returns about its own
  // result. `partial_write_failure`, `post_state_mismatch`,
  // `confirmation_unavailable`, `direction_assumed` and `snapshot_id` are
  // already known from #865 and #688 above.
  'playlist_items', 'playlist_meta',
  'unknown_receipt', 'not_reversible', 'no_uris', 'no_reversible',
  'occurrences_unrecorded',
  'undone_receipt', 'inverted_to', 'expected_absent', 'expected_present',
  'completed_requests', 'attempted_requests', 'unconfirmed_uris',
  'post_state_unverified',
  // #713: SPEC.md §5.11 documents the discovery trio's response_format, which
  // means naming the payload each mode serializes. These are the remaining
  // structuredContent keys of find_tool/inspect_tool/toolset_report, joining
  // registered_tools/active_modules/active_toolsets above.
  'total_registered', 'input_schema', 'read_only', 'module_schema_budgets',
  'registration_exclusions', 'batch_caps',
  // #903: balance_playlist_pairs caps its planned-move array at max_results
  // and discloses what the cap withheld, so SPEC.md can name those keys.
  // structuredContent keys on that tool, not tools and not parameters.
  'moves_total', 'moves_returned', 'moves_withheld', 'moves_truncated',
  // #807: taste_shift_report reports the size of each window it compared, so a
  // caller can tell "taste did not change" from "there was nothing to compare"
  // without parsing the prose. A StructuredContent key on that tool, not a
  // parameter — SPEC.md is describing the tool's own output.
  'window_sizes',
  // #781: every offset-paged read publishes the offset to continue from as
  // `pagination.next_offset` in structuredContent, which is the field SPEC.md's
  // shared paging-signal contract names. A key a tool returns about its own
  // page — not a parameter the caller sends, and not a tool.
  'next_offset',
  // #731: search_within_playlist gained a `kind` filter, which made the walk
  // behind it report its own coverage so a capped scan is distinguishable
  // from a narrow one. These are the structuredContent keys it returns about
  // its own result — not tools, and not parameters of anything.
  'scanned_items', 'scan_truncated', 'items_of_unknown_kind',
  // #783: the radar scans report the width their fan-out actually ran at, and
  // which knob supplied it — the request funnel's SPOTIFY_MCP_MAX_CONCURRENCY
  // or this work's own fallback — so docs/configuration.md can name the
  // tunable and its precedence. structuredContent keys describing the tool's
  // own result, not tools and not parameters.
  'fanout_concurrency', 'fanout_concurrency_source',
  // #898: playlist_expression_algebra and playlist_fill_from_search both walk
  // source playlists under SPOTIFY_MCP_FETCH_ALL_CAP and both turn what they
  // read into a write, so each reports whether its reads were whole. The
  // algebra names the clipped refs and the per-ref counts; the fill names its
  // own pre-read and refuses to state a resulting length off a clipped one.
  // structuredContent keys naming a tool's own result, not tools and not
  // parameters.
  'truncated_refs', 'ref_scans', 'existing_truncated', 'existing_scanned',
  'existing_total', 'existing_truncated_by_cap', 'now_total',
  // #899: the bounded playlist lists report what their bound actually bought.
  // SPEC.md names both keys so a caller can see the read cost of a call
  // instead of inferring it from the row count. structuredContent keys on the
  // tools that report them, not tools and not parameters.
  'requests_read', 'search_requests_read',
  // #1225: queue_playlist says which read produced the list it queued —
  // `top_tracks` or the `albums` fallback that runs when the app registration
  // is gated off the top-tracks path. A structuredContent key and its enum
  // members, naming the tool's own result, not a tool and not a parameter.
  'resolved_via', 'top_tracks',
  // #900: the five tools that probe one artist's newest release report the
  // probe fan-out split three ways — probes asked for, probes the read cache
  // answered, probes that reached the API — so SPEC.md can name what the
  // shared canonical request cost. structuredContent keys on those tools, not
  // tools and not parameters.
  'artist_probes', 'artist_probe_cache_hits', 'artist_probe_requests',
  // #1224: the per-id fan-in replaced a removed `?ids=` batch read with one
  // `GET /{type}/{id}` per id, so these tools report the request count they
  // really issued and the ids whose read failed, with a reason. Every name
  // below is a structuredContent key a tool returns about its own result —
  // none is a tool, and none is a parameter a caller sends. `batch_requests`
  // and `batch_size` are the two `library_hygiene.album_lookups` keys the
  // migration REMOVED; SPEC.md names them so a reader of the old contract can
  // see what replaced them.
  'album_requests', 'artist_requests', 'track_unresolved', 'album_unresolved',
  'artist_unresolved', 'album_lookups', 'request_mode', 'fanout_width',
  'estimated_album_requests', 'batch_requests', 'batch_size',
  // The third `ReceiptKind` member (src/receipts.ts), named by
  // docs/cookbook.md's undo section to say which receipts `undo_mutation`
  // refuses. It is a value the `kind` field of a receipt takes, not a tool
  // and not a parameter a caller sends. The other two kinds need no entry only
  // because no scanned doc happens to backtick them.
  'playlist_meta',
  // #606: three keys the new CLI subcommands publish, which docs/cli.md names
  // so a reader knows what the output fields mean. None is a tool and none is
  // a parameter a caller sends.
  //
  //   - `registration_key` is a field of `spotify-mcp tools --json`, read off
  //     REGISTRAR_MANIFEST rather than off the wire. It is named in the doc
  //     precisely to say that, so a reader does not go looking for a wire field
  //     carrying it.
  //   - `change_detection` is the field `spotify-mcp watch` uses to report how
  //     it decided a poll had changed (`etag` / `mixed` / `payload-diff`). It
  //     is a MEASUREMENT the loop reports about its own polls, which is the
  //     whole point of naming it: a target that carries no revalidation signal
  //     must say so rather than default to a plausible answer.
  //   - `fetch_truncated` is a structuredContent key `export_playlist` and
  //     `export_library_json` already publish; the CLI surfaces it verbatim so a
  //     capped export cannot read as a complete backup.
  'registration_key', 'change_detection', 'fetch_truncated',
]);
/** Registration keys are module names, not tools; docs legitimately name them. */
const registrationKeyNames = new Set(census.registrationKeyNames ?? []);
/**
 * Tool names this release RETIRED. A migration note has to be able to name what
 * it replaces; every other retired name still fails the gate, so this cannot
 * become a graveyard.
 *
 * #638 removed the six tools whose only implementation was an endpoint Spotify
 * deleted in February 2026. The allowlist entry is what lets the migration
 * table in SPEC.md/AGENTS.md name each retired tool and its replacement; it
 * does NOT stop the gate from rejecting any *other* unbackticked name, and it
 * does not make the name callable again.
 */
const retiredToolNames = new Set([
  'get_show_episodes',
  // #638 — write half, per-type `/me/{type}s` removed; unified replacement.
  'save_items',
  'remove_saved_items',
  // #638 — read half, per-type `/me/{type}s/contains` removed; unified read.
  'check_saved_items',
  // #638 — `PUT`/`DELETE /me/following?type=artist` removed with NO replacement
  // (the library write endpoint does not accept `spotify:artist:` URIs).
  'follow_artists',
  'unfollow_artists',
  // #638 — `GET /browse/categories*` removed with no replacement; the browse
  // category tree is no longer served by any endpoint.
  'get_categories',
  'get_category_playlists',
  // #908 — the eight legacy `taste_*` registrations. Each is a duplicate row of
  // the `statsfm_*` tool it shadowed, same params and same handler; they are no
  // longer advertised and resolve only through SPOTIFY_MCP_LEGACY_ALIASES=1.
  // A migration table still has to be able to NAME what it replaced, which is
  // the whole point of the table, so these are handled like the retired names
  // above rather than as typos.
  'taste_profile',
  'artist_affinity',
  'exposure_check',
  'listening_eras',
  'listening_sessions',
  'forgotten_favorites',
  'taste_recommendations',
  'record_feedback',
  // #848 — the transfer and volume tool families, collapsed onto one tool each.
  // Each name still FORWARDS to its survivor with the flags its behaviour
  // needed (`handoff` → `transfer_playback` with `preserve_position: true`), so
  // a migration table can name what it replaced; the names are simply not
  // registered any more, which is what this list records.
  'handoff',
  'switch_device',
  'transfer_playback_with_state',
  'volume_step',
  'mute',
  'unmute',
  'room_level',
  'apply_device_presets',
  'apply_volume_plan',
  'plan_volume_level_across_devices',
  // #847 — the six queue-read registrations collapsed into `get_queue` and
  // `peek_next`. Unlike the eight above, these are NOT rewritten by
  // SPOTIFY_MCP_LEGACY_ALIASES: the survivors take arguments the retired
  // tools did not, so a name-only rewrite would answer a different question.
  // A caller gets a typed `retired_tool_alias` refusal naming the exact
  // replacement call, and a migration table still has to be able to NAME what
  // it replaced.
  'describe_queue',
  'get_queue_snapshot',
  'queue_runtime_report',
  'queue_duplicate_check',
  'queue_profile',
  'predict_next_tracks',
]);
/**
 * #1287 — parameter names this server published under a deprecation notice and
 * withdrew in v3.0. A migration table has to be able to NAME what it replaced,
 * which is the whole point of the doc, so these are treated like the retired
 * TOOL names above rather than as typos: a doc may mention one only where it is
 * talking about the removal. They are not parameters any tool accepts, and
 * `census.parameterNames` no longer carries them, so without this entry every
 * honest migration note fails the gate and the only way through would be to
 * delete the migration table.
 */
const retiredParameterNames = new Set([
  'playlist_ids', 'source_playlist_ids', 'subtract_playlist_ids', 'sources',
  'playlist_id_a', 'playlist_id_b', 'playlist_a_id', 'playlist_b_id',
]);
const documentedMetadata = new Set([
  // #848 removed the last tool that took a `device_name` argument, so
  // `census.parameterNames` stopped carrying the name and SPEC.md's playback-
  // position record table (#846) started failing this gate on a field that is
  // still perfectly real. It belongs here rather than in `parameterAllowlist`:
  // that set is fed by the live registry on purpose, so a name added to it
  // would claim a tool accepts it. This one is a documented FIELD of a payload,
  // which is what this set is for.
  'device_name',
  'toolset_trimmed', 'scope_filtered', 'read_only_hidden',
  'deprecated_inputs', 'deprecation_note', 'auth', 'forbidden', 'not_found',
  'rate_limited', 'unavailable', 'statsfm_resource_not_found', 'conflict',
  'unknown_param', 'unknown_tool', 'playlist_changed_since_read',
  // #1100: the confirmation-refusal `reason` discriminators documented in
  // SPEC.md. `declined` needs no entry — SPEC states that field is ABSENT for
  // that verdict, so there is nothing to backtick. These two name the refusal
  // shape a host parses, not a tool, a parameter, or a metadata key.
  'elicitation_failed', 'confirmation_unavailable',
  // #1287: the `reason` a refusal carries when a call sends a playlist input
  // spelling this server published under a deprecation notice and withdrew in
  // v3.0. A host routing on `kind` sees `validation`; this is the discriminator
  // that separates "we never had that name" (unknown_param) from "we did, and
  // we took it away". It is a refusal shape, not a tool or a parameter.
  'retired_input',
  // #1318: the `reason` a refusal carries when a stats.fm identity arrives
  // under both spellings with different values. Same category as
  // `retired_input` — a refusal shape a host parses, not a tool, a parameter
  // or a metadata key. `kind` is already `validation`; this separates "you
  // sent one field twice and it did not match" from any other validation
  // failure, which is exactly the routing decision a host cannot make from
  // prose alone.
  'conflicting_input',
  // #896: `quota_hit_at_playlist` is the key a paged scan reports to say WHICH
  // playlist a mid-walk 429 stopped it at, so a caller can tell a partial
  // result from a complete one. It is a structuredContent key, not a tool and
  // not a parameter — `saved_vs_playlist_coverage` has returned it since #732
  // and `playlist_staleness_report` now does too.
  'quota_hit_at_playlist',
  // #897: the two Spotify album fields the §5.3 `library_hygiene` contract has
  // to name, because the whole point of the change is WHERE they come from —
  // `album_type` and `total_tracks` are required members of the API's
  // `AlbumBase`, so every `/me/tracks` row already carries them and the
  // contract says the walk supplies them rather than a per-id read. They are
  // response fields, not parameters. `shared_from_walk` is the
  // `album_lookups` key that says how many groups the walk answered, so a
  // caller can tell a complete zero-request run from a scan that found
  // nothing — same category as `quota_hit_at_playlist` above.
  'album_type', 'total_tracks', 'shared_from_walk',
  // #604: the `spotify://me/genre-heatmap` coverage contract. The heatmap
  // reports the source it read and how much of that source it could actually
  // read, so these are the JSON keys a doc must name to describe the payload:
  // the two `source` values it can emit, the window it reads, and the counts
  // separating rows read from rows excluded as unreadable. None is a tool or a
  // parameter.
  'top_artists_sample', 'medium_term',
  'artists_counted', 'artists_with_genres',
  'artists_unreadable', 'unreadable_artists',
  // #604: the sidecar the heatmap description used to claim and never read.
  // Named here only so the contract can state the claim was removed; it is
  // neither a tool nor a parameter, and no code path produces this sidecar.
  'followed_artists',
]);
/**
 * Range vocabulary (#720). The JSON-example check already rejects a bad
 * `range` value inside a ```json fence, but the ranges *reference* is prose:
 * docs/statsfm.md told taste-tool callers to pass `week`/`month` while the
 * endpoint tools enforced `weeks`/`months`, and stats.fm itself answers
 * `400 invalid range` for the singular spellings. Prose is where this drift
 * actually lived, so prose is what gets checked.
 *
 * The accepted set is read from the production schemas rather than declared
 * here, so this check cannot drift from the registry it is meant to police.
 *
 * `year` is deliberately absent from the candidate set: `statsfm_recaps`
 * takes an optional calendar `year`, so treating it as a range literal would
 * flag a correct sentence about a different parameter.
 */
const RANGE_CANDIDATES = new Set([
  'today', 'day', 'days', 'week', 'weeks', 'month', 'months',
  '6month', '6months', 'all-time', 'all_time', 'alltime',
]);

/** A line that says these values are *rejected* is not documenting them. */
const RANGE_REJECTION = /\b400\b|\brejects?\b|rejected\b|not\s+accepted|\bnot\s+valid\b|\binvalid\b/i;

/**
 * A documented numeric range, in any of the three dashes the docs use for it.
 * Declared up here with the other patterns because the checks below it run
 * during module evaluation, before a `const` further down the file would have
 * been initialized.
 */
const DOCUMENTED_RANGE = /\b(\d+)\s*[–—-]\s*(\d+)\b/g;

/**
 * A documented CEILING in any of the spellings the docs use for one. Only the
 * upper number is captured, because only the upper number is comparable to a
 * schema's `maximum`/`maxItems`; a `max 40` is the same claim as a `1–40`
 * whose floor the schema states elsewhere.
 */
const DOCUMENTED_CEILING = /\b(?:max|maximum|cap|capped at|capped|at most|up to|no more than)\s+(\d+)\b/gi;

/**
 * #1476 — the two claims a document makes about a contract the code owns, and
 * the two this gate now compares rather than trusting.
 *
 * Both defects in #1476 were the same shape as a #929 field: a document that
 * named everything correctly and then stated a value the code contradicts. The
 * difference is only WHERE the value lives, and that is what made them survive
 * — neither is a tool name, an argument name, or a row in an Inputs table, so
 * nothing in this script was reading them.
 *
 *  - A shared-contract bullet (`` - **`field`** (`'a' | 'b'`, default `'a'`)
 *    — ... ``) states an enum the whole surface accepts. It is not attributed
 *    to one tool, so `checkDocumentedFieldConstraints` — which needs a tool
 *    heading to have a schema to compare against — cannot see it. SPEC.md
 *    spelled `response_format`'s first member `reconcile` against a schema
 *    whose members are `concise` / `detailed` / `json`, and every tool
 *    carrying that field was green.
 *  - A document that backticks a LIVE constant and then states its value is
 *    asserting a number about code. SPEC.md stated the aggregate ceiling as
 *    620,000B against `TOOL_SURFACE_BUDGET.defaultMaxBytes` of 611,000 —
 *    9,000B of headroom that does not exist, in the direction that matters,
 *    because the reader trusts the larger number. The census already measures
 *    both constants and renders them into a generated table nobody edits by
 *    hand, so the honest check is to compare the prose against that
 *    measurement rather than to let the prose stand.
 *
 * Each is narrow about what it can PROVE, for the reason the header on
 * `checkDocumentedFieldConstraints` gives: a gate that guesses is a gate that
 * gets switched off.
 *
 *  - The enum arm fires only where at least one live input schema declares the
 *    named field AS AN ENUM, and only when no live variant declares exactly
 *    the documented members. A field the schemas do not type as an enum is not
 *    checked at all — there is nothing to compare against, and inferring one
 *    would make the gate a liar. Where a field has SEVERAL live variants
 *    (`kind` has five, `mode` six), matching ANY one of them passes: the
 *    document describes the contract, not every tool that happens to reuse
 *    the name, and demanding the intersection would fail on a correct line.
 *  - The constant arm fires only when the figure sits immediately after the
 *    backticked constant name and before the sentence ends. Anything further
 *    away is a comparison ("about a tenth of the ceiling"), not a restatement,
 *    and reading it as one produces false positives rather than catching
 *    drift. The unit must be written out — `611,000B` — so an unrelated
 *    number in the same clause cannot be captured.
 */
const SHARED_CONTRACT_ENUM = /\*\*`([a-z][a-z0-9_]*)`\*\*\s*\(\s*`((?:'[^']+'\s*\|\s*)*'[^']+')`\s*(?:,\s*default\s*`('[^']+')`)?\s*\)/g;
const DOCUMENTED_CONSTANT_FIGURE_SUFFIX = 'B';

/** Every distinct enum shape the live schemas declare for `field`. */
function liveEnumVariants(registry, field) {
  const variants = [];
  for (const schema of Object.values(registry.toolInputSchemas ?? {})) {
    const property = schema?.properties?.[field];
    if (!property || !Array.isArray(property.enum)) continue;
    const key = JSON.stringify([property.enum, property.default]);
    if (!variants.some((variant) => variant.key === key)) {
      variants.push({ key, values: property.enum, default: property.default });
    }
  }
  return variants;
}

function checkSharedContractEnums(file, source, registry = census) {
  for (const match of source.matchAll(SHARED_CONTRACT_ENUM)) {
    const at = `${relative(ROOT, file)}:${lineAt(source, match.index)}`;
    const field = match[1];
    const documented = match[2].split('|').map((member) => member.trim().replace(/'/g, ''));
    const documentedDefault = match[3]?.replace(/'/g, '');
    const variants = liveEnumVariants(registry, field);
    // No live schema types this field as an enum, so there is nothing this
    // gate can prove the documented list wrong against. Skipped rather than
    // guessed: the sentence may be describing a response value, a report row
    // key, or something the schemas do not type at all.
    if (variants.length === 0) continue;
    const sameMembers = variants.filter((variant) => variant.values.length === documented.length
      && variant.values.every((value, index) => value === documented[index]));
    if (sameMembers.length === 0) {
      const live = variants.map((variant) => `\`${variant.values.join(' | ')}\``).join(' / ');
      errors.push(`${at}: shared contract documents \`${field}\` as \`${documented.join(' | ')}\`, but no live input schema declares those members — they are ${live}. A caller copying the documented list is rejected at validation.`);
      continue;
    }
    // The members are right, so the default is the only claim left that can
    // be wrong. Checked only where a live variant STATES a default, for the
    // reason `checkDocumentedDefault` gives: a field defaulted in the handler
    // body has no schema default, and inferring one would be a guess.
    if (documentedDefault === undefined) continue;
    if (sameMembers.some((variant) => variant.default === documentedDefault)) continue;
    const liveDefaults = [...new Set(sameMembers.map((variant) => variant.default).filter((value) => value !== undefined))];
    if (liveDefaults.length === 0) continue;
    errors.push(`${at}: shared contract documents \`${field}\` as defaulting to \`${documentedDefault}\`, but the live schema${liveDefaults.length === 1 ? '' : 's'} default${liveDefaults.length === 1 ? 's' : ''} to ${liveDefaults.map((value) => `\`${value}\``).join(' / ')} — a caller who omits the field gets the other one.`);
  }
}

/**
 * Live constants a document may name alongside a figure.
 *
 * The value is read from the census, not from `src/tools/annotations.ts`, so
 * the comparison is against the same measurement the generated budget tables
 * render — a hand-copied second read of the constant would be exactly the
 * thing this check exists to prevent.
 */
function documentedConstants(registry = census) {
  const aggregate = registry.aggregateSurface;
  if (!aggregate) return [];
  return [
    {
      label: 'TOOL_SURFACE_BUDGET.defaultMaxBytes',
      names: ['TOOL_SURFACE_BUDGET.defaultMaxBytes'],
      live: aggregate.maxCeilingBytes,
    },
    {
      label: 'AGGREGATE_SURFACE_LIMITS.maxBytes',
      names: ['AGGREGATE_SURFACE_LIMITS.maxBytes'],
      live: aggregate.maxEnforcedBytes,
    },
    {
      label: 'MAX_RESPONSE_BYTES',
      names: ['MAX_RESPONSE_BYTES'],
      live: aggregate.responseCapBytes,
    },
  ].filter((entry) => typeof entry.live === 'number');
}

function checkDocumentedConstantFigures(file, source, registry = census) {
  for (const constant of documentedConstants(registry)) {
    // The figure must belong to THIS constant: the gap between the name and
    // the number may not cross a sentence end, so a number attributed to the
    // next clause cannot be read as this one's value.
    const pattern = new RegExp(
      `\`${constant.names.map((name) => name.replace(/\./g, '\\.')).join('|\`|\`')}\`[^.\\n]{0,40}?([0-9][0-9,]*)\\s*${DOCUMENTED_CONSTANT_FIGURE_SUFFIX}\\b`,
      'g',
    );
    for (const match of source.matchAll(pattern)) {
      const at = `${relative(ROOT, file)}:${lineAt(source, match.index)}`;
      const documented = Number(match[1].replace(/,/g, ''));
      if (documented === constant.live) continue;
      errors.push(`${at}: documents \`${constant.label}\` as ${documented.toLocaleString('en-US')}B, but the live constant is ${constant.live.toLocaleString('en-US')}B — a reader sizing against the document is wrong by ${Math.abs(documented - constant.live).toLocaleString('en-US')}B.`);
    }
  }
}

/**
 * The verbs that introduce a recipe step. `call` and `preview` are the two
 * the docs actually use — the write half of every recipe is `preview <tool>
 * with ...` — and a matcher that only saw the literal word "Call" left every
 * preview step unchecked, so a bogus key in one passed silently (#928).
 *
 * The list is deliberately short. A wider one reads ordinary prose: the
 * feature-sweep skill says "confirm the request budget with the human", where
 * `request` is a noun, `budget` is not a tool, and the sentence is an
 * instruction to a human. Widening the verb list without a way to tell a
 * recipe step from a sentence puts that class of false positive straight back
 * into the gate, which is worse than the gap it closes.
 */
const RECIPE_VERB = /^(?:call|preview)$/;

const markdownFiles = [
  'README.md',
  'SPEC.md',
  'ARCHITECTURE.md',
  ...walk(join(ROOT, 'docs')),
  ...walk(join(ROOT, 'skills')),
].filter((file) => file.endsWith('.md')).sort();
const errors = [];

function checkDocumentToolContracts(source, file, registry = census) {
  return collectDocumentToolContractErrors(source, file, registry);
}

if (process.argv.includes('--check-fixture')) {
  const fixturePath = process.argv[process.argv.indexOf('--check-fixture') + 1];
  const found = checkDocumentToolContracts(readFileSync(resolve(fixturePath), 'utf8'), fixturePath, census);
  for (const error of found) console.error(error);
  process.exit(found.length > 0 ? 1 : 0);
}

for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8');
  const found = checkDocumentToolContracts(source, file);
  for (const error of found) errors.push(error);
}

if (errors.length > 0) {
  console.error(`Documentation tool contract check failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n${unique(errors).map((line) => `- ${line}`).join('\n')}`);
  console.error('Use a finalized production tool and only arguments declared by that tool’s production inputSchema.');
  process.exitCode = 1;
} else {
  console.log(`Documentation tool contracts match the finalized production registry (${tools.size} tools and schemas checked).`);
}

function collectDocumentToolContractErrors(source, file, registry) {
  const found = [];
  const collect = (error) => found.push(error);
  const originalPush = errors.push;
  errors.push = collect;
  try {
    checkBacktickToolNames(file, source, registry);
    checkJsonToolExamples(file, source, registry);
    checkCallRecipes(file, source, registry);
    checkToolArgumentTables(file, source, registry);
    checkInputsTableContracts(file, source, registry);
    checkModuleMapEntries(file, source, registry);
    checkRangeEnumLiterals(file, source, registry);
    checkDocumentedFieldConstraints(file, source, registry);
    checkSharedContractEnums(file, source, registry);
    checkDocumentedConstantFigures(file, source, registry);
  } finally {
    errors.push = originalPush;
  }
  return unique(found);
}

function checkBacktickToolNames(file, source, registry = census) {
  const knownTools = new Set(registry.toolNames);
  const knownNonTools = new Set([...registry.promptNames, ...registry.resourceUris, ...parameterAllowlist, ...documentedMetadata, ...(registry.registrationKeyNames ?? registrationKeyNames), ...retiredToolNames, ...retiredParameterNames, ...gatedToolNames(registry)]);
  for (const match of source.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    const name = match[1];
    if (knownTools.has(name) || knownNonTools.has(name)) continue;
    errors.push(`${relative(ROOT, file)}:${lineAt(source, match.index)}: undocumented snake_case tool reference \`${name}\``);
  }
}

function productionRangeEnum(registry) {
  const values = new Set();
  for (const schema of Object.values(registry.toolInputSchemas ?? {})) {
    const range = schema?.properties?.range;
    if (range && Array.isArray(range.enum)) for (const value of range.enum) values.add(value);
  }
  return values;
}

function checkRangeEnumLiterals(file, source, registry = census) {
  const accepted = productionRangeEnum(registry);
  if (accepted.size === 0) return;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\brange\b/i.test(lines[index]) || RANGE_REJECTION.test(lines[index])) continue;
    for (const match of lines[index].matchAll(/`([^`\n]+)`/g)) {
      const literal = match[1].trim().toLowerCase();
      if (!RANGE_CANDIDATES.has(literal) || accepted.has(literal)) continue;
      errors.push(`${relative(ROOT, file)}:${index + 1}: documented range value \`${match[1]}\` is not one of the production range enum (${[...accepted].sort().join(', ')})`);
    }
  }
}

/**
 * #929 — the three claims a caller reads off an Inputs table and acts on.
 *
 * A documented field can be named correctly and still be wrong in a way that
 * only fails at the call: a range wider than the schema clamps, an enum member
 * the schema never accepts, a default that contradicts the schema's own. Each
 * of the name-shaped checks above passes on exactly those rows, because the
 * field name, the tool name and the argument all agree — only the constraint
 * the doc asserts about them is stale.
 *
 * Claims are attributed per FIELD, not per line, which is what makes the prose
 * half of this check safe. A table row describes one field, so its Description
 * cell is checked whole. A prose `**Inputs:**` line describes several, so it is
 * split at each backticked field name and each segment is checked only against
 * the field that opens it — otherwise `get_playlist`'s `1–100` is attributed to
 * `fetch_all` two clauses later and every table in the repo fails.
 *
 * Each class is deliberately narrow about what it can PROVE, because a gate
 * that guesses is a gate that gets switched off:
 *
 *  - Ranges are only read as `A–B` / `A-B` / `A—B` pairs or as a stated
 *    ceiling (`max 40`, `at most 10`, `cap 200`), and only compared against a
 *    schema that states `minimum`/`maximum` (or `minItems`/`maxItems` for an
 *    array). No inference, no "about N". Both spellings are read because all
 *    of them are in the docs, and reading only the pair form let a planted
 *    `max 400` against a `maxItems` of 40 through.
 *  - Defaults are only compared when the schema states a `default` of its own.
 *    A field with no schema `default` is defaulted in the handler body, which
 *    this gate cannot read, so a documented default for one is left alone
 *    rather than guessed at.
 *  - Enum members are only read out of a Type column, and only for a property
 *    the schema really declares as an enum. A cell that says `string` beside
 *    an enum-typed property is not a claim about the members, so it is not
 *    failed here — `checkInputsTableContracts` owns the shape questions.
 */
function checkDocumentedFieldConstraints(file, source, registry = census) {
  const lines = source.split('\n');
  let tool = null;
  let inInputs = false;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^#{2,4}\s+`([a-z][a-z0-9_]*)`?/.exec(lines[index]);
    if (heading) {
      tool = registry.toolNames.includes(heading[1]) ? heading[1] : null;
      inInputs = false;
      continue;
    }
    // Any other heading ends the tool section. A prose section (`### 5.2
    // Search`) is not a tool contract and must not inherit the previous
    // tool's schema, or every claim beneath it is checked against the wrong
    // tool.
    if (/^#{1,6}\s/.test(lines[index])) { tool = null; inInputs = false; continue; }
    // `inInputs` is set and the line FALLS THROUGH rather than continuing: a
    // prose Inputs block puts its claims on this very line
    // (``**Inputs:** `limit` (1–50, default 20), `offset` ``), and skipping
    // it is how a wrong range in prose stays green while the same claim in a
    // table fails two sections later. A table's `**Inputs:**` line carries no
    // claims of its own, so falling through costs nothing there.
    if (/^\*\*Inputs:\*\*/.test(lines[index])) inInputs = true;
    if (/^\*\*(?:Returns|Notes|Output):\*\*/.test(lines[index])) { inInputs = false; continue; }
    if (!tool || !inInputs) continue;
    const properties = registry.toolInputSchemas?.[tool]?.properties;
    if (!properties || typeof properties !== 'object') continue;
    const at = relative(ROOT, file);
    const line = lines[index];

    // A table row: `| \`field\` | type | required | description |`. The
    // Description cell is that field's and no other field's, so the enum
    // column is compared whole and the description is scanned whole.
    const row = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/.exec(line);
    if (row) {
      const field = row[1];
      const property = properties[field];
      if (!property) continue;
      const cells = line.split(/(?<!\\)\|/).slice(1);
      const typeCell = (cells[1] ?? '').trim().replace(/\\\|/g, '|');
      const description = cells.slice(3).join('|').trim();
      checkDocumentedRange(at, index + 1, tool, field, property, description);
      checkDocumentedDefault(at, index + 1, tool, field, property, description);
      checkDocumentedEnumMembers(at, index + 1, tool, field, property, typeCell);
      continue;
    }

    // Prose: split at each backticked field name so a claim is only ever
    // compared against the field whose name opens its clause.
    for (const [field, claim] of clausesOfFieldClaims(properties, line)) {
      const property = properties[field];
      checkDocumentedRange(at, index + 1, tool, field, property, claim);
      checkDocumentedDefault(at, index + 1, tool, field, property, claim);
    }
  }
}

/**
 * Split a prose line into `[field, text belonging to that field]` pairs. A
 * segment runs from one backticked field name to the next, so a range written
 * about `limit` is never read as a claim about the `market` that follows it.
 */
function clausesOfFieldClaims(properties, line) {
  const marks = [...line.matchAll(/`([a-z][a-z0-9_]*)`/g)];
  const out = [];
  for (let i = 0; i < marks.length; i += 1) {
    const field = marks[i][1];
    if (!Object.hasOwn(properties, field)) continue;
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : line.length;
    out.push([field, line.slice(start, end)]);
  }
  return out;
}

/**
 * The inclusive bounds the schema states, as `null` for a bound it does not
 * state. An array's bounds are `minItems`/`maxItems`; a number's are
 * `minimum`/`maximum`, or the nearest integer either side of an exclusive
 * bound, since a document states inclusive numbers.
 */
function statedBounds(property) {
  if (property.type === 'array') {
    return {
      minimum: typeof property.minItems === 'number' ? property.minItems : null,
      maximum: typeof property.maxItems === 'number' ? property.maxItems : null,
    };
  }
  return {
    minimum: typeof property.minimum === 'number'
      ? property.minimum
      : typeof property.exclusiveMinimum === 'number' ? property.exclusiveMinimum + 1 : null,
    maximum: typeof property.maximum === 'number'
      ? property.maximum
      : typeof property.exclusiveMaximum === 'number' ? property.exclusiveMaximum - 1 : null,
  };
}

function checkDocumentedRange(at, line, tool, field, property, text) {
  if (!property || typeof property !== 'object' || !text) return;
  const bounds = statedBounds(property);
  if (bounds.maximum === null) return;
  // A ceiling is not only ever written as a pair. `max 40`, `at most 10` and
  // `cap 200` are the same claim in three spellings, and all three appear in
  // the docs — reading only the pair form let `save_to_library.uris` be
  // documented `max 40` against a `maxItems` of 40 and still let a planted
  // `max 400` through, which is a gate that cannot fail.
  for (const match of text.matchAll(DOCUMENTED_CEILING)) {
    const claimed = Number(match[1]);
    if (claimed > bounds.maximum) {
      errors.push(`${at}:${line}: \`${tool}\`.\`${field}\` documents "${match[0].trim()}" but the live schema caps it at ${bounds.maximum} — a caller copying the doc is rejected.`);
    }
  }
  if (bounds.minimum === null && bounds.maximum === null) return;
  for (const match of text.matchAll(DOCUMENTED_RANGE)) {
    const documentedMin = Number(match[1]);
    const documentedMax = Number(match[2]);
    // A document may legitimately describe a SUBSET of what the schema
    // accepts; what it may not do is promise more than the schema clamps, or
    // understate a floor the schema enforces. Compare in the direction that
    // breaks a call.
    if (bounds.maximum !== null && documentedMax > bounds.maximum) {
      errors.push(`${at}:${line}: \`${tool}\`.\`${field}\` is documented as \`${match[0]}\`, but the live schema caps it at ${bounds.maximum} — a caller copying the doc is rejected.`);
    }
    if (bounds.minimum !== null && documentedMin < bounds.minimum) {
      errors.push(`${at}:${line}: \`${tool}\`.\`${field}\` is documented as \`${match[0]}\`, but the live schema requires at least ${bounds.minimum} — a caller copying the doc is rejected.`);
    }
  }
}

/**
 * A documented default is compared only against a schema that STATES one.
 * Most paging fields default in the handler body (`args.limit ?? 20`) and
 * declare no `default`, and the schema is the only source this gate reads, so
 * those are deliberately not guessed at. Where the schema does state a
 * default, that is the same fact the doc is asserting, and disagreement is
 * drift.
 */
function checkDocumentedDefault(at, line, tool, field, property, text) {
  if (!property || typeof property !== 'object' || !text) return;
  if (property.default === undefined) return;
  if (property.type !== 'number' && property.type !== 'integer' && property.type !== 'string') return;
  for (const match of text.matchAll(/[Dd]efaults?\s*:?\s*`?(-?\d+)`?/g)) {
    const documented = Number(match[1]);
    if (property.default !== documented) {
      errors.push(`${at}:${line}: \`${tool}\`.\`${field}\` documents default ${documented} but the live schema declares ${JSON.stringify(property.default)}.`);
    }
  }
}

/**
 * Enum members named in a Type column. Only cells that actually list quoted
 * members are read, and only against a property the schema declares as an
 * enum — a cell reading `string` next to an enum-typed property makes no claim
 * about which members are legal, so it is not this check's business.
 */
function checkDocumentedEnumMembers(at, line, tool, field, property, typeCell) {
  if (!Array.isArray(property?.enum)) return;
  const listed = [...typeCell.matchAll(/[`'"]([a-z0-9_-]+)[`'"]/g)].map((match) => match[1]);
  if (listed.length === 0) return;
  const rejected = listed.filter((value) => !property.enum.includes(value));
  if (rejected.length === 0) return;
  errors.push(`${at}:${line}: \`${tool}\`.\`${field}\` documents enum member${rejected.length === 1 ? '' : 's'} ${rejected.map((value) => `\`${value}\``).join(', ')}, which the live schema does not accept (it accepts ${property.enum.map((value) => `\`${value}\``).join(', ')}).`);
}

/**
 * Module maps (`playlists.ts  # get_playlist, add_to_playlist, …`) are tool
 * contracts too: the tree in SPEC.md §11 listed four tools that no longer
 * exist, and every other matcher missed it because the names appear neither
 * in backticks nor in a json fence nor in an Inputs table.
 */function checkModuleMapEntries(file, source, registry = census) {
  const knownTools = new Set(registry.toolNames);
  const knownNonTools = new Set([...registry.promptNames, ...registry.resourceUris, ...parameterAllowlist, ...documentedMetadata, ...(registry.registrationKeyNames ?? registrationKeyNames), ...retiredToolNames, ...retiredParameterNames, ...gatedToolNames(registry)]);
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const entry = /^\s*(?:[│|├└─\s])*([a-z0-9_]+\.ts)\s+#\s*(.+?)\s*$/.exec(lines[index]);
    if (!entry) continue;
    for (const name of entry[2].match(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g) ?? []) {
      if (knownTools.has(name) || knownNonTools.has(name)) continue;
      errors.push(`${relative(ROOT, file)}:${index + 1}: module map for ${entry[1]} names unknown tool \`${name}\``);
    }
  }
}

function checkJsonToolExamples(file, source, registry = census) {
  for (const match of source.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    let value;
    try {
      value = JSON.parse(match[1]);
    } catch (error) {
      if (!/['\"]tool['\"]\s*:/.test(match[1])) continue;
      errors.push(`${relative(ROOT, file)}:${lineAt(source, match.index)}: invalid JSON tool example (${error instanceof Error ? error.message : error})`);
      continue;
    }
    visitJsonToolExamples(value, file, lineAt(source, match.index), registry);
  }
}

function visitJsonToolExamples(value, file, line, registry) {
  if (Array.isArray(value)) {
    for (const entry of value) visitJsonToolExamples(entry, file, line, registry);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.tool === 'string') validateToolArguments(file, line, value, registry);
  for (const entry of Object.values(value)) visitJsonToolExamples(entry, file, line, registry);
}

/**
 * A schema node is a union when it lists `anyOf`/`oneOf`; each branch is
 * checked and the value is accepted if any branch accepts it. `whats_new`'s
 * `since` is exactly this shape (`const: 'last-check'` OR an ISO-date
 * pattern), which is why `last Monday` is a value no branch accepts.
 */
function schemaAcceptsValue(value, schema) {
  if (!schema || typeof schema !== 'object') return true;
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    return (schema.anyOf ?? schema.oneOf).some((branch) => schemaAcceptsValue(value, branch));
  }
  if ('const' in schema) return value === schema.const;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (typeof schema.pattern === 'string' && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) return false;
  }
  return true;
}

/**
 * A backticked value that parses as a JSON literal is a claim about the
 * schema, so it is checked; prose (``the `uris` array``) is not a literal and
 * is left alone.
 */
function parseRecipeValue(raw) {
  const text = raw.trim().replace(/,\s*$/, '');
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (/^["[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  return undefined; // prose, a placeholder fragment, or a bare identifier
}

function validateArgumentValues(file, line, tool, entries, registry) {
  const properties = registry.toolInputSchemas?.[tool]?.properties;
  if (!properties || typeof properties !== 'object') return;
  for (const [key, value] of entries) {
    const property = properties[key];
    if (!property) continue; // an unknown key is validateArgumentKeys' report
    if (value === undefined) continue; // a bare `key` with no value is prose
    if (schemaAcceptsValue(value, property)) continue;
    errors.push(`${relative(ROOT, file)}:${line}: \`${tool}\` recipe passes \`${key}: ${JSON.stringify(value)}\`, which the live inputSchema does not accept`);
  }
}

/**
 * A recipe step is an executable claim, so both halves of it are checked: the
 * tool it names and the arguments it passes. #928 is the case that makes the
 * second half necessary — the cookbook said `whats_new` with
 * `since: "last Monday"`, a value the tool's own schema rejects, so the step
 * failed validation instead of returning a result.
 *
 * The trigger is an imperative verb rather than the literal word "Call": the
 * docs write `preview <tool> with ...` for the write half of a recipe, and a
 * matcher that only saw "Call" left every preview step unchecked — a bogus
 * key in a preview step passed the gate silently.
 */
function checkCallRecipes(file, source, registry = census) {
  // The verb is what makes this a recipe step rather than a sentence, and it
  // is restricted to `call`/`preview` precisely because those two are what the
  // docs use to introduce a tool call. A wider verb list reads ordinary prose
  // — the feature-sweep skill's "confirm the request budget with the human"
  // is an instruction to a human, not a call to a tool named `budget`.
  const pattern = /\b([A-Za-z]+)\s+`?([a-z][a-z0-9_]*)`?\s+(?:with|using)\s+([^.;\n]+)/g;
  for (const match of source.matchAll(pattern)) {
    if (!RECIPE_VERB.test(match[1].toLowerCase())) continue;
    const [, , tool, tail] = match;
    const line = lineAt(source, match.index);
    if (!registry.toolNames.includes(tool)) {
      // A known parameter named here is a caller instruction, not a tool:
      // SPEC.md says "use `offset` with repeated requests".
      if ((registry.parameterNames ?? []).includes(tool)) continue;
      errors.push(`${relative(ROOT, file)}:${line}: Call recipe names unknown tool \`${tool}\``);
      continue;
    }
    // The colon is what makes a backticked word an argument. Without it the
    // word is prose (or a value the sentence is naming), and cookbook.md
    // names a *prompt's* arguments in the same breath as a tool call.
    const pairs = [...tail.matchAll(/`([a-z][a-z0-9_]*)\s*:\s*([^`]+)`/g)];
    if (pairs.length === 0) continue;
    validateArgumentKeys(file, line, tool, Object.fromEntries(pairs.map(([, key]) => [key, true])), registry);
    const values = pairs
      .map(([, key, raw]) => [key, parseRecipeValue(raw)])
      .filter(([, value]) => value !== undefined);
    if (values.length > 0) validateArgumentValues(file, line, tool, values, registry);
  }
}

/**
 * An Inputs table is a contract, not prose, so the three things a caller reads
 * off it are checked against the live schema rather than left to review:
 *
 *  - COMPLETENESS (#1243): a field the schema marks required but the table
 *    omits is a call the table tells a caller to make and the server rejects.
 *    `remove_from_playlist` documented `uris` and `snapshot_id` and never named
 *    `playlist_id`, so the documented half of a two-call workflow could not
 *    succeed.
 *  - REQUIREDNESS (#1245): a plain `yes` on a property the schema marks
 *    optional promises a validation error that never comes — the real
 *    enforcement is a runtime throw inside the handler. `yes (runtime)` is the
 *    honest spelling, and the check holds it to a property that really is
 *    optional, so the escape hatch cannot be used to paper over an inverted
 *    name.
 *  - SHAPE (#1244): a `string` column over an array schema advertises a value
 *    the tool rejects. Only array-ness is compared; the type vocabulary in
 *    these tables is prose, not JSON Schema, so a full type comparison would
 *    be a false gate.
 *
 * Only tools with an actual Inputs *table* are checked. A prose Inputs line is
 * not a field-by-field contract and is left alone rather than half-checked.
 */
function checkInputsTableContracts(file, source, registry = census) {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const heading = /^#{3,4}\s+`([a-z][a-z0-9_]*)`/.exec(lines[index]);
    if (!heading || !registry.toolNames.includes(heading[1])) continue;
    const tool = heading[1];
    const schema = registry.toolInputSchemas?.[tool];
    if (!schema?.properties) continue;
    // Prose may sit between the heading and the Inputs marker.
    let inputsAt = -1;
    for (let k = index + 1; k < lines.length; k++) {
      if (/^#{1,4}\s/.test(lines[k])) break;
      if (/^\*\*Inputs:\*\*/.test(lines[k])) { inputsAt = k; break; }
    }
    if (inputsAt < 0) continue;
    const body = [];
    for (let k = inputsAt + 1; k < lines.length && lines[k].startsWith('|'); k++) body.push(k);
    // Header + separator and nothing else is not a table of fields.
    if (body.length < 3) continue;

    const documented = new Map();
    for (const k of body) {
      const row = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/.exec(lines[k]);
      if (!row) continue;
      // Split on unescaped pipes so a union type like `string[] \| {…}[]`
      // keeps its columns.
      const cells = lines[k].split(/(?<!\\)\|/).slice(1);
      documented.set(row[1], {
        type: (cells[1] ?? '').trim().replace(/\\\|/g, '|'),
        required: (cells[2] ?? '').trim().toLowerCase(),
      });
    }
    const at = relative(ROOT, file);
    for (const field of schema.required ?? []) {
      if (documented.has(field)) continue;
      errors.push(
        `${at}:${inputsAt + 1}: \`${tool}\`'s Inputs table omits \`${field}\`, which its schema `
        + 'marks required — a caller building the documented call would be rejected.',
      );
    }
    for (const [field, cell] of documented) {
      const property = schema.properties[field];
      if (!property) continue;
      const schemaRequired = (schema.required ?? []).includes(field);
      if (cell.required === 'yes' && !schemaRequired) {
        errors.push(
          `${at}:${inputsAt + 1}: \`${tool}\`.${field} is documented \`Required: yes\` but is `
          + 'optional in the live schema. Say `yes (runtime)` if the handler enforces it, so a '
          + 'caller is not told validation will catch a missing value.',
        );
      } else if (cell.required === 'yes (runtime)' && schemaRequired) {
        errors.push(
          `${at}:${inputsAt + 1}: \`${tool}\`.${field} is documented \`yes (runtime)\` but the `
          + 'schema marks it required — plain `yes` is correct.',
        );
      }
      if (!cell.type || /\bshared\b/i.test(cell.type)) continue;
      const docSaysArray = cell.type.includes('[]');
      if (docSaysArray !== (property.type === 'array')) {
        errors.push(
          `${at}:${inputsAt + 1}: \`${tool}\`.${field} is documented as \`${cell.type}\` but the `
          + `live schema declares type \`${property.type}\`${property.items?.enum ? ` of ${JSON.stringify(property.items.enum)}` : ''} — `
          + 'the documented value shape is rejected.',
        );
      }
    }
  }
}

function checkToolArgumentTables(file, source, registry = census) {
  const lines = source.split('\n');
  let activeTool = null;
  let inInputs = false;
  for (let index = 0; index < lines.length; index++) {
    const heading = /^#{3,4}\s+`([a-z][a-z0-9_]*)`/.exec(lines[index]);
    if (heading) {
      activeTool = registry.toolNames.includes(heading[1]) ? heading[1] : null;
      inInputs = false;
      continue;
    }
    if (/^###\s+/.test(lines[index])) {
      activeTool = null;
      inInputs = false;
      continue;
    }
    if (/^\*\*Inputs:\*\*/.test(lines[index])) {
      inInputs = true;
      continue;
    }
    if (/^\*\*(?:Returns|Notes):\*\*/.test(lines[index])) inInputs = false;
    if (!activeTool || !inInputs) continue;
    const row = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/.exec(lines[index]);
    if (row) validateArgumentKeys(file, index + 1, activeTool, { [row[1]]: true }, registry);
  }
}

function validateToolArguments(file, line, example, registry) {
  if (!registry.toolNames.includes(example.tool)) {
    errors.push(`${relative(ROOT, file)}:${line}: JSON example names unknown tool \`${example.tool}\``);
    return;
  }
  const args = example.arguments && typeof example.arguments === 'object' && !Array.isArray(example.arguments)
    ? example.arguments
    : Object.fromEntries(Object.entries(example).filter(([key]) => key !== 'tool'));
  validateArgumentKeys(file, line, example.tool, args, registry);
  const properties = registry.toolInputSchemas?.[example.tool]?.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(args)) {
      validateExampleValue(file, line, example.tool, key, value, properties[key]);
    }
  }
}

function validateArgumentKeys(file, line, tool, args, registry) {
  const schema = registry.toolInputSchemas?.[tool];
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') {
    errors.push(`${relative(ROOT, file)}:${line}: production tools/list has no inputSchema.properties for \`${tool}\``);
    return;
  }
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) {
      errors.push(`${relative(ROOT, file)}:${line}: \`${key}\` is not an input parameter of \`${tool}\` (schema: ${Object.keys(properties).sort().join(', ')})`);
    }
  }
}

function validateExampleValue(file, line, tool, pathName, value, schema) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} example value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  const expectedType = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
  if (expectedType.length > 0 && !expectedType.includes(actualType) && !(expectedType.includes('number') && actualType === 'integer')) {
    errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} example value ${JSON.stringify(value)} is not ${expectedType.join('|')}`);
    return;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} example is below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} example exceeds maximum ${schema.maximum}`);
  }
  if (actualType === 'object' && schema.properties && typeof schema.properties === 'object') {
    for (const requiredKey of schema.required ?? []) {
      if (!Object.hasOwn(value, requiredKey)) errors.push(`${relative(ROOT, file)}:${line}: ${tool}.${pathName} is missing required ${requiredKey}`);
    }
  }
  if (actualType === 'array' && schema.items) {
    value.forEach((item, index) => validateExampleValue(file, line, tool, `${pathName}[${index}]`, item, schema.items));
  }
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function unique(values) {
  return [...new Set(values)];
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) files.push(...walk(file));
    else files.push(file);
  }
  return files;
}
