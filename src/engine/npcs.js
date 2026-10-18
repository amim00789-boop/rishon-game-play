// Population: a pool of pedestrians spawned and recycled around the player.
//
// Where people walk: city.sidewalks (raised strips beside the carriageways, promenade edges),
// plus footways / pedestrian streets / the promenade from city.roads that are off the
// carriageway. Without city sidewalks it falls back to offsets of city.roads. Walkers cross to
// the nearest other sidewalk end at junctions, pause, stand in chatting groups, wait at bus
// stops, walk as couples, ride delivery bikes, and play matkot on the sand.
//
// Who walks there: every archetype carries `crowd.zones` weights (archetypes.js). Each spot gets
// zone memberships (street, busy, residential, beach, promenade, mall, station, synagogue, park,
// parking) from landmark POIs, city.busStops, and data/rishon.json (amenities, religious and
// large commercial buildings, beach and park polygons), so matkot guys stay by the sea, haredim
// cluster near synagogues, commuters near stations, Moshiko's crew near malls, beach and parking.
//
// Round 3 behaviours: people sit on the benches dressing.js placed (read from its instanced
// meshes, no API needed), wait seated in bus shelters, queue at kiosks and falafel stands with a
// vendor behind the counter, gather in parks (kids playing tag, a parent watching), stand around
// squares and cinema plazas, listen to buskers, walk dogs, jog the promenade, walk hand in hand,
// go to school in small groups, and stop to take photos.
//
// How it stays at 60 fps: the nearest MAX_FULL people within FULL_R get a full avatar (pooled by
// look and reused); everyone else out to HIDE_R is a cheap proxy drawn with one InstancedMesh per
// body part (a handful of draw calls for the whole crowd); beyond HIDE_R nobody is drawn. Full
// avatars cost ~60 draw calls each (plus shadows), proxies are nearly free, so density grows in
// the proxy tier and the full tier stays capped.
//
// API (unchanged from M1): new Crowd(scene, roads, makeAvatar, archetypeIds, opts),
// spawnAround(x, z), update(dt, px, pz), npcs. Extras: setWorld({ city, landmarks }), stats().
// `opts.count` (old fixed crowd size) is ignored; `opts.max` caps the pool.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SCALE } from '../geo.js';

const FULL_R = 55, FULL_OUT = 66, MAX_FULL = 20;
const SHADOW_R = 22; // full avatars further out skip the shadow pass (~60 draw calls each)
const HIDE_R = 250, SPAWN_R = 235, DESPAWN_R = 300;
// Real Rishon on a weekday: a handful of people per residential block, nobody along the
// highways and ramps, crowds only where people actually gather (founder, round 3 feedback).
const MAX_NPC = 140, MIN_NPC = 4;
const DENSITY = 0.027; // people per unit of weighted sidewalk length within SPAWN_R
const CELL = 50;
const SIDE_TOP = 0.42, PATH_TOP = 0.12, SAND_TOP = 0.06;
const CREATE_BUDGET = 2, POOL_CAP = 110;
// Personal space (world units, centre to centre): walkers steer to keep SEP_WALK, nobody is ever
// placed or pushed closer than SEP_MIN (two torsos would touch), and the audit flags < SEP_AUDIT.
const SEP_WALK = 1.9, SEP_MIN = 1.5, SEP_AUDIT = 1.2, SEP_CELL = 2.5, SEP_R = 150;
// Seats on dressing.js furniture, in the prop's local frame (seat faces +z): seat height, the
// pelvis depth on the seat, and the x of each place.
const SEAT_DEFS = {
  bench: { h: 1.29, z: -0.3, xs: [-1.0, 1.0] },
  pergola: { h: 1.29, z: -1.2, xs: [-1.0, 1.0] },
  shelter: { h: 1.36, z: -1.0, xs: [-1.8, 0, 1.8] },
};
// Squares and plazas where people stand around (landmark POI ids).
const PLAZAS = { founders_square: 45, cinema_city: 50, yes_planet: 45, superland: 55, dino_park: 45, golden_mall: 55, skate_park: 35, water_tower: 25, harova: 45 };
// Nightlife squares (landmark POI ids, radius): bars and restaurants with people at their tables.
const NIGHTLIFE = { harova: 110 };
// The four regulars (the founder's friends): where they hang out, in order of preference.
// Their default is the cliff lookout over Route 431 at the end of Kiryat Ganim / Neot Ashlim
// (founder, round 5): all four sit at the picnic benches there and play, day in, day out. Now and
// then one of them strolls one of their old haunts while the player is far away, and is back on
// the bench before the player gets near.
const NAMED = {
  dekel: { homes: ['ganim', 'tizmoret', 'beach'], seat: 0 },
  ofir: { homes: ['ganim', 'beach', 'tizmoret'], reroll: true, seat: 1 },
  adir: { homes: ['ganim', 'tizmoret', 'beach'], seat: 2 },
  malul: { homes: ['beach', 'ganim', 'plaza', 'tizmoret'], drums: true, seat: 3 },
};
// Until landmarks.js publishes poi 'cliff_lookout' with its benches: the lookout data the
// landmarks and terrain agents gave (round 5): two picnic benches and the giant leaning tree.
const LOOKOUT_FALLBACK = { x: -199, z: 1968, y: 77.42, benches: [[-186.8, 1967.5], [-211.5, 1963.1]], tree: [-199.1, 1979.5] };
const LOOKOUT_NEAR = 320; // inside this the player always finds all four on the benches
const INSTRUMENTS = /^(guitar|ukulele|electricGuitar|violin|flute|melodica|darbuka|kazoo|shofar|keyboard)$/;
const SHOP_KINDS = /^(fast_food|cafe|ice_cream|kiosk|convenience|bakery|deli|greengrocer|confectionery)$/;
const SKIP_KINDS = /motorway|trunk|rail|tram|subway|_link$/i;
const FOOT_KINDS = /^(footway|pedestrian|promenade|path|living_street)$/;

// guarded optional modules
let groundAt = () => 0;
import('../world/terrain.js').then((m) => { if (typeof m.groundAt === 'function') groundAt = m.groundAt; }).catch(() => {});
let resolveConfig = null, ARCH = null;
let BODY = 0.697; // avatar world units per body unit (avatar.js BODY_SCALE)
import('../characters/avatar.js').then((m) => { resolveConfig = m.resolveConfig || null; ARCH = m.ARCHETYPES || null; if (m.BODY_SCALE) BODY = m.BODY_SCALE; if (m.gaitCycleLength) gaitC = m.gaitCycleLength; }).catch(() => {});
// cycle length (body units per two steps) of the avatar gait; avatar.js replaces this fallback
let gaitC = (vb, run = 0, stride = 1) => (Math.min(3.8, Math.max(2.3, 2.1 + 0.24 * vb)) * (1 - run) + Math.min(9.5, Math.max(4.0, 2.85 + 0.33 * vb)) * run) * Math.min(1.15, Math.max(0.75, stride));
let plazaAt = () => null;
import('../world/landmarks.js').then((m) => { if (typeof m.landmarkSurfaceAt === 'function') plazaAt = m.landmarkSurfaceAt; }).catch(() => {});

const ZONES = ['street', 'busy', 'residential', 'beach', 'promenade', 'mall', 'station', 'synagogue', 'park', 'parking', 'school', 'nightlife'];
const KIND_DENSITY = {
  primary: 0.5, secondary: 0.5, tertiary: 0.35, trunk: 0, residential: 0.14, living_street: 0.2, unclassified: 0.12,
  service: 0.08, promenade: 2.6, pedestrian: 2.0, footway: 0.2, path: 0.15, cycleway: 0, steps: 0.1, track: 0,
};
const GAN_HAIR = /\u05d2\u05df \u05d4\u05e2\u05d9\u05e8|gan ha.?ir/i; // the city park's OSM name
const BUSY_KINDS = /^(primary|secondary|tertiary|trunk|pedestrian)/;
const RES_KINDS = /^(residential|living_street|footway|path|service|unclassified)/;

// How much an archetype fits a spot: sitting (crowd.sit, older people like benches most),
// queueing or standing around (nobody on wheels or mid-run).
function modeWeight(a, mode) {
  const cr = a.crowd || {}, st = a.style || {};
  if (cr.ride || cr.pace || cr.named) return 0;
  if (mode === 'bar') return st.dog || st.stroller || (a.body && (a.body.scale ?? 1) < 0.85) ? 0 : (cr.sit ?? 1);
  if (mode === 'sit') return st.dog || st.stroller ? 0 : (cr.sit ?? 1) * ((st.stride ?? 1) < 0.8 ? 2.2 : 1);
  if (mode === 'queue') return st.dog ? 0.3 : 1;
  return st.dog ? 0.5 : 1;
}

const key = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
const cellOf = (v) => Math.floor(v / CELL);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fall = (d, r) => (d >= r ? 0 : 1 - d / r);

export class Crowd {
  constructor(scene, roads, makeAvatar, archetypeIds, opts = {}) {
    this.scene = scene;
    this.makeAvatar = makeAvatar;
    this.ids = (archetypeIds || []).slice();
    this.roads = roads || [];
    this.max = opts.max || MAX_NPC;
    this.rnd = mulberry(opts.seed || 777);
    this.npcs = [];
    this.groups = [];
    this.world = null;
    this.net = null;
    this.data = null;
    this.zoneCache = new Map();
    this.pool = new Map();
    this.pooled = 0;
    this.created = 0;
    this.fullCount = 0;
    this.desired = MIN_NPC;
    this.desiredT = 0;
    this.filled = false;
    this.cand = null;
    this.proxyAcc = 1;
    this.t = 0;
    this.center = null;
    this.frame = 0;
    this.proxy = buildProxies(scene, this.max);
    // the regulars, readable by quests: crowd.named.dekel -> { x, z, y, state, playing, instrument } or null
    this.named = { dekel: null, ofir: null, adir: null, malul: null };
    // The cliff lookout is the band's hangout only once the story has brought the player there
    // (Adir's pickup in m13b_cliff); until then they keep to their old haunts.
    this.lookoutOpen = false;
    this.namedRec = {};
    if (opts.city) this.setWorld({ city: opts.city, landmarks: opts.landmarks });
    // opts.streaming: main.js adds furniture, shop fronts and their colliders after the first
    // frame. The crowd waits for worldGrew() so its first fill sits people on the benches, queues
    // them at the kiosks and keeps them clear of every collider, as when everything loaded at once.
    this.worldPending = !!opts.streaming;
    this.wver = 1;
    loadData().then((d) => { if (d) { this.data = d; this.zoneFeatures = null; this.zoneCache.clear(); this.cand = null; this.wver++; } });
  }

  // Optional explicit wiring; otherwise the crowd picks city/landmarks up from window.__game.
  setWorld({ city, landmarks } = {}) {
    this.world = { city: city || null, landmarks: landmarks || null };
    this.net = null;
    this.zoneFeatures = null;
    this.zoneCache.clear();
    this.cand = null;
    this.wver = (this.wver || 0) + 1;
  }

  // The streamed world is complete: zones and kiosk spots are recomputed against it.
  worldGrew() {
    this.worldPending = false;
    this.zoneFeatures = null;
    this.zoneCache.clear();
    this.cand = null;
    this.wver++;
  }

  spawnAround(cx, cz) {
    this.center = { x: cx, z: cz };
  }

  stats() {
    const by = {};
    const states = {};
    let full = 0, proxy = 0, near = 0;
    for (const n of this.npcs) {
      by[n.id] = (by[n.id] || 0) + 1;
      states[n.state] = (states[n.state] || 0) + 1;
      if (n.av) full++;
      else if (n.lod === 1) proxy++;
      if (n.d < HIDE_R) near++;
    }
    const groups = {};
    for (const g of this.groups) groups[g.kind] = (groups[g.kind] || 0) + 1;
    return { total: this.npcs.length, visible: near, full, proxy, desired: this.desired, created: this.created, pooled: this.pooled, byArchetype: by, states, groups,
      seats: this.seatList ? this.seatList.length : 0, shopSpots: this.shopList ? this.shopList.length : 0, paths: this.net ? this.net.paths.length : 0 };
  }

  zoneAt(x, z) {
    return { ...this.cellZone(x, z) };
  }

  // Everyone's step clock runs on how far they really moved this frame (path walking, side-steps,
  // being slowed behind someone, crossing, joining a queue), never on their nominal speed, so a
  // planted foot holds the ground at every LOD: the full avatar gets this speed, and the far proxy's
  // legs swing at the cadence the avatar would have (avatar.js gaitCycleLength).
  gaitClock(dt) {
    if (!(dt > 0)) return;
    const k = Math.min(1, dt * 10);
    for (const n of this.npcs) {
      const dx = n.x - (n.x0 ?? n.x), dz = n.z - (n.z0 ?? n.z);
      n.x0 = n.x; n.z0 = n.z;
      const v = Math.hypot(dx, dz) / dt;
      n.vel = v > 60 ? n.vel || 0 : (n.vel || 0) + (v - (n.vel || 0)) * k; // a respawn jump is not a step
      if (n.state === 'skate' || n.state === 'sit') continue;
      if (n.ride) { n.phase += (n.moving ? n.speed : 0) * dt * 0.95; continue; }
      const ws = (n.colors && n.colors.ws) || BODY, vb = n.vel / ws;
      const run = n.pace === 'jog' ? 1 : 0;
      if (n.stride === undefined) { const A = ARCH && ARCH[n.id]; n.stride = (A && A.style && A.style.stride) || 1; }
      n.gaitC = gaitC(vb, run, n.stride);
      n.phase += (2 * Math.PI * vb * dt) / n.gaitC;
    }
  }

  // ---- personal space -------------------------------------------------------------------------------
  // A spatial hash of everyone near the player (and the player). Walkers on a pavement side-step to
  // the right of an oncoming or slower person and slow down when there is no room; free movers
  // (crossing, joining a queue, playing, skating) are pushed apart; nobody ends a frame inside
  // anybody else. Standing and seated people are fixed obstacles.
  buildSepGrid(px, pz) {
    const G = new Map();
    const add = (o) => {
      const k = key(Math.floor(o.x / SEP_CELL), Math.floor(o.z / SEP_CELL));
      let l = G.get(k);
      if (!l) G.set(k, (l = []));
      l.push(o);
    };
    for (const n of this.npcs) if (n.d < SEP_R + 10) add(n);
    this.player = this.player || { player: true, x: 0, z: 0, state: 'player' };
    this.player.x = px; this.player.z = pz;
    add(this.player);
    this.sepGrid = G;
    return G;
  }

  neighbours(x, z, r, out) {
    out.length = 0;
    const G = this.sepGrid;
    if (!G) return out;
    const c = Math.ceil(r / SEP_CELL), ix = Math.floor(x / SEP_CELL), iz = Math.floor(z / SEP_CELL);
    for (let a = -c; a <= c; a++) for (let b = -c; b <= c; b++) for (const o of G.get(key(ix + a, iz + b)) || []) out.push(o);
    return out;
  }

  // Is anyone (or the player) within r of (x, z)? Spawners use it so nobody appears inside someone.
  occupied(x, z, r = SEP_MIN, except = null) {
    const nb = this.neighbours(x, z, r, this._occ || (this._occ = []));
    for (const o of nb) if (o !== except && Math.abs(o.x - x) < r && Math.abs(o.z - z) < r && Math.hypot(o.x - x, o.z - z) < r) return true;
    for (const o of this.fresh || []) if (o !== except && Math.hypot(o.x - x, o.z - z) < r) return true;
    return false;
  }

  separate(dt, px, pz) {
    this.buildSepGrid(px, pz);
    this.fresh = [];
    const nb = this._sep || (this._sep = []);
    for (const n of this.npcs) {
      if (n.d > SEP_R) continue;
      const free = n.state === 'cross' || n.state === 'goto' || n.state === 'play' || n.state === 'skate';
      const walker = n.state === 'walk';
      if (!free && !walker) { n.avoid = 0; continue; }
      const fx = Math.sin(n.facing), fz = Math.cos(n.facing);
      let wantAvoid = 0, block = 1;
      this.neighbours(n.x, n.z, SEP_WALK + 1.2, nb);
      for (const o of nb) {
        if (o === n || o === n.mate || o === n.leader || (o.leader === n)) continue;
        const dx = o.x - n.x, dz = o.z - n.z, d = Math.hypot(dx, dz);
        if (d > SEP_WALK + 1.2 || d < 1e-4) continue;
        if (free) {
          // push straight apart, half each when both move, all of it when the other stands
          if (d < SEP_MIN) {
            const share = o.player || o.state === 'stand' || o.state === 'sit' || o.state === 'workout' ? 1 : 0.5;
            const k = ((SEP_MIN - d) * share) / d;
            const nx = n.x - dx * k, nz = n.z - dz * k;
            const zebra = n.cross && n.cross.via && n.cross.via.length === 1;
            if (zebra || this.offRoad(nx, nz, 0)) { n.x = nx; n.z = nz; }
          }
          continue;
        }
        // walker on a pavement: look ahead along the facing
        const ahead = dx * fx + dz * fz, lat = dx * fz - dz * fx; // lat > 0: the other is to the left
        if (ahead < -0.4 || ahead > SEP_WALK + 1.2) continue;
        if (Math.abs(lat) > SEP_WALK) continue;
        const ofx = o.state === 'walk' || o.state === 'follow' ? Math.sin(o.facing) : 0, ofz = o.state === 'walk' || o.state === 'follow' ? Math.cos(o.facing) : 0;
        const closing = n.speed - (ofx * fx + ofz * fz) * (o.speed || 0);
        if (closing <= 0.05 && ahead > SEP_MIN) continue; // the one ahead walks away as fast
        // step to the right of someone coming the other way; otherwise pass on the roomier side
        const right = o.state === 'walk' && ofx * fx + ofz * fz < -0.3 ? 1 : lat > 0 ? 1 : -1;
        wantAvoid += right * (SEP_WALK - Math.abs(lat) + 0.2);
        if (ahead < SEP_MIN + 0.4 && Math.abs(lat) < SEP_MIN) block = Math.min(block, ahead < SEP_MIN * 0.8 ? 0 : 0.35);
      }
      if (free) continue;
      // lane is to the left of the path direction; facing may be either way along it
      const target = clamp(-wantAvoid * (n.dir || 1), -1.6, 1.6);
      n.avoid = (n.avoid || 0) + (target - (n.avoid || 0)) * Math.min(1, dt * 4);
      n.block = block;
      // nose to nose on a pavement too narrow to pass: one of them turns back after a moment
      n.stuckT = block === 0 ? (n.stuckT || 0) + dt : 0;
      if (n.stuckT > 1.2 + (n.yTick || 0) * 0.4) { n.stuckT = 0; n.dir = -n.dir; n.avoid = 0; }
    }
  }

