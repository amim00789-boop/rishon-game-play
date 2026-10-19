// A parked airliner on the dunes north of Derech HaHatzlacha (Adir's request, 2026-10-18).
// Walk up the airstairs, through the front-left door and into the cabin, where Gal the flight
// attendant waits by the galley (data/quests/act_gal.json). Parody airline name, no logo.
// While the player is inside, the cabin roof hides so the chase camera can see in.
//
// Local frame: nose toward +x, left side (door, stairs) toward -z, cabin floor at y = 0.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { project } from '../geo.js';
import { toonMat } from '../engine/renderer.js';
import { groundAt } from './terrain.js';
import { t } from '../i18n.js';

export const PLANE = { lat: 31.97125, lon: 34.75466, yaw: 0.35 };

const R = 5.6;                 // fuselage radius
const CY = 2.6;                // fuselage axis above the cabin floor
const X0 = -30, X1 = 30;       // straight barrel; tail cone behind X0, nose ahead of X1
const HALF = 4.6;              // walkable half-width of the cabin
const SPLIT = 1.5;             // roof / lower split, above the axis (just over the windows)
const DOOR = { x: 20, w: 2.6, top: 5.6 };
const STAIRS = { w: 1.9, top: 6.6, run: 14 };
const SEAT_ROWS = { from: -27, to: 13, pitch: 3 };

const A_SPLIT = Math.asin(SPLIT / R);
const A_FLOOR = Math.asin(CY / R);
const A_DOOR = Math.asin((DOOR.top - CY) / R);

const WHITE = 0xf7f7f2, NAVY = 0x1f2f55, TEAL = 0x2ec4b6, GREY = 0x9aa3ad, DARK = 0x22252b;

// Open barrel from x0 to x1 over the angle range [t0, t0 + tl]; angle PI/2 is the top, PI the left.
function barrel(x0, x1, t0, tl, r = R) {
  const g = new THREE.CylinderGeometry(r, r, x1 - x0, 48, 1, true, t0, tl);
  g.rotateZ(Math.PI / 2);
  g.translate((x0 + x1) / 2, CY, 0);
  return g;
}

// A bulkhead disc cut at the roof line: the part below (lower) or above it.
function bulkhead(x, upper) {
  const s = new THREE.Shape();
  if (upper) s.absarc(0, 0, R, A_SPLIT, Math.PI - A_SPLIT, false);
  else s.absarc(0, 0, R, Math.PI - A_SPLIT, 2 * Math.PI + A_SPLIT, false);
  s.closePath();
  const g = new THREE.ShapeGeometry(s, 24);
  g.rotateY(Math.PI / 2);
  g.translate(x, CY, 0);
  return g;
}

// Flat planform (x, z) points, extruded `thick` downward from y = 0.
function slab(points, thick) {
  const s = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  return g;
}

