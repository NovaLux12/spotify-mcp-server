import { describe, it } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerPlaylistMiscTools } from '../src/tools/playlistmisc.js';

interface RecordedCall { method: string; path: string; arg?: unknown; }
type Responder = (path: string, arg?: unknown) => unknown;
interface RegisteredTool { name: string; validate: (a: Record<string, unknown>) => Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{type:string;text:string}>; structuredContent?: Record<string, unknown> }>; }

function makeStubClient(responder: Responder = () => null) {
  const calls: RecordedCall[] = [];
  const client = {
    calls,
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
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(name:string,_d:string,schema:z.ZodRawShape,handler:RegisteredTool['handler']){ registered.push({name,validate:(a)=>z.object(schema).parse(a),handler}); },
    registerTool(name:string,cfg:{description?:string;inputSchema?:z.ZodType},handler:RegisteredTool['handler']){ registered.push({name,validate:(a)=>(cfg.inputSchema as z.ZodType).parse(a),handler}); },
    ...(elicitResult!==undefined?{server:{getClientCapabilities:()=>({elicitation:{form:{}}})},async elicitInput(){ if(elicitResult instanceof Error) throw elicitResult; return elicitResult; }}:{}),
  } as unknown as McpServer;
  const client = makeStubClient(responder);
  registerPlaylistMiscTools(fakeServer, client as unknown as SpotifyClient);
  return { registered, client, invoke: async (name:string,args:Record<string,unknown>)=>{ const t=registered.find(x=>x.name===name); assert.ok(t,`tool ${name} registered`); return t.handler(t.validate(args)); } };
}
const textOf=(o:{content:Array<{text:string}>})=>o.content[0].text;
const track=(id:string)=>({ uri:`spotify:track:${id}`, name:`Track ${id}`, artists:[{name:`Artist ${id}`}] });

describe('pin_playlist',()=>{
  it('PUTs to /playlists/{id}/followers',async()=>{
    const h=harness(()=>null);
    const out=await h.invoke('pin_playlist',{playlist_id:'pl1'});
    assert.equal(h.client.calls[0].method,'PUT'); assert.equal(h.client.calls[0].path,'/playlists/pl1/followers');
    assert.match(textOf(out),/Pinned/);
  });
  it('forwards public flag',async()=>{
    const h=harness(()=>null);
    await h.invoke('pin_playlist',{playlist_id:'pl1',public:false});
    assert.deepEqual(h.client.calls[0].arg,{public:false});
  });
});
describe('unpin_playlist',()=>{
  it('dry_run previews without DELETE',async()=>{
    const h=harness(()=>null,new Error('must not elicit'));
    const out=await h.invoke('unpin_playlist',{playlist_id:'pl1',dry_run:true});
    assert.equal(h.client.calls.length,0);
    assert.match(textOf(out),/dry run/);
  });
  it('DELETEs after elicitation accept',async()=>{
    const h=harness(()=>null,{action:'accept',content:{confirm:true}});
    const out=await h.invoke('unpin_playlist',{playlist_id:'pl1'});
    assert.equal(h.client.calls.filter(c=>c.method==='DELETE').length,1);
    assert.match(textOf(out),/Unpinned/);
  });
  it('declined cancels',async()=>{
    const h=harness(()=>null,{action:'decline'});
    const out=await h.invoke('unpin_playlist',{playlist_id:'pl1'});
    assert.equal(h.client.calls.length,0);
    assert.match(textOf(out),/Cancelled/);
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
});
