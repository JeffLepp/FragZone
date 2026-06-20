import * as THREE from 'three';

// Bots are server-authoritative and shared by every player (the AI, movement,
// wave logic and damage all live in server/index.js). This class is a pure
// view: it builds the mesh, interpolates toward the server position, and
// exposes the same rayIntersect API RemotePlayer uses so LocalPlayer can pick
// which bot a shot hit. Hits/kills are reported to and resolved by the server.
const BOT_HP = 100;
const BOT_R  = 0.38;
const BOT_H  = 1.82;

export class Bot {
  constructor(scene, data) {
    this._scene = scene;
    this.id     = data.id;
    this.name   = data.name || 'BOT';
    this.alive  = data.alive !== false;

    this._pos       = new THREE.Vector3(data.pos[0], 0, data.pos[2]);
    this._targetPos = this._pos.clone();

    this._buildMesh();
    this._setHp(data.hp != null ? data.hp : BOT_HP);
    this._grp.visible   = this.alive;
    this._hpGrp.visible = this.alive;
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
    const box = new THREE.Box3(
      new THREE.Vector3(this._pos.x - BOT_R, 0,     this._pos.z - BOT_R),
      new THREE.Vector3(this._pos.x + BOT_R, BOT_H, this._pos.z + BOT_R)
    );
    const hit = new THREE.Vector3();
    return new THREE.Ray(origin, dir).intersectBox(box, hit)
      ? origin.distanceTo(hit)
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
      // Free GPU resources — each bot builds its own geometries/materials.
      grp.traverse(obj => {
        if (obj.isMesh) {
          obj.geometry.dispose();
          obj.material.dispose();
        }
      });
    }
  }
}
