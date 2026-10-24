// Sderot Moshe Dayan bridge over Ayalon and the railway trench, hand designed.
//
// The street network draws every bridge deck procedurally (a slab under each OSM carriageway),
// which at this crossing gave two staggered plates with no structure under them. This module
// replaces that drawing for the two decks of the crossing only: one wide girder bridge with
// sidewalks, concrete barrier plus railing, lamp posts, expansion joints, cross ribs under the
// deck and a pier row wherever the ground below is free (here only at the east end: Ayalon, the
// rails and the station take the rest of the span).
//
// What stays with city.js: the asphalt, the lane marks, the walkable surface (heightAt) and the
// road data the traffic paths follow. This module only draws and collides. It never changes a
// height a walker or a car can stand on.
//
// Standalone use: tools/preview-bridge.html feeds it the same inputs from a snapshot of the game.
//
// Frame. u runs along the bridge (west to east), n across it (towards the south, like the
// normals the street network builds for a way that runs along u), y up. s and t are the
// coordinates along u and n from the centre of the two decks.
import * as THREE from 'three';

// The two OSM ways (start and end vertices, +-3 u). Matched by end points, not by id, because the
// bake renumbers ways.
const DECK_ENDS = [
  [[-2078.2, -1642.1], [-1948.7, -1610.7]], // B23, eastbound, 6 lanes, south half
  [[-1945.5, -1632.5], [-2073.3, -1663.1]], // B24, westbound, 4 lanes, north half
];
const MATCH = 3;

export const DESIGN = {
  slab: 0.8,          // deck slab thickness under the asphalt
  girder: 1.25,       // girder web depth below the slab at mid span
  haunch: 0.85,       // extra girder depth over a pier row
  haunchReach: 15,    // along-bridge distance over which the haunch fades out
  girders: 9,         // girder lines across the deck
  girderW: 1.1,
  rib: 14,            // cross ribs (diaphragms) about this far apart
  edgeBeam: 1.15,     // edge fascia reaches this far below the slab top
  barrier: 1.1,       // solid concrete part of the parapet
  rail: 1.15,         // railing above the barrier (total parapet 2.25 u, like the collider)
  postEvery: 3.6,
  parapetCollider: 2.2,
  kerb: 0.25,         // sidewalk above the asphalt (city.js DECK_KERB)
  pierRows: [62],     // wanted s of the pier rows; each is nudged to the nearest free ground (the rest of the span has Ayalon, the rails and the station below)
  pierColumn: 1.4,    // column radius
  pierCap: 1.5,       // cap beam depth
  pierCapW: 3.4,      // cap beam width along the bridge
  lampEvery: 24,
  lampH: 9.5,
  lampArm: 3.6,
};

const hex = (h) => new THREE.Color(h);
const COL = {
  asphalt: hex(0x3d3b42), concrete: hex(0xd6d0c4), concreteDark: hex(0xbdb7ab), underside: hex(0x9b968d),
  rib: hex(0x8f8a82), parapetTop: hex(0xefebe3), sidewalk: hex(0xd4d5d3), kerb: hex(0xb3b0a9),
  pier: hex(0xc9c3b6), steel: hex(0xc7ccd1), steelDark: hex(0x7d848c), joint: hex(0x5f5c58),
  lampHead: hex(0xfff1bf), drip: hex(0xa39e94),
};

const cl = (v, a, b) => (v < a ? a : v > b ? b : v);
// Piecewise linear function through (xs[i], ys[i]), clamped at the ends. xs ascending.
function lin(xs, ys) {
  return (x) => {
    if (x <= xs[0]) return ys[0];
    const n = xs.length;
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const f = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + (ys[hi] - ys[lo]) * f;
  };
}

