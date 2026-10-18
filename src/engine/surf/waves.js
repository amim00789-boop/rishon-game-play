// Procedural surf for the surf minigame: rolling swell lines that shoal, steepen, break at a
// peak and peel both ways, drawn as a local heightfield overlay on top of the sea (water.js is
// untouched). Flat parts of the overlay are transparent, so the sea shader shows through and
// only the humps, the white lips and the whitewater read on top of it.
//
// Coordinates: a shore frame. u = distance seaward from the waterline, v = distance along the
// shore. frame.world(u, v) -> { x, z }; frame.local(x, z) -> { u, v }. Heights are above sea level.
import * as THREE from 'three';
import { SUN_DIR } from '../sky.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

export function shoreFrame(ox, oz, nx, nz) {
  const l = Math.hypot(nx, nz) || 1;
  nx /= l; nz /= l;
  // along-shore axis: the seaward normal turned a quarter to the left (seen from above, +y up)
  const sx = -nz, sz = nx;
  return {
    ox, oz, nx, nz, sx, sz,
    world(u, v, out = {}) { out.x = ox + nx * u + sx * v; out.z = oz + nz * u + sz * v; return out; },
    local(x, z, out = {}) { const dx = x - ox, dz = z - oz; out.u = dx * nx + dz * nz; out.v = dx * sx + dz * sz; return out; },
    // world yaw (three rotation.y: forward = (sin, cos)) of a local direction (du, dv)
    yawOf(du, dv) { return Math.atan2(nx * du + sx * dv, nz * du + sz * dv); },
    // local direction of a world yaw
    dirOf(yaw, out = {}) { const fx = Math.sin(yaw), fz = Math.cos(yaw); out.du = fx * nx + fz * nz; out.dv = fx * sx + fz * sz; return out; },
  };
}

export const SURF = {
  lineup: 150,       // where riders sit and wait
  breakAt: 132,      // mean break line
  spawnAt: 330,      // where a new swell line appears
  speed: 8.5,        // swell speed toward the shore, units/s
  height: 5.6,       // a typical set wave at the peak (the avatar is ~5 units tall)
  peel: [10, 15],    // peel speed of the good side / the fast side
};

// One swell line.
class Wave {
  constructor(o) {
    this.id = o.id;
    this.u = o.u ?? SURF.spawnAt;
    this.c = o.c ?? SURF.speed;
    this.H = o.H ?? SURF.height;
    this.peakV = o.peakV ?? 0;
    this.uBreak = o.uBreak ?? SURF.breakAt;
    // +1: the slow (long, rideable) side peels toward +v
    this.goodSide = o.goodSide ?? 1;
    this.peelL = 0; this.peelR = 0;
    this.broken = false;
    this.age = 0;
    this.dead = false;
    this.riders = 0;
  }
  get shoal() { return smooth(SURF.spawnAt, this.uBreak, this.u); }
  amp(v) {
    const dv = (v - this.peakV) / 190;
    const fade = this.broken ? smooth(6, 70, this.u) : 1;
    return this.H * (0.32 + 0.68 * this.shoal) * (0.22 + 0.78 * Math.exp(-dv * dv)) * fade;
  }
  frontW() { return lerp(17, 7.2, this.shoal); }
  // 0..1: how broken the line is at v (1 inside the whitewater section)
  brokenAt(v) {
    if (!this.broken) return 0;
    const out = Math.max(this.peakV - this.peelL - v, v - (this.peakV + this.peelR));
    return 1 - smooth(-5, 5, out);
  }
  // distance from v to the nearest peel edge (negative inside the broken section), Infinity when unbroken
  edgeDist(v) {
    if (!this.broken) return Infinity;
    return Math.max(this.peakV - this.peelL - v, v - (this.peakV + this.peelR));
  }
  update(dt) {
    this.age += dt;
    this.u -= this.c * dt;
    if (!this.broken && this.u < this.uBreak) this.broken = true;
    if (this.broken) {
      const [slow, fast] = SURF.peel;
      this.peelR += (this.goodSide > 0 ? slow : fast) * dt;
      this.peelL += (this.goodSide > 0 ? fast : slow) * dt;
    }
    if (this.u < 4) this.dead = true;
  }
}

