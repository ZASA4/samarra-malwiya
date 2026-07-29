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
      timeOfDay: 17.3, // h, hero golden hour — sun ~8.7 deg elevation (5-12 window)
      latitude: 34.2, // deg N — Samarra, Iraq
      declination: 0, // deg — equinox-ish; +/- shifts the seasonal arc
      sunIntensityScale: 2.6, // DirectionalLight brightness
      hemiIntensity: 0.9, // sky + ground bounce strength
      groundColor: '#b07a3c', // warm ochre sand for the ground bounce
      // Split-tone: the sky-bounce FILL is pushed to a desaturated slate blue so
      // shadows read cool while the direct sun stays warm amber (see updateSun).
      fillColor: '#6c829d',
      sunDistance: 200, // where we park the light for shadow framing
      shadowThrowCap: 260, // m, how far down-sun we still render the cast shadow

      // Sky contrast (multipliers on the physical model, shared with the lights):
      rayleigh: 1.9, // deeper blue-indigo overhead
      mie: 1.7, // denser warm dust glow hugging the horizon near the sun
      mieG: 0.8, // tighter forward glow around the sun disc
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
    // The shadow frustum is aimed here — recomputed each updateSun() so it hugs
    // the minaret AND the direction its long shadow is thrown.
    this.shadow = { center: this.focus.center.clone(), radius: this.focus.radius };
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

  /**
   * Big, tight shadow map for the hero shot. The frustum is sized and CENTRED
   * (see updateSun) to hug the minaret and the reach of its long cast shadow, so
   * texels aren't wasted on empty desert. PCF-soft + these biases kill both the
   * stair-stepping and the light-leak you get from a low, grazing sun.
   */
  configureShadow() {
    const r = this.shadow.radius;
    const cam = this.sun.shadow.camera;
    this.sun.shadow.mapSize.set(4096, 4096); // high res -> crisp edges
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = this.params.sunDistance + r * 2 + this.focus.center.y;
    this.sun.shadow.bias = -0.0005; // kill shadow acne on the curved tower
    this.sun.shadow.normalBias = 0.6; // push samples off the surface -> no leaking
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

    // --- Shadow framing: tighten the frustum to the minaret AND its cast shadow.
    // A point of height h throws a shadow of length h/tan(elevation); we cover the
    // near-to-mid throw (capped) and OFFSET the frustum centre down-sun so texels
    // land on the shadow instead of empty sand on the far side.
    const horiz = Math.hypot(dir.x, dir.z) || 1e-4;
    const towerH = this.focus.center.y * 2; // sphere centre sits ~mid-height
    const reach = Math.min(this.params.shadowThrowCap, (towerH * horiz) / Math.max(dir.y, 1e-3));
    const off = reach * 0.5;
    this.shadow.center.set(
      this.focus.center.x - (dir.x / horiz) * off, // shadow points opposite the sun
      this.focus.center.y * 0.5,
      this.focus.center.z - (dir.z / horiz) * off
    );
    this.shadow.radius = off + this.focus.radius * 1.4; // base -> shadow tip, with margin
    this.configureShadow();

    // 1. Direct sun: warm colour, brightness scaled by elevation. The light and
    // its shadow camera are aimed at the offset centre — direction is unchanged
    // (position - target is still dir * distance), only the frustum shifts.
    this.sun.color.copy(sunColor);
    this.sun.intensity = p.sunIntensityScale * elevationFactor;
    this.sun.target.position.copy(this.shadow.center);
    this.sun.position.copy(dir).multiplyScalar(p.sunDistance).add(this.shadow.center);

    // 2. Sky bounce (split-tone): the hemisphere TOP fill is pushed to a
    // desaturated slate blue so shadowed/upward faces read COOL, while the direct
    // sun above stays warm amber. A touch of the real sky hue is kept.
    this.sky.setSunDiscColor(sunColor);
    this.hemi.color.set(p.fillColor).lerp(skyColor, 0.2);
    // 3. Ground bounce: hemisphere BOTTOM stays warm ochre but tracks daylight.
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
    f.addColor(this.params, 'fillColor').name('shadow fill (cool)').onChange(onSun);

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
