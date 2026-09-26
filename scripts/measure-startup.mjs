#!/usr/bin/env node
/**
 * Startup-to-`tools/list` latency and peak RSS, per toolset spec (#906).
 *
 * The issue's acceptance criteria are expressed in wall-clock milliseconds and
 * megabytes, so they have to be measured the way a host measures them: spawn
 * the real `dist/index.js` over stdio, wait for `tools/list`, and read the
 * child's own `VmHWM` rather than guessing from the parent.
 *
 * This is a MEASUREMENT harness, not a gate. Absolute numbers move with the
 * machine, so the thresholds CI actually enforces live in
 * `tests/lazy-module-loading.test.ts`.
 *
 * Usage: node scripts/measure-startup.mjs [--runs N] [--toolsets all,playback]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Point at another build to A/B two trees on the same machine: the box this
// runs on is shared, so only an interleaved comparison is trustworthy.
const DIST = process.env.SPOTIFY_MCP_DIST_ROOT ?? join(ROOT, 'dist');
const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const RUNS = Number(argValue('--runs', '5'));
const TOOLSETS = argValue('--toolsets', 'all,playback').split(',').map((s) => s.trim()).filter(Boolean);

/** Peak resident set of a running child, in MB. Linux-only; null elsewhere. */
function peakRssMb(pid) {
  try {
    const match = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) / 1024 : null;
  } catch {
    return null;
  }
}

function measureOnce(toolsets) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'spotify-mcp-startup-'));
    const tokenFile = join(home, 'tokens.json');
    writeFileSync(tokenFile, JSON.stringify({
      access_token: 'startup-measure',
      refresh_token: 'startup-measure',
      expires_at: Date.now() + 60 * 60 * 1000,
    }), { mode: 0o600 });

    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [join(DIST, 'index.js')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        SPOTIFY_CLIENT_ID: 'startup-measure',
        SPOTIFY_MCP_TOKEN_FILE: tokenFile,
        SPOTIFY_MCP_TOOLSETS: toolsets,
        SPOTIFY_MCP_CONFIRM: 'never',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    let buffer = '';
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Read the child's peak RSS BEFORE killing it: /proc/<pid> disappears as
      // soon as it reaps, and a reading taken after the kill is a silent null.
      const rssMb = peakRssMb(child.pid);
      child.kill();
      rmSync(home, { recursive: true, force: true });
      fn(rssMb);
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`toolsets=${toolsets} never reached tools/list\n${stderr}`))),
      30_000,
    );

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && Array.isArray(message.result?.tools)) {
          finish((rssMb) => resolve({
            ms: Number(process.hrtime.bigint() - started) / 1e6,
            rssMb,
            toolCount: message.result.tools.length,
          }));
          return;
        }
      }
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  });
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const results = [];
for (const toolsets of TOOLSETS) {
  const samples = [];
  for (let run = 0; run < RUNS; run++) samples.push(await measureOnce(toolsets));
  const rss = samples.map((s) => s.rssMb).filter((v) => v !== null);
  results.push({
    toolsets,
    runs: RUNS,
    toolCount: samples[0].toolCount,
    medianMs: median(samples.map((s) => s.ms)).toFixed(1),
    minMs: Math.min(...samples.map((s) => s.ms)).toFixed(1),
    medianRssMb: rss.length ? median(rss).toFixed(1) : null,
    maxRssMb: rss.length ? Math.max(...rss).toFixed(1) : null,
  });
}
console.log(JSON.stringify(results, null, 2));
