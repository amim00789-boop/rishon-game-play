// Street furniture: lamps, bus shelters, traffic lights, benches, bins, bike racks, boulevard
// median lamps and the beach promenade kit. Facade details (AC units, laundry) belong to
// buildings.js since round 2. Trees are not placed here any more: since round 3 every tree comes
// from the map (src/world/trees.js), including street trees on sidewalks and medians.
//
// Order on the street comes from three rules:
//  1. Every prop stands on a sidewalk strip (city.sidewalks), at a bus stop (city.busStops), on a
//     boulevard median, or along the promenade. If the city has no sidewalks yet, strips are
//     derived by offsetting the road centre lines.
//  2. A spatial grid of carriageway segments (city.roads with their widths) vetoes any prop whose
//     footprint would touch asphalt or rail. Buildings and water veto too.
//  3. An occupancy grid keeps props from stacking: mapped trees (when passed in) claim space
//     first, then stops and junction lights, then lamps, then the small stuff.
// Rendering: one InstancedMesh per prop type per large chunk, a single MeshToonMaterial, and
// per-type draw distances so small props cost nothing far away.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SCALE, project } from '../geo.js';

const CHUNK = 640;
const CARRIAGE = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(residential|service|unclassified|living_street|road|busway|track|rail|tram|light_rail)$/;
const BIG = /^(trunk|primary|secondary|tertiary)(_link)?$/;
const BOULEVARD = /^(trunk|primary)(_link)?$/;
const WALKED = /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/;
const SHOP_AMENITY = /restaurant|cafe|fast_food|bank|pharmacy|ice_cream|pub|bar|post_office|clinic|bureau_de_change|atm|library|cinema|marketplace|doctors|dentist/;

// Draw distance per prop type (world units). Beyond this the chunk's mesh for that type is hidden.
const DRAW = {
  lamp: 750, lamp2: 750, promLamp: 600, shelter: 700, busSign: 450, trafficLight: 600, trafficLightPed: 600, trafficHead: 600,
  bench: 320, bin: 260, bikeRack: 260, pergola: 700, lampC: 750, railing: 300, bollard: 220, mirror: 300, pole: 520,
};
const SHADOW = new Set(['lamp', 'lamp2', 'lampC', 'promLamp', 'shelter', 'pergola', 'trafficLight', 'trafficLightPed', 'trafficHead']);

// The old centre gets the dark green ornamental lamps (Herzl, Jabotinsky, Rothschild and the
// streets around Founders Square). The circle is an assumption fitted to where the east drive
// video shows them; the edge is not surveyed.
const CENTRE = { ...project(31.9648, 34.8015), r: 950 * SCALE };
const inCentre = (x, z) => Math.hypot(x - CENTRE.x, z - CENTRE.z) < CENTRE.r;

// Older neighbourhoods (1950s-80s) keep overhead power lines on concrete poles beside the street;
// the newer west and east estates are buried. Centres from OSM place nodes (see buildings.js
// NEIGHBOURHOODS); the 600 m radius is an assumption read off the two drive videos, not surveyed.
const OLD_ZONES = [
  [31.98235, 34.78981], [31.96530, 34.77854], [31.96047, 34.79543], [31.96883, 34.80143], [31.95360, 34.80406],
  [31.94966, 34.80742], [31.96815, 34.79463], [31.97301, 34.79409], [31.95969, 34.78997], [31.96007, 34.81136],
  [31.96524, 34.81074], [31.95177, 34.81645], [31.98589, 34.80624],
].map(([la, lo]) => ({ ...project(la, lo), r: 600 * SCALE }));
const inOldZone = (x, z) => OLD_ZONES.some((q) => Math.hypot(x - q.x, z - q.z) < q.r);
const WIRE_DRAW = 420;

const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) >>> 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d) >>> 0; n ^= n >>> 15; return (n >>> 0) / 4294967296; };
const hxz = (x, z, s = 0) => hash((Math.round(x * 7) * 73856093) ^ (Math.round(z * 7) * 19349663) ^ (s * 83492791));

// ---------- geometry building blocks ----------

function paint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
const box = (w, h, d, x, y, z, hex) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
const cyl = (r0, r1, h, x, y, z, hex, seg = 7) => paint(new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z), hex);
const blob = (r, x, y, z, hex, sy = 1, detail = 0) => paint(new THREE.IcosahedronGeometry(r, detail).scale(1, sy, 1).translate(x, y, z), hex);
const merge = (parts) => { const g = mergeGeometries(parts); g.computeBoundingSphere(); return g; };

// ---------- templates ----------
// Sized against the ~5 u avatar. Local frame: +x runs along the street, +z faces the road
// (or the direction the prop faces), y up, origin at the foot.

// A straight piece from local point a to b (in the y-z plane), as a thin box.
function strut(a, b, t, hex) {
  const dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dy, dz);
  const g = new THREE.BoxGeometry(t, t, len).rotateX(-Math.atan2(dy, dz));
  return paint(g.translate(0, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), hex);
}

function lampTemplate(double = false) {
  // Rishon street lamp, ~11 u: light galvanised pole whose arm bends up and out over the kerb, a
  // slim flat luminaire tilted toward the road. Medians carry the same arm on both sides, a "Y".
  // Reference: founder's drive videos (east 2025, west 2026), every residential street and median.
  const POLE = 0xa3abb2, HEAD = 0x7d868e;
  const parts = [cyl(0.32, 0.38, 0.7, 0, 0.35, 0, 0x6f7881), cyl(0.12, 0.19, 10.2, 0, 5.1, 0, POLE)];
  for (const s of double ? [1, -1] : [1]) {
    parts.push(strut([0, 10.0, 0], [0, 10.55, 0.9 * s], 0.15, POLE));
    parts.push(strut([0, 10.55, 0.9 * s], [0, 11.05, 2.7 * s], 0.13, POLE));
    const head = new THREE.BoxGeometry(0.62, 0.22, 1.45).rotateX(0.12 * s).translate(0, 11.05, 3.35 * s);
    parts.push(paint(head, HEAD));
    parts.push(paint(new THREE.BoxGeometry(0.46, 0.06, 1.1).rotateX(0.12 * s).translate(0, 10.92, 3.35 * s), 0xfff0b8));
  }
  parts.push(cyl(0.14, 0.12, 0.3, 0, 10.15, 0, POLE));
  return merge(parts);
}

function lampCentreTemplate() {
  // Old-centre ornamental lamp: dark green fluted post, a silver wire globe at two thirds of the
  // height and two curved arms with hanging lanterns. Seen on Herzl / Jabotinsky / Rothschild
  // and their medians in the east drive video (40:30, 49:30).
  const G = 0x41705a, GD = 0x2f5444, WIRE = 0xd2d6d9;
  const parts = [
    cyl(0.55, 0.62, 0.5, 0, 0.25, 0, GD, 8), cyl(0.38, 0.5, 1.4, 0, 1.2, 0, G, 8),
    cyl(0.14, 0.2, 9.4, 0, 6.3, 0, G, 8), cyl(0.24, 0.24, 0.3, 0, 2.0, 0, GD, 8),
  ];
  for (const rot of [[0, 0], [0, Math.PI / 2], [Math.PI / 2, 0]]) {
    const ring = new THREE.TorusGeometry(1.0, 0.055, 4, 16).rotateX(rot[0]).rotateY(rot[1]).translate(0, 7.4, 0);
    parts.push(paint(ring, WIRE));
  }
  for (const s of [1, -1]) {
    parts.push(strut([0, 10.4, 0], [0, 10.9, 0.8 * s], 0.13, G));
    parts.push(strut([0, 10.9, 0.8 * s], [0, 10.6, 1.8 * s], 0.13, G));
    parts.push(cyl(0.05, 0.05, 0.5, 0, 10.35, 1.8 * s, G, 5));
    parts.push(cyl(0.12, 0.5, 0.35, 0, 9.95, 1.8 * s, GD, 8));
    parts.push(cyl(0.38, 0.3, 0.55, 0, 9.5, 1.8 * s, 0xfff0b8, 8));
  }
  parts.push(blob(0.22, 0, 10.95, 0, G, 1.4));
  return merge(parts);
}

