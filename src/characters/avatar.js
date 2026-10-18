// Public character API (contract: docs/ARCHITECTURE.md).
//   ARCHETYPES                      archetype definitions keyed by id
//   createAvatar(idOrConfig)        -> { group, setMode(mode), update(dt, speed), emote(name), ... }
// Modes: 'idle' | 'walk' | 'scooter' | 'bike' | 'car' | 'sit' (on a bench; see setSeat).
// Emotes: 'wave' | 'argue' | 'swing' (a matkot forehand) | 'photo' (camera to the eye).
// Crowd extras: setSeat(h, { table }) sets the seat height (world units) for 'sit'; setHold(side)
// holds a partner's hand (+1 left hand, -1 right hand, 0 none); setPlaying(false | true | 'drums')
// slings a carried instrument on the back or plays it (drums: seated at the kit, mode 'sit');
// setHeld('beer' | 'coffee' | null) puts a drink in the right hand ('toast', 'drink' emotes).
// Mode 'skate' rides a style.skateboard; emote 'ollie' pops it. None of this changes an avatar
// until called, so quest NPCs render exactly as before.
// The avatar is ~5 world units tall, feet at y = 0, facing +z. `speed` is world units/second.
//
// Animation is fully procedural: poses are flat float arrays (cheap to blend), locomotion is a
// phase-driven gait, vehicles use two-bone IK onto the prop's grips and pedals, and spring
// "jiggles" give hair, beards, peyot, tzitzit, bags and skirts follow-through.
import * as THREE from 'three';
import { ARCHETYPES } from './archetypes.js';
import { buildRig, DIMS, mat, BODY_SCALE } from './rig.js';
import { buildScooter, buildBike, buildTrolley, buildStroller, buildDog, buildGuitarCase, buildDrumKit, buildSkateboard, DRUMS, SKATE, SCOOTER, BIKE, TROLLEY_LEN, STROLLER } from './props.js';
import { faceTexture } from './faces.js';
import { rng, hashString } from './textures.js';

export { ARCHETYPES, BODY_SCALE };
export const AVATAR_MODES = ['idle', 'walk', 'scooter', 'bike', 'car', 'sit', 'skate'];
export const AVATAR_EMOTES = ['wave', 'argue', 'swing', 'photo', 'toast', 'drink', 'ollie'];
// drinks held in the right hand (shared geometry)
const HELD = {
  beer: [[0.26, 0.22, 0.7, '#e8a32e', 0], [0.27, 0.27, 0.16, '#fff8ea', 0.4]],
  coffee: [[0.25, 0.2, 0.55, '#ffffff', 0], [0.26, 0.26, 0.08, '#7a4a2a', 0.3]],
};
const heldGeo = new Map();
// the dog trots at the owner's left, a little ahead (body units)
const DOG = { x: 2.15, z: 1.5 };
const LEASH_GEO = new THREE.CylinderGeometry(0.05, 0.05, 1, 5).translate(0, 0.5, 0);
const _UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------------------------
// Config resolution: id string, or { archetype, seed, ...overrides }.
const clone = (o) => JSON.parse(JSON.stringify(o));
function deepMerge(a, b) {
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k], v);
    else a[k] = clone(v);
  }
  return a;
}
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null) return;
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value && typeof value === 'object' ? clone(value) : value;
}

export function resolveConfig(arg) {
  const input = typeof arg === 'string' ? { archetype: arg } : arg || {};
  let id = input.archetype || input.id || 'player_rishoni';
  if (!ARCHETYPES[id]) {
    console.warn('[avatar] unknown archetype', id, '- using player_rishoni');
    id = 'player_rishoni';
  }
  const cfg = clone(ARCHETYPES[id]);
  if (input.seed != null && (cfg.vary || cfg.looks)) {
    const r = rng(hashString(id + ':' + input.seed));
    // a whole outfit first (looks), then single-value tweaks on top (vary)
    if (cfg.looks && cfg.looks.length) deepMerge(cfg, cfg.looks[Math.floor(r() * cfg.looks.length)]);
    if (cfg.vary) for (const [path, options] of Object.entries(cfg.vary)) setPath(cfg, path, options[Math.floor(r() * options.length)]);
  }
  delete cfg.looks;
  const overrides = { ...input };
  delete overrides.archetype;
  delete overrides.seed;
  delete overrides.walkSpeed;
  delete overrides.runSpeed;
  deepMerge(cfg, overrides);
  cfg.id = id;
  cfg.style = cfg.style || {};
  return cfg;
}

// ---------------------------------------------------------------------------------------------
// Pose layout: 15 joints x (rx, ry, rz), then pelvis position and shoulder shrug.
const JOINTS = ['pelvis', 'waist', 'neck', 'shL', 'elL', 'wrL', 'shR', 'elR', 'wrR', 'hipL', 'knL', 'anL', 'hipR', 'knR', 'anR'];
const [PEL, WAI, NEC, SHL, ELL, WRL, SHR, ELR, WRR, HIPL, KNL, ANL, HIPR, KNR, ANR] = JOINTS.map((_, i) => i);
const PX = 45, PY = 46, PZ = 47, SHRUG = 48, PLEN = 49;
const UPPER = [WAI, NEC, SHL, ELL, WRL, SHR, ELR, WRR];

const newPose = () => new Float32Array(PLEN);
function R(p, j, x, y, z) {
  p[j * 3] = x;
  p[j * 3 + 1] = y;
  p[j * 3 + 2] = z;
}
function lerpPose(out, a, b, t) {
  for (let i = 0; i < PLEN; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}
function lerpJoints(out, b, t, list) {
  for (const j of list) for (let k = 0; k < 3; k++) out[j * 3 + k] += (b[j * 3 + k] - out[j * 3 + k]) * t;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

// ---- two-bone IK ------------------------------------------------------------------------------
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _t = new THREE.Vector3();

function pelvisMatrix(p, out) {
  _e.set(p[0], p[1], p[2], 'XYZ');
  return out.compose(_v.set(p[PX], p[PY], p[PZ]), _q.setFromEuler(_e), _one);
}
function waistMatrix(p, out) {
  pelvisMatrix(p, _m3);
  _e.set(p[WAI * 3], p[WAI * 3 + 1], p[WAI * 3 + 2], 'XYZ');
  _m2.compose(_v.set(0, DIMS.waistY, 0), _q.setFromEuler(_e), _one);
  return out.multiplyMatrices(_m3, _m2);
}
// returns [pitch, splay, bend]; bendSign +1 = knee (bends backward), -1 = elbow (bends forward)
function solveLimb(dx, dy, dz, L1, L2, bendSign) {
  const d = Math.hypot(dx, dy, dz);
  const dd = clamp(d, 0.1, (L1 + L2) * 0.999);
  const splay = Math.asin(clamp(dx / Math.max(d, 1e-4), -1, 1));
  const theta = Math.atan2(-dz, -dy);
  const a = Math.acos(clamp((L1 * L1 + dd * dd - L2 * L2) / (2 * L1 * dd), -1, 1));
  const k = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - dd * dd) / (2 * L1 * L2), -1, 1));
  return bendSign > 0 ? [theta - a, splay, k] : [theta + a, splay, -k];
}
function legIK(p, side, tx, ty, tz, d, footPitch = 0) {
  pelvisMatrix(p, _m1).invert();
  _t.set(tx, ty, tz).applyMatrix4(_m1);
  const [pitch, splay, bend] = solveLimb(_t.x - side * d.legX, _t.y, _t.z, d.ul, d.ll, 1);
  const h = side > 0 ? HIPL : HIPR;
  R(p, h, pitch, 0, splay);
  R(p, h + 1, bend, 0, 0);
  R(p, h + 2, footPitch - (pitch + bend + p[0]), 0, -splay * 0.8);
}
// forward kinematics: lowest sole point of a foot (as an ankle height) for the current pose
const _fk = new THREE.Matrix4(), _fk2 = new THREE.Matrix4(), _fe = new THREE.Euler();
function ankleY(p, side, d) {
  pelvisMatrix(p, _fk);
  const h = side > 0 ? HIPL : HIPR;
  _fe.set(p[h * 3], p[h * 3 + 1], p[h * 3 + 2], 'XZY');
  _fk2.compose(_v.set(side * d.legX, 0, 0), _q.setFromEuler(_fe), _one);
  _fk.multiply(_fk2);
  _fe.set(p[(h + 1) * 3], 0, 0, 'XYZ');
  _fk2.compose(_v.set(0, -d.ul, 0), _q.setFromEuler(_fe), _one);
  _fk.multiply(_fk2);
  _fe.set(p[(h + 2) * 3], 0, 0, 'XYZ');
  _fk2.compose(_v.set(0, -d.ll, 0), _q.setFromEuler(_fe), _one);
  _fk.multiply(_fk2);
  // lowest of heel and toe on the sole, reported as an equivalent flat-foot ankle height
  const toe = _v.set(0, -d.ankleH, 0.8).applyMatrix4(_fk).y;
  const heel = _v.set(0, -d.ankleH, -0.5).applyMatrix4(_fk).y;
  return Math.min(toe, heel) + d.ankleH;
}

// Hand on a grip: the wrist sits a hand's length back along the line to the shoulder, so the
// forearm, wrist and hand point straight at the bar instead of the hand overshooting it.
const _g = new THREE.Vector3();
function gripIK(p, side, gx, gy, gz, d) {
  waistMatrix(p, _m1);
  _g.set(side * d.shX, d.shY + p[SHRUG], 0).applyMatrix4(_m1); // shoulder in body space
  _g.sub(_t.set(gx, gy, gz)).normalize().multiplyScalar(0.42);
  armIK(p, side, gx + _g.x, gy + _g.y, gz + _g.z, d, 0);
}
function armIK(p, side, tx, ty, tz, d, wristPitch = 0) {
  waistMatrix(p, _m1).invert();
  _t.set(tx, ty, tz).applyMatrix4(_m1);
  const [pitch, splay, bend] = solveLimb(_t.x - side * d.shX, _t.y - (d.shY + p[SHRUG]), _t.z, d.ua, d.la, -1);
  const s = side > 0 ? SHL : SHR;
  R(p, s, pitch, 0, splay);
  R(p, s + 1, bend, 0, 0);
  R(p, s + 2, wristPitch, 0, 0);
}

