import * as THREE from 'three';

// Player colours cycling (we pick one per player ID)
const PLAYER_COLORS = [0xe05050, 0x50a0e0, 0x50e080, 0xe0c050, 0xc050e0, 0xe08050, 0x50e0e0];
let colorIdx = 0;
const colorMap = new Map();
const PLAYER_BODY_GEO = new THREE.CylinderGeometry(0.35, 0.35, 1.2, 10);
const PLAYER_HEAD_GEO = new THREE.SphereGeometry(0.22, 10, 8);

function colorFor(id) {
  if (!colorMap.has(id)) colorMap.set(id, PLAYER_COLORS[colorIdx++ % PLAYER_COLORS.length]);
  return colorMap.get(id);
}

export class RemotePlayer {
  constructor(scene, data) {
    this._scene = scene;
    this.id     = data.id;
    this.name   = data.name || 'Player';
    this.alive  = data.alive !== false;

    // Build mesh group (body + head)
    const color  = colorFor(data.id);
    const group  = new THREE.Group();

    // Body (cylinder)
    const mat     = new THREE.MeshLambertMaterial({ color });
    this._bodyMaterial = mat;
    const body    = new THREE.Mesh(PLAYER_BODY_GEO, mat);
    body.position.y = 0.6;
    body.castShadow = true;
    group.add(body);

    // Head (sphere)
    const head    = new THREE.Mesh(PLAYER_HEAD_GEO, mat);
    head.position.y = 1.55;
    head.castShadow = true;
    group.add(head);

    // Name tag (canvas texture)
    this._nameTag = this._makeNameTag(data.name, color);
    this._nameTag.position.y = 2.2;
    group.add(this._nameTag);

    this._group = group;
    scene.add(group);

    // Interpolation state
    this._targetPos = data.pos ? new THREE.Vector3(...data.pos) : new THREE.Vector3();
    this._pos       = this._targetPos.clone();
    this._hitBox    = new THREE.Box3();
    this._hitPoint  = new THREE.Vector3();
    this._hitRay    = new THREE.Ray();
    this._targetYaw = data.yaw || 0;
    this._yaw       = this._targetYaw;

    this._group.position.copy(this._pos);
    this._group.visible = this.alive;
  }

  _makeNameTag(name, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx    = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = 'bold 28px monospace';
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.slice(0, 12), 128, 32);

    const tex  = new THREE.CanvasTexture(canvas);
    const mat  = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.6, 0.4, 1);
    return sprite;
  }

  updateState(data) {
    this.alive = data.alive !== false;
    this._group.visible = this.alive;
    if (!this.alive) return;

    if (data.pos) this._targetPos.set(...data.pos);
    if (data.yaw !== undefined) this._targetYaw = data.yaw;
  }

  // Simple box hit-detection for client-side bullet tracing.
  // Returns distance or null.
  rayIntersect(origin, dir) {
    if (!this.alive) return null;
    const p = this._pos;
    this._hitBox.min.set(p.x - 0.4, p.y,        p.z - 0.4);
    this._hitBox.max.set(p.x + 0.4, p.y + 1.85, p.z + 0.4);
    const hit = this._hitRay.set(origin, dir).intersectBox(this._hitBox, this._hitPoint);
    if (!hit) return null;
    return origin.distanceTo(this._hitPoint);
  }

  update(dt, cameraPos) {
    if (!this.alive) return;
    // Smooth position interpolation
    this._pos.lerp(this._targetPos, Math.min(1, dt * 18));
    this._yaw += ((this._targetYaw - this._yaw + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 18);
    this._group.position.copy(this._pos);
    this._group.rotation.y = this._yaw;

    // Name tag always faces camera
    if (cameraPos) this._nameTag.lookAt(cameraPos);
  }

  dispose() {
    this._scene.remove(this._group);
    // Body/head geometry is shared; player color and name tag stay per-player.
    this._bodyMaterial.dispose();
    this._nameTag.material.map.dispose();
    this._nameTag.material.dispose();
    colorMap.delete(this.id);
  }
}