  // Last line of defence after steering: anyone moving who still ends the frame inside someone
  // (or the player) is pushed straight out, all the way when the other is fixed (standing, seated,
  // the player), half when both move. A push that would land on a carriageway or in a sealed zone
  // is refused, and the mover is held where it stood last frame instead (its place on the path
  // too, so it does not jump ahead later).
  resolveOverlaps() {
    const nb = this._res || (this._res = []);
    const mobile = (o) => !o.player && (o.state === 'walk' || o.state === 'follow' || o.state === 'cross' || o.state === 'goto' || o.state === 'play') && !o.seat;
    for (let pass = 0; pass < 2; pass++) {
      let fixed = 0;
      for (const n of this.npcs) {
        if (n.d > SEP_R || !mobile(n)) continue;
        this.neighbours(n.x, n.z, SEP_MIN + 0.2, nb);
        for (const o of nb) {
          if (o === n) continue;
          const dx = n.x - o.x, dz = n.z - o.z, d = Math.hypot(dx, dz);
          if (d >= SEP_AUDIT + 0.15) continue;
          const want = SEP_AUDIT + 0.2;
          const share = mobile(o) ? 0.5 : 1;
          const ux = d > 1e-4 ? dx / d : Math.sin(n.facing + Math.PI / 2), uz = d > 1e-4 ? dz / d : Math.cos(n.facing + Math.PI / 2);
          const k = (want - d) * share;
          const nx = n.x + ux * k, nz = n.z + uz * k;
          const zebra = n.state === 'cross' && n.cross && n.cross.via && n.cross.via.length === 1;
          if (zebra || this.offRoad(nx, nz, 0)) { n.x = nx; n.z = nz; }
          else if (n.snap && n.snap.state === n.state && Math.hypot(n.snap.x - o.x, n.snap.z - o.z) > d) {
            const S = n.snap;
            n.x = S.x; n.z = S.z;
            if (n.state === 'walk') { n.path = S.path; n.seg = S.seg; n.t = S.t; n.dir = S.dir; }
            n.block = 0;
          } else if (n.state === 'walk') {
            // boxed in against the kerb by someone who will not move: turn back
            n.dir = -n.dir; n.avoid = 0; n.stuckT = 0;
          }
          if (share < 1) {
            const ox = o.x - ux * k, oz = o.z - uz * k;
            if (this.offRoad(ox, oz, 0)) { o.x = ox; o.z = oz; }
          }
          fixed++;
        }
      }
      if (!fixed) break;
    }
    // two people standing inside each other (a queue slot, a listener, a group spot taken twice):
    // the later one steps to the nearest free place beside
    for (const n of this.npcs) {
      if (n.d > SEP_R || n.state !== 'stand' || n.id === 'kiosk_vendor' || n.id === 'street_musician' || n.named) continue;
      this.neighbours(n.x, n.z, SEP_AUDIT, nb);
      let clash = null;
      for (const o of nb) if (o !== n && !o.player && (o.state === 'stand' || o.state === 'sit' || o.state === 'workout') && Math.hypot(o.x - n.x, o.z - n.z) < SEP_AUDIT) { clash = o; break; }
      if (!clash) continue;
      for (let tries = 0; tries < 12; tries++) {
        const a = n.facing + Math.PI / 2 + (tries % 2 ? Math.PI : 0) + Math.floor(tries / 2) * 0.5, r = SEP_MIN + 0.1 + Math.floor(tries / 4) * 0.6;
        const x = clash.x + Math.sin(a) * r, z = clash.z + Math.cos(a) * r;
        if (this.offRoad(x, z, 0.3) && !this.occupied(x, z, SEP_MIN, n)) { this.sendTo(n, x, z, n.facing); break; }
      }
    }
  }

  // Overlap audit (tests and console): pairs of people near the player whose bodies intersect, and
  // people inside the player.
  overlapAudit(r = 120) {
    this.buildSepGrid(this.last ? this.last.x : 0, this.last ? this.last.z : 0);
    const out = { checked: 0, pairs: 0, withPlayer: 0, samples: [] };
    const nb = [];
    for (const n of this.npcs) {
      if (n.d > r) continue;
      out.checked++;
      this.neighbours(n.x, n.z, SEP_AUDIT + 0.1, nb);
      for (const o of nb) {
        if (o === n || (!o.player && this.npcs.indexOf(o) < this.npcs.indexOf(n))) continue;
        const d = Math.hypot(o.x - n.x, o.z - n.z);
        if (d >= SEP_AUDIT) continue;
        if (o.player) out.withPlayer++;
        else out.pairs++;
        if (out.samples.length < 5) out.samples.push({ a: n.id + ':' + n.state, b: o.player ? 'player' : o.id + ':' + o.state, d: +d.toFixed(2) });
      }
    }
    return out;
  }

  // The player is pushed out of anyone they walk into (player.js calls this after moving).
  pushOut(pos, radius = 0.9) {
    if (!this.sepGrid) return false;
    const nb = this.neighbours(pos.x, pos.z, radius + 1.2, this._push || (this._push = []));
    let hit = false;
    for (const o of nb) {
      if (o.player || o.d > SEP_R) continue;
      const dx = pos.x - o.x, dz = pos.z - o.z, d = Math.hypot(dx, dz), min = radius + 0.62;
      if (d >= min) continue;
      const k = d > 1e-4 ? (min - d) / d : 0;
      pos.x += d > 1e-4 ? dx * k : min;
      pos.z += dz * k;
      hit = true;
    }
    return hit;
  }

  // Audit for tests and the debug console: everyone near the player standing or walking on a
  // carriageway right now. Crossing on a zebra is allowed and counted apart.
  roadAudit(r = HIDE_R) {
    const out = { checked: 0, onRoad: 0, onZebra: 0, byState: {}, samples: [] };
    for (const n of this.npcs) {
      if (n.d > r) continue;
      out.checked++;
      if (this.offRoad(n.x, n.z, 0)) continue;
      const zc = (m) => m && m.state === 'cross' && m.cross && m.cross.via && m.cross.via.length === 1;
      if (zc(n) || (n.state === 'follow' && zc(n.leader))) { out.onZebra++; continue; }
      out.onRoad++;
      const k = n.state + (n.idle > 0 ? '+idle' : '');
      out.byState[k] = (out.byState[k] || 0) + 1;
      if (out.samples.length < 5) out.samples.push({ id: n.id, state: n.state, x: Math.round(n.x), z: Math.round(n.z), path: n.path ? n.path.kind : null });
    }
    return out;
  }

  // ---- keeping people off the carriageways -----------------------------------------------------
  // True when (x, z) is clear of every carriageway, ramp and track by `m` units. Anyone who stands
  // still (groups, queues, bus stops, listeners) is placed only where this holds.
  // A place someone may stand: off every carriageway and outside sealed zones.
  offRoad(x, z, m = 0.6) {
    if (this.sealed(x, z)) return false;
    const city = this.world && this.world.city;
    if (!city || typeof city.onCarriage !== 'function') return true;
    try { return !city.onCarriage(x, z, m); } catch (_) { return true; }
  }

