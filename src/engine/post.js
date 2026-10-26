// Post: single-pixel ink outlines, normal-aware contact AO, warm colour grade with a highlight
// shoulder, selective bloom (sun disc and water glitter only), SMAA. See docs/ART_DIRECTION.md.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { FADE_PARS, bindFadeUniforms } from './nearfade.js';

// ?aa=fxaa falls back to the cheaper FXAA; ?bloom=0 and ?ao=0 switch those passes off.
const PARAMS = new URLSearchParams(location.search);

const OutlineGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.5 },
    cameraFar: { value: 4000 },
    tanHalfFov: { value: 0.52 },
    aspect: { value: 1.6 },
    outlineColor: { value: new THREE.Color(0x2b1d14) },
    outlineStrength: { value: 0.95 },
    thickness: { value: 1.0 },
    fadeStart: { value: 220 },
    fadeEnd: { value: 480 },
    aoRadius: { value: 1.3 },
    aoStrength: { value: PARAMS.get('ao') === '0' ? 0 : 0.75 },
    aoTint: { value: new THREE.Color(0x4a3f5c) },
    vignette: { value: 0.28 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse, tNormal, tDepth;
    uniform vec2 resolution;
    uniform float cameraNear, cameraFar, outlineStrength, thickness, fadeStart, fadeEnd;
    uniform float tanHalfFov, aspect, aoRadius, aoStrength, vignette;
    uniform vec3 outlineColor, aoTint;
    varying vec2 vUv;

    float viewZ(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      return -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
    }
    vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
    vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * vec2(tanHalfFov * aspect, tanHalfFov) * z, -z); }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col = base.rgb;
      float dC = texture2D(tDepth, vUv).x;
      float edge = 0.0;
      float ao = 1.0;
      if (dC < 0.99999) {
        float zC = viewZ(vUv);
        // Sample spacing shrinks with distance: ~2 px ink up close, a hairline down the street.
        vec2 px = thickness * mix(1.0, 0.5, smoothstep(25.0, 180.0, zC)) / resolution;
        float zL = viewZ(vUv - vec2(px.x, 0.0)), zR = viewZ(vUv + vec2(px.x, 0.0));
        float zU = viewZ(vUv + vec2(0.0, px.y)), zD = viewZ(vUv - vec2(0.0, px.y));
        // Signed Laplacian on linear depth: flat slopes cancel, and only the NEAR side of a
        // silhouette is positive, so each edge gets one line instead of a doubled one.
        float lap = (zL + zR + zU + zD - 4.0 * zC) / max(zC, 1.0);
        float depthEdge = smoothstep(0.03, 0.08, lap);
        // Creases: compare with the right/up neighbours only (one side of the crease), and only
        // where that neighbour is not in front of us (that case is a silhouette, drawn above).
        vec3 nC = nrm(vUv);
        float nd = 0.0;
        if (zR > zC * 0.985) nd = max(nd, 1.0 - dot(nC, nrm(vUv + vec2(px.x, 0.0))));
        if (zU > zC * 0.985) nd = max(nd, 1.0 - dot(nC, nrm(vUv + vec2(0.0, px.y))));
        float normalEdge = smoothstep(0.25, 0.5, nd);
        edge = max(depthEdge, normalEdge);
        // Line weight falls with distance: full ink up close, a pencil line mid-way, none far.
        edge *= mix(1.0, 0.6, smoothstep(50.0, fadeStart, zC)) * (1.0 - smoothstep(fadeStart, fadeEnd, zC));

        // Contact AO: a fixed 8-tap spiral in a world-sized disc, scored against the normal so
        // flat ground does not self-occlude. Darkens wall bases, kerbs, under benches and cars.
        if (aoStrength > 0.0 && zC < 150.0) {
          vec3 P = viewPos(vUv, zC);
          float rPx = clamp(aoRadius * resolution.y / (2.0 * tanHalfFov * zC), 3.0, 48.0);
          float occ = 0.0;
          for (int i = 0; i < 8; i++) {
            float fi = float(i);
            float ang = fi * 2.39996 + 0.6;
            float rr = (fi + 0.5) / 8.0;
            vec2 o = vec2(cos(ang), sin(ang)) * rr * rPx / resolution;
            vec2 su = vUv + o;
            vec3 S = viewPos(su, viewZ(su));
            vec3 v = S - P;
            float d = length(v);
            float w = 1.0 - smoothstep(aoRadius * 0.4, aoRadius, d);
            occ += max(dot(nC, v / max(d, 1e-3)) - 0.2, 0.0) * w;
          }
          ao = 1.0 - clamp(occ / 8.0 * 2.2, 0.0, 1.0) * aoStrength * (1.0 - smoothstep(90.0, 150.0, zC));
        }
      }
      // Coloured shadow, not black: AO pulls toward a warm violet, like a painter's shade.
      col *= mix(aoTint * 1.6, vec3(1.0), ao);

      // Ink: warm brown, picking up a little of the surface colour so lines feel drawn, not stamped.
      vec3 ink = mix(outlineColor, col * 0.3, 0.2);
      col = mix(col, ink, edge * outlineStrength);

      // Grade (linear): gentle saturation, cool-violet shadows / warm highlights split tone, and a
      // soft shoulder so sunlit white plaster keeps its shading instead of clipping flat.
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, 1.06);
      col *= mix(vec3(0.985, 0.97, 1.025), vec3(1.035, 1.0, 0.95), smoothstep(0.05, 0.7, l));
      const float knee = 0.82;
      vec3 over = max(col - knee, 0.0);
      col = min(col, knee) + (1.0 - knee) * (1.0 - exp(-over / (1.0 - knee)));
      vec2 q = vUv - 0.5;
      col *= 1.0 - dot(q, q) * vignette;
      gl_FragColor = vec4(max(col, 0.0), base.a);
    }`,
};

// Normal/depth pre-pass material: MeshNormalMaterial's output, plus the near-lens fade for meshes
// flagged userData.lookFade, so a dissolving canopy leaves no ink lines or AO behind. The flag is
// read per draw (onBeforeRender) because one override material serves the whole scene.
function makeNormalMaterial() {
  const uniforms = { lookFade: { value: 0 } };
  bindFadeUniforms(uniforms);
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      #include <common>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      varying vec3 vNrm;
      varying vec3 vWorldF;
      void main() {
        #include <beginnormal_vertex>
        #include <morphnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vNrm = normalize( transformedNormal );
        vec4 wp = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        vWorldF = ( modelMatrix * wp ).xyz;
        // Same anchor as the toon pass (renderer.js), so ink and colour agree on what is faded.
        #ifdef USE_INSTANCING
          vec3 lookO = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          vWorldF = vec3( lookO.x, vWorldF.y, lookO.z );
        #endif
      }`,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform float lookFade;
      ${FADE_PARS}
      varying vec3 vNrm;
      varying vec3 vWorldF;
      void main() {
        if ( lookFade > 0.5 && lookFadeAlpha( vWorldF ) < 0.98 ) discard;
        gl_FragColor = vec4( packNormalToRGB( normalize( vNrm ) ), 1.0 );
      }`,
  });
  m.onBeforeRender = (r, s, c, g, object) => {
    const f = object.userData.lookFade ? 1 : 0;
    if (f !== uniforms.lookFade.value) { uniforms.lookFade.value = f; m.uniformsNeedUpdate = true; }
  };
  return m;
}

export function createPost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const w = Math.floor(size.x * pr), h = Math.floor(size.y * pr);

  const depthTex = new THREE.DepthTexture(w, h);
  depthTex.type = THREE.UnsignedIntType;
  const normalTarget = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: depthTex,
  });
  const normalMat = makeNormalMaterial();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  // Bloom reads the raw HDR frame, before the grade's shoulder: only the sun disc (pushed to ~3)
  // and water glitter (~2.5) pass the threshold; sunlit plaster tops out near 1.5.
  let bloom = null;
  if (PARAMS.get('bloom') !== '0') {
    bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.55, 0.45, 1.75);
    // Quarter-resolution mips are plenty for a glow and keep the pass under a millisecond.
    const bloomSetSize = bloom.setSize.bind(bloom);
    bloom.setSize = (bw, bh) => bloomSetSize(Math.max(2, bw / 2), Math.max(2, bh / 2));
    composer.addPass(bloom);
  }
  const outline = new ShaderPass(OutlineGradeShader);
  outline.uniforms.tNormal.value = normalTarget.texture;
  outline.uniforms.tDepth.value = depthTex;
  composer.addPass(outline);
  composer.addPass(new OutputPass());
  // SMAA keeps one-pixel ink lines crisp where FXAA smeared them.
  const useFxaa = PARAMS.get('aa') === 'fxaa';
  const fxaa = useFxaa ? new ShaderPass(FXAAShader) : null;
  const smaa = useFxaa ? null : new SMAAPass(w, h);
  composer.addPass(fxaa || smaa);

  const hidden = [];
  // Explicit registry instead of a per-frame scene traversal: the city can hold thousands of nodes.
  const excluded = new Set();
  function setSize(cw, ch) {
    const p = renderer.getPixelRatio();
    composer.setPixelRatio(p);
    composer.setSize(cw, ch);
    normalTarget.setSize(Math.floor(cw * p), Math.floor(ch * p));
    outline.uniforms.resolution.value.set(Math.floor(cw * p), Math.floor(ch * p));
    // One-sided edges are a single sample wide; this keeps them near 1 CSS pixel at any ratio.
    outline.uniforms.thickness.value = Math.max(1.6, p * 1.8);
    if (fxaa) fxaa.uniforms.resolution.value.set(1 / (cw * p), 1 / (ch * p));
  }
  setSize(size.x, size.y);

  const prevAuto = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;

  // The outline pre-pass only needs the near city (lines fade out by fadeEnd), so it uses a
  // short far plane: that culls most chunks and roughly halves the extra draw calls.
  const PRE_FAR = 560;
  function render() {
    const fullFar = camera.far;
    const preFar = Math.min(PRE_FAR, fullFar);
    outline.uniforms.cameraNear.value = camera.near;
    outline.uniforms.cameraFar.value = preFar;
    outline.uniforms.tanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    outline.uniforms.aspect.value = camera.aspect;
    // Each renderer.render() walks the whole scene graph to refresh world matrices (~2 ms for
    // 23k nodes). The pre-pass and the colour pass see the same frame, so do it once.
    scene.updateMatrixWorld();
    const autoWorld = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    camera.far = preFar;
    camera.updateProjectionMatrix();

    // Normal/depth pre-pass. Sky, clouds and anything flagged noOutline stay out of it.
    hidden.length = 0;
    for (const o of excluded) if (o.visible) { o.visible = false; hidden.push(o); }
    const bg = scene.background, fog = scene.fog;
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = normalMat;
    renderer.setRenderTarget(normalTarget);
    renderer.setClearColor(0x8080ff, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    scene.overrideMaterial = null;
    scene.background = bg;
    scene.fog = fog;
    for (const o of hidden) o.visible = true;
    camera.far = fullFar;
    camera.updateProjectionMatrix();

    // Shadows render once per frame, in the colour pass only.
    renderer.shadowMap.needsUpdate = true;
    try { composer.render(); } finally { scene.matrixWorldAutoUpdate = autoWorld; }
  }

  function dispose() {
    renderer.shadowMap.autoUpdate = prevAuto;
    composer.dispose();
    normalTarget.dispose();
  }

  return { composer, render, setSize, dispose, uniforms: outline.uniforms, bloom, exclude: (o) => excluded.add(o) };
}
