// Moshe Dayan interchange, designed on its own: pure data, no three.js.
//
// Input: the OSM cut (data/dayan.osm.json) and the game's ground function (src/world/terrain.js
// groundAt), so every height here is in the game's own frame and the result can be dropped into
// the game at the same place.
//
// Output (createDesign): roads with per-vertex heights and lane data, the bridge band (one deck
// carrying both carriageways and a central barrier), a graded ground grid, retaining walls and
// parapets where the ground steps, the station (platforms, stairs), signals and crossings, and the
// two things the game needs to stand on it: heightAt(x, z, y) and colliders, with exactly the
// contracts of city.js heightAt and engine/collision.js polygons.
//
// Why the cross-sections are re-laid here: the game widens every lane by 1.4 (city.js WIDEN) but
// keeps the OSM centre lines, so the two bridge carriageways overlapped by ~9 u and there was no
// room for a divider, and the Ayalon edges ran over the rails. The lab moves centre lines where the
// widened cross-sections need it and fades the move back into the connecting roads.

export const SCALE = 1.2;
export const WIDEN = 1.4;
export const U = (m) => m * SCALE * WIDEN;
export const LANE = U(3.5);
export const SW = U(2.8);          // sidewalk strip
export const KERB = 0.25;          // sidewalk top above the asphalt
export const STEP_UP = 0.6;        // city.js STEP_UP
export const SNAP_BAND = 1.0;      // city.js SNAP_BAND
export const FREE = 8.6;           // free height under a deck (coach 7.45 + margin), city.js DECK
export const DECK_DEPTH = 2.1;     // asphalt to soffit at mid span
export const CLEAR = FREE + DECK_DEPTH;
export const MAX_GRADE = 0.055;    // design grade for ramps and approaches (curves add up to ~1.5 %)
export const PARAPET_H = 2.2;      // solid collider height on a deck edge (game value)
export const BARRIER_H = 1.1;      // New Jersey barrier
export const PLAT_H = 1.7;         // platform top above the track bed (rail head ~0.6 above it)
export const STAIR_W = U(1.85);   // narrower than city.js: the OSM island platforms are only 8.2-8.8 u wide and a walker must pass beside the flight
export const STAIR_GRADE = 0.6;
export const GRID = 2;             // graded ground resolution

// Road classes, same widths as city.js RC (lanes x 3.5 m + extra, widened).
export const RC = {
  motorway: { rank: 9, lanes: 6, lanes1: 3, extra: 3.5, urban: false },
  motorway_link: { rank: 6, lanes: 2, lanes1: 1, extra: 3, link: true },
  trunk: { rank: 8, lanes: 4, lanes1: 2, extra: 3 },
  primary: { rank: 7, lanes: 4, lanes1: 2, extra: 1, urban: true },
  primary_link: { rank: 5, lanes: 2, lanes1: 1, extra: 2, urban: true, link: true },
  secondary: { rank: 6, lanes: 2, lanes1: 2, extra: 3, urban: true },
  tertiary: { rank: 5, lanes: 2, lanes1: 1, extra: 3, urban: true },
  unclassified: { rank: 3, lanes: 2, lanes1: 1, extra: 3, urban: true },
  residential: { rank: 3, lanes: 2, lanes1: 1, extra: 3, urban: true },
  living_street: { rank: 2, lanes: 1, lanes1: 1, extra: 3, urban: true },
  service: { rank: 1, lanes: 1, lanes1: 1, extra: 1 },
};
export const PATHS = { footway: 2.5, path: 2, cycleway: 2.5, pedestrian: 8, steps: 2.5, track: 3 };

// Design decisions for this interchange, in one place (see docs/DAYAN_LAB.md).
export const PLAN = {
  deckWays: { eb: 98868545, wb: 98868546 },   // OSM bridge=yes layer=2 carriageways
  ayalon: { sb: [220398876, 220398875, 220398887], nb: [457662448] },
  // Cross-section of the bridge, north (WB) to south (EB): parapet | sidewalk | WB lanes | barrier | EB lanes | sidewalk | parapet
  deck: { parapetW: 0.6, outerShoulder: 0.9, innerShoulder: 0.7, barrierW: 1.2, sidewalk: SW },
  deckMargin: 7,         // deck runs this far past the last thing that passes under it
  fade: 80,              // a moved centre line fades back to OSM over this length
  corridorGap: 3.2,      // Ayalon carriageway edge to ballast / platform edge (wall + shoulder)
  stairsFrom: 'edges',   // station stairs leave the deck edges, one per island platform per side
};

// ---------- small geometry ----------
const hyp = Math.hypot;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
function segClosest(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t, cz = az + dz * t;
  return { t, d: hyp(px - cx, pz - cz), cx, cz, side: Math.sign(dx * (pz - az) - dz * (px - ax)) };
}
export function inPoly(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segInter(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u, x: a[0] + r[0] * t, z: a[1] + r[1] * t } : null;
}
// Per-vertex unit normals n = (-dz, dx), mitred at bends. With x east and z south, n points to
// the RIGHT of the direction of travel (east -> south).
export function normals(pts) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = hyp(dx, dz) || 1; dx /= l; dz /= l;
    // mitre at interior vertices, capped
    if (i > 0 && i < n - 1) {
      const p = pts[i - 1], q = pts[i], r = pts[i + 1];
      let ax = q[0] - p[0], az = q[1] - p[1]; const la = hyp(ax, az) || 1; ax /= la; az /= la;
      let bx = r[0] - q[0], bz = r[1] - q[1]; const lb = hyp(bx, bz) || 1; bx /= lb; bz /= lb;
      const cos = ax * bx + az * bz;
      const k = 1 / Math.max(0.5, Math.sqrt((1 + cos) / 2));
      out.push([-dz * k, dx * k]);
    } else out.push([-dz, dx]);
  }
  return out;
}
function cumLen(pts) { const s = [0]; for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return s; }
// Offset polyline (side +1/-1 along normals()).
export function offsetLine(pts, off) { const N = normals(pts); return pts.map((p, i) => [p[0] + N[i][0] * off, p[1] + N[i][1] * off]); }

// Uniform grid over segments for fast proximity queries.
class SegGrid {
  constructor(cell = 16) { this.cell = cell; this.map = new Map(); }
  add(item, ax, az, bx, bz, pad) {
    const c = this.cell;
    const x0 = Math.floor((Math.min(ax, bx) - pad) / c), x1 = Math.floor((Math.max(ax, bx) + pad) / c);
    const z0 = Math.floor((Math.min(az, bz) - pad) / c), z1 = Math.floor((Math.max(az, bz) + pad) / c);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const k = i * 100003 + j; let l = this.map.get(k); if (!l) this.map.set(k, (l = [])); l.push(item);
    }
  }
  at(x, z) { return this.map.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell)) || EMPTY; }
}
const EMPTY = [];

// ---------- 1. network ----------
function classify(tags) {
  const hw = tags.highway;
  if (hw && RC[hw]) return { kind: 'road', hw, cls: RC[hw] };
  if (hw && PATHS[hw] !== undefined) return { kind: 'path', hw };
  if (tags.railway === 'rail') return { kind: 'rail' };
  if (tags.railway === 'platform' || (tags.public_transport === 'platform' && !hw)) return { kind: 'platform' };
  if (tags.building) return { kind: 'building' };
  if (tags.barrier === 'fence' || tags.barrier === 'wall') return { kind: 'barrier' };
  return null;
}

