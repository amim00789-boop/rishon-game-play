// Skate session in the pool at the HaTeder skate park: drop in, pump, carve and fly for a timed
// run; tricks chain into combos (points x number of tricks), a bail loses the combo.
//
//   const skate = createSkate(deps);      // deps as for createMinigames (scene, camera, player, t, ...)
//   const r = await skate.start({ seconds: 60 });
//   // r = { ok, score, best, combo, tricks: { id: count }, done: [required ids landed], tries, quit?, cancelled? }
//   per frame: skate.update(dt, input); freeze the player (FROZEN input) while skate.blocksPlayer.
//
// Config: seconds (60), goal (score to pass, null = any run passes), tricks + need (a checklist:
// the run passes once `need` of the listed tricks have landed; ids like 'kickflip', 'grind_rail',
// 'quarter_180' map onto the tricks below by name), at ({x, z}: ride the pool nearest to it; default
// is HaTeder's), best (the score to beat, for the HUD),
// title (key), autoContinue. Pools are the 'skate-bowl' meshes landmarks.js builds (HaTeder, Neot
// Shikma); the start and exit spot is the pool's `exitPoi` (else in front of its south wall).
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, cameraRig, keyListener, toaster, clamp, rich, showCard, placePlayer, countdown } from './common.js';
import { register, i18n } from '../../i18n.js';
import { bowlE } from '../../world/skatebowl.js';
import { Rider } from '../skate/rider.js';

