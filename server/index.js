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

const WEAPON_DATA = {
  ak:      { damage: 27 },
  pistol:  { damage: 35 },
  grenade: { damage: 0 },
};

const TICK_RATE      = 20;
const GRENADE_GRAV   = 15;
const GRENADE_FUSE   = 3.0;
const EXPL_RADIUS    = 7;
const EXPL_MAX_DMG   = 98;
const RESPAWN_MS     = 3000;
const MAX_SPEED      = 18; // m/s lag-compensated ceiling

let players       = new Map(); // ws -> player
let grenades      = new Map(); // id -> grenade
let grenadeSeq    = 0;
let tickCount     = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid() {
  return crypto.randomBytes(4).toString('hex');
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
  attacker.kills++;
  victim.deaths++;

  broadcast({
    type: 'killed',
    killerId: attacker.id, killerName: attacker.name,
    victimId, victimName: victim.name,
    weapon,
  });

  setTimeout(() => {
    if (!players.has(victimWs)) return;
    const { idx, pos } = pickSpawn();
    Object.assign(victim, {
      spawnIdx: idx, pos: [...pos],
      health: 100, armor: 100, alive: true,
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
        pos: [...pos], vel: [0, 0, 0],
        yaw: 0, pitch: 0,
        health: 100, armor: 100,
        weapon: 'ak', alive: true,
        kills: 0, deaths: 0,
        spawnIdx: idx, crouching: false,
        lastUpdate: Date.now(),
      };
      players.set(ws, player);
      joined = true;

      send(ws, {
        type: 'init',
        id: player.id,
        spawnPos: [...pos],
        players: [...players.values()].filter(p => p.id !== player.id).map(serialize),
        scores: scores(),
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
        player.vel  = Array.isArray(msg.vel) ? msg.vel.map(Number) : [0,0,0];
        player.yaw  = isFinite(msg.yaw)   ? Number(msg.yaw)   : 0;
        player.pitch= isFinite(msg.pitch) ? Number(msg.pitch) : 0;
        player.crouching = !!msg.crouching;
        if (msg.weapon) player.weapon = msg.weapon;
        player.lastUpdate = Date.now();
        break;
      }
      case 'shoot': {
        if (!player.alive || !WEAPON_DATA[msg.weapon]) break;
        applyDamage(ws, msg.targetId, WEAPON_DATA[msg.weapon].damage, msg.weapon);
        break;
      }
      case 'throwGrenade': {
        if (!player.alive) break;
        const gid = `g${grenadeSeq++}`;
        const gpos = Array.isArray(msg.pos) ? msg.pos.map(Number) : [...player.pos];
        const gvel = Array.isArray(msg.vel) ? msg.vel.map(Number) : [0, 6, -4];
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
