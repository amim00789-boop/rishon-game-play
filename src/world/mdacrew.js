// Ofir and Dekel on shift at the Magen David Adom station (round 10 phase 7, founder 2026-10-31):
// in uniform beside the first parked ambulance. They stand in for the wandering regulars
// (npcs.js crowd.named), so each one shows only while the player is near the station and the
// wandering copy is far from it: the same person is never seen twice at once. No dialogue.
//
//   createMdaCrew({ scene, player, crowd, quests, surface, city, makeAvatar }) -> { crew, update } | null
//
// The uniform is ASSUMED (white shirt, red collar, navy trousers) until the look research
// (docs/research/EMERGENCY_BUILDINGS.md) says otherwise; no emblem is drawn.
import * as THREE from 'three';
import { EMG_PARKED } from './landmarks.js';
import { groundY, surfaceFn } from '../engine/minigames/common.js';

const NEAR = 170; // the player is close enough to see the station
const APART = 230; // the wandering copy is far enough not to be seen at the same time
const UNIFORM = {
  shirt: { color: '#ffffff', neck: 'collar', collarColor: '#d7263d', sleeves: 'short', print: null },
  pants: { kind: 'long', color: '#22304a', belt: '#1d1d24' },
  shoes: { kind: 'sneakers', color: '#1d1d24', stripe: '#d7263d' },
  style: { carry: false },
};
// Dekel keeps his kippah; both leave their instruments in the station.
const CREW = [
  { id: 'dekel', lz: 1.2, extra: { accessories: [{ type: 'kippah', color: '#ffffff', ring: '#2e86de', ring2: '#ffcb3d' }] } },
  { id: 'ofir', lz: -2.0, extra: { accessories: [] } },
];

export function createMdaCrew(deps) {
  const { scene, player, crowd, quests, makeAvatar } = deps;
  const amb = EMG_PARKED.find((v) => v.site === 'mda');
  if (!amb || !makeAvatar) return null;
  const surface = surfaceFn(deps);
  const root = new THREE.Group();
  root.name = 'mda-crew';
  scene.add(root);
  const c = Math.cos(amb.yaw), s = Math.sin(amb.yaw), hw = 3.0 / 2 + 1.6;
  // The side away from the other ambulance, so nobody stands in the gap between the two.
  const other = EMG_PARKED.find((v) => v.site === 'mda' && v !== amb);
  const side = other && (other.x - amb.x) * c - (other.z - amb.z) * s > 0 ? -1 : 1;
  const crew = [];
  for (const m of CREW) {
    let av = null;
    try { av = makeAvatar({ archetype: m.id, ...UNIFORM, ...m.extra }); } catch (e) { console.warn('[mdacrew] avatar failed', m.id, e); }
    if (!av || !av.group) continue;
    // Beside the ambulance: local +x is its left, +z its nose.
    const lx = side * hw, x = amb.x + lx * c + m.lz * s, z = amb.z - lx * s + m.lz * c;
    av.group.position.set(x, groundY(surface, x, z), z);
    av.group.visible = false;
    try { av.setMode && av.setMode('idle'); } catch (_) { /* optional */ }
    root.add(av.group);
    crew.push({ id: m.id, av, x, z });
  }

  function update(dt) {
    const px = player.pos.x, pz = player.pos.z;
    const near = Math.hypot(px - amb.x, pz - amb.z) < NEAR;
    for (const m of crew) {
      const w = crowd && crowd.named ? crowd.named[m.id] : null;
      const show = near && (!w || Math.hypot(w.x - amb.x, w.z - amb.z) > APART);
      m.av.group.visible = show;
      if (!show) continue;
      m.av.group.rotation.y = Math.atan2(px - m.x, pz - m.z);
      try { m.av.update(dt, 0); } catch (_) { /* optional */ }
    }
  }

  // Ride on the quest system's per-frame update, as jobspots.js does.
  if (quests && typeof quests.update === 'function') {
    const orig = quests.update.bind(quests);
    quests.update = (dt, pl, input) => { const r = orig(dt, pl, input); try { update(dt); } catch (e) { console.warn('[mdacrew] update failed', e); } return r; };
  }
  return { crew, update, root };
}
