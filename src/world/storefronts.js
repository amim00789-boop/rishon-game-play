// Storefronts: ground-floor shop fronts on the building nearest each OSM shop node, facing its
// street, so the player can read the shops of Rishon while walking.
//
// Data: data/rishon.extras.json `shops` (fetch_osm_extras.py); without it, the amenities baked into
// data/rishon.json. Text: data/i18n/shops.<lang>.json, registered under the `shop` prefix, so every
// sign resolves through t('shop.*'). Source files hold keys only (house rule: no Hebrew in .js).
//
// Naming policy (docs/ROUND3.md decisions):
//  - a known national chain or brand gets its parody name (shop.brand.<id>);
//  - any other branded shop (an OSM brand tag we do not know) shows only its generic type, never
//    the real brand;
//  - an independent local shop shows its own name, with the generic type underneath;
//  - an unnamed shop shows the generic type ("falafel", "grocery").
//
// Placement: for each shop, candidate facade edges of nearby buildings are scored by distance to
// the node and by having a street in front of them (city.roads, car streets preferred). Party walls
// (another building right outside the edge) are rejected. Several shops on one facade get separate
// slots along the edge. Shops inside a mall (or a landmark that is a mall) are listed on the mall's
// directory pylon instead of getting a facade.
//
// Street props stand on the sidewalk only: café tables need a clear strip of CAFE_CLEAR between the
// facade and the carriageway (city.onCarriage), and every table is re-checked on its own.
//
// Rendering: every kind of part is ONE InstancedMesh (boards, frames, glass, awnings, props) and
// sign text is one InstancedMesh per atlas page, with a per-instance UV rectangle. Instances are
// distance-culled by compacting the instance buffers when the camera has moved REFRESH_STEP units,
// driven from onBeforeRender, so ~20 draw calls cover every shop in the city.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SCALE, project } from '../geo.js';
import { t, register, i18n, isRtl } from '../i18n.js';

const DATA = new URL('../../data/', import.meta.url).href;

const R_SEARCH = 26 * SCALE; // a shop node further than ~26 m from any facade is not placed
const ROAD_REACH = 45 * SCALE; // a facade "faces a street" only if one is this close in front
const MIN_W = 3.0; // narrowest shop front (world units)
const CAFE_CLEAR = 5.6; // facade-to-carriageway clearance needed for tables (~4.7 m)
const PROP_CLEAR = 2.8; // clearance needed for crates and an outside counter
const PS = 1.45; // street props are drawn oversized to match the ~5-unit avatars
const RANGE_FRONT = 480, RANGE_PROP = 260, RANGE_DIR = 900;
const REFRESH_STEP = 10;
const CELL_W = 384, CELL_H = 96, DIR_W = 320, DIR_H = 640, PAGE = 2048, GUTTER = 4;
const FONT = '"Rubik", "Heebo", "Arial Hebrew", "Noto Sans Hebrew", sans-serif';
const ch = (...c) => String.fromCharCode(...c);
// Built from code points so this file stays free of right-to-left characters.
const RTL_CHARS = new RegExp(`[${ch(0x590)}-${ch(0x5ff)}]`);
const QUOTES = new RegExp(`['"\`${ch(0x2018, 0x2019, 0x5f3, 0x5f4)}]`, 'g');

// ---------- type and brand tables (English keys; display text is in the JSON) ----------

// type: [prop group, sign bg, sign fg, awning chance, front size]
// groups: counter (outside food counter), seat (café tables), crates, cross (pharmacy), atm, none.
const TYPES = {
  falafel: ['counter', '#f6c12f', '#7a2e0e', 0.85, 'small'],
  shawarma: ['counter', '#c8451d', '#fff4d6', 0.85, 'small'],
  hummus: ['counter', '#efe2b8', '#5a3b12', 0.7, 'small'],
  fast_food: ['counter', '#e53935', '#ffffff', 0.5, 'small'],
  pizza: ['seat', '#2e7d32', '#ffffff', 0.6],
  burger: ['seat', '#3e2723', '#ffca28', 0.3],
  sushi: ['seat', '#1d1d1d', '#ff5252', 0.2],
  restaurant: ['seat', '#6d2b2b', '#fbe9d0', 0.8],
  cafe: ['seat', '#4e342e', '#ffe0b2', 0.85],
  ice_cream: ['seat', '#f48fb1', '#ffffff', 0.7, 'small'],
  bakery: ['seat', '#fff3e0', '#8d4a1c', 0.75],
  bar: ['seat', '#1b1b2f', '#ffb300', 0.3],
  pub: ['seat', '#2b1a12', '#ffcc66', 0.3],
  pharmacy: ['cross', '#ffffff', '#16883a', 0],
  chemist: ['cross', '#ffffff', '#c2185b', 0],
  bank: ['atm', '#14325c', '#ffffff', 0],
  exchange: ['atm', '#0b5d3b', '#ffd54f', 0, 'small'],
  post: ['none', '#d32f2f', '#ffffff', 0],
  clinic: ['cross', '#e3f2fd', '#1565c0', 0],
  dentist: ['none', '#e0f7fa', '#00838f', 0],
  vet: ['none', '#e8f5e9', '#2e7d32', 0],
  supermarket: ['crates', '#d32f2f', '#ffffff', 0.2, 'big'],
  convenience: ['crates', '#1e88e5', '#ffffff', 0.55],
  kiosk: ['crates', '#ffca28', '#b71c1c', 0.6, 'small'],
  greengrocer: ['crates', '#43a047', '#ffffff', 0.9],
  butcher: ['none', '#b71c1c', '#ffffff', 0.6],
  deli: ['crates', '#795548', '#fff8e1', 0.6],
  seafood: ['none', '#0277bd', '#ffffff', 0.5],
  nuts: ['crates', '#8d6e63', '#fff3e0', 0.8, 'small'],
  spices: ['crates', '#e65100', '#fff3e0', 0.8, 'small'],
  confectionery: ['none', '#ec407a', '#ffffff', 0.6, 'small'],
  alcohol: ['none', '#4a148c', '#ffffff', 0.2],
  wine: ['none', '#5b0e2d', '#ffffff', 0.3],
  coffee: ['none', '#3e2723', '#d7ccc8', 0.5],
  food: ['crates', '#6d4c41', '#ffffff', 0.4],
  florist: ['crates', '#f8bbd0', '#2e7d32', 0.7, 'small'],
  garden_centre: ['crates', '#33691e', '#ffffff', 0.3, 'big'],
  furniture: ['none', null, null, 0.1, 'big'],
  car: ['none', null, null, 0, 'big'],
  department_store: ['none', null, null, 0.1, 'big'],
  doityourself: ['none', '#ef6c00', '#ffffff', 0, 'big'],
  building_materials: ['none', '#5d4037', '#ffffff', 0, 'big'],
  hardware: ['none', '#ef6c00', '#ffffff', 0.2],
  car_repair: ['none', '#37474f', '#ffeb3b', 0, 'big'],
  tyres: ['none', '#212121', '#ffeb3b', 0],
  // Cuisines of the well-known eateries (EATERIES): sit-down fronts with their own sign colours.
  mideast: ['seat', '#1f5c4a', '#f3e6c4', 0.6],
  georgian: ['seat', '#7b1f2b', '#fbe9d0', 0.5],
  uzbek: ['seat', '#0d4f8b', '#ffd27a', 0.5],
  italian: ['seat', '#1b5e20', '#ffffff', 0.7],
  asian: ['seat', '#111111', '#e53935', 0.2],
  mexican: ['seat', '#e65100', '#fff3e0', 0.7],
  fish: ['seat', '#0b4f6c', '#ffffff', 0.6],
  steakhouse: ['seat', '#2b1a12', '#e0b070', 0.3],
  grill: ['seat', '#b71c1c', '#fff4d6', 0.7],
  // Named businesses from rishon.signs.json (offices, workshops, gyms...): a door, a window, the board.
  office: ['none', '#263238', '#ffffff', 0], workshop: ['none', '#455a64', '#ffeb3b', 0], gym: ['none', '#111111', '#76ff03', 0],
  car_wash: ['none', '#0277bd', '#ffffff', 0.3], car_rental: ['none', '#1b5e20', '#ffffff', 0], school_biz: ['none', '#3949ab', '#ffffff', 0.2],
  events: ['none', '#4a148c', '#ffd54f', 0], studio: ['none', '#212121', '#ff4081', 0], fun: ['none', '#ff6f00', '#ffffff', 0.3],
};
// rishon.signs.json kind/category -> storefront type. `company` (a named industrial or commercial
// building) gets a high name plate instead of a shop front; null = not drawn here (civic.js, etc.).
const SIGN_TYPE = {
  amenity: { bar: 'bar', pub: 'pub', nightclub: 'bar', biergarten: 'pub', restaurant: 'restaurant', cafe: 'cafe', fast_food: 'fast_food', ice_cream: 'ice_cream',
    dentist: 'dentist', doctors: 'clinic', clinic: 'clinic', veterinary: 'vet', bank: 'bank', bureau_de_change: 'exchange', post_office: 'post', pharmacy: 'pharmacy',
    car_wash: 'car_wash', car_rental: 'car_rental', driving_school: 'school_biz', language_school: 'school_biz', music_school: 'school_biz', dancing_school: 'school_biz',
    events_venue: 'events', studio: 'studio', coworking_space: 'office', gym: 'gym', kindergarten: null, childcare: null },
  leisure: { fitness_centre: 'gym', sports_centre: 'gym', dance: 'school_biz', escape_game: 'fun', amusement_arcade: 'fun', bowling_alley: 'fun', trampoline_park: 'fun' },
  healthcare: 'clinic', office: 'office', craft: 'workshop', company: 'office', building: 'company', industrial: 'company',
};
// Trades painted on the fascia of industrial roller-shutter units (generic trade names, never an
// invented business name); text under shop.trade.<key>.
const TRADES = ['garage', 'carpentry', 'metalwork', 'bodywork', 'electrician', 'plumbing', 'warehouse', 'movers', 'printing', 'upholstery',
  'aluminium', 'glass', 'tiles', 'spare_parts', 'tyres', 'wholesale', 'furniture_factory', 'bakery_supply'];
// Rishon's nightlife strip (founder): bars, pubs, restaurants and cafés with outdoor seating,
// pergolas and string lights. Matched on the road's English OSM name, so no Hebrew is needed here.
const NIGHTLIFE_STREET = /rothschild/i;
const NIGHTLIFE_FILL_MAX = 60; // generic venues added on free strip facades (OSM maps few of its bars)
const NIGHTLIFE_SPACING = 18;
// Non-food retail gets a full shop window (vitrine) instead of a door-and-window front.
const VITRINE_TYPES = new Set(['clothes', 'shoes', 'bag', 'jewelry', 'watches', 'optician', 'beauty', 'cosmetics', 'perfumery', 'gift', 'toys',
  'books', 'mobile_phone', 'electronics', 'computer', 'sports', 'outdoor', 'baby_goods', 'houseware', 'kitchenware', 'lighting', 'interior_decoration',
  'photo', 'music', 'video_games', 'stationery', 'confectionery', 'wine', 'alcohol', 'second_hand', 'shop', 'florist']);
// What stands in a shop window, by type (see display()).
const DISPLAY = {
  mannequin: ['clothes', 'bag', 'sports', 'outdoor', 'department_store', 'second_hand', 'shop'],
  shoes: ['shoes', 'shoe_repair'],
  sofa: ['furniture', 'bed', 'interior_decoration', 'carpet'],
  kitchen: ['kitchen', 'kitchenware', 'houseware'],
  lamp: ['lighting'],
  tiles: ['building_materials', 'doors'],
  shelf: ['hardware', 'doityourself', 'paint', 'car_parts', 'books', 'stationery', 'gift', 'supermarket', 'convenience', 'deli', 'pharmacy',
    'chemist', 'alcohol', 'wine', 'variety_store', 'baby_goods', 'music', 'medical_supply', 'pet', 'food', 'confectionery', 'photo', 'copyshop'],
  tv: ['electronics', 'computer', 'mobile_phone', 'video_games'],
  pedestal: ['jewelry', 'watches', 'optician', 'cosmetics', 'perfumery', 'beauty', 'hairdresser'],
  blocks: ['toys'],
  plants: ['florist', 'garden_centre'],
  tyres: ['tyres', 'car_repair'],
  car: ['car'],
};
const DISPLAY_OF = Object.fromEntries(Object.entries(DISPLAY).flatMap(([k, list]) => list.map((t) => [t, k])));
const SHUTTER_UNITS_MAX = 500; // roller-shutter units on industrial side streets

// ---------- frontages copied from street-level photos ----------
// Viewed in the Mapillary web app (https://www.mapillary.com/app/?pKey=<key>). A profile restyles every
// shop front within `r` metres of (lat, lon) whose facade faces `faces` (compass degrees, the
// direction the shop window looks; null = any). Brand parody colours are kept for chains.
const PHOTO = [
  // Lishansky, west side (design centre): full-glass ground floor with slim black mullions, a white
  // slab canopy, small black-on-white name strips on the glass head, dark timber cladding above.
  // Mapillary 8734189840040960 (2025-01-16), 611065321526258 (2025-01-16).
  { id: 'lishansky-west', lat: 31.9888, lon: 34.7642, r: 110, faces: 115, glass: 'full', mull: '#1c1c1c', step: 2.4, canopy: '#f1f1ef',
    fascia: ['#ffffff', '#111111'], signOnGlass: true, key: '8734189840040960' },
  // Lishansky, east side: red fascia frame, large printed banners on the upper floor, fence along
  // the walk. Mapillary 611065321526258, 8734189840040960 (2025-01-16).
  { id: 'lishansky-east', lat: 31.9888, lon: 34.7650, r: 110, faces: 295, fascia: ['#c62828', '#ffffff'], band: '#c62828', banners: true, fence: true,
    key: '611065321526258' },
  // Lehi, north side big-box block: dark grey cladding band, tall black sign panels, wall sconces,
  // trees on the walk, car park opposite. Mapillary 946573696145450 (2021-02-21, night; no newer).
  { id: 'lehi-bigbox', lat: 31.9865, lon: 34.7653, r: 140, faces: 205, band: '#3a3f44', fascia: ['#1d1f22', '#ffffff'], sconces: true, panel: true,
    glass: 'full', mull: '#2a2e33', step: 3.0, key: '946573696145450' },
  // Rothschild, north side fashion strip: stone piers, narrow black fascias with white letters right
  // above full-height windows, mannequins, red sale posters. Mapillary 1930172930668097 (2023-02-28).
  { id: 'rothschild-fashion', onStrip: true, lat: 31.96412, lon: 34.80147, r: 90, faces: 180, glass: 'full', mull: '#111111', step: 2.0, fascia: ['#141414', '#ffffff'],
    piers: '#cdbb98', salePosters: true, fill: ['clothes', 'shoes', 'clothes', 'jewelry', 'clothes', 'optician'], key: '1930172930668097' },
  // Rothschild at HaDegel HaIvri, south side: grocery with red-tile piers, basket stacks and trolleys
  // by the door. Mapillary 1528684747620700 (2023-02-28).
  { id: 'rothschild-grocery', onStrip: true, lat: 31.96405, lon: 34.79735, r: 20, faces: 0, piers: '#c8553d', baskets: true, fill: ['convenience'], key: '1528684747620700' },
  // ...and the café on the north corner: big white square umbrellas, black bistro chairs, a railed
  // enclosure on the sidewalk. Mapillary 1528684747620700 (2023-02-28).
  { id: 'rothschild-cafe', onStrip: true, lat: 31.96428, lon: 34.7976, r: 60, faces: 180, umbrellas: ['#f7f5ef'], square: true, chairs: '#1e1e1e', enclosure: true,
    fill: ['cafe'], key: '1528684747620700' },
  // Rothschild, south side west of Jabotinsky: arcaded shikun blocks, red boards with yellow letters
  // on the arcade beam, red-and-white awnings, red and yellow umbrellas. Mapillary 2206982192807195 (2023-02-28, 360).
  { id: 'rothschild-arcade', onStrip: true, lat: 31.96382, lon: 34.7987, r: 80, faces: 0, arcade: '#d9ccb0', fascia: ['#c62828', '#ffd54f'], awning: '#c62828',
    umbrellas: ['#c62828', '#f2c200', '#ffffff'], fill: ['falafel', 'restaurant', 'cafe', 'shop'], key: '2206982192807195' },
  // Founders Square area: white plaster colony houses, timber frames and shutters, plain boards, no
  // awnings. Mapillary 200305485211088 (2021-06-26; no newer).
  { id: 'founders-heritage', lat: 31.9643, lon: 34.8070, r: 160, faces: null, frame: '#6b4a2f', fascia: ['#f4efe6', '#5b3a24'], noAwning: true,
    key: '200305485211088' },
];
// `fill`: shop types photographed on that frontage. Free facade slots there get generic fronts of these
// types (generic names only, flagged `inferred`), because OSM maps few of those shops.
// Bulbs strung across Rothschild between these longitudes. Mapillary 2206982192807195 (2023-02-28).
const STRING_ACROSS = { lon0: 34.7968, lon1: 34.8032, spacing: 24, key: '2206982192807195' };
// The Lotto booth on Rothschild's south walk (blue canopy, orange booth). Mapillary 2206982192807195.
const LOTTO_BOOTH = { lat: 31.96382, lon: 34.79962, key: '2206982192807195' };
// ---------- well-known eateries (docs/ROUND5.md item 9) ----------
// Places people in Rishon know by name, researched 2026-10-16. Positions are the street address as
// geocoded by Nominatim (OSM), or the venue's own OSM node where one is mapped. An OSM shop within
// EATERY_MATCH of the point whose name matches (shop.eatery.<id> in either language, or the chain's
// brand aliases) is restyled in place; otherwise the eatery is added at the point. Local places show
// their real name (shop.eatery.<id>), chains their parody brand. `seat`: outdoor seating confirmed by a
// street photo or a review, drawn as a deck with two rows where the walk allows. `style` copies what a
// photo shows (chairs, awning). `rova`: a HaRova venue (see HAROVA). Sources: W1 = wanderlog.com/list/geoCategory/375484 (best dinner,
// updated 2025-11), W2 = wanderlog.com/list/geoCategory/1594771, MK = mako.co.il food (Rothschild),
// MA = maariv.co.il/food/article-483944, TR = trip.com Rishon guide, OSM = node in rishon.extras.json.
const EATERY_MATCH = 60 * SCALE;
const EATERIES = [
  // Lishansky 27, new industrial zone: contemporary Mediterranean chain (W1, W2, TR; OSM node).
  { id: 'nafis', brand: 'nafis', lat: 31.99541, lon: 34.7669, ty: 'mideast', src: 'W1 W2 TR OSM' },
  // HaRova, the old industrial zone on Moshe Becker turned pedestrian street and square (see HAROVA):
  // positions are the venues' OSM nodes where mapped (node ids from Overpass, 2026-10-16).
  { id: 'soho', rova: true, lat: 31.975399, lon: 34.809028, ty: 'asian', src: 'W1 MA, OSM node 4613908265 (Moshe Beker 15)' },
  { id: 'origami', rova: true, lat: 31.97476, lon: 34.80816, ty: 'sushi', src: 'W1 (Moshe Beker 11)' },
  { id: 'pirate_bar', rova: true, lat: 31.974758, lon: 34.808159, ty: 'pub', src: 'TR, OSM node 1831552975 (Moshe Beker 11)' },
  { id: 'nafis_harova', rova: true, brand: 'nafis', lat: 31.974055, lon: 34.808883, ty: 'mideast', src: 'OSM way 376296268 (Moshe Beker 10)' },
  { id: 'loft', rova: true, lat: 31.97541, lon: 34.808876, ty: 'steakhouse', src: 'OSM node 3811238167' },
  { id: 'kakao', rova: true, lat: 31.9751, lon: 34.809242, ty: 'cafe', src: 'OSM node 2405477825 (Moshe Beker 16)' },
  { id: 'meatball', rova: true, lat: 31.974663, lon: 34.807574, ty: 'burger', src: 'OSM node 2405421342 (HaMaccabim 8)' },
  { id: 'tarabin', rova: true, lat: 31.974448, lon: 34.810082, ty: 'bar', src: 'OSM node 2634579830 (Binyamin Shmotkin 11)' },
  { id: 'cafe_cafe_harova', rova: true, brand: 'cafe_cafe', lat: 31.975219, lon: 34.808453, ty: 'cafe', src: 'OSM node 3811246301' },
  { id: 'vivino', rova: true, brand: 'vivino', lat: 31.97444, lon: 34.809, ty: 'italian', src: 'W1 (Moshe Beker 12)' },
  { id: 'lechem_basar', rova: true, brand: 'lechem_basar', lat: 31.97515, lon: 34.80849, ty: 'steakhouse', src: 'W1 (Moshe Beker 13)' },
  { id: 'bbb', rova: true, brand: 'burgus', lat: 31.974361, lon: 34.808569, ty: 'burger', src: 'W1, OSM node 3811242915 (Moshe Beker 9)' },
  { id: 'campania', rova: true, lat: 31.97375, lon: 34.80997, ty: 'steakhouse', src: 'W1 (Barshavski 8)' },
  { id: 'sorento', rova: true, lat: 31.97375, lon: 34.80997, ty: 'italian', src: 'W1 (Barshavski 8)' },
  { id: 'herzl2', lat: 31.97518, lon: 34.81283, ty: 'shawarma', src: 'W1 (Freiman 18)' },
  { id: 'hummus_erez', lat: 31.97518, lon: 34.81283, ty: 'hummus', src: 'W2 (Freiman 18, Mika station)' },
  // Herzl street.
  { id: 'vostok', lat: 31.97304, lon: 34.8069, ty: 'uzbek', src: 'W2 OSM (Herzl 5)' },
  { id: 'beer_house', lat: 31.97146, lon: 34.80601, ty: 'pub', src: 'W1 OSM (Herzl 8)' },
  { id: 'netanel', lat: 31.96621, lon: 34.80212, ty: 'grill', src: 'W1 (Herzl 52, old central station)' },
  { id: 'deda', lat: 31.96516, lon: 34.8031, ty: 'georgian', src: 'W1 W2 OSM (Herzl 75)' },
  // Rothschild, the nightlife strip.
  { id: 'setu', lat: 31.96386, lon: 34.79887, ty: 'pizza', src: 'W1 (Rothschild 63)' },
  { id: 'sosha', lat: 31.96391, lon: 34.79818, ty: 'sushi', src: 'MK (Rothschild 69)' },
  // Rothschild 77, north walk: mixed green, red and white bistro chairs, black awnings (Mapillary 194658593174530, 2023-02-28).
  { id: 'bernard', lat: 31.96399, lon: 34.79718, ty: 'bar', seat: true, style: { chairs: ['#6aa84f', '#c62828', '#f4f4f4'], awning: '#1c1c1c' },
    src: 'W1 (Rothschild 77)', key: '194658593174530' },
  // Rothschild 83: beer garden; benches and bistro tables on the walk (Mapillary 683245006820044, 2023-02-28).
  { id: 'garden83', lat: 31.96407, lon: 34.79642, ty: 'pub', seat: true, src: 'W1 (Rothschild 83)', key: '683245006820044' },
  { id: 'vamos', lat: 31.96409, lon: 34.79625, ty: 'mexican', src: 'MK (Rothschild 85)' },
  { id: 'baribua', lat: 31.96409, lon: 34.79625, ty: 'falafel', src: 'W2 HappyCow (Rothschild 85)' },
  { id: 'pola', lat: 31.9653, lon: 34.79025, ty: 'cafe', src: 'W1 OSM (Rothschild 126)' },
  // Rotch (founder: "Rotsh"), bistro-bar at Rothschild 64: European design, outdoor seating (ontopo.com,
  // wolt.com, restaurantguru.com reviews, checked 2026-10-18). Black bistro chairs and a dark green
  // awning are ASSUMED (no photo of this front).
  { id: 'rotch', lat: 31.96411, lon: 34.79828, ty: 'bar', seat: true, style: { chairs: ['#1e1e1e'], awning: '#1f3b2d' },
    src: 'ontopo, wolt, restaurantguru (Rothschild 64); Nominatim' },
  // Pacho Bar (founder: "Apacho"), Jabotinsky 48, a block north of Rothschild: live shows, jam, jazz
  // and stand-up nights (pacho.co.il, mevalim.co.il, checked 2026-10-18). `stage`: a lit stage behind
  // the window and LIVE neon; out.stage marks it for the stage minigame.
  { id: 'pacho', lat: 31.96723, lon: 34.79979, ty: 'bar', stage: true, src: 'pacho.co.il, mevalim.co.il (Jabotinsky 48); Nominatim' },
  // The beach promenade (HaTayelet).
  { id: 'pepe', lat: 31.99885, lon: 34.73273, ty: 'fish', seat: true, style: { chairs: ['#f4f4f4'], umbrellas: ['#f7f5ef', '#1e5f8c'], square: true },
    src: 'W1 TR OSM; sea-view terrace in reviews' },
  { id: 'benny', brand: 'benny_hadayag', lat: 31.99967, lon: 34.73289, ty: 'fish', src: 'W1 TR OSM (HaTayelet 19)' },
  { id: 'adom', lat: 32.00046, lon: 34.73361, ty: 'restaurant', src: 'Nominatim building name (HaTayelet 14)' },
  // New industrial zone and the Golden Mall area.
  { id: 'fish_royal', lat: 31.99456, lon: 34.74865, ty: 'fish', src: 'W1 OSM (Paul Gruninger 4)' },
  { id: 'hazedef', lat: 31.99044, lon: 34.75114, ty: 'fish', src: 'W1 OSM (Shimon Israeli 4)' },
  { id: 'goomba', lat: 31.99249, lon: 34.77307, ty: 'italian', src: 'W1 OSM (Lazarov 23)' },
  { id: 'agadir', brand: 'agadir', lat: 31.99186, lon: 34.77503, ty: 'burger', src: 'W1 (Lazarov 33)' },
  { id: 'tzipora', brand: 'tzipora', lat: 31.98947, lon: 34.77418, ty: 'grill', src: 'W1 (David Saharov 26)' },
];
// HaRova ("the Quarter", founder: "Mitcham HaRov"): Rishon's nightlife complex. landmarks.js paves the
// square (OSM way 377731453, footprint 'harova_square') and dresses it; here every facade facing the
// square or the Moshe Becker / Barshavski walk within `r` metres is a venue front in the complex's
// industrial-chic look: black steel glazing and canopy, a corten band, brick piers, wall sconces, a
// dark fascia with neon-coloured letters and neon OPEN signs. The look is ASSUMED: Mapillary has no
// imagery of Moshe Becker or the square (checked 2026-10-16). Free facades there get generic venues
// (names never invented, flagged `inferred`), at most `fillMax`.
const HAROVA = { lat: 31.97465, lon: 34.80895, r: 150, street: /moshe beck?er|barshavsk/i, fillMax: 18 };
const ROVA_LOOK = { id: 'harova', rova: true, glass: 'full', mull: '#1a1a1a', step: 2.2, corten: '#7a3b22', piers: '#8c4a32', canopy: '#1f1f1f',
  sconces: true, neon: true, fascia: ['#141414', '#ff4fb5'] };
