// Checkpoint race: rings with arrows along a route, a clock, optional rival runners/riders/drivers
// who follow the route at their own pace (rubber-banded so the race stays close), a time penalty
// for bumping into people, and an optional tempting shortcut that carries story effects.
//
//   const race = createRace({ scene, camera, hud, audio, player, city, traffic, crowd, t, surface, makeAvatar });
//   const res = await race.start({
//     checkpoints: [{x,z}, ...],            // resolved world points, in order; the last one is the finish
//     start: { x, z, heading? },            // optional; the player is placed here for every try
//     modes: ['scooter', 'bike'],           // allowed player modes (the first is set if the player is on another)
//     rivals: [{ id: 'dasha', archetype: 'jogger', mode: 'walk', speed: 15 }],
//     place: 2, bumpPenalty: 3, radius: 9,
//     shortcut: { at: {x,z}, radius: 10, effects: { scale: -1 } },
//   });
//   // res = { ok, place, time, penalty, bumps, shortcut, effects, rivals: [{ id, time }], tries, quit }
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, showCard, countdown, ringMarker, beamMarker, surfaceFn, groundY,
  avatarFactory, disposeTree, placePlayer, fmtTime, clamp, toaster, mergeEffects, jumpToStart, clearSpot } from './common.js';
import { getSynth } from './synth.js';
import { getGps, gpsMode, clearance, clearAt } from '../gps.js';

const CSS = `
.mg-race .rc-hud { left: 50%; top: 12px; transform: translateX(-50%); width: 240px; text-align: start; }
.mg-race .rc-time { font-size: 28px; font-weight: 900; }
.mg-race .rc-row { display: flex; justify-content: space-between; font-weight: 800; font-size: 14px; }
.mg-race .rc-pen { color: #e8364f; }
`;

