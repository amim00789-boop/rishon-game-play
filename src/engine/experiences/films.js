// The two short films the cinemas screen: original cartoon "trailers" rendered live from the
// game's own characters and toon props into a render target that the auditorium screen shows.
// Nothing here is real footage; the music is composed note by note for these clips.
//
//   const film = await createFilm('dino' | 'space', deps, t, { onGag });
//   per frame: film.update(dt); film.render(renderer);   screen material map = film.texture
//   film.done (true after the last shot), film.glow (THREE.Color: what the screen throws on the hall)
//   film.dispose()
//
// A film is a list of shots on one clock; each shot sets its own camera and actors from its
// local time, so seeking (tests, ?film=) lands on the right picture. Sound and the hall's
// laughs fire from a cue list as the clock passes them.
import * as THREE from 'three';
import { toon, basic, mesh, box, cyl, ball, rbox, textCanvas, popcornBucket, ease, seg, lerp } from './kit.js';
import { getSfx } from './sfx.js';
import { avatarFactory, disposeTree } from '../minigames/common.js';

const W = 960, H = 540, FOV = 40;
const TAU = Math.PI * 2;

// ---- small builders ---------------------------------------------------------------------------
function rnd(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

let windowTex = null;
function windows() {
  if (windowTex) return windowTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#7fb3d9';
  for (let y = 6; y < 64; y += 16) for (let x = 6; x < 64; x += 16) g.fillRect(x, y, 8, 9);
  windowTex = new THREE.CanvasTexture(c);
  windowTex.colorSpace = THREE.SRGBColorSpace;
  windowTex.wrapS = windowTex.wrapT = THREE.RepeatWrapping;
  return windowTex;
}
function building(w, h, d, color, x, z, parent) {
  const tex = windows().clone();
  tex.needsUpdate = true;
  tex.repeat.set(Math.max(1, Math.round(w / 3)), Math.max(1, Math.round(h / 3)));
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshToonMaterial({ color, map: tex }));
  m.position.set(x, h / 2, z);
  parent.add(m);
  box(w + 0.6, 0.6, d + 0.6, 0xf4efe6, x, h, z, parent);
  return m;
}
function palm(x, z, h, parent, lean = 0.1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.z = lean;
  cyl(0.35, 0.5, h, 0x9b7653, 0, 0, 0, g, 8);
  for (let i = 0; i < 6; i++) {
    const leaf = mesh(new THREE.ConeGeometry(0.9, 5, 4), toon(0x3f9b4b), 0, h, 0, g);
    leaf.geometry.translate(0, 2.5, 0);
    leaf.rotation.set(Math.PI / 2 - 0.5, (i / 6) * TAU, 0, 'YXZ');
  }
  parent.add(g);
  return g;
}
function bench(x, z, parent) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  box(5, 0.3, 1.4, 0xb5753c, 0, 1.0, 0, g);
  box(5, 1.2, 0.25, 0xb5753c, 0, 1.5, -0.65, g);
  for (const s of [-2.1, 2.1]) box(0.25, 1.0, 1.2, 0x3a3a44, s, 0, 0, g);
  parent.add(g);
  return g;
}
// Rishon's old water tower, in toon: a tapered shaft and a drum on top.
function waterTower(x, z, parent) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  cyl(1.6, 2.2, 16, 0xe4d2b0, 0, 0, 0, g, 12);
  cyl(4.2, 3.0, 4, 0xd9c19a, 0, 16, 0, g, 16);
  cyl(4.5, 4.5, 0.6, 0xb98b5e, 0, 20, 0, g, 16);
  mesh(new THREE.ConeGeometry(4.6, 2.2, 16), toon(0xc0533a), 0, 21.7, 0, g);
  parent.add(g);
  return g;
}
function stars(n, r, seed) {
  const R = rnd(seed), pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = R() * 2 - 1, a = R() * TAU, s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(a) * s * r, u * r, Math.sin(a) * s * r], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false }));
}

