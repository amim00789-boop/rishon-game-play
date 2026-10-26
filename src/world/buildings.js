// Neighbourhood-aware building generator for Rishon LeZion.
//
// buildBuildings(scene, data, { exclude, project }) -> { colliders, group }
//
// Every footprint in data/rishon.json is assigned a neighbourhood profile (nearest OSM
// suburb/neighbourhood node, overridden by hand-drawn zones for the old moshava centre and
// the industrial parks), then an archetype from its footprint shape and OSM height:
// shikun slab, 1990s mid-rise, 1990s tower, new glass tower, villa, old stone house,
// commercial, office, industrial, public. Each archetype picks a roof (flat with solar
// heaters, pyramid, hipped tile, setback penthouse, crown), a wall/accent palette, a
// window style and a storey height.
//
// Sources and confidence for each look are in the PROFILES comments below. "VERIFIED"
// means a cited page supports the claim; "INFERRED" means a reasoned guess from the OSM
// footprint pattern or general knowledge of Israeli housing of that era.
//
// Draw calls: per chunk one wall mesh (single atlas material), one roof mesh and two
// instanced meshes (solar heaters, balconies), the same budget city.js used.

import * as THREE from 'three';
import { SCALE, project as geoProject } from '../geo.js';

// Terrain is optional: without it everything stands on y = 0 (ROUND2 terrain contract).
let groundAt = () => 0;
try {
  const t = await import('./terrain.js');
  if (typeof t.groundAt === 'function') groundAt = t.groundAt;
} catch { /* no terrain module yet */ }

// OSM extras (ROUND3 shared data, written by the parking agent): building tags, shop nodes and
// industrial landuse polygons. Optional; everything falls back to heuristics without it.
let EXTRAS = null;
// Researched storey counts per footprint (round 3 height pass): data/building_heights.json.
let HEIGHTS = null;
try {
  const res = await fetch(new URL('../../data/building_heights.json', import.meta.url));
  if (res.ok) HEIGHTS = await res.json();
} catch { /* no heights table */ }
try {
  const res = await fetch(new URL('../../data/rishon.extras.json', import.meta.url));
  if (res.ok) EXTRAS = await res.json();
} catch { /* no extras file yet */ }

// Storeys are drawn slightly taller than true scale so floors read next to ~5-unit avatars.
// At SCALE 1.2 a 3 m storey becomes ~4.1 units, matching the old FLOOR_H of 4.
const VEX = 1.15;
// Chunk edge in metres. 1600 m equals city.js's CHUNK (400 at 0.25 u/m), so draw calls stay level.
const CHUNK_M = 1600;
const NEAREST_MAX_M = 1300;
// Largest untagged footprint (m2) the heuristic may turn into one point tower. Bigger compact
// footprints in Rishon are podium projects, malls or slab blocks (round 3 height pass).
const TOWER_MAX_M2 = 1600;
// Heaters and balconies are sub-pixel beyond this distance (metres from the chunk's box), so
// their instanced meshes are hidden there; it roughly halves the triangles of a wide view.
const PROP_RANGE_M = 750;

// ---------- neighbourhood profiles ----------

// Centres from OSM place=suburb/neighbourhood nodes (data/rishon.places.raw.json, fetched
// 2026-10-14). Embedded so the assignment works even if data.places is trimmed.
const NEIGHBOURHOODS = [
  // West Rishon, built from the late 1980s on.
  { id: 'neot-ashlim', name: 'Neot Ashlim', lat: 31.9658937, lon: 34.7737439, profile: 'ashlim' },
  { id: 'kiryat-ganim', name: 'Kiryat Ganim', lat: 31.9653001, lon: 34.778535, profile: 'ganim' },
  { id: 'pras-nobel', name: 'Kiryat Hatanei Pras Nobel', lat: 31.9702533, lon: 34.7657523, profile: 'nobel' },
  { id: 'kiryat-rishon', name: 'Kiryat Rishon', lat: 31.9728441, lon: 34.7844774, profile: 'westTowers' },
  { id: 'kiryat-haleom', name: 'Kiryat HaLeom', lat: 31.9705, lon: 34.7800, profile: 'westTowers' },
  { id: 'kiryat-kramim', name: 'Kiryat Kramim', lat: 31.9741453, lon: 34.7790746, profile: 'westTowers' },
  { id: 'neot-shikma', name: 'Neot Shikma', lat: 31.9774554, lon: 34.7719584, profile: 'cottage' },
  { id: 'neve-dekalim', name: 'Neve Dekalim', lat: 31.9817745, lon: 34.7620013, profile: 'cottage' },
  { id: 'shaar-hayam', name: 'Shaar HaYam', lat: 31.9991624, lon: 34.7368976, profile: 'beachNew' },
  { id: 'neve-hof', name: 'Neve Hof', lat: 31.9962892, lon: 34.7415574, profile: 'beachNew' },
  // East and centre: the 1950s-70s housing estates and the old moshava.
  // Neve Yam is a late-1980s/1990s neighbourhood of private houses, not a shikun (round 5): see the
  // `neveYam` profile and the neve-yam zone.
  { id: 'neve-yam', name: 'Neve Yam', lat: 31.9857896, lon: 34.7798344, profile: 'neveYam' },
  { id: 'ramat-eliyahu', name: 'Ramat Eliyahu', lat: 31.9823499, lon: 34.7898073, profile: 'shikun' },
  // East (round 5). Profiles from OSM footprint statistics per place node (sizes, building:levels,
  // building=* tags; data/rishon.raw.json, 2026-10-16) plus Mapillary where it exists; see SOURCES.
  { id: 'nahalat-yehuda', name: 'Nahalat Yehuda', lat: 31.985887, lon: 34.8062396, profile: 'eastVillas' },
  { id: 'bnot-hayil', name: 'Bnot Hayil', lat: 31.9730073, lon: 34.7940869, profile: 'eastVillas' },
  { id: 'katznelson', name: 'Katznelson', lat: 31.9681499, lon: 34.7946347, profile: 'katznelson' },
  { id: 'abramovich', name: 'Abramovich', lat: 31.9688346, lon: 34.8014293, profile: 'remez' },
  { id: 'remez', name: 'Remez', lat: 31.9604736, lon: 34.79543, profile: 'remez' },
  { id: 'neve-hilel', name: 'Neve Hilel', lat: 31.9596939, lon: 34.7899692, profile: 'eastVillas' },
  { id: 'rishonim', name: 'Rishonim', lat: 31.9536035, lon: 34.804057, profile: 'shikun' },
  { id: 'hairisim', name: 'HaIrisim', lat: 31.9509646, lon: 34.8045784, profile: 'westTowers' },
  { id: 'kiryat-simha', name: 'Kiryat Simha', lat: 31.9496603, lon: 34.8074195, profile: 'shikun' },
  // Before round 5 these fell back to the 'generic' walk-up profile (OSM place nodes, 2026-10-14).
  { id: 'hashomer', name: 'HaShomer', lat: 31.9600704, lon: 34.8113597, profile: 'katznelson' },
  { id: 'rambam', name: 'Rambam', lat: 31.9652442, lon: 34.810735, profile: 'remez' },
  { id: 'gordon', name: 'Gordon', lat: 31.9517728, lon: 34.8164472, profile: 'eastVillas' },
  { id: 'shikuney-hamizrah', name: 'Shikuney HaMizrah', lat: 31.9531076, lon: 34.8268653, profile: 'eastLow' },
  { id: 'tzamarot', name: 'Tzamarot', lat: 31.95732, lon: 34.8246574, profile: 'eastVillas' },
  { id: 'neve-hadarim', name: 'Neve Hadarim', lat: 31.9588797, lon: 34.8168725, profile: 'eastNew' },
  { id: 'mishor-hanof', name: 'Mishor HaNof', lat: 31.9530103, lon: 34.8117754, profile: 'eastNew' },
  { id: 'kidmat-rishon', name: 'Kidmat Rishon', lat: 31.9706329, lon: 34.815564, profile: 'eastNew' },
  { id: 'marom-rishon', name: 'Marom Rishon', lat: 31.9691383, lon: 34.8234737, profile: 'eastNew' },
  { id: 'revivim', name: 'Revivim', lat: 31.9658961, lon: 34.8223424, profile: 'eastNew' },
  { id: 'nuriyot', name: 'Nuriyot', lat: 31.96548, lon: 34.8294461, profile: 'eastNew' },
  { id: 'narkisim', name: 'Narkisim', lat: 31.9593455, lon: 34.8306032, profile: 'eastNew' },
  { id: 'kalaniyot', name: 'Kalaniyot', lat: 31.9453795, lon: 34.8216468, profile: 'eastNew' },
  { id: 'kfar-arye', name: 'Kfar Arye', lat: 31.9455377, lon: 34.8274652, profile: 'eastNew' },
  { id: 'harakafot', name: 'HaRakafot', lat: 31.9479891, lon: 34.8297418, profile: 'eastNew' },
];

// Hand-drawn zones in lat/lon (rectangles or polygons) that override the nearest-centre rule.
// Read off a plot of the OSM footprints: large commercial/industrial footprints cluster here.
const ZONES = [
  // Old moshava core around Founders Square (Kikar HaMeyasdim, OSM way at 31.9643, 34.8072),
  // Rothschild St, the Great Synagogue and the Carmel winery.
  { id: 'old-centre', name: 'Old centre (Founders Square)', profile: 'oldCentre', view: [31.9640, 34.8040],
    poly: [[31.9672, 34.7985], [31.9672, 34.8105], [31.9598, 34.8105], [31.9598, 34.7985]] },
  // Neve Yam (round 5): Moshe Levi to the Ramat Eliyahu edge, David Saharov / HaTzfira down to the
  // Mivtza (operation-name) streets, including the gem streets (Topaz, Inbar, Shenhav, Granit,
  // Pninat HaYam, Ravid, Tarshish, Shoham, Leshem, Yahalom, Bareket) read off the OSM street layout.
  { id: 'neve-yam', name: 'Neve Yam', profile: 'neveYam', view: [31.9840, 34.7810],
    poly: [[31.9902, 34.7752], [31.9902, 34.7862], [31.9860, 34.7862], [31.9848, 34.7866], [31.9830, 34.7866],
      [31.9800, 34.7862], [31.9790, 34.7836], [31.9790, 34.7752]] },
  // Western industrial zone north of Sderot Moshe Dayan, between Route 4/20 and Ramat Eliyahu.
  { id: 'industrial-west', name: 'Western industrial zone', profile: 'industrial', view: [31.9890, 34.7680],
    poly: [[31.9965, 34.7575], [31.9950, 34.7770], [31.9895, 34.7790], [31.9845, 34.7770], [31.9840, 34.7585]] },
  // Industrial/commercial strip inland of Shaar HaYam, west of the highway.
  { id: 'industrial-north', name: 'North-west commercial zone', profile: 'industrial', view: [31.9925, 34.7520],
    poly: [[31.9975, 34.7465], [31.9975, 34.7580], [31.9880, 34.7580], [31.9880, 34.7465]] },
  // Gan Sorek industrial zone south of Neot Ashlim. OSM extent 31.9482-31.9571 N, 34.7560-34.7787 E
  // (Nominatim, checked 2026-10-14).
  { id: 'industrial-south', name: 'Gan Sorek industrial zone', profile: 'industrial', view: [31.9520, 34.7660],
    poly: [[31.9571, 34.7550], [31.9571, 34.7790], [31.9478, 34.7790], [31.9478, 34.7550]] },
  // Ramat Eliyahu industrial zone, OSM extent 31.9786-31.9895 N, 34.7906-34.7963 E (Nominatim, 2026-10-14).
  { id: 'industrial-eliyahu', name: 'Ramat Eliyahu industrial zone', profile: 'industrial', view: [31.9840, 34.7935],
    poly: [[31.9895, 34.7906], [31.9895, 34.7963], [31.9786, 34.7963], [31.9786, 34.7906]] },
  // Old industrial zone (Neurim), OSM extent 31.9731-31.9853 N, 34.8071-34.8163 E (Nominatim, 2026-10-14).
  { id: 'industrial-east', name: 'Old industrial zone (Neurim)', profile: 'industrial', view: [31.9790, 34.8090],
    poly: [[31.9853, 34.8071], [31.9853, 34.8163], [31.9731, 34.8163], [31.9731, 34.8071]] },
];

// Per-building evidence, keyed by the OSM footprint centroid (lat/lon, matched within 12 m).
// `roof` overrides the heuristic roof; `floors` the storey count. Each row cites the photo
// that shows it; the matching footprint was found by projecting the camera position and
// heading onto the OSM footprints (checked 2026-10-15). Add founder notes here as
// { ..., src: 'founder <date>' } once he names streets.
const EVIDENCE = [
  // Neot Ashlim west edge, seen from the HaTof/HaPsanter boulevard: 8-9 storeys with the roof
  // room, flat roof, teal-glass roof room and stair core. NO pyramid.
  { lat: 31.96624, lon: 34.77211, osm: 373091850, label: 'HaPsanter 3', roof: 'penthouse', src: 'Mapillary 769716300409432 (2021-02-14)' },
  { lat: 31.96653, lon: 34.77202, osm: 373091852, label: 'HaPsanter 5', roof: 'penthouse', src: 'Mapillary 769716300409432 (2021-02-14)' },
  { lat: 31.96682, lon: 34.77196, osm: 373091851, label: 'HaPsanter 7', roof: 'penthouse', src: 'Mapillary 769716300409432, 5751417088231907 (2021-02-14)' },
  { lat: 31.96375, lon: 34.76950, osm: 372789089, label: 'HaTof 7', roof: 'penthouse', src: 'Mapillary 376108830412327 (2021-02-14)' },
  { lat: 31.96402, lon: 34.76969, osm: 372789088, label: 'HaTof 9', roof: 'penthouse', src: 'Mapillary 376108830412327, 507130250703871 (2021-02-14)' },
  // The ONLY light-blue pyramid roofs in Neot Ashlim (founder, 2026-10-15). Footprints by OSM
  // addr:street=HaTizmoret + addr:housenumber in data/rishon.raw.json.
  { lat: 31.96442, lon: 34.77351, osm: 332389678, label: 'HaTizmoret 40', roof: 'pyramid', src: 'founder 2026-10-15' },
  { lat: 31.96472, lon: 34.77399, osm: 332389679, label: 'HaTizmoret 38', roof: 'pyramid', src: 'founder 2026-10-15 ("36-38")' },
  { lat: 31.96526, lon: 34.77402, osm: 332389680, label: 'HaTizmoret 36', roof: 'pyramid', src: 'founder 2026-10-15 ("36-38")' },
  { lat: 31.96560, lon: 34.77453, osm: 332389681, label: 'HaTizmoret 34', roof: 'pyramid', src: 'founder 2026-10-15' },
  { lat: 31.96613, lon: 34.77455, osm: 332389682, label: 'HaTizmoret 32', roof: 'pyramid', maybe: true, src: 'founder: maybe, 2026-10-15' },
];

// Pedestrian nightlife zones where industrial yard fences and loading docks must not stand: HaRova
// (Moshe Becker square, OSM highway=pedestrian area way 377731453, and the Moshe Becker / Barshavski
// walk; same coordinates as HAROVA_SQUARE / HAROVA_STREET in landmarks.js). No OSM barrier or wall is
// mapped within 150 m (data/rishon.details.raw.json, 559 barriers city-wide, checked 2026-10-16).
// `pad` is metres around the polygon / along the polyline.
const NO_YARD = [
  { id: 'harova-square', pad: 18, poly: [[31.975254, 34.809175], [31.974944, 34.80907], [31.974963, 34.808988], [31.974816, 34.80894], [31.974822, 34.808915], [31.974873, 34.808702], [31.975068, 34.808767], [31.975115, 34.808573], [31.975371, 34.80866]] },
  { id: 'harova-walk', pad: 16, line: [[31.973783, 34.808364], [31.973905, 34.808473], [31.974148, 34.808675], [31.974476, 34.808869], [31.974788, 34.808991], [31.974893, 34.809045], [31.974915, 34.809123], [31.974899, 34.809214], [31.974907, 34.809356], [31.974925, 34.809409], [31.975181, 34.809486], [31.975509, 34.809585]] },
];

// Footbridges whose deck runs into a building (urban architect's walk test, commit f118804; indices
// into city.footbridges). The footprint gets an entrance recess cut from the wall the deck crosses
// (or the wall nearest the deck when the deck lies wholly inside), deep and wide enough for the deck,
// so the collider has a real gap, plus a glazed door and canopy at deck level. `line` is the OSM
// bridge way; `deckU` is the deck height above the building's seat in world units, measured in the
// game on 2026-10-17 (city.footbridges[i].surface minus the lowest terrain under the footprint),
// because city.js does not pass its heightAt to this module.
//  - #53 OSM 958581093 (bridge=yes footway, layer 1) enters the mall OSM 802170565 (shop=mall,
//    Yaldei Tehran St) at its ground floor on the uphill side.
//  - #71 OSM 1333317140 (bridge=yes footway, layer 1) lies inside school OSM 1333263537 (layer 1),
//    in the neck between its two wings, 13.8 u above the seat: cut as a slot along the deck.
const PASSAGES = [
  { id: 'fb53-mall', line: [[31.9850991, 34.7679876], [31.9851464, 34.7680324]], halfW: 2.1, deckU: 0.71 },
  { id: 'fb71-school', line: [[31.9424931, 34.8257406], [31.942526, 34.8257384]], halfW: 2.1, deckU: 13.82 },
];

// OSM landuse polygon name -> industrial profile (data/rishon.extras.json `industrial`).
const INDUSTRIAL_NAMES = [
  [/new industrial/i, 'indWest'],
  [/gan sorek/i, 'indSouth'],
  [/old industrial/i, 'indOld'],
];

