import * as THREE from 'three';

export const WALL_H    = 3.2;
export const FLOOR_Y   = 0;
// Ceiling sits well above the mid skyscraper so its rooftop deck is playable.
export const CEIL_Y    = 26;

// Wall / crate definitions.
// Each object: { cx, cy, cz, w, h, d, color }
// cx/cy/cz = center position; w/h/d = full dimensions.
const H = WALL_H;

function wall(cx, cz, w, d, color = 0x8C8374, h = H) {
  return { cx, cy: h / 2, cz, w, h, d, color };
}
function crate(cx, cz, w = 2, d = 2) {
  return { cx, cy: 0.75, cz, w, h: 1.5, d, color: 0x654A30 };
}

// ── Mid skyscraper ────────────────────────────────────────────────────────────
// A hollow tower on the old mid-box footprint (walls at x ±5, z ±6). The E/W
// slabs span the full 13 m depth so the corners meet; the N/S walls butt
// against their inner faces and each carry a 2.4 m doorway at x = 0. Inside, a
// smooth ramp spirals 2.5 laps up the walls (21 m of rise over an 87 m run,
// floor at the SW corner to the NE corner) to a rooftop deck behind a 1 m
// parapet. The ramp is not an AABB: RAMPS below describes sloped slabs that
// player physics walks as surfaces (see player.js). Four gaps in the parapet
// open onto steep surf ramps (SURF_RAMPS) that end mid-air short of the floor.
// NOTE: mirrored by towerBoxes() in server/index.js - update both together.
export const TOWER_H    = 22;    // wall / parapet top
export const TOWER_TOP  = 21;    // rooftop deck walking surface
export const RAMP_THICK = 0.35;  // ramp slab thickness (surface down to underside)
const RAMP_W = 1.3;
const SURF_W = 3;                // surf ramp width

function towerDefs() {
  const wallC = 0x737A82, deckC = 0x49515A;
  const defs  = [];
  const B = (cx, cy, cz, w, h, d, color = wallC) => defs.push({ cx, cy, cz, w, h, d, color });

  // Walls. Pieces that stop at TOWER_TOP leave gaps in the parapet above -
  // the rooftop exits onto the surf ramps (SURF_RAMPS below).
  for (const x of [-5, 5]) {
    B(x, TOWER_TOP / 2,   0,      1, TOWER_TOP, 13);   // up to deck level
    B(x, TOWER_TOP + 0.5, -2.125, 1, 1,         8.75); // parapet, gap z 2.25–5.25
    B(x, TOWER_TOP + 0.5,  5.875, 1, 1,         1.25);
  }
  // North wall: parapet gap above the NE landing (x 2.5–4.5)
  B(-2.85, TOWER_H / 2,     -6, 3.3, TOWER_H,   1);         // beside the door
  B( 2.85, TOWER_TOP / 2,   -6, 3.3, TOWER_TOP, 1);
  B( 1.85, TOWER_TOP + 0.5, -6, 1.3, 1,         1);
  B(0, (TOWER_H + 2.4) / 2, -6, 2.4, TOWER_H - 2.4, 1);     // above the door
  // South wall: parapet gap above the doorway (x ±1.2)
  B(-2.85, TOWER_H / 2, 6, 3.3, TOWER_H, 1);
  B( 2.85, TOWER_H / 2, 6, 3.3, TOWER_H, 1);
  B(0, (TOWER_TOP + 2.4) / 2, 6, 2.4, TOWER_TOP - 2.4, 1);

  // Rooftop deck (top at TOWER_TOP). Open above the final climb - the last
  // west- and north-wall steps need head clearance - with a landing bridging
  // the arrival in the NE corner.
  B( 0.65, TOWER_TOP - 0.2,    0.75, 7.7, 0.4,  9.5, deckC); // main deck
  B(-3.85, TOWER_TOP - 0.2,    2.0,  1.3, 0.4,  7.0, deckC); // west strip
  B( 3.5,  TOWER_TOP - 0.175, -4.75, 2,   0.35, 1.5, deckC); // NE landing
  return defs;
}

