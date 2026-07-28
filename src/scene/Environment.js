import * as THREE from 'three';
import Sky from '../shaders/sky/Sky.js';
import { ATMOSPHERE, atmosphere, sunDirectionFromTime } from '../shaders/sky/atmosphere.js';

/**
 * Environment — the single source of truth for the sun.
 *
 * One `sunDirection` (from time-of-day + latitude) drives EVERYTHING:
 *   - the sky shader uniform,
 *   - the DirectionalLight's position, and
 *   - the light colours, which are sampled from atmosphere() so the sunlight can
 *     never disagree with the sky it came from.
 *
 * The four real light sources of desert architecture:
 *   1. Direct sun      — warm DirectionalLight, low angle, sharp shadows.
 *   2. Sky bounce      — cool blue fill from above  (HemisphereLight, top).
 *   3. Ground bounce   — warm ochre from the sand up onto undersides
 *                        (HemisphereLight, bottom — down-facing surfaces get it).
 *   4. Ambient occlusion — baked into the minaret's vertices (see Malwiya),
 *                        darkening contact areas; here we just keep the ambient
 *                        fill low so that occlusion actually reads.
 */
export default class Environment {
  constructor(scene, gui) {
    this.scene = scene;

    // Merge the physical atmosphere constants with scene-lighting controls.
    this.params = Object.assign({}, ATMOSPHERE, {
      timeOfDay: 17.2, // h, low golden hour (sun ~10 deg above horizon)
      latitude: 34.2, // deg N — Samarra, Iraq
      declination: 0, // deg — equinox-ish; +/- shifts the seasonal arc
      sunIntensityScale: 2.6, // DirectionalLight brightness
      hemiIntensity: 0.9, // sky + ground bounce strength
      groundColor: '#b07a3c', // warm ochre sand for the ground bounce
      sunDistance: 200, // where we park the light for shadow framing
    });

    // --- Sky dome -----------------------------------------------------------
    this.sky = new Sky(this.params);
    scene.add(this.sky.mesh);

    // --- 1. Direct sun ------------------------------------------------------
    this.sun = new THREE.DirectionalLight(0xffffff, this.params.sunIntensityScale);
    this.sun.castShadow = true;
    scene.add(this.sun);
    scene.add(this.sun.target); // the light aims at this; moved in focusOn()

    // --- 2 + 3. Sky bounce (top) & ground bounce (bottom) -------------------
    // A HemisphereLight is exactly this: up-facing surfaces get the sky colour,
    // DOWN-facing surfaces (the underside of the ramp!) get the ground colour.
    this.hemi = new THREE.HemisphereLight(0x88aacc, this.params.groundColor, this.params.hemiIntensity);
    scene.add(this.hemi);

    this.focus = { center: new THREE.Vector3(0, 25, 0), radius: 40 };
    this.configureShadow();
    this.updateSun();
    if (gui) this.buildGUI(gui);
  }

  /**
   * Point the sun/shadow system at the finished minaret. Called by Scene once it
   * knows the real bounds, so the shadow frustum hugs the tower tightly and the
   * helical ramp throws a crisp spiral shadow instead of a soft blob.
   */
  focusOn(center, radius) {
    this.focus.center.copy(center);
    this.focus.radius = radius;
    this.sun.target.position.copy(center);
    this.configureShadow();
    this.updateSun();
  }

  /** Big, tight shadow map so the spiral shadow band stays sharp (hero shot). */
  configureShadow() {
    const r = this.focus.radius;
    const cam = this.sun.shadow.camera;
    this.sun.shadow.mapSize.set(4096, 4096); // high res -> crisp edges
    cam.left = -r * 1.15; // frustum only just larger than the tower...
    cam.right = r * 1.15; // ...so every shadow texel is spent on the minaret
    cam.top = r * 1.15;
    cam.bottom = -r * 1.15;
    cam.near = 1;
    cam.far = this.params.sunDistance + r * 2;
    this.sun.shadow.bias = -0.0004; // kill shadow acne on the curved tower
    this.sun.shadow.normalBias = 0.4;
    cam.updateProjectionMatrix();
  }

  /**
   * Recompute the sun from the current time, then colour the sky and the lights
   * from the SAME atmosphere sample.
   */
  updateSun() {
    const p = this.params;
    const dir = sunDirectionFromTime(p.timeOfDay, p.latitude, p.declination);
    this.sunDir = dir;

    // Sky uses the direction directly.
    this.sky.setSunDirection(dir);
    this.sky.syncUniforms(p);

    // Sample the atmosphere in the sun's direction -> its (reddened) colour.
    const sunRGB = atmosphere([dir.x, dir.y, dir.z], [dir.x, dir.y, dir.z], p);
    const sunColor = normalizedColor(sunRGB);
    // Sample straight up -> the cool sky-bounce colour.
    const zenithRGB = atmosphere([0, 1, 0], [dir.x, dir.y, dir.z], p);
    const skyColor = normalizedColor(zenithRGB);

    // How high is the sun? Fade the direct light out as it dips below horizon.
    const elevationFactor = THREE.MathUtils.smoothstep(dir.y, -0.05, 0.15);

    // 1. Direct sun: warm colour, brightness scaled by elevation.
    this.sun.color.copy(sunColor);
    this.sun.intensity = p.sunIntensityScale * elevationFactor;
    this.sun.position.copy(dir).multiplyScalar(p.sunDistance).add(this.focus.center);

    // 2. Sky bounce: hemisphere TOP colour = the sky we just sampled.
    this.sky.setSunDiscColor(sunColor);
    this.hemi.color.copy(skyColor);
    // 3. Ground bounce: hemisphere BOTTOM stays ochre but tracks daylight.
    this.hemi.groundColor.set(p.groundColor).multiplyScalar(0.6 + 0.4 * elevationFactor);
    this.hemi.intensity = p.hemiIntensity;
  }

  /** Called every frame — only the sky needs per-frame work (follow camera). */
  update(camera) {
    this.sky.update(camera);
  }

  buildGUI(gui) {
    const f = gui.addFolder('Environment');
    const onSun = () => this.updateSun();
    f.add(this.params, 'timeOfDay', 0, 24, 0.1).name('time of day (h)').onChange(onSun);
    f.add(this.params, 'latitude', -60, 60, 0.1).onChange(onSun);
    f.add(this.params, 'declination', -23.4, 23.4, 0.1).name('season (declination)').onChange(onSun);
    f.add(this.params, 'sunIntensityScale', 0, 6, 0.1).name('sun intensity').onChange(onSun);
    f.add(this.params, 'hemiIntensity', 0, 3, 0.05).name('bounce intensity').onChange(onSun);
    f.addColor(this.params, 'groundColor').name('ground bounce').onChange(onSun);

    const sky = f.addFolder('Sky');
    sky.add(this.params, 'rayleigh', 0, 4, 0.05).onChange(onSun);
    sky.add(this.params, 'mie', 0, 4, 0.05).onChange(onSun);
    sky.add(this.params, 'mieG', 0, 0.99, 0.01).name('mie glow').onChange(onSun);
    sky.add(this.params, 'sunIntensity', 5, 40, 0.5).name('sun radiance').onChange(onSun);
  }
}

/**
 * Turn a raw HDR radiance into a light COLOUR: keep the hue (which carries the
 * physical reddening), drop the absolute brightness (the GUI controls that).
 */
function normalizedColor(rgb) {
  const m = Math.max(rgb[0], rgb[1], rgb[2], 1e-4);
  return new THREE.Color(rgb[0] / m, rgb[1] / m, rgb[2] / m);
}
