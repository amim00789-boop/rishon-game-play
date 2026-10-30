// GPS: shortest routes over the city's ways and a guidance ribbon of chevrons on the ground.
//
//   const gps = getGps({ scene, city, collision, surface });   // one per scene, shared
//   const r = gps.route(from, to, { mode: 'car' | 'wheels' | 'walk' })  // -> { ok, points: [{x,z}], length, mode }
//   gps.guide(to, { mode, path?, owner? }) // show the ribbon to `to`; re-routes when the player strays
//   gps.update(dt, player, owner?)   // every frame; only the guide's owner (opts.owner) drives it
//   gps.clear()
//   HUD: gps.active, gps.path (full current route), gps.remaining() (from the player on),
//        gps.distanceLeft, gps.target, gps.version (bumps on every new route), gps.onChange(fn)
//
// Networks (one graph, costs per mode):
//   car    - carriageways only, one-ways respected, bigger roads preferred.
//   wheels - scooter / bike: cycleways, sidewalks, footways and zebra crossings first, quiet
//            streets next, main roads only when nothing else connects, stairs only to save a
//            long detour; never motorways.
//   walk   - sidewalks, footways, paths, steps, crossings; streets only as a last resort.
// Wheel and walk routes are pushed sideways off lamps, trees, benches and parked cars (the
// collision world's props), so the riding line the ribbon draws is clear.
import * as THREE from 'three';

const Q = 0.5;           // node merge grid (world units)
const CELL = 12;         // spatial grid for nodes and segments
const STITCH_R = 9;      // loose ends of sidewalks / footways / crossings join the nearest way within this
const CAR_STITCH_R = 3.5; // carriageway ends rejoin the nearest carriageway within this
const C = { CAR: 0, FOOT: 1, STEPS: 2, CYCLE: 3, CROSS: 4, LINK: 5, CARLINK: 6 };
const FOOT_KINDS = /^(footway|path|pedestrian|promenade|track|bridleway|corridor|platform)$/;
const MODE_ALIAS = { scooter: 'wheels', bike: 'wheels', bicycle: 'wheels', foot: 'walk', walk: 'walk', car: 'car', wheels: 'wheels', bus: 'bus' };
const H_FACTOR = { car: 0.85, wheels: 0.8, walk: 1, bus: 0.8 };
const CLEAR = { car: 0, wheels: 2.0, walk: 1.4, bus: 0 };
const STRAY = { car: 22, wheels: 13, walk: 10, bus: 22 };

export const gpsMode = (m) => MODE_ALIAS[m] || 'walk';

// Edge cost multiplier for a mode; Infinity = not allowed.
function cost(mode, cls, rank, against) {
  // A city bus (the line-5 job): the main roads; a neighbourhood street only when there is no other
  // way, and never a service lane or a living street (founder 2026-10-30: "not into the neighbourhoods").
  if (mode === 'bus') {
    if (cls === C.CARLINK) return 1;
    if (cls !== C.CAR || against) return Infinity;
    return rank >= 6 ? 0.8 : rank >= 5 ? 0.9 : rank >= 4 ? 1.3 : rank >= 3 ? 4 : Infinity;
  }
  if (mode === 'car') {
    if (cls === C.CARLINK) return 1;
    if (cls !== C.CAR || against) return Infinity;
    return rank >= 6 ? 0.85 : rank >= 5 ? 0.95 : rank <= 2 ? 1.5 : 1;
  }
  if (cls === C.CAR) {
    if (rank >= 8) return Infinity;
    if (mode === 'wheels') return (rank >= 6 ? 2.4 : rank >= 3 ? 1.6 : 1.15) * (against ? 1.5 : 1);
    return rank >= 6 ? 4 : rank >= 3 ? 2.5 : 1.3;
  }
  // Stairs: a scooter or bike can bump down a short flight (the beach stairs), but only when the
  // way round is much longer.
  if (cls === C.STEPS) return mode === 'walk' ? 1.3 : 4;
  if (cls === C.CYCLE) return mode === 'wheels' ? 0.8 : 1.1;
  if (cls === C.LINK) return 1.15;
  if (cls === C.CARLINK) return mode === 'wheels' ? 1.6 : 2.5;
  return 1; // FOOT, CROSS
}

