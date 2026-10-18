// Full-screen city map: north-up canvas 2D overlay with zoom around the cursor, drag/inertia pan,
// pinch, hover road names, landmark POIs, the player arrow and an optional click-to-set waypoint.
// The static layers (sea, ground cover, buildings, roads, rail) are rasterised into 512 px tiles
// per power-of-two zoom tier and cached, so panning and zooming only re-blit images; labels and
// markers are drawn as vectors every frame so they stay crisp at any zoom.
import { SCALE, unproject } from '../geo.js';

// Display text comes from src/i18n.js (t(key, vars), falls back to the key). It is imported
// dynamically so the map still works, in English, if that module is missing or fails to load.
// MAP_STRINGS_EN lists every key this module uses, as the English fallback and a key list for translators.
export const MAP_STRINGS_EN = {
  'map.title': 'Rishon LeZion',
  'map.hint': 'Drag to pan · wheel or pinch to zoom · click to set a waypoint · M or Esc to close',
  'map.center_on_me': 'Centre on me', 'map.zoom_in': 'Zoom in', 'map.zoom_out': 'Zoom out', 'map.close': 'Close map (M)',
  'map.clear_waypoint': 'Clear waypoint', 'map.legend': 'Legend', 'map.you': 'You', 'map.waypoint': 'Waypoint',
  'map.north': 'N', 'map.north_up': 'North is up', 'map.open': 'Open map (M)', 'map.loading': 'Loading map data...',
  'map.attribution': '© OpenStreetMap contributors', 'map.scale': 'Scale', 'map.unit_m': '{n} m', 'map.unit_km': '{n} km',
  'map.bridge': 'bridge', 'map.tunnel': 'tunnel', 'map.landmark': 'Landmark', 'map.unnamed': 'Unnamed {kind}',
  'map.lat_lon': '{lat}° N, {lon}° E',
  'map.kind.motorway': 'motorway', 'map.kind.trunk': 'trunk road', 'map.kind.primary': 'main road',
  'map.kind.secondary': 'secondary road', 'map.kind.tertiary': 'local road', 'map.kind.residential': 'residential street',
  'map.kind.unclassified': 'minor road', 'map.kind.living_street': 'living street', 'map.kind.service': 'service road',
  'map.kind.pedestrian': 'pedestrian street', 'map.kind.promenade': 'promenade', 'map.kind.footway': 'footpath',
  'map.kind.sidewalk': 'sidewalk', 'map.kind.path': 'path', 'map.kind.steps': 'steps', 'map.kind.cycleway': 'cycle path',
  'map.kind.track': 'track', 'map.kind.rail': 'railway',
  'map.legend.motorway': 'Motorway / trunk', 'map.legend.primary': 'Main road', 'map.legend.secondary': 'Secondary road',
  'map.legend.residential': 'Street', 'map.legend.pedestrian': 'Pedestrian / promenade', 'map.legend.footway': 'Footpath',
  'map.legend.cycleway': 'Cycle path', 'map.legend.rail': 'Railway', 'map.legend.bridge': 'Bridge', 'map.legend.park': 'Park',
  'map.legend.beach': 'Beach', 'map.legend.building': 'Building', 'map.legend.landmark': 'Landmark',
};
const LEGEND_ITEMS = ['motorway', 'primary', 'secondary', 'residential', 'pedestrian', 'footway', 'cycleway', 'rail',
  'bridge', 'park', 'beach', 'building', 'landmark'];

let tImpl = null;
const i18nReady = import('../i18n.js')
  .then((m) => { if (typeof m.t === 'function') tImpl = m.t; })
  .catch(() => { /* no i18n module yet: English fallback */ });
function fill(str, vars) {
  return vars ? String(str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : String(str);
}
// Translated text, else the English fallback (t() returns the key itself when it has no entry).
function tr(key, vars) {
  if (tImpl) {
    try { const v = tImpl(key, vars); if (v != null && v !== key) return String(v); } catch (_) { /* fall through */ }
  }
  return fill(MAP_STRINGS_EN[key] ?? key, vars);
}
// Same, but for data-driven keys (POIs) whose fallback is the data's own name, never the key.
function trOr(key, fallback) {
  if (tImpl) {
    try { const v = tImpl(key); if (v != null && v !== key) return String(v); } catch (_) { /* fall through */ }
  }
  return fallback;
}
const HEBREW = /[\u0590-\u05FF]/;
// Hebrew-capable stack first; the game is moving to Hebrew RTL.
const FONT = "'Rubik', 'Heebo', 'Nunito', 'Arial Hebrew', system-ui, sans-serif";

const DATA_URL = new URL('../../data/rishon.json', import.meta.url);

// ---------- look ----------
const C = {
  land: '#f1ead8', sea: '#63b9ec', seaEdge: '#3f97d2', beach: '#f6df9f', grass: '#d2e9a8', park: '#b3dc8c',
  wood: '#95c87b', pitch: '#a5d98c', pitchEdge: '#7fbd69', water: '#80c9f0', platform: '#d7cdbd',
  building: '#dcd1c0', buildingEdge: '#c2b49f', landmark: '#ffd08f', landmarkEdge: '#e0973a',
  boundary: 'rgba(124, 77, 196, 0.55)', ink: '#23324a', halo: 'rgba(255, 252, 244, 0.95)',
  rail: '#6f6f78', railDash: '#ffffff', bridgeCasing: '#4a4f5c',
  player: '#ffb347', waypoint: '#2ec4b6', target: '#ffcb3d', hover: 'rgba(255, 111, 89, 0.55)',
};

// rank orders drawing and labels; min = minimum width in CSS px; show = minimum zoom (CSS px per unit).
const ROAD_STYLE = {
  motorway: { rank: 10, fill: '#ef8a8c', casing: '#b25058', min: 3.4, show: 0 },
  trunk: { rank: 9, fill: '#f5a86f', casing: '#b46b38', min: 3.0, show: 0 },
  primary: { rank: 8, fill: '#fbd47a', casing: '#b48b33', min: 2.6, show: 0 },
  secondary: { rank: 7, fill: '#f7ef9c', casing: '#a39853', min: 2.1, show: 0 },
  tertiary: { rank: 6, fill: '#ffffff', casing: '#a19a8e', min: 1.7, show: 0 },
  residential: { rank: 5, fill: '#ffffff', casing: '#bbb3a5', min: 1.1, show: 0.1 },
  unclassified: { rank: 5, fill: '#ffffff', casing: '#bbb3a5', min: 1.1, show: 0.1 },
  living_street: { rank: 5, fill: '#f4f4f4', casing: '#bbb3a5', min: 1.1, show: 0.1 },
  service: { rank: 4, fill: '#fbfaf6', casing: '#c8c0b2', min: 0.8, show: 0.3 },
  pedestrian: { rank: 3, fill: '#ece5f4', casing: '#ad9fc1', min: 1.2, show: 0.2 },
  promenade: { rank: 3, fill: '#f0dcb2', casing: '#c6a56c', min: 1.6, show: 0.1 },
  track: { rank: 2, dash: '#a8814f', min: 1.0, show: 0.6 },
  cycleway: { rank: 2, dash: '#3d7ed6', min: 1.0, show: 0.5 },
  footway: { rank: 1, dash: '#df7660', min: 0.9, show: 0.7 },
  path: { rank: 1, dash: '#df7660', min: 0.9, show: 0.7 },
  steps: { rank: 1, dash: '#df7660', min: 1.2, show: 0.7 },
  sidewalk: { rank: 1, dash: '#c9b9a8', min: 0.8, show: 1.2 },
};
const DEFAULT_ROAD = { rank: 4, fill: '#ffffff', casing: '#c8c0b2', min: 0.8, show: 0.3 };
const RAIL_STYLE = { rank: 11, min: 3.0, show: 0 };

// Fallback carriageway widths in metres for the raw-data path (the live city passes its own widths).
const DATA_ROAD_M = {
  motorway: 15, trunk: 13, primary: 12, secondary: 10, tertiary: 8, residential: 6.5, unclassified: 6, living_street: 5,
  service: 4, pedestrian: 5, footway: 2, sidewalk: 1.7, path: 2, steps: 2, cycleway: 2.3, track: 3, promenade: 7.5,
};

const TILE = 512;               // device px per tile edge
const T_MIN = -5, T_MAX = 4;    // tier t renders at 2^t device px per world unit
const MAX_TILES = 72;           // LRU cap (~72 MB of canvas backing store at most)
const MIN_S = 0.04, MAX_S = 10; // CSS px per world unit
const GRID = 160;               // spatial index cell, world units
const CHUNK_LEN = 400;          // long polylines are split into pieces about this long
const POI_ICONS = [
  [/cinema|planet/i, '🎬', '#8e5bd6'], [/dino/i, '🦖', '#4caf50'], [/superland|land$/i, '🎢', '#e8364f'],
  [/lake|swan|pond/i, '🦢', '#3f8efc'], [/mall/i, '🛍️', '#e0a03a'], [/square/i, '⛲', '#3f8efc'],
  [/synagogue/i, '🕍', '#3f6fd6'], [/tower/i, '🗼', '#8a6d4f'], [/station|train|rail/i, '🚆', '#2f6b9a'],
  [/kiosk|ice/i, '🍦', '#ff6f91'], [/lifeguard/i, '🛟', '#e8364f'], [/matkot|beach/i, '🏖️', '#e0a03a'],
  [/cellar|winery|wine/i, '🍷', '#9c2f4d'], [/sign|welcome/i, '🪧', '#2f6b9a'],
];

// ---------- small helpers ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function flatten(pts) {
  if (!pts) return null;
  if (typeof pts[0] === 'number') return Float64Array.from(pts);
  const f = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) { f[i * 2] = pts[i][0]; f[i * 2 + 1] = pts[i][1]; }
  return f;
}
function scaled(flat, k) {
  if (!flat) return null;
  const f = new Float64Array(flat.length);
  for (let i = 0; i < flat.length; i++) f[i] = flat[i] * k;
  return f;
}
function bboxOf(f, pad = 0) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i + 1 < f.length; i += 2) {
    const x = f[i], z = f[i + 1];
    if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z;
  }
  return { minX: a - pad, minZ: b - pad, maxX: c + pad, maxZ: d + pad };
}
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}
function inPoly(x, z, f) {
  let inside = false;
  const n = f.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = f[i * 2], zi = f[i * 2 + 1], xj = f[j * 2], zj = f[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function chunkLine(f, maxLen) {
  const out = [];
  let start = 0, len = 0;
  for (let k = 2; k < f.length; k += 2) {
    len += Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]);
    if (len >= maxLen && k < f.length - 2) { out.push(f.slice(start, k + 2)); start = k; len = 0; }
  }
  out.push(f.slice(start));
  return out;
}
const endKey = (f) => (f.length < 4 ? '' : [f[0], f[1], f[f.length - 2], f[f.length - 1]].map((v) => Math.round(v * 2)).join(','));
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
function niceMetres(maxM) {
  const p = 10 ** Math.floor(Math.log10(maxM));
  for (const m of [5, 2, 1]) if (m * p <= maxM) return m * p;
  return p;
}
const fmtDist = (m) => (m >= 1000 ? tr('map.unit_km', { n: (m / 1000).toFixed(m >= 10000 ? 0 : 1) }) : tr('map.unit_m', { n: Math.round(m) }));

