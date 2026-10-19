// The skate park pool: one analytic shape shared by the world mesh (landmarks.js buildSkatePark)
// and the skate minigame's physics (engine/skate/rider.js), so the rider rolls on exactly what is
// drawn. Bowl-local space: origin at the centre of the flat floor, y up from the floor, x/z as the
// park group's local axes.
//
// Shape: a flat rounded-rectangle floor (half sizes fx, fz) ringed by a circular transition of
// radius Rt that rises to the coping at distance Ec from the floor's edge (Ec < Rt, so the wall
// stops just short of vertical), then a flat deck of width `deck` at the coping height H and an
// outer wall down to the park slab. e = distance from a point to the floor rectangle; the
// transition height is Rt - sqrt(Rt^2 - e^2). A low kicker wedge and a flat bar sit on the floor.
import * as THREE from 'three';

// Fit a pool into an outer box (half sizes ox, oz, the outer edge of the deck), with room left for
// a transition of up to Rt units.
export function bowlSpec({ cx = 0, cy = 0, cz = 0, ox, oz, Rt = 5, wall = 0.975, deck = 1.6 }) {
  const Ec = Rt * wall;
  const H = Rt - Math.sqrt(Rt * Rt - Ec * Ec);
  const fx = Math.max(2, ox - deck - Ec), fz = Math.max(1.5, oz - deck - Ec);
  // Kicker in the east part of the floor, rising toward the west (ride in off the east wall, launch
  // over the middle); flat bar in the west part along the long axis.
  const kick = { x0: fx * 0.42, x1: fx * 0.42 + 3.2, z0: -1.6, z1: 1.6, h: 1.1 };
  const rail = { x0: -fx * 0.78, x1: -fx * 0.28, z: 0, y: 0.85 };
  return { cx, cy, cz, fx, fz, Rt, Ec, H, deck, kick, rail };
}

// Distance outside the floor rectangle and the outward unit normal there (normal is 0,0 on the floor).
export function bowlE(s, x, z) {
  const qx = Math.max(Math.abs(x) - s.fx, 0), qz = Math.max(Math.abs(z) - s.fz, 0);
  const e = Math.hypot(qx, qz);
  return e > 1e-6 ? { e, nx: (qx / e) * Math.sign(x), nz: (qz / e) * Math.sign(z) } : { e: 0, nx: 0, nz: 0 };
}
const trans = (s, e) => s.Rt - Math.sqrt(Math.max(0, s.Rt * s.Rt - e * e));
const kickerH = (s, x, z) => {
  const k = s.kick;
  if (x < k.x0 || x > k.x1 || z < k.z0 || z > k.z1) return 0;
  return (k.h * (k.x1 - x)) / (k.x1 - k.x0);
};

// Riding surface in bowl-local space -> { h, gx, gz, zone } or null outside the deck.
// gx, gz: the height gradient. zone: 'floor' | 'wall' | 'deck'.
export function bowlHeight(s, x, z) {
  const { e, nx, nz } = bowlE(s, x, z);
  if (e <= s.Ec) {
    if (e <= 0) {
      const kh = kickerH(s, x, z), k = s.kick;
      return kh > 0 ? { h: kh, gx: -k.h / (k.x1 - k.x0), gz: 0, zone: 'floor' } : { h: 0, gx: 0, gz: 0, zone: 'floor' };
    }
    const m = e / Math.sqrt(Math.max(1e-4, s.Rt * s.Rt - e * e));
    return { h: trans(s, e), gx: nx * m, gz: nz * m, zone: 'wall' };
  }
  if (e <= s.Ec + s.deck) return { h: s.H, gx: 0, gz: 0, zone: 'deck' };
  return null;
}

// Nearest point on the coping line (e = Ec) and the tangent there (counter-clockwise seen from above).
export function copingAt(s, x, z) {
  const qx = Math.max(-s.fx, Math.min(s.fx, x)), qz = Math.max(-s.fz, Math.min(s.fz, z));
  let dx = x - qx, dz = z - qz, l = Math.hypot(dx, dz);
  if (l < 1e-5) {
    // inside the floor: push out across the nearer side
    const px = s.fx - Math.abs(x), pz = s.fz - Math.abs(z);
    if (px < pz) { dx = Math.sign(x) || 1; dz = 0; } else { dx = 0; dz = Math.sign(z) || 1; }
    l = 1;
  }
  const nx = dx / l, nz = dz / l;
  return { x: qx + nx * s.Ec, z: qz + nz * s.Ec, nx, nz, tx: -nz, tz: nx };
}

// Perimeter samples of the floor rectangle: base point + outward normal, closed loop, CCW from above
// in a right-handed x/z view (x east, z south). Same samples for every ring, so rings join as quads.
function perimeter(s, side = 1.4, arc = 9) {
  const out = [];
  const corner = (bx, bz, a0) => { for (let i = 0; i < arc; i++) { const a = a0 + (i / arc) * (Math.PI / 2); out.push([bx, bz, Math.cos(a), Math.sin(a)]); } };
  const edge = (ax, az, bx, bz, nx, nz) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / side));
    for (let i = 0; i < n; i++) out.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n, nx, nz]);
  };
  const { fx, fz } = s;
  corner(fx, fz, 0); edge(fx, fz, -fx, fz, 0, 1);
  corner(-fx, fz, Math.PI / 2); edge(-fx, fz, -fx, -fz, -1, 0);
  corner(-fx, -fz, Math.PI); edge(-fx, -fz, fx, -fz, 0, -1);
  corner(fx, -fz, Math.PI * 1.5); edge(fx, -fz, fx, fz, 1, 0);
  return out;
}

