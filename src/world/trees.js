// Trees from the map, and only from the map (founder, round 3: "only where you actually see in the
// map that there are trees"). Source: data/rishon.trees.json, baked by tools/fetch_osm_trees.py.
//
//  - natural=tree nodes: one tree each, where it is mapped. A node that lands on a carriageway or
//    in the middle of a sidewalk (OSM is a few metres off) is moved to the kerb-side tree line of
//    the nearest sidewalk, which keeps the walking line clear.
//  - natural=tree_row ways: trees along the row at street-tree spacing, same snapping.
//  - natural=wood / landuse=forest: filled at a stand density for the land cover (open pine
//    woodland). A thin wood strip beside a grove or a field is a windbreak: one or two tight rows
//    of cypress (narrow strips) or eucalyptus (wide strips) down its middle, as planted.
//  - landuse=orchard (the pardesim toward Nes Ziona): citrus in a regular grid that follows the
//    grove's own edges, 6 m between rows and 4 m in the row, a dirt headland inside the boundary
//    and, in big groves, a dirt track every 14 rows and every ~110 m across, like real blocks.
//    landuse=plant_nursery: saplings in tight rows.
//  - landuse=farmland / farmyard: no trees (none are mapped there); their ground is drawn as
//    ploughed fields and packed-earth yards, and their edges tell windbreaks from town woods.
//  - leisure=park / garden: a modest scatter only, in groves along the park edge and its paths,
//    never on mapped playgrounds, pitches, water, sand, parking or the middle of open lawns, and
//    none at all where mappers already drew the park's trees one by one.
// Nothing stands on a carriageway, a footpath, a building, water, rail, under a bridge deck, on a
// parking stall or inside a landmark (landmarks plant their own).
//
// Species come from species/genus/leaf_type tags; untagged trees take the local default: pines
// in woods and near the dunes, ficus/jacaranda/poinciana in streets and parks. Palms appear only
// where OSM says Phoenix/Washingtonia, or for an untagged tree_row on a boulevard or the promenade.
//
// Rendering: one InstancedMesh per species per chunk and LOD level (full model near, a 10-20
// triangle stand-in far), MeshToonMaterial, distance culling on the scene's render hook. Grove
// trees switch earlier: beyond GROVE_NEAR each grove row is drawn as one low hedge strip, which is
// how a citrus row reads from a distance anyway and keeps tens of thousands of trees cheap.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SCALE } from '../geo.js';

const DATA_URL = new URL('../../data/rishon.trees.json', import.meta.url);

const CHUNK = 320;
const NEAR = 420;   // full model within this distance of the camera (plus the chunk radius)
const FAR = 1350;   // stand-in model up to here; beyond, the chunk's trees are hidden
const SIDE_TOP = 0.42; // sidewalk top above the ground, as built by city.js
const U_PER_M_HEIGHT = 1.3; // tree heights: a storey is 4 u, so ~1.3 u per real metre

// Stand densities (world units between trunks). Trees are modelled against the ~5 u avatar, so
// these read as an open Mediterranean pine wood and a planted orchard, not a jungle.
const SPACING = { forest: 11, wood: 12 };
// Groves in world units (1.2 u per metre): rows 6 m apart, trees 4 m apart in the row, a 3 m dirt
// headland inside the boundary, a 3.5 m track every 14 rows and every ~110 m across big groves.
const GROVE = { row: 7.2, step: 4.8, headland: 3.6, margin: 2.0, blockRows: 14, blockLen: 132, track: 4.2, bigArea: 20000 };
const NURSERY = { row: 2.6, step: 1.9, headland: 1.8, margin: 0.6, blockRows: 0, scale: 0.42 };
const GROVE_NEAR = 240;   // individual grove trees within this distance (plus the chunk radius)
const GROVE_RUN = 30;     // a grove row is cut into hedge/collider pieces of at most this length
// Windbreaks: a wood strip narrower than this (u) and at least 3x as long, within FARM_NEAR of a
// grove or field. Below WB_NARROW it is a single cypress row, wider ones are eucalyptus.
const WB_MAX_W = 30, WB_NARROW = 13, FARM_NEAR = 40;
const WB_STEP = { cypress: 3.6, eucalyptus: 6 };
const ROW_STEP = { palm: 9, default: 10 };
const PARK_AREA_PER_TREE = 1100; // modest: at most one scattered tree per ~760 m2 of park
const PARK_GROVE_SCALE = 70;      // groves: value noise at this wavelength decides where they cluster

const PATH_KINDS = /^(footway|path|pedestrian|cycleway|steps|sidewalk|promenade|track)$/;
const BOULEVARD = /^(trunk|primary)(_link)?$/;
// Open ground inside parks where no tree grows. Lawns (grass/meadow) only keep their middles open.
const OPEN_HARD = new Set(['playground', 'pitch', 'track', 'dog_park', 'swimming_pool', 'sports_centre', 'water', 'wetland', 'sand', 'beach', 'parking']);
const OPEN_LAWN = new Set(['grass', 'meadow', 'grassland']);
const LAWN_EDGE = 6; // a lawn keeps trees only within this distance of its edge

const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) >>> 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d) >>> 0; n ^= n >>> 15; return (n >>> 0) / 4294967296; };
const hxz = (x, z, s = 0) => hash((Math.round(x * 7) * 73856093) ^ (Math.round(z * 7) * 19349663) ^ (s * 83492791));
const lerp = (a, b, t) => a + (b - a) * t;
function noise2(x, z) {
  const fx = x / PARK_GROVE_SCALE, fz = z / PARK_GROVE_SCALE;
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const s = (t) => t * t * (3 - 2 * t);
  const h = (a, b) => hash((a * 73856093) ^ (b * 19349663) ^ 0x5bd1e995);
  return lerp(lerp(h(i, j), h(i + 1, j), s(u)), lerp(h(i, j + 1), h(i + 1, j + 1), s(u)), s(v));
}

// ---------- templates ----------

function paint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
const box = (w, h, d, x, y, z, hex) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
const cyl = (r0, r1, h, x, y, z, hex, seg = 6) => paint(new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z), hex);
const blob = (r, x, y, z, hex, sy = 1) => paint(new THREE.IcosahedronGeometry(r, 0).scale(1, sy, 1).translate(x, y, z), hex);
const merge = (parts) => { const g = mergeGeometries(parts); g.computeVertexNormals(); g.computeBoundingSphere(); return g; };

