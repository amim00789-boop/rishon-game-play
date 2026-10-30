// Bus driver (docs/JOBS.md 8.2). The player drives a city bus from the central bus station along a
// route of real stops (city.busStops) joined by the car road graph (gps.js): a loop of a few stops
// that ends back at the station. At each stop the bus has to stand still near the kerb; the doors
// open, waiting people walk to the door and board, and the bus leaves on schedule.
//
//   const r = await bus.start({ depot: {x,z}, stops: 4, minLeg: 170, maxLeg: 460, pace: 11, grace: 14, dwell: 4, speedLimit: 26 });
//   // r = { ok, score (0..100), summary, detail: { smooth, punct, stop, pax, ... }, reason?, quit? }
//
// It is a job game: no result card of its own (src/engine/minigames/jobs.js shows it). The player
// stays in 'car' mode; the car is hidden and a bus body drawn instead, and MODE_PARAMS.car is
// swapped for bus handling for the length of the run (restored on every exit path).
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, placePlayer, avatarFactory, clamp, toaster, beamMarker, groundY, surfaceFn, jumpToStart, countdown } from './common.js';
import { getSynth } from './synth.js';
import { getGps } from '../gps.js';
import { MODE_PARAMS } from '../vehicles.js';
import { buildPlayerBus } from '../../vehicles/models.js';

