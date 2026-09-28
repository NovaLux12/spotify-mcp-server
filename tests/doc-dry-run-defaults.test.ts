/**
 * #1571 — SPEC.md's `dry_run` convention table must match the shipped registry.
 *
 * The doc previously stated that the library, playlist and podcast families
 * "still preview when `dry_run` is omitted and still declare no schema
 * default". Measured against the finalized registry, BOTH halves were false:
 * those families are mid-migration onto `DryRunDefault`, so each one holds both
 * conventions at once, split by MODULE rather than by family. A caller reading
 * the old sentence would have believed an omitted flag was safe across 52 tools
 * where it is not.
 *
 * A prose statement about the registry is exactly the kind that rots silently,
 * which is why the sentence lives next to a measurement rather than next to a
 * citation. This test re-derives the numbers from a real `tools/list` — the
 * path a host uses, not the source text that produced it — and compares them
 * against the table in SPEC.md. It fails in BOTH directions: a module migrating
 * onto `DryRunDefault` changes the measurement without the doc being updated,
 * and a doc edit that no longer matches the registry fails the same comparison.
 *
 * The comparison is against the doc's own table text, parsed out of SPEC.md —
 * not against a constant restated here. Restating the numbers as a constant
 * would make the test a second copy that can drift the same way the prose did,
 * which is the failure this issue exists to correct.
 *
 * Read-only by construction: the stub client below is never called, since
 * nothing here invokes a handler. `tools/list` is all that is read.
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SpotifyClient } from '../src/client.js';
import { REGISTRAR_MANIFEST, applyToolAnnotations, loadManifestRegistrars } from '../src/tools/annotations.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Which published `dry_run` default a tool carries, as the doc's table words it. */
type DefaultKind = 'true' | 'false' | 'absent';

interface AnnotatedRow {
  name: string;
  scopeKey: string;
  kind: DefaultKind;
  readOnly: boolean;
  destructive: boolean;
}

/**
 * One real `tools/list` over the finalized registry, with each tool attributed
 * to the manifest module that registered it so the rows can be grouped by the
 * manifest's own `scopeKey` — the same derivation `tools.dry-run-contract.test.ts`
 * uses for the playback family, rather than a hand-maintained module list.
 *
 * The server's own annotations are applied before the read, because the
 * read-only/write split the classification paragraph asserts is carried by
 * `readOnlyHint` — and `applyToolAnnotations` is a separate step
 * `startMcpServer` runs after registration (`src/server.ts:309`). A probe that
 * skipped it would see `readOnlyHint` undefined on every tool, measure all 53
 * no-default tools as writes, and pass a comparison that was measuring nothing.
 */
