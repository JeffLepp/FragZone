const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { createHistogram, monitorEventLoopDelay } = require('perf_hooks');

// Behind a reverse proxy (Caddy) in production, systemd pins HOST=127.0.0.1 so
// the app is never reachable from the public internet except through TLS.
// The 0.0.0.0 default keeps `npm run dev` working on a LAN.
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const SPAWN_POINTS = [
  [-25, 0, -25], [25, 0, -25],
  [-25, 0,  25], [25, 0,  25],
  [-18, 0,   0], [18, 0,   0],
  [  0, 0, -22], [ 0, 0,  22],
];

// Wall/crate AABBs — mirrors WALL_DEFS in client/src/map.js (the visual source
// of truth; the client is deployed separately, so the data is hand-synced —
// update both files together). Used for grenade bounces and explosion cover.
const WALL_H = 3.2;
function aabb(cx, cz, w, d, h = WALL_H, cy = h / 2) {
  return {
    minX: cx - w / 2, maxX: cx + w / 2,
    minY: cy - h / 2, maxY: cy + h / 2,
    minZ: cz - d / 2, maxZ: cz + d / 2,
  };
}
const wallBox  = (cx, cz, w, d)         => aabb(cx, cz, w, d);
const crateBox = (cx, cz, w = 2, d = 2) => aabb(cx, cz, w, d, 1.5, 0.75);

// Mid skyscraper — mirrors towerDefs()/RAMPS/SURF_RAMPS in client/src/map.js
// (same hand-sync rule as the rest of this list): hollow 22 m tower, N/S
// doorways, a smooth ramp spiralling up the inner walls (2.5 laps, 21 m rise
// over an 87 m run), a rooftop deck at y 21, and four steep surf ramps from
// gaps in the parapet down to the floor. The client walks/rides the ramps as
// true sloped surfaces; here they are approximated as overlapping thin slabs,
// which is plenty for grenade bounces and explosion cover.
const TOWER_H = 22, TOWER_TOP = 21, RAMP_W = 1.3;
function towerBoxes() {
  const boxes = [];
  const B = (cx, cy, cz, w, h, d) => boxes.push(aabb(cx, cz, w, d, h, cy));

  // Walls (pieces stopping at TOWER_TOP leave the surf gaps in the parapet)
  for (const x of [-5, 5]) {
    B(x, TOWER_TOP / 2,   0,      1, TOWER_TOP, 13);
    B(x, TOWER_TOP + 0.5, -2.125, 1, 1,         8.75);
    B(x, TOWER_TOP + 0.5,  5.875, 1, 1,         1.25);
  }
  B(-2.85, TOWER_H / 2,     -6, 3.3, TOWER_H,   1);
  B( 2.85, TOWER_TOP / 2,   -6, 3.3, TOWER_TOP, 1);
  B( 1.85, TOWER_TOP + 0.5, -6, 1.3, 1,         1);
  B(0, (TOWER_H + 2.4) / 2, -6, 2.4, TOWER_H - 2.4, 1);
  B(-2.85, TOWER_H / 2, 6, 3.3, TOWER_H, 1);
  B( 2.85, TOWER_H / 2, 6, 3.3, TOWER_H, 1);
  B(0, (TOWER_TOP + 2.4) / 2, 6, 2.4, TOWER_TOP - 2.4, 1);

  // Ramp spiral (SW→NW→NE→SE→…, centerline inset RAMP_W/2 from the walls),
  // approximated as a thin slab every 0.5 m of run at the local surface height.
  const RX = 3.85, RZ = 4.85;
  const segs = [
    [-RX,  RZ,  0, -1, 2 * RZ],
    [-RX, -RZ,  1,  0, 2 * RX],
    [ RX, -RZ,  0,  1, 2 * RZ],
    [ RX,  RZ, -1,  0, 2 * RX],
  ];
  const lap   = 2 * (2 * RX + 2 * RZ);
  const total = 2.5 * lap;
  const grade = TOWER_TOP / total, SLAB = 0.5;
  for (let s = SLAB / 2; s < total; s += SLAB) {
    let t = s % lap, seg = 0;
    while (t > segs[seg][4]) { t -= segs[seg][4]; seg++; }
    const [fx, fz, dx] = segs[seg];
    const x = fx + segs[seg][2] * t, z = fz + segs[seg][3] * t;
    const len = SLAB + 0.3;
    B(x, s * grade - 0.175, z,
      dx ? len : RAMP_W, 0.35, dx ? RAMP_W : len);
  }

  // Rooftop deck (open above the final climb, NE landing bridges the arrival)
  B( 0.65, TOWER_TOP - 0.2,    0.75, 7.7, 0.4,  9.5);
  B(-3.85, TOWER_TOP - 0.2,    2.0,  1.3, 0.4,  7.0);
  B( 3.5,  TOWER_TOP - 0.175, -4.75, 2,   0.35, 1.5);

  // Surf ramps — ~46° slabs from the parapet gaps, cut short of the floor
  // (bottom edge hangs at y 4); one thin slab every 0.5 m of run at the local
  // surface height. (x1, z1) is where the slope would meet the floor.
  const SURF_W = 3, SURF_END = 4;
  for (const [x0, z0, x1, z1] of [
    [ 5.5,  3.75,  26,  3.75],   // E
    [-5.5,  3.75, -26,  3.75],   // W
    [ 3.5, -6.5,   3.5, -26 ],   // N
    [ 0,    6.5,   0,    26 ],   // S
  ]) {
    const full = Math.hypot(x1 - x0, z1 - z0);
    const ux   = (x1 - x0) / full, uz = (z1 - z0) / full;
    const len  = full * (TOWER_TOP - SURF_END) / TOWER_TOP;
    for (let s = 0.25; s < len; s += 0.5) {
      B(x0 + ux * s, TOWER_TOP * (1 - s / full) - 0.175, z0 + uz * s,
        ux ? 0.8 : SURF_W, 0.35, ux ? SURF_W : 0.8);
    }
  }
  return boxes;
}

