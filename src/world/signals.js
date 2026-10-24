// Traffic-signal controller (round 8, signals).
//
// One plan for the whole city, built once from the drivable graph (src/vehicles/network.js) and the
// OSM signal nodes (city.signals). dressing.js stands the poles and lamps from it, traffic.js stops
// cars at its stop lines, the crowd waits at its kerbs. Pure logic, no THREE, so a node script can
// build and check it exactly the way the game does.
//
// What is a signal site:
//   junction  a graph node with 3+ arms that carries an OSM highway=traffic_signals node within
//             reach, or crossing=traffic_signals nodes on two different arms. Never on a roundabout
//             ring or within RING_ENTRY of one, never on a mini roundabout, never on a deck.
//   mid       a crossing=traffic_signals / highway=traffic_signals node in the middle of an edge
//             that no junction claims: a pedestrian crossing with vehicle heads.
// Nothing else is lit.
//
// Phase plan of a junction: arms are grouped by axis (within GROUP_ANGLE). Each group with an
// approach gets one green stage; no two groups are ever green or amber together, and every green is
// followed by amber and an all-red clearance before the next group. Pedestrian crossings on the
// arms of a group walk while the vehicles of that group are held, flash for the last seconds, and
// are closed during amber and all-red. A site with a single vehicle group (a mid-block crossing, a
// junction whose other arms are exits) gets a pedestrian stage instead of a second group.
// Sites within CLUSTER_R of each other (dual carriageways, a crossing next to a junction) share one
// cycle length, one offset and one stage order, so a car released at one is released at the next.

export const AMBER = 3, ALL_RED = 2, FLASH = 4, PED_STAGE = 10, MID_GREEN = 18;
const REACH = 22; // an OSM node belongs to the nearest junction within arm half width + REACH
const RING_ENTRY = 40;
const GROUP_ANGLE = (32 * Math.PI) / 180;
const CLUSTER_R = 45;
const MIN_UPSTREAM = 14; // a stop line needs this much road behind it
const STOP_OFFSET = 4.3; // stop line beyond the zebra centre (zebra half length 2.5 + gap)
export const MID_STOP = 4.3; // stop line before the centre of a mid-block crossing

const hash = (a, b) => {
  let n = (Math.round(a * 4) * 73856093) ^ (Math.round(b * 4) * 19349663);
  n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) >>> 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d) >>> 0; n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
};
export const nodeKey = (x, z) => `${Math.round(x * 4)},${Math.round(z * 4)}`;
const axisOf = (ax, az) => { let a = Math.atan2(az, ax) % Math.PI; if (a < 0) a += Math.PI; return a; };
const axisDist = (a, b) => { let d = Math.abs(a - b) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d; };

function greenFor(rank) { return rank >= 8 ? 16 : rank >= 7 ? 14 : rank >= 6 ? 11 : 8; }

// Stage tables --------------------------------------------------------------------------------

// order: group indices (active first, by priority). Returns stages with state per group.
function makeStages(site, order) {
  const G = site.groups, n = G.length;
  const stages = [];
  const blank = () => new Array(n).fill('R');
  const walkOf = (except) => G.map((g, j) => (g.ped && g.active && !except.includes(j) ? 1 : 0));
  const active = order.filter((j) => G[j].active);
  if (active.length >= 2) {
    for (const j of active) {
      const st = blank(); st[j] = 'G';
      stages.push({ kind: 'green', group: j, dur: G[j].green, state: st, walk: walkOf([j]) });
      const am = blank(); am[j] = 'A';
      stages.push({ kind: 'amber', group: j, dur: AMBER, state: am, walk: new Array(n).fill(0) });
      stages.push({ kind: 'allred', group: j, dur: ALL_RED, state: blank(), walk: new Array(n).fill(0) });
    }
  } else {
    // One vehicle group: green, amber, then everyone on foot may cross.
    const j = active[0];
    const veh = [];
    const st = blank(); st[j] = 'G';
    veh.push({ kind: 'green', group: j, dur: site.kind === 'mid' ? MID_GREEN : G[j].green + 6, state: st, walk: new Array(n).fill(0) });
    const am = blank(); am[j] = 'A';
    veh.push({ kind: 'amber', group: j, dur: AMBER, state: am, walk: new Array(n).fill(0) });
    veh.push({ kind: 'allred', group: j, dur: 1, state: blank(), walk: new Array(n).fill(0) });
    const ped = [
      { kind: 'ped', group: j, dur: PED_STAGE, state: blank(), walk: G.map((g) => (g.ped ? 1 : 0)) },
      { kind: 'allred', group: j, dur: 1, state: blank(), walk: new Array(n).fill(0) },
    ];
    stages.push(...(site.pedFirst ? [...ped, ...veh] : [...veh, ...ped]));
  }
  let t = 0;
  for (const s of stages) { s.t0 = t; t += s.dur; s.t1 = t; }
  return { stages, cycle: t };
}

