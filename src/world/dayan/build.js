// Meshes for the Moshe Dayan interchange design (src/design.js). Everything is merged into a few
// vertex-coloured toon meshes (one per material), like city.js does, so the whole interchange is a
// handful of draw calls and can be added to the game as one group.
import * as THREE from 'three';
import { toonRamp } from '../../engine/renderer.js';
import {
  LANE, SW, KERB, DECK_DEPTH, BARRIER_H, PLAT_H, PLAN, normals, offsetLine, inPoly,
} from './design.js';

const hex = (h) => new THREE.Color(h);
export const COL = {
  grass: hex(0x93c968), grassDry: hex(0xb7c27a), earth: hex(0xc9b083), verge: hex(0xa9bf72),
  asphalt: hex(0x44464c), asphaltMw: hex(0x3d3f45), asphaltDeck: hex(0x46484e),
  line: hex(0xf4f2ea), lineYellow: hex(0xf0c541), stop: hex(0xffffff),
  sidewalk: hex(0xd6d6d2), sidewalkSide: hex(0xaaa79f), kerb: hex(0xbdbab2), kerbRed: hex(0xc9473b), kerbWhite: hex(0xf3f0e8),
  concrete: hex(0xd8d2c6), concreteDark: hex(0xbfb9ad), underside: hex(0x9d988f), rib: hex(0x8f8a82),
  parapetTop: hex(0xf0ece4), steel: hex(0xc4cad0), steelDark: hex(0x6f767e), barrier: hex(0xe2ded6),
  pier: hex(0xcac4b7), joint: hex(0x55524e), wall: hex(0xd0c9bb), wallTop: hex(0xe8e2d6),
  ballast: hex(0x968d82), sleeper: hex(0x6b5747), rail: hex(0x9a9792), mast: hex(0x8a9096),
  platform: hex(0xd9d0c0), platformSide: hex(0xb7ae9f), tactile: hex(0xf2c94c), safety: hex(0xf6f1e3),
  canopy: hex(0xf3f4f1), canopyEdge: hex(0x2f8f6f), hallRoof: hex(0xa9adb2), hallRib: hex(0x8d9298),
  glass: hex(0x9fd3e6), stairTread: hex(0xcfc6b8), stairRiser: hex(0xb0a796), handrail: hex(0x8c949b),
  pole: hex(0x6c737a), head: hex(0x2b2f33), red: hex(0xff3b30), amber: hex(0xffb020), green: hex(0x34d06b),
  lamp: hex(0xfff1bf), signGreen: hex(0x1f7a4d), building: hex(0xe9e2d4), buildingRoof: hex(0xcfc7b8),
};

// Vertex-coloured triangle soup with flat normals.
class Soup {
  constructor() { this.p = []; this.n = []; this.c = []; }
  tri(a, b, c, col, up) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (up && nx * up[0] + ny * up[1] + nz * up[2] < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz); if (l < 1e-12) return;
    for (const v of [a, b, c]) { this.p.push(v[0], v[1], v[2]); this.n.push(nx / l, ny / l, nz / l); this.c.push(col.r, col.g, col.b); }
  }
  quad(a, b, c, d, col, up) { this.tri(a, b, c, col, up); this.tri(a, c, d, col, up); }
  // vertical wall between two ground points, from y0s to y1s, facing `out` (2D)
  wall(a, b, ya0, ya1, yb0, yb1, col, out) {
    this.quad([a[0], ya0, a[1]], [b[0], yb0, b[1]], [b[0], yb1, b[1]], [a[0], ya1, a[1]], col, out ? [out[0], 0, out[1]] : null);
  }
  // oriented box: centre, half sizes along (u, v=up, w), u is a unit 2D direction
  box(cx, cy, cz, hu, hv, hw, ux, uz, col, colTop = col) {
    const wx = -uz, wz = ux;
    const P = (su, sv, sw) => [cx + ux * hu * su + wx * hw * sw, cy + hv * sv, cz + uz * hu * su + wz * hw * sw];
    const f = [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)], t = [P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)];
    this.quad(t[0], t[1], t[2], t[3], colTop, [0, 1, 0]);
    this.quad(f[0], f[3], f[2], f[1], col, [0, -1, 0]);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; const mx = (f[i][0] + f[j][0]) / 2 - cx, mz = (f[i][2] + f[j][2]) / 2 - cz; this.quad(f[i], f[j], t[j], t[i], col, [mx, 0, mz]); }
  }
  // vertical prism over a 2D ring
  prism(ring, y0, y1, colSide, colTop) {
    let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      this.wall(a, b, y0, y1, y0, y1, colSide, [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz]);
    }
    if (colTop) this.poly(ring, y1, colTop);
  }
  // flat polygon (ear clipping, fine for the simple rings used here)
  poly(ring, y, col, up = [0, 1, 0]) {
    const pts = ring.map((p) => [p[0], p[1]]);
    let area = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
    const idx = pts.map((_, i) => i); if (area < 0) idx.reverse();
    let guard = 0;
    while (idx.length > 3 && guard++ < 5000) {
      let cut = false;
      for (let i = 0; i < idx.length; i++) {
        const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
        const a = pts[ia], b = pts[ib], c = pts[ic];
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0) continue;
        let inside = false;
        for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inPoly(pts[j][0], pts[j][1], [a, b, c])) { inside = true; break; } }
        if (inside) continue;
        this.tri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], col, up); idx.splice(i, 1); cut = true; break;
      }
      if (!cut) break;
    }
    if (idx.length === 3) { const [a, b, c] = idx.map((i) => pts[i]); this.tri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], col, up); }
  }
  // ribbon along a polyline: per-vertex heights, offsets left/right of the centre line (along n)
  ribbon(pts, ys, o0, o1, col, lift = 0, up = [0, 1, 0]) {
    const N = normals(pts);
    for (let i = 0; i + 1 < pts.length; i++) {
      const e = (k, o) => [pts[k][0] + N[k][0] * o, ys[k] + lift, pts[k][1] + N[k][1] * o];
      this.quad(e(i, o0), e(i + 1, o0), e(i + 1, o1), e(i, o1), col, up);
    }
  }
  mesh(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; return m;
  }
  get tris() { return this.p.length / 9; }
  // The 2-unit graded ground is ~300k triangles; one mesh of it was drawn whole whenever any
  // corner of the box was on screen. Tiles by triangle centre frustum-cull separately.
  tileMeshes(mat, cell) {
    const buckets = new Map();
    for (let t = 0; t < this.p.length / 9; t++) {
      const o = t * 9;
      const k = `${Math.floor((this.p[o] + this.p[o + 3] + this.p[o + 6]) / 3 / cell)},${Math.floor((this.p[o + 2] + this.p[o + 5] + this.p[o + 8]) / 3 / cell)}`;
      let b = buckets.get(k);
      if (!b) { b = new Soup(); buckets.set(k, b); }
      for (let i = o; i < o + 9; i++) { b.p.push(this.p[i]); b.n.push(this.n[i]); b.c.push(this.c[i]); }
    }
    return [...buckets.values()].map((b) => b.mesh(mat));
  }
}