function buildNetwork(osm) {
  const [bx0, bz0, bx1, bz1] = osm.meta.box;
  const inBox = (p) => p[0] >= bx0 && p[0] <= bx1 && p[1] >= bz0 && p[1] <= bz1;
  const nodes = new Map(); // id -> { id, x, z, ways: Set, boundary }
  const node = (id, x, z) => { let n = nodes.get(id); if (!n) { n = { id, x, z, ways: new Set(), boundary: false }; nodes.set(id, n); } return n; };
  const ways = [], platforms = [], buildings = [], barriers = [];
  for (const w of osm.ways) {
    const c = classify(w.tags);
    if (!c) continue;
    if (c.kind === 'platform' && w.nodes[0] === w.nodes[w.nodes.length - 1]) { platforms.push({ id: w.id, ref: w.tags.ref || '', ring: w.pts.slice(0, -1) }); continue; }
    if (c.kind === 'building') { if (w.pts.some(inBox)) buildings.push({ id: w.id, ring: w.pts.slice(0, -1), tags: w.tags }); continue; }
    if (c.kind === 'barrier') { if (w.pts.some(inBox)) barriers.push({ id: w.id, pts: w.pts }); continue; }
    // clip to the box: runs of inside vertices, with the boundary crossing added as an end node
    let run = null;
    const flush = () => { if (run && run.ids.length >= 2) ways.push({ ...run }); run = null; };
    for (let i = 0; i < w.pts.length; i++) {
      const p = w.pts[i], inside = inBox(p);
      if (inside) {
        if (!run) {
          run = { osmId: w.id, tags: w.tags, ...c, ids: [] };
          if (i > 0) { const e = boxCross(w.pts[i - 1], p); const id = `e${w.id}_${i}`; node(id, e[0], e[1]).boundary = true; run.ids.push(id); }
        }
        node(w.nodes[i], p[0], p[1]); run.ids.push(w.nodes[i]);
      } else if (run) {
        const e = boxCross(w.pts[i - 1], p); const id = `e${w.id}_${i}`; node(id, e[0], e[1]).boundary = true; run.ids.push(id); flush();
      }
    }
    flush();
  }
  function boxCross(a, b) { // a inside, b outside (or the reverse): point on the box edge
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dz = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - bx0], [dx, bx1 - a[0]], [-dz, a[1] - bz0], [dz, bz1 - a[1]]]) {
      if (p === 0) continue; const r = q / p; if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    }
    const t = inBox(a) ? t1 : t0; return [a[0] + dx * t, a[1] + dz * t];
  }
  ways.forEach((w, i) => { w.idx = i; for (const id of w.ids) nodes.get(id).ways.add(i); });
  const tagged = osm.nodes.filter((n) => inBox([n.x, n.z]));
  return { nodes, ways, platforms, buildings, barriers, tagged, box: osm.meta.box };
}

function wayProps(w) {
  const t = w.tags;
  w.oneway = t.oneway === 'yes' || t.oneway === '1' || t.highway === 'motorway' || t.junction === 'roundabout';
  w.layer = +t.layer || (t.bridge === 'yes' ? 1 : 0);
  w.bridgeTag = t.bridge === 'yes';
  if (w.kind === 'road') {
    const c = w.cls;
    w.lanes = Math.min(w.oneway ? 6 : 8, +t.lanes || (w.oneway ? c.lanes1 : c.lanes));
    let metres = w.lanes * 3.5 + c.extra;
    if (t.service === 'driveway' || t.service === 'parking_aisle') metres = 5;
    w.width = U(metres);
    w.turn = (t['turn:lanes'] || '').split('|').filter((s, i, a) => a.length === w.lanes);
    w.rank = c.rank;
    w.sidewalks = c.urban && t.sidewalk !== 'no' && !c.link ? (w.oneway ? [1] : [1, -1]) : [];
    // Israel drives on the right: the outer kerb of a one-way carriageway is on its right. With the
    // normal n = (-dz, dx) and x east, z south, n points to the right of travel, so side +1.
    if (w.oneway) w.sidewalks = w.sidewalks.length ? [1] : [];
  } else if (w.kind === 'path') {
    w.width = U(PATHS[w.hw]);
    w.lanes = 0; w.rank = 0; w.sidewalks = [];
  } else if (w.kind === 'rail') { w.width = 7; w.rank = 0; w.lanes = 0; w.sidewalks = []; }
}

// ---------- 2. design edits: move centre lines, fade back ----------
function moveNodes(net, moves, fade) {
  // moves: Map nodeId -> [dx, dz]. Propagates each move along the network with a smooth fade.
  const { nodes, ways } = net;
  const adj = new Map();
  for (const w of ways) for (let i = 0; i + 1 < w.ids.length; i++) {
    const a = w.ids[i], b = w.ids[i + 1];
    const na = nodes.get(a), nb = nodes.get(b), l = hyp(na.x - nb.x, na.z - nb.z);
    if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push([b, l]); adj.get(b).push([a, l]);
  }
  // multi-source Dijkstra (small graph: plain arrays)
  const dist = new Map(), src = new Map();
  const open = [];
  for (const [id, d] of moves) { dist.set(id, 0); src.set(id, d); open.push(id); }
  while (open.length) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (dist.get(open[i]) < dist.get(open[bi])) bi = i;
    const id = open.splice(bi, 1)[0]; const d0 = dist.get(id);
    for (const [nb, l] of adj.get(id) || []) {
      const d = d0 + l; if (d >= fade) continue;
      if (!dist.has(nb) || d < dist.get(nb)) { dist.set(nb, d); src.set(nb, src.get(id)); open.push(nb); }
    }
  }
  for (const [id, d] of dist) {
    const n = nodes.get(id); if (n.boundary) continue;
    const m = src.get(id), k = moves.has(id) ? 1 : 1 - smooth(d / fade);
    n.x += m[0] * k; n.z += m[1] * k;
  }
}

function waysByOsm(net, id) { return net.ways.filter((w) => w.osmId === id); }
const P = (net, id) => { const n = net.nodes.get(id); return [n.x, n.z]; };
export const wayPts = (net, w) => w.ids.map((id) => P(net, id));

// The Ayalon carriageways keep clear of the rails and platforms (widened cross-section).
function relayCorridor(net) {
  const rails = net.ways.filter((w) => w.kind === 'rail');
  const feats = [];
  for (const r of rails) { const p = wayPts(net, r); for (let i = 0; i + 1 < p.length; i++) feats.push({ a: p[i], b: p[i + 1], hw: 3.6 }); }
  for (const pl of net.platforms) for (let i = 0; i < pl.ring.length; i++) feats.push({ a: pl.ring[i], b: pl.ring[(i + 1) % pl.ring.length], hw: 0 });
  const moves = new Map();
  for (const side of ['sb', 'nb']) for (const oid of PLAN.ayalon[side]) for (const w of waysByOsm(net, oid)) {
    const hw = w.width / 2, need = hw + PLAN.corridorGap;
    const pts = wayPts(net, w), N = normals(pts);
    pts.forEach((p, i) => {
      let push = 0;
      for (const f of feats) {
        const c = segClosest(p[0], p[1], f.a[0], f.a[1], f.b[0], f.b[1]);
        const gap = c.d - f.hw;
        if (gap < need && c.d < 60) push = Math.max(push, need - gap);
      }
      if (push > 0.05) {
        // push away from the corridor: SB is west of the rails, NB east
        const dir = side === 'sb' ? -1 : 1;
        const nx = N[i][0], s = Math.sign(nx) || 1;
        const k = dir * s; // move along the normal whose x component points the right way
        moves.set(w.ids[i], [N[i][0] * push * k, N[i][1] * push * k]);
      }
    });
  }
  // smooth the push along each carriageway so it ramps in, then fade into the links
  moveNodes(net, moves, PLAN.fade * 1.5);
  return moves.size;
}