function finalize(site, principal, cycle, offset) {
  // Group order: nearest to the principal axis first.
  const idx = site.groups.map((g, i) => i).sort((a, b) => axisDist(site.groups[a].axis, principal) - axisDist(site.groups[b].axis, principal));
  const nActive = site.groups.filter((g) => g.active).length;
  if (nActive < 2) site.pedFirst = axisDist(site.groups[idx.find((i) => site.groups[i].active)].axis, principal) > Math.PI / 4;
  const { stages, cycle: nat } = makeStages(site, idx);
  const pad = Math.max(0, cycle - nat);
  if (pad > 0) { stages[0].dur += pad; let t = 0; for (const s of stages) { s.t0 = t; t += s.dur; s.t1 = t; } }
  site.stages = stages;
  site.cycle = Math.max(cycle, nat);
  site.offset = offset;
  site.cacheT = NaN;
}

function locate(site, T) {
  if (site.cacheT === T) return site.cacheStage;
  let m = (T + site.offset) % site.cycle;
  if (m < 0) m += site.cycle;
  let st = site.stages[site.stages.length - 1];
  for (const s of site.stages) if (m < s.t1) { st = s; break; }
  site.cacheT = T; site.cacheStage = st; site.cacheLocal = m - st.t0;
  return st;
}

/** 'G' | 'A' | 'R' for vehicles of group g at plan time T. */
export function aspect(site, g, T) { return locate(site, T).state[g]; }
/** 0 don't walk, 1 walk, 2 flashing (finish crossing, do not start) for the crossing on group g. */
export function walkState(site, g, T) {
  const st = locate(site, T);
  if (!site.groups[g].active) return 1;
  const w = st.walk[g];
  if (!w) return 0;
  return st.dur - site.cacheLocal <= Math.min(FLASH, st.dur / 2) ? 2 : 1;
}
/** Index of the stage running at T (for the lamps: redraw only when it changes). */
export function stageIndex(site, T) { return site.stages.indexOf(locate(site, T)); }
/** Seconds left in the current stage. */
export function stageLeft(site, T) { const st = locate(site, T); return st.dur - site.cacheLocal; }

// Plan ----------------------------------------------------------------------------------------

/**
 * @param city  city.js result (signals, rings, crossings)
 * @param net   buildNetwork(city) result (nodes, edges, nearest, pointAt, lanesFor)
 * @param opts  { ground(x, z) -> terrain height, for the deck check }
 */
