// Rishon LeZion city builder: turns data/rishon.json (baked from OSM by
// tools/fetch_osm.py) into a toon-shaded, chunked, mostly merged scene.
// Coordinates in the data are already projected through src/geo.js.
//
// Round 2 (roads): a readable road hierarchy. Every carriageway is as wide as its lanes, every
// urban street gets raised kerbed sidewalks, dual carriageways get planted medians, bridges stand
// on pillars with ramps down to the ground network, and the railway runs in its own fenced
// ballast corridor. Street props (lamps, street trees, benches, shelters) live in dressing.js,
// buildings in buildings.js, trees in trees.js (this file draws none).
//
// Round 3 (terrain seams): raised ways get one absolute profile with vertical curves, decks clear
// what passes below, heightAt follows the structure you are on, and the heightfield under roads is
// smoothed offline (tools/fetch_terrain.py). tools/audit_seams.js and tools/drive_seams.js check it.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SCALE, project } from '../geo.js';
import { createMosheDayanBridge } from './bridge_moshe_dayan.js';

export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

const DATA_URL = new URL('../../data/rishon.json', import.meta.url);
// Local-language city name from code points so the source stays ASCII.
const RISHON_LOCAL = String.fromCharCode(0x5e8, 0x5d0, 0x5e9, 0x5d5, 0x5df, 0x20, 0x5dc, 0x5e6, 0x5d9, 0x5d5, 0x5df);

// Footprints are true scale (SCALE u/m from geo.js, baked into the data) but characters
// are ~5.2 u tall, so storeys are exaggerated: a 4-storey shikun stands about 3x the player.
export const FLOOR_H = 4;
export const WIN_W = 3.2;
export const PARAPET = 0.8;
// Constants below marked "at 0.25" were tuned when the world was 0.25 u/m; K rescales them.
const BASE_SCALE = 0.25;
const CHUNK = 400; // at 0.25; building chunks
const V = FLOOR_H / 1.5; // storey-relative props (heaters, balconies) were modelled for 1.5 u floors

// ---------- road cross-sections ----------
// Avatars (~5.2 u) and cars (4.8 u wide) are about 2.3x human scale on a true-scale map, so road
// cross-sections are widened by WIDEN. Centre lines stay exactly where OSM puts them.
const WIDEN = 1.4;
const U = (metres) => metres * SCALE * WIDEN;
const LANE = U(3.5);
const SW = U(2.8); // sidewalk strip width
const DECK = 9.5; // deck height per bridge level: a coach (7.45 u) clears every underpass with margin (free height >= 8.6)
const SLAB = 1.3; // deck thickness
const RAMP_SLOPE = 0.075; // absolute grade of every ramp (Israeli interchange ramps are 5-8 %)
const RAIL_SLOPE = 0.035;
const DECK_SMOOTH = 30;   // deck profile follows the ground smoothed over this many units
const DECK_MARGIN = 0.4;  // extra clearance so vertical curves never eat into DECK
// Vertical curves (height blend k): a curve is 2k / (grade change) long, ~50 u for a ramp landing
// on level ground, which keeps the grade change under 5 % per 10 u even against a 5 % hillside.
// 3.5: a ramp landing in a dip whose far side climbs at 8 % (Etzel at Moshe Dayan) still gets a
// curve of ~45 u.
const SAG_K = 3.5;        // where a ramp lands
const CREST_K = 2.5;      // where a ramp leaves a deck
const NODE_FADE = 24;     // node reconciliation fades out over this length
const ATTACH_MAX = 3;     // an end this close in height to the street it lands on joins it
const ATTACH_FADE = 40;   // ...fading back over this length
const ATTACH_MAX_RAMP = 5; // a long slip road may climb this far to the road it lands on (DECK is 9.5)
const MAX_FORCED = 0.1;   // steepest grade a ramp may take to touch down on the road it joins
// Nodes where a ramp lands on a road that must not be pinned to the ground there: the descent
// carries on over the way beyond at ramp grade (the ground rises 7 % east of the Moshe Dayan deck,
// so touching down at the 63 u node needed 15 %). Keys are keyOf() of the node.
const SOFT_LANDINGS = new Set(['-1886.6,-1597.5', '-2276.8,-659.6']);
// Vertices where two carriageways cross at one shared vertex and one of them is still settling
// towards the ground (a sag tail), so the other sat 0.4-0.5 u below it: a step for every car that
// crosses (Ayalon west slip roads at Sderot HaAtid). Both take the higher height there, faded over NODE_FADE.
const NODE_MEETS = new Set(['-2345.7,-1450.7']);
const HUMP_R = 12;
const MAX_FORCED_PATH = 0.7; // footbridge approaches may be steep: past STAIR_GRADE they are drawn as stairs
const STAIR_GRADE = 0.2;
const BANK_FADE = 3;      // a raised way banks with the ground below this height, flat above it        // rounding of a hump where a ramp lands on the middle of a road
// heightAt: the highest rise a walker can step onto in one move. Ramps rise < 0.1 u per frame at
// car speed; at 1.2 a car on a slip road jumped onto the parallel ramp a metre above it.
const STEP_UP = 0.6;
const SNAP_BAND = 1.0; // heightAt keeps a walker on a surface up to this far below its feet
const LEDGE_MAX = 1.3; // heightAt lifts a walker on a structure onto a deck up to this far above its feet when nothing else is underfoot
const RCHUNK = 600; // road chunk size; small enough for frustum culling, big enough for few draw calls
const BALLAST_HW = U(1.9);
const BALLAST_H = 0.45;
const GAUGE = U(1.435);
const FENCE_OFF = U(5.2);

// OSM highway class -> rank (draw order, junction priority), default lanes (two-way / one-way),
// extra metres (shoulders, parking strips), asphalt shade.
const RC = {
  motorway: { rank: 9, lanes: 6, lanes1: 3, extra: 3.5, color: 0x383d45 },
  motorway_link: { rank: 6, lanes: 2, lanes1: 1, extra: 3, color: 0x3c414a, link: true },
  trunk: { rank: 8, lanes: 4, lanes1: 2, extra: 2.5, color: 0x3e434b },
  trunk_link: { rank: 6, lanes: 2, lanes1: 1, extra: 2.5, color: 0x41464e, link: true },
  primary: { rank: 7, lanes: 4, lanes1: 2, extra: 1, color: 0x454950, urban: true },
  primary_link: { rank: 5, lanes: 2, lanes1: 1, extra: 2, color: 0x484c53, urban: true, link: true },
  secondary: { rank: 6, lanes: 2, lanes1: 2, extra: 3, color: 0x4e5258, urban: true },
  secondary_link: { rank: 4, lanes: 2, lanes1: 1, extra: 2, color: 0x4e5258, urban: true, link: true },
  tertiary: { rank: 5, lanes: 2, lanes1: 1, extra: 3, color: 0x575a60, urban: true },
  tertiary_link: { rank: 4, lanes: 2, lanes1: 1, extra: 2, color: 0x575a60, urban: true, link: true },
  unclassified: { rank: 3, lanes: 2, lanes1: 1, extra: 3, color: 0x64666b, urban: true },
  residential: { rank: 3, lanes: 2, lanes1: 1, extra: 3, color: 0x64666b, urban: true },
  living_street: { rank: 2, lanes: 1, lanes1: 1, extra: 3, color: 0x9f9a95 }, // grey interlocking pavers
  service: { rank: 1, lanes: 1, lanes1: 1, extra: 1, color: 0x77777b },
};
// Path class -> [width in metres, colour].
const PATH = {
  pedestrian: [8, 0xdccdb6], footway: [2.5, 0xe8dec6], path: [2, 0xd6c49b], track: [3, 0xc7b086],
  steps: [2.5, 0xcfc6b8], cycleway: [2.5, 0xc76f5d], promenade: [9, 0xe4d7c2],
};
// Collapsed kinds from data baked before round 2 -> an OSM class.
const OLD_KIND = { motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary', residential: 'residential', service: 'service' };

// Vertical stack of flat layers. Gaps are generous because the camera far plane is large.
const Y = { land: 0, grass: 0.04, beach: 0.06, pitch: 0.08, water: 0.03, path: 0.12, road: 0.15 };
const roadY = (rank) => Y.road + rank * 0.008;
const MARK_LIFT = 0.035;
const SIDE_TOP = 0.42; // sidewalk and median top: a kerb about 0.2 u above the asphalt
const PLAT_H = 1.0;       // station platform top above the ground on its centre line
const STAIR_W = U(2.2);   // station stair flight width
const STAIR_GRADE_STEEP = 0.6; // station stairs: rise per unit of run (about 31 degrees)
const DECK_KERB = 0.25; // bridge sidewalks stand this far above the deck asphalt
const JOIN_GAP = 6.5;   // parallel decks closer than this share one deck with a barrier between them

const PALETTE = {
  land: 0xe4d9b8, grass: 0x8fcf63, park: 0x7cc45a, wood: 0x5fae4f, pitch: 0x6cc35c,
  sand: 0xf4dc9c, sea: 0x3aa6e0, lake: 0x4fb6dd,
  line: 0xf6f3ea, lineYellow: 0xf2c84b,
  sidewalk: 0xd4d5d3, sidewalkSide: 0xa8a59e, kerb: 0xb3b0a9, kerbRed: 0xd2473c, kerbWhite: 0xf5f2ea,
  median: 0x86c35a, medianDry: 0x9bbf6a, hedge: 0x4f9d45, barrier: 0xd9d5cc,
  concrete: 0xd3cdc1, underside: 0x9b968d, parapetTop: 0xefebe3, pillar: 0xc6c0b3,
  ballast: 0x978e83, ballastSide: 0x80786d, sleeper: 0x6b5545, rail: 0x8e8b87, railTop: 0xc9c7c2,
  corridor: 0xbcae93, fence: 0x8f979e,
  platform: 0xd8cfc0, platformSide: 0xb9b0a1, roof: 0xd9d3c7, roofTile: 0xc9694b,
};

const WALLS_RES = [0xffffff, 0xfbf7ef, 0xf7f0e2, 0xf2e8d5, 0xfde4d8, 0xe1eff6, 0xece6f7, 0xe4f2dc, 0xfbf0c6, 0xf6e6d2, 0xffffff, 0xfaf4ea];
const WALLS_STONE = [0xeadcbc, 0xe2d0a8, 0xf0e5cc, 0xe8d6b4];
const WALLS_COM = [0xd2e3ec, 0xe7eef0, 0xf0e6d6, 0xcfdde3];
const WALLS_IND = [0xd9d5cc, 0xcfd3d6, 0xe0d8c8];
const WALLS_PUB = [0xf2cf8f, 0xeeb98a, 0xf3e0a8, 0xe6c49c];

// ---------- small helpers ----------

const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];
const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) >>> 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d) >>> 0; n ^= n >>> 15; return (n >>> 0) / 4294967296; };
const val = (v, i) => (typeof v === 'number' ? v : v[i]);
// C1 smooth max/min of two heights: a parabolic vertical curve wherever they are within k.
const smax = (a, b, k) => { const d = Math.abs(a - b); return Math.max(a, b) + (d < k ? ((k - d) * (k - d)) / (4 * k) : 0); };
const smin = (a, b, k) => { const d = Math.abs(a - b); return Math.min(a, b) - (d < k ? ((k - d) * (k - d)) / (4 * k) : 0); };

function ring(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
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
function polylineLength(pts) {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return s;
}
function cumulative(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}
// Inserts vertices so no segment is longer than `step` (ramps need heights between sparse OSM nodes).
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    out.push(b);
  }
  return out;
}
// Douglas-Peucker on [x, z] points, keeping endpoints.
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    let best = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = L < 1e-9 ? Math.hypot(pts[i][0] - ax, pts[i][1] - az) : Math.abs(dx * (az - pts[i][1]) - dz * (ax - pts[i][0])) / L;
      if (d > best) { best = d; idx = i; }
    }
    if (best > eps) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Points every `step` units along a polyline, with the local direction, segment index and fraction.
function* along(pts, step, start = step / 2) {
  let carry = start;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const sl = Math.hypot(dx, dz);
    if (sl < 1e-3) continue;
    let t = carry;
    while (t < sl) { yield [a[0] + (dx * t) / sl, a[1] + (dz * t) / sl, dx / sl, dz / sl, i, t / sl]; t += step; }
    carry = t - sl;
  }
}

// Arc-length lookup on a polyline with optional per-vertex heights.
function walker(pts, ys = 0) {
  const cum = cumulative(pts), n = pts.length, L = cum[n - 1];
  return {
    L,
    at(s) {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      const sl = cum[hi] - cum[lo] || 1e-6;
      const t = Math.max(0, Math.min(1, (s - cum[lo]) / sl));
      const a = pts[lo], b = pts[hi];
      return {
        x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t,
        y: val(ys, lo) + (val(ys, hi) - val(ys, lo)) * t,
        dx: (b[0] - a[0]) / sl, dz: (b[1] - a[1]) / sl,
      };
    },
  };
}

// Per-vertex right-hand normals (x east, z south: right of travel), pre-scaled for mitred offsets.
function vnormals(pts) {
  const n = pts.length, out = new Array(n);
  let lx = 1, lz = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let d0x = 0, d0z = 0, d1x = 0, d1z = 0;
    if (i > 0) { d0x = p[0] - pts[i - 1][0]; d0z = p[1] - pts[i - 1][1]; const l = Math.hypot(d0x, d0z); if (l > 1e-6) { d0x /= l; d0z /= l; } else d0x = d0z = 0; }
    if (i < n - 1) { d1x = pts[i + 1][0] - p[0]; d1z = pts[i + 1][1] - p[1]; const l = Math.hypot(d1x, d1z); if (l > 1e-6) { d1x /= l; d1z /= l; } else d1x = d1z = 0; }
    if (!d0x && !d0z) { d0x = d1x; d0z = d1z; }
    if (!d1x && !d1z) { d1x = d0x; d1z = d0z; }
    if (!d0x && !d0z) { d0x = d1x = lx; d0z = d1z = lz; }
    let tx = d0x + d1x, tz = d0z + d1z;
    let tl = Math.hypot(tx, tz);
    if (tl < 1e-4) { tx = d1x; tz = d1z; tl = 1; }
    tx /= tl; tz /= tl;
    const nx = -tz, nz = tx;
    const cos = nx * -d1z + nz * d1x;
    const s = 1 / Math.max(0.5, cos);
    out[i] = [nx * s, nz * s];
    lx = d1x; lz = d1z;
  }
  return out;
}
function offsetLine(pts, off, N = vnormals(pts)) {
  return pts.map((p, i) => [p[0] + N[i][0] * val(off, i), p[1] + N[i][1] * val(off, i)]);
}
const ep = (pts, N, i, off, y) => [pts[i][0] + N[i][0] * off, y, pts[i][1] + N[i][1] * off];

function coastXAt(coast, z) {
  let best = null;
  for (let i = 0; i < coast.length - 1; i++) {
    const [x1, z1] = coast[i], [x2, z2] = coast[i + 1];
    if ((z1 - z) * (z2 - z) <= 0 && z1 !== z2) {
      const x = x1 + ((x2 - x1) * (z - z1)) / (z2 - z1);
      best = best === null ? x : Math.max(best, x);
    }
  }
  return best;
}

function toonGradient() {
  const data = new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function windowTexture() {
  // One tile = one window bay of one floor. Bottom and top bands stay plain wall
  // so parapets and roofs mapped there show no glass.
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#e9e4da'; // sill shadow
  g.fillRect(14, 44, 36, 4);
  g.fillStyle = '#5d86a6';
  g.fillRect(17, 14, 30, 30);
  g.fillStyle = '#8fb9d6';
  g.fillRect(17, 14, 30, 13);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.beginPath(); g.moveTo(20, 41); g.lineTo(30, 17); g.lineTo(35, 17); g.lineTo(25, 41); g.fill();
  g.fillStyle = '#f7f3ea'; // mullion
  g.fillRect(31, 14, 2, 30);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Terrain hook. Geometry is written relative to the ground and draped onto groundAt() when the
// mesh is finalised, except while ABS is set (bridge decks, ramps, pillars keep their own grade).
let groundAt = () => 0;
// True inside the rail trench (terrain.js cut): the ground there is below the rim.
let inCut = () => false;
// Ground ignoring the rail trench (its rim); groundAt where there is no trench.
let rimGround = (x, z) => groundAt(x, z);
let ABS = false;
const absolute = (fn) => { ABS = true; try { fn(); } finally { ABS = false; } };

// Accumulates triangles with position/normal/color(/uv) into one BufferGeometry.
class Acc {
  constructor(uv = false) { this.p = []; this.n = []; this.c = []; this.f = []; this.uv = uv ? [] : null; }
  get empty() { return this.p.length === 0; }
  tri(a, b, c, col, up = null, uvs = null) {
    // a, b, c: [x, y, z]. Face normal is computed; flipped to agree with `up` if given.
    let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    let vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (up && nx * up[0] + ny * up[1] + nz * up[2] < 0) {
      [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz;
      if (uvs) uvs = [uvs[0], uvs[2], uvs[1]];
    }
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const v of [a, b, c]) { this.p.push(v[0], v[1], v[2]); this.n.push(nx, ny, nz); this.f.push(ABS ? 1 : 0); }
    const cols = Array.isArray(col) ? col : [col, col, col];
    for (const k of cols) this.c.push(k.r, k.g, k.b);
    if (this.uv) { const u = uvs || [[0.05, 0.05], [0.05, 0.05], [0.05, 0.05]]; for (const q of u) this.uv.push(q[0], q[1]); }
  }
  quad(a, b, c, d, col, up, uvs) {
    this.tri(a, b, c, col, up, uvs && [uvs[0], uvs[1], uvs[2]]);
    this.tri(a, c, d, col, up, uvs && [uvs[0], uvs[2], uvs[3]]);
  }
  geometry(drape = false) {
    if (drape) for (let i = 0, v = 0; v < this.f.length; v++, i += 3) if (!this.f[v]) this.p[i + 1] += groundAt(this.p[i], this.p[i + 2]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

// One accumulator per road chunk, so the network merges into few meshes that still frustum-cull.
class Layer {
  constructor(name, material, shadows = false) { this.name = name; this.mat = material; this.shadows = shadows; this.map = new Map(); }
  at(x, z) {
    const k = `${Math.floor(x / RCHUNK)},${Math.floor(z / RCHUNK)}`;
    let a = this.map.get(k);
    if (!a) { a = new Acc(); this.map.set(k, a); }
    return a;
  }
}

// Uniform grid of line segments for "what road is under this point" queries.
class SegGrid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return (i + 4000) * 8192 + (j + 4000); }
  add(s, pad) {
    const c = this.cell;
    const i0 = Math.floor((Math.min(s.ax, s.bx) - pad) / c), i1 = Math.floor((Math.max(s.ax, s.bx) + pad) / c);
    const j0 = Math.floor((Math.min(s.az, s.bz) - pad) / c), j1 = Math.floor((Math.max(s.az, s.bz) + pad) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j);
      let l = this.map.get(k);
      if (!l) { l = []; this.map.set(k, l); }
      l.push(s);
    }
  }
  at(x, z) { return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))); }
  each(x0, z0, x1, z1, fn) {
    const c = this.cell;
    for (let i = Math.floor(Math.min(x0, x1) / c); i <= Math.floor(Math.max(x0, x1) / c); i++)
      for (let j = Math.floor(Math.min(z0, z1) / c); j <= Math.floor(Math.max(z0, z1) / c); j++) {
        const l = this.map.get(this.key(i, j));
        if (l) for (const s of l) if (fn(s) === false) return;
      }
  }
}
function mkSeg(a, b, props) {
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1e-6;
  return Object.assign({ ax: a[0], az: a[1], bx: b[0], bz: b[1], len, ux: dx / len, uz: dz / len }, props);
}
let segT = 0; // parameter of the last segDist projection, to avoid allocating per query
function segDist(s, x, z) {
  let t = ((x - s.ax) * s.ux + (z - s.az) * s.uz) / s.len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  segT = t;
  return Math.hypot(x - (s.ax + s.ux * s.len * t), z - (s.az + s.uz * s.len * t));
}
function segCross(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + rx * t, a[1] + rz * t];
}

// ---------- geometry writers (all into chunked layers) ----------

const UP = [0, 1, 0];
const col = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const HAZE = new THREE.Color(0xdcd6c8);

// Flat polygon at height y into an accumulator.
function fillPoly(acc, pts, y, color) {
  if (pts.length < 3) return;
  const v2 = pts.map((p) => new THREE.Vector2(p[0], p[1]));
  let tris;
  try { tris = THREE.ShapeUtils.triangulateShape(v2, []); } catch { return; }
  for (const t of tris) {
    const a = pts[t[0]], b = pts[t[1]], c = pts[t[2]];
    acc.tri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], color, UP);
  }
}

// Flat polygon split into triangles no longer than maxEdge, so it can drape over the terrain.
function fillPolyDense(acc, pts, y, color, maxEdge, skip = null) {
  if (pts.length < 3) return;
  const v2 = pts.map((p) => new THREE.Vector2(p[0], p[1]));
  let tris;
  try { tris = THREE.ShapeUtils.triangulateShape(v2, []); } catch { return; }
  const m2 = maxEdge * maxEdge;
  const stack = tris.map((t) => [pts[t[0]], pts[t[1]], pts[t[2]]]);
  let guard = 0;
  while (stack.length && guard++ < 400000) {
    const [a, b, c] = stack.pop();
    const ab = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2, bc = (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2, ca = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2;
    const mx = Math.max(ab, bc, ca);
    if (mx <= m2) {
      // Nothing draped spans the rail trench (it would lie over it like a lid).
      const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[1] + b[1] + c[1]) / 3;
      if (inCut(cx, cz) || inCut(a[0], a[1]) || inCut(b[0], b[1]) || inCut(c[0], c[1])) continue;
      if (skip && skip(cx, cz)) continue;
      acc.tri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], color, UP);
      continue;
    }
    // Split the longest edge at its midpoint.
    if (mx === ab) { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; stack.push([a, m, c], [m, b, c]); }
    else if (mx === bc) { const m = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]; stack.push([a, b, m], [a, m, c]); }
    else { const m = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; stack.push([a, b, m], [m, b, c]); }
  }
}

// Ribbon along a polyline with mitred joins, constant width (single accumulator; land and beach).
function ribbon(acc, pts, width, y, color) {
  const N = vnormals(pts), h = width / 2;
  for (let i = 0; i < pts.length - 1; i++) acc.quad(ep(pts, N, i, -h, y), ep(pts, N, i + 1, -h, y), ep(pts, N, i + 1, h, y), ep(pts, N, i, h, y), color, UP);
}

// Flat strip between lateral offsets a and b (numbers or per-vertex arrays) at heights ys.
// `ysB` (optional) gives the b edge its own heights, for strips that bank with the ground.
function strip(layer, pts, ys, a, b, color, N = vnormals(pts), segIf = null, ysB = ys) {
  for (let i = 0; i < pts.length - 1; i++) {
    if (segIf && !segIf(i)) continue;
    const c = typeof color === 'function' ? color(i) : color;
    layer.at(pts[i][0], pts[i][1]).quad(
      ep(pts, N, i, val(a, i), val(ys, i)), ep(pts, N, i + 1, val(a, i + 1), val(ys, i + 1)),
      ep(pts, N, i + 1, val(b, i + 1), val(ysB, i + 1)), ep(pts, N, i, val(b, i), val(ysB, i)), c, UP);
  }
}

// Solid strip: top face between offsets a and b at height yt, side walls down to yb, optional
// underside and end caps. Used for sidewalks, medians, decks, parapets, ballast and rails.
function slab(layer, pts, yb, a, b, yt, topC, sideC, opt = {}) {
  const N = opt.N || vnormals(pts), n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    if (opt.segIf && !opt.segIf(i)) continue;
    const acc = layer.at(pts[i][0], pts[i][1]);
    const a0 = val(a, i), a1 = val(a, i + 1), b0 = val(b, i), b1 = val(b, i + 1);
    const At0 = ep(pts, N, i, a0, val(yt, i)), At1 = ep(pts, N, i + 1, a1, val(yt, i + 1));
    const Bt0 = ep(pts, N, i, b0, val(yt, i)), Bt1 = ep(pts, N, i + 1, b1, val(yt, i + 1));
    const Ab0 = ep(pts, N, i, a0, val(yb, i)), Ab1 = ep(pts, N, i + 1, a1, val(yb, i + 1));
    const Bb0 = ep(pts, N, i, b0, val(yb, i)), Bb1 = ep(pts, N, i + 1, b1, val(yb, i + 1));
    if (topC) acc.quad(At0, At1, Bt1, Bt0, typeof topC === 'function' ? topC(i) : topC, UP);
    const sA = Math.sign(a0 - b0) || -1, nx = N[i][0], nz = N[i][1];
    if (sideC && opt.sideA !== false) acc.quad(Ab0, Ab1, At1, At0, sideC, [nx * sA, 0, nz * sA]);
    if (sideC && opt.sideB !== false) acc.quad(Bb0, Bb1, Bt1, Bt0, sideC, [-nx * sA, 0, -nz * sA]);
    if (opt.under && val(yb, i) > 0.3 && val(yb, i + 1) > 0.3) acc.quad(Ab0, Ab1, Bb1, Bb0, opt.under, [0, -1, 0]);
  }
  if (opt.caps !== false && sideC && n >= 2) {
    for (const [i, j] of [[0, 1], [n - 1, n - 2]]) {
      const dx = pts[i][0] - pts[j][0], dz = pts[i][1] - pts[j][1];
      layer.at(pts[i][0], pts[i][1]).quad(ep(pts, N, i, val(a, i), val(yt, i)), ep(pts, N, i, val(b, i), val(yt, i)),
        ep(pts, N, i, val(b, i), val(yb, i)), ep(pts, N, i, val(a, i), val(yb, i)), sideC, [dx, 0, dz]);
    }
  }
}

