/**
 * export_playlist (#155): dump a playlist's full item list as an M3U or CSV
 * document — either written to a local file (mode 0600) or returned inline
 * (truncated at max_results rows with a footer noting the full length).
 *
 * Items are paged to completion via client.getAllPages; each row nests its
 * playable under `item` (tracks AND episodes both land there). M3U carries
 * music well but not talk content, so podcast episodes are skipped there with
 * a comment count — unless the playlist contains ONLY episodes, in which case
 * they are rendered like tracks so the export is never empty.
 *
 * File mode is confined to the configured output root (#622): output_path is
 * resolved through src/paths.ts, so an absolute path, a `..` segment or a
 * symlink that leaves SPOTIFY_MCP_EXPORT_DIR (default ~/.spotify-mcp/exports)
 * is refused rather than written, and an existing file is only replaced when
 * the caller passes overwrite: true. CSV cells go through src/csvsafe.ts so a
 * playlist name like `=cmd|…` cannot land as a live formula (#630).
 *
 * #EXTINF labels are folded by extinfValue (#631) so a newline or leading '#'
 * in attacker-controlled metadata cannot append a fabricated track line to
 * the document the importer would then read back as playlist content.
 *
 * A written export is a Spotify Content compilation that this Server cannot
 * expire, and it can land in a client-side cloud-sync folder (#702). So the
 * file-mode result reports the resolved path (`output_path_resolved`,
 * distinct from the requested `output_path`), a `retention_note` saying the
 * file is user-managed and must be deleted by the user, and a
 * `cloud_sync_warning` naming the provider's directory when the resolved path
 * sits inside one.
 */
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { resolveMaxResults, sharedListFields } from '../shaping.js';
import { exportRootDir, resolveOutputPath, writeOutputFile } from '../paths.js';
import { csvField } from '../csvsafe.js';
import type {
  PlaylistItemObject,
  SpotifyTrack,
  SpotifyEpisode,
} from '../types/spotify.js';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

/** Raw-JSON rendering for response_format='json' (#51). */
const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

interface ExportRow {
  uri: string;
  title: string;
  /** Track artist names joined ', ', or the show name for episodes. */
  artists: string;
  /** Album name for tracks; empty for episodes. */
  album: string;
  durationMs: number;
  isEpisode: boolean;
}

function extractRow(playable: SpotifyTrack | SpotifyEpisode): ExportRow {
  if (playable.type === 'episode') {
    return {
      uri: playable.uri,
      title: playable.name ?? '',
      artists: playable.show?.name ?? '',
      album: '',
      durationMs: playable.duration_ms ?? 0,
      isEpisode: true,
    };
  }
  return {
    uri: playable.uri,
    title: playable.name ?? '',
    artists: (playable.artists ?? []).map((a) => a.name).join(', '),
    album: playable.album?.name ?? '',
    durationMs: playable.duration_ms ?? 0,
    isEpisode: false,
  };
}

function renderCsv(rows: readonly ExportRow[], includeHeaders: boolean): string {
  const lines: string[] = [];
  if (includeHeaders) lines.push('track_no,title,artists,album,duration_ms,uri');
  rows.forEach((r, i) => {
    lines.push(
      [String(i + 1), r.title, r.artists, r.album, String(r.durationMs), r.uri]
        .map(csvField)
        .join(','),
    );
  });
  return lines.join('\n') + '\n';
}

/**
 * Make one value safe to interpolate into an #EXTINF line (#631).
 *
 * An #EXTINF line is metadata; the line BELOW it is the track. The importer
 * reads every bare `spotify:…` line as a playlist entry, and that metadata is
 * attacker-controlled on any public playlist, so a title of
 * "Song\nspotify:track:INJECTED" would be written out as a second, fabricated
 * track on re-import. Folding CR/LF to a space closes that, and dropping a
 * leading '#' stops a value from opening a comment or directive line.
 */

function extinfValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/^#+/, '');
}

// ---------------------------------------------------------------------------
// #702: retention + deletion disclosure for a written export
// ---------------------------------------------------------------------------

/**
 * The one place the retention wording lives. Every written export is a
 * Spotify Content compilation (title, artists, album, duration and URI per
 * row) that nothing in this Server can later expire: removing the token file
 * and stopping the Server disconnects the profile but leaves every exported
 * document on disk, and no age-based cleanup exists. Without a note in the
 * result, an agent that exports as a side effect of a larger task never
 * surfaces the artifact to the user.
 *
 * Exported (not private) so the portability/listening-history exports, which
 * share the write-a-document-and-return-a-summary pattern, can carry the
 * identical string instead of a drifting paraphrase.
 */
export const EXPORT_RETENTION_NOTE =
  'This file contains Spotify Content exported at your request. Delete it when you no longer ' +
  'need it; Spotify Developer Terms Sec. IV.3.a.i prohibit indefinite storage of Spotify ' +
  'Content. The export is user-managed: it has no expiry, and removing the ' +
  'token file or stopping the Server does not delete it.';