// A cartoon T-rex, feet at y = 0, facing +z, about three avatars tall.
function trex() {
  const green = 0x63c24f, belly = 0xd2ea9c, dark = 0x3f8f3a;
  const group = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 7.2;
  group.add(hips);
  const body = ball(1, green, 0, 1.4, 0, hips); body.scale.set(3.1, 2.9, 4.3); body.rotation.x = -0.45;
  const bel = ball(1, belly, 0, 1.0, 1.1, hips); bel.scale.set(2.4, 2.3, 3.2); bel.rotation.x = -0.45;
  for (let i = 0; i < 6; i++) {
    const sp = mesh(new THREE.ConeGeometry(0.55, 1.4, 6), toon(dark), 0, 4.0 - i * 0.55, 1.6 - i * 1.25, hips);
    sp.rotation.x = -0.4;
  }
  const head = new THREE.Group();
  head.position.set(0, 4.6, 3.2);
  hips.add(head);
  rbox(3.4, 2.3, 4.6, 0.7, green, 0, -0.3, 1.5, head);
  for (const s of [-1, 1]) {
    // googly eyes on top of the snout, where the camera can see them
    ball(0.66, 0xffffff, s * 0.95, 1.0, 2.3, head);
    ball(0.32, 0x141414, s * 1.0, 1.1, 2.85, head);
    const brow = box(1.0, 0.28, 0.4, dark, s * 0.95, 1.75, 2.2, head); brow.rotation.z = -s * 0.3;
  }
  for (let i = 0; i < 7; i++) {
    const tooth = mesh(new THREE.ConeGeometry(0.17, 0.5, 5), toon(0xffffff), -1.3 + i * 0.43, -0.65, 3.55, head);
    tooth.rotation.x = Math.PI;
  }
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.55, -0.4);
  head.add(jaw);
  rbox(3.0, 0.8, 4.2, 0.3, belly, 0, -0.5, 1.9, jaw);
  const tail = new THREE.Group();
  tail.position.set(0, 1.4, -3.4);
  hips.add(tail);
  const tc = mesh(new THREE.ConeGeometry(1.7, 9, 12), toon(green), 0, 0, -4.2, tail);
  tc.rotation.x = -Math.PI / 2 - 0.15;
  const legs = [-1, 1].map((s) => {
    const leg = new THREE.Group();
    leg.position.set(s * 2.1, 7.2, -0.2);
    group.add(leg);
    const th = ball(1.6, green, 0, -0.8, 0, leg); th.scale.set(1, 1.4, 1.3);
    cyl(0.75, 0.6, 4.6, green, 0, -6.6, -0.2, leg, 10);
    rbox(1.9, 0.8, 2.8, 0.3, dark, 0, -7.2, 0.6, leg);
    return leg;
  });
  const arms = [-1, 1].map((s) => {
    const arm = new THREE.Group();
    arm.position.set(s * 1.7, 2.6, 2.9);
    hips.add(arm);
    const a = cyl(0.26, 0.2, 1.7, green, 0, -1.7, 0, arm, 8);
    a.rotation.x = 0.3;
    ball(0.3, belly, 0, -1.8, 0.5, arm);
    return arm;
  });
  // walk(phase) / roar(0..1) / dance(t) / tilt(rad): pose setters, called every frame.
  return {
    group, hips, head, jaw, tail, legs, arms,
    pose({ walk = null, roar = 0, dance = null, tilt = 0 } = {}) {
      const w = walk == null ? 0 : walk;
      legs[0].rotation.x = walk == null ? 0 : Math.sin(w) * 0.45;
      legs[1].rotation.x = walk == null ? 0 : -Math.sin(w) * 0.45;
      hips.position.y = 7.2 + (walk == null ? 0 : Math.abs(Math.cos(w)) * 0.5);
      tail.rotation.y = walk == null ? 0 : Math.sin(w) * 0.25;
      hips.rotation.set(0, 0, 0);
      group.position.y = 0;
      arms[0].rotation.x = arms[1].rotation.x = 0;
      if (dance != null) {
        hips.rotation.z = Math.sin(dance * 4) * 0.18;
        tail.rotation.y = Math.sin(dance * 4) * 0.6;
        arms[0].rotation.x = Math.sin(dance * 8) * 0.9;
        arms[1].rotation.x = -Math.sin(dance * 8) * 0.9;
        legs[0].rotation.x = Math.max(0, Math.sin(dance * 4)) * 0.5;
        legs[1].rotation.x = Math.max(0, -Math.sin(dance * 4)) * 0.5;
        group.position.y = Math.abs(Math.sin(dance * 4)) * 0.8;
      }
      jaw.rotation.x = 0.75 * roar;
      head.rotation.set(-0.35 * roar + (dance != null ? Math.sin(dance * 8) * 0.12 : 0), 0, tilt);
    },
  };
}

function rocket() {
  const g = new THREE.Group();
  cyl(2.2, 2.2, 11, 0xf4f4f4, 0, 2.5, 0, g, 20);
  mesh(new THREE.ConeGeometry(2.2, 4.5, 20), toon(0xe8364f), 0, 15.75, 0, g);
  cyl(2.25, 2.25, 1.0, 0xe8364f, 0, 6, 0, g, 20);
  const win = ball(1.0, 0x7fd3ff, 0, 10, 1.95, g); win.scale.z = 0.4;
  cyl(1.1, 1.1, 0.2, 0x3a3a44, 0, 9.9, 1.9, g, 16).rotation.x = Math.PI / 2;
  for (let i = 0; i < 4; i++) {
    const fin = box(0.35, 4.5, 2.6, 0xe8364f, 0, 0.5, 0, null);
    fin.geometry.translate(0, 0, 2.6);
    fin.rotation.y = i * Math.PI / 2 + Math.PI / 4;
    g.add(fin);
  }
  cyl(1.4, 1.8, 1.4, 0x555566, 0, 1.1, 0, g, 16);
  const flame = new THREE.Group();
  flame.position.y = 1.1;
  g.add(flame);
  const f1 = mesh(new THREE.ConeGeometry(1.5, 6, 14), basic(0xffb02e), 0, -3, 0, flame); f1.rotation.x = Math.PI;
  const f2 = mesh(new THREE.ConeGeometry(0.8, 3.5, 12), basic(0xfff3b0), 0, -1.8, 0, flame); f2.rotation.x = Math.PI;
  flame.visible = false;
  return { group: g, flame };
}