// Profile -> how footprints become archetypes. Floors are [min, max]; "p" values are probabilities.
// See SOURCES at the bottom of the file for what is verified.
const PROFILES = {
  // Neot Ashlim: 1990s point towers on 22-27 m square footprints. Street-level photos of the
  // HaTof / HaKinor / HaPsanter edge show 8-9 storeys including the roof room, so the towers are
  // about as tall as they are wide: chunky, not slender (Mapillary 769716300409432,
  // 5751417088231907, 2021-02-14); a HaTizmoret listing has its penthouse on floor 7 (yad2,
  // checked 2026-10-15); HaTizmoret 36 has 12 floors (walla, see SOURCES) -> a few taller ones.
  // Roofs: flat terrace with a teal-glazed roof room (same photos). Pyramids only where the
  // EVIDENCE table (founder: HaTizmoret 32-40) or an OSM roof:shape tag says so.
  ashlim: { towerFloors: [7, 9], tallShare: 0.12, tallFloors: [11, 12], slabFloors: [5, 7], villaMax: 170,
    towerRoof: { penthouse: 1 }, chunky: true, pyramidColour: 0x9fd3ea,
    palette: 'ashlim', accents: [0x5fb3b3, 0x4f9fb0, 0x6aa9c9], awnings: true },
  // Kiryat Ganim: founder: long 3-4 storey blocks on pilotis, shutters, laundry.
  // Round 4: listings (ad.co.il archive, 685 ads) give 4-5 storey walk-ups with ground-floor flats
  // on most streets (so fewer on pilotis), roof add-on flats on 22 addresses and cottages on a few
  // streets; `variety` adds stair cores, enclosed balconies, roof rooms, tiles and garden walls.
  ganim: { shikun: true, pilotis: 0.35, variety: true, slabFloors: [3, 4], towerFloors: [8, 12], villaMax: 120, palette: 'ganim' },
  // Pras Nobel: towers ringing the central park (OSM 12-16 storeys; ad.co.il listings mostly
  // 13), semi-detached cottages around them. Storey ranges below are the round-3 defaults for
  // footprints with no OSM tag and no row in data/building_heights.json.
  nobel: { towerFloors: [12, 15], slabFloors: [5, 8], villaMax: 230, towerRoof: { crown: 0.6, setback: 0.4 }, palette: 'tower90' },
  // Kiryat Rishon / HaLeom / Kramim: white 15-24 storey towers with frame crowns and dark glass
  // balcony rails (Mapillary 1106177046574094, 2021); Upper West = two 19-storey granite towers.
  // Untagged footprints here measured 5-10 storeys (Mapillary/listings, round 3); the real
  // 16-30 storey towers all carry OSM levels, so the default is conservative.
  westTowers: { towerFloors: [7, 10], slabFloors: [5, 8], towerMin: 420, villaMax: 170, towerRoof: { setback: 0.35, crown: 0.65 }, palette: 'white', darkRails: true },
  // Neve Dekalim / Neot Shikma: dense grids of small footprints -> cottages, a few walk-ups.
  // Round 3: Neot Shikma's central project is 9-13 storeys, its east part 3-5; Neve Dekalim is villas.
  cottage: { towerFloors: [8, 11], slabFloors: [3, 6], villaMax: 280, palette: 'tower90' },
  // Beachfront: the real towers carry OSM levels (22-38). Untagged Neve Hof / Shaar HaYam
  // footprints are 2-storey cottage grids and 6-8 storey blocks (round 3, Mapillary 975627843245209,
  // 580733026238493), so untagged defaults stay low and cottages reach 430 m2.
  beachNew: { towerFloors: [7, 9], slabFloors: [5, 8], villaMax: 430, glass: true, towerMin: 450, towerRoof: { crown: 1 }, palette: 'glass' },
  shikun: { shikun: true, pilotis: 0.35, slabFloors: [3, 4], towerFloors: [7, 10], villaMax: 110, palette: 'shikun' },
  // Katznelson / Remez: private houses with clay-tile roofs and kurkar garden walls between the
  // walk-ups (Mapillary 114474104910136, Katznelson, 2023).
  mixedEast: { shikun: true, pilotis: 0.3, slabFloors: [3, 4], towerFloors: [7, 10], villaMax: 260, tile: 0.65, palette: 'shikun' },
  // Round 5 photos show 4-6 storey 1970s-90s blocks on the residential streets round Rothschild
  // (Mapillary 113223590828438, 225505345610605 2019-06; 168198489334036 2023-02-28), but the founder
  // found the centre over-tall and cramped (round 6): unsourced blocks are 2-4 storeys again; the
  // tall ones carry OSM levels or a heights-table row.
  oldCentre: { old: true, slabFloors: [2, 4], towerFloors: [6, 9], villaMax: 230, palette: 'shikun', yardWalls: 0.7 },
  // ---- Round 5: Neve Yam and the east (sources in SOURCES, "Round 5") ----
  // `villaKit` shapes private houses: tile = tiled roof share (hip on simple footprints, a tiled
  // skirt round a flat roof elsewhere), modern = white flat-roofed cube share, stone/brick = cladding
  // shares, floors3/floors1 = share of 3- or 1-storey houses, yard = garden-wall share. `blocks`
  // = untagged big footprints become 1990s apartment blocks, never heuristic towers.
  // Neve Yam: 2-storey houses with red tile roofs, stone-clad or white, high garden walls, two-
  // and four-unit cottages on the gem cul-de-sacs; apartment blocks on the Mivtza streets
  // (Mapillary 3973510192736240, 1630021603853741, 135317705318681, 2021-04-04; bizportal 2025).
  neveYam: { villaMax: 420, blocks: true, slabFloors: [4, 7], towerFloors: [8, 11], palette: 'tower90',
    villaKit: { pal: 'nyVilla', tile: 0.8, modern: 0.12, stone: 0.3, brick: 0, floors3: 0.12, yard: 0.9 } },
  // Remez / Abramovich / Rambam: 1960s-70s four-storey walk-ups in ochre and sand plaster with solid
  // plaster balcony parapets, closed-in balconies and AC units, 8-9 storey grey 1990s blocks between,
  // tree-lined streets, shops under the blocks on the main streets (Mapillary 1144609733365870,
  // 1089845375564946, 702918805144216 2024-03-16; 138386475811360 2023-02-28). OSM levels median 4.
  remez: { shikun: true, pilotis: 0.12, variety: true, walkTile: 0.03, solidRails: true, slabFloors: [4, 4],
    towerFloors: [8, 10], villaMax: 140, palette: 'remez', midPalette: 'remezMid' },
  // Katznelson / HaShomer: private houses on plots, 2 storeys with red tile hip roofs, some red brick,
  // white modern cubes replacing them, tall plastered or stone garden walls with grey slat gates;
  // walk-ups on the bigger plots (Mapillary 1533664107158095, 1207114670170707, 520401690241645,
  // 193679213309467, 2023-02-28; 114474104910136, 2023). OSM levels median 2.
  katznelson: { shikun: true, pilotis: 0.15, variety: true, walkTile: 0.1, slabFloors: [3, 4], towerFloors: [7, 9],
    villaMax: 330, palette: 'remez', midPalette: 'remezMid',
    villaKit: { pal: 'katzVilla', tile: 0.6, modern: 0.3, stone: 0.15, brick: 0.12, floors3: 0.1, yard: 0.95 } },
  // Nahalat Yehuda, Bnot Hayil, Neve Hilel, Gordon, Tzamarot: OSM footprints mostly under 300 m2 with
  // levels median 1-2 -> private houses with a few walk-ups (INFERRED from the statistics).
  eastVillas: { shikun: true, pilotis: 0.15, variety: true, walkTile: 0.1, slabFloors: [3, 4], towerFloors: [7, 9],
    villaMax: 300, palette: 'remez', midPalette: 'remezMid',
    villaKit: { pal: 'katzVilla', tile: 0.55, modern: 0.22, stone: 0.15, brick: 0.05, floors3: 0.08, yard: 0.9 } },
  // Shikuney HaMizrah: 1950s single-storey immigrant houses, most since raised by a storey; footprints
  // 50-300 m2, OSM levels 2 (INFERRED).
  eastLow: { shikun: true, pilotis: 0, variety: true, walkTile: 0.1, slabFloors: [2, 3], towerFloors: [6, 8],
    villaMax: 320, palette: 'remez', midPalette: 'remezMid',
    villaKit: { pal: 'katzVilla', tile: 0.45, modern: 0.15, stone: 0.05, brick: 0.03, floors1: 0.4, yard: 0.9 } },
  // Far east (Neve Hadarim, Revivim, Kalaniyot, Kfar Arye, HaRakafot ...): 1990s-2010s cottages and
  // apartment blocks; the towers there carry OSM levels (medians 15-26), so untagged = blocks.
  eastNew: { villaMax: 300, blocks: true, slabFloors: [4, 7], towerFloors: [8, 12], palette: 'tower90',
    villaKit: { pal: 'nyVilla', tile: 0.6, modern: 0.3, stone: 0.2, brick: 0, floors3: 0.1, yard: 0.85 } },
  industrial: { industrial: true, slabFloors: [2, 3], towerFloors: [5, 10], villaMax: 0, palette: 'industrial' },
  // Industrial zones by OSM landuse polygon (data/rishon.extras.json `industrial`). `style` picks
  // the building mix; see industrialArch() and SOURCES.
  // New (west) industrial area: glass-fronted 3-6 storey office/showroom blocks and big-box retail.
  indWest: { industrial: true, style: 'west', slabFloors: [2, 3], towerFloors: [5, 10], villaMax: 0, palette: 'industrial' },
  // Old industrial zone (east): low plastered commercial with shops on the main roads, sheds behind.
  indOld: { industrial: true, style: 'old', slabFloors: [2, 3], towerFloors: [5, 10], villaMax: 0, palette: 'industrial' },
  // Gan Sorek: logistics boxes and new glass hi-tech offices.
  indSouth: { industrial: true, style: 'south', slabFloors: [2, 3], towerFloors: [5, 10], villaMax: 0, palette: 'industrial' },
  // Small commercial/retail landuse patches: treated like the west zone's showrooms and boxes.
  indRetail: { industrial: true, style: 'west', slabFloors: [2, 3], towerFloors: [5, 10], villaMax: 0, palette: 'industrial' },
  generic: { shikun: true, pilotis: 0.2, slabFloors: [3, 5], towerFloors: [8, 12], villaMax: 130, palette: 'shikun' },
};

// ---------- palettes ----------

const PAL = {
  // Faded plaster of 1950s-70s housing estates: cream, sand, pale grey, washed pink/blue.
  shikun: [0xeee6d3, 0xe6dfcf, 0xdcd8cf, 0xece0bb, 0xe9d6c9, 0xd8e0e2, 0xf1ead9, 0xd2cec4],
  shikunWest: [0xf3eee2, 0xefe4cf, 0xe3e3dd, 0xf2e6c8, 0xe9dccf],
  // Kiryat Ganim: plaster in white, cream, sand, peach, pale yellow and light grey, with stone-clad
  // or painted stair cores (INFERRED: no photos inside the neighbourhood).
  ganim: [0xf6f3ea, 0xefe4cf, 0xe9d7b5, 0xf0d6bf, 0xf1e5b3, 0xdedcd6, 0xe8dccb, 0xf3eee2],
  ganimCore: [0xd9c9a3, 0xc9b48c, 0x9fb7c4, 0xd8b39a, 0xbfc5c8, 0xe6e0d2],
  enclosure: [0xf4f4f0, 0xe7e2d6, 0xd5d9da, 0xe2d3b4, 0xcfd6d2],
  // 1990s: white/cream plaster, stone-clad bases.
  tower90: [0xf6f2e9, 0xf1e7d4, 0xffffff, 0xece4d6, 0xf4ecdc],
  tower90Accent: [0x7fb8d8, 0xd38b5d, 0x6fb7b0, 0x8fa6b8, 0xc9a46a],
  // Neot Ashlim: cream/beige plaster, teal-blue cladding at the pilotis (Commons Rischon025/026, 2010).
  ashlim: [0xf1e6cf, 0xeee0c4, 0xf4ebd8, 0xe9dcc2],
  white: [0xffffff, 0xf7f6f2, 0xf2efe8, 0xe9e7e2],
  whiteAccent: [0x5a626c, 0x8b939b, 0xcfc6b4, 0x3d6f8f],
  // New towers: light frames around glass, saturated accent panels.
  glass: [0xf4f4f2, 0xdfe3e6, 0xcfd5da, 0xe9e6df, 0x5a626c],
  // Mostly greys and stone; a minority of saturated panels, as on Rishon's 2010s towers.
  glassAccent: [0x5a626c, 0x8b939b, 0xcfc6b4, 0x3d6f8f, 0xe8763a, 0x2f9fb5, 0xd8423a],
  stone: [0xeadcbc, 0xe2d0a8, 0xf0e5cc, 0xe8d6b4, 0xf3ead2],
  villa: [0xffffff, 0xfbf7ef, 0xf4ece0, 0xf6efe0, 0xefe5d5, 0xf3e6d8],
  commercial: [0xe7eef0, 0xf0e6d6, 0xd2e3ec, 0xf2f2ee, 0xe3d9c9],
  industrial: [0xd9d5cc, 0xcfd3d6, 0xbfc8cf, 0xe0d8c8, 0x9fb3c4, 0xd6dde0, 0xc4b9a8],
  public: [0xf2cf8f, 0xeeb98a, 0xf3e0a8, 0xe6c49c, 0xcfe3b0, 0xa9d3e0],
  // Remez walk-ups: ochre and sand plaster first, then cream and the greys of later re-plastering
  // (Mapillary 1144609733365870, 1089845375564946).
  remez: [0xe0c08a, 0xd8b47a, 0xe6cc9a, 0xebd8ae, 0xeee3c8, 0xd9d5cc, 0xe3cf9f, 0xd2b98e],
  remezCore: [0xcfc8b8, 0xbdb6a6, 0xd8d0bd, 0xc4c8c9, 0xe2dccb],
  remezMid: [0xd6d8d8, 0xc8ccce, 0xe4e4e0, 0xdcd6ca, 0xeeeeea],
  // Private houses: white and cream plaster, beige stone cladding, red brick (Katznelson photos).
  katzVilla: [0xf8f6f0, 0xf2ebdc, 0xefe6d2, 0xfbfaf6, 0xe9e4da],
  nyVilla: [0xfaf8f2, 0xf3ecdd, 0xf1e5cf, 0xf6efe6, 0xece6da],
  villaStone: [0xe2d1ac, 0xd8c39a, 0xe8dbbd, 0xd3bd92],
  villaBrick: [0xb4613f, 0xa95a3c, 0xbf6f4a],
  yardWall: [0xf4f1ea, 0xe8e2d4, 0xd9c9a3, 0xcdbb94, 0xbfc3c4, 0xe1d7c2],
};
const ROOF_FLAT = [0xd9d3c7, 0xcfcac0, 0xe6e2da, 0xc8c4bb];
const ROOF_TILE = [0xc9694b, 0xb85a3e, 0xd27a55, 0xbf6446];
const ROOF_METAL = [0xc3c9cc, 0xb3bcc2, 0xd0d4d6];
const HAZE = new THREE.Color(0xdcd6c8);

// ---------- window atlas ----------

const TILE = 128, COLS = 4;
const ROW = {
  plain: 0, shikun: 1, mid: 2, tower: 3, glass: 4, old: 5, villa: 6, office: 7, industrial: 8, school: 9,
  gShop: 10, gPilotis: 11, gLobby: 12, gOldDoor: 13, gIndDoor: 14, gVillaDoor: 15, gShowroom: 16, panel: 17,
};
const ROWS = 18;
// Ground-floor modes stored per vertex; the shader swaps floor 0 to row 9 + mode, so
// mode k must live in atlas row gShop - 1 + k (showroom = 7 -> row 16).
const GROUND = { none: 0, shop: 1, pilotis: 2, lobby: 3, oldDoor: 4, indDoor: 5, villaDoor: 6, showroom: 7 };

function buildAtlas() {
  const W = TILE * COLS, H = TILE * ROWS;
  const cc = document.createElement('canvas'), mc = document.createElement('canvas');
  cc.width = mc.width = W; cc.height = mc.height = H;
  const c = cc.getContext('2d'), m = mc.getContext('2d');
  let ox = 0, oy = 0;
  // wall(): pixels tinted by the building's wall colour (mask white), shade 1 = full colour.
  // fix(): fixed colour pixels (glass, shutters, signs), not tinted.
  const P = {
    wall(x, y, w, h, shade = 1) {
      const v = Math.round(255 * shade);
      c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(ox + x, oy + y, w, h);
      m.fillStyle = '#fff'; m.fillRect(ox + x, oy + y, w, h);
    },
    fix(x, y, w, h, css) {
      c.fillStyle = css; c.fillRect(ox + x, oy + y, w, h);
      m.fillStyle = '#000'; m.fillRect(ox + x, oy + y, w, h);
    },
    glass(x, y, w, h, dark = '#4f7392', light = '#86aecb') {
      P.fix(x, y, w, h, dark);
      P.fix(x, y, w, Math.round(h * 0.42), light);
      // Diagonal glint reads as glass in toon shading.
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.beginPath(); c.moveTo(ox + x + w * 0.15, oy + y + h); c.lineTo(ox + x + w * 0.45, oy + y); c.lineTo(ox + x + w * 0.58, oy + y); c.lineTo(ox + x + w * 0.28, oy + y + h); c.fill();
    },
    slats(x, y, w, h, base = '#d3cdbf', line = '#b5ae9f') {
      P.fix(x, y, w, h, base);
      for (let yy = y + 4; yy < y + h; yy += 6) P.fix(x, yy, w, 1.5, line);
    },
    slab() { P.wall(0, 114, TILE, 14, 0.9); },
  };
  const at = (row, col, fn) => { ox = col * TILE; oy = (ROWS - 1 - row) * TILE; P.wall(0, 0, TILE, TILE, 1); fn(P, col); };

  for (let k = 0; k < COLS; k++) at(ROW.plain, k, () => {});

  // Shikun: smallish window with a roller shutter (trisim) at varying heights, laundry rack, AC.
  for (let k = 0; k < COLS; k++) at(ROW.shikun, k, (P) => {
    P.slab();
    const x = 32, y = 36, w = 62, h = 54;
    P.glass(x, y, w, h);
    P.fix(x - 2, y - 9, w + 4, 9, '#e9e5dc'); // shutter box
    const down = [0.4, 1, 0.65, 0.25][k];
    P.slats(x, y, w, Math.round(h * down));
    P.fix(x - 5, y + h, w + 10, 5, '#d8d1c3'); // sill
    if (k === 2) { // laundry rack under the window, the defining shikun detail
      P.fix(x - 6, y + h + 12, w + 12, 2, '#8a8a8a');
      const cols = ['#d84a4a', '#3f7fd0', '#f2c84b', '#ffffff', '#6cbf6a', '#e889b5'];
      for (let i = 0; i < 6; i++) P.fix(x - 2 + i * 11, y + h + 14, 8, 12 + (i % 3) * 4, cols[i]);
    }
    if (k === 3) {
      // Vertical concrete fins screening a closed balcony (Ramat Eliyahu walk-ups, Mapillary 802299140647537).
      P.wall(18, 20, 92, 94, 0.72);
      for (let x = 20; x < 108; x += 12) P.wall(x, 20, 7, 94, 1.02);
    }
  });

  // 1990s mid-rise: wider aluminium windows, balcony doors.
  for (let k = 0; k < COLS; k++) at(ROW.mid, k, (P) => {
    P.slab();
    if (k === 1) {
      P.fix(34, 18, 60, 96, '#e6e6e2'); P.glass(38, 22, 52, 92); P.fix(63, 22, 2, 92, '#e6e6e2');
      P.slats(38, 22, 52, 30);
    } else {
      const x = 22, y = 30, w = 84, h = 60;
      P.fix(x - 3, y - 3, w + 6, h + 6, '#e8e8e4');
      P.glass(x, y, w, h); P.fix(x + w / 2 - 1, y, 2, h, '#e8e8e4');
      P.slats(x, y, w, [0.3, 0, 0.8, 0.1][k] * h | 0);
      if (k === 3) { P.fix(4, 82, 14, 16, '#f1f1ee'); }
      P.fix(x - 6, y + h + 3, w + 12, 4, '#d8d1c3');
    }
  });

  // 1990s tower: paired windows with a coloured-frame look kept neutral; stacked strip.
  for (let k = 0; k < COLS; k++) at(ROW.tower, k, (P) => {
    P.slab();
    if (k === 2) {
      P.fix(20, 20, 88, 94, '#dfe6ea'); P.glass(24, 24, 80, 90, '#3f6684', '#7aa6c4'); P.fix(63, 24, 2, 90, '#dfe6ea');
    } else {
      for (const x of [16, 68]) { P.fix(x - 2, 28, 48, 64, '#e4e4e0'); P.glass(x, 30, 44, 60, '#46708f', '#80abc8'); }
      if (k === 1) { P.slats(16, 30, 44, 36); }
      if (k === 3) { P.slats(68, 30, 44, 60); }
    }
  });

  // Glass curtain wall: full-height glass, thin mullions, wall-tinted slab band (accent colours show there).
  const GL = [['#2f6a8a', '#5f9dbd'], ['#3d7d99', '#79b5cc'], ['#2b5874', '#5a8aa8'], ['#3a8c96', '#7cc0c4']];
  for (let k = 0; k < COLS; k++) at(ROW.glass, k, (P) => {
    P.wall(0, 0, TILE, TILE, 1);
    P.glass(0, 4, TILE, 98, GL[k][0], GL[k][1]);
    P.fix(0, 4, 3, 98, '#c9d3d9'); P.fix(TILE / 2 - 1, 4, 2, 98, '#c9d3d9'); P.fix(TILE - 3, 4, 3, 98, '#c9d3d9');
    P.wall(0, 102, TILE, 26, 0.95);
  });

  // Old moshava house: tall narrow window, wooden shutters (green/blue), stone courses.
  for (let k = 0; k < COLS; k++) at(ROW.old, k, (P) => {
    for (let yy = 8; yy < TILE; yy += 16) P.wall(0, yy, TILE, 1.5, 0.9);
    const x = 46, y = 22, w = 36, h = 74;
    P.fix(x - 4, y - 6, w + 8, 6, '#efe7d3'); P.fix(x - 6, y + h, w + 12, 6, '#efe7d3');
    P.glass(x, y, w, h, '#3c5566', '#6f8fa3');
    P.fix(x + w / 2 - 1, y, 2, h, '#f2ece0');
    const sh = ['#4f8a5b', '#3f74a6', '#4f8a5b', '#6e8f9e'][k];
    if (k === 2) P.slats(x, y, w, h, sh, '#3b6646');
    else { P.slats(x - 18, y, 16, h, sh, 'rgba(0,0,0,0.25)'); P.slats(x + w + 2, y, 16, h, sh, 'rgba(0,0,0,0.25)'); }
  });

  // Modern villa: wide dark-framed windows, sliding doors.
  for (let k = 0; k < COLS; k++) at(ROW.villa, k, (P) => {
    if (k === 1) { P.fix(18, 26, 92, 88, '#3b3f45'); P.glass(22, 30, 84, 84, '#4b6f88', '#88afc6'); P.fix(63, 30, 2, 84, '#3b3f45'); }
    else if (k === 2) { for (const x of [20, 72]) { P.fix(x, 34, 36, 44, '#3b3f45'); P.glass(x + 3, 37, 30, 38); } }
    else { P.fix(16, 34, 96, 52, '#3b3f45'); P.glass(20, 38, 88, 44); P.fix(63, 38, 2, 44, '#3b3f45'); if (k === 3) P.slats(20, 38, 88, 22, '#cfd2d4', '#aeb3b7'); }
  });

  // Office ribbon windows: continuous glass band, wall-tinted spandrels.
  for (let k = 0; k < COLS; k++) at(ROW.office, k, (P) => {
    P.glass(0, 26, TILE, 66, GL[k][0], GL[k][1]);
    for (const x of [0, 42, 85]) P.fix(x, 26, 3, 66, '#d4dade');
    P.wall(0, 92, TILE, 36, 0.97);
  });

  // Industrial: ribbed metal cladding, the odd high window strip.
  for (let k = 0; k < COLS; k++) at(ROW.industrial, k, (P) => {
    for (let x = 0; x < TILE; x += 16) P.wall(x + 10, 0, 6, TILE, 0.86);
    if (k === 1) P.glass(8, 10, 112, 18, '#5a7a8e', '#8db0c2');
    if (k === 3) P.wall(0, 100, TILE, 28, 0.78);
  });

  // School / public: windows with horizontal sunshades, a playful colour panel.
  for (let k = 0; k < COLS; k++) at(ROW.school, k, (P) => {
    P.slab();
    P.glass(22, 40, 84, 56);
    P.fix(14, 30, 100, 6, '#fafafa'); P.fix(14, 22, 100, 4, '#fafafa');
    P.fix(63, 40, 2, 56, '#eeeeea');
    if (k === 2) P.fix(98, 40, 20, 56, ['#f2a541', '#4fb3bf', '#e8615a', '#8cc152'][k]);
    if (k === 3) P.fix(8, 40, 14, 56, '#4fb3bf');
  });

  // Ground: shopfronts with sign bands and an occasional closed roller shutter.
  const SIGN = ['#d8423a', '#2f6db5', '#2e9a5b', '#f0b429'];
  for (let k = 0; k < COLS; k++) at(ROW.gShop, k, (P) => {
    P.fix(0, 6, TILE, 26, SIGN[k]); P.fix(12, 14, 60, 10, '#ffffff');
    if (k === 3) P.slats(6, 36, 116, 82, '#a9adb0', '#8c9094');
    else { P.fix(4, 36, 120, 84, '#2f3a40'); P.glass(8, 40, 112, 80, '#3f6378', '#7aa0b8'); P.fix(78, 40, 3, 80, '#2f3a40'); }
    P.fix(0, 120, TILE, 8, '#bdb6a8');
  });

  // Pilotis: open ground floor between columns, the classic shikun undercroft.
  for (let k = 0; k < COLS; k++) at(ROW.gPilotis, k, (P) => {
    P.fix(0, 0, TILE, TILE, '#585a5c');
    P.fix(0, 0, TILE, 14, '#6b6d6f');
    P.wall(0, 0, TILE, 10, 0.92);
    P.wall(0, 0, 14, TILE, 0.95); P.wall(TILE - 14, 0, 14, TILE, 0.8);
    if (k === 1) { P.fix(46, 40, 36, 88, '#8a6a4a'); P.glass(50, 44, 28, 40, '#3f5a6a', '#6c8696'); }
    if (k === 3) { for (let i = 0; i < 3; i++) P.fix(30 + i * 24, 64, 18, 22, '#9a9c88'); }
  });

  // Tower lobby: stone base with glass entrance.
  for (let k = 0; k < COLS; k++) at(ROW.gLobby, k, (P) => {
    P.wall(0, 0, TILE, TILE, 0.92);
    for (let yy = 20; yy < TILE; yy += 22) P.wall(0, yy, TILE, 2, 0.82);
    if (k === 0) { P.fix(20, 26, 88, 102, '#2f3a40'); P.glass(24, 30, 80, 98, '#3f6378', '#7aa0b8'); P.fix(63, 30, 2, 98, '#2f3a40'); }
    if (k === 2) P.glass(30, 40, 68, 50);
  });

  // Old house ground floor: arched wooden door or window.
  for (let k = 0; k < COLS; k++) at(ROW.gOldDoor, k, (P) => {
    for (let yy = 8; yy < TILE; yy += 16) P.wall(0, yy, TILE, 1.5, 0.9);
    if (k === 0 || k === 2) {
      P.fix(42, 30, 44, 98, '#efe7d3'); P.fix(46, 36, 36, 92, k ? '#3f74a6' : '#7a5136');
      P.fix(63, 36, 2, 92, 'rgba(0,0,0,0.3)');
    } else { P.glass(46, 30, 36, 66, '#3c5566', '#6f8fa3'); P.slats(28, 30, 16, 66, '#4f8a5b'); P.slats(84, 30, 16, 66, '#4f8a5b'); }
    P.wall(0, 116, TILE, 12, 0.8);
  });

  // Industrial ground: roller doors.
  for (let k = 0; k < COLS; k++) at(ROW.gIndDoor, k, (P) => {
    for (let x = 0; x < TILE; x += 16) P.wall(x + 10, 0, 6, TILE, 0.86);
    if (k !== 3) { P.slats(14, 24, 100, 104, '#9ea4a8', '#81878b'); P.fix(10, 20, 108, 5, '#f0b429'); }
    else { P.fix(40, 50, 30, 78, '#4b5b66'); }
  });

  // Villa ground: front door, garage, garden window.
  for (let k = 0; k < COLS; k++) at(ROW.gVillaDoor, k, (P) => {
    if (k === 0) { P.fix(46, 30, 36, 98, '#6b4a33'); P.fix(78, 76, 3, 6, '#d8c070'); }
    else if (k === 1) P.slats(12, 36, 104, 92, '#d6d8d9', '#b9bdbf');
    else { P.fix(16, 30, 96, 66, '#3b3f45'); P.glass(20, 34, 88, 58); }
    P.wall(0, 120, TILE, 8, 0.85);
  });

  // Showroom ground floor: storey-high glass with thin mullions under a wall-tinted fascia,
  // the car/furniture showrooms along the industrial-zone main roads (Mapillary 161210462524430,
  // 1228399470927683).
  for (let k = 0; k < COLS; k++) at(ROW.gShowroom, k, (P) => {
    P.wall(0, 0, TILE, 22, 0.97);
    P.fix(0, 22, TILE, 106, '#3a4650');
    P.glass(3, 25, TILE - 6, 100, k === 2 ? '#2c5a72' : '#3f6c86', k === 2 ? '#6898b2' : '#86b4cc');
    P.fix(TILE / 2 - 1, 25, 2, 100, '#3a4650');
    if (k === 1) { P.fix(44, 60, 40, 65, '#2f3a40'); P.glass(47, 63, 34, 62, '#4b7590', '#9cc3d6'); }
    if (k === 3) P.fix(0, 4, TILE, 12, '#f0f0ec');
  });

  // Panels: tilt-up concrete with joints every bay and the odd high slot window (cols 0-2), and
  // silver sandwich-panel cladding with horizontal seams (col 3). Logistics boxes in Gan Sorek and
  // the old industrial zone (Mapillary 582636666042956, 527840945041701).
  for (let k = 0; k < COLS; k++) at(ROW.panel, k, (P) => {
    if (k === 3) {
      for (let y = 10; y < TILE; y += 18) P.wall(0, y, TILE, 2, 0.82);
    } else {
      P.wall(0, 0, 3, TILE, 0.74); P.wall(TILE - 3, 0, 3, TILE, 0.86);
      P.wall(0, 0, TILE, 5, 0.9);
      if (k === 1) P.glass(14, 14, 100, 14, '#58788a', '#8eb1c3');
      if (k === 2) P.wall(10, 60, 108, 2, 0.84);
    }
  });

  // Combine colour + mask into one RGBA DataTexture. Canvas alpha would premultiply away the
  // colour of untinted pixels, so the mask lives in its own canvas until here.
  const cd = c.getImageData(0, 0, W, H).data, md = m.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const src = y * W * 4, dst = (H - 1 - y) * W * 4; // flip so atlas row r sits at v in [r, r+1]/ROWS
    for (let i = 0; i < W * 4; i += 4) {
      out[dst + i] = cd[src + i]; out[dst + i + 1] = cd[src + i + 1]; out[dst + i + 2] = cd[src + i + 2];
      out[dst + i + 3] = md[src + i];
    }
  }
  const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function toonGradient() {
  const data = new Uint8Array([150, 150, 150, 255, 205, 205, 205, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// Toon material that reads window tiles from the atlas. Per vertex: `wuv` = (bay, storey)
// in tile units, `wcell` = (atlas row, ground-floor mode, per-building seed).
function wallMaterial(gradientMap, atlas) {
  const mat = new THREE.MeshToonMaterial({ gradientMap, vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uAtlas = { value: atlas };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 wuv;\nattribute vec3 wcell;\nvarying vec2 vWuv;\nvarying vec3 vWcell;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWuv = wuv;\nvWcell = wcell;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uAtlas;\nvarying vec2 vWuv;\nvarying vec3 vWcell;')
      .replace('#include <color_fragment>', `
        {
          vec2 t = vWuv;
          vec2 ci = floor(t);
          vec2 f = t - ci;
          // Interpolated attributes wobble in the last bits; round them or the hash flickers per pixel.
          vec3 wc = floor(vWcell + 0.5);
          float row = wc.x;
          if (wc.y > 0.5 && ci.y < 0.5) row = ${ROW.gShop - 1}.0 + wc.y;
          float h = fract(sin(dot(vec3(mod(ci, 64.0), wc.z), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          float col = min(floor(h * ${COLS}.0), ${COLS - 1}.0);
          const float PAD = 0.02;
          vec2 cs = vec2(1.0 / ${COLS}.0, 1.0 / ${ROWS}.0);
          vec2 auv = (vec2(col, row) + PAD + f * (1.0 - 2.0 * PAD)) * cs;
          vec2 g = (1.0 - 2.0 * PAD) * cs;
          vec4 tx = textureGrad(uAtlas, auv, dFdx(t) * g, dFdy(t) * g);
          diffuseColor.rgb *= tx.rgb * mix(vec3(1.0), vColor, tx.a);
        }`);
  };
  mat.customProgramCacheKey = () => 'rishon-building-walls-v2';
  return mat;
}

// ---------- geometry accumulators ----------

class Acc {
  constructor(walls = false) { this.p = []; this.n = []; this.c = []; this.w = walls; this.uv = walls ? [] : null; this.cell = walls ? [] : null; }
  get empty() { return this.p.length === 0; }
  // a, b, c: [x, y, z]. The triangle is wound so its normal agrees with `up` when given.
  // Hot path (millions of calls per city): no temporary arrays.
  tri(a, b, c, col, up = null, uvs = null, cell = null) { this._tri(a, b, c, col, up, uvs, cell, 0, 1, 2); }
  // i0..i2 pick the colours/uvs out of 3- or 4-entry arrays, so quad() needs no slices.
  _tri(a, b, c, col, up, uvs, cell, i0, i1, i2) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (up && nx * up[0] + ny * up[1] + nz * up[2] < 0) {
      const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz;
      const ti = i1; i1 = i2; i2 = ti;
    }
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    if (Array.isArray(col)) {
      const k0 = col[i0], k1 = col[i1], k2 = col[i2];
      this.c.push(k0.r, k0.g, k0.b, k1.r, k1.g, k1.b, k2.r, k2.g, k2.b);
    } else this.c.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    if (this.w) {
      if (uvs) this.uv.push(uvs[i0][0], uvs[i0][1], uvs[i1][0], uvs[i1][1], uvs[i2][0], uvs[i2][1]);
      else this.uv.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
      const c0 = cell ? cell[0] : ROW.plain, c1 = cell ? cell[1] : 0, c2 = cell ? cell[2] : 0;
      this.cell.push(c0, c1, c2, c0, c1, c2, c0, c1, c2);
    }
  }
  quad(a, b, c, d, col, up, uvs, cell) {
    this._tri(a, b, c, col, up, uvs, cell, 0, 1, 2);
    this._tri(a, c, d, col, up, uvs, cell, 0, 2, 3);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.w) {
      g.setAttribute('wuv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.setAttribute('wcell', new THREE.Float32BufferAttribute(this.cell, 3));
    }
    g.computeBoundingSphere();
    // The build arrays are plain JS numbers (8 bytes each, ~1.9 GB across the city); the
    // geometry holds its own Float32 copy, so let them go. `tris` keeps the count for stats.
    this.tris = this.p.length / 9;
    this.p = []; this.n = []; this.c = []; if (this.w) { this.uv = []; this.cell = []; }
    return g;
  }
}

const UP = [0, 1, 0];

// ---------- polygon helpers ----------

function ring(flat, k) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i] * k, flat[i + 1] * k]);
  // Drop a closing duplicate and zero-length edges; they break walls and triangulation.
  const clean = [];
  for (const p of out) { const q = clean[clean.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3) clean.push(p); }
  if (clean.length > 1) { const a = clean[0], b = clean[clean.length - 1]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) clean.pop(); }
  return clean;
}
function signedArea(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}
// Area-weighted centroid; vertex averages drift toward densely sampled curved sides.
function centroid(r) {
  let x = 0, z = 0, a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length], w = p[0] * q[1] - q[0] * p[1];
    a += w; x += (p[0] + q[0]) * w; z += (p[1] + q[1]) * w;
  }
  if (Math.abs(a) < 1e-9) { let sx = 0, sz = 0; for (const p of r) { sx += p[0]; sz += p[1]; } return [sx / r.length, sz / r.length]; }
  return [x / (3 * a), z / (3 * a)];
}
function inPoly(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function bbox(r) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const p of r) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
  return { minX: a, maxX: b, minZ: c, maxZ: d };
}
function isConvex(r) {
  let sign = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length], c = r[(i + 2) % r.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) continue;
    if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}
