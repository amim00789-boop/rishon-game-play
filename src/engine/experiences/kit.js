// Props and UI pieces shared by the experiences: toon primitives, instanced seat rows and cheap
// background audiences, canvas text planes (text comes from t(), never from source), curtains,
// light beams, confetti, food, and speech bubbles that follow an actor on screen.
import * as THREE from 'three';
import { addStyle, rich } from '../minigames/common.js';
import { dir as i18nDir } from '../../i18n.js';

const matCache = new Map();
export function toon(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshToonMaterial({ color, ...opts }); m.userData.shared = true; matCache.set(key, m); }
  return m;
}
export function basic(color, opts = {}) { return new THREE.MeshBasicMaterial({ color, ...opts }); }

export function mesh(geo, mat, x = 0, y = 0, z = 0, parent = null) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (parent) parent.add(m);
  return m;
}
export const box = (w, h, d, color, x = 0, y = 0, z = 0, parent = null) => mesh(new THREE.BoxGeometry(w, h, d), toon(color), x, y + h / 2, z, parent);
export const cyl = (rt, rb, h, color, x = 0, y = 0, z = 0, parent = null, seg = 16) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), toon(color), x, y + h / 2, z, parent);
export const ball = (r, color, x = 0, y = 0, z = 0, parent = null) => mesh(new THREE.SphereGeometry(r, 16, 12), toon(color), x, y, z, parent);
// A rounded box (toon look: fewer hard corners).
export function rbox(w, h, d, r, color, x = 0, y = 0, z = 0, parent = null) {
  const s = new THREE.Shape();
  const hw = w / 2 - r, hh = h / 2 - r;
  s.moveTo(-hw, -h / 2); s.lineTo(hw, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -hh);
  s.lineTo(w / 2, hh); s.quadraticCurveTo(w / 2, h / 2, hw, h / 2); s.lineTo(-hw, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, hh); s.lineTo(-w / 2, -hh); s.quadraticCurveTo(-w / 2, -h / 2, -hw, -h / 2);
  const g = new THREE.ExtrudeGeometry(s, { depth: d - r * 2, bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.6, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, h / 2, -(d - r * 2) / 2);
  return mesh(g, toon(color), x, y, z, parent);
}

// ---- text -----------------------------------------------------------------------------------
// A plane with text drawn on a canvas. lines: [{ text, size (px), color, weight }], or strings.
export function textCanvas(lines, { w = 1024, h = 512, bg = null, fg = '#ffffff', stroke = null, align = 'center', font = 'Rubik, "Trebuchet MS", system-ui, sans-serif', gap = 1.25, top = null } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.direction = i18nDir();
  g.textAlign = align; g.textBaseline = 'middle';
  const L = lines.map((l) => (typeof l === 'string' ? { text: l } : l));
  const heights = L.map((l) => (l.size || 64) * gap);
  const total = heights.reduce((a, b) => a + b, 0);
  let y = top != null ? top : (h - total) / 2;
  L.forEach((l, i) => {
    const size = l.size || 64;
    g.font = `${l.weight || 900} ${size}px ${font}`;
    const yy = y + heights[i] / 2;
    const x = align === 'center' ? w / 2 : align === 'right' ? w - 40 : 40;
    if (l.text) {
      let txt = String(l.text);
      while (g.measureText(txt).width > w - 60 && size > 12) { g.font = `${l.weight || 900} ${Math.floor(size * 0.92)}px ${font}`; break; }
      if (stroke || l.stroke) { g.lineWidth = Math.max(4, size / 9); g.strokeStyle = l.stroke || stroke; g.lineJoin = 'round'; g.strokeText(txt, x, yy); }
      g.fillStyle = l.color || fg;
      g.fillText(txt, x, yy);
    }
    y += heights[i];
  });
  return c;
}
export function textPlane(lines, width, height, opts = {}) {
  const c = textCanvas(lines, opts);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tex, transparent: !opts.bg, depthWrite: !!opts.bg, toneMapped: false }));
  return m;
}

