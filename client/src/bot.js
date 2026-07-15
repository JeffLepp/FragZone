import * as THREE from 'three';

// Bots are server-authoritative and shared by every player (the AI, movement,
// wave logic and damage all live in server/index.js). This class is a pure
// view: it builds the mesh, interpolates toward the server position, and
// exposes the same rayIntersect API RemotePlayer uses so LocalPlayer can pick
// which bot a shot hit. Hits/kills are reported to and resolved by the server.
const BOT_HP = 100;
const BOT_R  = 0.38;
const BOT_H  = 1.82;
const BOT_BODY_GEO = new THREE.CylinderGeometry(BOT_R, BOT_R, 1.4, 10);
const BOT_HEAD_GEO = new THREE.SphereGeometry(0.24, 10, 7);
const BOT_HP_BG_GEO = new THREE.PlaneGeometry(0.76, 0.11);
const BOT_HP_FILL_GEO = new THREE.PlaneGeometry(0.7, 0.07);
const BOT_BODY_MAT = new THREE.MeshLambertMaterial({ color: 0x7D1717 });
const BOT_HEAD_MAT = new THREE.MeshLambertMaterial({ color: 0xB86E52 });
const BOT_HP_BG_MAT = new THREE.MeshBasicMaterial({ color: 0x181818, side: THREE.DoubleSide, depthTest: false });

export class Bot {
  constructor(scene, data) {
    this._scene = scene;
    this.id     = data.id;
    this.name   = data.name || 'BOT';
    this.alive  = data.alive !== false;

    this._pos       = new THREE.Vector3(data.pos[0], 0, data.pos[2]);
    this._targetPos = this._pos.clone();
    this._hitBox = new THREE.Box3();
    this._hitPoint = new THREE.Vector3();
    this._hitRay = new THREE.Ray();

    this._buildMesh();
    this._setHp(data.hp != null ? data.hp : BOT_HP);
    this._grp.visible   = this.alive;
    this._hpGrp.visible = this.alive;
  }

  _buildMesh() {
    this._grp = new THREE.Group();

    const body = new THREE.Mesh(
      BOT_BODY_GEO,
      BOT_BODY_MAT,
    );
    body.position.y = 0.7;
    body.castShadow = true;

    const head = new THREE.Mesh(
      BOT_HEAD_GEO,
      BOT_HEAD_MAT,
    );
    head.position.y = 1.56;
    head.castShadow = true;

    this._grp.add(body, head);
    this._grp.position.copy(this._pos);
    this._scene.add(this._grp);

    // Health bar — separate group so billboard lookAt doesn't fight body rotation
    const bgMesh = new THREE.Mesh(
      BOT_HP_BG_GEO,
      BOT_HP_BG_MAT,
    );
    this._hpMat = new THREE.MeshBasicMaterial({ color: 0x22CC44, side: THREE.DoubleSide, depthTest: false });
    this._hpFill = new THREE.Mesh(BOT_HP_FILL_GEO, this._hpMat);
    this._hpFill.position.z = 0.003;

    this._hpGrp = new THREE.Group();
    this._hpGrp.add(bgMesh, this._hpFill);
    this._scene.add(this._hpGrp);
  }

  _setHp(hp) {
    const pct = Math.max(0, Math.min(1, hp / BOT_HP));
    this._hpFill.scale.x    = Math.max(pct, 0.001);
    this._hpFill.position.x = (pct - 1) * 0.35; // anchor left edge
    this._hpMat.color.setHex(pct > 0.5 ? 0x22CC44 : pct > 0.25 ? 0xFFAA00 : 0xFF2222);
  }

  // Server snapshot → interpolation target + health bar.
  updateState(data) {
    this.alive = data.alive !== false;
    this._grp.visible   = this.alive;
    this._hpGrp.visible = this.alive;
    if (data.pos) this._targetPos.set(data.pos[0], 0, data.pos[2]);
    if (data.hp != null) this._setHp(data.hp);
  }

  // Same API as RemotePlayer so LocalPlayer._tryShoot works unchanged.
  rayIntersect(origin, dir) {
    if (!this.alive) return null;
    this._hitBox.min.set(this._pos.x - BOT_R, 0,     this._pos.z - BOT_R);
    this._hitBox.max.set(this._pos.x + BOT_R, BOT_H, this._pos.z + BOT_R);
    return this._hitRay.set(origin, dir).intersectBox(this._hitBox, this._hitPoint)
      ? origin.distanceTo(this._hitPoint)
      : null;
  }

  update(dt, camera) {
    if (!this.alive) return;
    // Smooth toward the latest server position (same lerp rate as RemotePlayer).
    this._pos.lerp(this._targetPos, Math.min(1, dt * 18));
    this._grp.position.set(this._pos.x, 0, this._pos.z);

    // Face the direction it's heading (toward the interpolation target).
    const dx = this._targetPos.x - this._pos.x;
    const dz = this._targetPos.z - this._pos.z;
    if (dx * dx + dz * dz > 1e-5) this._grp.rotation.y = Math.atan2(dx, dz);

    this._hpGrp.position.set(this._pos.x, 2.1, this._pos.z);
    if (camera) this._hpGrp.lookAt(camera.position);
  }

  dispose() {
    for (const grp of [this._grp, this._hpGrp]) {
      this._scene.remove(grp);
    }
    // Static bot geometry/materials are shared across every instance.
    this._hpMat.dispose();
  }
}
