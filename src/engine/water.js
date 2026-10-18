// Stylised animated water. Any mesh with userData.water === true gets this material.
// Shoreline foam comes from a mask texture drawn from the mesh's own boundary edges,
// so it works for whatever sea/lake polygon the map module produces.
import * as THREE from 'three';
import { SUN_DIR } from './sky.js';

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform float time;
  uniform vec3 deep, mid, shallow, foamCol, sunDir, sunCol;
  uniform sampler2D foamMap;
  uniform vec4 foamRect; // minX, minZ, 1/width, 1/depth
  uniform float hasFoam;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 p = vWorld.xz;
    vec2 uv = (p - foamRect.xy) * foamRect.zw;
    float shore = hasFoam > 0.5 ? texture2D(foamMap, uv).r : 0.0;
    vec3 V = normalize(cameraPosition - vWorld);
    float dist = length(cameraPosition - vWorld);

    // Depth read from the shore mask: navy-teal open sea -> turquoise -> sandy shallows.
    // Inland water (no mask) is a clear lake/pool turquoise that matches the private pools.
    vec3 col = hasFoam > 0.5
      ? mix(mix(deep, mid, smoothstep(0.0, 0.35, shore)), shallow, smoothstep(0.45, 0.9, shore))
      : mix(mid, shallow, 0.55 + 0.25 * noise(p * 0.08));

    // Two wave scales; the normal they imply drives crests, glints and the sky reflection.
    float n = noise(p * 0.045 + vec2(time * 0.12, time * 0.05)) * 0.6
            + noise(p * 0.11 - vec2(time * 0.08, -time * 0.1)) * 0.4;
    float n2 = noise(p * 0.07 + time * 0.2);
    vec3 N = normalize(vec3((n - 0.5) * 0.35, 1.0, (n2 - 0.5) * 0.35));

    // Sky reflection at grazing angles: the far sea takes the horizon's colour, like a painting.
    // Mid angles mirror the blue upper sky, only the grazing band takes the warm horizon haze.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    vec3 skyRefl = vec3(0.36, 0.56, 0.82);
    #ifdef USE_FOG
      skyRefl = mix(skyRefl, fogColor, smoothstep(0.8, 0.98, fres));
    #endif
    col = mix(col, skyRefl, clamp(fres * 0.4, 0.0, 0.28));

    // Cartoon wave crests, thinned out with distance so the horizon stays calm.
    float crest = smoothstep(0.66, 0.70, n) * (1.0 - smoothstep(0.73, 0.78, n));
    col = mix(col, vec3(0.92, 0.98, 1.0), crest * 0.45 * (1.0 - smoothstep(60.0, 320.0, dist)));

    // Sun: a broad stepped sheen plus glitter. Glitter = sparse twinkling cells inside the
    // reflection lobe, pushed past 1.0 so the bloom pass picks them up and nothing else.
    vec3 R = reflect(-sunDir, N);
    float lobe = max(dot(R, V), 0.0);
    col += sunCol * smoothstep(0.55, 0.62, pow(lobe, 40.0)) * 0.35;
    // Cells grow with distance so glints stay a few pixels wide instead of aliasing to speckle.
    float cs = 0.9 / (1.0 + dist * 0.012);
    vec2 cell = floor(p * cs + vec2(time * 0.6, time * 0.25));
    float tw = hash(cell + floor(time * 3.0));
    float glit = step(0.93, tw) * smoothstep(0.93, 0.99, lobe);
    col += sunCol * glit * 2.2;

    // Foam: a lacy breaker line at the coast and bands that roll toward the beach.
    float band = fract(shore * 3.0 - time * 0.35 + noise(p * 0.08) * 0.6);
    float lace = noise(p * 0.35 + vec2(time * 0.4, 0.0));
    float edge = smoothstep(0.84, 0.9, shore + (lace - 0.5) * 0.08);
    float foam = edge + step(0.84, band) * smoothstep(0.3, 0.6, shore) * (1.0 - edge) * 0.8;
    foam *= step(0.35, noise(p * 0.18 + time * 0.3)) * 0.35 + 0.65;
    col = mix(col, foamCol, clamp(foam, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

export function makeWaterMaterial(foamInfo) {
  const mat = new THREE.ShaderMaterial({
    fog: true,
    // Light aerial desaturation only: a grey far sea reads as overcast, not golden hour.
    defines: { LOOK_AERIAL: 0.1 },
    side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        time: { value: 0 },
        deep: { value: new THREE.Color(0x14708f) },
        mid: { value: new THREE.Color(0x1f9fc6) },
        shallow: { value: new THREE.Color(0x5fd0d4) },
        foamCol: { value: new THREE.Color(0xfffbf2) },
        sunCol: { value: new THREE.Color(0xfff0d0) },
        sunDir: { value: null },
        foamMap: { value: foamInfo ? foamInfo.texture : null },
        foamRect: { value: foamInfo ? foamInfo.rect : new THREE.Vector4(0, 0, 1, 1) },
        hasFoam: { value: foamInfo ? 1 : 0 },
      },
    ]),
    vertexShader,
    fragmentShader,
  });
  // By reference (merge() clones): the glitter follows the time-of-day preset.
  mat.uniforms.sunDir.value = SUN_DIR;
  return mat;
}

