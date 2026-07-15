// FragZone load test — drives N real WebSocket clients against a server and
// reports the numbers the migration needs (connection success, disconnects,
// RTT percentiles, server tick/event-loop stats from /metrics).
//
//   node loadtest.js                                    # 8 clients, 60 s, localhost
//   METRICS_URL=http://127.0.0.1:8081/metrics \
//     node loadtest.js wss://fragzone-server.example.com 8 300
//
// Clients speak the real protocol (join / move @20 Hz / shoot / throwGrenade),
// so this exercises the same code path a browser does. RTT uses native
// WebSocket ping frames, which measures the full path through the proxy
// without adding anything to the game protocol.

const WebSocket = require('ws');

const WS_URL   = process.argv[2] || 'ws://127.0.0.1:8080';
const CLIENTS  = Number(process.argv[3] || 8);
const DURATION = Number(process.argv[4] || 60);   // seconds

const target = new URL(WS_URL);
const isLocalTarget = ['localhost', '127.0.0.1', '::1'].includes(target.hostname);
const METRICS_URL = process.env.METRICS_URL ||
  (isLocalTarget ? 'http://127.0.0.1:8081/metrics' : '');
const NET_HZ    = 20;     // matches client/src/player.js
const MAX_SPEED = 18;     // server anti-teleport ceiling; stay well under it

const stats = {
  attempted: 0, connected: 0, failed: 0,
  disconnects: 0, errors: [], rtt: [], recv: 0, sent: 0,
};

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p / 100))] * 10) / 10;
};

function spawnClient(i) {
  stats.attempted++;
  const ws = new WebSocket(WS_URL);
  const c  = { ws, id: null, pos: [0, 0, 0], yaw: 0, alive: true, peers: [], bots: [], timers: [] };
  // Each bot orbits its spawn on its own circle, so movement is continuous and
  // always under MAX_SPEED — a teleport would be silently dropped by the server.
  const speed = 4 + (i % 4);
  let   theta = i * (Math.PI / 4);
  let   ready = false;

  ws.on('open', () => {
    stats.connected++;
    ws.send(JSON.stringify({ type: 'join', name: `bot${i}` }));
    stats.sent++;
  });

  ws.on('message', raw => {
    stats.recv++;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'init') {
      c.id  = msg.id;
      c.pos = msg.spawnPos.slice();
      ready = true;
    }
    if (msg.type === 'stateUpdate') {
      c.peers = (msg.players || []).filter(p => p.id !== c.id && p.alive);
      c.bots  = (msg.bots    || []).filter(b => b.alive);
      const me = (msg.players || []).find(p => p.id === c.id);
      if (me) c.alive = me.alive;
    }
  });

  ws.on('pong', buf => {
    const sentAt = Number(buf.toString());
    if (sentAt) stats.rtt.push(Date.now() - sentAt);
  });

  ws.on('close', () => { c.timers.forEach(clearInterval); stats.disconnects++; });
  ws.on('error', e => { stats.failed++; stats.errors.push(e.message); });

  // Movement at the same 20 Hz the real client uses.
  c.timers.push(setInterval(() => {
    if (!ready || ws.readyState !== WebSocket.OPEN) return;
    theta += (speed / 12) / NET_HZ;
    const r = 8;
    c.pos = [Math.cos(theta) * r + (i % 2 ? 12 : -12), 0, Math.sin(theta) * r];
    c.yaw = theta;
    ws.send(JSON.stringify({
      type: 'move', pos: c.pos, yaw: c.yaw, pitch: 0,
      crouching: false, weapon: 'ak',
    }));
    stats.sent++;
  }, 1000 / NET_HZ));

  // Shoot at whatever is in range, ~8/s (under the AK's 600 RPM limiter).
  c.timers.push(setInterval(() => {
    if (!ready || !c.alive || ws.readyState !== WebSocket.OPEN) return;
    const bot  = c.bots[0];
    const peer = c.peers[0];
    if (bot)       ws.send(JSON.stringify({ type: 'shootBot', botId: bot.id, weapon: 'ak' }));
    else if (peer) ws.send(JSON.stringify({ type: 'shoot', targetId: peer.id, weapon: 'ak' }));
    else return;
    stats.sent++;
  }, 125));

  // Grenade every ~6 s, staggered per client.
  c.timers.push(setInterval(() => {
    if (!ready || !c.alive || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'throwGrenade',
      pos: [c.pos[0], 1.5, c.pos[2]],
      vel: [Math.cos(c.yaw) * 14, 6, Math.sin(c.yaw) * 14],
    }));
    stats.sent++;
  }, 6000 + i * 250));

  // RTT probe through the proxy.
  c.timers.push(setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping(String(Date.now()));
  }, 1000));

  return c;
}