function ufo() {
  const g = new THREE.Group();
  const disc = ball(1, 0xb9c3cf, 0, 0, 0, g); disc.scale.set(6, 1.3, 6);
  const dome = ball(2.6, 0x9ff0d6, 0, 0.9, 0, g); dome.material = new THREE.MeshToonMaterial({ color: 0x9ff0d6, transparent: true, opacity: 0.55 });
  const lights = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    lights.push(mesh(new THREE.SphereGeometry(0.42, 10, 8), basic(0xffcb3d), Math.cos(a) * 5.4, -0.2, Math.sin(a) * 5.4, g));
  }
  return { group: g, lights };
}
// The visitor: round, green, two antennae, very polite.
function alien() {
  const g = new THREE.Group();
  const body = mesh(new THREE.CapsuleGeometry(1.1, 1.4, 4, 12), toon(0x7ddc5a), 0, 1.8, 0, g);
  const head = new THREE.Group();
  head.position.y = 4.2;
  g.add(head);
  ball(1.6, 0x7ddc5a, 0, 0, 0, head);
  for (const s of [-1, 1]) {
    ball(0.55, 0xffffff, s * 0.65, 0.3, 1.3, head);
    ball(0.26, 0x141414, s * 0.7, 0.32, 1.75, head);
    const ant = cyl(0.08, 0.08, 1.6, 0x4caf50, s * 0.7, 1.2, 0, head, 6); ant.rotation.z = -s * 0.35;
  }
  const tips = [-1, 1].map((s) => ball(0.3, 0xff6f59, s * 1.25, 2.75, 0, head));
  const mouth = box(0.9, 0.12, 0.2, 0x2a4d1e, 0, -0.65, 1.45, head);
  const arms = [-1, 1].map((s) => {
    const a = new THREE.Group();
    a.position.set(s * 1.1, 2.6, 0);
    g.add(a);
    cyl(0.18, 0.18, 1.6, 0x7ddc5a, 0, -1.6, 0, a, 6);
    return a;
  });
  return { group: g, head, tips, mouth, arms, body };
}
function pita() {
  const m = mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.3, 16, 1, false, 0, Math.PI), toon(0xe8c184));
  m.rotation.set(Math.PI / 2, 0, 0);
  const g = new THREE.Group();
  g.add(m);
  ball(0.22, 0x8a5a2b, 0.2, 0.2, 0.1, g); ball(0.2, 0x4caf50, -0.2, 0.25, 0.1, g);
  return g;
}
// A fishbowl helmet on an avatar's head joint (head-joint units).
function helmet(av) {
  const head = av && av.joints && av.joints.head;
  if (!head) return null;
  const m = new THREE.Mesh(new THREE.SphereGeometry(1.25, 20, 14), new THREE.MeshToonMaterial({ color: 0xcff4ff, transparent: true, opacity: 0.32, depthWrite: false }));
  m.position.y = 0.55;
  m.renderOrder = 3;
  head.add(m);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.14, 8, 20), toon(0xdddddd));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.45;
  head.add(ring);
  return m;
}

// ---- music (original, written for these clips) -------------------------------------------------
const M = {
  // a cheerful march for the sunny town
  town: [[0, 60, 1], [1, 64, 1], [2, 67, 1], [3, 64, 0.5], [3.5, 65, 0.5], [4, 67, 2], [6, 72, 1], [7, 71, 1], [8, 69, 1], [9, 67, 1], [10, 65, 1], [11, 64, 1], [12, 62, 2], [14, 60, 2],
    [0, 36, 2], [2, 43, 2], [4, 41, 2], [6, 43, 2], [8, 45, 2], [10, 41, 2], [12, 43, 2], [14, 36, 2]],
  // creeping low notes while the ground shakes
  creep: [[0, 40, 1.5], [2, 41, 1.5], [4, 40, 1.5], [6, 43, 1.5], [8, 40, 1], [9, 41, 1], [10, 43, 1], [11, 44, 1]],
  // the dance groove
  groove: (() => {
    const n = [];
    const bass = [48, 48, 55, 58, 60, 58, 55, 53];
    const lead = [[0, 72, 1], [1, 74, 0.5], [1.5, 76, 1.5], [3, 74, 0.5], [3.5, 72, 0.5], [4, 79, 1], [5, 76, 1], [6, 74, 1], [7, 72, 1]];
    for (let bar = 0; bar < 4; bar++) {
      const k = bar % 2 ? 5 : 0;
      bass.forEach((m, i) => n.push([bar * 4 + i * 0.5, m + k - 12, 0.45]));
      if (bar % 2 === 0) lead.forEach(([b, m, l]) => n.push([bar * 4 + b, m, l]));
    }
    return n;
  })(),
  fanfare: [[0, 60, 0.5], [0.5, 64, 0.5], [1, 67, 0.5], [1.5, 72, 2.5], [1.5, 48, 2.5]],
  // night by the lake, waiting to launch
  launch: (() => {
    const n = [];
    const chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67]];
    chords.forEach((c, bar) => { for (let r = 0; r < 2; r++) c.forEach((m, i) => n.push([bar * 4 + r * 2 + i * 0.5, m, 0.45])); n.push([bar * 4, c[0] - 12, 4]); });
    return n;
  })(),
  float: [[0, 69, 3.5], [4, 67, 3.5], [8, 65, 3.5], [12, 64, 3.5], [0, 45, 4], [4, 43, 4], [8, 41, 4], [12, 40, 4], [2, 76, 1.5], [6, 74, 1.5], [10, 72, 1.5], [14, 71, 1.5]],
};

