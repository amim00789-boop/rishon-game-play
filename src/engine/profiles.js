// Player profiles: a start screen to pick or create a username, then "continue" (load that
// user's save) or "new game" (start the story over), plus a pause menu (Esc) to save and go
// back to that screen.
//
// Storage: localStorage['rishon.profiles.v1'] = { v: 1, last, profiles: { [name]: { created,
// played, quests, story, player } } }. `quests` and `story` hold the raw JSON the quest system
// and the story ledger keep under their own keys ('rishon.quests.v1', 'rishon.story.v1'): the
// chosen profile is copied into those keys before the quests load, and copied back on every
// save, so neither system needs to know about profiles. A save from before profiles existed
// becomes the first profile.
//
// Automation: ?quests=reset (dev) plays a fresh profile 'dev' without the screen; ?profile=NAME
// continues NAME without the screen; a webdriver browser continues the last profile.
//
// All text comes from i18n keys under 'profile.*' (no display text in this file).

export const PROFILES_KEY = 'rishon.profiles.v1';
const KEYS = { quests: 'rishon.quests.v1', story: 'rishon.story.v1' };
const AUTOSAVE_S = 30;

const storage = (() => {
  try { const k = '__rishon_probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; } catch (_) { /* blocked */ }
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();

function load() {
  try {
    const s = JSON.parse(storage.getItem(PROFILES_KEY) || 'null');
    if (s && s.v === 1 && s.profiles) return s;
  } catch (_) { /* corrupt: start fresh, the old keys are migrated below */ }
  return { v: 1, last: null, profiles: {} };
}

const CSS = `
#profiles { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center;
  background: radial-gradient(circle at 50% 30%, rgba(255, 248, 234, 0.96), rgba(255, 214, 160, 0.97)); font-family: Rubik, system-ui, sans-serif; color: #23324a; }
#profiles.on { display: flex; }
#profiles .pf-card { width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; background: #fffaf0;
  border: 3px solid #23324a; border-radius: 22px; box-shadow: 0 8px 0 #23324a; padding: 22px 22px 18px; }
#profiles h1 { margin: 0 0 4px; font-size: 30px; font-weight: 900; }
#profiles .pf-sub { margin: 0 0 16px; font-weight: 700; opacity: 0.75; }
#profiles .pf-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
#profiles .pf-item { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 14px; border: 2px solid #23324a;
  border-radius: 14px; background: #fff; cursor: pointer; font: inherit; color: inherit; text-align: start; }
#profiles .pf-item.sel { background: #ffcb3d; }
#profiles .pf-item b { font-size: 17px; }
#profiles .pf-item small { opacity: 0.7; font-weight: 600; }
#profiles .pf-new { display: flex; gap: 8px; margin-bottom: 16px; }
#profiles input { flex: 1; min-width: 0; font: inherit; font-size: 16px; padding: 10px 12px; border: 2px solid #23324a; border-radius: 12px; background: #fff; }
#profiles .pf-actions { display: flex; flex-wrap: wrap; gap: 8px; }
#profiles button.pf-btn { font: inherit; font-weight: 800; font-size: 16px; padding: 10px 16px; border: 2px solid #23324a; border-radius: 12px;
  background: #2ec4b6; color: #23324a; cursor: pointer; box-shadow: 0 3px 0 #23324a; }
#profiles button.pf-btn.alt { background: #fff; }
#profiles button.pf-btn.warn { background: #ff8a7a; }
#profiles button.pf-btn:disabled { opacity: 0.45; cursor: default; }
#profiles .pf-msg { min-height: 1.4em; margin-top: 10px; font-weight: 700; color: #b8433a; }
#profiles .pf-confirm { margin-top: 12px; padding: 12px; border: 2px dashed #b8433a; border-radius: 12px; display: none; }
#profiles .pf-confirm.on { display: block; }
#profiles .pf-confirm p { margin: 0 0 10px; font-weight: 700; }
`;

export function createProfiles({ t, dir = () => 'rtl', params = new URLSearchParams(location.search) } = {}) {
  const store = load();
  const save = () => { try { storage.setItem(PROFILES_KEY, JSON.stringify(store)); } catch (e) { console.warn('[profiles] save failed', e); } };

  // A save from before profiles existed becomes the first profile.
  if (!Object.keys(store.profiles).length && (storage.getItem(KEYS.quests) || storage.getItem(KEYS.story))) {
    const name = t('profile.firstName');
    store.profiles[name] = { created: Date.now(), played: Date.now(), quests: storage.getItem(KEYS.quests), story: storage.getItem(KEYS.story), player: null };
    store.last = name;
    save();
  }

  let current = null, snapshot = null, timer = 0, resolveChosen;
  const chosen = new Promise((r) => { resolveChosen = r; });
  let root = null, pauseEl = null, open = false, paused = false;

  // Copy a profile into the working keys (or clear them for a new game) before the quests load.
  function mount(name, fresh) {
    const p = store.profiles[name] || (store.profiles[name] = { created: Date.now(), played: 0, quests: null, story: null, player: null });
    if (fresh) { p.quests = null; p.story = null; p.player = null; }
    for (const [k, key] of Object.entries(KEYS)) {
      if (p[k]) storage.setItem(key, p[k]); else storage.removeItem(key);
    }
    p.played = Date.now();
    store.last = name;
    current = name;
    save();
    const info = { name, fresh: !!fresh, player: p.player || null };
    resolveChosen(info);
    return info;
  }

  // Copy the working keys back into the current profile, with whatever the game adds (position).
  function persist(extra = null) {
    if (!current) return;
    const p = store.profiles[current];
    if (!p) return;
    p.quests = storage.getItem(KEYS.quests);
    p.story = storage.getItem(KEYS.story);
    const more = extra || (snapshot ? snapshot() : null);
    if (more && more.player) p.player = more.player;
    p.played = Date.now();
    save();
  }

  const progressOf = (p) => {
    try { const s = JSON.parse(p.quests || 'null'); return (s && Array.isArray(s.done) ? s.done.filter((id) => /^m\d/.test(id)).length : 0); } catch (_) { return 0; }
  };
  const hasSave = (p) => !!(p && (p.quests || p.story || p.player));

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function buildScreen() {
    if (!document.getElementById('profiles-style')) { const st = el('style'); st.id = 'profiles-style'; st.textContent = CSS; document.head.appendChild(st); }
    root = el('div'); root.id = 'profiles'; root.dir = dir();
    const card = el('div', 'pf-card');
    card.append(el('h1', null, t('profile.title')), el('p', 'pf-sub', t('profile.who')));
    const list = el('div', 'pf-list');
    const newRow = el('div', 'pf-new');
    const input = el('input'); input.maxLength = 20; input.placeholder = t('profile.namePlaceholder'); input.setAttribute('aria-label', t('profile.namePlaceholder'));
    const add = el('button', 'pf-btn alt', t('profile.create'));
    newRow.append(input, add);
    const actions = el('div', 'pf-actions');
    const bCont = el('button', 'pf-btn', t('profile.continue'));
    const bNew = el('button', 'pf-btn alt', t('profile.newGame'));
    const bDel = el('button', 'pf-btn warn', t('profile.delete'));
    actions.append(bCont, bNew, bDel);
    const confirm = el('div', 'pf-confirm');
    const cText = el('p'); const cYes = el('button', 'pf-btn warn'); const cNo = el('button', 'pf-btn alt', t('profile.cancel'));
    const cRow = el('div', 'pf-actions'); cRow.append(cYes, cNo); confirm.append(cText, cRow);
    const msg = el('div', 'pf-msg');
    card.append(list, newRow, actions, confirm, msg);
    root.append(card);
    document.body.appendChild(root);

    let sel = store.last && store.profiles[store.last] ? store.last : Object.keys(store.profiles)[0] || null;
    let pending = null;
    const ask = (text, yesLabel, fn) => { pending = fn; cText.textContent = text; cYes.textContent = yesLabel; confirm.classList.add('on'); };
    const hideAsk = () => { pending = null; confirm.classList.remove('on'); };

    function render() {
      list.textContent = '';
      const names = Object.keys(store.profiles).sort((a, b) => (store.profiles[b].played || 0) - (store.profiles[a].played || 0));
      if (!names.length) list.append(el('div', 'pf-sub', t('profile.none')));
      for (const name of names) {
        const p = store.profiles[name];
        const b = el('button', 'pf-item' + (name === sel ? ' sel' : ''));
        b.append(el('b', null, name), el('small', null, hasSave(p) ? t('profile.progress', { n: progressOf(p) }) : t('profile.empty')));
        b.addEventListener('click', () => { sel = name; hideAsk(); msg.textContent = ''; render(); });
        b.addEventListener('dblclick', () => { sel = name; if (hasSave(store.profiles[name])) go(false); });
        list.append(b);
      }
      const p = sel && store.profiles[sel];
      bCont.disabled = !p || !hasSave(p);
      bNew.disabled = !p; bDel.disabled = !p;
    }

    function go(fresh) {
      close();
      mount(sel, fresh);
    }

    add.addEventListener('click', () => {
      const name = input.value.trim().replace(/\s+/g, ' ');
      if (!name) { msg.textContent = t('profile.needName'); return; }
      if (store.profiles[name]) { sel = name; msg.textContent = t('profile.exists'); render(); return; }
      store.profiles[name] = { created: Date.now(), played: Date.now(), quests: null, story: null, player: null };
      save();
      sel = name; input.value = ''; msg.textContent = ''; render();
    });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') add.click(); });
    bCont.addEventListener('click', () => { if (sel) go(false); });
    bNew.addEventListener('click', () => {
      if (!sel) return;
      if (hasSave(store.profiles[sel])) ask(t('profile.confirmNew', { name: sel }), t('profile.yesNew'), () => go(true));
      else go(true);
    });
    bDel.addEventListener('click', () => {
      if (!sel) return;
      ask(t('profile.confirmDelete', { name: sel }), t('profile.yesDelete'), () => {
        delete store.profiles[sel];
        if (store.last === sel) store.last = null;
        save();
        sel = Object.keys(store.profiles)[0] || null; hideAsk(); render();
      });
    });
    cYes.addEventListener('click', () => { const fn = pending; hideAsk(); if (fn) fn(); });
    cNo.addEventListener('click', hideAsk);
    // Keys typed here must not drive the player behind the screen.
    root.addEventListener('keydown', (e) => e.stopPropagation());
    render();
    if (!sel) input.focus();
  }

  function show() { if (!root) buildScreen(); root.classList.add('on'); open = true; }
  function close() { if (root) root.classList.remove('on'); open = false; }

  // ---------- pause menu (Esc) ----------
  function buildPause() {
    pauseEl = el('div'); pauseEl.id = 'profiles-pause'; pauseEl.dir = dir();
    pauseEl.style.cssText = 'position:fixed;inset:0;z-index:59;display:none;align-items:center;justify-content:center;background:rgba(35,50,74,0.45);font-family:Rubik,system-ui,sans-serif;color:#23324a;';
    const card = el('div', 'pf-card');
    card.style.cssText = 'width:min(380px,calc(100vw - 32px));background:#fffaf0;border:3px solid #23324a;border-radius:22px;box-shadow:0 8px 0 #23324a;padding:20px;display:flex;flex-direction:column;gap:10px;';
    const h = el('h2', null, t('profile.paused', { name: current || '' })); h.style.margin = '0 0 6px';
    const mk = (label, cls, fn) => { const b = el('button', cls, label); b.style.cssText = 'font:inherit;font-weight:800;font-size:16px;padding:11px 16px;border:2px solid #23324a;border-radius:12px;cursor:pointer;box-shadow:0 3px 0 #23324a;background:' + (cls === 'alt' ? '#fff' : '#2ec4b6'); b.addEventListener('click', fn); return b; };
    const note = el('div'); note.style.cssText = 'min-height:1.2em;font-weight:700;opacity:0.75;';
    card.append(h,
      mk(t('profile.resume'), '', () => hidePause()),
      mk(t('profile.save'), 'alt', () => { persist(); note.textContent = t('profile.saved'); }),
      mk(t('profile.saveQuit'), 'alt', () => { persist(); location.href = location.pathname; }),
      note);
    pauseEl.append(card);
    document.body.appendChild(pauseEl);
  }
  function showPause() { if (!pauseEl) buildPause(); pauseEl.style.display = 'flex'; paused = true; }
  function hidePause() { if (pauseEl) pauseEl.style.display = 'none'; paused = false; }

  const api = {
    get open() { return open || paused; },
    get current() { return current; },
    chosen,
    // Set each frame by the game: whether Esc may open the pause menu now (no dialogue, map or
    // mini-game is using Esc). Read at keydown, so the frame before the key counts.
    pausable: false,
    // Starts the flow: the screen, or an automatic choice for tests.
    start() {
      const dev = params.get('quests') === 'reset';
      const named = params.get('profile');
      if (dev) return mount(named || 'dev', true);
      if (named) return mount(named, false);
      if (navigator.webdriver) return mount(store.last || 'dev', false);
      show();
      return null;
    },
    // Autosave every 30 s once a profile is playing; `fn` returns { player: {x, z, heading, mode} }.
    autosave(fn) {
      snapshot = fn;
      clearInterval(timer);
      timer = setInterval(() => persist(), AUTOSAVE_S * 1000);
      addEventListener('pagehide', () => persist());
    },
    save: persist,
    profiles: () => Object.keys(store.profiles),
  };

  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || e.repeat || open) return;
    if (paused) { hidePause(); e.preventDefault(); return; }
    if (!current || !api.pausable) return;
    showPause();
    e.preventDefault();
  });

  return api;
}