// ---------------------------------------------------------------------------------------------
// Graph (built once per city, lazily: ~0.5 s for the whole map)

// The build is a generator that yields every few thousand items: warm() runs it in 10 ms slices
// in the background, and a route asked for before it is done finishes it on the spot.
const graphs = new WeakMap(), building = new WeakMap();
export function cityGraph(city) {
  let g = graphs.get(city);
  if (g) return g;
  const it = building.get(city) || buildGraph(city);
  let r;
  while (!(r = it.next()).done);
  graphs.set(city, r.value);
  building.delete(city);
  return r.value;
}
export function warmGraph(city, sliceMs = 10) {
  if (!city || graphs.has(city)) return Promise.resolve(graphs.get(city));
  if (!building.has(city)) building.set(city, buildGraph(city));
  return new Promise((resolve) => {
    const step = () => {
      if (graphs.has(city)) { resolve(graphs.get(city)); return; }
      const it = building.get(city);
      if (!it) { resolve(cityGraph(city)); return; }
      const end = performance.now() + sliceMs;
      let r;
      while (!(r = it.next()).done) if (performance.now() > end) { setTimeout(step, 0); return; }
      graphs.set(city, r.value);
      building.delete(city);
      resolve(r.value);
    };
    setTimeout(step, 0);
  });
}

