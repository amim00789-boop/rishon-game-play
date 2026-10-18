// A surfer on the wave field: the board, the avatar on it, and the physics shared by the player
// and the friends. Inputs per frame: { paddle, steer (-1 left .. 1 right), pump (pressed), jump (pressed) }.
// States: paddle (prone, moving), sit (waiting), catch (paddling for a wave), pop (standing up),
// ride, air, wipe (tumbling, then floating), done (back to prone after a ride).
import * as THREE from 'three';
import { buildBoard, BOARD } from './board.js';
import { newPose, blendPose, copyPose, avatarDims, pronePose, sitPose, stancePose, airPose, tumblePose, applySurfPose } from './poses.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (c, t, r, dt) => c + (t - c) * (1 - Math.exp(-r * dt));

export const RIDE = {
  G: 30,            // slope pull
  drag: 0.32,
  maxS: 34, minS: 5,
  turn: 2.5,        // rad/s at full steer
  paddle: 9,        // paddling speed
  leanLimit: 1,     // |lean| above this for leanGrace seconds = wipeout
  leanGrace: 0.3,
  pump: 2.6,
  face: 12,         // the wave's push on a rider who is on its face
};

export class Rider {
  // av: an avatar (createAvatar) or null for a board alone; look: board colours key
  constructor({ field, scene, av, look = 'player', name = 'player', spray = null, skill = 1 }) {
    this.field = field;
    this.name = name;
    this.skill = skill;
    this.spray = spray;
    this.group = new THREE.Group();
    this.group.name = 'surfer-' + name;
    this.group.rotation.order = 'YXZ';
    this.tilt = new THREE.Group();           // board pitch/roll on the water
    this.tilt.rotation.order = 'YXZ';
    this.board = buildBoard(look);
    this.tilt.add(this.board);
    this.group.add(this.tilt);
    this.av = av;
    this.dims = av ? avatarDims(av) : null;
    if (av) this.tilt.add(av.group);
    scene.add(this.group);
    this.pose = newPose(); this.poseA = newPose(); this.poseB = newPose(); this.poseSnap = newPose();
    this.blendT = 1;
    this.reset(0, 0, 0);
  }
  // Place in the frame at (u, v) facing world yaw, state 'sit' unless given.
  reset(u, v, yaw, state = 'sit') {
    this.u = u; this.v = v;
    const w = this.field.frame.world(u, v);
    this.x = w.x; this.z = w.z;
    this.y = this.field.seaY;
    this.vy = 0;
    this.yaw = yaw;
    this.S = 0;
    this.lean = 0; this.leanOver = 0;
    this.stroke = Math.random() * 6;
    this.state = state;
    this.stateT = 0;
    this.wave = null;
    this.spin = 0; this.airT = 0;
    this.pumpK = 0;
    this.carveAcc = 0;
    this.events = [];
    this.roll = 0; this.pitch = 0;
    this.tumble = { rx: 0, rz: 0, sink: 0 };
    this.cheer = 0;
    this.look = 0;
    this.blendT = 1;
    this.sample = { h: 0, gu: 0, gv: 0, foam: 0, wave: null, x: 0, b: 0 };
  }
  setState(s) {
    if (s === this.state) return;
    copyPose(this.poseSnap, this.pose);
    this.blendT = 0;
    this.state = s;
    this.stateT = 0;
  }
  emit(type, data = {}) { this.events.push({ type, ...data }); }
  get forward() { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }

