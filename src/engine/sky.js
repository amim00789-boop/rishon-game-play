// Gradient sky dome, stylised clouds, sun + hemisphere light, haze, time-of-day presets.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toonMat, markCharacters, rimUniforms } from './renderer.js';
import { markFadeTargets } from './nearfade.js';

// Golden hour over the sea (approved concept look): sun low in the west, shadows fall east
// across the city, peach haze on the horizon. Mutated in place by setPreset(), and shared by
// reference with the water shader, so the glitter path follows the sun.
export const SUN_DIR = new THREE.Vector3(-140, 85, 40).normalize();

// Each preset is a full lighting rig. Values are art-directed, not physical: key/fill ratio
// stays between 2:1 and 3:1 so shadows read as blue-violet sky fill, never black.
// sun/hemi intensities are in three's physical units (divided by PI in the toon BRDF).
export const TIME_PRESETS = {
  golden: {
    sunDir: [-140, 85, 40], sun: 0xffd9a8, sunI: 2.65, sky: 0xc2c8ee, ground: 0xe6bd8e, hemiI: 2.15,
    top: 0x5b9fe0, horizon: 0xffd3a8, warm: 0xffe0b8, low: 0xff9a6b, haze: 0xf6c9a4, fog: [240, 1420],
    cloud: 0xfff4ea, cloudGlow: 0xffc8a0, rimSun: 0xffc27a, rimSky: 0x7088c0, sunGlow: 3.0,
  },
  morning: {
    sunDir: [130, 70, -50], sun: 0xfff0d6, sunI: 2.6, sky: 0xbcd8ff, ground: 0xd8c8a8, hemiI: 2.0,
    top: 0x5ea6ea, horizon: 0xe8eef2, warm: 0xfff1d8, low: 0xf2d6b8, haze: 0xdfe6ea, fog: [260, 1420],
    cloud: 0xffffff, cloudGlow: 0xffe8cc, rimSun: 0xfff0d0, rimSky: 0x7a98c8, sunGlow: 2.6,
  },
  noon: {
    sunDir: [-35, 170, 25], sun: 0xfff8ec, sunI: 2.9, sky: 0xbcd6ff, ground: 0xd6c4a2, hemiI: 1.9,
    top: 0x3f8fe0, horizon: 0xcfe6fb, warm: 0xffffff, low: 0xbcd8f0, haze: 0xd2e4f2, fog: [300, 1420],
    cloud: 0xffffff, cloudGlow: 0xe8f2ff, rimSun: 0xfff4e0, rimSky: 0x7a98c8, sunGlow: 2.4,
  },
  dusk: {
    sunDir: [-160, 22, 35], sun: 0xff9c5c, sunI: 2.3, sky: 0x9a9ad8, ground: 0xc8907a, hemiI: 2.05,
    top: 0x34548f, horizon: 0xffa47c, warm: 0xffc08a, low: 0xd8607a, haze: 0xe2a08c, fog: [200, 1400],
    cloud: 0xffd6c4, cloudGlow: 0xff8a6a, rimSun: 0xff9a5c, rimSky: 0x8a7ad0, sunGlow: 3.4,
  },
};
const ORDER = ['golden', 'dusk', 'morning', 'noon'];

