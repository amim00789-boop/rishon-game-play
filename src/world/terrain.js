// Terrain: real elevation from an open DEM (tools/fetch_terrain.py -> data/terrain.bin), sampled
// with groundAt() by every module that puts things on the ground, and drawn as a chunked,
// toon-shaded heightfield that replaces the flat land plane.
import * as THREE from 'three';
import { SCALE } from '../geo.js';

const BASE = new URL('../../data/', import.meta.url);
const SURF_LAND = 0, SURF_SAND = 1, SURF_SEA = 2;
const SEA_FLOOR = -2.2; // mesh depth at sea cells: under the sea plane (-0.6) so the shoreline is a clean cut
const CHUNK_CELLS = 32; // 32 cells x 12 u = 384 u chunks: small enough for frustum culling

let T = null; // { nx, nz, x0, z0, step, h: Float32Array (world units), surf: Uint8Array, meta }
let CUT = null; // rail trench along the Ayalon: { list, segs, grid } (see tools/fetch_terrain.py)
let RIM = null; // cliff cuts baked into the heightfield: { i0, j0, w, h, lift: Float32Array } (world units)
const CUT_CELL = 32;
// Mesh vertices this far outside a cut are lowered too, so the terrain never covers the trench
// floor; the dip it leaves outside the wall is hidden under city.js's lip strip.
const CUT_MESH_PAD = 10;

// Loads the heightfield. Safe to call twice; resolves to the header (or null if the data is missing,
// in which case groundAt stays 0 and the world is flat as before).
let loading = null;
export function loadTerrain(base = BASE) {
  if (T) return Promise.resolve(T.meta);
  if (loading) return loading;
  loading = (async () => {
    try {
      const [mr, br] = await Promise.all([fetch(new URL('terrain.json', base)), fetch(new URL('terrain.bin', base))]);
      if (!mr.ok || !br.ok) throw new Error(`terrain data HTTP ${mr.status}/${br.status}`);
      const meta = await mr.json();
      const buf = await br.arrayBuffer();
      const { nx, nz, heightQ } = meta;
      // The bake stores positions at its SCALE; rescale if src/geo.js has moved since.
      const k = SCALE / (meta.scale || SCALE);
      const raw = new Uint16Array(buf, 0, nx * nz);
      const h = new Float32Array(nx * nz);
      for (let i = 0; i < h.length; i++) h[i] = raw[i] * heightQ * k;
      const surf = new Uint8Array(buf, meta.surfaceOffset ?? nx * nz * 2, nx * nz);
      T = { nx, nz, x0: meta.x0 * k, z0: meta.z0 * k, step: meta.step * k, h, surf, meta, unitsPerMetre: SCALE * (meta.verticalExaggeration || 1) };
      CUT = buildCuts(meta.cuts || [], k);
      const r = meta.rimLift;
      if (r && r.q && r.q.length === r.w * r.h) RIM = { i0: r.i0, j0: r.j0, w: r.w, h: r.h, lift: Float32Array.from(r.q, (v) => v * heightQ * k) };
      return meta;
    } catch (e) {
      console.warn('[terrain] no elevation data, ground stays flat.', e.message || e);
      return null;
    }
  })();
  return loading;
}

function buildCuts(cuts, k) {
  if (!cuts.length) return null;
  const list = [], segs = [], grid = new Map();
  cuts.forEach((c, ci) => {
    const pts = [];
    for (let i = 0; i + 1 < c.pts.length; i += 2) pts.push([c.pts[i] * k, c.pts[i + 1] * k]);
    const hw = c.hw.map((v) => v * k), depth = c.depth.map((v) => v * k);
    list.push({ points: pts, hw, depth });
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1e-6;
      const sg = { ci, ax, az, ux: (bx - ax) / len, uz: (bz - az) / len, len, hw0: hw[i], hw1: hw[i + 1], d0: depth[i], d1: depth[i + 1] };
      segs.push(sg);
      const pad = Math.max(hw[i], hw[i + 1]) + CUT_MESH_PAD + 2;
      for (let gi = Math.floor((Math.min(ax, bx) - pad) / CUT_CELL); gi <= Math.floor((Math.max(ax, bx) + pad) / CUT_CELL); gi++)
        for (let gj = Math.floor((Math.min(az, bz) - pad) / CUT_CELL); gj <= Math.floor((Math.max(az, bz) + pad) / CUT_CELL); gj++) {
          const key = gi * 65536 + gj;
          let l = grid.get(key);
          if (!l) { l = []; grid.set(key, l); }
          l.push(sg);
        }
    }
  });
  return { list, segs, grid };
}