const cumLen = (pts) => { const s = [0]; for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return s; };
// Sample a polyline at arc length t: point, height, unit direction.
function sampler(pts, ys) {
  const L = cumLen(pts);
  return {
    len: L[L.length - 1],
    at(t) {
      let i = 0; while (i < L.length - 2 && L[i + 1] < t) i++;
      const seg = L[i + 1] - L[i] || 1, f = Math.min(1, Math.max(0, (t - L[i]) / seg));
      const a = pts[i], b = pts[i + 1];
      const dx = (b[0] - a[0]) / seg, dz = (b[1] - a[1]) / seg;
      return { x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, y: ys[i] + (ys[i + 1] - ys[i]) * f, dx, dz };
    },
  };
}

export function buildInterchange(D, { context = true, signals = true } = {}) {
  const root = new THREE.Group(); root.name = 'moshe-dayan-interchange';
  const ramp = toonRamp();
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
  // asphalt and sidewalks win over draped ground cover (city.js grass and park layers), the
  // markings over the asphalt: the same depth ladder as city.js's layers
  const matRoad = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 });
  const matMark = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -24 });
  const matGlass = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, transparent: true, opacity: 0.38, depthWrite: false });
  const matGlow = new THREE.MeshBasicMaterial({ vertexColors: true });
  // the graded ground lies exactly under the asphalt of at-grade roads; push it back in depth
  const matGround = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 6 });
  const S = { ground: new Soup(), road: new Soup(), mark: new Soup(), struct: new Soup(), hall: new Soup(), glass: new Soup(), glow: new Soup(), ctx: new Soup() };
  const { band, ground, ways } = D;
  const sec = band.sec;
  const gy = ground.gy;
  const stats = {};

  // ---------- ground (graded grid) ----------
  {
    const g = ground, s = S.ground;
    const colAt = (k) => (g.kind[k] === 1 ? COL.verge : g.kind[k] === 2 ? COL.grassDry : COL.grass);
    for (let j = 0; j < g.nz - 1; j++) for (let i = 0; i < g.nx - 1; i++) {
      const k = j * g.nx + i;
      const P = (ii, jj) => [g.x0 + ii * g.step, g.h[jj * g.nx + ii] - 0.03, g.z0 + jj * g.step];
      const c = colAt(k);
      s.quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), c, [0, 1, 0]);
    }
    if (context) {
      // a ring of the game's own terrain around the box, so the cut-out does not float
      const [x0, z0, x1, z1] = D.net.box, M = 360, st = 12;
      for (let z = z0 - M; z < z1 + M; z += st) for (let x = x0 - M; x < x1 + M; x += st) {
        if (x >= x0 && x + st <= x1 && z >= z0 && z + st <= z1) continue;
        const P = (xx, zz) => [xx, D.groundAt(Math.min(Math.max(xx, x0 - M), x1 + M), zz) - 0.05, zz];
        S.ctx.quad(P(x, z), P(x + st, z), P(x + st, z + st), P(x, z + st), COL.grass.clone().lerp(COL.grassDry, 0.35), [0, 1, 0]);
      }
    }
  }

  // ---------- roads ----------
  const jNodes = new Map(); // junction node id -> { x, z, y, r }
  for (const [id, n] of D.net.nodes) {
    const ws = [...n.ways].map((i) => ways[i]).filter((w) => w.kind === 'road');
    if (ws.length < 2) continue;
    const ends = ws.filter((w) => w.ids[0] === id || w.ids[w.ids.length - 1] === id).length;
    if (ws.length === 2 && ends === 2 && ws[0].width === ws[1].width) continue; // plain continuation
    const r = Math.max(...ws.map((w) => w.width / 2)) * 1.02;
    jNodes.set(id, { x: n.x, z: n.z, y: D.Y.get(id), r });
  }
  const nearJunction = (x, z, pad = 0) => { for (const j of jNodes.values()) if (Math.hypot(x - j.x, z - j.z) < j.r + pad) return true; return false; };
  for (const w of ways) {
    if (w.kind !== 'road') continue;
    const c = w.hw === 'motorway' ? COL.asphaltMw : COL.asphalt;
    // at-grade asphalt lies on the graded ground (the walking surface), decks on their own height
    {
      const N = normals(w.pts);
      for (let i = 0; i + 1 < w.pts.length; i++) {
        const e = (k, o) => { const x = w.pts[k][0] + N[k][0] * o, z = w.pts[k][1] + N[k][1] * o; return [x, gy(x, z, w.ys[k]) + 0.04, z]; };
        S.road.quad(e(i, -w.width / 2), e(i + 1, -w.width / 2), e(i + 1, w.width / 2), e(i, w.width / 2), c, [0, 1, 0]);
      }
    }
    // caps at the ends so a road ending on another one has no visible seam
    for (const k of [0, w.pts.length - 1]) {
      const p = w.pts[k], y = w.ys[k] + 0.04, r = w.width / 2, ring = [];
      for (let a = 0; a < 16; a++) ring.push([p[0] + Math.cos(a / 16 * Math.PI * 2) * r, p[1] + Math.sin(a / 16 * Math.PI * 2) * r]);
      if (jNodes.has(w.ids[k])) S.road.poly(ring, gy(p[0], p[1], y - 0.04) + 0.035, c);
    }
  }
  // junction plates
  for (const j of jNodes.values()) {
    const ring = []; for (let a = 0; a < 20; a++) ring.push([j.x + Math.cos(a / 20 * Math.PI * 2) * j.r * 0.8, j.z + Math.sin(a / 20 * Math.PI * 2) * j.r * 0.8]);
    S.road.poly(ring, gy(j.x, j.z, j.y) + 0.035, COL.asphalt);
  }

  // ---------- lane markings, arrows, stop lines ----------
  const dash = (s, smp, off, on, gap, col, width = 0.26, solid = false) => {
    for (let t = 2; t < smp.len - 2; t += solid ? 2 : on + gap) {
      const t1 = Math.min(smp.len - 2, t + (solid ? 2 : on));
      const a = smp.at(t), b = smp.at(t1);
      const pa = [a.x - a.dz * off, a.z + a.dx * off], pb = [b.x - b.dz * off, b.z + b.dx * off];
      if (nearJunction(pa[0], pa[1], 1) || nearJunction(pb[0], pb[1], 1)) continue;
      const nx = -a.dz * width / 2, nz = a.dx * width / 2;
      const ya = gy(pa[0], pa[1], a.y) + 0.07, yb = gy(pb[0], pb[1], b.y) + 0.07;
      s.quad([pa[0] - nx, ya, pa[1] - nz], [pb[0] - nx, yb, pb[1] - nz], [pb[0] + nx, yb, pb[1] + nz], [pa[0] + nx, ya, pa[1] + nz], col, [0, 1, 0]);
    }
  };
  const signalAt = new Map(D.furniture.signals.map((s) => [s.id, s]));
  for (const w of ways) {
    if (w.kind !== 'road' || w.hw === 'service' || !w.lanes) continue;
    const smp = sampler(w.pts, w.ys);
    const half = (w.lanes * LANE) / 2;
    for (let k = 1; k < w.lanes; k++) dash(S.mark, smp, -half + k * LANE, 3.6, 6, COL.line);
    if (w.oneway) {
      dash(S.mark, smp, -half - 0.25, 0, 0, w.cls.urban ? COL.line : COL.lineYellow, 0.3, true); // left edge: yellow on motorways
      dash(S.mark, smp, half + 0.25, 0, 0, COL.line, 0.3, true);
    } else {
      dash(S.mark, smp, 0, 0, 0, COL.line, 0.22, true); // centre line (two-way)
      dash(S.mark, smp, -half - 0.25, 0, 0, COL.line, 0.22, true);
      dash(S.mark, smp, half + 0.25, 0, 0, COL.line, 0.22, true);
    }
    // stop line and arrows where the way ends at a signal (or carries turn lanes)
    const endId = w.ids[w.ids.length - 1];
    const sig = [...w.ids].reverse().find((id) => signalAt.has(id));
    let stopT = null;
    if (sig !== undefined && w.oneway) {
      const i = w.ids.indexOf(sig), L = cumLen(w.pts);
      stopT = L[i] - 3;
      const p = smp.at(stopT), nx = -p.dz, nz = p.dx;
      const a = [p.x + nx * (-half), p.z + nz * (-half)], b = [p.x + nx * half, p.z + nz * half];
      const ux = p.dx * 0.4, uz = p.dz * 0.4;
      const ya = gy(a[0], a[1], p.y) + 0.075, yb = gy(b[0], b[1], p.y) + 0.075;
      S.mark.quad([a[0] - ux, ya, a[1] - uz], [b[0] - ux, yb, b[1] - uz], [b[0] + ux, yb, b[1] + uz], [a[0] + ux, ya, a[1] + uz], COL.stop, [0, 1, 0]);
    }
    if (w.turn && w.turn.length === w.lanes && w.oneway) {
      const tEnd = stopT ?? smp.len - 6;
      for (const back of [6, 34]) {
        const T0 = tEnd - back; if (T0 < 4) continue;
        w.turn.forEach((tt, k) => arrow(S.mark, smp, T0, -half + (k + 0.5) * LANE, tt));
      }
    } else if (w.oneway && w.lanes && stopT) {
      for (let k = 0; k < w.lanes; k++) arrow(S.mark, smp, stopT - 8, -half + (k + 0.5) * LANE, 'through');
    }
    void endId;
  }
  function arrow(s, smp, t, off, type) {
    const p = smp.at(t), y = gy(p.x - p.dz * off, p.z + p.dx * off, p.y) + 0.08;
    const fx = p.dx, fz = p.dz, rx = -p.dz, rz = p.dx; // forward, right
    const at = (f, r) => [p.x + rx * off + fx * f + rx * r, y, p.z + rz * off + fz * f + rz * r];
    const q = (a, b, c, d) => s.quad(a, b, c, d, COL.line, [0, 1, 0]);
    const tri = (a, b, c) => s.tri(a, b, c, COL.line, [0, 1, 0]);
    const kinds = String(type || 'through').split(';');
    // shaft
    q(at(-3.2, -0.2), at(0.6, -0.2), at(0.6, 0.2), at(-3.2, 0.2));
    for (const k of kinds) {
      if (k === 'through' || k === '' || k === 'none') { tri(at(0.6, -0.75), at(2.2, 0), at(0.6, 0.75)); }
      else if (k.includes('left') || k.includes('right')) {
        const sgn = k.includes('left') ? -1 : 1;
        q(at(0.2, 0), at(0.6, 0), at(0.6, sgn * 1.4), at(0.2, sgn * 1.4));
        tri(at(-0.3, sgn * 1.4), at(1.1, sgn * 1.4), at(0.4, sgn * 2.3));
      }
    }
  }

  // ---------- sidewalks ----------
  for (const r of D.sidewalks) {
    const w = ways[r.way], side = r.side;
    const N = normals(r.pts);
    const inner = r.pts.map((p, i) => [p[0] - N[i][0] * side * SW / 2, p[1] - N[i][1] * side * SW / 2]);
    const outer = r.pts.map((p, i) => [p[0] + N[i][0] * side * SW / 2, p[1] + N[i][1] * side * SW / 2]);
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const y0 = r.ys[i], y1 = r.ys[i + 1];
      S.road.quad([inner[i][0], y0, inner[i][1]], [inner[i + 1][0], y1, inner[i + 1][1]], [outer[i + 1][0], y1, outer[i + 1][1]], [outer[i][0], y0, outer[i][1]], COL.sidewalk, [0, 1, 0]);
      const kc = (i % 2) ? COL.kerbWhite : COL.kerb;
      S.road.wall(inner[i], inner[i + 1], y0 - KERB, y0, y1 - KERB, y1, kc, [-N[i][0] * side, -N[i][1] * side]);
      const g0 = ground.at(...outer[i]), g1 = ground.at(...outer[i + 1]);
      S.road.wall(outer[i], outer[i + 1], Math.min(g0, y0 - KERB) - 0.3, y0, Math.min(g1, y1 - KERB) - 0.3, y1, COL.sidewalkSide, [N[i][0] * side, N[i][1] * side]);
    }
    void w;
  }

  // ---------- the bridge ----------
  buildDeck(D, S, stats);

  // ---------- walls from grading ----------
  for (const wr of D.walls) {
    const w = ways[wr.way];
    const N = normals(wr.pts);
    for (let i = 0; i + 1 < wr.pts.length; i++) {
      const a = wr.pts[i], b = wr.pts[i + 1];
      const out = [N[i][0] * wr.side, N[i][1] * wr.side];
      const oa = [a[0] + out[0] * 0.7, a[1] + out[1] * 0.7], ob = [b[0] + out[0] * 0.7, b[1] + out[1] * 0.7];
      if (wr.type === 'drop') {
        // the road above: a parapet on its edge and the wall face down to the ground beside it
        S.struct.wall(oa, ob, wr.bot[i] - 0.5, wr.top[i], wr.bot[i + 1] - 0.5, wr.top[i + 1], COL.wall, out);
        parapet(S.struct, a, b, wr.top[i], wr.top[i + 1], out, 0.7);
      } else {
        // retaining wall holding the bank above the road
        S.struct.wall(a, b, wr.bot[i] - 0.3, wr.top[i] + 0.4, wr.bot[i + 1] - 0.3, wr.top[i + 1] + 0.4, COL.wall, [-out[0], -out[1]]);
        S.struct.quad([a[0], wr.top[i] + 0.4, a[1]], [b[0], wr.top[i + 1] + 0.4, b[1]], [ob[0], wr.top[i + 1] + 0.4, ob[1]], [oa[0], wr.top[i] + 0.4, oa[1]], COL.wallTop, [0, 1, 0]);
        // fence on top so nobody walks off the bank
        if (i % 2 === 0) S.struct.box((oa[0] + a[0]) / 2, wr.top[i] + 1.4, (oa[1] + a[1]) / 2, 0.08, 1.0, 0.08, 1, 0, COL.steelDark);
        railLine(S.struct, [(a[0] + oa[0]) / 2, (a[1] + oa[1]) / 2], [(b[0] + ob[0]) / 2, (b[1] + ob[1]) / 2], wr.top[i] + 2.3, wr.top[i + 1] + 2.3, 0.08, COL.steelDark);
      }
    }
    void w;
  }

  // ---------- rails, catenary ----------
  for (const w of ways) {
    if (w.kind !== 'rail') continue;
    S.struct.ribbon(w.pts, w.ys, -3.0, 3.0, COL.ballast, 0.18);
    const smp = sampler(w.pts, w.ys);
    for (let t = 0.6; t < smp.len; t += 1.5) {
      const p = smp.at(t);
      S.struct.box(p.x, p.y + 0.3, p.z, 0.35, 0.09, 1.55, p.dx, p.dz, COL.sleeper);
    }
    for (const off of [-0.86, 0.86]) {
      const line = offsetLine(w.pts, off);
      S.struct.ribbon(line, w.ys, -0.1, 0.1, COL.rail, 0.5);
    }
    // catenary: masts every 55 u on the west side of each track, contact wire 6.4 u up
    for (let t = 20; t < smp.len; t += 55) {
      const p = smp.at(t), nx = -p.dz, nz = p.dx;
      const mx = p.x - nx * 3.6, mz = p.z - nz * 3.6;
      if (band.inBand(mx, mz)) continue;
      S.struct.box(mx, p.y + 4.2, mz, 0.22, 4.2, 0.22, p.dx, p.dz, COL.mast);
      S.struct.box((mx + p.x) / 2, p.y + 7.6, (mz + p.z) / 2, 1.9, 0.09, 0.09, nx, nz, COL.mast);
    }
    const wire = w.pts, ys = w.ys.map((y) => y + 6.6);
    S.struct.ribbon(wire, ys, -0.05, 0.05, COL.steelDark, 0, [0, 1, 0]);
  }

  // ---------- Ayalon: barrier and fence towards the rails, sign gantries (both in the aerial photo) ----------
  buildMotorwayKit(D, S);

  // ---------- station ----------
  buildStation(D, S);

  // ---------- signals, crossings ----------
  buildFurniture(D, S, signals);

  // ---------- context buildings ----------
  if (context) for (const b of D.net.buildings) {
    const [cx, cz] = b.ring.reduce((a, p) => [a[0] + p[0] / b.ring.length, a[1] + p[1] / b.ring.length], [0, 0]);
    if (band.inBand(cx, cz)) continue;
    const g = Math.min(...b.ring.map((p) => D.groundAt(...p)));
    const lv = +b.tags['building:levels'] || (b.ring.length > 8 ? 4 : 2);
    S.ctx.prism(b.ring, g - 0.5, g + lv * 4.2, COL.building, COL.buildingRoof);
  }

  const add = (soup, m, name) => { if (!soup.p.length) return; const mesh = soup.mesh(m); mesh.name = name; root.add(mesh); stats[name] = soup.tris; return mesh; };
  if (S.ground.p.length) {
    for (const m of S.ground.tileMeshes(matGround, 160)) { m.name = 'ground'; m.castShadow = false; root.add(m); }
    stats.ground = S.ground.tris;
  }
  add(S.ctx, matGround, 'context');
  add(S.road, matRoad, 'roads');
  add(S.mark, matMark, 'markings');
  add(S.struct, mat, 'structures');
  add(S.hall, mat, 'station-roofs'); // hall vault, platform canopies, stair roofs: hidden together (index.js)
  add(S.glass, matGlass, 'glass');
  const glow = add(S.glow, matGlow, 'lights'); if (glow) glow.castShadow = false;
  const mk = root.getObjectByName('markings'); if (mk) mk.castShadow = false;
  const gm = root.getObjectByName('ground'); if (gm) gm.castShadow = false;
  root.userData.stats = stats;
  return root;
}

