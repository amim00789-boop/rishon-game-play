// The four friends as surfers: looks for the water (board shorts, no instruments) and a small
// brain each. Malul surfs the best (long, stylish rides, airs and spins), Ofir is good too (a few
// airs), Dekel and Adir are decent (shorter rides, the odd soft wipeout they laugh off).
import { SURF } from './waves.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const FRIENDS = {
  malul: { skill: 1.0, gain: 2.6, airChance: 0.55, spinChance: 0.45, wobble: 0.0, wipeChance: 0.03, rideLen: [12, 18], weave: 2.3, catchOdds: 0.97, lineup: 13 },
  ofir: { skill: 0.86, gain: 2.3, airChance: 0.28, spinChance: 0.08, wobble: 0.1, wipeChance: 0.1, rideLen: [8, 13], weave: 1.9, catchOdds: 0.9, lineup: -22 },
  dekel: { skill: 0.62, gain: 1.8, airChance: 0.04, spinChance: 0, wobble: 0.35, wipeChance: 0.28, rideLen: [4, 8], weave: 1.3, catchOdds: 0.72, lineup: 24 },
  adir: { skill: 0.62, gain: 1.9, airChance: 0.08, spinChance: 0, wobble: 0.3, wipeChance: 0.26, rideLen: [4.5, 8.5], weave: 1.4, catchOdds: 0.74, lineup: -42 },
};
export const FRIEND_IDS = ['malul', 'ofir', 'dekel', 'adir'];

// Avatar config overrides for the water: the archetype's face, hair and skin stay, the
// instruments and shoes come off, everyone is in board shorts.
const SHORTS = { malul: '#22252b', ofir: '#2ec4b6', dekel: '#ffcb3d', adir: '#3d5f8f' };
// barefoot: the flip-flop sole in the archetype's skin colour (characters/archetypes.js)
const SKIN = { malul: '#d39a6e', ofir: '#a8673e', dekel: '#f2cfb1', adir: '#c48a5c' };
export function surfLook(id) {
  const keep = { dekel: [{ type: 'kippah', color: '#ffffff', ring: '#2e86de', ring2: '#ffcb3d' }], adir: [{ type: 'watch', color: '#d8d8d8' }] };
  return {
    archetype: id,
    accessories: keep[id] || [],
    pants: { kind: 'shorts', color: SHORTS[id] || '#3d5f8f', belt: null },
    shoes: { kind: 'flipflops', color: SKIN[id] || '#e0ac82', strap: SKIN[id] || '#e0ac82' },
    style: { carry: false, drumKit: null, guitarCase: null },
  };
}

// The brain: drives a Rider through the lineup -> go -> ride -> return loop.
export class FriendBrain {
  constructor(id, rider, field, rnd = Math.random) {
    this.id = id;
    this.p = FRIENDS[id];
    this.rider = rider;
    this.field = field;
    this.rnd = rnd;
    this.mode = 'lineup';
    this.target = null;   // wave to catch
    this.anchorV = 0;     // lineup centre along the shore (follows the player)
    this.dir = 1;
    this.phase = 0;
    this.rideLen = 8;
    this.planAir = false;
    this.spinGoal = 0;
    this.events = [];
  }
  spot() { return { u: SURF.lineup + (this.id === 'malul' ? 6 : 0) + Math.sin(this.p.lineup) * 5, v: this.anchorV + this.p.lineup }; }
  // Assign a wave to go for.
  go(w) { if (this.mode === 'lineup') { this.target = w; this.mode = 'go'; } }
  get free() { return this.mode === 'lineup'; }

