// Drivable road graph built from city.roads for traffic and street-side parking.
//
// Roads are split into edges at every vertex shared with another road (OSM junction nodes survive
// city.js's densify, so shared vertices are exact) and at their ends. Each edge knows its lanes
// per direction, lane band (median, kerb reserve for parked cars), speed, absolute heights on
// raised parts (replicating city.js's deck/ramp heights), crossings and bus stops along it.
//
// Right-hand normals: for travel along the points (dir +1) the right side is (-dz, dx) with x east
// and z south; for dir -1 it flips. All lane offsets below are measured along the right normal of
// the direction of travel.

const ROAD_LIFT = (rank) => 0.15 + (rank || 0) * 0.008 + 0.03; // city.js roadY + a hair for the tyres

// Speeds in world units per second (SCALE 1.2 u/m; 50 km/h ~ 17 u/s), and spawn density per unit
// length of road (both directions together).
export const CLASS = {
  motorway: { v: 38, dens: 0.03 },
  trunk: { v: 32, dens: 0.026 },
  primary: { v: 24, dens: 0.026 },
  secondary: { v: 21, dens: 0.018 },
  tertiary: { v: 19, dens: 0.012 },
  unclassified: { v: 16, dens: 0.004 },
  residential: { v: 14, dens: 0.0035 },
  living_street: { v: 8, dens: 0.0012 },
  motorway_link: { v: 26, dens: 0.012 },
  trunk_link: { v: 24, dens: 0.01 },
  primary_link: { v: 18, dens: 0.008 },
  secondary_link: { v: 17, dens: 0.006 },
  tertiary_link: { v: 15, dens: 0.004 },
};
const DEFAULT_CLASS = { v: 14, dens: 0.002 };
// Founder, round 3: the street felt too busy. Every class keeps its relative density, one third less.
export const TRAFFIC_DENSITY = 0.67;

// Both follow the 0.85 vehicle scale (models.js VEHICLE_SCALE): the widest parked car is ~3.1 wide.
export const PARK_RESERVE = 3.3; // kerb band a parked car takes (up to 3.1 wide + kerb gap)
export const MOVING_W = 3.1; // narrowest band a moving car needs
const SHOULDER = 0.3;

let groundAt = () => 0;
export const terrainReady = import('../world/terrain.js')
  .then((m) => { if (typeof m.groundAt === 'function') groundAt = m.groundAt; })
  .catch(() => {});
export const ground = (x, z) => groundAt(x, z);
// city.heightAt(x, z, -Infinity) is the bare terrain (no deck is ever within a step of -Infinity), and
// it is ready synchronously, unlike the guarded terrain import above.
export function setGround(fn) { if (typeof fn === 'function') groundAt = fn; }

const keyOf = (x, z) => `${Math.round(x * 4)},${Math.round(z * 4)}`;

// Absolute heights of a raised road, the way city.js computes its deck: ramps ride the terrain plus
// their rise, a deck keeps a straight grade between the ground at its two ends.
function absoluteHeights(pts, ys) {
  const g = pts.map((p) => groundAt(p[0], p[1]));
  const ya = ys.map((y, i) => g[i] + y);
  let base = Infinity;
  for (const y of ys) base = Math.min(base, y);
  if (base <= 0.05) return ya;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  let i = 0;
  while (i < pts.length) {
    if (ys[i] < base - 0.01) { i++; continue; }
    let j = i;
    while (j + 1 < pts.length && ys[j + 1] >= base - 0.01) j++;
    const span = cum[j] - cum[i] || 1;
    for (let k = i; k <= j; k++) ya[k] = g[i] + ((g[j] - g[i]) * (cum[k] - cum[i])) / span + ys[k];
    i = j + 1;
  }
  return ya;
}

function vertexNormals(pts) {
  const n = pts.length, out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let ax = 0, az = 0, bx = 0, bz = 0;
    if (i > 0) { ax = pts[i][0] - pts[i - 1][0]; az = pts[i][1] - pts[i - 1][1]; const l = Math.hypot(ax, az) || 1; ax /= l; az /= l; }
    if (i < n - 1) { bx = pts[i + 1][0] - pts[i][0]; bz = pts[i + 1][1] - pts[i][1]; const l = Math.hypot(bx, bz) || 1; bx /= l; bz /= l; }
    if (i === 0) { ax = bx; az = bz; }
    if (i === n - 1) { bx = ax; bz = az; }
    let tx = ax + bx, tz = az + bz;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-4) { tx = bx; tz = bz; } else { tx /= tl; tz /= tl; }
    // Mitre: keep the lane parallel to both segments, capped so hairpins do not explode.
    const cos = Math.max(0.6, tx * bx + tz * bz);
    out[i * 2] = -tz / cos;
    out[i * 2 + 1] = tx / cos;
  }
  return out;
}

