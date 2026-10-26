// Relationship ledger for the Super Malul story (docs/SUPER_MALUL.md). Kept apart from the main
// story ledger (rishon.story.v1) so the second story never moves the City Scale.
//   effects: { rel: { noa: +1, havi: -2 }, flag: "noa_knows" | ["a", "b=c"] }
//   conditions: "rel.noa>=3", "noa_knows", "!noa_knows"
// Persistence: localStorage['rishon.hero.ledger.v1'] = { v: 1, rel, flags }.

export const HERO_LEDGER_KEY = 'rishon.hero.ledger.v1';
// noa: reporter (suspicion <-> trust), dudi: sidekick confidence, havi: the villain's wound (grudge <->
// forgiveness), rachel: mentor, orit: fan-club founder.
export const BONDS = ['noa', 'dudi', 'havi', 'rachel', 'orit', 'sarah'];
export const REL_MIN = -10, REL_MAX = 10;
const clamp = (v) => (v < REL_MIN ? REL_MIN : v > REL_MAX ? REL_MAX : v);
const blank = () => ({ v: 1, rel: Object.fromEntries(BONDS.map((b) => [b, 0])), flags: {} });

export function createHeroLedger({ key = HERO_LEDGER_KEY, storage = null, reset = false } = {}) {
  if (!storage) { try { storage = window.localStorage; } catch (_) { storage = { getItem: () => null, setItem: () => {} }; } }
  let state = blank();
  if (!reset) {
    try {
      const s = JSON.parse(storage.getItem(key) || 'null');
      if (s && s.v === 1) state = { ...blank(), rel: { ...blank().rel, ...(s.rel || {}) }, flags: { ...(s.flags || {}) } };
    } catch (_) { /* corrupt or blocked: start fresh */ }
  }
  const save = () => { try { storage.setItem(key, JSON.stringify(state)); } catch (_) { /* storage blocked */ } };
  if (reset) save();

  const api = {
    rel: (id) => state.rel[id] || 0,
    flag: (k) => state.flags[k],
    snapshot: () => JSON.parse(JSON.stringify(state)),
    apply(e) {
      if (!e) return;
      for (const [k, v] of Object.entries(e.rel || {})) if (typeof v === 'number') state.rel[k] = clamp((state.rel[k] || 0) + v);
      for (const f of [].concat(e.flag || [], e.flags || [])) {
        const s = String(f).trim();
        if (!s) continue;
        if (s.startsWith('!')) { delete state.flags[s.slice(1)]; continue; }
        const eq = s.indexOf('=');
        if (eq > 0) state.flags[s.slice(0, eq).trim()] = s.slice(eq + 1).trim(); else state.flags[s] = true;
      }
      save();
    },
    test(c) {
      if (c == null || c === '') return true;
      if (Array.isArray(c)) return c.every((x) => api.test(x));
      const s = String(c).trim();
      if (s.startsWith('!')) return !api.test(s.slice(1));
      const m = /^rel\.(\w+)\s*(>=|<=|>|<|==)\s*(-?\d+)$/.exec(s);
      if (m) {
        const v = api.rel(m[1]), n = +m[3];
        return m[2] === '>=' ? v >= n : m[2] === '<=' ? v <= n : m[2] === '>' ? v > n : m[2] === '<' ? v < n : v === n;
      }
      const eq = s.indexOf('=');
      if (eq > 0) return String(state.flags[s.slice(0, eq).trim()]) === s.slice(eq + 1).trim();
      return !!state.flags[s];
    },
    reset() { state = blank(); save(); },
  };
  return api;
}
