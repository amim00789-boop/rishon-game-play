// Procedural canvas textures for avatars: printed faces, shirt fronts, fabric patterns.
// Everything is cached by a content key so a crowd of NPCs shares GPU textures.
import * as THREE from 'three';

const texCache = new Map();

export function canvasTexture(key, w, h, draw, repeat = false) {
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  texCache.set(key, t);
  return t;
}

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// amt in [-1, 1]: negative darkens towards black, positive lightens towards white (sRGB space,
// which is what a painter would expect when picking a trim colour).
export function shade(hex, amt) {
  const [r, g, b] = rgb(hex);
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  const m = (v) => Math.round(v + (t - v) * p);
  return '#' + ((1 << 24) | (m(r) << 16) | (m(g) << 8) | m(b)).toString(16).slice(1);
}

export function rgba(hex, a) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------------------------------------------------------------------------------------------
// Fabric patterns. Every pattern tiles in 64 px blocks so front, side and sleeve textures line up.
export function drawPattern(g, w, h, spec, seed = 1) {
  const base = spec.color;
  const alt = spec.alt || shade(base, 0.6);
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const r = rng(seed);
  switch (spec.pattern) {
    case 'stripes': {
      const band = spec.band || 22;
      g.fillStyle = alt;
      for (let y = 0; y < h; y += band * 2) g.fillRect(0, y, w, band);
      break;
    }
    case 'vstripes': {
      const band = spec.band || 14;
      g.fillStyle = alt;
      for (let x = 0; x < w; x += band * 3) g.fillRect(x, 0, band, h);
      break;
    }
    case 'checks': {
      const band = spec.band || 20;
      g.fillStyle = rgba(alt, 0.55);
      for (let x = 0; x < w; x += band * 2) g.fillRect(x, 0, band, h);
      for (let y = 0; y < h; y += band * 2) g.fillRect(0, y, w, band);
      break;
    }
    case 'plaid':
    case 'tartan': {
      const step = spec.band || 64;
      g.fillStyle = rgba(alt, 0.6);
      for (let x = 0; x < w; x += step) g.fillRect(x, 0, step * 0.38, h);
      for (let y = 0; y < h; y += step) g.fillRect(0, y, w, step * 0.38);
      g.fillStyle = rgba(spec.line || '#ffffff', 0.75);
      for (let x = step * 0.62; x < w; x += step) g.fillRect(x, 0, 4, h);
      for (let y = step * 0.62; y < h; y += step) g.fillRect(0, y, w, 4);
      break;
    }
    case 'flowers': {
      const n = Math.round((w * h) / 2600);
      for (let i = 0; i < n; i++) {
        const x = r() * w;
        const y = r() * h;
        const s = 6 + r() * 6;
        g.fillStyle = i % 3 === 0 ? (spec.alt2 || '#ffffff') : alt;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          g.beginPath();
          g.arc(x + Math.cos(a) * s * 0.7, y + Math.sin(a) * s * 0.7, s * 0.55, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = '#ffd23f';
        g.beginPath();
        g.arc(x, y, s * 0.35, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'dots': {
      g.fillStyle = alt;
      for (let y = 8; y < h; y += 24) {
        for (let x = (y / 24) % 2 ? 20 : 8; x < w; x += 24) {
          g.beginPath();
          g.arc(x, y, 4.5, 0, Math.PI * 2);
          g.fill();
        }
      }
      break;
    }
    case 'knit': {
      const band = spec.band || 10;
      const cols = [alt, spec.alt2 || alt, base];
      for (let y = 0, i = 0; y < h; y += band, i++) {
        if (i % 3 === 2) continue;
        g.fillStyle = cols[i % 3];
        g.fillRect(0, y, w, band * 0.7);
      }
      g.fillStyle = rgba('#000000', 0.08);
      for (let x = 0; x < w; x += 6) g.fillRect(x, 0, 2, h);
      break;
    }
    default:
      break;
  }
  // a faint fabric grain keeps flat colours from looking like plastic paint
  g.fillStyle = rgba('#000000', 0.035);
  for (let i = 0; i < (w * h) / 90; i++) g.fillRect(r() * w, r() * h, 2, 2);
}

export function patternTexture(spec, w = 128, h = 128) {
  const key = 'pat|' + w + 'x' + h + '|' + JSON.stringify(spec);
  return canvasTexture(key, w, h, (g) => drawPattern(g, w, h, spec, hashString(key)));
}

// ---------------------------------------------------------------------------------------------
// Shirt hem: a folded band at the bottom with a row of stitches above it.
function hem(g, w, h, color) {
  g.fillStyle = shade(color || '#ffffff', -0.14);
  g.fillRect(0, h - 16, w, 16);
  g.strokeStyle = rgba(shade(color || '#ffffff', -0.4), 0.55);
  g.lineWidth = 3;
  g.setLineDash([9, 7]);
  g.beginPath();
  g.moveTo(0, h - 22);
  g.lineTo(w, h - 22);
  g.stroke();
  g.setLineDash([]);
}

// Upper-torso shirt textures: { front, back, side }. Front carries neckline, coat panels and print.
export function torsoTextures(shirt, skin) {
  const base = JSON.stringify(shirt) + '|' + skin;
  const coat = shirt.coat;
  const sleeveless = shirt.sleeves === 'none';
  const front = canvasTexture('torsoF|' + base, 320, 256, (g, w, h) => {
    drawPattern(g, w, h, shirt, 11);
    const cx = w / 2;
    if (sleeveless) {
      g.fillStyle = skin;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(62, 0);
      g.quadraticCurveTo(70, 70, 0, 92);
      g.fill();
      g.beginPath();
      g.moveTo(w, 0);
      g.lineTo(w - 62, 0);
      g.quadraticCurveTo(w - 70, 70, w, 92);
      g.fill();
    }
    const neck = shirt.neck || 'crew';
    const trim = shade(shirt.color, -0.25);
    if (neck === 'v') {
      g.fillStyle = skin;
      g.beginPath();
      g.moveTo(cx - 46, 0);
      g.lineTo(cx + 46, 0);
      g.lineTo(cx, 78);
      g.fill();
      g.strokeStyle = trim;
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(cx - 46, 0);
      g.lineTo(cx, 78);
      g.lineTo(cx + 46, 0);
      g.stroke();
    } else if (neck === 'scoop') {
      g.fillStyle = skin;
      g.beginPath();
      g.ellipse(cx, 0, 58, 40, 0, 0, Math.PI);
      g.fill();
      g.strokeStyle = trim;
      g.lineWidth = 5;
      g.beginPath();
      g.ellipse(cx, 0, 58, 40, 0, 0, Math.PI);
      g.stroke();
    } else if (neck === 'crew') {
      g.strokeStyle = trim;
      g.lineWidth = 8;
      g.beginPath();
      g.ellipse(cx, 0, 48, 24, 0, 0, Math.PI);
      g.stroke();
    }
    if (shirt.print === 'buttons' || neck === 'collar') {
      g.strokeStyle = trim;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx, 30);
      g.lineTo(cx, h);
      g.stroke();
      g.fillStyle = shirt.buttonColor || shade(shirt.color, 0.75);
      for (let y = 52; y < h; y += 46) {
        g.beginPath();
        g.arc(cx + 7, y, 5, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (neck === 'collar') {
      const cc = shirt.collarColor || shade(shirt.color, 0.15);
      g.fillStyle = cc;
      g.strokeStyle = shade(cc, -0.3);
      g.lineWidth = 3;
      for (const dir of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx, 26);
        g.lineTo(cx + dir * 58, 0);
        g.lineTo(cx + dir * 66, 30);
        g.lineTo(cx + dir * 10, 44);
        g.closePath();
        g.fill();
        g.stroke();
      }
    }
    if (shirt.pocket) {
      g.strokeStyle = shade(shirt.color, -0.3);
      g.lineWidth = 3;
      g.strokeRect(cx + 50, 70, 54, 56);
    }
    drawPrint(g, cx, 112, shirt);
    if (!coat) hem(g, w, h, shirt.color);
    if (coat) {
      g.fillStyle = coat;
      const gap = shirt.coatGap || 36;
      for (const dir of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx + dir * gap, 0);
        g.lineTo(cx + dir * w, 0);
        g.lineTo(cx + dir * w, h);
        g.lineTo(cx + dir * (gap * 0.55), h);
        g.closePath();
        g.fill();
        // lapel edge highlight
        g.strokeStyle = shade(coat, 0.18);
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(cx + dir * gap, 0);
        g.lineTo(cx + dir * (gap + 30), 70);
        g.lineTo(cx + dir * (gap * 0.75), 120);
        g.stroke();
      }
    }
  });
  const back = canvasTexture('torsoB|' + base, 320, 256, (g, w, h) => {
    if (coat) {
      g.fillStyle = coat;
      g.fillRect(0, 0, w, h);
    } else {
      drawPattern(g, w, h, shirt, 12);
      if (sleeveless) {
        g.fillStyle = skin;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(56, 0);
        g.quadraticCurveTo(62, 60, 0, 80);
        g.fill();
        g.beginPath();
        g.moveTo(w, 0);
        g.lineTo(w - 56, 0);
        g.quadraticCurveTo(w - 62, 60, w, 80);
        g.fill();
      }
    }
    if (shirt.backPrint) drawPrint(g, w / 2, 110, { print: 'text', text: shirt.backPrint, textColor: shirt.textColor });
    if (!coat) hem(g, w, h, shirt.color);
  });
  const side = coat
    ? null
    : canvasTexture('torsoS|' + base, 128, 256, (g, w, h) => {
      drawPattern(g, w, h, shirt, 13);
      hem(g, w, h, shirt.color);
      // side seam
      g.strokeStyle = rgba(shade(shirt.color, -0.35), 0.5);
      g.lineWidth = 3;
      g.setLineDash([8, 7]);
      g.beginPath();
      g.moveTo(w / 2, 0);
      g.lineTo(w / 2, h);
      g.stroke();
      g.setLineDash([]);
    });
  return { front, back, side };
}

function drawPrint(g, cx, cy, shirt) {
  const p = shirt.print;
  if (!p || p === 'buttons') return;
  g.save();
  switch (p) {
    case 'sun': {
      // sun over the sea: Rishon's beach in one glyph
      g.fillStyle = '#ffd23f';
      g.strokeStyle = '#ffd23f';
      g.lineWidth = 6;
      for (let i = 0; i < 9; i++) {
        const a = Math.PI + (i / 8) * Math.PI;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * 36, cy + 10 + Math.sin(a) * 36);
        g.lineTo(cx + Math.cos(a) * 50, cy + 10 + Math.sin(a) * 50);
        g.stroke();
      }
      g.beginPath();
      g.arc(cx, cy + 10, 28, Math.PI, 0);
      g.fill();
      g.strokeStyle = '#1e88c8';
      g.lineWidth = 7;
      for (let k = 0; k < 2; k++) {
        g.beginPath();
        for (let x = -56; x <= 56; x += 4) {
          const y = cy + 24 + k * 15 + Math.sin(x * 0.17) * 4;
          if (x === -56) g.moveTo(cx + x, y);
          else g.lineTo(cx + x, y);
        }
        g.stroke();
      }
      break;
    }
    case 'heart':
      g.fillStyle = shirt.printColor || '#e8364f';
      g.beginPath();
      g.moveTo(cx, cy + 34);
      g.bezierCurveTo(cx - 60, cy - 6, cx - 24, cy - 40, cx, cy - 12);
      g.bezierCurveTo(cx + 24, cy - 40, cx + 60, cy - 6, cx, cy + 34);
      g.fill();
      break;
    case 'star': {
      g.fillStyle = shirt.printColor || '#ffd23f';
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? 17 : 42;
        g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      g.fill();
      break;
    }
    case 'palm': {
      g.strokeStyle = '#8a5a2b';
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(cx + 6, cy + 46);
      g.quadraticCurveTo(cx - 8, cy + 10, cx + 4, cy - 22);
      g.stroke();
      g.fillStyle = shirt.printColor || '#2e9e57';
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI + (i / 5) * Math.PI;
        g.save();
        g.translate(cx + 4, cy - 22);
        g.rotate(a);
        g.beginPath();
        g.ellipse(26, 0, 28, 8, 0.25, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      g.fillStyle = '#ffb347';
      g.beginPath();
      g.arc(cx + 34, cy + 30, 10, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'text':
      g.fillStyle = shirt.textColor || '#ffffff';
      g.font = '900 46px "Trebuchet MS", system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(shirt.text || 'RISHON', cx, cy);
      break;
    case 'logo':
      g.fillStyle = shirt.printColor || '#ffffff';
      g.beginPath();
      g.arc(cx + 66, cy - 40, 12, 0, Math.PI * 2);
      g.fill();
      break;
    default:
      break;
  }
  g.restore();
}

// Lower torso: pants fabric with a belt band; front gets a buckle.
export function lowerTorsoTextures(pants) {
  const base = JSON.stringify(pants);
  const draw = (buckle) => (g, w, h) => {
    drawPattern(g, w, h, pants, 21);
    if (pants.belt) {
      g.fillStyle = pants.belt;
      g.fillRect(0, 6, w, 34);
      if (buckle) {
        g.fillStyle = pants.buckle || '#d8c27a';
        g.fillRect(w / 2 - 20, 4, 40, 38);
        g.fillStyle = pants.belt;
        g.fillRect(w / 2 - 12, 12, 24, 22);
      }
    }
    if (buckle && pants.fly !== false && !pants.pattern && pants.kind !== 'skirt') {
      g.strokeStyle = shade(pants.color, -0.25);
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(w / 2 + 6, 44);
      g.lineTo(w / 2 + 6, h);
      g.stroke();
    }
  };
  return {
    front: canvasTexture('ltF|' + base, 256, 128, draw(true)),
    other: canvasTexture('ltO|' + base, 256, 128, draw(false)),
  };
}
