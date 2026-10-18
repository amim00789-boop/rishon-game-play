// HUD: mode + controls, FPS, minimap, OSM attribution, and the quest layer (tracker, dialogue,
// talk prompt, banners). All text comes from i18n (data/i18n/<lang>.json); quest text arrives
// already resolved. Panels take the language's direction, so Hebrew reads right to left.
import { SCALE } from '../geo.js';
import { t, rich, dir, poiName } from '../i18n.js';

const MODE_KEYS = { walk: '1', scooter: '2', bike: '3', car: '4', skate: '5' };
const ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';

function el(tag, id, cls) { const e = document.createElement(tag); e.id = id; if (cls) e.className = cls; return e; }

const MAP_SIZE = 190;
const MAP_SCALE = 0.55; // minimap px per world unit

export class Hud {
  constructor() {
    this.mode = document.createElement('div');
    this.mode.id = 'hud-mode';
    this.mode.className = 'hud-panel';
    this.fps = document.createElement('div');
    this.fps.id = 'hud-fps';
    this.fps.className = 'hud-panel';
    this.mapWrap = document.createElement('div');
    this.mapWrap.id = 'hud-map';
    this.mapWrap.className = 'hud-panel';
    this.map = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.map.width = MAP_SIZE * dpr; this.map.height = MAP_SIZE * dpr;
    this.map.style.width = this.map.style.height = MAP_SIZE + 'px';
    this.dpr = dpr;
    this.mapWrap.appendChild(this.map);
    this.attrib = document.createElement('div');
    this.attrib.id = 'hud-attrib';
    const a = document.createElement('a');
    a.href = ATTRIBUTION_URL; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = t('hud.attribution');
    this.attrib.appendChild(a);
    this.toast = document.createElement('div');
    this.toast.id = 'hud-toast';
    this.toast.className = 'hud-panel';
    // Persistent clue card for the map-detective step: stays up while the map is closed.
    this.clues = el('div', 'hud-clues', 'hud-panel');
    this.clues.style.display = 'none';
    this.quest = el('div', 'hud-quest', 'hud-panel');
    this.quest.innerHTML = '<div class="hum"><span class="hum-label"></span><div class="hum-bar"><div class="hum-fill"></div></div></div>' +
      '<div class="q-title"></div><div class="q-text"></div><div class="q-meta"><span class="q-arrow">\u2191</span><span class="q-dist"></span><span class="q-prog"></span></div>';
    this.q = {
      humLabel: this.quest.querySelector('.hum-label'), humFill: this.quest.querySelector('.hum-fill'),
      title: this.quest.querySelector('.q-title'), text: this.quest.querySelector('.q-text'),
      arrow: this.quest.querySelector('.q-arrow'), dist: this.quest.querySelector('.q-dist'), prog: this.quest.querySelector('.q-prog'),
    };
    this.dialogue = el('div', 'hud-dialogue', 'hud-panel');
    this.dialogue.innerHTML = '<div class="who"></div><div class="line"></div><ol class="opts"></ol><div class="next"></div>';
    this.dialogue.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (this._dlgClick) this._dlgClick(); });
    this.prompt = el('div', 'hud-prompt', 'hud-panel');
    this.bannerEl = el('div', 'hud-banner', 'hud-panel');
    for (const e of [this.mode, this.attrib, this.toast, this.clues, this.quest, this.dialogue, this.prompt, this.bannerEl]) e.dir = dir();
    document.body.append(this.mode, this.fps, this.mapWrap, this.attrib, this.toast, this.clues, this.quest, this.dialogue, this.prompt, this.bannerEl);
    this.objective = null;
    this._objKey = '';
    this.base = null;
    this.pois = [];
    this.fpsAcc = 0; this.fpsN = 0; this.fpsValue = 0;
    this.mapTimer = 0;
  }

  // ---------- quest layer ----------
  onDialogueClick(fn) { this._dlgClick = fn; }
  onOptionClick(fn) { this._optClick = fn; }

  // options: labels for a tone choice, shown as a numbered list under the line (keys 1-3 or click).
  showDialogue({ speaker, text, hint, narrator, player, options = null }) {
    const d = this.dialogue;
    d.querySelector('.who').textContent = speaker || '';
    d.querySelector('.who').style.display = speaker ? '' : 'none';
    d.querySelector('.line').innerHTML = rich(text); // key caps ({k:D}) in tutorial lines
    d.querySelector('.next').innerHTML = rich(hint);
    const list = d.querySelector('.opts');
    list.innerHTML = '';
    list.style.display = options ? '' : 'none';
    (options || []).forEach((label, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<kbd dir="ltr">${i + 1}</kbd> ${rich(label)}`;
      li.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (this._optClick) this._optClick(i); });
      list.appendChild(li);
    });
    d.classList.toggle('narrator', !!narrator);
    d.classList.toggle('player', !!player);
    d.classList.add('on');
  }

  hideDialogue() { this.dialogue.classList.remove('on'); }

  setPrompt(text) {
    if (text === this._prompt) return;
    this._prompt = text;
    this.prompt.innerHTML = rich(text);
    this.prompt.classList.toggle('on', !!text);
  }

  setHum(value, label) {
    this.q.humLabel.textContent = `${label} ${Math.round(value)}%`;
    this.q.humFill.style.width = Math.max(0, Math.min(100, value)) + '%';
  }

  // The meter row (Hum or City Scale) can stay hidden until it first means something.
  showMeter(on) { const m = this.quest.querySelector('.hum'); if (m) m.style.display = on ? '' : 'none'; }

  // City Scale, -20 ("me first") .. +20 ("together"): a balance bar filled from its centre.
  setScale(value, label, left, right) {
    const v = Math.max(-20, Math.min(20, value || 0));
    // Arrows would point the wrong way once the bidi algorithm flips the row in Hebrew.
    this.q.humLabel.textContent = `${left} · ${label} · ${right}`;
    const f = this.q.humFill.style;
    const w = (Math.abs(v) / 20) * 50;
    f.width = w + '%';
    f.marginInlineStart = (v >= 0 ? 50 : 50 - w) + '%';
    f.background = v >= 0 ? 'linear-gradient(90deg, #7fe0d6, #2e9e57)' : 'linear-gradient(90deg, #e8364f, #ff8a7a)';
    this.q.humFill.parentElement.title = String(v);
  }

  setObjective(obj) {
    this.objective = obj;
    const key = obj ? `${obj.title}|${obj.text}|${obj.progress || ''}` : '';
    if (key === this._objKey) return;
    this._objKey = key;
    this.q.title.textContent = obj?.title || '';
    this.q.text.textContent = obj?.text || '';
    this.q.prog.innerHTML = rich(obj?.progress || ''); // key caps ({k:F}) in hints
    this.quest.classList.toggle('giver', !!obj?.giver);
  }

  // html = null hides the card; the same markup is not rewritten every frame.
  setClues(html) {
    if (html === this._cluesKey) return;
    this._cluesKey = html;
    this.clues.style.display = html ? '' : 'none';
    this.clues.innerHTML = html || '';
    if (html) this.clues.style.top = Math.round(this.quest.getBoundingClientRect().bottom + 8) + 'px';
  }

  banner(title, sub, extra) {
    this.bannerEl.innerHTML = '';
    for (const [cls, text] of [['b-title', title], ['b-sub', sub], ['b-extra', extra]]) {
      if (!text) continue;
      const e = document.createElement('div'); e.className = cls; e.textContent = text; this.bannerEl.appendChild(e);
    }
    this.bannerEl.classList.add('on');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => this.bannerEl.classList.remove('on'), extra ? 6500 : 3000);
  }

  toastMsg(text) {
    this.toast.innerHTML = rich(text); // key caps ({k:F}) render as in the dialogue box
    this.toast.style.opacity = 1;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { this.toast.style.opacity = 0; }, 1400);
  }

  updateTracker(player, camYaw) {
    const tgt = this.objective?.target;
    this.q.arrow.style.visibility = tgt ? 'visible' : 'hidden';
    if (!tgt) { this.q.dist.textContent = ''; return; }
    // With a GPS route to this target, the arrow points along the road ahead and the distance
    // is the distance to drive, not the straight line.
    const route = this.routeFor(tgt);
    let aim = tgt, len = Math.hypot(tgt.x - player.pos.x, tgt.z - player.pos.z);
    if (route) {
      len = this.gps.distanceLeft || len;
      let acc = 0;
      for (let i = 1; i < route.length; i++) { acc += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z); if (acc > 14) { aim = route[i]; break; } }
    }
    const dx = aim.x - player.pos.x, dz = aim.z - player.pos.z;
    // camera looks along (sin yaw, cos yaw); its right is (-cos yaw, sin yaw)
    const fwd = dx * Math.sin(camYaw) + dz * Math.cos(camYaw);
    const right = -dx * Math.cos(camYaw) + dz * Math.sin(camYaw);
    this.q.arrow.style.transform = `rotate(${Math.atan2(right, fwd)}rad)`;
    const m = len / SCALE;
    const dist = m > 1000 ? t('hud.distKm', { d: (m / 1000).toFixed(1) }) : t('hud.distM', { d: Math.round(m) });
    // A search zone has no exact spot, so its distance reads as approximate.
    // The neighbourhood or landmark the target is in, so "where" reads as a place, not a number.
    const where = this.objective && this.objective.where;
    this.q.dist.textContent = (tgt.zone ? `~${dist}` : dist) + (where && m > 60 ? ` · ${where}` : '');
  }

  setMode(mode) {
    const label = (m) => t(`hud.modes.${m}`);
    const chips = Object.keys(MODE_KEYS).map((m) => `<span class="${m === mode ? 'on' : ''}"><kbd dir="ltr">${MODE_KEYS[m]}</kbd> ${rich(label(m))}</span>`).join('');
    const hint = t(mode === 'walk' ? 'hud.hintWalk' : mode === 'car' ? 'hud.hintCar' : mode === 'skate' ? 'hud.hintSkate' : 'hud.hintRide');
    this.mode.innerHTML = `<div class="mode">${rich(label(mode))}</div><div class="modes">${chips}</div>` +
      `<div class="hint">${rich(hint)}</div><div class="hint">${rich(t('hud.hintCommon'))}</div>`;
    if (this._modeSet) {
      this.toast.textContent = t('hud.switched', { mode: label(mode) });
      this.toast.style.opacity = 1;
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { this.toast.style.opacity = 0; }, 900);
    }
    this._modeSet = true;
  }

  // Pre-render the static map (sea, buildings, roads) once into an offscreen canvas.
  buildMap({ bounds, roads = [], colliders = [], water = [], pois = [] }) {
    this.pois = pois;
    if (!bounds) return;
    const w = bounds.maxX - bounds.minX, d = bounds.maxZ - bounds.minZ;
    const s = Math.min(MAP_SCALE, 4096 / Math.max(w, d));
    const c = document.createElement('canvas');
    c.width = Math.max(4, Math.ceil(w * s)); c.height = Math.max(4, Math.ceil(d * s));
    const g = c.getContext('2d');
    const X = (x) => (x - bounds.minX) * s, Z = (z) => (z - bounds.minZ) * s;
    g.fillStyle = '#cfe6a8';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#e9d2b4';
    for (const col of colliders) {
      if (col.kind === 'sea' || col.kind === 'water') continue;
      const p = col.points; if (!p || p.length < 3) continue;
      g.beginPath(); g.moveTo(X(p[0][0]), Z(p[0][1]));
      for (let i = 1; i < p.length; i++) g.lineTo(X(p[i][0]), Z(p[i][1]));
      g.closePath(); g.fill();
    }
    // Water after buildings: the map's sea-edge collider covers the sea itself.
    g.fillStyle = '#4fb6e8';
    for (const tri of water) { g.beginPath(); g.moveTo(X(tri[0]), Z(tri[1])); g.lineTo(X(tri[2]), Z(tri[3])); g.lineTo(X(tri[4]), Z(tri[5])); g.closePath(); g.fill(); }
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const pass of [['#8a8f99', 2.2], ['#ffffff', 1]]) {
      g.strokeStyle = pass[0];
      for (const r of roads) {
        const p = r.points; if (!p || p.length < 2) continue;
        g.lineWidth = Math.max(1.2, (r.width || 6) * s * pass[1]);
        g.beginPath(); g.moveTo(X(p[0][0]), Z(p[0][1]));
        for (let i = 1; i < p.length; i++) g.lineTo(X(p[i][0]), Z(p[i][1]));
        g.stroke();
      }
    }
    this.base = { canvas: c, s, bounds };
  }

  update(dt, player, camYaw) {
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc >= 0.5) {
      this.fpsValue = Math.round(this.fpsN / this.fpsAcc);
      this.fps.textContent = `${t('hud.fps')} ${this.fpsValue}`;
      this.fpsAcc = 0; this.fpsN = 0;
    }
    this.mapTimer += dt;
    if (this.mapTimer < 1 / 20) return;
    this.updateTracker(player, camYaw);
    this.mapTimer = 0;
    this.drawMap(player, camYaw);
  }

  drawMap(player, camYaw) {
    const g = this.map.getContext('2d');
    const S = MAP_SIZE * this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#cfe6a8';
    g.fillRect(0, 0, S, S);
    const zoom = this.dpr; // canvas px per minimap px
    if (this.base) {
      const { canvas, s, bounds } = this.base;
      const k = (MAP_SCALE / s) * zoom;
      const cx = (player.pos.x - bounds.minX) * s, cz = (player.pos.z - bounds.minZ) * s;
      g.imageSmoothingEnabled = true;
      g.setTransform(k, 0, 0, k, S / 2 - cx * k, S / 2 - cz * k);
      g.drawImage(canvas, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    const toMap = (x, z) => [S / 2 + (x - player.pos.x) * MAP_SCALE * zoom, S / 2 + (z - player.pos.z) * MAP_SCALE * zoom];
    g.font = `bold ${10 * zoom}px Rubik, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.direction = dir();
    for (const p of this.pois) {
      const [mx, my] = toMap(p.x, p.z);
      if (mx < -20 || my < -20 || mx > S + 20 || my > S + 20) continue;
      g.fillStyle = '#ff6f59'; g.strokeStyle = '#23324a'; g.lineWidth = 2 * zoom;
      g.beginPath(); g.arc(mx, my, 5 * zoom, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#23324a';
      g.fillText(poiName(p).slice(0, 22), mx, my - 8 * zoom);
    }
    this.drawObjective(g, S, zoom, toMap);
    // view cone + player arrow (north up: -z is up on the map)
    g.save();
    g.translate(S / 2, S / 2);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); g.moveTo(0, 0);
    const vf = Math.atan2(Math.sin(camYaw), Math.cos(camYaw));
    g.arc(0, 0, 42 * zoom, Math.atan2(Math.cos(vf), Math.sin(vf)) - 0.5, Math.atan2(Math.cos(vf), Math.sin(vf)) + 0.5);
    g.closePath(); g.fill();
    g.rotate(-player.heading + Math.PI);
    g.fillStyle = '#ffb347'; g.strokeStyle = '#23324a'; g.lineWidth = 2 * zoom;
    g.beginPath(); g.moveTo(0, -9 * zoom); g.lineTo(6.5 * zoom, 7 * zoom); g.lineTo(0, 3.5 * zoom); g.lineTo(-6.5 * zoom, 7 * zoom); g.closePath();
    g.fill(); g.stroke();
    g.restore();
    g.fillStyle = '#23324a';
    g.fillText(t('hud.north'), S / 2, 12 * zoom);
  }

  // The GPS (quests or a mini-game) hands its route here. The minimap draws the active route
  // (ribbon or map-only waypoint route); the tracker's arrow follows it only when it leads to
  // the current objective.
  setGps(gps, routeFn = null) { this.gps = gps; this.routeFn = routeFn; }

  routeFor(tgt) {
    const g = this.gps;
    if (!g || !g.active || !g.target) return null;
    if (tgt && Math.hypot(g.target.x - tgt.x, g.target.z - tgt.z) > 12) return null;
    const r = g.remaining();
    return r && r.length > 1 ? r : null;
  }

  drawRoute(g, zoom, toMap) {
    // Any active route: the quest objective, a mini-game's, or a waypoint set on the big map.
    const route = this.routeFn ? this.routeFn() : this.gps && this.gps.active ? this.gps.remaining() : null;
    if (!route || route.length < 2) return;
    g.save();
    g.lineJoin = g.lineCap = 'round';
    for (const [w, c] of [[6, '#23324a'], [3.4, '#2ec4b6']]) {
      g.lineWidth = w * zoom; g.strokeStyle = c;
      g.beginPath();
      route.forEach((p, i) => { const [x, y] = toMap(p.x, p.z); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    }
    g.restore();
  }

  // Quest target: a pulsing marker when on the map, otherwise an arrow pinned to the edge.
  drawObjective(g, S, zoom, toMap) {
    this.drawRoute(g, zoom, toMap);
    const tgt = this.objective?.target;
    if (!tgt) return;
    const [mx, my] = toMap(tgt.x, tgt.z);
    const c = S / 2, pad = 14 * zoom;
    const color = this.objective.giver ? '#ffcb3d' : '#2ec4b6';
    if (tgt.zone && tgt.radius) {
      // Search zone: a dashed circle, no exact marker (the item is somewhere inside).
      g.save();
      g.fillStyle = 'rgba(255, 179, 71, 0.22)'; g.strokeStyle = '#e8364f'; g.lineWidth = 2 * zoom;
      g.setLineDash([6 * zoom, 4 * zoom]);
      g.beginPath(); g.arc(mx, my, tgt.radius * MAP_SCALE * zoom, 0, Math.PI * 2); g.fill(); g.stroke();
      g.restore();
      if (mx > 0 && my > 0 && mx < S && my < S) return;
    }
    g.lineWidth = 2 * zoom; g.strokeStyle = '#23324a'; g.fillStyle = color;
    if (mx > pad && my > pad && mx < S - pad && my < S - pad) {
      const r = (6 + Math.sin(performance.now() / 180) * 1.5) * zoom;
      g.beginPath(); g.arc(mx, my, r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#23324a'; g.font = `900 ${10 * zoom}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(this.objective.giver ? '!' : '\u2605', mx, my + 0.5 * zoom);
      g.textBaseline = 'alphabetic';
      return;
    }
    const ang = Math.atan2(my - c, mx - c);
    const k = (c - pad) / Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
    g.save();
    g.translate(c + Math.cos(ang) * k, c + Math.sin(ang) * k);
    g.rotate(ang);
    g.beginPath(); g.moveTo(10 * zoom, 0); g.lineTo(-6 * zoom, 7 * zoom); g.lineTo(-3 * zoom, 0); g.lineTo(-6 * zoom, -7 * zoom); g.closePath();
    g.fill(); g.stroke();
    g.restore();
  }
}