const COLLISION_BOXES = [
  // Outer boundary
  wallBox(0, -30, 62, 1), wallBox(0, 30, 62, 1),
  wallBox(-30, 0, 1, 62), wallBox(30, 0, 1, 62),
  // Corner bunkers (NW, NE, SW, SE)
  wallBox(-24, -22, 1, 8), wallBox(-20, -18, 8, 1),
  wallBox( 24, -22, 1, 8), wallBox( 20, -18, 8, 1),
  wallBox(-24,  22, 1, 8), wallBox(-20,  18, 8, 1),
  wallBox( 24,  22, 1, 8), wallBox( 20,  18, 8, 1),
  // Mid skyscraper
  ...towerBoxes(),
  // Side barriers
  wallBox(-15, 0, 1, 18), wallBox(15, 0, 1, 18),
  // Cover crates
  crateBox( -9, -12), crateBox(  9, -12),
  crateBox( -9,  12), crateBox(  9,  12),
  crateBox(  0, -20), crateBox(  0,  20),
  crateBox(-22, 0, 2, 4), crateBox(22, 0, 2, 4),
  crateBox( -9, 0), crateBox(9, 0),
  crateBox(-14, -16), crateBox(14, -16),
  crateBox(-14,  16), crateBox(14,  16),
];

// Hitscan weapons a client may name in a 'shoot' message. Grenade damage is
// computed server-side in the explosion loop and must not be listed here —
// the damage floor in applyDamage would turn a 0-damage 'shoot' into 1 hp.
const WEAPON_DATA = {
  ak:     { damage: 27, rpm: 600 },
  pistol: { damage: 35, rpm: 350 },
};

const TICK_RATE      = 20;
const GRENADE_GRAV   = 15;
const GRENADE_FUSE   = 3.0;
const EXPL_RADIUS    = 7;
const EXPL_MAX_DMG   = 98;
const RESPAWN_MS     = 3000;
const MAX_SPEED      = 18;  // m/s lag-compensated ceiling
const MAX_SHOT_RANGE = 120; // matches the client raycaster's far limit
const MAX_NADE_SPEED = 25;  // client throws at ~17 m/s
const MAX_NADE_DIST  = 3;   // throw must originate near the thrower (eye height ~1.6)
const MAX_GRENADES   = 2;

const PICKUP_RADIUS     = 1.3;
const HEALTH_PACK_HP    = 50;
const PICKUP_RESPAWN_MS = { health: 15000, ammo: 10000 };

const PICKUP_DEFS = [
  { id: 'hp1', kind: 'health', pos: [  0, 0.5, -13] },
  { id: 'hp2', kind: 'health', pos: [  0, 0.5,  13] },
  { id: 'hp3', kind: 'health', pos: [-26, 0.5,   0] },
  { id: 'hp4', kind: 'health', pos: [ 26, 0.5,   0] },
  { id: 'am1', kind: 'ammo',   pos: [ -9, 0.5,  -6] },
  { id: 'am2', kind: 'ammo',   pos: [  9, 0.5,  -6] },
  { id: 'am3', kind: 'ammo',   pos: [ -9, 0.5,   6] },
  { id: 'am4', kind: 'ammo',   pos: [  9, 0.5,   6] },
];