function* buildGraph(city) {
  const t0 = performance.now();
  let work = 0;
  const tick = () => (++work & 1023) === 0;
  const X = [], Z = [];
  // Nodes merge within MERGE units (a hash of 1-unit cells), so ways that meet at a shared OSM
  // node join even when rounding put their copies in neighbouring cells.
  const MERGE = 0.35, ncell = new Map();
  const nk = (ix, iz) => ix * 1000003 + iz;
  const node = (x, z) => {
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const l = ncell.get(nk(ix, iz));
      if (l) for (const i of l) if (Math.abs(X[i] - x) < MERGE && Math.abs(Z[i] - z) < MERGE) return i;
    }
    const i = X.length;
    X.push(x); Z.push(z);
    const k = nk(cx, cz);
    (ncell.get(k) || ncell.set(k, []).get(k)).push(i);
    return i;
  };
  // Edges before splitting: a, b, class, rank, oneway, line id. Lines remember their two ends.
  const E = { a: [], b: [], cls: [], rank: [], one: [], line: [] };
  const ends = []; // [node, line, isCar]
  let lineId = 0;
  const addLine = (pts, cls, rank = 0, oneway = false) => {
    if (!pts || pts.length < 2) return;
    const line = lineId++;
    let prev = -1, first = -1;
    for (const p of pts) {
      const x = p[0] ?? p.x, z = p[1] ?? p.z;
      const i = node(x, z);
      if (first < 0) first = i;
      if (prev >= 0 && prev !== i) { E.a.push(prev); E.b.push(i); E.cls.push(cls); E.rank.push(rank); E.one.push(oneway ? 1 : 0); E.line.push(line); }
      prev = i;
    }
    if (first !== prev) { ends.push([first, line, cls === C.CAR]); ends.push([prev, line, cls === C.CAR]); }
  };
  for (const r of city.roads || []) {
    if (tick()) yield;
    if (!r || !r.points || r.kind === 'rail') continue;
    if (r.rank != null) addLine(r.points, C.CAR, r.rank, !!r.oneway);
    else if (r.kind === 'steps') addLine(r.points, C.STEPS);
    else if (r.kind === 'cycleway') addLine(r.points, C.CYCLE);
    else if (FOOT_KINDS.test(r.kind || '')) addLine(r.points, C.FOOT);
  }
  for (const s of city.sidewalks || []) { if (tick()) yield; addLine(s.points, C.FOOT); }
  for (const c of city.crossings || []) {
    // A zebra runs across the road: its tangent is the road's direction.
    const tx = Math.sin(c.angle), tz = Math.cos(c.angle), nx = tz, nz = -tx;
    const h = (c.width || 10) / 2 + 1.2;
    addLine([[c.x - nx * h, c.z - nz * h], [c.x + nx * h, c.z + nz * h]], C.CROSS);
  }

  // Segment grids, one for carriageways and one for everything walkable.
  const gkey = (ix, iz) => ix * 100003 + iz;
  const carSegs = new Map(), footSegs = new Map();
  const nEdges = E.a.length;
  for (let e = 0; e < nEdges; e++) {
    if (tick()) yield;
    const grid = E.cls[e] === C.CAR ? carSegs : footSegs;
    const a = E.a[e], b = E.b[e];
    const x0 = Math.floor(Math.min(X[a], X[b]) / CELL), x1 = Math.floor(Math.max(X[a], X[b]) / CELL);
    const z0 = Math.floor(Math.min(Z[a], Z[b]) / CELL), z1 = Math.floor(Math.max(Z[a], Z[b]) / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const k = gkey(ix, iz);
      let l = grid.get(k);
      if (!l) { l = []; grid.set(k, l); }
      l.push(e);
    }
  }
  // The nearest point on a segment of another line within R: { e, t, d } or null.
  const nearestSeg = (grid, x, z, line, R) => {
    let best = null, bd = R;
    const r = Math.ceil(R / CELL), cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let ix = cx - r; ix <= cx + r; ix++) for (let iz = cz - r; iz <= cz + r; iz++) {
      const l = grid.get(gkey(ix, iz));
      if (!l) continue;
      for (const e of l) {
        if (E.line[e] === line) continue;
        const a = E.a[e], b = E.b[e];
        const vx = X[b] - X[a], vz = Z[b] - Z[a], l2 = vx * vx + vz * vz || 1e-9;
        let tt = ((x - X[a]) * vx + (z - Z[a]) * vz) / l2;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const d = Math.hypot(X[a] + vx * tt - x, Z[a] + vz * tt - z);
        if (d < bd) { bd = d; best = { e, t: tt, d }; }
      }
    }
    return best;
  };

  // Every line end joins the nearest other line: carriageways rejoin carriageways (T-junctions
  // whose shared node was simplified away, split dual carriageways), walkable ends join the
  // nearest walkable way, else a street centre line close by.
  const splits = new Map(); // edge -> [{ t, node }]
  const links = [];         // [a, b, cls]
  const attach = (i, hit, cls) => {
    const a = E.a[hit.e], b = E.b[hit.e];
    const len = Math.hypot(X[b] - X[a], Z[b] - Z[a]);
    let j;
    if (hit.t * len < 0.6) j = a;
    else if ((1 - hit.t) * len < 0.6) j = b;
    else {
      j = node(X[a] + (X[b] - X[a]) * hit.t, Z[a] + (Z[b] - Z[a]) * hit.t);
      (splits.get(hit.e) || splits.set(hit.e, []).get(hit.e)).push({ t: hit.t, node: j });
    }
    if (j !== i) links.push([i, j, cls]);
  };
  for (const [i, line, isCar] of ends) {
    if (tick()) yield;
    if (isCar) {
      const hit = nearestSeg(carSegs, X[i], Z[i], line, CAR_STITCH_R);
      if (hit) attach(i, hit, C.CARLINK);
    } else {
      const hit = nearestSeg(footSegs, X[i], Z[i], line, STITCH_R) || nearestSeg(carSegs, X[i], Z[i], line, 4);
      if (hit) attach(i, hit, C.LINK);
    }
  }

  // Final edge list with splits applied, then CSR adjacency in both directions.
  const fa = [], fb = [], fc = [], fr = [], fo = [];
  const push = (a, b, c, r, o) => { if (a !== b) { fa.push(a); fb.push(b); fc.push(c); fr.push(r); fo.push(o); } };
  for (let e = 0; e < nEdges; e++) {
    if (tick()) yield;
    const sp = splits.get(e);
    if (!sp) { push(E.a[e], E.b[e], E.cls[e], E.rank[e], E.one[e]); continue; }
    sp.sort((p, q) => p.t - q.t);
    let prev = E.a[e];
    for (const s of sp) { push(prev, s.node, E.cls[e], E.rank[e], E.one[e]); prev = s.node; }
    push(prev, E.b[e], E.cls[e], E.rank[e], E.one[e]);
  }
  for (const [a, b, c] of links) push(a, b, c, 0, 0);
  const n = X.length, m = fa.length;
  const off = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) { off[fa[e] + 1]++; off[fb[e] + 1]++; }
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const fill = off.slice(0, n);
  const to = new Int32Array(2 * m), len = new Float32Array(2 * m), cls = new Uint8Array(2 * m), rank = new Uint8Array(2 * m), against = new Uint8Array(2 * m);
  for (let e = 0; e < m; e++) {
    if (tick()) yield;
    const a = fa[e], b = fb[e], l = Math.hypot(X[b] - X[a], Z[b] - Z[a]);
    let k = fill[a]++; to[k] = b; len[k] = l; cls[k] = fc[e]; rank[k] = fr[e]; against[k] = 0;
    k = fill[b]++; to[k] = a; len[k] = l; cls[k] = fc[e]; rank[k] = fr[e]; against[k] = fo[e];
  }
  const xs = Float64Array.from(X), zs = Float64Array.from(Z);
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    if (tick()) yield;
    const k = gkey(Math.floor(xs[i] / CELL), Math.floor(zs[i] / CELL));
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  }
  return { n, xs, zs, off, to, len, cls, rank, against, grid, gkey, ms: Math.round(performance.now() - t0), edges: m, links: links.length,
    g: new Float64Array(n), from: new Int32Array(n), stamp: new Int32Array(n), gen: 0 };
}

