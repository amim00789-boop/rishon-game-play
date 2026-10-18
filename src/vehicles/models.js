// Chunky toon vehicles for traffic and parked cars, built as merged geometry so each model is one
// InstancedMesh per level of detail. Local frame: +z forward, +x is the vehicle's left, y up,
// wheels touch y = 0. Units are world units (avatars are ~5 tall, so vehicles are scaled up from
// true size the same Roblox-ish way, but kept narrow enough to fit the real lane widths).
//
// Paint: parts marked 'P' (or 'P2', a darker trim of the paint) take the per-instance colour; every
// other part keeps its own vertex colour. A small shader patch (paintMask attribute) does that, so
// one draw call carries any number of differently painted cars.
//
// API
//   KINDS                       kind id -> { L, W, H, s, ... } (drawn bounding size, scale s applied)
//   buildKindGeometry(kind, lod) merged BufferGeometry, lod 0 = near (rounded), 1 = mid (plain boxes)
//   boxGeometry()               unit box (paint mask 1) for the far LOD, scaled per instance
//   vehicleMaterial()           shared toon material with the paint-mask patch
//   pickPaint(kind, rnd)        THREE.Color for a new vehicle of that kind
//   createFleet(scene, kinds, { capacity, shadows }) instanced renderer, see below
//   buildVehicleMesh(kind, colorHex) one-off Mesh (preview, player car reuse)
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toonRamp } from '../engine/renderer.js';

// ---- palette -----------------------------------------------------------------------------------
const C = {
  glass: 0x557891, glassDark: 0x34495e, trim: 0x2f333b, tyre: 0x232323, hub: 0xc3c7cd,
  light: 0xfff4c8, tail: 0xd7263d, amber: 0xffa62b, plate: 0xf5c400, plateDark: 0x2a2a2a,
  white: 0xf3f3ef, grey: 0xb9bdc2, chassis: 0x3a3d42, skin: 0xe0ac7e, hair: 0x3b2a20,
  jeans: 0x34508a, jacket: 0x3a3f4a, helmet: 0xf1f1f1, taxi: 0xffd23f, cargo: 0xeeeeea,
  stripe: 0x2e6db4, roof: 0xe9ebec, display: 0x1d1d1d, metal: 0xaab0b8,
};

// Israel's street mix is mostly white, silver and grey, with a few dark and coloured cars.
const W = (hex, w) => ({ hex, w });
export const PAINTS = {
  car: [W(0xf4f4f2, 30), W(0xc4c8cc, 20), W(0x8a8f96, 14), W(0x4a4f57, 7), W(0x25272b, 6), W(0x2c3e66, 4),
    W(0xc0392b, 4), W(0x8fb8d8, 3), W(0xd8c9a8, 3), W(0x2f7d6d, 2), W(0x7b2d3b, 2), W(0xf2c14e, 1), W(0xe67e22, 1)],
  van: [W(0xf6f6f3, 70), W(0xc4c8cc, 14), W(0x8a8f96, 7), W(0x2c3e66, 4), W(0xc0392b, 3), W(0xf2c14e, 2)],
  taxi: [W(0xf4f4f2, 50), W(0xc4c8cc, 25), W(0x8a8f96, 10), W(0x25272b, 10), W(0x2c3e66, 5)],
  bus: [W(0x3f9b4a, 40), W(0x7cc242, 15), W(0xf0f0f0, 15), W(0x2e6db4, 15), W(0xd64541, 10), W(0x2bb3a6, 5)],
  coach: [W(0xf6f6f3, 60), W(0xc4c8cc, 20), W(0xefe3c4, 10), W(0x2e6db4, 10)],
  truck: [W(0xf6f6f3, 50), W(0xc0392b, 14), W(0x2e6db4, 14), W(0x3f9b4a, 10), W(0xe67e22, 7), W(0x8a8f96, 5)],
  semi: [W(0xf6f6f3, 35), W(0xc0392b, 20), W(0x2e6db4, 18), W(0x8a8f96, 12), W(0xf2c14e, 10), W(0x25272b, 5)],
  moto: [W(0x25272b, 30), W(0xc0392b, 18), W(0x2e6db4, 15), W(0xf4f4f2, 15), W(0x8a8f96, 12), W(0xf2c14e, 10)],
  delivery: [W(0x2ec4b6, 35), W(0xff6b3d, 25), W(0xffcb3d, 20), W(0xd64541, 10), W(0x3f9b4a, 10)],
  scooter: [W(0x2ec4b6, 25), W(0x25272b, 25), W(0xf4f4f2, 20), W(0xff6b3d, 15), W(0x7cc242, 15)],
};

