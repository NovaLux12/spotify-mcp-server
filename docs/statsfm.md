# stats.fm second source

SpotifyMCP reads Spotify first. stats.fm rides alongside as a **second upstream** — long-range listening history, cross-range top lists, and taste aggregates that the Spotify Web API alone cannot give you (Spotify's own top-items endpoints stop at a few bounded time ranges; stats.fm keeps lifetime history once your streams are imported).

All stats.fm tools are **read-only**. They never write to your library, playlists, or playback state. Pair them with the Spotify write tools to act on what you learn — see the [flagship taste-profile recipe](cookbook.md#1-taste-profile--playlist-flagship) and the [taste showcase](taste.md).

> **Status:** v2.0.0 (unreleased). Tool names below are the planned contract; the implementation branches own the final schemas. If a name differs after release, the tool description in-host is authoritative.

## Setup

1. **Create a stats.fm account** at [stats.fm](https://stats.fm) and log in.
2. **Import your Spotify history.** stats.fm builds lifetime stats from imported streams: in stats.fm go to Settings → Import, connect Spotify, and request your extended history. Lifetime ranges stay thin until the import completes — check coverage with `statsfm_history_status` before trusting `lifetime` results.
3. **Find your stats.fm user ID.** Open your stats.fm profile page — the numeric ID is in the URL (`stats.fm/user/<id>`). That ID is the identity every stats.fm tool below takes.
4. **Point the server at it.** Set the user ID once so you don't repeat it per call:

```bash
export STATSFM_USER_ID=your_statsfm_user_id_here
```

```json
"env": {
  "SPOTIFY_CLIENT_ID": "your_client_id_here",
  "STATSFM_USER_ID": "your_statsfm_user_id_here"
}
```

No OAuth dance: stats.fm public profile data needs no token. Private profiles need the profile owner's cooperation (see [Privacy](#privacy)).

## Tool cheat sheet

The planned stats.fm surface. Every tool accepts `response_format` (`concise` / `detailed` / `json`) like the rest of the server.

| Tool | What it returns |
|---|---|
| `statsfm_get_profile` | Public profile: display name, follower counts, total streams and minutes, account age |
| `statsfm_top_tracks` | Top tracks for a range (see [Ranges](#ranges)) |
| `statsfm_top_artists` | Top artists for a range, with stream counts |
| `statsfm_top_albums` | Top albums for a range |
| `statsfm_top_genres` | Genre ranking for a range — the input to taste work |
| `statsfm_recent_streams` | Most recent individual streams (track + timestamp) |
| `statsfm_stream_stats` | Totals for a range: streams, minutes, distinct tracks/artists, daily average |
| `statsfm_listening_clock` | Hourly / weekday heatmap of when listening happens |
| `statsfm_taste_profile` | Aggregate digest: top genres, anchor artists, clock summary, diversity notes — built to feed playlist creation |
| `statsfm_compare_taste` | Overlap between two stats.fm users: shared artists/tracks, compatibility note |
| `statsfm_history_status` | Import coverage: how much history stats.fm holds, newest/oldest stream, gaps |

Typical flow: `statsfm_history_status` (is the data there?) → `statsfm_taste_profile` (what's the shape?) → Spotify search/playlist tools (make something from it).

## Ranges

Top and stats tools take a `range` argument. stats.fm ranges are **named windows**, not arbitrary dates:

- `lifetime` needs a completed history import; without it, lifetime looks identical to the imported window and silently undercounts.
- Short windows (`week`, `month`) reflect current rotation; long windows (`6months`, `lifetime`) reflect identity. Compare a short window against `lifetime` to separate phases from taste.
- Exact range names and defaults live in each tool's schema — pass `range` explicitly in agents and scripts rather than relying on the default.

## Limits

- Top-list tools page with `limit` / `offset` like the Spotify catalog tools. Ask for what you need; walks over huge offsets cost one upstream request per page.
- `statsfm_recent_streams` is recency-ordered and most useful with small limits (10–50). It is a window onto recent plays, not a full export — for bulk work, page deliberately and expect rate limiting on deep walks.
- `max_results` truncation and `structuredContent` pagination behave the same as every other list tool on this server.

## Privacy

- **Public profiles** are queryable by any stats.fm user ID — no credential needed.
- **Private profiles** return minimal or no data. There is no bypass: ask the owner to make the profile public or share the comparison from their side.
- **Detailed streams are owner-only.** `statsfm_recent_streams` gives full detail for your own linked account; for other users you get aggregates (tops, stats, clock) but not play-by-play history.
- `statsfm_compare_taste` only sees what both profiles expose. Private + private compares return nothing — by design.
- These tools send stats.fm user IDs to the stats.fm API and render what comes back. Nothing is posted, liked, or followed as a side effect.

## Gotchas

- **Lifetime lies before import.** A fresh stats.fm account with no history import returns near-empty lifetime ranges. Always call `statsfm_history_status` first in a new setup.
- **stats.fm ≠ Spotify counts.** Totals come from stats.fm's stream log, not Spotify's API — expect small mismatches against `listening_report` or Spotify Wrapped. Different counters, different windows.
- **Genres are stats.fm's own taxonomy.** `statsfm_top_genres` labels come from stats.fm, not Spotify (whose API exposes no genre endpoint for tracks). Great for curation, not for exact Spotify-side filtering — use them as search seeds, not IDs.
- **Clock is timezone-shaped.** `statsfm_listening_clock` buckets by the timezone stats.fm recorded. Late-night vs commute patterns survive; exact-hour claims across timezones don't.
- **Prior art.** stats.fm continues ideas Last.fm pioneered (scrobbling, taste graphs, compatibility). If you know Last.fm, the mental model transfers; the IDs and ranges don't.

## See also

- [Cookbook](cookbook.md) — copy-paste recipes including the flagship taste-profile flow
- [Taste showcase](taste.md) — anonymized end-to-end example driving a real playlist
- [FAQ](faq.md) — setup and auth troubleshooting
- [Configuration](configuration.md) — every environment variable