(async () => {
  console.log(`Load test: ${CLIENTS} clients -> ${WS_URL} for ${DURATION}s\n`);
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    clients.push(spawnClient(i));
    await new Promise(r => setTimeout(r, 150)); // stagger joins
  }

  // One client turns on the server-side bot waves, so the sim has real load.
  setTimeout(() => {
    const c = clients[0];
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'toggleBots' }));
  }, 3000);

  let peakCpu = 0, peakMem = 0;
  const poll = METRICS_URL ? setInterval(async () => {
    try {
      const m = await (await fetch(METRICS_URL)).json();
      peakMem = Math.max(peakMem, m.memoryMb);
      process.stdout.write(
        `\r  t+${String(m.uptimeSec).padStart(3)}s  players=${m.players} bots=${m.bots}  ` +
        `tick p50=${m.tick.p50}ms p95=${m.tick.p95}ms max=${m.tick.max}ms  ` +
        `loop p95=${m.eventLoop.p95}ms  rss=${m.memoryMb}MB   `);
    } catch { /* server may be mid-restart; keep going */ }
  }, 2000) : null;

  await new Promise(r => setTimeout(r, DURATION * 1000));
  if (poll) clearInterval(poll);

  let final = null;
  if (METRICS_URL) {
    try { final = await (await fetch(METRICS_URL)).json(); } catch { /* ignore */ }
  }
  clients.forEach(c => { c.timers.forEach(clearInterval); c.ws.close(); });

  const rate = ((stats.connected / stats.attempted) * 100).toFixed(1);
  console.log('\n\n──── RESULTS ────────────────────────────────');
  console.log(`target                 ${WS_URL}`);
  console.log(`clients                ${stats.connected}/${stats.attempted} connected (${rate}%)`);
  console.log(`unexpected disconnects ${Math.max(0, stats.disconnects)}`);
  console.log(`socket errors          ${stats.failed}${stats.errors.length ? ' — ' + [...new Set(stats.errors)].join('; ') : ''}`);
  console.log(`messages               ${stats.sent} sent / ${stats.recv} received`);
  console.log(`RTT p50 / p95 / max    ${pct(stats.rtt, 50)} / ${pct(stats.rtt, 95)} / ${pct(stats.rtt, 100)} ms  (n=${stats.rtt.length})`);
  if (final) {
    console.log(`tick target            ${final.tickTargetMs} ms`);
    console.log(`tick p50 / p95 / max   ${final.tick.p50} / ${final.tick.p95} / ${final.tick.max} ms  (n=${final.tick.count})`);
    console.log(`event loop p50 / p95   ${final.eventLoop.p50} / ${final.eventLoop.p95} ms  (max ${final.eventLoop.max})`);
    console.log(`memory peak            ${Math.max(peakMem, final.memoryMb)} MB`);
  } else if (!METRICS_URL) {
    console.log('server metrics         skipped (set METRICS_URL from the VM to include them)');
  }
  console.log('─────────────────────────────────────────────');

  const metricsOk = !METRICS_URL || (final && final.tick.p95 < final.tickTargetMs);
  const ok = stats.connected === stats.attempted && stats.failed === 0 && metricsOk;
  console.log(ok ? '\nPASS' : '\nFAIL — see numbers above');
  process.exit(ok ? 0 : 1);
})();