  update(dt, inp) {
    const F = this.field, fr = F.frame, s = this.sample;
    this.stateT += dt;
    fr.local(this.x, this.z, this);
    F.sample(this.u, this.v, s);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    // world gradient of the water and the slope along the heading (+ = uphill)
    const gx = fr.nx * s.gu + fr.sx * s.gv, gz = fr.nz * s.gu + fr.sz * s.gv;
    const up = gx * fx + gz * fz;
    const st = this.state;

    if (st === 'paddle' || st === 'catch' || st === 'done') {
      // paddling for a wave is slower than the wave, so it catches up and lifts the board
      const want = inp.paddle ? (st === 'catch' ? 3.6 : RIDE.paddle) : 0;
      this.S = damp(this.S, want, inp.paddle ? 2.2 : 1.2, dt);
      this.yaw = wrap(this.yaw - (inp.steer || 0) * 1.7 * dt);
      if (inp.paddle) this.stroke += dt * 5.2;
      let vx = fx * this.S, vz = fz * this.S;
      // whitewater pushes a paddler back toward the beach
      if (s.b > 0.5 && s.x > -6 && s.x < 10 && s.h > 0.6) {
        const c = s.wave ? s.wave.c : 8;
        vx -= fr.nx * c * 0.9; vz -= fr.nz * c * 0.9;
        if (Math.random() < dt * 10 && this.spray) this.spray.emit(this.x, this.y + 0.6, this.z, 0, 4, 0, 2, 2, 0.6);
      }
      this.x += vx * dt; this.z += vz * dt;
      this.y = F.seaY + s.h;
      this.pitch = damp(this.pitch, -Math.atan(up) * 0.8, 8, dt);
      this.roll = damp(this.roll, 0, 4, dt);
    } else if (st === 'sit') {
      this.S = damp(this.S, 0, 1.5, dt);
      this.x += fx * this.S * dt; this.z += fz * this.S * dt;
      this.yaw = wrap(this.yaw - (inp.steer || 0) * 1.2 * dt);
      this.y = F.seaY + s.h;
      this.pitch = damp(this.pitch, -Math.atan(up) * 0.8 - 0.18, 6, dt);
      this.roll = damp(this.roll, Math.sin(this.stateT * 1.1) * 0.04, 4, dt);
    } else if (st === 'pop' || st === 'ride') {
      this.ride(dt, inp, s, fx, fz, up);
    } else if (st === 'air') {
      this.air(dt, inp, s);
    } else if (st === 'wipe') {
      this.wipe(dt, s);
    }
    fr.local(this.x, this.z, this);
    // nobody paddles up the sand: the swash line is a soft wall
    if (this.u < 7) {
      const k = 7 - this.u;
      this.x += fr.nx * k; this.z += fr.nz * k; this.u = 7;
    }
    this.pose_(dt, inp);
    this.place();
  }

  ride(dt, inp, s, fx, fz, up) {
    const F = this.field, fr = F.frame;
    const w = this.wave || s.wave;
    if (w) this.wave = w;
    const x = w ? this.u - w.u : 99;
    const fw = w ? w.frontW() : 8;
    // "hold": the face carries a rider who is on it (as the water climbs it); off the face
    // (far below or over the back) the wave leaves the rider behind or rolls on past
    const hold = w ? smooth(-fw * 2.4, -fw * 1.3, x) * (1 - smooth(-0.5, 2.5, x)) : 0;
    this.hold = hold;
    const popping = this.state === 'pop';
    const steer = popping ? 0 : clamp(inp.steer || 0, -1, 1);
    const turn = RIDE.turn * (0.75 + 0.25 * this.skill) * (1.15 - clamp(this.S / 60, 0, 0.45));
    const prevYaw = this.yaw;
    this.yaw = wrap(this.yaw - steer * turn * dt);
    const dyaw = Math.abs(wrap(this.yaw - prevYaw));
    // speed: pulled down the slope, kept up by the face, slowed by drag
    const faceSteep = clamp(s.gu, 0, 1.2);
    let aS = -RIDE.G * up + RIDE.face * hold * faceSteep - RIDE.drag * this.S;
    if (inp.pump && hold > 0.25 && this.pumpCd <= 0) { this.S += RIDE.pump * (0.5 + hold * 0.7); this.pumpK = 1; this.pumpCd = 0.32; this.emit('pump'); }
    this.pumpCd = (this.pumpCd || 0) - dt;
    this.pumpK = damp(this.pumpK, 0, 6, dt);
    this.S = clamp(this.S + aS * dt, RIDE.minS, RIDE.maxS);
    if (popping) this.S = Math.max(this.S, 9);
    const c = w ? w.c : 8;
    const vx = Math.sin(this.yaw) * this.S - fr.nx * c * hold;
    const vz = Math.cos(this.yaw) * this.S - fr.nz * c * hold;
    this.x += vx * dt; this.z += vz * dt;
    this.y = F.seaY + s.h;
    // lean builds while carving hard at speed; too far = wipeout
    // (holding one turn for more than about a second at speed tips you over)
    const leanT = steer * (0.55 + this.S / 30);
    this.lean = damp(this.lean, leanT, 2.2, dt);
    this.leanOver = Math.abs(this.lean) > RIDE.leanLimit ? this.leanOver + dt : 0;
    // carve score: degrees turned at speed while leaning
    if (Math.abs(steer) > 0.3 && this.S > 11) {
      this.carveAcc += dyaw * this.S * 3.2;
      if (this.spray && Math.random() < dt * 30) {
        const side = Math.sign(steer);
        this.spray.emit(this.x - Math.cos(this.yaw) * side * 0.8, this.y + 0.3, this.z + Math.sin(this.yaw) * side * 0.8,
          -Math.cos(this.yaw) * side * 6 + vx * 0.3, 5 + this.S * 0.18, Math.sin(this.yaw) * side * 6 + vz * 0.3, 3, 1.5, 0.7);
      }
    } else if (this.carveAcc > 0) {
      if (this.carveAcc > 35) this.emit('carve', { points: Math.round(this.carveAcc) });
      this.carveAcc = 0;
    }
    // board attitude: follow the water's slope along and across, plus the carve lean
    const sx = Math.cos(this.yaw), sz = -Math.sin(this.yaw);
    const gx = fr.nx * s.gu + fr.sx * s.gv, gz = fr.nz * s.gu + fr.sz * s.gv;
    const across = gx * sx + gz * sz;
    this.pitch = damp(this.pitch, -Math.atan(up), 10, dt);
    this.roll = damp(this.roll, Math.atan(across) * 0.9 - this.lean * 0.55, 10, dt);
    if (popping) {
      if (this.stateT > 0.45) { this.setState('ride'); this.emit('popped'); }
      return;
    }
    this.rideT = (this.rideT || 0) + dt;
    // air: off the top of the face with some speed, going up it
    if (inp.jump && this.S > 11 && x > -fw * 1.1 && up > 0.05 && this.stateT > 0.8) {
      this.vy = 6 + this.S * 0.2 + smooth(-fw * 0.6, 0, x) * 4;
      this.vel = { x: vx, z: vz };
      this.spin = 0; this.airT = 0; this.airYaw0 = this.yaw;
      this.setState('air');
      if (this.spray) this.spray.emit(this.x, this.y + 0.3, this.z, vx * 0.4, 7, vz * 0.4, 14, 2.5, 0.9);
      this.emit('jump');
      return;
    }
    // endings
    const b = w ? w.brokenAt(this.v) : 0;
    if (this.leanOver > RIDE.leanGrace) return this.fall('lean');
    if (b > 0.6 && x > -fw * 2.4) return this.fall(x > -3 ? 'falls' : 'caught');
    if (x > 3.5) return this.finish('back');
    if (!w || w.u < 26) return this.finish('inside');
  }

