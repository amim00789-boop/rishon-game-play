// Passenger calm meter while driving (M5 bride, M16 pickups). The meter drops on hard braking,
// bumps (walls, kerbs, traffic), driving off the carriageway and honking (H); it rises on smooth
// driving and when the player stops patiently for people crossing. At zero the passenger asks to
// try again from the start point. Optional `waitSpots` turn one crossing into a moral beat:
// waiting there is remembered, honking there too.
//
//   const res = await passenger.start({
//     at: {x,z}, radius: 10,                  // drop-off
//     start: { x, z, heading? },              // retry point (e.g. the salon); omitted = no teleport
//     limit: 240,                             // optional clock in seconds (the chuppah)
//     passenger: { archetype: 'bride', seed: 3 }, name: 'quest.npc.hodaya',
//     calm: { start: 80, brake: -4, bump: -10, honk: -6, kerb: -5, offroad: -3, smooth: 1.2, waitCrossing: 3 },
//     waitSpots: [{ id: 'zebra_family', at: {x,z}, radius: 14, seconds: 3, effects: { scale: 1, trust: { haredi: 1 } },
//                   honkEffects: { scale: -1 } }],
//   });
//   // res = { ok, calm, time, tries, events: { brakes, bumps, honks, kerbs, waits }, waited: [], honkedAt: [], effects, quit }
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, showCard, placePlayer, avatarFactory, fmtTime, clamp, toaster, mergeEffects, keyListener, beamMarker, groundY, surfaceFn, jumpToStart } from './common.js';
import { getSynth } from './synth.js';
import { getGps } from '../gps.js';

const CSS = `
.mg-pass .ps-hud { left: 50%; top: 12px; transform: translateX(-50%); width: 260px; }
.mg-pass .ps-row { display: flex; justify-content: space-between; font-weight: 800; font-size: 13px; margin-top: 4px; }
.mg-pass .mg-bar { height: 14px; margin-top: 4px; }
.mg-pass .mg-bar > i { transition: width 0.25s, background 0.4s; }
.mg-pass .ps-face { font-weight: 900; font-size: 14px; }
`;
const DEF = { start: 80, max: 100, brake: -4, bump: -10, honk: -6, kerb: -5, offroad: -3, smooth: 1.2, waitCrossing: 3 };

