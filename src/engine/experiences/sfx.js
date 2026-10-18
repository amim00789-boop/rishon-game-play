// Synthesised sound for the experiences: audience laughs and applause, a T-rex roar, popcorn
// crunch, sandwich bites, film-score melodies and cartoon gibberish for the actors. It shares the
// minigame synth's AudioContext (synth.js) and follows the game's mute setting.
//
//   const fx = getSfx(deps.audio);  fx.laugh(0.8);  fx.applause(3);  fx.talk(1.2, 'high');
import { getSynth } from '../minigames/synth.js';

let shared = null;
export function getSfx(audio = null) {
  if (shared) { if (audio) shared.setAudio(audio); return shared; }
  shared = createSfx(audio);
  return shared;
}

function createSfx(audioMod) {
  const synth = getSynth(audioMod);
  let audio = audioMod, out = null, noiseBuf = null, ctxRef = null;
  const VOL = 0.6;

  function ctx() {
    const c = synth.ensure();
    if (!c) return null;
    if (c !== ctxRef) {
      ctxRef = c;
      out = c.createGain();
      out.connect(c.destination);
      const n = c.sampleRate * 2;
      noiseBuf = c.createBuffer(1, n, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let seed = 777;
      for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = (seed / 0x3fffffff) - 1; }
    }
    out.gain.value = audio && audio.muted ? 0 : VOL;
    return c;
  }
  const rnd = Math.random;

  function env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function noise(c, t, dur, peak, type, freq, q = 1, attack = 0.004) {
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
    env(g, t, attack, peak, dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, rnd() * 1.5); s.stop(t + attack + dur + 0.05);
  }
  function tone(c, type, f, t, dur, peak, attack = 0.005, dest = out) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    env(g, t, attack, peak, dur);
    o.connect(g).connect(dest); o.start(t); o.stop(t + attack + dur + 0.05);
    return o;
  }
  // One voiced syllable through two formants ("ha", "blah"): pitch f0, vowel formants f1/f2.
  function syllable(c, t, f0, dur, peak, f1 = 750, f2 = 1200, glide = 0) {
    const o = c.createOscillator(), g = c.createGain(), b1 = c.createBiquadFilter(), b2 = c.createBiquadFilter(), m = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    if (glide) o.frequency.linearRampToValueAtTime(f0 * (1 + glide), t + dur);
    b1.type = b2.type = 'bandpass'; b1.frequency.value = f1; b2.frequency.value = f2; b1.Q.value = 6; b2.Q.value = 8;
    m.gain.value = 1;
    env(g, t, 0.02, peak, dur);
    o.connect(b1); o.connect(b2); b1.connect(m); b2.connect(m); m.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.08);
  }

  const api = {
    setAudio(a) { audio = a; synth.setAudio(a); },
    get now() { const c = ctx(); return c ? c.currentTime : 0; },
    synth,
    // An audience laugh: many "ha"s at different pitches, swelling and fading.
    laugh(v = 1, dur = 1.6, people = 9) {
      const c = ctx(); if (!c) return;
      const t0 = c.currentTime + 0.02;
      for (let p = 0; p < people; p++) {
        const f0 = 110 + rnd() * 190, start = t0 + rnd() * 0.25, rate = 0.13 + rnd() * 0.07;
        const n = Math.floor((dur * (0.6 + rnd() * 0.4)) / rate);
        for (let i = 0; i < n; i++) {
          const k = i / n, amp = 0.05 * v * Math.sin(Math.PI * Math.min(1, k * 1.4 + 0.1)) / Math.sqrt(people / 6);
          syllable(c, start + i * rate, f0 * (1 - k * 0.15), rate * 0.7, amp, 650 + rnd() * 200, 1100 + rnd() * 300, -0.08);
        }
      }
      noise(c, t0, dur, 0.04 * v, 'bandpass', 1500, 0.5, 0.2);
    },
    // Applause: random hand claps thinning out at the end.
    applause(dur = 3, v = 1, rate = 38) {
      const c = ctx(); if (!c) return;
      const t0 = c.currentTime + 0.02;
      const n = Math.floor(dur * rate);
      for (let i = 0; i < n; i++) {
        const t = t0 + rnd() * dur, k = (t - t0) / dur;
        const amp = 0.12 * v * (k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.6) / 0.4) * 0.9);
        noise(c, t, 0.03 + rnd() * 0.03, Math.max(0.005, amp), 'bandpass', 900 + rnd() * 1600, 1.4, 0.001);
      }
    },
    cheer(dur = 2, v = 1) {
      const c = ctx(); if (!c) return;
      const t0 = c.currentTime + 0.02;
      noise(c, t0, dur, 0.1 * v, 'bandpass', 1300, 0.7, 0.25);
      for (let i = 0; i < 6; i++) syllable(c, t0 + rnd() * 0.4, 220 + rnd() * 160, dur * 0.6, 0.05 * v, 800, 1300, 0.2);
      api.applause(dur, v * 0.8);
    },
    whistle(v = 1) {
      const c = ctx(); if (!c) return;
      const t = c.currentTime + 0.02, o = tone(c, 'sine', 1800, t, 0.5, 0.12 * v, 0.03);
      o.frequency.linearRampToValueAtTime(2600, t + 0.18); o.frequency.linearRampToValueAtTime(1500, t + 0.5);
    },
    // Cartoon gibberish while an actor talks; pitch: 'low' | 'mid' | 'high'.
    talk(dur = 1, pitch = 'mid', v = 1) {
      const c = ctx(); if (!c) return;
      const f = pitch === 'low' ? 105 : pitch === 'high' ? 260 : 170;
      let t = c.currentTime + 0.02;
      const end = t + dur;
      while (t < end) {
        const d = 0.07 + rnd() * 0.08;
        syllable(c, t, f * (0.85 + rnd() * 0.4), d, 0.09 * v, 500 + rnd() * 500, 1000 + rnd() * 1200, (rnd() - 0.5) * 0.3);
        t += d + 0.02 + rnd() * 0.05;
      }
    },
    roar(v = 1) {
      const c = ctx(); if (!c) return;
      const t = c.currentTime + 0.02;
      const o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), lp = c.createBiquadFilter(), g = c.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(70, t); o.frequency.linearRampToValueAtTime(110, t + 0.4); o.frequency.linearRampToValueAtTime(55, t + 1.4);
      lfo.frequency.value = 18; lg.gain.value = 14; lfo.connect(lg).connect(o.frequency);
      lp.type = 'lowpass'; lp.frequency.value = 700;
      env(g, t, 0.1, 0.5 * v, 1.4);
      o.connect(lp).connect(g).connect(out);
      o.start(t); lfo.start(t); o.stop(t + 1.6); lfo.stop(t + 1.6);
      noise(c, t, 1.2, 0.18 * v, 'lowpass', 500, 0.8, 0.1);
    },
    crunch(v = 1) {
      const c = ctx(); if (!c) return;
      const t = c.currentTime + 0.01;
      for (let i = 0; i < 4; i++) noise(c, t + i * 0.035 + rnd() * 0.02, 0.03, 0.3 * v, 'bandpass', 2200 + rnd() * 1800, 2, 0.001);
    },
    bite(v = 1) {
      const c = ctx(); if (!c) return;
      const t = c.currentTime + 0.01;
      noise(c, t, 0.06, 0.4 * v, 'bandpass', 1800, 1.5, 0.002);
      noise(c, t + 0.1, 0.12, 0.2 * v, 'lowpass', 700, 1, 0.01);
    },
    boing(v = 1) {
      const c = ctx(); if (!c) return;
      const t = c.currentTime + 0.01, o = tone(c, 'sine', 220, t, 0.45, 0.25 * v);
      o.frequency.exponentialRampToValueAtTime(660, t + 0.12); o.frequency.exponentialRampToValueAtTime(180, t + 0.45);
    },
    zip(v = 1) {
      const c = ctx(); if (!c) return;
      const t = c.currentTime + 0.01, o = tone(c, 'triangle', 500, t, 0.3, 0.15 * v);
      o.frequency.exponentialRampToValueAtTime(1800, t + 0.28);
    },
    pop(v = 1) { const c = ctx(); if (!c) return; const t = c.currentTime + 0.01; tone(c, 'sine', 900, t, 0.06, 0.2 * v); noise(c, t, 0.04, 0.15 * v, 'highpass', 3000); },
    honk(v = 1) { synth.play('honk', null, v); },
    ding(v = 1) { synth.play('ding', null, v); },
    win(v = 1) { synth.play('win', null, v); },
    whoosh(v = 1) { synth.play('whoosh', null, v); },
    clack(v = 1) { const c = ctx(); if (!c) return; const t = c.currentTime + 0.01; noise(c, t, 0.05, 0.35 * v, 'bandpass', 1200, 3, 0.001); tone(c, 'square', 300, t, 0.04, 0.08 * v); },
    grind(dur = 0.6, v = 1) { const c = ctx(); if (!c) return; noise(c, c.currentTime + 0.01, dur, 0.12 * v, 'bandpass', 3500, 4, 0.02); },
    thud(v = 1) { synth.play('bump', null, v); },
    // Projector whirr for the cinema, returns stop().
    projector(v = 1) {
      const c = ctx(); if (!c) return () => {};
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
      s.buffer = noiseBuf; s.loop = true; f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 3;
      g.gain.value = 0.012 * v; lfo.frequency.value = 24; lg.gain.value = 0.008 * v;
      lfo.connect(lg).connect(g.gain);
      s.connect(f).connect(g).connect(out); s.start(); lfo.start();
      return () => { try { g.gain.setTargetAtTime(0, c.currentTime, 0.1); s.stop(c.currentTime + 0.5); lfo.stop(c.currentTime + 0.5); } catch (_) { /* gone */ } };
    },
    // A little score: notes = [[beat, midi, beats], ...] at bpm, on a triangle lead + soft bass.
    score(notes, bpm = 120, v = 1, wave = 'triangle') {
      const c = ctx(); if (!c) return () => {};
      const t0 = c.currentTime + 0.05, spb = 60 / bpm;
      const g = c.createGain(); g.gain.value = 1; g.connect(out);
      for (const [b, m, len = 1] of notes) {
        const f = 440 * Math.pow(2, (m - 69) / 12);
        tone(c, wave, f, t0 + b * spb, len * spb * 0.9, 0.09 * v, 0.01, g);
        if (m < 60) tone(c, 'sine', f, t0 + b * spb, len * spb * 0.9, 0.12 * v, 0.01, g);
      }
      return () => { try { g.gain.setTargetAtTime(0, c.currentTime, 0.05); } catch (_) { /* gone */ } };
    },
  };
  return api;
}
