import * as THREE from 'three';

/**
 * Mud-brick material for the minaret.
 *
 * It is a normal MeshStandardMaterial (so it still gets the scene's real
 * lighting, shadows and tone mapping) that we hijack with onBeforeCompile to
 * inject a fully procedural surface — NO texture files at all.
 *
 * Everything is TRIPLANAR: the pattern is evaluated on the three world planes
 * (zy, xz, xy) and blended by the world normal, so bricks never smear or stretch
 * as they wrap the conical tower (a single UV set always stretches on a cone).
 *
 * Three scales of detail, exactly like real masonry read from far to near:
 *   1. COURSE bands   — per-row tone shift (the big horizontal banding).
 *   2. PER-BRICK       — each brick a slightly different colour (hash per cell).
 *   3. GRAIN / PITTING — high-frequency multi-octave noise.
 *
 * Plus the weathering a 1200-year-old building actually shows:
 *   - roughness driven by the noise, and polished where feet/hands wear the ramp,
 *   - cavity darkening — dirt collecting in mortar lines,
 *   - edge wear — brick edges lighter and smoother from centuries of wind,
 *   - a `weathering` uniform (0..1) piling pale dust on upward-facing surfaces.
 *
 * @param {object} p           - Malwiya params (colours, sizes, weathering...).
 * @param {boolean} vertexColors - true for meshes that carry baked-AO vertex
 *                                 colours (tower, ramp); false otherwise.
 */
export function createMudBrickMaterial(p, vertexColors = false) {
  // Colours are authored in sRGB; convert to the renderer's linear working space
  // so they light correctly (three does this automatically for material.color,
  // but NOT for our custom uniforms, so we do it by hand).
  const lin = (hex) => new THREE.Color(hex).convertSRGBToLinear();

  const uniforms = {
    uWeathering: { value: p.weathering },
    uBrickW: { value: p.brickTexW },
    uBrickH: { value: p.brickTexH },
    uMortar: { value: p.mortarWidth },
    uCavityDark: { value: p.cavityDark },
    uEdgeWear: { value: p.edgeWear },
    uGrainScale: { value: p.grainScale },
    uPolish: { value: p.polish },
    uBrickColorA: { value: lin(p.brickColorA) },
    uBrickColorB: { value: lin(p.brickColorB) },
    uMortarColor: { value: lin(p.mortarColor) },
    uDustColor: { value: lin(p.dustColor) },
    uBrickRough: { value: p.brickRough },
    uMortarRough: { value: p.mortarRough },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, // white — the procedure supplies all the colour
    roughness: 0.9,
    metalness: 0.0,
    vertexColors,
  });

  // Give the compiled program a stable, unique cache key so it is never confused
  // with a plain MeshStandardMaterial (and the two vertexColors variants differ).
  material.customProgramCacheKey = () => `mudbrick:${vertexColors ? 'vc' : 'plain'}`;

  material.onBeforeCompile = (shader) => {
    // Share our uniform objects (by reference) so live edits reach the GPU.
    Object.assign(shader.uniforms, uniforms);

    // --- Vertex: expose world position + world normal to the fragment -------
    shader.vertexShader =
      'varying vec3 vWorldPos;\nvarying vec3 vWorldNrm;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n  vWorldNrm = normalize(mat3(modelMatrix) * objectNormal);'
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
    );

    // --- Fragment: procedural mud brick ------------------------------------
    shader.fragmentShader = FRAG_HEADER + shader.fragmentShader;
    // Compute albedo + roughness in place of the (absent) texture fetch.
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', MAP_BLOCK);
    // Drive roughness from the procedure instead of the flat uniform.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      'float roughnessFactor = clamp(gMudRough, 0.04, 1.0);'
    );
  };

  // Keep the uniform bag reachable so the GUI can retune it live.
  material.userData.mudUniforms = uniforms;
  return material;
}

