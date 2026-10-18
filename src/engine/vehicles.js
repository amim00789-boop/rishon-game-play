// Movement modes and their chunky toon vehicles. Local forward is +z, units are world units
// (characters are ~5 units tall, Roblox-scale, so vehicles are scaled to match them).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toonMat } from './renderer.js';

export const MODES = ['walk', 'scooter', 'bike', 'car', 'skate'];

// Founder, round 3: characters and vehicles at 0.85 of their first size against the map (the
// traffic models use the same factor, src/vehicles/models.js VEHICLE_SCALE).
export const PLAYER_VEHICLE_SCALE = 0.85;
const VS = PLAYER_VEHICLE_SCALE;

// riderY: how high the avatar's feet sit; riderZ: fore/aft seat offset (both already scaled).
export const MODE_PARAMS = {
  // walk: a real walking pace on the default key, Shift for a full run (founder, round 5: 10 read as
  // a jog, the earlier stroll as far too slow); the gait sizes strides from distance moved
  // (src/characters/avatar.js gaitCycle), so cadence follows the speed
  walk:    { label: 'On foot',      speed: 6, run: 18, accel: 45, brake: 60, turn: 14, radius: 1.3 * VS, riderY: 0,         riderZ: 0,         canJump: true },
  scooter: { label: 'Kick scooter', speed: 22, run: 26, accel: 22, brake: 40, turn: 5.5, radius: 1.5 * VS, riderY: 0.55 * VS, riderZ: -0.2 * VS, canJump: true },
  bike:    { label: 'Bicycle',      speed: 30, run: 36, accel: 18, brake: 40, turn: 4.2, radius: 1.6 * VS, riderY: 1.25 * VS, riderZ: -0.6 * VS, canJump: true },
  car:     { label: 'Car',          speed: 55, run: 70, accel: 28, brake: 55, turn: 2.3, radius: 2.8 * VS, riderY: 1.0 * VS,  riderZ: -0.6 * VS, canJump: false, reverse: 16 },
  // skateboard (round 5): faster than the kick scooter, slower than the bike; Space pops an ollie
  skate:   { label: 'Skateboard',   speed: 25, run: 30, accel: 15, brake: 32, turn: 6.0, radius: 1.3 * VS, riderY: 0,         riderZ: 0,         canJump: true, jumpV: 13 },
};

// The player's car, in world units (round 5: rebuilt as a small hatchback the 0.85 avatar sits
// inside). Toon avatars have short legs and a big head, so a seated driver is relatively taller
// than a real one: the seat sits low (cushion near the wheel tops, legs forward to the pedals) and
// the roof clears the driver's cap, which makes the car about as tall as a standing avatar. It is
// wider than the traffic cars (src/vehicles/models.js): session C (2026-10-18) seats a quest
// rider (Adir, the bride) beside the driver, and two chunky avatars measure about 2.9 units across
// each with their arms in, so the cabin grew from 3.5 to 4.8 with the seats 2.5 apart.
// Israel drives on the right, so the driver sits on the left (+x).
export const CAR = {
  width: 4.8, length: 7.6, wheelR: 0.8, axleZ: 2.5, trackX: 2.05,
  // where the driver's seat surface is (the avatar's pelvis sits right above it)
  seat: { x: 1.2, y: 0.72, z: -0.6 },
  // the front passenger's seat, on the kerb side
  passenger: { x: -1.2, y: 0.72, z: -0.6 },
};

const M = {
  dark: () => toonMat(0x2d3142),
  metal: () => toonMat(0xc8ccd4),
  tyre: () => toonMat(0x262626),
};

function rbox(w, h, d, mat, r = 0.25) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function wheel(radius, width, mat, hubMat) {
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 18), mat);
  t.rotation.z = Math.PI / 2;
  t.castShadow = true;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.45, radius * 0.45, width * 1.05, 10), hubMat);
  hub.rotation.z = Math.PI / 2;
  g.add(t, hub);
  g.userData.radius = radius;
  return g;
}