// ---- part helpers --------------------------------------------------------------------------------
// box(w, h, d, x, y, z, colour, opts): y is the box centre. colour 'P' = paint, 'P2' = darker paint.
const box = (w, h, d, x, y, z, c, o = {}) => ({ t: 'box', w, h, d, x, y, z, c, r: o.r ?? 0.12, rx: o.rx || 0, ry: o.ry || 0, rz: o.rz || 0, detail: !!o.detail });
const cyl = (rt, rb, h, x, y, z, c, o = {}) => ({ t: 'cyl', rt, rb, h, x, y, z, c, seg: o.seg || 10, rx: o.rx || 0, ry: o.ry || 0, rz: o.rz || 0, detail: !!o.detail });
// Wheel on an axle along x: tyre plus hub.
const wheel = (r, w, x, y, z) => [
  cyl(r, r, w, x, y, z, C.tyre, { rz: Math.PI / 2, seg: 14 }),
  cyl(r * 0.5, r * 0.5, w + 0.04, x, y, z, C.hub, { rz: Math.PI / 2, seg: 10, detail: true }),
];
const axle = (r, w, track, y, z) => [...wheel(r, w, track, y, z), ...wheel(r, w, -track, y, z)];
// Lights, plates and grille on a car-like front and rear at ±zf, ±zr.
function carFace(Wd, zf, zr, yl, opts = {}) {
  const lx = Wd / 2 - 0.45;
  return [
    box(0.62, 0.34, 0.12, lx, yl, zf, C.light, { r: 0.08, detail: true }),
    box(0.62, 0.34, 0.12, -lx, yl, zf, C.light, { r: 0.08, detail: true }),
    box(0.5, 0.36, 0.12, lx, yl + 0.05, zr, C.tail, { r: 0.08, detail: true }),
    box(0.5, 0.36, 0.12, -lx, yl + 0.05, zr, C.tail, { r: 0.08, detail: true }),
    box(0.95, 0.26, 0.06, 0, opts.plateY ?? 0.85, zf + 0.02, C.plate, { r: 0.03, detail: true }),
    box(0.95, 0.26, 0.06, 0, opts.plateY ?? 0.85, zr - 0.02, C.plate, { r: 0.03, detail: true }),
    box(Math.min(1.3, Wd * 0.45), 0.3, 0.06, 0, yl - 0.05, zf + 0.01, C.trim, { r: 0.05, detail: true }),
  ];
}
// Simple blocky riders, sized like the ~5 unit avatars. `shirt` may be 'P' (matches the paint).
function seatedRider(y, z, shirt, helmet = C.helmet) {
  return [
    box(1.0, 0.55, 1.3, 0, y + 0.25, z + 0.15, C.jeans, { r: 0.15 }), // thighs
    box(0.75, 1.1, 0.5, 0.42, y - 0.35, z + 0.75, C.jeans, { r: 0.12, detail: true }), // shins
    box(0.75, 1.1, 0.5, -0.42, y - 0.35, z + 0.75, C.jeans, { r: 0.12, detail: true }),
    box(1.3, 1.5, 0.8, 0, y + 1.25, z - 0.2, shirt, { r: 0.2, rx: 0.22 }), // torso, leaning in
    box(0.36, 0.36, 1.3, 0.72, y + 1.45, z + 0.45, shirt, { r: 0.12, rx: 0.35, detail: true }), // arms
    box(0.36, 0.36, 1.3, -0.72, y + 1.45, z + 0.45, shirt, { r: 0.12, rx: 0.35, detail: true }),
    box(0.85, 0.85, 0.85, 0, y + 2.4, z - 0.05, C.skin, { r: 0.2 }),
    box(1.0, 0.62, 1.02, 0, y + 2.7, z - 0.1, helmet, { r: 0.3 }),
  ];
}
function standingRider(z, shirt) {
  return [
    box(0.62, 2.0, 0.6, 0.35, 1.45, z, C.jeans, { r: 0.12 }),
    box(0.62, 2.0, 0.6, -0.35, 1.45, z - 0.25, C.jeans, { r: 0.12 }),
    box(1.35, 1.7, 0.8, 0, 3.3, z, shirt, { r: 0.2, rx: 0.08 }),
    box(0.36, 0.36, 1.4, 0.8, 3.65, z + 0.55, shirt, { r: 0.12, rx: 0.5, detail: true }),
    box(0.36, 0.36, 1.4, -0.8, 3.65, z + 0.55, shirt, { r: 0.12, rx: 0.5, detail: true }),
    box(0.9, 0.9, 0.9, 0, 4.65, z + 0.05, C.skin, { r: 0.2 }),
    box(0.96, 0.32, 0.96, 0, 5.15, z, C.hair, { r: 0.14 }),
  ];
}

