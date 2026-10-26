// Automatic quality steps for weaker machines.
//
// The game was tuned on a fast laptop. On a slower one (or a retina screen, where pixel ratio
// 1.5 means 2.25x the pixels) every frame runs long and the whole game feels laggy. This watches
// the real frame cadence and, when it stays slow, lowers render resolution first (the cheapest
// change to see), then bloom, then the shadow map. When there is plenty of headroom it steps back
// up one level, at most a few times, so it does not flip back and forth.
//
// ?quality=0..4 pins a level (0 = full); ?quality=auto (default) adapts.

const LEVELS = [
  { pr: 1.5, bloom: true, shadow: 2048 },
  { pr: 1.25, bloom: true, shadow: 2048 },
  { pr: 1.0, bloom: true, shadow: 2048 },
  { pr: 0.85, bloom: false, shadow: 2048 },
  { pr: 0.75, bloom: false, shadow: 1024 },
];
const WINDOW_MS = 2500;     // judge the median frame over this long
const SLOW_MS = 21;         // median above this (under ~48 fps) steps down
const FAST_MS = 12.5;       // median under this for UP_AFTER windows steps back up
const UP_AFTER = 4;
const MAX_UPS = 2;
const GRACE_MS = 4000;      // after a change, let shaders and buffers settle before judging

export function createQuality({ renderer, post, sun, onResize, params = new URLSearchParams(location.search) }) {
  const dpr = window.devicePixelRatio || 1;
  const pinned = params.has('quality') && params.get('quality') !== 'auto' ? Math.max(0, Math.min(LEVELS.length - 1, +params.get('quality') | 0)) : null;
  // the top level never renders above the screen's own ratio
  const prFor = (l) => Math.min(dpr, post ? LEVELS[l].pr : Math.min(2, LEVELS[l].pr + 0.5));
  let level = 0, ups = 0, fastWindows = 0, since = performance.now(), changedAt = -Infinity;
  // A CPU-bound machine gains nothing from fewer pixels; a step down that does not help is
  // undone and the descent stops there, so the picture is not blurred for nothing.
  let lastMedian = null, probing = false, prevLevel = 0, floor = LEVELS.length - 1;
  const gaps = [];
  // a hidden tab, a dialog or a load hitch is not "the machine is slow"
  let paused = false;

  // on a 1x screen the first steps change nothing (the ratio is already 1); skip to a real change
  const same = (a, b) => prFor(a) === prFor(b) && LEVELS[a].bloom === LEVELS[b].bloom && LEVELS[a].shadow === LEVELS[b].shadow;
  function nextDiffering(l) { let n = l + 1; while (n < LEVELS.length - 1 && same(n, l)) n++; return n; }

  function apply(l) {
    level = l;
    const L = LEVELS[l];
    const p = prFor(l);
    if (Math.abs(renderer.getPixelRatio() - p) > 1e-3) {
      renderer.setPixelRatio(p);
      onResize();
    }
    if (post && post.bloom) post.bloom.enabled = L.bloom;
    if (sun && sun.shadow.mapSize.x !== L.shadow) {
      sun.shadow.mapSize.set(L.shadow, L.shadow);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    changedAt = performance.now();
    gaps.length = 0;
  }

  function frame(dtMs) {
    if (pinned !== null || paused) return;
    const now = performance.now();
    if (now - changedAt < GRACE_MS) { since = now; return; }
    // a single huge gap is a hitch (tab switch, streaming), not a frame rate
    if (dtMs < 250) gaps.push(dtMs);
    if (now - since < WINDOW_MS || gaps.length < 30) return;
    since = now;
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    gaps.length = 0;
    if (probing) {
      probing = false;
      if (median > lastMedian * 0.9) { const back = prevLevel; floor = back; apply(back); return; }
    }
    if (median > SLOW_MS && level < floor) { fastWindows = 0; lastMedian = median; probing = true; prevLevel = level; apply(Math.min(floor, nextDiffering(level))); return; }
    if (median < FAST_MS && level > 0 && ups < MAX_UPS) {
      if (++fastWindows >= UP_AFTER) { fastWindows = 0; ups++; apply(level - 1); }
    } else fastWindows = 0;
  }

  apply(pinned ?? 0);
  document.addEventListener('visibilitychange', () => { gaps.length = 0; since = performance.now(); });
  return {
    frame,
    set paused(v) { paused = !!v; if (v) gaps.length = 0; },
    get level() { return level; },
    state: () => ({ level, floor, pinned, pr: renderer.getPixelRatio(), bloom: !!(post && post.bloom && post.bloom.enabled), shadow: sun ? sun.shadow.mapSize.x : null }),
    set: (l) => apply(Math.max(0, Math.min(LEVELS.length - 1, l | 0))),
  };
}