const NEON = ['#ff4fb5', '#3ad6ff', '#ffd23f', '#7cff6b', '#ff7a3a'];
const BIG_TYPES = new Set(Object.keys(TYPES).filter((k) => TYPES[k][4] === 'big'));
// Showrooms: big glass fronts with a fascia sign, facing the main road. Always for these types in an
// industrial or commercial zone (founder: west Rishon industrial area first), and for big-box types anywhere.
const SHOWROOM_TYPES = new Set(['car', 'car_parts', 'tyres', 'furniture', 'kitchen', 'lighting', 'carpet', 'bed', 'doors', 'electronics',
  'computer', 'department_store', 'doityourself', 'building_materials', 'hardware', 'paint', 'sports', 'outdoor', 'bicycle', 'interior_decoration',
  'houseware', 'kitchenware', 'baby_goods', 'toys', 'garden_centre', 'variety_store', 'supermarket', 'car_repair', 'shop']);
const KNOWN = new Set(['falafel', 'shawarma', 'hummus', 'fast_food', 'pizza', 'burger', 'sushi', 'restaurant', 'cafe', 'ice_cream', 'bakery', 'bar',
  'pub', 'pharmacy', 'chemist', 'bank', 'exchange', 'post', 'clinic', 'dentist', 'vet', 'supermarket', 'convenience', 'kiosk', 'greengrocer', 'butcher',
  'deli', 'seafood', 'nuts', 'spices', 'confectionery', 'alcohol', 'wine', 'coffee', 'food', 'clothes', 'shoes', 'shoe_repair', 'bag', 'jewelry',
  'watches', 'optician', 'beauty', 'cosmetics', 'perfumery', 'hairdresser', 'pet_grooming', 'pet', 'florist', 'garden_centre', 'furniture', 'kitchen',
  'kitchenware', 'houseware', 'lighting', 'carpet', 'bed', 'interior_decoration', 'doors', 'paint', 'hardware', 'doityourself', 'building_materials',
  'electronics', 'computer', 'mobile_phone', 'photo', 'books', 'stationery', 'toys', 'baby_goods', 'sports', 'outdoor', 'bicycle', 'fishing', 'gift',
  'variety_store', 'department_store', 'car', 'car_repair', 'tyres', 'car_parts', 'ticket', 'dry_cleaning', 'laundry', 'tailor', 'travel_agency',
  'lottery', 'music', 'video_games', 'second_hand', 'copyshop', 'medical_supply']);
const SHOP_ALIAS = {
  building_material: 'building_materials', jewellery: 'jewelry', fashion: 'clothes', boutique: 'clothes', electrical: 'electronics',
  appliance: 'electronics', mobile: 'mobile_phone', telecommunication: 'mobile_phone', newsagent: 'kiosk', frozen_food: 'food', health_food: 'food',
  pastry: 'bakery', fish: 'seafood', cheese: 'deli', chocolate: 'confectionery', beverages: 'alcohol', fabric: 'gift', craft: 'gift', art: 'gift',
  antiques: 'second_hand', charity: 'second_hand', musical_instrument: 'music', games: 'video_games', hifi: 'electronics', radiotechnics: 'electronics',
  motorcycle: 'car', hearing_aids: 'medical_supply', massage: 'beauty', nail_salon: 'beauty', tattoo: 'beauty', tobacco: 'kiosk', e_cigarette: 'kiosk',
  water: 'food', bookmaker: 'lottery', yes: 'shop',
};
const AMENITY = {
  restaurant: 'restaurant', cafe: 'cafe', fast_food: 'fast_food', bar: 'bar', pub: 'pub', ice_cream: 'ice_cream', pharmacy: 'pharmacy', bank: 'bank',
  bureau_de_change: 'exchange', post_office: 'post', clinic: 'clinic', dentist: 'dentist', doctors: 'clinic', veterinary: 'vet',
  nightclub: 'bar', biergarten: 'pub',
};
// Not a storefront (or not for this game): adult shops, empty units, fuel stations, malls (directory).
const SKIP_SHOP = new Set(['vacant', 'erotic', 'fuel', 'no', 'disused', 'mall', 'adult']);

// Brand id -> [category, sign bg, sign fg]. Aliases and display names live in shops.<lang>.json.
const BRANDS = {
  shufersal: ['supermarket', '#d6001c', '#ffffff'], rami_levy: ['supermarket', '#0b4ea2', '#ffd400'], victory: ['supermarket', '#e30613', '#ffffff'],
  yochananof: ['supermarket', '#00843d', '#ffffff'], osher_ad: ['supermarket', '#ffd200', '#1d3c8f'], yeinot_bitan: ['supermarket', '#7c1d3a', '#ffffff'],
  hazi_hinam: ['supermarket', '#f47b20', '#ffffff'], carrefour: ['supermarket', '#1f4fa3', '#ffffff'], tiv_taam: ['supermarket', '#0a7a3d', '#ffffff'],
  yellow: ['convenience', '#6a2c91', '#ffffff'], alonit: ['convenience', '#00a0df', '#ffffff'], sogood: ['convenience', '#8bc34a', '#ffffff'],
  coop: ['supermarket', '#e4002b', '#ffffff'], stopmarket: ['supermarket', '#2e7d32', '#ffffff'], am_pm: ['convenience', '#1a1a1a', '#ff5a00'],
  super_cofix: ['supermarket', '#00a6a6', '#ffffff'],
  super_pharm: ['pharmacy', '#003da5', '#ffffff'], good_pharm: ['pharmacy', '#e5007e', '#ffffff'], be: ['pharmacy', '#00b2a9', '#ffffff'],
  maccabi_pharm: ['pharmacy', '#0d47a1', '#ffffff'], new_pharm: ['pharmacy', '#ffffff', '#e91e63'],
  mcdonalds: ['burger', '#da291c', '#ffc72c'], burger_king: ['burger', '#f5ebdc', '#d62300'], burgers_bar: ['burger', '#111111', '#f2c400'],
  burgus: ['burger', '#222222', '#ff7a00'], dominos: ['pizza', '#006491', '#ffffff'], pizza_hut: ['pizza', '#c8102e', '#ffffff'],
  kfc: ['fast_food', '#a3080c', '#ffffff'], moses: ['burger', '#1d1d1b', '#e94e1b'], japanika: ['sushi', '#111111', '#e60012'],
  agadir: ['burger', '#2b2b2b', '#ffb000'], shipudei_hatikva: ['restaurant', '#b71c1c', '#ffffff'], giraffe: ['restaurant', '#ffcc00', '#222222'],
  prego: ['restaurant', '#2e7d32', '#ffffff'], max_brenner: ['cafe', '#3e2723', '#f5e6c8'], roladin: ['bakery', '#f8e1e7', '#7b1e3c'],
  golda: ['ice_cream', '#f7c6d9', '#6b2b48'], iceberg: ['ice_cream', '#bfe9ff', '#0b4f8a'], cafe_cafe: ['cafe', '#5a2d0c', '#ffffff'],
  aroma: ['cafe', '#111111', '#e0262e'], cofix: ['cafe', '#ffd100', '#111111'], landwer: ['cafe', '#0e3b2e', '#f3e4c0'],
  greg: ['cafe', '#4a2c2a', '#ffffff'], cafe_joe: ['cafe', '#c62828', '#ffffff'], arcaffe: ['cafe', '#222222', '#ffffff'],
  hapoalim: ['bank', '#e30613', '#ffffff'], leumi: ['bank', '#00a1de', '#ffffff'], discount: ['bank', '#00843d', '#ffffff'],
  mizrahi: ['bank', '#f58025', '#ffffff'], first_international: ['bank', '#002f6c', '#ffffff'], otsar_hahayal: ['bank', '#1c3f94', '#ffffff'],
  yahav: ['bank', '#00529b', '#ffffff'], jerusalem: ['bank', '#6d2077', '#ffffff'], mercantile: ['bank', '#00843d', '#ffffff'],
  castro: ['clothes', '#111111', '#ffffff'], fox: ['clothes', '#ffffff', '#111111'], fox_home: ['houseware', '#ffffff', '#6b8e23'],
  golf: ['clothes', '#0c2340', '#ffffff'], honigman: ['clothes', '#b0005a', '#ffffff'], h_and_o: ['clothes', '#ffffff', '#e10600'],
  hm: ['clothes', '#e50010', '#ffffff'], zara: ['clothes', '#000000', '#ffffff'], renuar: ['clothes', '#ffffff', '#222222'],
  terminal_x: ['clothes', '#000000', '#ffffff'], tnt: ['clothes', '#e10600', '#ffffff'], urbanica: ['clothes', '#222222', '#e6e6e6'],
  delta: ['clothes', '#003b71', '#ffffff'], intima: ['clothes', '#f3c6d3', '#7a1f3d'], adidas: ['sports', '#000000', '#ffffff'],
  nike: ['sports', '#111111', '#ffffff'], decathlon: ['sports', '#0082c3', '#ffffff'], mega_sport: ['sports', '#e30613', '#ffffff'],
  american_eagle: ['clothes', '#0f2b5b', '#ffffff'], hamashbir: ['department_store', '#c8102e', '#ffffff'], max_stock: ['variety_store', '#e30613', '#ffd400'],
  ace: ['hardware', '#d71920', '#ffffff'], home_center: ['doityourself', '#ff6a13', '#ffffff'], ikea: ['furniture', '#0058a3', '#ffda1a'],
  kravitz: ['stationery', '#e2001a', '#ffffff'], office_depot: ['stationery', '#cc0000', '#ffffff'], steimatzky: ['books', '#ffffff', '#c8102e'],
  tzomet_sfarim: ['books', '#1d3c8f', '#ffffff'], ksp: ['computer', '#000000', '#ffcc00'], bug: ['electronics', '#e30613', '#ffffff'],
  ivory: ['computer', '#1d3c8f', '#ffffff'], mahsanei_hashmal: ['electronics', '#0055a5', '#ffd400'], shekem_electric: ['electronics', '#e30613', '#ffffff'],
  naaman: ['houseware', '#003b5c', '#ffffff'], shilav: ['baby_goods', '#7ac143', '#ffffff'], rosen_meents: ['furniture', '#3a3a3a', '#ffffff'],
  wine_more: ['alcohol', '#5b0e2d', '#ffffff'], cellcom: ['mobile_phone', '#6a1b9a', '#ffffff'], partner: ['mobile_phone', '#00b3e3', '#ffffff'],
  pelephone: ['mobile_phone', '#0066b3', '#ffffff'], hot: ['mobile_phone', '#e4002b', '#ffffff'], toys_r_us: ['toys', '#0d6eb8', '#ffffff'],
  pandora: ['jewelry', '#ffffff', '#222222'], lotto: ['lottery', '#e30613', '#ffffff'], optica_halperin: ['optician', '#0a2a5c', '#ffffff'],
  simmons: ['bed', '#003a70', '#ffffff'], negev_ceramics: ['building_materials', '#3a3a3a', '#ffffff'], nirlat: ['paint', '#e30613', '#ffffff'],
  teva_castel: ['kitchen', '#ffffff', '#2e5a88'], shomrat: ['kitchen', '#4b6b2f', '#ffffff'],
  nafis: ['restaurant', '#1f5c4a', '#f3e6c4'], vivino: ['restaurant', '#7a1f2b', '#ffffff'], lechem_basar: ['restaurant', '#2b2b2b', '#f2c14e'],
  tzipora: ['restaurant', '#c62828', '#ffffff'], benny_hadayag: ['restaurant', '#0b4f6c', '#ffffff'],
  hyundai: ['car', '#002c5f', '#ffffff'], kia: ['car', '#05141f', '#ffffff'], nissan: ['car', '#c3002f', '#ffffff'], skoda: ['car', '#4ba82e', '#ffffff'],
  seat: ['car', '#222222', '#e30613'], infiniti: ['car', '#1a1a1a', '#ffffff'], toyota: ['car', '#eb0a1e', '#ffffff'], mazda: ['car', '#101010', '#ffffff'],
  azrieli: ['mall', '#0f2a4a', '#ffffff'], g_city: ['mall', '#111111', '#ffffff'], big: ['mall', '#e30613', '#ffffff'],
  golden_mall: ['mall', '#f7b52c', '#ffffff'], cinema_city: ['mall', '#c8102e', '#ffffff'],
};

// Sign colours for local shops of types without a fixed style: a warm, readable palette.
const PALETTE = [['#1e4f8a', '#ffffff'], ['#b23a48', '#ffffff'], ['#2e7d5b', '#ffffff'], ['#f2b134', '#3b2a10'], ['#6a4c93', '#ffffff'],
  ['#ffffff', '#c0392b'], ['#263238', '#ffd166'], ['#e76f51', '#ffffff'], ['#f4f1de', '#264653'], ['#00838f', '#ffffff']];
const AWNING = ['#d1495b', '#2e86ab', '#3c9d5d', '#f29e4c', '#7b5ea7', '#c0392b', '#127369', '#e9c46a'];
const CRATE = ['#2e7d32', '#1565c0', '#8d6e63', '#c62828', '#455a64'];
const PRODUCE = { greengrocer: ['#ff9800', '#8bc34a', '#e53935', '#ffeb3b', '#7cb342'], nuts: ['#a1887f', '#6d4c41', '#d7ccc8', '#ffcc80'],
  spices: ['#e65100', '#c62828', '#fdd835', '#6d4c41'], kiosk: ['#1e88e5', '#e53935', '#43a047', '#fdd835'], florist: ['#e91e63', '#ffeb3b', '#ab47bc', '#ff7043'],
  default: ['#ff9800', '#e53935', '#8bc34a', '#1e88e5', '#fdd835'] };

// ---------- small helpers ----------

function hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function inPoly(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const k = l2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
  const cx = ax + dx * k, cz = az + dz * k;
  return [Math.hypot(px - cx, pz - cz), cx, cz];
}
const norm = (s) => String(s || '').toLowerCase().replace(QUOTES, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const signedArea2 = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x, z] = r[i], [x2, z2] = r[(i + 1) % r.length]; a += x * z2 - x2 * z; } return a; };

class Grid {
  constructor(cell) { this.c = cell; this.m = new Map(); this.stamp = 0; }
  add(minX, minZ, maxX, maxZ, item) {
    const c = this.c;
    for (let i = Math.floor(minX / c); i <= Math.floor(maxX / c); i++) {
      for (let j = Math.floor(minZ / c); j <= Math.floor(maxZ / c); j++) {
        const k = `${i},${j}`;
        let l = this.m.get(k);
        if (!l) this.m.set(k, (l = []));
        l.push(item);
      }
    }
  }
  query(x, z, r, fn) {
    const c = this.c, s = ++this.stamp;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const l = this.m.get(`${i},${j}`);
        if (!l) continue;
        for (const it of l) { if (it._s === s) continue; it._s = s; fn(it); }
      }
    }
  }
}

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// ---------- names ----------

function buildMatcher(tables) {
  const aliases = [];
  for (const tb of tables) {
    for (const [id, list] of Object.entries((tb && tb.match) || {})) {
      if (!BRANDS[id]) continue;
      for (const a of list) {
        const exact = a.startsWith('=');
        const toks = norm(exact ? a.slice(1) : a).split(' ').filter(Boolean);
        if (toks.length) aliases.push({ id, toks, exact, len: toks.join(' ').length });
      }
    }
  }
  // Earliest match in the name wins (so "Naaman HaZahav Mall" is Naaman), then the longest alias.
  return (text) => {
    const n = norm(text);
    if (!n) return null;
    const toks = n.split(' ');
    let best = null;
    for (const a of aliases) {
      let at = -1;
      if (a.exact) { if (n === a.toks.join(' ')) at = 0; } else {
        for (let i = 0; i + a.toks.length <= toks.length && at < 0; i++) {
          let ok = true;
          for (let k = 0; k < a.toks.length && ok; k++) ok = toks[i + k] === a.toks[k];
          if (ok) at = i;
        }
      }
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && a.len > best.len)) best = { id: a.id, at, len: a.len };
    }
    return best ? best.id : null;
  };
}