// Spatial grid of edge segments (for nearest-edge queries and spawn sampling).
class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  k(ix, iz) { return ix * 100003 + iz; }
  add(x0, z0, x1, z1, item) {
    const c = this.cell;
    for (let ix = Math.floor(Math.min(x0, x1) / c); ix <= Math.floor(Math.max(x0, x1) / c); ix++) {
      for (let iz = Math.floor(Math.min(z0, z1) / c); iz <= Math.floor(Math.max(z0, z1) / c); iz++) {
        const key = this.k(ix, iz);
        let l = this.map.get(key);
        if (!l) { l = []; this.map.set(key, l); }
        l.push(item);
      }
    }
  }
  near(x, z, r, fn) {
    const c = this.cell;
    for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++) {
      for (let iz = Math.floor((z - r) / c); iz <= Math.floor((z + r) / c); iz++) {
        const l = this.map.get(this.k(ix, iz));
        if (l) for (const it of l) fn(it);
      }
    }
  }
}

// `restrictedAt(x, z)` (src/world/details.js) returns the sealed zone at a point, if any. Roads
// details.js tagged `restricted` (a vertex inside a zone) and roads whose segments cross a sealed
// perimeter between vertices are left out, so no car spawns behind or routes through a closed gate.
function entersZone(r, restrictedAt) {
  if (r.restricted) return true;
  if (!restrictedAt) return false;
  const p = r.points;
  for (let i = 0; i < p.length; i++) {
    if (restrictedAt(p[i][0], p[i][1])) return true;
    if (i === p.length - 1) break;
    const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1];
    const n = Math.floor(Math.hypot(dx, dz) / 3);
    for (let k = 1; k <= n; k++) if (restrictedAt(p[i][0] + (dx * k) / (n + 1), p[i][1] + (dz * k) / (n + 1))) return true;
  }
  return false;
}

