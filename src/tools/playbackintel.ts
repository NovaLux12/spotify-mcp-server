/**
 * playbackintel — exhaustive playback/queue/player intel (#272-283 slice)
 * 12 tools: play_on, queue_next, describe_queue, describe_listening_session,
 * play_at, device_health, seek_relative, playback_timeline, repeat_queue_toggle,
 * now_playing_history, playback_compare_states, peek_next
 * + triage extras: get_playback_context, volume_step, market_availability
 * Each tool notes quota in description (🟢/🟡).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import type { PlaybackState, SpotifyQueue, GetDevicesResponse, SpotifyDevice, SpotifyTrack, SpotifyEpisode } from '../types/spotify.js';
import { ResponseFormat, DryRun, MaxResults, resolveMaxResults, truncateItems, parseSpotifyUri, describeDryRun } from '../shaping.js';
import { loadPlaybackExt, detectSessions } from './playbackext.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}
function emit(fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolResult {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}
function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function formatItem(it: any): string {
  if (!it) return '—';
  if ('artists' in it) return `"${it.name}" by ${(it.artists??[]).map((a:any)=>a.name).join(', ')}`;
  return `"${it.name}" — ${it.show?.name ?? 'episode'}`;
}
async function resolveDeviceHint(client: SpotifyClient, hint: string): Promise<{ deviceId: string | null; devices: SpotifyDevice[] }> {
  const res = await client.get<GetDevicesResponse>('/me/player/devices');
  const devices = res?.devices ?? [];
  const exact = devices.find((d) => d.id === hint);
  const found = exact ?? devices.find((d) => d.name.toLowerCase().includes(hint.toLowerCase()));
  return { deviceId: found?.id ?? null, devices };
}
function parsePosition(input: string): number | null {
  const s = input.trim();
  // H:MM:SS or MM:SS or SS
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return (parts[0]*3600 + parts[1]*60 + parts[2])*1000;
  if (parts.length === 2) return (parts[0]*60 + parts[1])*1000;
  if (parts.length === 1) return parts[0]*1000;
  return null;
}

export function registerPlaybackIntelTools(server: McpServer, client: SpotifyClient): void {
  // 272 play_on — device-name-aware play
  server.tool('play_on',
    'Play a context/uris/search query on a named device (resolves device name → id via GET /me/player/devices, then PUT /me/player/play). 🟡 (1 read + 1 write; +1 if volume/shuffle). Supports device name substring or exact id.',
    {
      device: z.string().min(1).describe('Device name substring (case-insensitive) or exact device id'),
      query: z.string().optional().describe('Search query to play (tracks) — alternatives: context_uri or uris'),
      context_uri: z.string().optional().describe('Spotify context URI (playlist/album/artist URI)'),
      uris: z.array(z.string()).optional().describe('Array of track/episode URIs'),
      position_ms: z.number().int().min(0).optional().describe('Start position in ms'),
      shuffle: z.boolean().optional().describe('Set shuffle before play'),
      volume: z.number().int().min(0).max(100).optional().describe('Set volume (0-100) before play'),
      search_type: z.enum(['track','album','playlist']).optional().describe('When query mode: type to search (default track)'),
      response_format: ResponseFormat, dry_run: DryRun,
    },
    async (args) => {
      const { deviceId, devices } = await resolveDeviceHint(client, args.device as string);
      if (!deviceId) {
        const names = devices.map(d=>d.name).join(', ') || 'no devices';
        return textResult(`No device matches "${args.device}". Available: ${names}`, { ok:false, error:'device_not_found', available: devices.map(d=>({id:d.id,name:d.name})) });
      }
      // validate one source
      const hasQuery = !!args.query; const hasContext = !!args.context_uri; const hasUris = !!(args.uris as string[] | undefined)?.length;
      if ([hasQuery,hasContext,hasUris].filter(Boolean).length > 1) return textResult('Provide only one of query / context_uri / uris.', { ok:false });
      if (!hasQuery && !hasContext && !hasUris) return textResult('Provide one of query, context_uri, or uris.', { ok:false });
      let playBody: Record<string, unknown> = {};
      let label = '';
      if (hasQuery) {
        const q = args.query as string; const st = (args.search_type as string) ?? 'track';
        const res: any = await client.get('/search', { q, type: st, limit: '1' });
        const items = res?.tracks?.items ?? res?.albums?.items ?? res?.playlists?.items ?? [];
        if (!items.length) return textResult(`No results for "${q}" (${st}).`, { ok:false });
        const hit = items[0]; playBody = { context_uri: hit.uri ?? undefined, uris: hit.uri ? undefined : [hit.uri] };
        // track search: play single uri; album/playlist: context
        if (st === 'track') playBody = { uris: [hit.uri] }; else playBody = { context_uri: hit.uri };
        label = hit.uri;
      } else if (hasContext) { playBody = { context_uri: args.context_uri }; label = args.context_uri as string; }
      else { playBody = { uris: args.uris }; label = (args.uris as string[])[0]; }
      if (args.position_ms !== undefined) (playBody as any).position_ms = args.position_ms;
      if (args.dry_run) {
        const steps = [`Resolve "${args.device}" → ${deviceId}`, `Play ${label} on ${deviceId}${args.volume!==undefined?` @ vol ${args.volume}`:''}${args.shuffle!==undefined?` shuffle=${args.shuffle}`:''}`];
        return { content: [{ type:'text', text: describeDryRun('play_on', label, steps) }], structuredContent: { ok:true, dry_run:true, resolved_device_id: deviceId, playBody } };
      }
      if (args.shuffle !== undefined) {
        try { await client.put(`/me/player/shuffle?state=${args.shuffle}&device_id=${encodeURIComponent(deviceId)}`); } catch {}
      }
      if (args.volume !== undefined) {
        try { await client.put(`/me/player/volume?${new URLSearchParams({ volume:String(args.volume), device_id: deviceId })}`); } catch {}
      }
      await client.put(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, playBody);
      return emit(args.response_format as string, { ok:true, resolved_device_id: deviceId, device_name: devices.find(d=>d.id===deviceId)?.name, playBody }, `Playing ${label} on "${devices.find(d=>d.id===deviceId)?.name ?? deviceId}" (${deviceId})${args.volume!==undefined?` @ ${args.volume}%`:''}.`);
    });

  // 273 queue_next — insert-next with honest tail disclosure
  server.tool('queue_next',
    'Queue a track/episode to play next (tail insert with honest disclosure — Spotify has no insert-next API; tail placement is the API reality). Optionally notes temp-playlist workaround. 🟢 (1 write)',
    {
      uri: z.string().min(1).describe('Spotify track or episode URI (spotify:track:… / spotify:episode:…)'),
      device_id: z.string().optional().describe('Target device id'),
      response_format: ResponseFormat, dry_run: DryRun,
    },
    async (args) => {
      const uri = args.uri as string;
      const parsed = parseSpotifyUri(uri);
      if (!parsed || !['track','episode'].includes(parsed.type)) return textResult(`Invalid track/episode URI: ${uri}`, { ok:false });
      if (args.dry_run) return { content: [{ type:'text', text: describeDryRun('queue_next', uri, [`Queue ${uri} at tail (next-play is tail-only — no native insert-next)`, 'Workaround for true next: snapshot queue → temp playlist in desired order → PUT /me/player/play with context (not performed).']) }], structuredContent: { ok:true, dry_run:true, uri, insertion:'tail', workaround:'tail-only API; use temp playlist for true next' } };
      const params = new URLSearchParams({ uri });
      if (args.device_id) params.set('device_id', args.device_id as string);
      await client.post(`/me/player/queue?${params}`);
      const disclosure = 'Note: Spotify queue API is tail-only — item was appended at the tail. For true "play next" semantics, create a temporary playlist with the desired order and start playback from it.';
      return emit(args.response_format as string, { ok:true, uri, insertion:'tail', workaround:'tail-only API; use temp playlist for true next', disclosure }, `Queued ${uri} at tail. ${disclosure}`);
    });

  // 274 describe_queue — enriched queue + context
  server.tool('describe_queue',
    'Enriched queue view: currently playing + up-next with durations, total remaining, and source context label. 🟢 (1 read) or 🟡 (2 if include_context resolves playlist/album name).',
    { max_results: MaxResults, include_context: z.boolean().default(true).describe('Resolve context URI to playlist/album name (extra GET)'), response_format: ResponseFormat },
    async (args) => {
      const cap = resolveMaxResults(args.max_results as number | undefined);
      const q = await client.get<SpotifyQueue>('/me/player/queue');
      if (!q) return textResult('No queue available (nothing playing).', { ok:true, queue: null });
      const currently = q.currently_playing;
      const items = q.queue ?? [];
      const { items: sliced, truncated, remaining, footer } = truncateItems(items, cap);
      const totalRemaining = items.reduce((s, it:any)=> s + (it.duration_ms ?? 0), 0);
      let contextLabel: string | null = null;
      if (args.include_context !== false) {
        try {
          const player: any = await client.get('/me/player');
          const ctx = player?.context?.uri as string | undefined;
          if (ctx) {
            const p = parseSpotifyUri(ctx);
            if (p?.type === 'playlist') { const pl:any = await client.get(`/playlists/${p.id}`, { fields: 'name' }); contextLabel = pl?.name ? `playlist "${pl.name}"` : ctx; }
            else if (p?.type === 'album') { const al:any = await client.get(`/albums/${p.id}`); contextLabel = al?.name ? `album "${al.name}"` : ctx; }
            else contextLabel = ctx;
          }
        } catch {}
      }
      const lines: string[] = [];
      if (currently) lines.push(`Now: ${formatItem(currently)}`);
      else lines.push('Now: —');
      if (contextLabel) lines.push(`Context: ${contextLabel}`);
      lines.push(`Queue: ${items.length} track(s), total remaining ${formatDuration(totalRemaining)}`);
      sliced.forEach((it:any,i:number)=> lines.push(` ${i+1}. ${formatItem(it)} (${formatDuration(it.duration_ms ?? 0)})`));
      if (footer) lines.push(footer);
      lines.push('Workaround note: queue is tail-append only; reorder requires temp playlist.');
      const echo: Record<string, unknown> = { ok:true, currently_playing: currently, queue_length: items.length, total_remaining_ms: totalRemaining, total_remaining_formatted: formatDuration(totalRemaining), context_label: contextLabel, items: sliced, truncated, remaining, insertion:'tail', workaround:'queue is append-only' };
      if (args.response_format === 'json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
    });

  // 275 describe_listening_session — recently-played + detectSessions
  server.tool('describe_listening_session',
    'Playback history timeline from recently-played, optionally grouped into sessions (30-min gap via detectSessions). 🟢 (1 page) / 🟡 (2 pages). Read-only.',
    { limit: z.number().int().min(1).max(50).optional().describe('Max items (default 20)'), as_session: z.boolean().optional().describe('Group into sessions by 30-min gaps (default false)'), response_format: ResponseFormat },
    async (args) => {
      const limit = Math.min(args.limit ?? 20, 50);
      const data: any = await client.get('/me/player/recently-played', { limit: String(limit) });
      const items: Array<{ played_at: string; track: any }> = data?.items ?? [];
      if (items.length === 0) return textResult('No recently-played history.', { ok:true, count:0 });
      if (args.as_session) {
        const sessions = detectSessions(items.map(i=>({ played_at:i.played_at, track:{uri:i.track.uri}})));
        const lines = [`Listening sessions (${sessions.length}) from ${items.length} plays:`];
        sessions.forEach((s,i)=> lines.push(` ${i+1}. ${s.start} → ${s.end} — ${s.tracks.length} track(s)`));
        // map session tracks to names
        const echo:Record<string,unknown>={ ok:true, count: items.length, sessions, items };
        if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
        lines.push(...items.slice(0,5).map(it=> `  - ${it.played_at} ${formatItem(it.track)}`));
        if (items.length>5) lines.push(`  … +${items.length-5} more`);
        return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
      }
      const lines = [`Recently played (${items.length}):`];
      items.forEach(it=> lines.push(` - ${it.played_at} ${formatItem(it.track)}`));
      const echo:Record<string,unknown>={ ok:true, count: items.length, items };
      if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
    });

  // 276 play_at — H:MM:SS parsing -> position_ms
  server.tool('play_at',
    'Start playback at a specific position — accepts H:MM:SS / MM:SS / seconds string or position_ms. Wraps PUT /me/player/play with offset/position_ms. 🟢 (1 write).',
    {
      context_uri: z.string().optional().describe('Context URI (playlist/album URI) — XOR uris'),
      uris: z.array(z.string()).optional().describe('Track/episode URIs'),
      at: z.string().optional().describe('Position as "1:23" or "01:02:03" or "90" seconds'),
      position_ms: z.number().int().min(0).optional().describe('Position in ms (alternative to at)'),
      offset_uri: z.string().optional().describe('Offset URI within context to start at'),
      offset: z.number().int().min(0).optional().describe('Offset index within context'),
      device_id: z.string().optional().describe('Target device id'),
      response_format: ResponseFormat, dry_run: DryRun,
    },
    async (args) => {
      let ms: number | undefined = args.position_ms as number | undefined;
      if (args.at !== undefined) {
        const parsed = parsePosition(args.at as string);
        if (parsed === null) return textResult(`Invalid position "${args.at}" — use "1:23", "01:02:03", or seconds.`, { ok:false });
        ms = parsed;
      }
      if (ms === undefined) return textResult('Provide at (time string) or position_ms.', { ok:false });
      const body: Record<string, unknown> = { position_ms: ms };
      if (args.context_uri) (body as any).context_uri = args.context_uri;
      else if (args.uris?.length) (body as any).uris = args.uris;
      else return textResult('Provide context_uri or uris.', { ok:false });
      if (args.offset_uri) (body as any).offset = { uri: args.offset_uri };
      else if (args.offset !== undefined) (body as any).offset = { position: args.offset };
      const qs = args.device_id ? `?device_id=${encodeURIComponent(args.device_id as string)}` : '';
      if (args.dry_run) return { content:[{type:'text', text: describeDryRun('play_at', (args.context_uri ?? (args.uris as string[])?.[0]) as string, [`Play at ${formatDuration(ms)} (${ms}ms) — body ${JSON.stringify(body)}`])}], structuredContent:{ ok:true, dry_run:true, position_ms: ms, body } };
      await client.put(`/me/player/play${qs}`, body);
      return emit(args.response_format as string, { ok:true, position_ms: ms, position_formatted: formatDuration(ms), body }, `Playing at ${formatDuration(ms)} (${ms}ms).`);
    });

  // 277 device_health
  server.tool('device_health',
    'Device availability & capability report — merges GET /me/player/devices + GET /me/player active id + sidecar labels/presets. 🟢 (1-2 reads, local merge). Read-only.',
    { response_format: ResponseFormat },
    async (args) => {
      const [devRes, player]: any[] = await Promise.all([
        client.get<GetDevicesResponse>('/me/player/devices'),
        client.get('/me/player').catch(()=> null),
      ]);
      const devices: SpotifyDevice[] = devRes?.devices ?? [];
      const activeId = (player as any)?.device?.id ?? null;
      const store = await loadPlaybackExt().catch(()=> ({ devicePresets:{} } as any));
      const presets: Record<string, any> = (store as any).devicePresets ?? {};
      const enriched = devices.map(d=> ({
        id: d.id, name: d.name, type: (d as any).type ?? null, is_active: d.id === activeId,
        is_restricted: (d as any).is_restricted ?? null, is_private_session: (d as any).is_private_session ?? null,
        volume_percent: (d as any).volume_percent ?? null,
        supports_volume: (d as any).supports_volume ?? ((d as any).volume_percent !== null),
        label: presets[d.id as string]?.label ?? null, preset_volume: presets[d.id as string]?.volume ?? null,
      }));
      const lines = [`Devices (${devices.length}), active: ${activeId ?? 'none'}:`];
      enriched.forEach(d=> lines.push(` - ${d.name} (${d.id}) type=${d.type} active=${d.is_active} vol=${d.volume_percent} restricted=${d.is_restricted}${d.label?` label="${d.label}"`:''}`));
      const echo:Record<string,unknown>={ ok:true, active_device_id: activeId, count: devices.length, devices: enriched };
      if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
    });

  // 278 seek_relative
  server.tool('seek_relative',
    'Relative seek — forward/back by delta_ms from current progress (GET /me/player then PUT /me/player/seek, clamped to [0, duration]). 🟢 (1 read + 1 write).',
    { delta_ms: z.number().int().describe('Delta in ms (+ forward, - backward), e.g. 30000 or -15000'), device_id: z.string().optional().describe('Target device id'), response_format: ResponseFormat, dry_run: DryRun },
    async (args) => {
      const state: any = await client.get('/me/player');
      const progress = typeof state?.progress_ms === 'number' ? state.progress_ms : 0;
      const duration = typeof state?.item?.duration_ms === 'number' ? state.item.duration_ms : null;
      let target = progress + (args.delta_ms as number);
      if (duration !== null) target = Math.max(0, Math.min(duration, target));
      else target = Math.max(0, target);
      if (args.dry_run) return { content:[{type:'text', text: describeDryRun('seek_relative', `${args.delta_ms}ms`, [`From ${formatDuration(progress)} ${args.delta_ms>=0?'+':''}${formatDuration(Math.abs(args.delta_ms as number))} → ${formatDuration(target)} (${target}ms)`])}], structuredContent:{ ok:true, dry_run:true, from: progress, delta: args.delta_ms, to: target } };
      const qs = new URLSearchParams({ position_ms: String(target) });
      if (args.device_id) qs.set('device_id', args.device_id as string);
      await client.put(`/me/player/seek?${qs}`);
      return emit(args.response_format as string, { ok:true, from_ms: progress, delta_ms: args.delta_ms, to_ms: target, to_formatted: formatDuration(target) }, `Seeked ${args.delta_ms>=0?'+':''}${formatDuration(Math.abs(args.delta_ms as number))}: ${formatDuration(progress)} → ${formatDuration(target)}.`);
    });

  // 279 playback_timeline
  server.tool('playback_timeline',
    'Progress forecast — elapsed/remaining for current track and optional queue runway, plus ETA wall-clock. 🟢/🟡 (1 read; +1 if include_queue). Read-only.',
    { include_queue: z.boolean().default(true).describe('Include queue total/ETA (extra GET /me/player/queue)'), response_format: ResponseFormat },
    async (args) => {
      const state: any = await client.get('/me/player');
      if (!state?.item) return textResult('Nothing is currently playing — no timeline.', { ok:true, playing:false });
      const progress = state.progress_ms ?? 0; const duration = state.item.duration_ms ?? 0;
      const remainingTrack = Math.max(0, duration - progress);
      let queueTotal = 0; let queueCount = 0;
      if (args.include_queue !== false) {
        try { const q:any = await client.get('/me/player/queue'); queueTotal = (q?.queue ?? []).reduce((s:number,it:any)=> s + (it.duration_ms ?? 0), 0); queueCount = q?.queue?.length ?? 0; } catch {}
      }
      const totalRemaining = remainingTrack + queueTotal;
      const eta = new Date(Date.now() + totalRemaining).toISOString();
      const lines = [
        `Now: ${formatItem(state.item)} — ${formatDuration(progress)}/${formatDuration(duration)} (remaining ${formatDuration(remainingTrack)})`,
        `Queue: ${queueCount} track(s), ${formatDuration(queueTotal)}`,
        `Total remaining: ${formatDuration(totalRemaining)} — ETA ${eta}`,
      ];
      const echo:Record<string,unknown>={ ok:true, playing: !!state.is_playing, elapsed_ms: progress, elapsed_formatted: formatDuration(progress), remaining_track_ms: remainingTrack, remaining_track_formatted: formatDuration(remainingTrack), queue_count: queueCount, queue_remaining_ms: queueTotal, total_remaining_ms: totalRemaining, eta_wallclock: eta };
      if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
    });

  // 280 repeat_queue_toggle
  server.tool('repeat_queue_toggle',
    'One-call queue-repeat helper — sets repeat=context/off and optionally shuffle in 1-2 writes. 🟢.',
    { enable: z.boolean().describe('true → repeat=context, false → repeat=off'), shuffle: z.boolean().optional().describe('Also set shuffle state'), device_id: z.string().optional().describe('Target device id'), response_format: ResponseFormat, dry_run: DryRun },
    async (args) => {
      const state = args.enable ? 'context' : 'off';
      const qs = args.device_id ? `&device_id=${encodeURIComponent(args.device_id as string)}` : '';
      if (args.dry_run) {
        const steps = [`Set repeat → ${state}${qs?` (device ${args.device_id})`:''}`, ...(args.shuffle!==undefined?[`Set shuffle → ${args.shuffle}`]:[])];
        return { content:[{type:'text', text: describeDryRun('repeat_queue_toggle', state, steps)}], structuredContent:{ ok:true, dry_run:true, repeat: state, shuffle: args.shuffle } };
      }
      await client.put(`/me/player/repeat?state=${state}${qs}`);
      if (args.shuffle !== undefined) {
        const shuffleQs = args.device_id ? `?state=${args.shuffle}&device_id=${encodeURIComponent(args.device_id as string)}` : `?state=${args.shuffle}`;
        await client.put(`/me/player/shuffle${shuffleQs}`);
      }
      return emit(args.response_format as string, { ok:true, repeat: state, shuffle: args.shuffle ?? null }, `Repeat ${state}${args.shuffle!==undefined?` + shuffle ${args.shuffle}`:''}.`);
    });

  // 281 now_playing_history
  server.tool('now_playing_history',
    'Merged listening stream — recently-played plus currently-playing item on top (deduped). 🟡 (2 reads). Read-only.',
    { limit: z.number().int().min(1).max(50).optional().describe('Max recently-played items (default 10)'), dedupe: z.boolean().default(true).describe('Deduplicate currently-playing if already most-recent'), response_format: ResponseFormat },
    async (args) => {
      const limit = Math.min(args.limit ?? 10, 50);
      const [recent, now]: any[] = await Promise.all([
        client.get('/me/player/recently-played', { limit: String(limit) }),
        client.get('/me/player/currently-playing').catch(()=> null),
      ]);
      const items: any[] = recent?.items ?? [];
      let merged = [...items];
      const cpItem = now?.item;
      if (cpItem) {
        const alreadyTop = items[0]?.track?.uri === cpItem.uri;
        if (!(args.dedupe !== false && alreadyTop)) {
          merged = [{ played_at: new Date().toISOString(), track: cpItem, _currently_playing: true }, ...items];
        }
      }
      const lines = [`Listening history (merged, ${merged.length} item(s)):`];
      merged.slice(0, limit+1).forEach((it,i)=> lines.push(` ${i+1}. ${it._currently_playing?'▶ ':''}${it.played_at ?? ''} ${formatItem(it.track)}`));
      const echo:Record<string,unknown>={ ok:true, count: merged.length, items: merged.slice(0, limit+1) };
      if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
    });

  // 282 playback_compare_states
  server.tool('playback_compare_states',
    'Diff two saved playback snapshots (sidecar only, no API). Shows item/shuffle/repeat/progress/device/context changes. 🟢 (0 API calls).',
    { state_a: z.string().min(1).describe('First snapshot name'), state_b: z.string().min(1).describe('Second snapshot name'), response_format: ResponseFormat },
    async (args) => {
      const store = await loadPlaybackExt();
      const a = (store as any).states?.[args.state_a as string];
      const b = (store as any).states?.[args.state_b as string];
      if (!a) return textResult(`No snapshot "${args.state_a}". Available: ${Object.keys((store as any).states ?? {}).join(', ')||'none'}`, { ok:false });
      if (!b) return textResult(`No snapshot "${args.state_b}". Available: ${Object.keys((store as any).states ?? {}).join(', ')||'none'}`, { ok:false });
      const pa = a.playback; const pb = b.playback;
      const diff: Record<string, unknown> = {};
      const lines = [`Diff "${args.state_a}" vs "${args.state_b}":`];
      const cmp = (k:string, va:any, vb:any) => { if (JSON.stringify(va)!==JSON.stringify(vb)) { diff[k]={ from: va, to: vb }; lines.push(` - ${k}: ${JSON.stringify(va)} → ${JSON.stringify(vb)}`); } };
      cmp('item', pa?.item?.uri ?? null, pb?.item?.uri ?? null);
      cmp('item_name', pa?.item?.name ?? null, pb?.item?.name ?? null);
      cmp('progress_ms', pa?.progress_ms ?? null, pb?.progress_ms ?? null);
      cmp('shuffle_state', pa?.shuffle_state ?? null, pb?.shuffle_state ?? null);
      cmp('repeat_state', pa?.repeat_state ?? null, pb?.repeat_state ?? null);
      cmp('device', (pa?.device as any)?.id ?? null, (pb?.device as any)?.id ?? null);
      cmp('context_uri', (pa as any)?.context?.uri ?? null, (pb as any)?.context?.uri ?? null);
      if (Object.keys(diff).length===0) lines.push(' (no differences)');
      const echo:Record<string,unknown>={ ok:true, state_a: args.state_a, state_b: args.state_b, diff, has_diff: Object.keys(diff).length>0 };
      if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
    });

  // peek_next (scout #2.2 adjacent) — queue lookahead
  server.tool('peek_next',
    'Queue lookahead — next N tracks with durations and total runway. Right-sized via max_results. 🟢 (1 read). Read-only.',
    { count: z.number().int().min(1).max(50).optional().describe('Alias for max_results: how many to peek (default 5)'), max_results: MaxResults, response_format: ResponseFormat },
    async (args) => {
      const n = (args.count as number | undefined) ?? (args.max_results as number | undefined) ?? 5;
      const cap = resolveMaxResults(n);
      const q:any = await client.get('/me/player/queue');
      const items: any[] = q?.queue ?? [];
      const { items: sliced, truncated, remaining, footer } = truncateItems(items, cap);
      const total = sliced.reduce((s:number,it:any)=> s + (it.duration_ms ?? 0), 0);
      const lines = [`Next ${sliced.length}/${items.length} in queue (total next ${formatDuration(total)}):`];
      sliced.forEach((it:any,i:number)=> lines.push(` ${i+1}. ${formatItem(it)} (${formatDuration(it.duration_ms ?? 0)})`));
      if (footer) lines.push(footer);
      const echo:Record<string,unknown>={ ok:true, count: sliced.length, total_queued: items.length, total_duration_ms: total, items: sliced, truncated, remaining };
      if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
    });

  // get_playback_context (scout-a §2.2) — resolve context.uri to catalog
  server.tool('get_playback_context',
    'Resolve the current playback context URI (from GET /me/player) to catalog metadata — playlist/album/artist/show name, owner, track count. 🟢/🟡 (1-2 reads). Read-only.',
    { response_format: ResponseFormat },
    async (args) => {
      const player:any = await client.get('/me/player');
      const ctx = player?.context?.uri as string | undefined;
      if (!ctx) return textResult('No active context (nothing playing or context is null).', { ok:true, context: null, player_item: player?.item ?? null });
      const parsed = parseSpotifyUri(ctx);
      let resolved: Record<string,unknown> = { uri: ctx, type: parsed?.type ?? 'unknown', id: parsed?.id ?? null };
      try {
        if (parsed?.type === 'playlist') { const pl:any = await client.get(`/playlists/${parsed.id}`, { fields: 'name,owner(display_name,id),tracks(total),public,collaborative,uri' }); resolved = { ...resolved, name: pl?.name, owner: pl?.owner, tracks_total: pl?.tracks?.total, public: pl?.public }; }
        else if (parsed?.type === 'album') { const al:any = await client.get(`/albums/${parsed.id}`); resolved = { ...resolved, name: al?.name, artists: al?.artists?.map((a:any)=>a.name), total_tracks: al?.total_tracks, release_date: al?.release_date }; }
        else if (parsed?.type === 'artist') { const ar:any = await client.get(`/artists/${parsed.id}`); resolved = { ...resolved, name: ar?.name, genres: ar?.genres, followers: ar?.followers?.total }; }
        else if (parsed?.type === 'show') { const sh:any = await client.get(`/shows/${parsed.id}`); resolved = { ...resolved, name: sh?.name, publisher: sh?.publisher, total_episodes: sh?.total_episodes }; }
      } catch (e:any) { (resolved as any).resolve_error = e?.message ?? String(e); }
      const echo:Record<string,unknown>={ ok:true, context_uri: ctx, resolved, player_item: player?.item ? { uri: (player.item as any).uri, name: (player.item as any).name } : null };
      const text = `Context: ${ctx} → ${JSON.stringify(resolved)}`;
      if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text }], structuredContent: echo };
    });

  // volume_step — relative volume nudge
  server.tool('volume_step',
    'Nudge volume up/down by a step (reads current volume via GET /me/player, then PUT /me/player/volume clamped 0-100). 🟡 (1 read + 1 write).',
    { step: z.number().int().min(-100).max(100).describe('Delta, e.g. +10 or -10'), device_id: z.string().optional().describe('Target device id (else active)'), response_format: ResponseFormat, dry_run: DryRun },
    async (args) => {
      const player:any = await client.get('/me/player');
      const cur = typeof player?.device?.volume_percent === 'number' ? player.device.volume_percent : 50;
      const target = Math.max(0, Math.min(100, cur + (args.step as number)));
      if (args.dry_run) return { content:[{type:'text', text: describeDryRun('volume_step', `${args.step>0?'+':''}${args.step}`, [`Volume ${cur} → ${target}`])}], structuredContent:{ ok:true, dry_run:true, from: cur, step: args.step, to: target } };
      const qs = new URLSearchParams({ volume: String(target) });
      if (args.device_id) qs.set('device_id', args.device_id as string);
      else if (player?.device?.id) qs.set('device_id', player.device.id);
      await client.put(`/me/player/volume?${qs}`);
      return emit(args.response_format as string, { ok:true, from: cur, step: args.step, to: target }, `Volume ${cur} → ${target} (step ${args.step>0?'+':''}${args.step}).`);
    });

  // market_availability — per-entity multi-market check
  server.tool('market_availability',
    'Check which markets an item is available in — fetches track/episode/album and reports available_markets. 🟢 (1 read). Read-only.',
    { uri: z.string().min(1).describe('Spotify URI (track/episode/album)'), response_format: ResponseFormat },
    async (args) => {
      const parsed = parseSpotifyUri(args.uri as string);
      if (!parsed) return textResult(`Invalid URI: ${args.uri}`, { ok:false });
      let data:any;
      if (parsed.type==='track') data = await client.get(`/tracks/${parsed.id}`);
      else if (parsed.type==='episode') data = await client.get(`/episodes/${parsed.id}`);
      else if (parsed.type==='album') data = await client.get(`/albums/${parsed.id}`);
      else return textResult(`market_availability supports track/episode/album, not ${parsed.type}`, { ok:false });
      const markets: string[] = data?.available_markets ?? [];
      const lines = [`${args.uri} — ${data?.name ?? ''} — available in ${markets.length} market(s): ${markets.slice(0,20).join(', ')}${markets.length>20?` … +${markets.length-20} more`:''}`];
      const echo:Record<string,unknown>={ ok:true, uri: args.uri, name: data?.name, available_markets: markets, count: markets.length };
      if (args.response_format==='json') return { content:[{type:'text', text: JSON.stringify(echo,null,2)}], structuredContent: echo };
      return { content:[{type:'text', text: lines.join('\n')}], structuredContent: echo };
    });
}