// Depth of the rail trench at (x, z) (0 outside), widened by `pad` for the mesh.
function cutDepth(x, z, pad = 0) {
  const l = CUT.grid.get(Math.floor(x / CUT_CELL) * 65536 + Math.floor(z / CUT_CELL));
  if (!l) return 0;
  let best = 0;
  for (const s of l) {
    let t = (x - s.ax) * s.ux + (z - s.az) * s.uz;
    t = t < 0 ? 0 : t > s.len ? s.len : t;
    const u = t / s.len;
    const d = Math.hypot(x - s.ax - s.ux * t, z - s.az - s.uz * t);
    if (d >= s.hw0 + (s.hw1 - s.hw0) * u + pad) continue;
    const dep = s.d0 + (s.d1 - s.d0) * u;
    if (dep > best) best = dep;
  }
  return best;
}

// The rail trench polylines with per-vertex half width and depth (world units), for city.js's walls.
export function terrainCuts() { return CUT ? CUT.list : []; }
// Ground height ignoring the trench and the baked cliff cuts (the rim of the cut), for walls and
// anything that bridges it: city.js builds bridge decks on this, so the Route 4 bridges over the
// 431 cut stay at clifftop level instead of sagging into it.
export function rimAt(x, z) { return baseAt(x, z) + (RIM ? rimLiftAt(x, z) : 0); }

function rimLiftAt(x, z) {
  const fx = (x - T.x0) / T.step - RIM.i0, fz = (z - T.z0) / T.step - RIM.j0;
  if (!(fx >= 0 && fz >= 0 && fx < RIM.w - 1 && fz < RIM.h - 1)) return 0;
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, w = RIM.w, l = RIM.lift, o = j * w + i;
  return (l[o] * (1 - u) + l[o + 1] * u) * (1 - v) + (l[o + w] * (1 - u) + l[o + w + 1] * u) * v;
}

export function terrainLoaded() { return !!T; }
export function terrainMeta() { return T ? T.meta : null; }

// Real elevation in metres above sea level (groundAt divided by SCALE and the baked exaggeration).
export function metresAt(x, z) { return T ? groundAt(x, z) / T.unitsPerMetre : 0; }

// Ground height in world units (bilinear over the 10 m grid). 0 before load and at sea. Past the
// edge of the data the edge row continues (it used to drop to 0: a 40 u cliff under the roads that
// run off the map), and the baked grid already spans 1.35 km past the playable bounds.
export function groundAt(x, z) {
  if (OVR && x > OVR.box[0] && x < OVR.box[2] && z > OVR.box[1] && z < OVR.box[3]) return OVR.at(x, z);
  return groundAtRaw(x, z);
}

// The heightfield itself, without any override: what the override is designed on.
export function groundAtRaw(x, z) {
  const g = baseAt(x, z);
  return CUT && g > 0 ? g - cutDepth(x, z) : g;
}

// A designed area that owns its ground (src/world/dayan: the Moshe Dayan interchange, graded under
// its roads): { box: [x0, z0, x1, z1], at(x, z) }. Inside the box groundAt answers with it and the
// terrain mesh leaves a hole for the area's own ground mesh, which meets this one at the box edge.
let OVR = null;
export function setGroundOverride(o) { OVR = o && o.box && typeof o.at === 'function' ? o : null; }