// Bots are now server-authoritative and shared by every player (mirrors the
// old client-only logic in client/src/bot.js, ported here). Bot mode is a
// single game-wide toggle — any player pressing B flips it for the whole match.
const BOT_HP_MAX      = 100;
const BOT_DAMAGE      = 10;
const BOT_R           = 0.38;
const BOT_H           = 1.82;
const BOT_CHASE_SPEED = 3.2;
const BOT_STOP_DIST   = 5.5;
const BOT_SHOOT_RANGE = 24;
const BOT_SHOOT_INT   = 1.0;  // seconds between shot attempts
const BOT_ACCURACY    = 0.48; // probability of dealing damage per attempt with LOS
const BOT_WAVE_BREAK  = 2.5;  // seconds between clearing a wave and the next spawn
// Matches client/src/map.js MAP_BOUNDS — keeps bots inside the arena.
const BOT_BOUNDS      = { minX: -29.4, maxX: 29.4, minZ: -29.4, maxZ: 29.4 };

const players     = new Map(); // ws -> player
const grenades    = new Map(); // id -> grenade
let grenadeSeq    = 0;
let tickCount     = 0;
const pickups     = PICKUP_DEFS.map(d => ({ ...d, active: true, respawnAt: 0 }));

const bots        = new Map(); // id -> bot
let botMode       = false;
let botWaveSize   = 0;
let botWaveTimer  = 0; // countdown between clearing a wave and the next spawn
let botSeq        = 0;
let botNameSeq    = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid() {
  return crypto.randomBytes(4).toString('hex');
}

// Returns [x, y, z] of finite numbers, or null if the client sent garbage.
function vec3(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out = [Number(v[0]), Number(v[1]), Number(v[2])];
  return out.every(Number.isFinite) ? out : null;
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const NADE_R = 0.12; // matches the client's grenade mesh radius

function grenadeBlocked(x, y, z) {
  for (const b of COLLISION_BOXES) {
    if (x + NADE_R > b.minX && x - NADE_R < b.maxX &&
        y + NADE_R > b.minY && y - NADE_R < b.maxY &&
        z + NADE_R > b.minZ && z - NADE_R < b.maxZ) return true;
  }
  return false;
}

// True if the straight segment a→b passes through any wall or crate.
// Slab-method segment/AABB intersection.
function losBlocked(a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  for (const box of COLLISION_BOXES) {
    const mins = [box.minX, box.minY, box.minZ];
    const maxs = [box.maxX, box.maxY, box.maxZ];
    let tmin = 0, tmax = 1, hit = true;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (a[i] < mins[i] || a[i] > maxs[i]) { hit = false; break; }
      } else {
        let t1 = (mins[i] - a[i]) / d[i];
        let t2 = (maxs[i] - a[i]) / d[i];
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) { hit = false; break; }
      }
    }
    if (hit) return true;
  }
  return false;
}

function pickSpawn() {
  const used = new Set([...players.values()].map(p => p.spawnIdx));
  const free = SPAWN_POINTS.map((_, i) => i).filter(i => !used.has(i));
  const idx  = free.length ? free[Math.floor(Math.random() * free.length)]
                           : Math.floor(Math.random() * SPAWN_POINTS.length);
  return { idx, pos: SPAWN_POINTS[idx] };
}