// Outer edge of the deck as a polygon in bowl-local x/z (for a collider).
export function bowlOutline(s, pad = 0) {
  return perimeter(s, 3, 4).map(([bx, bz, nx, nz]) => [bx + nx * (s.Ec + s.deck + pad), bz + nz * (s.Ec + s.deck + pad)]);
}

// Rings (e, y) of the lathe-like profile: transition, deck, outer wall.
function rings(s) {
  const R = [];
  const phiMax = Math.asin(s.Ec / s.Rt), K = 14;
  for (let k = 0; k <= K; k++) { const e = s.Rt * Math.sin((k / K) * phiMax); R.push([e, trans(s, e)]); }
  R.push([s.Ec + s.deck, s.H]);
  R.push([s.Ec + s.deck, -s.cy]);
  return R;
}

// Geometry of the whole pool in bowl-local space (indexed, smooth normals), plus a colour function
// for landmarks' Batch (gets a triangle centroid in this space).
export function bowlGeometry(s) {
  const P = perimeter(s), R = rings(s), n = P.length;
  // Smooth normals within the transition only: the coping and the deck edge are hard creases
  // (shared normals there banded each quad in two under the toon ramp).
  const strip = (r0, r1) => {
    const pos = [], idx = [];
    for (let r = r0; r <= r1; r++) { const [e, y] = R[r]; for (const [bx, bz, nx, nz] of P) pos.push(bx + nx * e, y, bz + nz * e); }
    for (let r = 0; r < r1 - r0; r++) {
      for (let i = 0; i < n; i++) {
        const a = r * n + i, b = r * n + ((i + 1) % n), c = (r + 1) * n + i, d = (r + 1) * n + ((i + 1) % n);
        // faces point into the pool (up the walls); the outer wall faces out
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const out = g.toNonIndexed();
    g.dispose();
    return out;
  };
  const K = R.length - 3;
  const parts = [strip(0, K), strip(K, K + 1), strip(K + 1, K + 2)];
  // floor
  const floor = new THREE.PlaneGeometry(s.fx * 2, s.fz * 2, 1, 1);
  floor.rotateX(-Math.PI / 2);
  parts.push(floor.toNonIndexed());
  // kicker wedge (top slope, west face, two sides)
  const k = s.kick, kw = new THREE.BufferGeometry();
  const v = (x, y, z) => [x, y, z];
  const A = v(k.x1, 0, k.z0), B = v(k.x1, 0, k.z1), C = v(k.x0, k.h, k.z1), D = v(k.x0, k.h, k.z0), E = v(k.x0, 0, k.z1), F = v(k.x0, 0, k.z0);
  const tri = [A, C, B, A, D, C, D, E, C, D, F, E, A, F, D, B, C, E].flat();
  kw.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
  kw.computeVertexNormals();
  parts.push(kw);
  // flat bar: a round rail on two posts
  const rl = s.rail, len = rl.x1 - rl.x0;
  const bar = new THREE.CylinderGeometry(0.1, 0.1, len, 8, 1);
  bar.rotateZ(Math.PI / 2); bar.translate((rl.x0 + rl.x1) / 2, rl.y, rl.z);
  parts.push(bar.toNonIndexed());
  for (const x of [rl.x0 + 0.4, rl.x1 - 0.4]) { const p = new THREE.BoxGeometry(0.14, rl.y, 0.14); p.translate(x, rl.y / 2, rl.z); parts.push(p.toNonIndexed()); }
  // coping: a steel pipe along the lip
  const cp = perimeter(s, 1.0, 10).map(([bx, bz, nx, nz]) => new THREE.Vector3(bx + nx * s.Ec, s.H + 0.06, bz + nz * s.Ec));
  const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cp, true), cp.length * 2, 0.14, 6, true);
  parts.push(tube.toNonIndexed());
  [floor, bar, tube].forEach((g) => g.dispose());
  const out = mergeSimple(parts);
  for (const g of parts) g.dispose();
  return out;
}

// Concatenate non-indexed position+normal geometries (no addons import needed here).
function mergeSimple(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

// Colours by ring (whole quads share a band, so no zig-zag edges) and place: pale floor, darker transition, white top band, steel coping and bar,
// a warm painted kicker.
export function bowlColor(s) {
  return (x, y, z) => {
    const { e } = bowlE(s, x, z);
    if (e > s.Ec + s.deck - 0.05) return 0xb9bcbd;           // outer wall
    if (Math.abs(e - s.Ec) < 0.3 && y > s.H - 0.1) return 0x6f7880; // coping (the top wall triangles stay below H - 0.16)
    if (e <= 0.02 && y > 0.02) {
      if (x >= s.kick.x0 - 0.01 && x <= s.kick.x1 + 0.01 && z >= s.kick.z0 - 0.01 && z <= s.kick.z1 + 0.01) return 0xe0703a;
      return 0x6f7880;                                         // flat bar
    }
    if (e > s.Ec + 0.02) return 0xd3d5d5;                      // deck
    if (e > s.Ec - 0.5) return 0xe9ecec;                       // white band under the lip
    if (e > 0.02) return 0x9fa4a6;                             // transition
    return 0xb7babb;                                           // floor
  };
}
