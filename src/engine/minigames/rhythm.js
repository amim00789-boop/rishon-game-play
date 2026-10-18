// Note-highway rhythm game: lanes of falling notes, hit them on the line with D F J K (or by
// tapping the lane pads). Charts are JSON in data/minigames/charts/<id>.json. Timing is judged
// against the WebAudio clock (with the output latency taken off); without a running audio
// context (hidden tab, automated tick) it falls back to accumulated frame time.
//
//   const rhythm = createRhythm({ scene, camera, hud, audio, player, city, t });
//   const res = await rhythm.start({ chart: 'beach_soundcheck', pass: 0.6 });
//   // res = { ok, score, accuracy, hits, perfect, misses, total, maxCombo, grade, tries, quit }
//   per frame: rhythm.update(dt, input)
//
// Fails are forgiving: a result card offers a retry from the count-in; after two fails the
// timing window widens to `assistWindow`. Only "quit" resolves with ok: false.
import { createOverlay, addStyle, textFn, showCard, keyListener, clamp, rich } from './common.js';
import { getSynth } from './synth.js';

const CHART_BASE = new URL('../../../data/minigames/charts/', import.meta.url).href;
const LANE_COLORS = ['#ff6f59', '#ffcb3d', '#2ec4b6', '#b36bd6', '#7fe0d6', '#ffb347'];
const DEFAULT_KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'KeyS'];
const cap = (code) => code.replace(/^Key|^Digit|^Numpad/, '');

// Kits: what each lane sounds like when hit, and the backing track per eighth-note step
// (step 0 = the first downbeat; negative steps are the count-in, which only clicks).
const ROOTS = [55, 43.65, 65.41, 49.0]; // A, F, C, G
const CHORDS = [[220, 262, 330], [175, 220, 262], [262, 330, 392], [196, 247, 294]];
const KITS = {
  beach: {
    lanes: [['kick'], ['snare'], ['tek'], ['clap']],
    back(s, step, t, spb) {
      const e = ((step % 8) + 8) % 8, bar = Math.floor(step / 8);
      // Moshiko's playlist: a soft darbuka maqsum under the player's kit.
      if (e === 0 || e === 4) s.play('dum', t, 0.35);
      if (e === 1 || e === 3 || e === 6) s.play('tek', t, 0.22);
      if (e % 2 === 1) s.play('hat', t, 0.35);
      if (e === 0) s.play('bass', t, 0.8, ROOTS[bar % 4], spb * 1.6);
      if (e === 4) s.play('bass', t, 0.6, ROOTS[bar % 4] * 1.5, spb * 1.2);
      if (e === 0 && bar % 2 === 0) s.play('wave', t, 1, spb * 7);
    },
  },
  choir: {
    // Light-desk cues: two spotlights, the curtain, the house lights.
    lanes: [['bell', 784], ['bell', 988], ['whoosh'], ['bell', 659]],
    back(s, step, t, spb) {
      const e = ((step % 8) + 8) % 8, bar = Math.floor(step / 8);
      if (e === 0) s.play('pad', t, 1, CHORDS[bar % 4], spb * 4);
      if (e === 0 || e === 4) s.play('bass', t, 0.45, ROOTS[bar % 4], spb * 1.8);
      if (e === 2 || e === 6) s.play('hat', t, 0.12);
    },
  },
  concert: {
    lanes: [['kick'], ['snare'], ['tom', 150], ['crash']],
    back(s, step, t, spb) {
      const e = ((step % 8) + 8) % 8, bar = Math.floor(step / 8);
      s.play('hat', t, e % 2 ? 0.25 : 0.4);
      s.play('bass', t, e % 2 ? 0.45 : 0.7, ROOTS[bar % 4] * (e === 6 ? 1.5 : 1), spb * 0.45);
      if (e === 0) s.play('pad', t, 0.8, CHORDS[bar % 4].map((f) => f * 2), spb * 4);
    },
  },
};

