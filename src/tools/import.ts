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
 *
 * Provenance and purpose (#708): when the write goes out, the prompt and the
 * result both state where the document came from (a path, or plainly "inline,
 * no file"), that the M3U/CSV format declares no creation date, how many URIs
 * were parsed from it, and the one use being made of it — plus whether a human
 * confirmed that use, was asked and declined, was never asked because the
 * batch was under the threshold, or went through SPOTIFY_MCP_CONFIRM=never.
 */
import { z } from 'zod';
import { capFor } from '../chunk.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { SpotifyApiError } from '../client.js';
import { getConfig } from '../config.js';
import {
  READ_ROOTS_ENV_HINT,
  maxDocumentBytes,
  readInputFile,
  readRoots,
  resolveInputPath,
} from '../paths.js';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { backupDir } from './backup.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import { consentAfterGate, consentFields, provenanceNote, provenancePromptLines, type WriteProvenance } from './provenance.js';
import type { ElicitVerdict } from './confirm.js';
import { BATCH_ADD_ELICIT_THRESHOLD } from './playlistbatch.js';
import type { PlaylistItemObject } from '../types/spotify.js';
import { classifySpotifyReference, spotifyUriFromClassification } from '../refs.js';
import { ResponseFormat, normalizePlaylistReference } from '../shaping.js';
import { textResult } from '../result.js';

const TOOL = 'import_playlist';

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
   * The true in-document duplicate count: entries whose extracted URI repeated
   * one already taken, counted in the same pass that produced `uris`.
   *
   * Counted, never derived by subtraction. The previous shape added one to a
   * per-row tally and subtracted `uris.length` at the end, which counted
   * *URI-shaped fields* rather than *URIs actually extracted*: a row whose
   * title happened to be `spotify:track:<id>` and whose real URI sat in a
   * later column contributed 2 to the tally and 1 to `uris`, so a document
   * with no repeat at all reported one duplicate (#632).
   */
  duplicates: number;
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
  let duplicates = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('#')) continue;
    if (isPlayableUri(line)) {
      if (seen.has(line)) {
        duplicates++;
      } else {
        seen.add(line);
        uris.push(line);
      }
    } else {
      skipped++;
    }
  }
  return { format: 'm3u', uris, skipped_rows: skipped, duplicates };
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
  let duplicates = 0;
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
    const declared = uriColumn >= 0 ? fields[uriColumn] : undefined;
    const uri = declared !== undefined && isPlayableUri(declared) ? declared : declared === undefined ? playable[playable.length - 1] : undefined;
    if (!uri) {
      skipped++;
    } else if (seen.has(uri)) {
      // Counted against the URI this row actually yields. A sibling field that
      // merely looks like a URI was never extracted, so repeating it is not a
      // duplicate and must not be counted as one.
      duplicates++;
    } else {
      seen.add(uri);
      uris.push(uri);
    }
  }
  return { format: 'csv', uris, skipped_rows: skipped, duplicates };
}

/** Format auto-detection: M3U markers win; otherwise look at the shape. */
export function detectFormat(content: string): 'm3u' | 'csv' | null {
  if (/^\s*#EXTM3U/m.test(content)) return 'm3u';
  if (isPlayableUri(content.trim())) return 'm3u';
  if (content.split(/\r?\n/).some((line) => splitCsvRow(line).some(isPlayableUri))) return 'csv';
  return null;
}

/**
 * Directories `input_path` may be read from. The definition moved to
 * `readRoots()` in ../paths.js (#623) so that every caller-supplied read in
 * the server — this one, `import_profile_state`, `import_from_sidecar`,
 * `library_snapshot_diff`, `restore_library_snapshot` — is confined by the
 * same list. A second copy here is what let four of those five go unguarded.
 */
function allowedReadRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return readRoots(env);
}

/**
 * The document the caller pointed at, or the inline body. Every file read goes
 * through resolveInputPath: confined to the allowed roots, regular files only,
 * and size-capped by stat() before a byte is read.
 *
 * `path` is null for inline content and `source` stays the human label either
 * way: the provenance record needs to know there was no file, and putting the
 * label 'inline content' into a field typed as a path would be a lie about the
 * type (#708).
 */