// Box in a local frame rotated about y (no bottom face).
function box(layer, x, y0, z, sx, sy, sz, rot, topC, sideC) {
  const c = Math.cos(rot), s = Math.sin(rot), hx = sx / 2, hz = sz / 2;
  const P = (lx, lz, y) => [x + lx * c + lz * s, y, z - lx * s + lz * c];
  const y1 = y0 + sy;
  const acc = layer.at(x, z);
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  acc.quad(P(-hx, -hz, y1), P(hx, -hz, y1), P(hx, hz, y1), P(-hx, hz, y1), topC, UP);
  for (let k = 0; k < 4; k++) {
    const p = corners[k], q = corners[(k + 1) % 4];
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    acc.quad(P(p[0], p[1], y0), P(q[0], q[1], y0), P(q[0], q[1], y1), P(p[0], p[1], y1), sideC, [mx * c + mz * s, 0, -mx * s + mz * c]);
  }
}
function rectCollider(x, z, sx, sz, rot) {
  const c = Math.cos(rot), s = Math.sin(rot), hx = sx / 2, hz = sz / 2;
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([lx, lz]) => [x + lx * c + lz * s, z - lx * s + lz * c]);
}

// ---------- prop templates (merged once, instanced per chunk) ----------

function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (geo.index) geo = geo.toNonIndexed();
  geo.deleteAttribute('uv');
  return geo;
}

function solarTemplate() {
  // The Israeli rooftop "dud shemesh": tilted collector plus a white horizontal tank.
  const frame = paint(new THREE.BoxGeometry(1.2, 0.5, 0.06).translate(0, 0.45, 0.35), 0xb8bcc2);
  const panel = new THREE.BoxGeometry(1.1, 0.06, 0.9);
  panel.rotateX(-0.6);
  panel.translate(0, 0.45, 0.05);
  const tank = new THREE.CylinderGeometry(0.24, 0.24, 1.25, 8);
  tank.rotateZ(Math.PI / 2);
  tank.translate(0, 0.92, -0.4);
  const legs = paint(new THREE.BoxGeometry(1.2, 0.7, 0.08).translate(0, 0.35, -0.4), 0x9aa0a6);
  const g = mergeGeometries([frame, paint(panel, 0x2a4f86), paint(tank, 0xf8f8f4), legs]);
  g.computeVertexNormals();
  return g;
}

function balconyTemplate() {
  // Unit length along x, sticks out towards +z.
  const slab0 = paint(new THREE.BoxGeometry(1, 0.14, 0.7).translate(0, 0.07, 0.35), 0xf4efe4);
  const rail = paint(new THREE.BoxGeometry(1, 0.5, 0.08).translate(0, 0.4, 0.66), 0xffffff);
  const g = mergeGeometries([slab0, rail]);
  g.computeVertexNormals();
  return g;
}

// ---------- neighbourhood signs ----------

