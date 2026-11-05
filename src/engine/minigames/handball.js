// Handball at Maccabi House (round 10, docs/ROUND10_HANDBALL.md): a top-down arcade match on a
// canvas, four court players and a keeper a side so the court stays readable. The player runs the
// Rishonim Stars: the ball carrier in attack, the defender nearest the ball in defence.
//
//   const r = await games.handball.start({ opponent: 'kiryat_ganim', level: 1, seconds: 150, mustWin: true });
//   // r = { ok, score (our goals), them, won } | { ok: false, quit: true }
//
// Keys: arrows/WASD run, Space pass, Enter/K shoot (the marker sweeping the goal mouth is the aim),
// Q switch defender. Pointer: press the court to run there, a team-mate to pass, the goal to shoot.
// Rules, kept simple: court players stay out of both 6 m areas, a ball over a line goes to the
// other side, the side that let a goal in restarts from the centre, and a draw at full time goes
// to a golden goal. Text: data/minigames/handball.<lang>.json, registered under `hb`.
import { createOverlay, addStyle, textFn, clamp, toaster, keyListener, showCard } from './common.js';
import { getSynth } from './synth.js';
import { i18n, register } from '../../i18n.js';

let stringsP = null;
export function loadHandballStrings(base = new URL('../../../data/minigames/', import.meta.url).href) {
  if (stringsP) return stringsP;
  const get = (lang) => fetch(`${base}handball.${lang}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`handball.${lang}.json: HTTP ${r.status}`))));
  stringsP = (async () => {
    const fallback = await get('en').catch((e) => { console.warn('[handball] no English strings', e.message); return {}; });
    const active = i18n.lang === 'en' ? fallback : await get(i18n.lang).catch(() => null);
    register('hb', active || fallback, fallback);
  })();
  return stringsP;
}

// ---- court geometry, in metres (a real court is 40 x 20) ----
const CL = 40, CW = 20, GY0 = 8.5, GY1 = 11.5, ZONE = 6, SEVEN = 9;
const S = 16, MX = 40, MY = 40, W = CL * S + MX * 2, H = CW * S + MY * 2; // canvas px
const PR = 0.55; // player radius (m)
const TEAMS = {
  // Fictional teams on real Rishon neighbourhood names (OSM place=suburb, checked 2026-11-05).
  rishonim: { color: '#2e86de', gk: '#ffcb3d' },
  kiryat_ganim: { color: '#8e5b3a', gk: '#7fe0d6' },
  neve_hof: { color: '#16a99c', gk: '#ffb347' },
  ramat_eliyahu: { color: '#7a4dbb', gk: '#7fe0d6' },
  neot_eshelim: { color: '#ef7d1a', gk: '#7fe0d6' },
  nahalat_yehuda: { color: '#d7263d', gk: '#7fe0d6' },
};
const ROLES = ['gk', 'lw', 'lb', 'rb', 'rw'];

const CSS = `
.mg-hb .hb-main { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(760px, calc(100vw - 16px)); text-align: center; pointer-events: auto; }
.mg-hb .hb-top { display: flex; justify-content: center; gap: 10px; align-items: center; font-weight: 900; font-size: 16px; margin-bottom: 6px; }
.mg-hb canvas { width: 100%; height: auto; display: block; border: 2px solid #23324a; border-radius: 10px; background: #e8b77a; touch-action: none; }
.mg-hb .hb-hint { margin-top: 6px; font-weight: 700; font-size: 12px; opacity: 0.85; min-height: 16px; }
`;

const goalXFor = (team) => (team === 0 ? CL : 0); // the goal a team attacks
const ownGoalX = (team) => (team === 0 ? 0 : CL);
const fwd = (team) => (team === 0 ? 1 : -1);

// Closest point of a goal mouth (a segment on the goal line) to (x, y).
function mouthPoint(gx, x, y) { return [gx, clamp(y, GY0, GY1)]; }
function inZone(gx, x, y, r = ZONE) { const [mx, my] = mouthPoint(gx, x, y); return Math.hypot(x - mx, y - my) < r; }
// Push a court player out of both 6 m areas.
function keepOut(p) {
  for (const gx of [0, CL]) {
    const [mx, my] = mouthPoint(gx, p.x, p.y), dx = p.x - mx, dy = p.y - my, d = Math.hypot(dx, dy);
    if (d < ZONE + PR * 0.4) {
      const k = (ZONE + PR * 0.4) / (d || 1e-3);
      p.x = mx + (d > 1e-3 ? dx : (gx === 0 ? 1 : -1)) * k; p.y = my + (d > 1e-3 ? dy : 0) * k;
    }
  }
}

export function createHandball(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  addStyle('mg-style-hb', CSS);
  loadHandballStrings();
  let M = null; // the running match

  function teamName(id) { return t(`hb.teams.${id}`); }

  async function start(config = {}) {
    if (M) cancel();
    await loadHandballStrings();
    return new Promise((resolve) => {
      const cfg = { opponent: 'kiryat_ganim', level: 1, seconds: 150, mustWin: false, ...config };
      // Free play meets a different side each time.
      if (cfg.opponent === 'random') { const ids = Object.keys(TEAMS).filter((k) => k !== 'rishonim'); cfg.opponent = ids[Math.floor(Math.random() * ids.length)]; }
      const ov = createOverlay('mg-hb', '<div class="mg-panel hb-main"><div class="hb-top"><span class="hb-stat mg-num"></span></div><canvas></canvas><div class="hb-hint"></div></div>');
      const cv = ov.$('canvas');
      const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d');
      g.scale(dpr, dpr);
      ov.$('.hb-hint').textContent = t('hb.keys');
      const m = { cfg, ov, cv, g, resolve, phase: 'intro', time: 0, clock: cfg.seconds, golden: false, score: [0, 0], toast: toaster(ov.root), held: new Set(), pause: 0, ctrl: null, moveTo: null, lastTouch: 0, pressT: 0 };
      m.lv = clamp(cfg.level | 0, 1, 5);
      m.names = [teamName('rishonim'), teamName(cfg.opponent)];
      m.cols = [TEAMS.rishonim, TEAMS[cfg.opponent] || TEAMS.kiryat_ganim];
      M = m;
      setup(m, 1); // the visitors open
      const local = (e) => { const r = cv.getBoundingClientRect(); return [(((e.clientX - r.left) / r.width) * W - MX) / S, (((e.clientY - r.top) / r.height) * H - MY) / S]; };
      cv.addEventListener('pointerdown', (e) => { e.preventDefault(); if (m.phase === 'play') { m.pointerDown = true; pointer(m, ...local(e), 'down'); } });
      cv.addEventListener('pointermove', (e) => { if (m.phase === 'play' && m.pointerDown) pointer(m, ...local(e), 'move'); });
      const upP = () => { m.pointerDown = false; m.moveTo = null; };
      cv.addEventListener('pointerup', upP); cv.addEventListener('pointercancel', upP); cv.addEventListener('pointerleave', upP);
      m.offKeys = keyListener((e) => {
        if (M !== m || e.type !== 'keydown') return;
        if (e.code === 'Escape' && m.phase !== 'done') { e.preventDefault(); e.stopPropagation(); finish({ ok: false, quit: true }); return; }
        if (m.phase !== 'play' || e.repeat) return;
        if (e.code === 'Space') { pass(m); e.preventDefault(); e.stopPropagation(); }
        else if (e.code === 'Enter' || e.code === 'KeyK' || e.code === 'NumpadEnter') { shootCtrl(m); e.preventDefault(); e.stopPropagation(); }
        else if (e.code === 'KeyQ') { switchCtrl(m, true); e.preventDefault(); e.stopPropagation(); }
      });
      m.offUp = (() => {
        const dn = (e) => m.held.add(e.code), up = (e) => m.held.delete(e.code);
        window.addEventListener('keydown', dn, true); window.addEventListener('keyup', up, true);
        return () => { window.removeEventListener('keydown', dn, true); window.removeEventListener('keyup', up, true); };
      })();
      stat(m);
      draw(m);
      const lines = [t('hb.how'), t('hb.vs', { a: m.names[0], b: m.names[1] })];
      m.card = showCard(ov.root, { title: t('hb.title'), lines, buttons: [{ label: t('hb.ui.start'), key: ['Enter', 'Space'], onClick: () => { m.card = null; m.phase = 'play'; synth.play('go'); m.toast(t('hb.whistle'), 900); } }, { label: t('hb.ui.later'), key: 'Escape', alt: true, onClick: () => finish({ ok: false, quit: true }) }] });
    });
  }

  // ---------- setup and restarts ----------
  function setup(m, kickTeam) {
    m.players = [];
    for (const team of [0, 1]) for (let i = 0; i < 5; i++) {
      const role = ROLES[i];
      m.players.push({ team, role, num: [1, 7, 9, 11, 5][i] + team * 10, x: 0, y: 0, vx: 0, vy: 0, react: 0, hold: 0 });
    }
    kickoff(m, kickTeam);
  }
  function kickoff(m, team) {
    for (const p of m.players) {
      const [x, y] = p.role === 'gk' ? [ownGoalX(p.team) + fwd(p.team) * 0.8, CW / 2] : kickSpot(p);
      p.x = x; p.y = y; p.vx = p.vy = 0; p.react = 0;
    }
    const carrier = m.players.find((p) => p.team === team && p.role === 'lb');
    carrier.x = CL / 2 - fwd(team) * 0.6; carrier.y = CW / 2;
    m.ball = { state: 'held', holder: carrier, x: carrier.x, y: carrier.y, h: 0 };
    m.lastTouch = team;
    m.aiT = 0.8; m.pressT = 0;
    m.ctrl = team === 0 ? carrier : nearestOf(m, 0, carrier.x, carrier.y);
  }
  function kickSpot(p) {
    const f = fwd(p.team), mid = CL / 2;
    const slot = { lw: [mid - f * 4, 3], lb: [mid - f * 2, 7], rb: [mid - f * 2, 13], rw: [mid - f * 4, 17] }[p.role];
    return slot;
  }
  const court = (m, team) => m.players.filter((p) => p.team === team && p.role !== 'gk');
  const keeper = (m, team) => m.players.find((p) => p.team === team && p.role === 'gk');
  function nearestOf(m, team, x, y, skip = null) {
    let best = null, bd = 1e9;
    for (const p of court(m, team)) { if (p === skip) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    return best;
  }
  const holderTeam = (m) => (m.ball.state === 'held' ? m.ball.holder.team : null);

  // ---------- the player's actions ----------
  function switchCtrl(m, force) {
    if (holderTeam(m) === 0) return;
    const b = m.ball, n = nearestOf(m, 0, b.x, b.y);
    if (!m.ctrl || force || (n !== m.ctrl && Math.hypot(m.ctrl.x - b.x, m.ctrl.y - b.y) > Math.hypot(n.x - b.x, n.y - b.y) + 3)) {
      if (force && n === m.ctrl) { const o = nearestOf(m, 0, b.x, b.y, m.ctrl); if (o) m.ctrl = o; } else m.ctrl = n;
    }
  }
  // Pass to the team-mate who best fits the run direction (or the one asked for).
  function pass(m, to = null) {
    const b = m.ball;
    if (b.state !== 'held' || b.holder.team !== 0) return;
    const c = b.holder;
    let target = to;
    if (!target) {
      const dx = m.dir ? m.dir[0] : 1, dy = m.dir ? m.dir[1] : 0;
      let best = -1e9;
      for (const p of court(m, 0)) {
        if (p === c) continue;
        const vx = p.x - c.x, vy = p.y - c.y, d = Math.hypot(vx, vy) || 1;
        const open = Math.min(...court(m, 1).map((o) => Math.hypot(o.x - p.x, o.y - p.y)));
        const score = ((vx * dx + vy * dy) / d) * 2 + Math.min(open, 4) * 0.5 - d * 0.05;
        if (score > best) { best = score; target = p; }
      }
    }
    if (target) throwBall(m, c, target.x + target.vx * 0.25, target.y + target.vy * 0.25, 'pass');
  }
  function aimY(m) { return CW / 2 + 1.42 * Math.sin(m.time * 2.6); }
  function shootCtrl(m, y = null) {
    const b = m.ball;
    if (b.state !== 'held' || b.holder.team !== 0) return;
    throwBall(m, b.holder, CL, y == null ? aimY(m) : clamp(y, GY0 + 0.15, GY1 - 0.15), 'shot');
  }
  function pointer(m, x, y, kind) {
    const b = m.ball;
    if (kind === 'down' && b.state === 'held' && b.holder.team === 0) {
      const mate = court(m, 0).find((p) => p !== b.holder && Math.hypot(p.x - x, p.y - y) < 1.4);
      if (mate) { pass(m, mate); return; }
      if (x > CL - 3.5 && Math.abs(y - CW / 2) < 4) { shootCtrl(m, y); return; }
    }
    m.moveTo = [clamp(x, 0.3, CL - 0.3), clamp(y, 0.3, CW - 0.3)];
  }

  // ---------- the ball ----------
  function throwBall(m, from, tx, ty, kind) {
    const b = m.ball, lv = m.lv;
    const dist = Math.hypot(tx - from.x, ty - from.y);
    let ex = tx, ey = ty;
    if (kind === 'shot') {
      // Spread grows with distance; the visitors get steadier with the level.
      const spread = (from.team === 0 ? 0.12 : 0.28 - lv * 0.03) + dist * 0.025;
      ey = ty + (Math.random() * 2 - 1) * spread;
    } else if (from.team === 1) {
      const miss = (0.9 - lv * 0.15) * (Math.random() * 2 - 1);
      ey += miss; ex += miss * 0.5;
    }
    const sp = kind === 'shot' ? 21 + (from.team === 1 ? lv : 2) : 15;
    const dx = ex - from.x, dy = ey - from.y, d = Math.hypot(dx, dy) || 1;
    Object.assign(b, { state: 'air', holder: null, kind, team: from.team, x: from.x, y: from.y, vx: (dx / d) * sp, vy: (dy / d) * sp, h: 0.5, t: 0, T: d / sp, checked: new Set([from]), from });
    m.lastTouch = from.team;
    synth.play(kind === 'shot' ? 'bump' : 'tick');
    if (kind === 'shot') {
      const gk = keeper(m, 1 - from.team);
      gk.react = from.team === 0 ? 0.3 - lv * 0.03 : 0.24 + Math.random() * 0.1;
      // Where the ball will cross the goal line.
      const gx = goalXFor(from.team), tt = (gx - from.x) / ((dx / d) * sp);
      gk.aim = from.y + (dy / d) * sp * Math.max(0, tt);
    }
  }
  function giveTo(m, p) {
    const b = m.ball;
    Object.assign(b, { state: 'held', holder: p, h: 0 });
    p.hold = 0;
    m.lastTouch = p.team;
    if (p.team === 0 && p.role !== 'gk') m.ctrl = p;
    if (p.team === 1) m.aiT = 0.6 + Math.random() * 0.6;
  }
  // Over a line: the other side throws in from the nearest point (their keeper for a goal line).
  function outOfPlay(m) {
    const b = m.ball, team = 1 - m.lastTouch;
    m.toast(t('hb.out'), 700);
    if (b.x <= 0 || b.x >= CL) { const gk = keeper(m, team); giveTo(m, gk); return; }
    const p = nearestOf(m, team, b.x, b.y);
    p.x = clamp(b.x, 0.5, CL - 0.5); p.y = clamp(b.y, 0.4, CW - 0.4); keepOut(p);
    giveTo(m, p);
  }
  function goal(m, team) {
    m.score[team]++;
    synth.play(team === 0 ? 'win' : 'bump');
    m.toast(t(team === 0 ? 'hb.goal' : 'hb.theyScore'), 1300);
    m.pause = 1.6; m.after = () => { if (m.golden) { end(m); return; } kickoff(m, 1 - team); };
    m.ball.state = 'dead';
    stat(m);
  }

  function updateBall(m, dt) {
    const b = m.ball;
    if (b.state === 'held') { const p = b.holder; b.x = p.x + fwd(p.team) * 0.45; b.y = p.y; b.h = 0; return; }
    if (b.state === 'dead') return;
    if (b.state === 'air') {
      b.t += dt; b.x += b.vx * dt; b.y += b.vy * dt;
      b.h = 0.5 + Math.sin(Math.min(1, b.t / Math.max(0.2, b.T)) * Math.PI) * (b.kind === 'pass' ? 0.9 : 0.4);
      // Interceptions: each opponent gets one chance per throw when the ball passes close.
      if (b.kind === 'pass') for (const p of m.players) {
        if (p.team === b.team || p.role === 'gk' || b.checked.has(p)) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < 0.75) {
          b.checked.add(p);
          const chance = p.team === 0 ? (p === m.ctrl ? 0.7 : 0.3) : 0.18 + m.lv * 0.06;
          if (Math.random() < chance) { giveTo(m, p); synth.play('coin'); m.toast(t('hb.intercept'), 700); return; }
        }
      }
      // A pass is caught by the first team-mate it reaches.
      if (b.kind === 'pass') for (const p of court(m, b.team)) {
        if (p === b.from) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < 0.9) { giveTo(m, p); return; }
      }
      // A shot meets the goal line: the keeper, the net or the wall.
      if (b.kind === 'shot') {
        const gx = goalXFor(b.team);
        if ((b.team === 0 && b.x >= gx) || (b.team === 1 && b.x <= gx)) {
          const gk = keeper(m, 1 - b.team), y = b.y;
          const reach = b.team === 0 ? 0.72 + m.lv * 0.07 : 0.6;
          const corner = Math.min(Math.abs(y - GY0), Math.abs(y - GY1)) < 0.4;
          if (y >= GY0 && y <= GY1) {
            if (Math.abs(gk.y - y) < reach * (corner ? 0.75 : 1)) { m.toast(t('hb.saved'), 800); synth.play('tick'); giveTo(m, gk); return; }
            goal(m, b.team); return;
          }
          outOfPlay(m); return;
        }
      }
      if (b.kind === 'pass' && b.t > b.T + 0.15) { b.state = 'loose'; b.vx *= 0.5; b.vy *= 0.5; }
    }
    if (b.state === 'loose') {
      b.x += b.vx * dt; b.y += b.vy * dt; b.h = Math.max(0, b.h - dt * 2);
      const f = Math.max(0, 1 - dt * 2.2); b.vx *= f; b.vy *= f;
      for (const p of m.players) {
        if (Math.hypot(p.x - b.x, p.y - b.y) < 0.8) { if (p.role === 'gk' && !inZone(ownGoalX(p.team), b.x, b.y, ZONE + 0.8)) continue; giveTo(m, p); return; }
      }
      // A ball rolling into a 6 m area belongs to its keeper.
      for (const team of [0, 1]) if (inZone(ownGoalX(team), b.x, b.y) && Math.hypot(b.vx, b.vy) < 1.5) { giveTo(m, keeper(m, team)); return; }
    }
    if (b.x < 0 || b.x > CL || b.y < 0 || b.y > CW) outOfPlay(m);
  }

  // ---------- movement ----------
  function steer(p, tx, ty, vmax, dt) {
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
    const want = d < 0.05 ? 0 : Math.min(vmax, d * 3);
    const wx = d > 1e-3 ? (dx / d) * want : 0, wy = d > 1e-3 ? (dy / d) * want : 0;
    const k = Math.min(1, dt * 9);
    p.vx += (wx - p.vx) * k; p.vy += (wy - p.vy) * k;
  }
  // Attack slots near the 9 m line of the goal a team attacks, swaying a little so they look alive.
  function attackSlot(m, p) {
    const gx = goalXFor(p.team), f = fwd(p.team), sw = Math.sin(m.time * 1.3 + p.num) * 0.8;
    const s = { lw: [gx - f * 1.6, 1.4 + sw * 0.3], lb: [gx - f * (SEVEN + 1.2), 6.2 + sw], rb: [gx - f * (SEVEN + 1.2), 13.8 - sw], rw: [gx - f * 1.6, 18.6 - sw * 0.3] }[p.role];
    return s;
  }
  // Defence: four slots on the 6 m line, shifted toward the ball.
  function defendSlot(m, p) {
    const gx = ownGoalX(p.team), f = fwd(p.team), shift = clamp((m.ball.y - CW / 2) * 0.35, -3, 3);
    const ang = { lw: -1.0, lb: -0.34, rb: 0.34, rw: 1.0 }[p.role] * (p.team === 0 ? 1 : -1);
    const r = ZONE + 0.9;
    return [gx + f * Math.cos(ang) * r, clamp(CW / 2 + Math.sin(ang) * r * 1.15 + shift, 1, CW - 1)];
  }
  function keeperMove(m, p, dt) {
    const gx = ownGoalX(p.team), f = fwd(p.team), b = m.ball;
    let ty = clamp(b.y, GY0 + 0.3, GY1 - 0.3), sp = p.team === 0 ? 6 : 5.4 + m.lv * 0.4;
    if (b.state === 'air' && b.kind === 'shot' && b.team !== p.team) {
      p.react -= dt;
      if (p.react > 0) ty = p.y; else { ty = clamp(p.aim ?? b.y, GY0 - 0.2, GY1 + 0.2); sp *= 1.5; }
    }
    steer(p, gx + f * 0.7, ty, sp, dt);
    // The keeper holding the ball throws it out to a free court player.
    if (b.state === 'held' && b.holder === p) {
      p.hold += dt;
      if (p.hold > (p.team === 0 ? 0.8 : 1.1)) {
        const mates = court(m, p.team).filter((q) => Math.min(...court(m, 1 - p.team).map((o) => Math.hypot(o.x - q.x, o.y - q.y))) > 1.5);
        const to = (mates.length ? mates : court(m, p.team)).sort((a, c) => Math.abs(a.x - CL / 2) - Math.abs(c.x - CL / 2))[0];
        throwBall(m, p, to.x, to.y, 'pass');
      }
    }
  }

  function tick(m, dt) {
    if (m.pause > 0) { m.pause -= dt; if (m.pause <= 0 && m.after) { const a = m.after; m.after = null; a(); } return; }
    if (!m.golden) {
      m.clock -= dt;
      if (m.clock <= 0) {
        m.clock = 0;
        if (m.score[0] !== m.score[1]) { end(m); return; }
        m.golden = true; m.toast(t('hb.golden'), 2200); synth.play('go');
      }
    }
    const lv = m.lv, b = m.ball;
    switchCtrl(m, false);
    // The player's man.
    const c = m.ctrl;
    let ix = 0, iy = 0;
    if (m.held.has('ArrowLeft') || m.held.has('KeyA')) ix -= 1;
    if (m.held.has('ArrowRight') || m.held.has('KeyD')) ix += 1;
    if (m.held.has('ArrowUp') || m.held.has('KeyW')) iy -= 1;
    if (m.held.has('ArrowDown') || m.held.has('KeyS')) iy += 1;
    if (ix || iy) { const l = Math.hypot(ix, iy); m.dir = [ix / l, iy / l]; m.moveTo = null; }
    for (const p of m.players) {
      if (p.role === 'gk') { keeperMove(m, p, dt); continue; }
      if (p === c) {
        const vmax = b.state === 'held' && b.holder === p ? 6.4 : 7.0;
        if (ix || iy) steer(p, p.x + m.dir[0] * 3, p.y + m.dir[1] * 3, vmax, dt);
        else if (m.moveTo) { steer(p, m.moveTo[0], m.moveTo[1], vmax, dt); const dx = m.moveTo[0] - p.x, dy = m.moveTo[1] - p.y, d = Math.hypot(dx, dy); if (d > 0.3) m.dir = [dx / d, dy / d]; }
        else steer(p, p.x, p.y, vmax, dt);
        continue;
      }
      const vmax = p.team === 1 ? 4.9 + lv * 0.35 : 5.6;
      if (b.state === 'held' && b.holder === p) { aiCarrier(m, p, dt); continue; }
      if (b.state === 'loose' && p === nearestOf(m, p.team, b.x, b.y)) { steer(p, b.x, b.y, vmax, dt); continue; }
      // Read the holder per player: an earlier carrier in this loop may just have thrown.
      const ht = holderTeam(m);
      if (ht === p.team) { const [x, y] = attackSlot(m, p); steer(p, x, y, vmax, dt); continue; }
      // Defending: the nearest marks the carrier, the rest hold their slot.
      if (ht === 1 - p.team && p === nearestOf(m, p.team, b.x, b.y)) {
        const h = b.holder, gx = ownGoalX(p.team);
        const dx = gx - h.x, dy = CW / 2 - h.y, d = Math.hypot(dx, dy) || 1;
        steer(p, h.x + (dx / d) * 0.95, h.y + (dy / d) * 0.95, vmax, dt);
        continue;
      }
      const [x, y] = defendSlot(m, p); steer(p, x, y, vmax, dt);
    }
    for (const p of m.players) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.x = clamp(p.x, 0.3, CL - 0.3); p.y = clamp(p.y, 0.3, CW - 0.3);
      if (p.role !== 'gk') keepOut(p);
      else { const gx = ownGoalX(p.team); if (!inZone(gx, p.x, p.y, ZONE - 0.3)) { const [mx, my] = mouthPoint(gx, p.x, p.y), dx = p.x - mx, dy = p.y - my, d = Math.hypot(dx, dy) || 1; p.x = mx + (dx / d) * (ZONE - 0.3); p.y = my + (dy / d) * (ZONE - 0.3); } }
    }
    // Bodies keep apart.
    const ps = m.players;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], o = ps[j], dx = o.x - a.x, dy = o.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < PR * 2) { const k = (PR * 2 - d) / 2 / d; a.x -= dx * k; a.y -= dy * k; o.x += dx * k; o.y += dy * k; }
    }
    // Steals: pressing the carrier for a moment can win the ball.
    if (b.state === 'held' && b.holder.role !== 'gk') {
      const h = b.holder, def = nearestOf(m, 1 - h.team, h.x, h.y);
      if (def && Math.hypot(def.x - h.x, def.y - h.y) < 1.25) {
        m.pressT += dt;
        if (m.pressT > 0.4) {
          m.pressT = 0;
          const chance = h.team === 1 ? (def === m.ctrl ? 0.3 - lv * 0.04 : 0.05) : 0.06 + lv * 0.06;
          if (Math.random() < chance) { giveTo(m, def); synth.play('coin'); m.toast(t(h.team === 1 ? 'hb.steal' : 'hb.lost'), 700); }
        }
      } else m.pressT = 0;
    }
    updateBall(m, dt);
    stat(m);
  }

  // The visitors' carrier: run at the goal, pass when pressed or when a mate is free, shoot in range.
  function aiCarrier(m, p, dt) {
    const lv = m.lv, gx = goalXFor(p.team), f = fwd(p.team);
    p.hold += dt; m.aiT -= dt;
    const dGoal = Math.hypot(gx - p.x, CW / 2 - p.y);
    const press = Math.min(...court(m, 1 - p.team).map((o) => Math.hypot(o.x - p.x, o.y - p.y)));
    // Aim for the 9 m line in front of the goal, drifting toward open space.
    const ty = clamp(p.y + Math.sin(m.time * 0.9 + p.num) * 3, 3, CW - 3);
    steer(p, gx - f * (SEVEN - 0.5), ty, 4.6 + lv * 0.3, dt);
    if (m.aiT > 0) return;
    m.aiT = 0.35 + Math.random() * (0.7 - lv * 0.06);
    if (dGoal < SEVEN + 2.5 + lv * 0.3 && Math.random() < 0.45 + lv * 0.08) {
      const y = Math.random() < 0.3 + lv * 0.1 ? (Math.random() < 0.5 ? GY0 + 0.25 : GY1 - 0.25) : GY0 + Math.random() * (GY1 - GY0);
      throwBall(m, p, gx, y, 'shot');
      return;
    }
    if (press < 1.6 || p.hold > 2.6 - lv * 0.2 || Math.random() < 0.25) {
      const mates = court(m, p.team).filter((q) => q !== p);
      let best = null, bs = -1e9;
      for (const q of mates) {
        const open = Math.min(...court(m, 1 - p.team).map((o) => Math.hypot(o.x - q.x, o.y - q.y)));
        const s = open + (f * (q.x - p.x)) * 0.15 + Math.random() * 1.5;
        if (s > bs) { bs = s; best = q; }
      }
      if (best) throwBall(m, p, best.x + best.vx * 0.3, best.y + best.vy * 0.3, 'pass');
    }
  }

  // ---------- display ----------
  function clockText(m) {
    if (m.golden) return t('hb.goldenShort');
    const s = Math.ceil(m.clock), mm = Math.floor(s / 60), ss = s % 60;
    return `${mm}:${ss < 10 ? '0' : ''}${ss}`;
  }
  function stat(m) { m.ov.$('.hb-stat').textContent = t('hb.stat', { a: m.names[0], x: m.score[0], y: m.score[1], b: m.names[1], t: clockText(m) }); }

  function draw(m) {
    const g = m.g, X = (x) => MX + x * S, Y = (y) => MY + y * S;
    g.direction = 'ltr'; // shirt numbers read the same in a Hebrew page
    g.fillStyle = '#d9a46a'; g.fillRect(0, 0, W, H);
    // parquet
    g.fillStyle = '#e8b77a'; g.fillRect(X(0), Y(0), CL * S, CW * S);
    g.strokeStyle = 'rgba(160, 100, 50, 0.18)'; g.lineWidth = 1;
    for (let y = 0; y <= CW; y += 1) { g.beginPath(); g.moveTo(X(0), Y(y)); g.lineTo(X(CL), Y(y)); g.stroke(); }
    // 6 m areas, 9 m dashed lines, 7 m marks
    for (const gx of [0, CL]) {
      const f = gx === 0 ? 1 : -1;
      // A capsule of radius r around the goal mouth: quarter circle, straight, quarter circle.
      const capsule = (r) => {
        g.beginPath();
        g.moveTo(X(gx), Y(GY0 - r));
        if (f > 0) { g.arc(X(gx), Y(GY0), r * S, -Math.PI / 2, 0); g.lineTo(X(gx + r), Y(GY1)); g.arc(X(gx), Y(GY1), r * S, 0, Math.PI / 2); }
        else { g.arc(X(gx), Y(GY0), r * S, -Math.PI / 2, -Math.PI, true); g.lineTo(X(gx - r), Y(GY1)); g.arc(X(gx), Y(GY1), r * S, Math.PI, Math.PI / 2, true); }
      };
      g.save();
      g.beginPath(); g.rect(X(0), Y(0), CL * S, CW * S); g.clip();
      capsule(ZONE); g.closePath();
      g.fillStyle = '#5b9bd5'; g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
      g.setLineDash([7, 6]); capsule(SEVEN); g.stroke(); g.setLineDash([]);
      g.restore();
      g.fillStyle = '#fff'; g.fillRect(X(gx + f * 7) - 1, Y(CW / 2) - 6, 2, 12);
      // the goal and its net
      g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(f > 0 ? X(gx) - 22 : X(gx), Y(GY0), 22, (GY1 - GY0) * S);
      g.strokeStyle = 'rgba(35,50,74,0.35)'; g.lineWidth = 1;
      for (let k = 0; k <= 6; k++) { const yy = Y(GY0) + (k / 6) * (GY1 - GY0) * S; g.beginPath(); g.moveTo(X(gx), yy); g.lineTo(X(gx) - f * 22, yy); g.stroke(); }
      for (let k = 0; k <= 4; k++) { const xx = X(gx) - f * k * 5.5; g.beginPath(); g.moveTo(xx, Y(GY0)); g.lineTo(xx, Y(GY1)); g.stroke(); }
      g.fillStyle = '#e8364f';
      for (let k = 0; k < 6; k++) g.fillRect(X(gx) - 3, Y(GY0) + k * (GY1 - GY0) * S / 6, 6, (GY1 - GY0) * S / 12);
    }
    g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.strokeRect(X(0), Y(0), CL * S, CW * S);
    g.beginPath(); g.moveTo(X(CL / 2), Y(0)); g.lineTo(X(CL / 2), Y(CW)); g.stroke();
    g.beginPath(); g.arc(X(CL / 2), Y(CW / 2), 2 * S, 0, Math.PI * 2); g.stroke();
    // the aim marker on their goal while our carrier is in range
    const b = m.ball;
    if (m.phase === 'play' && b.state === 'held' && b.holder.team === 0 && b.holder.x > CL - 14) {
      const ay = aimY(m);
      g.strokeStyle = '#23324a'; g.lineWidth = 2; g.fillStyle = 'rgba(255, 203, 61, 0.9)';
      g.beginPath(); g.arc(X(CL), Y(ay), 6, 0, Math.PI * 2); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(35,50,74,0.35)'; g.setLineDash([4, 5]); g.beginPath(); g.moveTo(X(b.holder.x), Y(b.holder.y)); g.lineTo(X(CL), Y(ay)); g.stroke(); g.setLineDash([]);
    }
    // players
    for (const p of m.players) {
      const col = p.role === 'gk' ? m.cols[p.team].gk : m.cols[p.team].color;
      g.fillStyle = 'rgba(35,50,74,0.25)'; g.beginPath(); g.ellipse(X(p.x) + 2, Y(p.y) + 3, PR * S, PR * S * 0.7, 0, 0, Math.PI * 2); g.fill();
      if (p === m.ctrl) { g.strokeStyle = '#ffcb3d'; g.lineWidth = 4; g.beginPath(); g.arc(X(p.x), Y(p.y), PR * S + 4, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = col; g.strokeStyle = '#23324a'; g.lineWidth = 2;
      g.beginPath(); g.arc(X(p.x), Y(p.y), PR * S, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = p.role === 'gk' ? '#23324a' : '#fff'; g.font = '900 9px Rubik, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(p.num), X(p.x), Y(p.y) + 0.5);
    }
    // the ball, raised in flight with its shadow under it
    if (b.state !== 'dead') {
      const lift = b.h * S * 0.9;
      g.fillStyle = 'rgba(35,50,74,0.3)'; g.beginPath(); g.ellipse(X(b.x), Y(b.y) + 2, 4, 2.5, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffd23f'; g.strokeStyle = '#23324a'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(X(b.x), Y(b.y) - lift, 4.2, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }

  // ---------- flow ----------
  function end(m) {
    if (m.phase !== 'play') return;
    m.phase = 'done';
    const [us, them] = m.score, won = us > them;
    synth.play(won ? 'win' : 'bump');
    const res = { ok: m.cfg.mustWin ? won : true, score: us, them, won };
    m.card = showCard(m.ov.root, {
      title: t(won ? 'hb.win' : 'hb.loss'),
      big: `${us} : ${them}`,
      lines: [t('hb.result', { a: m.names[0], b: m.names[1] }), t(won ? 'hb.lineWin' : m.cfg.mustWin ? 'hb.lineRetry' : 'hb.lineLoss')],
      buttons: [{ label: t('hb.ui.done'), key: ['Enter', 'Escape', 'Space'], onClick: () => finish(res) }],
    });
  }
  function update(dt) {
    const m = M;
    if (!m || dt <= 0) return;
    if (m.phase === 'play') {
      m.time += dt;
      // Fixed small steps keep the ball from tunnelling past a keeper on a slow frame.
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
      state: () => (M ? { phase: M.phase, clock: +M.clock.toFixed(1), score: M.score.slice(), golden: M.golden, ball: M.ball.state, holder: M.ball.holder ? `${M.ball.holder.team}:${M.ball.holder.role}` : null } : null),
      play: () => { if (M && M.card) { M.card(); M.card = null; } if (M) M.phase = 'play'; },
      // Test helpers: put a goal on the board, run the clock out.
      goal: (team = 0) => { if (M) { M.score[team]++; stat(M); } },
      clock: (s = 0) => { if (M) M.clock = s; },
      // The live match, for balance runs in tools.
      raw: () => M,
    },
  };
}
