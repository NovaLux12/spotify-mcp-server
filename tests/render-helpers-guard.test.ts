/**
 * #788: the presentation helpers have exactly one definition, in
 * `src/shaping.ts`, and every call site reaches it by import.
 *
 * This is a source-scanning guard rather than a behavioural one, deliberately.
 * The defect this issue exists to prevent is not a wrong string — it is a
 * second copy of a function. Both former copies passed the suite: each was
 * self-consistent, so every behavioural test stayed green while the two
 * drifted apart (catalog's grew `unresolved`/`degraded` for the batch tools,
 * audiobooks' grew the `extra` passthrough, and neither had the other's
 * options). A behavioural test can only cover the call sites its author
 * happened to invoke; this guard covers every call site that exists now and
 * every one added later, which is the property the issue actually asks for.
 *
 * The market half of the issue was already fixed by #782 (the helpers live in
 * `src/markets.ts`), so `getWithMarketFallback` is guarded here too — the
 * acceptance criterion is a single definition across `src/` for all four.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const TOOLS_DIR = join(SRC, 'tools');
const SHAPING = join(SRC, 'shaping.ts');
const MARKETS = join(SRC, 'markets.ts');

/** The helpers #788 consolidates, and the single module each must live in. */
const SHARED_HELPERS: Record<string, string> = {
  renderList: SHAPING,
  renderSingle: SHAPING,
  jsonResult: SHAPING,
  getWithMarketFallback: MARKETS,
};

/** The modules that must import, not redeclare, the presentation helpers. */
const RENDER_CONSUMERS = ['catalog.ts', 'audiobooks.ts'] as const;

type Definition = { name: string; index: number; line: number; text: string };

/**
 * Local declarations of a helper name, in every form a copy could take:
 * `function f(`, `export function f(`, `async function f(`, `const f = …`,
 * and the generic-carrying `function f<T>(`. A guard that only matched the
 * one form the deleted copies happened to use would pass on a duplicate
 * written in any other form, which is the failure mode this test exists to
 * rule out.
 *
 * `index` is the offset of the NAME itself, taken from the match's own
 * indices — not `indexOf(declared text)`, which lands on the first repeat of
 * the text rather than on the declaration that was just matched.
 */
function localDefinitions(source: string, names: readonly string[]): Definition[] {
  const alt = names.join('|');
  const patterns = [
    new RegExp(`^[^\\S\\n]*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+(${alt})\\b`, 'gmd'),
    new RegExp(`^[^\\S\\n]*(?:export\\s+)?(?:const|let|var)\\s+(${alt})\\b`, 'gmd'),
  ];
  const found: Definition[] = [];
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) {
      const index = m.indices?.[1]?.[0] ?? m.index;
      found.push({ name: m[1], index, line: source.slice(0, m.index).split('\n').length, text: m[0].trim() });
    }
  }
  return found;
}

/** Every `.ts` file under `src/`, recursively, as `path -> source`. */
function allSources(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of allSources(full)) out.set(k, v);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.set(full, readFileSync(full, 'utf8'));
    }
  }
  return out;
}

/**
 * Call sites of a helper: every occurrence of the bare name followed by a
 * call or a generic argument list, EXCLUDING the declaration itself. The
 * exclusion is by construction rather than by line number, so a declaration
 * and a call on one line are still told apart correctly.
 */
