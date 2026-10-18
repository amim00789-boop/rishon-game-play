// Parking lots from data/rishon.extras.json: asphalt draped on the terrain, painted stalls,
// kerbs with an entrance gap, light poles, trees in islands, multi-storey garages (stalls on the
// roof only) and underground entrances. Cars are not drawn here: the traffic module fills
// lots[].stalls.
//
// buildParking(scene, city, extras, { exclude, colliders }) -> { lots, colliders, group }
//   lots[i]   = { id, points, kind, name, capacity, inferred (0 tagged, 1 from parking aisles, 2 from tower
//               service loops), covered, entrance?, ramp?, stalls: [{ x, z, y, angle, w, l }] }
//   opts.towerLots = false drops the weaker tier-2 lots.
//   stall     = centre (x, z), surface height y, `angle` = rotation.y of a car model whose nose faces
//               +z when parked nose-in (nose points away from the aisle), w x l = stall size in units.
//   colliders = light poles, tree trunks, garage blocks, underground entrance hoods.
import * as THREE from 'three';
import { SCALE } from '../geo.js';

let groundAt = () => 0;
try {
  const t = await import('./terrain.js');
  if (typeof t.groundAt === 'function') groundAt = t.groundAt;
} catch (e) {
  console.warn('[parking] terrain.js unavailable, lots sit at y = 0', e);
}

// Same stylisation as the road network (city.js WIDEN): avatars and cars are about 2x human scale,
// so a stall is a real 2.5 m x 5 m bay widened by the same factor as the lanes it opens onto.
const WIDEN = 1.4;
const U = (metres) => metres * SCALE * WIDEN;
export const STALL_W = U(2.5);
export const STALL_L = U(5.0);
const STALL_L_SHORT = U(4.3); // fallback depth when a full stall would touch a neighbour or wall
const AISLE = U(6.0); // aisle between facing rows in lots without mapped aisles
const ISLAND_EVERY = 10; // every Nth slot in a row becomes a planted island
const CHUNK = 1200;
const Y_LOT = 0.1; // above grass (0.04-0.08), under paths (0.12) and roads (0.15+)
const Y_LINE = 0.135;
const LINE_W = 0.28;
const KERB_H = 0.35, KERB_W = 0.5;
const FLOOR = 4.5; // garage storey height in units (city.js floors are 4)

const C = (hex) => new THREE.Color(hex);
const COL = {
  asphalt: C(0x5c5f66), asphaltRoof: C(0x55585e), line: C(0xf3f1e7), kerb: C(0xc9c5bb), island: C(0x79bf55),
  concrete: C(0xd8d2c4), concreteDark: C(0xb9b2a3), stripe: C(0xf2c230), mouth: C(0x1d1f24), ramp: C(0x6a6d73),
};

const DATA_URL = new URL('../../data/rishon.extras.json', import.meta.url);

// Fetches the shared extras file; null when it does not exist yet (the city then has no lots).
export async function loadExtras(url = DATA_URL) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[parking] no extras data', e);
    return null;
  }
}

// ---------- geometry helpers ----------

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
function signedArea(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}
function centroid(r) {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const x = ax + dx * t - px, z = az + dz * t - pz;
  return { d2: x * x + z * z, x: ax + dx * t, z: az + dz * t };
}
// Rectangle as centre, unit nose direction (dx, dz), half width, half length.
function rectCorners(cx, cz, dx, dz, hw, hl) {
  const px = -dz, pz = dx;
  return [
    [cx + dx * hl + px * hw, cz + dz * hl + pz * hw], [cx + dx * hl - px * hw, cz + dz * hl - pz * hw],
    [cx - dx * hl - px * hw, cz - dz * hl - pz * hw], [cx - dx * hl + px * hw, cz - dz * hl + pz * hw],
  ];
}
function rectsOverlap(a, b) {
  // Separating axis test on two oriented rectangles given as corner lists.
  for (const r of [a, b]) {
    for (let i = 0; i < 2; i++) {
      const p = r[i], q = r[i + 1];
      const ax = q[0] - p[0], az = q[1] - p[1];
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const c of a) { const v = c[0] * ax + c[1] * az; if (v < a0) a0 = v; if (v > a1) a1 = v; }
      for (const c of b) { const v = c[0] * ax + c[1] * az; if (v < b0) b0 = v; if (v > b1) b1 = v; }
      if (a1 <= b0 || b1 <= a0) return false;
    }
  }
  return true;
}

class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 73856093 + j; }
  addBox(item, minX, minZ, maxX, maxZ) {
    const s = this.cell;
    for (let i = Math.floor(minX / s); i <= Math.floor(maxX / s); i++)
      for (let j = Math.floor(minZ / s); j <= Math.floor(maxZ / s); j++) {
        const k = this.key(i, j);
        let l = this.map.get(k);
        if (!l) this.map.set(k, (l = []));
        l.push(item);
      }
  }
  at(x, z) { return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))); }
  query(minX, minZ, maxX, maxZ, out = new Set()) {
    const s = this.cell;
    for (let i = Math.floor(minX / s); i <= Math.floor(maxX / s); i++)
      for (let j = Math.floor(minZ / s); j <= Math.floor(maxZ / s); j++) {
        const l = this.map.get(this.key(i, j));
        if (l) for (const it of l) out.add(it);
      }
    return out;
  }
}

