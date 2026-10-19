// Rishon LeZion airfield (ICAO LLRS) behind Neot Ashlim, and a small private single-engine plane
// that flies a circuit from it about every three minutes (round 7, task B).
//
// Geometry from OpenStreetMap (api.openstreetmap.org map call, 2026-10-18; Overpass was down):
// runway way 60220921 (18/36, asphalt, 9 m wide, 648 m between its OSM ends), hangar 185558486 and
// taxiways 185558488, 371812414, 371812415, 414240938, 414240939, 1474321371, 1474321372. Facts
// cross-checked with lfs.aero/flight-support/israel/LLRS and airportroutes.com/airports/LLRS
// (runway 18/36, ~660 m, asphalt, unlit). The parking apron north of the hangar, the second small
// hangar, the windsock and the fence are not mapped: placed where nothing else stands.
//
// The ground under the field is graded in the terrain bake (AIRFIELD_FLATS, read by
// tools/landmark_flats.js -> data/terrain.flats.json -> tools/fetch_terrain.py): level across the
// runway, one straight slope along it.
//
// The plane has no collider and is not in the collision world, so it never blocks the player or
// the chase camera. Its whole loop is a pure function of the cycle clock (pose(t)), driven from a
// scene.onBeforeRender hook, so main.js only needs the loader line.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { project, SCALE } from '../geo.js';
import { toonMat } from '../engine/renderer.js';
import { groundAt } from './terrain.js';

const P = (lat, lon) => { const p = project(lat, lon); return [p.x, p.z]; };
const ways = (list) => list.map(([la, lo]) => P(la, lo));

// ---- OSM geometry (lat, lon) ----
const RUNWAY = ways([[31.9691887, 34.7535546], [31.9633256, 34.7535896]]);
const RUNWAY_W = 9 * SCALE;
const HANGAR = ways([[31.9691431, 34.7527879], [31.9691429, 34.7533552], [31.9688487, 34.7533707], [31.9688610, 34.7527879]]);
const TAXIWAYS = [
  [[31.9650916, 34.7535793], [31.9650946, 34.7534165], [31.9651096, 34.7533662], [31.9651324, 34.7533428], [31.9651986, 34.7532717], [31.9652353, 34.7532098], [31.9652453, 34.7531266], [31.9652851, 34.7530709], [31.9654052, 34.7530320], [31.9676365, 34.7529028], [31.9679324, 34.7529743], [31.9684148, 34.7529636]],
  [[31.9687808, 34.7533888], [31.9687403, 34.7533657], [31.9686397, 34.7533457], [31.9652803, 34.7533388], [31.9651324, 34.7533428]],
  [[31.9652353, 34.7532098], [31.9652572, 34.7532967], [31.9652803, 34.7533388]],
  [[31.9687808, 34.7533888], [31.9688155, 34.7534130], [31.9688425, 34.7534625], [31.9690106, 34.7534625], [31.9690927, 34.7534607], [31.9691569, 34.7534099], [31.9691938, 34.7533296], [31.9691938, 34.7528856]],
  [[31.9688425, 34.7534625], [31.9688419, 34.7535574]],
  [[31.9651199, 34.7533527], [31.9633903, 34.7533499], [31.9633012, 34.7534631], [31.9633256, 34.7535896]],
  [[31.9686004, 34.7535588], [31.9688782, 34.7538351], [31.9693995, 34.7538270], [31.9694819, 34.7537623], [31.9694716, 34.7536208], [31.9694133, 34.7535521], [31.9691887, 34.7535546]],
].map(ways);
const TAXI_W = 6 * SCALE;

// Runway frame: `a` = world units from the north end toward the south one, `c` = across, east positive.
const [NX, NZ] = RUNWAY[0], [SX, SZ] = RUNWAY[1];
const LEN = Math.hypot(SX - NX, SZ - NZ);
const UX = (SX - NX) / LEN, UZ = (SZ - NZ) / LEN; // along, north -> south
const EX = -UZ, EZ = UX;                           // across, toward the east
const rw = (a, c = 0) => [NX + UX * a + EX * c, NZ + UZ * a + EZ * c];

// Unmapped pieces, in world units next to the mapped ones.
const APRON = [[-2524, 724], [-2446, 724], [-2446, 772], [-2524, 772]];
const SHED = { x: -2497, z: 711, w: 28, d: 22, h: 7.5 }; // small hangar north of the apron, door to the south
const SOCK = rw(250, -16);                                // windsock west of the runway, mid field
const PARK = { x: -2478, z: 744 };                        // the plane's stand on the apron, nose north