function bar(len, thick, mat) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(thick, thick, len, 8), mat);
  m.castShadow = true;
  return m;
}

// Stand-in board for the fallback capsule; the characters module rides its own (props.js).
function makeSkateboard() {
  const g = new THREE.Group();
  const deck = rbox(1.0, 0.14, 3.4, toonMat(0x2f7bd6), 0.07);
  deck.position.set(0, 0.55, 0);
  g.add(deck);
  const wheels = [];
  for (const z of [1.0, -1.0]) for (const x of [0.42, -0.42]) {
    const w = wheel(0.2, 0.17, M.tyre(), M.metal());
    w.position.set(x, 0.2, z);
    w.userData.radius = 0.2;
    g.add(w);
    wheels.push(w);
  }
  return { group: g, wheels };
}

function makeScooter() {
  const g = new THREE.Group();
  const deck = rbox(1.1, 0.3, 3.4, toonMat(0x34c1b5), 0.14);
  deck.position.set(0, 0.5, 0);
  const metal = M.metal();
  const stem = bar(3.4, 0.12, metal);
  stem.position.set(0, 2.2, 1.55);
  stem.rotation.x = -0.12;
  const handle = bar(2.0, 0.1, metal);
  handle.rotation.z = Math.PI / 2;
  handle.position.set(0, 3.85, 1.75);
  const grips = [-0.95, 0.95].map((x) => { const m = bar(0.5, 0.16, toonMat(0xff6b6b)); m.rotation.z = Math.PI / 2; m.position.set(x, 3.85, 1.75); return m; });
  const wf = wheel(0.38, 0.35, M.tyre(), metal); wf.position.set(0, 0.38, 1.6);
  const wb = wheel(0.38, 0.35, M.tyre(), metal); wb.position.set(0, 0.38, -1.5);
  g.add(deck, stem, handle, ...grips, wf, wb);
  return { group: g, wheels: [wf, wb], steer: null };
}

function makeBike() {
  const g = new THREE.Group();
  const frameMat = toonMat(0xffb347);
  const metal = M.metal();
  const wf = wheel(1.05, 0.22, M.tyre(), metal); wf.position.set(0, 1.05, 1.75);
  const wb = wheel(1.05, 0.22, M.tyre(), metal); wb.position.set(0, 1.05, -1.75);
  const top = bar(3.0, 0.14, frameMat); top.rotation.x = Math.PI / 2 - 0.12; top.position.set(0, 2.25, 0.1);
  const down = bar(2.6, 0.14, frameMat); down.rotation.x = Math.PI / 2 + 0.75; down.position.set(0, 1.6, 0.65);
  const seatPost = bar(1.5, 0.12, frameMat); seatPost.position.set(0, 1.85, -0.75); seatPost.rotation.x = -0.25;
  const chainStay = bar(1.9, 0.1, frameMat); chainStay.rotation.x = Math.PI / 2; chainStay.position.set(0, 1.05, -0.85);
  const seat = rbox(0.6, 0.2, 1.0, M.dark(), 0.09); seat.position.set(0, 2.62, -0.95);
  const fork = bar(1.6, 0.1, metal); fork.position.set(0, 1.85, 1.6); fork.rotation.x = 0.2;
  const handle = bar(1.8, 0.09, metal); handle.rotation.z = Math.PI / 2; handle.position.set(0, 2.85, 1.35);
  const basket = rbox(1.1, 0.7, 0.8, toonMat(0xd9a066), 0.12); basket.position.set(0, 2.55, 2.05);
  g.add(wf, wb, top, down, seatPost, chainStay, seat, fork, handle, basket);
  return { group: g, wheels: [wf, wb], steer: null };
}