/**
 * Client-side cloud-sync roots, relative to the user's home directory. An
 * export written under one of these leaves the machine: the provider keeps a
 * server-side copy under its own retention, which is a wider blast radius
 * than a local file and is not covered by this Server's deletion duties.
 */
const CLOUD_SYNC_ROOTS: readonly { name: string; rel: string }[] = [
  { name: 'Dropbox', rel: 'Dropbox' },
  { name: 'Google Drive', rel: 'Google Drive' },
  { name: 'Google Drive', rel: 'GoogleDrive' },
  { name: 'OneDrive', rel: 'OneDrive' },
  // iCloud Drive is a per-app container under this root; any of them syncs.
  { name: 'iCloud Drive', rel: 'Library/Mobile Documents' },
];

export interface ExportDisclosure {
  /** Same text in prose and structuredContent, so neither surface hides it. */
  retention_note: string;
  /** Names the provider and root when the file is synced; null otherwise. */
  cloud_sync_warning: string | null;
}

/**
 * Which cloud-sync root (if any) contains this REAL, symlink-resolved file.
 * A directory that does not exist cannot contain the file, so a failed
 * realpath is simply "not that provider" rather than an error.
 */
async function cloudSyncRootOf(file: string): Promise<{ name: string; root: string } | null> {
  const home = homedir();
  if (!home) return null;
  for (const entry of CLOUD_SYNC_ROOTS) {
    const root = await realpath(join(home, entry.rel)).catch(() => null);
    if (!root) continue;
    const rel = relative(root, file);
    // Equal to the root, or below it: a leading `..` (or an absolute rel, which
    // only happens across Windows drives) means it is a different directory.
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return { name: entry.name, root };
    }
  }
  return null;
}

/**
 * Build the disclosure block for a file this tool has just written. `file`
 * must be the resolved path (resolveOutputPath's `file`), not the caller's
 * string, or a relative path or symlink would hide the real location.
 */
export async function exportDisclosure(file: string): Promise<ExportDisclosure> {
  const synced = await cloudSyncRootOf(file);
  return {
    retention_note: EXPORT_RETENTION_NOTE,
    cloud_sync_warning: synced
      ? `${file} is inside the ${synced.name} cloud-synced directory ${synced.root}. ` +
        'The file will be uploaded to that provider and kept under its retention policy, so ' +
        'this export leaves the machine even if you delete the local copy. Keep it out of a ' +
        'synced root, or delete it there as well when the purpose ends.'
      : null,
  };
}

function renderM3u(
  rows: readonly ExportRow[],
  includeHeaders: boolean,
  omittedEpisodes: number,
): string {
  const lines: string[] = [];
  if (includeHeaders) lines.push('#EXTM3U');
  if (omittedEpisodes > 0) {
    lines.push(`# ${omittedEpisodes} episode(s) skipped — M3U does not carry talk content`);
  }
  for (const r of rows) {
    // Integer seconds, rounded, per the EXTINF spec.
    const seconds = Math.round(r.durationMs / 1000);
    lines.push(`#EXTINF:${seconds},${extinfValue(r.artists)} - ${extinfValue(r.title)}`);
    lines.push(r.uri);
  }
  return lines.join('\n') + '\n';
}