function baseAt(x, z) {
  if (!T) return 0;
  let fx = (x - T.x0) / T.step, fz = (z - T.z0) / T.step;
  if (!(fx === fx && fz === fz)) return 0;
  fx = fx < 0 ? 0 : fx > T.nx - 1 ? T.nx - 1 : fx;
  fz = fz < 0 ? 0 : fz > T.nz - 1 ? T.nz - 1 : fz;
  let i = Math.floor(fx), j = Math.floor(fz);
  if (i >= T.nx - 1) i = T.nx - 2;
  if (j >= T.nz - 1) j = T.nz - 2;
  const u = fx - i, v = fz - j, nx = T.nx, h = T.h, o = j * nx + i;
  return (h[o] * (1 - u) + h[o + 1] * u) * (1 - v) + (h[o + nx] * (1 - u) + h[o + nx + 1] * u) * v;
}

// Surface slope (rise over run) at x, z; handy for AI speed and debug.
export function slopeAt(x, z, d = 6) {
  const gx = (groundAt(x + d, z) - groundAt(x - d, z)) / (2 * d);
  const gz = (groundAt(x, z + d) - groundAt(x, z - d)) / (2 * d);
  return Math.hypot(gx, gz);
}

// 'land' | 'sand' | 'sea' | null, nearest grid cell.
export function surfaceAt(x, z) {
  if (!T) return null;
  const i = Math.round((x - T.x0) / T.step), j = Math.round((z - T.z0) / T.step);
  if (i < 0 || j < 0 || i >= T.nx || j >= T.nz) return null;
  return ['land', 'sand', 'sea'][T.surf[j * T.nx + i]] || 'land';
}

// ---------- mesh ----------

const C = {
  sand: new THREE.Color(0xf4dc9c),     // city.js PALETTE.sand, so draped beach layers match
  sandDeep: new THREE.Color(0xe2bf7c), // dune hollows
  wetSand: new THREE.Color(0xd9bd83),
  low: new THREE.Color(0x86bf5c),      // valley floors: greener
  mid: new THREE.Color(0xa6bf6c),      // green-tan
  high: new THREE.Color(0xc4bd7c),     // dry ridges: khaki, kept well off the sand colour
  earth: new THREE.Color(0xb39563),    // steep faces
  kurkar: new THREE.Color(0xcf9f5e),   // the sandstone cliff above the northern beach
  lawn: new THREE.Color(0x8cc65e),     // promenade lawns and terraces on top of it
};
const COAST_BAND_M = 260; // metres from the waterline where the cliff and lawn colours apply
let coastI = null;        // per grid row: first column that is not sea

function cellH(i, j) {
  i = i < 0 ? 0 : i >= T.nx ? T.nx - 1 : i;
  j = j < 0 ? 0 : j >= T.nz ? T.nz - 1 : j;
  return T.h[j * T.nx + i];
}
function cellS(i, j) {
  i = i < 0 ? 0 : i >= T.nx ? T.nx - 1 : i;
  j = j < 0 ? 0 : j >= T.nz ? T.nz - 1 : j;
  return T.surf[j * T.nx + i];
}

// Low-frequency value noise so large flat areas are not one flat colour.
function hash(ix, iz) {
  let n = ix * 374761393 + iz * 668265263;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}