// Ground that the terrain bake grades for the field (tools/landmark_flats.js reads this).
export const AIRFIELD_FOOTPRINT = [[-2530, 694], [-2386, 694], [-2386, 862], [-2412, 872], [-2412, 1566], [-2472, 1566], [-2472, 1334], [-2500, 1334], [-2500, 842], [-2530, 842]];
export const AIRFIELD_FLATS = [{ id: 'llrs_airfield', points: AIRFIELD_FOOTPRINT, axis: [RUNWAY[0], RUNWAY[1]] }];

const ASPHALT = 0x4b4f57, TAXI = 0x5a5e66, APRON_C = 0x62666d, WHITE = 0xf4f4ee, YELLOW = 0xf2c230;

// ---------- draped flat geometry ----------
// Every decal follows groundAt per vertex, sampled every ~6 u, a little above the terrain mesh.
function ribbon(pts, w, lift) {
  const dense = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 6));
    for (let k = 0; k < n; k++) dense.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  dense.push(pts[pts.length - 1]);
  const pos = [], idx = [];
  for (let i = 0; i < dense.length; i++) {
    const p = dense[Math.max(0, i - 1)], q = dense[Math.min(dense.length - 1, i + 1)];
    let dx = q[0] - p[0], dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const [x, z] = dense[i];
    for (const s of [-1, 1]) {
      const vx = x - dz * s * w / 2, vz = z + dx * s * w / 2;
      pos.push(vx, groundAt(vx, vz) + lift, vz);
    }
    if (i) { const o = (i - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); } // wound to face up
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A rectangle in the runway frame (a0..a1 along, c0..c1 across), draped.
const rect = (a0, a1, c0, c1, lift) => ribbon([rw(a0, (c0 + c1) / 2), rw(a1, (c0 + c1) / 2)], c1 - c0, lift);

// A world polygon filled on a ~6 u grid, every vertex draped.
function patch(ring, lift) {
  const s = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, z)));
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(Math.PI / 2); // shape (x, y) -> world (x, 0, z) with z = y
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, groundAt(p.getX(i), p.getZ(i)) + lift);
  // The field is graded planar along the runway, so the corners alone follow it; flip to face up.
  g.index && g.index.array.reverse();
  g.computeVertexNormals();
  return g;
}

function numberTexture(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 384;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f4ee';
  ctx.font = '700 300px Rubik, Heebo, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 200);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A runway designator painted flat: `top` is the direction the top of the digits points to.
function designator(text, a, top) {
  const w = 7, l = 10.5, lift = 0.2;
  const [cx, cz] = rw(a);
  const g = new THREE.PlaneGeometry(w, l);
  g.rotateX(-Math.PI / 2); // +y of the plane -> -z of the world
  const yaw = Math.atan2(-top[0], -top[1]); // turn the -z "top" onto `top`
  g.rotateY(yaw);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + cx, z = p.getZ(i) + cz;
    p.setXYZ(i, x, groundAt(x, z) + lift, z);
  }
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: numberTexture(text), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  m.renderOrder = 2;
  return m;
}

const decalMat = (color, f) => toonMat(color, { polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: f });

