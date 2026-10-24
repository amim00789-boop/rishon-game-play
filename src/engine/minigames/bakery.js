// Bakery shift (docs/JOBS.md, idea 3). A DOM-only minigame: no world, no physics. Customers come
// one at a time; for each one the player takes the order, kneads, bakes (a timing needle), packs the
// bag and hands it over before the customer's patience runs out.
//
//   const r = await bakery.start({ orders: 3 });
//   // r = { ok, score (0..100), summary, detail: { served, total, perfect, mistakes, tips }, reason?, quit? }
//
// Keys: Space takes the order and pulls the tray out of the oven, A and D knead (taps and clicks
// work too), 1-4 put the pastries in the bag, Enter hands it over. Esc quits. Job game: the shared
// result card comes from jobs.js.
import { createOverlay, addStyle, textFn, clamp, toaster, keyListener, fmtTime } from './common.js';
import { getSynth } from './synth.js';

const CSS = `
.mg-bake .bk-main { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, calc(100vw - 24px)); text-align: center; pointer-events: auto; }
.mg-bake .bk-top { display: flex; justify-content: space-between; align-items: center; font-weight: 900; font-size: 15px; }
.mg-bake .bk-face { font-size: 34px; }
.mg-bake .bk-steps { display: flex; justify-content: center; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
.mg-bake .bk-chip { padding: 2px 10px; border: 2px solid rgba(35, 50, 74, 0.4); border-radius: 14px; font-weight: 800; font-size: 12px; background: #fff; }
.mg-bake .bk-chip.on { background: #ffcb3d; border-color: #23324a; }
.mg-bake .bk-chip.done { background: #b9ecd0; }
.mg-bake .bk-body { min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.mg-bake .bk-order { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; font-size: 44px; line-height: 1.1; }
.mg-bake .bk-order span small { display: block; font-size: 13px; font-weight: 800; }
.mg-bake .bk-order span.ok { opacity: 0.35; }
.mg-bake .bk-hint { margin-top: 6px; font-weight: 700; font-size: 13px; opacity: 0.85; min-height: 18px; }
.mg-bake .bk-dough { width: 220px; height: 24px; }
.mg-bake .bk-oven { position: relative; width: 300px; height: 28px; border: 2px solid #23324a; border-radius: 8px; background: linear-gradient(90deg, #e8e0cf, #c98b4d 70%, #5a3418); overflow: hidden; }
.mg-bake .bk-green { position: absolute; top: 0; bottom: 0; background: rgba(46, 196, 182, 0.75); border-inline: 2px solid #1b8f84; }
.mg-bake .bk-needle { position: absolute; top: -2px; bottom: -2px; width: 4px; margin-left: -2px; background: #e8364f; }
.mg-bake .bk-tray { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.mg-bake .bk-tray .mg-btn { font-size: 30px; padding: 4px 12px; }
.mg-bake .bk-tray .mg-btn small { display: block; font-size: 11px; }
.mg-bake .bk-pat > i { background: #7fe0d6; }
.mg-bake .bk-pat.low > i { background: #e8364f; }
.mg-bake .bk-big { font-size: 56px; }
`;

let dataP = null;
const loadData = () => (dataP || (dataP = fetch(new URL('../../../data/minigames/bakery.json', import.meta.url).href, { cache: 'no-cache' }).then((r) => r.json())));
const STEPS = ['take', 'knead', 'bake', 'pack', 'hand'];