  air(dt, inp, s) {
    this.airT += dt;
    this.vy -= 30 * dt;
    this.y += this.vy * dt;
    // the wave keeps rolling under; the rider keeps its momentum
    this.x += this.vel.x * dt; this.z += this.vel.z * dt;
    const spinRate = 5.2 * clamp(inp.steer || 0, -1, 1);
    this.yaw = wrap(this.yaw - spinRate * dt);
    this.spin += Math.abs(spinRate * dt);
    this.pitch = damp(this.pitch, 0.15, 4, dt);
    this.roll = damp(this.roll, 0, 4, dt);
    const ground = this.field.seaY + s.h;
    if (this.y <= ground && this.vy < 0) {
      this.y = ground;
      // a clean landing faces anywhere but straight up the back of the wave
      const fr = this.field.frame;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const facingSea = fx * fr.nx + fz * fr.nz;
      if (facingSea > 0.72) return this.fall('landing');
      const spins = Math.floor((this.spin + 0.6) / Math.PI) / 2; // completed half turns as turns
      // every further air on the same wave is worth a little less (no hop-spamming)
      const points = Math.round((180 + this.airT * 380 + spins * 2 * 220) * Math.pow(0.7, this.airs || 0));
      this.airs = (this.airs || 0) + 1;
      this.emit('air', { points, airT: this.airT, spins });
      this.S = Math.max(this.S * 0.85, 10);
      this.vy = 0;
      if (this.spray) this.spray.emit(this.x, this.y + 0.2, this.z, 0, 6, 0, 16, 3, 0.8);
      this.setState('ride');
    }
  }

  fall(reason) {
    this.setState('wipe');
    this.tumble = { rx: 0, rz: 0, sink: 0, dir: Math.random() < 0.5 ? 1 : -1 };
    this.vel = { x: Math.sin(this.yaw) * this.S * 0.5, z: Math.cos(this.yaw) * this.S * 0.5 };
    if (this.carveAcc > 35) this.emit('carve', { points: Math.round(this.carveAcc) });
    this.carveAcc = 0;
    if (this.spray) this.spray.emit(this.x, this.y + 0.5, this.z, this.vel.x * 0.3, 8, this.vel.z * 0.3, 26, 4, 1.1);
    this.emit('wipe', { reason });
  }
  finish(reason) {
    if (this.carveAcc > 35) this.emit('carve', { points: Math.round(this.carveAcc) });
    this.carveAcc = 0;
    this.emit('finish', { reason });
    this.lean = 0;
    this.setState('done');
    this.S = 3;
  }

