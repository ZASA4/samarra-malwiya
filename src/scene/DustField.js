import * as THREE from 'three';

/**
 * DustField — a low haze of wind-borne dust for the golden hour. A single
 * THREE.Points cloud (one BufferGeometry, one draw call) of soft additive
 * sprites that glow when they catch the low sun, drifting slowly sideways.
 *
 * Kept between y = 0 and y = 5 m so it hugs the ground like real desert dust.
 */
export default class DustField {
  /**
   * @param {object} [o]
   * @param {number} [o.count=800]   - particle count (600-1000).
   * @param {number} [o.area=90]     - half-width of the drift box (m), around origin.
   * @param {number} [o.yMax=5]      - dust ceiling (m).
   * @param {number} [o.size=3.4]    - world size of a sprite (m).
   * @param {string} [o.color='#d8b48a'] - warm dust tint.
   * @param {number} [o.opacity=0.25]
   * @param {number} [o.drift=1.6]   - horizontal drift speed (m/s).
   */
  constructor(o = {}) {
    this.count = o.count ?? 800;
    this.area = o.area ?? 90;
    this.yMax = o.yMax ?? 5;
    this.drift = o.drift ?? 1.6;

    // Positions (one flat Float32Array) + a per-particle sideways speed so the
    // cloud shears slightly instead of moving as a rigid block.
    const pos = new Float32Array(this.count * 3);
    this.speed = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * this.area; // x
      pos[i * 3 + 1] = Math.pow(Math.random(), 1.7) * this.yMax; // y — biased low
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * this.area; // z
      this.speed[i] = this.drift * (0.5 + Math.random()); // 0.5x .. 1.5x drift
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    const material = new THREE.PointsMaterial({
      size: o.size ?? 3.4,
      map: makeSoftSprite(),
      color: new THREE.Color(o.color ?? '#d8b48a'),
      transparent: true,
      opacity: o.opacity ?? 0.25,
      blending: THREE.AdditiveBlending, // glow when lit by the low sun
      depthWrite: false, // don't occlude the scene behind the haze
      sizeAttenuation: true, // nearer motes are bigger
    });

    this.points = new THREE.Points(geo, material);
    this.points.name = 'dust';
    this.points.frustumCulled = false; // it surrounds the camera; never cull it
  }

  /** Slow horizontal drift; wrap particles back when they leave the box. */
  update(delta) {
    const pos = this.points.geometry.attributes.position;
    const a = this.area;
    for (let i = 0; i < this.count; i++) {
      let x = pos.getX(i) + this.speed[i] * delta; // drift along +X (down-wind)
      if (x > a) x -= 2 * a; // wrap around to the far side
      pos.setX(i, x);
    }
    pos.needsUpdate = true;
  }
}

/** A 64x64 soft circular alpha sprite (radial gradient) as a CanvasTexture. */
function makeSoftSprite() {
  const s = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
