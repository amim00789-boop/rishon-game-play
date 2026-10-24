// Saved results of the jobs (docs/JOBS.md): best score, stars and pay per job, plus a running
// total. Its own key, never rishon.story.v1: the story ledger has a closed schema.
export const JOBS_KEY = 'rishon.jobs.v1';

const blank = () => ({ v: 1, total: 0, best: {} });

export function createJobStore(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  let data = blank();
  try {
    const raw = storage && storage.getItem(JOBS_KEY);
    const parsed = raw && JSON.parse(raw);
    if (parsed && parsed.v === 1 && parsed.best) data = { ...blank(), ...parsed };
  } catch (_) { /* a corrupt save starts fresh */ }
  const save = () => { try { storage && storage.setItem(JOBS_KEY, JSON.stringify(data)); } catch (_) { /* private mode */ } };
  return {
    get total() { return data.total; },
    best: (id) => data.best[id] || null,
    // Records a finished shift; returns { newBest, best }. Pay is added every time, the best only
    // moves up (by score, then stars).
    record(id, { score, stars, earned }) {
      const prev = data.best[id];
      const newBest = !prev || score > prev.score;
      if (newBest) data.best[id] = { score, stars: Math.max(stars, prev ? prev.stars : 0), earned: Math.max(earned, prev ? prev.earned : 0) };
      else if (stars > prev.stars) prev.stars = stars;
      data.total += earned;
      save();
      return { newBest, best: data.best[id] };
    },
    reset() { data = blank(); save(); },
  };
}