// ---- the film shell ------------------------------------------------------------------------------
async function shell(deps, t) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(FOV, W / H, 0.1, 2000);
  scene.add(camera);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.1);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(30, 60, 40);
  scene.add(hemi, sun);
  const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });

  // Camera-fixed planes: a full-frame title card and a subtitle strip, redrawn on change.
  const vh = 2 * Math.tan((FOV / 2) * Math.PI / 180), vw = vh * (W / H);
  const mk = (w, h, cw, ch, y) => {
    const tex = new THREE.CanvasTexture(document.createElement('canvas'));
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    m.position.set(0, y, -1);
    m.renderOrder = 10;
    m.visible = false;
    camera.add(m);
    return { m, tex, cw, ch, key: null };
  };
  const card = mk(vw, vh, 1280, 720, 0);
  const subs = mk(vw * 0.94, vh * 0.2, 1280, 192, -vh * 0.37);
  const draw = (p, key, lines, opts) => {
    if (p.key === key) return;
    p.key = key;
    if (!lines) { p.m.visible = false; return; }
    p.tex.image = textCanvas(lines, { w: p.cw, h: p.ch, ...opts });
    p.tex.needsUpdate = true;
    p.m.visible = true;
  };
  const make = await avatarFactory(deps);
  const actors = [];
  const S = {
    scene, camera, rt, t, actors, hemi, sun,
    glow: new THREE.Color(0x223355),
    fx: getSfx(deps.audio),
    // A title card: lines [{ key, size, color }], text from the film's string table.
    card(id, lines, bg = '#05060c') {
      draw(card, id, lines && lines.map((l) => ({ text: l.key ? t(l.key) : l.text, size: l.size || 90, color: l.color || '#ffffff', weight: l.weight })), { bg, stroke: null });
    },
    // A subtitle: speaker name key + line key; null clears.
    sub(name, key) {
      if (!key) return draw(subs, null, null);
      const lines = [];
      if (name) lines.push({ text: t(name), size: 44, color: '#ffe27a' });
      lines.push({ text: t(key), size: 60, color: '#ffffff' });
      draw(subs, key, lines, { stroke: '#000000', gap: 1.15 });
    },
    actor(cfg, parent = scene) {
      const a = make(cfg);
      parent.add(a.group);
      actors.push(a);
      return a;
    },
    look(px, py, pz, lx, ly, lz, fov = FOV) {
      camera.position.set(px, py, pz);
      camera.lookAt(lx, ly, lz);
      if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    },
    shake(k, time) { camera.position.x += Math.sin(time * 61) * k; camera.position.y += Math.sin(time * 47) * k; },
  };
  return S;
}

// Clock, shots and cues, shared by both films.
function runner(S, shots, cues, duration, hooks) {
  let time = 0, cur = -1, fired = 0, music = null, done = false;
  const stopMusic = () => { if (music) { try { music(); } catch (_) { /* gone */ } music = null; } };
  const ctx = {
    ...S,
    music(notes, bpm, v = 0.8, wave = 'triangle') { stopMusic(); music = S.fx.score(notes, bpm, v, wave); },
    stopMusic,
    gag(k = 1) { if (hooks.onGag) hooks.onGag(k); },
  };
  cues.sort((a, b) => a[0] - b[0]);
  function frame(dt, silent = false) {
    time += dt;
    while (fired < cues.length && cues[fired][0] <= time) { if (!silent) { try { cues[fired][1](ctx); } catch (e) { console.warn('[cinema] cue failed', e); } } fired++; }
    let i = shots.findIndex((s) => time >= s.from && time < s.to);
    if (i < 0) { i = shots.length - 1; if (time >= duration) done = true; }
    const s = shots[i];
    if (i !== cur) { cur = i; if (s.enter) s.enter(ctx); }
    s.tick(ctx, time - s.from, time, dt);
    for (const a of S.actors) if (a.group.visible) { try { a.update(dt, a.userSpeed || 0); } catch (_) { /* optional */ } }
  }
  return {
    texture: S.rt.texture,
    duration,
    get time() { return time; },
    get done() { return done; },
    glow: S.glow,
    update(dt) { if (!done) frame(Math.min(dt, 0.1)); },
    // Jump ahead without sound (tests and the "skip" key); actors catch up in coarse steps.
    seek(to) { while (time < to - 1e-3 && !done) frame(Math.min(0.1, to - time), true); },
    render(renderer) {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(S.rt);
      renderer.clear();
      renderer.render(S.scene, S.camera);
      renderer.setRenderTarget(prev);
    },
    pause() { stopMusic(); },
    dispose() {
      stopMusic();
      S.rt.dispose();
      disposeTree(S.scene);
    },
  };
}