// Every neighbourhood gets a municipal-style board just behind the sidewalk of the nearest street,
// all boards sharing one canvas atlas and one merged mesh, so 20+ signs cost two draw calls.
const SIGN_W = 20, SIGN_H = 5, SIGN_LIFT = 6.5;
function buildNeighbourhoodSigns(places, carRoads, blocked, K, toon) {
  if (!places.length) return null;
  const cols = 2, slotW = 1024, slotH = 256, rows = Math.ceil(places.length / cols);
  const cv = document.createElement('canvas');
  cv.width = cols * slotW; cv.height = rows * slotH;
  const g = cv.getContext('2d');
  g.direction = 'rtl'; g.textAlign = 'center'; g.textBaseline = 'middle';
  places.forEach((pl, i) => {
    const x0 = (i % cols) * slotW, y0 = Math.floor(i / cols) * slotH;
    g.fillStyle = '#ffffff'; g.fillRect(x0, y0, slotW, slotH);
    g.fillStyle = '#2f6b9a'; g.fillRect(x0 + 10, y0 + 10, slotW - 20, slotH - 20);
    g.strokeStyle = '#ffffff'; g.lineWidth = 6; g.strokeRect(x0 + 24, y0 + 24, slotW - 48, slotH - 48);
    g.fillStyle = '#ffffff';
    let size = 120;
    g.font = `bold ${size}px "Arial Hebrew", "Noto Sans Hebrew", Arial, sans-serif`;
    while (g.measureText(pl.nameLocal).width > slotW - 120 && size > 50) { size -= 6; g.font = `bold ${size}px "Arial Hebrew", "Noto Sans Hebrew", Arial, sans-serif`; }
    g.fillText(pl.nameLocal, x0 + slotW / 2, y0 + slotH * 0.44);
    g.font = '48px "Arial Hebrew", "Noto Sans Hebrew", Arial, sans-serif';
    g.fillStyle = '#d8e8f4';
    g.fillText(RISHON_LOCAL, x0 + slotW / 2, y0 + slotH * 0.78);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const boards = [], posts = [], out = [];
  places.forEach((pl, i) => {
    const px = pl.x, pz = pl.z;
    // Nearest street segment within reach; stand the board behind its sidewalk, parallel to it.
    let best = null, bd = 80 * K;
    for (const r of carRoads) {
      const pts = r.points;
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
        const qx = ax + dx * t, qz = az + dz * t, d = Math.hypot(px - qx, pz - qz);
        if (d < bd) { bd = d; best = { qx, qz, dx, dz, w: r.width, side: Math.sign((px - qx) * -dz + (pz - qz) * dx) || 1 }; }
      }
    }
    let x = px, z = pz, rot = 0;
    if (best) {
      const l = Math.hypot(best.dx, best.dz) || 1, ux = best.dx / l, uz = best.dz / l;
      const off = best.w / 2 + SW + 2.5;
      rot = Math.atan2(-uz, ux);
      // Slide along the kerb (and try the far side) until the board clears every footprint and road.
      let found = false;
      for (const step of [0, 6, -6, 12, -12, 20, -20, 30, -30]) {
        for (const side of [best.side, -best.side]) {
          const cx = best.qx + ux * step * K - uz * off * side, cz = best.qz + uz * step * K + ux * off * side;
          const ex = (SIGN_W / 2) * ux, ez = (SIGN_W / 2) * uz;
          if (!blocked(cx, cz) && !blocked(cx + ex, cz + ez) && !blocked(cx - ex, cz - ez)) { x = cx; z = cz; found = true; break; }
        }
        if (found) break;
      }
      if (!found) return;
    } else if (blocked(x, z)) return;
    out.push({ id: `place-${i}`, name: pl.name, nameLocal: pl.nameLocal, x, z });
    const u0 = (i % cols) / cols, u1 = u0 + 1 / cols;
    const v1 = 1 - Math.floor(i / cols) / rows, v0 = v1 - 1 / rows;
    const board = new THREE.BoxGeometry(SIGN_W, SIGN_H, 0.4);
    // Both big faces (+z, -z) show the text; BoxGeometry lays each face's u left-to-right as seen from outside.
    const uv = board.attributes.uv;
    for (let k = 0; k < uv.count; k++) {
      const face = Math.floor(k / 4);
      const su = uv.getX(k), sv = uv.getY(k);
      if (face === 4 || face === 5) uv.setXY(k, u0 + su * (u1 - u0), v0 + sv * (v1 - v0));
      else uv.setXY(k, u0 + 0.002, v0 + 0.01); // edges sample the white rim
    }
    const gy = groundAt(x, z);
    board.translate(0, SIGN_LIFT + SIGN_H / 2, 0).rotateY(rot).translate(x, gy, z);
    boards.push(board);
    for (const sx of [-SIGN_W * 0.38, SIGN_W * 0.38]) {
      const p = new THREE.CylinderGeometry(0.35, 0.35, SIGN_LIFT + SIGN_H * 0.8 + 1, 8);
      p.translate(sx, (SIGN_LIFT + SIGN_H * 0.8 + 1) / 2 - 1, 0).rotateY(rot).translate(x, gy, z);
      posts.push(paint(p, 0x9aa3ab));
    }
  });
  if (!boards.length) return null;
  const group = new THREE.Group();
  group.name = 'neighbourhood-signs';
  const bm = new THREE.Mesh(mergeGeometries(boards), toon({ map: tex }));
  const pm = new THREE.Mesh(mergeGeometries(posts), toon({ vertexColors: true }));
  bm.castShadow = pm.castShadow = true;
  group.add(bm, pm);
  return { group, places: out };
}

// ---------- street-name signs ----------

// Israeli municipal street sign: a white board with a blue frame on a grey post, the local name
// big and the English one small. One atlas for the whole city (a cell per street name, cell 0 is
// the post's grey), signs merged per 800 u map cell so frustum culling drops the far ones: one
// draw call per visible cell, not 4000 signs every frame.
const SSIGN_W = 7, SSIGN_H = 1.8, SSIGN_LIFT = 3.4;
const SSIGN_CELL = 800, SSIGN_COLS = 16, SSIGN_PX_W = 256, SSIGN_PX_H = 64, SSIGN_MAX_ROWS = 128;
function buildStreetSigns(signs, toon) {
  if (!signs.length) return null;
  const cap = SSIGN_COLS * SSIGN_MAX_ROWS - 1; // slot 0 stays grey for the posts
  const names = [...new Map(signs.map((s) => [s.name, s.nameEn])).entries()].slice(0, cap);
  const slot = new Map(names.map(([n], i) => [n, i + 1]));
  const cols = SSIGN_COLS, sw = SSIGN_PX_W, sh = SSIGN_PX_H, rows = Math.ceil((names.length + 1) / cols);
  const cv = document.createElement('canvas');
  cv.width = cols * sw; cv.height = rows * sh;
  const g = cv.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#8f979e'; g.fillRect(0, 0, sw, sh);
  names.forEach(([name, nameEn], k) => {
    const i = k + 1;
    const x0 = (i % cols) * sw, y0 = Math.floor(i / cols) * sh;
    g.fillStyle = '#ffffff'; g.fillRect(x0, y0, sw, sh);
    g.strokeStyle = '#1f4e8c'; g.lineWidth = 5; g.strokeRect(x0 + 5, y0 + 5, sw - 10, sh - 10);
    g.fillStyle = '#1f4e8c';
    g.direction = 'rtl';
    let size = 31;
    const font = (px) => `bold ${px}px "Arial Hebrew", "Noto Sans Hebrew", Arial, sans-serif`;
    g.font = font(size);
    while (g.measureText(name).width > sw - 30 && size > 13) { size -= 2; g.font = font(size); }
    g.fillText(name, x0 + sw / 2, y0 + sh * (nameEn ? 0.42 : 0.5));
    if (nameEn) {
      g.direction = 'ltr';
      g.font = '12px Arial, sans-serif';
      g.fillText(nameEn, x0 + sw / 2, y0 + sh * 0.8);
    }
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const W = cv.width, H = cv.height;
  const cells = new Map();
  for (const s of signs) {
    const i = slot.get(s.name);
    if (!i) continue;
    const u0 = (i % cols) / cols, u1 = u0 + 1 / cols;
    const v1 = 1 - Math.floor(i / cols) / rows, v0 = v1 - 1 / rows;
    const board = new THREE.BoxGeometry(SSIGN_W, SSIGN_H, 0.18);
    const uv = board.attributes.uv;
    const eu = ((i % cols) * sw + 2) / W, ev = 1 - (Math.floor(i / cols) * sh + 2) / H; // white margin texel
    for (let k = 0; k < uv.count; k++) {
      const face = Math.floor(k / 4), su = uv.getX(k), sv = uv.getY(k);
      if (face === 4 || face === 5) uv.setXY(k, u0 + su * (u1 - u0), v0 + sv * (v1 - v0));
      else uv.setXY(k, eu, ev);
    }
    const gy = groundAt(s.x, s.z);
    board.translate(0, SSIGN_LIFT + SSIGN_H / 2, 0).rotateY(s.rot).translate(s.x, gy, s.z);
    const p = new THREE.CylinderGeometry(0.16, 0.16, SSIGN_LIFT + SSIGN_H + 0.6, 6, 1, true);
    const pu = p.attributes.uv;
    for (let k = 0; k < pu.count; k++) pu.setXY(k, 0.5 / W, 1 - 0.5 / H);
    p.translate(0, (SSIGN_LIFT + SSIGN_H + 0.6) / 2 - 0.3, 0).rotateY(s.rot).translate(s.x, gy, s.z);
    const key = Math.floor(s.x / SSIGN_CELL) + ',' + Math.floor(s.z / SSIGN_CELL);
    let c = cells.get(key);
    if (!c) cells.set(key, c = []);
    c.push(board, p);
  }
  const group = new THREE.Group();
  group.name = 'street-signs';
  const mat = toon({ map: tex });
  for (const parts of cells.values()) {
    const m = new THREE.Mesh(mergeGeometries(parts), mat);
    // No shadow caster: a 1.8 u board throws nothing worth a second pass over every visible cell.
    group.add(m);
  }
  group.userData.stats = { signs: signs.length, names: names.length, cells: cells.size, atlas: [W, H] };
  return group;
}

// ---------- data ----------

// Data baked at another SCALE is rescaled in place, so every consumer sees one coordinate system.
function rescaleData(data, f) {
  const sc = (a) => { if (a) for (let i = 0; i < a.length; i++) a[i] *= f; };
  for (const b of data.buildings || []) sc(b[2]);
  for (const r of data.roads || []) sc(r[2]);
  for (const r of data.rail || []) sc(r[1]);
  for (const k of ['beach', 'grass', 'pitches', 'woods', 'platforms', 'boundary']) for (const f2 of data[k] || []) sc(f2);
  for (const k of ['parks', 'water', 'waterways']) for (const p of data[k] || []) sc(p[1]);
  for (const a of data.fountains || []) { a[0] *= f; a[1] *= f; a[2] *= f; }
  for (const a of data.amenities || []) { a[3] *= f; a[4] *= f; }
  for (const a of data.places || []) { a[3] *= f; a[4] *= f; }
  for (const a of data.junctions || []) { a[3] *= f; a[4] *= f; }
  for (const a of data.busStops || []) { a[2] *= f; a[3] *= f; }
  for (const a of data.signals || []) { a[1] *= f; a[2] *= f; }
  sc(data.sea); sc(data.coast);
  if (data.spawn) { data.spawn.x *= f; data.spawn.z *= f; }
  const b = data.meta.bounds;
  for (const k of ['minX', 'maxX', 'minZ', 'maxZ']) b[k] *= f;
  data.meta.scale = SCALE;
}

// ---------- road network ----------

function buildNetwork(data, ctx) {
  // Section timings (ms) for load-time work, reported in city.group.userData.stats.networkProfile.
  const prof = {};
  let lapName = null, lapT = performance.now();
  const lap = (name) => { const t = performance.now(); if (lapName) prof[lapName] = Math.round(t - lapT); lapName = name; lapT = t; };
  const { coast, inBuilding, colliders, layers, K, platforms } = ctx;
  const C = (hex, k) => col(hex, k);
  const WHITE = C(PALETTE.line), YELLOW = C(PALETTE.lineYellow);
  const coastNear = (x, z) => { const cx = coastXAt(coast, z); return cx !== null && x - cx < 90 * K && x - cx > -5 * K; };
  const keyOf = (p) => `${p[0]},${p[1]}`;

  lap('parse ways');
  // ---- parse ways ----
  const ways = [];
  const mappedSidewalks = new SegGrid(30);
  for (const row of data.roads) {
    const [kind0, name, f, a0] = row;
    const a = a0 || {};
    const pts = ring(f);
    if (pts.length < 2) continue;
    if (kind0 === 'sidewalk') {
      // Separately mapped sidewalks are not drawn (they sit inside the widened carriageways); they
      // only tell us which side of a road has a sidewalk when the road itself says "no".
      for (let i = 0; i < pts.length - 1; i++) mappedSidewalks.add(mkSeg(pts[i], pts[i + 1], {}), 0);
      continue;
    }
    const hw = a.hw || OLD_KIND[kind0] || kind0;
    const cls = RC[hw] || null;
    let kind = hw, path = null;
    if (!cls) {
      path = PATH[hw] ? hw : 'footway';
      if ((path === 'footway' || path === 'pedestrian' || path === 'cycleway') && coast.length && pts.some((p) => coastNear(p[0], p[1]))) { path = 'promenade'; kind = 'promenade'; }
    }
    const oneway = !!a.oneway;
    let lanes = 0, w, median = 0;
    if (cls) {
      lanes = Math.min(oneway ? 6 : 8, a.lanes || (oneway ? cls.lanes1 : cls.lanes));
      let metres = lanes * 3.5 + cls.extra;
      if (hw === 'service' && (a.service === 'driveway' || a.service === 'alley')) metres = 4;
      // Boulevards drawn as one two-way way get a planted centre median.
      if (!oneway && !a.roundabout && cls.rank >= 6 && !cls.link && lanes >= 4) median = U(4);
      w = U(metres) + median;
    } else w = U(PATH[path][0]);
    const tunnel = !!a.tunnel && a.tunnel !== 'building_passage';
    const layer = a.layer || 0;
    ways.push({
      idx: ways.length, kind, hw, cls, path, name, nameEn: a.nameEn || '', ref: a.ref || '', pts, w, hw2: w / 2,
      lanes, oneway, median, roundabout: !!a.roundabout, sidewalkTag: a.sidewalk, tunnel, layer,
      bridgeTag: !!a.bridge, elevated: !tunnel && (!!a.bridge || layer > 0), rank: cls ? cls.rank : 0,
    });
  }
  const rails = [];
  for (const [tun, f, a0] of data.rail || []) {
    const a = a0 || {};
    const pts = ring(f);
    if (pts.length < 2) continue;
    const layer = a.layer || 0, tunnel = !!tun || !!a.tunnel;
    rails.push({ rail: true, pts, tunnel, layer, bridgeTag: !!a.bridge, elevated: !tunnel && (!!a.bridge || layer > 0), hw2: BALLAST_HW, w: BALLAST_HW * 2, rank: 0 });
  }
  const all = [...ways, ...rails];
  for (const w of all) {
    // On terrain, vertices every grid cell let flat strips follow the ground instead of cutting it.
    if (ctx.terrain) w.pts = densify(w.pts, 12);
    w.len = polylineLength(w.pts); w.level = 0; w.ys = null;
  }

  // Railway stations without OSM platform polygons nearby (their side platforms are built here).
  const bareStations = (data.amenities || []).filter((a) => a[0] === 'station')
    .map(([, nameEn, nameLocal, x, z]) => ({ nameEn, nameLocal, x, z }))
    .filter((s) => !platforms.some((r) => r.some((p) => Math.hypot(p[0] - s.x, p[1] - s.z) < 300)));
  let deckGroups = [];
  lap('bridge levels');
  // ---- bridge levels: a deck rises one level above whatever actually passes under it ----
  // (ground ways -> 1, a level-1 deck -> 2). OSM layer only orders the decks; a layer-2 bridge over
  // a plain motorway stands at level 1. Bridges over nothing (streams, parks) stay at grade.
  {
    const els = all.filter((w) => w.elevated);
    const g = new SegGrid(40);
    for (const w of all) if (!w.tunnel) for (let i = 0; i < w.pts.length - 1; i++) g.add(mkSeg(w.pts[i], w.pts[i + 1], { a: w.pts[i], b: w.pts[i + 1], w }), 0);
    for (const w of els) {
      const s0 = w.pts[0], s1 = w.pts[w.pts.length - 1];
      w.under = new Set();
      w.cross = [];
      for (let i = 0; i < w.pts.length - 1; i++) {
        const a = w.pts[i], b = w.pts[i + 1];
        g.each(a[0], a[1], b[0], b[1], (s) => {
          if (s.w === w || w.under.has(s.w)) return true;
          // Only ways on a lower layer can pass underneath.
          const below = s.w.elevated ? s.w.layer < w.layer : true;
          if (!below) return true;
          const p = segCross(a, b, s.a, s.b);
          if (p && Math.hypot(p[0] - s0[0], p[1] - s0[1]) > 1.5 && Math.hypot(p[0] - s1[0], p[1] - s1[1]) > 1.5) {
            w.under.add(s.w);
            // Where it crosses, so the deck can be lifted to clear it (arc position filled in below).
            w.cross.push({ i, p, u: s.w });
          }
          return true;
        });
      }
    }
    // Connected elevated ways of one layer form one structure, so a viaduct never steps.
    const parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    els.forEach((w, i) => {
      w.gid = `w${i}`;
      parent.set(w.gid, w.gid);
      for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) {
        const k = `${w.rail ? 'r' : 'h'}${w.layer}|${keyOf(p)}`;
        if (!parent.has(k)) parent.set(k, k);
        unite(w.gid, k);
      }
    });
    const groups = new Map();
    for (const w of els) { const r = find(w.gid); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(w); }
    // Lower layers first, so a deck over another deck sees that deck's final level.
    const ordered = [...groups.values()].sort((a, b) => a[0].layer - b[0].layer);
    for (const grp of ordered) {
      let lv = 0;
      for (const w of grp) for (const u of w.under) lv = Math.max(lv, (u.elevated ? u.level : 0) + 1);
      for (const w of grp) w.level = Math.min(lv, 3);
    }
    deckGroups = ordered;
    // Station tracks: OSM puts the HaRishonim terminus tracks at layer 1 in the median of the
    // raised Route 431, but nothing passes under them, so they stayed at grade and ramped down
    // through the station 8 u below the carriageways beside them. Layer-tagged tracks at a station
    // without mapped platforms are decks at the level of the road beside them (photos: Commons
    // "Rishonim train station 01-03.jpg", 2022: platforms level with the motorway, the concourse
    // below at the west end).
    for (const grp of ordered) {
      if (grp[0].level || !grp[0].rail || grp[0].layer < 1) continue;
      if (!grp.some((w) => w.pts.some((p) => bareStations.some((s) => Math.hypot(p[0] - s.x, p[1] - s.z) < 140)))) continue;
      for (const w of grp) { w.level = 1; w.station = true; }
    }
    // Bridges over water with nothing else below (footbridges in parks, streams under a street)
    // used to stay at grade, under the now visible water and behind its collider: they rise to
    // clear the surface, with ramps inside the bridge and on to the paths that join it.
    if (ctx.waterTop) for (const grp of ordered) {
      if (grp[0].level) continue;
      for (const w of grp) {
        if (w.tunnel) continue;
        const cum = cumulative(w.pts);
        let top = -Infinity, s0 = Infinity, s1 = -Infinity;
        for (const [x, z, , , i, t] of along(w.pts, 1.5, 0.75)) {
          const h = ctx.waterTop(x, z);
          if (h === null) continue;
          const s = cum[i] + (cum[i + 1] - cum[i]) * t;
          top = Math.max(top, h); s0 = Math.min(s0, s); s1 = Math.max(s1, s);
        }
        if (top > -Infinity) w.water = { top, s0: s0 - 1.5, s1: s1 + 1.5 };
      }
    }
    // Short footbridges over nothing this module knows of (a landmark's own pond, like the one in
    // Gan HaIr, OSM way 234820884) were flat strips at grade nobody could tell from the path:
    // they arch gently instead (rise L * 0.08, at most 1.6 u), walkable, with parapets.
    for (const grp of ordered) {
      if (grp[0].level) continue;
      for (const w of grp) if (!w.cls && !w.rail && !w.tunnel && w.bridgeTag && !w.water && w.len > 4 && w.len < 60) w.arch = Math.min(1.6, w.len * 0.08);
    }
  }

  lap('heights');
  // ---- heights: one absolute surface profile (ya) per raised way ----
  // Decks follow the ground under them, smoothed along the structure, one level above whatever
  // passes underneath (the whole structure is lifted if something below still lacks clearance).
  // Ramps leave every deck end at a constant absolute grade (not relative to a sloping hillside),
  // round over the deck end with a crest curve, and land on the ground with a sag curve. Heights are
  // shared per node, so connected ways meet exactly, and a ramp whose far end lands on the middle of
  // an at-grade road is made to touch down there instead of ending in a step.
  for (const w of all) if (!w.tunnel) { w.cum = cumulative(w.pts); w.g = w.pts.map((p) => groundAt(p[0], p[1])); }
  const reprofile = (w, step) => {
    const oldCum = w.cum, oldP = w.P;
    w.pts = densify(w.pts, step);
    w.cum = cumulative(w.pts);
    w.g = w.pts.map((p) => groundAt(p[0], p[1]));
    if (oldP) { const wk = walker(oldCum.map((c) => [c, 0]), oldP); w.P = w.cum.map((c) => wk.at(c).y); }
  };
  const lerpAt = (w, arr, x, z) => {
    let best = Infinity, y = arr[0];
    for (let i = 0; i < w.pts.length - 1; i++) {
      const s = mkSeg(w.pts[i], w.pts[i + 1], {});
      const d = segDist(s, x, z);
      if (d < best) { best = d; y = arr[i] + (arr[i + 1] - arr[i]) * segT; }
    }
    return y;
  };
  // Deck plateau: Gaussian-smoothed ground along the way, pinned to the real ground at both ends so
  // the deck ways of one structure meet, plus the deck level.
  const plateau = (w) => {
    // The rim, not the floor of the rail trench: a deck over the cut must not sag into it.
    const g = w.pts.map((p) => rimGround(p[0], p[1]));
    const n = w.pts.length, cum = w.cum, sm = new Array(n), R = 3 * DECK_SMOOTH, k2 = 2 * DECK_SMOOTH * DECK_SMOOTH;
    for (let i = 0; i < n; i++) {
      let acc = 0, ws = 0;
      for (let j = i; j >= 0 && cum[i] - cum[j] <= R; j--) { const e = Math.exp(-((cum[i] - cum[j]) ** 2) / k2); acc += g[j] * e; ws += e; }
      for (let j = i + 1; j < n && cum[j] - cum[i] <= R; j++) { const e = Math.exp(-((cum[j] - cum[i]) ** 2) / k2); acc += g[j] * e; ws += e; }
      sm[i] = acc / ws;
    }
    const e0 = g[0] - sm[0], e1 = g[n - 1] - sm[n - 1], L = cum[n - 1] || 1;
    return sm.map((y, i) => y + e0 + ((e1 - e0) * cum[i]) / L + w.level * DECK);
  };
  // Group lift: the whole structure rises together so its ways keep meeting. `under(c)` is the
  // surface height of what passes below at crossing c (first pass: ground or the lower deck's
  // plateau; later passes: the final profile, which includes ramps).
  const groupLift = new Map();
  const surfaceBelow = (c) => {
    const u = c.u, ug = groundAt(c.p[0], c.p[1]);
    if (u.ya) return lerpAt(u, u.ya, c.p[0], c.p[1]) + (u.rail ? BALLAST_H + 0.45 : 0.2);
    if (u.P) return lerpAt(u, u.P, c.p[0], c.p[1]);
    return ug + (u.rail ? BALLAST_H + 0.45 : 0.2);
  };
  // A slip road that merges into the deck crosses its centreline just before the shared node; that
  // is a merge, not something passing underneath.
  const grpKeys = new Map();
  const merges = (grp, u) => {
    if (!grpKeys.has(grp)) grpKeys.set(grp, new Set(grp.flatMap((w) => [keyOf(w.pts[0]), keyOf(w.pts[w.pts.length - 1])])));
    const ks = grpKeys.get(grp);
    return ks.has(keyOf(u.pts[0])) || ks.has(keyOf(u.pts[u.pts.length - 1]));
  };
  const deficit = (grp) => {
    let lift = -Infinity;
    for (const w of grp) {
      if (w.tunnel || !w.P) continue;
      for (const c of w.cross) if (!merges(grp, c.u)) lift = Math.max(lift, surfaceBelow(c) + DECK + DECK_MARGIN - lerpAt(w, w.ya || w.P, c.p[0], c.p[1]));
      // Never into the hill it spans.
      for (let i = 0; i < w.pts.length; i++) lift = Math.max(lift, w.g[i] + 2.5 - (w.ya ? w.ya[i] : w.P[i]));
    }
    return lift;
  };
  // A bridge over water at grade: deck over the water, a ramp (paths: 1 in 8, roads: 1 in 16)
  // down to the ground inside the bridge where it is long enough; the rest continues on the ways
  // joining it like any other deck end.
  const waterDeck = (w) => {
    const T = w.water.top + (w.cls ? 1.4 : 1.6), sl = w.cls ? 0.06 : 0.125;
    return w.pts.map((p, i) => {
      const s = w.cum[i], d = s < w.water.s0 ? w.water.s0 - s : s > w.water.s1 ? s - w.water.s1 : 0;
      return Math.max(w.g[i], T - sl * d);
    });
  };
  const setPlateaus = () => {
    for (const grp of deckGroups) {
      if (!grp[0].level) { for (const w of grp) if (w.water) w.P = waterDeck(w); else if (w.arch) w.P = w.g.map((y, i) => y + w.arch * Math.sin((Math.PI * w.cum[i]) / w.len)); continue; } // other bridges over nothing stay at grade
      for (const w of grp) if (!w.tunnel) w.P = plateau(w);
      if (!groupLift.has(grp)) groupLift.set(grp, Math.max(0, deficit(grp)));
      const lift = groupLift.get(grp);
      if (lift > 0) for (const w of grp) if (w.P) w.P = w.P.map((y) => y + lift);
    }
    harmonizeTwinDecks();
  };
  // The two carriageways of one bridge are separate OSM ways, each with its own deck profile, so
  // they differed by 0.3-0.9 u across the median: a step for every walker crossing the Moshe
  // Dayan deck. Where two free-standing decks of opposite direction run side by side (centre lines
  // within TWIN_DECK_GAP), each takes the mean of the two heights across from it.
  const TWIN_DECK_GAP = 42;
  const TWIN_DECK_AT = [[-2013, -1637, 100]]; // [x, z, radius]: both decks must lie wholly inside
  const harmonizeTwinDecks = () => {
    // Only the Moshe Dayan deck so far: applied to every pair of twin decks in the city it kinked
    // 60 other ramps (kinkRaised 45 -> 109) where the two profiles meet connected ramps differently.
    const decks = all.filter((w) => w.cls && w.level > 0 && w.P && !w.tunnel && TWIN_DECK_AT.some(([cx, cz, r]) => w.pts.every((p) => Math.hypot(p[0] - cx, p[1] - cz) < r)));
    const nearest = (b, x, z) => {
      let best = Infinity, y = 0, ux = 0, uz = 0;
      for (let i = 0; i < b.pts.length - 1; i++) {
        const s = mkSeg(b.pts[i], b.pts[i + 1], {});
        const d = segDist(s, x, z);
        if (d < best) { best = d; y = b.P[i] + (b.P[i + 1] - b.P[i]) * segT; ux = s.ux; uz = s.uz; }
      }
      return { d: best, y, ux, uz };
    };
    const target = new Map();
    const box = (w) => w.pts.reduce((q, p) => [Math.min(q[0], p[0]), Math.min(q[1], p[1]), Math.max(q[2], p[0]), Math.max(q[3], p[1])], [1e9, 1e9, -1e9, -1e9]);
    for (const d of decks) d.tbox = box(d);
    for (const a of decks) {
      const ta = a.P.slice();
      const mates = decks.filter((b) => b !== a && b.oneway && a.oneway && b.tbox[0] < a.tbox[2] + TWIN_DECK_GAP && b.tbox[2] > a.tbox[0] - TWIN_DECK_GAP && b.tbox[1] < a.tbox[3] + TWIN_DECK_GAP && b.tbox[3] > a.tbox[1] - TWIN_DECK_GAP);
      if (!mates.length) { target.set(a, ta); continue; }
      for (let i = 0; i < a.pts.length; i++) {
        const j = Math.min(i + 1, a.pts.length - 1), h = Math.max(i - 1, 0);
        const dx = a.pts[j][0] - a.pts[h][0], dz = a.pts[j][1] - a.pts[h][1], dl = Math.hypot(dx, dz) || 1;
        for (const b of mates) {
          const n = nearest(b, a.pts[i][0], a.pts[i][1]);
          if (n.d > TWIN_DECK_GAP || (dx / dl) * n.ux + (dz / dl) * n.uz > -0.6) continue;
          ta[i] = (a.P[i] + n.y) / 2; // the mean of both (symmetric, smooth); a max would kink where the two profiles cross
        }
      }
      target.set(a, ta);
    }
    for (const [a, ta] of target) a.P = ta;
  };

  // Node topology of a list, built once: densifying a way later keeps its original vertices.
  const topoCache = new Map();
  const ramps = (list, slope) => {
    if (!topoCache.has(list)) topoCache.set(list, topology(list));
    return rampsOn(list, slope, topoCache.get(list));
  };
  const topology = (list) => {
    const ends = new Map(), mids = new Set(), inner = new Map(), carEnds = new Set();
    const live = list.filter((w) => !w.tunnel);
    for (const w of live) if (w.cls) { carEnds.add(keyOf(w.pts[0])); carEnds.add(keyOf(w.pts[w.pts.length - 1])); }
    const endCount = new Map();
    for (const w of live) for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) endCount.set(keyOf(p), (endCount.get(keyOf(p)) || 0) + 1);
    for (const w of live) {
      for (const end of [0, 1]) {
        const k = keyOf(end ? w.pts[w.pts.length - 1] : w.pts[0]);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push({ w, end });
      }
      for (let i = 1; i < w.pts.length - 1; i++) {
        const k = keyOf(w.pts[i]);
        if (!inner.has(k)) inner.set(k, []);
        inner.get(k).push(w);
        if (!w.P && (w.cls || w.rail)) mids.add(k);
      }
    }
    // A ramp that simply ends (nothing else at its end node) comes down to the ground there.
    const dead = new Set([...endCount].filter(([k, c]) => c === 1 && !inner.has(k)).map(([k]) => k));
    return { ends, mids, inner, live, carEnds, dead };
  };
  const rampsOn = (list, slope, { ends, mids, inner, live, carEnds, dead }) => {
    const floorAt = (w, i) => (w.P ? w.P[i] : w.g[i]);
    for (const w of live) { w.cones = [null, null]; w.mid = []; w.ya = null; w.ys = null; w.crestEnds = null; }
    const best = new Map(), crest = new Map(), src = new Map(), queue = [];
    // `fo` (foot only): a footbridge's approach ramps stay on paths and never lift a street.
    const foot = new Map();
    const push = (k, h, c = null, from = null, fo = false) => {
      if (best.has(k) && best.get(k) >= h - 1e-3) return;
      best.set(k, h); queue.push(k); src.set(k, from); foot.set(k, fo);
      if (c) crest.set(k, c); else crest.delete(k);
    };
    // Deck ends: the ramp starts there; the crest curve needs the deck's outward grade.
    for (const w of live) {
      if (!w.P) continue;
      const n = w.pts.length;
      for (const end of [0, 1]) {
        const i = end ? n - 1 : 0, j = end ? n - 2 : 1;
        const gr = (w.P[i] - w.P[j]) / ((Math.abs(w.cum[i] - w.cum[j])) || 1);
        const k = keyOf(w.pts[i]);
        // A deck end that continues into another deck way is not a crest.
        const cont = (ends.get(k) || []).some((o) => o.w !== w && o.w.P);
        push(k, w.P[i], cont ? null : { deck: w, end, grade: gr }, null, !w.cls && !w.rail);
      }
    }
    let forced = 0, humps = 0;
    // A cone entering a way at an interior vertex: a rounded hump on that way, spreading to its ends.
    // Arc position (and index) on `w` nearest to node key k.
    const arcAt = (w, k) => {
      const [x, z] = k.split(',').map(Number);
      let bestD = Infinity, s0 = 0, i0 = 0, t0 = 0;
      for (let i = 0; i < w.pts.length - 1; i++) {
        const d = segDist(mkSeg(w.pts[i], w.pts[i + 1], {}), x, z);
        if (d < bestD) { bestD = d; i0 = i; t0 = segT; s0 = w.cum[i] + (w.cum[i + 1] - w.cum[i]) * segT; }
      }
      return { s0, i: i0, t: t0 };
    };
    const midPush = (host, k, h, from) => {
      const { s0 } = arcAt(host, k);
      if (host.mid.some((m) => Math.abs(m.s0 - s0) < 0.5 && m.h >= h - 1e-3)) return;
      host.mid.push({ s0, h, sl: slope });
      humps++;
      const n = host.pts.length, L = host.cum[n - 1];
      for (const end of [0, 1]) {
        const rem = h - slope * (end ? L - s0 : s0);
        const j = end ? n - 1 : 0;
        if (rem > floorAt(host, j) - SAG_K) push(keyOf(host.pts[j]), rem, null, host);
      }
    };
    const run = () => {
      while (queue.length) {
        const k = queue.pop(), h = best.get(k), cr = crest.get(k) || null;
        const from = src.get(k), here = ends.get(k) || [];
        // A footbridge that lands straight on a street end (no path to come down on) uses it.
        const fo = foot.get(k) && here.some((o) => !o.w.cls && o.w !== from && !(cr && cr.deck === o.w));
        for (const { w, end } of here) {
          if ((cr && cr.deck === w) || from === w || (fo && w.cls)) continue;
          const n = w.pts.length, near = end ? n - 1 : 0, far = end ? 0 : n - 1;
          // Decks only take a cone from something higher; ground ways also take one that lands just
          // short of them, so the sag curve continues across the node.
          if (h <= floorAt(w, near) + (w.P ? 0.05 : -SAG_K)) continue;
          const cur = w.cones[end];
          if (cur && cur.h >= h - 1e-3) continue;
          const farKey = keyOf(w.pts[far]);
          let sl = slope;
          // Steps come down over their own length (stairs-steep if need be), not at ramp grade:
          // the Herzl footbridge by HaTeder kept its flights level and lifted 130 u of footway.
          if (w.path === 'steps' && !w.P) sl = Math.min(MAX_FORCED_PATH, Math.max(slope, (h - w.g[far]) / (w.len || 1)));
          // A ramp landing on the middle of an at-grade road must touch down there.
          // If that needs more than MAX_FORCED, the road it lands on gets a local hump instead.
          // A footbridge approach that ends on the middle of another path touches down there too
          // (stairs-steep if it must); the end-attach pass below used to drag it down instead and
          // left a step at the deck.
          const soft = SOFT_LANDINGS.has(farKey);
          const pinned = !soft && (mids.has(farKey) || dead.has(farKey) || (fo && (carEnds.has(farKey) || inner.has(farKey)))) && !w.P;
          // A soft landing does not touch down, but a road crossing the node still rises to meet it.
          if (soft && !w.P) for (const host of inner.get(farKey) || []) if (host !== w && !host.P) midPush(host, farKey, h - w.len * slope, w);
          if (pinned && h - w.len * slope > w.g[far] - SAG_K) {
            const need = (h - w.g[far] + SAG_K) / w.len;
            const cap = w.rail ? slope * 1.4 : w.cls ? MAX_FORCED : MAX_FORCED_PATH;
            if (need <= cap) { sl = need; forced++; }
            else if (fo) { sl = cap; forced++; }
            else for (const host of inner.get(farKey) || []) if (host !== w && !host.P) midPush(host, farKey, h - w.len * slope, w);
          }
          w.cones[end] = { h, sl, crest: cr && cr.deck.P && h - floorAt(w, near) > 1.5 ? cr.grade : null };
          if (cr) { const d = cr.deck; d.crestEnds = d.crestEnds || [false, false]; d.crestEnds[cr.end] = d.crestEnds[cr.end] || h - floorAt(w, near) > 1.5; }
          const rem = h - w.len * sl;
          if (!pinned && rem > floorAt(w, far) - SAG_K) push(farKey, rem, null, w, fo);
        }
      }
    };
    const solve = () => {
      for (const w of live) {
        const c0 = w.cones[0], c1 = w.cones[1];
        if (!w.P && !c0 && !c1 && !w.mid.length) continue;
        if ((c0 || c1 || w.mid.length) && !w.dense) { reprofile(w, 5); w.dense = true; }
        const n = w.pts.length, L = w.cum[n - 1];
        const ya = new Array(n);
        for (let i = 0; i < n; i++) {
          const s = w.cum[i];
          let y = floorAt(w, i);
          // Crest curve over each deck end that a ramp leaves from.
          if (w.P && w.crestEnds) {
            if (w.crestEnds[0]) y = smin(y, w.P[0] + slope * s, CREST_K);
            if (w.crestEnds[1]) y = smin(y, w.P[n - 1] + slope * (L - s), CREST_K);
          }
          for (const [c, d] of [[c0, s], [c1, L - s]]) {
            if (!c) continue;
            let cy = c.h - c.sl * d;
            if (c.crest !== null) cy = smin(c.h + c.crest * d, cy, CREST_K);
            y = smax(y, cy, SAG_K);
          }
          for (const m of w.mid) {
            const d = Math.abs(s - m.s0);
            y = smax(y, m.h - m.sl * (Math.hypot(d, HUMP_R) - HUMP_R), SAG_K);
          }
          ya[i] = y;
        }
        w.ya = ya;
      }
      // Every end at a node meets the highest one there; the difference (vertical-curve rounding,
      // at most a few tenths) fades out along the lower way over NODE_FADE units. On a way shorter
      // than NODE_FADE, lifting one end lifts the other a little too and reopens the node already
      // matched there (0.54 u steps on the Komemiyut slip roads, round 7), so the pass repeats
      // until every node agrees; it only ever lifts, so it settles.
      for (let it = 0, moved = true; moved && it < 8; it++) {
        moved = false;
        for (const [k, list2] of ends) {
          let top = -Infinity;
          const at = list2.map(({ w, end }) => { const i = end ? w.pts.length - 1 : 0; const y = w.ya ? w.ya[i] : w.g[i]; top = Math.max(top, y); return y; });
          list2.forEach(({ w, end }, m) => {
            const d = top - at[m];
            if (d < 1e-3) return;
            if (d > 0.01) moved = true;
            if (!w.ya) w.ya = w.g.slice();
            const n = w.pts.length, L = w.cum[n - 1];
            for (let i = 0; i < n; i++) {
              const u = Math.min(1, (end ? L - w.cum[i] : w.cum[i]) / NODE_FADE);
              w.ya[i] += d * (1 - u * u * (3 - 2 * u));
            }
          });
        }
      }
      for (const w of live) {
        if (!w.ya) continue;
        w.ys = w.ya.map((y, i) => Math.max(0, y - w.g[i]));
        if (!w.ys.some((y) => y > 0.05)) { w.ya = null; w.ys = null; }
      }
    };
    run();
    solve();
    // Side streets whose end lands on the middle of a raised way ramp down from it.
    for (const [k, list2] of ends) {
      for (const host of inner.get(k) || []) {
        if (!host.ys || list2.every((o) => o.w === host)) continue;
        const { i, t } = arcAt(host, k);
        const ys = host.ys[i] + (host.ys[i + 1] - host.ys[i]) * t;
        if (ys < 0.3) continue;
        push(k, host.ya[i] + (host.ya[i + 1] - host.ya[i]) * t, null, host, !host.cls && !host.rail);
      }
    }
    run();
    solve();
    return { forced, humps };
  };
  // Decks, then ramps; then check clearance again against the final profiles (a ramp can pass
  // under a deck) and lift any structure that still comes short.
  let rampStats = null;
  for (let pass = 0; pass < 4; pass++) {
    setPlateaus();
    const a = ramps(ways, RAMP_SLOPE), b = ramps(rails, RAIL_SLOPE);
    rampStats = { forced: a.forced + b.forced, humps: a.humps + b.humps, passes: pass + 1 };
    let again = false;
    for (const grp of deckGroups) {
      if (!grp[0].level) continue;
      const d = deficit(grp);
      if (d > 0.05) { groupLift.set(grp, groupLift.get(grp) + d); again = true; }
    }
    if (!again) break;
  }
  // ---- ends that land on another carriageway between its nodes ----
  // OSM often joins a slip road or a parking ramp to a street without a shared node (or 5 cm off
  // it), so node reconciliation never sees the pair and the end hung up to 2 u above the street.
  // Such an end now takes the street's height there, faded back over ATTACH_FADE.
  {
    const sg = new SegGrid(25), endKeys = new Map();
    for (const w of all) {
      if (w.tunnel) continue;
      for (let i = 0; i < w.pts.length - 1; i++) sg.add(mkSeg(w.pts[i], w.pts[i + 1], { w, i }), w.hw2 || 2);
      for (const end of [0, 1]) {
        const k = keyOf(end ? w.pts[w.pts.length - 1] : w.pts[0]);
        if (!endKeys.has(k)) endKeys.set(k, []);
        endKeys.get(k).push(w);
      }
    }
    let attached = 0;
    const touched = new Set();
    // Per end node, so every way meeting there moves together and the node stays one height.
    for (const [k, list] of endKeys) {
      const first = list[0], i0 = first.pts.length - 1;
      const p = keyOf(first.pts[0]) === k ? first.pts[0] : first.pts[i0];
      const movable = list.filter((w) => !w.P);
      if (!movable.length || movable.length < list.length) continue;
      const yAt = (w) => { const i = keyOf(w.pts[0]) === k ? 0 : w.pts.length - 1; return w.ya ? w.ya[i] : w.g[i]; };
      const y = Math.max(...list.map(yAt));
      let best = null;
      for (const sgm of sg.at(p[0], p[1]) || []) {
        const h = sgm.w;
        if (list.includes(h) || !!h.rail !== !!first.rail) continue;
        const d = segDist(sgm, p[0], p[1]);
        if (d > Math.max(1.5, h.hw2 * 0.6)) continue;
        const hy = h.ya ? h.ya[sgm.i] + (h.ya[sgm.i + 1] - h.ya[sgm.i]) * segT : groundAt(p[0], p[1]);
        if (!best || d < best.d) best = { d, hy };
      }
      if (!best || SOFT_LANDINGS.has(k)) continue;
      for (const w of movable) {
        const diff = best.hy - yAt(w);
        const n = w.pts.length, end = keyOf(w.pts[0]) === k ? 0 : 1, L = w.cum[n - 1];
        // A long enough slip road climbs a little further at ramp grade: the Ayalon on-ramp that
        // lands on the descending Komemiyut deck west of the interchange ended 3.4 u under it.
        // Never as far as a deck over a street (DECK), which must stay a pass-under.
        const reach = w.cls ? Math.max(ATTACH_MAX, Math.min(ATTACH_MAX_RAMP, (L * 0.9 * RAMP_SLOPE) / 1.5)) : ATTACH_MAX;
        if (Math.abs(diff) < 0.05 || Math.abs(best.hy - y) > reach) continue;
        if (!w.ya) w.ya = w.g.slice();
        // A path never fades all the way to its far end: on a short footbridge approach that
        // moved the end joined to the deck and left a step there. A car way fades over enough
        // length to keep the climb near ramp grade (the smoothstep peaks at 1.5x its mean).
        const F = w.cls ? Math.min(Math.max(ATTACH_FADE, (1.5 * Math.abs(diff)) / RAMP_SLOPE), Math.max(ATTACH_FADE, L * 0.9)) : Math.min(ATTACH_FADE, L * 0.8);
        for (let j = 0; j < n; j++) {
          const u = Math.min(1, (end ? L - w.cum[j] : w.cum[j]) / F);
          w.ya[j] += diff * (1 - u * u * (3 - 2 * u));
        }
        touched.add(w);
        attached++;
      }
    }
    // Attaching moves a whole short way (ATTACH_FADE is longer than it), so the node at its other
    // end opened again (0.54-0.59 u steps on the Komemiyut slip roads, round 7): those nodes meet
    // the highest end once more, faded over NODE_FADE, until they agree.
    for (let it = 0, moved = touched.size > 0; moved && it < 8; it++) {
      moved = false;
      for (const [k, all2] of endKeys) {
        const list = all2.filter((w) => !w.rail);
        if (list.length < 2 || !list.some((w) => touched.has(w))) continue;
        const idx = (w) => (keyOf(w.pts[0]) === k ? 0 : w.pts.length - 1);
        const yEnd = (w) => (w.ya ? w.ya[idx(w)] : w.g[idx(w)]);
        const top = Math.max(...list.map(yEnd));
        for (const w of list) {
          const d = top - yEnd(w);
          if (d < 1e-3) continue;
          if (d > 0.01) moved = true;
          if (!w.ya) w.ya = w.g.slice();
          const n = w.pts.length, L = w.cum[n - 1], end = idx(w) ? 1 : 0;
          for (let j = 0; j < n; j++) {
            const u = Math.min(1, (end ? L - w.cum[j] : w.cum[j]) / NODE_FADE);
            w.ya[j] += d * (1 - u * u * (3 - 2 * u));
          }
          touched.add(w);
        }
      }
    }
    for (const w of touched) {
      w.ys = w.ya.map((y, i) => Math.max(0, y - w.g[i]));
      if (!w.ys.some((y) => y > 0.05)) { w.ya = null; w.ys = null; }
    }
    if (rampStats) rampStats.attached = attached;
  }
  for (const k of NODE_MEETS) {
    const hit = [];
    for (const w of all) {
      if (w.tunnel || !w.cls) continue;
      // Nearest vertex within 2.5 u: OSM does not always share the node (a link crossing a deck end).
      const [kx, kz] = k.split(',').map(Number);
      let i = -1, bd = 2.5;
      w.pts.forEach((p, m) => { const d = Math.hypot(p[0] - kx, p[1] - kz); if (d < bd) { bd = d; i = m; } });
      if (i >= 0) hit.push({ w, i, y: w.ya ? w.ya[i] : w.g[i] });
    }
    const top = Math.max(...hit.map((h) => h.y));
    for (const { w, i, y } of hit) {
      const d = top - y;
      if (d < 0.01) continue;
      if (!w.ya) w.ya = w.g.slice();
      for (let j = 0; j < w.pts.length; j++) {
        const u = Math.min(1, Math.abs(w.cum[j] - w.cum[i]) / NODE_FADE);
        w.ya[j] += d * (1 - u * u * (3 - 2 * u));
      }
      w.ys = w.ya.map((v, m) => Math.max(0, v - w.g[m]));
      if (!w.ys.some((v) => v > 0.05)) { w.ya = null; w.ys = null; }
    }
  }
  const yOf = (w, i) => (w.ys ? w.ys[i] : 0);
  const isUp = (w) => !!w.ys && w.ys.some((y) => y > 0.05);

  const cars = ways.filter((w) => w.cls && !w.tunnel);
  lap('dual carriageways');
  // ---- dual carriageways: find the opposite-direction twin of each one-way road ----
  // Highways are paired by road number first (Ayalon North and South are two names for route 20,
  // Route 1 changes name between its carriageways); unnamed secondary one-ways pair with their
  // opposite number. Round 8 9.4.
  const twinKey = (w) => (w.rank >= 8 && w.ref ? 'ref:' + w.ref : w.name || w.ref || (w.rank >= 8 ? w.hw : w.rank >= 6 ? 'hw:' + w.hw : ''));
  // Residential one-way pairs are twins too (Rothschild / Kikar HaMeyasdim by the Great Synagogue:
  // two 2-lane one-ways 9-15 u apart drew overlapping carriageways with kerbed sidewalks down the
  // middle), but only when close: same-named back streets 40-80 u apart are separate streets.
  const TWIN_RANK = 3, twinReach = (rank) => (rank >= 4 ? 80 : 24);
  let owGrid;
  const buildOwGrid = () => {
    owGrid = new SegGrid(40);
    for (const w of cars) {
      if (w.oneway && !w.roundabout && w.tkey && w.rank >= TWIN_RANK) for (let i = 0; i < w.pts.length - 1; i++) owGrid.add(mkSeg(w.pts[i], w.pts[i + 1], { ri: w.idx, tkey: w.tkey, hw: w.hw2 }), 80);
    }
  };
  for (const w of cars) w.tkey = twinKey(w);
  buildOwGrid();
  function twinAt(w, x, z, dx, dz, side) {
    const list = owGrid.at(x, z);
    if (!list) return null;
    let best = null;
    for (const s of list) {
      if (s.ri === w.idx || s.tkey !== w.tkey || dx * s.ux + dz * s.uz > -0.75) continue;
      const d = segDist(s, x, z);
      if (d > twinReach(w.rank)) continue;
      const qx = s.ax + s.ux * s.len * segT, qz = s.az + s.uz * s.len * segT;
      if (Math.sign((qx - x) * -dz + (qz - z) * dx) !== side) continue;
      if (!best || d < best.d) best = { d, hw: s.hw, ri: s.ri };
    }
    return best;
  }
  for (const w of cars) {
    w.twinSide = 0;
    if (!w.oneway || w.roundabout || !w.tkey || w.rank < TWIN_RANK) continue;
    let n = 0, l = 0, r = 0;
    const probe = (x, z, dx, dz) => { n++; if (twinAt(w, x, z, dx, dz, -1)) l++; if (twinAt(w, x, z, dx, dz, 1)) r++; };
    for (const [x, z, dx, dz] of along(w.pts, 12, 6)) probe(x, z, dx, dz);
    if (!n) {
      const p = w.pts[0], q = w.pts[w.pts.length - 1], L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      probe((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (q[0] - p[0]) / L, (q[1] - p[1]) / L);
    }
    if (Math.max(l, r) >= 0.4 * n) w.twinSide = l >= r ? -1 : 1;
  }

  // ---- squeeze twin carriageways apart (round 8 9.4) ----
  // The roads are drawn 1.4x wider than OSM spaces them, so most dual carriageways overlap or touch
  // and no planted median fits between them (gap measured -2 to -7 u on Herzl, Route 4, Jabotinsky).
  // Where trimming at most 22% off each carriageway's half width leaves a 2.5 u strip, trim it; the
  // centre lines (and so every car path) stay exactly where OSM has them.
  {
    const MIN_GAP = 2.5, MAX_TRIM = 0.22;
    const trim = new Map();
    for (const w of cars) {
      if (!w.twinSide || w.elevated || w.layer > 0 || w.rank < 4) continue;
      const gaps = [];
      for (const [x, z, dx, dz] of along(w.pts, 10, 5)) {
        const tw = twinAt(w, x, z, dx, dz, w.twinSide);
        if (tw) gaps.push(tw.d - tw.hw - w.hw2);
      }
      if (gaps.length < 2) continue;
      gaps.sort((p, q) => p - q);
      const need = MIN_GAP - gaps[Math.floor(gaps.length * 0.25)];
      if (need > 0 && need / 2 <= MAX_TRIM * w.hw2) trim.set(w, need / 2);
    }
    for (const [w, t] of trim) { w.hw2 -= t; w.w = w.hw2 * 2; }
    if (trim.size) buildOwGrid(); // the median section reads the trimmed half widths from it
  }

  lap('spatial indexes');
  // ---- spatial indexes ----
  const cgrid = new SegGrid(25);
  for (const w of cars) for (let i = 0; i < w.pts.length - 1; i++) cgrid.add(mkSeg(w.pts[i], w.pts[i + 1], { ri: w.idx, i, hw: w.hw2, rank: w.rank, h0: yOf(w, i), h1: yOf(w, i + 1) }), w.hw2 + 9);
  const railGrid = new SegGrid(25);
  rails.forEach((r, ri) => { if (!r.tunnel) for (let i = 0; i < r.pts.length - 1; i++) railGrid.add(mkSeg(r.pts[i], r.pts[i + 1], { ri, h0: yOf(r, i), h1: yOf(r, i + 1) }), FENCE_OFF + 2); });

  // Is (x, z) on another road's carriageway at about height h? Roads running within ~30 degrees of
  // `dir` are ignored, so a street's own continuation never cuts its sidewalk or lines.
  function inCarriage(x, z, self, h, dx, dz, minRank, margin, tol = 2.5) {
    const list = cgrid.at(x, z);
    if (!list) return false;
    for (const s of list) {
      if (s.ri === self || s.rank < minRank) continue;
      if ((dx || dz) && Math.abs(dx * s.ux + dz * s.uz) > 0.87) continue;
      const d = segDist(s, x, z);
      if (d > s.hw + margin) continue;
      if (Math.abs(s.h0 + (s.h1 - s.h0) * segT - h) > tol) continue;
      return true;
    }
    return false;
  }
  // 1 + index of a carriageway (other than `self`) whose lanes cover (x, z) at about height h, or 0.
  function carriageAt(x, z, self, h, tol) {
    const list = cgrid.at(x, z);
    if (!list) return 0;
    for (const s of list) {
      if (s.ri === self || s.rank < 1) continue;
      if (segDist(s, x, z) > s.hw) continue;
      if (Math.abs(s.h0 + (s.h1 - s.h0) * segT - h) > tol) continue;
      return s.ri + 1;
    }
    return 0;
  }
  // Is (x, z) on a footway, path, steps or cycleway (other than `self`)? Pillars keep off them:
  // they stood on footbridge approaches under the decks at Moshe Dayan and elsewhere.
  const pgrid = new SegGrid(25);
  for (const w of ways) if (!w.cls && !w.tunnel) for (let i = 0; i < w.pts.length - 1; i++) pgrid.add(mkSeg(w.pts[i], w.pts[i + 1], { w }), w.hw2 + 3);
  function onPath(x, z, self) {
    for (const s of pgrid.at(x, z) || []) if (s.w !== self && segDist(s, x, z) <= s.w.hw2 + 1.6) return true;
    return false;
  }
  function inRail(x, z, h, reach, skip = -1) {
    const list = railGrid.at(x, z);
    if (!list) return false;
    for (const s of list) {
      if (s.ri === skip) continue;
      const d = segDist(s, x, z);
      if (d < reach && Math.abs(s.h0 + (s.h1 - s.h0) * segT - h) < 2.5) return true;
    }
    return false;
  }

  // Roundabouts: the island is on the side of the ring's curvature centre.
  for (const w of cars) {
    if (!w.roundabout) continue;
    const [cx, cz] = centroid(w.pts);
    const m = Math.max(0, Math.min(w.pts.length - 2, Math.floor((w.pts.length - 1) / 2)));
    const a = w.pts[m], b = w.pts[m + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    w.innerSide = Math.sign((cx - a[0]) * -dz + (cz - a[1]) * dx) || 1;
  }

  lap('junctions');
  // ---- junctions: shared endpoints and endpoints landing on another road ----
  const jmap = new Map();
  const addArm = (x, z, arm) => {
    const k = `${Math.round(x * 2)},${Math.round(z * 2)}`;
    let j = jmap.get(k);
    if (!j) { j = { x, z, arms: [] }; jmap.set(k, j); }
    if (!j.arms.some((o) => o.w === arm.w && o.dir === arm.dir && o.seg === arm.seg)) j.arms.push(arm);
  };
  for (const w of cars) {
    if (w.rank < 2) continue;
    const n = w.pts.length;
    if (yOf(w, 0) < 0.3) addArm(w.pts[0][0], w.pts[0][1], { w, seg: 0, t: 0, dir: 1 });
    if (yOf(w, n - 1) < 0.3) addArm(w.pts[n - 1][0], w.pts[n - 1][1], { w, seg: n - 2, t: 1, dir: -1 });
  }
  for (const j of jmap.values()) {
    const list = cgrid.at(j.x, j.z);
    if (!list) continue;
    for (const s of list) {
      if (s.rank < 2 || j.arms.some((a) => a.w.idx === s.ri)) continue;
      if (segDist(s, j.x, j.z) > 1.0 || Math.abs(s.h0 + (s.h1 - s.h0) * segT) > 0.3) continue;
      const w = ways[s.ri];
      j.arms.push({ w, seg: s.i, t: segT, dir: 1 }, { w, seg: s.i, t: segT, dir: -1 });
    }
  }
  const junctions = [...jmap.values()].filter((j) => j.arms.length >= 3);
  const jgrid = new SegGrid(50);
  for (const j of junctions) {
    j.maxHw = Math.max(...j.arms.map((a) => a.w.hw2));
    j.r = j.maxHw + SW * 0.5 + 7;
    jgrid.add(mkSeg([j.x, j.z], [j.x + 1e-3, j.z], { j }), j.r);
  }
  // Inside the painted-out zone of a junction where another road of at least minRank meets.
  function nearJunction(x, z, self, minRank) {
    const list = jgrid.at(x, z);
    if (!list) return false;
    for (const { j } of list) {
      if (Math.hypot(x - j.x, z - j.z) > j.r) continue;
      if (j.arms.some((a) => a.w.idx !== self && a.w.rank >= minRank)) return true;
    }
    return false;
  }

  // Walk `dist` along a way from (seg, t) in direction dir; null if the way ends first.
  function walkFrom(pts, seg, t, dir, dist) {
    let i = seg, x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
    let left = dist;
    while (i >= 0 && i < pts.length - 1) {
      const tx = dir > 0 ? pts[i + 1][0] : pts[i][0], tz = dir > 0 ? pts[i + 1][1] : pts[i][1];
      const d = Math.hypot(tx - x, tz - z);
      if (d >= left && d > 1e-6) { const k = left / d; return { x: x + (tx - x) * k, z: z + (tz - z) * k, dx: (tx - x) / d, dz: (tz - z) / d, i }; }
      left -= d; x = tx; z = tz; i += dir;
    }
    return null;
  }

  const roads = [];
  const sidewalks = [];
  const medians = [];
  const crossings = [];
  const hgrid = new SegGrid(20);
  // Walkable raised surfaces for heightAt, in absolute heights (ya), skipping parts at grade.
  // The lift (asphalt or ballast thickness) fades in over the first 2 u of rise, so stepping from
  // the ground (heightAt = terrain) onto a ramp foot is not a 0.2 u hop.
  let deckId = 0;
  // `prio`: a stair flight wins over the platform or deck it stands on whenever both are in reach.
  const prioDecks = new Set();
  const addDeck = (pts, ys, ya, lift, hw, prio = false) => {
    const id = deckId++;
    if (prio) prioDecks.add(id);
    const top = (i) => ya[i] + lift * Math.min(1, ys[i] / 2);
    for (let i = 0; i < pts.length - 1; i++) {
      if (ys[i] <= 0.05 && ys[i + 1] <= 0.05) continue;
      hgrid.add(mkSeg(pts[i], pts[i + 1], { h0: top(i), h1: top(i + 1), hw, id }), hw + 1);
    }
  };

  const concrete = C(PALETTE.concrete), underside = C(PALETTE.underside), parapetTop = C(PALETTE.parapetTop), pillarC = C(PALETTE.pillar);
  const swTopC = C(PALETTE.sidewalk), kerbSideC = C(PALETTE.kerb), barrierC2 = C(PALETTE.barrier);
  const parapetGaps = []; // { x, z, r }: stair tops on a deck edge
  const slotFilled = []; // { x, z, r }: slot between twin decks decked over by the owner way
  const filledAt = (x, z) => slotFilled.some((f) => Math.hypot(x - f.x, z - f.z) < f.r);
  // The two decks of the Moshe Dayan crossing are drawn by src/world/bridge_moshe_dayan.js; their
  // walkable surface and road data stay with this file.
  const mdBridge = createMosheDayanBridge();
  // Deck, walls, parapets and pillars under every raised part of a way.
  function structure(w, hwDeck, lift, parapets = true) {
    if (!isUp(w)) return;
    const modelled = mdBridge.claims(w);
    if (modelled) mdBridge.add(w, lift);
    const pts = w.pts, ys = w.ys, n = pts.length, N = vnormals(pts);
    let i = 0;
    while (i < n - 1) {
      const off = (k) => Math.max(ys[k], ys[k + 1]) <= 0.05 || (w.overCar && w.overCar[k]);
      if (off(i)) { i++; continue; }
      let j = i;
      while (j < n - 1 && !off(j)) j++;
      const rp = pts.slice(i, j + 1), ry = ys.slice(i, j + 1), ra = w.ya.slice(i, j + 1), rg = w.g.slice(i, j + 1), RN = N.slice(i, j + 1);
      const top = ra.map((y) => y + lift);
      // Urban bridges carry a kerbed sidewalk outside each outer lane (deckWalk: extra width per
      // side); the deck, its walls and parapets move out to make room.
      const xs = w.deckWalk || [0, 0], hA = hwDeck + xs[0], hB = hwDeck + xs[1], hs = (s) => (s < 0 ? hA : hB);
      // A deck stands free once it is high enough; below that the ramp is a walled embankment.
      // Over water a low deck is a slab too (an embankment would dam the stream and hide it).
      const wet = (k) => w.water && ctx.waterTop && ctx.waterTop(rp[k][0], rp[k][1]) !== null;
      const bot = ry.map((y, k) => (y >= DECK * 0.7 ? ra[k] + lift - SLAB : (y > 0.9 && wet(k)) || (w.arch && y > 0.3) ? ra[k] + lift - 0.7 : rg[k] - 0.3));
      // Where this way's edge lies on another carriageway at about the same level (a raised
      // junction, a slip road joining) it has no side wall and no parapet: they used to run
      // straight across the other road.
      // Parallel ways count too: a dual carriageway mapped closer than our widened lanes overlaps.
      const open = [-1, 1].map((s) => rp.map((p, k) => {
        const x = p[0] + RN[k][0] * s * (hs(s) - 0.25), z = p[1] + RN[k][1] * s * (hs(s) - 0.25);
        return inCarriage(x, z, w.idx ?? -1, ry[k], 0, 0, 1, 0.3);
      }));
      // Parallel decks a few units apart (a carriageway and its collector road, twin halves over
      // the 412 at HaRishonim) read as separate bridges with a slot of sky and two parapets in
      // between. Where another raised carriageway at about this height lies within JOIN_GAP of
      // the edge, the slot is decked over with one New Jersey barrier down its middle, like one
      // wide structure; the way with the lower index draws it. Free-standing decks only.
      const join = [-1, 1].map((s) => rp.map((p, k) => {
        if (w.rail || ry[k] < DECK * 0.7) return 0;
        for (let o = hs(s) + 0.4; o <= hs(s) + JOIN_GAP; o += 0.6) {
          const x = p[0] + RN[k][0] * s * o, z = p[1] + RN[k][1] * s * o;
          const hit = carriageAt(x, z, w.idx ?? -1, ry[k], 0.7);
          if (hit) return { gap: o - hs(s), owner: (w.idx ?? -1) < hit - 1 };
        }
        return 0;
      }));
      absolute(modelled ? () => {} : () => {
        const shut = (o) => (k) => !o[k] && !o[k + 1];
        const both = (m) => (k) => !!join[m][k] && !!join[m][k + 1];
        // Segments whose slot this way decks over (it is the lower-indexed of the pair).
        const ownSeg = [[], []];
        for (const [m, s] of [[0, -1], [1, 1]]) {
          const jn = join[m];
          if (!jn.some((j) => j && j.owner)) continue;
          // One owner end is enough: the owner flag follows whichever carriageway is hit first, and
          // an end that hit a slip road instead left the slot half decked over and walkers dropped in.
          const own = (k) => both(m)(k) && (jn[k].owner || jn[k + 1].owner) && shut(open[m])(k);
          const a = rp.map((_, k) => s * (hs(s) - 0.3)), b = rp.map((_, k) => s * (hs(s) + (jn[k] ? jn[k].gap : 0) + 0.3));
          const mid = rp.map((_, k) => s * (hs(s) + (jn[k] ? jn[k].gap / 2 : 0)));
          const lo = (arr1, arr2) => arr1.map((v, k) => Math.min(v, arr2[k])), hi = (arr1, arr2) => arr1.map((v, k) => Math.max(v, arr2[k]));
          slab(layers.solid, rp, top.map((y) => y - SLAB), lo(a, b), hi(a, b), top.map((y) => y - 0.01), concrete, null, { N: RN, under: underside, caps: false, segIf: own });
          slab(layers.solid, rp, top, mid.map((v) => v - 0.35), mid.map((v) => v + 0.35), top.map((y) => y + 1.0), barrierC2, barrierC2, { N: RN, caps: false, segIf: own });
          for (let k = 0; k < rp.length - 1; k++) {
            if (!own(k)) continue;
            ownSeg[m][k] = true;
            // The decked-over slot is walkable up to the barrier (it was only the lanes, so a walker
            // stepping off one deck's asphalt edge fell through the gap between the decks).
            const q0 = ep(rp, RN, k, mid[k], 0), q1 = ep(rp, RN, k + 1, mid[k + 1], 0);
            addDeck([[q0[0], q0[2]], [q1[0], q1[2]]], [ry[k], ry[k + 1]], [ra[k], ra[k + 1]], lift, (Math.abs(b[k] - a[k]) + Math.abs(b[k + 1] - a[k + 1])) / 4 + 0.5); // overlaps both decks: a 0.1 sliver between them dropped a walker
            slotFilled.push({ x: (q0[0] + q1[0]) / 2, z: (q0[2] + q1[2]) / 2, r: Math.hypot(q1[0] - q0[0], q1[2] - q0[2]) / 2 + 2.5 });
            const pa = ep(rp, RN, k, mid[k] - 0.35, 0), pb = ep(rp, RN, k + 1, mid[k + 1] - 0.35, 0), pc = ep(rp, RN, k + 1, mid[k + 1] + 0.35, 0), pd = ep(rp, RN, k, mid[k] + 0.35, 0);
            colliders.push({ kind: 'wall', height: 1.0, y0: Math.min(top[k], top[k + 1]) - 0.6, y1: Math.max(top[k], top[k + 1]) + 1.0, points: [[pa[0], pa[2]], [pb[0], pb[2]], [pc[0], pc[2]], [pd[0], pd[2]]] });
          }
        }
        slab(layers.solid, rp, bot, -hA, hB, top, null, null, { N: RN, under: underside, caps: false });
        slab(layers.solid, rp, bot, -hA, hB, top, null, concrete, { N: RN, caps: false, sideB: false, segIf: shut(open[0]) });
        slab(layers.solid, rp, bot, -hA, hB, top, null, concrete, { N: RN, caps: false, sideA: false, segIf: shut(open[1]) });
        // Stairs down to a station platform leave a gap in the parapet.
        const gap = (k, s) => {
          const x = rp[k][0] + RN[k][0] * s * hs(s), z = rp[k][1] + RN[k][1] * s * hs(s);
          return !parapetGaps.some((g) => Math.hypot(x - g.x, z - g.z) < g.r);
        };
        if (parapets) {
          [-1, 1].forEach((s, m) => {
            // A segment is cut when a stair top lies on it (the old test looked at the two ends
            // only, so a stair in the middle of a 12 u segment had a parapet across it).
            const hasCut = (k) => {
              const A = ep(rp, RN, k, s * hs(s), 0), B = ep(rp, RN, k + 1, s * hs(s), 0), L2 = (B[0] - A[0]) ** 2 + (B[2] - A[2]) ** 2 || 1;
              return parapetGaps.some((g) => {
                const t = Math.max(0, Math.min(1, ((g.x - A[0]) * (B[0] - A[0]) + (g.z - A[2]) * (B[2] - A[2])) / L2));
                return Math.hypot(A[0] + (B[0] - A[0]) * t - g.x, A[2] + (B[2] - A[2]) * t - g.z) < 3.5;
              });
            };
            // An edge facing a twin deck is bare only where the owner decked the slot over; anywhere
            // else it keeps its parapet (the old test dropped it wherever a twin was near, owner or not).
            const edgeShut = (k) => {
              if (!shut(open[m])(k)) return false;
              if (!both(m)(k)) return true;
              if (ownSeg[m][k]) return false;
              const A = ep(rp, RN, k, s * hs(s), 0), B = ep(rp, RN, k + 1, s * hs(s), 0);
              return !filledAt((A[0] + B[0]) / 2, (A[2] + B[2]) / 2);
            };
            const drawn = (k) => edgeShut(k) && gap(k, s) && gap(k + 1, s) && !hasCut(k);
            slab(layers.solid, rp, top, s * (hs(s) - 0.5), s * hs(s), top.map((y) => y + 1.1), parapetTop, concrete, { N: RN, caps: false, segIf: drawn });
            // The parapet is solid for walkers on a free-standing deck: it used to be only drawn,
            // so anyone walking at the edge of the Moshe Dayan bridge dropped 11 u to the road.
            // Tall (jump-proof) and only for movers at deck height, so nothing below is blocked.
            const wallPiece = (k, t0, t1) => {
              const lerpY = (t) => top[k] + (top[k + 1] - top[k]) * t;
              const P0 = (o, t) => { const u = ep(rp, RN, k, o, 0), v = ep(rp, RN, k + 1, o, 0); return [u[0] + (v[0] - u[0]) * t, u[2] + (v[2] - u[2]) * t]; };
              const a = P0(s * (hs(s) - 0.5), t0), b = P0(s * (hs(s) - 0.5), t1), b2 = P0(s * hs(s), t1), a2 = P0(s * hs(s), t0);
              colliders.push({ kind: 'wall', height: 2.2, y0: Math.min(lerpY(t0), lerpY(t1)) - 0.6, y1: Math.max(lerpY(t0), lerpY(t1)) + 2.2, points: [a, b, b2, a2] });
            };
            for (let k = 0; k < rp.length - 1; k++) {
              if ((ry[k] + ry[k + 1]) / 2 < DECK * 0.7) continue;
              if (drawn(k)) { wallPiece(k, 0, 1); continue; }
              if (!edgeShut(k)) continue;
              // A segment cut for a stair top: the stair is 3.7 wide but the cut is a whole
              // segment (up to 12 u), so walkers dropped off the deck beside the stair. The rest
              // of the segment gets its parapet back, and is solid.
              const A = ep(rp, RN, k, s * hs(s), 0), B = ep(rp, RN, k + 1, s * hs(s), 0), L = Math.hypot(B[0] - A[0], B[2] - A[2]) || 1;
              const cuts = [];
              for (const g of parapetGaps) {
                const t = ((g.x - A[0]) * (B[0] - A[0]) + (g.z - A[2]) * (B[2] - A[2])) / (L * L);
                const dx = A[0] + (B[0] - A[0]) * Math.max(0, Math.min(1, t)) - g.x, dz = A[2] + (B[2] - A[2]) * Math.max(0, Math.min(1, t)) - g.z;
                if (Math.hypot(dx, dz) > 3.5) continue;
                const hw = (STAIR_W / 2 + 0.3) / L;
                cuts.push([Math.max(0, t - hw), Math.min(1, t + hw)]);
              }
              cuts.sort((p, q) => p[0] - q[0]);
              let at = 0;
              const keep = [];
              for (const [c0, c1] of cuts) { if (c0 > at) keep.push([at, c0]); at = Math.max(at, c1); }
              if (at < 1) keep.push([at, 1]);
              for (const [t0, t1] of keep) {
                if ((t1 - t0) * L < 0.3) continue;
                wallPiece(k, t0, t1);
                const yA = top[k] + (top[k + 1] - top[k]) * t0, yB = top[k] + (top[k + 1] - top[k]) * t1;
                const q0 = ep(rp, RN, k, 0, 0), q1 = ep(rp, RN, k + 1, 0, 0);
                const pt = (t) => [q0[0] + (q1[0] - q0[0]) * t, q0[2] + (q1[2] - q0[2]) * t];
                slab(layers.solid, [pt(t0), pt(t1)], [yA, yB], s * (hs(s) - 0.5), s * hs(s), [yA + 1.1, yB + 1.1], parapetTop, concrete, { N: [RN[k], RN[k + 1]], caps: false });
              }
            }
          });
        }
        // Deck sidewalks: kerbed slab from the lane edge to the parapet, walkable at kerb height.
        [-1, 1].forEach((s, m) => {
          if (!xs[m]) return;
          const a = s * (w.hw2 + 0.3), b = s * (hs(s) - 0.5);
          // Not where a slip road joins or runs alongside at deck level (its lanes are there).
          slab(layers.solid, rp, top, a, b, top.map((y) => y + DECK_KERB), swTopC, kerbSideC, { N: RN, caps: false, segIf: (k) => !open[m][k] && !open[m][k + 1] });
        });
        // Pillars: one under narrow decks, two under wide ones, never on a road or track below.
        const wk = walker(rp, ry), wa = walker(rp, ra);
        for (let s = 13; s < wk.L - 6; s += 26) {
          const p = wk.at(s);
          if (p.y < DECK * 0.7) continue;
          const deckBottom = wa.at(s).y + lift - SLAB, rot = Math.atan2(-p.dz, p.dx);
          for (const o of hwDeck > 10 ? [-hwDeck * 0.55, hwDeck * 0.55] : [0]) {
            const x = p.x - p.dz * o, z = p.z + p.dx * o;
            // Not on any road below the deck, ramps included (they used to get a pillar in the lane).
            if (inCarriage(x, z, w.idx ?? -1, 0, 0, 0, 1, 1.8, p.y - 1.5) || inRail(x, z, 0, BALLAST_HW + 1.5) || onPath(x, z, w)) continue;
            // Nor where a slip road runs at deck level beside or into this deck: the pillar top
            // stood a few tenths under its lanes and stopped cars dead on the Komemiyut ramp.
            if (inCarriage(x, z, w.idx ?? -1, p.y, 0, 0, 1, 1.8, 3)) continue;
            const y0 = groundAt(x, z) - 0.3;
            if (deckBottom - y0 < 1) continue;
            box(layers.solid, x, y0, z, 2.4, deckBottom - y0, 2.4, rot, pillarC, pillarC);
            colliders.push({ kind: 'pillar', height: deckBottom - y0, y0, y1: deckBottom, points: rectCollider(x, z, 2.4, 2.4, rot) });
          }
        }
      });
      // Embankment walls block walkers at ground level from crossing a ramp sideways. No collider
      // where any other carriageway (at any height) runs under the wall line: OSM puts slip roads
      // closer to an embankment than our widened lanes, and cars on them got stuck on it.
      // Outside the parapet line, so a car (radius 2.8) still fits a narrow ramp; narrow
      // service ramps get a little more room.
      const wos = (s) => hs(s) + (w.hw2 < 5 ? 0.8 : 0);
      const openC = [-1, 1].map((s, m) => rp.map((p, k) => open[m][k] || inCarriage(p[0] + RN[k][0] * s * (wos(s) + 0.2), p[1] + RN[k][1] * s * (wos(s) + 0.2), w.idx ?? -1, 0, 0, 0, 1, 0.3, 1e9)));
      for (let k = 0; k < rp.length - 1; k++) {
        const ym = (ry[k] + ry[k + 1]) / 2;
        if (ym < 1.5 || ym >= DECK * 0.7) continue;
        for (const s of [-1, 1]) {
          const o = openC[s < 0 ? 0 : 1];
          if (o[k] || o[k + 1]) continue; // a road joins or runs alongside: no wall to drive into
          const wo = wos(s);
          const a = ep(rp, RN, k, s * (wo + 0.4), 0), b = ep(rp, RN, k + 1, s * (wo + 0.4), 0);
          const a2 = ep(rp, RN, k, s * wo, 0), b2 = ep(rp, RN, k + 1, s * wo, 0);
          colliders.push({ kind: 'wall', height: ym, y0: Math.min(rg[k], rg[k + 1]) - 0.3, y1: Math.max(ra[k], ra[k + 1]) + lift + 1.1, points: [[a[0], a[2]], [b[0], b[2]], [b2[0], b2[2]], [a2[0], a2[2]]] });
        }
      }
      // Walkable only over the drawn surface (narrow ramps keep the parapet margin, or a car,
      // wider than half the lane, drops off the edge on a bend).
      addDeck(rp, ry, ra, lift, w.hw2 < 5 ? hwDeck : Math.min(hwDeck, w.hw2 + 0.1));
      [-1, 1].forEach((s, m) => {
        if (!xs[m]) return;
        const a = w.hw2 + 0.3, b = hs(s) - 0.5, line = offsetLine(rp, s * (a + b) / 2, RN);
        for (let k0 = 0; k0 < rp.length - 1;) {
          if (open[m][k0] || open[m][k0 + 1]) { k0++; continue; }
          let k1 = k0 + 1;
          while (k1 < rp.length - 1 && !open[m][k1 + 1]) k1++;
          addDeck(line.slice(k0, k1 + 1), ry.slice(k0, k1 + 1), ra.slice(k0, k1 + 1), lift + DECK_KERB, (b - a) / 2 + 0.3);
          k0 = k1;
        }
      });
      i = j;
    }
  }

  lap('deck sidewalks and stations');
  // ---- sidewalks on urban bridges ----
  // OSM maps them as separate footways beside the carriageway; at our widened lanes those lie
  // inside the asphalt and are not drawn, so every urban bridge (not motorways or slip roads)
  // carries its own kerbed sidewalk on both outer sides, never towards its twin carriageway.
  for (const w of cars) {
    if (!w.ys || !w.ys.some((y) => y > 3) || !w.cls.urban || w.cls.link || w.rank < 3 || w.roundabout) continue;
    w.deckWalk = [-1, 1].map((s) => (s !== w.twinSide ? SW : 0));
  }
  // Top of a car deck (its sidewalk where there is one) at (x, z), before the decks are indexed.
  const deckTopAt = (x, z) => {
    let best = null;
    for (const sg of cgrid.at(x, z) || []) {
      const w = ways[sg.ri];
      if (!w.ys) continue;
      const d = segDist(sg, x, z), xw = w.deckWalk ? Math.max(...w.deckWalk) : 0;
      if (d > w.hw2 + 0.5 + xw) continue;
      const y = w.ya[sg.i] + (w.ya[sg.i + 1] - w.ya[sg.i]) * segT + roadY(w.rank) + (d > w.hw2 + 0.3 && xw ? DECK_KERB : 0);
      if (best === null || y > best) best = y;
    }
    return best;
  };
  // ---- station platforms and the stairs down to them ----
  // Island platforms (OSM railway=platform, four-sided) stand PLAT_H above the ground on their
  // centre line and are walkable. Wherever a road bridge crosses a platform, a flight of stairs
  // leaves the bridge sidewalk at each outer edge and runs down the platform's centre line.
  const stations = [], stationStairs = [], platformHandled = new Set();
  const stairC = C(PALETTE.concrete, 0.96), treadC = C(PALETTE.parapetTop), edgeC = C(PALETTE.lineYellow);
  // One straight flight: `edge` is where the descent starts (with a 1.5 u landing behind it),
  // `d` the unit direction of descent; it falls from topY to botY over `run`. Solid stepped
  // treads with low side walls; walkable (wins over the platform or deck it stands on) and solid
  // from below (each collider piece is open to a walker already on its steps).
  function flight(edge, d, topY, botY, run, W = STAIR_W) {
    const [ex, ez] = edge, [dx, dz] = d, rise = topY - botY;
    const P = (sv) => [ex + dx * sv, ez + dz * sv];
    const at = (p) => { const t = Math.max(0, Math.min(1, ((p[0] - ex) * dx + (p[1] - ez) * dz) / run)); return topY - rise * t; };
    const pts = densify([P(-1.5), P(0), P(run)], 1), ya = pts.map(at);
    addDeck(pts, pts.map((p, k) => Math.max(0.1, ya[k] - groundAt(p[0], p[1]))), ya, 0, W / 2, true);
    const n = Math.max(2, Math.ceil(rise / 0.5)), dep = run / n, rot = Math.atan2(-dz, dx);
    absolute(() => {
      for (let k = 0; k < n; k++) {
        const [x, z] = P((k + 0.5) * dep), y = topY - (k + 0.5) * (rise / n);
        box(layers.solid, x, botY - 0.2, z, dep + 0.02, Math.max(0.1, y - botY + 0.2), W, rot, treadC, stairC);
      }
      const fl = densify([P(0), P(run)], 2), FN = vnormals(fl), fy = fl.map(at);
      for (const sd of [-1, 1]) slab(layers.solid, fl, botY - 0.2, sd * W / 2, sd * (W / 2 + 0.35), fy.map((y) => y + 1.0), parapetTop, concrete, { N: FN });
    });
    // A walker's circle reaches a piece before its feet do: pieces open 1.4 below their lowest step.
    for (let q = 0; q < 6; q++) {
      const low = topY - rise * ((q + 1) / 6);
      if (low - botY < 2.2) continue;
      const pa = P(run * (q / 6)), pb = P(run * ((q + 1) / 6)), nx = -dz * (W / 2 + 0.35), nz = dx * (W / 2 + 0.35);
      colliders.push({ kind: 'wall', height: low - botY, y0: botY - 0.5, y1: low - 1.0, points: [[pa[0] + nx, pa[1] + nz], [pb[0] + nx, pb[1] + nz], [pb[0] - nx, pb[1] - nz], [pa[0] - nx, pa[1] - nz]] });
    }
  }
  platforms.forEach((ring4, pi) => {
    if (ring4.length !== 4) return;
    const e = [0, 1, 2, 3].map((k) => Math.hypot(ring4[(k + 1) % 4][0] - ring4[k][0], ring4[(k + 1) % 4][1] - ring4[k][1]));
    const k0 = e[0] + e[2] < e[1] + e[3] ? 0 : 1; // edges k0 and k0 + 2 are the short ends
    const mid = (k) => [(ring4[k][0] + ring4[(k + 1) % 4][0]) / 2, (ring4[k][1] + ring4[(k + 1) % 4][1]) / 2];
    const A = mid(k0), B = mid(k0 + 2), hw = (e[k0] + e[k0 + 2]) / 4;
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (L < 20 || hw < 1.5) return;
    const ux = (B[0] - A[0]) / L, uz = (B[1] - A[1]) / L;
    const axis = densify([A, B], 6), g = axis.map((p) => groundAt(p[0], p[1])), cum = cumulative(axis);
    const gw = walker(axis, g), topAtS = (sv) => gw.at(Math.max(0, Math.min(L, sv))).y + PLAT_H;
    // Station: the nearest OSM railway station, as a slug of its local part ("... - Moshe Dayan").
    let station = `platform_${pi}`, sd = 400;
    for (const [kind, nameEn, , ax, az] of data.amenities || []) {
      if (kind !== 'station' || !nameEn) continue;
      const d = Math.hypot(ax - (A[0] + B[0]) / 2, az - (A[1] + B[1]) / 2);
      if (d < sd) { sd = d; station = nameEn.split(' - ').pop().trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'); }
    }
    const plat = { axis, A, ux, uz, L, hw, g, topAtS, station };
    stations.push(plat);
    platformHandled.add(pi);
    // Bridge spans over the platform, from its centre line.
    const spans = [];
    let cur = null;
    for (let sv = 0; sv <= L; sv += 1) {
      const x = A[0] + ux * sv, z = A[1] + uz * sv, d = deckTopAt(x, z);
      const over = d !== null && d - topAtS(sv) > 4;
      if (over && !cur) cur = { s0: sv, s1: sv };
      else if (over) cur.s1 = sv;
      else if (cur) { spans.push(cur); cur = null; }
    }
    if (cur) spans.push(cur);
    for (const sp of spans) for (const dir of [-1, 1]) {
      const edge = dir < 0 ? sp.s0 : sp.s1, sTop = edge - dir * 1.5;
      const tx = A[0] + ux * sTop, tz = A[1] + uz * sTop, topY = deckTopAt(tx, tz);
      if (topY === null) continue;
      const rise = topY - topAtS(edge), run = rise / STAIR_GRADE_STEEP, sBot = edge + dir * run;
      if (sBot < 2 || sBot > L - 2 || spans.some((o) => o !== sp && sBot > o.s0 - 2 && sBot < o.s1 + 2)) continue;
      const P = (sv) => [A[0] + ux * sv, A[1] + uz * sv];
      const botY = topAtS(sBot);
      flight(P(edge), [ux * dir, uz * dir], topY, botY, run);
      parapetGaps.push({ x: P(edge)[0], z: P(edge)[1], r: STAIR_W / 2 + 1.5 });
      stationStairs.push({ station, platform: pi, top: [+P(sTop)[0].toFixed(2), +topY.toFixed(2), +P(sTop)[1].toFixed(2)], edge: [+P(edge)[0].toFixed(2), +topY.toFixed(2), +P(edge)[1].toFixed(2)], bottom: [+P(sBot)[0].toFixed(2), +botY.toFixed(2), +P(sBot)[1].toFixed(2)], width: STAIR_W, dir: [ux * dir, uz * dir] });
    }
    // Platform slab with a yellow safety line along both edges; walkable on its centre line.
    absolute(() => {
      const N = vnormals(axis), top = g.map((y) => y + PLAT_H);
      slab(layers.solid, axis, g.map((y) => y - 0.3), -hw, hw, top, C(PALETTE.platform), C(PALETTE.platformSide), { N });
      for (const sd of [-1, 1]) strip(layers.marks, axis, top.map((y) => y + 0.02), sd * (hw - 0.9), sd * (hw - 0.55), edgeC, N);
    });
    addDeck(axis, axis.map(() => 2), g, PLAT_H, hw);
  });
  // ---- side platforms at stations OSM maps without platform polygons (HaRishonim) ----
  // Two side platforms outside the pair of station tracks, from the buffer stops along the
  // tracks, as wide as the gap to the carriageway beside them allows (up to U(6)); top 1.2 above
  // the rail heads. A flight at the buffer end of each one drops to the ground concourse under
  // the raised motorway (OSM steps ways 700786932/700786933 at the west end, Commons photo 03).
  const platformC = C(PALETTE.platform), platformSideC = C(PALETTE.platformSide), railingC = C(PALETTE.fence);
  const sidePlatforms = [];
  for (const st of bareStations) {
    const trk = rails.filter((r) => r.station && r.ya && r.pts.some((p) => Math.hypot(p[0] - st.x, p[1] - st.z) < 160));
    if (trk.length !== 2) continue;
    // Buffer ends: the end of each track nearest the station; the axis runs from their midpoint.
    const ends = trk.map((r) => {
      const a = r.pts[0], b = r.pts[r.pts.length - 1];
      return Math.hypot(a[0] - st.x, a[1] - st.z) < Math.hypot(b[0] - st.x, b[1] - st.z) ? { p: a, q: r.pts[Math.min(3, r.pts.length - 1)] } : { p: b, q: r.pts[Math.max(0, r.pts.length - 4)] };
    });
    let ux = 0, uz = 0;
    for (const e of ends) { const l = Math.hypot(e.q[0] - e.p[0], e.q[1] - e.p[1]) || 1; ux += (e.q[0] - e.p[0]) / l; uz += (e.q[1] - e.p[1]) / l; }
    const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    const nx = -uz, nz = ux;
    // Start at the buffer that sits further along the axis, so both tracks run the whole platform.
    const s0 = Math.max(...ends.map((e) => e.p[0] * ux + e.p[1] * uz));
    const M = [(ends[0].p[0] + ends[1].p[0]) / 2, (ends[0].p[1] + ends[1].p[1]) / 2];
    const m0 = M[0] * ux + M[1] * uz;
    const O = [M[0] + ux * (s0 - m0), M[1] + uz * (s0 - m0)];
    const Lt = Math.min(...trk.map((r) => r.len));
    const sA = 4, sB = Math.min(Lt - 30, sA + U(250));
    if (sB - sA < 60) continue;
    const axis = densify([[O[0] + ux * sA, O[1] + uz * sA], [O[0] + ux * sB, O[1] + uz * sB]], 6);
    const side = trk.map((r) => { const d = (r.pts[Math.floor(r.pts.length / 2)][0] - O[0]) * nx + (r.pts[Math.floor(r.pts.length / 2)][1] - O[1]) * nz; return { r, d }; });
    for (const sg of [-1, 1]) {
      const t = side.find((o) => Math.sign(o.d) === sg);
      if (!t) continue;
      const inner = Math.abs(t.d) + U(1.6);
      // Outer edge: the nearest carriageway (at any height) seen across the gap, less a margin.
      const outer = axis.map(([x, z]) => {
        for (let o = inner + 1; o <= inner + U(6); o += 0.5) if (inCarriage(x + nx * sg * o, z + nz * sg * o, -1, 0, 0, 0, 1, 0.6, 1e9)) return o - 0.5;
        return inner + U(6);
      });
      // Constant width (the narrowest stretch), never under 3 u.
      const ow = Math.max(inner + 3, Math.min(...outer)), mid = (inner + ow) / 2, hw = (ow - inner) / 2;
      const line = axis.map(([x, z]) => [x + nx * sg * mid, z + nz * sg * mid]);
      const top = axis.map(([x, z]) => lerpAt(t.r, t.r.ya, x, z) + BALLAST_H + 1.2);
      const g = line.map((p) => groundAt(p[0], p[1]));
      const N = vnormals(line), L = polylineLength(line), cum = cumulative(line);
      const lw = walker(cum.map((c) => [c, 0]), top);
      // `line` runs along +u, so its normal is (nx, nz): the track edge lies at -sg * hw from it.
      const a = -hw, b = hw, trackEdge = -sg * hw;
      absolute(() => {
        slab(layers.solid, line, top.map((y) => y - 1.4), a, b, top, platformC, platformSideC, { N, under: underside });
        // Yellow safety line along the track edge, railing along the outer edge.
        const e0 = trackEdge + sg * 0.35, e1 = trackEdge + sg * 0.7;
        strip(layers.marks, line, top.map((y) => y + 0.02), Math.min(e0, e1), Math.max(e0, e1), edgeC, N);
        const r0 = -trackEdge - sg * 0.15, r1 = -trackEdge;
        slab(layers.solid, line, top, Math.min(r0, r1), Math.max(r0, r1), top.map((y) => y + 1.1), railingC, railingC, { N, caps: false });
        // Piers under the outer half, every 24 u.
        for (let sv = 8; sv < L - 4; sv += 24) {
          const p = lw.at(sv), k = Math.min(line.length - 1, Math.round(sv / 6));
          const ox = line[k][0] - N[k][0] * trackEdge * 0.4, oz = line[k][1] - N[k][1] * trackEdge * 0.4;
          const y0 = groundAt(ox, oz) - 0.3;
          if (p.y - 1.4 - y0 > 1) box(layers.solid, ox, y0, oz, 1.8, p.y - 1.4 - y0, 1.8, Math.atan2(-uz, ux), pillarC, pillarC);
        }
      });
      // Railing collider (a band at platform height only, so nothing at ground level is blocked).
      for (let k = 0; k < line.length - 1; k++) {
        const pa = ep(line, N, k, -trackEdge, 0), pb = ep(line, N, k + 1, -trackEdge, 0), pc = ep(line, N, k + 1, -trackEdge + sg * 0.4, 0), pd = ep(line, N, k, -trackEdge + sg * 0.4, 0);
        colliders.push({ kind: 'wall', height: 1.1, y0: Math.min(top[k], top[k + 1]) - 0.3, y1: Math.max(top[k], top[k + 1]) + 1.1, points: [[pa[0], pa[2]], [pb[0], pb[2]], [pc[0], pc[2]], [pd[0], pd[2]]] });
      }
      addDeck(line, top.map((y, k) => Math.max(2, y - g[k])), top, 0, hw);
      const station = (st.nameEn || 'station').split(' - ').pop().trim().replace(/^Rishon LeTsiyyon\s*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const A = line[0];
      const plat = { axis: line, A, ux, uz, L, hw, g, topAtS: (sv) => lw.at(Math.max(0, Math.min(L, sv))).y, station, side: sg };
      stations.push(plat);
      sidePlatforms.push({ station, side: sg > 0 ? 'right' : 'left', axis: line.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]), top: top.map((y) => +y.toFixed(2)), width: 2 * hw });
      // Flight from the buffer end of the platform down to the concourse, continuing its axis.
      const W = Math.min(STAIR_W, 2 * hw - 0.4), topY = top[0];
      let run = (topY - groundAt(A[0] - ux * 10, A[1] - uz * 10)) / STAIR_GRADE_STEEP;
      for (let it = 0; it < 3; it++) run = (topY - groundAt(A[0] - ux * run, A[1] - uz * run)) / STAIR_GRADE_STEEP;
      const B = [A[0] - ux * run, A[1] - uz * run], botY = groundAt(B[0], B[1]);
      if (topY - botY > 1) {
        flight(A, [-ux, -uz], topY, botY, run, W);
        stationStairs.push({ station, platform: `side-${sg > 0 ? 'right' : 'left'}`, top: [+A[0].toFixed(2), +topY.toFixed(2), +A[1].toFixed(2)], edge: [+A[0].toFixed(2), +topY.toFixed(2), +A[1].toFixed(2)], bottom: [+B[0].toFixed(2), +botY.toFixed(2), +B[1].toFixed(2)], width: W, dir: [-ux, -uz] });
      }
    }
  }
  const platformAt = (x, z) => {
    for (const p of stations) {
      const sv = (x - p.A[0]) * p.ux + (z - p.A[1]) * p.uz, lat = Math.abs(-(x - p.A[0]) * p.uz + (z - p.A[1]) * p.ux);
      if (sv >= 0 && sv <= p.L && lat <= p.hw) return p.topAtS(sv);
    }
    return null;
  };

  lap('carriageways and paths');
  // ---- carriageways and paths ----
  // Raised footways and cycleways mapped beside a bridge's carriageway lie inside our widened
  // lanes, half a unit above or below them: those pieces are not drawn or walked on (cars and
  // walkers hopped onto them), the carriageway carries them.
  for (const w of ways) {
    if (w.cls || !w.ys) continue;
    w.overCar = w.pts.slice(0, -1).map((p, i) => {
      const q = w.pts[i + 1], x = (p[0] + q[0]) / 2, z = (p[1] + q[1]) / 2;
      // Only a raised carriageway carries a footway: a low footbridge ramp over a car park
      // aisle at grade (the Neot Ashlim water park spiral) used to vanish there and drop walkers.
      // Within 1 u in height: a footbridge clearly above or below a ramp beside it is its own deck.
      const h = (w.ys[i] + w.ys[i + 1]) / 2, k = carriageAt(x, z, w.idx, h, 1.0);
      if (!k) return false;
      const sgm = (cgrid.at(x, z) || []).find((sg) => sg.ri === k - 1 && segDist(sg, x, z) <= sg.hw);
      return !!sgm && sgm.h0 + (sgm.h1 - sgm.h0) * segT > 1;
    });
  }
  for (const w of ways) {
    const entry = { kind: w.kind, width: w.w, name: w.name, points: w.pts };
    if (w.nameEn) entry.nameEn = w.nameEn;
    if (w.bridgeTag || w.level) entry.bridge = true;
    if (w.tunnel) entry.tunnel = true;
    if (w.layer) entry.layer = w.layer;
    if (w.arch) entry.arch = true;
    if (w.water) entry.overWater = true;
    if (w.ys) entry.heights = w.ys;
    // Absolute drawn surface heights of raised ways (debug and the seam audit, tools/audit_seams.js).
    if (w.ys) {
      // Low parts of a raised way bank with the hillside like the street they grow out of (the
      // at-grade strip drapes each edge on the ground), and level out as the ramp rises: a flat
      // ramp foot used to dig its uphill edge into the slope and twist against the street.
      const N0 = vnormals(w.pts), lift = w.cls ? roadY(w.rank) : Y.path;
      w.edge = [-1, 1].map((sd) => w.pts.map((p, i) => {
        const f = Math.max(0, 1 - w.ys[i] / BANK_FADE);
        if (f <= 0) return w.ya[i] + lift;
        const e = groundAt(p[0] + N0[i][0] * sd * w.hw2, p[1] + N0[i][1] * sd * w.hw2);
        return w.ya[i] + lift + (e - w.g[i]) * f;
      }));
      entry.surface = w.ya.map((h) => h + lift);
      entry.edges = w.edge;
    }
    if (w.cls) { entry.lanes = w.lanes; entry.oneway = w.oneway; entry.rank = w.rank; if (w.roundabout) entry.roundabout = true; }
    roads.push(entry);
    if (w.tunnel) continue; // tunnels stay hidden under the flat ground
    const N = vnormals(w.pts);
    if (w.cls) {
      const y = roadY(w.rank);
      if (w.ys) absolute(() => strip(layers.asphalt, w.pts, w.edge[0], -w.hw2, w.hw2, C(w.cls.color), N, null, w.edge[1]));
      else strip(layers.asphalt, w.pts, y, -w.hw2, w.hw2, C(w.cls.color), N);
      structure(w, w.hw2 + 0.5, y);
    } else {
      const y = Y.path + (w.path === 'promenade' ? 0.01 : 0);
      if (w.ys) absolute(() => strip(layers.paths, w.pts, w.edge[0].map((h, i) => h + (w.ys[i] > 0.05 ? 0.1 : 0)), -w.hw2, w.hw2, C(PATH[w.path][1]), N, w.overCar ? (i) => !w.overCar[i] : null, w.edge[1].map((h, i) => h + (w.ys[i] > 0.05 ? 0.1 : 0))));
      else strip(layers.paths, w.pts, y, -w.hw2, w.hw2, C(PATH[w.path][1]), N);
      structure(w, w.hw2 + 0.5, y + 0.1);
    }
    // Low bridges over streams and parks: no deck, just parapets either side.
    if (w.bridgeTag && !w.level && !isUp(w)) {
      const y = w.cls ? roadY(w.rank) : Y.path;
      for (const s of [-1, 1]) slab(layers.solid, w.pts, y, s * (w.hw2 + 0.1), s * (w.hw2 + 0.6), y + 1.1, parapetTop, concrete, { N });
    }
  }
  // The modelled Moshe Dayan bridge: needs both decks and the stair gaps, so it comes last.
  if (mdBridge.complete) {
    absolute(() => {
      prof.mosheDayanBridge = mdBridge.emit({
        at: (x, z) => layers.solid.at(x, z), groundAt, colliders, gaps: parapetGaps, stairW: STAIR_W,
        // Anything a pier or an abutment must keep off: ground-level roads, rails, paths, platforms.
        blocked: (x, z, m) => inCarriage(x, z, -1, 0, 0, 0, 1, m + 1.0, 4) || inRail(x, z, 0, BALLAST_HW + m + 1) || platformAt(x, z) != null
          || (pgrid.at(x, z) || []).some((s) => !(s.w.ys && Math.min(...s.w.ys) > 4) && segDist(s, x, z) <= s.w.hw2 + 1.6 + m),
      });
    });
  }

  lap('lane markings');
  // ---- lane markings ----
  const markW = 0.32;
  function lineSet(w) {
    const c = w.cls;
    if (!c || (w.rank < 4 && !c.link && (w.oneway || w.rank < 3))) return []; // one-way residential streets and smaller ways stay unpainted
    const out = [], n = w.lanes;
    const dash = w.rank >= 8 || w.hw === 'motorway_link' ? [5, 8] : [3, 4.5];
    if (w.oneway) {
      for (let k = 1; k < n; k++) out.push({ off: -(n * LANE) / 2 + k * LANE, dash, color: WHITE });
      if (!c.urban || c.link) {
        const e = Math.min(w.hw2 - 0.5, (n * LANE) / 2 + 0.4);
        out.push({ off: e, color: WHITE }, { off: -e, color: w.rank >= 8 ? YELLOW : WHITE });
      }
    } else {
      const m = w.median / 2, per = Math.max(1, Math.floor(n / 2));
      if (m > 0) out.push({ off: m + 0.4, color: WHITE }, { off: -(m + 0.4), color: WHITE });
      else if (w.rank >= 6 || w.rank === 3) out.push({ off: 0.3, color: WHITE }, { off: -0.3, color: WHITE });
      else out.push({ off: 0, dash: [3, 4.5], color: WHITE });
      for (let k = 1; k < per; k++) out.push({ off: m + k * LANE, dash, color: WHITE }, { off: -(m + k * LANE), dash, color: WHITE });
    }
    return out;
  }
  for (const w of cars) {
    const lines = lineSet(w);
    if (!lines.length) continue;
    const N = vnormals(w.pts), lift = roadY(w.rank) + MARK_LIFT, minRank = Math.max(3, w.rank - 1);
    const ok = (p) => !inCarriage(p.x, p.z, w.idx, p.y, p.dx, p.dz, minRank, 0.3) && !nearJunction(p.x, p.z, w.idx, minRank);
    // Raised ways paint in absolute heights; the predicate still tests the height above ground.
    ABS = !!w.ys;
    for (const ln of lines) {
      const op = offsetLine(w.pts, ln.off, N);
      const wk = walker(op, w.ys || 0), wa = w.ys ? walker(op, w.ya) : null;
      if (ln.dash) {
        const [len, gap] = ln.dash;
        for (let s = gap / 2; s + len <= wk.L; s += len + gap) {
          const a = wk.at(s), b = wk.at(s + len), m = wk.at(s + len / 2);
          if (!ok(m)) continue;
          const ya = wa ? wa.at(s).y : a.y, yb = wa ? wa.at(s + len).y : b.y;
          const nx = (-m.dz * markW) / 2, nz = (m.dx * markW) / 2;
          layers.marks.at(m.x, m.z).quad([a.x + nx, ya + lift, a.z + nz], [b.x + nx, yb + lift, b.z + nz], [b.x - nx, yb + lift, b.z - nz], [a.x - nx, ya + lift, a.z - nz], ln.color, UP);
        }
      } else {
        let run = [];
        const flush = () => {
          if (run.length >= 2) strip(layers.marks, run.map((p) => [p.x, p.z]), run.map((p) => p.ya + lift), -markW / 2, markW / 2, ln.color);
          run = [];
        };
        for (let s = 0; s <= wk.L + 2.9; s += 3) {
          const sc = Math.min(s, wk.L), p = wk.at(sc);
          p.ya = wa ? wa.at(sc).y : p.y;
          if (ok(p)) run.push(p); else flush();
        }
        flush();
      }
    }
    ABS = false;
  }

  lap('living streets and street signs');
  // ---- shared streets (OSM living_street: Neve Yam's gem and sea streets) ----
  // Paved kerb-to-kerb with no sidewalks, they were a tan strip on tan ground and the founder
  // could not read the neighbourhood (round 4 and 5). Now: grey pavers (RC colour), a light
  // edge band on both sides, and at every mouth onto a bigger street a red paver gateway band
  // with give-way triangles, so the hierarchy reads collector -> residential -> shared street.
  const edgeBandC = C(0xd9d6d0), gateC = C(0xb4553f);
  for (const w of cars) {
    if (w.hw !== 'living_street' || isUp(w)) continue;
    const N = vnormals(w.pts), y = roadY(w.rank) + MARK_LIFT;
    for (const s of [-1, 1]) strip(layers.marks, w.pts, y, s < 0 ? -w.hw2 : w.hw2 - 0.7, s < 0 ? -w.hw2 + 0.7 : w.hw2, edgeBandC, N);
  }
  for (const j of junctions) {
    const big = j.arms.filter((a) => a.w.rank >= 3);
    if (!big.length) continue;
    for (const arm of j.arms) {
      const w = arm.w;
      if (w.hw !== 'living_street' || isUp(w)) continue;
      const dc = Math.max(...big.map((a) => a.w.hw2)) + SW + 2.2;
      const at = walkFrom(w.pts, arm.seg, arm.t, arm.dir, dc);
      if (!at) continue;
      const y = roadY(w.rank) + MARK_LIFT + 0.004, nx = -at.dz, nz = at.dx, hl = 1.6, hw = w.hw2;
      const P = (a, l) => [at.x + nx * a + at.dx * l, y, at.z + nz * a + at.dz * l];
      layers.marks.at(at.x, at.z).quad(P(-hw, -hl), P(-hw, hl), P(hw, hl), P(hw, -hl), gateC, UP);
      // Give-way triangles on the junction side of the band, pointing at the bigger street.
      const n = Math.max(2, Math.floor((2 * hw - 0.6) / 1.4));
      for (let k = 0; k < n; k++) {
        const c = -hw + 0.3 + (k + 0.5) * ((2 * hw - 0.6) / n);
        layers.marks.at(at.x, at.z).tri(P(c + 0.5, -hl - 0.3), P(c, -hl - 1.5), P(c - 0.5, -hl - 0.3), WHITE, UP);
      }
    }
  }
  // ---- street-name signs ----
  // A municipal name sign at each corner where a named street leaves a junction, on its right
  // side and facing along it, showing the OSM local name (and the English one small). Whole city:
  // every ground-level named street from living_street up to primary/trunk, except motorways and
  // names that are only a road number ("431").
  const streetSigns = [];
  {
    const placed = new Map();
    const nearPlaced = (x, z) => {
      const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
      for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) {
        for (const p of placed.get((cx + i) + ',' + (cz + k)) || []) if (Math.hypot(p[0] - x, p[1] - z) < 8) return true;
      }
      return false;
    };
    for (const j of junctions) {
      const seen = new Set();
      for (const arm of j.arms) {
        const w = arm.w;
        if (!w.name || w.rank < 2 || w.rank > 8 || /^[\d\s-]+$/.test(w.name) || isUp(w) || seen.has(w.name)) continue;
        const others = j.arms.filter((a) => a.w.name !== w.name);
        if (!others.length) continue;
        seen.add(w.name);
        const dc = Math.max(...others.map((a) => a.w.hw2)) + 3;
        const at = walkFrom(w.pts, arm.seg, arm.t, arm.dir, dc);
        if (!at) continue;
        // Right-hand corner as seen walking out of the junction along the arm.
        const off = w.hw2 + (w.rank >= 3 ? SW * 0.7 : 1.6);
        const x = at.x - at.dz * off, z = at.z + at.dx * off;
        if (inBuilding(x, z) || inCarriage(x, z, w.idx, 0, 0, 0, 1, 0.8) || nearPlaced(x, z)) continue;
        const pk = Math.floor(x / 16) + ',' + Math.floor(z / 16);
        if (!placed.has(pk)) placed.set(pk, []);
        placed.get(pk).push([x, z]);
        streetSigns.push({ x, z, rot: Math.atan2(-at.dz, at.dx), name: w.name, nameEn: w.nameEn || '' });
      }
    }
  }

  lap('crosswalks');
  // ---- crosswalks: zebras across each urban arm, just outside the crossing road ----
  const ZL = U(3), ZW = U(0.5);
  // Zebras used to pile up where junction nodes sit close together (dual carriageways, offset
  // T-junctions, short arms between two junctions): each arm of each node painted its own. Now
  // a zebra whose footprint overlaps one already painted is dropped (oriented-box test), and
  // stripes that would land on another carriageway are left out, so a zebra spans its own road.
  const zebras = [];
  const obbHit = (a, b) => {
    for (const [ax, az] of [[a.ux, a.uz], [-a.uz, a.ux], [b.ux, b.uz], [-b.uz, b.ux]]) {
      const pr = (r) => Math.abs(r.ux * ax + r.uz * az) * r.hl + Math.abs(-r.uz * ax + r.ux * az) * r.hw;
      if (Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) > pr(a) + pr(b)) return false;
    }
    return true;
  };
  for (const j of junctions) {
    for (const arm of j.arms) {
      const w = arm.w;
      if (!w.cls || !w.cls.urban || w.rank < 3 || w.roundabout || isUp(w)) continue;
      const others = j.arms.filter((a) => a.w !== w);
      if (!others.length) continue;
      const dc = Math.max(...others.map((a) => a.w.hw2)) + SW * 0.5 + ZL / 2 + 1;
      const at = walkFrom(w.pts, arm.seg, arm.t, arm.dir, dc);
      if (!at || inCarriage(at.x, at.z, w.idx, 0, at.dx, at.dz, 2, -0.5)) continue;
      const box = { x: at.x, z: at.z, ux: at.dx, uz: at.dz, hl: ZL / 2 + 1.2, hw: w.w / 2 };
      if (zebras.some((o) => obbHit(o, box))) continue;
      zebras.push(box);
      const n = Math.max(2, Math.floor((w.w - 0.8) / (2 * ZW)));
      const y = roadY(w.rank) + MARK_LIFT + 0.004;
      const nx = -at.dz, nz = at.dx;
      for (let k = 0; k < n; k++) {
        const o = -((n - 1) * 2 * ZW) / 2 + k * 2 * ZW;
        const cx = at.x + nx * o, cz = at.z + nz * o;
        if (inCarriage(cx, cz, w.idx, 0, at.dx, at.dz, 2, -0.3)) continue;
        const hx = (at.dx * ZL) / 2, hz = (at.dz * ZL) / 2, wx = (nx * ZW) / 2, wz = (nz * ZW) / 2;
        layers.marks.at(cx, cz).quad([cx - hx - wx, y, cz - hz - wz], [cx + hx - wx, y, cz + hz - wz], [cx + hx + wx, y, cz + hz + wz], [cx - hx + wx, y, cz - hz + wz], WHITE, UP);
      }
      crossings.push({ x: at.x, z: at.z, angle: Math.atan2(at.dx, at.dz), width: w.w });
    }
  }

  lap('sidewalks');
  // ---- sidewalks ----
  const swTop = C(PALETTE.sidewalk), swSide = C(PALETTE.sidewalkSide), kerbC = C(PALETTE.kerb), kerbRed = C(PALETTE.kerbRed), kerbWhite = C(PALETTE.kerbWhite);
  const hasMapped = (w, side) => {
    // Does an OSM-mapped sidewalk run beside this road on that side?
    for (const [x, z, dx, dz] of along(w.pts, Math.max(8, w.len / 3), Math.min(4, w.len / 2))) {
      const list = mappedSidewalks.at(x, z);
      if (!list) continue;
      for (const s of list) {
        const d = segDist(s, x, z);
        if (d > 40 || Math.abs(dx * s.ux + dz * s.uz) < 0.7) continue;
        const qx = s.ax + s.ux * s.len * segT, qz = s.az + s.uz * s.len * segT;
        if (Math.sign((qx - x) * -dz + (qz - z) * dx) === side) return true;
      }
    }
    return false;
  };
  function sidewalkSides(w) {
    if (!w.cls || !w.cls.urban || w.cls.link || w.rank < 3 || w.tunnel) return [];
    const t = w.sidewalkTag;
    let sides = [-1, 1];
    if (t === 'left') sides = [-1];
    else if (t === 'right') sides = [1];
    else if (t === 'no') sides = [-1, 1].filter((s) => hasMapped(w, s));
    if (w.twinSide) sides = sides.filter((s) => s !== w.twinSide);
    if (w.roundabout) sides = sides.filter((s) => s !== w.innerSide);
    return sides;
  }
  const kerbStripes = (pts, s, fromEnd) => {
    // Red-and-white kerb (no stopping) for the last stretch before a junction, Israeli style.
    const p = fromEnd ? [...pts].reverse() : pts;
    const wk = walker(p), len = Math.min(16, wk.L), seg = 1.6;
    const sg = fromEnd ? s : -s; // road side, measured in the walked direction
    for (let d = 0, k = 0; d < len; d += seg, k++) {
      const a = wk.at(d), b = wk.at(Math.min(len, d + seg));
      const c = k % 2 ? kerbWhite : kerbRed;
      const o0 = SW / 2 - 0.7, o1 = SW / 2 + 0.02;
      const nx = -a.dz * sg, nz = a.dx * sg;
      const y = SIDE_TOP + 0.012;
      layers.solid.at(a.x, a.z).quad([a.x + nx * o0, y, a.z + nz * o0], [b.x + nx * o0, y, b.z + nz * o0], [b.x + nx * o1, y, b.z + nz * o1], [a.x + nx * o1, y, a.z + nz * o1], c, UP);
    }
  };
  for (const w of cars) {
    const sides = sidewalkSides(w);
    if (!sides.length) continue;
    const N = vnormals(w.pts);
    for (const s of sides) {
      const op = offsetLine(w.pts, s * (w.hw2 + SW / 2), N);
      // Sample the offset line; keep points that are on the ground, off every other carriageway,
      // track and building. A run ends either at a road (junction) or at an obstacle.
      const runs = [];
      let run = null, lastReason = 'start';
      for (let i = 0; i < op.length - 1; i++) {
        const a = op[i], b = op[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(L / 3));
        const bdx = w.pts[i + 1][0] - w.pts[i][0], bdz = w.pts[i + 1][1] - w.pts[i][1], bl = Math.hypot(bdx, bdz) || 1;
        for (let k = 0; k <= steps; k++) {
          if (k === steps && i < op.length - 2) continue;
          const t = k / steps, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
          const h = yOf(w, i) + (yOf(w, i + 1) - yOf(w, i)) * t;
          let reason = null;
          if (h > 0.3) reason = 'deck';
          else if (inCarriage(x, z, w.idx, 0, bdx / bl, bdz / bl, 2, SW * 0.5 - 0.2)) reason = 'road';
          else if (inRail(x, z, 0, BALLAST_HW + 1.5)) reason = 'road';
          else if (inBuilding(x, z)) reason = 'building';
          if (reason) {
            if (run) { run.end = reason; runs.push(run); run = null; }
            lastReason = reason;
          } else {
            if (!run) run = { pts: [], start: lastReason };
            run.pts.push([x, z]);
          }
        }
      }
      if (run) { run.end = 'end'; runs.push(run); }
      for (const r of runs) {
        let pts = simplify(r.pts, 0.25);
        if (pts.length < 2 || polylineLength(pts) < 3) continue;
        if (ctx.terrain) pts = densify(pts, 12);
        const RN = vnormals(pts);
        slab(layers.solid, pts, Y.road, -SW / 2, SW / 2, SIDE_TOP, swTop, swSide, { N: RN });
        // Kerb stone band on the road edge of the strip.
        strip(layers.solid, pts, SIDE_TOP + 0.006, -s * (SW / 2 - 0.7), -s * (SW / 2 + 0.01), kerbC, RN);
        if (r.start === 'road') kerbStripes(pts, s, false);
        if (r.end === 'road') kerbStripes(pts, s, true);
        sidewalks.push({ points: pts, roadKind: w.kind, side: s > 0 ? 'right' : 'left', roadName: w.name, width: SW });
      }
    }
  }

  lap('medians');
  // ---- medians: planted strips between dual carriageways and down two-way boulevards ----
  const grassC = C(PALETTE.median), dryC = C(PALETTE.medianDry), hedgeC = C(PALETTE.hedge), barrierC = C(PALETTE.barrier);
  const medianRun = (pts, a, b, urban, barrier) => {
    if (pts.length < 2 || polylineLength(pts) < 4) return;
    const N = vnormals(pts);
    const top = urban ? SIDE_TOP : Y.road + 0.12;
    const mid = a.map((v, i) => (v + b[i]) / 2);
    slab(layers.solid, pts, Y.road, a, b, top, urban ? grassC : dryC, kerbC, { N });
    if (barrier) {
      slab(layers.solid, pts, top, mid.map((m) => m - 0.35), mid.map((m) => m + 0.35), top + 1.1, barrierC, barrierC, { N });
    } else if (urban) {
      // Low clipped hedge down the middle of wide medians.
      const ok = a.map((v, i) => Math.abs(b[i] - v) > 3.5);
      slab(layers.solid, pts, top, mid.map((m) => m - 0.8), mid.map((m) => m + 0.8), top + 0.9, hedgeC, hedgeC, { N, segIf: (i) => ok[i] && ok[i + 1] });
    }
    medians.push({ points: offsetLine(pts, mid, N), width: Math.min(...a.map((v, i) => Math.abs(b[i] - v))) });
  };
  for (const w of cars) {
    const urban = !!w.cls.urban;
    if (w.twinSide) {
      const s = w.twinSide;
      let pts = [], A = [], B = [];
      const flush = () => { if (pts.length >= 2) medianRun(pts, A, B, urban, !urban); pts = []; A = []; B = []; };
      for (const [x, z, dx, dz, i, t] of along(w.pts, 5, 0)) {
        const h = yOf(w, i) + (yOf(w, i + 1) - yOf(w, i)) * t;
        const tw = h < 0.3 ? twinAt(w, x, z, dx, dz, s) : null;
        const inner = w.hw2, outer = tw ? (w.hw2 + tw.d - tw.hw) / 2 : 0;
        const midX = x - dz * s * (inner + outer) / 2, midZ = z + dx * s * (inner + outer) / 2;
        if (!tw || outer - inner < 1 || inCarriage(midX, midZ, w.idx, 0, dx, dz, 2, 0.5) || inCut(midX, midZ) || inRail(midX, midZ, 0, BALLAST_HW + 1)) { flush(); continue; }
        pts.push([x, z]);
        A.push(s > 0 ? inner : -outer); B.push(s > 0 ? outer : -inner);
      }
      flush();
    } else if (w.median > 0) {
      let pts = [];
      const flush = () => { if (pts.length >= 2) medianRun(pts, pts.map(() => -w.median / 2), pts.map(() => w.median / 2), urban, false); pts = []; };
      for (const [x, z, dx, dz, i, t] of along(w.pts, 5, 0)) {
        const h = yOf(w, i) + (yOf(w, i + 1) - yOf(w, i)) * t;
        if (h > 0.3 || inCarriage(x, z, w.idx, 0, dx, dz, 2, 0.5) || nearJunction(x, z, w.idx, 3)) { flush(); continue; }
        pts.push([x, z]);
      }
      flush();
    }
  }

  lap('centre dividers');
  // ---- centre dividers (round 8, road bugs) ----
  // Every two-way road and every dual carriageway keeps its directions apart:
  //  - a two-way way on a bridge or ramp (raised more than 0.3 u) gets a New Jersey barrier down its
  //    centre line, solid for walkers and drivers at deck level;
  //  - twin one-way decks whose asphalt touches get the same barrier on the line midway between their
  //    centre lines (structure() only fills a slot between decks that is not asphalt);
  //  - twin one-way roads at grade that overlap too much for a planted median get a barrier there;
  //  - two-way streets of tertiary rank and up at grade without a planted median get a low kerbed strip
  //    (smaller streets keep a painted double line, see lineSet).
  // Nothing is drawn across a junction mouth or a driveway: a divider stops where another
  // carriageway covers its line.
  const DIV_HW = 0.4, DIV_H = 1.0, DIV_KERB = 0.2, DIV_STEP = 3;
  const deckTwinAt = (w, x, z, dx, dz, h, side) => {
    const list = cgrid.at(x, z);
    if (!list) return null;
    let best = null;
    for (const s of list) {
      if (s.ri === w.idx || s.rank < 3 || dx * s.ux + dz * s.uz > -0.75) continue;
      const d = segDist(s, x, z);
      if (d > w.hw2 + s.hw + 0.3) continue;
      if (Math.abs(s.h0 + (s.h1 - s.h0) * segT - h) > 2.5) continue;
      const qx = s.ax + s.ux * s.len * segT, qz = s.az + s.uz * s.len * segT;
      if (Math.sign((qx - x) * -dz + (qz - z) * dx) !== side) continue;
      if (!best || d < best.d) best = { d, hw: s.hw, ri: s.ri };
    }
    return best;
  };
  const divStats = { walks: 0, up: 0, barrier: 0, kerb: 0, twoway: 0 };
  const placeDivider = (pts, ys, raised, ground) => {
    if (pts.length < 2 || polylineLength(pts) < 4) return;
    divStats[raised ? 'up' : ground]++;
    const N = vnormals(pts);
    if (raised) {
      absolute(() => slab(layers.solid, pts, ys.map((y) => y - 0.05), -DIV_HW, DIV_HW, ys.map((y) => y + DIV_H), barrierC, barrierC, { N }));
      for (let k = 0; k < pts.length - 1; k++) {
        const pa = ep(pts, N, k, -DIV_HW, 0), pb = ep(pts, N, k + 1, -DIV_HW, 0), pc = ep(pts, N, k + 1, DIV_HW, 0), pd = ep(pts, N, k, DIV_HW, 0);
        colliders.push({ kind: 'wall', height: DIV_H, y0: Math.min(ys[k], ys[k + 1]) - 0.6, y1: Math.max(ys[k], ys[k + 1]) + DIV_H, points: [[pa[0], pa[2]], [pb[0], pb[2]], [pc[0], pc[2]], [pd[0], pd[2]]] });
      }
    } else if (ground === 'barrier') {
      slab(layers.solid, pts, Y.road, -DIV_HW, DIV_HW, Y.road + 0.9, barrierC, barrierC, { N });
    } else {
      slab(layers.solid, pts, Y.road, -0.35, 0.35, Y.road + DIV_KERB, barrierC, kerbC, { N });
    }
  };
  // Samples a way every DIV_STEP u; `at(x, z, dx, dz, h, i, t)` returns the offset of the divider
  // line from the way's centre line and its mode, or null where there is none.
  const dividerWalk = (w, at) => {
    divStats.walks++;
    let rp = [], ry = [], mode = null;
    const flush = () => {
      if (rp.length >= 2) {
        const N = vnormals(rp);
        placeDivider(rp.map((p, k) => [p[0] + N[k][0] * p[2], p[1] + N[k][1] * p[2]]), ry, mode === 'up', mode);
      }
      rp = []; ry = []; mode = null;
    };
    for (const [x, z, dx, dz, i, t] of along(w.pts, DIV_STEP, 0)) {
      const h = yOf(w, i) + (yOf(w, i + 1) - yOf(w, i)) * t;
      const r = at(x, z, dx, dz, h, i, t);
      if (!r || (mode && r.mode !== mode)) flush();
      if (!r) continue;
      mode = r.mode;
      rp.push([x, z, r.off]);
      ry.push(w.ya ? w.ya[i] + (w.ya[i + 1] - w.ya[i]) * t + roadY(w.rank) : 0);
    }
    flush();
  };
  for (const w of cars) {
    if (w.roundabout || w.cls.link || w.rank < 3) continue;
    if (!w.oneway) {
      divStats.twoway++;
      dividerWalk(w, (x, z, dx, dz, h) => {
        if (h > 0.3) return inCarriage(x, z, w.idx, h, dx, dz, 1, 1.2) ? null : { off: 0, mode: 'up' };
        if (w.median > 0 || w.rank < 5) return null;
        if (inCarriage(x, z, w.idx, 0, dx, dz, 1, 1.2) || nearJunction(x, z, w.idx, 1) || inCut(x, z) || inRail(x, z, 0, BALLAST_HW + 1)) return null;
        return { off: 0, mode: 'kerb' };
      });
    } else if (isUp(w)) {
      // Twin decks whose asphalt touches: the lower-indexed one draws the barrier between them.
      for (const s of [-1, 1]) {
        dividerWalk(w, (x, z, dx, dz, h) => {
          if (h <= 0.3) return null;
          const tw = deckTwinAt(w, x, z, dx, dz, h, s);
          if (!tw || w.idx > tw.ri) return null;
          const off = s * Math.max(0.1, (w.hw2 - tw.hw + tw.d) / 2), mx = x - dz * off, mz = z + dx * off;
          if (inCarriage(mx, mz, w.idx, h, dx, dz, 1, 0.5)) return null;
          return { off, mode: 'up' };
        });
      }
    }
  }
  if (rampStats) rampStats.dividers = divStats;
  // Twin one-way roads at grade where the planted median does not fit: a barrier on the line midway.
  for (const w of cars) {
    if (!w.twinSide || w.roundabout) continue;
    const s = w.twinSide;
    dividerWalk(w, (x, z, dx, dz, h) => {
      if (h > 0.3) return null;
      const tw = twinAt(w, x, z, dx, dz, s);
      if (!tw || w.idx > tw.ri) return null;
      const inner = w.hw2, outer = (w.hw2 + tw.d - tw.hw) / 2;
      if (outer - inner >= 1) return null; // a planted median is drawn here
      const off = s * (tw.d / 2), mx = x - dz * off, mz = z + dx * off;
      if (inCarriage(mx, mz, w.idx, 0, dx, dz, 2, 0.5) || nearJunction(mx, mz, w.idx, 1) || inCut(mx, mz) || inRail(mx, mz, 0, BALLAST_HW + 1)) return null;
      return { off, mode: 'barrier' };
    });
  }

  lap('roundabout islands');
  const flowerA = C(0xe0567a), flowerB = C(0xf2c14e), flowerC = C(0xb16fd8), moundC = C(0x6fb84f), splitC = C(0xcfd1c9);
  // ---- roundabout islands ----
  const rings = [];
  {
    const groups = new Map(), parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
    for (const w of cars) {
      if (!w.roundabout) continue;
      const ks = [keyOf(w.pts[0]), keyOf(w.pts[w.pts.length - 1])];
      for (const k of ks) if (!parent.has(k)) parent.set(k, k);
      const ra = find(ks[0]), rb = find(ks[1]);
      if (ra !== rb) parent.set(ra, rb);
    }
    for (const w of cars) {
      if (!w.roundabout) continue;
      const r = find(keyOf(w.pts[0]));
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(w);
    }
    for (const g of groups.values()) {
      if (g.some((w) => isUp(w))) continue;
      const pts = g.flatMap((w) => w.pts);
      const [cx, cz] = centroid(pts);
      const angs = pts.map((p) => Math.atan2(p[1] - cz, p[0] - cx)).sort((a, b) => a - b);
      let gap = angs[0] + Math.PI * 2 - angs[angs.length - 1];
      for (let i = 1; i < angs.length; i++) gap = Math.max(gap, angs[i] - angs[i - 1]);
      if (gap > 2.1) continue; // not a closed ring
      const rad = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cz), 0) / pts.length;
      rings.push({ x: cx, z: cz, r: rad + Math.max(...g.map((w) => w.hw2)) }); // outer edge, for traffic lights
      const ri = rad - Math.max(...g.map((w) => w.hw2)) - 0.3;
      if (ri < 1.2) continue;
      const circle = [];
      for (let k = 0; k <= 20; k++) circle.push([cx + Math.cos((k / 20) * Math.PI * 2) * ri, cz + Math.sin((k / 20) * Math.PI * 2) * ri]);
      const acc = layers.solid.at(cx, cz);
      fillPoly(acc, circle.slice(0, 20), SIDE_TOP, grassC);
      for (let k = 0; k < 20; k++) {
        const a = circle[k], b = circle[k + 1];
        acc.quad([a[0], Y.road, a[1]], [b[0], Y.road, b[1]], [b[0], SIDE_TOP, b[1]], [a[0], SIDE_TOP, a[1]], kerbC, [(a[0] + b[0]) / 2 - cx, 0, (a[1] + b[1]) / 2 - cz]);
      }
      medians.push({ points: circle, width: ri * 2, roundabout: true, x: cx, z: cz });
      // Central island landscaping (round 6): a flower ring inside the kerb and, on big rings
      // (Kikar Rabin, the rings down to 431), a raised planted mound in the middle.
      if (ri > 4) {
        const ring2 = (r) => { const c = []; for (let k = 0; k < 24; k++) c.push([cx + Math.cos((k / 24) * Math.PI * 2) * r, cz + Math.sin((k / 24) * Math.PI * 2) * r]); return c; };
        const outer = ring2(ri - 0.6), inner = ring2(ri - Math.min(2.4, ri * 0.25));
        for (let k = 0; k < 24; k++) {
          const a = outer[k], b = outer[(k + 1) % 24], c = inner[(k + 1) % 24], d = inner[k];
          acc.quad([a[0], SIDE_TOP + 0.02, a[1]], [d[0], SIDE_TOP + 0.02, d[1]], [c[0], SIDE_TOP + 0.02, c[1]], [b[0], SIDE_TOP + 0.02, b[1]], k % 3 === 0 ? flowerA : k % 3 === 1 ? flowerB : flowerC, UP);
        }
        if (ri > 10) {
          const m = ring2(ri * 0.38);
          slab(layers.solid, [...m, m[0]], SIDE_TOP, -0.01, ri * 0.06, SIDE_TOP + 1.2, moundC, hedgeC, { caps: false });
          fillPoly(layers.solid.at(cx, cz), m, SIDE_TOP + 1.2, moundC);
        }
      }
      // Splitter islands: a kerbed, tapering island down the middle of every two-way arm, from the
      // ring's outer edge outwards, so entry and exit lanes are separated as on a real roundabout.
      const ringKeys = new Set(g.flatMap((w) => w.pts.map(keyOf)));
      const ringHw = Math.max(...g.map((w) => w.hw2));
      for (const w of cars) {
        if (w.roundabout || w.oneway || w.cls.link || isUp(w) || w.rank < 3) continue;
        for (const end of [0, 1]) {
          const n = w.pts.length, p = end ? w.pts[n - 1] : w.pts[0];
          if (!ringKeys.has(keyOf(p))) continue;
          const seg = end ? n - 2 : 0, t = end ? 1 : 0, dir = end ? -1 : 1;
          const L = Math.min(U(14), w.len * 0.45), base = Math.min(w.hw2 * 0.4, 2.4);
          const pts = [];
          for (let k = 0; k <= 4; k++) { const q = walkFrom(w.pts, seg, t, dir, ringHw + 1 + (L * k) / 4); if (q) pts.push([q.x, q.z]); }
          if (pts.length < 3) continue;
          const half = pts.map((_, k) => Math.max(0.35, base * (1 - k / (pts.length - 1)) + 0.35 * (k / (pts.length - 1))));
          const N = vnormals(pts);
          slab(layers.solid, pts, Y.road, half.map((h) => -h), half, SIDE_TOP, splitC, kerbC, { N });
          strip(layers.marks, pts, Y.road + MARK_LIFT, half.map((h) => -h - 0.5), half.map((h) => -h - 0.2), WHITE, N);
          strip(layers.marks, pts, Y.road + MARK_LIFT, half.map((h) => h + 0.2), half.map((h) => h + 0.5), WHITE, N);
        }
      }
    }
  }

  lap('railway');
  // ---- railway: fenced ballast corridor, sleepers, rails, bridges ----
  const corridorC = C(PALETTE.corridor), ballastC = C(PALETTE.ballast), ballastSide = C(PALETTE.ballastSide), sleeperC = C(PALETTE.sleeper), railC = C(PALETTE.rail), railTop = C(PALETTE.railTop), fenceC = C(PALETTE.fence);
  const inPlatform = (x, z) => platforms.some((p) => inPoly(x, z, p));
  rails.forEach((r, ri) => {
    const entry = { kind: 'rail', width: r.w, name: '', points: r.pts };
    if (r.bridgeTag || r.level) entry.bridge = true;
    if (r.tunnel) entry.tunnel = true;
    if (r.layer) entry.layer = r.layer;
    if (r.ys) entry.heights = r.ys;
    if (r.ys) entry.surface = r.ya.map((h) => h + BALLAST_H);
    roads.push(entry);
    if (r.tunnel) return;
    const pts = r.pts, ys = r.ys || pts.map(() => 0), N = vnormals(pts);
    const ground = (i) => ys[i] < 0.05 && ys[i + 1] < 0.05;
    // In the trench the corridor strip would span it like a lid at rim height.
    const open = (i) => ground(i) && !inCut((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    strip(layers.paths, pts, Y.path - 0.005, -FENCE_OFF, FENCE_OFF, corridorC, N, open);
    // Station tracks run between platforms: no parapets between them or along the platform edges.
    structure(r, BALLAST_HW + 1.2, 0.05, !r.station);
    // Raised track is written in absolute heights; track at grade drapes on the terrain.
    const yy = r.ys ? r.ya : ys;
    ABS = !!r.ys;
    const base = yy.map((y) => y + 0.05), top = yy.map((y) => y + BALLAST_H);
    slab(layers.solid, pts, base, -BALLAST_HW, BALLAST_HW, top, ballastC, ballastSide, { N });
    // Sleepers: flat timber bars across the ballast.
    const wk = walker(pts, yy);
    const sl = U(2.6) / 2;
    for (let s = 0.5; s < wk.L; s += U(0.75)) {
      const p = wk.at(s), y = p.y + BALLAST_H + 0.1;
      const nx = -p.dz, nz = p.dx, hx = p.dx * 0.28, hz = p.dz * 0.28;
      layers.solid.at(p.x, p.z).quad([p.x - nx * sl - hx, y, p.z - nz * sl - hz], [p.x - nx * sl + hx, y, p.z - nz * sl + hz], [p.x + nx * sl + hx, y, p.z + nz * sl + hz], [p.x + nx * sl - hx, y, p.z + nz * sl - hz], sleeperC, UP);
    }
    for (const g of [-GAUGE / 2, GAUGE / 2]) slab(layers.solid, pts, top, g - 0.13, g + 0.13, yy.map((y) => y + BALLAST_H + 0.42), railTop, railC, { N });
    ABS = false;
    if (r.ys) addDeck(pts, ys, r.ya, BALLAST_H, BALLAST_HW + 1.2);
    // Buffer stop and end wall where a station track ends (terminus).
    if (r.station && r.ys) for (const end of [0, 1]) {
      const i = end ? pts.length - 1 : 0, j = end ? pts.length - 2 : 1;
      if (!bareStations.some((st) => Math.hypot(pts[i][0] - st.x, pts[i][1] - st.z) < 160)) continue;
      const dx = pts[i][0] - pts[j][0], dz = pts[i][1] - pts[j][1], l = Math.hypot(dx, dz) || 1, rot = Math.atan2(-dz / l, dx / l);
      const y = r.ya[i];
      absolute(() => {
        box(layers.solid, pts[i][0] - (dx / l) * 1.2, y + BALLAST_H, pts[i][1] - (dz / l) * 1.2, 1.2, 1.4, GAUGE + 1.2, rot, C(PALETTE.lineYellow), C(0xc0392b));
        box(layers.solid, pts[i][0] + (dx / l) * 0.4, groundAt(pts[i][0], pts[i][1]) - 0.3, pts[i][1] + (dz / l) * 0.4, 0.8, y + BALLAST_H - groundAt(pts[i][0], pts[i][1]) + 0.3, BALLAST_HW * 2 + 0.6, rot, concrete, concrete);
      });
    }
    // Fences either side, skipped between parallel tracks, at level crossings and stations.
    for (const s of [-1, 1]) {
      const op = offsetLine(pts, s * FENCE_OFF, N);
      const fw = walker(op, ys);
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          let rp = simplify(run, 0.3);
          if (ctx.terrain) rp = densify(rp, 12);
          const RN = vnormals(rp);
          for (const hgt of [1.1, 2.2]) slab(layers.solid, rp, hgt - 0.12, -0.07, 0.07, hgt, fenceC, fenceC, { N: RN, caps: false });
          for (const [x, z, dx, dz] of along(rp, 5, 0.5)) box(layers.solid, x, 0, z, 0.22, 2.4, 0.22, Math.atan2(-dz, dx), fenceC, fenceC);
          for (let k = 0; k < rp.length - 1; k++) {
            const a = ep(rp, RN, k, -0.3, 0), b = ep(rp, RN, k + 1, -0.3, 0), c = ep(rp, RN, k + 1, 0.3, 0), d = ep(rp, RN, k, 0.3, 0);
            const fy = Math.min(groundAt(a[0], a[2]), groundAt(b[0], b[2]));
            colliders.push({ kind: 'fence', height: 2.4, y0: fy - 0.3, y1: fy + 2.4, points: [[a[0], a[2]], [b[0], b[2]], [c[0], c[2]], [d[0], d[2]]] });
          }
        }
        run = [];
      };
      for (let d = 0; d <= fw.L + 2.9; d += 3) {
        const p = fw.at(Math.min(d, fw.L));
        const ok = p.y < 0.05 && !inRail(p.x, p.z, 0, FENCE_OFF - 0.6, ri) && !inCarriage(p.x, p.z, -1, 0, 0, 0, 1, 1) && !inBuilding(p.x, p.z) && !inPlatform(p.x, p.z);
        if (ok) run.push([p.x, p.z]); else flush();
      }
      flush();
    }
  });

  lap('bus stops');
  // ---- bus stops: OSM stop positions snapped onto the nearest real sidewalk ----
  const swGrid = new SegGrid(30);
  sidewalks.forEach((sw) => {
    if (!RC[sw.roadKind] || RC[sw.roadKind].rank < 3) return;
    for (let i = 0; i < sw.points.length - 1; i++) swGrid.add(mkSeg(sw.points[i], sw.points[i + 1], { sw, i }), 32);
  });
  const busStops = [];
  for (const [nameEn, nameLocal, x, z] of data.busStops || []) {
    const list = swGrid.at(x, z);
    if (!list) continue;
    let best = null;
    for (const s of list) { const d = segDist(s, x, z); if (d < 32 && (!best || d < best.d)) best = { d, s, t: segT }; }
    if (!best) continue;
    const { s } = best;
    // Keep shelters off the corner: slide along the strip away from its ends.
    const along0 = Math.max(Math.min(best.t * s.len, s.len - 4), Math.min(4, s.len / 2));
    const px = s.ax + s.ux * along0, pz = s.az + s.uz * along0;
    if (busStops.some((b) => Math.hypot(b.x - px, b.z - pz) < 6)) continue;
    // The sidewalk was offset to `side` of the road, so the road lies the other way.
    const sg = s.sw.side === 'right' ? -1 : 1;
    const vx = -s.uz * sg, vz = s.ux * sg;
    busStops.push({ x: px, z: pz, angle: Math.atan2(vx, vz), name: nameEn || nameLocal, nameLocal, road: s.sw.roadName });
  }

  // ---- promenade edges count as sidewalks for the dressing ----
  for (const w of ways) {
    if (w.path !== 'promenade' || w.len < 10) continue;
    const N = vnormals(w.pts);
    for (const s of [-1, 1]) sidewalks.push({ points: offsetLine(w.pts, s * Math.max(0, w.hw2 - SW / 2), N), roadKind: 'promenade', side: s > 0 ? 'right' : 'left', roadName: w.name, width: Math.min(SW, w.w / 2) });
  }

  // Walkable surface under (x, z) for a walker at height y: the highest deck no more than a step
  // above y, or the terrain, whichever is higher.
  // Each structure answers with its nearest segment only: on a wide ramp, the next segment up the
  // slope is also "within the half-width" of its clamped start, and used to lift walkers ~1 u.
  // Among the structures within reach of the walker's height (a step up, a snap down), the one
  // whose centre line is nearest wins: where a slip road peels off a deck, a car following the
  // slip road stays on it instead of riding the level deck until it ends and dropping 3 u.
  // At-grade carriageway next to a raised one: where a slip road peels off a deck (or a ramp
  // leaves a street), the raised way's walkable strip reached over the at-grade lanes beside it,
  // and with nothing of their own in the index a car on those lanes rode the raised surface until
  // the strips parted, then dropped up to 0.9 u (Moshe Dayan, after DECK went to 9.5). Those
  // at-grade stretches are indexed too, answering with the ground, so the nearest centre line wins.
  {
    const near = new SegGrid(25);
    for (const w of cars) if (w.ys) for (let i = 0; i < w.pts.length - 1; i++) if (w.ys[i] > 0.05 || w.ys[i + 1] > 0.05) near.add(mkSeg(w.pts[i], w.pts[i + 1], {}), w.hw2 + 14);
    for (const w of cars) {
      const id = deckId++;
      for (let i = 0; i < w.pts.length - 1; i++) {
        if (yOf(w, i) > 0.05 || yOf(w, i + 1) > 0.05) continue;
        const [ax, az] = w.pts[i], [bx, bz] = w.pts[i + 1];
        if (!near.at(ax, az) && !near.at(bx, bz) && !near.at((ax + bx) / 2, (az + bz) / 2)) continue;
        hgrid.add(mkSeg(w.pts[i], w.pts[i + 1], { ground: true, hw: w.hw2, id }), w.hw2 + 1);
      }
    }
  }
  const nearD = new Map(), nearH = new Map(), nearW = new Map();
  function heightAt(x, z, y = 0) {
    const g = groundAt(x, z);
    const list = hgrid.at(x, z);
    if (!list) return g;
    nearD.clear(); nearH.clear(); nearW.clear();
    for (const s of list) {
      const d = segDist(s, x, z);
      if (d > s.hw) continue;
      const pd = nearD.get(s.id);
      if (pd !== undefined && pd <= d) continue;
      nearD.set(s.id, d);
      nearH.set(s.id, s.ground ? g : s.h0 + (s.h1 - s.h0) * segT);
      nearW.set(s.id, s.hw);
    }
    let best = g, bestR = Infinity, top = g;
    for (const [id, h] of nearH) {
      if (h > y + STEP_UP) continue;
      if (h > top) top = h;
      if (h < y - SNAP_BAND) continue;
      const r = nearD.get(id) / nearW.get(id) - (prioDecks.has(id) ? 10 : 0);
      if (r < bestR) { bestR = r; best = h; }
    }
    // Nothing underfoot within reach (falling, or a query from above): the highest surface below.
    // A walker high on a structure first climbs a ledge a little above its feet: where two decks of
    // one bridge meet 0.6-1.2 u apart (a slip road peeling off a deck, Sderot Tashah), the lower
    // deck ended at a bare edge and the walker dropped 17 u past the higher one.
    if (bestR === Infinity && y > g + 3) {
      let ledge = Infinity;
      for (const [id, h] of nearH) if (h > y + STEP_UP && h <= y + LEDGE_MAX && h < ledge) ledge = h;
      if (ledge < Infinity) return ledge;
    }
    return bestR === Infinity ? top : Math.max(best, g);
  }

  const onCarriage = (x, z, margin = 0) => inCarriage(x, z, -1, 0, 0, 0, 1, margin) || inRail(x, z, 0, BALLAST_HW + margin);
  lap(null);
  // Ground-level junctions for dressing.js (traffic lights): every arm with its unit direction away
  // from the node, half width and rank. Includes a side street ending on the middle of a main road.
  const junctionNodes = junctions.map((j) => ({
    x: j.x, z: j.z,
    arms: j.arms.map((a) => {
      const at = walkFrom(a.w.pts, a.seg, a.t, a.dir, 4);
      const l = at ? Math.hypot(at.x - j.x, at.z - j.z) : 0;
      return l > 0.5 ? { ax: (at.x - j.x) / l, az: (at.z - j.z) / l, hw: a.w.hw2, rank: a.w.rank, link: !!(a.w.cls && a.w.cls.link) } : null;
    }).filter(Boolean),
  })).filter((j) => j.arms.length >= 3);
  return { roads, sidewalks, busStops, medians, crossings, heightAt, onCarriage, cars, junctions: junctions.length, junctionNodes, rings, rampStats, prof, platformAt, stationStairs, platformHandled, sidePlatforms, streetSigns };
}

