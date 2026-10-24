// A night at the movies, at either cinema: buy a ticket at the box office (free, the house
// treats), maybe popcorn, walk down the steps of a dark auditorium to your seat, the lights dim,
// the curtains open and a short film plays on the big screen. Leave whenever you like.
//
//   const cinema = createCinema(deps);      // deps as for createMinigames (scene, camera, renderer, player, audio, ...)
//   const r = await cinema.start({ venue: 'cinema_city' | 'yes_planet' });
//   // r = { ok: true, quit, watched, popcorn, film, cancelled? }
//   per frame: cinema.update(dt, input); freeze the player while cinema.blocksPlayer.
//
// The films are original cartoons rendered live in the engine (experiences/films.js). The founder
// can screen his own clip instead: put an mp4 under data/cinema/ and name it in
// data/cinema/films.json (docs/CINEMA.md). Text: data/minigames/cinema.<lang>.json under `cinema`.
import * as THREE from 'three';
import { createOverlay, addStyle, textFn, keyListener, toaster, showCard, rich, playerIsMalul } from './common.js';
import { register, i18n } from '../../i18n.js';
import { openVenue, fader } from '../experiences/venue.js';
import { toon, basic, box, cyl, rbox, textPlane, seatRows, blobCrowd, curtainHalf, popcornBucket, ease, lerp } from '../experiences/kit.js';
import { getSfx } from '../experiences/sfx.js';
import { createFilm } from '../experiences/films.js';