// concrete base + steel railing along a line (a to b), heights at the base, `out` = outward 2D
function parapet(s, a, b, ya, yb, out, th = 0.6) {
  const ia = [a[0] - out[0] * 0.0, a[1] - out[1] * 0.0], ib = [b[0], b[1]];
  const oa = [a[0] + out[0] * th, a[1] + out[1] * th], ob = [b[0] + out[0] * th, b[1] + out[1] * th];
  const h = BARRIER_H;
  s.wall(ia, ib, ya, ya + h, yb, yb + h, COL.concrete, [-out[0], -out[1]]);
  s.wall(oa, ob, ya - 0.3, ya + h, yb - 0.3, yb + h, COL.concreteDark, out);
  s.quad([ia[0], ya + h, ia[1]], [ib[0], yb + h, ib[1]], [ob[0], yb + h, ob[1]], [oa[0], ya + h, oa[1]], COL.parapetTop, [0, 1, 0]);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / (L || 1), uz = (b[1] - a[1]) / (L || 1);
  const mid = [(a[0] + oa[0]) / 2, (a[1] + oa[1]) / 2], midB = [(b[0] + ob[0]) / 2, (b[1] + ob[1]) / 2];
  for (let t = 0; t < L; t += 3) s.box(mid[0] + ux * t, ya + (yb - ya) * (t / (L || 1)) + h + 0.6, mid[1] + uz * t, 0.07, 0.6, 0.07, ux, uz, COL.steelDark);
  railLine(s, mid, midB, ya + h + 1.15, yb + h + 1.15, 0.09, COL.steel);
  railLine(s, mid, midB, ya + h + 0.6, yb + h + 0.6, 0.06, COL.steel);
}
function railLine(s, a, b, ya, yb, r, col) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.01) return;
  const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -uz * r, nz = ux * r;
  s.quad([a[0] - nx, ya + r, a[1] - nz], [b[0] - nx, yb + r, b[1] - nz], [b[0] + nx, yb + r, b[1] + nz], [a[0] + nx, ya + r, a[1] + nz], col, [0, 1, 0]);
  s.quad([a[0] - nx, ya - r, a[1] - nz], [b[0] - nx, yb - r, b[1] - nz], [b[0] - nx, yb + r, b[1] - nz], [a[0] - nx, ya + r, a[1] - nz], col, [-nx, 0, -nz]);
  s.quad([a[0] + nx, ya - r, a[1] + nz], [b[0] + nx, yb - r, b[1] + nz], [b[0] + nx, yb + r, b[1] + nz], [a[0] + nx, ya + r, a[1] + nz], col, [nx, 0, nz]);
}

