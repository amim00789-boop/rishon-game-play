// Sapir's garden wedding (round 10, docs/ROUND10_WEDDING.md): set up a wedding on a lawn before the
// guests arrive. A top-down canvas: the player carries one item at a time from the piles by her
// black jeep to the dashed spots of her plan - tables, light poles, speakers and the stage, heavy
// things slower - while gusts of wind now and then knock a placed table or pole over.
//
//   const r = await games.wedding.start({ seconds: 150 });
//   // r = { ok (everything standing at the bell), score, placed, total } | { ok: false, quit: true }
//
// Keys: arrows/WASD walk, Space picks up at a pile, sets down on a spot, stands a fallen item up.
// Pointer: press a pile, a spot or a fallen item to walk there and act on arrival.
// Text: data/minigames/wedding.<lang>.json, registered under `wd`.
import { createOverlay, addStyle, textFn, clamp, toaster, keyListener, showCard } from './common.js';
import { getSynth } from './synth.js';
import { i18n, register } from '../../i18n.js';

let stringsP = null;
export function loadWeddingStrings(base = new URL('../../../data/minigames/', import.meta.url).href) {
  if (stringsP) return stringsP;
  const get = (lang) => fetch(`${base}wedding.${lang}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`wedding.${lang}.json: HTTP ${r.status}`))));
  stringsP = (async () => {
    const fallback = await get('en').catch((e) => { console.warn('[wedding] no English strings', e.message); return {}; });
    const active = i18n.lang === 'en' ? fallback : await get(i18n.lang).catch(() => null);
    register('wd', active || fallback, fallback);
  })();
  return stringsP;
}

// ---- the lawn, in metres ----
const LW = 32, LH = 17, S = 20, MX = 40, MY = 40, W = LW * S + MX * 2, H = LH * S + MY * 2;
const REACH = 1.5; // how close the player must be to act on something
const WALK = 6.5;
// Item kinds: carry speed, size on the lawn and colours.
const KINDS = {
  table: { speed: 5.0, r: 0.9, color: '#ffffff' },
  light: { speed: 5.6, r: 0.35, color: '#3a3a3a' },
  speaker: { speed: 4.5, r: 0.55, color: '#1b1b1b' },
  stage: { speed: 3.6, r: 1.0, color: '#8a5a32' },
};
const PILES = [['table', 4.6, 3.2], ['light', 4.6, 6.6], ['speaker', 4.6, 10.4], ['stage', 4.6, 13.8]];
const SPOTS = [
  ...[[9.5, 4.2], [15, 4.2], [20.5, 4.2], [9.5, 12.8], [15, 12.8], [20.5, 12.8]].map(([x, y]) => ['table', x, y]),
  ...[[12.2, 1.4], [23.5, 1.4], [12.2, 15.6], [23.5, 15.6]].map(([x, y]) => ['light', x, y]),
  ['speaker', 25.4, 6], ['speaker', 25.4, 11],
  ...[[27.5, 7.5], [29.5, 7.5], [27.5, 9.5], [29.5, 9.5]].map(([x, y]) => ['stage', x, y]),
];
// Strings of bulbs hang between neighbouring poles once both stand.
const STRINGS = [[6, 7], [8, 9], [6, 8], [7, 9], [6, 9], [7, 8]];

const CSS = `
.mg-wd .wd-main { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(760px, calc(100vw - 16px)); text-align: center; pointer-events: auto; }
.mg-wd .wd-top { display: flex; justify-content: center; gap: 10px; align-items: center; font-weight: 900; font-size: 16px; margin-bottom: 6px; }
.mg-wd canvas { width: 100%; height: auto; display: block; border: 2px solid #23324a; border-radius: 10px; background: #7cbf5a; touch-action: none; }
.mg-wd .wd-hint { margin-top: 6px; font-weight: 700; font-size: 12px; opacity: 0.85; min-height: 16px; }
`;

export function createWedding(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  addStyle('mg-style-wd', CSS);
  loadWeddingStrings();
  let M = null;

  async function start(config = {}) {
    if (M) cancel();
    await loadWeddingStrings();
    return new Promise((resolve) => {
      const cfg = { seconds: 150, gust: [16, 24], ...config };
      const ov = createOverlay('mg-wd', '<div class="mg-panel wd-main"><div class="wd-top"><span class="wd-stat mg-num"></span></div><canvas></canvas><div class="wd-hint"></div></div>');
      const cv = ov.$('canvas');
      const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d');
      g.scale(dpr, dpr);
      ov.$('.wd-hint').textContent = t('wd.keys');
      const m = {
        cfg, ov, g, resolve, phase: 'intro', time: 0, clock: cfg.seconds, toast: toaster(ov.root), held: new Set(),
        me: { x: 7, y: 8.5, vx: 0, vy: 0, carry: null }, goal: null,
        spots: SPOTS.map(([kind, x, y], i) => ({ i, kind, x, y, state: 'empty' })), // empty | placed | fallen
        gustT: cfg.gust[0] + Math.random() * (cfg.gust[1] - cfg.gust[0]), gustFx: 0, falls: 0,
      };
      M = m;
      const local = (e) => { const r = cv.getBoundingClientRect(); return [(((e.clientX - r.left) / r.width) * W - MX) / S, (((e.clientY - r.top) / r.height) * H - MY) / S]; };
      cv.addEventListener('pointerdown', (e) => { e.preventDefault(); if (m.phase === 'play') pointer(m, ...local(e)); });
      m.offKeys = keyListener((e) => {
        if (M !== m || e.type !== 'keydown') return;
        if (e.code === 'Escape' && m.phase !== 'done') { e.preventDefault(); e.stopPropagation(); finish({ ok: false, quit: true }); return; }
        if (m.phase !== 'play' || e.repeat) return;
        if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyE') { act(m); e.preventDefault(); e.stopPropagation(); }
      });
      m.offUp = (() => {
        const dn = (e) => m.held.add(e.code), up = (e) => m.held.delete(e.code);
        window.addEventListener('keydown', dn, true); window.addEventListener('keyup', up, true);
        return () => { window.removeEventListener('keydown', dn, true); window.removeEventListener('keyup', up, true); };
      })();
      stat(m);
      draw(m);
      m.card = showCard(ov.root, { title: t('wd.title'), lines: [t('wd.how'), t('wd.how2')], buttons: [{ label: t('wd.ui.start'), key: ['Enter', 'Space'], onClick: () => { m.card = null; m.phase = 'play'; synth.play('go'); m.toast(t('wd.go'), 1100); } }, { label: t('wd.ui.later'), key: 'Escape', alt: true, onClick: () => finish({ ok: false, quit: true }) }] });
    });
  }

  const dist = (a, x, y) => Math.hypot(a.x - x, a.y - y);
  const ready = (m) => m.spots.filter((s) => s.state === 'placed').length;

  // Space: whatever is in reach - stand a fallen item up, set the load down on its spot, or take
  // from a pile (putting the load back if it is the wrong pile).
  function act(m) {
    const me = m.me;
    const fallen = m.spots.filter((s) => s.state === 'fallen' && dist(me, s.x, s.y) < REACH).sort((a, b) => dist(me, a.x, a.y) - dist(me, b.x, b.y))[0];
    if (fallen && !me.carry) { fallen.state = 'placed'; synth.play('coin'); m.toast(t('wd.fixed'), 700); stat(m); if (ready(m) === m.spots.length) allDone(m); return true; }
    if (me.carry) {
      const spot = m.spots.filter((s) => s.kind === me.carry && s.state === 'empty' && dist(me, s.x, s.y) < REACH).sort((a, b) => dist(me, a.x, a.y) - dist(me, b.x, b.y))[0];
      if (spot) { spot.state = 'placed'; me.carry = null; synth.play('tick'); stat(m); if (ready(m) === m.spots.length) allDone(m); return true; }
      if (fallen) { m.toast(t('wd.handsFull'), 800); return false; }
    }
    const pile = PILES.find(([, x, y]) => dist(me, x, y) < REACH + 0.4);
    if (pile) {
      if (me.carry === pile[0]) { me.carry = null; synth.play('tick'); return true; }
      if (me.carry) { m.toast(t('wd.handsFull'), 800); return false; }
      if (!m.spots.some((s) => s.kind === pile[0] && s.state === 'empty')) { m.toast(t('wd.noneLeft'), 800); return false; }
      me.carry = pile[0]; synth.play('tick'); return true;
    }
    return false;
  }
  // A press on the lawn: walk to the nearest thing under it and act there, or just walk.
  function pointer(m, x, y) {
    const near = (px, py, r) => Math.hypot(px - x, py - y) < r;
    const fallen = m.spots.find((s) => s.state === 'fallen' && near(s.x, s.y, 1.4));
    const spot = m.spots.find((s) => s.state === 'empty' && near(s.x, s.y, 1.4));
    const pile = PILES.find(([, px, py]) => near(px, py, 1.6));
    const target = fallen || spot || (pile && { x: pile[1], y: pile[2] });
    m.goal = target ? { x: target.x, y: target.y, act: true } : { x: clamp(x, 0.4, LW - 0.4), y: clamp(y, 0.4, LH - 0.4), act: false };
  }
  function allDone(m) {
    m.toast(t('wd.allReady'), 1500);
    synth.play('win');
    m.endT = 1.2;
  }
  function gust(m) {
    const standing = m.spots.filter((s) => s.state === 'placed' && (s.kind === 'table' || s.kind === 'light'));
    if (!standing.length) return;
    const s = standing[Math.floor(Math.random() * standing.length)];
    s.state = 'fallen'; m.falls++;
    m.gustFx = 1.2;
    synth.play('bump');
    m.toast(t(s.kind === 'table' ? 'wd.gustTable' : 'wd.gustLight'), 1400);
    stat(m);
  }

  function tick(m, dt) {
    if (m.endT != null) { m.endT -= dt; if (m.endT <= 0) end(m); return; }
    m.clock -= dt;
    if (m.clock <= 0) { m.clock = 0; end(m); return; }
    // Wind only while there is still time to fix what it knocks over.
    m.gustT -= dt;
    if (m.gustT <= 0) { m.gustT = m.cfg.gust[0] + Math.random() * (m.cfg.gust[1] - m.cfg.gust[0]); if (m.clock > 8) gust(m); }
    m.gustFx = Math.max(0, m.gustFx - dt);
    const me = m.me;
    let ix = 0, iy = 0;
    if (m.held.has('ArrowLeft') || m.held.has('KeyA')) ix -= 1;
    if (m.held.has('ArrowRight') || m.held.has('KeyD')) ix += 1;
    if (m.held.has('ArrowUp') || m.held.has('KeyW')) iy -= 1;
    if (m.held.has('ArrowDown') || m.held.has('KeyS')) iy += 1;
    const vmax = me.carry ? KINDS[me.carry].speed : WALK;
    let wx = 0, wy = 0;
    if (ix || iy) { const l = Math.hypot(ix, iy); wx = (ix / l) * vmax; wy = (iy / l) * vmax; m.goal = null; }
    else if (m.goal) {
      const dx = m.goal.x - me.x, dy = m.goal.y - me.y, d = Math.hypot(dx, dy);
      if (d < (m.goal.act ? REACH * 0.6 : 0.15)) { const g = m.goal; m.goal = null; if (g.act) act(m); }
      else { const v = Math.min(vmax, d * 4); wx = (dx / d) * v; wy = (dy / d) * v; }
    }
    const k = Math.min(1, dt * 12);
    me.vx += (wx - me.vx) * k; me.vy += (wy - me.vy) * k;
    me.x = clamp(me.x + me.vx * dt, 0.4, LW - 0.4); me.y = clamp(me.y + me.vy * dt, 0.4, LH - 0.4);
    // The jeep is solid.
    if (me.x < 3.6 && me.y > 5.4 && me.y < 11.6) me.x = 3.6;
    stat(m);
  }

  function stat(m) {
    const s = Math.ceil(m.clock), mm = Math.floor(s / 60), ss = s % 60;
    m.ov.$('.wd-stat').textContent = t('wd.stat', { n: ready(m), total: m.spots.length, t: `${mm}:${ss < 10 ? '0' : ''}${ss}` });
  }

  function itemShape(g, kind, x, y, alpha = 1, fallen = false) {
    const k = KINDS[kind], r = k.r * S;
    g.save(); g.globalAlpha = alpha; g.translate(x, y);
    if (fallen) g.rotate(0.9);
    g.strokeStyle = '#23324a'; g.lineWidth = 2;
    if (kind === 'table') {
      g.fillStyle = '#f4f1ea';
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; g.beginPath(); g.arc(Math.cos(a) * (r + 5), Math.sin(a) * (r + 5), 3.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
      g.fillStyle = fallen ? '#d9d3c6' : '#ffffff'; g.beginPath(); g.ellipse(0, 0, r, fallen ? r * 0.45 : r, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      if (!fallen) { g.fillStyle = '#e86a8e'; g.beginPath(); g.arc(0, 0, 3.5, 0, Math.PI * 2); g.fill(); }
    } else if (kind === 'light') {
      if (fallen) { g.fillStyle = '#3a3a3a'; g.fillRect(-r, -3, r * 4, 6); }
      else { g.fillStyle = 'rgba(255, 214, 102, 0.35)'; g.beginPath(); g.arc(0, 0, r * 2.4, 0, Math.PI * 2); g.fill(); g.fillStyle = k.color; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill(); g.stroke(); }
    } else if (kind === 'speaker') {
      g.fillStyle = k.color; g.fillRect(-r, -r, r * 2, r * 2); g.strokeRect(-r, -r, r * 2, r * 2);
      g.fillStyle = '#555'; g.beginPath(); g.arc(0, 0, r * 0.55, 0, Math.PI * 2); g.fill();
    } else {
      g.fillStyle = k.color; g.fillRect(-r, -r, r * 2, r * 2); g.strokeRect(-r, -r, r * 2, r * 2);
      g.strokeStyle = 'rgba(35,50,74,0.35)'; g.lineWidth = 1;
      for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(-r, -r + (i * r) / 2); g.lineTo(r, -r + (i * r) / 2); g.stroke(); }
    }
    g.restore();
  }

  function draw(m) {
    const g = m.g, X = (x) => MX + x * S, Y = (y) => MY + y * S;
    g.direction = 'ltr'; // counters read the same in a Hebrew page
    g.fillStyle = '#6aa84f'; g.fillRect(0, 0, W, H);
    // mown stripes
    for (let i = 0; i < LW; i += 2) { g.fillStyle = i % 4 ? '#7cbf5a' : '#86c765'; g.fillRect(X(i), Y(0), 2 * S, LH * S); }
    // the dance floor between the tables
    g.fillStyle = 'rgba(255, 244, 214, 0.55)'; g.fillRect(X(11.5), Y(6.3), 13 * S, 4.4 * S);
    g.strokeStyle = 'rgba(35,50,74,0.25)'; g.lineWidth = 1; g.strokeRect(X(11.5), Y(6.3), 13 * S, 4.4 * S);
    // bulb strings between standing poles
    const pole = (i) => m.spots[i];
    for (const [a, b] of STRINGS) {
      const p = pole(a), q = pole(b);
      if (p.state !== 'placed' || q.state !== 'placed') continue;
      g.strokeStyle = 'rgba(35,50,74,0.55)'; g.lineWidth = 1.2;
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2 + 0.6;
      g.beginPath(); g.moveTo(X(p.x), Y(p.y)); g.quadraticCurveTo(X(mx), Y(my), X(q.x), Y(q.y)); g.stroke();
      for (let k = 1; k < 12; k++) {
        const u = k / 12, bx = (1 - u) * (1 - u) * p.x + 2 * u * (1 - u) * mx + u * u * q.x, by = (1 - u) * (1 - u) * p.y + 2 * u * (1 - u) * my + u * u * q.y;
        g.fillStyle = k % 2 ? '#ffd166' : '#fff3c4'; g.beginPath(); g.arc(X(bx), Y(by), 2.6, 0, Math.PI * 2); g.fill();
      }
    }
    // the plan: dashed ghosts for empty spots, items where placed
    for (const s of m.spots) {
      if (s.state === 'empty') {
        const r = KINDS[s.kind].r * S + (s.kind === 'table' ? 6 : 2);
        const hot = m.me.carry === s.kind;
        g.setLineDash([5, 4]); g.strokeStyle = hot ? '#ffcb3d' : 'rgba(255,255,255,0.85)'; g.lineWidth = hot ? 3 : 2;
        if (s.kind === 'table' || s.kind === 'light') { g.beginPath(); g.arc(X(s.x), Y(s.y), r, 0, Math.PI * 2); g.stroke(); }
        else g.strokeRect(X(s.x) - r, Y(s.y) - r, r * 2, r * 2);
        g.setLineDash([]);
      } else {
        itemShape(g, s.kind, X(s.x), Y(s.y), 1, s.state === 'fallen');
        if (s.state === 'fallen') { g.fillStyle = '#e8364f'; g.font = '900 16px Rubik, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', X(s.x), Y(s.y) - 22); }
      }
    }
    // the black jeep with its boot open, and Sapir by it
    g.fillStyle = '#121212'; g.strokeStyle = '#23324a'; g.lineWidth = 2;
    g.fillRect(X(0.3), Y(5.6), 3.1 * S, 5.8 * S); g.strokeRect(X(0.3), Y(5.6), 3.1 * S, 5.8 * S);
    g.fillStyle = '#3d4b5c'; g.fillRect(X(0.7), Y(6.4), 2.3 * S, 1.2 * S); g.fillRect(X(0.7), Y(9.6), 2.3 * S, 1.0 * S);
    g.font = '22px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('🎧', X(1.8), Y(3.2));
    // the piles
    for (const [kind, x, y] of PILES) {
      const left = m.spots.filter((s) => s.kind === kind && s.state === 'empty').length - (m.me.carry === kind ? 1 : 0);
      g.fillStyle = 'rgba(35,50,74,0.18)'; g.beginPath(); g.arc(X(x), Y(y), 1.25 * S, 0, Math.PI * 2); g.fill();
      itemShape(g, kind, X(x), Y(y), left > 0 ? 1 : 0.3);
      g.fillStyle = '#23324a'; g.font = '900 12px Rubik, sans-serif'; g.fillText(`×${Math.max(0, left)}`, X(x) + 26, Y(y) + 14);
    }
    // the player, with the load overhead
    const me = m.me;
    g.fillStyle = 'rgba(35,50,74,0.25)'; g.beginPath(); g.ellipse(X(me.x) + 2, Y(me.y) + 3, 9, 6, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ff6b3d'; g.strokeStyle = '#23324a'; g.lineWidth = 2;
    g.beginPath(); g.arc(X(me.x), Y(me.y), 9, 0, Math.PI * 2); g.fill(); g.stroke();
    if (me.carry) itemShape(g, me.carry, X(me.x), Y(me.y) - 16, 0.95);
    if (m.goal) { g.strokeStyle = 'rgba(255, 203, 61, 0.9)'; g.lineWidth = 2; g.beginPath(); g.arc(X(m.goal.x), Y(m.goal.y), 6, 0, Math.PI * 2); g.stroke(); }
    // a gust sweeps across
    if (m.gustFx > 0) {
      g.strokeStyle = `rgba(255,255,255,${(m.gustFx / 1.2) * 0.8})`; g.lineWidth = 3;
      const off = (1.2 - m.gustFx) * W;
      for (let i = 0; i < 5; i++) { const yy = 60 + i * 70; g.beginPath(); g.moveTo(off - 120, yy); g.quadraticCurveTo(off - 60, yy - 18, off, yy); g.stroke(); }
    }
  }

  function end(m) {
    if (m.phase !== 'play') return;
    m.phase = 'done';
    const placed = ready(m), total = m.spots.length, ok = placed === total;
    const score = placed * 10 + (ok ? Math.round(m.clock) * 2 : 0);
    synth.play(ok ? 'win' : 'bump');
    const res = { ok, score, placed, total };
    m.card = showCard(m.ov.root, {
      title: t(ok ? 'wd.win' : 'wd.loss'),
      big: `${placed} / ${total}`,
      lines: [t(ok ? 'wd.lineWin' : 'wd.lineLoss', { s: Math.round(m.clock), score })],
      buttons: [{ label: t('wd.ui.done'), key: ['Enter', 'Escape', 'Space'], onClick: () => finish(res) }],
    });
  }
  function update(dt) {
    const m = M;
    if (!m || dt <= 0) return;
    if (m.phase === 'play') {
      m.time += dt;
      let left = Math.min(dt, 0.1);
      while (left > 1e-4 && M === m && m.phase === 'play') { const st = Math.min(left, 1 / 60); tick(m, st); left -= st; }
    }
    if (M === m) draw(m);
  }
  function finish(result) {
    const m = M;
    if (!m) return;
    M = null;
    if (m.card) { m.card(); m.card = null; }
    m.offKeys(); m.offUp();
    m.ov.remove();
    m.resolve({ ...result, tries: 1 });
  }
  function cancel() { if (M) finish({ ok: false, cancelled: true }); }

  return {
    start, update, cancel,
    get active() { return !!M; },
    get blocksPlayer() { return !!M; },
    debug: {
      state: () => (M ? { phase: M.phase, clock: +M.clock.toFixed(1), placed: ready(M), total: M.spots.length, carry: M.me.carry, falls: M.falls } : null),
      play: () => { if (M && M.card) { M.card(); M.card = null; } if (M) M.phase = 'play'; },
      // The live game and its act(), for playthroughs in tools.
      raw: () => M,
      act: () => (M ? act(M) : false),
      piles: PILES,
    },
  };
}