export function createPassenger(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  const surface = surfaceFn(deps);
  addStyle('mg-style-pass', CSS);
  let S = null;

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const ov = createOverlay('mg-pass',
        '<div class="mg-panel ps-hud"><div class="mg-title ps-name"></div><div class="ps-row"><span class="ps-face"></span><span class="ps-val mg-num"></span></div>' +
        '<div class="mg-bar"><i></i></div><div class="ps-row"><span class="ps-time mg-num"></span><span class="ps-dist mg-num"></span></div></div>');
      ov.$('.ps-name').textContent = t(config.name || 'mg.passenger.title');
      const calm = { ...DEF, ...(config.calm || {}) };
      const root = new THREE.Group();
      root.name = 'mg-passenger';
      deps.scene.add(root);
      const drop = beamMarker(0xffcb3d, 4, 60);
      drop.position.set(config.at.x, groundY(surface, config.at.x, config.at.z), config.at.z);
      root.add(drop);
      S = { cfg: config, calmCfg: calm, ov, root, drop, resolve, tries: 0, gps: getGps(deps), toast: toaster(ov.root), offKeys: keyListener(onKey) };
      seatPassenger(S);
      reset();
    });
  }

  async function seatPassenger(s) {
    if (!s.cfg.passenger) return;
    const make = await avatarFactory(deps);
    if (S !== s) return;
    let av = null;
    try { av = make(s.cfg.passenger.archetype ? { archetype: s.cfg.passenger.archetype, seed: s.cfg.passenger.seed || 1 } : s.cfg.passenger); } catch (e) { console.warn('[passenger] avatar failed', e); }
    if (!av || !av.group) return;
    try { av.setMode && av.setMode('car'); } catch (_) { /* optional */ }
    s.av = av;
    // The buggy is open-topped: the passenger rides on the rear deck, facing forward, where the
    // camera sees them (the driver's seat is taken by the player avatar).
    av.group.position.set(0, 2.55 - (av.seatHeight || 1.2) + 0.4, -3.1);
    deps.player.root.add(av.group);
    av.group.visible = deps.player.mode === 'car';
  }

  function reset() {
    const s = S;
    if (s.closeCard) { s.closeCard(); s.closeCard = null; }
    const pl = deps.player;
    const modes = s.cfg.modes || ['car'];
    // Retries (and a first try with teleport or jump) start over at `start`, through a fade.
    const jump = s.cfg.start && (s.tries > 0 || s.cfg.teleport || s.cfg.jump);
    if (jump && s.cfg.jump === false) placePlayer(pl, s.cfg.start, s.cfg.start.heading);
    if (!modes.includes(pl.mode)) pl.setMode(modes[0]);
    const assist = s.tries >= 2 ? 0.7 : 1;
    Object.assign(s, {
      calm: s.calmCfg.start, time: 0, phase: 'drive', assist, prevSpeed: pl.speed, hardT: 0, cd: {}, lastEvent: -9,
      stopT: 0, onRoad: true, offT: 0, events: { brakes: 0, bumps: 0, honks: 0, kerbs: 0, waits: 0 }, waited: [], honkedAt: [],
      trafficBumps: deps.traffic && deps.traffic.stats ? deps.traffic.stats().bumps : 0, spotT: {},
      limit: s.cfg.limit ? s.cfg.limit * (1 + 0.25 * s.tries) : 0,
    });
    const guide = () => { if (S === s && s.cfg.guide !== false) s.gps.guide(s.cfg.at, { mode: modes[0], from: pl.pos, arrive: 0, color: 0xffcb3d, owner: 'passenger' }); };
    if (jump && s.cfg.jump !== false) {
      s.phase = 'jump';
      s.gps.clear();
      const st = s.cfg.start;
      const heading = st.heading ?? Math.atan2(s.cfg.at.x - st.x, s.cfg.at.z - st.z);
      jumpToStart(deps, { x: st.x, z: st.z, heading, mode: modes[0] }).then(() => {
        if (S !== s) return;
        s.phase = 'drive'; s.prevSpeed = 0;
        guide();
      });
    } else guide();
    hud();
  }

  // An event changes the meter once per cooldown, and the passenger says something about it.
  function event(kind, amount, cooldown = 1.2) {
    const s = S;
    if ((s.cd[kind] || -99) > s.time) return;
    s.cd[kind] = s.time + cooldown;
    const delta = amount < 0 ? amount * s.assist : amount;
    s.calm = clamp(s.calm + delta, 0, s.calmCfg.max);
    if (amount < 0) s.lastEvent = s.time;
    const key = (s.cfg.lines && s.cfg.lines[kind]) || `mg.passenger.react.${kind}`;
    s.toast(`${t(key)}  ${delta > 0 ? '+' : ''}${Math.round(delta)}`);
    try { s.cfg.onEvent && s.cfg.onEvent(kind, delta, s.calm); } catch (_) { /* caller's problem */ }
  }

  function onKey(e) {
    const s = S;
    if (!s || s.phase !== 'drive' || e.repeat || e.code !== (s.cfg.honkKey || 'KeyH')) return;
    if (deps.player.mode !== 'car') return;
    synth.play('honk');
    s.events.honks++;
    event('honk', s.calmCfg.honk, 0.4);
    for (const w of s.cfg.waitSpots || []) {
      if (Math.hypot(deps.player.pos.x - w.at.x, deps.player.pos.z - w.at.z) < (w.radius || 14) && !s.honkedAt.includes(w.id)) s.honkedAt.push(w.id);
    }
  }

  function update(dt) {
    const s = S;
    if (!s) return;
    if (s.av) s.av.group.visible = deps.player.mode === 'car';
    if (s.drop.userData.ring) s.drop.userData.ring.scale.setScalar(1 + Math.sin(performance.now() / 220) * 0.12);
    if (s.phase !== 'drive' || dt <= 0) return;
    s.gps.update(dt, deps.player, 'passenger');
    const pl = deps.player;
    s.time += dt;
    const modes = s.cfg.modes || ['car'];
    if (!modes.includes(pl.mode)) { pl.setMode(modes[0]); s.toast(t((s.cfg.lines && s.cfg.lines.stay) || 'mg.passenger.stay')); }

    const sp = Math.abs(pl.speed), prev = Math.abs(s.prevSpeed);
    const decel = (prev - sp) / dt;
    s.prevSpeed = pl.speed;
    // Wall or kerb-stone hit: player.js cuts the speed in a single step.
    if (prev - sp > 9 && decel > 300) { s.events.bumps++; synth.play('bump'); event('bump', s.calmCfg.bump); }
    else if (decel > 38 && prev > 16) {
      s.hardT += dt;
      if (s.hardT > 0.22) { s.hardT = -1; s.events.brakes++; event('brake', s.calmCfg.brake, 2); }
    } else if (decel < 20) s.hardT = Math.max(0, s.hardT);
    if (deps.traffic && deps.traffic.stats) {
      const b = deps.traffic.stats().bumps;
      if (b > s.trafficBumps) { s.events.bumps++; event('bump', s.calmCfg.bump); }
      s.trafficBumps = b;
    }
    // Off the carriageway (pavement, kerbs, sand): a jolt when leaving it, then a slow drain.
    const onC = deps.city && typeof deps.city.onCarriage === 'function';
    if (onC && sp > 2) {
      const on = !!deps.city.onCarriage(pl.pos.x, pl.pos.z, 1.0);
      if (!on && s.onRoad) { s.events.kerbs++; event('kerb', s.calmCfg.kerb, 2.5); }
      if (!on) { s.offT += dt; if (s.offT > 1) s.calm = clamp(s.calm + s.calmCfg.offroad * s.assist * dt, 0, s.calmCfg.max); } else s.offT = 0;
      s.onRoad = on;
    }
    // Smooth, steady driving calms the passenger down.
    if (sp > 8 && s.time - s.lastEvent > 3 && Math.abs(decel) < 20) s.calm = clamp(s.calm + s.calmCfg.smooth * dt, 0, s.calmCfg.max);

    // Waiting for people: stopped with someone on foot just ahead.
    if (sp < 1) s.stopT += dt; else s.stopT = 0;
    if (s.stopT > 1.5 && !s.cd.waitArmed) {
      if (personAhead(pl, 16)) { s.cd.waitArmed = true; s.events.waits++; event('wait', s.calmCfg.waitCrossing, 8); }
    }
    if (sp > 3) s.cd.waitArmed = false;
    for (const w of s.cfg.waitSpots || []) {
      if (s.waited.includes(w.id) || s.honkedAt.includes(w.id)) continue;
      const inSpot = Math.hypot(pl.pos.x - w.at.x, pl.pos.z - w.at.z) < (w.radius || 14);
      s.spotT[w.id] = inSpot && sp < 1.2 ? (s.spotT[w.id] || 0) + dt : 0;
      if (s.spotT[w.id] > (w.seconds || 3)) { s.waited.push(w.id); event('wait', s.calmCfg.waitCrossing, 0); if (w.toast) s.toast(t(w.toast)); }
    }

    if (s.calm <= 0) { fail('calm'); return; }
    if (s.limit && s.time > s.limit) { fail('time'); return; }
    if (Math.hypot(pl.pos.x - s.cfg.at.x, pl.pos.z - s.cfg.at.z) < (s.cfg.radius || 10) && sp < 8) { win(); return; }
    hud();
  }

  function personAhead(pl, range) {
    const people = deps.crowd && deps.crowd.npcs;
    if (!people) return false;
    const fx = Math.sin(pl.heading), fz = Math.cos(pl.heading);
    for (const n of people) {
      const dx = n.x - pl.pos.x, dz = n.z - pl.pos.z;
      if (Math.abs(dx) > range || Math.abs(dz) > range) continue;
      const al = dx * fx + dz * fz;
      if (al > 0 && al < range && Math.abs(dx * fz - dz * fx) < 7) return true;
    }
    return false;
  }

  function hud() {
    const s = S;
    const v = s.calm / s.calmCfg.max;
    const bar = s.ov.$('.mg-bar i');
    bar.style.width = v * 100 + '%';
    bar.style.background = v > 0.6 ? '#2ec4b6' : v > 0.3 ? '#ffb347' : '#e8364f';
    s.ov.$('.ps-face').textContent = t(v > 0.6 ? 'mg.passenger.calm' : v > 0.3 ? 'mg.passenger.nervous' : 'mg.passenger.panic');
    s.ov.$('.ps-val').textContent = `${Math.round(s.calm)}`;
    s.ov.$('.ps-time').textContent = s.limit ? t('mg.passenger.timeLeft', { t: fmtTime(s.limit - s.time) }) : fmtTime(s.time);
    const pl = deps.player.pos;
    const m = Math.hypot(pl.x - s.cfg.at.x, pl.z - s.cfg.at.z) / 0.25;
    s.ov.$('.ps-dist').textContent = m > 1000 ? t('mg.ui.km', { d: (m / 1000).toFixed(1) }) : t('mg.ui.m', { d: Math.round(m) });
  }

  function results(ok, extra = {}) {
    const s = S;
    const effects = mergeEffects(...(s.cfg.waitSpots || []).flatMap((w) => [
      s.waited.includes(w.id) ? w.effects : null, s.honkedAt.includes(w.id) ? w.honkEffects : null]));
    return { ok, calm: Math.round(s.calm), time: +s.time.toFixed(1), tries: s.tries + 1, events: { ...s.events }, waited: s.waited.slice(),
      honkedAt: s.honkedAt.slice(), effects, quit: false, ...extra };
  }

  function win() {
    const s = S;
    s.phase = 'card';
    s.gps.clear();
    s.result = results(true);
    synth.play('win');
    s.closeCard = showCard(s.ov.root, { title: t('mg.passenger.passTitle'), big: `${Math.round(s.calm)}`,
      lines: [t('mg.passenger.summary', { time: fmtTime(s.time), brakes: s.events.brakes, bumps: s.events.bumps, honks: s.events.honks })],
      buttons: [{ label: t('mg.ui.continue'), key: ['Enter', 'KeyF'], onClick: () => end(s.result) }] });
    if (s.cfg.autoContinue) setTimeout(() => S === s && s.closeCard && s.closeCard.fire(0), 600);
  }

  function fail(why) {
    const s = S;
    s.phase = 'card';
    s.gps.clear();
    s.result = results(false, { reason: why });
    synth.play('fail');
    const lines = [t(s.cfg.failLine || 'mg.passenger.failLine')];
    if (s.tries + 1 >= 2) lines.push(t('mg.passenger.assist'));
    s.closeCard = showCard(s.ov.root, { title: t(why === 'time' ? 'mg.passenger.timeUp' : 'mg.passenger.failTitle'), lines,
      buttons: [
        { label: t('mg.ui.retry'), key: ['Enter', 'KeyF'], onClick: () => { s.tries++; reset(); } },
        { label: t('mg.ui.quit'), key: ['Escape'], alt: true, onClick: () => end({ ...s.result, quit: true }) },
      ] });
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
    s.offKeys();
    s.gps.clear();
    if (s.av && s.av.group.parent) s.av.group.parent.remove(s.av.group);
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
    get active() { return !!S; },
    get blocksPlayer() { return !!S && S.phase !== 'drive'; },
    debug: {
      state: () => (S ? { phase: S.phase, calm: S.calm, time: S.time, events: { ...S.events }, waited: S.waited.slice(), honked: S.honkedAt.slice() } : null),
      event: (kind, amount) => S && event(kind, amount ?? S.calmCfg[kind] ?? -5, 0),
      honk: () => onKey({ code: (S && S.cfg.honkKey) || 'KeyH', repeat: false }),
      card: (i = 0) => S && S.closeCard && S.closeCard.fire(i),
    },
  };
}