const CSS = `
.mg-bus .bs-hud { left: 50%; top: 12px; transform: translateX(-50%); width: 300px; }
.mg-bus .bs-row { display: flex; justify-content: space-between; gap: 10px; font-weight: 800; font-size: 13px; margin-top: 4px; }
.mg-bus .bs-next { font-weight: 900; font-size: 15px; }
.mg-bus .mg-bar { height: 12px; margin-top: 4px; }
.mg-bus .mg-bar > i { transition: width 0.25s, background 0.4s; }
.mg-bus .bs-doors { font-weight: 900; }
.mg-bus .bs-speed.over { color: #e8364f; }
`;
// Handling swapped into MODE_PARAMS.car while the job runs: slower, heavier, wide turns.
const BUS_PARAMS = { speed: 30, run: 30, accel: 11, brake: 26, turn: 1.55, radius: 2.6, reverse: 5 };
const WAITERS = ['savta', 'school_kid', 'office_worker', 'older_man', 'teen_phone', 'tourist', 'older_woman', 'secular_woman'];
const DEF = { stops: 4, minLeg: 170, maxLeg: 460, pace: 11, grace: 14, dwell: 4, speedLimit: 26, zone: 15,
  comfort: { start: 100, brake: -4, bump: -10, kerb: -5, offroad: -3, slow: -3, doors: -6, smooth: 0.8 } };

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createBus(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  const surface = surfaceFn(deps);
  addStyle('mg-style-bus', CSS);
  let S = null, last = null;

  // The kerb-side road point next to a stop: from the stop (on the pavement) toward the road, to the
  // first carriageway sample, then a lane's half width in.
  function curbOf(b) {
    const dx = Math.sin(b.angle), dz = Math.cos(b.angle);
    const onC = deps.city && deps.city.onCarriage;
    if (onC) for (let d = 1; d <= 18; d += 1) if (onC(b.x + dx * d, b.z + dz * d, 0)) return { x: b.x + dx * (d + 3), z: b.z + dz * (d + 3) };
    return { x: b.x + dx * 8, z: b.z + dz * 8 };
  }

  // Picks the stops and the road between them: a depth-first search over the nearest candidates,
  // turning the same way at every stop so the line closes into a loop on the station. A loop with the
  // wanted number of stops wins at once; otherwise the longest one found (at least two stops besides
  // the station) with the shortest total. Runs under the fade, so the street graph may build here.
  const BRANCH = 3, MAX_ROUTES = 160;
  function plan(cfg, gps) {
    const all = (deps.city && deps.city.busStops) || [];
    if (!all.length) return null;
    const depot = cfg.depot || { x: 0, z: 0 };
    let first = null, fd = Infinity;
    for (const b of all) { const d = Math.hypot(b.x - depot.x, b.z - depot.z); if (d < fd) { fd = d; first = b; } }
    const nameOf = (b) => (b.nameLocal || b.name || '').split('/')[0] || t('jobs.bus.stop');
    const mk = (b) => ({ b, at: curbOf(b), name: nameOf(b) });
    const s0 = firstName ? { ...mk(first), name: firstName } : mk(first);
    const cache = new Map();
    let routes = 0;
    // The car graph also links across medians and between props: a bus (wider than the car the graph
    // was drawn for) can only take a route whose points are clear, so a route with a blocked point is
    // refused (one blocked point is let through: a lamp the bus can brush past).
    const route = (a, b) => {
      const key = `${a.b.x | 0},${a.b.z | 0}>${b.b.x | 0},${b.b.z | 0}`;
      if (cache.has(key)) return cache.get(key);
      routes++;
      const r = gps.route(a.at, b.at, { mode: 'car' });
      if (r.ok && deps.collision && deps.collision.isFree) {
        let n = 0;
        for (const p of r.points) if (!deps.collision.isFree(p.x, p.z, 2.2)) n++;
        if (n > 1) r.ok = false;
      }
      cache.set(key, r);
      return r;
    };
    let best = null;
    const consider = (stops, legs, cur) => {
      const home = route(cur, s0);
      if (!home.ok) return false;
      const all2 = [...legs, { from: cur, to: s0, r: home, terminus: true }];
      const total = all2.reduce((n, l) => n + l.r.length, 0);
      if (!best || stops.length > best.stops.length || (stops.length === best.stops.length && total < best.total)) best = { stops: stops.slice(), legs: all2, total };
      return true;
    };
    for (const sign of [1, -1]) {
      const turn = sign * (Math.PI * 2) / (cfg.stops + 1);
      const extend = (stops, legs, prevDir) => {
        if (routes > MAX_ROUTES) return;
        const cur = stops[stops.length - 1], i = stops.length - 1;
        if (i >= cfg.stops) return;
        const cands = [];
        for (const b of all) {
          if (b === cur.b) continue;
          const d = Math.hypot(b.x - cur.b.x, b.z - cur.b.z);
          if (d < cfg.minLeg * 0.7 || d > cfg.maxLeg) continue;
          if (stops.some((q) => Math.hypot(q.b.x - b.x, q.b.z - b.z) < 70 || nameOf(q.b) === nameOf(b))) continue;
          // stay within reach of the way home: the loop has to close on the station
          if (Math.hypot(b.x - s0.b.x, b.z - s0.b.z) > (cfg.stops - i) * cfg.maxLeg) continue;
          const dir = Math.atan2(b.x - cur.b.x, b.z - cur.b.z);
          const dTurn = prevDir === null ? 0 : Math.abs(wrap(dir - prevDir - turn));
          cands.push({ b, dir, score: dTurn + Math.abs(d - (cfg.minLeg + cfg.maxLeg) / 2) / cfg.maxLeg });
        }
        cands.sort((a, b2) => a.score - b2.score);
        let tried = 0;
        for (const c of cands) {
          if (tried >= BRANCH || routes > MAX_ROUTES) break;
          const q = mk(c.b), r = route(cur, q);
          if (!r.ok || r.length < cfg.minLeg * 0.8 || r.length > cfg.maxLeg * 1.6) continue;
          tried++;
          const stops2 = [...stops, q], legs2 = [...legs, { from: cur, to: q, r }];
          if (stops2.length >= 3) consider(stops2, legs2, q);
          if (best && best.stops.length > cfg.stops) return;
          extend(stops2, legs2, c.dir);
          if (best && best.stops.length > cfg.stops) return;
        }
      };
      extend([s0], [], null);
      if (best && best.stops.length > cfg.stops) break;
    }
    (plan.diag || (plan.diag = [])).push(`routes ${routes}, stops ${best ? best.stops.length - 1 : 0}`);
    if (!best) return null;
    // Timetable: due = when the bus should arrive at a stop, depart = when it may leave.
    let clock = 0;
    for (const l of best.legs) {
      l.len = l.r.length;
      l.points = l.r.points;
      l.due = clock + l.len / cfg.pace;
      clock = l.due + (l.terminus ? 0 : cfg.dwell);
      l.depart = clock;
    }
    return best;
  }

  // A fixed line (data/jobs/line5.json): the bus starts at the job's own stop and opens its doors at
  // the stops marked serve. The line's other stops are pass-through waypoints that keep it on the
  // line's streets, but only while they cost little: one that adds more than DETOUR to the leg is
  // dropped, because OSM often maps a stop on one kerb only and reaching it from the other
  // carriageway means a U-turn loop. Names resolve against city.busStops; when a name exists on both
  // kerbs, the one the road reaches more directly wins.
  const DETOUR = 1.3;
  async function loadLine(url) {
    try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch (e) { console.warn('[bus] line load failed', e); return null; }
  }
  const SHIFT_KEY = 'rishon.jobs.bus.shift';
  // Shifts alternate after a finished run; a retry after a failed one keeps the same shift.
  function shiftIndex(line) {
    try { return (parseInt(localStorage.getItem(SHIFT_KEY) || '0', 10) || 0) % line.shifts.length; } catch (_) { return 0; }
  }
  function advanceShift(n) {
    try { localStorage.setItem(SHIFT_KEY, String(((parseInt(localStorage.getItem(SHIFT_KEY) || '0', 10) || 0) + 1) % n)); } catch (_) { /* storage blocked */ }
  }
  function planLine(cfg, gps, shift) {
    const all = (deps.city && deps.city.busStops) || [];
    if (!all.length) return null;
    const byName = new Map();
    for (const b of all) { const k = b.nameLocal || b.name; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(b); }
    const nameOf = (b) => b.nameLocal || b.name || t('jobs.bus.stop');
    const mk = (b) => ({ b, at: curbOf(b), name: nameOf(b) });
    const depot = shift.fromDepot === false ? null : cfg.depot || null;
    let first = null, firstName = null;
    if (depot) { let fd = Infinity; for (const b of all) { const d = Math.hypot(b.x - depot.x, b.z - depot.z); if (d < fd) { fd = d; first = b; } } }
    const cache = new Map();
    const route = (a, b2) => {
      const key = `${a.at.x | 0},${a.at.z | 0}>${b2.at.x | 0},${b2.at.z | 0}`;
      if (!cache.has(key)) cache.set(key, gps.route(a.at, b2.at, { mode: cfg.relaxed ? 'bus' : 'car' }));
      return cache.get(key);
    };
    // a line stop's candidates: the stops with its name plus any stop within NEAR of them (OSM often
    // names the two kerbs of one street differently, or maps only one); shown under the line's name
    const NEAR = 70;
    // relaxed: only stops on main roads (tertiary and up), so the line never turns into a neighbourhood
    const net = deps.traffic && deps.traffic.net;
    const mainRoad = (b) => {
      if (!cfg.relaxed || !net || !net.nearest) return true;
      const k = curbOf(b), h = net.nearest(k.x, k.z, 12, () => true);
      return !h || h.e.rank >= 5;
    };
    // relaxed: a stop mapped on one kerb only is also served from the far kerb (its mirror across
    // the carriageway), so the bus never loops through side streets to reach the "right" side
    const onC = deps.city && deps.city.onCarriage;
    const mirror = (b) => {
      if (!onC) return null;
      const dx = Math.sin(b.angle), dz = Math.cos(b.angle);
      let d1 = -1, d2 = -1;
      for (let d = 1; d <= 60; d += 1) {
        const on = onC(b.x + dx * d, b.z + dz * d, 0);
        if (d1 < 0 && on) d1 = d; else if (d1 >= 0 && !on) { d2 = d; break; }
      }
      if (d1 < 0 || d2 < 0 || d2 - d1 > 40) return null;
      return { ...b, x: b.x + dx * (d1 + d2), z: b.z + dz * (d1 + d2), angle: b.angle + Math.PI, mirrorOf: b };
    };
    const cands = (st) => {
      const named = byName.get(st.stop) || [];
      const set = new Set(named);
      for (const n of named) for (const b of all) if (Math.hypot(b.x - n.x, b.z - n.z) < NEAR) set.add(b);
      const list = [...set].filter((b) => b !== first && mainRoad(b));
      if (cfg.relaxed) for (const b of [...list]) { const m = mirror(b); if (m && mainRoad(m)) list.push(m); }
      return list.map((b) => ({ ...mk(b), name: st.stop }));
    };
    const wps = shift.stops.map((st) => ({ st, c: cands(st) })).filter((w) => w.c.length);
    let startCands = null;
    if (!first) { const w0 = wps.shift(); if (!w0) return null; first = w0.c[0].b; firstName = w0.st.stop; startCands = w0.c.map((c) => c.b); }
    // the station has several kerbs; start from the one with the most direct road onto the line
    // (a kerb on a one-way terminal lane can force a loop of a kilometre or more)
    const firstServe = wps.find((w) => w.st.serve) || wps[wps.length - 1];
    // relaxed: the start may be either kerb of the first stop, whichever leads onto the line directly
    if (!depot && startCands && cfg.relaxed && firstServe) {
      const pool = [...startCands];
      for (const b of startCands) { const m = mirror(b); if (m) pool.push(m); }
      let bestC = null, bestCost = Infinity;
      for (const b of pool) {
        const c0 = mk(b);
        for (const c of firstServe.c) { const r = route(c0, c); if (r.ok && r.length < bestCost) { bestCost = r.length; bestC = b; } }
      }
      if (bestC) first = bestC;
    }
    if (depot && firstServe) {
      let bestC = null, bestCost = Infinity;
      for (const b of all) {
        const dd = Math.hypot(b.x - depot.x, b.z - depot.z);
        if (dd > 150) continue;
        const c0 = mk(b);
        for (const c of firstServe.c) {
          const r = route(c0, c);
          if (r.ok && r.length + dd < bestCost) { bestCost = r.length + dd; bestC = b; }
        }
      }
      if (bestC) first = bestC;
    }
    const s0 = firstName ? { ...mk(first), name: firstName } : mk(first);
    const stops = [s0], legs = [];
    let from = s0, i = 0, dropped = 0;
    while (i < wps.length) {
      let j = i;
      while (j < wps.length - 1 && !wps[j].st.serve) j++;
      // the served stop: the kerb the road reaches most directly from where the leg starts
      let S = null, base = null;
      for (const c of wps[j].c) { const r = route(from, c); if (r.ok && (!base || r.length < base.length)) { S = c; base = r; } }
      // a served stop the road only reaches by a long loop (a U-turn the graph lacks) is passed by,
      // and the doors open at the next one instead (the last stop always stays)
      const straight = S ? Math.hypot(S.at.x - from.at.x, S.at.z - from.at.z) : 0;
      if (S && j < wps.length - 1 && base.length > (cfg.relaxed ? straight * 1.8 + 150 : straight * 2.5 + 300)) S = null;
      if (!S) { i = j + 1; dropped++; continue; }
      let cur = from, pts = [], len = 0;
      for (let k = i; k < j; k++) {
        let pick = null, r1 = null, cost = Infinity;
        for (const c of wps[k].c) {
          const a1 = route(cur, c), a2 = route(c, S);
          if (a1.ok && a2.ok && a1.length + a2.length < cost) { pick = c; r1 = a1; cost = a1.length + a2.length; }
        }
        if (!pick || len + cost > base.length * (cfg.relaxed ? 1.12 : DETOUR)) { dropped++; continue; }
        pts = pts.concat(pts.length ? r1.points.slice(1) : r1.points);
        len += r1.length;
        cur = pick;
      }
      const rl = cur === from ? base : route(cur, S);
      pts = pts.concat(pts.length ? rl.points.slice(1) : rl.points);
      len += rl.length;
      const terminus = j === wps.length - 1;
      legs.push({ from, to: S, r: { ok: true, points: pts, length: len }, terminus });
      stops.push(S);
      from = S;
      i = j + 1;
    }
    if (!legs.length) return null;
    legs[legs.length - 1].terminus = true;
    // The car graph runs close to the kerb, where parked cars stand: a point the bus does not fit
    // through moves sideways, left (toward the middle of the road) first, to the nearest free spot.
    const C = deps.collision;
    if (C && C.isFree) for (const l of legs) {
      const P = l.r.points;
      for (let k = 0; k < P.length; k++) {
        if (C.isFree(P[k].x, P[k].z, 2.2)) continue;
        const a = P[Math.max(0, k - 1)], b2 = P[Math.min(P.length - 1, k + 1)];
        const dx = b2.x - a.x, dz = b2.z - a.z, n = Math.hypot(dx, dz) || 1;
        const lx = dz / n, lz = -dx / n; // left of travel: x east, z south
        for (let off = 1; off <= 8; off += 1) {
          const x = P[k].x + lx * off, z = P[k].z + lz * off;
          if (C.isFree(x, z, 2.2)) { P[k] = { x, z }; break; }
          const x2 = P[k].x - lx * off, z2 = P[k].z - lz * off; // the car may stand on the other side
          if (C.isFree(x2, z2, 2.2)) { P[k] = { x: x2, z: z2 }; break; }
        }
      }
    }
    (plan.diag || (plan.diag = [])).push(`line ${shift.id}: ${wps.length} waypoints, ${dropped} dropped, ${legs.length} legs, ${Math.round(legs.reduce((n, l) => n + l.r.length, 0))} long`);
    let clock = 0;
    for (const l of legs) {
      l.len = l.r.length;
      l.points = l.r.points;
      l.due = clock + l.len / cfg.pace;
      clock = l.due + (l.terminus ? 0 : cfg.dwell);
      l.depart = clock;
    }
    return { stops, legs, total: legs.reduce((n, l) => n + l.len, 0), shift };
  }

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const cfg = { ...DEF, ...config, comfort: { ...DEF.comfort, ...(config.comfort || {}) } };
      const ov = createOverlay('mg-bus',
        '<div class="mg-panel bs-hud"><div class="mg-title bs-title"></div><div class="bs-next"></div>' +
        '<div class="bs-row"><span class="bs-dist mg-num"></span><span class="bs-speed mg-num"></span></div>' +
        '<div class="mg-bar"><i></i></div><div class="bs-row"><span class="bs-aboard mg-num"></span><span class="bs-time"></span></div>' +
        '<div class="bs-row"><span class="bs-doors"></span><span class="bs-note"></span></div></div>');
      ov.$('.bs-title').textContent = t('jobs.bus.title');
      const root = new THREE.Group();
      root.name = 'mg-bus';
      deps.scene.add(root);
      const stopMark = beamMarker(0xffcb3d, 4, 50);
      stopMark.visible = false;
      root.add(stopMark);
      S = { cfg, ov, root, stopMark, resolve, gps: getGps(deps), toast: toaster(ov.root), phase: 'jump', tries: 0, prevMode: deps.player.mode,
        saved: { ...Object.fromEntries(Object.keys(BUS_PARAMS).map((k) => [k, MODE_PARAMS.car[k]])) },
        chase: deps.chase || (typeof window !== 'undefined' && window.__game && window.__game.chase) || null, vis: null };
      S.chaseDist = S.chase ? S.chase.wantDist : null;
      begin();
    });
  }

  async function begin() {
    const s = S, pl = deps.player;
    s.make = await avatarFactory(deps);
    if (S !== s) return;
    const line = s.cfg.line ? await loadLine(s.cfg.line) : null;
    if (S !== s) return;
    const shift = line && line.shifts && line.shifts.length ? line.shifts[shiftIndex(line)] : null;
    s.lineShifts = shift ? line.shifts.length : 0;
    const plan0 = (() => {
      try { return (shift && planLine(s.cfg, s.gps, shift)) || plan(s.cfg, s.gps); } catch (e) { console.warn('[bus] plan failed', e); return null; }
    })();
    if (!plan0) { finish({ ok: false, reason: 'noroute', tries: s.tries + 1 }); return; }
    s.plan = plan0;
    s.ov.$('.bs-title').textContent = plan0.shift ? t('jobs.bus.lineTitle', { ref: line.ref, to: plan0.shift.to }) : t('jobs.bus.title');
    const s0 = plan0.stops[0];
    const p0 = plan0.legs[0].points;
    const head = p0.length > 3 ? Math.atan2(p0[3].x - p0[0].x, p0[3].z - p0[0].z) : 0;
    s.phase = 'jump';
    await jumpToStart(deps, { x: s0.at.x, z: s0.at.z, heading: head, mode: 'car' }, { onDark: () => { applyBus(); resetRun(); return null; } });
    if (S !== s) return;
    s.phase = 'count';
    s.count = countdown(s.ov.root, ['3', '2', '1', t('jobs.bus.go')]);
    hud();
  }

  // Swap the car for the bus and the car's handling for the bus's.
  function applyBus() {
    const s = S, pl = deps.player;
    if (pl.mode !== 'car') pl.setMode('car');
    Object.assign(MODE_PARAMS.car, BUS_PARAMS);
    if (!s.vis) {
      s.vis = buildPlayerBus(0x2e6db4);
      pl.root.add(s.vis.group);
    }
    if (s.chase) s.chase.wantDist = 34;
    hideCar();
  }
  function hideCar() {
    const pl = deps.player;
    if (pl.vehicles && pl.vehicles.car) pl.vehicles.car.group.visible = false;
    pl.rider.visible = false;
    pl.shotgun.visible = false;
  }

  function resetRun() {
    const s = S;
    s.leg = 0;
    s.time = 0;
    s.comfort = s.cfg.comfort.start;
    s.aboard = 0;
    s.stats = { brakes: 0, bumps: 0, kerbs: 0, slow: 0, doorsBlock: 0, punct: [], stop: [], pax: { boarded: 0, total: 0 }, late: 0 };
    s.prevSpeed = 0; s.hardT = 0; s.cd = {}; s.lastEvent = -9; s.onRoad = true; s.offT = 0; s.slowT = 0; s.stillT = 0;
    s.trafficBumps = deps.traffic && deps.traffic.stats ? deps.traffic.stats().bumps : 0;
    s.dwell = null;
    s.waiters = [];
    s.vis.setDoors(0);
    s.doorOpen = 0; s.doorTarget = 0;
  }

  function guide() {
    const s = S, leg = s.plan.legs[s.leg];
    s.stopMark.visible = true;
    s.stopMark.position.set(leg.to.at.x, groundY(surface, leg.to.at.x, leg.to.at.z), leg.to.at.z);
    s.gps.guide(leg.to.at, { mode: s.cfg.relaxed ? 'bus' : 'car', from: deps.player.pos, arrive: 0, color: 0xffcb3d, owner: 'bus', path: leg.points });
    spawnWaiters(leg);
  }

  // People waiting at the next stop: spawned along the pavement (the stop point), 2 or 3 of them.
  function spawnWaiters(leg) {
    const s = S;
    if (leg.terminus || leg.waiters) return;
    const b = leg.to.b, n = 2 + (s.leg % 2);
    leg.waiters = [];
    const px = Math.cos(b.angle), pz = -Math.sin(b.angle);
    for (let i = 0; i < n; i++) {
      let av = null;
      try { av = s.make({ archetype: WAITERS[(s.leg * 3 + i) % WAITERS.length], seed: 11 + s.leg * 5 + i }); } catch (e) { console.warn('[bus] avatar failed', e); }
      if (!av || !av.group) continue;
      const off = (i - (n - 1) / 2) * 2.4;
      const x = b.x + px * off, z = b.z + pz * off;
      av.group.position.set(x, groundY(surface, x, z), z);
      av.group.rotation.y = Math.atan2(Math.sin(b.angle), Math.cos(b.angle));
      try { av.setMode && av.setMode('idle'); } catch (_) { /* optional */ }
      deps.scene.add(av.group);
      leg.waiters.push({ av, state: 'wait', x, z });
    }
    s.stats.pax.total += leg.waiters.length;
  }

  function event(kind, amount, cooldown = 1.5) {
    const s = S;
    if ((s.cd[kind] || -99) > s.time) return;
    s.cd[kind] = s.time + cooldown;
    if (kind === 'bump') s.stats.bumps++;
    s.comfort = clamp(s.comfort + amount, 0, s.cfg.comfort.start);
    s.lastEvent = s.time;
    (s.evlog || (s.evlog = [])).push([kind, +s.time.toFixed(1), Math.round(deps.player.pos.x), Math.round(deps.player.pos.z), Math.round(deps.player.speed)]);
    s.toast(`${t(`jobs.bus.${kind === 'brake' ? 'hard' : kind}`)}  ${Math.round(amount)}`);
  }

  function doorPoint() {
    const pl = deps.player, d = S.vis.doorAt, h = pl.heading;
    // local +x is the left of the bus: x = -w/2 is the kerb side
    return { x: pl.pos.x + Math.sin(h) * d.z + Math.cos(h) * d.x, z: pl.pos.z + Math.cos(h) * d.z - Math.sin(h) * d.x };
  }

  function arrive(leg) {
    const s = S, pl = deps.player;
    const d = Math.hypot(pl.pos.x - leg.to.at.x, pl.pos.z - leg.to.at.z);
    const late = s.cfg.relaxed ? 0 : Math.max(0, s.time - (leg.due + s.cfg.grace));
    const punct = clamp(100 - late * 2.5, 0, 100);
    const stop = s.cfg.relaxed ? clamp(100 - Math.max(0, d - 9) * (100 / 18), 60, 100) : clamp(100 - Math.max(0, d - 6) * (100 / 9), 0, 100);
    s.stats.punct.push(punct); s.stats.stop.push(stop); s.stats.late += late;
    s.gps.clear();
    s.stopMark.visible = false;
    synth.play('win');
    s.toast(t(stop >= 85 ? 'jobs.bus.perfectStop' : 'jobs.bus.okStop'));
    s.phase = 'dwell';
    s.doorTarget = 1;
    s.dwell = { t: 0, leg, left: false };
    s.aboard = Math.max(0, s.aboard - (leg.terminus ? s.aboard : Math.min(s.aboard, 1 + (s.leg % 2))));
    if (leg.waiters) for (const w of leg.waiters) w.state = 'board';
  }

  function depart(missed) {
    const s = S;
    s.doorTarget = 0;
    const leg = s.dwell.leg;
    if (leg.waiters) for (const w of leg.waiters) if (w.state !== 'gone') { w.state = 'gone'; w.av.group.visible = false; }
    s.dwell = null;
    s.leg++;
    s.phase = 'drive';
    if (missed && !s.cfg.relaxed) { s.stats.doorsBlock++; event('doors', s.cfg.comfort.doors, 0); }
    else s.toast(t('jobs.bus.go'));
    guide();
  }

  function update(dt, input) {
    const s = S;
    if (!s) return;
    const pl = deps.player;
    if (!s.vis) return;
    if (s.stopMark.visible && s.stopMark.userData.ring) s.stopMark.userData.ring.scale.setScalar(1 + Math.sin(performance.now() / 220) * 0.12);
    if (s.phase === 'jump') return;
    // 1-5 and E would swap the vehicle under the bus: put it back
    if (pl.mode !== 'car') { pl.setMode('car'); Object.assign(MODE_PARAMS.car, BUS_PARAMS); s.toast(t('jobs.bus.hard')); }
    hideCar();
    s.doorOpen += (s.doorTarget - s.doorOpen) * Math.min(1, dt * 6);
    s.vis.setDoors(s.doorOpen);
    for (const leg of s.plan.legs) if (leg.waiters) for (const w of leg.waiters) walkWaiter(w, dt);
    if (s.phase === 'count') {
      if (s.count.update(dt)) { s.phase = 'drive'; s.prevSpeed = 0; guide(); }
      hud();
      return;
    }
    if (dt <= 0) return;
    s.time += dt;
    if (input && input.wasPressed && input.wasPressed('KeyH')) synth.play('honk');
    const leg = s.plan.legs[s.leg];
    const sp = Math.abs(pl.speed);

    if (s.phase === 'drive') {
      s.gps.update(dt, pl, 'bus');
      drivingEvents(dt, sp);
      const d = Math.hypot(pl.pos.x - leg.to.at.x, pl.pos.z - leg.to.at.z);
      s.stillT = d < s.cfg.zone && sp < 1.6 ? s.stillT + dt : 0;
      if (s.stillT > 0.35) arrive(leg);
    } else if (s.phase === 'dwell') {
      const dw = s.dwell;
      dw.t += dt;
      drivingEvents(dt, sp, true);
      const boarded = (leg.waiters || []).filter((w) => w.state === 'gone').length;
      const allIn = !leg.waiters || leg.waiters.every((w) => w.state === 'gone');
      s.aboard = Math.max(0, s.aboardBase ?? s.aboard);
      if (sp > 3 && Math.hypot(pl.pos.x - leg.to.at.x, pl.pos.z - leg.to.at.z) > s.cfg.zone * 1.2) { depart(true); }
      else if (leg.terminus) { if (dw.t > 2.2) return win(); }
      else if (allIn && dw.t >= 1.5 && (s.cfg.relaxed || s.time >= leg.depart)) { s.stats.pax.boarded += boarded; depart(false); }
      else if (!allIn && dw.t > s.cfg.dwell * 2 + 4) { s.stats.pax.boarded += boarded; depart(false); }
    }
    if (s.comfort <= 0 && !s.cfg.relaxed) return fail('comfort');
    hud();
  }

  function walkWaiter(w, dt) {
    const s = S;
    try { w.av.update(dt, w.state === 'board' ? 3.5 : 0); } catch (_) { /* optional */ }
    if (w.state !== 'board') return;
    if (s.phase !== 'dwell' || s.doorOpen < 0.7) return;
    const door = doorPoint(), g = w.av.group;
    const dx = door.x - g.position.x, dz = door.z - g.position.z, d = Math.hypot(dx, dz);
    if (d < 1.4) { w.state = 'gone'; g.visible = false; s.aboard++; s.toast(t('jobs.bus.boarded', { n: s.aboard })); return; }
    const step = Math.min(d, 5 * dt);
    g.position.x += dx / d * step; g.position.z += dz / d * step;
    g.position.y = groundY(surface, g.position.x, g.position.z);
    g.rotation.y = Math.atan2(dx, dz);
    try { w.av.setMode && w.av.setMode('walk'); } catch (_) { /* optional */ }
  }

  function drivingEvents(dt, sp, still = false) {
    const s = S, pl = deps.player, cc = s.cfg.comfort;
    const prev = Math.abs(s.prevSpeed), decel = (prev - sp) / dt;
    s.prevSpeed = pl.speed;
    // Relaxed (founder, 2026-10-30: "a mission for fun, light and friendly"): no comfort damage,
    // no speed or braking penalties.
    if (s.cfg.relaxed) return;
    if (prev - sp > 9 && decel > 300) { synth.play('bump'); event('bump', cc.bump); }
    else if (decel > 21 && prev > 12) {
      s.hardT += dt;
      if (s.hardT > 0.25) { s.hardT = -1; s.stats.brakes++; event('brake', cc.brake, 2); }
    } else s.hardT = Math.max(0, s.hardT);
    if (deps.traffic && deps.traffic.stats) {
      const b = deps.traffic.stats().bumps;
      if (b > s.trafficBumps) event('bump', cc.bump, 5); // a queue nudging a bumper is one event, not ten
      s.trafficBumps = b;
    }
    if (still) return;
    const onC = deps.city && typeof deps.city.onCarriage === 'function';
    if (onC && sp > 2) {
      const on = !!deps.city.onCarriage(pl.pos.x, pl.pos.z, 1.5);
      if (!on && s.onRoad) { s.stats.kerbs++; event('kerb', cc.kerb, 2.5); }
      if (!on) { s.offT += dt; if (s.offT > 1) s.comfort = clamp(s.comfort + cc.offroad * dt, 0, cc.start); } else s.offT = 0;
      s.onRoad = on;
    }
    s.slowT = sp > s.cfg.speedLimit ? s.slowT + dt : 0;
    if (s.slowT > 1) { s.slowT = -3; s.stats.slow++; event('slow', cc.slow, 4); }
    if (sp > 8 && s.time - s.lastEvent > 4 && decel < 15) s.comfort = clamp(s.comfort + cc.smooth * dt, 0, cc.start);
  }

  function hud() {
    const s = S;
    if (!s || !s.plan) return;
    const leg = s.plan.legs[Math.min(s.leg, s.plan.legs.length - 1)];
    const pl = deps.player;
    const v = s.cfg.relaxed ? 1 : s.comfort / s.cfg.comfort.start;
    const bar = s.ov.$('.mg-bar i');
    bar.style.width = v * 100 + '%';
    bar.style.background = v > 0.6 ? '#2ec4b6' : v > 0.3 ? '#ffb347' : '#e8364f';
    s.ov.$('.bs-next').textContent = leg.terminus ? (s.plan.shift ? t('jobs.bus.lineEnd', { name: leg.to.name }) : t('jobs.bus.terminus')) : t('jobs.bus.next', { name: leg.to.name });
    const m = Math.hypot(pl.pos.x - leg.to.at.x, pl.pos.z - leg.to.at.z) / 0.25 / 1.2 * 0.25;
    s.ov.$('.bs-dist').textContent = t('jobs.bus.dist', { d: Math.round(Math.hypot(pl.pos.x - leg.to.at.x, pl.pos.z - leg.to.at.z) / 1.2) });
    const kmh = Math.round(Math.abs(pl.speed) / 1.2 * 3.6);
    const sp = s.ov.$('.bs-speed');
    sp.textContent = `${kmh} km/h`;
    sp.classList.toggle('over', !s.cfg.relaxed && Math.abs(pl.speed) > s.cfg.speedLimit);
    s.ov.$('.bs-aboard').textContent = t('jobs.bus.aboard', { n: s.aboard });
    const slack = s.time - leg.due;
    let note = '';
    if (s.cfg.relaxed) note = s.phase === 'drive' ? t('jobs.bus.relaxed') : '';
    else if (s.phase === 'drive') note = slack > s.cfg.grace ? t('jobs.bus.late', { s: Math.round(slack - s.cfg.grace) }) : t('jobs.bus.onTime');
    else if (s.phase === 'dwell' && s.time < leg.depart && !leg.terminus) note = t('jobs.bus.early', { s: Math.ceil(leg.depart - s.time) });
    s.ov.$('.bs-time').textContent = note;
    s.ov.$('.bs-doors').textContent = t(s.doorTarget ? 'jobs.bus.doorsOpen' : 'jobs.bus.doorsClosed');
    s.ov.$('.bs-note').textContent = s.phase === 'dwell' && !leg.terminus ? t('jobs.bus.wait') : '';
  }

  const avg = (a) => (a.length ? a.reduce((n, x) => n + x, 0) / a.length : 100);
  function win() {
    const s = S, st = s.stats;
    const smooth = Math.round(s.comfort), punct = Math.round(avg(st.punct)), stop = Math.round(avg(st.stop));
    const pax = st.pax.total ? Math.round(100 * st.pax.boarded / st.pax.total) : 100;
    // relaxed: finishing the line is the achievement; only the stops and the boarding count
    const score = s.cfg.relaxed ? Math.round(70 + stop * 0.2 + pax * 0.1) : Math.round(smooth * 0.4 + punct * 0.3 + stop * 0.2 + pax * 0.1);
    const detail = { smooth, punct, stop, pax, time: +s.time.toFixed(1), brakes: st.brakes, bumps: st.bumps, kerbs: st.kerbs, slow: st.slow, doorsBlock: st.doorsBlock, boarded: st.pax.boarded, stops: s.plan.stops.length };
    if (s.lineShifts) advanceShift(s.lineShifts);
    finish({ ok: true, score, detail, summary: t('jobs.bus.summary', { smooth, punct, stop, pax }), tries: s.tries + 1 });
  }
  function fail(reason) { finish({ ok: false, reason, tries: S.tries + 1, detail: { evlog: S.evlog || [], time: +S.time.toFixed(1), leg: S.leg, comfort: Math.round(S.comfort), pos: [Math.round(deps.player.pos.x), Math.round(deps.player.pos.z)] } }); }

  function finish(result) {
    const s = S;
    if (!s) return;
    teardown();
    last = result;
    s.resolve(result);
  }

  function teardown() {
    const s = S;
    if (!s) return;
    S = null;
    const pl = deps.player;
    s.gps.clear();
    if (s.count) s.count.remove();
    for (const leg of (s.plan && s.plan.legs) || []) for (const w of leg.waiters || []) { deps.scene.remove(w.av.group); }
    Object.assign(MODE_PARAMS.car, s.saved);
    if (s.chase && s.chaseDist) s.chase.wantDist = s.chaseDist;
    if (s.vis) {
      pl.root.remove(s.vis.group);
      s.vis.group.traverse((o) => { if (o.geometry && o.geometry.userData?.shared !== true && o !== s.vis.group) { /* shared geometries are cached */ } });
      // the bus leaves the road with the player: back on foot (or on what they rode) at the station kerb
      const st = s.plan && s.plan.stops[0];
      pl.rider.visible = true;
      pl.setMode(s.prevMode === 'car' ? 'car' : s.prevMode);
      if (st) placePlayer(pl, { x: st.b.x, z: st.b.z }, st.b.angle + Math.PI);
    }
    deps.scene.remove(s.root);
    s.ov.remove();
  }

  function cancel() {
    const s = S;
    if (!s) return;
    teardown();
    s.resolve({ ok: false, cancelled: true, tries: s.tries });
  }

  return {
    start, update, cancel,
    get lastResult() { return last; },
    get active() { return !!S; },
    get blocksPlayer() { return !!S && (S.phase === 'jump' || S.phase === 'count'); },
    debug: {
      state: () => (S ? { phase: S.phase, leg: S.leg, legs: S.plan && S.plan.legs.length, comfort: Math.round(S.comfort || 0), aboard: S.aboard || 0, time: +(S.time || 0).toFixed(1), doors: +(S.doorOpen || 0).toFixed(2),
        stats: S.stats, evlog: S.evlog || [], target: S.plan && S.plan.legs[Math.min(S.leg || 0, S.plan.legs.length - 1)].to.at } : null),
      diag: () => plan.diag || [],
      plan: () => (S && S.plan ? { stops: S.plan.stops.map((x) => ({ name: x.name, at: x.at })), legs: S.plan.legs.map((l) => ({ len: Math.round(l.len), due: +l.due.toFixed(1), depart: +l.depart.toFixed(1), points: l.points })), total: Math.round(S.plan.total) } : null),
      event: (kind, amount) => S && event(kind, amount ?? S.cfg.comfort[kind] ?? -5, 0),
    },
  };
}
