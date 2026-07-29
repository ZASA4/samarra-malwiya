import * as THREE from 'three';

/**
 * SummitPavilion — the small OPEN cylindrical pavilion that crowns the real
 * Malwiya (see docs/reference/samarra-05 and the aerial samarra-10): a short
 * drum ringed with vertical BLIND-ARCH NICHES, hollow, open at the top so you
 * can see the floor inside.
 *
 * The downloaded GLTF has no such feature — its summit was a solid capped drum
 * with a scan blob on top. We clip that blob and build this procedurally so the
 * crown matches the photographs.
 *
 * Construction (one merged BufferGeometry, one draw call):
 *   - OUTER wall: a surface of revolution whose radius is pulled inward inside
 *     each niche footprint; the footprint's top follows a semicircle -> a blind
 *     arch. Pilaster strips are left between niches.
 *   - INNER wall: a plain straight tube (radius = outer - wallThickness).
 *   - TOP RING: an annulus joining outer & inner tops (open — no cap).
 *   - BOTTOM: an annulus under the wall + a floor disc you see through the top.
 *
 * Contact AO is baked into vertex colours (recesses darker) to match the tower.
 *
 * @param {object} o
 * @param {number} o.baseY         - world Y the pavilion floor sits at (tower top).
 * @param {number} o.outerRadius   - outer radius of the drum (m).
 * @param {number} [o.wallThickness=0.5]
 * @param {number} [o.height=4.0]
 * @param {number} [o.nicheCount=12]
 * @param {number} [o.nicheDepth=0.3]
 * @param {number} [o.nicheWidthFrac=0.62] - fraction of each sector that recesses.
 * @param {number} [o.radialSegments=96]
 * @param {number} [o.heightSegments=32]
 * @param {THREE.Material} material - the shared mud-brick material (vertexColors).
 * @returns {THREE.Mesh}
 */
export function buildSummitPavilion(o, material) {
  const baseY = o.baseY;
  const Rout = o.outerRadius;
  const wall = o.wallThickness ?? 0.5;
  const Hgt = o.height ?? 4.0;
  const N = o.nicheCount ?? 12;
  const depth = o.nicheDepth ?? 0.3;
  const widthFrac = o.nicheWidthFrac ?? 0.62;
  const R = o.radialSegments ?? 96;
  const H = o.heightSegments ?? 32;
  const Rin = Math.max(0.3, Rout - wall);

  const pos = [];
  const col = [];
  const idx = [];
  const TAU = Math.PI * 2;
  const ss = THREE.MathUtils.smoothstep;

  // How deep the wall is recessed at (azimuth a, vertical fraction vv in 0..1).
  // Returns 0 on pilasters/frame, up to `depth` deep inside a blind arch.
  const sill = 0.14; // niche starts this far above the floor
  const topM = 0.1; // ...and stops this far below the cornice
  const archFrac = 0.42; // top 42% of the niche is the semicircular arch
  const band = 0.05; // soft edge width (for clean normals/AO)
  function recess(a, vv) {
    if (vv < sill || vv > 1 - topM) return 0;
    const seg = (a / TAU) * N;
    const frac = seg - Math.floor(seg); // 0..1 within one niche+pilaster sector
    const dcen = Math.abs(frac - 0.5) * 2; // 0 at niche centre -> 1 at sector edge
    const top = 1 - topM;
    const archStart = top - archFrac * (top - sill);
    let halfW = widthFrac; // niche occupies dcen < halfW
    if (vv > archStart) {
      const tt = (vv - archStart) / (top - archStart); // 0..1 up the arch
      halfW = widthFrac * Math.sqrt(Math.max(0, 1 - tt * tt)); // semicircle
    }
    // Smooth edges: fade the recess near the arch border and the sill/cornice.
    const horiz = 1 - ss(dcen, halfW - band, halfW);
    const vert = ss(vv, sill, sill + band) * (1 - ss(vv, top - band, top));
    return depth * horiz * vert;
  }

  const pushV = (x, y, z, ao) => {
    pos.push(x, y, z);
    col.push(ao, ao, ao);
    return pos.length / 3 - 1;
  };
  const ang = (i) => (i / R) * TAU;

  // --- OUTER wall (niched) : (H+1) rings x R columns, seam wraps via %R -------
  const outerBase = pos.length / 3;
  for (let j = 0; j <= H; j++) {
    const vv = j / H;
    const y = baseY + vv * Hgt;
    for (let i = 0; i < R; i++) {
      const a = ang(i);
      const rc = recess(a, vv);
      const rad = Rout - rc;
      const ao = 1 - 0.55 * (rc / depth); // recessed brick sits in shadow
      pushV(rad * Math.cos(a), y, rad * Math.sin(a), ao);
    }
  }
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < R; i++) {
      const i1 = (i + 1) % R;
      const a = outerBase + j * R + i;
      const b = outerBase + j * R + i1;
      const c = outerBase + (j + 1) * R + i;
      const d = outerBase + (j + 1) * R + i1;
      idx.push(a, c, b, b, c, d); // outward winding (material is DoubleSide anyway)
    }
  }

  // --- INNER wall (plain tube): just a base ring and a top ring --------------
  const innerBase = pos.length / 3;
  for (let i = 0; i < R; i++) {
    const a = ang(i);
    pushV(Rin * Math.cos(a), baseY, Rin * Math.sin(a), 0.7); // in shadow
  }
  const innerTop = pos.length / 3;
  for (let i = 0; i < R; i++) {
    const a = ang(i);
    pushV(Rin * Math.cos(a), baseY + Hgt, Rin * Math.sin(a), 0.85);
  }
  for (let i = 0; i < R; i++) {
    const i1 = (i + 1) % R;
    idx.push(innerBase + i, innerBase + i1, innerTop + i, innerTop + i1, innerTop + i, innerBase + i1);
  }

  // --- TOP RING annulus (open top: joins outer top to inner top) -------------
  const outerTop = outerBase + H * R; // first index of the outer top ring
  for (let i = 0; i < R; i++) {
    const i1 = (i + 1) % R;
    idx.push(outerTop + i, outerTop + i1, innerTop + i, innerTop + i1, innerTop + i, outerTop + i1);
  }

  // --- BOTTOM annulus (under the wall: outer base -> inner base) -------------
  for (let i = 0; i < R; i++) {
    const i1 = (i + 1) % R;
    idx.push(outerBase + i, innerBase + i, outerBase + i1, outerBase + i1, innerBase + i, innerBase + i1);
  }

  // --- FLOOR disc (the interior floor seen through the open top) -------------
  const centre = pushV(0, baseY, 0, 0.9);
  const floorRing = pos.length / 3;
  for (let i = 0; i < R; i++) {
    const a = ang(i);
    // fade AO from wall (darker) toward the centre (lighter)
    pushV(Rin * Math.cos(a), baseY, Rin * Math.sin(a), 0.78);
  }
  for (let i = 0; i < R; i++) {
    const i1 = (i + 1) % R;
    idx.push(centre, floorRing + i, floorRing + i1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'summit-pavilion';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