// The spiral ramp: axis-aligned sloped slabs, centerline inset RAMP_W/2 from
// the wall faces, rising at a constant grade (~24 %) from the floor at the SW
// corner to the deck at the NE corner - 2.5 laps, 10 segments.
function buildRamps() {
  const RX = 3.85, RZ = 4.85;
  const corners = [[-RX, RZ], [-RX, -RZ], [RX, -RZ], [RX, RZ]]; // SW NW NE SE
  const lap   = 2 * (2 * RX + 2 * RZ);
  const grade = TOWER_TOP / (2.5 * lap); // m of rise per m walked
  const ramps = [];
  let s = 0;
  for (let i = 0; i < 10; i++) {
    const [x0, z0] = corners[i % 4];
    const [x1, z1] = corners[(i + 1) % 4];
    const len = Math.hypot(x1 - x0, z1 - z0);
    ramps.push({
      x0, z0, x1, z1, len,
      ux: (x1 - x0) / len, uz: (z1 - z0) / len, // unit direction along the slope
      y0: s * grade, y1: (s + len) * grade,     // surface height at each end
      minX: Math.min(x0, x1) - RAMP_W / 2, maxX: Math.max(x0, x1) + RAMP_W / 2,
      minZ: Math.min(z0, z1) - RAMP_W / 2, maxZ: Math.max(z0, z1) + RAMP_W / 2,
    });
    s += len;
  }
  return ramps;
}
export const RAMPS = buildRamps();

// Surface height of a ramp segment at (x, z), clamped to the segment ends
// (so corner squares, covered by two segments, stay continuous).
export function rampHeightAt(r, x, z) {
  const t = Math.max(0, Math.min(1,
    ((x - r.x0) * r.ux + (z - r.z0) * r.uz) / r.len));
  return r.y0 + (r.y1 - r.y0) * t;
}

// ── Surf ramps ────────────────────────────────────────────────────────────────
// Four steep (~46°) slabs leaving the parapet gaps. Same shape as RAMPS
// entries plus a surface normal - too steep to walk, so player physics rides
// them CS-surf style instead of grounding (the surf branch in player.js clips
// velocity along the plane). Each one is cut short of the floor: the bottom
// edge hangs at SURF_END, so riders launch off the end and fall the rest, and
// from the ground there is no tip to climb - the edge is out of jump reach
// with full head clearance under it.
const SURF_END = 4;
function surfRamp(x0, z0, xf, zf) {
  // (xf, zf) is where the slope would meet the floor; the slab stops short
  // of it at SURF_END up.
  const full = Math.hypot(xf - x0, zf - z0);
  const ux   = (xf - x0) / full, uz = (zf - z0) / full;
  const len  = full * (TOWER_TOP - SURF_END) / TOWER_TOP;
  const x1   = x0 + ux * len, z1 = z0 + uz * len;
  const k    = Math.hypot(full, TOWER_TOP); // normal tilts toward the downhill end
  return {
    x0, z0, x1, z1, len, ux, uz,
    y0: TOWER_TOP, y1: SURF_END,
    nx: ux * TOWER_TOP / k, ny: full / k, nz: uz * TOWER_TOP / k,
    minX: Math.min(x0, x1) - (ux ? 0 : SURF_W / 2),
    maxX: Math.max(x0, x1) + (ux ? 0 : SURF_W / 2),
    minZ: Math.min(z0, z1) - (uz ? 0 : SURF_W / 2),
    maxZ: Math.max(z0, z1) + (uz ? 0 : SURF_W / 2),
  };
}
export const SURF_RAMPS = [
  surfRamp( 5.5,  3.75,  26,  3.75), // E - through the east parapet gap
  surfRamp(-5.5,  3.75, -26,  3.75), // W
  surfRamp( 3.5, -6.5,   3.5, -26),  // N - off the NE landing
  surfRamp( 0,    6.5,   0,    26),  // S - above the south doorway
];

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

  // ── Mid skyscraper ──
  ...towerDefs(),

  // ── Side barriers ──  (provide flanking cover)
  wall(-15,  0, 1, 18, 0x766C5B),
  wall( 15,  0, 1, 18, 0x766C5B),

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

const UNIT_BOX_GEO = new THREE.BoxGeometry(1, 1, 1);

