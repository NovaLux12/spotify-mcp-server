import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerArtistWatchTools } from '../src/tools/artistwatch.js';
type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
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
test('resolve_artist accepts typed artist URI through shared policy', async () => {
  const { registered, calls } = makeHarness(()=>{ throw new Error('should not call search'); });
  const r = await find(registered,'resolve_artist').handler({ query:'spotify://artist/abc123' });
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
    // Relative date: a hard-coded one eventually falls outside the lookback window
    // and this test becomes a time bomb (it broke main the day it turned 30 days old).
    const freshDate = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const dataAlbums = [album('new1','Fresh','album',freshDate), album('old1','Old','album','2020-01-01')];
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

// #771 — artists_scanned must count the artists the scan actually examined,
// not the ones that happened to have something new.
test('artist_release_digest reports artists scanned, not artists with hits', async () => {
  await withTmpDir(async ()=>{
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/art3/albums')) return { items:[album('d3','Digest Three')] };
      return { items:[] };
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3'] });
    const r = await find(registered,'artist_release_digest').handler({});
    const sc = r.structuredContent as unknown as Record<string,unknown>;
    assert.equal(sc.artists_scanned, 3);
    assert.equal(sc.artists_read, 3);
    assert.equal(sc.artists_failed, 0);
    assert.deepEqual(sc.failures, []);
    assert.match(text(r), /scanned 3\/3 artists/);
  });
});

test('artist_release_digest counts the quota position, not the number of hits', async () => {
  await withTmpDir(async ()=>{
    let callN = 0;
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) {
        callN++;
        // Only the last artist has anything unseen, and the 2nd hits the quota
        // wall: the old accounting reported "scanned 0" for a scan that
        // examined an artist and stopped.
        if (callN === 2) throw Object.assign(new Error('quota'), { status: 429, reason: 'QUOTA_EXCEEDED', retryAfterSec: 9 });
        if (path.includes('/artists/art3/albums')) return { items:[album('d3','Digest Three')] };
      }
      return { items:[] };
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3'] });
    const r = await find(registered,'artist_release_digest').handler({});
    const sc = r.structuredContent as unknown as Record<string,unknown>;
    assert.equal(sc.quota_hit, true);
    assert.equal(sc.quota_scanned, 2);
    assert.equal(sc.artists_scanned, 2);
    assert.equal(sc.artists_read, 1);
    assert.equal(callN, 2);
  });
});

// #772 — a stale id in a persisted watchlist must not cost the caller every
// other artist's results, and must never read as "0 new releases".
test('check_artist_releases keeps other artists when one id is unreadable', async () => {
  await withTmpDir(async ()=>{
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/art1/albums')) return { items:[album('x1','Alpha Album')] };
      if (path.includes('/artists/art3/albums')) return { items:[album('x3','Gamma Album')] };
      if (path.includes('/artists/bogus/albums')) throw Object.assign(new Error('non-existing id'), { status: 404, reason: 'NOT_FOUND' });
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','bogus','art3'] });
    const r = await find(registered,'check_artist_releases').handler({});
    const sc = r.structuredContent as unknown as {
      artists_scanned:number; artists_read:number; artists_failed:number; total:number;
      failures:Array<{artist_id:string;reason:string;status?:number}>;
      items:Array<{artist_id:string;album:{name:string}}>;
    };
    assert.equal(sc.artists_failed, 1);
    assert.equal(sc.failures.length, 1);
    assert.equal(sc.failures[0].artist_id, 'bogus');
    assert.equal(sc.failures[0].status, 404);
    assert.match(sc.failures[0].reason, /non-existing id/);
    // The readable artists survive, and the failed one is not folded in as a
    // zero-release row.
    assert.equal(sc.total, 2);
    assert.deepEqual(sc.items.map(i=>i.artist_id).sort(), ['art1','art3']);
    assert.equal(sc.artists_read, 2);
    assert.equal(sc.artists_scanned, 3);
    const t = text(r);
    assert.match(t, /Alpha Album/);
    assert.match(t, /Gamma Album/);
    assert.match(t, /bogus/);
    assert.match(t, /could not be read/);
  });
});

test('check_artist_releases reports an all-failed watchlist as unreadable, not empty', async () => {
  await withTmpDir(async ()=>{
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) throw Object.assign(new Error('upstream 500'), { status: 500 });
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['bogus1','bogus2'] });
    const r = await find(registered,'check_artist_releases').handler({});
    const sc = r.structuredContent as unknown as { artists_read:number; artists_failed:number; failures:Array<{artist_id:string}>; total:number };
    assert.equal(sc.artists_read, 0);
    assert.equal(sc.artists_failed, 2);
    assert.equal(sc.total, 0);
    assert.deepEqual(sc.failures.map(f=>f.artist_id), ['bogus1','bogus2']);
    const t = text(r);
    assert.match(t, /could not be read/);
    assert.doesNotMatch(t, /No new releases/);
  });
});