  // True when the straight walk a -> b stays off the carriageways.
  clearLine(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(d / 1.5));
    for (let i = 0; i <= n; i++) if (!this.offRoad(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n, 0)) return false;
    return true;
  }

  // Route from a kerb point to another across the road over the nearest zebra: [nearSide, farSide].
  zebraRoute(ax, az, bx, bz) {
    const city = this.world && this.world.city;
    const list = city && city.crossings;
    if (!list || !list.length) return null;
    let best = null, bd = 1e9;
    for (const c of list) {
      const d = Math.hypot(c.x - ax, c.z - az) + Math.hypot(c.x - bx, c.z - bz);
      if (d > 90 || d >= bd) continue;
      const nx = Math.cos(c.angle), nz = -Math.sin(c.angle); // across the road
      const h = (c.width || 8) / 2 + 1.6;
      let A = [c.x + nx * h, c.z + nz * h], B = [c.x - nx * h, c.z - nz * h];
      if (Math.hypot(A[0] - ax, A[1] - az) > Math.hypot(B[0] - ax, B[1] - az)) [A, B] = [B, A];
      if (!this.offRoad(A[0], A[1], 0) || !this.offRoad(B[0], B[1], 0)) continue;
      if (!this.clearLine(ax, az, A[0], A[1]) || !this.clearLine(B[0], B[1], bx, bz)) continue;
      bd = d;
      best = { via: [A, B], c };
    }
    return best;
  }

  // A vehicle close to a zebra: wait at the kerb.
  carNear(c) {
    const tr = typeof window !== 'undefined' && window.__game && window.__game.traffic;
    const vs = tr && tr.vehicles;
    if (!vs || !vs.length) return false;
    const r = (c.width || 8) / 2 + 9;
    for (const v of vs) {
      const x = v.x ?? (v.pos && v.pos.x), z = v.z ?? (v.pos && v.pos.z);
      if (x !== undefined && Math.abs(x - c.x) < r && Math.abs(z - c.z) < r && Math.hypot(x - c.x, z - c.z) < r) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------
  ensureNetwork() {
    if (this.net) return true;
    if (!this.world && typeof window !== 'undefined' && window.__game && window.__game.city) {
      this.setWorld({ city: window.__game.city, landmarks: window.__game.landmarks });
    }
    if (!this.world && this.frame < 3) return false; // give main.js a frame to publish __game
    this.net = buildNetwork(this.world && this.world.city, this.roads, this.sealedFn());
    this.netSealed = !!this.sealedFn();
    return this.net.paths.length > 0;
  }

  // Sealed zones (military bases, fenced private grounds; src/world/details.js): nobody walks,
  // spawns or waits inside one. details.js streams in after the first frames, so the walk network
  // is rebuilt once it arrives and anyone already inside is sent away.
  sealedFn() {
    const d = typeof window !== 'undefined' && window.__game && window.__game.details;
    return d && typeof d.restrictedAt === 'function' && d.zones && d.zones.length ? d.restrictedAt : null;
  }

  sealed(x, z) {
    const f = this.sealedFn();
    if (!f) return false;
    try { return !!f(x, z); } catch (_) { return false; }
  }

  resealNetwork() {
    if (this.netSealed || !this.net || !this.sealedFn() || this.frame % 30 !== 5) return;
    this.net = buildNetwork(this.world && this.world.city, this.roads, this.sealedFn());
    this.netSealed = true;
    this.zoneFeatures = null;
    this.cand = null;
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const n = this.npcs[i];
      if (n.keep || n.named) continue;
      if (n.path || this.sealed(n.x, n.z)) this.removeNpc(i);
    }
  }

  // ---- zones ---------------------------------------------------------------------------------
  features() {
    if (this.zoneFeatures) return this.zoneFeatures;
    const F = { mall: [], station: [], busStop: [], synagogue: [], beachPt: [], parking: [], commercial: [], park: [], busy: [], beachPolys: [], parkPolys: [], promenade: [], school: [], plaza: [], shop: [], nightlife: [], quiet: [], ganHair: [] };
    const city = this.world && this.world.city;
    const pois = (this.world && this.world.landmarks && this.world.landmarks.pois) || [];
    for (const p of pois) {
      if (PLAZAS[p.id]) F.plaza.push({ x: p.x, z: p.z, r: PLAZAS[p.id] + 70 });
      if (NIGHTLIFE[p.id]) F.nightlife.push({ x: p.x, z: p.z, r: NIGHTLIFE[p.id] });
      const id = (p.id || '') + ' ' + (p.name || '');
      if (/mall|kanyon/i.test(id)) { F.mall.push({ x: p.x, z: p.z, r: 170 }); F.parking.push({ x: p.x, z: p.z, r: 230 }); }
      else if (/cinema/i.test(id)) { F.mall.push({ x: p.x, z: p.z, r: 120 }); F.parking.push({ x: p.x, z: p.z, r: 180 }); }
      else if (/station/i.test(id)) F.station.push({ x: p.x, z: p.z, r: 130 });
      else if (/synagogue/i.test(id)) F.synagogue.push({ x: p.x, z: p.z, r: 240 });
      else if (/beach|matkot|lifeguard|kiosk/i.test(id)) F.beachPt.push({ x: p.x, z: p.z, r: 160 });
      else if (/superland|dino|lake|park/i.test(id)) F.park.push({ x: p.x, z: p.z, r: 150 });
      else if (/square|founder/i.test(id)) F.busy.push({ x: p.x, z: p.z, r: 120 });
    }
    for (const b of (city && city.busStops) || []) F.busStop.push({ x: b.x, z: b.z, r: 28 });
    const d = this.data;
    if (d) {
      for (const [kind, , , x, z] of d.amenities || []) {
        if (kind === 'station' || kind === 'bus_station') F.station.push({ x, z, r: 110 });
        else if (kind === 'place_of_worship') F.synagogue.push({ x, z, r: 150 });
        else if (kind === 'parking_entrance' || kind === 'fuel') F.parking.push({ x, z, r: 70 });
        else if (kind === 'school' || kind === 'kindergarten' || kind === 'college') F.school.push({ x, z, r: 160 });
        else if (/restaurant|cafe|fast_food|bank|pharmacy|ice_cream|pub|bar|post_office|bureau|atm/.test(kind)) F.commercial.push({ x, z, r: 90 });
      }
      for (const b of d.religious) F.synagogue.push({ x: b.x, z: b.z, r: 160 });
      for (const b of d.bigShops) {
        F.mall.push({ x: b.x, z: b.z, r: b.r + 70 });
        F.parking.push({ x: b.x, z: b.z, r: b.r + 140 });
      }
      F.beachPolys = d.beach;
      F.parkPolys = d.parks;
      F.ganHair = d.ganHair || [];
      for (const q of d.nightlife || []) F.nightlife.push({ x: q[0], z: q[1], r: 70 });
      for (const q of d.industrial || []) F.quiet.push(q);
    }
    for (const st of this.barSeatList || []) if (st.kind === 'bar') F.nightlife.push({ x: st.x, z: st.z, r: 45 });
    for (const r of this.roads) {
      if (r.kind !== 'promenade' || !r.points) continue;
      for (let i = 0; i < r.points.length; i += 3) F.promenade.push({ x: r.points[i][0], z: r.points[i][1], r: 60 });
    }
    // bucket point features by cell so a zone lookup only scans its neighbourhood
    F.grid = new Map();
    for (const s of this.shopSpots()) F.shop.push({ x: s.px, z: s.pz, r: 40 });
    for (const name of ['mall', 'station', 'busStop', 'synagogue', 'beachPt', 'parking', 'commercial', 'park', 'busy', 'promenade', 'school', 'plaza', 'shop', 'nightlife', 'quiet']) {
      for (const f of F[name]) {
        const span = Math.ceil(f.r / CELL);
        const ix = cellOf(f.x), iz = cellOf(f.z);
        for (let a = -span; a <= span; a++) for (let b = -span; b <= span; b++) {
          const k = key(ix + a, iz + b);
          let l = F.grid.get(k);
          if (!l) F.grid.set(k, (l = []));
          l.push([name, f]);
        }
      }
    }
    this.zoneFeatures = F;
    return F;
  }

  cellZone(x, z) {
    const ix = cellOf(x), iz = cellOf(z), k = key(ix, iz);
    let Z = this.zoneCache.get(k);
    if (Z) return Z;
    const F = this.features();
    const cx = (ix + 0.5) * CELL, cz = (iz + 0.5) * CELL;
    const m = { mall: 0, station: 0, busStop: 0, synagogue: 0, beachPt: 0, parking: 0, commercial: 0, park: 0, busy: 0, promenade: 0, school: 0, plaza: 0, shop: 0, nightlife: 0, quiet: 0 };
    let shops = 0;
    for (const [name, f] of F.grid.get(k) || []) {
      const v = fall(Math.hypot(f.x - cx, f.z - cz), f.r);
      if (name === 'commercial') shops += v;
      else if (v > m[name]) m[name] = v;
    }
    const sand = polyHit(F.beachPolys, cx, cz, 25);
    const gan = polyHit(F.ganHair, cx, cz, 30);
    const park = Math.max(polyHit(F.parkPolys, cx, cz, 0), gan);
    Z = {
      street: 1,
      busy: clamp(Math.max(m.busy, shops / 3, m.plaza * 0.8), 0, 1),
      residential: 0,
      beach: Math.max(sand, m.beachPt * 0.8),
      promenade: m.promenade,
      mall: m.mall,
      station: Math.max(m.station, m.busStop * 0.7),
      busStop: m.busStop,
      synagogue: m.synagogue,
      park: Math.max(park, m.park),
      parking: m.parking,
      school: m.school,
      plaza: Math.max(m.plaza, gan * 0.7),
      shop: m.shop,
      nightlife: m.nightlife,
      quiet: m.quiet,
    };
    // on the sand and the promenade the city-street crowd thins out
    if (Z.beach > 0.5 || Z.promenade > 0.6) Z.street = 0.35;
    this.zoneCache.set(k, Z);
    return Z;
  }

  segZone(path, x, z) {
    const Z = { ...this.cellZone(x, z) };
    const kind = path.kind || '';
    if (BUSY_KINDS.test(kind)) Z.busy = Math.max(Z.busy, 0.8);
    if (RES_KINDS.test(kind) && Z.busy < 0.5) Z.residential = 1 - Z.busy;
    if (kind === 'promenade') { Z.promenade = 1; Z.street = 0.3; }
    return Z;
  }

  segWeight(path, x, z, len) {
    const Z = this.segZone(path, x, z);
    const k = KIND_DENSITY[path.kind] ?? (SKIP_KINDS.test(path.kind || '') ? 0 : 0.2);
    // the gathering places carry the crowd; industrial estates stay nearly empty
    const boost = 1 + 9.0 * Z.mall + 3.0 * Z.station + 3.0 * Z.busStop + 5.0 * Z.promenade + 4.0 * Z.beach + 0.5 * Z.synagogue
      + 0.6 * Z.busy + 1.5 * Z.park + 0.6 * Z.school + 6.0 * Z.plaza + 7.0 * Z.nightlife + 1.0 * Z.shop;
    return len * k * boost * (1 - 0.85 * Z.quiet);
  }

  // ---- archetype choice ----------------------------------------------------------------------
  // mode 'sit' (bench liking), 'queue' (no bikes, joggers or dogs), 'stand' (no riders, joggers)
  pickArchetype(Z, mode = null) {
    const ids = this.ids;
    if (!ARCH) return ids[Math.floor(this.rnd() * ids.length)];
    let total = 0;
    const w = this._w || (this._w = new Float64Array(128));
    for (let i = 0; i < ids.length; i++) {
      const a = ARCH[ids[i]];
      const cr = a && a.crowd;
      const zw = cr ? cr.zones || {} : { street: 0.4 };
      let s = 0;
      for (const zn of ZONES) if (zw[zn]) s += zw[zn] * (Z[zn] || 0);
      if (mode && a) s *= modeWeight(a, mode);
      w[i] = s;
      total += s;
    }
    if (total <= 0) {
      // only people who walk the streets at all, never a vendor or busker out of place
      const walkers = ids.filter((id) => ARCH[id] && ARCH[id].crowd && Object.keys(ARCH[id].crowd.zones || {}).length);
      return (walkers.length ? walkers : ids)[Math.floor(this.rnd() * (walkers.length || ids.length))];
    }
    let r = this.rnd() * total;
    for (let i = 0; i < ids.length; i++) { r -= w[i]; if (r <= 0) return ids[i]; }
    return ids[ids.length - 1];
  }

  // ---- candidate segments around the player ---------------------------------------------------
  candidates(px, pz) {
    const c = this.cand;
    if (c && Math.hypot(c.x - px, c.z - pz) < 25 && this.t - c.t < 3) return c;
    const net = this.net;
    const list = [], cum = [];
    let total = 0, near = 0;
    const span = Math.ceil(SPAWN_R / CELL);
    const ix = cellOf(px), iz = cellOf(pz);
    for (let a = -span; a <= span; a++) for (let b = -span; b <= span; b++) {
      const segs = net.grid.get(key(ix + a, iz + b));
      if (!segs) continue;
      for (const s of segs) {
        const path = net.paths[s[0]];
        const p0 = path.pts[s[1]], p1 = path.pts[s[1] + 1];
        const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
        const d = Math.hypot(mx - px, mz - pz);
        if (d > SPAWN_R) continue;
        if (s[3] !== this.wver) { s[2] = this.segWeight(path, mx, mz, Math.hypot(p1[0] - p0[0], p1[1] - p0[1])); s[3] = this.wver; }
        total += s[2];
        if (d < 160) near += s[2];
        list.push(s);
        cum.push(total);
      }
    }
    this.cand = { x: px, z: pz, t: this.t, list, cum, total, near };
    return this.cand;
  }

  // ---- spawning --------------------------------------------------------------------------------
  spawnOne(px, pz, minR, view) {
    const C = this.candidates(px, pz);
    if (!C.list.length) return false;
    const ok = (x, z) => {
      const d = Math.hypot(x - px, z - pz);
      return d >= minR && d <= SPAWN_R && !(view && d < 150 && inView(view, x, z));
    };
    for (let tries = 0; tries < 10; tries++) {
      const r = this.rnd() * C.total;
      let lo = 0, hi = C.cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (C.cum[m] < r) lo = m + 1; else hi = m; }
      const s = C.list[lo];
      const path = this.net.paths[s[0]];
      const t = this.rnd();
      const p0 = path.pts[s[1]], p1 = path.pts[s[1] + 1];
      const x = p0[0] + (p1[0] - p0[0]) * t, z = p0[1] + (p1[1] - p0[1]) * t;
      if (!ok(x, z) || this.occupied(x, z)) continue;
      const Z = this.segZone(path, x, z);
      const roll = this.rnd();
      if (Z.beach > 0.4 && roll < 0.3 && this.spawnMatkot(x, z, px, pz, minR, view)) return true;
      if (Z.busStop > 0.5 && roll < 0.55 && this.spawnBusStop(x, z)) return true;
      if (Z.shop > 0.3 && this.rnd() < 0.5 && this.spawnShop(x, z, ok)) return true;
      if ((Z.promenade > 0.6 || Z.plaza > 0.4 || Z.mall > 0.6) && this.rnd() < 0.05 && this.spawnMusician(path, s[1], t, ok)) return true;
      if (this.rnd() < 0.2 + 0.5 * Z.nightlife && this.spawnBar(x, z, Z, ok)) return true;
      if (this.rnd() < 0.3 && this.spawnSkate(x, z, ok)) return true;
      if (this.rnd() < 0.3 && this.spawnFitness(x, z, ok)) return true;
      if (this.rnd() < 0.14 + 0.16 * Z.park + 0.16 * Z.promenade + 0.08 * Z.plaza && this.spawnBench(x, z, Z, ok)) return true;
      if (Z.park > 0.5 && this.rnd() < 0.12 && this.spawnPlay(x, z, ok)) return true;
      if (Z.plaza > 0.3 && this.rnd() < 0.25 && this.spawnPlaza(x, z, ok)) return true;
      const id = this.pickArchetype(Z);
      if (roll > (Z.park > 0.5 || Z.plaza > 0.4 ? 0.72 : 0.82) && this.spawnGroup(path, s[1], t, Z)) return true;
      const a = ARCH && ARCH[id];
      const cr = a && a.crowd;
      if (cr && cr.squad) {
        const [lo2, hi2] = cr.squad;
        const n = lo2 + Math.floor(this.rnd() * (hi2 - lo2 + 1));
        const lead = this.addNpc(id, { state: 'walk', path, seg: s[1], t });
        lead.lane = -(n - 1) * 0.8;
        for (let i = 1; i < n; i++) {
          const m = this.addNpc(id, { state: 'follow', leader: lead });
          m.lane = lead.lane + i * 1.6;
          m.speed = lead.speed;
        }
        return true;
      }
      if (cr && cr.partner && this.ids.includes(cr.partner)) {
        const lead = this.addNpc(id, { state: 'walk', path, seg: s[1], t });
        const mate = this.addNpc(cr.partner, { state: 'follow', leader: lead });
        const hold = cr.hold === true || (typeof cr.hold === 'number' && this.rnd() < cr.hold);
        lead.lane = hold ? -1.1 : -0.7; mate.lane = -lead.lane; mate.speed = lead.speed;
        if (hold) { lead.mate = mate; mate.mate = lead; }
        return true;
      }
      this.addNpc(id, { state: 'walk', path, seg: s[1], t });
      return true;
    }
    return false;
  }

  // Nightlife squares (HaRova): when the player is around, most bar and restaurant tables there
  // fill up and a few groups stand about on the square. New arrivals appear only out of view (or
  // in the first fill), like every other spawn.
  fillNightlife(px, pz, view) {
    const pois = (this.world && this.world.landmarks && this.world.landmarks.pois) || [];
    const grid = this.barSeats();
    for (const p of pois) {
      const R = NIGHTLIFE[p.id];
      if (!R || Math.hypot(p.x - px, p.z - pz) > R + 220) continue;
      const Z = { ...this.cellZone(p.x, p.z), nightlife: 1, busy: 1 };
      const ok = (x, z) => this.offRoad(x, z, 0.3) && (!this.filled || !view || !inView(view, x, z, 4) || Math.hypot(x - px, z - pz) > 70);
      let tables = 0, used = 0;
      if (grid) for (const l of grid.values()) for (const t of l) {
        if (Math.hypot(t.x - p.x, t.z - p.z) > R) continue;
        tables++;
        if (t.seats.some((q) => q.occ)) used++;
      }
      for (let k = 0; k < 2 && tables && used < tables * 0.7; k++) {
        // aim the bar spawner at a free table inside the square
        const free = [];
        for (const l of grid.values()) for (const t of l) if (!t.seats.some((q) => q.occ) && Math.hypot(t.x - p.x, t.z - p.z) <= R && ok(t.x, t.z)) free.push(t);
        if (!free.length) break;
        const t = free[Math.floor(this.rnd() * free.length)];
        if (this.spawnBar(t.x, t.z, Z, ok)) used++;
      }
      const standing = this.groups.filter((g) => g.kind === 'chat' && Math.hypot(g.x - p.x, g.z - p.z) < R).length;
      if (standing < 3) {
        const a = this.rnd() * Math.PI * 2, r = this.rnd() * R * 0.6;
        const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
        if (ok(x, z) && !this.occupied(x, z, 3)) this.standGroup(x, z, Z, PATH_TOP, 2 + Math.floor(this.rnd() * 3));
      }
    }
  }

  spawnGroup(path, seg, t, Z) {
    const p0 = path.pts[seg], p1 = path.pts[seg + 1];
    const cx = p0[0] + (p1[0] - p0[0]) * t, cz = p0[1] + (p1[1] - p0[1]) * t;
    return !!this.standGroup(cx, cz, Z, path.top, 2 + Math.floor(this.rnd() * 2.2));
  }

  standGroup(cx, cz, Z, top, n) {
    if (!this.offRoad(cx, cz, 0.8)) return null;
    const grp = { kind: 'chat', members: [], x: cx, z: cz, cd: 3 + this.rnd() * 5 };
    const a0 = this.rnd() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const ang = a0 + (i / n) * Math.PI * 2;
      // pull a member in toward the middle rather than let it step onto the road
      let x = 0, z = 0, ok = false;
      for (const r of [1.65 + this.rnd() * 0.35, 1.2, 0.9]) {
        x = cx + Math.sin(ang) * r; z = cz + Math.cos(ang) * r;
        if ((ok = this.offRoad(x, z))) break;
      }
      if (!ok || this.occupied(x, z)) continue;
      const npc = this.addNpc(this.pickArchetype(Z, 'stand'), { state: 'stand', x, z, facing: Math.atan2(cx - x, cz - z), top });
      npc.group = grp;
      grp.members.push(npc);
    }
    if (!grp.members.length) return null;
    this.groups.push(grp);
    return grp;
  }

  // ---- seats -----------------------------------------------------------------------------------
  // Benches, beach pergolas and bus shelters from dressing.js's instanced meshes.
  seats() {
    if (this.seatGrid) return this.seatGrid;
    const grid = new Map(), list = [];
    const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    let dressing = null;
    this.scene.traverse((o) => { if (!dressing && o.name === 'dressing' && o.isGroup) dressing = o; });
    if (dressing) {
      dressing.traverse((o) => {
        const def = o.isInstancedMesh && SEAT_DEFS[o.name];
        if (!def) return;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m);
          m.decompose(pos, q, sc);
          const yaw = 2 * Math.atan2(q.y, q.w), k = sc.x || 1;
          const cs = Math.cos(yaw), sn = Math.sin(yaw);
          const bench = { kind: o.name, seats: [], x: pos.x, z: pos.z };
          for (const lx of def.xs) {
            const lz = def.z;
            const seat = { x: pos.x + (lx * cs + lz * sn) * k, z: pos.z + (-lx * sn + lz * cs) * k, y: pos.y, h: def.h * k, facing: yaw, bench, occ: null };
            bench.seats.push(seat);
            list.push(seat);
          }
          const key2 = key(cellOf(pos.x), cellOf(pos.z));
          let l = grid.get(key2);
          if (!l) grid.set(key2, (l = []));
          l.push(bench);
        }
      });
    }
    // dressing may still be loading on the very first frames; try again later if nothing is there
    if (!list.length && this.frame < 600) return grid;
    this.seatGrid = grid;
    this.seatList = list;
    return grid;
  }

  nearBenches(x, z, r, kind = null) {
    const grid = this.seats();
    const out = [];
    const span = Math.ceil(r / CELL), ix = cellOf(x), iz = cellOf(z);
    for (let a = -span; a <= span; a++) for (let b = -span; b <= span; b++) {
      for (const bn of grid.get(key(ix + a, iz + b)) || []) {
        if (kind ? bn.kind !== kind : bn.kind === 'shelter') continue;
        if (Math.hypot(bn.x - x, bn.z - z) < r) out.push(bn);
      }
    }
    return out;
  }

  sitDown(id, seat, leave) {
    const npc = this.addNpc(id, { state: 'sit', x: seat.x, z: seat.z, facing: seat.facing, top: 0, seat });
    seat.occ = npc;
    npc.leaveT = leave;
    return npc;
  }

  spawnBench(x, z, Z, ok) {
    const free = this.nearBenches(x, z, 45).filter((b) => b.seats.every((s) => !s.occ) && ok(b.x, b.z));
    if (!free.length) return false;
    const bn = free[Math.floor(this.rnd() * free.length)];
    const leave = () => 25 + this.rnd() * 110;
    const r = this.rnd();
    if (r < 0.2 && this.ids.includes('savta')) {
      // two grandmothers catching up
      const a = this.sitDown('savta', bn.seats[0], leave());
      const b = this.sitDown(this.rnd() < 0.5 ? 'savta' : 'older_woman', bn.seats[1], a.leaveT);
      this.chatGroup([a, b]);
      return true;
    }
    if (r < 0.62) {
      const a = this.sitDown(this.pickArchetype(Z, 'sit'), bn.seats[0], leave());
      const b = this.sitDown(this.pickArchetype(Z, 'sit'), bn.seats[1], a.leaveT);
      this.chatGroup([a, b]);
      return true;
    }
    this.sitDown(this.pickArchetype(Z, 'sit'), bn.seats[Math.floor(this.rnd() * bn.seats.length)], leave());
    return true;
  }

  chatGroup(members) {
    const grp = { kind: 'chat', members, x: members[0].x, z: members[0].z, cd: 2 + this.rnd() * 4 };
    for (const m of members) m.group = grp;
    this.groups.push(grp);
    return grp;
  }

  spawnBusStop(x, z) {
    const city = this.world && this.world.city;
    let best = null, bd = 40;
    for (const b of (city && city.busStops) || []) {
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return false;
    if (this.npcs.some((n) => n.stop === best)) return false;
    const n = 1 + Math.floor(this.rnd() * 4);
    const fx = Math.sin(best.angle || 0), fz = Math.cos(best.angle || 0);
    const Z = { ...this.cellZone(best.x, best.z), station: 1 };
    // the shelter's bench fills first
    const shelter = this.nearBenches(best.x, best.z, 16, 'shelter').find((b) => b.seats.every((s) => !s.occ));
    let i = 0;
    if (shelter) {
      const seats = shelter.seats.slice().sort(() => this.rnd() - 0.5);
      for (; i < n && i < 2; i++) {
        const npc = this.sitDown(this.pickArchetype(Z, 'sit'), seats[i], 15 + this.rnd() * 40);
        npc.stop = best;
      }
    }
    for (; i < n; i++) {
      const lat = (i - (n - 1) / 2) * 2.2 + (this.rnd() - 0.5) * 0.6;
      // stops mapped on the carriageway (dual carriageways, motorway stops): try the kerb side,
      // then a step further back, and leave the spot empty rather than stand on the road
      let px = 0, pz = 0, ok = false;
      for (const back of [1.2, 3.0, 4.5]) {
        px = best.x - fx * back + fz * lat; pz = best.z - fz * back - fx * lat;
        if ((ok = this.offRoad(px, pz, 0.8) && !this.occupied(px, pz))) break;
      }
      if (!ok) continue;
      const npc = this.addNpc(this.pickArchetype(Z, 'stand'), { state: 'stand', x: px, z: pz, facing: (best.angle || 0) + (this.rnd() - 0.5) * 0.6, top: SIDE_TOP });
      npc.stop = best;
      npc.leaveT = 15 + this.rnd() * 40; // the bus comes eventually; they walk off along the street
    }
    return true;
  }

  // ---- kiosks and falafel stands: a vendor at the counter and a short queue ---------------------
  shopSpots() {
    if (this.shopList) return this.shopList;
    const net = this.net, city = this.world && this.world.city;
    if (!net || !this.data || this.worldPending) return [];
    const onCar = city && city.onCarriage ? (x, z, m) => { try { return city.onCarriage(x, z, m); } catch (_) { return false; } } : () => false;
    const col = typeof window !== 'undefined' && window.__game && window.__game.collision;
    const blocked = (x, z, r) => (col ? !col.isFree(x, z, r) : false);
    const nodes = [];
    for (const [kind, , , x, z] of this.data.amenities || []) if (SHOP_KINDS.test(kind)) nodes.push([x, z]);
    for (const sh of this.data.shops || []) nodes.push([sh.x, sh.z]);
    for (const p of (this.world.landmarks && this.world.landmarks.pois) || []) if (/kiosk/i.test(p.id || '')) nodes.push([p.x, p.z]);
    const list = [];
    for (const [nx0, nz0] of nodes) {
      if (list.some((s) => Math.hypot(s.x - nx0, s.z - nz0) < 12)) continue;
      const near = this.nearestPath(nx0, nz0, 32);
      if (!near) continue;
      const { path, seg, t } = near;
      const a = path.pts[seg], b = path.pts[seg + 1];
      const px = a[0] + (b[0] - a[0]) * t, pz = a[1] + (b[1] - a[1]) * t;
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      let nx = nx0 - px, nz = nz0 - pz;
      const nl = Math.hypot(nx, nz);
      if (nl < 0.8) continue;
      nx /= nl; nz /= nl;
      // vendor between the walkway and the shop, clear of the building wall
      let vx = px + nx * Math.min(1.8, nl - 0.6), vz = pz + nz * Math.min(1.8, nl - 0.6);
      if (blocked(vx, vz, 0.7)) { vx = px + nx * 0.9; vz = pz + nz * 0.9; }
      if (blocked(vx, vz, 0.6) || onCar(vx, vz, 0.3)) continue;
      const side = hash(nx0 + ',' + nz0) & 1 ? 1 : -1;
      const slots = [];
      const q0x = vx - nx * 2.2, q0z = vz - nz * 2.2;
      for (let k = 0; k < 4; k++) {
        const sx = q0x + tx * side * 2.0 * k, sz = q0z + tz * side * 2.0 * k;
        if (onCar(sx, sz, 0.4) || blocked(sx, sz, 0.5)) break;
        const fx = k ? q0x + tx * side * 2.0 * (k - 1) : vx, fz = k ? q0z + tz * side * 2.0 * (k - 1) : vz;
        slots.push({ x: sx, z: sz, facing: Math.atan2(fx - sx, fz - sz) });
      }
      if (!slots.length) continue;
      list.push({ x: nx0, z: nz0, px, pz, vx, vz, vf: Math.atan2(-nx, -nz), slots, top: path.top, active: null });
    }
    this.shopList = list;
    return list;
  }

  spawnShop(x, z, ok) {
    let best = null, bd = 45;
    for (const sp of this.shopSpots()) {
      if (sp.active) continue;
      const d = Math.hypot(sp.px - x, sp.pz - z);
      if (d < bd && ok(sp.vx, sp.vz)) { bd = d; best = sp; }
    }
    if (!best) return false;
    const Z = this.cellZone(best.px, best.pz);
    const vendor = this.addNpc('kiosk_vendor', { state: 'stand', x: best.vx, z: best.vz, facing: best.vf, top: best.top });
    const grp = { kind: 'queue', spot: best, vendor, members: [vendor], line: [], t: 5 + this.rnd() * 6, joinT: 2 };
    vendor.group = grp;
    best.active = grp;
    const n = Math.min(best.slots.length, Math.floor(this.rnd() * 4));
    for (let i = 0; i < n; i++) {
      const sl = best.slots[i];
      const c = this.addNpc(this.pickArchetype(Z, 'queue'), { state: 'stand', x: sl.x, z: sl.z, facing: sl.facing, top: best.top });
      c.group = grp;
      grp.members.push(c);
      grp.line.push(c);
    }
    this.groups.push(grp);
    return true;
  }

  // ---- buskers on the promenade and squares --------------------------------------------------------
  spawnMusician(path, seg, t, ok) {
    if (!this.ids.includes('street_musician')) return false;
    const p0 = path.pts[seg], p1 = path.pts[seg + 1];
    let tx = p1[0] - p0[0], tz = p1[1] - p0[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const cx = p0[0] + (p1[0] - p0[0]) * t, cz = p0[1] + (p1[1] - p0[1]) * t;
    const side = this.rnd() < 0.5 ? 1 : -1;
    const mx = cx + tz * side * 2.2, mz = cz - tx * side * 2.2;
    return this.placeMusician(mx, mz, Math.atan2(cx - mx, cz - mz), path.top, ok);
  }

  placeMusician(mx, mz, facing, top, ok) {
    if (!ok(mx, mz) || this.occupied(mx, mz, 2.5)) return false;
    for (const n of this.npcs) if (n.id === 'street_musician' && Math.hypot(n.x - mx, n.z - mz) < 220) return false;
    const city = this.world && this.world.city;
    if (!this.offRoad(mx, mz, 1.5)) return false;
    const mus = this.addNpc('street_musician', { state: 'stand', x: mx, z: mz, facing, top });
    const grp = { kind: 'music', members: [mus], x: mx, z: mz, facing, top, joinT: 3, cd: 5 };
    mus.group = grp;
    const Z = this.cellZone(mx, mz);
    const n = Math.floor(this.rnd() * 4);
    for (let i = 0; i < n; i++) this.addListener(grp, this.addNpc(this.pickArchetype(Z, 'stand'), { state: 'stand', x: mx, z: mz, top }), true);
    this.groups.push(grp);
    return true;
  }

  // a semicircle of listeners in front of the busker
  listenerSpot(grp, k) {
    for (let tries = 0; tries < 6; tries++) {
      const ang = grp.facing + (k - 1.5 + (tries ? (this.rnd() - 0.5) * 6 : 0)) * 0.45 + (this.rnd() - 0.5) * 0.2;
      const r = (grp.r0 || 4.2) + this.rnd() * 1.2;
      const x = grp.x + Math.sin(ang) * r, z = grp.z + Math.cos(ang) * r;
      if (this.offRoad(x, z) && !this.occupied(x, z)) return { x, z, facing: Math.atan2(grp.x - x, grp.z - z) };
    }
    return null;
  }

  addListener(grp, npc, instant) {
    const sp = this.listenerSpot(grp, grp.members.length - 1);
    if (!sp) {
      // nowhere safe to stand: a spawned extra goes, a passer-by keeps walking
      if (instant) this.npcs.splice(this.npcs.indexOf(npc), 1);
      return;
    }
    npc.group = grp;
    npc.leaveT = 20 + this.rnd() * 40;
    grp.members.push(npc);
    if (instant) { npc.x = sp.x; npc.z = sp.z; npc.facing = npc.yaw = sp.facing; npc.state = 'stand'; npc.y = this.groundY(npc.x, npc.z, npc.top); }
    else this.sendTo(npc, sp.x, sp.z, sp.facing);
  }

  sendTo(npc, x, z, facing) {
    npc.state = 'goto';
    npc.goal = { x, z, facing };
    npc.cross = null;
    npc.idle = 0;
  }

  // ---- parks: kids playing tag around a spot on the grass, a grown-up keeping an eye ---------------
  spawnPlay(x, z, ok) {
    const polys = this.zoneFeatures && this.zoneFeatures.parkPolys;
    if (!polys || !polys.length) return false;
    const col = typeof window !== 'undefined' && window.__game && window.__game.collision;
    const city = this.world && this.world.city;
    for (let k = 0; k < 10; k++) {
      const sx = x + (this.rnd() - 0.5) * 90, sz = z + (this.rnd() - 0.5) * 90;
      if (!polyHit(polys, sx, sz, 0) || !ok(sx, sz)) continue;
      if (col && !col.isFree(sx, sz, 6)) continue;
      if (city && city.onCarriage) { try { if (city.onCarriage(sx, sz, 6)) continue; } catch (_) { /* optional */ } }
      const kids = ['kid', 'school_kid'].filter((id) => this.ids.includes(id));
      if (!kids.length) return false;
      const n = 3 + Math.floor(this.rnd() * 3);
      const R = 3.2 + this.rnd() * 1.6;
      const grp = { kind: 'play', members: [], x: sx, z: sz, r: R, w: (5 + this.rnd()) / R, flipT: 4 + this.rnd() * 5 };
      for (let i = 0; i < n; i++) {
        const npc = this.addNpc(kids[Math.floor(this.rnd() * kids.length)], { state: 'play', x: sx, z: sz, top: SAND_TOP });
        npc.ang = (i / n) * Math.PI * 2 + this.rnd() * 0.3;
        npc.rr = R * (0.85 + this.rnd() * 0.3);
        npc.speed = grp.w * R;
        npc.group = grp;
        grp.members.push(npc);
      }
      const adult = this.pickArchetype({ park: 1, residential: 0.5 }, 'stand');
      const a = this.rnd() * Math.PI * 2;
      const ax = sx + Math.sin(a) * (R + 4), az = sz + Math.cos(a) * (R + 4);
      if (!this.offRoad(ax, az) || this.occupied(ax, az)) { this.groups.push(grp); return true; }
      const p = this.addNpc(adult, { state: 'stand', x: ax, z: az, facing: Math.atan2(sx - ax, sz - az), top: SAND_TOP });
      p.group = grp;
      grp.members.push(p);
      this.groups.push(grp);
      return true;
    }
    return false;
  }

  // ---- squares and cinema plazas: people standing around, now and then a busker -------------------
  spawnPlaza(x, z, ok) {
    const pois = (this.world && this.world.landmarks && this.world.landmarks.pois) || [];
    const col = typeof window !== 'undefined' && window.__game && window.__game.collision;
    const city = this.world && this.world.city;
    let P = null, bd = 1e9;
    for (const p of pois) {
      if (!PLAZAS[p.id]) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd && d < PLAZAS[p.id] + 90) { bd = d; P = p; }
    }
    if (!P) return false;
    const R = PLAZAS[P.id];
    for (let k = 0; k < 8; k++) {
      const a = this.rnd() * Math.PI * 2, r = R * (0.35 + this.rnd() * 0.75);
      const sx = P.x + Math.sin(a) * r, sz = P.z + Math.cos(a) * r;
      if (!ok(sx, sz)) continue;
      if (col && !col.isFree(sx, sz, 3.2)) continue;
      if (city && city.onCarriage) { try { if (city.onCarriage(sx, sz, 2)) continue; } catch (_) { /* optional */ } }
      const Z = { ...this.cellZone(sx, sz), busy: 1 };
      if (this.rnd() < 0.18 && this.placeMusician(sx, sz, Math.atan2(P.x - sx, P.z - sz), PATH_TOP, ok)) return true;
      if (this.standGroup(sx, sz, Z, PATH_TOP, 2 + Math.floor(this.rnd() * 3))) return true;
    }
    return false;
  }

  spawnMatkot(x, z, px, pz, minR, view) {
    const polys = this.zoneFeatures && this.zoneFeatures.beachPolys;
    if (!polys || !polys.length || !this.ids.includes('beach_guy')) return false;
    // a spot on the sand within 70 units of the walkway sample
    for (let k = 0; k < 14; k++) {
      const sx = x + (this.rnd() - 0.5) * 140, sz = z + (this.rnd() - 0.5) * 140;
      if (!polyHit(polys, sx, sz, 0)) continue;
      const d = Math.hypot(sx - px, sz - pz);
      if (d < minR || d > SPAWN_R || (view && d < 150 && inView(view, sx, sz))) continue;
      const ang = this.rnd() * Math.PI * 2, half = 4.6;
      const ax = sx + Math.sin(ang) * half, az = sz + Math.cos(ang) * half;
      const bx = sx - Math.sin(ang) * half, bz = sz - Math.cos(ang) * half;
      if (!polyHit(polys, ax, az, 0) || !polyHit(polys, bx, bz, 0)) continue;
      const grp = { kind: 'matkot', members: [], x: sx, z: sz, ball: 0, from: 0, dur: 1.15 };
      const a = this.addNpc('beach_guy', { state: 'stand', x: ax, z: az, facing: Math.atan2(bx - ax, bz - az), top: SAND_TOP });
      const pick = this.rnd() < 0.7 ? 'beach_guy' : this.pickArchetype({ beach: 1 });
      const b = this.addNpc(pick, { state: 'stand', x: bx, z: bz, facing: Math.atan2(ax - bx, az - bz), top: SAND_TOP });
      a.group = b.group = grp;
      grp.members.push(a, b);
      this.groups.push(grp);
      return true;
    }
    return false;
  }

  addNpc(id, o) {
    const a = ARCH && ARCH[id];
    // more seeds where an archetype has more whole outfits, so a busy street rarely shows twins
    const looks = (a && a.looks && a.looks.length) || 1;
    const seed = Math.floor(this.rnd() * (id === 'ars_crew' ? 24 : Math.min(24, 6 + looks * 3)));
    const ride = a && a.crowd && a.crowd.ride;
    const pace = a && a.crowd && a.crowd.pace;
    const npc = {
      id, seed, look: id + '#' + seed, av: null, lod: 0, d: 1e9,
      state: o.state, path: o.path || null, seg: o.seg || 0, t: o.t || 0, dir: this.rnd() < 0.5 ? 1 : -1,
      lane: (this.rnd() - 0.5) * 1.6, x: o.x || 0, z: o.z || 0, y: 0, top: o.top ?? (o.path ? o.path.top : SIDE_TOP),
      facing: o.facing || 0, yaw: o.facing || 0, speed: ride ? 11 + this.rnd() * 4 : 2.8 + this.rnd() * 2.0,
      mode: ride ? 'bike' : 'idle', ride: ride || null, idle: this.rnd() * 2, waveCd: 5 + this.rnd() * 20,
      accum: 0, phase: this.rnd() * 6, moving: false, leader: o.leader || null, group: null,
      cross: null, colors: null, seat: o.seat || null, pace: pace || null, yTick: Math.floor(this.rnd() * 4),
      photo: !!(a && a.crowd && a.crowd.photo), dog: !!(a && a.style && a.style.dog), mate: null, holdSide: 0,
    };
    if (pace === 'jog') npc.speed = 8.5 + this.rnd() * 2.5;
    else if (pace === 'fast') npc.speed = 14 + this.rnd() * 4;
    if (id === 'older_man' || id === 'older_woman' || id === 'savta' || id === 'russian_speaking_grandpa') npc.speed *= 0.7;
    if (id === 'mom_stroller' || npc.dog) npc.speed *= 0.8;
    npc.colors = proxyLook(id, seed);
    if (npc.state === 'walk') this.placeOnPath(npc);
    else if (npc.state === 'follow') this.followLeader(npc);
    npc.y = npc.seat ? npc.seat.y : this.groundY(npc.x, npc.z, npc.top);
    this.npcs.push(npc);
    (this.fresh || (this.fresh = [])).push(npc);
    return npc;
  }

  removeNpc(i) {
    const npc = this.npcs[i];
    this.releaseAvatar(npc);
    if (npc.seat && npc.seat.occ === npc) npc.seat.occ = null;
    if (npc.spot && npc.spot.occ === npc) npc.spot.occ = null;
    if (npc.group) this.leaveGroup(npc);
    if (npc.mate && npc.mate.mate === npc) npc.mate.mate = null;
    for (const n of this.npcs) if (n.leader === npc) { n.leader = null; n.state = 'walk'; }
    this.npcs[i] = this.npcs[this.npcs.length - 1];
    this.npcs.pop();
  }

  // A member drops out of its group; groups that lose their anchor (the vendor, the busker, a
  // matkot partner) break up and everyone walks on.
  leaveGroup(npc) {
    const g = npc.group;
    npc.group = null;
    g.members = g.members.filter((m) => m !== npc);
    if (g.line) g.line = g.line.filter((m) => m !== npc);
    const anchorLost = g.kind === 'matkot' || (g.kind === 'queue' && npc === g.vendor) || (g.kind === 'music' && (npc.id === 'street_musician' || !!npc.named));
    if (anchorLost) {
      for (const m of g.members) { m.group = null; if (m.state !== 'sit') this.toWalker(m); }
      g.members = [];
      if (g.spot) g.spot.active = null;
    }
    if (!g.members.length) this.groups = this.groups.filter((q) => q !== g);
  }

  groundY(x, z, top) {
    let g = 0;
    try { g = groundAt(x, z) || 0; } catch (_) { g = 0; }
    const city = this.world && this.world.city;
    if (top !== SAND_TOP) {
      if (city && city.heightAt) {
        const h = city.heightAt(x, z, g + 0.5);
        if (h > g) g = h;
      }
      // raised landmark plazas (squares, the dino lawn) are walked on, not through
      let p = null;
      try { p = plazaAt(x, z); } catch (_) { p = null; }
      if (p != null && p > g) return p + 0.05;
    }
    return g + top;
  }

  // ---- movement ------------------------------------------------------------------------------
  placeOnPath(npc) {
    const p = npc.path;
    npc.seg = clamp(npc.seg, 0, p.pts.length - 2);
    const a = p.pts[npc.seg], b = p.pts[npc.seg + 1];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const lim = p.lanes && p.lanes[npc.seg];
    const want = npc.lane + (npc.avoid || 0);
    const lane = lim ? clamp(want, -lim[1], lim[0]) : want;
    npc.x = a[0] + (b[0] - a[0]) * npc.t + dz * lane;
    npc.z = a[1] + (b[1] - a[1]) * npc.t - dx * lane;
    npc.facing = Math.atan2(dx * npc.dir, dz * npc.dir);
    npc.top = p.top;
  }

  followLeader(npc) {
    const L = npc.leader;
    if (!L || L.state !== 'walk') {
      if (L && L.state === 'cross') {
        // single file behind the leader over the zebra, on the same safe line
        let tx = L.x - Math.sin(L.facing) * 1.3, tz = L.z - Math.cos(L.facing) * 1.3;
        const onZebra = L.cross && L.cross.via && L.cross.via.length === 1;
        // the spot behind the leader can be asphalt (a leader just leaving a kerb): step onto the
        // leader's own track instead, unless both are on the zebra
        if (!onZebra && !this.offRoad(tx, tz, 0)) { tx = L.x; tz = L.z; }
        const nx = npc.x + (tx - npc.x) * 0.25, nz = npc.z + (tz - npc.z) * 0.25;
        if (onZebra || this.offRoad(nx, nz, 0)) { npc.x = nx; npc.z = nz; }
        npc.facing = L.facing; npc.moving = L.moving; return;
      }
      npc.state = 'walk';
      npc.leader = null;
      if (L && L.path) { npc.path = L.path; npc.seg = L.seg; npc.t = L.t; npc.dir = L.dir; this.placeOnPath(npc); }
      return;
    }
    npc.path = L.path; npc.seg = L.seg; npc.t = L.t; npc.dir = L.dir;
    this.placeOnPath(npc);
    // a pavement too narrow to walk abreast: fall in behind instead of inside the leader
    const ddx = npc.x - L.x, ddz = npc.z - L.z;
    if (ddx * ddx + ddz * ddz < SEP_MIN * SEP_MIN) {
      const k = npc.lane > L.lane ? 1 : 2;
      const bx = L.x - Math.sin(L.facing) * 1.7 * k, bz = L.z - Math.cos(L.facing) * 1.7 * k;
      if (this.offRoad(bx, bz, 0)) { npc.x = bx; npc.z = bz; }
    }
    npc.moving = L.moving;
  }

  toWalker(npc) {
    const near = this.nearestPath(npc.x, npc.z, 30);
    if (!near) return false;
    if (npc.seat) { if (npc.seat.occ === npc) npc.seat.occ = null; npc.seat = null; }
    // walk over to the path rather than snapping onto it
    const p = near.path, a = p.pts[near.seg], b = p.pts[near.seg + 1];
    const tx = a[0] + (b[0] - a[0]) * near.t, tz = a[1] + (b[1] - a[1]) * near.t;
    let via = null;
    if (!this.clearLine(npc.x, npc.z, tx, tz)) {
      const zr = this.zebraRoute(npc.x, npc.z, tx, tz);
      if (zr) via = zr;
      else if (npc.d > 70) { npc.x = tx; npc.z = tz; } // out of sight: just be there
      else return false;
    }
    npc.state = 'cross';
    npc.cross = { x: tx, z: tz, e: null, path: p, seg: near.seg, t: near.t, via: via ? via.via.slice() : null, zebra: via ? via.c : null };
    npc.top = npc.top === SAND_TOP ? SAND_TOP : PATH_TOP;
    npc.stop = null;
    npc.leaveT = undefined;
    return true;
  }

  nearestPath(x, z, maxD) {
    const net = this.net;
    let best = null, bd = maxD;
    const span = Math.ceil(maxD / CELL);
    const ix = cellOf(x), iz = cellOf(z);
    for (let a = -span; a <= span; a++) for (let b = -span; b <= span; b++) {
      for (const s of net.grid.get(key(ix + a, iz + b)) || []) {
        const path = net.paths[s[0]];
        const p0 = path.pts[s[1]], p1 = path.pts[s[1] + 1];
        const vx = p1[0] - p0[0], vz = p1[1] - p0[1];
        const L2 = vx * vx + vz * vz || 1;
        const t = clamp(((x - p0[0]) * vx + (z - p0[1]) * vz) / L2, 0, 1);
        const d = Math.hypot(p0[0] + vx * t - x, p0[1] + vz * t - z);
        if (d < bd) { bd = d; best = { path, seg: s[1], t }; }
      }
    }
    return best;
  }

  advance(npc, dist) {
    let guard = 0;
    while (dist > 0 && guard++ < 40) {
      const p = npc.path.pts;
      const a = p[npc.seg], b = p[npc.seg + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 0.001;
      const remain = npc.dir > 0 ? (1 - npc.t) * len : npc.t * len;
      if (dist < remain) { npc.t += (npc.dir * dist) / len; return; }
      dist -= remain;
      if (npc.dir > 0) {
        if (npc.seg + 1 >= p.length - 1) { npc.t = 1; this.atPathEnd(npc, p[p.length - 1]); return; }
        npc.seg++; npc.t = 0;
      } else {
        if (npc.seg === 0) { npc.t = 0; this.atPathEnd(npc, p[0]); return; }
        npc.seg--; npc.t = 1;
      }
    }
  }

  // End of a sidewalk run: cross to another run's end nearby (the far kerb at a junction, or
  // round the corner); otherwise turn back.
  atPathEnd(npc, end) {
    const net = this.net;
    const opts = [];
    const ix = cellOf(end[0]), iz = cellOf(end[1]);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const e of net.ends.get(key(ix + a, iz + b)) || []) {
        if (e.path === npc.path) continue;
        const d = Math.hypot(e.x - end[0], e.z - end[1]);
        if (d < 34 && d > 0.5) opts.push(e);
      }
    }
    // round the corner on the pavement, or across the road at a zebra; never straight over the asphalt
    let pick = null;
    while (opts.length && !pick) {
      const e = opts.splice(Math.floor(this.rnd() * opts.length), 1)[0];
      // from where the walker actually stands (its lane is off the centre line), not the path end
      if (this.clearLine(npc.x, npc.z, e.x, e.z)) pick = { e, via: null };
      else { const zr = this.zebraRoute(npc.x, npc.z, e.x, e.z); if (zr) pick = { e, via: zr }; }
    }
    if (pick && this.rnd() < 0.85) {
      const e = pick.e;
      npc.cross = { x: e.x, z: e.z, e, via: pick.via ? pick.via.via.slice() : null, zebra: pick.via ? pick.via.c : null };
      npc.state = 'cross';
      npc.idle = this.rnd() < 0.5 ? 0.6 + this.rnd() * 1.5 : 0; // a look both ways at the kerb
      return;
    }
    npc.dir = -npc.dir;
    npc.idle = 0.8 + this.rnd() * 2;
  }

  // ---- per-frame -----------------------------------------------------------------------------
  update(dt, px, pz) {
    if (this.worldPending) return;
    this.frame++;
    this.t += dt;
    if (!this.ensureNetwork()) return;
    this.resealNetwork();
    const cam = (typeof window !== 'undefined' && window.__game && window.__game.camera) || null;
    const view = cam ? viewInfo(cam) : null;

    // how fast the player moves (people start when someone rushes past them)
    this.pSpeed = this.last && dt > 0 ? Math.hypot(px - this.last.x, pz - this.last.z) / dt : 0;
    // a teleport (respawn, quest reset) gets a fresh crowd around the new spot at once
    if (this.last && Math.hypot(px - this.last.x, pz - this.last.z) > 120) { this.filled = false; this.desiredT = 0; }
    this.last = { x: px, z: pz };

    // density target from the weighted sidewalk length around the player
    this.desiredT -= dt;
    if (this.desiredT <= 0) {
      this.desiredT = 1.5;
      const C = this.candidates(px, pz);
      this.desired = Math.round(clamp(C.total * DENSITY * 0.55 + C.near * DENSITY * 0.6, MIN_NPC, this.max));
      if (C.total === 0) this.desired = 0;
    }

    // recycle: drop the far ones, add new ones in a ring (or out of view) until the target is met
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const n = this.npcs[i];
      const d = Math.hypot(n.x - px, n.z - pz);
      if (n.keep) continue;
      if (d > DESPAWN_R || (this.npcs.length > this.desired * 1.2 && d > HIDE_R && !n.group)) this.removeNpc(i);
    }
    let budget = this.filled ? 3 : this.desired;
    while (this.npcs.length < this.desired && budget-- > 0) {
      if (!this.spawnOne(px, pz, this.filled ? 30 : 6, this.filled ? view : null)) break;
    }
    this.filled = true;

    if (this.frame % 120 === 7) this.barSeats();
    if (this.frame % 45 === 11) this.fillNightlife(px, pz, view);
    this.updateNamed(dt, view);

    // simulate (each mover's last spot is kept so resolveOverlaps can hold it there)
    for (const n of this.npcs) {
      if (n.d < SEP_R) { const S = n.snap || (n.snap = {}); S.x = n.x; S.z = n.z; S.state = n.state; S.path = n.path; S.seg = n.seg; S.t = n.t; S.dir = n.dir; }
      this.step(n, dt, px, pz);
    }
    for (const g of this.groups) this.stepGroup(g, dt);
    this.separate(dt, px, pz);
    this.resolveOverlaps();
    // a skater nudged aside rides the surface where they ended up
    for (const n of this.npcs) if (n.state === 'skate' && n.skx !== undefined && (n.x !== n.skx || n.z !== n.skz)) n.y += this.skateY(n, n.x, n.z) - this.skateY(n, n.skx, n.skz);
    this.gaitClock(dt);

    // LOD: nearest MAX_FULL inside FULL_R get full avatars
    const near = [];
    for (const n of this.npcs) {
      n.d = Math.hypot(n.x - px, n.z - pz);
      if (n.d < (n.av ? FULL_OUT : FULL_R)) near.push(n);
      else if (n.av) this.releaseAvatar(n);
    }
    near.sort((a, b) => a.d - b.d);
    let made = 0;
    for (let i = 0; i < near.length; i++) {
      const n = near[i];
      if (i >= MAX_FULL) { if (n.av) this.releaseAvatar(n); continue; }
      if (!n.av) {
        const ok = this.acquireAvatar(n, made < CREATE_BUDGET);
        if (ok === 'new') made++;
      }
    }
    for (const n of this.npcs) n.lod = n.av ? 2 : n.d < HIDE_R ? 1 : 0;

    // full avatars: pose every frame up close or on screen, ~15 Hz otherwise
    for (const n of this.npcs) {
      if (!n.av) continue;
      const g = n.av.group;
      const sh = n.d < SHADOW_R;
      const det = n.d < 28;
      if (n.avDetail !== det) { n.avDetail = det; try { n.av.setDetail && n.av.setDetail(det); } catch (_) { /* optional */ } }
      if (n.avShadow !== sh) {
        n.avShadow = sh;
        g.traverse((o) => { if (o.isMesh) { if (o.userData.cs0 === undefined) o.userData.cs0 = o.castShadow; o.castShadow = sh && o.userData.cs0; } });
      }
      g.position.set(n.x, n.y, n.z);
      if (n.state === 'skate') { g.rotation.order = 'YXZ'; g.rotation.x = -(n.pitch || 0); }
      else if (g.rotation.x) g.rotation.x = 0;
      g.rotation.y = n.yaw;
      if (n.state === 'skate' && n.avPush !== n.push) { n.avPush = n.push; try { n.av.setSkate && n.av.setSkate({ push: !!n.push }); } catch (_) { /* optional */ } }
      n.accum += dt;
      const onScreen = !view || inView(view, n.x, n.z, 6);
      if (n.d < 25 || (onScreen && (n.d < 45 || n.accum > 0.033)) || n.accum > 0.066) {
        const mobile = n.state === 'walk' || n.state === 'follow' || n.state === 'cross' || n.state === 'goto' || n.state === 'play';
        const want = n.state === 'sit' ? 'sit' : n.state === 'skate' ? 'skate' : mobile ? (n.ride ? 'bike' : n.moving || n.vel > 0.6 ? 'walk' : 'idle') : n.vel > 0.6 ? 'walk' : 'idle';
        const mode = n.ride ? 'bike' : want;
        if (n.avPlaying !== n.playing) { n.avPlaying = n.playing; try { n.av.setPlaying && n.av.setPlaying(n.playing || false); } catch (_) { /* optional */ } }
        if (n.state === 'workout' || n.avWorkout) {
          const wk = n.state === 'workout' ? n.wk || null : null;
          n.avWorkout = wk;
          try { n.av.setWorkout && n.av.setWorkout(wk, n.rep || 0); } catch (_) { /* optional */ }
        }
        if (n.avHeld !== n.held) { n.avHeld = n.held; try { n.av.setHeld && n.av.setHeld(n.held || null); } catch (_) { /* optional */ } }
        if (n.avMode !== mode) {
          n.avMode = mode;
          try {
            if (mode === 'sit' && n.seat && n.av.setSeat && n.playing !== 'drums') n.av.setSeat(n.seat.h, { table: !!n.seat.table });
            n.av.setMode && n.av.setMode(mode);
          } catch (_) { /* optional */ }
        }
        // hand in hand: the hand on the partner's side, while they walk together
        let hs = 0;
        const m = n.mate;
        if (m && (n.state === 'walk' || n.state === 'follow') && (m.state === 'walk' || m.state === 'follow')) {
          const dx = m.x - n.x, dz = m.z - n.z;
          if (dx * dx + dz * dz < 12) hs = dx * Math.cos(n.yaw) - dz * Math.sin(n.yaw) > 0 ? 1 : -1;
        }
        if (hs !== n.holdSide) { n.holdSide = hs; try { n.av.setHold && n.av.setHold(hs); } catch (_) { /* optional */ } }
        try { n.av.update && n.av.update(n.accum, n.ride ? (n.moving ? n.speed : 0) : n.vel || 0); } catch (e) {
          if (!this._warned) { console.warn('[npcs] avatar.update failed', e); this._warned = true; }
        }
        n.accum = 0;
      }
    }

    // proxies: one instanced draw per body part, refreshed at ~30 Hz
    this.proxyAcc += dt;
    if (this.proxyAcc > 0.033) {
      writeProxies(this.proxy, this.npcs, this.proxyAcc, this.groups, view);
      this.proxyAcc = 0;
    }
  }

  step(n, dt, px, pz) {
    n.moving = false;
    // greet the player now and then (full avatars only, so it is seen)
    n.waveCd -= dt;
    if (n.av && n.d < 9 && n.waveCd <= 0 && n.state !== 'cross' && n.state !== 'play' && n.state !== 'skate' && !n.playing && !n.ride && n.pace !== 'jog') {
      n.waveCd = 25 + this.rnd() * 30;
      if (this.rnd() < 0.4) {
        n.greet = n.state === 'sit' || n.id === 'kiosk_vendor' || n.id === 'street_musician' ? 0.01 : 2.2;
        try { n.av.emote && n.av.emote('wave'); } catch (_) { /* optional */ }
        this.bark(n);
      }
    }
    if (n.av && n.d < 4 && this.pSpeed > 14 && this.pSpeed < 80 && !(n.surpT > 0)) {
      n.surpT = 6;
      try { n.av.express && n.av.express('surprised', 1.1); } catch (_) { /* optional */ }
    }
    if (n.surpT > 0) n.surpT -= dt;
    if (n.greet > 0) {
      n.greet -= dt;
      turnTo(n, Math.atan2(px - n.x, pz - n.z), dt);
      return;
    }
    if (n.gigT !== undefined) {
      n.gigT -= dt;
      if (n.gigT <= 0) { this.stopGig(n); return; }
    }
    if (n.state === 'skate') { this.stepSkate(n, dt); return; }
    if (n.state === 'workout') { this.stepWorkout(n, dt); return; }
    if (n.state === 'sit') {
      n.leaveT -= dt;
      // stand up and walk on (the far ones simply stay put until they despawn)
      if (n.leaveT < 0 && !(n.group && n.group.members.length > 1 && this.rnd() < 0.5)) {
        if (n.group) this.leaveGroup(n);
        if (!this.toWalker(n)) n.leaveT = 30;
      } else if (n.leaveT < 0) n.leaveT = 10 + this.rnd() * 20;
      turnTo(n, n.facing, dt);
      return;
    }
    if (n.state === 'stand') {
      if (n.leaveT !== undefined) {
        n.leaveT -= dt;
        if (n.leaveT < 0) { n.leaveT = undefined; if (n.group) this.leaveGroup(n); this.toWalker(n); }
      }
      turnTo(n, n.facing, dt);
      return;
    }
    if (n.state === 'play') {
      const g = n.group;
      if (!g) { this.toWalker(n); return; }
      n.ang += g.w * dt * (g.dir || 1) * (n.rr ? g.r / n.rr : 1);
      const x = g.x + Math.sin(n.ang) * n.rr, z = g.z + Math.cos(n.ang) * n.rr;
      n.facing = Math.atan2(x - n.x, z - n.z);
      n.x = x; n.z = z;
      n.moving = true;
      if ((this.frame + n.yTick) % 3 === 0) n.y = this.groundY(n.x, n.z, n.top);
      turnTo(n, n.facing, dt);
      return;
    }
    if (n.state === 'goto') {
      const G = n.goal;
      const dx = G.x - n.x, dz = G.z - n.z, d = Math.hypot(dx, dz);
      const stepLen = Math.min(n.speed, 4.5) * dt;
      if (d <= stepLen) { n.x = G.x; n.z = G.z; n.state = 'stand'; n.facing = G.facing; n.goal = null; }
      else { n.x += (dx / d) * stepLen; n.z += (dz / d) * stepLen; n.facing = Math.atan2(dx, dz); n.moving = true; }
      n.y = this.groundY(n.x, n.z, n.top);
      turnTo(n, n.facing, dt);
      return;
    }
    if (n.state === 'follow') {
      n.idle = 0;
      this.followLeader(n);
      if (n.state === 'follow') {
        if (n.d < 90 || (this.frame + n.yTick) % 3 === 0) n.y = this.groundY(n.x, n.z, n.top);
          turnTo(n, n.facing, dt);
        return;
      }
    }
    if (n.idle > 0) {
      n.idle -= dt;
      if (n.photoT > 0) { n.photoT -= dt; if (n.photoT <= 0 && n.av && n.av.emote) { try { n.av.emote('photo'); } catch (_) { /* optional */ } } }
      turnTo(n, n.facing, dt);
      return;
    }
    if (n.state === 'cross') {
      const c = n.cross;
      const wp = c.via && c.via.length ? c.via[0] : null;
      const gx = wp ? wp[0] : c.x, gz = wp ? wp[1] : c.z;
      const dx = gx - n.x, dz = gz - n.z, d = Math.hypot(dx, dz);
      const stepLen = n.speed * dt;
      if (wp && d <= stepLen) {
        // at a zebra kerb: on to the next point, after waiting for cars on the near side
        n.x = gx; n.z = gz;
        if (c.via.length === 2 && c.zebra && this.carNear(c.zebra)) { n.idle = 0.6; n.facing = Math.atan2(c.via[1][0] - gx, c.via[1][1] - gz); return; }
        c.via.shift();
      } else if (d <= stepLen) {
        const e = c.e;
        if (e) { n.path = e.path; n.seg = e.end ? e.path.pts.length - 2 : 0; n.t = e.end ? 1 : 0; n.dir = e.end ? -1 : 1; }
        else { n.path = c.path; n.seg = c.seg; n.t = c.t; n.dir = this.rnd() < 0.5 ? 1 : -1; }
        n.state = 'walk'; n.cross = null;
        this.placeOnPath(n);
      } else {
        const nx = n.x + (dx / d) * stepLen, nz = n.z + (dz / d) * stepLen;
        const zebraLeg = c.via && c.via.length === 1;
        if (!zebraLeg && !this.offRoad(nx, nz, 0)) {
          // last line of defence: never step onto asphalt outside a zebra
          n.cross = null;
          if (c.e && n.path) { n.state = 'walk'; n.dir = -n.dir; n.idle = 0.5; this.placeOnPath(n); }
          else if (n.d > 70 && c.path) { n.path = c.path; n.seg = c.seg; n.t = c.t; n.state = 'walk'; this.placeOnPath(n); }
          else { n.state = 'stand'; n.leaveT = 4 + this.rnd() * 6; }
          return;
        }
        n.x = nx; n.z = nz;
        n.facing = Math.atan2(dx, dz);
        if (n.top !== SAND_TOP) n.top = PATH_TOP;
      }
      n.moving = true;
    } else {
      // pause rather than walk through the player
      const fx = Math.sin(n.facing), fz = Math.cos(n.facing);
      const rx = px - n.x, rz = pz - n.z;
      const ahead = rx * fx + rz * fz;
      if (ahead > 0 && ahead < 3.2 && Math.abs(rx * fz - rz * fx) < 1.6) { n.idle = 0.6; return; }
      this.advance(n, n.speed * dt * (n.block > 0 ? n.block : 1));
      if (n.state === 'walk') this.placeOnPath(n);
      n.moving = n.state === 'walk' || n.state === 'cross';
      if (!n.ride && n.pace !== 'jog') {
        // stop to look around; dogs stop to sniff more often; tourists stop for a picture
        const r1 = this.rnd();
        if (r1 < dt * (n.dog ? 0.09 : 0.03)) { if (this.offRoad(n.x, n.z, 0.3)) n.idle = 1.5 + this.rnd() * 4; }
        else if (n.photo && r1 < dt * 0.06 && this.offRoad(n.x, n.z, 0.3)) { n.idle = 3.4; n.photoT = 0.3; }
      }
    }
    if (n.d < 90 || (this.frame + n.yTick) % 3 === 0) n.y = this.groundY(n.x, n.z, n.top);
    turnTo(n, n.facing, dt);
  }

  stepGroup(g, dt) {
    if (g.kind === 'chat') {
      g.cd -= dt;
      if (g.cd <= 0) {
        g.cd = 4 + this.rnd() * 7;
        const m = g.members[Math.floor(this.rnd() * g.members.length)];
        if (m && m.av && m.av.emote) { try { m.av.emote(this.rnd() < 0.7 ? 'argue' : 'wave'); } catch (_) { /* optional */ } this.bark(m); }
        // the others laugh at the story now and then
        if (this.rnd() < 0.35) for (const o of g.members) if (o !== m && o.av && o.av.express) { try { o.av.express('laugh', 1.2 + this.rnd()); } catch (_) { /* optional */ } }
      }
      return;
    }
    if (g.kind === 'queue') {
      g.t -= dt;
      if (g.t <= 0) {
        g.t = 7 + this.rnd() * 9;
        const front = g.line[0];
        if (front && front.state === 'stand') {
          // served: a wave to the vendor, then off down the street; the line steps up
          try { front.av && front.av.emote && front.av.emote('wave'); } catch (_) { /* optional */ }
          try { g.vendor.av && g.vendor.av.emote && g.vendor.av.emote('wave'); } catch (_) { /* optional */ }
          this.bark(g.vendor);
          this.leaveGroup(front);
          front.leaveT = undefined;
          this.toWalker(front);
          g.line.forEach((m, i) => { const sl = g.spot.slots[i]; this.sendTo(m, sl.x, sl.z, sl.facing); });
        }
      }
      g.joinT -= dt;
      if (g.joinT <= 0) {
        g.joinT = 1.5;
        const k = g.line.length;
        if (k < g.spot.slots.length && this.rnd() < 0.35) {
          const sl = g.spot.slots[k];
          const w = this.occupied(sl.x, sl.z) ? null : this.passerby(sl.x, sl.z, 16);
          if (w) {
            w.group = g; g.members.push(w); g.line.push(w);
            this.sendTo(w, sl.x, sl.z, sl.facing);
          }
        }
      }
      return;
    }
    if (g.kind === 'music') {
      g.joinT -= dt;
      if (g.joinT <= 0) {
        g.joinT = 2;
        if (g.members.length < 6 && this.rnd() < 0.3) {
          const w = this.passerby(g.x, g.z, 18);
          if (w) this.addListener(g, w, false);
        }
      }
      g.cd -= dt;
      if (g.cd <= 0) { g.cd = 6 + this.rnd() * 8; const m = g.members[1 + Math.floor(this.rnd() * (g.members.length - 1))]; if (m && m.av && m.av.emote) { try { m.av.emote('wave'); } catch (_) { /* optional */ } } }
      return;
    }
    if (g.kind === 'bar') {
      g.cd -= dt;
      if (g.cd <= 0) {
        if (this.rnd() < 0.3 && g.members.length > 1) {
          // "le'chaim!": glasses up together
          g.cd = 14 + this.rnd() * 20;
          for (const m of g.members) if (m.av && m.av.emote) { try { m.av.emote('toast'); } catch (_) { /* optional */ } }
          this.bark(g.members[0]);
        } else {
          g.cd = 3 + this.rnd() * 6;
          const m = g.members[Math.floor(this.rnd() * g.members.length)];
          if (m && m.av && m.av.emote) { try { m.av.emote(this.rnd() < 0.5 ? 'drink' : 'argue'); } catch (_) { /* optional */ } }
        }
      }
      return;
    }
    if (g.kind === 'play') {
      g.flipT -= dt;
      if (g.flipT <= 0) { g.flipT = 4 + this.rnd() * 6; g.dir = -(g.dir || 1); }
      return;
    }
    if (g.kind === 'matkot' && g.members.length === 2) {
      g.ball += dt / g.dur;
      if (g.ball >= 1) {
        g.ball -= 1;
        g.from = 1 - g.from;
        g.dur = 0.9 + this.rnd() * 0.5;
      }
      // the receiver swings just before the ball arrives
      const recv = g.members[1 - g.from];
      if (g.ball > 0.72 && !g.swung) {
        g.swung = true;
        if (recv.av && recv.av.emote) { try { recv.av.emote('swing'); } catch (_) { /* optional */ } }
      }
      if (g.ball < 0.5) g.swung = false;
    }
  }

  // A plain walker nearby who could stop for a falafel or a song.
  passerby(x, z, r) {
    for (const n of this.npcs) {
      if (n.state !== 'walk' || n.group || n.ride || n.pace || n.mate || n.dog ) continue;
      if (this.npcs.some((m) => m.leader === n)) continue;
      if (Math.abs(n.x - x) < r && Math.abs(n.z - z) < r) return n;
    }
    return null;
  }

  // Optional voice blips from the audio module (it rate-limits itself); only for people close by.
  bark(n) {
    if (!n || n.d > 20) return;
    const audio = typeof window !== 'undefined' && window.__game && window.__game.audio;
    if (!audio || typeof audio.playBark !== 'function') return;
    try { const r = audio.playBark(n.id, { x: n.x, z: n.z }); if (r && r.catch) r.catch(() => {}); } catch (_) { /* optional */ }
  }

  // ---- the regulars: Dekel, Ofir, Adir, Malul ------------------------------------------------------
  // One of each in the whole city, simulated wherever they are (they never despawn). They walk the
  // streets of their haunts, now and then stop to play with a few people gathering to listen, and
  // move between haunts while the player is elsewhere. Ofir brings a different instrument each time.
  homeAnchor(kind) {
    const d = this.data, F = this.zoneFeatures;
    const pick = (list) => list[Math.floor(this.rnd() * list.length)];
    if (kind === 'ganim' && d && d.places) {
      const p = d.places.find((q) => /ganim/i.test(q.en));
      if (p) return { kind, x: p.x, z: p.z, r: 320 };
    }
    if (kind === 'tizmoret' && d && d.tizmoret && d.tizmoret.length) {
      const q = pick(d.tizmoret);
      return { kind, x: q[0], z: q[1], r: 140 };
    }
    if (kind === 'beach' && F && F.promenade && F.promenade.length) {
      const q = pick(F.promenade);
      return { kind, x: q.x, z: q.z, r: 160 };
    }
    if (kind === 'plaza') {
      const pois = ((this.world && this.world.landmarks && this.world.landmarks.pois) || []).filter((p) => /founders_square|cinema_city|yes_planet/.test(p.id));
      if (pois.length) { const p = pick(pois); return { kind, x: p.x, z: p.z, r: 80 }; }
    }
    return null;
  }

  instrumentOf(id, seed) {
    try {
      const c = resolveConfig ? resolveConfig({ archetype: id, seed }) : null;
      const a = c && (c.accessories || []).find((q) => INSTRUMENTS.test(q.type));
      return a ? a.type : null;
    } catch (_) { return null; }
  }

  placeNamed(rec, npc) {
    const def = NAMED[rec.name];
    for (let tries = 0; tries < 6; tries++) {
      const homes = def.homes;
      const kind = tries < 3 && this.rnd() < 0.55 ? homes[0] : homes[Math.floor(this.rnd() * homes.length)];
      const H = this.homeAnchor(kind);
      if (!H) continue;
      const a = this.rnd() * Math.PI * 2, r = this.rnd() * H.r * 0.8;
      const near = this.nearestPath(H.x + Math.sin(a) * r, H.z + Math.cos(a) * r, 80);
      if (!near || !KIND_DENSITY[near.path.kind] && near.path.kind !== 'promenade') continue;
      rec.home = H;
      if (!npc) return { home: H, near };
      npc.path = near.path; npc.seg = near.seg; npc.t = near.t; npc.state = 'walk'; npc.cross = null;
      this.placeOnPath(npc);
      npc.y = this.groundY(npc.x, npc.z, npc.top);
      return { home: H, near };
    }
    return null;
  }

  // The lookout: its benches, where each friend sits (two to a bench, facing the view over the
  // road, Malul on his stool with the kit at the end of the second bench) and the tree.
  lookout() {
    if (this.look && (this.look.final || this.frame - this.look.frame < 300)) return this.look;
    const L = this.world && this.world.landmarks;
    const poi = ((L && L.pois) || []).find((p) => p.id === 'cliff_lookout');
    const spots = poi && Array.isArray(poi.spots) ? poi.spots : null;
    const benches = [];
    for (const q of spots || []) {
      if (!/bench|picnic|table/i.test(q.kind || '')) continue;
      const a = Array.isArray(q.a) ? q.a : [q.x, 0, q.z], b = Array.isArray(q.b) ? q.b : a;
      benches.push({ x: (a[0] + b[0]) / 2, z: (a[2] + b[2]) / 2, ax: b[0] - a[0], az: b[2] - a[2] });
    }
    const F = LOOKOUT_FALLBACK;
    if (!benches.length) for (const [x, z] of F.benches) benches.push({ x, z, ax: 0, az: 0 });
    const treeQ = (spots || []).find((q) => /tree/i.test(q.kind || ''));
    const tree = treeQ ? (Array.isArray(treeQ.a) ? [treeQ.a[0], treeQ.a[2]] : [treeQ.x, treeQ.z]) : F.tree;
    const cx = poi ? poi.x : F.x, cz = poi ? poi.z : F.z;
    const seats = [];
    // landmarks.js publishes the picnic seats themselves: a = the seat (its top height), b = a
    // point out along the view
    for (const q of spots || []) {
      if (!/seat/i.test(q.kind || '') || !Array.isArray(q.a)) continue;
      const [x, y, z] = q.a, bb = Array.isArray(q.b) ? q.b : [x, y, z + 1];
      const gy = this.groundY(x, z, 0);
      seats.push({ x, z, y: gy, h: clamp(y - gy, 0.8, 2), facing: Math.atan2(bb[0] - x, bb[2] - z), occ: null, own: true, lookout: true });
    }
    const bs = seats.length >= 4 ? [] : benches.slice(0, 2);
    if (bs.length) seats.length = 0;
    bs.forEach((bn, i) => {
      // face the view: from the benches toward the tree at the cliff edge
      const facing = Math.atan2(tree[0] - bn.x, tree[1] - bn.z);
      const fx = Math.sin(facing), fz = Math.cos(facing);
      const px = fz, pz = -fx; // along the bench
      const back = 0.9; // the bench seat on the near side of the table
      for (const k of [-1, 1]) {
        const x = bn.x - fx * back + px * k * 1.05, z = bn.z - fz * back + pz * k * 1.05;
        seats.push({ x, z, y: this.groundY(x, z, 0), h: SEAT_DEFS.bench.h, facing, occ: null, own: true, lookout: true });
      }
    });
    while (seats.length < 4) {
      const k = seats.length, a = (k / 4) * Math.PI * 2;
      const x = cx + Math.sin(a) * 3, z = cz + Math.cos(a) * 3;
      seats.push({ x, z, y: this.groundY(x, z, 0), h: SEAT_DEFS.bench.h, facing: Math.atan2(tree[0] - x, tree[1] - z), occ: null, own: true, lookout: true });
    }
    // Malul drums from a stool at the free end of the second bench, the kit in front of him
    const m = seats[3], o = seats[2];
    const ex = m.x + (m.x - o.x) * 1.2, ez = m.z + (m.z - o.z) * 1.2;
    seats[3] = { x: ex, z: ez, y: this.groundY(ex, ez, 0), h: 1.95 * BODY, facing: m.facing, occ: null, own: true, lookout: true, stool: true };
    this.look = { x: cx, z: cz, seats, tree, final: !!poi, frame: this.frame };
    return this.look;
  }

  // Where a friend ends up when nobody sees: the lookout once the story opened it, else one of
  // their old haunts (the lookout stays the fallback when no haunt has a path).
  settleNamed(rec, n) {
    if (!this.lookoutOpen) {
      if (!n) {
        n = this.addNpc(rec.name, { state: 'stand', x: 0, z: 0, top: 0 });
        if (n && this.placeNamed(rec, n)) { rec.away = 0; return n; }
        const i = n ? this.npcs.indexOf(n) : -1;
        if (i >= 0) this.removeNpc(i);
        return this.toLookout(rec, null);
      }
      if (n.seat && n.seat.occ === n) n.seat.occ = null;
      n.seat = null; n.playing = false; n.leaveT = undefined;
      if (this.placeNamed(rec, n)) { rec.away = 0; return n; }
    }
    return this.toLookout(rec, n);
  }

  setLookoutOpen(open) { this.lookoutOpen = !!open; }

  // Seat a friend at the lookout (a fresh npc, or the wandering one brought back unseen).
  toLookout(rec, n) {
    const def = NAMED[rec.name], Lk = this.lookout();
    const seat = Lk.seats[def.seat % Lk.seats.length];
    if (!n) n = this.addNpc(rec.name, { state: 'sit', x: seat.x, z: seat.z, facing: seat.facing, top: 0, seat });
    else {
      if (n.group) this.leaveGroup(n);
      n.state = 'sit'; n.path = null; n.cross = null; n.goal = null; n.x = seat.x; n.z = seat.z; n.facing = n.yaw = seat.facing; n.seat = seat;
      n.y = seat.y;
    }
    seat.occ = n;
    n.leaveT = 1e9;
    n.gigT = undefined;
    rec.home = { kind: 'lookout', x: Lk.x, z: Lk.z, r: 40 };
    rec.away = 0;
    rec.jamT = 8 + this.rnd() * 20;
    n.playing = def.drums && seat.stool ? 'drums' : true;
    return n;
  }

  // Quest hook: the friend plays right where they are (stood or seated; Malul at his kit when
  // drums is asked) for `seconds`, then goes back to what they were doing.
  playNamed(id, seconds = 20, opts = {}) {
    const rec = this.namedRec[id], n = rec && rec.npc;
    if (!n || !this.npcs.includes(n)) return false;
    const drums = !!(opts.drums && NAMED[id] && NAMED[id].drums);
    rec.forceT = Math.max(0.5, seconds);
    if (n.state === 'sit') {
      if (drums && !(n.seat && n.seat.stool)) {
        n.seat = { x: n.x, z: n.z, y: n.y, h: 1.95 * BODY, facing: n.facing, occ: n, own: true };
        n.avMode = null; // re-seat on the stool
      }
      n.playing = drums ? 'drums' : true;
      return true;
    }
    if (n.group) this.leaveGroup(n);
    n.path = n.path || null; n.cross = null; n.goal = null; n.idle = 0;
    rec.forceWalk = n.state === 'walk' || n.state === 'follow';
    if (drums) {
      n.state = 'sit'; n.leaveT = 1e9;
      n.seat = { x: n.x, z: n.z, y: n.y, h: 1.95 * BODY, facing: n.facing, occ: n, own: true };
      n.playing = 'drums';
    } else { n.state = 'stand'; n.leaveT = 1e9; n.playing = true; }
    return true;
  }

  updateNamed(dt, view) {
    if (!this.net || !this.data || !ARCH || !this.zoneFeatures) return;
    for (const name of Object.keys(NAMED)) {
      if (!ARCH[name] || !this.ids.includes(name)) continue;
      let rec = this.namedRec[name];
      if (!rec) {
        rec = this.namedRec[name] = { name, npc: null, home: null, gigCd: 20 + this.rnd() * 60, relocT: 15, met: false, inst: null, info: { id: name } };
      }
      let n = rec.npc;
      // A quest is showing its own copy of this character: keep the wandering one out of sight.
      if (rec.held) {
        if (n) { const i = this.npcs.indexOf(n); if (i >= 0) this.removeNpc(i); rec.npc = null; }
        this.named[name] = null;
        continue;
      }
      if (!n || !this.npcs.includes(n)) {
        n = this.settleNamed(rec, null);
        n.keep = true;
        n.named = name;
        n.speed = 3.2 + this.rnd() * 0.8;
        if (NAMED[name].reroll) this.rerollInstrument(rec, n);
        rec.inst = this.instrumentOf(name, n.seed);
        rec.npc = n;
      }
      if (n.d < FULL_R) rec.met = true;
      const Lk = this.lookout();
      const pd = this.last ? Math.hypot(this.last.x - Lk.x, this.last.z - Lk.z) : 1e9;
      const atLookout = !!(n.seat && n.seat.lookout && n.state === 'sit');
      // a quest asked them to play for a while
      if (rec.forceT > 0) {
        rec.forceT -= dt;
        if (rec.forceT <= 0) {
          rec.forceT = 0;
          if (atLookout) n.playing = NAMED[name].drums && n.seat.stool ? 'drums' : true;
          else { n.playing = false; n.seat = null; n.leaveT = undefined; if (!this.toWalker(n)) n.state = 'walk'; }
        }
      } else if (atLookout && !this.lookoutOpen) {
        this.settleNamed(rec, n);
      } else if (atLookout) {
        // the session: a song, a break to talk and laugh, the next song
        rec.jamT -= dt;
        if (rec.jamT <= 0) {
          const playing = !!n.playing;
          n.playing = playing ? false : NAMED[name].drums && n.seat.stool ? 'drums' : true;
          rec.jamT = playing ? 8 + this.rnd() * 14 : 35 + this.rnd() * 50;
        }
        // now and then one of them goes for a stroll while nobody watches
        rec.relocT -= dt;
        if (rec.relocT <= 0) {
          rec.relocT = 30;
          if (pd > LOOKOUT_NEAR + 200 && n.d > HIDE_R + 20 && this.rnd() < 0.12 && !Object.values(this.namedRec).some((r) => r !== rec && r.away > 0)) {
            if (n.seat) n.seat.occ = null;
            n.seat = null; n.playing = false; n.leaveT = undefined;
            if (this.placeNamed(rec, n)) rec.away = 90 + this.rnd() * 120;
            else this.toLookout(rec, n);
          }
        }
      } else {
        // away: back on the bench when the time is up or the player heads for the lookout, but
        // only where nobody sees them vanish
        rec.away -= dt;
        const unseen = n.d > 60 && (!view || !inView(view, n.x, n.z, 6));
        if ((rec.away <= 0 || (this.lookoutOpen && pd < LOOKOUT_NEAR)) && unseen) {
          if (n.gigT !== undefined) this.stopGig(n);
          if (this.lookoutOpen) this.toLookout(rec, n);
          else rec.away = 90 + this.rnd() * 120;
        }
      }
      // away from the lookout: wander between haunts, a song now and then
      const away = !(n.seat && n.seat.lookout) && !(rec.forceT > 0);
      if (away) rec.relocT -= dt;
      if (away && rec.relocT <= 0) {
        rec.relocT = 20;
        const far = n.d > HIDE_R + 20 && !n.playing;
        if (far && (rec.met || !rec.home || Math.hypot(n.x - rec.home.x, n.z - rec.home.z) > rec.home.r * 1.8 || this.rnd() < 0.15)) {
          if (n.group) this.leaveGroup(n);
          if (NAMED[name].reroll && rec.met) { this.rerollInstrument(rec, n); rec.inst = this.instrumentOf(name, n.seed); }
          rec.met = false;
          this.placeNamed(rec, n);
        }
      }
      // a song now and then
      if (away) rec.gigCd -= dt;
      if (away && rec.gigCd <= 0 && n.state === 'walk' && !n.group) {
        rec.gigCd = 70 + this.rnd() * 110;
        this.startGig(n, view);
      }
      const I = rec.info;
      I.x = n.x; I.z = n.z; I.y = n.y; I.state = n.state; I.playing = n.playing || false; I.instrument = n.playing === 'drums' ? 'drums' : rec.inst;
      I.home = rec.home ? rec.home.kind : null;
      I.atLookout = !!(n.seat && n.seat.lookout && n.state === 'sit');
      if (I.atLookout) I.home = 'lookout';
      this.named[name] = I;
    }
  }

  holdNamed(id, hold) {
    const rec = this.namedRec[id] || (this.namedRec[id] = { name: id, npc: null, home: null, gigCd: 60, relocT: 15, met: false, inst: null, info: { id } });
    rec.held = !!hold;
  }

  rerollInstrument(rec, n) {
    const before = this.instrumentOf(n.id, n.seed);
    for (let k = 0; k < 12; k++) {
      const seed = Math.floor(this.rnd() * 64);
      if (this.instrumentOf(n.id, seed) !== before) {
        this.releaseAvatar(n);
        n.seed = seed; n.look = n.id + '#' + seed; n.colors = proxyLook(n.id, seed);
        return;
      }
    }
  }

  // Stop beside the walkway and play; listeners gather from passers-by (and a couple who were
  // already there when the player was not looking). Malul sets up his drum kit at the beach and
  // the squares.
  startGig(n, view, opts = {}) {
    const p = n.path;
    if (!p) return false;
    const a = p.pts[n.seg], b = p.pts[n.seg + 1];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    // face the side with room for an audience
    let facing = null;
    for (const sg of [1, -1]) {
      const fx = tz * sg, fz = -tx * sg;
      if (this.offRoad(n.x + fx * 4.5, n.z + fz * 4.5, 0.5) && this.offRoad(n.x + fx * 2.5, n.z + fz * 2.5, 0.5)) { facing = Math.atan2(fx, fz); break; }
    }
    if (facing === null || !this.offRoad(n.x, n.z, 0.6)) return false;
    const Z = this.cellZone(n.x, n.z);
    const drums = NAMED[n.named] && NAMED[n.named].drums && (opts.drums || ((Z.beach > 0.3 || Z.promenade > 0.5 || Z.plaza > 0.3) && this.rnd() < 0.75));
    n.facing = facing;
    n.gigT = 45 + this.rnd() * 60;
    n.leaveT = undefined;
    if (drums) {
      n.state = 'sit';
      n.leaveT = 1e9;
      n.seat = { x: n.x, z: n.z, y: n.y, h: 1.95 * BODY, facing, occ: n, own: true };
      n.playing = 'drums';
    } else {
      n.state = 'stand';
      n.playing = true;
    }
    const grp = { kind: 'music', members: [n], x: n.x, z: n.z, facing, top: n.top, joinT: 2, cd: 5, r0: drums ? 6.8 : 4.2 };
    n.group = grp;
    this.groups.push(grp);
    const hidden = !view || n.d > 70 || !inView(view, n.x, n.z, 6);
    if (hidden) {
      const k = 1 + Math.floor(this.rnd() * 3);
      for (let i = 0; i < k; i++) this.addListener(grp, this.addNpc(this.pickArchetype(Z, 'stand'), { state: 'stand', x: n.x, z: n.z, top: n.top }), true);
    }
    return true;
  }

  stopGig(n) {
    n.gigT = undefined;
    n.playing = false;
    if (n.group) this.leaveGroup(n);
    n.seat = null;
    n.leaveT = undefined;
    if (!this.toWalker(n)) { n.state = 'walk'; }
  }

  // ---- bars and cafés (storefronts.js seats): beer and coffee, toasts and chatter ---------------
  barSeats() {
    if (this.barSeatGrid) return this.barSeatGrid;
    const sf = typeof window !== 'undefined' && window.__game && window.__game.storefronts;
    const raw = sf && Array.isArray(sf.seats) ? sf.seats : null;
    if (!raw || !raw.length) return null;
    const grid = new Map(), list = [];
    for (const q of raw) {
      if (!Number.isFinite(q.x) || !Number.isFinite(q.z)) continue;
      const ground = Number.isFinite(q.ground) ? q.ground : this.groundY(q.x, q.z, 0);
      const h = Number.isFinite(q.y) && q.y - ground > 0.4 ? q.y - ground : 1.2;
      // face the table or bar the seat belongs to (storefronts.js faceX/faceZ); the chair model's
      // own rotation is only a fallback
      const fx = Number.isFinite(q.faceX) ? q.faceX - q.x : 0, fz = Number.isFinite(q.faceZ) ? q.faceZ - q.z : 0;
      const facing = fx * fx + fz * fz > 1e-4 ? Math.atan2(fx, fz) : q.angle || 0;
      list.push({ x: q.x, z: q.z, y: ground, h, facing, kind: q.kind || 'cafe', table: true, occ: null, tbl: null });
    }
    // seats within reach of each other share a table
    for (const st of list) {
      if (st.tbl) continue;
      const tbl = { seats: [st], kind: st.kind, x: st.x, z: st.z };
      st.tbl = tbl;
      for (const o of list) {
        if (o.tbl || o.kind !== st.kind) continue;
        if (tbl.seats.some((m) => Math.hypot(m.x - o.x, m.z - o.z) < 3.4) && tbl.seats.length < 6) { o.tbl = tbl; tbl.seats.push(o); }
      }
      tbl.x = tbl.seats.reduce((a, m) => a + m.x, 0) / tbl.seats.length;
      tbl.z = tbl.seats.reduce((a, m) => a + m.z, 0) / tbl.seats.length;
      const k = key(cellOf(tbl.x), cellOf(tbl.z));
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(tbl);
    }
    this.barSeatGrid = grid;
    this.barSeatList = list;
    this.zoneFeatures = null; // bars mark the nightlife zone
    this.zoneCache.clear();
    this.cand = null;
    this.wver++;
    return grid;
  }

  spawnBar(x, z, Z, ok) {
    const grid = this.barSeats();
    if (!grid) return false;
    const span = 1, ix = cellOf(x), iz = cellOf(z);
    const free = [];
    for (let a = -span; a <= span; a++) for (let b = -span; b <= span; b++) {
      for (const t of grid.get(key(ix + a, iz + b)) || []) if (t.seats.every((q) => !q.occ) && ok(t.x, t.z)) free.push(t);
    }
    if (!free.length) return false;
    const t = free[Math.floor(this.rnd() * free.length)];
    const k = Math.min(t.seats.length, 1 + Math.floor(this.rnd() * 4));
    const seats = [];
    for (const q of t.seats.slice().sort(() => this.rnd() - 0.5)) {
      if (seats.length >= Math.max(k, Math.min(2, t.seats.length))) break;
      // chairs set closer than two bodies: leave the neighbour empty
      if (seats.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < SEP_MIN) || this.occupied(q.x, q.z, 1.2)) continue;
      seats.push(q);
    }
    if (!seats.length) return false;
    const leave = 60 + this.rnd() * 160;
    const members = [];
    for (const q of seats) {
      const npc = this.sitDown(this.pickArchetype({ ...Z, busy: 1 }, 'bar'), q, leave);
      npc.held = t.kind === 'bar' || (t.kind === 'restaurant' && this.rnd() < 0.5) ? 'beer' : 'coffee';
      members.push(npc);
    }
    const grp = { kind: 'bar', members, x: t.x, z: t.z, cd: 2 + this.rnd() * 5 };
    for (const m of members) m.group = grp;
    this.groups.push(grp);
    return true;
  }

  // ---- the skate park -----------------------------------------------------------------------------
  skatePark() {
    if (this.skate !== undefined && this.skate !== null) return this.skate;
    const L = this.world && this.world.landmarks;
    const poi = ((L && L.pois) || []).find((p) => p.id === 'skate_park');
    if (!poi) { this.skate = this.frame > 600 ? false : null; return this.skate || null; }
    let spots = poi.spots || (L && (L.skateSpots || (L.skate && L.skate.spots))) || null;
    if (!Array.isArray(spots) || !spots.length) {
      spots = [];
      for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; spots.push({ x: poi.x + Math.sin(a) * 11, z: poi.z + Math.cos(a) * 11, kind: 'flat' }); }
    }
    // landmarks.js spots are runs { kind, a: [x, y, z], b: [x, y, z] } with world heights
    const P = (v, fb) => (Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : v && Number.isFinite(v.x) ? { x: v.x, y: v.y, z: v.z } : fb);
    spots = spots.map((q) => {
      const c = { x: q.x, y: q.y, z: q.z };
      const a = P(q.a, c), b = P(q.b, a);
      return { kind: String(q.kind || q.type || 'flat'), a, b };
    }).filter((q) => q.a && Number.isFinite(q.a.x) && Number.isFinite(q.a.z));
    if (!spots.length) { this.skate = false; return false; }
    this.skate = { poi, spots };
    return this.skate;
  }

  spawnSkate(x, z, ok) {
    const S = this.skatePark();
    if (!S || !this.ids.includes('skater_kid')) return false;
    if (Math.hypot(S.poi.x - x, S.poi.z - z) > 160 || this.groups.some((g) => g.kind === 'skate')) return false;
    if (!ok(S.poi.x, S.poi.z) && this.filled) return false;
    const grp = { kind: 'skate', members: [], x: S.poi.x, z: S.poi.z, spots: S.spots };
    const n = 3 + Math.floor(this.rnd() * 3);
    for (let i = 0; i < n; i++) {
      const sp = S.spots[Math.floor(this.rnd() * S.spots.length)];
      const k = this.addNpc('skater_kid', { state: 'skate', x: sp.a.x + (this.rnd() - 0.5) * 4, z: sp.a.z + (this.rnd() - 0.5) * 4, top: PATH_TOP });
      k.speed = 6 + this.rnd() * 2.5;
      k.goal = S.spots[Math.floor(this.rnd() * S.spots.length)];
      k.group = grp;
      grp.members.push(k);
    }
    // a couple of friends watching from the edge
    for (let i = 0; i < 2; i++) {
      const a = this.rnd() * Math.PI * 2;
      const wx = S.poi.x + Math.sin(a) * 20, wz = S.poi.z + Math.cos(a) * 20;
      if (!this.offRoad(wx, wz)) continue;
      const w = this.addNpc(this.rnd() < 0.6 ? 'teen_phone' : 'skater_kid', { state: 'stand', x: wx, z: wz, facing: Math.atan2(S.poi.x - wx, S.poi.z - wz), top: PATH_TOP });
      w.group = grp;
      grp.members.push(w);
    }
    this.groups.push(grp);
    return true;
  }

  // The real riding surface of a skate park (bowl walls, quarter pipe, funbox, ledge and rail tops,
  // stairs): a ray straight down onto the park's own meshes, cached on a 0.4-unit grid. The run
  // spots only give each feature's two ends; between them the rider follows this surface instead
  // of a straight line (which floated across the bowl at coping height).
  skateSurface(x, z) {
    const S = this.skate;
    if (!S) return null;
    if (!S.meshes) {
      S.meshes = [];
      this.scene.traverse((o) => { if (o.isMesh && /skate/i.test(o.name || '') && !/skateboard/i.test(o.name || '') && o.geometry) S.meshes.push(o); });
      S.cache = new Map();
      S.ray = new THREE.Raycaster();
      S.ray.far = 80;
    }
    if (!S.meshes.length) return null;
    const ix = Math.round(x / 0.4), iz = Math.round(z / 0.4), k = ix * 100003 + iz;
    let y = S.cache.get(k);
    if (y === undefined) {
      S.ray.set(_rayO.set(ix * 0.4, 400, iz * 0.4), _rayD);
      S.ray.far = 800;
      const hit = S.ray.intersectObjects(S.meshes, false)[0];
      y = hit ? hit.point.y : null;
      if (S.cache.size > 20000) S.cache.clear();
      S.cache.set(k, y);
    }
    return y;
  }

  // Height a skater rides at: the park surface where there is one, never below the ground.
  skateY(n, x, z) {
    const gy = this.groundY(x, z, n.top);
    const sy = this.skateSurface(x, z);
    return sy == null ? gy : Math.max(gy, sy);
  }

  // Ride to the start of a feature, then run it: up a quarter pipe and pop out, round the bowl,
  // ollie onto a rail or ledge and grind it, jump the stairs, hold a manual. Heights come from the
  // run's own end points, so the rider follows the ramps the landmark built.
  stepSkate(n, dt) {
    const g = n.group;
    if (!g || !g.spots || !g.spots.length) { n.state = 'stand'; return; }
    if (n.idle > 0) { n.idle -= dt; n.moving = false; turnTo(n, n.facing, dt); return; }
    if (!n.goal || !n.goal.a) n.goal = g.spots[Math.floor(this.rnd() * g.spots.length)];
    const G = n.goal;
    const ollie = () => { if (n.av && n.av.emote) { try { n.av.emote('ollie'); } catch (_) { /* optional */ } } };
    let y = null;
    if (n.run) {
      // on the feature
      const R = n.run, A = G.a, B = G.b;
      const L = Math.max(0.5, Math.hypot(B.x - A.x, B.z - A.z));
      R.t += (n.speed * dt) / L;
      const t = Math.min(1, R.t);
      n.x = A.x + (B.x - A.x) * t; n.z = A.z + (B.z - A.z) * t;
      n.facing = Math.atan2(B.x - A.x, B.z - A.z);
      const ay = Number.isFinite(A.y) ? A.y : this.groundY(A.x, A.z, n.top), by = Number.isFinite(B.y) ? B.y : ay;
      const lin = ay + (by - ay) * t;
      const sy = this.skateSurface(n.x, n.z);
      // on the real surface; a rail or ledge grind rides its top; a stair set or gap is jumped
      y = sy == null ? lin : /rail|ledge/i.test(G.kind) ? Math.max(sy, lin) : sy;
      if (/stair|gap/i.test(G.kind)) y = Math.max(y, lin + Math.sin(t * Math.PI) * 1.4);
      if (t >= 1) {
        n.run = null;
        if (/quarter|ramp|kicker|bank|pipe/i.test(G.kind)) { n.air = { t: 0, dur: 0.9, h: 1.8, y0: y }; ollie(); n.facing += Math.PI; }
        else if (/rail|ledge|box|funbox/i.test(G.kind)) { n.air = { t: 0, dur: 0.5, h: 0.6, y0: y }; }
        let next = G;
        for (let k = 0; k < 4 && next === G; k++) next = g.spots[Math.floor(this.rnd() * g.spots.length)];
        n.goal = next;
        if (this.rnd() < 0.15) n.idle = 1.5 + this.rnd() * 3;
      }
    } else {
      // carve toward the start of the next feature
      const A = G.a;
      const dx = A.x - n.x, dz = A.z - n.z, d = Math.hypot(dx, dz);
      const want = Math.atan2(dx, dz);
      const diff = Math.atan2(Math.sin(want - n.facing), Math.cos(want - n.facing));
      n.facing += clamp(diff, -2.4 * dt, 2.4 * dt);
      const v = n.speed * (Math.abs(diff) > 1.4 ? 0.45 : 1);
      n.x += Math.sin(n.facing) * v * dt;
      n.z += Math.cos(n.facing) * v * dt;
      if (d < 1.6) {
        n.run = { t: 0 };
        if (/rail|ledge|box|stair|gap|funbox/i.test(G.kind) || this.rnd() < 0.2) ollie();
      }
    }
    n.moving = true;
    let air = 0, base = y;
    const floor = this.skateY(n, n.x, n.z);
    if (n.air) {
      n.air.t += dt;
      const k = n.air.t / n.air.dur;
      air = k >= 1 ? 0 : Math.sin(k * Math.PI) * n.air.h;
      if (base === null && k < 1) base = Math.max(n.air.y0 * (1 - k) + floor * k, floor);
      if (k >= 1) n.air = null;
    }
    n.y = (base === null ? floor : base) + air;
    n.skx = n.x; n.skz = n.z;
    // the board tilts with the surface along the line of travel (up a transition, down into the
    // bowl), so it stays flat under the wheels and the rider stands square to it
    const fx = Math.sin(n.facing) * 0.7, fz = Math.cos(n.facing) * 0.7;
    const slope = n.air ? 0 : Math.atan2(this.skateY(n, n.x + fx, n.z + fz) - this.skateY(n, n.x - fx, n.z - fz), 1.4);
    n.pitch = (n.pitch || 0) + (clamp(slope, -1.1, 1.1) - (n.pitch || 0)) * Math.min(1, dt * 12);
    // push on the flat when slow; cruise on the features and at speed
    n.push = !n.run && !n.air && Math.abs(n.pitch) < 0.08;
    n.phase += n.speed * dt * 0.5;
    turnTo(n, n.facing, dt);
  }

  // ---- the fitness park: pull-ups, monkey bars, dips, stretching between sets -----------------------
  fitnessPark() {
    if (this.fit !== undefined && this.fit !== null) return this.fit;
    const poi = ((this.world && this.world.landmarks && this.world.landmarks.pois) || []).find((p) => p.id === 'fitness_park');
    if (!poi || !Array.isArray(poi.spots) || !poi.spots.length) { this.fit = this.frame > 600 ? false : null; return this.fit || null; }
    const V = (v) => (Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : v);
    this.fit = { poi, spots: poi.spots.map((q) => ({ kind: String(q.kind || ''), a: V(q.a), b: V(q.b || q.a), occ: null })).filter((q) => q.a && Number.isFinite(q.a.x)) };
    return this.fit;
  }

  spawnFitness(x, z, ok) {
    const F = this.fitnessPark();
    if (!F || Math.hypot(F.poi.x - x, F.poi.z - z) > 150 || this.groups.some((g) => g.kind === 'fitness')) return false;
    if (!ok(F.poi.x, F.poi.z) && this.filled) return false;
    const who = ['jogger', 'soldier_on_leave', 'ars_crew', 'office_worker', 'adir'].filter((id) => this.ids.includes(id) && id !== 'adir');
    if (!who.length) return false;
    const grp = { kind: 'fitness', members: [], x: F.poi.x, z: F.poi.z };
    const spots = [];
    for (const q of F.spots.filter((q2) => !q2.occ).sort(() => this.rnd() - 0.5)) {
      if (spots.length >= 2 + Math.floor(this.rnd() * 2)) break;
      if (spots.some((o) => Math.hypot(o.b.x - q.b.x, o.b.z - q.b.z) < SEP_MIN)) continue;
      spots.push(q);
    }
    for (const sp of spots) {
      const n = this.addNpc(who[Math.floor(this.rnd() * who.length)], { state: 'workout', x: sp.a.x, z: sp.a.z, top: 0 });
      n.spot = sp; sp.occ = n;
      n.wkT = 0; n.sets = 2 + Math.floor(this.rnd() * 3); n.restT = 0;
      n.facing = Math.atan2(sp.b.z - sp.a.z, sp.b.x - sp.a.x) + Math.PI / 2; // face across the bar
      n.group = grp;
      grp.members.push(n);
    }
    if (!grp.members.length) return false;
    this.groups.push(grp);
    return true;
  }

  stepWorkout(n, dt) {
    const sp = n.spot;
    if (!sp) { this.toWalker(n); return; }
    const scale = (n.colors && n.colors.ws) || BODY;
    const g0 = this.groundY(sp.a.x, sp.a.z, 0);
    n.moving = false;
    if (n.restT > 0) {
      // between sets: stand beside the bar and stretch
      n.restT -= dt;
      n.wk = 'stretch'; n.rep = 0;
      n.x = sp.a.x + Math.sin(n.facing) * 1.6; n.z = sp.a.z + Math.cos(n.facing) * 1.6;
      n.y = g0;
      if (n.restT <= 0 && --n.sets <= 0) { if (sp.occ === n) sp.occ = null; n.spot = null; if (n.group) this.leaveGroup(n); this.toWalker(n); }
      turnTo(n, n.facing, dt);
      return;
    }
    n.wkT += dt;
    const k = 0.5 - 0.5 * Math.cos(n.wkT * 2.4); // one rep every ~2.6 s
    n.rep = k;
    const top = Math.max(sp.a.y, sp.b.y);
    if (/monkey/i.test(sp.kind)) {
      // hand over hand along the monkey bars
      const L = Math.max(1, Math.hypot(sp.b.x - sp.a.x, sp.b.z - sp.a.z));
      const t = Math.min(1, (n.wkT * 1.1) / L);
      n.x = sp.a.x + (sp.b.x - sp.a.x) * t; n.z = sp.a.z + (sp.b.z - sp.a.z) * t;
      n.facing = Math.atan2(sp.b.x - sp.a.x, sp.b.z - sp.a.z);
      n.wk = 'hang'; n.rep = 0.25 + 0.15 * Math.sin(n.wkT * 5);
      n.y = top - 5.45 * (scale / 0.82) * (1 - 0.3 * n.rep) + 0.3;
      if (t >= 1) { n.wkT = 0; n.restT = 6 + this.rnd() * 6; }
    } else if (/parallel|dip/i.test(sp.kind)) {
      n.x = (sp.a.x + sp.b.x) / 2; n.z = (sp.a.z + sp.b.z) / 2;
      n.facing = Math.atan2(sp.b.x - sp.a.x, sp.b.z - sp.a.z);
      n.wk = 'dip';
      n.y = top - 1.75 * (scale / 0.82) + 0.55 - 0.55 * k;
      if (n.wkT > 14) { n.wkT = 0; n.restT = 6 + this.rnd() * 8; }
    } else {
      // pull-ups under the bar's top end
      n.x = sp.b.x; n.z = sp.b.z;
      n.wk = 'hang';
      n.y = top - 5.45 * (scale / 0.82) * (1 - 0.32 * k) + 0.3;
      if (n.wkT > 16) { n.wkT = 0; n.restT = 6 + this.rnd() * 8; }
    }
    turnTo(n, n.facing, dt);
  }

  // ---- full avatar pool ------------------------------------------------------------------------
  acquireAvatar(n, mayCreate) {
    const free = this.pool.get(n.look);
    let av = free && free.pop();
    let res = 'pool';
    if (av) this.pooled--;
    else {
      if (!mayCreate) return false;
      // joggers run: a low walk speed tells the gait to blend into its running cycle
      const cfg = n.pace === 'jog' ? { archetype: n.id, seed: n.seed, walkSpeed: 3.5, runSpeed: 9 } : { archetype: n.id, seed: n.seed };
      try { av = this.makeAvatar(cfg); } catch (e) { console.warn('[npcs] createAvatar failed for', n.id, e); return false; }
      if (!av || !av.group) return false;
      this.scene.add(av.group);
      this.created++;
      res = 'new';
    }
    av.group.visible = true;
    av.group.position.set(n.x, n.y, n.z);
    av.group.rotation.y = n.yaw;
    n.av = av;
    n.avMode = null;
    n.holdSide = 0;
    n.avPlaying = undefined;
    n.avHeld = undefined;
    n.avWorkout = 'reset';
    n.avShadow = undefined;
    n.avDetail = undefined;
    // some people simply look cheerful
    try { av.setRestFace && av.setRestFace(hash(n.look) % 3 === 0 ? 'smile' : 'neutral'); } catch (_) { /* optional */ }
    try { av.setHold && av.setHold(0); } catch (_) { /* optional */ }
    n.accum = 0.05;
    return res;
  }

  releaseAvatar(n) {
    const av = n.av;
    if (!av) return;
    n.av = null;
    av.group.visible = false;
    let list = this.pool.get(n.look);
    if (!list) this.pool.set(n.look, (list = []));
    list.push(av);
    this.pooled++;
    if (this.pooled > POOL_CAP) {
      // forget the oldest spare look entirely (geometry and textures are shared, so this is cheap)
      for (const [k, l] of this.pool) {
        if (!l.length || k === n.look) continue;
        const old = l.shift();
        this.scene.remove(old.group);
        this.pooled--;
        this.created--;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Walk network
function buildNetwork(city, roads, sealedAt = null) {
  const sealed = (x, z) => { try { return !!(sealedAt && sealedAt(x, z)); } catch (_) { return false; } };
  const paths = [];
  const add = (pts, kind, top) => {
    if (!pts || pts.length < 2) return;
    if (pts.length === 2 && Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) < 3) return;
    const clean = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = clean[clean.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.3) clean.push(p);
    }
    if (clean.length >= 2) paths.push({ pts: clean, kind, top });
  };
  if (city && city.sidewalks && city.sidewalks.length) {
    const off = city.onCarriage;
    // A sidewalk strip can run over another carriageway (dual carriageways, interchange ramps,
    // where a strip meets the next road); cut it there so nobody walks or waits on the asphalt.
    const onRoad = (x, z) => { try { return !!(off && off(x, z, 0)) || sealed(x, z); } catch (_) { return false; } };
    const addClean = (pts, kind, top) => {
      let run = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        let bad = onRoad(p[0], p[1]);
        if (!bad && i > 0) {
          // sample the segment too: a footway may cut across a road between two of its points
          const q = pts[i - 1], n = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) / 1.5);
          for (let k = 1; k < n && !bad; k++) bad = onRoad(q[0] + ((p[0] - q[0]) * k) / n, q[1] + ((p[1] - q[1]) * k) / n);
          if (bad) { add(run, kind, top); run = []; bad = false; }
        }
        if (bad) { add(run, kind, top); run = []; } else run.push(p);
      }
      add(run, kind, top);
    };
    for (const s of city.sidewalks) {
      const kind = s.roadKind || 'residential';
      if (SKIP_KINDS.test(kind)) continue; // nobody walks along Ayalon, Route 4, 431 or the ramps
      addClean(s.points || [], kind, kind === 'promenade' ? PATH_TOP : SIDE_TOP);
    }
    for (const r of roads) {
      if (!r || !r.points || r.bridge || r.tunnel || r.restricted || !FOOT_KINDS.test(r.kind || '')) continue;
      // separately mapped sidewalks and crossings would put people on the asphalt: keep only the
      // stretches that stay clear of every carriageway
      addClean(r.points, r.kind, PATH_TOP);
    }
  } else {
    for (const r of roads) {
      if (!r || !r.points || r.points.length < 2 || r.restricted || SKIP_KINDS.test(r.kind || '')) continue;
      for (const side of [1, -1]) add(offsetSidewalk(r, side), r.kind, 0);
    }
  }
  // how far each segment lets people walk off its centre line before they would step onto a road
  const offC = city && city.onCarriage;
  const roadAt = (x, z) => { try { return !!(offC && offC(x, z, 0.2)); } catch (_) { return false; } };
  for (const p of paths) {
    p.lanes = [];
    for (let i = 0; i < p.pts.length - 1; i++) {
      const a = p.pts[i], b = p.pts[i + 1];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const lim = [0, 0];
      for (const [k, sg] of [[0, 1], [1, -1]]) {
        for (const off of [1.4, 0.8, 0.4]) {
          const ok = [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]].every((q) => !roadAt(q[0] + dz * off * sg, q[1] - dx * off * sg));
          if (ok) { lim[k] = off; break; }
        }
      }
      p.lanes.push(lim);
    }
  }
  const grid = new Map(), ends = new Map();
  paths.forEach((p, pi) => {
    for (let i = 0; i < p.pts.length - 1; i++) {
      const a = p.pts[i], b = p.pts[i + 1];
      const k = key(cellOf((a[0] + b[0]) / 2), cellOf((a[1] + b[1]) / 2));
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push([pi, i]);
    }
    for (const end of [0, 1]) {
      const q = end ? p.pts[p.pts.length - 1] : p.pts[0];
      const k = key(cellOf(q[0]), cellOf(q[1]));
      let l = ends.get(k);
      if (!l) ends.set(k, (l = []));
      l.push({ path: p, end, x: q[0], z: q[1] });
    }
  });
  return { paths, grid, ends };
}