// `light` builds only the graph and its spatial index (no overhead clearance, zebras or bus stops):
// enough for the signal plan, which dressing.js needs before traffic exists.
export function buildNetwork(city, { restrictedAt = null, light = false } = {}) {
  const all = (city.roads || []).filter((r) => r && r.rank >= 2 && r.points && r.points.length >= 2 && !/^(rail|promenade)$/.test(r.kind));
  const roads = all.filter((r) => !entersZone(r, restrictedAt));
  const restrictedRoads = all.length - roads.length;
  // Vertex keys used by more than one road (or twice by one) are junction nodes.
  const uses = new Map();
  roads.forEach((r, ri) => {
    const seen = new Set();
    r.points.forEach((p, i) => {
      const k = keyOf(p[0], p[1]);
      const end = i === 0 || i === r.points.length - 1;
      if (seen.has(k) && !end) { uses.set(k, (uses.get(k) || 0) + 2); return; }
      seen.add(k);
      uses.set(k, (uses.get(k) || 0) + (end ? 2 : 1));
    });
  });
  const nodes = new Map();
  const nodeAt = (p) => {
    const k = keyOf(p[0], p[1]);
    let n = nodes.get(k);
    if (!n) { n = { id: nodes.size, x: p[0], z: p[1], edges: [], maxRank: 0, maxHw: 0, busy: -1, busyBy: null }; nodes.set(k, n); }
    return n;
  };

  const edges = [];
  for (const r of roads) {
    const pts = r.points;
    const ya = r.heights && r.heights.some((y) => y > 0.05) ? absoluteHeights(pts, r.heights) : null;
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      const last = i === pts.length - 1;
      if (!last && (uses.get(keyOf(pts[i][0], pts[i][1])) || 0) < 2) continue;
      const sub = pts.slice(start, i + 1);
      const subY = ya ? ya.slice(start, i + 1) : null;
      start = i;
      // Zero-length pieces (duplicate vertices) carry no traffic.
      let L = 0;
      const cum = new Float32Array(sub.length);
      for (let k = 1; k < sub.length; k++) { L += Math.hypot(sub[k][0] - sub[k - 1][0], sub[k][1] - sub[k - 1][1]); cum[k] = L; }
      if (L < 0.3) continue;
      edges.push(makeEdge(r, sub, subY, cum, L, nodeAt(sub[0]), nodeAt(sub[sub.length - 1])));
    }
  }
  edges.forEach((e, i) => {
    e.id = i;
    e.a.edges.push({ e, end: 0 });
    e.b.edges.push({ e, end: 1 });
    for (const n of [e.a, e.b]) { n.maxRank = Math.max(n.maxRank, e.rank); n.maxHw = Math.max(n.maxHw, e.hw); }
  });
  for (const n of nodes.values()) n.deg = n.edges.length;
  if (light) for (const e of edges) e.clear = Infinity; else overheadClearance(city, edges);

  const grid = new Grid(48);
  for (const e of edges) for (let i = 0; i < e.pts.length - 1; i++) grid.add(e.pts[i][0], e.pts[i][1], e.pts[i + 1][0], e.pts[i + 1][1], { e, i });

  // Nearest edge segment to (x, z) within r: { e, i, t, s, d, side } (side +1 = right of the points' direction).
  function nearest(x, z, r = 12, filter = null) {
    let best = null;
    grid.near(x, z, r, ({ e, i }) => {
      if (filter && !filter(e)) return;
      const a = e.pts[i], b = e.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a[0] + dx * t, qz = a[1] + dz * t;
      const d = Math.hypot(x - qx, z - qz);
      if (d > r || (best && d >= best.d)) return;
      const cross = (x - a[0]) * -dz + (z - a[1]) * dx; // > 0: right of travel (x east, z south)
      best = { e, i, t, s: e.cum[i] + t * (e.cum[i + 1] - e.cum[i]), d, side: cross >= 0 ? 1 : -1 };
    });
    return best;
  }

  // ---- crossings (zebras) and bus stops onto edges ----
  for (const c of light ? [] : city.crossings || []) {
    const hit = nearest(c.x, c.z, 3);
    if (!hit) continue;
    const a = hit.e.pts[hit.i], b = hit.e.pts[hit.i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // tx, tz: road direction; the zebra runs across the road, ~5 units along it.
    hit.e.crossings.push({ s: hit.s, x: c.x, z: c.z, tx: (b[0] - a[0]) / l, tz: (b[1] - a[1]) / l, hw: hit.e.hw, r: (c.width || 10) / 2 + 2.5 });
  }
  for (const e of edges) e.crossings.sort((p, q) => p.s - q.s);
  (light ? [] : city.busStops || []).forEach((b, id) => {
    const hit = nearest(b.x, b.z, 18, (e) => e.rank >= 3);
    if (!hit) return;
    // The shelter stands on the sidewalk; buses travelling with it on their right stop there.
    const dir = hit.side;
    if (hit.e.oneway && dir < 0) return;
    hit.e.stops.push({ id, s: hit.s, dir, x: b.x, z: b.z });
  });

  const net = { nodes: [...nodes.values()], edges, grid, nearest, laneOffsets, pointAt, heightAt, lanesFor, restrictedRoads };
  return net;
}

function makeEdge(r, pts, ya, cum, L, a, b) {
  const kind = r.kind;
  const cls = CLASS[kind] || DEFAULT_CLASS;
  const link = /_link$/.test(kind);
  const oneway = !!r.oneway;
  const lanes = Math.max(1, r.lanes || 2);
  const median = !oneway && r.rank >= 6 && !link && lanes >= 4 ? 4.8 : 0;
  return {
    id: -1, road: r, kind, rank: r.rank, link, oneway, lanes, median, hw: r.width / 2, width: r.width,
    pts, cum, L, ya, N: vertexNormals(pts), a, b,
    tunnel: !!r.tunnel, raised: !!ya, lift: ROAD_LIFT(r.rank),
    speed: cls.v, dens: cls.dens * TRAFFIC_DENSITY,
    // Parked-car kerb reserve on the right (+1) and left (-1) of the points' direction.
    parkR: 0, parkL: 0,
    crossings: [], stops: [],
  };
}

// Lanes in one direction and their lateral band [inner, outer] along the travel right normal.
function lanesFor(e, dir) {
  const hw = e.hw;
  const resR = (dir > 0 ? e.parkR : e.parkL) || SHOULDER;
  const resL = (dir > 0 ? e.parkL : e.parkR) || SHOULDER;
  if (e.oneway) {
    // dir is always +1 on a one-way; the band spans the whole carriageway.
    return { n: e.lanes, inner: -hw + resL, outer: hw - resR };
  }
  const n = Math.max(1, Math.floor(e.lanes / 2));
  const inner = e.median ? e.median / 2 + 0.3 : 0.08;
  return { n, inner, outer: Math.max(inner + MOVING_W, hw - resR) };
}