let stringsP = null;
export function loadCinemaStrings(base = new URL('../../../data/minigames/', import.meta.url).href) {
  if (stringsP) return stringsP;
  const get = (lang) => fetch(`${base}cinema.${lang}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`cinema.${lang}.json: HTTP ${r.status}`))));
  stringsP = (async () => {
    const fallback = await get('en').catch((e) => { console.warn('[cinema] no English strings', e.message); return {}; });
    const active = i18n.lang === 'en' ? fallback : await get(i18n.lang).catch(() => null);
    register('cinema', active || fallback, fallback);
  })();
  return stringsP;
}

// The founder's own clips: data/cinema/films.json names a file per venue (empty = none). A list
// file instead of probing for the mp4, so a missing clip never shows up as a 404 in the console.
let ownP = null;
const CINEMA_DIR = new URL('../../../data/cinema/', import.meta.url).href;
function ownFilms() {
  if (!ownP) ownP = fetch(`${CINEMA_DIR}films.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return ownP;
}

// Per venue: which film, the hall's colours, the box office look.
const VENUES = {
  cinema_city: { film: 'dino', seat: 0xb3263a, wall: 0x241c30, panel: 0x30263f, carpet: 0x3a1f2c, accent: '#d8343a', accent2: '#1f4fa3', hall: 7 },
  yes_planet: { film: 'space', seat: 0x1f4fa3, wall: 0x1b2030, panel: 0x262d42, carpet: 0x1e2433, accent: '#ee6a1f', accent2: '#1f4fa3', hall: 12 },
};

// Hall layout (venue-local units; the screen wall is at -z, the door at the top of the rows).
const SCREEN = { w: 28, h: 15.75, y: 2.8, z: -6 };
const ROWS = { rows: 9, cols: 14, pitch: 2.5, rise: 0.62, z0: 10, aisle: 2.2, seatH: 1.25 };
const MY = { row: 4, col: 7 }; // first seat right of the aisle, middle of the hall
const LOBBY = { x: 400, z: 0 };

const CSS = `
.mg-cinema .cn-hint { left: 50%; bottom: 18px; transform: translateX(-50%); font-weight: 800; font-size: 14px; white-space: nowrap; max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis; }
.mg-cinema .cn-pop { position: absolute; inset-inline-end: 16px; top: 14px; font-weight: 900; font-size: 18px; }
.mg-cinema .cn-ticket { font-size: 13px; opacity: 0.8; }
`;

export function createCinema(deps = {}) {
  const t = textFn(deps.t);
  addStyle('mg-style-cinema', CSS);
  loadCinemaStrings();
  ownFilms();
  let S = null;

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const venueId = VENUES[config.venue] ? config.venue : 'cinema_city';
      const V = VENUES[venueId];
      const fade = fader(0.45);
      fade.black();
      const ov = createOverlay('mg-cinema', '<div class="mg-panel cn-hint mg-hide"></div><div class="mg-panel cn-pop mg-hide"></div>');
      S = {
        cfg: config, venueId, V, ov, fade, resolve, phase: 'lobby', phaseT: 0, ending: false,
        toast: toaster(ov.root), offKeys: keyListener(onKey), card: null,
        fx: getSfx(deps.audio), popcorn: false, eaten: 0, film: null, filmKind: V.film, video: null,
        dim: 0, curtain: 0, full: false, watched: false, quit: false, laughs: [],
      };
      const s = S;
      s.venue = openVenue(deps, { background: 0x05060a });
      buildLobby(s);
      buildHall(s);
      s.venue.tick(0);
      lobbyCam(s, 0);
      Promise.all([loadCinemaStrings(), ownFilms(), s.ready]).then(([, own]) => {
        if (S !== s) return;
        s.own = own && own[venueId] && own[venueId].file ? own[venueId] : null;
        s.fade.in();
        boxOffice(s);
      });
    });
  }

  // ---- sets ----------------------------------------------------------------------------------
  function buildLobby(s) {
    const v = s.venue, V = s.V;
    const g = new THREE.Group();
    g.position.set(LOBBY.x, 0, LOBBY.z);
    v.root.add(g);
    s.lobby = g;
    g.add(new THREE.HemisphereLight(0xfff4e0, 0x4a3a3a, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(6, 14, 12);
    g.add(key);
    box(40, 0.2, 30, V.carpet, 0, -0.2, 0, g);
    box(40, 16, 0.6, V.wall, 0, 0, -9, g);
    // the counter, the popcorn machine and a soda tap
    rbox(14, 2.1, 2.4, 0.3, 0x2b2b33, 0, 0, -3.2, g);
    box(14.4, 0.3, 2.8, 0xe9e2d0, 0, 2.1, -3.2, g);
    const glassM = new THREE.MeshToonMaterial({ color: 0xfff6d8, transparent: true, opacity: 0.35 });
    const pm = new THREE.Group();
    pm.position.set(-4.5, 2.4, -3.4);
    g.add(pm);
    const pglass = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.8, 1.8), glassM);
    pglass.position.y = 1.4;
    pm.add(pglass);
    box(2.8, 0.5, 2.0, 0xd8343a, 0, 2.8, 0, pm);
    const kernels = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 0), toon(0xfff1b5), 90);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 90; i++) { m4.makeTranslation((Math.random() - 0.5) * 2.3, 0.15 + Math.random() * 1.1 * (i / 90), (Math.random() - 0.5) * 1.5); kernels.setMatrixAt(i, m4); }
    pm.add(kernels);
    s.kernelsLobby = kernels;
    cyl(0.5, 0.5, 2.0, 0xcfd6dd, 3.8, 2.4, -3.6, g, 12);
    for (let i = 0; i < 3; i++) cyl(0.1, 0.1, 0.6, 0x555555, 3.4 + i * 0.4, 3.3, -3.0, g, 6);
    // the sign over the counter and two posters for this week's films
    const sign = textPlane([{ text: t(`cinema.venue.${s.venueId}`), size: 120, color: '#ffffff' }], 14, 2.6, { w: 1400, h: 260, bg: V.accent });
    sign.position.set(0, 11.6, -8.6);
    g.add(sign);
    const poster = (film, x, bg) => {
      const p = textPlane([{ text: t(`cinema.film.${film}.title`), size: 92, color: '#ffffff' }, { text: t(`cinema.film.${film}.tag`), size: 34, color: '#ffe27a' }, { text: t(`cinema.film.${film}.soon`), size: 30, color: '#ffffff' }],
        4.6, 6.6, { w: 600, h: 860, bg });
      p.position.set(x, 7.2, -8.6);
      g.add(p);
      box(5.0, 7.0, 0.2, 0xe9c46a, x, 3.7, -8.8, g);
    };
    poster('dino', -10.5, '#2e7d32');
    poster('space', 10.5, '#1b2a6b');
    s.lobbyLights = [];
    for (const x of [-15, -6, 6, 15]) { const l = box(1.2, 0.4, 1.2, 0xfff2c0, x, 15, -2, g); l.material = basic(0xfff2c0); }
    // the cashier behind the counter and the player in front of it
    s.ready = (async () => {
      const cashier = await v.avatar({ archetype: 'kiosk_vendor', seed: s.venueId === 'yes_planet' ? 2 : 0 }, g);
      cashier.group.position.set(0, 0, -5.2);
      s.cashier = cashier;
      const me = await v.double(null, g);
      me.group.position.set(0, 0, 2.2);
      me.group.rotation.y = Math.PI;
      s.me = me;
      // the friends who came along, already in their seats
      s.friends = [];
      for (const [id, dc] of [['adir', 1], ['malul', 2]].filter(([id]) => !(id === 'malul' && playerIsMalul()))) {
        const a = await v.avatar(id, s.hall);
        sitAt(a, seatAt(MY.row, MY.col + dc));
        s.friends.push(a);
      }
    })().catch((e) => console.warn('[cinema] cast failed', e));
  }

  function buildHall(s) {
    const v = s.venue, V = s.V;
    const g = new THREE.Group();
    v.root.add(g);
    s.hall = g;
    // light: the house lights dim, a cool spill from the screen takes over
    s.amb = new THREE.HemisphereLight(0xfff0dc, 0x3a2a3a, 1.2);
    s.key = new THREE.DirectionalLight(0xffe7c4, 1.0);
    s.key.position.set(0, 20, 30);
    s.spill = new THREE.DirectionalLight(0x9fd8ff, 0);
    s.spill.position.set(0, SCREEN.y + SCREEN.h / 2, SCREEN.z);
    s.spill.target.position.set(0, 0, 30);
    g.add(s.amb, s.key, s.spill, s.spill.target);
    const back = ROWS.z0 + (ROWS.rows - 1) * ROWS.pitch + ROWS.pitch / 2 + 0.3, top = (ROWS.rows - 1) * ROWS.rise;
    s.backZ = back;
    s.topY = top;
    box(40, 0.2, ROWS.z0 + 16, V.carpet, 0, -0.2, (ROWS.z0 - 16) / 2, g);
    box(40, top, 6, V.carpet, 0, 0, back + 3, g);
    for (const x of [-19, 19]) box(1, 26, 50, V.wall, x, 0, 13, g);
    box(40, 26, 1, V.wall, 0, 0, back + 6, g);
    box(40, 26, 1, 0x0c0c12, 0, 0, SCREEN.z - 1.5, g);
    box(40, 1, 50, 0x15121c, 0, 25, 13, g);
    // acoustic panels and wall lamps (the lamps dim with the house lights)
    s.lamps = [];
    for (const x of [-18.4, 18.4]) {
      for (let i = 0; i < 6; i++) {
        box(0.3, 14, 3.2, V.panel, x, 5, -1 + i * 6.4, g);
        const lamp = box(0.4, 1.0, 1.2, 0xffd9a0, x * 0.985, 13, 2.2 + i * 6.4, g);
        lamp.material = basic(0xffd9a0);
        s.lamps.push(lamp);
      }
    }
    // the screen, its black frame, the stage lip and the curtains
    box(SCREEN.w + 1.6, SCREEN.h + 1.6, 0.4, 0x050507, 0, SCREEN.y - 0.8, SCREEN.z - 0.4, g);
    s.screenMat = new THREE.MeshBasicMaterial({ color: 0x15151c, toneMapped: false });
    s.screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h), s.screenMat);
    s.screen.position.set(0, SCREEN.y + SCREEN.h / 2, SCREEN.z);
    g.add(s.screen);
    rbox(34, 1.4, 4, 0.3, 0x2a2233, 0, 0, SCREEN.z + 1.6, g);
    s.curtains = [-1, 1].map((side) => {
      const c = curtainHalf(SCREEN.w / 2 + 2, SCREEN.h + 5, s.venueId === 'yes_planet' ? 0x22356e : 0x8e1b2b, side);
      // curtainHalf(side) gathers towards -side, so each half hangs on the opposite side
      c.mesh.position.x = -side * (SCREEN.w / 4 + 1);
      c.mesh.position.z = SCREEN.z + 0.6;
      g.add(c.mesh);
      return c;
    });
    // seats, the aisle lights and the back platform
    const rows = seatRows({ ...ROWS, color: V.seat });
    g.add(rows.group);
    s.seats = rows.seats;
    for (let r = 0; r < ROWS.rows; r++) {
      for (const x of [-ROWS.aisle / 2 - 0.15, ROWS.aisle / 2 + 0.15]) {
        const l = box(0.25, 0.12, 0.6, 0xffb347, x, r * ROWS.rise + 0.02, ROWS.z0 + r * ROWS.pitch - ROWS.pitch / 2 + 0.6, g);
        l.material = basic(0xffb347);
      }
    }
    // the audience: about half the seats, never the player's own or the friends'
    const keep = new Set([[MY.row, MY.col], [MY.row, MY.col + 1], [MY.row, MY.col + 2]].map(([r, c]) => r * ROWS.cols + c));
    let seed = s.venueId === 'yes_planet' ? 99 : 7;
    const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const people = s.seats.filter((p, i) => !keep.has(i) && R() < 0.52);
    s.crowd = blobCrowd(people, { seated: true, seed });
    g.add(s.crowd.group);
    // the projector booth window (a light cone would read as a grey wedge under the outline pass)
    const booth = box(6, 3, 0.4, 0xbfd8ff, 0, 17, back + 5.4, g);
    booth.material = basic(0x2a3550);
    s.booth = booth;
  }

  function seatAt(row, col) { return S ? S.seats[row * ROWS.cols + col] : null; }
  function sitAt(a, seat) {
    if (!a || !seat) return;
    a.setMode('sit');
    a.setSeat(ROWS.seatH - 0.1);
    a.group.position.set(seat.x, seat.y - ROWS.seatH, seat.z - 0.15);
    a.group.rotation.y = Math.PI;
  }
  // Floor height in the hall at depth z (the seat rows are steps).
  function floorAt(z) {
    if (z < ROWS.z0 - ROWS.pitch / 2 + 0.3) return 0;
    const r = Math.round((z - 0.3 - ROWS.z0) / ROWS.pitch);
    return Math.max(0, Math.min(ROWS.rows - 1, r)) * ROWS.rise;
  }

  // ---- cameras -------------------------------------------------------------------------------
  function lobbyCam(s, k) {
    s.venue.look(LOBBY.x + 4 - k * 2, 7.5, LOBBY.z + 15, LOBBY.x, 4.2, LOBBY.z - 3, 45);
  }
  function seatCam(s) {
    const seat = seatAt(MY.row, MY.col);
    return { p: new THREE.Vector3(seat.x - 0.6, seat.y + 4.6, seat.z + 5.2), l: new THREE.Vector3(0, SCREEN.y + SCREEN.h * 0.48, SCREEN.z), fov: 50 };
  }
  function fullCam() {
    const aspect = deps.camera ? deps.camera.aspect : 16 / 9, fov = 40, k = 2 * Math.tan((fov / 2) * Math.PI / 180);
    const d = Math.max((SCREEN.h * 1.06) / k, (SCREEN.w * 1.04) / (k * aspect));
    return { p: new THREE.Vector3(0, SCREEN.y + SCREEN.h / 2, SCREEN.z + d), l: new THREE.Vector3(0, SCREEN.y + SCREEN.h / 2, SCREEN.z), fov };
  }

  // ---- the box office ------------------------------------------------------------------------
  function boxOffice(s) {
    hint(s, null);
    const film = t(`cinema.film.${s.filmKind}.title`);
    s.card = showCard(s.ov.root, {
      title: t('cinema.box.title', { venue: t(`cinema.venue.${s.venueId}`) }),
      big: '🎟️',
      lines: [t('cinema.box.film', { film }), t('cinema.box.price')],
      buttons: [
        { label: t('cinema.box.combo'), key: ['Enter', 'Digit1'], onClick: () => buy(s, true) },
        { label: t('cinema.box.ticket'), key: 'Digit2', onClick: () => buy(s, false) },
        { label: t('cinema.box.cancel'), key: 'Escape', alt: true, onClick: () => { s.card = null; finish({ quit: true, watched: false }); } },
      ],
    });
    s.cashier && s.cashier.setTalking(true);
    setTimeout(() => s.cashier && s.cashier.setTalking(false), 1200);
  }
  function buy(s, popcorn) {
    s.card = null;
    s.popcorn = popcorn;
    const seat = { hall: s.V.hall, row: MY.row + 1, seat: MY.col + 1 };
    if (s.own) {
      s.card = showCard(s.ov.root, {
        title: t('cinema.own.title'),
        lines: [t('cinema.own.line')],
        buttons: [
          { label: t(`cinema.film.${s.filmKind}.title`), key: ['Enter', 'Digit1'], onClick: () => { s.card = null; served(s, seat); } },
          { label: t('cinema.own.play'), key: 'Digit2', onClick: () => { s.card = null; s.useOwn = true; served(s, seat); } },
        ],
      });
      return;
    }
    served(s, seat);
  }
  function served(s, seat) {
    s.toast(t('cinema.toast.ticket', seat), 2600);
    if (s.popcorn) {
      for (let i = 0; i < 6; i++) setTimeout(() => s.fx.pop(0.7), i * 140);
      const b = popcornBucket();
      s.bucket = b;
      const me = s.me;
      if (me && me.anchors && me.anchors.carry) {
        me.setCarry('two');
        const ws = me.anchors.carry.getWorldScale(new THREE.Vector3()).x || 1;
        b.scale.setScalar(0.75 / ws);
        b.position.set(0, -0.3 / ws, 0);
        me.anchors.carry.add(b);
      }
    } else s.fx.ding(0.6);
    s.cashier && s.cashier.emote('wave');
    setPhase(s, 'lobbyOut');
  }

  // ---- the hall ------------------------------------------------------------------------------
  async function toHall(s) {
    await s.fade.out();
    if (S !== s) return;
    s.lobby.visible = false;
    const me = s.me;
    if (me) {
      s.hall.add(me.group);
      me.group.position.set(0, s.topY, s.backZ + 2);
      me.group.rotation.y = Math.PI;
      me.setMode('walk');
    }
    s.walkPath = [
      new THREE.Vector3(0, 0, s.backZ + 2),
      new THREE.Vector3(0, 0, seatAt(MY.row, MY.col).z - 1.2),
      new THREE.Vector3(seatAt(MY.row, MY.col).x, 0, seatAt(MY.row, MY.col).z - 1.2),
    ];
    s.walkI = 0;
    // load the film while we walk in
    loadFilm(s);
    setPhase(s, 'walk');
    hint(s, t('cinema.hint.walk'));
    s.fade.in();
  }
  function loadFilm(s) {
    if (s.useOwn && s.own) { s.filmP = Promise.resolve(ownVideo(s)); return; }
    s.filmP = createFilm(s.filmKind, deps, t, { onGag: (k) => gag(s, k) }).then((f) => { if (S === s) s.film = f; else f.dispose(); return f; })
      .catch((e) => { console.warn('[cinema] film failed', e); return null; });
  }
  // The founder's clip as a video texture; on any error the cartoon plays instead.
  function ownVideo(s) {
    const el = document.createElement('video');
    el.src = CINEMA_DIR + s.own.file;
    el.playsInline = true;
    el.preload = 'auto';
    el.volume = deps.audio && deps.audio.muted ? 0 : 1;
    const tex = new THREE.VideoTexture(el);
    tex.colorSpace = THREE.SRGBColorSpace;
    let ended = false;
    el.addEventListener('ended', () => { ended = true; });
    el.addEventListener('error', () => {
      if (S !== s || s.video !== v) return;
      console.warn('[cinema] own film failed to load', s.own.file);
      s.toast(t('cinema.own.failed'), 2500);
      s.video = null; s.useOwn = false;
      loadFilm(s);
      s.filmP.then(() => { if (S === s && s.phase === 'film') useFilmTexture(s); });
    });
    el.addEventListener('loadedmetadata', () => {
      const a = el.videoWidth / Math.max(1, el.videoHeight), sa = SCREEN.w / SCREEN.h;
      s.screen.scale.set(a < sa ? a / sa : 1, a > sa ? sa / a : 1, 1);
    });
    const v = {
      el, texture: tex, glow: new THREE.Color(0xc8d8ff),
      get done() { return ended; },
      play() { el.play().catch((e) => console.warn('[cinema] video play blocked', e.message)); },
      update() {}, render() {}, pause() { el.pause(); },
      dispose() { el.pause(); el.removeAttribute('src'); el.load(); tex.dispose(); },
    };
    s.video = v;
    return v;
  }
  function useFilmTexture(s) {
    const f = s.video || s.film;
    if (!f) return;
    s.screenMat.map = f.texture;
    s.screenMat.color.setHex(0xffffff);
    s.screenMat.needsUpdate = true;
  }
  function gag(s, k) {
    if (S !== s) return;
    s.fx.laugh(0.5 + k * 0.4, 1.4 + k);
    s.laughT = 1.2 + k * 1.2;
    s.laughK = k;
    for (const a of s.friends || []) a.express('laugh', 1.6);
    if (s.me) s.me.express('laugh', 1.4);
  }

  // ---- per frame -----------------------------------------------------------------------------
  function update(dt) {
    const s = S;
    if (!s) return;
    s.phaseT += dt;
    s.venue.tick(dt);
    if (s.phase === 'lobby' || s.phase === 'lobbyOut') {
      lobbyCam(s, Math.min(1, s.phaseT / 6));
      // the popcorn machine keeps popping
      if (s.kernelsLobby && Math.random() < dt * 8) s.kernelsLobby.rotation.y += 0.4;
      if (s.phase === 'lobbyOut' && s.phaseT > 1.8 && !s.leaving) { s.leaving = true; toHall(s); }
      return;
    }
    if (s.phase === 'walk') { walk(s, dt); return; }
    lights(s, dt);
    const cam = s.full ? fullCam() : seatCam(s);
    if (s.phase === 'dim') {
      // from the aisle view to the seat, as the room goes dark and the curtains part
      const k = ease(Math.min(1, s.phaseT / 3.2));
      const from = s.camFrom;
      s.venue.look(lerp(from.p.x, cam.p.x, k), lerp(from.p.y, cam.p.y, k), lerp(from.p.z, cam.p.z, k), lerp(from.l.x, cam.l.x, k), lerp(from.l.y, cam.l.y, k), lerp(from.l.z, cam.l.z, k), lerp(from.fov, cam.fov, k));
      s.dim = Math.min(1, s.phaseT / 3);
      s.curtain = ease(Math.min(1, Math.max(0, (s.phaseT - 1.2) / 2.4)));
      if (s.phaseT > 3.6 && (s.film || s.video)) startFilm(s);
      return;
    }
    s.camK = Math.min(1, (s.camK ?? 1) + dt * 1.5);
    const k = ease(s.camK);
    const a = s.camPrev || cam;
    s.venue.look(lerp(a.p.x, cam.p.x, k), lerp(a.p.y, cam.p.y, k), lerp(a.p.z, cam.p.z, k), cam.l.x, cam.l.y, cam.l.z, lerp(a.fov, cam.fov, k));
    if (s.phase === 'film') {
      const f = s.video || s.film;
      if (f) {
        f.update(dt);
        if (deps.renderer && f.render) f.render(deps.renderer);
        // the screen's light flickers on the audience with the picture
        s.spill.color.copy(f.glow);
        s.spill.intensity = 0.55 + Math.sin(s.phaseT * 13) * 0.05 + Math.sin(s.phaseT * 3.1) * 0.08;
        if (f.done) endFilm(s);
      }
    } else if (s.phase === 'lights') {
      s.dim = Math.max(0, 1 - s.phaseT / 2.5);
      s.curtain = Math.max(0, 1 - s.phaseT / 2.5);
      if (s.phaseT > 2.6 && !s.card) endCard(s);
    }
  }

  function walk(s, dt) {
    const me = s.me, P = s.walkPath;
    if (!me || !P) return;
    const pos = me.group.position;
    const target = P[s.walkI];
    const dx = target.x - pos.x, dz = target.z - pos.z, d = Math.hypot(dx, dz);
    const sp = 7;
    if (d < 0.15) {
      s.walkI++;
      if (s.walkI >= P.length) { sitDown(s); return; }
    } else {
      const step = Math.min(d, sp * dt);
      pos.x += (dx / d) * step; pos.z += (dz / d) * step;
      me.group.rotation.y = Math.atan2(dx, dz);
      me.userSpeed = sp;
    }
    pos.y = floorAt(pos.z);
    // a crane view from the front corner, following the player down the steps
    s.venue.look(15, 13, pos.z - 12, pos.x, pos.y + 2.5, pos.z, 46);
  }
  function sitDown(s) {
    const me = s.me;
    me.userSpeed = 0;
    sitAt(me, seatAt(MY.row, MY.col));
    if (s.bucket) {
      // the bucket moves from the hands to the lap
      me.setCarry(null);
      const ws = me.group.getWorldScale(new THREE.Vector3()).x || 1;
      s.bucket.removeFromParent();
      s.bucket.scale.setScalar(0.7 / ws);
      s.bucket.position.set(0, ROWS.seatH + 0.55, 1.0);
      me.group.add(s.bucket);
    }
    const pos = me.group.position;
    s.camFrom = { p: new THREE.Vector3(15, 13, pos.z - 12), l: new THREE.Vector3(pos.x, pos.y + 2.5, pos.z), fov: 46 };
    setPhase(s, 'dim');
    hint(s, null);
    s.fx.applause(1.2, 0.25);
  }
  function lights(s, dt) {
    const k = 1 - s.dim * 0.93;
    s.amb.intensity = 1.2 * k + 0.08;
    s.key.intensity = 1.0 * k;
    const c = 0.25 + 0.75 * k;
    for (const l of s.lamps) l.material.color.setRGB(1 * c, 0.85 * c, 0.63 * c);
    s.curtains.forEach((cu) => cu.open(s.curtain));
    if (s.phase !== 'film') s.spill.intensity = Math.max(0, s.spill.intensity - dt);
    if (s.laughT > 0) { s.laughT -= dt; s.crowd.bounce(dt, Math.min(1, s.laughT) * (s.laughK || 1)); } else s.crowd.bounce(dt, 0);
  }

  function startFilm(s) {
    setPhase(s, 'film');
    useFilmTexture(s);
    s.watched = true;
    if (s.video) s.video.play();
    s.booth.material.color.setHex(0xe8f4ff);
    hint(s, t(s.popcorn ? 'cinema.hint.filmPopcorn' : 'cinema.hint.film'));
    popCounter(s);
    s.stopProjector = s.fx.projector(0.8);
  }
  function endFilm(s) {
    if (s.stopProjector) { s.stopProjector(); s.stopProjector = null; }
    s.booth.material.color.setHex(0x2a3550);
    s.screenMat.map = null;
    s.screenMat.color.setHex(0x15151c);
    s.screenMat.needsUpdate = true;
    s.screen.scale.set(1, 1, 1);
    s.fx.applause(3, 0.7);
    s.laughT = 2.5; s.laughK = 1;
    // back to the seat view to see the room light up
    if (s.full) { s.camPrev = fullCam(); s.full = false; s.camK = 0; }
    setPhase(s, 'lights');
    hint(s, null);
    popCounter(s);
  }
  function endCard(s) {
    s.card = showCard(s.ov.root, {
      title: t('cinema.end.title'),
      lines: [t(s.eaten > 0 ? 'cinema.end.popcorn' : 'cinema.end.line', { n: s.eaten })],
      buttons: [
        { label: t('cinema.end.leave'), key: ['Enter', 'Escape'], onClick: () => { s.card = null; finish({ quit: false }); } },
        { label: t('cinema.end.again'), key: 'KeyR', alt: true, onClick: () => { s.card = null; again(s); } },
      ],
    });
  }
  function again(s) {
    if (s.film) { s.film.dispose(); s.film = null; }
    if (s.video) { s.video.dispose(); s.video = null; }
    loadFilm(s);
    s.camFrom = seatCam(s);
    setPhase(s, 'dim');
  }

  function onKey(e) {
    const s = S;
    if (!s || s.card || e.repeat) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); if (s.phase !== 'lobby' && !s.ending) finish({ quit: s.phase !== 'lights' }); return; }
    if (s.phase === 'walk' && (e.code === 'Space' || e.code === 'Enter')) {
      e.preventDefault(); e.stopPropagation();
      const last = s.walkPath[s.walkPath.length - 1];
      s.me.group.position.set(last.x, floorAt(last.z), last.z);
      sitDown(s);
      return;
    }
    if (s.phase !== 'film') return;
    if (e.code === 'KeyC') { e.preventDefault(); e.stopPropagation(); s.camPrev = s.full ? fullCam() : seatCam(s); s.full = !s.full; s.camK = 0; return; }
    if (e.code === 'Space') {
      e.preventDefault(); e.stopPropagation();
      if (!s.popcorn) return;
      if (s.eaten >= 30) { s.toast(t('cinema.toast.empty'), 1500); return; }
      s.eaten = Math.min(30, s.eaten + 3);
      s.me.emote('drink');
      setTimeout(() => S === s && s.fx.crunch(0.8), 650);
      const k = s.bucket && s.bucket.children.find((o) => o.isInstancedMesh);
      if (k) k.count = Math.max(0, 30 - s.eaten);
      popCounter(s);
    }
  }

  // ---- ui ------------------------------------------------------------------------------------
  function hint(s, text) {
    const el = s.ov.$('.cn-hint');
    el.classList.toggle('mg-hide', !text);
    if (text) el.innerHTML = rich(text);
  }
  function popCounter(s) {
    const el = s.ov.$('.cn-pop');
    el.classList.toggle('mg-hide', !s.popcorn || s.phase !== 'film');
    el.textContent = t('cinema.popcorn', { n: 30 - s.eaten });
  }
  function setPhase(s, p) { s.phase = p; s.phaseT = 0; }

  // ---- ending --------------------------------------------------------------------------------
  function finish(result = {}) {
    const s = S;
    if (!s || s.ending) return;
    s.ending = true;
    const out = { ok: true, quit: !!result.quit, watched: s.watched, popcorn: s.popcorn, eaten: s.eaten, film: s.useOwn ? 'own' : s.filmKind, venue: s.venueId };
    if (s.film) s.film.pause();
    if (s.video) s.video.pause();
    if (s.stopProjector) { s.stopProjector(); s.stopProjector = null; }
    s.fade.out().then(() => {
      teardown();
      s.fade.in().then(() => s.fade.remove());
      s.resolve(out);
    });
  }
  function teardown() {
    const s = S;
    if (!s) return;
    S = null;
    if (s.card) s.card();
    s.offKeys();
    if (s.stopProjector) s.stopProjector();
    if (s.film) s.film.dispose();
    else if (s.filmP) s.filmP.then((f) => f && f !== s.video && f.dispose && f.dispose());
    if (s.video) s.video.dispose();
    s.venue.close();
    s.ov.remove();
  }
  function cancel() {
    const s = S;
    if (!s) return;
    const out = { ok: true, cancelled: true, quit: true, watched: s.watched, popcorn: s.popcorn, film: s.filmKind, venue: s.venueId };
    teardown();
    s.fade.remove();
    s.resolve(out);
  }

  return {
    start, update, cancel,
    get active() { return !!S; },
    get blocksPlayer() { return !!S; },
    debug: {
      get S() { return S; },
      card: (i = 0) => S && S.card && S.card.fire(i),
      phase: () => S && S.phase,
      // tests and screenshots: jump the running film to a time (no sound on the way)
      seek: (time) => S && S.film && S.film.seek(time),
      key: (code) => onKey({ code, repeat: false, preventDefault() {}, stopPropagation() {} }),
    },
  };
}