// ---- kinds -----------------------------------------------------------------------------------------
// L/W/H: bounding size. vMax: top speed factor. big: needs main roads. two: two-wheeler.
// park: may appear as a parked car. paint: palette name.
export const KINDS = {
  hatch: { L: 5.8, W: 2.7, H: 3.25, paint: 'car', park: true },
  sedan: { L: 6.6, W: 2.8, H: 3.2, paint: 'car', park: true },
  suv: { L: 6.4, W: 2.9, H: 3.55, paint: 'car', park: true },
  taxi: { L: 6.6, W: 2.8, H: 3.75, paint: 'taxi', park: true },
  van: { L: 7.4, W: 3.0, H: 4.3, paint: 'van', park: true },
  // Round 5: buses grown upward so a 0.85 avatar is ~60% of the roof height and fits the doors; the
  // tallest no longer clear every underpass, so traffic.js routes them by edge clearance.
  bus: { L: 17.6, W: 3.5, H: 7.3, paint: 'bus', big: true, vMax: 0.8 },
  coach: { L: 18.6, W: 3.5, H: 7.45, paint: 'coach', big: true, vMax: 0.9 },
  truck: { L: 11, W: 3.3, H: 5.5, paint: 'truck', big: true, vMax: 0.8 },
  semi: { L: 23.4, W: 3.4, H: 6.0, paint: 'semi', big: true, vMax: 0.85 },
  moto: { L: 3.4, W: 1.2, H: 5.2, paint: 'moto', two: true, vMax: 1.05 },
  ebike: { L: 3.0, W: 1.1, H: 5.0, paint: 'delivery', two: true, vMax: 0.7, cap: 13 },
  kick: { L: 2.3, W: 1.1, H: 5.4, paint: 'scooter', two: true, vMax: 0.6, cap: 10 },
};

// Four-wheelers are drawn at CAR_SCALE of the part sizes below. city.js widens every road
// cross-section by 1.4 on top of SCALE (a lane is ~5.9 units), and avatars are about twice human
// size, so true-proportion cars would look like toys; two-wheelers stay at avatar scale.
export const CAR_SCALE = 1.2;
// Founder, round 3: characters and vehicles a bit smaller against the map; avatars shrink by the
// same factor, so two-wheelers and their built-in riders keep matching them.
export const VEHICLE_SCALE = 0.85;
for (const k of Object.values(KINDS)) {
  k.s = (k.two ? 1 : CAR_SCALE) * VEHICLE_SCALE;
  k.L *= k.s; k.W *= k.s; k.H *= k.s;
}