// ---------- the deck ----------
function buildDeck(D, S, stats) {
  const { band } = D, sec = band.sec, s = S.struct, rd = S.road;
  const W = band.W, Y = band.deckY;
  const ds = 2;
  const s0 = band.s0, s1 = band.s1;
  const tN = sec.north, tS = sec.south, pw = PLAN.deck.parapetW;
  const gaps = D.station.stairs.map((st) => ({ s: st.s, edge: st.edge, hw: st.w / 2 + 0.4 }));
  const inGap = (sa, sb, edge) => gaps.some((g) => g.edge === edge && sb > g.s - g.hw && sa < g.s + g.hw);
  const P = (ss, t, dy = 0) => { const p = W(ss, t); return [p[0], Y(ss) + dy, p[1]]; };
  const UP = [0, 1, 0], DN = [0, -1, 0];
  const nOut = [band.nx, band.nz], nIn = [-band.nx, -band.nz];
  for (let a = s0; a < s1 - 1e-6; a += ds) {
    const b = Math.min(a + ds, s1);
    // asphalt across both carriageways (the road ribbons sit on it)
    rd.quad(P(a, sec.wbEdge, 0.02), P(b, sec.wbEdge, 0.02), P(b, sec.ebEdge, 0.02), P(a, sec.ebEdge, 0.02), COL.asphaltDeck, UP);
    // sidewalks with kerbs
    for (const [t0, t1, kerbT, inward] of [[tN + pw, sec.wbEdge, sec.wbEdge, 1], [sec.ebEdge, tS - pw, sec.ebEdge, -1]]) {
      rd.quad(P(a, t0, KERB), P(b, t0, KERB), P(b, t1, KERB), P(a, t1, KERB), COL.sidewalk, UP);
      const ka = W(a, kerbT), kb = W(b, kerbT);
      rd.wall(ka, kb, Y(a), Y(a) + KERB, Y(b), Y(b) + KERB, COL.kerb, inward > 0 ? nOut : nIn);
    }
    // slab underside and fascia
    const bot = -0.9;
    s.quad(P(a, tN, bot), P(b, tN, bot), P(b, tS, bot), P(a, tS, bot), COL.underside, DN);
    for (const [t, out] of [[tN, nIn], [tS, nOut]]) {
      const pa = W(a, t), pb = W(b, t);
      s.wall(pa, pb, Y(a) - 1.35, Y(a) + KERB, Y(b) - 1.35, Y(b) + KERB, COL.concreteDark, out);
      // drip edge
      s.wall(pa, pb, Y(a) - 1.45, Y(a) - 1.35, Y(b) - 1.45, Y(b) - 1.35, COL.rib, out);
    }
    // parapets (openings at the stair tops)
    for (const edge of ['north', 'south']) {
      if (inGap(a, b, edge)) continue;
      const t = edge === 'north' ? tN + pw : tS - pw;
      const out = edge === 'north' ? nIn : nOut;
      parapet(s, W(a, t), W(b, t), Y(a) + KERB, Y(b) + KERB, out, pw);
    }
    // central barrier (New Jersey profile)
    const m = sec.m0, hb = PLAN.deck.barrierW / 2;
    const prof = [[-hb, 0], [-hb * 0.75, 0.25], [-0.2, BARRIER_H], [0.2, BARRIER_H], [hb * 0.75, 0.25], [hb, 0]];
    for (let k = 0; k + 1 < prof.length; k++) {
      const [t0, h0] = prof[k], [t1, h1] = prof[k + 1];
      s.quad(P(a, m + t0, h0 + 0.02), P(b, m + t0, h0 + 0.02), P(b, m + t1, h1 + 0.02), P(a, m + t1, h1 + 0.02), k === 2 ? COL.parapetTop : COL.barrier, UP);
    }
  }
  // girders and diaphragms
  const nG = 9;
  for (let g = 0; g < nG; g++) {
    const t = tN + 2 + (g * (tS - tN - 4)) / (nG - 1);
    for (let a = s0; a < s1 - 1e-6; a += ds) {
      const b = Math.min(a + ds, s1);
      const pa = W(a, t), pb = W(b, t);
      const d0 = -DECK_DEPTH;
      for (const sg of [-0.55, 0.55]) {
        const qa = [pa[0] + band.nx * sg, pa[1] + band.nz * sg], qb = [pb[0] + band.nx * sg, pb[1] + band.nz * sg];
        s.wall(qa, qb, Y(a) + d0, Y(a) - 0.9, Y(b) + d0, Y(b) - 0.9, COL.underside, sg < 0 ? nIn : nOut);
      }
      const qa0 = [pa[0] - band.nx * 0.55, pa[1] - band.nz * 0.55], qa1 = [pa[0] + band.nx * 0.55, pa[1] + band.nz * 0.55];
      const qb0 = [pb[0] - band.nx * 0.55, pb[1] - band.nz * 0.55], qb1 = [pb[0] + band.nx * 0.55, pb[1] + band.nz * 0.55];
      s.quad([qa0[0], Y(a) + d0, qa0[1]], [qb0[0], Y(b) + d0, qb0[1]], [qb1[0], Y(b) + d0, qb1[1]], [qa1[0], Y(a) + d0, qa1[1]], COL.rib, DN);
    }
  }
  for (let a = s0 + 1; a < s1; a += 14) {
    const pa = W(a, tN + 1), pb = W(a, tS - 1);
    s.box((pa[0] + pb[0]) / 2, Y(a) - 1.4, (pa[1] + pb[1]) / 2, (tS - tN - 2) / 2, 0.5, 0.25, band.nx, band.nz, COL.rib);
  }
  // expansion joints and the end diaphragms
  for (const a of [s0, s1]) {
    const pa = W(a, sec.wbEdge), pb = W(a, sec.ebEdge);
    S.mark.quad([pa[0] - band.ux * 0.3, Y(a) + 0.075, pa[1] - band.uz * 0.3], [pb[0] - band.ux * 0.3, Y(a) + 0.075, pb[1] - band.uz * 0.3], [pb[0] + band.ux * 0.3, Y(a) + 0.075, pb[1] + band.uz * 0.3], [pa[0] + band.ux * 0.3, Y(a) + 0.075, pa[1] + band.uz * 0.3], COL.joint, UP);
    // abutment: a wall from the soffit down to the ground below, across the whole deck
    const ga = Math.min(...[tN, (tN + tS) / 2, tS].map((t) => D.ground.at(...W(a + (a === s0 ? 2 : -2), t))));
    const out = a === s0 ? [band.ux, band.uz] : [-band.ux, -band.uz];
    const wa = W(a, tN), wb = W(a, tS);
    s.wall(wa, wb, ga - 1, Y(a) - 0.9, ga - 1, Y(a) - 0.9, COL.concrete, out);
    s.box((wa[0] + wb[0]) / 2 + out[0] * 0.8, ga + 0.4, (wa[1] + wb[1]) / 2 + out[1] * 0.8, (tS - tN) / 2, 0.5, 0.8, band.nx, band.nz, COL.concreteDark);
  }
  // piers: skewed lines in the free gaps between what passes under (carriageways, tracks,
  // platforms), found row by row across the deck and linked along the gap
  const piers = [];
  const free = (ss, t) => { const p = W(ss, t); return !D.onRoadOrRail(p[0], p[1], 0.6); };
  const rowsT = []; for (let t = tN + 3; t <= tS - 3; t += 6) rowsT.push(t);
  for (const t of rowsT) {
    let runStart = null;
    for (let ss = s0 + 5; ss <= s1 - 5; ss += 0.5) {
      const f = free(ss, t);
      if (f && runStart === null) runStart = ss;
      if ((!f || ss + 0.5 > s1 - 5) && runStart !== null) {
        const e = f ? ss : ss - 0.5;
        if (e - runStart >= 1.4 && runStart > s0 + 5.5 && e < s1 - 5.5) piers.push({ s: (runStart + e) / 2, t, w: e - runStart });
        runStart = null;
      }
    }
  }
  // link columns of neighbouring rows into lines (same gap: s within 7 u)
  const lines = [];
  for (const c of piers) {
    const l = lines.find((L) => Math.abs(L[L.length - 1].t - c.t) <= 6.1 && Math.abs(L[L.length - 1].s - c.s) < 7 && L[L.length - 1].t !== c.t);
    if (l) l.push(c); else lines.push([c]);
  }
  for (const L of lines) {
    if (L.length < 2) continue; // a lone column is not worth a pier line
    for (let i = 0; i < L.length; i++) {
      const c = L[i], p = W(c.s, c.t), g = D.ground.at(p[0], p[1]);
      const y = Y(c.s) - DECK_DEPTH;
      const r = Math.max(0.5, Math.min(0.9, c.w / 2 - 0.15));
      const ring = []; for (let k = 0; k < 8; k++) ring.push([p[0] + Math.cos((k + 0.5) / 8 * Math.PI * 2) * r, p[1] + Math.sin((k + 0.5) / 8 * Math.PI * 2) * r]);
      s.prism(ring, g - 0.5, y - 1.2, COL.pier, null);
      if (i + 1 < L.length) {
        const n = L[i + 1], q = W(n.s, n.t);
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]), ux = (q[0] - p[0]) / len, uz = (q[1] - p[1]) / len;
        s.box((p[0] + q[0]) / 2, Math.min(y, Y(n.s) - DECK_DEPTH) - 0.6, (p[1] + q[1]) / 2, len / 2 + 1.2, 0.6, Math.min(1.2, r + 0.3), ux, uz, COL.pier);
      }
      D.pierCols = D.pierCols || []; D.pierCols.push({ x: p[0], z: p[1], r, y0: g - 0.5, y1: y });
      // a column is solid for anyone below the deck (game collider format)
      D.colliders.push({ kind: 'pillar', height: y - g, y0: g - 0.5, y1: y - 1.2, points: ring.map((q) => [q[0], q[1]]) });
    }
  }
  D.piers = piers;
  // lamp posts on the sidewalks, alternating sides
  let k = 0;
  for (let a = s0 + 10; a < s1 - 6; a += 24, k++) {
    for (const edge of k % 2 ? ['south'] : ['north']) {
      if (inGap(a - 2, a + 2, edge)) continue;
      const t = edge === 'north' ? tN + pw + 0.8 : tS - pw - 0.8;
      const dirIn = edge === 'north' ? 1 : -1;
      const p = W(a, t), y = Y(a) + KERB;
      s.box(p[0], y + 5, p[1], 0.18, 5, 0.18, band.ux, band.uz, COL.steelDark);
      const armEnd = W(a, t + dirIn * 4.2);
      s.box((p[0] + armEnd[0]) / 2, y + 9.9, (p[1] + armEnd[1]) / 2, 2.1, 0.1, 0.12, band.nx * dirIn, band.nz * dirIn, COL.steelDark);
      S.glow.box(armEnd[0], y + 9.75, armEnd[1], 0.6, 0.12, 0.3, band.nx, band.nz, COL.lamp);
    }
  }
  // bus shelters on both sidewalks (OSM: two stops on the bridge), clear of the stair openings
  for (const edge of ['north', 'south']) {
    let sc = -6; while (gaps.some((g) => g.edge === edge && Math.abs(g.s - sc) < g.hw + 8)) sc += 4;
    const t = edge === 'north' ? tN + pw + 1.6 : tS - pw - 1.6, dirIn = edge === 'north' ? 1 : -1;
    const y = Y(sc) + KERB;
    const back = W(sc, t), roofC = W(sc, t + dirIn * 1.2);
    S.glass.box(back[0], y + 1.6, back[1], 4.5, 1.5, 0.08, band.ux, band.uz, COL.glass);
    s.box(roofC[0], y + 3.25, roofC[1], 4.8, 0.12, 1.6, band.ux, band.uz, COL.canopy, COL.canopy);
    for (const e of [-4.4, 4.4]) { const q = W(sc + e, t); s.box(q[0], y + 1.6, q[1], 0.1, 1.6, 0.1, 1, 0, COL.steelDark); }
    const bench = W(sc, t + dirIn * 0.7); s.box(bench[0], y + 0.6, bench[1], 2.5, 0.08, 0.4, band.ux, band.uz, COL.steel);
  }
  stats.piers = lines.filter((L) => L.length >= 2).length;
}

