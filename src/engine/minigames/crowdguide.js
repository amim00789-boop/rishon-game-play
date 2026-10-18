// Lead groups of people through the dark (M14 blackout). Each group waits at its spot; walk up to
// it and it follows you in a line along the path you walked. Followers are slower than a walk:
// run or get too far ahead and the ones at the back lose you (a "?" over them) and stop until you
// come back. Bring everyone to a lit exit before the generous clock runs out. Helpers (earned in
// earlier missions) can lead a group out on their own.
//
//   const res = await crowdguide.start({
//     groups: [{ id: 'seniors', at: {x,z}, size: 8, archetypes: ['savta', 'grisha'], speed: 7.5, helper: false }],
//     exits: [{ at: {x,z}, radius: 10 }],
//     limit: 300, leash: 24, regroup: 9, dark: true,
//   });
//   // res = { ok, time, saved, total, lostEvents, tries, groups: [{ id, saved, size }], quit }
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, showCard, toaster, avatarFactory, beamMarker, iconSprite, groundY, surfaceFn, fmtTime, clamp, jumpToStart } from './common.js';
import { getSynth } from './synth.js';

const CSS = `
.mg-dark { position: fixed; inset: 0; pointer-events: none; background: radial-gradient(ellipse 34% 40% at 50% 58%, rgba(6, 10, 24, 0) 0%, rgba(6, 10, 24, 0.55) 55%, rgba(6, 10, 24, 0.9) 100%); }
.mg-crowd .cg-ind { position: absolute; inset: 0; }
.mg-crowd .cg-hud { left: 50%; top: 12px; transform: translateX(-50%); width: 260px; }
.mg-crowd .cg-time { font-size: 26px; font-weight: 900; }
.mg-crowd .cg-row { display: flex; justify-content: space-between; font-weight: 800; font-size: 13px; }
`;
const DEFAULT_ARCH = ['savta', 'russian_speaking_grandpa', 'haredi_man', 'dati_leumi_woman', 'hipster', 'mizrahi_street_guy', 'older_woman', 'skater_kid', 'mom_stroller', 'secular_woman'];

