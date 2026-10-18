// Pools, restricted zones and fences (round 4, "details").
//
// Founder: every pool should read as a pool, and places that are fenced and closed (the military
// testing ground by the beach first) must not be enterable at all, even where a road runs in.
//
// Data: data/rishon.details.json, baked by tools/fetch_osm_details.py from OSM
// (leisure=swimming_pool, landuse=military / military=*, fenced access=private|no areas,
// barrier=fence|wall|hedge lines).
//
// - Pools sit on a paved deck raised above the highest ground under them, with a white coping, a
//   tiled basin wall down to bright pool water, lane lines on long pools, ladders, and loungers
//   with umbrellas round outdoor pools; indoor pools get a glass hall. The deck is walkable through
//   surfaceAt(); the water blocks. city.js already draws public pools as flat lake water at
//   ground + 0.35; this water sits above it and the coping covers its stone bank.
// - Sealed zones (military, fenced private) get one continuous perimeter: chain-link with a
//   barbed-wire coil (concrete wall where OSM says wall), bushes along the outside, a closed gate
//   with a boom, a guard booth and signs where a road enters, and a closed collider chain round
//   the whole outline, sea side included, so nothing on foot or wheels gets in. Roads inside stay
//   drawn; they are tagged road.restricted so traffic and routing can skip them.
// - Other OSM barrier lines (school fences, yard walls, hedges) are drawn and collide, with gaps
//   wherever a road, sidewalk or footpath crosses them, so public grounds stay open.
//
// Mapped barriers stand on real property lines, but the game widens streets by 1.4, so any fence
// sample that lands on a carriageway, sidewalk or path is first slid sideways off it; only a
// real crossing becomes a gate (sealed zones) or a gap (everything else).
//
// Rendering: geometry is merged per 1200-unit chunk into a few meshes (solid vertex-coloured,
// chain-link, barbed coil) plus one instanced bush mesh per chunk; pools are four meshes in all.
import * as THREE from 'three';
import { SCALE } from '../geo.js';
import { t, dir } from '../i18n.js';

const DATA_URL = new URL('../../data/rishon.details.json', import.meta.url);
const WIDEN = 1.4;                 // city.js road cross-section widening
const SIDEWALK = 2.8 * SCALE * WIDEN;
const CHUNK = 1200;
const STEP = 3.0;                  // perimeter sample spacing
const SHIFT_MAX = 36;              // how far a fence sample may slide off a road
const MIL_H = 3.0, FENCE_H = 2.2, WALL_H = 2.6, HEDGE_H = 2.0, COIL_H = 0.9;
const POOL_WATER = 0.5, POOL_DECK = 0.95, DECK_W = 4.2;
const CAR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(residential|service|unclassified|living_street|road|busway|track)$/;
const FOOT = /^(footway|pedestrian|cycleway|sidewalk|steps|path|bridleway|promenade)$/;

const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) >>> 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d) >>> 0; n ^= n >>> 15; return (n >>> 0) / 4294967296; };
const hxz = (x, z, s = 0) => hash((Math.round(x * 3) * 73856093) ^ (Math.round(z * 3) * 19349663) ^ (s * 83492791));

export async function loadDetails(url = DATA_URL) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn('[details] no data, skipping pools and fences', e.message || e);
    return null;
  }
}

// ---------- small geometry helpers ----------

const ring = (flat) => { const out = []; for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
function signedArea(r) { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
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
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  const t0 = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return Math.hypot(px - ax - dx * t0, pz - az - dz * t0);
}
// Outward miter normals of a closed ring (any winding), clamped so sharp corners stay sane.
function ringNormals(r) {
  const n = r.length, ccw = signedArea(r) > 0, out = [];
  const edgeN = r.map((p, i) => {
    const q = r[(i + 1) % n], dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
    // For a ring with positive signed area in (x, z), (dz, -dx) points out.
    return ccw ? [dz / l, -dx / l] : [-dz / l, dx / l];
  });
  for (let i = 0; i < n; i++) {
    const a = edgeN[(i - 1 + n) % n], b = edgeN[i];
    let mx = a[0] + b[0], mz = a[1] + b[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const cos = Math.max(0.4, mx * b[0] + mz * b[1]);
    out.push([mx / cos, mz / cos]);
  }
  return out;
}
const offsetRing = (r, N, d) => r.map((p, i) => [p[0] + N[i][0] * d, p[1] + N[i][1] * d]);

// Douglas-Peucker on [x, z] points (for collider chains).
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, idx = -1;
    for (let i = a + 1; i < b; i++) { const d = segDist(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]); if (d > best) { best = d; idx = i; } }
    if (best > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Resample a polyline every ~step, keeping its corners.
function resample(pts, step, closed) {
  const P = closed ? [...pts, pts[0]] : pts, out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const n = Math.max(1, Math.round(L / step)), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    for (let k = 0; k < n; k++) out.push({ x: a[0] + (b[0] - a[0]) * (k / n), z: a[1] + (b[1] - a[1]) * (k / n), ux, uz });
  }
  if (!closed) { const a = P[P.length - 2] || P[0], b = P[P.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; out.push({ x: b[0], z: b[1], ux: (b[0] - a[0]) / L, uz: (b[1] - a[1]) / L }); }
  return out;
}

// Vertex-coloured (optionally UV-mapped) triangle soup that becomes one mesh.
class Acc {
  constructor(uv = false) { this.p = []; this.n = []; this.c = []; this.uv = uv ? [] : null; }
  get empty() { return this.p.length === 0; }
  tri(a, b, c, col, ua, ub, uc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.c.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    if (this.uv) this.uv.push(ua ? ua[0] : 0, ua ? ua[1] : 0, ub ? ub[0] : 0, ub ? ub[1] : 0, uc ? uc[0] : 0, uc ? uc[1] : 0);
  }
  // Quad a-b-c-d; `face` (optional [x, y, z]) flips the winding so the front faces that way.
  quad(a, b, c, d, col, face, uvs) {
    if (face) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * face[0] + ny * face[1] + nz * face[2] < 0) {
        this.tri(a, d, c, col, uvs?.[0], uvs?.[3], uvs?.[2]); this.tri(a, c, b, col, uvs?.[0], uvs?.[2], uvs?.[1]);
        return;
      }
    }
    this.tri(a, b, c, col, uvs?.[0], uvs?.[1], uvs?.[2]); this.tri(a, c, d, col, uvs?.[0], uvs?.[2], uvs?.[3]);
  }
  // A template geometry (non-indexed, positions + normals) placed by a matrix.
  geo(g, m, col) {
    const P = g.attributes.position, N = g.attributes.normal, v = GV, nm = NM.getNormalMatrix(m);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(m); this.p.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); this.n.push(v.x, v.y, v.z);
      this.c.push(col.r, col.g, col.b);
      if (this.uv) this.uv.push(0, 0);
    }
  }
  // Axis box centred at (x, y, z), rotated by rotY about its centre.
  box(x, y, z, w, h, d, rotY, col) { this.geo(BOX, MAT.compose(V3.set(x, y, z), Q.setFromAxisAngle(YAX, rotY), S3.set(w, h, d)), col); }
  mesh(mat, name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.receiveShadow = true;
    return m;
  }
}
const BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8).toNonIndexed();
const CONE = new THREE.ConeGeometry(0.5, 1, 10, 1, true).toNonIndexed();
const DISC = new THREE.CylinderGeometry(0.5, 0.5, 1, 18).toNonIndexed();
const EUL = new THREE.Euler(), NM = new THREE.Matrix3(), GV = new THREE.Vector3();
const MAT = new THREE.Matrix4(), V3 = new THREE.Vector3(), Q = new THREE.Quaternion(), S3 = new THREE.Vector3(), YAX = new THREE.Vector3(0, 1, 0);
const C = (hex) => new THREE.Color(hex);

// ---------- textures ----------