// One bridge band: an axis, a cross-section, and the s range the deck must span.
function relayBridge(net) {
  const eb = waysByOsm(net, PLAN.deckWays.eb)[0], wb = waysByOsm(net, PLAN.deckWays.wb)[0];
  const pe = wayPts(net, eb), pw = wayPts(net, wb);
  const dir = (p) => { const a = p[0], b = p[p.length - 1], l = hyp(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const de = dir(pe), dw = dir(pw);
  let ux = de[0] - dw[0], uz = de[1] - dw[1]; const ul = hyp(ux, uz); ux /= ul; uz /= ul;
  const nx = -uz, nz = ux; // +t points south (to the right of an eastbound driver)
  let ox = 0, oz = 0; const all = [...pe, ...pw]; for (const p of all) { ox += p[0]; oz += p[1]; } ox /= all.length; oz /= all.length;
  const S = (x, z) => (x - ox) * ux + (z - oz) * uz, T = (x, z) => (x - ox) * nx + (z - oz) * nz;
  const D = PLAN.deck;
  const wbW = wb.width, ebW = eb.width; // carriageway widths incl. shoulders (lanes*3.5+extra)
  // section, from t = north edge to south edge, relative to the barrier centre m0
  const tEbOsm = pe.reduce((a, p) => a + T(...p), 0) / pe.length, tWbOsm = pw.reduce((a, p) => a + T(...p), 0) / pw.length;
  const halfB = D.barrierW / 2 + D.innerShoulder;
  const offWb = -(halfB + wbW / 2), offEb = halfB + ebW / 2;
  const m0 = ((tEbOsm - offEb) + (tWbOsm - offWb)) / 2; // centre the move: both carriageways shift about equally
  const sec = {
    m0,
    wb: m0 + offWb, eb: m0 + offEb,
    wbEdge: m0 + offWb - wbW / 2, ebEdge: m0 + offEb + ebW / 2,
  };
  sec.north = sec.wbEdge - D.sidewalk - D.parapetW; // outer face of the north parapet
  sec.south = sec.ebEdge + D.sidewalk + D.parapetW;
  const moves = new Map();
  const place = (w, t) => w.ids.forEach((id) => { const n = net.nodes.get(id); const s = S(n.x, n.z), tt = T(n.x, n.z); moves.set(id, [nx * (t - tt), nz * (t - tt)]); });
  place(eb, sec.eb); place(wb, sec.wb);
  moveNodes(net, moves, PLAN.fade);
  const sOsm = [Math.min(...all.map((p) => S(...p))), Math.max(...all.map((p) => S(...p)))];
  const band = { sOsm, ox, oz, ux, uz, nx, nz, sec, S, T, W: (s, t) => [ox + ux * s + nx * t, oz + uz * s + nz * t], ebIdx: eb.idx, wbIdx: wb.idx };
  return band;
}

// ---------- 3. heights ----------
function densify(net, maxLen) {
  for (const w of net.ways) {
    if (w.kind !== 'road' && w.kind !== 'rail') continue;
    const out = [w.ids[0]];
    for (let i = 0; i + 1 < w.ids.length; i++) {
      const a = net.nodes.get(w.ids[i]), b = net.nodes.get(w.ids[i + 1]);
      const l = hyp(b.x - a.x, b.z - a.z), k = Math.ceil(l / maxLen);
      for (let j = 1; j < k; j++) {
        const id = `d${w.idx}_${i}_${j}`;
        net.nodes.set(id, { id, x: lerp(a.x, b.x, j / k), z: lerp(a.z, b.z, j / k), ways: new Set([w.idx]), boundary: false });
        out.push(id);
      }
      out.push(w.ids[i + 1]);
    }
    w.ids = out;
  }
}

function solveHeights(net, band, groundAt, log) {
  const { nodes, ways } = net;
  const roadWays = ways.filter((w) => w.kind === 'road');
  // smoothed ground along a polyline (window in u)
  const smoothAlong = (pts, win) => {
    const s = cumLen(pts), g = pts.map((p) => groundAt(p[0], p[1]));
    return pts.map((_, i) => { let a = 0, c = 0; for (let j = 0; j < pts.length; j++) { const d = Math.abs(s[j] - s[i]); if (d <= win) { const w = 1 - d / win; a += g[j] * w; c += w; } } return a / c; });
  };
  const Y = new Map(), hard = new Set();
  // rails and motorways: ground smoothed along whole chains (ways joined end to start), hard
  const chainWays = ways.filter((w) => w.kind === 'rail' || (w.kind === 'road' && w.hw === 'motorway'));
  const used = new Set();
  for (const w of chainWays) {
    if (used.has(w)) continue;
    let chain = [w]; used.add(w);
    for (let grow = true; grow;) {
      grow = false;
      const head = chain[0], tail = chain[chain.length - 1];
      for (const o of chainWays) {
        if (used.has(o) || o.kind !== w.kind) continue;
        if (o.ids[0] === tail.ids[tail.ids.length - 1]) { chain.push(o); used.add(o); grow = true; }
        else if (o.ids[o.ids.length - 1] === head.ids[0]) { chain.unshift(o); used.add(o); grow = true; }
      }
    }
    const ids = []; for (const c of chain) for (const id of c.ids) if (ids[ids.length - 1] !== id) ids.push(id);
    const pts = ids.map((id) => P(net, id)), ys = smoothAlong(pts, w.kind === 'rail' ? 120 : 90);
    // a chain end on the box edge meets the city's road there: its height exactly, the smoothing
    // eased back in over 80 u (a 0.95 u step on the Ayalon at the edge otherwise)
    if (w.kind === 'road') {
      const L = cumLen(pts), FADE = 80;
      for (const end of [0, ids.length - 1]) {
        const n = nodes.get(ids[end]);
        if (!n.boundary) continue;
        const d0 = groundAt(n.x, n.z) + 0.15 + (w.rank || 0) * 0.008 - ys[end];
        for (let i = 0; i < ids.length; i++) { const d = Math.abs(L[i] - L[end]); if (d < FADE) ys[i] += d0 * (1 - smooth(d / FADE)); }
      }
    }
    ids.forEach((id, i) => { if (!hard.has(id)) { Y.set(id, ys[i]); hard.add(id); } });
  }
  // the deck: clearance over everything that crosses the band below it
  const { S, T, sec } = band;
  const under = [];
  const bandHit = (pts) => { const hits = []; for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1]; const ta = T(...a), tb = T(...b); if ((ta - sec.north + 6) * (tb - sec.north + 6) <= 0 || (ta - sec.south - 6) * (tb - sec.south - 6) <= 0 || (ta > sec.north && ta < sec.south)) hits.push(i); } return hits; };
  // ways that meet the deck carriageways or their approaches at a node join at grade, not under
  const deckNodes = new Set([...ways[band.ebIdx].ids, ...ways[band.wbIdx].ids]);
  const joined = (w) => w.ids.some((id) => deckNodes.has(id));
  const sWin = [band.sOsm[0] - 30, band.sOsm[1] + 30];
  for (const w of ways) {
    if (w.idx === band.ebIdx || w.idx === band.wbIdx) continue;
    if (w.kind !== 'road' && w.kind !== 'rail') continue; // paths are re-routed round abutments, they do not set the span
    if (w.kind === 'road' && w.hw !== 'motorway' && joined(w)) continue;
    const pts = wayPts(net, w);
    // crosses the band roughly across (not one of the approach roads, which run along it)
    for (const i of bandHit(pts)) {
      const a = pts[i], b = pts[i + 1];
      const along = Math.abs(((b[0] - a[0]) * band.ux + (b[1] - a[1]) * band.uz) / (hyp(b[0] - a[0], b[1] - a[1]) || 1));
      if (along > 0.6) continue;
      const tm = (T(...a) + T(...b)) / 2;
      if (tm < sec.north - 4 || tm > sec.south + 4) continue;
      const s = (S(...a) + S(...b)) / 2;
      if (s < sWin[0] || s > sWin[1]) continue;
      const hw = (w.width || 3) / 2 / Math.max(0.3, Math.sqrt(1 - along * along));
      const y = w.kind === 'path' ? groundAt(...a) : (Y.get(w.ids[i]) ?? groundAt(...a));
      under.push({ s, hw, y, w: w.idx, kind: w.kind, hwName: w.hw });
      if (w.kind === 'road' && w.hw !== 'motorway') for (const k of [i, i + 1]) if (!hard.has(w.ids[k])) { Y.set(w.ids[k], groundAt(...pts[k])); hard.add(w.ids[k]); }
    }
  }
  band.underIdx = new Set(under.map((u) => u.w).filter((v) => v !== undefined));
  for (const pl of net.platforms) {
    const ss = pl.ring.map((p) => S(...p)), ts = pl.ring.map((p) => T(...p));
    if (Math.min(...ts) < sec.south && Math.max(...ts) > sec.north) {
      const s0 = Math.min(...ss), s1 = Math.max(...ss);
      // only its part under the band matters: a platform runs along the rails, under it near its centre
      const inside = pl.ring.filter((p) => T(...p) > sec.north - 2 && T(...p) < sec.south + 2);
      const sm = inside.length ? inside.reduce((a, p) => a + S(...p), 0) / inside.length : (s0 + s1) / 2;
      under.push({ s: sm, hw: 6, y: groundAt(...pl.ring[0]) + PLAT_H, kind: 'platform' });
    }
  }
  // deck extent and minimum profile
  const sLo = Math.min(...under.map((u) => u.s - u.hw)) - PLAN.deckMargin;
  const sHi = Math.max(...under.map((u) => u.s + u.hw)) + PLAN.deckMargin;
  const req = under.map((u) => ({ s: u.s, y: u.y + CLEAR + (u.kind === 'rail' ? 0.6 : 0) }));
  // smallest crest (concave) profile above every requirement: upper concave hull, then a tangent
  // extension at both ends at the hull's end grades (clamped).
  req.sort((a, b) => a.s - b.s);
  const hull = [];
  for (const p of req) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2], b = hull[hull.length - 1];
      if ((b.y - a.y) * (p.s - a.s) <= (p.y - a.y) * (b.s - a.s)) hull.pop(); else break;
    }
    hull.push(p);
  }
  const deckY = (s) => {
    if (s <= hull[0].s) { const g = hull.length > 1 ? clamp((hull[1].y - hull[0].y) / (hull[1].s - hull[0].s), -0.03, 0.03) : 0; return hull[0].y + (s - hull[0].s) * g; }
    const n = hull.length - 1;
    if (s >= hull[n].s) { const g = n > 0 ? clamp((hull[n].y - hull[n - 1].y) / (hull[n].s - hull[n - 1].s), -0.03, 0.03) : 0; return hull[n].y + (s - hull[n].s) * g; }
    for (let i = 0; i < n; i++) if (s <= hull[i + 1].s) return lerp(hull[i].y, hull[i + 1].y, (s - hull[i].s) / (hull[i + 1].s - hull[i].s));
    return hull[n].y;
  };
  // round the hull's corners (crest curves): average over +-14 u, never below the hull
  const deckProfile = (s) => { let a = 0, c = 0; for (let k = -14; k <= 14; k += 2) { const w = 1 - Math.abs(k) / 16; a += deckY(s + k) * w; c += w; } return Math.max(deckY(s), a / c); };
  band.s0 = sLo; band.s1 = sHi; band.deckY = deckProfile; band.under = under;
  const inBand = (x, z) => { const s = S(x, z), t = T(x, z); return s >= sLo - 0.5 && s <= sHi + 0.5 && t >= sec.north - 1 && t <= sec.south + 1; };
  band.inBand = inBand;
  // every road vertex on the deck: hard at the profile
  band.onDeck = (w) => w.kind === 'road' && w.hw !== 'motorway' && !band.underIdx.has(w.idx);
  for (const w of roadWays) if (band.onDeck(w)) w.ids.forEach((id) => { const n = nodes.get(id); if (inBand(n.x, n.z)) { Y.set(id, deckProfile(S(n.x, n.z))); hard.add(id); } });
  // boundary nodes: where the city's own road continues, at its drawn height (ground + city.js roadY)
  const rankAt = (n) => Math.max(0, ...[...n.ways].map((wi) => ways[wi].rank || 0));
  const edgeY = (n) => groundAt(n.x, n.z) + 0.15 + rankAt(n) * 0.008;
  for (const [id, n] of nodes) if (n.boundary && !hard.has(id)) { Y.set(id, edgeY(n)); hard.add(id); }
  // everything else: the road graph
  const adj = new Map();
  for (const w of roadWays) for (let i = 0; i + 1 < w.ids.length; i++) {
    const a = w.ids[i], b = w.ids[i + 1], na = nodes.get(a), nb = nodes.get(b);
    const l = Math.max(0.5, hyp(na.x - nb.x, na.z - nb.z));
    if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push([b, 1 / l]); adj.get(b).push([a, 1 / l]);
  }
  const free = [...adj.keys()].filter((id) => !hard.has(id));
  // Cone: every road is at least as high as a MAX_GRADE descent from any fixed node (deck,
  // motorway, boundary) along the network; otherwise it follows the ground. Max-plus Dijkstra.
  const cone = new Map();
  const heap = [];
  for (const id of hard) if (adj.has(id)) { cone.set(id, Y.get(id)); heap.push(id); }
  while (heap.length) {
    let bi = 0; for (let i = 1; i < heap.length; i++) if (cone.get(heap[i]) > cone.get(heap[bi])) bi = i;
    const id = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
    const v = cone.get(id);
    for (const [nb, w] of adj.get(id)) {
      if (hard.has(nb)) continue;
      const nv = v - MAX_GRADE / w; // w = 1 / length
      if (nv > (cone.get(nb) ?? -Infinity) + 1e-6) { cone.set(nb, nv); heap.push(nb); }
    }
  }
  let lifted = 0;
  for (const id of free) {
    const n = nodes.get(id), g = groundAt(n.x, n.z), c = cone.get(id) ?? -Infinity;
    Y.set(id, Math.max(g, c)); if (c > g + 0.05) lifted++;
  }
  // vertical curves: neighbour averaging on free nodes, never below the ground
  for (let it = 0; it < 30; it++) for (const id of free) {
    let a = 0, c = 0; for (const [nb, w] of adj.get(id)) { a += Y.get(nb) * w; c += w; }
    const n = nodes.get(id);
    Y.set(id, Math.max(groundAt(n.x, n.z) - 0.4, Y.get(id) * 0.5 + (a / c) * 0.5));
  }
  // rails, paths, everything not solved: ground
  for (const [id, n] of nodes) if (!Y.has(id)) Y.set(id, groundAt(n.x, n.z));
  for (const w of ways) { w.pts = wayPts(net, w); w.ys = w.ids.map((id) => Y.get(id)); }
  log && log(`heights: ${under.length} crossings under the deck, deck s ${sLo.toFixed(1)}..${sHi.toFixed(1)}, ${lifted} nodes lifted above the ground by the ${MAX_GRADE * 100}% cone`);
  return Y;
}