const tmpC = new THREE.Color();
// Same direction as SUN_DIR in src/engine/sky.js (not imported, so terrain.js works without the engine).
const SUN = new THREE.Vector3(-140, 85, 40).normalize();
const HILLSHADE_Z = 4;
function vertexColor(i, j, out) {
  const s = cellS(i, j);
  const h = cellH(i, j);
  const st = T.step;
  const gx = (cellH(i + 1, j) - cellH(i - 1, j)) / (2 * st);
  const gz = (cellH(i, j + 1) - cellH(i, j - 1)) / (2 * st);
  const slope = Math.hypot(gx, gz);
  const x = T.x0 + i * st, z = T.z0 + j * st;
  const n = vnoise(x / 260, z / 260) * 0.65 + vnoise(x / 70, z / 70) * 0.35;
  // Height in metres drives the tint so the relief reads even where the toon bands are flat.
  const m = h / T.unitsPerMetre;
  // Coastal strip (see tools/fetch_terrain.py shape_coast): kurkar faces, lawn terraces on top.
  const dc = coastI && coastI[j] >= 0 ? (i - coastI[j]) * (T.meta.stepMetres || 10) : -1;
  vertexColorInland(i, j, s, h, slope, gx, gz, n, m, out);
  // Faces far steeper than any natural Rishon slope are cut rock (the 431 cut under Kiryat Ganim):
  // pale kurkar with shotcrete streaks, not the darkened earth of an ordinary steep bank.
  if (s === SURF_LAND && slope > 0.55) {
    const cw = Math.min(1, (slope - 0.55) / 0.35);
    out.lerp(tmpC2.copy(C.kurkar).lerp(C.sand, 0.25).multiplyScalar(0.9 + vnoise(x / 9, z / 30) * 0.18), cw * cw * (3 - 2 * cw));
  }
  if (s !== SURF_SEA && dc >= 0 && dc < COAST_BAND_M) {
    // Weights, not thresholds: hard cut-offs left kurkar blotches on the lawns wherever the
    // slope wobbled around the limit.
    const sm = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
    const fade = sm((COAST_BAND_M - dc) / 60);
    const lw = sm((m - 3.5) / 1.5) * sm((dc - 35) / 20) * fade;
    const kw = sm((slope - 0.4) / 0.35) * fade;
    if (lw > 0) out.lerp(tmpC2.copy(C.lawn).multiplyScalar(0.94 + n * 0.12), lw);
    if (kw > 0) out.lerp(tmpC2.copy(C.kurkar).lerp(C.earth, Math.min(0.4, Math.max(0, slope - 0.4) * 0.5)), kw);
  }
  return out;
}


const tmpC2 = new THREE.Color();
function vertexColorInland(i, j, s, h, slope, gx, gz, n, m, out) {
  if (s === SURF_SEA) {
    out.copy(C.wetSand);
  } else if (s === SURF_SAND) {
    // Dune hollows a little deeper, crests paler; local relief from the neighbourhood mean.
    const mean = (cellH(i - 4, j) + cellH(i + 4, j) + cellH(i, j - 4) + cellH(i, j + 4)) / 4;
    const rel = THREE.MathUtils.clamp((h - mean) / (3 * T.unitsPerMetre) * 0.5 + 0.5, 0, 1);
    out.copy(C.sandDeep).lerp(C.sand, 0.45 + rel * 0.55);
    if (m < 2.5) out.lerp(C.wetSand, (2.5 - m) / 2.5 * 0.6);
  } else {
    const t = THREE.MathUtils.clamp((m - 15) / 50 + (n - 0.5) * 0.25, 0, 1);
    if (t < 0.5) out.copy(C.low).lerp(C.mid, t * 2);
    else out.copy(C.mid).lerp(C.high, (t - 0.5) * 2);
  }
  // Steep faces turn to earth and darken: that is what makes a slope visible from above.
  const steep = THREE.MathUtils.clamp((slope - 0.06) / 0.25, 0, 1);
  if (s !== SURF_SEA) out.lerp(tmpC.copy(C.earth), steep * 0.55);
  out.multiplyScalar(1 - Math.min(0.3, slope * 1.1));
  // Baked hillshade from the game's low western sun, with the gradient amplified: Rishon's slopes
  // are 2-5 %, too gentle to cross a toon band on their own, so this is what shows the hills.
  if (s !== SURF_SEA) {
    const ax = -gx * HILLSHADE_Z, az = -gz * HILLSHADE_Z;
    const l = Math.hypot(ax, 1, az);
    const lit = (ax * SUN.x + SUN.y + az * SUN.z) / l;
    out.multiplyScalar(THREE.MathUtils.clamp(0.78 + (lit - SUN.y) * 0.9 + 0.22, 0.68, 1.18));
  }
  return out;
}

