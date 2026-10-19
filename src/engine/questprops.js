// Story props: what the characters talk about is in the world. Quest data lists prop actions
// (show / hold / carry / place / remove / play / emote) on a quest or a step; this module builds
// the meshes and keeps them where the story put them: on the ground, in a hand, on a back, or
// trundling behind someone on a cart.
//
//   show   { show: 'amp', id: 'amp', at: anchor | { npc, dx, dz }, yaw? }
//   hold   { hold: 'phone', id, by: npcId | 'player', how: 'hand' | 'ear' | 'back' | 'carry' }
//   place  { place: id, at }            (puts a held or carried prop down)
//   remove { remove: id }
//   play   { play: npcId, how: true | 'drums' | false }   (the avatar's own instrument / kit)
//   emote  { emote: npcId, name: 'wave' }
//
// Sizes are in the avatars' world units; held props parent to the hand joint, so they follow
// the avatar's own scale instead of a hardcoded height.
import * as THREE from 'three';
import { toonMat } from './renderer.js';
import { buildDrumKit, buildGuitarCase, buildSkateboard, buildDog, buildStroller, buildCat } from '../characters/props.js';

const G = {
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  cyl: (rt, rb, h, n = 14) => new THREE.CylinderGeometry(rt, rb, h, n),
  sph: (r, a = 12, b = 8) => new THREE.SphereGeometry(r, a, b),
};

function part(g, geo, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, toonMat(color));
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  g.add(m);
  return m;
}