function buildCuisine(tables) {
  const list = [];
  for (const tb of tables) for (const [k, words] of Object.entries((tb && tb.cuisine) || {})) for (const w of words) list.push([k, norm(w)]);
  return (text) => {
    const n = ` ${norm(text)} `;
    for (const [k, w] of list) if (w && n.includes(` ${w} `)) return k;
    for (const [k, w] of list) if (w && w.length >= 4 && n.includes(w)) return k;
    return null;
  };
}

function cleanName(s) {
  let n = String(s || '').split(/\s[-–—]\s/)[0].replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (n.length > 24) { const cut = n.slice(0, 24); n = (cut.lastIndexOf(' ') > 12 ? cut.slice(0, cut.lastIndexOf(' ')) : cut) + '…'; }
  return n;
}

// ---------- geometry kits ----------

function kit(parts) {
  const geos = parts.map(([g, hex]) => {
    const geo = g.index ? g.toNonIndexed() : g;
    const c = new THREE.Color(hex), n = geo.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'color'].includes(k)) geo.deleteAttribute(k);
    return geo;
  });
  return mergeGeometries(geos);
}
const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const cyl = (rt, rb, h, x = 0, y = 0, z = 0, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z);

// Awning of unit width: sloped canvas from the wall (z=0, y=0) out to z=1.5, then a short valance.
function awningGeometry() {
  const p = [], uv = [], idx = [];
  const quad = (a, b, c, d, v0, v1) => {
    const o = p.length / 3;
    p.push(...a, ...b, ...c, ...d);
    uv.push(0, v0, 1, v0, 1, v1, 0, v1);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  quad([-0.5, 0, 0], [0.5, 0, 0], [0.5, -0.5, 1.5], [-0.5, -0.5, 1.5], 1, 0.3);
  quad([-0.5, -0.5, 1.5], [0.5, -0.5, 1.5], [0.5, -0.8, 1.52], [-0.5, -0.8, 1.52], 0.3, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 4;
  const x = c.getContext('2d');
  for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#000000' : '#ffffff'; x.fillRect(i * 16, 0, 16, 4); }
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}

// Roller shutter: horizontal slats, tinted per instance.
function shutterTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 64;
  const x = c.getContext('2d');
  for (let i = 0; i < 16; i++) { x.fillStyle = '#ffffff'; x.fillRect(0, i * 4, 4, 3); x.fillStyle = '#b9bcbf'; x.fillRect(0, i * 4 + 3, 4, 1); }
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}

// ---------- instance pools with distance culling ----------

class Pool {
  // `attrs`: extra per-instance attributes, { name: itemSize }, filled from add()'s `extra`.
  constructor(name, geometry, material, { shadow = false, attrs = {} } = {}) {
    Object.assign(this, { name, geometry, material, shadow, attrs });
    this.m = []; this.c = []; this.p = []; this.range = [];
    this.x = Object.fromEntries(Object.keys(attrs).map((k) => [k, []]));
    this.mesh = null;
  }
  add(matrix, color, range, extra = {}) {
    for (let i = 0; i < 16; i++) this.m.push(matrix.elements[i]);
    const col = color instanceof THREE.Color ? color : new THREE.Color(color ?? 0xffffff);
    this.c.push(col.r, col.g, col.b);
    this.p.push(matrix.elements[12], matrix.elements[14]);
    this.range.push(range * range);
    for (const [k, n] of Object.entries(this.attrs)) for (let i = 0; i < n; i++) this.x[k].push(extra[k] ? extra[k][i] : 0);
  }
  get size() { return this.P ? this.P.length / 2 : this.p.length / 2; }
  build(group) {
    const n = this.size;
    if (!n) return null;
    const names = Object.keys(this.attrs);
    const geo = names.length ? this.geometry.clone() : this.geometry;
    const mesh = new THREE.InstancedMesh(geo, this.material, n);
    mesh.name = `storefront-${this.name}`;
    mesh.frustumCulled = false;
    mesh.castShadow = this.shadow;
    mesh.receiveShadow = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.X = names.map((k) => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * this.attrs[k]), this.attrs[k]);
      geo.setAttribute(k, attr);
      return { attr, src: new Float32Array(this.x[k]), size: this.attrs[k] };
    });
    this.M = new Float32Array(this.m); this.C = new Float32Array(this.c); this.P = new Float32Array(this.p); this.R2 = new Float32Array(this.range);
    this.m = this.c = this.p = this.range = this.x = null;
    this.mesh = mesh;
    group.add(mesh);
    this.refresh(null);
    return mesh;
  }
  // Packs the instances within range of `cam` (all of them for null) to the front of the buffers.
  refresh(cam) {
    const mesh = this.mesh;
    if (!mesh) return 0;
    const im = mesh.instanceMatrix.array, ic = mesh.instanceColor.array, X = this.X;
    let k = 0;
    for (let i = 0, n = this.P.length / 2; i < n; i++) {
      if (cam) { const dx = this.P[i * 2] - cam.x, dz = this.P[i * 2 + 1] - cam.z; if (dx * dx + dz * dz > this.R2[i]) continue; }
      im.set(this.M.subarray(i * 16, i * 16 + 16), k * 16);
      ic[k * 3] = this.C[i * 3]; ic[k * 3 + 1] = this.C[i * 3 + 1]; ic[k * 3 + 2] = this.C[i * 3 + 2];
      for (const e of X) e.attr.array.set(e.src.subarray(i * e.size, i * e.size + e.size), k * e.size);
      k++;
    }
    mesh.count = k;
    mesh.visible = k > 0; // an empty InstancedMesh would still cost a draw call
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    for (const e of X) e.attr.needsUpdate = true;
    return k;
  }
}

// ---------- sign atlas ----------

// 'mask' pages hold one byte per pixel (text coverage); the shader colours each sign from its
// instance colours, so every sign costs a quarter of an RGBA cell. 'rgba' is for the directories.
class Atlas {
  constructor(mode) { this.mode = mode; this.pages = []; this.cache = new Map(); }
  page() {
    const c = document.createElement('canvas');
    c.width = PAGE; c.height = PAGE;
    const pg = { canvas: c, ctx: c.getContext('2d'), x: 0, y: 0, rowH: 0 };
    this.pages.push(pg);
    return pg;
  }
  alloc(w, h) {
    let pg = this.pages[this.pages.length - 1] || this.page();
    if (pg.x + w > PAGE) { pg.x = 0; pg.y += pg.rowH + GUTTER; pg.rowH = 0; }
    if (pg.y + h > PAGE) pg = this.page();
    const r = { page: this.pages.length - 1, x: pg.x, y: pg.y, w, h };
    pg.x += w + GUTTER; pg.rowH = Math.max(pg.rowH, h);
    return { r, ctx: pg.ctx };
  }
  // Cached by content: every generic "falafel" sign shares one cell. Drawing waits for finish(),
  // which packs tall directory cells first so they never leave half-empty sign rows.
  get(key, w, h, draw) {
    let r = this.cache.get(key);
    if (r) return r;
    r = { page: -1, x: 0, y: 0, w, h, draw };
    this.cache.set(key, r);
    return r;
  }
  // Packs and draws every cell, crops the last page to its used height (less texture memory) and
  // makes the textures.
  finish() {
    const cells = [...this.cache.values()].sort((a, b) => b.h - a.h);
    for (const r of cells) {
      const a = this.alloc(r.w, r.h);
      Object.assign(r, { page: a.r.page, x: a.r.x, y: a.r.y });
      r.draw(a.ctx, r.x, r.y, r.w, r.h);
      r.draw = null;
    }
    if (!this.pages.length) this.page();
    this.textures = this.pages.map((pg, i) => {
      let canvas = pg.canvas;
      const used = Math.min(PAGE, pg.y + pg.rowH + GUTTER);
      if (i === this.pages.length - 1 && used < PAGE) {
        const c = document.createElement('canvas');
        c.width = PAGE; c.height = Math.max(64, Math.ceil(used / 64) * 64);
        c.getContext('2d').drawImage(canvas, 0, 0);
        canvas = c;
      }
      pg.h = canvas.height;
      let tx;
      if (this.mode === 'mask') {
        const rgba = canvas.getContext('2d').getImageData(0, 0, PAGE, pg.h).data, a = new Uint8Array(PAGE * pg.h);
        for (let j = 0; j < a.length; j++) a[j] = rgba[j * 4];
        tx = new THREE.DataTexture(a, PAGE, pg.h, THREE.RedFormat, THREE.UnsignedByteType);
        tx.generateMipmaps = true;
        tx.minFilter = THREE.LinearMipmapLinearFilter;
        tx.magFilter = THREE.LinearFilter;
        tx.needsUpdate = true;
      } else {
        tx = new THREE.CanvasTexture(canvas);
        tx.colorSpace = THREE.SRGBColorSpace;
      }
      tx.anisotropy = 4;
      pg.canvas = pg.ctx = null;
      return tx;
    });
    this.bytes = this.pages.reduce((s, pg) => s + PAGE * pg.h * (this.mode === 'mask' ? 1 : 4) * 1.33, 0);
  }
  // Mask pages are uploaded top row first (no flip), so their V axis runs downwards.
  uv(r) {
    const h = this.pages[r.page].h;
    return this.mode === 'mask' ? [r.x / PAGE, (r.y + r.h) / h, r.w / PAGE, -r.h / h] : [r.x / PAGE, 1 - (r.y + r.h) / h, r.w / PAGE, r.h / h];
  }
}

function fitFont(ctx, text, size, maxW, weight = 800) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) { size = Math.max(10, size * (maxW / w)); ctx.font = `${weight} ${size}px ${FONT}`; }
  return size;
}

function drawSign(ctx, x, y, w, h, lab) {
  ctx.save();
  ctx.fillStyle = lab.bg;
  ctx.fillRect(x - GUTTER / 2, y - GUTTER / 2, w + GUTTER, h + GUTTER); // bleed into the gutter so mipmaps keep the board colour
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.globalAlpha = 0.35; ctx.strokeStyle = lab.fg; ctx.lineWidth = 3; ctx.strokeRect(x + 6, y + 6, w - 12, h - 12); ctx.globalAlpha = 1;
  ctx.fillStyle = lab.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.direction = RTL_CHARS.test(lab.main) ? 'rtl' : 'ltr';
  fitFont(ctx, lab.main, lab.sub ? h * 0.5 : h * 0.62, w * 0.88);
  ctx.fillText(lab.main, x + w / 2, y + (lab.sub ? h * 0.4 : h * 0.54));
  if (lab.sub) {
    ctx.direction = RTL_CHARS.test(lab.sub) ? 'rtl' : 'ltr';
    ctx.globalAlpha = 0.85;
    fitFont(ctx, lab.sub, h * 0.22, w * 0.8, 600);
    ctx.fillText(lab.sub, x + w / 2, y + h * 0.8);
  }
  ctx.restore();
}

function drawDirectory(ctx, x, y, w, h, d) {
  const rtl = isRtl();
  ctx.save();
  ctx.fillStyle = '#1f2d4d'; ctx.fillRect(x - GUTTER / 2, y - GUTTER / 2, w + GUTTER, h + GUTTER);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = d.bg; ctx.fillRect(x, y, w, 112);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = d.fg;
  ctx.direction = RTL_CHARS.test(d.name) ? 'rtl' : 'ltr';
  fitFont(ctx, d.name, 50, w * 0.9);
  ctx.fillText(d.name, x + w / 2, y + 52);
  ctx.globalAlpha = 0.85; ctx.direction = rtl ? 'rtl' : 'ltr';
  fitFont(ctx, d.title, 22, w * 0.9, 600);
  ctx.fillText(d.title, x + w / 2, y + 95);
  ctx.globalAlpha = 1;
  const lineH = 42, top = y + 124, max = Math.floor((h - 140) / lineH);
  const items = d.items.length > max ? d.items.slice(0, max - 1) : d.items;
  items.forEach((it, i) => {
    const ly = top + i * lineH;
    if (i % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x + 10, ly, w - 20, lineH); }
    ctx.fillStyle = it.bg; ctx.fillRect(rtl ? x + w - 30 : x + 14, ly + 12, 16, 18);
    ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle';
    ctx.direction = RTL_CHARS.test(it.text) ? 'rtl' : 'ltr';
    ctx.textAlign = rtl ? 'right' : 'left';
    fitFont(ctx, it.text, 26, w - 60, 600);
    ctx.fillText(it.text, rtl ? x + w - 40 : x + 40, ly + lineH / 2 + 1);
  });
  if (d.items.length > items.length) {
    ctx.fillStyle = '#c9d4ea'; ctx.textAlign = 'center'; ctx.direction = rtl ? 'rtl' : 'ltr';
    const more = t('shop.ui.more', { n: d.items.length - items.length });
    fitFont(ctx, more, 22, w * 0.9, 600);
    ctx.fillText(more, x + w / 2, top + items.length * lineH + lineH / 2);
  }
  ctx.restore();
}

// ---------- main ----------

