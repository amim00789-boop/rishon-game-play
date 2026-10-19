// Wires the world, characters and engine together. Every content module is imported
// dynamically: if one is missing or throws, a fallback keeps the game playable.
import * as THREE from 'three';
import { createRenderer, applyToonRamp, toonMat } from './engine/renderer.js';
import { createSky } from './engine/sky.js';
import { applyWater } from './engine/water.js';
import { createInput } from './engine/input.js';
import { CollisionWorld } from './engine/collision.js';
import { Player } from './engine/player.js';
import { ChaseCamera } from './engine/camera.js';
import { Crowd } from './engine/npcs.js';
import { Hud } from './engine/hud.js';
import { loadI18n, t, dir } from './i18n.js';
import { createProfiles } from './engine/profiles.js';

const params = new URLSearchParams(location.search);
const POST_ON = params.get('post') !== '0';

const loadFill = document.getElementById('loading-fill');
const loadMsg = document.getElementById('loading-msg');
// rAF never fires in a hidden tab; the timeout keeps loading moving if the tab is in the background.
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 60); });
async function progress(pct, msg) {
  if (loadFill) loadFill.style.width = pct + '%';
  if (loadMsg) loadMsg.textContent = msg;
  await nextFrame();
}

// ?skip=city,landmarks,avatar forces the fallbacks, to check the game still runs without them.
const SKIP = new Set((params.get('skip') || '').split(',').filter(Boolean));

async function tryImport(path, label) {
  if (SKIP.has(label)) { console.warn(`[main] ${label} skipped by ?skip; using fallback.`); return null; }
  try {
    return await import(path);
  } catch (e) {
    console.warn(`[main] ${label} unavailable (${path}); using fallback.`, e.message || e);
    return null;
  }
}

// Boot profiling: every phase becomes a performance.measure named "boot:<phase>", collected in
// window.__bootPerf so the load can be timed from DevTools or tools/measure_boot.mjs.
const bootPerf = { phases: [], t0: performance.now() };
window.__bootPerf = bootPerf;
function measure(name, start) {
  const end = performance.now();
  try { performance.measure('boot:' + name, { start, end }); } catch { /* old browsers */ }
  bootPerf.phases.push({ name, ms: Math.round(end - start) });
  return end;
}

const FROZEN = { axis: () => ({ f: 0, r: 0 }), isDown: () => false, wasPressed: () => false };

