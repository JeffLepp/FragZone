import * as THREE from 'three';

export const WALL_H    = 3.2;
export const FLOOR_Y   = 0;
// Ceiling sits well above the mid skyscraper so its rooftop deck is playable.
export const CEIL_Y    = 26;

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

// ── Mid skyscraper ────────────────────────────────────────────────────────────
// A hollow tower on the old mid-box footprint (walls at x ±5, z ±6). The E/W
// slabs span the full 13 m depth so the corners meet; the N/S walls butt
// against their inner faces and each carry a 2.4 m doorway at x = 0. Inside, a
// smooth ramp spirals 2.5 laps up the walls (21 m of rise over an 87 m run,
// floor at the SW corner to the NE corner) to a rooftop deck behind a 1 m
// parapet. The ramp is not an AABB: RAMPS below describes sloped slabs that
// player physics walks as surfaces (see player.js). Four gaps in the parapet
// open onto steep surf ramps (SURF_RAMPS) that end mid-air short of the floor.
// NOTE: mirrored by towerBoxes() in server/index.js — update both together.
export const TOWER_H    = 22;    // wall / parapet top
export const TOWER_TOP  = 21;    // rooftop deck walking surface
export const RAMP_THICK = 0.35;  // ramp slab thickness (surface down to underside)
const RAMP_W = 1.3;
const SURF_W = 3;                // surf ramp width

function towerDefs() {
  const wallC = 0x8E96A3, deckC = 0x5C6470;
  const defs  = [];
  const B = (cx, cy, cz, w, h, d, color = wallC) => defs.push({ cx, cy, cz, w, h, d, color });

  // Walls. Pieces that stop at TOWER_TOP leave gaps in the parapet above —
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

  // Rooftop deck (top at TOWER_TOP). Open above the final climb — the last
  // west- and north-wall steps need head clearance — with a landing bridging
  // the arrival in the NE corner.
  B( 0.65, TOWER_TOP - 0.2,    0.75, 7.7, 0.4,  9.5, deckC); // main deck
  B(-3.85, TOWER_TOP - 0.2,    2.0,  1.3, 0.4,  7.0, deckC); // west strip
  B( 3.5,  TOWER_TOP - 0.175, -4.75, 2,   0.35, 1.5, deckC); // NE landing
  return defs;
}

// The spiral ramp: axis-aligned sloped slabs, centerline inset RAMP_W/2 from
// the wall faces, rising at a constant grade (~24 %) from the floor at the SW
// corner to the deck at the NE corner — 2.5 laps, 10 segments.
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
// entries plus a surface normal — too steep to walk, so player physics rides
// them CS-surf style instead of grounding (the surf branch in player.js clips
// velocity along the plane). Each one is cut short of the floor: the bottom
// edge hangs at SURF_END, so riders launch off the end and fall the rest, and
// from the ground there is no tip to climb — the edge is out of jump reach
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
  surfRamp( 5.5,  3.75,  26,  3.75), // E — through the east parapet gap
  surfRamp(-5.5,  3.75, -26,  3.75), // W
  surfRamp( 3.5, -6.5,   3.5, -26),  // N — off the NE landing
  surfRamp( 0,    6.5,   0,    26),  // S — above the south doorway
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

  // Spiral ramp slabs. Sloped, so they live in RAMPS rather than WALL_DEFS;
  // pushed into `meshes` so bullets raycast them like any wall. Each slab is
  // stretched RAMP_W/2 past both ends so consecutive segments seal the corner.
  const rampMat = new THREE.MeshLambertMaterial({ color: 0x6E7480 });
  for (const r of RAMPS) {
    const geo  = new THREE.BoxGeometry(Math.hypot(r.len, r.y1 - r.y0) + RAMP_W, RAMP_THICK, RAMP_W);
    const mesh = new THREE.Mesh(geo, rampMat);
    mesh.position.set((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 - RAMP_THICK / 2, (r.z0 + r.z1) / 2);
    mesh.rotation.order = 'YZX';
    mesh.rotation.y = Math.atan2(-(r.z1 - r.z0), r.x1 - r.x0);
    mesh.rotation.z = Math.atan2(r.y1 - r.y0, r.len);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshes.push(mesh);
  }

  // Surf ramps: same slab treatment, but centered along the true surface
  // normal — at ~46° the plain vertical offset used above would sink the
  // visual surface several cm below the physics surface.
  const surfMat = new THREE.MeshLambertMaterial({ color: 0x4E86A0 });
  for (const r of SURF_RAMPS) {
    const geo  = new THREE.BoxGeometry(Math.hypot(r.len, r.y0 - r.y1), RAMP_THICK, SURF_W);
    const mesh = new THREE.Mesh(geo, surfMat);
    mesh.position.set(
      (r.x0 + r.x1) / 2 - r.nx * RAMP_THICK / 2,
      (r.y0 + r.y1) / 2 - r.ny * RAMP_THICK / 2,
      (r.z0 + r.z1) / 2 - r.nz * RAMP_THICK / 2,
    );
    mesh.rotation.order = 'YZX';
    mesh.rotation.y = Math.atan2(-(r.z1 - r.z0), r.x1 - r.x0);
    mesh.rotation.z = Math.atan2(r.y1 - r.y0, r.len);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshes.push(mesh);
  }

  addTowerDecor(scene);

  return meshes; // returned so player.js can raycast against them
}

