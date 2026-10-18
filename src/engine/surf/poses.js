// Surf poses for any characters/avatar.js avatar, applied on top of the avatar's own update
// (call av.update first, then applySurfPose): prone paddling, sitting astride the board, the
// pop-up, a crouched side-on stance with carve lean, an air tuck and a soft tumble.
// Nothing in src/characters is edited: the poses write the avatar's exposed joints directly,
// with a small two-bone IK solver that mirrors the avatar's own (body units, +z forward).
import * as THREE from 'three';
import { BOARD } from './board.js';

const JN = ['pelvis', 'waist', 'neck', 'shL', 'elL', 'wrL', 'shR', 'elR', 'wrR', 'hipL', 'knL', 'anL', 'hipR', 'knR', 'anR'];
const IX = Object.fromEntries(JN.map((n, i) => [n, i]));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// pose = { j: Float32Array(45) joint eulers, pel: [x, y, z] body units,
//          root: [x, y, z, rx, ry, rz] the avatar group relative to the board (world units, YXZ) }
export function newPose() {
  return { j: new Float32Array(45), pel: new Float32Array([0, 2.3, 0]), root: new Float32Array(6) };
}
export function copyPose(out, a) { out.j.set(a.j); out.pel.set(a.pel); out.root.set(a.root); return out; }
export function blendPose(out, a, b, t) {
  for (let i = 0; i < 45; i++) out.j[i] = a.j[i] + (b.j[i] - a.j[i]) * t;
  for (let i = 0; i < 3; i++) out.pel[i] = a.pel[i] + (b.pel[i] - a.pel[i]) * t;
  for (let i = 0; i < 6; i++) out.root[i] = a.root[i] + (b.root[i] - a.root[i]) * t;
  return out;
}
const R = (p, name, x, y, z) => { const i = IX[name] * 3; p.j[i] = x; p.j[i + 1] = y; p.j[i + 2] = z; };

// Body dimensions read off the avatar's joints (body units) and its body scale.
export function avatarDims(av) {
  const J = av.joints;
  return {
    legX: J.hipL.position.x, ul: -J.knL.position.y, ll: -J.anL.position.y, ankleH: 0.4,
    shX: J.shL.position.x, shY: 1.5, ua: -J.elL.position.y, la: -J.wrL.position.y,
    waistY: J.waist.position.y, hipY: 2.3,
    scale: J.pelvis.parent ? J.pelvis.parent.scale.x : 0.7,
  };
}

// ---- IK (same conventions as the avatar's own solver) ----------------------------------------
function solveLimb(dx, dy, dz, L1, L2, bendSign) {
  const d = Math.hypot(dx, dy, dz);
  const dd = clamp(d, 0.1, (L1 + L2) * 0.999);
  const splay = Math.asin(clamp(dx / Math.max(d, 1e-4), -1, 1));
  const theta = Math.atan2(-dz, -dy);
  const a = Math.acos(clamp((L1 * L1 + dd * dd - L2 * L2) / (2 * L1 * dd), -1, 1));
  const k = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - dd * dd) / (2 * L1 * L2), -1, 1));
  return bendSign > 0 ? [theta - a, splay, k] : [theta + a, splay, -k];
}
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _t = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
function pelvisM(p, out) {
  const i = IX.pelvis * 3;
  _e.set(p.j[i], p.j[i + 1], p.j[i + 2], 'XYZ');
  return out.compose(_v.set(p.pel[0], p.pel[1], p.pel[2]), _q.setFromEuler(_e), _one);
}
function legIK(p, d, side, tx, ty, tz, footPitch = 0) {
  pelvisM(p, _m).invert();
  _t.set(tx, ty, tz).applyMatrix4(_m);
  const [pitch, splay, bend] = solveLimb(_t.x - side * d.legX, _t.y, _t.z, d.ul, d.ll, 1);
  const h = side > 0 ? 'hipL' : 'hipR';
  R(p, h, pitch, 0, splay);
  R(p, side > 0 ? 'knL' : 'knR', bend, 0, 0);
  R(p, side > 0 ? 'anL' : 'anR', footPitch - (pitch + bend + p.j[0]), 0, -splay * 0.8);
}
function armIK(p, d, side, tx, ty, tz) {
  pelvisM(p, _m);
  const i = IX.waist * 3;
  _e.set(p.j[i], p.j[i + 1], p.j[i + 2], 'XYZ');
  _m2.compose(_v.set(0, d.waistY, 0), _q.setFromEuler(_e), _one);
  _m.multiply(_m2).invert();
  _t.set(tx, ty, tz).applyMatrix4(_m);
  const [pitch, splay, bend] = solveLimb(_t.x - side * d.shX, _t.y - d.shY, _t.z, d.ua, d.la, -1);
  R(p, side > 0 ? 'shL' : 'shR', pitch, 0, splay);
  R(p, side > 0 ? 'elL' : 'elR', bend, 0, 0);
  R(p, side > 0 ? 'wrL' : 'wrR', 0, 0, 0);
}