function broadcast(msg, skipWs = null) {
  const str = JSON.stringify(msg);
  for (const ws of players.keys()) {
    if (ws !== skipWs && ws.readyState === 1) ws.send(str);
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function wsOfId(id) {
  for (const [ws, p] of players) if (p.id === id) return ws;
  return null;
}

function serialize(p) {
  return {
    id: p.id, name: p.name,
    pos: p.pos, yaw: p.yaw, pitch: p.pitch,
    health: p.health, armor: p.armor,
    weapon: p.weapon, alive: p.alive,
    kills: p.kills, deaths: p.deaths,
    crouching: !!p.crouching,
  };
}

function serializeBot(b) {
  return { id: b.id, name: b.name, pos: b.pos, hp: b.hp, alive: b.alive };
}

function scores() {
  const s = {};
  for (const p of players.values()) {
    s[p.id] = { kills: p.kills, deaths: p.deaths, name: p.name };
  }
  return s;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

function applyDamage(attackerWs, victimId, damage, weapon) {
  const attacker = players.get(attackerWs);
  if (!attacker) return;

  const victimWs = wsOfId(victimId);
  if (!victimWs) return;
  const victim = players.get(victimWs);
  if (!victim || !victim.alive) return;

  // Simple armor absorption: CS-style (armor absorbs ~50 % of bullets)
  let actual = damage;
  if (victim.armor > 0) {
    const absorbed = Math.min(victim.armor, damage * 0.5);
    victim.armor   = Math.max(0, victim.armor - absorbed * 2);
    actual         = damage - absorbed;
  }
  actual = Math.max(1, Math.round(actual));
  victim.health -= actual;

  const killed = victim.health <= 0;
  if (killed) victim.health = 0;

  const hitMsg = { type: 'hit', victimId, killerId: attacker.id, damage: actual, killed };
  send(attackerWs, hitMsg);
  send(victimWs,   hitMsg);

  if (!killed) return;

  victim.alive = false;
  if (attacker !== victim) attacker.kills++; // no kill credit for suicides
  victim.deaths++;

  broadcast({
    type: 'killed',
    killerId: attacker.id, killerName: attacker.name,
    victimId, victimName: victim.name,
    weapon,
  });

  scheduleRespawn(victimWs, victim);
}

function scheduleRespawn(victimWs, victim) {
  setTimeout(() => {
    if (!players.has(victimWs)) return;
    const { idx, pos } = pickSpawn();
    Object.assign(victim, {
      spawnIdx: idx, pos: [...pos],
      health: 100, armor: 100, alive: true,
      grenades: 1, // client resets its loadout to one grenade on respawn
    });
    send(victimWs, { type: 'respawn', pos: [...pos] });
  }, RESPAWN_MS);
}

// Damage dealt to a player by a bot. Like applyDamage, but the killer is a bot
// (no player attacker): no kill credit, and the death is reported with a null
// killerId so the client kill feed reads "BOTx killed <player>".
function applyBotDamage(victim, damage, botName) {
  if (!victim.alive) return;
  const victimWs = wsOfId(victim.id);
  if (!victimWs) return;

  let actual = damage;
  if (victim.armor > 0) {
    const absorbed = Math.min(victim.armor, damage * 0.5);
    victim.armor   = Math.max(0, victim.armor - absorbed * 2);
    actual         = damage - absorbed;
  }
  actual = Math.max(1, Math.round(actual));
  victim.health -= actual;

  const killed = victim.health <= 0;
  if (killed) victim.health = 0;

  send(victimWs, { type: 'hit', victimId: victim.id, killerId: null, damage: actual, killed });
  if (!killed) return;

  victim.alive = false;
  victim.deaths++;
  broadcast({
    type: 'killed',
    killerId: null, killerName: botName,
    victimId: victim.id, victimName: victim.name,
    weapon: 'ak',
  });
  scheduleRespawn(victimWs, victim);
}

// ---------------------------------------------------------------------------
// Bots (server-authoritative, shared by all players)
// ---------------------------------------------------------------------------

// True if a bot standing at (x, z) would overlap map geometry — mirrors
// botBlockedAt in client/src/bot.js.
function botBlockedAt(x, z) {
  for (const b of COLLISION_BOXES) {
    if (x + BOT_R > b.minX && x - BOT_R < b.maxX &&
        BOT_H     > b.minY && 0         < b.maxY &&
        z + BOT_R > b.minZ && z - BOT_R < b.maxZ) return true;
  }
  return false;
}

function spawnBotWave(count) {
  const alive = [...players.values()].filter(p => p.alive);
  // Distance of a spawn point to the nearest player; spawn waves farthest out
  // so bots have to close in (matches the old client spawner's intent).
  const nearestPlayer = sp => alive.length
    ? Math.min(...alive.map(p => Math.hypot(sp[0] - p.pos[0], sp[2] - p.pos[2])))
    : 0;
  const byDist = [...SPAWN_POINTS].sort((a, b) => nearestPlayer(b) - nearestPlayer(a));

  for (let i = 0; i < count; i++) {
    const sp = byDist[i % byDist.length];
    // Jitter (widening as points are reused) so stacked bots don't overlap,
    // retrying when a jittered point lands inside geometry; the bare spawn
    // point is always clear.
    const spread = 2 + Math.floor(i / byDist.length);
    let x = sp[0], z = sp[2];
    for (let tries = 0; tries < 10; tries++) {
      const jx = sp[0] + (Math.random() - 0.5) * spread;
      const jz = sp[2] + (Math.random() - 0.5) * spread;
      if (!botBlockedAt(jx, jz)) { x = jx; z = jz; break; }
    }
    const id = `bot${botSeq++}`;
    bots.set(id, {
      id, name: `BOT${++botNameSeq}`,
      pos: [x, 0, z], hp: BOT_HP_MAX, alive: true,
      shootCd: 0.4 + Math.random() * 0.6,
    });
  }
}

function setBotMode(on) {
  botMode      = on;
  botWaveTimer = 0;
  if (on) {
    botWaveSize = 1;
    spawnBotWave(botWaveSize);
    broadcast({ type: 'botWave', size: botWaveSize, first: true });
  } else {
    bots.clear();
    botWaveSize = 0;
    broadcast({ type: 'botMode', on: false });
  }
}

function botSlide(bot, dx, dz) {
  const testX = bot.pos[0] + dx;
  if (!botBlockedAt(testX, bot.pos[2])) bot.pos[0] = testX;
  const testZ = bot.pos[2] + dz;
  if (!botBlockedAt(bot.pos[0], testZ)) bot.pos[2] = testZ;
  bot.pos[0] = Math.max(BOT_BOUNDS.minX + BOT_R, Math.min(BOT_BOUNDS.maxX - BOT_R, bot.pos[0]));
  bot.pos[2] = Math.max(BOT_BOUNDS.minZ + BOT_R, Math.min(BOT_BOUNDS.maxZ - BOT_R, bot.pos[2]));
}

function botTryShoot(bot, target) {
  // Eye-to-eye range/LOS like the old client AI: undercounting with the
  // horizontal distance let bots shoot through walls when a target was up the
  // tower. Crouching lowers the target's eye height (mirrors player.js).
  const eye   = [bot.pos[0], 1.4, bot.pos[2]];
  const tEye  = [target.pos[0], target.pos[1] + (target.crouching ? 0.92 : 1.62), target.pos[2]];
  const dist  = dist3(eye, tEye);
  if (dist >= BOT_SHOOT_RANGE) return;
  if (losBlocked(eye, tEye)) return;
  if (Math.random() < BOT_ACCURACY) applyBotDamage(target, BOT_DAMAGE, bot.name);
}

// Award a bot kill to a player (hitscan or grenade) and broadcast it.
function killBot(bot, killer, weapon) {
  bot.hp    = 0;
  bot.alive = false;
  bots.delete(bot.id);
  if (killer) killer.kills++;
  broadcast({
    type: 'botKilled',
    botId: bot.id, botName: bot.name,
    killerId:   killer ? killer.id   : null,
    killerName: killer ? killer.name : 'BOT',
    weapon,
  });
}

function updateBots(dt) {
  if (botMode) {
    const alive = [...players.values()].filter(p => p.alive);
    for (const bot of bots.values()) {
      if (!bot.alive) continue;
      // Chase the nearest living player and shoot when in range.
      let target = null, best = Infinity;
      for (const p of alive) {
        const d = Math.hypot(p.pos[0] - bot.pos[0], p.pos[2] - bot.pos[2]);
        if (d < best) { best = d; target = p; }
      }
      if (target) {
        const dx = target.pos[0] - bot.pos[0];
        const dz = target.pos[2] - bot.pos[2];
        if (best > BOT_STOP_DIST && best > 1e-4) {
          botSlide(bot, dx / best * BOT_CHASE_SPEED * dt, dz / best * BOT_CHASE_SPEED * dt);
        }
        bot.shootCd -= dt;
        if (bot.shootCd <= 0) {
          bot.shootCd = BOT_SHOOT_INT * (0.8 + Math.random() * 0.4);
          botTryShoot(bot, target);
        }
      }
    }
  }

  // Wave progression: once a wave is cleared, grow it (doubling up to 16, then
  // +log2 so the count doesn't explode) and respawn after a short breather.
  if (botMode && bots.size === 0) {
    if (botWaveTimer <= 0) {
      botWaveSize = botWaveSize < 16
        ? botWaveSize * 2
        : botWaveSize + Math.round(Math.log2(botWaveSize));
      botWaveTimer = BOT_WAVE_BREAK;
      broadcast({ type: 'botWave', size: botWaveSize, first: false });
    } else {
      botWaveTimer -= dt;
      if (botWaveTimer <= 0) spawnBotWave(botWaveSize);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

// Tick + event-loop instrumentation. Both histograms are stdlib (perf_hooks),
// so percentiles come free — no metrics dependency.
const tickHist = createHistogram();
const loopLag  = monitorEventLoopDelay({ resolution: 10 });
loopLag.enable();

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"ok"}');
  }

  // Read-only counters for the load test; no secrets, nothing mutable.
  if (path === '/metrics') {
    const ms = ns => Math.round(ns / 1e5) / 10;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      uptimeSec: Math.round(process.uptime()),
      players: players.size,
      bots: bots.size,
      tickTargetMs: 1000 / TICK_RATE,
      tick: {
        count: Number(tickHist.count),
        p50: ms(tickHist.percentile(50)),
        p95: ms(tickHist.percentile(95)),
        max: ms(tickHist.max),
      },
      eventLoop: {
        p50: ms(loopLag.percentile(50)),
        p95: ms(loopLag.percentile(95)),
        max: ms(loopLag.max),
      },
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    }));
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('FragZone OK\n');
});

