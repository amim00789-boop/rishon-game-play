// Phone camera mode: walk around, press C to raise the phone, frame a target (an NPC or a
// landmark) inside the viewfinder and take the shot, then pick a caption. Captions carry story
// effects and like counts (the snarky one gets the most likes; that is the point of M9).
//
//   const res = await photo.start({
//     targets: [{ id: 'water_tower', at: {x,z}, y: 18, radius: 140, label: 'quest.m9.shot.tower',
//                 captions: [{ text: 'quest.m9.c.tower_kind', tone: 'kind', effects: { scale: 1 } }, ...] },
//               { id: 'grisha', get: () => ({ x, y, z }), label: '...' }],   // moving NPC: get() each frame
//     need: 6,                                // shots required (default: all targets)
//     captions: [...],                        // default captions for targets without their own
//   });
//   // res = { ok, shots: [{ id, caption, text, tone, likes, effects }], likes, effects, flags, quit }
//
// Rules for a valid shot: target inside `radius` (default 90) and beyond `minDist` (default 3),
// within `cone` degrees (default 25) of the view centre and not hidden behind a building.
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, cameraRig, keyListener, toaster, iconSprite, mergeEffects, clamp, groundY, surfaceFn, rich, showCard, jumpToStart } from './common.js';
import { getSynth } from './synth.js';

const CSS = `
.mg-photo .ph-hud { left: 50%; top: 12px; transform: translateX(-50%); width: 260px; }
.mg-photo .ph-list { margin: 6px 0 0; padding: 0; list-style: none; font-size: 13px; }
.mg-photo .ph-list li { padding: 1px 0; }
.mg-photo .ph-list li.done { text-decoration: line-through; opacity: 0.55; }
.mg-photo .ph-hint { margin-top: 6px; font-size: 12px; font-weight: 800; opacity: 0.8; }
.mg-photo .ph-cam { position: absolute; inset: 0; pointer-events: auto; cursor: crosshair; touch-action: none; }
.mg-photo .ph-cam::before, .mg-photo .ph-cam::after { content: ""; position: absolute; left: 0; right: 0; height: 9vh; background: #0b0f18; }
.mg-photo .ph-cam::before { top: 0; } .mg-photo .ph-cam::after { bottom: 0; }
.mg-photo .ph-vf { position: absolute; left: 50%; top: 50%; width: min(56vw, 70vh); height: min(38vw, 48vh); transform: translate(-50%, -50%); }
.mg-photo .ph-vf i { position: absolute; width: 34px; height: 34px; border: 0 solid #fff; filter: drop-shadow(0 1px 0 #23324a); }
.mg-photo .ph-vf i:nth-child(1) { left: 0; top: 0; border-left-width: 5px; border-top-width: 5px; }
.mg-photo .ph-vf i:nth-child(2) { right: 0; top: 0; border-right-width: 5px; border-top-width: 5px; }
.mg-photo .ph-vf i:nth-child(3) { left: 0; bottom: 0; border-left-width: 5px; border-bottom-width: 5px; }
.mg-photo .ph-vf i:nth-child(4) { right: 0; bottom: 0; border-right-width: 5px; border-bottom-width: 5px; }
.mg-photo .ph-vf.lock i { border-color: #2ec4b6; }
.mg-photo .ph-dot { position: absolute; left: 50%; top: 50%; width: 10px; height: 10px; margin: -5px; border-radius: 50%; border: 2px solid #fff; }
.mg-photo .ph-cap { position: absolute; left: 50%; bottom: calc(9vh + 12px); transform: translateX(-50%); color: #fff; font-weight: 900;
  font-size: 16px; text-shadow: 0 2px 0 #23324a; white-space: nowrap; }
.mg-photo .ph-top { position: absolute; left: 50%; top: 2vh; transform: translateX(-50%); color: #fff; font-weight: 800; font-size: 13px; opacity: 0.9; white-space: nowrap; }
.mg-photo .ph-flash { position: absolute; inset: 0; background: #fff; opacity: 0; transition: opacity 0.35s; pointer-events: none; }
.mg-photo .ph-card { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 24px); overflow: auto; pointer-events: auto; text-align: start; }
.mg-photo .ph-card img, .mg-photo .ph-card .ph-ph { display: block; width: 100%; aspect-ratio: 16 / 10; border: 3px solid #23324a; border-radius: 8px;
  background: linear-gradient(135deg, #7cc8f5, #ffe3b0); object-fit: cover; margin: 6px 0; max-height: 34vh; }
.mg-photo .ph-like { font-size: 12px; font-weight: 800; opacity: 0.7; margin-inline-start: 6px; }
`;
const TONE_LIKES = { kind: 35, funny: 80, snark: 380 };

