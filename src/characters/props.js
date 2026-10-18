// Vehicle and carry props that belong to an avatar. Built in the same concept units as the rig
// (they live inside the scaled body group, so a kid automatically gets a kid-size scooter).
import * as THREE from 'three';
import { mat, rbox, addMesh } from './rig.js';
import { patternTexture, shade } from './textures.js';

// Points the rider's IK aims at, in body units.
// Round 5: a longer deck on bigger wheels, so two chunky toon feet fit on it with room to spare
// (the old 2.6-unit deck on 0.27 wheels read as a toy next to the 0.85 avatar).
export const SCOOTER = {
  deckTop: 0.36, gripY: 3.8, gripZ: 1.95, gripX: 1.0, wheelR: 0.34,
};
export const BIKE = {
  wheelR: 1.0, bbY: 0.95, bbZ: 0.0, crank: 0.45, seatY: 2.5, seatZ: -0.6,
  gripY: 3.3, gripZ: 1.1, gripX: 0.95, pedalX: 0.62,
};

function tube(parent, a, b, r, m) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  const mesh = addMesh(parent, g, m);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return mesh;
}

function wheel(parent, r, tyre, rimColor, spokes) {
  const w = new THREE.Group();
  parent.add(w);
  const t = addMesh(w, new THREE.TorusGeometry(r - 0.09, 0.1, 8, 28), mat(tyre));
  t.rotation.y = Math.PI / 2;
  if (spokes) {
    const rim = addMesh(w, new THREE.TorusGeometry(r - 0.2, 0.035, 6, 28), mat(rimColor));
    rim.rotation.y = Math.PI / 2;
    for (let i = 0; i < 6; i++) {
      const s = addMesh(w, new THREE.CylinderGeometry(0.025, 0.025, (r - 0.2) * 2, 4), mat('#d9d9d9'));
      s.rotation.x = (i / 6) * Math.PI;
    }
  } else {
    const hub = addMesh(w, new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.16, 14), mat(rimColor));
    hub.rotation.z = Math.PI / 2;
  }
  const hub = addMesh(w, new THREE.CylinderGeometry(0.1, 0.1, 0.3, 8), mat('#555555'));
  hub.rotation.z = Math.PI / 2;
  return w;
}

export function buildScooter(color = '#2ec4b6') {
  const S = SCOOTER;
  const g = new THREE.Group();
  g.name = 'scooter';
  const body = mat(color);
  const dark = mat('#2b2b2b');
  addMesh(g, rbox(0.78, 0.14, 3.1, 0.05), body, 0, S.deckTop - 0.07, 0.1);
  addMesh(g, rbox(0.7, 0.03, 2.5, 0.01), mat('#333333'), 0, S.deckTop + 0.005, 0.05); // grip tape
  const rear = wheel(g, S.wheelR, '#222222', '#dddddd', false);
  rear.position.set(0, S.wheelR, -1.5);
  const front = wheel(g, S.wheelR, '#222222', '#dddddd', false);
  front.position.set(0, S.wheelR, 2.05);
  addMesh(g, rbox(0.55, 0.06, 0.7, 0.03), body, 0, S.wheelR * 2 + 0.04, -1.5); // rear brake fender
  tube(g, new THREE.Vector3(0, S.wheelR, 2.05), new THREE.Vector3(0, S.gripY, S.gripZ - 0.1), 0.09, mat('#c8c8c8'));
  tube(g, new THREE.Vector3(0, S.deckTop - 0.05, 1.6), new THREE.Vector3(0, 0.75, 2.0), 0.08, body);
  const bar = addMesh(g, new THREE.CylinderGeometry(0.07, 0.07, S.gripX * 2 + 0.3, 8), mat('#c8c8c8'), 0, S.gripY, S.gripZ);
  bar.rotation.z = Math.PI / 2;
  for (const s of [1, -1]) {
    const grip = addMesh(g, new THREE.CylinderGeometry(0.11, 0.11, 0.45, 8), dark, s * (S.gripX + 0.05), S.gripY, S.gripZ);
    grip.rotation.z = Math.PI / 2;
  }
  return { group: g, wheels: [rear, front], wheelR: S.wheelR };
}

