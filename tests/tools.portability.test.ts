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
import { initConfig } from '../src/config.js';
import { parseCsvDocument, FORMULA_LEAD } from './csv-reader.js';

interface RecordedCall { method:string; path:string; arg?: unknown; }
type Responder = (path:string, arg?:unknown)=>unknown;
interface RegisteredTool { name:string; validate:(a:Record<string,unknown>)=>Record<string,unknown>; handler:(a:Record<string,unknown>)=>Promise<{content:Array<{type:string;text:string}>;structuredContent?:Record<string,unknown>}>; }
/** One offset-paged GET, recorded exactly as a real client call would be. */
async function walkPage<T>(responder:Responder,calls:RecordedCall[],path:string,params:Record<string,string>|undefined,offset:number):Promise<SpotifyPaged<T>|null>{
  const arg={...params, offset:String(offset)};
  calls.push({method:'GET',path,arg});
  return responder(path,arg) as SpotifyPaged<T>|null;
}
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
      return (await (this as unknown as {getAllPagesWithTruncation:(p:string,pr?:Record<string,string>,o?:{maxItems?:number})=>Promise<{items:T[];truncated:boolean}>}).getAllPagesWithTruncation<T>(path,params,opts)).items;
    },
    // Mirrors SpotifyClient.getAllPagesWithTruncation (#864) so a walk that
    // stopped AT the cap is not indistinguishable from one the cap cut short.
    async getAllPagesWithTruncation<T>(path:string,params?:Record<string,string>,opts?:{maxItems?:number}):Promise<{items:T[];truncated:boolean}>{
      const maxItems=opts?.maxItems??500; const all:T[]=[]; let offset=0;
      for(;;){
        const page=await (this as unknown as {get:(p:string,pr?:Record<string,string>)=>Promise<SpotifyPaged<T>|null>}).get(path,{...params, offset:String(offset)});
        if(!page||!Array.isArray(page.items)) break;
        all.push(...page.items);
        if(all.length>=maxItems) return { items: all.slice(0,maxItems), truncated: all.length>maxItems || typeof page.total!=='number' || all.length<page.total };
        const limit=typeof page.limit==='number'&&page.limit>0?page.limit:page.items.length;
        offset+=limit;
        if(page.items.length===0||page.items.length<limit) break;
        if(typeof page.total==='number'&&offset>=page.total) break;
      }
      return { items: all, truncated:false };
    },
    async getAllPagesWithTruncation<T>(path:string,params?:Record<string,string>,opts?:{maxItems?:number}):Promise<{items:T[];truncated:boolean}>{
      const maxItems=opts?.maxItems??500; const all:T[]=[]; let offset=0;
      for(;;){ const page=await walkPage<T>(responder,calls,path,params,offset); if(!page||!Array.isArray(page.items)) break; all.push(...page.items); if(all.length>=maxItems) return { items: all.slice(0,maxItems), truncated: all.length>maxItems || typeof page.total!=='number' || all.length<page.total }; const limit=typeof page.limit==='number'&&page.limit>0?page.limit:page.items.length; offset+=limit; if(page.items.length===0||page.items.length<limit) break; if(typeof page.total==='number'&&offset>=page.total) break;}
      return { items: all, truncated: false };
    },
  }; return client;
}
function harness(responder: Responder=()=>null, extraServerKeys?:Record<string,unknown>){
  const registered: RegisteredTool[]=[];
  const fakeServer={ ...(extraServerKeys??{}), tool(name:string,_d:string,schema:z.ZodRawShape,h:RegisteredTool['handler']){ registered.push({name,validate:(a)=>z.object(schema).parse(a),handler:h}); }, registerTool(name:string,cfg:{description?:string;inputSchema?:z.ZodType},h:RegisteredTool['handler']){ registered.push({name,validate:(a)=>(cfg.inputSchema as z.ZodType).parse(a),handler:h}); } } as unknown as McpServer;
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

// #753 fixtures: an archive is a row in /me/playlists that may or may not be
// owned by the caller, so these build explicit owner ids rather than leaving
// ownership to chance.
const pl=(id:string,name:string,owner:string)=>({id,name,uri:`spotify:playlist:${id}`,description:null,owner:{id:owner,display_name:owner}});
const plPage=(rows:unknown[],total:number)=>({items:rows,total,limit:50,offset:0});
const tracks=(...u:string[])=>({items:u.map(x=>({item:{uri:x}})),total:u.length,limit:100,offset:0});
const mutations=(h:{client:{calls:RecordedCall[]}})=>h.client.calls.filter(c=>c.method==='PUT'||c.method==='POST'||c.method==='DELETE');

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
  // ---------------------------------------------------------------------
  // #753: the archive is the one playlist this tool PUT-REPLACES, and
  // /me/playlists also returns playlists the user merely FOLLOWS.
  // ---------------------------------------------------------------------

  it('refuses to write into a same-name archive the user does not own (#753)',async()=>{
    const h=harness((path)=>{
      if(path==='/me') return {id:'me'};
      if(path==='/me/playlists') return plPage([pl('dw','Discover Weekly','me'),pl('notmine','Discover Weekly Archive','other')],2);
      if(path==='/playlists/dw/items') return tracks('spotify:track:t1','spotify:track:t2');
      return null;
    });
    const out=await h.invoke('save_discover_weekly',{});
    assert.equal(out.structuredContent?.ok,false);
    assert.equal(out.structuredContent?.error,'archive_not_owned');
    assert.deepEqual(out.structuredContent?.archive_owner,{id:'other',display_name:'other'});
    assert.match(textOf(out),/Discover Weekly Archive/);
    assert.match(textOf(out),/not by you/);
    assert.match(textOf(out),/archive_name/);
    // The hazard: pre-fix this PUT-replaced a playlist owned by someone else.
    assert.equal(mutations(h).length,0);
  });

  it('picks the owned copy when a followed playlist shares the archive name (#753)',async()=>{
    const h=harness((path)=>{
      if(path==='/me') return {id:'me'};
      if(path==='/me/playlists') return plPage([pl('dw','Discover Weekly','me'),pl('theirs','Discover Weekly Archive','other'),pl('mine','Discover Weekly Archive','me')],3);
      if(path==='/playlists/dw/items') return tracks('spotify:track:t1','spotify:track:t2');
      if(path==='/playlists/theirs/items') return tracks();
      // The read and the replace are the same URL, so one fixture serves both.
      if(path==='/playlists/mine/items') return {...tracks('spotify:track:stale'),snapshot_id:'snap'};
      return null;
    });
    const out=await h.invoke('save_discover_weekly',{});
    assert.equal(out.structuredContent?.ok,true);
    assert.equal(out.structuredContent?.archive_id,'mine');
    assert.equal(out.structuredContent?.same_name_playlists,2);
    // The foreign row sorts first; nothing may be sent to it.
    assert.equal(h.client.calls.filter(c=>c.path.includes('theirs')).length,0);
    assert.ok(h.client.calls.some(c=>c.method==='PUT'&&c.path==='/playlists/mine/items'));
  });

  it('states how many items the write replaces, and names the archive it wrote to (#753)',async()=>{
    const h=harness((path)=>{
      if(path==='/me') return {id:'me'};
      if(path==='/me/playlists') return plPage([pl('dw','Discover Weekly','me'),pl('arch1','Discover Weekly Archive','me')],2);
      if(path==='/playlists/dw/items') return tracks('spotify:track:t1','spotify:track:t2');
      if(path==='/playlists/arch1/items') return {...tracks('spotify:track:old1','spotify:track:old2','spotify:track:old3'),snapshot_id:'snap'};
      return null;
    });
    const out=await h.invoke('save_discover_weekly',{});
    assert.equal(out.structuredContent?.replaced,3);
    assert.equal(out.structuredContent?.archive_id,'arch1');
    assert.equal(out.structuredContent?.archive_uri,'spotify:playlist:arch1');
    assert.equal(out.structuredContent?.archive_action,'replace');
    assert.match(textOf(out),/Replaced 3 existing item\(s\)/);
  });

  it('does not PUT when the owned archive already matches (#753)',async()=>{
    const h=harness((path)=>{
      if(path==='/me') return {id:'me'};
      if(path==='/me/playlists') return plPage([pl('dw','Discover Weekly','me'),pl('arch1','Discover Weekly Archive','me')],2);
      if(path==='/playlists/dw/items') return tracks('spotify:track:t1','spotify:track:t2');
      if(path==='/playlists/arch1/items') return tracks('spotify:track:t1','spotify:track:t2');
      return null;
    });
    const out=await h.invoke('save_discover_weekly',{});
    assert.equal(out.structuredContent?.idempotent,true);
    assert.equal(out.structuredContent?.replaced,0);
    assert.equal(mutations(h).length,0);
  });

  it('refuses to create a duplicate when the playlist-list walk was capped (#753)',async()=>{
    const h=harness((path)=>{
      if(path==='/me') return {id:'me'};
      // total 5 with only 2 rows in hand: the walk dies at the cap, and the
      // archive may be one of the three it never read.
      if(path==='/me/playlists') return plPage([pl('dw','Discover Weekly','me'),pl('mix1','Mix 1','me')],5);
      if(path==='/playlists/dw/items') return tracks('spotify:track:t1','spotify:track:t2');
      return null;
    });
    initConfig({ ...process.env, SPOTIFY_MCP_FETCH_ALL_CAP: '2' });
    try{
      const out=await h.invoke('save_discover_weekly',{});
      assert.equal(out.structuredContent?.ok,false);
      assert.equal(out.structuredContent?.error,'archive_scan_incomplete');
      assert.equal(out.structuredContent?.archives_scanned,2);
      assert.equal(out.structuredContent?.archive_scan_truncated,true);
      assert.match(textOf(out),/SPOTIFY_MCP_FETCH_ALL_CAP/);
      // The duplicate this used to create silently.
      assert.equal(h.client.calls.filter(c=>c.method==='POST'&&c.path==='/me/playlists').length,0);
    } finally { initConfig(process.env); }
  });
});