function partsOf(kind, { rider = true } = {}) {
  const k = KINDS[kind];
  switch (kind) {
    case 'hatch': {
      const L = k.L / k.s, Wd = k.W / k.s;
      return [
        box(Wd, 1.3, L, 0, 1.25, 0, 'P', { r: 0.45 }),
        box(Wd + 0.04, 0.32, L - 0.5, 0, 0.72, 0, C.trim, { r: 0.12 }),
        box(Wd + 0.06, 0.5, 0.42, 0, 0.82, L / 2 - 0.15, C.trim, { r: 0.18 }),
        box(Wd + 0.06, 0.5, 0.42, 0, 0.82, -L / 2 + 0.15, C.trim, { r: 0.18 }),
        box(Wd - 0.22, 1.12, 3.1, 0, 2.42, -0.45, C.glass, { r: 0.3 }),
        box(Wd - 0.1, 0.34, 3.0, 0, 3.07, -0.55, 'P', { r: 0.15 }),
        box(0.3, 0.26, 0.36, Wd / 2 + 0.12, 2.05, 0.95, 'P', { r: 0.08, detail: true }),
        box(0.3, 0.26, 0.36, -Wd / 2 - 0.12, 2.05, 0.95, 'P', { r: 0.08, detail: true }),
        ...carFace(Wd, L / 2 - 0.02, -L / 2 + 0.02, 1.5),
        ...axle(0.7, 0.55, Wd / 2 - 0.22, 0.7, 1.85), ...axle(0.7, 0.55, Wd / 2 - 0.22, 0.7, -1.85),
      ];
    }
    case 'sedan':
    case 'taxi': {
      const L = k.L / k.s, Wd = k.W / k.s;
      const p = [
        box(Wd, 1.25, L, 0, 1.22, 0, 'P', { r: 0.45 }),
        box(Wd + 0.04, 0.3, L - 0.6, 0, 0.7, 0, C.trim, { r: 0.12 }),
        box(Wd + 0.06, 0.48, 0.42, 0, 0.8, L / 2 - 0.15, C.trim, { r: 0.18 }),
        box(Wd + 0.06, 0.48, 0.42, 0, 0.8, -L / 2 + 0.15, C.trim, { r: 0.18 }),
        box(Wd - 0.24, 1.05, 3.3, 0, 2.35, -0.3, C.glass, { r: 0.32 }),
        box(Wd - 0.12, 0.32, 2.9, 0, 2.98, -0.4, 'P', { r: 0.15 }),
        box(0.3, 0.26, 0.36, Wd / 2 + 0.12, 2.0, 1.25, 'P', { r: 0.08, detail: true }),
        box(0.3, 0.26, 0.36, -Wd / 2 - 0.12, 2.0, 1.25, 'P', { r: 0.08, detail: true }),
        ...carFace(Wd, L / 2 - 0.02, -L / 2 + 0.02, 1.45),
        ...axle(0.7, 0.55, Wd / 2 - 0.22, 0.7, 2.2), ...axle(0.7, 0.55, Wd / 2 - 0.22, 0.7, -2.2),
      ];
      if (kind === 'taxi') p.push(
        box(1.35, 0.5, 0.6, 0, 3.42, -0.3, C.taxi, { r: 0.12 }),
        box(1.38, 0.13, 0.62, 0, 3.32, -0.3, C.plateDark, { r: 0.04 }),
      );
      return p;
    }
    case 'suv': {
      const L = k.L / k.s, Wd = k.W / k.s;
      return [
        box(Wd, 1.45, L, 0, 1.45, 0, 'P', { r: 0.45 }),
        box(Wd + 0.05, 0.5, L - 0.4, 0, 0.92, 0, C.trim, { r: 0.15 }),
        box(Wd + 0.06, 0.55, 0.45, 0, 1.0, L / 2 - 0.15, C.trim, { r: 0.18 }),
        box(Wd + 0.06, 0.55, 0.45, 0, 1.0, -L / 2 + 0.15, C.trim, { r: 0.18 }),
        box(Wd - 0.2, 1.08, 3.9, 0, 2.7, -0.45, C.glass, { r: 0.3 }),
        box(Wd - 0.1, 0.32, 3.8, 0, 3.32, -0.5, 'P', { r: 0.15 }),
        box(0.12, 0.12, 3.2, Wd / 2 - 0.35, 3.52, -0.5, C.trim, { r: 0.04, detail: true }),
        box(0.12, 0.12, 3.2, -Wd / 2 + 0.35, 3.52, -0.5, C.trim, { r: 0.04, detail: true }),
        box(0.3, 0.28, 0.38, Wd / 2 + 0.12, 2.35, 1.2, 'P', { r: 0.08, detail: true }),
        box(0.3, 0.28, 0.38, -Wd / 2 - 0.12, 2.35, 1.2, 'P', { r: 0.08, detail: true }),
        ...carFace(Wd, L / 2 - 0.02, -L / 2 + 0.02, 1.75, { plateY: 1.05 }),
        ...axle(0.82, 0.6, Wd / 2 - 0.25, 0.82, 2.05), ...axle(0.82, 0.6, Wd / 2 - 0.25, 0.82, -2.05),
      ];
    }
    case 'van': {
      const L = k.L / k.s, Wd = k.W / k.s;
      return [
        box(Wd, 3.15, L - 1.5, 0, 2.55, -0.75, 'P', { r: 0.35 }), // load box and cab roof
        box(Wd - 0.1, 1.35, 1.7, 0, 1.55, L / 2 - 0.95, 'P', { r: 0.4 }), // short bonnet
        box(Wd - 0.2, 1.2, 0.5, 0, 3.0, L / 2 - 1.75, C.glass, { r: 0.12, rx: -0.38 }), // windscreen
        box(Wd + 0.04, 1.05, 1.15, 0, 3.15, L / 2 - 2.35, C.glass, { r: 0.12 }), // cab side windows
        box(Wd + 0.05, 0.42, L - 0.3, 0, 0.92, 0, C.trim, { r: 0.12 }),
        box(Wd + 0.06, 0.5, 0.4, 0, 0.88, L / 2 - 0.12, C.trim, { r: 0.18 }),
        box(Wd + 0.06, 0.5, 0.4, 0, 0.88, -L / 2 + 0.12, C.trim, { r: 0.18 }),
        box(0.06, 2.4, 0.08, 0, 2.5, -L / 2 + 0.02, C.trim, { r: 0.02, detail: true }), // rear door split
        box(0.05, 2.1, 1.6, Wd / 2 + 0.01, 2.4, -0.4, C.grey, { r: 0.04, detail: true }), // sliding door
        box(0.35, 0.3, 0.4, Wd / 2 + 0.14, 2.75, L / 2 - 2.0, C.trim, { r: 0.08, detail: true }),
        box(0.35, 0.3, 0.4, -Wd / 2 - 0.14, 2.75, L / 2 - 2.0, C.trim, { r: 0.08, detail: true }),
        ...carFace(Wd, L / 2 - 0.02, -L / 2 + 0.02, 1.7, { plateY: 0.95 }),
        ...axle(0.76, 0.6, Wd / 2 - 0.25, 0.76, L / 2 - 1.45), ...axle(0.76, 0.6, Wd / 2 - 0.25, 0.76, -L / 2 + 1.5),
      ];
    }
    case 'bus': {
      const L = k.L / k.s, Wd = k.W / k.s;
      return [
        // low floor at the doors; windows from a passenger's waist to above a standing head
        box(Wd, 5.9, L, 0, 3.8, 0, 'P', { r: 0.5 }),
        box(Wd + 0.06, 3.2, L - 1.4, 0, 4.0, -0.5, C.glassDark, { r: 0.12 }),
        box(Wd - 0.3, 4.4, 0.14, 0, 3.8, L / 2 + 0.01, C.glassDark, { r: 0.08 }),
        box(Wd - 0.1, 0.4, L - 0.3, 0, 6.8, 0, C.roof, { r: 0.18 }),
        box(2.4, 0.4, 4.2, 0, 7.1, -2.5, C.roof, { r: 0.18 }), // roof air conditioning
        box(2.4, 0.45, 0.12, 0, 6.3, L / 2 + 0.03, C.display, { r: 0.05 }),
        box(1.8, 0.2, 0.13, 0, 6.3, L / 2 + 0.05, C.amber, { r: 0.04, detail: true }),
        box(Wd + 0.05, 0.55, L - 0.2, 0, 1.05, 0, 'P2', { r: 0.15 }),
        // doors, kerb side: lighter glass in a dark frame so they read against the window band
        box(0.08, 4.85, 2.05, -Wd / 2 - 0.01, 3.27, L / 2 - 1.6, C.trim, { r: 0.04 }),
        box(0.1, 4.6, 1.8, -Wd / 2 - 0.02, 3.2, L / 2 - 1.6, C.glass, { r: 0.04 }),
        box(0.08, 4.85, 2.05, -Wd / 2 - 0.01, 3.27, -0.6, C.trim, { r: 0.04 }),
        box(0.1, 4.6, 1.8, -Wd / 2 - 0.02, 3.2, -0.6, C.glass, { r: 0.04 }),
        box(Wd + 0.06, 0.5, 0.35, 0, 1.0, L / 2 - 0.05, C.trim, { r: 0.15 }),
        box(Wd + 0.06, 0.5, 0.35, 0, 1.0, -L / 2 + 0.05, C.trim, { r: 0.15 }),
        box(0.62, 0.34, 0.12, Wd / 2 - 0.5, 1.7, L / 2 + 0.02, C.light, { r: 0.08, detail: true }),
        box(0.62, 0.34, 0.12, -Wd / 2 + 0.5, 1.7, L / 2 + 0.02, C.light, { r: 0.08, detail: true }),
        box(0.5, 0.7, 0.12, Wd / 2 - 0.4, 2.1, -L / 2 - 0.02, C.tail, { r: 0.08, detail: true }),
        box(0.5, 0.7, 0.12, -Wd / 2 + 0.4, 2.1, -L / 2 - 0.02, C.tail, { r: 0.08, detail: true }),
        ...axle(1.15, 0.75, Wd / 2 - 0.35, 1.15, L / 2 - 3.2), ...axle(1.15, 0.75, Wd / 2 - 0.35, 1.15, -L / 2 + 4.2),
      ];
    }
    case 'coach': {
      const L = k.L / k.s, Wd = k.W / k.s;
      return [
        // high floor over the luggage bays, so the windows start higher than on a city bus
        box(Wd, 6.45, L, 0, 4.22, 0, 'P', { r: 0.55 }),
        box(Wd + 0.06, 3.0, L - 2.2, 0, 5.1, -0.6, C.glassDark, { r: 0.12 }),
        box(Wd - 0.3, 4.3, 0.14, 0, 4.75, L / 2 + 0.01, C.glassDark, { r: 0.08, rx: -0.08 }),
        box(Wd + 0.05, 0.42, L - 0.4, 0, 3.2, 0, C.stripe, { r: 0.1 }),
        box(Wd + 0.04, 1.6, L - 6, 0, 1.95, -0.5, C.grey, { r: 0.12 }), // luggage bays
        box(Wd + 0.06, 0.5, 0.35, 0, 1.0, L / 2 - 0.05, C.trim, { r: 0.15 }),
        box(Wd + 0.06, 0.5, 0.35, 0, 1.0, -L / 2 + 0.05, C.trim, { r: 0.15 }),
        box(0.08, 5.25, 1.45, -Wd / 2 - 0.01, 3.57, L / 2 - 1.3, C.trim, { r: 0.04 }),
        box(0.1, 5.0, 1.2, -Wd / 2 - 0.02, 3.5, L / 2 - 1.3, C.glass, { r: 0.04 }),
        box(0.62, 0.34, 0.12, Wd / 2 - 0.5, 1.6, L / 2 + 0.02, C.light, { r: 0.08, detail: true }),
        box(0.62, 0.34, 0.12, -Wd / 2 + 0.5, 1.6, L / 2 + 0.02, C.light, { r: 0.08, detail: true }),
        box(0.5, 0.7, 0.12, Wd / 2 - 0.4, 1.9, -L / 2 - 0.02, C.tail, { r: 0.08, detail: true }),
        box(0.5, 0.7, 0.12, -Wd / 2 + 0.4, 1.9, -L / 2 - 0.02, C.tail, { r: 0.08, detail: true }),
        ...axle(1.15, 0.75, Wd / 2 - 0.35, 1.15, L / 2 - 3.4), ...axle(1.15, 0.75, Wd / 2 - 0.35, 1.15, -L / 2 + 5.2),
        ...axle(1.15, 0.75, Wd / 2 - 0.35, 1.15, -L / 2 + 3.0),
      ];
    }
    case 'truck': {
      const L = k.L / k.s, Wd = k.W / k.s;
      return [
        box(Wd, 3.2, 2.7, 0, 2.55, L / 2 - 1.35, 'P', { r: 0.4 }), // cab
        box(Wd - 0.3, 1.2, 0.12, 0, 3.15, L / 2 + 0.01, C.glass, { r: 0.08 }),
        box(Wd + 0.04, 1.05, 1.3, 0, 3.2, L / 2 - 1.0, C.glass, { r: 0.08 }),
        box(Wd, 4.3, L - 3.0, 0, 3.25, -1.5, C.cargo, { r: 0.2 }), // box body
        box(Wd + 0.02, 0.25, L - 3.1, 0, 5.3, -1.5, 'P2', { r: 0.08, detail: true }),
        box(2.2, 0.6, L - 0.6, 0, 0.95, -0.2, C.chassis, { r: 0.1 }),
        box(Wd + 0.06, 0.5, 0.35, 0, 1.0, L / 2 - 0.05, C.trim, { r: 0.15 }),
        box(0.62, 0.34, 0.12, Wd / 2 - 0.5, 1.6, L / 2 + 0.02, C.light, { r: 0.08, detail: true }),
        box(0.62, 0.34, 0.12, -Wd / 2 + 0.5, 1.6, L / 2 + 0.02, C.light, { r: 0.08, detail: true }),
        box(0.5, 0.4, 0.12, Wd / 2 - 0.4, 1.4, -L / 2 - 0.02, C.tail, { r: 0.08, detail: true }),
        box(0.5, 0.4, 0.12, -Wd / 2 + 0.4, 1.4, -L / 2 - 0.02, C.tail, { r: 0.08, detail: true }),
        ...axle(0.95, 0.7, Wd / 2 - 0.35, 0.95, L / 2 - 1.5), ...axle(0.95, 0.9, Wd / 2 - 0.45, 0.95, -L / 2 + 2.3),
      ];
    }
    case 'semi': {
      const L = k.L / k.s, Wd = k.W / k.s, zc = L / 2 - 1.5; // cab-over tractor at the front
      return [
        box(Wd, 3.8, 2.9, 0, 2.95, zc, 'P', { r: 0.4 }),
        box(Wd - 0.3, 1.4, 0.12, 0, 3.6, zc + 1.46, C.glass, { r: 0.08 }),
        box(Wd + 0.04, 1.1, 1.4, 0, 3.7, zc + 0.6, C.glass, { r: 0.08 }),
        box(Wd - 0.2, 0.9, 2.4, 0, 5.3, zc - 0.2, 'P2', { r: 0.3 }), // roof fairing
        box(Wd, 4.4, L - 4.4, 0, 3.75, -2.1, C.cargo, { r: 0.18 }), // trailer
        box(Wd + 0.02, 0.3, L - 4.5, 0, 1.75, -2.1, C.stripe, { r: 0.06, detail: true }),
        box(2.2, 0.7, L - 1, 0, 1.1, 0, C.chassis, { r: 0.1 }),
        box(Wd + 0.06, 0.6, 0.35, 0, 1.1, L / 2 - 0.05, C.trim, { r: 0.15 }),
        box(0.62, 0.34, 0.12, Wd / 2 - 0.5, 1.7, L / 2 + 0.02, C.light, { r: 0.08, detail: true }),
        box(0.62, 0.34, 0.12, -Wd / 2 + 0.5, 1.7, L / 2 + 0.02, C.light, { r: 0.08, detail: true }),
        box(0.5, 0.4, 0.12, Wd / 2 - 0.4, 1.5, -L / 2 - 0.02, C.tail, { r: 0.08, detail: true }),
        box(0.5, 0.4, 0.12, -Wd / 2 + 0.4, 1.5, -L / 2 - 0.02, C.tail, { r: 0.08, detail: true }),
        ...axle(0.95, 0.7, Wd / 2 - 0.35, 0.95, zc), ...axle(0.95, 0.9, Wd / 2 - 0.45, 0.95, zc - 3.2),
        ...axle(0.95, 0.9, Wd / 2 - 0.45, 0.95, -L / 2 + 4.6), ...axle(0.95, 0.9, Wd / 2 - 0.45, 0.95, -L / 2 + 2.6),
      ];
    }
    case 'moto': {
      const p = [
        ...wheel(0.62, 0.32, 0, 0.62, 1.2), ...wheel(0.62, 0.36, 0, 0.62, -1.2),
        box(0.62, 0.65, 0.95, 0, 1.0, 0.1, C.chassis, { r: 0.15 }), // engine
        box(0.72, 0.55, 1.2, 0, 1.6, 0.35, 'P', { r: 0.22 }), // tank
        box(0.58, 0.24, 1.25, 0, 1.68, -0.6, C.trim, { r: 0.1 }), // seat
        box(0.5, 0.35, 0.9, 0, 1.45, -1.1, 'P', { r: 0.12 }), // tail
        box(0.14, 1.4, 0.14, 0, 1.55, 1.15, C.metal, { r: 0.04, rx: -0.3 }), // fork
        box(1.3, 0.12, 0.12, 0, 2.25, 0.9, C.metal, { r: 0.04 }), // bars
        box(0.42, 0.42, 0.25, 0, 1.95, 1.3, C.light, { r: 0.12, detail: true }),
        box(0.3, 0.2, 0.1, 0, 1.5, -1.56, C.tail, { r: 0.04, detail: true }),
      ];
      if (rider) p.push(...seatedRider(1.85, -0.45, C.jacket, 'P'));
      return p;
    }
    case 'ebike': {
      const p = [
        ...wheel(0.62, 0.18, 0, 0.62, 1.1), ...wheel(0.62, 0.2, 0, 0.62, -1.1),
        box(0.18, 0.18, 1.9, 0, 1.25, 0.05, C.chassis, { r: 0.06, rx: 0.12 }),
        box(0.34, 0.45, 0.75, 0, 1.15, -0.15, C.trim, { r: 0.1 }), // battery
        box(0.14, 1.35, 0.14, 0, 1.55, 1.0, C.metal, { r: 0.04, rx: -0.25 }),
        box(1.2, 0.1, 0.1, 0, 2.25, 0.85, C.metal, { r: 0.03 }),
        box(0.42, 0.18, 0.7, 0, 1.75, -0.55, C.trim, { r: 0.08 }),
        box(1.35, 1.25, 1.25, 0, 2.6, -1.05, 'P', { r: 0.18 }), // delivery box behind the seat
        box(1.38, 0.18, 1.28, 0, 2.95, -1.05, C.white, { r: 0.06, detail: true }),
      ];
      if (rider) p.push(...seatedRider(1.85, -0.25, 'P', C.white));
      return p;
    }
    case 'kick': {
      const p = [
        ...wheel(0.32, 0.22, 0, 0.32, 0.85), ...wheel(0.32, 0.22, 0, 0.32, -0.85),
        box(0.6, 0.2, 1.9, 0, 0.42, 0, 'P', { r: 0.08 }),
        box(0.14, 2.9, 0.14, 0, 1.85, 0.95, C.metal, { r: 0.04, rx: -0.1 }),
        box(1.25, 0.1, 0.1, 0, 3.25, 1.1, C.trim, { r: 0.03 }),
      ];
      if (rider) p.push(...standingRider(-0.2, 'P').map((q) => ({ ...q, y: q.y + 0.25 })));
      return p;
    }
    default:
      return [box(k ? k.W : 2.8, k ? k.H : 3, k ? k.L : 6, 0, (k ? k.H : 3) / 2, 0, 'P')];
  }
}