function canvasTex(w, h, draw, { repeat = true, srgb = true } = {}) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tx = new THREE.CanvasTexture(cv);
  if (repeat) tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  if (srgb) tx.colorSpace = THREE.SRGBColorSpace;
  tx.anisotropy = 4;
  return tx;
}
// Chain-link diamonds; one tile spans LINK_U x LINK_V world units.
const LINK_U = 1.6, LINK_V = 1.6;
const linkTex = () => canvasTex(64, 64, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#aeb6bd'; g.lineWidth = 5; g.lineCap = 'square';
  g.beginPath();
  for (const o of [-w, 0, w]) { g.moveTo(o, 0); g.lineTo(o + w, h); g.moveTo(o + w, 0); g.lineTo(o, h); }
  g.stroke();
});
// Concertina coil: overlapping loops.
const COIL_U = 1.2;
const coilTex = () => canvasTex(128, 64, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#c9cfd4'; g.lineWidth = 4;
  for (let k = -1; k <= 2; k++) { g.beginPath(); g.ellipse(k * w / 2 + w / 4, h / 2, w * 0.36, h * 0.42, 0.25, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = '#c9cfd4';
  for (let i = 0; i < 10; i++) g.fillRect((i * 37) % w, (i * 23) % h, 5, 5);
});
// Pool water: bright tiles seen through clear water, with a few caustic ripples.
const waterTex = () => canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#4cc9e3'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 2;
  for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(i * w / 8, 0); g.lineTo(i * w / 8, h); g.moveTo(0, i * h / 8); g.lineTo(w, i * h / 8); g.stroke(); }
  g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 3;
  for (let k = 0; k < 7; k++) {
    g.beginPath();
    const y0 = (k + 0.5) * h / 7;
    for (let x = 0; x <= w; x += 8) g.lineTo(x, y0 + Math.sin(x * 0.07 + k * 1.7) * 6 + Math.sin(x * 0.19 + k) * 3);
    g.stroke();
  }
});
const tileTex = () => canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = '#8fdcef'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#e8f8fc'; g.lineWidth = 3;
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * w / 4, 0); g.lineTo(i * w / 4, h); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.stroke(); }
});

// Sign atlas: one row per message, each 1024 x 256. Text comes from data/i18n (keys listed in
// SIGN_KEYS); the English fallbacks only show until the translator adds the keys.
export const SIGN_KEYS = {
  military: ['sign.militaryZone', 'Closed military zone - no entry'],
  photo: ['sign.noPhotos', 'No photography'],
  private: ['sign.privateProperty', 'Private property - no entry'],
  noEntry: ['sign.noEntry', 'No entry'],
};
const SIGN_ROWS = ['military', 'photo', 'private', 'noEntry'];
function signTex() {
  return canvasTex(1024, 1024, (g, w, h) => {
    const rh = h / SIGN_ROWS.length;
    SIGN_ROWS.forEach((id, i) => {
      const y0 = i * rh;
      g.fillStyle = '#ffffff'; g.fillRect(0, y0, w, rh);
      g.strokeStyle = '#d32222'; g.lineWidth = 22; g.strokeRect(14, y0 + 14, w - 28, rh - 28);
      const text = String(t(SIGN_KEYS[id][0], null, SIGN_KEYS[id][1]));
      g.fillStyle = '#c31414';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.direction = dir();
      // Two lines when the message has a dash or is long; shrink to fit.
      const parts = text.includes(' - ') ? text.split(' - ') : [text];
      const lines = parts.length > 1 ? parts : [text];
      let size = lines.length > 1 ? 86 : 110;
      const fit = () => { g.font = `900 ${size}px system-ui, "Arial Hebrew", Arial, sans-serif`; return Math.max(...lines.map((l) => g.measureText(l).width)); };
      while (fit() > w - 90 && size > 30) size -= 4;
      lines.forEach((l, k) => g.fillText(l, w / 2, y0 + rh / 2 + (k - (lines.length - 1) / 2) * size * 1.08));
    });
  }, { repeat: false });
}
const signUV = (id) => { const i = SIGN_ROWS.indexOf(id), n = SIGN_ROWS.length; const v1 = 1 - i / n, v0 = 1 - (i + 1) / n; return [[0, v0], [1, v0], [1, v1], [0, v1]]; };

// ---------- the build ----------

