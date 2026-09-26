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
