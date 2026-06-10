import * as THREE from 'three';
import { COLLISION_BOXES, MAP_BOUNDS } from './map.js';

const CHASE_SPEED    = 3.2;
const STOP_DIST      = 5.5;   // metres — stop and hold when this close
const SHOOT_RANGE    = 24;
const SHOOT_INTERVAL = 1.0;   // seconds between shot attempts
const ACCURACY       = 0.48;  // probability of dealing damage per attempt (no LOS block)
const BOT_DAMAGE     = 10;
const BOT_HP         = 100;
const BOT_R          = 0.38;
const BOT_H          = 1.82;

let _botCount = 0;

export class Bot {
  constructor(scene, spawnPos, wallMeshes) {
    this._scene      = scene;
    this._wallMeshes = wallMeshes;
    this._pos        = new THREE.Vector3(spawnPos[0], 0, spawnPos[2]);
    this._hp         = BOT_HP;
    this.alive       = true;
    this.name        = `BOT${++_botCount}`;
    this._shootCd    = 0.4 + Math.random() * 0.6;

    this._buildMesh();
  }

  _buildMesh() {
    this._grp = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(BOT_R, BOT_R, 1.4, 10),
      new THREE.MeshLambertMaterial({ color: 0x8B0000 })
    );
    body.position.y = 0.7;
    body.castShadow = true;

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 10, 7),
      new THREE.MeshLambertMaterial({ color: 0xCC7755 })
    );
    head.position.y = 1.56;
    head.castShadow = true;

    this._grp.add(body, head);
    this._grp.position.copy(this._pos);
    this._scene.add(this._grp);

    // Health bar — separate group so billboard lookAt doesn't fight body rotation
    const bgMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.76, 0.11),
      new THREE.MeshBasicMaterial({ color: 0x222222, side: THREE.DoubleSide, depthTest: false })
    );
    this._hpMat = new THREE.MeshBasicMaterial({ color: 0x22CC44, side: THREE.DoubleSide, depthTest: false });
    this._hpFill = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.07), this._hpMat);
    this._hpFill.position.z = 0.003;

    this._hpGrp = new THREE.Group();
    this._hpGrp.add(bgMesh, this._hpFill);
    this._scene.add(this._hpGrp);
  }

  // Same API as RemotePlayer so LocalPlayer._tryShoot works unchanged
  rayIntersect(origin, dir) {
    if (!this.alive) return null;
    const box = new THREE.Box3(
      new THREE.Vector3(this._pos.x - BOT_R, 0,     this._pos.z - BOT_R),
      new THREE.Vector3(this._pos.x + BOT_R, BOT_H, this._pos.z + BOT_R)
    );
    const hit = new THREE.Vector3();
    return new THREE.Ray(origin, dir).intersectBox(box, hit)
      ? origin.distanceTo(hit)
      : null;
  }

  takeDamage(amount) {
    if (!this.alive) return;
    this._hp = Math.max(0, this._hp - amount);
    const pct = this._hp / BOT_HP;
    this._hpFill.scale.x = Math.max(pct, 0.001);
    this._hpFill.position.x = (pct - 1) * 0.35; // anchor left edge
    this._hpMat.color.setHex(pct > 0.5 ? 0x22CC44 : pct > 0.25 ? 0xFFAA00 : 0xFF2222);
    if (this._hp <= 0) this._die();
  }

  _die() {
    this.alive = false;
    this._scene.remove(this._grp);
    this._scene.remove(this._hpGrp);
  }

  dispose() {
    this._scene.remove(this._grp);
    this._scene.remove(this._hpGrp);
  }

  // playerPos = camera position (eye height), camera = THREE.Camera for billboard
  update(dt, playerPos, playerAlive, camera, onHitPlayer) {
    if (!this.alive) return;

    const dx   = playerPos.x - this._pos.x;
    const dz   = playerPos.z - this._pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > STOP_DIST) {
      this._slide(dx / dist * CHASE_SPEED * dt, dz / dist * CHASE_SPEED * dt);
    }

    this._grp.position.set(this._pos.x, 0, this._pos.z);
    this._grp.rotation.y = Math.atan2(dx, dz);

    this._hpGrp.position.set(this._pos.x, 2.1, this._pos.z);
    this._hpGrp.lookAt(camera.position);

    this._shootCd -= dt;
    if (this._shootCd <= 0 && dist < SHOOT_RANGE && playerAlive) {
      this._shootCd = SHOOT_INTERVAL * (0.8 + Math.random() * 0.4);
      this._tryShotAt(playerPos, dist, onHitPlayer);
    }
  }

  _tryShotAt(playerPos, dist, onHitPlayer) {
    const eye = new THREE.Vector3(this._pos.x, 1.4, this._pos.z);
    const dir = new THREE.Vector3().subVectors(playerPos, eye).normalize();
    const rc  = new THREE.Raycaster(eye, dir, 0, dist);
    if (rc.intersectObjects(this._wallMeshes, false).length > 0) return;
    if (Math.random() < ACCURACY) onHitPlayer(BOT_DAMAGE);
  }

  _slide(dx, dz) {
    const testX = this._pos.x + dx;
    if (!this._blocked(testX, this._pos.z)) this._pos.x = testX;
    const testZ = this._pos.z + dz;
    if (!this._blocked(this._pos.x, testZ)) this._pos.z = testZ;
    this._pos.x = Math.max(MAP_BOUNDS.minX + BOT_R, Math.min(MAP_BOUNDS.maxX - BOT_R, this._pos.x));
    this._pos.z = Math.max(MAP_BOUNDS.minZ + BOT_R, Math.min(MAP_BOUNDS.maxZ - BOT_R, this._pos.z));
  }

  _blocked(x, z) {
    for (const b of COLLISION_BOXES) {
      if (x + BOT_R > b.minX && x - BOT_R < b.maxX &&
          BOT_H     > b.minY && 0         < b.maxY &&
          z + BOT_R > b.minZ && z - BOT_R < b.maxZ) return true;
    }
    return false;
  }
}