export function createCrowdGuide(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  const surface = surfaceFn(deps);
  addStyle('mg-style-crowd', CSS);
  let S = null;
  const v3 = new THREE.Vector3();

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const ov = createOverlay('mg-crowd',
        '<canvas class="cg-ind"></canvas><div class="mg-panel cg-hud"><div class="mg-title cg-title"></div>' +
        '<div class="cg-time mg-num"></div><div class="cg-row"><span class="cg-saved"></span><span class="cg-lost"></span></div><div class="mg-small cg-hint"></div></div>');
      ov.$('.cg-title').textContent = t(config.title || 'mg.crowd.title');
      ov.$('.cg-hint').textContent = t('mg.crowd.hint');
      // The darkness sits under the game HUD (first in <body>, no z-index), so dialogue and the
      // minimap stay readable; the minigame's own panels are above it.
      const dark = document.createElement('div');
      dark.className = 'mg-dark';
      if (config.dark !== false) document.body.insertBefore(dark, document.body.firstChild);
      const root = new THREE.Group();
      root.name = 'mg-crowdguide';
      deps.scene.add(root);
      S = { cfg: config, ov, root, dark, resolve, tries: 0, toast: toaster(ov.root), groups: [], members: [], exits: [], trail: [], phase: 'load' };
      for (const ex of config.exits || []) {
        const m = beamMarker(0xffd27a, 3.5, 40);
        m.position.set(ex.at.x, groundY(surface, ex.at.x, ex.at.z), ex.at.z);
        const lamp = new THREE.PointLight(0xffd27a, 60, 40, 1.6);
        lamp.position.set(0, 7, 0);
        m.add(lamp);
        root.add(m);
        S.exits.push({ ...ex, radius: ex.radius || 10, mesh: m });
      }
      if (config.dark !== false) darken(S);
      // A fixed start (config.start = { x, z, heading? }): fade, place the player there, fade in.
      const s0 = S;
      const jump = config.start && config.jump !== false ? jumpToStart(deps, { ...config.start, mode: config.start.mode || 'walk' }) : Promise.resolve();
      Promise.all([build(S), jump]).then(() => { if (S === s0) reset(); });
    });
  }

  async function build(s) {
    const make = await avatarFactory(deps);
    if (S !== s) return;
    let seed = 300;
    for (const [gi, g] of (s.cfg.groups || []).entries()) {
      const grp = { def: g, id: g.id || `group${gi}`, members: [], marker: iconSprite('!', '#ffcb3d', '#23324a', 3.2), size: g.size || 8 };
      s.root.add(grp.marker);
      const arch = g.archetypes && g.archetypes.length ? g.archetypes : DEFAULT_ARCH;
      for (let i = 0; i < grp.size; i++) {
        let av = null;
        try { av = make({ archetype: arch[i % arch.length], seed: seed++ }); } catch (e) { console.warn('[crowdguide] avatar failed', e); }
        if (!av || !av.group) continue;
        try { av.setMode && av.setMode('idle'); } catch (_) { /* optional */ }
        s.root.add(av.group);
        const m = { grp, av, home: null, x: 0, z: 0, yaw: 0, state: 'wait', speed: (g.speed || 7.5) * (0.92 + Math.random() * 0.16) };
        grp.members.push(m);
        s.members.push(m);
      }
      s.groups.push(grp);
    }
  }

  function reset() {
    const s = S;
    if (s.closeCard) { s.closeCard(); s.closeCard = null; }
    const assist = s.tries >= 2;
    s.limit = (s.cfg.limit || 300) * (1 + 0.4 * Math.min(s.tries, 2));
    s.leash = (s.cfg.leash || 24) * (assist ? 1.3 : 1);
    s.time = 0; s.lostEvents = 0; s.trail = []; s.phase = 'play';
    for (const grp of s.groups) {
      const c = grp.def.at;
      grp.members.forEach((m, i) => {
        const a = (i / grp.members.length) * Math.PI * 2, r = 2.2 + (i % 3) * 1.4;
        let p = { x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r };
        if (deps.collision) p = deps.collision.findFree(p.x, p.z, 1.0);
        Object.assign(m, { x: p.x, z: p.z, state: grp.def.helper ? 'helper' : 'wait', av: m.av, yaw: a + Math.PI });
        m.av.group.visible = true;
        place(m, 0);
      });
      grp.marker.visible = true;
      grp.saved = 0;
      if (grp.def.helper) s.toast(t('mg.crowd.helperGo'));
    }
    hud();
  }

  function place(m, speed, dt = 0) {
    const y = groundY(surface, m.x, m.z, Infinity);
    m.av.group.position.set(m.x, y, m.z);
    m.av.group.rotation.y = m.yaw;
    try { m.av.update(dt, speed); } catch (_) { /* animation only */ }
  }

  function update(dt) {
    const s = S;
    if (!s || s.phase !== 'play') { drawIndicators(); return; }
    const pl = deps.player;
    s.time += dt;
    // Breadcrumbs: where the player walked is where the line walks.
    const last = s.trail[s.trail.length - 1];
    if (!last || Math.hypot(pl.pos.x - last.x, pl.pos.z - last.z) > 1.2) {
      s.trail.push({ x: pl.pos.x, z: pl.pos.z });
      if (s.trail.length > 400) s.trail.shift();
    }
    let k = 0;
    const regroup = s.cfg.regroup || 9;
    for (const m of s.members) {
      const dP = Math.hypot(m.x - pl.pos.x, m.z - pl.pos.z);
      if (m.state === 'wait' || m.state === 'lost') {
        if (dP < regroup) {
          if (m.state === 'lost') s.toast(t('mg.crowd.regrouped'));
          m.state = 'follow';
          try { m.av.setMode && m.av.setMode('walk'); } catch (_) { /* optional */ }
        } else { place(m, 0, dt); continue; }
      }
      if (m.state === 'follow') {
        if (dP > s.leash) {
          m.state = 'lost';
          s.lostEvents++;
          s.toast(t('mg.crowd.lost'));
          synth.play('miss');
          try { m.av.setMode && m.av.setMode('idle'); } catch (_) { /* optional */ }
          continue;
        }
        // Slot k in the line: k + 2 crumbs behind the player.
        const idx = Math.max(0, s.trail.length - 3 - Math.floor(k * 1.1));
        const tgt = s.trail[idx] || pl.pos;
        k++;
        step(m, tgt, dt, dP < 3 ? 0 : m.speed);
        const ex = exitAt(m);
        if (ex) { m.state = 'exit'; m.exit = ex; m.grp.saved++; synth.play('ding', null, 0.5); }
      } else if (m.state === 'helper') {
        const ex = nearestExit(m);
        step(m, ex.at, dt, m.speed);
        if (exitAt(m)) { m.state = 'exit'; m.exit = ex; m.grp.saved++; }
      } else if (m.state === 'exit') {
        step(m, m.exit.at, dt, m.speed);
        if (Math.hypot(m.x - m.exit.at.x, m.z - m.exit.at.z) < 2.5) { m.state = 'safe'; m.av.group.visible = false; }
      }
    }
    for (const grp of s.groups) {
      const waiting = grp.members.filter((m) => m.state === 'wait' || m.state === 'lost');
      grp.marker.visible = waiting.length > 0;
      if (waiting.length) {
        const c = waiting[0];
        grp.marker.position.set(c.x, groundY(surface, c.x, c.z) + 8 + Math.sin(performance.now() / 260) * 0.4, c.z);
      }
    }
    const saved = s.members.filter((m) => m.state === 'exit' || m.state === 'safe').length;
    if (saved >= s.members.length && s.members.length) { win(); return; }
    if (s.time > s.limit) { fail(); return; }
    hud(saved);
    drawIndicators();
  }

  function step(m, tgt, dt, speed) {
    const dx = tgt.x - m.x, dz = tgt.z - m.z, d = Math.hypot(dx, dz);
    let v = 0;
    if (d > 0.6 && speed > 0) {
      v = Math.min(speed, d * 4);
      const mv = Math.min(d, v * dt);
      m.x += (dx / d) * mv; m.z += (dz / d) * mv;
      m.yaw += Math.atan2(Math.sin(Math.atan2(dx, dz) - m.yaw), Math.cos(Math.atan2(dx, dz) - m.yaw)) * Math.min(1, dt * 8);
      if (deps.collision) { const p = { x: m.x, z: m.z }; deps.collision.resolve(p, 0.9); m.x = p.x; m.z = p.z; }
    }
    place(m, v, dt);
  }

  const exitAt = (m) => S.exits.find((e) => Math.hypot(m.x - e.at.x, m.z - e.at.z) < e.radius) || null;
  const nearestExit = (m) => S.exits.reduce((b, e) => (!b || Math.hypot(m.x - e.at.x, m.z - e.at.z) < Math.hypot(m.x - b.at.x, m.z - b.at.z) ? e : b), null);

  function hud(saved = 0) {
    const s = S;
    s.ov.$('.cg-time').textContent = fmtTime(s.limit - s.time);
    s.ov.$('.cg-saved').textContent = t('mg.crowd.saved', { n: saved, total: s.members.length });
    const lost = s.members.filter((m) => m.state === 'lost').length;
    s.ov.$('.cg-lost').textContent = lost ? t('mg.crowd.lostCount', { n: lost }) : '';
  }

  // Screen-edge arrows to the lit exits and to groups still waiting: in the dark the world
  // markers are hard to see.
  function drawIndicators() {
    const s = S;
    if (!s) return;
    const c = s.ov.$('.cg-ind');
    const W = window.innerWidth, H = window.innerHeight;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (s.phase !== 'play') return;
    const cam = deps.camera;
    cam.updateMatrixWorld();
    const items = s.exits.map((e) => ({ x: e.at.x, z: e.at.z, color: '#ffd27a' }))
      .concat(s.groups.filter((gr) => gr.marker.visible).map((gr) => ({ x: gr.marker.position.x, z: gr.marker.position.z, color: '#ffcb3d', bang: true })));
    for (const it of items) {
      v3.set(it.x, groundY(surface, it.x, it.z) + 3, it.z).project(cam);
      const behind = v3.z > 1;
      let x = (v3.x * 0.5 + 0.5) * W, y = (-v3.y * 0.5 + 0.5) * H;
      if (behind) { x = W - x; y = H - y; }
      const on = !behind && x > 30 && x < W - 30 && y > 30 && y < H - 30;
      if (on) continue;
      const cx = W / 2, cy = H / 2, ang = Math.atan2(y - cy, x - cx);
      const kx = (W / 2 - 34) / Math.max(1e-6, Math.abs(Math.cos(ang))), ky = (H / 2 - 34) / Math.max(1e-6, Math.abs(Math.sin(ang)));
      const k = Math.min(kx, ky);
      g.save();
      g.translate(cx + Math.cos(ang) * k, cy + Math.sin(ang) * k);
      g.rotate(ang);
      g.fillStyle = it.color; g.strokeStyle = '#23324a'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(16, 0); g.lineTo(-10, 12); g.lineTo(-5, 0); g.lineTo(-10, -12); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }
  }

  // ---- darkness ----
  function darken(s) {
    s.lights = [];
    deps.scene.traverse((o) => { if (o.isLight && !o.userData.mgKeep && !isOwn(o, s)) { s.lights.push([o, o.intensity]); o.intensity *= 0.16; } });
    if (deps.scene.background && deps.scene.background.isColor) { s.bg = deps.scene.background.clone(); deps.scene.background.setHex(0x0b1022); }
    if (deps.scene.fog && deps.scene.fog.color) { s.fogColor = deps.scene.fog.color.clone(); deps.scene.fog.color.setHex(0x0b1022); }
    if (deps.sky && deps.sky.dome) { s.domeVis = deps.sky.dome.visible; deps.sky.dome.visible = false; }
    // The player's torch.
    const torch = new THREE.SpotLight(0xfff1c8, 400, 70, 0.55, 0.5, 1.4);
    torch.position.set(0, 6, -1);
    torch.target.position.set(0, 0, 18);
    torch.userData.mgKeep = true;
    const glow = new THREE.PointLight(0xfff1c8, 25, 16, 1.5);
    glow.position.set(0, 5, 0);
    glow.userData.mgKeep = true;
    if (deps.player.root) { deps.player.root.add(torch, torch.target, glow); }
    s.torch = [torch, glow];
  }
  const isOwn = (o, s) => { let p = o; while (p) { if (p === s.root) return true; p = p.parent; } return false; };
  function lightUp(s) {
    for (const [o, i] of s.lights || []) o.intensity = i;
    if (s.bg) deps.scene.background.copy(s.bg);
    if (s.fogColor) deps.scene.fog.color.copy(s.fogColor);
    if (deps.sky && deps.sky.dome && s.domeVis !== undefined) deps.sky.dome.visible = s.domeVis;
    for (const l of s.torch || []) { if (l.parent) l.parent.remove(l); if (l.target && l.target.parent) l.target.parent.remove(l.target); l.dispose && l.dispose(); }
  }

  function win() {
    const s = S;
    s.phase = 'card';
    s.result = { ok: true, time: +s.time.toFixed(1), saved: s.members.length, total: s.members.length, lostEvents: s.lostEvents, tries: s.tries + 1,
      groups: s.groups.map((g) => ({ id: g.id, saved: g.saved, size: g.members.length })), quit: false };
    synth.play('win');
    s.closeCard = showCard(s.ov.root, { title: t('mg.crowd.passTitle'), big: fmtTime(s.time), lines: [t('mg.crowd.summary', { n: s.members.length, lost: s.lostEvents })],
      buttons: [{ label: t('mg.ui.continue'), key: ['Enter', 'KeyF'], onClick: () => end(s.result) }] });
    if (s.cfg.autoContinue) setTimeout(() => S === s && s.closeCard && s.closeCard.fire(0), 600);
  }

  function fail() {
    const s = S;
    s.phase = 'card';
    const saved = s.members.filter((m) => m.state === 'exit' || m.state === 'safe').length;
    s.result = { ok: false, time: +s.time.toFixed(1), saved, total: s.members.length, lostEvents: s.lostEvents, tries: s.tries + 1, quit: false };
    synth.play('fail');
    const lines = [t(s.cfg.failLine || 'mg.crowd.failLine')];
    if (s.tries + 1 >= 2) lines.push(t('mg.crowd.assist'));
    s.closeCard = showCard(s.ov.root, { title: t('mg.crowd.failTitle'), big: `${saved}/${s.members.length}`, lines,
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
    lightUp(s);
    s.dark.remove();
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
    get blocksPlayer() { return !!S && S.phase !== 'play'; },
    debug: {
      state: () => (S ? { phase: S.phase, time: S.time, members: S.members.length, states: S.members.reduce((o, m) => { o[m.state] = (o[m.state] || 0) + 1; return o; }, {}), lostEvents: S.lostEvents, trail: S.trail.length } : null),
      card: (i = 0) => S && S.closeCard && S.closeCard.fire(i),
    },
  };
}