// ---------- 4. what stands on what ----------
function classifySegments(net, band) {
  for (const w of net.ways) {
    if (w.kind !== 'road') continue;
    w.struct = w.pts.slice(0, -1).map((p, i) => {
      const q = w.pts[i + 1];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      return band.inBand(mx, mz) && band.onDeck(w) ? 'deck' : (w.bridgeTag ? 'bridge' : 'grade');
    });
  }
}

// ---------- 5. ground grading, walls ----------
function gradeGround(net, band, groundAt) {
  const [x0, z0, x1, z1] = net.box;
  const nx = Math.round((x1 - x0) / GRID) + 1, nz = Math.round((z1 - z0) / GRID) + 1;
  const base = new Float32Array(nx * nz), h = new Float32Array(nx * nz), kind = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) base[j * nx + i] = groundAt(x0 + i * GRID, z0 + j * GRID);
  // where two cores overlap (a slip road beside its parent road, a junction) the heights blend by
  // closeness to each centre line, so the surface ramps across instead of stepping where the nearer
  // road changes (a 0.65 u rise at a gore otherwise)
  const bestCore = new Float32Array(nx * nz).fill(Infinity), coreH = new Float32Array(nx * nz), coreW = new Float32Array(nx * nz);
  const bestSlope = new Float32Array(nx * nz).fill(0), slopeH = new Float32Array(nx * nz);
  const segs = [];
  for (const w of net.ways) {
    if (w.kind !== 'road' && w.kind !== 'rail') continue;
    const sideExtra = (w.sidewalks || []).length ? SW + 0.5 : 1.2;
    for (let i = 0; i + 1 < w.pts.length; i++) {
      if (w.kind === 'road' && w.struct[i] !== 'grade') continue;
      const core = w.width / 2 + sideExtra + (w.kind === 'rail' ? 1 : 0);
      const below = w.kind === 'rail' || w.hw === 'motorway' || band.underIdx.has(w.idx);
      segs.push({ w, i, a: w.pts[i], b: w.pts[i + 1], ya: w.ys[i], yb: w.ys[i + 1], core, below });
    }
  }
  for (const sg of segs) {
    const dh = Math.max(Math.abs(sg.ya - groundAt(...sg.a)), Math.abs(sg.yb - groundAt(...sg.b)));
    const F = 2 + 2.0 * dh;
    const pad = sg.core + F;
    const i0 = Math.max(0, Math.floor((Math.min(sg.a[0], sg.b[0]) - pad - x0) / GRID)), i1 = Math.min(nx - 1, Math.ceil((Math.max(sg.a[0], sg.b[0]) + pad - x0) / GRID));
    const j0 = Math.max(0, Math.floor((Math.min(sg.a[1], sg.b[1]) - pad - z0) / GRID)), j1 = Math.min(nz - 1, Math.ceil((Math.max(sg.a[1], sg.b[1]) + pad - z0) / GRID));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = x0 + i * GRID, z = z0 + j * GRID;
      // under the deck only what passes under it sets the ground; an approach embankment may run on
      // under the deck end as a slope (spill-through abutment), capped below the soffit further down
      const inB = !sg.below && band.inBand(x, z);
      const c = segClosest(x, z, sg.a[0], sg.a[1], sg.b[0], sg.b[1]);
      if (inB && c.d <= sg.core) continue;
      const y = lerp(sg.ya, sg.yb, c.t), k = j * nx + i;
      if (c.d <= sg.core) {
        const r = c.d / sg.core, wgt = (1 - r) ** 3 + 1e-4;
        if (r < bestCore[k]) bestCore[k] = r;
        coreH[k] += y * wgt; coreW[k] += wgt;
      } else if (c.d < pad) {
        const g = base[k], f = (c.d - sg.core) / (2 + 2.0 * Math.abs(y - g));
        if (f < 1) { const wgt = 1 - smooth(f); if (wgt > bestSlope[k]) { bestSlope[k] = wgt; slopeH[k] = y; } }
      }
    }
  }
  // fade every change to zero at the box edge so the lab ground meets the game's terrain exactly
  const EDGE = 24;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, g = base[k];
    let y = g;
    if (bestCore[k] < Infinity) { y = coreH[k] / coreW[k]; kind[k] = 1; }
    else if (bestSlope[k] > 0) { y = lerp(g, slopeH[k], bestSlope[k]); kind[k] = 2; }
    const e = Math.min(i, j, nx - 1 - i, nz - 1 - j) * GRID;
    if (e < EDGE && kind[k] !== 1) y = lerp(g, y, smooth(e / EDGE));
    const x = x0 + i * GRID, z = z0 + j * GRID;
    if (kind[k] !== 1 && band.inBand(x, z)) y = Math.min(y, band.deckY(band.S(x, z)) - DECK_DEPTH - 0.8);
    h[k] = y;
  }
  const at = (x, z) => {
    let fx = (x - x0) / GRID, fz = (z - z0) / GRID;
    if (fx < 0 || fz < 0 || fx > nx - 1 || fz > nz - 1) return groundAt(x, z);
    let i = Math.floor(fx), j = Math.floor(fz); if (i >= nx - 1) i = nx - 2; if (j >= nz - 1) j = nz - 2;
    const u = fx - i, v = fz - j, o = j * nx + i;
    return (h[o] * (1 - u) + h[o + 1] * u) * (1 - v) + (h[o + nx] * (1 - u) + h[o + nx + 1] * u) * v;
  };
  // at grade (within 1 u of the graded ground here): the graded ground, which is what a walker stands
  // on where two roads overlap; on a deck or bridge: the road's own height
  const gy = (x, z, y) => { const g = at(x, z); return Math.abs(y - g) < 1 ? g : y; };
  return { x0, z0, nx, nz, step: GRID, h, base, kind, at, gy };
}

