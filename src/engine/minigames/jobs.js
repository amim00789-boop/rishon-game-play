// The job framework (docs/JOBS.md 8.1): one entry point that runs a job's game, turns its 0..100
// score into stars and pay, saves the best (src/engine/jobs/store.js) and shows the shared result
// card. Each job is a normal minigame ({ start, update, cancel, active, blocksPlayer }) that
// resolves { ok, score, lines?: [...] } and shows no result card of its own.
//
//   const r = await mg.jobs.start({ job: 'bus' });   // the id in data/jobs/jobs.json
//   // r = { ok, job, score, stars, earned, best, newBest, tries, quit }
import { createOverlay, addStyle, textFn, showCard } from './common.js';
import { getSynth } from './synth.js';
import { createJobStore } from '../jobs/store.js';
import { loadJobStrings, loadJobDefs } from '../jobs/strings.js';
import { starsOf, payOf } from '../jobs/stars.js';

export { loadJobStrings, loadJobDefs, createJobStore };

const STARS = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);

export function createJobs(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  const store = deps.jobStore || createJobStore();
  let S = null;
  addStyle('mg-style-jobs', '.mg-jobs .jb-stars { font-size: 34px; letter-spacing: 4px; color: #ffb000; -webkit-text-stroke: 1px #23324a; margin: 2px 0 6px; }');

  async function start(config = {}) {
    if (S) cancel();
    const [defs] = await Promise.all([loadJobDefs(), loadJobStrings()]);
    const def = defs[config.job];
    const game = def && deps.games && deps.games[def.game];
    if (!def || !game) return { ok: false, job: config.job, error: 'unknown job' };
    return new Promise((resolve) => {
      const ov = createOverlay('mg-jobs');
      S = { cfg: config, def, game, ov, resolve, tries: 0, card: null, cancelled: false, phase: 'card' };
      if (config.skipIntro || config.autoContinue) run(); else intro();
    });
  }

  // The offer: what the job is, the saved best, Start or Not now. Blocks the player like any card.
  function intro() {
    const s = S, id = `jobs.${s.def.game}`, best = store.best(s.cfg.job);
    s.phase = 'card';
    s.card = showCard(s.ov.root, { title: t(`${id}.name`), big: s.def.icon || '', lines: [t(`${id}.pitch`),
        best ? `${STARS(best.stars)}  ·  ${t('jobs.ui.best', { n: best.score })}` : t('jobs.ui.noBest')],
      buttons: [
        { label: t('jobs.ui.start'), key: ['Enter', 'KeyF'], onClick: () => { s.card = null; run(); } },
        { label: t('jobs.ui.notNow'), key: ['Escape'], alt: true, onClick: () => finish({ ok: false, job: s.cfg.job, quit: true, declined: true, tries: 0 }) },
      ] });
  }

  async function run() {
    const s = S;
    if (s.card) { s.card(); s.card = null; }
    s.phase = 'play';
    let r;
    try { r = await s.game.start({ ...s.def.params, ...(s.cfg.params || {}), autoContinue: s.cfg.autoContinue }); } catch (e) { console.error('[jobs] game failed', e); r = { ok: false, error: String(e) }; }
    if (S !== s || s.cancelled) return;
    if (r && r.cancelled) return;
    s.phase = 'card';
    if (!r || !r.ok) return failCard(s, r || {});
    const score = Math.max(0, Math.min(100, Math.round(r.score)));
    const stars = starsOf(score);
    const earned = payOf(s.def.pay || {}, stars);
    const { newBest, best } = store.record(s.cfg.job, { score, stars, earned });
    synth.play('win');
    const id = `jobs.${s.def.game}`;
    const lines = [];
    if (r.summary) lines.push(r.summary);
    lines.push(t('jobs.ui.earned', { n: earned }), t('jobs.ui.score', { n: score }) + '  ·  ' + (newBest ? t('jobs.ui.newBest') : t('jobs.ui.best', { n: best.score })), t('jobs.ui.total', { n: store.total }));
    const out = { ok: true, job: s.cfg.job, score, stars, earned, best, newBest, tries: s.tries + 1, quit: false, detail: r.detail || null };
    s.out = out;
    s.card = showCard(s.ov.root, { title: t(`${id}.passTitle`), big: STARS(stars), lines,
      buttons: [
        { label: t('jobs.ui.again'), key: ['Enter'], onClick: () => { s.tries++; run(); } },
        { label: t('jobs.ui.done'), key: ['Escape'], alt: true, onClick: () => finish(out) },
      ] });
    if (s.cfg.autoContinue) setTimeout(() => S === s && s.card && finish(out), 700);
  }

  function failCard(s, r) {
    synth.play('fail');
    const id = `jobs.${s.def.game}`;
    if (r.quit) return finish({ ok: false, job: s.cfg.job, quit: true, tries: s.tries + 1 });
    s.card = showCard(s.ov.root, { title: t(`${id}.failTitle`), lines: [t(`${id}.failLine`)],
      buttons: [
        { label: t('jobs.ui.retry'), key: ['Enter'], onClick: () => { s.tries++; run(); } },
        { label: t('jobs.ui.done'), key: ['Escape'], alt: true, onClick: () => finish({ ok: false, job: s.cfg.job, quit: true, tries: s.tries + 1, reason: r.reason || null }) },
      ] });
  }

  function finish(out) {
    const s = S;
    if (!s) return;
    S = null;
    if (s.card) s.card();
    s.ov.remove();
    s.resolve(out);
  }

  function cancel() {
    const s = S;
    if (!s) return;
    s.cancelled = true;
    if (s.game.active) s.game.cancel();
    finish({ ok: false, job: s.cfg.job, cancelled: true, tries: s.tries });
  }

  return {
    start, cancel,
    update() { /* the job's own game is updated by the registry */ },
    get active() { return !!S; },
    // Blocks while a result card is up; the game underneath decides for itself while it plays.
    get blocksPlayer() { return !!S && S.phase === 'card'; },
    store,
    debug: {
      state: () => (S ? { job: S.cfg.job, phase: S.phase, tries: S.tries } : null),
      card: (i = 0) => S && S.card && S.card.fire(i),
    },
  };
}