  update(dt) {
    const r = this.rider, fr = this.field.frame;
    const inp = { paddle: false, steer: 0, pump: false, jump: false };
    const shoreYaw = fr.yawOf(-1, 0), seaYaw = fr.yawOf(1, 0);
    if (this.mode === 'lineup' || this.mode === 'return') {
      const sp = this.spot();
      const du = sp.u - r.u, dv = sp.v - r.v, dist = Math.hypot(du, dv);
      if (dist > 8) {
        if (r.state !== 'paddle') r.setState('paddle');
        inp.paddle = true;
        inp.steer = this.steerTo(fr.yawOf(du, dv), 1.5);
      } else {
        if (r.state !== 'sit') r.setState('sit');
        inp.steer = this.steerTo(seaYaw, 1);
        if (this.mode === 'return') this.mode = 'lineup';
      }
    } else if (this.mode === 'go') {
      const w = this.target;
      if (!w || w.dead) { this.mode = 'return'; return this.after(r, inp, dt); }
      const x = r.u - w.u;
      if (w.u - r.u < 30) {
        if (r.state !== 'catch') r.setState('catch');
        inp.paddle = true;
        // angle a little toward the side this friend will ride
        this.dir = this.pickDir(w);
        inp.steer = this.steerTo(fr.yawOf(-0.93, 0.36 * this.dir), 2);
      } else {
        if (r.state !== 'sit' && r.state !== 'paddle') r.setState('sit');
        inp.steer = this.steerTo(shoreYaw, 1);
      }
      if (x > -4.2 && x < -1.5 && r.state === 'catch') {
        if (this.rnd() < this.p.catchOdds) {
          r.popUp(w, this.dir);
          this.mode = 'ride';
          this.phase = 0;
          this.rideLen = this.p.rideLen[0] + this.rnd() * (this.p.rideLen[1] - this.p.rideLen[0]);
          this.willWipe = this.rnd() < this.p.wipeChance;
          this.events.push({ type: 'popped' });
        } else { this.mode = 'return'; this.events.push({ type: 'missed' }); }
      } else if (x > 1) this.mode = 'return';
    } else if (this.mode === 'ride') {
      if (r.state === 'ride' || r.state === 'pop') this.rideBrain(dt, inp);
      else if (r.state === 'air') this.airBrain(inp);
      else if (r.state === 'done' || (r.state === 'wipe' && r.stateT > 1.9)) { this.mode = 'return'; r.setState('paddle'); }
    }
    return this.after(r, inp, dt);
  }
  after(r, inp, dt) {
    r.update(dt, inp);
    for (const e of r.events) this.events.push(e);
    r.events.length = 0;
  }
  pickDir(w) {
    if (this._dirFor === w) return this._dir;
    this._dirFor = w;
    // Malul always reads the long side; the others mostly do
    this._dir = this.id === 'malul' || this.rnd() < 0.7 ? w.goodSide : -w.goodSide;
    return this._dir;
  }
  steerTo(yaw, gain) {
    // yaw -= steer * turn: a positive difference needs a negative steer
    return clamp(-wrap(yaw - this.rider.yaw) * gain, -1, 1);
  }
  rideBrain(dt, inp) {
    const r = this.rider, w = r.wave, fr = this.field.frame, p = this.p;
    if (!w) return;
    const fw = w.frontW();
    const x = r.u - w.u;
    this.phase += dt * p.weave;
    let a;
    if (r.rideT > this.rideLen || w.u < 34) a = 1.25; // kick out over the back
    else {
      // weave between the bottom turn and the top turn
      const xt = -fw * (0.58 + 0.42 * Math.cos(this.phase));
      a = clamp(0.32 * (xt - x), -1.0, 1.0);
      // the broken section close behind: straighten out and run
      const edge = w.edgeDist(r.v);
      if (Number.isFinite(edge) && edge < 12 && edge > -2) a = clamp(a, -0.25, 0.25);
    }
    const want = fr.yawOf(Math.sin(a), this.dir * Math.cos(a));
    let steer = this.steerTo(want, p.gain);
    steer += (this.rnd() - 0.5) * p.wobble * 2;
    // good riders keep the lean in check; a planned wipeout lets it go
    if (!this.willWipe && Math.abs(r.lean) > 0.8 && Math.sign(steer) === Math.sign(r.lean)) steer *= 0.2;
    if (this.willWipe && r.rideT > this.rideLen * 0.5) steer = Math.sign(r.lean || 1);
    inp.steer = clamp(steer, -1, 1);
    // pump on the flatter parts of the face
    inp.pump = r.S < 15 && this.rnd() < dt * 3;
    // air at the top of the turn
    const top = Math.cos(this.phase) < -0.6 && x > -fw * 0.8;
    if (top && !this.triedTop) {
      this.triedTop = true;
      if (r.S > 13 && this.rnd() < p.airChance) { inp.jump = true; this.spinGoal = this.rnd() < p.spinChance ? Math.PI * 2 - 0.25 : 0; }
    } else if (Math.cos(this.phase) > 0) this.triedTop = false;
  }
  airBrain(inp) {
    const r = this.rider, fr = this.field.frame;
    if (this.spinGoal && r.spin < this.spinGoal) { inp.steer = this.dir; return; }
    this.spinGoal = 0;
    // come back down facing along the line
    inp.steer = this.steerTo(fr.yawOf(-0.4, this.dir * 0.9), 2.2);
  }
}