// Walls along the edges of at-grade roads where the ground beside them steps by more than this.
const WALL_DH = 1.4;
function findWalls(net, band, ground, onOther) {
  const walls = [];
  for (const w of net.ways) {
    if (w.kind !== 'road') continue;
    const N = normals(w.pts);
    for (const side of [1, -1]) {
      const off = w.width / 2 + ((w.sidewalks || []).includes(side) ? SW : 0.6);
      let run = null;
      const flush = () => { if (run && run.pts.length >= 2) walls.push(run); run = null; };
      const L = cumLen(w.pts);
      for (let i = 0; i + 1 < w.pts.length; i++) {
        if (w.struct[i] !== 'grade') { flush(); continue; }
        const segL = L[i + 1] - L[i], k = Math.max(1, Math.ceil(segL / 2));
        for (let j = (i === 0 ? 0 : 1); j <= k; j++) {
          const f = j / k;
          const cx = lerp(w.pts[i][0], w.pts[i + 1][0], f), cz = lerp(w.pts[i][1], w.pts[i + 1][1], f);
          const nn = [lerp(N[i][0], N[i + 1][0], f) * side, lerp(N[i][1], N[i + 1][1], f) * side];
          const ex = cx + nn[0] * off, ez = cz + nn[1] * off;
          const y = ground.gy(cx, cz, lerp(w.ys[i], w.ys[i + 1], f)) + ((w.sidewalks || []).includes(side) ? KERB : 0);
          const out = ground.at(ex + nn[0] * 2.2, ez + nn[1] * 2.2);
          const dh = out - y;
          // no wall where the edge touches another carriageway (a gore, a junction): only once the roads part
          const shared = onOther(ex, ez, w, 1.2) || onOther(ex + nn[0] * 2.2, ez + nn[1] * 2.2, w, 0.8);
          const type = shared || band.inBand(ex + nn[0] * 2.2, ez + nn[1] * 2.2) ? null : dh > WALL_DH ? 'up' : dh < -WALL_DH ? 'drop' : null;
          if (!type || (run && run.type !== type)) flush();
          if (type) { if (!run) run = { type, way: w.idx, side, pts: [], top: [], bot: [] }; run.pts.push([ex, ez]); run.top.push(type === 'up' ? out : y); run.bot.push(type === 'up' ? y : out); }
        }
      }
      flush();
    }
  }
  return walls;
}

