// Skips world-matrix work for parts of the scene that do not move.
//
// three.js refreshes the world matrix of every node on every render (23k nodes, ~2 ms each
// time). Most of them are the static city. Two savings:
//   1. Hidden top-level objects (the crowd keeps hundreds of avatars hidden by LOD) are skipped.
//   2. Children of the static world groups that have not moved for a few seconds are frozen.
// A frozen part is checked again in the background, a slice per frame; if anything in it moved,
// or a node was added or removed, it is unfrozen for good. Nothing is frozen on a guess.
//
// Note: Object3D.updateMatrix() marks the node dirty, which forces a refresh of its whole
// subtree, so the scene and the static groups stop auto-updating their own (identity) matrix.

const WORLD = new Set(['landmarks', 'airfield', 'city', 'buildings', 'terrain', 'parking', 'details',
  'trees', 'dressing', 'signals', 'storefronts', 'parked-cars']);
const STILL_MS = 6000;      // a part must stay still this long before it is frozen
const CHECK_NODES = 3000;   // background re-check budget per frame
const RESCAN_MS = 2000;     // new parts streamed into a world group are picked up this often

function snapshot(root) {
  const out = [];
  root.traverse((o) => {
    if (o.matrixAutoUpdate) {
      out.push(o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w, o.scale.x, o.scale.y, o.scale.z);
    } else {
      for (let i = 0; i < 16; i++) out.push(o.matrix.elements[i]);
    }
    out.push(o.matrixAutoUpdate ? 1 : 0);
  });
  return Float64Array.from(out);
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createFreezer(scene, { now = () => performance.now() } = {}) {
  const units = new Map(); // part -> { snap, since, frozen, moved }
  const groups = [];       // world groups we took over: { g, snap }
  let enabled = true, lastScan = -Infinity, cursor = 0, list = [];
  const stats = { frozen: 0, units: 0, unfrozen: 0 };

  scene.updateMatrix();
  scene.matrixAutoUpdate = false;

  function scan(t) {
    for (const g of scene.children) {
      if (!WORLD.has(g.name)) continue;
      if (!groups.some((e) => e.g === g)) {
        g.updateMatrix();
        g.matrixAutoUpdate = false;
        groups.push({ g, pos: g.matrix.elements.slice(), done: false });
      }
      for (const c of g.children) if (!units.has(c)) units.set(c, { snap: snapshot(c), since: t, frozen: false, moved: false });
    }
    for (const u of units.keys()) if (!u.parent || !WORLD.has(u.parent.name)) { u.matrixWorldAutoUpdate = true; units.delete(u); }
    stats.units = units.size;
    list = [...units.entries()];
  }

  function thaw(u, e) {
    e.frozen = false; e.moved = true;
    u.matrixWorldAutoUpdate = true;
    u.updateMatrixWorld(true);
    stats.unfrozen++;
  }

  function update() {
    if (!enabled) return;
    const t = now();
    // hidden top-level subtrees are not drawn, so their matrices can wait until they are shown
    for (const c of scene.children) if (!WORLD.has(c.name)) c.matrixWorldAutoUpdate = c.visible;
    // a world group that moves goes back to normal updates
    for (const e of groups) {
      if (e.done) continue;
      // compose, not updateMatrix(): that would mark the group dirty and force its whole subtree
      e.g.matrix.compose(e.g.position, e.g.quaternion, e.g.scale);
      const m = e.g.matrix.elements;
      if (m.some((v, i) => v !== e.pos[i])) { e.done = true; e.g.matrixAutoUpdate = true; for (const c of e.g.children) { const u = units.get(c); if (u && u.frozen) thaw(c, u); } }
    }
    if (t - lastScan > RESCAN_MS) { lastScan = t; scan(t); }

    // round-robin: candidates mature, frozen parts are re-verified
    if (!list.length) return;
    let budget = CHECK_NODES, n = 0;
    while (budget > 0 && n++ < list.length) {
      cursor = (cursor + 1) % list.length;
      const [u, e] = list[cursor];
      if (e.moved || !units.has(u)) continue;
      const s = snapshot(u);
      budget -= s.length / 11 + 1;
      if (!same(s, e.snap)) {
        if (e.frozen) thaw(u, e);
        else { e.snap = s; e.since = t; }
        continue;
      }
      if (!e.frozen && t - e.since >= STILL_MS) {
        u.updateMatrixWorld(true);
        u.matrixWorldAutoUpdate = false;
        e.frozen = true;
      }
    }
    let f = 0; for (const e of units.values()) if (e.frozen) f++;
    stats.frozen = f;
  }

  function setEnabled(on) {
    enabled = on;
    if (!on) {
      scene.matrixAutoUpdate = true;
      for (const e of groups) e.g.matrixAutoUpdate = true;
      for (const u of units.keys()) u.matrixWorldAutoUpdate = true;
      for (const c of scene.children) c.matrixWorldAutoUpdate = true;
    } else {
      scene.matrixAutoUpdate = false;
    }
  }

  return { update, stats, setEnabled };
}
