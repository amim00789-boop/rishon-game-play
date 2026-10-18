// Shared plumbing for the minigames: the DOM overlay (right-to-left aware, Rubik, game palette),
// a camera override that wins over the chase camera, world markers, effect merging and the
// minigame string table. No display text lives here; every label is a key under `mg.`.
import * as THREE from 'three';
import { t as i18nT, dir as i18nDir, rich, register, i18n } from '../../i18n.js';

export { rich };

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export const COLORS = {
  ink: '#23324a', paper: 'rgba(255, 252, 244, 0.9)', yellow: '#ffcb3d', teal: '#2ec4b6', coral: '#ff6f59',
  orange: '#ffb347', purple: '#b36bd6', red: '#e8364f', mint: '#7fe0d6',
};

// The game passes i18n.t; standalone tools may pass nothing.
export const textFn = (t) => (typeof t === 'function' ? t : i18nT);

// Minigame text lives in data/i18n/minigames.<lang>.json (same shape in every language) and is
// registered under `mg`, so t('mg.rhythm.perfect') resolves. English is the fallback table.
export async function loadMinigameStrings(base = new URL('../../../data/i18n/', import.meta.url).href) {
  const get = async (lang) => {
    const r = await fetch(`${base}minigames.${lang}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`minigames.${lang}.json: HTTP ${r.status}`);
    return r.json();
  };
  const fallback = await get('en').catch((e) => { console.warn('[minigames] no English strings', e.message); return {}; });
  const active = i18n.lang === 'en' ? fallback : await get(i18n.lang).catch(() => null);
  register('mg', active || fallback, fallback);
}

// ---------------------------------------------------------------------------------------------
// DOM overlay

const CSS = `
.mg-root { position: fixed; inset: 0; pointer-events: none; z-index: 6; color: ${COLORS.ink};
  font-family: "Rubik", "Nunito", "Trebuchet MS", system-ui, sans-serif; user-select: none; }
.mg-panel { position: absolute; background: ${COLORS.paper}; border: 2px solid rgba(35, 50, 74, 0.85); border-radius: 12px;
  box-shadow: 0 3px 0 rgba(35, 50, 74, 0.35); padding: 8px 12px; box-sizing: border-box; }
.mg-hide { display: none !important; }
.mg-title { font-weight: 900; font-size: 15px; }
.mg-big { font-weight: 900; font-size: 26px; }
.mg-small { font-size: 12px; font-weight: 700; opacity: 0.8; }
.mg-num { unicode-bidi: isolate; direction: ltr; display: inline-block; font-variant-numeric: tabular-nums; }
.mg-bar { height: 10px; border: 2px solid ${COLORS.ink}; border-radius: 7px; background: #fff8ea; overflow: hidden; position: relative; }
.mg-bar > i { position: absolute; inset: 0 auto 0 0; display: block; background: ${COLORS.teal}; transition: width 0.2s; }
[dir="rtl"] .mg-bar > i { inset: 0 0 0 auto; }
.mg-bar > b { position: absolute; top: -3px; bottom: -3px; width: 2px; background: ${COLORS.red}; }
.mg-btn { pointer-events: auto; cursor: pointer; font: inherit; font-weight: 800; font-size: 15px; color: ${COLORS.ink};
  background: ${COLORS.yellow}; border: 2px solid ${COLORS.ink}; border-radius: 9px; padding: 6px 14px; margin: 4px;
  box-shadow: 0 2px 0 rgba(35, 50, 74, 0.4); }
.mg-btn.alt { background: #fff; }
.mg-btn:active { transform: translateY(1px); box-shadow: none; }
.mg-center { left: 50%; top: 38%; transform: translate(-50%, -50%); text-align: center; min-width: 260px;
  max-width: min(520px, calc(100vw - 32px)); pointer-events: auto; }
.mg-count { position: absolute; left: 50%; top: 32%; transform: translate(-50%, -50%); font-size: 96px; font-weight: 900;
  color: #fff; -webkit-text-stroke: 4px ${COLORS.ink}; text-shadow: 0 6px 0 rgba(35, 50, 74, 0.45); pointer-events: none; }
.mg-pop { animation: mg-pop 0.35s ease-out; }
@keyframes mg-pop { from { transform: translate(-50%, -50%) scale(1.5); opacity: 0.2; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
.mg-toast { position: absolute; left: 50%; top: 150px; transform: translateX(-50%); background: ${COLORS.yellow};
  border: 2px solid ${COLORS.ink}; border-radius: 10px; padding: 4px 12px; font-weight: 900; font-size: 15px;
  opacity: 0; transition: opacity 0.2s; white-space: nowrap; }
.mg-toast.on { opacity: 1; }
/* Phone up: the game HUD steps aside so the viewfinder is clean. */
body.mg-phone .hud-panel, body.mg-phone #hud-map, body.mg-phone #hud-attrib { visibility: hidden; }
.mg-opts { list-style: none; margin: 8px 0 0; padding: 0; text-align: start; }
.mg-opts li { pointer-events: auto; cursor: pointer; margin: 5px 0; padding: 6px 10px; border: 2px solid rgba(35, 50, 74, 0.35);
  border-radius: 9px; background: rgba(255, 255, 255, 0.8); font-size: 15px; }
.mg-opts li:hover { background: #ffe3b0; border-color: ${COLORS.ink}; }
`;

function injectStyle() {
  if (document.getElementById('mg-style')) return;
  const s = document.createElement('style');
  s.id = 'mg-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// A full-screen layer for one minigame. `html` is static markup (no text); text goes in later
// through textContent / rich(). Returns the root and a query helper.
export function createOverlay(cls, html = '') {
  injectStyle();
  const root = document.createElement('div');
  root.className = `mg-root ${cls}`;
  root.dir = i18nDir();
  root.innerHTML = html;
  document.body.appendChild(root);
  const $ = (sel) => root.querySelector(sel);
  return { root, $, remove() { root.remove(); } };
}

export function addStyle(id, css) {
  injectStyle();
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
}

// Short message near the top of the screen.
export function toaster(root) {
  const el = document.createElement('div');
  el.className = 'mg-toast';
  root.appendChild(el);
  let timer = 0;
  return (text, ms = 1300) => {
    el.innerHTML = rich(text);
    el.classList.add('on');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('on'), ms);
  };
}

// Result / retry card. buttons: [{ label, key: 'Enter'|'Escape'|..., onClick, alt }].
// Keyboard shortcuts work while the card is open; returns a close function.
export function showCard(root, { title, big, lines = [], buttons = [] }) {
  const card = document.createElement('div');
  card.className = 'mg-panel mg-center';
  if (title) { const e = document.createElement('div'); e.className = 'mg-title'; e.textContent = title; card.appendChild(e); }
  if (big) { const e = document.createElement('div'); e.className = 'mg-big'; e.textContent = big; card.appendChild(e); }
  for (const l of lines) { const e = document.createElement('div'); e.innerHTML = rich(l); card.appendChild(e); }
  const row = document.createElement('div');
  row.style.marginTop = '8px';
  const keyMap = new Map();
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'mg-btn' + (b.alt ? ' alt' : '');
    btn.innerHTML = rich(b.label);
    btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); fire(b); });
    row.appendChild(btn);
    for (const k of [].concat(b.key || [])) keyMap.set(k, b);
  }
  card.appendChild(row);
  root.appendChild(card);
  let closed = false;
  const onKey = (e) => {
    const b = keyMap.get(e.code);
    if (!b || e.repeat) return;
    e.preventDefault();
    fire(b);
  };
  // Opened by a key press in the same frame? Let that press finish first.
  const armT = setTimeout(() => window.addEventListener('keydown', onKey, true), 120);
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(armT);
    window.removeEventListener('keydown', onKey, true);
    card.remove();
  }
  function fire(b) { if (closed) return; close(); b.onClick && b.onClick(); }
  return Object.assign(close, { fire: (i) => fire(buttons[i]), el: card });
}

// Big centred countdown (3, 2, 1, go). Calls onTick(n) and resolves when done. Driven by the
// minigame's update (dt), so it pauses with the game.
export function countdown(root, labels) {
  const el = document.createElement('div');
  el.className = 'mg-count';
  root.appendChild(el);
  let i = -1, acc = 1;
  return {
    update(dt) {
      acc += dt;
      if (acc < 0.8) return false;
      acc = 0;
      i++;
      if (i >= labels.length) { el.remove(); return true; }
      el.textContent = labels[i];
      el.classList.remove('mg-pop'); void el.offsetWidth; el.classList.add('mg-pop');
      return false;
    },
    get step() { return i; },
    remove() { el.remove(); },
  };
}

export const fmtTime = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

// ---------------------------------------------------------------------------------------------
// Camera override. main.js updates the chase camera after quests (and so after the minigames)
// in every frame, so a minigame view is applied at render time through scene.onBeforeRender,
// which three calls before it reads the camera matrices. One rig per scene; the latest owner wins.

export function cameraRig(scene, camera) {
  if (scene.userData.mgRig) return scene.userData.mgRig;
  const prev = scene.onBeforeRender;
  const stack = [];
  let baseFov = null;
  const apply = () => {
    const top = stack[stack.length - 1];
    if (!top || !top.pos) return;
    camera.position.copy(top.pos);
    if (top.quat) camera.quaternion.copy(top.quat); else camera.lookAt(top.look);
    if (top.fov && camera.fov !== top.fov) { camera.fov = top.fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld(true);
  };
  scene.onBeforeRender = function (...args) {
    if (prev) prev.apply(this, args);
    apply();
  };
  const rig = {
    // Each minigame takes a handle and sets its pose every frame it wants the view.
    take() {
      const h = { pos: null, look: new THREE.Vector3(), quat: null, fov: null };
      if (baseFov === null) baseFov = camera.fov;
      stack.push(h);
      h.set = (pos, look, fov = null) => {
        h.pos = h.pos || new THREE.Vector3();
        h.pos.copy(pos); h.look.copy(look); h.quat = null; h.fov = fov;
      };
      h.setQuat = (pos, quat, fov = null) => {
        h.pos = h.pos || new THREE.Vector3();
        h.pos.copy(pos); h.quat = (h.quat || new THREE.Quaternion()).copy(quat); h.fov = fov;
      };
      h.release = () => {
        const i = stack.indexOf(h);
        if (i >= 0) stack.splice(i, 1);
        if (!stack.length && baseFov !== null && camera.fov !== baseFov) { camera.fov = baseFov; camera.updateProjectionMatrix(); }
        if (!stack.length) baseFov = null;
      };
      return h;
    },
    // Apply now (for code that raycasts against the override view between frames).
    apply,
  };
  scene.userData.mgRig = rig;
  return rig;
}

// ---------------------------------------------------------------------------------------------
// World helpers

// Walkable height: the game's surface function (terrain + bridges) when given, else city.heightAt.
export function surfaceFn(deps) {
  if (typeof deps.surface === 'function') return deps.surface;
  if (deps.city && typeof deps.city.heightAt === 'function') return (x, z, y) => deps.city.heightAt(x, z, y);
  return () => 0;
}
export function groundY(surface, x, z, y = Infinity) {
  try { const h = surface(x, z, y); return Number.isFinite(h) ? h : 0; } catch (_) { return 0; }
}

// Avatar factory: the game's makeAvatar when passed, else characters/avatar.js, else a capsule.
let avatarMod = null;
const avatarReady = import('../../characters/avatar.js').then((m) => { avatarMod = m; }).catch(() => {});
export async function avatarFactory(deps) {
  if (typeof deps.makeAvatar === 'function') return deps.makeAvatar;
  await avatarReady;
  if (avatarMod && avatarMod.createAvatar) return (cfg) => avatarMod.createAvatar(cfg);
  return () => capsuleAvatar();
}
export function capsuleAvatar(color = 0x3f8efc) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1, 2.6, 4, 10), new THREE.MeshToonMaterial({ color }));
  body.position.y = 2.3;
  body.castShadow = true;
  group.add(body);
  return { group, setMode() {}, update() {}, emote() {} };
}

// A vertical ring with an arrow, for race checkpoints.
export function ringMarker(color = 0x2ec4b6) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(6, 0.55, 10, 40), mat);
  ring.position.y = 6.5;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(5.6, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
  disc.position.y = 6.5;
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.2, 12), new THREE.MeshBasicMaterial({ color: 0xffcb3d }));
  arrow.rotation.x = Math.PI / 2; // cone tip along +z
  arrow.position.set(0, 14.5, 0);
  const foot = new THREE.Mesh(new THREE.RingGeometry(5, 6.2, 36),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }));
  foot.rotation.x = -Math.PI / 2;
  foot.position.y = 0.2;
  g.add(ring, disc, arrow, foot);
  g.userData = { ring, disc, arrow, foot, mat };
  g.renderOrder = 5;
  return g;
}

// A tall translucent column (same look as the quest beams).
export function beamMarker(color = 0x2ec4b6, radius = 2.2, height = 60) {
  const g = new THREE.Group();
  const col = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
  col.position.y = height / 2;
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 1.45, radius * 1.9, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.15;
  g.add(col, ring);
  g.userData.ring = ring;
  return g;
}

// A camera-facing round icon with a glyph (no words, so no text in source).
export function iconSprite(glyph, bg = '#ffcb3d', fg = '#23324a', size = 3) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.strokeStyle = '#23324a'; g.lineWidth = 10;
  g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = fg; g.font = 'bold 70px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(glyph, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false }));
  s.scale.set(size, size, 1);
  s.renderOrder = 12;
  return s;
}

export function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
  });
}

// Move the player (retry from the start of a step). Uses the Player's own fields.
export function placePlayer(player, at, heading) {
  if (!player || !at) return;
  player.pos.x = at.x; player.pos.z = at.z;
  player.speed = 0;
  if (typeof heading === 'number') player.heading = heading;
  if (player.collision && player.params) player.collision.resolve(player.pos, player.params.radius);
  if (player.groundAt) { player.y = player.groundAt(player.pos.x, player.pos.z, Infinity); player.vy = 0; player.onGround = true; }
  if (player.root) { player.root.position.set(player.pos.x, player.y || 0, player.pos.z); player.root.rotation.y = player.heading; }
}

// ---------------------------------------------------------------------------------------------
// Effects (see story.js): { scale, trust: { sector: n }, flag | flags }

export function mergeEffects(...list) {
  const out = { scale: 0, trust: {}, flags: [] };
  for (const e of list) {
    if (!e) continue;
    out.scale += e.scale || 0;
    for (const [k, v] of Object.entries(e.trust || {})) out.trust[k] = (out.trust[k] || 0) + v;
    for (const f of [].concat(e.flag || [], e.flags || [])) if (f && !out.flags.includes(f)) out.flags.push(f);
  }
  return out;
}

// One-shot keyboard listener set for a minigame, removed together on finish.
export function keyListener(fn) {
  const h = (e) => fn(e);
  window.addEventListener('keydown', h, true);
  return () => window.removeEventListener('keydown', h, true);
}

// ---------------------------------------------------------------------------------------------
// Jump to the start: fade to black, run `onDark` (route planning, placing rivals), teleport the
// player with their vehicle to `spot` facing `heading`, snap the chase camera behind them, fade
// back in. Resolves when the picture starts coming back (the moment to begin a 3-2-1).
//   await jumpToStart(deps, { x, z, heading, mode }, { onDark() { return spotOverride | void } })
// The chase camera comes from deps.chase (or window.__game.chase); without one the camera glides
// over during the hold.
export function jumpToStart(deps, spot, { onDark = null, fade = 0.35, hold = 0.45 } = {}) {
  injectStyle();
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'mg-fade';
    el.style.cssText = `position:fixed;inset:0;background:#0b1022;opacity:0;transition:opacity ${fade}s;pointer-events:none;z-index:30;`;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '1'; }, 20);
    setTimeout(() => {
      let to = spot;
      try { const r = onDark && onDark(); if (r && typeof r.x === 'number') to = r; } catch (e) { console.warn('[minigames] jump planning failed', e); }
      const pl = deps.player;
      if (to && pl) {
        if (to.mode && pl.mode !== to.mode && pl.setMode) pl.setMode(to.mode);
        placePlayer(pl, to, to.heading);
        const chase = deps.chase || (typeof window !== 'undefined' && window.__game && window.__game.chase);
        if (chase) {
          chase.inited = false;
          if (typeof to.heading === 'number') chase.yaw = to.heading;
          chase.clipDist = 1e4;
        }
      }
      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), fade * 1000 + 50);
        resolve(to);
      }, hold * 1000);
    }, fade * 1000 + 40);
  });
}

// Nearest spot to (x, z) with `r` units of clear space (props, cars, walls), searched in rings.
export function clearSpot(collision, x, z, r = 2.2, clearAtFn = null) {
  const ok = (px, pz) => (clearAtFn ? clearAtFn(collision, px, pz, r) : collision.isFree(px, pz, r));
  if (!collision || ok(x, z)) return { x, z };
  for (let ring = 1; ring <= 12; ring++) {
    const rad = ring * 1.5, n = 8 + ring * 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (ok(x + Math.cos(a) * rad, z + Math.sin(a) * rad)) return { x: x + Math.cos(a) * rad, z: z + Math.sin(a) * rad };
    }
  }
  return { x, z };
}