async function loadDocument(
  args: { content?: string; input_path?: string },
): Promise<{ body: string; source: string; path: string | null }> {
  if (args.content !== undefined) return { body: args.content, source: 'inline content', path: null };
  const resolved = await resolveInputPath({
    roots: allowedReadRoots(),
    tool: TOOL,
    target: args.input_path as string,
    envHint: READ_ROOTS_ENV_HINT,
  });
  return { body: await readInputFile(resolved, TOOL), source: resolved.path, path: resolved.path };
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
    "Parse an M3U or CSV document (the inverse of export_playlist) and append its Spotify URIs to a target playlist. Pass the document inline via content, or read it from input_path (a regular file inside the configured read roots). URIs already in the playlist are skipped, so a re-run adds nothing. Adds in batches of 100. Use dry_run=true to preview without writing. Result records the document source and the use made of it (consent_note); under 100 new URIs nothing is gated.",
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

      const { body, source, path: documentPath } = await loadDocument(args);

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
      // Two genuinely different spellings of one URI (a short id and its full
      // form, say) collapse during canonicalisation. That is a real in-document
      // duplicate too, so it counts alongside the ones the parser saw.
      const collapsedByCanonicalisation = parsed.uris.length - canonicalUris.length;
      // Non-negative by construction — the parser counts repeats and the
      // canonicalisation gap is a subtraction of a subset — and clamped anyway
      // because this is a public field and a negative here is what agents acted
      // on in the first place (#632).
      const duplicatesInDocument = Math.max(0, parsed.duplicates + collapsedByCanonicalisation);
      const target = meta.name ?? args.playlist_id;
      // #708: the record, built before any gate so the prompt and the result
      // render the same object. `items` is what the DOCUMENT holds (the parsed
      // unique URIs), not what survives the idempotency filter — the write
      // count is its own number and the prompt already states it.
      //
      // The date is null for both sources and always will be: M3U and CSV
      // declare no creation timestamp, so there is nothing for this tool to
      // read. Saying so by name is the honest record; the file's mtime would
      // be a date the filesystem guesses about a path, and a copy resets it.
      const provenanceBase = {
        source: {
          kind: 'import_document' as const,
          path: documentPath,
          items: canonicalUris.length,
          created: null,
          missing_date_reason:
            `the ${parsed.format.toUpperCase()} document format declares no creation date, `
            + 'so the document states nothing about when it was written',
        },
        purpose: `append the Spotify URIs parsed from this ${parsed.format.toUpperCase()} document to the Spotify playlist "${target}"`,
      };
      const prov = (consent: WriteProvenance['consent']): WriteProvenance => ({ ...provenanceBase, consent });
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
          {
            ...basePayload,
            ...consentFields(
              prov({
                state: 'not_requested',
                because: 'dry_run=true — nothing was written and no confirmation was requested',
              }),
            ),
            ok: true,
          },
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
          {
            ...basePayload,
            ...consentFields(
              prov({
                state: 'not_requested',
                because: 'every URI in the document is already in the playlist, so there was no write to confirm',
              }),
            ),
            added: 0,
            batches_sent: 0,
            ok: true,
          },
        );
      }

      // Large bulk writes prompt first, exactly like batch_add_to_playlist
      // (#632) — a 5,000-URI document used to POST with no confirmation at all.
      //
      // #708: the prompt now also says where the document came from, that the
      // format declares no date, how many URIs it held, and what use is being
      // made of it. `verdict` stays null when the batch is under the threshold
      // and no prompt is issued, which the record reports as such.
      const gated = toAdd.length >= BATCH_ADD_ELICIT_THRESHOLD;
      let verdict: ElicitVerdict | null = null;
      let refusal: ReturnType<typeof requiredConfirmationRefusal> = null;
      if (gated) {
        verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('import a document into playlist', target, [
            ...provenancePromptLines(provenanceBase),
            `Add ${toAdd.length} item(s) from the ${parsed.format.toUpperCase()} document to "${target}":`,
            ...toAdd.slice(0, 10).map((uri) => `  - ${uri}`),
            ...(toAdd.length > 10 ? [`  - …and ${toAdd.length - 10} more`] : []),
            ...(skippedExisting > 0 ? [`(${skippedExisting} already in the playlist, skipped)`] : []),
          ]),
        });
        refusal = requiredConfirmationRefusal(verdict);
        if (refusal) {
          return textResult(refusal.message, {
            ...consentFields(
              prov(
                consentAfterGate(verdict, {
                  refusalReason: refusal.reason,
                  notRequestedBecause: '',
                }),
              ),
            ),
            ...refusal.payload,
          });
        }
      }
      const consent = consentAfterGate(verdict, {
        notRequestedBecause:
          `only ${toAdd.length} of the document's URIs would be added, under the `
          + `${BATCH_ADD_ELICIT_THRESHOLD}-item confirmation threshold, so no prompt was issued`,
      });

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
        ...consentFields(prov(consent)),
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
          + truncatedNote
          + `\n#708 ${provenanceNote(prov(consent))}`,
        { ...summary, ok: true },
      );
    },
  );
}