// Every prop is built standing on y = 0, facing +z.
export function propMesh(kind) {
  const g = new THREE.Group();
  g.name = 'prop:' + kind;
  switch (kind) {
    case 'drum_kit': { const k = buildDrumKit('#c2405a'); g.add(k.group); break; }
    case 'guitar_case': { const c = buildGuitarCase(); c.group.rotation.x = -Math.PI / 2; c.group.position.y = 0.3; g.add(c.group); break; }
    case 'skateboard': { const b = buildSkateboard(); g.add(b.group); break; }
    case 'dog': { const d = buildDog('#c98b4a', '#f4efe2', 1.1, 'flop'); g.add(d.group); break; }
    case 'stroller': { const st = buildStroller('#2f5d9a'); g.add(st.group); break; }
    case 'speaker': // Moshiko's: the size of a fridge
      part(g, G.box(2.0, 4.2, 1.6), 0x1d1d24, 0, 2.1);
      for (const [y, r] of [[3.2, 0.55], [1.5, 0.8]]) { part(g, G.cyl(r, r, 0.12, 20), 0x4a4f5a, 0, y, 0.82, Math.PI / 2); part(g, G.cyl(r * 0.35, r * 0.35, 0.14, 12), 0xb8b8c0, 0, y, 0.86, Math.PI / 2); }
      part(g, G.box(1.6, 0.18, 0.1), 0x2ec4b6, 0, 4.0, 0.81);
      break;
    case 'amp':
      part(g, G.box(1.5, 1.3, 0.9), 0x23232b, 0, 0.65);
      part(g, G.box(1.3, 0.8, 0.05), 0x5a4a3a, 0, 0.55, 0.46);
      part(g, G.box(1.5, 0.22, 0.92), 0xd8b24a, 0, 1.2);
      break;
    case 'cable': {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.12, 6, 18), toonMat(0x1d1d24)); t.rotation.x = Math.PI / 2; t.position.y = 0.12; g.add(t);
      part(g, G.cyl(0.12, 0.12, 0.5, 8), 0xffcb3d, 0.6, 0.12, 0, 0, 0, Math.PI / 2);
      break;
    }
    case 'mic_stand':
      part(g, G.cyl(0.45, 0.5, 0.08, 14), 0x1d1d24, 0, 0.04);
      part(g, G.cyl(0.05, 0.05, 3.4, 8), 0x8a8f99, 0, 1.75);
      part(g, G.sph(0.2), 0x2b2b33, 0, 3.5, 0.15);
      break;
    case 'generator':
      part(g, G.box(2.6, 1.8, 1.6), 0xe8a02e, 0, 1.1);
      part(g, G.box(2.8, 0.25, 1.8), 0x3a3f48, 0, 0.12);
      part(g, G.cyl(0.18, 0.18, 0.8, 8), 0x3a3f48, 0.9, 2.3);
      part(g, G.box(1.0, 0.6, 0.06), 0x23324a, -0.5, 1.3, 0.82);
      for (const x of [-1.1, 1.1]) part(g, G.cyl(0.35, 0.35, 0.25, 12), 0x1d1d24, x, 0.35, 0.95, Math.PI / 2);
      break;
    case 'trailer': // flatbed the generator rides on
      part(g, G.box(3.0, 0.25, 2.2), 0x5a5f6b, 0, 0.8);
      part(g, G.cyl(0.45, 0.45, 0.3, 14), 0x1d1d24, -1.25, 0.45, 0, 0, 0, Math.PI / 2);
      part(g, G.cyl(0.45, 0.45, 0.3, 14), 0x1d1d24, 1.25, 0.45, 0, 0, 0, Math.PI / 2);
      part(g, G.box(0.15, 0.15, 2.2), 0x3a3f48, 0, 0.8, 2.0);
      break;
    case 'generator_trailer': { // the festival generator riding its flatbed
      g.add(propMesh('trailer'));
      const gen = propMesh('generator'); gen.position.y = 0.95; g.add(gen);
      break;
    }
    case 'chair':
      part(g, G.box(1.2, 0.12, 1.2), 0xf3f1ec, 0, 1.15);
      part(g, G.box(1.2, 1.2, 0.12), 0xf3f1ec, 0, 1.75, -0.55);
      for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) part(g, G.cyl(0.05, 0.05, 1.15, 6), 0x8a8f99, x, 0.58, z);
      break;
    case 'chair_stack':
      for (let i = 0; i < 5; i++) { const c = propMesh('chair'); c.position.y = i * 0.32; g.add(c); }
      break;
    case 'chair_rows': // 5 rows of 8: the first row at the origin, the rest further back (+z), all facing -z (the stage)
      for (let r = 0; r < 5; r++) for (let c = 0; c < 8; c++) { const ch = propMesh('chair'); ch.position.set((c - 3.5) * 2.4, 0, r * 2.8); ch.rotation.y = Math.PI; g.add(ch); }
      break;
    case 'certificate': // the mayor's certificate of appreciation: a gold frame, cream paper, a ribbon seal
      part(g, G.box(1.3, 1.0, 0.08), 0xd8b24a);
      part(g, G.box(1.12, 0.82, 0.02), 0xf7f0dc, 0, 0, 0.045);
      for (let i = 0; i < 3; i++) part(g, G.box(0.8 - i * 0.2, 0.05, 0.01), 0x8a7a5a, 0, 0.22 - i * 0.16, 0.06);
      part(g, G.cyl(0.11, 0.11, 0.03, 12), 0x2e86de, 0.36, -0.26, 0.06, Math.PI / 2);
      break;
    case 'podium': // a plain wooden lectern for the ceremony
      part(g, G.box(1.6, 2.6, 1.0), 0x8a5a34, 0, 1.3);
      part(g, G.box(1.9, 0.14, 1.3), 0x6b4226, 0, 2.66, 0.08, -0.25);
      part(g, G.box(1.64, 0.3, 1.04), 0x2e86de, 0, 1.9);
      break;
    case 'table':
      part(g, G.box(3.2, 0.15, 1.5), 0xe9e1cf, 0, 1.6);
      for (const [x, z] of [[-1.4, -0.6], [1.4, -0.6], [-1.4, 0.6], [1.4, 0.6]]) part(g, G.cyl(0.07, 0.07, 1.6, 6), 0x8a8f99, x, 0.8, z);
      break;
    case 'flag_table': { // a folding table with an Israeli flag on a pole
      g.add(propMesh('table'));
      part(g, G.cyl(0.05, 0.05, 3.2, 6), 0xd8d8d8, 1.3, 3.1, 0);
      const f = new THREE.Group(); f.position.set(1.3 + 0.75, 4.2, 0);
      part(f, G.box(1.5, 1.0, 0.04), 0xffffff);
      for (const y of [-0.36, 0.36]) part(f, G.box(1.5, 0.12, 0.05), 0x1f4fa3, 0, y);
      part(f, G.box(0.36, 0.36, 0.05), 0x1f4fa3, 0, 0, 0.01);
      g.add(f);
      break;
    }
    case 'yard_sale': // a table of odds and ends with boxes
      g.add(propMesh('table'));
      for (const [x, z, c] of [[-1.0, 0, 0xc98b4a], [0.2, 0.2, 0x7fa6c9], [1.1, -0.1, 0xe8364f]]) part(g, G.box(0.7, 0.5, 0.6), c, x, 1.95, z);
      for (const [x, z] of [[-2.4, 0.4], [2.4, -0.3]]) part(g, G.box(1.0, 0.8, 0.8), 0xb07a3e, x, 0.4, z);
      break;
    case 'boards': // surfboards leaning on a rack
      part(g, G.box(3.0, 0.2, 0.3), 0x8a8f99, 0, 2.2, -0.4);
      [0xff7a2a, 0x2ec4b6, 0xffcb3d, 0xe8364f].forEach((c, i) => { const b = part(g, G.box(0.8, 3.8, 0.12), c, -1.2 + i * 0.8, 1.9, 0); b.rotation.x = -0.18; });
      break;
    case 'pot':
      part(g, G.cyl(1.1, 1.0, 1.3, 16), 0x8a8f99, 0, 0.65);
      part(g, G.cyl(1.18, 1.18, 0.16, 16), 0x5a5f6b, 0, 1.36);
      part(g, G.sph(0.2, 8, 6), 0x23324a, 0, 1.55);
      break;
    case 'oranges':
      for (let i = 0; i < 7; i++) part(g, G.sph(0.35, 10, 8), 0xff8a1f, Math.cos(i * 2.3) * (0.6 + i * 0.25), 0.35, Math.sin(i * 2.3) * (0.6 + i * 0.25));
      part(g, G.box(0.9, 1.1, 0.5), 0xf4efe2, -0.4, 0.55, 0.3, 0, 0, 0.6);
      break;
    case 'umbrella': {
      part(g, G.cyl(0.04, 0.04, 2.4, 6), 0x3a3f48, 0, 1.2);
      const c = part(g, new THREE.ConeGeometry(1.4, 0.6, 8, 1, true), 0x2f5d9a, 0, 2.3); c.material.side = THREE.DoubleSide;
      break;
    }
    case 'wheel': part(g, G.cyl(0.4, 0.4, 0.2, 16), 0x1d1d24, 0, 0.4, 0, 0, 0, Math.PI / 2); part(g, G.cyl(0.16, 0.16, 0.22, 10), 0xd8d8d8, 0, 0.4, 0, 0, 0, Math.PI / 2); break;
    case 'shofar': { const s = part(g, new THREE.ConeGeometry(0.22, 1.6, 10), 0xd2b48c, 0, 0.3, 0, 0, 0, Math.PI / 2.3); s.scale.set(1, 1, 0.8); break; }
    case 'cups': for (let i = 0; i < 6; i++) part(g, G.cyl(0.16, 0.12, 0.3, 10), 0xf4efe2, (i % 3 - 1) * 0.38, 0.15, Math.floor(i / 3) * 0.38 - 0.19); break;
    case 'bass_drum': part(g, G.cyl(1.0, 1.0, 0.8, 22), 0xc2405a, 0, 1.0, 0, Math.PI / 2); part(g, G.cyl(0.92, 0.92, 0.82, 22), 0xf4efe2, 0, 1.0, 0, Math.PI / 2); break;
    case 'phone': part(g, G.box(0.42, 0.8, 0.07), 0x1d1d24); part(g, G.box(0.36, 0.66, 0.02), 0x7fe0d6, 0, 0, 0.045); break;
    case 'keys': part(g, new THREE.TorusGeometry(0.16, 0.04, 6, 12), 0xd8d8d8); part(g, G.box(0.08, 0.4, 0.04), 0xd8b24a, 0.1, -0.25); break;
    case 'tray': part(g, G.cyl(1.0, 1.0, 0.1, 18), 0xc9ced6, 0, 0.05); part(g, G.sph(0.85, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0xe6eaef, 0, 0.1); break;
    case 'flowers':
      part(g, G.cyl(0.25, 0.15, 0.7, 8), 0x2e9e57, 0, 0.35);
      [0xe8364f, 0xffcb3d, 0xf2a1b8, 0xffffff].forEach((c, i) => part(g, G.sph(0.22, 8, 6), c, Math.cos(i * 1.6) * 0.22, 0.85, Math.sin(i * 1.6) * 0.22));
      break;
    case 'bucket': part(g, G.cyl(0.6, 0.48, 1.0, 16), 0x2e86de, 0, 0.5); part(g, G.cyl(0.55, 0.55, 0.04, 16), 0x1d1d24, 0, 1.0); break;
    case 'torch': part(g, G.cyl(0.08, 0.08, 1.2, 8), 0x5a3a24, 0, 0.6); part(g, G.sph(0.25, 8, 6), 0xffb347, 0, 1.3); break;
    case 'spotlight':
      part(g, G.cyl(0.08, 0.08, 4.5, 8), 0x3a3f48, 0, 2.25);
      part(g, G.cyl(0.55, 0.4, 0.9, 12), 0x1d1d24, 0, 4.6, 0.2, 0.9);
      part(g, G.cyl(0.42, 0.42, 0.05, 12), 0xfff3c4, 0, 4.4, 0.6, 0.9);
      break;
    case 'mixer_desk':
      g.add(propMesh('table'));
      part(g, G.box(2.0, 0.25, 1.0), 0x23232b, 0, 1.82, 0, -0.15);
      for (let i = 0; i < 4; i++) part(g, G.box(0.12, 0.08, 0.5), [0xe8364f, 0x2ec4b6, 0xffcb3d, 0xb36bd6][i], -0.7 + i * 0.45, 1.98, 0.05);
      break;
    case 'stage':
      part(g, G.box(16, 1.2, 9), 0x3a3f48, 0, 0.6);
      part(g, G.box(16.4, 0.3, 9.4), 0x23232b, 0, 1.25);
      for (const x of [-7.6, 7.6]) part(g, G.box(0.4, 8, 0.4), 0x8a8f99, x, 5, -4.2);
      part(g, G.box(15.6, 0.5, 0.5), 0x8a8f99, 0, 9, -4.2);
      break;
    case 'cat': { // Mitzi: very old, ginger, opinions. The crowd's own cat, with its walk cycle.
      const c = buildCat();
      g.add(c.group);
      g.userData.anim = c.update;
      break;
    }
    default:
      part(g, G.box(0.8, 0.8, 0.8), 0xffcb3d, 0, 0.4);
  }
  return g;
}