export function buildBike(color = '#e8364f') {
  const B = BIKE;
  const g = new THREE.Group();
  g.name = 'bike';
  const frame = mat(color);
  const V = (y, z) => new THREE.Vector3(0, y, z);
  const rearHub = V(B.wheelR, -1.75);
  const frontHub = V(B.wheelR, 1.85);
  const bb = V(B.bbY, B.bbZ);
  const seatTop = V(2.25, -0.5);
  const headTop = V(2.65, 1.4);
  const headBot = V(2.05, 1.55);
  tube(g, rearHub, bb, 0.07, frame);
  tube(g, rearHub, seatTop, 0.07, frame);
  tube(g, bb, seatTop, 0.1, frame);
  tube(g, bb, headBot, 0.11, frame);
  tube(g, seatTop, headTop, 0.09, frame);
  tube(g, headTop, headBot, 0.12, frame);
  tube(g, headBot, frontHub, 0.08, mat('#c8c8c8'));
  tube(g, seatTop, V(B.seatY - 0.1, B.seatZ), 0.06, mat('#c8c8c8'));
  addMesh(g, rbox(0.62, 0.16, 1.0, 0.07), mat('#2b2b2b'), 0, B.seatY - 0.05, B.seatZ - 0.05);
  tube(g, headTop, V(B.gripY, B.gripZ + 0.25), 0.07, mat('#c8c8c8'));
  const bar = addMesh(g, new THREE.CylinderGeometry(0.065, 0.065, B.gripX * 2 + 0.3, 8), mat('#c8c8c8'), 0, B.gripY, B.gripZ + 0.2);
  bar.rotation.z = Math.PI / 2;
  for (const s of [1, -1]) {
    const grip = addMesh(g, new THREE.CylinderGeometry(0.1, 0.1, 0.45, 8), mat('#2b2b2b'), s * (B.gripX + 0.05), B.gripY, B.gripZ + 0.15);
    grip.rotation.z = Math.PI / 2;
  }
  // front basket: every Tel Aviv-area city bike has one
  const basket = mat('#c99a5a');
  addMesh(g, rbox(1.2, 0.7, 0.85, 0.08), basket, 0, 2.55, 2.15);
  addMesh(g, rbox(1.0, 0.1, 0.65, 0.04), mat(shade('#c99a5a', -0.35)), 0, 2.92, 2.15);
  // fenders
  for (const [hub, z] of [[rearHub, -1.75], [frontHub, 1.85]]) {
    const f = addMesh(g, new THREE.TorusGeometry(B.wheelR + 0.05, 0.05, 4, 16, Math.PI * 0.7), frame, 0, hub.y, z);
    f.rotation.y = Math.PI / 2;
    f.rotation.x = Math.PI * 0.15;
  }
  const rear = wheel(g, B.wheelR, '#222222', '#cfcfcf', true);
  rear.position.copy(rearHub);
  const front = wheel(g, B.wheelR, '#222222', '#cfcfcf', true);
  front.position.copy(frontHub);
  // crank + pedals
  const crank = new THREE.Group();
  crank.position.copy(bb);
  g.add(crank);
  addMesh(crank, new THREE.CylinderGeometry(0.28, 0.28, 0.08, 14), mat('#9a9a9a'), 0.28, 0, 0).rotation.z = Math.PI / 2;
  const pedals = [];
  for (const s of [1, -1]) {
    const arm = new THREE.Group();
    arm.rotation.x = s > 0 ? 0 : Math.PI;
    crank.add(arm);
    addMesh(arm, rbox(0.08, B.crank + 0.12, 0.14, 0.03), mat('#9a9a9a'), s * 0.4, -B.crank / 2, 0);
    const p = new THREE.Group();
    p.position.set(s * B.pedalX, -B.crank, 0);
    arm.add(p);
    addMesh(p, rbox(0.4, 0.08, 0.32, 0.03), mat('#2b2b2b'));
    pedals.push(p);
  }
  return { group: g, wheels: [rear, front], wheelR: B.wheelR, crank, pedals };
}