// ---------- buildings and props ----------
function buildHangar(group, colliders) {
  // OSM footprint: its long side runs east-west; the door is on the north side, onto the taxiway.
  const xs = HANGAR.map((p) => p[0]), zs = HANGAR.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let base = Infinity;
  for (const [x, z] of HANGAR) base = Math.min(base, groundAt(x, z));
  base -= 0.6;
  const wallH = 9.5, rise = 5.5;
  const g = new THREE.Group();
  g.position.set(cx, base, cz);
  group.add(g);
  const wall = toonMat(0xd9dcd6), roof = toonMat(0x8f99a3), dark = toonMat(0x22262c), door = toonMat(0xb9c2c9), red = toonMat(0xc8423a);
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  // walls: back and sides solid, the north face a frame around a 70 % wide door
  add(new THREE.BoxGeometry(w, wallH, 0.6).translate(0, wallH / 2, d / 2 - 0.3), wall);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.6, wallH, d).translate(s * (w / 2 - 0.3), wallH / 2, 0), wall);
  const doorW = w * 0.7, side = (w - doorW) / 2;
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(side, wallH, 0.6).translate(s * (w / 2 - side / 2), wallH / 2, -d / 2 + 0.3), wall);
  add(new THREE.BoxGeometry(doorW, 1.6, 0.6).translate(0, wallH - 0.8, -d / 2 + 0.3), wall);
  add(new THREE.BoxGeometry(doorW, wallH - 1.6, 0.2).translate(0, (wallH - 1.6) / 2, -d / 2 + 2.2), dark); // the dark inside
  // sliding door leaves, half open toward both sides
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(doorW * 0.27, wallH - 1.7, 0.3).translate(s * doorW * 0.36, (wallH - 1.7) / 2, -d / 2 - 0.2), door);
  // barrel roof over the long axis, gable ends filled
  const arc = new THREE.CylinderGeometry(1, 1, w + 0.8, 24, 1, true, -Math.PI / 2, Math.PI);
  arc.rotateZ(Math.PI / 2);
  arc.scale(1, rise, d / 2 + 0.4);
  arc.translate(0, wallH, 0);
  add(arc, toonMat(0x8f99a3, { side: THREE.DoubleSide }));
  const endShape = new THREE.Shape();
  endShape.absellipse(0, 0, d / 2, rise, 0, Math.PI, false);
  for (const s of [-1, 1]) { const e = new THREE.ShapeGeometry(endShape, 16); e.rotateY(Math.PI / 2); e.translate(s * (w / 2 - 0.05), wallH, 0); add(e, roof); }
  // a red band under the eaves, like the real one's trim (generic, no lettering)
  add(new THREE.BoxGeometry(w + 0.2, 0.8, d + 0.2).translate(0, wallH - 0.4, 0), red).castShadow = false;
  colliders.push({ kind: 'building', points: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], height: base + wallH + rise });
}

function buildShed(group, colliders) {
  const { x, z, w, d, h } = SHED;
  let base = Infinity;
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) base = Math.min(base, groundAt(x + dx * w / 2, z + dz * d / 2));
  base -= 0.5;
  const g = new THREE.Group();
  g.position.set(x, base, z);
  group.add(g);
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  const wall = toonMat(0xe8e1cf);
  add(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), wall);
  add(new THREE.BoxGeometry(w * 0.7, h * 0.8, 0.3).translate(0, h * 0.4, d / 2 + 0.1), toonMat(0x6d7f8f)); // closed door, south
  const roof = new THREE.Shape([new THREE.Vector2(-d / 2 - 0.6, 0), new THREE.Vector2(d / 2 + 0.6, 0), new THREE.Vector2(0, 3.2)]);
  const rg = new THREE.ExtrudeGeometry(roof, { depth: w + 1, bevelEnabled: false });
  rg.translate(0, 0, -(w + 1) / 2);
  rg.rotateY(Math.PI / 2);
  rg.translate(0, h, 0);
  add(rg, toonMat(0x9c4b3a));
  colliders.push({ kind: 'building', points: [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]], height: base + h + 3.2 });
}

// Wind from the sea (west-north-west), so the sock points east-south-east.
const WIND_YAW = Math.atan2(1, 0.25);

function buildWindsock(group, colliders) {
  const [x, z] = SOCK;
  const y = groundAt(x, z);
  const g = new THREE.Group();
  g.position.set(x, y, z);
  group.add(g);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 9, 8).translate(0, 4.5, 0), toonMat(0xdddddd));
  pole.castShadow = true;
  g.add(pole);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.07, 6, 16), toonMat(0x666666));
  ring.position.y = 8.6; ring.rotation.y = Math.PI / 2;
  // The sock: a cone of five stripes, orange and white, hinged at the pole top.
  const sock = new THREE.Group();
  sock.position.y = 8.6;
  const segs = [];
  for (let i = 0; i < 5; i++) {
    const r0 = 0.7 - i * 0.09, r1 = 0.7 - (i + 1) * 0.09;
    const c = new THREE.CylinderGeometry(r0, r1, 1.0, 12, 1, true);
    c.rotateZ(-Math.PI / 2);
    c.translate(0.5 + i, 0, 0);
    const m = new THREE.Mesh(c, toonMat(i % 2 ? 0xf6f6f2 : 0xff6a1a, { side: THREE.DoubleSide }));
    m.castShadow = true;
    sock.add(m);
    segs.push(m);
  }
  sock.add(ring);
  ring.position.set(0, 0, 0);
  sock.rotation.y = WIND_YAW - Math.PI / 2;
  g.add(sock);
  colliders.push({ kind: 'prop', points: [[x - 0.4, z - 0.4], [x + 0.4, z - 0.4], [x + 0.4, z + 0.4], [x - 0.4, z + 0.4]], height: y + 9 });
  return (time) => {
    sock.rotation.z = -0.12 + Math.sin(time * 1.3) * 0.06;            // droops and lifts with the gusts
    sock.rotation.y = WIND_YAW - Math.PI / 2 + Math.sin(time * 0.7) * 0.12;
  };
}

