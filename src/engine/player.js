// Player controller: walk / kick scooter / bicycle / car with camera-relative input,
// smooth acceleration and turning, jumping, and sliding collision.
import * as THREE from 'three';
import { MODES, MODE_PARAMS, CAR, createVehicles, animateVehicle, carDriveTargets } from './vehicles.js';

// Terrain is optional: without it (or before main wires city.heightAt) the ground is y = 0.
let terrainGround = () => 0;
import('../world/terrain.js').then((m) => { if (m && m.groundAt) terrainGround = m.groundAt; }).catch(() => {});

const GRAVITY = -48;
const JUMP_V = 17;
// Walking down a slope or off a kerb keeps you glued to the ground up to this drop per step;
// anything deeper (a bridge edge) is a fall.
const SNAP_DOWN = 1.0;

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Player {
  constructor(scene, avatar, collision, spawn) {
    this.root = new THREE.Group();
    this.root.name = 'player';
    scene.add(this.root);
    this.avatar = avatar;
    this.rider = new THREE.Group();
    this.rider.add(avatar.group);
    this.root.add(this.rider);
    // the car's front passenger seat (seatPassenger); empty unless a quest rider is aboard
    this.shotgun = new THREE.Group();
    this.shotgun.name = 'passenger-seat';
    this.root.add(this.shotgun);
    this.passenger = null;
    this.vehicles = createVehicles();
    for (const v of Object.values(this.vehicles)) { v.group.visible = false; this.root.add(v.group); }
    this.collision = collision;
    this.pos = { x: spawn.x, z: spawn.z };
    this.y = 0;
    this.vy = 0;
    this.heading = Math.PI / 2; // facing east, into the city
    this.speed = 0;
    this.turnRate = 0;
    this.steer = 0;
    this.mode = 'walk';
    this.onGround = true;
    this.lean = 0;
    this.listeners = [];
    // The characters module ships its own scooter and bike props and leans the rider itself;
    // the fallback capsule does not, so the engine supplies them.
    this.avatarOwnsProps = !!(avatar.joints || avatar.config);
    this.avatarMode = null;
    // Pitch/roll follow the ground on wheels; YXZ so the tilt is in the vehicle's own frame.
    this.root.rotation.order = 'YXZ';
    this.pitch = 0;
    this.roll = 0;
    this.surface = null;
    this.setMode('walk');
    this.y = this.groundAt(this.pos.x, this.pos.z, Infinity);
  }

  // `fn(x, z, y)` returns the walkable height under (x, z) for someone currently at height y:
  // main.js passes city.heightAt (bridge decks + terrain); without it, terrain only.
  setSurface(fn) {
    this.surface = typeof fn === 'function' ? fn : null;
    this.y = this.groundAt(this.pos.x, this.pos.z, this.y);
  }

  groundAt(x, z, y = this.y) {
    if (this.surface) {
      const h = this.surface(x, z, y);
      if (Number.isFinite(h)) return h;
    }
    return terrainGround(x, z);
  }

  get params() { return MODE_PARAMS[this.mode]; }

  onModeChange(fn) { this.listeners.push(fn); }

  setMode(mode) {
    if (!MODE_PARAMS[mode]) return;
    const prev = this.mode;
    this.mode = mode;
    const ownProp = this.avatarOwnsProps && (mode === 'scooter' || mode === 'bike' || mode === 'skate');
    for (const [k, v] of Object.entries(this.vehicles)) v.group.visible = k === mode && !ownProp;
    const p = MODE_PARAMS[mode];
    if (ownProp) this.rider.position.set(0, 0, 0);
    else if (mode === 'car') {
      // butt on the driver's seat (vehicles.js CAR.seat); the fallback capsule just stands there
      const sh = typeof this.avatar.seatHeight === 'number' ? this.avatar.seatHeight : 0;
      this.rider.position.set(CAR.seat.x, CAR.seat.y - sh, CAR.seat.z);
    }
    else this.rider.position.set(0, p.riderY, p.riderZ);
    // a passenger only exists inside the car; on two wheels or on foot they wait out of sight
    this.shotgun.visible = mode === 'car';
    this.setAvatarMode(mode);
    // A bigger vehicle could spawn inside a wall; nudge it out right away.
    this.collision.resolve(this.pos, p.radius);
    if (prev !== mode) this.speed *= 0.4;
    for (const fn of this.listeners) fn(mode);
  }

  // Seat another avatar (a quest NPC) in the car's front passenger seat, beside the driver. The
  // avatar's group moves into the player's frame until releasePassenger hands it back to the
  // parent it came from; the caller keeps animating it (av.update).
  seatPassenger(av) {
    if (!av || !av.group) return false;
    if (this.passenger && this.passenger !== av) this.releasePassenger();
    const P = CAR.passenger;
    const sh = typeof av.seatHeight === 'number' ? av.seatHeight : 0;
    this.passenger = av;
    this.passengerHome = av.group.parent;
    this.shotgun.add(av.group);
    av.group.position.set(P.x, P.y - sh, P.z);
    av.group.rotation.set(0, 0, 0);
    av.group.visible = true;
    // soles on the floor ahead of the seat, where the driver's pedals are on the other side
    const feet = [1, -1].map((s) => [s * 0.4, 0.68 - (P.y - sh), 1.15]);
    try { av.setMode && av.setMode('car'); av.setPassenger && av.setPassenger({ feet }); } catch (_) { /* optional */ }
    return true;
  }

  // Give the seated avatar back (to the scene, or wherever it was) standing; returns it.
  releasePassenger() {
    const av = this.passenger;
    if (!av) return null;
    this.passenger = null;
    this.shotgun.remove(av.group);
    if (this.passengerHome) this.passengerHome.add(av.group);
    this.passengerHome = null;
    try { av.setPassenger && av.setPassenger(false); av.setMode && av.setMode('idle'); } catch (_) { /* optional */ }
    return av;
  }

  setAvatarMode(m) {
    if (m === this.avatarMode) return;
    this.avatarMode = m;
    try { this.avatar.setMode && this.avatar.setMode(m); } catch (e) { console.warn('[player] avatar.setMode failed', e); }
  }

  cycleMode() { this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); }

  update(dt, input, camYaw) {
    if (input.wasPressed('Digit1', 'Numpad1')) this.setMode('walk');
    if (input.wasPressed('Digit2', 'Numpad2')) this.setMode('scooter');
    if (input.wasPressed('Digit3', 'Numpad3')) this.setMode('bike');
    if (input.wasPressed('Digit4', 'Numpad4')) this.setMode('car');
    if (input.wasPressed('Digit5', 'Numpad5')) this.setMode('skate');
    if (input.wasPressed('KeyE')) this.cycleMode();
    if (input.wasPressed('KeyG') && this.avatar.emote) { try { this.avatar.emote('wave'); } catch (_) { /* optional */ } }

    const p = this.params;
    const { f, r } = input.axis();
    const running = input.isDown('ShiftLeft', 'ShiftRight');
    const prevHeading = this.heading;

    if (this.mode === 'car') {
      // Arcade car: W/S throttle and reverse, A/D steer relative to the car, steering
      // authority grows with speed so it cannot spin on the spot.
      const top = running ? p.run : p.speed;
      let target = f > 0 ? top : f < 0 ? -p.reverse : 0;
      const braking = (f < 0 && this.speed > 0.5) || (f > 0 && this.speed < -0.5);
      const rate = braking ? p.brake : f === 0 ? p.accel * 0.6 : p.accel;
      this.speed += THREE.MathUtils.clamp(target - this.speed, -rate * dt, rate * dt);
      this.steer += (-r - this.steer) * Math.min(1, dt * 8);
      const authority = THREE.MathUtils.clamp(Math.abs(this.speed) / 12, 0, 1) * Math.sign(this.speed);
      this.heading += this.steer * p.turn * authority * dt;
    } else {
      // Camera-relative: W is "away from the camera".
      const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
      const rx = -Math.cos(camYaw), rz = Math.sin(camYaw);
      let dx = fx * f + rx * r, dz = fz * f + rz * r;
      const len = Math.hypot(dx, dz);
      let target = 0;
      if (len > 0.01) {
        dx /= len; dz /= len;
        const want = Math.atan2(dx, dz);
        const diff = wrapAngle(want - this.heading);
        this.heading += THREE.MathUtils.clamp(diff, -p.turn * dt, p.turn * dt);
        // Wheeled modes slow down while turning hard instead of sliding sideways.
        const align = this.mode === 'walk' ? 1 : Math.max(0.25, Math.cos(diff));
        target = (running ? p.run : p.speed) * align;
      }
      const rate = target > this.speed ? p.accel : p.brake;
      this.speed += THREE.MathUtils.clamp(target - this.speed, -rate * dt, rate * dt);
      this.steer = 0;
    }
    this.heading = wrapAngle(this.heading);
    this.turnRate = wrapAngle(this.heading - prevHeading) / Math.max(dt, 1e-4);

    // Move in sub-steps so a fast car never tunnels through a thin wall.
    const dist = this.speed * dt;
    const steps = Math.max(1, Math.ceil(Math.abs(dist) / (p.radius * 0.5)));
    const sx = Math.sin(this.heading) * dist / steps, sz = Math.cos(this.heading) * dist / steps;
    const startX = this.pos.x, startZ = this.pos.z;
    let hit = false;
    // people are solid too (on foot and on small wheels): the crowd pushes the player out of anyone
    // they walk into (src/engine/npcs.js pushOut)
    const crowd = this.mode !== 'car' && typeof window !== 'undefined' && window.__game && window.__game.crowd;
    for (let i = 0; i < steps; i++) {
      this.pos.x += sx; this.pos.z += sz;
      if (crowd && crowd.pushOut) { try { if (crowd.pushOut(this.pos, p.radius * 0.7)) hit = true; } catch (_) { /* optional */ } }
      if (this.collision.resolve(this.pos, p.radius, this.y)) hit = true;
    }
    if (hit && dt > 0) {
      // Keep only the speed that actually happened along the heading: sliding along a wall
      // keeps momentum, a head-on hit stops you.
      const ax = (this.pos.x - startX) / dt, az = (this.pos.z - startZ) / dt;
      const along = ax * Math.sin(this.heading) + az * Math.cos(this.heading);
      this.speed = Math.sign(this.speed) * Math.min(Math.abs(this.speed), Math.abs(along));
    }

    // Jump / gravity over the terrain and bridge decks.
    const ground = this.groundAt(this.pos.x, this.pos.z, this.y);
    if (p.canJump && this.onGround && input.wasPressed('Space')) {
      this.vy = p.jumpV || JUMP_V; this.onGround = false;
      // on the board the jump is an ollie: tail snap, board rising with the feet (avatar.js)
      if (this.mode === 'skate' && this.avatar.emote) { try { this.avatar.emote('ollie'); } catch (_) { /* optional */ } }
    }
    if (this.onGround && this.vy <= 0) {
      // Downhill at speed drops further per step than a walk does; scale the snap with it.
      const snap = SNAP_DOWN + Math.abs(this.speed) * dt * 0.7;
      if (this.y - ground <= snap) { this.y = ground; this.vy = 0; }
      else this.onGround = false; // walked off an edge: fall
    }
    if (!this.onGround) {
      this.vy += GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= ground) { this.y = ground; this.vy = 0; this.onGround = true; }
    }

    this.root.position.set(this.pos.x, this.y, this.pos.z);
    this.root.rotation.y = this.heading;
    // Wheels follow the slope: pitch from front/rear ground, roll (car only) from left/right.
    let pitchT = 0, rollT = 0;
    if (this.mode !== 'walk' && this.onGround) {
      const half = this.mode === 'car' ? CAR.axleZ : this.mode === 'bike' ? 1.75 : this.mode === 'skate' ? 1.0 : 1.55;
      const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
      const yf = this.groundAt(this.pos.x + sh * half, this.pos.z + ch * half, this.y);
      const yr = this.groundAt(this.pos.x - sh * half, this.pos.z - ch * half, this.y);
      pitchT = -Math.atan2(yf - yr, 2 * half);
      if (this.mode === 'car') {
        const w = CAR.trackX; // local +x is the car's left
        const yl = this.groundAt(this.pos.x + ch * w, this.pos.z - sh * w, this.y);
        const yri = this.groundAt(this.pos.x - ch * w, this.pos.z + sh * w, this.y);
        rollT = Math.atan2(yl - yri, 2 * w);
      }
      pitchT = THREE.MathUtils.clamp(pitchT, -0.5, 0.5);
      rollT = THREE.MathUtils.clamp(rollT, -0.35, 0.35);
    }
    const tilt = Math.min(1, dt * 10);
    this.pitch += (pitchT - this.pitch) * tilt;
    this.roll += (rollT - this.roll) * tilt;
    this.root.rotation.x = this.pitch;
    // Two-wheelers lean into turns.
    const leanTarget = (!this.avatarOwnsProps && (this.mode === 'scooter' || this.mode === 'bike')) || this.mode === 'skate'
      ? THREE.MathUtils.clamp(-this.turnRate * this.speed * 0.012, -0.35, 0.35) : 0;
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * 6);
    this.root.rotation.z = this.lean + this.roll;

    if (this.mode === 'walk') this.setAvatarMode(Math.abs(this.speed) < 0.4 && this.onGround ? 'idle' : 'walk');
    // push off while speeding up from slow; cruise once rolling or in the air
    if (this.mode === 'skate' && this.avatar.setSkate) {
      try { this.avatar.setSkate({ push: this.onGround && f > 0 && Math.abs(this.speed) < p.speed * 0.8 }); } catch (_) { /* optional */ }
    }
    animateVehicle(this.vehicles[this.mode], dt, this.speed, this.steer, this.turnRate);
    // hands on the steering wheel and feet on the pedals as the wheel turns
    if (this.mode === 'car' && this.avatar.setDrive) {
      try { this.avatar.setDrive(carDriveTargets(this.vehicles.car, this.rider.position)); } catch (_) { /* optional */ }
    }
    try { this.avatar.update(dt, this.onGround ? Math.abs(this.speed) : 0, { airborne: !this.onGround, mode: this.mode }); } catch (e) {
      if (!this._warned) { console.warn('[player] avatar.update failed', e); this._warned = true; }
    }
  }
}
