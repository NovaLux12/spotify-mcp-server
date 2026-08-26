/**
 * import_playlist (#165): the inverse of export_playlist. Parses an M3U or
 * CSV document — inline content or a local file — extracts Spotify URIs, and
 * appends them to a target playlist in batches of 100.
 *
 * Round-trip guarantee: parses exactly what export_playlist emits (URI on its
 * own line under #EXTINF for M3U; `uri` column for CSV). Non-Spotify lines,
 * comments, and http/file URIs are skipped and counted, never fatal. dry_run
 * previews the extraction without writing anything.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import { getConfig } from '../config.js';
import { readFile } from 'node:fs/promises';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

/** A playable Spotify URI: tracks AND episodes both import cleanly. */
const SPOTIFY_URI_RE = /^spotify:(track|episode):[A-Za-z0-9]+$/;

export interface ParsedDocument {
  format: 'm3u' | 'csv';
  /** Deduplicated URIs in first-seen document order. */
  uris: string[];
  /** Lines/rows skipped because they held no extractable Spotify URI. */
  skipped_rows: number;
}

/**
 * Pull every spotify:track:/spotify:episode: URI out of an M3U document.
 * Extended-M3U comment lines (#EXTINF, #…) are metadata; bare URI lines are
 * the playlist order. Duplicate URIs keep their FIRST position.
 */
export function parseM3u(content: string): ParsedDocument {
  const uris: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('#')) continue;
    if (SPOTIFY_URI_RE.test(line)) {
      if (!seen.has(line)) {
        seen.add(line);
        uris.push(line);
      }
    } else {
      skipped++;
    }
  }
  return { format: 'm3u', uris, skipped_rows: skipped };
}

/**
 * RFC-4180-ish single-line CSV row splitter: honours double-quote wrapping
 * ("" escapes a quote), then each field is unwrapped.
 */
export function splitCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Pull every spotify:track:/spotify:episode: URI out of a CSV document,
 * scanning each row's fields (header included) so column order doesn't
 * matter. Duplicate URIs keep their FIRST position.
 */
export function parseCsv(content: string): ParsedDocument {
  const uris: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const uri = splitCsvRow(line)
      .map((f) => f.trim())
      .find((f) => SPOTIFY_URI_RE.test(f));
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      uris.push(uri);
    } else if (!uri) {
      skipped++;
    }
  }
  return { format: 'csv', uris, skipped_rows: skipped };
}

/** Format auto-detection: M3U markers win; otherwise look at the shape. */
export function detectFormat(content: string): 'm3u' | 'csv' | null {
  if (/^\s*#EXTM3U/m.test(content)) return 'm3u';
  if (SPOTIFY_URI_RE.test(content.trim())) return 'm3u';
  if (/(^|\n)\s*[^#\r\n]*\bspotify:(track|episode):/.test(content)) return 'csv';
  return null;
}

export function registerImportTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'import_playlist',
    "Parse an M3U or CSV document (the inverse of export_playlist) and append its Spotify URIs to a target playlist. Pass the document inline via content or read it from input_path. Skips non-Spotify lines, dedupes within the batch, and adds in batches of 100. Use dry_run=true to preview without writing.",
    {
      playlist_id: z.string().describe('Target playlist ID or spotify:playlist: URI'),
      content: z
        .string()
        .optional()
        .describe('The M3U or CSV document body, passed inline'),
      input_path: z
        .string()
        .optional()
        .describe('Read the document from this local file instead of content'),
      format: z
        .enum(['m3u', 'csv'])
        .optional()
        .describe('Document format; auto-detected when omitted'),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe('Parse and report what would be added without touching the playlist'),
    },
    async (args) => {
      // Exactly one document source — ambiguity would silently pick one.
      if (!args.content && !args.input_path) {
        throw new Error('Provide the document via content or input_path');
      }
      if (args.content && args.input_path) {
        throw new Error('Pass either content or input_path, not both');
      }

      const body = args.content ?? (await readFile(args.input_path as string, 'utf8'));

      const fmt =
        args.format ??
        detectFormat(body) ??
        (() => {
          throw new Error(
            'Could not detect the document format — pass format explicitly ("m3u" or "csv")',
          );
        })();
      const parsed = fmt === 'm3u' ? parseM3u(body) : parseCsv(body);

      // Existence probe so an unknown target fails before any parsing effort
      // is reported as success-shaped output. client.get() throws on 404
      // (SpotifyApiError) rather than returning null, so map that to the
      // friendly message (see #210).
      const id = encodeURIComponent(args.playlist_id.replace(/^spotify:playlist:/, ''));
      let meta: { id?: string; name?: string } | null;
      try {
        meta = await client.get<{ id?: string; name?: string }>(`/playlists/${id}`);
      } catch (e) {
        if (e instanceof SpotifyApiError && (e as { status?: number }).status === 404) {
          throw new Error(`Playlist "${args.playlist_id}" not found`);
        }
        throw e;
      }
      if (!meta) throw new Error(`Playlist "${args.playlist_id}" not found`);

      const uriMatchesInDocument = body.match(new RegExp(SPOTIFY_URI_RE.source, 'gm'))?.length ?? 0;
      const basePayload = {
        playlist_id: args.playlist_id,
        playlist_name: meta.name ?? null,
        format: parsed.format,
        parsed_uris: parsed.uris.length,
        duplicates_in_document_skipped: uriMatchesInDocument - parsed.uris.length,
        skipped_rows: parsed.skipped_rows,
        dry_run: args.dry_run,
      };

      if (args.dry_run) {
        return textResult(
          `[dry run] import_playlist — nothing was changed.\n`
            + `Parsed ${parsed.uris.length} unique URI(s) from ${parsed.format.toUpperCase()}`
            + (parsed.skipped_rows > 0 ? ` (${parsed.skipped_rows} unusable row(s) skipped)` : '')
            + `. Would append to "${meta.name ?? args.playlist_id}".`,
          { ...basePayload, ok: true },
        );
      }

      if (parsed.uris.length === 0) {
        throw new Error(
          `No spotify:track:/spotify:episode: URIs found in the ${fmt.toUpperCase()} document`,
        );
      }

      // Append in batches of 100 (Spotify's per-request URI cap).
      const itemsPath = `/playlists/${id}/items`;
      let batchesSent = 0;
      let snapshotId: string | undefined;
      for (let start = 0; start < parsed.uris.length; start += 100) {
        const res = await client.post<{ snapshot_id?: string }>(itemsPath, {
          uris: parsed.uris.slice(start, start + 100),
        });
        batchesSent++;
        if (res?.snapshot_id) snapshotId = res.snapshot_id;
      }

      const summary = {
        ...basePayload,
        added: parsed.uris.length,
        batches_sent: batchesSent,
        ...(snapshotId ? { snapshot_id: snapshotId } : {}),
      };
      return textResult(
        `Imported ${parsed.uris.length} item(s) into "${meta.name ?? args.playlist_id}" `
          + `from ${parsed.format.toUpperCase()} across ${batchesSent} batch request(s)`
          + (parsed.skipped_rows > 0 ? `; skipped ${parsed.skipped_rows} unusable row(s)` : '')
          + '.',
        { ...summary, ok: true },
      );
    },
  );
}