// The drum kit only shows while its drummer sits at it; any other playing is done standing.
function playOn(av, how) {
  av.setPlaying(how);
  try { av.setMode && av.setMode(how === 'drums' ? 'sit' : 'idle'); } catch (_) { /* optional */ }
}

// Things the avatar carries with its own pose and pieces (avatar.setCarry): the phone and the
// strapped-on kit are drawn by the avatar itself; two-handed loads sit on anchors.carry.
const TWO_HANDS = new Set(['tray', 'pot', 'bucket', 'cups', 'box', 'crate', 'cake', 'speaker', 'amp']);
function carryPose(it) {
  if (it.kind === 'phone') return it.how === 'ear' ? 'phoneEar' : 'phone';
  if (it.kind === 'drum_kit' && it.how === 'back') return 'drumsBack';
  if (TWO_HANDS.has(it.kind) && it.how !== 'back') return 'two';
  return null;
}

// Offsets for the ways something is carried, in the joint's or body's local space.
const HAND = { phone: [0, -0.55, 0.3], keys: [0, -0.5, 0.2], flowers: [0, -0.6, 0.35], shofar: [0, -0.55, 0.4], cups: [0, -0.5, 0.45],
  umbrella: [0, -0.4, 0.2], certificate: [0, -0.5, 0.45], wheel: [0, -0.6, 0.3], torch: [0, -0.4, 0.2], skateboard: [0, -0.7, 0.3], tray: [0, -0.4, 0.6], pot: [0, -0.9, 0.5], bucket: [0, -1.0, 0.3] };

