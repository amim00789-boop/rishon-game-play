// Story state for V2 ("Four Winds"): the City Scale (me first <-> together), trust per sector
// and free-form flags. Every quest option, step result and minigame result may carry effects:
//   { scale: +2, trust: { haredi: +1, secular: -1 }, flag: "gen_to=yeshiva", flags: ["helped_man"] }
// Persistence: localStorage['rishon.story.v1'] = { v: 1, scale, trust, flags, log }.
//
//   const story = createStory();          story.apply(result.effects);
//   story.test('gen_to=yeshiva')  story.test('!helped_man')  story.testScale('>=5')
//   story.tier() -> 'low' | 'mid' | 'high'   (dialogue variants: key@scaleHigh etc.)

export const STORY_KEY = 'rishon.story.v1';
export const SECTORS = ['haredi', 'dati', 'secular', 'street', 'russian', 'elders', 'youth'];
export const SCALE_MIN = -20, SCALE_MAX = 20;
export const TRUST_MIN = -10, TRUST_MAX = 10;
const TIER_HIGH = 8, TIER_LOW = -4;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const blank = () => ({ v: 1, scale: 0, trust: Object.fromEntries(SECTORS.map((s) => [s, 0])), flags: {}, log: [] });

export function createStory({ key = STORY_KEY, storage = safeStorage(), reset = false } = {}) {
  let state = blank();
  if (!reset) {
    try {
      const s = JSON.parse(storage.getItem(key) || 'null');
      if (s && s.v === 1) state = { ...blank(), ...s, trust: { ...blank().trust, ...(s.trust || {}) }, flags: { ...(s.flags || {}) }, log: s.log || [] };
    } catch (_) { /* corrupt or blocked: start fresh */ }
  }
  const listeners = [];
  const save = () => { try { storage.setItem(key, JSON.stringify(state)); } catch (_) { /* storage blocked */ } };
  const emit = (change) => { for (const fn of listeners) { try { fn(change, api); } catch (e) { console.warn('[story] listener failed', e); } } };
  if (reset) save();

  // "name=value" sets name to value; "name" sets it to true; "!name" clears it.
  function setFlag(f, value) {
    if (value !== undefined) { state.flags[f] = value; return; }
    const s = String(f).trim();
    if (!s) return;
    if (s.startsWith('!')) { delete state.flags[s.slice(1)]; return; }
    const eq = s.indexOf('=');
    if (eq > 0) state.flags[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
    else state.flags[s] = true;
  }

  const api = {
    get scale() { return state.scale; },
    get trust() { return { ...state.trust }; },
    get flags() { return { ...state.flags }; },
    trustOf(sector) { return state.trust[sector] || 0; },
    flag(name) { return state.flags[name]; },
    setFlag(name, value) { setFlag(name, value); save(); emit({ flags: [name] }); },

    // Applies an effects object (or an array of them). `source` is a short id for the log
    // (quest/step), so the M15 contributor list can show what the player chose.
    apply(effects, source = '') {
      const list = Array.isArray(effects) ? effects : [effects];
      const change = { scale: 0, trust: {}, flags: [] };
      for (const e of list) {
        if (!e) continue;
        if (e.scale) { const before = state.scale; state.scale = clamp(state.scale + e.scale, SCALE_MIN, SCALE_MAX); change.scale += state.scale - before; }
        for (const [s, d] of Object.entries(e.trust || {})) {
          if (!SECTORS.includes(s)) console.warn('[story] unknown sector', s);
          state.trust[s] = clamp((state.trust[s] || 0) + d, TRUST_MIN, TRUST_MAX);
          change.trust[s] = (change.trust[s] || 0) + d;
        }
        for (const f of [].concat(e.flag || [], e.flags || [])) { setFlag(f); change.flags.push(f); }
      }
      if (change.scale || Object.keys(change.trust).length || change.flags.length) {
        state.log.push({ at: Date.now(), source, ...change });
        if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
        save();
        emit(change);
      }
      return change;
    },

    // Condition strings used by `if:` in quest data. Space-separated terms must all hold:
    //   "gen_to=yeshiva"  "!helped_man"  "helped_man"  "scale>=5"  "trust.haredi>2"
    test(cond) {
      if (!cond) return true;
      return String(cond).trim().split(/\s+/).every((term) => {
        const m = term.match(/^(scale|trust\.(\w+))\s*(>=|<=|>|<|==)\s*(-?\d+)$/);
        if (m) return cmp(m[1] === 'scale' ? state.scale : (state.trust[m[2]] || 0), m[3], +m[4]);
        if (term.startsWith('!')) return !state.flags[term.slice(1)];
        const eq = term.indexOf('=');
        if (eq > 0) return String(state.flags[term.slice(0, eq)]) === term.slice(eq + 1);
        return !!state.flags[term];
      });
    },
    // ifScale: ">=5"
    testScale(expr) {
      const m = String(expr || '').match(/^(>=|<=|>|<|==)\s*(-?\d+)$/);
      return m ? cmp(state.scale, m[1], +m[2]) : true;
    },
    tier() { return state.scale >= TIER_HIGH ? 'high' : state.scale <= TIER_LOW ? 'low' : 'mid'; },
    // Dialogue variant: 'm16.d.outro' -> 'm16.d.outro@scaleHigh' when `has(key)` says it exists.
    variant(baseKey, has) {
      const k = `${baseKey}@scale${api.tier() === 'high' ? 'High' : api.tier() === 'low' ? 'Low' : 'Mid'}`;
      return has && has(k) ? k : baseKey;
    },
    // Sectors whose trust is below `min` (the M16 pickups).
    lowTrust(min = 1) { return SECTORS.filter((s) => (state.trust[s] || 0) < min); },
    // Display value 0..1 for the HUD balance icon: 0 = me first, 1 = together.
    balance() { return (state.scale - SCALE_MIN) / (SCALE_MAX - SCALE_MIN); },
    onChange(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    log() { return state.log.slice(); },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
    reset() { state = blank(); save(); emit({ reset: true }); },
  };
  return api;
}

function cmp(a, op, b) {
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
    default: return a === b;
  }
}

function safeStorage() {
  try { if (typeof localStorage !== 'undefined') return localStorage; } catch (_) { /* blocked */ }
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