// Cross-section of one wave at x = u - wave.u for an amplitude A, front width fw and broken
// share b. Writes h, dh/dx and foam into `o`.
const BACK_W = 26;
function profile(x, A, fw, b, shoal, o) {
  // green (unbroken) hump: steep front, long back
  const w = x < 0 ? fw : BACK_W;
  const e = Math.exp(-(x / w) * (x / w));
  const hG = A * e, dG = A * e * (-2 * x / (w * w));
  // whitewater bore: half height, short steep front, long foamy back
  const wb = x < 0 ? 5 : 34;
  const eb = Math.exp(-(x / wb) * (x / wb));
  const hB = A * 0.5 * eb, dB = A * 0.5 * eb * (-2 * x / (wb * wb));
  o.h = hG + (hB - hG) * b;
  o.d = dG + (dB - dG) * b;
  // foam: the bore and its trailing patch; a thin crest line on a steep green face
  const fb = x < 0 ? Math.exp(-(x / 6) * (x / 6)) : x < 46 ? 1 - x / 52 : 0;
  const crest = Math.exp(-((x + 0.9) / 1.6) * ((x + 0.9) / 1.6)) * shoal * shoal * 0.55;
  o.foam = fb * b + crest * (1 - b);
}

export class WaveField {
  // frame: shoreFrame; seaY: sea surface height
  constructor(frame, seaY = 0, rnd = Math.random) {
    this.frame = frame;
    this.seaY = seaY;
    this.rnd = rnd;
    this.waves = [];
    this.nextId = 1;
    this.queue = []; // { t, opts }
    this.time = 0;
    this._p = { h: 0, d: 0, foam: 0 };
  }
  // Schedule a set of `count` waves centred near v, `gap` seconds apart, starting in `delay` s.
  set(count = 3, { v = 0, delay = 0, gap = 6.5, height = SURF.height, start } = {}) {
    for (let i = 0; i < count; i++) {
      const r = this.rnd;
      this.queue.push({
        t: this.time + delay + i * gap,
        opts: {
          u: start,
          H: height * (i === 1 ? 1.08 : 0.88 + r() * 0.14),
          peakV: v + (r() - 0.5) * 30,
          uBreak: SURF.breakAt + (r() - 0.5) * 16,
          goodSide: r() < 0.5 ? 1 : -1,
        },
      });
    }
    this.queue.sort((a, b) => a.t - b.t);
  }
  spawn(opts = {}) {
    const w = new Wave({ id: this.nextId++, ...opts });
    this.waves.push(w);
    return w;
  }
  get pending() { return this.queue.length; }
  update(dt) {
    this.time += dt;
    while (this.queue.length && this.queue[0].t <= this.time) this.spawn(this.queue.shift().opts);
    for (const w of this.waves) w.update(dt);
    this.waves = this.waves.filter((w) => !w.dead);
  }
  clear() { this.waves.length = 0; this.queue.length = 0; }
  // Height above sea level at (u, v) plus the gradient and foam:
  // out = { h, gu, gv, foam, wave (the dominant one), x (u - wave.u), b (broken share there) }
  sample(u, v, out = {}) {
    let h = 0, gu = 0, gv = 0, foam = 0, best = null, bestH = -1, bx = 0, bb = 0;
    const p = this._p;
    for (const w of this.waves) {
      const x = u - w.u;
      if (x < -60 || x > 80) continue;
      const fw = w.frontW(), b = w.brokenAt(v), sh = w.shoal;
      const A = w.amp(v);
      profile(x, A, fw, b, sh, p);
      // along-shore slope: finite difference on the amplitude envelope and the broken share
      const dv = 1.5;
      profile(x, w.amp(v + dv), fw, w.brokenAt(v + dv), sh, _q);
      h += p.h; gu += p.d; gv += (_q.h - p.h) / dv; foam += p.foam;
      if (p.h > bestH) { bestH = p.h; best = w; bx = x; bb = b; }
    }
    // shore: everything flattens into the swash in the last few units
    const shore = smooth(2, 16, u);
    out.h = h * shore; out.gu = gu * shore; out.gv = gv * shore; out.foam = Math.min(1, foam);
    out.wave = best; out.x = bx; out.b = bb;
    return out;
  }
  // The wave a rider at (u, v) could catch: the nearest line seaward of u within `ahead` units.
  incoming(u, v, ahead = 70) {
    let best = null;
    for (const w of this.waves) {
      const d = w.u - u;
      if (d < -6 || d > ahead) continue;
      if (!best || w.u < best.u) best = w;
    }
    return best;
  }
}
const _q = { h: 0, d: 0, foam: 0 };

