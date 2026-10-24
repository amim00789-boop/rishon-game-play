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
import { SCALE } from '../geo.js';

const CHUNK = 640;
const CARRIAGE = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(residential|service|unclassified|living_street|road|busway|track|rail|tram|light_rail)$/;
const BIG = /^(trunk|primary|secondary|tertiary)(_link)?$/;
const BOULEVARD = /^(trunk|primary)(_link)?$/;
const WALKED = /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/;
const SHOP_AMENITY = /restaurant|cafe|fast_food|bank|pharmacy|ice_cream|pub|bar|post_office|clinic|bureau_de_change|atm|library|cinema|marketplace|doctors|dentist/;

// Draw distance per prop type (world units). Beyond this the chunk's mesh for that type is hidden.
const DRAW = {
  lamp: 750, lamp2: 750, promLamp: 600, shelter: 700, busSign: 450, trafficLight: 600, trafficLightPed: 600,
  bench: 320, bin: 260, bikeRack: 260, pergola: 700,
};
const SHADOW = new Set(['lamp', 'lamp2', 'promLamp', 'shelter', 'pergola', 'trafficLight', 'trafficLightPed']);

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

function lampTemplate(double = false) {
  // Galvanised street lamp, ~11.5 u. The arm reaches out over the kerb toward the road.
  const parts = [cyl(0.36, 0.42, 0.8, 0, 0.4, 0, 0x4a545e), cyl(0.13, 0.2, 11, 0, 5.5, 0, 0x8794a0)];
  for (const s of double ? [1, -1] : [1]) {
    parts.push(box(0.14, 0.14, 2.6, 0, 10.9, 1.25 * s, 0x8794a0));
    parts.push(box(0.75, 0.32, 1.5, 0, 10.85, 2.6 * s, 0x5b6670));
    parts.push(box(0.55, 0.1, 1.15, 0, 10.65, 2.6 * s, 0xfff0b8));
  }
  parts.push(cyl(0.2, 0.13, 0.4, 0, 11.2, 0, 0x5b6670));
  return merge(parts);
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
  // here are dark.
  const parts = [
    cyl(0.28, 0.32, 0.5, 0, 0.25, 0, 0x3b444c), cyl(0.15, 0.15, 7.4, 0, 3.7, 0, 0x606a73),
    box(1.5, 3.0, 0.08, 0, 5.8, 0.18, 0xf2c84b),
    box(0.95, 2.7, 0.7, 0, 5.8, 0.55, 0x1e2226),
  ];
  if (ped) parts.push(box(0.6, 1.4, 0.6, -0.45, 3.2, 0, 0x1e2226));
  return merge(parts);
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
      for (const [dd, ds, side] of cands) {
        plan.armPoint(arm, dd, side * (arm.e.hw + ds), PT);
        if (plan.nearRing(PT.x, PT.z)) continue; // roundabouts and their entries never get lights
        const rot = face(-PT.tx, -PT.tz);
        if (!tryPut(type, PT.x, PT.z, rot, 0.45, { claimR: 3 })) continue;
        arm.poles.push({ x: PT.x, z: PT.z, rot });
        heads.push({ site, arm, x: PT.x, y: ground(PT.x, PT.z), z: PT.z, rot });
        if (!hops.junction && site.kind === 'junction') hops.junction = { x: PT.x - PT.tx * 26 + PT.tz * 2, z: PT.z - PT.tz * 26 - PT.tx * 2, lx: site.x, lz: site.z };
        ok = true;
        break;
      }
      if (ok) placed++; else noRoom.push([Math.round(site.x), Math.round(site.z), arm.idx]);
    }
    if (placed) { junctions++; lit.push([site.x, site.z]); }
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
        if (tryPut('lamp2', mx, mz, face(nx, nz), Math.min(0.5, best.gap / 2 - 0.1), { claimR: 3 })) {
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
    if (tryPut('lamp', x, z, face(s.nx, s.nz), 0.45, { claimR: 2.2 })) {
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
    if (s.placed === 'lamp' && (shop || (s.big && s.k % 3 === 0))) {
      const x = s.x + s.nx * Math.max(-4, Math.min(4, s.gap - 0.9)) + s.dx * 1.5, z = s.z + s.nz * Math.max(-4, Math.min(4, s.gap - 0.9)) + s.dz * 1.5;
      tryPut('bin', x, z, face(-s.nx, -s.nz), 0.55, { claimR: 0.7 });
    }
    if (shop && !s.placed && s.k % 4 === 2 && hxz(s.x, s.z, 7) < 0.25) {
      const [x, z] = kerbPoint(s, 3.6);
      tryPut('bikeRack', x + s.dx * 4, z + s.dz * 4, face(s.nx, s.nz), 1.0, { claimR: 2.6, solidR: 2.4 });
    }
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
    lamp: lampTemplate(false), lamp2: lampTemplate(true), promLamp: promLampTemplate(),
    bench: merge(benchTemplate()), bin: binTemplate(), bikeRack: bikeRackTemplate(),
    shelter: shelterTemplate(), busSign: busSignTemplate(), trafficLight: trafficLightTemplate(false), trafficLightPed: trafficLightTemplate(true),
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

  root.userData.stats = { ...stats, junctions, signals: plan ? { ...plan.stats, heads: heads.length, ...(signalMeshes ? signalMeshes.stats : {}) } : null, chunks: chunks.size, meshes: cull.length, colliders: colliders.length, sidewalks: walksReal ? 'city' : 'derived', busStops: stopsReal ? 'city' : 'derived', ms: Math.round(performance.now() - t0) };
  root.userData.hops = hops;
  root.userData.lightsNoRoom = noRoom;
  root.userData.droppedStops = dropped;
  root.userData.debug = { offRoad, inSolid };
  return { colliders, group: root };
}
