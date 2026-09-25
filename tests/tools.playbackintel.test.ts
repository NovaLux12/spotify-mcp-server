import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPlaybackIntelTools } from '../src/tools/playbackintel.js';
import { registerPlaybackTools } from '../src/tools/playback.js';

type ToolContent = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> };
type RegisteredTool = { name: string; description: string; schema: Record<string, any>; handler: (args: Record<string, unknown>) => Promise<ToolContent> };
type Call = { method: string; path: string; params?: Record<string, string>; body?: unknown };

function trackFixture(o: any = {}) { return { id:'trk1', name:'T1', uri:'spotify:track:trk1', type:'track', duration_ms:200000, artists:[{name:'A'}], album:{name:'Alb'}, ...o }; }

function makeHarness(opts: { getResponse?: (path:string, params?:Record<string,string>)=>unknown; failPut?: (path:string)=>boolean } = {}) {
  const calls: Call[] = [];
  const registered: RegisteredTool[] = [];
  const server: any = { tool(name:string, desc:string, schema:any, handler:any){ registered.push({ name, description: desc, schema, handler }); } };
  const client: any = {
    get: async (path:string, params?:Record<string,string>) => { calls.push({ method:'GET', path, params }); if (opts.getResponse) { const r = opts.getResponse(path, params); if (r!==undefined) return r; } return null; },
    put: async (path:string, body?:unknown) => { calls.push({ method:'PUT', path, body }); if (opts.failPut?.(path)) throw new Error('write rejected'); },
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
function playlistTracksTotal(r:ToolContent): unknown {
  const resolved = r.structuredContent?.resolved;
  return typeof resolved === 'object' && resolved !== null && 'tracks_total' in resolved ? resolved.tracks_total : undefined;
}

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

// #842 — play_at must enforce the same argument contract as `play`.
test('play_at refuses context_uri + uris with zero client calls', async()=>{
  const { registered, calls } = makeHarness();
  await assert.rejects(
    () => invoke(find(registered,'play_at'), { context_uri:'spotify:album:alb1', uris:['spotify:track:trk1'], at:'0:30' }),
    /Provide either context_uri or uris, not both\./,
  );
  assert.equal(calls.length, 0, 'no Spotify call may happen for an ambiguous call');
});
test('play_at refuses an invalid uri with zero client calls', async()=>{
  const { registered, calls } = makeHarness();
  await assert.rejects(
    () => invoke(find(registered,'play_at'), { uris:['not-a-spotify-uri'], at:'0:30' }),
    /Invalid Spotify URI\(s\): not-a-spotify-uri/,
  );
  assert.equal(calls.length, 0);
});
test('play_at refuses offset for ad-hoc uris', async()=>{
  const { registered, calls } = makeHarness();
  await assert.rejects(
    () => invoke(find(registered,'play_at'), { uris:['spotify:track:trk1'], at:'0:30', offset:2 }),
    /offset is ignored when playing ad-hoc uris/,
  );
  assert.equal(calls.length, 0);
});
test('play_at refuses a numeric offset on an artist context', async()=>{
  const { registered, calls } = makeHarness();
  await assert.rejects(
    () => invoke(find(registered,'play_at'), { context_uri:'spotify:artist:art1', at:'0:30', offset:2 }),
    /Numeric offset is not valid for artist contexts/,
  );
  assert.equal(calls.length, 0);
});
test('play_at uris body matches what play sends for the same uris', async()=>{
  const uris = ['spotify:track:trk1','spotify:episode:ep1'];
  const { registered, calls } = makeHarness();
  await invoke(find(registered,'play_at'), { uris, position_ms:1500, device_id:'dev 1' });
  const put = calls.find(c=>c.method==='PUT');
  assert.ok(put);
  assert.equal(put!.path, '/me/player/play?device_id=dev%201');
  // Same shape `play` builds — uris verbatim, no context_uri, no offset key
  // (the endpoint rejects offset for ad-hoc uris). Only position_ms, which is
  // play_at's whole reason to exist, is added.
  const playSent = await playBody({ uris, device_id:'dev 1' });
  assert.deepEqual({ ...(put!.body as Record<string, unknown>), position_ms: 0 }, { ...playSent, position_ms: 0 });
  assert.equal((put!.body as Record<string, number>).position_ms, 1500);
});
test('play_at context_uri body matches what play sends for the same context', async()=>{
  const { registered, calls } = makeHarness();
  await invoke(find(registered,'play_at'), { context_uri:'spotify:playlist:pl1', at:'0:30', offset:4 });
  const put = calls.find(c=>c.method==='PUT');
  assert.ok(put);
  const playSent = await playBody({ context_uri:'spotify:playlist:pl1', offset:4 });
  assert.deepEqual({ ...(put!.body as Record<string, unknown>), position_ms: 0 }, { ...playSent, position_ms: 0 });
  assert.equal((put!.body as Record<string, number>).position_ms, 30000);
});

/** The body `play` (src/tools/playback.ts) sends for these args — play_at's parity reference. */
async function playBody(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const calls: Call[] = [];
  const registered: RegisteredTool[] = [];
  const server: any = { tool(name:string, desc:string, schema:any, handler:any){ registered.push({ name, description: desc, schema, handler }); } };
  const client: any = {
    get: async()=> null,
    put: async (path:string, body?:unknown) => { calls.push({ method:'PUT', path, body }); },
    post: async()=> {}, delete: async()=> {}, getAllPages: async()=>[],
  };
  registerPlaybackTools(server, client);
  await find(registered,'play').handler(args);
  const put = calls.find(c=>c.method==='PUT');
  assert.ok(put, 'play did not issue a PUT');
  return (put!.body ?? {}) as Record<string, unknown>;
}
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
test('get_playback_context projects items(total) and reads items.total', async()=>{
  const { registered, calls } = makeHarness({ getResponse:(p)=> p==='/me/player'?{ context:{uri:'spotify:playlist:pl1'} } : p==='/playlists/pl1'?{ name:'PL', items:{total:20}}:null });
  const r = await invoke(find(registered,'get_playback_context'), {});
  const plCall = calls.find(c=>c.path==='/playlists/pl1');
  assert.ok(plCall, 'playlist must be fetched');
  assert.equal(plCall!.params?.fields, 'name,owner(display_name,id),items(total),public,collaborative,uri');
  assert.equal(playlistTracksTotal(r), 20);
});
test('get_playback_context still reads deprecated tracks.total projection', async()=>{
  const { registered } = makeHarness({ getResponse:(p)=> p==='/me/player'?{ context:{uri:'spotify:playlist:pl1'} } : p==='/playlists/pl1'?{ name:'PL', tracks:{total:7}}:null });
  const r = await invoke(find(registered,'get_playback_context'), {});
  assert.equal(playlistTracksTotal(r), 7);
});
// #830: Spotify declares volume_percent as the required query parameter; the
// `volume` spelling is silently rejected, so the nudge never applied.
test('volume_step writes volume_percent, not volume', async()=>{
  const { registered, calls } = makeHarness({ getResponse:(p)=> p==='/me/player'?{ device:{ id:'d1', volume_percent:50}}:null });
  await invoke(find(registered,'volume_step'), { step:10 });
  const put = calls.find(c=>c.method==='PUT' && c.path.startsWith('/me/player/volume'));
  assert.ok(put, 'volume_step must PUT the volume');
  const qs = new URLSearchParams(put!.path.split('?')[1]);
  assert.equal(qs.get('volume_percent'), '60');
  assert.equal(qs.get('device_id'), 'd1');
  assert.equal(qs.get('volume'), null, 'Spotify does not accept `volume`: ' + put!.path);
});
test('play_on writes volume_percent on the resolved device', async()=>{
  const { registered, calls } = makeHarness({ getResponse:(p)=> p==='/me/player/devices'?{ devices:[{ id:'dev1', name:'Kitchen Speaker'}]}:undefined });
  await invoke(find(registered,'play_on'), { device:'kitchen', context_uri:'spotify:playlist:abc', volume:25 });
  const put = calls.find(c=>c.method==='PUT' && c.path.startsWith('/me/player/volume'));
  assert.ok(put, 'play_on must PUT the requested volume');
  const qs = new URLSearchParams(put!.path.split('?')[1]);
  assert.equal(qs.get('volume_percent'), '25');
  assert.equal(qs.get('device_id'), 'dev1');
  assert.equal(qs.get('volume'), null, 'Spotify does not accept `volume`: ' + put!.path);
});
test('play_on does not report a rejected volume write as applied', async()=>{
  const { registered } = makeHarness({
    getResponse:(p)=> p==='/me/player/devices'?{ devices:[{ id:'dev1', name:'Kitchen Speaker'}]}:undefined,
    failPut:(p)=>p.startsWith('/me/player/volume'),
  });
  const r = await invoke(find(registered,'play_on'), { device:'kitchen', context_uri:'spotify:playlist:abc', volume:25 });
  const sc = r.structuredContent as Record<string, unknown>;
  assert.equal(sc.ok, false, 'a rejected volume write must not report ok:true');
  assert.equal(sc.volume_applied, false);
  assert.match(String(sc.volume_error), /rejected/);
  assert.doesNotMatch(text(r), /@ 25%/);
  assert.match(text(r), /NOT applied/);
});

// #837: a rejected shuffle write used to be swallowed by an empty `catch {}`,
// so the whole call still reported ok:true and the text claimed success.
test('play_on does not report a rejected shuffle write as applied, and still plays', async()=>{
  const { registered, calls } = makeHarness({
    getResponse:(p)=> p==='/me/player/devices'?{ devices:[{ id:'dev1', name:'Kitchen Speaker'}]}:undefined,
    failPut:(p)=>p.startsWith('/me/player/shuffle'),
  });
  const r = await invoke(find(registered,'play_on'), { device:'kitchen', context_uri:'spotify:playlist:abc', shuffle:true });
  const sc = r.structuredContent as Record<string, unknown>;
  assert.equal(sc.ok, false, 'a rejected shuffle write must not report ok:true');
  assert.equal(sc.shuffle_applied, false);
  assert.equal(sc.shuffle_state, true);
  assert.match(String(sc.shuffle_error), /rejected/);
  assert.match(text(r), /shuffle on was NOT applied/);
  assert.ok(
    calls.some(c=>c.method==='PUT' && c.path.startsWith('/me/player/play')),
    'the primary effect — the play — must still be issued after a rejected shuffle write',
  );
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
