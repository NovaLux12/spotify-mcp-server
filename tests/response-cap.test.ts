/**
 * The one response byte cap (#895).
 *
 * Every test here drives a payload that EXCEEDS `MAX_RESPONSE_BYTES`. A test
 * that only feeds an undersized payload cannot distinguish "the cap fired" from
 * "the helper returned its input", so those tests assert nothing about the cap
 * and are the §6 "a test that cannot fail" failure mode in miniature. The one
 * deliberately-small case below is paired with an identity assertion so it
 * proves the cap does not fire, rather than proving the cap works.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  applyResponseCap,
  installTruncationBoundary,
  MAX_RESPONSE_BYTES,
  type ResponseCapReceipt,
  type TruncationBoundary,
} from '../src/shaping.js';

const TOOL = 'probe_collection';

/** Register one tool so the boundary has a descriptor for it, as in production. */
function boundaryFor(): TruncationBoundary {
  const server = new McpServer({ name: 'response-cap-test', version: '0.0.0' });
  const boundary = installTruncationBoundary(server);
  server.registerTool(
    TOOL,
    { inputSchema: { max_results: z.number().optional() } },
    async () => ({ content: [{ type: 'text', text: '' }] }),
  );
  return boundary;
}

interface Row {
  id: string;
  name: string;
  artists: Array<{ name: string; uri: string }>;
  album: { name: string; uri: string; release_date: string };
}

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}-${'x'.repeat(48)}`,
    name: `Track ${index} ${'name padding '.repeat(6)}`,
    artists: [{ name: `Artist ${index}`, uri: `spotify:artist:a${index}` }],
    album: { name: `Album ${index}`, uri: `spotify:album:b${index}`, release_date: '2026-01-01' },
  }));
}

/**
 * A shaped result in the shape the issue reported: cheap accounting fields that
 * describe what happened, beside expensive bulk arrays.
 */
function oversizedPayload(rowCount = 400): Record<string, unknown> {
  return {
    truncated: false,
    returned: rowCount,
    total: rowCount,
    pagination: { total: rowCount, offset: 0, limit: rowCount, next_offset: null },
    items: rows(rowCount),
    groups: rows(rowCount).map((row) => ({ title: row.name, liked_tracks: [row] })),
  };
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

function receiptOf(structured: Record<string, unknown>): ResponseCapReceipt {
  const receipt = structured.response_cap as ResponseCapReceipt | undefined;
  assert.ok(receipt, 'expected a response_cap receipt on an over-cap payload');
  assert.equal(receipt.response_capped, true);
  return receipt;
}

describe('response byte cap (#895)', () => {
  it('caps an oversized payload and names every field it dropped', () => {
    const payload = oversizedPayload();
    assert.ok(bytesOf(payload) > MAX_RESPONSE_BYTES * 2, 'fixture must exceed the cap');

    const capped = applyResponseCap({ content: [{ type: 'text', text: 'ok' }], structuredContent: payload });
    const structured = capped.structuredContent as Record<string, unknown>;

    assert.ok(bytesOf(structured) <= MAX_RESPONSE_BYTES, 'capped payload must fit the cap');
    const receipt = receiptOf(structured);
    assert.ok(receipt.actual_bytes > MAX_RESPONSE_BYTES);
    assert.equal(receipt.cap_bytes, MAX_RESPONSE_BYTES);

    // The disclosure must name what is gone. An absent field is only honest
    // if something says it is absent.
    const dropped = new Set(receipt.omitted_fields.map((entry) => entry.field));
    assert.ok(receipt.omitted_field_count > 0);
    for (const field of ['items', 'groups']) {
      assert.ok(dropped.has(field), `expected ${field} to be named as omitted`);
      assert.equal(structured[field], undefined, `${field} must not be present in a capped result`);
    }
    assert.ok(receipt.note.includes('were NOT returned'));
  });

  it('keeps the cheap accounting fields and spends the budget on bulk', () => {
    const capped = applyResponseCap({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: oversizedPayload(),
    });
    const structured = capped.structuredContent as Record<string, unknown>;

    // Smallest-first selection is the design: a capped result must still be
    // able to say HOW MUCH there was, or the caller cannot page or report.
    for (const field of ['total', 'returned', 'truncated', 'pagination']) {
      assert.equal(structured[field] !== undefined, true, `${field} must survive the cap`);
    }
    const receipt = receiptOf(structured);
    assert.ok(receipt.retained_fields.includes('total'));
    assert.equal(receipt.omitted_field_count, receipt.omitted_fields.length <= 24 ? receipt.omitted_field_count : 24);
  });

  it('reports the real size of what it dropped, not a guess', () => {
    const payload = oversizedPayload();
    const capped = applyResponseCap({ content: [{ type: 'text', text: 'ok' }], structuredContent: payload });
    const receipt = receiptOf(capped.structuredContent as Record<string, unknown>);

    // The headline number is the whole payload, measured.
    assert.equal(receipt.actual_bytes, bytesOf(payload));
    for (const entry of receipt.omitted_fields) {
      const original = payload[entry.field];
      assert.ok(original !== undefined, `receipt names ${entry.field}, which is not a payload key`);
      // Measured as the field's full contribution to the payload — key and
      // separator included — so the parts account for the whole.
      const contribution = Buffer.byteLength(`${JSON.stringify(entry.field)}:${JSON.stringify(original, null, 2)}`, 'utf8');
      assert.equal(entry.bytes, contribution, `${entry.field} byte count must be measured, not invented`);
    }
  });

  it('result size is independent of input size', () => {
    const small = applyResponseCap({ content: [], structuredContent: oversizedPayload(400) });
    const large = applyResponseCap({ content: [], structuredContent: oversizedPayload(4000) });
    const smallBytes = bytesOf(small.structuredContent);
    const largeBytes = bytesOf(large.structuredContent);

    // 10x the input must not buy 10x the response. The only input-dependent
    // number is the measured `actual_bytes`, which is a count, not content.
    assert.ok(smallBytes <= MAX_RESPONSE_BYTES && largeBytes <= MAX_RESPONSE_BYTES);
    assert.ok(Math.abs(smallBytes - largeBytes) < 4_000, 'a 10x fixture must not change the emitted size');
  });

  it('json-mode text and structuredContent share one cap and never disagree', () => {
    const payload = oversizedPayload();
    const boundary = boundaryFor();
    const shaped = boundary.shape(
      TOOL,
      {},
      {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      },
    ) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };

    const text = shaped.content[0].text;
    assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_RESPONSE_BYTES, 'json-mode text must fit the cap');
    assert.ok(bytesOf(shaped.structuredContent) <= MAX_RESPONSE_BYTES);

    // Neither channel may still be carrying the uncapped payload. This is the
    // property that matters: a host reading the text and a host reading
    // structuredContent get the SAME bounded, self-describing answer.
    assert.notEqual(text, JSON.stringify(payload, null, 2), 'text must not be the full payload');
    assert.deepEqual(JSON.parse(text), shaped.structuredContent);
    assert.ok((JSON.parse(text) as Record<string, unknown>).response_cap);

    // NOTE (#895 acceptance criterion, deliberately NOT met here): the issue
    // also asks that the two channels not be byte-identical copies, which
    // needs the per-tool `emitOnce` migration (payload once in
    // structuredContent, one-line summary in text). That changes what ~590
    // tools return, so it is out of scope for the shared cap. What this change
    // does bound is the duplication: the worst case is now 2x the cap on the
    // wire, where it was previously unbounded on both channels.
    assert.equal(text, JSON.stringify(shaped.structuredContent, null, 2));
  });

  it('caps a bare JSON array in the text block and says how many were dropped', () => {
    const big = rows(600);
    const boundary = boundaryFor();
    const shaped = boundary.shape(TOOL, {}, {
      content: [{ type: 'text', text: JSON.stringify(big, null, 2) }],
    }) as { content: Array<{ text: string }> };

    const text = shaped.content[0].text;
    const jsonPart = text.split('\n\n')[0];
    const kept = JSON.parse(jsonPart) as Row[];
    assert.ok(kept.length < big.length, 'an over-cap array must actually be shortened');
    assert.ok(Buffer.byteLength(jsonPart, 'utf8') <= MAX_RESPONSE_BYTES);
    assert.match(text, /were NOT returned/);
    // The dropped count is measured, not estimated.
    assert.ok(text.includes(String(big.length - kept.length)));
  });

  it('leaves a payload under the cap completely untouched', () => {
    const small = { total: 2, items: rows(2) };
    const result = { content: [{ type: 'text', text: 'ok' }], structuredContent: small };
    assert.equal(applyResponseCap(result), result, 'under-cap results must be returned by identity');
    assert.equal(result.structuredContent.response_cap, undefined);
  });

  it('does not cap an error result', () => {
    const error = { isError: true, content: [{ type: 'text', text: 'x'.repeat(200_000) }] };
    assert.equal(applyResponseCap(error), error);
  });

  it('is enforced by the production boundary, not only by direct calls', () => {
    const boundary = boundaryFor();
    const shaped = boundary.shape(TOOL, {}, {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: oversizedPayload(),
    }) as { structuredContent: Record<string, unknown> };

    // Reached through installTruncationBoundary -> the path every tool takes.
    assert.ok(bytesOf(shaped.structuredContent) <= MAX_RESPONSE_BYTES);
    assert.ok(receiptOf(shaped.structuredContent).omitted_field_count > 0);
  });
});
