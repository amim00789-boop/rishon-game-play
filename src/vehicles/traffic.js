// Moving traffic and parked cars (contract: docs/ROUND3.md).
//
//   createTraffic({ scene, city, lots, collision, camera?, crowd? }) -> { update(dt, player), stats(), vehicles, colliders(), parked, net }
//
// Vehicles drive on city.roads lanes (right-hand traffic, lane offsets from width/lanes, one-ways
// respected), follow road heights over bridges and ramps, keep a speed-dependent gap to the vehicle
// ahead, slow for turns, give way at junctions when they come from the smaller road, stop for
// people on zebras and for the player, and buses stop at city.busStops. They exist only in a ring
// around the player (density by road class), drawn in three LODs (rounded models, plain-box
// models, single boxes). Two-wheelers near the player get a full avatar rider.
// Contact with the player is soft: the player is pushed out of the vehicle box and slowed, the
// vehicle stops for a moment. No damage, no crashes.
import * as THREE from 'three';
import { KINDS, pickPaint, createFleet } from './models.js';
import { buildNetwork, setGround, ground } from './network.js';
import { buildParked } from './parked.js';
import { aspect as sigAspect, MID_STOP } from '../world/signals.js';
import { t as tr } from '../i18n.js';

const NEAR_R = 110, MID_R = 300, FAR_R = 520;
const SPAWN_MIN = 210, SPAWN_R = 440, DESPAWN_R = 530;
const MAX_VEH = 67, MIN_VEH = 6; // round 3 cut a third; founder 2026-10-24: another third off
const RIDER_R = 55, RIDER_OUT = 68, MAX_RIDERS = 8;
const DEC = 12; // comfortable braking, u/s^2
const BRAKE = 30, ACCEL = 9;
const J_MAX = 8; // how far before / after a node a turn curve starts / ends

const MIX = {
  highway: [['hatch', 16], ['sedan', 24], ['suv', 18], ['van', 10], ['taxi', 4], ['truck', 9], ['semi', 8], ['coach', 5], ['bus', 2], ['moto', 4]],
  main: [['hatch', 20], ['sedan', 22], ['suv', 15], ['van', 10], ['taxi', 6], ['bus', 14], ['truck', 5], ['moto', 6], ['ebike', 5], ['kick', 3]],
  local: [['hatch', 22], ['sedan', 19], ['suv', 14], ['van', 9], ['taxi', 5], ['bus', 10], ['truck', 3], ['moto', 7], ['ebike', 10], ['kick', 7]],
  res: [['hatch', 28], ['sedan', 20], ['suv', 15], ['van', 6], ['taxi', 3], ['moto', 6], ['ebike', 12], ['kick', 10]],
};
const isHighway = (e) => e.rank >= 8 || /^(motorway|trunk)/.test(e.kind);
const bucket = (e) => (isHighway(e) ? 'highway' : e.rank >= 6 ? 'main' : e.rank >= 4 ? 'local' : 'res');

// Tall vehicles keep off underpasses they would not fit under (network.js e.clear, the free height
// under the lowest deck crossing the edge; the road surface itself sits e.lift above the ground).
function clears(kind, e) {
  const K = KINDS[kind];
  return !K || !K.big || !(e.clear < Infinity) || K.H + e.lift + 0.15 <= e.clear;
}

function allowed(kind, e) {
  const K = KINDS[kind];
  if (!clears(kind, e)) return false;
  if (kind === 'semi') return isHighway(e) || e.rank >= 6;
  if (K.big) return e.rank >= 4;
  if (K.two) return !isHighway(e) && (kind === 'moto' || e.rank <= 7);
  return true;
}