export function createMosheDayanBridge() {
  const decks = [];
  return {
    // Is this way one of the two decks (by its end points)?
    claims(w) {
      if (!w || !w.pts || w.pts.length < 2 || !w.ys) return false;
      const a = w.pts[0], b = w.pts[w.pts.length - 1];
      const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < MATCH;
      return DECK_ENDS.some(([s, e]) => near(a, s) && near(b, e));
    },
    // w: { pts, ya (deck height per vertex without the asphalt), hw2, deckWalk: [west/-1 side, +1 side], cls: { color } }
    add(w, lift) { if (!decks.some((d) => d.w === w)) decks.push({ w, lift }); },
    get complete() { return decks.length === DECK_ENDS.length; },
    emit,
    decks,
  };

  // env: { at(x, z) -> accumulator with quad(a, b, c, d, color, up); groundAt(x, z); blocked(x, z, margin) -> bool
  //        (a road, rail, path or platform below); gaps: [{ x, z, r }] stair tops on the deck edge; stairW;
  //        colliders: [] to push into; log?: fn }
  function emit(env) {
    const D = DESIGN;
    const { at, groundAt, blocked = () => false, gaps = [], stairW = 3.7, colliders = [] } = env;
    if (decks.length < 2) return null;

    // ---- frame ----
    const dirOf = (w) => { const p = w.pts, q = p[p.length - 1], dx = q[0] - p[0][0], dz = q[1] - p[0][1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    const d0 = dirOf(decks[0].w), d1 = dirOf(decks[1].w);
    const flip = d0[0] * d1[0] + d0[1] * d1[1] < 0 ? -1 : 1;
    let ux = d0[0] + flip * d1[0], uz = d0[1] + flip * d1[1];
    const ul = Math.hypot(ux, uz); ux /= ul; uz /= ul;
    const nx = -uz, nz = ux;
    let ox = 0, oz = 0, cnt = 0;
    for (const { w } of decks) for (const p of w.pts) { ox += p[0]; oz += p[1]; cnt++; }
    ox /= cnt; oz /= cnt;
    const W = (s, t, y) => [ox + ux * s + nx * t, y, oz + uz * s + nz * t];
    const SP = (x, z) => (x - ox) * ux + (z - oz) * uz;
    const TP = (x, z) => (x - ox) * nx + (z - oz) * nz;
    const gnd = (s, t) => { const p = W(s, t, 0); return groundAt(p[0], p[2]); };
    const isBlocked = (s, t, m) => { const p = W(s, t, 0); return blocked(p[0], p[2], m); };
    const upDir = (ds, dt, dy) => [ux * ds + nx * dt, dy, uz * ds + nz * dt];
    const UPV = [0, 1, 0], DNV = [0, -1, 0];

    // ---- the two decks in the frame ----
    const info = decks.map(({ w, lift }) => {
      const dir = dirOf(w);
      const sign = dir[0] * ux + dir[1] * uz > 0 ? 1 : -1; // this way's +1 side lies towards +t when sign is 1
      const ss = w.pts.map((p) => SP(p[0], p[1])), ts = w.pts.map((p) => TP(p[0], p[1]));
      const tc = ts.reduce((a, b) => a + b, 0) / ts.length;
      const order = ss.map((_, i) => i).sort((a, b) => ss[a] - ss[b]);
      const xs = order.map((i) => ss[i]), ys = order.map((i) => w.ya[i]);
      return { w, lift, sign, tc, hw: w.hw2, walk: w.deckWalk || [0, 0], s0: xs[0], s1: xs[xs.length - 1], xs, ya: lin(xs, ys) };
    });
    const sMin = Math.min(...info.map((d) => d.s0)), sMax = Math.max(...info.map((d) => d.s1));
    const s0 = sMin - 0.2, s1 = sMax + 0.2;
    const asphaltTop = (s) => Math.min(...info.map((d) => d.ya(s) + d.lift));
    const yTop = (s) => asphaltTop(s) - 0.1; // concrete top, a hair under the asphalt the ways draw
    // Outer edges: only the sides that carry a sidewalk; the sides facing the twin deck end in it.
    const edges = [];
    let tN = 1e9, tS = -1e9, aN = 1e9, aS = -1e9;
    for (const d of info) {
      for (const [m, side] of [[0, -1], [1, 1]]) {
        const out = d.sign * side;                    // +1: this side lies towards +t
        const asph = d.tc + out * d.hw;
        aN = Math.min(aN, asph); aS = Math.max(aS, asph);
        const off = d.hw + 0.5 + d.walk[m];
        const te = d.tc + out * off;
        tN = Math.min(tN, te); tS = Math.max(tS, te);
        if (d.walk[m] > 0) edges.push({ d, out, tIn: d.tc + out * (d.hw + 0.3), tOut: te });
      }
    }
    const edgeTop = (e, s) => e.d.ya(s) + e.d.lift + D.kerb; // sidewalk surface

    // ---- stations along the bridge (the vertices of the road profile) ----
    const st = [s0, s1];
    for (const d of info) for (const x of d.xs) if (x > s0 + 0.4 && x < s1 - 0.4) st.push(x);
    st.sort((a, b) => a - b);
    const stations = st.filter((x, i) => i === 0 || x - st[i - 1] > 0.6);
    // Evaluation grids: a function sampled at `step`, always including the stations.
    const grid = (a, b, step) => {
      const out = new Set([a, b]);
      for (const x of stations) if (x > a && x < b) out.add(x);
      for (let x = Math.ceil(a / step) * step; x < b; x += step) out.add(+x.toFixed(4));
      const arr = [...out].sort((p, q) => p - q);
      return arr.filter((x, i) => i === 0 || x - arr[i - 1] > 0.05);
    };

    // ---- geometry writers (local s, t, y -> world) ----
    const quad = (a, b, c, d, color, up) => {
      const A = W(...a), B = W(...b), C = W(...c), E = W(...d);
      at((A[0] + C[0]) / 2, (A[2] + C[2]) / 2).quad(A, B, C, E, color, up);
    };
    // Prism along s over `ss`, between t0 and t1, bottom/top heights as functions of s.
    const prism = (ss, t0, t1, yb, yt, topC, sideC, opt = {}) => {
      if (t0 > t1) [t0, t1] = [t1, t0];
      for (let i = 0; i < ss.length - 1; i++) {
        const a = ss[i], b = ss[i + 1];
        const yb0 = yb(a), yb1 = yb(b), yt0 = yt(a), yt1 = yt(b);
        if (topC) quad([a, t0, yt0], [b, t0, yt1], [b, t1, yt1], [a, t1, yt0], topC, UPV);
        if (sideC) {
          if (opt.sideLo !== false) quad([a, t0, yb0], [b, t0, yb1], [b, t0, yt1], [a, t0, yt0], sideC, upDir(0, -1, 0));
          if (opt.sideHi !== false) quad([a, t1, yb0], [b, t1, yb1], [b, t1, yt1], [a, t1, yt0], sideC, upDir(0, 1, 0));
        }
        if (opt.under) quad([a, t0, yb0], [b, t0, yb1], [b, t1, yb1], [a, t1, yb0], opt.under, DNV);
      }
      if (sideC && opt.ends !== false) {
        const a = ss[0], b = ss[ss.length - 1];
        quad([a, t0, yb(a)], [a, t1, yb(a)], [a, t1, yt(a)], [a, t0, yt(a)], sideC, upDir(-1, 0, 0));
        quad([b, t0, yb(b)], [b, t1, yb(b)], [b, t1, yt(b)], [b, t0, yt(b)], sideC, upDir(1, 0, 0));
      }
    };
    // Axis-aligned block (constant heights) with a top colour, side colour and optional bottom.
    const block = (a, b, t0, t1, y0, y1, topC, sideC, bottomC = null) => {
      prism([a, b], t0, t1, () => y0, () => y1, topC, sideC, { under: bottomC });
    };
    // Eight-sided column.
    const column = (s, t, r, y0, y1, color) => {
      const pts = [];
      for (let k = 0; k < 8; k++) { const a = (k + 0.5) * Math.PI / 4; pts.push([s + Math.cos(a) * r, t + Math.sin(a) * r]); }
      for (let k = 0; k < 8; k++) {
        const p = pts[k], q = pts[(k + 1) % 8];
        quad([p[0], p[1], y0], [q[0], q[1], y0], [q[0], q[1], y1], [p[0], p[1], y1], color, upDir((p[0] + q[0]) / 2 - s, (p[1] + q[1]) / 2 - t, 0));
      }
    };

    // ---- pier rows: nudge each wanted row to ground that is free below ----
    const colsAt = () => {
      const n = 7, a = tN + 4.5, b = tS - 4.5;
      return Array.from({ length: n }, (_, k) => a + (b - a) * k / (n - 1));
    };
    const cols = colsAt();
    const freeColumn = (s, t) => ![[0, 0], [D.pierColumn + 1.2, 0], [-D.pierColumn - 1.2, 0], [0, D.pierColumn + 1.2], [0, -D.pierColumn - 1.2]].some(([ds, dt]) => isBlocked(s + ds, t + dt, 0.8));
    const rows = [];
    for (const want of D.pierRows) {
      let best = null;
      for (const off of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 8, -8, 10, -10]) {
        const s = want + off;
        if (s < s0 + 12 || s > s1 - 4) continue;
        const free = cols.filter((t) => freeColumn(s, t));
        if (free.length >= 4 && (!best || free.length > best.free.length)) { best = { s, free }; if (free.length === cols.length) break; }
      }
      if (best) rows.push(best);
    }
    const haunch = (s) => {
      let h = 0;
      for (const r of rows) h = Math.max(h, 0.5 + 0.5 * Math.cos(Math.PI * cl(Math.abs(s - r.s) / D.haunchReach, 0, 1)));
      return h;
    };

    // ---- deck slab ----
    const gridFine = grid(s0, s1, 4);
    const slabBottom = (s) => yTop(s) - D.slab;
    prism(stations, tN, tS, slabBottom, yTop, COL.asphalt, COL.concrete, { under: COL.underside, ends: true });

    // ---- girders and cross ribs below the slab ----
    const gT = Array.from({ length: D.girders }, (_, k) => tN + 3.2 + (tS - tN - 6.4) * k / (D.girders - 1));
    const gDepth = (s) => D.girder + D.haunch * haunch(s);
    const gBottom = (s) => slabBottom(s) - gDepth(s);
    for (const t of gT) prism(gridFine, t - D.girderW / 2, t + D.girderW / 2, gBottom, slabBottom, null, COL.rib, { under: COL.underside, ends: true });
    const ribAt = [];
    const ribs = Math.max(2, Math.round((s1 - s0) / D.rib));
    for (let k = 0; k <= ribs; k++) ribAt.push(s0 + 1.2 + (s1 - s0 - 2.4) * k / ribs);
    for (const r of rows) ribAt.push(r.s - 1.4, r.s + 1.4);
    for (const s of ribAt) {
      for (let k = 0; k < gT.length - 1; k++) {
        const a = gT[k] + D.girderW / 2, b = gT[k + 1] - D.girderW / 2;
        block(s - 0.3, s + 0.3, a, b, gBottom(s) + 0.25, slabBottom(s), null, COL.rib, COL.underside);
      }
    }
    // End beams: a deep clean face at both ends of the bridge.
    for (const [a, b] of [[s0, s0 + 1.5], [s1 - 1.5, s1]]) {
      const yb = (s) => slabBottom(s) - D.girder - 0.5;
      prism([a, b], tN, tS, yb, yTop, null, COL.concrete, { under: COL.underside, ends: true });
    }

    // ---- sidewalks, edge beams, barrier, railing ----
    const colliderSeg = (e, a, b) => {
      const t0 = e.tOut - e.out * 0.55, t1 = e.tOut;
      const pts = [W(a, t0, 0), W(b, t0, 0), W(b, t1, 0), W(a, t1, 0)].map((p) => [p[0], p[2]]);
      const y = [edgeTop(e, a), edgeTop(e, b)];
      colliders.push({ kind: 'wall', height: D.parapetCollider, y0: Math.min(...y) - 0.6, y1: Math.max(...y) + D.parapetCollider, points: pts });
    };
    const openingW = stairW + 0.8;
    for (const e of edges) {
      const lo = Math.min(e.tIn, e.tOut + e.out * 0.6), hi = Math.max(e.tIn, e.tOut + e.out * 0.6);
      const top = (s) => edgeTop(e, s);
      // Sidewalk block and the edge beam under it.
      prism(stations, lo, hi, (s) => yTop(s) - D.edgeBeam, top, COL.sidewalk, COL.kerb, { under: COL.underside, ends: true });
      // Drip strip along the bottom of the fascia.
      const outT0 = e.tOut + e.out * 0.6, outT1 = outT0 + e.out * 0.14;
      prism(stations, outT0, outT1, (s) => yTop(s) - D.edgeBeam - 0.2, (s) => yTop(s) - D.edgeBeam + 0.12, COL.drip, COL.drip, { under: COL.underside, ends: true });
      // Openings for the station stairs: the barrier and railing stop there.
      const open = [];
      for (const g of gaps) {
        const sg = SP(g.x, g.z), tg = TP(g.x, g.z);
        if (Math.abs(tg - e.tOut) < 7 && sg > s0 && sg < s1) open.push([sg - openingW / 2, sg + openingW / 2]);
      }
      open.sort((p, q) => p[0] - q[0]);
      const runs = [];
      let cur = s0;
      for (const [a, b] of open) { if (a > cur) runs.push([cur, a]); cur = Math.max(cur, b); }
      if (cur < s1) runs.push([cur, s1]);
      const bt0 = e.tOut - 0.5, bt1 = e.tOut + 0.5;
      for (const [ra, rb] of runs) {
        if (rb - ra < 0.3) continue;
        const ss = grid(ra, rb, 100);
        const baseTop = (s) => top(s) + 0.4, mainTop = (s) => top(s) + D.barrier, capTop = (s) => top(s) + D.barrier + 0.1;
        prism(ss, bt0, bt1, top, baseTop, COL.concreteDark, COL.concrete, { ends: true });
        prism(ss, e.tOut - 0.28, e.tOut + 0.28, baseTop, mainTop, null, COL.concrete, { ends: true });
        prism(ss, e.tOut - 0.36, e.tOut + 0.36, mainTop, capTop, COL.parapetTop, COL.parapetTop, { ends: true });
        // Railing: posts and two rails.
        const n = Math.max(1, Math.round((rb - ra) / D.postEvery));
        for (let k = 0; k <= n; k++) {
          const s = ra + (rb - ra) * k / n;
          block(s - 0.12, s + 0.12, e.tOut - 0.12, e.tOut + 0.12, capTop(s), capTop(s) + D.rail, COL.steel, COL.steel);
        }
        for (const [o0, o1] of [[0.38, 0.5], [D.rail - 0.1, D.rail + 0.04]]) {
          prism(ss, e.tOut - 0.07, e.tOut + 0.07, (s) => capTop(s) + o0, (s) => capTop(s) + o1, COL.steel, COL.steelDark, { ends: true });
        }
        // Solid for walkers: one collider per piece of at most 12 u.
        const pieces = Math.max(1, Math.ceil((rb - ra) / 12));
        for (let k = 0; k < pieces; k++) colliderSeg(e, ra + (rb - ra) * k / pieces, ra + (rb - ra) * (k + 1) / pieces);
      }
      e.runs = runs;
    }

    // ---- piers ----
    const piers = [];
    for (const r of rows) {
      const cap1 = gBottom(r.s), cap0 = cap1 - D.pierCap;
      for (const t of r.free) {
        const y0 = gnd(r.s, t) - 0.4;
        if (cap0 - y0 < 1) continue;
        column(r.s, t, D.pierColumn, y0, cap0 + 0.05, COL.pier);
        const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => W(r.s + a * D.pierColumn, t + b * D.pierColumn, 0)).map((p) => [p[0], p[2]]);
        colliders.push({ kind: 'pillar', height: cap0 - y0, y0, y1: cap0, points: pts });
        piers.push([r.s, t]);
      }
      if (r.free.length >= 2) {
        const a = Math.min(...r.free) - 2.2, b = Math.max(...r.free) + 2.2;
        block(r.s - D.pierCapW / 2, r.s + D.pierCapW / 2, Math.max(a, tN + 0.6), Math.min(b, tS - 0.6), cap0, cap1, COL.pier, COL.pier, COL.underside);
      }
    }

    // ---- lamps along both outer edges, staggered ----
    const lamps = [];
    const inOpen = (e, s) => (e.runs || []).every(([a, b]) => s < a + 1 || s > b - 1);
    edges.forEach((e, ei) => {
      const first = s0 + 10 + (ei % 2) * D.lampEvery / 2;
      for (let s = first; s < s1 - 6; s += D.lampEvery) {
        if (inOpen(e, s)) continue;
        const t = e.tOut - e.out * 1.7, y0 = edgeTop(e, s), y1 = y0 + D.lampH;
        column(s, t, 0.26, y0, y1, COL.steelDark);
        block(s - 0.5, s + 0.5, t - 0.5, t + 0.5, y0, y0 + 0.5, COL.steelDark, COL.steelDark);
        // Arm reaching over the roadway, with a flat head under its end.
        const inward = -e.out, tEnd = t + inward * D.lampArm;
        prism([s - 0.11, s + 0.11], Math.min(t, tEnd), Math.max(t, tEnd), () => y1 - 0.15, () => y1 + 0.06, COL.steelDark, COL.steelDark, { ends: true });
        block(s - 0.35, s + 0.35, tEnd - 0.7, tEnd + 0.7, y1 - 0.32, y1 - 0.12, COL.steelDark, COL.lampHead, COL.lampHead);
        lamps.push([s, t]);
      }
    });

    // ---- expansion joints across the asphalt and the sidewalks ----
    for (const s of [s0 + 1.1, s1 - 1.1, (rows[0] ? rows[0].s : (s0 + s1) / 2)]) {
      const yJ = asphaltTop(s) + 0.07;
      block(s - 0.3, s + 0.3, aN, aS, yJ - 0.03, yJ, COL.joint, COL.joint);
      for (const e of edges) {
        const lo = Math.min(e.tIn, e.tOut), hi = Math.max(e.tIn, e.tOut);
        block(s - 0.3, s + 0.3, lo, hi, edgeTop(e, s), edgeTop(e, s) + 0.05, COL.joint, COL.joint);
      }
    }

    // ---- abutment where the whole end stands on free ground and no pier row is near ----
    const abut = [];
    for (const end of [-1, 1]) {
      const sEnd = end < 0 ? s0 : s1, inward = -end;
      if (rows.some((r) => Math.abs(r.s - sEnd) < 16)) continue;
      const panels = Math.round((tS - tN) / 3.5);
      const free = [];
      for (let k = 0; k < panels; k++) {
        const tm = tN + (tS - tN) * (k + 0.5) / panels;
        free.push(!isBlocked(sEnd, tm, 0.5) && !isBlocked(sEnd + inward * 2.4, tm, 0.5));
      }
      if (free.filter(Boolean).length < panels * 0.8) continue;
      const sa = Math.min(sEnd, sEnd + inward * 2.4), sb = Math.max(sEnd, sEnd + inward * 2.4);
      const g = Math.min(...Array.from({ length: 9 }, (_, k) => gnd(sEnd, tN + (tS - tN) * k / 8)));
      const yb = g - 0.5, yt = yTop(sEnd) - D.slab - D.girder - 0.5;
      for (let k = 0; k < panels; k++) {
        if (!free[k]) continue;
        const ta = tN + (tS - tN) * k / panels, tb = tN + (tS - tN) * (k + 1) / panels;
        block(sa, sb, ta, tb, yb, yt, null, COL.concrete);
        const pts = [W(sa, ta, 0), W(sb, ta, 0), W(sb, tb, 0), W(sa, tb, 0)].map((p) => [p[0], p[2]]);
        colliders.push({ kind: 'wall', height: yt - yb, y0: yb, y1: yt, points: pts });
        abut.push([end, (ta + tb) / 2]);
      }
    }

    const out = { s0, s1, tN, tS, frame: { origin: [ox, oz], u: [ux, uz], n: [nx, nz] }, piers, rows: rows.map((r) => r.s), lamps: lamps.length, edges: edges.map((e) => ({ tOut: e.tOut, runs: e.runs })), abutments: abut.length };
    if (env.log) env.log(out);
    return out;
  }
}