// Shopping trolley ("agala"): built with its axle at the origin and the handle straight up +y.
export const TROLLEY_LEN = 2.6;
export function buildTrolley(color = '#2f5d9a', alt = '#e8443a') {
  const outer = new THREE.Group();
  outer.name = 'trolley';
  const g = new THREE.Group();
  outer.add(g);
  const metal = mat('#bdbdbd');
  const tart = mat('#ffffff', { map: patternTexture({ color, pattern: 'tartan', alt, line: '#ffffff', band: 48 }) });
  addMesh(g, rbox(1.3, 1.75, 0.95, 0.22), tart, 0, 1.25, -0.15);
  addMesh(g, rbox(1.36, 0.22, 1.0, 0.1), mat(shade(color, -0.3)), 0, 2.12, -0.15);
  for (const s of [1, -1]) tube(g, new THREE.Vector3(s * 0.55, 0.05, 0.38), new THREE.Vector3(s * 0.45, TROLLEY_LEN, 0.38), 0.06, metal);
  const handle = addMesh(g, new THREE.CylinderGeometry(0.09, 0.09, 1.1, 8), mat('#2b2b2b'), 0, TROLLEY_LEN, 0.38);
  handle.rotation.z = Math.PI / 2;
  addMesh(g, rbox(1.2, 0.08, 0.6, 0.03), metal, 0, 0.12, 0.1); // toe plate
  const wheels = [];
  for (const s of [1, -1]) {
    const w = new THREE.Group();
    w.position.set(s * 0.72, 0, 0);
    g.add(w);
    const t = addMesh(w, new THREE.CylinderGeometry(0.34, 0.34, 0.16, 14), mat('#2b2b2b'));
    t.rotation.z = Math.PI / 2;
    addMesh(w, new THREE.CylinderGeometry(0.16, 0.16, 0.18, 10), mat('#e0e0e0')).rotation.z = Math.PI / 2;
    wheels.push(w);
  }
  return { group: outer, frame: g, wheels, wheelR: 0.34, handleZ: 0.38 };
}

// Baby stroller, pushed in front. Built with the push bar at the origin height STROLLER.handleY
// and z = 0; the pram itself extends toward +z. Wheels sit on y = 0.
export const STROLLER = { handleY: 3.3, gripX: 1.05, ahead: 1.9 };
export function buildStroller(color = '#2fb3a6') {
  const g = new THREE.Group();
  g.name = 'stroller';
  const H = STROLLER.handleY;
  const frame = mat('#3a3f45');
  const body = mat(color);
  const dark = mat(shade(color, -0.3));
  const bar = addMesh(g, new THREE.CylinderGeometry(0.09, 0.09, 2.3, 8), mat('#1e2226'), 0, H, 0);
  bar.rotation.z = Math.PI / 2;
  for (const s of [1, -1]) {
    tube(g, new THREE.Vector3(s * 1.05, H, 0), new THREE.Vector3(s * 0.65, 1.15, 1.2), 0.06, frame);
    tube(g, new THREE.Vector3(s * 0.65, 1.15, 1.2), new THREE.Vector3(s * 0.7, 0.4, 2.6), 0.06, frame);
    tube(g, new THREE.Vector3(s * 0.65, 1.15, 1.2), new THREE.Vector3(s * 0.7, 0.4, 0.7), 0.06, frame);
  }
  addMesh(g, rbox(1.45, 0.85, 2.0, 0.3), body, 0, 1.75, 1.75);
  addMesh(g, rbox(1.25, 0.1, 1.6, 0.04), mat(shade(color, 0.45)), 0, 2.18, 1.85);
  // hood over the baby's end
  addMesh(g, rbox(1.5, 0.95, 0.85, 0.35), dark, 0, 2.45, 1.05);
  addMesh(g, new THREE.SphereGeometry(0.32, 10, 8), mat('#f0c8a0'), 0, 2.32, 1.62);
  addMesh(g, rbox(0.8, 0.5, 0.6, 0.2), mat('#ffffff', { map: patternTexture({ color: '#ffffff', pattern: 'dots', alt: color }) }), 0, 1.95, 2.25);
  const wheels = [];
  for (const [x, z] of [[0.72, 0.7], [-0.72, 0.7], [0.72, 2.6], [-0.72, 2.6]]) {
    const w = new THREE.Group();
    w.position.set(x, 0.4, z);
    g.add(w);
    const t = addMesh(w, new THREE.CylinderGeometry(0.4, 0.4, 0.14, 14), mat('#2b2b2b'));
    t.rotation.z = Math.PI / 2;
    addMesh(w, new THREE.CylinderGeometry(0.18, 0.18, 0.16, 8), mat('#d9d9d9')).rotation.z = Math.PI / 2;
    wheels.push(w);
  }
  return { group: g, wheels, wheelR: 0.4 };
}