// Oriented bounding box by testing each edge direction: length >= width, plus the unit axis.
function obb(r) {
  let best = null;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l < 1e-3) continue;
    const ux = (q[0] - p[0]) / l, uz = (q[1] - p[1]) / l;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const s of r) { const u = s[0] * ux + s[1] * uz, v = -s[0] * uz + s[1] * ux; if (u < a) a = u; if (u > b) b = u; if (v < c) c = v; if (v > d) d = v; }
    const area = (b - a) * (d - c);
    if (!best || area < best.area) best = { area, L: b - a, W: d - c, ux, uz };
  }
  if (!best) return { L: 0, W: 0, ux: 1, uz: 0, area: 0 };
  if (best.W > best.L) return { area: best.area, L: best.W, W: best.L, ux: -best.uz, uz: best.ux };
  return best;
}
function triangulate(r) {
  try { return THREE.ShapeUtils.triangulateShape(r.map((p) => new THREE.Vector2(p[0], p[1])), []); } catch { return []; }
}
function fillPoly(acc, r, y, color, tris = null) {
  if (r.length < 3) return;
  for (const t of tris || triangulate(r)) {
    const a = r[t[0]], b = r[t[1]], c = r[t[2]];
    acc.tri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], color, UP);
  }
}
// Uniform hash grid for the extras lookups (tags, shops, road segments, evidence).
class Grid {
  constructor(cell) { this.s = cell; this.m = new Map(); }
  add(x, z, v, dedupe = false) {
    const key = Math.floor(x / this.s) * 65536 + Math.floor(z / this.s); // numeric: no string garbage in the hot loop
    let a = this.m.get(key);
    if (!a) { a = []; this.m.set(key, a); }
    if (dedupe && a.length && a[a.length - 3] === v) return;
    a.push(v, x, z);
  }
  near(x, z, rad, fn) {
    const s = this.s, x0 = Math.floor((x - rad) / s), x1 = Math.floor((x + rad) / s), z0 = Math.floor((z - rad) / s), z1 = Math.floor((z + rad) / s);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const a = this.m.get(i * 65536 + j);
      if (a) for (let n = 0; n < a.length; n += 3) fn(a[n], a[n + 1], a[n + 2]);
    }
  }
}
function segDist(x, z, s) {
  const dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / l2));
  return Math.hypot(x - s[0] - dx * t, z - s[1] - dz * t);
}
function ringDist(x, z, r) {
  let d = Infinity;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; d = Math.min(d, segDist(x, z, [p[0], p[1], q[0], q[1]])); }
  return d;
}

// Inset toward the centroid; good enough for the mostly convex towers that get penthouses.
function shrink(r, c, s) { return r.map((p) => [c[0] + (p[0] - c[0]) * s, c[1] + (p[1] - c[1]) * s]); }

