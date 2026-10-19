// The Beit Albert clock at Rothschild x Ze'ev Jabotinsky, by the Rothschild mall (founder's
// photos, 2026-10-19): a round white clock with dark ticks over the corner of the building,
// with the building's name in big letters below it. The hands show the player's real local time.
//
// Placement: OSM footprint of the south-east corner building (data/rishon.json building 5189),
// corner vertex 31.963752, 34.800104; its two facades face west (Jabotinsky) and north (Rothschild),
// so the clock faces north-west, across the junction.
import * as THREE from 'three';
import { project } from '../geo.js';
import { toonMat } from '../engine/renderer.js';
import { groundAt } from './terrain.js';
import { t } from '../i18n.js';

export const CLOCK = { lat: 31.963752, lon: 34.800104 };
const FACING = Math.atan2(-0.76, -0.65); // north-west, the bisector of the two facades
// The rendered building sits ~4.5 units inside its OSM corner (measured with a ray in the game),
// so the panel's front stands ~2 units proud of that tip (the facades are not at a clean 45 degrees); DEPTH reaches back into both facades.
const OUT = -2.6;
const DEPTH = 8.2;
const PANEL_Y = 10.5; // above the shop colonnade
const R = 2.3;        // clock face radius
const FONT = '"Rubik", "Arial Hebrew", sans-serif';

const isRtl = (s) => [...s].some((ch) => { const c = ch.codePointAt(0); return c >= 0x0590 && c <= 0x05ff; });

function nameTexture(text) {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 192;
  const g = cv.getContext('2d');
  g.fillStyle = '#e9e4d8'; g.fillRect(0, 0, cv.width, cv.height);
  g.direction = isRtl(text) ? 'rtl' : 'ltr';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let s = 150;
  g.font = `800 ${s}px ${FONT}`;
  while (g.measureText(text).width > cv.width * 0.9 && s > 20) { s -= 6; g.font = `800 ${s}px ${FONT}`; }
  g.fillStyle = '#2f6e8e'; g.fillText(text, cv.width / 2, cv.height / 2 + 6);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildClock(scene) {
  const c = project(CLOCK.lat, CLOCK.lon);
  const g = new THREE.Group();
  g.position.set(c.x + Math.sin(FACING) * OUT, groundAt(c.x, c.z), c.z + Math.cos(FACING) * OUT);
  g.rotation.y = FACING;

  // Name band across the corner, like the lettering under the clock in the photo.
  const band = new THREE.Mesh(new THREE.BoxGeometry(12, 2.6, DEPTH), toonMat(0xe9e4d8));
  band.position.set(0, PANEL_Y, 0.3 - DEPTH / 2);
  g.add(band);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(11.6, 2.2), new THREE.MeshBasicMaterial({ map: nameTexture(String(t('sign.beit_albert', null, 'BEIT ALBERT'))) }));
  label.position.set(0, PANEL_Y, 0.31);
  g.add(label);
  // Parapet the clock sits on.
  const cap = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.5, DEPTH + 0.4), toonMat(0xd6d0c2));
  cap.position.set(0, PANEL_Y + 1.55, 0.5 - DEPTH / 2);
  g.add(cap);

  const face = new THREE.Group();
  face.position.set(0, PANEL_Y + 1.8 + R + 0.2, 0.1);
  g.add(face);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.35, 40), toonMat(0xf7f6f0));
  disc.rotation.x = Math.PI / 2;
  face.add(disc);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.16, 8, 40), toonMat(0x3a3f47));
  rim.position.z = 0.18;
  face.add(rim);
  const dark = toonMat(0x23262c);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const long = i % 3 === 0;
    const tick = new THREE.Mesh(new THREE.BoxGeometry(long ? 0.22 : 0.12, long ? 0.6 : 0.4, 0.06), dark);
    const rr = R - (long ? 0.45 : 0.38);
    tick.position.set(Math.sin(a) * rr, Math.cos(a) * rr, 0.2);
    tick.rotation.z = -a;
    face.add(tick);
  }
  // Hands pivot at the centre; the geometry is shifted so each hand grows out of the pivot.
  const hand = (len, w) => {
    const geo = new THREE.BoxGeometry(w, len, 0.06);
    geo.translate(0, len / 2 - 0.15, 0);
    const m = new THREE.Mesh(geo, dark);
    m.position.z = 0.26;
    face.add(m);
    return m;
  };
  const hour = hand(R * 0.5, 0.2), minute = hand(R * 0.78, 0.13);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 12), dark);
  hub.rotation.x = Math.PI / 2; hub.position.z = 0.3;
  face.add(hub);

  // The time changes once a minute, so a timer is enough instead of a per-frame hook.
  const set = () => {
    const d = new Date();
    const m = d.getMinutes() + d.getSeconds() / 60;
    minute.rotation.z = -(m / 60) * Math.PI * 2;
    hour.rotation.z = -(((d.getHours() % 12) + m / 60) / 12) * Math.PI * 2;
  };
  set();
  setInterval(set, 15000);

  scene.add(g);
  return { group: g };
}
