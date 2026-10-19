// A skater in the pool (world/skatebowl.js), in bowl-local space (y up from the floor).
// The board rolls only along its heading: gravity along the slope, pumping on the transitions,
// pushing on the flat, carving with A/D. Up the wall past the coping it launches straight up
// (the last few degrees of the wall count as vert), flies, and must land with the board along the
// fall line, nose or tail first. In the air: kickflip, grab, spin (180 / 360). The coping and the
// flat bar can be ground (grind) with a balance needle.
//
//   const r = new Rider(spec, av);   r.update(dt, inp);   r.events -> drained by the session
//   inp = { pump, brake, steer (-1 left .. 1 right), ollie, flip, grind (pressed), grab (held) }
// Events: { type: 'trick', id, pts, secs?, height? } | { type: 'land', fakie, clean } |
//         { type: 'bail', reason } | { type: 'grind', on } | { type: 'pop' } | { type: 'bonk' } | { type: 'up' }
import * as THREE from 'three';
import { bowlHeight, bowlE, copingAt } from '../../world/skatebowl.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const SK = {
  G: 30,            // gravity, units/s^2 (the avatar is ~5 units tall)
  maxS: 23,
  roll: 0.35, drag: 0.0022,
  pump: 20,         // extra pull down a transition while W is held
  push: 9, pushMax: 10,
  brake: 14,
  turn: 2.6,        // rad/s at full steer
  fall: 1.8,        // the slope turns a rider down the fall line
  ollie: 9,
  lipPop: 4,        // Space just before the lip
  spin: 6.4,        // rad/s in the air
  flipDur: 0.42,
  landTol: 0.95,    // radians off the fall line that still land
  grindFric: 2.2,
  bailSecs: 1.5,
};

const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _up = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _wup = new THREE.Vector3(0, 1, 0);

export class Rider {
  constructor(spec, av, parent) {
    this.s = spec;
    this.group = new THREE.Group();
    this.group.name = 'skater';
    this.tilt = new THREE.Group();
    this.group.add(this.tilt);
    this.av = av || null;
    if (av) {
      this.avSaved = { pos: av.group.position.clone(), rot: av.group.rotation.clone() };
      av.group.position.set(0, 0, 0);
      av.group.rotation.set(0, 0, 0);
      this.tilt.add(av.group);
      try { av.setMode && av.setMode('skate'); } catch (_) { /* optional */ }
      this.board = av.group.getObjectByName('skateboard');
    }
    parent.add(this.group);
    this.upV = new THREE.Vector3(0, 1, 0);
    this.events = [];
    this.reset(0, 0, Math.PI / 2);
  }

  // Standing on the floor or the deck at (x, z), facing yaw `psi`.
  reset(x, z, psi, state = 'ride') {
    const S = bowlHeight(this.s, x, z) || { h: this.s.H };
    this.x = x; this.z = z; this.y = S.h;
    this.psi = psi; this.sp = 0;
    this.V = new THREE.Vector3();
    this.state = state;
    this.flipT = 0; this.flipN = 0; this.grabT = 0; this.grabbing = false; this.spinAcc = 0;
    this.airT = 0; this.airY0 = 0; this.airPeak = 0; this.fromLip = false;
    this.ollieBuf = 0; this.grindBuf = 0;
    this.grind = null; this.bal = 0; this.balV = 0;
    this.bailT = 0; this.pushing = false;
    this.upV.set(0, 1, 0);
  }

  get fwd() { return { x: Math.sin(this.psi), z: Math.cos(this.psi) }; }
  get speed() { return this.state === 'air' ? this.V.length() : this.state === 'grind' ? Math.abs(this.grind.v) : Math.abs(this.sp); }

  emit(e) { this.events.push(e); }