// Full models, origin at the foot, sized against the ~5 u avatar (street crowns start above it).
const NEAR_TPL = {
  ficus: () => merge([
    cyl(0.34, 0.5, 6.6, 0, 3.3, 0, 0x8b7d6b), cyl(0.15, 0.22, 2.4, 0.7, 6.8, 0.2, 0x8b7d6b),
    blob(3.3, 0, 9.4, 0, 0x3e8a3a, 0.85), blob(2.4, 1.8, 8.7, 0.7, 0x4a9a43, 0.85),
    blob(2.3, -1.6, 8.9, -0.9, 0x357d33, 0.85), blob(2.0, 0.3, 11.1, -0.6, 0x4fa548, 0.85),
  ]),
  jacaranda: () => merge([
    cyl(0.25, 0.36, 6.8, 0, 3.4, 0, 0x7d6f60),
    cyl(0.12, 0.16, 2.6, 0.9, 7.4, 0, 0x7d6f60), cyl(0.12, 0.16, 2.6, -0.8, 7.5, 0.3, 0x7d6f60),
    blob(3.0, 0, 9.3, 0, 0x9b7fd4, 0.55), blob(2.2, 2.0, 8.9, 0.6, 0xb59ae8, 0.6),
    blob(2.2, -1.9, 9.0, -0.5, 0x8a6fc6, 0.6), blob(1.6, 0.4, 8.5, 1.8, 0x6aa84a, 0.6),
  ]),
  poinciana: () => merge([
    cyl(0.3, 0.42, 6.2, 0, 3.1, 0, 0x857565),
    cyl(0.14, 0.18, 2.8, 1.1, 6.8, 0, 0x857565), cyl(0.14, 0.18, 2.8, -1.1, 6.8, 0, 0x857565),
    blob(3.6, 0, 8.3, 0, 0xe5532d, 0.42), blob(2.4, 2.4, 8.1, 0.4, 0xf06b33, 0.45),
    blob(2.2, -2.3, 8.2, -0.3, 0x5c9e3f, 0.45), blob(1.8, 0.2, 9.1, -1.4, 0xd8452a, 0.45),
  ]),
  broad: () => merge([
    cyl(0.3, 0.44, 5.6, 0, 2.8, 0, 0x7f6a55),
    blob(3.0, 0, 8.0, 0, 0x6dbb4a, 0.8), blob(2.1, 1.5, 7.2, 0.8, 0x5aa83f, 0.8), blob(1.9, -1.3, 9.0, -0.4, 0x86c95a, 0.8),
  ]),
  pine: () => merge([
    // Aleppo pine: tall bare trunk with a slight lean, flat irregular dark crown.
    cyl(0.28, 0.46, 8.4, 0, 4.2, 0, 0x6e5844).rotateZ(0.05),
    cyl(0.12, 0.18, 3.0, 0.9, 8.4, 0.2, 0x6e5844),
    blob(2.9, 0.4, 10.2, 0, 0x2f6b3a, 0.5), blob(2.2, 2.2, 9.4, 0.8, 0x3a7a42, 0.5),
    blob(2.1, -1.6, 9.7, -0.9, 0x2a6135, 0.5), blob(1.6, 0.6, 11.4, -0.4, 0x3f8448, 0.5),
  ]),
  eucalyptus: () => merge([
    cyl(0.3, 0.5, 11, 0, 5.5, 0, 0xd9d2c0), cyl(0.12, 0.18, 3.6, 1.0, 10.2, 0, 0xd9d2c0),
    blob(2.6, 0.5, 13.0, 0, 0x7fa38a, 0.85), blob(2.0, 2.0, 11.4, 0.6, 0x8db397, 0.8),
    blob(1.9, -1.4, 12.0, -0.7, 0x6f9579, 0.85),
  ]),
  cypress: () => merge([cyl(0.25, 0.3, 1.6, 0, 0.8, 0, 0x6e5844), blob(1.6, 0, 6.2, 0, 0x2e5e36, 3.2)]),
  // Grove citrus: a lean version (~44 triangles) because a grove has thousands of them.
  grove: () => merge([
    paint(new THREE.CylinderGeometry(0.16, 0.24, 1.4, 4, 1, true).translate(0, 0.7, 0), 0x6d5a45),
    blob(2.25, 0, 2.85, 0, 0x37803a, 0.86),
    paint(new THREE.OctahedronGeometry(0.34, 0).translate(1.75, 2.6, 0.7), 0xf0a028),
    paint(new THREE.OctahedronGeometry(0.34, 0).translate(-0.9, 3.4, -1.5), 0xe8b030),
  ]),
  citrus: () => merge([
    cyl(0.16, 0.24, 1.6, 0, 0.8, 0, 0x6d5a45), blob(2.3, 0, 2.9, 0, 0x3f8a3a, 0.85),
    blob(0.32, 1.9, 2.8, 0.5, 0xf39a2b), blob(0.32, -1.2, 3.4, 1.5, 0xf39a2b), blob(0.32, 0.4, 2.4, -2.0, 0xf39a2b),
  ]),
  olive: () => merge([
    cyl(0.22, 0.36, 2.4, 0, 1.2, 0, 0x7a6a55).rotateZ(0.12),
    blob(2.5, 0.3, 3.6, 0, 0x8fa88a, 0.7), blob(1.7, -1.4, 3.2, 0.6, 0x9db797, 0.7),
  ]),
  palm: () => palmTemplate(false),
  datePalm: () => palmTemplate(true),
  pit: () => merge([box(1.9, 0.1, 1.9, 0, 0.05, 0, 0x6b5640)]),
};

function palmTemplate(date) {
  // Washingtonia (tall, thin) for boulevards; date palm (stockier, arched fronds) for the beach.
  const H = date ? 9 : 13.5, r0 = date ? 0.7 : 0.55, r1 = date ? 0.55 : 0.38;
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const a = i / 5, b = (i + 1) / 5;
    parts.push(cyl(r1 + (r0 - r1) * (1 - b), r1 + (r0 - r1) * (1 - a), H / 5, 0, H * (a + b) / 2, 0, i % 2 ? 0x9b8463 : 0x8a7456, 7));
  }
  parts.push(cyl(r1 + 0.25, r1 + 0.05, 1.0, 0, H - 0.3, 0, 0x7a6a4c));
  const n = date ? 11 : 9, len = date ? 5.2 : 4.3;
  for (let k = 0; k < n; k++) {
    const droop = (date ? 0.55 : 0.35) + (k % 3) * 0.12;
    const g = new THREE.BoxGeometry(date ? 1.0 : 1.1, 0.08, len).translate(0, 0, len / 2).rotateX(droop).rotateY((k / n) * Math.PI * 2 + (k % 2) * 0.2).translate(0, H, 0);
    parts.push(paint(g, k % 2 ? 0x4f9a3c : 0x66ad45));
  }
  if (date) for (let k = 0; k < 3; k++) parts.push(blob(0.45, Math.cos(k * 2.1) * 0.7, H - 0.9, Math.sin(k * 2.1) * 0.7, 0xe08a2e));
  return merge(parts);
}

// Far stand-ins: a box trunk and one octahedron crown (12-20 triangles), same silhouette and colour.
const FAR_SPEC = {
  ficus: [6.8, 0x8b7d6b, 3.9, 9.6, 0.8, 0x3e8a3a], jacaranda: [6.8, 0x7d6f60, 3.8, 9.1, 0.5, 0x9b7fd4],
  poinciana: [6.2, 0x857565, 4.3, 8.3, 0.4, 0xe5532d], broad: [5.6, 0x7f6a55, 3.3, 8.0, 0.8, 0x6dbb4a],
  pine: [8.4, 0x6e5844, 3.6, 10.0, 0.5, 0x2f6b3a], eucalyptus: [11, 0xd9d2c0, 3.0, 12.6, 0.85, 0x7fa38a],
  cypress: [1.6, 0x6e5844, 1.7, 6.2, 3.2, 0x2e5e36], citrus: [1.6, 0x6d5a45, 2.4, 2.9, 0.85, 0x3f8a3a],
  olive: [2.4, 0x7a6a55, 2.6, 3.6, 0.7, 0x8fa88a], palm: [13.5, 0x9b8463, 3.8, 13.6, 0.25, 0x4f9a3c],
  datePalm: [9, 0x9b8463, 4.4, 8.9, 0.35, 0x4f9a3c],
};
function farTemplate(sp) {
  const [th, tc, cr, cy, sy, cc] = FAR_SPEC[sp];
  return merge([box(0.7, th, 0.7, 0, th / 2, 0, tc), paint(new THREE.OctahedronGeometry(cr, 0).scale(1, sy, 1).translate(0, cy, 0), cc)]);
}
// Template heights for the OSM height tag (u), and trunk collider half-sizes.
const TPL_H = { grove: 4.8, ficus: 12.5, jacaranda: 11, poinciana: 9.8, broad: 10.5, pine: 12, eucalyptus: 15, cypress: 11.3, citrus: 4.8, olive: 5.3, palm: 14, datePalm: 10.5 };
const TRUNK = { grove: 0.3, citrus: 0.3, olive: 0.4, cypress: 0.4, palm: 0.45, datePalm: 0.55 };

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
const ring = (f, k = 1) => { const r = []; for (let i = 0; i + 1 < f.length; i += 2) r.push([f[i] * k, f[i + 1] * k]); return r; };
function area(r) { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(s / 2); }
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t, qz = az + dz * t;
  return { d: Math.hypot(x - qx, z - qz), qx, qz, t };
}
function edgeDist(x, z, r) {
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) best = Math.min(best, segDist(x, z, r[j][0], r[j][1], r[i][0], r[i][1]).d);
  return best;
}
// Points every `step` along a polyline: [x, z, dirX, dirZ].
function* along(pts, step, start = step / 2) {
  let carry = start;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], sl = Math.hypot(dx, dz);
    if (sl < 1e-3) continue;
    let t = carry;
    while (t < sl) { yield [a[0] + (dx * t) / sl, a[1] + (dz * t) / sl, dx / sl, dz / sl]; t += step; }
    carry = t - sl;
  }
}

// Uniform grid of items with bounding boxes, for point queries.
class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 100003 + j; }
  add(item, minX, minZ, maxX, maxZ) {
    const c = this.cell;
    for (let i = Math.floor(minX / c); i <= Math.floor(maxX / c); i++)
      for (let j = Math.floor(minZ / c); j <= Math.floor(maxZ / c); j++) {
        const k = this.key(i, j);
        let l = this.map.get(k);
        if (!l) this.map.set(k, (l = []));
        l.push(item);
      }
  }
  at(x, z) { return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) || []; }
  // Polygons are stored with their bounding box (grown by pad) so most tests stop at the box.
  addPoly(r, pad = 0) {
    const bb = bbox(r);
    const P = { r, minX: bb.minX - pad, maxX: bb.maxX + pad, minZ: bb.minZ - pad, maxZ: bb.maxZ + pad };
    this.add(P, P.minX, P.minZ, P.maxX, P.maxZ);
    return P;
  }
}
const inBox = (P, x, z) => x >= P.minX && x <= P.maxX && z >= P.minZ && z <= P.maxZ;

