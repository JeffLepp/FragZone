import * as THREE from 'three';
import { createMap } from './map.js';
import { Bot } from './bot.js';
import { LocalPlayer } from './player.js';
import { RemotePlayer } from './remote.js';
import { Network } from './network.js';
import { HUD } from './hud.js';
import { AudioSystem } from './audio.js';
import { PickupManager } from './pickups.js';

const QUALITY_PRESETS = Object.freeze({
  performance: { pixelRatio: 1, shadows: false, shadowMapSize: 512 },
  balanced:    { pixelRatio: 1.25, shadows: true, shadowMapSize: 1024 },
});
const storedQuality = localStorage.getItem('fz-quality');
let graphicsQuality = storedQuality in QUALITY_PRESETS ? storedQuality : 'balanced';
let menuNeedsRender = true;

// ── Renderer ──────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_PRESETS[graphicsQuality].pixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = QUALITY_PRESETS[graphicsQuality].shadows;
renderer.shadowMap.type    = THREE.PCFShadowMap;
renderer.autoClear         = false; // we manage clear for viewmodel pass
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  menuNeedsRender = true;
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) menuNeedsRender = true;
});

// ── Scene & Camera ────────────────────────────────────────────────────────────
const scene  = new THREE.Scene();
// Use setClearColor instead of scene.background — scene.background forces a
// full framebuffer clear on every renderer.render() call regardless of
// autoClear, which erases the world pass when the viewmodel pass runs.
renderer.setClearColor(0x718696, 1);
scene.fog = new THREE.FogExp2(0x718696, 0.018);

const camera = new THREE.PerspectiveCamera(95, window.innerWidth / window.innerHeight, 0.05, 100);
// Camera added to scene so viewmodel children receive lighting
scene.add(camera);

// ── Lighting ──────────────────────────────────────────────────────────────────
const ambient = new THREE.AmbientLight(0xc8c0ad, 0.58);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xe3d4b8, 1.05);
sun.position.set(15, 25, 10);
sun.castShadow = QUALITY_PRESETS[graphicsQuality].shadows;
sun.shadow.camera.near   = 0.5;
sun.shadow.camera.far    = 100;
sun.shadow.camera.left   = -45;
sun.shadow.camera.right  = 45;
sun.shadow.camera.top    = 45;
sun.shadow.camera.bottom = -45;
sun.shadow.mapSize.set(
  QUALITY_PRESETS[graphicsQuality].shadowMapSize,
  QUALITY_PRESETS[graphicsQuality].shadowMapSize,
);
scene.add(sun);

// Subtle fill from below
const fill = new THREE.DirectionalLight(0x7890a6, 0.18);
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
const bots = new Map();           // id -> Bot (server-authoritative, shared)

const localPlayer = new LocalPlayer({ camera, scene, wallMeshes, remotePlayers, network, hud, audio, bots });

function applyGraphicsQuality(mode, { persist = true } = {}) {
  const nextMode = mode in QUALITY_PRESETS ? mode : 'balanced';
  const preset = QUALITY_PRESETS[nextMode];
  const shadowsChanged = renderer.shadowMap.enabled !== preset.shadows
    || sun.shadow.mapSize.x !== preset.shadowMapSize;

  graphicsQuality = nextMode;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = preset.shadows;
  sun.castShadow = preset.shadows;
  sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);

  if (shadowsChanged) {
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    scene.traverse(obj => {
      if (!obj.material) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      materials.forEach(material => { material.needsUpdate = true; });
    });
  }

  document.body.classList.toggle('fz-performance', nextMode === 'performance');
  menuNeedsRender = true;
  if (persist) localStorage.setItem('fz-quality', nextMode);
  return nextMode;
}

graphicsQuality = applyGraphicsQuality(graphicsQuality, { persist: false });
hud.setQuality(graphicsQuality);
hud.onQuality(mode => {
  graphicsQuality = applyGraphicsQuality(mode);
  hud.setQuality(graphicsQuality);
});