describe('save_release_radar',()=>{
  it('refuses a same-name archive the user does not own (#753 — shared resolver)',async()=>{
    const h=harness((path)=>{
      if(path==='/me') return {id:'me'};
      if(path==='/me/playlists') return plPage([pl('rr','Release Radar','me'),pl('theirs','Release Radar Archive','other')],2);
      if(path==='/playlists/rr/items') return tracks('spotify:track:t1');
      return null;
    });
    const out=await h.invoke('save_release_radar',{});
    assert.equal(out.structuredContent?.error,'archive_not_owned');
    assert.equal(mutations(h).length,0);
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

// ---------------------------------------------------------------------------
// #637 + #736: import_from_sidecar
// ---------------------------------------------------------------------------

/** A canonical library URI of the given kind (Spotify ids are 22 base62 chars). */
const uri=(kind:string,n:number)=>`spotify:${kind}:${String(n).padStart(22,'0')}`;
const rows=(kind:string,count:number,start=1)=>Array.from({length:count},(_,i)=>({uri:uri(kind,start+i)}));

/** A stub whose saved-state is real: /me/library/contains answers from a set
 *  that PUT /me/library?uris= mutates, so a second import genuinely finds
 *  everything already present. */
const libraryStub=()=>{
  const saved=new Set<string>();
  const responder:Responder=(path,arg)=>{
    if(path==='/me/library/contains'){
      const list=String((arg as {uris?:string}|undefined)?.uris??'').split(',').filter(Boolean);
      return list.map((u)=>saved.has(u));
    }
    if(path.startsWith('/me/library?uris=')){
      for(const u of new URLSearchParams(path.slice('/me/library?'.length)).get('uris')!.split(',')) saved.add(u);
      return null;
    }
    return null;
  };
  return {saved,responder};
};

const withSidecar=async<T>(doc:unknown,run:(p:string)=>Promise<T>)=>{
  const dir=await mkdtemp(join(tmpdir(),'portability-import-'));
  try{
    const p=join(dir,'library.json');
    await writeFile(p,JSON.stringify(doc));
    return await run(p);
  } finally { await rm(dir,{recursive:true,force:true}); }
};
const mutating=(c:{calls:RecordedCall[]})=>c.calls.filter((x)=>x.method==='PUT'||x.method==='POST'||x.method==='DELETE');
const puts=(c:{calls:RecordedCall[]})=>c.calls.filter((x)=>x.method==='PUT');
const urisOf=(c:RecordedCall)=>new URLSearchParams(c.path.split('?')[1]).get('uris')!.split(',');

describe('import_from_sidecar (#637 validation + executed reporting)',()=>{
  it('rejects malformed uri rows without sending them, and reports invalid',async()=>{
    await withSidecar(
      { tracks:[
        { uri: uri('track',1) },
        { uri: 'not-a-uri' },
        { uri: 'spotify:track:tooshort' },
        { name: 'no uri at all' },
        { uri: 42 },
      ] },
      async (p)=>{
        const {responder}=libraryStub();
        const h=harness(responder);
        const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
        const payload=out.structuredContent!;
        assert.equal(payload.invalid,4);
        assert.equal(payload.added,1);
        // The one valid URI is sent; nothing else ever reaches the wire.
        assert.equal(mutating(h.client).length,1);
        assert.deepEqual(urisOf(puts(h.client)[0]),[uri('track',1)]);
        assert.match(textOf(out),/4 invalid row\(s\) skipped/);
        assert.match(textOf(out),/added 1 item/);
      },
    );
  });

  it('sends nothing at all when every row is malformed',async()=>{
    await withSidecar({ tracks: rows('track',0), albums:[{uri:'junk'},{uri:''}] }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      assert.equal(h.client.calls.length,0,'a fully malformed sidecar must not reach the API');
      assert.equal(out.structuredContent!.invalid,2);
      assert.equal(out.structuredContent!.added,0);
    });
  });

  it('never says "would be added" once the writes have run',async()=>{
    await withSidecar({ tracks: rows('track',3) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      assert.doesNotMatch(textOf(out),/would/i);
      assert.equal(out.structuredContent!.executed,true);
      assert.equal(out.structuredContent!.added,3);
    });
  });

  it('writes through the unified /me/library endpoint, never the deprecated /me/tracks',async()=>{
    await withSidecar({ tracks: rows('track',3) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      for(const c of mutating(h.client)) assert.match(c.path,/^\/me\/library\?uris=/);
      assert.equal(h.client.calls.filter((c)=>c.path.startsWith('/me/tracks')).length,0);
    });
  });

  it('mints no receipt on a run that wrote nothing',async()=>{
    await withSidecar({ tracks: rows('track',3) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      const second=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      // Everything is already saved: an empty-uri receipt would read VERIFIED
      // with after=0 and imply a save that never happened.
      assert.equal(second.structuredContent!.receipt,undefined);
      assert.doesNotMatch(textOf(second),/VERIFIED|Receipt rcpt/);
      assert.match(textOf(second),/already in the library/);
    });
  });

  it('chunks 41 uris into 2 requests at the 40-uri library_writes cap',async()=>{
    await withSidecar({ tracks: rows('track',41) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      const writes=puts(h.client);
      assert.equal(writes.length,2);
      assert.deepEqual(writes.map((w)=>urisOf(w).length),[40,1]);
      assert.equal(out.structuredContent!.added,41);
    });
  });

  it('reports skipped_existing and adds nothing on a second run',async()=>{
    await withSidecar({ tracks: rows('track',4) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const first=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      assert.equal(first.structuredContent!.added,4);
      const writesAfterFirst=puts(h.client).length;
      const second=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      assert.equal(second.structuredContent!.added,0);
      assert.equal(second.structuredContent!.skipped_existing,4);
      assert.equal(puts(h.client).length,writesAfterFirst);
    });
  });

  it('previews with zero API calls and keeps "would" for the dry run',async()=>{
    await withSidecar({ tracks: rows('track',3), albums: rows('album',2) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p });
      assert.equal(h.client.calls.length,0,'a preview must not touch the API at all');
      assert.equal(out.structuredContent!.executed,false);
      assert.match(textOf(out),/would/i);
      const plan=out.structuredContent!.collections as Record<string,{in_file:number}>;
      assert.equal(plan.tracks.in_file,3);
      assert.equal(plan.albums.in_file,2);
    });
  });

  it('prompts via elicitation before the first large write',async()=>{
    const prompts:string[]=[];
    const order:string[]=[];
    const elicitHost={
      getClientCapabilities:()=>({elicitation:{}}),
      elicitInput:async(req:{message:string})=>{ prompts.push(req.message); order.push('prompt'); return {action:'accept',content:{confirm:true}}; },
    };
    const prevConfirm=process.env.SPOTIFY_MCP_CONFIRM;
    delete process.env.SPOTIFY_MCP_CONFIRM;
    try{
      await withSidecar({ tracks: rows('track',120) }, async (p)=>{
        const {responder}=libraryStub();
        const h=harness((path,arg)=>{ if(typeof path==='string'&&path.startsWith('/me/library?uris=')) order.push('put'); return responder(path,arg); }, { server: elicitHost });
        const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
        assert.equal(prompts.length,1,'one confirmation before the writes');
        assert.match(prompts[0],/120 item/);
        assert.equal(order[0],'prompt','the prompt must precede the write');
        assert.ok(order.filter((o)=>o==='put').length>0);
        assert.equal(out.structuredContent!.added,120);
      });
    } finally { if(prevConfirm===undefined) delete process.env.SPOTIFY_MCP_CONFIRM; else process.env.SPOTIFY_MCP_CONFIRM=prevConfirm; }
  });

  it('performs no write when the operator declines the gate',async()=>{
    const elicitHost={
      getClientCapabilities:()=>({elicitation:{}}),
      elicitInput:async()=>({action:'decline'}),
    };
    const prevConfirm=process.env.SPOTIFY_MCP_CONFIRM;
    delete process.env.SPOTIFY_MCP_CONFIRM;
    try{
      await withSidecar({ tracks: rows('track',120) }, async (p)=>{
        const {responder}=libraryStub();
        const h=harness(responder,{ server: elicitHost });
        const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
        assert.equal(mutating(h.client).length,0);
        assert.equal(out.structuredContent!.cancelled,true);
      });
    } finally { if(prevConfirm===undefined) delete process.env.SPOTIFY_MCP_CONFIRM; else process.env.SPOTIFY_MCP_CONFIRM=prevConfirm; }
  });
});

describe('import_from_sidecar (#736 restores every collection)',()=>{
  it('restores all five collections with per-collection counts',async()=>{
    const firstUri:Record<string,string>={ track:uri('track',1), album:uri('album',101), show:uri('show',201), episode:uri('episode',301), audiobook:uri('audiobook',401) };
    const doc={
      counts:{ tracks:2, albums:2, shows:2, episodes:2, audiobooks:2 },
      tracks: rows('track',2,1),
      albums: rows('album',2,101),
      shows: rows('show',2,201),
      episodes: rows('episode',2,301),
      audiobooks: rows('audiobook',2,401),
    };
    await withSidecar(doc, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      const payload=out.structuredContent!;
      assert.deepEqual(payload.imported,{ tracks:2, albums:2, shows:2, episodes:2, audiobooks:2 });
      assert.equal(payload.added,10);
      assert.deepEqual(payload.absent_keys,[]);
      // Every one of the ten URIs actually reached the library endpoint.
      const sent=puts(h.client).flatMap(urisOf);
      assert.equal(sent.length,10);
      for(const u of Object.values(firstUri)) assert.ok(sent.includes(u),`${u} never reached the endpoint`);
    });
  });

  it('names a collection the file does not carry in absent_keys and in prose',async()=>{
    await withSidecar({ tracks: rows('track',1) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      const absent=out.structuredContent!.absent_keys as string[];
      for(const key of ['albums','shows','episodes','audiobooks']) assert.ok(absent.includes(key),`${key} must be disclosed as absent`);
      assert.ok(!absent.includes('tracks'));
      assert.match(textOf(out),/has no .*shows/);
    });
  });

  it('discloses an absent key in the dry-run plan too',async()=>{
    await withSidecar({ tracks: rows('track',1), shows: rows('show',1) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p });
      const payload=out.structuredContent!;
      assert.deepEqual(payload.absent_keys,['albums','episodes','audiobooks']);
      assert.deepEqual(payload.would_import,{ tracks:1, albums:0, shows:1, episodes:0, audiobooks:0 });
      assert.match(textOf(out),/has no .*episodes/);
    });
  });
});

