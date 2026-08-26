import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPlaybackIntelTools } from '../src/tools/playbackintel.js';

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, any>; handler: (args: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; params?: Record<string, string>; body?: unknown };

function trackFixture(o: any = {}) { return { id:'trk1', name:'T1', uri:'spotify:track:trk1', type:'track', duration_ms:200000, artists:[{name:'A'}], album:{name:'Alb'}, ...o }; }

function makeHarness(opts: { getResponse?: (path:string, params?:Record<string,string>)=>unknown } = {}) {
  const calls: Call[] = [];
  const registered: RegisteredTool[] = [];
  const server: any = { tool(name:string, desc:string, schema:any, handler:any){ registered.push({ name, description: desc, schema, handler }); } };
  const client: any = {
    get: async (path:string, params?:Record<string,string>) => { calls.push({ method:'GET', path, params }); if (opts.getResponse) { const r = opts.getResponse(path, params); if (r!==undefined) return r; } return null; },
    put: async (path:string, body?:unknown) => { calls.push({ method:'PUT', path, body }); },
    post: async (path:string, body?:unknown) => { calls.push({ method:'POST', path, body }); },
    delete: async (path:string) => { calls.push({ method:'DELETE', path }); },
    getAllPages: async()=>[],
  };
  registerPlaybackIntelTools(server, client);
  return { registered, calls, client };
}
function find(registered:RegisteredTool[], name:string){ const t=registered.find(x=>x.name===name); assert.ok(t, `tool ${name} not found`); return t!; }
async function invoke(t:RegisteredTool, args:Record<string,unknown>){ return t.handler(args); }
function text(r:ToolContent){ return r.content.map(c=>c.text).join('\n'); }

