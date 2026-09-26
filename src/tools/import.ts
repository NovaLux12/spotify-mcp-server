/**
 * import_playlist (#165): the inverse of export_playlist. Parses an M3U or
 * CSV document — inline content or a local file — extracts Spotify URIs, and
 * appends them to a target playlist in batches of 100.
 *
 * Round-trip guarantee: parses exactly what export_playlist emits (URI on its
 * own line under #EXTINF for M3U; `uri` column for CSV). Non-Spotify lines,
 * comments, and http/file URIs are skipped and counted, never fatal. dry_run
 * previews the extraction without writing anything.
 *
 * Local-file safety (#623): `input_path` is confined to the configured read
 * roots, must be a regular file, and is size-capped by stat() before a byte is
 * read; inline `content` is byte-capped by the schema.
 *
 * Idempotency (#632): URIs already in the target playlist are filtered out, so
 * re-running the same document adds nothing, and an import of 100+ new URIs is
 * elicitation-gated before the first POST.
 */
import { z } from 'zod';
import { capFor } from '../chunk.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import { getConfig } from '../config.js';
import { exportRootDir, maxDocumentBytes, readInputFile, resolveInputPath } from '../paths.js';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { backupDir } from './backup.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import { BATCH_ADD_ELICIT_THRESHOLD } from './playlistbatch.js';
import type { PlaylistItemObject } from '../types/spotify.js';
import { classifySpotifyReference, spotifyUriFromClassification } from '../refs.js';
import { ResponseFormat, normalizePlaylistReference } from '../shaping.js';

const TOOL = 'import_playlist';

type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[]; structuredContent?: Record<string, unknown> };

const textResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
});

/**
 * A playable Spotify URI: tracks AND episodes both import cleanly. The shared
 * reference validator anchors the whole string and admits only a 22-char
 * base62 id (or, with allowShortIds, an alphanumeric one), so a line that
 * merely CONTAINS a URI — the shape an embedded newline in a title renders as
 * — can never be read as one.
 */
function isPlayableUri(value: string): boolean {
  const parsed = classifySpotifyReference(value, undefined, { allowShortIds: true });
  return parsed.valid && parsed.form === 'uri' && (parsed.kind === 'track' || parsed.kind === 'episode');
}

function canonicalPlayableUri(value: string): string {
  const parsed = classifySpotifyReference(value, undefined, { allowShortIds: true });
  const canonical = spotifyUriFromClassification(parsed);
  if (!canonical || parsed.form !== 'uri' || (parsed.kind !== 'track' && parsed.kind !== 'episode')) {
    throw new Error(`Invalid playable Spotify URI: ${value}`);
  }
  return canonical;
}

interface ParsedDocument {
  format: 'm3u' | 'csv';
  /** Deduplicated URIs in first-seen document order. */
  uris: string[];
  /** Lines/rows skipped because they held no extractable Spotify URI. */
  skipped_rows: number;
  /**
   * Every playable URI the document held, repeats included, counted in the
   * same pass that produced `uris`. `uri_occurrences - uris.length` is the true
   * in-document duplicate count; deriving it from a second whole-body match
   * pass is what let the reported figure go negative for CSV.
   */
  uri_occurrences: number;
}

/**
 * Pull every spotify:track:/spotify:episode: URI out of an M3U document.
 * Extended-M3U comment lines (#EXTINF, #…) are metadata; bare URI lines are
 * the playlist order. Duplicate URIs keep their FIRST position.
 *
 * A line counts only when the WHOLE line is the URI, so a URI sitting inside
 * `#EXTINF` metadata — the shape an embedded newline in a title renders as —
 * stays part of a comment and is never extracted.
 */
export function parseM3u(content: string): ParsedDocument {
  const uris: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let occurrences = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('#')) continue;
    if (isPlayableUri(line)) {
      occurrences++;
      if (!seen.has(line)) {
        seen.add(line);
        uris.push(line);
      }
    } else {
      skipped++;
    }
  }
  return { format: 'm3u', uris, skipped_rows: skipped, uri_occurrences: occurrences };
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
 * Pull every spotify:track:/spotify:episode: URI out of a CSV document.
 *
 * WHICH field of a row is the URI is a safety property, not a tidiness one:
 * taking the first field that merely looks like a URI lets a metadata value —
 * a title of `spotify:track:<id>` — masquerade as the row's URI and silently
 * replace the real one. So a declared `uri` column is authoritative when the
 * first row is a header, and otherwise the LAST playable field wins, which is
 * where export_playlist puts it. Duplicate URIs keep their FIRST position.
 */