function canUse(G, i, mode) {
  for (let k = G.off[i]; k < G.off[i + 1]; k++) if (cost(mode, G.cls[k], G.rank[k], G.against[k]) < Infinity) return true;
  return false;
}

function nearestNode(G, x, z, mode, maxR = 400) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  let best = -1, bd = Infinity;
  for (let ring = 0; ring * CELL < maxR; ring++) {
    for (let ix = cx - ring; ix <= cx + ring; ix++) for (let iz = cz - ring; iz <= cz + ring; iz++) {
      if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== ring) continue;
      for (const i of G.grid.get(G.gkey(ix, iz)) || []) {
        const d = (G.xs[i] - x) ** 2 + (G.zs[i] - z) ** 2;
        if (d < bd && canUse(G, i, mode)) { bd = d; best = i; }
      }
    }
    // Anything found within this ring is at most (ring + 1) cells away; one more ring settles it.
    if (best >= 0 && Math.sqrt(bd) < ring * CELL) break;
  }
  return best;
}

function astar(G, s, e, mode) {
  const gen = ++G.gen;
  const { xs, zs, off, to, len, cls, rank, against, g, from, stamp } = G;
  const hf = H_FACTOR[mode];
  const h = (i) => Math.hypot(xs[i] - xs[e], zs[i] - zs[e]) * hf;
  const heapF = [], heapI = [];
  const push = (f, i) => {
    heapF.push(f); heapI.push(i);
    let c = heapF.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (heapF[p] <= heapF[c]) break; [heapF[p], heapF[c]] = [heapF[c], heapF[p]]; [heapI[p], heapI[c]] = [heapI[c], heapI[p]]; c = p; }
  };
  const pop = () => {
    const i = heapI[0];
    const lf = heapF.pop(), li = heapI.pop();
    if (heapF.length) {
      heapF[0] = lf; heapI[0] = li;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === c) break;
        [heapF[m], heapF[c]] = [heapF[c], heapF[m]]; [heapI[m], heapI[c]] = [heapI[c], heapI[m]];
        c = m;
      }
    }
    return i;
  };
  stamp[s] = gen; g[s] = 0; from[s] = -1;
  push(h(s), s);
  let found = false;
  for (let guard = 0; heapF.length && guard < 3e6; guard++) {
    const f = heapF[0];
    const i = pop();
    if (i === e) { found = true; break; }
    if (f - h(i) > g[i] + 1e-6) continue; // stale heap entry
    for (let k = off[i]; k < off[i + 1]; k++) {
      const c = cost(mode, cls[k], rank[k], against[k]);
      if (c === Infinity) continue;
      const j = to[k], ng = g[i] + len[k] * c;
      if (stamp[j] !== gen || ng < g[j]) { stamp[j] = gen; g[j] = ng; from[j] = i; push(ng + h(j), j); }
    }
  }
  if (!found) return null;
  const out = [];
  for (let i = e; i >= 0; i = from[i]) out.push({ x: xs[i], z: zs[i] });
  return out.reverse();
}

// ---------------------------------------------------------------------------------------------
// Polyline helpers

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return L;
}