// ---- gait shared by the full avatar and the crowd's far proxies ---------------------------------
// Thresholds in world units/s for a full-size adult (4.4 units tall, so 1 unit is ~0.4 m). Crowd
// walkers go 2.8-4.8 (1.1-1.9 m/s, a real walking pace) and walk. The player's 10 (~4 m/s) and
// joggers' 8.5-11 are a running pace for any person, and for these short toon legs above all, so
// they get a light jog with a flight phase rather than a frantic speed-walk or a crouch; the
// player's Shift 18 is a full run (src/engine/vehicles.js).
export const GAIT = { walk: 5.4, run: 11 };
// Cycle length C in body units per two steps for a pace vb (body units/s) and run blend 0..1. The
// cadence is vb / C cycles per second; a planted foot moves back at exactly vb, so C only decides
// how long the strides are. A stroll takes short steps (about 1.5 cycles/s for the crowd); a brisk
// walk at the player's pace lengthens them as far as the leg reaches; a run adds a flight phase.
export function gaitCycleLength(vb, run, stride = 1) {
  const walkC = clamp(2.1 + 0.24 * vb, 2.3, 3.8);
  const runC = clamp(2.85 + 0.33 * vb, 4.0, 9.5);
  return lerp(walkC, runC, run) * clamp(stride ?? 1, 0.75, 1.15);
}
// Fraction of the cycle a foot is on the ground: 0.6 in a stroll, less in a brisk walk and a fast
// run, so a long stride lands the foot nearer under the body instead of dropping the hips.
export function gaitStance(vb, run) {
  return lerp(lerp(0.6, 0.5, smooth(6, 13, vb)), lerp(0.36, 0.28, smooth(10, 24, vb)), run);
}
export function gaitRunBlend(v, walkSpeed = GAIT.walk, runSpeed = GAIT.run) {
  return smooth(walkSpeed * 1.05, runSpeed, v);
}