// Lateral offset (right of travel) for lane index `lane` (0 = innermost) and a vehicle of half width hw.
function laneOffsets(e, dir, lane, halfW = 1.4, kerbHug = false) {
  const b = lanesFor(e, dir);
  const lw = (b.outer - b.inner) / b.n;
  const l = Math.max(0, Math.min(b.n - 1, lane));
  if (kerbHug) return Math.max(b.inner + halfW, b.outer - halfW - 0.25);
  let o = b.inner + (l + 0.5) * lw;
  // A wide vehicle in a narrow lane keeps clear of the parked cars and kerb rather than the centre line.
  if (o + halfW > b.outer - 0.05) o = Math.max(b.inner + halfW * 0.6, b.outer - halfW - 0.05);
  return o;
}

// Point at arc length s along e, offset `off` along the right normal of the points' direction.
// Writes { x, z, dx, dz, i } into out. `hint` speeds up the segment search.
function pointAt(e, s, off, out, hint = -1) {
  const cum = e.cum, n = e.pts.length;
  if (s <= 0) s = 0; else if (s >= e.L) s = e.L;
  let i = hint;
  if (i < 0 || i >= n - 1 || cum[i] > s || cum[i + 1] < s) {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    i = lo;
  }
  const a = e.pts[i], b = e.pts[i + 1];
  const sl = cum[i + 1] - cum[i] || 1e-6;
  const t = (s - cum[i]) / sl;
  const N = e.N;
  const nx = N[i * 2] + (N[i * 2 + 2] - N[i * 2]) * t, nz = N[i * 2 + 1] + (N[i * 2 + 3] - N[i * 2 + 1]) * t;
  out.x = a[0] + (b[0] - a[0]) * t + nx * off;
  out.z = a[1] + (b[1] - a[1]) * t + nz * off;
  out.dx = (b[0] - a[0]) / sl;
  out.dz = (b[1] - a[1]) / sl;
  out.i = i;
  out.t = t;
  return out;
}

// Free height under the lowest deck that crosses over each edge (e.clear, Infinity when nothing
// does), so tall vehicles can keep off low underpasses. Every raised way counts, rail bridges too.
// city.js lifts a deck at least DECK + DECK_MARGIN (8.4) over what it crosses and the slab is 1.3
// thick, so a plain underpass clears about 7; ramps that dip lower show up here as less.
const SLAB = 1.3;
function overheadClearance(city, edges) {
  for (const e of edges) e.clear = Infinity;
  const decks = new Grid(48);
  for (const r of city.roads || []) {
    if (!r.points || r.points.length < 2 || !r.heights || !r.heights.some((y) => y > 2)) continue;
    const ya = absoluteHeights(r.points, r.heights);
    for (let i = 0; i < r.points.length - 1; i++) {
      if (r.heights[i] < 2 && r.heights[i + 1] < 2) continue; // only the raised stretches
      const a = r.points[i], b = r.points[i + 1];
      decks.add(a[0], a[1], b[0], b[1], { r, a, b, ya: ya[i], yb: ya[i + 1] });
    }
  }
  for (const e of edges) {
    for (let i = 0; i < e.pts.length - 1; i++) {
      const p = e.pts[i], q = e.pts[i + 1];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2, half = Math.hypot(q[0] - p[0], q[1] - p[1]) / 2;
      decks.near(mx, mz, half + 1, (d) => {
        if (d.r === e.road) return;
        // plan-view crossing of p-q with a-b
        const rx = q[0] - p[0], rz = q[1] - p[1], sx = d.b[0] - d.a[0], sz = d.b[1] - d.a[1];
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-9) return;
        const wx = d.a[0] - p[0], wz = d.a[1] - p[1];
        const t = (wx * sz - wz * sx) / den, u = (wx * rz - wz * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) return;
        const x = p[0] + rx * t, z = p[1] + rz * t;
        const below = e.ya ? e.ya[i] + (e.ya[i + 1] - e.ya[i]) * t : groundAt(x, z);
        const gap = d.ya + (d.yb - d.ya) * u - SLAB - below;
        if (gap > 1 && gap < e.clear) e.clear = gap; // under 1: a ramp merging at grade, not a deck
      });
    }
  }
}

// Road surface height at arc length s (raised parts) or at (x, z) on the terrain.
function heightAt(e, s, x, z, i = -1, t = 0) {
  if (e.ya) {
    if (i < 0) {
      const cum = e.cum;
      let lo = 0, hi = e.pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      i = lo;
      t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1e-6);
    }
    return e.ya[i] + (e.ya[i + 1] - e.ya[i]) * t + e.lift;
  }
  return groundAt(x, z) + e.lift;
}