// ---------------------------------------------------------------------------
// #1008: the importer reads the exporter's own truncated / cap_reached flags
// ---------------------------------------------------------------------------

describe('import_from_sidecar (#1008 surfaces the exporter truncation flags)',()=>{
  const cappedDoc={
    exported_at:'2026-01-01T00:00:00.000Z',
    counts:{ tracks:500, albums:500, shows:3, episodes:0, audiobooks:0 },
    cap_reached:{ tracks:true, albums:true, shows:false, episodes:false, audiobooks:false },
    truncated:true,
    cap:500,
    tracks: rows('track',500,1),
    albums: rows('album',500,1001),
    shows: rows('show',3,2001),
    episodes: [],
    audiobooks: [],
  };

  it('never reports a capped sidecar as a complete restore in the executed payload',async()=>{
    // 1003 rows crosses the 100-item elicitation gate; disable it so this
    // test exercises the reporting, not the confirmation.
    const prevConfirm=process.env.SPOTIFY_MCP_CONFIRM;
    process.env.SPOTIFY_MCP_CONFIRM='never';
    try{
      await withSidecar(cappedDoc, async (p)=>{
        const {responder}=libraryStub();
        const h=harness(responder);
        const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
        const payload=out.structuredContent!;
        assert.equal(payload.added,1003);
        // The defect in #1008: the payload said nothing about the 400+ tracks
        // and 400+ albums the exporter never wrote.
        assert.equal(payload.sidecar_truncated,true);
        assert.deepEqual(payload.truncated_collections,['tracks','albums']);
        assert.equal(payload.cap,500);
        assert.deepEqual(payload.cap_reached,{ tracks:true, albums:true, shows:false, episodes:false, audiobooks:false });
        assert.match(textOf(out),/TRUNCATED/);
        assert.match(textOf(out),/tracks, albums/);
        // The honest count still has to be there alongside the disclosure.
        assert.match(textOf(out),/added 1003 item/);
      });
    } finally { if(prevConfirm===undefined) delete process.env.SPOTIFY_MCP_CONFIRM; else process.env.SPOTIFY_MCP_CONFIRM=prevConfirm; }
  });

  it('discloses truncation in the dry run too, not only after writes',async()=>{
    await withSidecar(cappedDoc, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p });
      assert.equal(h.client.calls.length,0);
      assert.equal(out.structuredContent!.executed,false);
      assert.equal(out.structuredContent!.sidecar_truncated,true);
      assert.deepEqual(out.structuredContent!.truncated_collections,['tracks','albums']);
      assert.match(textOf(out),/TRUNCATED/);
    });
  });

  it('surfaces the truncation in the confirmation prompt, before the write',async()=>{
    const prompts:string[]=[];
    const elicitHost={
      getClientCapabilities:()=>({elicitation:{}}),
      elicitInput:async(req:{message:string})=>{ prompts.push(req.message); return {action:'accept',content:{confirm:true}}; },
    };
    const prevConfirm=process.env.SPOTIFY_MCP_CONFIRM;
    delete process.env.SPOTIFY_MCP_CONFIRM;
    try{
      await withSidecar(cappedDoc, async (p)=>{
        const {responder}=libraryStub();
        const h=harness(responder,{ server: elicitHost });
        await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
        assert.equal(prompts.length,1);
        assert.match(prompts[0],/TRUNCATED/);
        assert.match(prompts[0],/tracks, albums/);
      });
    } finally { if(prevConfirm===undefined) delete process.env.SPOTIFY_MCP_CONFIRM; else process.env.SPOTIFY_MCP_CONFIRM=prevConfirm; }
  });

  it('reports a file with no truncation flag as UNKNOWN, never as complete',async()=>{
    // Same rows, flag removed: nothing in the file can prove the export
    // finished, so the importer must not claim it did.
    await withSidecar({ tracks: rows('track',3), albums: rows('album',2) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      const payload=out.structuredContent!;
      assert.equal(payload.sidecar_truncated,null);
      assert.deepEqual(payload.truncated_collections,[]);
      assert.equal(payload.cap,null);
      assert.match(textOf(out),/UNKNOWN/);
      assert.doesNotMatch(textOf(out),/complete export/);
    });
  });

  it('honours an explicit truncated:false as a complete export',async()=>{
    await withSidecar({ truncated:false, cap:500, cap_reached:{tracks:false}, tracks: rows('track',3) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      assert.equal(out.structuredContent!.sidecar_truncated,false);
      assert.match(textOf(out),/complete export/);
    });
  });

  it('names every present collection when the file flags truncation without naming which',async()=>{
    await withSidecar({ truncated:true, tracks: rows('track',2), shows: rows('show',1) }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      // A flag with no per-collection detail cannot single out a key, so it
      // must not silently narrow the disclosure to a plausible guess.
      assert.deepEqual(out.structuredContent!.truncated_collections,['tracks','albums','shows','episodes','audiobooks']);
    });
  });

  it('discloses a truncated sidecar even when it restores nothing',async()=>{
    await withSidecar({ truncated:true, cap_reached:{tracks:true}, cap:500, tracks:[{uri:'junk'},{uri:''}] }, async (p)=>{
      const {responder}=libraryStub();
      const h=harness(responder);
      const out=await h.invoke('import_from_sidecar',{ input_path:p, dry_run:false });
      assert.equal(out.structuredContent!.added,0);
      assert.equal(out.structuredContent!.sidecar_truncated,true);
      assert.match(textOf(out),/TRUNCATED/);
    });
  });
});