test('check_artist_releases quota mid-scan still returns the rows collected before it', async () => {
  await withTmpDir(async ()=>{
    let callN = 0;
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) {
        callN++;
        if (callN === 3) throw Object.assign(new Error('quota'), { status: 429, reason: 'QUOTA_EXCEEDED', retryAfterSec: 11 });
        return { items:[album(`r${callN}`,`Release ${callN}`)] };
      }
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3'] });
    const r = await find(registered,'check_artist_releases').handler({});
    const sc = r.structuredContent as unknown as {
      quota_hit:boolean; quota_scanned:number; artists_scanned:number; artists_read:number; total:number;
      items:Array<{artist_id:string;album:{name:string}}>;
    };
    assert.equal(sc.quota_hit, true);
    assert.equal(sc.quota_scanned, 3);
    assert.equal(sc.artists_scanned, 3);
    assert.equal(sc.artists_read, 2);
    // Non-vacuous: the two rows read before the wall are present.
    assert.equal(sc.total, 2);
    assert.deepEqual(sc.items.map(i=>i.album.name), ['Release 1','Release 2']);
  });
});

test('artist_release_digest keeps the readable artists when one lookup fails', async () => {
  await withTmpDir(async ()=>{
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/art1/albums')) return { items:[album('d1','Digest One')] };
      if (path.includes('/artists/stale/albums')) throw Object.assign(new Error('non-existing id'), { status: 404, reason: 'NOT_FOUND' });
      return { items:[] };
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','stale'] });
    const r = await find(registered,'artist_release_digest').handler({});
    const sc = r.structuredContent as unknown as {
      artists_scanned:number; artists_read:number; artists_failed:number; total:number;
      failures:Array<{artist_id:string;reason:string}>; items:Array<{artist_id:string;album:{name:string}}>;
    };
    assert.equal(sc.total, 1);
    assert.deepEqual(sc.items.map(i=>i.artist_id), ['art1']);
    assert.equal(sc.artists_read, 1);
    assert.equal(sc.artists_scanned, 2);
    assert.equal(sc.artists_failed, 1);
    assert.equal(sc.failures[0].artist_id, 'stale');
    assert.match(sc.failures[0].reason, /non-existing id/);
    const t = text(r);
    assert.match(t, /Digest One/);
    assert.match(t, /stale/);
    assert.match(t, /could not be read/);
  });
});

// A burst limit or a dead token is not this artist's fault: it must stop the
// scan rather than spend the remaining budget on requests that cannot succeed.
test('check_artist_releases stops on a burst 429 instead of collecting it as a failure', async () => {
  await withTmpDir(async ()=>{
    let callN = 0;
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) {
        callN++;
        if (callN === 2) throw Object.assign(new Error('rate limited'), { status: 429, retryAfterSec: 3 });
        return { items:[album('s1','Before Limit')] };
      }
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3','art4'] });
    const r = await find(registered,'check_artist_releases').handler({});
    const sc = r.structuredContent as unknown as {
      rate_limited:boolean; retry_after:number; rate_limit_scanned:number; quota_hit?:boolean;
      artists_scanned:number; artists_read:number; artists_failed:number; failures:unknown[]; total:number;
    };
    assert.equal(sc.rate_limited, true);
    assert.equal(sc.retry_after, 3);
    assert.equal(sc.rate_limit_scanned, 2);
    assert.equal(sc.quota_hit, undefined);
    assert.equal(sc.artists_scanned, 2);
    assert.equal(sc.artists_read, 1);
    // Not a per-artist failure: the scan stopped, so the rest were never tried.
    assert.equal(sc.artists_failed, 0);
    assert.deepEqual(sc.failures, []);
    assert.equal(sc.total, 1);
    assert.equal(callN, 2);
    assert.match(text(r), /Rate limited \(429\)/);
  });
});

test('check_artist_releases stops on a 401 that survived the token refresh', async ()=>{
  await withTmpDir(async ()=>{
    let callN = 0;
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) {
        callN++;
        if (callN === 2) throw Object.assign(new Error('The access token expired'), { status: 401 });
        return { items:[album('t1','Before Expiry')] };
      }
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3'] });
    const r = await find(registered,'check_artist_releases').handler({});
    const sc = r.structuredContent as unknown as { auth_error:boolean; auth_error_scanned:number; artists_scanned:number; total:number };
    assert.equal(sc.auth_error, true);
    assert.equal(sc.auth_error_scanned, 2);
    assert.equal(sc.artists_scanned, 2);
    assert.equal(sc.total, 1);
    assert.equal(callN, 2);
    const t = text(r);
    assert.match(t, /401/);
    assert.match(t, /spotify-mcp auth/);
  });
});