// Boundary edges of a mesh in world XZ, minus edges lying on the bounding box
// (those are open sea, not coast).
function coastEdges(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!pos) return null;
  mesh.updateWorldMatrix(true, false);
  const v = new THREE.Vector3();
  const pts = [];
  const keyOf = new Map();
  const ids = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const k = `${Math.round(v.x * 10)},${Math.round(v.z * 10)}`;
    let id = keyOf.get(k);
    if (id === undefined) { id = pts.length; keyOf.set(k, id); pts.push([v.x, v.z]); }
    ids[i] = id;
  }
  const idx = geo.index ? geo.index.array : null;
  const triCount = idx ? idx.length / 3 : pos.count / 3;
  const edges = new Map();
  const add = (a, b) => {
    if (a === b) return;
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    const e = edges.get(k);
    if (e) e.n++; else edges.set(k, { a, b, n: 1 });
  };
  for (let t = 0; t < triCount; t++) {
    const i0 = ids[idx ? idx[t * 3] : t * 3], i1 = ids[idx ? idx[t * 3 + 1] : t * 3 + 1], i2 = ids[idx ? idx[t * 3 + 2] : t * 3 + 2];
    add(i0, i1); add(i1, i2); add(i2, i0);
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const eps = Math.max(maxX - minX, maxZ - minZ) * 0.002 + 0.5;
  const onBox = (p, q) =>
    (Math.abs(p[0] - minX) < eps && Math.abs(q[0] - minX) < eps) || (Math.abs(p[0] - maxX) < eps && Math.abs(q[0] - maxX) < eps) ||
    (Math.abs(p[1] - minZ) < eps && Math.abs(q[1] - minZ) < eps) || (Math.abs(p[1] - maxZ) < eps && Math.abs(q[1] - maxZ) < eps);
  const out = [];
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    const p = pts[e.a], q = pts[e.b];
    if (!onBox(p, q)) out.push([p, q]);
  }
  return { edges: out, minX, maxX, minZ, maxZ };
}

function foamTexture(info) {
  if (!info || info.edges.length === 0) return null;
  const w = info.maxX - info.minX || 1, d = info.maxZ - info.minZ || 1;
  const MAX = 2048;
  const s = MAX / Math.max(w, d);
  const cw = Math.max(8, Math.ceil(w * s)), ch = Math.max(8, Math.ceil(d * s));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, cw, ch);
  g.lineCap = 'round';
  // Layered strokes make a soft distance falloff: wide+faint out to sea, narrow+bright at the coast.
  const layers = [[90, 0.1], [55, 0.14], [32, 0.2], [18, 0.28], [9, 0.45], [4, 1.0]];
  g.strokeStyle = '#fff';
  for (const [worldWidth, alpha] of layers) {
    g.globalAlpha = alpha;
    g.lineWidth = Math.max(1, worldWidth * s);
    g.beginPath();
    for (const [p, q] of info.edges) {
      g.moveTo((p[0] - info.minX) * s, (p[1] - info.minZ) * s);
      g.lineTo((q[0] - info.minX) * s, (q[1] - info.minZ) * s);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  return {
    texture: tex,
    rect: new THREE.Vector4(info.minX, info.minZ, 1 / (info.maxX - info.minX || 1), 1 / (info.maxZ - info.minZ || 1)),
  };
}

export function applyWater(scene) {
  const mats = [];
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh && o.userData && o.userData.water === true) meshes.push(o); });
  for (const m of meshes) {
    let foam = null;
    // Sea-scale foam bands (up to 90 u) would whiten a park pond or a channel: inland water
    // meshes opt out with userData.foam === false.
    if (m.userData.foam !== false) try { foam = foamTexture(coastEdges(m)); } catch (e) { console.warn('[water] foam mask failed', e); }
    const mat = makeWaterMaterial(foam);
    m.material = mat;
    m.receiveShadow = false;
    m.castShadow = false;
    mats.push(mat);
  }
  return {
    count: meshes.length,
    meshes,
    update(t) { for (const m of mats) m.uniforms.time.value = t; },
  };
}