function liveryTexture(text) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1f2f55';
  ctx.font = '900 92px Rubik, Heebo, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction = 'rtl';
  ctx.fillText(text, 512, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildAirplane(scene) {
  const c = project(PLANE.lat, PLANE.lon);
  const cos = Math.cos(PLANE.yaw), sin = Math.sin(PLANE.yaw);
  const toWorld = (lx, lz) => [c.x + lx * cos + lz * sin, c.z - lx * sin + lz * cos];
  const toLocal = (x, z) => { const dx = x - c.x, dz = z - c.z; return [dx * cos - dz * sin, dx * sin + dz * cos]; };
  const groundLocal = (lx, lz) => { const [x, z] = toWorld(lx, lz); return groundAt(x, z); };

  // Floor high enough that the engines clear the highest sand under the plane.
  let top = -Infinity;
  for (let lx = -44; lx <= 40; lx += 4) for (let lz = -32; lz <= 32; lz += 4) top = Math.max(top, groundLocal(lx, lz));
  const floorY = top + 5.6;

  const root = new THREE.Group();
  root.name = 'airplane';
  const lower = new THREE.Group(), roof = new THREE.Group();
  root.add(lower, roof);

  const white = toonMat(WHITE, { side: THREE.DoubleSide });
  const navy = toonMat(NAVY, { side: THREE.DoubleSide });
  const teal = toonMat(TEAL);
  const grey = toonMat(GREY);
  const dark = toonMat(DARK);
  const add = (parent, geo, mat, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow; m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // ---- fuselage: rear, door and front sections, each a lower shell and a roof shell ----
  const dx0 = DOOR.x - DOOR.w, dx1 = DOOR.x + DOOR.w;
  const lowerFull = [Math.PI - A_SPLIT, Math.PI + 2 * A_SPLIT];
  const roofFull = [A_SPLIT, Math.PI - 2 * A_SPLIT];
  add(lower, mergeGeometries([
    barrel(X0, dx0, ...lowerFull),
    barrel(dx1, X1, ...lowerFull),
    barrel(dx0, dx1, Math.PI + A_FLOOR, Math.PI + A_SPLIT - A_FLOOR),
    bulkhead(X0, false),
    bulkhead(X1, false),
  ]), white);
  add(roof, mergeGeometries([
    barrel(X0, dx0, ...roofFull),
    barrel(dx1, X1, ...roofFull),
    barrel(dx0, dx1, A_SPLIT, Math.PI - A_DOOR - A_SPLIT),
    bulkhead(X0, true),
    bulkhead(X1, true),
  ]), white);
  // teal cheatline under the windows (cut at the door) and a navy belly
  const band = [Math.PI + 0.1, 0.11], bandR = [-0.21, 0.11];
  add(lower, mergeGeometries([
    barrel(X0, dx0, ...band, R + 0.03), barrel(dx1, X1, ...band, R + 0.03), barrel(X0, X1, ...bandR, R + 0.03),
  ]), teal, false);
  add(lower, barrel(X0, X1, 1.5 * Math.PI - 0.7, 1.4, R + 0.02), navy, false);

  // nose: a rounded cone with a dark cockpit band
  const noseProfile = [];
  for (let i = 0; i <= 12; i++) { const f = i / 12; noseProfile.push(new THREE.Vector2(R * Math.sqrt(Math.max(0, 1 - f * f)) + (i === 12 ? 0 : 0.001), f * 10)); }
  const nose = new THREE.LatheGeometry(noseProfile.reverse().map((v) => new THREE.Vector2(v.x, v.y)), 40);
  nose.rotateZ(-Math.PI / 2);
  nose.translate(X1, CY, 0);
  add(lower, nose, white);
  const cockpit = add(lower, new THREE.BoxGeometry(2.6, 1.0, 7.2), dark, false);
  cockpit.position.set(X1 + 4.6, CY + 2.9, 0);
  cockpit.rotation.z = -0.55;

  // tail cone: narrows and lifts toward the fin
  const tailProfile = [];
  for (let i = 0; i <= 10; i++) { const f = i / 10; tailProfile.push(new THREE.Vector2(R * (1 - 0.8 * f), f * 14)); }
  const tail = new THREE.LatheGeometry(tailProfile, 40);
  tail.rotateZ(Math.PI / 2);
  const tp = tail.attributes.position;
  for (let i = 0; i < tp.count; i++) tp.setY(i, tp.getY(i) + 0.22 * -tp.getX(i));
  tail.computeVertexNormals();
  tail.translate(X0, CY, 0);
  add(lower, tail, white);

  // fin and tailplanes
  const fin = slab([[-44.5, 0], [-33, 0], [-41, 12], [-46.5, 12]], 0.7);
  fin.rotateX(-Math.PI / 2);
  fin.translate(0, CY + 2.4, -0.35);
  add(lower, fin, navy);
  const finStripe = add(lower, new THREE.BoxGeometry(5.6, 1.2, 0.8), teal, false);
  finStripe.position.set(-41.4, CY + 9.2, 0);
  finStripe.rotation.z = -0.55;
  const tailplane = (s) => slab([[-37, 0], [-41.5, 11 * s], [-44.5, 11 * s], [-44, 0]], 0.5);
  for (const s of [1, -1]) { const g = tailplane(s); g.translate(0, CY + 3.2, 0); add(lower, g, white); }

  // wings with a little dihedral, engines under them
  const wingY = CY - 3.1;
  const wingPlan = (s) => [[8, 4.2 * s], [-6, 4.2 * s], [-15, 32 * s], [-10, 32 * s]];
  for (const s of [1, -1]) {
    const g = slab(wingPlan(s), 0.8);
    g.rotateX(-0.07 * s);
    g.translate(0, wingY, 0);
    add(lower, g, white);
    const eng = new THREE.CylinderGeometry(1.7, 1.5, 6.5, 24);
    eng.rotateZ(Math.PI / 2);
    eng.translate(1.5, wingY - 2.2, 12 * s);
    add(lower, eng, grey);
    const intake = new THREE.CircleGeometry(1.45, 24);
    intake.rotateY(Math.PI / 2);
    intake.translate(4.8, wingY - 2.2, 12 * s);
    add(lower, intake, dark, false);
    const pylon = new THREE.BoxGeometry(4, 1.4, 0.5);
    pylon.translate(0.5, wingY - 0.8, 12 * s);
    add(lower, pylon, grey);
  }

  // landing gear down to the sand
  const strut = (lx, lz, fromY) => {
    const toY = groundLocal(lx, lz) - floorY;
    const h = fromY - toY;
    if (h <= 0.2) return;
    const s = new THREE.CylinderGeometry(0.3, 0.3, h, 10);
    s.translate(lx, toY + h / 2, lz);
    add(lower, s, grey);
    const w = new THREE.CylinderGeometry(0.9, 0.9, 0.7, 16);
    w.rotateX(Math.PI / 2);
    for (const dz of [-0.55, 0.55]) { const g = w.clone(); g.translate(lx, toY + 0.9, lz + dz); add(lower, g, dark); }
  };
  strut(26, 0, CY - R + 0.4);
  for (const s of [1, -1]) strut(-2, 3.6 * s, wingY);

  // windows along both sides (cut at the door)
  const winGeo = new THREE.BoxGeometry(0.9, 1.15, 0.3);
  const winY = CY + 0.45, winZ = Math.sqrt(R * R - 0.45 * 0.45);
  const wins = [];
  for (let x = X0 + 2; x <= X1 - 2; x += 2.6) for (const s of [1, -1]) if (s > 0 || Math.abs(x - DOOR.x) > DOOR.w + 0.7) wins.push([x, s]);
  const winMesh = new THREE.InstancedMesh(winGeo, dark, wins.length);
  const m4 = new THREE.Matrix4();
  wins.forEach(([x, s], i) => winMesh.setMatrixAt(i, m4.makeTranslation(x, winY, winZ * s)));
  lower.add(winMesh);

  // the parody airline's name above the windows, on both sides
  const livery = new THREE.MeshBasicMaterial({ map: liveryTexture(t('sign.arkia_livery', {}, 'ARKIA')), transparent: true, depthWrite: false });
  for (const s of [1, -1]) {
    const y = CY + 2.6, z = Math.sqrt(R * R - 2.6 * 2.6) + 0.08;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(20, 2.5), livery);
    p.position.set(4, y, z * s);
    p.lookAt(4, y + 2.6, z * s + z * s);
    roof.add(p);
  }

  // ---- inside: carpet, two-and-two seat rows, a galley by the door ----
  const floor = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0, 0.3, 2 * Math.sqrt(R * R - CY * CY)), toonMat(0x4a5a78));
  floor.position.set((X0 + X1) / 2, -0.15, 0);
  floor.receiveShadow = true;
  lower.add(floor);
  const aisle = new THREE.Mesh(new THREE.BoxGeometry(X1 - X0 - 1, 0.02, 2.4), toonMat(0x7a2f3a));
  aisle.position.set((X0 + X1) / 2, 0.02, 0);
  lower.add(aisle);
  const cushion = new THREE.BoxGeometry(1.5, 0.45, 1.45).translate(0, 1.1, 0);
  const back = new THREE.BoxGeometry(0.35, 2.3, 1.45).translate(-0.62, 2.0, 0);
  const head = new THREE.BoxGeometry(0.4, 0.55, 1.2).translate(-0.6, 3.25, 0);
  const legs = new THREE.BoxGeometry(0.9, 0.9, 1.1).translate(0, 0.45, 0);
  const seatGeo = mergeGeometries([cushion, back, legs]);
  const seats = [];
  for (let x = SEAT_ROWS.from; x <= SEAT_ROWS.to; x += SEAT_ROWS.pitch) for (const z of [2.15, 3.7, -2.15, -3.7]) seats.push([x, z]);
  const seatMesh = new THREE.InstancedMesh(seatGeo, toonMat(0x2f6fb8), seats.length);
  const headMesh = new THREE.InstancedMesh(head, toonMat(0xf2efe6), seats.length);
  seats.forEach(([x, z], i) => { m4.makeTranslation(x, 0, z); seatMesh.setMatrixAt(i, m4); headMesh.setMatrixAt(i, m4); });
  seatMesh.castShadow = true;
  lower.add(seatMesh, headMesh);
  // galley cabinets against the cockpit wall, and a drinks trolley
  const galley = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.4, 7.6), toonMat(0xd8dde3));
  galley.position.set(X1 - 1.3, 1.7, 0);
  lower.add(galley);
  const trolley = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.0, 1.0), toonMat(0xc9ced6));
  trolley.position.set(DOOR.x + 4, 1.0, 3.2);
  lower.add(trolley);

  // ---- the open door and the airstairs truck ----
  const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(2 * DOOR.w, DOOR.top, 0.3), white);
  doorPanel.position.set(dx1 + 0.2, DOOR.top / 2, -R - 0.9);
  doorPanel.rotation.y = -1.2;
  lower.add(doorPanel);
  const footY = groundLocal(DOOR.x, -(STAIRS.top + STAIRS.run)) - floorY;
  const stairMat = toonMat(0xe0e3e8);
  const steps = Math.max(4, Math.round(-footY / 0.5));
  const stairGeos = [];
  for (let i = 0; i < steps; i++) {
    const f = (i + 0.5) / steps;
    const g = new THREE.BoxGeometry(2 * STAIRS.w, 0.25, STAIRS.run / steps + 0.05);
    g.translate(DOOR.x, footY * f, -STAIRS.top - STAIRS.run * f);
    stairGeos.push(g);
  }
  const platform = new THREE.BoxGeometry(2 * STAIRS.w, 0.3, STAIRS.top - HALF);
  platform.translate(DOOR.x, -0.15, -(STAIRS.top + HALF) / 2);
  stairGeos.push(platform);
  add(lower, mergeGeometries(stairGeos), stairMat);
  const rise = -footY, slope = Math.atan2(rise, STAIRS.run), len = Math.hypot(rise, STAIRS.run);
  for (const s of [1, -1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, len), toonMat(0xffcb3d));
    rail.position.set(DOOR.x + s * STAIRS.w, footY / 2 + 2.2, -STAIRS.top - STAIRS.run / 2);
    rail.rotation.x = -slope;
    lower.add(rail);
  }
  const truck = new THREE.Mesh(new THREE.BoxGeometry(2 * STAIRS.w + 1.2, 2.2, STAIRS.run * 0.8), toonMat(0xffcb3d));
  truck.position.set(DOOR.x, footY + 1.2, -STAIRS.top - STAIRS.run * 0.55);
  lower.add(truck);

  root.position.set(c.x, floorY, c.z);
  root.rotation.y = PLANE.yaw;
  scene.add(root);

  // ---- colliders (world polygons) ----
  const rect = (x0, x1, z0, z1) => ({ points: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => toWorld(x, z)) });
  const poly = (pts) => ({ points: pts.map(([x, z]) => toWorld(x, z)) });
  const lastRow = SEAT_ROWS.to + 1;
  // Cabin walls and seats carry their top, so the camera may look in over them once the roof hides.
  const low = (c) => ({ ...c, height: floorY + CY + SPLIT });
  const colliders = [
    low(rect(X0 - 1, dx0, -R - 0.6, -HALF)), low(rect(dx1, X1 + 1, -R - 0.6, -HALF)), // left wall around the door
    low(rect(X0 - 1, X1 + 1, HALF, R + 0.6)),                                         // right wall
    rect(X0 - 15, X0, -R - 0.6, R + 0.6),                                              // tail
    rect(X1 - 2.4, X1 + 10, -R - 0.6, R + 0.6),                                        // galley + nose
    low(rect(SEAT_ROWS.from - 1, lastRow, 1.35, HALF)), low(rect(SEAT_ROWS.from - 1, lastRow, -HALF, -1.35)), // seat blocks
    poly(wingPlan(1)), poly(wingPlan(-1)),
    rect(DOOR.x - STAIRS.w - 0.5, DOOR.x - STAIRS.w, -STAIRS.top - STAIRS.run, -R - 0.6), // stair rails
    rect(DOOR.x + STAIRS.w, DOOR.x + STAIRS.w + 0.5, -STAIRS.top - STAIRS.run, -R - 0.6),
  ];

  // ---- walkable height: cabin floor and the stairs ----
  const footG = floorY + footY;
  function surfaceAt(x, z) {
    const [lx, lz] = toLocal(x, z);
    if (lx > X0 && lx < X1 && Math.abs(lz) <= HALF + 0.2) return floorY;
    if (Math.abs(lx - DOOR.x) <= STAIRS.w + 0.1 && lz <= -HALF && lz >= -STAIRS.top - STAIRS.run) {
      if (lz >= -STAIRS.top) return floorY;
      const f = (-lz - STAIRS.top) / STAIRS.run;
      return floorY + (footG - floorY) * f;
    }
    return null;
  }

  // Gal's spot: in the aisle just aft of the door, facing it.
  const [gx, gz] = toWorld(DOOR.x - 2.5, 0);
  const pois = [{ id: 'arkia_plane', name: 'arkia_plane', x: gx, z: gz }];

  function update(pos) {
    if (!pos) return;
    const [lx, lz] = toLocal(pos.x, pos.z);
    roof.visible = !(lx > X0 - 2 && lx < X1 + 2 && Math.abs(lz) < R + 0.5);
  }

  return { group: root, colliders, pois, surfaceAt, update, floorY };
}
