import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { SpotifyApiError } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerPlaylistMiscTools } from '../src/tools/playlistmisc.js';
import { registerPlaylistFollowTools } from '../src/tools/playlistfollow.js';
import {
  classifyToolAnnotations,
  MUTATING_PREFIXES,
  DESTRUCTIVE_PREFIXES,
  READ_ONLY_PREFIXES,
  READ_ONLY_OVERRIDES,
} from '../src/tools/annotations.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface RecordedCall { method: string; path: string; arg?: unknown; }
type Responder = (path: string, arg?: unknown) => unknown;
interface RegisteredTool { name: string; description: string; validate: (a: Record<string, unknown>) => Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{type:string;text:string}>; structuredContent?: Record<string, unknown> }>; }

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    async get<T>(p: string, params?: Record<string, string>): Promise<T | null> { calls.push({ method:'GET', path:p, arg: params }); return responder(p, params) as T | null; },
    async post<T>(p: string, b?: unknown): Promise<T | null> { calls.push({ method:'POST', path:p, arg:b }); return responder(p, b) as T | null; },
    async put<T>(p: string, b?: unknown): Promise<T | null> { calls.push({ method:'PUT', path:p, arg:b }); return responder(p, b) as T | null; },
    async putRaw(p: string, b: string): Promise<void> { calls.push({ method:'PUT_RAW', path:p, arg:b }); await responder(p, b); },
    async delete<T>(p: string, b?: unknown): Promise<T | null> { calls.push({ method:'DELETE', path:p, arg:b }); return responder(p, b) as T | null; },
    async getAllPages<T>(path: string, params?: Record<string,string>, opts?: { maxItems?: number }): Promise<T[]> {
      const maxItems = opts?.maxItems ?? 500;
      const all: T[] = []; let offset=0;
      for(;;){ const page = await (this as unknown as { get: (p:string,pr?:Record<string,string>)=>Promise<SpotifyPaged<T> | null> }).get(path, {...params, offset:String(offset)}); if(!page||!Array.isArray(page.items)) break; all.push(...page.items); if(all.length>=maxItems) return all.slice(0,maxItems); const limit = typeof page.limit==='number'&&page.limit>0?page.limit:page.items.length; offset+=limit; if(page.items.length===0||page.items.length<limit) break; if(typeof page.total==='number'&&offset>=page.total) break; }
      return all;
    },
  }; return client;
}
function harness(responder: Responder=()=>null, elicitResult?: unknown) {
  const prompts: string[] = [];
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name:string,description:string,schema:z.ZodRawShape,handler:RegisteredTool['handler']){ registered.push({name,description,validate:(a)=>z.object(schema).parse(a),handler}); },
    registerTool(name:string,cfg:{description?:string;inputSchema?:z.ZodType},handler:RegisteredTool['handler']){ registered.push({name,description:cfg.description??'',validate:(a)=>(cfg.inputSchema as z.ZodType).parse(a),handler}); },
    ...(elicitResult!==undefined?{server:{getClientCapabilities:()=>({elicitation:{form:{}}}),async elicitInput(req:{message:string}){ prompts.push(req.message); if(elicitResult instanceof Error) throw elicitResult; return elicitResult; }}}:{}),
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  // Two manifest rows, two registrars (#1005): pin/unpin moved to
  // playlistfollow.ts so they can carry their own /me/library scope key.
  registerPlaylistMiscTools(fakeServer, client as unknown as SpotifyClient);
  registerPlaylistFollowTools(fakeServer, client as unknown as SpotifyClient);
  return { registered, client, prompts, invoke: async (name:string,args:Record<string,unknown>)=>{ const t=registered.find(x=>x.name===name); assert.ok(t,`tool ${name} registered`); return t.handler(t.validate(args)); } };
}
const textOf=(o:{content:Array<{text:string}>})=>o.content[0].text;
const track=(id:string)=>({ uri:`spotify:track:${id}`, name:`Track ${id}`, artists:[{name:`Artist ${id}`}] });

