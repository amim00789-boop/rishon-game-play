// Job text lives in data/minigames/jobs.<lang>.json and is registered under `jobs`, so
// t('jobs.bus.title') resolves. Started by createJobs; await it when the first frame needs it.
import { register, i18n } from '../../i18n.js';

let stringsP = null;
export function loadJobStrings(base = new URL('../../../data/minigames/', import.meta.url).href) {
  if (stringsP) return stringsP;
  const get = (lang) => fetch(`${base}jobs.${lang}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`jobs.${lang}.json: HTTP ${r.status}`))));
  stringsP = (async () => {
    const fallback = await get('en').catch((e) => { console.warn('[jobs] no English strings', e.message); return {}; });
    const active = i18n.lang === 'en' ? fallback : await get(i18n.lang).catch(() => null);
    register('jobs', active || fallback, fallback);
  })();
  return stringsP;
}

let defsP = null;
// data/jobs/jobs.json: the job definitions and their start spots.
export function loadJobDefs(base = new URL('../../../data/jobs/', import.meta.url).href) {
  if (!defsP) defsP = fetch(`${base}jobs.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`jobs.json: HTTP ${r.status}`)))).then((d) => d.jobs || {});
  return defsP;
}