export function createSky(scene) {
  scene.background = new THREE.Color();
  // Haze ends just inside the camera far plane, so distant chunks are culled without a visible pop.
  scene.fog = new THREE.Fog(0xffffff, 240, 1420);

  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      warm: { value: new THREE.Color() },
      ground: { value: new THREE.Color() },
      sunDir: { value: SUN_DIR },
      sunGlow: { value: 3.0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top, horizon, warm, ground, sunDir;
      uniform float sunGlow;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float s = max(dot(d, sunDir), 0.0);
        // concept gradient: coral low band -> peach horizon -> blue zenith
        vec3 col = h > 0.08 ? mix(horizon, top, smoothstep(0.08, 0.55, h))
                            : mix(ground, horizon, smoothstep(-0.05, 0.08, h));
        col = mix(col, warm, pow(s, 8.0) * 0.5 * (1.0 - smoothstep(0.0, 0.5, h)));
        // stylised sun: hard disc + soft halo. The disc is pushed past 1.0 so it is the one
        // sky element the bloom threshold picks up.
        float disc = smoothstep(0.9993, 0.9996, s);
        col += vec3(1.0, 0.93, 0.75) * (pow(s, 200.0) * 0.6 + pow(s, 18.0) * 0.18);
        col = mix(col, vec3(1.0, 0.97, 0.88) * sunGlow, disc);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1450, 32, 16), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  dome.userData.noOutline = true;
  scene.add(dome);

  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0xd9b88a, 1.95);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe0b8, 2.75);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // A little wider than the old 75 so shadows hold further down a street, at nearly the same texel.
  const S = 82;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 520 });
  sun.shadow.bias = -0.0006;
  // Enough normal offset to clear acne stipple on sloped planks and roofs at golden-hour angles.
  sun.shadow.normalBias = 0.12;
  scene.add(sun);
  scene.add(sun.target);

  const clouds = makeClouds(scene);

  let current = 'golden';
  function setPreset(name) {
    const p = TIME_PRESETS[name];
    if (!p) return current;
    current = name;
    SUN_DIR.set(...p.sunDir).normalize();
    sun.color.setHex(p.sun);
    sun.intensity = p.sunI;
    hemi.color.setHex(p.sky);
    hemi.groundColor.setHex(p.ground);
    hemi.intensity = p.hemiI;
    const u = domeMat.uniforms;
    u.top.value.setHex(p.top); u.horizon.value.setHex(p.horizon); u.warm.value.setHex(p.warm);
    u.ground.value.setHex(p.low); u.sunGlow.value = p.sunGlow;
    scene.background.setHex(p.haze);
    scene.fog.color.setHex(p.haze);
    scene.fog.near = p.fog[0];
    scene.fog.far = p.fog[1];
    clouds.mat.color.setHex(p.cloud);
    clouds.mat.emissive.setHex(p.cloudGlow);
    rimUniforms.rimSun.value.setHex(p.rimSun);
    rimUniforms.rimSky.value.setHex(p.rimSky);
    return current;
  }
  const params = new URLSearchParams(location.search);
  setPreset(TIME_PRESETS[params.get('tod')] ? params.get('tod') : 'golden');
  // T cycles the time of day (look development; golden hour stays the shipped default).
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyT' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    setPreset(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]);
  });

  const texel = (2 * S) / 2048;
  const tmp = new THREE.Vector3();
  let rimTimer = 0;
  function update(dt, focus, camera) {
    dome.position.copy(camera.position);
    // Snap the shadow frustum to whole texels so shadows do not shimmer as the player moves.
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    // Centre the shadow box on the player's height, or shadows vanish on the eastern hills.
    sun.target.position.set(fx, focus.y, fz);
    tmp.copy(SUN_DIR).multiplyScalar(250);
    sun.position.set(fx + tmp.x, focus.y + tmp.y, fz + tmp.z);
    clouds.update(dt, camera.position);
    // Crowd members stream in and out; give new ones the character rim light. Trees and street
    // props stream in after the first frame; give them the near-lens fade once they land.
    rimTimer -= dt;
    if (rimTimer <= 0) { rimTimer = 1.0; markCharacters(scene); markFadeTargets(scene); }
  }

  return { dome, sun, hemi, clouds, update, setPreset, get preset() { return current; }, presets: Object.keys(TIME_PRESETS) };
}

function makeClouds(scene) {
  const mat = toonMat(0xfff4ea, { emissive: 0xffc8a0, emissiveIntensity: 0.3 });
  mat.fog = false;
  const blob = new THREE.IcosahedronGeometry(1, 2);
  const group = new THREE.Group();
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const FIELD = 2400;
  const items = [];
  for (let i = 0; i < 34; i++) {
    const parts = [];
    const n = 4 + Math.floor(rnd() * 4);
    const len = 40 + rnd() * 50;
    for (let k = 0; k < n; k++) {
      const g = blob.clone();
      const r = 12 + rnd() * 14;
      g.scale(r * 1.2, r * 0.75, r);
      g.translate((k / (n - 1) - 0.5) * len, rnd() * 6 + (k % 2 ? 4 : 0), (rnd() - 0.5) * 18);
      parts.push(g);
    }
    // flat cartoon underside
    const geo = mergeGeometries(parts);
    const pos = geo.attributes.position;
    for (let v = 0; v < pos.count; v++) if (pos.getY(v) < -4) pos.setY(v, -4 + (pos.getY(v) + 4) * 0.25);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.userData.noOutline = true;
    m.castShadow = false;
    m.receiveShadow = false;
    const s = 1.4 + rnd() * 1.1;
    m.scale.setScalar(s);
    items.push({ m, x: (rnd() - 0.5) * FIELD, z: (rnd() - 0.5) * FIELD, y: 190 + rnd() * 90, v: 4 + rnd() * 4 });
    group.add(m);
  }
  scene.add(group);
  group.userData.noOutline = true;
  const wrap = (v) => ((((v + FIELD / 2) % FIELD) + FIELD) % FIELD) - FIELD / 2;
  return {
    group,
    mat,
    update(dt, camPos) {
      for (const c of items) {
        c.x += c.v * dt; // sea breeze blows inland (east)
        c.m.position.set(camPos.x + wrap(c.x - camPos.x), c.y, camPos.z + wrap(c.z - camPos.z));
      }
    },
  };
}