// Triangles with position/normal/colour; y is absolute (callers sample the ground themselves).
class Acc {
  constructor() { this.p = []; this.n = []; this.c = []; }
  get empty() { return this.p.length === 0; }
  tri(a, b, c, col, up = true) {
    let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    let vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (up && ny < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const v of [a, b, c]) { this.p.push(v[0], v[1], v[2]); this.n.push(nx / l, ny / l, nz / l); this.c.push(col.r, col.g, col.b); }
  }
  quad(a, b, c, d, col, up = true) { this.tri(a, b, c, col, up); this.tri(a, c, d, col, up); }
  // Vertical quad from two ground points, facing `out` (the side the normal points to).
  wall(a, b, y0a, y0b, y1a, y1b, col, outX, outZ) {
    const v = [[a[0], y0a, a[1]], [b[0], y0b, b[1]], [b[0], y1b, b[1]], [a[0], y1a, a[1]]];
    const nx = -(b[1] - a[1]), nz = b[0] - a[0];
    if (nx * outX + nz * outZ >= 0) this.quad(v[0], v[1], v[2], v[3], col, false);
    else this.quad(v[0], v[3], v[2], v[1], col, false);
  }
  box(cx, cz, dx, dz, hw, hl, y0, y1, top, side) {
    const k = rectCorners(cx, cz, dx, dz, hw, hl);
    this.quad([k[0][0], y1, k[0][1]], [k[1][0], y1, k[1][1]], [k[2][0], y1, k[2][1]], [k[3][0], y1, k[3][1]], top);
    for (let i = 0; i < 4; i++) {
      const a = k[i], b = k[(i + 1) % 4];
      this.wall(a, b, y0, y0, y1, y1, side, (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// Polygon (with holes) split into triangles no longer than maxEdge, y from yOf(x, z).
function fillDense(acc, outer, holes, yOf, col, maxEdge = 10) {
  const v2 = (r) => r.map((p) => new THREE.Vector2(p[0], p[1]));
  let pts = outer.slice();
  const hs = (holes || []).filter((h) => h.length >= 3);
  let tris;
  try { tris = THREE.ShapeUtils.triangulateShape(v2(outer), hs.map(v2)); } catch { return; }
  for (const h of hs) pts = pts.concat(h);
  const m2 = maxEdge * maxEdge;
  const stack = tris.map((t) => [pts[t[0]], pts[t[1]], pts[t[2]]]);
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const [a, b, c] = stack.pop();
    const ab = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2, bc = (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2, ca = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2;
    const mx = Math.max(ab, bc, ca);
    if (mx <= m2) { acc.tri([a[0], yOf(a[0], a[1]), a[1]], [b[0], yOf(b[0], b[1]), b[1]], [c[0], yOf(c[0], c[1]), c[1]], col); continue; }
    if (mx === ab) { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; stack.push([a, m, c], [m, b, c]); }
    else if (mx === bc) { const m = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]; stack.push([a, b, m], [a, m, c]); }
    else { const m = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; stack.push([a, b, m], [m, b, c]); }
  }
}

// Orientation (radians) of the minimum-area bounding rectangle, rotated so u runs along the long side.
function longAxis(r) {
  let best = Infinity, ang = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const t = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const ca = Math.cos(t), sa = Math.sin(t);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of r) {
      const u = p[0] * ca + p[1] * sa, v = -p[0] * sa + p[1] * ca;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best - 1e-6) { best = area; ang = (u1 - u0) >= (v1 - v0) ? t : t + Math.PI / 2; }
  }
  return ang;
}

// ---------- prop templates ----------

function coloured(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function merge(parts) {
  const out = new THREE.BufferGeometry();
  const keys = ['position', 'normal', 'color'];
  for (const k of keys) {
    const arrs = parts.map((p) => p.attributes[k].array);
    const total = arrs.reduce((s, a) => s + a.length, 0), m = new Float32Array(total);
    let o = 0;
    for (const a of arrs) { m.set(a, o); o += a.length; }
    out.setAttribute(k, new THREE.BufferAttribute(m, 3));
  }
  out.computeBoundingSphere();
  return out;
}
function treeTemplate() {
  const trunk = coloured(new THREE.CylinderGeometry(0.35, 0.5, 3.2, 6).translate(0, 1.6, 0), 0x8a5a3b);
  const crown = coloured(new THREE.IcosahedronGeometry(2.4, 0).translate(0, 4.6, 0), 0x5fae45);
  const crown2 = coloured(new THREE.IcosahedronGeometry(1.6, 0).translate(0.9, 5.9, 0.3), 0x72c052);
  return merge([trunk, crown, crown2]);
}
function lampTemplate() {
  const h = 9;
  const post = coloured(new THREE.CylinderGeometry(0.18, 0.26, h, 6).translate(0, h / 2, 0), 0x7d828a);
  const base = coloured(new THREE.CylinderGeometry(0.5, 0.6, 0.6, 8).translate(0, 0.3, 0), 0x9aa0a8);
  const arm = coloured(new THREE.BoxGeometry(3.2, 0.22, 0.3).translate(0, h - 0.2, 0), 0x7d828a);
  const heads = [-1.5, 1.5].map((x) => coloured(new THREE.BoxGeometry(1.0, 0.3, 0.6).translate(x, h - 0.45, 0), 0xfff2c4));
  return merge([post, base, arm, ...heads]);
}
function signTemplate() {
  const post = coloured(new THREE.CylinderGeometry(0.12, 0.12, 3.4, 6).translate(0, 1.7, 0), 0x8b9098);
  return merge([post]);
}
function pTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#1f5fbf'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#ffffff'; g.lineWidth = 8; g.strokeRect(8, 8, 112, 112);
  g.fillStyle = '#ffffff'; g.font = 'bold 92px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('P', 64, 70);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- main ----------

export function buildParking(scene, city, extras, opts = {}) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'parking';
  const lots = [], colliders = [];
  const stats = { lots: 0, stalls: 0, surface: 0, multiStorey: 0, underground: 0, streetSide: 0, inferred: 0, covered: 0, empty: 0, ms: 0 };
  group.userData.stats = stats;
  if (scene) scene.add(group);
  if (!extras || !Array.isArray(extras.parking)) return { lots, colliders, group };

  // The bake stores positions at its SCALE; follow src/geo.js if it has moved since.
  const k = extras.meta && extras.meta.scale ? SCALE / extras.meta.scale : 1;
  const P = (pts) => (k === 1 ? pts : pts.map((p) => [p[0] * k, p[1] * k]));

  // ---- obstacles: buildings, water, landmarks ----
  const obst = new Grid(40);
  const addObst = (c) => {
    if (!c || !c.points || c.points.length < 3) return;
    const b = bbox(c.points);
    if (b.maxX - b.minX > 3000 || b.maxZ - b.minZ > 3000) { bigObst.push(c); return; }
    obst.addBox({ r: c.points, kind: c.kind || 'building' }, b.minX, b.minZ, b.maxX, b.maxZ);
  };
  const bigObst = [];
  for (const c of city.colliders || []) if (!c.kind || c.kind === 'building' || c.kind === 'water' || c.kind === 'sea') addObst(c);
  for (const c of opts.colliders || []) addObst(c);
  for (const e of opts.exclude || []) addObst({ points: Array.isArray(e) ? e : e.points, kind: 'landmark' });
  const inObstacle = (x, z) => {
    const l = obst.at(x, z);
    if (l) for (const o of l) if (inPoly(x, z, o.r)) return o.kind;
    for (const o of bigObst) if (inPoly(x, z, o.points)) return o.kind;
    return null;
  };
  const onCarriage = typeof city.onCarriage === 'function' ? city.onCarriage : () => false;

  // ---- road segments: car roads for entrances, service ways as lot aisles ----
  const roadSegs = new Grid(80);
  for (const r of city.roads || []) {
    if (r.tunnel || r.bridge || !r.points || r.points.length < 2) continue;
    const isCar = r.rank != null && r.rank >= 1;
    if (!isCar) continue;
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const s = { a, b, w: r.width || 6, service: r.kind === 'service', rank: r.rank };
      roadSegs.addBox(s, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    }
  }
  const nearestRoad = (x, z, radius, filter = () => true) => {
    let best = null;
    for (const s of roadSegs.query(x - radius, z - radius, x + radius, z + radius)) {
      if (!filter(s)) continue;
      const q = segDist2(x, z, s.a[0], s.a[1], s.b[0], s.b[1]);
      if (q.d2 < radius * radius && (!best || q.d2 < best.d2)) best = { ...q, s };
    }
    return best;
  };

  // ---- output accumulators, chunked so the lots frustum-cull ----
  const chunks = new Map();
  const chunk = (x, z) => {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = { key, ground: new Acc(), lines: new Acc(), solid: new Acc() }));
    return c;
  };
  const trees = [], lamps = [], signs = [], planters = [];
  const lineKeys = new Set();