// ---- seating and audiences ------------------------------------------------------------------
// Rows of theatre seats facing -z (towards the screen). Returns { group, seats: [{x, y, z}] }.
export function seatRows({ rows = 8, cols = 14, pitch = 2.3, width = 1.7, rise = 0.55, color = 0xb3263a, z0 = 0, aisle = 2, seatH = 1.25 } = {}) {
  const group = new THREE.Group();
  const n = rows * cols;
  const seatG = new THREE.BoxGeometry(width * 0.86, 0.35, 1.0);
  const backG = new THREE.BoxGeometry(width * 0.86, 1.7, 0.3);
  const armG = new THREE.BoxGeometry(0.16, 0.7, 1.0);
  const stepG = new THREE.BoxGeometry(1, 1, 1);
  const seat = new THREE.InstancedMesh(seatG, toon(color), n);
  const back = new THREE.InstancedMesh(backG, toon(color), n);
  const arm = new THREE.InstancedMesh(armG, toon(0x2a2a33), n + rows);
  const step = new THREE.InstancedMesh(stepG, toon(0x3a2f45), rows);
  const m4 = new THREE.Matrix4(), seats = [];
  let i = 0, a = 0;
  const half = (cols * width + aisle) / 2;
  for (let r = 0; r < rows; r++) {
    const y = r * rise, z = z0 + r * pitch;
    m4.compose(new THREE.Vector3(0, y / 2 - 0.01, z + 0.3), new THREE.Quaternion(), new THREE.Vector3(half * 2 + 4, Math.max(0.02, y), pitch));
    step.setMatrixAt(r, m4);
    for (let c = 0; c < cols; c++) {
      const x = -half + width / 2 + c * width + (c >= cols / 2 ? aisle : 0);
      m4.makeTranslation(x, y + seatH - 0.15, z); seat.setMatrixAt(i, m4);
      m4.makeTranslation(x, y + seatH + 0.75, z + 0.55); back.setMatrixAt(i, m4);
      m4.makeTranslation(x - width / 2, y + seatH + 0.15, z); arm.setMatrixAt(a++, m4);
      if (c === cols - 1 || c === cols / 2 - 1) { m4.makeTranslation(x + width / 2, y + seatH + 0.15, z); arm.setMatrixAt(a++, m4); }
      seats.push({ x, y: y + seatH, z, row: r, col: c });
      i++;
    }
  }
  arm.count = a;
  group.add(step, seat, back, arm);
  return { group, seats };
}

// Cheap people for the far rows / stands: a body and a head per instance, seated or standing.
const SKIN = [0xf1c7a5, 0xd39a6e, 0xa86b45, 0xe8b48f, 0x7a4a2e];
const SHIRT = [0xff6f59, 0x2ec4b6, 0xffcb3d, 0x3f8efc, 0xb36bd6, 0x7fe0d6, 0xf4f4f4, 0x23324a, 0xe8364f];
const HAIR = [0x1a1210, 0x3b2a1d, 0x8a5a2b, 0xd9c08a, 0x777777, 0x141414];
export function blobCrowd(points, { seated = true, seed = 1 } = {}) {
  let s = seed >>> 0;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const n = points.length;
  const body = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.62, seated ? 0.9 : 1.9, 3, 8), toon(0xffffff), n);
  const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.55, 12, 10), toon(0xffffff), n);
  const hair = new THREE.InstancedMesh(new THREE.SphereGeometry(0.58, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), toon(0xffffff), n);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  const base = [];
  points.forEach((p, i) => {
    const sc = 0.9 + r() * 0.2;
    const by = p.y + (seated ? 0.95 : 1.6) * sc;
    base.push({ x: p.x, y: p.y, z: p.z, sc, by, ph: r() * 6.28 });
    m4.makeScale(sc, sc, sc).setPosition(p.x, by, p.z); body.setMatrixAt(i, m4);
    m4.makeScale(sc, sc, sc).setPosition(p.x, by + (seated ? 1.25 : 1.75) * sc, p.z); head.setMatrixAt(i, m4); hair.setMatrixAt(i, m4.clone().setPosition(p.x, by + (seated ? 1.33 : 1.83) * sc, p.z));
    body.setColorAt(i, col.setHex(SHIRT[Math.floor(r() * SHIRT.length)]));
    head.setColorAt(i, col.setHex(SKIN[Math.floor(r() * SKIN.length)]));
    hair.setColorAt(i, col.setHex(HAIR[Math.floor(r() * HAIR.length)]));
  });
  const group = new THREE.Group();
  group.add(body, head, hair);
  // bounce(k): everyone hops/bobs by k (0..1); call while laughing or cheering.
  let t = 0;
  function bounce(dt, k, rate = 7) {
    t += dt;
    base.forEach((b, i) => {
      const h = k > 0 ? Math.max(0, Math.sin(t * rate + b.ph)) * 0.35 * k : 0;
      m4.makeScale(b.sc, b.sc, b.sc).setPosition(b.x, b.by + h, b.z); body.setMatrixAt(i, m4);
      m4.setPosition(b.x, b.by + h + (seated ? 1.25 : 1.75) * b.sc, b.z); head.setMatrixAt(i, m4);
      m4.setPosition(b.x, b.by + h + (seated ? 1.33 : 1.83) * b.sc, b.z); hair.setMatrixAt(i, m4);
    });
    body.instanceMatrix.needsUpdate = head.instanceMatrix.needsUpdate = hair.instanceMatrix.needsUpdate = true;
  }
  return { group, bounce };
}

