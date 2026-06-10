import * as THREE from 'three';

export const WALL_H    = 3.2;
export const FLOOR_Y   = 0;
export const CEIL_Y    = WALL_H;

// Wall / crate definitions.
// Each object: { cx, cy, cz, w, h, d, color }
// cx/cy/cz = center position; w/h/d = full dimensions.
const H = WALL_H;

function wall(cx, cz, w, d, color = 0xA89070, h = H) {
  return { cx, cy: h / 2, cz, w, h, d, color };
}
function crate(cx, cz, w = 2, d = 2) {
  return { cx, cy: 0.75, cz, w, h: 1.5, d, color: 0x7A5830 };
}

export const WALL_DEFS = [
  // Outer boundary
  wall(0, -30, 62, 1),
  wall(0,  30, 62, 1),
  wall(-30,  0,  1, 62),
  wall( 30,  0,  1, 62),

  // ── NW bunker (CT left) ──
  wall(-24, -22, 1, 8),   // west arm
  wall(-20, -18, 8, 1),   // south arm
  // ── NE bunker (CT right) ──
  wall( 24, -22, 1, 8),
  wall( 20, -18, 8, 1),

  // ── SW bunker (T left) ──
  wall(-24,  22, 1, 8),
  wall(-20,  18, 8, 1),
  // ── SE bunker (T right) ──
  wall( 24,  22, 1, 8),
  wall( 20,  18, 8, 1),

  // ── Mid box ──  (open-topped 4-wall box with gaps on E/W sides)
  wall(-5,  0, 1, 12),   // west wall (full)
  wall( 5,  0, 1, 12),   // east wall (full)
  wall( 0, -6, 8, 1),    // north wall
  wall( 0,  6, 8, 1),    // south wall

  // ── Side barriers ──  (provide flanking cover)
  wall(-15,  0, 1, 18, 0x9C8B6E),
  wall( 15,  0, 1, 18, 0x9C8B6E),

  // ── Cover crates ──
  crate( -9, -12),
  crate(  9, -12),
  crate( -9,  12),
  crate(  9,  12),
  crate(  0, -20),
  crate(  0,  20),
  crate(-22,   0, 2, 4),
  crate( 22,   0, 2, 4),
  crate( -9,   0),
  crate(  9,   0),
  crate(-14, -16),
  crate( 14, -16),
  crate(-14,  16),
  crate( 14,  16),
];

// AABB collision boxes derived from wall definitions.
// These are used for both player movement collision and bullet-wall intersection.
export const COLLISION_BOXES = WALL_DEFS.map(({ cx, cy, cz, w, h, d }) => ({
  minX: cx - w / 2,  maxX: cx + w / 2,
  minY: cy - h / 2,  maxY: cy + h / 2,
  minZ: cz - d / 2,  maxZ: cz + d / 2,
}));

export const MAP_BOUNDS = { minX: -29.4, maxX: 29.4, minZ: -29.4, maxZ: 29.4 };

export const SPAWN_POINTS = [
  [-25, 0, -25],
  [ 25, 0, -25],
  [-25, 0,  25],
  [ 25, 0,  25],
  [-18, 0,   0],
  [ 18, 0,   0],
  [  0, 0, -22],
  [  0, 0,  22],
];

// ---------------------------------------------------------------------------
// Scene geometry
// ---------------------------------------------------------------------------

export function createMap(scene) {
  // Floor
  const floorGeo = new THREE.PlaneGeometry(60, 60, 12, 12);
  const floorMat = new THREE.MeshLambertMaterial({ color: 0xC8A882 });
  const floor    = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling (back-side so we see it from below)
  const ceilGeo = new THREE.PlaneGeometry(60, 60);
  const ceilMat = new THREE.MeshLambertMaterial({ color: 0xB0A080, side: THREE.BackSide });
  const ceil    = new THREE.Mesh(ceilGeo, ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = CEIL_Y;
  scene.add(ceil);

  // Walls & crates
  const meshes = [];
  for (const def of WALL_DEFS) {
    const geo  = new THREE.BoxGeometry(def.w, def.h, def.d);
    const mat  = new THREE.MeshLambertMaterial({ color: def.color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(def.cx, def.cy, def.cz);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshes.push(mesh);
  }

  return meshes; // returned so player.js can raycast against them
}