// Grid direction of a grove: edges folded onto one orthogonal frame (4x angle trick, weighted by
// length), then the axis of that frame nearer the longest edge carries the rows.
function gridAngle(r) {
  let sx = 0, sz = 0, best = 0, ang = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const dx = r[i][0] - r[j][0], dz = r[i][1] - r[j][1], l = Math.hypot(dx, dz);
    if (l < 1e-3) continue;
    const th = Math.atan2(dz, dx);
    sx += l * Math.cos(4 * th); sz += l * Math.sin(4 * th);
    if (l > best) { best = l; ang = th; }
  }
  const a4 = Math.atan2(sz, sx) / 4;
  return Math.abs(Math.sin(ang - a4)) < Math.SQRT1_2 ? a4 : a4 + Math.PI / 2;
}
const signedArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return s / 2; };

// Triangle soup with position, colour and optional uv, split into tiles so the camera frustum can
// skip the parts out of view.
class Soup {
  constructor(tile = 1280) { this.tile = tile; this.tiles = new Map(); this.tris = 0; }
  bin(x, z) {
    const k = `${Math.floor(x / this.tile)},${Math.floor(z / this.tile)}`;
    let b = this.tiles.get(k);
    if (!b) this.tiles.set(k, (b = { p: [], c: [], uv: [] }));
    return b;
  }
  // a, b, c: [x, y, z]; col: THREE.Color; uv: [[u, v] x3] or null.
  tri(a, b, c, col, uv) {
    const t = this.bin((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3);
    // Wind upward so the face is front-facing from above.
    if ((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]) > 0) { [b, c] = [c, b]; if (uv) uv = [uv[0], uv[2], uv[1]]; }
    t.p.push(...a, ...b, ...c);
    t.c.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    if (uv) t.uv.push(...uv[0], ...uv[1], ...uv[2]);
    this.tris++;
  }
  // Raw triangle (already wound) for solid strips.
  raw(a, b, c, col) {
    const t = this.bin((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3);
    t.p.push(...a, ...b, ...c);
    t.c.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    this.tris++;
  }
  meshes(mat, name) {
    const out = [];
    for (const [k, b] of this.tiles) {
      if (!b.p.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
      if (b.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.name = `${name} ${k}`;
      m.receiveShadow = true;
      out.push(m);
    }
    return out;
  }
}

// Ground textures, drawn once on a small canvas. Grove soil: hamra (red-brown sandy loam) with a
// darker shaded band under each tree line; fields: ploughed furrows. Both tile along the rows.
function stripeTexture(bands) {
  const W = 64, H = 64;
  let tex = null;
  try {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    for (const [v0, v1, hex] of bands) { g.fillStyle = hex; g.fillRect(0, Math.round(v0 * H), W, Math.ceil((v1 - v0) * H)); }
    // Clods and pebbles so the soil does not read as flat paint up close.
    for (let i = 0; i < 260; i++) {
      const h = hash(i * 7919 + 17), x = Math.floor(hash(i * 104729 + 3) * W), y = Math.floor(hash(i * 1299709 + 5) * H);
      g.fillStyle = h < 0.5 ? 'rgba(60,35,20,0.18)' : 'rgba(255,240,215,0.16)';
      g.fillRect(x, y, 1 + Math.floor(h * 2), 1);
    }
    tex = new THREE.CanvasTexture(cv);
  } catch (e) {
    return null; // no DOM (node tools): untextured ground
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------- data ----------

export async function loadTrees(url = DATA_URL) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[trees] no tree data', e);
    return null;
  }
}

// ---------- main ----------

// opts: { lots } parking lots from buildParking (stalls stay clear), { exclude } landmark
// footprints (defaults to LANDMARK_FOOTPRINTS).
export async function buildTrees(scene, city, data, opts = {}) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'trees';
  scene.add(group);
  const colliders = [];
  const stats = { nodes: 0, rows: 0, woods: 0, parks: 0, groves: 0, nursery: 0, windbreaks: 0, total: 0, species: {}, snapped: 0, nudged: 0, dropped: {} };
  const result = { group, colliders, stats, points: [] };
  if (data === undefined || data === null) data = await loadTrees();
  if (!data || !data.meta) { console.warn('[trees] no data/rishon.trees.json; no trees'); return result; }
  const k = data.meta.scale ? SCALE / data.meta.scale : 1;
  const phaseMs = {};
  let tLap = performance.now();
  const lap = (name) => { const t = performance.now(); phaseMs[name] = Math.round(t - tLap); tLap = t; };
  const drop = (why) => { stats.dropped[why] = (stats.dropped[why] || 0) + 1; return null; };

  // ---- ground ----
  let groundAt = null;
  try {
    const tm = await import('./terrain.js');
    if (typeof tm.groundAt === 'function' && (!tm.terrainLoaded || tm.terrainLoaded())) groundAt = tm.groundAt;
  } catch (e) { /* flat world */ }
  const ground = (x, z) => {
    let y = 0;
    try { y = groundAt ? groundAt(x, z) : city && city.heightAt ? city.heightAt(x, z, 0) : 0; } catch (e) { y = 0; }
    return Number.isFinite(y) ? y : 0;
  };
  // Something raised (a bridge deck or ramp) over this spot: no tree grows under it.
  const underDeck = (x, z) => {
    if (!city || typeof city.heightAt !== 'function') return false;
    try { return city.heightAt(x, z, 1e4) > ground(x, z) + 1.2; } catch (e) { return false; }
  };
  const onCarriage = (x, z, m) => { try { return !!(city && city.onCarriage && city.onCarriage(x, z, m)); } catch (e) { return false; } };

  // ---- solids: buildings, water, sea, walls, pillars, fences; landmark sites ----
  const solidGrid = new Grid(50);
  for (const c of (city && city.colliders) || []) {
    if (!c || !c.points || c.points.length < 3 || c.kind === 'prop') continue;
    solidGrid.addPoly(c.points);
  }
  let exclude = opts.exclude;
  if (!exclude) {
    try { exclude = (await import('./landmarks.js')).LANDMARK_FOOTPRINTS || []; } catch (e) { exclude = []; }
  }
  const siteGrid = new Grid(100);
  for (const e of exclude) {
    const r = Array.isArray(e) ? e : e && e.points;
    if (!r || r.length < 3) continue;
    siteGrid.addPoly(r);
  }
  const inAny = (grid, x, z) => grid.at(x, z).some((P) => inBox(P, x, z) && inPoly(x, z, P.r));
  const inSolid = (x, z, r = 0) => inAny(solidGrid, x, z) || (r > 0 && (inAny(solidGrid, x + r, z) || inAny(solidGrid, x - r, z) || inAny(solidGrid, x, z + r) || inAny(solidGrid, x, z - r)));

  // ---- parking stalls ----
  const stallGrid = new Grid(24);
  for (const lot of opts.lots || []) for (const s of lot.stalls || []) {
    let c = s.corners;
    if (!c && Number.isFinite(s.x)) {
      const ca = Math.cos(s.angle || 0), sa = Math.sin(s.angle || 0), hw = (s.w || 2.5) / 2, hl = (s.l || 5) / 2;
      c = [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]].map(([a, b]) => [s.x + a * ca + b * sa, s.z - a * sa + b * ca]);
    }
    if (!c || c.length < 3) continue;
    stallGrid.addPoly(c, 0.6);
  }
  const onStall = (x, z) => stallGrid.at(x, z).some((P) => inBox(P, x, z) && (inPoly(x, z, P.r) || edgeDist(x, z, P.r) < 0.6));

  // ---- sidewalks and paths (walking lines) ----
  const walkGrid = new Grid(32);
  for (const [wi, w] of ((city && city.sidewalks) || []).entries()) {
    const p = w.points;
    if (!p || p.length < 2) continue;
    const hw = (w.width || 4) / 2;
    for (let i = 0; i < p.length - 1; i++) {
      const s = { ax: p[i][0], az: p[i][1], bx: p[i + 1][0], bz: p[i + 1][1], hw, wi, prom: w.roadKind === 'promenade' };
      s.len = Math.hypot(s.bx - s.ax, s.bz - s.az);
      if (s.len < 1e-3) continue;
      walkGrid.add(s, Math.min(s.ax, s.bx) - hw - 8, Math.min(s.az, s.bz) - hw - 8, Math.max(s.ax, s.bx) + hw + 8, Math.max(s.az, s.bz) + hw + 8);
    }
  }
  const pathGrid = new Grid(32), boulevardGrid = new Grid(48), promGrid = new Grid(48), carGrid = new Grid(32);
  for (const rd of (city && city.roads) || []) {
    const p = rd.points, kind = rd.kind || '';
    if (!p || p.length < 2 || rd.tunnel) continue;
    const hw = (rd.width || 3) / 2;
    const isPath = PATH_KINDS.test(kind), isBlvd = BOULEVARD.test(kind), isProm = kind === 'promenade';
    const isCar = !isPath && !/rail|tram|platform/.test(kind);
    if (!isPath && !isBlvd && !isCar) continue;
    for (let i = 0; i < p.length - 1; i++) {
      const s = { ax: p[i][0], az: p[i][1], bx: p[i + 1][0], bz: p[i + 1][1], hw };
      s.len = Math.hypot(s.bx - s.ax, s.bz - s.az);
      if (s.len < 1e-3) continue;
      // Near pad for the point tests, far pad for "which boulevard/promenade does this row line".
      const padBox = (pad) => [Math.min(s.ax, s.bx) - pad, Math.min(s.az, s.bz) - pad, Math.max(s.ax, s.bx) + pad, Math.max(s.az, s.bz) + pad];
      if (isPath) pathGrid.add(s, ...padBox(hw + 4));
      if (isCar && !rd.bridge) carGrid.add(s, ...padBox(hw + 4));
      if (isBlvd) boulevardGrid.add(s, ...padBox(hw + 30));
      if (isProm) promGrid.add(s, ...padBox(hw + 40));
    }
  }
  const nearestSeg = (grid, x, z, maxD) => {
    let best = null;
    for (const s of grid.at(x, z)) {
      const r = segDist(x, z, s.ax, s.az, s.bx, s.bz);
      if (r.d < maxD && (!best || r.d < best.r.d)) best = { s, r };
    }
    return best;
  };
  const onPath = (x, z, m) => {
    for (const s of pathGrid.at(x, z)) if (segDist(x, z, s.ax, s.az, s.bx, s.bz).d < s.hw + m) return s;
    return null;
  };

  // ---- open ground (playgrounds, pitches, lawns, water, sand, parking) ----
  const openGrid = new Grid(64), lawnGrid = new Grid(64), sandGrid = new Grid(250);
  for (const [kind, f] of data.open || []) {
    const r = ring(f, k);
    if (r.length < 3) continue;
    const bb = bbox(r);
    if (OPEN_HARD.has(kind)) openGrid.addPoly(r, 1.5);
    else if (OPEN_LAWN.has(kind)) lawnGrid.addPoly(r);
    if (kind === 'sand' || kind === 'beach') sandGrid.add(r, bb.minX - 200, bb.minZ - 200, bb.maxX + 200, bb.maxZ + 200);
  }
  const onOpen = (x, z) => openGrid.at(x, z).some((P) => inBox(P, x, z) && (inPoly(x, z, P.r) || edgeDist(x, z, P.r) < 1.5));
  const midLawn = (x, z) => lawnGrid.at(x, z).some((P) => inBox(P, x, z) && inPoly(x, z, P.r) && edgeDist(x, z, P.r) > LAWN_EDGE);
  const nearDunes = (x, z) => sandGrid.at(x, z).length > 0;

  // ---- farm land: groves, nurseries, fields and yards (windbreak context and ground) ----
  const farmGrid = new Grid(128);
  const groves = [], farms = [];
  for (const [kind, sp0, leaf, f, holesF] of data.orchards || []) {
    const outer = ring(f, k);
    if (outer.length < 3) continue;
    const g = { kind, sp0, leaf, outer, holes: (holesF || []).map((h) => ring(h, k)) };
    groves.push(g);
    farmGrid.addPoly(outer, FARM_NEAR);
  }
  for (const [kind, crop, name, f, holesF] of data.farms || []) {
    const outer = ring(f, k);
    if (outer.length < 3) continue;
    farms.push({ kind, crop, name, outer, holes: (holesF || []).map((h) => ring(h, k)) });
    farmGrid.addPoly(outer, FARM_NEAR);
  }
  const nearFarm = (x, z, d = FARM_NEAR) => farmGrid.at(x, z).some((P) => inBox(P, x, z) && (inPoly(x, z, P.r) || edgeDist(x, z, P.r) < d));
  const waterGrid = new Grid(64);
  for (const c of (city && city.colliders) || []) if (c && c.points && c.points.length >= 3 && /water|sea|stream|fountain|pool/.test(c.kind || '')) waterGrid.addPoly(c.points);
  const inWater = (x, z) => waterGrid.at(x, z).some((P) => inBox(P, x, z) && inPoly(x, z, P.r));

  // ---- occupancy ----
  const occ = new Grid(8);
  const occFree = (x, z, r) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++)
      for (const o of occ.map.get(occ.key(Math.floor(x / 8) + i, Math.floor(z / 8) + j)) || []) if (Math.hypot(o[0] - x, o[1] - z) < o[2] + r) return false;
    return true;
  };
  const occClaim = (x, z, r) => { const o = [x, z, Math.min(r, 8)]; occ.map.has(occ.key(Math.floor(x / 8), Math.floor(z / 8))) ? occ.map.get(occ.key(Math.floor(x / 8), Math.floor(z / 8))).push(o) : occ.map.set(occ.key(Math.floor(x / 8), Math.floor(z / 8)), [o]); };

  // ---- placement ----
  const chunks = new Map();
  const samples = {};
  const droppedAt = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const emit = (sp, x, z, opt) => {
    const onWalk = !!opt.sidewalk;
    const r = 0.6;
    // Seat the trunk on the lowest ground under it so slopes never show a floating root.
    const y = onWalk ? ground(x, z) + SIDE_TOP : Math.min(ground(x, z), ground(x + r, z), ground(x - r, z), ground(x, z + r), ground(x, z - r)) - 0.12;
    let s = (0.85 + hxz(x, z, 4) * 0.3);
    if (opt.heightM > 0) s = Math.max(0.6, Math.min(1.6, (opt.heightM * U_PER_M_HEIGHT) / TPL_H[sp]));
    if (opt.scale) s *= opt.scale;
    const ck = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let c = chunks.get(ck);
    if (!c) chunks.set(ck, (c = { cx: (Math.floor(x / CHUNK) + 0.5) * CHUNK, cz: (Math.floor(z / CHUNK) + 0.5) * CHUNK, lists: {} }));
    q.setFromAxisAngle(up, hxz(x, z, 2) * Math.PI * 2);
    m4.compose(v.set(x, y, z), q, sc.set(s, s, s));
    const tint = 0.88 + hxz(x, z, 6) * 0.22;
    (c.lists[sp] || (c.lists[sp] = [])).push([m4.clone(), tint]);
    if (onWalk) {
      m4.compose(v.set(x, y - 0.02, z), q, sc.set(1, 1, 1));
      (c.lists.pit || (c.lists.pit = [])).push([m4.clone(), 1]);
    }
    const tr = (TRUNK[sp] || 0.5) * Math.min(s, 1.2);
    // Grove rows get one collider per row piece instead (see the groves section).
    if (!opt.noCollider) colliders.push({ kind: 'prop', height: Math.min(TPL_H[sp] * s, 12), points: [[x - tr, z - tr], [x + tr, z - tr], [x + tr, z + tr], [x - tr, z + tr]] });
    occClaim(x, z, opt.claim ?? 1.5);
    result.points.push([+x.toFixed(2), +z.toFixed(2), opt.claim ?? 1.5]);
    // A few positions per source for previews and screenshots.
    const sk = onWalk ? 'sidewalk' : opt.source;
    const sl = samples[sk] || (samples[sk] = []);
    if (sl.length < 400) sl.push([+x.toFixed(1), +z.toFixed(1), sp]);
    stats.species[sp] = (stats.species[sp] || 0) + 1;
    stats[opt.source]++;
    stats.total++;
    return true;
  };

  // Woods and parks that straddle the bbox edge come back whole from Overpass; the world stops
  // at city.bounds, so trees past it would stand on nothing.
  const B = (city && city.bounds) || null;
  const outside = (x, z) => !!B && (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ);
  // Common vetoes. Returns a reason or null.
  const veto = (x, z, r = 0.6) => {
    if (outside(x, z)) return 'outsideMap';
    if (inAny(siteGrid, x, z)) return 'landmark';
    if (inSolid(x, z, r)) return 'building/water';
    if (onStall(x, z)) return 'parking';
    if (underDeck(x, z)) return 'bridge';
    return null;
  };

  // Mapped trees: keep them where mapped, but move them off asphalt and walking lines. Returns
  // the final position plus whether it is a sidewalk tree, or null (reason in stats.dropped).
  const inWalkStrip = (x, z, m = 0.2) => { for (const s of walkGrid.at(x, z)) if (segDist(x, z, s.ax, s.az, s.bx, s.bz).d < s.hw + m) return true; return false; };
  const clearSpot = (x, z) => !veto(x, z, 0.5) && !onCarriage(x, z, 0.5) && !onPath(x, z, 0.6) && !inWalkStrip(x, z);
  const RINGS = [1, 2, 3, 4.5, 6];
  const searchNear = (x, z) => {
    for (const r of RINGS) for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + r, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (clearSpot(px, pz)) return { x: px, z: pz };
    }
    return null;
  };
  // Kerb-side tree line of the sidewalk strip `walk` (nearestSeg result), on the road side.
  const kerbLine = (walk, x, z) => {
    const s = walk.s, tx = (s.bx - s.ax) / s.len, tz = (s.bz - s.az) / s.len;
    const nx = -tz, nz = tx, cx = walk.r.qx, cz = walk.r.qz;
    let side;
    const kerbA = onCarriage(cx + nx * (s.hw + 1.2), cz + nz * (s.hw + 1.2), 0), kerbB = onCarriage(cx - nx * (s.hw + 1.2), cz - nz * (s.hw + 1.2), 0);
    if (kerbA !== kerbB) side = kerbA ? 1 : -1;
    else side = Math.sign((x - cx) * nx + (z - cz) * nz) || 1;
    // 0.9 u from the kerb leaves ~3 u of clear walking line beside a 0.5 u trunk.
    const off = Math.max(0, s.hw - 0.9);
    const px = cx + nx * side * off, pz = cz + nz * side * off;
    return !onCarriage(px, pz, 0.35) && !veto(px, pz, 0.5) ? { x: px, z: pz, sidewalk: true } : null;
  };
  // Carriageways are drawn wider than the real street (city.js WIDEN), so a tree mapped at the
  // real kerb often lands on game asphalt: push it out across the nearest carriageway edge, on
  // its own side of the street.
  const pushOffRoad = (x, z) => {
    for (let it = 0; it < 3 && onCarriage(x, z, 0); it++) {
      const n = nearestSeg(carGrid, x, z, 40);
      if (!n) return null;
      const s = n.s;
      let nx = x - n.r.qx, nz = z - n.r.qz;
      const l = Math.hypot(nx, nz);
      if (l < 1e-3) { nx = -(s.bz - s.az) / s.len; nz = (s.bx - s.ax) / s.len; } else { nx /= l; nz /= l; }
      x = n.r.qx + nx * (s.hw + 1.2); z = n.r.qz + nz * (s.hw + 1.2);
    }
    return onCarriage(x, z, 0) ? null : { x, z };
  };
  const resolveMapped = (x, z) => {
    if (outside(x, z)) return drop('outsideMap');
    if (inAny(siteGrid, x, z)) return drop('landmark');
    const onRoad = onCarriage(x, z, 0);
    let px = x, pz = z;
    if (onRoad) { const p = pushOffRoad(x, z); if (p) { px = p.x; pz = p.z; } }
    const walk = nearestSeg(walkGrid, px, pz, 7);
    if (walk && (onRoad || walk.r.d < walk.s.hw + 0.2)) {
      // On the road or in the middle of a sidewalk: plant it on the kerb-side tree line.
      const k1 = kerbLine(walk, px, pz);
      if (k1) { stats.snapped++; return k1; }
    }
    if (clearSpot(px, pz)) { if (onRoad) stats.nudged++; return { x: px, z: pz }; }
    // A few metres off (OSM accuracy): the nearest clear spot within 6 u, else drop it.
    const p = searchNear(px, pz);
    if (p) { stats.nudged++; return p; }
    const why = veto(x, z, 0) || (onRoad || onCarriage(x, z, 0.5) ? 'carriageway' : onPath(x, z, 0.6) ? 'path' : 'sidewalk');
    if (droppedAt.length < 300) droppedAt.push([+x.toFixed(1), +z.toFixed(1), why]);
    return drop(why);
  };
  // Filled trees (woods, park groves): any conflict drops the candidate.
  // Cheapest tests first: most wood candidates fail on none, so the order only matters for cost.
  const fillOk = (x, z) => !(onOpen(x, z) || onPath(x, z, 1.2) || inWalkStrip(x, z, 1.0) || onCarriage(x, z, 1.5) || veto(x, z, 0.8));

  // Untagged species by place. Street trees: one species per street segment cluster.
  const STREET_MIX = [['ficus', 0.5], ['jacaranda', 0.72], ['poinciana', 0.86], ['broad', 1]];
  const PARK_MIX = [['ficus', 0.3], ['pine', 0.52], ['jacaranda', 0.67], ['poinciana', 0.8], ['broad', 1]];
  const pickMix = (mix, h) => mix.find(([, c]) => h < c)[0];
  const tagged = (sp, leaf) => {
    if (sp === 'washingtonia' || sp === 'palm') return 'palm';
    if (sp === 'phoenix') return 'datePalm';
    if (sp === 'tipuana' || sp === 'melia') return 'broad';
    if (NEAR_TPL[sp]) return sp;
    if (leaf === 'n') return 'pine';
    return null;
  };
  // leaf_type=palm without a species: date palm by the sea, Washingtonia elsewhere.
  const palmAt = (x, z) => (nearestSeg(promGrid, x, z, 40) || nearDunes(x, z) ? 'datePalm' : 'palm');

  lap('setup');
  // ================= 1. natural=tree nodes =================
  for (const [nx0, nz0, sp0, leaf, hM] of data.nodes || []) {
    const x0 = nx0 * k, z0 = nz0 * k;
    if (!occFree(x0, z0, 1.2)) { drop('duplicate'); continue; }
    const p = resolveMapped(x0, z0);
    if (!p) continue;
    let sp = tagged(sp0, leaf) || (leaf === 'p' ? palmAt(p.x, p.z) : null);
    if (!sp) {
      if (p.sidewalk) sp = pickMix(STREET_MIX, hxz(Math.round(p.x / 60), Math.round(p.z / 60), 11));
      else if (nearDunes(p.x, p.z)) sp = 'pine';
      else sp = pickMix(PARK_MIX, hxz(p.x, p.z, 12));
    }
    emit(sp, p.x, p.z, { source: 'nodes', sidewalk: p.sidewalk, heightM: hM, claim: 1.4 });
  }

  lap('nodes');
  // ================= 2. natural=tree_row ways =================
  for (const [ri, [sp0, leaf, hM, f]] of (data.rows || []).entries()) {
    const pts = ring(f, k);
    if (pts.length < 2) continue;
    let sp = tagged(sp0, leaf);
    if (!sp) {
      // Untagged rows on the promenade are date palms; along a boulevard, Washingtonia palms.
      const mid = pts[Math.floor(pts.length / 2)];
      const dir = [pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]];
      const dl = Math.hypot(dir[0], dir[1]) || 1;
      const prom = nearestSeg(promGrid, mid[0], mid[1], 25);
      const blvd = nearestSeg(boulevardGrid, mid[0], mid[1], 28);
      const parallel = (b) => b && Math.abs(((b.s.bx - b.s.ax) * dir[0] + (b.s.bz - b.s.az) * dir[1]) / (b.s.len * dl)) > 0.8;
      // A row tagged broadleaved or needleleaved is not palms, whatever road it lines.
      // A row along a grove or a field is a windbreak: eucalyptus if mapped broadleaved, else cypress.
      if (leaf !== 'p' && (nearFarm(mid[0], mid[1], 30) || nearFarm(pts[0][0], pts[0][1], 30))) { sp = leaf === 'b' ? 'eucalyptus' : 'cypress'; stats.windbreakRows = (stats.windbreakRows || 0) + 1; }
      else if (leaf === 'p') sp = palmAt(mid[0], mid[1]);
      else if (leaf !== 'b' && leaf !== 'n' && parallel(prom)) sp = 'datePalm';
      else if (leaf !== 'b' && leaf !== 'n' && parallel(blvd)) sp = 'palm';
      else sp = pickMix(STREET_MIX, hash(ri * 7919 + 13));
    }
    const step = sp === 'palm' || sp === 'datePalm' ? ROW_STEP.palm : WB_STEP[sp] || ROW_STEP.default;
    for (const [x0, z0] of along(pts, step, step / 2)) {
      if (!occFree(x0, z0, Math.min(3, step * 0.4))) { drop('duplicate'); continue; }
      const p = resolveMapped(x0, z0);
      if (!p) continue;
      emit(sp, p.x, p.z, { source: 'rows', sidewalk: p.sidewalk, heightM: hM, claim: Math.min(2.5, step * 0.4) });
    }
  }

  lap('rows');
  // Windbreak rows down a thin wood strip: walk both long sides, step inward to the middle (one
  // row) or 3 u in from each side (two rows in a wide strip), and let occupancy merge the points
  // the two sides agree on.
  function plantWindbreak(outer, holes, stripW, leaf, sp0) {
    let sp = tagged(sp0, leaf);
    if (!sp || sp === 'palm' || sp === 'datePalm') sp = leaf === 'n' ? 'cypress' : leaf === 'b' ? 'eucalyptus' : stripW < WB_NARROW ? 'cypress' : 'eucalyptus';
    const step = WB_STEP[sp] || 5;
    const inset = stripW < WB_NARROW ? stripW / 2 : 3.0;
    const inward = signedArea(outer) > 0 ? 1 : -1;
    stats.windbreakStrips = (stats.windbreakStrips || 0) + 1;
    for (const [x0, z0, dx, dz] of along([...outer, outer[0]], step, step / 2)) {
      const x = x0 - dz * inset * inward, z = z0 + dx * inset * inward;
      if (outside(x, z) || !inPoly(x, z, outer) || holes.some((h) => inPoly(x, z, h))) continue;
      if (edgeDist(x, z, outer) < inset * 0.6) continue; // strip ends and corners
      if (!occFree(x, z, step * 0.42)) continue;
      if (!fillOk(x, z)) { drop('windbreakBlocked'); continue; }
      emit(sp, x, z, { source: 'windbreaks', claim: step * 0.42, scale: sp === 'cypress' ? 1.05 : 1 });
    }
  }

  // ================= 3. woods and forests =================
  const woodGrid = new Grid(128);
  for (const [kind, leaf, sp0, f, holesF] of data.woods || []) {
    const outer = ring(f, k), holes = (holesF || []).map((h) => ring(h, k));
    if (outer.length < 3) continue;
    const bb = bbox(outer);
    woodGrid.add({ outer, holes }, bb.minX, bb.minZ, bb.maxX, bb.maxZ);
    // Windbreak: a thin strip (width ~ 2 * area / perimeter) beside a grove or a field.
    const A = area(outer);
    let P = 0;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) P += Math.hypot(outer[i][0] - outer[j][0], outer[i][1] - outer[j][1]);
    const stripW = (2 * A) / Math.max(P, 1e-3);
    if (stripW < WB_MAX_W && P / 2 > 3 * stripW && outer.some(([x, z]) => nearFarm(x, z))) {
      plantWindbreak(outer, holes, stripW, leaf, sp0);
      continue;
    }
    const S = SPACING[kind] || SPACING.wood;
    const angle = 0;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const cx = (bb.minX + bb.maxX) / 2, cz = (bb.minZ + bb.maxZ) / 2;
    const R = Math.hypot(bb.maxX - bb.minX, bb.maxZ - bb.minZ) / 2;
    const dunes = nearDunes(cx, cz);
    const polySp = tagged(sp0, leaf);
    const jit = 0.38;
    for (let u = -R; u <= R; u += S) for (let w = -R; w <= R; w += S) {
      const hu = hxz(u + cx, w + cz, 21) - 0.5, hw = hxz(u + cx, w + cz, 22) - 0.5;
      const lu = u + hu * S * jit * 2, lw = w + hw * S * jit * 2;
      const x = cx + lu * ca - lw * sa, z = cz + lu * sa + lw * ca;
      if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ || outside(x, z)) continue;
      if (!inPoly(x, z, outer) || holes.some((h) => inPoly(x, z, h))) continue;
      // Natural stands are not perfect: a few gaps keep the canopy from reading as a carpet.
      if (hxz(x, z, 23) < 0.12) continue;
      if (!fillOk(x, z)) { drop('woodsBlocked'); continue; }
      let sp = polySp;
      if (!sp) {
        if (dunes || leaf === 'n') sp = 'pine';
        else sp = hxz(x, z, 24) < (leaf === 'b' ? 0.8 : 0.25) ? 'eucalyptus' : 'pine';
      }
      emit(sp, x, z, { source: 'woods', claim: 3 });
    }
  }
  const inWood = (x, z) => woodGrid.at(x, z).some((w) => inPoly(x, z, w.outer) && !w.holes.some((h) => inPoly(x, z, h)));

  lap('woods');
  // ================= 3b. groves (pardesim) and nurseries =================
  // Ground: soil under the groves (texture striped along the rows), dirt headlands and tracks,
  // ploughed fields and packed-earth yards. Draped on the terrain just above the city's ground cover.
  const soilSoup = new Soup(), fieldSoup = new Soup(), dirtSoup = new Soup();
  const hedgeChunks = new Map(); // chunk key -> Soup of far grove-row hedges
  const C = (hex) => new THREE.Color(hex);
  const SOIL = C(0xffffff), DIRT = C(0xcfae82), YARD = C(0xc9b28e);
  const FIELD = [C(0xc49a70), C(0xdcc58e), C(0xb38e6a)]; // ploughed, stubble, harrowed (October)
  const OFF = { field: 0.06, soil: 0.1, dirt: 0.115 }; // above the city's ground cover (<= 0.08), below paths and roads
  const parkGrid = new Grid(128);
  for (const [, , f] of data.parks || []) { const r = ring(f, k); if (r.length >= 3) parkGrid.addPoly(r); }
  const inPark = (x, z) => parkGrid.at(x, z).some((P) => inBox(P, x, z) && inPoly(x, z, P.r));
  // Fill a polygon with triangles no longer than maxEdge, each vertex seated on the terrain.
  const drape = (soup, outer, holes, maxEdge, off, col, uvOf, skip) => {
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(outer.map((p) => new THREE.Vector2(p[0], p[1])), holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])))); } catch (e) { return; }
    const all = outer.concat(...holes);
    const m2 = maxEdge * maxEdge, stack = tris.map((t) => [all[t[0]], all[t[1]], all[t[2]]]);
    let guard = 0;
    while (stack.length && guard++ < 600000) {
      const [a, b, c] = stack.pop();
      const ab = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2, bc = (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2, ca = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2;
      const mx = Math.max(ab, bc, ca);
      if (mx > m2) {
        if (mx === ab) { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; stack.push([a, m, c], [m, b, c]); }
        else if (mx === bc) { const m = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]; stack.push([a, b, m], [a, m, c]); }
        else { const m = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; stack.push([a, b, m], [m, b, c]); }
        continue;
      }
      const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[1] + b[1] + c[1]) / 3;
      if (outside(cx, cz) || inAny(siteGrid, cx, cz) || inWater(cx, cz) || (skip && skip(cx, cz))) continue;
      const ya = ground(a[0], a[1]), yb = ground(b[0], b[1]), yc = ground(c[0], c[1]);
      // A triangle spanning a cut or an embankment would lie over it like a lid.
      if (Math.max(ya, yb, yc) - Math.min(ya, yb, yc) > 6) continue;
      soup.tri([a[0], ya + off, a[1]], [b[0], yb + off, b[1]], [c[0], yc + off, c[1]], col, uvOf ? [uvOf(a[0], a[1]), uvOf(b[0], b[1]), uvOf(c[0], c[1])] : null);
    }
  };
  // A flat dirt strip along a polyline, draped every few units.
  const strip = (soup, pts, w, off, col) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5) continue;
      const n = Math.max(1, Math.ceil(L / 6)), nx = -(bz - az) / L * w / 2, nz = (bx - ax) / L * w / 2;
      for (let s2 = 0; s2 < n; s2++) {
        const t0 = s2 / n, t1 = (s2 + 1) / n;
        const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
        if (outside((x0 + x1) / 2, (z0 + z1) / 2) || inWater((x0 + x1) / 2, (z0 + z1) / 2)) continue;
        const p = [[x0 + nx, z0 + nz], [x1 + nx, z1 + nz], [x1 - nx, z1 - nz], [x0 - nx, z0 - nz]].map(([x, z]) => [x, ground(x, z) + off, z]);
        soup.tri(p[0], p[1], p[2], col, null);
        soup.tri(p[0], p[2], p[3], col, null);
      }
    }
  };
  // Far stand-in of one grove row piece: a rounded hedge prism from A to B on the ground.
  const PROFILE = [[-1, 0], [-1, 0.72], [-0.55, 1], [0.55, 1], [1, 0.72], [1, 0]];
  const hedgePiece = (soup, ax, az, bx, bz, hw, y0, y1, col) => {
    const L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L, nz = (bx - ax) / L;
    const ga = ground(ax, az) - 0.1, gb = ground(bx, bz) - 0.1;
    const P = (end, i) => {
      const [u, v] = PROFILE[i], x = end ? bx : ax, z = end ? bz : az;
      return [x + nx * u * hw, (end ? gb : ga) + y0 + (y1 - y0) * v, z + nz * u * hw];
    };
    const side = col.clone().multiplyScalar(0.92);
    // Wind each face so its normal points away from the prism's axis (lit from outside).
    const mid = [(ax + bx) / 2, (ga + gb) / 2 + (y0 + y1) / 2, (az + bz) / 2];
    const face = (a, b, c, cc) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
      const ox = (a[0] + b[0] + c[0]) / 3 - mid[0], oy = (a[1] + b[1] + c[1]) / 3 - mid[1], oz = (a[2] + b[2] + c[2]) / 3 - mid[2];
      if (nx2 * ox + ny2 * oy + nz2 * oz < 0) soup.raw(a, c, b, cc); else soup.raw(a, b, c, cc);
    };
    for (let i = 0; i < PROFILE.length - 1; i++) {
      const a0 = P(0, i), a1 = P(0, i + 1), b0 = P(1, i), b1 = P(1, i + 1);
      const c = i === 2 ? col : side;
      face(a0, b0, b1, c); face(a0, b1, a1, c);
    }
    for (const end of [0, 1]) for (let i = 1; i < PROFILE.length - 1; i++) face(P(end, 0), P(end, i), P(end, i + 1), side);
  };
  stats.groveTrees = 0; stats.groveRows = 0; stats.groveTracks = 0;
  for (const g of groves) {
    const nursery = g.kind === 'nursery';
    const G = nursery ? NURSERY : GROVE;
    const { outer, holes } = g;
    const bb = bbox(outer);
    const ang = gridAngle(outer), ca = Math.cos(ang), sa = Math.sin(ang);
    const cx = (bb.minX + bb.maxX) / 2, cz = (bb.minZ + bb.maxZ) / 2;
    // Local frame: u along the rows, w across them.
    const toLocal = (x, z) => [(x - cx) * ca + (z - cz) * sa, -(x - cx) * sa + (z - cz) * ca];
    const toWorld = (u, w) => [cx + u * ca - w * sa, cz + u * sa + w * ca];
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const [x, z] of outer) { const [u, w] = toLocal(x, z); u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
    const inside = (x, z) => inPoly(x, z, outer) && !holes.some((h) => inPoly(x, z, h));
    const big = !nursery && area(outer) > G.bigArea;
    // Soil, striped along the rows (v = 0 on a tree line).
    const wStart = w0 + G.headland + G.margin;
    drape(soilSoup, outer, holes, 16, OFF.soil, SOIL, (x, z) => { const [u, w] = toLocal(x, z); return [u / 19.2, (w - wStart) / G.row + 0.25]; });
    // Headland: a dirt band just inside the boundary, on each edge.
    const inward = signedArea(outer) > 0 ? 1 : -1;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const [ax, az] = outer[j], [bx, bz] = outer[i], L = Math.hypot(bx - ax, bz - az);
      if (L < 1) continue;
      const o = (G.headland / 2) * inward, ox = -(bz - az) / L * o, oz = (bx - ax) / L * o;
      strip(dirtSoup, [[ax + ox, az + oz], [bx + ox, bz + oz]], G.headland, OFF.dirt, DIRT);
      // Fill the notch the two edge strips leave at a corner with a small octagon.
      const vx = bx + ox, vz = bz + oz, rr = G.headland * 0.62, gy0 = ground(vx, vz) + OFF.dirt;
      if (!outside(vx, vz)) for (let q2 = 0; q2 < 8; q2++) {
        const t0 = (q2 / 8) * Math.PI * 2, t1 = ((q2 + 1) / 8) * Math.PI * 2;
        dirtSoup.tri([vx, gy0, vz], [vx + Math.cos(t0) * rr, gy0, vz + Math.sin(t0) * rr], [vx + Math.cos(t1) * rr, gy0, vz + Math.sin(t1) * rr], DIRT, null);
      }
    }
    // Block tracks in big groves: along the rows every blockRows rows, across every blockLen.
    const trackRows = new Set(), crossU = [];
    if (big) {
      const nRows = Math.floor((w1 - wStart) / G.row);
      for (let i = G.blockRows; i < nRows - 3; i += G.blockRows + 1) trackRows.add(i);
      for (let u = u0 + G.blockLen; u < u1 - G.blockLen * 0.5; u += G.blockLen) crossU.push(u);
      const runs = (sample) => {
        // Inside runs of a sampled line, kept off the headland.
        let run = [];
        for (const [x, z] of sample) {
          if (inside(x, z) && edgeDist(x, z, outer) > G.headland) run.push([x, z]);
          else { if (run.length > 2) { strip(dirtSoup, run, G.track, OFF.dirt, DIRT); stats.groveTracks++; } run = []; }
        }
        if (run.length > 2) { strip(dirtSoup, run, G.track, OFF.dirt, DIRT); stats.groveTracks++; }
      };
      for (const i of trackRows) { const w = wStart + i * G.row, pts = []; for (let u = u0; u <= u1; u += 6) pts.push(toWorld(u, w)); runs(pts); }
      for (const u of crossU) { const pts = []; for (let w = w0; w <= w1; w += 6) pts.push(toWorld(u, w)); runs(pts); }
    }
    const polySp = tagged(g.sp0, g.leaf);
    const sp = nursery ? 'grove' : polySp && !/palm/i.test(polySp) ? (polySp === 'citrus' ? 'grove' : polySp) : 'grove';
    const clearOfEdge = G.headland + G.margin;
    // Scanline per row (u-intervals inside the grove, holes handled by even-odd) and a local edge
    // grid for the headland test: both keep the cost per tree independent of the polygon size.
    const localRings = [outer, ...holes].map((r) => r.map(([x, z]) => toLocal(x, z)));
    const rowSpans = (w) => {
      const xs = [];
      for (const r of localRings) for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const [ua, wa] = r[a], [ub, wb] = r[b];
        if ((wa > w) !== (wb > w)) xs.push(ua + ((w - wa) / (wb - wa)) * (ub - ua));
      }
      xs.sort((p2, q2) => p2 - q2);
      const spans = [];
      for (let a = 0; a + 1 < xs.length; a += 2) spans.push([xs[a], xs[a + 1]]);
      return spans;
    };
    const edgeGrid = new Grid(24);
    for (const r of [outer, ...holes]) for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
      const sg = [r[b][0], r[b][1], r[a][0], r[a][1]];
      edgeGrid.add(sg, Math.min(sg[0], sg[2]) - clearOfEdge, Math.min(sg[1], sg[3]) - clearOfEdge, Math.max(sg[0], sg[2]) + clearOfEdge, Math.max(sg[1], sg[3]) + clearOfEdge);
    }
    const nearEdge = (x, z) => {
      for (const [ax, az, bx, bz] of edgeGrid.at(x, z)) {
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if ((x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2 < clearOfEdge * clearOfEdge) return true;
      }
      return false;
    };
    // Row by row: trees, and contiguous runs of them as hedge pieces and colliders.
    for (let i = 0, w = wStart; w <= w1 - clearOfEdge + 1e-6; i++, w += G.row) {
      if (trackRows.has(i)) continue;
      let run = null;
      const flush = () => {
        if (!run || nursery) { run = null; return; }
        const [a, b] = [run.first, run.last];
        const ext = 2.0; // crown radius past the end trunks
        const [ax, az] = toWorld(a - ext, w), [bx, bz] = toWorld(b + ext, w);
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, ck = `${Math.floor(mx / CHUNK)},${Math.floor(mz / CHUNK)}`;
        let hs = hedgeChunks.get(ck);
        if (!hs) hedgeChunks.set(ck, (hs = { soup: new Soup(1e9), cx: (Math.floor(mx / CHUNK) + 0.5) * CHUNK, cz: (Math.floor(mz / CHUNK) + 0.5) * CHUNK }));
        const t = 0.9 + hxz(mx, mz, 41) * 0.16;
        hedgePiece(hs.soup, ax, az, bx, bz, 2.05, 0.9, 4.5, C(0x37803a).multiplyScalar(t));
        // Trunk line collider: walk the alleys between rows, not through a row.
        const [tax, taz] = toWorld(a - 0.4, w), [tbx, tbz] = toWorld(b + 0.4, w);
        const L = Math.hypot(tbx - tax, tbz - taz) || 1, nx = -(tbz - taz) / L * 0.45, nz = (tbx - tax) / L * 0.45;
        colliders.push({ kind: 'prop', height: 4.5, points: [[tax + nx, taz + nz], [tbx + nx, tbz + nz], [tbx - nx, tbz - nz], [tax - nx, taz - nz]] });
        stats.groveRows++;
        run = null;
      };
      for (const [sa0, sa1] of rowSpans(w)) {
        flush();
        // Keep every row on one global u lattice so neighbouring rows line up across the grove.
        for (let u = u0 + clearOfEdge + Math.ceil((sa0 - u0 - clearOfEdge) / G.step) * G.step; u <= sa1 - clearOfEdge * 0.5; u += G.step) {
          const blocked = crossU.some((cu) => Math.abs(u - cu) < G.track / 2 + G.margin);
          const [x, z] = toWorld(u + (hxz(u + cx, w + cz, 42) - 0.5) * 0.3, w + (hxz(u + cx, w + cz, 43) - 0.5) * 0.3);
          // Grid points on the headland or past the map edge are simply not part of the grove.
          if (blocked || outside(x, z) || nearEdge(x, z)) { flush(); continue; }
          if (!fillOk(x, z) || !occFree(x, z, nursery ? 0.5 : 1.6)) { drop('groveBlocked'); flush(); continue; }
          if (run && u - run.first > GROVE_RUN) flush();
          // A dead or replanted tree here and there; the row (and its far hedge) stays continuous.
          if (!nursery && hxz(x, z, 44) < 0.025) { run ? (run.last = u) : (run = { first: u, last: u }); continue; }
          emit(sp, x, z, { source: nursery ? 'nursery' : 'groves', claim: nursery ? 0.8 : 1.8, noCollider: true, scale: nursery ? G.scale : 1 });
          stats.groveTrees += nursery ? 0 : 1;
          run ? (run.last = u) : (run = { first: u, last: u });
        }
      }
      flush();
    }
  }
  lap('groves');
  // Fields and farm yards: ground only.
  for (const f of farms) {
    const bb = bbox(f.outer);
    if (B && (bb.maxX < B.minX || bb.minX > B.maxX || bb.maxZ < B.minZ || bb.minZ > B.maxZ)) continue;
    if (f.kind === 'farmyard') { drape(dirtSoup, f.outer, f.holes, 16, OFF.soil, YARD, null, inPark); continue; }
    const ang = gridAngle(f.outer), ca = Math.cos(ang), sa = Math.sin(ang);
    const col = FIELD[Math.floor(hxz(bb.minX, bb.minZ, 45) * FIELD.length)];
    drape(fieldSoup, f.outer, f.holes, 36, OFF.field, col, (x, z) => [(x * ca + z * sa) / 24, (-x * sa + z * ca) / 4.8], inPark);
  }
  lap('fields');
  // ================= 4. parks and gardens: modest groves along edges and paths =================
  const parks = (data.parks || []).map(([kind, name, f, holesF]) => ({ kind, name, outer: ring(f, k), holes: (holesF || []).map((h) => ring(h, k)) }));
  // Mapped trees per park: where mappers drew the trees, the park gets nothing extra.
  const mappedGrid = new Grid(64);
  for (const p of result.points) mappedGrid.add(p, p[0], p[1], p[0], p[1]);
  const mappedIn = (pk, bb) => {
    let n = 0;
    for (let i = Math.floor(bb.minX / 64); i <= Math.floor(bb.maxX / 64); i++)
      for (let j = Math.floor(bb.minZ / 64); j <= Math.floor(bb.maxZ / 64); j++)
        for (const [x, z] of mappedGrid.map.get(mappedGrid.key(i, j)) || []) if (inPoly(x, z, pk.outer)) n++;
    return n;
  };
  stats.parksSkippedMapped = 0;
  for (const pk of parks) {
    if (pk.outer.length < 3) continue;
    const bb = bbox(pk.outer);
    const A = area(pk.outer) - pk.holes.reduce((s, h) => s + area(h), 0);
    let budget = A / PARK_AREA_PER_TREE;
    budget = Math.floor(budget) + (hxz(bb.minX, bb.minZ, 31) < budget % 1 ? 1 : 0);
    if (budget <= 0) continue;
    const mapped = mappedIn(pk, bb);
    if (mapped >= budget * 0.5) { stats.parksSkippedMapped++; continue; }
    budget -= mapped;
    const inside = (x, z) => inPoly(x, z, pk.outer) && !pk.holes.some((h) => inPoly(x, z, h));
    const cands = [];
    // Edge band: just inside the park boundary.
    for (const [x, z, dx, dz] of along([...pk.outer, pk.outer[0]], 11, 5)) {
      for (const sgn of [1, -1]) {
        const px = x - dz * 4.5 * sgn, pz = z + dx * 4.5 * sgn;
        if (inside(px, pz)) { cands.push([px, pz]); break; }
      }
    }
    // Along the park's own footpaths, a few units off each side.
    const seen = new Set();
    for (let i = Math.floor(bb.minX / 32); i <= Math.floor(bb.maxX / 32); i++)
      for (let j = Math.floor(bb.minZ / 32); j <= Math.floor(bb.maxZ / 32); j++)
        for (const s of pathGrid.map.get(pathGrid.key(i, j)) || []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const tx = (s.bx - s.ax) / s.len, tz = (s.bz - s.az) / s.len;
          for (const [x, z] of along([[s.ax, s.az], [s.bx, s.bz]], 11, 5)) for (const sgn of [1, -1]) {
            const off = s.hw + 3.2;
            const px = x - tz * off * sgn, pz = z + tx * off * sgn;
            if (inside(px, pz)) cands.push([px, pz]);
          }
        }
    // Groves: keep the candidates where the low-frequency noise is high, then the budget.
    const keep = cands.filter(([x, z]) => noise2(x, z) > 0.45)
      .map(([x, z]) => [x + (hxz(x, z, 33) - 0.5) * 3, z + (hxz(x, z, 34) - 0.5) * 3, hxz(x, z, 35)])
      .sort((a, b) => a[2] - b[2]);
    const dunes = nearDunes((bb.minX + bb.maxX) / 2, (bb.minZ + bb.maxZ) / 2);
    let placed = 0;
    for (const [x, z] of keep) {
      if (placed >= budget) break;
      if (!inside(x, z) || midLawn(x, z) || inWood(x, z) || !occFree(x, z, 5.5)) continue;
      if (!fillOk(x, z)) { drop('parkBlocked'); continue; }
      const sp = dunes ? (hxz(x, z, 36) < 0.75 ? 'pine' : 'broad') : pickMix(PARK_MIX, hxz(x, z, 37));
      emit(sp, x, z, { source: 'parks', claim: 2.5 });
      placed++;
    }
  }

  lap('parks');
  // ---- emit: InstancedMesh per species per chunk, near and far ----
  const gradientMap = (() => {
    const t = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t;
  })();
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap });
  const matDS = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, side: THREE.DoubleSide });
  const nearTpl = {}, farTpl = {};
  const tplNear = (sp) => nearTpl[sp] || (nearTpl[sp] = NEAR_TPL[sp]());
  const tplFar = (sp) => farTpl[sp] || (farTpl[sp] = FAR_SPEC[sp] ? farTemplate(sp) : null);
  const cull = [];
  const col = new THREE.Color();
  for (const [ck, c] of chunks) {
    const g = new THREE.Group();
    g.name = `trees ${ck}`;
    for (const [sp, list] of Object.entries(c.lists)) {
      for (const lod of ['near', 'far']) {
        const geo = lod === 'near' ? tplNear(sp) : tplFar(sp);
        if (!geo) continue;
        const im = new THREE.InstancedMesh(geo, lod === 'near' && (sp === 'palm' || sp === 'datePalm') ? matDS : mat, list.length);
        list.forEach(([m, tint], i) => { im.setMatrixAt(i, m); im.setColorAt(i, col.setRGB(tint, tint, tint)); });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = lod === 'near' && sp !== 'pit';
        im.name = `${sp}-${lod}`;
        g.add(im);
        cull.push({ im, cx: c.cx, cz: c.cz, lod, near2: ((sp === 'grove' ? GROVE_NEAR : NEAR) + CHUNK * 0.72) ** 2, far2: (FAR + CHUNK * 0.72) ** 2 });
      }
    }
    group.add(g);
  }
  // Grove rows past GROVE_NEAR: one hedge mesh per chunk.
  const groveNear2 = (GROVE_NEAR + CHUNK * 0.72) ** 2, far2 = (FAR + CHUNK * 0.72) ** 2;
  for (const [ck, hs] of hedgeChunks) for (const m of hs.soup.meshes(mat, `grove-rows ${ck}`)) {
    m.castShadow = false;
    group.add(m);
    cull.push({ im: m, cx: hs.cx, cz: hs.cz, lod: 'far', near2: groveNear2, far2 });
  }
  // Farm ground: plain meshes, frustum culled per tile.
  const groundMat = (tex) => new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, map: tex || null, polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -6 }); // just over city.js layerMat(1)
  const soilTex = stripeTexture([[0, 0.5, '#7e5638'], [0.5, 0.62, '#9a6a45'], [0.62, 0.88, '#ad7a50'], [0.88, 1, '#9a6a45']]);
  // Furrows ~1 m apart, low contrast: a field reads as ploughed without shimmering at a distance.
  const fieldTex = stripeTexture([[0, 0.2, '#e6d6ba'], [0.2, 0.25, '#d2bc98'], [0.25, 0.45, '#e6d6ba'], [0.45, 0.5, '#d2bc98'],
    [0.5, 0.7, '#e6d6ba'], [0.7, 0.75, '#d2bc98'], [0.75, 0.95, '#e6d6ba'], [0.95, 1, '#d2bc98']]);
  const groundParts = [
    [soilSoup, groundMat(soilTex), 'grove-soil'], [fieldSoup, groundMat(fieldTex), 'fields'],
    [dirtSoup, groundMat(null), 'farm-dirt'],
  ];
  if (!soilTex) groundParts[0][0].tiles.forEach((b) => { b.uv.length = 0; });
  if (!fieldTex) groundParts[1][0].tiles.forEach((b) => { b.uv.length = 0; });
  for (const [soup, m2, name] of groundParts) for (const m of soup.meshes(m2, name)) { m.castShadow = false; group.add(m); }
  stats.groundTris = soilSoup.tris + fieldSoup.tris + dirtSoup.tris;
  // Pick the LOD per chunk on the scene's render hook, so it works in the game and the previews.
  // Hysteresis is not needed: the switch happens beyond the fog's dense band.
  const prevHook = scene.onBeforeRender;
  scene.onBeforeRender = function (renderer, sc2, camera, ...rest) {
    if (prevHook) prevHook.call(this, renderer, sc2, camera, ...rest);
    const p = camera.position;
    for (const e of cull) {
      const dx = e.cx - p.x, dz = e.cz - p.z, d2 = dx * dx + dz * dz;
      e.im.visible = e.lod === 'near' ? d2 < e.near2 : d2 >= e.near2 && d2 < e.far2;
    }
  };

  lap('meshes');
  stats.phaseMs = phaseMs;
  stats.chunks = chunks.size;
  stats.meshes = cull.length;
  stats.ms = Math.round(performance.now() - t0);
  group.userData.stats = stats;
  group.userData.samples = samples;
  group.userData.droppedAt = droppedAt;
  group.userData.attribution = data.meta.attribution;
  return result;
}