export function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [{ x: pts[0].x, z: pts[0].z }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    let d = step - carry;
    while (d <= L) { out.push({ x: a.x + ((b.x - a.x) * d) / L, z: a.z + ((b.z - a.z) * d) / L }); d += step; }
    carry = L - (d - step);
  }
  const last = pts[pts.length - 1], tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > step * 0.3) out.push({ x: last.x, z: last.z });
  else { tail.x = last.x; tail.z = last.z; }
  return out;
}

// Clearance probe against the collision world's nearby polygons (props, cars, walls, buildings).
// CollisionWorld.isFree scans every polygon for containment, which is far too slow per sample.
export function clearAt(collision, x, z, r) {
  if (!collision || !collision._gather) return true;
  const near = collision._gather(x - r, z - r, x + r, z + r, clearAt.tmp || (clearAt.tmp = new Set()));
  const polys = clearAt.polys || (clearAt.polys = new Set());
  polys.clear();
  for (const si of near) {
    const s = collision.segs[si];
    const p = collision.polys[s.poly];
    if (p.kind === 'sea' || p.kind === 'water') { polys.add(s.poly); continue; }
    const vx = s.bx - s.ax, vz = s.bz - s.az, l2 = vx * vx + vz * vz || 1e-9;
    let t = ((x - s.ax) * vx + (z - s.az) * vz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if ((s.ax + vx * t - x) ** 2 + (s.az + vz * t - z) ** 2 < r * r) return false;
    polys.add(s.poly);
  }
  for (const pi of polys) {
    const p = collision.polys[pi];
    if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
    if (pointInPoly(x, z, p.pts)) return false;
  }
  return true;
}
function pointInPoly(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Largest clear radius at a point, from a few probes (for placing rings on a clear stretch).
export function clearance(collision, x, z, radii = [5, 4, 3, 2.5, 2, 1.5, 1]) {
  for (const r of radii) if (clearAt(collision, x, z, r)) return r;
  return 0;
}

// Push samples sideways off obstacles, keeping the line smooth: each sample tries growing
// offsets on both sides, then the offsets are eased so the ribbon does not zigzag.
function clearLine(collision, pts, r) {
  if (!collision || r <= 0 || pts.length < 3) return pts;
  const n = pts.length, offs = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) {
    if (clearAt(collision, pts[i].x, pts[i].z, r)) continue;
    const a = pts[i - 1], b = pts[i + 1];
    const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
    const nx = tz / tl, nz = -tx / tl;
    for (const o of [0.8, -0.8, 1.6, -1.6, 2.4, -2.4, 3.2, -3.2, 4, -4, 5, -5]) {
      if (clearAt(collision, pts[i].x + nx * o, pts[i].z + nz * o, r)) { offs[i] = o; break; }
    }
  }
  const eased = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0, peak = 0;
    for (let k = -3; k <= 3; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const wt = 4 - Math.abs(k);
      s += offs[j] * wt; w += wt;
      if (Math.abs(offs[j]) > Math.abs(peak) && Math.abs(k) <= 1) peak = offs[j];
    }
    // Never ease a needed push away: the sample itself keeps at least its own offset.
    eased[i] = Math.abs(offs[i]) > Math.abs(s / w) ? offs[i] : s / w;
    if (!offs[i] && peak && Math.sign(peak) !== Math.sign(eased[i])) eased[i] = 0;
  }
  return pts.map((p, i) => {
    if (!eased[i]) return p;
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
    const q = { x: p.x + (tz / tl) * eased[i], z: p.z + (-tx / tl) * eased[i] };
    return clearAt(collision, q.x, q.z, r * 0.7) ? q : p;
  });
}

// ---------------------------------------------------------------------------------------------
// Guidance ribbon

const MAX_CHEV = 90, CHEV_STEP = 4.2, AHEAD = 340;

function chevronGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-1.5, -0.7); s.lineTo(0, 0.8); s.lineTo(1.5, -0.7); s.lineTo(1.5, -1.6); s.lineTo(0, -0.1); s.lineTo(-1.5, -1.6); s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2); // flat on the ground, tip toward -z ... turned to +z below
  g.rotateY(Math.PI);
  return g;
}

export function getGps(deps) {
  const scene = deps.scene;
  if (scene && scene.userData.gps) { scene.userData.gps.setDeps(deps); return scene.userData.gps; }
  const gps = createGps(deps);
  if (scene) scene.userData.gps = gps;
  return gps;
}

