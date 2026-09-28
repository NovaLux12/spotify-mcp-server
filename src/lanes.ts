/**
 * The server-side lane registry (#727).
 *
 * ## Why this exists
 *
 * Lane-style workflows ("OSM", "HH", …) name a playlist by a short label the
 * user chose, and every host was left to re-derive the label→playlist mapping
 * for itself. That is not a cosmetic duplication: two hosts resolving the same
 * label can disagree (a renamed playlist, two playlists sharing a name), and
 * when they do the write lands in the wrong playlist and nothing in the
 * response says so. The server already owns the playlist write path, so it owns
 * the mapping too — one file, one resolution rule, every host identical.
 *
 * ## The rules this module enforces
 *
 *  - **A lane is a name, not a spelling of a playlist reference.** A lane
 *    resolves to a playlist reference, and that reference is then handed to the
 *    SAME {@link normalizePlaylistReference} every other playlist tool uses. A
 *    lane is not a seventh way to write `target_playlist_id`; it is a second
 *    input that produces one, so ID/URI/URL acceptance stays in one place and
 *    cannot drift from it.
 *
 *  - **An unknown lane is an error, never a silent fallback to "no lane".**
 *    A caller that asked for `OSM` and got a write somewhere else has been lied
 *    to, so {@link resolveLane} refuses and the refusal names the known lanes
 *    and the manifest path. There is no "did you mean" guessing: a lane file
 *    that maps two labels to one playlist is a user decision, not a typo to be
 *    second-guessed here.
 *
 *  - **A lane whose playlist reference does not parse is a corrupt manifest,
 *    not an empty lane.** It fails at LOAD with the offending lane named, so a
 *    typo in one entry is visible on the first call rather than the first write
 *    that happens to use it.
 *
 * ## What is NOT here
 *
 * No caching, no invalidation, and no write path. The manifest is a small local
 * JSON file read through the shared sidecar loader (`src/sidecar.ts`), so a
 * corrupt one preserves its bytes and raises rather than reading as "no lanes" —
 * an empty registry would make every lane-targeted call fall back to explicit
 * ids, which is precisely the client-side behaviour this issue removes.
 */
import { z } from 'zod';
import { loadSidecar } from './sidecar.js';
import { storePath } from './config.js';
import { normalizePlaylistReference } from './shaping.js';

/**
 * One lane entry.
 *
 * `playlist` accepts anything {@link normalizePlaylistReference} accepts, so a
 * lane can hold a bare id, a `spotify:playlist:` URI or an open.spotify.com URL
 * and the file does not have to agree with itself about which form is canonical.
 */
export const LaneEntrySchema = z
  .object({
    playlist: z.string().min(1).describe('Playlist id, spotify:playlist: URI, or Spotify playlist URL'),
    description: z.string().optional().describe('What this lane is for; shown by list_lanes'),
  })
  .strict();

/** The manifest: lane name → entry. Keys are matched case-insensitively. */
export const LaneManifestSchema = z.record(z.string().min(1), LaneEntrySchema);

/**
 * The `*_lane` input a lane-targeted write accepts.
 *
 * A free string, not an enum: the lanes come from a file on the operator's
 * machine, and a schema enum baked at build time would advertise a list the
 * server cannot enforce and would drift the moment the file changes. The
 * refusal for a name that is not there comes from the manifest, and it names
 * the known lanes and the file — which is more use to a caller than a static
 * enum ever was.
 */
export const LaneName = z
  .string()
  .min(1)
  .describe(
    'Lane name from the lane registry (matched case-insensitively). An unknown lane is refused with the '
      + 'known lane names and the manifest path; it is never silently ignored.',
  );

export type LaneEntry = z.infer<typeof LaneEntrySchema>;
export type LaneManifest = Record<string, LaneEntry>;

/**
 * Where the manifest lives. Routed through the store registry so `logout` and
 * `doctor` know about it and no module spells the path a second time.
 */
export function lanesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('lanes', env);
}

/**
 * Read and validate the manifest.
 *
 * ENOENT is a first run and reads as an empty manifest (the caller decides what
 * an absent registry means); every other failure is raised by the shared
 * loader with its bytes preserved. Entries are normalized HERE, so a handler
 * receives a playlist id it can put in a URL without re-validating, and a bad
 * reference fails the load rather than the write.
 */
export async function loadLanes(env: NodeJS.ProcessEnv = process.env): Promise<LaneManifest> {
  return loadSidecar<LaneManifest>(
    lanesFilePath(env),
    () => ({}),
    (value) => {
      const manifest = LaneManifestSchema.parse(value);
      // Normalize after the shape check, so the error names the lane that is
      // malformed rather than surfacing a zod path like `["OSM"].playlist`.
      const out: LaneManifest = {};
      for (const [name, entry] of Object.entries(manifest)) {
        out[name] = {
          playlist: normalizePlaylistReference(entry.playlist),
          ...(entry.description === undefined ? {} : { description: entry.description }),
        };
      }
      return out;
    },
  );
}

/** The outcome of resolving one lane name. */
export type LaneResolution =
  | { ok: true; lane: string; playlistId: string }
  | { ok: false; message: string };

