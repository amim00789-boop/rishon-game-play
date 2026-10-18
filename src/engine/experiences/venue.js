// Shared plumbing for the "experiences" (cinema, show, bar stage, skate tournament): an interior
// set that replaces the city for a few seconds, fades, a seated double of the player, a camera
// handle and screen-space projection for speech bubbles.
//
//   const v = openVenue(deps, { at: { x, z }, background: 0x0b0f1a });
//   v.root.add(myHall);                     // local coordinates, origin on the hall floor
//   v.cam.set(worldPos, worldLook, fov);    // every frame (common.js cameraRig)
//   const me = await v.double();            // the player's look, as a separate avatar
//   v.close();                              // everything back as it was
//
// Isolation: every top-level scene child is hidden while the venue is open, so only the set
// renders (cheap, and the city never peeks through a wall). The set sits high above the venue's
// real spot, so anything another system re-shows on its own stays far out of view.
import * as THREE from 'three';
import { cameraRig, addStyle, avatarFactory, disposeTree } from '../minigames/common.js';

export const SET_Y = 2400;

addStyle('exp-style-venue', `
body.exp-on .hud-panel, body.exp-on #hud-map, body.exp-on #hud-attrib, body.exp-on .hud-prompt { visibility: hidden; }
.exp-fade { position: fixed; inset: 0; background: #070a14; pointer-events: none; z-index: 30; transition: opacity 0.4s; }
`);

// Black overlay: fadeOut() -> resolves when black, fadeIn() -> resolves when clear.
export function fader(seconds = 0.4) {
  const el = document.createElement('div');
  el.className = 'exp-fade';
  el.style.transition = `opacity ${seconds}s`;
  el.style.opacity = '0';
  document.body.appendChild(el);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    el,
    async out() { void el.offsetWidth; el.style.opacity = '1'; await wait(seconds * 1000 + 40); },
    async in() { el.style.opacity = '0'; await wait(seconds * 1000 + 40); },
    black() { el.style.transition = 'none'; el.style.opacity = '1'; void el.offsetWidth; el.style.transition = `opacity ${seconds}s`; },
    remove() { el.remove(); },
  };
}

export function poisOf(deps) {
  return deps.pois || (typeof window !== 'undefined' && window.__game && window.__game.landmarks && window.__game.landmarks.pois) || [];
}
export function poiSpot(deps, ids) {
  const pois = poisOf(deps);
  for (const id of [].concat(ids)) {
    const p = pois.find((q) => q.id === id);
    if (p) return { x: p.x, z: p.z, id };
  }
  return null;
}

// The player's own look as a second avatar (the real one stays with the Player).
export async function makeDouble(deps, patch = null) {
  const make = await avatarFactory(deps);
  const pl = deps.player;
  const base = pl && pl.avatar && pl.avatar.config ? pl.avatar.config : 'player_rishoni';
  let cfg = base;
  if (patch) cfg = typeof base === 'string' ? { archetype: base, ...patch } : { ...base, ...patch, style: { ...(base.style || {}), ...(patch.style || {}) } };
  try { return make(cfg); } catch (e) { console.warn('[experiences] double failed', e); return make('player_rishoni'); }
}

export function openVenue(deps, { at = null, background = 0x0b0f1a, isolate = true } = {}) {
  const scene = deps.scene, camera = deps.camera;
  const spot = at || (deps.player ? { x: deps.player.pos.x, z: deps.player.pos.z } : { x: 0, z: 0 });
  const root = new THREE.Group();
  root.name = 'exp-venue';
  root.position.set(spot.x, isolate ? SET_Y : 0, spot.z);
  const hidden = [];
  const saved = { background: scene.background, fog: scene.fog };
  if (isolate) {
    for (const c of scene.children) { if (c.visible) { hidden.push(c); c.visible = false; } }
    scene.background = new THREE.Color(background);
    scene.fog = null;
  }
  scene.add(root);
  root.updateMatrixWorld(true);
  const cam = cameraRig(scene, camera).take();
  document.body.classList.add('exp-on');
  const scratch = new THREE.PerspectiveCamera();
  const avatars = [];
  const _w = new THREE.Vector3(), _l = new THREE.Vector3();
  let lastPos = new THREE.Vector3(), lastLook = new THREE.Vector3(), lastFov = camera.fov;

  const v = {
    root, cam, spot, isolated: isolate,
    // local -> world
    world(x, y, z, out = new THREE.Vector3()) { return out.set(x, y, z).applyMatrix4(root.matrixWorld); },
    // Camera in local coordinates.
    look(px, py, pz, lx, ly, lz, fov = null) {
      v.world(px, py, pz, _w); v.world(lx, ly, lz, _l);
      lastPos.copy(_w); lastLook.copy(_l); lastFov = fov || camera.fov;
      cam.set(_w, _l, fov);
    },
    // World point -> CSS pixels for the current venue camera; on = in front and on screen.
    project(p) {
      scratch.fov = lastFov; scratch.aspect = camera.aspect; scratch.near = camera.near; scratch.far = camera.far;
      scratch.position.copy(lastPos); scratch.lookAt(lastLook);
      scratch.updateProjectionMatrix(); scratch.updateMatrixWorld(true);
      const q = p.clone().project(scratch);
      const r = (deps.renderer && deps.renderer.domElement) ? deps.renderer.domElement.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      return { x: r.left + (q.x * 0.5 + 0.5) * r.width, y: r.top + (-q.y * 0.5 + 0.5) * r.height, on: q.z < 1 && Math.abs(q.x) < 1.1 && Math.abs(q.y) < 1.1 };
    },
    // Avatars added through here are updated by tick() and disposed by close().
    async avatar(cfg, parent = root) {
      const make = await avatarFactory(deps);
      const a = make(cfg);
      parent.add(a.group);
      avatars.push(a);
      return a;
    },
    async double(patch, parent = root) {
      const a = await makeDouble(deps, patch);
      parent.add(a.group);
      avatars.push(a);
      return a;
    },
    adopt(a) { if (a && !avatars.includes(a)) avatars.push(a); return a; },
    // Update avatars; `every` > 1 spreads far ones over frames.
    tick(dt) {
      for (const a of avatars) { try { a.update(dt, a.userSpeed || 0); } catch (_) { /* optional */ } }
    },
    close() {
      cam.release();
      scene.remove(root);
      for (const c of hidden) c.visible = true;
      if (isolate) { scene.background = saved.background; scene.fog = saved.fog; }
      document.body.classList.remove('exp-on');
      disposeTree(root);
      const chase = deps.chase || (typeof window !== 'undefined' && window.__game && window.__game.chase);
      if (chase) chase.inited = false;
    },
  };
  return v;
}

// Hide the real player while a double stands in for them; returns the restore function.
export function hidePlayer(deps) {
  const pl = deps.player;
  if (!pl || !pl.root) return () => {};
  const was = pl.root.visible;
  pl.root.visible = false;
  return () => { pl.root.visible = was; };
}