// perMessageDeflate stays off (the `ws` server default): gameplay messages are
// small and frequent, so per-message compression would cost CPU and latency for
// almost no bandwidth win. Set explicitly so a future upgrade can't flip it.
const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on('connection', ws => {
  let joined = false;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- join ----
    if (!joined) {
      if (msg.type !== 'join') return;
      const name = String(msg.name || 'Anon').replace(/[<>&"]/g, '').slice(0, 16) || 'Anon';
      const { idx, pos } = pickSpawn();
      const player = {
        id: uid(), name,
        pos: [...pos],
        yaw: 0, pitch: 0,
        health: 100, armor: 100,
        weapon: 'ak', alive: true,
        kills: 0, deaths: 0,
        spawnIdx: idx, crouching: false,
        lastUpdate: Date.now(),
        lastShot: 0, grenades: 1,
      };
      players.set(ws, player);
      joined = true;

      send(ws, {
        type: 'init',
        id: player.id,
        spawnPos: [...pos],
        players: [...players.values()].filter(p => p.id !== player.id).map(serialize),
        scores: scores(),
        pickups: pickups.map(p => ({ id: p.id, kind: p.kind, pos: p.pos, active: p.active })),
        bots: [...bots.values()].map(serializeBot),
      });
      broadcast({ type: 'playerJoined', ...serialize(player) }, ws);
      return;
    }

    const player = players.get(ws);
    if (!player) return;

    switch (msg.type) {
      case 'move': {
        if (!Array.isArray(msg.pos) || msg.pos.length < 3) break;
        const [x, y, z] = msg.pos.map(Number);
        if ([x, y, z].some(v => isNaN(v) || !isFinite(v))) break;
        const dt = Math.max(0.001, (Date.now() - player.lastUpdate) / 1000);
        const dx = x - player.pos[0], dz = z - player.pos[2];
        if (Math.sqrt(dx*dx + dz*dz) / dt > MAX_SPEED) break; // anti-teleport
        player.pos  = [x, Math.max(0, y), z];
        player.yaw  = isFinite(msg.yaw)   ? Number(msg.yaw)   : 0;
        player.pitch= isFinite(msg.pitch) ? Number(msg.pitch) : 0;
        player.crouching = !!msg.crouching;
        if (msg.weapon) player.weapon = msg.weapon;
        player.lastUpdate = Date.now();
        break;
      }
      case 'shoot': {
        const wd = WEAPON_DATA[msg.weapon];
        if (!player.alive || !wd) break;
        // Rate limit from the weapon's RPM (30 % slack for network jitter) so
        // a modified client can't deal more DPS than the real fire rate allows.
        const now = Date.now();
        if (now - player.lastShot < (60000 / wd.rpm) * 0.7) break;
        // Range check with server positions: the client ray only reaches
        // MAX_SHOT_RANGE, so anything farther is a fabricated hit.
        const victim = [...players.values()].find(p => p.id === msg.targetId);
        if (!victim || dist3(player.pos, victim.pos) > MAX_SHOT_RANGE) break;
        player.lastShot = now;
        applyDamage(ws, msg.targetId, wd.damage, msg.weapon);
        break;
      }
      // Hitscan against a bot. Validated like 'shoot' (rate limit + range using
      // server positions); the client only raycasts to pick which bot it hit.
      case 'shootBot': {
        const wd = WEAPON_DATA[msg.weapon];
        if (!player.alive || !wd) break;
        const now = Date.now();
        if (now - player.lastShot < (60000 / wd.rpm) * 0.7) break;
        const bot = bots.get(msg.botId);
        if (!bot || !bot.alive) break;
        if (dist3(player.pos, bot.pos) > MAX_SHOT_RANGE) break;
        player.lastShot = now;
        bot.hp -= Math.max(1, Math.round(wd.damage));
        if (bot.hp <= 0) killBot(bot, player, msg.weapon);
        break;
      }
      // Any player can flip the game-wide bot mode (the B key).
      case 'toggleBots': {
        setBotMode(!botMode);
        break;
      }
      case 'throwGrenade': {
        // Inventory is tracked server-side: 1 per spawn, +1 per ammo pickup.
        if (!player.alive || player.grenades <= 0) break;
        const gpos = vec3(msg.pos);
        const gvel = vec3(msg.vel);
        // Reject non-finite vectors (NaN would poison the physics loop and get
        // broadcast), throws not originating at the player, and superhuman arm
        // strength — the real client throws at ~17 m/s from eye height.
        if (!gpos || !gvel) break;
        if (dist3(gpos, player.pos) > MAX_NADE_DIST) break;
        if (Math.hypot(...gvel) > MAX_NADE_SPEED) break;
        player.grenades--;
        const gid = `g${grenadeSeq++}`;
        grenades.set(gid, { id: gid, ownerId: player.id, pos: gpos, vel: gvel, fuse: GRENADE_FUSE });
        broadcast({ type: 'grenadeSpawned', id: gid, pos: gpos });
        break;
      }
    }
  });

  ws.on('close', () => {
    const player = players.get(ws);
    if (player) broadcast({ type: 'playerLeft', id: player.id, name: player.name });
    players.delete(ws);
  });

  // 'close' always follows 'error', so removal (and the playerLeft broadcast)
  // happens there — deleting here too would skip the broadcast and leave a
  // frozen ghost avatar on every client. Listener kept so ws doesn't throw.
  ws.on('error', () => {});
});

