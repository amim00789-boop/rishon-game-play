// Parked cars: a share of the painted stalls in parking lots (src/world/parking.js, optional) plus
// street-side parking along urban kerbs that have a sidewalk. Static instances in three LODs,
// re-binned around the player when they move; each car is also a solid box for the player.
//
// Street-side rules (OSM has no parking:lane tags in our extract, so the kerb is inferred):
// residential / living / unclassified / tertiary (and some secondary) streets, only on a side that
// has a sidewalk, only if the moving lanes keep at least a car's width (narrow one-ways park one
// side only), never on bridges, never in a junction mouth, on a zebra, at a bus stop or across a
// driveway. Parking is decided per street so a street keeps the same layout end to end, and the
// traffic lanes on that street shift over to clear the parked row (edge.parkR / edge.parkL).
import * as THREE from 'three';
import { KINDS, pickPaint, createFleet } from './models.js';
import { PARK_RESERVE, MOVING_W, ground } from './network.js';
import { SCALE, project } from '../geo.js';

const NEAR_R = 90, MID_R = 330, FAR_R = 650;
const REBIN_MOVE = 30;
const CELL = 100;
const STREET_KINDS = { residential: 1, living_street: 0.8, unclassified: 0.9, tertiary: 0.95, secondary: 0.85 };
// How full a parked row is, by street class: quiet residential streets have the most gaps,
// busy shopping streets (Rothschild is tertiary/secondary) stay fuller (founder, round 3: a third fewer cars).
// (x0.81 after the 0.85 vehicle scale, so shorter cars do not raise the count: same ~34.6k total.)
const STREET_FILL = { residential: 0.34, living_street: 0.34, unclassified: 0.38, tertiary: 0.69, secondary: 0.81 };
// Never park beside these. OSM parking:lane / parking:both tags could allow exceptions, but our
// extract carries none, so there are no exceptions (founder, round 3).
const NO_PARK = /^(motorway|trunk|primary)(_link)?$/;
// No kerbside parking (street rows or kerb stalls) around these spots: the old centre by the Rothschild mall is
// already tight for cars and people (founder, 2026-10-19). Lots are not affected.
const NO_PARK_ZONES = [{ ...project(31.96349, 34.80147), r: 260 * SCALE }]; // Rothschild mall, OSM shop=mall
const inNoParkZone = (x, z) => NO_PARK_ZONES.some((q) => Math.hypot(x - q.x, z - q.z) < q.r);
const CLEAR = 15 * SCALE; // keep 15 m from junction mouths and zebras
const SW_HALF = 2.35; // city.js sidewalk strip half width (U(2.8) / 2: SCALE 1.2 x WIDEN 1.4)

const PARK_MIX = [['hatch', 30], ['sedan', 26], ['suv', 24], ['van', 9], ['taxi', 2]];