describe('follow_playlist (#1099 rename)',()=>{
  it('PUTs the playlist URI to /me/library after confirmation (Feb 2026)',async()=>{
    const h=harness(()=>null,{action:'accept',content:{confirm:true}});
    const out=await h.invoke('follow_playlist',{playlist_id:'pl1',dry_run:false});
    const puts=h.client.calls.filter(c=>c.method==='PUT');
    assert.equal(puts.length,1);
    // Assert the real request, not the return value: a stub answers whatever
    // path it is handed, so only the recorded path/URI can catch a regression
    // back onto the removed PUT /playlists/{id}/followers.
    assert.equal(puts[0].path,'/me/library?uris=spotify%3Aplaylist%3Apl1');
    assert.equal(puts[0].arg,undefined,'/me/library carries uris in the query, not a body');
    assert.ok(!h.client.calls.some(c=>c.path.includes('/followers')),'no request may touch the removed endpoint');
    assert.match(textOf(out),/Saved playlist pl1 to your library/);
  });
  it('rejects public=false: the replacement has no visibility flag',async()=>{
    const h=harness(()=>null,new Error('must not elicit'));
    await assert.rejects(
      ()=>h.invoke('follow_playlist',{playlist_id:'pl1',public:false,dry_run:false}),
      /no visibility parameter/,
    );
    assert.equal(h.client.calls.length,0,'refuses before issuing any request');
  });
  it('accepts public=true and sends no body',async()=>{
    const h=harness(()=>null,{action:'accept',content:{confirm:true}});
    await h.invoke('follow_playlist',{playlist_id:'pl1',public:true,dry_run:false});
    assert.equal(h.client.calls[0].arg,undefined);
    assert.equal(h.client.calls[0].path,'/me/library?uris=spotify%3Aplaylist%3Apl1');
  });
  it('the confirmation prompt asserts no visibility the request never sends',async()=>{
    // public:true and the omitted case issue byte-identical requests, so the
    // prompt must be byte-identical too. Before the fix the prompt
    // interpolated "(public: true)" — telling the user their follow would be
    // public at the exact moment they authorised a private library save.
    const flagged=harness(()=>null,{action:'accept',content:{confirm:true}});
    await flagged.invoke('follow_playlist',{playlist_id:'pl1',public:true,dry_run:false});
    const bare=harness(()=>null,{action:'accept',content:{confirm:true}});
    await bare.invoke('follow_playlist',{playlist_id:'pl1',dry_run:false});
    assert.equal(flagged.prompts.length,1);
    assert.equal(flagged.prompts[0],bare.prompts[0],
      'public:true must not change the prompt when it does not change the request');
    assert.doesNotMatch(flagged.prompts[0],/public/i,
      'the prompt must not claim a visibility the request never sends');
    assert.equal(flagged.prompts[0],'About to follow playlist "pl1":\n- Save playlist pl1 to your library\n\nProceed?');
    // ...and the request it authorises really is the bodyless library save.
    assert.equal(flagged.client.calls[0].arg,undefined);
    assert.equal(flagged.client.calls[0].path,'/me/library?uris=spotify%3Aplaylist%3Apl1');
  });
  it('previews by default: an omitted dry_run issues no PUT (#870)',async()=>{
    const h=harness(()=>null,new Error('must not elicit'));
    const out=await h.invoke('follow_playlist',{playlist_id:'pl1'});
    assert.equal(h.client.calls.length,0);
    assert.match(textOf(out),/dry run/);
    assert.equal(out.structuredContent?.would_follow,true);
  });
  it('declined confirmation refuses without PUTting',async()=>{
    const h=harness(()=>null,{action:'decline'});
    const out=await h.invoke('follow_playlist',{playlist_id:'pl1',dry_run:false});
    assert.equal(h.client.calls.length,0);
    assert.match(textOf(out),/Cancelled/);
    assert.equal(out.structuredContent?.cancelled,true);
  });
  it('a failed elicitation refuses fail-closed rather than PUTting',async()=>{
    const h=harness(()=>null,new Error('transport failed'));
    const out=await h.invoke('follow_playlist',{playlist_id:'pl1',dry_run:false});
    assert.equal(h.client.calls.length,0);
    assert.equal(out.structuredContent?.reason,'elicitation_failed');
  });
  it('an unpromptable client is refused unless SPOTIFY_MCP_CONFIRM=never',async()=>{
    const unsupported=harness(()=>null);
    const out=await unsupported.invoke('follow_playlist',{playlist_id:'pl1',dry_run:false});
    assert.equal(unsupported.client.calls.length,0);
    assert.equal(out.structuredContent?.reason,'confirmation_unavailable');
    const previous=process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM='never';
    try{
      const bypass=harness(()=>null);
      const done=await bypass.invoke('follow_playlist',{playlist_id:'pl1',dry_run:false});
      assert.equal(bypass.client.calls.filter(c=>c.method==='PUT').length,1);
      assert.match(textOf(done),/Saved playlist pl1 to your library/);
    } finally {
      if(previous===undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM=previous;
    }
  });
});
describe('unfollow_playlist (#1099 rename)',()=>{
  it('dry_run previews without DELETE',async()=>{
    const h=harness(()=>null,new Error('must not elicit'));
    const out=await h.invoke('unfollow_playlist',{playlist_id:'pl1',dry_run:true});
    assert.equal(h.client.calls.length,0);
    assert.match(textOf(out),/dry run/);
  });
  it('DELETEs the playlist URI from /me/library after elicitation accept',async()=>{
    const h=harness(()=>null,{action:'accept',content:{confirm:true}});
    const out=await h.invoke('unfollow_playlist',{playlist_id:'pl1'});
    const dels=h.client.calls.filter(c=>c.method==='DELETE');
    assert.equal(dels.length,1);
    // Same reasoning as pin: pin the recorded request, not the reply.
    assert.equal(dels[0].path,'/me/library?uris=spotify%3Aplaylist%3Apl1');
    assert.ok(!h.client.calls.some(c=>c.path.includes('/followers')),'no request may touch the removed endpoint');
    assert.match(textOf(out),/Removed playlist pl1 from your library/);
  });
  it('declined cancels',async()=>{
    const h=harness(()=>null,{action:'decline'});
    const out=await h.invoke('unfollow_playlist',{playlist_id:'pl1'});
    assert.equal(h.client.calls.length,0);
    assert.match(textOf(out),/Cancelled/);
  });
});

// ---------------------------------------------------------------------------
// #1100 — unfollow_playlist refuses in the same shape as follow_playlist
//
// This is a safety change, so every test below is about the gate FAILING
// CLOSED. The bug was not that unfollow could write without confirmation — it
// could not, and still cannot — but that the two halves of one feature
// disagreed about what "refused" looks like: follow returned a machine-readable
// `reason` while unfollow threw a bare Error. A host that keys off that
// discriminator had to special-case one of its own inverse pair.
//
// #1099 renamed the pair; the gate assertions below are unchanged by that,
// because both names are registered against the SAME handler. An alias with a
// copied body would be free to drift, and the first thing to drift in a copy of
// a gated write is the gate — so the alias is asserted against it directly
// further down.
//
// Assertions are on PARSED STRUCTURE (structuredContent fields), never on
// substrings of the prose: `text.includes('elicitation_failed')` would pass on
// a payload that merely mentioned the word, which is the exact class of
// decoration AGENTS.md §6 warns about.
// ---------------------------------------------------------------------------

describe('unfollow_playlist refusal contract (#1100, #1099)', () => {
  /**
   * Drive unfollow_playlist to the point where the verdict is decided, with the
   * elicitation stub installed, and return both the recorded calls and the
   * result so a test can assert on each independently.
   *
   * No `server` property at all = a host that never advertised elicitation,
   * which is how an unpromptable client reaches the `unsupported` verdict.
   */
  const attempt = (elicitResult?: unknown) => {
    const h = harness(() => null, elicitResult);
    return h.invoke('unfollow_playlist', { playlist_id: 'pl1', dry_run: false })
      .then((out) => ({ out, deletes: h.client.calls.filter((c) => c.method === 'DELETE') }));
  };

  it('refuses EVERY non-confirming verdict without a DELETE (the fail-closed core)', async () => {
    // Each row: a host that cannot produce an explicit accept. If any of these
    // ever writes, the gate has been weakened — that is the whole assertion.
    const refusals = [
      { label: 'declined', elicit: { action: 'decline' } },
      { label: 'cancel', elicit: { action: 'cancel' } },
      { label: 'accept-without-confirm', elicit: { action: 'accept', content: { confirm: false } } },
      { label: 'malformed-result', elicit: { nothing: 'usable' } },
      { label: 'transport-error', elicit: new Error('elicitation transport failed') },
      { label: 'unpromptable-host', elicit: undefined },
    ] as const;

    for (const { label, elicit } of refusals) {
      const { out, deletes } = await attempt(elicit);
      assert.equal(deletes.length, 0, `${label}: an unconfirmed unpin must never reach Spotify`);
      assert.equal(out.structuredContent?.ok, false, `${label}: refusal must be ok:false`);
      assert.equal(out.structuredContent?.cancelled, true, `${label}: refusal must be cancelled:true`);
    }
  });

  it('carries a machine-readable `reason` on every refusal that distinguishes one', async () => {
    // The discriminator a host keys off. Before #1100 the 'error' verdict threw
    // instead, so this field did not exist for two of the three outcomes.
    const cases = [
      { label: 'transport-error', elicit: new Error('boom'), reason: 'elicitation_failed' },
      { label: 'unpromptable-host', elicit: undefined, reason: 'confirmation_unavailable' },
    ] as const;

    for (const { label, elicit, reason } of cases) {
      const { out } = await attempt(elicit);
      assert.equal(
        out.structuredContent?.reason,
        reason,
        `${label}: structuredContent.reason must be the discriminator, not prose`,
      );
      // Guard against the substring trap: a payload that merely NAMED the value
      // in prose while omitting the field would pass a text check. The field
      // assertion above is the real one; this documents why it is a field read.
      assert.equal(typeof out.structuredContent?.reason, 'string');
    }
  });

  it('a declined prompt refuses with no `reason` — the shape follow_playlist already returns', async () => {
    // Deliberate asymmetry, pinned: `declined` is the human's own "no", so the
    // payload is the bare {ok:false, cancelled:true} and carries no reason.
    // Asserting an exact object (not a field or two) is what stops a future
    // edit from quietly bolting an extra field onto this specific verdict. It
    // also pins that a CANONICAL call carries no deprecation keys at all —
    // #1099's aliases must not leak metadata into the names that replace them.
    const { out } = await attempt({ action: 'decline' });
    assert.deepEqual(out.structuredContent, { ok: false, cancelled: true });
  });

  it('refuses in the SAME shape as follow_playlist for the same verdict (#1100 was the divergence)', async () => {
    // The regression that matters: parity is asserted by comparing the two
    // tools' payloads for the same stubbed verdict, not by re-asserting each
    // tool's values. If one half of the pair drifts, this fails even if both
    // still pass their own standalone tests.
    for (const [label, elicit] of [
      ['declined', { action: 'decline' }],
      ['transport-error', new Error('boom')],
      ['unpromptable-host', undefined],
    ] as const) {
      const unfollow = await attempt(elicit);
      const followHarness = harness(() => null, elicit);
      const follow = await followHarness.invoke('follow_playlist', { playlist_id: 'pl1', dry_run: false });
      assert.deepEqual(
        unfollow.out.structuredContent,
        follow.structuredContent,
        `${label}: follow and unfollow must return an identical refusal payload`,
      );
      // The refusal text is operation-agnostic by design, so this is a plain
      // equality now. It used to need a pin->unpin substitution, which is
      // itself the point: the two halves no longer speak in different verbs.
      assert.equal(
        textOf(unfollow.out),
        textOf(follow),
        `${label}: the human-readable refusal must also match across the pair`,
      );
    }
  });

  it('SPOTIFY_MCP_CONFIRM=never remains the one sanctioned bypass, and only for it', async () => {
    const previous = process.env.SPOTIFY_MCP_CONFIRM;
    try {
      // Any value other than the exact string is not the bypass.
      for (const notNever of ['', 'yes', '1', 'NEVER', 'never ']) {
        process.env.SPOTIFY_MCP_CONFIRM = notNever;
        const { deletes } = await attempt(undefined);
        assert.equal(
          deletes.length,
          0,
          `SPOTIFY_MCP_CONFIRM=${JSON.stringify(notNever)} must not unlock the gate`,
        );
      }

      process.env.SPOTIFY_MCP_CONFIRM = 'never';
      const { deletes } = await attempt(undefined);
      assert.equal(deletes.length, 1, 'the deliberate automation bypass must still write');
    } finally {
      if (previous === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
      else process.env.SPOTIFY_MCP_CONFIRM = previous;
    }
  });

  it('a confirmed prompt is the only path that DELETEs, and it deletes the library URI', async () => {
    const { out, deletes } = await attempt({ action: 'accept', content: { confirm: true } });
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].path, '/me/library?uris=spotify%3Aplaylist%3Apl1');
    assert.equal(out.structuredContent?.ok, true);
  });

  it('advertises destructiveHint: true, and the hint comes from the OVERRIDES table', async () => {
    // The hint a host reads before deciding whether to auto-approve. It is a
    // static annotation applied by applyToolAnnotations, NOT the elicitation
    // gate: this test is about classification, and the gate is covered by the
    // fail-closed tests above.
    const annotations = classifyToolAnnotations('unpin_playlist');
    assert.equal(annotations.destructiveHint, true, 'unpin_playlist removes a library entry');
    assert.notEqual(annotations.readOnlyHint, true, 'a write must not claim readOnlyHint');

    // The premise this fix rests on, asserted so it cannot rot silently. `unpin`
    // is in NEITHER prefix list (both regexes are anchored, and the mutating
    // list has `pin` but not `unpin`), so the name alone classified a library
    // removal as a harmless write — that is why the OVERRIDES row exists. If a
    // future edit adds `unpin` to either list, this fails and the row should be
    // deleted rather than left as a second source of truth that can disagree
    // with the first. Note the honest corollary: the tool is ALSO absent from
    // MUTATING_PREFIXES, which is why the surface audit needed the audited
    // DESTRUCTIVE_OVERRIDES escape rather than mutating-verb membership.
    assert.equal(DESTRUCTIVE_PREFIXES.test('unpin_playlist'), false);
    assert.equal(MUTATING_PREFIXES.test('unpin_playlist'), false);
    assert.equal(READ_ONLY_PREFIXES.test('unpin_playlist'), false);

    // #1099 renamed the pair to follow_playlist/unfollow_playlist, and
    // `unfollow` is ALREADY in both prefix lists — so the renamed tool is
    // classified correctly with no override of its own. Asserted here so the
    // rename carries this fix across rather than needing it re-applied.
    assert.equal(DESTRUCTIVE_PREFIXES.test('unfollow_playlist'), true);
    assert.equal(MUTATING_PREFIXES.test('unfollow_playlist'), true);
    assert.equal(classifyToolAnnotations('unfollow_playlist').destructiveHint, true);
    // A follow is a library save, not a removal, so it must NOT claim the
    // destructive hint — the one place the old pair could have over-corrected.
    assert.equal(classifyToolAnnotations('follow_playlist').destructiveHint, false);
    assert.equal(classifyToolAnnotations('follow_playlist').readOnlyHint, undefined);

    // The #1100 row is still LOADED: the deprecated `unpin_playlist` alias is
    // registered for one more release and still needs its hint. It retires in
    // 2.1 with the alias, which is what makes this assertion worth making now.
    assert.equal(READ_ONLY_OVERRIDES.has('unpin_playlist'), false);
  });
});