export function parseCsv(content: string): ParsedDocument {
  const uris: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let occurrences = 0;
  let uriColumn = -1;
  let firstRow = true;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fields = splitCsvRow(line).map((f) => f.trim());
    const playable = fields.filter(isPlayableUri);
    if (firstRow) {
      firstRow = false;
      if (playable.length === 0) {
        // A header row: remember the declared uri column, then skip the row.
        const declared = fields.findIndex((f) => f.toLowerCase() === 'uri');
        if (declared !== -1) uriColumn = declared;
        skipped++;
        continue;
      }
    }
    occurrences += playable.length;
    const declared = uriColumn >= 0 ? fields[uriColumn] : undefined;
    const uri = declared !== undefined && isPlayableUri(declared) ? declared : declared === undefined ? playable[playable.length - 1] : undefined;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      uris.push(uri);
    } else if (!uri) {
      skipped++;
    }
  }
  return { format: 'csv', uris, skipped_rows: skipped, uri_occurrences: occurrences };
}

/** Format auto-detection: M3U markers win; otherwise look at the shape. */
export function detectFormat(content: string): 'm3u' | 'csv' | null {
  if (/^\s*#EXTM3U/m.test(content)) return 'm3u';
  if (isPlayableUri(content.trim())) return 'm3u';
  if (content.split(/\r?\n/).some((line) => splitCsvRow(line).some(isPlayableUri))) return 'csv';
  return null;
}

/**
 * Directories `input_path` may be read from. These are the roots the
 * portability/backup/export tools already own, so a document the server itself
 * wrote is always readable. The portability default is spelled out because
 * `portabilityDir()` in ./portability.ts is module-private — keep the two in
 * step. SPOTIFY_MCP_ALLOW_PATHS adds further roots, separated by the platform
 * path delimiter.
 */
function allowedReadRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.SPOTIFY_MCP_ALLOW_PATHS ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [
    env.SPOTIFY_MCP_PORTABILITY_DIR ?? join(homedir(), '.spotify-mcp', 'portability'),
    backupDir(env),
    exportRootDir(env),
    ...extra,
  ];
}

/**
 * The document the caller pointed at, or the inline body. Every file read goes
 * through resolveInputPath: confined to the allowed roots, regular files only,
 * and size-capped by stat() before a byte is read.
 */
async function loadDocument(args: { content?: string; input_path?: string }): Promise<{ body: string; source: string }> {
  if (args.content !== undefined) return { body: args.content, source: 'inline content' };
  const resolved = await resolveInputPath({
    roots: allowedReadRoots(),
    tool: TOOL,
    target: args.input_path as string,
    envHint:
      'Set SPOTIFY_MCP_PORTABILITY_DIR / SPOTIFY_MCP_BACKUP_DIR / SPOTIFY_MCP_EXPORT_DIR, or add the directory to SPOTIFY_MCP_ALLOW_PATHS.',
  });
  return { body: await readInputFile(resolved, TOOL), source: resolved.path };
}

interface ExistingScan {
  /** URIs already in the playlist. */
  present: Set<string>;
  /** True when the walk hit the configured cap, so `present` is incomplete. */
  truncated: boolean;
}

/**
 * One capped walk of the target playlist's current items (#632). Re-running an
 * import is the natural retry after a partial failure, and without this the
 * second run doubled the playlist.
 */
async function scanExistingUris(client: SpotifyClient, id: string): Promise<ExistingScan> {
  const cap = getConfig().fetchAllCap;
  const items = await client.getAllPages<PlaylistItemObject>(
    `/playlists/${encodeURIComponent(id)}/items`,
    { limit: '100' },
    { maxItems: cap + 1 },
  );
  const truncated = items.length > cap;
  const present = new Set<string>();
  for (const entry of truncated ? items.slice(0, cap) : items) {
    const uri = entry?.item?.uri;
    if (typeof uri === 'string' && uri.length > 0) present.add(uri);
  }
  return { present, truncated };
}

