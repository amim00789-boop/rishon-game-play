// Re-park the lot (M6): cars are double-parked across the aisle and the lifeguards' jeep cannot get
// out. Select a car (click it, or Tab), drive it a short way at walking pace (W/S, A/D) and park
// it (Space) in a free stall; when the jeep's lane is clear the jeep drives out. Move counter and
// par, no timer, no fail: R puts every car back.
//
//   const res = await parking.start({
//     lot,                         // optional: a lot from world/parking.js buildParking().lots
//     center: {x,z},               // where in the lot (or where to lay out a lot when there is none)
//     blockers: 3,                 // cars double-parked across the jeep's lane
//     fill: 0.55,                  // share of the other stalls that hold a car
//     par: 5,                      // default: blockers + 2
//     jeep: { kind: 'suv', color: 0xd7263d },
//   });
//   // res = { ok, moves, par, underPar, resets, quit }
//
// World cars: traffic.parked has no hide/show API, so the parked cars around `center` are hidden
// by zeroing their instance matrices and forcing a rebin, and restored when the puzzle ends. Their
// collision boxes stay in place (harmless: the player is frozen during the puzzle and the cars
// come back afterwards). Puzzle cars are this module's own meshes.
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, showCard, cameraRig, keyListener, toaster, clamp, wrapAngle, groundY, surfaceFn, disposeTree, rich, jumpToStart } from './common.js';
import { getSynth } from './synth.js';

let models = null;
const modelsReady = import('../../vehicles/models.js').then((m) => { models = m; }).catch(() => {});

const CSS = `
.mg-park .pk-hud { left: 50%; top: 12px; transform: translateX(-50%); width: 300px; }
.mg-park .pk-big { font-size: 24px; font-weight: 900; }
.mg-park .pk-help { margin-top: 6px; font-size: 12px; line-height: 1.5; }
.mg-park .pk-btns { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; gap: 6px; pointer-events: auto; }
.mg-park .pk-btns .mg-btn { white-space: nowrap; }
`;
const PAINT = [0xf4f4f2, 0x2b2f36, 0x9aa3ad, 0x3f6fb6, 0xe2c044, 0x6aa36f, 0xc2462e, 0xe58f3a];
const STALL_W = 4.4, STALL_L = 8.75; // parking.js U(2.5) x U(5.0) at SCALE 0.25, WIDEN 1.4 x CAR_SCALE