// ---- poses ---------------------------------------------------------------------------------
// Lying on the board, head to the nose, arms windmilling. stroke: paddle phase (radians),
// power 0..1 (0 = resting, arms trailing).
export function pronePose(p, d, t, stroke, power = 1) {
  p.j.fill(0);
  p.pel.set([0, d.hipY, 0]);
  // the body extends along +z once pitched forward; chest on the deck
  p.root.set([0, BOARD.DECK + 0.42 * d.scale / 0.7, -BOARD.length * 0.42, Math.PI / 2, 0, 0]);
  R(p, 'waist', -0.28 - 0.05 * power, 0, 0);
  R(p, 'neck', -0.75, 0.08 * Math.sin(t * 0.7), 0);
  for (const side of [1, -1]) {
    const ph = ((stroke + (side > 0 ? 0 : Math.PI)) / (Math.PI * 2)) % 1;
    const sh = side > 0 ? 'shL' : 'shR', el = side > 0 ? 'elL' : 'elR';
    if (power < 0.05) { R(p, sh, -0.35, 0, side * 0.35); R(p, el, -0.3, 0, 0); continue; }
    if (ph < 0.55) {
      // pull: from reaching past the nose, down through the water, back to the hip
      const k = ph / 0.55;
      R(p, sh, lerp(-2.85, -0.25, k), 0, side * (0.22 + 0.1 * Math.sin(k * Math.PI)));
      R(p, el, -0.25 - 0.35 * Math.sin(k * Math.PI), 0, 0);
    } else {
      // recovery: elbow up, the arm swings forward over the water
      const k = (ph - 0.55) / 0.45;
      R(p, sh, lerp(-0.25, Math.PI * 2 - 2.85, k), 0, side * (0.22 + 0.55 * Math.sin(k * Math.PI)));
      R(p, el, -0.3 - 1.2 * Math.sin(k * Math.PI), 0, 0);
    }
  }
  const kick = Math.sin(t * 5) * 0.12 * power;
  R(p, 'hipL', 0.05 + kick, 0, 0.09); R(p, 'knL', 0.35 + kick, 0, 0); R(p, 'anL', 1.15, 0, 0);
  R(p, 'hipR', 0.05 - kick, 0, -0.09); R(p, 'knR', 0.35 - kick, 0, 0); R(p, 'anR', 1.15, 0, 0);
  return p;
}

// Sitting astride, legs dangling in the water, hands on the deck. look: head yaw.
// cheer 0..1 raises the left arm in a wave.
export function sitPose(p, d, t, look = 0, cheer = 0) {
  p.j.fill(0);
  p.pel.set([0, d.hipY, 0]);
  const seat = d.hipY - 0.32; // pelvis bottom in body units
  p.root.set([0, BOARD.DECK - seat * d.scale, -0.5, 0, 0, 0]);
  R(p, 'pelvis', -0.12, 0, 0);
  R(p, 'waist', 0.16, 0.05 * Math.sin(t * 0.4), 0.03 * Math.sin(t * 0.9));
  R(p, 'neck', -0.05, look, 0);
  const swing = Math.sin(t * 1.6) * 0.18;
  R(p, 'hipL', -1.05, 0, 0.62); R(p, 'knL', 1.25 + swing, 0, 0); R(p, 'anL', 0.5, 0, 0);
  R(p, 'hipR', -1.05, 0, -0.62); R(p, 'knR', 1.25 - swing, 0, 0); R(p, 'anR', 0.5, 0, 0);
  armIK(p, d, -1, -0.8, seat + 0.05, 1.25);
  if (cheer > 0.01) {
    R(p, 'shL', lerp(-0.4, -2.9, cheer), 0, 0.35 + 0.35 * Math.sin(t * 11) * cheer);
    R(p, 'elL', lerp(-0.3, -0.5, cheer), 0, 0);
  } else armIK(p, d, 1, 0.8, seat + 0.05, 1.25);
  return p;
}

