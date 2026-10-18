// Renderer, scene, camera, the shared toon ramp and the global look shaders (see docs/ART_DIRECTION.md).
import * as THREE from 'three';
import { FADE_PARS } from './nearfade.js';

// ---------------------------------------------------------------------------------------------
// Global look: patched into three's shader library once, before any material compiles, so every
// module's MeshToonMaterial shades the same way without those modules changing.
// 1. Soft-stepped ramp: each module keeps its own band values, but band edges blend over a short
//    range (hand-painted cel look) instead of aliasing hard steps, plus a small fourth highlight band.
// 2. Material breakup: a very low-frequency world-space value noise (+-4%) so big flat surfaces
//    (asphalt, plaster, lawns) are not one flat colour. Characters opt out.
// 3. Rim light, only where a material defines TOON_RIM (characters; see markCharacters()).
// 4. Aerial perspective: distance first desaturates toward the haze, then fades into it.
//    A material can set its own strength with defines.LOOK_AERIAL (the sea keeps its blue).
export const LOOK = {
  rampSoftness: 0.16, // half-width of a band edge, in bands
  highlight: 0.06, // fourth band: lift for surfaces facing the sun squarely
  breakup: 0.045,
  aerial: 0.42,
};

const RAMP_CHUNK = /* glsl */ `
#ifdef USE_GRADIENTMAP
  uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
  float dotNL = dot( normal, lightDirection );
  float x = clamp( dotNL * 0.5 + 0.5, 0.0, 1.0 );
  #ifdef USE_GRADIENTMAP
    // Only the nearest band edge can be inside the soft zone (softness < 0.5), so two fetches do.
    float w = float( textureSize( gradientMap, 0 ).x );
    float b = x * w;
    float k = clamp( floor( b + 0.5 ), 1.0, max( w - 1.0, 1.0 ) );
    float vLo = texture2D( gradientMap, vec2( ( k - 0.5 ) / w, 0.5 ) ).r;
    float vHi = texture2D( gradientMap, vec2( min( k + 0.5, w - 0.5 ) / w, 0.5 ) ).r;
    float g = mix( vLo, vHi, smoothstep( k - ${LOOK.rampSoftness.toFixed(3)}, k + ${LOOK.rampSoftness.toFixed(3)}, b ) );
  #else
    float g = mix( 0.7, 1.0, smoothstep( 0.64, 0.76, x ) );
  #endif
  g *= 1.0 + ${LOOK.highlight.toFixed(3)} * smoothstep( 0.86, 0.92, x );
  return vec3( g );
}
`;