function railingTemplate() {
  // Galvanised pedestrian railing panel along the kerb beside a crossing, ~1 m (2.6 u) high and
  // 6 u long: posts, top and bottom rails and vertical bars. The commonest street steel in both
  // drive videos (busy crossings, shop streets, school gates).
  const C = 0xa9b0b6, P = 0x8d959c;
  const parts = [box(6.0, 0.13, 0.13, 0, 2.5, 0, C), box(6.0, 0.1, 0.1, 0, 0.55, 0, C), box(6.0, 0.08, 0.08, 0, 2.15, 0, C)];
  for (const x of [-2.95, 0, 2.95]) parts.push(box(0.2, 2.6, 0.2, x, 1.3, 0, P));
  for (let x = -2.6; x <= 2.61; x += 0.52) if (Math.abs(x) > 0.2) parts.push(box(0.07, 1.6, 0.07, x, 1.35, 0, C));
  return merge(parts);
}

function mirrorTemplate() {
  // Convex traffic mirror on a grey pole, facing +z (the side street it lets drivers see into):
  // orange back shell, silver face. Seen at residential T-junctions in the east drive video (4:50).
  const disc = (r, t, z, hex) => paint(new THREE.CylinderGeometry(r, r, t, 16).rotateX(Math.PI / 2).translate(0, 7.0, z), hex);
  return merge([
    cyl(0.1, 0.12, 7.6, 0, 3.8, 0, 0x9aa1a8), box(0.12, 0.12, 0.5, 0, 7.0, 0.2, 0x8d959c),
    disc(1.05, 0.22, 0.48, 0xe0662c), disc(0.9, 0.06, 0.62, 0xd6e1e8),
  ]);
}

function poleTemplate() {
  // Concrete utility pole, ~10.5 u, with a cross arm over the street and three insulators, as
  // along the old estates in the drive videos. The cross arm runs along local z (toward the road).
  const C = 0xa9a79f, ARM = 0x7d7468, INS = 0xd9d4c8;
  const parts = [cyl(0.26, 0.38, 10.4, 0, 5.2, 0, C, 8), box(0.2, 0.2, 2.5, 0, 9.4, 0, ARM), box(0.2, 0.14, 0.14, 0, 9.0, 0, ARM)];
  for (const z of [-1.0, 0, 1.0]) parts.push(cyl(0.1, 0.14, 0.38, 0, 9.69, z, INS, 6));
  parts.push(cyl(0.1, 0.18, 0.4, 0, 10.55, 0, C, 6));
  return merge(parts);
}

function bollardTemplate() {
  // Grey steel bollard (~0.85 m) with a darker cap band, as on shop-street corners in the videos.
  return merge([cyl(0.24, 0.26, 2.2, 0, 1.1, 0, 0x9aa1a8, 7), cyl(0.27, 0.27, 0.22, 0, 1.75, 0, 0x5d656c, 7), blob(0.24, 0, 2.2, 0, 0x9aa1a8, 0.5)]);
}

function promLampTemplate() {
  // White promenade post with two lantern globes on a cross bar.
  return merge([
    cyl(0.32, 0.38, 0.6, 0, 0.3, 0, 0x6f7a84), cyl(0.12, 0.16, 7.6, 0, 4.1, 0, 0xf3f1ea),
    box(2.4, 0.14, 0.14, 0, 7.8, 0, 0xf3f1ea),
    blob(0.5, -1.15, 8.25, 0, 0xfff3c9, 1, 1), blob(0.5, 1.15, 8.25, 0, 0xfff3c9, 1, 1),
    cyl(0.18, 0.28, 0.25, -1.15, 8.78, 0, 0xf3f1ea), cyl(0.18, 0.28, 0.25, 1.15, 8.78, 0, 0xf3f1ea),
  ]);
}

function benchTemplate() {
  // Blue slatted municipal bench; the seat faces +z.
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(box(4.2, 0.18, 0.42, 0, 1.2, -0.5 + i * 0.5, 0x2f7fb3));
  for (let i = 0; i < 2; i++) parts.push(box(4.2, 0.4, 0.14, 0, 1.7 + i * 0.5, -0.85, 0x2f7fb3));
  for (const x of [-1.7, 1.7]) { parts.push(box(0.22, 1.2, 1.4, x, 0.6, -0.2, 0x3b3b3b)); parts.push(box(0.22, 1.1, 0.16, x, 1.75, -0.85, 0x3b3b3b)); }
  return parts;
}

function binTemplate() {
  // Post-mounted green municipal bin.
  return merge([
    cyl(0.08, 0.08, 2.3, 0, 1.15, -0.5, 0x5d6873),
    cyl(0.48, 0.42, 1.2, 0, 1.25, 0, 0x2f8a57),
    cyl(0.5, 0.5, 0.12, 0, 1.9, 0, 0xd9d9d9),
  ]);
}

function bikeRackTemplate() {
  const parts = [box(4.6, 0.12, 0.14, 0, 0.12, 0, 0x7e8891)];
  for (const x of [-1.8, -0.6, 0.6, 1.8]) {
    parts.push(box(0.1, 1.4, 0.1, x - 0.38, 0.75, 0, 0x9aa3ab), box(0.1, 1.4, 0.1, x + 0.38, 0.75, 0, 0x9aa3ab), box(0.86, 0.1, 0.1, x, 1.45, 0, 0x9aa3ab));
  }
  return merge(parts);
}

function shelterTemplate() {
  // Israeli bus shelter, ~6 u: cantilevered roof on back posts, glass back wall, a bench and an
  // advertising panel at one end. The open side (+z) faces the road.
  return merge([
    box(8.8, 0.35, 3.9, 0, 5.95, 0.15, 0x5d6873),
    box(8.8, 0.12, 0.12, 0, 5.72, 2.05, 0x2f9e6e),
    box(0.3, 5.8, 0.3, -4.0, 2.9, -1.55, 0x4d5862), box(0.3, 5.8, 0.3, 4.0, 2.9, -1.55, 0x4d5862), box(0.3, 5.8, 0.3, 0, 2.9, -1.55, 0x4d5862),
    box(7.7, 4.5, 0.1, 0, 3.15, -1.55, 0xbfe1f2),
    box(7.7, 0.18, 0.16, 0, 0.85, -1.55, 0x4d5862),
    box(1.6, 1.2, 0.06, 2.0, 3.6, -1.48, 0xffffff),
    box(6.0, 0.22, 1.0, 0, 1.25, -0.95, 0xd9d4ca), box(0.2, 1.15, 0.8, -2.6, 0.6, -0.95, 0x4d5862), box(0.2, 1.15, 0.8, 2.6, 0.6, -0.95, 0x4d5862),
    box(0.35, 4.6, 2.5, -4.3, 2.75, -0.35, 0xf2f2f2),
    box(0.06, 3.9, 2.1, -4.5, 2.85, -0.35, 0xf28c28), box(0.06, 3.9, 2.1, -4.1, 2.85, -0.35, 0x2f7fb3),
  ]);
}

function busSignTemplate() {
  // Bus stop pole: white plate with a green header, yellow route panel lower down.
  return merge([
    cyl(0.12, 0.12, 7.4, 0, 3.7, 0, 0x9aa3ab),
    box(1.9, 1.9, 0.12, 0, 6.6, 0, 0xffffff), box(1.9, 0.5, 0.14, 0, 7.3, 0, 0x2f9e6e),
    box(0.9, 0.7, 0.15, 0, 6.4, 0, 0x2b3a46),
    box(1.2, 2.0, 0.14, 0, 3.6, 0, 0xf6d84a),
  ]);
}

function trafficLightTemplate(ped) {
  // Pole with a three-aspect head facing +z (oncoming traffic) and, with `ped`, a pedestrian head
  // facing -x (across the road). The lamps themselves are drawn by signalheads.js, so the housings
  // here are dark. The backplate is black too: the drive videos show black heads, no yellow plate.
  const parts = [
    cyl(0.28, 0.32, 0.5, 0, 0.25, 0, 0x3b444c), cyl(0.15, 0.15, 7.4, 0, 3.7, 0, 0x606a73),
    box(1.5, 3.0, 0.08, 0, 5.8, 0.18, 0x2b3035),
    box(0.95, 2.7, 0.7, 0, 5.8, 0.55, 0x1e2226),
  ];
  if (ped) parts.push(box(0.6, 1.4, 0.6, -0.45, 3.2, 0, 0x1e2226));
  return merge(parts);
}