// ---------- rail trench along the Ayalon (cut defined by terrain.js) ----------

// Retaining walls down both sides of the cut and a lip strip over the rim, where the terrain mesh
// dips to the trench floor within one grid cell. Walls between two parallel cuts are left out.
function buildTrench(layers, colliders, { list, rimAt }) {
  const wallC = col(PALETTE.concrete, 0.92), capC = col(PALETTE.parapetTop), lipC = col(PALETTE.medianDry, 0.95);
  const inOther = (x, z) => groundAt(x, z) < rimAt(x, z) - 0.3;
  const LIP = 22;
  absolute(() => {
    for (const c of list) {
      const pts = c.points, N = vnormals(pts), n = pts.length;
      for (const s of [-1, 1]) {
        const on = pts.map((p, i) => {
          if (c.depth[i] < 0.3) return false;
          const o = c.hw[i] + 0.8;
          return !inOther(p[0] + N[i][0] * s * o, p[1] + N[i][1] * s * o);
        });
        const segIf = (i) => on[i] && on[i + 1];
        const rim = pts.map((p, i) => rimAt(p[0] + N[i][0] * s * (c.hw[i] + 0.5), p[1] + N[i][1] * s * (c.hw[i] + 0.5)));
        const a = c.hw.map((h) => s * (h - 0.35)), b = c.hw.map((h) => s * (h + 0.35));
        slab(layers.solid, pts, rim.map((r, i) => r - c.depth[i] - 0.4), a, b, rim.map((r) => r + 0.55), capC, wallC, { N, caps: false, segIf });
        // The lip stops short of a neighbouring cut (two tracks in two cuts side by side).
        const lw = pts.map((p, i) => {
          let w = 1;
          while (w < LIP && !inOther(p[0] + N[i][0] * s * (c.hw[i] + w + 1), p[1] + N[i][1] * s * (c.hw[i] + w + 1))) w += 1.5;
          return Math.max(0.5, w - 1);
        });
        const la = c.hw.map((h) => s * (h + 0.35)), lb = c.hw.map((h, i) => s * (h + lw[i]));
        const lipY = pts.map((p, i) => rimAt(p[0] + N[i][0] * s * (c.hw[i] + lw[i] / 2), p[1] + N[i][1] * s * (c.hw[i] + lw[i] / 2)));
        strip(layers.paths, pts, rim.map((r) => r + 0.03), la, lb, lipC, N, segIf, lipY.map((r) => r + 0.03));
        for (let i = 0; i < n - 1; i++) {
          if (!segIf(i)) continue;
          const A = [pts[i][0] + N[i][0] * a[i], pts[i][1] + N[i][1] * a[i]], B = [pts[i + 1][0] + N[i + 1][0] * a[i + 1], pts[i + 1][1] + N[i + 1][1] * a[i + 1]];
          const B2 = [pts[i + 1][0] + N[i + 1][0] * b[i + 1], pts[i + 1][1] + N[i + 1][1] * b[i + 1]], A2 = [pts[i][0] + N[i][0] * b[i], pts[i][1] + N[i][1] * b[i]];
          colliders.push({ kind: 'wall', height: c.depth[i] + 0.55, y0: Math.min(rim[i], rim[i + 1]) - Math.max(c.depth[i], c.depth[i + 1]) - 0.4, y1: Math.max(rim[i], rim[i + 1]) + 0.55, points: [A, B, B2, A2] });
        }
      }
    }
  });
}