export class PropStage {
  constructor({ scene, groundY, resolve, npcAt, avatarOf, playerAvatar }) {
    this.root = new THREE.Group();
    this.root.name = 'quest-props';
    scene.add(this.root);
    this.groundY = groundY;   // (x, z) -> y
    this.resolve = resolve;   // anchor -> {x, z}
    this.npcAt = npcAt;       // id -> npc record ({x, z, yaw, av}) or null
    this.avatarOf = avatarOf; // 'player' | npc id -> avatar or null
    this.playerAvatar = playerAvatar;
    this.items = new Map();   // id -> { kind, mesh, holder, how, x, z, yaw }
  }

  has(id) { return this.items.has(id); }

  get(id, kind) {
    let it = this.items.get(id);
    if (!it) {
      it = { id, kind, mesh: propMesh(kind), holder: null, how: null, x: 0, z: 0, yaw: 0 };
      this.items.set(id, it);
    }
    return it;
  }

  detach(it) {
    this.release(it);
    it.mesh.removeFromParent(); this.root.add(it.mesh); it.holder = null; it.how = null; it.attached = null;
  }

  // Hands free again (and the avatar's own phone or kit put away) when a prop leaves its holder.
  release(it) {
    if (it.pose && it.attached && it.attached.setCarry) { try { it.attached.setCarry(null); } catch (_) { /* optional */ } }
    it.pose = null;
    it.mesh.visible = true;
  }