// ---------------------------------------------------------------------------
// #760: behaviour cover for the portability tools that shipped untested.
//
// Every case here asserts an observable payload or prose value, and the cap
// cases assert the walk's OWN truncation verdict: a collection that happens to
// be exactly the cap long is complete, and only rows the walk actually left
// behind make an export truncated.
// ---------------------------------------------------------------------------

/** Cap the fetch-all walks small enough to keep the fixtures readable, then
 *  restore the process-wide config snapshot. */
const withFetchAllCap=async<T>(cap:number,run:()=>Promise<T>)=>{
  const prev=process.env.SPOTIFY_MCP_FETCH_ALL_CAP;
  process.env.SPOTIFY_MCP_FETCH_ALL_CAP=String(cap);
  initConfig();
  try{ return await run(); } finally {
    if(prev===undefined) delete process.env.SPOTIFY_MCP_FETCH_ALL_CAP; else process.env.SPOTIFY_MCP_FETCH_ALL_CAP=prev;
    initConfig();
  }
};

/** Point every profile-state store at scratch paths for the duration of `run`. */
const PROFILE_ENV=['SPOTIFY_MCP_EXPORT_DIR','SPOTIFY_MCP_SCENES_FILE','SPOTIFY_MCP_GENRE_TAGS_FILE','SPOTIFY_MCP_PLAYBACKEXT_FILE','SPOTIFY_MCP_SEARCH_HISTORY_FILE','SPOTIFY_MCP_DATA_DIR'] as const;
const withProfileStores=async<T>(paths:Record<string,string>,run:()=>Promise<T>)=>{
  const prev:Record<string,string|undefined>={};
  for(const k of PROFILE_ENV){ prev[k]=process.env[k]; if(paths[k]!==undefined) process.env[k]=paths[k]; }
  try{ return await run(); } finally { for(const k of PROFILE_ENV){ if(prev[k]===undefined) delete process.env[k]; else process.env[k]=prev[k]; } }
};