// Stable per-building random numbers from the centroid in decimetres, so results survive
// data regeneration and re-ordering.
function hasher(xm, zm) {
  const X = Math.round(xm * 10) | 0, Z = Math.round(zm * 10) | 0;
  return (salt) => {
    let h = Math.imul(X ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((Z + Math.imul(salt, 0x632be5ab)) | 0, 0xc2b2ae35);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
const pick = (arr, r) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
const range = ([a, b], r) => a + Math.floor(r * (b - a + 1));
const col = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const colourOf = (v, fallback) => { try { return typeof v === 'number' ? v : new THREE.Color(String(v)).getHex(); } catch { return fallback; } };

// ---------- prop templates ----------

function paint(geo, hex) {
  const c = new THREE.Color(hex);
  if (geo.index) geo = geo.toNonIndexed();
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  return geo;
}
function merge(parts) {
  // Small local merge so this module does not depend on BufferGeometryUtils.
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), colr = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); colr.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  g.computeBoundingSphere();
  return g;
}
// Israeli rooftop solar water heater (dud shemesh), 1 unit = 1 metre before scaling.
// The collector faces south (+z) and the tank sits on its high north edge, as on real roofs.
function solarTemplate() {
  const panel = new THREE.BoxGeometry(1.9, 0.08, 1.0);
  panel.rotateX(0.62);
  panel.translate(0, 0.62, 0.15);
  // Open-ended five-sided tank: tens of thousands of these are on screen, so every triangle counts.
  const tank = new THREE.CylinderGeometry(0.28, 0.28, 1.8, 5, 1, true);
  tank.rotateZ(Math.PI / 2);
  tank.translate(0, 1.0, -0.45);
  const legs = new THREE.BoxGeometry(1.8, 0.8, 0.08).translate(0, 0.4, -0.45);
  return merge([paint(panel, 0x2a4f86), paint(tank, 0xf6f6f2), paint(legs, 0x9aa0a6)]);
}
// Unit length along x, 1.4 m deep toward +z: slab and front rail. Hand-built
// instead of boxes because there are tens of thousands of instances.
function balconyTemplate() {
  const P = [], N = [], C = [];
  const slab = new THREE.Color(0xf4efe4), rail = new THREE.Color(0xffffff);
  const quad = (a, b, c, d, n, k) => { for (const v of [a, b, c, a, c, d]) { P.push(...v); N.push(...n); C.push(k.r, k.g, k.b); } };
  // Round 6 ("more rounded"): the rail and slab top have chamfered front corners (0.18 of the unit
  // width, 0.35 m deep). Paid for by dropping the rail's back face (seen only from inside) and the
  // 0.22 m slab ends, so it stays at 12 triangles per instance.
  const x0 = -0.5, x1 = 0.5, z1 = 1.4, t = 0.22, h = 1.2, cx = 0.18, cz = 0.35;
  const up = [0, 1, 0];
  const A = [x0, z1 - cz], B = [x0 + cx, z1], Cc = [x1 - cx, z1], D = [x1, z1 - cz];
  quad([x0, t, 0], [A[0], t, A[1]], [D[0], t, D[1]], [x1, t, 0], up, slab); // slab top, rear part
  quad([A[0], t, A[1]], [B[0], t, B[1]], [Cc[0], t, Cc[1]], [D[0], t, D[1]], up, slab); // slab top, front part
  quad([x0, 0, 0], [x1, 0, 0], [Cc[0], 0, z1 - 0.02], [B[0], 0, z1 - 0.02], [0, -1, 0], slab.clone().multiplyScalar(0.8)); // soffit
  quad([B[0], 0, B[1]], [Cc[0], 0, Cc[1]], [Cc[0], h, Cc[1]], [B[0], h, B[1]], [0, 0, 1], rail); // rail front
  quad([A[0], 0, A[1]], [B[0], 0, B[1]], [B[0], h, B[1]], [A[0], h, A[1]], [-0.7, 0, 0.7], rail.clone().multiplyScalar(0.94)); // corner facets
  quad([Cc[0], 0, Cc[1]], [D[0], 0, D[1]], [D[0], h, D[1]], [Cc[0], h, Cc[1]], [0.7, 0, 0.7], rail.clone().multiplyScalar(0.94));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeBoundingSphere();
  return g;
}

// ---------- archetype selection ----------

const M2U = SCALE; // horizontal world units per metre
const V2U = SCALE * VEX; // vertical world units per metre

const ARCH = {
  // floorM / groundM in metres, bay in metres.
  shikun: { row: ROW.shikun, floorM: 2.9, groundM: 3.0, bay: 3.3 },
  mid: { row: ROW.mid, floorM: 3.0, groundM: 3.6, bay: 3.8 },
  tower90: { row: ROW.tower, floorM: 3.0, groundM: 4.2, bay: 3.6 },
  towerNew: { row: ROW.glass, floorM: 3.15, groundM: 5.0, bay: 3.0 },
  villa: { row: ROW.villa, floorM: 3.1, groundM: 3.1, bay: 4.2 },
  oldHouse: { row: ROW.old, floorM: 3.9, groundM: 3.9, bay: 3.2 },
  centre: { row: ROW.shikun, floorM: 3.0, groundM: 4.4, bay: 3.4 },
  commercial: { row: ROW.office, floorM: 4.2, groundM: 5.0, bay: 3.4 },
  office: { row: ROW.office, floorM: 3.6, groundM: 5.0, bay: 3.2 },
  industrial: { row: ROW.industrial, floorM: 6.5, groundM: 6.5, bay: 4.5 },
  public: { row: ROW.school, floorM: 3.6, groundM: 3.8, bay: 3.8 },
  shed: { row: ROW.plain, floorM: 3.0, groundM: 3.0, bay: 4 },
  // Industrial-zone types (ROUND3): glass office/showroom, big-box retail or logistics hall,
  // tilt-up concrete workshop, and the low plastered commercial strip on old-zone main roads.
  showroom: { row: ROW.office, floorM: 3.8, groundM: 5.4, bay: 3.2 },
  bigbox: { row: ROW.panel, floorM: 9.0, groundM: 9.0, bay: 6.0 },
  tiltup: { row: ROW.panel, floorM: 7.0, groundM: 7.0, bay: 5.5 },
  strip: { row: ROW.mid, floorM: 3.4, groundM: 4.6, bay: 3.6 },
};

const IND_WALL = {
  showroom: [0xf2f4f5, 0xe2e6e9, 0xcfd6dc, 0xd9e1e6, 0xeef0ee],
  bigbox: [0xe9e9e6, 0xd7dadc, 0xc9ced2, 0xe6e0d4, 0xdfe3e5],
  tiltup: [0xd6d2c8, 0xcfcac0, 0xe0dbd0, 0xc8c6c0, 0xd9d4c6],
};
// Fascia bands of the big boxes: mostly corporate blue/red/yellow on grey.
const IND_BAND = [0x2f6db5, 0x2f6db5, 0xd8423a, 0xf0b429, 0x2e9a5b, 0x5a626c];

// Archetype and storeys for a footprint in an OSM industrial zone. `front` = an edge faces a
// main road within ~30 m. Mix per zone from street-level photos (SOURCES, industrial zones).
function industrialArch(style, m, tagFloors, R, named) {
  const { area, front } = m;
  if (area < 60) return ['shed', 1];
  if (style === 'west') {
    if (area > 4000 || named) return ['bigbox', tagFloors >= 2 ? 2 : 1];
    if (front) return ['showroom', tagFloors || range([2, 4], R(4))];
    // Side streets: workshops and warehouses, a mezzanine office at most (founder, round 4).
    return [R(5) < 0.5 ? 'tiltup' : 'industrial', tagFloors >= 2 ? 2 : 1];
  }
  if (style === 'south') {
    if (area > 5000) return ['bigbox', 1];
    if (front && area > 700) return ['showroom', tagFloors || range([3, 5], R(4))];
    if (tagFloors >= 3) return ['office', tagFloors];
    return [R(5) < 0.6 ? 'tiltup' : 'industrial', 1];
  }
  // old zone
  if (front && area < 3000) return R(6) < 0.25 ? ['showroom', tagFloors || range([2, 3], R(4))] : ['strip', tagFloors || range([2, 3], R(4))];
  if (area > 3000) return [R(5) < 0.5 ? 'bigbox' : 'tiltup', 1];
  return [R(5) < 0.6 ? 'industrial' : 'tiltup', tagFloors >= 2 ? 2 : 1];
}

const lighten = (hex, k) => new THREE.Color(hex).lerp(new THREE.Color(0xffffff), k).getHex();

// Private-house look for the round-5 profiles (Neve Yam, Katznelson and the east). Salts 50-58 are
// new so the existing per-building random streams of other archetypes are unchanged.
function villaKit(spec, K, m, tagFloors, R) {
  if (!tagFloors) {
    const f = R(50);
    spec.floors = f < (K.floors1 || 0.04) ? 1 : f > 1 - (K.floors3 || 0) && m.area > 140 ? 3 : 2;
  }
  if (R(51) < K.modern) {
    // White cube with dark frames and a flat roof: the 2010s rebuilds (Katznelson 1207114670170707).
    spec.wall = pick([0xfbfbf8, 0xf4f3ef, 0xe9e8e4, 0xdedfdf], R(5));
    spec.row = ROW.villa; spec.roof = 'flat'; spec.parapet = 0.9 * V2U; spec.solar = 0.5;
  } else {
    const u = R(52);
    spec.wall = u < K.brick ? pick(PAL.villaBrick, R(5)) : u < K.brick + K.stone ? pick(PAL.villaStone, R(5)) : pick(PAL[K.pal] || PAL.villa, R(5));
    // 1990s houses mostly have aluminium windows with roller shutters, not dark villa frames.
    spec.row = R(53) < 0.6 ? ROW.mid : ROW.villa;
    if (R(54) < K.tile) {
      // Hip roof on simple footprints; L-shaped ones get the Israeli tiled skirt round a flat roof.
      spec.roof = m.n === 4 || m.convex ? 'hip' : 'skirt';
      spec.roofColour = pick(ROOF_TILE, R(11));
      spec.solar = spec.roof === 'skirt' ? 0.4 : 0;
    } else { spec.roof = 'flat'; spec.solar = 0.6; }
  }
  if (R(55) < K.yard) spec.yardWall = { colour: pick(PAL.yardWall, R(56)), h: (1.2 + R(57) * 0.6) * V2U };
}

// Decide the archetype and every visual parameter for one footprint.
function specFor(prof, profId, kind, hm, m, R, cluster, extra) {
  const { area, L, W, aspect, convex } = m;
  // Storeys: researched table (data/building_heights.json) > OSM building:levels/height > heuristic.
  const known = extra && extra.storeys > 0 ? extra.storeys : 0;
  const tagFloors = known || (hm > 0 ? Math.max(1, Math.round(hm / 3)) : 0);
  let arch, floors;

  if (area < 30) { arch = 'shed'; floors = 1; }
  else if (prof.style && kind !== 5 && kind !== 6 && tagFloors < 7) {
    [arch, floors] = industrialArch(prof.style, m, tagFloors, R, extra && extra.bigName);
  } else if (kind === 4 || (prof.industrial && (area > 900 || kind === 3 || kind === 0) && tagFloors < 5)) {
    arch = area > 400 || kind === 4 ? 'industrial' : 'commercial';
    floors = tagFloors ? Math.max(1, Math.round(hm / (arch === 'industrial' ? 6.5 : 4.2))) : (arch === 'industrial' ? 1 + (R(3) < 0.25 ? 1 : 0) : range([1, 3], R(3)));
  } else if (kind === 3 || (prof.industrial && tagFloors >= 5)) {
    arch = tagFloors >= 4 ? 'office' : 'commercial';
    floors = tagFloors || (area > 2500 ? range([1, 2], R(3)) : range([1, 3], R(3)));
  } else if (kind === 5 || kind === 6) {
    arch = 'public';
    floors = tagFloors || (area > 1500 ? range([2, 3], R(3)) : range([1, 3], R(3)));
  } else if (prof.old && !tagFloors && area < prof.villaMax) {
    arch = 'oldHouse'; floors = R(3) < 0.6 ? 1 : 2;
  } else if (prof.old) {
    arch = 'centre'; floors = tagFloors || range(prof.slabFloors, R(3));
  } else if (kind === 1 || (extra && extra.type === 'house') || (!tagFloors && area < prof.villaMax && !prof.industrial)) {
    arch = 'villa'; floors = tagFloors ? Math.min(3, tagFloors) : (R(3) < 0.85 ? 2 : 1);
    if (prof.shikun && !prof.villaKit && area > 75 && R(7) < 0.45) { arch = 'shikun'; floors = range([2, 3], R(3)); }
  } else if (tagFloors) {
    floors = tagFloors;
    if (floors >= 18 || (prof.glass && floors >= 9)) arch = prof.glass || floors >= 22 ? 'towerNew' : 'tower90';
    else if (floors >= 9) arch = 'tower90';
    // A compact 7-8 storey block in the tower districts is a point tower (Neot Ashlim type).
    else if (floors >= 7 && aspect < 1.55 && area > 260 && area <= TOWER_MAX_M2 && !prof.shikun) arch = 'tower90';
    else if (floors >= 5) arch = 'mid';
    else arch = prof.shikun || prof.old ? 'shikun' : 'mid';
  } else if (prof.shikun) {
    // Long thin slabs are the walk-up estate blocks; compact bigger ones are later infill.
    if (aspect > 1.6 || area < 420) { arch = 'shikun'; floors = range(prof.slabFloors, R(3)); }
    else if (area > 650 && area <= TOWER_MAX_M2 && convex && aspect < 1.4 && R(4) < 0.35) { arch = 'tower90'; floors = range(prof.towerFloors, R(3)); }
    else { arch = 'mid'; floors = range([4, 8], R(3)); }
  } else if (prof.industrial) {
    arch = 'commercial'; floors = range([1, 3], R(3));
  } else {
    // West Rishon: compact footprints are point towers, long ones are slab blocks.
    // `blocks` profiles (round 5) keep untagged big footprints as apartment blocks.
    const compact = aspect < 1.55 && area > 260;
    // Untagged footprints over TOWER_MAX_M2 are podiums, malls or slab blocks, not one tower.
    if (compact && !prof.blocks && area > (prof.towerMin || 330) && area <= TOWER_MAX_M2) {
      floors = range(prof.tallShare && R(18) < prof.tallShare ? prof.tallFloors : prof.towerFloors, R(3));
      arch = prof.glass && floors >= 12 ? 'towerNew' : 'tower90';
    } else { arch = 'mid'; floors = range(prof.slabFloors, R(3)); }
  }
  floors = Math.max(1, Math.min(floors, 60));

  const A = ARCH[arch];
  const heightWhy = known ? `table-${extra.confidence || 'medium'}` : hm > 0 ? 'osm' : 'heuristic';
  const spec = {
    arch, floors, heightWhy, row: A.row, ground: GROUND.none, bay: A.bay,
    fh: A.floorM * V2U, gh: A.groundM * V2U,
    wall: 0xffffff, accent: null, accentEdges: null,
    roof: 'flat', roofColour: pick(ROOF_FLAT, R(11)), parapet: 0.9 * V2U,
    solar: 0, balconies: null, stairBox: false, pilotis: false,
  };
  if (floors === 1) spec.gh = Math.max(spec.gh, A.floorM * V2U);

  const palette = PAL[prof.palette] || PAL.shikun;
  switch (arch) {
    case 'shikun': {
      spec.wall = prof.palette === 'ganim' ? pick(PAL.ganim, R(5)) : pick(prof.palette === 'shikunWest' || prof.palette === 'remez' ? PAL[prof.palette] : PAL.shikun, cluster(1) * 0.6 + R(5) * 0.4);
      if (R(6) < (prof.pilotis ?? 0.3) && floors >= 3) { spec.ground = GROUND.pilotis; spec.pilotis = true; }
      else if (prof.old || (R(6) > 0.85 && area > 200)) spec.ground = GROUND.shop;
      spec.solar = 1.0; spec.stairBox = floors >= 3;
      // Remez walk-ups: solid plaster parapets in the wall colour, a little lighter (round 5 photos).
      spec.balconies = { faces: 1, perFloor: aspect > 2 ? 3 : 2, width: prof.solidRails ? 0.22 : 0.18, rail: prof.solidRails ? lighten(spec.wall, 0.06) : 0xf2eee6, p: prof.solidRails ? 0.75 : 0.55 };
      if (spec.ground === GROUND.pilotis && !tagFloors) spec.floors += 1; // the open ground floor sits below the walk-up floors
      break;
    }
    case 'mid': {
      spec.wall = pick(prof.midPalette ? PAL[prof.midPalette] : palette, R(5));
      spec.ground = R(6) < 0.5 ? GROUND.lobby : (prof.palette === 'shikun' && R(6) > 0.8 ? GROUND.shop : GROUND.pilotis);
      spec.pilotis = spec.ground === GROUND.pilotis;
      spec.solar = 0.8; spec.stairBox = true;
      spec.roof = floors >= 5 && R(8) < 0.55 ? 'setback' : 'flat';
      spec.balconies = { faces: 2, perFloor: 2, width: 0.3, rail: 0xffffff, p: 0.9 };
      break;
    }
    case 'tower90': {
      spec.wall = pick(PAL[prof.palette] && prof.palette !== 'shikun' ? PAL[prof.palette] : PAL.tower90, cluster(2) * 0.5 + R(2) * 0.5);
      spec.accent = pick(prof.accents || (prof.palette === 'white' ? PAL.whiteAccent : PAL.tower90Accent), cluster(3));
      if (prof.awnings) { spec.groundAccent = true; spec.ground = GROUND.pilotis; }
      if (prof.palette === 'white') spec.crownPlain = R(15) < 0.7;
      spec.ground = prof.awnings ? GROUND.pilotis : GROUND.lobby;
      spec.pilotis = spec.ground === GROUND.pilotis;
      spec.solar = 0.5; spec.stairBox = true;
      const tr = prof.towerRoof || { setback: 0.6, crown: 0.4 };
      if (tr.penthouse) spec.roof = 'penthouse';
      else if ((tr.crown || 0) > R(9)) spec.roof = 'crown';
      else spec.roof = 'setback';
      spec.accentEdges = 'corners';
      if (prof.chunky) {
        // Recessed balcony stacks on every face, set at the corners and deeper than the default:
        // this is what makes the real towers read wide and heavy (Mapillary 769716300409432).
        spec.balconies = { faces: 4, perFloor: 2, corner: true, depth: 1.5, width: 0.3, rail: R(19) < 0.5 ? 0xf4f1ea : 0x6fa58a, p: 1 };
      } else {
        spec.balconies = { faces: 2, perFloor: 2, width: 0.28, rail: prof.darkRails ? 0x4a5560 : prof.awnings ? 0x6fa58a : 0xffffff, p: 1 };
      }
      break;
    }
    case 'towerNew': {
      spec.wall = pick(PAL.glass, R(5));
      // Half the new towers are white frames with punched windows and glass balconies, not curtain walls.
      if (R(17) < 0.5) { spec.row = ROW.tower; spec.wall = pick(PAL.white, R(5)); spec.crownPlain = R(15) < 0.6; }
      spec.accent = pick(PAL.glassAccent, cluster(3));
      spec.ground = GROUND.lobby;
      spec.roof = 'crown';
      spec.accentEdges = 'one';
      spec.solar = 0.2; spec.stairBox = false;
      spec.balconies = { faces: 2, perFloor: 3, width: 0.24, rail: 0x9fd0e6, p: 1 };
      break;
    }
    case 'villa': {
      spec.wall = pick(PAL.villa, R(5));
      spec.ground = GROUND.villaDoor;
      const tile = prof.shikun ? 0.35 : 0.55;
      spec.roof = R(8) < (prof.tile ?? tile) ? 'hip' : 'flat';
      if (spec.roof === 'hip') spec.roofColour = pick(ROOF_TILE, R(11));
      spec.parapet = 0.6 * V2U;
      spec.solar = spec.roof === 'flat' ? 0.6 : 0;
      const K = prof.villaKit;
      if (K) villaKit(spec, K, m, tagFloors, R);
      break;
    }
    case 'oldHouse': {
      spec.wall = pick(PAL.stone, R(5));
      spec.ground = GROUND.oldDoor;
      spec.roof = R(8) < 0.8 ? 'hip' : 'flat';
      spec.roofColour = spec.roof === 'hip' ? pick(ROOF_TILE, R(11)) : spec.roofColour;
      spec.parapet = 0.5 * V2U;
      // Kurkar garden walls round the moshava houses (ynet, see SOURCES).
      if (prof.yardWalls && R(55) < prof.yardWalls) spec.yardWall = { colour: pick([0xd9c9a3, 0xcdbb94, 0xc9b189, 0xe1d7c2], R(56)), h: (1.1 + R(57) * 0.5) * V2U };
      break;
    }
    case 'centre': {
      spec.wall = pick(PAL.shikun, R(5));
      spec.ground = GROUND.shop;
      spec.solar = 0.8; spec.stairBox = floors >= 3;
      spec.balconies = { faces: 1, perFloor: 2, width: 0.25, rail: 0xffffff, p: 0.7 };
      break;
    }
    case 'commercial': {
      spec.wall = pick(PAL.commercial, R(5));
      spec.ground = GROUND.shop;
      spec.parapet = 1.4 * V2U;
      if (R(12) < 0.5) { spec.accent = pick([0xd8423a, 0x2f6db5, 0xf0b429, 0x2e9a5b], R(16)); spec.accentEdges = 'band'; }
      break;
    }
    case 'office': {
      spec.wall = pick(PAL.commercial, R(5));
      spec.row = ROW.office; spec.ground = GROUND.lobby; spec.roof = floors >= 8 ? 'crown' : 'flat';
      spec.accent = pick(PAL.glassAccent, R(12)); spec.accentEdges = 'one';
      break;
    }
    case 'industrial': {
      spec.wall = pick(PAL.industrial, R(5));
      spec.ground = GROUND.indDoor;
      spec.roofColour = pick(ROOF_METAL, R(11));
      spec.parapet = 0.7 * V2U;
      spec.roof = 'shed';
      break;
    }
    case 'public': {
      spec.wall = pick(PAL.public, R(5));
      spec.roof = floors <= 2 && area < 500 && R(8) < 0.4 ? 'hip' : 'flat';
      if (spec.roof === 'hip') spec.roofColour = pick(ROOF_TILE, R(11));
      if (kind === 6) { spec.wall = pick(PAL.stone, R(5)); spec.row = ROW.old; }
      break;
    }
    case 'showroom': {
      spec.wall = pick(IND_WALL.showroom, R(5));
      spec.ground = m.front ? GROUND.showroom : GROUND.lobby;
      spec.parapet = 1.2 * V2U;
      spec.accent = pick(PAL.glassAccent, R(12)); spec.accentEdges = 'one';
      break;
    }
    case 'bigbox': {
      spec.wall = pick(IND_WALL.bigbox, R(5));
      spec.ground = GROUND.none;
      spec.accent = pick(IND_BAND, R(12));
      spec.roofColour = pick(ROOF_METAL, R(11));
      spec.parapet = 2.2 * V2U;
      spec.roof = 'box';
      break;
    }
    case 'tiltup': {
      spec.wall = pick(IND_WALL.tiltup, R(5));
      spec.ground = GROUND.indDoor;
      spec.roofColour = pick(ROOF_METAL, R(11));
      spec.parapet = 1.0 * V2U;
      spec.roof = 'shed';
      break;
    }
    case 'strip': {
      spec.wall = pick(PAL.commercial.concat(PAL.shikun.slice(0, 3)), R(5));
      spec.ground = GROUND.shop;
      spec.solar = 0.7; spec.stairBox = floors >= 2;
      spec.parapet = 1.0 * V2U;
      break;
    }
    default: { // shed
      spec.wall = pick(PAL.villa, R(5));
      spec.parapet = 0.3 * V2U;
    }
  }
  // Photo evidence for this exact footprint beats every heuristic.
  const ev = extra && extra.evidence;
  if (ev) {
    if (ev.floors) spec.floors = ev.floors;
    if (ev.roof) { spec.roof = ev.roof; spec.pyramidWhy = ev.roof === 'pyramid' ? (ev.maybe ? 'founderMaybe' : 'founder') : undefined; }
  }
  // Researched look for this footprint (heights table `facade`, `wall`, `roof`): photo-matched rows.
  if (extra && extra.facade && ROW[extra.facade] != null) spec.row = ROW[extra.facade];
  if (extra && extra.wallHex) { spec.wall = colourOf(extra.wallHex, spec.wall); spec.crownPlain = true; }
  if (extra && extra.roofKind) spec.roof = extra.roofKind;
  // OSM roof tags win where mappers set them.
  if (extra && extra.roofShape) {
    const s = extra.roofShape;
    if (s === 'pyramidal' && convex) { spec.roof = 'pyramid'; spec.pyramidWhy = 'osm'; }
    else if ((s === 'hipped' || s === 'gabled') && floors <= 4) spec.roof = 'hip';
    else if (s === 'flat' && (spec.roof === 'hip' || spec.roof === 'pyramid')) { spec.roof = 'flat'; spec.pyramidWhy = undefined; }
  }
  if (spec.roof === 'pyramid') spec.roofColour = prof.pyramidColour || 0x9fd3ea;
  if (extra && extra.roofColour) spec.roofColour = extra.roofColour;
  if (extra && extra.wallColour != null) spec.wall = extra.wallColour;
  // A shop node (OSM shop/amenity) at the footprint means a shop on the ground floor.
  if (extra && extra.shop && (arch === 'shikun' || arch === 'mid' || arch === 'tower90' || arch === 'centre')) {
    if (spec.ground === GROUND.pilotis && arch === 'shikun') spec.floors -= 1;
    spec.ground = GROUND.shop; spec.pilotis = false;
  }
  if (spec.roof === 'hip' && !(m.n === 4 || convex)) spec.roof = 'flat';
  // Kiryat Ganim walk-ups: per-building kit so neighbours differ (round 4).
  if (prof.variety && (arch === 'shikun' || arch === 'mid') && spec.floors <= 7 && area > 120) {
    if (arch === 'mid') spec.wall = pick(prof.midPalette ? PAL[prof.midPalette] : PAL.ganim, R(5));
    const tile = R(34) < (prof.walkTile ?? 0.15) && (m.n === 4 || convex) && spec.floors <= 5;
    if (tile) { spec.roof = 'hip'; spec.roofColour = pick(ROOF_TILE, R(11)); spec.solar = 0; }
    spec.stairBox = false;
    spec.walkup = {
      core: R(31) < 0.75, coreColour: pick(PAL[prof.palette + 'Core'] || PAL.ganimCore, R(39)),
      enclosures: R(32) < 0.7 ? 1 + Math.floor(R(33) * 3) : 0, encFrom: 1 + Math.floor(R(40) * 2), encColour: pick(PAL.enclosure, R(41)),
      roofRoom: !tile && ((extra && extra.roofRooms) || R(35) < 0.25), roomTile: R(42) < 0.35,
      garden: spec.ground !== GROUND.pilotis && R(43) < 0.8, gardenColour: pick([0xd9c9a3, 0xe8e0cf, 0xcdbb94, 0xeeeae0], R(44)),
    };
  }
  // Industrial lots: yard, dock, fence, pallets, rooftop units, sign band (round 4).
  if (prof.style && (arch === 'industrial' || arch === 'tiltup' || arch === 'bigbox' || arch === 'showroom' || arch === 'office')) {
    const lot = arch === 'industrial' || arch === 'tiltup' || arch === 'bigbox';
    spec.yard = {
      edges: m.edges, units: Math.max(1, Math.min(6, Math.round(area / 700))),
      dock: lot && area > 500 && R(45) < 0.8, fence: lot && R(46) < 0.75, fenceColour: pick([0x9aa3aa, 0x7f9a86, 0xb8bcbf, 0xc4b48f, 0x8fa3b8], R(47)),
      sign: lot && arch !== 'bigbox' && R(48) < 0.85, signColour: pick(IND_BAND, R(49)),
    };
  }
  // One OSM footprint that is really several towers on a shared podium (heights table).
  if (extra && extra.podium) {
    spec.podium = { floors: extra.podium.podiumStoreys || 2, towers: Math.max(1, extra.podium.towers || 2), ground: GROUND[extra.podium.podiumGround] || null };
    if (spec.roof === 'pyramid' || spec.roof === 'hip') spec.roof = 'flat';
  }
  return spec;
}

// ---------- emitters ----------

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
function mat4(x, y, z, rotY, sx, sy = sx, sz = sx) {
  tmpQ.setFromAxisAngle(yAxis, rotY);
  return tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz)).clone();
}

// Walls of a prism between y0 and y1. `v0` is the storey index at y0 so the shader knows
// which band is the ground floor; `vTop` is the storey count at y1.
// `skip` (optional Set of edge indices): bevel facets, drawn once full height by emitBuilding.
function prism(walls, r, y0, y1, v0, v1, colFn, cell, bayU, skip = null) {
  for (let i = 0; i < r.length; i++) {
    if (skip && skip.has(i)) continue;
    const p = r[i], q = r[(i + 1) % r.length];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const out = [dz / len, 0, -dx / len];
    // Whole bays per wall so glass is never sliced at a corner.
    const nb = Math.max(1, Math.round(len / bayU));
    const [cLow, cHigh] = colFn(i, len);
    // Bevel facets (round 6) are narrower than half a bay: plain wall, sampled from a tile's margin.
    const u0 = len < bayU * 0.45 ? 0.01 : 0, u1 = len < bayU * 0.45 ? 0.01 : nb;
    walls.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]],
      [cLow, cLow, cHigh, cHigh], out, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], cell);
  }
}

// Podium project: a low block on the whole footprint, then `towers` point towers along the
// footprint's long axis, each drawn as an ordinary building lifted onto the podium roof.
function emitPodium(ch, r, c, m, spec, R, haze, seed) {
  const P = spec.podium;
  const base = { ...spec, floors: P.floors, roof: 'flat', balconies: null, stairBox: false, podium: null, solar: 0, ground: P.ground ?? spec.ground };
  const podTop = emitBuilding(ch, r, c, m, base, R, haze, seed);
  const ob = m.obb, n = P.towers, seg = ob.L / n;
  const tw = Math.min(seg * 0.78, ob.W * 0.85), td = Math.min(ob.W * 0.7, 30 * M2U);
  const vx = -ob.uz, vz = ob.ux;
  let top = podTop;
  for (let i = 0; i < n; i++) {
    const t = -ob.L / 2 + seg * (i + 0.5);
    const cx = c[0] + ob.ux * t, cz = c[1] + ob.uz * t;
    if (!inPoly(cx, cz, r)) continue;
    const q = [[cx - ob.ux * tw / 2 - vx * td / 2, cz - ob.uz * tw / 2 - vz * td / 2], [cx + ob.ux * tw / 2 - vx * td / 2, cz + ob.uz * tw / 2 - vz * td / 2],
      [cx + ob.ux * tw / 2 + vx * td / 2, cz + ob.uz * tw / 2 + vz * td / 2], [cx - ob.ux * tw / 2 + vx * td / 2, cz - ob.uz * tw / 2 + vz * td / 2]];
    if (signedArea(q) < 0) q.reverse();
    const qo = obb(q);
    const qm = { ...m, area: Math.abs(signedArea(q)) / (M2U * M2U), W: qo.W, L: qo.L, obb: qo, n: 4, convex: true };
    const ts = { ...spec, floors: Math.max(1, spec.floors - P.floors), podium: null, ground: GROUND.lobby, facets: null, hipRing: null };
    const mark = [ch.walls.p.length, ch.roofs.p.length, ch.solar.length, ch.balcony.length];
    const h = emitBuilding(ch, q, [cx, cz], qm, ts, R, haze, seed);
    seat(ch, mark, podTop - spec.parapet, 0, q, ts, haze);
    top = Math.max(top, podTop - spec.parapet + h);
  }
  return top;
}