// ---------------------------------------------------------------------------
// Game loop – 20 Hz
// ---------------------------------------------------------------------------

let lastTick = Date.now();

// setInterval is deliberate: Node reschedules the timer only after the callback
// returns, so a slow tick delays the next one instead of queueing a backlog of
// them. dt is clamped below, so a stall can never be "caught up" by a giant
// simulation step either. Duration is recorded for /metrics.
const tick = () => {
  const t0  = process.hrtime.bigint();
  const now = Date.now();
  const dt  = Math.min((now - lastTick) / 1000, 0.1);
  lastTick  = now;
  tickCount++;

  // Bot AI + wave progression
  updateBots(dt);

  // Grenade physics
  const exploded = [];
  for (const [id, g] of grenades) {
    g.vel[1] -= GRENADE_GRAV * dt;

    // Move axis-by-axis so a wall hit on one axis still lets the grenade
    // slide/bounce along the others (same scheme the client uses for players).
    // A throw released while hugging a wall can spawn already overlapping a
    // box — let it fly freely until it's clear, or it would jitter in place.
    const embedded = grenadeBlocked(g.pos[0], g.pos[1], g.pos[2]);

    const nx = g.pos[0] + g.vel[0] * dt;
    if (!embedded && grenadeBlocked(nx, g.pos[1], g.pos[2])) g.vel[0] *= -0.45;
    else g.pos[0] = nx;

    const nz = g.pos[2] + g.vel[2] * dt;
    if (!embedded && grenadeBlocked(g.pos[0], g.pos[1], nz)) g.vel[2] *= -0.45;
    else g.pos[2] = nz;

    const ny = g.pos[1] + g.vel[1] * dt;
    if (!embedded && grenadeBlocked(g.pos[0], ny, g.pos[2])) {
      // Crate top (falling) bounces like the floor; underside just reflects.
      if (g.vel[1] < 0) {
        if (Math.abs(g.vel[1]) > 1.5) {
          g.vel[1] = Math.abs(g.vel[1]) * 0.38;
          g.vel[0] *= 0.72; g.vel[2] *= 0.72;
        } else {
          g.vel[1] = 0; g.vel[0] *= 0.9; g.vel[2] *= 0.9;
        }
      } else {
        g.vel[1] *= -0.38;
      }
    } else {
      g.pos[1] = ny;
    }

    if (g.pos[1] < 0.1 && g.vel[1] < 0) {
      g.pos[1] = 0.1;
      if (Math.abs(g.vel[1]) > 1.5) {
        g.vel[1] = Math.abs(g.vel[1]) * 0.38;
        g.vel[0] *= 0.72; g.vel[2] *= 0.72;
      } else {
        g.vel[1] = 0; g.vel[0] *= 0.9; g.vel[2] *= 0.9;
      }
    }

    g.fuse -= dt;
    if (g.fuse <= 0) {
      exploded.push(id);
      const ownerWs = wsOfId(g.ownerId);
      const hitPlayers = [];
      for (const [pws, p] of players) {
        if (!p.alive) continue;
        const dx = p.pos[0] - g.pos[0];
        const dy = (p.pos[1] + 0.9) - g.pos[1];
        const dz = p.pos[2] - g.pos[2];
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist < EXPL_RADIUS) {
          // Cover blocks the blast: no damage if a wall/crate sits between the
          // grenade and the player's chest.
          if (losBlocked(g.pos, [p.pos[0], p.pos[1] + 0.9, p.pos[2]])) continue;
          const f   = 1 - dist / EXPL_RADIUS;
          const dmg = Math.round(EXPL_MAX_DMG * f * f);
          if (dmg > 0 && ownerWs) applyDamage(ownerWs, p.id, dmg, 'grenade');
          hitPlayers.push(p.id);
        }
      }
      // Same blast against bots (chest at y 0.9, same falloff + cover check).
      // Deleting the current entry mid-iteration is safe for a Map.
      const owner = ownerWs ? players.get(ownerWs) : null;
      for (const bot of bots.values()) {
        if (!bot.alive) continue;
        const dx = bot.pos[0] - g.pos[0];
        const dy = 0.9 - g.pos[1];
        const dz = bot.pos[2] - g.pos[2];
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist >= EXPL_RADIUS) continue;
        if (losBlocked(g.pos, [bot.pos[0], 0.9, bot.pos[2]])) continue;
        const f   = 1 - dist / EXPL_RADIUS;
        const dmg = Math.round(EXPL_MAX_DMG * f * f);
        if (dmg <= 0) continue;
        bot.hp -= dmg;
        if (bot.hp <= 0) killBot(bot, owner, 'grenade');
      }
      broadcast({ type: 'explosion', id: g.id, pos: [...g.pos], hitPlayers });
    }
  }
  exploded.forEach(id => grenades.delete(id));

  // Pickups: respawn timers + touch detection
  for (const pk of pickups) {
    if (!pk.active) {
      if (now >= pk.respawnAt) {
        pk.active = true;
        broadcast({ type: 'pickupRespawned', id: pk.id });
      }
      continue;
    }
    for (const [pws, p] of players) {
      if (!p.alive) continue;
      if (pk.kind === 'health' && p.health >= 100) continue;
      const dx = p.pos[0] - pk.pos[0];
      const dz = p.pos[2] - pk.pos[2];
      if (dx*dx + dz*dz > PICKUP_RADIUS * PICKUP_RADIUS) continue;
      if (Math.abs(p.pos[1] - pk.pos[1]) > 2) continue;

      if (pk.kind === 'health') {
        p.health = Math.min(100, p.health + HEALTH_PACK_HP);
      } else {
        // Mirrors client addAmmo() so the server-side grenade inventory
        // (checked in 'throwGrenade') stays in sync.
        p.grenades = Math.min(MAX_GRENADES, p.grenades + 1);
      }
      pk.active    = false;
      pk.respawnAt = now + PICKUP_RESPAWN_MS[pk.kind];
      broadcast({ type: 'pickupTaken', id: pk.id, playerId: p.id });
      send(pws, { type: 'pickup', id: pk.id, kind: pk.kind, health: p.health });
      break;
    }
  }

  if (grenades.size > 0) {
    broadcast({
      type: 'grenadeUpdate',
      grenades: [...grenades.values()].map(g => ({ id: g.id, pos: [...g.pos] })),
    });
  }

  if (tickCount % 2 === 0) {
    broadcast({
      type: 'stateUpdate',
      players: [...players.values()].map(serialize),
      bots: [...bots.values()].map(serializeBot),
      scores: scores(),
    });
  }

  // Histogram rejects 0, so floor at 1 ns.
  tickHist.record(Number(process.hrtime.bigint() - t0) || 1);
};

const tickTimer = setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, HOST, () => console.log(`FragZone server on ${HOST}:${PORT}`));

// ---------------------------------------------------------------------------
// Graceful shutdown (systemd sends SIGTERM on stop/restart)
// ---------------------------------------------------------------------------

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);

  clearInterval(tickTimer);          // stop the simulation
  server.close();                    // stop accepting new connections
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  wss.close(() => process.exit(0));

  // A client that ignores the close frame shouldn't hold the process open.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
