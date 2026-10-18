// Builds the R15-style avatar mesh hierarchy from a resolved archetype config.
// Proportions follow the approved concept look (rishon-look.html): chunky bevelled parts, big
// rounded head, decal face. Built in "concept units" (~6.15 tall) and scaled by BODY_SCALE so the
// avatar is about 5 world units tall with its feet at y = 0, facing +z.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { torsoTextures, lowerTorsoTextures, patternTexture, shade } from './textures.js';
import { faceTexture, FACE_PLANE } from './faces.js';

// 0.85 of the round-2 size (0.82): the founder found the characters too big for the map.
export const BODY_SCALE = 0.697;
// Bevel radii (before rbox's x1.3): the head and limbs read rounder and less like crates.
const HEAD_R = 0.55;
const LIMB_R = 0.36;
// Height of the top of each hair style in head space (head box top = 0.8), for things worn on
// top of the hair such as the kippah.
const HAIR_TOP = { none: 0.8, bald: 0.8, buzz: 0.87, spiky: 0.94, bob: 0.86, short: 1.0, quiff: 1.0, messy: 1.0, long: 1.0, ponytail: 1.0, bun: 1.0, curly: 1.2, perm: 1.24 };

// Rig dimensions in concept units. Left = +x (the avatar faces +z).
export const DIMS = {
  // legs lengthened 10% (round 5, founder: limb lengths that read as human under the big toon head)
  hipY: 2.5, legX: 0.53, ul: 1.15, ll: 0.95, ankleH: 0.4,
  waistY: 0.55, shX: 1.58, shY: 1.5, ua: 0.95, la: 0.92,
  neckY: 1.65, headY: 0.85,
};

// ---------------------------------------------------------------------------------------------
// Shared materials and geometry (cached so a crowd shares GPU resources).
let gradientMap = null;
export function getGradientMap() {
  if (!gradientMap) {
    // same three-step ramp as the concept look
    gradientMap = new THREE.DataTexture(new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]), 3, 1);
    gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;
    gradientMap.needsUpdate = true;
  }
  return gradientMap;
}

const matCache = new Map();
export function mat(color, opts = {}) {
  const key = color + '|' + (opts.map ? opts.map.uuid : '') + '|' + (opts.side || 0) + '|' + (opts.decal ? 1 : 0);
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap: getGradientMap(), map: opts.map || null, side: opts.side || THREE.FrontSide });
    if (opts.decal) {
      m.transparent = true;
      m.alphaTest = 0.05;
      m.depthWrite = false;
      m.userData.outlineParameters = { visible: false };
    }
    matCache.set(key, m);
  }
  return m;
}