export async function buildStorefronts(scene, city, extras) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'storefronts';
  const stats = { source: '', shops: 0, storefronts: 0, mallListed: 0, directories: 0, skipped: 0, landmark: 0, unplaced: 0,
    showrooms: 0, pavilions: 0, vitrines: 0, bays: 0, displays: 0, displayCars: 0, stickers: 0, posters: 0, neons: 0, shutters: 0, shutterUnits: 0, bands: 0, stalls: 0, baskets: 0, photoMatched: 0, photoFill: 0, signsAdded: 0, signsDuplicate: 0, planters: 0, menuBoards: 0, nameplates: 0, tradeSigns: 0, stages: 0, eateryMatched: 0, eateryAdded: 0, eateryPlaced: 0, eaterySeats: 0, rovaFronts: 0, rovaFill: 0, rovaSeats: 0, stringsAcross: 0, nightlife: 0, nightlifeFill: 0, barCounters: 0, pergolas: 0, bulbs: 0, seats: 0, parody: 0, genericChain: 0, local: 0, generic: 0, inferredFood: 0, tables: 0, crates: 0, counters: 0, crosses: 0, awnings: 0 };

  // ---- text tables ----
  const lang = i18n.lang || 'he';
  const [act, en] = await Promise.all([
    getJson(`${DATA}i18n/shops.${lang}.json`).catch(() => ({})),
    lang === 'en' ? Promise.resolve(null) : getJson(`${DATA}i18n/shops.en.json`).catch(() => ({})),
  ]);
  // Hebrew aliases are needed to recognise chains even when playing in English.
  const he = lang === 'he' ? act : await getJson(`${DATA}i18n/shops.he.json`).catch(() => ({}));
  register('shop', act, en || act);
  const matchBrand = buildMatcher([act, en, he]);
  const matchCuisine = buildCuisine([act, en, he]);
  if (typeof document !== 'undefined' && document.fonts) {
    const sample = Object.values(act.type || {}).slice(0, 30).join(' ') || 'Shop';
    await Promise.race([Promise.all([document.fonts.load('800 48px Rubik', sample), document.fonts.load('600 24px Rubik', sample)]).catch(() => {}),
      new Promise((r) => setTimeout(r, 2500))]);
  }

  // ---- shop data ----
  let shopsIn = [], zones = [];
  try {
    let ex = extras && Array.isArray(extras.shops) ? extras : null;
    if (!ex) ex = await getJson(`${DATA}rishon.extras.json`);
    const k = ex.meta && ex.meta.scale ? SCALE / ex.meta.scale : 1;
    shopsIn = (ex.shops || []).map((s) => ({ ...s, x: s.x * k, z: s.z * k }));
    zones = (ex.industrial || []).filter((z) => z.points && z.points.length >= 3).map((z) => {
      const pts = z.points.map(([x, zz]) => [x * k, zz * k]);
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, zz] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, zz); maxZ = Math.max(maxZ, zz); }
      return { pts, minX, minZ, maxX, maxZ, name: z.nameEn || z.name || '', landuse: z.landuse };
    });
    stats.source = 'rishon.extras.json';
    // Named non-shop businesses (tools/fetch_osm_signs.py). Optional: without it only shops show.
    try {
      const sg = await getJson(`${DATA}rishon.signs.json`);
      const ks = sg.meta && sg.meta.scale ? SCALE / sg.meta.scale : 1;
      const near = new Grid(40);
      for (const q of shopsIn) near.add(q.x, q.z, q.x, q.z, q);
      for (const g of sg.signs || []) {
        const m = SIGN_TYPE[g.kind];
        const ty = typeof m === 'string' ? m : m ? m[g.cat] : null;
        if (!ty) continue;
        const x = g.x * ks, z = g.z * ks, nm = [g.name, g.nameLocal].map(norm).filter(Boolean);
        let dup = false;
        near.query(x, z, 30, (q) => { if (!dup && (Math.hypot(q.x - x, q.z - z) < 4 || [q.name, q.nameLocal].map(norm).some((n) => n && nm.includes(n)))) dup = true; });
        if (dup) { stats.signsDuplicate++; continue; }
        shopsIn.push({ x, z, name: g.name, nameLocal: g.nameLocal, brand: g.brand, shop: '', amenity: '', level: null, presetTy: ty, sign: g.kind, osm: g.osm });
        stats.signsAdded++;
      }
    } catch { /* no signs file */ }
  } catch (e) {
    try {
      const d = await getJson(`${DATA}rishon.json`);
      const k = d.meta && d.meta.scale ? SCALE / d.meta.scale : 1;
      shopsIn = (d.amenities || []).map(([amenity, name, nameLocal, x, z]) => ({ x: x * k, z: z * k, name, nameLocal, brand: '', shop: '', amenity, level: null }));
      stats.source = 'rishon.json amenities (fallback)';
    } catch (e2) { console.warn('[storefronts] no shop data', e2.message); }
  }

  // ---- landmarks (shops inside them get no facade) ----
  let landmarks = [];
  try { landmarks = ((await import('./landmarks.js')).LANDMARK_FOOTPRINTS || []).filter((l) => l.points && l.points.length >= 3); } catch { /* optional */ }

  // ---- display cars reuse the traffic agent's models (read-only; optional) ----
  let vehicles = null;
  try { vehicles = await import('../vehicles/models.js'); } catch { /* no models: dealers show empty stalls */ }

  // ---- ground: heightAt with a very low walker returns the bare terrain ----
  const ground = (x, z) => (typeof city.heightAt === 'function' ? city.heightAt(x, z, -1e9) : 0);
  const surface = (x, z, y) => (typeof city.heightAt === 'function' ? city.heightAt(x, z, y + 0.6) : 0);

  // ---- buildings ----
  const blds = [];
  const bgrid = new Grid(48);
  for (const c of city.colliders || []) {
    if (!c || !c.points || c.points.length < 3) continue;
    if (c.kind !== 'building' && !(c.kind == null && c.height > 3)) continue;
    const pts = c.points;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
    // groundH (optional, world units): the ground-floor band height drawn by buildings.js, so signs
    // can sit in its sign band. Without it the front height is estimated.
    const b = { id: blds.length, pts, s: signedArea2(pts) > 0 ? 1 : -1, minX, minZ, maxX, maxZ, top: c.height ?? 8, base: c.base, gh: c.groundH, edges: null };
    blds.push(b);
    bgrid.add(minX, minZ, maxX, maxZ, b);
  }
  const edgesOf = (b) => {
    if (b.edges) return b.edges;
    b.edges = [];
    for (let i = 0; i < b.pts.length; i++) {
      const [ax, az] = b.pts[i], [bx, bz] = b.pts[(i + 1) % b.pts.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-3) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      // Interior lies left of each edge on a positive-area ring, so the outward normal is to its right.
      const nx = b.s > 0 ? uz : -uz, nz = b.s > 0 ? -ux : ux;
      b.edges.push({ b, i, ax, az, ux, uz, nx, nz, L });
    }
    return b.edges;
  };
  const buildingAt = (x, z, except) => {
    let hit = null;
    bgrid.query(x, z, 0, (b) => { if (!hit && b !== except && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && inPoly(x, z, b.pts)) hit = b; });
    return hit;
  };
  const landmarkAt = (x, z) => landmarks.find((l) => inPoly(x, z, l.points)) || null;
  // ---- HaRova zone: the square footprint (landmarks.js) and a radius around the complex ----
  const rovaC = project(HAROVA.lat, HAROVA.lon), rovaR2 = (HAROVA.r * SCALE) ** 2;
  const rovaSq = (landmarks.find((l) => l.id === 'harova_square') || {}).points || null;
  const inRova = (x, z) => (x - rovaC.x) ** 2 + (z - rovaC.z) ** 2 <= rovaR2;
  // Inner part of the square, where landmarks.js stands its own terraces: storefront tables keep out.
  const rovaInner = rovaSq ? (() => { const n = rovaSq.length, mx = rovaSq.reduce((a, p) => a + p[0], 0) / n, mz = rovaSq.reduce((a, p) => a + p[1], 0) / n;
    return rovaSq.map(([x, z]) => [mx + (x - mx) * 0.8, mz + (z - mz) * 0.8]); })() : null;
  const facesSquare = (px, pz, nx, nz) => !!rovaSq && inRova(px, pz) && [2, 5, 9, 14, 20].some((k) => inPoly(px + nx * k, pz + nz * k, rovaSq));
  const zoneAt = (x, z) => zones.find((q) => x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ && inPoly(x, z, q.pts)) || null;

  // ---- streets ----
  const rgrid = new Grid(40);
  const stripRoads = [];
  for (const r of city.roads || []) {
    if (!r.points || r.points.length < 2 || r.tunnel || r.bridge) continue;
    const k = r.kind || '';
    let pen = null;
    if (/^motorway/.test(k)) pen = 30;
    else if (r.rank != null || /^(trunk|primary|secondary|tertiary|residential|unclassified|living_street|road)(_link)?$/.test(k)) pen = 0;
    else if (k === 'pedestrian') pen = 1;
    else if (k === 'service') pen = 8;
    else if (/^(footway|path|cycleway|steps|promenade)$/.test(k)) pen = 12;
    if (pen == null) continue;
    const hw = (r.width || 6) / 2;
    const strip = pen <= 1 && NIGHTLIFE_STREET.test(r.nameEn || '');
    if (strip) stripRoads.push({ pts: r.points, hw });
    const rovaRoad = pen <= 1 && HAROVA.street.test(r.nameEn || '');
    for (let i = 0; i < r.points.length - 1; i++) {
      const [ax, az] = r.points[i], [bx, bz] = r.points[i + 1];
      const rova = rovaRoad && inRova((ax + bx) / 2, (az + bz) / 2);
      rgrid.add(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw,
        { ax, az, bx, bz, hw, pen, car: pen === 0, major: /^(trunk|primary|secondary)(_link)?$/.test(k), strip: strip || rova, rova });
    }
  }
  // The street in front of a facade point: nearest segment within ~60 degrees of the outward normal.
  // `majorBonus` lets showrooms prefer a facade on a main road over a side street.
  const streetFront = (px, pz, nx, nz, majorBonus = 0) => {
    let best = null;
    rgrid.query(px, pz, ROAD_REACH, (s) => {
      const [d, cx, cz] = segDist(px, pz, s.ax, s.az, s.bx, s.bz);
      if (d > ROAD_REACH || d < 0.01) return;
      if (((cx - px) * nx + (cz - pz) * nz) / d < 0.5) return;
      const pen = s.pen - (s.major ? majorBonus : 0);
      const eff = Math.max(0, d - s.hw), score = eff + pen;
      if (!best || score < best.score) best = { d: eff, pen, score, car: s.car, major: s.major, strip: s.strip, rova: s.rova };
    });
    return best;
  };
  const onCarriage = typeof city.onCarriage === 'function' ? (x, z, m) => city.onCarriage(x, z, m) : (x, z, m) => {
    let hit = false;
    rgrid.query(x, z, 2, (s) => { if (!hit && s.car && segDist(x, z, s.ax, s.az, s.bx, s.bz)[0] < s.hw + m) hit = true; });
    return hit;
  };
  // Free distance from the facade outwards until the carriageway or another building.
  const clearance = (px, pz, nx, nz) => {
    for (let d = 0.5; d <= 14; d += 0.5) {
      const x = px + nx * d, z = pz + nz * d;
      if (onCarriage(x, z, 0.3) || buildingAt(x, z, null)) return d - 0.5;
    }
    return 14;
  };

  // ---- classify ----
  const typeOf = (s) => {
    let ty = null;
    if (s.shop) { if (SKIP_SHOP.has(s.shop)) return null; ty = SHOP_ALIAS[s.shop] || (KNOWN.has(s.shop) ? s.shop : 'shop'); } else if (s.amenity) ty = AMENITY[s.amenity] || null;
    if (!ty) return null;
    const names = `${s.name || ''} ${s.nameLocal || ''}`;
    const cu = String(s.cuisine || '');
    if (ty === 'fast_food' || ty === 'restaurant') {
      if (/falafel/.test(cu)) ty = 'falafel';
      else if (/shawarma|kebab/.test(cu)) ty = 'shawarma';
      else if (/pizza/.test(cu)) ty = 'pizza';
      else if (/burger/.test(cu)) ty = 'burger';
      else if (/sushi|japanese/.test(cu)) ty = 'sushi';
      else if (/hummus/.test(cu)) ty = 'hummus';
      else { const c = matchCuisine(names); if (c && c !== 'kiosk') ty = c; }
    } else if (ty === 'convenience' && matchCuisine(names) === 'kiosk') ty = 'kiosk';
    else if (ty === 'cafe' && /ice_cream/.test(cu)) ty = 'ice_cream';
    return ty;
  };

  const labelOf = (s, ty, brandId, chain) => {
    const typeText = t(`shop.type.${ty}`, null, ty);
    const st = TYPES[ty] || [];
    if (brandId) {
      const [, bg, fg] = BRANDS[brandId];
      return { main: t(`shop.brand.${brandId}`, null, brandId), sub: null, bg, fg, kind: 'parody' };
    }
    const pal = PALETTE[Math.floor(hash(`${s.x},${s.z}`) * PALETTE.length)];
    const bg = st[1] || pal[0], fg = st[2] || pal[1];
    if (chain) return { main: typeText, sub: null, bg, fg, kind: 'genericChain' };
    const raw = lang !== 'en' ? (RTL_CHARS.test(s.nameLocal || '') ? s.nameLocal : s.name || s.nameLocal) : (s.name || s.nameLocal);
    const nm = cleanName(raw);
    if (nm && norm(nm) !== norm(typeText)) return { main: nm, sub: typeText, bg: pal[0], fg: pal[1], kind: 'local' };
    return { main: typeText, sub: null, bg, fg, kind: 'generic' };
  };

  // ---- records and malls ----
  const malls = [];
  const records = [];
  for (const s of shopsIn) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) continue;
    stats.shops++;
    const brandId = matchBrand(s.brand) || matchBrand(s.name) || matchBrand(s.nameLocal);
    if (s.shop === 'mall') {
      const lm = landmarkAt(s.x, s.z);
      const b = lm ? null : buildingAt(s.x, s.z, null);
      const mallBrand = brandId && BRANDS[brandId][0] === 'mall' ? brandId : null;
      const name = mallBrand ? t(`shop.brand.${mallBrand}`) : cleanName(lang !== 'en' ? (s.nameLocal || s.name) : (s.name || s.nameLocal)) || t('shop.type.mall');
      const [bg, fg] = mallBrand ? BRANDS[mallBrand].slice(1) : PALETTE[Math.floor(hash(s.name) * PALETTE.length)];
      malls.push({ s, lm, b, name, bg, fg, members: [] });
      continue;
    }
    let ty = s.presetTy || typeOf(s);
    if (!ty) { stats.skipped++; continue; }
    const useBrand = brandId && BRANDS[brandId][0] !== 'mall' ? brandId : null;
    const chain = !useBrand && !!(s.brand && String(s.brand).trim());
    if (useBrand && ty === 'shop') ty = BRANDS[useBrand][0];
    let inferred = false;
    // Unnamed snack bars with no cuisine tag: the street needs falafel and shawarma, and these are
    // by far the most common fast food in Rishon. Marked `inferred` in the output.
    if (ty === 'fast_food' && !useBrand && !s.name && !s.nameLocal && !s.cuisine) { ty = hash(`${s.x}|${s.z}`) < 0.5 ? 'falafel' : 'shawarma'; inferred = true; stats.inferredFood++; }
    records.push({ s, ty, brand: useBrand, lab: labelOf(s, ty, useBrand, chain), inferred });
  }
  const mallOf = (x, z) => {
    for (const m of malls) {
      if (m.lm && inPoly(x, z, m.lm.points)) return m;
      if (m.b && x >= m.b.minX && x <= m.b.maxX && z >= m.b.minZ && z <= m.b.maxZ && inPoly(x, z, m.b.pts)) return m;
    }
    return null;
  };

  // ---- well-known eateries: restyle the matching OSM shop, or add the place at its address ----
  const eateryLabel = (E, s) => {
    if (E.brand) return { ...labelOf(s, E.ty, E.brand, false), sub: t(`shop.type.${E.ty}`, null, E.ty) };
    const st = TYPES[E.ty] || TYPES.restaurant;
    return { main: t(`shop.eatery.${E.id}`, null, E.id), sub: t(`shop.type.${E.ty}`, null, E.ty), bg: st[1], fg: st[2], kind: 'local' };
  };
  for (const E of EATERIES) {
    const c = project(E.lat, E.lon);
    const names = [act, en, he].map((tb) => tb && tb.eatery && tb.eatery[E.id]).filter(Boolean).map(norm);
    const named = (r) => [r.s.name, r.s.nameLocal].map(norm).some((n) => n && names.some((m) => n === m || n.includes(m) || (n.length >= 4 && m.includes(n))));
    let best = null;
    for (const r of records) {
      if (r.eatery) continue;
      const d = Math.hypot(r.s.x - c.x, r.s.z - c.z);
      if (d > EATERY_MATCH || (best && d >= best.d)) continue;
      if (E.brand ? r.brand === E.brand : named(r)) best = { r, d };
    }
    let rec = best && best.r;
    if (rec) stats.eateryMatched++;
    else {
      rec = { s: { x: c.x, z: c.z, name: '', nameLocal: '' }, brand: E.brand || null, inferred: false };
      records.push(rec);
      stats.shops++;
      stats.eateryAdded++;
    }
    Object.assign(rec, { ty: E.ty, eatery: E, lab: eateryLabel(E, rec.s) });
  }

  // ---- pools ----
  const toon = (opts) => new THREE.MeshToonMaterial(opts);
  const unit = box(1, 1, 1);
  const awnMat = toon({ map: stripeTexture(), side: THREE.DoubleSide });
  awnMat.onBeforeCompile = (sh) => {
    // Stripe map: black texels take the instance colour, white ones stay canvas-cream.
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>',
      '#ifdef USE_COLOR\n diffuseColor.rgb = mix(vColor, vec3(0.96, 0.94, 0.88), clamp(diffuseColor.r, 0.0, 1.0));\n#endif');
  };
  awnMat.customProgramCacheKey = () => 'storefront-awning';
  const vc = toon({ vertexColors: true });
  const pools = {
    frame: new Pool('frame', unit, toon({ color: 0xffffff })),
    glass: new Pool('glass', unit, toon({ color: 0xffffff, emissive: 0x0b1a26 })),
    board: new Pool('board', unit, toon({ color: 0xffffff }), { shadow: true }),
    awning: new Pool('awning', awningGeometry(), awnMat, { shadow: true }),
    counter: new Pool('counter', kit([[box(2.2, 1.1, 0.9, 0, 0.55, 0), '#c9ced3'], [box(2.24, 0.06, 0.94, 0, 1.12, 0), '#8f989f']]), vc, { shadow: true }),
    trays: new Pool('trays', kit([[box(0.4, 0.12, 0.3, -0.75, 0, 0), '#4caf50'], [box(0.4, 0.12, 0.3, -0.25, 0, 0), '#e53935'],
      [box(0.4, 0.12, 0.3, 0.25, 0, 0), '#fdd835'], [cyl(0.2, 0.2, 0.25, 0.75, 0.06, 0), '#e8c48a']]), vc),
    spit: new Pool('spit', kit([[cyl(0.035, 0.035, 1.3, 0, 0.65, 0, 6), '#9e9e9e'], [cyl(0.2, 0.3, 0.85, 0, 0.6, 0, 9), '#8d4a1f']]), vc),
    crate: new Pool('crate', box(0.8, 0.42, 0.6, 0, 0.21, 0), toon({ color: 0xffffff })),
    produce: new Pool('produce', box(0.7, 0.14, 0.5, 0, 0.47, 0), toon({ color: 0xffffff })),
    table: new Pool('table', kit([[cyl(0.55, 0.55, 0.06, 0, 1.0, 0, 14), '#f2efe8'], [cyl(0.05, 0.05, 1.0, 0, 0.5, 0, 6), '#555555'],
      [cyl(0.3, 0.3, 0.04, 0, 0.02, 0, 10), '#555555']]), vc),
    chair: new Pool('chair', kit([[box(0.55, 0.08, 0.55, 0, 0.58, 0), '#ffffff'], [box(0.55, 0.62, 0.08, 0, 0.9, -0.24), '#ffffff'],
      [box(0.05, 0.58, 0.05, -0.22, 0.29, 0.22), '#777777'], [box(0.05, 0.58, 0.05, 0.22, 0.29, 0.22), '#777777'],
      [box(0.05, 0.58, 0.05, -0.22, 0.29, -0.22), '#777777'], [box(0.05, 0.58, 0.05, 0.22, 0.29, -0.22), '#777777']]), toon({ vertexColors: true })),
    pole: new Pool('pole', cyl(0.05, 0.05, 2.9, 0, 1.45, 0, 6), toon({ color: 0xdddddd })),
    canopy: new Pool('canopy', new THREE.ConeGeometry(1.5, 0.6, 8, 1, true).translate(0, 3.0, 0), toon({ color: 0xffffff, side: THREE.DoubleSide }), { shadow: true }),
    cross: new Pool('cross', kit([[box(0.08, 1.1, 1.1), '#ffffff'], [box(0.14, 0.8, 0.26), '#18a33c'], [box(0.14, 0.26, 0.8), '#18a33c']]), vc),
    atm: new Pool('atm', kit([[box(0.75, 1.15, 0.14), '#b0b6bc'], [box(0.5, 0.36, 0.04, 0, 0.2, 0.08), '#1d3557'], [box(0.5, 0.1, 0.06, 0, -0.18, 0.08), '#333333']]), vc),
    pylon: new Pool('pylon', box(1, 1, 1, 0, 0.5, 0), toon({ color: 0xffffff }), { shadow: true }),
    wood: new Pool('wood', box(1, 1, 1, 0, 0.5, 0), toon({ color: 0xffffff }), { shadow: true }),
    bar: new Pool('bar', kit([[box(2.2, 1.1, 0.8, 0, 0.55, 0), '#5b3a24'], [box(2.3, 0.08, 0.95, 0, 1.14, 0.05), '#2b1a10'],
      [cyl(0.03, 0.03, 0.35, -0.5, 1.35, -0.2, 6), '#d4af37'], [cyl(0.03, 0.03, 0.35, 0, 1.35, -0.2, 6), '#d4af37'],
      [cyl(0.03, 0.03, 0.35, 0.5, 1.35, -0.2, 6), '#d4af37'], [cyl(0.05, 0.04, 0.16, 0.7, 1.26, 0.2, 8), '#f2c14e']]), vc, { shadow: true }),
    stool: new Pool('stool', kit([[cyl(0.24, 0.24, 0.08, 0, 1.0, 0, 10), '#ffffff'], [cyl(0.035, 0.035, 1.0, 0, 0.5, 0, 6), '#555555'],
      [cyl(0.2, 0.2, 0.03, 0, 0.35, 0, 10), '#555555']]), vc),
    bulb: new Pool('bulb', new THREE.IcosahedronGeometry(0.09, 0), new THREE.MeshBasicMaterial({ color: 0xffffff })),
    // Window glass in front of the display: see-through, so the props and the lit back read.
    pane: new Pool('pane', unit, new THREE.MeshToonMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false })),
    shutter: new Pool('shutter', unit, toon({ map: shutterTexture() })),
    poster: new Pool('poster', unit, toon({ color: 0xffffff })),
    line: new Pool('line', unit, toon({ color: 0xffffff })),
    mannequin: new Pool('mannequin', kit([[cyl(0.28, 0.28, 0.05, 0, 0.03, 0, 10), '#555555'], [cyl(0.03, 0.03, 0.5, 0, 0.3, 0, 6), '#555555'],
      [box(0.46, 1.25, 0.26, 0, 1.15, 0), '#d9d9d9'], [box(0.74, 1.05, 0.36, 0, 2.3, 0), '#ffffff'], [box(0.86, 0.22, 0.38, 0, 2.72, 0), '#ffffff'],
      [cyl(0.07, 0.08, 0.16, 0, 2.9, 0, 6), '#efe9e1'], [new THREE.IcosahedronGeometry(0.21, 1).translate(0, 3.12, 0), '#efe9e1']]), vc),
    sofa: new Pool('sofa', kit([[box(2.4, 0.42, 0.72, 0, 0.42, 0), '#ffffff'], [box(2.4, 0.72, 0.18, 0, 0.92, -0.27), '#ffffff'],
      [box(0.2, 0.55, 0.72, -1.1, 0.68, 0), '#e6e6e6'], [box(0.2, 0.55, 0.72, 1.1, 0.68, 0), '#e6e6e6'], [box(0.7, 0.3, 0.12, -0.5, 0.95, -0.12), '#f4f4f4'],
      [box(2.3, 0.2, 0.66, 0, 0.11, 0), '#6b4a2f'], [box(0.5, 0.5, 0.5, 1.75, 0.25, 0), '#a1887f'], [cyl(0.03, 0.03, 0.9, 1.75, 0.95, 0, 6), '#333333'],
      [cyl(0.12, 0.28, 0.32, 1.75, 1.5, 0, 10), '#fff3d6']]), vc),
    tv: new Pool('tv', kit([[box(1.9, 0.62, 0.5, 0, 0.31, 0), '#3a3a3a'], [box(1.7, 1.0, 0.08, 0, 1.35, -0.05), '#151a22'], [box(1.56, 0.86, 0.02, 0, 1.35, 0.0), '#3f7fd8'],
      [box(0.08, 0.25, 0.08, 0, 0.75, -0.05), '#222222'], [box(0.5, 0.7, 0.06, 0.65, 0.97, 0.12), '#202020'], [box(0.42, 0.6, 0.02, 0.65, 0.97, 0.16), '#6ec1ff']]), vc),
    shelf: new Pool('shelf', kit([[box(0.08, 2.4, 0.45, -0.8, 1.2, 0), '#8d6e63'], [box(0.08, 2.4, 0.45, 0.8, 1.2, 0), '#8d6e63'],
      ...[0.1, 0.85, 1.6, 2.35].map((y) => [box(1.68, 0.06, 0.45, 0, y, 0), '#a1887f']),
      ...[[0.12, '#e53935'], [0.87, '#1e88e5'], [1.62, '#fdd835']].flatMap(([y, c], i) => [-0.5, -0.05, 0.42].map((x, j) =>
        [box(0.36, 0.42 + ((i + j) % 3) * 0.1, 0.3, x, y + 0.03 + (0.42 + ((i + j) % 3) * 0.1) / 2, 0), ['#e53935', '#1e88e5', '#fdd835', '#43a047', '#ff7043', '#8e24aa'][(i * 2 + j) % 6]]))]), vc),
    kitchen: new Pool('kitchen', kit([[box(2.6, 1.0, 0.6, 0, 0.5, 0), '#ffffff'], [box(2.7, 0.08, 0.66, 0, 1.04, 0.02), '#3b3b3b'],
      [box(2.6, 0.8, 0.34, 0, 2.3, -0.13), '#ffffff'], [box(0.7, 0.32, 0.42, 0.6, 1.75, -0.1), '#b0b0b0'], [box(0.5, 0.03, 0.4, -0.6, 1.1, 0), '#222222'],
      ...[-0.9, -0.3, 0.3, 0.9].map((x) => [box(0.3, 0.03, 0.03, x, 0.85, 0.31), '#888888'])]), vc),
    lamp: new Pool('lamp', kit([[cyl(0.015, 0.015, 1.0, 0, -0.5, 0, 4), '#222222'], [cyl(0.12, 0.38, 0.32, 0, -1.12, 0, 12), '#ffffff']]), vc),
    tiles: new Pool('tiles', kit([[box(0.9, 1.9, 0.06, -1.05, 1.0, -0.2), '#e8e4dc'], [box(0.9, 1.9, 0.06, 0, 1.0, -0.22), '#9aa4ab'],
      [box(0.9, 1.9, 0.06, 1.05, 1.0, -0.2), '#c8a27a'], ...[0.45, 0.95, 1.45].map((y) => [box(2.9, 0.012, 0.07, 0, y, -0.18), '#ffffff']),
      [box(0.45, 0.42, 0.55, -0.6, 0.21, 0.12), '#fbfbfb'], [box(0.45, 0.45, 0.16, -0.6, 0.62, -0.08), '#fbfbfb'],
      [cyl(0.1, 0.12, 0.8, 0.7, 0.4, 0.1, 8), '#fbfbfb'], [box(0.6, 0.14, 0.42, 0.7, 0.86, 0.1), '#fbfbfb']]), vc),
    pedestal: new Pool('pedestal', kit([[box(0.45, 1.1, 0.4, 0, 0.55, 0), '#f5f5f5'], [box(0.62, 0.06, 0.5, 0, 1.13, 0), '#d8d8d8'],
      [box(0.12, 0.1, 0.12, -0.15, 1.21, 0), '#d4af37'], [cyl(0.05, 0.05, 0.16, 0.12, 1.24, 0.05, 8), '#c0c0c0'], [box(0.14, 0.06, 0.1, 0.05, 1.19, -0.12), '#e91e63']]), vc),
    blocks: new Pool('blocks', kit([[box(0.5, 0.5, 0.5, -0.4, 0.25, 0), '#e53935'], [box(0.5, 0.5, 0.5, 0.15, 0.25, 0.05), '#1e88e5'],
      [box(0.45, 0.45, 0.45, -0.15, 0.72, 0), '#fdd835'], [new THREE.IcosahedronGeometry(0.3, 1).translate(0.65, 0.3, 0), '#43a047'],
      [box(0.35, 0.6, 0.25, 0.9, 0.3, -0.1), '#8e24aa']]), vc),
    plants: new Pool('plants', kit([[cyl(0.32, 0.24, 0.5, -0.5, 0.25, 0, 10), '#b5651d'], [new THREE.IcosahedronGeometry(0.5, 1).translate(-0.5, 0.85, 0), '#43a047'],
      [cyl(0.26, 0.2, 0.4, 0.45, 0.2, 0, 10), '#8d6e63'], [new THREE.IcosahedronGeometry(0.36, 1).translate(0.45, 0.62, 0), '#e91e63']]), vc),
    tyres: new Pool('tyres', kit([0, 1, 2].map((i) => [cyl(0.45, 0.45, 0.26, 0, 0.14 + i * 0.27, 0, 14), '#1f1f1f'])
      .concat([[cyl(0.2, 0.2, 0.83, 0, 0.42, 0, 10), '#9e9e9e']])), vc, { shadow: true }),
  };
  pools.umbrellaSq = new Pool('umbrella-sq', kit([[new THREE.ConeGeometry(2.1, 0.45, 4, 1, true).rotateY(Math.PI / 4).translate(0, 3.1, 0), '#ffffff'],
    [box(2.9, 0.18, 2.9, 0, 2.85, 0), '#ffffff']]), toon({ vertexColors: true, side: THREE.DoubleSide }), { shadow: true });
  pools.baskets = new Pool('baskets', kit([0, 1, 2, 3, 4, 5].map((i) => [box(0.62, 0.17, 0.42, 0, 0.09 + i * 0.15, 0), i % 2 ? '#1e4fb4' : '#d32f2f'])), vc);
  pools.trolley = new Pool('trolley', kit([[box(0.62, 0.5, 0.95, 0, 0.85, 0), '#b0b6bb'], [box(0.66, 0.05, 0.05, 0, 1.2, -0.55), '#cc2b2b'],
    [box(0.05, 0.7, 0.05, -0.28, 0.35, 0.4), '#8a9096'], [box(0.05, 0.7, 0.05, 0.28, 0.35, 0.4), '#8a9096'], [box(0.05, 0.7, 0.05, -0.28, 0.35, -0.4), '#8a9096'],
    [box(0.05, 0.7, 0.05, 0.28, 0.35, -0.4), '#8a9096']]), vc);
  // Display cars: the traffic agent's own models, one pool per body style.
  const carKinds = ['sedan', 'suv', 'hatch'];
  if (vehicles && vehicles.buildKindGeometry && vehicles.vehicleMaterial) {
    for (const k of carKinds) { try { pools[`car_${k}`] = new Pool(`car-${k}`, vehicles.buildKindGeometry(k, 0), vehicles.vehicleMaterial(), { shadow: true }); } catch { /* skip */ } }
  }
  const carPaint = (k, key) => (vehicles && vehicles.pickPaint ? vehicles.pickPaint(k, () => hash(key)) : new THREE.Color(PALETTE[Math.floor(hash(key) * PALETTE.length)][0]));
  // Sign text: coverage mask from the atlas, background from instanceColor, ink from fgColor.
  const maskMat = (tex, i) => {
    const m = new THREE.MeshBasicMaterial({ map: tex });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 uvRect;\nattribute vec3 fgColor;\nvarying vec3 vFg;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = uvRect.xy + uv * uvRect.zw;\n#endif\n vFg = fgColor;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vFg;')
        .replace('#include <map_fragment>', 'float signInk = texture2D(map, vMapUv).r;')
        .replace('#include <color_fragment>', '#ifdef USE_COLOR\n diffuseColor.rgb = mix(vColor, vFg, signInk) * 0.92;\n#endif');
    };
    m.customProgramCacheKey = () => `storefront-mask-${i}`;
    return m;
  };
  const textMat = (tex, i) => {
    const m = new THREE.MeshBasicMaterial({ map: tex, color: 0xe6e6e6 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 uvRect;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = uvRect.xy + uv * uvRect.zw;\n#endif');
    };
    m.customProgramCacheKey = () => `storefront-text-${i}`;
    return m;
  };
  const atlas = new Atlas('mask'), dirAtlas = new Atlas('rgba');
  const pendingText = []; // [atlas, rect, matrix, range, bg, fg] until the atlas pages are final
  const MASK_INK = (lab) => ({ ...lab, bg: '#000000', fg: '#ffffff' });
  const signRect = (lab) => atlas.get(`s|${lab.main}|${lab.sub || ''}`, CELL_W, CELL_H, (ctx, x, y, cw, chh) => drawSign(ctx, x, y, cw, chh, MASK_INK(lab)));

  // Facade frame: origin on the wall, local +x along the facade, +z out to the street.
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const frameAt = (x, z, nx, nz, y) => ({ x, z, nx, nz, ax: nz, az: -nx, th: Math.atan2(nx, nz), y });
  const world = (f, lx, lz) => [f.x + f.ax * lx + f.nx * lz, f.z + f.az * lx + f.nz * lz];
  const matrix = (f, lx, ly, lz, sx, sy, sz, rotY = 0, yAbs = null) => {
    const [wx, wz] = world(f, lx, lz);
    _v.set(wx, yAbs ?? f.y + ly, wz);
    _q.setFromAxisAngle(Y, f.th + rotY);
    _s.set(sx, sy, sz);
    return _m.compose(_v, _q, _s);
  };
  const put = (pool, f, lx, ly, lz, sx, sy, sz, color, range, rotY = 0) => pool.add(matrix(f, lx, ly, lz, sx, sy, sz, rotY), color, range);
  // Props stand on the walkable surface (sidewalk top or ground) at their own spot.
  const putOnGround = (pool, f, lx, lz, s, color, range, rotY = 0, ly = 0) => {
    const [wx, wz] = world(f, lx, lz);
    pool.add(matrix(f, lx, 0, lz, s, s, s, rotY, surface(wx, wz, f.y) + ly), color, range);
  };
  const text = (at, rect, f, lx, ly, lz, w, h, range, rotY = 0, bg = '#ffffff', fg = '#000000') =>
    pendingText.push([at, rect, matrix(f, lx, ly, lz, w, h, 1, rotY).clone(), range, bg, fg]);
  const colliders = [];
  const rectCollider = (f, lx, lz, hw, hd, height) => {
    const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([a, b]) => world(f, lx + a, lz + b));
    colliders.push({ kind: 'prop', height: f.y + height, points: pts });
  };

  // ---- placement ----
  const occ = new Map();
  const bands = new Set();
  const allocate = (e, tc, w) => {
    const key = `${e.b.id}:${e.i}`, list = occ.get(key) || [];
    const pad = 0.4;
    for (const ww of [w, Math.max(MIN_W, w * 0.7)]) {
      if (e.L < ww + 2 * pad) continue;
      const lo = pad + ww / 2, hi = e.L - pad - ww / 2, step = Math.max(1, ww * 0.5);
      for (let k = 0; k < 40; k++) {
        const c = clamp(tc + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step, lo, hi);
        if (list.some(([a, b]) => c - ww / 2 < b + 0.4 && c + ww / 2 > a - 0.4)) continue;
        list.push([c - ww / 2, c + ww / 2]);
        occ.set(key, list);
        return { c, w: ww };
      }
    }
    return null;
  };
  const candidates = (sx, sz, majorBonus = 0) => {
    const out = [];
    bgrid.query(sx, sz, R_SEARCH, (b) => {
      if (sx < b.minX - R_SEARCH || sx > b.maxX + R_SEARCH || sz < b.minZ - R_SEARCH || sz > b.maxZ + R_SEARCH) return;
      const inside = inPoly(sx, sz, b.pts);
      for (const e of edgesOf(b)) {
        if (e.L < MIN_W + 0.8) continue;
        const tc = clamp((sx - e.ax) * e.ux + (sz - e.az) * e.uz, 0, e.L);
        const dist = Math.hypot(sx - (e.ax + e.ux * tc), sz - (e.az + e.uz * tc));
        if (dist > R_SEARCH) continue;
        // A node outside its building usually stands on the shop's street side of the wall.
        const side = inside ? 0 : ((sx - e.ax) * e.nx + (sz - e.az) * e.nz) > 0 ? -2 : 4;
        out.push({ e, tc, dist, inside, side });
      }
    });
    out.sort((a, b) => a.dist - b.dist);
    const scored = [];
    for (const c of out.slice(0, 14)) {
      const { e } = c, tm = clamp(c.tc, Math.min(e.L / 2, 2), Math.max(e.L / 2, e.L - 2));
      const px = e.ax + e.ux * tm, pz = e.az + e.uz * tm;
      if (buildingAt(px + e.nx * 1.2, pz + e.nz * 1.2, null)) continue; // party wall or closed courtyard
      const st = streetFront(px, pz, e.nx, e.nz, majorBonus);
      c.score = c.dist * (c.inside ? 0.7 : 1) + c.side + (st ? st.d * 0.45 + st.pen : 60);
      c.street = st;
      scored.push(c);
    }
    scored.sort((a, b) => a.score - b.score);
    return scored;
  };

  // Nearest drivable street, main roads preferred.
  const nearestRoad = (x, z, reach) => {
    let best = null;
    rgrid.query(x, z, reach, (sg) => {
      if (sg.pen > 1) return;
      const [d, cx, cz] = segDist(x, z, sg.ax, sg.az, sg.bx, sg.bz);
      if (d > reach) return;
      const sc = d - sg.hw - (sg.major ? 8 : 0);
      if (!best || sc < best.sc) best = { d, cx, cz, sc, major: sg.major, hw: sg.hw };
    });
    return best;
  };
  const pavilions = [];
  const pavilion = (rec, out, big) => {
    const { s, lab } = rec;
    const W = big ? 16 : 4.6, D = big ? 10 : 3.6, H = big ? 6.6 : 3.8;
    const r = nearestRoad(s.x, s.z, 70 * SCALE);
    if (!r || r.d < 1) return false;
    const nx = (r.cx - s.x) / r.d, nz = (r.cz - s.z) / r.d;
    const probe = [[-W / 2, 0.3], [W / 2, 0.3], [-W / 2, -D], [W / 2, -D], [0, -D / 2], [0, 3], [-W / 2, 3], [W / 2, 3]];
    for (let back = 0; back <= 30; back += 2) {
      // Centre on the node, stepping back from the street until the forecourt is clear.
      const cx = s.x - nx * back, cz = s.z - nz * back, fx = cx + (nx * D) / 2, fz = cz + (nz * D) / 2;
      if (pavilions.some((p) => Math.hypot(p[0] - cx, p[1] - cz) < (p[2] + W) / 2 + 1)) continue;
      const f0 = frameAt(fx, fz, nx, nz, 0);
      const pts = probe.map(([a, b]) => world(f0, a, b));
      if (!pts.every(([x, z]) => !onCarriage(x, z, 0.5) && !buildingAt(x, z, null) && !landmarkAt(x, z))) continue;
      const f = frameAt(fx, fz, nx, nz, Math.min(...pts.slice(0, 5).map(([x, z]) => ground(x, z))));
      pavilions.push([cx, cz, W]);
      put(pools.frame, f, 0, H / 2 - 0.3, -D / 2, W, H + 0.6, D, '#e9e7e2', RANGE_FRONT);
      put(pools.frame, f, 0, H + 0.15, -D / 2, W + 0.8, 0.3, D + 0.8, '#8f969c', RANGE_FRONT);
      const gTop = H * 0.74;
      put(pools.glass, f, 0, gTop / 2 + 0.05, 0.03, W - 0.6, gTop - 0.2, 0.08, '#8db8d2', RANGE_FRONT);
      if (big) {
        for (const sd of [-1, 1]) put(pools.glass, f, sd * (W / 2 + 0.03), gTop / 2 + 0.05, -D / 2 + 1, 0.08, gTop - 0.2, D - 2.6, '#8db8d2', RANGE_FRONT);
        const nm = Math.round((W - 0.6) / 2.8);
        for (let k = 1; k < nm; k++) put(pools.frame, f, -W / 2 + 0.3 + (k * (W - 0.6)) / nm, gTop / 2, 0.09, 0.14, gTop - 0.2, 0.1, '#59616b', RANGE_FRONT);
        put(pools.glass, f, W / 2 - 1.8, gTop * 0.3, 0.1, 2.2, gTop * 0.58, 0.06, '#4a6f8c', RANGE_FRONT);
      }
      const sh = Math.min(H - gTop - 0.2, big ? 1.6 : 0.95), sy = gTop + 0.1 + sh / 2;
      put(pools.board, f, 0, sy, 0.2, W - 0.4, sh, 0.36, lab.bg, RANGE_FRONT);
      const qh = sh * 0.92;
      text(atlas, signRect(lab), f, 0, sy, 0.385, Math.min(W - 0.5, qh * (CELL_W / CELL_H)), qh, big ? RANGE_DIR : RANGE_FRONT, 0, lab.bg, lab.fg);
      rectCollider(f, 0, -D / 2, W / 2, D / 2, H);
      stats.pavilions++;
      stats[lab.kind]++;
      Object.assign(out, { kind: 'pavilion', fx, fz, nx, nz, width: W, showroom: big, mainRoad: r.major, zone: out.zone });
      return { f, W, H };
    }
    return false;
  };

  // ---- outdoor seating (exported for the crowd) ----
  // seat: { x, z, y (seat surface), ground, angle, kind, faceX, faceZ }. `angle` is rotation.y for a
  // model whose front is +z; the seated person then faces the table or bar at (faceX, faceZ).
  const seats = [];
  let seatPlace = null; // id of the well-known eatery whose seats are being laid out (seat.place)
  let seatArea = null; // named nightlife area of the venue (seat.area), e.g. 'harova'
  const seatAt = (f, lx, lz, rotY, kind, sitH, tx, tz) => {
    const [x, z] = world(f, lx, lz);
    const gy = surface(x, z, f.y);
    const [fx, fz] = world(f, tx, tz);
    seats.push({ x: +x.toFixed(2), z: +z.toFixed(2), y: +(gy + sitH).toFixed(2), ground: +gy.toFixed(2), angle: +(f.th + rotY).toFixed(4), kind, faceX: +fx.toFixed(2), faceZ: +fz.toFixed(2), ...(seatPlace ? { place: seatPlace } : {}), ...(seatArea ? { area: seatArea } : {}) });
    if (seatPlace) stats.eaterySeats++;
    if (seatArea === 'harova') stats.rovaSeats++;
  };
  const venueOf = (ty) => (ty === 'bar' || ty === 'pub' ? 'bar' : /^(cafe|ice_cream|bakery|coffee)$/.test(ty) ? 'cafe' : 'restaurant');
  const putAbs = (pool, f, lx, lz, yAbs, sx, sy, sz, color, range, rotY = 0) => pool.add(matrix(f, lx, 0, lz, sx, sy, sz, rotY, yAbs), color, range);
  // A sagging strand of bulbs between two local points.
  const strand = (f, a, b, yBase, sag = 0.35) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(2, Math.round(len / 0.55));
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      putAbs(pools.bulb, f, a[0] + (b[0] - a[0]) * u, a[2] + (b[2] - a[2]) * u, yBase + a[1] + (b[1] - a[1]) * u - sag * 4 * u * (1 - u), 1, 1, 1,
        i % 5 === 2 ? '#ffb347' : '#ffe08a', RANGE_FRONT);
    }
    stats.bulbs += n + 1;
  };
  const pergola = (f, w, depth, ph, yBase) => {
    const wood = '#7a4e2d', xs = w > 7 ? [-w / 2 + 0.3, 0, w / 2 - 0.3] : [-w / 2 + 0.3, w / 2 - 0.3];
    for (const x of xs) putAbs(pools.wood, f, x, depth, yBase, 0.24, ph, 0.24, wood, RANGE_PROP);
    putAbs(pools.wood, f, 0, depth, yBase + ph, w, 0.26, 0.28, wood, RANGE_PROP);
    for (const x of xs) putAbs(pools.wood, f, x, depth / 2, yBase + ph, 0.2, 0.24, depth, wood, RANGE_PROP);
    for (let z = 0.6; z < depth; z += 0.8) putAbs(pools.wood, f, 0, z, yBase + ph + 0.24, w, 0.08, 0.14, wood, RANGE_PROP);
    for (const zz of [depth * 0.35, depth * 0.7]) strand(f, [-w / 2 + 0.3, ph - 0.1, zz], [w / 2 - 0.3, ph - 0.1, zz], yBase, 0.3);
    strand(f, [-w / 2 + 0.3, ph - 0.05, depth], [w / 2 - 0.3, ph - 0.05, depth], yBase, 0.4);
    stats.pergolas++;
  };

  // `deck`: confirmed outdoor seating of a well-known eatery: a timber deck, two rows where the walk allows.
  const outdoor = (rec, f, w, H, clear, strip, awn, h0, free, photo = null, deck = false) => {
    const kind = venueOf(rec.ty);
    seatPlace = rec.eatery ? rec.eatery.id : null;
    try { return outdoorAt(rec, f, w, H, clear, strip, awn, h0, free, photo, deck, kind); } finally { seatPlace = null; }
  };
  const outdoorAt = (rec, f, w, H, clear, strip, awn, h0, free, photo, deck, kind) => {
    const chairCol = photo && photo.chairs ? photo.chairs : strip ? ['#2f3e46', '#a44a3f', '#1d3557', '#3a5a40'][Math.floor(hash(`ch${rec.s.x}`) * 4)] : ['#ffffff', '#2f3e46', '#a44a3f', '#e9c46a'][Math.floor(hash(`ch${rec.s.x}`) * 4)];
    const chairOf = (k) => (Array.isArray(chairCol) ? chairCol[k % chairCol.length] : chairCol);
    const canopyCol = rec.brand ? BRANDS[rec.brand][1] : AWNING[Math.floor(hash(`u${rec.s.z}`) * AWNING.length)];
    let z0 = 0.3, used = 0, pg = false;
    const seats0 = seats.length;
    // Bar counter open to the street, stools facing it.
    // (A deck venue seats its guests at tables, as photographed, so it skips the counter.)
    if (kind === 'bar' && !deck && clear >= 3.4 && w >= 4.2) {
      const n = w >= 8.5 ? 2 : 1, lz = 0.4 * PS + 0.15;
      for (let k = 0; k < n; k++) {
        const lx = (k - (n - 1) / 2) * 2.3 * PS;
        if (!free(lx, lz + 1.4 * PS, 0.5)) continue;
        putOnGround(pools.bar, f, lx, lz, PS, '#ffffff', RANGE_PROP);
        rectCollider(f, lx, lz, 1.15 * PS, 0.45 * PS, 1.15 * PS);
        for (let j = -1; j <= 1; j++) {
          const sx = lx + j * 0.75 * PS, sz = lz + 1.05 * PS;
          putOnGround(pools.stool, f, sx, sz, PS, '#ffffff', RANGE_PROP);
          seatAt(f, sx, sz, Math.PI, 'bar', 1.04 * PS, sx, lz);
        }
        used++;
      }
      if (used) { z0 = lz + 1.6 * PS; stats.barCounters += used; }
    }
    // Rows of tables; on the strip a second row when the sidewalk allows.
    const rowNeed = 2.0 * PS + 1.6; // a row plus a walking lane to the kerb
    const rows = clear >= z0 + rowNeed + 2.0 * PS && (strip || deck) ? 2 : clear >= z0 + rowNeed ? 1 : 0;
    let depth = z0;
    for (let r = 0; r < rows; r++) {
      const lz = z0 + 0.95 * PS + r * 2.0 * PS;
      const n = clamp(Math.floor((w - 0.4) / (1.9 * PS)), 1, 4);
      for (let k = 0; k < n; k++) {
        const lx = n === 1 ? 0 : -w / 2 + 0.95 * PS + k * ((w - 1.9 * PS) / (n - 1));
        if (!free(lx, lz, 1.0) || !free(lx, lz + 0.9 * PS, 0.6)) continue;
        putOnGround(pools.table, f, lx, lz, PS, '#ffffff', RANGE_PROP);
        putOnGround(pools.chair, f, lx - 0.75 * PS, lz, PS, chairOf(k + r), RANGE_PROP, Math.PI / 2);
        putOnGround(pools.chair, f, lx + 0.75 * PS, lz, PS, chairOf(k + r + 1), RANGE_PROP, -Math.PI / 2);
        seatAt(f, lx - 0.75 * PS, lz, Math.PI / 2, kind, 0.62 * PS, lx, lz);
        seatAt(f, lx + 0.75 * PS, lz, -Math.PI / 2, kind, 0.62 * PS, lx, lz);
        stats.tables++;
        depth = Math.max(depth, lz + 0.9 * PS);
      }
    }
    if (depth <= z0 && !used) return null;
    if (strip || deck) {
      // Make the terrace read as a place to sit: planters at its two ends and a chalkboard menu
      // by the door, each only where the walk is free.
      for (const sd of [-1, 1]) if (free(sd * (w / 2 - 0.45), depth - 0.3, 0.5)) { putOnGround(pools.plants, f, sd * (w / 2 - 0.45), depth - 0.3, 0.9, '#ffffff', RANGE_PROP, sd > 0 ? Math.PI : 0); stats.planters++; }
      const bx = -w / 2 + 0.7, bz = Math.min(depth + 0.6, clear - 0.6);
      if (bz > 1 && free(bx, bz, 0.4)) {
        put(pools.board, f, bx, 0.6, bz, 0.7, 1.2, 0.1, '#2f3b33', RANGE_PROP);
        put(pools.frame, f, bx, 1.22, bz, 0.78, 0.06, 0.14, '#6b4a2f', RANGE_PROP);
        stats.menuBoards++;
      }
    }
    if (deck) {
      // Timber deck under the tables with a low rail on the street side, gap left for the entrance.
      const [dx, dz] = world(f, 0, depth / 2);
      const dy = surface(dx, dz, f.y), dd = Math.min(depth + 0.3, clear - 0.3);
      putAbs(pools.wood, f, 0, dd / 2, dy - 0.02, w - 0.2, 0.07, dd, '#a0703f', RANGE_PROP);
      for (const sd of [-1, 1]) {
        putAbs(pools.wood, f, sd * (w / 4 + 0.6), dd, dy, w / 2 - 1.4, 0.07, 0.07, '#5b3a24', RANGE_PROP);
        putAbs(pools.wood, f, sd * (w / 4 + 0.6), dd, dy + 0.85, w / 2 - 1.4, 0.08, 0.1, '#5b3a24', RANGE_PROP);
        for (let x = 1.2; x <= w / 2 - 0.1; x += 1.3) putAbs(pools.wood, f, sd * x, dd, dy, 0.09, 0.9, 0.09, '#5b3a24', RANGE_PROP);
      }
    }
    // Cover: pergola with string lights on the strip (and for every bar), else umbrellas or nothing.
    const [cx, cz] = world(f, 0, depth);
    const yBase = surface(cx, cz, f.y);
    const ph = Math.min(Math.max(3.4, H * 0.62), 4.6);
    if (photo && photo.umbrellas && rows) {
      // Umbrellas as photographed: colours and shape from the profile, one per table.
      const n = clamp(Math.floor((w - 0.4) / (1.9 * PS)), 1, 4);
      for (let k = 0; k < n; k++) {
        const lx = n === 1 ? 0 : -w / 2 + 0.95 * PS + k * ((w - 1.9 * PS) / (n - 1)), lz = z0 + 0.95 * PS;
        if (!free(lx, lz, 1.0)) continue;
        const col = photo.umbrellas[k % photo.umbrellas.length];
        putOnGround(pools.pole, f, lx, lz, PS, '#ffffff', RANGE_PROP);
        putOnGround(photo.square ? pools.umbrellaSq : pools.canopy, f, lx, lz, PS, col, RANGE_PROP);
      }
      if (photo.enclosure) {
        const zz = Math.min(depth + 0.3, clear - 0.4);
        put(pools.frame, f, 0, 1.05, zz, w - 0.2, 0.07, 0.07, '#2b2b2b', RANGE_PROP);
        for (const sd of [-1, 1]) put(pools.frame, f, sd * (w / 2 - 0.1), 1.05, zz / 2 + 0.2, 0.07, 0.07, zz - 0.4, '#2b2b2b', RANGE_PROP);
        for (let x = -w / 2 + 0.1; x <= w / 2 - 0.09; x += 1.2) put(pools.frame, f, x, 0.52, zz, 0.06, 1.05, 0.06, '#2b2b2b', RANGE_PROP);
      }
    } else if ((strip || kind === 'bar') && depth <= clear - 0.8 && !awn && (kind === 'bar' || h0 < 0.65)) { pergola(f, w, depth, ph, yBase); pg = true; }
    else if (strip && depth <= clear - 0.8) {
      // Lights from the facade out to two poles at the front corners.
      for (const sd of [-1, 1]) { putOnGround(pools.pole, f, sd * (w / 2 - 0.3), depth, PS, '#ffffff', RANGE_PROP); }
      const top = 2.9 * PS - 0.1;
      strand(f, [-w / 2 + 0.3, top, depth], [w / 2 - 0.3, top, depth], yBase, 0.45);
      strand(f, [-w / 2 + 0.3, H * 0.6, 0.25], [-w / 2 + 0.3, top, depth], yBase, 0.3);
      strand(f, [w / 2 - 0.3, H * 0.6, 0.25], [w / 2 - 0.3, top, depth], yBase, 0.3);
    } else if (!awn && rows && clear >= CAFE_CLEAR + 1.2 && h0 > 0.3) {
      for (let k = 0, n = clamp(Math.floor((w - 0.4) / (1.9 * PS)), 1, 4); k < n; k++) {
        const lx = n === 1 ? 0 : -w / 2 + 0.95 * PS + k * ((w - 1.9 * PS) / (n - 1)), lz = z0 + 0.95 * PS;
        if (!free(lx, lz, 1.0)) continue;
        putOnGround(pools.pole, f, lx, lz, PS, '#ffffff', RANGE_PROP);
        putOnGround(pools.canopy, f, lx, lz, PS, canopyCol, RANGE_PROP);
      }
    }
    if (strip) stats.nightlife++;
    return { seats: seats.length - seats0, pergola: pg, venue: kind };
  };

  // ---- photo profiles ----
  const photoProfiles = PHOTO.map((p) => {
    const c = project(p.lat, p.lon);
    const b = p.faces == null ? null : (p.faces * Math.PI) / 180;
    return { ...p, x: c.x, z: c.z, r2: (p.r * SCALE) ** 2, fx: b == null ? 0 : Math.sin(b), fz: b == null ? 0 : -Math.cos(b), any: b == null, fronts: 0 };
  });
  // `onStrip` profiles only apply to facades that face Rothschild itself, not a street behind it.
  const profileAt = (x, z, nx, nz, strip) => photoProfiles.find((p) => (x - p.x) ** 2 + (z - p.z) ** 2 <= p.r2 &&
    (p.any || nx * p.fx + nz * p.fz > 0.5) && (!p.onStrip || strip)) || null;

  // ---- shop windows ----
  // A bay: lit interior back, side jambs, sill and head, the display, and a see-through pane in
  // front at `depth`. `cx`/`ww` place it along the facade; base/top are sill and head heights.
  const bay = (f, cx, ww, base, top, depth, mull, step, interior) => {
    put(pools.glass, f, cx, (top + base) / 2, 0.1, ww, top - base, 0.04, interior, RANGE_FRONT);
    const d = Math.max(0.2, depth);
    if (d >= 0.5) {
      for (const sd of [-1, 1]) put(pools.frame, f, cx + sd * (ww / 2 + 0.06), (top + base) / 2, d / 2 + 0.05, 0.14, top - base + 0.1, d + 0.1, mull, RANGE_FRONT);
      put(pools.frame, f, cx, top + 0.1, d / 2 + 0.05, ww + 0.26, 0.22, d + 0.1, mull, RANGE_FRONT);
      put(pools.frame, f, cx, (base - 0.5) / 2, d / 2 + 0.05, ww + 0.26, base + 0.5, d + 0.1, mull, RANGE_FRONT);
      if (d > 2) for (const sd of [-1, 1]) put(pools.pane, f, cx + sd * (ww / 2 + 0.06), (top + base) / 2, d / 2, 0.05, top - base - 0.1, d - 0.2, '#cfe6f2', RANGE_FRONT);
    }
    put(pools.pane, f, cx, (top + base) / 2, d, ww, top - base, 0.05, '#cfe6f2', RANGE_FRONT);
    const nm = Math.max(1, Math.round(ww / step));
    for (let k = 1; k < nm; k++) put(pools.frame, f, cx - ww / 2 + (k * ww) / nm, (top + base) / 2, d + 0.05, 0.1, top - base, 0.08, mull, RANGE_FRONT);
    stats.bays++;
  };

  // The display behind the glass, standing on the sill.
  const display = (f, cx, ww, base, top, depth, rec, h0, zone) => {
    const fam = DISPLAY_OF[rec.ty];
    if (!fam || depth < 0.6) return;
    const lz = Math.min(depth - 0.42, 0.55), y = base, inner = ww - 0.6, room = top - base;
    const slots = (unitW) => { const n = clamp(Math.floor(inner / unitW), 1, 6); return Array.from({ length: n }, (_, i) => cx - inner / 2 + (i + 0.5) * (inner / n)); };
    const tint = (i, list) => list[Math.floor(hash(`${rec.s.x}|${i}`) * list.length)];
    const sc = (h) => Math.min(1, room / h); // shrink props that would not fit under the head
    const P = (pool, x, z, sx, color, rotY = 0) => put(pool, f, x, y, z, sx, sx, sx, color, RANGE_PROP, rotY);
    switch (fam) {
      case 'mannequin': slots(1.5).forEach((x, i) => P(pools.mannequin, x, lz, sc(3.4), tint(i, ['#f8f8f8', '#e8d5c4', '#cfd8dc', '#f3c6d3', '#d7ccc8', '#bcaaa4']))); break;
      case 'shoes': slots(1.9).forEach((x) => P(pools.shelf, x, lz - 0.05, sc(2.6) * 0.8, '#ffffff')); break;
      case 'sofa': if (inner >= 2.6) P(pools.sofa, cx - (inner > 5 ? 1.2 : 0), Math.min(lz, depth - 0.45), Math.min(1, sc(2)), tint(0, ['#8d6e63', '#546e7a', '#c0a080', '#7e57c2', '#e0e0e0', '#2e7d32'])); break;
      case 'kitchen': if (inner >= 2.8) P(pools.kitchen, cx, Math.min(lz, depth - 0.4), sc(2.8), tint(0, ['#ffffff', '#efe6d8', '#9e8a73', '#4f5b66'])); break;
      case 'lamp': slots(1.0).forEach((x, i) => {
        put(pools.lamp, f, x, top - 0.1, lz, 1, 1, 1, tint(i, ['#ffffff', '#212121', '#d4af37', '#ff7043']), RANGE_PROP);
        put(pools.bulb, f, x, top - 1.32, lz, 2.2, 2.2, 2.2, '#fff2c4', RANGE_PROP);
      }); break;
      case 'tiles': if (inner >= 3) P(pools.tiles, cx, Math.min(lz, depth - 0.4), sc(2.1), '#ffffff'); break;
      case 'shelf': slots(2.0).forEach((x) => P(pools.shelf, x, Math.min(lz, depth - 0.3) - 0.05, sc(2.6), '#ffffff')); break;
      case 'tv': slots(2.2).forEach((x) => P(pools.tv, x, Math.min(lz, depth - 0.3), sc(2), '#ffffff')); break;
      case 'pedestal': slots(1.2).forEach((x) => P(pools.pedestal, x, Math.min(lz, depth - 0.3), sc(1.4), '#ffffff')); break;
      case 'blocks': slots(2.2).forEach((x) => P(pools.blocks, x, Math.min(lz, depth - 0.4), 1, '#ffffff')); break;
      case 'plants': slots(1.8).forEach((x) => P(pools.plants, x, Math.min(lz, depth - 0.4), sc(1.5), '#ffffff')); break;
      case 'tyres': slots(1.2).forEach((x) => P(pools.tyres, x, Math.min(lz, depth - 0.5), sc(1), '#ffffff')); break;
      case 'car': {
        // Cars side-on inside a deep showroom bay.
        if (depth < 3 || room < 4.2) break;
        const kinds = carKinds.filter((k) => pools[`car_${k}`]);
        if (!kinds.length) break;
        const n = clamp(Math.floor(inner / 8.2), 1, 3);
        for (let i = 0; i < n; i++) {
          const k = kinds[i % kinds.length], x = cx - inner / 2 + (i + 0.5) * (inner / n);
          put(pools[`car_${k}`], f, x, y, depth / 2, 1, 1, 1, carPaint(k, `${rec.s.x}:${i}`), RANGE_FRONT, Math.PI / 2 + (i % 2 ? 0.06 : -0.06));
          stats.displayCars++;
        }
      }
    }
    stats.displays++;
  };

  // A text sticker or neon sign from the mask atlas (key under shop.ui.*).
  const sticker = (f, key, lx, ly, lz, w, bg, fg, range = RANGE_PROP) => {
    const lab = { main: t(`shop.ui.${key}`), sub: null };
    text(atlas, signRect(lab), f, lx, ly, lz, w, w * (CELL_H / CELL_W), range, 0, bg, fg);
  };

  // Roller shutter over [cx-ww/2, cx+ww/2] from y0 to y1, slightly proud of `lz`.
  const SHUTTER = ['#a7adb2', '#8e969c', '#b9b3a6', '#7f8f9c', '#9fae9a'];
  const shutter = (f, cx, ww, y0, y1, lz, key) => {
    put(pools.shutter, f, cx, (y0 + y1) / 2, lz, ww, y1 - y0, 0.08, SHUTTER[Math.floor(hash(key) * SHUTTER.length)], RANGE_FRONT);
    put(pools.frame, f, cx, y1 + 0.18, lz + 0.05, ww + 0.2, 0.36, 0.34, '#6f777d', RANGE_FRONT); // shutter box
    stats.shutters++;
  };

  // Painted stalls on a showroom forecourt; dealers fill them with display cars, the others are
  // exported for traffic (same shape as parking stalls: x, z, angle = car heading, w, l).
  const stalls = [];
  const forecourt = (f, w, clear, dealer, key, depth = 0) => {
    const SW = 3.2, SL = 6.4, z0 = Math.max(1.2, depth + 0.8);
    if (clear < z0 + SL + 2 || w < SW * 2) return 0;
    const n = Math.min(6, Math.floor((w - 0.4) / SW));
    const x0 = -(n * SW) / 2;
    const ok = (lx, lz) => { const [x, z] = world(f, lx, lz); return !onCarriage(x, z, 0.4) && !buildingAt(x, z, null); };
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const lx = x0 + (i + 0.5) * SW;
      if (![[lx - SW / 2, z0], [lx + SW / 2, z0], [lx - SW / 2, z0 + SL], [lx + SW / 2, z0 + SL]].every(([a, b]) => ok(a, b))) continue;
      const [x, z] = world(f, lx, z0 + SL / 2);
      const gy = surface(x, z, f.y);
      for (const sd of [-1, 1]) putAbs(pools.line, f, lx + (sd * SW) / 2, z0 + SL / 2, gy + 0.02, 0.14, 0.03, SL, '#f4f4f0', RANGE_PROP);
      putAbs(pools.line, f, lx, z0 + SL - 0.07, gy + 0.02, SW, 0.03, 0.14, '#f4f4f0', RANGE_PROP);
      // Cars nose-in, facing the building.
      const kinds = carKinds.filter((k) => pools[`car_${k}`]);
      if (dealer && kinds.length && hash(`${key}c${i}`) < 0.85) {
        const k = kinds[Math.floor(hash(`${key}k${i}`) * kinds.length)];
        putAbs(pools[`car_${k}`], f, lx, z0 + SL / 2, gy, 1, 1, 1, carPaint(k, `${key}p${i}`), RANGE_FRONT, Math.PI);
        rectCollider(f, lx, z0 + SL / 2, 1.5, 3.1, 3.2);
        stats.displayCars++;
      } else if (!dealer) stalls.push({ x: +x.toFixed(2), z: +z.toFixed(2), angle: +(f.th + Math.PI).toFixed(4), w: SW, l: SL });
      placed++;
    }
    stats.stalls += placed;
    return placed;
  };

  // Builds one shop front in a facade slot: frame, glass, sign, awning and street props.
  const buildFront = (rec, out, cand, slot, showroom, zone) => {
    const { s, ty } = rec;
    let lab = rec.lab;
    const st = TYPES[ty] || [];
    const { e } = cand, w = slot.w;
    const px = e.ax + e.ux * slot.c, pz = e.az + e.uz * slot.c;
    const g = ground(px + e.nx * 0.6, pz + e.nz * 0.6);
    const f = frameAt(px, pz, e.nx, e.nz, g);
    const bTop = e.b.top - (e.b.base ?? g);
    // Shop-front height inside the ground floor; industrial halls and showrooms are much taller.
    const H = showroom ? clamp(bTop - 0.5, 4.5, 8.6) : e.b.gh ? clamp(e.b.gh - 0.1, 3.4, 7.5) : bTop >= 8 ? 5.4 : clamp(bTop - 0.4, 3.4, 5.4);
    const clear = clearance(px, pz, e.nx, e.nz);
    const h0 = hash(`${s.x}:${s.z}:${ty}`);
    const rovaFront = inRova(px, pz) && (!!(cand.street && cand.street.rova) || facesSquare(px, pz, e.nx, e.nz) || !!(rec.eatery && rec.eatery.rova));
    const strip = !!(cand.street && cand.street.strip) || rovaFront;
    let photo = profileAt(px, pz, e.nx, e.nz, strip);
    if (!photo && rovaFront) photo = { ...ROVA_LOOK, fascia: ['#141414', NEON[Math.floor(h0 * NEON.length)]] };
    // A photo profile restyles the front: full glass, fascia colours (chains keep their parody colours).
    const vitrine = !showroom && (VITRINE_TYPES.has(ty) || (photo && photo.glass === 'full'));
    if (photo && photo.fascia && !rec.brand) lab = { ...lab, bg: photo.fascia[0], fg: photo.fascia[1] };
    if (photo && photo.rova) { stats.rovaFronts++; out.area = 'harova'; } else if (photo) { photo.fronts++; stats.photoMatched++; out.photo = photo.id; out.mapillary = photo.key; }
    const E = rec.eatery, styleAwn = E && E.style && E.style.awning;
    // What the eatery's own photo or review shows overrides the street profile for its seating.
    const look = E && E.style ? { ...(photo || {}), ...E.style } : photo;
    stats[lab.kind]++;
    stats.storefronts++;
    Object.assign(out, { kind: 'storefront', fx: px, fz: pz, nx: e.nx, nz: e.nz, width: w, clearance: clear, street: !!cand.street,
      mainRoad: !!(cand.street && cand.street.major), showroom, zone: zone ? zone.name : null, nightlife: strip });
    if (showroom) stats.showrooms++;
    if (vitrine) stats.vitrines++;

    // Shop front: a lit window bay with its display, a glass door, the sign board above.
    const sideStreet = !!zone && !(cand.street && cand.street.major);
    // A bay may take up to ~40% of a narrow sidewalk; a car needs a deep glass hall.
    const depth = ty === 'car' && clear >= 9 && H >= 6 ? 4.4 : clear >= 1.8 ? 0.95 : clear >= 1.1 ? 0.65 : 0.3;
    const interior = /^(bar|pub)$/.test(ty) ? '#c98f4a' : TYPES[ty] && TYPES[ty][0] === 'seat' ? '#e6c48a' : showroom ? '#aeb8bf' : '#d9ccb4';
    let sh, sy, gTop, base, doorW;
    // Under an arcade the name board hangs on the arcade beam (see PHOTO), not on the wall.
    const arcadeOn = !!(photo && photo.arcade && clear >= 3.4);
    if (showroom || vitrine) {
      // Showroom: tall glass with aluminium mullions and a wide fascia. Vitrine: the same at shop
      // height on a display sill.
      gTop = showroom ? H * 0.72 : H * 0.66; base = vitrine ? 0.6 : 0.4; doorW = showroom ? 2.2 : 1.2;
      const mull = photo && photo.mull ? photo.mull : showroom ? '#59616b' : h0 < 0.5 ? '#2f3438' : '#b8b2a6';
      put(pools.frame, f, 0, (gTop - 0.6) / 2, 0.05, w, gTop + 0.6, 0.12, mull, RANGE_FRONT);
      const ww = w - doorW - 0.6, cx = -w / 2 + 0.2 + ww / 2;
      bay(f, cx, ww, base, gTop, depth, mull, (photo && photo.step) || (showroom ? 2.8 : 2.0), interior);
      display(f, cx, ww, base, gTop, depth, rec, h0, zone);
      put(pools.glass, f, w / 2 - 0.2 - doorW / 2, gTop * 0.42, 0.14, doorW, gTop * 0.84, 0.06, '#4a6f8c', RANGE_FRONT);
      sh = showroom ? clamp(w / 6, 1.4, 2.4) : clamp(w / 5, 0.95, 1.7);
      sy = Math.min(H - sh / 2 - 0.1, gTop + 0.25 + sh / 2);
      if (vitrine && e.b.gh) { sh = Math.min(sh, Math.max(0.95, H * 0.2)); sy = H * 0.85; }
      if (photo && photo.signOnGlass) { sh = Math.min(sh, 0.85); sy = gTop + 0.2 + sh / 2; } // slim name strip under the canopy
      if (!arcadeOn) put(pools.board, f, 0, sy, 0.2, w, sh, 0.36, lab.bg, RANGE_FRONT);
      // Industrial blocks get one continuous fascia band along the facade, the sign on top of it.
      const bandKey = `${e.b.id}:${e.i}`;
      if (showroom && zone && !bands.has(bandKey) && e.L > w + 2) {
        bands.add(bandKey);
        put(pools.board, f, e.L / 2 - slot.c, sy, 0.1, e.L - 0.2, sh * 0.8, 0.2, h0 < 0.5 ? '#2c3136' : '#e8e4dc', RANGE_FRONT);
        stats.bands++;
      }
      // Window stickers: dealers advertise models, outlets and fashion run sales.
      if (ty === 'car') sticker(f, h0 < 0.5 ? 'newModel' : 'testDrive', cx + ww / 2 - 1.3, gTop - 0.9, Math.max(0.2, depth) + 0.04, 2.0, '#d32f2f', '#ffffff');
      else if (h0 < 0.55 && DISPLAY_OF[ty]) {
        const key = zone && /mannequin|shoes/.test(DISPLAY_OF[ty]) ? (h0 < 0.3 ? 'outlet' : 'clearance') : ['sale', 'discount', 'new', 'catalog'][Math.floor(h0 * 7.27) % 4];
        sticker(f, key, cx - ww / 2 + 1.1, base + 0.7, Math.max(0.2, depth) + 0.04, 1.6, key === 'new' ? '#ffd600' : '#e53935', key === 'new' ? '#1a1a1a' : '#ffffff');
        stats.stickers++;
      }
    } else {
      gTop = H * 0.66; base = 0.6; doorW = 1.1;
      const frameCol = photo && photo.frame ? photo.frame : h0 < 0.5 ? '#3b4148' : h0 < 0.8 ? '#d9d6cf' : '#5b3f2a';
      put(pools.frame, f, 0, (gTop - 0.6) / 2, 0.05, w, gTop + 0.6, 0.12, frameCol, RANGE_FRONT);
      const ww = w - 2.0, cx = 0.6;
      bay(f, cx, ww, base, gTop, depth, frameCol, 2.2, strip ? '#e8b871' : interior);
      display(f, cx, ww, base, gTop, depth, rec, h0, zone);
      put(pools.glass, f, -w / 2 + 0.75, H * 0.31, 0.12, 1.1, H * 0.6, 0.07, '#4a6f8c', RANGE_FRONT);
      sh = clamp(w / 5, 0.95, 1.7); sy = H * 0.78;
      if (e.b.gh) { sh = Math.min(sh, Math.max(0.95, H * 0.2)); sy = H * 0.85; } // the band buildings.js paints
      if (!arcadeOn) put(pools.board, f, 0, sy, 0.18, w, sh, 0.32, lab.bg, RANGE_FRONT);
      // Posters inside the window of ordinary shops.
      if (DISPLAY_OF[ty] && h0 > 0.5 && ww > 2.4) {
        put(pools.poster, f, cx + ww / 2 - 0.8, base + (gTop - base) * 0.55, 0.14, 0.9, Math.min(1.3, (gTop - base) * 0.6), 0.02, AWNING[Math.floor(h0 * 97) % AWNING.length], RANGE_PROP);
        stats.posters++;
      }
      // Neon OPEN (and the odd happy-hour sign) in strip venues and bars, readable at night.
      if (strip || ty === 'bar' || ty === 'pub') {
        const neon = h0 < 0.5 ? '#ff4fd8' : '#46f0ff';
        sticker(f, 'open', cx + ww / 2 - 0.95, gTop - 0.55, Math.max(0.2, depth) - 0.08, 1.5, '#140b1a', neon, RANGE_FRONT);
        if ((ty === 'bar' || ty === 'pub') && ww > 3.6) sticker(f, h0 < 0.5 ? 'happyHour' : 'beer', cx - ww / 2 + 1.2, gTop - 0.6, Math.max(0.2, depth) - 0.08, 1.9, '#140b1a', '#ffd23f', RANGE_FRONT);
        stats.neons++;
      }
    }
    // Details copied from the photo of this frontage (see PHOTO).
    if (photo) {
      const lzFront = Math.max(0.2, depth);
      if (photo.canopy) put(pools.frame, f, 0, sy + sh / 2 + 0.25, 0.85, w + 0.3, 0.3, 1.7, photo.canopy, RANGE_FRONT);
      if (photo.band) {
        const bandKey = `${e.b.id}:${e.i}`;
        if (!bands.has(bandKey)) { bands.add(bandKey); put(pools.board, f, e.L / 2 - slot.c, sy, 0.1, e.L - 0.2, sh * 0.85, 0.2, photo.band, RANGE_FRONT); stats.bands++; }
      }
      if (photo.piers) for (const sd of [-1, 1]) put(pools.frame, f, sd * (w / 2 + 0.12), H / 2, 0.25, 0.55, H, 0.5, photo.piers, RANGE_FRONT);
      if (photo.salePosters) sticker(f, 'sale', -w / 2 + 1.6, gTop * 0.62, lzFront - 0.08, 1.5, '#d32f2f', '#ffffff');
      if (photo.banners && bTop > H + 3.4) {
        // Big printed banner on the upper floor, framed in the fascia red.
        put(pools.board, f, 0, H + 2.1, 0.12, w * 0.94, 2.8, 0.12, photo.band || '#c62828', RANGE_FRONT);
        put(pools.poster, f, 0, H + 2.1, 0.2, w * 0.86, 2.3, 0.04, '#fbfbf8', RANGE_FRONT);
        sticker(f, h0 < 0.5 ? 'discount' : 'sale', 0, H + 2.1, 0.24, Math.min(w * 0.7, 5), '#fbfbf8', '#c62828', RANGE_FRONT);
      }
      if (photo.fence && clear >= 2.2) {
        const lz = Math.min(clear - 0.6, 2.4);
        put(pools.frame, f, 0, 1.15, lz, w, 0.08, 0.08, '#9aa0a6', RANGE_PROP);
        put(pools.frame, f, 0, 0.55, lz, w, 0.06, 0.06, '#9aa0a6', RANGE_PROP);
        for (let x = -w / 2; x <= w / 2 + 0.01; x += 1.4) put(pools.frame, f, x, 0.6, lz, 0.07, 1.2, 0.07, '#9aa0a6', RANGE_PROP);
      }
      if (photo.sconces) for (let x = -w / 2 + 1.2; x < w / 2 - 0.6; x += 3.4) {
        put(pools.frame, f, x, H * 0.6, 0.2, 0.25, 0.4, 0.25, '#222222', RANGE_FRONT);
        put(pools.bulb, f, x, H * 0.6 - 0.25, 0.32, 2.2, 2.2, 2.2, '#ffe9b0', RANGE_FRONT);
      }
      // Corten panel over the steel canopy, the width of this venue only (the halls are long).
      if (photo.corten && bTop > sy + sh / 2 + 1.6) put(pools.board, f, 0, sy + sh / 2 + 1.05, 0.08, w + 0.5, 1.1, 0.16, photo.corten, RANGE_FRONT);
      if (photo.neon) {
        // Neon behind the glass: OPEN on every venue, a cocktail or beer line on the bars.
        const nc = photo.fascia[1], lzN = Math.max(0.2, depth) - 0.08;
        sticker(f, 'open', -w / 2 + 1.4, gTop - 0.6, lzN, 1.5, '#140b1a', nc, RANGE_FRONT);
        if (/^(bar|pub)$/.test(ty) && w > 5.5) sticker(f, h0 < 0.5 ? 'happyHour' : 'beer', w / 2 - 2.6, gTop - 0.65, lzN, 1.9, '#140b1a', NEON[(Math.floor(h0 * 7) + 1) % NEON.length], RANGE_FRONT);
        stats.neons++;
      }
      if (photo.panel && w > 6) put(pools.board, f, w / 2 - 0.7, H * 0.5, 0.4, 1.1, H * 0.85, 0.3, '#151515', RANGE_FRONT);
      if (arcadeOn) {
        // Arcade: the floor above rests on a row of columns at the kerb side of the walk.
        put(pools.frame, f, 0, H + 0.25, 1.45, w + 0.25, 0.5, 2.9, photo.arcade, RANGE_FRONT);
        for (let x = -w / 2 + 0.3; x <= w / 2 - 0.29; x += Math.max(2.4, (w - 0.6) / Math.max(1, Math.round((w - 0.6) / 3.6)))) put(pools.frame, f, x, H / 2, 2.65, 0.5, H, 0.5, photo.arcade, RANGE_FRONT);
        put(pools.board, f, 0, H + 0.25, 2.95, w * 0.8, 0.46, 0.08, lab.bg, RANGE_FRONT);
        text(atlas, signRect(lab), f, 0, H + 0.25, 3.0, Math.min(w * 0.78, 0.44 * (CELL_W / CELL_H)), 0.44, RANGE_FRONT, 0, lab.bg, lab.fg);
      }
    }
    // A live-music bar (E.stage): red curtain, a lit stage with mic and amps behind the window, LIVE neon.
    if (E && E.stage) {
      const ww = w - 2.0, cx = 0.6, d = Math.max(0.5, depth), lz = d / 2 + 0.05;
      put(pools.frame, f, cx, (gTop + base) / 2, 0.13, ww, gTop - base, 0.03, '#7a1022', RANGE_FRONT);
      put(pools.wood, f, cx, base, lz, ww - 0.3, 0.3, d - 0.15, '#2a1a12', RANGE_FRONT);
      put(pools.pole, f, cx, base + 0.3, lz, 1, 0.5, 1, '#222222', RANGE_PROP);
      for (const sd of [-1, 1]) {
        put(pools.frame, f, cx + sd * (ww / 2 - 0.5), base + 0.7, lz, 0.6, 0.8, Math.min(0.4, d - 0.2), '#1a1a1a', RANGE_PROP);
        put(pools.bulb, f, cx + sd * 0.9, gTop - 0.25, lz, 2.6, 2.6, 2.6, '#ffe08a', RANGE_FRONT);
      }
      sticker(f, 'live', cx, gTop + 0.05, d + 0.08, Math.min(ww, 2.6), '#140b1a', '#ff4fb5', RANGE_FRONT);
      const [sx, sz] = world(f, cx, lz);
      out.stage = { x: +sx.toFixed(2), z: +sz.toFixed(2), nx: e.nx, nz: e.nz };
      stats.stages++;
    }
    // Side streets of the industrial zones: roller shutters half or fully down.
    if (sideStreet && !showroom && (!TYPES[ty] || TYPES[ty][0] !== 'seat')) {
      const r = hash(`shut${s.x}:${s.z}`);
      if (r < 0.12) shutter(f, 0, w - 0.1, 0, gTop, Math.max(0.2, depth) + 0.12, `s${s.x}`);
      else if (r < 0.45) shutter(f, 0, w - 0.1, gTop * 0.55, gTop, Math.max(0.2, depth) + 0.12, `s${s.x}`);
    }
    const parked = showroom && zone ? forecourt(f, w, clear, ty === 'car', `${s.x}:${s.z}`, depth) : 0;
    // Dealers without a forecourt park display cars side-on on a wide sidewalk, as they do.
    const kinds = carKinds.filter((k) => pools[`car_${k}`]);
    if (ty === 'car' && !parked && depth < 3 && clear >= depth + 4.6 && kinds.length) {
      const lz = depth + 0.4 + 1.75, n = clamp(Math.floor((w - 1) / 8.4), 1, 2);
      for (let i = 0; i < n; i++) {
        const lx = -w / 2 + (i + 0.5) * (w / n);
        const ok = [[lx - 3.9, lz], [lx + 3.9, lz], [lx, lz + 1.8]].every(([a, b]) => { const [x, z] = world(f, a, b); return !onCarriage(x, z, 0.6) && !buildingAt(x, z, null); });
        if (!ok) continue;
        const k = kinds[Math.floor(hash(`${s.x}w${i}`) * kinds.length)];
        putOnGround(pools[`car_${k}`], f, lx, lz, 1, carPaint(k, `${s.z}w${i}`), RANGE_FRONT, Math.PI / 2);
        rectCollider(f, lx, lz, 3.9, 1.7, 3.2);
        stats.displayCars++;
      }
    }
    const qh = sh * 0.92, qw = Math.min(w - 0.1, qh * (CELL_W / CELL_H));
    if (!arcadeOn) text(atlas, signRect(lab), f, 0, sy, showroom || vitrine ? 0.385 : 0.345, qw, qh, showroom ? RANGE_DIR : RANGE_FRONT, 0, lab.bg, lab.fg);

    // Awning below the sign (not on the strip's pergola venues: the pergola is their cover).
    const group = st[0] || 'none';
    const awn = !showroom && group !== 'cross' && !(strip && group === 'seat' && !styleAwn) && !(photo && (photo.noAwning || photo.arcade || photo.canopy) && !styleAwn) &&
      (h0 < (st[3] ?? 0.25) || !!(photo && photo.awning) || !!styleAwn);
    if (awn) {
      const ac = styleAwn || (rec.brand ? BRANDS[rec.brand][1] : photo && photo.awning ? photo.awning : AWNING[Math.floor(hash(`a${s.x}`) * AWNING.length)]);
      put(pools.awning, f, 0, sy - sh / 2 - 0.1, 0.05, w - 0.2, 1, Math.min(1, Math.max(0.6, clear / 2.5)), ac, RANGE_FRONT);
      stats.awnings++;
    }
    if (group === 'cross') {
      put(pools.cross, f, w / 2 - 0.3, sy - sh / 2 - 0.75, 0.75, 1, 1, 1, '#ffffff', RANGE_FRONT);
      stats.crosses++;
    } else if (group === 'atm') {
      put(pools.atm, f, w / 2 - 0.7, 1.75, 0.12, 1, 1, 1, '#ffffff', RANGE_PROP);
    }

    // Street props, only where the sidewalk in front is wide enough, never on the carriageway.
    const free = (lx, lz, m = 0.9) => { const [x, z] = world(f, lx, lz); return !onCarriage(x, z, m) && !buildingAt(x, z, null) && !(rovaFront && rovaInner && inPoly(x, z, rovaInner)); };
    if (showroom) { /* showrooms keep the forecourt clear */ } else if (group === 'counter' && clear >= PROP_CLEAR && w >= 4) {
      const lx = w / 2 - 1.1 * PS - 0.2, lz = 0.45 * PS + 0.15;
      if (free(lx, lz + 0.45 * PS, 0.6)) {
        putOnGround(pools.counter, f, lx, lz, PS, '#ffffff', RANGE_PROP);
        putOnGround(pools.trays, f, lx, lz, PS, '#ffffff', RANGE_PROP, 0, 1.15 * PS + 0.06);
        if (ty === 'shawarma' || (ty === 'fast_food' && h0 > 0.5)) putOnGround(pools.spit, f, lx + 0.7 * PS, lz - 0.15, PS, '#ffffff', RANGE_PROP, 0, 1.15 * PS);
        rectCollider(f, lx, lz, 1.1 * PS, 0.45 * PS, 1.15 * PS);
        stats.counters++;
      }
    } else if (group === 'crates' && clear >= PROP_CLEAR && w >= 4) {
      // Grocers keep basket stacks and trolleys by the door (Mapillary 1528684747620700).
      if (/supermarket|convenience/.test(ty) && (h0 < 0.6 || (photo && photo.baskets)) && free(-w / 2 + 1.9, 0.6, 0.4)) {
        putOnGround(pools.baskets, f, -w / 2 + 1.7, 0.5, PS, '#ffffff', RANGE_PROP);
        for (let k = 0; k < 2; k++) putOnGround(pools.trolley, f, -w / 2 + 2.6 + k * 0.35, 0.75, PS, '#ffffff', RANGE_PROP, Math.PI);
        stats.baskets++;
      }
      const prod = PRODUCE[ty] || PRODUCE.default;
      const n = clamp(Math.floor((w - 2.2) / (0.85 * PS)), 1, 4);
      let placed = 0;
      for (let k = 0; k < n; k++) {
        const lx = w / 2 - 0.5 * PS - k * 0.85 * PS, lz = 0.35 * PS + 0.2;
        if (!free(lx, lz, 0.6)) break;
        putOnGround(pools.crate, f, lx, lz, PS, CRATE[Math.floor(hash(`c${k}${s.x}`) * CRATE.length)], RANGE_PROP);
        putOnGround(pools.produce, f, lx, lz, PS, prod[Math.floor(hash(`p${k}${s.z}`) * prod.length)], RANGE_PROP);
        placed++;
      }
      if (placed) { rectCollider(f, w / 2 - 0.5 * PS - (placed - 1) * 0.425 * PS, 0.35 * PS + 0.2, placed * 0.425 * PS, 0.3 * PS, 0.6 * PS); stats.crates += placed; }
    } else if (group === 'seat') {
      seatArea = rovaFront ? 'harova' : null;
      const od = outdoor(rec, f, w, H, clear, strip, awn, h0, free, look, !!(E && E.seat));
      seatArea = null;
      if (od) Object.assign(out, od);
    }
  };

  const shopsOut = [];
  // A well-known eatery whose point falls inside a landmark (e.g. the beach kiosk building) gets its
  // front on that landmark's street-facing wall, as if the footprint were an ordinary building.
  const landmarkFront = (rec, out, lmk) => {
    const pts = lmk.points;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const g = ground((minX + maxX) / 2, (minZ + maxZ) / 2);
    const b = { id: `lm:${lmk.id}`, pts, s: signedArea2(pts) > 0 ? 1 : -1, minX, minZ, maxX, maxZ, top: g + 5.6, base: g, gh: null, edges: null };
    let best = null;
    for (const e of edgesOf(b)) {
      if (e.L < MIN_W + 0.8) continue;
      const tc = clamp((rec.s.x - e.ax) * e.ux + (rec.s.z - e.az) * e.uz, 0, e.L);
      const px = e.ax + e.ux * tc, pz = e.az + e.uz * tc;
      const st = streetFront(px, pz, e.nx, e.nz);
      const score = Math.hypot(rec.s.x - px, rec.s.z - pz) * 0.3 + (st ? st.d * 0.45 + st.pen : 60);
      if (!best || score < best.score) best = { e, tc, street: st, score };
    }
    if (!best) return false;
    const slot = allocate(best.e, best.tc, 7.2);
    if (!slot) return false;
    buildFront(rec, out, best, slot, false, null);
    return true;
  };
  // A named industrial or commercial building (rishon.signs.json `company`): its name high on the
  // facade that faces a street, the way the halls in the zones carry it.
  const nameplate = (rec, out) => {
    const c = candidates(rec.s.x, rec.s.z, 6).find((cc) => cc.street && cc.e.L >= 6);
    if (!c) return false;
    const e = c.e, L = Math.min(e.L * 0.7, 20), tc = clamp(c.tc, L / 2 + 0.3, e.L - L / 2 - 0.3);
    const px = e.ax + e.ux * tc, pz = e.az + e.uz * tc, g = ground(px + e.nx * 0.6, pz + e.nz * 0.6), f = frameAt(px, pz, e.nx, e.nz, g);
    const bTop = e.b.top - (e.b.base ?? g), bh = clamp(L / 5, 1.2, 2.6), by = clamp(bTop - bh / 2 - 0.5, 4.2 + bh / 2, 16);
    if (bTop < by + bh / 2 - 0.1) return false;
    const lab = rec.lab;
    put(pools.board, f, 0, by, 0.12, L, bh, 0.24, lab.bg, RANGE_DIR);
    text(atlas, signRect({ main: lab.main, sub: null }), f, 0, by, 0.25, Math.min(L - 0.2, bh * 0.92 * (CELL_W / CELL_H)), bh * 0.92, RANGE_DIR, 0, lab.bg, lab.fg);
    stats.nameplates++;
    stats[lab.kind]++;
    Object.assign(out, { kind: 'nameplate', fx: px, fz: pz, nx: e.nx, nz: e.nz, width: L });
    return true;
  };
  const markEatery = (rec, out) => {
    const E = rec.eatery;
    Object.assign(out, { eatery: E.id, famous: true, source: E.src, ...(E.key ? { mapillary: E.key } : {}) });
    stats.eateryPlaced++;
  };
  for (const rec of records) {
    const { s, ty, lab } = rec;
    const out = { id: `shop-${shopsOut.length}`, type: ty, brand: rec.brand, name: lab.main, nameKind: lab.kind, x: s.x, z: s.z, kind: 'unplaced', inferred: rec.inferred };
    shopsOut.push(out);
    const mall = mallOf(s.x, s.z) || (s.level >= 1 ? malls.find((m) => Math.hypot(m.s.x - s.x, m.s.z - s.z) < 90 * SCALE) : null);
    if (mall) { mall.members.push({ text: lab.main, bg: lab.bg }); out.kind = 'directory'; out.mall = mall.name; stats.mallListed++; continue; }
    const lmk = landmarkAt(s.x, s.z);
    if (lmk && rec.eatery && landmarkFront(rec, out, lmk)) { markEatery(rec, out); continue; }
    if (lmk) { out.kind = 'landmark'; stats.landmark++; continue; }
    if (ty === 'company') { if (!nameplate(rec, out)) stats.unplaced++; continue; }
    const st = TYPES[ty] || [];
    const zone = zoneAt(s.x, s.z);
    const showroom = SHOWROOM_TYPES.has(ty) && (!!zone || BIG_TYPES.has(ty));
    // Well-known eateries get a wider front so their name reads from down the street.
    const wantW = showroom ? 13 : BIG_TYPES.has(ty) ? 10 : rec.eatery ? 7.2 : st[4] === 'small' ? 4.2 : 5.6;
    let slot = null, cand = null;
    let cands = candidates(s.x, s.z, showroom ? 6 : 0);
    // HaRova venues open onto the square or the walk, as they do: prefer those facades.
    if (rec.eatery && rec.eatery.rova) {
      const onRova = (c) => (c.street && c.street.rova) || facesSquare(c.e.ax + c.e.ux * c.tc, c.e.az + c.e.uz * c.tc, c.e.nx, c.e.nz);
      cands = cands.map((c) => ({ c, k: c.score - (onRova(c) ? 25 : 0) })).sort((a, b) => a.k - b.k).map((q) => q.c);
    }
    for (const c of cands.slice(0, 5)) {
      slot = allocate(c.e, c.tc, wantW);
      if (slot) { cand = c; break; }
    }
    if (!slot) {
      // No mapped building near the node (common for car dealers' lots): a freestanding pavilion.
      const pv = showroom || ty === 'kiosk' || zone || rec.eatery ? pavilion(rec, out, showroom) : null;
      if (pv) {
        if (rec.eatery) {
          markEatery(rec, out);
          // A freestanding eatery (beach kiosks, lots) still gets its tables in front.
          if ((TYPES[ty] || [])[0] === 'seat') {
            const free = (lx, lz, m = 0.9) => { const [x, z] = world(pv.f, lx, lz); return !onCarriage(x, z, m) && !buildingAt(x, z, null) && !landmarkAt(x, z); };
            const od = outdoor(rec, pv.f, pv.W, pv.H, clearance(pv.f.x, pv.f.z, pv.f.nx, pv.f.nz), false, false, hash(`${s.x}:${s.z}`), free,
              rec.eatery.style || null, !!rec.eatery.seat);
            if (od) Object.assign(out, od);
          }
        }
        continue;
      }
      stats.unplaced++;
      continue;
    }
    buildFront(rec, out, cand, slot, showroom, zone);
    if (rec.eatery) markEatery(rec, out);
  }

  // ---- photo fill: generic fronts of the photographed types on unmapped frontages ----
  for (const p of photoProfiles) {
    if (!p.fill) continue;
    const R = Math.sqrt(p.r2);
    let n = 0;
    const seen = new Set();
    bgrid.query(p.x, p.z, R, (b) => {
      if (seen.has(b.id)) return;
      seen.add(b.id);
      for (const e of edgesOf(b)) {
        if (e.L < 6 || n >= p.fill.length * 2) continue;
        if (!p.any && e.nx * p.fx + e.nz * p.fz <= 0.5) continue;
        for (let tc = 3; tc < e.L - 2.5; tc += 6.5) {
          const px = e.ax + e.ux * tc, pz = e.az + e.uz * tc;
          if ((px - p.x) ** 2 + (pz - p.z) ** 2 > p.r2) continue;
          if (buildingAt(px + e.nx * 1.2, pz + e.nz * 1.2, null) || landmarkAt(px, pz) || mallOf(px, pz)) continue;
          const st = streetFront(px, pz, e.nx, e.nz);
          if (!st || st.d > 14 || (p.onStrip && !st.strip)) continue;
          const slot = allocate(e, tc, 5.6);
          if (!slot) continue;
          const ty = p.fill[n % p.fill.length];
          const sx = e.ax + e.ux * slot.c, sz = e.az + e.uz * slot.c;
          const rec = { s: { x: sx, z: sz, name: '', nameLocal: '' }, ty, brand: null, inferred: true };
          rec.lab = labelOf(rec.s, ty, null, false);
          const out = { id: `shop-${shopsOut.length}`, type: ty, brand: null, name: rec.lab.main, nameKind: 'generic', x: sx, z: sz, kind: 'unplaced', inferred: true, fill: true };
          shopsOut.push(out);
          buildFront(rec, out, { e, tc, street: st }, slot, false, null);
          stats.photoFill++;
          n++;
        }
      }
    });
  }

  // ---- nightlife strip: generic venues on free facades facing it ----
  // OSM maps few of the strip's bars, so free street-facing slots get generic bars, pubs,
  // restaurants and cafés (generic type names only, never invented brands; flagged `inferred`).
  const MIX = [['bar', 0.32], ['pub', 0.13], ['restaurant', 0.25], ['cafe', 0.3]];
  let filled = 0;
  for (const r of stripRoads) {
    let acc = NIGHTLIFE_SPACING / 2;
    for (let i = 0; i < r.pts.length - 1 && filled < NIGHTLIFE_FILL_MAX; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-3) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      for (; acc < L && filled < NIGHTLIFE_FILL_MAX; acc += NIGHTLIFE_SPACING) {
        const x0 = ax + ux * acc, z0 = az + uz * acc;
        for (const sd of [-1, 1]) {
          if (filled >= NIGHTLIFE_FILL_MAX) break;
          if (hash(`n${Math.round(x0)}:${Math.round(z0)}:${sd}`) < 0.3) continue;
          const qx = x0 - uz * sd * (r.hw + 5), qz = z0 + ux * sd * (r.hw + 5);
          if (landmarkAt(qx, qz) || mallOf(qx, qz)) continue;
          // Only facades with sidewalk to sit on: a venue squeezed against the kerb adds nothing.
          const c = candidates(qx, qz).find((cc) => cc.street && cc.street.strip && cc.dist < 10 &&
            clearance(cc.e.ax + cc.e.ux * cc.tc, cc.e.az + cc.e.uz * cc.tc, cc.e.nx, cc.e.nz) >= 4);
          if (!c) continue;
          const slot = allocate(c.e, c.tc, 5.6);
          if (!slot) continue;
          const hv = hash(`v${Math.round(qx)}:${Math.round(qz)}`);
          let ty = 'cafe';
          for (let a = 0, k = 0; k < MIX.length; k++) { a += MIX[k][1]; if (hv < a) { ty = MIX[k][0]; break; } }
          const sx = c.e.ax + c.e.ux * slot.c, sz = c.e.az + c.e.uz * slot.c;
          const rec = { s: { x: sx, z: sz, name: '', nameLocal: '' }, ty, brand: null, inferred: true };
          rec.lab = labelOf(rec.s, ty, null, false);
          const out = { id: `shop-${shopsOut.length}`, type: ty, brand: null, name: rec.lab.main, nameKind: 'generic', x: sx, z: sz, kind: 'unplaced', inferred: true, fill: true };
          shopsOut.push(out);
          buildFront(rec, out, c, slot, false, null);
          filled++;
        }
      }
      acc -= L;
    }
  }
  stats.nightlifeFill = filled;

  // ---- HaRova: generic venues on free facades facing the square or the walk ----
  if (rovaSq) {
    const R = HAROVA.r * SCALE, seen = new Set();
    let n = 0;
    bgrid.query(rovaC.x, rovaC.z, R, (b) => {
      if (seen.has(b.id)) return;
      seen.add(b.id);
      for (const e of edgesOf(b)) {
        if (e.L < 6.5) continue;
        for (let tc = 3.4; tc < e.L - 3 && n < HAROVA.fillMax; tc += 7) {
          const px = e.ax + e.ux * tc, pz = e.az + e.uz * tc;
          if (!inRova(px, pz) || buildingAt(px + e.nx * 1.2, pz + e.nz * 1.2, null) || landmarkAt(px + e.nx * 1.2, pz + e.nz * 1.2) || mallOf(px, pz)) continue;
          const st = streetFront(px, pz, e.nx, e.nz);
          const sq = facesSquare(px, pz, e.nx, e.nz);
          if (!sq && !(st && st.rova && st.d < 14)) continue;
          if (clearance(px, pz, e.nx, e.nz) < 3) continue;
          const slot = allocate(e, tc, 6.4);
          if (!slot) continue;
          const hv = hash(`rova${Math.round(px)}:${Math.round(pz)}`);
          let ty = 'cafe';
          for (let a = 0, k = 0; k < MIX.length; k++) { a += MIX[k][1]; if (hv < a) { ty = MIX[k][0]; break; } }
          const sx = e.ax + e.ux * slot.c, sz = e.az + e.uz * slot.c;
          const rec = { s: { x: sx, z: sz, name: '', nameLocal: '' }, ty, brand: null, inferred: true };
          rec.lab = labelOf(rec.s, ty, null, false);
          const out = { id: `shop-${shopsOut.length}`, type: ty, brand: null, name: rec.lab.main, nameKind: 'generic', x: sx, z: sz, kind: 'unplaced', inferred: true, fill: true };
          shopsOut.push(out);
          buildFront(rec, out, { e, tc, street: st || { d: 0, pen: 1, strip: true, rova: true } }, slot, false, null);
          stats.rovaFill++;
          n++;
        }
      }
    });
  }

  // ---- Rothschild: bulbs strung across the street (Mapillary 2206982192807195) ----
  {
    const xa = project(31.964, STRING_ACROSS.lon0).x, xb = project(31.964, STRING_ACROSS.lon1).x;
    for (const r of stripRoads) {
      let acc = STRING_ACROSS.spacing / 2;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-3) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L;
        for (; acc < L; acc += STRING_ACROSS.spacing) {
          const x = ax + ux * acc, z = az + uz * acc;
          if (x < Math.min(xa, xb) || x > Math.max(xa, xb)) continue;
          const half = r.hw + 1.0, f = frameAt(x, z, ux, uz, ground(x, z));
          const ends = [world(f, -half, 0), world(f, half, 0)];
          if (!ends.every(([ex, ez]) => !onCarriage(ex, ez, 0.2) && !buildingAt(ex, ez, null))) continue;
          for (const sd of [-1, 1]) putAbs(pools.pole, f, sd * half, 0, ground(...world(f, sd * half, 0)), 0.8, 2.6, 0.8, '#5f666c', RANGE_FRONT);
          strand(f, [-half, 7.3, 0], [half, 7.3, 0], f.y, 0.9);
          stats.stringsAcross++;
        }
        acc -= L;
      }
    }
  }

  // ---- the Lotto booth on Rothschild's south walk (Mapillary 2206982192807195) ----
  {
    const c = project(LOTTO_BOOTH.lat, LOTTO_BOOTH.lon);
    const r = nearestRoad(c.x, c.z, 60);
    if (r && r.d > 0.5) {
      const nx = (r.cx - c.x) / r.d, nz = (r.cz - c.z) / r.d;
      // From the kerb outwards on the photo's side of the street, then along the walk.
      const tries = [];
      for (const out of [2.5, 3.5, 4.5, 6, 8]) for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) tries.push([k * 1.5, out]);
      for (const [k, out] of tries) {
        const x = r.cx - nx * (r.hw + out) - nz * k, z = r.cz - nz * (r.hw + out) + nx * k;
        const f0 = frameAt(x, z, nx, nz, 0);
        if (![[-1.7, -0.8], [1.7, -0.8], [-1.7, 1.4], [1.7, 1.4]].every(([a, b]) => { const [wx, wz] = world(f0, a, b); return !onCarriage(wx, wz, 0.3) && !buildingAt(wx, wz, null); })) continue;
        const f = frameAt(x, z, nx, nz, ground(x, z));
        put(pools.frame, f, 0, 1.2, 0, 1.8, 2.4, 1.4, '#f57c00', RANGE_FRONT);
        put(pools.glass, f, 0, 1.45, 0.72, 1.2, 0.8, 0.03, '#4a6f8c', RANGE_FRONT);
        put(pools.board, f, 0, 2.7, 0.25, 3.4, 0.22, 2.6, '#1e4fb4', RANGE_FRONT);
        put(pools.board, f, 0, 2.2, 0.73, 1.75, 0.5, 0.05, '#1e4fb4', RANGE_FRONT);
        text(atlas, signRect({ main: t('shop.brand.lotto', null, 'lotto'), sub: null }), f, 0, 2.2, 0.77, 1.6, 0.4, RANGE_FRONT, 0, '#1e4fb4', '#ffffff');
        rectCollider(f, 0, 0, 0.9, 0.7, 2.4);
        stats.photoMatched++;
        stats.lottoBooth = 1;
        break;
      }
    }
  }
  stats.photoProfiles = Object.fromEntries(photoProfiles.map((p) => [p.id, p.fronts]));

  // ---- industrial side streets: roller-shutter units on otherwise blank facades ----
  // Workshops and stores with their shutters half or fully down and a plain fascia band; no names
  // are invented, so these carry no text.
  if (zones.length) {
    let units = 0;
    for (const b of blds) {
      if (units >= SHUTTER_UNITS_MAX) break;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const zone = zoneAt(cx, cz);
      if (!zone || landmarkAt(cx, cz)) continue;
      for (const e of edgesOf(b)) {
        if (e.L < 7 || units >= SHUTTER_UNITS_MAX) continue;
        const mx = e.ax + e.ux * e.L / 2, mz = e.az + e.uz * e.L / 2;
        if (buildingAt(mx + e.nx * 1.2, mz + e.nz * 1.2, null)) continue;
        const st = streetFront(mx, mz, e.nx, e.nz);
        if (!st || !st.car || st.major || st.d > 16) continue;
        const n = Math.min(4, Math.floor((e.L - 1) / 6.2));
        for (let k = 0; k < n && units < SHUTTER_UNITS_MAX; k++) {
          if (hash(`u${b.id}:${e.i}:${k}`) < 0.4) continue;
          const slot = allocate(e, ((k + 0.5) * e.L) / n, 5);
          if (!slot) continue;
          const px = e.ax + e.ux * slot.c, pz = e.az + e.uz * slot.c;
          const f = frameAt(px, pz, e.nx, e.nz, ground(px + e.nx * 0.6, pz + e.nz * 0.6));
          const bTop = b.top - (b.base ?? f.y), H = clamp(bTop - 0.6, 3.6, 6.2), hd = Math.min(H * 0.78, 5.2), w = slot.w;
          const r = hash(`r${b.id}:${e.i}:${k}`);
          put(pools.frame, f, 0, (hd - 0.6) / 2, 0.05, w + 0.3, hd + 0.6, 0.12, '#3f454b', RANGE_FRONT);
          if (r < 0.5) shutter(f, 0, w, 0, hd, 0.16, `u${b.id}${k}`);
          else {
            // Half open: dark workshop inside below the shutter.
            put(pools.glass, f, 0, hd * 0.22, 0.12, w, hd * 0.44, 0.04, '#2b3035', RANGE_FRONT);
            shutter(f, 0, w, hd * 0.44, hd, 0.16, `u${b.id}${k}`);
          }
          const [pbg, pfg] = PALETTE[Math.floor(r * 97) % PALETTE.length], by = Math.min(H - 0.45, hd + 0.75);
          put(pools.board, f, 0, by, 0.18, w + 0.4, 0.8, 0.26, pbg, RANGE_FRONT);
          // Most units paint their trade on the fascia (generic trade names only).
          if (hash(`t${b.id}:${e.i}:${k}`) < 0.75) {
            const lab = { main: t(`shop.trade.${TRADES[Math.floor(hash(`tr${b.id}:${k}`) * TRADES.length)]}`), sub: null };
            text(atlas, signRect(lab), f, 0, by, 0.315, Math.min(w, 0.72 * (CELL_W / CELL_H)), 0.72, RANGE_FRONT, 0, pbg, pfg);
            stats.tradeSigns++;
          }
          units++;
        }
      }
    }
    stats.shutterUnits = units;
  }
  stats.seats = seats.length;

  // ---- mall directories ----
  for (const m of malls) {
    const poly = m.lm ? m.lm.points : m.b ? m.b.pts : null;
    let best = null;
    if (poly) {
      const a2 = signedArea2(poly);
      for (let i = 0; i < poly.length; i++) {
        const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length], L = Math.hypot(bx - ax, bz - az);
        if (L < 6) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L, nx = a2 > 0 ? uz : -uz, nz = a2 > 0 ? -ux : ux;
        const px = (ax + bx) / 2, pz = (az + bz) / 2;
        if (buildingAt(px + nx * 1.5, pz + nz * 1.5, m.b)) continue;
        const st = streetFront(px, pz, nx, nz);
        const score = (st ? st.d * 0.6 + st.pen + (st.car ? 0 : 3) : 80) - Math.min(L, 40) * 0.1;
        if (!best || score < best.score) best = { px, pz, nx, nz, L, score };
      }
    }
    if (!best) best = { px: m.s.x, pz: m.s.z, nx: 0, nz: 1, L: 10, score: 99 }; // no footprint: stand at the node
    const clear = clearance(best.px, best.pz, best.nx, best.nz);
    const lz = clear >= 3 ? clamp(clear - 2.2, 1.6, 4.5) : Math.max(0.8, clear * 0.5);
    const cx = best.px + best.nx * lz, cz = best.pz + best.nz * lz;
    const f = frameAt(cx, cz, best.nx, best.nz, ground(cx, cz));
    const PH = 7.6, PW = 3.0;
    put(pools.pylon, f, 0, 0, 0, PW, PH, 0.7, '#26324f', RANGE_DIR);
    put(pools.pylon, f, 0, PH, 0, PW + 0.3, 0.35, 0.9, m.bg, RANGE_DIR);
    const items = [...new Map(m.members.map((it) => [it.text, it])).values()].sort((a, b) => a.text.localeCompare(b.text, lang));
    const d = { name: m.name, bg: m.bg, fg: m.fg, title: t('shop.ui.directory'), items };
    const rect = dirAtlas.get(`d|${m.name}|${items.map((i) => i.text).join(',')}`, DIR_W, DIR_H, (ctx, x, y, w, h) => drawDirectory(ctx, x, y, w, h, d));
    const qh = PH - 1.2, qw = qh * (DIR_W / DIR_H);
    text(dirAtlas, rect, f, 0, PH / 2 + 0.25, 0.36, qw, qh, RANGE_DIR);
    text(dirAtlas, rect, f, 0, PH / 2 + 0.25, -0.36, qw, qh, RANGE_DIR, Math.PI);
    rectCollider(f, 0, 0, PW / 2, 0.35, PH);
    // A mall in an ordinary building also gets its name high on that facade (landmarks carry their own).
    if (m.b && best.score < 80) {
      const ff = frameAt(best.px, best.pz, best.nx, best.nz, ground(best.px + best.nx, best.pz + best.nz));
      const bw = Math.min(best.L * 0.6, 16), bh = clamp(bw / 4, 1.2, 3.2);
      const bTop = m.b.top - (m.b.base ?? ff.y);
      const by = clamp(bTop - bh / 2 - 0.6, 5.6 + bh / 2, 10);
      if (bTop > by + bh / 2) {
        put(pools.board, ff, 0, by, 0.2, bw, bh, 0.4, m.bg, RANGE_DIR);
        const qh2 = bh * 0.92;
        text(atlas, signRect({ main: m.name, sub: null }), ff, 0, by, 0.405, Math.min(bw - 0.1, qh2 * 4), qh2, RANGE_DIR, 0, m.bg, m.fg);
      }
    }
    stats.directories++;
    shopsOut.push({ id: `mall-${stats.directories}`, type: 'mall', name: m.name, x: m.s.x, z: m.s.z, kind: 'mall', fx: cx, fz: cz, nx: best.nx, nz: best.nz, members: items.length });
  }

  // ---- finalize: atlas pages, text pools, meshes ----
  atlas.finish();
  dirAtlas.finish();
  const quad = new THREE.PlaneGeometry(1, 1);
  const signPools = atlas.textures.map((tx, i) => new Pool(`text${i}`, quad, maskMat(tx, i), { attrs: { uvRect: 4, fgColor: 3 } }));
  const dirPools = dirAtlas.textures.map((tx, i) => new Pool(`dir${i}`, quad, textMat(tx, i), { attrs: { uvRect: 4 } }));
  const _fg = new THREE.Color();
  for (const [at, rect, m, range, bg, fg] of pendingText) {
    if (at === atlas) { _fg.set(fg); signPools[rect.page].add(m, bg, range, { uvRect: at.uv(rect), fgColor: [_fg.r, _fg.g, _fg.b] }); } else dirPools[rect.page].add(m, 0xffffff, range, { uvRect: at.uv(rect) });
  }
  const textPools = [...signPools, ...dirPools];
  const all = [...Object.values(pools), ...textPools];
  for (const p of all) p.build(group);
  scene.add(group);

  // Distance culling, refreshed whenever the camera has moved REFRESH_STEP units.
  const last = { x: Infinity, z: Infinity };
  const update = (pos) => {
    if (!pos || Math.hypot(pos.x - last.x, pos.z - last.z) < REFRESH_STEP) return;
    last.x = pos.x; last.z = pos.z;
    let n = 0;
    for (const p of all) n += p.refresh(pos);
    stats.visibleInstances = n;
  };
  // The refresh is driven by a mesh that always renders: driving it from a pool mesh deadlocked
  // once the camera stood where that pool had nothing in range (the mesh hid itself, so its
  // onBeforeRender never ran again and every storefront in the city stayed empty). The driver is
  // one degenerate triangle with colour and depth writes off; only the main perspective camera
  // moves the window (not the minimap's or the shadow pass's).
  const driverGeo = new THREE.BufferGeometry();
  driverGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  const driver = new THREE.Mesh(driverGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
  driver.name = 'storefront-driver';
  driver.frustumCulled = false;
  driver.onBeforeRender = (r, s, camera) => { if (camera && camera.isPerspectiveCamera) update(camera.position); };
  group.add(driver);

  Object.assign(stats, {
    labels: atlas.cache.size + dirAtlas.cache.size, atlasPages: atlas.pages.length + dirAtlas.pages.length, atlasMB: +((atlas.bytes + dirAtlas.bytes) / 1048576).toFixed(1),
    instances: all.reduce((n, p) => n + p.size, 0), meshes: all.filter((p) => p.mesh).length,
    malls: malls.length, colliders: colliders.length, ms: Math.round(performance.now() - t0),
  });
  group.userData.stats = stats;
  console.info('[storefronts]', JSON.stringify(stats));
  return { group, shops: shopsOut, seats, stalls, colliders, update, stats };
}