export function createGps(deps = {}) {
  let { city, collision } = deps;
  let surface = typeof deps.surface === 'function' ? deps.surface : (city && city.heightAt ? (x, z, y) => city.heightAt(x, z, y) : () => 0);
  const listeners = [];
  // Readable on pale sidewalks, asphalt and sand alike: a dark casing under a bright band, and
  // bright chevrons with a dark outline that flow toward the target with a travelling glint.
  const STRIP_N = 160, BAND_W = 1.15, CASE_W = 2.0;
  const ribbonMat = (color, opacity, offset) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
  const makeStrip = (name, mat, order) => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(STRIP_N * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < STRIP_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = order;
    m.name = name;
    if (deps.scene) deps.scene.add(m);
    return { geo, pos, m };
  };
  const caseMat = ribbonMat(0x101a2e, 0.82, -2);
  const stripMat = ribbonMat(0x2ec4b6, 0.95, -3);
  const casing = makeStrip('gps-casing', caseMat, 2);
  const band = makeStrip('gps-strip', stripMat, 3);
  const strip = band.m;
  const chev = chevronGeometry();
  const outMat = ribbonMat(0x14213a, 0.9, -4);
  const mat = ribbonMat(0xffffff, 1, -5);
  const makeChevrons = (name, m, order) => {
    const im = new THREE.InstancedMesh(chev, m, MAX_CHEV);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;
    im.renderOrder = order;
    im.name = name;
    if (deps.scene) deps.scene.add(im);
    return im;
  };
  const meshOut = makeChevrons('gps-chevron-outline', outMat, 4);
  const mesh = makeChevrons('gps-ribbon', mat, 5);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CHEV * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const CA = new THREE.Color(0xffffff), CB = new THREE.Color(0xfff07a), CT = new THREE.Color();
  const hide = () => { mesh.count = meshOut.count = 0; band.geo.setDrawRange(0, 0); casing.geo.setDrawRange(0, 0); };
  const M4 = new THREE.Matrix4(), QT = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0);

  const st = { active: false, target: null, mode: 'walk', path: [], cum: [], progress: 0, version: 0, strayT: 0, lastRoute: -9, time: 0, owner: undefined, arrived: false, opts: {} };

  const groundY = (x, z, y = Infinity) => { try { const h = surface(x, z, y); return Number.isFinite(h) ? h : 0; } catch (_) { return 0; } };
  const emit = () => { st.version++; for (const fn of listeners) { try { fn(api); } catch (e) { console.warn('[gps] listener failed', e); } } };

  // Shortest route; points are resampled every 2.5 units and, for wheels and walking, pushed off
  // obstacles. Falls back to a straight line (ok: false) when the networks do not connect.
  function route(from, to, opts = {}) {
    const mode = gpsMode(opts.mode || 'walk');
    const t0 = performance.now();
    let pts = null;
    if (city) {
      const G = cityGraph(city);
      const s = nearestNode(G, from.x, from.z, mode), e = nearestNode(G, to.x, to.z, mode);
      if (s >= 0 && e >= 0) pts = astar(G, s, e, mode);
      // Islands (a footway that never meets a sidewalk): try the street network instead.
      if (!pts && mode !== 'car' && mode !== 'bus') {
        const s2 = nearestNode(G, from.x, from.z, 'car'), e2 = nearestNode(G, to.x, to.z, 'car');
        if (s2 >= 0 && e2 >= 0) pts = astar(G, s2, e2, 'car');
      }
    }
    const ok = !!pts;
    if (!pts) pts = [];
    pts = [{ x: from.x, z: from.z }, ...pts, { x: to.x, z: to.z }];
    // Drop graph points that double back right at the ends (the snap node behind the player).
    trimEnds(pts);
    pts = resample(pts, opts.step || 2.5);
    const clr = opts.clearance ?? CLEAR[mode];
    if (clr > 0 && collision) pts = clearLine(collision, pts, clr);
    return { ok, points: pts, length: polylineLength(pts), mode, ms: Math.round(performance.now() - t0) };
  }

  function trimEnds(pts) {
    for (let k = 0; k < 2 && pts.length > 3; k++) {
      const a = pts[0], b = pts[1], c = pts[2];
      if ((b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z) < 0 && Math.hypot(b.x - a.x, b.z - a.z) < 30) pts.splice(1, 1);
    }
    for (let k = 0; k < 2 && pts.length > 3; k++) {
      const n = pts.length, a = pts[n - 3], b = pts[n - 2], c = pts[n - 1];
      if ((b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z) < 0 && Math.hypot(c.x - b.x, c.z - b.z) < 30) pts.splice(n - 2, 1);
    }
  }

  function setPath(points) {
    st.path = points;
    st.cum = [0];
    for (let i = 1; i < points.length; i++) st.cum.push(st.cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    st.progress = 0;
    st.strayT = 0;
    st.arrived = false;
    emit();
  }

  // Start guidance to `to`. opts: { mode, path (precomputed points), from, color, arrive (radius),
  // reroute (default true), onArrive() }.
  function guide(to, opts = {}) {
    st.active = true;
    st.target = { x: to.x, z: to.z };
    st.mode = gpsMode(opts.mode || st.mode);
    st.opts = opts;
    st.owner = opts.owner;
    stripMat.color.setHex(opts.color ?? 0x2ec4b6);
    const from = opts.from || (deps.player ? deps.player.pos : to);
    setPath(opts.path && opts.path.length > 1 ? opts.path.map((p) => ({ x: p.x, z: p.z })) : route(from, to, { mode: st.mode }).points);
    st.lastRoute = st.time;
    return api;
  }

  function clear() {
    st.active = false; st.target = null; st.path = []; st.cum = []; st.owner = undefined;
    hide();
    emit();
  }

  // Nearest point on the path near the current progress; returns { i, t, d, s } (s = distance along).
  function locate(px, pz) {
    const P = st.path;
    let best = { i: st.progress, t: 0, d: Infinity, s: st.cum[st.progress] || 0 };
    const i0 = Math.max(0, st.progress - 6), i1 = Math.min(P.length - 1, st.progress + 60);
    for (let i = i0; i < i1; i++) {
      const a = P[i], b = P[i + 1];
      const vx = b.x - a.x, vz = b.z - a.z, l2 = vx * vx + vz * vz || 1e-9;
      let t = ((px - a.x) * vx + (pz - a.z) * vz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(a.x + vx * t - px, a.z + vz * t - pz);
      if (d < best.d) best = { i, t, d, s: st.cum[i] + t * (st.cum[i + 1] - st.cum[i]) };
    }
    return best;
  }

  // `owner`: whoever started the current guidance (guide(..., { owner })) drives it; an update
  // from anyone else is ignored, so the quests and a running minigame can both call this.
  function update(dt, player = deps.player, owner = undefined) {
    if (st.owner !== undefined && owner !== st.owner) return;
    st.time += dt;
    if (!st.active || !player || st.path.length < 2) { hide(); return; }
    const px = player.pos.x, pz = player.pos.z;
    const loc = locate(px, pz);
    st.progress = loc.i;
    const arriveR = st.opts.arrive ?? 8;
    if (!st.arrived && Math.hypot(px - st.target.x, pz - st.target.z) < arriveR) {
      st.arrived = true;
      try { st.opts.onArrive && st.opts.onArrive(); } catch (e) { console.warn('[gps] onArrive failed', e); }
    }
    // Off the route for a moment: plan again from here (at most every 1.5 s).
    const stray = st.opts.stray ?? STRAY[st.mode];
    st.strayT = loc.d > stray ? st.strayT + dt : 0;
    if (st.opts.reroute !== false && st.strayT > 0.8 && st.time - st.lastRoute > 1.5) {
      st.lastRoute = st.time;
      setPath(route({ x: px, z: pz }, st.target, { mode: st.mode }).points);
      return;
    }
    drawRibbon(loc, player);
  }

  function drawRibbon(loc, player) {
    const P = st.path, cum = st.cum;
    const total = cum[cum.length - 1];
    // Chevrons start a little ahead of the player and flow toward the target.
    const phase = (st.time * 6) % CHEV_STEP;
    let s = loc.s + 3 + phase, k = 0, i = loc.i;
    let y = player.y ?? groundY(player.pos.x, player.pos.z);
    while (k < MAX_CHEV && s < total - 1 && s < loc.s + AHEAD) {
      while (i < P.length - 2 && cum[i + 1] < s) i++;
      const a = P[i], b = P[i + 1];
      const seg = cum[i + 1] - cum[i] || 1e-6, t = (s - cum[i]) / seg;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      y = groundY(x, z, y + 2);
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      QT.setFromAxisAngle(UP, yaw);
      // Fade the far end by shrinking it; a glint runs along the chevrons toward the target.
      const far = (s - loc.s) / AHEAD;
      const sc = (far > 0.75 ? 1 - (far - 0.75) * 2.4 : 1) * 1.45;
      const glint = Math.max(0, Math.sin((s - loc.s) * 0.11 - st.time * 5));
      const pulse = 1 + 0.12 * glint * glint * glint;
      M4.compose(V.set(x, y + 0.34, z), QT, S.set(sc * 1.32, 1, sc * 1.32));
      meshOut.setMatrixAt(k, M4);
      M4.compose(V.set(x, y + 0.38, z), QT, S.set(sc * pulse, 1, sc * pulse));
      mesh.setMatrixAt(k, M4);
      mesh.setColorAt(k, CT.copy(CA).lerp(CB, glint * glint));
      k++;
      s += CHEV_STEP;
    }
    mesh.count = meshOut.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    meshOut.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Band and casing: from the player along the next stretch, one vertex pair per path point.
    let n = 0, yy = player.y ?? groundY(player.pos.x, player.pos.z);
    const put = (x, z, tx, tz) => {
      const tl = Math.hypot(tx, tz) || 1, ux = tz / tl, uz = -tx / tl;
      yy = groundY(x, z, yy + 2);
      const o = n * 6;
      for (const [P2, w, lift] of [[band.pos, BAND_W, 0.3], [casing.pos, CASE_W, 0.27]]) {
        P2[o] = x + ux * w; P2[o + 1] = yy + lift; P2[o + 2] = z + uz * w;
        P2[o + 3] = x - ux * w; P2[o + 4] = yy + lift; P2[o + 5] = z - uz * w;
      }
      n++;
    };
    const i0 = loc.i, a0 = P[i0], b0 = P[i0 + 1];
    put(a0.x + (b0.x - a0.x) * loc.t, a0.z + (b0.z - a0.z) * loc.t, b0.x - a0.x, b0.z - a0.z);
    for (let j = i0 + 1; j < P.length && n < STRIP_N && cum[j] - loc.s < AHEAD; j++) {
      const p = P[j], q = P[Math.min(P.length - 1, j + 1)], o = P[j - 1];
      put(p.x, p.z, q.x - o.x, q.z - o.z);
    }
    for (const r of [band, casing]) {
      r.geo.attributes.position.needsUpdate = true;
      r.geo.setDrawRange(0, Math.max(0, (n - 1) * 6));
    }
  }

  // The route from the player onward (for the minimap): [{x, z}, ...].
  function remaining() {
    if (!st.active || st.path.length < 2) return [];
    const p = deps.player ? deps.player.pos : st.path[0];
    return [{ x: p.x, z: p.z }, ...st.path.slice(st.progress + 1)];
  }

  const api = {
    route, guide, clear, update, remaining,
    get active() { return st.active; },
    get target() { return st.target; },
    get mode() { return st.mode; },
    get path() { return st.path; },
    get version() { return st.version; },
    get arrived() { return st.arrived; },
    get distanceLeft() { return st.active && st.cum.length ? Math.max(0, st.cum[st.cum.length - 1] - (st.cum[st.progress] || 0)) : 0; },
    onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    // Build the graph ahead of time (it takes about half a second on the full map).
    // Build the graph in the background (10 ms slices); routes asked for before it finishes build the rest at once.
    warm() { return warmGraph(city); },
    get ready() { return !!(city && graphs.has(city)); },
    stats() { const G = city && graphs.get(city); return G ? { nodes: G.n, edges: G.edges, links: G.links, buildMs: G.ms } : null; },
    setDeps(d) {
      if (d.city) city = d.city;
      if (d.collision) collision = d.collision;
      if (typeof d.surface === 'function') surface = d.surface;
      if (d.player) deps.player = d.player;
    },
    mesh, strip, casing: casing.m, outline: meshOut,
  };
  return api;
}