test('play_on resolves device name and plays', async()=>{
  const { registered, calls } = makeHarness({ getResponse:(p)=> p==='/me/player/devices' ? { devices:[{ id:'dev1', name:'Kitchen Speaker'}]} : p==='/search' ? { tracks:{ items:[{ uri:'spotify:track:xyz', name:'Hit'}]}} : undefined });
  const r = await invoke(find(registered,'play_on'), { device:'kitchen', query:'hit' });
  assert.match(text(r), /Kitchen/); assert.ok(calls.some(c=>c.path.includes('/me/player/play')));
});
test('play_on device not found', async()=>{
  const { registered } = makeHarness({ getResponse:(p)=> p==='/me/player/devices' ? { devices:[]} : undefined });
  const r = await invoke(find(registered,'play_on'), { device:'nope', context_uri:'spotify:playlist:abc' });
  assert.match(text(r), /No device matches/);
});
test('queue_next appends with disclosure', async()=>{
  const { registered, calls } = makeHarness();
  const r = await invoke(find(registered,'queue_next'), { uri:'spotify:track:trk1' });
  assert.match(text(r), /tail-only/); assert.ok(calls.some(c=>c.method==='POST' && c.path.includes('/me/player/queue')));
  const sc=r.structuredContent as any; assert.equal(sc.insertion,'tail');
});
test('queue_next dry_run', async()=>{
  const { registered } = makeHarness();
  const r = await invoke(find(registered,'queue_next'), { uri:'spotify:track:trk1', dry_run:true });
  assert.match(text(r), /\[dry run\]/);
});
test('describe_queue enriched', async()=>{
  const q={ currently_playing: trackFixture(), queue:[trackFixture({uri:'spotify:track:q2', name:'Q2'}), trackFixture({uri:'spotify:track:q3', name:'Q3'})] };
  const { registered } = makeHarness({ getResponse:(p)=> p==='/me/player/queue'?q : p==='/me/player'?{ context:{uri:'spotify:playlist:pl1'}, device:{id:'d1'}} : p.startsWith('/playlists/')?{name:'My Playlist'}:null });
  const r = await invoke(find(registered,'describe_queue'), { include_context:true });
  assert.match(text(r), /Queue:/);
});
test('describe_listening_session groups', async()=>{
  const items=[{ played_at:'2026-08-26T10:00:00Z', track: trackFixture()},{ played_at:'2026-08-26T10:03:00Z', track: trackFixture({uri:'spotify:track:trk2'})}];
  const { registered } = makeHarness({ getResponse:()=> ({ items })});
  const r = await invoke(find(registered,'describe_listening_session'), { limit:10, as_session:true });
  assert.match(text(r), /Listening sessions/);
});
test('play_at H:MM:SS parsing', async()=>{
  const { registered, calls } = makeHarness();
  await invoke(find(registered,'play_at'), { context_uri:'spotify:album:alb1', at:'1:30' });
  const put=calls.find(c=>c.method==='PUT'); assert.ok(put); assert.equal((put!.body as any).position_ms, 90000);
});
test('device_health merges', async()=>{
  const { registered } = makeHarness({ getResponse:(p)=> p==='/me/player/devices'?{ devices:[{ id:'d1', name:'Kitchen', type:'Speaker', volume_percent:70}]} : p==='/me/player'?{ device:{ id:'d1'}} : null });
  const r = await invoke(find(registered,'device_health'), {});
  assert.match(text(r), /Kitchen/);
});
test('seek_relative forward', async()=>{
  const { registered, calls } = makeHarness({ getResponse:(p)=> p==='/me/player'?{ progress_ms:10000, item:{ duration_ms:200000}}:null });
  await invoke(find(registered,'seek_relative'), { delta_ms:30000 });
  assert.ok(calls.some(c=>c.path.includes('/me/player/seek') && c.path.includes('40000')));
});
test('playback_timeline ETA', async()=>{
  const { registered } = makeHarness({ getResponse:(p)=> p==='/me/player'?{ is_playing:true, progress_ms:60000, item:{ name:'T1', uri:'spotify:track:trk1', duration_ms:200000, artists:[{name:'A'}]}} : p==='/me/player/queue'?{ queue:[{ duration_ms:180000}]} : null });
  const r = await invoke(find(registered,'playback_timeline'), { include_queue:true });
  assert.match(text(r), /ETA/);
});
test('repeat_queue_toggle', async()=>{
  const { registered, calls } = makeHarness();
  await invoke(find(registered,'repeat_queue_toggle'), { enable:true, shuffle:true });
  assert.ok(calls.some(c=>c.path.includes('/me/player/repeat?state=context')));
  assert.ok(calls.some(c=>c.path.includes('/me/player/shuffle')));
});
test('now_playing_history merges', async()=>{
  const { registered } = makeHarness({ getResponse:(p)=> p==='/me/player/recently-played'?{ items:[{ played_at:'2026-08-26T10:00:00Z', track: trackFixture()}]} : p==='/me/player/currently-playing'?{ item: trackFixture({uri:'spotify:track:live', name:'Live'})}:null });
  const r = await invoke(find(registered,'now_playing_history'), { limit:10 });
  assert.match(text(r), /Live/);
});
test('peek_next lookahead', async()=>{
  const { registered } = makeHarness({ getResponse:(p)=> p==='/me/player/queue'?{ queue:[trackFixture(), trackFixture({uri:'spotify:track:q2'})]}:null });
  const r = await invoke(find(registered,'peek_next'), { count:1 });
  assert.match(text(r), /Next 1/);
});
test('get_playback_context resolves playlist', async()=>{
  const { registered } = makeHarness({ getResponse:(p)=> p==='/me/player'?{ context:{uri:'spotify:playlist:pl1'}, item:{ uri:'spotify:track:trk1', name:'T1'}} : p==='/playlists/pl1'?{ name:'My PL', owner:{display_name:'me'}, tracks:{total:20}}:null });
  const r = await invoke(find(registered,'get_playback_context'), {});
  assert.match(text(r), /My PL/);
});
test('volume_step nudge', async()=>{
  const { registered, calls } = makeHarness({ getResponse:(p)=> p==='/me/player'?{ device:{ id:'d1', volume_percent:50}}:null });
  await invoke(find(registered,'volume_step'), { step:10 });
  assert.ok(calls.some(c=>c.path.includes('/me/player/volume') && c.path.includes('60')));
});
test('market_availability', async()=>{
  const { registered } = makeHarness({ getResponse:(p)=> p.startsWith('/tracks/')?{ name:'Hit', available_markets:['US','GB','DE']}:null });
  const r = await invoke(find(registered,'market_availability'), { uri:'spotify:track:trk1', markets:['US','GB','DE'] });
  assert.match(text(r), /3\/3 markets available/);
});
test('playback_compare_states diff (sidecar)', async()=>{
  const dir = join(tmpdir(), `pb-intel-test-${Date.now()}`);
  await mkdir(dir, { recursive:true });
  const file = join(dir,'playback-ext.json');
  const store={ states:{ a:{ name:'a', saved_at:'2026-08-26T10:00:00Z', playback:{ item:{ uri:'spotify:track:trk1', name:'T1'}, progress_ms:1000, shuffle_state:false, repeat_state:'off', device:{id:'d1'}, context:{uri:'spotify:playlist:pl1'}}}, b:{ name:'b', saved_at:'2026-08-26T11:00:00Z', playback:{ item:{ uri:'spotify:track:trk2', name:'T2'}, progress_ms:5000, shuffle_state:true, repeat_state:'context', device:{id:'d2'}, context:{uri:'spotify:playlist:pl2'}}} }, devicePresets:{}, sessions:{}, smartRules:{} };
  await writeFile(file, JSON.stringify(store));
  const orig = process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE;
  process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = file;
  const { registered } = makeHarness();
  const r = await invoke(find(registered,'playback_compare_states'), { state_a:'a', state_b:'b' });
  assert.match(text(r), /shuffle_state/);
  process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = orig ?? '';
  if (!orig) delete process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE;
  await rm(dir, { recursive:true, force:true });
});
