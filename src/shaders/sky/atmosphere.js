import * as THREE from 'three';

/**
 * CPU twin of the GLSL sky in sky.frag.glsl.
 *
 * The whole scene must agree on ONE atmosphere: the shader colours the sky, and
 * this file colours the LIGHTS by running the identical single-scattering model
 * on the CPU for a handful of directions (the sun, the zenith). Because the maths
 * is the same, the sunlight can never disagree with the sky behind it.
 *
 * Model = classic single-scattering: Rayleigh (air molecules -> blue sky, red
 * sunset) + Mie (aerosols -> sun glow + horizon haze), integrated along the view
 * ray with a nested ray-march toward the sun for optical depth.
 */

// Physical constants. These are shared with the shader (Environment feeds the
// same numbers into the uniforms), so the two implementations stay in lock-step.
export const ATMOSPHERE = {
  sunIntensity: 22.0,
  planetRadius: 6371e3, // m, Earth
  atmosphereRadius: 6471e3, // m, top of atmosphere
  rayleighCoeff: [5.5e-6, 13.0e-6, 22.4e-6], // per-wavelength (R,G,B) scatter
  mieCoeff: 21e-6,
  rayleighScaleH: 8000, // m, how fast air thins with altitude
  mieScaleH: 1200, // m, aerosols hug the ground
  mieG: 0.758, // Mie anisotropy (forward-scatter -> sun glow)
  primarySteps: 16, // view-ray samples
  lightSteps: 8, // sun-ray samples
  rayleigh: 1.0, // GUI multiplier
  mie: 1.0, // GUI multiplier
};

// --- tiny vec3-as-array helpers (keeps the port readable vs GLSL) ----------
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Ray-sphere intersection; returns [near, far] t, or [1e5,-1e5] on a miss. */
function rsi(r0, rd, sr) {
  const b = dot3(r0, rd);
  const c = dot3(r0, r0) - sr * sr;
  let d = b * b - c;
  if (d < 0) return [1e5, -1e5];
  d = Math.sqrt(d);
  return [-b - d, -b + d];
}

/**
 * In-scattered light for a view ray `dir`, sun at `sunDir`. Returns LINEAR rgb.
 * Line-for-line the same algorithm as atmosphere() in sky.frag.glsl.
 */
export function atmosphere(dir, sunDir, p) {
  const PI = Math.PI;
  const r = norm3(dir);
  const pSun = norm3(sunDir);
  const kR = [
    p.rayleighCoeff[0] * p.rayleigh,
    p.rayleighCoeff[1] * p.rayleigh,
    p.rayleighCoeff[2] * p.rayleigh,
  ];
  const kMie = p.mieCoeff * p.mie;
  const r0 = [0, p.planetRadius + 1000, 0]; // observer ~1km up, like the shader

  const seg = rsi(r0, r, p.atmosphereRadius);
  if (seg[0] > seg[1]) return [0, 0, 0];
  seg[1] = Math.min(seg[1], rsi(r0, r, p.planetRadius)[0]);
  const iStep = (seg[1] - seg[0]) / p.primarySteps;

  let iTime = 0;
  const totalR = [0, 0, 0];
  const totalM = [0, 0, 0];
  let iOdR = 0;
  let iOdM = 0;

  // Phase functions: how much light scatters toward the view given the angle
  // to the sun. Rayleigh is gentle; Mie spikes forward -> the bright sun glow.
  const mu = dot3(r, pSun);
  const mumu = mu * mu;
  const g = p.mieG;
  const gg = g * g;
  const phaseR = (3 / (16 * PI)) * (1 + mumu);
  const phaseM =
    ((3 / (8 * PI)) * ((1 - gg) * (mumu + 1))) /
    (Math.pow(1 + gg - 2 * mu * g, 1.5) * (2 + gg));

  for (let i = 0; i < p.primarySteps; i++) {
    const s = iTime + iStep * 0.5;
    const iPos = [r0[0] + r[0] * s, r0[1] + r[1] * s, r0[2] + r[2] * s];
    const iHeight = Math.hypot(iPos[0], iPos[1], iPos[2]) - p.planetRadius;
    const odR = Math.exp(-iHeight / p.rayleighScaleH) * iStep;
    const odM = Math.exp(-iHeight / p.mieScaleH) * iStep;
    iOdR += odR;
    iOdM += odM;

    // March toward the sun to accumulate how much air the light passed through.
    const jStep = rsi(iPos, pSun, p.atmosphereRadius)[1] / p.lightSteps;
    let jTime = 0;
    let jOdR = 0;
    let jOdM = 0;
    for (let j = 0; j < p.lightSteps; j++) {
      const js = jTime + jStep * 0.5;
      const jPos = [iPos[0] + pSun[0] * js, iPos[1] + pSun[1] * js, iPos[2] + pSun[2] * js];
      const jHeight = Math.hypot(jPos[0], jPos[1], jPos[2]) - p.planetRadius;
      jOdR += Math.exp(-jHeight / p.rayleighScaleH) * jStep;
      jOdM += Math.exp(-jHeight / p.mieScaleH) * jStep;
      jTime += jStep;
    }

    // Attenuation = extinction over the combined path (this is the reddening).
    const aR = kR[0] * (iOdR + jOdR) + kMie * (iOdM + jOdM);
    const aG = kR[1] * (iOdR + jOdR) + kMie * (iOdM + jOdM);
    const aB = kR[2] * (iOdR + jOdR) + kMie * (iOdM + jOdM);
    const attn = [Math.exp(-aR), Math.exp(-aG), Math.exp(-aB)];

    totalR[0] += odR * attn[0];
    totalR[1] += odR * attn[1];
    totalR[2] += odR * attn[2];
    totalM[0] += odM * attn[0];
    totalM[1] += odM * attn[1];
    totalM[2] += odM * attn[2];
    iTime += iStep;
  }

  return [
    p.sunIntensity * (phaseR * kR[0] * totalR[0] + phaseM * kMie * totalM[0]),
    p.sunIntensity * (phaseR * kR[1] * totalR[1] + phaseM * kMie * totalM[1]),
    p.sunIntensity * (phaseR * kR[2] * totalR[2] + phaseM * kMie * totalM[2]),
  ];
}

/**
 * Real solar position for a given clock hour and latitude.
 *  - hourAngle H = 15deg per hour, 0 at solar noon,
 *  - altitude from sin(alt) = sinLat*sinDec + cosLat*cosDec*cosH,
 *  - azimuth measured clockwise from North (afternoon flips it to the west).
 * World convention: +X = East, +Y = up, -Z = North (Three.js "forward").
 *
 * @returns {THREE.Vector3} unit vector pointing FROM the ground TOWARD the sun.
 */
export function sunDirectionFromTime(hour, latDeg, decDeg) {
  const lat = THREE.MathUtils.degToRad(latDeg);
  const dec = THREE.MathUtils.degToRad(decDeg);
  const H = THREE.MathUtils.degToRad(15 * (hour - 12));

  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const alt = Math.asin(THREE.MathUtils.clamp(sinAlt, -1, 1));

  const cosAz =
    (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) /
    (Math.cos(alt) * Math.cos(lat) || 1e-6);
  let az = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1));
  if (H > 0) az = 2 * Math.PI - az; // afternoon -> sun swings to the west

  return new THREE.Vector3(
    Math.cos(alt) * Math.sin(az), // East  (+X)
    Math.sin(alt), // Up (+Y)
    -Math.cos(alt) * Math.cos(az) // North (-Z)
  ).normalize();
}
