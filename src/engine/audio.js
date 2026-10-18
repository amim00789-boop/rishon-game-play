// Game audio on plain WebAudio: synthesised zone ambience that follows the player, motion sounds
// for each travel mode, founder-supplied music and recorded voices. Nothing here needs an audio
// file to work; recorded material is picked up from data/audio/ when it exists.
//
// Browsers keep an AudioContext silent until a user gesture, so the context is only created on
// the first key, click or touch. Until then every method is a cheap no-op.
import { SCALE } from '../geo.js';

const AUDIO_BASE = new URL('../../data/audio/', import.meta.url);
const CITY_DATA = new URL('../../data/rishon.json', import.meta.url);
const SAVE_KEY = 'rishon.audio.v1';
const ZONE_HZ = 5;            // zone weights are recomputed this often; layer gains glide between
const CROSSFADE_TC = 0.9;     // seconds, time constant of the ambience crossfade
const MUSIC_ZONE_HOLD = 5;    // seconds a new dominant zone must last before the music follows
const VOICE_EXTS = ['ogg', 'mp3', 'wav'];

const DEFAULTS = { master: 0.8, music: 0.55, sfx: 0.8, voice: 1, muted: false, musicOn: true };

// Crowd murmur sources: landmark POIs that draw people, with a 0..1 weight.
const CROWD_POIS = {
  golden_mall: 1, superland: 1, cinema_city: 0.85, yes_planet: 0.85, founders_square: 0.9,
  station_moshe_dayan: 0.7, station_harishonim: 0.7, beach_kiosk: 0.65, matkot_spot: 0.55,
  beach_lifeguards: 0.45, great_synagogue: 0.4, camel_cellars: 0.45, welcome_sign: 0.2, water_tower: 0.3,
};
const BEACH_POIS = ['beach_kiosk', 'beach_lifeguards', 'matkot_spot'];
const PARK_POIS = { dino_park: 0.8, superland_lake: 0.9 };
// Traffic hum by OSM road rank (city.js): motorway 9, trunk 8, primary 7, secondary 6.
const ROAD_WEIGHT = { 9: 1, 8: 0.9, 7: 0.8, 6: 0.6 };

// Dialogue line key to the voice file name: 'q1_speaker.d.offer.0' (what quests.js passes) or
// 'd.offer.0' both become 'q1_speaker.offer.01', 1-based and zero-padded so files sort in script
// order. tools/make_voice_script.mjs imports this function, so the script and the game agree.
export function voiceKey(questId, lineKey) {
  const parts = String(lineKey).split('.').filter(Boolean);
  if (parts[0] === questId) parts.shift();
  if (parts[0] === 'd') parts.shift();
  let idx = '';
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) idx = '.' + String(Number(parts.pop()) + 1).padStart(2, '0');
  return `${questId}.${parts.join('.')}${idx}`;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// 1 inside `near`, 0 beyond `far`, smooth in between.
function fall(d, near, far) {
  if (d <= near) return 1;
  if (d >= far) return 0;
  const t = 1 - (d - near) / (far - near);
  return t * t * (3 - 2 * t);
}
const rand = Math.random;

function loadSettings() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SAVE_KEY) || 'null') || {}) }; } catch (_) { return { ...DEFAULTS }; }
}

// ---------- geometry helpers ----------
function nearestOnPoly(px, pz, pts, closed) {
  let best = Infinity, bx = px, bz = pz;
  const n = pts.length, last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const vx = b[0] - a[0], vz = b[1] - a[1], l2 = vx * vx + vz * vz;
    let t = l2 > 0 ? ((px - a[0]) * vx + (pz - a[1]) * vz) / l2 : 0;
    t = clamp(t, 0, 1);
    const cx = a[0] + vx * t, cz = a[1] + vz * t, d = (cx - px) ** 2 + (cz - pz) ** 2;
    if (d < best) { best = d; bx = cx; bz = cz; }
  }
  return { d: Math.sqrt(best), x: bx, z: bz };
}

function inPoly(px, pz, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function polyInfo(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x, z] = pts[i];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    area += (pts[j][0] + x) * (pts[j][1] - z);
  }
  return { pts, minX, maxX, minZ, maxZ, area: Math.abs(area) / 2 };
}

