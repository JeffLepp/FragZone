import * as THREE from 'three';
import { COLLISION_BOXES, MAP_BOUNDS, RAMPS, SURF_RAMPS, RAMP_THICK, rampHeightAt } from './map.js';

// Spiral ramps and surf ramps share the same solid-slab collision in _hits;
// only RAMPS are walkable (surf ramps are ridden — see the surf branch).
const SOLID_RAMPS = [...RAMPS, ...SURF_RAMPS];

// ── CS:Source-inspired physics constants (metric units) ──────────────────────
const MAX_SPEED     = 5.0;    // m/s walk
const WALK_SPEED    = 2.5;
const CROUCH_SPEED  = 2.0;
const GROUND_ACCEL  = 10;
const AIR_ACCEL     = 12;
const FRICTION      = 4.0;
const GRAVITY       = 15.5;
const JUMP_VEL      = 5.6;
const PLAYER_R      = 0.38;   // capsule radius
const STEP_UP_H     = 0.45;   // max ledge auto-climbed while grounded
const SNAP_DOWN     = 0.55;   // max drop followed while grounded (ramp descents, slab edges)
const PLAYER_H      = 1.82;
const CROUCH_H      = 1.1;
const EYE_H         = 1.62;
const CROUCH_EYE_H  = 0.92;
const NET_HZ        = 20;

// Keys the game owns while the pointer is locked. Crouch is Alt, which the
// browser also uses — Alt alone focuses the menu bar, Alt+D the address bar,
// Alt+Arrow navigates history — so it must be preventDefault-ed on both
// keydown and keyup. (Alt+F4 is OS-reserved and unblockable; the
// beforeunload guard in main.js catches accidental closes.)
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyG', 'KeyC', 'KeyB',
  'Digit1', 'Digit2', 'Space',
  'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
]);

const WEAPON_DEF = {
  ak: {
    name: 'AK-47', maxMag: 30, reserve: 90,
    rpm: 600, bloomInc: 0.018, bloomDecay: 0.16,
    recoilUp: 0.017, recoilSide: 0.007, reloadTime: 2.4,
    color: 0x444444, woodColor: 0x6B4423,
    damage: 27, // keep in sync with server WEAPON_DATA (only applied to bots here)
  },
  pistol: {
    name: 'USP-S', maxMag: 15, reserve: 45,
    rpm: 350, bloomInc: 0.010, bloomDecay: 0.24,
    recoilUp: 0.010, recoilSide: 0.004, reloadTime: 1.7,
    color: 0x555555, woodColor: 0x555555,
    damage: 35, // keep in sync with server WEAPON_DATA (only applied to bots here)
  },
};

// Shared across all impact/grenade meshes — the meshes themselves are cheap to
// create, but geometry and material hold GPU buffers and must not be recreated
// (and silently leaked) on every wall hit or grenade.
const IMPACT_GEO  = new THREE.SphereGeometry(0.04, 4, 4);
const IMPACT_MAT  = new THREE.MeshBasicMaterial({ color: 0xDDCC88 });
const GRENADE_GEO = new THREE.SphereGeometry(0.12, 8, 6);
const GRENADE_MAT = new THREE.MeshLambertMaterial({ color: 0x445533 });