// ---------- 6. station ----------
function designStation(net, band, groundAt) {
  const { S, T, sec } = band;
  const plats = net.platforms.map((pl) => {
    // centre line: from the middle of one short end to the middle of the other (the two shortest
    // edges of the ring), not the longest diagonal, which runs corner to corner
    const edges = pl.ring.map((p, i) => { const q = pl.ring[(i + 1) % pl.ring.length]; return { i, l: hyp(q[0] - p[0], q[1] - p[1]), m: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] }; });
    const ends = [...edges].sort((e1, e2) => e1.l - e2.l).slice(0, 2);
    const a = ends[0].m, b = ends[1].m;
    // platform edge ~1.1 m over the rail head: PLAT_H over the highest ground under the ring
    const top = Math.max(...pl.ring.map((p) => groundAt(p[0], p[1])), groundAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) + PLAT_H;
    return { ...pl, top, axis: [a, b] };
  });
  // rail level: ground under the platforms, so platforms and rails agree
  const stairs = [];
  for (const pl of plats) {
    // the platform's centre line where it passes the deck edges
    const [a, b] = pl.axis;
    for (const edge of ['north', 'south']) {
      const tEdge = edge === 'north' ? sec.north : sec.south;
      const ta = T(...a), tb = T(...b);
      if ((ta - tEdge) * (tb - tEdge) > 0) continue;
      const f = (tEdge - ta) / (tb - ta);
      const px = lerp(a[0], b[0], f), pz = lerp(a[1], b[1], f);
      // stair runs away from the deck along the platform axis
      let dx = b[0] - a[0], dz = b[1] - a[1]; const l = hyp(dx, dz); dx /= l; dz /= l;
      const away = edge === 'north' ? -1 : 1; // -t is north
      const tdir = (dx * band.nx + dz * band.nz);
      if (Math.sign(tdir) !== away) { dx = -dx; dz = -dz; }
      const s = S(px, pz);
      const yTop = band.deckY(s) + KERB;
      const rise = yTop - pl.top, run = rise / STAIR_GRADE;
      // the flight starts at the parapet line (the sidewalk edge) and lands on the platform
      const start = [px + dx * 0.0, pz + dz * 0.0];
      const end = [start[0] + dx * run, start[1] + dz * run];
      // put the top on the deck edge exactly: shift so its first point sits at tEdge
      stairs.push({ platform: pl.id, edge, a: start, b: end, y0: yTop, y1: pl.top, w: STAIR_W, dir: [dx, dz], s });
    }
  }
  return { plats, stairs };
}

// Is (x, z) on the carriageway of a road other than `self` (within margin)?
function makeOnOther(net) {
  const grid = new SegGrid(20);
  for (const w of net.ways) {
    if (w.kind !== 'road') continue;
    for (let i = 0; i + 1 < w.pts.length; i++) grid.add({ w, i }, w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1], w.width / 2 + 3);
  }
  return (x, z, self, m = 0.6) => {
    for (const { w, i } of grid.at(x, z)) {
      if (w === self) continue;
      const c = segClosest(x, z, w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1]);
      if (c.d < w.width / 2 + m) return true;
    }
    return false;
  };
}

// ---------- 6b. sidewalks: runs along at-grade urban roads, cut where they meet another carriageway ----------
function designSidewalks(net, band, onOther, ground) {
  // no sidewalk through a building footprint, and none in the last 4 u before the box edge (the
  // city's own sidewalks take over there)
  const bld = net.buildings.map((b) => { const xs = b.ring.map((q) => q[0]), zs = b.ring.map((q) => q[1]); return { ring: b.ring, bb: [Math.min(...xs) - 1, Math.min(...zs) - 1, Math.max(...xs) + 1, Math.max(...zs) + 1] }; });
  const inBuilding = (x, z) => bld.some((b) => x > b.bb[0] && x < b.bb[2] && z > b.bb[1] && z < b.bb[3] && inPoly(x, z, b.ring));
  const [bx0, bz0, bx1, bz1] = net.box;
  const nearEdge = (x, z) => Math.min(x - bx0, bx1 - x, z - bz0, bz1 - z) < 4;
  // nor through a mapped fence or wall (details.js stands them as colliders)
  const onBarrier = (x, z) => net.barriers.some((b) => b.pts.some((p, i) => i + 1 < b.pts.length && segClosest(x, z, p[0], p[1], b.pts[i + 1][0], b.pts[i + 1][1]).d < SW / 2 + 1.5));
  const runs = [];
  for (const w of net.ways) {
    if (w.kind !== 'road') continue;
    for (const side of w.sidewalks || []) {
      const off = side * (w.width / 2 + SW / 2);
      const N = normals(w.pts);
      let run = null;
      const flush = () => { if (run && run.pts.length >= 2) runs.push(run); run = null; };
      for (let i = 0; i < w.pts.length; i++) {
        const p = [w.pts[i][0] + N[i][0] * off, w.pts[i][1] + N[i][1] * off];
        const segOk = i < w.pts.length - 1 ? w.struct[i] === 'grade' : w.struct[i - 1] === 'grade';
        const outer = [p[0] + N[i][0] * side * SW / 2, p[1] + N[i][1] * side * SW / 2];
        const ok = segOk && !band.inBand(p[0], p[1]) && !onOther(p[0], p[1], w) && !onOther(outer[0], outer[1], w)
          && !inBuilding(p[0], p[1]) && !inBuilding(outer[0], outer[1]) && !nearEdge(p[0], p[1]) && !onBarrier(p[0], p[1]);
        if (!ok) { flush(); continue; }
        if (!run) run = { way: w.idx, side, pts: [], ys: [] };
        run.pts.push(p); run.ys.push(ground.gy(w.pts[i][0], w.pts[i][1], w.ys[i]) + KERB);
      }
      flush();
    }
  }
  return runs;
}

