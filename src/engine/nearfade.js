// Near-lens and line-of-sight fade for foliage and street props.
// Tree canopies and props that come within a few units of the camera, or sit between the camera
// and the player, dissolve with an ordered dither instead of filling the screen. Purely in the
// shader: no per-frame CPU work beyond one uniform the chase camera updates. Shadows are kept
// (the depth material is untouched), so a faded palm still shades the street.
//
// Targets are found by name: every mesh of the `trees` and `dressing` groups (their materials are
// theirs alone, so they get the LOOK_FADE define in place), plus foliage meshes inside other
// groups (landmark palms, lot trees, bushes, shop plants), which get a faded clone of their
// shared material so the buildings that share it stay solid. Every target mesh also gets
// userData.lookFade so the outline pre-pass (post.js) skips the same fragments and no ink or AO
// is drawn for a faded canopy.
import * as THREE from 'three';

export const FADE = {
  focus: { value: new THREE.Vector3(0, -1e5, 0) }, // the chase camera's look-at point
  near: { value: new THREE.Vector2(3.5, 7.5) }, // fully gone .. fully back, lens to trunk axis
  tube: { value: new THREE.Vector3(1.6, 3.6, 0.22) }, // inner, outer radius, ghost opacity left
};

export const FADE_TARGETS = ['trees', 'dressing'];
// Foliage inside shared groups, by mesh name ('gan-hair-palms', 'lot-trees', 'details-bushes 1,0').
const FOLIAGE = /(^|-)(trees|palms|bushes|plants)(\s|$)/;
const SCAN = ['landmarks', 'parking', 'details', 'storefronts'];

// Shared GLSL: declares the uniforms and lookFadeAlpha(worldPos) in [0, 1].
export const FADE_PARS = /* glsl */ `
uniform vec3 lookFocus;
uniform vec2 lookNear;
uniform vec3 lookTube;
float lookFadeAlpha( vec3 wp ) {
  vec3 c = cameraPosition;
  float a = smoothstep( lookNear.x, lookNear.y, length( wp - c ) );
  vec3 seg = lookFocus - c;
  float t = clamp( dot( wp - c, seg ) / max( dot( seg, seg ), 1e-4 ), 0.0, 1.0 );
  float tube = smoothstep( lookTube.x, lookTube.y, length( wp - ( c + seg * t ) ) );
  // Leave a ghost of what is in the way, and never fade things at the player's own spot.
  tube = max( tube, lookTube.z );
  tube = mix( tube, 1.0, smoothstep( 0.86, 0.97, t ) );
  return min( a, tube );
}
float lookBayer( vec2 p ) {
  vec2 q = mod( floor( p ), 4.0 );
  float i = q.x + q.y * 4.0;
  // 4x4 ordered-dither thresholds
  float b = i == 0.0 ? 0.0 : i == 1.0 ? 8.0 : i == 2.0 ? 2.0 : i == 3.0 ? 10.0
          : i == 4.0 ? 12.0 : i == 5.0 ? 4.0 : i == 6.0 ? 14.0 : i == 7.0 ? 6.0
          : i == 8.0 ? 3.0 : i == 9.0 ? 11.0 : i == 10.0 ? 1.0 : i == 11.0 ? 9.0
          : i == 12.0 ? 15.0 : i == 13.0 ? 7.0 : i == 14.0 ? 13.0 : 5.0;
  return ( b + 0.5 ) / 16.0;
}
`;

export function bindFadeUniforms(uniforms) {
  uniforms.lookFocus = FADE.focus;
  uniforms.lookNear = FADE.near;
  uniforms.lookTube = FADE.tube;
}

const patched = new WeakSet();
function enableFade(m) {
  if (!m || !m.isMeshToonMaterial || patched.has(m)) return;
  patched.add(m);
  m.defines = { ...(m.defines || {}), LOOK_FADE: '' };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    bindFadeUniforms(shader.uniforms);
    if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(m, shader, r);
  };
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => 'fade|' + (prevKey ? prevKey.call(m) : '');
  m.needsUpdate = true;
}

// Called on a slow timer (sky.update): trees, dressing and the rest stream in after the first frame.
const done = new WeakSet();
const clones = new WeakMap();
function fadedClone(m) {
  if (!m || !m.isMeshToonMaterial) return m;
  let c = clones.get(m);
  if (!c) { c = m.clone(); enableFade(c); clones.set(m, c); }
  return c;
}
export function markFadeTargets(scene) {
  let n = 0;
  for (const top of scene.children) {
    if (done.has(top)) continue;
    if (FADE_TARGETS.includes(top.name)) {
      done.add(top);
      top.traverse((o) => {
        if (!o.isMesh) return;
        o.userData.lookFade = true;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) enableFade(m);
        n++;
      });
    } else if (SCAN.includes(top.name)) {
      done.add(top);
      top.traverse((o) => {
        if (!o.isMesh || !FOLIAGE.test(o.name) || Array.isArray(o.material)) return;
        o.material = fadedClone(o.material);
        o.userData.lookFade = true;
        n++;
      });
    }
  }
  return n;
}