// A pleated stage curtain (one half). open(k) 0 closed .. 1 gathered to the side.
export function curtainHalf(width, height, color, side) {
  const geo = new THREE.PlaneGeometry(width, height, 40, 1);
  const pos = geo.attributes.position;
  const x0 = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) x0[i] = pos.getX(i);
  const m = new THREE.Mesh(geo, new THREE.MeshToonMaterial({ color, side: THREE.DoubleSide }));
  m.position.y = height / 2;
  const hw = width / 2;
  function open(k) {
    for (let i = 0; i < pos.count; i++) {
      const u = (x0[i] + hw) / width; // 0..1 across the half
      const fromEdge = side < 0 ? u : 1 - u; // 1 at the outer edge
      const gathered = 1 - (1 - fromEdge) * (1 - k * 0.85);
      const x = side < 0 ? -hw + gathered * width : hw - gathered * width;
      pos.setX(i, x);
      pos.setZ(i, Math.sin(u * 40) * (0.25 + k * 0.35));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  open(0);
  return { mesh: m, open };
}

// A soft additive light beam (stage spot / projector), apex at the origin pointing down -y.
export function beam(color = 0xfff2c0, length = 20, radius = 4, opacity = 0.18) {
  const g = new THREE.ConeGeometry(radius, length, 24, 1, true);
  g.translate(0, -length / 2, 0);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  m.renderOrder = 4;
  return m;
}

// Confetti burst: call update(dt); finished when done.
export function confetti(n = 160, at = new THREE.Vector3(), spread = 10) {
  const geo = new THREE.PlaneGeometry(0.35, 0.22);
  const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), n);
  const parts = [], col = new THREE.Color(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const C = [0xff6f59, 0xffcb3d, 0x2ec4b6, 0xb36bd6, 0x3f8efc, 0xffffff];
  for (let i = 0; i < n; i++) {
    parts.push({ p: new THREE.Vector3(at.x + (Math.random() - 0.5) * spread, at.y + Math.random() * 4, at.z + (Math.random() - 0.5) * spread),
      v: new THREE.Vector3((Math.random() - 0.5) * 6, 6 + Math.random() * 8, (Math.random() - 0.5) * 6), r: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6) });
    im.setColorAt(i, col.setHex(C[i % C.length]));
  }
  let t = 0;
  return {
    mesh: im,
    update(dt) {
      t += dt;
      parts.forEach((pt, i) => {
        pt.v.y = Math.max(pt.v.y - 9 * dt, -2.2);
        pt.v.x *= 0.99; pt.v.z *= 0.99;
        pt.p.addScaledVector(pt.v, dt);
        e.set(pt.r.x * t, pt.r.y * t, pt.r.z * t); q.setFromEuler(e);
        m4.compose(pt.p, q, new THREE.Vector3(1, 1, 1)); im.setMatrixAt(i, m4);
      });
      im.instanceMatrix.needsUpdate = true;
      return t > 6;
    },
  };
}

