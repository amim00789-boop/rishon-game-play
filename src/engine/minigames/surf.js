// Surf session at the Surf Club beach: paddle out with the friends, wait for a set, catch a wave
// on a timing ring, ride it (carve, pump, a small air), wipe out softly, score every wave.
//
//   const surf = createSurf(deps);          // deps as for createMinigames (scene, camera, player, t, ...)
//   const r = await surf.start({ friends: true, waves: 3, goal: 1500 });
//   // r = { ok, score, best, waves: [scores], tries, quit?, cancelled? }
//   per frame: surf.update(dt, input); freeze the player (FROZEN input) while surf.blocksPlayer.
//
// Config: friends (true), waves (rides that count, 3), goal (total score, null = any),
// at ({x,z} beach spot; default poi 'surf_club_beach', else the sand nearest 'surf_club'),
// title (key), autoContinue, assist (0..2 extra catch window from the start), seed.
// Waves are a local overlay (surf/waves.js) on top of the sea; water.js is not touched.
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, cameraRig, keyListener, toaster, clamp, rich, showCard, placePlayer } from './common.js';
import { register, i18n } from '../../i18n.js';
import { shoreFrame, WaveField, WaveMesh, LipRibbons, Spray, SURF } from '../surf/waves.js';
import { Rider } from '../surf/riders.js';
import { FriendBrain, FRIEND_IDS, surfLook } from '../surf/friends.js';
import { clearSurfPose } from '../surf/poses.js';