async function dryRunRows(): Promise<AnnotatedRow[]> {
  const stub = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
  } as unknown as SpotifyClient;
  const server = new McpServer({ name: 'doc-dry-run-defaults-probe', version: '0.0.0' });

  const moduleByTool = new Map<string, string>();
  const observed = new Set<string>();
  const wrappable = server as unknown as {
    tool: (...args: unknown[]) => unknown;
    registerTool: (...args: unknown[]) => unknown;
  };
  const origTool = wrappable.tool.bind(server);
  const origRegisterTool = wrappable.registerTool.bind(server);
  wrappable.tool = (...args: unknown[]) => {
    observed.add(args[0] as string);
    return origTool(...args);
  };
  wrappable.registerTool = (...args: unknown[]) => {
    observed.add(args[0] as string);
    return origRegisterTool(...args);
  };

  // The manifest holds thunks, not imported registrars (#906), so load them
  // first — the same two steps `startMcpServer` runs.
  const loaded = await loadManifestRegistrars(REGISTRAR_MANIFEST, {
    readOnly: false,
    disableOverrides: new Set<string>(),
    isModuleActive: () => true,
    scopeBlocked: () => false,
  });
  for (const { key, registrar } of loaded) {
    assert.ok(registrar, `${key} has no loaded registrar`);
    const before = new Set(observed);
    registrar(server, stub);
    for (const name of observed) if (!before.has(name)) moduleByTool.set(name, key);
  }
  applyToolAnnotations(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'doc-dry-run-defaults-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    const scopeOfModule = new Map(REGISTRAR_MANIFEST.map((m) => [m.key, m.scopeKey]));
    const rows: AnnotatedRow[] = [];
    for (const tool of tools) {
      const properties = tool.inputSchema?.properties as
        | Record<string, { default?: unknown }>
        | undefined;
      if (!properties?.dry_run) continue;
      const prop = properties.dry_run;
      const moduleKey = moduleByTool.get(tool.name);
      rows.push({
        name: tool.name,
        scopeKey: moduleKey === undefined ? '?' : (scopeOfModule.get(moduleKey) ?? '?'),
        kind: 'default' in prop
          ? (prop.default === true ? 'true' : prop.default === false ? 'false' : 'absent')
          : 'absent',
        readOnly: tool.annotations?.readOnlyHint === true,
        destructive: tool.annotations?.destructiveHint === true,
      });
    }
    return rows;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/** Counts of each published default within one manifest `scopeKey`. */
function tally(rows: AnnotatedRow[], scopeKey: string): Record<DefaultKind, number> {
  const out: Record<DefaultKind, number> = { true: 0, false: 0, absent: 0 };
  for (const row of rows) if (row.scopeKey === scopeKey) out[row.kind] += 1;
  return out;
}

function specText(): string {
  return readFileSync(join(REPO_ROOT, 'SPEC.md'), 'utf8');
}

/**
 * The numbers the SPEC.md table asserts, parsed from its own markdown row.
 * Returns null when the row is absent, which fails the assertion below with a
 * message that says so — a doc that deletes the table must not silently pass a
 * test that only reads the table.
 */
function documentedTally(scopeKey: string): Record<DefaultKind, number> | null {
  const row = specText()
    .split('\n')
    .find((line) => new RegExp(`^\\s*\\|\\s*\`${scopeKey}\``).test(line));
  if (row === undefined) return null;
  // "… | 48 | 1 (`import_playlist`) | 37 |" — the true/false/absent columns, in
  // the order the table header declares them. An em-dash or "0" both read as 0.
  const cells = row.split('|').slice(1, -1).map((c) => c.trim());
  const numeric = cells.slice(1).map((c) => {
    const first = /^-?\d+/.exec(c);
    return first === null ? 0 : Number(first[0]);
  });
  if (numeric.length !== 3 || numeric.some((n) => Number.isNaN(n))) return null;
  return { true: numeric[0], false: numeric[1], absent: numeric[2] };
}

describe('SPEC.md dry_run convention matches the shipped registry (#1571)', () => {
  it('measures a non-empty dry_run surface (the comparison is not vacuous)', async () => {
    const rows = await dryRunRows();
    assert.ok(
      rows.length > 50,
      `only ${rows.length} tools declare dry_run; the probe is not exercising the registry it claims to`,
    );
    // A probe that attributed nothing would make every scopeKey tally zero and
    // every documented number trivially "wrong" in the same way.
    assert.ok(
      rows.some((r) => r.scopeKey !== '?'),
      'no tool was attributed to a manifest module, so the scopeKey grouping is meaningless',
    );
  });

  for (const scopeKey of ['playlists', 'library']) {
    it(`the \`${scopeKey}\` row in SPEC.md matches the measured split`, async () => {
      const measured = tally(await dryRunRows(), scopeKey);
      const documented = documentedTally(scopeKey);
      assert.ok(
        documented !== null,
        `SPEC.md has no dry_run table row for \`${scopeKey}\`; the convention it used to state by hand is now table-driven`,
      );
      assert.deepEqual(
        documented,
        measured,
        `SPEC.md's \`${scopeKey}\` dry_run row is stale. The measured published defaults are `
        + `${measured.true} default:true, ${measured.false} default:false, ${measured.absent} with no default. `
        + 'Re-measure and update the table — do not round a partial migration into a family-wide claim.',
      );
    });
  }

  it('the library family is NOT uniformly preview-by-default, and the doc says so', async () => {
    // The specific claim #1571 was filed against. If every library tool
    // published `default: true`, the old sentence would be true again and the
    // table's mixed row would be the thing that was wrong.
    const measured = tally(await dryRunRows(), 'library');
    assert.ok(
      measured.absent > 0,
      'no library tool declares dry_run without a default — re-check whether the table is still the right shape',
    );
    assert.ok(
      measured.true > 0,
      'no library tool previews by default — remove_from_library (#1566) should be among them',
    );
  });

  it('counts the no-default write tools the way the prose classifies them', async () => {
    // The classification paragraph in SPEC.md deliberately does NOT enumerate
    // ~50 tool names, because a hand-kept list of that size is a list that
    // goes stale silently — it named `save_to_library` as committing on
    // omission after #1567 had moved it onto `DryRunDefault`. What it states
    // instead is a COUNT, and this pins that count to the registry.
    //
    // The split is by `readOnlyHint`, which is the annotation a host already
    // receives, so this is measurable without reading a single handler.
    const rows = await dryRunRows();
    const families = new Set(['playlistfollow', 'playlists', 'library']);
    const noDefault = rows.filter((r) => r.kind === 'absent' && families.has(r.scopeKey));
    const writes = noDefault.filter((r) => r.readOnly !== true);
    const reads = noDefault.filter((r) => r.readOnly === true);
    assert.equal(noDefault.length, 53, `measured ${noDefault.length} no-default tools in the three scopeKeys`);
    assert.equal(writes.length, 49, `measured ${writes.length} no-default WRITE tools in the three scopeKeys`);
    assert.equal(reads.length, 4, `measured ${reads.length} no-default read-only tools in the three scopeKeys`);

    // The three asserts above compare the registry to a constant in THIS file.
    // That is a change-detector, not a doc gate: it fires when the code moves,
    // and says nothing about whether SPEC.md still prints the same numbers.
    // So the numbers the DOC states are parsed out of its own prose and
    // compared to the measurement — otherwise editing "49" to "99" in SPEC.md
    // passes every assertion here, which is the same class of bug as the one
    // this file exists to prevent.
    const spec = specText();
    const claimed = /of the tools in these three `scopeKey`s that publish no `dry_run` default, \*\*(\d+) are write-capable\*\* \(`playlistfollow` (\d+), `playlists` (\d+), `library` (\d+)\)/.exec(
      spec,
    );
    assert.ok(
      claimed !== null,
      'SPEC.md no longer states the write-capable no-default count in the form this test parses',
    );
    const perFamily = (key: string): number =>
      writes.filter((r) => r.scopeKey === key).length;
    assert.deepEqual(
      {
        total: Number(claimed[1]),
        playlistfollow: Number(claimed[2]),
        playlists: Number(claimed[3]),
        library: Number(claimed[4]),
      },
      {
        total: writes.length,
        playlistfollow: perFamily('playlistfollow'),
        playlists: perFamily('playlists'),
        library: perFamily('library'),
      },
      "SPEC.md's write-capable no-default count is stale. Re-measure it rather than adjusting the prose.",
    );
    // The prose names the read-only four individually, so they are pinned by
    // name as well as by count — a tool that migrates onto a default would
    // make SPEC.md's class-3 list wrong, and the count alone would not say so.
    //
    // The search is scoped to the SENTENCE that makes each claim, not the whole
    // file. A bare `spec.includes(name)` is satisfied by the tool's own section
    // further down SPEC.md, so deleting a name from the class-3 list — the
    // exact edit that makes the doc wrong — would still pass. Verified by
    // deleting `remove_unavailable_playlist_items` from the class-2 list and
    // watching this assertion fire only once the scope was narrowed.
    const classList = (anchor: RegExp): string => {
      const m = anchor.exec(spec);
      assert.ok(m !== null, `SPEC.md no longer contains the sentence matching ${anchor}`);
      return m[0];
    };
    const classTwo = classList(
      /The \*\*replace-shaped\*\* writes[^.]*\./s,
    );
    const classThree = classList(
      /of the 53 tools in these `scopeKey`s[^.]*\./s,
    );
    for (const name of reads.map((r) => r.name)) {
      assert.ok(
        classThree.includes(`\`${name}\``),
        `SPEC.md's class-3 list names the read-only no-default tools but omits ${name}`,
      );
    }
    // And the destructive replace-shaped writes, which are the sharpest edge
    // and are the ones a caller most needs named.
    const destructive = writes.filter((r) => r.destructive === true && r.scopeKey !== 'playlistfollow');
    assert.equal(destructive.length, 5, `measured ${destructive.length} destructive no-default writes in playlists`);
    for (const name of destructive.map((r) => r.name)) {
      assert.ok(
        classTwo.includes(`\`${name}\``),
        `SPEC.md's replace-shaped list names the destructive no-default writes but omits ${name}`,
      );
    }
    // The playlistfollow pair is named in the same sentence and is the only
    // destructive no-default write outside `playlists`, so it is pinned here
    // rather than in the count above, which deliberately excludes it.
    for (const name of writes.filter((r) => r.destructive === true && r.scopeKey === 'playlistfollow').map((r) => r.name)) {
      assert.ok(
        classTwo.includes(`\`${name}\``),
        `SPEC.md's replace-shaped list omits the playlistfollow write ${name}`,
      );
    }
  });

  it('no longer claims save_to_library commits on an omitted flag', () => {
    // The regression this test exists to prevent. #1567 moved both halves of
    // the `/me/library` pair onto `DryRunDefault`; an earlier draft of the
    // classification paragraph still described the save half as committing and
    // the module as internally inconsistent, which is the same defect in the
    // doc that #1567 fixed in the code.
    const spec = specText();
    assert.doesNotMatch(
      spec,
      /`save_to_library`[^.]*\bcommits\b/s,
      'SPEC.md still says save_to_library commits on an omitted dry_run; #1567 moved it onto DryRunDefault',
    );
    assert.doesNotMatch(
      spec,
      /internally inconsistent/,
      'SPEC.md still calls the /me/library pair internally inconsistent; #1567 closed that split',
    );
  });
});
