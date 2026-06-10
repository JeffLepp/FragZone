const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

const SPAWN_POINTS = [
  [-25, 0, -25], [25, 0, -25],
  [-25, 0,  25], [25, 0,  25],
  [-18, 0,   0], [18, 0,   0],
  [  0, 0, -22], [ 0, 0,  22],
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

const players     = new Map(); // ws -> player
const grenades    = new Map(); // id -> grenade
let grenadeSeq    = 0;
let tickCount     = 0;
const pickups     = PICKUP_DEFS.map(d => ({ ...d, active: true, respawnAt: 0 }));

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

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('FragZone OK\n');
});

const wss = new WebSocketServer({ server });

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
      // Client-side bots are invisible to the server, so bot hits and kills are
      // reported here to keep server health/alive state in sync (the health-pack
      // `health >= 100` check and damage math use server health) and to let the
      // server drive the respawn (position included) like any other death.
      case 'botDamage': {
        if (!player.alive) break;
        const dmg = Number(msg.damage);
        if (!Number.isFinite(dmg) || dmg <= 0 || dmg > 100) break;
        // Floor at 1 hp — death is only ever signalled via 'botDeath' so a
        // damage race can't kill the player without a respawn being scheduled.
        player.health = Math.max(1, player.health - Math.round(dmg));
        break;
      }
      case 'botDeath': {
        if (!player.alive) break;
        player.alive  = false;
        player.health = 0;
        player.deaths++;
        // Show the death in everyone else's kill feed. The reporter is skipped:
        // it already showed its own entry immediately, and the bot only exists
        // on that client anyway. Sanitize the name like 'join' does — it ends
        // up in innerHTML on other clients.
        const botName = String(msg.botName || 'BOT').replace(/[<>&"]/g, '').slice(0, 16) || 'BOT';
        broadcast({
          type: 'killed',
          killerId: null, killerName: botName,
          victimId: player.id, victimName: player.name,
          weapon: 'ak',
        }, ws);
        scheduleRespawn(ws, player);
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

  ws.on('error', () => players.delete(ws));
});

// ---------------------------------------------------------------------------
// Game loop – 20 Hz
// ---------------------------------------------------------------------------

let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt  = Math.min((now - lastTick) / 1000, 0.1);
  lastTick  = now;
  tickCount++;

  // Grenade physics
  const exploded = [];
  for (const [id, g] of grenades) {
    g.vel[1] -= GRENADE_GRAV * dt;
    g.pos[0] += g.vel[0] * dt;
    g.pos[1] += g.vel[1] * dt;
    g.pos[2] += g.vel[2] * dt;

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
          const f   = 1 - dist / EXPL_RADIUS;
          const dmg = Math.round(EXPL_MAX_DMG * f * f);
          if (dmg > 0 && ownerWs) applyDamage(ownerWs, p.id, dmg, 'grenade');
          hitPlayers.push(p.id);
        }
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
    broadcast({ type: 'stateUpdate', players: [...players.values()].map(serialize), scores: scores() });
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`FragZone server on :${PORT}`));
