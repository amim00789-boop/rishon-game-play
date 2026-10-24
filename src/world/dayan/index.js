// The Moshe Dayan interchange (lab/moshe-dayan, docs/DAYAN_LAB.md) inside the game.
//
// loadDayan() runs right after the terrain loads and before landmarks and the city: it builds the
// design on the bare terrain, then makes terrain.groundAt answer with the interchange's graded
// ground inside its box, so everything that sits on the ground (landmarks, buildings, trees, the
// crowd, the terrain mesh edge) agrees with it. city.js then leaves the box to it: it clips its own
// roads, rails and platforms at the box, adds dayan.roadEntries() to city.roads (traffic and the
// signal plan run on them), and routes heightAt, onCarriage and the colliders inside the box here.
import { createDesign } from './design.js';

let active = null;
export const dayanActive = () => !!active;
export const getDayan = () => active;

export async function loadDayan(terrain, { base = new URL('../../../data/', import.meta.url) } = {}) {
  if (active) return active;
  if (!terrain || !terrain.groundAtRaw || !terrain.setGroundOverride || !terrain.terrainLoaded || !terrain.terrainLoaded()) return null;
  try {
    const res = await fetch(new URL('dayan.osm.json', base));
    if (!res.ok) throw new Error(`dayan.osm.json HTTP ${res.status}`);
    const osm = await res.json();
    const t0 = performance.now();
    const design = createDesign(osm, terrain.groundAtRaw);
    terrain.setGroundOverride({ box: design.box, at: (x, z) => design.ground.at(x, z) });
    active = { design, box: design.box, inBox: design.inBox, ms: Math.round(performance.now() - t0) };
    return active;
  } catch (e) {
    console.warn('[dayan] interchange not loaded, the city draws its own', e.message || e);
    return null;
  }
}

// Per frame (main.js): the station's roofs (hall vault, platform canopies, stair roofs) hide while
// the player is down at platform level with the chase camera above them, or while the camera is
// inside the hall, as the old station did with its canopies; otherwise a roof fills the screen.
let hallMesh = null;
export function updateDayan(camera, player) {
  if (!active || !hallMesh || !camera) return;
  const Z = active.design.stationZone, H = active.design.hall, B = active.design.band;
  if (!Z) return;
  const c = camera.position;
  const inZone = (x, z) => { const s = B.S(x, z), t = B.T(x, z); return s > Z.s0 && s < Z.s1 && t > Z.t0 && t < Z.t1; };
  const low = player && player.pos && inZone(player.pos.x, player.pos.z) && player.y < Z.top + 8 && c.y > player.y + 2;
  let camIn = false;
  if (H) { const s = B.S(c.x, c.z), t = B.T(c.x, c.z); camIn = s > H.sW - 4 && s < H.sE + 4 && t < H.tA + 4 && t > H.tB - 4 && c.y > H.yBase - 2 && c.y < H.yBase + H.crown + 2; }
  hallMesh.visible = !(low || camIn);
}

// Meshes for the game: no context ring or buildings (the city has its own) and no signal poles
// (dressing.js stands the city's signal heads, driven by the signal plan, on these roads too).
export async function buildDayanGroup() {
  if (!active) return null;
  const { buildInterchange } = await import('./build.js');
  const group = buildInterchange(active.design, { context: false, signals: false });
  group.name = 'moshe-dayan-interchange';
  hallMesh = group.getObjectByName('station-roofs') || null;
  return group;
}