export class LocalPlayer {
  constructor({ camera, scene, wallMeshes, remotePlayers, network, hud, audio, bots }) {
    this._cam          = camera;
    this._scene        = scene;
    this._wallMeshes   = wallMeshes;
    this._remotes      = remotePlayers; // Map<id, RemotePlayer>
    this._net          = network;
    this._hud          = hud;
    this._audio        = audio;
    this._bots         = bots || null;

    this.id    = null;
    this.alive = false;

    this._pos = new THREE.Vector3();
    this._vel = new THREE.Vector3();

    this._yaw   = 0;
    this._pitch = 0;
    this._recoilPitch = 0;
    this._recoilYaw   = 0;

    this._onGround  = false;
    this._landBob   = 0;
    this._smoothY   = 0;  // eye-height follower (see camera section in update)

    this._crouchAmt = 0; // 0=stand 1=crouch (smooth)

    this._bobTimer = 0;

    this._health = 100;
    this._armor  = 100;

    // Ammo state
    this._ammo    = { ak: 30, pistol: 15 };
    this._reserve = { ak: 90, pistol: 45 };
    this._grenades = 1;
    this._weapon  = 'ak';

    this._bloom        = 0;
    this._shootCD      = 0;
    this._reloading    = false;
    this._reloadTimer  = 0;
    this._semi_prev    = false; // for semi-auto

    this._respawnTimer = 0;
    this._netTimer     = 0;

    // Raw mouse accumulator
    this._dx = 0;
    this._dy = 0;
    this._lmbDown    = false;
    this._lmbPrev    = false;
    this._sensitivity = 0.00175;

    // Server grenade visuals
    this._grenObjs = new Map();

    // Viewmodels (two, toggled by weapon switch)
    this._vmGroups = {
      ak:     this._buildVM('ak'),
      pistol: this._buildVM('pistol'),
    };
    this._vmLight = new THREE.PointLight(0xffffff, 0, 4);
    this._vmLight.layers.set(1);
    scene.add(this._vmLight);
    this._muzzleFlashTimer = 0;

    this._keys = new Set();
    this._bindInput();
  }

  // ─── Input ─────────────────────────────────────────────────────────────────

  _bindInput() {
    window.addEventListener('keydown', e => {
      this._keys.add(e.code);
      // Only hijack Tab once we've joined (id set by 'init') — in the menu it
      // must keep its default focus-navigation behaviour.
      if (e.code === 'Tab' && this.id) { e.preventDefault(); this._hud.showScoreboard(true); }
      if (document.pointerLockElement && GAME_KEYS.has(e.code)) e.preventDefault();
      if (!this.alive) return;
      if (e.code === 'KeyR') this._startReload();
      if (e.code === 'KeyG') this._throwGrenade();
      if (e.code === 'Digit1') this._switchWeapon('ak');
      if (e.code === 'Digit2') this._switchWeapon('pistol');
    });
    window.addEventListener('keyup', e => {
      this._keys.delete(e.code);
      // Alt's menu-bar focus fires on release, so keyup needs blocking too.
      if (document.pointerLockElement && GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.code === 'Tab') this._hud.showScoreboard(false);
    });
    window.addEventListener('mousemove', e => {
      if (document.pointerLockElement) {
        this._dx += e.movementX;
        this._dy += e.movementY;
      }
    });
    // Only register fire input while the pointer is locked — otherwise the
    // click that re-acquires pointer lock (or hits a menu button) fires a shot.
    window.addEventListener('mousedown', e => {
      if (e.button === 0 && document.pointerLockElement) this._lmbDown = true;
    });
    window.addEventListener('mouseup',   e => { if (e.button === 0) this._lmbDown = false; });

    // Alt-tab / pointer-lock loss can swallow keyup and mouseup events,
    // leaving keys (and the trigger) stuck held — release everything.
    const releaseInput = () => {
      this._keys.clear();
      this._lmbDown = false;
      this._hud.showScoreboard(false); // Tab keyup is lost on Alt+Tab
    };
    window.addEventListener('blur', releaseInput);
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement) releaseInput();
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  init(id, spawnPos) {
    this.id    = id;
    this.alive = true;
    this._pos.set(...spawnPos);
    this._vel.set(0, 0, 0);
    this._health = 100; this._armor = 100;
    this._resetLoadout();
    this._syncHud();
  }

  respawn(pos) {
    this.alive = true;
    this._pos.set(...pos);
    this._vel.set(0, 0, 0);
    this._health = 100; this._armor = 100;
    this._respawnTimer = 0;
    this._bloom = 0;
    this._resetLoadout();
    this._hud.hideDeathScreen();
    this._hud.updateHealth(100, 100);
    this._syncHud();
  }

  // Fresh spawn: full mags, full reserves, grenade back
  _resetLoadout() {
    this._ammo     = { ak: WEAPON_DEF.ak.maxMag,  pistol: WEAPON_DEF.pistol.maxMag };
    this._reserve  = { ak: WEAPON_DEF.ak.reserve, pistol: WEAPON_DEF.pistol.reserve };
    this._grenades = 1;
    this._reloading   = false;
    this._reloadTimer = 0;
    this._shootCD     = 0;
    this._hud.showReload(1);
  }