// A second head bolted onto a pole that already stands (back to back with its own head, or turned
// to face another approach): the same housing as trafficLightTemplate, no pole.
function trafficHeadTemplate() {
  return merge([box(1.5, 3.0, 0.08, 0, 5.8, 0.18, 0x2b3035), box(0.95, 2.7, 0.7, 0, 5.8, 0.55, 0x1e2226), box(0.3, 0.3, 0.3, 0, 5.8, 0.05, 0x606a73)]);
}

function pergolaTemplate() {
  // Beach shade pergola with a bench underneath, facing +z (toward the walkway).
  const parts = [];
  for (const x of [-4.5, 4.5]) for (const z of [-2.2, 2.2]) parts.push(box(0.4, 5.2, 0.4, x, 2.6, z, 0xf5efe3));
  for (const z of [-2.2, 2.2]) parts.push(box(9.8, 0.35, 0.35, 0, 5.3, z, 0xf5efe3));
  for (let x = -4.4; x <= 4.41; x += 0.8) parts.push(box(0.28, 0.22, 5.4, x, 5.6, 0, 0xc9a46b));
  for (const g of benchTemplate()) parts.push(g.translate(0, 0, -0.9));
  return merge(parts);
}

// ---------- 2D helpers ----------

function inPoly(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function bbox(r) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const p of r) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}
// Points every `step` along a polyline: [x, z, dirX, dirZ, index].
function* along(pts, step, start = step / 2) {
  let carry = start, k = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], sl = Math.hypot(dx, dz);
    if (sl < 1e-3) continue;
    let t = carry;
    while (t < sl) { yield [a[0] + (dx * t) / sl, a[1] + (dz * t) / sl, dx / sl, dz / sl, k++]; t += step; }
    carry = t - sl;
  }
}
// Offset a polyline sideways by d (positive = left of travel in x-east/z-south, i.e. (dz, -dx)... see n()).
function offsetLine(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    let m = 1;
    if (i > 0 && i < pts.length - 1) {
      // Miter length so the strip keeps its distance at corners, capped on sharp turns.
      const ax = p[0] - a[0], az = p[1] - a[1], la = Math.hypot(ax, az) || 1;
      const cos = (ax / la) * tx + (az / la) * tz;
      m = Math.min(2, 1 / Math.max(0.5, cos));
    }
    out.push([p[0] - tz * d * m, p[1] + tx * d * m]);
  }
  return out;
}
function segDist(x, z, s) {
  const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = s.ax + dx * t, qz = s.az + dz * t;
  return { d: Math.hypot(x - qx, z - qz), qx, qz, t };
}

// Facing angle about +y so local +z points along (fx, fz).
const face = (fx, fz) => Math.atan2(fx, fz);

// Rectangle collider in a prop's local frame (centre ox,oz; half sizes hw,hd).
function rectCollider(x, z, rot, ox, oz, hw, hd, height) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const pts = [[ox - hw, oz - hd], [ox + hw, oz - hd], [ox + hw, oz + hd], [ox - hw, oz + hd]]
    .map(([a, b]) => [x + a * c + b * s, z - a * s + b * c]);
  return { kind: 'prop', height, points: pts };
}

// ---------- main ----------

