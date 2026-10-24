// Job start points (docs/JOBS.md 8.1): for every job in data/jobs/jobs.json a floating icon, a
// light column and a talking NPC at its spot. Walk up, press F: the job's offer card opens
// (src/engine/minigames/jobs.js) and, on Start, the job's minigame runs. The spots are data, so a new
// job needs no edit here.
//
//   createJobSpots({ scene, player, collision, city, hud, t, quests, surface, makeAvatar }) -> { spots, update, nearest }
//
// It hooks the quest system's per-frame update (after it, so the talk prompt of a quest NPC wins
// when both are in reach) instead of asking main.js for a second per-frame call.
import * as THREE from 'three';
import { project } from '../geo.js';
import { beamMarker, iconSprite, groundY, surfaceFn } from '../engine/minigames/common.js';
import { loadJobDefs, loadJobStrings } from '../engine/jobs/strings.js';

const REACH = 9;

export async function createJobSpots(deps) {
  const { scene, player, hud, quests } = deps;
  const t = deps.t;
  const surface = surfaceFn(deps);
  let defs;
  try { [defs] = await Promise.all([loadJobDefs(), loadJobStrings()]); } catch (e) { console.warn('[jobspots] no job data', e); return null; }
  const spots = [];
  const root = new THREE.Group();
  root.name = 'job-spots';
  scene.add(root);

  for (const [id, def] of Object.entries(defs)) {
    const sp = def.spot || {};
    let p = typeof sp.lat === 'number' ? project(sp.lat, sp.lon) : { x: sp.x || 0, z: sp.z || 0 };
    const depot = { x: p.x, z: p.z };
    // snapTo busStop: stand on the pavement of the nearest real stop
    if (sp.snapTo === 'busStop' && deps.city && deps.city.busStops) {
      let best = null, bd = Infinity;
      for (const b of deps.city.busStops) { const d = Math.hypot(b.x - p.x, b.z - p.z); if (d < bd) { bd = d; best = b; } }
      if (best && bd < 200) p = { x: best.x - Math.cos(best.angle) * 3.2, z: best.z + Math.sin(best.angle) * 3.2 };
    }
    p = { x: p.x + (sp.dx || 0), z: p.z + (sp.dz || 0) };
    if (deps.collision && deps.collision.findFree) { const f = deps.collision.findFree(p.x, p.z, 1.6); p = { x: f.x, z: f.z }; }
    const y = groundY(surface, p.x, p.z);
    const g = new THREE.Group();
    g.position.set(p.x, y, p.z);
    const beam = beamMarker(0xffb347, 2.4, 34);
    const icon = iconSprite(def.icon || '?', '#ffcb3d', '#23324a', 4.2);
    icon.position.set(0, 12.5, 0);
    g.add(beam, icon);
    let av = null;
    if (deps.makeAvatar && def.npc) {
      try { av = deps.makeAvatar({ archetype: def.npc.archetype, seed: def.npc.seed || 1 }); } catch (e) { console.warn('[jobspots] npc failed', id, e); }
      if (av && av.group) { av.group.position.set(1.8, 0, 0); g.add(av.group); try { av.setMode && av.setMode('idle'); } catch (_) { /* optional */ } }
    }
    root.add(g);
    spots.push({ id, def, x: p.x, z: p.z, depot, group: g, icon, beam, av, name: `jobs.${def.game}.npc` });
  }

  function nearest() {
    let best = null, bd = REACH;
    for (const s of spots) { const d = Math.hypot(player.pos.x - s.x, player.pos.z - s.z); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  let wasShown = false;
  function update(dt, input) {
    const mg = quests && quests.minigames;
    for (const s of spots) {
      s.icon.position.y = 12.5 + Math.sin(performance.now() / 500 + s.x) * 0.6;
      if (s.av) {
        const dx = player.pos.x - s.x, dz = player.pos.z - s.z;
        if (Math.hypot(dx, dz) < 40) s.av.group.rotation.y = Math.atan2(dx - 1.8, dz);
        try { s.av.update(dt, 0); } catch (_) { /* optional */ }
      }
    }
    const busy = !mg || mg.active || (quests && quests.blocking) || player.speed > 12;
    const s = busy ? null : nearest();
    // A quest NPC in reach already put its own talk prompt up this frame: leave it alone.
    const taken = !!(hud && hud._prompt);
    if (!s || taken) { if (wasShown && hud) { hud.setPrompt(null); wasShown = false; } return; }
    hud.setPrompt(t('jobs.ui.talk', { name: t(s.name) }));
    wasShown = true;
    if (input.wasPressed('KeyF')) {
      hud.setPrompt(null); wasShown = false;
      mg.jobs.start({ job: s.id, params: { depot: s.depot } }).then((r) => {
        if (r && r.ok && hud.toastMsg) hud.toastMsg(t('jobs.ui.earned', { n: r.earned }));
      });
    }
  }

  // After the quest system's own update, so its prompt is set (or cleared) first.
  if (quests && typeof quests.update === 'function') {
    const orig = quests.update.bind(quests);
    quests.update = (dt, pl, input) => { const r = orig(dt, pl, input); try { update(dt, input); } catch (e) { console.warn('[jobspots] update failed', e); } return r; };
  }
  return { spots, update, nearest, root };
}
