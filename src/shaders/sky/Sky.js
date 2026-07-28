import * as THREE from 'three';
import vertexShader from './sky.vert.glsl?raw';
import fragmentShader from './sky.frag.glsl?raw';

/**
 * The sky dome: a unit sphere seen from the inside (BackSide), kept centred on
 * the camera so we only ever look at DIRECTIONS, never distance. It writes no
 * depth and ignores the depth test (renderOrder -1), so it is always the
 * backdrop — no need to size it against the camera's far plane.
 */
export default class Sky {
  /** @param {object} a - atmosphere params (shared with atmosphere.js). */
  constructor(a) {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0, 0.1, -1) },
        uSunIntensity: { value: a.sunIntensity },
        uRayleighCoeff: { value: new THREE.Vector3(...a.rayleighCoeff) },
        uMieCoeff: { value: a.mieCoeff },
        uRayleigh: { value: a.rayleigh },
        uMie: { value: a.mie },
        uMieG: { value: a.mieG },
        uPlanetRadius: { value: a.planetRadius },
        uAtmosphereRadius: { value: a.atmosphereRadius },
        uRayleighScaleH: { value: a.rayleighScaleH },
        uMieScaleH: { value: a.mieScaleH },
        uSunDiscColor: { value: new THREE.Color(1, 1, 1) },
        uSunAngularRadius: { value: 0.045 }, // a touch bigger than reality, to read
        uSunDiscIntensity: { value: 18.0 },
        uLimbDarkening: { value: 0.6 },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
    this.mesh.renderOrder = -1; // draw first, behind everything
    this.mesh.frustumCulled = false; // it wraps the camera; never cull it
    this.mesh.name = 'sky';
  }

  setSunDirection(v) {
    this.material.uniforms.uSunDirection.value.copy(v);
  }

  setSunDiscColor(c) {
    this.material.uniforms.uSunDiscColor.value.copy(c);
  }

  /** Push the current GUI multipliers into the shader. */
  syncUniforms(a) {
    const u = this.material.uniforms;
    u.uRayleigh.value = a.rayleigh;
    u.uMie.value = a.mie;
    u.uMieG.value = a.mieG;
    u.uSunIntensity.value = a.sunIntensity;
  }

  /** Keep the dome centred on the camera every frame. */
  update(camera) {
    this.mesh.position.copy(camera.position);
  }
}