// --------------------------------------------------------------------------
//  GLSL — prepended to the MeshStandard fragment shader
// --------------------------------------------------------------------------
const FRAG_HEADER = /* glsl */ `
uniform float uWeathering;
uniform float uBrickW;
uniform float uBrickH;
uniform float uMortar;
uniform float uCavityDark;
uniform float uEdgeWear;
uniform float uGrainScale;
uniform float uPolish;
uniform vec3  uBrickColorA;
uniform vec3  uBrickColorB;
uniform vec3  uMortarColor;
uniform vec3  uDustColor;
uniform float uBrickRough;
uniform float uMortarRough;

varying vec3 vWorldPos;
varying vec3 vWorldNrm;

float gMudRough; // shared between the map + roughness injection points

// Cheap hashes for per-brick / per-course randomness.
float hash12(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float hash13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }

// 3D value noise + fbm for the grain (world-space -> never stretches).
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0,0,0)), n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
             mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
}
float fbm(vec3 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.02; a *= 0.5; }
  return s;
}

// Running-bond brick lattice. Returns: x = brick mask (1 inside, 0 in mortar),
// yz = brick cell id (for per-brick randomness), w = distance to nearest edge.
vec4 brickPattern(vec2 uv){
  float row = floor(uv.y / uBrickH);
  float offset = mod(row, 2.0) * 0.5;         // every other course shifts half a brick
  float cx = uv.x / uBrickW + offset;
  vec2 cell = vec2(floor(cx), row);
  vec2 f = vec2(fract(cx), fract(uv.y / uBrickH));
  float mx = min(smoothstep(0.0, uMortar, f.x), smoothstep(0.0, uMortar, 1.0 - f.x));
  float my = min(smoothstep(0.0, uMortar, f.y), smoothstep(0.0, uMortar, 1.0 - f.y));
  float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  return vec4(mx * my, cell, edge);
}

// Shade one triplanar plane -> albedo + roughness. The world-space noises
// (grain, mortarNoise) are identical on every plane, so we compute them ONCE in
// the caller and pass them in rather than paying for fbm three times.
void mudPlane(vec2 uv, float grain, float mortarNoise, out vec3 albedo, out float rough){
  vec4 bp = brickPattern(uv);
  float brickMask = bp.x;
  vec2 cell = bp.yz;
  float edge = bp.w;

  float perBrick = hash12(cell * vec2(12.7, 7.3));    // scale 2: per-brick drift
  vec3 brickCol = mix(uBrickColorA, uBrickColorB, perBrick);
  float course = hash12(vec2(cell.y, 3.1));           // scale 1: course bands
  brickCol *= 0.88 + 0.24 * course;
  brickCol *= 0.82 + 0.36 * grain;                    // scale 3: fine grain

  vec3 mortarCol = uMortarColor * (0.8 + 0.2 * mortarNoise);
  albedo = mix(mortarCol, brickCol, brickMask);

  // Cavity: mortar sits recessed, so dirt gathers and darkens it.
  albedo *= 1.0 - (1.0 - brickMask) * uCavityDark;

  // Edge wear: a bright, smooth rim just inside each brick's border.
  float rim = (1.0 - smoothstep(uMortar, uMortar * 2.5, edge)) * brickMask;
  albedo = mix(albedo, albedo * 1.25 + 0.02, rim * uEdgeWear);

  rough = mix(uMortarRough, uBrickRough, brickMask);
  rough *= 0.85 + 0.3 * grain;                        // roughness follows the noise
  rough = mix(rough, rough * 0.55, rim * uEdgeWear);  // worn edges are smoother
}
`;

// Replaces #include <map_fragment>: builds the triplanar surface and writes it
// into diffuseColor + gMudRough.
const MAP_BLOCK = /* glsl */ `
  vec3 wp = vWorldPos;
  vec3 wn = normalize(vWorldNrm);
  vec3 tw = pow(abs(wn), vec3(4.0));                  // triplanar blend weights
  tw /= (tw.x + tw.y + tw.z);

  // World-space noises — computed once, shared by all three planes.
  float grain = fbm(wp * uGrainScale);                 // scale 3: fine grain
  float mortarNoise = fbm(wp * 0.6);

  vec3 aX, aY, aZ; float rX, rY, rZ;
  mudPlane(wp.zy, grain, mortarNoise, aX, rX);         // plane facing X
  mudPlane(wp.xz, grain, mortarNoise, aY, rY);         // plane facing Y (up)
  mudPlane(wp.xy, grain, mortarNoise, aZ, rZ);         // plane facing Z
  vec3 mudAlbedo = aX * tw.x + aY * tw.y + aZ * tw.z;
  gMudRough      = rX * tw.x + rY * tw.y + rZ * tw.z;

  // Foot/hand polish: near-horizontal, up-facing surfaces (the ramp tread) are
  // smoothed by centuries of traffic.
  gMudRough = mix(gMudRough, gMudRough * uPolish, smoothstep(0.55, 0.95, wn.y));

  // Weathering: pale dust accumulates on upward-facing surfaces (normal.y).
  float dust = uWeathering * smoothstep(0.15, 0.85, wn.y);
  mudAlbedo = mix(mudAlbedo, uDustColor, dust * 0.65);
  gMudRough = mix(gMudRough, 0.95, dust * 0.7);

  diffuseColor.rgb *= mudAlbedo;
`;