export function registerImportTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'import_playlist',
    "Parse an M3U or CSV document (the inverse of export_playlist) and append its Spotify URIs to a target playlist. Pass the document inline via content, or read it from input_path (a regular file inside the configured read roots). URIs already in the playlist are skipped, so a re-run adds nothing. Adds in batches of 100. Use dry_run=true to preview without writing.",
    {
      playlist_id: z.string().describe('Target playlist ID, spotify:playlist: URI, or share URL'),
      content: z
        .string()
        .optional()
        .superRefine((value, ctx) => {
          if (value === undefined) return;
          const limit = maxDocumentBytes();
          const bytes = Buffer.byteLength(value, 'utf8');
          if (bytes > limit) {
            ctx.addIssue({
              code: 'custom',
              message:
                `content is ${bytes} bytes, over the ${limit}-byte document limit `
                + `(${Math.round(limit / (1024 * 1024))} MB). Split the document and import it in `
                + 'pieces, or raise SPOTIFY_MCP_MAX_DOCUMENT_MB.',
            });
          }
        })
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
      response_format: ResponseFormat,
    },
    async (args) => {
      // Exactly one document source — ambiguity would silently pick one.
      if (!args.content && !args.input_path) {
        throw new Error('Provide the document via content or input_path');
      }
      if (args.content && args.input_path) {
        throw new Error('Pass either content or input_path, not both');
      }

      const { body, source } = await loadDocument(args);

      const fmt =
        args.format ??
        detectFormat(body) ??
        (() => {
          throw new Error(
            'Could not detect the document format — pass format explicitly ("m3u" or "csv")',
          );
        })();
      const parsed = fmt === 'm3u' ? parseM3u(body) : parseCsv(body);
      const canonicalUris: string[] = [];
      const seenCanonicalUris = new Set<string>();
      for (const uri of parsed.uris) {
        const canonical = canonicalPlayableUri(uri);
        if (seenCanonicalUris.has(canonical)) continue;
        seenCanonicalUris.add(canonical);
        canonicalUris.push(canonical);
      }

      // Existence probe so an unknown target fails before any parsing effort
      // is reported as success-shaped output. client.get() throws on 404
      // (SpotifyApiError) rather than returning null, so map that to the
      // friendly message (see #210).
      const playlistId = normalizePlaylistReference(args.playlist_id);
      const id = encodeURIComponent(playlistId);
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

      // Idempotency: never POST a URI the playlist already holds.
      const existing =
        canonicalUris.length > 0
          ? await scanExistingUris(client, id)
          : { present: new Set<string>(), truncated: false };
      const toAdd = canonicalUris.filter((uri) => !existing.present.has(uri));
      const skippedExisting = canonicalUris.length - toAdd.length;
      const duplicatesInDocument = Math.max(0, parsed.uri_occurrences - canonicalUris.length);
      const target = meta.name ?? args.playlist_id;
      const basePayload = {
        playlist_id: args.playlist_id,
        playlist_name: meta.name ?? null,
        format: parsed.format,
        source,
        parsed_uris: canonicalUris.length,
        duplicates_in_document_skipped: duplicatesInDocument,
        skipped_existing: skippedExisting,
        existing_scan_truncated: existing.truncated,
        skipped_rows: parsed.skipped_rows,
        dry_run: args.dry_run,
      };

      if (args.dry_run) {
        return textResult(
          `[dry run] import_playlist — nothing was changed.\n`
            + `Parsed ${canonicalUris.length} unique URI(s) from ${parsed.format.toUpperCase()}`
            + (parsed.skipped_rows > 0 ? ` (${parsed.skipped_rows} unusable row(s) skipped)` : '')
            + `. Would append ${toAdd.length} to "${target}"`
            + (skippedExisting > 0 ? ` (${skippedExisting} already present)` : '')
            + '.',
          { ...basePayload, ok: true },
        );
      }

      if (canonicalUris.length === 0) {
        throw new Error(
          `No spotify:track:/spotify:episode: URIs found in the ${fmt.toUpperCase()} document`,
        );
      }

      if (toAdd.length === 0) {
        return textResult(
          `All ${canonicalUris.length} URI(s) in the ${parsed.format.toUpperCase()} document are already in "${target}" — nothing added.`,
          { ...basePayload, added: 0, batches_sent: 0, ok: true },
        );
      }

      // Large bulk writes prompt first, exactly like batch_add_to_playlist
      // (#632) — a 5,000-URI document used to POST with no confirmation at all.
      if (toAdd.length >= BATCH_ADD_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('import a document into playlist', target, [
            `Add ${toAdd.length} item(s) from the ${parsed.format.toUpperCase()} document to "${target}":`,
            ...toAdd.slice(0, 10).map((uri) => `  - ${uri}`),
            ...(toAdd.length > 10 ? [`  - …and ${toAdd.length - 10} more`] : []),
            ...(skippedExisting > 0 ? [`(${skippedExisting} already in the playlist, skipped)`] : []),
          ]),
        });
        const refusal = requiredConfirmationRefusal(verdict);
        if (refusal) return textResult(refusal.message, refusal.payload);
      }

      // Append in batches of 100 (Spotify's per-request URI cap).
      const itemsPath = `/playlists/${id}/items`;
      let batchesSent = 0;
      let snapshotId: string | undefined;
      const writeCap = capFor('playlist_writes');
      for (let start = 0; start < toAdd.length; start += writeCap) {
        const res = await client.post<{ snapshot_id?: string }>(itemsPath, {
          uris: toAdd.slice(start, start + writeCap),
        });
        batchesSent++;
        if (res?.snapshot_id) snapshotId = res.snapshot_id;
      }

      const summary = {
        ...basePayload,
        added: toAdd.length,
        batches_sent: batchesSent,
        ...(snapshotId ? { snapshot_id: snapshotId } : {}),
      };
      const truncatedNote = existing.truncated
        ? ` (existing-items walk stopped at FETCH_ALL_CAP=${getConfig().fetchAllCap}; some already-present URIs may not have been seen)`
        : '';
      return textResult(
        `Imported ${toAdd.length} item(s) into "${target}" from ${parsed.format.toUpperCase()} `
          + `across ${batchesSent} batch request(s)`
          + (skippedExisting > 0 ? `; skipped ${skippedExisting} already present` : '')
          + (parsed.skipped_rows > 0 ? `; skipped ${parsed.skipped_rows} unusable row(s)` : '')
          + '.'
          + truncatedNote,
        { ...summary, ok: true },
      );
    },
  );
}