export async function buildDetails(scene, city, data, opts = {}) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'details';
  // Standing props built into merged geometry, listed for tools/audit_props.js.
  const placements = [];
  group.userData.placements = placements;
  const colliders = [];
  const stats = { pools: 0, poolsSkipped: 0, indoorPools: 0, zones: 0, sealed: 0, gates: 0, footGates: 0, signs: 0, booths: 0,
    perimeterUnits: 0, perimeterMetres: 0, openGates: 0, fenceUnits: 0, wallUnits: 0, hedgeUnits: 0, barrierLines: 0, bushes: 0,
    colliders: 0, restrictedRoads: 0, meshes: 0, ms: 0 };
  if (!data) data = await loadDetails();
  if (!data) return { group, colliders, stats, surfaceAt: () => null, restrictedAt: () => null };

  let groundAt = () => 0, terrainSurface = null;
  try { const tm = await import('./terrain.js'); if (typeof tm.groundAt === 'function') groundAt = tm.groundAt; terrainSurface = tm.surfaceAt || null; } catch { /* flat world */ }
  let footprints = opts.exclude;
  if (!footprints) { try { footprints = (await import('./landmarks.js')).LANDMARK_FOOTPRINTS || []; } catch { footprints = []; } }
  const lmPolys = footprints.filter((f) => f.points?.length >= 3).map((f) => ({ r: f.points, bb: bbox(f.points) }));
  const inLandmark = (x, z) => lmPolys.some((p) => x >= p.bb.minX && x <= p.bb.maxX && z >= p.bb.minZ && z <= p.bb.maxZ && inPoly(x, z, p.r));

  // --- spatial lookups over the city: roads (own grid, so bridges and tunnels do not count),
  // buildings and the sea ---
  const RG = 40, roadGrid = new Map();
  const addSeg = (ax, az, bx, bz, hw, car) => {
    const s = { ax, az, bx, bz, hw, car };
    for (let i = Math.floor((Math.min(ax, bx) - hw) / RG); i <= Math.floor((Math.max(ax, bx) + hw) / RG); i++)
      for (let j = Math.floor((Math.min(az, bz) - hw) / RG); j <= Math.floor((Math.max(az, bz) + hw) / RG); j++) {
        const k = i * 100003 + j; let l = roadGrid.get(k); if (!l) roadGrid.set(k, (l = [])); l.push(s);
      }
  };
  for (const r of city.roads || []) {
    if (!r.points || r.points.length < 2 || r.tunnel || r.bridge) continue;
    const car = CAR.test(r.kind) && r.kind !== 'track', foot = FOOT.test(r.kind) || r.kind === 'track';
    if (!car && !foot) continue;
    const hw = car ? (r.width || 7) / 2 + SIDEWALK + 0.8 : (r.width || 2.5) / 2 + 0.9;
    for (let i = 0; i < r.points.length - 1; i++) addSeg(r.points[i][0], r.points[i][1], r.points[i + 1][0], r.points[i + 1][1], hw, car);
  }
  // The road segment whose strip covers (x, z), car roads first, or null.
  const roadHit = (x, z) => {
    const l = roadGrid.get(Math.floor(x / RG) * 100003 + Math.floor(z / RG));
    if (!l) return null;
    let foot = null;
    for (const s of l) if (segDist(x, z, s.ax, s.az, s.bx, s.bz) < s.hw) { if (s.car) return s; foot = foot || s; }
    return foot;
  };
  // 'car' | 'foot' | null
  const roadAt = (x, z) => { const s = roadHit(x, z); return s ? (s.car ? 'car' : 'foot') : null; };
  // Points where a road centre line crosses the closed ring r: { x, z, hw (half the gap it needs,
  // measured along the ring), car }. Crossing at a slant needs a wider gap.
  const crossingsOf = (r) => {
    const out = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length], ex = b[0] - a[0], ez = b[1] - a[1], eL = Math.hypot(ex, ez) || 1;
      const seen = new Set();
      for (let gi = Math.floor(Math.min(a[0], b[0]) / RG); gi <= Math.floor(Math.max(a[0], b[0]) / RG); gi++)
        for (let gj = Math.floor(Math.min(a[1], b[1]) / RG); gj <= Math.floor(Math.max(a[1], b[1]) / RG); gj++)
          for (const sg of roadGrid.get(gi * 100003 + gj) || []) {
            if (seen.has(sg)) continue;
            seen.add(sg);
            const rx = sg.bx - sg.ax, rz = sg.bz - sg.az, den = ex * rz - ez * rx;
            if (Math.abs(den) < 1e-9) continue;
            const tt = ((sg.ax - a[0]) * rz - (sg.az - a[1]) * rx) / den, uu = ((sg.ax - a[0]) * ez - (sg.az - a[1]) * ex) / den;
            if (tt < 0 || tt > 1 || uu < 0 || uu > 1) continue;
            const sin = Math.abs(den) / (eL * (Math.hypot(rx, rz) || 1));
            if (sin < 0.35) continue; // grazing: the outline runs along this road, not across it
            out.push({ x: a[0] + ex * tt, z: a[1] + ez * tt, hw: Math.min(40, sg.hw / sin), car: sg.car });
          }
    }
    return out;
  };
  const BG = 64, bGrid = new Map(), seaPolys = [];
  for (const c of city.colliders || []) {
    if (!c.points || c.points.length < 3) continue;
    if (c.kind === 'sea') { seaPolys.push({ r: c.points, bb: bbox(c.points) }); continue; }
    if (c.kind !== 'building') continue;
    const bb = bbox(c.points), e = { r: c.points, bb };
    for (let i = Math.floor(bb.minX / BG); i <= Math.floor(bb.maxX / BG); i++)
      for (let j = Math.floor(bb.minZ / BG); j <= Math.floor(bb.maxZ / BG); j++) { const k = i * 100003 + j; let l = bGrid.get(k); if (!l) bGrid.set(k, (l = [])); l.push(e); }
  }
  const inBuilding = (x, z) => {
    const l = bGrid.get(Math.floor(x / BG) * 100003 + Math.floor(z / BG));
    return !!l && l.some((e) => x >= e.bb.minX && x <= e.bb.maxX && z >= e.bb.minZ && z <= e.bb.maxZ && inPoly(x, z, e.r));
  };
  // The sea outline has thousands of vertices: ask the terrain grid first, and test the polygon
  // only where the terrain is sea or beach sand.
  const inSea = (x, z) => {
    const ts = terrainSurface ? terrainSurface(x, z) : null;
    if (ts === 'land') return false;
    if (!seaPolys.length) return ts === 'sea';
    return seaPolys.some((p) => x >= p.bb.minX && x <= p.bb.maxX && z >= p.bb.minZ && z <= p.bb.maxZ && inPoly(x, z, p.r));
  };
  // Why a spot cannot hold a fence: 'car' | 'foot' | 'solid' | null.
  const blockAt = (x, z) => roadAt(x, z) || (inBuilding(x, z) || inLandmark(x, z) ? 'solid' : null);
  // Slide a sample along its normal until it is off roads/buildings. `side` (+1/-1) is tried over
  // the whole range first when `strict`, so a boundary drawn down a street does not zigzag across
  // it; otherwise the nearest free spot wins, `side` breaking ties.
  const settle = (s, nx, nz, max, side = 1, strict = false) => {
    const why = blockAt(s.x, s.z);
    if (!why) return { x: s.x, z: s.z, why: null };
    const tryAt = (d, sg) => { const x = s.x + nx * d * sg, z = s.z + nz * d * sg; return blockAt(x, z) ? null : { x, z, why: null, side: sg }; };
    if (strict) {
      for (const sg of [side, -side]) for (let d = 2; d <= max; d += 2) { const r = tryAt(d, sg); if (r) return r; }
    } else {
      for (let d = 2; d <= max; d += 2) for (const sg of [side, -side]) { const r = tryAt(d, sg); if (r) return r; }
    }
    return { x: s.x, z: s.z, why };
  };

  // Cells near car roads get dense bushes and signs; the far dunes stay sparse.
  const DC = 100, dense = new Set();
  for (const r of city.roads || []) {
    if (!CAR.test(r.kind) || !r.points) continue;
    for (const p of r.points) for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) dense.add((Math.floor(p[0] / DC) + i) * 100003 + Math.floor(p[1] / DC) + j);
  }
  const isDense = (x, z) => dense.has(Math.floor(x / DC) * 100003 + Math.floor(z / DC));

  // --- materials and per-chunk accumulators ---
  const solidMat = new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const linkMat = new THREE.MeshToonMaterial({ vertexColors: true, map: linkTex(), alphaTest: 0.45, side: THREE.DoubleSide });
  const coilMat = new THREE.MeshToonMaterial({ vertexColors: true, map: coilTex(), alphaTest: 0.45, side: THREE.DoubleSide });
  const signMat = new THREE.MeshToonMaterial({ map: signTex() });
  const bushMat = new THREE.MeshToonMaterial({ color: 0xffffff });
  const chunks = new Map();
  const chunk = (x, z) => {
    const k = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let c = chunks.get(k);
    if (!c) chunks.set(k, (c = { solid: new Acc(), link: new Acc(true), coil: new Acc(true), sign: new Acc(true), bushes: [] }));
    return c;
  };
  const col = { post: C(0x8b949c), postMil: C(0x6f7a72), rail: C(0x9aa2a8), wall: C(0xd3ccbf), wallJoint: C(0xa9a294), wallTop: C(0xe2dccf),
    hedge: C(0x4d8a3b), hedgeTop: C(0x62a24a), gate: C(0x4f5d4c), pillar: C(0xc9c3b6), red: C(0xd42a2a), white: C(0xf4f2ec),
    booth: C(0xefece3), boothWin: C(0x5f7f99), roof: C(0x8d969c), door: C(0x6b5b4a), steel: C(0x7c858c), blue: C(0x2d5bd1), link: C(0xffffff) };
  const bushCols = [0x3f7d34, 0x4b8f3c, 0x5a9b42, 0x386f30, 0x6aa84f].map(C);

  // Vertical ribbon along points [{x, z, y}] from y+y0 to y+y1, UV u by distance.
  const ribbon = (acc, pts, y0, y1, uScale, vScale, c) => {
    let u = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-4) continue;
      const u1 = u + L / uScale;
      acc.quad([a.x, a.y + y0, a.z], [b.x, b.y + y0, b.z], [b.x, b.y + y1, b.z], [a.x, a.y + y1, a.z], c, null,
        [[u, 0], [u1, 0], [u1, (y1 - y0) / vScale], [u, (y1 - y0) / vScale]]);
      u = u1;
    }
  };
  // Solid wall/hedge strip of thickness th along pts.
  const slabRun = (acc, pts, y0, y1, th, cSide, cTop) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-4) continue;
      const nx = -(b.z - a.z) / L * th / 2, nz = (b.x - a.x) / L * th / 2;
      // Overlap a little past each end so corners close.
      const ex = (b.x - a.x) / L * th / 2, ez = (b.z - a.z) / L * th / 2;
      const A = [a.x - ex, a.z - ez], B = [b.x + ex, b.z + ez];
      const P = (p, s, y) => [p[0] + nx * s, y, p[1] + nz * s];
      for (const s of [1, -1]) acc.quad(P(A, s, a.y + y0), P(B, s, b.y + y0), P(B, s, b.y + y1), P(A, s, a.y + y1), cSide, [nx * s, 0, nz * s]);
      acc.quad(P(A, 1, a.y + y1), P(B, 1, b.y + y1), P(B, -1, b.y + y1), P(A, -1, a.y + y1), cTop, [0, 1, 0]);
    }
  };
  // Vertical strip from y0 to y1 along pts, offset sideways by off (one face, both-sided material).
  const strip = (acc, pts, y0, y1, off, c) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-4) continue;
      const nx = -(b.z - a.z) / L * off, nz = (b.x - a.x) / L * off;
      acc.quad([a.x + nx, a.y + y0, a.z + nz], [b.x + nx, b.y + y0, b.z + nz], [b.x + nx, b.y + y1, b.z + nz], [a.x + nx, a.y + y1, a.z + nz], c);
    }
  };
  // Square post without caps (8 triangles), half-width r, from y up h.
  const prism = (acc, x, y, z, r, h, c) => {
    const P = [[x - r, z - r], [x + r, z - r], [x + r, z + r], [x - r, z + r]];
    for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; acc.quad([a[0], y, a[1]], [b[0], y, b[1]], [b[0], y + h, b[1]], [a[0], y + h, a[1]], c); }
  };
  const addBush = (x, z, y, s, seed) => {
    if (blockAt(x, z) || inSea(x, z)) return;
    chunk(x, z).bushes.push([x, y + s * 0.55, z, s, hxz(x, z, seed)]);
    stats.bushes++;
  };
  // Collider chain: thin quads along [x, z] points, between absolute heights.
  const chainColliders = (pts, kind, closed) => {
    const P = closed ? [...pts, pts[0]] : pts;
    for (let i = 0; i < P.length - 1; i++) {
      const A = P[i], B = P[i + 1], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L < 0.05) continue;
      const nx = -(B[1] - A[1]) / L * 0.35, nz = (B[0] - A[0]) / L * 0.35;
      // Pieces of at most ~24 u, each with the ground range under it sampled every ~4 u: a long
      // straight stretch over a dune must not take its height range from its two ends only.
      const pieces = Math.max(1, Math.ceil(L / 24));
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces, t1 = (k + 1) / pieces;
        const a = [A[0] + (B[0] - A[0]) * t0, A[1] + (B[1] - A[1]) * t0], b = [A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1];
        let lo = Infinity, hi = -Infinity;
        const m = Math.max(1, Math.ceil((L / pieces) / 4));
        for (let j = 0; j <= m; j++) { const g = groundAt(a[0] + (b[0] - a[0]) * j / m, a[1] + (b[1] - a[1]) * j / m); if (g < lo) lo = g; if (g > hi) hi = g; }
        // y1 clears a jump (~3 u) but not a bridge deck (8 u) above the fence.
        colliders.push({ kind, points: [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]], y0: lo - 3, y1: hi + 6 });
      }
    }
  };
  const textSign = (x, y, z, ox, oz, id, w = 3.4, h = 0.85) => {
    // Face (ox, oz); quad corners left-to-right as seen by the reader.
    const rx = oz, rz = -ox, c = chunk(x, z);
    c.sign.quad([x - rx * w / 2, y, z - rz * w / 2], [x + rx * w / 2, y, z + rz * w / 2], [x + rx * w / 2, y + h, z + rz * w / 2], [x - rx * w / 2, y + h, z - rz * w / 2],
      col.link, [ox, 0, oz], signUV(id));
    stats.signs++;
  };
  // Round red "no entry" disc on a pole, facing (ox, oz).
  const noEntryPost = (x, z, ox, oz) => {
    const y = groundAt(x, z), c = chunk(x, z).solid, rot = Math.atan2(ox, oz);
    placements.push({ kind: 'noEntry', x, y, z });
    c.box(x, y + 1.3, z, 0.16, 2.6, 0.16, 0, col.steel);
    MAT.compose(V3.set(x + ox * 0.1, y + 2.9, z + oz * 0.1), Q.setFromEuler(new THREE.Euler(Math.PI / 2, rot, 0, 'YXZ')), S3.set(1.3, 0.08, 1.3));
    c.geo(DISC, MAT, col.red);
    c.box(x + ox * 0.16, y + 2.9, z + oz * 0.16, 0.85, 0.22, 0.04, rot, col.white);
    stats.signs++;
  };

  stats.tSetup = Math.round(performance.now() - t0);
  // ---------- pools ----------
  const pools = [];
  const waterAcc = new Acc(true), tileAcc = new Acc(true), poolSolid = new Acc(), glassAcc = new Acc();
  for (const [flat, indoor, access] of data.pools || []) {
    let r = ring(flat);
    if (r.length < 3) continue;
    if (signedArea(r) < 0) r = r.reverse();
    const bb = bbox(r), cx = (bb.minX + bb.maxX) / 2, cz = (bb.minZ + bb.maxZ) / 2;
    // Pools inside a landmark are the landmark's; pools inside a mapped building are indoors and
    // the building already hides them.
    if (inLandmark(cx, cz) || inBuilding(cx, cz)) { stats.poolsSkipped++; continue; }
    // Same level rule as city.js water: highest ground over the outline and an interior grid.
    const step = Math.max(5, Math.sqrt((bb.maxX - bb.minX) * (bb.maxZ - bb.minZ)) / 24);
    let gmax = -Infinity;
    for (const p of r) gmax = Math.max(gmax, groundAt(p[0], p[1]));
    for (let x = bb.minX + step / 2; x < bb.maxX; x += step) for (let z = bb.minZ + step / 2; z < bb.maxZ; z += step) if (inPoly(x, z, r)) gmax = Math.max(gmax, groundAt(x, z));
    const Yw = gmax + POOL_WATER, Yd = gmax + POOL_DECK, Yc = Yd + 0.08;
    const N = ringNormals(r);
    const inner = offsetRing(r, N, -0.35), copeOut = offsetRing(r, N, 0.6), deckOut = offsetRing(r, N, DECK_W);
    // Pool frame: along its longest edge.
    let best = 0, ang = 0;
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > best) { best = L; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); } }
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const local = (x, z) => [(x - cx) * ca + (z - cz) * sa, -(x - cx) * sa + (z - cz) * ca];
    // Water: ear-clipped over the inner ring (free-form and L-shaped pools are not convex), UVs in
    // the pool frame.
    const WU = 4;
    for (const [i0, i1, i2] of THREE.ShapeUtils.triangulateShape(inner.map((p) => new THREE.Vector2(p[0], p[1])), [])) {
      const P = [inner[i0], inner[i1], inner[i2]];
      const uv = P.map((p) => { const l = local(p[0], p[1]); return [l[0] / WU, l[1] / WU]; });
      const v = P.map((p) => [p[0], Yw, p[1]]);
      // Up-facing.
      const cr = (v[1][0] - v[0][0]) * (v[2][2] - v[0][2]) - (v[1][2] - v[0][2]) * (v[2][0] - v[0][0]);
      if (cr < 0) waterAcc.tri(v[0], v[1], v[2], col.link, uv[0], uv[1], uv[2]); else waterAcc.tri(v[0], v[2], v[1], col.link, uv[0], uv[2], uv[1]);
    }
    // Lane lines on long pools (25 m and up), seen through the water.
    const len = best / SCALE;
    if (len >= 20) {
      const lb = bbox(inner.map((p) => local(p[0], p[1])));
      const laneW = 2.5 * SCALE, n = Math.floor((lb.maxZ - lb.minZ) / laneW);
      for (let k = 1; k < n; k++) {
        const lz = lb.minZ + (lb.maxZ - lb.minZ) * (k / n), x0 = lb.minX + 2.2, x1 = lb.maxX - 2.2;
        const W = (lx, lz2) => [cx + lx * ca - lz2 * sa, Yw + 0.03, cz + lx * sa + lz2 * ca];
        poolSolid.quad(W(x0, lz - 0.18), W(x1, lz - 0.18), W(x1, lz + 0.18), W(x0, lz + 0.18), C(0x1f4f9a), [0, 1, 0]);
        poolSolid.quad(W(x1 - 0.4, lz - 0.6), W(x1, lz - 0.6), W(x1, lz + 0.6), W(x1 - 0.4, lz + 0.6), C(0x1f4f9a), [0, 1, 0]);
        poolSolid.quad(W(x0, lz - 0.6), W(x0 + 0.4, lz - 0.6), W(x0 + 0.4, lz + 0.6), W(x0, lz + 0.6), C(0x1f4f9a), [0, 1, 0]);
      }
    }
    // Basin wall (tiles), coping, deck and the deck's outer face down to the ground.
    let u = 0;
    for (let i = 0; i < r.length; i++) {
      const j = (i + 1) % r.length, a = inner[i], b = inner[j], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const inward = [-(N[i][0] + N[j][0]), 0, -(N[i][1] + N[j][1])];
      tileAcc.quad([a[0], Yw - 0.6, a[1]], [b[0], Yw - 0.6, b[1]], [b[0], Yc, b[1]], [a[0], Yc, a[1]], col.link, inward,
        [[u, 0], [u + L / 1.6, 0], [u + L / 1.6, (Yc - Yw + 0.6) / 1.6], [u, (Yc - Yw + 0.6) / 1.6]]);
      u += L / 1.6;
      const co = copeOut, de = deckOut;
      poolSolid.quad([a[0], Yc + 0.06, a[1]], [b[0], Yc + 0.06, b[1]], [co[j][0], Yc + 0.06, co[j][1]], [co[i][0], Yc + 0.06, co[i][1]], C(0xf7f5ef), [0, 1, 0]);
      poolSolid.quad([a[0], Yc - 0.1, a[1]], [b[0], Yc - 0.1, b[1]], [b[0], Yc + 0.06, b[1]], [a[0], Yc + 0.06, a[1]], C(0xf7f5ef), inward);
      poolSolid.quad([co[i][0], Yd, co[i][1]], [co[j][0], Yd, co[j][1]], [de[j][0], Yd, de[j][1]], [de[i][0], Yd, de[i][1]], C(0xe6d6b8), [0, 1, 0]);
      const gi = groundAt(de[i][0], de[i][1]) - 0.4, gj = groundAt(de[j][0], de[j][1]) - 0.4;
      poolSolid.quad([de[i][0], gi, de[i][1]], [de[j][0], gj, de[j][1]], [de[j][0], Yd, de[j][1]], [de[i][0], Yd, de[i][1]], C(0xcdbb98), [N[i][0] + N[j][0], 0, N[i][1] + N[j][1]]);
    }
    // On a slope the deck stands on a retaining wall (the water has to stay level above the
    // highest ground). Where that wall is tallest, a flight of steps leads up to the deck.
    {
      let si = -1, drop = 1.0;
      for (let i = 0; i < r.length; i++) {
        const j = (i + 1) % r.length, mx = (deckOut[i][0] + deckOut[j][0]) / 2, mz = (deckOut[i][1] + deckOut[j][1]) / 2;
        if (Math.hypot(deckOut[j][0] - deckOut[i][0], deckOut[j][1] - deckOut[i][1]) < 4) continue;
        const d = Yd - groundAt(mx, mz);
        if (d > drop) { drop = d; si = i; }
      }
      if (si >= 0) {
        const j = (si + 1) % r.length, a = deckOut[si], b = deckOut[j];
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, ex = b[0] - a[0], ez = b[1] - a[1], eL = Math.hypot(ex, ez);
        let ox = ez / eL, oz = -ex / eL;
        if (inPoly(mx + ox * 1.5, mz + oz * 1.5, deckOut)) { ox = -ox; oz = -oz; }
        const rot = Math.atan2(ox, oz), n = Math.min(14, Math.ceil(drop / 0.32)), rise = drop / n, run = 0.62;
        for (let k = 0; k < n; k++) {
          const top = Yd - rise * k, d = run * (k + 0.5), x = mx + ox * d, z = mz + oz * d, g = groundAt(x, z) - 0.4;
          if (top <= g + 0.4) break;
          poolSolid.box(x, (top + g) / 2, z, 3.4, top - g, run, rot, C(k % 2 ? 0xd9c7a3 : 0xe6d6b8));
        }
        stats.poolSteps = (stats.poolSteps || 0) + 1;
      }
    }
    // Ladders: one near each end of the longest edge.
    const ei = (() => { let bi = 0, bl = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > bl) { bl = L; bi = i; } } return bi; })();
    {
      const a = inner[ei], b = inner[(ei + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -(N[ei][0] + N[(ei + 1) % r.length][0]) / 2, nz = -(N[ei][1] + N[(ei + 1) % r.length][1]) / 2;
      const rot = Math.atan2(ux, uz);
      for (const f of L > 9 ? [0.15, 0.85] : [0.5]) {
        const lx = a[0] + ux * L * f, lz = a[1] + uz * L * f;
        for (const s of [-0.45, 0.45]) {
          const px = lx + ux * s, pz = lz + uz * s;
          poolSolid.box(px + nx * 0.25, (Yw - 0.4 + Yc + 0.9) / 2, pz + nz * 0.25, 0.12, Yc + 0.9 - Yw + 0.4, 0.12, rot, C(0xd8dde2));
          poolSolid.box(px - nx * 0.2, Yc + 0.9, pz - nz * 0.2, 0.12, 0.12, 0.9, rot, C(0xd8dde2));
          poolSolid.box(px - nx * 0.6, Yc + 0.45, pz - nz * 0.6, 0.12, 0.9, 0.12, rot, C(0xd8dde2));
        }
        for (const ry of [Yw - 0.25, Yw + 0.1]) poolSolid.box(lx + nx * 0.3, ry, lz + nz * 0.3, 0.9, 0.08, 0.3, rot, C(0xd8dde2));
      }
    }
    // Loungers and umbrellas on the deck of outdoor pools, along the two longest edges.
    if (!indoor) {
      const edges = r.map((p, i) => { const q = r[(i + 1) % r.length]; return { i, L: Math.hypot(q[0] - p[0], q[1] - p[1]) }; }).sort((x, y) => y.L - x.L).slice(0, 2);
      const cushions = [0x2f7fd1, 0xf28c28, 0xffffff, 0x2bb3a3].map(C), canopies = [0xf4f2ec, 0x2f7fd1, 0xe94e3c, 0xf2c94c].map(C);
      for (const { i, L } of edges) {
        if (L < 6) continue;
        const a = r[i], b = r[(i + 1) % r.length], ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
        const nx = (N[i][0] + N[(i + 1) % r.length][0]) / 2, nz = (N[i][1] + N[(i + 1) % r.length][1]) / 2, nl = Math.hypot(nx, nz) || 1;
        const ox = nx / nl, oz = nz / nl, rot = Math.atan2(ox, oz);
        const n = Math.floor((L - 3) / 2.6);
        for (let k = 0; k < n; k++) {
          const s = 1.5 + 1.3 + k * 2.6, h = hxz(a[0] + s, a[1], i + k);
          if (h < 0.18) continue;
          const x = a[0] + ux * s + ox * (0.6 + 2.0), z = a[1] + uz * s + oz * (0.6 + 2.0);
          placements.push({ kind: 'lounger', x, y: Yd, z, deck: true });
          // Lounger: frame, seat cushion, raised back toward the deck edge.
          poolSolid.box(x, Yd + 0.35, z, 0.85, 0.12, 2.2, rot, C(0xf2f2f2));
          for (const [lx, lz] of [[-0.35, -0.95], [0.35, -0.95], [-0.35, 0.95], [0.35, 0.95]]) poolSolid.box(x + Math.cos(rot) * lx + Math.sin(rot) * lz, Yd + 0.17, z - Math.sin(rot) * lx + Math.cos(rot) * lz, 0.1, 0.34, 0.1, rot, C(0xe2e2e2));
          poolSolid.box(x - ox * 0.25, Yd + 0.47, z - oz * 0.25, 0.75, 0.12, 1.3, rot, cushions[Math.floor(h * 4) % 4]);
          MAT.compose(V3.set(x + ox * 0.75, Yd + 0.75, z + oz * 0.75), Q.setFromEuler(new THREE.Euler(-0.75, rot, 0, 'YXZ')), S3.set(0.75, 0.12, 0.8));
          poolSolid.geo(BOX, MAT, cushions[Math.floor(h * 4) % 4]);
          if (k % 2 === 1) {
            const px = x - ux * 1.3, pz = z - uz * 1.3;
            placements.push({ kind: 'umbrella', x: px, y: Yd, z: pz, deck: true });
            poolSolid.box(px, Yd + 1.4, pz, 0.1, 2.8, 0.1, 0, C(0xf2f2f2));
            MAT.compose(V3.set(px, Yd + 2.95, pz), Q.identity(), S3.set(3.0, 0.7, 3.0));
            poolSolid.geo(CONE, MAT, canopies[Math.floor(h * 7) % 4]);
          }
        }
      }
    } else stats.indoorPools++;
    // Indoor pool with no mapped building: a glass hall over the deck.
    if (indoor) {
      const H = 7.5;
      for (let i = 0; i < r.length; i++) {
        const j = (i + 1) % r.length, a = deckOut[i], b = deckOut[j];
        glassAcc.quad([a[0], Yd, a[1]], [b[0], Yd, b[1]], [b[0], Yd + H, b[1]], [a[0], Yd + H, a[1]], C(0xbfe3f2));
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / 3.5));
        for (let k = 0; k <= n; k++) { const x = a[0] + (b[0] - a[0]) * k / n, z = a[1] + (b[1] - a[1]) * k / n; poolSolid.box(x, Yd + H / 2, z, 0.25, H, 0.25, 0, C(0xe9edf0)); }
        poolSolid.box((a[0] + b[0]) / 2, Yd + H, (a[1] + b[1]) / 2, 0.3, 0.3, L + 0.3, Math.atan2(b[0] - a[0], b[1] - a[1]), C(0xe9edf0));
      }
      for (let i = 1; i < deckOut.length - 1; i++) glassAcc.tri([deckOut[0][0], Yd + H, deckOut[0][1]], [deckOut[i][0], Yd + H, deckOut[i][1]], [deckOut[i + 1][0], Yd + H, deckOut[i + 1][1]], C(0xbfe3f2));
      colliders.push({ kind: 'building', points: deckOut, height: H + 1 });
    }
    // The water blocks (city.js blocks public pools already; this also covers the raised deck).
    colliders.push({ kind: 'water', points: r, y0: gmax - 3, y1: Yd + 4 });
    pools.push({ r, outer: indoor ? null : deckOut, cope: copeOut, bb: bbox(deckOut), Yd, Yc, indoor: !!indoor, access });
    stats.pools++;
  }
  const waterMat = new THREE.MeshToonMaterial({ map: waterTex(), color: 0xffffff, emissive: 0x0d5566, emissiveIntensity: 0.55 });
  const tileMat = new THREE.MeshToonMaterial({ map: tileTex(), color: 0xffffff });
  const glassMat = new THREE.MeshToonMaterial({ vertexColors: true, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
  if (!waterAcc.empty) group.add(waterAcc.mesh(waterMat, 'pool-water'));
  if (!tileAcc.empty) group.add(tileAcc.mesh(tileMat, 'pool-tiles'));
  if (!poolSolid.empty) { const m = poolSolid.mesh(solidMat, 'pool-decks'); m.castShadow = true; group.add(m); }
  if (!glassAcc.empty) group.add(glassAcc.mesh(glassMat, 'pool-glass'));

  // Walkable deck height at (x, z), or null off every deck.
  const PG = 64, poolGrid = new Map();
  for (const p of pools) for (let i = Math.floor(p.bb.minX / PG); i <= Math.floor(p.bb.maxX / PG); i++) for (let j = Math.floor(p.bb.minZ / PG); j <= Math.floor(p.bb.maxZ / PG); j++) {
    const k = i * 100003 + j; let l = poolGrid.get(k); if (!l) poolGrid.set(k, (l = [])); l.push(p);
  }
  const surfaceAt = (x, z) => {
    const l = poolGrid.get(Math.floor(x / PG) * 100003 + Math.floor(z / PG));
    if (!l) return null;
    for (const p of l) {
      if (!p.outer || x < p.bb.minX || x > p.bb.maxX || z < p.bb.minZ || z > p.bb.maxZ) continue;
      if (inPoly(x, z, p.outer) && !inPoly(x, z, p.r)) return inPoly(x, z, p.cope) ? p.Yc + 0.06 : p.Yd;
    }
    return null;
  };

  stats.tPools = Math.round(performance.now() - t0);
  // ---------- sealed zones ----------
  const zones = [];
  const sealedRings = [];
  for (const zd of data.zones || []) {
    if (!zd.sealed) continue;
    let r = ring(zd.pts);
    if (r.length < 3) continue;
    if (signedArea(r) < 0) r = r.reverse();
    const bb = bbox(r), b = city.bounds;
    // Off the playable map entirely: nothing to fence.
    if (b && (bb.minX > b.maxX || bb.maxX < b.minX || bb.minZ > b.maxZ || bb.maxZ < b.minZ)) continue;
    const military = zd.kind === 'military', wall = !!zd.wall;
    const H = military ? MIL_H : FENCE_H;
    stats.zones++; stats.sealed++;
    const S = resample(r, STEP, true);
    // Where mapped roads really cross the outline: only there does the fence become a gate (car)
    // or a closed wicket (path). Everywhere else a sample on a road means the outline runs down
    // or beside the street, and the sample slides off it.
    const xings = crossingsOf(r);
    // Outward normal of the ring at each sample (ring is CCW in x-z after the flip above).
    const samples = S.map((s) => {
      const sea = inSea(s.x, s.z);
      const o = { x: s.x, z: s.z, nx: s.uz, nz: -s.ux, sea, why: null };
      if (sea) return o;
      const xg = xings.find((c) => Math.hypot(c.x - s.x, c.z - s.z) < c.hw);
      if (xg) { o.why = xg.car ? 'car' : 'foot'; return o; }
      if (blockAt(s.x, s.z)) {
        // Into the zone first, so the street outside stays open and the fence never zigzags.
        const p = settle(o, o.nx, o.nz, 24, -1, true);
        if (!p.why) { o.x = p.x; o.z = p.z; } else if (inBuilding(s.x, s.z) || inLandmark(s.x, s.z)) o.why = 'solid';
      }
      return o;
    });
    const n = samples.length;
    const typeOf = (s) => (s.sea ? 'sea' : s.why === 'car' ? 'gate' : s.why === 'foot' ? 'wicket' : s.why ? 'solid' : 'fence');
    const group = () => {
      let start = samples.findIndex((s, i) => typeOf(s) !== typeOf(samples[(i + 1) % n]));
      if (start < 0) start = n - 1;
      const out = [];
      let cur = null;
      for (let k = 1; k <= n; k++) {
        const s = samples[(start + k) % n], type = typeOf(s);
        if (!cur || cur.type !== type) { if (cur) out.push(cur); cur = { type, pts: [] }; }
        cur.pts.push(s);
      }
      if (cur) out.push(cur);
      return out;
    };
    // A scrap of fence between two gates of one junction joins them into one mouth.
    {
      const g = group();
      g.forEach((run, i) => {
        const pv = g[(i - 1 + g.length) % g.length], nx = g[(i + 1) % g.length];
        if (g.length > 2 && run.type === 'fence' && run.pts.length <= 4 && pv.type === 'gate' && nx.type === 'gate') for (const s of run.pts) s.why = 'car';
      });
    }
    for (const s of samples) s.y = groundAt(s.x, s.z);
    let per = 0;
    for (let i = 0; i < n; i++) { const a = samples[i], c = samples[(i + 1) % n]; per += Math.hypot(c.x - a.x, c.z - a.z); }
    stats.perimeterUnits += per;
    // Runs of drawable samples (land, no road/building): fence; runs blocked by a car road: gate.
    const runs = group();
    // Collider: the whole loop, sea side included, simplified. A gate run is skipped, so the chain
    // jumps straight from the fence end on one side of the road to the other, where the gate is.
    const loopPts = runs.flatMap((run) => (run.type === 'gate' && runs.length > 1 ? [] : run.pts.map((p) => [p.x, p.z])));
    const loop = simplify([...loopPts, loopPts[0]], 0.4).slice(0, -1);
    chainColliders(loop, military ? 'fence' : 'wall', true);
    // A fence run reaches into the next sample so neighbouring runs meet (wickets are fenced too).
    runs.forEach((run, ri) => {
      const next = runs[(ri + 1) % runs.length];
      if (run.type === 'fence' || run.type === 'wicket') {
        const pts = [...run.pts];
        if (next && next.pts[0] && (next.type === 'fence' || next.type === 'wicket')) pts.push(next.pts[0]);
        drawFence(pts, { military, wall, H, zone: zd });
        // Where the fence runs into the sea, a sign faces the beach on the outside.
        const prev = runs[(ri - 1 + runs.length) % runs.length];
        for (const [end, k] of [[next?.type === 'sea', run.pts.length - 4], [prev?.type === 'sea', 3]]) {
          const m = run.pts[Math.max(0, Math.min(run.pts.length - 1, k))];
          if (!end || !m) continue;
          textSign(m.x + m.nx * 0.14, m.y + 1.1, m.z + m.nz * 0.14, m.nx, m.nz, military ? 'military' : 'private');
          noEntryPost(m.x + m.nx * 2.2, m.z + m.nz * 2.2, m.nx, m.nz);
        }
        if (run.type === 'wicket') { const m = run.pts[Math.floor(run.pts.length / 2)]; textSign(m.x + m.nx * 0.12, m.y + 1.0, m.z + m.nz * 0.12, m.nx, m.nz, military ? 'military' : 'private'); stats.footGates++; }
      } else if (run.type === 'gate') {
        const prev = runs[(ri - 1 + runs.length) % runs.length];
        const a = prev?.pts[prev.pts.length - 1] || run.pts[0], b = next?.pts[0] || run.pts[run.pts.length - 1];
        drawGate(a, b, run.pts, { military, H, ring: r });
      }
    });
    zones.push({ id: zd.id, kind: zd.kind, name: zd.name, r, bb, loop, runs: runs.map((run) => ({ type: run.type, pts: run.pts.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]) })) });
    sealedRings.push({ r, bb });
  }
  stats.perimeterMetres = Math.round(stats.perimeterUnits / SCALE);
  stats.perimeterUnits = Math.round(stats.perimeterUnits);

  function drawFence(pts, { military, wall, H, kind }) {
    if (pts.length < 2) return;
    const c = chunk(pts[0].x, pts[0].z);
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    const k = kind || (wall ? 'wall' : 'fence');
    if (k === 'wall') {
      stats.wallUnits += L;
      slabRun(c.solid, pts, -0.4, H, 0.5, col.wall, col.wallTop);
      // Panel joints every few samples, one flat strip on each face.
      for (let i = 0; i < pts.length; i += 3) {
        const p = pts[i], q = pts[Math.min(i + 1, pts.length - 1)], pr = pts[Math.max(i - 1, 0)], l = Math.hypot(q.x - pr.x, q.z - pr.z) || 1;
        const ux = (q.x - pr.x) / l * 0.08, uz = (q.z - pr.z) / l * 0.08, nx = -uz / 0.08 * 0.27, nz = ux / 0.08 * 0.27;
        for (const sg of [1, -1]) c.solid.quad([p.x + nx * sg - ux, p.y, p.z + nz * sg - uz], [p.x + nx * sg + ux, p.y, p.z + nz * sg + uz],
          [p.x + nx * sg + ux, p.y + H - 0.1, p.z + nz * sg + uz], [p.x + nx * sg - ux, p.y + H - 0.1, p.z + nz * sg - uz], col.wallJoint);
      }
    } else if (k === 'hedge') {
      stats.hedgeUnits += L;
      slabRun(c.solid, pts, -0.3, H * 0.85, 1.3, col.hedge, col.hedgeTop);
      for (let i = 0; i < pts.length; i++) { const p = pts[i]; if (hxz(p.x, p.z, 7) < 0.8) c.bushes.push([p.x, p.y + H * 0.8, p.z, 0.8 + hxz(p.x, p.z, 8) * 0.4, hxz(p.x, p.z, 9)]); }
    } else {
      stats.fenceUnits += L;
      ribbon(c.link, pts, 0.05, H, LINK_U, LINK_V, col.link);
      // Top rail: a thin strip just off each face of the mesh (no z-fight with it).
      for (const o of [0.05, -0.05]) strip(c.solid, pts, H - 0.16, H, o, col.rail);
      // Posts every other sample (~5 m), with Y-shaped wire outriggers on every other military post.
      const PH = H + (military ? 0.5 : 0.1) + 0.4;
      for (let i = 0; i < pts.length; i += 2) {
        const p = pts[i], nxt = pts[Math.min(i + 1, pts.length - 1)], prv = pts[Math.max(i - 1, 0)];
        const rot = Math.atan2(nxt.x - prv.x, nxt.z - prv.z);
        prism(c.solid, p.x, p.y - 0.4, p.z, 0.09, PH, military ? col.postMil : col.post);
        if (military && i % 4 === 0) {
          // Two flat arms leaning out of the post top, across the fence line.
          const ax = Math.cos(rot), az = -Math.sin(rot), tx = Math.sin(rot) * 0.05, tz = Math.cos(rot) * 0.05, y0 = p.y + H, y1 = p.y + H + 0.7;
          for (const sg of [1, -1]) c.solid.quad([p.x - tx, y0, p.z - tz], [p.x + tx, y0, p.z + tz], [p.x + ax * 0.5 * sg + tx, y1, p.z + az * 0.5 * sg + tz], [p.x + ax * 0.5 * sg - tx, y1, p.z + az * 0.5 * sg - tz], col.postMil);
        }
      }
    }
    if (military) {
      // Concertina coil on top: a vertical and a horizontal strip of loops read as a round coil.
      const top = H + (k === 'wall' ? 0.05 : 0.15);
      ribbon(c.coil, pts, top, top + COIL_H, COIL_U, COIL_H, col.link);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], l = Math.hypot(b.x - a.x, b.z - a.z);
        if (l < 1e-3) continue;
        const nx = -(b.z - a.z) / l * COIL_H / 2, nz = (b.x - a.x) / l * COIL_H / 2, y0 = top + COIL_H / 2;
        c.coil.quad([a.x + nx, a.y + y0, a.z + nz], [b.x + nx, b.y + y0, b.z + nz], [b.x - nx, b.y + y0, b.z - nz], [a.x - nx, a.y + y0, a.z - nz], col.link, null,
          [[0, 0], [l / COIL_U, 0], [l / COIL_U, 1], [0, 1]]);
      }
    }
    // Bushes outside the fence: dense near streets, sparse in the dunes. Plus a sign now and then.
    let since = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.nx == null) continue;
      const d = isDense(p.x, p.z), h = hxz(p.x, p.z, 3);
      if (d ? h < 0.82 : h < 0.3) {
        const off = 1.5 + hxz(p.x, p.z, 4) * 1.2, s = d ? 1.2 + hxz(p.x, p.z, 5) * 1.0 : 1.0 + hxz(p.x, p.z, 5) * 0.7;
        addBush(p.x + p.nx * off, p.z + p.nz * off, groundAt(p.x + p.nx * off, p.z + p.nz * off), s, 1);
        if (d && hxz(p.x, p.z, 6) < 0.5) addBush(p.x + p.nx * (off + 1.6) + p.nz * 1.2, p.z + p.nz * (off + 1.6) - p.nx * 1.2, p.y, s * 0.8, 2);
      }
      since += STEP;
      if (d && since > 120 && i > 0 && i < pts.length - 1 && military !== undefined && kind == null) {
        since = 0;
        textSign(p.x + p.nx * 0.14, p.y + 1.1, p.z + p.nz * 0.14, p.nx, p.nz, military ? (hxz(p.x, p.z, 11) < 0.5 ? 'military' : 'photo') : 'private');
      }
    }
  }

  function drawGate(a, b, run, { military, H, ring: zr }) {
    // a, b: the fence ends on either side of the road; the gate (and the collider) spans a-b.
    const dx = b.x - a.x, dz = b.z - a.z, w = Math.hypot(dx, dz);
    if (w < 2) return;
    const ux = dx / w, uz = dz / w;
    const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2, y = Math.min(a.y, b.y, groundAt(cx, cz));
    // Outward normal of the gate line: the side whose probe is outside the zone.
    let nx = uz, nz = -ux;
    if (inPoly(cx + nx * 8, cz + nz * 8, zr) && !inPoly(cx - nx * 8, cz - nz * 8, zr)) { nx = -nx; nz = -nz; }
    // A wide mouth (a junction on the outline) is fenced at both ends, with the gate in the middle.
    const GW = 22;
    if (w > GW + 4) {
      const line = (p, q) => {
        const L = Math.hypot(q.x - p.x, q.z - p.z), k = Math.max(1, Math.round(L / STEP)), out = [];
        for (let i = 0; i <= k; i++) { const x = p.x + (q.x - p.x) * i / k, z = p.z + (q.z - p.z) * i / k; out.push({ x, z, y: groundAt(x, z), nx, nz }); }
        return out;
      };
      const a2 = { x: cx - ux * GW / 2, z: cz - uz * GW / 2 }, b2 = { x: cx + ux * GW / 2, z: cz + uz * GW / 2 };
      a2.y = groundAt(a2.x, a2.z); b2.y = groundAt(b2.x, b2.z);
      drawFence(line(a, a2), { military, wall: false, H });
      drawFence(line(b2, b), { military, wall: false, H });
      return drawGate(a2, b2, run, { military, H, ring: zr });
    }
    const c = chunk(cx, cz), rot = Math.atan2(ux, uz);
    stats.gates++;
    // Pillars.
    for (const p of [a, b]) c.solid.box(p.x, p.y + (H + 0.8) / 2 - 0.3, p.z, 1.0, H + 1.1, 1.0, rot, col.pillar);
    // Closed sliding gate: steel frame with mesh between, a hair inside the pillars.
    const gx0 = a.x + ux * 0.5, gz0 = a.z + uz * 0.5, gx1 = b.x - ux * 0.5, gz1 = b.z - uz * 0.5, gl = w - 1;
    const gp = [{ x: gx0, z: gz0, y }, { x: gx1, z: gz1, y }];
    ribbon(c.link, gp, 0.15, H - 0.1, LINK_U, LINK_V, col.link);
    for (const ry of [0.15, H / 2, H - 0.1]) c.solid.box(cx, y + ry, cz, 0.14, 0.14, gl, rot, col.gate);
    const nb = Math.max(2, Math.round(gl / 2.4));
    for (let k = 0; k <= nb; k++) { const f = k / nb; c.solid.box(gx0 + (gx1 - gx0) * f, y + H / 2, gz0 + (gz1 - gz0) * f, 0.14, H - 0.2, 0.14, rot, col.gate); }
    // Gate sign facing out.
    textSign(cx + nx * 0.12, y + H * 0.42, cz + nz * 0.12, nx, nz, military ? 'military' : 'private', Math.min(6, gl * 0.8), Math.min(1.5, gl * 0.2));
    if (military) textSign(cx + nx * 0.12, y + H * 0.42 - 1.0, cz + nz * 0.12, nx, nz, 'photo', Math.min(3.6, gl * 0.6), Math.min(0.9, gl * 0.15));
    // Red-white boom barrier outside the gate.
    const bx0 = a.x + nx * 3.2 + ux * 0.6, bz0 = a.z + nz * 3.2 + uz * 0.6, by = groundAt(bx0, bz0);
    c.solid.box(bx0, by + 0.6, bz0, 0.6, 1.2, 0.6, rot, col.steel);
    const segs = Math.max(2, Math.floor((w - 1.6) / 1.0));
    for (let k = 0; k < segs; k++) c.solid.box(bx0 + ux * (0.6 + k + 0.5), by + 1.05, bz0 + uz * (0.6 + k + 0.5), 0.2, 0.2, 1.0, rot, k % 2 ? col.white : col.red);
    // No-entry discs either side, outside.
    for (const [p, s] of [[a, -1], [b, 1]]) noEntryPost(p.x + ux * s * 1.6 + nx * 1.4, p.z + uz * s * 1.6 + nz * 1.4, nx, nz);
    // Guard booth inside, beside the gate, with a flag.
    const hx = b.x + ux * 3.2 - nx * 3.8, hz = b.z + uz * 3.2 - nz * 3.8;
    if (!roadAt(hx, hz)) {
      const hy = groundAt(hx, hz);
      placements.push({ kind: 'booth', x: hx, y: hy, z: hz });
      c.solid.box(hx, hy + 1.45, hz, 3.4, 3.3, 3.4, rot, col.booth);
      c.solid.box(hx, hy + 2.05, hz, 3.5, 1.0, 3.5, rot, col.boothWin);
      c.solid.box(hx, hy + 3.25, hz, 4.3, 0.35, 4.3, rot, col.roof);
      c.solid.box(hx - ux * 1.71, hy + 1.05, hz - uz * 1.71, 1.0, 2.1, 0.04, rot, col.door);
      colliders.push({ kind: 'building', height: hy + 3.5, points: [[-1.8, -1.8], [1.8, -1.8], [1.8, 1.8], [-1.8, 1.8]].map(([lx, lz]) => [hx + ux * lx + nx * lz, hz + uz * lx + nz * lz]) });
      stats.booths++;
      if (military) {
        const fx = hx + ux * 2.6 - nx * 1.5, fz = hz + uz * 2.6 - nz * 1.5, fy = groundAt(fx, fz);
        c.solid.box(fx, fy + 4.5, fz, 0.14, 9, 0.14, 0, col.steel);
        c.solid.box(fx + ux * 1.05, fy + 8.3, fz + uz * 1.05, 2.0, 1.3, 0.04, rot + Math.PI / 2, col.white);
        for (const sy of [8.75, 7.85]) c.solid.box(fx + ux * 1.05, fy + sy, fz + uz * 1.05, 2.0, 0.16, 0.05, rot + Math.PI / 2, col.blue);
      }
    }
  }

  stats.tZones = Math.round(performance.now() - t0);
  // ---------- other barrier lines ----------
  const inSealed = (x, z) => sealedRings.some((s) => x >= s.bb.minX - 14 && x <= s.bb.maxX + 14 && z >= s.bb.minZ - 14 && z <= s.bb.maxZ + 14
    && (inPoly(x, z, s.r) || s.r.some((p, i) => segDist(x, z, p[0], p[1], s.r[(i + 1) % s.r.length][0], s.r[(i + 1) % s.r.length][1]) < 14)));
  // Mapped gates on ordinary barrier lines: open ones (no access=private|no) leave a walk-through
  // gap with two pillars, closed ones stay fenced and get a gate panel.
  const GG = 32, gateGrid = new Map();
  for (const [x, z, open] of data.gates || []) {
    const k = Math.floor(x / GG) * 100003 + Math.floor(z / GG);
    let l = gateGrid.get(k); if (!l) gateGrid.set(k, (l = [])); l.push({ x, z, open: !!open, used: false });
  }
  const gateNear = (x, z, r = 2.6) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const g of gateGrid.get((Math.floor(x / GG) + i) * 100003 + Math.floor(z / GG) + j) || []) if (Math.hypot(g.x - x, g.z - z) < r) return g;
    return null;
  };
  const gatePillar = (p, H) => { chunk(p.x, p.z).solid.box(p.x, p.y + H / 2, p.z, 0.6, H + 0.4, 0.6, 0, col.pillar); colliders.push({ kind: 'wall', points: [[p.x - 0.3, p.z - 0.3], [p.x + 0.3, p.z - 0.3], [p.x + 0.3, p.z + 0.3], [p.x - 0.3, p.z + 0.3]], y0: p.y - 2, y1: p.y + H + 1 }); };
  const OPEN = { open: true };
  for (const [ki, hm, , flat] of data.barriers || []) {
    const P = ring(flat);
    if (P.length < 2) continue;
    const kind = ['fence', 'wall', 'hedge'][ki] || 'fence';
    const H = hm > 0 ? Math.min(Math.max(hm * SCALE, 1.2), 4.5) : kind === 'wall' ? WALL_H : kind === 'hedge' ? HEDGE_H : FENCE_H;
    const S = resample(P, STEP, false);
    let side = 1;
    const kept = S.map((s) => {
      const nx = s.uz, nz = -s.ux;
      if (inSea(s.x, s.z) || inSealed(s.x, s.z)) return null;
      const g = gateNear(s.x, s.z);
      if (g && g.open) { if (!g.used) { g.used = true; stats.openGates++; } return OPEN; }
      const p = settle(s, nx, nz, 12, side);
      if (p.side) side = p.side;
      return p.why ? null : { x: p.x, z: p.z, y: groundAt(p.x, p.z), nx: null, nz: null };
    });
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        drawFence(run, { military: false, wall: kind === 'wall', H, kind });
        chainColliders(simplify(run.map((p) => [p.x, p.z]), 0.4), kind, false);
        stats.barrierLines++;
      }
      run = [];
    };
    let afterGate = false;
    for (const p of kept) {
      if (p === OPEN) { if (run.length) gatePillar(run[run.length - 1], H); flush(); afterGate = true; continue; }
      if (p) { if (afterGate && !run.length) gatePillar(p, H); run.push(p); } else flush();
      afterGate = false;
    }
    flush();
  }

  stats.tLines = Math.round(performance.now() - t0);
  // ---------- meshes ----------
  const bushGeo = new THREE.IcosahedronGeometry(1, 0);
  for (const [key, c] of chunks) {
    if (!c.solid.empty) { group.add(c.solid.mesh(solidMat, `details-solid ${key}`)); stats.meshes++; }
    if (!c.link.empty) { group.add(c.link.mesh(linkMat, `details-link ${key}`)); stats.meshes++; }
    if (!c.coil.empty) { group.add(c.coil.mesh(coilMat, `details-coil ${key}`)); stats.meshes++; }
    if (!c.sign.empty) { group.add(c.sign.mesh(signMat, `details-signs ${key}`)); stats.meshes++; }
    if (c.bushes.length) {
      const im = new THREE.InstancedMesh(bushGeo, bushMat, c.bushes.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      c.bushes.forEach(([x, y, z, s, h], i) => {
        m.compose(V3.set(x, y, z), q.setFromEuler(e.set(0, h * 6.28, 0)), S3.set(s * (1 + h * 0.3), s * (0.8 + h * 0.3), s * (1.1 - h * 0.2)));
        im.setMatrixAt(i, m);
        im.setColorAt(i, bushCols[Math.floor(h * bushCols.length) % bushCols.length]);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.name = `details-bushes ${key}`;
      im.receiveShadow = true;
      group.add(im);
      stats.meshes++;
    }
  }
  scene.add(group);

  // Roads into or inside a sealed zone: still drawn, but traffic and routing should skip them.
  const restrictedAt = (x, z) => {
    for (const zn of zones) if (x >= zn.bb.minX && x <= zn.bb.maxX && z >= zn.bb.minZ && z <= zn.bb.maxZ && inPoly(x, z, zn.r)) return zn;
    return null;
  };
  for (const r of city.roads || []) {
    if (!r.points) continue;
    const zn = r.points.find((p) => restrictedAt(p[0], p[1]));
    if (zn) { r.restricted = restrictedAt(zn[0], zn[1]).id; stats.restrictedRoads++; }
  }

  stats.fenceUnits = Math.round(stats.fenceUnits); stats.wallUnits = Math.round(stats.wallUnits); stats.hedgeUnits = Math.round(stats.hedgeUnits);
  stats.colliders = colliders.length;
  stats.ms = Math.round(performance.now() - t0);
  group.userData.stats = stats;
  group.userData.zones = zones.map((z) => ({ id: z.id, kind: z.kind, name: z.name, bb: z.bb }));
  return { group, colliders, stats, surfaceAt, restrictedAt, zones, pools };
}