// Surf text lives in data/minigames/surf.<lang>.json (same shape in every language) and is
// registered under `surf`, so t('surf.hint.ride') resolves. createSurf starts this on its own;
// await it first when the strings must be there on the very first frame.
let stringsP = null;
export function loadSurfStrings(base = new URL('../../../data/minigames/', import.meta.url).href) {
  if (stringsP) return stringsP;
  const get = (lang) => fetch(`${base}surf.${lang}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`surf.${lang}.json: HTTP ${r.status}`))));
  stringsP = (async () => {
    const fallback = await get('en').catch((e) => { console.warn('[surf] no English strings', e.message); return {}; });
    const active = i18n.lang === 'en' ? fallback : await get(i18n.lang).catch(() => null);
    register('surf', active || fallback, fallback);
  })();
  return stringsP;
}

const CSS = `
.mg-surf .sf-top { left: 50%; top: 12px; transform: translateX(-50%); min-width: 250px; text-align: center; }
.mg-surf .sf-row { display: flex; justify-content: space-between; gap: 12px; font-weight: 800; font-size: 14px; margin-top: 2px; }
.mg-surf .sf-hint { left: 50%; bottom: 22px; transform: translateX(-50%); font-weight: 800; font-size: 15px; white-space: nowrap; max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis; }
.mg-surf .sf-ring { position: absolute; left: 50%; top: 26%; transform: translate(-50%, -50%); pointer-events: none; }
.mg-surf .sf-bal { left: 50%; bottom: 66px; transform: translateX(-50%); width: 230px; padding: 5px 10px; }
.mg-surf .sf-bal .track { position: relative; height: 12px; border: 2px solid #23324a; border-radius: 8px;
  background: linear-gradient(90deg, #e8364f 0 14%, #ffcb3d 14% 26%, #7fe0d6 26% 74%, #ffcb3d 74% 86%, #e8364f 86%); }
.mg-surf .sf-bal .needle { position: absolute; top: -5px; width: 6px; height: 18px; margin-left: -3px; background: #23324a; border-radius: 3px; left: 50%; }
.mg-surf .sf-pop { position: absolute; left: 50%; top: 30%; transform: translate(-50%, -50%); font-weight: 900; font-size: 26px; color: #fff;
  -webkit-text-stroke: 1.5px #23324a; text-shadow: 0 4px 0 rgba(35, 50, 74, 0.45); opacity: 0; transition: opacity 0.2s; white-space: nowrap; pointer-events: none; }
.mg-surf .sf-pop.on { opacity: 1; animation: mg-pop 0.35s ease-out; }
.mg-surf .sf-chat { position: absolute; inset-inline-start: 14px; bottom: 70px; display: flex; flex-direction: column; gap: 5px; max-width: min(380px, 60vw); pointer-events: none; }
.mg-surf .sf-chat div { background: rgba(255, 252, 244, 0.92); border: 2px solid #23324a; border-radius: 12px; padding: 4px 10px; font-weight: 700; font-size: 14px;
  box-shadow: 0 2px 0 rgba(35, 50, 74, 0.3); transition: opacity 0.5s; }
.mg-surf .sf-chat b { font-weight: 900; margin-inline-end: 6px; }
.mg-surf .sf-wave { font-size: 12px; font-weight: 800; opacity: 0.75; }
/* the game HUD steps aside while surfing (same rule as the photo game's phone view) */
body.mg-surfing .hud-panel, body.mg-surfing #hud-map { visibility: hidden; }
`;
const NAME_COLORS = { malul: '#e8364f', ofir: '#1a9e93', dekel: '#2e86de', adir: '#b8860b' };

// ---- the beach: where is the sea, which way is out ----------------------------------------
function findSea(scene) {
  let best = null, bestA = -1;
  scene.traverse((o) => {
    if (!o.isMesh || !o.userData || o.userData.water !== true || o.userData.foam === false) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox, a = (b.max.x - b.min.x) * (b.max.z - b.min.z || b.max.y - b.min.y);
    const score = (o.name === 'sea' ? 1e12 : 0) + a;
    if (score > bestA) { bestA = score; best = o; }
  });
  return best;
}
const _rc = new THREE.Raycaster(), _o = new THREE.Vector3(), _d = new THREE.Vector3(0, -1, 0);
function waterAt(sea, x, z) {
  _rc.set(_o.set(x, 600, z), _d);
  const h = _rc.intersectObject(sea, false)[0];
  return h ? h.point.y : null;
}
// -> { frame, seaY, beach: {x, z} } for a spot near the shore, or null without a sea.
export function surfFrame(scene, spot) {
  const sea = findSea(scene);
  if (!sea) return null;
  sea.updateWorldMatrix(true, false);
  // nearest water in 24 directions
  let bestD = Infinity, dirs = [];
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2, cx = Math.cos(ang), cz = Math.sin(ang);
    for (let r = 0; r <= 600; r += 6) {
      if (waterAt(sea, spot.x + cx * r, spot.z + cz * r) !== null) { dirs.push([cx, cz, r]); bestD = Math.min(bestD, r); break; }
    }
  }
  if (!dirs.length) return null;
  let nx = 0, nz = 0;
  for (const [cx, cz, r] of dirs) if (r < bestD * 1.5 + 6) { nx += cx / (r + 10); nz += cz / (r + 10); }
  let l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
  // shore points on three parallel lines refine the normal: the coast runs between them
  const shoreAlong = (ox, oz) => {
    for (let r = -40; r <= 700; r += 2) if (waterAt(sea, ox + nx * r, oz + nz * r) !== null) return { x: ox + nx * r, z: oz + nz * r };
    return null;
  };
  const sx = -nz, sz = nx;
  const A = shoreAlong(spot.x - sx * 70, spot.z - sz * 70), B = shoreAlong(spot.x + sx * 70, spot.z + sz * 70), C = shoreAlong(spot.x, spot.z);
  if (A && B) {
    const tx = B.x - A.x, tz = B.z - A.z, tl = Math.hypot(tx, tz) || 1;
    let mx = tz / tl, mz = -tx / tl; // perpendicular; pick the one pointing out to sea
    if (mx * nx + mz * nz < 0) { mx = -mx; mz = -mz; }
    if (mx * nx + mz * nz > 0.5) { nx = mx; nz = mz; }
  }
  const O = C || { x: spot.x + nx * bestD, z: spot.z + nz * bestD };
  const seaY = waterAt(sea, O.x + nx * 60, O.z + nz * 60) ?? sea.position.y;
  return { frame: shoreFrame(O.x, O.z, nx, nz), seaY, beach: { x: O.x - nx * 9, z: O.z - nz * 9 }, sea };
}

function poisOf(deps) {
  return deps.pois || (typeof window !== 'undefined' && window.__game && window.__game.landmarks && window.__game.landmarks.pois) || [];
}

// ---------------------------------------------------------------------------------------------
export function createSurf(deps = {}) {
  const t = textFn(deps.t);
  addStyle('mg-style-surf', CSS);
  loadSurfStrings();
  let S = null;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3();

  function spotFor(config) {
    if (config.at && Number.isFinite(config.at.x)) return config.at;
    const pois = poisOf(deps);
    const p = pois.find((q) => q.id === 'surf_club_beach') || pois.find((q) => q.id === 'surf_club');
    if (p) return { x: p.x, z: p.z };
    const pl = deps.player;
    return pl ? { x: pl.pos.x, z: pl.pos.z } : { x: 0, z: 0 };
  }

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const spot = spotFor(config);
      const found = config.frame ? null : surfFrame(deps.scene, spot);
      const frame = config.frame || (found ? found.frame : shoreFrame(spot.x, spot.z, -1, 0));
      const seaY = config.seaY ?? (found ? found.seaY : 0);
      const beach = found ? found.beach : { x: spot.x - frame.nx * 9, z: spot.z - frame.nz * 9 };
      let seed = (config.seed ?? 20261016) >>> 0;
      const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };

      const ov = createOverlay('mg-surf',
        '<div class="mg-panel sf-top"><div class="mg-title sf-title"></div><div class="sf-row"><span class="sf-wave"></span><span class="mg-num sf-score"></span></div><div class="mg-bar sf-goal"><i></i></div></div>' +
        '<canvas class="sf-ring mg-hide" width="200" height="200"></canvas>' +
        '<div class="mg-panel sf-bal mg-hide"><div class="mg-small sf-bal-l"></div><div class="track"><div class="needle"></div></div></div>' +
        '<div class="sf-pop"></div><div class="sf-chat"></div>' +
        '<div class="mg-panel sf-hint"></div>');
      ov.$('.sf-title').textContent = t(config.title || 'surf.title');
      ov.$('.sf-bal-l').textContent = t('surf.balance');
      if (!config.goal) ov.$('.sf-goal').classList.add('mg-hide');

      const root = new THREE.Group();
      root.name = 'mg-surf';
      deps.scene.add(root);
      const field = new WaveField(frame, seaY, rnd);
      const mesh = new WaveMesh(field);
      const lips = new LipRibbons(field);
      const spray = new Spray();
      root.add(mesh.mesh, lips.mesh, spray.points);

      S = {
        cfg: config, ov, root, field, mesh, lips, spray, frame, seaY, beach, rnd, resolve,
        goal: config.goal || 0, nWaves: Math.max(1, config.waves || 3), scores: [], waveScore: 0, tries: 1,
        assist: clamp(config.assist || 0, 0, 2), fails: 0,
        phase: 'intro', phaseT: 0, paused: false, closeCard: null, setCd: 4, setCount: 0, catchW: null, catchOk: false, earlyCd: 0,
        rig: cameraRig(deps.scene, deps.camera), cam: null, friends: [], held: [], popT: 0, chat: [],
        toast: toaster(ov.root), offKeys: keyListener(onKey), result: null, camInit: false,
      };
      S.cam = S.rig.take();
      document.body.classList.add('mg-surfing');

      // the player's avatar moves onto the board for the session
      const pl = deps.player;
      if (pl && pl.mode !== 'walk' && pl.setMode) pl.setMode('walk');
      const av = pl && pl.avatar && pl.avatar.joints ? pl.avatar : null;
      if (av) S.avParent = av.group.parent;
      S.me = new Rider({ field, scene: root, av, look: 'player', name: 'player', spray, skill: 1 });
      S.me.reset(28, 0, frame.yawOf(1, 0), 'paddle');

      // the friends, in board shorts, held out of the city crowd while they surf
      if (config.friends !== false) makeFriends();
      if (pl) placePlayer(pl, beach, frame.yawOf(1, 0));
      field.set(3, { v: 0, delay: 9, height: SURF.height * 0.95 });
      fadeIn();
      say('paddleOut');
    });
  }

  async function makeFriends() {
    const s = S;
    let make = deps.makeAvatar;
    if (typeof make !== 'function') {
      try { make = (await import('../../characters/avatar.js')).createAvatar; } catch (_) { make = null; }
    }
    if (!S || S !== s || !make) return;
    FRIEND_IDS.forEach((id, i) => {
      let av = null;
      try { av = make(surfLook(id)); } catch (e) { console.warn('[surf] friend avatar failed', id, e); }
      const r = new Rider({ field: s.field, scene: s.root, av, look: id, name: id, spray: s.spray, skill: id === 'malul' ? 1 : id === 'ofir' ? 0.86 : 0.62 });
      const b = new FriendBrain(id, r, s.field, s.rnd);
      const sp = b.spot();
      r.reset(sp.u - 70 + i * 10, sp.v, s.frame.yawOf(1, 0), 'paddle');
      b.mode = 'return';
      s.friends.push(b);
      if (deps.crowd && deps.crowd.holdNamed) { try { deps.crowd.holdNamed(id, true); s.held.push(id); } catch (_) { /* optional */ } }
    });
  }

  function fadeIn() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#0b1022;opacity:1;transition:opacity 0.45s;pointer-events:none;z-index:30;';
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 520); }, 60);
  }
  // Black out, run fn under the dark, fade back.
  function fadeThrough(fn) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:#0b1022;opacity:0;transition:opacity 0.3s;pointer-events:none;z-index:30;';
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '1'; }, 20);
    const s = S;
    s.fading = true;
    setTimeout(() => {
      if (S === s) { try { fn(); } catch (e) { console.warn('[surf] fade step failed', e); } s.fading = false; s.camInit = false; }
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 360);
    }, 340);
  }

  // ---- text ----
  function say(key, vars) { if (S) S.ov.$('.sf-hint').innerHTML = rich(t('surf.hint.' + key, vars)); S.hintKey = key; }
  function pop(key, vars, ms = 1200) {
    const el = S.ov.$('.sf-pop');
    el.textContent = t('surf.pop.' + key, vars);
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
    clearTimeout(S.popTimer);
    S.popTimer = setTimeout(() => el.classList.remove('on'), ms);
  }
  // A friend shouts a line (an array of lines per event in the string table).
  function cheer(id, ev) {
    const s = S;
    if (!s) return;
    const lines = t(`surf.cheer.${id}.${ev}`);
    if (!Array.isArray(lines) || !lines.length) return;
    const line = lines[Math.floor(s.rnd() * lines.length)];
    const box = s.ov.$('.sf-chat');
    const d = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = t('surf.name.' + id);
    b.style.color = NAME_COLORS[id] || '#23324a';
    d.appendChild(b);
    d.appendChild(document.createTextNode(line));
    box.appendChild(d);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 520); }, 2600);
    const f = s.friends.find((q) => q.id === id);
    if (f && f.rider.av) { f.rider.cheer = 1; try { f.rider.av.express && f.rider.av.express('laugh', 1.2); } catch (_) { /* optional */ } }
  }
  // Up to two nearby friends react to the player's moment (not too often).
  function react(ev, n = 1) {
    const s = S;
    if (!s || !s.friends.length) return;
    s.chatCd = s.chatCd || 0;
    if (s.chatCd > 0 && ev !== 'wipe' && ev !== 'ride') return;
    s.chatCd = 2.2;
    const me = s.me;
    const near = s.friends.slice().sort((a, b) => Math.hypot(a.rider.u - me.u, a.rider.v - me.v) - Math.hypot(b.rider.u - me.u, b.rider.v - me.v));
    const pick = near.slice(0, 3).sort(() => s.rnd() - 0.5).slice(0, n);
    pick.forEach((f, i) => setTimeout(() => cheer(f.id, ev), i * 700));
  }

  function onKey(e) {
    const s = S;
    if (!s || s.closeCard) return;
    if (e.code === 'Escape' && !e.repeat) {
      e.preventDefault();
      s.paused = true;
      s.closeCard = showCard(s.ov.root, {
        title: t('mg.ui.paused'), lines: [t('surf.card.quitTitle')],
        buttons: [
          { label: t('mg.ui.resume'), key: ['Enter'], onClick: () => { s.closeCard = null; s.paused = false; } },
          { label: t('mg.ui.quit'), key: ['Escape'], alt: true, onClick: () => { s.closeCard = null; finish({ ok: false, quit: true }); } },
        ],
      });
    }
  }

  // ---- the session loop ----
  function update(dt, input) {
    const s = S;
    if (!s) return;
    dt = Math.min(dt, 1 / 20);
    const inp = readInput(input);
    if (!s.paused) {
      s.phaseT += dt;
      s.chatCd = (s.chatCd || 0) - dt;
      s.field.update(dt);
      schedule(dt);
      playerLogic(dt, inp);
      for (const f of s.friends) {
        f.anchorV = s.me.v;
        f.update(dt);
        if (f.rider.av) { try { f.rider.av.update(dt, 0); } catch (_) { /* optional */ } }
        f.rider.applyPose();
        friendEvents(f);
      }
      s.spray.update(dt, s.seaY);
      emitLipSpray(dt);
    }
    s.me.applyPose();
    s.mesh.follow(s.me.v);
    s.mesh.update();
    s.lips.update();
    camera(dt);
    ui();
  }

  function readInput(input) {
    if (!input || S.fading || S.closeCard) return { paddle: false, steer: 0, pump: false, jump: false, space: false };
    const ax = input.axis ? input.axis() : { f: 0, r: 0 };
    return {
      paddle: ax.f > 0,
      steer: ax.r,
      pump: input.wasPressed ? input.wasPressed('KeyW', 'ArrowUp') : false,
      jump: input.wasPressed ? input.wasPressed('Space') : false,
      space: input.wasPressed ? input.wasPressed('Space') : false,
    };
  }

  // Sets: a new one a few seconds after the last line has gone through, centred on the player.
  function schedule(dt) {
    const s = S, F = s.field;
    const outside = F.waves.some((w) => w.u > SURF.lineup - 10);
    if (F.pending || outside) { s.setCd = 3 + s.rnd() * 2.5; return; }
    s.setCd -= dt;
    if (s.setCd <= 0) {
      s.setCount++;
      F.set(2 + (s.rnd() < 0.6 ? 1 : 0), { v: s.me.v + (s.rnd() - 0.5) * 20, delay: 0, gap: 6 + s.rnd() * 1.5 });
    }
  }
  // When a line comes in, send the free friends after it (Malul gets the biggest).
  function assignFriends(w) {
    const s = S;
    const free = s.friends.filter((f) => f.free);
    if (!free.length) return;
    free.sort((a, b) => (b.id === 'malul' ? 1 : 0) - (a.id === 'malul' ? 1 : 0));
    const n = Math.min(free.length, 1 + (s.rnd() < 0.55 ? 1 : 0));
    for (let i = 0; i < n; i++) free[i].go(w);
  }

  function playerLogic(dt, inp) {
    const s = S, me = s.me, F = s.field, fr = s.frame;
    // new lines reaching the lineup get friends assigned once
    for (const w of F.waves) if (!w.assigned && w.u < SURF.lineup + 80) { w.assigned = true; assignFriends(w); }
    s.earlyCd -= dt;
    switch (s.phase) {
      case 'intro':
        s.phase = 'paddleOut';
      // falls through
      case 'paddleOut': {
        me.update(dt, { paddle: inp.paddle, steer: inp.steer });
        if (me.u > SURF.lineup - 8) { me.setState('sit'); s.phase = 'wait'; s.phaseT = 0; say('wait'); }
        break;
      }
      case 'wait': {
        const w = F.incoming(me.u, me.v, 32);
        const seaYaw = fr.yawOf(1, 0);
        const catchable = w && w.u - me.u > 2 && w.amp(me.v) > 2.2;
        const seen = F.incoming(me.u, me.v, 120);
        if (catchable && w !== s.skipW) {
          if (s.hintKey !== 'go') say('go');
          if (inp.paddle) {
            me.setState('catch'); s.phase = 'catch'; s.phaseT = 0; s.catchW = w; s.paddledT = 0; s.catchX = me.u - w.u;
            say('catch');
          } else me.update(dt, { steer: inp.steer });
        } else {
          const hk = seen && seen !== s.skipW && seen.u > me.u + 2 ? 'set' : 'wait';
          if (s.hintKey !== hk) say(hk);
          // drift back toward the lineup and face the sea
          const back = SURF.lineup - me.u;
          if (Math.abs(back) > 14) {
            me.setState('paddle');
            me.update(dt, { paddle: true, steer: clamp(-angle(fr.yawOf(Math.sign(back), 0) - me.yaw) * 1.5, -1, 1) });
          } else {
            if (me.state !== 'sit') me.setState('sit');
            me.update(dt, { steer: inp.steer || clamp(-angle(seaYaw - me.yaw) * 0.8, -1, 1) });
          }
        }
        break;
      }
      case 'catch': {
        const w = s.catchW;
        const shoreYaw = fr.yawOf(-1, 0);
        // auto-turn toward the beach, the player can angle it with A/D
        const auto = clamp(-angle(shoreYaw - me.yaw) * 2.2, -1, 1);
        if (inp.paddle) s.paddledT += dt;
        me.update(dt, { paddle: true, steer: Math.abs(angle(shoreYaw - me.yaw)) > 0.9 ? auto : inp.steer * 0.8 + auto * 0.3 });
        const x = me.u - w.u;
        const [a, b] = windowFor();
        s.catchX = x;
        if (inp.space && s.earlyCd <= 0) {
          if (x >= a && x <= b) {
            me.popUp(w);
            s.phase = 'ride'; s.phaseT = 0; s.waveScore = 0; s.rideT = 0;
            say('ride');
            react('pop');
          } else if (x < a) { pop('early'); s.earlyCd = 0.45; me.S *= 0.6; }
        }
        if (s.phase === 'catch' && (x > b + 1.2 || w.dead)) {
          if (w.brokenAt(me.v) > 0.5) { me.fall('caught'); s.phase = 'washed'; s.phaseT = 0; pop('caught'); }
          else { pop('missed'); s.skipW = w; s.phase = 'wait'; me.setState('sit'); say('wait'); }
        }
        break;
      }
      case 'ride': {
        me.update(dt, { steer: inp.steer, pump: inp.pump, paddle: inp.paddle, jump: inp.jump });
        if (me.state === 'ride' || me.state === 'air') {
          s.rideT += dt;
          // points for time on the face, not for running ahead of the wave on the flats
          s.waveScore += dt * 50 * (me.state === 'air' ? 1 : clamp(me.hold || 0, 0, 1));
        }
        if (me.state === 'air' && s.hintKey !== 'air') say('air');
        else if (me.state === 'ride' && s.hintKey !== 'ride') say('ride');
        for (const e of me.events) playerEvent(e);
        me.events.length = 0;
        break;
      }
      case 'washed': {
        me.update(dt, {});
        me.events.length = 0;
        if (s.phaseT > 2) backToLineup(false);
        break;
      }
      case 'scored': {
        me.update(dt, me.state === 'wipe' ? {} : { paddle: false });
        me.events.length = 0;
        if (s.phaseT > 1.7 && !s.fading) afterWave();
        break;
      }
    }
  }

  function windowFor() {
    const s = S;
    const paddled = clamp((s.paddledT || 0) / 1.2, 0, 1);
    const extra = s.assist * 1.4 + paddled * 1.5;
    return [-8 - extra, -1.4 + extra * 0.45];
  }

  function playerEvent(e) {
    const s = S;
    if (e.type === 'carve') { s.waveScore += e.points; pop('carve', { p: e.points }, 900); if (e.points > 90) react('carve'); }
    else if (e.type === 'air') {
      s.waveScore += e.points;
      pop(e.spins >= 1 ? 'spin' : 'air', { p: e.points }, 1300);
      react('air', 2);
    } else if (e.type === 'wipe') {
      pop(e.reason === 'lean' ? 'lean' : e.reason === 'landing' ? 'landing' : 'wipe', null, 1500);
      endWave(false);
      react('wipe', 2);
    } else if (e.type === 'finish') {
      const bonus = e.reason === 'inside' ? 250 : s.rideT > 3 ? 120 : 0;
      s.waveScore += bonus;
      if (bonus) pop(e.reason === 'inside' ? 'inside' : 'kickout', { p: bonus }, 1300);
      endWave(true);
      react('ride', 2);
    }
  }

  function endWave() {
    const s = S;
    const sc = Math.round(s.waveScore);
    s.scores.push(sc);
    s.phase = 'scored'; s.phaseT = 0;
    setTimeout(() => { if (S === s) { S.toast(t('surf.card.wave', { i: s.scores.length, score: sc.toLocaleString('en-US') }), 1800); } }, 900);
  }

  function afterWave() {
    const s = S;
    if (s.scores.length >= s.nWaves) return sessionCard();
    backToLineup(true);
  }

  // Under a quick fade: the player (and anyone not mid-ride) back to the lineup, sitting.
  function backToLineup() {
    const s = S;
    s.phase = 'fading';
    fadeThrough(() => {
      const fr = s.frame;
      s.me.reset(SURF.lineup, s.me.v, fr.yawOf(1, 0), 'sit');
      s.skipW = null;
      // clear lines that are already inside so the next set reads fresh
      for (const w of s.field.waves) if (w.u < SURF.lineup + 10) w.dead = true;
      s.field.waves = s.field.waves.filter((w) => !w.dead);
      s.setCd = 2.5;
      for (const f of s.friends) {
        if (f.mode === 'ride') continue;
        const sp = f.spot();
        f.anchorV = s.me.v;
        f.mode = 'lineup';
        f.rider.reset(sp.u, s.me.v + f.p.lineup, fr.yawOf(1, 0), 'sit');
      }
      s.phase = 'wait'; s.phaseT = 0;
      say('wait');
    });
  }

  function total() { return S.scores.reduce((a, b) => a + b, 0); }
  function best() { return S.scores.reduce((a, b) => Math.max(a, b), 0); }

  function sessionCard() {
    const s = S;
    s.phase = 'card';
    s.ov.$('.sf-hint').classList.add('mg-hide');
    const score = total(), top = best();
    const ok = !s.goal || score >= s.goal;
    const result = { ok, score, best: top, waves: s.scores.slice(), tries: s.tries };
    const fmt = (n) => n.toLocaleString('en-US');
    if (ok) {
      if (s.friends.length) setTimeout(() => cheer('malul', 'ride'), 200);
      if (s.cfg.autoContinue) { setTimeout(() => finish(result), 600); return; }
      s.closeCard = showCard(s.ov.root, {
        title: t('surf.card.passTitle'), big: fmt(score),
        lines: [t('surf.card.summary', { score: fmt(score), best: fmt(top) })],
        buttons: [{ label: t('mg.ui.continue'), key: ['Enter', 'Space'], onClick: () => { s.closeCard = null; finish(result); } }],
      });
    } else {
      s.fails++;
      s.closeCard = showCard(s.ov.root, {
        title: t('surf.card.failTitle'), big: fmt(score),
        lines: [t('surf.card.summary', { score: fmt(score), best: fmt(top) }), t('surf.card.need', { goal: fmt(s.goal) }), s.fails >= 2 ? t('surf.card.assist') : ''].filter(Boolean),
        buttons: [
          { label: t('mg.ui.retry'), key: ['Enter'], onClick: () => { s.closeCard = null; retry(); } },
          { label: t('mg.ui.quit'), key: ['Escape'], alt: true, onClick: () => { s.closeCard = null; finish({ ...result, ok: false, quit: true }); } },
        ],
      });
    }
  }
  function retry() {
    const s = S;
    s.ov.$('.sf-hint').classList.remove('mg-hide');
    s.tries++;
    s.scores = [];
    if (s.fails >= 2) s.assist = Math.min(2, s.assist + 1);
    backToLineup();
  }

  function friendEvents(f) {
    const s = S;
    for (const e of f.events) {
      if (e.type === 'air' && (f.id === 'malul' || f.id === 'ofir') && near(f, 140)) { if (s.chatCd <= 0) { s.chatCd = 3; cheer(f.id, 'self'); } }
      else if (e.type === 'wipe' && (f.id === 'dekel' || f.id === 'adir') && near(f, 140)) { if (s.chatCd <= 0) { s.chatCd = 3; cheer(f.id, 'self'); } }
    }
    f.events.length = 0;
  }
  function near(f, d) { return Math.hypot(f.rider.u - S.me.u, f.rider.v - S.me.v) < d; }

  function emitLipSpray(dt) {
    const s = S, fr = s.frame;
    for (const w of s.field.waves) {
      if (!w.broken || w.u < 20) continue;
      for (const side of [1, -1]) {
        if (s.rnd() > dt * 22) continue;
        const v = side > 0 ? w.peakV + w.peelR : w.peakV - w.peelL;
        const A = w.amp(v);
        const p = fr.world(w.u - 1.5, v);
        s.spray.emit(p.x, s.seaY + A * 0.8, p.z, -fr.nx * 6 + fr.sx * side * 3, 3 + A * 0.6, -fr.nz * 6 + fr.sz * side * 3, 3, 2.2, 0.9);
      }
    }
  }

  // ---- camera ----
  function camera(dt) {
    const s = S, me = s.me, fr = s.frame;
    const fx = Math.sin(me.yaw), fz = Math.cos(me.yaw);
    const P = (x, y, z) => wantPos.set(x, y, z), L = (x, y, z) => wantLook.set(x, y, z);
    const y0 = me.y;
    let rate = 3.5, fov = 58;
    if (me.state === 'sit' || s.phase === 'wait') {
      // behind the rider, looking out at the sets
      P(me.x - fr.nx * 15 + fr.sx * 5, s.seaY + 7, me.z - fr.nz * 15 + fr.sz * 5);
      L(me.x + fr.nx * 40, s.seaY + 2, me.z + fr.nz * 40);
    } else if (s.phase === 'catch') {
      // from the beach side, low: the paddler coming at the camera, the wave rising behind
      P(me.x - fr.nx * 19 - fr.sx * 11, s.seaY + 7.5, me.z - fr.nz * 19 - fr.sz * 11);
      L(me.x + fr.nx * 8, y0 + 2.5, me.z + fr.nz * 8);
      fov = 60;
    } else if (me.state === 'ride' || me.state === 'pop' || me.state === 'air') {
      // behind and a little shoreward, so the face is in view
      P(me.x - fx * 13 - fr.nx * 6, Math.max(y0, s.seaY) + 6.5, me.z - fz * 13 - fr.nz * 6);
      L(me.x + fx * 10 + fr.nx * 1.5, y0 + 1.5, me.z + fz * 10 + fr.nz * 1.5);
      rate = 4.5; fov = 62;
    } else if (me.state === 'wipe' || s.phase === 'scored') {
      L(me.x, y0 + 0.5, me.z);
      P(camPos.x, Math.max(camPos.y, s.seaY + 4), camPos.z);
      rate = 2;
    } else {
      // paddling: behind and above, looking where the rider is going
      P(me.x - fx * 13, s.seaY + 6.5, me.z - fz * 13);
      L(me.x + fx * 20, s.seaY + 1.5, me.z + fz * 20);
    }
    // never below the water at the camera's own spot
    const cl = fr.local(wantPos.x, wantPos.z);
    const hc = s.field.sample(cl.u, cl.v, {}).h;
    wantPos.y = Math.max(wantPos.y, s.seaY + hc + 2.2);
    if (!s.camInit) { camPos.copy(wantPos); camLook.copy(wantLook); s.camInit = true; }
    const k = 1 - Math.exp(-rate * dt), kl = 1 - Math.exp(-(rate + 2) * dt);
    camPos.lerp(wantPos, k);
    camLook.lerp(wantLook, kl);
    s.cam.set(camPos, camLook, fov);
  }

  // ---- HUD ----
  function ui() {
    const s = S, ov = s.ov;
    const done = s.scores.length;
    const cur = s.phase === 'ride' ? Math.round(s.waveScore) : 0;
    const tot = total() + cur;
    ov.$('.sf-wave').textContent = t('surf.wave', { i: Math.min(done + 1, s.nWaves), n: s.nWaves });
    ov.$('.sf-score').textContent = s.goal ? t('surf.score', { score: tot.toLocaleString('en-US'), goal: s.goal.toLocaleString('en-US') }) : tot.toLocaleString('en-US');
    if (s.goal) ov.$('.sf-goal > i').style.width = `${clamp(tot / s.goal, 0, 1) * 100}%`;
    // balance meter while riding
    const riding = s.phase === 'ride' && (s.me.state === 'ride' || s.me.state === 'pop');
    ov.$('.sf-bal').classList.toggle('mg-hide', !riding);
    if (riding) ov.$('.sf-bal .needle').style.left = `${50 + clamp(s.me.lean / 1.3, -1, 1) * 46}%`;
    // timing ring while catching
    const ring = ov.$('.sf-ring');
    ring.classList.toggle('mg-hide', s.phase !== 'catch');
    if (s.phase === 'catch') drawRing(ring);
  }
  function drawRing(cv) {
    const s = S, g = cv.getContext('2d');
    const [a, b] = windowFor();
    const x = s.catchX ?? -40;
    const map = (v) => 22 + clamp((-v) / 30, 0, 1) * 70; // radius from the wave's distance
    g.clearRect(0, 0, 200, 200);
    // target band (the sweet spot)
    g.lineWidth = map(a) - map(b);
    g.strokeStyle = 'rgba(46, 196, 182, 0.55)';
    g.beginPath(); g.arc(100, 100, (map(a) + map(b)) / 2, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 2; g.strokeStyle = '#23324a';
    for (const v of [a, b]) { g.beginPath(); g.arc(100, 100, map(v), 0, Math.PI * 2); g.stroke(); }
    // the wave closing in
    const inWin = x >= a && x <= b;
    g.lineWidth = 6; g.strokeStyle = inWin ? '#ffcb3d' : '#ffffff';
    g.beginPath(); g.arc(100, 100, map(x), 0, Math.PI * 2); g.stroke();
    g.lineWidth = 2; g.strokeStyle = '#23324a';
    g.beginPath(); g.arc(100, 100, map(x) + 3.5, 0, Math.PI * 2); g.stroke();
    g.fillStyle = inWin ? '#ffcb3d' : 'rgba(255,255,255,0.85)';
    g.beginPath(); g.arc(100, 100, 12, 0, Math.PI * 2); g.fill(); g.stroke();
  }

  // ---- ending ----
  function finish(result) {
    const s = S;
    if (!s || s.ending) return;
    s.ending = true;
    const out = { ok: false, score: total(), best: best(), waves: s.scores.slice(), tries: s.tries, ...result };
    fadeThrough(() => { teardown(); s.resolve(out); });
  }
  function teardown() {
    const s = S;
    if (!s) return;
    S = null;
    if (s.closeCard) s.closeCard();
    s.offKeys();
    clearTimeout(s.popTimer);
    document.body.classList.remove('mg-surfing');
    if (s.cam) s.cam.release();
    // the avatar goes home to the player's rider group
    const pl = deps.player, av = s.me.av;
    if (av) {
      clearSurfPose(av);
      (s.avParent || (pl && pl.rider) || deps.scene).add(av.group);
    }
    if (pl) placePlayer(pl, s.beach, s.frame.yawOf(-1, 0));
    const chase = deps.chase || (typeof window !== 'undefined' && window.__game && window.__game.chase);
    if (chase) { chase.inited = false; chase.yaw = s.frame.yawOf(-1, 0); }
    for (const id of s.held) { try { deps.crowd.holdNamed(id, false); } catch (_) { /* optional */ } }
    s.me.av = null;
    s.me.dispose();
    for (const f of s.friends) f.rider.dispose();
    s.mesh.dispose(); s.lips.dispose(); s.spray.dispose();
    deps.scene.remove(s.root);
    s.ov.remove();
  }
  function cancel() {
    const s = S;
    if (!s) return;
    const out = { ok: false, cancelled: true, score: total(), best: best(), waves: s.scores.slice(), tries: s.tries };
    teardown();
    s.resolve(out);
  }

  return {
    start, update, cancel,
    get active() { return !!S; },
    // The whole session drives the player's avatar.
    get blocksPlayer() { return !!S; },
    debug: {
      state: () => (S ? { phase: S.phase, me: { state: S.me.state, u: +S.me.u.toFixed(1), v: +S.me.v.toFixed(1), S: +S.me.S.toFixed(1), lean: +S.me.lean.toFixed(2) },
        scores: S.scores.slice(), waveScore: Math.round(S.waveScore), waves: S.field.waves.map((w) => ({ u: +w.u.toFixed(1), broken: w.broken, H: +w.H.toFixed(1) })),
        friends: S.friends.map((f) => ({ id: f.id, mode: f.mode, state: f.rider.state, u: +f.rider.u.toFixed(1), v: +f.rider.v.toFixed(1) })) } : null),
      card: (i = 0) => S && S.closeCard && S.closeCard.fire(i),
      // tests: jump straight to the lineup / force a catch on the next wave / spawn a wave now
      toLineup: () => { if (S) { S.me.reset(SURF.lineup, S.me.v, S.frame.yawOf(1, 0), 'sit'); S.phase = 'wait'; } },
      spawnWave: (o = {}) => S && S.field.spawn({ u: S.me.u + 60, peakV: S.me.v, ...o }),
      frame: () => S && S.frame,
      get S() { return S; },
    },
  };
}

function angle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