  // Server-authoritative health from a health-pack pickup
  setHealth(hp) {
    this._health = hp;
    this._hud.updateHealth(this._health, this._armor);
  }

  // Ammo-box pickup: tops up reserves and grenades (caps at spawn amounts +1 nade)
  addAmmo() {
    this._reserve.ak     = Math.min(WEAPON_DEF.ak.reserve,     this._reserve.ak + 60);
    this._reserve.pistol = Math.min(WEAPON_DEF.pistol.reserve, this._reserve.pistol + 30);
    this._grenades       = Math.min(2, this._grenades + 1);
    this._syncHud();
  }

  takeDamage(amount) {
    this._health = Math.max(0, this._health - amount);
    this._hud.updateHealth(this._health, this._armor);
    this._hud.showDamage();
    this._recoilPitch += 0.02; // camera kick from being hit
  }

  die() {
    this.alive = false;
    this._respawnTimer = 3;
    this._vel.set(0, 0, 0);
    this._hud.showDeathScreen(3);
  }

  // ─── Weapons ───────────────────────────────────────────────────────────────

  _switchWeapon(name) {
    if (this._weapon === name) return;
    if (this._reloading) { this._reloading = false; this._reloadTimer = 0; this._hud.showReload(1); }
    // Kill any in-flight muzzle flash: _updateVM only manages the flash of the
    // *current* weapon, so a flash left mid-burn on the old model would stay
    // visible until that weapon is fired again.
    this._muzzleFlashTimer = 0;
    Object.values(this._vmGroups).forEach(g => { g._flash.visible = false; });
    this._vmLight.intensity = 0;
    this._weapon = name;
    this._bloom  = 0;
    this._syncHud();
  }

  _startReload() {
    const def  = WEAPON_DEF[this._weapon];
    const ammo = this._ammo[this._weapon];
    const res  = this._reserve[this._weapon];
    if (!def || this._reloading || ammo >= def.maxMag || res <= 0) return;
    this._reloading   = true;
    this._reloadTimer = def.reloadTime;
    this._audio.playReload();
  }

  _finishReload() {
    const max  = WEAPON_DEF[this._weapon].maxMag;
    const need = max - this._ammo[this._weapon];
    const take = Math.min(need, this._reserve[this._weapon]);
    this._ammo[this._weapon]    += take;
    this._reserve[this._weapon] -= take;
    this._reloading = false;
    this._hud.showReload(1);
    this._syncHud();
  }

  _tryShoot() {
    if (!this.alive || this._shootCD > 0 || this._reloading) return;
    const def  = WEAPON_DEF[this._weapon];
    const ammo = this._ammo[this._weapon];
    if (!def) return;

    // Semi-auto pistol: require fresh click
    const justClicked = this._lmbDown && !this._semi_prev;
    if (this._weapon === 'pistol' && !justClicked) return;

    if (ammo <= 0) { this._audio.playEmpty(); return; }

    this._ammo[this._weapon]--;
    this._shootCD   = 60 / def.rpm;
    this._bloom     = Math.min(this._bloom + def.bloomInc, 0.1);
    this._recoilPitch += def.recoilUp   + Math.random() * 0.004;
    this._recoilYaw   += (Math.random() - 0.5) * def.recoilSide;

    this._audio.playGunshot(this._weapon);
    this._triggerMuzzleFlash();
    this._syncHud();

    // Ray direction with bloom spread
    const spd = Math.hypot(this._vel.x, this._vel.z);
    const sp  = this._bloom + (this._onGround ? 0 : 0.03) + spd * 0.002;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this._cam.quaternion);
    dir.x += (Math.random() - 0.5) * sp;
    dir.y += (Math.random() - 0.5) * sp;
    dir.z += (Math.random() - 0.5) * sp;
    dir.normalize();

    const origin = this._cam.position.clone();