const scratch=async()=>mkdtemp(join(tmpdir(),'i760-'));

const savedTracks=(n:number,start=1)=>Array.from({length:n},(_,i)=>({track:{uri:`spotify:track:t${start+i}`,name:`Track ${start+i}`,artists:[]},added_at:'2026-01-01T00:00:00.000Z'}));

describe('export_library_json (the walk reports its own truncation)',()=>{
  it('a library that is exactly the cap long is a complete library',async()=>{
    const dir=await scratch();
    try{
      await withFetchAllCap(3,async()=>{
        const h=harness((path)=>path==='/me/tracks'
          ? {items:savedTracks(3),total:3,limit:3,offset:0}
          : {items:[],total:0,limit:50,offset:0});
        const out=await withPortabilityRoot(dir,()=>h.invoke('export_library_json',{}));
        const doc=JSON.parse(await readFile(join(dir,'library.json'),'utf8'));
        assert.equal(doc.counts.tracks,3);
        assert.deepEqual(doc.cap_reached,{tracks:false,albums:false,shows:false,episodes:false,audiobooks:false},'a 3-track library under a cap of 3 is not a capped one');
        assert.equal(doc.truncated,false);
        assert.doesNotMatch(textOf(out),/truncated/);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('a library longer than the cap is truncated, names the cap and keeps only the rows it walked',async()=>{
    const dir=await scratch();
    try{
      await withFetchAllCap(3,async()=>{
        const h=harness((path)=>path==='/me/tracks'
          ? {items:savedTracks(5),total:5,limit:5,offset:0}
          : {items:[],total:0,limit:50,offset:0});
        const out=await withPortabilityRoot(dir,()=>h.invoke('export_library_json',{}));
        const doc=JSON.parse(await readFile(join(dir,'library.json'),'utf8'));
        assert.equal(doc.cap_reached.tracks,true);
        assert.equal(doc.truncated,true);
        assert.equal(doc.cap,3);
        assert.equal(doc.tracks.length,3,'only the walked rows may be written');
        assert.match(textOf(out),/truncated/);
        assert.match(textOf(out),/capped types: tracks/);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('an unreadable /me/audiobooks is reported unread, never as zero saved',async()=>{
    const dir=await scratch();
    try{
      await withFetchAllCap(3,async()=>{
        const h=harness((path)=>{
          if(path==='/me/audiobooks') throw new Error('403 Forbidden: audiobook scope missing');
          return {items:[],total:0,limit:50,offset:0};
        });
        const out=await withPortabilityRoot(dir,()=>h.invoke('export_library_json',{}));
        const payload=out.structuredContent!;
        assert.equal(payload.ok,false);
        assert.equal((payload.unreadable as Record<string,string>).audiobooks,'403 Forbidden: audiobook scope missing');
        assert.match(textOf(out),/UNREAD/);
        assert.match(textOf(out),/403 Forbidden/);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});

describe('export_followed_artists (cap verdict comes from the walk)',()=>{
  it('exactly the cap followed artists is a complete list, not a truncated one',async()=>{
    const dir=await scratch();
    try{
      await withFetchAllCap(3,async()=>{
        // The server says there is no next page: three artists is all of them.
        const h=harness(()=>({artists:{items:Array.from({length:3},(_,i)=>({uri:`spotify:artist:a${i}`,name:`Artist ${i}`,genres:[]})),cursors:{after:null},next:null}}) as any);
        const out=await withPortabilityRoot(dir,()=>h.invoke('export_followed_artists',{}));
        const doc=JSON.parse(await readFile(join(dir,'followed_artists.json'),'utf8'));
        assert.equal(doc.total,3);
        assert.equal(doc.cap_reached,false,'the walk ended on its own terms, so nothing was cut');
        assert.equal(doc.truncated,false);
        assert.doesNotMatch(textOf(out),/truncated/);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('a following list that still has a next cursor at the cap is truncated and says so',async()=>{
    const dir=await scratch();
    try{
      await withFetchAllCap(3,async()=>{
        const h=harness(()=>({artists:{items:Array.from({length:3},(_,i)=>({uri:`spotify:artist:a${i}`,name:`Artist ${i}`,genres:[]})),cursors:{after:'cursor-2'},next:'/me/following?after=cursor-2'}}) as any);
        const out=await withPortabilityRoot(dir,()=>h.invoke('export_followed_artists',{}));
        const doc=JSON.parse(await readFile(join(dir,'followed_artists.json'),'utf8'));
        assert.equal(doc.artists.length,3);
        assert.equal(doc.cap_reached,true);
        assert.equal(doc.truncated,true);
        assert.equal(doc.cap,3);
        assert.match(textOf(out),/truncated/);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});

describe('export_listening_history (cap verdict and cursor boundaries)',()=>{
  const played=(i:number,at:string)=>({played_at:at,track:{name:`Play ${i}`,uri:`spotify:track:p${i}`,artists:[{name:'A'}],album:{name:'Alb'}},context:null});

  it('a history that runs out exactly at max_items is complete',async()=>{
    const dir=await scratch();
    try{
      // Two items on a short page: the server had nothing more to give.
      const h=harness(()=>({items:[played(1,'2026-01-03T00:00:00.000Z'),played(2,'2026-01-02T00:00:00.000Z')],cursors:{before:'1767225600000'}}) as any);
      const out=await withPortabilityRoot(dir,()=>h.invoke('export_listening_history',{max_items:2}));
      const doc=JSON.parse(await readFile(join(dir,'listening_history.json'),'utf8'));
      assert.equal(doc.total,2);
      assert.equal(doc.cap_reached,false,'a short page is the end of the history, not a cap hit');
      assert.equal(doc.truncated,false);
      assert.doesNotMatch(textOf(out),/truncated/);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('a full page that hits max_items is truncated, and only the capped rows are written',async()=>{
    const dir=await scratch();
    try{
      const full=Array.from({length:50},(_,i)=>played(i,`2026-01-0${(i%9)+1}T00:00:00.000Z`));
      const h=harness(()=>({items:full,cursors:{before:'1767225600000'}}) as any);
      const out=await withPortabilityRoot(dir,()=>h.invoke('export_listening_history',{max_items:2}));
      const doc=JSON.parse(await readFile(join(dir,'listening_history.json'),'utf8'));
      assert.equal(doc.items.length,2);
      assert.equal(doc.cap_reached,true);
      assert.equal(doc.truncated,true);
      assert.equal(doc.cap,2);
      assert.match(textOf(out),/truncated/);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('sends a before cursor to Spotify in milliseconds',async()=>{
    const dir=await scratch();
    try{
      const h=harness(()=>({items:[],cursors:{before:null}}) as any);
      await withPortabilityRoot(dir,()=>h.invoke('export_listening_history',{before:'2026-01-05T00:00:00.000Z'}));
      const call=h.client.calls.find((c)=>c.path==='/me/player/recently-played')!;
      assert.equal((call.arg as Record<string,string>).before,String(Date.parse('2026-01-05T00:00:00.000Z')));
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('drops plays at or before the after cursor instead of writing them',async()=>{
    const dir=await scratch();
    try{
      const h=harness(()=>({items:[
        played(1,'2026-01-01T00:00:00.000Z'),
        played(2,'2026-01-03T00:00:00.000Z'),
        played(3,'2026-01-02T00:00:00.000Z'),
      ],cursors:{before:'1767225600000'}}) as any);
      await withPortabilityRoot(dir,()=>h.invoke('export_listening_history',{after:'2026-01-02T00:00:00.000Z'}));
      const doc=JSON.parse(await readFile(join(dir,'listening_history.json'),'utf8'));
      assert.equal(doc.total,1,`only the play strictly after the cursor may be exported: ${JSON.stringify(doc.items.map((x:{track:string})=>x.track))}`);
      assert.equal(doc.items[0].track,'Play 2');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});

describe('export_all_playlists (scope, cap and unreadable item lists)',()=>{
  const pls=(n:number,owner='me')=>Array.from({length:n},(_,i)=>({id:`p${i}`,name:`List ${i}`,uri:`spotify:playlist:p${i}`,owner:{id:owner},items:{total:2}}));
  const emptyPage={items:[],total:0,limit:100,offset:0};

  it('scope=owned exports only the playlists you own',async()=>{
    const dir=await scratch();
    try{
      const h=harness((path)=>{
        if(path==='/me') return {id:'me'};
        if(path==='/me/playlists') return {items:[...pls(1,'me'),...pls(1,'someone-else').map((p)=>({...p,id:'other',uri:'spotify:playlist:other'}))],total:2,limit:50,offset:0};
        return emptyPage;
      });
      const out=await withPortabilityRoot(dir,()=>h.invoke('export_all_playlists',{scope:'owned'}));
      const doc=JSON.parse(await readFile(join(dir,'playlists.json'),'utf8'));
      assert.equal(doc.total,1);
      assert.deepEqual(doc.playlists.map((p:{id:string})=>p.id),['p0']);
      assert.equal(doc.scope,'owned');
      assert.equal(out.structuredContent!.total,1);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('include_items=false reads no playlist items and still records the metadata',async()=>{
    const dir=await scratch();
    try{
      const h=harness((path)=>{
        if(path==='/me') return {id:'me'};
        if(path==='/me/playlists') return {items:pls(2),total:2,limit:50,offset:0};
        return emptyPage;
      });
      await withPortabilityRoot(dir,()=>h.invoke('export_all_playlists',{include_items:false}));
      assert.equal(h.client.calls.filter((c)=>c.path.startsWith('/playlists/')&&c.path.endsWith('/items')).length,0,'include_items=false must not walk any playlist');
      const doc=JSON.parse(await readFile(join(dir,'playlists.json'),'utf8'));
      assert.equal(doc.total,2);
      assert.equal(doc.playlists[0].items.length,0);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('a /me/playlists walk that hits the cap is reported truncated with the cap named',async()=>{
    const dir=await scratch();
    try{
      await withFetchAllCap(2,async()=>{
        const h=harness((path)=>{
          if(path==='/me') return {id:'me'};
          if(path==='/me/playlists') return {items:pls(3),total:3,limit:3,offset:0};
          return emptyPage;
        });
        const out=await withPortabilityRoot(dir,()=>h.invoke('export_all_playlists',{}));
        const doc=JSON.parse(await readFile(join(dir,'playlists.json'),'utf8'));
        assert.equal(doc.cap,2);
        assert.equal(doc.cap_reached,true);
        assert.equal(doc.truncated,true);
        assert.equal(doc.playlists.length,2,'only the walked playlists may be written');
        assert.match(textOf(out),/hit the cap of 2/);
        assert.match(textOf(out),/raise SPOTIFY_MCP_FETCH_ALL_CAP/);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('a playlist whose item list cannot be read is named unread, not exported as empty',async()=>{
    const dir=await scratch();
    try{
      const h=harness((path)=>{
        if(path==='/me') return {id:'me'};
        if(path==='/me/playlists') return {items:pls(1),total:1,limit:50,offset:0};
        if(path==='/playlists/p0/items') throw new Error('403 Forbidden');
        return emptyPage;
      });
      const out=await withPortabilityRoot(dir,()=>h.invoke('export_all_playlists',{}));
      const payload=out.structuredContent!;
      assert.equal(payload.ok,false);
      assert.equal((payload.unreadable as Record<string,string>).p0,'403 Forbidden');
      assert.match(textOf(out),/UNREADABLE/);
      assert.match(textOf(out),/p0/);
      const doc=JSON.parse(await readFile(join(dir,'playlists.json'),'utf8'));
      assert.equal(doc.playlists[0].items_unreadable,'403 Forbidden');
      assert.equal(doc.playlists[0].items.length,0);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});

describe('export_profile_state (real counts, and unread is not zero)',()=>{
  it('counts the stores it can read and writes the archive 0600',async()=>{
    const dir=await scratch();
    try{
      const env={
        SPOTIFY_MCP_EXPORT_DIR:dir,
        SPOTIFY_MCP_SCENES_FILE:join(dir,'scenes.json'),
        SPOTIFY_MCP_GENRE_TAGS_FILE:join(dir,'genre-tags.json'),
        SPOTIFY_MCP_PLAYBACKEXT_FILE:join(dir,'playback-ext.json'),
        SPOTIFY_MCP_SEARCH_HISTORY_FILE:join(dir,'search-history.json'),
        SPOTIFY_MCP_DATA_DIR:dir,
      };
      await withProfileStores(env,async()=>{
        await writeFile(env.SPOTIFY_MCP_SCENES_FILE,JSON.stringify({morning:{tracks:['a']},evening:{tracks:['b']}}));
        await writeFile(env.SPOTIFY_MCP_GENRE_TAGS_FILE,JSON.stringify({version:1,tags:{rock:1,jazz:2}}));
        await writeFile(env.SPOTIFY_MCP_PLAYBACKEXT_FILE,JSON.stringify({states:{s1:{}},sessions:{}}));
        await writeFile(env.SPOTIFY_MCP_SEARCH_HISTORY_FILE,JSON.stringify({entries:[{id:'a'},{id:'b'},{id:'c'}]}));
        await writeFile(join(dir,'artist-watchlist.json'),JSON.stringify({watchlists:{w1:{}}}));
        const out=await harness().invoke('export_profile_state',{});
        const payload=out.structuredContent!;
        assert.equal(payload.ok,true);
        assert.deepEqual(payload.counts,{scenes:2,genre_tags:2,playback_ext_states:1,playback_ext_sessions:0,search_history:3,artist_watchlist:1});
        assert.equal((await stat(payload.path as string)).mode & 0o777,0o600);
        const doc=JSON.parse(await readFile(payload.path as string,'utf8'));
        assert.equal(doc.schema_version,1);
        assert.equal(doc.stores.scenes.morning.tracks[0],'a');
        assert.equal(doc.stores.search_history.length,3);
        assert.equal(doc.stores.artist_watchlist.watchlists.w1!=null,true);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('reports a corrupt store as unread instead of a count of zero',async()=>{
    const dir=await scratch();
    try{
      const env={
        SPOTIFY_MCP_EXPORT_DIR:dir,
        SPOTIFY_MCP_SCENES_FILE:join(dir,'scenes.json'),
        SPOTIFY_MCP_DATA_DIR:dir,
      };
      await withProfileStores(env,async()=>{
        await writeFile(env.SPOTIFY_MCP_SCENES_FILE,'{ this is not json');
        const out=await harness().invoke('export_profile_state',{});
        const payload=out.structuredContent!;
        assert.equal(payload.ok,false);
        assert.equal((payload.counts as Record<string,unknown>).scenes,null,'an unread store has no count — zero would be a number the export never measured');
        const unreadable=(payload.unreadable as Record<string,string>);
        assert.match(unreadable.scenes,/scenes\.json/);
        assert.match(unreadable.scenes,/invalid JSON/);
        assert.match(textOf(out),/UNREAD/);
        assert.match(textOf(out),/scenes:null/);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('tells a store that was never written apart from one that could not be read',async()=>{
    const dir=await scratch();
    try{
      // scenes.json is corrupt; genre-tags.json was never written at all. The
      // export must say which is which — reporting both as 0 asserts the same
      // thing about two different worlds.
      const env={
        SPOTIFY_MCP_EXPORT_DIR:dir,
        SPOTIFY_MCP_SCENES_FILE:join(dir,'scenes.json'),
        SPOTIFY_MCP_GENRE_TAGS_FILE:join(dir,'genre-tags.json'),
        SPOTIFY_MCP_DATA_DIR:dir,
      };
      await withProfileStores(env,async()=>{
        await writeFile(env.SPOTIFY_MCP_SCENES_FILE,'{ truncated json');
        const out=await harness().invoke('export_profile_state',{});
        const payload=out.structuredContent!;
        const counts=payload.counts as Record<string,unknown>;
        assert.equal(counts.genre_tags,0,'a store that is not there really has no entries');
        assert.equal(counts.scenes,null,'a store that could not be read has no measurable count');
        const unreadable=payload.unreadable as Record<string,string>;
        assert.match(unreadable.scenes,/invalid JSON/);
        assert.equal('genre_tags' in unreadable,false,'an absent store is not an unread one');
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});

describe('import_profile_state (merge, overwrite and refusal)',()=>{
  const archive=async(dir:string,stores:unknown,schema_version=1)=>{
    const p=join(dir,'archive.json');
    await writeFile(p,JSON.stringify({schema_version,stores}));
    return p;
  };

  it('merge keeps the existing scenes and adds the archive ones',async()=>{
    const dir=await scratch();
    try{
      const env={SPOTIFY_MCP_SCENES_FILE:join(dir,'scenes.json'),SPOTIFY_MCP_DATA_DIR:dir};
      await withProfileStores(env,async()=>{
        await writeFile(env.SPOTIFY_MCP_SCENES_FILE,JSON.stringify({alpha:{tracks:['x']},beta:{tracks:['y']}}));
        const p=await archive(dir,{scenes:{beta:{tracks:['changed']},gamma:{tracks:['z']}}});
        const out=await harness().invoke('import_profile_state',{input_path:p,mode:'merge'});
        assert.equal(out.structuredContent!.results.scenes,'merged');
        const merged=JSON.parse(await readFile(env.SPOTIFY_MCP_SCENES_FILE,'utf8'));
        assert.deepEqual(Object.keys(merged).sort(),['alpha','beta','gamma'],'merge must not drop a store the archive did not mention');
        assert.equal(merged.beta.tracks[0],'changed');
        assert.equal((await stat(env.SPOTIFY_MCP_SCENES_FILE)).mode & 0o777,0o600);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('overwrite replaces the store outright',async()=>{
    const dir=await scratch();
    try{
      const env={SPOTIFY_MCP_SCENES_FILE:join(dir,'scenes.json'),SPOTIFY_MCP_DATA_DIR:dir};
      await withProfileStores(env,async()=>{
        await writeFile(env.SPOTIFY_MCP_SCENES_FILE,JSON.stringify({alpha:{tracks:['x']}}));
        const p=await archive(dir,{scenes:{gamma:{tracks:['z']}}});
        const out=await harness().invoke('import_profile_state',{input_path:p,mode:'overwrite'});
        assert.equal(out.structuredContent!.results.scenes,'overwritten');
        const merged=JSON.parse(await readFile(env.SPOTIFY_MCP_SCENES_FILE,'utf8'));
        assert.deepEqual(Object.keys(merged),['gamma']);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('says nothing to import when the archive carries no known store',async()=>{
    const dir=await scratch();
    try{
      const env={SPOTIFY_MCP_DATA_DIR:dir};
      await withProfileStores(env,async()=>{
        const p=await archive(dir,{not_a_store:{a:1},scenes:null});
        const out=await harness().invoke('import_profile_state',{input_path:p});
        assert.deepEqual(out.structuredContent!.results,{});
        assert.match(textOf(out),/nothing to import/);
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('refuses an archive written by a newer schema version',async()=>{
    const dir=await scratch();
    try{
      const env={SPOTIFY_MCP_DATA_DIR:dir};
      await withProfileStores(env,async()=>{
        const p=await archive(dir,{scenes:{}},99);
        await assert.rejects(
          ()=>harness().invoke('import_profile_state',{input_path:p}),
          (e:Error)=>/schema version 99 is newer than this server's 1/.test(e.message),
        );
      });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});

describe('library_snapshot_diff (counts come from the URIs actually in the files)',()=>{
  const lib=(...albums:string[])=>({tracks:[{uri:'spotify:track:keepme00000000000000'}],albums:albums.map((a)=>({uri:a}))});

  it('counts an added and a removed album between two library.json snapshots',async()=>{
    const dir=await scratch();
    try{
      const before=join(dir,'before.json');
      const after=join(dir,'after.json');
      await writeFile(before,JSON.stringify(lib('spotify:album:aaaaaaaaaaaaaaaaaaaaaa')));
      await writeFile(after,JSON.stringify(lib('spotify:album:bbbbbbbbbbbbbbbbbbbbbb')));
      const out=await harness().invoke('library_snapshot_diff',{before_path:before,after_path:after});
      const payload=out.structuredContent!;
      assert.equal(payload.added_count,1);
      assert.equal(payload.removed_count,1);
      assert.deepEqual(payload.added_sample,['spotify:album:bbbbbbbbbbbbbbbbbbbbbb']);
      assert.deepEqual(payload.removed_sample,['spotify:album:aaaaaaaaaaaaaaaaaaaaaa']);
      assert.match(textOf(out),/\+1 added, -1 removed/);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('counts the tracks nested inside playlists.json rows, not just the playlists',async()=>{
    const dir=await scratch();
    try{
      const before=join(dir,'before.json');
      const after=join(dir,'after.json');
      await writeFile(before,JSON.stringify({playlists:[{id:'p0',uri:'spotify:playlist:p0000000000000000000',items:[{uri:'spotify:track:inside000000000000000'}]}]}));
      await writeFile(after,JSON.stringify({playlists:[{id:'p0',uri:'spotify:playlist:p0000000000000000000',items:[{uri:'spotify:track:inside000000000000000'},{uri:'spotify:track:brandnew00000000000000'}]}]}));
      const out=await harness().invoke('library_snapshot_diff',{before_path:before,after_path:after});
      assert.equal(out.structuredContent!.added_count,1);
      assert.deepEqual(out.structuredContent!.added_sample,['spotify:track:brandnew00000000000000']);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('reports the real counts while the payload sample stays capped at 10',async()=>{
    const dir=await scratch();
    try{
      const before=join(dir,'before.json');
      const after=join(dir,'after.json');
      const uris=(n:number)=>Array.from({length:n},(_,i)=>({uri:`spotify:album:${String(i).padStart(22,'0')}`}));
      await writeFile(before,JSON.stringify({albums:[]}));
      await writeFile(after,JSON.stringify({albums:uris(14)}));
      const out=await harness().invoke('library_snapshot_diff',{before_path:before,after_path:after});
      const payload=out.structuredContent!;
      assert.equal(payload.added_count,14);
      assert.equal((payload.added_sample as string[]).length,10);
      assert.match(textOf(out),/\+14 added/);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
