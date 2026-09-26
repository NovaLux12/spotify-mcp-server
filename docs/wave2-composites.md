# Wave 2 composites — shipped taste tools (read-only except `taste_to_playlist`)
<!-- BEGIN:generated surface-census -->
Current default production surface: **592 tools**, including the shipped taste composites documented below. Earlier release totals in this page's history are not current registry truth; regenerate this block with `npm run count:tools -- --write`.
<!-- END:generated surface-census -->

The `taste` toolset contributes eleven tools across two registrar rows: ten read-only composites in `taste_composites.ts`, plus `taste_to_playlist` in `taste_playlist.ts`, which previews by default and writes only when a caller passes `dry_run: false`. They are separate rows because `readOnlySafe` is a per-ROW flag — one row holding both would either expose the writer to `SPOTIFY_MCP_READONLY` sessions or hide the ten readers with it (#1009). Earlier release totals are historical context, not current registry truth.

## Data-source and write guarantees

Every composite in `src/tools/taste_composites.ts` and `src/tools/taste_playlist.ts`:

- Reads the stats.fm public API v1 (`https://api.stats.fm/api/v1`, no
  auth) — top artists / tracks / genres / streams endpoints.
- The ten read-only composites never call any Spotify write API. Playlist-
  shaped output from them is a copy-pasteable track list plus a `DRY_RUN`
  receipt describing what a human (or a Spotify write tool) would do next.
- `taste_to_playlist` is the single writer. It calls NO Spotify endpoint at
  all while `dry_run` is true (the default). With `dry_run: false` it
  performs one `POST /me/playlists` and chunked `PUT`/`POST
  /playlists/{id}/items` adds, and refuses outright under
  `SPOTIFY_MCP_READONLY` before any wire call. See #723.
- `stats.fm` `externalIds.spotify[]` entries are frequently dead (≈12% in
  the wild), so every track-list output includes Spotify-search fallback
  guidance (`search_tracks "Artist - Title"`) and a `missing[]` section for
  rows with no usable Spotify id.
- On a `dry_run: false` commit, tracks whose stats.fm id is unusable are
  looked up with one `/search` GET each. Only a 404 or an empty result set
  means "search matched nothing" (`unresolved[]`); a lookup that itself fails
  (401 / 429 / 5xx / transport) is reported under `search_errors[]` as
  *existence unknown*, and a run in which no lookup could be served is
  blocked with `blocked: 'search_failed'` and writes nothing.
- Pure shaping on top of the lenient normalizers in `statsfm_taste.ts`
  (`normalizeStreams`, `normalizeTopList`, `groupSessions`,
  `summarizeMonths`, `detectEras`, `summarizeDayParting`,
  `classifyExposure`). Empty data degrades to "not enough data" prose —
  never a crash.

## The 11 composites

| # | Tool | Inputs | Output |
|---|------|--------|--------|
| 1 | `taste_to_playlist` | `statsfm_user`, `track_count` (default 20, max 50), `seed` (core\|recent\|mixed, default mixed), `dry_run` (default true), `playlist_name` (optional) | Ordered `Artist — Title` list blended from lifetime tops + recent streams. `dry_run: true` (default) → DRY_RUN receipt, zero Spotify calls. `dry_run: false` → creates the playlist and adds every pick that resolves, with `unresolved[]` / `search_errors[]` for the rest |
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
  `src/tools/taste_composites.ts` (10 `server.tool` calls) and
  `registerTastePlaylistTools(server, client)` in `src/tools/taste_playlist.ts`
  (1 call) — all eleven names are `taste_*`.
- Wired through the `REGISTRAR_MANIFEST` in `src/tools/annotations.ts` as two
  rows that share registration key `tastecomposites` (so `src/toolsets.ts` and
  the toolset list are unchanged): `tastecomposites` is `readOnlySafe: true`,
  and `tasteplaylist` is `readOnlySafe: false` with `scopeKey: 'playlists'` —
  creating a playlist needs a playlist-modify scope, so the writer is withheld
  from a grant that carries none (#1009).
- `src/toolsets.ts`: `taste: ['taste', 'tastecomposites']`. Per-set tool counts
  are not hand-maintained — the generated census header above is the source of
  truth, and the registrar budgets in `src/tools/annotations.ts` carry the
  per-module numbers.
- Tests: `tests/taste-composites.test.ts`, fixture-backed fetch via
  `__setTasteCompositeFetchImpl`, ≥1 test per tool.
