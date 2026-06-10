import * as THREE from 'three';
import { createMap, SPAWN_POINTS } from './map.js';
import { Bot } from './bot.js';
import { LocalPlayer } from './player.js';
import { RemotePlayer } from './remote.js';
import { Network } from './network.js';
import { HUD } from './hud.js';
import { AudioSystem } from './audio.js';
import { PickupManager } from './pickups.js';

// ── Renderer ──────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.autoClear         = false; // we manage clear for viewmodel pass
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Scene & Camera ────────────────────────────────────────────────────────────
const scene  = new THREE.Scene();
// Use setClearColor instead of scene.background — scene.background forces a
// full framebuffer clear on every renderer.render() call regardless of
// autoClear, which erases the world pass when the viewmodel pass runs.
renderer.setClearColor(0x8CB8D4, 1);
scene.fog = new THREE.FogExp2(0x8CB8D4, 0.020);

const camera = new THREE.PerspectiveCamera(95, window.innerWidth / window.innerHeight, 0.05, 100);
// Camera added to scene so viewmodel children receive lighting
scene.add(camera);

// ── Lighting ──────────────────────────────────────────────────────────────────
const ambient = new THREE.AmbientLight(0xffeedd, 0.65);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff5e0, 1.1);
sun.position.set(15, 25, 10);
sun.castShadow = true;
sun.shadow.camera.near   = 0.5;
sun.shadow.camera.far    = 100;
sun.shadow.camera.left   = -45;
sun.shadow.camera.right  = 45;
sun.shadow.camera.top    = 45;
sun.shadow.camera.bottom = -45;
sun.shadow.mapSize.width  = 2048;
sun.shadow.mapSize.height = 2048;
scene.add(sun);

// Subtle fill from below
const fill = new THREE.DirectionalLight(0xaaccff, 0.25);
fill.position.set(-10, -5, -10);
scene.add(fill);

// ── Map ───────────────────────────────────────────────────────────────────────
const wallMeshes = createMap(scene);

// ── Systems ───────────────────────────────────────────────────────────────────
const hud     = new HUD();
const audio   = new AudioSystem();
const network = new Network();
const pickups = new PickupManager(scene);

const remotePlayers = new Map(); // id -> RemotePlayer
const bots = [];                  // client-side bots
let playerName = '';
let botRespawnTimer = 0;

const localPlayer = new LocalPlayer({ camera, scene, wallMeshes, remotePlayers, network, hud, audio, bots });

// ── Pointer lock ──────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('click', () => {
  if (!document.pointerLockElement) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  const locked = !!document.pointerLockElement;
  hud.showLockHint(!locked && gameStarted);
  document.body.classList.toggle('locked', locked);
});

// ── Explosion visual ──────────────────────────────────────────────────────────
const explosionEffects = [];