function createInstances(scene, geometry, material, count, setMatrix, {
  name = 'static-instances',
  castShadow = false,
  receiveShadow = false,
} = {}) {
  const instances = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    setMatrix(i, matrix);
    instances.setMatrixAt(i, matrix);
  }
  instances.name = name;
  instances.castShadow = castShadow;
  instances.receiveShadow = receiveShadow;
  instances.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  instances.instanceMatrix.needsUpdate = true;
  instances.computeBoundingBox();
  instances.computeBoundingSphere();
  scene.add(instances);
  return instances;
}

function addFloorColors(geometry) {
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  const base = new THREE.Color(0x92775B);
  const color = new THREE.Color();

  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const variation = Math.sin(x * 0.43 + y * 0.61) * 0.045
      + Math.sin(x * 1.17 - y * 0.79) * 0.025;
    color.copy(base).multiplyScalar(1 + variation);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

export function createMap(scene) {
  // Floor
  const floorGeo = new THREE.PlaneGeometry(60, 60, 12, 12);
  addFloorColors(floorGeo);
  const floorMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const floor    = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling (back-side so we see it from below)
  const ceilGeo = new THREE.PlaneGeometry(60, 60);
  const ceilMat = new THREE.MeshLambertMaterial({ color: 0x77766F, side: THREE.BackSide });
  const ceil    = new THREE.Mesh(ceilGeo, ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = CEIL_Y;
  scene.add(ceil);

  // Walls & crates. Grouping identical materials into InstancedMeshes keeps
  // raycasting intact while collapsing dozens of static draw calls.
  const meshes = [];
  const wallsByColor = new Map();
  for (const def of WALL_DEFS) {
    if (!wallsByColor.has(def.color)) wallsByColor.set(def.color, []);
    wallsByColor.get(def.color).push(def);
  }
  for (const [color, defs] of wallsByColor) {
    const material = new THREE.MeshLambertMaterial({ color });
    const instances = createInstances(scene, UNIT_BOX_GEO, material, defs.length, (i, matrix) => {
      const def = defs[i];
      matrix.makeScale(def.w, def.h, def.d);
      matrix.setPosition(def.cx, def.cy, def.cz);
    }, {
      name: `walls-${color.toString(16)}`,
      castShadow: true,
      receiveShadow: true,
    });
    meshes.push(instances);
  }

  // Spiral ramp slabs. Sloped, so they live in RAMPS rather than WALL_DEFS;
  // pushed into `meshes` so bullets raycast them like any wall. Each slab is
  // stretched RAMP_W/2 past both ends so consecutive segments seal the corner.
  const rampMat = new THREE.MeshLambertMaterial({ color: 0x5F6670 });
  const rampEuler = new THREE.Euler(0, 0, 0, 'YZX');
  const rampQuat = new THREE.Quaternion();
  const rampPos = new THREE.Vector3();
  const rampScale = new THREE.Vector3();
  const rampInstances = createInstances(scene, UNIT_BOX_GEO, rampMat, RAMPS.length, (i, matrix) => {
    const r = RAMPS[i];
    rampPos.set((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 - RAMP_THICK / 2, (r.z0 + r.z1) / 2);
    rampEuler.set(0, Math.atan2(-(r.z1 - r.z0), r.x1 - r.x0), Math.atan2(r.y1 - r.y0, r.len), 'YZX');
    rampQuat.setFromEuler(rampEuler);
    rampScale.set(Math.hypot(r.len, r.y1 - r.y0) + RAMP_W, RAMP_THICK, RAMP_W);
    matrix.compose(rampPos, rampQuat, rampScale);
  }, { name: 'spiral-ramps', castShadow: true, receiveShadow: true });
  meshes.push(rampInstances);

  // Surf ramps: same slab treatment, but centered along the true surface
  // normal - at ~46° the plain vertical offset used above would sink the
  // visual surface several cm below the physics surface.
  const surfMat = new THREE.MeshLambertMaterial({ color: 0x3F6D7D });
  const surfEuler = new THREE.Euler(0, 0, 0, 'YZX');
  const surfQuat = new THREE.Quaternion();
  const surfPos = new THREE.Vector3();
  const surfScale = new THREE.Vector3();
  const surfInstances = createInstances(scene, UNIT_BOX_GEO, surfMat, SURF_RAMPS.length, (i, matrix) => {
    const r = SURF_RAMPS[i];
    surfPos.set(
      (r.x0 + r.x1) / 2 - r.nx * RAMP_THICK / 2,
      (r.y0 + r.y1) / 2 - r.ny * RAMP_THICK / 2,
      (r.z0 + r.z1) / 2 - r.nz * RAMP_THICK / 2,
    );
    surfEuler.set(0, Math.atan2(-(r.z1 - r.z0), r.x1 - r.x0), Math.atan2(r.y1 - r.y0, r.len), 'YZX');
    surfQuat.setFromEuler(surfEuler);
    surfScale.set(Math.hypot(r.len, r.y0 - r.y1), RAMP_THICK, SURF_W);
    matrix.compose(surfPos, surfQuat, surfScale);
  }, { name: 'surf-ramps', castShadow: true, receiveShadow: true });
  meshes.push(surfInstances);

  addTowerDecor(scene);

  return meshes; // returned so player.js can raycast against them
}

// Skyscraper dressing: window panes on all four faces plus a parapet cap.
// Purely visual - kept out of WALL_DEFS (no collision) and out of the returned
// mesh list (bullets hit the wall 3 cm behind a pane anyway).
function addTowerDecor(scene) {
  const nsPane   = new THREE.BoxGeometry(1.1, 1.6, 0.06);
  const ewPane   = new THREE.BoxGeometry(0.06, 1.6, 1.1);
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x111820, emissive: 0x070D12 });
  const litMat   = new THREE.MeshLambertMaterial({ color: 0xD6A95D, emissive: 0x6F4E20 });
  // Deterministic "some lights are on" pattern - stable across reloads.
  const lit = seed => seed % 10 < 3;
  const panes = { nsDark: [], nsLit: [], ewDark: [], ewLit: [] };

  for (let row = 0; row < 6; row++) {
    const y = 4.6 + row * 2.8;
    [-3, -1, 1, 3].forEach((x, col) => {
      for (const zs of [-1, 1]) {
        const key = lit(row * 7 + col * 3 + (zs > 0 ? 5 : 0)) ? 'nsLit' : 'nsDark';
        panes[key].push([x, y, zs * 6.53]);
      }
    });
    [-4.5, -2.7, -0.9, 0.9, 2.7, 4.5].forEach((z, col) => {
      for (const xs of [-1, 1]) {
        const key = lit(row * 5 + col * 7 + (xs > 0 ? 3 : 0)) ? 'ewLit' : 'ewDark';
        panes[key].push([xs * 5.53, y, z]);
      }
    });
  }

  for (const [key, positions] of Object.entries(panes)) {
    const geometry = key.startsWith('ns') ? nsPane : ewPane;
    const material = key.endsWith('Lit') ? litMat : glassMat;
    createInstances(scene, geometry, material, positions.length, (i, matrix) => {
      matrix.makeTranslation(...positions[i]);
    }, { name: `tower-${key}` });
  }

  // Parapet cap: slightly proud ledge along the wall tops, broken where the
  // surf-ramp gaps open.
  const capMat = new THREE.MeshLambertMaterial({ color: 0x3E464F });
  const caps = [
    [1.4, 8.95, -5, -2.225], [1.4, 1.45, -5, 5.975],  // W (gap z 2.25–5.25)
    [1.4, 8.95,  5, -2.225], [1.4, 1.45,  5, 5.975],  // E
    [7.0, 1.4, -1.0, -6],                             // N (gap x 2.5–4.5)
    [3.3, 1.4, -2.85, 6], [3.3, 1.4, 2.85, 6],        // S (gap x ±1.2)
  ];
  createInstances(scene, UNIT_BOX_GEO, capMat, caps.length, (i, matrix) => {
    const [w, d, x, z] = caps[i];
    matrix.makeScale(w, 0.18, d);
    matrix.setPosition(x, TOWER_H + 0.09, z);
  }, { name: 'tower-caps' });
}