describe('February 2026 removed-endpoint guards (playlist follow family)',()=>{
  // The follow family moved to playlistfollow.ts (#1005); this guard has to
  // read the file that actually builds the request, or it protects nothing.
  const srcPath=join(dirname(fileURLToPath(import.meta.url)),'..','src','tools','playlistfollow.ts');
  const src=readFileSync(srcPath,'utf8');

  it('names no removed endpoint in code — only in prose',()=>{
    // Deliberately not a call-site regex. The old guard matched
    // `client.put(`…/followers`)`, but this module builds the path through
    // `playlistLibraryPath`, so no real call site could ever match it and a
    // regression injected into that helper left the guard green. This rule is
    // shape-agnostic: any `/followers` (or `/me/following`) on a non-comment
    // line is a removed request path in the making, wherever it is spelled —
    // inline, helper return, or concatenation. Naming the removed endpoint in
    // comments stays legal, because that is where the migration note lives.
    const offenders=src.split('\n')
      .map((line,i)=>({n:i+1,line}))
      .filter(({line})=>/\/followers|\/me\/following/.test(line))
      .filter(({line})=>/^\s*(?:\/\/|\/\*|\*)/.test(line)===false)
      .map(({n,line})=>`${n}: ${line.trim()}`);
    assert.deepEqual(offenders,[],
      'src/tools/playlistfollow.ts names a removed endpoint outside a comment: '+offenders.join(' | '));
  });

  it('advertises no removed endpoint in any of the four tool descriptions',()=>{
    const h=harness();
    // #1099: the family is two operations under four names (canonical +
    // one-release deprecated alias). All four descriptions are in scope, so a
    // stale endpoint path cannot survive on the alias after the canonical
    // description was corrected.
    for(const name of ['follow_playlist','unfollow_playlist','pin_playlist','unpin_playlist']){
      const tool=h.registered.find(t=>t.name===name);
      assert.ok(tool,`tool ${name} registered`);
      assert.ok(!/\/followers/.test(tool.description),
        `${name} advertises the removed /playlists/{id}/followers endpoint`);
      assert.ok(!/\/me\/following/.test(tool.description),
        `${name} advertises the removed /me/following endpoint`);
      assert.match(tool.description,/\/me\/library/,
        `${name} should name its actual endpoint`);
    }
  });
});