// ---- film 1: the dinosaur (Cinema City) -------------------------------------------------------
async function dinoFilm(deps, t, hooks) {
  const S = await shell(deps, t);
  const { scene } = S;
  const K = (k) => `cinema.film.dino.${k}`;
  const town = new THREE.Group();
  scene.add(town);
  const ground = mesh(new THREE.PlaneGeometry(600, 600), toon(0x8fd16a), 0, 0, 0, town);
  ground.rotation.x = -Math.PI / 2;
  const road = mesh(new THREE.PlaneGeometry(600, 12), toon(0x5b5b66), 0, 0.03, 18, town);
  road.rotation.x = -Math.PI / 2;
  for (let i = -20; i < 20; i++) { const l = mesh(new THREE.PlaneGeometry(4, 0.6), basic(0xffffff), i * 10, 0.05, 18, town); l.rotation.x = -Math.PI / 2; }
  const R = rnd(1621457280);
  const cols = [0xf2a65a, 0xf7d488, 0x9fd8cb, 0xe98a8a, 0xb7a6e0, 0xf4efe6];
  for (let i = 0; i < 16; i++) building(10 + R() * 8, 12 + R() * 22, 10, cols[i % cols.length], -110 + i * 14, -32 - R() * 10, town);
  waterTower(46, -24, town);
  // a gap in the palm row behind the bench: the dinosaur's way in and the roar camera's line
  for (let i = 0; i < 8; i++) { const x = -60 + i * 16; if (x > -16 && x < 8) continue; palm(x, -14 - (i % 2) * 3, 9 + R() * 3, town); }
  bench(0, 0, town);
  const sunBall = ball(8, 0xffe066, 80, 90, -200, scene); sunBall.material = basic(0xffe066);
  for (let i = 0; i < 5; i++) { const c = ball(5, 0xffffff, -120 + i * 60, 70 + (i % 2) * 12, -180, scene); c.material = basic(0xffffff); c.scale.set(2.2, 0.9, 1); }

  const dekel = S.actor('dekel'), ofir = S.actor('ofir'), adir = S.actor('adir'), malul = S.actor('malul');
  const rex = trex();
  scene.add(rex.group);
  const pop = popcornBucket();
  scene.add(pop);
  const kit = new THREE.Group();
  scene.add(kit);

  const sit = (a, x) => { a.setMode('sit'); a.setSeat(1.15); a.group.position.set(x, 0, 0.35); a.group.rotation.y = 0; a.userSpeed = 0; };
  const reset = () => {
    for (const a of [dekel, ofir, adir, malul]) { a.group.visible = false; a.userSpeed = 0; a.group.position.y = 0; a.group.rotation.set(0, 0, 0); }
    rex.group.visible = false;
    pop.visible = false;
  };
  const sky = new THREE.Color(0x8fd3ff);

  const shots = [
    { from: 0, to: 4, enter(c) { reset(); scene.background = new THREE.Color(0x000000); c.card('ident', [{ key: K('ident1'), size: 64, color: '#ffcb3d' }, { key: K('ident2'), size: 110 }]); c.sub(null, null); },
      tick(c) { c.look(0, 6, 30, 0, 6, 0); } },
    { from: 4, to: 9, enter(c) { scene.background = sky; c.card('t1', [{ key: K('t1'), size: 100 }], 'rgba(0,0,0,0)'); },
      tick(c, k) { c.look(-70 + k * 14, 22 - k, 60, -40 + k * 16, 10, -20); } },
    { from: 9, to: 15, enter(c) { c.card(null); reset(); dekel.group.visible = ofir.group.visible = pop.visible = true; sit(dekel, -1.3); sit(ofir, 1.3); pop.position.set(0, 1.15, 0.2); pop.scale.setScalar(0.8); },
      tick(c, k) {
        c.look(0 + k * 0.6, 4.2, 15 - k * 0.8, 0, 3.0, 0, 34);
        dekel.setTalking(k < 2.6); ofir.setTalking(k > 3.1 && k < 5.6);
        c.sub(k < 3 ? K('n.dekel') : K('n.ofir'), k < 3 ? K('s1') : K('s2'));
      } },
    { from: 15, to: 19, enter(c) { c.sub(null, null); dekel.express('surprised', 4); ofir.express('surprised', 4); },
      tick(c, k, time) {
        c.look(2, 3.5, 11, 0, 4.5 + seg(k, 1.5, 3.5) * 5, 0, 38);
        c.shake(0.08 + seg(k, 0, 3) * 0.25, time);
        const hop = Math.max(0, Math.sin(time * 9)) * 0.35 * seg(k, 0.3, 1);
        pop.position.y = 1.15 + hop;
      } },
    { from: 19, to: 25, enter(c) { rex.group.visible = true; rex.group.position.set(-6, 0, -26); rex.group.rotation.y = 0.15; },
      tick(c, k, time) {
        const roar = k > 0.6 && k < 2.6 ? Math.sin(Math.min(1, (k - 0.6) / 0.4) * Math.PI / 2) : 0;
        if (k < 2.8) {
          rex.pose({ roar });
          c.look(3, 12.5, -7, -6, 11.5, -24, 50);
          c.shake(roar * 0.25, time);
          c.sub(roar > 0.1 ? K('n.rex') : null, roar > 0.1 ? K('s3') : null);
          dekel.group.visible = ofir.group.visible = pop.visible = false;
        } else {
          // the run: two friends in circles round the bench, the dino looking on, puzzled
          c.sub(null, null);
          dekel.group.visible = ofir.group.visible = true;
          for (const [a, ph] of [[dekel, 0], [ofir, Math.PI]]) {
            if (a.mode !== 'walk') a.setMode('walk');
            const ang = ph + (k - 2.8) * 2.2;
            a.group.position.set(Math.cos(ang) * 6, 0, Math.sin(ang) * 6 + 2);
            a.group.rotation.y = -ang;
            a.userSpeed = 12;
            a.express('surprised', 0.5);
          }
          rex.pose({ walk: (k - 2.8) * 3, tilt: Math.sin(k * 2) * 0.25 });
          rex.group.position.z = -26 + (k - 2.8) * 2;
          c.look(0, 10, 34, 0, 5, -6, 44);
        }
      } },
    { from: 25, to: 31, enter(c) { adir.group.visible = true; adir.setMode('scooter'); adir.group.rotation.y = Math.PI / 2; },
      tick(c, k) {
        const x = lerp(-40, 0, ease(Math.min(1, k / 1.6)));
        adir.group.position.set(x, 0, 9);
        adir.userSpeed = k < 1.6 ? 14 * (1 - k / 1.6) + 1 : 0;
        for (const a of [dekel, ofir]) { a.userSpeed = 0; if (a.mode !== 'idle') a.setMode('idle'); }
        dekel.group.position.set(-5, 0, 14); dekel.group.rotation.y = Math.PI; ofir.group.position.set(5, 0, 14); ofir.group.rotation.y = Math.PI;
        rex.group.position.z = -18;
        rex.pose({ tilt: k > 3.2 ? 0.35 : 0 });
        if (k < 2) c.look(-14, 3.5, 22, x, 3, 9, 40);
        else { c.look(22, 6, 12, -2, 5.5, -2, 48); adir.group.rotation.y = Math.PI; }
        adir.setTalking(k > 2 && k < 4.5);
        c.sub(k > 2 && k < 4.8 ? K('n.adir') : k >= 4.8 ? K('n.rex') : null, k > 2 && k < 4.8 ? K('s4') : k >= 4.8 ? K('s5') : null);
      } },
    { from: 31, to: 39, enter(c) {
        malul.group.visible = true; malul.setPlaying('drums'); malul.setMode('sit'); malul.group.position.set(-9, 0, 2); malul.group.rotation.y = 0.5;
        rex.group.position.set(0, 0, -8); rex.group.rotation.y = 0;
        dekel.group.position.set(-4, 0, 6); ofir.group.position.set(4, 0, 6); adir.group.position.set(0, 0, 8);
        c.music(M.groove, 120, 0.75, 'square');
      },
      tick(c, k, time) {
        c.sub(k < 2.2 ? K('n.malul') : null, k < 2.2 ? K('s6') : null);
        malul.setTalking(k < 2.2);
        rex.pose({ dance: k > 1.4 ? time : null });
        adir.setMode('idle');
        for (const [a, ph] of [[dekel, 0], [ofir, 1.3], [adir, 2.6]]) {
          a.group.position.y = k > 1.8 ? Math.abs(Math.sin(time * 4 + ph)) * 0.9 : 0;
          a.group.rotation.y = k > 1.8 ? Math.sin(time * 2 + ph) * 0.5 : Math.PI;
          if (k > 1.8) a.express('laugh', 0.4);
        }
        const orbit = -0.3 + k * 0.09;
        c.look(Math.sin(orbit) * 30, 8, 2 + Math.cos(orbit) * 30, -1, 6, -1, 44);
      } },
    { from: 39, to: 46, enter(c) { c.sub(null, null); scene.background = new THREE.Color(0x000000);
        c.card('title', [{ key: K('title'), size: 150, color: '#ffcb3d' }, { key: K('tag'), size: 52 }, { key: K('soon'), size: 44, color: '#9fd8cb' }, { key: K('rating'), size: 30, color: '#bbbbbb' }]); },
      tick(c) { c.look(0, 6, 30, 0, 6, 0); } },
  ];
  const cues = [
    [0.2, (c) => c.fx.whoosh(0.6)],
    [4.0, (c) => c.music(M.town, 132, 0.7)],
    [9.2, (c) => c.fx.talk(2.2, 'mid')], [12.2, (c) => c.fx.talk(2.2, 'high')],
    [15.0, (c) => { c.music(M.creep, 90, 0.9, 'sawtooth'); c.fx.thud(1); }], [16.0, (c) => c.fx.thud(1)], [17.0, (c) => c.fx.thud(1.2)], [18.0, (c) => c.fx.thud(1.4)],
    [19.6, (c) => { c.stopMusic(); c.fx.roar(1); }],
    [22.0, (c) => { c.fx.boing(0.6); c.gag(0.7); }],
    [25.2, (c) => c.fx.zip(0.8)],
    [27.0, (c) => c.fx.talk(2.3, 'low')], [29.8, (c) => { c.fx.boing(0.8); c.gag(1); }],
    [31.2, (c) => c.fx.talk(1.8, 'mid')],
    [33.0, (c) => c.gag(0.8)],
    [39.0, (c) => { c.stopMusic(); c.music(M.fanfare, 110, 0.8); }],
  ];
  // drum hits under the groove
  for (let b = 0; b < 15; b++) cues.push([31.2 + b * 0.5, (c) => (b % 2 ? c.fx.clack(0.7) : c.fx.thud(0.6))]);
  S.glow.set(0x9fd8ff);
  return runner(S, shots, cues, 46, hooks);
}