const geoCache = new Map();
// Softer than the first look: bevels a third rounder (never past half the thinnest side) and three
// segments so the curve reads smooth up close.
export function rbox(w, h, d, r) {
  const rr = Math.min((r ?? Math.min(w, h, d) * 0.18) * 1.3, Math.min(w, h, d) * 0.48);
  const k = [w, h, d, rr].map((v) => v.toFixed(3)).join();
  let g = geoCache.get(k);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 3, rr);
    geoCache.set(k, g);
  }
  return g;
}
// Limb segment that narrows toward its lower end (wrist, ankle): `t` is the bottom width factor.
// The box hangs from its top like the rig's limbs, so y runs from +h/2 (joint) to -h/2.
function tbox(w, h, d, r, t = 0.85) {
  const k = 'tb' + [w, h, d, r, t].map((v) => v.toFixed(3)).join();
  let g = geoCache.get(k);
  if (!g) {
    g = rbox(w, h, d, r).clone();
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const f = 1 + (t - 1) * (0.5 - pos.getY(i) / h);
      pos.setX(i, pos.getX(i) * f);
      pos.setZ(i, pos.getZ(i) * f);
    }
    g.computeVertexNormals();
    geoCache.set(k, g);
  }
  return g;
}
function cachedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}
const cyl = (rt, rb, h, seg = 16, open = false) =>
  cachedGeo(`cyl${rt},${rb},${h},${seg},${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
const ball = (r, ws = 16, hs = 12) => cachedGeo(`sph${r},${ws}`, () => new THREE.SphereGeometry(r, ws, hs));

export function addMesh(parent, geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
function group(parent, name, x = 0, y = 0, z = 0, order) {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  if (order) g.rotation.order = order;
  parent.add(g);
  return g;
}

// ---------------------------------------------------------------------------------------------
export function buildRig(cfg) {
  const skin = cfg.skin;
  const skinM = mat(skin);
  const root = new THREE.Group();
  root.name = 'avatar:' + cfg.id;
  const lean = group(root, 'lean');
  const body = group(lean, 'body');
  const bodyScale = BODY_SCALE * (cfg.body?.scale ?? 1);
  body.scale.setScalar(bodyScale);
  const bw = cfg.body?.width ?? 1;
  const belly = cfg.body?.belly ?? 0;
  const d = { ...DIMS, legX: DIMS.legX * bw, shX: 1.1 * bw + 0.48, scale: bodyScale };
  const J = {};
  const rig = { root, lean, body, J, dims: d, jiggles: [], props: {}, hideInVehicle: [], detail: [], cfg };

  // ---- materials from the outfit
  const shirt = cfg.shirt;
  const pants = cfg.pants || { color: '#3d5f8f' };
  const skirt = cfg.skirt;
  const tt = torsoTextures(shirt, skin);
  const coat = shirt.coat;
  const sleeveM = coat ? mat(coat) : mat('#ffffff', { map: tt.side });
  const shirtTop = mat(coat || shirt.color);
  const torsoMats = [
    coat ? mat(coat) : mat('#ffffff', { map: tt.side }),
    coat ? mat(coat) : mat('#ffffff', { map: tt.side }),
    shirtTop, shirtTop,
    mat('#ffffff', { map: tt.front }),
    mat('#ffffff', { map: tt.back }),
  ];
  const fabric = skirt && skirt.length !== 'coat' ? { color: skirt.color, pattern: skirt.pattern, alt: skirt.alt } : pants;
  const pantsM = fabric.pattern ? mat('#ffffff', { map: patternTexture(fabric) }) : mat(fabric.color);
  const lt = lowerTorsoTextures({ ...fabric, belt: skirt && skirt.length !== 'coat' ? null : pants.belt, kind: skirt ? 'skirt' : pants.kind });
  const ltOther = mat('#ffffff', { map: lt.other });
  const lowerMats = [ltOther, ltOther, pantsM, pantsM, mat('#ffffff', { map: lt.front }), ltOther];

  // ---- skeleton
  const pelvis = (J.pelvis = group(body, 'pelvis', 0, d.hipY, 0));
  addMesh(pelvis, rbox(1.95 * bw, 0.72, 1.1 + belly * 0.5, 0.34), lowerMats, 0, 0.25, belly * 0.15);
  const waist = (J.waist = group(pelvis, 'waist', 0, d.waistY, 0));
  const torsoW = 2.2 * bw;
  // narrower at the waist than the chest: a body, not a crate
  addMesh(waist, tbox(torsoW, 1.72, 1.15 + belly * 0.3, 0.4, belly > 0 ? 0.95 : 0.86), torsoMats, 0, 0.8, belly * 0.1);
  if (belly > 0) {
    addMesh(waist, rbox(torsoW * 0.84, 1.0, 0.6, 0.28), coat ? mat(coat) : torsoMats[0], 0, 0.4, 0.42 + belly * 0.35);
  }

  // legs
  const lowerLegM = (() => {
    if (cfg.legs?.lower) return mat(cfg.legs.lower);
    if (skirt && skirt.length === 'long') return pantsM;
    if (skirt && skirt.length === 'coat') return mat(pants.color);
    if (skirt) return skinM;
    return pants.kind === 'shorts' ? skinM : pantsM;
  })();
  const upperLegM = skirt && skirt.length === 'coat' ? mat(pants.color) : pantsM;
  for (const [side, s] of [['L', 1], ['R', -1]]) {
    const hip = (J['hip' + side] = group(pelvis, 'hip' + side, s * d.legX, 0, 0, 'XZY'));
    addMesh(hip, tbox(1.0 * Math.min(bw, 1.08), d.ul + 0.1, 1.05, LIMB_R, 0.86), upperLegM, 0, -d.ul * 0.476, 0);
    const knee = (J['kn' + side] = group(hip, 'kn' + side, 0, -d.ul, 0));
    addMesh(knee, tbox(0.92 * Math.min(bw, 1.08), d.ll + 0.13, 0.96, LIMB_R, 0.78), lowerLegM, 0, -d.ll * 0.47, 0);
    if (pants.cuff) addMesh(knee, rbox(1.02, 0.2, 1.06, 0.08), mat(pants.cuff), 0, -(d.ll - 0.09), 0);
    const ankle = (J['an' + side] = group(knee, 'an' + side, 0, -d.ll, 0));
    buildShoe(ankle, cfg.shoes || { kind: 'sneakers', color: '#ffffff' }, skinM, Math.min(bw, 1.08));
  }

  // arms
  const sleeves = shirt.sleeves || 'short';
  for (const [side, s] of [['L', 1], ['R', -1]]) {
    const sh = (J['sh' + side] = group(waist, 'sh' + side, s * d.shX, d.shY, 0, 'XZY'));
    if (sleeves === 'none') {
      // tank top (deliberate, e.g. the matkot vest): bare arm
      addMesh(sh, tbox(0.84, 1.12, 0.9, LIMB_R, 0.84), skinM, 0, -0.4, 0);
    } else if (sleeves === 'short') {
      // The sleeve is the outermost shell and reaches above the top of the arm, so no skin can
      // poke through at the shoulder in any pose; the bare part of the arm starts under the hem.
      addMesh(sh, tbox(0.82, 0.62, 0.88, LIMB_R, 0.9), skinM, 0, -0.65, 0);
      addMesh(sh, tbox(0.96, 0.82, 1.0, LIMB_R, 0.94), sleeveM, 0, -0.15, 0);
      addMesh(sh, rbox(0.92, 0.1, 0.96, 0.05), mat(shade(shirt.coat || shirt.color, -0.12)), 0, -0.53, 0);
    } else {
      addMesh(sh, tbox(0.88, 1.2, 0.94, LIMB_R, 0.86), sleeveM, 0, -0.38, 0);
    }
    const el = (J['el' + side] = group(sh, 'el' + side, 0, -d.ua, 0));
    addMesh(el, tbox(0.78, 1.0, 0.84, LIMB_R, 0.76), sleeves === 'long' ? sleeveM : skinM, 0, -0.42, 0);
    if (sleeves === 'mid') addMesh(el, rbox(0.92, 0.42, 0.98, 0.16), sleeveM, 0, -0.1, 0);
    if (shirt.cuff && sleeves === 'long') addMesh(el, rbox(0.88, 0.16, 0.94, 0.06), mat(shirt.cuff), 0, -0.86, 0);
    const wr = (J['wr' + side] = group(el, 'wr' + side, 0, -d.la, 0));
    J['hand' + side] = addMesh(wr, rbox(0.66, 0.6, 0.74, 0.32), skinM, 0, -0.24, 0);
    // thumb on the inside front of the hand (hidden on far LODs)
    const thumb = addMesh(wr, tbox(0.26, 0.44, 0.3, 0.12, 0.8), skinM, -s * 0.36, -0.2, 0.26);
    thumb.rotation.z = s * 0.35;
    rig.detail.push(thumb);
  }

  // neck + head
  const neck = (J.neck = group(waist, 'neck', 0, d.neckY, 0));
  addMesh(neck, cyl(0.42, 0.48, 0.4, 14), skinM, 0, 0.1, 0);
  const head = (J.head = group(neck, 'head', 0, d.headY, 0));
  head.scale.setScalar(cfg.body?.head ?? 1);
  addMesh(head, rbox(1.7, 1.6, 1.5, HEAD_R), skinM);
  const faceMat = new THREE.MeshToonMaterial({
    map: faceTexture(cfg.face, skin, 'neutral'),
    gradientMap: getGradientMap(), transparent: true, alphaTest: 0.05,
  });
  faceMat.userData.outlineParameters = { visible: false };
  // the decal bends round the head's bevels so its edges never float off the rounded corners
  const facePlane = addMesh(head, cachedGeo('facePlaneCurved', () => {
    const g = new THREE.PlaneGeometry(FACE_PLANE, FACE_PLANE, 12, 12);
    const r = Math.min(HEAD_R * 1.3, 1.5 * 0.48), hx = 0.85 - r, hy = 0.8 - r;
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const ex = Math.max(0, Math.abs(pos.getX(i)) - hx), ey = Math.max(0, Math.abs(pos.getY(i) - 0.05) - hy);
      const sx = r - Math.sqrt(Math.max(0, r * r - Math.min(ex, r) ** 2)), sy = r - Math.sqrt(Math.max(0, r * r - Math.min(ey, r) ** 2));
      pos.setZ(i, -(sx + sy));
    }
    g.computeVertexNormals();
    return g;
  }), faceMat, 0, -0.05, 0.765);
  facePlane.castShadow = false;
  rig.faceMat = faceMat;

  buildHair(rig, head, cfg.hair || { style: 'short', color: '#3b2416' });
  if (cfg.beard) buildBeard(rig, head, cfg.beard);
  for (const acc of cfg.accessories || []) buildAccessory(rig, acc);

  // skirt / long coat "bell": follows the mean thigh angle so it drapes when seated or pedalling
  if (skirt) {
    const lenMap = { coat: 1.38, midi: 1.82, long: 2.2 }; // scaled with the round-5 legs
    const len = lenMap[skirt.length] ?? 1.76;
    const flare = skirt.flare ?? (skirt.length === 'coat' ? 1.12 : 1.28);
    const pivot = group(pelvis, 'skirt', 0, 0.45, 0);
    const color = skirt.length === 'coat' ? coat || skirt.color : skirt.color;
    const m = skirt.pattern ? mat('#ffffff', { map: patternTexture(skirt, 256, 128), side: THREE.DoubleSide }) : mat(color, { side: THREE.DoubleSide });
    const bell = addMesh(pivot, cyl(1.0, flare, len, 20, true), m, 0, -len / 2, 0);
    bell.scale.set(1.12 * bw, 1, 0.66 + belly * 0.2);
    if (skirt.length === 'coat') {
      // shirt-tail slit in the front of a long coat reads instantly as a frock coat
      addMesh(pivot, rbox(0.14, len * 0.9, 0.06, 0.03), mat(shade(color, 0.25)), 0, -len * 0.5, 0.74);
    }
    rig.bell = { obj: pivot, len };
  }

  if (cfg.style?.phone) {
    // phone held in the right hand, screen toward the face
    const g = group(J.wrR, 'phone', 0, -0.45, 0.32);
    addMesh(g, rbox(0.62, 0.95, 0.14, 0.06), mat('#1e2226'), 0, 0, 0);
    addMesh(g, rbox(0.5, 0.78, 0.04, 0.03), mat('#8fd3ff'), 0, 0, 0.07);
    rig.hideInVehicle.push(g);
  }

  root.traverse((o) => {
    if (o.isMesh && o !== facePlane) o.castShadow = true;
  });
  return rig;
}

// ---------------------------------------------------------------------------------------------
function buildShoe(ankle, shoe, skinM, w) {
  const c = shoe.color || '#3a3a3a';
  const y = -0.2;
  switch (shoe.kind) {
    case 'flipflops':
      addMesh(ankle, rbox(0.98 * w, 0.32, 1.25, 0.14), skinM, 0, y + 0.02, 0.15);
      addMesh(ankle, rbox(1.08 * w, 0.1, 1.42, 0.04), mat(c), 0, -0.36, 0.15);
      addMesh(ankle, rbox(1.0 * w, 0.08, 0.14, 0.03), mat(shoe.strap || shade(c, -0.2)), 0, -0.1, 0.42);
      break;
    case 'sandals':
      addMesh(ankle, rbox(0.98 * w, 0.32, 1.25, 0.14), skinM, 0, y + 0.02, 0.15);
      addMesh(ankle, rbox(1.08 * w, 0.12, 1.42, 0.04), mat(c), 0, -0.35, 0.15);
      for (const z of [0.0, 0.42]) addMesh(ankle, rbox(1.02 * w, 0.1, 0.16, 0.04), mat(shade(c, -0.15)), 0, -0.12, z);
      break;
    case 'boots':
      addMesh(ankle, rbox(1.08 * w, 0.45, 1.35, 0.15), mat(c), 0, y, 0.15);
      addMesh(ankle, rbox(1.02 * w, 0.42, 1.06, 0.12), mat(c), 0, 0.12, 0);
      break;
    case 'sneakers':
      addMesh(ankle, rbox(1.08 * w, 0.4, 1.35, 0.15), mat(c), 0, y + 0.02, 0.15);
      addMesh(ankle, rbox(1.12 * w, 0.12, 1.42, 0.05), mat(shoe.sole || '#ffffff'), 0, -0.34, 0.15);
      if (shoe.stripe) addMesh(ankle, rbox(1.1 * w, 0.08, 0.5, 0.03), mat(shoe.stripe), 0, -0.12, 0.05);
      // toe cap and laces
      addMesh(ankle, rbox(0.98 * w, 0.22, 0.36, 0.1), mat(shoe.sole || '#ffffff'), 0, -0.24, 0.72);
      addMesh(ankle, rbox(0.42, 0.06, 0.5, 0.02), mat(shade(c, -0.35)), 0, 0.03, 0.42);
      break;
    default: // shoes
      addMesh(ankle, rbox(1.08 * w, 0.45, 1.35, 0.15), mat(c), 0, y, 0.15);
  }
}

// ---------------------------------------------------------------------------------------------
// Hair. Head box is 1.7 x 1.6 x 1.5 centred on the head group; top at y = 0.8, face at z = 0.75.
function buildHair(rig, head, hair) {
  const hc = hair.color || '#3b2416';
  const m = mat(hc);
  // a little fuller than the head so hair reads as hair, not a painted cap
  // An ellipsoid dome over the same span the old box cap had (bottom to top), so it reads round
  // from above too; a box's bevel is capped by its thin height and stayed square in plan.
  const cap = (h = 0.5, y = 0.66) => {
    const bot = y + 0.04 - (h + 0.08) / 2, tall = h + 0.08;
    const c = addMesh(head, cachedGeo('hairDome', () => new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), m, 0, bot, -0.03);
    c.scale.set(0.95, tall, 0.85);
    return c;
  };
  const back = (len = 1.1) => addMesh(head, rbox(1.8, len, 0.35, 0.17), m, 0, 0.75 - len / 2, -0.66);
  switch (hair.style) {
    case 'none':
      break;
    case 'buzz':
      addMesh(head, rbox(1.76, 0.3, 1.56, 0.16), m, 0, 0.72, -0.02);
      back(0.8);
      break;
    case 'short': {
      cap();
      back();
      // side-swept fringe over the forehead
      const fr = addMesh(head, rbox(1.05, 0.32, 0.55, 0.15), m, 0.25, 0.86, 0.5);
      fr.rotation.z = -0.18;
      break;
    }
    case 'spiky': {
      cap(0.4);
      back(1.0);
      for (let i = 0; i < 6; i++) {
        const s = addMesh(head, cachedGeo('spike', () => new THREE.ConeGeometry(0.28, 0.9, 4)), m, -0.65 + (i % 3) * 0.65, 1.12, -0.35 + Math.floor(i / 3) * 0.6);
        s.rotation.x = -0.3;
      }
      break;
    }
    case 'quiff': {
      cap(0.4);
      back(1.0);
      const q = addMesh(head, rbox(1.5, 0.6, 1.0, 0.28), m, 0, 1.02, 0.18);
      q.rotation.x = -0.35;
      break;
    }
    case 'curly':
    case 'perm': {
      cap(0.5, 0.64);
      back(hair.style === 'perm' ? 0.9 : 0.8);
      const pts = hair.style === 'perm'
        ? [[-0.6, 0.85, 0.3], [0, 0.95, 0.35], [0.6, 0.85, 0.3], [-0.75, 0.8, -0.3], [0, 0.95, -0.25], [0.75, 0.8, -0.3], [-0.92, 0.35, -0.25], [0.92, 0.35, -0.25], [-0.5, 0.45, -0.75], [0.5, 0.45, -0.75]]
        : [[-0.55, 0.9, 0.25], [0.05, 0.98, 0.3], [0.6, 0.9, 0.2], [-0.45, 0.92, -0.35], [0.4, 0.94, -0.4], [0, 0.6, -0.7]];
      for (const [x, y, z] of pts) addMesh(head, ball(hair.style === 'perm' ? 0.36 : 0.34), m, x, y, z);
      break;
    }
    case 'bun':
      cap(0.5, 0.64);
      back(1.2);
      addMesh(head, ball(hair.big ? 0.62 : 0.5), m, 0, hair.big ? 1.1 : 1.0, -0.5);
      break;
    case 'bob':
      addMesh(head, rbox(1.92, 1.35, 1.62, 0.35), m, 0, 0.18, -0.1);
      addMesh(head, rbox(1.75, 0.4, 0.25, 0.12), m, 0, 0.62, 0.72);
      break;
    case 'long': {
      cap();
      const piv = group(head, 'hairLong', 0, 0.6, -0.62);
      addMesh(piv, rbox(1.9, 2.6, 0.5, 0.22), m, 0, -1.1, 0);
      addMesh(head, rbox(0.22, 1.5, 0.9, 0.1), m, 0.9, 0.0, -0.2);
      addMesh(head, rbox(0.22, 1.5, 0.9, 0.1), m, -0.9, 0.0, -0.2);
      addMesh(head, rbox(1.2, 0.28, 0.2, 0.1), m, -0.2, 0.68, 0.72).rotation.z = 0.12;
      rig.jiggles.push(jiggle(piv, 0.6, 1));
      break;
    }
    case 'ponytail': {
      cap();
      back(0.9);
      const piv = group(head, 'ponytail', 0, 0.55, -0.82);
      addMesh(piv, ball(0.18), mat(hair.tie || '#e8364f'), 0, 0, 0);
      addMesh(piv, rbox(0.55, 1.4, 0.45, 0.2), m, 0, -0.65, -0.12);
      piv.rotation.x = 0.25;
      rig.jiggles.push(jiggle(piv, 1.0, 1, 0.25));
      break;
    }
    case 'bald':
      addMesh(head, rbox(0.2, 0.55, 0.9, 0.08), m, 0.86, 0.1, -0.2);
      addMesh(head, rbox(0.2, 0.55, 0.9, 0.08), m, -0.86, 0.1, -0.2);
      addMesh(head, rbox(1.6, 0.5, 0.22, 0.08), m, 0, 0.1, -0.74);
      break;
    case 'messy': {
      cap();
      back(1.1);
      for (const [x, y, z, rz] of [[-0.9, 0.2, -0.3, 0.5], [0.9, 0.2, -0.3, -0.5], [0, 0.0, -0.85, 0], [-0.5, 0.1, -0.8, 0.3]]) {
        const t = addMesh(head, rbox(0.3, 0.6, 0.3, 0.1), m, x, y, z);
        t.rotation.z = rz;
      }
      break;
    }
    default:
      cap();
      back();
  }
}

function buildBeard(rig, head, beard) {
  const m = mat(beard.color || '#2a1d14');
  const long = beard.style === 'long';
  const full = beard.style !== 'trim';
  if (beard.style === 'goatee') {
    // chin beard and moustache only, the cheeks stay clean
    addMesh(head, rbox(0.6, 0.55, 0.32, 0.14), m, 0, -0.78, 0.66);
    addMesh(head, rbox(0.75, 0.13, 0.12, 0.05), m, 0, -0.27, 0.8);
    for (const s of [1, -1]) addMesh(head, rbox(0.12, 0.42, 0.1, 0.04), m, s * 0.36, -0.48, 0.78);
    return;
  }
  if (long) {
    const piv = group(head, 'beard', 0, -0.4, 0.62);
    addMesh(piv, rbox(1.4, 1.25, 0.36, 0.16), m, 0, -0.6, 0);
    rig.jiggles.push(jiggle(piv, 0.35, 0.7));
  } else {
    addMesh(head, rbox(full ? 1.4 : 1.2, full ? 0.62 : 0.42, 0.35, 0.15), m, 0, full ? -0.7 : -0.62, 0.62);
  }
  // jaw sides join the beard to the hairline
  for (const s of [1, -1]) addMesh(head, rbox(0.22, 0.9, 0.9, 0.1), m, s * 0.8, -0.3, 0.15);
  if (beard.mustache !== false) addMesh(head, rbox(0.75, 0.13, 0.12, 0.05), m, 0, -0.27, 0.8);
}

// z of the shirt's front face in waist space (belly pushes it out)
function torsoFront(rig) {
  const belly = rig.cfg.body?.belly ?? 0;
  return (1.15 + belly * 0.3) / 2 + belly * 0.1;
}

// spring-hung part: gains are rad per (unit/s^2) of forward accel / vertical accel
function jiggle(obj, gainF = 0.5, gainV = 0.5, restX = 0, restZ = 0) {
  return { obj, gainF, gainV, restX, restZ, x: 0, z: 0, vx: 0, vz: 0 };
}

// ---------------------------------------------------------------------------------------------
function buildAccessory(rig, acc) {
  const { J } = rig;
  const head = J.head;
  const c = acc.color;
  switch (acc.type) {
    case 'cap': {
      const g = group(head, 'cap', 0, 0, 0);
      addMesh(g, rbox(1.85, 0.6, 1.65, 0.28), mat(c), 0, 0.82, -0.02);
      addMesh(g, rbox(1.5, 0.12, 0.95, 0.05), mat(acc.brim || c), 0, 0.58, 1.05);
      if (acc.logo) addMesh(g, rbox(0.5, 0.3, 0.06, 0.03), mat(acc.logo), 0, 0.85, 0.83);
      addMesh(g, ball(0.1, 8, 6), mat(acc.brim || c), 0, 1.13, -0.02);
      if (acc.backwards) g.rotation.y = Math.PI;
      else g.rotation.y = acc.tilt || 0;
      break;
    }
    case 'blackHat': {
      const k = mat('#141414');
      addMesh(head, cyl(1.45, 1.45, 0.12, 24), k, 0, 0.82, 0);
      addMesh(head, cyl(0.85, 0.95, 1.05, 20), k, 0, 1.38, 0);
      addMesh(head, cyl(0.97, 0.97, 0.2, 20), mat('#2a2a2a'), 0, 1.0, 0);
      // the pinched crease on top of the crown
      addMesh(head, rbox(0.25, 0.12, 1.1, 0.05), mat('#0c0c0c'), 0, 1.88, 0);
      break;
    }
    case 'flatCap': {
      const g = group(head, 'flatCap', 0, 0.7, 0.05);
      g.rotation.x = 0.12;
      addMesh(g, rbox(1.95, 0.42, 1.8, 0.2), mat(c), 0, 0.16, -0.05);
      addMesh(g, rbox(1.6, 0.1, 0.65, 0.04), mat(shade(c, -0.1)), 0, 0.0, 0.95);
      break;
    }
    case 'tembel':
      addMesh(head, cyl(0.55, 1.0, 0.85, 16), mat(c || '#f2e6c4'), 0, 1.15, 0);
      break;
    case 'beanie': {
      const b = addMesh(head, ball(0.98, 18, 12), mat(c), 0, 0.6, -0.08);
      b.scale.set(1, 0.85, 0.95);
      addMesh(head, rbox(1.95, 0.38, 1.72, 0.15), mat(shade(c, -0.12)), 0, 0.55, -0.05);
      break;
    }
    case 'kippah': {
      const tex = patternTexture({ color: c || '#ffffff', pattern: 'knit', alt: acc.ring || '#2f7fb3', alt2: acc.ring2 || acc.ring || '#2f7fb3', band: 9 }, 128, 64);
      // It sits on the hair, not on the scalp: under a full hair cap the old dome was swallowed.
      // A shallow cap (r 0.8, 0.7 rad) is 0.52 wide and 0.19 tall; its rim rests just below the
      // hair top, toward the crown.
      const top = HAIR_TOP[rig.cfg.hair?.style || 'short'] ?? HAIR_TOP.short;
      const g = group(head, 'kippah', 0, top - 0.03, -0.22);
      g.rotation.x = -0.32;
      addMesh(g, cachedGeo('kippah', () => new THREE.SphereGeometry(0.8, 24, 8, 0, Math.PI * 2, 0, 0.7).translate(0, -0.8 * Math.cos(0.7), 0)), mat('#ffffff', { map: tex }), 0, 0, 0);
      break;
    }
    case 'tichel': {
      const m = acc.pattern ? mat('#ffffff', { map: patternTexture({ color: c, pattern: acc.pattern, alt: acc.alt }) }) : mat(c);
      addMesh(head, rbox(1.98, 0.62, 1.72, 0.3), m, 0, 0.66, -0.1);
      addMesh(head, rbox(1.98, 1.35, 1.0, 0.42), m, 0, 0.3, -0.4);
      const piv = group(head, 'tichelKnot', 0, 0.45, -0.95);
      addMesh(piv, ball(0.5), m, 0, 0, 0);
      addMesh(piv, rbox(0.5, 0.8, 0.25, 0.1), m, 0.15, -0.6, -0.1).rotation.z = 0.2;
      rig.jiggles.push(jiggle(piv, 0.4, 0.6));
      addMesh(head, rbox(1.96, 0.14, 1.74, 0.07), mat(shade(c, -0.18)), 0, 0.38, -0.1);
      break;
    }
    case 'headband':
      addMesh(head, rbox(1.96, 0.16, 1.68, 0.08), mat(c), 0, 0.62, -0.06);
      break;
    case 'sunglassesOnHead': {
      const g = group(head, 'shades', 0, 0.98, 0.45);
      g.rotation.x = -0.35;
      for (const s of [1, -1]) addMesh(g, rbox(0.6, 0.34, 0.1, 0.1), mat(c || '#1e140f'), s * 0.38, 0, 0.18);
      addMesh(g, rbox(1.4, 0.07, 0.07, 0.03), mat(acc.frame || '#d8b24a'), 0, 0.08, 0.2);
      break;
    }
    case 'peyot': {
      const geo = cachedGeo('peyot', () => {
        const pts = [];
        for (let i = 0; i <= 40; i++) {
          const t = i / 40;
          pts.push(new THREE.Vector3(Math.cos(t * Math.PI * 7) * 0.09, -t * 1.0, Math.sin(t * Math.PI * 7) * 0.09));
        }
        return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.07, 6, false);
      });
      for (const s of [1, -1]) {
        const piv = group(head, 'peyot', s * 0.92, 0.1, 0.25);
        addMesh(piv, geo, mat(c || '#3b2416'));
        rig.jiggles.push(jiggle(piv, 0.6, 1.2));
      }
      break;
    }
    case 'goldChain': {
      const gold = mat(c || '#ffcb3d');
      const t = acc.big ? 0.14 : 0.09;
      const ch = addMesh(J.waist, cachedGeo('chain' + t, () => new THREE.TorusGeometry(0.62, t, 8, 22)), gold, 0, 1.42, 0.36);
      ch.rotation.x = 1.25;
      addMesh(J.waist, ball(acc.big ? 0.28 : 0.2, 10, 8), gold, 0, acc.big ? 0.94 : 0.98, 0.62);
      break;
    }
    case 'lanyard': {
      const front = torsoFront(rig) + 0.03;
      for (const sd of [1, -1]) {
        const st = addMesh(J.waist, rbox(0.1, 0.78, 0.04, 0.02), mat(c || '#2e86de'), sd * 0.2, 1.3, front);
        st.rotation.z = sd * 0.5;
      }
      addMesh(J.waist, rbox(0.42, 0.52, 0.05, 0.04), mat('#ffffff'), 0, 0.82, front + 0.01);
      addMesh(J.waist, rbox(0.42, 0.14, 0.06, 0.03), mat(c || '#2e86de'), 0, 1.02, front + 0.01);
      break;
    }
    case 'laptopBag': {
      const front = torsoFront(rig) + 0.03, w = rig.cfg.body?.width ?? 1;
      const strap = mat(shade(c || '#2b2b2b', 0.15));
      const sf = addMesh(J.waist, rbox(0.16, 2.5, 0.05, 0.02), strap, 0.1, 0.85, front);
      sf.rotation.z = 0.62;
      const sb = addMesh(J.waist, rbox(0.16, 2.5, 0.05, 0.02), strap, 0.1, 0.85, -front);
      sb.rotation.z = 0.62;
      const piv = group(J.waist, 'laptopBag', -1.15 * w, 0.1, 0.05);
      addMesh(piv, rbox(0.32, 1.1, 1.45, 0.1), mat(c || '#2b2b2b'), -0.05, -0.35, 0);
      addMesh(piv, rbox(0.36, 0.5, 1.48, 0.08), mat(shade(c || '#2b2b2b', 0.12)), -0.06, -0.05, 0);
      rig.jiggles.push(jiggle(piv, 0.5, 0.7));
      rig.hideInVehicle.push(piv);
      break;
    }
    case 'earbuds':
      for (const sd of [1, -1]) addMesh(head, ball(0.12, 8, 6), mat('#ffffff'), sd * 0.88, -0.15, 0.2);
      break;
    case 'sunHat': {
      addMesh(head, cyl(1.55, 1.55, 0.08, 24), mat(c || '#f2e6c4'), 0, 0.8, 0);
      addMesh(head, cyl(0.92, 0.98, 0.62, 20), mat(c || '#f2e6c4'), 0, 1.1, -0.02);
      addMesh(head, cyl(0.99, 0.99, 0.16, 20), mat(acc.band || '#5a3a22'), 0, 0.92, -0.02);
      break;
    }
    case 'helmet': {
      const hm = mat(c || '#2ec4b6');
      const h = addMesh(head, cachedGeo('helmet', () => new THREE.SphereGeometry(1.12, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)), hm, 0, 0.42, -0.05);
      h.scale.set(1, 0.95, 1.05);
      addMesh(head, rbox(0.3, 0.16, 1.9, 0.06), mat(shade(c || '#2ec4b6', -0.3)), 0, 1.47, -0.05);
      addMesh(head, rbox(0.1, 0.9, 0.08, 0.03), mat('#2b2b2b'), 0.86, -0.1, 0.1);
      addMesh(head, rbox(0.1, 0.9, 0.08, 0.03), mat('#2b2b2b'), -0.86, -0.1, 0.1);
      break;
    }
    case 'deliveryBox': {
      const bm = mat(c || '#2ec4b6');
      const back = -torsoFront(rig);
      addMesh(J.waist, rbox(2.0, 1.9, 1.45, 0.18), bm, 0, 1.05, back - 0.78);
      addMesh(J.waist, rbox(0.9, 0.6, 0.06, 0.05), mat('#ffffff'), 0, 1.2, back - 1.52);
      addMesh(J.waist, rbox(2.04, 0.14, 1.49, 0.05), mat(shade(c || '#2ec4b6', -0.25)), 0, 1.9, back - 0.78);
      for (const sd of [1, -1]) addMesh(J.waist, rbox(0.22, 0.12, 1.3, 0.05), mat('#2b2b2b'), sd * 0.6, 1.66, -0.1);
      break;
    }
    case 'beret': {
      // folded under the left shoulder strap, the way it is worn off duty
      const w = rig.cfg.body?.width ?? 1;
      const b = addMesh(J.waist, rbox(0.5, 0.16, 0.85, 0.07), mat(c || '#7a2a3a'), 0.72 * w, 1.68, 0.05);
      b.rotation.z = -0.12;
      addMesh(J.waist, rbox(0.32, 0.06, 0.95, 0.03), mat(shade(rig.cfg.shirt.color, -0.2)), 0.72 * w, 1.73, 0.05);
      break;
    }
    case 'kitbag': {
      const km = mat(c || '#5f6235');
      const back = -torsoFront(rig);
      addMesh(J.waist, cyl(0.78, 0.82, 2.4, 14), km, 0, 1.05, back - 0.7);
      addMesh(J.waist, cyl(0.84, 0.84, 0.14, 14), mat(shade(c || '#5f6235', -0.25)), 0, 0.35, back - 0.7);
      addMesh(J.waist, ball(0.3, 10, 8), mat(shade(c || '#5f6235', -0.15)), 0, 2.3, back - 0.7);
      for (const sd of [1, -1]) addMesh(J.waist, rbox(0.22, 0.12, 1.25, 0.05), mat(shade(c || '#5f6235', -0.3)), sd * 0.55, 1.66, -0.1);
      break;
    }
    case 'necklace': {
      const ch = addMesh(J.waist, cachedGeo('necklace', () => new THREE.TorusGeometry(0.6, 0.05, 6, 22)), mat(c || '#f4efe2'), 0, 1.45, 0.34);
      ch.rotation.x = 1.25;
      break;
    }
    case 'earrings':
      for (const s of [1, -1]) {
        const e = addMesh(head, cachedGeo('hoop', () => new THREE.TorusGeometry(0.13, 0.035, 6, 14)), mat(c || '#ffcb3d'), s * 0.88, -0.35, 0.05);
        e.rotation.y = Math.PI / 2;
      }
      break;
    case 'tzitzit': {
      const w = mat('#ffffff');
      const x = acc.x ?? 1.08;
      for (const s of [1, -1]) {
        const piv = group(J.pelvis, 'tzitzit', s * x, 0.1, 0.25);
        for (let i = 0; i < 3; i++) addMesh(piv, rbox(0.06, 1.0, 0.06, 0.02), w, s * 0.02 * i, -0.5, -0.12 * i);
        rig.jiggles.push(jiggle(piv, 0.9, 1.5));
      }
      break;
    }
    case 'watch':
      addMesh(J.elL, rbox(0.9, 0.18, 0.96, 0.06), mat(c || '#ffcb3d'), 0, -0.78, 0);
      break;
    case 'toteBag': {
      const piv = group(J.waist, 'tote', 1.18 * (rig.cfg.body?.width ?? 1), 1.55, -0.45);
      const bagM = mat('#ffffff', { map: patternTexture({ color: c || '#e8dcc0', pattern: acc.pattern || 'plain', alt: acc.alt }) });
      addMesh(piv, rbox(1.05, 1.25, 0.28, 0.1), bagM, 0.12, -1.65, 0);
      addMesh(piv, rbox(0.1, 1.2, 0.08, 0.03), mat(shade(c || '#e8dcc0', -0.2)), 0.05, -0.55, 0.05);
      if (acc.print) addMesh(piv, rbox(0.45, 0.45, 0.04, 0.05), mat(acc.print), 0.12, -1.6, 0.15);
      rig.jiggles.push(jiggle(piv, 0.5, 0.8));
      break;
    }
    case 'backpack': {
      const m = mat(c || '#ffcb3d');
      addMesh(J.waist, rbox(1.75, 1.55, 0.75, 0.25), m, 0, 0.85, -0.9);
      addMesh(J.waist, rbox(1.3, 0.6, 0.3, 0.12), mat(acc.pocket || shade(c || '#ffcb3d', -0.2)), 0, 0.45, -1.3);
      for (const s of [1, -1]) addMesh(J.waist, rbox(0.22, 0.12, 1.25, 0.05), mat(shade(c || '#ffcb3d', -0.25)), s * 0.6, 1.66, -0.1);
      break;
    }
    case 'matkot': {
      // the Israeli beach paddle game: one paddle in each hand
      const wood = mat(c || '#c9874a');
      for (const side of ['L', 'R']) {
        const g = group(J['wr' + side], 'matkot', 0, -0.4, 0.1);
        g.rotation.x = -0.45;
        const pad = addMesh(g, cyl(0.8, 0.8, 0.14, 20), side === 'L' ? mat(acc.alt || '#e8364f') : wood, 0, -1.05, 0);
        pad.rotation.z = Math.PI / 2;
        pad.scale.set(1, 1, 0.9);
        addMesh(g, rbox(0.25, 0.75, 0.2, 0.06), mat('#6b4a2a'), 0, -0.12, 0);
        rig.hideInVehicle.push(g);
      }
      break;
    }
    case 'coffee': {
      const g = group(J.wrR, 'coffee', 0, -0.5, 0.3);
      addMesh(g, cyl(0.32, 0.26, 0.8, 12), mat('#ffffff'), 0, -0.1, 0);
      addMesh(g, cyl(0.33, 0.33, 0.14, 12), mat('#7a4a2a'), 0, 0.32, 0);
      addMesh(g, cyl(0.335, 0.3, 0.3, 12), mat(c || '#8fbf6a'), 0, -0.1, 0);
      rig.hideInVehicle.push(g);
      break;
    }
    case 'handbag': {
      const piv = group(J.elL, 'handbag', 0.0, -0.25, 0.0);
      addMesh(piv, rbox(0.9, 0.75, 0.4, 0.15), mat(c || '#6b3b20'), 0.55, -0.55, 0);
      addMesh(piv, cachedGeo('bagHandle', () => new THREE.TorusGeometry(0.28, 0.05, 6, 14, Math.PI)), mat(shade(c || '#6b3b20', -0.2)), 0.55, -0.18, 0);
      rig.hideInVehicle.push(piv);
      break;
    }
    case 'camera': {
      // tourist's camera, carried in the right hand and raised to the eye by the 'photo' emote
      const g = group(J.wrR, 'camera', 0, -0.5, 0.3);
      addMesh(g, rbox(0.8, 0.52, 0.42, 0.1), mat(c || '#2b2b2b'), 0, 0, 0);
      const lens = addMesh(g, cyl(0.2, 0.22, 0.36, 12), mat('#141414'), 0, 0, 0.32);
      lens.rotation.x = Math.PI / 2;
      addMesh(g, rbox(0.18, 0.12, 0.1, 0.04), mat('#d9d9d9'), 0.24, 0.3, 0);
      rig.hideInVehicle.push(g);
      break;
    }
    case 'apron': {
      // shop counter apron: bib on the chest, skirt panel over the pelvis, neck strap
      const front = torsoFront(rig) + 0.03, w = rig.cfg.body?.width ?? 1;
      const am = mat(c || '#ffffff');
      addMesh(J.waist, rbox(1.55 * w, 1.35, 0.06, 0.04), am, 0, 0.6, front);
      addMesh(J.pelvis, rbox(1.8 * w, 1.05, 0.06, 0.04), am, 0, -0.05, 0.58 + (rig.cfg.body?.belly ?? 0) * 0.4);
      addMesh(J.waist, rbox(0.9, 0.42, 0.04, 0.03), mat(shade(c || '#ffffff', -0.12)), 0, 0.42, front + 0.03); // pocket
      for (const sd of [1, -1]) addMesh(J.waist, rbox(0.12, 0.7, 0.05, 0.02), am, sd * 0.55, 1.5, front - 0.02).rotation.z = sd * 0.35;
      break;
    }
    case 'guitar': {
      // acoustic guitar slung across the front: body at the right hip, neck up to the left
      const front = torsoFront(rig);
      const g = group(J.waist, 'guitar', -0.25, 0.45, front + 0.42);
      g.rotation.z = -1.2;
      const wood = mat(c || '#c9874a');
      addMesh(g, rbox(1.55, 1.25, 0.42, 0.3), wood, 0, -0.35, 0);
      addMesh(g, rbox(1.25, 0.95, 0.42, 0.28), wood, 0, 0.55, 0);
      const hole = addMesh(g, cyl(0.3, 0.3, 0.05, 14), mat('#2b1a10'), 0, 0.15, 0.22);
      hole.rotation.x = Math.PI / 2;
      addMesh(g, rbox(0.3, 2.3, 0.18, 0.06), mat('#5a3a22'), 0, 2.1, 0);
      addMesh(g, rbox(0.42, 0.55, 0.2, 0.06), mat('#2b1a10'), 0, 3.4, 0);
      addMesh(g, rbox(0.12, 2.6, 0.06, 0.03), mat(acc.strap || '#e8364f'), -0.62, 1.1, -0.2).rotation.z = 0.2;
      rig.hideInVehicle.push(g);
      rig.guitar = g;
      g.userData.neck = [0.1, 2.25, 0.3];
      g.userData.strum = [0, 0.35, 0.55];
      rig.instrument = { kind: 'guitar', group: g };
      break;
    }
    case 'ukulele': {
      // small and bright, held higher on the chest
      const front = torsoFront(rig);
      const g = group(J.waist, 'ukulele', -0.15, 0.8, front + 0.32);
      g.rotation.z = -1.15;
      const wood = mat(c || '#e0a526');
      addMesh(g, rbox(0.95, 0.75, 0.3, 0.22), wood, 0, -0.2, 0);
      addMesh(g, rbox(0.78, 0.6, 0.3, 0.2), wood, 0, 0.35, 0);
      const hole = addMesh(g, cyl(0.17, 0.17, 0.05, 12), mat('#2b1a10'), 0, 0.05, 0.16);
      hole.rotation.x = Math.PI / 2;
      addMesh(g, rbox(0.2, 1.2, 0.12, 0.05), mat('#5a3a22'), 0, 1.2, 0);
      addMesh(g, rbox(0.3, 0.35, 0.14, 0.05), mat('#2b1a10'), 0, 1.9, 0);
      rig.hideInVehicle.push(g);
      rig.guitar = g;
      g.userData.neck = [0.05, 1.35, 0.25];
      g.userData.strum = [0, 0.1, 0.42];
      rig.instrument = { kind: 'ukulele', group: g };
      break;
    }
    case 'electricGuitar': {
      // solid body with two horns, a pickguard and a long neck
      const front = torsoFront(rig);
      const g = group(J.waist, 'electricGuitar', -0.25, 0.45, front + 0.36);
      g.rotation.z = -1.2;
      const body = mat(c || '#d7263d');
      addMesh(g, rbox(1.45, 1.4, 0.3, 0.3), body, 0, -0.1, 0);
      addMesh(g, rbox(0.45, 0.7, 0.3, 0.18), body, 0.45, 0.8, 0);
      addMesh(g, rbox(0.35, 0.5, 0.3, 0.15), body, -0.45, 0.72, 0);
      addMesh(g, rbox(0.8, 0.9, 0.04, 0.15), mat('#ffffff'), -0.1, 0.0, 0.16);
      for (const y of [0.2, -0.2]) addMesh(g, rbox(0.55, 0.14, 0.06, 0.03), mat('#2b2b2b'), 0, y, 0.19);
      addMesh(g, rbox(0.26, 2.4, 0.15, 0.05), mat('#e0b07a'), 0, 1.85, 0);
      addMesh(g, rbox(0.36, 0.6, 0.16, 0.06), mat('#2b2b2b'), 0, 3.3, 0);
      addMesh(g, rbox(0.12, 2.6, 0.06, 0.03), mat(acc.strap || '#141414'), -0.62, 1.1, -0.2).rotation.z = 0.2;
      rig.hideInVehicle.push(g);
      rig.guitar = g;
      g.userData.neck = [0.1, 2.2, 0.25];
      g.userData.strum = [0, 0.15, 0.4];
      rig.instrument = { kind: 'electricGuitar', group: g };
      break;
    }
    case 'violin': {
      // built along +y (scroll at the top); the avatar turns it under the chin when playing
      const g = group(J.waist, 'violin', 0.55, 0.6, 0.0);
      const wood = mat(c || '#9a4a1e');
      addMesh(g, rbox(0.7, 0.55, 0.22, 0.2), wood, 0, -0.25, 0);
      addMesh(g, rbox(0.55, 0.5, 0.22, 0.18), wood, 0, 0.25, 0);
      addMesh(g, rbox(0.14, 0.9, 0.1, 0.04), mat('#1e140f'), 0, 0.85, 0.02);
      addMesh(g, rbox(0.18, 0.22, 0.12, 0.06), mat('#5a3a22'), 0, 1.38, 0);
      const bow = group(J.wrR, 'bow', 0, -0.45, 0.25);
      addMesh(bow, rbox(0.06, 2.2, 0.06, 0.02), mat('#5a3a22'), 0, 0, 0.0).rotation.z = Math.PI / 2;
      bow.visible = false;
      rig.hideInVehicle.push(g);
      rig.instrument = { kind: 'violin', group: g, bow };
      break;
    }
    case 'flute': {
      const g = group(J.waist, 'flute', 0.5, 0.3, 0.0);
      const fm = mat(c || '#d9d9d9');
      addMesh(g, cyl(0.07, 0.07, 2.2, 8), fm, 0, 0, 0);
      for (let k = 0; k < 4; k++) addMesh(g, rbox(0.1, 0.08, 0.1, 0.03), mat('#9aa3ab'), 0, -0.6 + k * 0.3, 0.07);
      rig.hideInVehicle.push(g);
      rig.instrument = { kind: 'flute', group: g };
      break;
    }
    // ---- round 5: Ofir's other instruments (each held at the hip until played) ----
    case 'melodica': {
      // a little keyboard you blow into: keys along +y, mouthpiece tube at the top end
      const g = group(J.waist, 'melodica', 0.6, 0.35, 0.05);
      addMesh(g, rbox(0.55, 1.7, 0.28, 0.1), mat(c || '#d7263d'), 0, 0, 0);
      addMesh(g, rbox(0.34, 1.5, 0.05, 0.02), mat('#f4efe2'), 0.06, 0, 0.15);
      for (let k = 0; k < 7; k++) addMesh(g, rbox(0.16, 0.08, 0.05, 0.02), mat('#1d1d24'), 0.13, -0.6 + k * 0.2, 0.18);
      const tube = addMesh(g, cyl(0.05, 0.05, 0.7, 6), mat('#e8e8e8'), 0, 1.15, 0.05);
      tube.rotation.x = 0.4;
      rig.hideInVehicle.push(g);
      rig.instrument = { kind: 'melodica', group: g };
      break;
    }
    case 'darbuka': {
      // the goblet drum, carried under the left arm, played with the right hand
      const g = group(J.waist, 'darbuka', 0.95, 0.35, 0.25);
      const m = mat(c || '#c9a227');
      addMesh(g, cyl(0.5, 0.42, 0.55, 16), m, 0, 0.25, 0);
      addMesh(g, cyl(0.22, 0.24, 0.35, 12), m, 0, -0.18, 0);
      addMesh(g, cyl(0.3, 0.38, 0.22, 14), m, 0, -0.45, 0);
      addMesh(g, cyl(0.51, 0.51, 0.05, 16), mat('#f1e3c6'), 0, 0.54, 0);
      for (let k = 0; k < 3; k++) addMesh(g, cyl(0.505, 0.505, 0.04, 16), mat(acc.band || '#7a3a1e'), 0, 0.05 + k * 0.15, 0);
      rig.hideInVehicle.push(g);
      rig.instrument = { kind: 'darbuka', group: g };
      break;
    }
    case 'kazoo': {
      const g = group(J.wrR, 'kazoo', 0, -0.45, 0.3);
      addMesh(g, cyl(0.07, 0.1, 0.55, 8), mat(c || '#ffcb3d'), 0, 0, 0).rotation.x = Math.PI / 2;
      addMesh(g, cyl(0.06, 0.06, 0.08, 8), mat('#e8364f'), 0, 0.08, 0.05);
      rig.hideInVehicle.push(g);
      rig.instrument = { kind: 'kazoo', group: g };
      break;
    }
    case 'shofar': {
      // a ram's horn: a tapered, gently curling tube built from a few segments along +y
      const g = group(J.waist, 'shofar', 0.7, 0.25, 0.1);
      const m = mat(c || '#d9b98a'), tip = mat(shade(c || '#d9b98a', -0.25));
      let y = 0, z = 0, ang = 0;
      for (let k = 0; k < 6; k++) {
        const r0 = 0.24 - k * 0.032, r1 = r0 - 0.032, len = 0.36;
        const seg = addMesh(g, cyl(r1, r0, len, 10), k > 3 ? tip : m, 0, y + Math.cos(ang) * len * 0.5, z + Math.sin(ang) * len * 0.5);
        seg.rotation.x = ang;
        y += Math.cos(ang) * len; z += Math.sin(ang) * len; ang += 0.28;
      }
      rig.hideInVehicle.push(g);
      rig.instrument = { kind: 'shofar', group: g };
      break;
    }
    case 'keyboard': {
      // a portable keyboard on a strap, worn across the front like a keytar
      const front = torsoFront(rig);
      const g = group(J.waist, 'keyboard', 0, 0.15, front + 0.45);
      addMesh(g, rbox(2.6, 0.22, 0.7, 0.08), mat(c || '#1d1d24'), 0, 0, 0);
      addMesh(g, rbox(2.3, 0.05, 0.42, 0.02), mat('#f4efe2'), 0, 0.12, 0.08);
      for (let k = 0; k < 9; k++) addMesh(g, rbox(0.1, 0.05, 0.24, 0.02), mat('#1d1d24'), -1.0 + k * 0.25, 0.15, -0.02);
      addMesh(g, rbox(0.12, 2.4, 0.06, 0.03), mat(acc.strap || '#2ec4b6'), 0.9, 1.1, -0.35).rotation.z = 0.45;
      rig.hideInVehicle.push(g);
      rig.instrument = { kind: 'keyboard', group: g };
      break;
    }
    // ---- round 5: the bride, the choir ----
    case 'veil': {
      // tulle from a small tiara down the back to the waist, swaying as she walks
      const tm = new THREE.MeshToonMaterial({ color: c || '#ffffff', gradientMap: getGradientMap(), transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
      addMesh(head, rbox(1.5, 0.16, 0.2, 0.06), mat(acc.tiara || '#e8d9a8'), 0, 0.98, 0.35);
      const piv = group(head, 'veil', 0, 0.95, -0.35);
      addMesh(piv, rbox(1.7, 0.04, 0.9, 0.02), tm, 0, 0.0, -0.2);
      const fall = addMesh(piv, rbox(1.9, 2.8, 0.04, 0.02), tm, 0, -1.4, -0.75);
      fall.rotation.x = 0.12;
      rig.jiggles.push(jiggle(piv, 0.7, 0.9));
      break;
    }
    case 'bouquet': {
      const g = group(J.wrR, 'bouquet', 0, -0.5, 0.35);
      addMesh(g, cyl(0.12, 0.08, 0.6, 8), mat('#5a8a3a'), 0, -0.1, 0);
      const cols = acc.colors || ['#ffffff', '#f6b6c8', '#ffe08a', '#ffffff', '#f6b6c8'];
      cols.forEach((col, k) => addMesh(g, ball(0.2), mat(col), Math.cos(k * 1.26) * 0.22, 0.32 + (k % 2) * 0.08, Math.sin(k * 1.26) * 0.22));
      rig.hideInVehicle.push(g);
      break;
    }
    case 'stole': {
      // choir stole: two bands down the front of the robe from a collar
      const front = torsoFront(rig) + 0.03, w = rig.cfg.body?.width ?? 1;
      const sm = mat(c || '#e8c547');
      for (const sd of [1, -1]) addMesh(J.waist, rbox(0.42 * w, 1.75, 0.06, 0.03), sm, sd * 0.45 * w, 0.75, front);
      addMesh(J.waist, rbox(1.7 * w, 0.22, 1.2, 0.08), sm, 0, 1.62, 0);
      break;
    }
    default:
      console.warn('[avatar] unknown accessory', acc.type);
  }
}
