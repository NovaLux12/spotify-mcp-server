# Migrating to 3.0

3.0 retires tool names and parameter names. This page is the map from every
retired name to what replaced it, and — for the one operation that has no
replacement — says so as loudly as the tables below.

The tables are **generated** from the same constants in `src/shaping.ts` that
the runtime refusal messages are built from, so a row here and the error a
migrating caller hits cannot disagree. Regenerate them with
`npm run count:tools -- --write`; a stale one fails
`npm run count:tools -- --check`, so this page cannot fall behind the code.
Do not hand-edit anything between the generated markers.

## Following an artist has no replacement

**`follow_artists` and `unfollow_artists` are gone and nothing replaces them.
Do not look for a migration on this page — there is not one.** This is the
single most important line in the document, and a guide that let a reader infer
the operation still exists somewhere would be worse than no guide at all.

Spotify removed `PUT`/`DELETE /me/following?type=artist` in its February 2026
changelog. The obvious-looking migration does not work:
`PUT`/`DELETE /me/library` accepts track, album, episode, show, audiobook,
user and playlist URIs — **not** `spotify:artist:`. A
`PUT /me/library?uris=spotify:artist:<id>` would return success and follow
nothing, which is a worse outcome than the refusal you get today.

The repository already encodes the asymmetry: `LIBRARY_SAVE_TYPES` in
`src/tools/library.ts` omits `artist` while `LIBRARY_CHECK_TYPES` includes it.
The **read** half migrated cleanly and still works:

- `check_following_artists` answers "do I follow these artists" via
  `GET /me/library/contains`, which does accept artist URIs.
- `get_followed_artists` and `following_analytics` still list the followed set.

