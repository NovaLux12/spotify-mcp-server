import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerArtistWatchTools } from '../src/tools/artistwatch.js';
type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, { safeParse(a: unknown): { success: boolean } }>; handler: (a: Record<string, unknown>) => Promise<ToolContent> };
function album(id:string, name:string, type='album', date='2026-08-01'){ return { id, name, uri:`spotify:album:${id}`, album_type:type, release_date:date, total_tracks:10, artists:[{id:'art1',name:'Artist'}] }; }
function makeHarness(getResponse?: (path:string, params?:Record<string,string>)=>unknown, putImpl?: (path:string, body?:unknown)=>Promise<void>){
  const calls: Array<{method:string;path:string;params?:Record<string,string>;body?:unknown}> = [];
  const client = {
    get: async (path:string, params?:Record<string,string>)=>{ calls.push({method:'GET',path,params}); return getResponse ? getResponse(path,params): null; },
    put: async (path:string, body?:unknown)=>{ calls.push({method:'PUT',path,body}); if(putImpl) return putImpl(path,body); },
    post: async (path:string)=>{calls.push({method:'POST',path}); return null;},
    delete: async (path:string)=>{calls.push({method:'DELETE',path});},
    getAllPages: async ()=>[],
  };
  const registered: RegisteredTool[] = [];
  const server = { tool:(n:string,d:string,s:RegisteredTool['schema'],h:RegisteredTool['handler'])=> registered.push({name:n,description:d,schema:s,handler:h}) };
  registerArtistWatchTools(server as never, client as never);
  return { registered, calls, client };
}
function find(r:RegisteredTool[], n:string){ const t=r.find(x=>x.name===n); assert.ok(t,`missing ${n}`); return t!; }
function text(r:ToolContent){ return r.content.map(c=>c.text).join('\n'); }
async function withTmpDir(fn:(dir:string)=>Promise<void>){
  const dir = join(tmpdir(), `aw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir,{recursive:true});
  const prev = process.env.SPOTIFY_MCP_DATA_DIR;
  process.env.SPOTIFY_MCP_DATA_DIR = dir;
  try { await fn(dir); } finally { process.env.SPOTIFY_MCP_DATA_DIR = prev; await rm(dir,{recursive:true,force:true}); }
}
test('get_artist_discography filtered and limit', async () => {
  const { registered } = makeHarness(()=>({ items:[album('a1','Album One','album'),album('a2','Single One','single'),album('a3','Comp','compilation')], total:3, limit:20, offset:0 }));
  const r = await find(registered,'get_artist_discography').handler({ artist_id:'art1', album_types:['album'], max_results:10 });
  const t=text(r);
  assert.match(t,/Album One/);
  assert.doesNotMatch(t,/Single One/);
  assert.doesNotMatch(t,/Comp/);
});
test('get_artist_discography empty', async () => {
  const { registered } = makeHarness(()=>({ items:[], total:0 }));
  const r = await find(registered,'get_artist_discography').handler({ artist_id:'art1', album_types:['album'] });
  assert.match(text(r),/No releases/);
});
test('resolve_artist finds and marks top match', async () => {
  const { registered } = makeHarness(()=>({ artists:{ items:[{id:'id1',name:'Queen',uri:'spotify:artist:id1'},{id:'id2',name:'Queens',uri:'spotify:artist:id2'}], total:2 }}));
  const r = await find(registered,'resolve_artist').handler({ query:'Queen', max_results:1 });
  const t=text(r);
  assert.match(t,/Queen/);
  assert.doesNotMatch(t,/Queens/);
  assert.equal(((r.structuredContent as unknown) as {resolved:{id:string}}).resolved.id,'id1');
});
test('resolve_artist URI passthrough', async () => {
  const { registered, calls } = makeHarness(()=>{ throw new Error('should not call search'); });
  const r = await find(registered,'resolve_artist').handler({ query:'spotify:artist:abc123' });
  assert.match(text(r),/abc123/);
  assert.equal(calls.length,0);
});
test('save_artist_new_releases saves only unsaved', async () => {
  const puts: unknown[] = [];
  const { registered } = makeHarness((path)=>{
    if (path.includes('/artists/art1/albums')) return { items:[album('alb1','New Album'),album('alb2','Old Album')] };
    if (path==='/me/library/contains') return [false,true];
    return null;
  }, async (path, body)=>{ puts.push({path,body}); });
  const r = await find(registered,'save_artist_new_releases').handler({ artist_id:'art1' });
  assert.match(text(r),/Saved 1/);
  assert.match(text(r),/New Album/);
  assert.equal(puts.length,1);
});
test('save_artist_new_releases all already saved', async () => {
  const { registered } = makeHarness((path)=>{
    if (path.includes('/artists/art1/albums')) return { items:[album('alb1','A')] };
    if (path==='/me/library/contains') return [true];
    return null;
  });
  const r = await find(registered,'save_artist_new_releases').handler({ artist_id:'art1' });
  assert.match(text(r),/already in Your Library/);
});
test('watch_artists and check_artist_releases sidecar', async () => {
  await withTmpDir(async ()=>{
    const dataAlbums = [album('new1','Fresh','album','2026-08-20'), album('old1','Old','album','2020-01-01')];
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/art1/albums')) return { items:dataAlbums };
      return null;
    });
    const r1 = await find(registered,'watch_artists').handler({ artist_ids:['art1'] });
    assert.match(text(r1),/1 added/);
    const r2 = await find(registered,'check_artist_releases').handler({ lookback_days:30 });
    const t2=text(r2);
    assert.match(t2,/Fresh/);
    assert.doesNotMatch(t2,/Old/);
    const r3 = await find(registered,'check_artist_releases').handler({ lookback_days:1000 });
    assert.match(text(r3),/No new releases/);
  });
});
test('artist_release_digest shows unseen', async () => {
  await withTmpDir(async ()=>{
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/art1/albums')) return { items:[album('d1','Digest One')] };
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1'] });
    const r = await find(registered,'artist_release_digest').handler({});
    assert.match(text(r),/Digest One/);
  });
});

test('check_artist_releases budget caps and reports truncated', async () => {
  await withTmpDir(async ()=>{
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) return { items:[album('a1','Fresh','album','2026-08-20')] };
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3','art4','art5'] });
    const r = await find(registered,'check_artist_releases').handler({ max_artists: 2, lookback_days: 1000 });
    const sc = r.structuredContent as unknown as Record<string,unknown>;
    assert.equal(sc.truncated, true);
    assert.equal(sc.watchlist_size, 5);
    assert.equal(sc.artists_scanned, 2);
  });
});

test('check_artist_releases dry_run returns cost estimate without calls', async () => {
  await withTmpDir(async ()=>{
    let getCalled = false;
    const { registered } = makeHarness((path)=>{
      getCalled = true;
      if (path.includes('/artists/')) return { items:[] };
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2'] });
    getCalled = false;
    const r = await find(registered,'check_artist_releases').handler({ max_artists: 1, dry_run: true });
    assert.equal(getCalled, false);
    const sc = r.structuredContent as unknown as Record<string,unknown>;
    assert.equal(sc.dry_run, true);
    assert.equal(sc.would_check, 1);
    assert.match(text(r), /dry run/i);
    assert.match(text(r), /Cost estimate/i);
  });
});

test('check_artist_releases quota recovery returns partial', async () => {
  await withTmpDir(async ()=>{
    let callN = 0;
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) {
        callN++;
        if (callN === 2) throw Object.assign(new Error('quota'), { status: 429, reason: 'QUOTA_EXCEEDED', retryAfterSec: 7 });
        return { items:[album('a1','Fresh','album','2026-08-20')] };
      }
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3'] });
    const r = await find(registered,'check_artist_releases').handler({ lookback_days: 1000 });
    const sc = r.structuredContent as unknown as Record<string,unknown>;
    assert.equal(sc.quota_hit, true);
    assert.equal(sc.retry_after, 7);
  });
});

test('artist_release_digest dry_run and budget cap', async () => {
  await withTmpDir(async ()=>{
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) return { items:[album('d1','Digest One')] };
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3'] });
    const r = await find(registered,'artist_release_digest').handler({ dry_run: true, max_artists: 1 });
    const sc = r.structuredContent as unknown as Record<string,unknown>;
    assert.equal(sc.dry_run, true);
    assert.equal(sc.would_check, 1);
    assert.equal(sc.watchlist_size, 3);
  });
});

test('watch_artists warns when >50 artists', async () => {
  await withTmpDir(async ()=>{
    const { registered } = makeHarness(()=>null);
    const many = Array.from({length: 51}, (_,i)=>`art${i}`);
    const r = await find(registered,'watch_artists').handler({ artist_ids: many });
    assert.match(text(r), /Warning/i);
    const sc = r.structuredContent as unknown as Record<string,unknown>;
    assert.ok(sc.warning);
  });
});