export function createPhoto(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  const surface = surfaceFn(deps);
  addStyle('mg-style-photo', CSS);
  let S = null;
  const fwd = new THREE.Vector3(), eye = new THREE.Vector3(), look = new THREE.Vector3(), tmp = new THREE.Vector3();

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const ov = createOverlay('mg-photo',
        '<div class="mg-panel ph-hud"><div class="mg-title ph-title"></div><div class="ph-prog mg-small"></div><ul class="ph-list"></ul><div class="ph-hint"></div></div>' +
        '<div class="ph-cam mg-hide"><div class="ph-top"></div><div class="ph-vf"><i></i><i></i><i></i><i></i></div><div class="ph-dot"></div><div class="ph-cap"></div></div>' +
        '<div class="ph-flash"></div>');
      ov.$('.ph-title').textContent = t(config.title || 'mg.photo.title');
      ov.$('.ph-hint').innerHTML = rich(t('mg.photo.hint', { k: cap(config.key || 'KeyC') }));
      ov.$('.ph-top').innerHTML = rich(t('mg.photo.camHint'));
      const targets = (config.targets || []).map((tg, i) => ({ ...tg, id: tg.id || `shot${i}`, done: false, marker: null }));
      const root = new THREE.Group();
      root.name = 'mg-photo';
      deps.scene.add(root);
      S = { cfg: config, ov, root, targets, need: Math.min(config.need || targets.length, targets.length), shots: [], resolve, phase: 'roam',
        toast: toaster(ov.root), rig: cameraRig(deps.scene, deps.camera), cam: null, yaw: 0, pitch: 0, fov: 55, offKeys: keyListener(onKey) };
      if (config.markers !== false) {
        for (const tg of targets) { tg.marker = iconSprite('◉', '#7fe0d6', '#23324a', 3.4); root.add(tg.marker); }
      }
      const camEl = ov.$('.ph-cam');
      let down = null;
      camEl.addEventListener('pointerdown', (e) => { e.preventDefault(); down = { x: e.clientX, y: e.clientY, moved: 0 }; try { camEl.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ } });
      camEl.addEventListener('pointermove', (e) => {
        if (!down || !S) return;
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        down.moved += Math.abs(dx) + Math.abs(dy);
        down.x = e.clientX; down.y = e.clientY;
        S.yaw -= dx * 0.0035 * (S.fov / 55); S.pitch = clamp(S.pitch - dy * 0.0035 * (S.fov / 55), -0.9, 0.9);
      });
      camEl.addEventListener('pointerup', () => { if (down && down.moved < 8) shutter(); down = null; });
      camEl.addEventListener('wheel', (e) => { e.preventDefault(); if (S) S.fov = clamp(S.fov * Math.exp(e.deltaY * 0.001), 20, 60); }, { passive: false });
      list();
      if (config.start && config.jump !== false) {
        S.phase = 'jump';
        const s0 = S;
        jumpToStart(deps, config.start).then(() => { if (S === s0) S.phase = 'roam'; });
      }
    });
  }

  const cap = (code) => code.replace(/^Key|^Digit/, '');
  const label = (tg) => (tg.label ? t(tg.label) : tg.id);

  function list() {
    const s = S;
    const ul = s.ov.$('.ph-list');
    ul.innerHTML = '';
    for (const tg of s.targets) {
      const li = document.createElement('li');
      li.className = tg.done ? 'done' : '';
      li.textContent = label(tg);
      ul.appendChild(li);
    }
    s.ov.$('.ph-prog').textContent = t('mg.photo.progress', { n: s.shots.length, need: s.need });
  }

  function targetPos(tg, out) {
    if (typeof tg.get === 'function') {
      const p = tg.get();
      if (p) return out.set(p.x, (p.y ?? groundY(surface, p.x, p.z)) + (tg.y ?? 3), p.z);
    }
    return out.set(tg.at.x, groundY(surface, tg.at.x, tg.at.z) + (tg.y ?? 3), tg.at.z);
  }

  function enterCam() {
    const s = S;
    s.phase = 'aim';
    deps.camera.getWorldDirection(fwd);
    s.yaw = Math.atan2(fwd.x, fwd.z);
    s.pitch = clamp(Math.asin(clamp(fwd.y, -1, 1)), -0.5, 0.5);
    s.fov = 50;
    s.cam = s.rig.take();
    s.ov.$('.ph-cam').classList.remove('mg-hide');
    s.ov.$('.ph-hud').classList.add('mg-hide');
    document.body.classList.add('mg-phone');
    for (const tg of s.targets) if (tg.marker) tg.marker.visible = false;
    synth.play('click');
  }
  function exitCam() {
    const s = S;
    if (s.cam) { s.cam.release(); s.cam = null; }
    if (deps.player.root) deps.player.root.visible = true;
    document.body.classList.remove('mg-phone');
    s.phase = 'roam';
    s.ov.$('.ph-cam').classList.add('mg-hide');
    s.ov.$('.ph-hud').classList.remove('mg-hide');
  }

  function onKey(e) {
    const s = S;
    if (!s || e.repeat) return;
    const key = s.cfg.key || 'KeyC';
    if (s.phase === 'roam' && e.code === key) { enterCam(); return; }
    if (s.phase === 'aim') {
      if (e.code === key || e.code === 'Escape') { e.preventDefault(); exitCam(); return; }
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyF') { e.preventDefault(); shutter(); }
    }
  }

  // Which remaining target is framed right now (best = closest to the view centre)?
  function framed() {
    const s = S;
    let best = null, bestA = Infinity;
    for (const tg of s.targets) {
      if (tg.done) continue;
      targetPos(tg, tmp);
      const dx = tmp.x - eye.x, dy = tmp.y - eye.y, dz = tmp.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > (tg.radius || 90) || d < (tg.minDist ?? 3)) continue;
      const cos = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d;
      const ang = Math.acos(clamp(cos, -1, 1)) * 180 / Math.PI;
      // Zooming in narrows what counts as "in frame".
      if (ang > (tg.cone || s.cfg.cone || 25) * Math.min(1, s.fov / 45)) continue;
      if (deps.collision && deps.collision.raycast) {
        const h = deps.collision.raycast(eye.x, eye.z, tmp.x, tmp.z, true, { skipBelow: eye.y - 1, skipThin: 2 });
        const flat = Math.hypot(dx, dz);
        if (h < 1 && h * flat < flat - (tg.losPad ?? 10)) continue;
      }
      if (ang < bestA) { bestA = ang; best = tg; }
    }
    return best;
  }

  function shutter() {
    const s = S;
    if (!s || s.phase !== 'aim') return;
    synth.play('shutter');
    const fl = s.ov.$('.ph-flash');
    fl.style.transition = 'none'; fl.style.opacity = 0.9; void fl.offsetWidth; fl.style.transition = ''; fl.style.opacity = 0;
    const tg = framed();
    if (!tg) { s.toast(t('mg.photo.miss')); return; }
    tg.done = true;
    const img = snapshot();
    exitCam();
    s.phase = 'caption';
    captionCard(tg, img);
  }

  // A small render of the shot for the caption card (needs the renderer; optional).
  function snapshot() {
    const r = deps.renderer;
    if (!r) return null;
    try {
      const W = 320, H = 200;
      const rt = new THREE.WebGLRenderTarget(W, H);
      const cam = new THREE.PerspectiveCamera(S.fov, W / H, 0.5, 1500);
      cam.position.copy(eye); cam.lookAt(look);
      cam.updateMatrixWorld(true);
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      r.render(deps.scene, cam);
      const px = new Uint8Array(W * H * 4);
      r.readRenderTargetPixels(rt, 0, 0, W, H, px);
      r.setRenderTarget(prev);
      rt.dispose();
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const im = g.createImageData(W, H);
      // Render targets hold linear colour; encode to sRGB and flip rows for the canvas.
      const lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) { const v = i / 255; lut[i] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const si = ((H - 1 - y) * W + x) * 4, di = (y * W + x) * 4;
        im.data[di] = lut[px[si]]; im.data[di + 1] = lut[px[si + 1]]; im.data[di + 2] = lut[px[si + 2]]; im.data[di + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      return c.toDataURL('image/jpeg', 0.8);
    } catch (e) { console.warn('[photo] snapshot failed', e); return null; }
  }

  function captionCard(tg, img) {
    const s = S;
    const opts = tg.captions || s.cfg.captions || null;
    const card = document.createElement('div');
    card.className = 'mg-panel ph-card';
    const title = document.createElement('div');
    title.className = 'mg-title';
    title.textContent = label(tg);
    card.appendChild(title);
    if (img) { const im = document.createElement('img'); im.src = img; card.appendChild(im); } else { const ph = document.createElement('div'); ph.className = 'ph-ph'; card.appendChild(ph); }
    s.ov.root.appendChild(card);
    if (!opts || !opts.length) {
      const btn = document.createElement('button');
      btn.className = 'mg-btn'; btn.innerHTML = rich(t('mg.ui.continue'));
      card.appendChild(btn);
      const done = () => { off(); card.remove(); record(tg, -1, null); };
      btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); done(); });
      const off = armKeys((e) => { if (e.code === 'Enter' || e.code === 'KeyF' || e.code === 'Space') done(); });
      s.closeCaption = () => { off(); card.remove(); };
      return;
    }
    const q = document.createElement('div');
    q.className = 'mg-small';
    q.textContent = t('mg.photo.pickCaption');
    card.appendChild(q);
    const ul = document.createElement('ol');
    ul.className = 'mg-opts';
    const pick = (i) => { off(); card.remove(); record(tg, i, opts[i]); };
    opts.forEach((o, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<kbd dir="ltr">${i + 1}</kbd> ${rich(t(o.text))}`;
      li.addEventListener('pointerdown', (e) => { e.stopPropagation(); pick(i); });
      ul.appendChild(li);
    });
    card.appendChild(ul);
    const off = armKeys((e) => { const n = /^(Digit|Numpad)(\d)$/.exec(e.code); if (n && +n[2] >= 1 && +n[2] <= opts.length) pick(+n[2] - 1); });
    s.closeCaption = () => { off(); card.remove(); };
  }

  function armKeys(fn) {
    let off = null;
    const timer = setTimeout(() => { off = keyListener((e) => { if (!e.repeat) fn(e); }); }, 150);
    return () => { clearTimeout(timer); if (off) off(); };
  }

  function record(tg, i, opt) {
    const s = S;
    s.closeCaption = null;
    const tone = opt ? opt.tone || null : null;
    const base = opt ? opt.likes ?? TONE_LIKES[tone] ?? 50 : 0;
    const likes = opt ? Math.round(base * (0.85 + Math.random() * 0.3)) : 0;
    s.shots.push({ id: tg.id, caption: i, text: opt ? opt.text : null, tone, likes, effects: opt ? opt.effects || null : null });
    if (opt) { synth.play('ding'); s.toast(t('mg.photo.posted', { likes }), 1800); }
    try { s.cfg.onShot && s.cfg.onShot(s.shots[s.shots.length - 1]); } catch (_) { /* caller's problem */ }
    if (tg.marker) { s.root.remove(tg.marker); tg.marker = null; }
    s.phase = 'roam';
    list();
    if (s.shots.length >= s.need) finish();
  }

  function finish() {
    const s = S;
    s.phase = 'card';
    const effects = mergeEffects(...s.shots.map((x) => x.effects));
    s.result = { ok: true, shots: s.shots.slice(), likes: s.shots.reduce((a, x) => a + x.likes, 0), effects, flags: effects.flags, quit: false };
    synth.play('win');
    if (s.cfg.noCard) { end(s.result); return; }
    s.closeCard = showCard(s.ov.root, { title: t('mg.photo.doneTitle'), big: `${s.shots.length}/${s.need}`,
      lines: [t('mg.photo.likesLine', { likes: s.result.likes })],
      buttons: [{ label: t('mg.ui.continue'), key: ['Enter', 'KeyF'], onClick: () => end(s.result) }] });
    if (s.cfg.autoContinue) setTimeout(() => S === s && s.closeCard && s.closeCard.fire(0), 600);
  }

  function update(dt, input) {
    const s = S;
    if (!s) return;
    const pl = deps.player;
    if (s.phase === 'roam') {
      for (const tg of s.targets) {
        if (!tg.marker) continue;
        targetPos(tg, tmp);
        tg.marker.visible = true;
        tg.marker.position.set(tmp.x, tmp.y + 4 + Math.sin(performance.now() / 300) * 0.4, tmp.z);
      }
      return;
    }
    if (s.phase !== 'aim') return;
    if (input) {
      const rot = 1.4 * dt * (s.fov / 55);
      if (input.isDown('ArrowLeft', 'KeyA')) s.yaw += rot;
      if (input.isDown('ArrowRight', 'KeyD')) s.yaw -= rot;
      if (input.isDown('ArrowUp', 'KeyW')) s.pitch = clamp(s.pitch + rot, -0.9, 0.9);
      if (input.isDown('ArrowDown', 'KeyS')) s.pitch = clamp(s.pitch - rot, -0.9, 0.9);
      if (input.isDown('KeyQ', 'Minus')) s.fov = clamp(s.fov + 30 * dt, 20, 60);
      if (input.isDown('KeyE', 'Equal')) s.fov = clamp(s.fov - 30 * dt, 20, 60);
    }
    const base = pl.root ? pl.root.position : new THREE.Vector3(pl.pos.x, pl.y || 0, pl.pos.z);
    fwd.set(Math.sin(s.yaw) * Math.cos(s.pitch), Math.sin(s.pitch), Math.cos(s.yaw) * Math.cos(s.pitch));
    eye.set(base.x + Math.sin(s.yaw) * 1.2, base.y + (pl.mode === 'car' ? 5.4 : 4.6), base.z + Math.cos(s.yaw) * 1.2);
    look.copy(eye).add(fwd);
    s.cam.set(eye, look, s.fov);
    s.rig.apply();
    // The player avatar would fill the lens; hide it while the phone is up.
    if (pl.root) pl.root.visible = false;
    const tg = framed();
    s.ov.$('.ph-vf').classList.toggle('lock', !!tg);
    s.ov.$('.ph-cap').textContent = tg ? t('mg.photo.inFrame', { name: label(tg) }) : '';
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
    if (s.cam) s.cam.release();
    document.body.classList.remove('mg-phone');
    if (deps.player.root) deps.player.root.visible = true;
    if (s.closeCard) s.closeCard();
    if (s.closeCaption) s.closeCaption();
    s.offKeys();
    deps.scene.remove(s.root);
    s.ov.remove();
  }
  function cancel() {
    const s = S;
    if (!s) return;
    teardown();
    s.resolve({ ok: false, cancelled: true, shots: s.shots.slice() });
  }

  return {
    start, update, cancel,
    get active() { return !!S; },
    // Free roaming between shots; frozen while the phone is up or a caption is being chosen.
    get blocksPlayer() { return !!S && S.phase !== 'roam'; },
    get aiming() { return !!S && S.phase === 'aim'; },
    debug: {
      state: () => (S ? { phase: S.phase, shots: S.shots.length, need: S.need, yaw: S.yaw, pitch: S.pitch, framed: S.phase === 'aim' ? (framed() || {}).id || null : null } : null),
      enter: () => S && S.phase === 'roam' && enterCam(),
      // Point the phone at a target (tests): sets yaw/pitch from the current eye position.
      aimAt: (id) => {
        const s = S; if (!s) return false;
        const tg = s.targets.find((x) => x.id === id); if (!tg) return false;
        if (s.phase === 'roam') enterCam();
        update(0, null);
        targetPos(tg, tmp);
        s.yaw = Math.atan2(tmp.x - eye.x, tmp.z - eye.z);
        s.pitch = Math.atan2(tmp.y - eye.y, Math.hypot(tmp.x - eye.x, tmp.z - eye.z));
        update(0, null);
        return true;
      },
      shutter: () => shutter(),
      // Picks caption i on the open caption card (the card listens for keys after 150 ms).
      caption: (i) => window.dispatchEvent(new KeyboardEvent('keydown', { code: `Digit${i + 1}` })),
      card: (i = 0) => S && S.closeCard && S.closeCard.fire(i),
    },
  };
}