// ── Pointer lock ──────────────────────────────────────────────────────────────
// unadjustedMovement bypasses OS pointer acceleration ("Enhance pointer
// precision" on Windows), which otherwise causes large erratic jumps in
// movementX/Y on some machines. Falls back if the platform doesn't support it.
function lockPointer() {
  const el = renderer.domElement;
  const p = el.requestPointerLock({ unadjustedMovement: true });
  // Retry without options where unsupported; the retry can also reject
  // (e.g. re-locking too soon after Escape) — swallow it, the user just clicks again.
  if (p && p.catch) p.catch(() => { const r = el.requestPointerLock(); if (r && r.catch) r.catch(() => {}); });
}

renderer.domElement.addEventListener('click', () => {
  if (!document.pointerLockElement) lockPointer();
});
document.addEventListener('pointerlockchange', () => {
  const locked = !!document.pointerLockElement;
  hud.showPauseMenu(!locked && gameStarted);
  document.body.classList.toggle('locked', locked);
});

// ── Settings (escape menu) ────────────────────────────────────────────────────
const savedSens = Math.min(3, Math.max(0.1, parseFloat(localStorage.getItem('fz-sens')) || 1));
localPlayer.setSensitivity(savedSens);
hud.setSensitivity(savedSens);
hud.onSensitivity(v => {
  localPlayer.setSensitivity(v);
  localStorage.setItem('fz-sens', v);
});
hud.onResume(lockPointer);

// ── Explosion visual ──────────────────────────────────────────────────────────
const explosionEffects = [];
const EXPLOSION_GEO = new THREE.SphereGeometry(0.6, 10, 8);

function spawnExplosion(pos) {
  const mat  = new THREE.MeshBasicMaterial({ color: 0xFF5500, transparent: true, opacity: 1 });
  const mesh = new THREE.Mesh(EXPLOSION_GEO, mat);
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
      mat.dispose();
      return true; // done
    }
    return false;
  };
  explosionEffects.push(update);
}

// ── Network events ────────────────────────────────────────────────────────────
let gameStarted = false;
let pendingJoinName = '';

// Pages can't preventDefault window-closing shortcuts (Ctrl+W, Alt+F4), but
// they can require a leave-site confirmation — turning an instant close
// mid-game into a cancellable prompt.
window.addEventListener('beforeunload', e => {
  if (gameStarted) { e.preventDefault(); e.returnValue = ''; }
});