// ---------- station ----------
function buildStation(D, S) {
  const { band } = D, sec = band.sec, s = S.struct;
  const railY = (x, z) => D.ground.at(x, z);
  for (const pl of D.station.plats) {
    const g = Math.min(...pl.ring.map((p) => railY(...p)));
    s.prism(pl.ring, g - 0.3, pl.top, COL.platformSide, COL.platform);
    // yellow safety line along the long edges
    const [a, b] = pl.axis; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    for (let i = 0; i < pl.ring.length; i++) {
      const p = pl.ring[i], q = pl.ring[(i + 1) % pl.ring.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l < 30) continue;
      const ex = (q[0] - p[0]) / l, ez = (q[1] - p[1]) / l;
      const cx = pl.ring.reduce((t, r) => t + r[0], 0) / pl.ring.length, cz = pl.ring.reduce((t, r) => t + r[1], 0) / pl.ring.length;
      let nx = -ez, nz = ex; if ((cx - p[0]) * nx + (cz - p[1]) * nz < 0) { nx = -nx; nz = -nz; }
      const o = 0.9, wdt = 0.35;
      S.mark.quad([p[0] + nx * o, pl.top + 0.03, p[1] + nz * o], [q[0] + nx * o, pl.top + 0.03, q[1] + nz * o], [q[0] + nx * (o + wdt), pl.top + 0.03, q[1] + nz * (o + wdt)], [p[0] + nx * (o + wdt), pl.top + 0.03, p[1] + nz * (o + wdt)], COL.tactile, [0, 1, 0]);
    }
    // canopies along the platform outside the deck and the hall
    const along = (t) => [a[0] + ux * t, a[1] + uz * t];
    const cRow = [];
    for (let t = 6; t < L - 6; t += 8) {
      const p = along(t);
      const ts = band.T(...p);
      if (ts > sec.north - 3 && ts < sec.south + 3) continue; // under the deck
      cRow.push({ t, p });
    }
    for (const c of cRow) {
      const y = pl.top;
      if (Math.round(c.t / 8) % 2 === 0) s.box(c.p[0], y + 3.6, c.p[1], 0.14, 3.6, 0.14, ux, uz, COL.steelDark);
      S.hall.box(c.p[0], y + 7.3, c.p[1], 4.1, 0.14, 3.0, ux, uz, COL.canopy, COL.canopy);
      S.hall.box(c.p[0], y + 7.05, c.p[1], 4.1, 0.12, 3.05, ux, uz, COL.canopyEdge);
    }
  }
  // the station's roofs hide as one when the player is down at platform level (index.js)
  {
    const pts = [...D.station.plats.flatMap((p) => p.ring), ...D.station.stairs.flatMap((st) => [st.a, st.b])];
    const ss = pts.map((p) => band.S(...p)), ts = pts.map((p) => band.T(...p));
    D.stationZone = { s0: Math.min(...ss) - 6, s1: Math.max(...ss) + 6, t0: Math.min(...ts) - 6, t1: Math.max(...ts) + 6, top: Math.max(...D.station.plats.map((p) => p.top)) };
  }
  // stair flights with glass sides and a roof over the upper half
  for (const st of D.station.stairs) {
    const [dx, dz] = st.dir, nx = -dz, nz = dx;
    const L = Math.hypot(st.b[0] - st.a[0], st.b[1] - st.a[1]);
    const n = Math.max(4, Math.round((st.y0 - st.y1) / 0.32));
    for (let i = 0; i < n; i++) {
      const f0 = i / n, f1 = (i + 1) / n;
      const y = st.y0 + (st.y1 - st.y0) * f1;
      const c = [st.a[0] + dx * L * (f0 + f1) / 2, st.a[1] + dz * L * (f0 + f1) / 2];
      s.box(c[0], y - 0.6, c[1], (L / n) / 2, 0.6, st.w / 2, dx, dz, COL.stairRiser, COL.stairTread);
    }
    for (const side of [1, -1]) {
      const o = (st.w / 2 + 0.15) * side;
      const pa = [st.a[0] + nx * o, st.a[1] + nz * o], pb = [st.b[0] + nx * o, st.b[1] + nz * o];
      S.glass.wall(pa, pb, st.y0 - 0.2, st.y0 + 2.6, st.y1 - 0.2, st.y1 + 2.6, COL.glass, [nx * side, nz * side]);
      railLine(s, pa, pb, st.y0 + 1.0, st.y1 + 1.0, 0.06, COL.handrail);
      // stringer
      s.wall(pa, pb, st.y0 - 1.2, st.y0 + 0.1, st.y1 - 1.2, st.y1 + 0.1, COL.concreteDark, [nx * side, nz * side]);
    }
    const mid = [st.a[0] + dx * L * 0.3, st.a[1] + dz * L * 0.3];
    S.hall.box(mid[0], st.y0 + 3.1, mid[1], L * 0.32, 0.15, st.w / 2 + 0.6, dx, dz, COL.canopy, COL.canopy);
  }
  // the hall north of the bridge: a barrel vault over both platforms and the tracks between them
  const plats = D.station.plats;
  if (plats.length) {
    const tN = sec.north;
    const pts = plats.flatMap((p) => p.ring);
    const ts = pts.map((p) => band.T(...p)), ss = pts.map((p) => band.S(...p));
    const tFar = Math.max(tN - 95, Math.min(...ts) + 10);
    const sW = Math.min(...ss.filter((_, i) => ts[i] < tN)) - 2, sE = Math.max(...ss.filter((_, i) => ts[i] < tN)) + 2;
    const tA = tN - 6, tB = tFar;
    const yBase = Math.min(...plats.map((p) => p.top)) + 9.5;
    const crown = 9;
    const span = sE - sW, R = (span * span / 4 + crown * crown) / (2 * crown);
    const arcY = (s) => { const x = s - (sW + sE) / 2; return yBase + Math.sqrt(Math.max(0, R * R - x * x)) - (R - crown); };
    const nSeg = 16, h = S.hall;
    // the game hides this roof while the camera is in it or above a player under it (index.js)
    D.hall = { sW, sE, tA, tB, yBase, crown };
    for (let i = 0; i < nSeg; i++) {
      const a = sW + (span * i) / nSeg, b = sW + (span * (i + 1)) / nSeg;
      const A0 = band.W(a, tA), B0 = band.W(b, tA), A1 = band.W(a, tB), B1 = band.W(b, tB);
      h.quad([A0[0], arcY(a), A0[1]], [B0[0], arcY(b), B0[1]], [B1[0], arcY(b), B1[1]], [A1[0], arcY(a), A1[1]], COL.hallRoof, [0, 1, 0]);
      h.quad([A0[0], arcY(a) - 0.3, A0[1]], [B0[0], arcY(b) - 0.3, B0[1]], [B1[0], arcY(b) - 0.3, B1[1]], [A1[0], arcY(a) - 0.3, A1[1]], COL.hallRib, [0, -1, 0]);
    }
    for (let t = tA; t >= tB; t -= 12) for (const sc of [sW + 1, sE - 1]) {
      const p = band.W(sc, t), g = D.ground.at(...p);
      if (D.onRoadOrRail && D.onRoadOrRail(p[0], p[1], 0.5)) continue;
      s.box(p[0], (g + arcY(sc)) / 2, p[1], 0.3, (arcY(sc) - g) / 2, 0.3, band.ux, band.uz, COL.steelDark);
    }
    // ribs
    for (let t = tA; t >= tB; t -= 6) for (let i = 0; i < nSeg; i++) {
      const a = sW + (span * i) / nSeg, b = sW + (span * (i + 1)) / nSeg;
      const A = band.W(a, t), B = band.W(b, t);
      h.quad([A[0], arcY(a) + 0.12, A[1]], [B[0], arcY(b) + 0.12, B[1]], [B[0] - band.nx * 0.3, arcY(b) + 0.12, B[1] - band.nz * 0.3], [A[0] - band.nx * 0.3, arcY(a) + 0.12, A[1] - band.nz * 0.3], COL.hallRib, [0, 1, 0]);
    }
  }
}

