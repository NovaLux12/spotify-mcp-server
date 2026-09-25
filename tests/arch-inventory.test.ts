/**
 * Generated documentation inventory guard (#924, #925, #930).
 *
 * The census owns live-registry enumeration; this test exercises the same
 * offline command CI runs and independently proves the documented totals came
 * from the JSON it prints.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const census = JSON.parse(execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
})) as { tools: number; resources: number; resourceTemplates: number; prompts: number };

describe('generated architecture and specification inventory', () => {
  it('passes the offline documentation drift guard', () => {
    execFileSync(process.execPath, ['scripts/surface-census.mjs', '--check'], { cwd: ROOT });
  });

  it('documents the live tools/list, resources, templates, and prompts totals', () => {
    const architecture = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
    const claims = [
      `**${census.tools} tools**`,
      `**${census.resources} fixed resources**`,
      `**${census.resourceTemplates} resource templates**`,
      `**${census.prompts} prompts**`,
    ];
    for (const claim of claims) {
      assert.ok(architecture.includes(claim), `ARCHITECTURE.md is missing ${claim}`);
      assert.ok(spec.includes(claim), `SPEC.md is missing ${claim}`);
    }
  });

  it('keeps SPEC top-level numbering sequential and its TOC synchronized', () => {
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
    const toc = [...spec.matchAll(/^\d+\. \[[^\]]+\]\(#(\d+)-/gm)].map((match) => Number(match[1]));
    const sections = [...spec.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
    assert.deepEqual(toc, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.deepEqual(sections, toc);
  });
});
