// Data-driven quests: JSON files in data/quests/ describe who gives a quest, where everyone
// stands and which steps lead to the ending. Step types:
//   talk    - speak to an NPC (optionally `gather` others to them first)
//   collect - pick up N items scattered around a spot
//   reach   - get to a marked spot
//   find    - an item hidden somewhere inside a search zone; only the zone is marked (big map)
//   timed   - pick up a load and deliver it before the clock runs out, on allowed vehicles
//   choice  - a dialogue that ends in a tone choice; a wrong tone makes the NPC walk off, retry
//   escort  - walk an NPC to a spot at their pace; they wait when the player strays
//   drive   - pick up a passenger in an allowed vehicle and reach the drop-off before the clock
//   track   - find something by sound and walk up slowly (rushing scares it to another spot)
//   barter  - trade items along a chain of neighbours until the goal item is in the bag
//   minigame- hand over to a mini-game module (rhythm, race, photo...); stubbed until it exists
//   deduce  - read the clues, mark the spot on the big map (decoys cross out), then go there
// A talk or choice step with `auto: true` starts by itself when the player gets close (no F).
// Timed and drive steps can carry roadside `events` (a scene with a choice on the way).
// V2 story: options, steps and quests carry `effects` (City Scale, sector trust, flags), and
// steps and NPCs carry `if` conditions on them; a choice without `good` options has no wrong
// answer, only consequences.
// Nothing fails for good: every miss resets the step for another try.
// This module owns the quest NPCs, the 3D markers and the progress state; the HUD only draws.
import * as THREE from 'three';
import { toonMat } from './renderer.js';
import { project } from '../geo.js';
import { PropStage } from './questprops.js';
import { t as tr, register, i18n, dir, poiName, placeName, rich } from '../i18n.js';

const TALK_R = 10;      // world units; avatars are ~5 u tall, so this is a couple of body lengths
const TALK_R_VEHICLE = 20; // a car stops on the road, not at the pavement where the step's character stands
const PICK_R = 6;
const REVEAL_R = 55;    // a `find` item only shows itself this close
const NPC_ACTIVE_R = 260;
const NPC_VISIBLE_R = 520;
const NOT_DRIVABLE = /footway|path|cycleway|steps|pedestrian|sidewalk|corridor|track|service|construction/i;
const GATHER_TELEPORT_R = 150; // gathered NPCs further than this appear at the host instead of walking
const GATHER_TIMEOUT = 14;     // seconds a gathering walker gets before it is placed at its spot
const PARKED_NEAR_R = 30;      // a drive-step passenger gets out when the car stands this close to a drop it cannot reach
const PARKED_NEAR_S = 6;
const SCOOTER_SPEED = 22;      // vehicles.js cruise speed, the reference for delivery time limits
const SAVE_KEY = 'rishon.quests.v1';
// Quest ids that changed, so an old save keeps its progress. The wedding was a late side quest
// (q6) whose cast outranked every main-story copy of Avi, Savta and Moshiko once unlocked early;
// as m05b it sits in the main list right after the drive that brings the bride.
const RENAMED = { q6_wedding: 'm05b_wedding' };
// The founder cut m19_tour (the mayor's errands tour) on 2026-10-23. A save that lists it as done
// drops it (every id not in the story is filtered below); m20 now follows m18, and nothing is
// persisted for an open quest, so no save can be stuck inside it.
const JUMP_R = 300;
const LEAVE_R = 160;
const INTRO_RIDE_R = 400;       // further than this from the first giver, the opening ends with a ride there            // a character moving on walks off visibly when the player is this close             // a pickup further than this from the player is reached by a jump

// Quest text is registered with i18n under 'quest', in the active language with English as the
// fallback, so a missing Hebrew line shows the English one instead of a key.
export async function loadQuests(base = './data/quests/') {
  // Edited JSON must not come from a stale cache. A busy dev server drops connections now and
  // then: retry a few times before giving up on the whole story.
  const get = async (f) => {
    for (let k = 0; ; k++) {
      try {
        const r = await fetch(base + f, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        if (k >= 2 || /HTTP 404/.test(e.message)) throw e;
        await new Promise((res) => setTimeout(res, 400 * (k + 1)));
      }
    }
  };
  const index = await get('index.json');
  // Several string files (V1 side stories, V2 story) merge into one table; a missing file only
  // costs its own text.
  const files = Array.isArray(index.strings) ? index.strings : [index.strings];
  const table = async (lang) => {
    const parts = await Promise.all(files.map((f) => get(f.replace('{lang}', lang)).catch((e) => { console.warn('[quests] no strings', f, lang, e.message); return {}; })));
    return parts.reduce(deepMerge, {});
  };
  const side = index.side || [];
  const acts = index.activities || [];
  const [active, fallback, ...all] = await Promise.all([
    table(i18n.lang),
    i18n.lang === 'en' ? Promise.resolve(null) : table('en'),
    ...[...index.quests, ...side, ...acts].map((id) => get(id + '.json')),
  ]);
  const quests = all.slice(0, all.length - acts.length), activities = all.slice(all.length - acts.length);
  quests.forEach((q, i) => { if (i >= index.quests.length) q.side = true; });
  register('quest', active, fallback || active);
  return { quests, activities, minigames: index.minigames || null, intro: index.intro || null };
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// meshes

function labelSprite(text, bg, fg) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.strokeStyle = '#23324a'; g.lineWidth = 10;
  g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = fg; g.font = 'bold 84px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(3.2, 3.2, 1);
  s.renderOrder = 10;
  return s;
}

function itemMesh(kind) {
  const g = new THREE.Group();
  const add = (geo, color, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, toonMat(color)); m.position.set(x, y, z); g.add(m); return m; };
  if (kind === 'cable') {
    add(new THREE.TorusGeometry(0.9, 0.22, 8, 20), 0x222831);
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.8, 8), 0xffcb3d, 0.9).rotation.z = Math.PI / 2;
  } else if (kind === 'tomato') {
    add(new THREE.SphereGeometry(0.85, 14, 10), 0xe8364f).scale.y = 0.85;
    add(new THREE.ConeGeometry(0.35, 0.4, 5), 0x3c9a3c, 0, 0.8);
  } else if (kind === 'charcoal') {
    add(new THREE.BoxGeometry(1.4, 1.8, 0.7), 0x2b2b2b);
    add(new THREE.BoxGeometry(1.45, 0.5, 0.75), 0xff6b3d);
  } else if (kind === 'antenna') {
    add(new THREE.CylinderGeometry(0.15, 0.25, 2.6, 8), 0xd9dde3, 0, 0.3);
    const dish = add(new THREE.SphereGeometry(0.8, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.5), 0xf4f4f4, 0, 1.4);
    dish.rotation.x = 0.9;
    add(new THREE.SphereGeometry(0.16, 8, 6), 0xe8364f, 0, 1.75);
  } else if (kind === 'tray') {
    add(new THREE.CylinderGeometry(1.3, 1.3, 0.12, 20), 0xc9ced6);
    add(new THREE.SphereGeometry(1.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0xe6eaef, 0, 0.06);
    add(new THREE.SphereGeometry(0.18, 8, 6), 0x23324a, 0, 1.2);
  } else if (kind === 'sticker') {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const s = c.getContext('2d');
    s.fillStyle = '#fff8ea'; s.beginPath(); s.arc(32, 32, 30, 0, Math.PI * 2); s.fill();
    s.fillStyle = '#ffffff'; s.strokeStyle = '#23324a'; s.lineWidth = 5;
    s.beginPath(); s.ellipse(32, 32, 22, 14, 0, 0, Math.PI * 2); s.fill(); s.stroke();
    s.fillStyle = '#23324a'; s.beginPath(); s.arc(32, 22, 7, 0, Math.PI * 2); s.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    g.add(m);
  } else if (kind === 'pot') {
    add(new THREE.CylinderGeometry(1.1, 1.0, 1.3, 16), 0x8a8f99, 0, 0.65);
    add(new THREE.CylinderGeometry(1.18, 1.18, 0.16, 16), 0x5a5f6b, 0, 1.36);
    add(new THREE.SphereGeometry(0.2, 8, 6), 0x23324a, 0, 1.55);
    for (const x of [-1.2, 1.2]) add(new THREE.BoxGeometry(0.3, 0.14, 0.4), 0x23324a, x, 1.1);
  } else if (kind === 'dog') {
    // A sandy street dog, a little chunky like the avatars; the tail and the bark bubble animate.
    const body = add(new THREE.BoxGeometry(1.3, 1.1, 2.6), 0xc98b4a, 0, 1.3);
    body.scale.set(1, 1, 1);
    add(new THREE.BoxGeometry(1.1, 1.0, 1.1), 0xc98b4a, 0, 2.2, 1.5);
    add(new THREE.BoxGeometry(0.7, 0.5, 0.6), 0xf4efe2, 0, 2.0, 2.2);
    add(new THREE.SphereGeometry(0.16, 8, 6), 0x1d1d24, 0, 2.15, 2.52);
    for (const x of [-0.45, 0.45]) add(new THREE.BoxGeometry(0.3, 0.6, 0.2), 0x7a4b2e, x, 2.8, 1.4).rotation.z = x * 0.6;
    for (const [x, z] of [[-0.45, 0.9], [0.45, 0.9], [-0.45, -0.9], [0.45, -0.9]]) add(new THREE.BoxGeometry(0.35, 0.8, 0.35), 0xb07a3e, x, 0.4, z);
    const tail = new THREE.Group(); tail.position.set(0, 1.7, -1.3);
    const tm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 1.0), toonMat(0xc98b4a)); tm.position.z = -0.45; tm.rotation.x = -0.6; tail.add(tm);
    g.add(tail);
    g.userData.tail = tail;
    const bubble = labelSprite('!', '#ffffff', '#23324a');
    bubble.position.set(0, 4.2, 0); bubble.scale.set(2.2, 2.2, 1); bubble.visible = false;
    g.add(bubble);
    g.userData.bubble = bubble;
  } else {
    add(new THREE.OctahedronGeometry(0.9), 0xffcb3d);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function beam(color) {
  const g = new THREE.Group();
  const col = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 60, 16, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
  col.position.y = 30;
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.2, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.15;
  g.add(col, ring);
  g.userData.ring = ring;
  return g;
}

function stickerBench(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#fff8ea'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffffff'; g.strokeStyle = '#23324a'; g.lineWidth = 8;
  g.beginPath(); g.ellipse(64, 56, 46, 30, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = '#23324a'; g.beginPath(); g.arc(64, 36, 14, 0, Math.PI * 2); g.fill();
  g.font = 'bold 17px Rubik, system-ui, sans-serif'; g.textAlign = 'center'; g.direction = text.dir;
  g.fillText(text.label, 64, 114, 120);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const grp = new THREE.Group();
  const bench = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 2), toonMat(0xa0703c));
  bench.position.y = 1.6;
  const legs = [-2.4, 2.4].map((x) => { const l = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 1.6), toonMat(0x5a5f6b)); l.position.set(x, 0.8, 0); return l; });
  const st = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: tex }));
  st.rotation.x = -Math.PI / 2; st.position.set(0.8, 1.87, 0);
  grp.add(bench, ...legs, st);
  grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return grp;
}

function inPoly(x, z, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[i][0] ?? pts[i].x, az = pts[i][1] ?? pts[i].z, bx = pts[j][0] ?? pts[j].x, bz = pts[j][1] ?? pts[j].z;
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) c = !c;
  }
  return c;
}