network.onStatus((status, { url }) => {
  if (status === 'connecting') {
    hud.setMenuStatus(`Connecting to ${url}`, true);
    return;
  }

  if (status === 'open') {
    // Each connection is a fresh session server-side, so always (re-)join.
    // Covers both the first connect and reconnects after a mid-game drop.
    if (pendingJoinName) {
      network.send({ type: 'join', name: pendingJoinName });
    }
    if (!gameStarted) hud.setMenuStatus('Waiting for server...', true);
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
  // On a rejoin after reconnect the server assigns a new id and sends a fresh
  // world snapshot — drop everything left over from the old session.
  remotePlayers.forEach(rp => rp.dispose());
  remotePlayers.clear();
  bots.forEach(b => b.dispose());
  bots.clear();
  localPlayer.updateServerGrenades([]);

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
  (msg.bots || []).forEach(b => {
    if (!bots.has(b.id)) bots.set(b.id, new Bot(scene, b));
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
  const seen = new Set();
  msg.players.forEach(p => {
    if (p.id === network.id) return;
    seen.add(p.id);
    let rp = remotePlayers.get(p.id);
    if (!rp) {
      rp = new RemotePlayer(scene, p);
      remotePlayers.set(p.id, rp);
    }
    rp.updateState(p);
  });
  // Prune remotes the server no longer reports — covers any path where the
  // playerLeft broadcast was missed, so ghost avatars can't linger.
  for (const [id, rp] of remotePlayers) {
    if (!seen.has(id)) {
      rp.dispose();
      remotePlayers.delete(id);
    }
  }

  // Bots are diffed the same way: create/update from the snapshot, prune any
  // the server no longer reports (cleared wave, bot mode off, missed kill).
  const seenBots = new Set();
  (msg.bots || []).forEach(b => {
    seenBots.add(b.id);
    let bv = bots.get(b.id);
    if (!bv) { bv = new Bot(scene, b); bots.set(b.id, bv); }
    bv.updateState(b);
  });
  for (const [id, bv] of bots) {
    if (!seenBots.has(id)) { bv.dispose(); bots.delete(id); }
  }

  if (msg.scores) hud.updateScoreboard(msg.scores);
});

network.on('hit', msg => {
  if (msg.victimId === network.id) {
    localPlayer.takeDamage(msg.damage);
  }
  // Kill confirm from server (client-side hit marker is already shown in player.js)
  // — but not for suicides, where killer and victim are both us.
  if (msg.killed && msg.killerId === network.id && msg.victimId !== network.id) {
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

// A new bot wave spawned. `first` is the opening wave when bot mode is toggled
// on; later waves announce the growing count as each is cleared.
network.on('botWave', msg => {
  hud.showNotification(msg.first
    ? 'Bot mode ON — clear waves to face double the bots (B to stop)'
    : `Wave cleared — ${msg.size} bots incoming`);
});

network.on('botMode', msg => {
  if (!msg.on) hud.showNotification('Bot mode OFF');
});

// A bot was killed by a player. Remove it immediately (don't wait for the next
// stateUpdate prune) and show the kill feed / confirm.
network.on('botKilled', msg => {
  const bv = bots.get(msg.botId);
  if (bv) { bv.dispose(); bots.delete(msg.botId); }
  const isMine = msg.killerId === network.id;
  hud.addKillFeedEntry(msg.killerName, msg.botName, msg.weapon, isMine);
  if (isMine) {
    audio.playKillConfirm();
    hud.showKillConfirm();
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
  // Blast damage to players and bots is resolved server-side (see the
  // explosion loop in server/index.js); bot deaths arrive via 'botKilled'.
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
  pendingJoinName = name;
  hud.setMenuStatus('Connecting...', true);
  network.connect(WS_URL); // 'open' status handler sends the join
  lockPointer();
});

// ── Bot mode ──────────────────────────────────────────────────────────────────
// Bots are now server-authoritative and shared by everyone in the match. B
// asks the server to toggle the game-wide bot mode; the server spawns/runs the
// waves and broadcasts them, so all players see (and get shot at by) the same
// bots. Waves double in size each time one is cleared (1 → 2 → 4 → 8 …).
window.addEventListener('keydown', e => {
  if (e.code === 'KeyB' && gameStarted) network.send({ type: 'toggleBots' });
});

// ── Render loop ───────────────────────────────────────────────────────────────
let prev = performance.now();
let lastRender = 0;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt  = Math.min((now - prev) / 1000, 0.05);
  prev = now;

  // Background tabs already throttle requestAnimationFrame, but explicitly
  // skip all render/update work so a hidden match consumes effectively no GPU.
  if (document.hidden) return;

  // Update local player
  if (gameStarted) localPlayer.update(dt);

  // Update remote players
  remotePlayers.forEach(rp => rp.update(dt, camera.position));

  // Update bots (render-only: interpolate toward the latest server position;
  // AI, movement and damage are all resolved server-side).
  bots.forEach(bot => bot.update(dt, camera));

  // Animate pickups (bob + spin)
  pickups.update(dt);

  // Update HUD
  hud.update(dt);

  // Update explosion effects
  for (let i = explosionEffects.length - 1; i >= 0; i--) {
    if (explosionEffects[i](dt)) explosionEffects.splice(i, 1);
  }

  // The pre-game world is static, so draw it once beneath the menu. While the
  // pause overlay is open, cap only rendering at 30 fps; network/state updates
  // above continue normally for the online match.
  if (!gameStarted) {
    if (!menuNeedsRender) return;
    menuNeedsRender = false;
  } else if (!document.pointerLockElement && now - lastRender < 1000 / 30) {
    return;
  }
  lastRender = now;

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