const pairs = (flat) => { const out = []; for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

// ---------- the module ----------
export function createAudio({ getPlayer, city = null, landmarks = null, camera = null, isDialogueOpen = null, onMuteChange = null, muteKey = 'KeyN' } = {}) {
  const settings = loadSettings();
  const params = new URLSearchParams(location.search);
  const probeVoices = params.get('voiceprobe') === '1';
  let ctx = null, unsupported = false, disposed = false;
  let master, limiter, buses, ambBus, ambFilter, duckMusic, duckAmb, motionBus;
  let noise = null;
  let L = null;                 // ambience layers
  let V = null;                 // motion (vehicle / footstep) layers
  let manifest = null;          // { voice: [], barks: [], music: [] } from data/audio/manifest.json
  let manifestTried = false;
  const voiceUrl = new Map();   // key -> url | null (probe cache)
  const buffers = new Map();    // url -> Promise<AudioBuffer|null>
  let voice = null, voiceToken = 0, dialogueHold = 0, lastSpeaker = null;
  const bark = { last: {}, lastAny: 0, lastFile: {} };
  const music = { tracks: [], current: null, zone: null, pending: null, pendingSince: 0, ready: false };

  const zones = { beach: 0, traffic: 0, crowd: 0, park: 0, seaM: Infinity, roadM: Infinity, roadRank: 0, onSand: false, dominant: 'city' };
  const srcDir = { sea: null, traffic: null, crowd: null };
  let zoneT = 0;
  let roadGrid = null;
  let parks = [];
  let parksState = 'none';
  const seaPolys = [];
  const timers = { wave: 0, gull: 0, bird: 0, passby: 0, babble: 0, step: 0, clack: 0, tick: 0 };
  let lastGround = true;

  // Sea colliders from the city (kind 'sea'); beach POIs cover a world without them.
  for (const c of (city && city.colliders) || []) if (c && c.kind === 'sea' && c.points && c.points.length > 2) seaPolys.push(c.points);
  const poiById = {};
  for (const p of (landmarks && landmarks.pois) || []) poiById[p.id] = p;

  // ---------- unlock ----------
  const gestureEvents = ['keydown', 'pointerdown', 'touchstart'];
  const onGesture = () => unlock();
  for (const ev of gestureEvents) window.addEventListener(ev, onGesture, { capture: true, passive: true });

  const onKey = (e) => {
    if (e.code !== muteKey || e.repeat) return;
    const tg = e.target;
    if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || ''))) return;
    setMuted(!settings.muted);
  };
  window.addEventListener('keydown', onKey);

  // Hidden tabs keep an AudioContext rendering; suspend it to save the battery.
  const onVis = () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  };
  document.addEventListener('visibilitychange', onVis);

  function unlock() {
    if (disposed || unsupported) return false;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { unsupported = true; console.warn('[audio] WebAudio unavailable; running silent.'); return false; }
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { unsupported = true; console.warn('[audio] AudioContext failed', e); return false; }
      build();
      for (const ev of gestureEvents) window.removeEventListener(ev, onGesture, { capture: true });
      loadManifest().then(loadMusic);
      setTimeout(loadParks, 1500); // after the first frames, so the parse does not hitch the start
    }
    if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {});
    return true;
  }

  // ---------- graph ----------
  const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const F = (type, freq, q = 0.707) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; };
  const P = (dest) => { const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null; if (p) { p.connect(dest); return p; } const g = G(); g.connect(dest); g.pan = { value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }; return g; };
  const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };
  // Only a changed target is scheduled: called every frame, an unchanged one would pile up
  // automation events for nothing.
  const lastTarget = new WeakMap();
  const glide = (param, v, tc = CROSSFADE_TC) => {
    const p = lastTarget.get(param);
    if (p !== undefined && Math.abs(p - v) < 1e-4) return;
    lastTarget.set(param, v);
    param.setTargetAtTime(v, ctx.currentTime, tc);
  };

  // Looping noise needs a seamless loop point: the tail is crossfaded into the head.
  function makeNoise(kind, seconds = 4) {
    const sr = ctx.sampleRate, fade = Math.floor(sr * 0.05), n = Math.floor(sr * seconds) + fade;
    const raw = new Float32Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      if (kind === 'white') raw[i] = w * 0.5;
      else if (kind === 'pink') { // Paul Kellet's pink filter
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else { last = (last + 0.02 * w) / 1.02; raw[i] = last * 3.5; }
    }
    const len = n - fade, buf = ctx.createBuffer(1, len, sr), out = buf.getChannelData(0);
    for (let i = 0; i < len; i++) out[i] = raw[i];
    for (let i = 0; i < fade; i++) { const k = i / fade; out[i] = raw[i] * k + raw[len + i] * (1 - k); }
    return buf;
  }

  function loopNoise(kind) {
    const s = ctx.createBufferSource();
    s.buffer = noise[kind]; s.loop = true;
    s.start(0, rand() * s.buffer.duration);
    return s;
  }

  function build() {
    master = G(settings.muted ? 0 : settings.master);
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4; limiter.knee.value = 2; limiter.ratio.value = 16;
    limiter.attack.value = 0.003; limiter.release.value = 0.25;
    chain(master, limiter, ctx.destination);
    duckMusic = G(1); duckAmb = G(1);
    buses = { music: G(settings.musicOn ? settings.music : 0), sfx: G(settings.sfx), voice: G(settings.voice) };
    chain(buses.music, duckMusic, master);
    buses.sfx.connect(master);
    buses.voice.connect(master);
    ambBus = G(1);
    ambFilter = F('lowpass', 18000, 0.5); // closes while driving: the car cabin muffles the street
    chain(ambBus, ambFilter, duckAmb, buses.sfx);
    motionBus = G(1);
    motionBus.connect(buses.sfx);

    noise = { white: makeNoise('white'), pink: makeNoise('pink'), brown: makeNoise('brown') };

    // City bed: a faint constant air so the world is never digitally silent.
    const bed = G(0.05);
    chain(loopNoise('pink'), F('lowpass', 900), bed, ambBus);

    // Sea: low brown-noise body that swells per wave, plus a brighter wash trailing each crest.
    const sea = { out: G(0) };
    sea.pan = P(ambBus); sea.out.connect(sea.pan);
    sea.swell = G(0.3); sea.wash = G(0.05);
    chain(loopNoise('brown'), F('lowpass', 620), sea.swell, sea.out);
    chain(loopNoise('pink'), F('bandpass', 2300, 0.6), sea.wash, sea.out);

    // Traffic: engine rumble plus tyre hiss; individual pass-bys are one-shots.
    const traffic = { out: G(0) };
    traffic.pan = P(ambBus); traffic.out.connect(traffic.pan);
    chain(loopNoise('brown'), F('lowpass', 170), G(1.1), traffic.out);
    chain(loopNoise('pink'), F('bandpass', 750, 0.8), G(0.28), traffic.out);

    // Crowd: speech-band noise whose bands flutter at syllable rate reads as distant chatter.
    const crowd = { out: G(0), bands: [] };
    crowd.pan = P(ambBus); crowd.out.connect(crowd.pan);
    const babble = loopNoise('pink');
    for (const [f, q] of [[380, 3], [950, 4], [1900, 5], [2900, 6]]) {
      const g = G(0.3);
      chain(babble, F('bandpass', f, q), g, crowd.out);
      crowd.bands.push(g);
    }
    chain(loopNoise('pink'), F('bandpass', 650, 0.7), G(0.12), crowd.out);

    L = { bed, sea, traffic, crowd, park: { level: 0 } };

    // Motion layers: rolling wheels, car engine, tyres and wind. Footsteps and clicks are one-shots.
    const roll = { g: G(0), f: F('bandpass', 400, 1.6) };
    chain(loopNoise('pink'), roll.f, roll.g, motionBus);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    const engine = { g: G(0), lp: F('lowpass', 500, 1.2), o1: ctx.createOscillator(), o2: ctx.createOscillator() };
    engine.o1.type = 'sawtooth'; engine.o2.type = 'square';
    engine.o1.frequency.value = 34; engine.o2.frequency.value = 17;
    const o2g = G(0.5);
    engine.o1.connect(shaper); chain(engine.o2, o2g, shaper);
    chain(shaper, engine.lp, engine.g, motionBus);
    engine.o1.start(); engine.o2.start();
    const tyre = { g: G(0) };
    chain(loopNoise('brown'), F('lowpass', 320), tyre.g, motionBus);
    const wind = { g: G(0) };
    chain(loopNoise('pink'), F('highpass', 380), wind.g, motionBus);
    V = { roll, engine, tyre, wind };
  }

  // ---------- data ----------
  async function loadManifest() {
    if (manifestTried) return;
    manifestTried = true;
    try {
      const r = await fetch(new URL('manifest.json', AUDIO_BASE), { cache: 'no-cache' });
      if (r.ok) {
        const m = await r.json();
        manifest = { voice: new Set(m.voice || []), barks: m.barks || [], music: new Set(m.music || []) };
      }
    } catch (_) { /* no manifest: voices are probed on demand */ }
  }

  async function loadMusic() {
    let list = null;
    try {
      const r = await fetch(new URL('music/index.json', AUDIO_BASE), { cache: 'no-cache' });
      if (r.ok) list = await r.json();
    } catch (_) { list = null; }
    music.tracks = Array.isArray(list) ? list.filter((t) => t && typeof t.file === 'string') : [];
    music.ready = true;
    if (music.tracks.length) pickMusic(true);
  }

  // Parks are not exposed by buildCity, so their polygons come from the map data it already loads.
  async function loadParks() {
    if (parksState !== 'none' || disposed) return;
    parksState = 'loading';
    const add = (pts) => { if (pts && pts.length >= 3) parks.push(polyInfo(pts)); };
    try {
      if (city && Array.isArray(city.parks)) {
        for (const p of city.parks) add(Array.isArray(p) ? (Array.isArray(p[1]) ? pairs(p[1]) : p) : p.points);
      } else {
        const r = await fetch(CITY_DATA);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        const k = d.meta && d.meta.scale ? SCALE / d.meta.scale : 1;
        const scaled = (flat) => pairs(flat.map((v) => v * k));
        for (const p of d.parks || []) add(scaled(p[1]));
        for (const w of d.woods || []) add(scaled(w));
      }
      parksState = 'ready';
    } catch (e) {
      parksState = 'failed';
      console.warn('[audio] park outlines unavailable; birds only at park landmarks.', e.message || e);
    }
  }

  function buildRoadGrid() {
    const CELL = 120;
    const cells = new Map();
    const key = (cx, cz) => cx * 100003 + cz;
    for (const r of (city && city.roads) || []) {
      const w = ROAD_WEIGHT[r.rank];
      if (!w || r.tunnel || !r.points || r.points.length < 2) continue;
      const p = r.points;
      for (let i = 0; i < p.length - 1; i++) {
        const seg = { ax: p[i][0], az: p[i][1], bx: p[i + 1][0], bz: p[i + 1][1], w, rank: r.rank };
        const x0 = Math.floor(Math.min(seg.ax, seg.bx) / CELL), x1 = Math.floor(Math.max(seg.ax, seg.bx) / CELL);
        const z0 = Math.floor(Math.min(seg.az, seg.bz) / CELL), z1 = Math.floor(Math.max(seg.az, seg.bz) / CELL);
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(seg);
        }
      }
    }
    return { CELL, cells, key };
  }

  // ---------- zones ----------
  const M = (u) => u / SCALE; // world units -> metres

  function computeZones(px, pz) {
    // Beach: distance to the sea outline, or to the beach POIs when the city has no sea.
    let seaD = Infinity, seaPt = null;
    for (const poly of seaPolys) {
      if (inPoly(px, pz, poly)) { seaD = 0; seaPt = null; break; }
      const n = nearestOnPoly(px, pz, poly, true);
      if (n.d < seaD) { seaD = n.d; seaPt = n; }
    }
    let seaM = M(seaD);
    for (const id of BEACH_POIS) {
      const p = poiById[id];
      if (!p) continue;
      const d = M(Math.hypot(p.x - px, p.z - pz)) + 60; // a POI sits on the sand, ~60 m from the water
      if (d < seaM) { seaM = d; seaPt = { x: p.x, z: p.z }; }
    }
    zones.seaM = seaM;
    zones.beach = fall(seaM, 45, 380);
    zones.onSand = seaM < 90;
    srcDir.sea = seaPt;

    // Traffic: loudest weighted big road nearby.
    if (!roadGrid) roadGrid = buildRoadGrid();
    let best = 0, bestM = Infinity, bestRank = 0, roadPt = null;
    const { CELL, cells, key } = roadGrid;
    const R = Math.ceil((170 * SCALE) / CELL), cx0 = Math.floor(px / CELL), cz0 = Math.floor(pz / CELL);
    for (let cx = cx0 - R; cx <= cx0 + R; cx++) for (let cz = cz0 - R; cz <= cz0 + R; cz++) {
      const list = cells.get(key(cx, cz));
      if (!list) continue;
      for (const s of list) {
        const n = nearestOnPoly(px, pz, [[s.ax, s.az], [s.bx, s.bz]], false);
        const dm = M(n.d), c = s.w * fall(dm, 14, 170);
        if (dm < bestM) { bestM = dm; bestRank = s.rank; }
        if (c > best) { best = c; roadPt = n; }
      }
    }
    zones.traffic = best; zones.roadM = bestM; zones.roadRank = bestRank;
    srcDir.traffic = roadPt;

    // Crowd: malls, cinemas, squares and stations.
    let crowd = 0, crowdPt = null;
    for (const p of Object.values(poiById)) {
      const w = CROWD_POIS[p.id];
      if (!w) continue;
      const c = w * fall(M(Math.hypot(p.x - px, p.z - pz)), 35, 200);
      if (c > crowd) { crowd = c; crowdPt = p; }
    }
    zones.crowd = crowd;
    srcDir.crowd = crowdPt;

    // Parks: inside an outline (bigger park, more birds) or near one; plus park landmarks.
    let park = 0;
    const margin = 80 * SCALE;
    for (const pk of parks) {
      if (px < pk.minX - margin || px > pk.maxX + margin || pz < pk.minZ - margin || pz > pk.maxZ + margin) continue;
      const size = clamp(Math.sqrt(M(M(pk.area))) / 110, 0.4, 1);
      const c = inPoly(px, pz, pk.pts) ? size : size * fall(M(nearestOnPoly(px, pz, pk.pts, true).d), 0, 70);
      if (c > park) park = c;
    }
    for (const [id, w] of Object.entries(PARK_POIS)) {
      const p = poiById[id];
      if (p) park = Math.max(park, w * fall(M(Math.hypot(p.x - px, p.z - pz)), 50, 180));
    }
    zones.park = park;

    const ranked = [['beach', zones.beach], ['road', zones.traffic], ['crowd', zones.crowd], ['park', zones.park]].sort((a, b) => b[1] - a[1]);
    zones.dominant = ranked[0][1] >= 0.35 ? ranked[0][0] : 'city';
  }

  // Stereo position of a source from the camera's right vector, kept partial so nothing hard-pans.
  function panFor(pt, px, pz) {
    if (!pt || !camera || !camera.matrixWorld) return 0;
    const dx = pt.x - px, dz = pt.z - pz, l = Math.hypot(dx, dz);
    if (l < 1e-3) return 0;
    const e = camera.matrixWorld.elements, rl = Math.hypot(e[0], e[2]) || 1;
    return clamp(((dx / l) * e[0] + (dz / l) * e[2]) / rl, -1, 1) * 0.65;
  }

  // ---------- one-shots ----------
  function oneShotNoise(kind, t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noise[kind];
    s.start(t, rand() * (s.buffer.duration - dur - 0.05), dur);
    return s;
  }

  function gullCall(t, level, pan) {
    const calls = 2 + Math.floor(rand() * 3);
    const o = ctx.createOscillator(), g = G(0), p = P(ambBus);
    o.type = 'sawtooth';
    p.pan.value = pan;
    chain(o, F('bandpass', 1700 + rand() * 400, 3.5), g, p);
    const base = 1150 + rand() * 300;
    let t0 = t;
    for (let k = 0; k < calls; k++) {
      o.frequency.setValueAtTime(base, t0);
      o.frequency.linearRampToValueAtTime(base * 1.75, t0 + 0.05);
      o.frequency.exponentialRampToValueAtTime(base * 0.85, t0 + 0.22);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(level, t0 + 0.025);
      g.gain.setTargetAtTime(0, t0 + 0.13, 0.04);
      t0 += 0.26 + rand() * 0.12;
    }
    o.start(t); o.stop(t0 + 0.3);
  }

  function birdSong(t, level, pan) {
    const notes = 3 + Math.floor(rand() * 5);
    const o = ctx.createOscillator(), g = G(0), p = P(ambBus);
    o.type = 'sine';
    p.pan.value = pan;
    chain(o, g, p);
    const base = 2600 + rand() * 2000;
    let t0 = t;
    for (let k = 0; k < notes; k++) {
      const d = 0.05 + rand() * 0.07, up = rand() < 0.5;
      o.frequency.setValueAtTime(base * (up ? 0.85 : 1.25), t0);
      o.frequency.exponentialRampToValueAtTime(base * (up ? 1.3 : 0.8), t0 + d);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(level, t0 + 0.012);
      g.gain.setTargetAtTime(0, t0 + d * 0.7, 0.015);
      t0 += d + 0.03 + rand() * 0.06;
    }
    o.start(t); o.stop(t0 + 0.2);
  }

  function passBy(t, level, pan) {
    const dur = 2.6 + rand() * 1.4;
    const s = oneShotNoise('white', t, dur), f = F('bandpass', 380, 1.4), g = G(0), p = P(ambBus);
    chain(s, f, F('lowpass', 1600), g, p);
    const dirn = rand() < 0.5 ? -1 : 1;
    p.pan.setValueAtTime(clamp(pan - 0.6 * dirn, -1, 1), t);
    p.pan.linearRampToValueAtTime(clamp(pan + 0.6 * dirn, -1, 1), t + dur);
    f.frequency.setValueAtTime(420, t);
    f.frequency.linearRampToValueAtTime(900, t + dur * 0.45); // approaching: brighter, then the doppler drop
    f.frequency.linearRampToValueAtTime(330, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(0, t + dur);
  }

  function footstep(t, sand, intensity) {
    const s = oneShotNoise('white', t, 0.2), g = G(0);
    chain(s, F('bandpass', sand ? 520 + rand() * 120 : 1150 + rand() * 350, sand ? 0.7 : 1.3), g, motionBus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32 * intensity, t + (sand ? 0.02 : 0.004));
    g.gain.setTargetAtTime(0, t + 0.012, sand ? 0.05 : 0.022);
    if (!sand) { // heel thump
      const o = ctx.createOscillator(), og = G(0);
      o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.06);
      chain(o, og, motionBus);
      og.gain.setValueAtTime(0.35 * intensity, t); og.gain.setTargetAtTime(0, t + 0.01, 0.025);
      o.start(t); o.stop(t + 0.12);
    }
  }

  function click(t, freq, level, len = 0.012) {
    const s = oneShotNoise('white', t, len + 0.02), g = G(0);
    chain(s, F('highpass', freq), g, motionBus);
    g.gain.setValueAtTime(level, t);
    g.gain.setTargetAtTime(0, t + len * 0.3, len * 0.4);
  }

  // ---------- per frame ----------
  function update(dt) {
    if (!ctx || disposed || ctx.state !== 'running') return;
    const pl = getPlayer && getPlayer();
    if (!pl) return;
    const pos = pl.pos || (pl.position ? { x: pl.position.x, z: pl.position.z } : null);
    if (!pos) return;
    const now = ctx.currentTime;

    zoneT -= dt;
    if (zoneT <= 0) {
      zoneT = 1 / ZONE_HZ;
      computeZones(pos.x, pos.z);
      glide(L.sea.out.gain, zones.beach * 0.6);
      glide(L.traffic.out.gain, zones.traffic * 0.5);
      glide(L.crowd.out.gain, zones.crowd * 0.42);
      glide(L.bed.gain, 0.05 * (1 - 0.6 * Math.max(zones.beach, zones.traffic)));
      L.park.level += (zones.park - L.park.level) * 0.5;
      glide(L.sea.pan.pan, panFor(srcDir.sea, pos.x, pos.z), 0.3);
      glide(L.traffic.pan.pan, panFor(srcDir.traffic, pos.x, pos.z), 0.3);
      glide(L.crowd.pan.pan, panFor(srcDir.crowd, pos.x, pos.z), 0.3);
      if (music.tracks.length) followZone(now);
    }

    // Waves: a new crest every 5-10 s.
    if (zones.beach > 0.02 && now >= timers.wave) {
      const peak = 0.75 + rand() * 0.5;
      L.sea.swell.gain.setTargetAtTime(peak, now, 0.9);
      L.sea.swell.gain.setTargetAtTime(0.22, now + 2.3, 1.5);
      L.sea.wash.gain.setTargetAtTime(0.35 * peak, now + 1.4, 0.35);
      L.sea.wash.gain.setTargetAtTime(0.05, now + 2.6, 1.1);
      timers.wave = now + 5 + rand() * 5;
    }
    if (zones.beach > 0.25 && now >= timers.gull) {
      if (rand() < 0.7) gullCall(now + 0.05, 0.05 * zones.beach, rand() * 1.4 - 0.7);
      timers.gull = now + 3 + rand() * 7;
    }
    if (zones.traffic > 0.3 && now >= timers.passby) {
      passBy(now + 0.05, 0.28 * zones.traffic, panFor(srcDir.traffic, pos.x, pos.z));
      timers.passby = now + (1.5 + rand() * 4) / zones.traffic;
    }
    if (zones.crowd > 0.02 && now >= timers.babble) {
      for (const g of L.crowd.bands) g.gain.setTargetAtTime(0.1 + rand() * rand() * 0.9, now, 0.035);
      timers.babble = now + 0.08 + rand() * 0.09;
    }
    if (L.park.level > 0.15 && now >= timers.bird) {
      birdSong(now + 0.05, 0.035 * L.park.level, rand() * 1.6 - 0.8);
      timers.bird = now + (0.6 + rand() * 2.8) / L.park.level;
    }

    updateMotion(pl, now);

    // Dialogue ducking: music and ambience dip under a voice or an open dialogue box.
    const talking = (voice && voice.playing) || now < dialogueHold || (isDialogueOpen && safeBool(isDialogueOpen));
    glide(duckMusic.gain, talking ? 0.28 : 1, talking ? 0.12 : 0.6);
    glide(duckAmb.gain, talking ? 0.6 : 1, talking ? 0.12 : 0.6);
    glide(ambFilter.frequency, pl.mode === 'car' ? 2200 : 18000, 0.25);
  }

  function safeBool(fn) { try { return !!fn(); } catch (_) { return false; } }

  function updateMotion(pl, now) {
    const mode = pl.mode || 'walk';
    const sp = Math.abs(pl.speed || 0);
    const ground = pl.onGround !== false;
    const { roll, engine, tyre, wind } = V;

    // Footsteps: cadence rises with speed, sand is soft and hissy.
    if (mode === 'walk' && ground && sp > 0.6) {
      const rate = clamp(0.9 + sp * 0.16, 1.4, 3.8);
      if (timers.step < now) timers.step = now + 0.02;
      while (timers.step < now + 0.1) {
        footstep(timers.step, zones.onSand, clamp(0.45 + sp / 30, 0.45, 1));
        timers.step += 1 / rate;
      }
    } else timers.step = 0;
    if (ground && !lastGround) footstep(now + 0.01, zones.onSand, 1.2); // landing
    lastGround = ground;

    // Wheels: scooter roll is gritty and low, the bike a finer whirr with freewheel ticks.
    const wheels = (mode === 'scooter' || mode === 'bike') && ground;
    const top = mode === 'scooter' ? 26 : 36;
    glide(roll.g.gain, wheels ? clamp(sp / top, 0, 1) * (mode === 'scooter' ? 0.42 : 0.25) : 0, 0.08);
    glide(roll.f.frequency, (mode === 'scooter' ? 260 : 520) + sp * (mode === 'scooter' ? 24 : 30), 0.08);
    if (wheels && sp > 2) {
      if (mode === 'scooter') {
        if (timers.clack < now) timers.clack = now + 0.05;
        while (timers.clack < now + 0.1) { click(timers.clack, 1800, 0.07 * clamp(sp / top, 0.3, 1), 0.018); timers.clack += clamp(5.5 / sp, 0.18, 1.2) * (0.7 + rand() * 0.6); }
      } else {
        if (timers.tick < now) timers.tick = now + 0.02;
        while (timers.tick < now + 0.1) { click(timers.tick, 4200, 0.03, 0.006); timers.tick += 1 / clamp(sp * 0.9, 4, 28); }
      }
    } else { timers.clack = 0; timers.tick = 0; }

    // Car: idle burble, revs climbing through four gears, tyre roar with speed.
    if (mode === 'car') {
      const gears = [0, 14, 28, 44, 62, 90];
      let gi = 0;
      while (gi < gears.length - 2 && sp > gears[gi + 1]) gi++;
      const within = clamp((sp - gears[gi]) / (gears[gi + 1] - gears[gi]), 0, 1);
      const f0 = sp < 0.5 ? 33 + Math.sin(now * 7) * 0.8 : 40 + within * 52 + gi * 5;
      glide(engine.o1.frequency, Math.round(f0 * 4) / 4, 0.06);
      glide(engine.o2.frequency, Math.round(f0 * 2) / 4, 0.06);
      glide(engine.lp.frequency, 380 + within * 900 + gi * 80, 0.08);
      glide(engine.g.gain, 0.13 + within * 0.1, 0.1);
      glide(tyre.g.gain, clamp(sp / 70, 0, 1) * 0.35, 0.15);
    } else {
      glide(engine.g.gain, 0, 0.15);
      glide(tyre.g.gain, 0, 0.15);
    }

    // Wind past the ears grows with the square of speed; walking barely registers.
    const wv = mode === 'walk' ? 0 : clamp(sp / 70, 0, 1) ** 2 * (mode === 'car' ? 0.12 : 0.3);
    glide(wind.g.gain, wv, 0.2);
  }

  // ---------- music ----------
  function trackUrl(t) {
    const probe = document.createElement('audio');
    const ogg = /\.ogg$/i.test(t.file) && !probe.canPlayType('audio/ogg; codecs="vorbis"') && !probe.canPlayType('audio/ogg; codecs="opus"');
    return new URL('music/' + (ogg && t.fallback ? t.fallback : t.file), AUDIO_BASE).href;
  }

  function poolFor(zone) {
    const z = music.tracks.filter((t) => t.zone === zone);
    return z.length ? z : music.tracks.filter((t) => !t.zone);
  }

  function followZone(now) {
    if (zones.dominant !== music.pending) { music.pending = zones.dominant; music.pendingSince = now; }
    if (music.pending !== music.zone && now - music.pendingSince >= MUSIC_ZONE_HOLD) {
      const pool = poolFor(music.pending);
      music.zone = music.pending;
      // Stay on the current track if it also belongs to the new zone's pool.
      if (!music.current || !pool.includes(music.current.entry)) pickMusic(false);
    }
  }

  function pickMusic(first) {
    if (first) music.zone = zones.dominant;
    const pool = poolFor(music.zone);
    if (!pool.length) { stopMusic(); return; }
    const choices = pool.length > 1 && music.current ? pool.filter((t) => t !== music.current.entry) : pool;
    playTrack(choices[Math.floor(rand() * choices.length)]);
  }

  function stopMusic(fade = 2.5) {
    const c = music.current;
    music.current = null;
    if (!c) return;
    c.g.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
    setTimeout(() => { try { c.stop(); } catch (_) { /* already stopped */ } }, fade * 1000 + 200);
  }

  // Tracks with loopStart/loopEnd are decoded for a sample-exact loop; the rest stream through an
  // <audio> element, which keeps a long track out of memory.
  async function playTrack(entry) {
    stopMusic();
    const g = G(0);
    g.connect(buses.music);
    const level = typeof entry.gain === 'number' ? entry.gain : 1;
    const loop = entry.loop !== false;
    const cur = { entry, g, stop: () => {} };
    music.current = cur;
    const url = trackUrl(entry);
    try {
      if (typeof entry.loopStart === 'number' || typeof entry.loopEnd === 'number') {
        const buf = await loadBuffer(url);
        if (!buf || music.current !== cur) return;
        const s = ctx.createBufferSource();
        s.buffer = buf; s.loop = loop;
        if (typeof entry.loopStart === 'number') s.loopStart = entry.loopStart;
        s.loopEnd = typeof entry.loopEnd === 'number' ? entry.loopEnd : buf.duration;
        s.connect(g);
        s.onended = () => { if (music.current === cur) pickMusic(false); };
        s.start();
        cur.stop = () => s.stop();
      } else {
        const el = new Audio();
        el.src = url; el.loop = loop; el.preload = 'auto';
        ctx.createMediaElementSource(el).connect(g);
        el.addEventListener('ended', () => { if (music.current === cur) pickMusic(false); });
        el.addEventListener('error', () => { console.warn('[audio] music track failed to load:', entry.file); if (music.current === cur) music.current = null; });
        await el.play();
        cur.stop = () => { el.pause(); el.removeAttribute('src'); el.load(); };
      }
      g.gain.setTargetAtTime(level, ctx.currentTime, 1);
    } catch (e) {
      console.warn('[audio] music track failed:', entry.file, e.message || e);
      if (music.current === cur) music.current = null;
    }
  }

  // ---------- voices ----------
  function extOrder() {
    const a = document.createElement('audio');
    return a.canPlayType('audio/ogg; codecs="vorbis"') ? VOICE_EXTS : ['mp3', 'wav', 'ogg'];
  }

  async function resolveFile(dir, name) {
    const id = dir + name;
    if (voiceUrl.has(id)) return voiceUrl.get(id);
    await loadManifest();
    let url = null;
    for (const ext of extOrder()) {
      const file = `${name}.${ext}`;
      if (manifest && !probeVoices) {
        const list = dir === 'voice/barks/' ? manifest.barks : manifest.voice;
        if (list.has ? list.has(file) : list.includes(file)) { url = new URL(dir + file, AUDIO_BASE).href; break; }
      } else {
        try {
          const u = new URL(dir + file, AUDIO_BASE).href;
          const r = await fetch(u, { method: 'HEAD', cache: 'no-cache' });
          if (r.ok) { url = u; break; }
        } catch (_) { /* offline */ }
      }
    }
    voiceUrl.set(id, url);
    return url;
  }

  function loadBuffer(url) {
    if (!buffers.has(url)) {
      buffers.set(url, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((ab) => (ab ? ctx.decodeAudioData(ab) : null))
        .catch((e) => { console.warn('[audio] cannot decode', url, e.message || e); return null; }));
      // Keep the cache bounded: dialogue lines are played once or twice per session.
      if (buffers.size > 64) buffers.delete(buffers.keys().next().value);
    }
    return buffers.get(url);
  }

  function stopVoice() {
    if (!voice) return;
    const v = voice;
    voice = null;
    try { v.g.gain.setTargetAtTime(0, ctx.currentTime, 0.02); v.src.stop(ctx.currentTime + 0.1); } catch (_) { /* not started */ }
  }

  // Plays data/audio/voice/<key>.(ogg|mp3|wav). Resolves true if it played, false when the file
  // does not exist (yet) or audio is locked; a newer line cancels an older one still loading.
  async function playVoice(key) {
    if (!ctx) return false;
    const token = ++voiceToken;
    stopVoice();
    const url = await resolveFile('voice/', key);
    if (!url || token !== voiceToken) return false;
    const buf = await loadBuffer(url);
    if (!buf || token !== voiceToken) return false;
    const src = ctx.createBufferSource(), g = G(1);
    src.buffer = buf;
    chain(src, g, buses.voice);
    const v = { key, src, g, playing: true };
    src.onended = () => { v.playing = false; if (voice === v) voice = null; };
    voice = v;
    src.start();
    return true;
  }

  // Quest hook: called for every dialogue line shown. Ducks the bed even when no file exists, so
  // the dialogue box reads as a scene; the hold covers callers that do not pass isDialogueOpen.
  function onDialogueLine(questId, lineKey, speaker) {
    if (!ctx) return;
    dialogueHold = ctx.currentTime + 3;
    playVoice(voiceKey(questId, lineKey)).catch(() => {});
    lastSpeaker = speaker || null;
  }

  // Short everyday line from a passer-by: data/audio/voice/barks/<archetype>_NN.ogg. `at` places
  // it in the world (quiet beyond ~40 m). Rate-limited so a crowd never turns into a choir.
  async function playBark(archetype, at = null) {
    if (!ctx || ctx.state !== 'running') return false;
    const now = ctx.currentTime;
    if (now - bark.lastAny < 1.5 || now - (bark.last[archetype] || -99) < 6) return false;
    let level = 1, pan = 0;
    if (at) {
      const pl = getPlayer && getPlayer(), pos = pl && (pl.pos || pl.position);
      if (pos) {
        level = fall(M(Math.hypot(at.x - pos.x, at.z - pos.z)), 6, 40);
        pan = panFor(at, pos.x, pos.z);
      }
      if (level < 0.05) return false;
    }
    await loadManifest();
    let files;
    if (manifest && !probeVoices) {
      files = manifest.barks.filter((f) => f.startsWith(archetype + '_')).map((f) => f.replace(/\.(ogg|mp3|wav)$/i, ''));
      files = [...new Set(files)];
    } else {
      files = [];
      for (let i = 1; i <= 12; i++) files.push(`${archetype}_${String(i).padStart(2, '0')}`);
    }
    if (!files.length) return false;
    const options = files.length > 1 ? files.filter((f) => f !== bark.lastFile[archetype]) : files;
    const name = options[Math.floor(rand() * options.length)];
    const url = await resolveFile('voice/barks/', name);
    if (!url) return false;
    const buf = await loadBuffer(url);
    if (!buf) return false;
    bark.lastAny = ctx.currentTime; bark.last[archetype] = ctx.currentTime; bark.lastFile[archetype] = name;
    const src = ctx.createBufferSource(), g = G(level * 0.8), p = P(buses.voice);
    p.pan.value = pan;
    src.buffer = buf;
    chain(src, g, p);
    src.start();
    return true;
  }

  // ---------- settings ----------
  function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(settings)); } catch (_) { /* storage blocked */ } }

  function setMuted(m) {
    settings.muted = !!m;
    save();
    if (ctx) glide(master.gain, settings.muted ? 0 : settings.master, 0.05);
    if (onMuteChange) { try { onMuteChange(settings.muted); } catch (_) { /* caller's problem */ } }
  }

  function setVolume(bus, v) {
    v = clamp(Number(v) || 0, 0, 1);
    if (!(bus in DEFAULTS) || typeof DEFAULTS[bus] !== 'number') return;
    settings[bus] = v;
    save();
    if (!ctx) return;
    if (bus === 'master') { if (!settings.muted) glide(master.gain, v, 0.05); }
    else if (bus === 'music') glide(buses.music.gain, settings.musicOn ? v : 0, 0.05);
    else glide(buses[bus].gain, v, 0.05);
  }

  function setMusicEnabled(on) {
    settings.musicOn = !!on;
    save();
    if (ctx) glide(buses.music.gain, settings.musicOn ? settings.music : 0, 0.4);
  }

  function stats() {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return {
      supported: !unsupported, unlocked: !!ctx, state: ctx ? ctx.state : 'locked', muted: settings.muted,
      volumes: { master: settings.master, music: settings.music, sfx: settings.sfx, voice: settings.voice }, musicEnabled: settings.musicOn,
      zone: zones.dominant,
      weights: { beach: r3(zones.beach), traffic: r3(zones.traffic), crowd: r3(zones.crowd), park: r3(zones.park) },
      gains: L ? { sea: r3(L.sea.out.gain.value), traffic: r3(L.traffic.out.gain.value), crowd: r3(L.crowd.out.gain.value), birds: r3(L.park.level), bed: r3(L.bed.gain.value) } : null,
      distM: { sea: Math.round(zones.seaM), bigRoad: Math.round(zones.roadM), roadRank: zones.roadRank },
      parks: { state: parksState, count: parks.length },
      music: { tracks: music.tracks.length, playing: music.current ? music.current.entry.file : null, zone: music.zone },
      voice: { manifest: !!manifest, playing: voice ? voice.key : null, speaker: lastSpeaker, files: manifest ? manifest.voice.size : null, barks: manifest ? manifest.barks.length : null },
    };
  }

  function dispose() {
    disposed = true;
    for (const ev of gestureEvents) window.removeEventListener(ev, onGesture, { capture: true });
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    stopMusic(0.1); stopVoice();
    if (ctx) ctx.close().catch(() => {});
  }

  return {
    update, unlock, playVoice, onDialogueLine, playBark, setMusicEnabled, setMuted, setVolume,
    toggleMute: () => setMuted(!settings.muted), get muted() { return settings.muted; }, stats, dispose, voiceKey,
  };
}