// ---------------------------------------------------------------------------------------------
export function createAvatar(archetypeIdOrConfig = 'player_rishoni') {
  const cfg = resolveConfig(archetypeIdOrConfig);
  const opts = typeof archetypeIdOrConfig === 'object' && archetypeIdOrConfig ? archetypeIdOrConfig : {};
  const rig = buildRig(cfg);
  const { root, lean, body, J, dims: d } = rig;
  const style = cfg.style;
  const worldScale = d.scale; // world units per body unit
  // gait thresholds in world units/s for a full-size adult (BODY_SCALE): the player's walk (10)
  // stays a walk, the run blends in towards Shift (18); smaller bodies (kids) switch earlier
  const walkSpeed = (opts.walkSpeed ?? GAIT.walk) * (worldScale / BODY_SCALE);
  const runSpeed = (opts.runSpeed ?? GAIT.run) * (worldScale / BODY_SCALE);

  // props
  const scooter = buildScooter(cfg.props?.scooter);
  const bike = buildBike(cfg.props?.bike);
  scooter.group.visible = bike.group.visible = false;
  body.add(scooter.group, bike.group);
  let trolley = null;
  if (style.trolley) {
    trolley = buildTrolley(style.trolley.color, style.trolley.alt);
    body.add(trolley.group);
    rig.hideInVehicle.push(trolley.group);
  }
  let stroller = null;
  if (style.stroller) {
    stroller = buildStroller(style.stroller.color);
    stroller.group.position.set(0, 0, STROLLER.ahead);
    body.add(stroller.group);
    rig.hideInVehicle.push(stroller.group);
  }
  let dog = null, leash = null;
  if (style.dog) {
    dog = buildDog(style.dog.color, style.dog.alt, style.dog.size ?? 1, style.dog.ears);
    dog.group.position.set(DOG.x, 0, DOG.z);
    leash = new THREE.Mesh(LEASH_GEO, mat(style.dog.leash || '#e8364f'));
    leash.castShadow = false;
    body.add(dog.group, leash);
    rig.hideInVehicle.push(dog.group, leash);
  }
  let kit = null;
  const sticks = [];
  if (style.drumKit) {
    kit = buildDrumKit(style.drumKit.color);
    kit.group.visible = false;
    body.add(kit.group);
    for (const side of ['L', 'R']) {
      const st2 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.5, 6), mat('#e8d2a6'));
      st2.position.set(0, -0.55, 0.55);
      st2.rotation.x = 1.25;
      st2.visible = false;
      J['wr' + side].add(st2);
      sticks.push(st2);
    }
  }
  // a board for anyone who rides one (skaters carry their own colours; the player's is made the
  // first time they step on it)
  let board = null;
  const ensureBoard = () => {
    if (board) return board;
    const sb = style.skateboard || { color: '#2f7bd6', grip: '#2b2b2b' };
    board = buildSkateboard(sb.color, sb.grip);
    board.group.visible = false;
    body.add(board.group);
    return board;
  };
  if (style.skateboard) ensureBoard();
  // carried instrument: its playing transform as built, and a slung-on-the-back transform
  const inst = rig.instrument || null;
  if (inst) {
    inst.playPos = inst.group.position.clone();
    inst.playRot = inst.group.rotation.clone();
  }
  if (style.guitarCase) {
    const gc = buildGuitarCase(style.guitarCase.color, style.guitarCase.lining);
    gc.group.position.set(0.4, 0, 3.4);
    gc.group.rotation.y = 1.35;
    body.add(gc.group);
    rig.hideInVehicle.push(gc.group);
  }

  const jointObjs = JOINTS.map((n) => J[n]);
  const st = {
    t: Math.random() * 10,
    mode: 'idle',
    phase: 0,
    speed: 0,
    fade: 1,
    snap: newPose(),
    cur: newPose(),
    a: newPose(),
    b: newPose(),
    emote: null,
    kick: 0,
    crank: 0,
    wheelAngle: 0,
    lookYaw: 0,
    lookTarget: 0,
    lookTimer: 1,
    blink: 2 + Math.random() * 3,
    expr: 'neutral',
    torso: 0,
    torsoV: 0,
    lean: 0,
    prevPos: null,
    prevYaw: null,
    vF: 0,
    accF: 0,
    yawRate: 0,
    prevPY: d.hipY,
    vPY: 0,
    accV: 0,
    propT: 1,
    seedPhase: Math.random() * 6,
    seatH: 1.29,
    table: false,
    hold: 0,
    dogPhase: 0,
    playing: !style.carry,
    exprName: null,
    exprT: 0,
    talking: false,
    restFace: 'neutral',
    workout: null,
    rep: 0,
    held: null,
    heldMesh: null,
    push: 0,
  };
  idlePose(st.cur, 0);
  st.snap.set(st.cur);

  // ---- pose generators -----------------------------------------------------------------------
  function basePose(p) {
    p.fill(0);
    p[PX] = 0;
    p[PY] = d.hipY;
    p[PZ] = 0;
  }

  function idlePose(p, crouch = 0) {
    basePose(p);
    const t = st.t;
    const br = Math.sin(t * 1.8);
    const sw = Math.sin(t * 0.5 + st.seedPhase);
    const hunch = style.hunch || 0;
    p[PX] = 0.08 * sw;
    p[PY] = d.hipY - 0.06 - crouch;
    p[0 * 3 + 2] = -0.035 * sw;
    R(p, WAI, 0.02 * br + hunch, 0.04 * Math.sin(t * 0.37), 0.05 * sw);
    R(p, NEC, -hunch * 0.7 - 0.015 * br + 0.04 * Math.sin(t * 0.6), st.lookYaw, -0.02 * sw);
    p[SHRUG] = 0.03 * br;
    // feet stay planted while the hips shift weight; the relaxed leg sits a little forward
    const relaxL = Math.max(0, -sw), relaxR = Math.max(0, sw);
    legIK(p, 1, d.legX, d.ankleH + 0.02 * relaxL, 0.12 * relaxL, d);
    legIK(p, -1, -d.legX, d.ankleH + 0.02 * relaxR, 0.12 * relaxR, d);
    R(p, SHL, 0.05 * Math.sin(t * 0.9), 0, 0.07 + 0.02 * br);
    R(p, ELL, -0.16 - 0.03 * br, 0, 0);
    R(p, SHR, -0.05 * Math.sin(t * 0.9 + 1), 0, -0.07 - 0.02 * br);
    R(p, ELR, -0.16 - 0.03 * br, 0, 0);
    if (style.armsBehind) armsBehind(p, 0);
  }

  function armsBehind(p, ph) {
    // upper arms well back so the folded forearms clear the torso (and grandpa's belly)
    R(p, SHL, 0.85 + 0.03 * Math.sin(ph), -1.9, 0.12);
    R(p, ELL, -1.25, 0, 0);
    R(p, SHR, 0.85 - 0.03 * Math.sin(ph), 1.9, -0.12);
    R(p, ELR, -1.25, 0, 0);
  }

  // ---- locomotion: foot placement, animated the way a character animator keys a walk ----------
  // Each foot follows its own track in body space. A planted foot moves back exactly as fast as the
  // body moves forward (no skating): the cycle length C (body units per two steps) sets the cadence
  // in update(). The four key poses of a walk fall out of the tracks: CONTACT (heel strikes, toe
  // up, legs and arms at their widest), DOWN (the front knee gives as the weight lands, the hips at
  // their lowest), PASSING (the stance leg straight under the body, the free foot passing it) and UP
  // (the back heel peels, the body at its highest). The hips shift over the planted foot and drop a
  // little on the free side; the shoulders counter-rotate; the arms swing a beat behind the legs
  // with the forearms and hands dragging behind the upper arm (overlap and follow-through); the
  // head lags the body slightly and stays level. Every joint moves on an eased curve, and each
  // person carries a small asymmetry (one arm swings more, the head sits a touch off level) so a
  // crowd never marches in lockstep. A run adds a flight phase, pumps bent arms and leans in.
  const LEG = DIMS.ul + DIMS.ll;
  const gaitCycle = (vb, run) => gaitCycleLength(vb, run, style.stride);
  const asym = (() => {
    const r = rng(hashString((cfg.id || 'x') + ':' + (opts.seed ?? 0) + ':gait'));
    return { armL: 0.9 + 0.2 * r(), armR: 0.9 + 0.2 * r(), tilt: (r() - 0.5) * 0.07, lean: (r() - 0.5) * 0.05, splay: (r() - 0.5) * 0.06, skew: (r() - 0.5) * 0.02, lag: 0.05 + 0.04 * r() };
  })();
  const _foot = [0, 0, 0, 0];
  function footTrack(u, beta, C, run, amp) {
    const half = beta * C * 0.5, bias = 0.08 * (1 - run);
    if (u < beta) {
      const k = u / beta;
      let y = d.ankleH, pitch = 0;
      if (k < 0.18) pitch = -0.32 * (1 - smooth(0, 0.18, k)) * (1 - run * 0.6) * amp; // heel strike, toe up, rolling flat
      else if (k > 0.62) { pitch = 0.6 * smooth(0.62, 1, k) * amp; y += 0.55 * Math.sin(pitch); } // heel peel, toe-off
      _foot[0] = half * (1 - 2 * k) + bias; _foot[1] = y; _foot[2] = pitch; _foot[3] = k;
      return true;
    }
    const sw = (u - beta) / (1 - beta);
    const e = sw - Math.sin(2 * Math.PI * sw) / (2 * Math.PI); // eased: slow out of toe-off, fast through, slow into contact
    const lift = lerp(0.3, 0.55, run) * amp;
    const kick = run * 0.9 * Math.sin(Math.PI * Math.min(1, sw * 1.7)) * (1 - sw); // heel up behind
    _foot[0] = half * (2 * e - 1) + bias - kick * 0.35;
    // the swing arc peaks early (toe clearance just after push-off) and skims in low to the heel
    // strike; it leaves the ground from the toe-off height instead of snapping flat
    const peel = 0.55 * Math.sin(0.6 * amp) * (1 - smooth(0, 0.3, sw));
    _foot[1] = d.ankleH + lift * Math.sin(Math.PI * Math.pow(sw, 0.72)) + kick + peel;
    _foot[2] = lerp(0.6 * amp, -0.3 * amp, smooth(0, 0.85, sw));
    _foot[3] = sw;
    return false;
  }
  // where the two feet are fore/aft at cycle phase u: + when the left foot leads (-0.5..0.5)
  function leadAt(u, beta, C, run, amp) {
    footTrack(((u % 1) + 1) % 1, beta, C, run, amp);
    const zl = _foot[0];
    footTrack((((u + 0.5 + asym.skew) % 1) + 1) % 1, beta, C, run, amp);
    return (zl - _foot[0]) / Math.max(1, C);
  }
  function locoPose(p, amp, run) {
    basePose(p);
    const swag = style.swagger || 0;
    const bounce = style.bounce || 0;
    const hunch = style.hunch || 0;
    const C = st.gaitC || 2.5;
    const beta = gaitStance(st.gaitVb || 0, run);
    const u0 = (((st.phase / (2 * Math.PI)) % 1) + 1) % 1;
    const R2 = (0.997 * LEG) ** 2; // a stance leg reads straight (knee ~8 deg), as in a real walk
    const feet = [];
    // the pelvis turns with the leading leg, carrying that hip joint forward (it lengthens the step
    // without dropping the body); the reach of each leg is measured from its turned hip joint
    const lead = leadAt(u0, beta, C, run, amp);
    const pelYaw = -0.55 * lead * amp * (1 + swag * 0.4);
    let reachMin = Infinity, compress = 0, inAir = true, dip = 0;
    for (const [side, u] of [[1, u0], [-1, (u0 + 0.5 + asym.skew) % 1]]) {
      const stance = footTrack(u, beta, C, run, amp);
      const f = { side, z: _foot[0], y: _foot[1], pitch: _foot[2], k: _foot[3], stance };
      feet.push(f);
      if (stance) {
        inAir = false;
        const hz = -side * d.legX * Math.sin(pelYaw);
        reachMin = Math.min(reachMin, f.y + Math.sqrt(Math.max(0.2, R2 - (f.z - hz) ** 2)));
        compress = Math.max(compress, Math.sin(Math.PI * f.k));
        // DOWN: the knee of the foot that just landed gives under the weight, then straightens
        if (f.k < 0.4) dip = Math.max(dip, Math.sin((Math.PI * f.k) / 0.4));
      }
    }
    // hips: vault over a nearly straight stance leg, sink into DOWN after each contact
    const half = beta * C * 0.5;
    const low = d.ankleH + Math.sqrt(Math.max(0.2, R2 - half * half));
    const walkTop = reachMin === Infinity ? low : low + (reachMin - low) * (0.92 + 0.06 * bounce);
    const walkY = Math.min(d.hipY - 0.03, walkTop) - 0.06 * dip * amp;
    // run: hips carried high (a runner's stance knee bends ~40 deg), sinking as the foot takes the
    // weight and rising through the flight; a planted foot always reaches the ground
    const fl = inAir ? Math.sin((Math.PI * ((u0 % 0.5) - beta)) / (0.5 - beta)) : 0;
    const runY = Math.min(d.hipY * 0.94 - 0.2 * compress * amp + 0.14 * Math.max(0, fl), inAir ? Infinity : reachMin - 0.03);
    p[PY] = lerp(walkY, runY, run);
    // weight shift: the pelvis travels over the planted foot (eased, peaking at mid-stance) and the
    // free side drops a touch; it turns with the leading leg
    const wL = Math.cos(2 * Math.PI * (u0 - beta / 2)); // +1 at left mid-stance
    p[PX] = (0.1 * (1 - run) + swag * 0.06) * amp * wL;
    R(p, PEL, 0.03 + 0.05 * run, pelYaw, 0.07 * amp * wL * (1 - run * 0.5) * (1 + swag));
    for (const f of feet) legIK(p, f.side, f.side * d.legX * (1 - 0.18 * run), f.y, f.z, d, f.pitch);
    // torso: forward lean with speed, shoulders counter-rotating, the chest leaning back over the
    // stance hip as the pelvis shifts
    const lean = lerp(0.05, 0.36, run) * amp + hunch + asym.lean;
    R(p, WAI, lean + 0.02 * dip * amp * (1 - run), -pelYaw * 1.9 + 0.04 * swag * wL, -0.045 * amp * wL * (1 + swag * 2));
    // arms: swing from the shoulder a beat behind the legs (overlap); the forearm and the hand drag
    // further behind (follow-through), so the elbow folds as the arm comes forward and opens as it
    // swings back, and the wrist trails the swing
    const lag = asym.lag * (1 - 0.5 * run);
    const la = leadAt(u0 - lag, beta, C, run, amp);
    const lf = leadAt(u0 - lag * 2.2, beta, C, run, amp);
    const A = lerp(1.25, 1.6, run) * amp * (1 + swag * 0.25 + bounce * 0.2);
    const elB = lerp(0.28, 1.45, run);
    const splay = 0.08 + 0.06 * run + swag * 0.18;
    for (const side of [1, -1]) {
      const a = A * la * side * (side > 0 ? asym.armL : asym.armR);
      const af = A * lf * side;
      const sh = side > 0 ? SHL : SHR, el = side > 0 ? ELL : ELR, wr = side > 0 ? WRL : WRR;
      R(p, sh, a, 0, side * (splay + asym.splay * side));
      R(p, el, -(elB + 0.55 * Math.max(0, -af) * (1 - run * 0.6)), 0, 0);
      R(p, wr, 0.25 * (af - a) * (1 - run * 0.5), 0, 0);
    }
    p[SHRUG] = swag * 0.05 * Math.abs(wL) * amp;
    // head: level and steady, settling a beat after the body (a small nod into each DOWN), turning
    // back against the shoulders, with each person's own slight tilt
    const nod = 0.03 * Math.cos(4 * Math.PI * (u0 - 0.06)) * amp * (1 - run * 0.5);
    R(p, NEC, -lean * 0.75 + nod - 0.02 * dip * amp, -(p[WAI * 3 + 1] + p[1]) * 0.85, asym.tilt + 0.03 * wL * amp);
    if (style.armsBehind) armsBehind(p, st.phase);
  }

  function scooterPose(p, dt) {
    basePose(p);
    const S = SCOOTER;
    const moving = smooth(0.1, 0.9, st.speed);
    const deckAnkle = S.deckTop + d.ankleH;
    // kick cycle: plant, push back, lift, glide. Rate rises gently with speed.
    const c = st.kick % 1;
    const keys = [
      [0.0, -0.08, deckAnkle, -0.6],
      [0.18, -0.62, d.ankleH + 0.12, 0.3],
      [0.55, -0.62, d.ankleH + 0.16, -0.75],
      [0.75, -0.4, 1.15, -0.95],
      [0.9, -0.08, deckAnkle + 0.05, -0.6],
      [1.0, -0.08, deckAnkle, -0.6],
    ];
    let k = 0;
    while (k < keys.length - 2 && c > keys[k + 1][0]) k++;
    const k0 = keys[k], k1 = keys[k + 1];
    const u = smooth(0, 1, (c - k0[0]) / (k1[0] - k0[0]));
    let fx = lerp(k0[1], k1[1], u), fy = lerp(k0[2], k1[2], u), fz = lerp(k0[3], k1[3], u);
    const push = smooth(0.08, 0.2, c) * (1 - smooth(0.5, 0.68, c)) * moving;
    // stopped: right foot down on the pavement beside the deck
    fx = lerp(-0.95, fx, moving);
    fy = lerp(d.ankleH, fy, moving);
    fz = lerp(0.25, fz, moving);
    p[PY] = lerp(d.hipY - 0.08, deckAnkle + LEG - 0.08 - push * 0.3, moving);
    p[PZ] = -0.12 - push * 0.15;
    p[PX] = lerp(-0.12, 0, moving);
    R(p, PEL, 0.05 + push * 0.1, 0.12, lerp(0.06, 0, moving));
    R(p, WAI, 0.12 + push * 0.1, -0.1, 0);
    R(p, NEC, -0.3 - push * 0.1, 0, 0);
    legIK(p, 1, 0.14, deckAnkle, 0.45, d, 0);
    legIK(p, -1, fx, fy, fz, d, push * 0.35);
    for (const s of [1, -1]) gripIK(p, s, s * S.gripX, S.gripY, S.gripZ, d);
  }

  function bikePose(p) {
    basePose(p);
    const B = BIKE;
    const ride = smooth(0.25, 1.2, st.speed);
    const th = st.crank;
    p[PY] = lerp(d.hipY + 0.02, B.seatY + 0.12, ride);
    p[PZ] = lerp(-0.15, B.seatZ + 0.02, ride);
    R(p, PEL, lerp(0.05, 0.12, ride), 0, 0);
    R(p, WAI, lerp(0.18, 0.36, ride), 0, 0);
    R(p, NEC, -lerp(0.2, 0.42, ride), 0.08 * Math.sin(st.t * 0.7), 0);
    const pl = [B.pedalX, B.bbY - B.crank * Math.cos(th), B.bbZ - B.crank * Math.sin(th)];
    const pr = [-B.pedalX, B.bbY + B.crank * Math.cos(th), B.bbZ + B.crank * Math.sin(th)];
    // straddling the frame when stopped, both feet on the ground
    legIK(p, 1, lerp(1.0, pl[0], ride), lerp(d.ankleH, pl[1] + d.ankleH - 0.05, ride), lerp(0.1, pl[2] - 0.15, ride), d, 0.12 * Math.sin(th) * ride);
    legIK(p, -1, lerp(-1.0, pr[0], ride), lerp(d.ankleH, pr[1] + d.ankleH - 0.05, ride), lerp(0.1, pr[2] - 0.15, ride), d, -0.12 * Math.sin(th) * ride);
    for (const s of [1, -1]) gripIK(p, s, s * B.gripX, B.gripY, B.gripZ + 0.15, d);
  }

  function carPose(p) {
    basePose(p);
    const t = st.t;
    p[PY] = 1.3;
    R(p, PEL, 0, 0, 0);
    const dv = st.drive;
    if (dv) {
      // the engine's car supplies the steering-wheel grips and pedals (setDrive): sit back a
      // little, legs forward to the pedals, both hands on the rim
      R(p, WAI, -0.12, 0, 0);
      R(p, NEC, 0.1, 0.12 * Math.sin(t * 0.4), 0);
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? 1 : -1, f = dv.pedals[i];
        legIK(p, s, f[0], f[1] + d.ankleH, f[2], d, 0.25);
        gripIK(p, s, dv.grips[i][0], dv.grips[i][1], dv.grips[i][2], d);
      }
      return;
    }
    R(p, WAI, -0.06, 0, 0.02 * Math.sin(t * 0.8));
    R(p, NEC, 0.02, 0.15 * Math.sin(t * 0.4), 0);
    for (const [h, s] of [[HIPL, 1], [HIPR, -1]]) {
      R(p, h, -1.45, 0, s * 0.06);
      R(p, h + 1, 1.4, 0, 0);
      R(p, h + 2, 0.05, 0, 0);
    }
    const steer = 0.12 * Math.sin(t * 0.9);
    R(p, SHL, -1.05 + steer, 0, 0.12);
    R(p, ELL, -0.55, 0, 0);
    R(p, SHR, -1.05 - steer, 0, -0.12);
    R(p, ELR, -0.55, 0, 0);
  }

  // Seated on a bench: butt on the seat, thighs forward over the edge, shins hanging (short
  // chunky legs dangle a little on a full-size bench, the way Roblox seats look), hands on the lap.
  function sitPose(p) {
    basePose(p);
    const t = st.t;
    const br = Math.sin(t * 1.6);
    const py = st.seatH / worldScale + 0.5;
    p[PY] = py;
    p[PZ] = 0;
    R(p, PEL, -0.04, 0, 0);
    R(p, WAI, -0.05 + 0.015 * br + (style.hunch || 0) * 0.6, 0.03 * Math.sin(t * 0.31 + st.seedPhase), 0);
    R(p, NEC, 0.06 - 0.015 * br, st.lookYaw, 0);
    p[SHRUG] = 0.02 * br;
    const footY = Math.max(d.ankleH, py - 1.37);
    if (st.playing === 'drums' && kit) { drumPose(p, py); return; }
    for (const s of [1, -1]) legIK(p, s, s * (d.legX + 0.06), footY, 0.85, d, 0);
    if (st.table) for (const s of [1, -1]) armIK(p, s, s * (d.legX + 0.35), py + 1.0, 1.55, d, -0.1);
    else for (const s of [1, -1]) armIK(p, s, s * (d.legX + 0.15), py + 0.55, 0.85, d, -0.2);
  }

  // At the kit: right foot on the kick pedal, hi-hat eighths in the right hand, snare backbeat in
  // the left, a fill over the toms every few bars, head nodding on the beat.
  function hitY(ph, sharp = 6) {
    const f = ph - Math.floor(ph);
    return Math.pow(f, sharp) * 0.0 + (1 - Math.exp(-f * sharp)) * 0.55; // fast drop, slow lift
  }
  function drumPose(p, py) {
    const t = st.t, D = DRUMS;
    const beat = t * 4.4; // eighth notes at ~132 bpm
    const bar = Math.floor(beat / 8) % 4;
    const fill = bar === 3 && (beat % 8) >= 4;
    R(p, WAI, 0.18 + 0.02 * Math.sin(beat * Math.PI), 0.05 * Math.sin(beat * Math.PI / 2), 0);
    R(p, NEC, -0.12 + 0.07 * Math.abs(Math.sin(beat * Math.PI / 2)), 0, 0);
    // feet
    const kickF = beat % 4 < 0.4 || (beat % 8 > 5 && beat % 8 < 5.4) ? 0 : 0.25;
    legIK(p, -1, D.kick[0] - 0.55, d.ankleH + kickF, D.kick[2], d, kickF * 0.8);
    legIK(p, 1, D.hihat[0] + 2.3, d.ankleH + 0.05, 1.1, d, 0);
    let rt, lt;
    if (fill) {
      const k = Math.floor(beat * 2) % 4;
      const drums = [D.tom, D.tom, D.floor, D.floor];
      rt = drums[k]; lt = drums[(k + 1) % 4];
    } else {
      rt = bar === 2 ? D.ride : D.hihat;
      lt = D.snare;
    }
    const rh = hitY(beat), lh = hitY(beat / 2 + 0.5);
    armIK(p, -1, rt[0] + 0.3, rt[1] + 0.25 + rh, rt[2] - 0.65, d, 0.35);
    armIK(p, 1, lt[0] - 0.2, lt[1] + 0.25 + (fill ? hitY(beat + 0.5) : lh), lt[2] - 0.65, d, 0.35);
  }

  // On the board: side-on stance, front (left) foot just behind the front bolts, back foot on the
  // tail, knees soft, arms out for balance, eyes down the line. A push: the back foot leaves the
  // tail, reaches down beside the board ahead of the front foot, is planted and driven back as fast
  // as the board rolls (it holds the ground, no skating), lifts and returns to the tail; the hips
  // open toward the nose and the front knee sinks so the pushing leg reaches the ground. At speed
  // (or when told not to push) the rider just cruises.
  function skatePose(p) {
    basePose(p);
    const t = st.t, deck = SKATE.deckTop;
    const vb = st.speed / worldScale;
    const T = 2.0, travel = 1.5;
    const cf = clamp(travel / Math.max(vb, 0.4) / T, 0.07, 0.45);
    const a = 0.12, b = a + cf, e = b + 0.16;
    const c = st.push % 1;
    const ph = st.skatePush !== false && st.speed > 0.3 ? c : 1;
    const off = ph < a ? smooth(0, a, ph) : ph < b ? 1 : ph < e ? 1 - smooth(b, e, ph) : 0;
    // the pushing foot: forward and down (reach), planted and moving back at board speed, then up
    let fx = -0.05, fy = deck + d.ankleH, fz = -1.05;
    if (ph < a) { const k = smooth(0, a, ph); fx = lerp(-0.05, -0.85, k); fz = lerp(-1.05, 0.55, k); fy = lerp(deck + d.ankleH, d.ankleH, k) + 0.35 * Math.sin(Math.PI * k); }
    else if (ph < b) { const k = (ph - a) / cf; fx = -0.85; fz = 0.55 - travel * k; fy = d.ankleH; }
    else if (ph < e) { const k = smooth(b, e, ph); fx = lerp(-0.85, -0.05, k); fz = lerp(0.55 - travel, -1.05, k); fy = lerp(d.ankleH, deck + d.ankleH, k) + 0.4 * Math.sin(Math.PI * k); }
    const R2 = (0.99 * LEG) ** 2;
    const hipRide = d.hipY - 0.34 + deck + 0.03 * Math.sin(t * 1.1);
    const reachHip = d.ankleH + Math.sqrt(Math.max(0.2, R2 - fz * fz - (fx + d.legX) ** 2)) - 0.03;
    p[PY] = ph >= a && ph < b ? Math.min(hipRide, reachHip) : lerp(hipRide, Math.min(hipRide, reachHip + 0.1), off);
    const yaw = lerp(1.0, 0.3, off);
    R(p, PEL, 0.08 + 0.06 * off, yaw, 0);
    R(p, WAI, 0.12 + 0.07 * off, -yaw * 0.55, 0.03 * Math.sin(t * 1.3));
    R(p, NEC, -0.12, -yaw * 0.5 + st.lookYaw * 0.3, 0);
    legIK(p, 1, 0.12, deck + d.ankleH, 0.72, d, 0);
    legIK(p, -1, fx, fy, fz, d, ph >= a && ph < b ? 0.15 * ((ph - a) / cf) : 0);
    // arms: out for balance on the board, swinging with the push
    const sw = 0.25 * off * Math.sin(Math.PI * clamp((ph - a) / Math.max(cf, 0.01), 0, 1));
    R(p, SHL, -0.25 + 0.1 * Math.sin(t * 0.9) - sw, 0, lerp(0.75, 0.3, off));
    R(p, ELL, -0.4, 0, 0);
    R(p, SHR, 0.2 + sw, 0, -lerp(0.65, 0.3, off) - 0.1 * Math.sin(t * 0.9));
    R(p, ELR, -0.35, 0, 0);
  }

  function modePose(p, mode, dt) {
    if (mode === 'walk') {
      const v = st.speed;
      const w = smooth(0.15, 1.2, v);
      if (w < 1) idlePose(p);
      if (w > 0) {
        const amp = clamp(v / (walkSpeed * 0.7), 0.35, 1);
        const run = smooth(walkSpeed * 1.05, runSpeed, v);
        const tmp = st.b;
        locoPose(tmp, amp, run);
        if (w < 1) lerpPose(p, p, tmp, w);
        else p.set(tmp);
      }
    } else if (mode === 'scooter') scooterPose(p, dt);
    else if (mode === 'bike') bikePose(p);
    else if (mode === 'car') carPose(p);
    else if (mode === 'sit') sitPose(p);
    else if (mode === 'skate') skatePose(p);
    else idlePose(p);
    // both hands on the stroller's push bar
    if (stroller && (mode === 'walk' || mode === 'idle')) {
      p[WAI * 3] += 0.06;
      for (const s of [1, -1]) gripIK(p, s, s * STROLLER.gripX, STROLLER.handleY, STROLLER.ahead, d);
    }
    // eyes on the phone: forearm up, screen toward the face, head tipped down
    if (style.phone && (mode === 'walk' || mode === 'idle')) {
      R(p, SHR, -0.3, 0, -0.12);
      R(p, ELR, -1.55, 0, 0);
      R(p, WRR, -0.15, 0, 0);
      p[NEC * 3] += 0.32;
    }
    // savta's right hand keeps hold of her trolley
    if (trolley && (mode === 'walk' || mode === 'idle')) {
      R(p, SHR, 0.28 + 0.04 * Math.sin(st.phase), 0, -0.14);
      R(p, ELR, -0.2, 0, 0);
      R(p, WRR, -0.2, 0, 0);
    }
    const upright = mode === 'walk' || mode === 'idle';
    // leash hand forward and low
    if (dog && upright) {
      R(p, SHL, -0.42 + 0.05 * Math.sin(st.phase), 0, 0.22);
      R(p, ELL, -0.35, 0, 0);
      R(p, WRL, 0, 0, 0);
    }
    // the hand nearest the partner hangs still and reaches a little toward them
    if (st.hold && upright) {
      const sh = st.hold > 0 ? SHL : SHR;
      R(p, sh, 0.06, 0, st.hold * 0.1);
      R(p, sh + 1, -0.15, 0, 0);
      R(p, sh + 2, 0, 0, 0);
    }
    if (st.workout && mode === 'idle') workoutPose(p);
    else if ((upright || mode === 'sit') && st.playing && st.playing !== 'drums') {
      if (inst && inst.kind === 'violin') violinPose(p);
      else if (inst && inst.kind === 'flute') flutePose(p);
      else if (inst && EXTRA_POSE[inst.kind]) EXTRA_POSE[inst.kind](p);
      else if (rig.guitar) guitarPose(p);
    }
    if (st.carry && (upright || mode === 'sit')) carryPose(p);
  }
  // Fitness park: hanging from a bar ('hang', pulled up by setWorkout's rep 0..1), or propped on
  // parallel bars ('dip'). The crowd moves the whole avatar up and down with the rep.
  function workoutPose(p) {
    const k = st.rep;
    if (st.workout === 'hang') {
      const sy = p[PY] + d.waistY + d.shY;
      for (const s of [1, -1]) armIK(p, s, s * 0.95, sy + (d.ua + d.la) * (1 - 0.55 * k) + 0.3, 0.1, d, 0);
      for (const [h, s] of [[HIPL, 1], [HIPR, -1]]) { R(p, h, 0.15, 0, s * 0.04); R(p, h + 1, 0.9, 0, 0); R(p, h + 2, -0.3, 0, 0); }
      R(p, NEC, -0.15, 0, 0);
    } else if (st.workout === 'dip') {
      for (const s of [1, -1]) { R(p, s > 0 ? SHL : SHR, 0.25 * k, 0, s * 0.12); R(p, s > 0 ? ELL : ELR, -0.9 * k, 0, 0); R(p, s > 0 ? WRL : WRR, 0.6, 0, 0); }
      for (const [h, s] of [[HIPL, 1], [HIPR, -1]]) { R(p, h, 0.35, 0, s * 0.04); R(p, h + 1, 1.3, 0, 0); }
    } else {
      // stretching between sets: arms overhead, a slow side bend
      const b = Math.sin(st.t * 0.8);
      R(p, SHL, -0.1, 0, 2.6); R(p, SHR, -0.1, 0, -2.6); R(p, ELL, -0.4, 0, 0); R(p, ELR, -0.4, 0, 0);
      R(p, WAI, 0, 0, 0.25 * b);
    }
  }
  function instPoint(g, lx, ly, lz) {
    _gm.compose(g.position, g.quaternion, _one);
    return _gv.set(lx, ly, lz).applyMatrix4(_gm).applyMatrix4(_gw);
  }
  function violinPose(p) {
    const t = st.t, g = inst.group;
    waistMatrix(p, _gw);
    const a = instPoint(g, 0, 1.15, 0.1);
    armIK(p, 1, a.x, a.y - 0.15, a.z, d, 0.2);
    const bowing = Math.sin(t * 2.6);
    const b = instPoint(g, 0.25 + 0.75 * bowing, -0.05, 0.45);
    armIK(p, -1, b.x, b.y, b.z, d, -0.2);
    R(p, NEC, p[NEC * 3] + 0.15, p[NEC * 3 + 1] + 0.35, 0.3);
  }
  function flutePose(p) {
    const t = st.t, g = inst.group;
    waistMatrix(p, _gw);
    const f = 0.03 * Math.sin(t * 7);
    const a = instPoint(g, 0, -0.45, 0.05);
    armIK(p, 1, a.x, a.y - 0.1 + f, a.z + 0.05, d, 0);
    const b = instPoint(g, 0, 0.45, 0.05);
    armIK(p, -1, b.x, b.y - 0.1 - f, b.z + 0.05, d, 0);
    R(p, NEC, p[NEC * 3] - 0.05, p[NEC * 3 + 1] - 0.15, -0.12 + 0.04 * Math.sin(t * 1.3));
  }

  // ---- Ofir's other instruments (round 5) -------------------------------------------------------
  // Where each one sits in the hands while played (waist space), and the hands on it.
  const INST_PLAY = {
    melodica: { pos: [0.1, 2.05, 1.05], rot: [0.15, 0, Math.PI / 2] },
    darbuka: { pos: [0.8, 0.5, 0.6], rot: [-1.35, 0, 0.3] }, // under the left arm, head forward
    shofar: { pos: [0.15, 2.0, 0.85], rot: [-1.1, 0, 0.1] },
  };
  const waistPt = (x, y, z) => _gv.set(x, y, z).applyMatrix4(_gw);
  const EXTRA_POSE = {
    melodica(p) {
      const t = st.t, g = inst.group;
      waistMatrix(p, _gw);
      const a = instPoint(g, 0.15, 0.35 + 0.12 * Math.sin(t * 6), 0.2);
      armIK(p, -1, a.x, a.y, a.z, d, -0.2);
      waistMatrix(p, _gw);
      const b = instPoint(g, 0, -0.75, -0.1);
      armIK(p, 1, b.x, b.y, b.z, d, 0.1);
      p[NEC * 3] += 0.12;
    },
    darbuka(p) {
      const t = st.t, g = inst.group;
      waistMatrix(p, _gw);
      const a = instPoint(g, 0.45, 0.1, 0);
      armIK(p, 1, a.x, a.y, a.z, d, 0.2);
      waistMatrix(p, _gw);
      const hit = Math.abs(Math.sin(t * 8.5)), roll = Math.sin(t * 2.1);
      const b = instPoint(g, -0.15 + 0.15 * roll, 0.62 + 0.35 * hit, 0.05);
      armIK(p, -1, b.x, b.y, b.z, d, -0.4 * hit);
      R(p, NEC, p[NEC * 3] + 0.15, p[NEC * 3 + 1] + 0.25, 0.1 * roll);
    },
    kazoo(p) {
      const t = st.t;
      waistMatrix(p, _gw);
      const m = waistPt(-0.35, d.neckY + 0.55, 1.15);
      armIK(p, -1, m.x, m.y + 0.03 * Math.sin(t * 5), m.z, d, 0.9);
      R(p, NEC, p[NEC * 3] - 0.05, p[NEC * 3 + 1], 0.06 * Math.sin(t * 2.4));
    },
    shofar(p) {
      const t = st.t, g = inst.group;
      waistMatrix(p, _gw);
      const a = instPoint(g, 0, 0.25, 0);
      armIK(p, -1, a.x, a.y, a.z, d, 0);
      waistMatrix(p, _gw);
      const b = instPoint(g, 0, 1.1, 0.25);
      armIK(p, 1, b.x, b.y, b.z, d, 0);
      // a long blast: chin up, chest out, a slight tremble
      R(p, NEC, p[NEC * 3] - 0.3, p[NEC * 3 + 1], 0.02 * Math.sin(t * 13));
      R(p, WAI, p[WAI * 3] - 0.08, p[WAI * 3 + 1], p[WAI * 3 + 2]);
    },
    keyboard(p) {
      const t = st.t, g = inst.group;
      waistMatrix(p, _gw);
      const a = instPoint(g, -0.75 + 0.12 * Math.sin(t * 1.7), 0.25, 0.1);
      armIK(p, 1, a.x, a.y + 0.04 * Math.abs(Math.sin(t * 6)), a.z, d, -0.2);
      waistMatrix(p, _gw);
      const b = instPoint(g, 0.45 + 0.3 * Math.sin(t * 2.3), 0.25, 0.1);
      armIK(p, -1, b.x, b.y + 0.05 * Math.abs(Math.sin(t * 7.3)), b.z, d, -0.2);
      p[NEC * 3] += 0.2;
    },
  };

  // ---- carrying things for the story (round 5) ---------------------------------------------------
  // setCarry('two'): both hands round something held in front (a box, a cake, a crate); props
  //   attach to anchors.carry. setCarry('phone'): looking at a phone in the right hand.
  //   setCarry('phoneEar'): on a call, phone at the right ear. setCarry('drumsBack'): a drum kit
  //   strapped on the back, hands on the straps. setCarry(null): hands free.
  const carryAnchor = group0(J.waist, 'carryAnchor', 0, 0.85, torsoFrontZ() + 0.75);
  const phone = new THREE.Group();
  phone.name = 'phone';
  {
    const ph = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.8, 0.08), mat('#1d1d24'));
    const sc = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.66, 0.02), mat('#7fe0d6'));
    sc.position.z = 0.05;
    phone.add(ph, sc);
    phone.visible = false;
    J.wrR.add(phone);
  }
  let backKit = null;
  function group0(parent, name, x, y, z) { const g = new THREE.Group(); g.name = name; g.position.set(x, y, z); parent.add(g); return g; }
  function torsoFrontZ() { const belly = cfg.body?.belly ?? 0; return (1.15 + belly * 0.3) / 2 + belly * 0.1; }
  function setCarry(kind = null) {
    st.carry = kind || null;
    phone.visible = kind === 'phone' || kind === 'phoneEar';
    if (phone.visible) {
      if (kind === 'phone') { phone.position.set(0, -0.6, 0.35); phone.rotation.set(-1.0, 0, 0); }
      else { phone.position.set(0.05, -0.55, 0.2); phone.rotation.set(0, 0, 0); }
    }
    if (kind === 'drumsBack' && !backKit) {
      backKit = buildDrumKit(style.drumKit ? style.drumKit.color : '#c2405a');
      backKit.group.scale.setScalar(0.55);
      backKit.group.position.set(0, -0.55, -0.6 - torsoFrontZ());
      backKit.group.rotation.y = Math.PI;
      J.waist.add(backKit.group);
    }
    if (backKit) backKit.group.visible = kind === 'drumsBack';
  }
  function carryPose(p) {
    const c = st.carry, t = st.t;
    waistMatrix(p, _gw);
    const f = torsoFrontZ();
    if (c === 'two') {
      for (const s of [1, -1]) { const h = waistPt(s * 0.8, 0.85, f + 0.75); armIK(p, s, h.x, h.y, h.z, d, 0); waistMatrix(p, _gw); }
      R(p, WAI, p[WAI * 3] - 0.06, p[WAI * 3 + 1] * 0.4, p[WAI * 3 + 2]); // leaning back a touch under the load
    } else if (c === 'phone') {
      const h = waistPt(-0.35, 1.25, f + 0.85);
      armIK(p, -1, h.x, h.y, h.z, d, 0.4);
      R(p, NEC, 0.35, p[NEC * 3 + 1] * 0.3, 0);
    } else if (c === 'phoneEar') {
      const h = waistPt(-0.95, d.neckY + 0.75, 0.25);
      armIK(p, -1, h.x, h.y, h.z, d, 1.1);
      R(p, NEC, p[NEC * 3], p[NEC * 3 + 1], -0.12 + 0.04 * Math.sin(t * 0.9));
    } else if (c === 'drumsBack') {
      for (const s of [1, -1]) { const h = waistPt(s * 0.5, 1.3, f + 0.35); armIK(p, s, h.x, h.y, h.z, d, 0.3); waistMatrix(p, _gw); }
      R(p, WAI, p[WAI * 3] + 0.12, p[WAI * 3 + 1] * 0.5, p[WAI * 3 + 2]);
    }
  }

  // slung on the back while walking, in the hands while playing
  function placeInstrument() {
    if (!inst) return;
    const g = inst.group;
    if (INST_PLAY[inst.kind] || inst.kind === 'kazoo') {
      // round-5 instruments rest where rig.js built them (at the hip, the kazoo in the hand)
      const P = st.playing && st.playing !== 'drums' ? INST_PLAY[inst.kind] : null;
      g.rotation.order = 'XYZ';
      if (P) { g.position.set(P.pos[0], P.pos[1], P.pos[2]); g.rotation.set(P.rot[0], P.rot[1], P.rot[2]); }
      else { g.position.copy(inst.playPos); g.rotation.copy(inst.playRot); }
      return;
    }
    if (st.playing && st.playing !== 'drums') {
      if (inst.kind === 'violin') { g.rotation.order = 'YXZ'; g.position.set(0.85, 1.45, 0.7); g.rotation.set(-1.25, 0.6, 0.35); }
      else if (inst.kind === 'flute') { g.rotation.order = 'XYZ'; g.position.set(-0.95, 2.05, 0.95); g.rotation.set(0, 0, Math.PI / 2); }
      else { g.rotation.order = 'XYZ'; g.position.copy(inst.playPos); g.rotation.copy(inst.playRot); }
    } else {
      g.rotation.order = 'XYZ';
      const big = inst.kind === 'guitar' || inst.kind === 'electricGuitar';
      g.position.set(big ? 0.35 : 0.15, big ? 0.3 : 0.8, -0.95);
      g.rotation.set(0, Math.PI, big ? -0.75 : 0.6);
    }
    if (inst.bow) inst.bow.visible = st.playing === true;
  }
  placeInstrument();

  // Busker: left hand on the neck, right hand strumming over the sound hole, head nodding.
  const _gm = new THREE.Matrix4(), _gv = new THREE.Vector3(), _gw = new THREE.Matrix4();
  function guitarPoint(lx, ly, lz) {
    const g = rig.guitar;
    _gm.compose(g.position, g.quaternion, _one);
    return _gv.set(lx, ly, lz).applyMatrix4(_gm).applyMatrix4(_gw);
  }
  function guitarPose(p) {
    const t = st.t;
    const N = rig.guitar.userData.neck || [0.1, 2.25, 0.3], S = rig.guitar.userData.strum || [0, 0.35, 0.55];
    waistMatrix(p, _gw);
    const n = guitarPoint(N[0], N[1], N[2]);
    armIK(p, 1, n.x, n.y, n.z, d, 0.3);
    waistMatrix(p, _gw);
    const strum = Math.sin(t * 9.5);
    const s = guitarPoint(S[0] + 0.18 * strum, S[1], S[2]);
    armIK(p, -1, s.x, s.y, s.z, d, -0.3);
    p[NEC * 3] += 0.08 + 0.06 * Math.sin(t * 4.75);
  }

  // ---- emotes ----------------------------------------------------------------------------------
  const EMOTES = { wave: 2.4, argue: 3.4, swing: 0.9, photo: 2.8, toast: 2.0, drink: 2.2, ollie: 0.9 };
  function emotePose(p, name, t) {
    if (name === 'toast' || name === 'drink') {
      const hy = p[PY] + d.waistY + d.neckY + d.headY * 0.8;
      if (name === 'toast') armIK(p, -1, -0.55, hy + 0.1 + 0.1 * Math.sin(t * 6) * (t < 0.8 ? 1 : 0), 1.7, d, 0);
      else { armIK(p, -1, -0.25, hy - 0.55, 0.95, d, -0.6 - 0.5 * smooth(0.5, 1.2, t)); R(p, NEC, -0.25 * smooth(0.5, 1.2, t), 0, 0); }
      return;
    }
    if (name === 'ollie') {
      // crouch, pop, knees up in the air, land soft
      const k = t / EMOTES.ollie;
      const crouch = k < 0.25 ? smooth(0, 0.25, k) : 1 - smooth(0.25, 0.35, k);
      const tuck = k > 0.3 && k < 0.85 ? Math.sin(((k - 0.3) / 0.55) * Math.PI) : 0;
      R(p, WAI, p[WAI * 3] + 0.25 * crouch, p[WAI * 3 + 1], p[WAI * 3 + 2]);
      for (const s of [1, -1]) R(p, s > 0 ? SHL : SHR, -0.3 - 0.4 * tuck, 0, s * (0.7 + 0.5 * tuck));
      return;
    }
    if (name === 'photo') {
      // camera up to the right eye, left hand steadying it, head still
      const hy = p[PY] + d.waistY + d.neckY + d.headY * 0.8;
      armIK(p, -1, -0.3, hy - 0.3, 1.35, d, 0);
      armIK(p, 1, 0.55, hy - 0.45, 1.3, d, 0);
      R(p, NEC, -0.04, 0, 0);
      return;
    }
    if (name === 'swing') {
      // matkot forehand: wind back, snap forward across the body, follow through
      const k = t / EMOTES.swing;
      const a = k < 0.35 ? lerp(0, 1, smooth(0, 0.35, k)) : lerp(1, -1, smooth(0.35, 0.6, k));
      R(p, SHR, 0.6 * a - 0.9, 0.5 * a, -0.5 - 0.25 * Math.abs(a));
      R(p, ELR, -0.6 + 0.2 * a, 0, 0);
      R(p, WRR, 0, 0, 0);
      R(p, WAI, p[WAI * 3], -0.35 * a, p[WAI * 3 + 2]);
      return;
    }
    if (name === 'wave') {
      R(p, SHR, -0.15, 0, -2.6);
      R(p, ELR, -0.3, 0, 0.5 * Math.sin(t * 11) - 0.1);
      R(p, WRR, 0, 0, 0.2 * Math.sin(t * 11 - 0.6));
      R(p, NEC, p[NEC * 3] - 0.05, p[NEC * 3 + 1] * 0.3, 0.14);
      R(p, WAI, p[WAI * 3], p[WAI * 3 + 1], 0.06);
      return;
    }
    // argue: palms-up "ma?!" shrug, then the bunched-fingers "rega, rega" hand with the other on the hip
    const A = 1 - smooth(1.3, 1.65, t);
    const pump = Math.pow(Math.sin(t * 7), 2);
    const a = newPoseCache;
    a.set(p);
    R(a, SHL, -0.5, 0.45, 0.5);
    R(a, ELL, -1.2 - 0.3 * pump, 0, 0);
    R(a, WRL, 0, 0, 0.5);
    R(a, SHR, -0.5, -0.45, -0.5);
    R(a, ELR, -1.2 - 0.3 * pump, 0, 0);
    R(a, WRR, 0, 0, -0.5);
    a[SHRUG] = 0.22 * pump;
    R(a, WAI, -0.08, 0, 0.05 * Math.sin(t * 3));
    R(a, NEC, -0.12, 0.1 * Math.sin(t * 2), 0.22 * Math.sin(t * 2.6));
    const b = newPoseCache2;
    b.set(p);
    R(b, SHR, -0.55, -0.25, -0.15);
    R(b, ELR, -2.15 + 0.2 * Math.sin(t * 15), 0, 0);
    R(b, WRR, 0.35, 0, 0);
    R(b, SHL, 0.15, -1.45, 0.75);
    R(b, ELL, -1.55, 0, 0);
    R(b, WRL, 0, 0, 0);
    b[SHRUG] = 0.08;
    R(b, WAI, -0.04, -0.15, -0.05);
    R(b, NEC, -0.05 + 0.07 * Math.sin(t * 8), -0.1, -0.16);
    lerpPose(p, b, a, A);
  }
  const newPoseCache = newPose();
  const newPoseCache2 = newPose();

  // ---- application -------------------------------------------------------------------------------
  function applyPose(p) {
    for (let j = 0; j < JOINTS.length; j++) jointObjs[j].rotation.set(p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
    J.pelvis.position.set(p[PX], p[PY], p[PZ]);
    J.shL.position.y = J.shR.position.y = d.shY + p[SHRUG];
  }

  function setFace(expr) {
    if (expr === st.expr) return;
    st.expr = expr;
    rig.faceMat.map = faceTexture(cfg.face, cfg.skin, expr);
  }

  const _w = new THREE.Vector3();
  const _w2 = new THREE.Vector3();
  const _lv = new THREE.Vector3();

  function trackMotion(dt) {
    root.updateWorldMatrix(true, false);
    const e = root.matrixWorld.elements;
    _w.setFromMatrixPosition(root.matrixWorld);
    const yaw = Math.atan2(e[8], e[10]);
    if (st.prevPos && dt > 0) {
      const vx = (_w.x - st.prevPos.x) / dt, vz = (_w.z - st.prevPos.z) / dt;
      const vF = vx * Math.sin(yaw) + vz * Math.cos(yaw);
      let dy = yaw - st.prevYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      // teleports and spawn jumps would explode the springs: clamp
      st.accF = damp(st.accF, clamp((vF - st.vF) / dt, -60, 60), 12, dt);
      st.vF = vF;
      st.yawRate = damp(st.yawRate, clamp(dy / dt, -6, 6), 10, dt);
    } else st.prevPos = new THREE.Vector3();
    st.prevPos.copy(_w);
    st.prevYaw = yaw;
  }

  function updateJiggles(dt) {
    const steps = Math.max(1, Math.ceil(dt / 0.016));
    const h = dt / steps;
    const turn = st.yawRate * Math.max(st.speed, 2);
    for (const jg of rig.jiggles) {
      const tx = jg.restX + clamp(-st.accF * 0.012 * jg.gainF + st.accV * 0.02 * jg.gainV + st.speed * 0.012 * jg.gainF, -0.9, 0.9);
      const tz = jg.restZ + clamp(turn * 0.02 * jg.gainF, -0.6, 0.6);
      for (let i = 0; i < steps; i++) {
        jg.vx += (-70 * (jg.x - tx) - 6 * jg.vx) * h;
        jg.vz += (-70 * (jg.z - tz) - 6 * jg.vz) * h;
        jg.x += jg.vx * h;
        jg.z += jg.vz * h;
      }
      jg.obj.rotation.x = jg.x;
      jg.obj.rotation.z = jg.z;
    }
  }

  function updateProps(dt, p) {
    const vehicle = st.mode === 'scooter' || st.mode === 'bike' || st.mode === 'car' || st.mode === 'sit';
    for (const o of rig.hideInVehicle) o.visible = !vehicle;
    // playing seated (a bench session): the instrument stays in the hands
    if (inst && st.mode === 'sit' && st.playing && st.playing !== 'drums') inst.group.visible = true;
    st.propT = Math.min(1, st.propT + dt / 0.4);
    const pop = Math.max(0.001, easeOutBack(st.propT));
    scooter.group.visible = st.mode === 'scooter';
    bike.group.visible = st.mode === 'bike';
    scooter.group.scale.setScalar(pop);
    bike.group.scale.setScalar(pop);
    const dist = (st.speed * dt) / worldScale; // body units travelled
    for (const w of scooter.wheels) w.rotation.x += dist / scooter.wheelR;
    for (const w of bike.wheels) w.rotation.x += dist / bike.wheelR;
    bike.crank.rotation.x = st.crank;
    for (const pd of bike.pedals) pd.rotation.x = -pd.parent.rotation.x - st.crank;
    // skirt / long coat follows the thighs
    if (rig.bell) {
      const mean = (p[HIPL * 3] + p[HIPR * 3]) / 2;
      const b = rig.bell.obj;
      b.rotation.x = mean * 0.85 + st.jBell;
      b.scale.y = lerp(1, 0.55, clamp(-mean / 1.4, 0, 1));
    }
    if (stroller && stroller.group.visible) for (const w of stroller.wheels) w.rotation.x += dist / stroller.wheelR;
    if (board) {
      board.group.visible = st.mode === 'skate';
      const em = st.emote && st.emote.name === 'ollie' ? st.emote.t / EMOTES.ollie : -1;
      const air = em > 0.25 && em < 0.95 ? Math.sin(((em - 0.25) / 0.7) * Math.PI) : 0;
      body.position.y = st.physAir ? 0 : air * 1.5 * (worldScale / BODY_SCALE);
      board.deck.rotation.x = em > 0.2 && em < 0.6 ? -0.45 * Math.sin(((em - 0.2) / 0.4) * Math.PI) : 0;
      if (st.mode === 'skate') for (const w of board.wheels || []) w.rotation.x += dist / SKATE.wheelR;
    }
    if (kit) {
      const on = st.playing === 'drums' && st.mode === 'sit';
      kit.group.visible = on;
      for (const s2 of sticks) s2.visible = on;
    }
    if (dog && dog.group.visible) {
      const a = smooth(0.3, 2.5, st.speed);
      st.dogPhase += dt * (4 + st.speed * 1.3) * a;
      dog.legs.forEach((l, i) => { l.rotation.x = Math.sin(st.dogPhase + (i === 0 || i === 3 ? 0 : Math.PI)) * 0.6 * a; });
      dog.torso.position.y = 1.13 + Math.abs(Math.sin(st.dogPhase)) * 0.06 * a;
      dog.tail.rotation.y = Math.sin(st.t * (a > 0.5 ? 9 : 13)) * 0.55;
      dog.head.rotation.y = (1 - a) * 0.45 * Math.sin(st.t * 0.6 + st.seedPhase);
      dog.head.rotation.x = (1 - a) * (0.1 + 0.25 * Math.max(0, Math.sin(st.t * 0.45))); // sniffing
      // leash: owner's left hand to the collar
      body.updateMatrixWorld(true);
      J.handL.getWorldPosition(_w2);
      body.worldToLocal(_w2);
      const c = dog.collar;
      _lv.set(dog.group.position.x + c.x - _w2.x, c.y - _w2.y, dog.group.position.z + c.z - _w2.z);
      const len = _lv.length();
      leash.position.copy(_w2);
      leash.quaternion.setFromUnitVectors(_UP, _lv.multiplyScalar(1 / (len || 1)));
      leash.scale.set(1, len, 1);
    }
    if (trolley && trolley.group.visible) {
      body.updateMatrixWorld(true);
      J.handR.getWorldPosition(_w2);
      body.worldToLocal(_w2);
      const dy = Math.max(0.3, _w2.y - trolley.wheelR);
      const dz = Math.sqrt(Math.max(0, TROLLEY_LEN * TROLLEY_LEN - dy * dy));
      trolley.group.position.set(_w2.x - 0.15, trolley.wheelR, _w2.z - dz - trolley.handleZ * 0.5);
      trolley.frame.rotation.x = Math.atan2(dz, dy);
      for (const w of trolley.wheels) w.rotation.x += dist / trolley.wheelR;
    }
  }
  st.jBell = 0;
  st.jBellV = 0;

  function update(dt, speed = 0, o = null) {
    dt = clamp(dt || 0, 0, 0.1);
    // the player's own jump physics lifts the whole avatar; the ollie then only pops the board
    st.physAir = !!(o && o.airborne);
    st.t += dt;
    st.speed = damp(st.speed, Math.max(0, speed), 8, dt);
    trackMotion(dt);

    // gait / vehicle clocks
    const v = st.speed;
    if (st.mode === 'walk') {
      const run = smooth(walkSpeed * 1.05, runSpeed, v);
      const vb = v / worldScale; // body units per second
      st.gaitC = gaitCycle(vb, run);
      st.gaitVb = vb;
      st.phase += (2 * Math.PI * vb * dt) / st.gaitC;
    } else st.phase += dt * 2;
    if (st.mode === 'scooter') {
      const c = st.kick % 1;
      const coasting = v > runSpeed * 1.1 && c > 0.88;
      if (v > 0.3 && !coasting) st.kick += dt * clamp(0.45 + v * 0.03, 0.5, 0.95);
      else if (c < 0.9 && c > 0) st.kick += dt * 0.9; // finish the current kick before resting
    }
    st.crank += ((v * dt) / worldScale / BIKE.wheelR) / 1.6;
    // push clock (2 s a cycle) while pushing; otherwise finish the current push and glide
    if (st.mode === 'skate') { const c = st.push % 1; if (v > 0.3 && st.skatePush !== false) st.push += dt / 2.0; else if (c > 0 && c < 0.999 && c < 0.6) st.push += dt / 2.0; }

    // idle look-around
    st.lookTimer -= dt;
    if (st.lookTimer < 0) {
      st.lookTimer = 1.5 + Math.random() * 3;
      st.lookTarget = Math.random() < 0.4 ? 0 : (Math.random() - 0.5) * 1.1;
    }
    st.lookYaw = damp(st.lookYaw, st.lookTarget, 3, dt);

    // pose: mode pose, crossfaded from the snapshot taken at the last mode change
    const p = st.a;
    modePose(p, st.mode, dt);
    if (st.fade < 1) {
      st.fade = Math.min(1, st.fade + dt / 0.35);
      const f = st.fade * st.fade * (3 - 2 * st.fade);
      lerpPose(p, st.snap, p, f);
    }

    // emote layer
    let talking = false, happy = false, emoteFace = null;
    if (st.emote) {
      const em = st.emote;
      em.t += dt;
      const dur = EMOTES[em.name];
      if (em.t >= dur) st.emote = null;
      else {
        const w = smooth(0, 0.25, em.t) * (1 - smooth(dur - 0.4, dur, em.t));
        const ep = st.b;
        ep.set(p);
        emotePose(ep, em.name, em.t);
        lerpJoints(p, ep, w, UPPER);
        p[SHRUG] += (ep[SHRUG] - p[SHRUG]) * w;
        talking = em.name === 'argue' && w > 0.3;
        happy = em.name === 'wave' && w > 0.3;
        if (w > 0.3 && em.name === 'toast') emoteFace = 'laugh';
        else if (w > 0.3 && (em.name === 'photo' || em.name === 'drink')) emoteFace = 'smile';
      }
    }

    // secondary motion: torso follow-through on acceleration, vertical bob feeding the jiggles
    const torsoTarget = clamp(-st.accF * 0.01, -0.25, 0.25);
    st.torsoV += (-60 * (st.torso - torsoTarget) - 7 * st.torsoV) * dt;
    st.torso += st.torsoV * dt;
    p[WAI * 3] += st.torso;
    p[NEC * 3] -= st.torso * 0.5;
    const vPY = (p[PY] - st.prevPY) / Math.max(dt, 1e-3);
    st.accV = damp(st.accV, clamp((vPY - st.vPY) / Math.max(dt, 1e-3), -40, 40), 15, dt);
    st.vPY = vPY;
    st.prevPY = p[PY];
    st.jBellV += (-80 * (st.jBell - clamp(-st.accF * 0.006 + st.accV * 0.004, -0.3, 0.3)) - 7 * st.jBellV) * dt;
    st.jBell += st.jBellV * dt;

    // lean into turns (bikes and scooters lean much more than feet)
    const k = st.mode === 'bike' ? 0.04 : st.mode === 'scooter' ? 0.03 : st.mode === 'walk' ? 0.012 : 0;
    const maxLean = st.mode === 'bike' ? 0.35 : st.mode === 'scooter' ? 0.28 : 0.12;
    st.lean = damp(st.lean, clamp(-st.yawRate * v * k, -maxLean, maxLean), 6, dt);
    lean.rotation.z = st.lean;

    st.cur.set(p);
    applyPose(p);
    updateProps(dt, p);
    updateJiggles(dt);

    // face: talking > a held expression > emote faces > blink > resting face
    st.blink -= dt;
    if (st.blink < -0.13) st.blink = 2 + Math.random() * 3.5;
    if (st.exprT > 0) { st.exprT -= dt; if (st.exprT <= 0) st.exprName = null; }
    let expr = st.restFace;
    // a spoken line flaps between open and rounded mouths, with short closed pauses between words
    if (talking || st.talking) expr = Math.sin(st.t * 21) > -0.2 ? (Math.sin(st.t * 3.1) > 0.85 ? 'neutral' : 'talk') : 'talk2';
    else if (st.exprName) expr = st.exprName;
    else if (emoteFace) expr = emoteFace;
    else if (happy) expr = 'happy';
    else if (st.blink < 0) expr = 'blink';
    setFace(expr);
  }

  function setMode(mode) {
    if (!AVATAR_MODES.includes(mode)) {
      console.warn('[avatar] unknown mode', mode);
      return;
    }
    if (mode === st.mode) return;
    st.snap.set(st.cur);
    st.fade = 0;
    st.mode = mode;
    st.propT = mode === 'scooter' || mode === 'bike' ? 0 : 1;
    if (mode === 'scooter') st.kick = 0.92;
    if (mode === 'skate') { ensureBoard(); st.push = 0.999; }
  }
  // skate options: { push } false = cruise without pushing (on a ramp, in the bowl, at speed)
  function setSkate(o = {}) {
    if (o.push !== undefined) st.skatePush = !!o.push;
  }

  // Faces: express('smile' | 'laugh' | 'surprised' | 'happy', seconds) holds an expression;
  // setTalking(true) animates the mouth for a spoken line until set false; setRestFace picks the
  // resting face ('neutral' or 'smile'); setDetail(false) hides small parts on far LODs.
  function express(name, secs = 1.5) {
    st.exprName = name || null;
    st.exprT = secs;
  }
  function setTalking(on) {
    st.talking = !!on;
  }
  function setRestFace(name) {
    st.restFace = name === 'smile' ? 'smile' : 'neutral';
  }
  let detailOn = true;
  function setDetail(on) {
    if (!!on === detailOn) return;
    detailOn = !!on;
    for (const o of rig.detail) o.visible = detailOn;
  }

  // Car driving targets from the engine, in world units relative to the avatar's origin:
  // { grips: [[x, y, z] left, right], pedals: [[x, y, z] left, right] } (pedal = sole on the floor).
  // null drops back to the generic seated pose.
  function setDrive(t) {
    if (!t) { st.drive = null; return; }
    const k = 1 / worldScale, cv = (q) => [q[0] * k, q[1] * k, q[2] * k];
    st.drive = { grips: t.grips.map(cv), pedals: t.pedals.map(cv) };
  }

  function setSeat(h, o = {}) {
    if (Number.isFinite(h) && h > 0) st.seatH = h;
    st.table = !!o.table;
  }
  function setPlaying(on) {
    st.playing = on === 'drums' ? (kit ? 'drums' : false) : !!on;
    if (st.playing === 'drums') st.seatH = DRUMS.stool * worldScale;
    if (inst) inst.group.visible = st.playing !== 'drums';
    placeInstrument();
  }
  function setWorkout(kind, rep = 0) {
    st.workout = kind || null;
    st.rep = rep;
  }
  function setHeld(kind) {
    if (kind === st.held) return;
    st.held = kind || null;
    if (st.heldMesh) { st.heldMesh.removeFromParent(); st.heldMesh = null; }
    const def = HELD[kind];
    if (!def) return;
    const g = new THREE.Group();
    g.position.set(0, -0.5, 0.35);
    for (const [rt, rb, h, color, y] of def) {
      const key = rt + ',' + rb + ',' + h;
      let geo = heldGeo.get(key);
      if (!geo) heldGeo.set(key, (geo = new THREE.CylinderGeometry(rt, rb, h, 10)));
      const m = new THREE.Mesh(geo, mat(color));
      m.position.y = y;
      m.castShadow = true;
      g.add(m);
    }
    J.wrR.add(g);
    st.heldMesh = g;
  }
  function setHold(side) {
    st.hold = side > 0 ? 1 : side < 0 ? -1 : 0;
  }

  function emote(name) {
    if (!EMOTES[name]) {
      console.warn('[avatar] unknown emote', name);
      return false;
    }
    st.emote = { name, t: 0 };
    return true;
  }

  update(0, 0);

  return {
    group: root,
    setMode,
    setSkate,
    setCarry,
    anchors: { carry: carryAnchor, phone },
    update,
    emote,
    setSeat,
    setDrive,
    setHold,
    setPlaying,
    setHeld,
    setWorkout,
    express,
    setTalking,
    setRestFace,
    setDetail,
    get mode() {
      return st.mode;
    },
    archetype: cfg.id,
    config: cfg,
    height: (DIMS.hipY + DIMS.waistY + DIMS.neckY + DIMS.headY + 0.8) * worldScale,
    // in 'car' mode the seat surface sits this far above the avatar's origin
    seatHeight: (1.3 - 0.11) * worldScale,
    joints: J,
  };
}