test('artist_release_digest stops on a burst 429 and keeps prior rows', async ()=>{
  await withTmpDir(async ()=>{
    let callN = 0;
    const { registered } = makeHarness((path)=>{
      if (path.includes('/artists/')) {
        callN++;
        if (callN === 2) throw Object.assign(new Error('rate limited'), { status: 429, retryAfterSec: 5 });
        return { items:[album('u1','Digest Before Limit')] };
      }
      return null;
    });
    await find(registered,'watch_artists').handler({ artist_ids:['art1','art2','art3'] });
    const r = await find(registered,'artist_release_digest').handler({});
    const sc = r.structuredContent as unknown as { rate_limited:boolean; rate_limit_scanned:number; artists_scanned:number; total:number; items:Array<{album:{name:string}}> };
    assert.equal(sc.rate_limited, true);
    assert.equal(sc.rate_limit_scanned, 2);
    assert.equal(sc.artists_scanned, 2);
    assert.equal(sc.total, 1);
    assert.deepEqual(sc.items.map(i=>i.album.name), ['Digest Before Limit']);
    assert.equal(callN, 2);
    assert.match(text(r), /Rate limited \(429\)/);
  });
});

// ---------------------------------------------------------------------------
// #764: the sidecar is not a best-effort store. A write that does not land is
// reported as a failure, a file that cannot be parsed is reported as corrupt
// rather than reset, and the path does not follow the process cwd.
// ---------------------------------------------------------------------------

type Scoped = { restore: () => Promise<void> };

/** Point the store at a HOME the test owns, with no DATA_DIR override. */
async function withHome(home: string): Promise<Scoped> {
  const prevHome = process.env.HOME;
  const prevDir = process.env.SPOTIFY_MCP_DATA_DIR;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  delete process.env.SPOTIFY_MCP_DATA_DIR;
  return {
    restore: async () => {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevDir === undefined) delete process.env.SPOTIFY_MCP_DATA_DIR; else process.env.SPOTIFY_MCP_DATA_DIR = prevDir;
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('a watchlist that cannot be written is reported, never answered with an added count (#764)', async () => {
  await withTmpDir(async (dir) => {
    // A directory sitting where the atomic write's temp name belongs: the store
    // reads as absent, and publishing one fails for every user, root included.
    await mkdir(join(dir, 'artist-watchlist.json.tmp'), { recursive: true });
    const { registered } = makeHarness(() => ({ items: [album('a1', 'Album One')] }));
    const r = await find(registered, 'watch_artists').handler({ artist_ids: ['a1'] });
    assert.equal(r.isError, true);
    assert.doesNotMatch(text(r), /\b1 added\b/, 'a write that did not land is not an addition');
    assert.match(text(r), /NOT saved/);
    const sc = r.structuredContent as unknown as { ok: boolean; persisted: boolean; path: string; error: string; total: number };
    assert.equal(sc.ok, false);
    assert.equal(sc.persisted, false);
    assert.equal(sc.path, join(dir, 'artist-watchlist.json'));
    assert.equal(sc.total, 1);
    assert.ok(sc.error.length > 0, 'the failure names its cause');
    assert.equal(existsSync(join(dir, 'artist-watchlist.json')), false, 'nothing was created on disk');
  });
});

test('a corrupt sidecar is reported with its path and preserved, not reset to empty (#764)', async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'artist-watchlist.json');
    const bytes = '{"watchlists":{"default":{"artists":["a1"]';
    await writeFile(file, bytes);
    const { registered } = makeHarness();
    const r = await find(registered, 'watch_artists').handler({ artist_ids: ['a2'] });
    // Reported, not thrown: the process-wide tool boundary replaces a thrown
    // error with a generic "invalid arguments" envelope that names no file.
    assert.equal(r.isError, true);
    assert.match(text(r), /not valid JSON/);
    assert.match(text(r), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const sc = r.structuredContent as unknown as { ok: boolean; persisted: boolean; reason: string; error: string };
    assert.equal(sc.ok, false);
    assert.equal(sc.persisted, false);
    assert.equal(sc.reason, 'store_unreadable');
    assert.ok(sc.error.length > 0);
    assert.equal(await readFile(file, 'utf8'), bytes, 'the unreadable file is left exactly as it was');
    assert.equal(await readFile(`${file}.corrupt`, 'utf8'), bytes, 'its bytes are preserved for repair');
  });
});

