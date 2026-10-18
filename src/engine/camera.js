// Third-person chase camera: mouse-drag orbit, wheel zoom, smoothed follow, auto swing
// behind a moving vehicle, cheap 2D wall check so it does not end up inside buildings.
import * as THREE from 'three';
import { FADE } from './nearfade.js';

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Terrain is optional; without it the ground is y = 0.
let terrainGround = () => 0;
import('../world/terrain.js').then((m) => { if (m && m.groundAt) terrainGround = m.groundAt; }).catch(() => {});
const CLEARANCE = 1.6; // camera never closer to the ground than this

export class ChaseCamera {
  constructor(camera, collision) {
    this.camera = camera;
    this.collision = collision;
    this.yaw = Math.PI / 2;
    this.pitch = 0.32;
    // framing for the 0.85-size characters (round 3): a little closer and lower than before
    this.dist = 17;
    this.wantDist = 17;
    this.clipDist = 1e4;
    this.focus = new THREE.Vector3();
    this.inited = false;
    this.surface = null;
  }

  // Same surface function as the player (city.heightAt: decks + terrain); terrain only without it.
  setSurface(fn) { this.surface = typeof fn === 'function' ? fn : null; }

  groundAt(x, z, y) {
    if (this.surface) {
      const h = this.surface(x, z, y);
      if (Number.isFinite(h)) return h;
    }
    return terrainGround(x, z);
  }

  update(dt, target, heading, speed, mode, input) {
    // Orbit
    if (input.dragDX || input.dragDY) {
      this.yaw -= input.dragDX * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + input.dragDY * 0.004, -0.05, 1.25);
    }
    if (input.wheel) this.wantDist = THREE.MathUtils.clamp(this.wantDist * Math.exp(input.wheel * 0.0012), 6, 70);

    // Swing behind the player when moving and the mouse has been idle for a moment.
    const idle = performance.now() - input.lastDragTime > 1200 && !input.dragging;
    if (idle && Math.abs(speed) > 1) {
      const behind = speed < 0 && mode === 'car' ? heading + Math.PI : heading;
      const strength = (mode === 'walk' ? 0.8 : mode === 'car' ? 3.2 : 2.2) * Math.min(1, Math.abs(speed) / 15);
      this.yaw += wrapAngle(behind - this.yaw) * Math.min(1, dt * strength);
    }
    this.yaw = wrapAngle(this.yaw);

    // Faster vehicles get pulled back a little for a sense of speed.
    const speedPull = mode === 'car' ? Math.min(Math.abs(speed) * 0.12, 7) : 0;
    const desired = this.wantDist + speedPull;
    this.dist += (desired - this.dist) * Math.min(1, dt * 3);

    const fy = target.y + (mode === 'car' ? 4.5 : 3.4);
    const tf = this.inited ? 1 - Math.exp(-dt * 12) : 1;
    this.focus.x += (target.x - this.focus.x) * tf;
    this.focus.z += (target.z - this.focus.z) * tf;
    this.focus.y += (fy - this.focus.y) * (this.inited ? 1 - Math.exp(-dt * 6) : 1);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const ox = -Math.sin(this.yaw) * cp, oz = -Math.cos(this.yaw) * cp;
    let d = this.dist;

    // Wall check in plan view: shorten fast when blocked, recover slowly.
    if (this.collision) {
      // Fences, kerbs, poles and trunks used to pull the camera to 4 units; only walls that
      // reach the eye line (or have no known height) should.
      const t = this.collision.raycast(this.focus.x, this.focus.z, this.focus.x + ox * d, this.focus.z + oz * d, true,
        { skipBelow: this.focus.y + 2, skipThin: 3 });
      const blocked = t < 1 ? Math.max(4, t * d - 1.2) : 1e4;
      if (blocked < this.clipDist) this.clipDist = blocked;
      else this.clipDist = Math.min(blocked, Math.min(this.clipDist, d) + dt * 12);
      d = Math.min(d, this.clipDist);
    }

    const cam = this.camera;
    const px = this.focus.x + ox * d, pz = this.focus.z + oz * d;
    let py = this.focus.y + sp * d;
    // Stay above the ground at the camera and keep the sight line over any hill crest between
    // the player and the camera (a few samples along the line are enough for gentle terrain).
    py = Math.max(py, this.groundAt(px, pz, py) + CLEARANCE);
    for (const t of [0.35, 0.6, 0.8]) {
      const g = this.groundAt(this.focus.x + ox * d * t, this.focus.z + oz * d * t, this.focus.y) + CLEARANCE * 0.6;
      const lineY = this.focus.y + (py - this.focus.y) * t;
      if (lineY < g) py = Math.max(py, this.focus.y + (g - this.focus.y) / t);
    }
    if (!this.inited) { cam.position.set(px, py, pz); this.inited = true; }
    const cf = 1 - Math.exp(-dt * 10);
    cam.position.x += (px - cam.position.x) * cf;
    cam.position.y += (py - cam.position.y) * cf;
    cam.position.z += (pz - cam.position.z) * cf;
    // Smoothing lags behind on a fast climb; never let the lag put the lens in the hill.
    cam.position.y = Math.max(cam.position.y, this.groundAt(cam.position.x, cam.position.z, cam.position.y) + CLEARANCE * 0.75);
    cam.lookAt(this.focus);
    // Canopies and props between the lens and this point dissolve (nearfade.js).
    FADE.focus.value.copy(this.focus);
  }
}