// ---------------------------------------------------------------------------------------------
// The overlay mesh: a grid in the shore frame that follows the player along the shore.

const SEA_DEEP = new THREE.Color(0x1f8fb3), FACE = new THREE.Color(0x2fb4cc), LIP = new THREE.Color(0x6fe0e6), FOAM = new THREE.Color(0xeef8ff);

export class WaveMesh {
  constructor(field, { uMin = 3, uMax = 320, vHalf = 240, du = 2.5, dv = 4 } = {}) {
    this.field = field;
    this.uMin = uMin; this.uMax = uMax; this.vHalf = vHalf;
    this.nu = Math.ceil((uMax - uMin) / du) + 1;
    this.nv = Math.ceil((vHalf * 2) / dv) + 1;
    this.du = (uMax - uMin) / (this.nu - 1);
    this.dv = (vHalf * 2) / (this.nv - 1);
    this.vc = 0; // grid centre along the shore
    const n = this.nu * this.nv;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 4);
    const idx = [];
    for (let i = 0; i < this.nu - 1; i++) {
      for (let j = 0; j < this.nv - 1; j++) {
        const a = i * this.nv + j, b = a + 1, c = a + this.nv, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    this.h = new Float32Array(n);
    this.f = new Float32Array(n);
    // Unlit like the sea shader (water.js), with a two-step toon shade baked into the colours, so
    // the overlay keeps the sea's palette instead of picking up the warm sunlight.
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: true, fog: true });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'surf-waves';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = false;
    this._s = {};
    this.update(0);
  }
  follow(v) { this.vc = Math.round(v / this.dv) * this.dv; }
  update() {
    const F = this.field, fr = F.frame, nu = this.nu, nv = this.nv;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position.array, nor = geo.attributes.normal.array, col = geo.attributes.color.array;
    const H = this.h, Fo = this.f, seaY = F.seaY + 0.08;
    const v0 = this.vc - this.vHalf;
    // The profile splits into a part that depends on the row (u, through x) and a part that
    // depends on the column (v: amplitude envelope, broken share), so each is computed once.
    const waves = F.waves, nw = waves.length;
    if (!this._cols || this._cols.length < nw * nv * 2) this._cols = new Float32Array(Math.max(8, nw) * nv * 2);
    const cols = this._cols;
    for (let w = 0; w < nw; w++) {
      for (let j = 0; j < nv; j++) {
        const v = v0 + j * this.dv;
        cols[(w * nv + j) * 2] = waves[w].amp(v);
        cols[(w * nv + j) * 2 + 1] = waves[w].brokenAt(v);
      }
    }
    const rowW = this._rowW || (this._rowW = []);
    for (let i = 0; i < nu; i++) {
      const u = this.uMin + i * this.du;
      rowW.length = 0;
      for (let w = 0; w < nw; w++) {
        const wv = waves[w], x = u - wv.u;
        if (x < -60 || x > 80) continue;
        const fw = wv.frontW(), sh = wv.shoal;
        const gw = x < 0 ? fw : BACK_W, wb = x < 0 ? 5 : 34;
        const e = Math.exp(-(x / gw) * (x / gw)), eb = Math.exp(-(x / wb) * (x / wb)) * 0.5;
        const fb = x < 0 ? Math.exp(-(x / 6) * (x / 6)) : x < 46 ? 1 - x / 52 : 0;
        const crest = Math.exp(-((x + 0.9) / 1.6) * ((x + 0.9) / 1.6)) * sh * sh * 0.55;
        rowW.push(w, e, eb, fb, crest);
      }
      const shore = smooth(2, 16, u);
      for (let j = 0; j < nv; j++) {
        let h = 0, foam = 0;
        for (let q = 0; q < rowW.length; q += 5) {
          const c = (rowW[q] * nv + j) * 2, A = cols[c], b = cols[c + 1];
          const hG = A * rowW[q + 1], hB = A * rowW[q + 2];
          h += hG + (hB - hG) * b;
          foam += rowW[q + 3] * b + rowW[q + 4] * (1 - b);
        }
        const v = v0 + j * this.dv;
        const k = i * nv + j;
        H[k] = h * shore; Fo[k] = Math.min(1, foam);
        pos[k * 3] = fr.ox + fr.nx * u + fr.sx * v; pos[k * 3 + 1] = seaY + H[k]; pos[k * 3 + 2] = fr.oz + fr.nz * u + fr.sz * v;
      }
    }
    const tmp = this._tmp || (this._tmp = new THREE.Color());
    for (let i = 0; i < nu; i++) {
      const u = this.uMin + i * this.du;
      for (let j = 0; j < nv; j++) {
        const k = i * nv + j;
        const hu = (H[Math.min(nu - 1, i + 1) * nv + j] - H[Math.max(0, i - 1) * nv + j]) / (this.du * (i > 0 && i < nu - 1 ? 2 : 1));
        const hv = (H[i * nv + Math.min(nv - 1, j + 1)] - H[i * nv + Math.max(0, j - 1)]) / (this.dv * (j > 0 && j < nv - 1 ? 2 : 1));
        // normal = (-grad, 1) in the frame, turned into world axes
        const gx = fr.nx * hu + fr.sx * hv, gz = fr.nz * hu + fr.sz * hv;
        const l = Math.hypot(gx, 1, gz);
        nor[k * 3] = -gx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -gz / l;
        // colour: deep base, brighter toward the crest (light through the lip), foam white
        const h = H[k];
        const t = clamp(h / 5.5, 0, 1);
        tmp.copy(SEA_DEEP).lerp(FACE, smooth(0, 0.5, t)).lerp(LIP, smooth(0.55, 1, t));
        const fo = clamp(Fo[k] * 1.25, 0, 1);
        tmp.lerp(FOAM, smooth(0.25, 0.55, fo));
        // toon shade: faces turned from the sun a step darker
        const lit = (-gx * SUN_DIR.x + SUN_DIR.y - gz * SUN_DIR.z) / l;
        const shade = lit > 0.55 ? 1 : lit > 0.2 ? 0.86 : 0.74;
        tmp.multiplyScalar(shade);
        col[k * 4] = tmp.r; col[k * 4 + 1] = tmp.g; col[k * 4 + 2] = tmp.b;
        // flat water is see-through (the sea shader shows); the grid edges fade out
        const v = j * this.dv - this.vHalf;
        const edge = smooth(this.vHalf, this.vHalf - 50, Math.abs(v)) * smooth(this.uMax, this.uMax - 50, u) * smooth(3, 10, u);
        col[k * 4 + 3] = clamp(Math.max(smooth(0.15, 0.9, h), smooth(0.15, 0.4, fo)), 0, 1) * edge;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Pitching lips: a white hook along each peel edge, strongest right at the edge (the pocket) and
// fading along the open face. One ribbon per wave side, rebuilt every frame.

const LIP_SEG = 18, LIP_LEN = 34;
const LIP_X = [0.6, -0.6, -2.0, -3.1, -3.4];      // cross-section, x relative to the crest
const LIP_Y = [0.0, 0.45, 0.35, -0.5, -1.7];      // y relative to the crest height (scaled)

export class LipRibbons {
  constructor(field, max = 6) {
    this.field = field;
    const per = LIP_SEG * LIP_X.length;
    this.max = max * 2;
    const pos = new Float32Array(this.max * per * 3);
    const idx = [];
    for (let r = 0; r < this.max; r++) {
      const base = r * per;
      for (let s = 0; s < LIP_SEG - 1; s++) {
        for (let c = 0; c < LIP_X.length - 1; c++) {
          const a = base + s * LIP_X.length + c, b = a + 1, d = a + LIP_X.length, e = d + 1;
          idx.push(a, d, b, b, d, e);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ color: 0xf4fbff, side: THREE.DoubleSide, fog: true });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'surf-lips';
    this.mesh.frustumCulled = false;
    this.per = per;
    this._s = {};
  }
  update() {
    const F = this.field, fr = F.frame, pos = this.mesh.geometry.attributes.position.array, s = this._s;
    let r = 0;
    for (const w of F.waves) {
      if (!w.broken || r >= this.max - 1) continue;
      for (const side of [1, -1]) {
        const edgeV = side > 0 ? w.peakV + w.peelR : w.peakV - w.peelL;
        const base = r * this.per * 3;
        for (let sg = 0; sg < LIP_SEG; sg++) {
          const k = sg / (LIP_SEG - 1);
          const v = edgeV + side * (k * LIP_LEN - 2);
          const strength = (1 - k) * (1 - k) * smooth(0, 6, w.peelL + w.peelR) * smooth(8, 40, w.u);
          F.sample(w.u, v, s);
          const crestH = s.h;
          for (let c = 0; c < LIP_X.length; c++) {
            const u = w.u + LIP_X[c] * (0.4 + 0.6 * strength);
            const y = F.seaY + 0.1 + crestH + LIP_Y[c] * crestH * 0.32 * strength - (1 - strength) * 0.4;
            const o = base + (sg * LIP_X.length + c) * 3;
            pos[o] = fr.ox + fr.nx * u + fr.sx * v;
            pos[o + 1] = y;
            pos[o + 2] = fr.oz + fr.nz * u + fr.sz * v;
          }
        }
        r++;
      }
    }
    // park unused ribbons far below
    for (let i = r * this.per * 3; i < pos.length; i += 3) { pos[i] = fr.ox; pos[i + 1] = -999; pos[i + 2] = fr.oz; }
    const geo = this.mesh.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Spray: a pool of white blobs (peel edges, carves, wipeouts).

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(160, 220, 235, 0.9)'; g.lineWidth = 5; g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Spray {
  constructor(max = 600) {
    this.max = max;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);
    this.n = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({ map: blobTexture(), size: 1.4, sizeAttenuation: true, transparent: true, alphaTest: 0.4, depthWrite: false });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.name = 'surf-spray';
    this.next = 0;
    this.life.fill(0);
    for (let i = 0; i < max; i++) this.p[i * 3 + 1] = -999;
  }
  emit(x, y, z, vx, vy, vz, count = 6, spread = 2, life = 0.9) {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      this.p[i * 3] = x + (Math.random() - 0.5) * spread * 0.6;
      this.p[i * 3 + 1] = y + Math.random() * 0.4;
      this.p[i * 3 + 2] = z + (Math.random() - 0.5) * spread * 0.6;
      this.v[i * 3] = vx + (Math.random() - 0.5) * spread;
      this.v[i * 3 + 1] = vy * (0.7 + Math.random() * 0.6);
      this.v[i * 3 + 2] = vz + (Math.random() - 0.5) * spread;
      this.life[i] = life * (0.7 + Math.random() * 0.6);
    }
  }
  update(dt, floorY) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.v[i * 3 + 1] -= 18 * dt;
      this.p[i * 3] += this.v[i * 3] * dt;
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt;
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      if (this.life[i] <= 0 || this.p[i * 3 + 1] < floorY - 1) { this.life[i] = 0; this.p[i * 3 + 1] = -999; }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
  dispose() { this.points.geometry.dispose(); this.points.material.map.dispose(); this.points.material.dispose(); }
}
