// Steelman debate (M12): a speaker makes their case; the player rebuilds it for the other side
// from phrase cards ("what he means is ..."). Picking exactly the speaker's real points fills
// that speaker's trust bar (they feel heard); strawman cards get a laugh from the room and drain
// it; filler cards cost a little. A bar at zero means "let's take five" and the round restarts.
//
//   const res = await debate.start({
//     speakers: [{ id: 'yanki', name: 'quest.npc.yanki' }, { id: 'shiri', name: 'quest.npc.shiri' }],
//     rounds: [{ speaker: 0, statement: 'quest.m12.r1.say', lead: 'quest.m12.r1.lead',
//                phrases: [{ text: 'quest.m12.r1.p1', kind: 'core' }, { text: '...', kind: 'strawman' }, { text: '...', kind: 'filler' }] }],
//     trustStart: 40, strawmanCost: 25, wrongCost: 10,
//   });
//   // res = { ok, strawmen, wrongs, tries, rounds, quit }
import { createOverlay, addStyle, textFn, showCard, keyListener, toaster, rich } from './common.js';
import { getSynth } from './synth.js';

const CSS = `
.mg-debate .db-bars { left: 50%; top: 14px; transform: translateX(-50%); width: min(560px, calc(100vw - 32px)); display: flex; gap: 14px; }
.mg-debate .db-bars > div { flex: 1; }
.mg-debate .db-bars .mg-bar { height: 12px; }
.mg-debate .db-main { left: 50%; bottom: 24px; transform: translateX(-50%); width: min(640px, calc(100vw - 32px)); pointer-events: auto; text-align: start; }
.mg-debate .db-who { display: inline-block; padding: 1px 10px; background: #ffb347; border: 2px solid #23324a; border-radius: 8px; font-weight: 900; }
.mg-debate .db-say { margin: 6px 0 8px; font-size: 16px; line-height: 1.45; }
.mg-debate .db-build { min-height: 26px; padding: 6px 10px; border: 2px dashed rgba(35, 50, 74, 0.5); border-radius: 9px; background: #fff; font-size: 15px; }
.mg-debate .db-cards { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.mg-debate .db-card { pointer-events: auto; cursor: pointer; padding: 5px 10px; border: 2px solid rgba(35, 50, 74, 0.45); border-radius: 9px;
  background: rgba(255, 255, 255, 0.85); font-size: 14px; font-weight: 600; }
.mg-debate .db-card.on { background: #7fe0d6; border-color: #23324a; }
.mg-debate .db-row { display: flex; justify-content: space-between; align-items: center; }
`;