  // One action from quest data. `qid` namespaces ids per quest.
  apply(a, qid = '') {
    if (!a) return;
    const nid = (id) => (!id ? null : id.includes(':') ? id : `${qid}:${id}`);
    try {
      if (a.show) {
        const it = this.get(nid(a.id || a.show), a.show);
        if (it.holder) this.detach(it);
        else if (!it.mesh.parent) this.root.add(it.mesh);
        const p = this.where(a.at);
        if (!p) return;
        it.x = p.x; it.z = p.z; it.yaw = a.yaw ?? p.yaw ?? 0;
        this.put(it);
      } else if (a.hold) {
        const it = this.get(nid(a.id || a.hold), a.hold);
        if (it.holder) this.release(it);
        it.holder = a.by || 'player'; it.how = a.how || 'hand'; it.attached = null;
        if (it.how === 'carry' && !it.mesh.parent) this.root.add(it.mesh);
      } else if (a.place) {
        const it = this.items.get(nid(a.place));
        if (!it) return;
        if (it.holder) this.detach(it);
        const p = this.where(a.at) || (it.lastPos || null);
        if (p) { it.x = p.x; it.z = p.z; it.yaw = a.yaw ?? it.yaw; this.put(it); }
      } else if (a.remove) {
        const it = this.items.get(nid(a.remove));
        if (it) { this.release(it); it.mesh.removeFromParent(); this.items.delete(it.id); }
      } else if (a.play) {
        const av = this.avatarOf(a.play);
        if (av && av.setPlaying) playOn(av, a.how ?? true);
        else this.pendingPlay = { ...(this.pendingPlay || {}), [a.play]: a.how ?? true };
      } else if (a.emote) {
        const av = this.avatarOf(a.emote);
        if (av && av.emote) av.emote(a.name || 'wave');
      }
    } catch (e) { console.warn('[props] action failed', a, e); }
  }