// Dog on a leash, walked at the owner's left. Built facing +z with its paws on y = 0; the leash
// clips to `collar` (local position). Legs are pivot groups at the shoulders and hips so the
// owner's update can trot them. `size` scales a small dog up to a big one; `ears` is 'flop' or 'up'.
export function buildDog(color = '#c98b4a', alt = '#ffffff', size = 1, ears = 'flop') {
  const outer = new THREE.Group();
  outer.name = 'dog';
  const g = new THREE.Group();
  g.scale.setScalar(size);
  outer.add(g);
  const fur = mat(color);
  const pale = mat(alt);
  const dark = mat('#1e140f');
  const LEG = 0.78;
  const torso = new THREE.Group();
  torso.position.set(0, LEG + 0.35, 0);
  g.add(torso);
  addMesh(torso, rbox(0.82, 0.78, 1.9, 0.3), fur, 0, 0, 0);
  addMesh(torso, rbox(0.66, 0.3, 1.2, 0.12), pale, 0, -0.3, 0.2); // light belly
  const head = new THREE.Group();
  head.position.set(0, 0.45, 1.05);
  torso.add(head);
  addMesh(head, rbox(0.78, 0.72, 0.78, 0.26), fur, 0, 0.12, 0.1);
  addMesh(head, rbox(0.5, 0.38, 0.5, 0.14), pale, 0, -0.03, 0.62);
  addMesh(head, rbox(0.22, 0.16, 0.12, 0.06), dark, 0, 0.1, 0.88); // nose
  for (const s of [1, -1]) {
    addMesh(head, rbox(0.12, 0.14, 0.06, 0.04), dark, s * 0.2, 0.3, 0.5); // eyes
    const ear = addMesh(head, rbox(0.22, 0.42, 0.14, 0.07), mat(shade(color, -0.25)), s * 0.38, ears === 'up' ? 0.62 : 0.28, -0.02);
    ear.rotation.z = ears === 'up' ? s * -0.15 : s * 0.35;
  }
  const collar = addMesh(torso, rbox(0.86, 0.14, 0.4, 0.06), mat('#e8364f'), 0, 0.42, 0.88);
  collar.rotation.x = 0.5;
  const tail = new THREE.Group();
  tail.position.set(0, 0.22, -0.95);
  torso.add(tail);
  addMesh(tail, rbox(0.18, 0.18, 0.7, 0.08), fur, 0, 0.18, -0.3).rotation.x = 0.6;
  const legs = [];
  for (const [x, z] of [[0.26, 0.68], [-0.26, 0.68], [0.26, -0.68], [-0.26, -0.68]]) {
    const leg = new THREE.Group();
    leg.position.set(x, -0.2, z);
    torso.add(leg);
    addMesh(leg, rbox(0.26, LEG + 0.15, 0.3, 0.1), fur, 0, -LEG / 2 - 0.05, 0);
    addMesh(leg, rbox(0.3, 0.14, 0.38, 0.06), pale, 0, -LEG - 0.1, 0.05);
    legs.push(leg);
  }
  return { group: outer, torso, head, tail, legs, collar: new THREE.Vector3(0, (LEG + 0.35 + 0.45) * size, 0.95 * size) };
}

// Open guitar case on the pavement in front of a busker, a few coins inside.
export function buildGuitarCase(color = '#2b2b2b', lining = '#b8433a') {
  const g = new THREE.Group();
  g.name = 'guitarCase';
  addMesh(g, rbox(1.4, 0.32, 3.0, 0.12), mat(color), 0, 0.16, 0);
  addMesh(g, rbox(1.15, 0.06, 2.7, 0.04), mat(lining), 0, 0.31, 0);
  const lid = addMesh(g, rbox(1.4, 0.12, 3.0, 0.05), mat(color), 0, 0.85, -0.82);
  lid.rotation.x = -1.2;
  for (const [x, z] of [[0.2, 0.5], [-0.25, 0.1], [0.05, -0.4]]) addMesh(g, new THREE.CylinderGeometry(0.13, 0.13, 0.05, 10), mat('#d8b24a'), x, 0.36, z);
  return { group: g };
}