// Uniform-grid spatial index; features register in every cell their bbox touches.
class Grid {
  constructor(cell) { this.cell = cell; this.cells = new Map(); this.stamp = 0; }
  _k(i, j) { return (i + 4096) * 8192 + (j + 4096); }
  insert(item) {
    const c = this.cell;
    item._s = 0;
    for (let i = Math.floor(item.minX / c); i <= Math.floor(item.maxX / c); i++) {
      for (let j = Math.floor(item.minZ / c); j <= Math.floor(item.maxZ / c); j++) {
        const k = this._k(i, j);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(item);
      }
    }
  }
  query(minX, minZ, maxX, maxZ, out = []) {
    const c = this.cell, s = ++this.stamp;
    const i0 = Math.floor(minX / c), i1 = Math.floor(maxX / c), j0 = Math.floor(minZ / c), j1 = Math.floor(maxZ / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const l = this.cells.get(this._k(i, j));
        if (!l) continue;
        for (const it of l) {
          if (it._s === s) continue;
          it._s = s;
          if (it.maxX < minX || it.minX > maxX || it.maxZ < minZ || it.minZ > maxZ) continue;
          out.push(it);
        }
      }
    }
    return out;
  }
}

// ---------- DOM ----------
const CSS = `
#bigmap { position: fixed; inset: 0; z-index: 40; display: none; background: ${C.land};
  font-family: ${FONT}; color: ${C.ink}; touch-action: none; user-select: none; }
#bigmap.on { display: block; }
#bigmap canvas.bm-view { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
#bigmap canvas.bm-view.drag { cursor: grabbing; }
#bigmap .bm-panel { position: absolute; background: rgba(255, 252, 244, 0.92); border: 2px solid rgba(35, 50, 74, 0.85);
  border-radius: 12px; box-shadow: 0 3px 0 rgba(35, 50, 74, 0.35); }
#bigmap .bm-title { inset-inline-start: 16px; top: 16px; padding: 7px 14px; max-width: calc(100vw - 120px); }
#bigmap .bm-title b { font-size: 20px; font-weight: 900; letter-spacing: 0.4px; }
#bigmap .bm-title div { font-size: 12px; opacity: 0.75; }
#bigmap .bm-tools { inset-inline-end: 16px; top: 16px; display: flex; flex-direction: column; gap: 6px; padding: 6px; }
#bigmap button { width: 38px; height: 38px; border: 2px solid ${C.ink}; border-radius: 9px; background: #fff8ea; color: ${C.ink};
  font: 900 18px/1 system-ui, sans-serif; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
#bigmap button:hover { background: ${C.player}; }
#bigmap button.bm-wp { background: ${C.waypoint}; display: none; }
#bigmap button.bm-wp.on { display: flex; }
#bigmap .bm-compass { inset-inline-end: 74px; top: 16px; width: 46px; height: 52px; border-radius: 23px; padding: 0; display: flex; align-items: center; justify-content: center; }
#bigmap .bm-scale { inset-inline-start: 16px; bottom: 16px; padding: 6px 10px 5px; font-size: 12px; font-weight: 800; }
#bigmap .bm-scale .bar { height: 7px; direction: ltr; border: 2px solid ${C.ink}; border-top: 0; margin-top: 2px; }
#bigmap .bm-coords { inset-inline-end: 16px; bottom: 16px; padding: 3px 9px; font-size: 11px; font-weight: 700; text-align: end; }
#bigmap .bm-coords a { color: inherit; }
#bigmap .bm-legend { inset-inline-start: 16px; bottom: 62px; padding: 8px 10px; font-size: 12px; display: none; }
#bigmap .bm-legend.on { display: block; }
#bigmap .bm-legend div { display: flex; align-items: center; gap: 8px; line-height: 19px; }
#bigmap .bm-legend canvas { width: 34px; height: 14px; }
#bigmap .bm-tip { position: absolute; pointer-events: none; padding: 4px 9px; font-size: 13px; font-weight: 800; display: none; white-space: nowrap; }
#bigmap .bm-tip small { display: block; font-size: 11px; font-weight: 700; opacity: 0.7; }
#bigmap .bm-loading { left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 10px 18px; font-weight: 800; display: none; }
#bigmap .bm-quest { left: 50%; bottom: 16px; transform: translateX(-50%); width: min(560px, calc(100vw - 40px)); padding: 10px 14px;
  font-size: 14px; line-height: 1.55; display: none; direction: rtl; }
#bigmap .bm-quest.on { display: block; }
#bigmap .bm-quest b { font-size: 15px; }
#bigmap .bm-quest .q-msg { margin-top: 6px; padding: 5px 9px; border-radius: 8px; background: #ffcb3d; font-weight: 800; display: none; }
#bigmap .bm-quest .q-msg.on { display: block; }
#bigmap .bm-quest .q-acts { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
#bigmap .bm-quest .q-acts button { width: auto; height: auto; padding: 5px 12px; font: 800 14px/1.3 ${FONT}; }
#bigmap .bm-quest kbd { display: inline-block; min-width: 1.4em; padding: 0 5px; border: 2px solid ${C.ink}; border-radius: 5px;
  background: #fff8ea; font: 900 12px/1.4 system-ui, sans-serif; text-align: center; }
@media (max-width: 720px) { #bigmap .bm-title div { display: none; } #bigmap .bm-coords { display: none; } }
`;