// ---------- signals, crossings ----------
function buildFurniture(D, S, signals = true) {
  const s = S.struct;
  for (const sg of signals ? D.furniture.signals : []) {
    const [dx, dz] = sg.dir, rx = -dz, rz = dx; // right of travel
    const w = D.ways[sg.way];
    const base = [sg.x + rx * (sg.hw + 1.4), sg.z + rz * (sg.hw + 1.4)];
    const y = D.heightAt(base[0], base[1], sg.y + 3);
    s.box(base[0], y + 3.3, base[1], 0.16, 3.3, 0.16, dx, dz, COL.pole);
    const heads = [[0, 0]];
    if (w.lanes >= 3) {
      // mast arm over the lanes with one head per two lanes
      const reach = Math.min(sg.hw * 1.6, w.lanes * LANE * 0.8);
      const end = [base[0] - rx * reach, base[1] - rz * reach];
      s.box((base[0] + end[0]) / 2, y + 6.6, (base[1] + end[1]) / 2, reach / 2, 0.12, 0.12, -rx, -rz, COL.pole);
      for (let k = 1; k <= Math.ceil(w.lanes / 2); k++) heads.push([reach * k / Math.ceil(w.lanes / 2) - 0.6, 3.0]);
    }
    for (const [o, up] of heads) {
      const hx = base[0] - rx * o - dx * 0.4, hz = base[1] - rz * o - dz * 0.4, hy = y + 4.4 + up - (up ? 0.6 : 0);
      s.box(hx, hy, hz, 0.45, 1.25, 0.3, dx, dz, COL.head);
      const lights = [[COL.red, 0.8], [COL.amber, 0], [COL.green, -0.8]];
      for (const [c, oy] of lights) S.glow.box(hx - dx * 0.32, hy + oy, hz - dz * 0.32, 0.28, 0.28, 0.05, dx, dz, c);
    }
  }
  for (const c of D.furniture.crossings) {
    const [dx, dz] = c.dir, rx = -dz, rz = dx;
    const half = c.hw, width = 5.0;
    const y = D.ground.gy(c.x, c.z, c.y) + 0.085;
    for (let o = -half + 0.5; o < half - 0.4; o += 1.3) {
      const a = [c.x + rx * o, c.z + rz * o];
      S.mark.quad([a[0] - dx * width / 2, y, a[1] - dz * width / 2], [a[0] + dx * width / 2, y, a[1] + dz * width / 2], [a[0] + dx * width / 2 + rx * 0.65, y, a[1] + dz * width / 2 + rz * 0.65], [a[0] - dx * width / 2 + rx * 0.65, y, a[1] - dz * width / 2 + rz * 0.65], COL.line, [0, 1, 0]);
    }
    if (signals && c.signals) for (const side of [1, -1]) {
      const p = [c.x + rx * side * (half + 1.6), c.z + rz * side * (half + 1.6)];
      const y0 = D.heightAt(p[0], p[1], c.y + 3);
      s.box(p[0], y0 + 1.6, p[1], 0.1, 1.6, 0.1, dx, dz, COL.pole);
      s.box(p[0], y0 + 3.5, p[1], 0.3, 0.6, 0.22, rx, rz, COL.head);
      S.glow.box(p[0] + rx * side * -0.24, y0 + 3.75, p[1] + rz * side * -0.24, 0.18, 0.18, 0.04, rx, rz, COL.red);
      S.glow.box(p[0] + rx * side * -0.24, y0 + 3.25, p[1] + rz * side * -0.24, 0.18, 0.18, 0.04, rx, rz, COL.green);
    }
  }
}

