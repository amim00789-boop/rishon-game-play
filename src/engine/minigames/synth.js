// A tiny WebAudio drum kit and sound-effect box for the minigames, until real music exists.
// It owns its AudioContext (audio.js keeps its context private), follows the game's mute
// setting when the audio module is passed, and suspends with the tab.
//
//   const s = getSynth(audio);  s.ensure();  s.play('kick', s.time() + 0.1);
//   s.time() is the AudioContext clock in seconds, the reference the rhythm game judges against.

let shared = null;

export function getSynth(audio = null) {
  if (shared) { if (audio) shared.setAudio(audio); return shared; }
  shared = createSynth(audio);
  return shared;
}

function createSynth(audioMod) {
  let ctx = null, out = null, noiseBuf = null, comp = null;
  let audio = audioMod;
  const VOL = 0.75;

  const onVis = () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  };
  document.addEventListener('visibilitychange', onVis);

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { return null; }
      out = ctx.createGain();
      out.gain.value = VOL;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.ratio.value = 6;
      out.connect(comp).connect(ctx.destination);
      const n = ctx.sampleRate * 1.5;
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let seed = 12345;
      for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = (seed / 0x3fffffff) - 1; }
    }
    if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {});
    syncMute();
    return ctx;
  }

  function syncMute() {
    if (!out) return;
    const muted = !!(audio && audio.muted);
    out.gain.value = muted ? 0 : VOL;
  }

  const running = () => !!ctx && ctx.state === 'running';
  const time = () => (ctx ? ctx.currentTime : 0);
  // Seconds between scheduling a sound and hearing it.
  const latency = () => (ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0);

  // ---- voices ----
  function env(g, t, a, peak, d, end = 0.0001) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(end, t + a + d);
  }
  function osc(type, f, t, dur, peak, dest = out, attack = 0.003) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    env(g, t, attack, peak, dur);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + attack + dur + 0.05);
    return o;
  }
  function noise(t, dur, peak, type, freq, q = 1, dest = out, attack = 0.002) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    env(g, t, attack, peak, dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 0.5); s.stop(t + attack + dur + 0.05);
    return { s, f, g };
  }

  const V = {
    kick(t, v = 1) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      env(g, t, 0.002, 0.9 * v, 0.28);
      o.connect(g).connect(out); o.start(t); o.stop(t + 0.35);
    },
    snare(t, v = 1) {
      noise(t, 0.16, 0.5 * v, 'highpass', 1400, 0.7);
      osc('triangle', 190, t, 0.09, 0.35 * v);
    },
    hat(t, v = 1) { noise(t, 0.045, 0.22 * v, 'highpass', 7500, 0.8); },
    openhat(t, v = 1) { noise(t, 0.22, 0.18 * v, 'highpass', 6500, 0.8); },
    clap(t, v = 1) {
      for (const k of [0, 0.011, 0.023]) noise(t + k, 0.05, 0.32 * v, 'bandpass', 1300, 1.2);
      noise(t + 0.03, 0.18, 0.22 * v, 'bandpass', 1100, 0.9);
    },
    crash(t, v = 1) { noise(t, 0.9, 0.2 * v, 'highpass', 4500, 0.5); },
    // Darbuka: low "dum" and high "tek".
    dum(t, v = 1) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.18);
      env(g, t, 0.002, 0.6 * v, 0.3);
      o.connect(g).connect(out); o.start(t); o.stop(t + 0.36);
    },
    tek(t, v = 1) { noise(t, 0.05, 0.4 * v, 'bandpass', 3200, 2.5); osc('sine', 820, t, 0.04, 0.2 * v); },
    tom(t, v = 1, f = 160) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(f * 1.4, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.1);
      env(g, t, 0.002, 0.55 * v, 0.25);
      o.connect(g).connect(out); o.start(t); o.stop(t + 0.3);
    },
    click(t, v = 1, accent = false) { osc('square', accent ? 1760 : 1320, t, 0.03, 0.2 * v); },
    bass(t, v = 1, f = 55, dur = 0.3) {
      const o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f, t);
      lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(180, t + dur);
      env(g, t, 0.005, 0.32 * v, dur);
      o.connect(lp).connect(g).connect(out); o.start(t); o.stop(t + dur + 0.1);
    },
    // Soft "ooh" chord: detuned saws through a vowel-ish band, for the choirs and the finale.
    pad(t, v = 1, freqs = [220, 277, 330], dur = 1.6) {
      const bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 650; bp.Q.value = 0.9;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.07 * v, t + 0.25);
      g.gain.setValueAtTime(0.07 * v, t + dur - 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      bp.connect(g).connect(out);
      for (const f of freqs) for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
        o.connect(bp); o.start(t); o.stop(t + dur + 0.05);
      }
    },
    bell(t, v = 1, f = 880) { osc('sine', f, t, 0.6, 0.25 * v); osc('sine', f * 2.76, t, 0.25, 0.08 * v); },
    // Wave swell on the sand: lowpassed noise that rises and falls.
    wave(t, v = 1, dur = 3) {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuf; s.loop = true;
      f.type = 'lowpass'; f.frequency.setValueAtTime(300, t); f.frequency.linearRampToValueAtTime(1400, t + dur * 0.45); f.frequency.linearRampToValueAtTime(250, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16 * v, t + dur * 0.45); g.gain.linearRampToValueAtTime(0.0001, t + dur);
      s.connect(f).connect(g).connect(out); s.start(t); s.stop(t + dur + 0.05);
    },
    // ---- effects ----
    honk(t, v = 1) { for (const f of [392, 494]) { const o = osc('square', f, t, 0.35, 0.12 * v, out, 0.01); o.frequency.setValueAtTime(f, t); } },
    shutter(t, v = 1) { noise(t, 0.03, 0.4 * v, 'highpass', 3000); noise(t + 0.07, 0.05, 0.3 * v, 'highpass', 2500); },
    ding(t, v = 1) { osc('sine', 1046, t, 0.25, 0.22 * v); osc('sine', 1568, t + 0.08, 0.35, 0.18 * v); },
    win(t, v = 1) { [523, 659, 784, 1046].forEach((f, i) => osc('triangle', f, t + i * 0.09, 0.3, 0.2 * v)); },
    fail(t, v = 1) { [392, 330, 262].forEach((f, i) => osc('triangle', f, t + i * 0.14, 0.3, 0.18 * v)); },
    miss(t, v = 1) { osc('triangle', 140, t, 0.08, 0.08 * v); },
    bump(t, v = 1) { osc('sine', 90, t, 0.15, 0.4 * v); noise(t, 0.08, 0.2 * v, 'lowpass', 600); },
    whoosh(t, v = 1) { noise(t, 0.35, 0.18 * v, 'bandpass', 900, 0.6, out, 0.12); },
    cheer(t, v = 1) { noise(t, 1.4, 0.12 * v, 'bandpass', 1800, 0.4, out, 0.3); },
  };

  // Plays a voice at audio time t (default: now). Silent when WebAudio is missing or locked.
  function play(name, t = null, v = 1, ...args) {
    if (!ctx) ensure();
    if (!ctx || !V[name]) return;
    syncMute();
    try { V[name](t == null ? ctx.currentTime + 0.005 : Math.max(t, ctx.currentTime), v, ...args); } catch (_) { /* a dropped note is fine */ }
  }

  return {
    ensure, running, time, latency, play, voices: Object.keys(V),
    setAudio(a) { audio = a; syncMute(); },
    get ctx() { return ctx; },
  };
}
