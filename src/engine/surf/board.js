// Toon surfboards. One shape (pointed nose, rounded pin tail, nose rocker), a stripe on the deck
// and three fins underneath, coloured per rider. The board lies along +z (nose), deck up at
// y = DECK, so a rider group can stand on it at the origin.
import * as THREE from 'three';

export const BOARD = { length: 6.2, width: 1.55, thick: 0.26, DECK: 0.26 };

// Per-rider looks. Malul's board matches his red guitar strap, Ofir's his teal print.
export const BOARD_LOOKS = {
  player: { color: 0xffcb3d, stripe: 0x2ec4b6, rail: 0xffffff },
  malul: { color: 0x1d1d24, stripe: 0xe8364f, rail: 0xffcb3d },
  ofir: { color: 0xffffff, stripe: 0x2ec4b6, rail: 0x2ec4b6 },
  dekel: { color: 0x9fd3ff, stripe: 0xffcb3d, rail: 0xffffff },
  adir: { color: 0x23324a, stripe: 0xffb347, rail: 0xffffff },
};

let gradient = null;
function toon(color) {
  if (!gradient) {
    gradient = new THREE.DataTexture(new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]), 3, 1);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
  }
  return new THREE.MeshToonMaterial({ color, gradientMap: gradient });
}

// Outline in (x = half width side, y = along the board) for a board of length L and width W.
function outline(L, W, scale = 1) {
  const s = new THREE.Shape();
  const n = 28;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n; // 0 tail .. 1 nose
    // wide point a little behind the middle, pointed nose, narrow pin tail
    const w = W * 0.5 * scale * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.06)), 0.62) * (t > 0.8 ? 1 - (t - 0.8) * 1.6 : 1);
    pts.push([Math.max(0.02, w), (t - 0.5) * L * scale]);
  }
  s.moveTo(0, pts[0][1]);
  for (const [x, y] of pts) s.lineTo(x, y);
  for (let i = pts.length - 1; i >= 0; i--) s.lineTo(-pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

// Lift the nose (and a touch of the tail): the rocker every board has.
function rocker(geo, L) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i) / (L * 0.5); // -1 tail .. 1 nose
    const lift = z > 0 ? 0.55 * Math.pow(z, 3) : 0.12 * Math.pow(-z, 3);
    pos.setY(i, pos.getY(i) + lift);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

const geoCache = new Map();
function boardGeometries() {
  if (geoCache.size) return geoCache;
  const { length: L, width: W, thick: H } = BOARD;
  const deck = new THREE.ExtrudeGeometry(outline(L, W), { depth: H * 0.6, bevelEnabled: true, bevelThickness: H * 0.2, bevelSize: 0.1, bevelSegments: 2, curveSegments: 4 });
  // shape lies in XY; turn it so the board's length runs along +z and the deck faces +y
  deck.rotateX(Math.PI / 2);
  deck.translate(0, H * 0.8, 0);
  rocker(deck, L);
  const stripe = new THREE.ExtrudeGeometry(outline(L * 0.86, W * 0.16), { depth: 0.02, bevelEnabled: false, curveSegments: 3 });
  stripe.rotateX(Math.PI / 2);
  stripe.translate(0, H + 0.035, 0);
  rocker(stripe, L);
  const fin = new THREE.BufferGeometry();
  // a swept triangle fin, root along z
  fin.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.35, 0, 0, -0.25, 0, -0.55, -0.4], 3));
  fin.computeVertexNormals();
  geoCache.set('deck', deck).set('stripe', stripe).set('fin', fin);
  return geoCache;
}

// -> THREE.Group (nose +z, deck top at about y = BOARD.DECK). look: a BOARD_LOOKS key or { color, stripe, rail }.
export function buildBoard(look = 'player') {
  const L = typeof look === 'string' ? BOARD_LOOKS[look] || BOARD_LOOKS.player : look;
  const geos = boardGeometries();
  const g = new THREE.Group();
  g.name = 'surfboard';
  const deck = new THREE.Mesh(geos.get('deck'), toon(L.color));
  const stripe = new THREE.Mesh(geos.get('stripe'), toon(L.stripe));
  deck.castShadow = true;
  g.add(deck, stripe);
  const finMat = toon(L.rail);
  finMat.side = THREE.DoubleSide;
  for (const [x, z, s] of [[0, -BOARD.length * 0.4, 1], [0.42, -BOARD.length * 0.33, 0.8], [-0.42, -BOARD.length * 0.33, 0.8]]) {
    const f = new THREE.Mesh(geos.get('fin'), finMat);
    f.position.set(x, 0.02, z);
    f.scale.setScalar(s);
    g.add(f);
  }
  // A short leash cord coiled behind the tail.
  const leash = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.04, 5, 14), toon(0x23324a));
  leash.rotation.x = Math.PI / 2;
  leash.position.set(0, BOARD.DECK + 0.05, -BOARD.length * 0.47);
  g.add(leash);
  g.userData.look = L;
  return g;
}