function emitBuilding(ch, r, c, m, spec, R, haze, seed) {
  if (spec.podium) return emitPodium(ch, r, c, m, spec, R, haze, seed);
  const { walls, roofs } = ch;
  const tone = (hex, k = 1) => { const cc = col(hex, k); return haze ? cc.lerp(HAZE, 0.45) : cc; };
  const wallC = tone(spec.wall), wallLow = wallC.clone().multiplyScalar(0.86);
  const accC = spec.accent != null ? tone(spec.accent) : null, accLow = accC && accC.clone().multiplyScalar(0.86);
  const n = r.length;

  // Which edges carry the accent colour.
  let accentSet = null;
  if (accC && spec.accentEdges === 'one') {
    let bi = 0, bl = 0;
    for (let i = 0; i < n; i++) { const p = r[i], q = r[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l > bl) { bl = l; bi = i; } }
    accentSet = new Set([bi, (bi + Math.floor(n / 2)) % n]);
  } else if (accC && spec.accentEdges === 'corners') {
    // Short edges (corner returns, stair cores) read as coloured strips on 1990s towers.
    accentSet = new Set();
    let shortLen = 0, perim = 0;
    for (let i = 0; i < n; i++) {
      const p = r[i], q = r[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      perim += l;
      if (l < 6 * M2U) { accentSet.add(i); shortLen += l; }
    }
    // Curvy or many-sided footprints would turn wholly accent-coloured; keep the plaster there.
    if (accentSet.size === 0 || shortLen > perim * 0.3) accentSet = null;
  }
  const bodyCol = (i) => (accentSet && accentSet.has(i) ? [accLow, accC] : [wallLow, wallC]);
  const bayU = spec.bay * M2U;
  const cell = [spec.row, spec.ground, seed];

  const floors = spec.floors;
  const gh = spec.gh, fh = spec.fh;
  let top = floors === 1 ? gh : gh + (floors - 1) * fh;
  // A setback roof turns the last storey into an inset penthouse.
  const setback = spec.roof === 'setback' && floors >= 4;
  const bodyFloors = setback ? floors - 1 : floors;
  const bodyTop = bodyFloors === 1 ? gh : gh + (bodyFloors - 1) * fh;

  // Ground floor band and upper storeys as separate quads so the ground floor can be taller.
  // Bevel facets (round 6) are skipped here and drawn once, full height, after the roof.
  const SK = spec.facets || null;
  // Unbevelled footprint for inner rings (penthouse, crown plant room) and roof props: fewer
  // sides to draw and test, and the bevel never reaches them.
  const r0 = spec.hipRing || r;
  prism(walls, r, 0, gh, 0, 1, spec.groundAccent && accC ? () => [accLow, accC] : bodyCol, cell, bayU, SK);
  if (bodyFloors > 1) prism(walls, r, gh, bodyTop, 1, bodyFloors, bodyCol, cell, bayU, SK);

  const roofC = tone(spec.roofColour, 0.95 + R(13) * 0.08);
  const tris = triangulate(r);
  let colliderTop = bodyTop;
  const parapetCell = [ROW.plain, 0, seed];
  const plainCol = () => [wallLow, wallC];
  const accentBandCol = () => (accC ? [accLow, accC] : [wallLow, wallC]);

  const flatRoof = (ring, y, parH, colFn = plainCol, tr = null) => {
    if (parH > 0) prism(walls, ring, y, y + parH, 0, 0, colFn, parapetCell, 1e9, ring === r ? SK : null);
    fillPoly(roofs, ring, y + 0.03, roofC, tr);
  };

  switch (spec.roof) {
    case 'pyramid': {
      // Founder (2026-10-15): the pyramid is smaller than drawn before. It now sits inside a low
      // parapet on 80% of the roof and rises ~0.3 of that width (~30 degrees), about one storey
      // on a 24 m tower, instead of 0.62 of the full width. Proportion GUESS from the founder's
      // description; no photo yet.
      const y0 = bodyTop + 0.8 * V2U;
      prism(walls, r, bodyTop, y0, 0, 0, plainCol, parapetCell, 1e9, SK);
      fillPoly(roofs, r, y0 - 0.25 * V2U, tone(pick(ROOF_FLAT, R(11))), tris);
      const pr = shrink(r0, c, 0.8);
      const h = Math.max(2.5 * V2U, Math.min(m.W * 0.8 * 0.3, 7 * M2U) * VEX);
      const apex = [c[0], y0 + h, c[1]];
      for (let i = 0; i < pr.length; i++) {
        const p = pr[i], q = pr[(i + 1) % pr.length];
        const mid = [(p[0] + q[0]) / 2 - c[0], 0.6, (p[1] + q[1]) / 2 - c[1]];
        const shade = 0.92 + 0.12 * Math.max(0, (mid[0] * 0.4 - mid[2] * 0.6) / (Math.hypot(mid[0], mid[2]) || 1));
        roofs.tri([p[0], y0 - 0.25 * V2U, p[1]], [q[0], y0 - 0.25 * V2U, q[1]], apex, roofC.clone().multiplyScalar(shade), mid);
      }
      colliderTop = y0;
      break;
    }
    case 'penthouse': {
      // Neot Ashlim roofs: terrace with a parapet, a glazed roof room (teal glass from the atlas
      // glass row) and a flat canopy reaching past it (Mapillary 769716300409432).
      flatRoof(r, bodyTop, 1.0 * V2U, plainCol, tris);
      const pr = shrink(r0, c, 0.55);
      const pTop = bodyTop + fh * 0.95;
      prism(walls, pr, bodyTop, pTop, 1, 2, accentBandCol, [ROW.glass, 0, seed], bayU);
      const cr = shrink(r0, c, 0.68);
      const ct = triangulate(cr);
      fillPoly(roofs, cr, pTop + 0.04, roofC, ct);
      for (const t of ct) { // canopy soffit, seen from the street
        const a = cr[t[0]], b = cr[t[1]], d = cr[t[2]];
        roofs.tri([a[0], pTop, a[1]], [b[0], pTop, b[1]], [d[0], pTop, d[1]], roofC.clone().multiplyScalar(0.75), [0, -1, 0]);
      }
      top = pTop;
      colliderTop = bodyTop + 1.0 * V2U;
      break;
    }
    case 'box': {
      // Big box: tall fascia in the brand colour, flat metal roof with skylight strips.
      prism(walls, r, bodyTop, bodyTop + spec.parapet, 0, 0, accentBandCol, parapetCell, 1e9, SK);
      fillPoly(roofs, r, bodyTop + 0.03, roofC, tris);
      addSkylights(roofs, c, m, bodyTop);
      colliderTop = bodyTop + spec.parapet;
      break;
    }
    case 'hip': {
      const eave = 0.45 * M2U;
      // The hip is laid out on the unbevelled footprint (round 6 bevels the walls only).
      const rr = (spec.hipRing || r).map((p) => { const dx = p[0] - c[0], dz = p[1] - c[1], l = Math.hypot(dx, dz) || 1; return [p[0] + (dx / l) * eave, p[1] + (dz / l) * eave]; });
      const y0 = top;
      const pitch = 0.5; // ~27 degrees, the usual pitch of Mediterranean clay-tile roofs
      if (rr.length === 4) {
        // Hip roof with a ridge along the long axis.
        let li = 0;
        const el = (i) => Math.hypot(rr[(i + 1) % 4][0] - rr[i][0], rr[(i + 1) % 4][1] - rr[i][1]);
        if (el(1) > el(0)) li = 1;
        const Lr = (el(li) + el(li + 2)) / 2, Wr = (el(li + 1) + el((li + 3) % 4)) / 2;
        const ux = (rr[(li + 1) % 4][0] - rr[li][0]) / el(li), uz = (rr[(li + 1) % 4][1] - rr[li][1]) / el(li);
        const cc = [(rr[0][0] + rr[1][0] + rr[2][0] + rr[3][0]) / 4, (rr[0][1] + rr[1][1] + rr[2][1] + rr[3][1]) / 4];
        const half = Math.max(0, (Lr - Wr) / 2);
        const h = (Wr / 2) * pitch * VEX;
        const R0 = [cc[0] - ux * half, y0 + h, cc[1] - uz * half], R1 = [cc[0] + ux * half, y0 + h, cc[1] + uz * half];
        const P = (i) => [rr[i % 4][0], y0, rr[i % 4][1]];
        const a = li, b = li + 1, cI = li + 2, d = li + 3;
        const sh = (k) => roofC.clone().multiplyScalar(k);
        const upOf = (pts) => { const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length - cc[0], mz = pts.reduce((s, p) => s + p[2], 0) / pts.length - cc[1]; return [mx, 1, mz]; };
        roofs.quad(P(a), P(b), R1, R0, sh(1.0), upOf([P(a), P(b)]));
        roofs.quad(P(cI), P(d), R0, R1, sh(0.9), upOf([P(cI), P(d)]));
        roofs.tri(P(b), P(cI), R1, sh(0.96), upOf([P(b), P(cI)]));
        roofs.tri(P(d), P(a), R0, sh(0.93), upOf([P(d), P(a)]));
        // Soffit so the overhang is not see-through from below.
        fillPoly(roofs, rr, y0 - 0.02, roofC.clone().multiplyScalar(0.7));
        colliderTop = y0;
      } else {
        const h = Math.min(m.W * 0.5, 8 * M2U) * pitch * VEX;
        const apex = [c[0], y0 + h, c[1]];
        for (let i = 0; i < rr.length; i++) {
          const p = rr[i], q = rr[(i + 1) % rr.length];
          roofs.tri([p[0], y0, p[1]], [q[0], y0, q[1]], apex, roofC, [(p[0] + q[0]) / 2 - c[0], 1, (p[1] + q[1]) / 2 - c[1]]);
        }
        colliderTop = y0;
      }
      break;
    }
    case 'setback': {
      // Terrace roof over the body with a low parapet, then an inset penthouse storey.
      flatRoof(r, bodyTop, 1.0 * V2U, plainCol, tris);
      const pr = shrink(r0, c, 0.68);
      const pTop = bodyTop + fh;
      prism(walls, pr, bodyTop, pTop, bodyFloors, bodyFloors + 1, bodyCol, cell, bayU);
      flatRoof(pr, pTop, 0.7 * V2U, accentBandCol);
      top = pTop;
      colliderTop = bodyTop + 1.0 * V2U;
      if (spec.solar) addSolar(ch, pr, pTop, spec.solar * 0.6, R);
      break;
    }
    case 'crown': {
      // Tall coloured parapet hides the plant room: the signature top of newer towers.
      const crownH = Math.min(2.2 * fh, 9 * V2U);
      prism(walls, r, bodyTop, bodyTop + crownH, 0, 0, spec.crownPlain ? plainCol : accentBandCol, parapetCell, 1e9, SK);
      fillPoly(roofs, r, bodyTop + 0.03, roofC, tris);
      // Plant room box inside the crown.
      const pr = shrink(r0, c, 0.45);
      prism(walls, pr, bodyTop, bodyTop + crownH * 0.8, 0, 0, plainCol, parapetCell, 1e9);
      fillPoly(roofs, pr, bodyTop + crownH * 0.8, roofC.clone().multiplyScalar(0.92));
      colliderTop = bodyTop + crownH;
      break;
    }
    case 'skirt': {
      // Flat roof hidden behind a tiled band sloping up from an eave all round (the common Israeli
      // "tile skirt" on houses whose footprint is too irregular for a hip roof). Mitred per vertex.
      const eave = 0.4 * M2U, w = Math.min(1.4 * M2U, m.W * 0.22), rise = w * 0.55 * VEX;
      const outer = offsetRing(r, eave), inner = offsetRing(r, -w);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, a = outer[i], b = outer[j], ci = inner[j], d = inner[i];
        const p = r[i], q = r[j], ex = q[0] - p[0], ez = q[1] - p[1], el = Math.hypot(ex, ez) || 1;
        const shade = 0.9 + 0.1 * Math.max(-1, Math.min(1, (ez / el) * 0.8 - (ex / el) * 0.2));
        roofs.quad([a[0], bodyTop, a[1]], [b[0], bodyTop, b[1]], [ci[0], bodyTop + rise, ci[1]], [d[0], bodyTop + rise, d[1]],
          roofC.clone().multiplyScalar(shade), [ez / el, 1.2, -ex / el]);
      }
      fillPoly(roofs, outer, bodyTop - 0.02, roofC.clone().multiplyScalar(0.7)); // eave soffit
      fillPoly(roofs, r, bodyTop + rise * 0.6, tone(pick(ROOF_FLAT, R(11))), tris);
      colliderTop = bodyTop + rise;
      break;
    }
    case 'shed': {
      flatRoof(r, bodyTop, spec.parapet, plainCol, tris);
      addSkylights(roofs, c, m, bodyTop);
      colliderTop = bodyTop + spec.parapet;
      break;
    }
    default: {
      flatRoof(r, bodyTop, spec.parapet, spec.arch === 'commercial' ? accentBandCol : plainCol, tris);
      colliderTop = bodyTop + spec.parapet;
    }
  }

  // Bevel facets, one plain quad from the ground to the parapet/crown top.
  if (SK) {
    const ft = Math.max(colliderTop, bodyTop);
    for (const i of SK) {
      const p = r[i], q = r[(i + 1) % n], dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
      const [cLow, cHigh] = bodyCol(i, l);
      walls.quad([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], ft, q[1]], [p[0], ft, p[1]], [cLow, cLow, cHigh, cHigh], [dz / l, 0, -dx / l], null, [ROW.plain, 0, seed]);
    }
  }

  // Rooftop stair/lift room: every Israeli walk-up roof has one.
  if (spec.stairBox && (spec.roof === 'flat' || spec.roof === 'setback' || spec.roof === 'shed') && m.W > 7 * M2U) {
    const ob = m.obb;
    const roofY = spec.roof === 'setback' ? top : bodyTop;
    const bw = 3.2 * M2U, bd = 4.2 * M2U, bh = 2.6 * V2U;
    const off = (R(14) - 0.5) * Math.max(0, ob.L - bd * 2) * 0.6;
    const bx = c[0] + ob.ux * off, bz = c[1] + ob.uz * off;
    const vx = -ob.uz, vz = ob.ux;
    const box = [[bx - ob.ux * bd / 2 - vx * bw / 2, bz - ob.uz * bd / 2 - vz * bw / 2], [bx + ob.ux * bd / 2 - vx * bw / 2, bz + ob.uz * bd / 2 - vz * bw / 2],
      [bx + ob.ux * bd / 2 + vx * bw / 2, bz + ob.uz * bd / 2 + vz * bw / 2], [bx - ob.ux * bd / 2 + vx * bw / 2, bz - ob.uz * bd / 2 + vz * bw / 2]];
    if (signedArea(box) < 0) box.reverse();
    if (box.every((p) => inPoly(p[0], p[1], spec.roof === 'setback' ? shrink(r0, c, 0.68) : r))) {
      prism(walls, box, roofY, roofY + bh, 0, 0, plainCol, parapetCell, 1e9);
      fillPoly(roofs, box, roofY + bh, roofC.clone().multiplyScalar(0.9));
    }
  }

  // Solar heaters on flat roofs, in rows facing south.
  if (spec.solar > 0 && (spec.roof === 'flat' || spec.roof === 'shed' || spec.roof === 'skirt')) addSolar(ch, r0, spec.roof === 'skirt' ? bodyTop + 0.3 * V2U : bodyTop, spec.solar * (spec.floors >= 3 ? Math.min(2.2, spec.floors / 3) : 1), R);

  if (spec.balconies && bodyFloors >= 2) addBalconies(ch, r, spec, bodyFloors, R, haze);

  if (spec.walkup) addWalkupParts(ch, r, c, m, spec, R, haze, seed, bodyTop, tone, wallC);
  if (spec.yard) addIndustrialParts(ch, r, c, m, spec, R, haze, bodyTop, tone);
  if (spec.yardWall) addYardWall(ch, r, spec, R, seed, tone);

  return colliderTop;
}

// Oriented box (centre, unit axis u, half sizes a along u and b across, y0..y1) into an Acc.
// Walls Acc boxes get a window cell; roofs Acc boxes are plain vertex colour.
function box(acc, cx, cz, ux, uz, a, b, y0, y1, colSide, colTop, cell = null, bayU = 1e9) {
  const vx = -uz, vz = ux;
  const q = [[cx - ux * a - vx * b, cz - uz * a - vz * b], [cx + ux * a - vx * b, cz + uz * a - vz * b],
    [cx + ux * a + vx * b, cz + uz * a + vz * b], [cx - ux * a + vx * b, cz - uz * a + vz * b]];
  if (signedArea(q) < 0) q.reverse();
  if (cell) prism(acc, q, y0, y1, cell[3] || 0, cell[4] || 0, () => [colSide.clone().multiplyScalar(0.86), colSide], cell, bayU);
  else for (let i = 0; i < 4; i++) {
    const p = q[i], r = q[(i + 1) % 4];
    acc.quad([p[0], y0, p[1]], [r[0], y0, r[1]], [r[0], y1, r[1]], [p[0], y1, p[1]], colSide.clone().multiplyScalar(i % 2 ? 0.86 : 1), [r[1] - p[1], 0, p[0] - r[0]]);
  }
  return q;
}

// Kiryat Ganim walk-ups (round 4): entrance stair core, enclosed-balcony stacks (sgirat
// mirpeset), a roof add-on room and a low garden wall, so neighbouring blocks stop looking cloned.
// Storeys and roof rooms per address come from listings (data/building_heights.json); the forms
// themselves are the standard Israeli 1970s-90s walk-up kit, INFERRED: no street imagery exists
// inside Kiryat Ganim (Mapillary only on its edge roads, checked 2026-10-15).
function addWalkupParts(ch, r, c, m, spec, R, haze, seed, bodyTop, tone, wallC) {
  const W = spec.walkup, n = r.length;
  const edges = [];
  for (let i = 0; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; edges.push([Math.hypot(q[0] - p[0], q[1] - p[1]), i]); }
  edges.sort((a, b) => b[0] - a[0]);
  const along = (i, t) => { const p = r[i], q = r[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]); return { x: p[0] + (q[0] - p[0]) * t, z: p[1] + (q[1] - p[1]) * t, ux: (q[0] - p[0]) / l, uz: (q[1] - p[1]) / l, nx: (q[1] - p[1]) / l, nz: -(q[0] - p[0]) / l, l }; };
  const fh = spec.fh, gh = spec.gh;
  // Stair core: a shaft standing proud of the entrance facade, one storey above the roof.
  let coreEdge = -1;
  if (W.core && edges[0][0] > 9 * M2U) {
    coreEdge = edges[0][1]; part('stairCore');
    const e = along(coreEdge, 0.5), d = 1.4 * M2U;
    const coreC = tone(W.coreColour);
    box(ch.walls, e.x + e.nx * d / 2, e.z + e.nz * d / 2, e.ux, e.uz, 1.6 * M2U, d / 2, 0, bodyTop + fh * 0.9, coreC, null, [ROW.shikun, GROUND.lobby, seed, 0, spec.floors + 1], 1.6 * M2U);
    const cap = box(ch.roofs, e.x + e.nx * d / 2, e.z + e.nz * d / 2, e.ux, e.uz, 1.75 * M2U, d / 2 + 0.15 * M2U, bodyTop + fh * 0.9, bodyTop + fh * 0.9 + 0.25 * V2U, coreC.clone().multiplyScalar(0.9));
    quadTop(ch.roofs, cap, bodyTop + fh * 0.9 + 0.25 * V2U, coreC.clone().multiplyScalar(0.95));
  }
  // Enclosed balconies: aluminium-and-glass boxes stacked on the long facade (not the core one).
  if (W.enclosures && spec.floors >= 3) {
    const ei = edges[1] && edges[1][0] > 9 * M2U && edges[1][1] !== coreEdge ? edges[1][1] : edges[0][1];
    const encC = tone(W.encColour);
    for (let k = 0; k < W.enclosures; k++) {
      const t = (k + 0.5) / W.enclosures;
      const e = along(ei, t);
      if (ei === coreEdge && Math.abs(t - 0.5) < 0.2) continue;
      const d = 1.3 * M2U, y0 = gh + fh * (W.encFrom - 1), y1 = bodyTop - 0.05;
      if (y1 - y0 < fh * 0.9) continue;
      part('enclosure');
      box(ch.walls, e.x + e.nx * d / 2, e.z + e.nz * d / 2, e.ux, e.uz, 1.7 * M2U, d / 2, y0, y1, encC, null, [ROW.mid, 0, seed, W.encFrom, spec.floors], 3.4 * M2U);
      const top = box(ch.roofs, e.x + e.nx * d / 2, e.z + e.nz * d / 2, e.ux, e.uz, 1.7 * M2U, d / 2, y1, y1 + 0.02, encC);
      quadTop(ch.roofs, top, y1 + 0.02, encC.clone().multiplyScalar(0.9));
    }
  }
  // Roof add-on room ("roof penthouse" in the listings) at one end of the roof.
  if (W.roofRoom && spec.roof !== 'hip' && m.obb.L > 10 * M2U) {
    const ob = m.obb, sgn = R(36) < 0.5 ? -1 : 1, len = ob.L * 0.38, wid = ob.W * 0.7;
    const cx = c[0] + ob.ux * sgn * (ob.L / 2 - len / 2 - 0.8 * M2U), cz = c[1] + ob.uz * sgn * (ob.L / 2 - len / 2 - 0.8 * M2U);
    if (inPoly(cx, cz, r)) {
      part('roofRoom');
      const y0 = bodyTop, y1 = bodyTop + fh;
      const q = box(ch.walls, cx, cz, ob.ux, ob.uz, len / 2, wid / 2, y0, y1, wallC, null, [ROW.mid, 0, seed, spec.floors, spec.floors + 1], 3.6 * M2U);
      if (W.roomTile) {
        const rc = tone(pick(ROOF_TILE, R(37)));
        const ridgeH = Math.min(wid, len) * 0.28 * VEX;
        const a = [cx - ob.ux * len / 2, y1 + ridgeH, cz - ob.uz * len / 2], b = [cx + ob.ux * len / 2, y1 + ridgeH, cz + ob.uz * len / 2];
        const vx = -ob.uz, vz = ob.ux, hw = wid / 2 + 0.3 * M2U, hl = len / 2 + 0.3 * M2U;
        const P = (su, sv) => [cx + ob.ux * hl * su + vx * hw * sv, y1, cz + ob.uz * hl * su + vz * hw * sv];
        ch.roofs.quad(P(-1, -1), P(1, -1), b, a, rc, [vx * -1, 1, vz * -1]);
        ch.roofs.quad(P(1, 1), P(-1, 1), a, b, rc.clone().multiplyScalar(0.9), [vx, 1, vz]);
        ch.roofs.tri(P(-1, 1), P(-1, -1), a, rc.clone().multiplyScalar(0.95), [-ob.ux, 0.3, -ob.uz]);
        ch.roofs.tri(P(1, -1), P(1, 1), b, rc.clone().multiplyScalar(0.95), [ob.ux, 0.3, ob.uz]);
      } else quadTop(ch.roofs, q, y1 + 0.03, tone(pick(ROOF_FLAT, R(38))));
    }
  }
  // Garden wall around the ground-floor flats, with a gap at the entrance.
  if (W.garden) {
    part('gardenWall');
    const off = 1.8 * M2U, h = 1.1 * V2U, gc = tone(W.gardenColour), gl = gc.clone().multiplyScalar(0.85);
    for (let i = 0; i < n; i++) {
      const p = r[i], q = r[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l < 2 * M2U) continue;
      const nx = (q[1] - p[1]) / l, nz = -(q[0] - p[0]) / l, ux = (q[0] - p[0]) / l, uz = (q[1] - p[1]) / l;
      const a = [p[0] + nx * off - ux * off, p[1] + nz * off - uz * off], b = [q[0] + nx * off + ux * off, q[1] + nz * off + uz * off];
      const segs = i === coreEdge || (coreEdge < 0 && i === edges[0][1])
        ? [[0, 0.5 - 2 * M2U / l], [0.5 + 2 * M2U / l, 1]] : [[0, 1]];
      for (const [t0, t1] of segs) {
        if (t1 <= t0) continue;
        const A = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], B = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
        // Round 6: no garden wall on a sidewalk, a carriageway or a neighbour's footprint.
        if (!SITE.ok(A[0], A[1]) || !SITE.ok(B[0], B[1]) || !SITE.ok((A[0] + B[0]) / 2, (A[1] + B[1]) / 2)) continue;
        ch.walls.quad([A[0], 0, A[1]], [B[0], 0, B[1]], [B[0], h, B[1]], [A[0], h, A[1]], [gl, gl, gc, gc], [nx, 0, nz], null, [ROW.plain, 0, seed]);
        ch.roofs.quad([A[0], h, A[1]], [B[0], h, B[1]], [B[0] - nx * 0.25 * M2U, h, B[1] - nz * 0.25 * M2U], [A[0] - nx * 0.25 * M2U, h, A[1] - nz * 0.25 * M2U], gc, UP);
      }
    }
  }
}