  wipe(dt, s) {
    const T = this.tumble;
    const k = this.stateT;
    this.vel.x *= Math.exp(-2 * dt); this.vel.z *= Math.exp(-2 * dt);
    // whitewater drags the swimmer shoreward a little
    const fr = this.field.frame;
    const push = s.b > 0.4 ? 5 : 0;
    this.x += (this.vel.x - fr.nx * push) * dt; this.z += (this.vel.z - fr.nz * push) * dt;
    T.rx = Math.min(Math.PI * 0.55, k * 4.5);
    T.rz = T.dir * Math.min(1.2, k * 3);
    T.sink = Math.min(1.6, k * 2.4) - Math.max(0, k - 1.1) * 1.2;
    this.y = this.field.seaY + s.h;
    this.pitch = damp(this.pitch, 0, 3, dt);
    this.roll = damp(this.roll, T.dir * 1.2, 3, dt);
    if (k > 1.9) this.emit('wipeDone');
  }

  // ---- visuals ----
  pose_(dt, inp) {
    const av = this.av, d = this.dims;
    if (!av) return;
    const t = (this._t = (this._t || 0) + dt);
    const p = this.poseA;
    const st = this.state;
    this.cheer = damp(this.cheer, 0, 1.2, dt);
    if (st === 'paddle' || st === 'catch' || st === 'done') pronePose(p, d, t, this.stroke, inp.paddle ? 1 : 0.4 * (st === 'done' ? 0 : 1));
    else if (st === 'sit') sitPose(p, d, t, this.look, this.cheer);
    else if (st === 'pop') {
      // pop-up: from the prone press to the stance in one move
      const k = smooth(0, 0.45, this.stateT);
      pronePose(this.poseB, d, t, Math.PI * 1.1, 0);
      stancePose(p, d, t, 0.85, 0, 0);
      blendPose(p, this.poseB, p, k);
    } else if (st === 'ride') stancePose(p, d, t, 0.38 + (inp.paddle ? 0.3 : 0), clamp(this.lean, -1.3, 1.3), this.pumpK, this.cheer);
    else if (st === 'air') airPose(p, d, t, smooth(0, 0.25, this.airT));
    else if (st === 'wipe') tumblePose(p, d, t);
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / 0.25);
      const f = this.blendT * this.blendT * (3 - 2 * this.blendT);
      if (st !== 'pop') blendPose(p, this.poseSnap, p, f);
    }
    copyPose(this.pose, p);
  }
  // Apply the pose after av.update (the owner calls this once the avatar has animated).
  applyPose() {
    if (!this.av) return;
    applySurfPose(this.av, this.pose);
    if (this.state === 'wipe') {
      this.av.group.position.y -= this.tumble.sink;
      this.av.group.rotation.x += this.tumble.rx * 0.6;
    }
  }

  // Stand up on wave w (the catch succeeded).
  // dir (+1 / -1 along the shore, optional): which way to angle the take-off. A rider pointing
  // straight at the beach is turned 40 degrees that way, so the drop ends on the face, not the flats.
  popUp(w, dir = 0) {
    const fr = this.field.frame, d = fr.dirOf(this.yaw);
    const side = dir || Math.sign(d.dv) || w.goodSide || 1;
    if (Math.abs(d.dv) < 0.55) this.yaw = fr.yawOf(-0.77, 0.64 * side);
    this.wave = w;
    this.rideT = 0;
    this.airs = 0;
    this.carveAcc = 0;
    this.lean = 0; this.leanOver = 0;
    this.S = Math.max(this.S, 10);
    this.setState('pop');
  }

  place() {
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
    this.tilt.rotation.set(this.pitch, 0, this.roll);
    if (this.state === 'wipe') {
      const T = this.tumble;
      // the rider goes over, the board pops loose and floats
      this.tilt.rotation.z = this.roll;
      this.board.rotation.set(0, 0, T.dir * Math.min(Math.PI, this.stateT * 5));
      this.board.position.set(T.dir * Math.min(2.5, this.stateT * 4), Math.max(0, Math.sin(Math.min(Math.PI, this.stateT * 3)) * 2), 0);
    } else if (this.board.position.lengthSq() > 0 || this.board.rotation.z) {
      this.board.position.set(0, 0, 0);
      this.board.rotation.set(0, 0, 0);
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.board.traverse((o) => { if (o.geometry && o.geometry.type === 'TorusGeometry') o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
}