// A box between two points (pillars, the steering column).
function strut(a, b, w, d, mat) {
  const len = a.distanceTo(b);
  const m = rbox(w, len, d, mat, Math.min(w, d) * 0.4);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

// Flat glass from an outline of [z, y] points, standing in the car's side plane at x.
function sideGlass(points, x, mat) {
  const s = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const m = new THREE.Mesh(new THREE.ShapeGeometry(s), mat);
  m.rotation.y = -Math.PI / 2; // shape x -> car z
  m.position.x = x;
  return m;
}

function makeCar() {
  const { width: W, length: L, wheelR: R, axleZ, trackX, seat, passenger } = CAR;
  const g = new THREE.Group();
  const body = new THREE.Group();
  const paint = toonMat(0xff6f59);
  const cream = toonMat(0xfff3d6);
  const dark = M.dark();
  const trim = toonMat(0x2f333b);
  // see-through so the driver reads from the chase camera, like the toon cars it sits among
  const glassMat = new THREE.MeshToonMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const belt = 1.92, roofY = 3.9, hw = W / 2;
  const zWs = 1.55, zWsTop = 0.4, zRear = -3.45, zRearTop = -3.05; // windscreen and rear window feet/tops

  // lower body up to the beltline, trim strip, bumpers
  const shell = rbox(W, belt - 0.62, L, paint, 0.5); shell.position.y = (belt + 0.62) / 2;
  const sill = rbox(W + 0.04, 0.3, L - 0.7, trim, 0.12); sill.position.y = 0.78;
  const bumperF = rbox(W + 0.06, 0.5, 0.45, trim, 0.18); bumperF.position.set(0, 0.85, L / 2 - 0.12);
  const bumperB = rbox(W + 0.06, 0.5, 0.45, trim, 0.18); bumperB.position.set(0, 0.85, -L / 2 + 0.12);
  const bonnet = rbox(W - 0.5, 0.12, 1.6, paint, 0.05); bonnet.position.set(0, belt + 0.02, 2.65); // crease line
  body.add(shell, sill, bumperF, bumperB, bonnet);

  // cabin: pillars and roof in paint, glass between them
  const cabin = [];
  for (const s of [1, -1]) {
    cabin.push(strut(V(s * (hw - 0.14), belt - 0.05, zWs), V(s * (hw - 0.26), roofY, zWsTop), 0.2, 0.26, paint)); // A
    cabin.push(strut(V(s * (hw - 0.16), belt - 0.05, -1.45), V(s * (hw - 0.24), roofY, -1.45), 0.18, 0.34, paint)); // B
    cabin.push(strut(V(s * (hw - 0.14), belt - 0.05, zRear), V(s * (hw - 0.24), roofY, zRearTop), 0.2, 0.5, paint)); // C
    cabin.push(sideGlass([[zWs - 0.1, belt], [zWsTop - 0.05, roofY - 0.05], [zRearTop + 0.1, roofY - 0.05], [zRear + 0.15, belt]], s * (hw - 0.2), glassMat));
    const mirror = rbox(0.3, 0.28, 0.42, paint, 0.08); mirror.position.set(s * (hw + 0.12), belt + 0.22, zWs - 0.25);
    const handle = rbox(0.06, 0.1, 0.36, trim, 0.03); handle.position.set(s * (hw + 0.01), belt - 0.3, -1.85);
    const seamF = rbox(0.04, belt - 0.75, 0.05, trim, 0.01); seamF.position.set(s * (hw + 0.005), (belt + 0.7) / 2, zWs - 0.05);
    const seamB = rbox(0.04, belt - 0.75, 0.05, trim, 0.01); seamB.position.set(s * (hw + 0.005), (belt + 0.7) / 2, -1.45);
    cabin.push(mirror, handle, seamF, seamB);
  }
  // Roof as a frame round a glass panel: from the chase camera behind and above, the roof would
  // otherwise hide the driver completely.
  const roofD = zWsTop - zRearTop + 0.3, roofZ = (zWsTop + zRearTop) / 2;
  const roof = new THREE.Group();
  for (const s of [1, -1]) {
    const rail = rbox(0.5, 0.22, roofD, paint, 0.1); rail.position.set(s * (hw - 0.41), roofY + 0.08, roofZ);
    const header = rbox(W - 0.32, 0.22, 0.6, paint, 0.1); header.position.set(0, roofY + 0.08, roofZ + s * (roofD / 2 - 0.3));
    roof.add(rail, header);
  }
  const sunroof = new THREE.Mesh(new THREE.PlaneGeometry(W - 1.3, roofD - 1.15), glassMat);
  sunroof.rotation.x = -Math.PI / 2; sunroof.position.set(0, roofY + 0.1, roofZ);
  roof.add(sunroof);
  const wsLen = Math.hypot(roofY - belt, zWs - zWsTop);
  const windscreen = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.5, wsLen), glassMat);
  windscreen.position.set(0, (belt + roofY) / 2, (zWs + zWsTop) / 2);
  windscreen.rotation.x = -Math.atan2(zWs - zWsTop, roofY - belt);
  const rwLen = Math.hypot(roofY - belt, zRearTop - zRear);
  const rearScreen = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.6, rwLen), glassMat);
  rearScreen.position.set(0, (belt + roofY) / 2, (zRear + zRearTop) / 2);
  rearScreen.rotation.x = Math.atan2(zRearTop - zRear, roofY - belt);
  body.add(...cabin, roof, windscreen, rearScreen);

  // inside: dashboard, two front seats, steering wheel in front of the driver
  const dash = rbox(W - 0.4, 0.55, 0.75, dark, 0.15); dash.position.set(0, belt - 0.05, 1.15);
  const floor = rbox(W - 0.3, 0.1, L - 1.4, dark, 0.04); floor.position.set(0, 0.62, -0.3);
  body.add(dash, floor);
  for (const x of [seat.x, passenger.x]) {
    const cushion = rbox(1.3, 0.3, 1.25, cream, 0.12); cushion.position.set(x, seat.y - 0.15, seat.z - 0.15);
    const base = rbox(1.0, seat.y - 0.75, 0.9, dark, 0.05); base.position.set(x, (seat.y - 0.3 + 0.62) / 2, seat.z - 0.15);
    const back = rbox(1.3, 1.75, 0.3, cream, 0.12); back.position.set(x, seat.y + 0.8, seat.z - 0.9); back.rotation.x = -0.18;
    const rest = rbox(0.8, 0.45, 0.25, cream, 0.1); rest.position.set(x, seat.y + 1.85, seat.z - 1.1); rest.rotation.x = -0.18;
    body.add(cushion, back, rest);
    if (seat.y - 0.75 > 0.05) body.add(base);
  }
  // Steering wheel: centred on the driver, tilted with the column; the spinner turns with the
  // front wheels and carries the two grip points the driver's hands hold (carDriveTargets).
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(seat.x, seat.y + 1.2, seat.z + 0.95);
  wheelPivot.rotation.x = 0.45;
  const spinner = new THREE.Group();
  wheelPivot.add(spinner);
  const rimR = 0.6;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.08, 8, 24), dark); rim.castShadow = true;
  const spoke = rbox(rimR * 2, 0.1, 0.06, dark, 0.03);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.12, 12), toonMat(0x8a8f96)); hub.rotation.x = Math.PI / 2;
  spinner.add(rim, spoke, hub);
  const column = strut(V(seat.x, seat.y + 1.2, seat.z + 0.95), V(seat.x, belt - 0.2, 1.0), 0.14, 0.14, dark);
  body.add(wheelPivot, column);

  // lights, Israeli yellow plates, grille
  const lamp = toonMat(0xfffbe0, { emissive: 0xfff2a8, emissiveIntensity: 0.6 });
  const tail = toonMat(0xd7263d);
  const plate = toonMat(0xf5c400);
  for (const s of [1, -1]) {
    const l = rbox(0.75, 0.42, 0.14, lamp, 0.12); l.position.set(s * (hw - 0.55), 1.62, L / 2 + 0.01);
    const t = rbox(0.55, 0.5, 0.14, tail, 0.1); t.position.set(s * (hw - 0.4), 1.6, -L / 2 - 0.01);
    body.add(l, t);
  }
  const grille = rbox(1.4, 0.32, 0.08, trim, 0.06); grille.position.set(0, 1.5, L / 2 + 0.02);
  const plateF = rbox(1.1, 0.3, 0.06, plate, 0.03); plateF.position.set(0, 0.88, L / 2 + 0.12);
  const plateB = rbox(1.1, 0.3, 0.06, plate, 0.03); plateB.position.set(0, 1.18, -L / 2 - 0.02);
  const stripe = rbox(W + 0.02, 0.16, L - 1.2, cream, 0.06); stripe.position.y = belt - 0.45;
  body.add(grille, plateF, plateB, stripe);
  g.add(body);

  const wheels = [];
  const steerers = [];
  for (const [x, z] of [[-trackX, axleZ], [trackX, axleZ], [-trackX, -axleZ], [trackX, -axleZ]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, R, z);
    const w = wheel(R, 0.62, M.tyre(), cream);
    pivot.add(w);
    g.add(pivot);
    wheels.push(w);
    if (z > 0) steerers.push(pivot);
  }
  return { group: g, wheels, steer: steerers, body, wheelPivot, spinner, rimR, worldUnits: true };
}