export function createParking(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  const surface = surfaceFn(deps);
  addStyle('mg-style-park', CSS);
  let S = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      modelsReady.then(() => {
        const ov = createOverlay('mg-park',
          '<div class="mg-panel pk-hud"><div class="mg-title pk-title"></div><div class="pk-big mg-num"></div><div class="pk-par mg-small"></div><div class="pk-help"></div></div>' +
          '<div class="pk-btns"></div>');
        ov.$('.pk-title').textContent = t(config.title || 'mg.parking.title');
        ov.$('.pk-help').innerHTML = rich(t('mg.parking.help'));
        const root = new THREE.Group();
        root.name = 'mg-parking';
        deps.scene.add(root);
        S = { cfg: config, ov, root, resolve, toast: toaster(ov.root), rig: cameraRig(deps.scene, deps.camera), resets: 0, offKeys: keyListener(onKey) };
        S.cam = S.rig.take();
        const btns = ov.$('.pk-btns');
        for (const [key, fn] of [['mg.parking.next', () => cycle()], ['mg.parking.park', () => release()], ['mg.parking.reset', () => resetLot(true)]]) {
          const b = document.createElement('button');
          b.className = 'mg-btn alt'; b.innerHTML = rich(t(key));
          b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); fn(); });
          btns.appendChild(b);
        }
        S.onPointer = (e) => pick(e);
        window.addEventListener('pointerdown', S.onPointer);
        // Optional fixed start: the player stands beside the lot (the fade hides the camera cut).
        if (config.start && config.jump !== false) jumpToStart(deps, config.start);
        layout();
        hideWorldCars();
        resetLot(false);
      });
    });
  }

  // ---------------- layout ----------------
  function layout() {
    const s = S, cfg = s.cfg;
    const rnd = mulberry(cfg.seed || 7);
    let stalls = [];
    let center = cfg.center;
    if (cfg.lot && cfg.lot.stalls && cfg.lot.stalls.length >= 6) {
      const all = cfg.lot.stalls;
      if (!center) { center = { x: 0, z: 0 }; for (const st of all) { center.x += st.x / all.length; center.z += st.z / all.length; } }
      stalls = all.map((st) => ({ x: st.x, z: st.z, y: st.y, angle: st.angle, w: st.w || STALL_W, l: st.l || STALL_L }))
        .sort((a, b) => Math.hypot(a.x - center.x, a.z - center.z) - Math.hypot(b.x - center.x, b.z - center.z))
        .slice(0, cfg.stalls || 16);
    }
    if (stalls.length < 6) { center = center || { x: deps.player.pos.x + 30, z: deps.player.pos.z }; stalls = syntheticLot(center, cfg.angle || 0); s.synthetic = true; }
    s.center = center;
    // The jeep takes the stall nearest the centre; its aisle runs behind it.
    const jeepSt = stalls[0];
    const fx = Math.sin(jeepSt.angle), fz = Math.cos(jeepSt.angle);
    const ax = Math.cos(jeepSt.angle), az = -Math.sin(jeepSt.angle); // along the aisle
    const blockers = clamp(cfg.blockers ?? 3, 1, 5);
    const carL = 7.6;
    const laneLen = blockers * (carL + 2) + 6;
    const aisleOff = jeepSt.l / 2 + (cfg.aisle || jeepSt.l) / 2;
    // Pick the aisle end with more room (fewer stalls beside it) as the way out.
    let side = 1;
    const count = (sd) => stalls.filter((st) => { const rx = st.x - jeepSt.x, rz = st.z - jeepSt.z; return rx * ax * sd + rz * az * sd > 2; }).length;
    if (count(-1) < count(1)) side = -1;
    const lane = {
      x: jeepSt.x - fx * aisleOff + ax * side * (laneLen / 2 - 2), z: jeepSt.z - fz * aisleOff + az * side * (laneLen / 2 - 2),
      yaw: Math.atan2(ax * side, az * side), hl: laneLen / 2, hw: (cfg.aisle || jeepSt.l) / 2 - 0.4,
    };
    s.lane = lane;
    s.stalls = stalls;
    s.jeepStall = jeepSt;
    const cars = [];
    // Blockers: double-parked along the aisle, inside the lane.
    for (let i = 0; i < blockers; i++) {
      const d = -lane.hl + 4 + carL / 2 + i * (carL + 2);
      cars.push({ kind: pickKind(rnd), color: PAINT[Math.floor(rnd() * PAINT.length)], x: lane.x + Math.sin(lane.yaw) * d + Math.cos(lane.yaw) * (rnd() - 0.5) * 1.2,
        z: lane.z + Math.cos(lane.yaw) * d - Math.sin(lane.yaw) * (rnd() - 0.5) * 1.2, yaw: lane.yaw + (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * 0.2, blocker: true });
    }
    // Some stalls hold cars; keep enough free ones for every blocker plus two.
    const others = stalls.slice(1);
    const maxFull = Math.max(0, others.length - blockers - 2);
    let full = 0;
    for (const st of others) {
      if (full >= maxFull || rnd() > (cfg.fill ?? 0.55)) continue;
      full++;
      cars.push({ kind: pickKind(rnd), color: PAINT[Math.floor(rnd() * PAINT.length)], x: st.x, z: st.z, yaw: st.angle + (rnd() < 0.3 ? Math.PI : 0) });
    }
    s.layout = cars;
    s.par = cfg.par ?? blockers + 2;
    // Meshes: puzzle cars, the jeep, the lane marking, the selection ring.
    s.cars = cars.map((c, i) => ({ ...c, i, mesh: carMesh(c.kind, c.color), L: kindL(c.kind), W: kindW(c.kind) }));
    for (const c of s.cars) { c.mesh.userData.car = c; s.root.add(c.mesh); }
    s.jeep = { kind: cfg.jeep?.kind || 'suv', x: jeepSt.x, z: jeepSt.z, yaw: jeepSt.angle, mesh: carMesh(cfg.jeep?.kind || 'suv', cfg.jeep?.color ?? 0xd7263d), L: kindL('suv'), W: kindW('suv'), jeep: true };
    s.root.add(s.jeep.mesh);
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.6), new THREE.MeshBasicMaterial({ color: 0xffcb3d }));
    beacon.position.set(0, 4.6, 0);
    s.jeep.mesh.add(beacon);
    s.laneMesh = laneMarker(lane);
    s.root.add(s.laneMesh);
    s.sel = selRing();
    s.root.add(s.sel);
    if (s.synthetic) s.root.add(paintLot(stalls));
  }

  function syntheticLot(c, angle) {
    // Two facing rows of seven stalls across a central aisle.
    const out = [];
    const ax = Math.cos(angle), az = -Math.sin(angle), fx = Math.sin(angle), fz = Math.cos(angle);
    const aisle = STALL_L;
    for (const row of [-1, 1]) {
      for (let k = -3; k <= 3; k++) {
        const off = row * (aisle / 2 + STALL_L / 2);
        const along = k * STALL_W;
        const x = c.x + fx * off + ax * along, z = c.z + fz * off + az * along;
        out.push({ x, z, y: groundY(surface, x, z), angle: row > 0 ? angle : angle + Math.PI, w: STALL_W, l: STALL_L });
      }
    }
    return out.sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
  }

  function paintLot(stalls) {
    const g = new THREE.Group();
    const asphalt = new THREE.MeshBasicMaterial({ color: 0x5c5f66 });
    const line = new THREE.MeshBasicMaterial({ color: 0xf3f1e7 });
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const st of stalls) { minX = Math.min(minX, st.x); maxX = Math.max(maxX, st.x); minZ = Math.min(minZ, st.z); maxZ = Math.max(maxZ, st.z); }
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX + 30, maxZ - minZ + 30), asphalt);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set((minX + maxX) / 2, groundY(surface, (minX + maxX) / 2, (minZ + maxZ) / 2) + 0.09, (minZ + maxZ) / 2);
    g.add(pad);
    for (const st of stalls) {
      const ax = Math.cos(st.angle), az = -Math.sin(st.angle);
      for (const sd of [-1, 1]) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.3, st.l), line);
        m.rotation.set(-Math.PI / 2, 0, 0);
        m.rotation.order = 'YXZ';
        m.rotation.y = st.angle;
        m.position.set(st.x + ax * sd * st.w / 2, (st.y || 0) + 0.13, st.z + az * sd * st.w / 2);
        g.add(m);
      }
    }
    return g;
  }

  function laneMarker(lane) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xe8364f, transparent: true, opacity: 0.32, depthWrite: false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(lane.hw * 2, lane.hl * 2), mat);
    plane.rotation.x = -Math.PI / 2;
    g.add(plane);
    const chevMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false });
    for (let k = -1; k <= 1; k++) {
      const shape = new THREE.Shape();
      shape.moveTo(-1.6, 0); shape.lineTo(0, 1.6); shape.lineTo(1.6, 0); shape.lineTo(1.6, -0.8); shape.lineTo(0, 0.8); shape.lineTo(-1.6, -0.8);
      const ch = new THREE.Mesh(new THREE.ShapeGeometry(shape), chevMat);
      ch.rotation.x = -Math.PI / 2;
      ch.position.set(0, 0.02, -k * (lane.hl * 0.55));
      g.add(ch);
    }
    g.rotation.y = lane.yaw;
    g.position.set(lane.x, groundY(surface, lane.x, lane.z) + 0.16, lane.z);
    g.userData.mat = mat;
    return g;
  }

  function selRing() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.6, 5.4, 40), new THREE.MeshBasicMaterial({ color: 0xffcb3d, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.4, 10), new THREE.MeshBasicMaterial({ color: 0xffcb3d }));
    arrow.rotation.x = Math.PI;
    arrow.position.y = 7.5;
    g.add(ring, arrow);
    g.visible = false;
    g.userData.arrow = arrow;
    return g;
  }

  // ---------------- state ----------------
  function resetLot(byPlayer) {
    const s = S;
    if (byPlayer) { s.resets++; synth.play('whoosh'); s.toast(t('mg.parking.resetDone')); }
    s.layout.forEach((c, i) => Object.assign(s.cars[i], { x: c.x, z: c.z, yaw: c.yaw, v: 0, steer: 0 }));
    Object.assign(s.jeep, { x: s.jeepStall.x, z: s.jeepStall.z, yaw: s.jeepStall.angle });
    s.jeep.mesh.visible = true;
    s.moves = 0; s.selected = null; s.phase = 'play'; s.exitT = 0;
    for (const c of [...s.cars, s.jeep]) placeMesh(c);
    hud();
  }

  function placeMesh(c) {
    c.mesh.position.set(c.x, groundY(surface, c.x, c.z) + 0.05, c.z);
    c.mesh.rotation.y = c.yaw;
  }

  function hud() {
    const s = S;
    s.ov.$('.pk-big').textContent = t('mg.parking.moves', { n: s.moves });
    s.ov.$('.pk-par').textContent = t('mg.parking.par', { n: s.par });
  }

  function select(c) {
    const s = S;
    if (s.phase !== 'play' || c === s.selected) return;
    if (s.selected) release(true);
    s.selected = c;
    c.from = { x: c.x, z: c.z, yaw: c.yaw };
    c.v = 0; c.steer = 0;
    synth.play('click');
  }

  // Cycle through the cars, those in the jeep's lane first.
  function cycle() {
    const s = S;
    if (s.phase !== 'play') return;
    const order = s.cars.slice().sort((a, b) => (inLane(b) - inLane(a)) || (dist(a, s.lane) - dist(b, s.lane)));
    const i = s.selected ? order.indexOf(s.selected) : -1;
    select(order[(i + 1) % order.length]);
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  // Leave the car here, snapping it into a free stall when it is close to one.
  function release(silent = false) {
    const s = S;
    const c = s.selected;
    if (!c) return;
    s.selected = null;
    c.v = 0;
    const st = nearestFreeStall(c);
    if (st) {
      const yaw = Math.abs(wrapAngle(c.yaw - st.angle)) < Math.PI / 2 ? st.angle : st.angle + Math.PI;
      const save = { x: c.x, z: c.z, yaw: c.yaw };
      Object.assign(c, { x: st.x, z: st.z, yaw });
      if (collides(c)) Object.assign(c, save); else if (!silent) synth.play('ding');
      placeMesh(c);
    }
    if (Math.hypot(c.x - c.from.x, c.z - c.from.z) > 1.5 || Math.abs(wrapAngle(c.yaw - c.from.yaw)) > 0.3) { s.moves++; hud(); }
    checkWin();
  }

  function nearestFreeStall(c) {
    const s = S;
    let best = null, bd = Infinity;
    for (const st of s.stalls) {
      if (st === s.jeepStall) continue;
      const d = Math.hypot(st.x - c.x, st.z - c.z);
      if (d > Math.max(3.4, st.w * 0.8) || d >= bd) continue;
      const da = Math.abs(wrapAngle(c.yaw - st.angle));
      if (Math.min(da, Math.PI - da) > 0.65) continue;
      if (s.cars.some((o) => o !== c && Math.hypot(o.x - st.x, o.z - st.z) < 2.5)) continue;
      bd = d; best = st;
    }
    return best;
  }

  // ---------------- geometry ----------------
  const corners = (c, pad = 0) => {
    const hl = c.L / 2 + pad, hw = c.W / 2 + pad, sx = Math.sin(c.yaw), cz = Math.cos(c.yaw);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [c.x + cz * a * hw + sx * b * hl, c.z - sx * a * hw + cz * b * hl]);
  };
  const laneBox = () => ({ x: S.lane.x, z: S.lane.z, yaw: S.lane.yaw, L: S.lane.hl * 2, W: S.lane.hw * 2 });
  function overlap(a, b) {
    for (const poly of [a, b]) {
      for (let i = 0; i < 4; i++) {
        const p = poly[i], q = poly[(i + 1) % 4];
        const nx = q[1] - p[1], nz = p[0] - q[0];
        let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
        for (const v of a) { const d = v[0] * nx + v[1] * nz; amin = Math.min(amin, d); amax = Math.max(amax, d); }
        for (const v of b) { const d = v[0] * nx + v[1] * nz; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
        if (amax < bmin || bmax < amin) return false;
      }
    }
    return true;
  }
  function collides(c) {
    const s = S, mine = corners(c, -0.15);
    for (const o of [...s.cars, s.jeep]) {
      if (o === c || (o.jeep && !o.mesh.visible)) continue;
      if (Math.hypot(o.x - c.x, o.z - c.z) > 12) continue;
      if (overlap(mine, corners(o, -0.15))) return true;
    }
    // Keep puzzle cars around the lot.
    return Math.hypot(c.x - s.center.x, c.z - s.center.z) > (s.cfg.radius || 45) + 15;
  }
  const inLane = (c) => (overlap(corners(c, -0.2), corners(laneBox())) ? 1 : 0);

  function checkWin() {
    const s = S;
    const blocked = s.cars.filter((c) => inLane(c)).length;
    s.laneMesh.userData.mat.color.setHex(blocked ? 0xe8364f : 0x2ec4b6);
    if (blocked || s.phase !== 'play') return;
    s.phase = 'exit';
    s.exitT = 0;
    synth.play('win');
    s.toast(t('mg.parking.clear'));
  }

  // ---------------- input ----------------
  function onKey(e) {
    const s = S;
    if (!s || e.repeat || s.phase !== 'play') return;
    if (e.code === 'Tab') { e.preventDefault(); cycle(); } else if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); release(); } else if (e.code === 'KeyR') resetLot(true);
    else if (e.code === 'Escape') quitCard();
  }

  function pick(e) {
    const s = S;
    if (!s || s.phase !== 'play' || e.target.closest('.mg-btn, .mg-panel')) return;
    s.rig.apply();
    deps.camera.updateMatrixWorld(true);
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, deps.camera);
    const hits = ray.intersectObjects(s.cars.map((c) => c.mesh), true);
    if (!hits.length) return;
    let o = hits[0].object;
    while (o && !o.userData.car) o = o.parent;
    if (o) select(o.userData.car);
  }

  function quitCard() {
    const s = S;
    s.phase = 'card';
    s.closeCard = showCard(s.ov.root, { title: t('mg.ui.paused'), lines: [t('mg.parking.quitLine')],
      buttons: [{ label: t('mg.ui.resume'), key: ['Enter', 'Escape'], onClick: () => { s.phase = 'play'; s.closeCard = null; } },
        { label: t('mg.ui.quit'), key: ['KeyQ'], alt: true, onClick: () => end({ ok: false, quit: true, moves: s.moves, par: s.par, resets: s.resets }) }] });
  }

  // ---------------- per frame ----------------
  function update(dt, input) {
    const s = S;
    if (!s) return;
    const c = s.selected;
    if (s.phase === 'play' && c && input) {
      const f = (input.isDown('KeyW', 'ArrowUp') ? 1 : 0) - (input.isDown('KeyS', 'ArrowDown') ? 1 : 0);
      const r = (input.isDown('KeyD', 'ArrowRight') ? 1 : 0) - (input.isDown('KeyA', 'ArrowLeft') ? 1 : 0);
      drive(c, dt, f, r);
    }
    if (s.phase === 'exit') {
      // The jeep backs out into the aisle, turns along the lane and leaves.
      s.exitT += dt;
      const j = s.jeep, st = s.jeepStall;
      const fx = Math.sin(st.angle), fz = Math.cos(st.angle);
      const back = Math.min(1, s.exitT / 1.2) * (st.l / 2 + s.lane.hw);
      if (s.exitT < 1.2) { j.x = st.x - fx * back; j.z = st.z - fz * back; j.yaw = st.angle; } else {
        const k = s.exitT - 1.2;
        j.yaw = st.angle + wrapAngle(s.lane.yaw - st.angle) * Math.min(1, k * 1.5);
        j.x += Math.sin(j.yaw) * Math.min(14, 4 + k * 10) * dt; j.z += Math.cos(j.yaw) * Math.min(14, 4 + k * 10) * dt;
      }
      placeMesh(j);
      if (s.exitT > 3.6) { j.mesh.visible = false; finishCard(); }
    }
    // Selection ring and camera.
    s.sel.visible = !!c;
    if (c) { s.sel.position.set(c.x, groundY(surface, c.x, c.z), c.z); s.sel.userData.arrow.position.y = 7.5 + Math.sin(performance.now() / 180) * 0.5; }
    const focus = c ? { x: s.lane.x * 0.6 + c.x * 0.4, z: s.lane.z * 0.6 + c.z * 0.4 } : { x: s.lane.x * 0.5 + s.center.x * 0.5, z: s.lane.z * 0.5 + s.center.z * 0.5 };
    s.focus = s.focus || { ...focus };
    const k = 1 - Math.exp(-dt * 3);
    s.focus.x += (focus.x - s.focus.x) * k; s.focus.z += (focus.z - s.focus.z) * k;
    const st = s.jeepStall;
    const y0 = groundY(surface, s.focus.x, s.focus.z);
    // Look from the aisle side, across the jeep's row.
    const bx = -Math.sin(st.angle), bz = -Math.cos(st.angle);
    s.cam.set(new THREE.Vector3(s.focus.x + bx * 42, y0 + 58, s.focus.z + bz * 42), new THREE.Vector3(s.focus.x, y0, s.focus.z), 50);
  }

  function drive(c, dt, f, r) {
    const max = f > 0 ? 9 : 5;
    const target = f * max;
    c.v += clamp(target - c.v, -14 * dt, 14 * dt);
    c.steer += (-r * 0.6 - c.steer) * Math.min(1, dt * 6);
    if (Math.abs(c.v) < 0.01) return;
    const save = { x: c.x, z: c.z, yaw: c.yaw };
    c.yaw += (c.v / (c.L * 0.62)) * Math.tan(c.steer) * dt;
    c.x += Math.sin(c.yaw) * c.v * dt;
    c.z += Math.cos(c.yaw) * c.v * dt;
    if (collides(c)) {
      Object.assign(c, save);
      if (Math.abs(c.v) > 2) { synth.play('bump', null, 0.6); }
      c.v = 0;
    }
    placeMesh(c);
  }

  function finishCard() {
    const s = S;
    if (s.phase === 'card') return;
    s.phase = 'card';
    const under = s.moves <= s.par;
    s.result = { ok: true, moves: s.moves, par: s.par, underPar: under, resets: s.resets, quit: false };
    s.closeCard = showCard(s.ov.root, { title: t('mg.parking.passTitle'), big: t('mg.parking.moves', { n: s.moves }),
      lines: [t(under ? 'mg.parking.underPar' : 'mg.parking.overPar', { par: s.par })],
      buttons: [{ label: t('mg.ui.continue'), key: ['Enter', 'KeyF', 'Space'], onClick: () => end(s.result) }] });
    if (s.cfg.autoContinue) setTimeout(() => S === s && s.closeCard && s.closeCard.fire(0), 600);
  }

  // ---------------- world cars ----------------
  function hideWorldCars() {
    const s = S;
    const parked = deps.traffic && deps.traffic.parked;
    s.hidden = [];
    if (!parked || !parked.cars || s.cfg.hideParked === false) return;
    const r = (s.cfg.radius || 45) + 12;
    for (const c of parked.cars) {
      if (Math.abs(c.x - s.center.x) > r || Math.abs(c.z - s.center.z) > r || Math.hypot(c.x - s.center.x, c.z - s.center.z) > r) continue;
      s.hidden.push({ c, m: c.m.clone(), mf: c.mf.clone() });
      c.m.makeScale(0, 0, 0); c.mf.makeScale(0, 0, 0);
    }
    rebin(parked);
  }
  function restoreWorldCars(s) {
    const parked = deps.traffic && deps.traffic.parked;
    if (!parked || !s.hidden || !s.hidden.length) return;
    for (const h of s.hidden) { h.c.m.copy(h.m); h.c.mf.copy(h.mf); }
    rebin(parked);
  }
  // parked.update() rebins only after the player moves 30 units; a far jump forces it, and the
  // next traffic.update() rebins again around the real player.
  function rebin(parked) {
    const p = deps.player.pos;
    parked.update(p.x + 1e6, p.z);
    parked.update(p.x, p.z);
  }

  // ---------------- end ----------------
  function end(result) {
    const s = S;
    teardown();
    s.resolve(result);
  }
  function teardown() {
    const s = S;
    if (!s) return;
    S = null;
    if (s.closeCard) s.closeCard();
    s.offKeys();
    window.removeEventListener('pointerdown', s.onPointer);
    s.cam.release();
    restoreWorldCars(s);
    deps.scene.remove(s.root);
    s.root.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    disposeTree(s.root);
    s.ov.remove();
  }
  function cancel() {
    const s = S;
    if (!s) return;
    teardown();
    s.resolve({ ok: false, cancelled: true, moves: s.moves, par: s.par });
  }

  return {
    start, update, cancel,
    get active() { return !!S; },
    get blocksPlayer() { return !!S; },
    debug: {
      state: () => (S ? { phase: S.phase, moves: S.moves, par: S.par, inLane: S.cars.filter(inLane).length, selected: S.selected ? S.selected.i : null,
        free: S.stalls.filter((st) => st !== S.jeepStall && !S.cars.some((o) => Math.hypot(o.x - st.x, o.z - st.z) < 2.5)).length, hidden: S.hidden ? S.hidden.length : 0, synthetic: !!S.synthetic } : null),
      select: (i) => S && select(S.cars[i]),
      cycle: () => cycle(),
      drive: (f, r, seconds) => { const s = S; if (!s || !s.selected) return; for (let k = 0; k < seconds * 60; k++) drive(s.selected, 1 / 60, f, r); },
      // Teleport the selected car into the nearest free stall (tests the snap and the win check).
      parkInFreeStall: () => {
        const s = S; if (!s || !s.selected) return false;
        const c = s.selected;
        const free = s.stalls.filter((st) => st !== s.jeepStall && !s.cars.some((o) => o !== c && Math.hypot(o.x - st.x, o.z - st.z) < 2.5))
          .sort((a, b) => dist(a, c) - dist(b, c))[0];
        if (!free) return false;
        Object.assign(c, { x: free.x + 0.5, z: free.z, yaw: free.angle + 0.1 });
        release();
        return true;
      },
      release: () => release(),
      reset: () => resetLot(true),
      card: (i = 0) => S && S.closeCard && S.closeCard.fire(i),
    },
  };
}

function carMesh(kind, color) {
  if (models && models.buildVehicleMesh) {
    try { const m = models.buildVehicleMesh(kind, color); const g = new THREE.Group(); g.add(m); return g; } catch (e) { console.warn('[parking] vehicle mesh failed', e); }
  }
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.BoxGeometry(kindW(kind), 3, kindL(kind)), new THREE.MeshToonMaterial({ color }));
  b.position.y = 1.6;
  g.add(b);
  return g;
}
const kindL = (k) => (models && models.KINDS && models.KINDS[k] ? models.KINDS[k].L : 7.4);
const kindW = (k) => (models && models.KINDS && models.KINDS[k] ? models.KINDS[k].W : 3.2);
function pickKind(rnd) { const r = rnd(); return r < 0.35 ? 'hatch' : r < 0.65 ? 'sedan' : r < 0.9 ? 'suv' : 'van'; }
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