const CSS = `
.mg-rhythm .rh-top { left: 50%; top: 14px; transform: translateX(-50%); width: min(420px, calc(100vw - 32px)); text-align: center; }
.mg-rhythm .rh-row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-weight: 800; }
.mg-rhythm .rh-score { font-size: 22px; font-weight: 900; }
.mg-rhythm .rh-combo { font-size: 14px; }
.mg-rhythm .mg-bar { margin-top: 6px; }
.mg-rhythm .rh-hw { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); pointer-events: auto;
  border: 2px solid rgba(35, 50, 74, 0.85); border-radius: 14px; overflow: hidden; background: rgba(20, 28, 44, 0.72);
  box-shadow: 0 3px 0 rgba(35, 50, 74, 0.35); touch-action: none; }
.mg-rhythm .rh-hw canvas { display: block; }
.mg-rhythm .rh-pads { position: absolute; left: 0; right: 0; bottom: 0; display: flex; }
.mg-rhythm .rh-pad { flex: 1; text-align: center; padding: 6px 2px 8px; color: #fff; font-weight: 800; font-size: 12px; line-height: 1.3; }
.mg-rhythm .rh-pad kbd { color: #23324a; font-size: 16px; }
.mg-rhythm .rh-pad .lbl { display: block; opacity: 0.9; font-size: 11px; line-height: 1.15; max-height: 2.3em; overflow: hidden; }
.mg-rhythm .rh-judge { position: absolute; left: 50%; transform: translate(-50%, -50%); font-size: 26px; font-weight: 900; color: #fff;
  -webkit-text-stroke: 2px #23324a; pointer-events: none; }
`;