// ---------- water: ponds, channels, streams, pools and fountains ----------

// Water used to sit flat at its lowest shore point, so a long channel on a slope (the Neot Ashlim
// park water) lay under the terrain everywhere but its low end and was invisible. Now each body is
// either level (ponds, pools, fountains, wherever the ground under it varies little) at its
// highest point with a bank or basin wall round it, or, on a real slope, draped over the ground a
// little above the terrain mesh like a stream. topAt(x, z) gives the water surface for bridges.
const WATER_LIFT = 0.45;  // draped water above the bilinear ground: clears the terrain mesh triangulation
const WATER_FLAT_MAX = 2.2; // ground range under a body that may still be drawn level
const WATER_CELL = 48;    // water colliders are cut into cells so each knows its local surface
function clipToBox(poly, x0, z0, x1, z1) {
  // Sutherland-Hodgman against an axis-aligned box.
  let out = poly;
  const edges = [[(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= z0, (a, b) => [a[0] + ((b[0] - a[0]) * (z0 - a[1])) / (b[1] - a[1]), z0]],
    [(p) => p[1] <= z1, (a, b) => [a[0] + ((b[0] - a[0]) * (z1 - a[1])) / (b[1] - a[1]), z1]]];
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    if (out.length < 3) return [];
  }
  return out;
}
function buildWater(data, { ownedByLandmark, colliders, root, flatMat, toon }) {
  const surf = new Acc(), banks = new Acc(), bankL = { at: () => banks };
  const bodies = [], waterCols = [];
  const lakeC = col(PALETTE.lake), bankEarth = col(0xb59f78), bankStone = col(0xd8cfbd), basinC = col(0xe9e2d3);
  const list = [];
  for (const [name, f, kind] of data.water || []) list.push({ r: ring(f), name, kind: kind || 'water' });
  // Streams and drains: a ribbon at their mapped (or typical) width, widened like the roads.
  for (const [name, f, wm] of data.waterways || []) {
    const pts = ring(f);
    if (pts.length < 2) continue;
    const hw = Math.max(U(1.2), U(wm)) / 2, N = vnormals(pts);
    list.push({ r: [...offsetLine(pts, hw, N), ...offsetLine(pts, -hw, N).reverse()], name, kind: 'stream' });
  }
  for (const [x, z, rad] of data.fountains || []) {
    const r = [];
    for (let k = 0; k < 14; k++) r.push([x + Math.cos((k / 14) * Math.PI * 2) * rad * WIDEN, z + Math.sin((k / 14) * Math.PI * 2) * rad * WIDEN]);
    list.push({ r, name: '', kind: 'fountain' });
  }
  for (const b of list) {
    let r = b.r;
    if (r.length < 3 || ownedByLandmark(r)) continue;
    if (signedArea(r) < 0) r = [...r].reverse();
    const bb = bbox(r);
    // Ground under the body: its outline plus an interior grid.
    const step = Math.max(5, Math.sqrt((bb.maxX - bb.minX) * (bb.maxZ - bb.minZ)) / 24);
    let gmin = Infinity, gmax = -Infinity;
    const sample = (x, z) => { const g = groundAt(x, z); if (g < gmin) gmin = g; if (g > gmax) gmax = g; };
    for (const p of r) sample(p[0], p[1]);
    for (let x = bb.minX + step / 2; x < bb.maxX; x += step) for (let z = bb.minZ + step / 2; z < bb.maxZ; z += step) if (inPoly(x, z, r)) sample(x, z);
    const built = b.kind === 'fountain' || b.kind === 'swimming_pool';
    const level = built || gmax - gmin <= WATER_FLAT_MAX;
    const top = level ? gmax + (built ? 0.35 : 0.25) : null;
    const topAt = level ? () => top : (x, z) => groundAt(x, z) + WATER_LIFT;
    if (level) absolute(() => fillPoly(surf, r, top, lakeC));
    else fillPolyDense(surf, r, WATER_LIFT, lakeC, 10);
    // Bank (natural water) or basin wall (fountains, pools) just outside the waterline.
    const closed = [...r, r[0]], N = vnormals(closed);
    const mid = [(closed[0][0] + closed[1][0]) / 2 + N[0][0] * 0.5, (closed[0][1] + closed[1][1]) / 2 + N[0][1] * 0.5];
    const out = inPoly(mid[0], mid[1], r) ? -1 : 1;
    const wall = b.kind === 'fountain' ? 0.55 : built ? 0.15 : 0.12;
    const wide = b.kind === 'fountain' ? 0.7 : built ? 1.0 : 1.2;
    const ca = closed.map(() => out * -0.25), cb = closed.map(() => out * wide);
    const cc = b.kind === 'fountain' ? basinC : built ? bankStone : bankEarth;
    if (level) {
      absolute(() => slab(bankL, closed, closed.map((p) => groundAt(p[0], p[1]) - 0.4), ca, cb, closed.map(() => top + wall), cc, cc, { N, caps: false }));
    } else slab(bankL, closed, -0.4, ca, cb, WATER_LIFT + wall, cc, cc, { N, caps: false });
    b.r = r; b.bb = bb; b.topAt = topAt; b.top = level ? top : gmax + WATER_LIFT;
    bodies.push(b);
    // Colliders per cell, each passable from above its own surface (footbridges, decks).
    for (let cx = Math.floor(bb.minX / WATER_CELL); cx <= Math.floor(bb.maxX / WATER_CELL); cx++)
      for (let cz = Math.floor(bb.minZ / WATER_CELL); cz <= Math.floor(bb.maxZ / WATER_CELL); cz++) {
        const piece = clipToBox(r, cx * WATER_CELL, cz * WATER_CELL, (cx + 1) * WATER_CELL, (cz + 1) * WATER_CELL);
        if (piece.length < 3 || Math.abs(signedArea(piece)) < 0.5) continue;
        const ptop = Math.max(...piece.map((p) => topAt(p[0], p[1])));
        const wc = { kind: 'water', points: piece, y1: ptop + 0.5, bb: bbox(piece) };
        colliders.push(wc);
        waterCols.push(wc);
      }
  }
  if (!surf.empty) {
    const m = new THREE.Mesh(surf.geometry(true), toon({ color: PALETTE.lake }));
    m.geometry.deleteAttribute('color');
    m.userData.water = true;
    m.userData.foam = false;
    m.name = 'lakes';
    root.add(m);
  }
  if (!banks.empty) {
    const m = new THREE.Mesh(banks.geometry(true), flatMat);
    m.receiveShadow = true;
    m.name = 'water-banks';
    root.add(m);
  }
  // Surface of the water at (x, z), or null on dry land.
  const grid = new Map();
  bodies.forEach((b) => {
    for (let i = Math.floor(b.bb.minX / 64); i <= Math.floor(b.bb.maxX / 64); i++)
      for (let j = Math.floor(b.bb.minZ / 64); j <= Math.floor(b.bb.maxZ / 64); j++) { const k = i * 100003 + j; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b); }
  });
  const topAt = (x, z) => {
    const l = grid.get(Math.floor(x / 64) * 100003 + Math.floor(z / 64));
    if (!l) return null;
    let best = null;
    for (const b of l) if (x >= b.bb.minX && x <= b.bb.maxX && z >= b.bb.minZ && z <= b.bb.maxZ && inPoly(x, z, b.r)) { const t = b.topAt(x, z); if (best === null || t > best) best = t; }
    return best;
  };
  // Once the network is built: a walker on any raised way over the water (a footbridge, its
  // approach ramps where they run over the pond) passes over that water piece's collider.
  const openUnder = (roads) => {
    let opened = 0;
    for (const r of roads) {
      if (!r.surface || r.tunnel) continue;
      const P = r.points;
      for (let i = 0; i < P.length - 1; i++) {
        const [ax, az] = P[i], [bx, bz] = P[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5));
        for (let k = 0; k <= n; k++) {
          const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          if (topAt(x, z) === null) continue;
          const y = r.surface[i] + (r.surface[i + 1] - r.surface[i]) * t;
          for (const c of waterCols) {
            if (x < c.bb.minX || x > c.bb.maxX || z < c.bb.minZ || z > c.bb.maxZ || !inPoly(x, z, c.points)) continue;
            if (y + 0.3 < c.y1) { c.y1 = y + 0.3; opened++; }
          }
        }
      }
    }
    for (const c of waterCols) delete c.bb;
    return opened;
  };
  return { bodies: bodies.length, topAt, openUnder };
}