// Chain-link fence along the city side of the field, with posts every 4 u; thin colliders that
// the camera may look over.
function buildFence(group, colliders, lines) {
  const posts = [], panels = [];
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i], [bx, bz] = line[i + 1];
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 4));
      for (let k = 0; k <= n; k++) { const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n; posts.push([x, groundAt(x, z), z]); }
      for (let k = 0; k < n; k++) {
        const x0 = ax + (bx - ax) * k / n, z0 = az + (bz - az) * k / n, x1 = ax + (bx - ax) * (k + 1) / n, z1 = az + (bz - az) * (k + 1) / n;
        panels.push([x0, z0, x1, z1]);
      }
      const ux = (bx - ax) / L, uz = (bz - az) / L, t = 0.2;
      const top = Math.max(groundAt(ax, az), groundAt(bx, bz)) + 2.2;
      colliders.push({ kind: 'wall', height: top, points: [[ax - uz * t, az + ux * t], [bx - uz * t, bz + ux * t], [bx + uz * t, bz - ux * t], [ax + uz * t, az - ux * t]] });
    }
  }
  const postMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.08, 2.2, 6).translate(0, 1.1, 0), toonMat(0x8a8f96), posts.length);
  const m4 = new THREE.Matrix4();
  posts.forEach(([x, y, z], i) => postMesh.setMatrixAt(i, m4.makeTranslation(x, y, z)));
  group.add(postMesh);
  const pos = [], idx = [];
  for (const [x0, z0, x1, z1] of panels) {
    const o = pos.length / 3, y0 = groundAt(x0, z0), y1 = groundAt(x1, z1);
    pos.push(x0, y0 + 0.1, z0, x1, y1 + 0.1, z1, x1, y1 + 2.0, z1, x0, y0 + 2.0, z0);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  pg.setIndex(idx);
  pg.computeVertexNormals();
  group.add(new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0x9aa1a8, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })));
}

