import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import type { SpotifyPaged } from '../src/types/spotify.js';
import { registerPortabilityTools } from '../src/tools/portability.js';
import { parseCsvDocument, FORMULA_LEAD } from './csv-reader.js';

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
/** #622: every export write is confined to SPOTIFY_MCP_PORTABILITY_DIR, so a
 *  file-mode case points that key at its scratch directory, as a user would. */
const withPortabilityRoot=async<T>(dir:string,run:()=>Promise<T>)=>{
  const prev=process.env.SPOTIFY_MCP_PORTABILITY_DIR;
  process.env.SPOTIFY_MCP_PORTABILITY_DIR=dir;
  try{ return await run(); } finally { if(prev===undefined) delete process.env.SPOTIFY_MCP_PORTABILITY_DIR; else process.env.SPOTIFY_MCP_PORTABILITY_DIR=prev; }
};

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
      const out=await withPortabilityRoot(dir,()=>h.invoke('export_library_json',{format:'json'}));
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
      await withPortabilityRoot(dir,()=>h.invoke('export_library_json',{format:'csv'}));
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
      await withPortabilityRoot(dir,()=>h.invoke('export_library_json',{}));
      const doc=JSON.parse(await readFile(join(dir,'library.json'),'utf8'));
      assert.equal(doc.tracks.length,1);
      assert.equal(doc.tracks[0].uri,'spotify:track:t1');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('accepts a subdirectory of the output root as output_dir',async()=>{
    const root=await mkdtemp(join(tmpdir(),'portability-root-'));
    try{
      const h=harness(()=>({items:[],total:0,limit:50,offset:0} as any));
      // Relative destinations are root-relative, not cwd-relative.
      await withPortabilityRoot(root,()=>h.invoke('export_library_json',{output_dir:'nested/dir'}));
      assert.ok((await stat(join(root,'nested','dir','library.json'))).isFile());
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
describe('export confinement (#622)',()=>{
  const h=()=>harness(()=>({items:[],total:0,limit:50,offset:0}));
  it('refuses an output_dir that escapes the configured root via `..`',async()=>{
    const root=await mkdtemp(join(tmpdir(),'portability-root-'));
    const outside=await mkdtemp(join(tmpdir(),'portability-outside-'));
    try{
      const escape=join(root,'..',basename(outside));
      await withPortabilityRoot(root,()=>assert.rejects(
        h().invoke('export_library_json',{output_dir:escape}),
        /refusing to write outside the configured output root/,
      ));
      await assert.rejects(stat(join(outside,'library.json')),'nothing may be written outside the root');
    } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
  });
  it('refuses an absolute output_dir outside the configured root',async()=>{
    const root=await mkdtemp(join(tmpdir(),'portability-root-'));
    const outside=await mkdtemp(join(tmpdir(),'portability-outside-'));
    try{
      await withPortabilityRoot(root,()=>assert.rejects(
        h().invoke('export_library_json',{output_dir:outside}),
        /refusing to write outside the configured output root/,
      ));
      await assert.rejects(stat(join(outside,'library.json')));
    } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
  });
  it('refuses a symlinked output_dir that resolves out of the root',async()=>{
    const root=await mkdtemp(join(tmpdir(),'portability-root-'));
    const outside=await mkdtemp(join(tmpdir(),'portability-outside-'));
    try{
      // The literal path is inside the root; only realpath() exposes the escape.
      await symlink(outside,join(root,'escape'));
      await withPortabilityRoot(root,()=>assert.rejects(
        h().invoke('export_library_json',{output_dir:'escape'}),
        /refusing to write outside the configured output root/,
      ));
      await assert.rejects(stat(join(outside,'library.json')));
    } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
  });
  it('refuses an output_dir that names an existing file',async()=>{
    const root=await mkdtemp(join(tmpdir(),'portability-root-'));
    try{
      const file=join(root,'not-a-dir');
      await writeFile(file,'x');
      await withPortabilityRoot(root,()=>assert.rejects(
        h().invoke('export_library_json',{output_dir:'not-a-dir'}),
        /it exists and is not a directory/,
      ));
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});
describe('export_followed_artists',()=>{
  it('writes empty JSON when no artists',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-test-'));
    try{
      const h=harness(()=>({artists:{items:[],cursors:null,next:null,total:0}} as any));
      const out=await withPortabilityRoot(dir,()=>h.invoke('export_followed_artists',{}));
      assert.match(textOf(out),/0 followed/);
      const doc=JSON.parse(await readFile(join(dir,'followed_artists.json'),'utf8'));
      assert.equal(doc.total,0);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('writes CSV with artist data',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-test-'));
    try{
      const h=harness(()=>({artists:{items:[{uri:'spotify:artist:a1',name:'Artist One',genres:['rock','pop']}],cursors:null,next:null,total:1}} as any));
      const out=await withPortabilityRoot(dir,()=>h.invoke('export_followed_artists',{format:'csv'}));
      assert.match(textOf(out),/1 followed/);
      const csv=await readFile(join(dir,'followed_artists.csv'),'utf8');
      assert.match(csv,/Artist One/);
      assert.match(csv,/rock;pop/);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
describe('export_all_playlists CSV formula neutralisation (#630)',()=>{
  it('never emits a playlist name a spreadsheet would evaluate as a formula',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-test-'));
    try{
      // Playlist names are set by whoever owns the playlist, so a followed
      // public playlist is enough to plant a payload in the recipient's sheet.
      const payloads=["=cmd|'/c calc'!A1",'+1+1','-2+3','@SUM(1+1)','\t=1+1','\r=1+1'];
      const h=harness((path)=>{
        if(path==='/me') return {id:'me'};
        if(path==='/me/playlists') return {items:payloads.map((name,i)=>({id:`p${i}`,name,uri:`spotify:playlist:p${i}`,owner:{id:'me'}})),total:payloads.length,limit:50,offset:0};
        return {items:[],total:0,limit:50,offset:0};
      });
      await withPortabilityRoot(dir,()=>h.invoke('export_all_playlists',{format:'csv',include_items:false}));
      const rows=parseCsvDocument(await readFile(join(dir,'playlists.csv'),'utf8'));
      assert.deepEqual(rows[0],['playlist_id','playlist_name','item_uri','item_name']);
      for(const row of rows) for(const cell of row) assert.doesNotMatch(cell,FORMULA_LEAD,`cell would execute when opened: ${JSON.stringify(cell)}`);
      for(const [index,payload] of payloads.entries()) assert.equal(rows[index+1][1],`'${payload}`);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('tightens a pre-existing world-readable ledger to 0600 and 0700 on the directory',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'portability-hist-'));
    const histDir=join(dir,'history');
    await mkdir(histDir,{recursive:true,mode:0o755});
    const histPath=join(histDir,'mutations.jsonl');
    await writeFile(histPath,'{"method":"PUT","path":"/me/library"}\n');
    await chmod(histPath,0o644);
    await chmod(histDir,0o755);
    const prev=process.env.SPOTIFY_MCP_HISTORY_DIR;
    process.env.SPOTIFY_MCP_HISTORY_DIR=histDir;
    try{
      const archive=join(dir,'state.json');
      await writeFile(archive,JSON.stringify({
        schema_version:1,
        stores:{ mutations_history:[{ method:'DELETE', path:'/me/library', target:'abc' }] },
      }));
      const { invoke }=harness();
      await invoke('import_profile_state',{ input_path:archive, mode:'overwrite', response_format:'concise' });

      assert.equal((await stat(histPath)).mode & 0o777,0o600);
      assert.equal((await stat(histDir)).mode & 0o777,0o700);
    } finally {
      if (prev === undefined) delete process.env.SPOTIFY_MCP_HISTORY_DIR;
      else process.env.SPOTIFY_MCP_HISTORY_DIR = prev;
      await rm(dir,{recursive:true,force:true});
    }
  });
});