// Drum kit in front of a seated drummer (body units, drummer's pelvis over the origin, facing +z).
// `stool` is the seat top height. Exported hit points are where the sticks land.
export const DRUMS = {
  stool: 1.95,
  snare: [0.55, 2.55, 1.35], hihat: [-1.35, 3.05, 1.2], tom: [0.1, 3.3, 2.0], ride: [1.75, 3.7, 1.75], floor: [-1.7, 2.3, 1.55],
  kick: [0, 0.4, 1.45],
};
export function buildDrumKit(color = '#c2405a') {
  const g = new THREE.Group();
  g.name = 'drumKit';
  const shell = mat(color);
  const head = mat('#f4efe2');
  const chrome = mat('#cfd3d6');
  const brass = mat('#d8b24a');
  const D = DRUMS;
  const cyl = (rt, rb, h, seg = 18) => new THREE.CylinderGeometry(rt, rb, h, seg);
  // stool
  addMesh(g, cyl(0.75, 0.75, 0.3), mat('#2b2b2b'), 0, D.stool - 0.15, -0.1);
  addMesh(g, cyl(0.08, 0.08, D.stool - 0.3, 8), chrome, 0, (D.stool - 0.3) / 2, -0.1);
  addMesh(g, cyl(0.6, 0.6, 0.08, 10), chrome, 0, 0.04, -0.1);
  // bass drum lying on its side, front head toward the audience
  const bd = addMesh(g, cyl(1.15, 1.15, 1.3, 24), shell, 0, 1.15, 2.6);
  bd.rotation.x = Math.PI / 2;
  const bh = addMesh(g, cyl(1.05, 1.05, 0.04, 24), head, 0, 1.15, 3.27);
  bh.rotation.x = Math.PI / 2;
  addMesh(g, rbox(0.5, 0.25, 0.7, 0.08), chrome, 0, 0.15, 1.6); // pedal
  // snare, rack tom, floor tom
  addMesh(g, cyl(0.62, 0.62, 0.45), shell, D.snare[0], D.snare[1] - 0.25, D.snare[2]);
  addMesh(g, cyl(0.6, 0.6, 0.04), head, D.snare[0], D.snare[1], D.snare[2]);
  addMesh(g, cyl(0.05, 0.05, D.snare[1] - 0.45, 6), chrome, D.snare[0], (D.snare[1] - 0.45) / 2, D.snare[2]);
  const tom = addMesh(g, cyl(0.55, 0.55, 0.55), shell, D.tom[0], D.tom[1] - 0.25, D.tom[2]);
  tom.rotation.x = 0.35;
  addMesh(g, cyl(0.7, 0.7, 0.9), shell, D.floor[0], D.floor[1] - 0.45, D.floor[2]);
  addMesh(g, cyl(0.68, 0.68, 0.04), head, D.floor[0], D.floor[1], D.floor[2]);
  for (const s of [0.4, -0.4]) addMesh(g, cyl(0.05, 0.05, D.floor[1] - 0.9, 6), chrome, D.floor[0] + s, (D.floor[1] - 0.9) / 2, D.floor[2]);
  // hi-hat and ride cymbals on stands
  for (const [p, r] of [[D.hihat, 0.7], [D.ride, 0.95]]) {
    addMesh(g, cyl(0.05, 0.05, p[1], 6), chrome, p[0], p[1] / 2, p[2]);
    const c = addMesh(g, cyl(r, r, 0.05, 20), brass, p[0], p[1] + 0.05, p[2]);
    c.rotation.x = 0.12;
  }
  addMesh(g, cyl(0.68, 0.68, 0.05, 20), brass, D.hihat[0], D.hihat[1] - 0.12, D.hihat[2]);
  return { group: g };
}