/**
 * Resolve a lane name to a playlist id.
 *
 * Matching is case-insensitive because lanes are user-typed labels, not
 * identifiers; the manifest is free to spell `osm`, `OSM` or `Osm` and the
 * caller gets the same playlist either way. When two entries differ only by
 * case the lookup refuses and names both, rather than picking one — that is
 * the ambiguity this whole module exists to remove, and resolving it by
 * insertion order would reintroduce it.
 */
export function resolveLane(
  manifest: LaneManifest,
  lane: string,
  env: NodeJS.ProcessEnv = process.env,
): LaneResolution {
  const wanted = lane.trim().toLowerCase();
  const matches = Object.keys(manifest).filter((name) => name.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    return { ok: false, message: unknownLaneMessage(manifest, lane, env) };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message:
        `Lane "${lane}" is ambiguous: the manifest defines ${matches.length} lanes that differ only by `
        + `case (${matches.map((m) => `"${m}"`).join(', ')}). Rename all but one in ${lanesFilePath(env)} `
        + 'so the lane resolves to exactly one playlist.',
    };
  }
  const name = matches[0];
  const entry = manifest[name];
  return { ok: true, lane: name, playlistId: entry.playlist };
}

/**
 * Resolve a lane-targeted playlist write to one playlist id.
 *
 * `target_lane` is an ALTERNATIVE spelling of the target, not an addition to
 * it, so the two fields are mutually exclusive and exactly one is required.
 * That rule is enforced here, before any Spotify request:
 *
 *  - both supplied → refuse, naming BOTH fields. Silently preferring
 *    `target_playlist_id` would make a caller who set both believe the lane was
 *    honoured; silently preferring the lane would write to a different playlist
 *    than the id they also passed.
 *  - neither supplied → refuse, naming both, so the message lists the two ways
 *    to say it rather than only the one that happens to be missing.
 *
 * `target_playlist_id` is expected to be already normalized by the shared
 * {@link normalizePlaylistReference} at the schema boundary; it is normalized
 * again here so a caller that reaches this function with a raw URI still lands
 * on the same id rather than a URI in a URL path.
 */
export async function resolveLaneTarget(
  inputs: { target_playlist_id?: string; target_lane?: string },
  env: NodeJS.ProcessEnv = process.env,
  side: 'source' | 'target' = 'target',
): Promise<{ playlistId: string; lane: string | null }> {
  const idField = side === 'source' ? 'source_playlist_id' : 'target_playlist_id';
  const laneField = side === 'source' ? 'source_lane' : 'target_lane';
  const id = inputs.target_playlist_id?.trim();
  const lane = inputs.target_lane?.trim();
  if (id && lane) {
    throw new Error(
      `Provide exactly one of ${idField} or ${laneField}, not both — got ${idField}="${id}" `
      + `and ${laneField}="${lane}". Two ${side} playlists cannot be reconciled, so neither was used and nothing was written.`,
    );
  }
  if (id) return { playlistId: normalizePlaylistReference(id), lane: null };
  if (lane) return requireLane(lane, env);
  throw new Error(
    `Provide exactly one of ${idField} (an id, spotify:playlist: URI, or URL) or ${laneField} `
    + `(a lane name from ${lanesFilePath(env)}). Neither was given, so there is no ${side} playlist and nothing was written.`,
  );
}

/**
 * Resolve a lane name, or throw the refusal.
 *
 * This is the single resolution rule every lane-targeted write calls, exported
 * so a caller cannot grow its own "load the manifest and hope" path. It returns
 * the CANONICAL lane name from the manifest rather than the spelling the caller
 * typed, so a caller that asked for `osm` is told the lane is `OSM` — the same
 * spelling `list_lanes` prints, which is what makes the two answers joinable.
 */
export async function requireLane(
  lane: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ playlistId: string; lane: string }> {
  const manifest = await loadLanes(env);
  const resolution = resolveLane(manifest, lane, env);
  if (!resolution.ok) throw new Error(resolution.message);
  return { playlistId: resolution.playlistId, lane: resolution.lane };
}

/** The playlist id for a lane, or the refusal. The id half of {@link requireLane}. */
export async function requireLanePlaylistId(
  lane: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return (await requireLane(lane, env)).playlistId;
}

/**
 * The refusal for a lane that is not in the manifest.
 *
 * It names the known lanes and the file, because the two realistic causes are
 * different fixes: a typo in the lane name, or a manifest that was never
 * written / is at a different path. A message carrying only "unknown lane"
 * makes the caller guess between them.
 */
export function unknownLaneMessage(
  manifest: LaneManifest,
  lane: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const known = Object.keys(manifest).sort();
  const where = lanesFilePath(env);
  if (known.length === 0) {
    return (
      `Unknown lane "${lane}": no lanes are defined, because ${where} holds an empty manifest. `
      + 'Add an entry like {"OSM": {"playlist": "spotify:playlist:<id>"}} to that file, or pass '
      + 'target_playlist_id directly.'
    );
  }
  return (
    `Unknown lane "${lane}". Known lanes: ${known.join(', ')} (from ${where}). `
    + 'Lane names are matched case-insensitively; pass target_playlist_id to bypass the registry.'
  );
}