  where(at) {
    if (!at) return null;
    if (typeof at.npc === 'string') {
      const n = this.npcAt(at.npc);
      if (!n) return null;
      // Offsets are in front of / beside the character, in its own frame.
      const s = Math.sin(n.yaw || 0), c = Math.cos(n.yaw || 0), dx = at.dx || 0, dz = at.dz || 0;
      return { x: n.x + c * dx + s * dz, z: n.z - s * dx + c * dz, yaw: n.yaw || 0 };
    }
    return this.resolve(at);
  }

  put(it) {
    it.mesh.position.set(it.x, this.groundY(it.x, it.z), it.z);
    it.mesh.rotation.set(0, it.yaw, 0);
    it.mesh.scale.setScalar(1);
  }

  // Per frame: attach held props once their avatar exists, drag carts behind their holder.
  update(dt, player) {
    if (this.pendingPlay) {
      for (const [id, how] of Object.entries(this.pendingPlay)) { const av = this.avatarOf(id); if (av && av.setPlaying) { playOn(av, how); delete this.pendingPlay[id]; } }
      if (!Object.keys(this.pendingPlay).length) this.pendingPlay = null;
    }
    for (const it of this.items.values()) {
      if (it.mesh.userData.anim) it.mesh.userData.anim(dt, 0);
      if (!it.holder) continue;
      const av = this.avatarOf(it.holder);
      if (it.how === 'carry') {
        // On a cart (or trailer) a few units behind: follows the holder's path, never clips into them.
        const h = it.holder === 'player' ? player.pos : this.npcAt(it.holder);
        if (!h) continue;
        const dx = h.x - it.x, dz = h.z - it.z, d = Math.hypot(dx, dz), gap = /trailer|generator/.test(it.kind) ? 7 : 4;
        if (d > gap) { it.x += (dx / d) * (d - gap); it.z += (dz / d) * (d - gap); it.yaw = Math.atan2(dx, dz); }
        if (d > 80) { it.x = h.x - Math.sin(it.yaw) * gap; it.z = h.z - Math.cos(it.yaw) * gap; }
        it.lastPos = { x: it.x, z: it.z };
        this.put(it);
        continue;
      }
      if (!av || !av.joints || it.attached === av) continue;
      if (it.attached) this.release(it);
      it.mesh.removeFromParent();
      it.mesh.rotation.set(0, 0, 0);
      it.mesh.scale.setScalar(1);
      const pose = av.setCarry ? carryPose(it) : null;
      if (pose) {
        av.setCarry(pose);
        it.pose = pose;
        if (pose === 'two' && av.anchors && av.anchors.carry) {
          av.anchors.carry.add(it.mesh);
          it.mesh.position.set(0, -0.2, 0);
          it.mesh.scale.setScalar(0.6);
        } else {
          // The avatar draws its own phone / strapped kit; ours stays hidden but keeps the id.
          (av.joints.waist || av.group).add(it.mesh);
          it.mesh.visible = false;
        }
      } else if (it.how === 'back') {
        // Big things ride on the back: the body group, behind the shoulders.
        (av.joints.waist || av.group).add(it.mesh);
        it.mesh.position.set(0, -0.6, -1.3);
        it.mesh.scale.setScalar(it.kind === 'drum_kit' ? 0.45 : 0.7);
      } else {
        const hand = av.joints.wrR || av.group;
        hand.add(it.mesh);
        const o = HAND[it.kind] || [0, -0.6, 0.35];
        it.mesh.position.set(o[0], o[1], o[2]);
        if (!HAND[it.kind]) it.mesh.scale.setScalar(0.5);
      }
      it.attached = av;
    }
  }

  // Ids starting with a prefix (a quest's), for cleanup.
  clear(prefix) {
    for (const [id, it] of [...this.items]) if (id.startsWith(prefix)) { this.release(it); it.mesh.removeFromParent(); this.items.delete(id); }
  }
}