// Skateboard under the rider's feet (deck top at SKATE.deckTop), nose toward +z.
export const SKATE = { deckTop: 0.62, wheelR: 0.2, nose: 1.22 }; // nose/tail kink, body units from the centre
export function buildSkateboard(color = '#e8364f', grip = '#2b2b2b') {
  const outer = new THREE.Group();
  outer.name = 'skateboard';
  const g = new THREE.Group();
  outer.add(g);
  const T = SKATE.deckTop, deckM = mat(color), gripM = mat(grip), metal = mat('#c3c7cc'), dark = mat('#5a5f66');
  // popsicle deck: a flat middle between the trucks, nose and tail kicked up (the tail a little
  // steeper and shorter, as on a real board), black grip tape on top
  addMesh(g, rbox(1.0, 0.12, 2.5, 0.06), deckM, 0, T - 0.06, 0);
  addMesh(g, rbox(0.94, 0.03, 2.4, 0.015), gripM, 0, T + 0.005, 0);
  for (const [z, len, kick] of [[1, 0.62, 0.32], [-1, 0.55, 0.38]]) {
    const end = new THREE.Group();
    end.position.set(0, T - 0.06, z * 1.22);
    end.rotation.x = -z * kick;
    g.add(end);
    addMesh(end, rbox(1.0, 0.12, len, 0.06), deckM, 0, 0, z * len * 0.45);
    addMesh(end, rbox(0.94, 0.03, len - 0.06, 0.015), gripM, 0, 0.065, z * len * 0.43);
  }
  // trucks: baseplate under the deck, kingpin, a hanger and the axle, four urethane wheels
  const wheels = [];
  for (const z of [0.95, -0.95]) {
    addMesh(g, rbox(0.42, 0.06, 0.5, 0.02), dark, 0, T - 0.15, z);
    addMesh(g, new THREE.CylinderGeometry(0.05, 0.05, 0.18, 6), metal, 0, T - 0.24, z - Math.sign(z) * 0.08);
    addMesh(g, rbox(0.62, 0.13, 0.22, 0.05), metal, 0, SKATE.wheelR + 0.08, z);
    const axle = addMesh(g, new THREE.CylinderGeometry(0.035, 0.035, 1.02, 6), metal, 0, SKATE.wheelR, z);
    axle.rotation.z = Math.PI / 2;
    for (const x of [0.43, -0.43]) {
      const w = addMesh(g, new THREE.CylinderGeometry(SKATE.wheelR, SKATE.wheelR, 0.17, 12), mat('#f4efe2'), x, SKATE.wheelR, z);
      w.rotation.z = Math.PI / 2;
      wheels.push(w);
    }
  }
  return { group: outer, deck: g, wheels };
}