// ---------- the plane ----------
// Generic high-wing single-engine four-seater, about 1.5 x real size like the rest of the world's
// props next to the 5 u avatars. White with a plain blue cheat line; no marks of any maker.
// Local frame: nose toward +z, origin on the ground under the main wheels.
function buildPlane() {
  const root = new THREE.Group();
  root.name = 'llrs_plane';
  const body = new THREE.Group();
  root.add(body);
  const white = toonMat(0xf6f6f2), blue = toonMat(0x2d5fa8), dark = toonMat(0x1f252d), grey = toonMat(0x9aa2ab), black = toonMat(0x202020);
  const parts = { white: [], blue: [], dark: [], grey: [], black: [] };
  // Extrusions come unindexed and boxes indexed; merging needs one kind.
  const put = (k, g) => parts[k].push(g.index ? g.toNonIndexed() : g);
  const Y = 2.6; // fuselage axis height
  // cabin and cowling
  put('white', new THREE.BoxGeometry(2.3, 2.6, 5.6).translate(0, Y + 0.3, 1.6));
  put('white', new THREE.CylinderGeometry(1.0, 1.2, 2.4, 14).rotateX(Math.PI / 2).translate(0, Y, 5.6));
  // tail boom tapering up to the fin
  const boom = new THREE.CylinderGeometry(1.15, 0.35, 8.2, 12);
  boom.rotateX(-Math.PI / 2);
  const bp = boom.attributes.position;
  for (let i = 0; i < bp.count; i++) { const zz = bp.getZ(i); bp.setY(i, bp.getY(i) + Math.max(0, -zz + 4.1) * 0.06); }
  boom.computeVertexNormals();
  boom.translate(0, Y + 0.2, -5.2);
  put('white', boom);
  // blue cheat line along both sides
  for (const s of [-1, 1]) put('blue', new THREE.BoxGeometry(0.06, 0.35, 11).translate(s * 1.17, Y - 0.2, -0.6));
  // windows: windshield, side windows
  put('dark', new THREE.BoxGeometry(2.0, 1.0, 0.1).rotateX(-0.6).translate(0, Y + 1.3, 4.35));
  for (const s of [-1, 1]) put('dark', new THREE.BoxGeometry(0.08, 0.9, 3.4).translate(s * 1.17, Y + 0.95, 1.7));
  // high wing with a slight taper, two struts each side
  const wing = new THREE.BoxGeometry(20, 0.35, 2.6);
  const wp = wing.attributes.position;
  for (let i = 0; i < wp.count; i++) { const f = Math.abs(wp.getX(i)) / 10; wp.setZ(i, wp.getZ(i) * (1 - 0.25 * f)); wp.setY(i, wp.getY(i) + f * 0.35); }
  wing.computeVertexNormals();
  wing.translate(0, Y + 1.75, 2.2);
  put('white', wing);
  for (const s of [-1, 1]) put('blue', new THREE.BoxGeometry(1.4, 0.37, 2.0).translate(s * 9.4, Y + 2.1, 2.2)); // wing tips
  for (const s of [-1, 1]) {
    const len = Math.hypot(4.6, 1.6);
    const st = new THREE.BoxGeometry(0.14, len, 0.35);
    st.rotateZ(-s * Math.atan2(4.6, 1.6));
    st.translate(s * 3.4, Y + 0.85, 2.2);
    put('grey', st);
  }
  // tailplane and fin
  put('white', new THREE.BoxGeometry(6.6, 0.22, 1.7).translate(0, Y + 0.65, -8.6));
  const fin = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(2.4, 0), new THREE.Vector2(0.9, 3.0), new THREE.Vector2(-0.4, 3.0)]);
  const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.2, bevelEnabled: false });
  fg.translate(0, 0, -0.1);
  fg.rotateY(Math.PI / 2);
  fg.translate(0, Y + 0.7, -7.4);
  put('white', fg);
  put('blue', new THREE.BoxGeometry(0.24, 0.5, 1.6).translate(0, Y + 2.9, -8.6));
  // tricycle gear
  const wheel = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14).rotateZ(Math.PI / 2);
  for (const s of [-1, 1]) {
    put('black', wheel.clone().translate(s * 1.9, 0.55, 0));
    const leg = new THREE.BoxGeometry(0.16, 1.6, 0.4);
    leg.rotateZ(s * 0.6);
    leg.translate(s * 1.4, 1.2, 0);
    put('grey', leg);
  }
  put('black', wheel.clone().translate(0, 0.5, 5.4));
  put('grey', new THREE.BoxGeometry(0.14, 1.4, 0.14).translate(0, 1.2, 5.4));
  const meshes = {};
  for (const [k, list] of Object.entries(parts)) {
    const m = new THREE.Mesh(mergeGeometries(list), { white, blue, dark, grey, black }[k]);
    m.castShadow = true;
    body.add(m);
    meshes[k] = m;
  }
  // propeller: spinner, two blades and a faint disc that shows once it spins fast
  const prop = new THREE.Group();
  prop.position.set(0, Y, 6.9);
  body.add(prop);
  prop.add(new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.9, 12).rotateX(Math.PI / 2).translate(0, 0, 0.35), white));
  const blades = new THREE.Mesh(new THREE.BoxGeometry(0.28, 4.4, 0.08), black);
  blades.castShadow = true;
  prop.add(blades);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(2.2, 28), new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  disc.position.z = 0.02;
  prop.add(disc);
  return { root, body, blades, disc };
}