// Industrial lots (round 4): loading dock with canopy on a side street, fenced yard with pallet
// stacks, rooftop plant units and a sign band. Corrugated-metal yard fences are VERIFIED by
// photo (Mapillary 527840945041701 old zone, 1351990215598989 west zone); the dock, pallet and
// rooftop-unit layout is INFERRED (standard light-industrial lot; no interior imagery).
function addIndustrialParts(ch, r, c, m, spec, R, haze, bodyTop, tone) {
  const Y = spec.yard, n = r.length, edges = Y.edges || [];
  const list = [];
  for (let i = 0; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; list.push({ i, l: Math.hypot(q[0] - p[0], q[1] - p[1]), e: edges[i] || { front: false, clear: 0 } }); }
  const E = (i, t) => { const p = r[i], q = r[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]); return { x: p[0] + (q[0] - p[0]) * t, z: p[1] + (q[1] - p[1]) * t, ux: (q[0] - p[0]) / l, uz: (q[1] - p[1]) / l, nx: (q[1] - p[1]) / l, nz: -(q[0] - p[0]) / l, l }; };
  const metal = tone(0xa9b0b5), concrete = tone(0xc9c4b8);
  // Rooftop plant: grey boxes along the roof's long axis.
  const ob = m.obb;
  for (let k = 0; k < Y.units; k++) {
    const t = (R(60 + k) - 0.5) * ob.L * 0.7, v = (R(70 + k) - 0.5) * ob.W * 0.5;
    const x = c[0] + ob.ux * t - ob.uz * v, z = c[1] + ob.uz * t + ob.ux * v;
    if (!inPoly(x, z, r)) continue;
    const y0 = bodyTop + 0.05, y1 = y0 + 1.3 * V2U;
    const q = box(ch.roofs, x, z, ob.ux, ob.uz, 1.2 * M2U, 0.7 * M2U, y0, y1, metal);
    quadTop(ch.roofs, q, y1, metal.clone().multiplyScalar(0.8));
  }
  // Side-street edges with room in front of them, roomiest first.
  const back = list.filter((o) => !o.e.front && o.l > 10 * M2U && o.e.clear >= 6).sort((a, b) => b.e.clear - a.e.clear || b.l - a.l);
  // Loading dock: raised concrete apron and a steel canopy over the roller doors.
  if (Y.dock && back.length) {
    const e = E(back[0].i, 0.5), half = back[0].l * 0.3, d = 3.2 * M2U;
    part('dock');
    const q = box(ch.roofs, e.x + e.nx * d / 2, e.z + e.nz * d / 2, e.ux, e.uz, half, d / 2, 0, 1.2 * V2U, concrete);
    quadTop(ch.roofs, q, 1.2 * V2U, concrete.clone().multiplyScalar(0.92));
    const cy = Math.min(bodyTop - 0.3 * V2U, 5 * V2U), cd = 3.8 * M2U;
    const cq = box(ch.roofs, e.x + e.nx * cd / 2, e.z + e.nz * cd / 2, e.ux, e.uz, half + 0.6 * M2U, cd / 2, cy, cy + 0.3 * V2U, metal);
    quadTop(ch.roofs, cq, cy + 0.3 * V2U, metal.clone().multiplyScalar(0.9));
    quadTop(ch.roofs, cq, cy, metal.clone().multiplyScalar(0.7), [0, -1, 0]);
  }
  // Fenced yard behind the building, with pallet stacks along the fence.
  if (Y.fence && back.length) {
    const o = back[Y.dock && back.length > 1 ? 1 : 0];
    const dm = Math.min(7, o.e.clear - 2);
    if (dm >= 3) {
      part('yard');
      const e0 = E(o.i, 0), e1 = E(o.i, 1), d = dm * M2U, h = 2.2 * V2U;
      const fc = tone(Y.fenceColour), fl = fc.clone().multiplyScalar(0.8);
      const pts = [[e0.x, e0.z], [e0.x + e0.nx * d, e0.z + e0.nz * d], [e1.x + e0.nx * d, e1.z + e0.nz * d], [e1.x, e1.z]];
      for (let s = 0; s < 3; s++) {
        const A = pts[s], B = pts[s + 1], l = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (l < 0.5) continue;
        ch.walls.quad([A[0], 0, A[1]], [B[0], 0, B[1]], [B[0], h, B[1]], [A[0], h, A[1]], [fl, fl, fc, fc], [B[1] - A[1], 0, A[0] - B[0]],
          [[0, 0], [l / (1.4 * M2U), 0], [l / (1.4 * M2U), 0.99], [0, 0.99]], [ROW.industrial, 0, 0]);
      }
      const nP = Math.min(6, Math.max(2, Math.floor(o.l / (8 * M2U))));
      for (let k = 0; k < nP; k++) {
        const e = E(o.i, (k + 0.6) / (nP + 0.2));
        const x = e.x + e.nx * d * 0.62, z = e.z + e.nz * d * 0.62, hgt = (0.5 + R(80 + k) * 1.1) * V2U;
        const pc = tone(R(90 + k) < 0.7 ? 0xb08a5a : 0x3a6fb0);
        const q = box(ch.roofs, x, z, e.ux, e.uz, 0.65 * M2U, 0.55 * M2U, 0, hgt, pc);
        quadTop(ch.roofs, q, hgt, pc.clone().multiplyScalar(0.9));
      }
    }
  }
  // Sign band high on the street facade.
  if (Y.sign) {
    const fr = list.filter((o) => o.l > 10 * M2U).sort((a, b) => (b.e.front - a.e.front) || (a.e.clear - b.e.clear) || b.l - a.l)[0];
    if (fr) {
      part('sign');
      const e = E(fr.i, 0.5), half = Math.min(fr.l * 0.28, 14 * M2U), y0 = Math.max(1.2 * V2U, bodyTop - 2.6 * V2U), y1 = bodyTop - 0.9 * V2U;
      const sc = tone(Y.signColour), off = 0.12 * M2U;
      const A = [e.x - e.ux * half + e.nx * off, e.z - e.uz * half + e.nz * off], B = [e.x + e.ux * half + e.nx * off, e.z + e.uz * half + e.nz * off];
      ch.roofs.quad([A[0], y0, A[1]], [B[0], y0, B[1]], [B[0], y1, B[1]], [A[0], y1, A[1]], sc, [e.nx, 0, e.nz]);
      const w = tone(0xf7f7f2), hm = (y1 - y0) * 0.3, hh = half * 0.75, o2 = 0.2 * M2U;
      const C = [e.x - e.ux * hh + e.nx * o2, e.z - e.uz * hh + e.nz * o2], D = [e.x + e.ux * hh + e.nx * o2, e.z + e.uz * hh + e.nz * o2];
      ch.roofs.quad([C[0], y0 + hm, C[1]], [D[0], y0 + hm, D[1]], [D[0], y1 - hm, D[1]], [C[0], y1 - hm, C[1]], w, [e.nx, 0, e.nz]);
    }
  }
}
// Entrance recess for a footbridge deck (PASSAGES). Returns { ring, door } or null when the deck
// does not touch this footprint or the cut would not leave a simple polygon.
function cutPassage(r, P, why = null) {
  const [A, B] = P.pts, n = r.length;
  const dl = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, dx = (B[0] - A[0]) / dl, dz = (B[1] - A[1]) / dl;
  // Deck corridor corners.
  const C = [[A, -1], [A, 1], [B, -1], [B, 1]].map(([p, sgn]) => [p[0] - dz * P.halfW * sgn, p[1] + dx * P.halfW * sgn]);
  const insideA = inPoly(A[0], A[1], r), insideB = inPoly(B[0], B[1], r);
  const segX = (p, q, a, b) => { // segment intersection parameter on p-q, or null
    const r1x = q[0] - p[0], r1z = q[1] - p[1], r2x = b[0] - a[0], r2z = b[1] - a[1], den = r1x * r2z - r1z * r2x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((a[0] - p[0]) * r2z - (a[1] - p[1]) * r2x) / den, u = ((a[0] - p[0]) * r1z - (a[1] - p[1]) * r1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  };
  let ei = -1;
  if (insideA !== insideB) {
    for (let i = 0; i < n; i++) if (segX(r[i], r[(i + 1) % n], A, B) != null) { ei = i; break; }
  } else if (insideA && insideB) {
    const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
    // A wall the deck runs along (parallel within ~25 degrees, within 12 m) that spans most of the
    // deck, else the nearest wall. Score = deck length covered by the wall, then distance.
    let best = Infinity, bestScore = -Infinity, bi = -1, bp = -1;
    for (let i = 0; i < n; i++) {
      const p = r[i], q = r[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l < 3 * M2U) continue;
      const d = segDist(mx, mz, [p[0], p[1], q[0], q[1]]);
      if (d < best) { best = d; bi = i; }
      const ux = (q[0] - p[0]) / l, uz = (q[1] - p[1]) / l;
      if (Math.abs(ux * dx + uz * dz) < 0.9 || d > 12 * M2U) continue;
      const ta = (A[0] - p[0]) * ux + (A[1] - p[1]) * uz, tb = (B[0] - p[0]) * ux + (B[1] - p[1]) * uz;
      const cover = Math.max(0, Math.min(l, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)));
      const score = cover - d * 0.01;
      if (score > bestScore) { bestScore = score; bp = i; }
    }
    ei = bp >= 0 ? bp : bi;
  }
  if (why) why.push(['edge', ei, insideA, insideB]);
  if (ei < 0) return null;
  const p = r[ei], q = r[(ei + 1) % n], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const ux = (q[0] - p[0]) / len, uz = (q[1] - p[1]) / len, ix = -uz, iz = ux; // inward for a CCW ring
  let t0 = Infinity, t1 = -Infinity, depth = 0;
  for (const k of C) {
    const t = (k[0] - p[0]) * ux + (k[1] - p[1]) * uz, d = (k[0] - p[0]) * ix + (k[1] - p[1]) * iz;
    t0 = Math.min(t0, t); t1 = Math.max(t1, t); depth = Math.max(depth, d);
  }
  t0 = Math.max(0.3 * M2U, t0 - 0.5 * M2U); t1 = Math.min(len - 0.3 * M2U, t1 + 0.5 * M2U);
  depth = Math.max(2 * M2U, depth + 0.8 * M2U);
  if (why) why.push(['span', t0, t1, depth]);
  if (t1 - t0 < 2 * M2U) return null;
  const P0 = [p[0] + ux * t0, p[1] + uz * t0], P1 = [p[0] + ux * t1, p[1] + uz * t1];
  const Q0 = [P0[0] + ix * depth, P0[1] + iz * depth], Q1 = [P1[0] + ix * depth, P1[1] + iz * depth];
  const ring = [...r.slice(0, ei + 1), P0, Q0, Q1, P1, ...r.slice(ei + 1)];
  // Reject a cut that crosses another wall (non-simple ring).
  const m = ring.length;
  for (let i = 0; i < m; i++) for (let j = i + 2; j < m; j++) {
    if (i === 0 && j === m - 1) continue;
    if (segX(ring[i], ring[(i + 1) % m], ring[j], ring[(j + 1) % m]) != null) {
      const a = ring[i], b = ring[(i + 1) % m], c = ring[j], d = ring[(j + 1) % m];
      const shared = [c, d].some((v) => Math.hypot(v[0] - a[0], v[1] - a[1]) < 1e-6 || Math.hypot(v[0] - b[0], v[1] - b[1]) < 1e-6);
      if (!shared) { if (why) why.push(['cross', i, j]); return null; }
    }
  }
  if (signedArea(ring) <= 0) return null;
  return { ring, door: { Q0, Q1, P0, P1, ix, iz } };
}

// Glazed door on the back wall of a footbridge recess and a canopy over its mouth, at deck level.
function addPassageDoor(ch, D, top, seed) {
  const y0 = D.deckU, y1 = Math.min(top - 0.3 * V2U, y0 + 2.7 * V2U), yc = Math.min(top - 0.2 * V2U, y0 + 3.3 * V2U);
  if (y1 - y0 < 1.5 * V2U) return;
  part('passage');
  const off = 0.06 * M2U, nx = -D.ix, nz = -D.iz; // door faces back out of the recess
  const bx = D.Q1[0] - D.Q0[0], bz = D.Q1[1] - D.Q0[1], bl = Math.hypot(bx, bz), ux = bx / bl, uz = bz / bl;
  const w = Math.min(bl - 0.6 * M2U, 3.2 * M2U), cx = (D.Q0[0] + D.Q1[0]) / 2 + nx * off, cz = (D.Q0[1] + D.Q1[1]) / 2 + nz * off;
  const frame = col(0x3a4650), glass = col(0x35607a), lit = col(0x7fb2cc);
  const q = (hw, ya, yb, k) => ch.walls.quad([cx - ux * hw, ya, cz - uz * hw], [cx + ux * hw, ya, cz + uz * hw], [cx + ux * hw, yb, cz + uz * hw], [cx - ux * hw, yb, cz - uz * hw], k, [nx, 0, nz], null, [ROW.plain, 0, seed]);
  q(w / 2 + 0.25 * M2U, y0, y1 + 0.25 * V2U, frame);
  ch.walls.quad([cx - ux * w / 2 + nx * off, y0, cz - uz * w / 2 + nz * off], [cx + ux * w / 2 + nx * off, y0, cz + uz * w / 2 + nz * off],
    [cx + ux * w / 2 + nx * off, y1, cz + uz * w / 2 + nz * off], [cx - ux * w / 2 + nx * off, y1, cz - uz * w / 2 + nz * off], [glass, glass, lit, lit], [nx, 0, nz], null, [ROW.plain, 0, seed]);
  // Canopy across the recess mouth, reaching 1.2 m out over the deck.
  const ext = 1.2 * M2U, A0 = D.P0, A1 = D.P1, B1 = D.Q1, B0 = D.Q0;
  const cap = col(0xe8e6e0);
  const c4 = [[B0[0], yc, B0[1]], [B1[0], yc, B1[1]], [A1[0] + nx * ext, yc, A1[1] + nz * ext], [A0[0] + nx * ext, yc, A0[1] + nz * ext]];
  ch.roofs.quad(c4[0], c4[1], c4[2], c4[3], cap, UP);
  ch.roofs.quad(c4[0], c4[1], c4[2], c4[3], cap.clone().multiplyScalar(0.7), [0, -1, 0]);
}

// Corner bevel per archetype in metres (round 6, founder item 21 "less square, more rounded").
// Industrial boxes keep crisp corners. Bevels of 1 m+ (towers) get two facets, a coarse fillet.
// Only outside (convex) corners are cut, and houses keep square corners: a 0.35 m bevel does not
// read at play distance but doubled their wall and roof triangles (measured 2026-10-18).
const BEVEL_M = { tower90: 1.4, towerNew: 1.6, office: 1.0, mid: 0.8, shikun: 0.6, centre: 0.5, public: 0.6 };
const BEVEL_MIN_M2 = { shikun: 200, centre: 150 };
function bevelRing(r, b) {
  const n = r.length, out = [], facets = new Set();
  for (let i = 0; i < n; i++) {
    const a = r[(i + n - 1) % n], p = r[i], q = r[(i + 1) % n];
    const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]), l2 = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l1 < 1e-6 || l2 < 1e-6) { out.push(p); continue; }
    const u1x = (p[0] - a[0]) / l1, u1z = (p[1] - a[1]) / l1, u2x = (q[0] - p[0]) / l2, u2z = (q[1] - p[1]) / l2;
    if (u1x * u2x + u1z * u2z > 0.94) { out.push(p); continue; } // nearly straight: no corner to round
    if (u1x * u2z - u1z * u2x <= 0) { out.push(p); continue; } // inside corner: left square
    const d = Math.min(b, l1 * 0.3, l2 * 0.3);
    if (d < 0.15 * M2U) { out.push(p); continue; }
    facets.add(out.length);
    out.push([p[0] - u1x * d, p[1] - u1z * d]);
    if (d >= 1.0 * M2U) { facets.add(out.length); out.push([p[0] + (u2x - u1x) * d * 0.293, p[1] + (u2z - u1z) * d * 0.293]); }
    out.push([p[0] + u2x * d, p[1] + u2z * d]);
  }
  return { ring: out, facets };
}

// True when no two non-adjacent edges of the ring cross.
function simpleRing(r) {
  const n = r.length;
  const cross = (a, b, c, d) => {
    const o = (p, q, s) => Math.sign((q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]));
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  };
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (cross(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) return false;
  }
  return true;
}

// Ring offset along mitred vertex normals (d > 0 outward, < 0 inward); miters capped at 3x so
// sharp concave corners do not shoot across the roof.
function offsetRing(r, d) {
  const n = r.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = r[(i + n - 1) % n], p = r[i], b = r[(i + 1) % n];
    const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1, l2 = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    // Outward normals of a counter-clockwise ring in this x/z frame: (dz, -dx).
    const n1x = (p[1] - a[1]) / l1, n1z = -(p[0] - a[0]) / l1, n2x = (b[1] - p[1]) / l2, n2z = -(b[0] - p[0]) / l2;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const k = Math.min(3, 1 / Math.max(0.33, mx * n1x + mz * n1z));
    out.push([p[0] + mx * d * k, p[1] + mz * d * k]);
  }
  return out;
}

// Garden wall round a private house (round 5): plaster or kurkar, 1.2-1.8 m, set 1.6 m off the
// walls with a gate gap in the longest side. Photos: Katznelson 193679213309467, 520401690241645
// (2023-02-28); Neve Yam 3973510192736240 (2021-04-04). Same Acc as the walls: no draw calls.
function addYardWall(ch, r, spec, R, seed, tone) {
  const n = r.length, Y = spec.yardWall, off = 1.6 * M2U, h = Y.h;
  const gc = tone(Y.colour), gl = gc.clone().multiplyScalar(0.84), cap = gc.clone().multiplyScalar(0.94);
  // Round 6: each corner of the wall steps in (1.6 -> 0.9 -> 0.4 m) until it is off the sidewalk and
  // outside the neighbours; a corner that never fits drops the two wall runs that meet there.
  const rings = [offsetRing(r, off), offsetRing(r, 0.9 * M2U), offsetRing(r, 0.4 * M2U)];
  const ring = [], okV = [];
  for (let i = 0; i < n; i++) {
    let v = null;
    for (const rr of rings) if (SITE.ok(rr[i][0], rr[i][1])) { v = rr[i]; break; }
    ring.push(v || rings[0][i]); okV.push(!!v);
  }
  let gate = 0, gl0 = 0;
  for (let i = 0; i < n; i++) { const p = r[i], q = r[(i + 1) % n], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l > gl0) { gl0 = l; gate = i; } }
  part('yardWall');
  for (let i = 0; i < n; i++) {
    const A0 = ring[i], B0 = ring[(i + 1) % n], l = Math.hypot(B0[0] - A0[0], B0[1] - A0[1]);
    if (l < 0.8 * M2U || !okV[i] || !okV[(i + 1) % n] || !SITE.ok((A0[0] + B0[0]) / 2, (A0[1] + B0[1]) / 2)) continue;
    const ux = (B0[0] - A0[0]) / l, uz = (B0[1] - A0[1]) / l, nx = uz, nz = -ux;
    const g = 1.8 * M2U / l, segs = i === gate && l > 5 * M2U ? [[0, 0.5 - g], [0.5 + g, 1]] : [[0, 1]];
    for (const [t0, t1] of segs) {
      const A = [A0[0] + (B0[0] - A0[0]) * t0, A0[1] + (B0[1] - A0[1]) * t0], B = [A0[0] + (B0[0] - A0[0]) * t1, A0[1] + (B0[1] - A0[1]) * t1];
      ch.walls.quad([A[0], 0, A[1]], [B[0], 0, B[1]], [B[0], h, B[1]], [A[0], h, A[1]], [gl, gl, gc, gc], [nx, 0, nz], null, [ROW.plain, 0, seed]);
      ch.roofs.quad([A[0], h, A[1]], [B[0], h, B[1]], [B[0] - nx * 0.25 * M2U, h, B[1] - nz * 0.25 * M2U], [A[0] - nx * 0.25 * M2U, h, A[1] - nz * 0.25 * M2U], cap, UP);
    }
  }
}