**The write half is unexpressible over this API.** A caller that needs to
change follow state has to do it outside this server — in the Spotify client or
the web player. There is no tool, no env var and no toolset that brings it
back. Verified against the endpoint reference pages rather than the changelog
summary, and recorded in [SPEC.md §5.7](../SPEC.md#57-following).

## Retired in the February 2026 endpoint removals (#638)

These tools are **deleted**, not forwarded: the endpoint each one called was
removed by Spotify, and in every case below the honest outcomes were to delete
the tool or migrate the call. Where a migration exists, the shipped tool already
uses it. This batch is listed here in prose rather than in a generated table
because the runtime has no table for it — the tools are simply absent — and a
generator reading a list of names nothing else in `src/` uses would be a second
source of truth for a fact that already lives in
[AGENTS.md §2](../AGENTS.md#2-endpoints-that-are-blocked-or-deprecated) and in
[SPEC.md §5.7](../SPEC.md#57-following).

| Retired tool | Why | Replacement in 3.0 |
|---|---|---|
| `follow_artists` | `PUT /me/following?type=artist` removed with no replacement | **none** — see the section above |
| `unfollow_artists` | `DELETE /me/following?type=artist` removed with no replacement | **none** — see the section above |
| `save_items` | per-type `PUT /me/{tracks,albums,…}` removed | `save_to_library` (`PUT /me/library`) |
| `remove_saved_items` | per-type `DELETE /me/{tracks,albums,…}` removed | `remove_from_library` (`DELETE /me/library`) |
| `check_saved_items` | per-type `GET /me/{tracks,albums,…}/contains` removed | `check_in_library` (`GET /me/library/contains`) |
| `get_categories` | `GET /browse/categories` removed; no endpoint serves the browse category tree | **none** — `get_category`, `browse_category_deepdive` and `category_resolver` still read a category you already have an id for; see [README § Registration-gated endpoints](../README.md#registration-gated-endpoints) |
| `get_category_playlists` | same removal, same dead end | **none** — see the row above |
| `get_show_episodes` | superseded by the paged `get_playlist_items` on a show playlist | `get_playlist_items` on the show's playlist |

`/me/library` authorises **three** alternative scopes — `user-library-modify`,
`user-follow-modify`, **or** `playlist-modify-public`. Check which one your
registration actually holds before concluding that a migrated call will succeed;
a 403 there is a scope problem, not a broken migration.

A caller that reaches for one of these names now gets a typed `unknown_tool`
error with the nearest real names in `fix`. That error is a rename, not a bug —
see the next section.

## What a refusal mid-migration means

Every retirement in this document refuses **by name, before any Spotify
request**. That is deliberate: the retired name is not a typo and not an
unknown parameter, it is a name this server published under a deprecation
notice and then withdrew, and a host routing on `kind` should be able to tell
those apart without parsing prose.

| What you sent | `kind` | `reason` | `error.param` | Where to look it up |
|---|---|---|---|---|
| A retired parameter name | `validation` | `retired_input` | the retired name(s) | the parameter tables below |
| A retired tool name that still forwards | *(succeeds)* | — | — | carries `deprecated_inputs` + `deprecation_note` instead |
| A retired tool name that does not forward | `unknown_tool` | `unknown_tool` | — | the "Retired tool names" tables below, and `fix` names the survivor |
| A retired tool name that never existed / is gone with no replacement | `unknown_tool` | `unknown_tool` | — | the "February 2026" table above |

So a `retired_input` refusal is **this page's row, not a defect**. The `fix`
field names the replacement parameter and the message names the version the
name was removed in; neither is generated from a copy of this document, both
come from the same constant the table is rendered from. If you hit one and the
row here disagrees with the message, the message is right and this page is
stale — run `npm run count:tools -- --write` and open a bug.

## Reading the two version columns

The "Removed in" column and the "Still callable in 3.0?" column are separate
claims and are rendered from separate values, because they can disagree in a
way a single column would hide:

- **"Removed in"** is the release constant the refusal message quotes. It is
  the version boundary a notice promises.
- **"Still callable in 3.0?"** is what the code in this tree does today. The
  ten forwarding names answer calls in 3.0, precisely because forwarding *is*
  their one-release migration window.

A name that still answers calls and carries a notice naming `v3.0` is
therefore neither a contradiction nor a promise that the name is safe to keep
using. Port your calls; do not read the working forward as an extension.

## Retired names and parameters

<!-- BEGIN:generated migration-tables -->
### Retired tool names

These names are no longer advertised by `tools/list`. What a 3.0 caller
actually gets is stated per row, because the three families behave
differently and a single "removed" would misdescribe two of them.

#### Legacy stats.fm aliases — removed in v3.0

Each was the same tool registered twice: identical parameters, identical
handler, a description differing only by a suffix. The duplicate
registration is what went away, not the capability.

| Retired name | Canonical | Removed in | Still callable in 3.0? |
|---|---|---|---|
| `artist_affinity` | `statsfm_artist_affinity` | v3.0 | only with `SPOTIFY_MCP_LEGACY_ALIASES=1` **and** the `taste` toolset enabled |
| `exposure_check` | `statsfm_exposure_check` | v3.0 | only with `SPOTIFY_MCP_LEGACY_ALIASES=1` **and** the `taste` toolset enabled |
| `forgotten_favorites` | `statsfm_forgotten_favorites` | v3.0 | only with `SPOTIFY_MCP_LEGACY_ALIASES=1` **and** the `taste` toolset enabled |
| `listening_eras` | `statsfm_listening_eras` | v3.0 | only with `SPOTIFY_MCP_LEGACY_ALIASES=1` **and** the `taste` toolset enabled |
| `listening_sessions` | `statsfm_listening_sessions` | v3.0 | only with `SPOTIFY_MCP_LEGACY_ALIASES=1` **and** the `taste` toolset enabled |
| `record_feedback` | `statsfm_record_feedback` | v3.0 | only with `SPOTIFY_MCP_LEGACY_ALIASES=1` **and** the `taste` toolset enabled |
| `taste_profile` | `statsfm_taste_profile` | v3.0 | only with `SPOTIFY_MCP_LEGACY_ALIASES=1` **and** the `taste` toolset enabled |
| `taste_recommendations` | `statsfm_taste_recommendations` | v3.0 | only with `SPOTIFY_MCP_LEGACY_ALIASES=1` **and** the `taste` toolset enabled |

#### Retired names that still forward — removed in v3.0

These are not the same tool twice, so a name-only rewrite would hand the
caller a schema error instead of the behaviour they asked for. Each call
is translated into its survivor's arguments first.

| Retired name | Forwards to | Removed in | Still callable in 3.0? |
|---|---|---|---|
| `apply_device_presets` | `set_volume` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `apply_volume_plan` | `set_volume` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `handoff` | `transfer_playback` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `mute` | `set_volume` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `plan_volume_level_across_devices` | `set_volume` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `room_level` | `set_volume` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `switch_device` | `transfer_playback` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `transfer_playback_with_state` | `transfer_playback` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `unmute` | `set_volume` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |
| `volume_step` | `set_volume` | v3.0 | yes — forwards to the survivor with its arguments translated; the result carries `deprecated_inputs` and `deprecation_note` |

#### Retired queue-read names — removed in v3.0

Also not argument-compatible, and deliberately **not** rewritten by
`SPOTIFY_MCP_LEGACY_ALIASES=1`: the survivors take arguments the retired
tools did not, so a name-only rewrite would answer a different question
under a name that used to be right. The refusal names the exact call
instead — printed here verbatim, as the server sends it.

| Retired name | Canonical | Removed in | Still callable in 3.0? |
|---|---|---|---|
| `describe_queue` | `get_queue` | v3.0 | no — refuses with the exact replacement call in `fix`: `get_queue with view: 'enriched'` |
| `get_queue_snapshot` | `get_queue` | v3.0 | no — refuses with the exact replacement call in `fix`: `get_queue with include: ['runtime']` |
| `predict_next_tracks` | `peek_next` | v3.0 | no — refuses with the exact replacement call in `fix`: `peek_next with count (and get_queue with include: ['runtime'] for the per-item ETA)` |
| `queue_duplicate_check` | `get_queue` | v3.0 | no — refuses with the exact replacement call in `fix`: `get_queue with include: ['duplicates']` |
| `queue_profile` | `get_queue` | v3.0 | no — refuses with the exact replacement call in `fix`: `get_queue with include: ['profile']` |
| `queue_runtime_report` | `get_queue` | v3.0 | no — refuses with the exact replacement call in `fix`: `get_queue with include: ['runtime']` |

### Retired parameter names

A call carrying one of these is refused **by name**, before any Spotify
request, with `kind: "validation"` and `reason: "retired_input"` — not with
`unknown_param`, which would claim the server never had the name. Both
names ride along in `error.param`.

#### Retired playlist input spellings — removed in v3.0

| Tool | Retired parameter | Send instead | Removed in | What a 3.0 caller gets |
|---|---|---|---|---|
| `balance_playlist_pairs` | `playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `check_playlist_following` | `playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `compare_playlist_covers` | `playlist_id_a` / `playlist_id_b` | `playlist_a/playlist_b` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `diff_playlists` | `a` / `b` | `playlist_a/playlist_b` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `find_duplicate_tracks_across_playlists` | `playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `interleave_playlists_plan` | `playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `merge_playlists` | `sources` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `merge_playlists_plan` | `playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_diff` | `playlist_a_id` / `playlist_b_id` | `playlist_a/playlist_b` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_difference_plan` | `subtract_playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_intersect` | `source_playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_intersection` | `playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_overlap_matrix` | `playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_pair_check` | `playlist_a_id` / `playlist_b_id` | `playlist_a/playlist_b` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_subtract` | `subtract_playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_symmetric_difference` | `playlist_id_a` / `playlist_id_b` | `playlist_a/playlist_b` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_union` | `source_playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `playlist_union_preview` | `playlist_ids` | `playlists` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |

#### Retired walk caps — removed in v3.0

Both tools were durable-write tools, so lowering the retired name silently
truncated a snapshot or backup **on disk** while the response looked
normal. The caps now carry their own names.

| Tool | Retired parameter | Send instead | Removed in | What a 3.0 caller gets |
|---|---|---|---|---|
| `backup_library` | `max_results` | `walk_cap` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
| `take_playlist_snapshot` | `max_results` | `item_cap` | v3.0 | no — refuses before any Spotify request, `kind: "validation"`, `reason: "retired_input"` |
<!-- END:generated migration-tables -->

## What is deliberately not in this document

- **The live tool surface.** Counts, byte figures and the module map are
  generated into [SPEC.md](../SPEC.md#1-goals--non-goals) and
  [docs/schema-budgets.md](schema-budgets.md) from the real registry, and this
  page carries none of them. A retirement guide that also reported the tool
  count would be two documents to update per release for one number.
- **Registration-gated endpoints.** A 403 on a gated path is a property of your
  app registration, not of a retirement. See
  [README § Registration-gated endpoints](../README.md#registration-gated-endpoints).
- **Deprecations that have not landed.** `user_id` on the stats.fm tools is
  still callable and carries its own notice; it is named by that notice, not by
  this page, because nothing about it is retired yet.

## See also

- [SPEC.md](../SPEC.md) — the full tool contract, including the retirement
  notes per tool
- [docs/v3-roadmap.md](v3-roadmap.md) — what else 3.0 changes
- [docs/non-goals.md](non-goals.md) — the operations that have no replacement and
  why
- [docs/faq.md](faq.md) — auth, Premium, 403s, headless, tokens