export function createRace(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  const surface = surfaceFn(deps);
  addStyle('mg-style-race', CSS);
  let S = null;

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const cps = (config.checkpoints || []).map((p) => ({ x: p.x, z: p.z }));
      if (cps.length < 1) { resolve({ ok: true, place: 1, time: 0, skipped: true }); return; }
      const ov = createOverlay('mg-race',
        '<div class="mg-panel rc-hud"><div class="mg-title rc-title"></div><div class="rc-time mg-num">0:00.0</div>' +
        '<div class="rc-row"><span class="rc-cp"></span><span class="rc-place"></span></div><div class="rc-row"><span class="rc-pen mg-num"></span></div></div>');
      ov.$('.rc-title').textContent = t(config.title || 'mg.race.title');
      const root = new THREE.Group();
      root.name = 'mg-race';
      deps.scene.add(root);
      S = { cfg: config, cps, cps0: cps.map((p) => ({ ...p })), ov, root, resolve, tries: 0, toast: toaster(ov.root), rivals: [], rings: [], gps: getGps(deps) };
      S.ready = spawnRivals();
      reset();
    });
  }

  // Route planning, once per race (under the fade): the GPS path through every checkpoint for
  // the race vehicle, each checkpoint moved to the clearest spot of its approach (no lamp, tree,
  // bench or parked car in the ring or the riding line), and the start nudged onto clear ground.
  function plan() {
    const s = S;
    const gps = s.gps;
    const mode = gpsMode((s.cfg.modes || ['scooter', 'bike'])[0]);
    const C = deps.collision;
    const st0 = s.cfg.start || { x: deps.player.pos.x, z: deps.player.pos.z };
    const start = C ? clearSpot(C, st0.x, st0.z, 2.4, clearAt) : { x: st0.x, z: st0.z };
    const legs = [];
    let from = start;
    s.cps = s.cps0.map((cp0, i) => {
      const r = s.cfg.gps === false ? { points: [from, cp0] } : gps.route(from, cp0, { mode });
      let pts = r.points;
      let cp = { x: cp0.x, z: cp0.z };
      if (C && s.cfg.clearRings !== false && pts.length > 2) {
        // Search the last stretch of the approach for the best-cleared point.
        const want = s.cfg.ringClearance || 3;
        let bestI = pts.length - 1, bestScore = -Infinity;
        let along = 0;
        for (let k = pts.length - 1; k > 0 && along < (s.cfg.ringSearch || 30); k--) {
          const c = clearance(C, pts[k].x, pts[k].z);
          const score = Math.min(c, want) * 10 - along * 0.05;
          if (score > bestScore) { bestScore = score; bestI = k; }
          along += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
        }
        cp = { x: pts[bestI].x, z: pts[bestI].z };
        pts = pts.slice(0, bestI + 1);
      }
      legs.push(pts);
      from = cp;
      void i;
      return cp;
    });
    // The start line: the given start, or a point a little way down the first leg when the start
    // is boxed in (a wall right behind the player puts the chase camera in their ear).
    let best = null;
    const leg0 = legs[0] || [];
    let along = 0;
    let leg0Len = 0;
    for (let k = 1; k < leg0.length; k++) leg0Len += Math.hypot(leg0[k].x - leg0[k - 1].x, leg0[k].z - leg0[k - 1].z);
    for (let k = 0; k < leg0.length - 1 && along < Math.min(s.cfg.startSearch ?? 40, leg0Len * 0.4); k++) {
      const p = leg0[k], q = leg0[Math.min(leg0.length - 1, k + 3)];
      const yaw = Math.atan2(q.x - p.x, q.z - p.z);
      const room = C ? clearance(C, p.x, p.z, [4, 3, 2.4]) : 4;
      const back = C && C.raycast ? C.raycast(p.x, p.z, p.x - Math.sin(yaw) * 16, p.z - Math.cos(yaw) * 16, true, { skipThin: 1.5 }) : 1;
      const score = room * 2 + back * 10 - along * 0.08;
      if (room >= 2.4 && (!best || score > best.score)) best = { x: p.x, z: p.z, yaw, score, k };
      along += Math.hypot(leg0[k + 1].x - p.x, leg0[k + 1].z - p.z);
    }
    const sp = best || { x: start.x, z: start.z, yaw: Math.atan2(s.cps[0].x - start.x, s.cps[0].z - start.z), k: 0 };
    if (sp.k > 0) legs[0] = leg0.slice(sp.k);
    // One polyline for the rivals and the race position, with each checkpoint's distance.
    const path = [], cum = [0], cpAt = [];
    for (const leg of legs) {
      for (const p of leg) {
        const last = path[path.length - 1];
        if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.05) continue;
        if (last) cum.push(cum[cum.length - 1] + Math.hypot(p.x - last.x, p.z - last.z));
        path.push({ x: p.x, z: p.z });
      }
      cpAt.push(cum[cum.length - 1]);
    }
    s.plan = { mode, legs, path, cum, cpAt, start: { x: sp.x, z: sp.z, heading: st0.heading ?? sp.yaw } };
    buildRings();
  }

  function buildRings() {
    const s = S;
    for (const m of s.rings) { s.root.remove(m); disposeTree(m); }
    s.rings = [];
    s.cps.forEach((p, i) => {
      const last = i === s.cps.length - 1;
      const m = last ? beamMarker(0xffcb3d, 6, 50) : ringMarker(0x2ec4b6);
      const y = groundY(surface, p.x, p.z);
      m.position.set(p.x, y, p.z);
      // The ring faces the way the route arrives; its arrow points the way the route leaves.
      const leg = s.plan.legs[i], nextLeg = s.plan.legs[i + 1];
      const before = leg.length > 1 ? leg[Math.max(0, leg.length - 4)] : (i > 0 ? s.cps[i - 1] : s.plan.start);
      const after = nextLeg && nextLeg.length > 1 ? nextLeg[Math.min(nextLeg.length - 1, 3)] : null;
      m.rotation.y = Math.atan2(p.x - before.x, p.z - before.z);
      const dir = after ? Math.atan2(after.x - p.x, after.z - p.z) : m.rotation.y;
      // YXZ: tip the cone onto +z first, then turn it toward the next ring.
      if (m.userData.arrow) { m.userData.arrow.rotation.order = 'YXZ'; m.userData.arrow.rotation.set(Math.PI / 2, dir - m.rotation.y, 0); }
      s.root.add(m);
      s.rings.push(m);
    });
  }

  async function spawnRivals() {
    const s = S;
    const make = await avatarFactory(deps);
    const vehicleMesh = (s.cfg.rivals || []).some((r) => r.mode === 'car')
      ? await import('../../vehicles/models.js').then((m) => m.buildVehicleMesh).catch(() => null) : null;
    if (S !== s) return;
    (s.cfg.rivals || []).forEach((r, i) => {
      let av = null;
      try { av = make({ archetype: r.archetype || 'jogger', seed: 100 + i }); } catch (e) { console.warn('[race] rival avatar failed', e); }
      if (!av || !av.group) return;
      const holder = new THREE.Group();
      holder.add(av.group);
      if (r.mode === 'car' && vehicleMesh) {
        const car = vehicleMesh(r.kind || 'hatch', r.color || 0x3f8efc);
        holder.add(car);
        av.group.position.set(0, 1.6, -0.4);
      }
      try { av.setMode && av.setMode(r.mode === 'walk' || !r.mode ? 'walk' : r.mode); } catch (_) { /* optional */ }
      s.root.add(holder);
      s.rivals.push({ def: r, av, holder, d: 0, time: null, speed: r.speed || 15, lateral: (i % 2 ? 1 : -1) * (3 + Math.floor(i / 2) * 2.5) });
    });
    placeRivals();
  }

  // The route the rivals run: the planned GPS path (or a given `route`), as cumulative distances.
  function route() {
    const s = S;
    if (s.cfg.route) {
      const pts = [s.plan.start, ...s.cfg.route, s.cps[s.cps.length - 1]];
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      return { pts, cum, len: cum[cum.length - 1] };
    }
    const pts = [s.plan.start, ...s.plan.path.filter((p, i) => i > 0 || Math.hypot(p.x - s.plan.start.x, p.z - s.plan.start.z) > 0.5)], cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    return { pts, cum, len: cum[cum.length - 1] };
  }
  function along(R, d, out) {
    let i = 1;
    while (i < R.cum.length - 1 && R.cum[i] < d) i++;
    const a = R.pts[i - 1], b = R.pts[i];
    const seg = R.cum[i] - R.cum[i - 1] || 1;
    const k = clamp((d - R.cum[i - 1]) / seg, 0, 1);
    out.x = a.x + (b.x - a.x) * k; out.z = a.z + (b.z - a.z) * k;
    // Heading from the first real stretch at or after this point (zero-length joints have none).
    let j = i;
    while (j < R.pts.length - 1 && Math.hypot(R.pts[j].x - R.pts[j - 1].x, R.pts[j].z - R.pts[j - 1].z) < 0.3) j++;
    out.yaw = Math.atan2(R.pts[j].x - R.pts[j - 1].x, R.pts[j].z - R.pts[j - 1].z);
    return out;
  }

  function placeRivals() {
    const s = S;
    if (!s || !s.R) return;
    const p = {};
    for (const r of s.rivals) {
      along(s.R, r.d, p);
      const lx = Math.cos(p.yaw) * r.lateral, lz = -Math.sin(p.yaw) * r.lateral;
      const x = p.x + lx, z = p.z + lz;
      r.holder.position.set(x, groundY(surface, x, z), z);
      r.holder.rotation.y = p.yaw;
    }
  }

  // Every try: fade out, (plan once), put the player and the rivals on the start line facing
  // the first checkpoint, fade in, 3-2-1.
  function reset() {
    const s = S;
    if (!s) return;
    if (s.closeCard) { s.closeCard(); s.closeCard = null; }
    if (s.count) { s.count.remove(); s.count = null; }
    s.phase = 'jump';
    s.gps.clear();
    const modes = s.cfg.modes || ['scooter', 'bike'];
    const pl = deps.player;
    const mode = modes.includes(pl.mode) ? pl.mode : modes[0];
    const place = () => {
      if (S !== s) return null;
      if (!s.plan) plan();
      const st = s.plan.start;
      // A race from where the player stands (no `start`, or teleport: false) does not move them.
      return s.cfg.start && s.cfg.teleport !== false ? { ...st, mode } : null;
    };
    const go = () => {
      if (S !== s) return;
      if (pl.mode !== mode && !modes.includes(pl.mode)) pl.setMode(mode);
      s.mode = pl.mode;
      s.startPos = { x: pl.pos.x, z: pl.pos.z };
      Object.assign(s, { next: 0, time: 0, penalty: 0, bumps: 0, shortcut: false, phase: 'count', bumpCd: 0, npcCd: new Map(),
        trafficBumps: deps.traffic && deps.traffic.stats ? deps.traffic.stats().bumps : 0, finished: null, pd: 0, lastCount: -1 });
      s.R = route();
      const assist = s.tries >= 2 ? 0.9 : 1;
      for (const r of s.rivals) { r.d = 0; r.time = null; r.assist = assist; try { r.av.setMode && r.av.setMode(r.def.mode === 'walk' || !r.def.mode ? 'idle' : r.def.mode); } catch (_) { /* optional */ } }
      placeRivals();
      refreshRings();
      guideLeg(0);
      s.count = countdown(s.ov.root, ['3', '2', '1', t('mg.race.go')]);
      hud();
    };
    if (s.cfg.jump === false) { const spot = place(); if (spot) placePlayer(pl, spot, spot.heading); go(); return; }
    jumpToStart(deps, null, { onDark: place }).then(go);
  }

  // The ribbon shows the way to the next ring along the planned leg; it re-plans if the player strays.
  function guideLeg(i) {
    const s = S;
    if (!s.plan || s.cfg.ribbon === false || i >= s.cps.length) { s.gps.clear(); return; }
    s.gps.guide(s.cps[i], { mode: s.plan.mode, path: s.plan.legs[i], from: deps.player.pos, arrive: 0, color: 0x2ec4b6, owner: 'race' });
  }

  function refreshRings() {
    const s = S;
    s.rings.forEach((m, i) => {
      m.visible = i >= s.next && i <= s.next + 2;
      const on = i === s.next;
      m.traverse((o) => { if (o.material && o.material.opacity !== undefined && o !== m.userData.arrow) o.material.opacity = on ? (o === m.userData.disc ? 0.15 : 0.85) : 0.3; });
      if (m.userData.arrow) m.userData.arrow.visible = on;
    });
  }

  // How far along the rivals' route the player is: the nearest point on the route polyline,
  // never moving backwards by more than a little (a U-turn does not drop places at once).
  function playerDistance() {
    const s = S, pl = deps.player.pos, R = s.R;
    let best = Infinity, bd = 0;
    for (let i = 1; i < R.pts.length; i++) {
      const a = R.pts[i - 1], b = R.pts[i];
      const vx = b.x - a.x, vz = b.z - a.z, l2 = vx * vx + vz * vz || 1e-9;
      const k = clamp(((pl.x - a.x) * vx + (pl.z - a.z) * vz) / l2, 0, 1);
      const d = Math.hypot(a.x + vx * k - pl.x, a.z + vz * k - pl.z);
      const at = R.cum[i - 1] + k * (R.cum[i] - R.cum[i - 1]);
      // Prefer the stretch the player is actually on (close to the last known distance).
      const score = d + Math.max(0, (s.pd || 0) - at - 40) * 0.5;
      if (score < best) { best = score; bd = at; }
    }
    s.pd = Math.max(bd, (s.pd || 0) - 15);
    return s.pd;
  }

  function update(dt) {
    const s = S;
    if (!s) return;
    for (const [i, m] of s.rings.entries()) {
      if (!m.visible) continue;
      if (m.userData.ring) m.userData.ring.rotation.z += dt * 0.6;
      if (m.userData.arrow) m.userData.arrow.position.y = 14.5 + Math.sin(performance.now() / 250 + i) * 0.6;
    }
    for (const r of s.rivals) { try { r.av.update(dt, s.phase === 'race' && r.time === null ? r.speed : 0); } catch (_) { /* animation only */ } }
    if (s.phase === 'race' || s.phase === 'count') s.gps.update(dt, deps.player, 'race');
    if (s.phase === 'jump') return;
    if (s.phase === 'count') {
      if (s.count.update(dt)) { s.phase = 'race'; synth.play('whoosh'); for (const r of s.rivals) { try { r.av.setMode && r.av.setMode(r.def.mode || 'walk'); } catch (_) { /* optional */ } } }
      else if (s.count.step >= 0 && s.lastCount !== s.count.step) { s.lastCount = s.count.step; synth.play('click', null, 1, s.count.step === 3); }
      return;
    }
    if (s.phase !== 'race') return;
    const pl = deps.player;
    s.time += dt;
    // Wrong vehicle: put the player back on an allowed one (the race is on wheels).
    const modes = s.cfg.modes || ['scooter', 'bike'];
    if (!modes.includes(pl.mode)) { pl.setMode(modes.includes(s.mode) ? s.mode : modes[0]); s.toast(t('mg.race.stayOn')); }
    s.mode = pl.mode;

    // Checkpoints.
    const cp = s.cps[s.next];
    if (Math.hypot(pl.pos.x - cp.x, pl.pos.z - cp.z) < (s.cfg.radius || 9)) {
      s.next++;
      synth.play('ding');
      if (s.next >= s.cps.length) { finish(); return; }
      refreshRings();
      guideLeg(s.next);
    }

    // Bumps: people within reach while moving, and soft contacts with traffic.
    s.bumpCd = Math.max(0, s.bumpCd - dt);
    const people = deps.crowd && deps.crowd.npcs;
    if (people && Math.abs(pl.speed) > 3 && s.bumpCd <= 0) {
      for (const n of people) {
        if (Math.abs(n.x - pl.pos.x) > 3 || Math.abs(n.z - pl.pos.z) > 3) continue;
        if (Math.hypot(n.x - pl.pos.x, n.z - pl.pos.z) > 2.6) continue;
        if ((s.npcCd.get(n) || 0) > s.time) continue;
        s.npcCd.set(n, s.time + 3);
        bump();
        break;
      }
    }
    if (deps.traffic && deps.traffic.stats) {
      const b = deps.traffic.stats().bumps;
      if (b > s.trafficBumps && s.bumpCd <= 0) bump();
      s.trafficBumps = b;
    }
    // Shortcut: faster, at a cost the story remembers.
    const sc = s.cfg.shortcut;
    if (sc && !s.shortcut && sc.at && Math.hypot(pl.pos.x - sc.at.x, pl.pos.z - sc.at.z) < (sc.radius || 10)) {
      s.shortcut = true;
      if (sc.toast) s.toast(t(sc.toast));
    }

    // Rivals: steady pace along the route, nudged ±10% toward the player.
    const pd = playerDistance();
    for (const r of s.rivals) {
      if (r.time !== null) continue;
      const band = clamp((pd - r.d) / 120, -0.1, 0.1);
      r.d += r.speed * (r.assist || 1) * (1 + band) * dt;
      if (r.d >= s.R.len) { r.d = s.R.len; r.time = s.time; }
    }
    placeRivals();
    if (s.cfg.limit && s.time > s.cfg.limit) { finish(true); return; }
    hud(pd);
  }

  function bump() {
    const s = S;
    s.penalty += s.cfg.bumpPenalty ?? 3;
    s.bumps++;
    s.bumpCd = 1.2;
    synth.play('bump');
    s.toast(t('mg.race.bump', { s: s.cfg.bumpPenalty ?? 3 }));
  }

  function hud(pd = null) {
    const s = S;
    const total = s.time + s.penalty;
    s.ov.$('.rc-time').textContent = fmtTime(total);
    s.ov.$('.rc-cp').textContent = t('mg.race.checkpoint', { n: Math.min(s.next + 1, s.cps.length), total: s.cps.length });
    if (s.rivals.length && pd !== null) {
      const place = 1 + s.rivals.filter((r) => r.d > pd).length;
      s.ov.$('.rc-place').textContent = t('mg.race.place', { n: place, total: s.rivals.length + 1 });
    } else s.ov.$('.rc-place').textContent = '';
    s.ov.$('.rc-pen').textContent = s.penalty ? t('mg.race.penalty', { s: s.penalty }) : '';
  }

  function finish(timedOut = false) {
    const s = S;
    s.phase = 'card';
    s.gps.clear();
    const total = s.time + s.penalty;
    // Rivals still running finish at their current pace.
    const rivals = s.rivals.map((r) => ({ id: r.def.id || r.def.archetype, time: r.time !== null ? r.time : s.time + (s.R.len - r.d) / Math.max(1, r.speed) }));
    const place = timedOut ? rivals.length + 1 : 1 + rivals.filter((r) => r.time < total).length;
    const need = s.cfg.place || (rivals.length ? 1 : 1);
    const ok = !timedOut && place <= need;
    const effects = s.shortcut && s.cfg.shortcut ? mergeEffects(s.cfg.shortcut.effects) : null;
    s.result = { ok, place, time: +total.toFixed(2), raw: +s.time.toFixed(2), penalty: s.penalty, bumps: s.bumps, shortcut: s.shortcut, effects, rivals, tries: s.tries + 1, quit: false };
    synth.play(ok ? 'win' : 'fail');
    const lines = [t('mg.race.result', { time: fmtTime(total), place, total: rivals.length + 1 })];
    if (s.penalty) lines.push(t('mg.race.penaltyLine', { n: s.bumps, s: s.penalty }));
    if (ok) {
      s.closeCard = showCard(s.ov.root, { title: t('mg.race.passTitle'), big: t('mg.race.placeBig', { n: place }), lines,
        buttons: [{ label: t('mg.ui.continue'), key: ['Enter', 'KeyF'], onClick: () => end(s.result) }] });
      if (s.cfg.autoContinue) setTimeout(() => S === s && s.closeCard && s.closeCard.fire(0), 600);
    } else {
      if (s.tries + 1 >= 2) lines.push(t('mg.race.assist'));
      s.closeCard = showCard(s.ov.root, { title: t(timedOut ? 'mg.race.timeUp' : 'mg.race.failTitle'), big: t('mg.race.placeBig', { n: place }),
        lines: [t(s.cfg.failLine || 'mg.race.failLine'), ...lines],
        buttons: [
          { label: t('mg.ui.retry'), key: ['Enter', 'KeyF'], onClick: () => { s.tries++; reset(); } },
          { label: t('mg.ui.quit'), key: ['Escape'], alt: true, onClick: () => end({ ...s.result, ok: false, quit: true }) },
        ] });
    }
  }

  function end(result) {
    const s = S;
    teardown();
    s.resolve(result);
  }
  function teardown() {
    const s = S;
    if (!s) return;
    S = null;
    if (s.closeCard) s.closeCard();
    if (s.count) s.count.remove();
    s.gps.clear();
    deps.scene.remove(s.root);
    for (const m of s.rings) disposeTree(m);
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
    get active() { return !!S; },
    // Frozen only for the countdown and the result card; the race itself is driven by the player.
    get blocksPlayer() { return !!S && S.phase !== 'race'; },
    debug: {
      state: () => (S ? { phase: S.phase, next: S.next, time: S.time, penalty: S.penalty, rivals: S.rivals.map((r) => +r.d.toFixed(1)), len: S.R && S.R.len } : null),
      // The planned course: checkpoints as placed (moved onto clear spots) and their clearance.
      plan: () => (S && S.plan ? { start: S.plan.start, mode: S.plan.mode, length: Math.round(S.R ? S.R.len : 0), points: S.plan.path.length,
        cps: S.cps.map((c, i) => ({ x: +c.x.toFixed(1), z: +c.z.toFixed(1), moved: +Math.hypot(c.x - S.cps0[i].x, c.z - S.cps0[i].z).toFixed(1), clear: deps.collision ? clearance(deps.collision, c.x, c.z) : null })) } : null),
      card: (i = 0) => S && S.closeCard && S.closeCard.fire(i),
      bump: () => S && bump(),
    },
  };
}