// ---------- fallbacks ----------
function fallbackWorld(scene) {
  const rnd = mulberry(1337);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), toonMat(0x9ccc6a));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(70, 1200), toonMat(0xf3dca2));
  sand.rotation.x = -Math.PI / 2;
  sand.position.set(-185, 0.03, 0);
  sand.receiveShadow = true;
  scene.add(sand);
  // Sea with a wiggly coastline so the shoreline foam has something to follow.
  const coast = new THREE.Shape();
  coast.moveTo(-620, 600);
  for (let z = -600; z <= 600; z += 25) coast.lineTo(-220 + Math.sin(z * 0.02) * 10, -z);
  coast.lineTo(-620, -600);
  coast.lineTo(-620, 600);
  const sea = new THREE.Mesh(new THREE.ShapeGeometry(coast), new THREE.MeshBasicMaterial({ color: 0x2a9ee0 }));
  sea.rotation.x = -Math.PI / 2; // shape y = -z, so this lands it on the XZ plane facing up
  sea.position.y = 0.06;
  sea.userData.water = true;
  scene.add(sea);

  const roads = [];
  const roadMat = toonMat(0x5a5f6b);
  const addRoad = (pts, width) => {
    roads.push({ kind: 'residential', width, points: pts });
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(width, len), roadMat);
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = -Math.atan2(bx - ax, bz - az);
      m.position.set((ax + bx) / 2, 0.05, (az + bz) / 2);
      m.receiveShadow = true;
      scene.add(m);
    }
  };
  addRoad([[-140, -560], [-140, 560]], 10);
  for (let z = -480; z <= 480; z += 80) addRoad([[-140, z], [520, z]], 8);
  for (let x = -40; x <= 520; x += 90) addRoad([[x, -560], [x, 560]], 8);

  const colliders = [];
  const pastel = [0xf4e3c1, 0xf2c6a0, 0xcfe0f3, 0xf6cfcf, 0xd9efcf, 0xfff1d6, 0xe5d4f2];
  const roof = [0xd2694a, 0x9a6b4f, 0x6f8fa8];
  for (let bx = -140; bx < 520; bx += 90) {
    for (let bz = -480; bz < 480; bz += 80) {
      for (let k = 0; k < 3; k++) {
        const w = 18 + rnd() * 14, d = 16 + rnd() * 12, h = 10 + Math.floor(rnd() * 6) * 6;
        const x = bx + 12 + w / 2 + k * ((90 - 24 - w) / 2) * (rnd() * 0.3 + 0.85);
        const z = bz + 12 + d / 2 + rnd() * (80 - 24 - d);
        if (x + w / 2 > bx + 86 || bx < -130 && x - w / 2 < -132) continue;
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toonMat(pastel[Math.floor(rnd() * pastel.length)]));
        b.position.set(x, h / 2, z);
        b.castShadow = b.receiveShadow = true;
        scene.add(b);
        const r = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 1.2, d + 1), toonMat(roof[Math.floor(rnd() * roof.length)]));
        r.position.set(x, h + 0.6, z);
        r.castShadow = true;
        scene.add(r);
        colliders.push({ points: [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]], height: h });
      }
    }
  }
  // palms along the promenade
  const trunkMat = toonMat(0xa0703c), leafMat = toonMat(0x4caf50);
  for (let z = -540; z <= 540; z += 36) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 12, 7), trunkMat);
    t.position.set(-160, 6, z); t.castShadow = true; scene.add(t);
    const l = new THREE.Mesh(new THREE.ConeGeometry(5, 3, 7), leafMat);
    l.position.set(-160, 12.5, z); l.castShadow = true; scene.add(l);
    colliders.push({ points: [[-161, z - 1], [-159, z - 1], [-159, z + 1], [-161, z + 1]], height: 12 });
  }
  colliders.push({ points: [[-620, -600], ...Array.from({ length: 49 }, (_, i) => [-220 + Math.sin((-600 + i * 25) * 0.02) * 10, -600 + i * 25]), [-620, 600]], height: 0.5, kind: 'sea' });
  return { colliders, spawn: { x: -120, z: 20 }, bounds: { minX: -300, maxX: 560, minZ: -580, maxZ: 580 }, roads };
}

function fallbackAvatar(color = 0xe5532d) {
  const group = new THREE.Group();
  const skin = toonMat(0xf1c27d);
  const shirt = toonMat(color);
  const pants = toonMat(0x2b4a9c);
  const mk = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; return m; };
  const torso = mk(new THREE.BoxGeometry(1.8, 1.9, 1.0), shirt, 0, 2.95, 0);
  const head = mk(new THREE.BoxGeometry(1.3, 1.3, 1.3), skin, 0, 4.55, 0);
  const eyes = [-0.28, 0.28].map((x) => mk(new THREE.BoxGeometry(0.16, 0.26, 0.05), toonMat(0x222222), x, 4.65, 0.66));
  const legPivot = (x) => { const p = new THREE.Group(); p.position.set(x, 2.0, 0); p.add(mk(new THREE.BoxGeometry(0.8, 2.0, 0.9), pants, 0, -1.0, 0)); return p; };
  const armPivot = (x) => { const p = new THREE.Group(); p.position.set(x, 3.8, 0); p.add(mk(new THREE.BoxGeometry(0.6, 1.8, 0.7), skin, 0, -0.9, 0)); return p; };
  const lL = legPivot(-0.45), lR = legPivot(0.45), aL = armPivot(-1.22), aR = armPivot(1.22);
  group.add(torso, head, ...eyes, lL, lR, aL, aR);
  let t = 0, wave = 0, mode = 'walk';
  return {
    group,
    setMode(m) { mode = m; },
    emote() { wave = 1.6; },
    update(dt, speed = 0) {
      t += dt * (2 + speed * 0.9);
      const seated = mode === 'bike' || mode === 'car';
      const amp = mode === 'walk' || mode === 'idle' ? Math.min(1, speed / 6) * 0.8 : 0;
      lL.rotation.x = seated ? -1.3 : Math.sin(t) * amp;
      lR.rotation.x = seated ? -1.3 : -Math.sin(t) * amp;
      aL.rotation.x = mode === 'walk' ? -Math.sin(t) * amp : -1.0;
      aR.rotation.x = mode === 'walk' ? Math.sin(t) * amp : -1.0;
      if (wave > 0) { wave -= dt; aR.rotation.x = 0; aR.rotation.z = 2.6 + Math.sin(wave * 14) * 0.35; } else aR.rotation.z = 0;
      group.position.y = mode === 'walk' ? Math.abs(Math.sin(t)) * 0.15 * amp : 0;
    },
  };
}