    // Check wall distance
    const rc        = new THREE.Raycaster(origin, dir, 0, 120);
    const wallHits  = rc.intersectObjects(this._wallMeshes, false);
    const wallDist  = wallHits.length ? wallHits[0].distance : Infinity;

    // Check remote players
    let hitId = null, hitBot = null, hitDist = wallDist;
    this._remotes.forEach((rp, id) => {
      const d = rp.rayIntersect(origin, dir);
      if (d !== null && d < hitDist) { hitDist = d; hitId = id; hitBot = null; }
    });

    // Check bots
    if (this._bots) {
      this._bots.forEach(bot => {
        const d = bot.rayIntersect(origin, dir);
        if (d !== null && d < hitDist) { hitDist = d; hitBot = bot; hitId = null; }
      });
    }

    if (hitId) {
      this._net.send({ type: 'shoot', targetId: hitId, weapon: this._weapon });
      this._hud.showHitMarker();
      this._audio.playHitMarker();
    }

    if (hitBot) {
      hitBot.takeDamage(def.damage);
      this._hud.showHitMarker();
      this._audio.playHitMarker();
      if (!hitBot.alive) {
        this._audio.playKillConfirm();
        this._hud.showKillConfirm();
        this._hud.addKillFeedEntry('YOU', hitBot.name, this._weapon, true);
      }
    }

    if (wallHits.length && wallDist <= hitDist) {
      this._spawnImpact(wallHits[0].point, wallHits[0].face?.normal);
    }

