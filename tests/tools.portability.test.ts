import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerPortabilityTools } from '../src/tools/portability.js';

interface RecordedCall { method:string; path:string; arg?: unknown; }
type Responder = (path:string, arg?:unknown)=>unknown;
interface RegisteredTool { name:string; validate:(a:Record<string,unknown>)=>Record<string,unknown>; handler:(a:Record<string,unknown>)=>Promise<{content:Array<{type:string;text:string}>;structuredContent?:Record<string,unknown>}>; }
function makeStubClient(responder: Responder=()=>null){
  const calls: RecordedCall[]=[];
  const client={
    calls,
    async get<T>(p:string,params?:Record<string,string>):Promise<T|null>{ calls.push({method:'GET',path:p,arg:params}); return responder(p,params) as T|null; },
    async post<T>(p:string,b?:unknown):Promise<T|null>{ calls.push({method:'POST',path:p,arg:b}); return responder(p,b) as T|null; },
    async put<T>(p:string,b?:unknown):Promise<T|null>{ calls.push({method:'PUT',path:p,arg:b}); return responder(p,b) as T|null; },
    async putRaw(p:string,b:string):Promise<void>{ calls.push({method:'PUT_RAW',path:p,arg:b}); await responder(p,b); },
    async delete<T>(p:string,b?:unknown):Promise<T|null>{ calls.push({method:'DELETE',path:p,arg:b}); return responder(p,b) as T|null; },
    async getAllPages<T>(path:string,params?:Record<string,string>,opts?:{maxItems?:number}):Promise<T[]>{
      const maxItems=opts?.maxItems??500; const all:T[]=[]; let offset=0;
      for(;;){ const page=await (this as unknown as {get:(p:string,pr?:Record<string,string>)=>Promise<SpotifyPaged<T>|null>}).get(path,{...params, offset:String(offset)}); if(!page||!Array.isArray(page.items)) break; all.push(...page.items); if(all.length>=maxItems) return all.slice(0,maxItems); const limit=typeof page.limit==='number'&&page.limit>0?page.limit:page.items.length; offset+=limit; if(page.items.length===0||page.items.length<limit) break; if(typeof page.total==='number'&&offset>=page.total) break;}
      return all;
    },
  }; return client;
}
function harness(responder: Responder=()=>null){
  const registered: RegisteredTool[]=[];
  const fakeServer={ tool(name:string,_d:string,schema:z.ZodRawShape,h:RegisteredTool['handler']){ registered.push({name,validate:(a)=>z.object(schema).parse(a),handler:h}); }, registerTool(name:string,cfg:{description?:string;inputSchema?:z.ZodType},h:RegisteredTool['handler']){ registered.push({name,validate:(a)=>(cfg.inputSchema as z.ZodType).parse(a),handler:h}); } } as unknown as McpServer;
  const client=makeStubClient(responder);
  registerPortabilityTools(fakeServer, client as unknown as SpotifyClient);
  return { registered, client, invoke: async(name:string,args:Record<string,unknown>)=>{ const t=registered.find(x=>x.name===name); assert.ok(t,`tool ${name} registered`); return t.handler(t.validate(args)); } };
}
const textOf=(o:{content:Array<{text:string}>})=>o.content[0].text;