// The Ayalon carriageways: a New Jersey barrier with a mesh fence on the side facing the rails
// (the left of the driver), and a cantilever sign gantry on each carriageway north and south of
// the bridge. Colliders go straight into D.colliders (game format).
function buildMotorwayKit(D, S) {
  const s = S.struct, { band } = D;
  const quad = (a, b, th0, th1, out, y0, y1, kind) => {
    D.colliders.push({ kind, height: y1 - y0, y0, y1, points: [[a[0] - out[0] * th0, a[1] - out[1] * th0], [b[0] - out[0] * th0, b[1] - out[1] * th0], [b[0] + out[0] * th1, b[1] + out[1] * th1], [a[0] + out[0] * th1, a[1] + out[1] * th1]] });
  };
  for (const w of D.ways) {
    if (w.kind !== 'road' || w.hw !== 'motorway') continue;
    const N = normals(w.pts);
    const off = -(w.width / 2 + 0.7); // left edge (n points right of travel)
    for (let i = 0; i + 1 < w.pts.length; i++) {
      const a = [w.pts[i][0] + N[i][0] * off, w.pts[i][1] + N[i][1] * off], b = [w.pts[i + 1][0] + N[i + 1][0] * off, w.pts[i + 1][1] + N[i + 1][1] * off];
      const ya = w.ys[i], yb = w.ys[i + 1];
      const out = [-N[i][0], -N[i][1]];
      const h = BARRIER_H, hb = 0.55;
      const pa = (o, y) => [a[0] + out[0] * o, y, a[1] + out[1] * o], pb = (o, y) => [b[0] + out[0] * o, y, b[1] + out[1] * o];
      s.quad(pa(-hb, ya), pb(-hb, yb), pb(-0.15, yb + h), pa(-0.15, ya + h), COL.barrier, [-out[0], 0.4, -out[1]]);
      s.quad(pa(hb, ya), pb(hb, yb), pb(0.15, yb + h), pa(0.15, ya + h), COL.barrier, [out[0], 0.4, out[1]]);
      s.quad(pa(-0.15, ya + h), pb(-0.15, yb + h), pb(0.15, yb + h), pa(0.15, ya + h), COL.parapetTop, [0, 1, 0]);
      // mesh fence on top (posts + two wires), not under the deck
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!band.inBand(mid[0], mid[1])) {
        if (i % 1 === 0) s.box(a[0], ya + h + 1.0, a[1], 0.06, 1.0, 0.06, 1, 0, COL.steelDark);
        railLine(s, a, b, ya + h + 1.9, yb + h + 1.9, 0.05, COL.steelDark);
        S.glass.wall(a, b, ya + h, ya + h + 1.9, yb + h, yb + h + 1.9, COL.steel, out);
      }
      quad(a, b, 0.6, 0.6, out, Math.min(ya, yb) - 0.6, Math.max(ya, yb) + h + 1.9, 'wall');
    }
    // gantries: cantilevered from the right shoulder, 120 u from the deck on each side
    const L = [0]; for (let i = 1; i < w.pts.length; i++) L.push(L[i - 1] + Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]));
    for (let i = 1; i < w.pts.length - 1; i++) {
      const sb = band.S(...w.pts[i]), tb = band.T(...w.pts[i]);
      if (Math.abs(sb) > 120) continue;
      const dist = Math.min(Math.abs(tb - band.sec.north), Math.abs(tb - band.sec.south));
      if (Math.abs(dist - 120) > 4.5 || (tb > band.sec.north && tb < band.sec.south)) continue;
      if (w.gantryDone && Math.abs(L[i] - w.gantryDone) < 60) continue;
      w.gantryDone = L[i];
      const p = w.pts[i], y = w.ys[i], n = N[i];
      const base = [p[0] + n[0] * (w.width / 2 + 2.2), p[1] + n[1] * (w.width / 2 + 2.2)];
      // the post stands on the shoulder; where a slip road runs alongside there is no room for it
      if (D.onCarriage && D.onCarriage(base[0], base[1], 1.6)) continue;
      const dx = w.pts[i + 1][0] - w.pts[i - 1][0], dz = w.pts[i + 1][1] - w.pts[i - 1][1], dl = Math.hypot(dx, dz);
      const fx = dx / dl, fz = dz / dl;
      s.box(base[0], y + 5.6, base[1], 0.45, 5.6, 0.45, fx, fz, COL.mast);
      const reach = w.width * 0.85;
      const end = [base[0] - n[0] * reach, base[1] - n[1] * reach];
      for (const dy of [9.6, 11.0]) s.box((base[0] + end[0]) / 2, y + dy, (base[1] + end[1]) / 2, reach / 2, 0.16, 0.16, -n[0], -n[1], COL.mast);
      for (const k of [0.35, 0.72]) {
        const c = [base[0] - n[0] * reach * k, base[1] - n[1] * reach * k];
        s.box(c[0] - fx * 0.4, y + 10.3, c[1] - fz * 0.4, 3.4, 1.6, 0.12, -n[0], -n[1], COL.signGreen);
        s.box(c[0] - fx * 0.47, y + 10.3, c[1] - fz * 0.47, 3.0, 1.25, 0.06, -n[0], -n[1], COL.line);
        s.box(c[0] - fx * 0.5, y + 10.3, c[1] - fz * 0.5, 2.85, 1.1, 0.06, -n[0], -n[1], COL.signGreen);
      }
      D.colliders.push({ kind: 'pillar', height: 11, y0: y - 0.5, y1: y + 11.2, points: [[base[0] - 0.5, base[1] - 0.5], [base[0] + 0.5, base[1] - 0.5], [base[0] + 0.5, base[1] + 0.5], [base[0] - 0.5, base[1] + 0.5]] });
    }
  }
}
