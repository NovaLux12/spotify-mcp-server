/**
 * Tests for `src/csvsafe.ts` (#657) — the spreadsheet-injection guard shared by
 * every CSV writer in the server.
 *
 * The module had no importing test, so the two orderings it exists to get right
 * were both unverified:
 *
 *   1. The value is neutralised BEFORE the structural quoting. RFC 4180 quoting
 *      does not help on its own — Excel, LibreOffice and Google Sheets all
 *      evaluate `"=cmd|…"` inside quotes — so the apostrophe has to be on the
 *      value the writer emits, not prepended to the already-quoted cell. The
 *      two orders are observably different for any name that also needs
 *      quoting, which is exactly the shape a hostile playlist name has.
 *   2. The neutralisation covers every lead character a spreadsheet treats as a
 *      formula introducer: `=`, `+`, `-`, `@`, tab and CR. A guard that missed
 *      one of them is a one-character bypass.
 *
 * Run: node --import tsx --test tests/csvsafe.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { csvField, csvTable } from '../src/csvsafe.ts';

/**
 * The properties a spreadsheet parses: a cell is either bare or fully quoted,
 * and a quoted cell's contents are the de-doubled text between the quotes.
 * This is the reader half of the contract, so the assertions below measure the
 * CELL a recipient's parser would see rather than the bytes on the wire.
 */
function parseOneCell(cell: string): string {
  if (!cell.startsWith('"')) return cell;
  assert.ok(cell.endsWith('"'), `quoted cell must close: ${cell}`);
  return cell.slice(1, -1).replace(/""/g, '"');
}

describe('#657 csvsafe: formula payloads are neutralised before quoting', () => {
  it('parses a `=…` name back as inert text, not as a formula', () => {
    const cell = csvField('=cmd|\'/c calc\'!A1');
    assert.equal(
      parseOneCell(cell),
      '\'=cmd|\'/c calc\'!A1',
      'a leading apostrophe is what makes the cell text in Excel/LibreOffice/Sheets',
    );
    assert.equal(cell[0], '\'', `the cell itself must carry the marker, got ${cell}`);
  });

  it('puts the marker on the VALUE, not outside the quotes', () => {
    // This is the ordering assertion. A name that needs structural quoting AND
    // starts with a formula lead character is the only shape that separates the
    // two orders:
    //
    //   correct   neutralise, then quote  ->  "'=a,b"  ->  "'"=a,b""
    //   reversed  quote, then neutralise  ->  ""=a,b"" ->  "'""=a,b"""
    //
    // The reversed cell's parsed contents are the literal text `=a,b`,
    // apostrophe included inside the quotes — a spreadsheet that strips the
    // outer quotes as a structural marker leaves a formula introducer behind
    // for the DDE path, and the two are not the same document.
    const cell = csvField('=a,b');
    assert.equal(cell, '"\'=a,b"', `neutralise-then-quote, got ${cell}`);
    assert.equal(parseOneCell(cell), '\'=a,b');
    assert.ok(!cell.startsWith('"\'"'), 'the marker must sit inside the quotes, not before them');
  });

  it('neutralises every formula-lead character, not just `=`', () => {
    // Each of these is a formula or DDE introducer to some spreadsheet. A guard
    // covering only `=` is bypassed by changing the first character.
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const cell = csvField(`${lead}payload`);
      assert.equal(
        parseOneCell(cell),
        `'${lead}payload`,
        `lead ${JSON.stringify(lead)} must be neutralised, got ${cell}`,
      );
    }
  });

  it('leaves an ordinary name untouched', () => {
    // The negative case carries the weight: a guard that prefixed every cell
    // would pass the tests above and turn every exported name into text.
    for (const value of ['Radiohead', 'Song 2', 'a-b', '1-2', 'nothing special']) {
      assert.equal(csvField(value), value, `${value} needs no marker or quoting`);
    }
  });

  it('leaves a space-led value alone but neutralises a tab-led one', () => {
    // A leading space is not in FORMULA_LEAD, so a space-led name is emitted
    // byte-for-byte. A leading TAB is, and the marker applies to it like any
    // other lead character.
    assert.equal(csvField(' =1+1'), ' =1+1', 'a space is not a formula lead');
    assert.equal(csvField('\t=SUM(A1)'), "'\t=SUM(A1)", 'a tab is a formula lead');
    // Both effects at once: a lead character that also forces structural
    // quoting, which is the shape the ordering test above pins.
    assert.equal(csvField('\t=a,b'), '"\'\t=a,b"');
  });
});

describe('#657 csvsafe: RFC 4180 structural quoting', () => {
  it('quotes and de-doubles an embedded quote', () => {
    const cell = csvField('He said "hi"');
    assert.equal(cell, '"He said ""hi"""');
    assert.equal(parseOneCell(cell), 'He said "hi"');
  });

  it('quotes a comma, a CR and an LF', () => {
    for (const value of ['a,b', 'a\rb', 'a\nb', 'a\nb,c"d']) {
      const cell = csvField(value);
      assert.ok(cell.startsWith('"') && cell.endsWith('"'), `${value} must be quoted, got ${cell}`);
      assert.equal(parseOneCell(cell), value, `${value} must survive the round trip`);
    }
  });

  it('quotes an empty string that carries a formula lead', () => {
    // `=` is both a formula lead and a value; the marker must still be applied.
    assert.equal(csvField('='), "'=");
    assert.equal(csvField('""'), '""""""');
    assert.equal(parseOneCell(csvField('""')), '""');
  });
});

describe('#657 csvsafe: csvTable', () => {
  it('renders a header row plus data rows and terminates the last line', () => {
    const out = csvTable(['Name', 'Artist'], [['Song', 'Band'], ['=evil', 'x,y']]);
    assert.equal(
      out,
      'Name,Artist\nSong,Band\n\'=evil,"x,y"\n',
      'the trailing newline terminates the last row for a strict RFC 4180 reader',
    );
  });

  it('applies the guard to the header row too', () => {
    // A header is a name from the same untrusted source. If only data rows were
    // guarded, an attacker-controlled header was the bypass.
    const out = csvTable(['=cmd', 'x,y'], []);
    assert.equal(out, "'=cmd,\"x,y\"\n");
  });

  it('renders a header-only table', () => {
    assert.equal(csvTable(['a', 'b'], []), 'a,b\n');
  });

  it('renders an empty document for no headers and no rows', () => {
    assert.equal(csvTable([], []), '\n');
  });
});