function callSites(source: string, name: string): number {
  const declOffsets = new Set(localDefinitions(source, [name]).map((d) => d.index));
  let count = 0;
  for (const m of source.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
    if (declOffsets.has(m.index)) continue;
    const rest = source.slice(m.index + name.length);
    if (/^\s*(?:<[^<>()]*>)?\s*\(/.test(rest)) count++;
  }
  return count;
}

describe('#788 shared render and market helpers', () => {
  it('defines each helper exactly once across src/, in its shared module', () => {
    const names = Object.keys(SHARED_HELPERS);
    const sources = allSources(SRC);
    const violations: string[] = [];
    for (const [file, source] of sources) {
      for (const d of localDefinitions(source, names)) {
        if (file !== SHARED_HELPERS[d.name]) {
          violations.push(`${file}:${d.line} redeclares ${d.name} (${d.text}) — it belongs in ${SHARED_HELPERS[d.name]}`);
        }
      }
    }
    assert.deepEqual(violations, [], `duplicate helper definitions:\n${violations.join('\n')}`);
  });

  it('the shared module exports every helper the guard covers', () => {
    // A rename or a lost export must fail here rather than silently make
    // rule 1 vacuous by having nothing left to duplicate.
    const shaping = readFileSync(SHAPING, 'utf8');
    const markets = readFileSync(MARKETS, 'utf8');
    for (const [name, home] of Object.entries(SHARED_HELPERS)) {
      const source = home === SHAPING ? shaping : markets;
      const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|interface|type)\\s+${name}\\b`).test(source);
      assert.ok(exported, `${name} is no longer exported from ${home.replace(ROOT + '/', '')}`);
    }
  });

  for (const module of RENDER_CONSUMERS) {
    it(`${module} imports the shared render helpers instead of redeclaring them`, () => {
      const source = readFileSync(join(TOOLS_DIR, module), 'utf8');
      const importBlock = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/shaping\.js'/);
      assert.ok(importBlock, `${module} must import the render helpers from ../shaping.js`);
      const imported = importBlock[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const name of ['renderList', 'renderSingle', 'jsonResult']) {
        assert.ok(imported.includes(name), `${module} does not import ${name} from ../shaping.js`);
        assert.deepEqual(
          localDefinitions(source, [name]),
          [],
          `${module} declares its own ${name} — import the shared one instead`,
        );
      }
    });
  }

  it('every render call site resolves to the shared helper', () => {
    // Anchors rule 1 to reality: if the scanner above ever stopped matching
    // the call sites it claims to cover, these counts fail instead of the
    // guard quietly passing over an empty set.
    const total = RENDER_CONSUMERS.map((m) => {
      const source = readFileSync(join(TOOLS_DIR, m), 'utf8');
      return { module: m, renderList: callSites(source, 'renderList'), renderSingle: callSites(source, 'renderSingle') };
    });
    for (const row of total) {
      assert.ok(row.renderList > 0, `scanner found no renderList call sites in ${row.module} — the guard would be vacuous`);
      assert.ok(row.renderSingle > 0, `scanner found no renderSingle call sites in ${row.module} — the guard would be vacuous`);
    }
    const listTotal = total.reduce((n, r) => n + r.renderList, 0);
    const singleTotal = total.reduce((n, r) => n + r.renderSingle, 0);
    // 13 in catalog.ts + 2 in audiobooks.ts, and 7 + 2 for renderSingle. The
    // import specifier is not a call site, so these count calls only.
    assert.equal(listTotal, 15, `expected 15 renderList call sites across ${RENDER_CONSUMERS.join(' + ')}, saw ${listTotal}`);
    assert.equal(singleTotal, 9, `expected 9 renderSingle call sites across ${RENDER_CONSUMERS.join(' + ')}, saw ${singleTotal}`);
  });

  // -------------------------------------------------------------------------
  // Anti-vacuity. A guard that cannot fail is worse than no guard (AGENTS.md
  // §6 — this repo has shipped that bug twice), so the scanner itself is
  // driven against inputs it must reject.
  // -------------------------------------------------------------------------
  describe('the scanner is not vacuous', () => {
    it('flags a duplicate written in every declaration form it claims to cover', () => {
      const forms = [
        'function renderList() { return 1; }',
        'export function renderList() { return 1; }',
        'async function renderList() { return 1; }',
        'function renderList<T>() { return 1; }',
        'const renderList = () => 1;',
        'const renderList = function () { return 1; };',
        'const renderList = async () => 1;',
        'let renderList: RenderFn = () => 1;',
      ];
      for (const form of forms) {
        const found = localDefinitions(`\n${form}\n`, ['renderList']);
        assert.equal(found.length, 1, `scanner missed this duplicate form: ${form}`);
        assert.equal(found[0].name, 'renderList');
      }
    });

    it('flags a duplicate of every guarded helper name', () => {
      for (const name of Object.keys(SHARED_HELPERS)) {
        const found = localDefinitions(`\nfunction ${name}() {}\n`, [name]);
        assert.equal(found.length, 1, `scanner missed a duplicate of ${name}`);
      }
    });

    it('reports zero definitions for a module that only imports', () => {
      const source = readFileSync(join(TOOLS_DIR, 'catalog.ts'), 'utf8');
      assert.deepEqual(localDefinitions(source, ['renderList', 'renderSingle', 'jsonResult']), []);
    });

    it('does not mistake an import or a call for a declaration', () => {
      const source = [
        "import { renderList, renderSingle } from '../shaping.js';",
        'const a = renderList(undefined, [], { header: "h", line: () => "" });',
        'const b = renderSingle("json", {}, []);',
        'const c = someObject.renderList;',
      ].join('\n');
      assert.deepEqual(localDefinitions(source, ['renderList', 'renderSingle', 'jsonResult']), []);
      assert.equal(callSites(source, 'renderList'), 1);
      assert.equal(callSites(source, 'renderSingle'), 1);
    });

    it('counts a generic call site and a plain call site', () => {
      const source = [
        'function renderList<T>(a: T) { return a; }',
        'const x = renderList<number>(1);',
        'const y = renderList(2);',
      ].join('\n');
      // One declaration, two call sites — the declaration must not be counted.
      assert.equal(localDefinitions(source, ['renderList']).length, 1);
      assert.equal(callSites(source, 'renderList'), 2);
    });
  });
});