  // Placed stalls across all lots, so overlapping OSM lots never paint on top of each other.
  const stallGrid = new Grid(30);
  const fits = (corners) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const c of corners) { minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minZ = Math.min(minZ, c[1]); maxZ = Math.max(maxZ, c[1]); }
    for (const o of stallGrid.query(minX, minZ, maxX, maxZ)) if (rectsOverlap(corners, o)) return false;
    return true;
  };
  const claim = (corners) => {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const c of corners) { minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minZ = Math.min(minZ, c[1]); maxZ = Math.max(maxZ, c[1]); }
    stallGrid.addBox(corners, minX, minZ, maxX, maxZ);
  };

  const rejected = { outside: 0, island: 0, obstacle: 0, road: 0, overlap: 0 };
  const reject = (why) => { rejected[why]++; return null; };
  // Why a stall at this pose is not allowed ('outside', 'obstacle', ...), or null when it is.
  const probeStall = (ctx, cx, cz, dx, dz, w, l) => {
    const hw = w / 2 - 0.05, hl = l / 2 - 0.05;
    const inner = rectCorners(cx, cz, dx, dz, hw - 0.25, hl - 0.25);
    const samples = [...inner, [cx, cz], [cx + dx * hl * 0.6, cz + dz * hl * 0.6], [cx - dx * hl * 0.6, cz - dz * hl * 0.6]];
    // `loose` lots (narrow strips) only need the aisle end of the bay inside the outline: the mapped
    // polygon is a rough tracing and the bay may run on onto the open ground behind it.
    if (ctx.loose && ctx.poly && !inPoly(cx - dx * hl * 0.85, cz - dz * hl * 0.85, ctx.poly)) return 'outside';
    for (const [x, z] of samples) {
      if (!ctx.loose && ctx.poly && !inPoly(x, z, ctx.poly)) return 'outside';
      if (ctx.holes && ctx.holes.some((h) => inPoly(x, z, h))) return 'island';
      if (!ctx.roof && inObstacle(x, z)) return 'obstacle';
      if (!ctx.roof && !ctx.street && onCarriage(x, z, 0.2)) return 'road';
    }
    return null;
  };
  // Tries to place one stall; `ctx` describes the lot. Returns the stall or null.
  const tryStall = (ctx, cx, cz, dx, dz, w, l) => {
    const why = probeStall(ctx, cx, cz, dx, dz, w, l);
    if (why) return reject(why);
    const corners = rectCorners(cx, cz, dx, dz, w / 2 - 0.05, l / 2 - 0.05);
    if (!fits(corners)) return reject('overlap');
    claim(corners);
    const y = ctx.roof ? ctx.roofY : groundAt(cx, cz);
    return { x: +cx.toFixed(2), z: +cz.toFixed(2), y: +y.toFixed(2), angle: +Math.atan2(dx, dz).toFixed(4), w: +w.toFixed(2), l: +l.toFixed(2), corners };
  };

  // Painted lines: both long sides and the back of the stall (the front opens onto the aisle).
  const yAt = (ctx) => (ctx.roof ? () => ctx.roofY + 0.03 : (x, z) => groundAt(x, z) + Y_LINE);
  const paintLine = (acc, a, b, yOf) => {
    const key = `${Math.round((a[0] + b[0]) * 2)},${Math.round((a[1] + b[1]) * 2)}`;
    if (lineKeys.has(key)) return;
    lineKeys.add(key);
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    const px = (-dz / L) * LINE_W / 2, pz = (dx / L) * LINE_W / 2;
    const v = [[a[0] + px, a[1] + pz], [b[0] + px, b[1] + pz], [b[0] - px, b[1] - pz], [a[0] - px, a[1] - pz]];
    acc.quad(...v.map(([x, z]) => [x, yOf(x, z), z]), COL.line);
  };
  const paintStall = (ctx, s) => {
    const acc = chunk(s.x, s.z).lines, yOf = yAt(ctx), k4 = s.corners;
    // corners: 0 front-left, 1 front-right, 2 back-right, 3 back-left (front = nose end).
    paintLine(acc, k4[1], k4[2], yOf);
    paintLine(acc, k4[3], k4[0], yOf);
    paintLine(acc, k4[0], k4[1], yOf); // nose end = the back line of the bay
  };
  const pushStall = (lot, ctx, s) => {
    paintStall(ctx, s);
    if (ctx.pave) {
      // Lots known only from their aisles get asphalt under each bay instead of an outline.
      const yOf = (x, z) => groundAt(x, z) + Y_LOT;
      const k4 = rectCorners(s.x, s.z, Math.sin(s.angle), Math.cos(s.angle), s.w / 2 + 0.3, s.l / 2 + 0.6);
      chunk(s.x, s.z).ground.quad(...k4.map(([x, z]) => [x, yOf(x, z), z]), COL.asphalt);
    }
    delete s.corners;
    lot.stalls.push(s);
  };
  const plantIsland = (ctx, cx, cz, dx, dz, w, l, lampToo) => {
    if (ctx.roof) return;
    const k4 = rectCorners(cx, cz, dx, dz, w / 2 - 0.3, l / 2 - 0.3);
    for (const [x, z] of [...k4, [cx, cz]]) {
      if (ctx.poly && !inPoly(x, z, ctx.poly)) return;
      if (inObstacle(x, z) || onCarriage(x, z, 0.3)) return;
    }
    if (!fits(rectCorners(cx, cz, dx, dz, w / 2 - 0.1, l / 2 - 0.1))) return;
    claim(rectCorners(cx, cz, dx, dz, w / 2 - 0.1, l / 2 - 0.1));
    const y = groundAt(cx, cz);
    planters.push({ x: cx, z: cz, y, angle: Math.atan2(dx, dz), w: w - 0.6, l: l - 0.6 });
    if (lampToo) {
      lamps.push({ x: cx, z: cz, y: y + 0.4, angle: Math.atan2(dx, dz) });
      colliders.push({ kind: 'prop', height: 9, points: rectCorners(cx, cz, 1, 0, 0.4, 0.4) });
    } else {
      trees.push({ x: cx, z: cz, y: y + 0.4, angle: (cx * 13.1 + cz * 7.7) % 6.28, s: 0.85 + ((Math.abs(cx * 3.7 + cz) % 10) / 30) });
      colliders.push({ kind: 'prop', height: 3, points: rectCorners(cx, cz, 1, 0, 0.5, 0.5) });
    }
  };

  // Stalls on both sides of mapped aisles (OSM service ways inside the lot).
  const fillAlongAisles = (lot, ctx, aisles) => {
    for (const aisle of aisles) {
      const pts = aisle.points, half = aisle.width / 2 + 0.3;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const ux0 = b[0] - a[0], uz0 = b[1] - a[1], L = Math.hypot(ux0, uz0);
        if (L < STALL_W * 1.5) continue;
        const ux = ux0 / L, uz = uz0 / L;
        const n = Math.floor((L - STALL_W) / STALL_W);
        const off = (L - n * STALL_W) / 2;
        for (const side of [-1, 1]) {
          const dx = -uz * side, dz = ux * side; // nose points away from the aisle
          for (let j = 0; j < n; j++) {
            const t = off + (j + 0.5) * STALL_W;
            const bx = a[0] + ux * t, bz = a[1] + uz * t;
            if (j % ISLAND_EVERY === ISLAND_EVERY - 1) {
              const c = half + STALL_L / 2;
              plantIsland(ctx, bx + dx * c, bz + dz * c, dx, dz, STALL_W, STALL_L, (j / ISLAND_EVERY) % 2 === 1);
              continue;
            }
            let s = null;
            for (const l of [STALL_L, STALL_L_SHORT]) {
              const c = half + l / 2;
              s = tryStall(ctx, bx + dx * c, bz + dz * c, dx, dz, STALL_W, l);
              if (s) break;
            }
            if (s) pushStall(lot, ctx, s);
          }
        }
      }
    }
  };

  // Single row of stalls along one long side of a narrow lot; the strip left beside it is the aisle.
  // The row is slid across the lot (both facings) and along it, keeping the pose that holds the
  // most legal stalls; ties go to the aisle strip nearest a carriageway, where cars drive in.
  // When the outline is so narrow that a mapped service way fills it (a beach strip), the bays are
  // allowed to run past the outline on the far side of the aisle (`loose`, with asphalt under them).
  const fillNarrow = (lot, ctx, poly, ang, [u0, u1, v0, v1], dry) => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const W = (u, v) => [u * ca - v * sa, u * sa + v * ca];
    const span = u1 - u0;
    const nSlots = Math.max(0, Math.floor(span / STALL_W));
    const slack = span - nSlots * STALL_W;
    const search = (c, reachV) => {
      let best = null;
      for (const nv of [1, -1]) {
        const dx = -sa * nv, dz = ca * nv;
        for (let vc = v0 + STALL_L / 2 - reachV; vc <= v1 - STALL_L / 2 + reachV + 1e-6; vc += 0.5) {
          const aisleV = vc - nv * (STALL_L / 2 + 1.5);
          let near = 0;
          for (let k = 0; k <= 8; k++) {
            const [x, z] = W(u0 + (span * k) / 8, aisleV);
            for (const m of [3, 6, 10]) if (onCarriage(x, z, m)) near++;
          }
          for (let us = 0; us <= 4; us++) {
            const uOff = u0 + (slack * us) / 4;
            let n = 0;
            for (let j = 0; j < nSlots; j++) {
              const [cx, cz] = W(uOff + (j + 0.5) * STALL_W, vc);
              if (!probeStall(c, cx, cz, dx, dz, STALL_W, STALL_L)) n++;
            }
            if (!best || n > best.n || (n === best.n && near > best.near)) best = { n, near, nv, vc, uOff };
          }
        }
      }
      return best;
    };
    let ctxUse = ctx, best = search(ctx, 0);
    if (!best || best.n < 3) {
      const loose = { ...ctx, loose: true, pave: true };
      const alt = search(loose, STALL_L);
      if (alt && alt.n > (best ? best.n : 0)) { best = alt; ctxUse = loose; }
    }
    if (!best || best.n === 0) return 0;
    if (dry) return best.n;
    let count = 0;
    const dx = -sa * best.nv, dz = ca * best.nv;
    for (let j = 0; j < nSlots; j++) {
      const [cx, cz] = W(best.uOff + (j + 0.5) * STALL_W, best.vc);
      const s = tryStall(ctxUse, cx, cz, dx, dz, STALL_W, STALL_L);
      if (s) { pushStall(lot, ctxUse, s); count++; }
    }
    return count;
  };

  // Rows of stalls along the lot's long axis: [aisle][row facing it][row facing the next aisle]...
  // A row is only kept where the aisle in front of it lies inside the lot or on a road, so every
  // stall is reachable. `phase` puts one aisle centre on a known line (a mapped aisle).
  const fillGrid = (lot, ctx, poly, ang, phase, dry = false) => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of poly) {
      const u = p[0] * ca + p[1] * sa, v = -p[0] * sa + p[1] * ca;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const W = (u, v) => [u * ca - v * sa, u * sa + v * ca];
    const period = AISLE + 2 * STALL_L;
    let count = 0;
    const single = ctx.street || ctx.roof;
    // A lot too narrow for two facing rows plus an aisle (e.g. a beach strip) gets ONE row along
    // the long side; the leftover strip beside it is the aisle, fed by the road at that edge.
    if (!single && opts.narrowRows !== false && v1 - v0 < period * 0.9) return fillNarrow(lot, ctx, poly, ang, [u0, u1, v0, v1], dry);
    let first = phase - Math.ceil((phase - v0) / period) * period - period;
    const reach = (x, z) => (ctx.poly ? inPoly(x, z, ctx.poly) : true) || onCarriage(x, z, 0);
    const uStart = u0 + (u1 - u0 > 6 * STALL_W ? AISLE * 0.6 : 0.4), uEnd = u1 - (u1 - u0 > 6 * STALL_W ? AISLE * 0.6 : 0.4);
    const nSlots = Math.floor((uEnd - uStart) / STALL_W);
    const uOff = uStart + ((uEnd - uStart) - nSlots * STALL_W) / 2;
    for (let ac = first; ac < v1 + period; ac += period) {
      // Row A faces aisle `ac` from above (+v side), row B faces aisle `ac + period` from below.
      for (const [vc, nv] of [[ac + AISLE / 2 + STALL_L / 2, 1], [ac + period - AISLE / 2 - STALL_L / 2, -1]]) {
        if (vc + STALL_L / 2 < v0 || vc - STALL_L / 2 > v1) continue;
        const front = vc - nv * (STALL_L / 2 + AISLE / 2);
        for (let j = 0; j < nSlots; j++) {
          const u = uOff + (j + 0.5) * STALL_W;
          const [cx, cz] = W(u, vc);
          const dx = -sa * nv, dz = ca * nv;
          if (!single) {
            const [fx, fz] = W(u, front);
            if (!reach(fx, fz)) continue;
          }
          if (dry) {
            const ok = (ctx.poly ? inPoly(cx, cz, ctx.poly) : true) && !inObstacle(cx, cz);
            if (ok) count++;
            continue;
          }
          if (j % ISLAND_EVERY === ISLAND_EVERY - 1 && !single) {
            plantIsland(ctx, cx, cz, dx, dz, STALL_W, STALL_L, (j / ISLAND_EVERY) % 2 === 1);
            continue;
          }
          const s = tryStall(ctx, cx, cz, dx, dz, STALL_W, STALL_L);
          if (s) { pushStall(lot, ctx, s); count++; }
        }
      }
    }
    return count;
  };

  // Kerb pieces along the outline; a piece is left out where a road or aisle crosses the edge,
  // which leaves the entrances open. If no gap appears, one is cut toward the nearest road.
  const buildKerbs = (lot, poly) => {
    const pieces = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / 9));
      for (let j = 0; j < n; j++) {
        const p = [a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n];
        const q = [a[0] + ((b[0] - a[0]) * (j + 1)) / n, a[1] + ((b[1] - a[1]) * (j + 1)) / n];
        const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        pieces.push({ p, q, m, gap: onCarriage(m[0], m[1], 0.5), wall: !!inObstacle(m[0], m[1]) });
      }
    }
    let gaps = pieces.filter((x) => x.gap).length;
    let entrance = null;
    const [cx, cz] = centroid(poly);
    const road = nearestRoad(cx, cz, 400);
    if (road) {
      // The kerb piece closest to the nearest road is the entrance (plus its neighbours).
      let bi = -1, bd = Infinity;
      pieces.forEach((x, i) => { const d = (x.m[0] - road.x) ** 2 + (x.m[1] - road.z) ** 2; if (d < bd && !x.wall) { bd = d; bi = i; } });
      if (bi >= 0) {
        entrance = pieces[bi].m;
        if (!gaps) for (const d of [-1, 0, 1]) { const x = pieces[(bi + d + pieces.length) % pieces.length]; x.gap = true; gaps++; }
      }
    }
    const solid = chunk(cx, cz).solid;
    for (const x of pieces) {
      if (x.gap || x.wall) continue;
      const dx = x.q[0] - x.p[0], dz = x.q[1] - x.p[1], L = Math.hypot(dx, dz);
      if (L < 0.3) continue;
      // Top and both long faces only: the ends butt against the next piece.
      const ox = (-dz / L) * KERB_W / 2, oz = (dx / L) * KERB_W / 2;
      const ga = groundAt(x.p[0], x.p[1]), gb = groundAt(x.q[0], x.q[1]);
      const a1 = [x.p[0] + ox, x.p[1] + oz], b1 = [x.q[0] + ox, x.q[1] + oz], a2 = [x.p[0] - ox, x.p[1] - oz], b2 = [x.q[0] - ox, x.q[1] - oz];
      solid.quad([a1[0], ga + KERB_H, a1[1]], [b1[0], gb + KERB_H, b1[1]], [b2[0], gb + KERB_H, b2[1]], [a2[0], ga + KERB_H, a2[1]], COL.kerb);
      solid.wall(a1, b1, ga - 0.3, gb - 0.3, ga + KERB_H, gb + KERB_H, COL.kerb, ox, oz);
      solid.wall(a2, b2, ga - 0.3, gb - 0.3, ga + KERB_H, gb + KERB_H, COL.kerb, -ox, -oz);
    }
    return entrance;
  };

  const addSign = (x, z, faceX, faceZ) => {
    const y = groundAt(x, z);
    signs.push({ x, z, y, angle: Math.atan2(faceX, faceZ) });
  };

  // Lamps on the lot's long axis when it has no islands to carry them.
  const lampsAlongAxis = (poly, ang) => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of poly) {
      const u = p[0] * ca + p[1] * sa, v = -p[0] * sa + p[1] * ca;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const n = Math.max(1, Math.floor((u1 - u0) / 45));
    for (const vv of v1 - v0 > 60 ? [v0 + (v1 - v0) / 3, v0 + (2 * (v1 - v0)) / 3] : [(v0 + v1) / 2]) {
      for (let i = 0; i < n; i++) {
        const u = u0 + ((i + 0.5) * (u1 - u0)) / n;
        const x = u * ca - vv * sa, z = u * sa + vv * ca;
        if (!inPoly(x, z, poly) || inObstacle(x, z) || onCarriage(x, z, 1)) continue;
        if (!fits(rectCorners(x, z, 1, 0, 0.5, 0.5))) continue;
        claim(rectCorners(x, z, 1, 0, 0.5, 0.5));
        lamps.push({ x, z, y: groundAt(x, z), angle: ang });
        colliders.push({ kind: 'prop', height: 9, points: rectCorners(x, z, 1, 0, 0.4, 0.4) });
      }
    }
  };

  // ---- multi-storey garage: open decks, pillars, parapets, an outside ramp; stalls on the roof ----
  const buildGarage = (lot, poly, levels) => {
    const base = Math.min(...poly.map((p) => groundAt(p[0], p[1])));
    const top = base + levels * FLOOR;
    const [cx, cz] = centroid(poly);
    const solid = chunk(cx, cz).solid;
    const ccw = signedArea(poly) > 0;
    for (let L = 1; L <= levels; L++) {
      const y = base + L * FLOOR;
      fillDense(solid, poly, [], () => y, L === levels ? COL.asphaltRoof : COL.concreteDark, 1e9);
      fillDense(solid, poly, [], () => y - 0.6, COL.concreteDark, 1e9);
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const ox = (ccw ? 1 : -1) * (b[1] - a[1]), oz = (ccw ? -1 : 1) * (b[0] - a[0]);
        solid.wall(a, b, y - 0.6, y - 0.6, y + 1.1, y + 1.1, L === levels ? COL.stripe : COL.concrete, ox, oz);
        solid.wall(a, b, y, y, y + 1.1, y + 1.1, COL.concrete, -ox, -oz);
      }
    }
    // Pillars at corners and every ~12 units along the walls.
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / 12));
      for (let j = 0; j < n; j++) {
        const x = a[0] + ((b[0] - a[0]) * j) / n, z = a[1] + ((b[1] - a[1]) * j) / n;
        const ix = x + (cx - x) * (0.9 / Math.max(1, Math.hypot(cx - x, cz - z))), iz = z + (cz - z) * (0.9 / Math.max(1, Math.hypot(cx - x, cz - z)));
        solid.box(ix, iz, 1, 0, 0.5, 0.5, base - 0.3, top, COL.concrete, COL.concrete);
      }
    }
    // Ground-floor slab so the open storey reads as a deck, not grass.
    fillDense(chunk(cx, cz).ground, poly, [], (x, z) => groundAt(x, z) + Y_LOT, COL.asphalt, 16);
    // External ramp along the longest free edge, ground to the first deck.
    let best = null;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 16) continue;
      const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
      const ox = ccw ? uz : -uz, oz = ccw ? -ux : ux; // outward normal
      const rw = 7, off = rw / 2 + 0.6;
      const mx = (a[0] + b[0]) / 2 + ox * off, mz = (a[1] + b[1]) / 2 + oz * off;
      let ok = true;
      for (let t = -0.45; t <= 0.45; t += 0.15) {
        const x = mx + ux * L * t, z = mz + uz * L * t;
        if (inObstacle(x, z) || onCarriage(x, z, 0)) { ok = false; break; }
      }
      if (ok && (!best || L > best.L)) best = { a, b, L, ux, uz, ox, oz, mx, mz, rw };
    }
    if (best) {
      const { L, ux, uz, ox, oz, mx, mz, rw } = best;
      const len = Math.min(L * 0.9, FLOOR / 0.12);
      const s0 = [mx - ux * len / 2, mz - uz * len / 2], s1 = [mx + ux * len / 2, mz + uz * len / 2];
      const y0 = groundAt(s0[0], s0[1]) + 0.15, y1 = base + FLOOR;
      const e = [ox * rw / 2, oz * rw / 2];
      const A = [s0[0] - e[0], y0, s0[1] - e[1]], B = [s1[0] - e[0], y1, s1[1] - e[1]], Cc = [s1[0] + e[0], y1, s1[1] + e[1]], D = [s0[0] + e[0], y0, s0[1] + e[1]];
      solid.quad(A, B, Cc, D, COL.ramp);
      // Outer parapet of the ramp, and the support wall under it.
      const o0 = [s0[0] + e[0], s0[1] + e[1]], o1 = [s1[0] + e[0], s1[1] + e[1]];
      solid.wall(o0, o1, y0 - 0.4, base - 0.3, y0 + 1.1, y1 + 1.1, COL.concrete, ox, oz);
      solid.wall(o0, o1, y0, y1, y0 + 1.1, y1 + 1.1, COL.concrete, -ox, -oz);
      solid.wall(o0, o1, base - 0.3, base - 0.3, y0 - 0.2, y1 - 0.2, COL.concreteDark, -ox, -oz);
      lot.ramp = { from: [+s0[0].toFixed(1), +s0[1].toFixed(1)], to: [+s1[0].toFixed(1), +s1[1].toFixed(1)] };
      addSign(s0[0] - ux * 3 + ox * (rw / 2 + 1), s0[1] - uz * 3 + oz * (rw / 2 + 1), -ux, -uz);
    }
    colliders.push({ kind: 'building', height: top + 1.1, points: poly });
    // Roof deck stalls.
    const ctx = { poly, roof: true, roofY: top };
    const ang = longAxis(poly);
    let bestN = -1, bestPhase = 0;
    const [pcx, pcz] = centroid(poly);
    const pv = -pcx * Math.sin(ang) + pcz * Math.cos(ang);
    for (let k4 = 0; k4 < 4; k4++) {
      const ph = pv + (k4 * (AISLE + 2 * STALL_L)) / 4;
      const n = fillGrid(lot, ctx, poly, ang, ph, true);
      if (n > bestN) { bestN = n; bestPhase = ph; }
    }
    fillGrid(lot, ctx, poly, ang, bestPhase);
    lot.y = +top.toFixed(2);
  };

  // ---- underground: a covered ramp mouth at the lot edge nearest a road ----
  const buildUnderground = (lot, poly) => {
    const [cx, cz] = centroid(poly);
    const road = nearestRoad(cx, cz, 300);
    let px = cx, pz = cz;
    if (road) {
      // Walk from the road toward the lot centre to the first free spot.
      const dx = cx - road.x, dz = cz - road.z, L = Math.hypot(dx, dz) || 1;
      let found = false;
      for (let t = (road.s.w / 2 + 6) / L; t < 1; t += 2 / L) {
        const x = road.x + dx * t, z = road.z + dz * t;
        if (!inObstacle(x, z) && !onCarriage(x, z, 2) && !inObstacle(x + (dx / L) * 10, z + (dz / L) * 10)) { px = x; pz = z; found = true; break; }
      }
      if (!found) return false;
      // The same garage is sometimes mapped twice (way + relation): one entrance is enough.
      if (lots.some((o) => o.entrance && Math.hypot(o.entrance[0] - px, o.entrance[1] - pz) < 15)) return false;
      const ux = dx / L, uz = dz / L;
      const y = groundAt(px, pz), len = 10, hw = 4, h = 3.6;
      const mx = px + ux * len / 2, mz = pz + uz * len / 2;
      const solid = chunk(px, pz).solid;
      for (const s of [-1, 1]) {
        // Side walls.
        const wx = mx - uz * s * hw, wz = mz + ux * s * hw;
        solid.box(wx, wz, ux, uz, 0.35, len / 2, y - 0.3, y + h, COL.concrete, COL.concrete);
      }
      // Roof over the back two thirds, dark mouth and ramp floor.
      solid.box(mx + ux * len / 6, mz + uz * len / 6, ux, uz, hw + 0.35, len / 3, y + h, y + h + 0.5, COL.concreteDark, COL.stripe);
      const fl = rectCorners(mx, mz, ux, uz, hw - 0.35, len / 2);
      solid.quad([fl[0][0], y + 0.12, fl[0][1]], [fl[1][0], y + 0.12, fl[1][1]], [fl[2][0], y + 0.2, fl[2][1]], [fl[3][0], y + 0.2, fl[3][1]], COL.mouth);
      solid.box(mx + ux * (len / 2 - 0.3), mz + uz * (len / 2 - 0.3), ux, uz, hw - 0.35, 0.2, y, y + h, COL.mouth, COL.mouth);
      colliders.push({ kind: 'wall', height: h + 0.5, points: rectCorners(mx, mz, ux, uz, hw + 0.35, len / 2) });
      addSign(px - uz * (hw + 1.2), pz + ux * (hw + 1.2), -ux, -uz);
      lot.entrance = [+px.toFixed(1), +pz.toFixed(1)];
      return true;
    }
    return false;
  };

  // ---- per lot ----
  const covered = (poly) => {
    const [cx, cz] = centroid(poly);
    let n = 0, hit = 0;
    for (const p of [[cx, cz], ...poly]) { n++; if (inObstacle(p[0] + (cx - p[0]) * 0.1, p[1] + (cz - p[1]) * 0.1) === 'building') hit++; }
    return hit / n >= 0.5;
  };

  extras.parking.forEach((src, idx) => {
    const poly = P(src.points);
    if (!poly || poly.length < 3) return;
    if (src.inferred === 2 && opts.towerLots === false) return;
    const holes = (src.holes || []).map(P);
    const lot = {
      id: src.osm || `inferred${idx}`, points: poly, kind: src.kind, name: src.name || '', capacity: src.capacity ?? null,
      inferred: src.inferred || 0, covered: false, stalls: [],
    };
    lots.push(lot);
    stats.lots++;
    const [cx, cz] = centroid(poly);
    if (src.kind === 'underground') {
      stats.underground++;
      buildUnderground(lot, poly);
      return;
    }
    if (src.kind === 'multi-storey') {
      stats.multiStorey++;
      if (src.rooftop || covered(poly)) { lot.covered = true; stats.covered++; return; }
      const area = Math.abs(signedArea(poly));
      const perLevel = Math.max(1, area / (STALL_W * (STALL_L + AISLE / 2)));
      const levels = Math.max(2, Math.min(5, src.capacity ? Math.round(src.capacity / perLevel) : 3));
      buildGarage(lot, poly, levels);
      return;
    }
    if (src.kind === 'street_side') {
      stats.streetSide++;
      const ctx = { poly, street: true };
      fillGrid(lot, ctx, poly, longAxis(poly), 0);
      return;
    }
    stats.surface++;
    if (src.inferred) {
      stats.inferred++;
      const aisles = (src.aisles || []).map((a) => ({ points: P(a), width: U(4.5) }));
      const ctx = { poly, pave: true };
      fillAlongAisles(lot, ctx, aisles);
      return;
    }
    // A surface lot under a building is a covered/ground-floor lot: leave it to the building.
    if (covered(poly)) { lot.covered = true; stats.covered++; return; }

    // Tagged surface lot: asphalt, islands for mapped holes, kerbs, stalls, lamps.
    const ground = chunk(cx, cz).ground;
    fillDense(ground, poly, holes, (x, z) => groundAt(x, z) + Y_LOT, COL.asphalt, 16);
    for (const h of holes) {
      fillDense(ground, h, [], (x, z) => groundAt(x, z) + Y_LOT + 0.02, COL.island, 10);
      const [hx, hz] = centroid(h);
      if (Math.abs(signedArea(h)) > 12 && inPoly(hx, hz, h) && !inObstacle(hx, hz)) trees.push({ x: hx, z: hz, y: groundAt(hx, hz), angle: hx % 6.28, s: 1 });
    }
    const ctx = { poly, holes };
    const aisleList = [];
    const bb = bbox(poly);
    for (const s of roadSegs.query(bb.minX, bb.minZ, bb.maxX, bb.maxZ)) {
      if (!s.service) continue;
      const mx = (s.a[0] + s.b[0]) / 2, mz = (s.a[1] + s.b[1]) / 2;
      if (inPoly(mx, mz, poly)) aisleList.push({ points: [s.a, s.b], width: s.w });
    }
    fillAlongAisles(lot, ctx, aisleList);
    // Grid fill for the rest, aligned to the longest mapped aisle when there is one.
    let ang = longAxis(poly), phase = null;
    if (aisleList.length) {
      let bl = 0;
      for (const a of aisleList) {
        const [p, q] = a.points, L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (L > bl) { bl = L; ang = Math.atan2(q[1] - p[1], q[0] - p[0]); phase = -p[0] * Math.sin(ang) + p[1] * Math.cos(ang); }
      }
    }
    if (phase == null) {
      let bestN = -1;
      const pv = -cx * Math.sin(ang) + cz * Math.cos(ang);
      for (let k4 = 0; k4 < 4; k4++) {
        const ph = pv + (k4 * (AISLE + 2 * STALL_L)) / 4;
        const n = fillGrid(lot, ctx, poly, ang, ph, true);
        if (n > bestN) { bestN = n; phase = ph; }
      }
    }
    fillGrid(lot, ctx, poly, ang, phase);
    const entrance = buildKerbs(lot, poly);
    if (entrance) { lot.entrance = [+entrance[0].toFixed(1), +entrance[1].toFixed(1)]; if (lot.stalls.length) addSign(entrance[0] + (cx - entrance[0]) * 0.04, entrance[1] + (cz - entrance[1]) * 0.04, entrance[0] - cx, entrance[1] - cz); }
    if (lot.stalls.length > 12) lampsAlongAxis(poly, ang);
  });

  // ---- meshes ----
  const toon = (o) => new THREE.MeshToonMaterial(o);
  const groundMat = toon({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
  const lineMat = toon({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -20 });
  const solidMat = toon({ vertexColors: true, side: THREE.DoubleSide });
  let draws = 0, tris = 0;
  for (const c of chunks.values()) {
    const g = new THREE.Group();
    g.name = `parking ${c.key}`;
    for (const [acc, mat, name, cast] of [[c.ground, groundMat, 'lot-asphalt', false], [c.lines, lineMat, 'lot-lines', false], [c.solid, solidMat, 'lot-solid', true]]) {
      if (acc.empty) continue;
      const m = new THREE.Mesh(acc.geometry(), mat);
      m.name = name;
      m.receiveShadow = true;
      m.castShadow = cast;
      g.add(m);
      draws++;
      tris += acc.p.length / 9;
    }
    group.add(g);
  }
  const instanced = (geo, mat, list, name, compose, cast = true) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), s = new THREE.Vector3();
    list.forEach((it, i) => { compose(it, v, q, s, up); m.compose(v, q, s); im.setMatrixAt(i, m); });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = cast;
    im.receiveShadow = true;
    im.name = name;
    group.add(im);
    draws++;
  };
  const propMat = toon({ vertexColors: true });
  instanced(treeTemplate(), propMat, trees, 'lot-trees', (t, v, q, s, up) => { v.set(t.x, t.y, t.z); q.setFromAxisAngle(up, t.angle); s.setScalar(1.6 * t.s); });
  instanced(lampTemplate(), propMat, lamps, 'lot-lamps', (t, v, q, s, up) => { v.set(t.x, t.y, t.z); q.setFromAxisAngle(up, t.angle); s.setScalar(1); });
  instanced(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), toon({ color: COL.island }), planters, 'lot-islands',
    (t, v, q, s, up) => { v.set(t.x, t.y - 0.1, t.z); q.setFromAxisAngle(up, t.angle); s.set(t.w, 0.5, t.l); }, false);
  instanced(signTemplate(), propMat, signs, 'lot-sign-posts', (t, v, q, s, up) => { v.set(t.x, t.y, t.z); q.setFromAxisAngle(up, t.angle); s.setScalar(1); });
  const panel = new THREE.PlaneGeometry(1.8, 1.8).translate(0, 3.9, 0.14);
  instanced(panel, new THREE.MeshToonMaterial({ map: pTexture(), side: THREE.DoubleSide }), signs, 'lot-sign-panels',
    (t, v, q, s, up) => { v.set(t.x, t.y, t.z); q.setFromAxisAngle(up, t.angle); s.setScalar(1); }, false);
  for (const s of signs) colliders.push({ kind: 'prop', height: 4.8, points: rectCorners(s.x, s.z, 1, 0, 0.25, 0.25) });

  for (const l of lots) { stats.stalls += l.stalls.length; if (!l.stalls.length && l.kind !== 'underground' && !l.covered) stats.empty++; }
  Object.assign(stats, { rejected, trees: trees.length, lamps: lamps.length, islands: planters.length, signs: signs.length, draws, tris: Math.round(tris), chunks: chunks.size, ms: Math.round(performance.now() - t0) });
  group.userData.stats = stats;
  return { lots, colliders, group };
}
