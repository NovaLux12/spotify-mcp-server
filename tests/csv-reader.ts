/**
 * Minimal RFC 4180 row reader for tests (#630).
 *
 * Deliberately an independent decoder rather than a mirror of the writers: a
 * cell assertion then states what a spreadsheet actually receives — quoting,
 * doubled quotes and all — instead of restating the producer's own formatting.
 * `tests/*.test.ts` is the only glob `npm test` runs, so this helper is never
 * collected as a suite.
 */
export function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

/** Split a CSV document into decoded rows. */
export function parseCsvDocument(document: string): string[][] {
  return document
    .split('\n')
    .filter((line) => line !== '')
    .map(parseCsvRow);
}

/**
 * The characters Excel, LibreOffice and Google Sheets treat as "this cell is a
 * formula" when it is the first thing in the cell.
 */
export const FORMULA_LEAD = /^[=+\-@\t\r]/;