// ---------- boot ----------
async function boot() {
  // Text first: every label after this point, loading screen included, comes from data/i18n.
  let tp = measure('page + module load', 0);
  await loadI18n();
  tp = measure('i18n', tp);
  const loadingEl = document.getElementById('loading');
  if (loadingEl) { loadingEl.dir = dir(); loadingEl.querySelector('h1').textContent = t('load.title'); }
  // Who is playing: the start screen shows over the loading city; the quests wait for the choice.
  const profiles = createProfiles({ t, dir, params });
  profiles.start();
  await progress(5, t('load.sun'));
  const { renderer, scene, camera } = createRenderer({ post: POST_ON });
  const sky = createSky(scene);

  let post = null;
  if (POST_ON) {
    try {
      const { createPost } = await import('./engine/post.js');
      post = createPost(renderer, scene, camera);
      post.exclude(sky.dome);
    } catch (e) {
      console.warn('[main] post-processing unavailable, rendering plain.', e);
    }
  }

  // Terrain before every world module: they read groundAt() while building, and it is 0 until loaded.
  tp = measure('renderer+post', tp);
  const tm = await tryImport('./world/terrain.js', 'terrain');
  if (tm?.loadTerrain) { try { await tm.loadTerrain(); } catch (e) { console.warn('[main] loadTerrain failed', e); } }
  tp = measure('terrain load', tp);

  await progress(15, t('load.landmarks'));
  let landmarks = { colliders: [], pois: [] };
  let updateLandmarks = null;
  let exclude = [];
  const lm = await tryImport('./world/landmarks.js', 'landmarks');
  if (lm && lm.buildLandmarks) {
    try {
      const r = await lm.buildLandmarks(scene);
      landmarks = { colliders: r?.colliders || [], pois: r?.pois || [] };
      exclude = lm.LANDMARK_FOOTPRINTS || [];
      updateLandmarks = lm.updateLandmarks || null;
    } catch (e) { console.warn('[main] buildLandmarks failed', e); }
  }
  tp = measure('landmarks', tp);
  // Gal's airliner on the dunes (Adir, 2026-10-18): a walkable cabin with its own colliders and POI.
  let plane = null;
  const ap = await tryImport('./world/airplane.js', 'airplane');
  if (ap?.buildAirplane) {
    try {
      plane = ap.buildAirplane(scene);
      landmarks.colliders.push(...plane.colliders);
      landmarks.pois.push(...plane.pois);
    } catch (e) { console.warn('[main] buildAirplane failed', e); plane = null; }
  }
  // LLRS airfield and its circuit plane (round 7): adds its colliders, POI and hangar exclusion, runs itself.
  try { (await tryImport('./world/airfield.js', 'airfield'))?.buildAirfield?.(scene, { landmarks, exclude }); } catch (e) { console.warn('[main] buildAirfield failed', e); }

  await progress(35, t('load.city'));
  let city = null;
  const cm = await tryImport('./world/city.js', 'city');
  if (cm && cm.buildCity) {
    try { city = await cm.buildCity(scene, { exclude }); } catch (e) { console.warn('[main] buildCity failed', e); }
  }
  tp = measure('city (roads+buildings)', tp);
  if (!city) city = fallbackWorld(scene);
  city.roads = city.roads || [];
  city.colliders = city.colliders || [];
  // Landmarks built before the city; let them snap to city-owned levels (station platforms, stairs).
  if (lm?.alignLandmarksToCity) { try { lm.alignLandmarksToCity(city); } catch (e) { console.warn('[main] alignLandmarksToCity failed', e); } }
  if (tm?.buildTerrain) { try { tm.buildTerrain(scene, { bounds: city.bounds }); } catch (e) { console.warn('[main] buildTerrain failed', e); } }
  tp = measure('terrain mesh', tp);

  await progress(65, t('load.sea'));
  tp = performance.now();
  const water = applyWater(scene);
  tp = measure('water', tp);

  // The first playable frame needs only terrain, landmarks, roads and buildings. Parking, trees,
  // street furniture, shop fronts, traffic, quests, audio and the big map stream in after it
  // (see streamWorld below) and add their colliders to this same collision world as they land.
  const colliders = [...city.colliders, ...landmarks.colliders];
  const bounds = city.bounds || { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 };
  const collision = new CollisionWorld(colliders, bounds);
  tp = measure('collision grid', tp);

  await progress(75, t('load.locals'));
  tp = performance.now();
  const am = await tryImport('./characters/avatar.js', 'avatar');
  let makeAvatar = null, archetypeIds = [];
  if (am && am.createAvatar) {
    makeAvatar = am.createAvatar;
    archetypeIds = Object.keys(am.ARCHETYPES || {}).filter((id) => id !== 'player_rishoni');
  }
  let avatar;
  try { avatar = makeAvatar ? makeAvatar('player_rishoni') : null; } catch (e) { console.warn('[main] player avatar failed', e); }
  if (!avatar || !avatar.group) avatar = fallbackAvatar();

  const spawnRaw = city.spawn || { x: 0, z: 0 };
  const spawn = collision.findFree(spawnRaw.x, spawnRaw.z, 1.6);
  const input = createInput(renderer.domElement);
  const player = new Player(scene, avatar, collision, spawn);
  const chase = new ChaseCamera(camera, collision);
  // Walkable surface = bridge decks over terrain; without it everything stays on y = 0.
  const base = typeof city.heightAt === 'function' ? (x, z, y) => city.heightAt(x, z, y)
    : tm?.groundAt ? (x, z) => tm.groundAt(x, z) : null;
  // Raised landmark plazas (dino lawn, squares) sit above the terrain; walk on them, not through them.
  const plaza = lm?.landmarkSurfaceAt;
  const walkGround = base && plaza ? (x, z, y) => { const p = plaza(x, z); const b = base(x, z, y); return p != null && p > b ? p : b; } : base;
  // The airliner's cabin floor and airstairs.
  const surface = walkGround && plane ? (x, z, y) => { const p = plane.surfaceAt(x, z); const b = walkGround(x, z, y); return p != null && p > b ? p : b; } : walkGround;
  if (surface) { player.setSurface?.(surface); chase.setSurface?.(surface); }
  tp = measure('avatars+player', tp);

  const crowd = new Crowd(scene, city.roads,
    makeAvatar && archetypeIds.length ? makeAvatar : (() => { const cols = [0x4caf50, 0x3f8efc, 0xffb347, 0xb36bd6, 0xff6f91]; let i = 0; return () => fallbackAvatar(cols[i++ % cols.length]); })(),
    archetypeIds.length ? archetypeIds : ['fallback'], { city, landmarks, streaming: true });
  crowd.spawnAround(spawn.x, spawn.z);
  tp = measure('crowd', tp);

  const hud = new Hud();

  // Shared ramp, so avatars built above get it too (streamWorld applies it again to what it adds).
  applyToonRamp(scene);

  const waterTris = [];
  for (const m of water.meshes) collectTris(m, waterTris);
  hud.buildMap({ bounds, roads: city.roads, colliders, water: waterTris, pois: landmarks.pois });
  tp = measure('toon ramp+minimap', tp);
  hud.setMode(player.mode);
  player.onModeChange((m) => hud.setMode(m));

  // Filled by streamWorld after the first frame; step() skips whatever is still null.
  let parking = { lots: [], colliders: [] }, trees = { colliders: [], points: [] }, storefronts = { colliders: [] };
  let details = { colliders: [], stats: null, zones: [], pools: [] };
  let traffic = null, quests = null, audio = null, bigmap = null;
  const loaded = { parking: false, details: false, trees: false, dressing: false, storefronts: false, traffic: false, quests: false, audio: false, bigmap: false };

  async function streamWorld() {
    // Draw the first frame (and drop the loading screen) before any streamed work starts.
    await Promise.race([firstDrawn, new Promise((r) => setTimeout(r, 1500))]);
    // One module per idle slot: each is a single long task, so the frames in between keep the
    // game responsive while the rest of the city lands.
    const addColliders = (list) => { for (const c of list || []) collision.addPolygon(c); };
    const stage = async (name, fn) => {
      await idle();
      const t0 = performance.now();
      try { await fn(); } catch (e) { console.warn(`[main] ${name} failed`, e); }
      measure('stream: ' + name, t0);
    };

    // Order matters: trees avoid parking stalls, and street furniture avoids mapped trees.
    // Parking lots: painted stalls that the traffic module fills with parked cars.
    await stage('parking', async () => {
      const pk = await tryImport('./world/parking.js', 'parking');
      if (pk && pk.buildParking) parking = pk.buildParking(scene, city, await pk.loadExtras(), { exclude, colliders: landmarks.colliders }) || parking;
      addColliders(parking.colliders);
      loaded.parking = !!pk;
    });
    // Pools, sealed restricted zones (fence, gate, guard booth, signs) and mapped fences, walls and
    // hedges. Its colliders close every sealed zone, so nobody walks or drives into the base.
    await stage('details', async () => {
      const dtm = await tryImport('./world/details.js', 'details');
      loaded.details = !!dtm;
      if (!dtm?.buildDetails) return;
      details = (await dtm.buildDetails(scene, city, await dtm.loadDetails(), { exclude })) || details;
      addColliders(details.colliders);
      // Pool decks stand above the ground: walk on them instead of through them.
      if (surface && details.surfaceAt) {
        const deckOr = (x, z, y) => { const d = details.surfaceAt(x, z); const b = surface(x, z, y); return d != null && d > b ? d : b; };
        player.setSurface?.(deckOr); chase.setSurface?.(deckOr);
      }
    });
    // Trees from the map only (OSM natural=tree / tree_row / wood / orchard / park groves).
    await stage('trees', async () => {
      const trs = await tryImport('./world/trees.js', 'trees');
      if (trs && trs.buildTrees) trees = (await trs.buildTrees(scene, city, await trs.loadTrees(), { lots: parking.lots, exclude })) || trees;
      addColliders(trees.colliders);
      loaded.trees = !!trs;
    });
    await stage('dressing', async () => {
      const dm = await tryImport('./world/dressing.js', 'dressing');
      if (dm && dm.buildDressing) { const r = await dm.buildDressing(scene, city, { trees }); addColliders(r?.colliders); }
      loaded.dressing = !!dm;
    });
    // Shop signs, showrooms and mall directories from OSM shop nodes.
    await stage('storefronts', async () => {
      const sm = await tryImport('./world/storefronts.js', 'storefronts');
      if (sm && sm.buildStorefronts) storefronts = (await sm.buildStorefronts(scene, city, null)) || storefronts;
      addColliders(storefronts.colliders);
      loaded.storefronts = !!sm;
    });
    // Benches, kiosks, bar seats and their colliders are in: the crowd fills the streets now.
    crowd.worldGrew?.();
    // Parked cars in the painted stalls and on kerbs, plus moving traffic around the player.
    await stage('traffic', async () => {
      const trm = await tryImport('./vehicles/traffic.js', 'traffic');
      if (trm?.createTraffic) traffic = trm.createTraffic({ scene, city, collision, camera, crowd, restrictedAt: details.restrictedAt,
        // Showroom forecourt stalls park like a small surface lot.
        lots: [...(parking.lots || []), ...(storefronts.stalls?.length ? [{ id: 'storefront_forecourts', kind: 'surface', points: [], stalls: storefronts.stalls }] : [])] });
      loaded.traffic = !!trm;
    });
    // Every collider is in now: the minimap shows them all.
    hud.buildMap({ bounds, roads: city.roads, colliders: collision.polys.map((p) => ({ points: p.pts, kind: p.kind })), water: waterTris, pois: landmarks.pois });

    // Quests last among the world parts: their NPCs look for free spots among all colliders.
    await stage('quests', async () => {
      const qm = await tryImport('./engine/quests.js', 'quests');
      loaded.quests = !!qm;
      if (!qm || !qm.QuestSystem) return;
      // The profile's saved progress must be in place before the quest system reads it.
      const prof = await profiles.chosen;
      if (prof.player && !prof.fresh) {
        const at = collision.findFree(prof.player.x, prof.player.z, 1.6);
        player.pos.x = at.x; player.pos.z = at.z;
        if (Number.isFinite(prof.player.heading)) player.heading = prof.player.heading;
        if (prof.player.mode) player.setMode(prof.player.mode);
      }
      profiles.autosave(() => ({ player: { x: player.pos.x, z: player.pos.z, heading: player.heading, mode: player.mode } }));
      try {
        const data = await qm.loadQuests();
        quests = new qm.QuestSystem({ scene, collision, makeAvatar: makeAvatar || (() => fallbackAvatar(0x3f8efc)), pois: landmarks.pois, places: city.places, roads: city.roads, city, surface, spawn, data, hud, reset: params.get('quests') === 'reset' });
        quests.setWorld({ lots: parking.lots || [], shops: storefronts.shops || [], crowd, traffic, restrictedAt: details.restrictedAt });
        quests.minigamesPath = data.minigames;
        quests.setHooks({ onSave: () => profiles.save() }); // every finished step lands in the profile
      } catch (e) { console.warn('[main] quests unavailable', e); quests = null; }
    });

    // Sound: synthesised ambience now, founder's recordings and music when the files exist.
    await stage('audio', async () => {
      const aum = await tryImport('./engine/audio.js', 'audio');
      loaded.audio = !!aum;
      if (!aum?.createAudio) return;
      audio = aum.createAudio({ getPlayer: () => player, city, landmarks, camera, isDialogueOpen: () => !!quests?.blocking,
        onMuteChange: (m) => hud.toastMsg(t(m ? 'hud.soundOff' : 'hud.soundOn')) });
      quests?.setHooks?.({ onDialogueLine: audio.onDialogueLine });
    });

    // Mini-games (rhythm, race, calm ride, photo, parking...) and their story ledger, after audio
    // for the rhythm clock. Optional: index.json names the module once it exists, and missing games
    // play as stubs.
    await stage('minigames', async () => {
      if (!quests?.minigamesPath) return;
      const mgm = await tryImport(quests.minigamesPath, 'minigames');
      if (!mgm?.createMinigames) return;
      await mgm.loadMinigameStrings?.();
      const story = mgm.createStory ? mgm.createStory({ reset: params.get('quests') === 'reset' }) : null;
      quests.setMinigames(mgm.createMinigames({ scene, camera, chase, renderer, sky, player, city, t, hud, audio, traffic, crowd, collision, surface, makeAvatar }), story);
    });

    // Full-screen map (M or minimap click). Optional: the game runs without it.
    await stage('bigmap', async () => {
      const bmm = await tryImport('./engine/bigmap.js', 'bigmap');
      loaded.bigmap = !!bmm;
      if (!bmm || !bmm.createBigMap) return;
      bigmap = bmm.createBigMap({ city, landmarks, scene,
        getPlayer: () => ({ x: player.pos.x, z: player.pos.z, heading: player.heading }),
        getTarget: () => hud.objective?.target || null,
        // Double-click on the map: jump there (the founder inspects places one by one).
        onTeleport: (x, z) => {
          const s = collision.findFree(x, z, 2);
          player.pos.x = s.x; player.pos.z = s.z;
          bigmap?.close();
        } });
      if (bigmap) quests?.setWorld?.({ bigmap }); // map waypoints answer the M15 deduction
    });

    // Toon ramp for everything streamed in, then compile its shaders off the frame where possible.
    applyToonRamp(scene);
    try { await renderer.compileAsync?.(scene, camera); } catch { /* compiles on first draw instead */ }
    bootPerf.streamDone = Math.round(performance.now());
    measure('stream: TOTAL since navigation', 0);
    console.info('[boot] streamed', bootPerf.phases.filter((p) => p.name.startsWith('stream')).map((p) => `${p.name.slice(8)} ${p.ms}ms`).join(' | '));
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (post) post.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  await progress(100, t('load.yalla'));
  const loading = document.getElementById('loading');
  if (loading) { loading.style.opacity = 0; setTimeout(() => loading.remove(), 700); }
  renderer.domElement.focus();

  let firstFrame = true;
  let markDrawn;
  const firstDrawn = new Promise((r) => { markDrawn = r; });
  let usePost = !!post;
  let last = performance.now(), time = 0;
  const stats = { frames: 0, fps: 0 };
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    step(dt, true);
    requestAnimationFrame(frame);
  }
  // One simulation step. Exposed as __game.tick so automated playtests can advance the game
  // when the tab is hidden and rAF is paused; `draw` is skipped there to keep ticks cheap.
  function step(dt, draw) {
    time += dt;
    if (input.wasPressed('KeyP') && post) usePost = !usePost;

    // While a dialogue is open the player stands still; the camera can still be dragged.
    const mapOpen = !!(bigmap && bigmap.isOpen);
    // Esc opens the pause menu only when nothing else is using it (dialogue, map, mini-game).
    profiles.pausable = !(quests && quests.blocking) && !mapOpen && !(quests && quests.minigames && quests.minigames.active);
    player.update(dt, (quests && quests.blocking) || mapOpen || profiles.open ? FROZEN : input, chase.yaw);
    if (quests) { try { quests.update(dt, player, input); } catch (e) { console.error('[main] quests.update failed', e); quests = null; } }
    if (traffic) { try { traffic.update(dt, player); } catch (e) { console.warn('[main] traffic.update failed', e); traffic = null; } }
    chase.update(dt, player.root.position, player.heading, player.speed, player.mode, input);
    sky.update(dt, player.root.position, camera);
    water.update(time);
    crowd.update(dt, player.pos.x, player.pos.z);
    if (plane) plane.update(player.pos);
    if (updateLandmarks) { try { updateLandmarks(dt); } catch (e) { console.warn('[main] updateLandmarks failed', e); updateLandmarks = null; } }
    hud.update(dt, player, chase.yaw);
    if (bigmap) bigmap.update(dt);
    if (audio) { try { audio.update(dt); } catch (e) { console.warn('[main] audio.update failed', e); audio = null; } }
    input.endFrame();

    if (draw) {
      const tf = firstFrame ? performance.now() : 0;
      if (usePost) post.render();
      else { renderer.shadowMap.needsUpdate = true; renderer.render(scene, camera); }
      if (firstFrame) {
        firstFrame = false;
        measure('first render (shader compile)', tf);
        measure('TOTAL since navigation', 0);
        bootPerf.ready = true;
        markDrawn();
        console.info('[boot]', bootPerf.phases.map((p) => `${p.name} ${p.ms}ms`).join(' | '));
      }
    }
    stats.frames++;
    stats.fps = hud.fpsValue;
  }
  requestAnimationFrame(frame);

  // `streamed` resolves once parking, trees, furniture, shops, traffic, quests, audio and the big
  // map are in (tools and playtests await it before reading __game.quests).
  const streamed = streamWorld();
  window.__game = { THREE, scene, camera, renderer, player, chase, input, crowd, hud, collision, city, landmarks, water, stats, sky, post, profiles,
    get quests() { return quests; }, get bigmap() { return bigmap; }, get audio() { return audio; }, get traffic() { return traffic; },
    get storefronts() { return storefronts; }, get details() { return details; }, streamed,
    tick: (dt = 1 / 60, draw = false) => step(dt, draw),
    modules: { landmarks: !!lm, city: !!cm, avatar: !!am, get dressing() { return loaded.dressing; }, get quests() { return loaded.quests; }, get traffic() { return loaded.traffic; } } };
}

// Resolves in an idle slot (or after 120 ms at most, and on a timer in hidden tabs, where idle
// callbacks and rAF stall), so streamed work never waits on a busy frame for long.
function idle() {
  return new Promise((r) => {
    if (typeof requestIdleCallback === 'function' && !document.hidden) requestIdleCallback(() => r(), { timeout: 120 });
    else setTimeout(r, 0);
  });
}

function collectTris(mesh, out) {
  const geo = mesh.geometry, pos = geo.attributes.position;
  if (!pos) return;
  mesh.updateWorldMatrix(true, false);
  const v = new THREE.Vector3();
  const idx = geo.index ? geo.index.array : null;
  const n = idx ? idx.length : pos.count;
  for (let i = 0; i + 2 < n; i += 3) {
    const tri = [];
    for (let k = 0; k < 3; k++) { v.fromBufferAttribute(pos, idx ? idx[i + k] : i + k).applyMatrix4(mesh.matrixWorld); tri.push(v.x, v.z); }
    out.push(tri);
  }
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

boot().catch((e) => {
  console.error('[main] boot failed', e);
  const msg = document.getElementById('loading-msg');
  if (msg) msg.textContent = t('load.failed');
});