// ---------------------------------------------------------------------------
// #1099 — the names and descriptions said "pin"; the code has always followed
//   (saved the playlist to the caller's library via /me/library).
//
// This suite is the regression test for the rename itself. The bug is a lying
// contract, so the assertions that matter are about what a caller can LEARN
// from tools/list and from a result — not about the request, which
// `follow_playlist` already got right before the rename.
// ---------------------------------------------------------------------------

describe('#1099 the pin_playlist/unpin_playlist names were a lie', () => {
  it('registers follow_playlist/unfollow_playlist, and no canonical description claims a pin', () => {
    const h = harness();
    for (const name of ['follow_playlist', 'unfollow_playlist']) {
      const tool = h.registered.find((t) => t.name === name);
      assert.ok(tool, `${name} must be registered — this is the whole fix`);
      // The defect, stated as a test: the tool that saves a playlist was named
      // for a verb Spotify has no playlist equivalent of.
      assert.doesNotMatch(
        tool.description,
        /\bpin\b/i,
        `${name} must not claim to pin; it saves to the library`,
      );
      // ...and it must still say what it actually does, not just drop the lie.
      assert.match(tool.description, /library/i, `${name} must name the effect it has`);
      assert.match(tool.description, /\/me\/library/, `${name} must name the endpoint it calls`);
    }
  });

  it('the deprecated aliases still work, name their replacement, and are marked deprecated', async () => {
    const h = harness(() => null, { action: 'accept', content: { confirm: true } });
    for (const [alias, canonical] of [['pin_playlist', 'follow_playlist'], ['unpin_playlist', 'unfollow_playlist']]) {
      const tool = h.registered.find((t) => t.name === alias);
      assert.ok(tool, `${alias} must stay callable for one release (AGENTS.md §5)`);
      assert.match(tool.description, new RegExp(`DEPRECATED.*${canonical}`), `${alias} must name its replacement`);
      // #1287 removed the legacy playlist INPUT aliases. The tool-NAME aliases
      // are a separate deprecation and are still registered, so their notice
      // must not date a removal no release has scheduled — that mismatch is the
      // bug this issue was filed for. Retiring these names is its own change
      // with its own AGENTS.md §5 steps.
      assert.doesNotMatch(tool.description, /removed in 2\.1/, `${alias} still promises the 2.1 removal that never happened`);
    }
    // And "still work" is behavioural, not just a registration row.
    const out = await h.invoke('pin_playlist', { playlist_id: 'pl1', dry_run: false });
    assert.deepEqual(
      h.client.calls.filter((c) => c.method === 'PUT').map((c) => c.path),
      ['/me/library?uris=spotify%3Aplaylist%3Apl1'],
      'the alias must still PUT the library URI',
    );
    assert.equal(out.structuredContent?.followed, true);
  });

  it('an alias call carries deprecated_inputs/deprecation_note; a canonical call carries neither', async () => {
    const legacy = harness(() => null, { action: 'accept', content: { confirm: true } });
    const out = await legacy.invoke('pin_playlist', { playlist_id: 'pl1', dry_run: false });
    // Machine-readable first: a host must be able to branch on the field
    // without scraping prose.
    assert.deepEqual(out.structuredContent?.deprecated_inputs, ['pin_playlist']);
    assert.match(String(out.structuredContent?.deprecation_note), /use follow_playlist/);
    // ...and the same one-line note in the text, per AGENTS.md §5.
    assert.match(textOf(out), /Deprecated tool name pin_playlist; use follow_playlist\./);

    const canonical = harness(() => null, { action: 'accept', content: { confirm: true } });
    const clean = await canonical.invoke('follow_playlist', { playlist_id: 'pl1', dry_run: false });
    assert.equal(clean.structuredContent?.deprecated_inputs, undefined, 'canonical calls omit deprecated_inputs');
    assert.equal(clean.structuredContent?.deprecation_note, undefined, 'canonical calls omit deprecation_note');
    assert.doesNotMatch(textOf(clean), /Deprecated tool name/);
  });

  it('the alias is not a way around the always-ask gate — it asks exactly like the canonical name', async () => {
    // The one failure mode that would make this rename unsafe: a copied alias
    // body that lost the elicitation call. Both names are registered against
    // ONE handler, so this asserts the property rather than the implementation.
    for (const name of ['unfollow_playlist', 'unpin_playlist']) {
      for (const [label, elicit] of [
        ['declined', { action: 'decline' }],
        ['transport-error', new Error('boom')],
        ['unpromptable-host', undefined],
      ] as const) {
        const h = harness(() => null, elicit);
        const out = await h.invoke(name, { playlist_id: 'pl1', dry_run: false });
        assert.equal(
          h.client.calls.filter((c) => c.method === 'DELETE').length,
          0,
          `${name}/${label}: an unconfirmed unfollow must never reach Spotify`,
        );
        assert.equal(out.structuredContent?.cancelled, true, `${name}/${label}: refusal must be cancelled:true`);
      }
    }
  });

  it('the alias and the canonical name are the same operation, not two implementations', async () => {
    // Parity asserted by comparison, not by re-listing expected values on both
    // sides: strip the deprecation keys from the alias result and the two must
    // be byte-identical, request included.
    for (const [alias, canonical] of [['pin_playlist', 'follow_playlist'], ['unpin_playlist', 'unfollow_playlist']]) {
      const a = harness(() => null, { action: 'accept', content: { confirm: true } });
      await a.invoke(alias, { playlist_id: 'pl1', dry_run: false });
      const c = harness(() => null, { action: 'accept', content: { confirm: true } });
      await c.invoke(canonical, { playlist_id: 'pl1', dry_run: false });
      assert.deepEqual(a.client.calls, c.client.calls, `${alias} must issue the same request as ${canonical}`);
      assert.deepEqual(
        a.registered.find((t) => t.name === alias)?.validate({ playlist_id: 'pl1' }),
        c.registered.find((t) => t.name === canonical)?.validate({ playlist_id: 'pl1' }),
        `${alias} must accept the same inputs as ${canonical}`,
      );
    }
  });

  it('an alias that contradicts itself about visibility fails before any Spotify request', async () => {
    // The rejection names the tool the CALLER used, not the canonical one —
    // an error pointing at a name the caller never typed is its own small lie.
    const h = harness(() => null, new Error('must not elicit'));
    await assert.rejects(
      () => h.invoke('pin_playlist', { playlist_id: 'pl1', public: false, dry_run: false }),
      /^Error: pin_playlist cannot honour public=false/,
    );
    assert.equal(h.client.calls.length, 0, 'refuses before issuing any request');
  });
});
describe('playlist_template_apply',()=>{
  it('rejects unknown template before any call',async()=>{
    const h=harness();
    await assert.rejects(()=>h.invoke('playlist_template_apply',{template:'unknown', limit:5}),(e:unknown)=>e instanceof z.ZodError);
    assert.equal(h.client.calls.length,0);
  });
  it('dry_run previews without creating playlist',async()=>{
    const h=harness((path)=>path.includes('/me/top/tracks')?{items:[track('t1'),track('t2')],total:2,limit:50,offset:0}:path.includes('/me/tracks')?{items:[{track:track('t3')}],total:1,limit:50,offset:0}:null);
    const out=await h.invoke('playlist_template_apply',{template:'focus',limit:2,dry_run:true});
    assert.match(textOf(out),/dry run/);
    assert.ok(!h.client.calls.some(c=>c.method==='POST' && c.path==='/me/playlists'));
  });
  it('creates playlist and adds tracks',async()=>{
    const h=harness((path,b)=> {
      if(path==='/me/playlists' && b) return {id:'new123',uri:'spotify:playlist:new123'};
      if(path.includes('/me/top/tracks')) return {items:[track('t1'),track('t2')],total:2,limit:50,offset:0};
      if(path.includes('/me/tracks')) return {items:[],total:0,limit:50,offset:0};
      if(path.startsWith('/playlists/new123/items')) return {snapshot_id:'snap'};
      if(path==='/playlists/new123') return {id:'new123'};
      return null;
    });
    const out=await h.invoke('playlist_template_apply',{template:'gym',name:'Gym Test',limit:2});
    assert.ok(h.client.calls.some(c=>c.method==='POST'&&c.path==='/me/playlists'));
    assert.ok(h.client.calls.some(c=>c.path.includes('/playlists/new123/items')));
    assert.match(textOf(out),/Created "Gym Test"/);
  });
  it('fails when no candidates',async()=>{
    const h=harness(()=>({items:[],total:0,limit:50,offset:0}));
    await assert.rejects(()=>h.invoke('playlist_template_apply',{template:'focus',limit:5}),/No candidate/);
  });
  // #865 — the old loop let a rejecting fill POST escape with nothing but the
  // bare error, hiding the fact that the playlist had ALREADY been created.
  // `limit` tops out at 100 so this path is always one chunk; the report that
  // matters is naming the orphan playlist so it can be reused or deleted.
  it('reports the orphaned playlist when the fill request rejects (#865)',async()=>{
    const h=harness((path,b)=>{
      if(path==='/me/playlists' && b) return {id:'new123',uri:'spotify:playlist:new123'};
      if(path.includes('/me/top/tracks')) return {items:[track('t1'),track('t2')],total:2,limit:50,offset:0};
      if(path.includes('/me/tracks')) return {items:[],total:0,limit:50,offset:0};
      if(path.startsWith('/playlists/new123/items')) throw new SpotifyApiError(503,'Service Unavailable');
      return null;
    });
    const out=await h.invoke('playlist_template_apply',{template:'gym',name:'Gym Test',limit:2});
    const p=out.structuredContent!;
    assert.equal(p.partial_write_failure,true);
    assert.equal(p.attempted_chunks,1);
    assert.equal(p.failed_chunk_index,0);
    assert.equal(p.last_committed_chunk_index,-1);
    assert.deepEqual(p.last_committed_chunk_uris,[]);
    assert.equal(p.committed_uris,0);
    assert.equal(p.remaining_uris,2);
    // The id is the whole point: without it the caller cannot find the
    // playlist this call already created.
    assert.equal(p.playlist_id,'new123');
    assert.equal(p.playlist_uri,'spotify:playlist:new123');
    assert.match(String(p.error),/Service Unavailable/);
    assert.match(textOf(out),/no track landed/);
    assert.match(textOf(out),/new123/);
    // The create POST is not rolled back, and no second write is issued.
    assert.equal(h.client.calls.filter(c=>c.method==='POST'&&c.path.startsWith('/playlists/new123/items')).length,1);
  });
  it('reports the same partial state under response_format=json (#865)',async()=>{
    const h=harness((path,b)=>{
      if(path==='/me/playlists' && b) return {id:'new123',uri:'spotify:playlist:new123'};
      if(path.includes('/me/top/tracks')) return {items:[track('t1')],total:1,limit:50,offset:0};
      if(path.includes('/me/tracks')) return {items:[],total:0,limit:50,offset:0};
      if(path.startsWith('/playlists/new123/items')) throw new SpotifyApiError(500,'boom');
      return null;
    });
    const out=await h.invoke('playlist_template_apply',{template:'gym',name:'Gym Test',limit:1,response_format:'json'});
    const parsed=JSON.parse(textOf(out));
    assert.equal(parsed.partial_write_failure,true);
    assert.equal(parsed.playlist_id,'new123');
    assert.equal(parsed.committed_uris,0);
    assert.equal(out.structuredContent!.partial_write_failure,true);
  });
});