// ---- food -----------------------------------------------------------------------------------
// A sandwich in `segments` pieces along x; bite(i) hides piece i (from the right end).
export function sandwich(kind = 'baguette', segments = 5) {
  const g = new THREE.Group();
  const pieces = [];
  const len = 1.5, seg = len / segments;
  const bread = kind === 'pita' ? 0xe8c184 : kind === 'toast' ? 0xd9a35c : 0xd8a35a;
  const fill = { sabich: [0x6b3fa0, 0xfff1c9, 0x4caf50], schnitzel: [0xd99a3a, 0x4caf50, 0xe8364f], tuna: [0xd8c7a0, 0x4caf50, 0xffcb3d], toast: [0xffe08a, 0x2e7d32, 0x6b3fa0] }[kind] || [0xe8364f, 0x4caf50, 0xffe08a];
  for (let i = 0; i < segments; i++) {
    const p = new THREE.Group();
    const x = -len / 2 + seg * (i + 0.5);
    const top = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, seg * 0.9, 3, 8), toon(bread));
    top.rotation.z = Math.PI / 2; top.position.set(x, 0.24, 0); top.scale.set(1, 1, 1.25);
    const bot = top.clone(); bot.position.y = 0.06; bot.scale.set(0.9, 1, 1.2);
    p.add(top, bot);
    fill.forEach((c, k) => { const f = new THREE.Mesh(new THREE.BoxGeometry(seg * 0.98, 0.05, 0.42 - k * 0.04), toon(c)); f.position.set(x, 0.13 + k * 0.035, 0); p.add(f); });
    g.add(p);
    pieces.push(p);
  }
  return { group: g, pieces, bite(i) { if (pieces[i]) pieces[i].visible = false; }, left: () => pieces.filter((p) => p.visible).length };
}
export function plate() {
  const g = new THREE.Group();
  const p = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.8, 0.1, 24), toon(0xffffff));
  p.position.y = 0.05; g.add(p);
  return g;
}
export function glass(liquid = 0xffcb3d, h = 0.8) {
  const g = new THREE.Group();
  const l = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.19, h * 0.8, 14), toon(liquid));
  l.position.y = h * 0.4;
  const gl = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.21, h, 14, 1, true), new THREE.MeshToonMaterial({ color: 0xdff6ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  gl.position.y = h / 2;
  g.add(l, gl);
  g.userData.liquid = l;
  return g;
}
export function popcornBucket() {
  const g = new THREE.Group();
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.38, 1.0, 16), toon(0xffffff));
  cup.position.y = 0.5; g.add(cup);
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.559, 0.389, 1.0, 16, 1, true, i * Math.PI / 2, Math.PI / 4), toon(0xe8364f));
    s.position.y = 0.5; g.add(s);
  }
  const kernels = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.13, 0), toon(0xfff1b5), 30);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 30; i++) { const a = i * 2.4, r = 0.42 * Math.sqrt((i + 0.5) / 30); m4.makeTranslation(Math.cos(a) * r, 1.02 + Math.random() * 0.18, Math.sin(a) * r); kernels.setMatrixAt(i, m4); }
  g.add(kernels);
  return g;
}

// ---- speech bubbles -------------------------------------------------------------------------
addStyle('exp-style-kit', `
.exp-bubble { position: absolute; transform: translate(-50%, -100%); background: #fffdf6; border: 2px solid #23324a; border-radius: 14px;
  padding: 5px 11px; font-weight: 800; font-size: 15px; max-width: min(320px, 70vw); text-align: center; box-shadow: 0 3px 0 rgba(35,50,74,0.35);
  pointer-events: none; transition: opacity 0.25s; white-space: normal; }
.exp-bubble::after { content: ''; position: absolute; left: 50%; bottom: -9px; margin-left: -7px; border: 7px solid transparent; border-top-color: #23324a; border-bottom: 0; }
.exp-bubble b { display: block; font-size: 11px; font-weight: 900; opacity: 0.7; }
.exp-subs { position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); width: min(760px, calc(100vw - 32px)); text-align: center;
  color: #fff; font-weight: 800; font-size: clamp(16px, 2.4vw, 24px); text-shadow: 0 0 4px #000, 0 2px 0 #000, 0 0 10px #000; pointer-events: none; line-height: 1.3; }
.exp-subs i { font-style: normal; color: #ffe27a; }
.exp-hint { left: 50%; bottom: 18px; transform: translateX(-50%); font-weight: 800; font-size: 14px; white-space: nowrap; max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis; }
.exp-top { left: 50%; top: 12px; transform: translateX(-50%); text-align: center; min-width: 220px; max-width: calc(100vw - 32px); }
`);

export function bubbles(root, venue) {
  const list = [];
  return {
    // who: avatar or Object3D (bubble above its head) or a () => Vector3; name: optional label.
    say(who, text, secs = 2.2, name = null, height = 6) {
      const el = document.createElement('div');
      el.className = 'exp-bubble';
      el.innerHTML = (name ? `<b>${rich(name)}</b>` : '') + rich(text);
      el.dir = i18nDir();
      root.appendChild(el);
      const b = { el, who, t: secs, height };
      list.push(b);
      this.update(0);
      return b;
    },
    update(dt) {
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        b.t -= dt;
        if (b.t <= 0) { b.el.remove(); list.splice(i, 1); continue; }
        const p = typeof b.who === 'function' ? b.who() : (b.who.group || b.who).getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, b.height, 0));
        const s = venue.project(p);
        b.el.style.left = Math.max(80, Math.min(innerWidth - 80, s.x)) + 'px';
        b.el.style.top = Math.max(60, s.y) + 'px';
        b.el.style.opacity = s.on ? (b.t < 0.25 ? b.t / 0.25 : 1) : 0;
      }
    },
    clear() { for (const b of list) b.el.remove(); list.length = 0; },
  };
}

// Ease helpers for the scripted scenes.
export const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
export const seg = (t, a, b) => ease((t - a) / (b - a));
export const lerp = (a, b, k) => a + (b - a) * k;
