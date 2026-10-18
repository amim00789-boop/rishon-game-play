// Printed cartoon faces, drawn on a transparent 256x256 canvas that sits as a decal plane on the
// front of the head (same treatment as the approved concept look, rishon-look.html).
// Layout is the concept's 128 px layout doubled.
import { canvasTexture, rgba, shade, rng } from './textures.js';

export const FACE_PLANE = 1.5; // world size of the decal plane in head units
export const FACE_ANCHORS = { eyeX: [88, 168], eyeY: 116, browY: 76, mouthY: 172 };

const INK = '#1e140f';

// expr: 'neutral' | 'blink' | 'happy' | 'smile' | 'laugh' | 'surprised' | 'talk' | 'talk2'
export function faceTexture(face, skin, expr = 'neutral') {
  const key = 'face2|' + skin + '|' + expr + '|' + JSON.stringify(face || {});
  return canvasTexture(key, 256, 256, (g) => drawFace(g, face || {}, skin, expr));
}

function eyeShape(g, f, expr) {
  const [l, r] = FACE_ANCHORS.eyeX;
  const ey = FACE_ANCHORS.eyeY;
  g.fillStyle = INK;
  g.strokeStyle = INK;
  if (f.sunglasses && expr !== 'blinkOnly') {
    const lens = f.sunglasses === true ? INK : f.sunglasses;
    g.fillStyle = lens;
    g.beginPath();
    g.roundRect(40, 88, 76, 44, 16);
    g.roundRect(140, 88, 76, 44, 16);
    g.fill();
    g.strokeStyle = f.sunFrame || lens;
    g.lineWidth = 9;
    g.beginPath();
    g.moveTo(112, 104);
    g.lineTo(144, 104);
    g.stroke();
    if (f.sunFrame) {
      g.lineWidth = 5;
      g.beginPath();
      g.roundRect(40, 88, 76, 44, 16);
      g.roundRect(140, 88, 76, 44, 16);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.fillRect(52, 96, 20, 8);
    g.fillRect(152, 96, 20, 8);
    return;
  }
  if (expr === 'blink') {
    g.lineWidth = 8;
    for (const x of [l, r]) {
      g.beginPath();
      g.moveTo(x - 14, ey + 2);
      g.quadraticCurveTo(x, ey + 10, x + 14, ey + 2);
      g.stroke();
    }
  } else if (expr === 'surprised') {
    // wide eyes with white rims
    for (const x of [l, r]) {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(x, ey - 2, 21, 25, 0, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 5;
      g.stroke();
      g.fillStyle = INK;
      g.beginPath();
      g.ellipse(x, ey, 11, 13, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(x + 4, ey - 5, 4, 0, Math.PI * 2);
      g.fill();
    }
  } else if (expr === 'happy' || expr === 'laugh') {
    g.lineWidth = 9;
    for (const x of [l, r]) {
      g.beginPath();
      g.moveTo(x - 15, ey + 8);
      g.quadraticCurveTo(x, ey - 16, x + 15, ey + 8);
      g.stroke();
    }
  } else {
    const ry = f.sleepy ? 9 : f.bigEyes ? 24 : 20;
    const rx = f.bigEyes ? 16 : 14;
    for (const x of [l, r]) {
      g.fillStyle = INK;
      g.beginPath();
      g.ellipse(x, ey, rx, ry, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(x + 4, ey - ry * 0.4, f.sleepy ? 3.5 : 5.6, 0, Math.PI * 2);
      g.fill();
      // a second, smaller glint makes the eyes read wet and alive
      if (!f.sleepy) {
        g.beginPath();
        g.arc(x - 5, ey + ry * 0.35, 2.4, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (expr === 'smile') {
      // smiling eyes: the lower lid pushes up
      g.fillStyle = skinOf(g);
      for (const x of [l, r]) {
        g.beginPath();
        g.ellipse(x, ey + ry + 2, rx + 4, ry * 0.55, 0, Math.PI, 0);
        g.fill();
      }
    }
  }
  if (f.lashes && expr !== 'blink') {
    g.strokeStyle = INK;
    g.lineWidth = 6;
    for (const [x, dir] of [[l, -1], [r, 1]]) {
      g.beginPath();
      g.moveTo(x + dir * 9, ey - 16);
      g.lineTo(x + dir * 19, ey - 26);
      g.stroke();
    }
  }
  if (f.glasses) {
    g.strokeStyle = f.glasses;
    g.lineWidth = 8;
    for (const x of [l, r]) {
      g.beginPath();
      g.arc(x, ey, 30, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(118, 112);
    g.lineTo(138, 112);
    g.stroke();
  }
}

let _skin = '#e0ac82';
const skinOf = () => _skin;
function drawFace(g, f, skin, expr) {
  _skin = skin;
  g.clearRect(0, 0, 256, 256);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const my = f.mouthY || FACE_ANCHORS.mouthY;

  if (f.stubble) {
    // kept inside the flat front of the head so it never floats past the rounded edges
    const grad = g.createRadialGradient(128, 196, 10, 128, 196, 80);
    grad.addColorStop(0, rgba(f.stubble, 0.3));
    grad.addColorStop(0.75, rgba(f.stubble, 0.22));
    grad.addColorStop(1, rgba(f.stubble, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(128, 200, 80, 56, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (f.blush) {
    g.fillStyle = rgba(typeof f.blush === 'string' ? f.blush : '#f06e78', 0.45);
    g.beginPath();
    g.ellipse(58, 158, 18, 12, 0, 0, Math.PI * 2);
    g.ellipse(198, 158, 18, 12, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (f.freckles) {
    g.fillStyle = rgba(shade(skin, -0.45), 0.7);
    const r = rng(5);
    for (let i = 0; i < 12; i++) {
      const side = i % 2 ? 1 : -1;
      g.beginPath();
      g.arc(128 + side * (44 + r() * 30), 146 + r() * 14, 2.5, 0, Math.PI * 2);
      g.fill();
    }
  }
  if (f.wrinkles) {
    g.strokeStyle = rgba(shade(skin, -0.5), 0.55);
    g.lineWidth = 4;
    for (const [x, dir] of [[52, -1], [204, 1]]) {
      g.beginPath();
      g.moveTo(x, 112);
      g.lineTo(x + dir * 12, 106);
      g.moveTo(x, 122);
      g.lineTo(x + dir * 12, 126);
      g.stroke();
    }
  }

  eyeShape(g, f, expr);

  // brows
  const brows = expr === 'talk' || expr === 'talk2' ? 'worried' : expr === 'happy' || expr === 'laugh' ? 'up' : expr === 'surprised' ? 'high' : f.brows || 'normal';
  if (brows !== 'none') {
    g.strokeStyle = f.browColor || INK;
    g.lineWidth = f.browW || 10;
    let by = FACE_ANCHORS.browY;
    if (f.sunglasses) by -= 6;
    let inner = -4;
    let outer = 0;
    if (brows === 'up') by -= 12;
    if (brows === 'stern') { inner = 8; outer = -8; }
    if (brows === 'worried') { by -= 14; inner = -10; outer = 4; }
    if (brows === 'high') { by -= 22; inner = -4; outer = 2; }
    g.beginPath();
    g.moveTo(68, by + outer);
    g.lineTo(108, by + inner);
    g.moveTo(148, by + inner);
    g.lineTo(188, by + outer);
    g.stroke();
  }

  if (f.mustache) {
    g.fillStyle = f.mustache;
    g.beginPath();
    g.roundRect(84, my - 10, 88, 18, 10);
    g.fill();
  }

  // mouth
  let mouth = f.mouth || 'smile';
  if (expr === 'talk') mouth = 'open';
  else if (expr === 'talk2') mouth = 'o';
  else if (expr === 'happy') mouth = 'grin';
  else if (expr === 'smile') mouth = f.mouth === 'flat' ? 'smile' : mouth; // the eyes do the smiling
  else if (expr === 'laugh') mouth = 'laugh';
  else if (expr === 'surprised') mouth = 'wow';
  const ink = f.lips || INK;
  g.strokeStyle = ink;
  g.lineWidth = f.lips ? 11 : 10;
  const mo = f.mustache ? 10 : 0; // drop the mouth a touch under a moustache
  switch (mouth) {
    case 'grin':
      g.fillStyle = '#7a2626';
      g.beginPath();
      g.arc(128, my - 4 + mo, 32, 0, Math.PI);
      g.closePath();
      g.fill();
      g.fillStyle = '#ffffff';
      g.fillRect(104, my - 4 + mo, 48, 10);
      if (f.lips) {
        g.lineWidth = 5;
        g.stroke();
      }
      break;
    case 'flat':
      g.beginPath();
      g.moveTo(104, my + 12 + mo);
      g.lineTo(152, my + 12 + mo);
      g.stroke();
      break;
    case 'smirk':
      g.beginPath();
      g.moveTo(100, my + 12 + mo);
      g.quadraticCurveTo(132, my + 20 + mo, 160, my + mo);
      g.stroke();
      break;
    case 'o':
      g.fillStyle = '#7a2626';
      g.beginPath();
      g.ellipse(128, my + 12 + mo, 11, 13, 0, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 7;
      g.stroke();
      break;
    case 'open':
      g.fillStyle = '#7a2626';
      g.beginPath();
      g.ellipse(128, my + 10 + mo, 20, 18, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#e8798a';
      g.beginPath();
      g.ellipse(128, my + 20 + mo, 11, 6, 0, 0, Math.PI * 2);
      g.fill();
      break;
    case 'laugh':
      // big open laugh: wide D-shaped mouth, teeth on top, tongue below
      g.fillStyle = '#7a2626';
      g.beginPath();
      g.moveTo(92, my - 8 + mo);
      g.lineTo(164, my - 8 + mo);
      g.quadraticCurveTo(160, my + 44 + mo, 128, my + 44 + mo);
      g.quadraticCurveTo(96, my + 44 + mo, 92, my - 8 + mo);
      g.fill();
      g.fillStyle = '#ffffff';
      g.fillRect(98, my - 8 + mo, 60, 11);
      g.fillStyle = '#e8798a';
      g.beginPath();
      g.ellipse(128, my + 32 + mo, 17, 9, 0, 0, Math.PI * 2);
      g.fill();
      break;
    case 'wow':
      g.fillStyle = '#7a2626';
      g.beginPath();
      g.ellipse(128, my + 14 + mo, 15, 20, 0, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 6;
      g.stroke();
      break;
    case 'gentle':
      g.beginPath();
      g.arc(128, my - 14 + mo, 20, 0.45, Math.PI - 0.45);
      g.stroke();
      break;
    default: // smile
      g.beginPath();
      g.arc(128, my - 8 + mo, 26, 0.2, Math.PI - 0.2);
      g.stroke();
  }
}