function seeded(seed) {
  let a = 0;
  for (const ch of seed) a = (a * 31 + ch.charCodeAt(0)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Street graph for escorts: road polylines become nodes on a 0.5 u grid, consecutive points are
// edges, and nearby loose ends are stitched so split ways still connect. A* gives a path that
// stays on streets instead of cutting through buildings.

class RoadGraph {
  constructor(roads) {
    this.x = []; this.z = []; this.adj = [];
    const ids = new Map();
    const node = (x, z) => {
      const k = `${Math.round(x * 2)}:${Math.round(z * 2)}`;
      let i = ids.get(k);
      if (i === undefined) { i = this.x.length; ids.set(k, i); this.x.push(x); this.z.push(z); this.adj.push([]); }
      return i;
    };
    const link = (a, b) => { if (a !== b && !this.adj[a].includes(b)) { this.adj[a].push(b); this.adj[b].push(a); } };
    for (const r of roads) {
      let prev = -1;
      for (const [x, z] of r.points) { const i = node(x, z); if (prev >= 0) link(prev, i); prev = i; }
    }
    // Spatial hash, also used by nearest().
    this.cell = 12;
    this.grid = new Map();
    for (let i = 0; i < this.x.length; i++) {
      const k = `${Math.floor(this.x[i] / this.cell)}:${Math.floor(this.z[i] / this.cell)}`;
      (this.grid.get(k) || this.grid.set(k, []).get(k)).push(i);
    }
    for (let i = 0; i < this.x.length; i++) {
      if (this.adj[i].length > 1) continue; // only loose ends need stitching
      for (const j of this.around(this.x[i], this.z[i], 1)) {
        if (j !== i && Math.hypot(this.x[i] - this.x[j], this.z[i] - this.z[j]) < 3) link(i, j);
      }
    }
  }

  *around(x, z, ring) {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let a = -ring; a <= ring; a++) for (let b = -ring; b <= ring; b++) {
      const list = this.grid.get(`${cx + a}:${cz + b}`);
      if (list) yield* list;
    }
  }

  nearest(x, z) {
    for (let ring = 1; ring < 40; ring += 3) {
      let best = -1, bd = Infinity;
      for (const i of this.around(x, z, ring)) {
        const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  path(ax, az, bx, bz) {
    const s = this.nearest(ax, az), e = this.nearest(bx, bz);
    if (s < 0 || e < 0) return null;
    const n = this.x.length, g = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1);
    const h = (i) => Math.hypot(this.x[i] - this.x[e], this.z[i] - this.z[e]);
    const heap = [[h(s), s]];
    g[s] = 0;
    const push = (f, i) => { heap.push([f, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    for (let guard = 0; heap.length && guard < 400000; guard++) {
      const [, i] = pop();
      if (i === e) break;
      for (const j of this.adj[i]) {
        const ng = g[i] + Math.hypot(this.x[i] - this.x[j], this.z[i] - this.z[j]);
        if (ng < g[j]) { g[j] = ng; from[j] = i; push(ng + h(j), j); }
      }
    }
    if (from[e] < 0 && s !== e) return null;
    const out = [];
    for (let i = e; i >= 0; i = from[i]) out.push({ x: this.x[i], z: this.z[i] });
    return out.reverse();
  }
}

// ---------------------------------------------------------------------------------------------

export class QuestSystem {
  // city (optional) supplies busStops; surface(x, z, y) the walkable height (terrain + bridges).
  // hooks.onDialogueLine(questId, lineKey, speaker) fires for every line shown (voice playback).
  constructor({ scene, collision, makeAvatar, pois = [], places = [], roads = [], city = null, surface = null, hooks = {}, spawn, data, hud, reset = false }) {
    this.scene = scene;
    this.collision = collision;
    this.hud = hud;
    this.hooks = hooks || {};
    this.t = (path, vars) => tr(`quest.${path}`, vars);
    this.quests = data.quests;
    this.introKey = data.intro || null;
    this.byId = Object.fromEntries(this.quests.map((q) => [q.id, q]));
    this.qIndex = Object.fromEntries(this.quests.map((q, i) => [q.id, i]));
    this.poi = Object.fromEntries(pois.map((p) => [p.id, p]));
    // Neighbourhood labels from buildCity carry `name` (English when OSM has it) and `nameLocal`;
    // older builds used id/nameEn. Any of them, in any letter case, addresses the place.
    this.place = {};
    for (const p of places) for (const k of [p.id, p.nameEn, p.name, p.nameLocal]) if (k) { this.place[k] = p; this.place[String(k).toLowerCase()] = p; }
    this.world = { busStops: city?.busStops || [], lots: [], shops: [] };
    this.surface = typeof surface === 'function' ? surface : null;
    this.spawn = spawn;
    this.roads = roads.filter((r) => r && r.points && r.points.length >= 2 && !/motorway|trunk|rail|tram|subway/i.test(r.kind || ''));
    this.root = new THREE.Group();
    this.root.name = 'quests';
    scene.add(this.root);
    this.time = 0;
    this.dlg = null;
    this.clicked = false;
    this.optionClicked = -1;
    this.ambientT = 0;
    if (hud && hud.onDialogueClick) hud.onDialogueClick(() => { this.clicked = true; });
    if (hud && hud.onOptionClick) hud.onOptionClick((i) => { this.optionClicked = i; });

    // One instance per (quest, character). A character that appears in several quests is shown
    // only at its latest unlocked quest, so it seems to move through the story. Avatars are built
    // the first time an instance is shown: two dozen quests declare far more instances than are
    // ever on screen at once.
    this.makeAvatar = makeAvatar;
    this.npcs = {};
    this.quests.forEach((q, qi) => {
      for (const [id, def] of Object.entries(q.npcs || {})) {
        const p = this.resolve(def.at, qi);
        const free = collision.findFree(p.x, p.z, 1.8);
        // findFree gives up and returns the input after its search; say so, since a map change
        // that buries an NPC in a building or the sea makes its quest unplayable.
        if (!collision.isFree(free.x, free.z, 1.8)) console.warn(`[quests] ${q.id}/${id} has no free spot near`, def.at);
        const key = `${q.id}:${id}`;
        const n = { key, id, quest: q.id, qi, def, av: null, unlockOnly: !!def.unlockOnly, cond: def.if || null, x: free.x, z: free.z, y: 0, home: { ...free }, target: null, path: null, yaw: def.yaw || 0, marker: null, markerKind: null };
        n.y = this.groundY(n.x, n.z, Infinity);
        this.npcs[key] = n;
      }
    });

    // Side activities (surfing at the surf club...): a host who is always there and whose
    // dialogue offers a repeatable mini-game. Dormant until their landmark exists.
    this.activities = (data.activities || []).filter((act) => !act.needsPoi || this.poi[act.needsPoi]);
    for (const act of this.activities) {
      for (const [id, def] of Object.entries(act.npcs || {})) {
        const p = this.resolve(def.at);
        const free = collision.findFree(p.x, p.z, 1.8);
        const key = `${act.id}:${id}`;
        const n = { key, id, quest: act.id, qi: -1, def, activity: act, av: null, x: free.x, z: free.z, y: 0, home: { ...free }, target: null, path: null, yaw: def.yaw || 0, marker: null, markerKind: null };
        n.y = this.groundY(n.x, n.z, Infinity);
        this.npcs[key] = n;
      }
    }

    // Story state: finished quests plus the V2 moral ledger (flags, City Scale, trust per sector).
    this.state = { done: [], active: null };
    this.story = { flags: {}, scale: 0, trust: {} };
    if (!reset) {
      try {
        const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
        if (s && Array.isArray(s.done)) this.state.done = [...new Set(s.done.map((id) => RENAMED[id] || id))].filter((id) => this.byId[id]);
        if (s && s.story) this.story = { flags: s.story.flags || {}, scale: s.story.scale || 0, trust: s.story.trust || {} };
      } catch (_) { /* storage blocked */ }
    } else this.save();
    // Quests already done keep their pairs standing together, laughing.
    for (const q of this.quests) if (this.state.done.includes(q.id)) this.settleDone(q);
    this.stepObjs = [];
    this.carry = null;
    // Story props (drums, amps, the generator, chairs...): placed, held and carried as the story
    // says; quest-level `scene` props are set up while a quest is open, `leave` props stay after.
    this.props = new PropStage({
      scene,
      groundY: (x, z) => this.groundY(x, z),
      resolve: (at) => this.resolve(at),
      npcAt: (id) => { const q = this.byId[this.props && this.props.ctx]; return q ? this.npc(q, id) : this.current(id); },
      avatarOf: (id) => (id === 'player' ? this.playerAv : (this.npcAt(id) || {}).av || null),
      solid: (points) => collision.addPolygon({ points, kind: 'stage' }),
    });
    this.refreshScene();
    // Finished quests that seated a crowd: the chairs exist only now, so sit them down again.
    for (const q of this.quests) if (this.state.done.includes(q.id) && !q.dismantle) for (const s of q.steps) if (s.gather && s.seat) this.gatherTo(q, s.npc, s.gather, false, s.seat);
    this.lastPlayer = { x: spawn.x, z: spawn.z };
    this.refreshHud();
  }

  // Lead wiring for systems that land later (parking lots, storefronts); every use is guarded.
  setWorld(extra = {}) {
    Object.assign(this.world, extra);
    if (typeof extra.restrictedAt === 'function') this.auditRestricted();
    if (extra.bigmap && typeof extra.bigmap.onWaypointChange === 'function') extra.bigmap.onWaypointChange((wp) => this.onWaypoint(wp));
    if (extra.bigmap && this.gps && extra.bigmap.setGps) extra.bigmap.setGps(this.gps, () => this.routePoints());
  }

  // No quest place may sit inside a sealed zone (military bases, fenced compounds): the player
  // could never get there. Every anchor is resolved and checked once the world knows its zones;
  // offenders are listed in the console (and returned, for tests).
  auditRestricted() {
    const R = this.world.restrictedAt, bad = [];
    if (typeof R !== 'function') return bad;
    const check = (q, what, at) => {
      if (!at || typeof at.npc === 'string') return;
      if (!(typeof at.poi === 'string' || typeof at.place === 'string' || typeof at.lat === 'number')) return;
      const p = this.resolve(at, this.qIndex[q.id]);
      let why = null;
      try { why = R(p.x, p.z); } catch (_) { /* optional */ }
      if (why) bad.push(`${q.id} ${what}: ${(why && why.kind) || 'sealed zone'}`);
    };
    for (const q of this.quests) {
      for (const [id, d] of Object.entries(q.npcs || {})) check(q, `npc ${id}`, d.at);
      q.steps.forEach((s, i) => {
        for (const k of ['at', 'pickup', 'answer', 'home']) check(q, `step ${i} ${k}`, s[k]);
        for (const sp of s.spots || []) check(q, `step ${i} spot`, sp);
        for (const d of s.decoys || []) check(q, `step ${i} decoy`, d.at);
        for (const a of [].concat(s.props || [], s.propsDone || [])) check(q, `step ${i} prop`, a.at || a.to);
      });
      for (const a of [].concat(q.scene || [], q.leave || [])) check(q, 'prop', a.at);
    }
    if (bad.length) console.warn('[quests] places inside sealed zones:', bad);
    return bad;
  }

  // Deduce: the player marks a spot on the big map where the clues point. A decoy answers with
  // its joke and stays crossed out; the right spot puts a beam there to go and knock.
  onWaypoint(wp) {
    const a = this.state.active, q = a && this.byId[a.id], s = q && q.steps[a.step];
    if (!wp || !s || s.type !== 'deduce' || a.phase !== 'guess') return;
    const qi = this.qIndex[q.id];
    const ans = this.resolve(s.answer, qi);
    if (Math.hypot(wp.x - ans.x, wp.z - ans.z) < (s.radius || 60)) { this.solveDeduce(q, s, a, ans); return; }
    for (const [i, d] of (s.decoys || []).entries()) {
      const p = this.resolve(d.at, qi);
      if (Math.hypot(wp.x - p.x, wp.z - p.z) < (d.radius || s.radius || 60)) {
        a.crossed = (a.crossed || []).concat(a.crossed?.includes(i) ? [] : [i]);
        this.deduceMiss(q, s, a, wp, ans, this.qt(q, d.joke));
        return;
      }
    }
    this.deduceMiss(q, s, a, wp, ans, this.t('ui.deduceNo'));
  }

  // A wrong guess: crossed out on the map, and a friendly pointer towards the answer.
  deduceMiss(q, s, a, wp, ans, lead) {
    a.fails = (a.fails || 0) + 1;
    a.idle = 0;
    a.marks = (a.marks || []).concat([{ x: wp.x, z: wp.z }]);
    const dx = ans.x - wp.x, dz = ans.z - wp.z, d = Math.hypot(dx, dz);
    const temp = this.t(d < 600 ? 'ui.deduceHot' : d < 2000 ? 'ui.deduceWarm' : 'ui.deduceCold');
    // Map north is -z, east is +x (the sea is west).
    const ns = Math.abs(dz) > Math.abs(dx) * 0.4 ? (dz < 0 ? 'n' : 's') : '';
    const ew = Math.abs(dx) > Math.abs(dz) * 0.4 ? (dx > 0 ? 'e' : 'w') : '';
    const where = [ns, ew].filter(Boolean).map((k) => this.t(`ui.dir.${k}`)).join(this.t('ui.dir.and'));
    a.msg = `${lead} ${this.t('ui.deduceDir', { temp, dir: where })}`;
    if (a.fails === 2) a.msg += ` ${this.t('ui.deduceOffer')}`;
    if (this.hud) this.hud.toastMsg(a.msg);
    if (this.world.bigmap && this.world.bigmap.clearWaypoint) this.world.bigmap.clearWaypoint();
    this.deduceOverlay(q, s, a);
  }

  deduceHint(q, s, a) {
    const hints = s.hints || [];
    if ((a.hint || 0) >= hints.length) { this.deduceShow(q, s, a); return; }
    a.hint = (a.hint || 0) + 1;
    a.idle = 0;
    a.msg = '';
    const h = hints[a.hint - 1];
    if (this.hud) this.hud.toastMsg(`${this.t('ui.deduceHintN', { n: a.hint })} ${this.qt(q, h.text)}`);
    this.deduceOverlay(q, s, a);
    if (h.circle && this.world.bigmap && this.world.bigmap.focus) {
      const ans = this.resolve(s.answer, this.qIndex[q.id]);
      this.world.bigmap.focus(ans.x, ans.z + 170, 0.9);
    }
  }

  // "Show me": nobody stays stuck. The spot is marked and the step moves on to going there.
  deduceShow(q, s, a) {
    if (a.phase !== 'guess') return;
    const ans = this.resolve(s.answer, this.qIndex[q.id]);
    if (this.world.bigmap && this.world.bigmap.focus) this.world.bigmap.focus(ans.x, ans.z + 170, 0.9);
    this.solveDeduce(q, s, a, ans);
  }

  // The clue card on the main HUD, for the whole detective step (guessing and walking there):
  // the clues, every hint so far, and one line saying what to do next.
  deduceClues(q, step, a) {
    if (!this.hud || !this.hud.setClues) return;
    const hints = (step.hints || []).slice(0, a.hint || 0);
    let html = `<b>${rich(this.qt(q, step.card || 'c.card'))}</b>`;
    html += hints.map((h, i) => `<div>${rich(this.t('ui.deduceHintN', { n: i + 1 }))} ${rich(this.qt(q, h.text))}</div>`).join('');
    html += `<div class="nudge">${rich(this.t(a.phase === 'go' ? 'ui.deduceNudgeGo' : 'ui.deduceNudgeGuess'))}</div>`;
    this.hud.setClues(html);
  }

  // The card on the big map: the clues, the hints so far, the last guess's feedback, the area
  // circle from the last hint, and buttons for the next hint or "show me".
  deduceOverlay(q, s, a) {
    const bm = this.world.bigmap;
    if (!bm || !bm.setOverlay) return;
    this._dedOv = true;
    const hints = s.hints || [], got = hints.slice(0, a.hint || 0);
    const ans = this.resolve(s.answer, this.qIndex[q.id]);
    const R = (s.radius || 60) * 1.6;
    let html = `<b>${rich(this.qt(q, s.card || 'c.card'))}</b>`;
    html += got.map((h, i) => `<div>${rich(this.t('ui.deduceHintN', { n: i + 1 }))} ${rich(this.qt(q, h.text))}</div>`).join('');
    html += `<div style="opacity:.75;margin-top:4px">${rich(this.t('ui.deduceKeys'))}</div>`;
    const circle = got.some((h) => h.circle);
    const actions = [];
    if ((a.hint || 0) < hints.length) actions.push({ label: rich(this.t('ui.deduceHintBtn')), fn: () => this.deduceHint(q, s, a) });
    if ((a.fails || 0) >= 2 || (a.hint || 0) >= hints.length) actions.push({ label: rich(this.t('ui.deduceShow')), fn: () => this.deduceShow(q, s, a) });
    bm.setOverlay({
      html, msg: a.msg ? rich(a.msg) : '', actions,
      circles: circle ? [{ x: ans.x, z: ans.z, r: R, label: this.t('ui.deduceHere') }] : [],
      crosses: a.marks || [],
      keys: { KeyH: () => this.deduceHint(q, s, a) },
      focus: circle ? { x: ans.x, z: ans.z + 170, s: 0.9 } : null, // circle above the card
    });
  }

  solveDeduce(q, s, a, ans) {
    a.phase = 'go';
    this._dedOv = false;
    if (this.world.bigmap && this.world.bigmap.setOverlay) this.world.bigmap.setOverlay(null);
    a.spot = ans;
    this.addBeam(ans, 0x2ec4b6);
    if (this.hud) this.hud.toastMsg(this.qt(q, s.solved || 'solved'));
    this.refreshHud();
  }
  setHooks(hooks = {}) { Object.assign(this.hooks, hooks); }

  // A walkable route along streets and paths (escorts; tests that lead a crowd).
  roadPath(ax, az, bx, bz) {
    this.graph ||= new RoadGraph(this.roads);
    return this.graph.path(ax, az, bx, bz) || [];
  }

  groundY(x, z, y = Infinity) {
    if (!this.surface) return 0;
    try { const h = this.surface(x, z, y); return Number.isFinite(h) ? h : 0; } catch (_) { return 0; }
  }

  // Where a character's feet go: the ground, or the top of a stage prop when it stands on one.
  standY(x, z, y = Infinity) {
    const g = this.groundY(x, z, y), t = this.props ? this.props.surfaceAt(x, z) : null;
    return t != null ? Math.max(g, t) : g;
  }

  // Locations are a landmark POI, a neighbourhood place or lat/lon, plus an offset in world units,
  // never raw x/z: the world scale changes and a hardcoded spot would drift. `busStop` / `lot` /
  // `shop` pick the nearest such world feature to that anchor when the world has it, and fall back
  // to the anchor itself otherwise. A missing anchor places the quest near the spawn.
  resolve(at = {}, qi = 0) {
    const ll = typeof at.lat === 'number' ? project(at.lat, at.lon) : null;
    const p = ll || (at.poi && this.poi[at.poi]) || (at.place && (this.place[at.place] || this.place[String(at.place).toLowerCase()]));
    let base;
    if (p) base = { x: p.x + (at.dx || 0), z: p.z + (at.dz || 0) };
    else {
      const key = at.poi || at.place;
      if (key && !this._warnedPoi?.has(key)) { (this._warnedPoi ||= new Set()).add(key); console.warn('[quests] missing anchor', key, '- placing near spawn'); }
      base = { x: this.spawn.x + 30 + qi * 25 + (at.dx || 0) * 0.3, z: this.spawn.z + (at.dz || 0) * 0.3 };
    }
    const within = at.within || 250;
    const nearestOf = (list, pick = (e) => e) => {
      let best = null, bd = within;
      for (const e of list || []) { const c = pick(e); if (!c) continue; const d = Math.hypot(c.x - base.x, c.z - base.z); if (d < bd) { bd = d; best = c; } }
      return best;
    };
    if (at.busStop) return nearestOf(this.world.busStops) || base;
    if (at.lot) return nearestOf(this.world.lots, (l) => l.stalls?.[0] || l.centre || null) || base;
    if (at.shop) return nearestOf(this.world.shops.filter((s) => s.shop === at.shop || s.amenity === at.shop)) || base;
    // `street` snaps to the nearest street or footpath (a person on the pavement); `road` to the
    // nearest street a car can drive (a drop-off: a fenced lot or a building footprint next to
    // the anchor is never reachable by car, so the ride would never end).
    if (at.road) return this.streetSpot(base.x, base.z, true);
    if (at.street) return this.streetSpot(base.x, base.z);
    return base;
  }

  // A free spot can still sit in a closed courtyard the player cannot enter, so pickups snap to
  // the nearest street first (roads have no colliders, so a street point is always reachable).
  streetSpot(x, z, drivable = false) {
    let best = Infinity, bx = x, bz = z;
    for (const r of this.roads) {
      if (drivable && NOT_DRIVABLE.test(r.kind || '')) continue;
      const p = r.points;
      for (let i = 0; i < p.length - 1; i++) {
        const ax = p[i][0], az = p[i][1], vx = p[i + 1][0] - ax, vz = p[i + 1][1] - az;
        if (Math.abs(ax - x) > 300 && Math.abs(p[i + 1][0] - x) > 300) continue;
        const l2 = vx * vx + vz * vz;
        let t = l2 > 0 ? ((x - ax) * vx + (z - az) * vz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + vx * t, cz = az + vz * t, d = (cx - x) ** 2 + (cz - z) ** 2;
        if (d < best) { best = d; bx = cx; bz = cz; }
      }
    }
    return this.collision.findFree(bx, bz, 2.2);
  }

  // A running mini-game freezes the player unless it says it drives the player itself (a race).
  get blocking() { return !!this.dlg || !!this.jumping || !!(this.mg && this.mg.blocks !== false); }
  get hum() { return Math.max(0, 100 - this.state.done.reduce((s, id) => s + (this.byId[id]?.hum || 0), 0)); }

  unlocked(q) { return (q.requires || []).every((r) => this.state.done.includes(r)); }

  available() {
    if (this.state.active) return [];
    return this.quests.filter((q) => !this.state.done.includes(q.id) && this.unlocked(q) && this.inMode(q));
  }

  // Two story modes (docs/SUPER_MALUL.md): the regular Rishoni's story, and Malul in his Super
  // Malul suit (quests marked `mode: "hero"`). Each is offered only in its own mode.
  inMode(q) { return (q.mode === 'hero') === !!this.heroMode; }

  // Switch the story mode. The running quest of the mode being left is parked and picked up again
  // (from the start of its current step) when the player switches back.
  setHeroMode(on) {
    on = !!on;
    if (on === !!this.heroMode) return;
    this.endMinigame(); this.clearStepObjs(); this.dropCarry();
    const a = this.state.active;
    this._parked ||= {};
    this._parked[this.heroMode ? 'hero' : 'main'] = a ? { id: a.id, step: Math.max(0, a.step) } : null;
    this.state.active = null;
    this.heroMode = on;
    const p = this._parked[on ? 'hero' : 'main'];
    if (p && this.byId[p.id]) { this.state.active = { id: p.id, step: p.step - 1 }; this.nextStep(); }
    this.refreshHud();
  }

  // The instance a character currently lives as: the latest quest that declares it and is
  // unlocked, else its first appearance.
  // `unlockOnly` characters (the Heckler) do not exist before their quest opens.
  current(char) {
    // The quest being played, or the next one offered, owns its characters even when a later-listed
    // side quest is also unlocked (they would otherwise hide the giver: Moshiko of sm01 vs q1).
    const pref = this._prefer && this._prefer.get(char);
    if (pref && !(pref.cond && !this.test(pref.cond))) return pref;
    let best = null;
    for (const n of Object.values(this.npcs)) {
      if (n.id !== char) continue;
      if (n.activity) { if (this.activityOn(n.activity)) return n; continue; }
      if (n.unlockOnly && !this.unlocked(this.byId[n.quest])) continue;
      if (this.byId[n.quest] && this.byId[n.quest].mode === 'hero' && !this.heroMode) continue; // the hero story's cast stays out of the regular story
      if (n.cond && !this.test(n.cond)) continue;
      if (!best) { best = n; continue; }
      const ok = this.unlocked(this.byId[n.quest]);
      if (ok && (n.qi > best.qi || !this.unlocked(this.byId[best.quest]))) best = n;
    }
    return best;
  }

  // An NPC as a quest refers to it: its own instance if it declares the character, else the
  // character's current instance (the finale gathers people from earlier quests).
  npc(q, char) { return this.npcs[`${q.id}:${char}`] || this.current(char); }

  save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ done: this.state.done, story: this.story })); } catch (_) { /* storage blocked */ }
    if (this.hooks.onSave) { try { this.hooks.onSave(); } catch (e) { console.warn('[quests] onSave failed', e); } }
  }

  // The avatar, its marker and its first pose, built on first show.
  ensureAv(n) {
    if (n.av || n.avFailed) return n.av;
    let av = null;
    for (const arch of [n.def.archetype, n.def.fallback].filter(Boolean)) {
      // `look` (partial config, e.g. Ofir's instrument for this scene) and `seed` (which of the
      // archetype's outfits) only apply to the character's own archetype, not the fallback.
      const own = arch === n.def.archetype && (n.def.look || n.def.seed != null);
      const arg = own ? { ...(n.def.look || {}), archetype: arch, ...(n.def.seed != null ? { seed: n.def.seed } : {}) } : arch;
      try { av = this.makeAvatar ? this.makeAvatar(arg) : null; } catch (e) { console.warn('[quests] avatar failed for', n.id, arch, e); }
      if (av && av.group) break;
      av = null;
    }
    if (!av) { n.avFailed = true; return null; }
    try { av.setMode && av.setMode('idle'); } catch (_) { /* optional */ }
    this.scene.add(av.group);
    const marker = labelSprite('!', '#ffcb3d', '#23324a');
    marker.position.set(0, (av.height || 5.2) + 2.2, 0);
    marker.visible = false;
    av.group.add(marker);
    av.group.position.set(n.x, n.y, n.z);
    n.av = av; n.marker = marker; n.markerKind = null;
    return av;
  }

  // ---------------- side activities ----------------
  activityOn(act) { return (act.requires || []).every((r) => this.state.done.includes(r)); }

  flagValue(k) { return this.ledger ? this.ledger.flag(k) : this.story.flags[k]; }

  // A hangout activity has no host of its own: its `crowdHosts` are the crowd's regulars
  // (crowd.named), talkable while they sit at the hangout (home 'lookout', or crowd's own
  // atLookout flag) and while no quest has taken them over (holdNamed).
  nearestHangout(px, pz) {
    const crowd = this.world.crowd;
    if (!crowd || !crowd.named) return null;
    let best = null, bd = TALK_R;
    for (const act of this.activities) {
      if (!act.crowdHosts || !this.activityOn(act)) continue;
      for (const id of act.crowdHosts) {
        const I = crowd.named[id];
        if (!I || (this._held && this._held[id])) continue;
        if (!(I.atLookout || I.home === (act.home || 'lookout'))) continue;
        const d = Math.hypot(I.x - px, I.z - pz);
        if (d < bd) { bd = d; best = { act, id }; }
      }
    }
    return best;
  }

  // One friend's line (a different one each time, in order), then the choice: ask for a song
  // (the crowd plays it, Malul on the kit) or say bye.
  openHangout(act, id) {
    this._hangIx ||= {};
    const pool = this.t(`${act.id}.lines.${id}`);
    const sets = Array.isArray(pool) ? pool : [];
    const i = (this._hangIx[id] = ((this._hangIx[id] ?? -1) + 1) % Math.max(1, sets.length));
    const lines = sets[i] || [[id, '...']];
    const opts = act.options || [];
    // Ofir changes instruments between visits: his line names the one the crowd gave him today.
    const I = this.world.crowd && this.world.crowd.named && this.world.crowd.named[id];
    const kind = I && (typeof I.instrument === 'string' ? I.instrument : I.instrument && I.instrument.type);
    const inst = this.t(`${act.id}.inst.${kind}`);
    const vars = { inst: typeof inst === 'string' && !inst.includes('.inst.') ? inst : this.t(`${act.id}.inst.other`) };
    this.openDialogue(`${act.id}.lines.${id}.${i}`, {
      lines, vars,
      choices: opts.map((o) => this.qt(act, o.text)),
      onChoice: (k) => {
        const o = opts[k];
        if (o.play) {
          const crowd = this.world.crowd;
          for (const h of act.crowdHosts) { try { crowd && crowd.playNamed && crowd.playNamed(h, o.play, { drums: h === (act.drummer || 'malul') }); } catch (e) { console.warn('[quests] playNamed failed', e); } }
        }
        if (o.reply) this.openDialogue(`${act.id}.${o.reply}`, {});
      },
    });
  }

  // The host's line, then a choice; an option with a game runs that mini-game (as often as the
  // player likes), with an optional line before and after.
  openActivity(act) {
    const opts = act.options || [];
    this.openDialogue(`${act.id}.${this.pick(act.dialogue)}`, {
      choices: opts.map((o) => this.qt(act, o.text)),
      onChoice: (i) => {
        const o = opts[i];
        if (!o.game) { if (o.reply) this.openDialogue(`${act.id}.${o.reply}`, {}); return; }
        const run = () => this.startMinigame(o.game, o.params, (res) => {
          if (res && res.effects) this.applyEffects(res.effects, act.id);
          this.applyEffects(o.effects, act.id);
          // Best score lives in the story ledger, which the profile saves.
          const score = res && Number.isFinite(res.score) ? Math.round(res.score) : null;
          const prevBest = Number(this.flagValue(`${act.id}_best`)) || 0;
          if (score != null && score > prevBest) this.applyEffects({ flag: `${act.id}_best=${score}` }, act.id);
          const vars = { score: score ?? 0, best: Math.max(prevBest, score || 0) };
          if (res && res.quit) { if (o.afterQuit) this.openDialogue(`${act.id}.${o.afterQuit}`, { vars }); return; }
          const after = this.pick(res && res.ok === false ? o.afterFail || o.after : score != null && score > prevBest && prevBest > 0 && o.afterBest ? o.afterBest : o.after);
          if (after) this.openDialogue(`${act.id}.${after}`, { vars });
        }, act);
        // The first time: a longer intro (how it works, who is out there); later the short one.
        const first = o.introFirst && !this.test(`${act.id}_seen`);
        const intro = first ? o.introFirst : o.intro;
        if (first) this.applyEffects({ flag: `${act.id}_seen` }, act.id);
        if (intro) this.openDialogue(`${act.id}.${intro}`, { onDone: run }); else run();
      },
    });
  }

  // ---------------- the opening ----------------
  // A new story (no main quest done or open) opens with a few lines that say where the band is;
  // a player who is far from the first giver (an old save, a profile moved elsewhere) gets a
  // short ride there. Shown once per profile; waits a moment for the mini-games so the ride
  // can be a fade.
  maybeIntro(player) {
    if (this._introDone || this.dlg || this.state.active) return;
    this._introAt ??= this.time;
    if (!this.minigames && this.time - this._introAt < 8) return;
    this._introDone = true;
    const main = this.quests.filter((q) => !q.side);
    if (!this.introKey || this.test('intro_seen') || main.some((q) => this.state.done.includes(q.id))) return;
    const first = main[0], giver = first && this.npc(first, first.giver);
    this.applyEffects({ flag: 'intro_seen' });
    this.openDialogue(this.introKey, {
      onDone: () => {
        if (!giver || Math.hypot(giver.x - player.pos.x, giver.z - player.pos.z) < INTRO_RIDE_R) return;
        const spot = { x: giver.x + 10, z: giver.z + 10 };
        if (this.minigames && this.minigames.jumpToStart) { this.lastPlayer = player.pos; this.jumpTo(spot, 'walk', giver); }
        else { const f = this.collision.findFree(spot.x, spot.z, 1.6); player.pos.x = f.x; player.pos.z = f.z; }
      },
    });
  }

  // ---------------- who stands where ----------------
  // One copy of each character is on screen: the instance of their latest open quest. When that
  // changes while the player is watching, the old copy does not vanish: it walks over to the
  // next scene if that is close (and the new copy takes over there), or walks off, and is
  // swapped once the player is far or after a while. Until then the new copy stays hidden.
  whoIsShown(px, pz) {
    const shown = new Set();
    this._showing ||= {};
    this._chars ||= [...new Set(Object.values(this.npcs).map((n) => n.id))];
    for (const id of this._chars) {
      const cur = this.current(id), prev = this._showing[id];
      if (!prev || prev === cur || !prev.av || !prev.av.group.visible) { this._showing[id] = cur; if (cur) shown.add(cur); continue; }
      const d = Math.hypot(px - prev.x, pz - prev.z);
      const toCur = cur ? Math.hypot(cur.x - prev.x, cur.z - prev.z) : Infinity;
      if (!prev.leaving) {
        if (d > LEAVE_R) { this._showing[id] = cur; if (cur) shown.add(cur); continue; }
        // `stay` characters (the band on the cliff lookout's benches) do not walk off when the
        // story moves on: a walk-off is a straight line away from the player, which on a cliff top
        // is over the edge and into the road. They stay until the player is out of range (or walks
        // up to the next copy), and then the crowd's own regulars take the benches.
        if (prev.def.stay && !(cur && Math.hypot(px - cur.x, pz - cur.z) < 25)) { shown.add(prev); continue; }
        prev.leaving = { at: this.time, join: toCur < 150 };
        let dst;
        if (prev.leaving.join) dst = { x: cur.x, z: cur.z };
        else { const k = 60 / Math.max(1, d); dst = { x: prev.x + (prev.x - px) * k, z: prev.z + (prev.z - pz) * k }; }
        prev.target = this.collision.findFree(dst.x, dst.z, 1.6);
        prev.path = null; prev.escortSpeed = 0; prev.sit = null; prev.sitting = false;
      }
      const arrived = !prev.target;
      // The new copy also takes over when the player walks up to its spot (they want to talk).
      const done = d > LEAVE_R || this.time - prev.leaving.at > 40 || (arrived && prev.leaving.join) || (cur && Math.hypot(px - cur.x, pz - cur.z) < 25);
      if (!done) { shown.add(prev); continue; }
      prev.leaving = null; prev.target = null;
      prev.x = prev.home.x; prev.z = prev.home.z; prev.y = this.groundY(prev.x, prev.z);
      this._showing[id] = cur;
      if (cur) shown.add(cur);
    }
    return shown;
  }

  // ---------------- story props ----------------
  npcAt(id) { const q = this.byId[this.props && this.props.ctx]; return q ? this.npc(q, id) : this.current(id); }

  // Prop actions plus two for people: { put: npc, at } (stand there now) and { walk: npc, to }
  // (walk there in view), so a narrated arrival is something the player sees.
  propActs(q, list) {
    if (!list || !this.props) return;
    this.props.ctx = q.id;
    const qi = this.qIndex[q.id];
    for (const a of [].concat(list)) {
      if (a.if && !this.test(a.if)) continue;
      if (a.put || a.walk) {
        const n = this.npc(q, a.put || a.walk);
        if (!n) continue;
        const at = this.resolve(a.at || a.to, qi);
        const p = this.collision.findFree(at.x, at.z, 1.6);
        if (a.put) { n.x = p.x; n.z = p.z; n.y = this.groundY(n.x, n.z); n.target = null; }
        else n.target = p;
        continue;
      }
      this.props.apply(a, q.id);
    }
    this.props.ctx = null;
  }

  // Scene props of open quests appear once (and are then left to the steps); a finished quest
  // swaps them for its `leave` props, which are re-placed on every load (they follow from the
  // save, so nothing extra is stored).
  refreshScene() {
    if (!this.props) return;
    for (const q of this.quests) {
      const done = this.state.done.includes(q.id);
      if (done) {
        const keep = new Set((q.leave || []).map((a) => `${q.id}:${a.id || a.show}`));
        for (const a of q.scene || []) { const id = `${q.id}:${a.id || a.show}`; if (!keep.has(id) && this.props.has(id)) this.props.apply({ remove: id }, q.id); }
        if (!q._left) { q._left = true; this.propActs(q, q.leave); }
        // props another quest left behind (the flag tables on the plaza) go when this one is done
        for (const id of q.clear || []) if (this.props.has(id)) this.props.apply({ remove: id }, q.id);
      } else if (this.unlocked(q) && !q._staged) {
        q._staged = true;
        this.propActs(q, q.scene);
      }
    }
  }

  // The item on top of the barter bag rides in the player's hand.
  showBag(q, a) {
    const KIND = { drum: 'bass_drum' };
    const top = a.inv && a.inv[a.inv.length - 1];
    this.props.apply({ remove: `${q.id}:bag` }, q.id);
    if (top) this.props.apply({ hold: KIND[top] || top, id: 'bag', by: 'player', how: 'hand' }, q.id);
  }

  // ---------------- story ledger ----------------
  // effects: { scale: +2, trust: { haredi: +1 }, flag: "gen_to=yeshiva" | ["a", "b=c"] }
  applyEffects(e, source = '') {
    if (!e) return;
    // Super Malul story bonds (src/engine/herostory.js): `rel` (bond changes) and `heroFlag` go there.
    if ((e.rel || e.heroFlag) && this.heroLedger) this.heroLedger.apply({ rel: e.rel, flag: e.heroFlag });
    if (typeof e.scale === 'number' && e.scale && !this.test('scale_seen')) {
      // First choice that moves the City Scale: reveal the meter and say what it is.
      this.applyEffects({ flag: 'scale_seen' });
      if (this.hud) setTimeout(() => this.hud.banner(this.t('ui.scale'), this.t('ui.scaleIntro')), 300);
    }
    if (this.ledger) {
      try { this.ledger.apply(e, source || (this.state.active ? `${this.state.active.id}/${this.state.active.step}` : '')); } catch (err) { console.warn('[quests] story.apply failed', err); }
      if (typeof e.scale === 'number' && e.scale && this.hud && this.hud.toastMsg) this.hud.toastMsg(this.t(e.scale > 0 ? 'ui.scaleUp' : 'ui.scaleDown'));
      this.refreshHud();
      return;
    }
    const st = this.story;
    if (typeof e.scale === 'number') {
      st.scale = Math.max(-20, Math.min(20, st.scale + e.scale));
      if (this.hud && this.hud.toastMsg && e.scale) this.hud.toastMsg(this.t(e.scale > 0 ? 'ui.scaleUp' : 'ui.scaleDown'));
    }
    for (const [k, v] of Object.entries(e.trust || {})) st.trust[k] = (st.trust[k] || 0) + v;
    for (const f of [].concat(e.flag || [], e.flags || [])) {
      if (String(f).startsWith('!')) { delete st.flags[String(f).slice(1)]; continue; }
      const [k, v] = String(f).split('=');
      st.flags[k] = v === undefined ? true : v;
    }
    this.refreshHud();
    if (this.hooks.onStory) { try { this.hooks.onStory(st, e); } catch (err) { console.warn('[quests] onStory failed', err); } }
    this.save();
  }

  // Conditions: "flag", "!flag", "flag=value", "scale>=5", "trust.haredi>0", or an array (all).
  test(c) {
    if (c == null || c === '') return true;
    if (Array.isArray(c)) return c.every((x) => this.test(x));
    const s = String(c).trim();
    if (s.startsWith('!')) return !this.test(s.slice(1));
    if (/^rel\.\w+/.test(s)) return this.heroLedger ? this.heroLedger.test(s) : false;
    const L = this.ledger;
    const m = /^(scale|trust\.\w+)\s*(>=|<=|>|<|==)\s*(-?\d+)$/.exec(s);
    if (m) {
      const sector = m[1].slice(6);
      const v = m[1] === 'scale' ? (L ? L.scale : this.story.scale) : (L ? L.trustOf(sector) : (this.story.trust[sector] || 0)), n = +m[3];
      return m[2] === '>=' ? v >= n : m[2] === '<=' ? v <= n : m[2] === '>' ? v > n : m[2] === '<' ? v < n : v === n;
    }
    if (s.startsWith('done:')) return this.state.done.includes(s.slice(5));
    const [k, v] = s.split('=');
    const have = L ? L.flag(k) : this.story.flags[k];
    return v === undefined ? !!have : String(have) === v;
  }

  // A dialogue key, or { "<condition>": key, ..., "default": key } picked in order.
  pick(spec) {
    if (!spec || typeof spec === 'string') return spec;
    for (const [c, key] of Object.entries(spec)) if (c !== 'default' && this.test(c)) return key;
    return spec.default;
  }

  qt(q, key, vars) { return this.t(`${q.id}.${key}`, vars); }
  name(id) { return id === 'player' ? this.t('ui.player') : id === 'narrator' ? '' : this.t(`npc.${id}`); }

  // ---------------- dialogue ----------------
  // key is the strings path of the lines ('q1_speaker.d.offer'); it names voice lines for the hook.
  openDialogue(key, { offer = false, choices = null, onDone, onCancel, onChoice, lines: literal = null, vars = null } = {}) {
    let lines = literal || this.t(key);
    // {score}-style values in lines (a best surf score) are filled in here.
    if (vars && Array.isArray(lines)) lines = lines.map(([who, text]) => [who, String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m))]);
    if (!Array.isArray(lines) || !lines.length) {
      console.warn('[quests] dialogue missing in strings:', key);
      if (choices && onChoice) { this.dlg = { key, lines: [['narrator', '...']], i: 0, choices, onChoice }; this.showLine(); return; }
      if (onDone) onDone();
      return;
    }
    this.dlg = { key, lines, i: 0, offer, choices, onDone, onCancel, onChoice };
    this.showLine();
  }

  showLine() {
    const d = this.dlg;
    const [who, text] = d.lines[d.i];
    const last = d.i === d.lines.length - 1;
    const options = last && d.choices ? d.choices : null;
    const hint = options ? this.t('ui.choose', { n: options.length })
      : last && d.offer ? `${this.t('ui.accept')}   ·   ${this.t('ui.later')}` : this.t('ui.next');
    if (this.hud) this.hud.showDialogue({ speaker: this.name(who), narrator: who === 'narrator', player: who === 'player', text, hint, options });
    const npc = this.current(who);
    if (npc) npc.talkT = 1.2;
    if (this.hooks.onDialogueLine) {
      try { this.hooks.onDialogueLine(d.key.split('.')[0], `${d.key}.${d.i}`, who); } catch (e) { console.warn('[quests] onDialogueLine failed', e); }
    }
  }

  advanceDialogue(cancel) {
    const d = this.dlg;
    if (!d) return;
    const last = d.i === d.lines.length - 1;
    if (cancel && d.offer) { this.dlg = null; this.hud && this.hud.hideDialogue(); d.onCancel && d.onCancel(); return; }
    if (last && d.choices) return; // a choice must be picked
    if (cancel) { d.i = d.lines.length - 1; if (d.choices) { this.showLine(); return; } }
    else if (!last) { d.i++; this.showLine(); return; }
    this.dlg = null;
    this.hud && this.hud.hideDialogue();
    d.onDone && d.onDone();
  }

  pickOption(i) {
    const d = this.dlg;
    if (!d || !d.choices || d.i !== d.lines.length - 1 || i < 0 || i >= d.choices.length) return;
    this.dlg = null;
    this.hud && this.hud.hideDialogue();
    d.onChoice(i);
  }

  // ---------------- quest flow ----------------
  accept(q) {
    this.state.active = { id: q.id, step: -1 };
    this.hud && this.hud.banner(this.t('ui.newQuest'), this.qt(q, 'title'));
    this.nextStep();
  }

  nextStep() {
    const a = this.state.active;
    const q = this.byId[a.id];
    this.clearStepObjs();
    this.dropCarry();
    this.endMinigame();
    // The finished step's props settle (drums carried off, phone pocketed), whatever kind of step
    // it was; then autosave.
    if (a.step >= 0) this.propActs(q, q.steps[a.step] && q.steps[a.step].propsDone);
    if (a.step >= 0 && this.hooks.onSave) { try { this.hooks.onSave(); } catch (_) { /* optional */ } } // a step finished: autosave
    a.step++;
    // Branches: a step whose condition fails is skipped (helpers who only come with a flag).
    while (a.step < q.steps.length && !this.test(q.steps[a.step].if)) a.step++;
    if (a.step >= q.steps.length) { this.complete(q); return; }
    const s = q.steps[a.step];
    const qi = this.qIndex[q.id];
    a.got = 0; a.phase = null; a.retry = false; a.deadline = 0; a.fired = {}; a.bonus = 0; a.tries = 0;
    this.propActs(q, s.props);
    if (s.type === 'collect') {
      const c = this.resolve(s.at, qi);
      const rnd = seeded(q.id + a.step);
      const placed = [];
      for (let i = 0; i < s.count; i++) {
        // Two candidates can snap to the same street point; after a few tries, fall back to the
        // unsnapped spot so pickups never merge into one.
        let p = null;
        for (let k = 0; k < 10 && !p; k++) {
          const ang = (i / s.count) * Math.PI * 2 + rnd() * (1.2 + k), r = (s.spread || 30) * (0.35 + rnd() * 0.65);
          const rx = c.x + Math.cos(ang) * r, rz = c.z + Math.sin(ang) * r;
          const cand = k < 5 ? this.streetSpot(rx, rz) : this.collision.findFree(rx, rz, 2.2);
          if (k === 9 || placed.every((o) => Math.hypot(o.x - cand.x, o.z - cand.z) > PICK_R * 2)) p = cand;
        }
        placed.push(p);
        this.addItem(s.item, p, true);
      }
    } else if (s.type === 'find') {
      // The zone is what the player sees; the item sits somewhere inside it on a street.
      const c = this.resolve(s.at, qi);
      const rnd = seeded(q.id + a.step + 'find');
      const ang = rnd() * Math.PI * 2, r = (s.radius || 70) * (0.25 + rnd() * 0.45);
      const p = this.streetSpot(c.x + Math.cos(ang) * r, c.z + Math.sin(ang) * r);
      a.zone = { x: c.x, z: c.z, radius: s.radius || 70 };
      const o = this.addItem(s.item, p, false);
      o.hidden = true;
      o.mesh.visible = o.beam.visible = false;
    } else if (s.type === 'reach') {
      this.addBeam(this.resolve(s.at, qi), 0x2ec4b6, s.prop);
    } else if (s.type === 'timed') {
      a.phase = 'pickup';
      a.pickup = this.resolve(s.pickup, qi);
      a.drop = this.resolve(s.at, qi);
      this.addBeam(a.pickup, 0xffcb3d);
      // Fair clock: straight-line distance at scooter speed, times a factor for real streets,
      // plus time to get going. The data can only make it more generous, never stricter.
      const d = Math.hypot(a.drop.x - a.pickup.x, a.drop.z - a.pickup.z);
      a.limit = Math.ceil((d / SCOOTER_SPEED) * Math.max(1.8, s.timeFactor || 2.4) + 15);
      this.jumpTo(a.pickup, (s.modes || ['scooter'])[0], a.drop);
    } else if (s.type === 'drive') {
      // Passenger ride: meet the NPC, they get in (the player must be in an allowed vehicle),
      // then reach the drop-off before the clock.
      a.phase = 'meet';
      a.drop = this.resolve(s.at, qi);
      const n = this.npc(q, s.npc);
      const d = n ? Math.hypot(a.drop.x - n.x, a.drop.z - n.z) : 600;
      a.limit = s.limit || Math.ceil((d / SCOOTER_SPEED) * Math.max(1.8, s.timeFactor || 2.4) + 20);
      if (n) this.jumpTo({ x: n.x + 5, z: n.z + 5 }, (s.modes || ['car'])[0], a.drop);
    } else if (s.type === 'track') {
      this.startTrack(q, s, a, qi);
    } else if (s.type === 'barter') {
      a.inv = [].concat(s.start || []);
      a.traded = [];
      this.showBag(q, a);
    } else if (s.type === 'deduce') {
      a.phase = 'guess'; a.crossed = []; a.fails = 0; a.hint = 0; a.idle = 0; a.msg = ''; a.marks = []; a.howShown = false;
      this.deduceOverlay(q, s, a);
    } else if (s.type === 'minigame') {
      a.phase = 'go';
      a.spot = s.at ? this.resolve(s.at, qi) : null;
      if (a.spot) this.addBeam(a.spot, 0xb36bd6);
    } else if (s.type === 'escort') {
      a.phase = 'meet';
      a.drop = this.resolve(s.at, qi);
      this.addBeam(a.drop, 0x2ec4b6);
    } else if (s.type === 'talk' && s.gather) {
      this.gatherTo(q, s.npc, s.gather, true, s.seat);
    }
    this.refreshHud();
  }

  addItem(kind, p, withBeam) {
    const m = itemMesh(kind);
    const y = this.groundY(p.x, p.z);
    m.position.set(p.x, y + 1.6, p.z);
    const b = beam(0xffcb3d);
    b.scale.set(0.45, withBeam ? 0.5 : 0.18, 0.45);
    b.position.set(p.x, y, p.z);
    this.root.add(m, b);
    const o = { kind: 'item', mesh: m, beam: b, x: p.x, z: p.z, y };
    this.stepObjs.push(o);
    return o;
  }

  addBeam(p, color, prop) {
    const y = this.groundY(p.x, p.z);
    const b = beam(color);
    b.position.set(p.x, y, p.z);
    this.root.add(b);
    this.stepObjs.push({ kind: 'beam', mesh: b, x: p.x, z: p.z });
    if (prop === 'sticker') {
      const st = stickerBench({ label: this.t('ui.sticker'), dir: dir() });
      st.position.set(p.x, y, p.z);
      this.root.add(st);
      this.stepObjs.push({ kind: 'prop', mesh: st, x: p.x, z: p.z });
    }
  }

  // Bring characters next to a host. Far ones (another district) appear there at once instead
  // of a long walk across the city; near ones walk over.
  // `seatId` names a chair_rows prop of the quest (or of another one, `quest:id`): the gathered
  // characters take its chairs, front row and centre first, and the ones left over stand in a
  // line just behind the last row.
  gatherTo(q, hostId, ids, walk, seatId = null) {
    const host = this.npc(q, hostId);
    if (!host) return;
    const placed = [];
    const rowsId = seatId && this.props ? (seatId.includes(':') ? seatId : `${q.id}:${seatId}`) : null;
    const seats = rowsId ? this.props.seatsOf(rowsId).filter((c) => this.collision.isFree(c.x, c.z, 0.7)) : [];
    const sitters = rowsId ? ids.filter((id) => { const n = this.npc(q, id); return n && n !== host; }).length : 0;
    const behind = rowsId ? this.props.behindRows(rowsId, Math.max(0, sitters - seats.length)) : [];
    let nextSeat = 0, nextBehind = 0;
    ids.forEach((id, i) => {
      const n = this.npc(q, id);
      if (!n || n === host) return;
      n.sit = null; n.sitting = false;
      let seat = null, p = null;
      if (rowsId && nextSeat < seats.length) { seat = seats[nextSeat++]; p = { x: seat.x, z: seat.z }; }
      else if (rowsId && behind[nextBehind]) { const b = behind[nextBehind++]; p = this.collision.findFree(b.x, b.z, 1.2); }
      else {
        let ang = (i + 1) * (Math.PI * 2 / Math.max(6, ids.length + 1));
        // A host on a stage keeps the huddle on it: the stage is a wall for findFree, so spots
        // over its top are taken as they are.
        const onStage = !!this.props && this.props.surfaceAt(host.x, host.z) != null;
        const r = onStage ? 3 : ids.length > 4 ? 7 : 4.5;
        // findFree pushes a spot that lands in a bench or a rail to the nearest open ground, which
        // can be the very spot a neighbour was just given: turn the ring a little until it is clear.
        for (let k = 0; k < 6; k++, ang += 0.7) {
          const cx = host.x + Math.cos(ang) * r, cz = host.z + Math.sin(ang) * r;
          p = onStage && this.props.surfaceAt(cx, cz) != null ? { x: cx, z: cz } : this.collision.findFree(cx, cz, 1.6);
          const clear = (o) => Math.hypot(o.x - p.x, o.z - p.z) > 2.2;
          if (placed.every(clear) && Object.values(this.npcs).every((o) => o === n || o === host || o.quest !== n.quest || clear(o.target || o))) break;
        }
      }
      placed.push(p);
      if (seat) n.sit = seat;
      if (walk && Math.hypot(n.x - p.x, n.z - p.z) < GATHER_TELEPORT_R) { n.target = p; n.gatherAt = this.time; }
      else { n.x = p.x; n.z = p.z; n.target = null; n.y = this.standY(n.x, n.z); if (seat) this.sitDown(n); }
    });
  }

  // On the chair it walked to (or was put on): faces the way the chair does; the avatar sits
  // itself down in the update loop once it exists.
  sitDown(n) {
    const c = n.sit;
    if (!c) return;
    // The pelvis sits a little behind the middle of the seat, against the chair back.
    n.x = c.x - Math.sin(c.yaw) * 0.2; n.z = c.z - Math.cos(c.yaw) * 0.2; n.yaw = c.yaw; n.y = this.standY(n.x, n.z);
    n.sitting = true;
  }

  stepDone(q, s, key = s.dialogue) {
    this.applyEffects(s.effects);
    const k = this.pick(key);
    if (!k) { this.nextStep(); return; }
    this.openDialogue(`${q.id}.${k}`, { onDone: () => this.nextStep() });
  }

  complete(q) {
    this.state.active = null;
    if (!this.state.done.includes(q.id)) this.state.done.push(q.id);
    this.applyEffects(q.effects);
    this.save();
    this.settleDone(q, true);
    this.props.apply({ remove: `${q.id}:bag` }, q.id);
    this.refreshScene();
    const after = q.clue ? `${this.t('ui.clue')}: ${this.qt(q, 'clue')}` : q.after ? this.qt(q, this.pick(q.after)) : '';
    if (q.finale) this.hud && this.hud.banner(this.t('ui.theEnd'), this.qt(q, 'title'), this.t('ui.thanks'));
    else this.hud && this.hud.banner(this.t('ui.questDone'), this.qt(q, 'title'), after);
    if (q.finale && this.quests.some((x) => x.side)) setTimeout(() => this.hud && this.hud.toastMsg(this.t('ui.sideOpen')), 6000);
    this.refreshHud();
  }

  // Everyone in a finished quest stands together near the giver (and anyone its steps gathered).
  settleDone(q, emote = false) {
    if (!q) return;
    // `dismantle`: the show is over, the stage and chairs are gone (see `scene`/`leave`), and everyone
    // it gathered walks back to where they belong instead of standing around the empty plaza.
    if (q.dismantle) {
      const ids = new Set();
      for (const st of q.steps) for (const id of st.gather || []) ids.add(id);
      for (const id of ids) {
        const n = this.npc(q, id);
        if (!n || (n.quest === q.id && q.npcs && q.npcs[id])) continue;
        n.sit = null; n.sitting = false; n.path = null;
        if (emote) { n.target = this.collision.findFree(n.home.x, n.home.z, 1.6); n.gatherAt = this.time; }
        else { n.x = n.home.x; n.z = n.home.z; n.y = this.groundY(n.x, n.z); n.target = null; }
      }
      return;
    }
    if (!q) return;
    const own = Object.keys(q.npcs || {}).filter((id) => id !== q.giver);
    // `onStage` quests (the finale's band) keep their own characters where the story put them.
    if (!q.onStage) this.gatherTo(q, q.giver, own, emote);
    for (const s of q.steps) if (s.gather) this.gatherTo(q, s.npc, s.gather, emote, s.seat);
    if (emote) {
      for (const id of Object.keys(q.npcs || {})) { const n = this.npc(q, id); try { n?.av?.emote && n.av.emote('wave'); } catch (_) { /* optional */ } }
    }
  }

  clearStepObjs() {
    if (this.hud && this.hud.setClues) this.hud.setClues(null);
    for (const o of this.stepObjs) { this.root.remove(o.mesh); if (o.beam) this.root.remove(o.beam); }
    this.stepObjs = [];
  }

  // On foot the delivery is held in front in both hands; riding, the hands are on the bars, so it
  // floats over the head instead.
  holdCarry(player) {
    const av = this.playerAv, c = this.carry;
    const hands = player.mode === 'walk' && av && av.setCarry && av.anchors && av.anchors.carry;
    if (hands && !c.userData.onAvatar) {
      av.setCarry('two');
      av.anchors.carry.add(c);
      c.position.set(0, -0.15, 0); c.rotation.set(0, 0, 0); c.scale.setScalar(0.55);
      c.userData.onAvatar = true;
    } else if (!hands && c.userData.onAvatar) {
      if (av && av.setCarry) av.setCarry(null);
      this.root.add(c);
      c.scale.setScalar(1);
      c.userData.onAvatar = false;
    }
  }

  dropCarry() {
    if (!this.carry) return;
    this.carry.removeFromParent();
    if (this.carry.userData.onAvatar && this.playerAv && this.playerAv.setCarry) { try { this.playerAv.setCarry(null); } catch (_) { /* optional */ } }
    this.carry = null;
  }

  // What the player should do right now, with a world position for the minimap arrow.
  objective() {
    const a = this.state.active;
    if (!a) {
      const av = this.available()[0];
      if (!av) {
        const finished = this.quests.length && this.quests.every((q) => this.state.done.includes(q.id));
        if (this.heroMode && !finished) return { title: '', text: this.t(this.quests.filter((q) => q.mode === 'hero').every((q) => this.state.done.includes(q.id)) ? 'ui.heroDone' : 'ui.heroWait'), target: null };
        return { title: '', text: this.t(finished ? 'ui.freePlay' : 'ui.allDone'), target: null };
      }
      const g = this.npc(av, av.giver);
      return { title: this.qt(av, 'title'), text: this.t('ui.findGiver', { name: this.name(av.giver) }), progress: this.t('ui.howTalk', { name: this.name(av.giver) }), target: g ? { x: g.x, z: g.z } : null, giver: true, where: g ? this.whereIs(g) : '' };
    }
    const q = this.byId[a.id], s = q.steps[a.step];
    let target = null, progress = '', key = s.obj;
    const at = (n) => (n ? { x: n.x, z: n.z } : null);
    // "How" next to "where": the key to press once there.
    const howTalk = (id) => this.t('ui.howTalk', { name: this.name(id) });
    if (s.type === 'talk') { target = at(this.npc(q, s.npc)); progress = howTalk(s.npc); }
    else if (s.type === 'choice') { target = at(this.npc(q, s.npc)); progress = howTalk(s.npc); if (a.retry && s.objRetry) key = s.objRetry; }
    else if (s.type === 'collect') {
      const items = this.stepObjs.filter((o) => o.kind === 'item' && !o.taken);
      progress = this.t('ui.collected', { n: a.got, total: s.count });
      target = this._nearestItem || at(items[0]);
    } else if (s.type === 'reach') target = at(this.stepObjs.find((o) => o.kind === 'beam'));
    else if (s.type === 'find') { target = { ...a.zone, zone: true }; progress = this.t('ui.useMap'); }
    else if (s.type === 'timed') {
      if (a.phase === 'run') {
        key = s.objRun || s.obj;
        target = at(a.drop);
        const left = Math.max(0, Math.ceil(a.deadline - this.time));
        progress = this.t('ui.timer', { t: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
      } else { target = at(a.pickup); progress = this.t('ui.wheels'); }
    } else if (s.type === 'escort') {
      const n = this.npc(q, s.npc);
      if (a.phase === 'walk') { key = a.waiting ? (s.objWait || s.obj) : (s.objWalk || s.obj); target = at(n); if (!a.waiting) target = at(a.drop); }
      else target = at(n);    } else if (s.type === 'drive') {
      const n = this.npc(q, s.npc);
      if (a.phase === 'run') {
        key = s.objRun || s.obj;
        target = at(a.drop);
        const left = Math.max(0, Math.ceil(a.deadline - this.time));
        progress = this.t('ui.timer', { t: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
      } else { target = at(n); progress = this.t('ui.byCar'); }
    } else if (s.type === 'track') {
      if (a.phase === 'follow') { key = s.objFollow || s.obj; target = at(a.home); }
      else { target = { ...a.zone, zone: true }; progress = this.t('ui.walkSlow'); }
    } else if (s.type === 'barter') {
      const left = (s.chain || []).filter((c) => !a.traded.includes(c.npc)).map((c) => this.npc(q, c.npc)).filter(Boolean);
      let best = null, bd = Infinity;
      for (const n of left) { const d = Math.hypot(n.x - this.lastPlayer.x, n.z - this.lastPlayer.z); if (d < bd) { bd = d; best = n; } }
      target = at(best);
      progress = `${this.t('ui.bag', { items: a.inv.map((k) => this.t(`items.${k}`)).join(', ') || '-' })} · ${this.t('ui.howBarter')}`;
    } else if (s.type === 'minigame') {
      target = a.spot ? at(a.spot) : s.npc ? at(this.npc(q, s.npc)) : null;
      if (a.phase === 'go') progress = s.npc ? this.t('ui.howStart', { name: this.name(s.npc) }) : this.t('ui.howBeam');
    } else if (s.type === 'deduce') {
      if (a.phase === 'go') { key = s.objGo || s.obj; target = at(a.spot); }
      else progress = this.t('ui.markMap');
    }
    return { title: this.qt(q, 'title'), text: this.qt(q, key), progress, target, where: this.whereIs(target) };
  }

  // Display name of the landmark (within 120 u) or neighbourhood (within 600 u) nearest to a
  // point, cached per rounded spot: the objective is rebuilt every frame.
  whereIs(p) {
    if (!p) return '';
    const key = `${Math.round(p.x / 20)},${Math.round(p.z / 20)}`;
    this._where ||= new Map();
    if (this._where.has(key)) return this._where.get(key);
    let best = '', bd = 120;
    for (const poi of Object.values(this.poi)) {
      if (/dropoff|_plaza$|_sub$/.test(poi.id)) continue;
      const d = Math.hypot(poi.x - p.x, poi.z - p.z);
      if (d < bd) { bd = d; best = poiName(poi); }
    }
    if (!best) {
      bd = 600;
      for (const pl of new Set(Object.values(this.place))) {
        const d = Math.hypot(pl.x - p.x, pl.z - p.z);
        if (d < bd) { bd = d; best = placeName(pl); }
      }
    }
    if (this._where.size > 500) this._where.clear();
    this._where.set(key, best);
    return best;
  }

  refreshHud() {
    if (!this.hud) return;
    // The V2 story replaces the Hum meter with the City Scale.
    // V2: the City Scale shows from the first choice that moves it (with a one-line
    // explanation then); an empty meter from the first second only confused players.
    if (this.hud.setScale && this.quests.some((q) => !q.side && !q.hum)) {
      const seen = this.test('scale_seen');
      if (this.hud.showMeter) this.hud.showMeter(seen);
      if (seen) this.hud.setScale(this.ledger ? this.ledger.scale : this.story.scale, this.t('ui.scale'), this.t('ui.scaleLow'), this.t('ui.scaleHigh'));
    } else if (this.hud.setHum) { if (this.hud.showMeter) this.hud.showMeter(true); this.hud.setHum(this.hum, this.t('ui.hum')); }
    if (this.hud.setObjective) this.hud.setObjective(this.objective());
  }

  // ---------------- per frame ----------------
  update(dt, player, input) {
    this.player = player;
    this.time += dt;
    this.playerAv = player.avatar || null;
    if (this.props) this.props.update(dt, player);
    const px = player.pos.x, pz = player.pos.z;
    this.lastPlayer = player.pos;

    let consumed = false;
    if (this.dlg) {
      consumed = true;
      const d = this.dlg;
      const choosing = d.choices && d.i === d.lines.length - 1;
      const next = input.wasPressed('KeyF', 'Space', 'Enter', 'NumpadEnter') || this.clicked;
      const cancel = input.wasPressed('Escape');
      this.clicked = false;
      if (choosing) {
        let pick = this.optionClicked;
        for (let i = 0; i < d.choices.length; i++) if (input.wasPressed(`Digit${i + 1}`, `Numpad${i + 1}`)) pick = i;
        if (pick >= 0) this.pickOption(pick);
      } else if (d.offer && d.i === d.lines.length - 1 && cancel) this.advanceDialogue(true);
      else if (next) this.advanceDialogue(false);
    } else this.clicked = false;
    this.optionClicked = -1;

    const a = this.state.active;
    const q = a && this.byId[a.id];
    const step = q && q.steps[a.step];

    // NPCs: walk to targets, face the player when close, animate only when near.
    let nearest = null, nearestD = Infinity;
    const avail = this.available();
    this._prefer = new Map();
    const aq = this.state.active && this.byId[this.state.active.id];
    for (const x of aq ? [aq] : avail.slice(0, 1)) for (const id of Object.keys(x.npcs || {})) { const n = this.npcs[`${x.id}:${id}`]; if (n && !n.activity) this._prefer.set(id, n); }
    const givers = new Set(avail.map((x) => this.npc(x, x.giver)).filter(Boolean));
    const stepNpc = step && (['talk', 'choice', 'escort'].includes(step.type) || (step.type === 'drive' && a.phase === 'meet') || (step.type === 'minigame' && a.phase === 'go')) && step.npc ? this.npc(q, step.npc) : null;
    // Barter: every neighbour still in the chain can be asked.
    const barter = step && step.type === 'barter' ? new Set((step.chain || []).filter((c) => !a.traded.includes(c.npc)).map((c) => this.npc(q, c.npc)).filter(Boolean)) : null;
    const shown = this.whoIsShown(px, pz);
    // A gathering walker is only moved while it is shown, and walks in a straight line: one that
    // is hidden (far from the player) or cannot get there would keep the host untalkable for
    // good, so after a while it simply appears at its spot.
    for (const n of Object.values(this.npcs)) {
      if (n.target && n.gatherAt != null && this.time - n.gatherAt > GATHER_TIMEOUT) {
        n.x = n.target.x; n.z = n.target.z; n.y = this.standY(n.x, n.z); n.target = null; n.gatherAt = null;
        if (n.sit) this.sitDown(n);
      } else if (!n.target && n.gatherAt != null) n.gatherAt = null;
    }
    for (const n of Object.values(this.npcs)) {
      if (!shown.has(n)) { if (n.av) n.av.group.visible = false; continue; }
      if (!this.ensureAv(n)) continue;
      if (n.seated) {
        // riding shotgun: the player's car carries and places the avatar (Player.seatPassenger)
        if (n.marker) n.marker.visible = false;
        try { n.av.update(dt, 0); } catch (_) { /* optional */ }
        continue;
      }
      const dx = px - n.x, dz = pz - n.z, d = Math.hypot(dx, dz);
      n.av.group.visible = d < NPC_VISIBLE_R && !n.riding;
      let speed = 0;
      if (n.escortSpeed && n.path) speed = this.walkPath(n, dt, n.walking ? n.escortSpeed : 0);
      else if (n.target) {
        const tx = n.target.x - n.x, tz = n.target.z - n.z, tl = Math.hypot(tx, tz);
        if (tl < 0.4) {
          n.target = null;
          if (n.sit) this.sitDown(n);
          else { try { n.av.setMode('idle'); } catch (_) { /* optional */ } }
        }
        else {
          if (n.av.mode !== 'walk') { try { n.av.setMode('walk'); } catch (_) { /* optional */ } }
          speed = tl > 30 ? 14 : 7;
          const k = Math.min(1, (speed * dt) / tl);
          n.x += tx * k; n.z += tz * k;
          n.yaw = Math.atan2(tx, tz);
        }
      } else if (d < 18 && !n.sitting) n.yaw += Math.atan2(Math.sin(Math.atan2(dx, dz) - n.yaw), Math.cos(Math.atan2(dx, dz) - n.yaw)) * Math.min(1, dt * 5);
      // (a stage prop can appear under a standing character, so the height is re-read twice a second)
      if (speed > 0 || n._yDirty !== false || this.time - (n._yAt || 0) > 0.5) { n.y = this.standY(n.x, n.z, n.y + 1.5); n._yDirty = speed > 0; n._yAt = this.time; }
      if (n.sitting && !n.target) {
        if (n.av.mode !== 'sit') { try { n.av.setSeat && n.av.setSeat(n.sit ? n.sit.h : 1.2); n.av.setMode('sit'); } catch (_) { /* optional */ } }
      }
      n.av.group.position.set(n.x, n.y, n.z);
      n.av.group.rotation.y = n.yaw;
      if (d < NPC_ACTIVE_R) { try { n.av.update(dt, speed); } catch (e) { if (!this._warnedAv) { console.warn('[quests] avatar.update failed', e); this._warnedAv = true; } } }

      // marker: "!" on an available giver, "?" on whoever the current step points at
      let kind = null;
      if (givers.has(n)) kind = '!';
      else if (n.activity) kind = n.activity.icon || '?';
      else if ((n === stepNpc || barter?.has(n)) && !n.target && !(step.type === 'escort' && a.phase === 'walk')) kind = '?';
      if (kind !== n.markerKind) {
        n.markerKind = kind;
        if (kind) {
          const fresh = labelSprite(kind, kind === '!' ? '#ffcb3d' : n.activity ? '#fff8ea' : '#7fe0d6', '#23324a');
          n.marker.material.map.dispose(); n.marker.material.map = fresh.material.map; n.marker.material.needsUpdate = true;
        }
      }
      // Hidden while talking or in a minigame: the marker sits right in front of the camera then.
      n.marker.visible = !!kind && !this.dlg && !this.mg;
      if (n.marker.visible) n.marker.position.y = (n.av.height || 5.2) + 2.2 + Math.sin(this.time * 3) * 0.3;

      const talkable = (n.activity && !this.mg) || (((n === stepNpc && (step.type === 'talk' || step.type === 'choice' || step.type === 'minigame')) || barter?.has(n)) && !n.target && !this.gathering(q, step));
      // A step's character can be talked to from the vehicle that just brought the player, from a bit
      // further out: the car stops on the road and the character stands on the pavement.
      const reach = n === stepNpc && player.mode !== 'walk' ? TALK_R_VEHICLE : TALK_R;
      if ((givers.has(n) || talkable) && d < reach && d < nearestD) { nearest = n; nearestD = d; }
    }

    this.maybeIntro(player);
    // Hangouts: the crowd's own regulars (the band at the lookout) can be talked to as they are.
    const hang = !this.dlg && !nearest && !this.mg ? this.nearestHangout(px, pz) : null;

    // Unfinished pairs bicker every few seconds when the player is around.
    this.ambientT -= dt;
    if (this.ambientT <= 0) {
      this.ambientT = 4 + Math.random() * 3;
      for (const n of shown) {
        if (n.target || n.path || Math.hypot(px - n.x, pz - n.z) > 60) continue;
        const done = this.state.done.includes(n.quest);
        if (Math.random() < (done ? 0.25 : 0.4)) { try { n.av?.emote && n.av.emote(done ? 'wave' : 'argue'); } catch (_) { /* optional */ } }
      }
    }

    // The crowd's wandering regulars (the band) step aside while a quest has its own copy of
    // that friend out, so the city never shows two Maluls.
    const crowd = this.world.crowd;
    // The band moves to the cliff lookout only after Adir has been driven there (m13b_cliff, the
    // step after the drive), not before.
    if (crowd && typeof crowd.setLookoutOpen === 'function') {
      const act = this.state.active;
      const open = this.state.done.includes('m13b_cliff') || !!(act && act.id === 'm13b_cliff' && act.step > 2);
      if (open !== crowd.lookoutOpen) crowd.setLookoutOpen(open);
    }
    if (crowd && typeof crowd.holdNamed === 'function') {
      this._held ||= {};
      for (const id of Object.keys(crowd.named || {})) {
        // The copy on screen may be one walking off; the crowd gets its friend back only once
        // that copy is out of sight.
        const n = (this._showing && this._showing[id]) || this.current(id), hold = !!(n && n.av && n.av.group.visible);
        if (hold !== !!this._held[id]) { this._held[id] = hold; try { crowd.holdNamed(id, hold); } catch (_) { /* optional */ } }
      }
    }

    this._nearestItem = null;
    const guessing = step && step.type === 'deduce' && a.phase === 'guess';
    // While the big map is open it owns H (its overlay key), so a press is not counted twice.
    const mapOpen = !!(this.world.bigmap && this.world.bigmap.isOpen);
    if (guessing && !this.dlg && !mapOpen && input.wasPressed('KeyH')) this.deduceHint(q, step, a);
    if (!guessing && this._dedOv) { this._dedOv = false; if (this.world.bigmap && this.world.bigmap.setOverlay) this.world.bigmap.setOverlay(null); }
    if (step && !this.dlg) this.tickStep(q, step, a, dt, player);
    if (this.mg && this.mg.update && !this.dlg) { try { this.mg.update(dt, player, input); } catch (e) { console.warn('[quests] minigame update failed', e); this.mg = null; } }

    // `auto` talk steps start by themselves once the player is close: the scene does not depend on
    // the character being shown, the prompt being in reach or F reaching the game (m19 at Teder).
    if (step && step.auto && (step.type === 'talk' || step.type === 'choice') && !this.dlg && !this.mg && !(this.minigames && this.minigames.active) && !consumed && !this.gathering(q, step)) {
      const sn = this.npc(q, step.npc);
      if (sn && Math.hypot(px - sn.x, pz - sn.z) < TALK_R_VEHICLE * 0.8) { this.hud && this.hud.setPrompt(null); if (step.type === 'choice') this.openChoice(q, step, a); else this.stepDone(q, step); return; }
    }

    // Talk prompt + interaction.
    // A running mini-game owns the keys (F included): no talk prompt under it.
    if (!this.dlg && nearest && !consumed && !this.mg && !(this.minigames && this.minigames.active)) {
      this.hud && this.hud.setPrompt(this.t('ui.talk', { name: this.name(nearest.id) }));
      if (input.wasPressed('KeyF')) {
        this.hud && this.hud.setPrompt(null);
        const qq = avail.find((x) => this.npc(x, x.giver) === nearest);
        if (nearest.activity) this.openActivity(nearest.activity);
        else if (qq) this.openDialogue(`${qq.id}.${qq.offer}`, { offer: true, onDone: () => this.accept(qq) });
        else if (step.type === 'choice') this.openChoice(q, step, a);
        else if (step.type === 'barter') this.openBarter(q, step, a, nearest);
        else if (step.type === 'minigame') this.runMinigame(q, step, a);
        else this.stepDone(q, step);
      }
    } else if (!this.dlg && hang && !consumed) {
      this.hud && this.hud.setPrompt(this.t('ui.talk', { name: this.name(hang.id) }));
      if (input.wasPressed('KeyF')) { this.hud && this.hud.setPrompt(null); this.openHangout(hang.act, hang.id); }
    } else if (this.hud) this.hud.setPrompt(null);

    // Targets move (walking NPCs, nearest item, timers), so the tracker is refreshed every frame;
    // the HUD only rewrites its DOM when the text changes.
    const obj = this.objective();
    if (this.hud && this.hud.setObjective) this.hud.setObjective(obj);
    this.guide(dt, player, obj);
  }

  tickStep(q, step, a, dt, player) {
    const px = player.pos.x, pz = player.pos.z;
    if (step.type === 'collect' || step.type === 'find') {
      let best = Infinity;
      for (const o of this.stepObjs) {
        if (o.kind !== 'item' || o.taken) continue;
        const d = Math.hypot(px - o.x, pz - o.z);
        if (o.hidden) {
          const show = d < REVEAL_R;
          o.mesh.visible = o.beam.visible = show;
          if (!show) continue;
        }
        o.mesh.rotation.y += dt * 2.2;
        o.mesh.position.y = o.y + 1.6 + Math.sin(this.time * 3 + o.x) * 0.35;
        if (d < best) { best = d; this._nearestItem = { x: o.x, z: o.z }; }
        if (d < PICK_R) {
          o.taken = true;
          this.root.remove(o.mesh, o.beam);
          a.got++;
          const item = this.t('items.' + step.item);
          if (this.hud) this.hud.toastMsg(step.type === 'find' ? this.t('ui.found', { item }) : this.t('ui.pickup', { item, n: a.got, total: step.count }));
          if (step.type === 'find' || a.got >= step.count) { this.stepDone(q, step); break; }
        }
      }
    } else if (step.type === 'reach') {
      const b = this.stepObjs.find((o) => o.kind === 'beam');
      if (b) {
        b.mesh.userData.ring.scale.setScalar(1 + Math.sin(this.time * 4) * 0.12);
        if (Math.hypot(px - b.x, pz - b.z) < (step.radius || 8)) { this.root.remove(b.mesh); b.kind = 'gone'; this.stepDone(q, step); }
      }
    } else if (step.type === 'timed') this.tickTimed(q, step, a, player);
    else if (step.type === 'escort') this.tickEscort(q, step, a, player);
    else if (step.type === 'drive') this.tickDrive(q, step, a, player);
    else if (step.type === 'track') this.tickTrack(q, step, a, player, dt);
    else if (step.type === 'minigame') this.tickMinigame(q, step, a, player, dt);
    else if (step.type === 'deduce') {
      if (a.phase === 'guess') {
        // How to play, once, with the keys; then a new hint every 45 s without a guess.
        if (!a.howShown) { a.howShown = true; this.openDialogue('ui.deduceHow', {}); return; }
        a.idle = (a.idle || 0) + dt;
        if (a.idle > 45 && (a.hint || 0) < (step.hints || []).length) this.deduceHint(q, step, a);
      }
      this.deduceClues(q, step, a);
      const ans = a.spot || this.resolve(step.answer, this.qIndex[q.id]);
      const d = Math.hypot(player.pos.x - ans.x, player.pos.z - ans.z);
      // Without the big map (or by simply walking there), arriving also counts.
      if (a.phase === 'guess' && d < (step.radius || 60) * 0.5) this.solveDeduce(q, step, a, ans);
      if (a.phase === 'go' && d < 9) { this.clearStepObjs(); this.stepDone(q, step); }
    }
  }

  // Delivery: stand at the pickup on an allowed vehicle to load up, then beat the clock to the
  // drop-off. Running out of time, or swapping to a vehicle the load does not fit, puts the
  // load back at the pickup; nothing else is lost.
  tickTimed(q, s, a, player) {
    const modes = s.modes || ['scooter', 'bike'];
    const px = player.pos.x, pz = player.pos.z;
    const beamObj = this.stepObjs.find((o) => o.kind === 'beam');
    if (beamObj) beamObj.mesh.userData.ring.scale.setScalar(1 + Math.sin(this.time * 4) * 0.12);
    if (a.phase === 'pickup') {
      if (Math.hypot(px - a.pickup.x, pz - a.pickup.z) > (s.radius || 9)) { a.warned = false; return; }
      if (!modes.includes(player.mode)) {
        if (!a.warned && this.hud) { this.hud.toastMsg(this.t('ui.needWheels')); a.warned = true; }
        return;
      }
      a.phase = 'run';
      a.deadline = this.time + a.limit;
      a.runStart = this.time;
      this.clearStepObjs();
      this.addBeam(a.drop, 0x2ec4b6);
      this.carry = itemMesh(s.item || 'tray');
      this.root.add(this.carry);
      if (this.hud) this.hud.banner(this.t('ui.go'), this.qt(q, s.objRun || s.obj), this.t('ui.limit', { t: a.limit }));
      return;
    }
    // run
    if (this.carry) this.holdCarry(player);
    if (this.carry && !this.carry.userData.onAvatar) {
      this.carry.position.set(px, (player.y || 0) + 8.2 + Math.sin(this.time * 6) * 0.15, pz);
      this.carry.rotation.y += 0.02;
    }
    const reset = (msg) => {
      if (this.hud) this.hud.toastMsg(this.t(msg));
      this.dropCarry();
      this.clearStepObjs();
      a.phase = 'pickup';
      a.warned = false;
      a.tries = (a.tries || 0) + 1;
      // Each miss buys a little more time: a retry should get easier, never harder.
      a.limit = Math.ceil(a.limit * 1.15);
      this.addBeam(a.pickup, 0xffcb3d);
    };
    if (!modes.includes(player.mode)) { reset(s.noVehicle ? `${q.id}.${s.noVehicle}` : 'ui.noCar'); return; }
    if (this.time > a.deadline) { reset(s.timeUp ? `${q.id}.${s.timeUp}` : 'ui.timeUp'); a.limit += a.bonus || 0; a.bonus = 0; return; }
    if (this.tickEvents(q, s, a, player)) return;
    if (Math.hypot(px - a.drop.x, pz - a.drop.z) < (s.radius || 9)) {
      this.dropCarry();
      this.clearStepObjs();
      this.stepDone(q, s);
    }
  }

  // Escort: find the NPC, then walk them along streets to the drop-off. They only move while the
  // player is within the leash, so the player has to keep to their pace.
  tickEscort(q, s, a, player) {
    const n = this.npc(q, s.npc);
    if (!n) { this.nextStep(); return; }
    const d = Math.hypot(player.pos.x - n.x, player.pos.z - n.z);
    const leash = s.leash || 28;
    if (a.phase === 'meet') {
      if (d > TALK_R * 1.5) return;
      a.phase = 'walk';
      this.graph ||= new RoadGraph(this.roads);
      const route = this.graph.path(n.x, n.z, a.drop.x, a.drop.z) || [];
      n.path = [...route, { x: a.drop.x, z: a.drop.z }];
      n.escortSpeed = s.speed || 7;
      n.target = null;
      if (this.hud && s.start) this.hud.toastMsg(this.qt(q, s.start));
    }
    const was = n.walking;
    n.walking = d < leash;
    a.waiting = !n.walking;
    // Per-quest wait line: Hebrew needs the NPC's gender, which a generic string cannot know.
    if (was && !n.walking && this.hud) this.hud.toastMsg(s.wait ? this.qt(q, s.wait) : this.t('ui.waiting', { name: this.name(n.id) }));
    if (Math.hypot(n.x - a.drop.x, n.z - a.drop.z) < 4 || (n.path && !n.path.length)) {
      n.path = null; n.escortSpeed = 0; n.walking = false;
      try { n.av?.setMode('idle'); } catch (_) { /* optional */ }
      this.stepDone(q, s);
    }
  }

  walkPath(n, dt, speed) {
    if (!n.av) return 0;
    if (!speed) { if (n.av.mode !== 'idle') { try { n.av.setMode('idle'); } catch (_) { /* optional */ } } return 0; }
    if (n.av.mode !== 'walk') { try { n.av.setMode('walk'); } catch (_) { /* optional */ } }
    let move = speed * dt;
    while (move > 0 && n.path.length) {
      const p = n.path[0];
      const tx = p.x - n.x, tz = p.z - n.z, tl = Math.hypot(tx, tz);
      if (tl <= move) { n.x = p.x; n.z = p.z; move -= tl; n.path.shift(); continue; }
      n.x += (tx / tl) * move; n.z += (tz / tl) * move;
      n.yaw = Math.atan2(tx, tz);
      move = 0;
    }
    return speed;
  }

  // Roadside moments during a delivery or a ride: passing one opens a short scene, usually with
  // a choice. The clock keeps running while it plays, so stopping really costs time; an option
  // may buy time back on the next try (`bonus`) or take some now (`cost`). Each fires once per step.
  tickEvents(q, s, a, player) {
    for (const [i, e] of (s.events || []).entries()) {
      if (a.fired[i] || (e.if && !this.test(e.if))) continue;
      // `after` seconds into the run: the moment happens on whatever street the player took, so
      // the NPC steps out a little ahead of them (a crossing, a bus stop) instead of waiting at
      // a spot the chosen route may never pass.
      if (e.after) {
        if (this.time - (a.runStart || this.time) < e.after) continue;
        const n = e.npc && this.npc(q, e.npc);
        if (n) {
          const h = player.heading || 0;
          const f = this.collision.findFree(player.pos.x + Math.sin(h) * 9, player.pos.z + Math.cos(h) * 9, 1.6);
          n.x = f.x; n.z = f.z; n.y = this.groundY(n.x, n.z); n.target = null;
          n.yaw = Math.atan2(player.pos.x - n.x, player.pos.z - n.z);
        }
      }
      const p = e.npc ? this.npc(q, e.npc) : this.resolve(e.at, this.qIndex[q.id]);
      if (!p || Math.hypot(player.pos.x - p.x, player.pos.z - p.z) > (e.radius || 16)) continue;
      a.fired[i] = true;
      this.propActs(q, e.props);
      const opts = e.options || [];
      const after = (o) => {
        if (o) this.propActs(q, o.props);
        this.applyEffects(o ? o.effects : e.effects);
        if (o && o.cost) a.deadline -= o.cost;
        if (o && o.bonus) a.bonus = (a.bonus || 0) + o.bonus;
        if (o && o.reply) this.openDialogue(`${q.id}.${o.reply}`, {});
      };
      if (opts.length) this.openDialogue(`${q.id}.${e.dialogue}`, { choices: opts.map((o) => this.qt(q, o.text)), onChoice: (k) => after(opts[k]) });
      else this.openDialogue(`${q.id}.${e.dialogue}`, { onDone: () => after(null) });
      return true;
    }
    return false;
  }

  // Ride with a passenger: walk or drive up to them in an allowed vehicle and they climb in;
  // the drop-off has a clock. A miss or leaving the vehicle puts them back at the pickup with
  // more time. A calm meter (mini-game `calm`) rides along when that module exists.
  tickDrive(q, s, a, player) {
    const n = this.npc(q, s.npc);
    if (!n) { this.nextStep(); return; }
    const modes = s.modes || ['car'];
    const px = player.pos.x, pz = player.pos.z;
    if (a.phase === 'meet') {
      if (Math.hypot(px - n.x, pz - n.z) > TALK_R * 1.4) { a.warned = false; return; }
      if (!modes.includes(player.mode)) {
        if (!a.warned && this.hud) { this.hud.toastMsg(s.needVehicle ? this.qt(q, s.needVehicle) : this.t('ui.needCar')); a.warned = true; }
        return;
      }
      a.phase = 'run';
      a.deadline = this.time + a.limit;
      a.runStart = this.time;
      // A retry starts from where this leg began: a multi-stop ride (m19) picks the passenger up
      // where the last leg dropped them, not at their first spawn.
      a.from = { x: n.x, z: n.z };
      n.riding = true; n.target = null;
      this.seat(n, player);
      this.clearStepObjs();
      this.addBeam(a.drop, 0x2ec4b6);
      // With the passenger mini-game, it runs the ride (calm meter, clock, retries from the
      // pickup, the drop-off); this step keeps the roadside scenes.
      if (s.calm && this.hasGame('calm')) {
        a.managed = this.startMinigame('calm', {
          at: a.drop, radius: s.radius || 10, start: { x: a.from.x, z: a.from.z }, limit: a.limit, guide: false,
          passenger: n.seated ? null : { archetype: n.def.archetype }, name: `quest.npc.${n.id}`, calm: s.calm, waitSpots: s.waitSpots,
        }, (res) => {
          a.managed = false;
          if (res && res.effects) this.applyEffects(res.effects);
          if (res && res.ok === false) { this.driveReset(q, s, a, n, 'ui.calmLost'); return; }
          this.arrive(q, s, a, n);
        }, q);
      }
      if (this.hud) this.hud.banner(this.t('ui.go'), this.qt(q, s.objRun || s.obj), this.t('ui.limit', { t: a.limit }));
      return;
    }
    n.x = px; n.z = pz;
    // Safety net for a drop-off the vehicle cannot physically reach (a fence or a building on the
    // spot): standing still nearby for a few seconds counts as arriving, so the ride cannot stall.
    const nearDrop = Math.hypot(px - a.drop.x, pz - a.drop.z) < Math.max(PARKED_NEAR_R, (s.radius || 10) * 4);
    if (nearDrop && Math.abs(player.speed || 0) < 1.5) {
      a.parkedAt ??= this.time;
      if (this.time - a.parkedAt > PARKED_NEAR_S) { a.parkedAt = null; this.arrive(q, s, a, n); return; }
    } else a.parkedAt = null;
    if (a.managed) { this.tickEvents(q, s, a, player); return; }
    if (!modes.includes(player.mode)) { this.driveReset(q, s, a, n, s.noVehicle ? `${q.id}.${s.noVehicle}` : 'ui.noCarRide'); return; }
    if (this.time > a.deadline) { this.driveReset(q, s, a, n, s.timeUp ? `${q.id}.${s.timeUp}` : 'ui.timeUpRide'); return; }
    if (this.tickEvents(q, s, a, player)) return;
    if (Math.hypot(px - a.drop.x, pz - a.drop.z) < (s.radius || 10)) this.arrive(q, s, a, n);
  }

  // In the car, the rider sits in the front passenger seat where the player can see them; on
  // two wheels (or without the avatar) they just ride along unseen, as before.
  seat(n, player) {
    if (player && player.mode === 'car' && player.seatPassenger && this.ensureAv(n)) n.seated = player.seatPassenger(n.av);
  }

  unseat(n) {
    if (!n.seated) return;
    n.seated = false;
    if (this.player && this.player.passenger === n.av) this.player.releasePassenger();
    if (n.av) n.av.group.rotation.set(0, n.yaw || 0, 0);
  }

  arrive(q, s, a, n) {
    this.endMinigame();
    this.unseat(n);
    n.riding = false;
    const p = this.collision.findFree(a.drop.x + 3, a.drop.z + 3, 1.6);
    n.x = p.x; n.z = p.z; n.y = this.groundY(n.x, n.z);
    this.clearStepObjs();
    this.stepDone(q, s);
  }

  driveReset(q, s, a, n, msg) {
    this.endMinigame();
    a.managed = false;
    if (this.hud) this.hud.toastMsg(this.t(msg));
    this.unseat(n);
    n.riding = false;
    const back = a.from || n.home;
    n.x = back.x; n.z = back.z; n.y = this.groundY(n.x, n.z);
    this.clearStepObjs();
    a.phase = 'meet'; a.warned = false; a.tries = (a.tries || 0) + 1;
    a.limit = Math.ceil(a.limit * 1.15) + (a.bonus || 0); a.bonus = 0;
  }

  // Track by sound: something (the dog) waits at one of a few street spots inside a zone and
  // can be heard from afar. Rushing in (running or on wheels) makes it bolt to the next spot;
  // walking up slowly wins it over, and then it follows the player home.
  startTrack(q, s, a, qi) {
    const c = this.resolve(s.at, qi);
    const rnd = seeded(q.id + a.step + 'track');
    const r = s.radius || 90;
    a.zone = { x: c.x, z: c.z, radius: r };
    a.spots = [];
    // Hand-picked spots (the far side of the water park's footbridge) or random street points.
    if (s.spots && s.spots.length) for (const at of s.spots) { const p = this.resolve(at, qi); a.spots.push(this.collision.findFree(p.x, p.z, 1.2)); }
    else for (let i = 0; i < Math.max(3, (s.hops || 3) + 1); i++) {
      const ang = (i / 4) * Math.PI * 2 + rnd() * 1.2, rr = r * (0.35 + rnd() * 0.5);
      a.spots.push(this.streetSpot(c.x + Math.cos(ang) * rr, c.z + Math.sin(ang) * rr));
    }
    a.spot = 0; a.phase = 'find'; a.barkT = 0;
    a.home = this.resolve(s.home || s.at, qi);
    const m = itemMesh(s.item || 'dog');
    const p = a.spots[0];
    m.position.set(p.x, this.groundY(p.x, p.z), p.z);
    this.root.add(m);
    a.pet = { kind: 'pet', mesh: m, x: p.x, z: p.z, yaw: 0 };
    this.stepObjs.push(a.pet);
  }

  tickTrack(q, s, a, player, dt) {
    const pet = a.pet;
    if (!pet) return;
    const px = player.pos.x, pz = player.pos.z;
    const d = Math.hypot(px - pet.x, pz - pet.z);
    const tail = pet.mesh.userData.tail;
    if (tail) tail.rotation.y = Math.sin(this.time * (a.phase === 'follow' ? 16 : 6)) * 0.6;
    const walkTop = (player.params && player.params.speed) || 7;
    const rushing = player.mode !== 'walk' || Math.abs(player.speed || 0) > walkTop * 1.15;
    if (a.phase === 'find') {
      a.barkT -= dt;
      if (a.barkT <= 0) {
        a.barkT = 2.2;
        pet.mesh.userData.bark = 0.6;
        if (this.hooks.playAt) { try { this.hooks.playAt(s.beacon || 'bark', pet.x, pet.z); } catch (_) { /* optional */ } }
        if (d < 140 && d > 25 && this.hud && !a.barkShown) { this.hud.toastMsg(this.qt(q, s.barkText || 'bark')); a.barkShown = true; }
      }
      const b = pet.mesh.userData.bubble;
      if (b) { pet.mesh.userData.bark = Math.max(0, (pet.mesh.userData.bark || 0) - dt); b.visible = pet.mesh.userData.bark > 0; }
      if (d < (s.scareR || 18) && rushing) {
        a.spot = (a.spot + 1) % a.spots.length;
        const p = a.spots[a.spot];
        pet.x = p.x; pet.z = p.z;
        pet.mesh.position.set(p.x, this.groundY(p.x, p.z), p.z);
        a.hops = (a.hops || 0) + 1;
        if (this.hud) this.hud.toastMsg(this.qt(q, s.ranText || 'ran'));
        return;
      }
      if (d < (s.catchR || 6)) {
        a.phase = 'follow';
        this.addBeam(a.home, 0x2ec4b6);
        if (this.hud && s.caught) this.hud.toastMsg(this.qt(q, s.caught));
      }
      return;
    }
    // follow: trot a few steps behind the player, wait while they ride (it is a dog, not a biker)
    if (!rushing || d < 30) {
      const tx = px - pet.x, tz = pz - pet.z, tl = Math.hypot(tx, tz);
      if (tl > 3.5) {
        const k = Math.min(1, (Math.min(16, tl * 2) * dt) / tl);
        pet.x += tx * k; pet.z += tz * k;
        pet.yaw = Math.atan2(tx, tz);
      }
    }
    pet.mesh.position.set(pet.x, this.groundY(pet.x, pet.z), pet.z);
    pet.mesh.rotation.y = pet.yaw;
    if (Math.hypot(pet.x - a.home.x, pet.z - a.home.z) < (s.homeR || 10)) this.stepDone(q, s);
  }

  // Barter chain: the player carries a few items; each neighbour in the chain says what they are
  // missing, and offering the right item trades it for theirs. Wrong offers are only a "no thanks".
  openBarter(q, s, a, n) {
    const link = (s.chain || []).find((c) => c.npc === n.id && !a.traded.includes(c.npc));
    if (!link) return;
    const items = a.inv.slice();
    const choices = [...items.map((k) => this.t(`items.${k}`)), this.t('ui.notYet')];
    this.openDialogue(`${q.id}.${link.ask}`, {
      choices,
      onChoice: (i) => {
        if (i >= items.length) return;
        const offered = items[i];
        if (offered !== link.wants) { this.openDialogue(`${q.id}.${link.no || s.no}`, {}); return; }
        a.inv = a.inv.filter((k) => k !== offered).concat(link.gives ? [link.gives] : []);
        a.traded.push(link.npc);
        this.showBag(q, a);
        this.propActs(q, link.props);
        this.applyEffects(link.effects);
        const done = s.goal && a.inv.includes(s.goal);
        this.openDialogue(`${q.id}.${link.yes}`, { onDone: () => { if (this.hud && link.gives) this.hud.toastMsg(this.t('ui.got', { item: this.t(`items.${link.gives}`) })); if (done) this.stepDone(q, s); } });
      },
    });
  }

  // ---------------- GPS guidance ----------------
  // Founder: the ground ribbon only where the route is the challenge (timed deliveries; races
  // draw their own). Every other objective is a star on the maps plus the tracker arrow. A
  // waypoint set on the big map gets a route line on the maps only, never on the ground.
  guide(dt, player, obj) {
    const gps = this.gps;
    if (!gps) return;
    if (this.mg || (this.minigames && this.minigames.active)) { this._gpsKey = null; this.mapRoute = null; return; }
    const a = this.state.active, step = a && this.byId[a.id].steps[a.step];
    // Founder: arrows on the ground only where the route is the challenge: timed deliveries
    // (races draw their own). Rides, first trips and everything else: star + tracker only.
    const ribbon = !!(step && step.type === 'timed');
    const t = ribbon ? obj && obj.target : null;
    const mode = { scooter: 'wheels', bike: 'wheels', car: 'car' }[player.mode] || 'walk';
    if (!t || t.zone || !gps.ready || this.jumping) {
      if (this._gpsKey) { gps.clear(); this._gpsKey = null; }
    } else {
      const key = `${Math.round(t.x / 8)},${Math.round(t.z / 8)},${mode}`;
      if (key !== this._gpsKey) {
        try { gps.guide({ x: t.x, z: t.z }, { mode, owner: 'quests', color: 0x2ec4b6, arrive: 8 }); } catch (e) { console.warn('[quests] gps.guide failed', e); this.gps = null; return; }
        this._gpsKey = key;
      }
      gps.update(dt, player, 'quests');
    }
    // Map-only route to a big-map waypoint: re-planned when the player has moved on or the
    // waypoint changed, at most every second (a route costs 1-30 ms).
    const wp = this.world.bigmap && this.world.bigmap.getWaypoint ? this.world.bigmap.getWaypoint() : null;
    if (!wp || !gps.ready || this._gpsKey) { this.mapRoute = null; return; }
    const mr = this.mapRoute;
    const stale = !mr || mr.wp.x !== wp.x || mr.wp.z !== wp.z || mr.mode !== mode || Math.hypot(player.pos.x - mr.from.x, player.pos.z - mr.from.z) > 25;
    if (stale && this.time - (this._mapRouteT || -9) > 1) {
      this._mapRouteT = this.time;
      try {
        const r = gps.route({ x: player.pos.x, z: player.pos.z }, wp, { mode });
        this.mapRoute = { wp: { x: wp.x, z: wp.z }, mode, from: { x: player.pos.x, z: player.pos.z }, points: r && r.points ? r.points : [] };
      } catch (_) { this.mapRoute = null; }
    }
  }

  // The route the maps draw: the ground ribbon's, else the waypoint's map-only route.
  routePoints() {
    if (this.gps && this.gps.active) return this.gps.remaining();
    return this.mapRoute ? this.mapRoute.points : null;
  }

  // A delivery or a ride whose pickup is across town starts with a short fade to the pickup, on
  // the right vehicle and facing the way to go, instead of a long trip with nothing to do.
  jumpTo(spot, mode, toward) {
    const mg = this.minigames;
    if (!mg || typeof mg.jumpToStart !== 'function' || !this.lastPlayer) return;
    if (Math.hypot(spot.x - this.lastPlayer.x, spot.z - this.lastPlayer.z) < JUMP_R) return;
    let heading = 0;
    try {
      const r = this.gps && this.gps.ready ? this.gps.route(spot, toward, { mode: mode === 'car' ? 'car' : 'wheels' }) : null;
      const p = r && r.points && r.points[Math.min(3, r.points.length - 1)];
      heading = Math.atan2((p || toward).x - spot.x, (p || toward).z - spot.z);
    } catch (_) { heading = Math.atan2(toward.x - spot.x, toward.z - spot.z); }
    const free = this.collision.findFree(spot.x, spot.z, 2.2);
    this.jumping = true;
    Promise.resolve(mg.jumpToStart({ x: free.x, z: free.z, heading, mode }, {}))
      .catch((e) => console.warn('[quests] jumpToStart failed', e))
      .finally(() => { this.jumping = false; });
  }

  // ---------------- mini-games ----------------
  // Mini-game modules live in src/engine/minigames (docs/MINIGAMES.md): createMinigames(deps)
  // returns { rhythm, race, passenger, photo, parking, crowdguide, debate, update(dt, input),
  // blocksPlayer }, each game { start(config) -> Promise<result>, cancel(), active, blocksPlayer }.
  // Quest data names games by verb; this maps them onto the modules. Anchors in a config
  // ({ poi | place | lat/lon, dx, dz }) are resolved to world points first.
  // A verb with no module yet plays as a stub: a short placeholder line, then it counts as passed,
  // so the story stays playable end to end while the module is being built.
  setMinigames(registry, story = null) {
    this.minigames = registry;
    this.gps = registry && registry.gps ? registry.gps : null;
    if (this.gps && this.hud && this.hud.setGps) this.hud.setGps(this.gps, () => this.routePoints());
    if (this.gps && this.world.bigmap && this.world.bigmap.setGps) this.world.bigmap.setGps(this.gps, () => this.routePoints());
    if (story && typeof story.apply === 'function') {
      // The mini-games' story ledger is the one source of truth once it exists; carry over
      // anything recorded before it arrived.
      const mine = this.story;
      if (mine.scale || Object.keys(mine.flags).length || Object.keys(mine.trust).length) {
        story.apply({ scale: mine.scale, trust: mine.trust, flags: Object.entries(mine.flags).map(([k, v]) => (v === true ? k : `${k}=${v}`)) }, 'quests:carry');
      }
      this.ledger = story;
    }
    this.refreshHud();
  }

  static GAME_MODULE = { rhythm: 'rhythm', cue: 'rhythm', race: 'race', calm: 'passenger', photo: 'photo', parking: 'parking', crowd: 'crowdguide', debate: 'debate', surf: 'surf', skate: 'skate', cinema: 'cinema' };

  hasGame(kind) {
    const m = QuestSystem.GAME_MODULE[kind];
    return !!(m && this.minigames && this.minigames[m] && typeof this.minigames[m].start === 'function');
  }

  // Deep copy of a config with every anchor turned into { x, z } (keeps `y`/`heading` if given).
  // Story branches inside a config: array items with `if` are kept only when it holds,
  // { $if, then, else } picks a value, and `<name>If: cond` sets `<name>` to the test result
  // (a helper group that only leads itself out when the player earned it).
  resolveConfig(v, qi) {
    if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === 'object' && 'if' in x) || this.test(x.if)).map((x) => this.resolveConfig(x, qi));
    if (!v || typeof v !== 'object') return v;
    if ('$if' in v) return this.resolveConfig(this.test(v.$if) ? v.then : v.else, qi);
    // { $lot: anchor }: the real parking lot (from world/parking.js) that contains the anchor, or
    // the nearest within 60 u, handed over whole (its stalls and outline), not as a point.
    if ('$lot' in v) {
      const p = this.resolve(v.$lot, qi);
      let best = null, bd = 60;
      for (const l of this.world.lots || []) {
        const pts = l.points || [];
        if (pts.length > 2 && inPoly(p.x, p.z, pts)) return l;
        const c = pts.reduce((a, q) => ({ x: a.x + (q[0] ?? q.x) / pts.length, z: a.z + (q[1] ?? q.z) / pts.length }), { x: 0, z: 0 });
        const d = Math.hypot(c.x - p.x, c.z - p.z);
        if (d < bd) { bd = d; best = l; }
      }
      return best;
    }
    if (v.lot === true) { const p = this.resolve(v, qi); return { x: p.x, z: p.z }; }
    // { npc: 'shiri' }: where that character currently stands (a photo of people on a bench).
    if (typeof v.npc === 'string' && Object.keys(v).every((k) => ['npc', 'dx', 'dz', 'y'].includes(k))) {
      const n = this.current(v.npc);
      if (n) return { x: n.x + (v.dx || 0), z: n.z + (v.dz || 0), ...(v.y != null ? { y: v.y } : {}) };
    }
    if (typeof v.poi === 'string' || typeof v.place === 'string' || typeof v.lat === 'number') {
      // `free`: a landmark's centre is often inside its building; take the nearest open spot.
      let p = this.resolve(v, qi);
      if (v.free) p = this.collision.findFree(p.x, p.z, 2.5);
      return { x: p.x, z: p.z, ...(v.y != null ? { y: v.y } : {}), ...(v.heading != null ? { heading: v.heading } : {}) };
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'if') continue;
      if (k.length > 2 && k.endsWith('If') && typeof x === 'string') out[k.slice(0, -2)] = this.test(x);
      else out[k] = this.resolveConfig(x, qi);
    }
    return out;
  }

  startMinigame(kind, params, onDone, q) {
    if (!this.hasGame(kind)) {
      if (kind === 'calm') return false; // optional rider on a drive
      this.openDialogue(`stub.${kind}`, { lines: [['narrator', this.t('ui.minigameStub', { game: this.t(`ui.games.${kind}`) })]], onDone: () => onDone({ ok: true, stub: true }) });
      return false;
    }
    const reg = this.minigames, game = reg[QuestSystem.GAME_MODULE[kind]];
    const cfg = this.resolveConfig(params || {}, q ? this.qIndex[q.id] : 0);
    const handle = {
      game, kind, cfg,
      get blocks() { return !!(reg.blocksPlayer ?? game.blocksPlayer); },
      update: (dt, player, input) => reg.update(dt, input),
      cancel: () => { try { game.cancel(); } catch (_) { /* optional */ } },
    };
    this.mg = handle;
    let p;
    try { p = game.start(cfg); } catch (e) { console.warn('[quests] minigame failed to start', kind, e); this.mg = null; onDone({ ok: true, stub: true }); return false; }
    Promise.resolve(p).then((res) => {
      if (this.mg !== handle) return; // cancelled by the quest (step skipped, reset)
      this.mg = null;
      onDone(res || { ok: true });
    }, (e) => { console.warn('[quests] minigame failed', kind, e); if (this.mg === handle) { this.mg = null; onDone({ ok: true, stub: true }); } });
    return true;
  }

  endMinigame() {
    const h = this.mg;
    this.mg = null;
    if (h && h.cancel) { try { h.cancel(); } catch (_) { /* optional */ } }
  }

  tickMinigame(q, s, a, player, dt) {
    if (a.phase === 'play') return;
    const px = player.pos.x, pz = player.pos.z;
    if (a.spot) {
      const b = this.stepObjs.find((o) => o.kind === 'beam');
      if (b) b.mesh.userData.ring.scale.setScalar(1 + Math.sin(this.time * 4) * 0.12);
      if (Math.hypot(px - a.spot.x, pz - a.spot.z) > (s.radius || 9)) return;
    } else if (s.npc) return; // started by talking to the NPC (see update)
    this.runMinigame(q, s, a);
  }

  runMinigame(q, s, a) {
    a.phase = 'play';
    this.clearStepObjs();
    // Characters the module brings its own copies of (race rivals) step out while it runs.
    const hidden = (s.hide || []).map((id) => this.npc(q, id)).filter((n) => n && !n.riding);
    // `config` is the name docs/MINIGAMES.md uses; `params` the older one.
    const base = s.config || s.params;
    const params = s.paramsIf ? (this.pick(s.paramsIf) ? s.paramSets[this.pick(s.paramsIf)] : base) : base;
    const go = () => this.startMinigame(s.game, params, (res) => {
      for (const n of hidden) n.riding = false;
      if (res && res.ok === false) {
        a.tries = (a.tries || 0) + 1;
        if (this.hud) this.hud.toastMsg(s.failText ? this.qt(q, s.failText) : this.t('ui.tryAgain'));
        a.phase = 'go';
        if (a.spot) this.addBeam(a.spot, 0xb36bd6);
        return;
      }
      if (res && res.effects) this.applyEffects(res.effects);
      if (s.cheer && this.hud) this.hud.banner(this.t('ui.nailed'), this.qt(q, s.cheer));
      this.stepDone(q, s);
    }, q);
    const start = () => { if (this.hasGame(s.game)) for (const n of hidden) n.riding = true; go(); };
    const intro = this.pick(s.intro);
    if (intro) this.openDialogue(`${q.id}.${intro}`, { onDone: start });
    else start();
  }

  // A choice. With `good` options (V1 tone choices, V2 debate rounds) the right one moves the
  // quest on and a wrong one plays its reply, the NPC walks off to cool down, and the player can
  // come back and retry. Without them every option moves on, carrying its own effects: there is
  // no wrong answer, only consequences.
  openChoice(q, s, a) {
    const lead = this.pick(a.retry && s.retry ? s.retry : s.dialogue);
    const strict = s.options.some((o) => 'good' in o);
    const labels = s.options.map((o) => this.qt(q, o.text));
    this.openDialogue(`${q.id}.${lead}`, {
      choices: labels,
      onChoice: (i) => {
        const o = s.options[i];
        this.applyEffects(o.effects);
        this.openDialogue(`${q.id}.${o.reply}`, {
          onDone: () => {
            if (!strict || o.good) { this.nextStep(); return; }
            a.retry = true;
            const n = this.npc(q, s.npc);
            if (n) {
              const ang = Math.atan2(n.x - this.lastPlayer.x, n.z - this.lastPlayer.z) + (Math.random() - 0.5);
              n.target = this.collision.findFree(n.x + Math.sin(ang) * 16, n.z + Math.cos(ang) * 16, 1.6);
            }
            if (this.hud) this.hud.toastMsg(this.t('ui.wrongTone'));
          },
        });
      },
    });
  }

  gathering(q, step) { return (step.gather || []).some((id) => { const n = this.npc(q, id); return n && n.target; }); }

  // Debug helper for tests and the console: finish the current step or offer (a choice picks
  // the right tone).
  debugSkip() {
    const a = this.state.active;
    if (this.dlg) {
      if (this.dlg.choices) {
        const s = a && this.byId[a.id].steps[a.step];
        const good = Math.max(0, s?.options?.findIndex((o) => o.good) ?? 0); // non-strict: first option
        this.dlg.i = this.dlg.lines.length - 1;
        this.pickOption(good);
      } else this.advanceDialogue(true);
      return;
    }
    if (!a) { const q = this.available()[0]; if (q) this.accept(q); return; }
    this.endMinigame();
    for (const n of Object.values(this.npcs)) {
      if (n.riding) { this.unseat(n); n.riding = false; if (a.drop) { n.x = a.drop.x + 3; n.z = a.drop.z + 3; } }
      if (n.target) { n.x = n.target.x; n.z = n.target.z; n.target = null; }
      if (n.path) { const end = n.path[n.path.length - 1]; if (end) { n.x = end.x; n.z = end.z; } n.path = null; n.escortSpeed = 0; }
    }
    this.nextStep();
  }
}
