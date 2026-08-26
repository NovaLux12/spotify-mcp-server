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
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getConfig } from '../config.js';
import { resolveMaxResults, sharedListFields } from '../shaping.js';
import { writeFile } from 'node:fs/promises';
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

/**
 * RFC 4180 field quoting: wrap and double quotes only when the value
 * contains a comma, quote, CR, or LF.
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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
    lines.push(`#EXTINF:${seconds},${r.artists} - ${r.title}`);
    lines.push(r.uri);
  }
  return lines.join('\n') + '\n';
}

export function registerExportTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'export_playlist',
    "Export a playlist's full item list as an M3U playlist file or a CSV spreadsheet. Pages every item; pass output_path to write a file (created with mode 0600) or omit it to get the document inline.",
    {
      playlist_id: z.string().describe('Playlist ID'),
      format: z
        .enum(['m3u', 'csv'])
        .default('m3u')
        .describe('Output format: m3u (playable playlist) or csv (spreadsheet)'),
      output_path: z
        .string()
        .optional()
        .describe('Write the full document to this local file instead of returning it inline'),
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
        await writeFile(args.output_path, document, { mode: 0o600 });
        const bytes = Buffer.byteLength(document, 'utf8');
        const payload = {
          ...basePayload,
          output_path: args.output_path,
          bytes,
          truncated: fetchTruncated,
        };
        if (args.response_format === 'json') return textResult(jsonText(payload), payload);

        const parts = [
          `Exported ${rows.length} item(s) (${trackRows.length} track(s)` +
            (episodeRows.length > 0 ? `, ${episodeRows.length} episode(s)` : '') +
            `) as ${args.format.toUpperCase()} to ${args.output_path} (${bytes} bytes).`,
        ];
        if (fetchTruncated) parts.push(`(first ${fetchCap} of ${rows.length}+ — truncated at FETCH_ALL_CAP=${fetchCap}, raise SPOTIFY_MCP_FETCH_ALL_CAP for full export)`);
        if (omitsEpisodes) {
          parts.push(
            `${episodeRows.length} episode(s) were skipped in the M3U output (M3U does not carry talk content).`,
          );
        }
        if (unavailable > 0) parts.push(`${unavailable} unavailable item(s) could not be exported.`);
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
