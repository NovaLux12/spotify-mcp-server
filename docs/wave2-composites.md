# Wave 2 composites — 11 read-only taste composites toward 600 tools

Baseline: v1.29.0 ships 38 stats.fm + taste tools (30 `statsfm_*` live names
via loop registration + 8 `taste_*` in `statsfm_taste.ts`). Total live surface
≈ 589 tools. Standing rule: every release must expose MORE tools than the
previous one — this wave adds 11, all in the `taste` toolset.

## Read-only guarantees

Every composite in `src/tools/taste_composites.ts`:

- Reads ONLY the stats.fm public API v1 (`https://api.stats.fm/api/v1`, no
  auth) — top artists / tracks / genres / streams endpoints.
- Never calls any Spotify write API. Playlist-shaped output is a
  copy-pasteable track list plus a `DRY_RUN` receipt describing what a human
  (or a Spotify write tool) would do next.
- `stats.fm` `externalIds.spotify[]` entries are frequently dead (≈12% in
  the wild), so every track-list output includes Spotify-search fallback
  guidance (`search_tracks "Artist - Title"`) and a `missing[]` section for
  rows with no usable Spotify id.
- Pure shaping on top of the lenient normalizers in `statsfm_taste.ts`
  (`normalizeStreams`, `normalizeTopList`, `groupSessions`,
  `summarizeMonths`, `detectEras`, `summarizeDayParting`,
  `classifyExposure`). Empty data degrades to "not enough data" prose —
  never a crash.

## The 11 composites

| # | Tool | Inputs | Output |
|---|------|--------|--------|
| 1 | `taste_to_playlist` | `statsfm_user`, `track_count` (default 20, max 50), `seed` (core\|recent\|mixed, default mixed), `dry_run` (default true) | Ordered `Artist — Title` list blended from lifetime tops + recent streams, DRY_RUN receipt first, Spotify-search fallback guidance, `missing[]` for rows without Spotify ids |
| 2 | `taste_daily_brief` | `statsfm_user`, `date` (YYYY-MM-DD, default yesterday UTC) | Yesterday top-3 tracks + 2 revival picks (lifetime tops absent that day) + novelty share vs lifetime core |
| 3 | `taste_era_playlist` | `statsfm_user`, `era_index` (default latest), `track_count` (default 15) | Era window (start→end month, signature artist) + representative track list for that era + copy-paste block |
| 4 | `taste_forgotten_bangers` | `statsfm_user`, `top_limit` (default 50), `track_count` (default 15) | Forgotten-favorites playlist spec: lifetime tops missing from recent sample, ranked, with revival pick |
| 5 | `taste_obsession_ladder` | `statsfm_user`, `range` (default lifetime) | Artists ranked by stream share with exposure tiers (`classifyExposure`) — the obsession ladder |
| 6 | `taste_diamond_rotation` | `statsfm_user`, `track_count` (default 10) | Deep-cut rotation: mid-tier lifetime tracks (rank 20–60) absent from recent streams — diamonds to re-polish |
| 7 | `taste_weekly_recap` | `statsfm_user`, `days` (default 7, max 30) | Week-in-review brief: stream count, top artists/tracks of the window, busiest day, novelty share |
| 8 | `taste_genre_bridge` | `statsfm_user`, `from_genre` (optional), `to_genre` (optional) | Bridge playlist spec between two genres (defaults: core #1 → most novel adjacent genre) with evidence + risk per pick |
| 9 | `taste_novelty_loyalty` | `statsfm_user`, `range` (default lifetime) | Loyalty-vs-novelty report: top-5 share, recent-outside-core share, verdict line (comfort / balanced / explorer) |
| 10 | `taste_listening_clock` | `statsfm_user` | Day-part summary (night/morning/afternoon/evening UTC) + peak window + suggested playlist sequencing note |
| 11 | `taste_revival_queue` | `statsfm_user`, `queue_size` (default 10, max 30) | Ordered revival queue: forgotten favorites + dormant-affinity artists, each with `search_tracks` fallback line |

## Spotify-search fallback guidance (emitted in playlist-shaped outputs)

```text
stats.fm externalIds.spotify[] are often dead (~12%) — if a URI 404s,
run search_tracks "Artist - Title" and take the top result. Rows under
missing[] had no Spotify id at all: search them by name.
```

## Registration

- `registerTasteCompositeTools(server, client)` in
  `src/tools/taste_composites.ts` (11 `server.tool` calls, all `taste_*`).
- Wired in `src/index.ts` under registration key `tastecomposites`
  (no Spotify scopes, no readOnly gate — same as `taste`).
- `src/toolsets.ts`: `taste: ['taste', 'tastecomposites']`, comment
  `8 tools` → `19 tools` (8 taste + 11 composites).
- Tests: `tests/taste-composites.test.ts`, fixture-backed fetch via
  `__setTasteCompositeFetchImpl`, ≥1 test per tool.