// ---- geometry --------------------------------------------------------------------------------------
const tmpC = new THREE.Color();
const _m = new THREE.Matrix4(), _e = new THREE.Euler();

function partGeometry(p, lod) {
  let g;
  if (p.t === 'box') {
    const r = Math.min(p.r, p.w / 2 - 0.01, p.h / 2 - 0.01, p.d / 2 - 0.01);
    g = lod === 0 && r > 0.03 ? new RoundedBoxGeometry(p.w, p.h, p.d, 1, r) : new THREE.BoxGeometry(p.w, p.h, p.d);
  } else {
    g = new THREE.CylinderGeometry(p.rt, p.rb, p.h, lod === 0 ? p.seg : Math.max(6, Math.round(p.seg / 2)));
  }
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  _e.set(p.rx, p.ry, p.rz);
  _m.makeRotationFromEuler(_e).setPosition(p.x, p.y, p.z);
  g.applyMatrix4(_m);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), mask = new Float32Array(n);
  let m = 0;
  if (p.c === 'P') { tmpC.setRGB(1, 1, 1); m = 1; } else if (p.c === 'P2') { tmpC.setRGB(0.72, 0.72, 0.72); m = 1; } else tmpC.setHex(p.c);
  for (let i = 0; i < n; i++) { col[i * 3] = tmpC.r; col[i * 3 + 1] = tmpC.g; col[i * 3 + 2] = tmpC.b; mask[i] = m; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('paintMask', new THREE.BufferAttribute(mask, 1));
  return g;
}