export function createBakery(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  addStyle('mg-style-bake', CSS);
  let S = null;

  async function start(config = {}) {
    if (S) cancel();
    const data = await loadData();
    return new Promise((resolve) => {
      const ov = createOverlay('mg-bake',
        '<div class="mg-panel bk-main"><div class="bk-top"><span class="bk-cust"></span><span class="bk-face"></span><span class="bk-clock mg-num"></span></div>' +
        '<div class="mg-bar bk-pat"><i></i></div><div class="bk-steps"></div><div class="bk-body"></div><div class="bk-hint"></div></div>');
      const steps = ov.$('.bk-steps');
      for (const k of STEPS) { const c = document.createElement('span'); c.className = 'bk-chip'; c.dataset.step = k; c.textContent = t(`jobs.bakery.step.${k}`); steps.appendChild(c); }
      const n = clamp(config.orders || 3, 1, data.orders.length);
      // The same shift every time for the same try count would be dull; a start offset rotates them.
      const off = config.seed ?? Math.floor(Math.random() * data.orders.length);
      const orders = Array.from({ length: n }, (_, i) => data.orders[(off + i) % data.orders.length]);
      S = { cfg: config, data, ov, resolve, toast: toaster(ov.root), orders, idx: -1, results: [], time: 0, perfect: 0, mistakes: 0, tips: 0,
        offKeys: keyListener(onKey), phase: 'ready', t0: 0 };
      next();
    });
  }

  // ---- customers ------------------------------------------------------------------------------
  function next() {
    const s = S;
    s.idx++;
    if (s.idx >= s.orders.length) return done();
    const order = s.orders[s.idx];
    // patience (seconds) shrinks a little for every later customer
    const pat = (s.cfg.patience || 62) - s.idx * 4;
    s.cur = { order, lines: order.map(([item, count]) => ({ item, count, packed: 0 })), patience: pat, left: pat, quality: [], mistakes: 0,
      face: s.data.faces[(s.idx + (s.cfg.seed || 0)) % s.data.faces.length], bakeQ: [], bakeIdx: 0 };
    s.ov.$('.bk-face').textContent = s.cur.face;
    s.ov.$('.bk-cust').textContent = t('jobs.bakery.customer', { n: s.idx + 1, total: s.orders.length });
    setPhase('take');
  }

  function setPhase(p) {
    const s = S;
    s.phase = p;
    s.t0 = s.time;
    for (const c of s.ov.root.querySelectorAll('.bk-chip')) {
      const i = STEPS.indexOf(c.dataset.step), cur = STEPS.indexOf(p);
      c.classList.toggle('on', i === cur);
      c.classList.toggle('done', i < cur);
    }
    s.ov.$('.bk-hint').innerHTML = '';
    const hint = t(`jobs.bakery.hint.${p}`);
    s.ov.$('.bk-hint').innerHTML = hint.replace(/\{k:([^}]+)\}/g, '<kbd dir="ltr">$1</kbd>');
    const body = s.ov.$('.bk-body');
    body.innerHTML = '';
    if (p === 'take') renderTake(body);
    else if (p === 'knead') renderKnead(body);
    else if (p === 'bake') renderBake(body);
    else if (p === 'pack') renderPack(body);
    else if (p === 'hand') renderHand(body);
  }

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const button = (label, fn, cls = '') => { const b = el('button', 'mg-btn ' + cls); b.innerHTML = label; b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }); return b; };
  const orderRow = (lines, showDone = false) => {
    const row = el('div', 'bk-order');
    for (const l of lines) {
      const sp = el('span');
      sp.textContent = l.item && S.data.items[l.item].icon.repeat(l.count);
      const sm = el('small', null, `${t(`jobs.bakery.item.${l.item}`)}${showDone ? ` ${l.packed}/${l.count}` : ` x${l.count}`}`);
      sp.appendChild(sm);
      if (showDone && l.packed >= l.count) sp.className = 'ok';
      sp.dataset.item = l.item;
      row.appendChild(sp);
    }
    return row;
  };

  function renderTake(body) {
    body.append(el('div', 'mg-small', t('jobs.bakery.want')), orderRow(S.cur.lines), button(`${t('jobs.bakery.step.take')}`, takeOrder));
  }
  function takeOrder() { if (S.phase !== 'take') return; synth.play('tek'); setPhase('knead'); S.cur.dough = 0; S.cur.lastKey = null; }

  function renderKnead(body) {
    const dough = el('div', 'bk-big', '🥣');
    const bar = el('div', 'mg-bar bk-dough'); bar.appendChild(el('i'));
    dough.addEventListener('pointerdown', (e) => { e.preventDefault(); knead(0.045, null); });
    body.append(dough, bar);
    S.doughBar = bar.firstChild;
  }
  function knead(amount, key) {
    const s = S;
    if (s.phase !== 'knead') return;
    // alternating A and D is worth the full push, hammering one key only a trickle
    const add = key && s.cur.lastKey === key ? amount * 0.2 : amount;
    s.cur.lastKey = key;
    s.cur.dough = Math.min(1, s.cur.dough + add);
    s.doughBar.style.width = s.cur.dough * 100 + '%';
    if (s.cur.dough >= 1) { synth.play('tek'); s.cur.bakeList = s.cur.lines.map((l) => l.item); s.cur.bakeIdx = 0; setPhase('bake'); newNeedle(); }
  }

  function renderBake(body) {
    const s = S, item = s.cur.bakeList[s.cur.bakeIdx];
    body.append(el('div', 'bk-big', s.data.items[item].icon), el('div', 'mg-title', t(`jobs.bakery.item.${item}`)));
    const oven = el('div', 'bk-oven');
    const green = el('div', 'bk-green'), needle = el('div', 'bk-needle');
    oven.append(green, needle);
    body.append(oven, button(t('jobs.bakery.step.bake'), pull));
    s.greenEl = green; s.needleEl = needle;
    newNeedle(true);
  }
  // A new green window for each tray; the later the customer, the narrower and the faster.
  function newNeedle(rebuild) {
    const s = S;
    const w = Math.max(0.14, 0.24 - s.idx * 0.03);
    const c = 0.35 + ((s.idx * 0.23 + s.cur.bakeIdx * 0.31 + (s.cfg.seed || 0) * 0.17) % 0.45);
    s.cur.win = { lo: c - w / 2, hi: c + w / 2, c };
    s.cur.needle = 0; s.cur.dir = 1; s.cur.speed = 0.75 + s.idx * 0.12;
    if (s.greenEl) { s.greenEl.style.left = s.cur.win.lo * 100 + '%'; s.greenEl.style.width = w * 100 + '%'; }
  }
  function pull() {
    const s = S;
    if (s.phase !== 'bake') return;
    const w = s.cur.win, p = s.cur.needle;
    let q, key;
    if (Math.abs(p - w.c) < 0.045) { q = 1; key = 'perfect'; s.perfect++; synth.play('ding'); }
    else if (p >= w.lo && p <= w.hi) { q = 0.8; key = 'good'; synth.play('tek'); }
    else { q = 0.35; key = p < w.lo ? 'raw' : 'burnt'; synth.play('miss'); }
    s.cur.bakeQ.push(q);
    s.toast(t(`jobs.bakery.${key}`));
    s.cur.bakeIdx++;
    if (s.cur.bakeIdx >= s.cur.bakeList.length) { setPhase('pack'); return; }
    setPhase('bake');
    newNeedle();
  }

  function renderPack(body) {
    const s = S;
    s.bagRow = orderRow(s.cur.lines, true);
    const tray = el('div', 'bk-tray');
    for (const [id, it] of Object.entries(s.data.items)) {
      const b = button(`${it.icon}<small>${it.cap}</small>`, () => put(id));
      tray.appendChild(b);
    }
    body.append(s.bagRow, tray);
  }
  function put(item) {
    const s = S;
    if (s.phase !== 'pack') return;
    const line = s.cur.lines.find((l) => l.item === item && l.packed < l.count);
    if (!line) { s.cur.mistakes++; s.mistakes++; synth.play('miss'); s.toast(t('jobs.bakery.wrong')); return; }
    line.packed++;
    synth.play('tek');
    const body = s.ov.$('.bk-body');
    s.bagRow.replaceWith((s.bagRow = orderRow(s.cur.lines, true)));
    if (s.cur.lines.every((l) => l.packed >= l.count)) { s.toast(t('jobs.bakery.bagFull')); setPhase('hand'); }
  }

  function renderHand(body) {
    body.append(el('div', 'bk-big', '🛍️'), button(t('jobs.bakery.step.hand'), handOver));
  }
  function handOver() {
    const s = S;
    if (s.phase !== 'hand') return;
    const c = s.cur, patience = c.left / c.patience;
    const quality = c.bakeQ.reduce((n, q) => n + q, 0) / Math.max(1, c.bakeQ.length);
    const clean = 1 - Math.min(1, c.mistakes / 3);
    const score = Math.round(100 * (0.4 * quality + 0.4 * clamp(patience * 1.6, 0, 1) + 0.2 * clean));
    const tip = Math.round(score / 10);
    s.tips += tip;
    s.results.push({ served: true, score, tip });
    const face = patience > 0.45 ? 'happy' : patience > 0.2 ? 'ok' : 'angry';
    s.ov.$('.bk-face').textContent = face === 'happy' ? '😄' : face === 'ok' ? '🙂' : '😠';
    synth.play('win');
    s.toast(`${t(`jobs.bakery.${face}`)}  ${t('jobs.bakery.tip', { n: tip })}`, 1500);
    s.phase = 'pause'; s.t0 = s.time;
    s.after = () => next();
  }

  function leave() {
    const s = S;
    s.results.push({ served: false, score: 0, tip: 0 });
    s.ov.$('.bk-face').textContent = '😠';
    synth.play('fail');
    s.toast(t('jobs.bakery.left'), 1500);
    s.phase = 'pause'; s.t0 = s.time;
    s.after = () => next();
  }

  function onKey(e) {
    const s = S;
    if (!s || e.repeat) return;
    if (e.code === 'Escape') { e.preventDefault(); finish({ ok: false, quit: true, tries: 1 }); return; }
    if (s.phase === 'take' && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); takeOrder(); }
    else if (s.phase === 'knead' && (e.code === 'KeyA' || e.code === 'KeyD' || e.code === 'ArrowLeft' || e.code === 'ArrowRight')) { e.preventDefault(); knead(0.06, e.code === 'KeyA' || e.code === 'ArrowLeft' ? 'L' : 'R'); }
    else if (s.phase === 'bake' && e.code === 'Space') { e.preventDefault(); pull(); }
    else if (s.phase === 'pack') {
      for (const [id, it] of Object.entries(s.data.items)) if (e.code === it.key || e.code === it.key.replace('Digit', 'Numpad')) { e.preventDefault(); put(id); }
    } else if (s.phase === 'hand' && (e.code === 'Enter' || e.code === 'Space')) { e.preventDefault(); handOver(); }
  }

  function update(dt) {
    const s = S;
    if (!s || dt <= 0) return;
    s.time += dt;
    if (s.phase === 'pause') { if (s.time - s.t0 > 1.4) { const f = s.after; s.after = null; f && f(); } return; }
    if (s.phase === 'ready' || !s.cur) return;
    s.cur.left -= dt;
    if (s.phase === 'bake') {
      s.cur.needle += s.cur.dir * s.cur.speed * dt;
      if (s.cur.needle >= 1) { s.cur.needle = 1; s.cur.dir = -1; } else if (s.cur.needle <= 0) { s.cur.needle = 0; s.cur.dir = 1; }
      if (s.needleEl) s.needleEl.style.left = s.cur.needle * 100 + '%';
    }
    const v = clamp(s.cur.left / s.cur.patience, 0, 1);
    const bar = s.ov.$('.bk-pat');
    bar.firstChild.style.width = v * 100 + '%';
    bar.classList.toggle('low', v < 0.25);
    s.ov.$('.bk-clock').textContent = fmtTime(Math.max(0, s.cur.left));
    if (s.cur.left <= 0) leave();
  }

  function done() {
    const s = S;
    const served = s.results.filter((r) => r.served).length;
    const score = Math.round(s.results.reduce((n, r) => n + r.score, 0) / s.orders.length);
    if (!served) return finish({ ok: false, reason: 'nobody', tries: 1 });
    const detail = { served, total: s.orders.length, perfect: s.perfect, mistakes: s.mistakes, tips: s.tips, time: +s.time.toFixed(1) };
    finish({ ok: true, score, detail, summary: t('jobs.bakery.summary', { served, total: s.orders.length, perfect: s.perfect, mistakes: s.mistakes }), tries: 1 });
  }

  function finish(result) {
    const s = S;
    if (!s) return;
    S = null;
    s.offKeys();
    s.ov.remove();
    s.resolve(result);
  }
  function cancel() {
    const s = S;
    if (!s) return;
    finish({ ok: false, cancelled: true, tries: 1 });
  }

  return {
    start, update, cancel,
    get active() { return !!S; },
    get blocksPlayer() { return !!S; },
    debug: {
      state: () => (S ? { phase: S.phase, idx: S.idx, left: S.cur ? +S.cur.left.toFixed(1) : null, dough: S.cur ? S.cur.dough : null, needle: S.cur ? S.cur.needle : null,
        win: S.cur ? S.cur.win : null, lines: S.cur ? S.cur.lines : null, perfect: S.perfect, mistakes: S.mistakes, results: S.results } : null),
    },
  };
}