function offsetSidewalk(road, side) {
  const pts = road.points;
  const onFoot = FOOT_KINDS.test(road.kind || '');
  const off = onFoot ? (road.width || 2) * 0.22 : (road.width || 6) / 2 + 1.6;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    out.push([pts[i][0] - tz * off * side, pts[i][1] + tx * off * side]);
  }
  return out;
}

// data/rishon.json extras the zones need (fetched once; the browser already has it cached)
async function loadData() {
  try {
    const res = await fetch(new URL('../../data/rishon.json', import.meta.url));
    if (!res.ok) return null;
    const d = await res.json();
    const f = SCALE / ((d.meta && d.meta.scale) || SCALE);
    const poly = (flat) => {
      const pts = [];
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const x = flat[i] * f, z = flat[i + 1] * f;
        pts.push(x, z);
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      return { pts, minX, maxX, minZ, maxZ };
    };
    const out = { amenities: [], religious: [], bigShops: [], beach: [], parks: [] };
    for (const a of d.amenities || []) out.amenities.push([a[0], a[1], a[2], a[3] * f, a[4] * f]);
    for (const b of d.buildings || []) {
      const kind = b[1];
      if (kind !== 6 && kind !== 3) continue;
      const p = poly(b[2]);
      const area = (p.maxX - p.minX) * (p.maxZ - p.minZ);
      const c = { x: (p.minX + p.maxX) / 2, z: (p.minZ + p.maxZ) / 2 };
      if (kind === 6) out.religious.push(c);
      else if (area > 9000) out.bigShops.push({ ...c, r: Math.sqrt(area) * 0.6 });
    }
    // Only sand by the sea counts: OSM also tags volleyball courts and park sandpits as beach,
    // and the matkot guys belong on the real one.
    const coast = [];
    const addCoast = (flat) => { for (let i = 0; i + 1 < flat.length; i += 2) coast.push([flat[i] * f, flat[i + 1] * f]); };
    if (Array.isArray(d.coast)) { if (Array.isArray(d.coast[0])) d.coast.forEach(addCoast); else addCoast(d.coast); }
    for (const b of d.beach || []) {
      const q = poly(Array.isArray(b[1]) ? b[1] : b);
      const cx = (q.minX + q.maxX) / 2, cz = (q.minZ + q.maxZ) / 2;
      if (!coast.length || coast.some(([x, z]) => Math.hypot(x - cx, z - cz) < 700)) out.beach.push(q);
    }
    for (const p of d.parks || []) {
      const q = poly(p[1]);
      if ((q.maxX - q.minX) * (q.maxZ - q.minZ) > 2500) out.parks.push(q);
    }
    // Rothschild (the nightlife street), HaTizmoret, the city park, the industrial estates
    out.nightlife = []; out.tizmoret = []; out.ganHair = []; out.industrial = []; out.places = [];
    for (const r of d.roads || []) {
      const meta = r[3] || {}, en = meta.nameEn || '';
      const list = /rothschild/i.test(en) ? out.nightlife : /tizmoret/i.test(en) ? out.tizmoret : null;
      if (!list || !Array.isArray(r[2])) continue;
      for (let i = 0; i + 1 < r[2].length; i += 6) list.push([r[2][i] * f, r[2][i + 1] * f]);
    }
    for (const p of d.parks || []) if (GAN_HAIR.test(p[0] || '')) out.ganHair.push(poly(p[1]));
    for (const b of d.buildings || []) {
      if (b[1] !== 4) continue;
      const q = poly(b[2]);
      out.industrial.push({ x: (q.minX + q.maxX) / 2, z: (q.minZ + q.maxZ) / 2, r: 120 + Math.sqrt((q.maxX - q.minX) * (q.maxZ - q.minZ)) });
    }
    for (const p of d.places || []) out.places.push({ kind: p[0], en: p[2] || '', x: p[3] * f, z: p[4] * f });
    // shop nodes from the round-3 extras file, when the parking agent has written it
    out.shops = [];
    try {
      const rx = await fetch(new URL('../../data/rishon.extras.json', import.meta.url));
      if (rx.ok) {
        const e = await rx.json();
        const g = SCALE / ((e.meta && e.meta.scale) || SCALE);
        for (const sh of e.shops || []) {
          if (SHOP_KINDS.test(sh.shop || '') || SHOP_KINDS.test(sh.amenity || '')) out.shops.push({ x: sh.x * g, z: sh.z * g });
        }
        for (const ind of e.industrial || []) {
          const pts = ind.points || [];
          if (!pts.length) continue;
          let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
          for (const q of pts) { const x = (q[0] ?? q.x) * g, z = (q[1] ?? q.z) * g; if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
          out.industrial.push({ x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, r: Math.max(maxX - minX, maxZ - minZ) * 0.6 + 40 });
        }
      }
    } catch (_) { /* extras are optional */ }
    return out;
  } catch (e) {
    console.warn('[npcs] zone data unavailable', e.message || e);
    return null;
  }
}

function polyHit(polys, x, z, margin) {
  if (!polys) return 0;
  for (const p of polys) {
    if (x < p.minX - margin || x > p.maxX + margin || z < p.minZ - margin || z > p.maxZ + margin) continue;
    if (pointInPoly(p.pts, x, z)) return 1;
    if (margin > 0) {
      for (const [ox, oz] of [[margin, 0], [-margin, 0], [0, margin], [0, -margin]]) if (pointInPoly(p.pts, x + ox, z + oz)) return 0.6;
    }
  }
  return 0;
}

function pointInPoly(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], zi = pts[i + 1], xj = pts[j], zj = pts[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------------------------
// View helpers
const _fwd = new THREE.Vector3();
function viewInfo(cam) {
  cam.getWorldDirection(_fwd);
  const l = Math.hypot(_fwd.x, _fwd.z) || 1;
  return { x: cam.position.x, z: cam.position.z, fx: _fwd.x / l, fz: _fwd.z / l, cos: Math.cos(((cam.fov || 60) * (cam.aspect || 1.6) * Math.PI) / 360 + 0.35) };
}
function inView(v, x, z, pad = 0) {
  const dx = x - v.x, dz = z - v.z, d = Math.hypot(dx, dz);
  if (d < pad + 4) return true;
  return (dx * v.fx + dz * v.fz) / d > v.cos - pad / Math.max(d, 1);
}

function turnTo(n, target, dt) {
  const diff = Math.atan2(Math.sin(target - n.yaw), Math.cos(target - n.yaw));
  n.yaw += diff * Math.min(1, dt * 8);
}

// ---------------------------------------------------------------------------------------------
// Proxy crowd: one InstancedMesh per body part. Proportions match the avatar rig (concept units,
// feet at y = 0, facing +z), scaled by the avatar's world scale.
const PART_DEFS = [
  // name, geometry [w, h, d, r], per-NPC instances
  ['torso', [2.2, 1.72, 1.15, 0.28], 1],
  ['pelvis', [2.1, 0.72, 1.1, 0.26], 1],
  ['thigh', [1.0, 1.15, 1.05, 0.2], 2],
  ['shin', [0.96, 1.35, 1.0, 0.2], 2],
  ['arm', [0.9, 1.95, 0.96, 0.22], 2],
  ['hand', [0.8, 0.6, 0.85, 0.25], 2],
  ['head', [1.7, 1.6, 1.5, 0.42], 1],
  ['hair', [1.8, 0.5, 1.6, 0.22], 1],
  ['extra', [1.0, 1.0, 1.0, 0.15], 1], // stroller, kitbag, delivery box or bike: one block per person
];

function buildProxies(scene, max) {
  const gm = new THREE.DataTexture(new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]), 3, 1);
  gm.minFilter = gm.magFilter = THREE.NearestFilter;
  gm.needsUpdate = true;
  const material = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gm });
  const parts = {};
  const white = new THREE.Color(1, 1, 1);
  for (const [name, [w, h, d, r], per] of PART_DEFS) {
    const geo = new RoundedBoxGeometry(w, h, d, 1, r);
    const cap = max * per + 8;
    const mesh = new THREE.InstancedMesh(geo, material, cap);
    mesh.name = 'crowd:' + name;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, white);
    scene.add(mesh);
    parts[name] = mesh;
  }
  const ballGeo = new THREE.SphereGeometry(0.32, 10, 8);
  const balls = new THREE.InstancedMesh(ballGeo, new THREE.MeshToonMaterial({ color: 0x1e5aa8, gradientMap: gm }), 32);
  balls.frustumCulled = false;
  balls.castShadow = true;
  balls.count = 0;
  scene.add(balls);
  return { parts, balls };
}