function pickWeighted(list, rnd) {
  let total = 0;
  for (const [, w] of list) total += w;
  let r = rnd() * total;
  for (const [k, w] of list) { r -= w; if (r <= 0) return k; }
  return list[0][0];
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function buildParked({ scene, city, lots = [], collision = null, net, rnd = Math.random, restrictedAt = null }) {
  const cars = [];
  let zoneSkipped = 0, underDeck = 0, onRoadSkipped = 0;
  // Topmost walkable surface at (x, z) (city.heightAt with a mover far above), checked only where a
  // footbridge (city.footbridges) passes over the spot.
  const deckAbove = city && typeof city.heightAt === 'function' ? (x, z) => city.heightAt(x, z, 1e6) : null;
  const fbSegs = [], fbGrid = new Map();
  for (const f of (city && city.footbridges) || []) {
    const P = f.points || [], hw = (f.width || 3) / 2;
    for (let i = 0; i < P.length - 1; i++) {
      const sg = [P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], hw];
      fbSegs.push(sg);
      for (let ix = Math.floor((Math.min(sg[0], sg[2]) - 8) / 20); ix <= Math.floor((Math.max(sg[0], sg[2]) + 8) / 20); ix++) {
        for (let iz = Math.floor((Math.min(sg[1], sg[3]) - 8) / 20); iz <= Math.floor((Math.max(sg[1], sg[3]) + 8) / 20); iz++) {
          const k = ix * 100003 + iz;
          let l = fbGrid.get(k);
          if (!l) { l = []; fbGrid.set(k, l); }
          l.push(sg);
        }
      }
    }
  }
  const nearFootbridge = (x, z, pad) => {
    const l = fbGrid.get(Math.floor(x / 20) * 100003 + Math.floor(z / 20));
    if (l) for (const sg of l) {
      const dx = sg[2] - sg[0], dz = sg[3] - sg[1], l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - sg[0]) * dx + (z - sg[1]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - sg[0] - dx * t, z - sg[1] - dz * t) < sg[4] + pad) return true;
    }
    return false;
  };
  const t0 = performance.now();

  // ---- street-side ----
  const swGrid = new Map();
  const swKey = (ix, iz) => ix * 100003 + iz;
  for (const sw of city.sidewalks || []) {
    if (sw.roadKind === 'promenade') continue;
    const p = sw.points;
    for (let i = 0; i < p.length - 1; i++) {
      const seg = [p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]];
      for (let ix = Math.floor(Math.min(seg[0], seg[2]) / 20); ix <= Math.floor(Math.max(seg[0], seg[2]) / 20); ix++) {
        for (let iz = Math.floor(Math.min(seg[1], seg[3]) / 20); iz <= Math.floor(Math.max(seg[1], seg[3]) / 20); iz++) {
          const k = swKey(ix, iz);
          let l = swGrid.get(k);
          if (!l) { l = []; swGrid.set(k, l); }
          l.push(seg);
        }
      }
    }
  }
  const nearSidewalk = (x, z, r) => {
    const l = swGrid.get(swKey(Math.floor(x / 20), Math.floor(z / 20)));
    if (!l) return false;
    for (const s of l) {
      const dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - s[0]) * dx + (z - s[1]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - s[0] - dx * t, z - s[1] - dz * t) < r) return true;
    }
    return false;
  };
  // Driveways: ends of service roads that touch a street.
  const drive = new Map();
  for (const r of city.roads || []) {
    if (r.kind !== 'service' || r.restricted || !r.points || r.points.length < 2) continue;
    for (const p of [r.points[0], r.points[r.points.length - 1]]) {
      const k = swKey(Math.floor(p[0] / 20), Math.floor(p[1] / 20));
      let l = drive.get(k);
      if (!l) { l = []; drive.set(k, l); }
      l.push(p);
    }
  }
  const nearDriveway = (x, z, r) => {
    for (let ix = Math.floor((x - r) / 20); ix <= Math.floor((x + r) / 20); ix++) {
      for (let iz = Math.floor((z - r) / 20); iz <= Math.floor((z + r) / 20); iz++) {
        const l = drive.get(swKey(ix, iz));
        if (l) for (const p of l) if (Math.hypot(p[0] - x, p[1] - z) < r) return true;
      }
    }
    return false;
  };

  // On or right beside a no-parking carriageway (motorway, trunk, primary and their links)?
  // Highways also keep a 12 m band clear beyond the carriageway edge, so a parallel street right
  // beside one never reads as cars parked on the highway shoulder.
  function forbidden(x, z, halfW) {
    const hw = net.nearest(x, z, 60, (e) => /^(motorway|trunk)/.test(e.kind));
    if (hw && hw.d < hw.e.hw + halfW + 12 * SCALE) return true;
    const pr = net.nearest(x, z, 40, (e) => /^primary/.test(e.kind));
    return !!pr && pr.d < pr.e.hw + halfW + 4;
  }
  // Kerbside spot check against every road around it, not only the street it belongs to: no bridge,
  // ramp or link carriageway under or beside the car, no junction mouth or zebra within 15 m.
  const jGrid = new Map(), zGrid = new Map();
  const put = (g, x, z, item) => { const k = swKey(Math.floor(x / 40), Math.floor(z / 40)); let l = g.get(k); if (!l) { l = []; g.set(k, l); } l.push(item); };
  const around = (g, x, z, r, fn) => {
    for (let ix = Math.floor((x - r) / 40); ix <= Math.floor((x + r) / 40); ix++) {
      for (let iz = Math.floor((z - r) / 40); iz <= Math.floor((z + r) / 40); iz++) {
        const l = g.get(swKey(ix, iz));
        if (l) for (const it of l) if (fn(it)) return true;
      }
    }
    return false;
  };
  for (const n of net.nodes) if (n.deg >= 3) put(jGrid, n.x, n.z, n);
  for (const e of net.edges) for (const c of e.crossings) put(zGrid, c.x, c.z, c);
  function kerbOk(x, z, halfL, halfW = 1.7) {
    if (around(jGrid, x, z, 80, (n) => Math.hypot(n.x - x, n.z - z) - halfL < n.maxHw + CLEAR)) return false;
    if (around(zGrid, x, z, CLEAR + halfL, (c) => Math.hypot(c.x - x, c.z - z) - halfL < CLEAR)) return false;
    let bad = false;
    net.grid.near(x, z, 30, ({ e, i }) => {
      if (bad || !(e.raised || e.road.bridge || e.link || e.tunnel || NO_PARK.test(e.kind))) return;
      const a = e.pts[i], b = e.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < e.hw + halfW + (e.link ? 5 : 1)) bad = true;
    });
    return !bad;
  }

  // Group edges by street (city road entry) so a street keeps one layout.
  const byRoad = new Map();
  for (const e of net.edges) {
    const w = STREET_KINDS[e.kind];
    if (!w || e.raised || e.tunnel || e.link || e.road.bridge || e.road.layer) continue;
    if (!byRoad.has(e.road)) byRoad.set(e.road, []);
    byRoad.get(e.road).push(e);
  }
  // Lot stalls: street-side lots from parking.js already hold a kerb, so that kerb is reserved
  // for them (the moving lanes shift over) and no extra row is placed next to a stall.
  const stallGrid = new Map();
  const lotSide = new Map();

  // Ramps and garage ways: every road (service ways included) that is a bridge, has a layer or a
  // tunnel, or rises above the ground; garage ramps from parking.js; and service ways that lead
  // into a multi-storey or underground entrance. No car is ever placed on one of them.
  const rampGrid = new Map();
  const addRampSeg = (a, b, hw) => {
    const seg = [a[0], a[1], b[0], b[1], hw];
    for (let ix = Math.floor((Math.min(a[0], b[0]) - hw) / 20); ix <= Math.floor((Math.max(a[0], b[0]) + hw) / 20); ix++) {
      for (let iz = Math.floor((Math.min(a[1], b[1]) - hw) / 20); iz <= Math.floor((Math.max(a[1], b[1]) + hw) / 20); iz++) {
        const k = swKey(ix, iz);
        let l = rampGrid.get(k);
        if (!l) { l = []; rampGrid.set(k, l); }
        l.push(seg);
      }
    }
  };
  const garageMouths = [];
  for (const lot of lots || []) {
    if (!lot || (lot.kind !== 'multi-storey' && lot.kind !== 'underground')) continue;
    if (lot.entrance) garageMouths.push(lot.entrance);
    if (lot.ramp) { garageMouths.push(lot.ramp.from, lot.ramp.to); addRampSeg(lot.ramp.from, lot.ramp.to, 6); }
  }
  let rampRoads = 0;
  for (const r of city.roads || []) {
    if (r.rank == null || !r.points || r.points.length < 2) continue;
    const raised = r.bridge || r.layer || r.tunnel || (r.heights && r.heights.some((y) => y > 0.05));
    const ends = [r.points[0], r.points[r.points.length - 1]];
    const garageWay = r.kind === 'service' && garageMouths.some((m) => ends.some((p) => Math.hypot(p[0] - m[0], p[1] - m[1]) < 20));
    if (!raised && !garageWay) continue;
    rampRoads++;
    for (let i = 0; i < r.points.length - 1; i++) addRampSeg(r.points[i], r.points[i + 1], r.width / 2);
  }
  function onRamp(x, z, halfW) {
    const l = rampGrid.get(swKey(Math.floor(x / 20), Math.floor(z / 20)));
    if (!l) return false;
    for (const sg of l) {
      const dx = sg[2] - sg[0], dz = sg[3] - sg[1], l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - sg[0]) * dx + (z - sg[1]) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - sg[0] - dx * t, z - sg[1] - dz * t) < sg[4] + halfW + 1) return true;
    }
    return false;
  }
  for (const lot of lots || []) {
    for (const st of (lot && lot.stalls) || []) {
      const k = swKey(Math.floor(st.x / 20), Math.floor(st.z / 20));
      let l = stallGrid.get(k);
      if (!l) { l = []; stallGrid.set(k, l); }
      l.push(st);
      if (lot.kind !== 'street_side') continue;
      const hit = net.nearest(st.x, st.z, 30, (e) => !!STREET_KINDS[e.kind] || e.rank <= 6);
      if (hit && hit.d < hit.e.hw + 3) lotSide.set(hit.e.road, (lotSide.get(hit.e.road) || 0) | (hit.side > 0 ? 1 : 2));
    }
  }
  for (const e of net.edges) {
    const m = lotSide.get(e.road) || 0;
    if (m & 1) e.parkR = PARK_RESERVE;
    if (m & 2) e.parkL = PARK_RESERVE;
  }
  const nearStall = (x, z, r) => {
    for (let ix = Math.floor((x - r) / 20); ix <= Math.floor((x + r) / 20); ix++) {
      for (let iz = Math.floor((z - r) / 20); iz <= Math.floor((z + r) / 20); iz++) {
        const l = stallGrid.get(swKey(ix, iz));
        if (l) for (const st of l) if (Math.hypot(st.x - x, st.z - z) < r) return true;
      }
    }
    return false;
  };
  const tmp = { x: 0, z: 0 };
  let streets = 0;
  for (const [road, list] of byRoad) {
    const r0 = hashStr(`${road.name || ''}|${road.points[0][0].toFixed(1)}|${road.points[0][1].toFixed(1)}`);
    const rr = mulberry(r0);
    if (rr() > STREET_KINDS[road.kind]) continue;
    // Which kerbs have a sidewalk along most of the street?
    const hits = { 1: 0, '-1': 0 };
    let probes = 0;
    for (const e of list) {
      const n = Math.max(1, Math.min(4, Math.floor(e.L / 15)));
      for (let k = 0; k < n; k++) {
        const s = ((k + 0.5) / n) * e.L;
        probes++;
        for (const side of [1, -1]) {
          net.pointAt(e, s, side * (e.hw + SW_HALF), tmp);
          if (nearSidewalk(tmp.x, tmp.z, 1.6)) hits[side]++;
        }
      }
    }
    if (!probes) continue;
    const lm = lotSide.get(road) || 0;
    const okR = hits[1] >= probes * 0.5 && !(lm & 1), okL = hits[-1] >= probes * 0.5 && !(lm & 2);
    const e0 = list[0];
    // Width check: the moving lanes must keep MOVING_W each.
    const fits = (pr, pl) => {
      pr = pr || !!(lm & 1); pl = pl || !!(lm & 2);
      if (e0.oneway) return 2 * e0.hw - (pr ? PARK_RESERVE : 0.3) - (pl ? PARK_RESERVE : 0.3) >= e0.lanes * MOVING_W;
      const inner = e0.median ? e0.median / 2 + 0.3 : 0.08, n = Math.max(1, Math.floor(e0.lanes / 2));
      return (!pr || e0.hw - PARK_RESERVE - inner >= n * MOVING_W) && (!pl || e0.hw - PARK_RESERVE - inner >= n * MOVING_W);
    };
    const roll = rr();
    let pr = false, pl = false;
    if (e0.oneway) {
      if (roll < 0.6) pr = okR; else pl = okL;
      if (!pr && !pl) { pr = okR && roll < 0.8; pl = !pr && okL && roll < 0.8; }
      if (fits(true, true) && okR && okL && rr() < 0.5) pr = pl = true;
    } else {
      if (roll < 0.45) { pr = okR; pl = okL; } else if (roll < 0.7) pr = okR; else if (roll < 0.92) pl = okL;
    }
    if (pr && pl && !fits(true, true)) { if (rr() < 0.5) pl = false; else pr = false; }
    if (pr && !fits(true, false)) pr = false;
    if (pl && !fits(false, true)) pl = false;
    if (!pr && !pl) continue;
    streets++;
    const fill = (0.6 + rr() * 0.25) * (STREET_FILL[road.kind] || 0.6);
    for (const e of list) {
      if (pr) e.parkR = PARK_RESERVE;
      if (pl) e.parkL = PARK_RESERVE;
      for (const side of [1, -1]) {
        if ((side > 0 && !pr) || (side < 0 && !pl)) continue;
        placeRow(e, side, fill, rr);
      }
    }
  }

  // city.js paints a red-and-white (no stopping) kerb for 16 units after each junction mouth.
  function clearAt(node) {
    if (node.deg >= 3) return node.maxHw + Math.max(26, CLEAR);
    if (node.deg === 1) return 3;
    return 1;
  }
  function placeRow(e, side, fill, rr) {
    const start = clearAt(e.a), end = e.L - clearAt(e.b);
    let s = start + rr() * 2;
    while (s < end) {
      const kind = pickWeighted(PARK_MIX, rr);
      const K = KINDS[kind];
      const len = K.L;
      const mid = s + len / 2;
      if (mid + len / 2 > end) break;
      const blocked = e.crossings.some((c) => Math.abs(c.s - mid) < len / 2 + CLEAR)
        || e.stops.some((b) => (e.oneway || b.dir === side) && Math.abs(b.s - mid) < len / 2 + 12);
      if (!blocked && rr() < fill) {
        const off = side * (e.hw - 0.12 - K.W / 2);
        net.pointAt(e, mid, off, tmp);
        if (!nearDriveway(tmp.x, tmp.z, e.hw + 3.5) && !forbidden(tmp.x, tmp.z, K.W / 2) && kerbOk(tmp.x, tmp.z, len / 2, K.W / 2) && !onRamp(tmp.x, tmp.z, K.W / 2) && !nearStall(tmp.x, tmp.z, len / 2 + 3) && !nearSidewalk(tmp.x, tmp.z, SW_HALF + K.W / 2 - 0.2)) {
          // Two-way streets: each kerb faces its own traffic; one-ways all face along the street.
          const flip = !e.oneway && side < 0;
          const yaw = Math.atan2(flip ? -tmp.dx : tmp.dx, flip ? -tmp.dz : tmp.dz) + (rr() - 0.5) * 0.04;
          addCar(kind, tmp.x, tmp.z, yaw, 1, rr, 'street');
        }
      }
      s += len + 0.8 + rr() * 1.6 + (rr() < 0.08 ? len : 0);
    }
  }

  // ---- lots ----
  let lotCars = 0, stallsSeen = 0, rejected = 0;
  for (const lot of lots || []) {
    if (!lot || !lot.stalls || lot.kind === 'underground') continue;
    const lr = mulberry(hashStr(String(lot.id ?? lot.stalls.length)));
    // Big lots (malls, cinemas, stations) stay busy; small neighbourhood lots are half empty.
    const big = lot.stalls.length >= 80;
    const fill = big ? 0.62 + lr() * 0.2 : 0.38 + lr() * 0.2;
    const kerb = lot.kind === 'street_side';
    for (const st of lot.stalls) {
      stallsSeen++;
      if (lr() > fill) continue;
      // Same rules for every stall: nothing on or beside a highway / primary carriageway, and
      // kerbside stalls also keep clear of bridges, junction mouths and zebras.
      if (forbidden(st.x, st.z, (st.w || 3) / 2) || onRamp(st.x, st.z, (st.w || 3) / 2) || (kerb && !kerbOk(st.x, st.z, (st.l || 6) / 2, (st.w || 3) / 2))) { rejected++; continue; }
      let kind = pickWeighted(PARK_MIX, lr);
      const fit = (k) => Math.min(1, ((st.l || 6) - 0.3) / KINDS[k].L, ((st.w || 3) - 0.2) / KINDS[k].W);
      if (fit(kind) < 0.8) kind = 'hatch';
      const sc = Math.max(0.72, fit(kind));
      const jit = (lr() - 0.5) * 0.3;
      const x = st.x + Math.sin(st.angle) * jit, z = st.z + Math.cos(st.angle) * jit;
      if (addCar(kind, x, z, st.angle + (lr() - 0.5) * 0.05, sc, lr, kerb ? 'kerb-lot' : 'lot', st.y) !== false) lotCars++;
    }
  }

  function addCar(kind, x, z, yaw, scale, r, src, yAbs) {
    const K = KINDS[kind];
    const sx = Math.sin(yaw), cz = Math.cos(yaw);
    const half = (K.L * scale) / 2;
    if (src !== 'lot' && inNoParkZone(x, z)) { zoneSkipped++; return false; }
    // an OSM lot drawn over the street (a mapping slip) must not leave a car standing in a lane
    if (src === 'lot' && city && city.onCarriage && city.onCarriage(x, z, 0)) { onRoadSkipped++; return false; }
    // nothing parks inside a sealed zone (src/world/details.js), not even a lot or kerb behind its fence
    if (restrictedAt && (restrictedAt(x, z) || restrictedAt(x + sx * half, z + cz * half) || restrictedAt(x - sx * half, z - cz * half))) { zoneSkipped++; return false; }
    const yc = yAbs ?? ground(x, z) + 0.2;
    // nor under a footbridge low enough to cut through the roof, nor on its ramp foot
    if (deckAbove && fbSegs.length) {
      const top = yc + K.H * scale + 1, pad = (K.W * scale) / 2 + 0.5;
      for (const [qx, qz] of [[x, z], [x + sx * half, z + cz * half], [x - sx * half, z - cz * half]]) {
        if (nearFootbridge(qx, qz, pad) && deckAbove(qx, qz) < top) { underDeck++; return false; }
      }
    }
    const yf = yAbs ?? ground(x + sx * half, z + cz * half);
    const yb = yAbs ?? ground(x - sx * half, z - cz * half);
    const pitch = Math.max(-0.25, Math.min(0.25, -Math.atan2(yf - yb, 2 * half)));
    const car = { kind, x, y: yc, z, yaw, pitch, scale, color: pickPaint(kind, r), src, m: null, mf: null };
    car.m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    car.m.scale(new THREE.Vector3(scale, scale, scale)).setPosition(x, yc, z);
    car.mf = car.m.clone().scale(new THREE.Vector3(K.W, K.H * 0.82, K.L));
    cars.push(car);
    // A car on a garage roof must not leave a ground-level wall under it (the 2D colliders have no height).
    if (collision && collision.addPolygon && yc - ground(x, z) < 1.5) {
      const hw = (K.W * scale) / 2 + 0.05, hl = half + 0.05;
      const rx = cz, rz = -sx; // local +x (left) in world
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [x + rx * a * hw + sx * b * hl, z + rz * a * hw + cz * b * hl]);
      // vertical extent, so someone on a footbridge or road deck above walks over the car
      const y0 = Math.min(yc, ground(x, z)), y1 = yc + K.H * scale;
      collision.addPolygon({ points: pts, height: K.H * scale, kind: 'car', y0, y1 });
      car.collider = true;
    }
  }

  // ---- audit: every kerbside car by the class of the road it stands beside, plus rule breaks ----
  function audit() {
    const byClass = {}, bad = { onNoParkRoad: 0, nearJunctionZebraBridgeOrRamp: 0 };
    let onRampAny = 0, elevatedColliders = 0;
    for (const c of cars) {
      if (onRamp(c.x, c.z, (KINDS[c.kind].W * c.scale) / 2 - 0.2)) onRampAny++;
      if (c.collider && c.y - ground(c.x, c.z) >= 1.5) elevatedColliders++;
    }
    for (const c of cars) {
      if (c.src === 'lot') continue;
      const K = KINDS[c.kind];
      const hit = net.nearest(c.x, c.z, 30);
      const cls = hit ? hit.e.kind : 'none';
      byClass[cls] = (byClass[cls] || 0) + 1;
      if (forbidden(c.x, c.z, (K.W * c.scale) / 2)) bad.onNoParkRoad++;
      if (!kerbOk(c.x, c.z, (K.L * c.scale) / 2 - 0.5, (K.W * c.scale) / 2 - 0.2)) bad.nearJunctionZebraBridgeOrRamp++;
    }
    return { byClass, ...bad, onRampOrGarageWayAllCars: onRampAny, elevatedColliders, rampRoads };
  }
  const auditResult = audit();

  // ---- spatial bins and rendering ----
  const bins = new Map();
  for (const c of cars) {
    const k = swKey(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
    let l = bins.get(k);
    if (!l) { l = []; bins.set(k, l); }
    l.push(c);
  }
  const kinds = PARK_MIX.map(([k]) => k);
  const fleet = createFleet(scene, kinds, { capacity: 1400, farCapacity: 7000, name: 'parked-cars' });
  let lastX = Infinity, lastZ = Infinity;
  const counts = { near: 0, mid: 0, far: 0 };

  function rebin(px, pz) {
    lastX = px; lastZ = pz;
    fleet.begin();
    counts.near = counts.mid = counts.far = 0;
    const r = Math.ceil(FAR_R / CELL);
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const l = bins.get(swKey(ix, iz));
        if (!l) continue;
        for (const c of l) {
          const d = Math.hypot(c.x - px, c.z - pz);
          if (d > FAR_R) continue;
          if (d < NEAR_R) { if (fleet.add(c.kind, 0, c.m, c.color)) counts.near++; }
          else if (d < MID_R) { if (fleet.add(c.kind, 1, c.m, c.color)) counts.mid++; }
          else if (fleet.add(c.kind, 2, c.mf, c.color)) counts.far++;
        }
      }
    }
    fleet.end();
  }

  const buildMs = Math.round(performance.now() - t0);
  return {
    cars,
    group: fleet.group,
    update(px, pz) {
      if (Math.hypot(px - lastX, pz - lastZ) > REBIN_MOVE) rebin(px, pz);
    },
    stats() {
      return { total: cars.length, street: cars.length - lotCars, lot: lotCars, stalls: stallsSeen, stallsRejected: rejected, zoneSkipped, onRoadSkipped, underDeck, streets, buildMs, ...counts, drawCalls: fleet.drawCalls(), kerbside: auditResult };
    },
  };
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