test('a sidecar that is not a watchlist store is corruption, not an empty list (#764)', async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'artist-watchlist.json');
    await writeFile(file, '{"watchlists":[]}', 'utf8');
    const { registered } = makeHarness();
    const r = await find(registered, 'check_artist_releases').handler({});
    assert.equal(r.isError, true);
    assert.match(text(r), /not a watchlist store/);
    assert.equal(await readFile(file, 'utf8'), '{"watchlists":[]}', 'it was not overwritten with an empty store');
  });
});

test('the watchlist is the same file from any working directory (#764)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aw-home-'));
  const scope = await withHome(home);
  const dirA = await mkdtemp(join(tmpdir(), 'aw-cwd-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'aw-cwd-b-'));
  try {
    process.chdir(dirA);
    const first = makeHarness(() => ({ items: [album('a1', 'Album One')] }));
    await find(first.registered, 'watch_artists').handler({ artist_ids: ['a1'] });

    process.chdir(dirB);
    const second = makeHarness(() => ({ items: [album('a1', 'Album One')] }));
    const r = await find(second.registered, 'check_artist_releases').handler({});
    const sc = r.structuredContent as unknown as { artists_scanned: number; watchlist_size: number; path: string };
    assert.equal(sc.watchlist_size, 1);
    assert.equal(sc.artists_scanned, 1, 'the artist added from the other directory is found here');
    assert.equal(sc.path, join(home, '.spotify-mcp', 'artist-watchlist.json'));
    assert.equal(existsSync(join(dirA, 'data')), false, 'no cwd-relative sidecar was created');
    assert.equal(existsSync(join(dirB, 'data')), false, 'no cwd-relative sidecar was created');
  } finally {
    await scope.restore();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('a pre-v2 ./data/artist-watchlist.json is read once and migrated to the aligned path (#764)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aw-home-'));
  const scope = await withHome(home);
  const legacyCwd = await mkdtemp(join(tmpdir(), 'aw-legacy-'));
  try {
    await mkdir(join(legacyCwd, 'data'), { recursive: true });
    await writeFile(
      join(legacyCwd, 'data', 'artist-watchlist.json'),
      JSON.stringify({ watchlists: { default: { artists: ['legacy1'], createdAt: 'x', lastChecked: null, seen: {} } } }),
      'utf8',
    );
    process.chdir(legacyCwd);
    const { registered } = makeHarness(() => ({ items: [album('a1', 'Album One')] }));
    const r = await find(registered, 'watch_artists').handler({ artist_ids: ['a2'] });
    const sc = r.structuredContent as unknown as { artists: string[]; migrated_from: string | undefined; path: string };
    assert.equal(sc.migrated_from, join('data', 'artist-watchlist.json'));
    assert.deepEqual([...sc.artists].sort(), ['a2', 'legacy1'], 'the pre-v2 watchlist was not discarded');
    const moved = JSON.parse(await readFile(sc.path, 'utf8')) as { watchlists: Record<string, { artists: string[] }> };
    assert.deepEqual([...moved.watchlists.default.artists].sort(), ['a2', 'legacy1']);
    assert.match(text(r), /Migrated from/);
  } finally {
    await scope.restore();
    await rm(legacyCwd, { recursive: true, force: true });
  }
});

test('a check whose seen-bookkeeping cannot be saved says the watchlist did not advance (#764)', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(
      join(dir, 'artist-watchlist.json'),
      JSON.stringify({ watchlists: { default: { artists: ['a1'], createdAt: 'x', lastChecked: null, seen: {} } } }),
      'utf8',
    );
    // A directory where the atomic write's temp name belongs: the store reads
    // fine, but publishing a new one fails for every user, root included.
    await mkdir(join(dir, 'artist-watchlist.json.tmp'), { recursive: true });
    const { registered } = makeHarness(() => ({ items: [album('a1', 'Album One')] }));
    const r = await find(registered, 'check_artist_releases').handler({});
    const sc = r.structuredContent as unknown as { persisted: boolean; total: number; path: string };
    assert.equal(sc.total, 1, 'the scan still reports the release it read');
    assert.equal(sc.persisted, false, 'the watchlist did not advance and must not read as if it did');
    assert.equal(sc.path, join(dir, 'artist-watchlist.json'));
    assert.match(text(r), /NOT saved/);
    const onDisk = JSON.parse(await readFile(join(dir, 'artist-watchlist.json'), 'utf8')) as { watchlists: Record<string, { seen: Record<string, string[]> }> };
    assert.deepEqual(onDisk.watchlists.default.seen, {}, 'seen was not advanced on disk');
  });
});
