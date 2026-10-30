// Three short city mini-games (founder 2026-10-30: "add 2-3 mini-games about the city"). Light and
// friendly: no failing, every round ends with a score and a smile. Each is a canvas in a panel, so
// none of them touches the world; an activity host starts them (data/quests/act_grapes.json,
// act_well.json, act_matkot.json).
//
//   grapes  The Camel Cellars harvest: move the barrel (A/D, arrows or the pointer) and catch the
//           falling grapes for 40 seconds. Gold grapes are worth three, a bee costs two.
//   well    "We found water!": Rishon's founders dug for water in 1882. Dig the sand (click, or the
//           arrows and Space) and the colour of each hole says how close the water is. Ten digs.
//   matkot  A rally at the beach: press Space (or click) when the ball reaches the bat. Three
//           misses end the game; the score is the number of hits.
//
//   const r = await games.grapes.start();   // r = { ok: true, score } | { quit: true }
//
// Text: data/minigames/city.<lang>.json, registered under `city`.
import { createOverlay, addStyle, textFn, clamp, toaster, keyListener, showCard } from './common.js';
import { getSynth } from './synth.js';
import { i18n, register } from '../../i18n.js';

let stringsP = null;
export function loadCityStrings(base = new URL('../../../data/minigames/', import.meta.url).href) {
  if (stringsP) return stringsP;
  const get = (lang) => fetch(`${base}city.${lang}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`city.${lang}.json: HTTP ${r.status}`))));
  stringsP = (async () => {
    const fallback = await get('en').catch((e) => { console.warn('[city games] no English strings', e.message); return {}; });
    const active = i18n.lang === 'en' ? fallback : await get(i18n.lang).catch(() => null);
    register('city', active || fallback, fallback);
  })();
  return stringsP;
}

const CSS = `
.mg-city .cg-main { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(560px, calc(100vw - 24px)); text-align: center; pointer-events: auto; }
.mg-city .cg-top { display: flex; justify-content: space-between; align-items: center; font-weight: 900; font-size: 16px; margin-bottom: 6px; }
.mg-city canvas { width: 100%; height: auto; display: block; border: 2px solid #23324a; border-radius: 10px; background: #fff8ea; touch-action: none; }
.mg-city .cg-hint { margin-top: 6px; font-weight: 700; font-size: 13px; opacity: 0.85; min-height: 18px; }
`;
const W = 520, H = 340;

// The shared shell: intro card, the running canvas, the result card. A game spec supplies
// init(s), tick(s, dt), draw(s, g), key(s, e), pointer(s, x, y, kind) and score(s).
function shell(deps, id, spec) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  addStyle('mg-style-city', CSS);
  loadCityStrings();
  let S = null;

  async function start(config = {}) {
    if (S) cancel();
    await loadCityStrings();
    return new Promise((resolve) => {
      const ov = createOverlay('mg-city', '<div class="mg-panel cg-main"><div class="cg-top"><span class="cg-title"></span><span class="cg-stat mg-num"></span></div><canvas></canvas><div class="cg-hint"></div></div>');
      const cv = ov.$('canvas');
      const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d');
      g.scale(dpr, dpr);
      ov.$('.cg-title').textContent = t(`city.${id}.title`);
      ov.$('.cg-hint').textContent = t(`city.${id}.keys`);
      const s = { id, cfg: config, ov, cv, g, resolve, phase: 'intro', time: 0, t, synth, toast: toaster(ov.root), held: new Set(), stat: (txt) => { ov.$('.cg-stat').textContent = txt; } };
      S = s;
      const local = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]; };
      cv.addEventListener('pointerdown', (e) => { e.preventDefault(); if (s.phase === 'play' && spec.pointer) spec.pointer(s, ...local(e), 'down'); });
      cv.addEventListener('pointermove', (e) => { if (s.phase === 'play' && spec.pointer) spec.pointer(s, ...local(e), 'move'); });
      s.offKeys = keyListener((e) => {
        if (S !== s) return;
        if (e.type !== 'keydown') return;
        if (e.code === 'Escape' && s.phase !== 'done') { e.preventDefault(); e.stopPropagation(); finish({ ok: false, quit: true }); return; }
        if (s.phase === 'play' && spec.key) { if (spec.key(s, e) !== false) { e.preventDefault(); e.stopPropagation(); } }
      });
      s.offUp = (() => {
        const dn = (e) => s.held.add(e.code), up = (e) => s.held.delete(e.code);
        window.addEventListener('keydown', dn, true); window.addEventListener('keyup', up, true);
        return () => { window.removeEventListener('keydown', dn, true); window.removeEventListener('keyup', up, true); };
      })();
      spec.init(s);
      spec.draw(s, g);
      s.card = showCard(ov.root, { title: t(`city.${id}.title`), lines: [t(`city.${id}.how`)], buttons: [{ label: t('city.ui.start'), key: ['Enter', 'Space'], onClick: () => { s.card = null; s.phase = 'play'; synth.play('go'); } }, { label: t('city.ui.later'), key: 'Escape', alt: true, onClick: () => finish({ ok: false, quit: true }) }] });
    });
  }

  function end(s) {
    if (s.phase !== 'play') return;
    s.phase = 'done';
    const score = Math.max(0, Math.round(spec.score(s)));
    s.synth.play('win');
    const lines = [t(`city.${id}.result`, { n: score })];
    const extra = spec.resultLine && spec.resultLine(s);
    if (extra) lines.push(extra);
    s.card = showCard(s.ov.root, { title: t(`city.${id}.title`), big: String(score), lines, buttons: [{ label: t('city.ui.done'), key: ['Enter', 'Escape', 'Space'], onClick: () => finish({ ok: true, score }) }] });
  }

  function update(dt) {
    const s = S;
    if (!s || dt <= 0) return;
    if (s.phase === 'play') {
      s.time += dt;
      if (spec.tick(s, Math.min(dt, 0.05)) === 'end') end(s);
    }
    spec.draw(s, s.g);
  }

  function finish(result) {
    const s = S;
    if (!s) return;
    S = null;
    if (s.card) { s.card(); s.card = null; }
    s.offKeys(); s.offUp();
    s.ov.remove();
    s.resolve({ ...result, tries: 1 });
  }
  function cancel() { if (S) finish({ ok: false, cancelled: true }); }

  return {
    start, update, cancel,
    get active() { return !!S; },
    get blocksPlayer() { return !!S; },
    debug: { state: () => (S ? { phase: S.phase, time: +S.time.toFixed(2), ...(spec.debug ? spec.debug(S) : {}) } : null), end: () => S && end(S), play: () => { if (S && S.card) { S.card(); S.card = null; } if (S) S.phase = 'play'; } },
  };
}

// ---------- drawing helpers ----------
const INK = '#23324a';
function bg(g, top, bottom) {
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, top); gr.addColorStop(1, bottom);
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}
function circle(g, x, y, r, fill, stroke = INK, lw = 2) {
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
}
function bunch(g, x, y, c, r = 5) {
  const pts = [[0, -6], [-6, -1], [6, -1], [-3, 5], [3, 5], [0, 11]];
  g.strokeStyle = '#3e7b2c'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y - 10); g.lineTo(x + 3, y - 16); g.stroke();
  for (const [dx, dy] of pts) circle(g, x + dx, y + dy, r, c, INK, 1.5);
}

// ---------- 1. grapes at the Camel Cellars ----------
const GRAPES_TIME = 40;
const grapes = {
  init(s) { s.x = W / 2; s.items = []; s.spawn = 0.4; s.points = 0; s.caught = 0; s.stung = 0; s.stat(s.t('city.grapes.stat', { n: 0, t: GRAPES_TIME })); },
  key() { return false; }, // movement is read from held keys in tick
  pointer(s, x) { s.target = x; },
  tick(s, dt) {
    const left = s.held.has('ArrowLeft') || s.held.has('KeyA'), right = s.held.has('ArrowRight') || s.held.has('KeyD');
    if (left || right) { s.x += (right ? 1 : -1) * 330 * dt; s.target = null; }
    else if (s.target != null) s.x += clamp(s.target - s.x, -420 * dt, 420 * dt);
    s.x = clamp(s.x, 40, W - 40);
    s.spawn -= dt;
    const pace = 1 + (s.time / GRAPES_TIME) * 0.8;
    if (s.spawn <= 0) {
      s.spawn = (0.55 + Math.random() * 0.35) / pace;
      const r = Math.random();
      const kind = r < 0.12 ? 'gold' : r < 0.24 ? 'bee' : r < 0.36 ? 'leaf' : 'grape';
      s.items.push({ kind, x: 30 + Math.random() * (W - 60), y: -20, v: (95 + Math.random() * 50) * pace, wob: Math.random() * 6 });
    }
    for (const it of s.items) {
      it.y += it.v * dt;
      if (it.kind === 'bee') it.x += Math.sin(s.time * 5 + it.wob) * 60 * dt;
      if (it.kind === 'leaf') it.x += Math.sin(s.time * 2 + it.wob) * 40 * dt;
      if (!it.done && it.y > H - 62 && it.y < H - 30 && Math.abs(it.x - s.x) < 42) {
        it.done = true;
        if (it.kind === 'grape') { s.points += 1; s.caught++; s.synth.play('coin'); }
        else if (it.kind === 'gold') { s.points += 3; s.caught++; s.synth.play('win'); s.toast(s.t('city.grapes.gold')); }
        else if (it.kind === 'bee') { s.points = Math.max(0, s.points - 2); s.stung++; s.synth.play('bump'); s.toast(s.t('city.grapes.bee')); }
      }
    }
    s.items = s.items.filter((it) => !it.done && it.y < H + 30);
    const left2 = Math.max(0, GRAPES_TIME - s.time);
    s.stat(s.t('city.grapes.stat', { n: s.points, t: Math.ceil(left2) }));
    return left2 <= 0 ? 'end' : null;
  },
  draw(s, g) {
    bg(g, '#bfe6ff', '#f7e7c4');
    // vineyard rows and the cellar's arch
    g.fillStyle = '#8fbf5a';
    for (let i = 0; i < 6; i++) { g.beginPath(); g.ellipse(45 + i * 86, 70, 46, 22, 0, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#d9b98c'; g.fillRect(0, H - 24, W, 24);
    for (const it of s.items) {
      if (it.kind === 'grape') bunch(g, it.x, it.y, '#7b3fa0');
      else if (it.kind === 'gold') bunch(g, it.x, it.y, '#ffcb3d');
      else if (it.kind === 'leaf') { g.fillStyle = '#4f9a36'; g.beginPath(); g.ellipse(it.x, it.y, 13, 7, 0.6, 0, Math.PI * 2); g.fill(); g.strokeStyle = INK; g.lineWidth = 1.5; g.stroke(); }
      else { circle(g, it.x, it.y, 9, '#ffcb3d'); g.fillStyle = INK; g.fillRect(it.x - 3, it.y - 9, 2, 18); g.fillRect(it.x + 2, it.y - 9, 2, 18); circle(g, it.x - 7, it.y - 8, 5, 'rgba(255,255,255,0.8)', INK, 1); circle(g, it.x + 7, it.y - 8, 5, 'rgba(255,255,255,0.8)', INK, 1); }
    }
    // the barrel
    const bx = s.x, by = H - 46;
    g.fillStyle = '#9a5b2e'; g.strokeStyle = INK; g.lineWidth = 2;
    g.beginPath(); g.moveTo(bx - 38, by - 18); g.lineTo(bx + 38, by - 18); g.lineTo(bx + 32, by + 22); g.lineTo(bx - 32, by + 22); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#5e5e66'; g.fillRect(bx - 37, by - 8, 74, 5); g.fillRect(bx - 34, by + 10, 68, 5);
  },
  score(s) { return s.points; },
  resultLine(s) { return s.t('city.grapes.line', { c: s.caught, b: s.stung }); },
  debug(s) { return { points: s.points, items: s.items.length, x: Math.round(s.x) }; },
};

// ---------- 2. "We found water!" at the old water tower ----------
const WN = 7, DIGS = 10;
const well = {
  init(s) {
    s.wx = Math.floor(Math.random() * WN); s.wz = Math.floor(Math.random() * WN);
    s.cx = 3; s.cz = 3; s.holes = new Map(); s.digs = 0; s.found = false; s.endT = null;
    s.stat(s.t('city.well.stat', { n: DIGS }));
  },
  key(s, e) {
    const k = e.code;
    if (k === 'ArrowLeft' || k === 'KeyA') s.cx = clamp(s.cx - 1, 0, WN - 1);
    else if (k === 'ArrowRight' || k === 'KeyD') s.cx = clamp(s.cx + 1, 0, WN - 1);
    else if (k === 'ArrowUp' || k === 'KeyW') s.cz = clamp(s.cz - 1, 0, WN - 1);
    else if (k === 'ArrowDown' || k === 'KeyS') s.cz = clamp(s.cz + 1, 0, WN - 1);
    else if (k === 'Space' || k === 'Enter') well.dig(s, s.cx, s.cz);
    else return false;
    return true;
  },
  cell: 40, ox: (W - 7 * 40) / 2, oz: 46,
  pointer(s, x, y, kind) {
    const i = Math.floor((x - well.ox) / well.cell), j = Math.floor((y - well.oz) / well.cell);
    if (i < 0 || j < 0 || i >= WN || j >= WN) return;
    s.cx = i; s.cz = j;
    if (kind === 'down') well.dig(s, i, j);
  },
  dig(s, i, j) {
    if (s.found || s.endT != null || s.holes.has(i + ',' + j)) return;
    s.digs++;
    const d = Math.max(Math.abs(i - s.wx), Math.abs(j - s.wz));
    s.holes.set(i + ',' + j, d);
    if (d === 0) { s.found = true; s.endT = s.time + 1.6; s.synth.play('win'); s.toast(s.t('city.well.found')); }
    else {
      s.synth.play('tick');
      s.toast(s.t(d === 1 ? 'city.well.wet' : d === 2 ? 'city.well.damp' : d === 3 ? 'city.well.dry' : 'city.well.desert'));
      if (s.digs >= DIGS) { s.endT = s.time + 1.8; s.toast(s.t('city.well.out'), 1800); }
    }
    s.stat(s.t('city.well.stat', { n: DIGS - s.digs }));
  },
  tick(s) { return s.endT != null && s.time >= s.endT ? 'end' : null; },
  draw(s, g) {
    bg(g, '#ffe6b0', '#e9c98f');
    const c = well.cell;
    for (let i = 0; i < WN; i++) for (let j = 0; j < WN; j++) {
      const x = well.ox + i * c, y = well.oz + j * c;
      const d = s.holes.get(i + ',' + j);
      g.fillStyle = d === undefined ? ((i + j) % 2 ? '#f3d9a4' : '#eccf94') : d === 0 ? '#3fa9f5' : d === 1 ? '#7cc6e8' : d === 2 ? '#a9d8c8' : d === 3 ? '#d8b878' : '#c79a5a';
      g.fillRect(x, y, c, c);
      if (d !== undefined && d > 0) { g.fillStyle = 'rgba(35,50,74,0.25)'; g.beginPath(); g.ellipse(x + c / 2, y + c / 2, 11, 7, 0, 0, Math.PI * 2); g.fill(); }
      if (d === 0) { g.fillStyle = '#fff'; g.font = '900 20px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('💧', x + c / 2, y + c / 2); }
      g.strokeStyle = 'rgba(35,50,74,0.25)'; g.lineWidth = 1; g.strokeRect(x, y, c, c);
    }
    // the water shows itself when the digs run out
    if (!s.found && s.endT != null) { g.fillStyle = 'rgba(63,169,245,0.7)'; g.fillRect(well.ox + s.wx * c + 4, well.oz + s.wz * c + 4, c - 8, c - 8); }
    g.strokeStyle = INK; g.lineWidth = 3; g.strokeRect(well.ox + s.cx * c + 1.5, well.oz + s.cz * c + 1.5, c - 3, c - 3);
    // a little water tower on the side
    g.fillStyle = '#c9a77a'; g.strokeStyle = INK; g.lineWidth = 2;
    g.fillRect(16, 150, 34, 150); g.strokeRect(16, 150, 34, 150);
    g.fillStyle = '#e8d2ad'; g.fillRect(8, 120, 50, 34); g.strokeRect(8, 120, 50, 34);
  },
  score(s) { return s.found ? 100 - (s.digs - 1) * 10 : 0; },
  resultLine(s) { return s.t(s.found ? 'city.well.lineFound' : 'city.well.lineMiss', { n: s.digs }); },
  debug(s) { return { water: [s.wx, s.wz], digs: s.digs, found: s.found }; },
};

// ---------- 3. matkot at the beach ----------
const matkot = {
  init(s) { s.hits = 0; s.best = 0; s.rally = 0; s.lives = 3; s.serve(); s.stat(s.t('city.matkot.stat', { n: 0, l: 3 })); },
  key(s, e) { if (e.code === 'Space' || e.code === 'Enter') { matkot.swing(s); return true; } return false; },
  pointer(s, x, y, kind) { if (kind === 'down') matkot.swing(s); },
  swing(s) {
    if (s.ball.dir !== 1 || s.ball.miss) return;
    const dt = Math.abs(s.time - s.ball.tHit);
    if (dt > 0.2) { s.swingT = s.time; return; } // too early: just a swing in the air
    s.swingT = s.time;
    s.hits++; s.rally++; s.best = Math.max(s.best, s.rally);
    s.synth.play(dt < 0.08 ? 'win' : 'coin');
    if (dt < 0.08) s.toast(s.t('city.matkot.perfect'), 700);
    const T = Math.max(0.55, 1.15 - s.rally * 0.025);
    s.ball = { dir: -1, t0: s.time, T, tHit: s.time + T, miss: false };
    s.stat(s.t('city.matkot.stat', { n: s.hits, l: s.lives }));
  },
  tick(s) {
    const b = s.ball;
    if (b.dir === -1 && s.time >= b.tHit) {
      // the friend never misses
      const T = Math.max(0.55, 1.15 - s.rally * 0.025);
      s.ball = { dir: 1, t0: s.time, T, tHit: s.time + T, miss: false };
      s.friendT = s.time;
      s.synth.play('tick');
    } else if (b.dir === 1 && !b.miss && s.time > b.tHit + 0.2) {
      b.miss = true;
      s.lives--; s.rally = 0;
      s.synth.play('bump');
      s.toast(s.t(s.lives > 0 ? 'city.matkot.miss' : 'city.matkot.over'));
      s.stat(s.t('city.matkot.stat', { n: s.hits, l: s.lives }));
      b.missT = s.time;
    }
    if (b.miss && s.time - b.missT > 1.2) { if (s.lives <= 0) return 'end'; s.serve(); }
    return null;
  },
  draw(s, g) {
    bg(g, '#9fd8ff', '#ffe9b8');
    g.fillStyle = '#4fb3d9'; g.fillRect(0, 150, W, 40);
    g.fillStyle = '#f6dfa5'; g.fillRect(0, 190, W, H - 190);
    const fx = 90, px = W - 90, gy = 260;
    const person = (x, flip, swingAge, col) => {
      circle(g, x, gy - 70, 16, '#e9b48a');
      g.fillStyle = col; g.fillRect(x - 14, gy - 54, 28, 38); g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(x - 14, gy - 54, 28, 38);
      g.fillStyle = '#3d5f8f'; g.fillRect(x - 13, gy - 16, 11, 26); g.fillRect(x + 2, gy - 16, 11, 26);
      const a = swingAge != null && swingAge < 0.25 ? -0.9 : 0.3;
      const hx = x + flip * 22, hy = gy - 44;
      g.save(); g.translate(hx, hy); g.rotate(flip * a);
      g.fillStyle = '#8b5a2b'; g.fillRect(-3, -2, 6, 18); circle(g, 0, -12, 13, '#e8364f');
      g.restore();
    };
    person(fx, 1, s.friendT != null ? s.time - s.friendT : null, '#2ec4b6');
    person(px, -1, s.swingT != null ? s.time - s.swingT : null, '#ffcb3d');
    // the hit zone in front of the player's bat
    const zx = px - 26, zy = gy - 56;
    const b = s.ball;
    const near = b.dir === 1 && !b.miss && Math.abs(s.time - b.tHit) < 0.2;
    circle(g, zx, zy, 20, near ? 'rgba(46,196,182,0.35)' : 'rgba(255,255,255,0.35)', near ? '#1b8f84' : 'rgba(35,50,74,0.4)', 2);
    // the ball: a hop from one bat to the other
    let u = clamp((s.time - b.t0) / b.T, 0, 1.3);
    if (b.dir === -1) u = 1 - u;
    const x0 = fx + 26, x1 = zx;
    let bx = x0 + (x1 - x0) * u, by = zy - Math.sin(clamp(u, 0, 1) * Math.PI) * 70;
    if (b.miss) { const k = s.time - b.missT; bx = x1 + 30 * k; by = zy + Math.min(110, 200 * k * k + 40 * k); }
    circle(g, bx, by, 7, '#fff', INK, 2);
  },
  score(s) { return s.hits; },
  resultLine(s) { return s.t('city.matkot.line', { b: s.best }); },
  debug(s) { return { hits: s.hits, lives: s.lives, dir: s.ball.dir, tHit: +(s.ball.tHit - s.time).toFixed(2) }; },
};
// serve: a fresh ball from the friend
const withServe = (spec) => ({ ...spec, init(s) { s.serve = () => { s.ball = { dir: 1, t0: s.time + 0.6, T: 1.15, tHit: s.time + 1.75, miss: false }; s.friendT = s.time + 0.6; }; spec.init(s); } });

export function createGrapes(deps = {}) { return shell(deps, 'grapes', grapes); }
export function createWell(deps = {}) { return shell(deps, 'well', well); }
export function createMatkot(deps = {}) { return shell(deps, 'matkot', withServe(matkot)); }