// Mitzi the cat (round 5 story): a very old ginger cat with opinions, in world units (about 1.5
// long, nose toward +z, feet on y = 0). update(dt, speed) walks her with a cat's four-beat gait
// (left hind, left fore, right hind, right fore) whose stride matches the ground speed, so her
// paws do not skate; the head bobs, the tail sways with a curl at the tip, and when she stops she
// sits down on her haunches and looks about.
export function buildCat(color = '#e08a3a', stripe = '#c56f22', belly = '#f4dcc0') {
  const cyl = (rt, rb, h, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
  const ball = (r) => new THREE.SphereGeometry(r, 8, 6);
  const group = new THREE.Group();
  group.name = 'cat';
  const fur = mat(color), dk = mat(stripe), lt = mat(belly);
  const body = new THREE.Group();
  body.position.y = 0.62;
  group.add(body);
  addMesh(body, rbox(0.62, 0.5, 1.15, 0.22), fur, 0, 0, 0);
  addMesh(body, rbox(0.5, 0.2, 0.9, 0.09), lt, 0, -0.18, 0.02);
  for (const z of [-0.3, 0, 0.3]) addMesh(body, rbox(0.64, 0.08, 0.1, 0.03), dk, 0, 0.2, z);
  const neck = new THREE.Group();
  neck.position.set(0, 0.18, 0.5);
  body.add(neck);
  const head = new THREE.Group();
  head.position.set(0, 0.2, 0.2);
  neck.add(head);
  addMesh(head, rbox(0.5, 0.42, 0.42, 0.18), fur, 0, 0, 0);
  addMesh(head, rbox(0.26, 0.16, 0.14, 0.06), lt, 0, -0.08, 0.22);
  addMesh(head, ball(0.035), mat('#d0546a'), 0, -0.02, 0.29);
  for (const s of [1, -1]) {
    const ear = addMesh(head, new THREE.ConeGeometry(0.1, 0.2, 4), fur, s * 0.15, 0.27, -0.02);
    ear.rotation.y = Math.PI / 4;
    addMesh(head, rbox(0.1, 0.05, 0.03, 0.01), mat('#2a4a2a'), s * 0.11, 0.05, 0.21); // sleepy old eyes
    for (const k of [-1, 1]) addMesh(head, rbox(0.22, 0.012, 0.012, 0.004), mat('#f4efe2'), s * 0.2, -0.08 + k * 0.03, 0.22).rotation.z = s * k * 0.15;
  }
  const legs = [];
  for (const [x, z, hind, ph] of [[-0.2, -0.42, true, 0], [-0.2, 0.42, false, 0.25], [0.2, -0.42, true, 0.5], [0.2, 0.42, false, 0.75]]) {
    const hip = new THREE.Group();
    hip.position.set(x, -0.1, z);
    body.add(hip);
    addMesh(hip, rbox(0.16, 0.36, 0.18, 0.07), fur, 0, -0.16, 0);
    const knee = new THREE.Group();
    knee.position.set(0, -0.32, 0);
    hip.add(knee);
    addMesh(knee, rbox(0.13, 0.2, 0.14, 0.05), fur, 0, -0.08, 0);
    addMesh(knee, rbox(0.15, 0.06, 0.2, 0.03), lt, 0, -0.18, 0.03);
    legs.push({ hip, knee, hind, ph });
  }
  // tail: a chain of segments so it can curve
  const tail = [];
  let parent = body;
  for (let k = 0; k < 5; k++) {
    const seg = new THREE.Group();
    seg.position.set(0, k ? 0.2 : 0.12, k ? 0 : -0.55);
    parent.add(seg);
    addMesh(seg, cyl(0.06, 0.07, 0.22, 6), k % 2 ? dk : fur, 0, 0.1, 0);
    tail.push(seg);
    parent = seg;
  }
  const L = 0.5; // hip to paw
  let phase = 0, t = 0, sitK = 1, look = 0, lookT = 0, lookTarget = 0;
  function update(dt, speed = 0) {
    dt = Math.min(0.1, Math.max(0, dt || 0));
    t += dt;
    const moving = speed > 0.08;
    sitK += ((moving ? 0 : 1) - sitK) * Math.min(1, dt * 3);
    // stride: two paw placements per cycle, each about 0.55 at an old cat's amble
    const C = Math.min(1.3, 0.55 + speed * 0.35);
    phase += (2 * Math.PI * speed * dt) / C;
    const amp = Math.asin(Math.min(0.9, (C * 0.32) / L)) * (1 - sitK);
    for (const lg of legs) {
      const u = phase / (2 * Math.PI) + lg.ph;
      const sw = Math.sin(2 * Math.PI * u);
      const lift = Math.max(0, Math.cos(2 * Math.PI * u)) * (1 - sitK);
      // sitting: front legs straight down under the raised chest, hind legs folded flat
      lg.hip.rotation.x = -sw * amp + (lg.hind ? -0.9 : 0.55) * sitK;
      lg.knee.rotation.x = (lg.hind ? -0.5 : 0.6) * lift + (lg.hind ? 1.9 : 0) * sitK;
    }
    // sitting: rump down, chest up; walking: a gentle roll and an old cat's head bob
    body.rotation.x = -0.55 * sitK;
    body.position.y = 0.62 - 0.22 * sitK + 0.02 * Math.sin(2 * phase) * (1 - sitK);
    body.position.z = -0.15 * sitK;
    body.rotation.z = 0.04 * Math.sin(phase) * (1 - sitK);
    neck.rotation.x = 0.5 * sitK + 0.08 * Math.sin(2 * phase + 0.6) * (1 - sitK);
    lookT -= dt;
    if (lookT < 0) { lookT = 1.5 + Math.random() * 3; lookTarget = sitK > 0.5 ? (Math.random() - 0.5) * 1.4 : 0; }
    look += (lookTarget - look) * Math.min(1, dt * 2.5);
    head.rotation.y = look;
    // tail: up and swaying when walking, curled round the paws when sitting
    tail.forEach((seg, k) => {
      const w = Math.sin(t * 1.6 - k * 0.6);
      seg.rotation.x = k === 0 ? lerpN(-0.25, -1.5, sitK) : lerpN(0.25 + (k === 4 ? 0.5 : 0), 0.35, sitK);
      seg.rotation.z = (0.15 * w * (1 - sitK)) + (sitK * 0.35 * (k ? 1 : 0));
    });
  }
  update(0, 0);
  return { group, update };
}
const lerpN = (a, b, k) => a + (b - a) * k;
