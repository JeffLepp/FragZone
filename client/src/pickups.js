import * as THREE from 'three';

// Renders server-driven health/ammo pickups: bobbing, spinning props that
// hide when taken and reappear when the server respawns them.
export class PickupManager {
  constructor(scene) {
    this._scene = scene;
    this._items = new Map(); // id -> { group, baseY, active }
    this._time  = 0;
  }

  setAll(list) {
    this.clear();
    list.forEach(p => {
      const group = this._buildMesh(p.kind);
      group.position.set(...p.pos);
      group.visible = p.active;
      this._scene.add(group);
      this._items.set(p.id, { group, baseY: p.pos[1], active: p.active });
    });
  }

  setActive(id, active) {
    const item = this._items.get(id);
    if (!item) return;
    item.active = active;
    item.group.visible = active;
  }

  update(dt) {
    this._time += dt;
    for (const item of this._items.values()) {
      if (!item.active) continue;
      item.group.position.y = item.baseY + Math.sin(this._time * 2.2) * 0.08;
      item.group.rotation.y = this._time * 1.4;
    }
  }

  clear() {
    for (const item of this._items.values()) {
      this._scene.remove(item.group);
      item.group.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    }
    this._items.clear();
  }

  _buildMesh(kind) {
    const group = new THREE.Group();

    if (kind === 'health') {
      // White medkit with a red cross
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.32, 0.5),
        new THREE.MeshLambertMaterial({ color: 0xF2F2F2, emissive: 0x222222 })
      );
      const crossMat = new THREE.MeshLambertMaterial({ color: 0xD42020, emissive: 0x330000 });
      const barA = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.12), crossMat);
      const barB = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.34), crossMat);
      group.add(box, barA, barB);
    } else {
      // Olive ammo crate with a brass band
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.3, 0.38),
        new THREE.MeshLambertMaterial({ color: 0x4E5A2E, emissive: 0x111408 })
      );
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.52, 0.1, 0.4),
        new THREE.MeshLambertMaterial({ color: 0xC8A032, emissive: 0x332200 })
      );
      group.add(box, band);
    }

    group.traverse(obj => {
      if (obj.isMesh) obj.castShadow = true;
    });
    return group;
  }
}