// Text: data/minigames/skate.<lang>.json, registered under `skate`.
let stringsP = null;
export function loadSkateStrings(base = new URL('../../../data/minigames/', import.meta.url).href) {
  if (stringsP) return stringsP;
  const get = (lang) => fetch(`${base}skate.${lang}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`skate.${lang}.json: HTTP ${r.status}`))));
  stringsP = (async () => {
    const fallback = await get('en').catch((e) => { console.warn('[skate] no English strings', e.message); return {}; });
    const active = i18n.lang === 'en' ? fallback : await get(i18n.lang).catch(() => null);
    register('skate', active || fallback, fallback);
  })();
  return stringsP;
}

const CSS = `
.mg-skate .sk-top { left: 50%; top: 12px; transform: translateX(-50%); min-width: 260px; text-align: center; }
.mg-skate .sk-row { display: flex; justify-content: space-between; gap: 14px; font-weight: 800; font-size: 15px; margin-top: 2px; }
.mg-skate .sk-time.low { color: #e8364f; }
.mg-skate .sk-best { font-size: 12px; font-weight: 700; opacity: 0.75; }
.mg-skate .sk-combo { position: absolute; left: 50%; top: 92px; transform: translateX(-50%); text-align: center; pointer-events: none;
  font-weight: 900; color: #fff; -webkit-text-stroke: 1.2px #23324a; text-shadow: 0 3px 0 rgba(35, 50, 74, 0.45); white-space: nowrap; max-width: calc(100vw - 32px); overflow: hidden; }
.mg-skate .sk-combo .names { font-size: 17px; }
.mg-skate .sk-combo .pts { font-size: 24px; }
.mg-skate .sk-combo.lost { color: #ffb3bd; }
.mg-skate .sk-pop { position: absolute; left: 50%; top: 34%; transform: translate(-50%, -50%); font-weight: 900; font-size: 28px; color: #fff;
  -webkit-text-stroke: 1.5px #23324a; text-shadow: 0 4px 0 rgba(35, 50, 74, 0.45); opacity: 0; transition: opacity 0.2s; white-space: nowrap; pointer-events: none; }
.mg-skate .sk-pop.on { opacity: 1; animation: mg-pop 0.35s ease-out; }
.mg-skate .sk-hint { left: 50%; bottom: 22px; transform: translateX(-50%); font-weight: 800; font-size: 15px; white-space: nowrap; max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis; }
.mg-skate .sk-bal { left: 50%; bottom: 66px; transform: translateX(-50%); width: 230px; padding: 5px 10px; }
.mg-skate .sk-bal .track { position: relative; height: 12px; border: 2px solid #23324a; border-radius: 8px;
  background: linear-gradient(90deg, #e8364f 0 12%, #ffcb3d 12% 26%, #7fe0d6 26% 74%, #ffcb3d 74% 88%, #e8364f 88%); }
.mg-skate .sk-bal .needle { position: absolute; top: -5px; width: 6px; height: 18px; margin-left: -3px; background: #23324a; border-radius: 3px; left: 50%; }
.mg-skate .sk-list { inset-inline-end: 14px; top: 12px; font-weight: 700; font-size: 14px; min-width: 150px; }
.mg-skate .sk-list div.on { text-decoration: line-through; opacity: 0.6; }
.mg-skate .sk-list div.on::before { content: '✓ '; }
body.mg-skating .hud-panel, body.mg-skating #hud-map { visibility: hidden; }
`;

// Trick ids the rider emits, and how a checklist name maps onto them.
const TRICKS = ['ollie', 'air', 'kickflip', 'grab', 'spin180', 'spin360', 'grind', 'grindRail'];
function trickOf(name) {
  const n = String(name).toLowerCase();
  if (/360/.test(n)) return 'spin360';
  if (/180|spin/.test(n)) return 'spin180';
  if (/flip/.test(n)) return 'kickflip';
  if (/grab|indy|melon/.test(n)) return 'grab';
  if (/rail|bar/.test(n)) return 'grindRail';
  if (/grind|coping|ledge/.test(n)) return 'grind';
  if (/air/.test(n)) return 'air';
  return 'ollie';
}
// A checklist entry is met by these rider tricks (a grind on the bar counts as a grind, a 360
// covers a 180, any air or ollie covers an ollie).
const MEETS = { ollie: ['ollie', 'air'], air: ['air'], kickflip: ['kickflip'], grab: ['grab'], spin180: ['spin180', 'spin360'], spin360: ['spin360'], grind: ['grind', 'grindRail'], grindRail: ['grindRail', 'grind'] };

let sessionBest = 0;

function bestOf(deps, cfg) {
  if (Number.isFinite(cfg.best)) return cfg.best;
  try {
    const q = typeof window !== 'undefined' && window.__game && window.__game.quests;
    const v = q && q.flagValue ? Number(q.flagValue('act_skate_best')) : 0;
    if (v > 0) return Math.max(v, sessionBest);
  } catch (_) { /* optional */ }
  return sessionBest;
}

export function createSkate(deps = {}) {
  const t = textFn(deps.t);
  addStyle('mg-style-skate', CSS);
  loadSkateStrings();
  let S = null;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3();
  const _v = new THREE.Vector3();

  // The pool nearest to config.at ({x, z}, e.g. { poi: ... } in a quest config); without one, the
  // pool at HaTeder (the poi 'skate_bowl'), so older configs keep their pool.
  function findBowl(config) {
    if (config.bowlMesh) return config.bowlMesh;
    let at = config.at;
    if (!at) { const home = poisOf().find((p) => p.id === 'skate_bowl'); if (home) at = home; }
    let best = null, bd = Infinity;
    deps.scene.traverse((o) => {
      if (!o.isMesh || !o.userData || !o.userData.skateBowl) return;
      if (!at) { if (!best) best = o; return; }
      o.updateWorldMatrix(true, false);
      const s = o.userData.skateBowl;
      _v.set(s.cx, s.cy, s.cz).applyMatrix4(o.matrixWorld);
      const d = Math.hypot(_v.x - at.x, _v.z - at.z);
      if (d < bd) { bd = d; best = o; }
    });
    return best;
  }
  function poisOf() {
    return deps.pois || (typeof window !== 'undefined' && window.__game && window.__game.landmarks && window.__game.landmarks.pois) || [];
  }

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const mesh = findBowl(config);
      if (!mesh) { console.warn('[skate] no skate-bowl mesh in the scene'); resolve({ ok: false, cancelled: true, score: 0 }); return; }
      mesh.updateWorldMatrix(true, false);
      const spec = mesh.userData.skateBowl;
      // bowl-local space -> world
      const root = new THREE.Group();
      root.name = 'mg-skate';
      root.matrixAutoUpdate = false;
      root.matrix.copy(mesh.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(spec.cx, spec.cy, spec.cz));
      root.matrixWorldNeedsUpdate = true;
      deps.scene.add(root);
      const toWorld = (x, y, z, out = new THREE.Vector3()) => out.set(x, y, z).applyMatrix4(root.matrix);
      // where the player walks off to afterwards: the poi in front of the pool, facing it
      const poi = poisOf().find((p) => p.id === (spec.exitPoi || 'skate_bowl'));
      const exitL = { x: 0, z: spec.fz + spec.Ec + spec.deck + 3 };
      const exitW = poi ? { x: poi.x, z: poi.z } : (() => { const w = toWorld(exitL.x, 0, exitL.z); return { x: w.x, z: w.z }; })();
      const cW = toWorld(0, 0, 0);
      const exitYaw = Math.atan2(cW.x - exitW.x, cW.z - exitW.z);

      const ov = createOverlay('mg-skate',
        '<div class="mg-panel sk-top"><div class="mg-title sk-title"></div><div class="sk-row"><span class="mg-num sk-time"></span><span class="mg-num sk-score"></span></div><div class="sk-best"></div></div>' +
        '<div class="mg-panel sk-list mg-hide"></div>' +
        '<div class="sk-combo"><div class="names"></div><div class="pts"></div></div>' +
        '<div class="mg-panel sk-bal mg-hide"><div class="mg-small sk-bal-l"></div><div class="track"><div class="needle"></div></div></div>' +
        '<div class="sk-pop"></div><div class="mg-panel sk-hint"></div>');
      ov.$('.sk-title').textContent = t(config.title || 'skate.title');
      ov.$('.sk-bal-l').textContent = t('skate.balance');

      const need = (config.tricks || []).map((n) => ({ name: n, id: trickOf(n), done: false }));
      S = {
        cfg: config, ov, root, spec, mesh, resolve, toWorld, exitW, exitYaw,
        seconds: Math.max(10, config.seconds || 60), left: 0, goal: config.goal || 0,
        need, needN: need.length ? Math.min(need.length, config.need || need.length) : 0,
        score: 0, chain: null, bankT: 0, bestCombo: 0, counts: {}, recent: [], tries: 1, fails: 0,
        best: bestOf(deps, config),
        phase: 'intro', phaseT: 0, paused: false, closeCard: null, count: null, overT: 0,
        rig: cameraRig(deps.scene, deps.camera), cam: null, camDir: new THREE.Vector2(0, -1), camInit: false,
        toast: toaster(ov.root), offKeys: keyListener(onKey),
      };
      S.cam = S.rig.take();
      document.body.classList.add('mg-skating');
      if (need.length) ov.$('.sk-list').classList.remove('mg-hide');

      // the player's avatar steps onto the board for the session
      const pl = deps.player;
      if (pl && pl.mode !== 'walk' && pl.setMode) pl.setMode('walk');
      const av = pl && pl.avatar && pl.avatar.joints ? pl.avatar : null;
      if (av) S.avParent = av.group.parent;
      S.me = new Rider(spec, av, root);
      if (pl) placePlayer(pl, exitW, exitYaw);
      if (pl && pl.root) pl.root.visible = true;
      beginRun();
      fadeIn();
    });
  }

  // On the south deck, at the coping, looking into the pool; 3-2-1, then the drop-in.
  function beginRun() {
    const s = S, sp = s.spec;
    s.me.reset(0, sp.fz + sp.Ec + 0.45, Math.PI, 'ride');
    s.left = s.seconds;
    s.score = 0; s.chain = null; s.bankT = 0; s.bestCombo = 0; s.counts = {}; s.recent = [];
    for (const n of s.need) n.done = false;
    s.phase = 'count'; s.phaseT = 0; s.overT = 0;
    s.camInit = false; s.camDir.set(0, -1);
    s.count = countdown(s.ov.root, ['3', '2', '1', t('skate.go')]);
    say('drop');
    drawList();
  }

  function fadeIn() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#0b1022;opacity:1;transition:opacity 0.45s;pointer-events:none;z-index:30;';
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 520); }, 60);
  }
  function fadeThrough(fn) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#0b1022;opacity:0;transition:opacity 0.3s;pointer-events:none;z-index:30;';
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '1'; }, 20);
    const s = S;
    s.fading = true;
    setTimeout(() => {
      if (S === s) { try { fn(); } catch (e) { console.warn('[skate] fade step failed', e); } s.fading = false; s.camInit = false; }
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 360);
    }, 340);
  }

  // ---- text ----
  function say(key) { if (S && S.hintKey !== key) { S.ov.$('.sk-hint').innerHTML = rich(t('skate.hint.' + key)); S.hintKey = key; } }
  function pop(text, ms = 1100) {
    const el = S.ov.$('.sk-pop');
    el.textContent = text;
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
    clearTimeout(S.popTimer);
    S.popTimer = setTimeout(() => el.classList.remove('on'), ms);
  }
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const trickName = (id) => t('skate.trick.' + id);

  function onKey(e) {
    const s = S;
    if (!s || s.closeCard) return;
    if (e.code === 'Escape' && !e.repeat) {
      e.preventDefault();
      s.paused = true;
      s.closeCard = showCard(s.ov.root, {
        title: t('mg.ui.paused'), lines: [t('skate.card.quitTitle')],
        buttons: [
          { label: t('mg.ui.resume'), key: ['Enter'], onClick: () => { s.closeCard = null; s.paused = false; } },
          { label: t('mg.ui.quit'), key: ['Escape'], alt: true, onClick: () => { s.closeCard = null; finish({ ok: false, quit: true }); } },
        ],
      });
    }
  }

  // ---- the loop ----
  function update(dt, input) {
    const s = S;
    if (!s) return;
    dt = Math.min(dt, 1 / 20);
    const inp = readInput(input);
    if (!s.paused && !s.fading) {
      s.phaseT += dt;
      if (s.phase === 'count') {
        if (s.count.update(dt)) { s.count = null; s.phase = 'run'; s.phaseT = 0; s.me.sp = 3.5; say('ride'); }
        s.me.update(dt, { steer: 0 });
      } else if (s.phase === 'run' || s.phase === 'over') {
        s.me.update(dt, s.phase === 'run' ? inp : { steer: 0, brake: true });
        for (const e of s.me.events) event(e);
        s.me.events.length = 0;
        tickCombo(dt);
        if (s.phase === 'run') {
          s.left -= dt;
          if (s.left <= 0) { s.left = 0; s.phase = 'over'; s.overT = 0; pop(t('skate.pop.time'), 1400); }
        } else {
          // time's up: let a flight or a grind finish, then add up
          s.overT += dt;
          const settled = s.me.state === 'ride' || s.me.state === 'bail';
          if ((settled && s.overT > 0.6) || s.overT > 3.5) { if (s.chain && s.me.state === 'ride') bank(); else if (s.chain) lose(); runCard(); }
        }
        const st = s.me.state;
        if (s.phase === 'run') say(st === 'air' ? 'air' : st === 'grind' ? 'grind' : st === 'bail' ? 'bail' : 'ride');
      }
    }
    s.me.events.length = 0;
    s.me.applyPose(s.paused ? 0 : dt);
    camera(dt);
    ui();
  }

  function readInput(input) {
    const none = { pump: false, brake: false, steer: 0, ollie: false, flip: false, grind: false, grab: false };
    if (!input || S.fading || S.closeCard) return none;
    const ax = input.axis ? input.axis() : { f: 0, r: 0 };
    const pr = (...c) => (input.wasPressed ? input.wasPressed(...c) : false);
    const dn = (...c) => (input.isDown ? c.some((k) => input.isDown(k)) : false);
    return {
      pump: ax.f > 0, brake: ax.f < 0, steer: ax.r,
      ollie: pr('Space'), flip: pr('KeyJ'), grind: pr('KeyL'), grab: dn('KeyK'),
    };
  }

  // ---- tricks and combos ----
  function event(e) {
    const s = S;
    if (e.type === 'trick') addTrick(e);
    else if (e.type === 'land') { s.bankT = 0; if (s.chain && e.clean && s.chain.items.length >= 2) pop(t('skate.pop.clean'), 700); }
    else if (e.type === 'bail') { if (s.chain) lose(); pop(t('skate.pop.bail.' + (e.reason || 'landing')), 1300); }
    else if (e.type === 'pop') pop(t('skate.pop.pop'), 600);
    else if (e.type === 'bonk') { if (!s.bonkCd || s.phaseT > s.bonkCd) { pop(t('skate.pop.bonk'), 700); s.bonkCd = s.phaseT + 1.2; } }
  }
  function addTrick(e) {
    const s = S;
    if (s.phase !== 'run' && s.phase !== 'over') return;
    // the same trick again and again is worth less (the last eight tricks count)
    const reps = s.recent.filter((id) => id === e.id).length;
    const pts = Math.max(10, Math.round(e.pts * Math.pow(0.6, reps)));
    s.recent.push(e.id);
    if (s.recent.length > 8) s.recent.shift();
    if (!s.chain) s.chain = { items: [], pts: 0 };
    s.chain.items.push({ id: e.id, pts });
    s.chain.pts += pts;
    s.bankT = 0;
    s.lostT = 0;
    pop(`${trickName(e.id)} +${fmt(pts)}`, 900);
  }
  function tickCombo(dt) {
    const s = S;
    if (s.lostT !== undefined && s.lostT > 0) s.lostT -= dt;
    if (!s.chain) return;
    // the combo stays open while airborne or grinding, and for a moment after a landing
    if (s.me.state === 'ride') { s.bankT += dt; if (s.bankT > 1.1) bank(); }
  }
  function bank() {
    const s = S, c = s.chain;
    s.chain = null;
    if (!c) return;
    const mult = c.items.length, total = c.pts * mult;
    s.score += total;
    s.bestCombo = Math.max(s.bestCombo, total);
    for (const it of c.items) s.counts[it.id] = (s.counts[it.id] || 0) + 1;
    if (mult >= 2) pop(t('skate.pop.combo', { n: mult, p: fmt(total) }), 1300);
    s.last = { items: c.items, total, mult, lost: false, t: 1.6 };
    // the checklist (a quest's trick list)
    let changed = false;
    for (const n of s.need) if (!n.done && c.items.some((it) => (MEETS[n.id] || [n.id]).includes(it.id))) { n.done = true; changed = true; }
    if (changed) { drawList(); if (s.need.filter((n) => n.done).length >= s.needN && s.phase === 'run') { s.phase = 'over'; s.overT = 0; pop(t('skate.pop.listDone'), 1400); } }
  }
  function lose() {
    const s = S, c = s.chain;
    s.chain = null;
    if (c) s.last = { items: c.items, total: c.pts * c.items.length, mult: c.items.length, lost: true, t: 1.6 };
  }
  function drawList() {
    const s = S, el = s.ov.$('.sk-list');
    if (!s.need.length) return;
    el.innerHTML = '';
    const h = document.createElement('div'); h.className = 'mg-small'; h.textContent = t('skate.list', { n: s.needN }); el.appendChild(h);
    for (const n of s.need) { const d = document.createElement('div'); d.textContent = trickName(n.id); if (n.done) d.className = 'on'; el.appendChild(d); }
  }

  // ---- the end of a run ----
  function runCard() {
    const s = S;
    s.phase = 'card';
    s.ov.$('.sk-hint').classList.add('mg-hide');
    const score = s.score;
    const prev = s.best;
    const isBest = score > prev;
    s.best = Math.max(prev, score);
    sessionBest = Math.max(sessionBest, score);
    const listOk = !s.needN || s.need.filter((n) => n.done).length >= s.needN;
    const ok = listOk && (!s.goal || score >= s.goal);
    const result = { ok, score, best: s.best, combo: s.bestCombo, tricks: { ...s.counts }, done: s.need.filter((n) => n.done).map((n) => n.name), tries: s.tries };
    const counts = TRICKS.filter((id) => s.counts[id]).map((id) => `${trickName(id)} ×${s.counts[id]}`).join(' · ');
    const lines = [t('skate.card.summary', { score: fmt(score), combo: fmt(s.bestCombo) })];
    if (counts) lines.push(counts);
    lines.push(isBest && prev > 0 ? t('skate.card.newBest') : t('skate.card.best', { best: fmt(s.best) }));
    if (ok) {
      if (s.cfg.autoContinue) { setTimeout(() => finish(result), 600); return; }
      s.closeCard = showCard(s.ov.root, {
        title: t(isBest && prev > 0 ? 'skate.card.bestTitle' : 'skate.card.passTitle'), big: fmt(score), lines,
        // a quest's trick list moves the story on; a free session can go again
        buttons: s.needN ? [{ label: t('mg.ui.continue'), key: ['Enter', 'Space'], onClick: () => { s.closeCard = null; finish(result); } }] : [
          { label: t('skate.card.again'), key: ['Enter'], onClick: () => { s.closeCard = null; again(); } },
          { label: t('skate.card.exit'), key: ['Escape'], alt: true, onClick: () => { s.closeCard = null; finish(result); } },
        ],
      });
    } else {
      s.fails++;
      if (!listOk) lines.push(t('skate.card.needList', { n: s.needN }));
      else lines.push(t('skate.card.need', { goal: fmt(s.goal) }));
      if (s.fails >= 2) lines.push(t('skate.card.assist'));
      s.closeCard = showCard(s.ov.root, {
        title: t('skate.card.failTitle'), big: fmt(score), lines,
        buttons: [
          { label: t('mg.ui.retry'), key: ['Enter'], onClick: () => { s.closeCard = null; again(); } },
          { label: t('mg.ui.quit'), key: ['Escape'], alt: true, onClick: () => { s.closeCard = null; finish({ ...result, ok: false, quit: true }); } },
        ],
      });
    }
  }
  function again() {
    const s = S;
    s.tries++;
    // after two misses: more time for the list
    if (s.fails >= 2) s.seconds = Math.round(s.seconds * 1.25);
    s.ov.$('.sk-hint').classList.remove('mg-hide');
    fadeThrough(() => beginRun());
  }

  // ---- camera: inside the pool, on the far side of the rider from the wall he's riding ----
  function camera(dt) {
    const s = S, me = s.me, sp = s.spec;
    const p = bowlE(sp, me.x, me.z);
    // the inward normal of the wall the rider is on (kept while he crosses the flat)
    if (s.phase === 'count') s.camDir.set(-me.fwd.x, -me.fwd.z);
    else if (p.e > 0.6) s.camDir.lerp(new THREE.Vector2(-p.nx, -p.nz).normalize(), 1 - Math.exp(-2.2 * dt));
    else {
      // on the flat: swing behind the line of travel
      const v = me.state === 'air' ? new THREE.Vector2(me.V.x, me.V.z) : new THREE.Vector2(me.fwd.x * me.sp, me.fwd.z * me.sp);
      if (v.length() > 3) s.camDir.lerp(v.normalize().multiplyScalar(-1), 1 - Math.exp(-1.0 * dt));
    }
    if (s.camDir.lengthSq() < 1e-4) s.camDir.set(0, -1);
    s.camDir.normalize();
    const dist = 13, lift = 6.5;
    let cx = me.x + s.camDir.x * dist, cz = me.z + s.camDir.y * dist;
    // stay over the pool (and a little beyond the deck at most)
    const lim = (v, a) => clamp(v, -a, a);
    cx = lim(cx, sp.fx + sp.Ec + sp.deck + 9); cz = lim(cz, sp.fz + sp.Ec + sp.deck + 9);
    const ry = Math.max(me.y, 0) * 0.7 + lift + Math.max(0, sp.H - me.y) * 0.25;
    s.toWorld(cx, ry, cz, wantPos);
    s.toWorld(me.x, me.y + 1.8, me.z, wantLook);
    if (!s.camInit) { camPos.copy(wantPos); camLook.copy(wantLook); s.camInit = true; }
    const k = 1 - Math.exp(-3.2 * dt), kl = 1 - Math.exp(-7 * dt);
    camPos.lerp(wantPos, k);
    camLook.lerp(wantLook, kl);
    s.cam.set(camPos, camLook, 62);
  }

  // ---- HUD ----
  function ui() {
    const s = S, ov = s.ov;
    const left = Math.ceil(s.left);
    const tm = ov.$('.sk-time');
    tm.textContent = t('skate.time', { s: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
    tm.classList.toggle('low', s.phase === 'run' && s.left < 10);
    ov.$('.sk-score').textContent = fmt(s.score);
    ov.$('.sk-best').textContent = s.best > 0 ? t('skate.best', { best: fmt(s.best) }) : '';
    // the open combo (or the last one, for a moment)
    const box = ov.$('.sk-combo');
    const c = s.chain || (s.last && s.last.t > 0 ? s.last : null);
    if (s.last && !s.chain) s.last.t -= 1 / 60;
    if (c) {
      const items = c.items;
      const names = items.slice(-5).map((it) => trickName(it.id)).join(' + ');
      box.querySelector('.names').textContent = (items.length > 5 ? '… + ' : '') + names;
      const pts = c.pts !== undefined ? c.pts : c.total / c.mult;
      box.querySelector('.pts').textContent = c.lost ? t('skate.lost') : `${fmt(pts)} ×${items.length}`;
      box.classList.toggle('lost', !!c.lost);
      box.style.opacity = '1';
    } else box.style.opacity = '0';
    // grind balance
    const g = s.me.state === 'grind';
    ov.$('.sk-bal').classList.toggle('mg-hide', !g);
    if (g) ov.$('.sk-bal .needle').style.left = `${50 + clamp(s.me.bal, -1, 1) * 46}%`;
  }

  // ---- ending ----
  function finish(result) {
    const s = S;
    if (!s || s.ending) return;
    s.ending = true;
    const out = { ok: false, score: s.score, best: Math.max(s.best, s.score), combo: s.bestCombo, tricks: { ...s.counts }, tries: s.tries, ...result };
    fadeThrough(() => { teardown(); s.resolve(out); });
  }
  function teardown() {
    const s = S;
    if (!s) return;
    S = null;
    if (s.closeCard) s.closeCard();
    if (s.count) s.count.remove();
    s.offKeys();
    clearTimeout(s.popTimer);
    document.body.classList.remove('mg-skating');
    if (s.cam) s.cam.release();
    // the avatar goes home to the player, off the board
    const pl = deps.player, av = s.me.av;
    s.me.dispose();
    if (av) {
      (s.avParent || (pl && pl.rider) || deps.scene).add(av.group);
      // back to whatever the player thinks its avatar is doing, so Player.setAvatarMode stays in step
      try { av.setMode && av.setMode((pl && pl.avatarMode) || 'idle'); } catch (_) { /* optional */ }
    }
    if (pl) placePlayer(pl, s.exitW, s.exitYaw);
    const chase = deps.chase || (typeof window !== 'undefined' && window.__game && window.__game.chase);
    if (chase) { chase.inited = false; chase.yaw = s.exitYaw; }
    deps.scene.remove(s.root);
    s.ov.remove();
  }
  function cancel() {
    const s = S;
    if (!s) return;
    const out = { ok: false, cancelled: true, score: s.score, best: s.best, combo: s.bestCombo, tricks: { ...s.counts }, tries: s.tries };
    teardown();
    s.resolve(out);
  }

  return {
    start, update, cancel,
    get active() { return !!S; },
    // The whole session drives the player's avatar.
    get blocksPlayer() { return !!S; },
    debug: {
      state: () => (S ? { phase: S.phase, left: +S.left.toFixed(1), score: S.score, chain: S.chain ? { n: S.chain.items.length, pts: S.chain.pts, items: S.chain.items.map((i) => i.id) } : null,
        me: { state: S.me.state, x: +S.me.x.toFixed(2), y: +S.me.y.toFixed(2), z: +S.me.z.toFixed(2), sp: +S.me.sp.toFixed(2), psi: +S.me.psi.toFixed(2) }, counts: { ...S.counts }, need: S.need.map((n) => [n.name, n.done]) } : null),
      card: (i = 0) => S && S.closeCard && S.closeCard.fire(i),
      // tests: skip the countdown, end the clock now
      go: () => { if (S && S.phase === 'count') { S.count.remove(); S.count = null; S.phase = 'run'; S.me.sp = 3.5; } },
      timeUp: () => { if (S && S.phase === 'run') S.left = 0.01; },
      get S() { return S; },
    },
  };
}