const FOG_CHUNK = /* glsl */ `
#ifndef LOOK_AERIAL
  #define LOOK_AERIAL ${LOOK.aerial.toFixed(3)}
#endif
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    float aerial = fogFactor;
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    float aerial = smoothstep( fogNear * 0.2, fogFar * 0.8, vFogDepth );
  #endif
  // Far things lose saturation and contrast before they lose colour: the painter's depth cue.
  float aerialLum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 aerialCol = mix( vec3( aerialLum ), fogColor, 0.5 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, aerialCol, aerial * float( LOOK_AERIAL ) );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

const LOOK_VERT_PARS = /* glsl */ `
varying vec3 vLookWorld;
varying vec3 vLookAnchor;
`;
const LOOK_VERT = /* glsl */ `
{
  vec4 lookWP = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    lookWP = instanceMatrix * lookWP;
  #endif
  vLookWorld = ( modelMatrix * lookWP ).xyz;
  // Fade anchor: an instance's own vertical axis (a tree's trunk) at this vertex's height, so a
  // whole tree dissolves evenly instead of a sphere being carved out of its crown.
  vLookAnchor = vLookWorld;
  #ifdef USE_INSTANCING
    vec3 lookO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
    vLookAnchor = vec3( lookO.x, vLookWorld.y, lookO.z );
  #endif
}
`;
const LOOK_FRAG_PARS = /* glsl */ `
varying vec3 vLookWorld;
varying vec3 vLookAnchor;
// Sin-free hash (Dave Hoskins): cheaper than fract(sin()) and stable on mobile GPUs.
float lookHash( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float lookNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( lookHash( i ), lookHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( lookHash( i + vec2( 0.0, 1.0 ) ), lookHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
#ifdef TOON_RIM
  uniform vec3 rimSky;
  uniform vec3 rimSun;
#endif
#ifdef LOOK_FADE
${FADE_PARS}
#endif
`;
// Foliage and street props near the lens or in front of the player dissolve (see nearfade.js).
const LOOK_FADE_FRAG = /* glsl */ `
#ifdef LOOK_FADE
  if ( lookFadeAlpha( vLookAnchor ) < lookBayer( gl_FragCoord.xy ) ) discard;
#endif
`;
// After color_fragment: tint the albedo, never the lighting, so the bands stay clean.
const LOOK_BREAKUP = /* glsl */ `
#ifndef TOON_RIM
{
  vec2 wp = vLookWorld.xz + vLookWorld.y * 0.35;
  float n = lookNoise( wp * 0.045 ) * 0.65 + lookNoise( wp * 0.17 + 7.3 ) * 0.35;
  diffuseColor.rgb *= 1.0 + ( n - 0.5 ) * 2.0 * ${LOOK.breakup.toFixed(3)};
}
#endif
`;
// Before opaque_fragment: a stepped fresnel rim, warm on the sun side and cool sky elsewhere,
// so characters separate from busy facades in any light.
const LOOK_RIM = /* glsl */ `
#ifdef TOON_RIM
{
  vec3 V = normalize( vViewPosition );
  float fres = 1.0 - clamp( dot( normal, V ), 0.0, 1.0 );
  float rim = smoothstep( 0.62, 0.78, fres );
  float sunSide = 0.0;
  #if NUM_DIR_LIGHTS > 0
    sunSide = smoothstep( -0.1, 0.5, dot( normal, directionalLights[ 0 ].direction ) );
  #endif
  outgoingLight += rim * mix( rimSky, rimSun, sunSide ) * ( 0.35 + 0.65 * diffuseColor.rgb );
}
#endif
`;

export const rimUniforms = {
  rimSky: { value: new THREE.Color(0x6f8fc0) },
  rimSun: { value: new THREE.Color(0xffc27a) },
};

let lookInstalled = false;
function installLookShaders() {
  if (lookInstalled) return;
  lookInstalled = true;
  THREE.ShaderChunk.gradientmap_pars_fragment = RAMP_CHUNK;
  THREE.ShaderChunk.fog_fragment = FOG_CHUNK;
  const toon = THREE.ShaderLib.toon;
  toon.vertexShader = toon.vertexShader
    .replace('#include <common>', '#include <common>\n' + LOOK_VERT_PARS)
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + LOOK_VERT);
  toon.fragmentShader = toon.fragmentShader
    .replace('#include <common>', '#include <common>\n' + LOOK_FRAG_PARS)
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + LOOK_FADE_FRAG)
    .replace('#include <color_fragment>', '#include <color_fragment>\n' + LOOK_BREAKUP)
    .replace('#include <opaque_fragment>', LOOK_RIM + '\n#include <opaque_fragment>');
}
installLookShaders();

// Characters get the rim define plus the shared rim uniforms. Materials are cached per colour in
// the rig, so each one is patched once; called on a slow timer because crowds respawn.
const rimDone = new WeakSet();
function rimify(m) {
  if (!m || !m.isMeshToonMaterial || rimDone.has(m) || m.transparent) return;
  rimDone.add(m);
  m.defines = { ...(m.defines || {}), TOON_RIM: '' };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    shader.uniforms.rimSky = rimUniforms.rimSky;
    shader.uniforms.rimSun = rimUniforms.rimSun;
    if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev.call(m, shader, r);
  };
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = () => 'rim|' + (prevKey ? prevKey.call(m) : '');
  m.needsUpdate = true;
}
export function markCharacters(scene) {
  let n = 0;
  const visit = (o, depth) => {
    if (o.name && o.name.startsWith('avatar:')) {
      if (!o.userData.__rim) {
        o.userData.__rim = true;
        o.traverse((c) => { if (c.isMesh) for (const m of Array.isArray(c.material) ? c.material : [c.material]) rimify(m); });
        n++;
      }
      return;
    }
    if (depth < 4) for (const c of o.children) visit(c, depth + 1);
  };
  visit(scene, 0);
  return n;
}

export function createRenderer({ post = true } = {}) {
  // MSAA is wasted when the composer renders to offscreen targets; FXAA covers it instead.
  const renderer = new THREE.WebGLRenderer({ antialias: !post, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, post ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping flattens saturated toon colours; the grade pass handles warmth instead.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  // PCFSoft (bilinear taps) gives smoother penumbras than PCF + radius, which stair-steps.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.id = 'game';
  renderer.domElement.tabIndex = 0;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 1500);
  camera.position.set(0, 20, 30);
  return { renderer, scene, camera };
}

let sharedRamp = null;

// Three bands read as "cartoon" without the harsh two-tone default of MeshToonMaterial.
export function toonRamp() {
  if (sharedRamp) return sharedRamp;
  // Same bands as the approved concept look.
  const data = new Uint8Array([110, 110, 110, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  sharedRamp = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  sharedRamp.minFilter = THREE.NearestFilter;
  sharedRamp.magFilter = THREE.NearestFilter;
  sharedRamp.generateMipmaps = false;
  sharedRamp.needsUpdate = true;
  return sharedRamp;
}

export function toonMat(color, extra = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(), ...extra });
}

// Other modules create MeshToonMaterial without a ramp; give them the shared one so the
// whole world shades with the same bands.
export function applyToonRamp(root) {
  const ramp = toonRamp();
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m && m.isMeshToonMaterial && !m.gradientMap) {
        m.gradientMap = ramp;
        m.needsUpdate = true;
        n++;
      }
    }
  });
  return n;
}