let avatarMod = null;
import('../characters/avatar.js').then((m) => { avatarMod = m; }).catch(() => {});

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createTraffic({ scene, city, lots = [], collision = null, camera = null, crowd = null, seed = 4242, restrictedAt = null } = {}) {
  const t0 = performance.now();
  const rnd = mulberry(seed);
  if (city && typeof city.heightAt === 'function') setGround((x, z) => city.heightAt(x, z, -Infinity));
  // Sealed military / private zones (src/world/details.js): no traffic or parked car inside. main.js
  // builds the details stage before this one; without an explicit hook, read it off the debug handle.
  const inZone = typeof restrictedAt === 'function' ? restrictedAt
    : (typeof window !== 'undefined' && window.__game && window.__game.details && typeof window.__game.details.restrictedAt === 'function' ? window.__game.details.restrictedAt : null);
  const net = buildNetwork(city || { roads: [] }, { restrictedAt: inZone });
  const tNet = performance.now() - t0;
  // Signal plan (src/world/signals.js), built by dressing.js. Without it nothing is signalled.
  const plan = (city && city.signalPlan) || null;
  const sigTmp = [0, 0];
  const sigStats = { stopped: 0, red: 0, amber: 0, blocked: 0, leftYield: 0 };
  // The signal a vehicle meets at the node ahead of edge e (end 1 = the b end): { site, arm } or null.
  // Arms are matched by road and end, since the plan keeps its own graph; the travel direction
  // decides when one road meets the node twice.
  function sigOf(e, end) {
    if (!plan) return null;
    const c = e.sg || (e.sg = [undefined, undefined]);
    if (c[end] !== undefined) return c[end];
    let r = null;
    const node = end === 1 ? e.b : e.a;
    const site = plan.siteAtNode(node.x, node.z);
    if (site) {
      let arm = null;
      for (const a of site.arms) if (a.approach && a.stop && a.e.road === e.road && a.end === end && Math.abs(a.e.L - e.L) < 0.05) { arm = a; break; }
      if (!arm) {
        endTangent(e, end === 1 ? 1 : -1, sigTmp);
        const a = plan.armFor(site, sigTmp[0], sigTmp[1]);
        if (a && a.stop) arm = a;
      }
      if (arm) r = { site, arm };
    }
    c[end] = r;
    return r;
  }
  // Mid-block crossing signals on an edge: e.mids = [{ site, s, arms: { 1: arm, -1: arm } }].
  if (plan) for (const site of plan.sites) {
    if (site.kind !== 'mid') continue;
    const road = site.arms[0].e.road;
    const hit = net.nearest(site.x, site.z, 5, (ee) => ee.road === road);
    if (!hit) continue;
    const m = { site, s: hit.s, arms: {} };
    for (const a of site.arms) if (a.stop) m.arms[a.tdir] = a;
    (hit.e.mids || (hit.e.mids = [])).push(m);
  }
  let parked = null;
  try { parked = buildParked({ scene, city, lots, collision, net, rnd, restrictedAt: inZone }); } catch (e) { console.warn('[traffic] parked cars failed', e); }

  const fleetKinds = [...Object.keys(KINDS), 'moto_bare'];
  const fleet = createFleet(scene, fleetKinds, { capacity: (k) => (KINDS[k] && KINDS[k].big ? 48 : 120), farCapacity: 400, name: 'traffic' });

  const vehicles = [];
  let frame = 0, nextId = 1, spawned = 0, despawned = 0, bumps = 0;
  let cand = null, candX = Infinity, candZ = Infinity, candT = 0, desired = MIN_VEH;
  let filled = false, lastPX = Infinity, lastPZ = Infinity;
  const perf = { ms: 0, n: 0, avg: 0, max: 0 };
  const P = { x: 0, z: 0, dx: 0, dz: 1, i: -1, t: 0 }, Q = { x: 0, z: 0, dx: 0, dz: 1, i: -1, t: 0 };
  const M = new THREE.Matrix4(), MF = new THREE.Matrix4(), EUL = new THREE.Euler(0, 0, 0, 'YXZ'), SC = new THREE.Vector3();
  const frustum = new THREE.Frustum(), PM = new THREE.Matrix4(), SPH = new THREE.Sphere();
  const lodCount = [0, 0, 0];
  const pgrid = new Map(), PCELL = 16;

  // ---- spawning ----
  function rebuildCandidates(px, pz) {
    const seen = new Set();
    const list = [];
    let total = 0, want = 0;
    net.grid.near(px, pz, SPAWN_R, ({ e }) => {
      if (seen.has(e) || e.tunnel) return;
      seen.add(e);
      const mx = e.pts[e.pts.length >> 1];
      const d = Math.hypot(mx[0] - px, mx[1] - pz);
      if (d > SPAWN_R + e.L / 2) return;
      const w = e.L * e.dens * (e.oneway ? 0.6 : 1);
      want += w;
      total += w;
      list.push({ e, c: total });
    });
    cand = { list, total };
    desired = Math.round(clamp(want, MIN_VEH, MAX_VEH));
    candX = px; candZ = pz;
  }

  function pickKind(e) {
    const mix = MIX[bucket(e)];
    let tot = 0;
    for (const [, w] of mix) tot += w;
    for (let tries = 0; tries < 4; tries++) {
      let r = rnd() * tot;
      for (const [k, w] of mix) { r -= w; if (r <= 0) { if (allowed(k, e)) return k; break; } }
    }
    return 'sedan';
  }

  function spawnOne(px, pz, minD) {
    if (!cand || !cand.list.length) return false;
    const r = rnd() * cand.total;
    let lo = 0, hi = cand.list.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cand.list[mid].c < r) lo = mid + 1; else hi = mid; }
    const e = cand.list[lo].e;
    const dir = e.oneway ? 1 : rnd() < 0.5 ? 1 : -1;
    const s = 1 + rnd() * Math.max(0.1, e.L - 2);
    net.pointAt(e, s, 0, P);
    const d = Math.hypot(P.x - px, P.z - pz);
    if (d < minD || d > SPAWN_R) return false;
    const kind = pickKind(e);
    const K = KINDS[kind];
    for (const u of vehicles) if (Math.abs(u.x - P.x) < K.L + 10 && Math.abs(u.z - P.z) < K.L + 10 && Math.hypot(u.x - P.x, u.z - P.z) < (K.L + u.K.L) / 2 + 6) return false;
    const lanes = net.lanesFor(e, dir).n;
    const lane = K.big || K.two ? lanes - 1 : Math.floor(rnd() * lanes);
    const v = {
      id: nextId++, kind, K, color: pickPaint(kind, rnd), e, dir, s, lane,
      off: 0, offT: 0, v: 0, drv: 0.85 + rnd() * 0.23, x: P.x, y: 0, z: P.z, yaw: 0, yawRate: 0, pitch: 0,
      turn: null, next: null, wait: 0, stuck: 0, lastStop: -1, dwell: 0, bump: 0, hidden: false, rider: null, d,
    };
    v.off = v.offT = net.laneOffsets(e, dir, lane, K.W / 2, K.two);
    v.v = Math.min(e.speed * v.drv * (K.vMax || 1), K.cap || 99) * 0.8;
    place(v, 0);
    v.yaw = v.yawT;
    vehicles.push(v);
    spawned++;
    return true;
  }

  function remove(i) {
    const v = vehicles[i];
    if (v.rider) releaseRider(v);
    vehicles[i] = vehicles[vehicles.length - 1];
    vehicles.pop();
    despawned++;
  }

  // ---- routing ----
  function endTangent(e, dir, out) {
    // Travel direction at the node the vehicle is heading to.
    const p = e.pts, n = p.length;
    let ax, az, bx, bz;
    if (dir > 0) { ax = p[n - 2][0]; az = p[n - 2][1]; bx = p[n - 1][0]; bz = p[n - 1][1]; } else { ax = p[1][0]; az = p[1][1]; bx = p[0][0]; bz = p[0][1]; }
    const l = Math.hypot(bx - ax, bz - az) || 1;
    out[0] = (bx - ax) / l; out[1] = (bz - az) / l;
    return out;
  }
  function startTangent(e, dir, out) {
    const p = e.pts, n = p.length;
    let ax, az, bx, bz;
    if (dir > 0) { ax = p[0][0]; az = p[0][1]; bx = p[1][0]; bz = p[1][1]; } else { ax = p[n - 1][0]; az = p[n - 1][1]; bx = p[n - 2][0]; bz = p[n - 2][1]; }
    const l = Math.hypot(bx - ax, bz - az) || 1;
    out[0] = (bx - ax) / l; out[1] = (bz - az) / l;
    return out;
  }
  const T0 = [0, 0], T1 = [0, 0];

  function chooseNext(v, px, pz) {
    const e = v.e, node = v.dir > 0 ? e.b : e.a;
    endTangent(e, v.dir, T0);
    const opts = [];
    let tot = 0;
    for (const { e: ce, end } of node.edges) {
      let nd;
      if (end === 0) nd = 1; else { if (ce.oneway) continue; nd = -1; }
      if (ce === e && nd === -v.dir) continue;
      startTangent(ce, nd, T1);
      const cos = T0[0] * T1[0] + T0[1] * T1[1];
      if (cos < -0.85) continue; // no hairpin turns onto a twin carriageway
      let w = 0.25 + (1 + cos) * (1 + cos);
      if (ce.rank >= e.rank - 1) w *= 2;
      if (ce.rank < e.rank - 2) w *= 0.4;
      if (!clears(v.kind, ce)) continue; // a hard no: it would drive through the deck
      if (!allowed(v.kind, ce)) w *= 0.02;
      if (v.kind === 'bus' && ce.stops.length) w *= 3; // buses keep to streets with stops
      if (v.d > 260) {
        const tx = px - node.x, tz = pz - node.z;
        w *= tx * T1[0] + tz * T1[1] > 0 ? 2.5 : 0.5;
      }
      tot += w;
      opts.push({ ce, nd, cos, w });
    }
    if (!opts.length) {
      if (e.oneway) return null;
      return { e, dir: -v.dir, cos: -1, uturn: true };
    }
    let r = rnd() * tot;
    for (const o of opts) { r -= o.w; if (r <= 0) return { e: o.ce, dir: o.nd, cos: o.cos }; }
    const o = opts[opts.length - 1];
    return { e: o.ce, dir: o.nd, cos: o.cos };
  }

  const jdist = (e) => Math.min(J_MAX, e.L * 0.45);

  function startTurn(v) {
    const n = v.next, K = v.K;
    const ne = n.e, nd = n.dir;
    const curN = net.lanesFor(v.e, v.dir).n, nxtN = net.lanesFor(ne, nd).n;
    const fromOuter = curN - 1 - v.lane;
    const nl = K.big || K.two ? nxtN - 1 : Math.max(0, nxtN - 1 - fromOuter);
    const noff = net.laneOffsets(ne, nd, nl, K.W / 2, K.two);
    const J2 = jdist(ne);
    const s2 = nd > 0 ? J2 : ne.L - J2;
    // p0: where we are now on the lane; p2: the lane point on the next edge.
    net.pointAt(v.e, v.s, v.off * v.dir, P);
    const t0x = P.dx * v.dir, t0z = P.dz * v.dir;
    net.pointAt(ne, s2, noff * nd, Q);
    const t2x = Q.dx * nd, t2z = Q.dz * nd;
    const p0x = P.x, p0z = P.z, p2x = Q.x, p2z = Q.z;
    const wx = p2x - p0x, wz = p2z - p0z, wl = Math.hypot(wx, wz);
    const det = t0x * t2z - t0z * t2x;
    let cx = (p0x + p2x) / 2, cz = (p0z + p2z) / 2;
    if (n.uturn) { cx += t0x * (4 + K.W); cz += t0z * (4 + K.W); }
    else if (Math.abs(det) > 0.05) {
      const a = (wx * t2z - wz * t2x) / det, b = (t0x * wz - t0z * wx) / det;
      if (a > 0 && b > 0 && a < wl * 2 + 4 && b < wl * 2 + 4) { cx = p0x + t0x * a; cz = p0z + t0z * a; }
    }
    const tab = new Float32Array(11);
    let lx = p0x, lz = p0z;
    for (let k = 1; k <= 10; k++) {
      const u = k / 10, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
      const x = a * p0x + b * cx + c * p2x, z = a * p0z + b * cz + c * p2z;
      tab[k] = tab[k - 1] + Math.hypot(x - lx, z - lz);
      lx = x; lz = z;
    }
    const raised = v.e.raised || ne.raised;
    const y2 = net.heightAt(ne, s2, p2x, p2z, Q.i, Q.t);
    v.turn = { p0x, p0z, cx, cz, p2x, p2z, tab, len: tab[10], u: 0, y0: v.y, y2, raised, node: v.dir > 0 ? v.e.b : v.e.a, ne, nd, nl, noff, s2, lift: ne.lift };
  }

  function turnPoint(T, dist, out) {
    const tab = T.tab;
    let k = 1;
    while (k < 10 && tab[k] < dist) k++;
    const seg = tab[k] - tab[k - 1] || 1e-6;
    const u = clamp((k - 1 + (dist - tab[k - 1]) / seg) / 10, 0, 1);
    const a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
    out.x = a * T.p0x + b * T.cx + c * T.p2x;
    out.z = a * T.p0z + b * T.cz + c * T.p2z;
    out.dx = 2 * (1 - u) * (T.cx - T.p0x) + 2 * u * (T.p2x - T.cx);
    out.dz = 2 * (1 - u) * (T.cz - T.p0z) + 2 * u * (T.p2z - T.cz);
    const l = Math.hypot(out.dx, out.dz) || 1;
    out.dx /= l; out.dz /= l;
    out.u = u;
    return out;
  }

  // Position, heading, height and pitch from the vehicle's route state.
  function place(v) {
    const K = v.K;
    if (v.turn) {
      const T = v.turn;
      turnPoint(T, T.u, P);
      v.x = P.x; v.z = P.z;
      v.yawT = Math.atan2(P.dx, P.dz);
      const yg = T.raised ? T.y0 + (T.y2 - T.y0) * P.u : ground(P.x, P.z) + T.lift;
      v.y = yg;
      v.pitchT = T.raised ? v.pitch : -Math.atan2(ground(P.x + P.dx * K.L * 0.5, P.z + P.dz * K.L * 0.5) - ground(P.x - P.dx * K.L * 0.5, P.z - P.dz * K.L * 0.5), K.L);
      v.hidden = v.e.tunnel && T.ne.tunnel;
      return;
    }
    const e = v.e;
    net.pointAt(e, v.s, v.off * v.dir, P);
    v.x = P.x; v.z = P.z;
    v.yawT = Math.atan2(P.dx * v.dir, P.dz * v.dir);
    v.y = net.heightAt(e, v.s, P.x, P.z, P.i, P.t);
    const h = K.L * 0.5;
    if (e.raised) {
      const sf = clamp(v.s + v.dir * h, 0, e.L), sb = clamp(v.s - v.dir * h, 0, e.L);
      const yf = net.heightAt(e, sf, 0, 0), yb = net.heightAt(e, sb, 0, 0);
      v.pitchT = -Math.atan2(yf - yb, Math.abs(sf - sb) || 1);
    } else {
      const fx = P.dx * v.dir, fz = P.dz * v.dir;
      v.pitchT = -Math.atan2(ground(P.x + fx * h, P.z + fz * h) - ground(P.x - fx * h, P.z - fz * h), 2 * h);
    }
    v.hidden = e.tunnel;
  }

  // ---- pedestrians on zebras ----
  function npcs() {
    const c = crowd || (typeof window !== 'undefined' && window.__game && window.__game.crowd);
    return (c && c.npcs) || null;
  }
  // A zebra is busy when someone is on it (onRoad) or stepping off the kerb at its ends (atKerb).
  // People waiting at the kerb stop traffic only for a while, so an idle group cannot jam a street.
  function crossingState(c, people, px, pz, walkerNear) {
    if (c.f === frame) return c.state;
    c.f = frame;
    let state = 0;
    // Someone standing still (a chatting pair) only holds traffic as long as a kerb waiter does.
    const test = (x, z, still) => {
      const rx = x - c.x, rz = z - c.z;
      if (Math.abs(rx * c.tx + rz * c.tz) > 3.6) return;
      const across = Math.abs(rx * c.tz - rz * c.tx);
      if (across < c.hw - 0.2 && !still) state = 2;
      else if (across < c.hw + 0.8 && state < 1) state = 1;
    };
    if (walkerNear) test(px, pz, false);
    if (people && state < 2) {
      for (const n of people) {
        const dx = n.x - c.x, dz = n.z - c.z;
        if (dx * dx + dz * dz < c.r * c.r) { test(n.x, n.z, n.state === 'stand'); if (state === 2) break; }
      }
    }
    c.state = state;
    return state;
  }
  const crossingBusy = (c, people, px, pz, walkerNear, v) => {
    const st = crossingState(c, people, px, pz, walkerNear);
    return st === 2 || (st === 1 && v.zw < 8);
  };

  // Is v held by other traffic only (a waiting cycle), rather than by a person, a zebra or a bus stop?
  const PATIENT = new Set(['player', 'person', 'zebra', 'zebra2', 'dwell', 'bump', 'busstop', 'signal']);
  function heldByTraffic(v) {
    const seen = new Set();
    let u = v;
    while (u && u.why === 'follow' && u.lead && !seen.has(u)) { seen.add(u); u = u.lead; }
    return !(u && !seen.has(u) && PATIENT.has(u.why));
  }

  // ---- signals ----
  // Speed cap that stops the front of v at the stop line `dist` ahead. Red stops, amber stops unless
  // the vehicle could not (stopping distance at comfortable braking, plus a reaction margin), green
  // goes unless the box beyond is full or a left turn must give way to oncoming traffic.
  function signalLimit(v, target, dist, asp, sg, dt) {
    if (dist < -0.8) { v.sigWait = 0; return target; }
    const stopCap = Math.sqrt(2 * DEC * Math.max(0, dist - 0.4));
    if (asp === 'R') { sigStats.red++; return lim(v, target, stopCap, 'signal'); }
    if (asp === 'A') {
      const need = (v.v * v.v) / (2 * DEC * 1.2) + v.v * 0.3;
      if (dist >= need) { sigStats.amber++; return lim(v, target, stopCap, 'signal'); }
      return target;
    }
    if (sg && dist < 14) {
      if (holdAtGreen(v, sg, dt)) return lim(v, target, stopCap, 'signal');
    }
    return target;
  }
  // A green is not an invitation into a full junction: wait while the first stretch of the road
  // beyond is blocked by stopped vehicles, and give way on a left turn to cars coming the other
  // way. Both give up after a few seconds, so nothing waits for ever.
  function holdAtGreen(v, sg, dt) {
    const nx = v.next;
    if (!nx || nx.uturn) return false;
    const K = v.K, ne = nx.e, nd = nx.dir;
    if (v.sigWait > 7) return false;
    for (const u of vehicles) {
      if (u === v || u.hidden) continue;
      if (!u.turn && u.e === ne) {
        const du = nd > 0 ? u.s : ne.L - u.s;
        if (du < K.L + 7 && u.v < 1.5) { v.sigWait = (v.sigWait || 0) + dt; sigStats.blocked++; return true; }
      }
    }
    if (nx.cos < 0.5) {
      const e = v.e, node = v.dir > 0 ? e.b : e.a;
      endTangent(e, v.dir, T0);
      startTangent(ne, nd, T1);
      if (T0[0] * T1[1] - T0[1] * T1[0] < -0.35 && nx.cos > -0.5) {
        for (const u of vehicles) {
          if (u === v || u.hidden || u.v < 1) continue;
          if (u.turn) continue;
          const unode = u.dir > 0 ? u.e.b : u.e.a;
          if (unode !== node || u.e === e) continue;
          const du = u.dir > 0 ? u.e.L - u.s : u.s;
          if (du > 20) continue;
          if (Math.cos(u.yaw - v.yaw) < -0.7) { v.sigWait = (v.sigWait || 0) + dt; sigStats.leftYield++; return true; }
        }
      }
    }
    return false;
  }

  // ---- the player and the signals ----
  // Driving (car, bike, scooter) across a stop line against a red that is at least 1.5 s old counts
  // as running it: a toast, a count in stats(), and the cars of the green group already brake for
  // the player (control(): 'player'). Walking is never checked; zebras are for people.
  let redRuns = 0, redToastAt = -99, pLastX = NaN, pLastZ = NaN;
  function playerRedLight(player, px, pz) {
    const drive = player && player.mode && player.mode !== 'walk' && player.mode !== 'idle';
    const lx = pLastX, lz = pLastZ;
    pLastX = px; pLastZ = pz;
    if (!drive || !(lx === lx) || Math.hypot(px - lx, pz - lz) > 6) return;
    for (const site of plan.sites) {
      if (Math.abs(site.x - px) > 70 || Math.abs(site.z - pz) > 70) continue;
      for (const arm of site.arms) {
        if (!arm.stop) continue;
        const L = arm.line || (arm.line = (() => { const o = {}; plan.armPoint(arm, 0, (arm.inner + arm.outer) / 2, o); return o; })());
        const d0 = (lx - L.x) * L.tx + (lz - L.z) * L.tz, d1 = (px - L.x) * L.tx + (pz - L.z) * L.tz;
        if (!(d0 < 0 && d1 >= 0) || Math.abs((px - L.x) * L.tz - (pz - L.z) * L.tx) > arm.e.hw) continue;
        if (sigAspect(site, arm.group, plan.t) !== 'R' || sigAspect(site, arm.group, plan.t - 1.5) !== 'R') continue;
        redRuns++;
        if (api.onRedRun) { try { api.onRedRun({ site, arm, t: plan.t }); } catch (e) { console.warn('[traffic] onRedRun failed', e); } }
        if (plan.t - redToastAt > 6) {
          redToastAt = plan.t;
          const hud = typeof window !== 'undefined' && window.__game && window.__game.hud;
          if (hud && hud.toastMsg) hud.toastMsg(tr('hud.redLight'));
        }
        return;
      }
    }
  }

  // ---- per-vehicle control ----
  // Lowers the target speed and remembers why (stats() reports what is holding traffic up).
  function lim(v, target, cap, why) {
    if (cap < target) { v.why = why; return cap; }
    return target;
  }
  function control(v, dt, px, pz, py, player, people) {
    const K = v.K, e = v.e;
    let vLim = Math.min(e.speed * v.drv * (K.vMax || 1), K.cap || 99);
    let target = vLim;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);

    const prevWhy = v.why || '';
    v.why = '';
    // Zebra patience and the gridlock breaker: a vehicle held for long by other traffic (a
    // circular wait at a junction) ignores other vehicles for a moment and squeezes through.
    v.zw = prevWhy.startsWith('zebra') && v.v < 0.5 ? (v.zw || 0) + dt : 0;
    if (v.ghost > 0) v.ghost -= dt;
    else if (v.stuck > 10 && (prevWhy === 'follow' || prevWhy === 'yield') && heldByTraffic(v)) v.ghost = 2.5;
    if (v.dwell > 0) { v.dwell -= dt; target = 0; v.why = 'dwell'; }
    if (v.bump > 0) { v.bump -= dt; target = 0; v.why = 'bump'; }

    if (!v.turn) {
      const dEnd = v.dir > 0 ? e.L - v.s : v.s;
      const J = jdist(e);
      const node = v.dir > 0 ? e.b : e.a;
      if (!v.next && dEnd < 70) v.next = chooseNext(v, px, pz);
      if (v.next) {
        const c = v.next.cos;
        let vt = node.deg <= 2 && c > 0.9 ? vLim : 4 + (vLim - 4) * Math.pow((1 + c) / 2, 2);
        if (v.next.uturn) vt = 3;
        target = lim(v, target, Math.sqrt(vt * vt + 2 * DEC * Math.max(0, dEnd - J)), 'turn');
        // Give way: coming from the smaller road into a junction someone is crossing.
        const sg = plan ? sigOf(e, v.dir > 0 ? 1 : 0) : null;
        if (!(v.ghost > 0) && !sg && node.deg >= 3 && e.rank < node.maxRank && node.busy >= frame - 1 && node.busyBy !== v && dEnd < J + 14 && v.wait < 3.5) {
          target = lim(v, target, Math.sqrt(2 * DEC * Math.max(0, dEnd - J - 2)), 'yield');
          if (v.v < 1) v.wait += dt;
        } else if (v.v > 2) v.wait = 0;
      } else {
        // One-way dead end: roll to the end and vanish there.
        target = lim(v, target, Math.sqrt(2 * DEC * Math.max(0, dEnd - 1)) + 1, 'deadend');
      }
      // Zebras ahead on this edge, then just past the node on the next one.
      const walkerNear = player && player.mode !== 'car';
      for (const c of e.crossings) {
        const dc = (c.s - v.s) * v.dir;
        if (dc < K.L * 0.5 - 0.5 || dc > 40) continue;
        if (crossingBusy(c, people, px, pz, walkerNear, v)) target = lim(v, target, Math.sqrt(2 * DEC * Math.max(0, dc - K.L * 0.5 - 3)), 'zebra');
      }
      if (v.next && dEnd < 30) {
        const ne = v.next.e;
        for (const c of ne.crossings) {
          const dc = dEnd + (v.next.dir > 0 ? c.s : ne.L - c.s);
          if (dc > 40) continue;
          if (crossingBusy(c, people, px, pz, walkerNear, v)) target = lim(v, target, Math.sqrt(2 * DEC * Math.max(0, dc - K.L * 0.5 - 3)), 'zebra2');
        }
      }
      // Signals: the stop line of the node ahead, then mid-block crossing signals on this edge.
      if (plan) {
        const sg = sigOf(e, v.dir > 0 ? 1 : 0);
        if (sg) {
          const dist = dEnd - sg.arm.stopD - K.L / 2;
          if (dist < 90) target = signalLimit(v, target, dist, sigAspect(sg.site, sg.arm.group, plan.t), sg, dt);
        }
        // A short link between two junctions of one cluster: the next node's line is only a few
        // metres past this one, too late to start braking when the car reaches the link.
        if (v.next && !v.next.uturn) {
          const ne = v.next.e, sg2 = sigOf(ne, v.next.dir > 0 ? 1 : 0);
          if (sg2 && ne.L - sg2.arm.stopD < 32) {
            const dist2 = dEnd + ne.L - sg2.arm.stopD - K.L / 2;
            if (dist2 < 90) target = signalLimit(v, target, dist2, sigAspect(sg2.site, sg2.arm.group, plan.t), null, dt);
          }
        }
        if (e.mids) for (const m of e.mids) {
          const arm = m.arms[v.dir];
          if (!arm) continue;
          const dist = (m.s - v.dir * MID_STOP - v.s) * v.dir - K.L / 2;
          if (dist < -0.8 || dist > 90) continue;
          target = signalLimit(v, target, dist, sigAspect(m.site, 0, plan.t), null, dt);
        }
      }
      // Buses: pull in to the kerb and stop at the shelter.
      if (v.kind === 'bus' && v.dwell <= 0) {
        let near = null;
        for (const st of e.stops) {
          if (st.id === v.lastStop || (!e.oneway && st.dir !== v.dir)) continue;
          const ds = (st.s - v.s) * v.dir;
          if (ds > -1 && ds < 60 && (!near || ds < near.ds)) near = { st, ds };
        }
        if (near) {
          target = lim(v, target, Math.sqrt(2 * DEC * Math.max(0, near.ds)) + 0.3, 'busstop');
          v.offT = net.laneOffsets(e, v.dir, 99, K.W / 2, true);
          if (near.ds < 1.2 && v.v < 1.2) { v.dwell = 4 + rnd() * 3; v.lastStop = near.st.id; }
        } else v.offT = net.laneOffsets(e, v.dir, v.lane, K.W / 2, K.two);
      }
    } else {
      const T = v.turn;
      T.node.busy = frame;
      T.node.busyBy = v;
      const c = v.next ? v.next.cos : 1;
      const vt = v.next && v.next.uturn ? 3 : 4 + (vLim - 4) * Math.pow((1 + c) / 2, 2);
      target = lim(v, target, Math.max(vt, T.node.deg <= 2 && c > 0.9 ? vLim : vt), 'inturn');
      // The line of the next junction can lie inside this turn's zone (a short link): keep obeying it.
      if (plan) {
        const ne = T.ne, sg2 = sigOf(ne, T.nd > 0 ? 1 : 0);
        if (sg2) {
          const lineS = T.nd > 0 ? ne.L - sg2.arm.stopD : sg2.arm.stopD;
          const dist2 = T.len - T.u + (T.nd > 0 ? lineS - T.s2 : T.s2 - lineS) - K.L / 2;
          if (dist2 > -0.8 && dist2 < 60) target = signalLimit(v, target, dist2, sigAspect(sg2.site, sg2.arm.group, plan.t), null, dt);
        }
      }
    }

    // Car following: the nearest vehicle ahead in roughly the same lane, and the player.
    const minGap = 2.1 + v.v * 0.5; // bumper gap, scaled with the 0.85 vehicles
    for (const u of vehicles) {
      if (u === v || u.hidden || v.ghost > 0) continue;
      const dx = u.x - v.x, dz = u.z - v.z;
      if (dx > 50 || dx < -50 || dz > 50 || dz < -50) continue;
      const along = dx * fx + dz * fz;
      if (along <= 0 || along > 50) continue;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > (K.W + u.K.W) * 0.43 + 0.1) continue;
      if (Math.abs(u.y - v.y) > 3.5) continue;
      const hd = Math.cos(u.yaw - v.yaw);
      if (hd < -0.3) continue;
      // Two vehicles converging at an angle that each wait for the other: the older one goes.
      if (hd < 0.7 && u.lead === v && u.why === 'follow' && v.id < u.id) continue;
      const gap = along - (K.L + u.K.L) / 2;
      const ua = Math.max(0, u.v * hd);
      const cap = Math.max(0, ua + (gap - minGap) * 1.1);
      if (cap < target) { target = cap; v.why = 'follow'; v.lead = u; }
    }
    // Anyone on foot in the lane ahead (not only on zebras): stop short of them, never drive through.
    if (pgrid.size) {
      const ax = v.x + fx * 12, az = v.z + fz * 12;
      const cx0 = Math.floor(ax / PCELL), cz0 = Math.floor(az / PCELL);
      for (let ix = cx0 - 1; ix <= cx0 + 1; ix++) {
        for (let iz = cz0 - 1; iz <= cz0 + 1; iz++) {
          const l = pgrid.get(ix * 100003 + iz);
          if (!l) continue;
          for (const n of l) {
            const dx = n.x - v.x, dz = n.z - v.z;
            const along = dx * fx + dz * fz;
            if (along <= 0 || along > 26) continue;
            if (Math.abs(dx * fz - dz * fx) > K.W / 2 + 0.9) continue;
            if (n.y != null && Math.abs(n.y - v.y) > 3) continue;
            target = lim(v, target, Math.max(0, (along - K.L / 2 - 2.6) * 1.1), 'person');
          }
        }
      }
    }
    if (player) {
      const dx = px - v.x, dz = pz - v.z;
      const along = dx * fx + dz * fz;
      const pr = (player.params && player.params.radius) || 1.3;
      if (along > 0 && along < 45 && Math.abs(py - v.y) < 4) {
        const lat = Math.abs(dx * fz - dz * fx);
        if (lat < K.W / 2 + pr + 0.6) {
          const ua = Math.max(0, (player.speed || 0) * Math.cos((player.heading || 0) - v.yaw));
          target = lim(v, target, Math.max(0, ua + (along - K.L / 2 - pr - 2.6) * 1.1), 'player');
        }
      }
    }

    // Held up by someone in the lane (or a stopped vehicle) on a multi-lane road: change lanes.
    if (!v.turn && v.v < 3 && (v.why === 'person' || v.why === 'follow') && v.stuck > 2.5) tryLaneChange(v);

    const dv = target - v.v;
    v.v += dv > 0 ? Math.min(dv, ACCEL * dt) : Math.max(dv, -BRAKE * dt);
    if (v.v < 0) v.v = 0;
    v.stuck = v.v < 0.3 ? v.stuck + dt : 0;
  }

  function tryLaneChange(v) {
    const K = v.K, lanes = net.lanesFor(v.e, v.dir).n;
    if (lanes < 2 || v.laneT > 0) return;
    v.laneT = 3; // do not dither between lanes
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    for (const nl of [v.lane - 1, v.lane + 1]) {
      if (nl < 0 || nl >= lanes) continue;
      const off = net.laneOffsets(v.e, v.dir, nl, K.W / 2, false);
      const shift = off - v.off; // + is to the right of travel
      const rx = -fz * shift, rz = fx * shift; // right of travel is (-fz, fx) with x east, z south
      const tx = v.x + rx, tz = v.z + rz;
      let clear = true;
      for (const u of vehicles) {
        if (u === v) continue;
        const dx = u.x - tx, dz = u.z - tz;
        const al = dx * fx + dz * fz, la = Math.abs(dx * fz - dz * fx);
        if (la < (K.W + u.K.W) / 2 && al > -(K.L + u.K.L) / 2 - 6 && al < (K.L + u.K.L) / 2 + 10) { clear = false; break; }
      }
      if (clear) for (const n of npcs() || []) {
        const dx = n.x - tx, dz = n.z - tz;
        const al = dx * fx + dz * fz;
        if (al > -K.L / 2 && al < 30 && Math.abs(dx * fz - dz * fx) < K.W / 2 + 1) { clear = false; break; }
      }
      if (clear) { v.lane = nl; v.offT = off; return; }
    }
  }

  function advance(v, dt) {
    if (v.laneT > 0) v.laneT -= dt;
    let ds = v.v * dt;
    if (v.turn) {
      const T = v.turn;
      T.u += ds;
      if (T.u >= T.len) {
        v.e = T.ne; v.dir = T.nd; v.s = T.s2; v.lane = T.nl; v.off = v.offT = T.noff;
        v.turn = null; v.next = null; v.wait = 0;
      }
      return true;
    }
    const e = v.e;
    v.off += clamp(v.offT - v.off, -2.5 * dt, 2.5 * dt);
    v.s += ds * v.dir;
    const dEnd = v.dir > 0 ? e.L - v.s : v.s;
    if (v.next && dEnd <= jdist(e)) {
      startTurn(v);
      if (v.turn.len < 0.05) advance(v, 0);
    } else if (dEnd <= 0.2 && !v.next) return false; // dead end
    if (v.s < 0) v.s = 0; else if (v.s > e.L) v.s = e.L;
    return true;
  }

  // ---- riders (full avatars on nearby two-wheelers) ----
  const riderPool = { delivery: [], street: [] };
  let riderCount = 0, streetIds = null;
  function makeRider(kind) {
    if (!avatarMod || !avatarMod.createAvatar) return null;
    const type = kind === 'ebike' ? 'delivery' : 'street';
    const pool = riderPool[type];
    if (pool.length) return pool.pop();
    if (riderCount >= MAX_RIDERS + 4) return null;
    if (!streetIds) {
      const A = avatarMod.ARCHETYPES || {};
      streetIds = Object.keys(A).filter((id) => id !== 'player_rishoni' && id !== 'delivery_rider' && A[id].crowd && A[id].crowd.zones && (A[id].crowd.zones.street > 0.3 || A[id].crowd.zones.busy > 0.3));
      if (!streetIds.length) streetIds = ['player_rishoni'];
    }
    let av = null;
    try {
      const A = avatarMod.ARCHETYPES || {};
      const id = type === 'delivery' && A.delivery_rider ? 'delivery_rider' : streetIds[Math.floor(rnd() * streetIds.length)];
      av = avatarMod.createAvatar({ archetype: id, seed: Math.floor(rnd() * 1e6) });
    } catch (e) { console.warn('[traffic] rider avatar failed', e); avatarMod = null; return null; }
    av.type = type;
    av.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    riderCount++;
    return av;
  }
  function releaseRider(v) {
    const av = v.rider;
    v.rider = null;
    av.group.visible = false;
    if (av.group.parent) av.group.parent.remove(av.group);
    riderPool[av.type].push(av);
  }
  function updateRiders(dt) {
    let created = 0, active = 0;
    for (const v of vehicles) if (v.rider && (v.d > RIDER_OUT || v.hidden)) releaseRider(v);
    for (const v of vehicles) if (v.rider) active++;
    if (active < MAX_RIDERS && avatarMod) {
      const want = vehicles.filter((v) => v.K.two && !v.rider && !v.hidden && v.d < RIDER_R).sort((a, b) => a.d - b.d);
      for (const v of want) {
        if (active >= MAX_RIDERS || created >= 1) break;
        const fromPool = riderPool[v.kind === 'ebike' ? 'delivery' : 'street'].length > 0;
        const av = makeRider(v.kind);
        if (!av) break;
        if (!fromPool) created++;
        v.rider = av;
        av.setMode(v.kind === 'kick' ? 'scooter' : v.kind === 'ebike' ? 'bike' : 'car');
        av.group.visible = true;
        scene.add(av.group);
        active++;
      }
    }
    for (const v of vehicles) {
      const av = v.rider;
      if (!av) continue;
      const g = av.group;
      g.rotation.order = 'YXZ';
      g.rotation.set(v.pitch, v.yaw, v.roll || 0);
      if (v.kind === 'moto') {
        // Motorbike seat top and rider spot in the model (models.js), times the vehicle scale.
        const s = KINDS.moto.s, seat = 1.85 * s - (av.seatHeight || 1.0);
        g.position.set(v.x - Math.sin(v.yaw) * 0.45 * s, v.y + seat, v.z - Math.cos(v.yaw) * 0.45 * s);
      } else g.position.set(v.x, v.y, v.z);
      try { av.update(dt, v.v, { mode: av.mode }); } catch (e) { /* keep driving without animation */ }
    }
  }

  // ---- player contact ----
  function pushPlayer(player) {
    if (!player || !player.pos) return;
    const pos = player.pos, r = (player.params && player.params.radius) || 1.3, py = player.y || 0;
    let hit = false;
    for (const v of vehicles) {
      if (v.hidden) continue;
      const dx = pos.x - v.x, dz = pos.z - v.z;
      const reach = v.K.L / 2 + r + 1;
      if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue;
      if (py > v.y + v.K.H || py < v.y - 3) continue;
      const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw), sx = fz, sz = -fx;
      const lz = dx * fx + dz * fz, lx = dx * sx + dz * sz;
      const hw = v.K.W / 2, hl = v.K.L / 2;
      const cx = clamp(lx, -hw, hw), cz = clamp(lz, -hl, hl);
      let nx = lx - cx, nz = lz - cz;
      const d = Math.hypot(nx, nz);
      if (d >= r) continue;
      let push;
      if (d > 1e-4) { nx /= d; nz /= d; push = r - d; } else {
        const px = hw - Math.abs(lx), pz = hl - Math.abs(lz);
        if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; push = px + r; } else { nx = 0; nz = Math.sign(lz) || 1; push = pz + r; }
      }
      push = Math.min(push, 1.2);
      const wx = sx * nx + fx * nz, wz = sz * nx + fz * nz;
      pos.x += wx * push; pos.z += wz * push;
      // Driving into a vehicle is a soft bump: lose most of the speed into it, keep the rest.
      const h = player.heading || 0, ps = player.speed || 0;
      const into = -(Math.sin(h) * wx + Math.cos(h) * wz) * Math.sign(ps);
      if (into > 0.3 && Math.abs(ps) > 2) player.speed = ps * 0.55;
      v.bump = Math.max(v.bump, 1.2);
      hit = true;
    }
    if (hit) {
      bumps++;
      if (collision && collision.resolve) collision.resolve(pos, r);
      if (player.root) { player.root.position.x = pos.x; player.root.position.z = pos.z; }
    }
  }

  // ---- render ----
  function render(px, pz) {
    fleet.begin();
    lodCount[0] = lodCount[1] = lodCount[2] = 0;
    let cull = false;
    if (camera) {
      camera.updateMatrixWorld();
      PM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(PM);
      cull = true;
    }
    for (const v of vehicles) {
      if (v.hidden || v.d > FAR_R) continue;
      const K = v.K;
      if (cull && v.d > 35) {
        SPH.center.set(v.x, v.y + K.H / 2, v.z);
        SPH.radius = K.L / 2 + 1;
        if (!frustum.intersectsSphere(SPH)) continue;
      }
      EUL.set(v.pitch, v.yaw, v.roll || 0);
      M.makeRotationFromEuler(EUL).setPosition(v.x, v.y, v.z);
      const lod = v.d < NEAR_R ? 0 : v.d < MID_R ? 1 : 2;
      let kind = v.kind;
      if (v.rider) { if (kind !== 'moto') continue; kind = 'moto_bare'; }
      if (lod === 2) {
        MF.copy(M).scale(SC.set(K.W, K.H * 0.82, K.L));
        fleet.add(kind, 2, MF, v.color);
      } else fleet.add(kind, lod, M, v.color);
      lodCount[lod]++;
    }
    fleet.end();
  }

  // ---- main update ----
  function update(dt, player) {
    const tStart = performance.now();
    frame++;
    dt = Math.min(dt, 0.1);
    const px = player && player.pos ? player.pos.x : 0, pz = player && player.pos ? player.pos.z : 0;
    const py = player ? player.y || 0 : 0;
    if (parked) parked.update(px, pz);
    if (plan) plan.advance(dt, px, pz);
    if (plan) playerRedLight(player, px, pz);

    // A teleport (spawn, quest skip, map jump) refills the ring at once instead of waiting for traffic to arrive.
    if (Math.hypot(px - lastPX, pz - lastPZ) > 150) { filled = false; cand = null; }
    lastPX = px; lastPZ = pz;
    candT -= dt;
    if (!cand || candT <= 0 || Math.hypot(px - candX, pz - candZ) > 60) { rebuildCandidates(px, pz); candT = 2; }
    for (let i = vehicles.length - 1; i >= 0; i--) {
      const v = vehicles[i];
      v.d = Math.hypot(v.x - px, v.z - pz);
      if (v.d > DESPAWN_R || (v.stuck > 25 && v.d > 150)) remove(i);
    }
    if (!filled) {
      for (let tries = 0; tries < desired * 6 && vehicles.length < desired; tries++) spawnOne(px, pz, 30);
      filled = true;
    } else {
      for (let k = 0; k < 3 && vehicles.length < desired; k++) spawnOne(px, pz, SPAWN_MIN);
    }

    const people = npcs();
    pgrid.clear();
    if (people) {
      for (const n of people) {
        if (Math.abs(n.x - px) > DESPAWN_R || Math.abs(n.z - pz) > DESPAWN_R) continue;
        const k = Math.floor(n.x / PCELL) * 100003 + Math.floor(n.z / PCELL);
        let l = pgrid.get(k);
        if (!l) { l = []; pgrid.set(k, l); }
        l.push(n);
      }
    }
    for (const v of vehicles) control(v, dt, px, pz, py, player, people);
    for (let i = vehicles.length - 1; i >= 0; i--) {
      const v = vehicles[i];
      if (!advance(v, dt)) { remove(i); continue; }
      const prevYaw = v.yaw;
      place(v);
      v.yaw = prevYaw + wrap(v.yawT - prevYaw) * Math.min(1, dt * 12);
      v.yawRate = dt > 0 ? wrap(v.yaw - prevYaw) / dt : 0;
      v.pitch += (clamp(v.pitchT, -0.4, 0.4) - v.pitch) * Math.min(1, dt * 8);
      v.roll = v.K.two ? clamp(-v.yawRate * v.v * 0.03, -0.35, 0.35) : 0;
      v.d = Math.hypot(v.x - px, v.z - pz);
    }
    pushPlayer(player);
    updateRiders(dt);
    render(px, pz);

    const ms = performance.now() - tStart;
    perf.ms += ms; perf.n++;
    if (ms > perf.max) perf.max = ms;
    if (perf.n >= 60) { perf.avg = perf.ms / perf.n; perf.ms = 0; perf.n = 0; perf.lastMax = perf.max; perf.max = 0; }
  }

  function stats() {
    const byKind = {};
    for (const v of vehicles) byKind[v.kind] = (byKind[v.kind] || 0) + 1;
    return {
      moving: vehicles.length, desired, byKind, lod: { near: lodCount[0], mid: lodCount[1], far: lodCount[2] },
      riders: vehicles.filter((v) => v.rider).length, avatarsBuilt: riderCount,
      drawCalls: fleet.drawCalls() + (parked ? parked.stats().drawCalls : 0),
      updateMs: +perf.avg.toFixed(3), updateMaxMs: +(perf.lastMax || 0).toFixed(2),
      signals: plan ? { sites: plan.sites.length, playerRedRuns: redRuns, atRed: vehicles.filter((v) => v.why === 'signal').length, ...sigStats } : null,
      spawned, despawned, bumps, waitingAtJunction: vehicles.filter((v) => v.wait > 0).length,
      busesDwelling: vehicles.filter((v) => v.dwell > 0).length,
      network: { edges: net.edges.length, nodes: net.nodes.length, stops: net.edges.reduce((a, e) => a + e.stops.length, 0), crossings: net.edges.reduce((a, e) => a + e.crossings.length, 0), restrictedRoads: net.restrictedRoads || 0, zoneCheck: !!inZone, buildMs: Math.round(tNet) },
      parked: parked ? parked.stats() : null,
      buildMs: Math.round(buildMs),
    };
  }

  // Oriented boxes of the moving vehicles near (x, z): for other systems (crowd, quests) that want
  // to keep clear of traffic. { x, y, z, yaw, hw, hl, h }
  function colliders(x = 0, z = 0, r = 80) {
    const out = [];
    for (const v of vehicles) if (!v.hidden && Math.hypot(v.x - x, v.z - z) < r) out.push({ x: v.x, y: v.y, z: v.z, yaw: v.yaw, hw: v.K.W / 2, hl: v.K.L / 2, h: v.K.H });
    return out;
  }

  const buildMs = performance.now() - t0;
  // onRedRun: set by a quest that wants to penalise running a red ({ site, arm, t }); null in free play.
  const api = { update, stats, vehicles, colliders, parked, net, fleet, onRedRun: null };
  return api;
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
