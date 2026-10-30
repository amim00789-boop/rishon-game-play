// Lamps, stop lines and mid-block zebras of the signal plan (src/world/signals.js).
//
// dressing.js stands the poles (static, instanced per chunk) and hands the heads over: one record per
// pole, with its site and arm. Here every head gets its lamps (three vehicle aspects and, where the
// arm has a zebra, two pedestrian aspects) as instances of a single plane mesh whose instance colours
// show the state of the controller: the lit lamp bright, the others nearly black. Stop lines and the
// zebra stripes of mid-block crossings are one merged mesh. Lamps near the player are refreshed five
// times a second, and only when their site's stage changed (or a pedestrian lamp is flashing).
import * as THREE from 'three';
import { aspect, walkState, stageIndex } from './signals.js';

const ZL = 5.04, ZW = 0.84; // zebra stripe length and width, as city.js paints them (3 m and 0.5 m widened)
const UPDATE_R = 520;
const LIT = { R: 0xff3a2c, A: 0xffb21c, G: 0x35f07a };
const DIM = { R: 0x2b0b09, A: 0x2b2106, G: 0x07220f };

// Lamp layout in the pole's local frame (trafficLightTemplate in dressing.js): +z faces the oncoming
// traffic, -x faces the road for pedestrians.
const VEH = [['R', 6.65], ['A', 5.8], ['G', 4.95]];
const PED = [['R', 3.5], ['G', 2.9]];