// ---------- fallback buildings (used when buildings.js is missing or fails) ----------

function fallbackBuildings(data, ctx) {
  const { root, colliders, excl, excluded, inRishon, K, K2, wallMat, roofMat, propMat } = ctx;
  const chunks = new Map();
  const chunkOf = (x, z) => {
    const key = `${Math.floor(x / (CHUNK * K))},${Math.floor(z / (CHUNK * K))}`;
    let c = chunks.get(key);
    if (!c) { c = { walls: new Acc(true), roofs: new Acc(), solar: [], balcony: [] }; chunks.set(key, c); }
    return c;
  };
  const yAxis = new THREE.Vector3(0, 1, 0);
  const mat4 = (x, y, z, rotY, sx, sy = sx, sz = sx) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(yAxis, rotY), new THREE.Vector3(sx, sy, sz));
  let built = 0, skipped = 0;
  data.buildings.forEach(([hm, kind, f], idx) => {
    let r = ring(f);
    if (r.length < 3) return;
    if (signedArea(r) < 0) r = r.reverse();
    const area = signedArea(r);
    const [cx, cz] = centroid(r);
    if (excl.length && excluded(cx, cz)) { skipped++; return; }
    const h1 = hash(idx + 1), h2 = hash(idx * 7 + 3), h3 = hash(idx * 13 + 5);
    let floors;
    if (hm > 0) floors = Math.max(1, Math.round(hm / 3));
    else {
      const west = cx < -150 * K;
      if (kind === 1) floors = 1 + Math.floor(h1 * 2);
      else if (kind === 4) floors = 1 + Math.floor(h1 * 2);
      else if (kind === 5 || kind === 6) floors = 2 + Math.floor(h1 * 2);
      else if (kind === 3) floors = area > 150 * K2 ? 2 + Math.floor(h1 * 3) : 3 + Math.floor(h1 * 5);
      else if (area < 12 * K2) floors = 1 + Math.floor(h1 * 2);
      else if (west) floors = area > 30 * K2 ? 8 + Math.floor(h1 * h1 * 16) : 3 + Math.floor(h1 * 5);
      else floors = area > 40 * K2 ? 3 + Math.floor(h1 * 5) : 1 + Math.floor(h1 * 3);
    }
    if (area < 4 * K2) floors = Math.min(floors, 1);
    const H = floors * FLOOR_H;
    const palette = kind === 3 ? WALLS_COM : kind === 4 ? WALLS_IND : (kind === 5 || kind === 6) ? WALLS_PUB : (cx > 300 * K && h2 < 0.5) ? WALLS_STONE : WALLS_RES;
    const wallHex = pick(palette, h2);
    const local = inRishon(cx, cz);
    const wc = local ? col(wallHex) : col(wallHex).lerp(HAZE, 0.45), wcLow = wc.clone().multiplyScalar(0.86);
    const ch = chunkOf(cx, cz);
    const pitched = r.length === 4 && area < 70 * K2 && floors <= 2 && (kind === 1 || (cx > 200 * K && h3 < 0.55));
    const top = pitched ? H : H + PARAPET;
    let u = 0;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const out = [dz / len, 0, -dx / len];
      const u0 = u / WIN_W;
      // Snap window bays to whole tiles per wall so glass never gets sliced at corners.
      const uu1 = u0 + Math.max(1, Math.round(len / WIN_W)) - 0.15;
      const v1 = top / FLOOR_H;
      ch.walls.quad([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], top, q[1]], [p[0], top, p[1]], [wcLow, wcLow, wc, wc], out, [[u0 - 0.15, 0], [uu1, 0], [uu1, v1], [u0 - 0.15, v1]]);
      u += len;
    }
    const roofHex = pitched || (kind === 1 && h3 < 0.6) ? PALETTE.roofTile : PALETTE.roof;
    const rc = local ? col(roofHex, 0.94 + h3 * 0.1) : col(roofHex).lerp(HAZE, 0.45);
    if (pitched) {
      const apex = [cx, H + Math.min(2.4 * V, (Math.sqrt(area) / K) * 0.35 * V), cz];
      for (let i = 0; i < 4; i++) {
        const p = r[i], q = r[(i + 1) % 4];
        ch.roofs.tri([p[0], H, p[1]], [q[0], H, q[1]], apex, rc, [((p[0] + q[0]) / 2 - cx), 0.8, ((p[1] + q[1]) / 2 - cz)]);
      }
    } else fillPoly(ch.roofs, r, H + 0.02, rc);
    colliders.push({ kind: 'building', height: top, points: r });
    built++;
    if (!pitched && kind !== 4 && kind !== 3 && area > 6 * K2) {
      const n = Math.min(8, Math.max(1, Math.round(area / (22 * K2) * (floors > 5 ? 1.4 : 1))));
      const bb = bbox(r);
      for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
        const x = bb.minX + V + hash(idx * 31 + tries) * (bb.maxX - bb.minX - 2 * V);
        const z = bb.minZ + V + hash(idx * 17 + tries * 3) * (bb.maxZ - bb.minZ - 2 * V);
        if (!inPoly(x, z, r)) continue;
        ch.solar.push(mat4(x, H, z, (hash(idx + tries) - 0.5) * 0.3, V));
        k++;
      }
    }
    if (!pitched && floors >= 3 && kind !== 4 && area > 15 * K2) {
      let best = 0, bi = 0;
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (l > best) { best = l; bi = i; }
      }
      if (best > 3 * K) {
        const p = r[bi], q = r[(bi + 1) % r.length];
        const dx = (q[0] - p[0]) / best, dz = (q[1] - p[1]) / best;
        // Local +x runs along the edge; the extra half turn points local +z outward for a CCW ring.
        const rotY = Math.atan2(-dz, dx) + Math.PI;
        const span = best * (0.35 + h1 * 0.25);
        const offs = best > 9 * K ? [0.27, 0.73] : [0.5];
        for (let fl = 1; fl < floors; fl++) for (const o of offs) ch.balcony.push(mat4(p[0] + dx * best * o, fl * FLOOR_H - 0.05, p[1] + dz * best * o, rotY, Math.min(span, best * 0.4), V, V));
      }
    }
  });
  const solarGeo = solarTemplate(), balconyGeo = balconyTemplate();
  for (const [key, c] of chunks) {
    const g = new THREE.Group();
    g.name = `buildings ${key}`;
    if (!c.walls.empty) { const w = new THREE.Mesh(c.walls.geometry(), wallMat); w.castShadow = w.receiveShadow = true; w.name = 'walls'; g.add(w); }
    if (!c.roofs.empty) { const r = new THREE.Mesh(c.roofs.geometry(), roofMat); r.castShadow = r.receiveShadow = true; r.name = 'roofs'; g.add(r); }
    for (const [geo, list, nm] of [[solarGeo, c.solar, 'solar-heaters'], [balconyGeo, c.balcony, 'balconies']]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, propMat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.name = nm;
      g.add(im);
    }
    root.add(g);
  }
  return { built, skipped };
}