const geoCache = new Map();
// kind may end in '_bare' for a two-wheeler without its rider (a full avatar rides it instead).
export function buildKindGeometry(kind, lod = 0) {
  const key = kind + '|' + lod;
  if (geoCache.has(key)) return geoCache.get(key);
  const bare = kind.endsWith('_bare');
  const base = bare ? kind.slice(0, -5) : kind;
  const parts = partsOf(base, { rider: !bare }).filter((p) => lod === 0 || !p.detail);
  const g = mergeGeometries(parts.map((p) => partGeometry(p, lod)), false);
  const sc = (KINDS[base] || {}).s || 1;
  if (sc !== 1) g.scale(sc, sc, sc);
  g.computeBoundingSphere();
  geoCache.set(key, g);
  return g;
}

let unitBox = null;
export function boxGeometry() {
  if (unitBox) return unitBox;
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  g.deleteAttribute('uv');
  g.translate(0, 0.5, 0);
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  g.setAttribute('paintMask', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  unitBox = g;
  return g;
}

let sharedMat = null;
export function vehicleMaterial() {
  if (sharedMat) return sharedMat;
  const m = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp() });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float paintMask;')
      .replace('#include <color_vertex>', `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.xyz *= mix( vec3( 1.0 ), instanceColor.xyz, paintMask );
#endif`);
  };
  m.customProgramCacheKey = () => 'vehicle-paint-mask';
  sharedMat = m;
  return m;
}