// opts.trees: the result of buildTrees (src/world/trees.js); its trunk points are claimed first so
// lamps, benches and shelters make room for the mapped trees instead of standing in them.
export async function buildDressing(scene, city, opts = {}) {
  const t0 = performance.now();
  const root = new THREE.Group();
  root.name = 'dressing';
  scene.add(root);
  const colliders = [];
  const roads = (city && city.roads) || [];
  const allColliders = (city && city.colliders) || [];

  // ---- ground height: terrain if loaded, bridge decks via city.heightAt ----
  let groundAt = () => 0;
  try { const tm = await import('./terrain.js'); if (typeof tm.groundAt === 'function') groundAt = tm.groundAt; } catch (e) { /* flat world */ }
  const ground = (x, z) => {
    let y = 0;
    try { y = city && typeof city.heightAt === 'function' ? city.heightAt(x, z, 0) : groundAt(x, z); } catch (e) { y = 0; }
    return Number.isFinite(y) ? y : 0;
  };

  // ---- carriageway grid: the hard veto ----
  const RC = 32, RPAD = 7;
  const rgrid = new Map();
  const rkey = (i, j) => i * 100003 + j;
  const roadInfo = roads.map((r) => ({ boulevard: BOULEVARD.test(r.kind || '') }));
  roads.forEach((rd, ri) => {
    if (!rd.points || rd.points.length < 2 || rd.tunnel) return;
    const kind = rd.kind || '';
    const car = CARRIAGE.test(kind);
    const path = !car && kind !== 'promenade';
    if (!car && !path && kind !== 'promenade') return;
    const hw = (rd.width || 4) / 2;
    // Bridge decks get extra clearance: nothing may stand under or on them.
    const extra = rd.bridge ? 3 : 0;
    for (let i = 0; i < rd.points.length - 1; i++) {
      const a = rd.points[i], b = rd.points[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-3) continue;
      const s = { ax: a[0], az: a[1], bx: b[0], bz: b[1], tx: (b[0] - a[0]) / len, tz: (b[1] - a[1]) / len, hw, extra, ri, car, rail: /rail|tram/.test(kind), path, prom: kind === 'promenade', cycle: kind === 'cycleway', big: BIG.test(kind) };
      const pad = hw + extra + RPAD;
      const i0 = Math.floor((Math.min(a[0], b[0]) - pad) / RC), i1 = Math.floor((Math.max(a[0], b[0]) + pad) / RC);
      const j0 = Math.floor((Math.min(a[1], b[1]) - pad) / RC), j1 = Math.floor((Math.max(a[1], b[1]) + pad) / RC);
      for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) {
        const k = rkey(ii, jj);
        let l = rgrid.get(k);
        if (!l) rgrid.set(k, (l = []));
        l.push(s);
      }
    }
  });
  const cellSegs = (x, z) => rgrid.get(rkey(Math.floor(x / RC), Math.floor(z / RC))) || [];
  // True when a disc of radius r at (x, z) stays off every carriageway (and off cycle paths;
  // `avoidPaths` also keeps it off footways other than the promenade).
  const offRoad = (x, z, r, avoidPaths = false) => {
    for (const s of cellSegs(x, z)) {
      if (s.prom) continue;
      if (s.path && !s.cycle && !avoidPaths) continue;
      const lim = s.hw + s.extra + (s.path ? Math.min(r, 0.6) : r);
      if (segDist(x, z, s).d < lim) return false;
    }
    return true;
  };
  // Nearest carriageway segment (car roads, no rail) roughly parallel to direction (tx, tz).
  const nearestCar = (x, z, tx, tz, maxD = 30, minDot = 0.75, skip = null) => {
    let best = null;
    const ci = Math.floor(x / RC), cj = Math.floor(z / RC);
    const seen = new Set();
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      for (const s of rgrid.get(rkey(i, j)) || []) {
        if (!s.car || s.rail || seen.has(s) || (skip && skip.test(roads[s.ri].kind))) continue;
        seen.add(s);
        if (tx !== undefined && Math.abs(s.tx * tx + s.tz * tz) < minDot) continue;
        const r = segDist(x, z, s);
        if (r.d < maxD && (!best || r.d - s.hw < best.d - best.s.hw)) best = { s, d: r.d, qx: r.qx, qz: r.qz };
      }
    }
    return best;
  };

  // ---- buildings, water, landmark sites: the soft veto ----
  const BC = 50, bgrid = new Map();
  const solids = allColliders.filter((c) => c && c.points && c.points.length >= 3 && c.kind !== 'prop');
  let landmarkSites = [];
  try {
    const lm = await import('./landmarks.js');
    landmarkSites = (lm.LANDMARK_FOOTPRINTS || []).map((e) => (Array.isArray(e) ? e : e && e.points)).filter((r) => r && r.length >= 3);
  } catch (e) { /* landmarks are optional */ }
  for (const r of [...solids.map((c) => c.points), ...landmarkSites]) {
    const bb = bbox(r);
    if ((bb.maxX - bb.minX) * (bb.maxZ - bb.minZ) > 4e8) continue;
    for (let i = Math.floor(bb.minX / BC); i <= Math.floor(bb.maxX / BC); i++)
      for (let j = Math.floor(bb.minZ / BC); j <= Math.floor(bb.maxZ / BC); j++) {
        const k = rkey(i, j);
        let l = bgrid.get(k);
        if (!l) bgrid.set(k, (l = []));
        l.push(r);
      }
  }
  const inSolid = (x, z) => {
    const l = bgrid.get(rkey(Math.floor(x / BC), Math.floor(z / BC)));
    return !!l && l.some((r) => inPoly(x, z, r));
  };
  const clearOfSolids = (x, z, r) => !inSolid(x, z) && (r <= 0.3 || (!inSolid(x + r, z) && !inSolid(x - r, z) && !inSolid(x, z + r) && !inSolid(x, z - r)));

  // ---- occupancy: props never stack ----
  const OC = 12, occ = new Map();
  const free = (x, z, r) => {
    const ci = Math.floor(x / OC), cj = Math.floor(z / OC);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
      for (const o of occ.get(rkey(i, j)) || []) if (Math.hypot(o[0] - x, o[1] - z) < o[2] + r) return false;
    return true;
  };
  const claim = (x, z, r) => {
    const k = rkey(Math.floor(x / OC), Math.floor(z / OC));
    let l = occ.get(k);
    if (!l) occ.set(k, (l = []));
    l.push([x, z, Math.min(r, OC)]);
  };
  // Mapped trees first: a lamp slot that lands on a real tree is skipped, never the tree.
  const treePoints = (opts && opts.trees && opts.trees.points) || [];
  for (const [x, z, r] of treePoints) claim(x, z, Math.max(1.2, r || 1.5));

  // ---- instance buckets ----
  const chunks = new Map();
  const stats = {};
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const put = (type, x, z, rot, s = 1, y = ground(x, z)) => {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let c = chunks.get(k);
    if (!c) chunks.set(k, (c = { cx: (Math.floor(x / CHUNK) + 0.5) * CHUNK, cz: (Math.floor(z / CHUNK) + 0.5) * CHUNK, lists: {} }));
    q.setFromAxisAngle(up, rot);
    m4.compose(v.set(x, y, z), q, sc.set(s, s, s));
    (c.lists[type] || (c.lists[type] = [])).push(m4.clone());
    stats[type] = (stats[type] || 0) + 1;
  };
  // Place a prop only if the whole disc is off the road, off buildings and unclaimed.
  const tryPut = (type, x, z, rot, r, opts = {}) => {
    if (!offRoad(x, z, r, opts.avoidPaths)) return false;
    if (!clearOfSolids(x, z, opts.solidR ?? r)) return false;
    if (!free(x, z, opts.claimR ?? r)) return false;
    claim(x, z, opts.claimR ?? r);
    put(type, x, z, rot, opts.scale ?? 1);
    if (opts.collider) colliders.push(opts.collider(x, z, rot));
    return true;
  };

  // ---- shop hotspots (amenities from the baked data, plus commercial buildings) ----
  const SG = 40, shops = new Map();
  const addShop = (x, z) => { const k = rkey(Math.floor(x / SG), Math.floor(z / SG)); let l = shops.get(k); if (!l) shops.set(k, (l = [])); l.push([x, z]); };
  try {
    let amen = city.amenities;
    let blds = null, rs = 1;
    if (!amen) {
      const res = await fetch(new URL('../../data/rishon.json', import.meta.url));
      const data = await res.json();
      rs = SCALE / (data.meta.scale || SCALE);
      amen = data.amenities || [];
      blds = data.buildings || [];
    }
    for (const a of amen) {
      const kind = Array.isArray(a) ? a[0] : a.kind;
      const x = (Array.isArray(a) ? a[3] : a.x) * rs, z = (Array.isArray(a) ? a[4] : a.z) * rs;
      if (SHOP_AMENITY.test(kind || '') && Number.isFinite(x)) addShop(x, z);
    }
    for (const b of blds || []) {
      if (b[1] !== 3) continue;
      const f = b[2];
      let sx = 0, sz = 0, n = 0;
      for (let i = 0; i + 1 < f.length; i += 2) { sx += f[i]; sz += f[i + 1]; n++; }
      if (n) addShop((sx / n) * rs, (sz / n) * rs);
    }
  } catch (e) { console.warn('[dressing] no shop data', e); }
  const nearShop = (x, z, r = 34) => {
    const ci = Math.floor(x / SG), cj = Math.floor(z / SG);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
      for (const p of shops.get(rkey(i, j)) || []) if (Math.hypot(p[0] - x, p[1] - z) < r) return true;
    return false;
  };

  const hops = {};
  const dropped = [];

  // ================= 1. bus stops =================
  let stops = Array.isArray(city.busStops) ? city.busStops : null;
  const stopsReal = !!(stops && stops.length);
  if (!stopsReal) {
    // Fallback until the roads agent provides real stops: every ~300 u on main roads, alternating sides.
    stops = [];
    roads.forEach((rd, ri) => {
      if (!/^(primary|secondary|tertiary)$/.test(rd.kind) || !rd.points || rd.bridge || rd.tunnel) return;
      for (const [x, z, dx, dz, k] of along(rd.points, 300, 120)) {
        const side = (k + ri) % 2 ? 1 : -1, off = rd.width / 2 + 3;
        stops.push({ x: x - dz * off * side, z: z + dx * off * side, name: '' });
      }
    });
  }
  for (const st of stops) {
    if (!Number.isFinite(st.x) || !Number.isFinite(st.z)) continue;
    // Buses run on through roads: prefer those over parking aisles and service lanes.
    const nr = nearestCar(st.x, st.z, undefined, undefined, 40, 0, /^(service|track|motorway)/) || nearestCar(st.x, st.z, undefined, undefined, 40);
    let tx, tz, nx, nz, qx, qz, hw;
    if (nr) {
      tx = nr.s.tx; tz = nr.s.tz; hw = nr.s.hw; qx = nr.qx; qz = nr.qz;
      // Normal from the road toward the stop's side; a stop drawn on the centre line uses `angle`.
      nx = -tz; nz = tx;
      let side = Math.sign((st.x - qx) * nx + (st.z - qz) * nz);
      if (nr.d < 0.5 && Number.isFinite(st.angle)) side = -Math.sign(Math.sin(st.angle) * nx + Math.cos(st.angle) * nz) || 1;
      if (!side) side = 1;
      nx *= side; nz *= side;
    } else if (Number.isFinite(st.angle)) {
      // Shelter faces along `angle`; no road found nearby, so place it where the data says.
      nx = -Math.sin(st.angle); nz = -Math.cos(st.angle); tx = -nz; tz = nx; qx = st.x; qz = st.z; hw = -3;
    } else continue;
    // Try the mapped side first, then the far side (a stop node on the line of a dual carriageway
    // can resolve to the median), sliding along the kerb away from corners and driveways.
    let ok = false;
    for (const sd of [1, -1]) {
      const sx = nx * sd, sz = nz * sd, rot = face(-sx, -sz);
      for (const shift of [0, 6, -6, 12, -12, 18, -18, 26, -26]) {
        const cx = qx + sx * (hw + 3.2) + tx * shift, cz = qz + sz * (hw + 3.2) + tz * shift;
        const corners = [[-4.5, -1.8], [4.5, -1.8], [-4.5, 2.0], [4.5, 2.0], [0, 0]];
        const good = corners.every(([a, b]) => {
          const px = cx + tx * a - sx * b, pz = cz + tz * a - sz * b;
          return offRoad(px, pz, 0.3) && !inSolid(px, pz);
        });
        if (!good || !free(cx, cz, 5)) continue;
        claim(cx, cz, 5);
        put('shelter', cx, cz, rot);
        // Collider on the back wall and the ad panel only, so players can step under the roof.
        colliders.push(rectCollider(cx, cz, rot, 0, -1.55, 4.15, 0.3, 6.1), rectCollider(cx, cz, rot, -4.3, -0.35, 0.25, 1.3, 6.1));
        const px = qx + sx * (hw + 0.7) + tx * (shift + 6), pz = qz + sz * (hw + 0.7) + tz * (shift + 6);
        tryPut('busSign', px, pz, rot, 0.3, { claimR: 0.8 });
        tryPut('bin', cx + tx * 5.6 - sx * 0.6, cz + tz * 5.6 - sz * 0.6, rot, 0.6);
        if (hxz(cx, cz, 3) < 0.35) tryPut('bikeRack', cx - tx * 8 - sx * 0.8, cz - tz * 8 - sz * 0.8, rot, 2.4, { solidR: 2.3 });
        addShop(cx, cz);
        if (!hops.busStop && stats.shelter > 40) hops.busStop = { x: cx + tx * 18 + sx * 1.5, z: cz + tz * 18 + sz * 1.5, lx: cx - sx * 1, lz: cz - sz * 1 };
        ok = true;
        break;
      }
      if (ok) break;
    }
    if (!ok) {
      // No room for a shelter (corner, driveway, building line): the stop still gets its pole.
      outer: for (const sd of [1, -1]) for (const shift of [0, 8, -8, 16, -16, 24, -24]) {
        const px = qx + nx * sd * (hw + 0.7) + tx * shift, pz = qz + nz * sd * (hw + 0.7) + tz * shift;
        if (tryPut('busSign', px, pz, face(-nx * sd, -nz * sd), 0.3, { claimR: 0.8 })) { ok = true; stats.stopsPoleOnly = (stats.stopsPoleOnly || 0) + 1; break outer; }
      }
      if (!ok) { stats.stopsDropped = (stats.stopsDropped || 0) + 1; dropped.push([st.x, st.z, Math.round(nr ? nr.d : -1), roads[nr ? nr.s.ri : 0]?.kind]); }
    }
  }

  // ================= 2. traffic lights from the signal plan =================
  // Round 8 (signals): lights stand only where the plan of src/world/signals.js has a site, that is
  // where OSM maps a signal node (or crossing signals on two arms of a junction) and the junction is
  // not a roundabout or on a deck. One pole per approach, on the driver's right at the stop line,
  // with a pedestrian head where the arm has a zebra. The lamps change with the controller.
  let plan = (city && city.signalPlan) || null;
  if (!plan && city && Array.isArray(city.signals)) {
    try {
      const nm = await import('../vehicles/network.js');
      const sm = await import('./signals.js');
      nm.setGround((x, z) => city.heightAt(x, z, -Infinity));
      plan = sm.buildSignalPlan(city, nm.buildNetwork(city, { light: true }), { ground: (x, z) => city.heightAt(x, z, -Infinity) });
      city.signalPlan = plan;
      // Mid-block crossings the plan adds join the zebras, so cars and people treat them like the rest.
      if (Array.isArray(city.crossings)) city.crossings.push(...plan.newCrossings);
    } catch (e) { console.warn('[dressing] no signal plan', e); }
  }
  let junctions = 0;
  const lit = [], noRoom = [], heads = []; // noRoom: approaches where no pole found a free spot
  const PT = { x: 0, z: 0, tx: 0, tz: 1 };
  if (plan) for (const site of plan.sites) {
    let placed = 0;
    for (const arm of site.arms) {
      if (!arm.stop) continue;
      const type = arm.ped ? 'trafficLightPed' : 'trafficLight';
      // Behind the stop line on the driver's right; when that spot is taken or off the sidewalk,
      // slide back along the road and further out.
      let ok = false;
      // Right kerb first, sliding back and out. Last resorts: the median on the driver's left, then a
      // wider search where carriageways overlap (the widened dual carriageways of the big avenues).
      const cands = [[1.2, 0.9, 1], [1.2, 2.0, 1], [0.2, 0.9, 1], [3, 0.9, 1], [3, 2.0, 1], [5, 2.0, 1], [5, 3.2, 1], [8, 3.2, 1], [11, 4.4, 1], [14, 4.4, 1],
        [1.2, 0.9, -1], [3, 0.9, -1], [3, 2.0, -1], [6, 2.0, -1], [9, 3.2, -1], [12, 3.2, -1]];
      for (const side of [1, -1]) for (const dd of [1.2, 4, 8, 13, 19]) for (const ds of [0.9, 2.2, 3.8, 5.6, 8, 11]) cands.push([dd, ds, side]);
      for (const [dd, ds, side] of site.deck ? [[1.2, 0.7, 1], [3, 0.7, 1], [0.2, 0.7, 1], [1.2, 0.7, -1], [5, 0.7, 1]] : cands) {
        plan.armPoint(arm, dd, side * (arm.e.hw + ds), PT);
        if (plan.nearRing(PT.x, PT.z)) continue; // roundabouts and their entries never get lights
        const rot = face(-PT.tx, -PT.tz);
        // On a raised junction the pole stands on the deck edge at the road's height; the ground
        // veto (bridge clearance) does not apply there.
        let y = ground(PT.x, PT.z);
        if (site.deck) {
          y = plan.armY(arm, dd);
          if (!free(PT.x, PT.z, 3)) continue;
          claim(PT.x, PT.z, 3);
          put(type, PT.x, PT.z, rot, 1, y);
        } else if (!tryPut(type, PT.x, PT.z, rot, 0.45, { claimR: 3 })) continue;
        arm.poles.push({ x: PT.x, z: PT.z, rot });
        heads.push({ site, arm, x: PT.x, y, z: PT.z, rot });
        if (!hops.junction && site.kind === 'junction') hops.junction = { x: PT.x - PT.tx * 26 + PT.tz * 2, z: PT.z - PT.tz * 26 - PT.tx * 2, lx: site.x, lz: site.z };
        ok = true;
        break;
      }
      if (ok) placed++; else noRoom.push([Math.round(site.x), Math.round(site.z), arm.idx]);
    }
    if (placed) { junctions++; lit.push([site.x, site.z]); }
  }

  // Founder 2026-10-30: "more than one light". As on Israeli junctions, every approach also gets a
  // secondary head across the junction (on the far left, back to back with the head of the opposite
  // approach when a pole stands there), and a divided road with two or more lanes a head on its
  // median at the stop line. An approach whose kerb had no room gets its first head this way too.
  const poles = []; // every pole of the plan, for mounting a second head on it
  for (const h of heads) poles.push({ x: h.x, z: h.z, y: h.y, rots: [h.rot] });
  const PG = 16, pgrid = new Map();
  const pk = (x, z) => `${Math.floor(x / PG)},${Math.floor(z / PG)}`;
  for (const p of poles) { const k = pk(p.x, p.z); (pgrid.get(k) || pgrid.set(k, []).get(k)).push(p); }
  const poleNear = (x, z, r) => {
    let best = null, bd = r;
    for (let i = Math.floor((x - r) / PG); i <= Math.floor((x + r) / PG); i++) for (let j = Math.floor((z - r) / PG); j <= Math.floor((z + r) / PG); j++)
      for (const p of pgrid.get(`${i},${j}`) || []) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  const sameRot = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.5;
  // Mount on a pole within reach, else stand a new pole: returns true when the head is up.
  const headAt = (site, arm, x, z, rot, mountR = 2.6, deckY = null) => {
    if (plan.nearRing(x, z)) return false;
    const p = poleNear(x, z, mountR);
    if (p) {
      if (p.rots.some((r) => sameRot(r, rot))) return false;
      p.rots.push(rot);
      put('trafficHead', p.x, p.z, rot, 1, p.y);
      heads.push({ site, arm, x: p.x, y: p.y, z: p.z, rot, ped: false, extra: true });
      return true;
    }
    let y;
    if (deckY != null) {
      if (!free(x, z, 2.2)) return false;
      claim(x, z, 2.2);
      y = deckY;
      put('trafficLight', x, z, rot, 1, y);
    } else {
      if (!tryPut('trafficLight', x, z, rot, 0.45, { claimR: 2.2 })) return false;
      y = ground(x, z);
    }
    const np = { x, z, y, rots: [rot] };
    poles.push(np); (pgrid.get(pk(x, z)) || pgrid.set(pk(x, z), []).get(pk(x, z))).push(np);
    heads.push({ site, arm, x, y, z, rot, ped: false, extra: true });
    return true;
  };
  const R0 = { x: 0, z: 0, tx: 0, tz: 1 }, R1 = { x: 0, z: 0, tx: 0, tz: 1 };
  let extraHeads = 0, farHeads = 0, medianHeads = 0;
  if (plan) for (const site of plan.sites) {
    if (site.kind !== 'junction') continue;
    for (const arm of site.arms) {
      if (!arm.stop) continue;
      // my travel direction and my right, at my stop line
      plan.armPoint(arm, 0, 0, R0);
      plan.armPoint(arm, 0, 1, R1);
      const tx = R0.tx, tz = R0.tz, rx = R1.x - R0.x, rz = R1.z - R0.z;
      const toMe = face(-tx, -tz);
      // far side: the arm leaving straight ahead
      let opp = null, od = -0.75;
      for (const b of site.arms) { if (b === arm) continue; const d = b.ax * arm.ax + b.az * arm.az; if (d < od) { od = d; opp = b; } }
      let far = false;
      if (opp) {
        // on the opposite arm, its right kerb is my far left, its left kerb my far right
        for (const [dd, side] of [[1.2, 1], [3, 1], [-0.5, 1], [1.2, -1], [3, -1], [5, 1], [5, -1]]) {
          for (const ds of [0.9, 2.0, 3.2]) {
            plan.armPoint(opp, dd, side * (opp.e.hw + (site.deck ? 0.7 : ds)), PT);
            if (headAt(site, arm, PT.x, PT.z, toMe, 2.6, site.deck ? plan.armY(opp, dd) : null)) { far = true; break; }
          }
          if (far) break;
        }
      } else if (!site.deck) {
        // the stem of a T: the far kerb of the road ahead
        const across = arm.stopD * 2 + 2;
        for (const extra of [0, 2, 4, 7]) {
          for (const lat of [-arm.e.hw * 0.6, -arm.e.hw * 0.6 - 3, arm.e.hw * 0.6, arm.e.hw * 0.6 + 3, 0]) {
            const x = R0.x + tx * (across + extra) + rx * lat, z = R0.z + tz * (across + extra) + rz * lat;
            if (headAt(site, arm, x, z, toMe)) { far = true; break; }
          }
          if (far) break;
        }
      }
      if (far) { farHeads++; extraHeads++; }
      // median of a divided road with two or more lanes
      if (arm.e.oneway && arm.lanes >= 2 && !arm.poles.some((p) => Math.hypot(p.x - R0.x, p.z - R0.z) < arm.e.hw + 4 && ((p.x - R0.x) * rx + (p.z - R0.z) * rz) < 0)) {
        for (const [dd, ds] of [[1.2, 0.9], [1.2, 1.6], [3, 0.9], [3, 1.6], [0.2, 1.2], [5, 1.2]]) {
          plan.armPoint(arm, dd, -(arm.e.hw + ds), PT);
          if (site.deck) break;
          if (headAt(site, arm, PT.x, PT.z, face(-PT.tx, -PT.tz), 1.2)) { medianHeads++; extraHeads++; break; }
        }
      }
    }
  }

  // ================= 3. boulevard medians: double-arm lamps =================
  roads.forEach((rd, ri) => {
    if (!BIG.test(rd.kind || '') || !rd.points || rd.bridge || rd.tunnel) return;
    const hw = rd.width / 2;
    for (const [x, z, dx, dz, k] of along(rd.points, 18, 9)) {
      const nx = -dz, nz = dx;
      let best = null;
      const ci = Math.floor(x / RC), cj = Math.floor(z / RC);
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
        for (const s of rgrid.get(rkey(i, j)) || []) {
          if (!s.car || s.rail || s.ri === ri || !s.big) continue;
          if (Math.abs(s.tx * dx + s.tz * dz) < 0.96) continue;
          const r = segDist(x, z, s);
          const along_ = (r.qx - x) * dx + (r.qz - z) * dz;
          if (Math.abs(along_) > 3) continue;
          const sd = (r.qx - x) * nx + (r.qz - z) * nz;
          const gap = Math.abs(sd) - hw - s.hw;
          if (gap < 1.4 || gap > 30) continue;
          if (!best || Math.abs(sd) < Math.abs(best.sd)) best = { sd, gap, s };
        }
      }
      if (!best) continue;
      roadInfo[ri].boulevard = true;
      roadInfo[best.s.ri].boulevard = true;
      if (best.s.ri < ri) continue; // the lower-indexed carriageway furnishes the shared median
      const sg = Math.sign(best.sd), off = hw + best.gap / 2;
      const mx = x + nx * sg * off, mz = z + nz * sg * off;
      if (k % 2 === 0) {
        if (tryPut(inCentre(mx, mz) ? 'lampC' : 'lamp2', mx, mz, face(nx, nz), Math.min(0.5, best.gap / 2 - 0.1), { claimR: 3 })) {
          stats.medianLamps = (stats.medianLamps || 0) + 1;
          if (!hops.boulevard && best.gap > 2) hops.boulevard = { x: mx - dx * 30 + nx * sg * 0.1, z: mz - dz * 30, lx: mx + dx * 20, lz: mz + dz * 20, eye: 4.5 };
        }
      }
      // Median palms come from the map (trees.js), not from here.
    }
  });

  // ================= 4. sidewalks: lamps, then benches/bins/racks =================
  // Street trees used to be planted here at every free slot; they now come only from mapped OSM
  // trees and tree rows (trees.js), so the slots between lamps stay open unless the map has a tree.
  let walks = Array.isArray(city.sidewalks) && city.sidewalks.length ? city.sidewalks : null;
  const walksReal = !!walks;
  if (!walksReal) {
    walks = [];
    roads.forEach((rd) => {
      if (!WALKED.test(rd.kind || '') || !rd.points || rd.points.length < 2 || rd.bridge || rd.tunnel) return;
      for (const side of [1, -1]) walks.push({ points: offsetLine(rd.points, side * (rd.width / 2 + 1.5)), roadKind: rd.kind, side });
    });
  }
  const sideBit = (s) => (s === 'left' || s === 'L' || s === -1 || (typeof s === 'number' && s < 0) ? 1 : 0);

  // Each slot is resolved against the carriageway it borders: `nr` points from the sidewalk
  // toward the road and `gap` is the distance from the sidewalk line to the kerb.
  const slots = [];
  walks.forEach((w, wi) => {
    const pts = w.points;
    if (!pts || pts.length < 2) return;
    const kind = w.roadKind || 'residential';
    if (!WALKED.test(kind)) return;
    const big = BIG.test(kind);
    const per = big ? 3 : 4; // free slots per lamp interval
    const step = 12, phase = sideBit(w.side) ? (big ? 0 : 2) : 0;
    for (const [x, z, dx, dz, k] of along(pts, step, step / 2)) {
      const nc = nearestCar(x, z, dx, dz, 28);
      if (!nc) continue;
      const ux = nc.qx - x, uz = nc.qz - z, ul = Math.hypot(ux, uz) || 1;
      slots.push({ x, z, dx, dz, nx: ux / ul, nz: uz / ul, gap: nc.d - nc.s.hw, ri: nc.s.ri, kind, big, lamp: (k + phase) % (per + 1) === 0, k, wi });
    }
  });
  const kerbPoint = (s, fromKerb) => {
    const m = Math.max(-4, Math.min(4, s.gap - fromKerb));
    return [s.x + s.nx * m, s.z + s.nz * m];
  };
  for (const s of slots) {
    if (!s.lamp) continue;
    const [x, z] = kerbPoint(s, 0.8);
    if (tryPut(inCentre(x, z) ? 'lampC' : 'lamp', x, z, face(s.nx, s.nz), 0.45, { claimR: 2.2 })) {
      s.placed = 'lamp';
      // Street-level preview spots: stand on the strip, look down the street.
      const hop = { x: s.x - s.dx * 18 - s.nx * 2.6, z: s.z - s.dz * 18 - s.nz * 2.6, lx: s.x + s.dx * 50 + s.nx * 4, lz: s.z + s.dz * 50 + s.nz * 4, k: s.kind };
      if (!hops.residential && s.kind === 'residential' && nearShop(s.x, s.z, 200) && hxz(x, z, 9) < 0.1) hops.residential = hop;
      if (!hops.avenue && /secondary|primary/.test(s.kind) && nearShop(s.x, s.z) && hxz(x, z, 9) < 0.2) hops.avenue = hop;
    }
  }
  for (const s of slots) {
    const shop = nearShop(s.x, s.z);
    // Benches sit on the building side of the strip, backs to the facades, facing the road.
    // Rates are per free slot; they used to apply only to the few slots street trees left open.
    if (!s.placed && (shop ? hxz(s.x, s.z, 6) < 0.15 : s.big && hxz(s.x, s.z, 6) < 0.03)) {
      const [x, z] = kerbPoint(s, 3.4);
      tryPut('bench', x, z, face(s.nx, s.nz), 1.0, { claimR: 2.3, solidR: 2.2 });
    }
    if (s.placed === 'lamp' && (shop || (s.big && s.k % 3 === 0))) {      const x = s.x + s.nx * Math.max(-4, Math.min(4, s.gap - 0.9)) + s.dx * 1.5, z = s.z + s.nz * Math.max(-4, Math.min(4, s.gap - 0.9)) + s.dz * 1.5;
      tryPut('bin', x, z, face(-s.nx, -s.nz), 0.55, { claimR: 0.7 });
    }
    if (shop && !s.placed && s.k % 4 === 2 && hxz(s.x, s.z, 7) < 0.25) {
      const [x, z] = kerbPoint(s, 3.6);
      tryPut('bikeRack', x + s.dx * 4, z + s.dz * 4, face(s.nx, s.nz), 1.0, { claimR: 2.6, solidR: 2.4 });
    }
  }

  // ================= 4b. crossings: railings on big roads, bollards on shop streets =================
  // Both drive videos show steel along the kerb either side of a busy crossing, so people cross at
  // the zebra and not beside it. Big roads get railing panels, shop streets get a few bollards.
  // The crossing opening itself stays clear.
  const OPEN = 3.6; // half the opening along the kerb, a little wider than the zebra stripes
  // Never between a bus stop and its kerb: people board there.
  const STOP_CLEAR = 13;
  const stopGrid = new Map();
  for (const s of stops) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) continue;
    const k = rkey(Math.floor(s.x / STOP_CLEAR), Math.floor(s.z / STOP_CLEAR));
    let l = stopGrid.get(k);
    if (!l) stopGrid.set(k, (l = []));
    l.push(s);
  }
  const nearStop = (px, pz) => {
    const ci = Math.floor(px / STOP_CLEAR), cj = Math.floor(pz / STOP_CLEAR);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
      for (const s of stopGrid.get(rkey(i, j)) || []) if (Math.hypot(s.x - px, s.z - pz) < STOP_CLEAR) return true;
    return false;
  };
  // Where two zebras sit close together (dual carriageways, short arms), steel beside one must not
  // stand on the landing of the other: every landing is kept clear in a 3.5 u radius.
  const LAND = 3.5, landings = new Map();
  const crossList = Array.isArray(city.crossings) ? city.crossings : [];
  for (const c of crossList) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.width)) continue;
    const tx = Math.sin(c.angle), tz = Math.cos(c.angle);
    for (const side of [1, -1]) {
      const lx = c.x - tz * side * (c.width / 2 + 0.75), lz = c.z + tx * side * (c.width / 2 + 0.75);
      const k = rkey(Math.floor(lx / RC), Math.floor(lz / RC));
      let l = landings.get(k);
      if (!l) landings.set(k, (l = []));
      l.push([lx, lz]);
    }
  }
  const onLanding = (px, pz) => {
    const ci = Math.floor(px / RC), cj = Math.floor(pz / RC);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
      for (const p of landings.get(rkey(i, j)) || []) if (Math.hypot(p[0] - px, p[1] - pz) < LAND) return true;
    return false;
  };
  const fits = (pts, r) => pts.every(([px, pz]) => !nearStop(px, pz) && !onLanding(px, pz) && offRoad(px, pz, r, true) && clearOfSolids(px, pz, r) && free(px, pz, r));
  for (const c of crossList) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.width)) continue;
    const tx = Math.sin(c.angle), tz = Math.cos(c.angle);
    const nc = nearestCar(c.x, c.z, tx, tz, 6);
    if (!nc) continue;
    const big = nc.s.big, shop = nearShop(c.x, c.z, 40);
    if (!big && !shop) continue;
    for (const side of [1, -1]) {
      const nx = -tz * side, nz = tx * side; // from the road centre toward this kerb
      const off = c.width / 2 + 0.75;
      const kx = c.x + nx * off, kz = c.z + nz * off;
      const rot = face(-nx, -nz);
      for (const dir of [1, -1]) {
        if (big) {
          const m = OPEN + 3.0;
          const x = kx + tx * m * dir, z = kz + tz * m * dir;
          const ends = [-2.9, -1.45, 0, 1.45, 2.9].map((o) => [x + tx * o, z + tz * o]);
          if (!fits(ends, 0.35)) continue;
          for (const [px, pz] of ends) claim(px, pz, 0.6);
          put('railing', x, z, rot);
          colliders.push(rectCollider(x, z, rot, 0, 0, 3.0, 0.15, 2.6));
        } else {
          for (let i = 0; i < 3; i++) {
            const m = OPEN + 0.4 + i * 1.7;
            const x = kx + tx * m * dir, z = kz + tz * m * dir;
            if (!fits([[x, z]], 0.3)) break;
            claim(x, z, 0.5);
            put('bollard', x, z, 0);
            colliders.push(rectCollider(x, z, 0, 0, 0, 0.26, 0.26, 2.2));
          }
        }
      }
    }
  }

  // Junction corners (nodes shared by 3+ arms): poles stand outside the widest half width + 3 u.
  const poleNodes = (Array.isArray(city.junctionNodes) ? city.junctionNodes : []).map((j) => ({ x: j.x, z: j.z, r: Math.max(...j.arms.map((a) => a.hw)) + 3 }));
  const inMouthPole = (x, z) => poleNodes.some((n) => Math.abs(n.x - x) < n.r && Math.abs(n.z - z) < n.r && Math.hypot(n.x - x, n.z - z) < n.r);
  // ================= 4a. overhead lines in the old estates =================
  // A concrete pole every third slot (about 36 u) on one side of each residential-type street in
  // an old zone, joined by three wires. Poles only go where tryPut finds the kerb strip free, and
  // a wire is drawn only between two poles that were both placed, so none hangs from nothing.
  const wireSegs = new Map(); // chunk key -> flat [x,y,z,x,y,z,...] line segments
  const addWire = (ax, ay, az, bx, by, bz) => {
    const k = `${Math.floor(((ax + bx) / 2) / CHUNK)},${Math.floor(((az + bz) / 2) / CHUNK)}`;
    let a = wireSegs.get(k);
    if (!a) wireSegs.set(k, (a = []));
    a.push(ax, ay, az, bx, by, bz);
  };
  {
    const placed = []; // every pole so far: { x, z, y, nx, nz, links }
    let poles = 0, spans = 0;
    for (const s of slots) {
      if (s.k % 3 !== 1 || !/^(residential|unclassified|tertiary|living_street)$/.test(s.kind) || !inOldZone(s.x, s.z)) continue;
      if (walks[s.wi] && walks[s.wi].side !== undefined && sideBit(walks[s.wi].side)) continue; // one side only
      const [x, z] = kerbPoint(s, 0.9);
      if (onLanding(x, z) || nearStop(x, z) || inMouthPole(x, z)) continue;
      const rot = face(s.nx, s.nz);
      if (!tryPut('pole', x, z, rot, 0.3, { claimR: 2.0, avoidPaths: true, collider: (px, pz, r) => rectCollider(px, pz, r, 0, 0, 0.3, 0.3, 10.4) })) continue;
      poles++;
      const y0 = ground(x, z) + 9.7;
      // Join the nearest earlier pole that lies along this street (within 55 u, roughly in line)
      // and has a free end; the line then runs unbroken across short sidewalk pieces.
      let prev = null, bd = 55;
      for (let i = placed.length - 1; i >= 0 && i > placed.length - 400; i--) {
        const q = placed[i];
        if (q.links >= 2) continue;
        const d = Math.hypot(x - q.x, z - q.z);
        if (d < bd && d > 8 && Math.abs(((x - q.x) * s.dx + (z - q.z) * s.dz) / d) > 0.85) { bd = d; prev = q; }
      }
      const me = { x, z, y: y0, nx: s.nx, nz: s.nz, links: 0 };
      if (prev) {
        spans++; prev.links++; me.links++;
        for (const o of [-1.0, 0, 1.0]) {
          const ax = prev.x + prev.nx * o, az = prev.z + prev.nz * o, bx = x + s.nx * o, bz = z + s.nz * o;
          const N = 4, sag = 0.7;
          const f = (t) => 1 - 4 * (t - 0.5) * (t - 0.5); // 0 at the poles, 1 mid-span
          for (let i = 0; i < N; i++) {
            const t0 = i / N, t1 = (i + 1) / N;
            addWire(ax + (bx - ax) * t0, prev.y + (y0 - prev.y) * t0 - sag * f(t0), az + (bz - az) * t0, ax + (bx - ax) * t1, prev.y + (y0 - prev.y) * t1 - sag * f(t1), az + (bz - az) * t1);
          }
        }
      }
      placed.push(me);
    }
    stats.poleSpans = spans;
  }

  // ================= 4c. convex mirrors at residential T-junctions =================
  // A third of the T-junctions between small streets get a mirror on the far kerb of the through
  // street, facing down the stem, as in the older east neighbourhoods.
  for (const j of Array.isArray(city.junctionNodes) ? city.junctionNodes : []) {
    if (!j.arms || j.arms.length !== 3 || j.arms.some((a) => a.link || a.rank > 3 || a.rank < 2)) continue;
    if (hxz(j.x, j.z, 41) > 0.34) continue;
    // The stem is the arm with no partner pointing the opposite way.
    const stem = j.arms.find((a) => !j.arms.some((b) => b !== a && a.ax * b.ax + a.az * b.az < -0.8));
    if (!stem || j.arms.filter((a) => a !== stem).some((a) => Math.abs(a.ax * stem.ax + a.az * stem.az) > 0.5)) continue;
    const thru = Math.max(...j.arms.filter((a) => a !== stem).map((a) => a.hw));
    const d = thru + 1.6, x = j.x - stem.ax * d, z = j.z - stem.az * d;
    if (tryPut('mirror', x, z, face(stem.ax, stem.az), 0.35, { claimR: 0.9, avoidPaths: true })) colliders.push(rectCollider(x, z, face(stem.ax, stem.az), 0, 0, 0.15, 0.15, 7.6));
  }

  // ================= 5. promenade kit =================
  roads.forEach((rd) => {
    if (rd.kind !== 'promenade' || !rd.points || rd.points.length < 2) return;
    const hw = rd.width / 2;
    for (const e of [1, -1]) {
      const edge = offsetLine(rd.points, e * (hw + 1.3));
      for (const [x, z, dx, dz, k] of along(edge, 10, e > 0 ? 5 : 10)) {
        const nx = -dz * e, nz = dx * e; // outward from the walkway
        const slot = k % 4;
        // Slot 0 used to hold a date palm; promenade palms now come from the map (trees.js).
        if (slot === 2) {
          if (tryPut('bench', x - nx * 0.4, z - nz * 0.4, face(-nx, -nz), 1.0, { avoidPaths: true, claimR: 2.3, solidR: 2.2 }) && !hops.promenade)
            hops.promenade = { x: x - nx * (hw + 1) - dx * 30, z: z - nz * (hw + 1) - dz * 30, lx: x + dx * 30, lz: z + dz * 30 };
        } else if (slot === 1 && k % 8 === 1) tryPut('promLamp', x - nx * 0.6, z - nz * 0.6, 0, 0.4, { avoidPaths: true, claimR: 2 });
      }
      // Shade pergolas on the landward side (east, away from the sea).
      for (const [x, z, dx, dz] of along(rd.points, 130, 60)) {
        const nx = -dz * e, nz = dx * e;
        if (nx < 0.2) continue;
        const px = x + nx * (hw + 4.2), pz = z + nz * (hw + 4.2);
        tryPut('pergola', px, pz, face(-nx, -nz), 4.8, { avoidPaths: true, claimR: 5.5, solidR: 4.8 });
      }
    }
  });

  // ---- emit: one InstancedMesh per type per chunk ----
  const gradientMap = (() => {
    const t = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t;
  })();
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap });
  const tpl = {
    lamp: lampTemplate(false), lamp2: lampTemplate(true), lampC: lampCentreTemplate(), promLamp: promLampTemplate(),
    railing: railingTemplate(), bollard: bollardTemplate(), mirror: mirrorTemplate(), pole: poleTemplate(),
    bench: merge(benchTemplate()), bin: binTemplate(), bikeRack: bikeRackTemplate(),
    shelter: shelterTemplate(), busSign: busSignTemplate(), trafficLight: trafficLightTemplate(false), trafficLightPed: trafficLightTemplate(true), trafficHead: trafficHeadTemplate(),
    pergola: pergolaTemplate(),
  };
  const cull = [];
  for (const [k, c] of chunks) {
    const g = new THREE.Group();
    g.name = `dressing ${k}`;
    for (const [type, list] of Object.entries(c.lists)) {
      const im = new THREE.InstancedMesh(tpl[type], mat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = SHADOW.has(type);
      im.name = type;
      g.add(im);
      cull.push({ im, cx: c.cx, cz: c.cz, r2: (DRAW[type] + CHUNK * 0.72) ** 2 });
    }
    root.add(g);
  }
  // Wires: one mesh per chunk of thin crossed ribbons (a 1 px line vanishes at street distance),
  // hidden beyond WIRE_DRAW like the props.
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x2e3236, side: THREE.DoubleSide });
  const WW = 0.17;
  for (const [k, arr] of wireSegs) {
    const [ci, cj] = k.split(',').map(Number);
    const n = arr.length / 6, pos = new Float32Array(n * 12 * 3);
    let o = 0;
    const tri = (a1, a2, a3) => { for (const q of [a1, a2, a3]) { pos[o++] = q[0]; pos[o++] = q[1]; pos[o++] = q[2]; } };
    for (let i = 0; i < n; i++) {
      const [ax, ay, az, bx, by, bz] = arr.slice(i * 6, i * 6 + 6);
      const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1, px = (-dz / l) * WW, pz = (dx / l) * WW;
      const A1 = [ax, ay + WW, az], A2 = [ax, ay - WW, az], B1 = [bx, by + WW, bz], B2 = [bx, by - WW, bz];
      const C1 = [ax + px, ay, az + pz], C2 = [ax - px, ay, az - pz], D1 = [bx + px, by, bz + pz], D2 = [bx - px, by, bz - pz];
      tri(A1, A2, B1); tri(B1, A2, B2); tri(C1, C2, D1); tri(D1, C2, D2);
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g2.computeBoundingSphere();
    const wm = new THREE.Mesh(g2, wireMat);
    wm.name = 'wires';
    wm.userData.outlineParameters = { visible: false };
    root.add(wm);
    cull.push({ im: wm, cx: (ci + 0.5) * CHUNK, cz: (cj + 0.5) * CHUNK, r2: (WIRE_DRAW + CHUNK * 0.72) ** 2 });
  }
  // Distance culling rides on the scene's render hook so it works in the game and the preview alike.
  const prevHook = scene.onBeforeRender;
  scene.onBeforeRender = function (renderer, sc2, camera, ...rest) {
    if (prevHook) prevHook.call(this, renderer, sc2, camera, ...rest);
    const p = camera.position;
    for (const e of cull) { const dx = e.cx - p.x, dz = e.cz - p.z; e.im.visible = dx * dx + dz * dz < e.r2; }
  };

  let signalMeshes = null;
  if (plan && heads.length) {
    try {
      const hm = await import('./signalheads.js');
      signalMeshes = hm.buildSignalMeshes(scene, plan, heads, { ground });
    } catch (e) { console.warn('[dressing] signal lamps failed', e); }
  }

  root.userData.stats = { ...stats, junctions, signals: plan ? { ...plan.stats, heads: heads.length, extraHeads, farHeads, medianHeads, ...(signalMeshes ? signalMeshes.stats : {}) } : null, chunks: chunks.size, meshes: cull.length, colliders: colliders.length, sidewalks: walksReal ? 'city' : 'derived', busStops: stopsReal ? 'city' : 'derived', ms: Math.round(performance.now() - t0) };
  root.userData.hops = hops;
  root.userData.lightsNoRoom = noRoom;
  root.userData.droppedStops = dropped;
  root.userData.debug = { offRoad, inSolid };
  return { colliders, group: root };
}