// ---- film 2: Rishon to space (Yes Planet) -----------------------------------------------------
async function spaceFilm(deps, t, hooks) {
  const S = await shell(deps, t);
  const { scene } = S;
  const K = (k) => `cinema.film.space.${k}`;
  // the launch site by the lake, at night
  const site = new THREE.Group();
  scene.add(site);
  const ground = mesh(new THREE.PlaneGeometry(600, 600), toon(0x2f4f3a), 0, 0, 0, site); ground.rotation.x = -Math.PI / 2;
  const lake = mesh(new THREE.CircleGeometry(40, 32), toon(0x2a5d8f), 30, 0.05, -40, site); lake.rotation.x = -Math.PI / 2;
  waterTower(-38, -30, site);
  const R = rnd(202640023);
  for (let i = 0; i < 10; i++) building(9 + R() * 8, 10 + R() * 20, 9, [0x4a5a7a, 0x5a4a6a, 0x3f5f6f][i % 3], -120 + i * 13, -70 - R() * 10, site);
  for (let i = 0; i < 5; i++) palm(-34 + i * 17, -14, 8, site);
  const wheel = new THREE.Group();
  wheel.position.set(70, 22, -70);
  site.add(wheel);
  const rim = mesh(new THREE.TorusGeometry(18, 0.5, 8, 40), basic(0xffcb3d), 0, 0, 0, wheel);
  for (let i = 0; i < 12; i++) { const sp = box(0.3, 36, 0.3, 0xffcb3d, 0, -18, 0, wheel); sp.rotation.z = (i / 12) * Math.PI; sp.material = basic(0xff8a3d); }
  void rim;
  const pad = cyl(7, 7, 1, 0x666677, 0, 0, 0, site, 24);
  void pad;
  const rk = rocket();
  rk.group.position.set(0, 1, 0);
  scene.add(rk.group);
  const nightStars = stars(500, 700, 7);
  scene.add(nightStars);
  const smoke = [];
  for (let i = 0; i < 18; i++) { const s = ball(2.2, 0xd8d8e0, 0, 0, 0, scene); s.visible = false; smoke.push(s); }
  // space
  // space shares the origin with the launch site; only one of the two is ever visible
  const space = new THREE.Group();
  space.visible = false;
  scene.add(space);
  space.add(stars(1200, 900, 99));
  const earth = ball(26, 0x2e86de, -40, -60, -120, space);
  for (let i = 0; i < 7; i++) { const l = ball(8 + (i % 3) * 3, 0x4caf50, 0, 0, 0, earth); l.position.setFromSphericalCoords(24, 0.5 + i * 0.35, i * 1.7); l.scale.setScalar(0.6); }
  const planet = ball(14, 0xff9f43, 70, 20, -150, space);
  const ring = mesh(new THREE.RingGeometry(18, 26, 48), new THREE.MeshToonMaterial({ color: 0xffe0a8, side: THREE.DoubleSide }), 0, 0, 0, planet);
  ring.rotation.x = 1.2;
  const moon = ball(5, 0xd9d9d9, 30, -10, -60, space);
  const saucer = ufo();
  space.add(saucer.group);
  const visitor = alien();
  space.add(visitor.group);
  const snack = pita();
  space.add(snack);

  const crew = ['dekel', 'ofir', 'adir', 'malul'].map((id) => S.actor(id));
  crew.forEach((a) => helmet(a));
  const [dekel, ofir, adir, malul] = crew;

  const atPad = () => {
    space.visible = false; site.visible = true; nightStars.visible = true; rk.group.visible = true;
    crew.forEach((a, i) => { a.group.visible = true; a.setMode('idle'); a.group.position.set(-6 + i * 4, 0, 12); a.group.rotation.set(0, Math.PI, 0); scene.add(a.group); });
  };
  const inSpace = () => {
    site.visible = false; nightStars.visible = false; space.visible = true; rk.group.visible = false;
    for (const s of smoke) s.visible = false;
    crew.forEach((a) => { space.add(a.group); a.setMode('idle'); a.group.visible = true; });
  };

  const shots = [
    { from: 0, to: 4, enter(c) { atPad(); site.visible = false; nightStars.visible = false; rk.group.visible = false; crew.forEach((a) => { a.group.visible = false; });
        scene.background = new THREE.Color(0x000000); c.card('ident', [{ key: K('ident1'), size: 64, color: '#ee6a1f' }, { key: K('ident2'), size: 110 }]); c.sub(null, null); },
      tick(c) { c.look(0, 6, 30, 0, 6, 0); } },
    { from: 4, to: 10, enter(c) { c.card(null); atPad(); scene.background = new THREE.Color(0x0b1638); S.hemi.intensity = 0.7; },
      tick(c, k) {
        c.look(-4 + k * 1.2, 6, 34 - k, 0, 7, 0, 44);
        ofir.setTalking(k > 0.5 && k < 2.8);
        c.sub(k > 0.4 && k < 3 ? K('n.ofir') : null, k > 0.4 && k < 3 ? K('s1') : null);
        const n = k < 3.2 ? null : String(3 - Math.min(2, Math.floor((k - 3.2) / 0.9)));
        c.card(n ? 'n' + n : null, n ? [{ text: n, size: 300, color: '#ffcb3d' }] : null, 'rgba(0,0,0,0)');
      } },
    { from: 10, to: 16, enter(c) { c.card(null); crew.forEach((a) => { a.group.visible = false; }); rk.flame.visible = true; },
      tick(c, k, time) {
        const lift = Math.pow(Math.max(0, k - 0.6), 2) * 6;
        rk.group.position.y = 1 + lift;
        rk.flame.scale.set(1 + Math.sin(time * 40) * 0.12, 1 + Math.sin(time * 33) * 0.2 + Math.min(1, k) * 0.6, 1);
        smoke.forEach((s, i) => {
          const a = (i / smoke.length) * TAU, r = 2 + Math.min(k, 3) * (4 + (i % 3) * 2);
          s.visible = true; s.position.set(Math.cos(a) * r, 1.5 + (i % 4) * 0.8, Math.sin(a) * r); s.scale.setScalar(0.6 + Math.min(k, 3) * 0.5);
        });
        c.look(0, 4, 60, 0, Math.max(10, rk.group.position.y * 0.85), 0, 48);
        c.shake(0.3 * Math.min(1, k), time);
        c.sub(k > 2 ? K('n.dekel') : null, k > 2 ? K('s2') : null);
      } },
    { from: 16, to: 24, enter(c) { inSpace(); scene.background = new THREE.Color(0x02030a); S.hemi.intensity = 1.1;
        crew.forEach((a, i) => a.group.position.set(-7 + i * 4.6, 0, 0)); saucer.group.visible = false; visitor.group.visible = false; snack.visible = false; },
      tick(c, k, time) {
        crew.forEach((a, i) => {
          a.group.position.y = Math.sin(time * 0.9 + i) * 1.2;
          a.group.rotation.set(Math.sin(time * 0.5 + i) * 0.3, Math.PI + Math.sin(time * 0.3 + i * 2) * 0.6, Math.sin(time * 0.7 + i) * 0.25);
        });
        planet.rotation.y += 0.002; earth.rotation.y += 0.001; void moon;
        c.look(Math.sin(k * 0.15) * 6, 3, 22 - k * 0.4, 0, 1, 0, 46);
        adir.setTalking(k > 3 && k < 5.5);
        c.sub(k > 3 && k < 6 ? K('n.adir') : null, k > 3 && k < 6 ? K('s3') : null);
      } },
    { from: 24, to: 32, enter() { saucer.group.visible = true; visitor.group.visible = true; },
      tick(c, k, time) {
        const arrive = ease(Math.min(1, k / 2));
        saucer.group.position.set(lerp(60, 14, arrive), 10 + Math.sin(time * 2) * 0.6, -14);
        saucer.lights.forEach((l, i) => l.material.color.setHex((Math.floor(time * 6) + i) % 3 === 0 ? 0xff6f59 : 0xffcb3d));
        visitor.group.position.set(saucer.group.position.x - 4, saucer.group.position.y - 6 + Math.sin(time * 1.6) * 0.4, -10);
        visitor.group.rotation.y = -0.6;
        crew.forEach((a, i) => { a.group.position.y = Math.sin(time * 0.9 + i) * 1.0; a.group.rotation.set(0, Math.PI * 0.75, 0); });
        const offer = k > 4.2;
        snack.visible = k > 3.2 && k < 6.4;
        if (snack.visible) {
          const from = malul.group.position.clone().add(new THREE.Vector3(0.8, 3, 0.8));
          const to = visitor.group.position.clone().add(new THREE.Vector3(0.5, 3.4, 1.4));
          snack.position.lerpVectors(from, to, seg(k, 3.6, 5.2));
          snack.rotation.y = time * 2;
        }
        const happy = k > 5.6;
        visitor.tips.forEach((tp) => tp.material.color.setHex(happy && Math.floor(time * 8) % 2 ? 0xffef5a : 0xff6f59));
        visitor.arms.forEach((a, i) => { a.rotation.z = happy ? Math.sin(time * 10 + i * Math.PI) * 0.9 : (i ? -0.2 : 0.2); });
        c.look(-10, 4, 18, 4, 2, -8, 46);
        const line = k < 2.4 ? null : k < 4.2 ? ['n.alien', 's4'] : !offer ? null : k < 5.6 ? ['n.malul', 's5'] : ['n.alien', 's6'];
        malul.setTalking(!!line && line[0] === 'n.malul');
        c.sub(line ? K(line[0]) : null, line ? K(line[1]) : null);
      } },
    { from: 32, to: 39, enter(c) { snack.visible = false; c.music(M.groove, 126, 0.75, 'square'); },
      tick(c, k, time) {
        crew.forEach((a, i) => {
          a.group.position.y = Math.abs(Math.sin(time * 4.2 + i)) * 1.6;
          a.group.rotation.set(0, Math.PI + Math.sin(time * 2 + i) * 0.7, Math.sin(time * 4.2 + i) * 0.2);
          a.express('laugh', 0.4);
        });
        visitor.group.position.y = saucer.group.position.y - 6 + Math.abs(Math.sin(time * 4.2)) * 1.6;
        visitor.group.rotation.y = Math.sin(time * 3) * 0.8;
        visitor.arms.forEach((a, i) => { a.rotation.z = Math.sin(time * 8 + i * Math.PI) * 1.1; });
        planet.position.y = 20 + Math.abs(Math.sin(time * 4.2)) * 3;
        const orbit = k * 0.25;
        c.look(4 + Math.sin(orbit) * 30, 7, -4 + Math.cos(orbit) * 30, 4, 2, -5, 50);
        c.sub(k < 2.4 ? K('n.dekel') : null, k < 2.4 ? K('s7') : null);
      } },
    { from: 39, to: 46, enter(c) { c.sub(null, null); scene.background = new THREE.Color(0x000000); space.visible = false;
        c.card('title', [{ key: K('title'), size: 150, color: '#ee6a1f' }, { key: K('tag'), size: 52 }, { key: K('soon'), size: 44, color: '#9fd8cb' }, { key: K('rating'), size: 30, color: '#bbbbbb' }]); },
      tick(c) { c.look(0, 6, 30, 0, 6, 0); } },
  ];
  const cues = [
    [0.2, (c) => c.fx.whoosh(0.6)],
    [4.0, (c) => c.music(M.launch, 100, 0.7)],
    [4.6, (c) => c.fx.talk(2.2, 'high')],
    [7.2, (c) => c.fx.ding(0.6)], [8.1, (c) => c.fx.ding(0.6)], [9.0, (c) => c.fx.ding(0.6)],
    [10.0, (c) => { c.stopMusic(); c.fx.whoosh(1); c.fx.roar(0.35); }], [11.5, (c) => c.fx.whoosh(1)],
    [12.2, (c) => { c.fx.talk(2.0, 'high'); c.gag(0.8); }],
    [16.0, (c) => c.music(M.float, 70, 0.6)],
    [19.2, (c) => c.fx.talk(2.2, 'low')], [21.6, (c) => c.gag(0.7)],
    [24.2, (c) => c.fx.zip(0.9)], [26.6, (c) => c.fx.boing(0.9)], [28.3, (c) => c.fx.talk(1.2, 'mid')],
    [29.8, (c) => { c.fx.crunch(1); }], [30.2, (c) => { c.fx.boing(1); c.fx.cheer(1, 0.4); c.gag(1); }],
    [34.0, (c) => c.gag(0.8)],
    [39.0, (c) => { c.stopMusic(); c.music(M.fanfare, 110, 0.8); }],
  ];
  for (let b = 0; b < 14; b++) cues.push([32.2 + b * 0.476, (c) => (b % 2 ? c.fx.clack(0.7) : c.fx.thud(0.6))]);
  S.glow.set(0x6f7bff);
  return runner(S, shots, cues, 46, hooks);
}

export const FILMS = { dino: dinoFilm, space: spaceFilm };
export async function createFilm(kind, deps, t, hooks = {}) {
  const make = FILMS[kind] || dinoFilm;
  return make(deps, t, hooks);
}
