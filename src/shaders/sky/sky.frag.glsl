// Physically based single-scattering sky: Rayleigh (blue sky / red sunset) +
// Mie (sun glow, horizon haze), ray-marched. This is the GPU half of the model;
// atmosphere.js is the CPU half that colours the scene lights from the SAME maths
// so lighting always matches the sky. Ported from the classic O'Neil-style model.

varying vec3 vDir;

uniform vec3 uSunDirection; // toward the sun (drives light + sky together)
uniform float uSunIntensity;
uniform vec3 uRayleighCoeff;
uniform float uMieCoeff;
uniform float uRayleigh; // GUI multiplier
uniform float uMie; // GUI multiplier
uniform float uMieG; // Mie anisotropy
uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform float uRayleighScaleH;
uniform float uMieScaleH;

// Sun disc
uniform vec3 uSunDiscColor; // reddened sun colour, sampled from the atmosphere
uniform float uSunAngularRadius; // radians
uniform float uSunDiscIntensity;
uniform float uLimbDarkening; // 0..1, edge dimming

#define PI 3.141592653589793
#define I_STEPS 16
#define J_STEPS 8

// Ray-sphere intersection: [near, far] hit distances, or [1e5,-1e5] on a miss.
vec2 rsi(vec3 r0, vec3 rd, float sr) {
  float b = dot(r0, rd);
  float c = dot(r0, r0) - sr * sr;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e5, -1e5);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

vec3 atmosphere(vec3 r, vec3 r0, vec3 pSun) {
  pSun = normalize(pSun);
  r = normalize(r);
  vec3 kRlh = uRayleighCoeff * uRayleigh;
  float kMie = uMieCoeff * uMie;

  vec2 p = rsi(r0, r, uAtmosphereRadius);
  if (p.x > p.y) return vec3(0.0);
  p.y = min(p.y, rsi(r0, r, uPlanetRadius).x); // stop at the ground if we hit it
  float iStepSize = (p.y - p.x) / float(I_STEPS);

  float iTime = 0.0;
  vec3 totalRlh = vec3(0.0);
  vec3 totalMie = vec3(0.0);
  float iOdRlh = 0.0;
  float iOdMie = 0.0;

  // Phase functions: scatter weight toward the eye given the angle to the sun.
  float mu = dot(r, pSun);
  float mumu = mu * mu;
  float g = uMieG;
  float gg = g * g;
  float pRlh = 3.0 / (16.0 * PI) * (1.0 + mumu);
  float pMie = 3.0 / (8.0 * PI) * ((1.0 - gg) * (mumu + 1.0)) /
    (pow(1.0 + gg - 2.0 * mu * g, 1.5) * (2.0 + gg));

  for (int i = 0; i < I_STEPS; i++) {
    vec3 iPos = r0 + r * (iTime + iStepSize * 0.5);
    float iHeight = length(iPos) - uPlanetRadius;
    float odStepRlh = exp(-iHeight / uRayleighScaleH) * iStepSize;
    float odStepMie = exp(-iHeight / uMieScaleH) * iStepSize;
    iOdRlh += odStepRlh;
    iOdMie += odStepMie;

    // Secondary march toward the sun -> optical depth of the incoming light.
    float jStepSize = rsi(iPos, pSun, uAtmosphereRadius).y / float(J_STEPS);
    float jTime = 0.0;
    float jOdRlh = 0.0;
    float jOdMie = 0.0;
    for (int j = 0; j < J_STEPS; j++) {
      vec3 jPos = iPos + pSun * (jTime + jStepSize * 0.5);
      float jHeight = length(jPos) - uPlanetRadius;
      jOdRlh += exp(-jHeight / uRayleighScaleH) * jStepSize;
      jOdMie += exp(-jHeight / uMieScaleH) * jStepSize;
      jTime += jStepSize;
    }

    // Extinction over the whole path (view + sun) — this reddens low sun.
    vec3 attn = exp(-(kMie * (iOdMie + jOdMie) + kRlh * (iOdRlh + jOdRlh)));
    totalRlh += odStepRlh * attn;
    totalMie += odStepMie * attn;
    iTime += iStepSize;
  }

  return uSunIntensity * (pRlh * kRlh * totalRlh + pMie * kMie * totalMie);
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 r0 = vec3(0.0, uPlanetRadius + 1000.0, 0.0);
  vec3 color = atmosphere(dir, r0, uSunDirection);

  // Sun disc with soft limb darkening (brightest at the centre, dimmer at the
  // rim — the same effect you see on the real sun), tinted by the reddened sun
  // colour so it goes orange near the horizon.
  float cosd = dot(dir, normalize(uSunDirection));
  float ang = acos(clamp(cosd, -1.0, 1.0));
  if (ang < uSunAngularRadius) {
    float x = ang / uSunAngularRadius; // 0 centre .. 1 rim
    float limb = 1.0 - uLimbDarkening * (1.0 - sqrt(max(0.0, 1.0 - x * x)));
    float edge = smoothstep(1.0, 0.9, x); // soft anti-aliased rim
    color += uSunDiscColor * uSunDiscIntensity * limb * edge;
  }

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment> // ACES, matches the rest of the scene
  #include <colorspace_fragment> // linear -> sRGB for the canvas
}