    if (this._ammo[this._weapon] === 0 && this._reserve[this._weapon] > 0) {
      setTimeout(() => this._startReload(), 120);
    }
  }

  _throwGrenade() {
    if (!this.alive || this._grenades <= 0) return;
    this._grenades--;
    this._audio.playGrenadePull();
    const pos = this._cam.position.toArray();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this._cam.quaternion);
    const vel = [fwd.x * 14, fwd.y * 14 + 3, fwd.z * 14];
    this._net.send({ type: 'throwGrenade', pos, vel });
    this._syncHud();
  }

  _triggerMuzzleFlash() {
    this._muzzleFlashTimer = 0.045;
    this._vmLight.intensity = 4;
  }

  _spawnImpact(pos, normal) {
    const m = new THREE.Mesh(IMPACT_GEO, IMPACT_MAT);
    m.position.copy(pos);
    if (normal) m.position.addScaledVector(normal, 0.02);
    this._scene.add(m);
    setTimeout(() => this._scene.remove(m), 350);
  }

  // ─── Server grenade visuals ─────────────────────────────────────────────────

  updateServerGrenades(list) {
    const seen = new Set(list.map(g => g.id));
    list.forEach(({ id, pos }) => {
      if (!this._grenObjs.has(id)) {
        const m = new THREE.Mesh(GRENADE_GEO, GRENADE_MAT);
        this._scene.add(m);
        this._grenObjs.set(id, m);
      }
      this._grenObjs.get(id).position.set(...pos);
    });
    for (const [id, m] of this._grenObjs) {
      if (!seen.has(id)) { this._scene.remove(m); this._grenObjs.delete(id); }
    }
  }

  addGrenade(id, pos) {
    if (!this._grenObjs.has(id)) {
      const m = new THREE.Mesh(GRENADE_GEO, GRENADE_MAT);
      this._scene.add(m);
      this._grenObjs.set(id, m);
    }
    if (pos) this._grenObjs.get(id).position.set(...pos);
  }

  removeGrenade(id) {
    const m = this._grenObjs.get(id);
    if (m) { this._scene.remove(m); this._grenObjs.delete(id); }
  }

  // ─── Physics ───────────────────────────────────────────────────────────────

  _doMove(dt) {
    // Mouse look
    this._yaw   -= this._dx * this._sensitivity;
    this._pitch -= this._dy * this._sensitivity;
    this._pitch  = Math.max(-Math.PI / 2.05, Math.min(Math.PI / 2.05, this._pitch));
    this._dx = 0; this._dy = 0;

    // Recoil recovery (exponential)
    const recovFactor = Math.pow(0.80, dt * 60);
    this._recoilPitch *= recovFactor;
    this._recoilYaw   *= recovFactor;

    // Crouch lerp (C kept as alternate crouch key)
    let wantCrouch = this._keys.has('AltLeft') || this._keys.has('AltRight')
                  || this._keys.has('KeyC');
    // No headroom to stand (e.g. under the low end of the spiral ramp):
    // stay crouched until the standing capsule fits, or releasing crouch
    // would embed us in the ceiling and freeze movement permanently.
    if (!wantCrouch &&
        this._hits(this._pos.x, this._pos.y, this._pos.z, PLAYER_R, PLAYER_H)) {
      wantCrouch = true;
    }
    this._crouchAmt  = THREE.MathUtils.lerp(this._crouchAmt, wantCrouch ? 1 : 0, dt * 14);
    const crouching  = this._crouchAmt > 0.5;
    const playerH    = crouching ? CROUCH_H : PLAYER_H;

    // Wish direction (horizontal, ignores pitch)
    const cosY = Math.cos(this._yaw), sinY = Math.sin(this._yaw);
    let wx = 0, wz = 0;
    if (this._keys.has('KeyW')) { wx -= sinY; wz -= cosY; }
    if (this._keys.has('KeyS')) { wx += sinY; wz += cosY; }
    if (this._keys.has('KeyA')) { wx -= cosY; wz += sinY; }
    if (this._keys.has('KeyD')) { wx += cosY; wz -= sinY; }
    const wlen = Math.hypot(wx, wz);
    if (wlen > 0) { wx /= wlen; wz /= wlen; }

    const isWalking  = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight');
    const wishSpeed  = crouching ? CROUCH_SPEED : isWalking ? WALK_SPEED : MAX_SPEED;

    if (this._onGround) {
      // Jump check before friction — skipping friction on the landing frame
      // lets bhop preserve speed and accumulate with each hop.
      if (this._keys.has('Space')) {
        this._vel.y    = JUMP_VEL;
        this._onGround = false;
      } else {
        const spd = Math.hypot(this._vel.x, this._vel.z);
        if (spd > 0.01) {
          const f = Math.max(spd - spd * FRICTION * dt, 0) / spd;
          this._vel.x *= f; this._vel.z *= f;
        }
      }
      // Accelerate
      this._accel(wx, wz, wishSpeed, GROUND_ACCEL, dt);

    } else {
      // No wishSpeed cap in air — bhop speed accumulates freely
      this._accel(wx, wz, wishSpeed, AIR_ACCEL, dt);
      this._vel.y -= GRAVITY * dt;
    }

    // ── Axis-separated collision ──
    const r = PLAYER_R;
    const prevOnGround = this._onGround;

    const nx = this._pos.x + this._vel.x * dt;
    if (!this._hits(nx, this._pos.y, this._pos.z, r, playerH)) {
      this._pos.x = nx;
    } else if (this._onGround && this._tryStepUp(nx, this._pos.z, r, playerH)) {
      this._pos.x = nx;
    } else {
      this._vel.x = 0;
    }

    const nz = this._pos.z + this._vel.z * dt;
    if (!this._hits(this._pos.x, this._pos.y, nz, r, playerH)) {
      this._pos.z = nz;
    } else if (this._onGround && this._tryStepUp(this._pos.x, nz, r, playerH)) {
      this._pos.z = nz;
    } else {
      this._vel.z = 0;
    }

    // ── Vertical ──
    // Grounded: snap to the surface underfoot every frame (floor, slab top,
    // or ramp grade). This keeps _onGround stable — testing the capsule
    // against box tops instead made it flicker, retriggering the land-bob and
    // jittering the camera whenever the player stood on raised geometry.
    if (this._onGround) {
      const g = this._supportHeight(this._pos.x, this._pos.z, r, this._pos.y + STEP_UP_H);
      if (g > this._pos.y - SNAP_DOWN) {
        this._pos.y = g;
        this._vel.y = 0;
      } else {
        this._onGround = false; // walked off an edge
      }
    }

    if (!this._onGround) {
      const ny = this._pos.y + this._vel.y * dt;
      if (this._vel.y <= 0) {
        const g    = this._supportHeight(this._pos.x, this._pos.z, r, this._pos.y + STEP_UP_H);
        const surf = this._surfAt(this._pos.x, this._pos.z, ny, g);
        if (surf) {
          // Surfing: pin to the surface and clip velocity along its plane
          // (Source's slide rule). Never grounded, so there is no friction
          // and no jump — the gravity re-applied each frame becomes
          // acceleration down the slope, and air-strafe steers.
          this._pos.y = surf.h;
          const d = this._vel.x * surf.r.nx + this._vel.y * surf.r.ny + this._vel.z * surf.r.nz;
          if (d < 0) {
            this._vel.x -= surf.r.nx * d;
            this._vel.y -= surf.r.ny * d;
            this._vel.z -= surf.r.nz * d;
          }
        } else if (ny <= g && this._pos.y >= g - STEP_UP_H) {
          this._pos.y    = g;
          this._vel.y    = 0;
          this._onGround = true;
          if (!prevOnGround) this._landBob = 1;
        } else {
          this._pos.y = ny;
        }
      } else if (!this._hits(this._pos.x, ny, this._pos.z, r, playerH)) {
        this._pos.y = ny;
      } else {
        this._vel.y = 0; // head bump
      }
    }

    // Clamp to map
    this._pos.x = Math.max(MAP_BOUNDS.minX + r, Math.min(MAP_BOUNDS.maxX - r, this._pos.x));
    this._pos.z = Math.max(MAP_BOUNDS.minZ + r, Math.min(MAP_BOUNDS.maxZ - r, this._pos.z));

    this._landBob = Math.max(0, this._landBob - dt * 9);
  }

  _accel(wx, wz, wishSpeed, accel, dt) {
    const cur      = this._vel.x * wx + this._vel.z * wz;
    const addSpeed = wishSpeed - cur;
    if (addSpeed <= 0) return;
    const amt = Math.min(addSpeed, accel * wishSpeed * dt);
    this._vel.x += wx * amt;
    this._vel.z += wz * amt;
  }

  // Auto-climb low ledges: if the blocked horizontal move clears with the
  // capsule lifted STEP_UP_H, take it and settle onto the ledge top.
  _tryStepUp(x, z, r, h) {
    if (this._hits(x, this._pos.y + STEP_UP_H, z, r, h)) return false;
    let y = this._pos.y + STEP_UP_H;
    while (y - 0.05 > this._pos.y && !this._hits(x, y - 0.05, z, r, h)) y -= 0.05;
    this._pos.y = y;
    return true;
  }

  // Highest walkable surface under the capsule at (x, z) with top ≤ yMax:
  // the floor, any overlapped box top, or a ramp surface. Drives both the
  // grounded snap-follow and airborne touch-down.
  _supportHeight(x, z, r, yMax) {
    let best = 0; // the floor
    const x0 = x - r, x1 = x + r;
    const z0 = z - r, z1 = z + r;
    for (const b of COLLISION_BOXES) {
      if (b.maxY > best && b.maxY <= yMax &&
          x1 > b.minX && x0 < b.maxX &&
          z1 > b.minZ && z0 < b.maxZ) best = b.maxY;
    }
    for (const rp of RAMPS) {
      if (x1 > rp.minX && x0 < rp.maxX && z1 > rp.minZ && z0 < rp.maxZ) {
        const sh = rampHeightAt(rp, x, z);
        if (sh > best && sh <= yMax) best = sh;
      }
    }
    return best;
  }

  // The surf ramp surface the falling capsule is crossing this frame, if any:
  // center over the ramp, surface passed between the previous y (with slack
  // for the height change from this frame's horizontal move) and the next,
  // and still above the walkable support — at the ramp's foot the floor
  // takes over and the rider lands.
  _surfAt(x, z, ny, g) {
    for (const rp of SURF_RAMPS) {
      if (x <= rp.minX || x >= rp.maxX || z <= rp.minZ || z >= rp.maxZ) continue;
      const h = rampHeightAt(rp, x, z);
      if (ny <= h && this._pos.y >= h - 0.3 && h > g + 0.01) return { r: rp, h };
    }
    return null;
  }

  _hits(x, y, z, r, h) {
    const x0 = x - r, x1 = x + r;
    const y0 = y,     y1 = y + h;
    const z0 = z - r, z1 = z + r;
    for (const b of COLLISION_BOXES) {
      if (x1 > b.minX && x0 < b.maxX &&
          y1 > b.minY && y0 < b.maxY &&
          z1 > b.minZ && z0 < b.maxZ) return true;
    }
    // Ramps are solid slabs, except approached from above with the surface
    // within step-up reach of the feet — then the grounded snap (or the surf
    // pin) walks the capsule along the grade instead of treating the slope
    // as a wall.
    for (const rp of SOLID_RAMPS) {
      if (x1 > rp.minX && x0 < rp.maxX && z1 > rp.minZ && z0 < rp.maxZ) {
        if (rampHeightAt(rp, x, z) <= y + STEP_UP_H) continue;
        // Surface band across the capsule footprint (height varies only
        // along the ramp axis, so the extremes sit ±r along it).
        const hA = rampHeightAt(rp, x - rp.ux * r, z - rp.uz * r);
        const hB = rampHeightAt(rp, x + rp.ux * r, z + rp.uz * r);
        if (y1 > Math.min(hA, hB) - RAMP_THICK && y0 < Math.max(hA, hB)) return true;
      }
    }
    return false;
  }

  // ─── Viewmodel ─────────────────────────────────────────────────────────────

  _buildVM(type) {
    const def  = WEAPON_DEF[type];
    const grp  = new THREE.Group();
    grp.layers.set(1);

    const mat  = new THREE.MeshLambertMaterial({ color: def.color, emissive: new THREE.Color(def.color).multiplyScalar(0.2) });
    const wood = new THREE.MeshLambertMaterial({ color: def.woodColor, emissive: new THREE.Color(def.woodColor).multiplyScalar(0.15) });

    if (type === 'ak') {
      const recv = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.04, 0.28), mat);
      const brl  = new THREE.Mesh(new THREE.BoxGeometry(0.013, 0.013, 0.20), mat);
      brl.position.set(0, 0.018, -0.22);
      const stk  = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.09, 0.055), wood);
      stk.position.set(0, -0.04, 0.14);
      const grd  = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.028, 0.10), wood);
      grd.position.set(0, 0.004, -0.09);
      const mag  = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.072, 0.038), mat);
      mag.position.set(0, -0.04, -0.018);
      grp.add(recv, brl, stk, grd, mag);
    } else {
      // Pistol
      const recv = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.048, 0.16), mat);
      const brl  = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.10), mat);
      brl.position.set(0, 0.014, -0.12);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.08, 0.04), wood);
      grip.position.set(0, -0.056, 0.02);
      const mag  = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.055, 0.028), mat);
      mag.position.set(0, -0.044, 0);
      grp.add(recv, brl, grip, mag);
    }

    // Muzzle flash sphere (per model)
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0xFFAA33 })
    );
    flash.layers.set(1);
    flash.visible = false;
    flash.position.set(0, type === 'ak' ? 0.018 : 0.014, type === 'ak' ? -0.32 : -0.17);
    grp.add(flash);
    grp._flash = flash;

    // All descendant meshes must be on layer 1 so they only render in the
    // viewmodel pass. Three.js layer-tests each Mesh individually; the Group's
    // layer assignment does not propagate to children automatically.
    grp.traverse(obj => obj.layers.set(1));

    grp.visible = false;
    this._scene.add(grp);
    return grp;
  }

  _updateVM(dt) {
    const spd = Math.hypot(this._vel.x, this._vel.z);
    const bi  = this._onGround && spd > 0.5 ? Math.min(spd / MAX_SPEED, 1) : 0;
    this._bobTimer += dt * spd * 1.8;

    const bobX = Math.cos(this._bobTimer) * 0.020 * bi;
    const bobY = Math.abs(Math.sin(this._bobTimer)) * 0.025 * bi + this._landBob * 0.04;

    const off = new THREE.Vector3(0.26 + bobX, -0.22 - bobY, -0.44);
    off.applyQuaternion(this._cam.quaternion);

    const cur = this._vmGroups[this._weapon];
    Object.values(this._vmGroups).forEach(g => {
      g.visible = g === cur && this.alive;
    });
    if (!this.alive) return;

    cur.position.copy(this._cam.position).add(off);
    cur.quaternion.copy(this._cam.quaternion);

    // Muzzle flash
    if (this._muzzleFlashTimer > 0) {
      this._muzzleFlashTimer -= dt;
      cur._flash.visible    = true;
      this._vmLight.position.copy(cur._flash.getWorldPosition(new THREE.Vector3()));
      this._vmLight.intensity = Math.max(0, this._muzzleFlashTimer / 0.045) * 5;
      if (this._muzzleFlashTimer <= 0) {
        cur._flash.visible    = false;
        this._vmLight.intensity = 0;
      }
    }
  }

  // ─── HUD sync ──────────────────────────────────────────────────────────────

  _syncHud() {
    this._hud.updateAmmo(
      this._weapon,
      this._ammo[this._weapon],
      this._reserve[this._weapon],
      this._grenades,
    );
  }

  // ─── Main update ───────────────────────────────────────────────────────────

  update(dt) {
    // Respawn countdown
    if (!this.alive) {
      if (this._respawnTimer > 0) {
        this._respawnTimer -= dt;
        this._hud.updateDeathCountdown(this._respawnTimer);
      }
      this._dx = 0; this._dy = 0;
      this._updateVM(dt);
      return;
    }

    // Shoot cooldown
    if (this._shootCD > 0) this._shootCD -= dt;

    // Fire input — _tryShoot enforces semi-auto (fresh click) for the pistol
    if (this._lmbDown) this._tryShoot();
    this._semi_prev = this._lmbDown;

    // Reload
    if (this._reloading) {
      this._reloadTimer -= dt;
      const def = WEAPON_DEF[this._weapon];
      this._hud.showReload(1 - this._reloadTimer / def.reloadTime);
      if (this._reloadTimer <= 0) this._finishReload();
    }

    // Bloom decay
    const def = WEAPON_DEF[this._weapon];
    if (def) this._bloom = Math.max(0, this._bloom - def.bloomDecay * dt);

    // Physics
    this._doMove(dt);

    // Camera. While grounded the eye glides toward the true y instead of
    // tracking it: ramp-corner hand-offs and auto step-up move the capsule in
    // small one-frame pops, and smoothing here is what hides them (the same
    // trick Source uses for stairs). Airborne tracks exactly so jumps and
    // falls stay crisp; a big divergence (teleport/respawn) snaps.
    if (this._onGround && Math.abs(this._pos.y - this._smoothY) < 1) {
      this._smoothY += (this._pos.y - this._smoothY) * Math.min(1, dt * 14);
    } else {
      this._smoothY = this._pos.y;
    }
    const eyeY = this._smoothY
      + THREE.MathUtils.lerp(EYE_H, CROUCH_EYE_H, this._crouchAmt)
      - this._landBob * 0.03;
    this._cam.position.set(this._pos.x, eyeY, this._pos.z);
    this._cam.rotation.order = 'YXZ';
    this._cam.rotation.y     = this._yaw   + this._recoilYaw;
    this._cam.rotation.x     = this._pitch + this._recoilPitch;

    // Viewmodel
    this._updateVM(dt);

    // Crosshair bloom
    const spd = Math.hypot(this._vel.x, this._vel.z);
    this._hud.setBloom(4 + this._bloom * 65 + (this._onGround ? 0 : 14) + spd * 1.8);

    // Footsteps
    this._audio.tickFootsteps(dt, spd, this._onGround);

    // Network (20 Hz)
    this._netTimer += dt;
    if (this._netTimer >= 1 / NET_HZ) {
      this._netTimer = 0;
      this._net.send({
        type:      'move',
        pos:       [this._pos.x, this._pos.y, this._pos.z],
        yaw:       this._yaw,
        pitch:     this._pitch,
        crouching: this._crouchAmt > 0.5,
        weapon:    this._weapon,
      });
    }
  }

  get position() { return this._pos; }
  get health()   { return this._health; }
  get armor()    { return this._armor;  }
}