// Standing side-on (regular: left foot to the nose). crouch 0..1, lean -1..1 (toward the toes is
// +), pump 0..1 (a quick compression), t for idle motion, cheer 0..1 (fist up, for friends).
export function stancePose(p, d, t, crouch = 0.4, lean = 0, pump = 0, cheer = 0) {
  p.j.fill(0);
  const c = clamp(crouch + Math.abs(lean) * 0.35 + pump * 0.35, 0, 1);
  p.pel.set([0, d.hipY - 0.3 - 0.75 * c, 0.05]);
  p.root.set([0, BOARD.DECK, -0.15, 0, -Math.PI / 2, 0]);
  R(p, 'pelvis', 0.12 + 0.25 * c, 0.12, -0.04 * lean);
  R(p, 'waist', 0.18 + 0.28 * c + 0.12 * lean, 0.2, -0.12 * lean);
  R(p, 'neck', -0.2 - 0.2 * c, 0.95, 0.05 * Math.sin(t * 0.8));
  // feet along the board: body +x is the nose
  const stanceW = 1.32;
  legIK(p, d, 1, stanceW, d.ankleH, 0.12, 0);
  legIK(p, d, -1, -stanceW * 0.95, d.ankleH, 0.05, 0);
  // arms out for balance: the front arm leads toward the nose, the back arm trails;
  // leaning to the toes drops the front hand toward the face of the wave
  const sway = 0.15 * Math.sin(t * 1.3);
  armIK(p, d, 1, 2.75, p.pel[1] + 1.0 - 0.6 * lean + sway, 0.9 + 1.0 * lean);
  if (cheer > 0.01) {
    R(p, 'shR', lerp(0.2, -2.9, cheer), 0, -0.2);
    R(p, 'elR', -0.6, 0, 0);
  } else armIK(p, d, -1, -2.3, p.pel[1] + 0.55 + 0.3 * lean - sway, 0.5 - 0.6 * lean);
  return p;
}

// In the air: knees up, the back hand grabs the rail.
export function airPose(p, d, t, k = 1) {
  stancePose(p, d, t, 1, 0, 0);
  const tuck = 0.5 * k;
  p.pel[1] += tuck * 0.25;
  legIK(p, d, 1, 1.15, d.ankleH + tuck * 0.2, 0.1, 0);
  legIK(p, d, -1, -1.15, d.ankleH + tuck * 0.2, 0.05, 0);
  armIK(p, d, -1, -0.4, d.ankleH + 0.6, 1.0);
  armIK(p, d, 1, 2.6, p.pel[1] + 1.8, 0.4);
  return p;
}

// Tumbling off: arms flung up, legs apart. The rider spins the whole group; this is the body.
export function tumblePose(p, d, t) {
  p.j.fill(0);
  p.pel.set([0, d.hipY, 0]);
  p.root.set([0, BOARD.DECK, 0, 0, -Math.PI / 2, 0]);
  const f = Math.sin(t * 9);
  R(p, 'waist', 0.4, 0, 0.2 * f);
  R(p, 'neck', -0.3, 0, 0);
  R(p, 'shL', -2.5 + 0.4 * f, 0, 1.0); R(p, 'elL', -0.6, 0, 0);
  R(p, 'shR', -2.5 - 0.4 * f, 0, -1.0); R(p, 'elR', -0.6, 0, 0);
  R(p, 'hipL', -0.7 + 0.3 * f, 0, 0.5); R(p, 'knL', 1.0, 0, 0);
  R(p, 'hipR', -0.5 - 0.3 * f, 0, -0.5); R(p, 'knR', 0.8, 0, 0);
  return p;
}

// Write a pose into an avatar (after av.update). The avatar group must sit on the board group.
export function applySurfPose(av, p) {
  const J = av.joints;
  for (let i = 0; i < JN.length; i++) J[JN[i]].rotation.set(p.j[i * 3], p.j[i * 3 + 1], p.j[i * 3 + 2]);
  J.pelvis.position.set(p.pel[0], p.pel[1], p.pel[2]);
  const g = av.group;
  g.rotation.order = 'YXZ';
  g.position.set(p.root[0], p.root[1], p.root[2]);
  g.rotation.set(p.root[3], p.root[4], p.root[5]);
}

// Undo applySurfPose's group transform (the joints come back on the avatar's next update).
export function clearSurfPose(av) {
  const g = av.group;
  g.position.set(0, 0, 0);
  g.rotation.set(0, 0, 0);
  g.rotation.order = 'XYZ';
}