export function registerExportTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'export_playlist',
    "Export a playlist's full item list as an M3U playlist file or a CSV spreadsheet. Pages every item; pass output_path to write a file (created with mode 0600) inside the configured output root, or omit it to get the document inline. CSV cells are formula-safe.",
    {
      playlist_id: z.string().describe('Playlist ID'),
      format: z
        .enum(['m3u', 'csv'])
        .default('m3u')
        .describe('Output format: m3u (playable playlist) or csv (spreadsheet)'),
      output_path: z
        .string()
        .optional()
        .describe(
          'Write the full document to this local file (relative paths resolve inside the output root, default ~/.spotify-mcp/exports) instead of returning it inline',
        ),
      overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe('Allow replacing an existing file at output_path (refused by default)'),
      include_headers: z
        .boolean()
        .default(true)
        .describe('Emit the #EXTM3U marker / CSV header row'),
      ...sharedListFields,
    },
    async (args) => {
      const id = encodeURIComponent(args.playlist_id);

      // Existence probe first so an unknown ID fails fast with a clear error
      // instead of silently exporting zero items.
      const meta = await client.get<{ id?: string; name?: string }>(`/playlists/${id}`);
      if (!meta) throw new Error(`Playlist "${args.playlist_id}" not found`);

      const fetchCap = getConfig().fetchAllCap;
      const items = await client.getAllPages<PlaylistItemObject>(`/playlists/${id}/items`, {
        limit: '100',
      }, { maxItems: fetchCap });
      const fetchTruncated = items.length >= fetchCap;

      let unavailable = 0;
      const rows: ExportRow[] = [];
      for (const entry of items) {
        const playable = entry.item;
        if (!playable) {
          unavailable++;
          continue;
        }
        rows.push(extractRow(playable));
      }

      const trackRows = rows.filter((r) => !r.isEpisode);
      const episodeRows = rows.filter((r) => r.isEpisode);
      // M3U carries music well but not talk content: episodes are skipped
      // there unless they are ALL the playlist has. max_results and the
      // inline truncation footer count EXPORTABLE rows, so an M3U of a mixed
      // playlist caps on tracks rather than burning its budget on skipped
      // episodes.
      const omitsEpisodes = args.format === 'm3u' && trackRows.length > 0;
      const exportable = omitsEpisodes ? trackRows : rows;

      const renderDoc = (subset: readonly ExportRow[]): string =>
        args.format === 'csv'
          ? renderCsv(subset, args.include_headers)
          : renderM3u(subset, args.include_headers, omitsEpisodes ? episodeRows.length : 0);

      const basePayload = {
        playlist_id: args.playlist_id,
        playlist_name: meta.name ?? null,
        format: args.format,
        total_items: rows.length,
        tracks: trackRows.length,
        episodes: episodeRows.length,
        unavailable_skipped: unavailable,
        fetch_truncated: fetchTruncated,
        fetch_cap: fetchCap,
        items: rows.map((r, i) => ({
          track_no: i + 1,
          title: r.title,
          artists: r.artists,
          album: r.album,
          duration_ms: r.durationMs,
          uri: r.uri,
          is_episode: r.isEpisode,
        })),
      };

      // ---- File mode: write the FULL document, return a summary ----------
      if (args.output_path !== undefined) {
        const document = renderDoc(exportable);
        // #622: resolve + confine before writing — the caller's path is
        // symlink-resolved and proven to sit inside the output root first, and
        // an existing file is only replaced with an explicit overwrite opt-in.
        const target = await resolveOutputPath({
          root: exportRootDir(),
          target: args.output_path,
          tool: 'export_playlist',
          kind: 'file',
          overwrite: args.overwrite,
        });
        await writeOutputFile(target.file, document);
        const bytes = Buffer.byteLength(document, 'utf8');
        // #702: the artifact is on disk now and nothing here can expire it, so
        // say so — and say WHERE, on the resolved path, not the caller's
        // string, which may be relative or a symlink.
        const disclosure = await exportDisclosure(target.file);
        const payload = {
          ...basePayload,
          // Requested path, verbatim: what the caller asked to write.
          output_path: args.output_path,
          // Absolute, symlink-resolved path of the file that now exists.
          output_path_resolved: target.file,
          bytes,
          truncated: fetchTruncated,
          retention_note: disclosure.retention_note,
          cloud_sync_warning: disclosure.cloud_sync_warning,
        };
        if (args.response_format === 'json') return textResult(jsonText(payload), payload);

        const parts = [
          `Exported ${rows.length} item(s) (${trackRows.length} track(s)` +
            (episodeRows.length > 0 ? `, ${episodeRows.length} episode(s)` : '') +
            `) as ${args.format.toUpperCase()} to ${target.file} (${bytes} bytes).`,
        ];
        if (fetchTruncated) parts.push(`(first ${fetchCap} of ${rows.length}+ — truncated at FETCH_ALL_CAP=${fetchCap}, raise SPOTIFY_MCP_FETCH_ALL_CAP for full export)`);
        if (omitsEpisodes) {
          parts.push(
            `${episodeRows.length} episode(s) were skipped in the M3U output (M3U does not carry talk content).`,
          );
        }
        if (unavailable > 0) parts.push(`${unavailable} unavailable item(s) could not be exported.`);
        parts.push(disclosure.retention_note);
        if (disclosure.cloud_sync_warning) parts.push(`Warning: ${disclosure.cloud_sync_warning}`);
        return textResult(parts.join('\n'), payload);
      }

      // ---- Inline mode: truncate at max_results ROWS with a footer -------
      const cap = resolveMaxResults(args.max_results, getConfig().maxItems);
      const view = exportable.slice(0, cap);
      const truncated = exportable.length > cap || fetchTruncated;
      const document = renderDoc(view);
      const inlineText =
        document +
        (fetchTruncated
          ? `\n[first ${fetchCap} of ${rows.length}+ — raise SPOTIFY_MCP_FETCH_ALL_CAP (currently ${fetchCap}) for full export]\n`
          : '') +
        (exportable.length > cap
          ? `\n[truncated: showing first ${cap} of ${exportable.length} items — ` +
            `full export is ${renderDoc(exportable).split('\n').length - 1} lines; ` +
            `pass output_path or raise max_results for everything]\n`
          : '');

      const payload = {
        playlist_id: args.playlist_id,
        playlist_name: meta.name ?? null,
        format: args.format,
        total_items: rows.length,
        tracks: trackRows.length,
        episodes: episodeRows.length,
        unavailable_skipped: unavailable,
        // Raw parsed items: every playlist row, regardless of M3U episode
        // skipping or inline truncation (returned/truncated describe the
        // rendered document, items stay complete for programmatic use).
        items: basePayload.items,
        returned: view.length,
        truncated,
        fetch_truncated: fetchTruncated,
        fetch_cap: fetchCap,
        bytes: Buffer.byteLength(inlineText, 'utf8'),
      };
      if (args.response_format === 'json') return textResult(jsonText(payload), payload);
      return textResult(inlineText, payload);
    },
  );
}
