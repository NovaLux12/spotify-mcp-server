# stats.fm second source

SpotifyMCP reads Spotify first. stats.fm rides alongside as a **second upstream** for long-range listening history, cross-range top lists, and taste aggregates that the Spotify Web API alone cannot provide. stats.fm keeps lifetime history after your imported streams are available.

Stats.fm-backed calls never write to Spotify, with one exception: `taste_to_playlist` reads its picks from stats.fm and then writes to Spotify — it creates a playlist and adds tracks when you pass `dry_run: false`, and previews by default. It ships in the same `taste` toolset as everything below. The only taste tool with local state is `statsfm_record_feedback` / `record_feedback`: its entries are identity-free, never sent to stats.fm, and persisted to a local sidecar at `~/.spotify-mcp/taste-feedback.json` (`SPOTIFY_MCP_DATA_DIR` overrides the directory) — see [Local state](#local-state). Pair stats.fm results with Spotify write tools to act on what you learn — see the [flagship taste-profile recipe](cookbook.md#1-taste-profile--playlist-flagship) and the [taste showcase](taste.md).

## Setup

1. **Create a stats.fm account** at [stats.fm](https://stats.fm) and log in.
2. **Import your Spotify history.** In stats.fm, open Settings → Import, connect Spotify, and request your extended history. Lifetime results are only as complete as that import. `statsfm_streams_stats` reports aggregate totals for the history visible to stats.fm, and `statsfm_recaps` provides per-calendar-year views; neither proves import completeness.
3. **Find your stats.fm user ID.** Open your profile page and copy the `<id>` out of the `stats.fm/user/<id>` URL. It is a string, not a number — the tool schema's own example is the handle `"martijn"`. Most user-scoped endpoint tools take it as a required `user_id`; the seven network-backed taste tools in `src/tools/statsfm_taste.ts` take it as a required `statsfm_user`. Both parameters accept a stats.fm user id or a customId, so either form works. Which one a given tool takes is a property of its schema, not of its name — the `taste_*` wave-2 composites below take `statsfm_user`, and `taste_shift_report` / `taste_checkpoint` read Spotify's own top lists and take no identity argument at all.

There is no stats.fm OAuth dance: public profile data needs no token. Private profiles need the profile owner's cooperation (see [Privacy](#privacy)). User-scoped calls pass identity explicitly on every call; there is no `STATSFM_USER_ID` setting. Catalog searches and catalog-entity lookups do not require an identity argument.

## Taste-tool naming

The eight taste-intelligence tools in `src/tools/statsfm_taste.ts` use canonical **`statsfm_*`** names. Each also has a registered legacy alias pointing to the same handler; the complete pair-by-pair mapping is in the [taste showcase naming table](taste.md#tool-naming).

The separate wave-2 composite tools are registered under the `taste` toolset with canonical `taste_*` names. They are live tools, not planned tools; see [taste composites](wave2-composites.md).

## Tool cheat sheet

Every tool below is registered. The common `response_format` argument accepts `concise`, `detailed`, or `json` where the tool's schema includes it.

### Endpoint tools

| Tool | What it returns |
|---|---|
| `statsfm_resolve_user` | Resolve a stats.fm ID or customId to a profile, with user search as a fallback. |
| `statsfm_top_tracks` | A user's top tracks for `range` (`weeks`, `months`, or `lifetime`). |
| `statsfm_top_artists` | A user's top artists for a supported `range`. |
| `statsfm_top_albums` | A user's top albums for a supported `range`. |
| `statsfm_top_genres` | A user's genre ranking for a supported `range`. |
| `statsfm_recent_streams` | Recent individual streams, with optional Unix-ms `after`/`before` bounds. |
| `statsfm_now_playing` | The user's current stream, or `null` when idle. |
| `statsfm_track_stats` | Stream totals for one track, counted over one page of the user's newest streams (`limit`) — not their whole history. |
| `statsfm_artist_stats` | Stream totals for one artist, counted over one page of the user's newest streams (`limit`) — not their whole history. |
| `statsfm_album_stats` | Stream totals for one album, counted over one page of the user's newest streams (`limit`) — not their whole history. |
| `statsfm_search` | Search the stats.fm track, artist, album, playlist, or user catalog. |
| `statsfm_recaps` | Year-in-review totals and catalog breadth for one calendar year. |
| `statsfm_streams_stats` | Aggregate listening totals and catalog cardinality, optionally bounded by Unix-ms `after`/`before`. |
| `statsfm_top_tracks_from_artist` | A user's top tracks for one artist. |
| `statsfm_top_albums_from_artist` | A user's top albums for one artist. |
| `statsfm_top_tracks_from_album` | A user's top tracks for one album. |
| `statsfm_catalog_track` | Look up one track in the stats.fm catalog. |
| `statsfm_catalog_artist` | Look up one artist in the stats.fm catalog. |
| `statsfm_catalog_album` | Look up one album in the stats.fm catalog. |
| `statsfm_genre_artists` | Artists carrying a stats.fm genre tag. |
| `statsfm_charts_tracks` | A user's all-time track chart with movement indicators. |
| `statsfm_charts_artists` | A user's all-time artist chart with movement indicators. |
| `statsfm_charts_albums` | A user's all-time album chart with movement indicators. |
| `statsfm_charts_users` | One page of a user's friends — the `limit` you pass, not their whole friend list — ranked by stream count. A friend whose total cannot be read is listed as unreadable with the reason, never as zero. |
| `statsfm_track_date_stats` | Stream totals for one track within a date window, counted over one page of that window's streams (`limit`) — not the whole window. |
| `statsfm_artist_date_stats` | Stream totals for one artist within a date window, counted over one page of that window's streams (`limit`) — not the whole window. |
| `statsfm_album_date_stats` | Stream totals for one album within a date window, counted over one page of that window's streams (`limit`) — not the whole window. |
| `statsfm_friends` | A user's stats.fm friends. |
| `statsfm_friend_count` | A user's stats.fm friend count. |
| `statsfm_records_artists` | Artists holding a user's listening records and milestones. |

Typical flow: `statsfm_streams_stats` (how much history is visible?) → `statsfm_taste_profile` (what is its shape?) → Spotify search and playlist tools (make something from it). The first call reports aggregate history, not import coverage or recency gaps.

### Taste-intelligence tools

| Canonical tool | Legacy alias | What it returns |
|---|---|---|
| `statsfm_taste_profile` | `taste_profile` | Core artists, top genres, loyalty versus novelty, and UTC day-parting. |
| `statsfm_artist_affinity` | `artist_affinity` | Artist intensity, recency half-life, and exposure tier. |
| `statsfm_exposure_check` | `exposure_check` | An artist's, track's, album's, or genre's exposure tier. |
| `statsfm_listening_eras` | `listening_eras` | Monthly change points grouped into listening eras. |
| `statsfm_listening_sessions` | `listening_sessions` | Recent streams grouped by a configurable gap. |
| `statsfm_forgotten_favorites` | `forgotten_favorites` | Lifetime top tracks absent from the recent sample. |
| `statsfm_taste_recommendations` | `taste_recommendations` | Bridge-mode candidates with evidence and risk notes. |
| `statsfm_record_feedback` | `record_feedback` | Local-only taste verdicts; it never contacts stats.fm. |

`statsfm_record_feedback` defaults to `action: "record"`, which requires `subject_type`, `subject`, and `rating`; `action: "list"` returns the stored entries. It accepts no `user_id` or `statsfm_user` because it never makes a network call. For example:

```json
{ "tool": "statsfm_record_feedback", "action": "record", "subject_type": "track", "subject": "Anchor Song", "rating": "love" }
```

Use the registered `record_feedback` alias for the same call.

### Local state

Recorded verdicts are **written to disk**, not held in process memory. They live in `~/.spotify-mcp/taste-feedback.json`, overridable with `SPOTIFY_MCP_DATA_DIR`, and they survive a server restart. The store is bounded on three axes and eviction is oldest-first: a record count (`SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES`, default 500), a byte size (`SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES`, default 1 MiB), and per-field maxima. Every record is timestamped and keeps its `subject_type`, `subject`, `rating` and optional `note`, and the number of evicted verdicts is reported rather than silently applied.

A verdict is not uploaded to stats.fm and never leaves the machine through this tool. `taste_to_playlist` does not read this store; it builds its picks from the stats.fm API.

To remove the store, delete the file. It is **not** erased by `spotify-mcp logout` — see [PRIVACY.md](../PRIVACY.md) for the full local-store table.

## Ranges

Every tool that takes a `range` accepts the same three values, and only these three: **`weeks`**, **`months`**, and **`lifetime`** (lowercase, defaulting to `lifetime`). This holds for the endpoint top-list tools, the taste-intelligence tools, and the taste composites alike — they all send `range` to the same stats.fm query parameter, so there is one vocabulary across the whole surface, exported once as `statsfmRangeSchema` in `src/tools/statsfm.ts`.

The singular spellings `week` and `month` are not accepted. stats.fm rejects them with `400 invalid range`; so are `6months`, `year`, and `all-time`. Because `range` is optional with a `lifetime` default, a rejected value is worth catching before the call rather than discovering from a silent lifetime answer.

- `lifetime` needs a completed history import; without it, lifetime results are limited to the imported window.
- `weeks` and `months` reflect current rotation. Compare a short window against `lifetime` to separate phases from identity.
- `statsfm_streams_stats` and date-windowed tools use Unix-millisecond `after`/`before` bounds instead of a named `range`.
- `statsfm_recaps` uses an optional calendar `year`, not a range.

## Limits

- Top-list tools page with `limit` / `offset`; use the tool schema's maximum rather than assuming a Spotify page size. Check the row count you actually got back rather than assuming it equals the `limit` you asked for.
- The per-entity `*_stats` and `*_date_stats` tools each read **one page** of `/users/{id}/streams` — stats.fm's stream list carries no total, no cursor and no `offset`, so a page is a slice, never a lifetime total. The tools disclose this rather than letting a slice read as a lifetime figure: when the page filled, `structuredContent` carries a `capped` flag plus the page size and the number of streams actually read, and the prose says the read did not cover all of them. A total without that flag is complete for the page it read, not necessarily for the profile.
- `statsfm_recent_streams` is recency-ordered and most useful with small limits. It is a window onto recent plays, not a full export.
- `max_results` truncation and `structuredContent` pagination behave like the server's other list tools.
- Taste composites may require a public profile and enough imported streams; they return a useful empty result when the upstream has no data.

## Privacy

- **Public profiles** are queryable by a stats.fm user ID or customId; no credential is needed.
- **Private profiles** return minimal or no data. There is no bypass: ask the owner to make the profile public or share the result from their side.
- **Detailed streams are not guaranteed for every public profile.** The tools expose what stats.fm returns; private or owner-only history can be omitted.
- The tools send the supplied stats.fm ID to the stats.fm API and render the response. Nothing is posted, liked, or followed as a side effect.

## Gotchas

- **Lifetime lies before import.** A new account with no history import can return near-empty lifetime results. `statsfm_streams_stats` can confirm that aggregate history is present, but it cannot establish import completeness.
- **stats.fm ≠ Spotify counts.** Totals come from stats.fm's stream log, not Spotify's API — expect mismatches against `listening_report` or Spotify Wrapped. Different counters, different windows.
- **Genres are stats.fm's own taxonomy.** `statsfm_top_genres` labels come from stats.fm, not Spotify. Use them as search seeds, not Spotify genre IDs.
- **Clock buckets are UTC in the taste tools.** Exact-hour claims depend on the timestamps returned by stats.fm.
- **Identity is per call.** User-scoped endpoint tools require `user_id`; network-backed taste tools require `statsfm_user`. Catalog search and entity-lookup tools need no user identity. No stats.fm identity environment variable is read.

## See also

- [Cookbook](cookbook.md) — copy-paste recipes including the flagship taste-profile flow
- [Taste showcase](taste.md) — anonymized end-to-end example driving a real playlist
- [Wave-2 composites](wave2-composites.md) — playlist specs, briefs, and reports
- [FAQ](faq.md) — setup and auth troubleshooting
- [Configuration](configuration.md) — every environment variable