function h(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

// ---------- main ----------
export function createBigMap({ city = {}, landmarks = {}, getPlayer = () => null, data = null, getTarget = null,
  scene = null, minimapScale = 0.55, onWaypointReached = null, keys = true, onTeleport = null } = {}) {
  const roadsSrc = (city.roads || []).filter((r) => r && r.points && r.points.length >= 2);

  // ---- feature index ----
  const idx = { areas: new Grid(GRID), buildings: new Grid(GRID), roads: new Grid(GRID), named: [] };
  let places = [];      // { name, x, z, kind }
  const roadItems = [];
  let pois = [];        // { id, name, x, z, icon, color }
  let bounds = city.bounds ? { ...city.bounds } : null;
  let indexed = false, dataReady = false, dataLoading = false, rawData = data;

  function addArea(kind, flat, extra) {
    if (!flat || flat.length < 6) return;
    const b = bboxOf(flat);
    idx.areas.insert(Object.assign(b, { kind, f: flat }, extra));
  }
  function addRoad(r, flat) {
    const kind = r.kind || 'residential';
    const style = kind === 'rail' ? RAIL_STYLE : ROAD_STYLE[kind] || DEFAULT_ROAD;
    const width = r.width || (DATA_ROAD_M[kind] || 5) * SCALE;
    const whole = { f: flat, key: endKey(flat) };
    // Long ways are indexed as short pieces: canvas strokes the whole path even when the tile
    // clips it, so one city-long motorway would otherwise cost every tile it touches.
    for (const piece of chunkLine(flat, CHUNK_LEN)) {
      const item = Object.assign(bboxOf(piece, width / 2), {
        kind, style, width, f: piece, whole, name: r.name || r.nameEn || '', nameEn: r.nameEn || '', bridge: !!r.bridge, tunnel: !!r.tunnel, layer: r.layer || 0,
      });
      idx.roads.insert(item);
      roadItems.push(item);
      if (item.name && kind !== 'rail') idx.named.push(item);
    }
  }
  function addLine(kind, flat) {
    for (const piece of chunkLine(flat, CHUNK_LEN)) idx.areas.insert(Object.assign(bboxOf(piece), { kind, f: piece, line: true }));
  }

  function indexCity() {
    for (const r of roadsSrc) addRoad(r, flatten(r.points));
    for (const c of city.colliders || []) {
      if (!c || !c.points || c.points.length < 3) continue;
      const kind = c.kind || 'building';
      if (kind === 'building') { const f = flatten(c.points); idx.buildings.insert(Object.assign(bboxOf(f), { f })); }
      else if (kind === 'sea' && !(rawData && rawData.sea)) addArea('sea', flatten(c.points));
      else if (kind === 'water' && !(rawData && rawData.water)) addArea('water', flatten(c.points));
    }
    for (const c of landmarks.colliders || []) {
      const pts = Array.isArray(c) ? c : c && c.points;
      if (pts && pts.length >= 3) addArea('landmark', flatten(pts));
    }
    pois = (landmarks.pois || []).map((p) => {
      const key = `${p.id || ''} ${p.name || ''}`;
      const hit = POI_ICONS.find(([re]) => re.test(key));
      return { id: p.id, name: trOr(`poi.${p.id}`, p.name || p.id || ''), rawName: p.name || p.id || '', x: p.x, z: p.z, icon: hit ? hit[1] : '📍', color: hit ? hit[2] : '#e8364f' };
    });
    places = (city.places || []).map((p) => ({
      // Local (Hebrew) name first: contract places carry nameLocal; older city builds put it in name.
      name: p.nameLocal || (!isAscii(p.name || '') ? p.name : '') || p.name || p.nameEn || '', x: p.x, z: p.z, kind: p.kind || 'suburb',
    })).filter((p) => p.name);
    if (!bounds && roadsSrc.length) {
      bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
      idx.roads.query(-1e9, -1e9, 1e9, 1e9).forEach((r) => {
        bounds.minX = Math.min(bounds.minX, r.minX); bounds.maxX = Math.max(bounds.maxX, r.maxX);
        bounds.minZ = Math.min(bounds.minZ, r.minZ); bounds.maxZ = Math.max(bounds.maxZ, r.maxZ);
      });
    }
    indexed = true;
  }

  // Raw OSM extract: ground cover, sea, beach, places, boundary, and roads/buildings if the city gave none.
  function indexData(d) {
    const m = d.meta || {};
    // Factor from data units to world units. Measured against the city's own bounds when it was
    // built from this file, so the map agrees with the world even if the data is mid-rescale.
    let k = SCALE / (m.scale || SCALE);
    if (m.bounds && city.bounds && roadsSrc.length) {
      const r = (city.bounds.maxX - city.bounds.minX) / (m.bounds.maxX - m.bounds.minX);
      if (r > 0.2 && r < 5) k = r;
    }
    const F = (flat) => scaled(flat, k);
    if (d.sea && d.sea.length >= 6) addArea('sea', F(d.sea));
    if (d.coast && d.coast.length >= 4) {
      const coast = F(d.coast);
      // Extend the sea west of the coast line so the overview never shows land in the sea.
      const n = coast.length, far = 6000 * SCALE;
      const poly = new Float64Array(n + 8);
      poly.set(coast, 2);
      poly[0] = coast[0]; poly[1] = coast[1] - far;
      poly[n + 2] = coast[n - 2]; poly[n + 3] = coast[n - 1] + far;
      poly[n + 4] = coast[n - 2] - far; poly[n + 5] = coast[n - 1] + far;
      poly[n + 6] = coast[0] - far; poly[n + 7] = coast[1] - far;
      addArea('sea', poly);
      addLine('coast', coast);
    }
    for (const f of d.grass || []) addArea('grass', F(f));
    for (const [, f] of d.parks || []) addArea('park', F(f));
    for (const f of d.woods || []) addArea('wood', F(f));
    for (const f of d.pitches || []) addArea('pitch', F(f));
    for (const f of d.beach || []) addArea('beach', F(f));
    for (const f of d.platforms || []) addArea('platform', F(f));
    for (const [, f] of d.water || []) addArea('water', F(f));
    for (const f of d.boundary || []) {
      const ringF = F(f);
      const closed = new Float64Array(ringF.length + 2);
      closed.set(ringF); closed[ringF.length] = ringF[0]; closed[ringF.length + 1] = ringF[1];
      addLine('boundary', closed);
    }
    if (!roadsSrc.length) {
      for (const [kind, name, f, extra] of d.roads || []) {
        const e = extra && typeof extra === 'object' ? extra : {};
        addRoad({ kind, name, nameEn: e.nameEn, bridge: e.bridge, tunnel: e.tunnel, layer: e.layer }, F(f));
      }
      for (const [tunnel, f, extra] of d.rail || []) {
        const e = extra && typeof extra === 'object' ? extra : {};
        addRoad({ kind: 'rail', tunnel: !!(tunnel || e.tunnel), bridge: !!e.bridge, layer: e.layer }, F(f));
      }
    } else {
      // A city build that predates bridge/tunnel flags: take them from the extract, matching ways
      // by their end points (city.js keeps the data's geometry for every way it builds).
      if (!roadsSrc.some((r) => r.bridge || r.tunnel)) {
        const flags = new Map();
        for (const [, , f, e] of d.roads || []) if (e && (e.bridge || e.tunnel)) flags.set(endKey(F(f)), e);
        for (const [, f, e] of d.rail || []) if (e && e.bridge) flags.set(endKey(F(f)), e);
        if (flags.size) {
          for (const it of roadItems) {
            const e = flags.get(it.whole.key);
            if (e) { it.bridge = !!e.bridge; it.tunnel = !!e.tunnel; it.layer = e.layer || 0; }
          }
        }
      }
      // The city drops rail tunnels; show them dashed so the line is continuous on the map.
      if (!roadsSrc.some((r) => r.kind === 'rail' && r.tunnel)) {
        for (const [tunnel, f] of d.rail || []) if (tunnel) addRoad({ kind: 'rail', tunnel: true }, F(f));
      }
    }
    if (!(city.colliders || []).some((c) => c && (c.kind || 'building') === 'building')) {
      for (const [, , f] of d.buildings || []) { const g = F(f); idx.buildings.insert(Object.assign(bboxOf(g), { f: g })); }
    }
    // OSM place nodes are the honest neighbourhood centres; city.places may be sign positions.
    if (d.places && d.places.length) {
      places = d.places.map(([kind, nameLocal, nameEn, x, z]) => ({ kind, name: nameLocal || nameEn, x: x * k, z: z * k })).filter((p) => p.name);
    }
    if (!bounds && m.bounds) bounds = { minX: m.bounds.minX * k, maxX: m.bounds.maxX * k, minZ: m.bounds.minZ * k, maxZ: m.bounds.maxZ * k };
    dataReady = true;
    tiles.clear();
    warmQueue = null;
    dirty = true;
  }

  function ensureIndexed() {
    if (!indexed) indexCity();
    if (rawData && !dataReady) indexData(rawData);
    if (!rawData && !dataLoading) {
      dataLoading = true;
      fetch(DATA_URL).then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!d) return;
        rawData = d;
        if (indexed) indexData(d);
      }).catch((e) => console.warn('[bigmap] map data unavailable; drawing city layers only.', e));
    }
  }
  // Fetch early so the first open is instant (the file is already in the HTTP cache from city.js).
  if (!rawData) { dataLoading = true; fetch(DATA_URL).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { rawData = d; if (indexed) indexData(d); } }).catch(() => {}); }

  // ---- DOM ----
  if (!document.getElementById('bigmap-style')) {
    const st = document.createElement('style');
    st.id = 'bigmap-style'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const root = h('div', null, document.body); root.id = 'bigmap';
  const canvas = h('canvas', 'bm-view', root);
  const g = canvas.getContext('2d');
  const title = h('div', 'bm-panel bm-title', root, '<b></b><div></div>');
  const tools = h('div', 'bm-panel bm-tools', root);
  const buttons = [];
  const btn = (txt, key, fn, cls) => { const b = h('button', cls, tools, txt); buttons.push([b, key]); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
  btn('✕', 'map.close', () => close());
  btn('+', 'map.zoom_in', () => zoomBy(2));
  btn('−', 'map.zoom_out', () => zoomBy(0.5));
  btn('◎', 'map.center_on_me', () => centreOnMe());
  btn('?', 'map.legend', () => legend.classList.toggle('on'));
  const wpBtn = btn('⌫', 'map.clear_waypoint', () => clearWaypoint(), 'bm-wp');
  const compass = h('div', 'bm-panel bm-compass', root,
    `<svg width="34" height="40" viewBox="-17 -22 34 40" aria-label="North">` +
    `<text x="0" y="-12" text-anchor="middle" font-size="11" font-weight="900" fill="${C.ink}" font-family="system-ui, sans-serif" class="bm-n"></text>` +
    `<path d="M0,-9 L6,6 L0,3 L-6,6Z" fill="#e8364f" stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<path d="M0,15 L6,6 L0,3 L-6,6Z" fill="#fff8ea" stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round"/></svg>`);

  const scaleBox = h('div', 'bm-panel bm-scale', root, '<span dir="auto"></span><div class="bar"></div>');
  const coords = h('div', 'bm-panel bm-coords', root);
  const legend = h('div', 'bm-panel bm-legend', root);
  const tip = h('div', 'bm-panel bm-tip', root);
  const loadingEl = h('div', 'bm-panel bm-loading', root);
  // Quest overlay (the M15 deduction): a card with what to do, hint circles and crossed-out
  // guesses drawn on the map, and keys the quest handles while the map owns the keyboard.
  const questEl = h('div', 'bm-panel bm-quest', root, '<div class="q-body"></div><div class="q-msg"></div><div class="q-acts"></div>');
  for (const ev of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel']) questEl.addEventListener(ev, (e) => e.stopPropagation());
  let overlay = null;
  function setOverlay(o) {
    overlay = o || null;
    questEl.classList.toggle('on', !!(overlay && overlay.html));
    if (!overlay) return;
    questEl.querySelector('.q-body').innerHTML = overlay.html || '';
    const msg = questEl.querySelector('.q-msg');
    msg.innerHTML = overlay.msg || '';
    msg.classList.toggle('on', !!overlay.msg);
    const acts = questEl.querySelector('.q-acts');
    acts.innerHTML = '';
    for (const a of overlay.actions || []) {
      const b = h('button', '', acts, a.label);
      b.addEventListener('click', (e) => { e.stopPropagation(); a.fn(); });
    }
    dirty = true;
  }
  title.style.pointerEvents = 'none';
  function applyStrings() {
    title.firstChild.textContent = tr('map.title');
    title.lastChild.textContent = tr('map.hint').replace(/\{k:([^}]+)\}/g, '$1'); // key-cap markup is HUD-only
    for (const [b, key] of buttons) { b.title = tr(key); b.setAttribute('aria-label', tr(key)); }
    compass.querySelector('.bm-n').textContent = tr('map.north');
    compass.title = tr('map.north_up');
    scaleBox.title = tr('map.scale');
    loadingEl.textContent = tr('map.loading');
    if (minimap) minimap.title = tr('map.open');
    for (const p of pois) p.name = trOr(`poi.${p.id}`, p.rawName);
    legend.innerHTML = '';
    buildLegend();
    widthCache.clear();
    updateCoords();
  }

  // ---- view state ----
  let W = 0, H = 0, dpr = 1;
  const view = { cx: 0, cz: 0, s: 0.5 };
  const goal = { cx: 0, cz: 0, s: 0.5 };
  let anchor = null;               // zoom keeps this world point under this screen point
  const vel = { x: 0, z: 0 };      // pan inertia, world units / s
  let isOpenFlag = false, dirty = true, raf = 0, lastT = 0;
  let hover = null;                // { road } | { poi }
  let mouse = null;                // last pointer position in CSS px
  let waypoint = null;             // { x, z, label }
  const heldKeys = new Set();
  let minimap = null, mmCanvas = null, mmKey = '';

  function resize() {
    const nd = Math.min(window.devicePixelRatio || 1, 2);
    if (nd !== dpr) { tiles.clear(); warmQueue = null; }
    dpr = nd;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    dirty = true;
  }
  window.addEventListener('resize', () => { if (isOpenFlag) resize(); });

  const fitScale = () => (bounds ? Math.min(W / (bounds.maxX - bounds.minX), H / (bounds.maxZ - bounds.minZ)) * 0.95 : 0.2);
  const minScale = () => Math.max(MIN_S, fitScale() * 0.6);
  const toScreen = (x, z) => [(x - view.cx) * view.s + W / 2, (z - view.cz) * view.s + H / 2];
  const toWorld = (sx, sy) => [(sx - W / 2) / view.s + view.cx, (sy - H / 2) / view.s + view.cz];

  function clampCentre(v) {
    if (!bounds) return;
    const m = 300 * SCALE;
    v.cx = clamp(v.cx, bounds.minX - m, bounds.maxX + m);
    v.cz = clamp(v.cz, bounds.minZ - m, bounds.maxZ + m);
  }
  function zoomAt(factor, sx = W / 2, sy = H / 2) {
    const [wx, wz] = toWorld(sx, sy);
    goal.s = clamp(goal.s * factor, minScale(), MAX_S);
    anchor = { sx, sy, wx, wz };
    vel.x = vel.z = 0;
    dirty = true;
  }
  const zoomBy = (f) => zoomAt(f);
  function centreOnMe() {
    const p = getPlayer();
    if (!p) return;
    anchor = null; vel.x = vel.z = 0;
    goal.cx = p.x; goal.cz = p.z;
    goal.s = Math.max(goal.s, 0.8);
    dirty = true;
  }

  // ---- tiles ----
  const tiles = new Map(); // key -> { c, t, i, j, used }
  const dbgSkip = new Set();
  const perf = { tileMax: 0, tilesRendered: 0, frameMax: 0, frames: 0 };
  let frameNo = 0;
  const tkey = (t, i, j) => `${t}|${i}|${j}`;

  function renderTile(t, i, j) {
    const P = 2 ** t, span = TILE / P, x0 = i * span, z0 = j * span;
    const c = document.createElement('canvas');
    c.width = c.height = TILE;
    const tg = c.getContext('2d');
    tg.fillStyle = C.land;
    tg.fillRect(0, 0, TILE, TILE);
    tg.setTransform(P, 0, 0, P, -x0 * P, -z0 * P);
    const px = 1 / P;           // one device px in world units
    const css = P / dpr;        // CSS px per world unit at this tier
    const pad = 8 * dpr * px + 20;
    const qa = idx.areas.query(x0 - pad, z0 - pad, x0 + span + pad, z0 + span + pad);
    const qb = idx.buildings.query(x0 - pad, z0 - pad, x0 + span + pad, z0 + span + pad);
    const qr = idx.roads.query(x0 - pad, z0 - pad, x0 + span + pad, z0 + span + pad);
    const decim = px * 0.75;

    const trace = (f, closed) => {
      tg.moveTo(f[0], f[1]);
      let lx = f[0], lz = f[1];
      const n = f.length;
      for (let k = 2; k < n; k += 2) {
        const x = f[k], z = f[k + 1];
        if (k < n - 2 && Math.abs(x - lx) < decim && Math.abs(z - lz) < decim) continue;
        tg.lineTo(x, z); lx = x; lz = z;
      }
      if (closed) tg.closePath();
    };
    const fillKind = (kind, fill, stroke, strokePx) => {
      if (dbgSkip.has(kind)) return;
      tg.beginPath();
      let any = false;
      for (const a of qa) if (a.kind === kind) { trace(a.f, true); any = true; }
      if (!any) return;
      tg.fillStyle = fill; tg.fill();
      if (stroke && css > strokePx) { tg.strokeStyle = stroke; tg.lineWidth = Math.max(px, 0.6 * dpr * px); tg.stroke(); }
    };

    // ground
    fillKind('sea', C.sea);
    for (const a of qa) if (a.kind === 'coast') {
      tg.beginPath(); trace(a.f, false);
      tg.lineJoin = tg.lineCap = 'round';
      // Sand strip along the waterline, like the world's beach ribbon (about 56 m wide).
      tg.strokeStyle = C.beach; tg.lineWidth = 2 * 56 * SCALE; tg.stroke();
    }
    // Re-fill the sea on top of the sand ribbon's seaward half.
    fillKind('sea', C.sea);
    for (const a of qa) if (a.kind === 'coast') { tg.beginPath(); trace(a.f, false); tg.strokeStyle = C.seaEdge; tg.lineWidth = Math.max(1.2 * dpr * px, 0.6); tg.stroke(); }
    fillKind('beach', C.beach);
    fillKind('grass', C.grass);
    fillKind('park', C.park);
    fillKind('wood', C.wood);
    fillKind('pitch', C.pitch, C.pitchEdge, 0.8);
    fillKind('platform', C.platform, '#b2a690', 0.8);
    fillKind('water', C.water, C.seaEdge, 0.5);

    // tunnels, under everything else
    tg.lineCap = 'butt'; tg.lineJoin = 'round';
    for (const r of qr) {
      if (!r.tunnel || css < r.style.show) continue;
      tg.beginPath(); trace(r.f, false);
      tg.setLineDash([4 * dpr * px, 3 * dpr * px]);
      tg.strokeStyle = r.kind === 'rail' ? 'rgba(90, 90, 100, 0.6)' : 'rgba(120, 110, 100, 0.5)';
      tg.lineWidth = Math.max(r.width, r.style.min * dpr * px) * (r.kind === 'rail' ? 0.5 : 1);
      tg.stroke();
      tg.setLineDash([]);
    }

    // buildings: one path, tiny ones dropped at far tiers
    if (qb.length && !dbgSkip.has('buildings')) {
      const minSize = 1.1 * px;
      tg.beginPath();
      for (const b of qb) {
        if (b.maxX - b.minX < minSize && b.maxZ - b.minZ < minSize) continue;
        trace(b.f, true);
      }
      tg.fillStyle = C.building; tg.fill();
      if (css >= 0.9) { tg.strokeStyle = C.buildingEdge; tg.lineWidth = 0.8 * dpr * px; tg.stroke(); }
    }

    // roads: dashed paths, then casings, then fills (rank ascending so main roads win junctions)
    const surface = dbgSkip.has('roads') ? [] : qr.filter((r) => !r.tunnel && !r.bridge && css >= r.style.show).sort((a, b) => a.style.rank - b.style.rank);
    const wOf = (r) => Math.max(r.width, r.style.min * dpr * px);
    // Batched into one path per (kind, width) so a far tier strokes dozens of paths, not thousands.
    const groups = new Map();
    for (const r of surface) {
      if (r.kind === 'rail') continue;
      const w = r.style.dash ? Math.max(r.width * 0.6, r.style.min * dpr * px) : wOf(r);
      const key = `${r.kind}|${Math.round(w * P * 4)}`;
      let gr = groups.get(key);
      if (!gr) groups.set(key, (gr = { style: r.style, w, list: [] }));
      gr.list.push(r);
    }
    const ordered = [...groups.values()].sort((a, b) => a.style.rank - b.style.rank);
    const strokeGroup = (gr, color, w) => {
      tg.beginPath();
      for (const r of gr.list) trace(r.f, false);
      tg.strokeStyle = color; tg.lineWidth = w; tg.stroke();
    };
    // Paths: butt caps, or round caps would close the dash gaps; drawn at 60% of their true
    // width so they read as lines next to the carriageways rather than as streets.
    tg.lineCap = 'butt'; tg.lineJoin = 'round';
    for (const gr of ordered) {
      if (!gr.style.dash) continue;
      tg.setLineDash([Math.max(gr.w * 1.6, 4 * dpr * px), Math.max(gr.w * 1.1, 3 * dpr * px)]);
      strokeGroup(gr, gr.style.dash, gr.w);
    }
    tg.setLineDash([]);
    tg.lineCap = 'round';
    const casing = (css < 0.25 ? 0.5 : 1.1) * dpr * px * 2;
    for (const gr of ordered) if (!gr.style.dash) strokeGroup(gr, gr.style.casing, gr.w + casing);
    for (const gr of ordered) if (!gr.style.dash) strokeGroup(gr, gr.style.fill, gr.w);
    const drawRail = (r) => {
      const w = Math.max(r.width * 0.9, RAIL_STYLE.min * dpr * px);
      tg.beginPath(); trace(r.f, false);
      tg.lineCap = 'butt';
      tg.strokeStyle = C.rail; tg.lineWidth = w; tg.stroke();
      if (css >= 0.15) {
        tg.setLineDash([7 * dpr * px, 7 * dpr * px]);
        tg.strokeStyle = C.railDash; tg.lineWidth = w * 0.45; tg.stroke();
        tg.setLineDash([]);
      }
      tg.lineCap = 'round';
    };
    for (const r of surface) if (r.kind === 'rail') drawRail(r);

    // bridges on top, by layer: dark casing with butt ends reads as a deck over whatever is below
    const bridges = qr.filter((r) => r.bridge && css >= r.style.show).sort((a, b) => a.layer - b.layer || a.style.rank - b.style.rank);
    for (const r of bridges) {
      tg.lineCap = 'butt';
      tg.beginPath(); trace(r.f, false);
      tg.strokeStyle = C.bridgeCasing; tg.lineWidth = wOf(r) + 3.2 * dpr * px; tg.stroke();
      if (r.kind === 'rail') drawRail(r);
      else {
        tg.beginPath(); trace(r.f, false);
        tg.strokeStyle = r.style.fill || r.style.dash; tg.lineWidth = wOf(r); tg.stroke();
      }
    }
    tg.lineCap = 'round';

    // landmark footprints and city limits on top of the street grid
    fillKind('landmark', C.landmark, C.landmarkEdge, 0);
    for (const a of qa) if (a.kind === 'boundary') {
      tg.beginPath(); trace(a.f, false);
      tg.setLineDash([6 * dpr * px, 4 * dpr * px]);
      tg.strokeStyle = C.boundary; tg.lineWidth = 2 * dpr * px; tg.stroke();
      tg.setLineDash([]);
    }
    return c;
  }

  // Far tiers hold the whole city in a few tiles that each take a long time to raster; they are
  // rendered one per idle frame while the map is open and never evicted, so zooming out and the
  // coarse fallback under not-yet-rendered tiles are always ready.
  const PIN_TIER = -3;
  let warmQueue = null;
  function buildWarmQueue() {
    warmQueue = [];
    if (!bounds) return;
    for (let t = T_MIN; t <= PIN_TIER; t++) {
      const span = TILE / 2 ** t;
      for (let i = Math.floor(bounds.minX / span); i <= Math.floor(bounds.maxX / span); i++) {
        for (let j = Math.floor(bounds.minZ / span); j <= Math.floor(bounds.maxZ / span); j++) warmQueue.push([t, i, j]);
      }
    }
  }
  function warmOne() {
    if (!warmQueue) buildWarmQueue();
    while (warmQueue.length) {
      const [t, i, j] = warmQueue.shift();
      const k = tkey(t, i, j);
      if (tiles.has(k)) continue;
      tiles.set(k, { c: renderTile(t, i, j), used: frameNo, t });
      return;
    }
  }

  function evictTiles() {
    if (tiles.size <= MAX_TILES) return;
    const list = [...tiles.entries()].filter((e) => !(e[1].t <= PIN_TIER)).sort((a, b) => a[1].used - b[1].used);
    const excess = Math.min(tiles.size - MAX_TILES, list.length);
    for (let k = 0; k < excess; k++) tiles.delete(list[k][0]);
  }

  function drawTiles(budgetMs) {
    const sd = view.s * dpr; // device px per world unit on screen
    const t = clamp(Math.ceil(Math.log2(sd) - 0.15), T_MIN, T_MAX);
    const P = 2 ** t, span = TILE / P;
    const [wx0, wz0] = toWorld(0, 0), [wx1, wz1] = toWorld(W, H);
    const i0 = Math.floor(wx0 / span), i1 = Math.floor(wx1 / span), j0 = Math.floor(wz0 / span), j1 = Math.floor(wz1 / span);
    const need = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) need.push([i, j]);
    const ci = (view.cx / span), cj = (view.cz / span);
    need.sort((a, b) => Math.hypot(a[0] + 0.5 - ci, a[1] + 0.5 - cj) - Math.hypot(b[0] + 0.5 - ci, b[1] + 0.5 - cj));
    const start = performance.now();
    let pending = false, rendered = 0;
    g.imageSmoothingEnabled = true;
    const blit = (img, x0, z0, sp, sx0 = 0, sy0 = 0, sw = TILE) => {
      // Snap to device pixels on both edges so neighbouring tiles never leave hairline seams.
      const ax = Math.round(((x0 - view.cx) * view.s + W / 2) * dpr), ay = Math.round(((z0 - view.cz) * view.s + H / 2) * dpr);
      const bx = Math.round(((x0 + sp - view.cx) * view.s + W / 2) * dpr), by = Math.round(((z0 + sp - view.cz) * view.s + H / 2) * dpr);
      g.drawImage(img, sx0, sy0, sw, sw, ax, ay, bx - ax, by - ay);
    };
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const [i, j] of need) {
      const k = tkey(t, i, j);
      let tile = tiles.get(k);
      // Canvas 2D defers rasterisation, so the clock under-reads; the count cap keeps frames smooth.
      if (!tile && rendered < 3 && performance.now() - start < budgetMs) {
        rendered++;
        const t0 = performance.now();
        tile = { c: renderTile(t, i, j), used: frameNo, t };
        perf.tileMax = Math.max(perf.tileMax, performance.now() - t0); perf.tilesRendered++;
        tiles.set(k, tile);
      }
      if (tile) { tile.used = frameNo; blit(tile.c, i * span, j * span, span); continue; }
      pending = true;
      // Not rendered yet: stretch a coarser cached tile over the gap.
      for (let pt = t - 1; pt >= T_MIN; pt--) {
        const f = 2 ** (t - pt), pi = Math.floor(i / f), pj = Math.floor(j / f);
        const parent = tiles.get(tkey(pt, pi, pj));
        if (!parent) continue;
        parent.used = frameNo;
        const sub = TILE / f;
        blit(parent.c, i * span, j * span, span, (i - pi * f) * sub, (j - pj * f) * sub, sub);
        break;
      }
    }
    evictTiles();
    return pending;
  }

  // ---- labels and markers ----
  const widthCache = new Map();
  function textW(font, s) {
    const k = font + '|' + s;
    let w = widthCache.get(k);
    if (w === undefined) { g.font = font; w = g.measureText(s).width; widthCache.set(k, w); }
    return w;
  }
  function overlaps(boxes, b) {
    for (const o of boxes) if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return true;
    return false;
  }
  const pageRtl = () => (document.documentElement.dir || document.body.dir) === 'rtl';
  function haloText(text, x, y, font, fill, haloW = 3.5) {
    g.font = font;
    // Hebrew runs render right-to-left; other text follows the page direction.
    if ('direction' in g) g.direction = HEBREW.test(text) || pageRtl() ? 'rtl' : 'ltr';
    g.lineJoin = 'round';
    g.strokeStyle = C.halo; g.lineWidth = haloW; g.strokeText(text, x, y);
    g.fillStyle = fill; g.fillText(text, x, y);
  }

  function drawOverlay(now) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = view.s;
    const boxes = [];
    const ops = [];  // deferred so higher-priority items are placed first but drawn last
    const player = getPlayer();

    // hovered road highlight
    if (hover && hover.road) {
      const f = hover.road.whole.f;
      g.beginPath();
      for (let k = 0; k < f.length; k += 2) { const [x, y] = toScreen(f[k], f[k + 1]); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = C.hover; g.lineCap = g.lineJoin = 'round';
      g.lineWidth = Math.max(hover.road.width * s, 4) + 6; g.stroke();
    }

    // GPS route (quests or a mini-game): above the roads, under every marker. The map redraws
    // each frame while open, so a re-planned route shows up on its own.
    const route = routeFn ? routeFn() : gpsRef && gpsRef.active ? gpsRef.remaining() : null;
    if (route && route.length > 1) {
      g.beginPath();
      for (let k = 0; k < route.length; k++) { const [x, y] = toScreen(route[k].x, route[k].z); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.lineCap = g.lineJoin = 'round';
      g.strokeStyle = C.ink; g.lineWidth = 8; g.stroke();
      g.strokeStyle = '#2ec4b6'; g.lineWidth = 4.5; g.stroke();
    }

    // reserve space for high-priority markers first
    const pp = player ? toScreen(player.x, player.z) : null;
    if (pp) boxes.push({ x0: pp[0] - 16, y0: pp[1] - 16, x1: pp[0] + 16, y1: pp[1] + 16 });
    const wpS = waypoint ? toScreen(waypoint.x, waypoint.z) : null;
    if (wpS) boxes.push({ x0: wpS[0] - 12, y0: wpS[1] - 30, x1: wpS[0] + 12, y1: wpS[1] + 4 });

    // POIs
    const poiFont = `800 12px ${FONT}`;
    for (const p of pois) {
      const [x, y] = toScreen(p.x, p.z);
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      const r = 12;
      const ib = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
      const hovered = hover && hover.poi === p;
      if (overlaps(boxes, ib) && !hovered) {
        ops.push(() => { g.fillStyle = p.color; g.strokeStyle = C.ink; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); g.stroke(); });
        continue;
      }
      boxes.push(ib);
      const tw = textW(poiFont, p.name);
      const lb = { x0: x + r + 2, y0: y - 8, x1: x + r + 6 + tw, y1: y + 8 };
      const showName = (s >= 0.12 || hovered) && !overlaps(boxes, lb);
      if (showName) boxes.push(lb);
      ops.push(() => {
        g.beginPath(); g.arc(x, y + 1.5, r, 0, Math.PI * 2); g.fillStyle = 'rgba(35, 50, 74, 0.35)'; g.fill();
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = '#fffaf0'; g.fill();
        g.lineWidth = hovered ? 3.5 : 2.5; g.strokeStyle = p.color; g.stroke();
        g.font = '13px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = C.ink; g.fillText(p.icon, x, y + 1);
        if (showName) { g.textAlign = 'left'; haloText(p.name, x + r + 4, y + 1, poiFont, C.ink); }
      });
    }

    // neighbourhoods
    if (s < 4) {
      const fs = Math.round(clamp(12 + Math.log2(s / 0.1) * 1.6, 12, 19));
      const font = `900 ${fs}px ${FONT}`;
      const alpha = s > 1.5 ? 0.55 : 0.85;
      for (const p of places) {
        const [x, y] = toScreen(p.x, p.z);
        if (x < -150 || y < -30 || x > W + 150 || y > H + 30) continue;
        const heb = HEBREW.test(p.name);
        const label = heb ? p.name : p.name.toUpperCase();
        const spacing = heb ? 0.4 : 1.2;
        const tw = textW(font, label) + label.length * spacing;
        const b = { x0: x - tw / 2, y0: y - fs / 2 - 2, x1: x + tw / 2, y1: y + fs / 2 + 2 };
        if (overlaps(boxes, b)) continue;
        boxes.push(b);
        ops.unshift(() => {
          g.textAlign = 'center'; g.textBaseline = 'middle';
          if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
          g.globalAlpha = alpha;
          haloText(label, x, y, font, '#5b3f8c', 4);
          g.globalAlpha = 1;
          if ('letterSpacing' in g) g.letterSpacing = '0px';
        });
      }
    }

    // street names along the longest straight run that fits on screen
    if (s >= 0.7) {
      const [wx0, wz0] = toWorld(0, 0), [wx1, wz1] = toWorld(W, H);
      const vis = idx.roads.query(wx0, wz0, wx1, wz1).filter((r) => r.name && r.kind !== 'rail' && s >= r.style.show)
        .sort((a, b) => b.style.rank - a.style.rank);
      const seen = new Map();
      let count = 0;
      for (const r of vis) {
        if (count > 70) break;
        const major = r.style.rank >= 6;
        const font = `${major ? 800 : 700} ${major ? 12 : 11}px ${FONT}`;
        const tw = textW(font, r.name);
        const f = r.f;
        let best = null;
        let ax = 0, ay = 0, ang0 = null, runStartX = 0, runStartY = 0, runLen = 0;
        const consider = (ex, ey) => {
          if (runLen > tw + 18 && (!best || runLen > best.len)) best = { x0: runStartX, y0: runStartY, x1: ex, y1: ey, len: runLen };
        };
        for (let k = 0; k < f.length; k += 2) {
          const [x, y] = toScreen(f[k], f[k + 1]);
          if (k > 0) {
            const dx = x - ax, dy = y - ay, l = Math.hypot(dx, dy);
            if (l > 0.01) {
              const a = Math.atan2(dy, dx);
              let da = ang0 === null ? 0 : Math.abs(a - ang0);
              if (da > Math.PI) da = 2 * Math.PI - da;
              if (ang0 === null || da > 0.3) { consider(ax, ay); runStartX = ax; runStartY = ay; runLen = 0; ang0 = a; }
              runLen += l;
            }
          }
          ax = x; ay = y;
        }
        consider(ax, ay);
        if (!best) continue;
        const mx = (best.x0 + best.x1) / 2, my = (best.y0 + best.y1) / 2;
        if (mx < 20 || my < 20 || mx > W - 20 || my > H - 20) continue;
        const prev = seen.get(r.name);
        if (prev && prev.some(([px, py]) => Math.hypot(px - mx, py - my) < 320)) continue;
        let ang = Math.atan2(best.y1 - best.y0, best.x1 - best.x0);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        const hw = (tw + 6) / 2, hh = 8;
        const ex = Math.abs(Math.cos(ang)) * hw + Math.abs(Math.sin(ang)) * hh, ey = Math.abs(Math.sin(ang)) * hw + Math.abs(Math.cos(ang)) * hh;
        const b = { x0: mx - ex, y0: my - ey, x1: mx + ex, y1: my + ey };
        if (overlaps(boxes, b)) continue;
        boxes.push(b);
        if (!prev) seen.set(r.name, [[mx, my]]); else prev.push([mx, my]);
        count++;
        const name = r.name;
        ops.unshift(() => {
          g.save(); g.translate(mx, my); g.rotate(ang);
          g.textAlign = 'center'; g.textBaseline = 'middle';
          haloText(name, 0, 0.5, font, major ? '#3b2f22' : '#4b4f58', 3);
          g.restore();
        });
      }
    }

    for (const op of ops) op();
    if ('direction' in g) g.direction = 'ltr';

    // quest overlay: hint areas and guesses already ruled out
    if (overlay) {
      for (const c of overlay.circles || []) {
        const [cx, cy] = toScreen(c.x, c.z), r = Math.max(14, c.r * view.s);
        g.fillStyle = 'rgba(255, 203, 61, 0.28)'; g.strokeStyle = '#e8364f'; g.lineWidth = 3;
        g.setLineDash([10, 7]); g.lineDashOffset = -now / 50;
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill(); g.stroke();
        g.setLineDash([]); g.lineDashOffset = 0;
        if (c.label) { g.textAlign = 'center'; g.textBaseline = 'middle'; haloText(c.label, cx, cy - r - 12, `900 14px ${FONT}`, C.ink); }
      }
      for (const m of overlay.crosses || []) {
        const [mx, my] = toScreen(m.x, m.z);
        g.strokeStyle = '#e8364f'; g.lineWidth = 4;
        g.beginPath(); g.moveTo(mx - 8, my - 8); g.lineTo(mx + 8, my + 8); g.moveTo(mx + 8, my - 8); g.lineTo(mx - 8, my + 8); g.stroke();
      }
    }

    // quest target (if the lead passes getTarget)
    const target = getTarget ? getTarget() : null;
    if (target) drawPin(target.x, target.z, C.target, target.giver ? '!' : '★', now, null);

    // waypoint + guide line from the player
    if (waypoint) {
      if (pp) {
        g.setLineDash([6, 6]); g.lineDashOffset = -now / 40;
        g.strokeStyle = 'rgba(46, 196, 182, 0.9)'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(pp[0], pp[1]); g.lineTo(wpS[0], wpS[1]); g.stroke();
        g.setLineDash([]); g.lineDashOffset = 0;
      }
      const d = player ? Math.hypot(waypoint.x - player.x, waypoint.z - player.z) / SCALE : null;
      drawPin(waypoint.x, waypoint.z, C.waypoint, '●', now, [waypoint.label, d != null ? fmtDist(d) : ''].filter(Boolean).join(' · '));
    }

    // player
    if (player) drawPlayer(player, now);
  }

  function drawPin(x, z, color, glyph, now, label) {
    let [sx, sy] = toScreen(x, z);
    const off = sx < 12 || sy < 12 || sx > W - 12 || sy > H - 12;
    if (off) { edgeArrow(sx, sy, color); return; }
    const bob = Math.sin(now / 220) * 1.5;
    g.save(); g.translate(sx, sy);
    g.fillStyle = 'rgba(35, 50, 74, 0.25)'; g.beginPath(); g.ellipse(0, 0, 7, 3, 0, 0, Math.PI * 2); g.fill();
    g.translate(0, bob);
    g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-4, -8, -11, -12, -11, -20); g.arc(0, -20, 11, Math.PI, 0); g.bezierCurveTo(11, -12, 4, -8, 0, 0); g.closePath();
    g.fillStyle = color; g.strokeStyle = C.ink; g.lineWidth = 2.2; g.fill(); g.stroke();
    g.fillStyle = C.ink; g.font = '900 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(glyph === '●' ? '' : glyph, 0, -20);
    if (glyph === '●') { g.fillStyle = '#fffaf0'; g.beginPath(); g.arc(0, -20, 4, 0, Math.PI * 2); g.fill(); }
    g.restore();
    if (label) { g.textAlign = 'center'; g.textBaseline = 'middle'; haloText(label, sx, sy - 40 + bob, `800 12px ${FONT}`, C.ink); }
  }

  function edgeArrow(sx, sy, color, text) {
    // Inset enough to clear the corner panels (scale bar, attribution, tool column).
    const cx = W / 2, cy = H / 2, padX = 90, padY = 72;
    const ang = Math.atan2(sy - cy, sx - cx);
    const k = Math.min((W / 2 - padX) / Math.max(1e-6, Math.abs(Math.cos(ang))), (H / 2 - padY) / Math.max(1e-6, Math.abs(Math.sin(ang))));
    const x = cx + Math.cos(ang) * k, y = cy + Math.sin(ang) * k;
    g.save(); g.translate(x, y); g.rotate(ang);
    g.beginPath(); g.moveTo(14, 0); g.lineTo(-8, 10); g.lineTo(-3, 0); g.lineTo(-8, -10); g.closePath();
    g.fillStyle = color; g.strokeStyle = C.ink; g.lineWidth = 2.2; g.fill(); g.stroke();
    g.restore();
    if (text) { g.textAlign = 'center'; g.textBaseline = 'middle'; haloText(text, x - Math.cos(ang) * 22, y - Math.sin(ang) * 22, `900 12px ${FONT}`, C.ink); }
  }

  function drawPlayer(p, now) {
    const [sx, sy] = toScreen(p.x, p.z);
    if (sx < 10 || sy < 10 || sx > W - 10 || sy > H - 10) { edgeArrow(sx, sy, C.player, tr('map.you')); return; }
    const pulse = (now / 1400) % 1;
    g.beginPath(); g.arc(sx, sy, 10 + pulse * 22, 0, Math.PI * 2);
    g.fillStyle = `rgba(255, 179, 71, ${0.35 * (1 - pulse)})`; g.fill();
    g.save(); g.translate(sx, sy);
    // heading: forward is (sin h, cos h) in (x, z); screen y grows with z, so rotate an up-arrow by PI - h.
    g.rotate(Math.PI - (p.heading || 0));
    g.beginPath(); g.moveTo(0, -14); g.lineTo(10, 11); g.lineTo(0, 5.5); g.lineTo(-10, 11); g.closePath();
    g.fillStyle = C.player; g.strokeStyle = C.ink; g.lineWidth = 2.5; g.lineJoin = 'round'; g.fill(); g.stroke();
    g.restore();
  }

  function updateChrome() {
    // scale bar: largest 1/2/5 x 10^n metres that fits in 130 CSS px
    const mPerPx = 1 / (view.s * SCALE);
    const m = niceMetres(130 * mPerPx);
    scaleBox.firstChild.textContent = fmtDist(m);
    scaleBox.lastChild.style.width = `${Math.round(m / mPerPx)}px`;
    wpBtn.classList.toggle('on', !!waypoint);
    loadingEl.style.display = !dataReady && !roadsSrc.length ? 'block' : 'none';
  }

  function updateCoords() {
    coords.innerHTML = '';
    if (mouse) {
      const ll = unproject(...toWorld(mouse.x, mouse.y));
      const line = h('div', null, coords);
      line.dir = 'ltr';
      line.textContent = tr('map.lat_lon', { lat: ll.lat.toFixed(5), lon: ll.lon.toFixed(5) });
    }
    const attr = h('div', null, coords);
    attr.dir = 'auto';
    attr.textContent = tr('map.attribution');
  }

  // ---- frame loop (own rAF while open; the game's update(dt) only animates the world marker) ----
  function step(dt) {
    const k = 1 - Math.exp(-dt * 11);
    const before = view.s;
    view.s = Math.exp(Math.log(view.s) + (Math.log(goal.s) - Math.log(view.s)) * k);
    if (Math.abs(Math.log(goal.s / view.s)) < 1e-3) view.s = goal.s;
    if (anchor) {
      view.cx = anchor.wx - (anchor.sx - W / 2) / view.s;
      view.cz = anchor.wz - (anchor.sy - H / 2) / view.s;
      goal.cx = view.cx; goal.cz = view.cz;
      if (view.s === goal.s) anchor = null;
    } else if (!drag) {
      if (vel.x || vel.z) {
        goal.cx += vel.x * dt; goal.cz += vel.z * dt;
        view.cx = goal.cx; view.cz = goal.cz;
        const damp = Math.exp(-dt * 5);
        vel.x *= damp; vel.z *= damp;
        if (Math.hypot(vel.x, vel.z) * view.s < 8) vel.x = vel.z = 0;
      } else {
        view.cx += (goal.cx - view.cx) * k; view.cz += (goal.cz - view.cz) * k;
      }
    }
    // keyboard pan
    const kx = (heldKeys.has('ArrowRight') || heldKeys.has('KeyD') ? 1 : 0) - (heldKeys.has('ArrowLeft') || heldKeys.has('KeyA') ? 1 : 0);
    const kz = (heldKeys.has('ArrowDown') || heldKeys.has('KeyS') ? 1 : 0) - (heldKeys.has('ArrowUp') || heldKeys.has('KeyW') ? 1 : 0);
    if (kx || kz) { goal.cx += (kx * 700 * dt) / view.s; goal.cz += (kz * 700 * dt) / view.s; view.cx = goal.cx; view.cz = goal.cz; anchor = null; }
    clampCentre(view); clampCentre(goal);
    return before !== view.s || anchor || vel.x || vel.z || kx || kz || Math.abs(goal.cx - view.cx) * view.s > 0.05 || Math.abs(goal.cz - view.cz) * view.s > 0.05;
  }

  function frame(t) {
    if (!isOpenFlag) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    const dt = Math.min((t - (lastT || t)) / 1000, 0.05);
    lastT = t;
    frameNo++;
    const moving = step(dt) || !!drag || !!pinch;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.land;
    g.fillRect(0, 0, canvas.width, canvas.height);
    const f0 = performance.now();
    const pending = drawTiles(14);
    if (!pending && !moving && dataReady) warmOne();
    drawOverlay(t);
    perf.frames++;
    if (perf.frames > 2) perf.frameMax = Math.max(perf.frameMax, performance.now() - f0);
    updateChrome();
    if (mouse && frameNo % 6 === 0) updateCoords();
  }

  // ---- hit testing ----
  function hitTest(sx, sy) {
    for (const p of pois) {
      const [x, y] = toScreen(p.x, p.z);
      if (Math.hypot(x - sx, y - sy) < 13) return { poi: p };
    }
    const [wx, wz] = toWorld(sx, sy);
    const tol = 7 / view.s;
    const near = idx.roads.query(wx - tol, wz - tol, wx + tol, wz + tol);
    let best = null, bd = Infinity;
    for (const r of near) {
      if (view.s < r.style.show) continue;
      const half = Math.max(r.width, r.style.min / view.s) / 2 + 4 / view.s;
      const f = r.f;
      for (let k = 0; k + 3 < f.length; k += 2) {
        const d = Math.sqrt(segDist2(wx, wz, f[k], f[k + 1], f[k + 2], f[k + 3]));
        // Prefer bridges and bigger roads on a near-tie, since they are drawn on top.
        const score = d - (r.bridge ? 2 / view.s : 0) - r.style.rank * 0.05 / view.s;
        if (d <= half && score < bd) { bd = score; best = r; }
      }
    }
    return best ? { road: best } : null;
  }

  function showTip(hit, sx, sy) {
    if (!hit) { tip.style.display = 'none'; return; }
    let title, sub;
    if (hit.poi) { title = hit.poi.name; sub = tr('map.landmark'); }
    else {
      const r = hit.road;
      const kl = tr(`map.kind.${r.kind}`) === `map.kind.${r.kind}` ? r.kind.replace(/_/g, ' ') : tr(`map.kind.${r.kind}`);
      title = r.name || r.nameEn || tr('map.unnamed', { kind: kl });
      sub = [(r.name || r.nameEn) ? kl : '', r.bridge ? tr('map.bridge') : '', r.tunnel ? tr('map.tunnel') : ''].filter(Boolean).join(' · ');
    }
    tip.innerHTML = '';
    tip.append(document.createTextNode(title));
    if (sub) { const sm = document.createElement('small'); sm.textContent = sub; tip.appendChild(sm); }
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(sx + 16, W - tw - 8)}px`;
    tip.style.top = `${sy + 18}px`;
  }

  // ---- pointer input ----
  const pointers = new Map();
  let drag = null;   // { x, y, t, moved, lastX, lastY, lastT }
  let pinch = null;  // { d, mx, my }

  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    anchor = null; vel.x = vel.z = 0;
    goal.cx = view.cx; goal.cz = view.cz; goal.s = view.s;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      if (drag) drag.moved = true;
    } else if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, lastX: e.clientX, lastY: e.clientY, lastT: performance.now(), button: e.button };
      canvas.classList.add('drag');
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    const pt = pointers.get(e.pointerId);
    if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const [wx, wz] = toWorld(pinch.mx, pinch.my);
      view.s = goal.s = clamp(view.s * (d / Math.max(1, pinch.d)), minScale(), MAX_S);
      view.cx = wx - (mx - W / 2) / view.s; view.cz = wz - (my - H / 2) / view.s;
      goal.cx = view.cx; goal.cz = view.cz;
      pinch = { d, mx, my };
      return;
    }
    if (drag) {
      const now = performance.now();
      const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) drag.moved = true;
      if (drag.moved) {
        view.cx -= dx / view.s; view.cz -= dy / view.s;
        goal.cx = view.cx; goal.cz = view.cz;
        const dtm = Math.max(1, now - drag.lastT) / 1000;
        // Low-passed release velocity for inertia.
        vel.x = vel.x * 0.6 + (-dx / view.s / dtm) * 0.4; vel.z = vel.z * 0.6 + (-dy / view.s / dtm) * 0.4;
      }
      drag.lastX = e.clientX; drag.lastY = e.clientY; drag.lastT = now;
      tip.style.display = 'none';
      return;
    }
    hover = hitTest(e.clientX, e.clientY);
    canvas.style.cursor = hover && hover.poi ? 'pointer' : '';
    showTip(hover, e.clientX, e.clientY);
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pinch && pointers.size < 2) {
      pinch = null;
      const rest = [...pointers.values()][0];
      if (rest) drag = { x: rest.x, y: rest.y, t: 0, moved: true, lastX: rest.x, lastY: rest.y, lastT: performance.now() };
      vel.x = vel.z = 0;
      return;
    }
    if (!drag || pointers.size) return;
    canvas.classList.remove('drag');
    const d = drag; drag = null;
    if (performance.now() - d.lastT > 80) vel.x = vel.z = 0; // held still before release: no fling
    if (!d.moved && e.type === 'pointerup' && d.button === 0) {
      vel.x = vel.z = 0;
      onClick(e.clientX, e.clientY);
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; mouse = null; tip.style.display = 'none'; updateCoords(); } });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); clearWaypoint(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1);
    // Trackpad pinch arrives as ctrl+wheel with small deltas; make it as responsive as a wheel.
    const kk = e.ctrlKey ? 0.012 : 0.0022;
    dy = clamp(dy, -300, 300);
    zoomAt(Math.exp(-dy * kk), e.clientX, e.clientY);
  }, { passive: false });

  // Double-click jumps the player there: the founder inspects the city spot by spot.
  canvas.addEventListener('dblclick', (e) => {
    if (!onTeleport) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY; // same screen space as onClick (full-screen canvas)
    const hit = hitTest(sx, sy);
    const [wx, wz] = hit && hit.poi ? [hit.poi.x, hit.poi.z] : toWorld(sx, sy);
    clearWaypoint();
    onTeleport(wx, wz);
  });

  function onClick(sx, sy) {
    if (waypoint) {
      const [x, y] = toScreen(waypoint.x, waypoint.z);
      if (Math.hypot(x - sx, y - sy - 18) < 16) { clearWaypoint(); return; }
    }
    const hit = hitTest(sx, sy);
    if (hit && hit.poi) { setWaypoint(hit.poi.x, hit.poi.z, hit.poi.name); return; }
    const [wx, wz] = toWorld(sx, sy);
    setWaypoint(wx, wz, hit && hit.road && hit.road.name ? hit.road.name : '');
  }

  // ---- keyboard ----
  const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
    if (!isOpenFlag) {
      if (e.code === 'KeyM' && !e.repeat) { open(); e.preventDefault(); }
      return;
    }
    // While open the map owns the keyboard: the game never sees these keydowns (keyups still pass).
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.repeat && !/^(Arrow|Key[WASD])/.test(e.code)) return;
    switch (e.code) {
      case 'KeyM': case 'Escape': close(); break;
      case 'Equal': case 'NumpadAdd': zoomBy(2); break;
      case 'Minus': case 'NumpadSubtract': zoomBy(0.5); break;
      case 'KeyC': case 'Space': centreOnMe(); break;
      case 'KeyL': legend.classList.toggle('on'); break;
      case 'Backspace': case 'Delete': clearWaypoint(); break;
      default:
        if (overlay && overlay.keys && overlay.keys[e.code]) { overlay.keys[e.code](); break; }
        heldKeys.add(e.code);
    }
  }
  const onKeyUp = (e) => heldKeys.delete(e.code);
  if (keys) {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  }

  // ---- legend ----
  function buildLegend() {
    for (const kind of LEGEND_ITEMS) {
      const label = tr(`map.legend.${kind}`);
      const row = h('div', null, legend);
      const c = h('canvas', null, row);
      c.width = 68; c.height = 28;
      const lg = c.getContext('2d');
      lg.scale(2, 2);
      lg.lineCap = 'round';
      const line = (col, w, dash) => { lg.beginPath(); lg.moveTo(3, 7); lg.lineTo(31, 7); lg.setLineDash(dash || []); lg.strokeStyle = col; lg.lineWidth = w; lg.stroke(); lg.setLineDash([]); };
      const box = (fill, stroke) => { lg.fillStyle = fill; lg.fillRect(5, 2, 24, 10); if (stroke) { lg.strokeStyle = stroke; lg.lineWidth = 1; lg.strokeRect(5.5, 2.5, 23, 9); } };
      const st = ROAD_STYLE[kind];
      if (kind === 'rail') { lg.lineCap = 'butt'; line(C.rail, 5); line('#fff', 2, [4, 4]); }
      else if (kind === 'bridge') { lg.lineCap = 'butt'; line(C.bridgeCasing, 9); line(ROAD_STYLE.primary.fill, 5); }
      else if (kind === 'park') box(C.park);
      else if (kind === 'beach') box(C.beach);
      else if (kind === 'building') box(C.building, C.buildingEdge);
      else if (kind === 'landmark') box(C.landmark, C.landmarkEdge);
      else if (st && st.dash) line(st.dash, 2.2, [3, 2]);
      else if (st) { line(st.casing, kind === 'residential' ? 5 : 7); line(st.fill, kind === 'residential' ? 3 : 5); }
      h('span', null, row).textContent = label;
    }
  }

  // ---- GPS route ----
  let gpsRef = null, routeFn = null; // set by the quest system once the mini-games (and their GPS) are loaded

  // ---- waypoint ----
  let marker = null, markerT = 0;
  const wpListeners = [];
  function setWaypoint(x, z, label = '') {
    waypoint = { x, z, label: label || tr('map.waypoint') };
    wpListeners.forEach((fn) => fn(waypoint));
    if (marker) { marker.visible = true; marker.position.set(x, groundAt(x, z), z); }
  }
  function clearWaypoint() {
    if (!waypoint) return;
    waypoint = null;
    wpListeners.forEach((fn) => fn(null));
    if (marker) marker.visible = false;
  }
  const groundAt = (x, z) => (typeof city.heightAt === 'function' ? city.heightAt(x, z, 0) || 0 : 0);

  if (scene) {
    import('three').then((THREE) => {
      const group = new THREE.Group();
      group.name = 'waypoint-marker';
      const mat = new THREE.MeshBasicMaterial({ color: 0x2ec4b6, transparent: true, opacity: 0.35, depthWrite: false });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 90, 16, 1, true), mat);
      beam.position.y = 45;
      const ring = new THREE.Mesh(new THREE.RingGeometry(3.5, 5, 32), new THREE.MeshBasicMaterial({ color: 0x2ec4b6, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.4;
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(2.6), new THREE.MeshBasicMaterial({ color: 0x7fe0d6 }));
      gem.position.y = 14;
      group.add(beam, ring, gem);
      group.userData = { gem, ring };
      group.visible = !!waypoint;
      if (waypoint) group.position.set(waypoint.x, groundAt(waypoint.x, waypoint.z), waypoint.z);
      scene.add(group);
      marker = group;
    }).catch((e) => console.warn('[bigmap] world waypoint marker unavailable', e));
  }

  // ---- minimap hook ----
  function attachTo(el) {
    if (!el || el === minimap) return;
    minimap = el;
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.title = tr('map.open');
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    mmCanvas = document.createElement('canvas');
    mmCanvas.className = 'bigmap-minimap-overlay';
    Object.assign(mmCanvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    el.appendChild(mmCanvas);
  }

  // Draws the waypoint on the HUD minimap, which is north-up, centred on the player, minimapScale px/unit.
  function drawMinimap(player) {
    if (!mmCanvas) return;
    const key = waypoint && player ? `${Math.round(player.x * 2)}|${Math.round(player.z * 2)}|${waypoint.x}|${waypoint.z}` : '';
    if (key === mmKey) return;
    mmKey = key;
    const w = minimap.clientWidth, hh = minimap.clientHeight, r = Math.min(window.devicePixelRatio || 1, 2);
    if (mmCanvas.width !== Math.round(w * r) || mmCanvas.height !== Math.round(hh * r)) { mmCanvas.width = Math.round(w * r); mmCanvas.height = Math.round(hh * r); }
    const mg = mmCanvas.getContext('2d');
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, mmCanvas.width, mmCanvas.height);
    if (!key) return;
    mg.setTransform(r, 0, 0, r, 0, 0);
    const x = w / 2 + (waypoint.x - player.x) * minimapScale, y = hh / 2 + (waypoint.z - player.z) * minimapScale;
    mg.lineWidth = 2; mg.strokeStyle = C.ink; mg.fillStyle = C.waypoint;
    const pad = 20; // clears the minimap's 16 px rounded corners
    if (x > pad && y > pad && x < w - pad && y < hh - pad) {
      mg.beginPath(); mg.arc(x, y, 6, 0, Math.PI * 2); mg.fill(); mg.stroke();
      mg.fillStyle = '#fffaf0'; mg.beginPath(); mg.arc(x, y, 2.2, 0, Math.PI * 2); mg.fill();
      return;
    }
    const ang = Math.atan2(y - hh / 2, x - w / 2);
    const k = Math.min((w / 2 - pad) / Math.max(1e-6, Math.abs(Math.cos(ang))), (hh / 2 - pad) / Math.max(1e-6, Math.abs(Math.sin(ang))));
    mg.save(); mg.translate(w / 2 + Math.cos(ang) * k, hh / 2 + Math.sin(ang) * k); mg.rotate(ang);
    mg.beginPath(); mg.moveTo(9, 0); mg.lineTo(-6, 7); mg.lineTo(-2, 0); mg.lineTo(-6, -7); mg.closePath(); mg.fill(); mg.stroke();
    mg.restore();
  }

  // ---- public API ----
  function open() {
    if (isOpenFlag) return;
    ensureIndexed();
    isOpenFlag = true;
    root.classList.add('on');
    resize();
    const p = getPlayer();
    if (p) { view.cx = goal.cx = p.x; view.cz = goal.cz = p.z; }
    else if (bounds) { view.cx = goal.cx = (bounds.minX + bounds.maxX) / 2; view.cz = goal.cz = (bounds.minZ + bounds.maxZ) / 2; }
    // A quest hint frames its own area instead of the player.
    if (overlay && overlay.focus) { view.cx = goal.cx = overlay.focus.x; view.cz = goal.cz = overlay.focus.z; if (overlay.focus.s) view.s = goal.s = clamp(overlay.focus.s, MIN_S, MAX_S); }
    anchor = null; vel.x = vel.z = 0; heldKeys.clear();
    hover = null; tip.style.display = 'none';
    updateCoords();
    lastT = 0;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function close() {
    if (!isOpenFlag) return;
    isOpenFlag = false;
    root.classList.remove('on');
    heldKeys.clear();
    pointers.clear(); drag = null; pinch = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function update(dt = 0) {
    const p = getPlayer();
    if (waypoint && p && Math.hypot(waypoint.x - p.x, waypoint.z - p.z) < 10) {
      const reached = waypoint;
      clearWaypoint();
      if (onWaypointReached) onWaypointReached(reached);
    }
    if (marker && marker.visible) {
      markerT += dt;
      marker.userData.gem.position.y = 14 + Math.sin(markerT * 2.4) * 1.5;
      marker.userData.gem.rotation.y += dt * 1.8;
      const k = 1 + (markerT * 0.8 % 1) * 0.6;
      marker.userData.ring.scale.set(k, k, k);
    }
    drawMinimap(p);
  }

  const auto = document.getElementById('hud-map');
  if (auto) attachTo(auto);
  applyStrings();
  i18nReady.then(() => { if (tImpl) applyStrings(); });

  const api = {
    open, close, toggle: () => (isOpenFlag ? close() : open()), update, attachTo,
    getWaypoint: () => (waypoint ? { x: waypoint.x, z: waypoint.z, label: waypoint.label } : null),
    setWaypoint, clearWaypoint,
    onWaypointChange: (fn) => { wpListeners.push(fn); },
    setOverlay,
    // Frame the map on a point (a quest hint), whether or not it is open.
    focus: (x, z, s) => { goal.cx = x; goal.cz = z; if (s) goal.s = clamp(s, MIN_S, MAX_S); anchor = null; vel.x = vel.z = 0; dirty = true; },
    setGps: (gps, fn = null) => { gpsRef = gps || null; routeFn = fn; },
    // Debug/verification hooks (preview page, console).
    setView: (cx, cz, s) => { view.cx = goal.cx = cx; view.cz = goal.cz = cz; if (s) view.s = goal.s = clamp(s, MIN_S, MAX_S); anchor = null; vel.x = vel.z = 0; },
    getView: () => ({ ...view }),
    // Renders one tile and forces rasterisation; returns ms. Verification only.
    debugTileMs: (t, i, j) => { const t0 = performance.now(); const c = renderTile(t, i, j); c.getContext('2d').getImageData(0, 0, 1, 1); return performance.now() - t0; },
    debugSkip: (list) => { dbgSkip.clear(); list.forEach((k) => dbgSkip.add(k)); },
    resetPerf: () => { perf.tileMax = perf.frameMax = 0; perf.tilesRendered = perf.frames = 0; },
    stats: () => ({ ...perf, tiles: tiles.size, bridges: roadItems.filter((i) => i.bridge).length, dataReady, places: places.length, pois: pois.length, named: idx.named.length }),
    destroy: () => { close(); window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('keyup', onKeyUp, true); root.remove(); if (mmCanvas) mmCanvas.remove(); if (marker) marker.removeFromParent(); },
  };
  Object.defineProperty(api, 'isOpen', { get: () => isOpenFlag, enumerable: true });
  return api;
}