// Where the driver's hands and feet go, relative to `origin` (the avatar's origin in the car's
// frame, i.e. the rider group's position): the two rim points at 9 and 3 o'clock as the wheel turns,
// and the pedals on the floor ahead of the seat. World units.
const _dm = new THREE.Matrix4(), _dv = new THREE.Vector3();
export function carDriveTargets(v, origin) {
  if (!v || !v.spinner) return null;
  v.body.updateMatrix(); v.wheelPivot.updateMatrix(); v.spinner.updateMatrix();
  _dm.multiplyMatrices(v.body.matrix, v.wheelPivot.matrix).multiply(v.spinner.matrix);
  const grips = [1, -1].map((s) => {
    _dv.set(s * v.rimR, 0, 0).applyMatrix4(_dm).sub(origin);
    return [_dv.x, _dv.y, _dv.z];
  });
  const { seat } = CAR;
  const pedals = [1, -1].map((s) => [seat.x + s * 0.4 - origin.x, 0.68 - origin.y, seat.z + 1.15 - origin.z]);
  return { grips, pedals };
}

export function createVehicles() {
  const out = { scooter: makeScooter(), bike: makeBike(), car: makeCar(), skate: makeSkateboard() };
  for (const v of Object.values(out)) {
    if (v.worldUnits) continue; // the car is built at its final size
    v.group.scale.setScalar(VS);
    // animateVehicle spins wheels by distance / radius: use the drawn (scaled) radius.
    for (const w of v.wheels) w.userData.radius *= VS;
  }
  return out;
}

// Spin wheels from distance travelled; tilt the car body into turns for a squashy feel.
export function animateVehicle(v, dt, speed, steer, turnRate) {
  if (!v) return;
  for (const w of v.wheels) w.rotation.x += (speed * dt) / (w.userData.radius || 1);
  if (v.steer) for (const s of v.steer) s.rotation.y += (steer * 0.45 - s.rotation.y) * Math.min(1, dt * 10);
  // steering wheel: a left turn (steer > 0) swings its top toward the driver's left (+x)
  if (v.spinner && v.steer) v.spinner.rotation.z = -v.steer[0].rotation.y * 3;
  if (v.body) {
    const roll = THREE.MathUtils.clamp(-turnRate * speed * 0.004, -0.09, 0.09);
    v.body.rotation.z += (roll - v.body.rotation.z) * Math.min(1, dt * 6);
  }
}
