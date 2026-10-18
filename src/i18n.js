// Display-text lookup. Every player-facing string lives in JSON under data/ (data/i18n/<lang>.json,
// data/quests/strings.<lang>.json); source files hold keys only, so a language is a data change.
// Hebrew is the shipped language; English is the dev fallback for any key the active table lacks.
// ?lang=en switches for debugging.

const RTL = new Set(['he', 'ar']);
const tables = { active: {}, fallback: {} };
export const i18n = { lang: 'he' };

// 'no-cache' revalidates with the server: a static server sends no cache headers, so the browser
// would otherwise keep serving an old table after the text was edited.
async function getJson(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// Loads the UI table for the active language plus the English fallback. Never throws: with no
// tables at all, t() returns its fallback argument or the key, and the game still runs.
export async function loadI18n(base = './data/i18n/', lang) {
  i18n.lang = lang || new URLSearchParams(location.search).get('lang') || 'he';
  const [active, fallback] = await Promise.all([
    getJson(`${base}${i18n.lang}.json`).catch((e) => { console.warn('[i18n] missing table', i18n.lang, e.message); return {}; }),
    i18n.lang === 'en' ? Promise.resolve(null) : getJson(`${base}en.json`).catch(() => ({})),
  ]);
  tables.active = active;
  tables.fallback = fallback || active;
  document.documentElement.lang = i18n.lang;
}

// Adds a table under a key prefix, e.g. register('quest', strings.he, strings.en) makes
// t('quest.q1_speaker.title') resolve.
export function register(prefix, active, fallback) {
  tables.active[prefix] = active || {};
  tables.fallback[prefix] = fallback || active || {};
}

export const isRtl = () => RTL.has(i18n.lang);
export const dir = () => (isRtl() ? 'rtl' : 'ltr');

const lookup = (table, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), table);

// t('hud.modes.walk'), t('quest.ui.talk', { name }). Strings get {var} substitution; arrays and
// objects (dialogue lines) come back as they are. A missing key returns `fallback`, else the key,
// so gaps are visible in play rather than blank.
export function t(key, vars, fallback) {
  let v = lookup(tables.active, key);
  if (v == null) v = lookup(tables.fallback, key);
  if (v == null) return fallback ?? key;
  if (typeof v === 'string' && vars) v = v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return v;
}

// HTML for a UI string: escapes it and turns {k:F} into an isolated left-to-right key cap, so
// key names and Latin text keep their order inside right-to-left sentences.
export function rich(text) {
  const esc = String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return esc.replace(/\{k:([^}]+)\}/g, '<kbd dir="ltr">$1</kbd>');
}

// Landmark display names are keyed by poi id; the English parody name from the landmarks
// module is the fallback.
export const poiName = (p) => t(`poi.${p.id}`, null, p.name || p.id);

// Neighbourhoods carry the OSM local (Hebrew) name as nameLocal and the English one as name
// (older builds: name / nameEn).
export const placeName = (p) => (isRtl() ? p.nameLocal || p.name : p.nameEn || p.name || p.nameLocal) || p.id;