describe('save_discover_weekly',()=>{
  it('dry_run previews without mutating',async()=>{
    const h=harness((path)=>{
      if(path==='/search') return {playlists:{items:[{id:'dw1',name:'Discover Weekly'}]}};
      if(path==='/playlists/dw1/items') return {items:[{item:{uri:'spotify:track:t1'}}],total:1,limit:100,offset:0};
      return null;
    });
    const out=await h.invoke('save_discover_weekly',{dry_run:true});
    assert.match(textOf(out),/dry run/);
    assert.equal(h.client.calls.filter(c=>c.method==='POST'||c.method==='PUT').length,0);
  });
  it('creates archive when missing',async()=>{
    const h=harness((path,arg)=>{
      if(path==='/search') return {playlists:{items:[{id:'dw1',name:'Discover Weekly'}]}};
      if(path==='/playlists/dw1/items') return {items:[{item:{uri:'spotify:track:t1'}},{item:{uri:'spotify:track:t2'}}],total:2,limit:100,offset:0} as any;
      if(path==='/me/playlists' && (arg as Record<string,string>)?.offset!==undefined) return {items:[],total:0,limit:50,offset:0} as any;
      if(path==='/me/playlists') return {id:'arch123',uri:'spotify:playlist:arch123'} as any;
      if(path.startsWith('/playlists/')&&path.endsWith('/items')) return {snapshot_id:'snap'} as any;
      if(path.startsWith('/playlists/arch123')) return {id:'arch123'} as any;
      return null;
    });
    const out=await h.invoke('save_discover_weekly',{});
    const methods=h.client.calls.map(c=>c.method);
    assert.ok(methods.includes('POST') || methods.includes('PUT'));
    assert.match(textOf(out),/Archived/);
  });
});
describe('export_library_json',()=>{
  it('writes JSON file with empty library',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-test-'));
    try{
      const h=harness(()=>({items:[],total:0,limit:50,offset:0} as any));
      const out=await h.invoke('export_library_json',{output_dir:dir, format:'json'});
      assert.match(textOf(out),/Exported library/);
      const raw=await readFile(join(dir,'library.json'),'utf8');
      const doc=JSON.parse(raw);
      assert.equal(doc.counts.tracks,0);
      const st=await stat(join(dir,'library.json'));
      assert.equal(st.mode & 0o777, 0o600);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('writes CSV files',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-test-'));
    try{
      const h=harness(()=>({items:[],total:0,limit:50,offset:0} as any));
      await h.invoke('export_library_json',{output_dir:dir, format:'csv'});
      const csv=await readFile(join(dir,'tracks.csv'),'utf8');
      assert.match(csv,/uri,name/);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('writes tracks with data',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-test-'));
    try{
      const h=harness((path,arg)=>{
        const offset=Number((arg as Record<string,string>)?.offset ?? 0);
        if(path==='/me/tracks'){
          if(offset===0) return {items:[{track:{uri:'spotify:track:t1',name:'Song 1',artists:[{name:'A'}]},added_at:'2026-01-01T00:00:00Z'}],total:1,limit:50,offset:0} as any;
          return {items:[],total:1,limit:50,offset} as any;
        }
        return {items:[],total:0,limit:50,offset:0} as any;
      });
      await h.invoke('export_library_json',{output_dir:dir});
      const doc=JSON.parse(await readFile(join(dir,'library.json'),'utf8'));
      assert.equal(doc.tracks.length,1);
      assert.equal(doc.tracks[0].uri,'spotify:track:t1');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
describe('export_followed_artists',()=>{
  it('writes empty JSON when no artists',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-test-'));
    try{
      const h=harness(()=>({artists:{items:[],cursors:null,next:null,total:0}} as any));
      const out=await h.invoke('export_followed_artists',{output_dir:dir});
      assert.match(textOf(out),/0 followed/);
      const doc=JSON.parse(await readFile(join(dir,'followed_artists.json'),'utf8'));
      assert.equal(doc.total,0);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('writes CSV with artist data',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-test-'));
    try{
      const h=harness(()=>({artists:{items:[{uri:'spotify:artist:a1',name:'Artist One',genres:['rock','pop']}],cursors:null,next:null,total:1}} as any));
      const out=await h.invoke('export_followed_artists',{output_dir:dir, format:'csv'});
      assert.match(textOf(out),/1 followed/);
      const csv=await readFile(join(dir,'followed_artists.csv'),'utf8');
      assert.match(csv,/Artist One/);
      assert.match(csv,/rock;pop/);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