export function createRhythm(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  addStyle('mg-style-rhythm', CSS);
  let S = null; // the running session

  async function loadChart(chart, base) {
    if (chart && typeof chart === 'object') return chart;
    const r = await fetch(`${base || CHART_BASE}${chart}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`chart ${chart}: HTTP ${r.status}`);
    return r.json();
  }

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve, reject) => {
      loadChart(config.chart || 'beach_soundcheck', config.chartBase).then((chart) => {
        S = makeSession(config, chart, resolve);
        begin();
      }).catch((e) => { console.warn('[rhythm] chart failed', e); reject(e); });
    });
  }

  function makeSession(cfg, chart, resolve) {
    const lanes = cfg.lanes || chart.lanes || 4;
    const kit = KITS[cfg.kit || chart.kit] || KITS.beach;
    const keys = (cfg.keys || DEFAULT_KEYS).slice(0, lanes);
    const ov = createOverlay('mg-rhythm',
      '<div class="mg-panel rh-top"><div class="mg-title rh-title"></div><div class="rh-row"><span class="rh-score mg-num">0</span>' +
      '<span class="rh-combo"></span><span class="rh-acc mg-num"></span></div><div class="mg-bar"><i></i><b></b></div></div>' +
      '<div class="rh-hw" dir="ltr"><canvas></canvas><div class="rh-pads"></div><div class="rh-judge"></div></div>');
    ov.$('.rh-title').textContent = t(cfg.title || chart.title || 'mg.rhythm.title');
    const pads = ov.$('.rh-pads');
    const labels = cfg.labels || chart.labels || null;
    for (let i = 0; i < lanes; i++) {
      const p = document.createElement('div');
      p.className = 'rh-pad';
      const lbl = labels ? t(labels[i]) : t(`mg.rhythm.lane.${kit.lanes[i][0]}`);
      p.innerHTML = `<kbd>${cap(keys[i])}</kbd><span class="lbl">${rich(lbl)}</span>`;
      pads.appendChild(p);
    }
    const hw = ov.$('.rh-hw');
    const canvas = ov.$('canvas');
    const onPointer = (e) => {
      if (!S || S.phase !== 'play') return;
      e.preventDefault();
      const r = hw.getBoundingClientRect();
      press(clamp(Math.floor(((e.clientX - r.left) / r.width) * lanes), 0, lanes - 1));
    };
    hw.addEventListener('pointerdown', onPointer);
    const bpm = chart.bpm || 100;
    const spb = 60 / bpm;
    const offset = chart.offset || 0;
    const notes = (chart.notes || []).filter((n) => n[1] < lanes).map(([beat, lane]) => ({ beat, lane, time: offset + beat * spb, st: 0 }));
    notes.sort((a, b) => a.time - b.time);
    const s = {
      cfg, chart, kit, lanes, keys, ov, canvas, hw, resolve, spb, notes,
      byLane: Array.from({ length: lanes }, (_, i) => notes.filter((n) => n.lane === i)),
      countIn: chart.countIn ?? 4,
      lengthBeats: chart.lengthBeats || Math.ceil((notes.length ? notes[notes.length - 1].beat : 16) + 2),
      pass: cfg.pass ?? chart.pass ?? 0.6,
      baseWindow: cfg.window ?? 0.12,
      assistWindow: cfg.assistWindow ?? 0.18,
      lead: cfg.lead ?? 1.7,
      userOffset: cfg.offset || 0,
      tries: 0, phase: 'idle', closeCard: null,
      flash: new Array(lanes).fill(0), rings: [],
      judge: { text: '', t: 0, el: ov.$('.rh-judge') },
      offKeys: keyListener(onKey), onResize: () => size(),
    };
    window.addEventListener('resize', s.onResize);
    return s;
  }

  function size() {
    if (!S) return;
    const w = Math.min(window.innerWidth - 32, 104 * S.lanes);
    const h = Math.min(window.innerHeight * 0.62, 520);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.canvas.width = Math.round(w * dpr); S.canvas.height = Math.round(h * dpr);
    S.canvas.style.width = w + 'px'; S.canvas.style.height = h + 'px';
    S.dpr = dpr; S.w = w; S.h = h;
    S.hitY = h - 72;
  }

  // (Re)start the chart from the count-in.
  function begin() {
    size();
    const s = S;
    s.window = s.tries >= 2 ? s.assistWindow : Math.min(s.assistWindow, s.baseWindow * (1 + 0.1 * s.tries));
    for (const n of s.notes) { n.st = 0; n.grade = null; }
    Object.assign(s, { score: 0, combo: 0, maxCombo: 0, hits: 0, perfect: 0, misses: 0, lastBeat: -99 });
    s.ptr = new Array(s.lanes).fill(0);
    s.missPtr = 0;
    s.phase = 'play';
    s.songTime = -s.countIn * s.spb - 0.6;
    s.clock = 'dt';
    s.lastPerf = performance.now();
    s.nextStep = -s.countIn * 2;
    s.lastStep = s.lengthBeats * 2;
    synth.ensure();
    syncClock();
    clearInterval(s.timer);
    s.timer = setInterval(schedule, 40);
    ov().$('.mg-bar b').style.left = s.pass * 100 + '%';
    if (ov().root.dir === 'rtl') { ov().$('.mg-bar b').style.left = ''; ov().$('.mg-bar b').style.right = s.pass * 100 + '%'; }
    hud();
  }
  const ov = () => S.ov;

  // Audio clock while the context runs, frame time otherwise; switching keeps the song time.
  function syncClock() {
    const s = S;
    if (synth.running()) {
      if (s.clock !== 'audio') { s.audioStart = synth.time() - s.songTime; s.clock = 'audio'; }
    } else if (s.clock === 'audio') { s.songTime = synth.time() - s.audioStart; s.clock = 'dt'; s.lastPerf = performance.now(); }
  }
  function now() {
    const s = S;
    if (s.clock === 'audio') return synth.time() - s.audioStart;
    return s.songTime + Math.min(0.1, (performance.now() - s.lastPerf) / 1000);
  }
  // What the player hears lags the clock by the output latency; judge against what they hear.
  const heard = () => now() - (S.clock === 'audio' ? synth.latency() : 0) - S.userOffset;

  function schedule() {
    const s = S;
    if (!s || s.phase !== 'play' || s.clock !== 'audio') return;
    const horizon = now() + 0.25;
    while (s.nextStep <= s.lastStep && (s.nextStep * s.spb) / 2 + (s.chart.offset || 0) < horizon) {
      const st = s.nextStep++;
      const songT = (st * s.spb) / 2 + (s.chart.offset || 0);
      const at = s.audioStart + songT;
      if (at < synth.time() - 0.02) continue;
      if (st < 0) { if (st % 2 === 0) synth.play('click', at, 1, st === -s.countIn * 2); }
      else if (!s.cfg.mute) s.kit.back(synth, st, at, s.spb);
    }
  }

  function press(lane, at = heard()) {
    const s = S;
    if (!s || s.phase !== 'play' || lane < 0 || lane >= s.lanes) return null;
    s.flash[lane] = 1;
    const list = s.byLane[lane];
    let best = null, bd = Infinity;
    for (let i = s.ptr[lane]; i < list.length; i++) {
      const n = list[i];
      if (n.st) continue;
      const d = at - n.time;
      if (d < -s.window) break;
      if (Math.abs(d) < bd) { bd = Math.abs(d); best = n; }
    }
    const [voice, arg] = s.kit.lanes[lane];
    if (!best || bd > s.window) {
      // A stray press is free: it plays the drum quietly and costs nothing (no combo break).
      synth.play(voice, null, 0.45, arg);
      return null;
    }
    synth.play(voice, null, 1, arg);
    best.st = 1;
    const grade = bd <= s.window * 0.4 ? 'perfect' : 'good';
    best.grade = grade;
    s.hits++;
    if (grade === 'perfect') s.perfect++;
    s.combo++;
    s.maxCombo = Math.max(s.maxCombo, s.combo);
    s.score += Math.round((grade === 'perfect' ? 300 : 120) * (1 + Math.min(s.combo, 40) / 20));
    s.rings.push({ lane, t: 0 });
    showJudge(grade);
    try { s.cfg.onHit && s.cfg.onHit(lane, grade); } catch (_) { /* caller's problem */ }
    hud();
    return grade;
  }

  function showJudge(kind) {
    const j = S.judge;
    j.el.textContent = t(`mg.rhythm.${kind}`);
    j.el.style.top = (S.hitY - 46) + 'px';
    j.el.style.color = kind === 'miss' ? '#ffd0d0' : kind === 'perfect' ? '#ffcb3d' : '#ffffff';
    j.t = 0.5;
    j.el.style.opacity = 1;
  }

  function onKey(e) {
    if (!S || e.repeat) return;
    if (S.phase === 'play') {
      const lane = S.keys.indexOf(e.code);
      if (lane >= 0) { e.preventDefault(); press(lane); return; }
      if (e.code === 'Escape') { e.preventDefault(); finish(true); }
    }
  }

  function hud() {
    const s = S;
    const judged = s.hits + s.misses;
    const acc = s.notes.length ? s.hits / s.notes.length : 0;
    ov().$('.rh-score').textContent = String(s.score);
    ov().$('.rh-combo').textContent = s.combo > 2 ? t('mg.rhythm.combo', { n: s.combo }) : '';
    ov().$('.rh-acc').textContent = judged ? `${Math.round((s.hits / judged) * 100)}%` : '';
    ov().$('.mg-bar i').style.width = acc * 100 + '%';
  }

  function update(dt) {
    const s = S;
    if (!s) return;
    if (s.judge.t > 0) { s.judge.t -= dt; if (s.judge.t <= 0) s.judge.el.style.opacity = 0; }
    if (s.phase !== 'play') { draw(); return; }
    syncClock();
    if (s.clock === 'dt') { s.songTime += dt; s.lastPerf = performance.now(); }
    schedule();
    const tNow = heard();
    if (s.cfg.autoplay) {
      for (let l = 0; l < s.lanes; l++) for (const n of s.byLane[l]) if (!n.st && n.time <= tNow + 0.004) press(l, n.time);
    }
    // Misses: past the window and never hit.
    let changed = false;
    for (let i = s.missPtr; i < s.notes.length; i++) {
      const n = s.notes[i];
      if (n.time > tNow - s.window) break;
      if (!n.st) { n.st = 2; s.misses++; s.combo = 0; changed = true; showJudge('miss'); }
      if (i === s.missPtr) s.missPtr++;
    }
    for (let l = 0; l < s.lanes; l++) while (s.ptr[l] < s.byLane[l].length && s.byLane[l][s.ptr[l]].st) s.ptr[l]++;
    if (changed) hud();
    const beat = Math.floor(tNow / s.spb);
    if (beat !== s.lastBeat && beat >= 0) { s.lastBeat = beat; try { s.cfg.onBeat && s.cfg.onBeat(beat); } catch (_) { /* caller's problem */ } }
    for (let l = 0; l < s.lanes; l++) s.flash[l] = Math.max(0, s.flash[l] - dt * 5);
    for (const r of s.rings) r.t += dt;
    s.rings = s.rings.filter((r) => r.t < 0.35);
    const last = s.notes.length ? s.notes[s.notes.length - 1].time : 0;
    if (tNow > Math.max(last + 0.9, (s.lengthBeats * s.spb) + (s.chart.offset || 0))) finish(false);
    draw();
  }

  function draw() {
    const s = S;
    if (!s || !s.w) return;
    const g = s.canvas.getContext('2d');
    const { w, h, dpr, lanes, hitY } = s;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const lw = w / lanes;
    const tNow = s.phase === 'play' ? heard() : (s.frozenT ?? 0);
    const pps = hitY / s.lead; // pixels per second
    for (let l = 0; l < lanes; l++) {
      const x = l * lw;
      g.fillStyle = l % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.09)';
      g.fillRect(x, 0, lw, h);
      if (s.flash[l] > 0) {
        const grd = g.createLinearGradient(0, hitY, 0, hitY - 160);
        grd.addColorStop(0, hexA(LANE_COLORS[l], 0.5 * s.flash[l]));
        grd.addColorStop(1, hexA(LANE_COLORS[l], 0));
        g.fillStyle = grd;
        g.fillRect(x, hitY - 160, lw, 160);
      }
    }
    // beat lines
    g.strokeStyle = 'rgba(255,255,255,0.13)';
    g.lineWidth = 1;
    const firstBeat = Math.ceil((tNow - 0.3) / s.spb);
    for (let b = firstBeat; b * s.spb < tNow + s.lead; b++) {
      const y = hitY - (b * s.spb - tNow) * pps;
      g.lineWidth = b % 4 === 0 ? 2 : 1;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    }
    // hit line + targets
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(0, hitY - 2, w, 4);
    for (let l = 0; l < lanes; l++) {
      const cx = l * lw + lw / 2;
      g.beginPath(); g.arc(cx, hitY, Math.max(0, Math.min(22, lw * 0.3)), 0, Math.PI * 2); // a hidden canvas has width 0
      g.strokeStyle = LANE_COLORS[l]; g.lineWidth = 4; g.stroke();
    }
    // notes
    const nh = 18;
    for (const n of s.notes) {
      if (n.st === 1) continue;
      const y = hitY - (n.time - tNow) * pps;
      // Past the line the pads take over; a missed note fades out just below it.
      if (y < -nh || y > hitY + 26) continue;
      const x = n.lane * lw + 8;
      g.globalAlpha = n.st === 2 ? 0.3 : 1;
      roundRect(g, x, y - nh / 2, lw - 16, nh, 9);
      g.fillStyle = LANE_COLORS[n.lane]; g.fill();
      g.lineWidth = 3; g.strokeStyle = '#23324a'; g.stroke();
      g.globalAlpha = 1;
    }
    for (const r of s.rings) {
      const cx = r.lane * lw + lw / 2, k = r.t / 0.35;
      g.beginPath(); g.arc(cx, hitY, 18 + k * 30, 0, Math.PI * 2);
      g.strokeStyle = hexA('#ffffff', 1 - k); g.lineWidth = 4; g.stroke();
    }
    // count-in
    if (s.phase === 'play' && tNow < 0) {
      const n = Math.floor(tNow / s.spb) + s.countIn + 1;
      if (n >= 1 && n <= s.countIn) {
        g.font = '900 64px Rubik, system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 6; g.strokeStyle = '#23324a'; g.fillStyle = '#ffffff';
        g.strokeText(String(n), w / 2, h * 0.38); g.fillText(String(n), w / 2, h * 0.38);
      }
    }
  }

  function finish(quit) {
    const s = S;
    if (!s || s.phase !== 'play') return;
    s.frozenT = heard();
    s.phase = 'card';
    clearInterval(s.timer);
    const acc = s.notes.length ? s.hits / s.notes.length : 0;
    const ok = !quit && acc >= s.pass;
    const grade = acc >= 0.95 ? 'S' : acc >= 0.85 ? 'A' : acc >= 0.72 ? 'B' : acc >= s.pass ? 'C' : 'D';
    s.result = { ok, score: s.score, accuracy: +acc.toFixed(3), hits: s.hits, perfect: s.perfect, misses: s.notes.length - s.hits,
      total: s.notes.length, maxCombo: s.maxCombo, grade, tries: s.tries + 1, quit: false };
    synth.play(ok ? 'win' : 'fail');
    const pct = Math.round(acc * 100), need = Math.round(s.pass * 100);
    if (ok) {
      s.closeCard = showCard(ov().root, {
        title: t('mg.rhythm.passTitle'), big: grade,
        lines: [t('mg.rhythm.summary', { pct, need, combo: s.maxCombo }), t('mg.rhythm.scoreLine', { score: s.score })],
        buttons: [{ label: t('mg.ui.continue'), key: ['Enter', 'Space', 'KeyF'], onClick: () => end(s.result) }],
      });
      if (s.cfg.autoplay || s.cfg.autoContinue) setTimeout(() => s.closeCard && s.closeCard.fire && S === s && s.closeCard.fire(0), 600);
    } else {
      const assistNext = s.tries + 1 >= 2;
      s.closeCard = showCard(ov().root, {
        title: t(quit ? 'mg.ui.paused' : 'mg.rhythm.failTitle'),
        big: quit ? '' : `${pct}%`,
        lines: [t(s.cfg.failLine || 'mg.rhythm.failLine'), quit ? '' : t('mg.rhythm.need', { need }), assistNext ? t('mg.rhythm.assist') : ''].filter(Boolean),
        buttons: [
          { label: t('mg.ui.retry'), key: ['Enter', 'Space', 'KeyF'], onClick: () => { s.tries++; begin(); } },
          { label: t('mg.ui.quit'), key: ['Escape'], alt: true, onClick: () => end({ ...s.result, ok: false, quit: true }) },
        ],
      });
    }
  }

  function end(result) {
    const s = S;
    if (!s) return;
    teardown();
    s.resolve(result);
  }

  function teardown() {
    const s = S;
    if (!s) return;
    S = null;
    clearInterval(s.timer);
    if (s.closeCard) s.closeCard();
    s.offKeys();
    window.removeEventListener('resize', s.onResize);
    s.ov.remove();
  }

  function cancel() {
    const s = S;
    if (!s) return;
    teardown();
    s.resolve({ ok: false, cancelled: true, score: s.score || 0, accuracy: 0, tries: s.tries });
  }

  return {
    start, update, cancel,
    get active() { return !!S; },
    // D F J K would also steer the player: the quest system freezes the player while this is true.
    get blocksPlayer() { return !!S; },
    debug: {
      press: (lane) => press(lane),
      state: () => (S ? { phase: S.phase, clock: S.clock, t: S.phase === 'play' ? heard() : S.frozenT, hits: S.hits, misses: S.misses, total: S.notes.length, window: S.window, tries: S.tries } : null),
      card: (i = 0) => S && S.closeCard && S.closeCard.fire && S.closeCard.fire(i),
    },
  };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`;
}