// ---------- the loop ----------
// Legs in order. A ground leg follows the ground; an air leg carries absolute heights. Speeds in
// u/s change at a constant rate over the leg, so position is closed-form in time.
const G_ACC = 9.81 * SCALE;
function makeLegs() {
  const R = groundAt(...rw(80)); // field elevation at the touchdown zone
  const air = (x, z, agl) => new THREE.Vector3(x, R + agl, z);
  const gnd = (x, z) => new THREE.Vector3(x, 0, z);
  const g = (pts) => pts.map(([x, z]) => gnd(x, z));
  const X = rw(0)[0]; // the runway is north-south to 0.3 deg; its centre line x at the north end
  const xAt = (z) => rw((z - NZ) / UZ)[0];
  const lift = 1080, lzAt = (z) => [xAt(z), z];
  const L = [];
  const leg = (kind, pts, v0, v1, engine) => L.push({ kind, pts, v0, v1, engine });
  // Taxi speeds are brisk (up to ~18 m/s) and the cruise fast for a single-engine (~130 m/s): the
  // sea is 3.5 km west of the field, and the loop still has to come round in about three minutes.
  // stand -> U-turn on the apron -> taxiway -> onto the runway southbound at the 817 link
  leg('ground', g([[PARK.x, PARK.z], [PARK.x - 1, PARK.z - 9]]), 0, 8, 'taxi');
  leg('ground', g([[PARK.x - 1, PARK.z - 9], [-2486, 727], [-2499, 731], [-2505, 744], [-2500, 760], [-2486, 768], [-2466, 770.5], [-2456, 771], [-2447, 775], [-2441.5, 784], [-2440.8, 798], [-2439.5, 810], [-2435, 816.5], [xAt(824) - 1, 824], [...lzAt(836)]]), 8, 12, 'taxi');
  leg('ground', g([lzAt(836), lzAt(850)]), 12, 0, 'taxi');
  leg('hold', [gnd(...lzAt(850))], 0, 0, 'runup');
  // take-off roll to rotation, climb out south, right turn west out over the sea
  leg('ground', g([lzAt(850), lzAt(lift)]), 0, 36, 'full');
  leg('air', [gnd(...lzAt(lift)), air(xAt(1230), 1230, 10), air(xAt(1400), 1400, 32), air(-2450, 1600, 65), air(-2560, 1780, 100), air(-2800, 1900, 130), air(-3150, 1940, 150)], 36, 125, 'climb');
  // Out to sea and north along the coast, ~400-600 u offshore (the coast runs from x -6600 at z 1500
  // to -6100 at z 0).
  leg('air', [air(-3150, 1940, 150), air(-4300, 1850, 180), air(-5500, 1650, 190), air(-6500, 1350, 190), air(-6850, 850, 190), air(-6700, 300, 190), air(-6200, -100, 188), air(-5300, -400, 184), air(-4300, -560, 178), air(-3700, -620, 170)], 125, 160, 'cruise');
  // back east over the dunes and western Rishon, right turn onto a final from the north
  leg('air', [air(-3700, -620, 170), air(-3150, -620, 145), air(-2800, -540, 125), air(-2580, -380, 105), air(X - 4, -160, 88), air(X, 60, 74)], 160, 54, 'approach');
  leg('air', [air(X, 60, 74), air(X, 330, 50), air(xAt(600), 600, 22), air(xAt(800), 800, 4), gnd(...lzAt(880))], 54, 46, 'idle');
  // roll out, vacate west at the southern taxiway, back north on the parallel one to the stand
  leg('ground', g([lzAt(880), lzAt(1240), lzAt(1290)]), 46, 14, 'idle');
  leg('ground', g([lzAt(1290), [xAt(1304) - 2, 1306], [-2438, 1313.5], [-2448, 1312.5], [-2453.5, 1302], [-2454.2, 1280], [-2454.4, 1100], [-2454.4, 870], [-2453.6, 845], [-2451.5, 832], [-2447, 822], [-2441.5, 812], [-2440.8, 798], [-2441.5, 785], [-2447, 775.5], [-2455, 771]]), 14, 22, 'taxi');
  leg('ground', g([[-2455, 771], [-2468, 767], [PARK.x - 0.5, 759], [PARK.x, PARK.z]]), 22, 0, 'taxi');
  for (const l of L) {
    if (l.kind === 'hold') { l.len = 0; l.dur = 6; continue; }
    // Ground legs need their own heights before the curve is built, so the arc length is right.
    if (l.kind === 'ground') for (const p of l.pts) p.y = groundAt(p.x, p.z);
    l.curve = new THREE.CatmullRomCurve3(l.pts, false, 'centripetal');
    l.len = l.curve.getLength();
    l.dur = 2 * l.len / Math.max(0.5, l.v0 + l.v1);
    l.acc = (l.v1 * l.v1 - l.v0 * l.v0) / (2 * l.len);
  }
  return L;
}

const CYCLE = 180; // seconds, stand to stand; the plane rests on the stand for the remainder

const ENGINE_RPM = { off: 0, taxi: 0.35, runup: 0.7, full: 1, climb: 0.95, cruise: 0.8, approach: 0.55, idle: 0.3 };