function spawnExplosion(pos) {
  const geo  = new THREE.SphereGeometry(0.6, 10, 8);
  const mat  = new THREE.MeshBasicMaterial({ color: 0xFF5500, transparent: true, opacity: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(...pos);
  scene.add(mesh);
  let life = 0;
  const update = dt => {
    life += dt;
    const t = life / 0.5;
    mesh.scale.setScalar(1 + t * 5);
    mat.opacity = Math.max(0, 1 - t);
    if (t >= 1) {
      scene.remove(mesh);
      geo.dispose(); mat.dispose();
      return true; // done
    }
    return false;
  };
  explosionEffects.push(update);
}

// ── Network events ────────────────────────────────────────────────────────────
let gameStarted = false;
let pendingJoinName = '';

network.onStatus((status, { url }) => {
  if (status === 'connecting') {
    hud.setMenuStatus(`Connecting to ${url}`, true);
    return;
  }

  if (status === 'open') {
    if (pendingJoinName && !network.id) {
      network.send({ type: 'join', name: pendingJoinName });
    }
    hud.setMenuStatus('Waiting for server...', true);
    return;
  }

  if (status === 'error' && !network.id) {
    hud.setMenuStatus(`Could not reach game server: ${url}`, false);
    return;
  }

  if (status === 'closed' && !network.id) {
    hud.setMenuStatus(`Disconnected. Retrying ${url}`, true);
    return;
  }

  if (status === 'reconnecting') {
    hud.showNotification('Connection lost - reconnecting');
  }
});

network.on('init', msg => {
  localPlayer.init(msg.id, msg.spawnPos);
  network.id = msg.id;
  hud.setLocalId(msg.id);
  gameStarted = true;
  hud.setMenuStatus('', false);
  hud.showGameHud(true);
  msg.players.forEach(p => {
    if (!remotePlayers.has(p.id)) {
      remotePlayers.set(p.id, new RemotePlayer(scene, p));
    }
  });
  if (msg.scores) hud.updateScoreboard(msg.scores);
  if (msg.pickups) pickups.setAll(msg.pickups);
});

network.on('playerJoined', msg => {
  if (msg.id !== network.id && !remotePlayers.has(msg.id)) {
    remotePlayers.set(msg.id, new RemotePlayer(scene, msg));
    hud.showNotification(`${msg.name} entered the frag`);
  }
});

network.on('playerLeft', msg => {
  const rp = remotePlayers.get(msg.id);
  if (rp) { rp.dispose(); remotePlayers.delete(msg.id); }
  hud.showNotification(`${msg.name} disconnected`);
});

network.on('stateUpdate', msg => {
  msg.players.forEach(p => {
    if (p.id === network.id) return;
    let rp = remotePlayers.get(p.id);
    if (!rp) {
      rp = new RemotePlayer(scene, p);
      remotePlayers.set(p.id, rp);
    }
    rp.updateState(p);
  });
  if (msg.scores) hud.updateScoreboard(msg.scores);
});

network.on('hit', msg => {
  if (msg.victimId === network.id) {
    localPlayer.takeDamage(msg.damage);
  }
  // Kill confirm from server (client-side hit marker is already shown in player.js)
  if (msg.killed && msg.killerId === network.id) {
    audio.playKillConfirm();
    hud.showKillConfirm();
  }
});

network.on('killed', msg => {
  const isMine = msg.killerId === network.id;
  hud.addKillFeedEntry(msg.killerName, msg.victimName, msg.weapon, isMine);
  if (msg.victimId === network.id) {
    localPlayer.die();
  }
});

network.on('grenadeSpawned', msg => {
  localPlayer.addGrenade(msg.id, msg.pos);
});

network.on('grenadeUpdate', msg => {
  localPlayer.updateServerGrenades(msg.grenades);
});

network.on('explosion', msg => {
  audio.playExplosion();
  spawnExplosion(msg.pos);
  localPlayer.removeGrenade(msg.id);
});

network.on('respawn', msg => {
  localPlayer.respawn(msg.pos);
});

network.on('pickupTaken', msg => {
  pickups.setActive(msg.id, false);
});

network.on('pickupRespawned', msg => {
  pickups.setActive(msg.id, true);
});

// Sent only to the player who grabbed the pickup
network.on('pickup', msg => {
  if (msg.kind === 'health') {
    localPlayer.setHealth(msg.health);
    hud.showNotification('Picked up a health pack');
  } else {
    localPlayer.addAmmo();
    hud.showNotification('Picked up ammo');
  }
  audio.playPickup();
});

// ── Menu / game start ─────────────────────────────────────────────────────────
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';

hud.onPlay(name => {
  playerName = name;
  pendingJoinName = name;
  hud.setMenuStatus('Connecting...', true);
  network.connect(WS_URL);
  network.send({ type: 'join', name });
  renderer.domElement.requestPointerLock();
});

// Press B to spawn a bot at the map spawn point farthest from the player
window.addEventListener('keydown', e => {
  if (e.code === 'KeyB' && gameStarted) {
    const pp = localPlayer.position;
    const sp = SPAWN_POINTS.reduce((best, s) => {
      const d  = Math.hypot(s[0] - pp.x, s[2] - pp.z);
      const bd = Math.hypot(best[0] - pp.x, best[2] - pp.z);
      return d > bd ? s : best;
    });
    bots.push(new Bot(scene, sp, wallMeshes));
    hud.showNotification('Bot spawned — press B to add more');
  }
});

// ── Render loop ───────────────────────────────────────────────────────────────
let prev = performance.now();

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt  = Math.min((now - prev) / 1000, 0.05);
  prev = now;

  // Update local player
  if (gameStarted) localPlayer.update(dt);

  // Update remote players
  remotePlayers.forEach(rp => rp.update(dt, camera.position));

  // Update bots
  for (let i = bots.length - 1; i >= 0; i--) {
    const bot = bots[i];
    if (!bot.alive) { bots.splice(i, 1); continue; }
    bot.update(dt, camera.position, localPlayer.alive, camera, dmg => {
      if (!localPlayer.alive) return;
      localPlayer.takeDamage(dmg);
      audio.playHit();
      if (localPlayer.health <= 0) {
        hud.addKillFeedEntry(bot.name, playerName || 'YOU', 'ak', false);
        localPlayer.die();
        botRespawnTimer = 3.0;
      }
    });
  }

  // Respawn after bot kill (server handles respawn for player-kills)
  if (botRespawnTimer > 0) {
    botRespawnTimer -= dt;
    if (botRespawnTimer <= 0 && !localPlayer.alive) {
      localPlayer.respawn(SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)]);
    }
  }

  // Animate pickups (bob + spin)
  pickups.update(dt);

  // Update HUD
  hud.update(dt);
  if (localPlayer.alive) {
    hud.updateHealth(localPlayer.health, localPlayer.armor);
  }

  // Update explosion effects
  for (let i = explosionEffects.length - 1; i >= 0; i--) {
    if (explosionEffects[i](dt)) explosionEffects.splice(i, 1);
  }

  // ── Render: world pass ──
  renderer.clear();
  camera.layers.set(0);
  renderer.render(scene, camera);

  // ── Render: viewmodel pass (depth-cleared so weapon draws on top) ──
  renderer.clearDepth();
  camera.layers.set(1);
  renderer.render(scene, camera);

  // Reset layers for raycasting / next frame
  camera.layers.enableAll();
}

loop();