// ---------- 7. walkable surfaces + colliders ----------
function buildSurfaces(D) {
  const { band, ways, ground, station } = D;
  const strips = []; // { a:[x,z], b:[x,z], ha, hb, hw, kind }
  const polys = [];  // { ring, h, kind }
  const grid = new SegGrid(16);
  const addStrip = (a, b, ha, hb, hw, kind) => { const s = { a, b, ha, hb, hw, kind }; strips.push(s); grid.add(s, a[0], a[1], b[0], b[1], hw + 1); };
  // the deck: three strips across (north sidewalk, carriageways + barrier, south sidewalk), many along
  const { sec } = band;
  const ds = 3;
  for (let s = band.s0 - 1.5; s < band.s1 + 1.5 - 1e-6; s += ds) {
    const s2 = Math.min(s + ds, band.s1 + 1.5);
    const y0 = band.deckY(s), y1 = band.deckY(s2);
    const lanes = [sec.wbEdge - 0.1, sec.ebEdge + 0.1];
    const mid = (lanes[0] + lanes[1]) / 2, hw = (lanes[1] - lanes[0]) / 2;
    addStrip(band.W(s, mid), band.W(s2, mid), y0, y1, hw, 'deck');
    const swN = (sec.north + sec.wbEdge) / 2, swS = (sec.south + sec.ebEdge) / 2;
    const hwN = (sec.wbEdge - sec.north) / 2 + 0.05, hwS = (sec.south - sec.ebEdge) / 2 + 0.05;
    addStrip(band.W(s, swN), band.W(s2, swN), y0 + KERB, y1 + KERB, hwN, 'deckSidewalk');
    addStrip(band.W(s, swS), band.W(s2, swS), y0 + KERB, y1 + KERB, hwS, 'deckSidewalk');
  }
  // other structures (OSM bridges off the band) and sidewalks on at-grade roads
  for (const w of ways) {
    if (w.kind !== 'road') continue;
    for (let i = 0; i + 1 < w.pts.length; i++) if (w.struct[i] === 'bridge') addStrip(w.pts[i], w.pts[i + 1], w.ys[i], w.ys[i + 1], w.width / 2 + 0.2, 'bridge');
  }
  for (const r of D.sidewalks) for (let i = 0; i + 1 < r.pts.length; i++) addStrip(r.pts[i], r.pts[i + 1], r.ys[i], r.ys[i + 1], SW / 2, 'sidewalk');
  // station: platforms and stairs
  for (const pl of station.plats) polys.push({ ring: pl.ring, h: pl.top, kind: 'platform' });
  for (const st of station.stairs) addStrip(st.a, st.b, st.y0, st.y1, st.w / 2, 'stairs');
  for (const p of polys) { const xs = p.ring.map((q) => q[0]), zs = p.ring.map((q) => q[1]); p.box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]; }
  const prio = { stairs: 3, deckSidewalk: 1, sidewalk: 1, deck: 0, bridge: 0, platform: 0 };
  function heightAt(x, z, y = 0) {
    const g = ground.at(x, z);
    let best = -Infinity, bestP = -1, top = g, any = false;
    const consider = (h, p) => {
      if (h > y + STEP_UP) return;
      any = true;
      if (h > top) top = h;
      if (h < y - SNAP_BAND) return;
      if (h > best + 0.02 || (Math.abs(h - best) <= 0.02 && p > bestP)) { best = h; bestP = p; }
    };
    for (const s of grid.at(x, z)) {
      const c = segClosest(x, z, s.a[0], s.a[1], s.b[0], s.b[1]);
      if (c.d > s.hw) continue;
      // strips end square: past either end only within the overlap allowance
      const L = hyp(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const along = ((x - s.a[0]) * (s.b[0] - s.a[0]) + (z - s.a[1]) * (s.b[1] - s.a[1])) / (L || 1);
      if (along < -0.3 || along > L + 0.3) continue;
      consider(lerp(s.ha, s.hb, c.t), prio[s.kind] || 0);
    }
    for (const p of polys) {
      if (x < p.box[0] || x > p.box[2] || z < p.box[1] || z > p.box[3]) continue;
      if (inPoly(x, z, p.ring)) consider(p.h, prio[p.kind] || 0);
    }
    if (best > -Infinity) return Math.max(best, g);
    // nothing in reach: the highest surface below (falling), never below the ground
    return Math.max(top, g);
  }
  return { strips, polys, heightAt };
}

function buildColliders(D) {
  const { band, walls, station } = D;
  const { sec } = band;
  const col = [];
  // a wall along a -> b; `th` across it, or [inner, outer] extents along `out` (unit 2D) so a thin
  // parapet is thick on its outer side: whatever the resolver pushes out of it goes back inward.
  const quad = (a, b, th, y0, y1, kind = 'wall', out = null) => {
    let dx = b[0] - a[0], dz = b[1] - a[1]; const l = hyp(dx, dz) || 1; dx /= l; dz /= l;
    let n0, n1;
    if (out) { n0 = [-out[0] * th[0], -out[1] * th[0]]; n1 = [out[0] * th[1], out[1] * th[1]]; }
    else { n0 = [dz * th / 2, -dx * th / 2]; n1 = [-dz * th / 2, dx * th / 2]; }
    col.push({ kind, height: y1 - y0, y0, y1, points: [[a[0] + n1[0], a[1] + n1[1]], [b[0] + n1[0], b[1] + n1[1]], [b[0] + n0[0], b[1] + n0[1]], [a[0] + n0[0], a[1] + n0[1]]] });
  };
  // deck parapets with openings at the stair tops
  const gaps = station.stairs.map((st) => ({ s: st.s, edge: st.edge, hw: st.w / 2 + 0.4 }));
  const ds = 3;
  for (const edge of ['north', 'south']) {
    // face line: the inner face of the parapet; the collider reaches 0.2 onto the sidewalk and 3 u out
    const t = edge === 'north' ? sec.north + PLAN.deck.parapetW : sec.south - PLAN.deck.parapetW;
    const out = edge === 'north' ? [-band.nx, -band.nz] : [band.nx, band.nz];
    for (let s = band.s0 - 1.5; s < band.s1 + 1.5 - 1e-6; s += ds / 2) {
      const s2 = Math.min(s + ds / 2, band.s1 + 1.5);
      if (gaps.some((g) => g.edge === edge && s2 > g.s - g.hw && s < g.s + g.hw)) continue;
      const y = Math.min(band.deckY(s), band.deckY(s2)) + KERB;
      quad(band.W(s, t), band.W(s2, t), [0.2, 3.0], y - 0.6, y + PARAPET_H, 'wall', out);
    }
  }
  // central barrier
  for (let s = band.s0; s < band.s1 - 1e-6; s += ds) {
    const s2 = Math.min(s + ds, band.s1);
    const y = Math.min(band.deckY(s), band.deckY(s2));
    quad(band.W(s, sec.m0), band.W(s2, sec.m0), PLAN.deck.barrierW, y - 0.6, y + BARRIER_H);
  }
  // abutments: block anyone below from walking into the fill behind them
  for (const s of [band.s0, band.s1]) {
    const y = band.deckY(s);
    quad(band.W(s, sec.north), band.W(s, sec.south), 1.2, y - 40, y - DECK_DEPTH, 'abutment');
  }
  // ground walls (retaining walls and drops beside at-grade roads)
  for (const w of walls) {
    const N = normals(w.pts);
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const lo = Math.min(w.bot[i], w.bot[i + 1]), hi = Math.max(w.top[i], w.top[i + 1]);
      const out = [(N[i][0] + N[i + 1][0]) / 2 * w.side, (N[i][1] + N[i + 1][1]) / 2 * w.side];
      const ol = hyp(...out) || 1; out[0] /= ol; out[1] /= ol;
      // parapet on top of a drop: thin on the road side, 3 u deep over the drop
      if (w.type === 'drop') quad(w.pts[i], w.pts[i + 1], [0.1, 3.0], Math.min(w.top[i], w.top[i + 1]) - 0.6, hi + PARAPET_H, 'wall', out);
      // the wall face itself, for anyone down below (or, for an 'up' wall, on the road)
      quad(w.pts[i], w.pts[i + 1], w.type === 'up' ? [0.1, 3.0] : [-0.4, 3.0], lo - 0.6, hi, 'retaining', out);
    }
  }
  // stair side walls (glass enclosure)
  for (const st of station.stairs) {
    const nx = -st.dir[1], nz = st.dir[0];
    for (const side of [1, -1]) {
      const o = (st.w / 2 + 0.15) * side;
      const a = [st.a[0] + nx * o, st.a[1] + nz * o], b = [st.b[0] + nx * o, st.b[1] + nz * o];
      quad(a, b, 0.3, Math.min(st.y0, st.y1) - 0.6, Math.max(st.y0, st.y1) + 2.6);
    }
  }
  return col;
}