export function pickPaint(kind, rnd = Math.random) {
  const list = PAINTS[(KINDS[kind] || KINDS.sedan).paint] || PAINTS.car;
  let total = 0;
  for (const p of list) total += p.w;
  let r = rnd() * total;
  for (const p of list) { r -= p.w; if (r <= 0) return new THREE.Color(p.hex); }
  return new THREE.Color(list[0].hex);
}

// One-off mesh: previews, or the player's car if the engine wants to reuse a model.
export function buildVehicleMesh(kind, colorHex = 0xf4f4f2) {
  const geo = buildKindGeometry(kind, 0);
  const mesh = new THREE.InstancedMesh(geo, vehicleMaterial(), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.setColorAt(0, new THREE.Color(colorHex));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

// ---- instanced fleet ---------------------------------------------------------------------------------
// One InstancedMesh per (kind, lod) plus one shared far-box mesh. Each frame (or on demand):
//   fleet.begin(); fleet.add(kind, lod, matrix, color) ...; fleet.end();
// lod 0 near, 1 mid, 2 far box (matrix must already include the box scale).
export function createFleet(scene, kinds, { capacity = 256, farCapacity = 1024, shadows = true, name = 'fleet' } = {}) {
  const group = new THREE.Group();
  group.name = name;
  scene.add(group);
  const mat = vehicleMaterial();
  const slots = new Map();
  const mk = (geo, cap, castShadow) => {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    // Instances move all over the map; the per-instance culling is done by the caller.
    m.frustumCulled = false;
    m.castShadow = castShadow;
    m.receiveShadow = true;
    group.add(m);
    return { mesh: m, n: 0, cap };
  };
  for (const k of kinds) {
    const cap = typeof capacity === 'function' ? capacity(k) : capacity;
    slots.set(k + '|0', mk(buildKindGeometry(k, 0), cap, shadows));
    slots.set(k + '|1', mk(buildKindGeometry(k, 1), cap, false));
  }
  const far = mk(boxGeometry(), farCapacity, false);
  return {
    group,
    begin() { for (const s of slots.values()) s.n = 0; far.n = 0; },
    add(kind, lod, matrix, color) {
      const s = lod >= 2 ? far : slots.get(kind + '|' + lod);
      if (!s || s.n >= s.cap) return false;
      s.mesh.setMatrixAt(s.n, matrix);
      s.mesh.setColorAt(s.n, color);
      s.n++;
      return true;
    },
    end() {
      for (const s of [...slots.values(), far]) {
        const m = s.mesh;
        if (s.n === 0 && m.count === 0) continue;
        m.count = s.n;
        m.visible = s.n > 0;
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor.needsUpdate = true;
      }
    },
    counts() {
      const out = { far: far.n };
      for (const [k, s] of slots) if (s.n) out[k] = s.n;
      return out;
    },
    drawCalls() { let n = 0; for (const s of [...slots.values(), far]) if (s.n) n++; return n; },
    dispose() { scene.remove(group); for (const s of [...slots.values(), far]) s.mesh.dispose(); },
  };
}

export function triangleCount(kind, lod = 0) {
  const g = buildKindGeometry(kind, lod);
  return g.attributes.position.count / 3;
}