export function buildSignalPlan(city, net, { ground = () => 0 } = {}) {
  const osm = Array.isArray(city && city.signals) ? city.signals : [];
  const rings = (city && city.rings) || [];
  const nearRing = (x, z) => rings.some((r) => Math.hypot(x - r.x, z - r.z) < r.r + RING_ENTRY);
  const stats = { osmSignals: 0, osmCrossings: 0, minis: 0, junctions: 0, junctionsFromCrossings: 0, mids: 0, midsDropped: 0, droppedRing: 0, droppedDeck: 0, droppedMini: 0, droppedNoApproach: 0, crossingsAbsorbed: 0, arms: 0, approaches: 0, noStopShort: 0, clusters: 0 };
  const sites = [];
  const byKey = new Map();
  const crossingMap = new Map(); // city.crossings entry or new crossing -> { site, group }
  const newCrossings = [];

  const PT = { x: 0, z: 0, dx: 0, dz: 1, i: -1, t: 0 };
  const heightOn = (e, s, x, z) => {
    if (!e.ya) return ground(x, z) + e.lift;
    net.pointAt(e, s, 0, PT);
    return net.heightAt(e, s, PT.x, PT.z, PT.i, PT.t);
  };
  const raisedAt = (e, s, x, z) => !!e.ya && heightOn(e, s, x, z) - ground(x, z) > 1.0;

  // ---- crossing index (zebras painted by city.js) ----
  const ZC = 32, zgrid = new Map();
  const zk = (i, j) => i * 100003 + j;
  for (const c of city.crossings || []) {
    const k = zk(Math.floor(c.x / ZC), Math.floor(c.z / ZC));
    let l = zgrid.get(k); if (!l) zgrid.set(k, (l = []));
    l.push(c);
  }
  const zebraOnArm = (nx, nz, ax, az, maxAlong) => {
    let best = null;
    for (let i = Math.floor((nx - 52) / ZC); i <= Math.floor((nx + 52) / ZC); i++) for (let j = Math.floor((nz - 52) / ZC); j <= Math.floor((nz + 52) / ZC); j++)
      for (const c of zgrid.get(zk(i, j)) || []) {
        const rx = c.x - nx, rz = c.z - nz;
        const along = rx * ax + rz * az, lat = Math.abs(rx * az - rz * ax);
        if (along < 1 || along > maxAlong || lat > 3.4) continue;
        const dx = Math.sin(c.angle), dz = Math.cos(c.angle);
        if (Math.abs(dx * ax + dz * az) < 0.8) continue;
        if (!best || along < best.along) best = { c, along };
      }
    return best;
  };

  // ---- graph nodes with 3+ arms, indexed ----
  const NC = 64, ngrid = new Map();
  const nk = (i, j) => i * 100003 + j;
  const jn = net.nodes.filter((n) => n.edges.length >= 3);
  for (const n of jn) {
    const k = nk(Math.floor(n.x / NC), Math.floor(n.z / NC));
    let l = ngrid.get(k); if (!l) ngrid.set(k, (l = []));
    l.push(n);
  }
  const nodesNear = (x, z, r, fn) => {
    for (let i = Math.floor((x - r) / NC); i <= Math.floor((x + r) / NC); i++) for (let j = Math.floor((z - r) / NC); j <= Math.floor((z + r) / NC); j++)
      for (const n of ngrid.get(nk(i, j)) || []) fn(n);
  };
  const reachOf = (n) => n.maxHw + REACH;

  // ---- assign OSM nodes ----
  const minis = osm.filter((o) => o.kind === 'mini');
  stats.minis = minis.length;
  const claimed = new Map(); // node -> { signals: [], crossings: [] }
  const loose = []; // OSM nodes no junction node reaches
  for (const o of osm) {
    if (o.kind === 'signals') stats.osmSignals++; else if (o.kind === 'crossing') stats.osmCrossings++;
    if (o.kind !== 'signals' && o.kind !== 'crossing') continue;
    let best = null;
    nodesNear(o.x, o.z, 60, (n) => { const d = Math.hypot(n.x - o.x, n.z - o.z); if (d < reachOf(n) && (!best || d < best.d)) best = { d, n }; });
    if (!best) { loose.push(o); continue; }
    let c = claimed.get(best.n);
    if (!c) claimed.set(best.n, (c = { signals: [], crossings: [] }));
    (o.kind === 'signals' ? c.signals : c.crossings).push({ o, d: best.d });
  }

  // ---- arms of a node ----
  const armsOf = (n) => {
    const out = [];
    for (const { e, end } of n.edges) {
      if (e.tunnel || e.L < 2) continue;
      const sd = Math.min(10, e.L * 0.5), sS = end === 1 ? e.L - sd : sd;
      net.pointAt(e, sS, 0, PT);
      const l = Math.hypot(PT.x - n.x, PT.z - n.z);
      if (l < 0.5) continue;
      const ax = (PT.x - n.x) / l, az = (PT.z - n.z) / l;
      out.push({ e, end, tdir: end === 1 ? 1 : -1, ax, az, hw: e.hw, rank: e.rank, link: e.link, approach: end === 1 || !e.oneway });
    }
    return out;
  };

  const groupArms = (arms) => {
    const order = arms.map((a, i) => ({ i, phi: axisOf(a.ax, a.az) })).sort((p, q) => p.phi - q.phi);
    const groups = [];
    for (const p of order) {
      const g = groups[groups.length - 1];
      if (g && p.phi - g.first <= GROUP_ANGLE) g.members.push(p.i); else groups.push({ first: p.phi, members: [p.i] });
    }
    if (groups.length > 1) {
      const a = groups[0], b = groups[groups.length - 1];
      if (a.first + Math.PI - b.first <= GROUP_ANGLE) { a.members.push(...b.members); groups.pop(); }
    }
    return groups.map((g) => {
      let sx = 0, sz = 0;
      for (const i of g.members) { const p = axisOf(arms[i].ax, arms[i].az); sx += Math.cos(2 * p); sz += Math.sin(2 * p); }
      let axis = Math.atan2(sz, sx) / 2; if (axis < 0) axis += Math.PI;
      return { members: g.members, axis };
    });
  };

  const lanesOf = (arm) => net.lanesFor(arm.e, arm.tdir);

  // Fill the per-arm geometry the lamps and the cars need: where the stop line is, its lanes.
  function finishArm(site, arm, idx, group, stopD, zebra) {
    arm.idx = idx; arm.group = group; arm.stopD = stopD; arm.zebra = zebra || null;
    arm.ped = !!zebra;
    arm.site = site;
    arm.short = !arm.approach || arm.e.L < stopD + 4 || (arm.upstream !== undefined && arm.upstream < MIN_UPSTREAM);
    if (arm.approach && arm.short) stats.noStopShort++;
    arm.stop = !arm.approach || arm.short ? null : true;
    const lanes = lanesOf(arm);
    arm.inner = lanes.inner; arm.outer = lanes.outer; arm.lanes = lanes.n;
    arm.poles = [];
  }
  // Point on an arm: ds metres before the stop line, lateral offset lat to the right of travel.
  // Writes into out { x, z, tx, tz } (tx, tz = travel direction).
  function armPoint(arm, ds, lat, out) {
    const e = arm.e;
    const s = arm.end === 1 ? e.L - (arm.stopD + ds) : arm.stopD + ds;
    net.pointAt(e, Math.max(0, Math.min(e.L, s)), lat * arm.tdir, PT);
    out.x = PT.x; out.z = PT.z; out.tx = PT.dx * arm.tdir; out.tz = PT.dz * arm.tdir;
    return out;
  }

  // ---- junction sites ----
  const taken = []; // sites' centres, to keep a node and its neighbour from both claiming one mark
  const addJunction = (n, source) => {
    const arms = armsOf(n);
    if (arms.length < 3 || !arms.some((a) => a.approach)) { stats.droppedNoApproach++; return null; }
    const gr = groupArms(arms);
    const site = { id: sites.length, kind: 'junction', source, x: n.x, z: n.z, arms, groups: [], node: n };
    let idx = 0;
    gr.forEach((g, gi) => {
      const members = g.members;
      const active = members.some((i) => arms[i].approach);
      const rank = Math.max(...members.map((i) => arms[i].rank));
      const hw = Math.max(...members.map((i) => arms[i].hw));
      site.groups.push({ axis: g.axis, members, active, ped: false, green: greenFor(rank), score: rank * 10 + hw * 0.2 + members.length * 0.1 });
    });
    arms.forEach((arm, ai) => {
      const gi = site.groups.findIndex((g) => g.members.includes(ai));
      const otherHw = Math.max(0, ...arms.filter((_, bi) => !site.groups[gi].members.includes(bi)).map((b) => b.hw));
      const z = zebraOnArm(n.x, n.z, arm.ax, arm.az, otherHw + 14);
      const stopD = z ? z.along + STOP_OFFSET : Math.max(otherHw, arm.hw * 0.6) + 5.5;
      finishArm(site, arm, ai, gi, Math.min(stopD, Math.max(3, arm.e.L - 1)), z && z.c);
      if (arm.ped && arm.approach !== undefined) site.groups[gi].ped = true;
      if (arm.zebra) crossingMap.set(arm.zebra, { site, group: gi });
    });
    stats.arms += arms.length;
    stats.approaches += arms.filter((a) => a.approach).length;
    sites.push(site);
    byKey.set(nodeKey(n.x, n.z), site);
    return site;
  };

  const miniNear = (n) => minis.some((m) => Math.hypot(m.x - n.x, m.z - n.z) < n.maxHw + 30);
  const midCandidates = [...loose];
  for (const [n, c] of claimed) {
    const raised = n.edges.some(({ e, end }) => e.ya && e.ya[end === 0 ? 0 : e.pts.length - 1] - ground(n.x, n.z) > 1.0);
    const ringed = nearRing(n.x, n.z);
    if (raised) { stats.droppedDeck++; continue; }
    if (ringed) { stats.droppedRing++; continue; }
    if (miniNear(n)) { stats.droppedMini++; continue; }
    if (c.signals.length) {
      if (addJunction(n, 'signals')) stats.junctions++;
      stats.crossingsAbsorbed += c.crossings.length;
      continue;
    }
    // Crossing marks only: a junction when they sit on two different arms, else single pedestrian signals.
    const dirs = new Set(c.crossings.map(({ o }) => Math.round(Math.atan2(o.z - n.z, o.x - n.x) / (Math.PI / 4))));
    if (dirs.size >= 2 && n.edges.some(({ e }) => e.rank >= 5 && !e.link)) {
      if (addJunction(n, 'crossings')) { stats.junctions++; stats.junctionsFromCrossings++; }
      stats.crossingsAbsorbed += c.crossings.length;
    } else for (const { o } of c.crossings) midCandidates.push(o);
  }

  // ---- mid-block sites ----
  const midSites = [];
  for (const o of midCandidates) {
    if (nearRing(o.x, o.z)) { stats.droppedRing++; continue; }
    if (minis.some((m) => Math.hypot(m.x - o.x, m.z - o.z) < 40)) { stats.droppedMini++; continue; }
    const hit = net.nearest(o.x, o.z, 6, (e) => !e.tunnel && e.rank <= 8);
    if (!hit) { stats.midsDropped++; continue; }
    const e = hit.e;
    if (midSites.some((m) => m.e === e && Math.abs(m.s - hit.s) < 12)) { stats.midsDropped++; continue; }
    net.pointAt(e, hit.s, 0, PT);
    const px = PT.x, pz = PT.z, tx = PT.dx, tz = PT.dz;
    if (raisedAt(e, hit.s, px, pz)) { stats.droppedDeck++; continue; }
    if (nearRing(px, pz)) { stats.droppedRing++; continue; }
    midSites.push({ e, s: hit.s, x: px, z: pz, tx, tz });
  }
  for (const m of midSites) {
    const { e } = m;
    const arms = [];
    // dir +1: vehicles travelling along the points approach from behind (smaller s).
    for (const tdir of e.oneway ? [1] : [1, -1]) {
      const upstream = tdir > 0 ? m.s : e.L - m.s;
      arms.push({ e, end: tdir > 0 ? 1 : 0, tdir, ax: -m.tx * tdir, az: -m.tz * tdir, hw: e.hw, rank: e.rank, link: e.link, approach: true, upstream, mid: true });
    }
    if (!arms.some((a) => a.upstream >= MIN_UPSTREAM)) { stats.midsDropped++; continue; }
    const site = { id: sites.length, kind: 'mid', source: 'crossing', x: m.x, z: m.z, arms, groups: [], e, s: m.s };
    site.groups.push({ axis: axisOf(m.tx, m.tz), members: arms.map((_, i) => i), active: true, ped: true, green: MID_GREEN, score: e.rank * 10 + e.hw * 0.2 });
    // A mid-block crossing is positioned along the edge, not at the end of it: the stop line is MID_STOP
    // before its centre in each travel direction. Arms store the edge's end for their travel direction,
    // so the distance is measured from the centre.
    arms.forEach((arm, ai) => {
      finishMidArm(site, arm, ai, m);
    });
    const crossing = { x: m.x, z: m.z, angle: Math.atan2(m.tx, m.tz), width: e.hw * 2, signal: true };
    site.crossing = crossing;
    newCrossings.push(crossing);
    crossingMap.set(crossing, { site, group: 0 });
    stats.mids++;
    sites.push(site);
  }
  // Mid arms measure stopD along the edge from the nearer end, like node arms, so armPoint works for both.
  function finishMidArm(site, arm, ai, m) {
    const e = arm.e;
    const fromEnd = arm.tdir > 0 ? e.L - m.s : m.s; // distance from the centre to the end the vehicle heads for
    arm.idx = ai; arm.group = 0; arm.site = site; arm.zebra = null; arm.ped = true;
    arm.stopD = fromEnd + MID_STOP;
    arm.short = arm.upstream < MIN_UPSTREAM;
    if (arm.short) stats.noStopShort++;
    arm.stop = arm.short ? null : true;
    const lanes = lanesOf(arm);
    arm.inner = lanes.inner; arm.outer = lanes.outer; arm.lanes = lanes.n;
    arm.poles = [];
    stats.arms++; stats.approaches++;
  }

  // ---- clusters: sites near each other share one cycle ----
  const par = sites.map((_, i) => i);
  const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const sgrid = new Map();
  sites.forEach((s, i) => {
    const ci = Math.floor(s.x / CLUSTER_R), cj = Math.floor(s.z / CLUSTER_R);
    for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++)
      for (const j of sgrid.get(nk(a, b)) || []) if (Math.hypot(sites[j].x - s.x, sites[j].z - s.z) < CLUSTER_R) par[find(i)] = find(j);
    const k = nk(ci, cj); let l = sgrid.get(k); if (!l) sgrid.set(k, (l = [])); l.push(i);
  });
  const clusters = new Map();
  sites.forEach((s, i) => { const r = find(i); let c = clusters.get(r); if (!c) clusters.set(r, (c = [])); c.push(s); });
  for (const list of clusters.values()) {
    // Principal axis: the group of the biggest road in the cluster. Natural cycle: the longest in it.
    let best = null;
    for (const s of list) for (const g of s.groups) if (g.active && (!best || g.score > best.score)) best = g;
    const principal = best ? best.axis : 0;
    let cycle = 0;
    for (const s of list) {
      const idx = s.groups.map((g, i) => i).sort((a, b) => axisDist(s.groups[a].axis, principal) - axisDist(s.groups[b].axis, principal));
      if (s.groups.filter((g) => g.active).length < 2) s.pedFirst = false;
      cycle = Math.max(cycle, makeStages(s, idx).cycle);
    }
    const first = list.reduce((a, b) => (a.x < b.x || (a.x === b.x && a.z < b.z) ? a : b));
    const offset = hash(first.x, first.z) * cycle;
    for (const s of list) { s.cluster = first.id; finalize(s, principal, cycle, offset); }
    stats.clusters++;
  }

  // ---- the plan ----
  const plan = {
    sites, byKey, crossingMap, newCrossings, stats, t: 0,
    hooks: [],
    advance(dt, px = 0, pz = 0) { this.t += dt; for (const h of this.hooks) h(this.t, px, pz); },
    siteAtNode(x, z) { return byKey.get(nodeKey(x, z)) || null; },
    // The arm of a junction site a vehicle with travel direction (tx, tz) arrives on.
    armFor(site, tx, tz) {
      let best = null;
      for (const a of site.arms) {
        if (!a.approach) continue;
        const d = -(a.ax * tx + a.az * tz);
        if (d > 0.7 && (!best || d > best.d)) best = { d, a };
      }
      return best && best.a;
    },
    aspect(site, arm, T = this.t) { return aspect(site, arm.group, T); },
    walk(site, group, T = this.t) { return walkState(site, group, T); },
    // 0/1/2 for a crossing (a city.crossings entry); null when no signal controls it.
    crossingWalk(c, T = this.t) { const r = crossingMap.get(c); return r ? walkState(r.site, r.group, T) : null; },
    armPoint,
    nearRing,
  };
  return plan;
}