export function createDebate(deps = {}) {
  const t = textFn(deps.t);
  const synth = getSynth(deps.audio || null);
  addStyle('mg-style-debate', CSS);
  let S = null;

  function start(config = {}) {
    if (S) cancel();
    return new Promise((resolve) => {
      const ov = createOverlay('mg-debate',
        '<div class="mg-panel db-bars"><div><div class="mg-small db-n0"></div><div class="mg-bar db-b0"><i></i></div></div>' +
        '<div><div class="mg-small db-n1"></div><div class="mg-bar db-b1"><i></i></div></div></div>' +
        '<div class="mg-panel db-main"><span class="db-who"></span><div class="db-say"></div><div class="mg-small db-lead"></div><div class="db-build"></div>' +
        '<div class="db-cards"></div><div class="db-row"><span class="mg-small db-hint"></span><span><button class="mg-btn alt db-clear"></button><button class="mg-btn db-go"></button></span></div></div>');
      const sp = config.speakers || [{ id: 'a' }, { id: 'b' }];
      sp.forEach((x, i) => { ov.$(`.db-n${i}`).textContent = t(x.name || `quest.npc.${x.id}`); });
      ov.$('.db-clear').innerHTML = rich(t('mg.debate.clear'));
      ov.$('.db-go').innerHTML = rich(t('mg.debate.say'));
      ov.$('.db-go').addEventListener('pointerdown', (e) => { e.stopPropagation(); submit(); });
      ov.$('.db-clear').addEventListener('pointerdown', (e) => { e.stopPropagation(); S.picked = []; draw(); });
      const rounds = config.rounds || [];
      const perSpeaker = [0, 1].map((i) => Math.max(1, rounds.filter((r) => (r.speaker || 0) === i).length));
      S = { cfg: config, ov, resolve, rounds, perSpeaker, sp, round: 0, tries: 0, strawmen: 0, wrongs: 0, trust: [0, 0], passed: [0, 0], picked: [], phase: 'play',
        toast: toaster(ov.root), offKeys: keyListener(onKey) };
      S.trust = [config.trustStart ?? 40, config.trustStart ?? 40];
      S.base = S.trust.slice();
      if (!rounds.length) { end({ ok: true, strawmen: 0, wrongs: 0, tries: 1, rounds: 0, quit: false }); return; }
      openRound();
    });
  }

  function openRound() {
    const s = S;
    const r = s.rounds[s.round];
    s.picked = [];
    // Cards in a stable shuffled order (the correct ones are not always first).
    s.order = r.phrases.map((p, i) => ({ p, i, k: hash(`${r.statement}|${i}`) })).sort((a, b) => a.k - b.k);
    s.need = r.pick || r.phrases.filter((p) => p.kind === 'core').length;
    const who = s.sp[r.speaker || 0];
    s.ov.$('.db-who').textContent = t(who.name || `quest.npc.${who.id}`);
    s.ov.$('.db-say').innerHTML = rich(t(r.statement));
    s.ov.$('.db-lead').textContent = t(r.lead || 'mg.debate.lead');
    s.ov.$('.db-hint').textContent = t('mg.debate.hint', { n: s.need });
    draw();
  }

  function draw() {
    const s = S;
    const cards = s.ov.$('.db-cards');
    cards.innerHTML = '';
    s.order.forEach((o, n) => {
      const b = document.createElement('span');
      b.className = 'db-card' + (s.picked.includes(o.i) ? ' on' : '');
      b.innerHTML = `<kbd dir="ltr">${n + 1}</kbd> ${rich(t(o.p.text))}`;
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); toggle(o.i); });
      cards.appendChild(b);
    });
    // finish() redraws after the last round, when there is no current round to describe.
    const r = s.rounds[s.round];
    s.ov.$('.db-build').innerHTML = r ? rich(s.picked.map((i) => t(r.phrases[i].text)).join(' · ')) : '';
    s.trust.forEach((v, i) => { s.ov.$(`.db-b${i} i`).style.width = Math.max(0, Math.min(100, v)) + '%'; });
  }

  function toggle(i) {
    const s = S;
    if (!s || s.phase !== 'play') return;
    const at = s.picked.indexOf(i);
    if (at >= 0) s.picked.splice(at, 1);
    else if (s.picked.length < s.need) s.picked.push(i);
    synth.play('click');
    draw();
  }

  function onKey(e) {
    const s = S;
    if (!s || s.phase !== 'play' || e.repeat) return;
    const m = /^(Digit|Numpad)(\d)$/.exec(e.code);
    if (m && +m[2] >= 1 && +m[2] <= s.order.length) { toggle(s.order[+m[2] - 1].i); return; }
    if (e.code === 'Enter') submit();
    else if (e.code === 'Backspace') { s.picked.pop(); draw(); }
  }

  function submit() {
    const s = S;
    if (!s || s.phase !== 'play') return;
    const r = s.rounds[s.round];
    if (s.picked.length < s.need) { s.toast(t('mg.debate.pickMore', { n: s.need - s.picked.length })); return; }
    const who = r.speaker || 0;
    const kinds = s.picked.map((i) => r.phrases[i].kind || 'filler');
    const straw = kinds.filter((k) => k === 'strawman').length;
    const core = kinds.filter((k) => k === 'core').length;
    if (straw) {
      s.strawmen += straw;
      s.trust[who] -= (s.cfg.strawmanCost ?? 25) * straw;
      synth.play('cheer');
      s.toast(t('mg.debate.laugh'));
    } else if (core === s.need) {
      // Being heard outweighs earlier slips: the bar jumps to this speaker's share of the way to full.
      s.passed[who]++;
      s.trust[who] = Math.max(s.trust[who], Math.round(s.base[who] + ((100 - s.base[who]) * s.passed[who]) / s.perSpeaker[who]));
      synth.play('ding');
      s.toast(t('mg.debate.nod'));
      draw();
      s.round++;
      if (s.round >= s.rounds.length) { finish(); return; }
      openRound();
      return;
    } else {
      s.wrongs++;
      s.trust[who] -= s.cfg.wrongCost ?? 10;
      synth.play('miss');
      s.toast(t('mg.debate.almost', { n: core, total: s.need }));
    }
    s.picked = [];
    draw();
    if (s.trust[who] <= 0) takeFive(who);
  }

  function takeFive(who) {
    const s = S;
    s.phase = 'card';
    synth.play('fail');
    s.closeCard = showCard(s.ov.root, { title: t('mg.debate.failTitle'), lines: [t(s.cfg.failLine || 'mg.debate.failLine')],
      buttons: [
        { label: t('mg.ui.retry'), key: ['Enter', 'KeyF'], onClick: () => { s.closeCard = null; s.tries++; s.trust[who] = s.base[who]; s.phase = 'play'; openRound(); } },
        { label: t('mg.ui.quit'), key: ['Escape'], alt: true, onClick: () => end({ ok: false, quit: true, strawmen: s.strawmen, wrongs: s.wrongs, tries: s.tries + 1, rounds: s.round }) },
      ] });
  }

  function finish() {
    const s = S;
    s.phase = 'card';
    s.trust = [100, 100];
    draw();
    synth.play('win');
    s.result = { ok: true, strawmen: s.strawmen, wrongs: s.wrongs, tries: s.tries + 1, rounds: s.rounds.length, quit: false };
    s.closeCard = showCard(s.ov.root, { title: t('mg.debate.passTitle'), lines: [t('mg.debate.summary', { n: s.strawmen })],
      buttons: [{ label: t('mg.ui.continue'), key: ['Enter', 'KeyF'], onClick: () => end(s.result) }] });
    if (s.cfg.autoContinue) setTimeout(() => S === s && s.closeCard && s.closeCard.fire(0), 600);
  }

  function end(result) {
    const s = S;
    teardown();
    s.resolve(result);
  }
  function teardown() {
    const s = S;
    if (!s) return;
    S = null;
    if (s.closeCard) s.closeCard();
    s.offKeys();
    s.ov.remove();
  }
  function cancel() {
    const s = S;
    if (!s) return;
    teardown();
    s.resolve({ ok: false, cancelled: true });
  }

  return {
    start, update() {}, cancel,
    get active() { return !!S; },
    get blocksPlayer() { return !!S; },
    debug: {
      state: () => (S ? { phase: S.phase, round: S.round, trust: S.trust.slice(), picked: S.picked.slice(), strawmen: S.strawmen } : null),
      // Picks phrases by their index in the round's data (not the shuffled order) and submits.
      answer: (indices) => { const s = S; if (!s) return; s.picked = indices.slice(0, s.need); submit(); },
      card: (i = 0) => S && S.closeCard && S.closeCard.fire(i),
    },
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