// Skyscraper dressing: window panes on all four faces plus a parapet cap.
// Purely visual — kept out of WALL_DEFS (no collision) and out of the returned
// mesh list (bullets hit the wall 3 cm behind a pane anyway).
function addTowerDecor(scene) {
  const nsPane   = new THREE.BoxGeometry(1.1, 1.6, 0.06);
  const ewPane   = new THREE.BoxGeometry(0.06, 1.6, 1.1);
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x16202C, emissive: 0x0A141E });
  const litMat   = new THREE.MeshLambertMaterial({ color: 0xFFD588, emissive: 0x996F33 });
  // Deterministic "some lights are on" pattern — stable across reloads.
  const lit = seed => seed % 10 < 3;

  for (let row = 0; row < 6; row++) {
    const y = 4.6 + row * 2.8;
    [-3, -1, 1, 3].forEach((x, col) => {
      for (const zs of [-1, 1]) {
        const m = new THREE.Mesh(nsPane, lit(row * 7 + col * 3 + (zs > 0 ? 5 : 0)) ? litMat : glassMat);
        m.position.set(x, y, zs * 6.53);
        scene.add(m);
      }
    });
    [-4.5, -2.7, -0.9, 0.9, 2.7, 4.5].forEach((z, col) => {
      for (const xs of [-1, 1]) {
        const m = new THREE.Mesh(ewPane, lit(row * 5 + col * 7 + (xs > 0 ? 3 : 0)) ? litMat : glassMat);
        m.position.set(xs * 5.53, y, z);
        scene.add(m);
      }
    });
  }

  // Parapet cap: slightly proud ledge along the wall tops, broken where the
  // surf-ramp gaps open.
  const capMat = new THREE.MeshLambertMaterial({ color: 0x49505C });
  for (const [w, d, x, z] of [
    [1.4, 8.95, -5, -2.225], [1.4, 1.45, -5, 5.975],  // W (gap z 2.25–5.25)
    [1.4, 8.95,  5, -2.225], [1.4, 1.45,  5, 5.975],  // E
    [7.0, 1.4, -1.0, -6],                             // N (gap x 2.5–4.5)
    [3.3, 1.4, -2.85, 6], [3.3, 1.4, 2.85, 6],        // S (gap x ±1.2)
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, d), capMat);
    m.position.set(x, TOWER_H + 0.09, z);
    scene.add(m);
  }
}