function buildChunk(i0, j0, i1, j1, material) {
  const w = i1 - i0 + 1, d = j1 - j0 + 1;
  const pos = new Float32Array(w * d * 3), nor = new Float32Array(w * d * 3), colr = new Float32Array(w * d * 3);
  const c = new THREE.Color();
  const st = T.step;
  let k = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++, k += 3) {
      const sea = cellS(i, j) === SURF_SEA;
      pos[k] = T.x0 + i * st;
      pos[k + 2] = T.z0 + j * st;
      pos[k + 1] = sea ? SEA_FLOOR : cellH(i, j) - (CUT ? cutDepth(pos[k], pos[k + 2], CUT_MESH_PAD) : 0);
      // Normals from the heightfield itself, so lighting is continuous across chunk seams.
      const gx = (cellH(i + 1, j) - cellH(i - 1, j)) / (2 * st);
      const gz = (cellH(i, j + 1) - cellH(i, j - 1)) / (2 * st);
      const l = Math.hypot(gx, 1, gz);
      nor[k] = -gx / l; nor[k + 1] = 1 / l; nor[k + 2] = -gz / l;
      vertexColor(i, j, c);
      colr[k] = c.r; colr[k + 1] = c.g; colr[k + 2] = c.b;
    }
  }
  const idx = new Uint16Array((w - 1) * (d - 1) * 6); // 33 x 33 vertices per chunk
  let n = 0;
  for (let j = 0; j < d - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, e = a + w, f = e + 1;
      if (OVR && pos[a * 3] > OVR.box[0] + 1 && pos[b * 3] < OVR.box[2] - 1 && pos[a * 3 + 2] > OVR.box[1] + 1 && pos[e * 3 + 2] < OVR.box[3] - 1) continue;
      // Split each quad along the diagonal that follows the terrain better (less faceting on ridges).
      const ha = pos[a * 3 + 1], hb = pos[b * 3 + 1], he = pos[e * 3 + 1], hf = pos[f * 3 + 1];
      if (Math.abs(ha - hf) <= Math.abs(hb - he)) { idx.set([a, e, f, a, f, b], n); }
      else { idx.set([a, e, b, b, e, f], n); }
      n += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  g.setIndex(new THREE.BufferAttribute(n < idx.length ? idx.subarray(0, n) : idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  // Hills here are gentle; self-shadowing would cost a second pass of the whole field for nothing.
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// Same soft three-band ramp as the city's ground layers, so the terrain and the draped grass,
// sidewalks and roads on it shade alike. Without a ramp the material renders far too dark here.
function groundRamp() {
  const t = new THREE.DataTexture(new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// Builds the ground mesh over the whole grid (playable bounds plus the scenery margin).
// `bounds` is accepted for the contract; the grid already covers it with a margin.
export function buildTerrain(scene, { bounds } = {}) {
  const group = new THREE.Group();
  group.name = 'terrain';
  if (T && !coastI) {
    coastI = new Int32Array(T.nz).fill(-1);
    for (let j = 0; j < T.nz; j++) {
      let seen = false;
      for (let i = 0; i < T.nx; i++) {
        const sea = T.surf[j * T.nx + i] === SURF_SEA;
        if (sea) seen = true;
        else if (seen) { coastI[j] = i; break; }
      }
    }
  }
  if (!T) { console.warn('[terrain] buildTerrain before loadTerrain; nothing drawn.'); scene.add(group); return { group }; }
  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: groundRamp(),
    // Pushed back in depth so draped road, sidewalk and grass layers a few cm above always win.
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
  });
  let chunks = 0;
  for (let j0 = 0; j0 < T.nz - 1; j0 += CHUNK_CELLS) {
    for (let i0 = 0; i0 < T.nx - 1; i0 += CHUNK_CELLS) {
      const i1 = Math.min(i0 + CHUNK_CELLS, T.nx - 1), j1 = Math.min(j0 + CHUNK_CELLS, T.nz - 1);
      group.add(buildChunk(i0, j0, i1, j1, material));
      chunks++;
    }
  }
  group.userData.chunks = chunks;
  group.userData.bounds = bounds || null;
  scene.add(group);
  return { group };
}
