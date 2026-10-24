// Minigames that quest steps can drive. Each one is
//   create<Name>(deps) -> { start(config) -> Promise<result>, update(dt, input), cancel(), active, blocksPlayer, debug }
// deps = { scene, camera, player, city, t, hud?, audio?, traffic?, crowd?, collision?, surface?, makeAvatar?, renderer?, sky? }
// See docs/MINIGAMES.md for every config and result.
//
//   import { createMinigames, loadMinigameStrings, createStory } from './minigames/index.js';
//   await loadMinigameStrings();
//   const mg = createMinigames(deps);
//   const res = await mg.rhythm.start({ chart: 'beach_soundcheck' });
//   per frame: mg.update(dt, input); freeze the player while mg.blocksPlayer.
import { createRhythm } from './rhythm.js';
import { createRace } from './race.js';
import { createPassenger } from './passenger.js';
import { createPhoto } from './photo.js';
import { createParking } from './parking.js';
import { createCrowdGuide } from './crowdguide.js';
import { createDebate } from './debate.js';
import { createSurf, loadSurfStrings } from './surf.js';
import { createSkate, loadSkateStrings } from './skate.js';
import { createCinema, loadCinemaStrings } from './cinema.js';
import { createBus } from './bus.js';
import { createBakery } from './bakery.js';
import { createJobs, loadJobStrings, loadJobDefs } from './jobs.js';
import { jumpToStart } from './common.js';
import { getGps } from '../gps.js';

export { createRhythm, createRace, createPassenger, createPhoto, createParking, createCrowdGuide, createDebate, createSurf, loadSurfStrings, createSkate, loadSkateStrings, createCinema, loadCinemaStrings, createBus, createBakery, createJobs, loadJobStrings, loadJobDefs };
export { createStory, STORY_KEY, SECTORS } from './story.js';
export { loadMinigameStrings, mergeEffects, jumpToStart } from './common.js';
export { getGps, createGps, gpsMode } from '../gps.js';
export { getSynth } from './synth.js';

export function createMinigames(deps) {
  const games = {
    rhythm: createRhythm(deps),
    race: createRace(deps),
    passenger: createPassenger(deps),
    photo: createPhoto(deps),
    parking: createParking(deps),
    crowdguide: createCrowdGuide(deps),
    debate: createDebate(deps),
    // The surf club side activity (docs/MINIGAMES.md section 8); its text loads on its own.
    surf: createSurf(deps),
    // The skate bowl at HaTeder (act_skate, and m08's trick list); its text loads on its own.
    skate: createSkate(deps),
    // A night at the movies at Cinema City or Yes Planet (docs/CINEMA.md); its text loads on its own.
    cinema: createCinema(deps),
    // The jobs (docs/JOBS.md): job games shown through the shared result card of `jobs`.
    bus: createBus(deps),
    bakery: createBakery(deps),
  };
  games.jobs = createJobs({ ...deps, games });
  const list = Object.values(games);
  // Shared route guidance (one ribbon per scene). The race and the passenger ride drive it while
  // they run; quest steps can use it too and then call gps.update(dt, player) every frame.
  const gps = getGps(deps);
  // Build the street graph in the background a moment after boot (about 2 s of work in 10 ms slices).
  setTimeout(() => { try { gps.warm(); } catch (e) { console.warn('[minigames] gps warm failed', e); } }, 2500);
  return {
    ...games,
    gps,
    // Fade, teleport the player (with vehicle) to a start, fade in: docs/MINIGAMES.md section 7.
    jumpToStart: (spot, opts) => jumpToStart(deps, spot, opts),
    // Any minigame running?
    get active() { return list.some((g) => g.active); },
    // The quest system freezes the player (FROZEN input) and skips its own talk prompt while true.
    get blocksPlayer() { return list.some((g) => g.active && g.blocksPlayer); },
    // Name of the running minigame, or null.
    get current() { return Object.keys(games).find((k) => games[k].active) || null; },
    update(dt, input) {
      for (const g of list) {
        if (!g.active) continue;
        try { g.update(dt, input); } catch (e) { console.error('[minigames] update failed', e); g.cancel(); }
      }
    },
    cancelAll() { for (const g of list) if (g.active) g.cancel(); },
  };
}