export function buildAirfield(scene, { landmarks = null, exclude = null } = {}) {
  const group = new THREE.Group();
  group.name = 'airfield';
  scene.add(group);
  const colliders = [];

  // ---- surfaces: apron, taxiways, runway, markings ----
  const ground = [];
  ground.push([patch(APRON, 0.1), APRON_C]);
  for (const t of TAXIWAYS) ground.push([ribbon(t, TAXI_W, 0.11), TAXI]);
  ground.push([rect(-6, LEN + 6, -RUNWAY_W / 2, RUNWAY_W / 2, 0.14), ASPHALT]);
  const marks = [], yellow = [];
  for (const s of [-1, 1]) marks.push(rect(0, LEN, s * RUNWAY_W / 2 - 0.55, s * RUNWAY_W / 2 - 0.2, 0.17)); // edge lines
  for (let a = 30; a < LEN - 40; a += 20) marks.push(rect(a, a + 11, -0.25, 0.25, 0.17));               // centre line
  for (const [a0, a1] of [[2, 12], [LEN - 12, LEN - 2]]) {                                                  // threshold bars
    for (let i = 0; i < 4; i++) for (const s of [-1, 1]) { const c = s * (0.9 + i * 1.15); marks.push(rect(a0, a1, c - 0.4, c + 0.4, 0.17)); }
  }
  for (const a of [95, LEN - 95]) for (const s of [-1, 1]) marks.push(rect(a - 8, a + 8, s * 1.4 - 0.55, s * 1.4 + 0.55, 0.17)); // aiming points
  for (const t of TAXIWAYS) yellow.push(ribbon(t, 0.3, 0.15));
  yellow.push(ribbon([[PARK.x, PARK.z + 4], [PARK.x, 768]], 0.3, 0.15));
  ground.forEach(([geo, c], i) => { const m = new THREE.Mesh(geo, decalMat(c, -1 - i * 0.2)); m.receiveShadow = true; group.add(m); });
  const wm = new THREE.Mesh(mergeGeometries(marks), decalMat(WHITE, -3)); wm.receiveShadow = true; group.add(wm);
  const ym = new THREE.Mesh(mergeGeometries(yellow), decalMat(YELLOW, -3)); ym.receiveShadow = true; group.add(ym);
  group.add(designator('18', 24, [UX, UZ]));        // read by a pilot landing southbound
  group.add(designator('36', LEN - 24, [-UX, -UZ])); // read by one landing northbound

  buildHangar(group, colliders);
  buildShed(group, colliders);
  const sockTick = buildWindsock(group, colliders);
  buildFence(group, colliders, [
    [[-2386, 700], [-2386, 862], [-2404, 874], [-2404, 1080]],
    [[-2404, 1100], [-2404, 1562], [-2468, 1562]],          // a gap at z 1080-1100 lets the player walk in
  ]);

  // ---- the plane and its loop ----
  const plane = buildPlane();
  group.add(plane.root);
  const legs = makeLegs();
  const busy = legs.reduce((s, l) => s + l.dur, 0);
  const rest = Math.max(15, CYCLE - busy);
  const starts = [];
  { let s = rest; for (const l of legs) { starts.push(s); s += l.dur; } }
  const period = rest + busy;

  const _p = new THREE.Vector3(), _q = new THREE.Vector3();
  // Pose at cycle time t: { x, y, z, yaw, pitch, speed, engine, air }.
  function pose(t) {
    t = ((t % period) + period) % period;
    if (t < rest) return { x: PARK.x, y: groundAt(PARK.x, PARK.z), z: PARK.z, yaw: Math.PI, pitch: 0, speed: 0, engine: t > rest - 8 ? 'runup' : 'off', air: false, phase: 'parked' };
    let i = legs.length - 1;
    while (i > 0 && starts[i] > t) i--;
    const l = legs[i], tau = t - starts[i];
    if (l.kind === 'hold') {
      const p = l.pts[0];
      return { x: p.x, y: groundAt(p.x, p.z), z: p.z, yaw: Math.atan2(UX, UZ), pitch: 0, speed: 0, engine: l.engine, air: false, phase: 'hold' };
    }
    const s = Math.min(l.len, l.v0 * tau + 0.5 * l.acc * tau * tau);
    const u = l.len > 0 ? s / l.len : 0;
    l.curve.getPointAt(Math.min(1, u), _p);
    l.curve.getTangentAt(Math.min(1, Math.max(0, u)), _q);
    const speed = l.v0 + l.acc * tau;
    let y = _p.y;
    const g0 = groundAt(_p.x, _p.z);
    if (l.kind === 'ground' || y < g0) y = g0;
    const yaw = Math.atan2(_q.x, _q.z);
    const pitch = l.kind === 'air' ? -Math.atan2(_q.y, Math.hypot(_q.x, _q.z)) - 0.06 : 0;
    return { x: _p.x, y, z: _p.z, yaw, pitch, speed, engine: l.engine, air: l.kind === 'air', phase: l.kind + i };
  }

  // ---- engine sound (own small graph, silent until the first key or click, off when the game is muted) ----
  let actx = null, eng = null;
  const startSound = () => {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { actx = new AC(); } catch { return; }
    const out = actx.createGain(); out.gain.value = 0; out.connect(actx.destination);
    const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.connect(out);
    const o1 = actx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 80;
    const o2 = actx.createOscillator(); o2.type = 'square'; o2.frequency.value = 40;
    const g2 = actx.createGain(); g2.gain.value = 0.4;
    // the prop's blade-pass throb: a slow tremolo on the engine tone
    const trem = actx.createGain(); trem.gain.value = 0.7;
    const lfo = actx.createOscillator(); lfo.frequency.value = 22;
    const lfoG = actx.createGain(); lfoG.gain.value = 0.3;
    lfo.connect(lfoG); lfoG.connect(trem.gain);
    o1.connect(trem); o2.connect(g2); g2.connect(trem); trem.connect(lp);
    o1.start(); o2.start(); lfo.start();
    eng = { out, o1, o2, lfo, lp };
  };
  for (const ev of ['keydown', 'pointerdown']) window.addEventListener(ev, startSound, { once: true, capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (actx) (document.hidden ? actx.suspend() : actx.resume()).catch(() => {}); });

  // ---- per frame, from the render hook ----
  let clock = 0, last = performance.now(), spin = 0, rpm = 0;
  const camPos = new THREE.Vector3();
  function tick(dt, camera) {
    clock += dt;
    sockTick(clock);
    const p = pose(clock);
    plane.root.position.set(p.x, p.y, p.z);
    // Bank into turns: yaw rate from a pose a fraction of a second ahead.
    let bank = 0;
    if (p.air) {
      const q = pose(clock + 0.4);
      let dy = q.yaw - p.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      bank = Math.max(-0.55, Math.min(0.55, Math.atan((dy / 0.4) * p.speed / G_ACC)));
    }
    plane.root.rotation.set(0, 0, 0);
    plane.root.rotation.order = 'YXZ';
    plane.root.rotation.y = p.yaw;
    plane.body.rotation.set(p.pitch, 0, -bank * 1.0);
    const target = ENGINE_RPM[p.engine] || 0;
    rpm += (target - rpm) * Math.min(1, dt * (target > rpm ? 0.8 : 0.5));
    spin += rpm * 60 * dt;
    plane.blades.rotation.z = spin;
    plane.disc.material.opacity = Math.max(0, (rpm - 0.25) * 0.35);
    plane.blades.visible = rpm < 0.6;
    if (eng && actx.state === 'running') {
      if (camera) camPos.setFromMatrixPosition(camera.matrixWorld);
      const d = camera ? camPos.distanceTo(plane.root.position) : 1e4;
      const muted = !!window.__game?.audio?.muted;
      const vol = muted || rpm < 0.02 ? 0 : Math.min(0.12, 0.12 * rpm / (1 + (d / 120) ** 2));
      const now = actx.currentTime;
      eng.out.gain.setTargetAtTime(vol, now, 0.15);
      eng.o1.frequency.setTargetAtTime(55 + rpm * 70, now, 0.2);
      eng.o2.frequency.setTargetAtTime((55 + rpm * 70) / 2, now, 0.2);
      eng.lfo.frequency.setTargetAtTime(8 + rpm * 30, now, 0.2);
      eng.lp.frequency.setTargetAtTime(400 + rpm * 900, now, 0.2);
    }
  }
  const prevHook = scene.onBeforeRender;
  scene.onBeforeRender = function (renderer, sc2, camera, ...rest) {
    // The post pass may render the scene more than once a frame: advance on wall time only.
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    if (dt > 0.001 && camera && camera.isPerspectiveCamera) { last = now; tick(dt, camera); }
    if (prevHook) prevHook.call(this, renderer, sc2, camera, ...rest);
  };

  const [px, pz] = rw(LEN / 2, -18);
  const pois = [{ id: 'llrs_airfield', name: 'llrs_airfield', x: px, z: pz }];
  if (landmarks) { landmarks.colliders.push(...colliders); landmarks.pois.push(...pois); }
  // The OSM hangar's centroid falls in here: buildings.js leaves it to this module.
  if (exclude) exclude.push({ id: 'llrs_airfield', points: HANGAR });

  const api = {
    group, colliders, pois, period, rest, legs: legs.map((l) => ({ kind: l.kind, len: Math.round(l.len), dur: +l.dur.toFixed(1), engine: l.engine })),
    pose, get clock() { return clock; },
    // For playtests: jump the loop to cycle time t (seconds since the stand rest began).
    seek(t) { clock = t; },
  };
  window.__airfield = api;
  return api;
}