// Flat cap on a convex quad: two triangles, no general triangulation (thousands of small boxes).
function quadTop(acc, q, y, colr, up = UP) {
  acc.tri([q[0][0], y, q[0][1]], [q[1][0], y, q[1][1]], [q[2][0], y, q[2][1]], colr, up);
  acc.tri([q[0][0], y, q[0][1]], [q[2][0], y, q[2][1]], [q[3][0], y, q[3][1]], colr, up);
}
// Site checks for garden and yard walls (round 6): SITE.ok(x, z) is false on a carriageway or
// sidewalk or inside another building's footprint. Set per build in buildBuildings.
let SITE = { ok: () => true, self: -1 };

// Counts of the round-4 parts emitted in the current build (copied into stats).
let PARTS = {};
const part = (k) => { PARTS[k] = (PARTS[k] || 0) + 1; };

// Skylight strips across big industrial roofs.
function addSkylights(roofs, c, m, bodyTop) {
  if (m.area <= 600) return;
  const ob = m.obb, nStrips = Math.min(8, Math.floor(ob.L / (12 * M2U)));
  const sky = col(0x9fc3d6);
  for (let k = 1; k <= nStrips; k++) {
    const t = -ob.L / 2 + (k * ob.L) / (nStrips + 1);
    const cx = c[0] + ob.ux * t, cz = c[1] + ob.uz * t, hw = ob.W * 0.35, sw = 1.2 * M2U;
    const vx = -ob.uz, vz = ob.ux;
    const y = bodyTop + 0.12;
    roofs.quad([cx - ob.ux * sw - vx * hw, y, cz - ob.uz * sw - vz * hw], [cx + ob.ux * sw - vx * hw, y, cz + ob.uz * sw - vz * hw],
      [cx + ob.ux * sw + vx * hw, y, cz + ob.uz * sw + vz * hw], [cx - ob.ux * sw + vx * hw, y, cz - ob.uz * sw + vz * hw], sky, UP);
  }
}

// Rows of heaters, spaced like real installs (about 2.4 m by 3 m), capped per roof.
function addSolar(ch, r, y, density, R) {
  const bb = bbox(r);
  const sx = 2.6 * M2U, sz = 3.2 * M2U, margin = 1.2 * M2U;
  const area = Math.abs(signedArea(r)) / (M2U * M2U);
  const cap = Math.min(10, Math.max(1, Math.round((area / 55) * density)));
  const spots = [];
  const jx = R(21) * sx, jz = R(22) * sz;
  for (let z = bb.minZ + margin + jz * 0.5; z < bb.maxZ - margin; z += sz) {
    for (let x = bb.minX + margin + jx * 0.5; x < bb.maxX - margin; x += sx) {
      if (inPoly(x, z, r) && inPoly(x + margin, z, r) && inPoly(x - margin, z, r) && inPoly(x, z + margin, r) && inPoly(x, z - margin, r)) spots.push([x, z]);
    }
  }
  if (!spots.length) return;
  // Take a contiguous run of spots so they cluster into rows rather than sprinkling.
  const start = Math.floor(R(23) * Math.max(1, spots.length - cap));
  for (let i = start; i < Math.min(spots.length, start + cap); i++) {
    ch.solar.push(mat4(spots[i][0], y, spots[i][1], (R(30 + i) - 0.5) * 0.12, M2U));
  }
}

// Balcony slabs on the longest facades, one stack per bay column chosen.
function addBalconies(ch, r, spec, bodyFloors, R, haze) {
  const b = spec.balconies;
  const n = r.length;
  const edges = [];
  for (let i = 0; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; edges.push([Math.hypot(q[0] - p[0], q[1] - p[1]), i]); }
  edges.sort((a, c) => c[0] - a[0]);
  const rail = col(b.rail);
  if (haze) rail.lerp(HAZE, 0.45);
  for (let f = 0; f < Math.min(b.faces, edges.length); f++) {
    const [len, i] = edges[f];
    if (len < 6 * M2U) continue;
    const p = r[i], q = r[(i + 1) % n];
    const dx = (q[0] - p[0]) / len, dz = (q[1] - p[1]) / len;
    const rotY = Math.atan2(-dz, dx) + Math.PI;
    const w = Math.min(len * b.width, 6 * M2U);
    const k = Math.min(b.perFloor, Math.max(1, Math.floor(len / (w * 1.8))));
    const depth = M2U * (b.depth ? b.depth / 1.4 : 1);
    for (let j = 0; j < k; j++) {
      if (R(40 + f * 7 + j) > b.p) continue;
      // Corner stacks sit flush with the building corners; others spread evenly.
      const o = b.corner && k === 2 ? (j === 0 ? w / 2 / len : 1 - w / 2 / len) : (j + 0.5) / k;
      const x = p[0] + dx * len * o, z = p[1] + dz * len * o;
      for (let fl = 1; fl < bodyFloors; fl++) {
        const y = spec.gh + (fl - 1) * spec.fh - 0.05;
        ch.balcony.push([mat4(x, y, z, rotY, w, V2U, depth), rail]);
      }
    }
  }
}

// Lift everything emitted since `mark` by `base`, and hang a plinth skirt below it when the
// footprint spans a slope so the downhill edge never shows a gap.
function seat(ch, [w0, r0, s0, b0], base, relief, r, spec, haze) {
  if (base !== 0) {
    for (let i = w0 + 1; i < ch.walls.p.length; i += 3) ch.walls.p[i] += base;
    for (let i = r0 + 1; i < ch.roofs.p.length; i += 3) ch.roofs.p[i] += base;
    for (let i = s0; i < ch.solar.length; i++) ch.solar[i].elements[13] += base;
    for (let i = b0; i < ch.balcony.length; i++) ch.balcony[i][0].elements[13] += base;
  }
  if (relief > 0.05 * SCALE) {
    const stone = col(0xb8ae9c);
    if (haze) stone.lerp(HAZE, 0.45);
    prism(ch.walls, r, base - 1.5 * V2U, base, 0, 0, () => [stone.clone().multiplyScalar(0.8), stone], [ROW.plain, 0, 0], 1e9);
  }
}

// ---------- main ----------

// `ground` is optional (defaults to terrain.js groundAt) so callers and tests can supply heights.
// `extras` is optional (defaults to data/rishon.extras.json loaded at import; null disables it).
export function buildBuildings(scene, data, opts = {}) {
  const { exclude = [], project = geoProject, ground = null } = opts;
  const groundY = typeof ground === 'function' ? ground : groundAt;
  const k = SCALE / (data.meta && data.meta.scale ? data.meta.scale : SCALE);
  const toM = 1 / SCALE; // world units -> metres

  const excl = (exclude || [])
    .map((e) => (Array.isArray(e) ? e : e && e.points))
    .filter((r) => r && r.length >= 3)
    .map((r) => ({ r, bb: bbox(r) }));
  const excluded = (x, z) => excl.some(({ r, bb }) => x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ && inPoly(x, z, r));

  const limits = (data.boundary || []).map((f) => ring(f, k)).filter((r) => r.length >= 3).map((r) => ({ r, bb: bbox(r) }));
  const inRishon = (x, z) => !limits.length || limits.some(({ r, bb }) => x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ && inPoly(x, z, r));

  // Neighbourhood centres in world units; data.places adds any suburb not in the table.
  const centres = NEIGHBOURHOODS.map((nb) => ({ ...nb, ...project(nb.lat, nb.lon) }));
  for (const pl of data.places || []) {
    const [, , nameEn, px, pz] = pl;
    const x = px * k, z = pz * k;
    if (!centres.some((c) => Math.hypot(c.x - x, c.z - z) < 150 * SCALE)) centres.push({ id: String(nameEn).toLowerCase().replace(/\W+/g, '-'), name: nameEn, profile: 'generic', x, z });
  }
  const zones = ZONES.map((zn) => {
    const r = zn.poly.map(([la, lo]) => { const p = project(la, lo); return [p.x, p.z]; });
    return { ...zn, r, bb: bbox(r) };
  });
  // ---- OSM extras, indexed once (ROUND3). Missing file -> empty indexes, old behaviour. ----
  const ex = opts.extras !== undefined ? opts.extras : EXTRAS;
  const ek = ex && ex.meta && ex.meta.scale ? SCALE / ex.meta.scale : 1;
  // Industrial landuse polygons replace the hand-drawn industrial rectangles when present.
  const indPolys = ((ex && ex.industrial) || []).filter((p) => p.points && p.points.length >= 3).map((p) => {
    const r = p.points.map(([x, z]) => [x * ek, z * ek]);
    const nm = `${p.nameEn || ''} ${p.name || ''}`;
    let profile = p.landuse === 'industrial' ? 'industrial' : 'indRetail';
    for (const [re, id] of INDUSTRIAL_NAMES) if (re.test(nm)) profile = id;
    return { r, bb: bbox(r), profile, name: p.nameEn || p.name || '' };
  });
  const handZones = indPolys.length ? zones.filter((zn) => zn.profile !== 'industrial') : zones;
  const zoneAt = (x, z) => {
    for (const zn of indPolys) if (x >= zn.bb.minX && x <= zn.bb.maxX && z >= zn.bb.minZ && z <= zn.bb.maxZ && inPoly(x, z, zn.r)) return zn;
    for (const zn of handZones) if (x >= zn.bb.minX && x <= zn.bb.maxX && z >= zn.bb.minZ && z <= zn.bb.maxZ && inPoly(x, z, zn.r)) return zn;
    return null;
  };
  const tagGrid = new Grid(40 * SCALE), shopGrid = new Grid(40 * SCALE), roadGrid = new Grid(60 * SCALE), evGrid = new Grid(40 * SCALE);
  for (const t of (ex && ex.buildingTags) || []) tagGrid.add(t.x * ek, t.z * ek, t);
  for (const s of (ex && ex.shops) || []) if (!(s.level > 0)) shopGrid.add(s.x * ek, s.z * ek, s);
  for (const e of EVIDENCE) { const p = project(e.lat, e.lon); evGrid.add(p.x, p.z, e); }
  // Footbridge decks that enter buildings (PASSAGES) also keep yard fences off their approach.
  const noYard = NO_YARD.concat(PASSAGES.map((P) => ({ pad: 8, line: P.line }))).map((z) => {
    const pts = (z.poly || z.line).map(([la, lo]) => { const p = project(la, lo); return [p.x, p.z]; });
    return { pts, closed: !!z.poly, pad: z.pad * SCALE, bb: bbox(pts) };
  });
  // Footprint within `pad` of a no-yard zone (inside the square, or any vertex/centroid close to it).
  const inNoYard = (r, c) => noYard.some(({ pts, closed, pad, bb }) => {
    if (c[0] < bb.minX - pad - 150 * SCALE || c[0] > bb.maxX + pad + 150 * SCALE || c[1] < bb.minZ - pad - 150 * SCALE || c[1] > bb.maxZ + pad + 150 * SCALE) return false;
    const near = (x, z) => {
      if (closed && inPoly(x, z, pts)) return true;
      for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if (segDist(x, z, [a[0], a[1], b[0], b[1]]) < pad) return true; }
      return false;
    };
    return near(c[0], c[1]) || r.some((p) => near(p[0], p[1]));
  });
  const passages = PASSAGES.map((P) => {
    const pts = P.line.map(([la, lo]) => { const q = project(la, lo); return [q.x, q.z]; });
    return { ...P, pts, halfW: P.halfW * SCALE, bb: bbox(pts) };
  });
  // ---- Round 6: street clearance. A building, garden wall or yard may not stand on a carriageway
  // or sidewalk. Widths mirror city.js (lanes x 3.5 m + extra, x WIDEN 1.4, boulevard median,
  // 2.8 m sidewalks on urban non-link roads from residential up). city.js may pass
  // opts.clearance(x, z) -> metres-free (negative = on the street) once the architect's narrowed
  // old-centre carriageways land; until then this copy of its formula is used.
  const RCW = { motorway: [6, 3, 3.5, 9], motorway_link: [2, 1, 3, 6], trunk: [4, 2, 2.5, 8], trunk_link: [2, 1, 2.5, 6],
    primary: [4, 2, 1, 7, 1], primary_link: [2, 1, 2, 5], secondary: [2, 2, 3, 6, 1], secondary_link: [2, 1, 2, 4],
    tertiary: [2, 1, 3, 5, 1], tertiary_link: [2, 1, 2, 4], unclassified: [2, 1, 3, 3, 1], residential: [2, 1, 3, 3, 1],
    living_street: [1, 1, 3, 2], service: [1, 1, 1, 1] };
  const WU = SCALE * 1.4, SWU = 2.8 * WU, clearGrid = new Grid(40 * SCALE);
  for (const rd of data.roads || []) {
    const [kind0, , f, a0] = rd, a = a0 || {};
    if (kind0 === 'sidewalk' || !Array.isArray(f) || a.tunnel || a.bridge || (a.layer || 0) > 0) continue;
    const hw = a.hw || kind0, c = RCW[hw];
    let half = 0;
    if (c) {
      const lanes = Math.min(a.oneway ? 6 : 8, a.lanes || (a.oneway ? c[1] : c[0]));
      let metres = lanes * 3.5 + c[2];
      if (hw === 'service' && (a.service === 'driveway' || a.service === 'alley')) metres = 4;
      const median = !a.oneway && !a.roundabout && c[3] >= 6 && !/_link$/.test(hw) && lanes >= 4 ? 4 : 0;
      half = ((metres + median) * WU) / 2 + (c[4] && c[3] >= 3 ? SWU : 0);
    } else if (hw === 'pedestrian') half = (8 * WU) / 2;
    else continue;
    const carriage = c ? half - (c[4] ? SWU : 0) : 0;
    for (let i = 0; i + 3 < f.length; i += 2) {
      const ax = f[i] * k, az = f[i + 1] * k, bx = f[i + 2] * k, bz = f[i + 3] * k;
      const seg = [ax, az, bx, bz, half + 0.3, carriage];
      const nn = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (30 * SCALE)));
      for (let j = 0; j <= nn; j++) clearGrid.add(ax + ((bx - ax) * j) / nn, az + ((bz - az) * j) / nn, seg, true);
    }
  }
  const REACH = 26 * SCALE; // widest half-corridor considered (8-lane boulevard + sidewalk)
  // Free distance from the street at (x, z): > 0 is clear; also returns the push direction.
  // Street segments that can reach a footprint (bbox + REACH), deduplicated, so the per-vertex test
  // runs over a handful of segments instead of every grid cell around each vertex.
  const candSet = new Set();
  const candidates = (r) => {
    const b = bbox(r), cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2, rad = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
    candSet.clear();
    clearGrid.near(cx, cz, rad + REACH, (sg) => candSet.add(sg));
    const out = [];
    for (const sg of candSet) if (segDist(cx, cz, sg) < rad + sg[4] + 3 * SCALE) out.push(sg);
    return out;
  };
  let CANDS = null;
  const streetAt = (x, z, cands = CANDS) => {
    let worst = 0, px = 0, pz = 0, onCar = false;
    if (opts.clearance) { const v = opts.clearance(x, z); return { need: v < 0 ? -v * SCALE : 0, px: 0, pz: 0, onCar: v < -2 }; }
    const visit = (sg) => {
      const dx = sg[2] - sg[0], dz = sg[3] - sg[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - sg[0]) * dx + (z - sg[1]) * dz) / l2));
      const cx = sg[0] + dx * t, cz = sg[1] + dz * t, d = Math.hypot(x - cx, z - cz);
      const need = sg[4] - d;
      if (need > worst) { worst = need; const dl = d || 1; px = d > 1e-3 ? (x - cx) / dl : -dz / Math.sqrt(l2); pz = d > 1e-3 ? (z - cz) / dl : dx / Math.sqrt(l2); }
      if (d < sg[5]) onCar = true;
    };
    if (cands) for (const sg of cands) visit(sg); else clearGrid.near(x, z, REACH, visit);
    return { need: worst, px, pz, onCar };
  };
  const tPre = performance.now();
  // Footprint occupancy for "yards stay inside plots": original rings in a coarse grid.
  const occGrid = new Grid(30 * SCALE), rings = [];
  for (let bi = 0; bi < (data.buildings || []).length; bi++) {
    let r = ring(data.buildings[bi][2], k);
    if (r.length < 3) { rings.push(null); continue; }
    if (signedArea(r) < 0) r.reverse();
    rings.push(r);
    const b = bbox(r);
    for (let x = b.minX; x <= b.maxX + 30 * SCALE; x += 30 * SCALE) for (let z = b.minZ; z <= b.maxZ + 30 * SCALE; z += 30 * SCALE) occGrid.add(Math.min(x, b.maxX), Math.min(z, b.maxZ), bi, true);
  }
  const occupied = (x, z, self) => {
    let hit = false;
    occGrid.near(x, z, 1, (bi) => {
      if (hit || bi === self) return;
      const r = rings[bi];
      if (r && inPoly(x, z, r)) hit = true;
    });
    return hit;
  };
  const msPre = performance.now() - tPre;
  let msSite = 0;
  SITE = { ok: (x, z) => { const t = performance.now(); const v = streetAt(x, z).need <= 0 && !occupied(x, z, SITE.self); msSite += performance.now() - t; return v; }, self: -1 };
  // Push every vertex that stands on a street back to its edge; if the result is not a simple
  // polygon or lost most of its area, shrink about the centroid until it clears instead. Returns
  // null when nothing needed moving, 'drop' when the centroid stands on a carriageway.
  const setBack = (r) => {
    CANDS = candidates(r);
    if (!CANDS.length) return null;
    let moved = false;
    const out = r.map((p) => [p[0], p[1]]);
    for (let pass = 0; pass < 2; pass++) for (const p of out) {
      const s = streetAt(p[0], p[1]);
      if (s.need > 0.02) { p[0] += s.px * s.need; p[1] += s.pz * s.need; moved = true; }
    }
    if (!moved) return null;
    const c = centroid(r);
    if (streetAt(c[0], c[1]).onCar) return 'drop';
    const a0 = signedArea(r), a1 = signedArea(out);
    if (a1 > a0 * 0.35 && simpleRing(out)) return out;
    for (let sc = 0.9; sc >= 0.3; sc -= 0.1) {
      const q = shrink(r, c, sc);
      if (q.every((p) => streetAt(p[0], p[1]).need <= 0.02)) return q;
    }
    return 'drop';
  };
  const heights = opts.heights !== undefined ? opts.heights : HEIGHTS;
  const hGrid = new Grid(40 * SCALE);
  for (const h of (heights && heights.buildings) || []) { const p = project(h.lat, h.lon); hGrid.add(p.x, p.z, h); }
  const heightFor = (c) => {
    let best = null, bd = 6 * SCALE;
    hGrid.near(c[0], c[1], bd, (h, x, z) => { const d = Math.hypot(x - c[0], z - c[1]); if (d < bd) { bd = d; best = h; } });
    return best;
  };
  // Main-road segments, for "this building fronts a main road" (showroom glass, shop strips).
  const FRONT_KINDS = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link', 'secondary_link']);
  // Only roads near an industrial polygon matter (frontage is only asked there).
  const pad = 60 * SCALE;
  const nearInd = (x, z) => indPolys.some(({ bb }) => x > bb.minX - pad && x < bb.maxX + pad && z > bb.minZ - pad && z < bb.maxZ + pad);
  // Every road near an industrial zone, with its half width in world units, so yards and
  // fences stop short of the carriageway; seg[4] marks main roads (frontage).
  const HALF_M = { motorway: 12, trunk: 11, primary: 10, secondary: 8.5, tertiary: 7.5, residential: 6, unclassified: 6, service: 4, living_street: 5 };
  for (const rd of indPolys.length ? data.roads || [] : []) {
    if (!Array.isArray(rd[2]) || !nearInd(rd[2][0] * k, rd[2][1] * k)) continue;
    const half = (HALF_M[String(rd[0]).replace('_link', '')] || 0) * SCALE;
    if (!half) continue;
    const f = rd[2];
    for (let i = 0; i + 3 < f.length; i += 2) {
      const a = [f[i] * k, f[i + 1] * k], b2 = [f[i + 2] * k, f[i + 3] * k];
      const n = Math.max(1, Math.ceil(Math.hypot(b2[0] - a[0], b2[1] - a[1]) / (40 * SCALE)));
      const seg = [a[0], a[1], b2[0], b2[1], FRONT_KINDS.has(rd[0]), half];
      for (let j = 0; j <= n; j++) roadGrid.add(a[0] + ((b2[0] - a[0]) * j) / n, a[1] + ((b2[1] - a[1]) * j) / n, seg, true);
    }
  }
  // Per edge: does it face a main road (within 35 m, running along it), and how much clear
  // ground lies in front of it before any road's edge (metres, capped at 40).
  const edgeInfo = (r) => {
    const out = [];
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const e = { front: false, clear: 40 };
      out.push(e);
      if (len < 4 * SCALE) continue;
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2, ux = (q[0] - p[0]) / len, uz = (q[1] - p[1]) / len;
      const nx = uz, nz = -ux; // outward for counter-clockwise rings in this x/z frame
      roadGrid.near(mx, mz, 45 * SCALE, (s) => {
        const d = segDist(mx, mz, s);
        // only roads on the outer side of this edge
        const t = Math.max(0, Math.min(1, ((mx - s[0]) * (s[2] - s[0]) + (mz - s[1]) * (s[3] - s[1])) / (((s[2] - s[0]) ** 2 + (s[3] - s[1]) ** 2) || 1)));
        const cx = s[0] + (s[2] - s[0]) * t, cz = s[1] + (s[3] - s[1]) * t;
        if ((cx - mx) * nx + (cz - mz) * nz < 0) return;
        e.clear = Math.min(e.clear, Math.max(0, (d - s[5]) / SCALE));
        if (!s[4] || len < 8 * SCALE || d > 35 * SCALE) return;
        const sl = Math.hypot(s[2] - s[0], s[3] - s[1]) || 1;
        if (Math.abs(ux * (s[2] - s[0]) / sl + uz * (s[3] - s[1]) / sl) >= 0.9) e.front = true; // runs along the road
      });
    }
    return out;
  };
  const colourHex = (s) => { if (!s) return null; try { return new THREE.Color(String(s).trim()).getHex(); } catch { return null; } };
  // Everything the extras say about one footprint.
  const extrasFor = (r, c, area, industrial) => {
    const out = {};
    let bd = 8 * SCALE;
    tagGrid.near(c[0], c[1], bd, (t, x, z) => { const d = Math.hypot(x - c[0], z - c[1]); if (d < bd) { bd = d; out.tag = t; } });
    if (out.tag) {
      const t = out.tag;
      if (t.roofShape) out.roofShape = t.roofShape;
      out.roofColour = colourHex(t.roofColour);
      out.wallColour = colourHex(t.buildingColour);
      if (t.name && industrial && area > 1500) out.bigName = true;
    }
    let ed = 12 * SCALE;
    evGrid.near(c[0], c[1], ed, (e, x, z) => { const d = Math.hypot(x - c[0], z - c[1]); if (d < ed) { ed = d; out.evidence = e; } });
    const bb = bbox(r), pad = 6 * SCALE;
    shopGrid.near(c[0], c[1], Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ) / 2 + pad, (s, x, z) => {
      if (out.shop || x < bb.minX - pad || x > bb.maxX + pad || z < bb.minZ - pad || z > bb.maxZ + pad) return;
      if (inPoly(x, z, r) || ringDist(x, z, r) < pad) out.shop = s;
    });
    return out;
  };
  const nearest = (x, z) => {
    let best = null, bd = NEAREST_MAX_M * SCALE;
    for (const c of centres) { const d = Math.hypot(c.x - x, c.z - z); if (d < bd) { bd = d; best = c; } }
    return best;
  };

  const gradientMap = toonGradient();
  const atlas = buildAtlas();
  const wallMat = wallMaterial(gradientMap, atlas);
  const roofMat = new THREE.MeshToonMaterial({ gradientMap, vertexColors: true });
  const propMat = new THREE.MeshToonMaterial({ gradientMap, vertexColors: true });

  const chunks = new Map();
  const chunkOf = (x, z) => {
    const key = `${Math.floor((x * toM) / CHUNK_M)},${Math.floor((z * toM) / CHUNK_M)}`;
    let c = chunks.get(key);
    if (!c) { c = { walls: new Acc(true), roofs: new Acc(), solar: [], balcony: [] }; chunks.set(key, c); }
    return c;
  };

  PARTS = {};
  const colliders = [];
  const stats = { buildings: 0, excluded: 0, byArch: {}, byProfile: {}, roofs: {}, pyramidWhy: {}, evidence: 0, osmTags: 0, shopFronts: 0, msExtras: 0, pyramidAt: [], towers: [], heightWhy: {} };
  const t0 = performance.now();

  for (let bi = 0; bi < (data.buildings || []).length; bi++) {
    const b = data.buildings[bi];
    const [hm, kind, f, extra] = b;
    let r = rings[bi];
    if (!r) continue;
    const areaU = signedArea(r);
    if (areaU <= 0) continue;
    let c = centroid(r);
    if (excl.length && excluded(c[0], c[1])) { stats.excluded++; continue; }
    CANDS = null;

    const R = hasher(c[0] * toM, c[1] * toM);
    const zn = zoneAt(c[0], c[1]);
    const nb = zn ? null : nearest(c[0], c[1]);
    const profId = zn ? zn.profile : nb ? nb.profile : 'generic';
    const prof = PROFILES[profId];
    // Developers build in clusters, so neighbours share palette and roof choices.
    const CL = 140 * SCALE;
    const cluster = hasher(Math.floor(c[0] / CL) * 997, Math.floor(c[1] / CL) * 991);

    const ob = obb(r);
    const area = areaU * toM * toM;
    const m = { area, L: ob.L * toM, W: ob.W * toM, aspect: ob.W > 0 ? ob.L / ob.W : 1, convex: isConvex(r), n: r.length, obb: ob };
    m.W = ob.W; // emitters work in world units
    const metrics = { ...m, L: ob.L * toM, W: ob.W * toM };
    const tx = performance.now();
    if (prof.style) { metrics.edges = edgeInfo(r); metrics.front = metrics.edges.some((e) => e.front); }
    let more = ex ? extrasFor(r, c, area, !!prof.industrial) : null;
    const hRow = heightFor(c);
    if (hRow) more = { ...(more || {}), storeys: hRow.storeys, confidence: hRow.confidence, podium: hRow.podium ? hRow : null, type: hRow.type, roofRooms: hRow.roofRooms, facade: hRow.facade, wallHex: hRow.wall, roofKind: hRow.roof };
    stats.msExtras += performance.now() - tx;
    const spec = specFor(prof, profId, kind, hm, metrics, R, cluster, more ? { ...(extra || {}), ...more } : extra);
    if (spec.yard && inNoYard(r, c)) { spec.yard.fence = false; spec.yard.dock = false; stats.noYard = (stats.noYard || 0) + 1; }
    const haze = !inRishon(c[0], c[1]);
    const ch = chunkOf(c[0], c[1]);
    const seed = Math.floor(R(99) * 97);
    // Seat on the lowest ground under the footprint; the uphill side is buried, nothing floats.
    let base = groundY(c[0], c[1]), high = base;
    for (const p of r) { const g = groundY(p[0], p[1]); if (g < base) base = g; if (g > high) high = g; }
    if (!Number.isFinite(base)) base = high = 0;
    // Round 6: off the carriageway and sidewalk. Looks were already decided on the OSM footprint
    // (same random streams, same heights-table match); only the geometry moves back.
    const tsb = performance.now();
    const sb = setBack(r);
    stats.msSetBack = (stats.msSetBack || 0) + performance.now() - tsb;
    if (sb === 'drop') { stats.onStreet = (stats.onStreet || 0) + 1; continue; }
    if (sb) {
      r = sb; c = centroid(r);
      const ob2 = obb(r);
      m.obb = ob2; m.W = ob2.W; m.n = r.length; m.convex = isConvex(r);
      stats.setBack = (stats.setBack || 0) + 1;
    }
    SITE.self = bi;
    // Footbridge entering this footprint: cut the entrance recess (walls, roof and collider follow).
    let door = null;
    for (const P of passages) {
      if (P.bb.maxX < c[0] - 400 * SCALE || P.bb.minX > c[0] + 400 * SCALE || P.bb.maxZ < c[1] - 400 * SCALE || P.bb.minZ > c[1] + 400 * SCALE) continue;
      const cut = cutPassage(r, P);
      if (cut) { r = cut.ring; door = { ...cut.door, deckU: P.deckU }; stats.passages = (stats.passages || []).concat(P.id); }
    }
    // Round 6 "less square, more rounded": bevel the vertical corners (rounded on towers).
    const bev = BEVEL_M[spec.arch];
    if (bev && !door && r.length <= 16 && m.area > (BEVEL_MIN_M2[spec.arch] || 60)) {
      const br = bevelRing(r, bev * M2U);
      if (br.ring.length > r.length) { spec.hipRing = r; spec.facets = br.facets; r = br.ring; stats.bevelled = (stats.bevelled || 0) + 1; }
    }
    const mark = [ch.walls.p.length, ch.roofs.p.length, ch.solar.length, ch.balcony.length];
    const h = emitBuilding(ch, r, c, m, spec, R, haze, seed);
    if (door) addPassageDoor(ch, door, h, seed);
    if (base !== 0 || high !== 0) seat(ch, mark, base, high - base, r, spec, haze);
    colliders.push({ kind: 'building', points: r, height: base + h, base });

    stats.buildings++;
    stats.byArch[spec.arch] = (stats.byArch[spec.arch] || 0) + 1;
    if (spec.floors >= 8 || hRow) stats.heightWhy[spec.heightWhy] = (stats.heightWhy[spec.heightWhy] || 0) + 1;
    if (spec.floors >= 8) stats.towers.push([Math.round(c[0]), Math.round(c[1]), spec.floors, spec.arch, profId, spec.heightWhy || 'heuristic']);
    stats.byProfile[profId] = (stats.byProfile[profId] || 0) + 1;
    stats.roofs[spec.roof] = (stats.roofs[spec.roof] || 0) + 1;
    if (spec.pyramidWhy) {
      stats.pyramidWhy[spec.pyramidWhy] = (stats.pyramidWhy[spec.pyramidWhy] || 0) + 1;
      stats.pyramidAt.push([Math.round(c[0]), Math.round(c[1]), spec.pyramidWhy]); // preview hops
    }
    if (more && more.evidence) stats.evidence++;
    if (more && more.tag) stats.osmTags++;
    if (more && more.shop) stats.shopFronts++;
  }

  const group = new THREE.Group();
  group.name = 'buildings';
  const solarGeo = solarTemplate(), balconyGeo = balconyTemplate();
  let heaters = 0, balconies = 0;
  for (const [key, c] of chunks) {
    const g = new THREE.Group();
    g.name = `buildings ${key}`;
    const props = [];
    if (!c.walls.empty) {
      const w = new THREE.Mesh(c.walls.geometry(), wallMat);
      w.castShadow = w.receiveShadow = true; w.name = 'walls';
      w.geometry.computeBoundingBox();
      const box = w.geometry.boundingBox.clone();
      // Toggle the chunk's props from the main (perspective) camera only; shadow cameras are orthographic.
      w.onBeforeRender = (rnd, sc, cam) => {
        if (!cam.isPerspectiveCamera) return;
        const near = box.distanceToPoint(cam.position) < PROP_RANGE_M * SCALE;
        for (const p of props) p.visible = near;
      };
      g.add(w);
    }
    if (!c.roofs.empty) {
      const rm = new THREE.Mesh(c.roofs.geometry(), roofMat);
      rm.castShadow = rm.receiveShadow = true; rm.name = 'roofs';
      g.add(rm);
    }
    if (c.solar.length) {
      const im = new THREE.InstancedMesh(solarGeo, propMat, c.solar.length);
      c.solar.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); im.name = 'solar-heaters';
      g.add(im); props.push(im);
      heaters += c.solar.length;
    }
    if (c.balcony.length) {
      const im = new THREE.InstancedMesh(balconyGeo, propMat, c.balcony.length);
      c.balcony.forEach(([mm, cc], i) => { im.setMatrixAt(i, mm); im.setColorAt(i, cc); });
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere(); im.name = 'balconies';
      g.add(im); props.push(im);
      balconies += c.balcony.length;
    }
    group.add(g);
  }
  scene.add(group);

  stats.parts = PARTS;
  stats.heaters = heaters; stats.balconies = balconies; stats.chunks = chunks.size;
  stats.ms = Math.round(performance.now() - t0);
  stats.msPre = Math.round(msPre); stats.msSite = Math.round(msSite); stats.msSetBack = Math.round(stats.msSetBack || 0);
  group.userData.stats = stats;
  // Viewpoints for previews and the big map: neighbourhood centres and override zones.
  group.userData.views = [
    ...centres.map((c) => ({ id: c.id, name: c.name, profile: c.profile, x: c.x, z: c.z })),
    ...zones.map((zn) => { const p = project(zn.view[0], zn.view[1]); return { id: zn.id, name: zn.name, profile: zn.profile, x: p.x, z: p.z }; }),
    ...indPolys.filter((p) => p.name && p.profile !== 'industrial' || /eliyahu/i.test(p.name)).map((p) => {
      const cc = centroid(p.r);
      return { id: 'osm-' + p.name.toLowerCase().replace(/\W+/g, '-'), name: p.name + ' (OSM)', profile: p.profile, x: cc[0], z: cc[1] };
    }),
  ];
  return { colliders, group };
}