const HAT_ACCS = { blackHat: [2.2, 1.12], cap: [1.0, 1.05], beanie: [1.3, 1.1], flatCap: [1.0, 1.1], tichel: [1.6, 1.12], helmet: [1.5, 1.2], sunHat: [1.6, 1.7], headband: [1.0, 1.0] };
function proxyLook(id, seed) {
  let c = null;
  try { c = resolveConfig ? resolveConfig({ archetype: id, seed }) : null; } catch (_) { c = null; }
  if (!c) {
    const pal = ['#ff6b3d', '#2ec4b6', '#ffcb3d', '#3f8efc', '#b36bd6', '#e8364f'];
    const k = Math.abs(hash(id + seed));
    return { skin: col('#e0ac82'), shirt: col(pal[k % 6]), sleeve: col(pal[k % 6]), pants: col('#3d5f8f'), lower: col('#3d5f8f'), hair: col('#3b2416'), hatH: 1, hatW: 1, ws: BODY, bw: 1, belly: 0, head: 1, extra: null };
  }
  const shirt = c.shirt || {};
  const top = shirt.coat || shirt.color || '#ffffff';
  const skirt = c.skirt;
  const pants = c.pants || { color: '#3d5f8f', kind: 'long' };
  const fabric = skirt && skirt.length !== 'coat' ? skirt.color : pants.color;
  let lower = c.legs && c.legs.lower;
  if (!lower) {
    if (skirt && skirt.length === 'long') lower = skirt.color;
    else if (skirt && skirt.length === 'coat') lower = pants.color;
    else if (skirt) lower = c.skin;
    else lower = pants.kind === 'shorts' ? c.skin : pants.color;
  }
  let hair = c.hair && c.hair.style !== 'none' && c.hair.style !== 'bald' ? c.hair.color : c.skin;
  let hatH = 1, hatW = 1;
  for (const a of c.accessories || []) {
    const h = HAT_ACCS[a.type];
    if (!h) continue;
    hair = a.type === 'blackHat' ? '#141414' : a.color || hair;
    [hatH, hatW] = h;
  }
  let extra = null;
  const st = c.style || {};
  if (st.stroller) extra = { color: col(st.stroller.color), size: [1.5, 1.5, 2.2], at: [0, 1.9, 2.9] };
  else if (st.skateboard) extra = { color: col(st.skateboard.color || '#e8364f'), size: [1.0, 0.18, 3.4], at: [0, 0.5, 0] };
  else if (st.dog) { const k = st.dog.size ?? 1; extra = { color: col(st.dog.color || '#c98b4a'), size: [0.8 * k, 1.4 * k, 2.2 * k], at: [2.15, 0.85 * k, 1.5 + 0.2 * k] }; }
  else if (st.trolley) extra = { color: col(st.trolley.color), size: [1.2, 1.7, 0.9], at: [0.4, 1.25, -2.1] };
  for (const a of c.accessories || []) {
    if (a.type === 'deliveryBox') extra = { color: col(a.color || '#2ec4b6'), size: [2.0, 1.9, 1.45], at: [0, 3.9, -1.4] };
    else if (a.type === 'kitbag') extra = { color: col(a.color || '#5f6235'), size: [1.5, 2.4, 1.5], at: [0, 3.9, -1.3] };
    else if (a.type === 'backpack' && !extra) extra = { color: col(a.color || '#ffcb3d'), size: [1.75, 1.55, 0.75], at: [0, 3.7, -0.95] };
    else if (INSTRUMENTS.test(a.type)) {
      // a busker plays in front; the regulars carry theirs slung on the back
      const big = a.type === 'guitar' || a.type === 'electricGuitar';
      extra = st.carry ? { color: col(a.color || '#c9874a'), size: [big ? 1.3 : 0.8, big ? 2.6 : 1.5, 0.45], at: [0.2, 3.7, -1.0] }
        : { color: col(a.color || '#c9874a'), size: [1.6, 1.5, 0.45], at: [-0.1, 3.25, 1.0] };
    }
  }
  const sleeveless = shirt.sleeves === 'none';
  return {
    skin: col(c.skin), shirt: col(top), sleeve: col(sleeveless ? c.skin : top), pants: col(fabric), lower: col(lower), hair: col(hair),
    hatH, hatW, ws: BODY * ((c.body && c.body.scale) || 1), bw: (c.body && c.body.width) || 1, belly: (c.body && c.body.belly) || 0,
    head: (c.body && c.body.head) || 1, extra, skirt: !!(skirt && skirt.length !== 'coat'),
  };
}
const colCache = new Map();
function col(hex) {
  let c = colCache.get(hex);
  if (!c) colCache.set(hex, (c = new THREE.Color(hex || '#888888')));
  return c;
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const _rayO = new THREE.Vector3(), _rayD = new THREE.Vector3(0, -1, 0);
const _base = new THREE.Matrix4(), _loc = new THREE.Matrix4(), _m = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _o = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
const BIKE_COLOR = new THREE.Color('#2b2b2b');
const DRUM_COLOR = new THREE.Color('#c2405a');

// proxy body layout in avatar body units: hip height and how much the round-5 legs lifted the
// upper body (avatar rig.js DIMS)
const HB = 2.5, LU = 0.2;
function writeProxies(P, npcs, dt, groups, view) {
  const parts = P.parts;
  const idx = {};
  for (const k in parts) idx[k] = 0;
  const put = (name, color, px, py, pz, rx, rz, ox, oy, oz, sx, sy, sz) => {
    _e.set(rx, 0, rz);
    _q.setFromEuler(_e);
    _o.set(ox, oy, oz).applyQuaternion(_q);
    _p.set(px + _o.x, py + _o.y, pz + _o.z);
    _s.set(sx, sy, sz);
    _loc.compose(_p, _q, _s);
    _m.multiplyMatrices(_base, _loc);
    const mesh = parts[name], i = idx[name]++;
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(i, color);
  };
  for (const n of npcs) {
    if (n.lod !== 1) continue;
    if (view && n.d > 40 && !inView(view, n.x, n.z, 8)) continue;
    const L = n.colors;
    const ws = L.ws, bw = L.bw;
    _qy.setFromAxisAngle(_Y, n.yaw);
    _base.compose(_p.set(n.x, n.y, n.z), _qy, _s.set(ws, ws, ws));
    const riding = n.ride && n.moving;
    const legX = 0.53 * bw, shX = 1.1 * bw + 0.48;
    if (n.state === 'sit' && n.seat) {
      // seated: pelvis on the seat, thighs forward, shins hanging, hands on the lap
      const py = n.seat.h / ws + 0.5, up = py - HB + LU;
      put('pelvis', L.pants, 0, 2.55 + up, 0, 0, 0, 0, 0, 0, bw, 1, 1);
      put('torso', L.shirt, 0, 3.65 + up, -0.05, 0, 0, 0, 0, 0, bw, 1, 1 + L.belly * 0.3);
      for (const s of [1, -1]) {
        put('thigh', L.pants, s * legX, py, 0, -1.25, 0, 0, -0.5, 0, Math.min(bw, 1.08), 1, 1);
        put('shin', L.lower, s * legX, py - 0.33, 1.0, 0, 0, 0, -0.55, 0, Math.min(bw, 1.08), 1, 1);
        put('arm', L.sleeve, s * shX, 4.35 + up, 0, -0.55, s * 0.05, 0, -0.92, 0, 1, 1, 1);
        put('hand', L.skin, s * shX, 4.35 + up, 0, -0.55, s * 0.05, 0, -2.05, 0, 1, 1, 1);
      }
      put('head', L.skin, 0, 5.35 + up, 0, 0, 0, 0, 0, 0, L.head, L.head, L.head);
      put('hair', L.hair, 0, 5.35 + up + (0.66 + (L.hatH - 1) * 0.25) * L.head, -0.02, 0, 0, 0, 0, 0, L.hatW * L.head, L.hatH * L.head, L.hatW * L.head);
      if (n.playing === 'drums') put('extra', DRUM_COLOR, 0, 1.4, 2.5, 0, 0, 0, 0, 0, 3.4, 2.8, 2.2);
      continue;
    }
    const jog = n.pace === 'jog' && n.moving;
    // legs swing at the avatar's cadence (gaitClock) with an arc wide enough that a foot at
    // mid-stance moves back as fast as the body moves forward
    const stepping = !riding && n.state !== 'skate' && (n.vel || 0) > 0.4;
    const swA = stepping ? Math.min(0.95, Math.max(0.22, ((n.gaitC || 3) / (2 * Math.PI * 2.2)) * (jog ? 1.6 : 1.35))) : 0;
    const sw = stepping ? Math.sin(n.phase) * swA * Math.min(1, (n.vel || 0) / 1.5) : 0;
    put('pelvis', L.pants, 0, 2.55 + LU, 0, 0, 0, 0, 0, 0, bw, 1, 1);
    put('torso', L.shirt, 0, 3.65 + LU, L.belly * 0.1, 0, 0, 0, 0, 0, bw, 1, 1 + L.belly * 0.3);
    for (const s of [1, -1]) {
      const hip = riding ? -1.1 + 0.35 * s * Math.sin(n.phase) : s * sw;
      put('thigh', L.pants, s * legX, HB, 0, hip, 0, 0, -0.55, 0, Math.min(bw, 1.08), 1.1, 1);
      put('shin', L.skirt ? L.lower : L.lower, s * legX, HB, 0, hip * (riding ? 0.4 : 1), 0, 0, -1.7, riding ? 0.6 : 0, Math.min(bw, 1.08), 1.1, 1);
      const arm = riding ? -0.9 : jog ? -0.6 - s * sw * 0.9 : -s * sw * 0.8;
      put('arm', L.sleeve, s * shX, 4.35 + LU, 0, arm, s * 0.07, 0, -0.92, 0, 1, 1, 1);
      put('hand', L.skin, s * shX, 4.35 + LU, 0, arm, s * 0.07, 0, -2.05, 0, 1, 1, 1);
    }
    const hs = L.head;
    put('head', L.skin, 0, 5.35 + LU, 0, 0, 0, 0, 0, 0, hs, hs, hs);
    put('hair', L.hair, 0, 5.35 + LU + (0.66 + (L.hatH - 1) * 0.25) * hs, -0.02, 0, 0, 0, 0, 0, L.hatW * hs, L.hatH * hs, L.hatW * hs);
    if (riding) put('extra', BIKE_COLOR, 0, 1.0, 0.2, 0, 0, 0, 0, 0, 0.3, 1.4, 4.2);
    else if (L.extra) put('extra', L.extra.color, L.extra.at[0], L.extra.at[1], L.extra.at[2], 0, 0, 0, 0, 0, L.extra.size[0], L.extra.size[1], L.extra.size[2]);
  }
  for (const k in parts) {
    const mesh = parts[k];
    mesh.count = idx[k];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  // matkot balls in flight
  let b = 0;
  _qy.identity();
  for (const g of groups) {
    if (g.kind !== 'matkot' || g.members.length !== 2 || b >= 32) continue;
    const A = g.members[g.from], B = g.members[1 - g.from];
    if (A.d > HIDE_R) continue;
    const t = g.ball;
    const y = (A.y + B.y) / 2 + 3.2 + Math.sin(Math.PI * t) * 1.6;
    _m.compose(_p.set(A.x + (B.x - A.x) * t, y, A.z + (B.z - A.z) * t), _qy, _s.set(1, 1, 1));
    P.balls.setMatrixAt(b++, _m);
  }
  P.balls.count = b;
  P.balls.instanceMatrix.needsUpdate = true;
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