// ---------- main ----------

export async function buildCity(scene, { exclude = [] } = {}) {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`rishon.json: HTTP ${res.status}`);
  const data = await res.json();
  if (data.meta.scale && Math.abs(data.meta.scale - SCALE) > 1e-9) rescaleData(data, SCALE / data.meta.scale);
  // Terrain is optional: without terrain.js (or its data) the world stays flat at y = 0.
  let terrain = false, cuts = null;
  groundAt = () => 0;
  try {
    const t = await import('./terrain.js');
    if (t.loadTerrain) await t.loadTerrain();
    if (typeof t.groundAt === 'function' && (!t.terrainLoaded || t.terrainLoaded())) { groundAt = t.groundAt; terrain = true; }
    if (terrain && t.terrainCuts && t.rimAt) cuts = { list: t.terrainCuts(), rimAt: t.rimAt };
    inCut = cuts && cuts.list.length ? (x, z) => groundAt(x, z) < cuts.rimAt(x, z) - 0.5 : () => false;
    rimGround = cuts && cuts.list.length ? cuts.rimAt : (x, z) => groundAt(x, z);
  } catch (e) {
    console.warn('[city] terrain.js unavailable, flat ground', e);
  }
  const b = data.meta.bounds;
  const K = SCALE / BASE_SCALE, K2 = K * K;
  // Outside the municipal boundary the city fades, so Rishon's own outline reads on the ground.
  const limits = (data.boundary || []).map(ring).filter((r) => r.length >= 3).map((r) => ({ r, bb: bbox(r) }));
  const inRishon = (x, z) => !limits.length || limits.some(({ r, bb }) => x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ && inPoly(x, z, r));
  const bounds = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };

  const excl = exclude
    .map((e) => (Array.isArray(e) ? e : e && e.points))
    .filter((r) => r && r.length >= 3)
    .map((r) => ({ r, bb: bbox(r) }));
  const excluded = (x, z) => excl.some(({ r, bb }) => x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ && inPoly(x, z, r));

  const root = new THREE.Group();
  root.name = 'city';
  scene.add(root);

  const gradientMap = toonGradient();
  const toon = (opts) => new THREE.MeshToonMaterial({ gradientMap, ...opts });
  const flatMat = toon({ vertexColors: true });
  const layerMat = (offset) => toon({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -offset, polygonOffsetUnits: -offset * 4 });
  const propMat = toon({ vertexColors: true });

  const colliders = [];
  const coast = ring(data.coast || []);

  // ---- land, sea, coast skirt ----
  const FAR = 3000;
  if (coast.length >= 2) {
    const first = coast[0], last = coast[coast.length - 1];
    const north = [first[0], first[1] - FAR], south = [last[0], last[1] + FAR];
    const landPoly = [north, ...coast, south, [bounds.maxX + FAR, south[1]], [bounds.maxX + FAR, north[1]]];
    const seaPoly = [north, ...coast, south, [bounds.minX - FAR, south[1]], [bounds.minX - FAR, north[1]]];
    const land = new Acc();
    // With terrain the heightfield is the ground (terrain.js draws it), so no flat plane at all.
    if (!terrain) fillPoly(land, landPoly, Y.land, col(PALETTE.land));
    const shore = [north, ...coast, south];
    const skirt = new Acc();
    if (!terrain) {
      // Beach strip along the waterline so the sand never depends on OSM beach coverage alone.
      ribbon(land, shore.map((p) => [p[0] + 7 * K, p[1]]), 14 * K, Y.beach - 0.01, col(PALETTE.sand));
      for (let i = 0; i < shore.length - 1; i++) {
        const a = shore[i], c = shore[i + 1];
        skirt.quad([a[0], 0.05, a[1]], [c[0], 0.05, c[1]], [c[0], -1.2, c[1]], [a[0], -1.2, a[1]], col(PALETTE.sand, 0.9), [-1, 0, 0]);
      }
    }
    if (!land.empty) {
      const landMesh = new THREE.Mesh(land.geometry(), flatMat);
      landMesh.receiveShadow = true;
      landMesh.name = 'land';
      root.add(landMesh);
    }
    if (!skirt.empty) root.add(new THREE.Mesh(skirt.geometry(), flatMat));

    const sea = new Acc();
    fillPoly(sea, seaPoly, -0.6, col(PALETTE.sea));
    const seaMesh = new THREE.Mesh(sea.geometry(), toon({ color: PALETTE.sea }));
    seaMesh.geometry.deleteAttribute('color');
    seaMesh.userData.water = true;
    seaMesh.name = 'sea';
    seaMesh.receiveShadow = true;
    root.add(seaMesh);
    const z0 = bounds.minZ - 50 * K, z1 = bounds.maxZ + 50 * K;
    const seaCol = [[bounds.minX - 400 * K, z0], [coastXAt(coast, z0) ?? first[0], z0],
      ...coast.filter((p) => p[1] > z0 && p[1] < z1), [coastXAt(coast, z1) ?? last[0], z1], [bounds.minX - 400 * K, z1]];
    colliders.push({ kind: 'sea', points: seaCol });
  }

  // ---- ground cover layers ----
  const ground = new Acc();
  const grassC = col(PALETTE.grass), parkC = col(PALETTE.park), woodC = col(PALETTE.wood), pitchC = col(PALETTE.pitch), sandC = col(PALETTE.sand);
  // Landmarks draw their own lakes, parks and lawns inside their footprints; skipping ours there
  // avoids drawing the Superland lake twice and z-fighting with the landmark ground.
  const ownedByLandmark = (r) => excl.length > 0 && excluded(...centroid(r));
  const fill = terrain ? (acc, r, y, c, skip) => fillPolyDense(acc, r, y, c, 16, skip) : fillPoly;
  // Sand wins over grass: both drape the dunes 0.02 apart and the grass showed through the beach
  // in shards. Grass, park, wood and pitch triangles whose centre lies on a beach are left out.
  const beaches = (data.beach || []).map(ring).filter((r) => r.length >= 3).map((r) => ({ r, bb: bbox(r) }));
  const onBeach = (x, z) => beaches.some(({ r, bb }) => x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ && inPoly(x, z, r));
  const cover = (list, y, c) => {
    for (const f of list) {
      const r = ring(f);
      if (ownedByLandmark(r)) continue;
      const bb = bbox(r), near = beaches.some((b) => b.bb.minX <= bb.maxX && b.bb.maxX >= bb.minX && b.bb.minZ <= bb.maxZ && b.bb.maxZ >= bb.minZ);
      fill(ground, r, y, c, near ? onBeach : null);
    }
  };
  cover(data.grass, Y.grass, grassC);
  cover(data.parks.map(([, f]) => f), Y.grass + 0.01, parkC);
  cover(data.woods, Y.grass + 0.015, woodC);
  for (const f of data.beach) fill(ground, ring(f), Y.beach, sandC);
  cover(data.pitches, Y.pitch, pitchC);
  const groundMesh = new THREE.Mesh(ground.geometry(true), layerMat(1));
  groundMesh.receiveShadow = true;
  groundMesh.name = 'ground-cover';
  root.add(groundMesh);

  const water = buildWater(data, { ownedByLandmark, colliders, root, flatMat, toon });

  // ---- buildings: buildings.js owns them; the built-in blocks are the fallback ----
  const tBld = performance.now();
  let buildingStats = { source: 'buildings.js', count: 0 };
  let usedModule = false;
  try {
    const mod = await import('./buildings.js');
    if (typeof mod.buildBuildings === 'function') {
      const r = await mod.buildBuildings(scene, data, { exclude, project });
      if (r) {
        for (const c of r.colliders || []) colliders.push(c);
        if (r.group && !r.group.parent) root.add(r.group);
        usedModule = true;
        buildingStats.count = (r.colliders || []).length;
      }
    }
  } catch (e) {
    console.warn('[city] buildings.js unavailable, using built-in buildings', e);
  }
  if (!usedModule) {
    const wallMat = toon({ vertexColors: true, map: windowTexture(), side: THREE.DoubleSide });
    const roofMat = toon({ vertexColors: true });
    const r = fallbackBuildings(data, { root, colliders, excl, excluded, inRishon, K, K2, wallMat, roofMat, propMat });
    buildingStats = { source: 'fallback', count: r.built, excluded: r.skipped };
  }

  performance.measure?.('boot:city/buildings', { start: tBld, end: performance.now() });
  // Spatial hash of building footprints and lakes so nothing sprouts through roofs or water.
  const CELL = 25 * K, grid = new Map();
  const cellKey = (i, j) => i * 100003 + j;
  for (const c of colliders) {
    if (c.kind !== 'building' && c.kind !== 'water') continue;
    if (!c.points || c.points.length < 3) continue;
    const bb = bbox(c.points);
    for (let i = Math.floor(bb.minX / CELL); i <= Math.floor(bb.maxX / CELL); i++)
      for (let j = Math.floor(bb.minZ / CELL); j <= Math.floor(bb.maxZ / CELL); j++) {
        const k = cellKey(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(c);
      }
  }
  const blockedBy = (x, z, kind) => {
    const list = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
    return !!list && list.some((c) => (!kind || c.kind === kind) && inPoly(x, z, c.points));
  };
  const inBuilding = (x, z) => blockedBy(x, z, 'building');

  const platforms = (data.platforms || []).map(ring).filter((r) => r.length >= 3);

  // ---- roads, sidewalks, bridges, rail ----
  const layers = {
    paths: new Layer('paths', layerMat(3)), asphalt: new Layer('asphalt', layerMat(4)),
    marks: new Layer('marks', layerMat(6)), solid: new Layer('solid', toon({ vertexColors: true }), true),
  };
  const tNet = performance.now();
  const net = buildNetwork(data, { coast, inBuilding, colliders, layers, K, platforms, terrain, waterTop: water.topAt });
  const netMs = Math.round(performance.now() - tNet);
  performance.measure?.('boot:city/network', { start: tNet, end: performance.now() });
  if (cuts && cuts.list.length) buildTrench(layers, colliders, cuts);
  // Footprints OSM draws under a raised way (a footbridge or a station concourse over a small
  // building) blocked walkers on the deck above at any height: buildings a raised way passes
  // over get a vertical extent (ground to roof), so only movers below the roof bump into them.
  {
    const up = new SegGrid(25);
    for (const r of net.roads) {
      if (!r.heights || r.tunnel) continue;
      for (let i = 0; i < r.points.length - 1; i++) if (r.heights[i] > 2 || r.heights[i + 1] > 2) up.add(mkSeg(r.points[i], r.points[i + 1], { y0: r.surface ? r.surface[i] : null, y1: r.surface ? r.surface[i + 1] : null }), 2);
    }
    let banded = 0;
    for (const c of colliders) {
      if (c.kind !== 'building' || c.y1 != null || !Number.isFinite(c.height) || !c.points || c.points.length < 3) continue;
      const bb = bbox(c.points);
      let hit = false, over = false;
      up.each(bb.minX, bb.minZ, bb.maxX, bb.maxZ, (sg) => {
        for (let t = 0; t <= 1.001; t += 0.125) {
          const x = sg.ax + (sg.bx - sg.ax) * t, z = sg.az + (sg.bz - sg.az) * t;
          if (x < bb.minX - 1 || x > bb.maxX + 1 || z < bb.minZ - 1 || z > bb.maxZ + 1 || !inPoly(x, z, c.points)) continue;
          hit = true;
          // Only a deck that clears the roof: a garage ramp running into a building stays blocked.
          if (sg.y0 != null && sg.y0 + (sg.y1 - sg.y0) * t > c.height + 0.5) over = true;
        }
        return !over;
      });
      if (!hit) continue;
      c.under = true;
      if (!over) continue;
      c.y0 = (Number.isFinite(c.base) ? c.base : groundAt(...centroid(c.points))) - 0.5;
      c.y1 = c.height;
      banded++;
    }
    // A small footprint under a deck that OSM footways or steps run into is a stair or
    // lift house (the one under the Moshe Dayan station bridge, 28 x 13 u): it keeps its walls
    // but loses the collider, so the station paths through it stay walkable.
    const paths = new SegGrid(25);
    for (const r of net.roads) if (PATH[r.kind] && !r.tunnel) for (let i = 0; i < r.points.length - 1; i++) paths.add(mkSeg(r.points[i], r.points[i + 1], {}), 1);
    let opened = 0;
    for (let ci = colliders.length - 1; ci >= 0; ci--) {
      const c = colliders[ci];
      if (c.kind !== 'building' || !c.under || !c.points || Math.abs(signedArea(c.points)) > 600) continue;
      const bb = bbox(c.points);
      let inside = false;
      paths.each(bb.minX, bb.minZ, bb.maxX, bb.maxZ, (sg) => {
        for (let t = 0; t <= 1.001 && !inside; t += 0.1) if (inPoly(sg.ax + (sg.bx - sg.ax) * t, sg.az + (sg.bz - sg.az) * t, c.points)) inside = true;
        return !inside;
      });
      if (inside) { colliders.splice(ci, 1); opened++; }
    }
    net.prof.bandedBuildings = banded;
    net.prof.openedBuildings = opened;
  }
  const waterOpened = water.openUnder(net.roads);
  // Raised station platforms.
  for (const [pi, p] of platforms.entries()) {
    if (net.platformHandled.has(pi)) continue;
    const acc = layers.solid.at(...centroid(p));
    fillPoly(acc, p, 1.0, col(PALETTE.platform));
    const [pcx, pcz] = centroid(p);
    for (let i = 0; i < p.length; i++) {
      const a = p[i], c = p[(i + 1) % p.length];
      acc.quad([a[0], 0, a[1]], [c[0], 0, c[1]], [c[0], 1.0, c[1]], [a[0], 1.0, a[1]], col(PALETTE.platformSide), [(a[0] + c[0]) / 2 - pcx, 0, (a[1] + c[1]) / 2 - pcz]);
    }
  }
  const roadChunks = new Map();
  let roadTris = 0;
  for (const layer of Object.values(layers)) {
    for (const [key, acc] of layer.map) {
      if (acc.empty) continue;
      let g = roadChunks.get(key);
      if (!g) { g = new THREE.Group(); g.name = `roads ${key}`; roadChunks.set(key, g); root.add(g); }
      const m = new THREE.Mesh(acc.geometry(terrain), layer.mat);
      m.name = layer.name;
      m.receiveShadow = true;
      m.castShadow = layer.shadows;
      roadTris += acc.p.length / 9;
      g.add(m);
    }
  }

  // Trees come only from src/world/trees.js (OSM natural=tree / tree_row / wood / park data);
  // the procedural scattering over parks, lawns and woods that used to live here was removed
  // (founder, round 3: too many random trees).
  const blocked = (x, z) => blockedBy(x, z) || net.onCarriage(x, z, SW + 1.5);
  const trees = 0, palms = 0;

  // ---- places and neighbourhood signs ----
  const places = (data.places || []).map(([kind, nameLocal, nameEn, x, z]) => ({ kind, name: nameEn || nameLocal, nameLocal, x, z, inRishon: inRishon(x, z) }));
  const carRoads = net.cars.filter((w) => w.rank >= 2).map((w) => ({ points: w.pts, width: w.w }));
  const signs = buildNeighbourhoodSigns(places.filter((p) => p.inRishon), carRoads, blocked, K, toon);
  if (signs) root.add(signs.group);
  const streetSignGroup = buildStreetSigns(net.streetSigns || [], toon);
  if (streetSignGroup) root.add(streetSignGroup);
  const junctions = (data.junctions || []).map(([kind, nameEn, nameLocal, x, z]) => ({ kind, name: nameEn || nameLocal, nameLocal, x, z }));

  root.userData.stats = {
    buildings: buildingStats.count, buildingSource: buildingStats.source, roads: net.roads.length,
    sidewalks: net.sidewalks.length, busStops: net.busStops.length, junctions: net.junctions,
    crossings: net.crossings.length, medians: net.medians.length, trees, palms, roadChunks: roadChunks.size,
    roadTris: Math.round(roadTris), water: { bodies: water.bodies, opened: waterOpened }, ramps: net.rampStats, networkMs: netMs, networkProfile: net.prof, heaters: 0, balconies: 0, chunks: roadChunks.size,
  };
  root.userData.attribution = ATTRIBUTION;

  const spawn = data.spawn && Number.isFinite(data.spawn.x) ? { x: data.spawn.x, z: data.spawn.z } : { x: 0, z: 0 };
  // Extras beyond the contract: medians (planted strips and roundabout islands), crossings
  // (zebra centres), junctions (named interchanges), signs (placed boards), onCarriage(x, z, margin).
  return {
    colliders, spawn, bounds, group: root,
    roads: net.roads, sidewalks: net.sidewalks, busStops: net.busStops, places, heightAt: net.heightAt,
    medians: net.medians, crossings: net.crossings, junctions, signs: signs ? signs.places : [], onCarriage: net.onCarriage,
    // Station platforms: platformAt(x, z) -> walkable platform top or null; stationStairs: flights
    // from a bridge sidewalk down to a platform ({ station, top, edge, bottom: [x, y, z], width, dir }).
    platformAt: net.platformAt, stationStairs: net.stationStairs,
    // Side platforms built where OSM has none (HaRishonim): { station, side, axis: [[x, z]],
    // top: [y] per axis point (walkable surface), width }.
    sidePlatforms: net.sidePlatforms,
    // Junction control from OSM: { kind: 'signals' | 'crossing' | 'mini', x, z } (traffic_signals,
    // crossing=traffic_signals and mini_roundabout nodes). Traffic lights go only near these.
    signals: (data.signals || []).map(([kind, x, z]) => ({ kind, x, z })),
    // Street-name signs placed at junction corners: { x, z, rot, name (OSM local), nameEn }.
    streetSigns: net.streetSigns,
    // Ground-level junction nodes and roundabout rings (outer radius) for traffic-light placement.
    junctionNodes: net.junctionNodes, rings: net.rings,
    // Walkable footbridges (OSM bridge footways, paths, cycleways and steps that stand above the
    // ground): { kind, points: [[x, z]], surface: [y] walkable top per point, width, layer,
    // overWater (over water city.js draws), arch (short bridge over something a landmark draws,
    // e.g. the Gan HaIr pond) }. Landmarks that own the water under them can dress them.
    footbridges: net.roads.filter((r) => PATH[r.kind] && r.kind !== 'promenade' && r.bridge && r.surface)
      .map((r) => ({ kind: r.kind, points: r.points, surface: r.surface, width: r.width, layer: r.layer || 0, overWater: !!r.overWater, arch: !!r.arch })),
  };
}