export { NEIGHBOURHOODS, ZONES, PROFILES, PASSAGES, cutPassage };

// ---------- SOURCES (checked 2026-10-14) ----------
// VERIFIED = a cited page or photo shows it. INFERRED = reasoned from OSM footprints/era.
//
// Neot Ashlim
//  - Mid-1990s; HaTizmoret 36 has 12 floors (VERIFIED, https://finance.walla.co.il/item/1766616).
//  - Cream/beige plaster towers ~12-14 floors, recessed balconies with green rails and awnings,
//    teal-blue cladding on the pilotis, flat tops with pergola penthouses (VERIFIED by photo:
//    https://commons.wikimedia.org/wiki/File:Rischon025.jpg and File:Rischon026.jpg, 2010).
//  - Round 3 (checked 2026-10-15): towers on the HaTof/HaKinor/HaPsanter edge are 8-9 storeys
//    including a teal-glazed roof room, flat roofs, about as tall as wide (VERIFIED by photo:
//    Mapillary 769716300409432, 5751417088231907, 507130250703871, 376108830412327, 2021-02-14;
//    footprints matched in EVIDENCE). Penthouse on floor 7 on HaTizmoret (yad2 listing, 2026-10-15).
//    No Mapillary coverage inside the HaTizmoret/HaHalil/HaKlarinet ring; Commons has no photos.
//  - Light-blue pyramid roofs ONLY on HaTizmoret 40, 38, 36, 34 and maybe 32 (founder,
//    2026-10-15; EVIDENCE table). No photo or OSM roof:shape=pyramidal tag (extras: 0). Pyramid
//    proportions (80% inset, ~30 degrees) GUESS from the founder's "smaller". Colour INFERRED.
// Kiryat Ganim: long 3-4 storey blocks on pilotis (founder); no photo or text source found.
// Pras Nobel: cottages beside apartment buildings, late 1990s (VERIFIED,
//    https://www.bizportal.co.il/realestates/news/article/827450); OSM tower heights 42-55 m.
// Neot Shikma: private houses and relatively low buildings, mid-1990s (VERIFIED,
//    https://www.bizportal.co.il/realestates/news/article/816734).
// Neve Dekalim: OSM tags 58 footprints building=house with 2 levels; blocks up to ~15 floors
//    (madlan snippet, weak). Tile-roof cottage mix INFERRED.
// Kiryat Rishon / HaLeom / Kramim: white 15-24 storey towers, white frame crowns, dark glass balcony
//    rails (VERIFIED by photo: Mapillary image 1106177046574094, 2021-02-14); Upper West: two
//    19-floor granite-clad towers with curtain walls (VERIFIED, https://m-y-s.com/Upper-West).
// Beachfront (Shaar HaYam / Neve Hof): OSM heights to 138 m; looks INFERRED (no photo checked).
// Shikunim (Ramat Eliyahu, Neve Yam, Bnot Hayil, Abramovich): post-1950 immigrant housing,
//    3-4 storey "rakevet" slabs (VERIFIED, he.wikipedia Rishon LeZion; https://www.nadlancenter.co.il/article/9274);
//    cream/yellow plaster walk-ups with vertical concrete balcony fins next to 2-3 storey houses
//    (VERIFIED by photo: Mapillary image 802299140647537, Zalman Shneur St, 2021). Pilotis,
//    shutters and laundry racks INFERRED (standard Israeli shikun type).
// Katznelson / Remez: low private houses with clay-tile roofs and kurkar garden walls (VERIFIED by
//    photo: Mapillary image 114474104910136, 2023).
// Old centre: late-1800s houses with tiled roofs, verandas and green shutters, kurkar walls
//    (VERIFIED, https://www.ynet.co.il/articles/0,7340,L-3926491,00.html). Modern 3-4 storey
//    blocks with shops along Rothschild INFERRED.
// Storeys (round 3 height pass, 2026-10-15): OSM building:levels/height first (314 towers in
//    Rishon), then data/building_heights.json (487 researched footprints: web listings and
//    articles, Mapillary floor counts, same-project inference; each row has its source and a
//    confidence), then the conservative profile ranges above. Findings: most untagged "towers"
//    in Kiryat Kramim, Neot Shikma, Neve Hof, Shaar HaYam and Neve Dekalim are 2-10 storeys;
//    HaTizmoret 2-10/32-40 and Kiryat Ganim's Negba/Sde Nahum blocks are 10-14. Podiums:
//    Sea One (Achi Dakar) and the Yehoram Gaon twin towers are drawn as towers on a podium.
// Kiryat Ganim (round 4, 2026-10-15): storeys, ground-floor flats, roof add-on flats and cottage
//    streets from the ad.co.il sale archive (685 ads, sp4=1360; 83 footprints in
//    data/building_heights.json); walk-up kit (stair cores, enclosed balconies, roof rooms, some
//    tile roofs, garden walls, wider plaster palette) INFERRED: Mapillary covers only the edge roads
//    and Commons has no photos inside the neighbourhood.
// Industrial lots (round 4): showrooms only where an edge faces a main road; side streets get
//    sheds and tilt-up halls with loading docks, corrugated-fence yards with pallets, rooftop units
//    and sign bands. Corrugated fences VERIFIED (Mapillary 527840945041701, 1351990215598989);
//    docks, pallets and rooftop units INFERRED.
// Industrial zones: extents from OSM landuse polygons in data/rishon.extras.json (VERIFIED, OSM
//    2026-10-15); hand-drawn ZONES are only the fallback. Looks (checked 2026-10-15):
//  - New (west) industrial area: 3-6 storey office/showroom blocks with blue-green curtain glass
//    and white/silver panels, rounded glass corners, big-box retail with a coloured fascia band;
//    flat roofs, few corrugated sheds (VERIFIED by photo: Mapillary 582636666042956,
//    1133094797811385, 573210656989833, 161210462524430, 515936919423958).
//  - Old industrial zone: 1-3 storey plastered commercial with shops and showroom glass on the
//    main roads, car dealers, blue-glass boxes, corrugated fences/sheds behind, new residential
//    towers replacing it (VERIFIED by photo: Mapillary 1569099529960848, 137798325038294,
//    1641602769365025, 527840945041701, 1165704913946369). Most of it lies east of the data bbox.
//  - Gan Sorek: glass hi-tech offices with dark perforated screens (VERIFIED by photo: Commons
//    "Beit Champion in Rishon LeZion.jpg"); logistics halls from the 9-10k m2 OSM footprints
//    INFERRED (Mapillary there is highway only).
//  - Ramat Eliyahu industrial zone: Mapillary is Route 4 only; corrugated sheds INFERRED, unchanged.
//  - Main-road frontage (trunk..tertiary within 35 m, edge parallel) decides showroom/strip fronts.
//    Millennia tower 22 floors / 99.7 m (https://www.skyscrapercenter.com/building/millennia/47175).
// Round 5 (checked 2026-10-16)
//  - UMI building south of the Golden Mall: 12 storeys over a 2-storey car showroom podium (VERIFIED:
//    yad2 office listings 2026-06 "floor 8 of 11", "floor 9 of 12"; Mapillary 159745396155624,
//    1604517479734814, 170089475035435). Tower over the middle of the footprint: INFERRED from bearings.
//  - Neve Yam is a late-1980s/1990s neighbourhood of private houses and garden flats with apartment
//    blocks on the Mivtza streets (VERIFIED: bizportal 20038146, 2025; OSM: 0.9 of its footprints are
//    100-300 m2, identical 233-324 m2 plots eight to a gem cul-de-sac). Houses: 2 storeys, red tile
//    roofs, stone-clad or white, tall garden walls (VERIFIED by photo: Mapillary 3973510192736240,
//    1630021603853741, 135317705318681, 2021-04-04; Topaz 2 listing: ground-floor duplex with garden,
//    madlan 2026). Inside the marine-street half there is no street imagery: same look INFERRED.
//    Even Hen 2/4: 23 storeys, white with frame crowns (OSM levels + the same photos).
//  - Remez / Abramovich / Rambam: four-storey 1960s-70s walk-ups in ochre and sand plaster with solid
//    balcony parapets, closed balconies and AC units, grey 8-9 storey blocks between, shops under
//    the blocks on the Katznelson edge street (VERIFIED by photo: Mapillary 1144609733365870,
//    1096989901355406, 1089845375564946, 702918805144216 2024-03-16; 1233479687579997,
//    138386475811360 2023-02-28). OSM: 405 of 657 Remez footprints are 300-600 m2, levels median 4.
//  - Katznelson / HaShomer: private houses, 2 storeys, red tile hip roofs, some red brick, white
//    flat-roofed modern rebuilds, tall plastered/stone garden walls with grey slat gates (VERIFIED by
//    photo: Mapillary 1533664107158095, 1207114670170707, 520401690241645, 193679213309467,
//    2023-02-28). OSM: 341 of 569 footprints under 300 m2, levels median 2.
//  - Old centre: 4-6 storey blocks on the residential streets, shops under awnings on the shuk
//    streets, the white Great Synagogue and stone houses with tile roofs at Founders Square
//    (VERIFIED by photo: Mapillary 113223590828438, 225505345610605, 1195096860934796, 168198489334036).
//  - Nahalat Yehuda, Bnot Hayil, Neve Hilel, Gordon, Tzamarot (houses), Shikuney HaMizrah (low
//    houses), Neve Hadarim / Revivim / Kalaniyot / Kfar Arye / HaRakafot / Mishor HaNof / Kidmat
//    Rishon / Marom Rishon / Narkisim / Nuriyot (cottages + blocks, towers only where OSM tags
//    levels): INFERRED from OSM footprint sizes and building:levels per place node; no photos checked.