export function buildSignalMeshes(scene, plan, heads, { ground }) {
  const group = new THREE.Group();
  group.name = 'signals';
  scene.add(group);

  // ---- lamps ----
  const lamps = []; // { head, kind: 'v' | 'p', aspect: 'R' | 'A' | 'G', i }
  let n = 0;
  for (const h of heads) {
    h.lamps = [];
    for (const [a] of VEH) { h.lamps.push({ kind: 'v', a, i: n++ }); }
    if (h.ped !== false && h.arm.ped) for (const [a] of PED) { h.lamps.push({ kind: 'p', a, i: n++ }); }
    h.site.heads = h.site.heads || [];
    if (!h.site.heads.includes(h)) h.site.heads.push(h);
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  im.name = 'signalLamps';
  im.frustumCulled = false;
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), V = new THREE.Vector3(), S = new THREE.Vector3(), QL = new THREE.Quaternion(), C = new THREE.Color();
  for (const h of heads) {
    Q.setFromAxisAngle(UP, h.rot);
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    for (const l of h.lamps) {
      let lx, ly, lz, ry, w, hgt;
      if (l.kind === 'v') { lx = 0; ly = VEH.find((v) => v[0] === l.a)[1]; lz = 0.93; ry = 0; w = 0.55; hgt = 0.55; }
      else { lx = -0.77; ly = PED.find((v) => v[0] === l.a)[1]; lz = 0; ry = -Math.PI / 2; w = 0.4; hgt = 0.45; }
      // local -> world: rotate (lx, lz) by the pole's yaw
      V.set(h.x + lx * c + lz * s, h.y + ly, h.z - lx * s + lz * c);
      QL.setFromAxisAngle(UP, h.rot + ry);
      M.compose(V, QL, S.set(w, hgt, 1));
      im.setMatrixAt(l.i, M);
      im.setColorAt(l.i, C.setHex(DIM[l.a]));
    }
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  group.add(im);

  const paintHead = (h, T, flashOn) => {
    const g = h.arm.group, site = h.site;
    const va = aspect(site, g, T);
    const w = h.ped !== false && h.arm.ped ? walkState(site, g, T) : 0;
    for (const l of h.lamps) {
      let on;
      if (l.kind === 'v') on = l.a === va;
      else if (l.a === 'R') on = w === 0;
      else on = w === 1 || (w === 2 && flashOn);
      im.setColorAt(l.i, C.setHex(on ? LIT[l.a] : DIM[l.a]));
    }
  };
  const flashing = (site, T) => {
    for (let g = 0; g < site.groups.length; g++) if (site.groups[g].ped && site.groups[g].active && walkState(site, g, T) === 2) return true;
    return false;
  };
  const stats = { updates: 0, sitesLit: 0 };
  let lastUpdate = -1;
  const update = (T, px, pz, force = false) => {
    if (!force && T - lastUpdate < 0.2) return;
    lastUpdate = T;
    const flashOn = Math.floor(T * 2.5) % 2 === 0;
    let dirty = false;
    for (const site of plan.sites) {
      if (!site.heads) continue;
      if (!force && Math.hypot(site.x - px, site.z - pz) > UPDATE_R) continue;
      const fl = flashing(site, T);
      const key = stageIndex(site, T) * 4 + (fl ? 2 + (flashOn ? 1 : 0) : 0);
      if (!force && site.lampKey === key) continue;
      site.lampKey = key;
      for (const h of site.heads) paintHead(h, T, flashOn);
      dirty = true;
      stats.updates++;
    }
    if (dirty && im.instanceColor) im.instanceColor.needsUpdate = true;
  };
  update(plan.t, 0, 0, true);
  plan.hooks.push((T, px, pz) => update(T, px, pz));

  // ---- stop lines and mid-block zebras ----
  const pos = [];
  const quad = (a, b, c, d) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); };
  const lift = (x, z, rank) => ground(x, z) + 0.15 + (rank || 0) * 0.008 + 0.035 + 0.008;
  const P = { x: 0, z: 0, tx: 0, tz: 1 }, Q2 = { x: 0, z: 0, tx: 0, tz: 1 };
  let lines = 0, zebras = 0;
  for (const site of plan.sites) {
    for (const arm of site.arms) {
      if (!arm.stop || !arm.approach) continue;
      plan.armPoint(arm, 0, arm.inner + 0.12, P);
      plan.armPoint(arm, 0, arm.outer - 0.1, Q2);
      const th = 0.9;
      // on a raised junction the line lies on the deck: the road's own surface height
      const ly = site.deck && plan.armY ? (() => { const y0 = plan.armY(arm, 0) + 0.06; return () => y0; })() : null;
      const L = (x, z) => (ly ? ly() : lift(x, z, arm.rank));
      const a = [P.x, L(P.x, P.z), P.z], b = [Q2.x, L(Q2.x, Q2.z), Q2.z];
      const c = [Q2.x + Q2.tx * th, L(Q2.x + Q2.tx * th, Q2.z + Q2.tz * th), Q2.z + Q2.tz * th];
      const d = [P.x + P.tx * th, L(P.x + P.tx * th, P.z + P.tz * th), P.z + P.tz * th];
      quad(a, b, c, d);
      lines++;
    }
    if (site.kind === 'mid' && site.crossing) {
      const cr = site.crossing, e = site.e;
      const tx = Math.sin(cr.angle), tz = Math.cos(cr.angle), nx = -tz, nz = tx;
      const cnt = Math.max(2, Math.floor((cr.width - 0.8) / (2 * ZW)));
      for (let k = 0; k < cnt; k++) {
        const o = -((cnt - 1) * 2 * ZW) / 2 + k * 2 * ZW;
        if (e.median && Math.abs(o) < e.median / 2) continue;
        const cx = cr.x + nx * o, cz = cr.z + nz * o;
        const hx = (tx * ZL) / 2, hz = (tz * ZL) / 2, wx = (nx * ZW) / 2, wz = (nz * ZW) / 2;
        const y = (x, z) => lift(x, z, e.rank) + 0.004;
        quad([cx - hx - wx, y(cx - hx - wx, cz - hz - wz), cz - hz - wz], [cx + hx - wx, y(cx + hx - wx, cz + hz - wz), cz + hz - wz],
          [cx + hx + wx, y(cx + hx + wx, cz + hz + wz), cz + hz + wz], [cx - hx + wx, y(cx - hx + wx, cz - hz + wz), cz - hz + wz]);
      }
      zebras++;
    }
  }
  if (pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.MeshBasicMaterial({ color: 0xf4f4f0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'signalMarks';
    mesh.renderOrder = 2;
    group.add(mesh);
  }
  stats.lamps = n; stats.stopLines = lines; stats.midZebras = zebras;
  return { group, update, stats };
}
