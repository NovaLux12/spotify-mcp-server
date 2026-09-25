/**
 * CSV cell rendering shared by every writer that emits a spreadsheet (#630).
 *
 * Track, artist, album, show and playlist names come from Spotify metadata,
 * which any public playlist controls, so a name like `=cmd|'/c calc'!A1`
 * arrives here as an executable cell in the recipient's spreadsheet. RFC 4180
 * quoting does NOT help: Excel, LibreOffice and Google Sheets all evaluate
 * `"=cmd|…"` inside quotes, so the leading formula character has to be
 * neutralised on the value before the structural quoting is applied.
 */

/** A value starting with one of these is parsed as a formula or DDE payload. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Render one cell: prefix a leading `=`, `+`, `-`, `@`, tab or CR with an
 * apostrophe (the text marker every spreadsheet honours), then apply RFC 4180
 * structural quoting to whatever that produces.
 */
export function csvField(value: string): string {
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Render a header row plus data rows as a complete CSV document. */
export function csvTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [
    headers.map(csvField).join(','),
    ...rows.map((row) => row.map(csvField).join(',')),
  ];
  return lines.join('\n') + '\n';
}