// ---------- signals, crossings ----------
function designFurniture(net, Y) {
  const { tagged, nodes, ways } = net;
  const signals = [], crossings = [], stops = [];
  const wayAt = (id) => [...(nodes.get(id)?.ways || [])].map((i) => ways[i]).filter((w) => w.kind === 'road');
  for (let n of tagged) {
    const t = n.tags;
    const ws = wayAt(n.id);
    if (!ws.length) continue;
    const w = ws.sort((a, b) => b.rank - a.rank)[0];
    const i = w.ids.indexOf(n.id), pts = w.pts;
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const l = hyp(dx, dz) || 1; dx /= l; dz /= l;
    const y = Y.get(n.id) ?? w.ys[i];
    const nn = nodes.get(n.id); n = { ...n, x: nn.x, z: nn.z };
    if (t.highway === 'traffic_signals') signals.push({ id: n.id, x: n.x, z: n.z, y, dir: [dx, dz], hw: w.width / 2, way: w.idx, oneway: w.oneway, ref: t.ref || '' });
    else if (t.highway === 'crossing' || t.crossing) crossings.push({ id: n.id, x: n.x, z: n.z, y, dir: [dx, dz], hw: w.width / 2, way: w.idx, signals: t.crossing === 'traffic_signals' });
    else if (t.highway === 'bus_stop') stops.push({ id: n.id, x: n.x, z: n.z, y, dir: [dx, dz], hw: w.width / 2, way: w.idx, name: t['name:en'] || '' });
  }
  return { signals, crossings, stops };
}

// ---------- entry ----------
export function createDesign(osm, groundAt, { log = () => {} } = {}) {
  const t0 = performance.now();
  const net = buildNetwork(osm);
  for (const w of net.ways) wayProps(w);
  // nodes moved by the design keep their positions on the node objects (shared by every way)
  const nCorr = relayCorridor(net);
  const band = relayBridge(net);
  densify(net, 8);
  const Y = solveHeights(net, band, groundAt, log);
  classifySegments(net, band);
  // the platforms follow the rails' (smoothed) level
  const ground = gradeGround(net, band, groundAt);
  const onOther = makeOnOther(net);
  const walls = findWalls(net, band, ground, onOther);
  const station = designStation(net, band, (x, z) => ground.at(x, z));
  const furniture = designFurniture(net, Y);
  const sidewalks = designSidewalks(net, band, onOther, ground);
  const D = { net, ways: net.ways, band, ground, walls, station, furniture, sidewalks, Y, groundAt };
  const surf = buildSurfaces(D);
  D.heightAt = surf.heightAt; D.strips = surf.strips; D.polys = surf.polys;
  D.colliders = buildColliders(D);
  // is (x, z) on a carriageway, a track bed or a platform (with a margin)? Piers and columns avoid these.
  const occ = new SegGrid(20);
  for (const w of net.ways) {
    // at-grade footways and cycleways count too: no pier stands in a path (the game keeps them)
    const pts = w.pts || wayPts(net, w);
    if (w.kind === 'path' && (w.layer || w.hw === 'steps')) continue;
    if (w.kind === 'road' || w.kind === 'rail' || w.kind === 'path') for (let i = 0; i + 1 < pts.length; i++) if (w.kind !== 'road' || w.struct[i] === 'grade') occ.add({ w, i, pts }, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w.width / 2 + 4);
  }
  D.onRoadOrRail = (x, z, m = 0) => {
    for (const { w, i, pts } of occ.at(x, z)) if (segClosest(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]).d < w.width / 2 + m) return true;
    return station.plats.some((pl) => inPoly(x, z, pl.ring));
  };
  // ---- what the game needs (src/world/dayan/index.js) ----
  const sec0 = band.sec;
  const [bx0, bz0, bx1, bz1] = net.box;
  D.box = net.box;
  D.deckPoly = [band.W(band.s0, sec0.north), band.W(band.s1, sec0.north), band.W(band.s1, sec0.south), band.W(band.s0, sec0.south)];
  D.inBox = (x, z) => x > bx0 && x < bx1 && z > bz0 && z < bz1;
  // every carriageway (deck included) and track bed, for "is this on a road" questions
  const allRoads = new SegGrid(20);
  for (const w of net.ways) if (w.kind === 'road' || w.kind === 'rail') for (let i = 0; i + 1 < w.pts.length; i++) allRoads.add({ w, i }, w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1], w.width / 2 + 6);
  D.onCarriage = (x, z, m = 0) => {
    for (const { w, i } of allRoads.at(x, z)) if (segClosest(x, z, w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1]).d < w.width / 2 + m) return true;
    return band.inBand(x, z) && D.heightAt(x, z, 1e9) > ground.at(x, z) + 2; // on the deck
  };
  D.boundaryNodes = [...net.nodes.values()].filter((n) => n.boundary).map((n) => ({ x: n.x, z: n.z, way: n.ways.size ? net.ways[[...n.ways][0]].osmId : null }));
  // city.roads entries (contract of city.js): the traffic graph, the signal plan and the minimap
  // read them. `abs` is the exact surface height per point; `heights` the rise over the ground.
  D.roadEntries = () => net.ways.filter((w) => w.kind === 'road' || w.kind === 'rail').map((w) => {
    const e = { kind: w.kind === 'rail' ? 'rail' : w.hw, width: w.width, name: w.tags.name || '', points: w.pts.map((p) => [p[0], p[1]]), owner: 'dayan' };
    if (w.tags['name:en']) e.nameEn = w.tags['name:en'];
    e.abs = w.pts.map((p, i) => ground.gy(p[0], p[1], w.ys[i]));
    e.heights = w.pts.map((p, i) => Math.max(0, e.abs[i] - ground.at(p[0], p[1])));
    e.surface = e.abs.slice();
    // nothing of the city's own street furniture or parking belongs on these (the lab draws its own)
    e.bridge = true;
    if (w.kind === 'road') { e.lanes = w.lanes; e.oneway = w.oneway; e.rank = w.rank; }
    return e;
  });
  D.crossingEntries = () => furniture.crossings.map((c) => ({ x: c.x, z: c.z, angle: Math.atan2(c.dir[0], c.dir[1]), width: c.hw * 2, owner: 'dayan' }));
  D.report = report(D);
  D.report.ms = Math.round(performance.now() - t0);
  D.report.corridorMoves = nCorr;
  log(`design built in ${D.report.ms} ms: ${net.ways.length} ways, ${walls.length} wall runs, ${D.colliders.length} colliders`);
  return D;
}

// Grades, clearances and what crosses what, for the doc and the check.
function report(D) {
  const r = { maxGrade: [], clearance: [], deck: { s0: D.band.s0, s1: D.band.s1, width: D.band.sec.south - D.band.sec.north } };
  for (const w of D.ways) {
    if (w.kind !== 'road') continue;
    let g = 0, at = null;
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const l = hyp(w.pts[i + 1][0] - w.pts[i][0], w.pts[i + 1][1] - w.pts[i][1]); if (l < 1) continue;
      const gg = Math.abs(w.ys[i + 1] - w.ys[i]) / l; if (gg > g) { g = gg; at = w.pts[i]; }
    }
    r.maxGrade.push({ osm: w.osmId, hw: w.hw, grade: +(g * 100).toFixed(1), at: at && at.map((v) => Math.round(v)) });
  }
  r.maxGrade.sort((a, b) => b.grade - a.grade);
  for (const u of D.band.under) {
    const y = D.band.deckY(u.s) - DECK_DEPTH;
    r.clearance.push({ kind: u.kind, hw: u.hwName || '', s: +u.s.toFixed(1), free: +(y - u.y).toFixed(2) });
  }
  return r;
}