  update(dt, inp) {
    this.ollieBuf = inp.ollie ? 0.28 : Math.max(0, this.ollieBuf - dt);
    this.grindBuf = inp.grind ? 0.3 : Math.max(0, this.grindBuf - dt);
    const n = 4, h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.state === 'ride') this.ride(h, inp, i === 0);
      else if (this.state === 'air') this.air(h, inp, i === 0);
      else if (this.state === 'grind') this.grindStep(h, inp, i === 0);
      else if (this.state === 'bail') this.bailStep(h);
    }
  }

  // ---- rolling on the surface ----
  ride(h, inp, first) {
    const s = this.s;
    let S = bowlHeight(s, this.x, this.z);
    if (!S) { this.reset(0, 0, this.psi); return; }
    const d = this.fwd;
    const m = S.gx * d.x + S.gz * d.z;            // slope along the board
    const c = 1 / Math.sqrt(1 + m * m);
    const sg = this.sp >= 0 ? 1 : -1;
    let a = -SK.G * m * c;
    // pump: W while the line of travel goes down a transition
    if (inp.pump && sg * m < -0.08) a += sg * SK.pump * Math.min(1.4, Math.abs(m)) * c;
    // push on the flat when slow
    this.pushing = !!inp.pump && Math.abs(m) < 0.06 && Math.abs(this.sp) < SK.pushMax && S.zone !== 'wall';
    if (this.pushing) a += (Math.abs(this.sp) < 0.3 ? 1 : sg) * SK.push;
    if (inp.brake) a -= sg * SK.brake * (Math.abs(this.sp) > 0.5 ? 1 : Math.abs(this.sp) * 2);
    a -= sg * (SK.roll + SK.drag * this.sp * this.sp) * (Math.abs(this.sp) > 0.2 ? 1 : 0);
    this.sp = clamp(this.sp + a * h, -SK.maxS, SK.maxS);
    // carving, and a quick pivot (kickturn) when slow
    const slow = Math.abs(this.sp) < 3.5;
    this.psi -= (inp.steer || 0) * SK.turn * (slow ? 1.6 : 1) * h;
    // the wall turns a diagonal line back down the fall line
    const gl = Math.hypot(S.gx, S.gz);
    if (gl > 0.05 && Math.abs(this.sp) > 0.4) {
      const ux = sg * d.x, uz = sg * d.z, dn = Math.atan2(-S.gx, -S.gz), cur = Math.atan2(ux, uz);
      this.psi += Math.sin(wrap(dn - cur)) * SK.fall * Math.min(1, gl) * h;
    }
    // move along the board's line
    const d2 = this.fwd;
    const px = this.x, pz = this.z, py = this.y;
    const hx = d2.x * this.sp * c * h, hz = d2.z * this.sp * c * h;
    this.x += hx; this.z += hz;
    let N = bowlHeight(s, this.x, this.z);
    if (!N) { this.x = px; this.z = pz; this.sp *= -0.3; this.emit({ type: 'bonk' }); return; }
    const pred = S.h + m * this.sp * c * h;
    // a step up (the kicker's side, the bar) stops the board
    if (N.h - pred > 0.3 || this.crossesRail(pz, this.z, this.x, py)) {
      this.x = px; this.z = pz; this.sp *= -0.35; this.emit({ type: 'bonk' }); return;
    }
    // a drop (the kicker's lip) or the coping launches
    const vy = this.sp * m * c;
    const { e } = bowlE(s, this.x, this.z);
    if (N.zone === 'wall' && e >= s.Ec - 0.03 && vy > 0) { this.launchLip(N, vy); return; }
    if (N.h < py + vy * h - 0.22 && Math.abs(this.sp) > 3) {
      this.V.set(d2.x * this.sp * c, Math.max(0, vy), d2.z * this.sp * c);
      this.takeOff(false);
      return;
    }
    this.y = N.h;
    // ollie on the flat (and low on the transitions)
    if (this.ollieBuf > 0 && gl < 0.7) {
      this.ollieBuf = 0;
      this.V.set(d2.x * this.sp * c, vy + SK.ollie, d2.z * this.sp * c);
      this.y += 0.05;
      this.takeOff(false);
      return;
    }
    if (this.grindBuf > 0 && N.zone === 'wall' && e > s.Ec - 1.6) this.tryGrind();
  }

  crossesRail(z0, z1, x, y) {
    const r = this.s.rail;
    if (x < r.x0 - 0.2 || x > r.x1 + 0.2 || y > r.y - 0.1) return false;
    return (z0 - r.z) * (z1 - r.z) <= 0 && z0 !== z1;
  }

  launchLip(N, vy) {
    const s = this.s;
    const cp = copingAt(s, this.x, this.z);
    const d = this.fwd;
    const c = 1 / Math.sqrt(1 + (N.gx * d.x + N.gz * d.z) ** 2);
    const hx = d.x * this.sp * c, hz = d.z * this.sp * c;
    const vt = hx * cp.tx + hz * cp.tz;
    // straight up off the vert, drifting a little back in
    this.V.set(cp.tx * vt - cp.nx * 1.3, vy + (this.ollieBuf > 0 ? SK.lipPop : 0), cp.tz * vt - cp.nz * 1.3);
    if (this.ollieBuf > 0) { this.ollieBuf = 0; this.emit({ type: 'pop' }); }
    const p = bowlE(s, this.x, this.z);
    if (p.e > s.Ec - 0.05) { this.x -= p.nx * (p.e - s.Ec + 0.05); this.z -= p.nz * (p.e - s.Ec + 0.05); }
    this.y = s.H;
    this.takeOff(true);
  }

  takeOff(lip) {
    this.state = 'air';
    this.fromLip = lip;
    this.airT = 0; this.airY0 = this.y; this.airPeak = this.y;
    this.spinAcc = 0; this.flipT = 0; this.flipN = 0; this.grabT = 0; this.grabbing = false;
    if (this.av && this.av.emote) { try { this.av.emote('ollie'); } catch (_) { /* optional */ } }
  }

  // ---- flying ----
  air(h, inp, first) {
    const s = this.s;
    this.airT += h;
    this.V.y -= SK.G * h;
    this.x += this.V.x * h; this.y += this.V.y * h; this.z += this.V.z * h;
    this.airPeak = Math.max(this.airPeak, this.y);
    // spin with A/D
    const dpsi = -(inp.steer || 0) * SK.spin * h;
    this.psi += dpsi; this.spinAcc += dpsi;
    // kickflip: one press, one flip; the next press waits for the board to come round
    if (first && inp.flip && this.flipT === 0) this.flipT = 1e-4;
    if (this.flipT > 0) {
      this.flipT += h;
      if (this.flipT >= SK.flipDur) { this.flipT = 0; this.flipN++; this.emit({ type: 'trick', id: 'kickflip', pts: 250 }); }
    }
    // grab: held
    if (inp.grab) { this.grabbing = true; this.grabT += h; }
    else if (this.grabbing) this.endGrab();
    // the pool's solid parts: the deck block under the coping, the outside
    const p = bowlE(s, this.x, this.z);
    if (p.e > s.Ec + s.deck) { this.x -= p.nx * (p.e - s.Ec - s.deck + 0.05); this.z -= p.nz * (p.e - s.Ec - s.deck + 0.05); const vn = this.V.x * p.nx + this.V.z * p.nz; if (vn > 0) { this.V.x -= vn * p.nx * 1.3; this.V.z -= vn * p.nz * 1.3; } }
    else if (p.e > s.Ec - 0.02 && this.y < s.H - 0.05) {
      const k = p.e - s.Ec + 0.05;
      this.x -= p.nx * k; this.z -= p.nz * k;
      const vn = this.V.x * p.nx + this.V.z * p.nz;
      if (vn > 0) { this.V.x -= vn * p.nx * 1.4; this.V.z -= vn * p.nz * 1.4; }
    }
    if (this.grindBuf > 0) { if (this.tryGrind()) return; }
    const S = bowlHeight(s, this.x, this.z);
    if (S && this.y <= S.h && this.V.y <= 0) this.land(S);
  }

  endGrab() {
    if (this.grabT >= 0.18) this.emit({ type: 'trick', id: 'grab', pts: Math.round(120 + 180 * this.grabT), secs: this.grabT });
    this.grabbing = false; this.grabT = 0;
  }

  land(S) {
    const s = this.s;
    this.y = S.h;
    // a flip still turning under the feet is a bail
    if (this.flipT > 0.12 && this.flipT < SK.flipDur - 0.05) return this.bail('flip');
    if (this.grabbing) this.endGrab();
    const gl = Math.hypot(S.gx, S.gz), vh = Math.hypot(this.V.x, this.V.z);
    let ax, az;
    if (gl > 0.7) { ax = -S.gx / gl; az = -S.gz / gl; }
    else if (vh > 2) { ax = this.V.x / vh; az = this.V.z / vh; }
    else { const d = this.fwd; ax = d.x; az = d.z; }
    const d = this.fwd;
    const dot = d.x * ax + d.z * az;
    const off = Math.acos(clamp(Math.abs(dot), 0, 1));
    if (off > SK.landTol) return this.bail('landing');
    // straighten onto the line, nose or tail first
    this.psi = dot >= 0 ? Math.atan2(ax, az) : Math.atan2(-ax, -az);
    const n = this.fwd, m = S.gx * n.x + S.gz * n.z, c = 1 / Math.sqrt(1 + m * m);
    this.sp = clamp(this.V.x * n.x * c + this.V.y * m * c + this.V.z * n.z * c, -SK.maxS, SK.maxS);
    // keep some speed from a straight drop onto a steep wall
    if (Math.abs(this.sp) < 0.6 * this.V.length() && gl > 0.7) this.sp = Math.sign(this.sp || -1) * this.V.length() * 0.85;
    this.state = 'ride';
    const spun = Math.abs(this.spinAcc);
    if (spun > Math.PI * 1.8) this.emit({ type: 'trick', id: 'spin360', pts: 650 });
    else if (spun > Math.PI * 0.8) this.emit({ type: 'trick', id: 'spin180', pts: 300 });
    const height = this.airPeak - this.airY0;
    if (this.fromLip && height > 0.6) this.emit({ type: 'trick', id: 'air', pts: Math.round(100 + 35 * height), height });
    else if (!this.fromLip && this.airT > 0.35) this.emit({ type: 'trick', id: 'ollie', pts: Math.round(50 + 25 * Math.max(0, height)), height });
    this.emit({ type: 'land', fakie: this.sp < 0, clean: off < 0.35 });
  }

  // ---- grinding: the coping or the flat bar ----
  tryGrind() {
    const s = this.s, r = s.rail;
    const inAir = this.state === 'air';
    const vx = inAir ? this.V.x : this.fwd.x * this.sp, vz = inAir ? this.V.z : this.fwd.z * this.sp;
    // the flat bar
    if (inAir && this.x > r.x0 - 0.3 && this.x < r.x1 + 0.3 && Math.abs(this.z - r.z) < 1.5 && this.y > r.y - 0.4 && this.y < r.y + 2.6) {
      let v = vx;
      if (Math.abs(v) < 5) v = (Math.sign(v) || (this.fwd.x >= 0 ? 1 : -1)) * 6;
      this.startGrind({ kind: 'rail', v });
      this.x = clamp(this.x, r.x0, r.x1); this.z = r.z; this.y = r.y + 0.08;
      this.psi = v > 0 ? Math.PI / 2 : -Math.PI / 2;
      return true;
    }
    // the coping
    const cp = copingAt(s, this.x, this.z);
    const dh = Math.hypot(cp.x - this.x, cp.z - this.z);
    if (dh < 1.8 && this.y > s.H - 1.8 && this.y < s.H + 3.2) {
      let v = vx * cp.tx + vz * cp.tz;
      if (Math.abs(v) < 4) { const d = this.fwd; v = (Math.sign(d.x * cp.tx + d.z * cp.tz) || 1) * 6.5; }
      this.startGrind({ kind: 'coping', v });
      this.x = cp.x; this.z = cp.z; this.y = s.H + 0.1;
      this.psi = Math.atan2(cp.tx * Math.sign(v), cp.tz * Math.sign(v));
      return true;
    }
    return false;
  }
  startGrind(g) {
    if (this.state === 'air') { if (this.grabbing) this.endGrab(); this.flipT = 0; }
    this.state = 'grind';
    this.grind = { ...g, t: 0 };
    this.grindBuf = 0;
    this.bal = (Math.random() - 0.5) * 0.2; this.balV = (Math.random() - 0.5) * 0.4;
    this.emit({ type: 'grind', on: true });
  }
  grindStep(h, inp, first) {
    const s = this.s, g = this.grind;
    g.t += h;
    g.v -= Math.sign(g.v) * SK.grindFric * h;
    // balance: an unstable needle the player keeps in the middle with A/D
    this.balV += (Math.random() - 0.5) * 9 * h + this.bal * 2.2 * h - (inp.steer || 0) * 5.5 * h;
    this.balV *= 1 - 0.8 * h;
    this.bal += this.balV * h;
    if (Math.abs(this.bal) > 1) return this.bail('balance');
    if (g.kind === 'rail') {
      const r = s.rail;
      this.x += g.v * h;
      if (this.x < r.x0 || this.x > r.x1) { this.endGrind(); this.V.set(g.v, 3, 0); this.takeOff(false); return; }
    } else {
      const cp0 = copingAt(s, this.x, this.z);
      this.x += cp0.tx * g.v * h; this.z += cp0.tz * g.v * h;
      const cp = copingAt(s, this.x, this.z);
      this.x = cp.x; this.z = cp.z;
      this.psi = Math.atan2(cp.tx * Math.sign(g.v), cp.tz * Math.sign(g.v));
    }
    const out = (first && (inp.ollie || inp.grind)) || Math.abs(g.v) < 2.5;
    if (!out) return;
    this.endGrind();
    if (g.kind === 'rail') { this.V.set(g.v, 4, 0); this.takeOff(false); return; }
    // hop back into the pool, turning toward the fall line so the landing is clean
    const cp = copingAt(s, this.x, this.z), sv = Math.sign(g.v);
    this.x -= cp.nx * 0.5; this.z -= cp.nz * 0.5; this.y = s.H + 0.2;
    this.V.set(cp.tx * g.v * 0.6 - cp.nx * 3, 3.5, cp.tz * g.v * 0.6 - cp.nz * 3);
    this.psi = Math.atan2(-cp.nx + cp.tx * sv * 0.35, -cp.nz + cp.tz * sv * 0.35);
    this.takeOff(false);
    this.fromLip = true; this.airY0 = this.y;
  }
  endGrind() {
    const g = this.grind;
    if (g && g.t > 0.15) this.emit({ type: 'trick', id: g.kind === 'rail' ? 'grindRail' : 'grind', pts: Math.round(150 + 140 * g.t), secs: g.t });
    this.emit({ type: 'grind', on: false });
    this.grind = null;
  }

  // ---- falling ----
  bail(reason) {
    this.state = 'bail';
    this.bailT = 0;
    this.grabbing = false; this.flipT = 0;
    if (this.grind) { this.emit({ type: 'grind', on: false }); this.grind = null; }
    this.emit({ type: 'bail', reason });
    if (this.av && this.av.express) { try { this.av.express('surprised', 1.2); } catch (_) { /* optional */ } }
  }
  bailStep(h) {
    const s = this.s;
    this.bailT += h;
    // slide down to the floor
    const S = bowlHeight(s, this.x, this.z);
    if (S) {
      const gl = Math.hypot(S.gx, S.gz);
      if (gl > 0.05 && this.y <= S.h + 0.05) { this.x -= (S.gx / gl) * 6 * h; this.z -= (S.gz / gl) * 6 * h; }
      const S2 = bowlHeight(s, this.x, this.z) || S;
      this.y = Math.max(S2.h, this.y - 18 * h);
    }
    if (this.bailT > SK.bailSecs) {
      // climb out onto the nearer long deck and drop straight back in
      const side = this.z >= 0 ? 1 : -1;
      this.reset(clamp(this.x, -s.fx + 2, s.fx - 2), side * (s.fz + s.Ec + 0.45), side > 0 ? Math.PI : 0);
      this.sp = 3.5;
      this.emit({ type: 'up' });
    }
  }

  // ---- the avatar on the board ----
  applyPose(dt) {
    const s = this.s;
    this.group.position.set(this.x, this.y, this.z);
    // up = the surface normal on the ground, easing back to upright in the air
    let tx = 0, ty = 1, tz = 0;
    if (this.state === 'ride' || this.state === 'bail') {
      const S = bowlHeight(s, this.x, this.z);
      if (S) { const l = Math.hypot(S.gx, 1, S.gz); tx = -S.gx / l; ty = 1 / l; tz = -S.gz / l; }
    }
    const rate = this.state === 'air' ? 3.2 : 16;
    const k = 1 - Math.exp(-rate * dt);
    this.upV.set(this.upV.x + (tx - this.upV.x) * k, this.upV.y + (ty - this.upV.y) * k, this.upV.z + (tz - this.upV.z) * k).normalize();
    _up.copy(this.upV);
    _f.set(Math.sin(this.psi), 0, Math.cos(this.psi));
    _f.addScaledVector(_up, -_f.dot(_up));
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1);
    _f.normalize();
    _r.crossVectors(_up, _f).normalize();
    _m.makeBasis(_r, _up, _f);
    this.group.quaternion.setFromRotationMatrix(_m);
    // bail: tip over
    const tip = this.state === 'bail' ? Math.min(1, this.bailT * 3) * (1 - Math.max(0, this.bailT - SK.bailSecs + 0.35) / 0.35) : 0;
    this.tilt.rotation.set(0, 0, tip * 1.35);
    this.tilt.position.y = -tip * 0.9;
    const av = this.av;
    if (!av) return;
    try {
      // the player's own update may have put the avatar back on its feet this frame
      if (av.mode !== 'skate' && av.setMode) av.setMode('skate');
      av.setSkate && av.setSkate({ push: this.pushing });
      av.update(dt, this.state === 'air' ? 0 : this.speed, { airborne: this.state === 'air' });
    } catch (_) { /* optional */ }
    const J = av.joints;
    // grab: crouch and reach the right hand down to the board's toe edge
    if (J && this.grabbing && this.state === 'air') {
      const g = Math.min(1, this.grabT * 7);
      if (J.shR) { J.shR.rotation.x = -0.2 + 0.9 * g; J.shR.rotation.z = -0.35 - 0.25 * g; }
      if (J.elR) J.elR.rotation.x = -0.25 * g;
      if (J.waist) J.waist.rotation.x += 0.45 * g;
      if (J.knL) J.knL.rotation.x += 0.7 * g;
      if (J.knR) J.knR.rotation.x += 0.7 * g;
      if (J.hipL) J.hipL.rotation.x -= 0.6 * g;
      if (J.hipR) J.hipR.rotation.x -= 0.6 * g;
    }
    // kickflip: the board rolls a full turn about its length, around the deck's middle
    if (this.board) {
      const a = this.flipT > 0 ? (this.flipT / SK.flipDur) * Math.PI * 2 : 0;
      const c = 0.5;
      this.board.rotation.z = a;
      this.board.position.x = c * Math.sin(a);
      this.board.position.y = c - c * Math.cos(a) + (this.flipT > 0 ? 0.45 * Math.sin((this.flipT / SK.flipDur) * Math.PI) : 0);
    }
  }

  dispose() {
    const av = this.av;
    if (av && this.board) { this.board.rotation.z = 0; this.board.position.set(0, 0, 0); }
    if (av && this.avSaved) { av.group.position.copy(this.avSaved.pos); av.group.rotation.copy(this.avSaved.rot); }
    this.av = null;
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
