/**
 * Generated documentation inventory guard (#924, #925, #930).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const census = JSON.parse(execFileSync(process.execPath, ['scripts/surface-census.mjs'], {
  cwd: ROOT,
  encoding: 'utf8',
})) as {
  tools: number;
  resources: number;
  resourceTemplates: number;
  prompts: number;
  registrationKeys: number;
  toolModuleFiles: number;
  toolNames: string[];
  manifestToolNames: string[];
  toolInputSchemas: Record<string, { properties?: Record<string, unknown> }>;
  registrationUnits: Array<{ registrar: string; file: string; key: string; ungated: boolean }>;
  registrationKeyNames: string[];
  manifestRegistrationKeys: string[];
  toolsetRegistrationKeys: string[];
  unconditionalRegistrationKeys: string[];
  perModule: Record<string, number>;
  registrySource: string;
};

async function withFixtures<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(ROOT, '.census-fixture-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFailure(args: string[], env: NodeJS.ProcessEnv = {}): string {
  try {
    execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } });
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  }
  assert.fail(`expected command to fail: ${args.join(' ')}`);
}

describe('generated architecture and specification inventory', () => {
  it('passes the offline documentation drift guard', async () => {
    await withFixtures(async (dir) => {
      const file = join(dir, 'census.json');
      await writeFile(file, JSON.stringify(census));
      execFileSync(process.execPath, ['scripts/surface-census.mjs', '--check', '--census-file', file], { cwd: ROOT, stdio: 'pipe' });
    });
  });

  it('derives headline counts from the finalized production stdio registry', () => {
    assert.match(census.registrySource, /src\/index\.ts via stdio tools\/list after production finalizers/);
    assert.equal(
      Object.entries(census.perModule).reduce((sum, [file, count]) => sum + (file.startsWith('src/tools/') ? count : 0), 0),
      census.tools,
    );
  });
  it('attributes the finalized registry exactly through the shared registrar manifest', () => {
    assert.deepEqual(census.manifestToolNames, census.toolNames);
  });

  it('exports every production tool input schema', () => {
    assert.equal(Object.keys(census.toolInputSchemas).length, census.tools);
    for (const name of census.toolNames) {
      assert.ok(census.toolInputSchemas[name]?.properties, `${name} is missing tools/list inputSchema.properties`);
    }
  });

  it('derives registration keys from the production registrar manifest, including ungated units', () => {
    const doctor = census.registrationUnits.find(({ registrar }) => registrar === 'registerDoctorTool');
    assert.deepEqual(doctor, {
      registrar: 'registerDoctorTool',
      file: 'src/tools/doctortool.ts',
      key: 'doctor',
      ungated: true,
    });
    const expectedKeys = [...new Set([
      ...census.manifestRegistrationKeys,
      ...census.toolsetRegistrationKeys,
      ...census.unconditionalRegistrationKeys,
    ])].sort();
    assert.equal(census.registrationKeys, 44);
    assert.deepEqual(census.registrationKeyNames, expectedKeys);

  });

  it('documents the live tools/list, resources, templates, and prompts totals', () => {
    const architecture = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
    for (const claim of [
      `**${census.tools} tools**`,
      `**${census.resources} fixed resources**`,
      `**${census.resourceTemplates} resource templates**`,
      `**${census.prompts} prompts**`,
    ]) {
      assert.ok(architecture.includes(claim), `ARCHITECTURE.md is missing ${claim}`);
      assert.ok(spec.includes(claim), `SPEC.md is missing ${claim}`);
    }
  });

  it('keeps SPEC top-level numbering sequential and its TOC synchronized', () => {
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
    const toc = [...spec.matchAll(/^(\d+)\. \[[^\]]+\]\(#(\d+)-/gm)].map((match) => [Number(match[1]), Number(match[2])]);
    const sections = [...spec.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
    const expected = Array.from({ length: 13 }, (_, index) => index + 1);
    assert.deepEqual(toc, expected.map((ordinal) => [ordinal, ordinal]));
    assert.deepEqual(sections, expected);
  });

  it('checks documented tool names and schemas against the production registry', async () => {
    await withFixtures(async (dir) => {
      const file = join(dir, 'census.json');
      await writeFile(file, JSON.stringify(census));
      execFileSync(process.execPath, ['scripts/check-doc-tool-names.mjs', '--census-file', file], { cwd: ROOT, stdio: 'pipe' });
    });
  });

  it('rejects unknown documented tools and wrong-tool arguments', async () => {
    await withFixtures(async (dir) => {
      const censusFile = join(dir, 'census.json');
      await writeFile(censusFile, JSON.stringify(census));
      const cases = [
        { name: 'unknown tool', source: 'Call not_a_real_tool with `query: "x"`.', expected: /unknown tool/ },
        { name: 'wrong-tool JSON argument', source: '```json\n{"tool":"get_me","playlist_id":"x"}\n```', expected: /not an input parameter of .*get_me/ },
        { name: 'wrong-tool call argument', source: 'Call get_me with `playlist_id: "x"`.', expected: /not an input parameter of .*get_me/ },
      ];
      for (const fixture of cases) {
        const file = join(dir, `${fixture.name.replaceAll(' ', '-')}.md`);
        await writeFile(file, fixture.source);
        assert.match(runFailure(['scripts/check-doc-tool-names.mjs', '--check-fixture', file, '--census-file', censusFile]), fixture.expected);
      }
    });
  });

  it('requires exactly one valid marker pair for every generated block', async () => {
    await withFixtures(async (dir) => {
      const name = 'surface-census';
      const body = 'current';
      const start = '<!-- BEGIN:generated surface-census -->';
      const end = '<!-- END:generated surface-census -->';
      const valid = `${start}\ncurrent\n${end}`;
      const cases = [
        { name: 'missing', source: 'current', expected: /exactly one.*found 0/ },
        { name: 'stale', source: valid.replace('current', 'old'), expected: /stale/ },
        { name: 'duplicate start', source: `${valid}\n${start}`, expected: /found 2/ },
        { name: 'duplicate end', source: `${valid}\n${end}`, expected: /found 2/ },
      ];
      for (const fixture of cases) {
        const file = join(dir, `${fixture.name.replaceAll(' ', '-')}.json`);
        await writeFile(file, JSON.stringify({ source: fixture.source, file: 'README.md', name, body }));
        assert.match(runFailure(['scripts/surface-census.mjs', '--marker-fixture', file]), fixture.expected);
      }
    });
  });
});
