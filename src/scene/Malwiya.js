import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createMudBrickMaterial } from '../shaders/mud/MudBrickMaterial.js';

/**
 * Malwiya — the Great Mosque minaret of Samarra, rebuilt from the reference
 * photographs (docs/reference/).
 *
 * The photos settle the form: the core is a SMOOTH CONE, and the terraced
 * silhouette comes entirely from a helical ramp whose outer ledge protrudes
 * from that cone. It is NOT a stack of cylindrical drums.
 *
 * So we build RAMP-FIRST:
 *   1. A helix down the cone: outer radius shrinks with height, 5 CCW turns.
 *   2. The RAMP is the walkable annulus between inner and outer radius along
 *      that helix — a real slab with thickness and an OPEN outer edge (no
 *      parapet). One single mesh.
 *   3. The CORE is a solid of revolution whose radius at every height equals
 *      the ramp's INNER edge there. Because the ramp protrudes ~one ramp-width
 *      beyond that, its spiralling ledge is what carves the terraces — the
 *      steps are never modelled separately; they emerge.
 *
 * Dimensions are read from the photos and anchored to the ~52 m total height.
 */
export default class Malwiya extends THREE.Group {
  constructor(overrides = {}, gui = null) {
    super();
    this.name = 'Malwiya';

    // ---- Photo-derived dimensions (see docs/reference, STEP 1 report) -------
    this.params = Object.assign(
      {
        // Base platform — a low square plinth, slightly WIDER than the tower base.
        baseSize: 34, // m, square side (~1.5:1 vs the 52 m height)
        baseHeight: 3, // m
        baseChamfer: 0.3, // m

        // Conical core envelope (outer radius = the ramp's outer edge). The base
        // is only a little narrower than the plinth (small walkway margin).
        towerHeight: 44, // m (3 base + 44 cone + ~5 summit ≈ 52 total)
        outerRadiusBottom: 15, // m — tower base Ø30 under the 34 m plinth
        outerRadiusTop: 5, // m — at the foot of the summit
        coreRadialSegments: 64, // faces around the cone
        courseHeight: 0.7, // m per brick course -> vertical resolution

        // Helical ramp
        rampTurns: 5, // full counter-clockwise revolutions
        rampWidth: 2.4, // m — near-constant with height (per the photos)
        rampThickness: 1.1, // m, chunky slab so the ledge reads solid, not a fin
        segmentsPerTurn: 120, // sweep resolution
        handedness: -1, // -1 = counter-clockwise ascent
        edgeChamfer: 0.06, // m, small (fired brick has hard edges)

        // Summit — cylinder + smaller top drum (blind niches are a future pass)
        chamberRadius: 4.5, // m, matches the cone top
        chamberHeight: 4.2, // m (~ as tall as it is wide)
        topDrumRadius: 2.3, // m
        topDrumHeight: 2.4, // m
        chamberSegments: 40,

        // Erosion (MESO) — fired brick barely slumps, edges stay hard.
        courseRelief: 0.05,
        slumpAmount: 0.1,
        missingBrickChance: 0.015,
        brickDepth: 0.15,
        aoStrength: 0.4,
        aoContactRange: 8,

        // Surface — warm fired-brick palette (buff/tan, NOT grey).
        weathering: 0.35,
        brickTexW: 0.5,
        brickTexH: 0.2,
        mortarWidth: 0.09,
        cavityDark: 0.45,
        edgeWear: 0.3,
        grainScale: 6.0,
        polish: 0.5,
        brickColorA: '#a8875c', // warm tan
        brickColorB: '#cbb187', // pale honey buff
        mortarColor: '#c2ad84', // tan mortar
        dustColor: '#dccaa4', // pale warm dust
        brickRough: 0.82,
        mortarRough: 0.95,

        // Material-pass tiling hooks
        brickLength: 0.4,
        brickHeightTex: 0.28,

        seed: 1337,
      },
      overrides
    );

    this.meshes = [];
    this.brickMaterials = [];
    this.stats = { triangles: 0, vertices: 0, drawCalls: 0 };

    this.build();
    if (gui) this.buildGUI(gui);
  }

  // ------------------------------------------------------------------------
  //  Helix / envelope — the single source of truth for the whole form
  // ------------------------------------------------------------------------

  /** Climb progress t in [0,1] -> world height. */
  yAt(t) {
    return this.params.baseHeight + t * this.params.towerHeight;
  }
  /** Outer radius of the cone (= ramp outer edge) at progress t. */
  outerRadiusAt(t) {
    const p = this.params;
    return THREE.MathUtils.lerp(p.outerRadiusBottom, p.outerRadiusTop, t);
  }
  /** Inner radius = ramp inner edge = the core surface radius at that height. */
  innerRadiusAt(t) {
    return this.outerRadiusAt(t) - this.params.rampWidth;
  }

  // ------------------------------------------------------------------------
  //  Build orchestration
  // ------------------------------------------------------------------------

  build() {
    this.meshes = [];
    this.brickMaterials = [];
    this.buildBase();
    this.buildCore(); // smooth cone (solid of revolution)
    this.buildRamp(); // the ONE helical ramp
    this.buildSummit();
    this.computeStats();
    this.logStats();
    this.logSceneGraph();
  }

  rebuild() {
    for (const m of this.meshes) {
      this.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.meshes.length = 0;
    this.build();
  }

  addPart(mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------------
  //  BASE — low square plinth, chamfered
  // ------------------------------------------------------------------------

  buildBase() {
    const p = this.params;
    const geo = new RoundedBoxGeometry(p.baseSize, p.baseHeight, p.baseSize, 2, p.baseChamfer);
    const mat = createMudBrickMaterial(p, false);
    this.brickMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = p.baseHeight / 2;
    mesh.name = 'base';
    this.addPart(mesh);
  }

  // ------------------------------------------------------------------------
  //  CORE — smooth cone; radius(h) = inner edge of the ramp at that height
  // ------------------------------------------------------------------------

  buildCore() {
    const p = this.params;
    const R = p.coreRadialSegments;
    const gridW = R + 1;
    const H = Math.max(2, Math.round(p.towerHeight / p.courseHeight));
    const rng = mulberry32(p.seed);
    const bricksAround = Math.max(4, Math.round((2 * Math.PI * p.outerRadiusBottom) / p.brickLength));

    const missing = new Set();
    const count = Math.round(R * H * p.missingBrickChance);
    for (let m = 0; m < count; m++) {
      const jj = 1 + Math.floor(rng() * (H - 2));
      const ss = Math.floor(rng() * R);
      missing.add(jj * gridW + ss);
    }

    const pos = [];
    const uv = [];
    const uv1 = [];
    const idx = [];

    for (let j = 0; j <= H; j++) {
      const t = j / H;
      const y = this.yAt(t);
      const course = (j % 2 === 0 ? 1 : -1) * p.courseRelief;
      const slump = p.slumpAmount * Math.pow(1 - t, 3); // tiny, base only
      const rimTuck = j === 0 || j === H ? p.edgeChamfer : 0;

      for (let s = 0; s <= R; s++) {
        const a = (s / R) * Math.PI * 2;
        let radius = this.innerRadiusAt(t) + course + slump - rimTuck;
        if (missing.has(j * gridW + s)) radius -= p.brickDepth;
        pos.push(radius * Math.cos(a), y, radius * Math.sin(a));
        uv.push((s / R) * bricksAround, y / p.brickHeightTex);
        uv1.push(s / R, t);
      }
    }
    for (let j = 0; j < H; j++) {
      for (let s = 0; s < R; s++) {
        const tl = j * gridW + s;
        idx.push(tl, tl + gridW, tl + 1, tl + 1, tl + gridW, tl + gridW + 1);
      }
    }

    // Top cap disc so we never see into the cone (the summit sits over it).
    const capStart = pos.length / 3;
    const yTop = this.yAt(1);
    const rTop = this.innerRadiusAt(1);
    pos.push(0, yTop, 0);
    uv.push(0, 0);
    uv1.push(0.5, 1);
    for (let s = 0; s <= R; s++) {
      const a = (s / R) * Math.PI * 2;
      pos.push(rTop * Math.cos(a), yTop, rTop * Math.sin(a));
      uv.push((s / R) * bricksAround, yTop / p.brickHeightTex);
      uv1.push(s / R, 1);
    }
    for (let s = 0; s < R; s++) idx.push(capStart, capStart + 1 + s + 1, capStart + 1 + s);

    const geo = this.makeGeometry(pos, uv, uv1, idx);
    this.bakeAO(geo);
    const mat = createMudBrickMaterial(p, true);
    this.brickMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'core';
    this.addPart(mesh);
  }

  // ------------------------------------------------------------------------
  //  RAMP — one mesh: a slab swept along the helix, open outer edge, no parapet
  // ------------------------------------------------------------------------

  buildRamp() {
    const p = this.params;
    const w = p.rampWidth;
    const th = p.rampThickness;

    // Cross-section in (u = radial offset from inner edge 0..w, v = vertical).
    // Plain slab — the open outer edge (u = w, v = 0) is the defining feature.
    const corners = [
      [0, -th], // inner bottom (buried in the core)
      [0, 0], // inner top (sits on the core surface)
      [w, 0], // outer top — the open edge
      [w, -th], // outer bottom (soffit edge)
    ];
    const prof = chamferProfile(corners, p.edgeChamfer);
    const P = prof.length;

    const vCoord = [0];
    let perim = 0;
    for (let i = 1; i < P; i++) {
      perim += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]);
      vCoord.push(perim);
    }
    const perTotal = perim + Math.hypot(prof[0][0] - prof[P - 1][0], prof[0][1] - prof[P - 1][1]);

    const M = Math.max(2, Math.round(p.rampTurns * p.segmentsPerTurn));
    const rng = mulberry32(p.seed ^ 0x9e37);

    const pos = [];
    const uv = [];
    const uv1 = [];
    const idx = [];
    let cumLen = 0;
    let px = 0, py = 0, pz = 0;

    for (let k = 0; k <= M; k++) {
      const t = k / M;
      const theta = p.handedness * 2 * Math.PI * p.rampTurns * t;
      const innerR = this.innerRadiusAt(t);
      const y = this.yAt(t);

      const cRad = innerR + w * 0.5; // centreline, for arc-length UVs
      const cx = cRad * Math.cos(theta);
      const cz = cRad * Math.sin(theta);
      if (k > 0) cumLen += Math.hypot(cx - px, y - py, cz - pz);
      px = cx; py = y; pz = cz;

      const stepMissing = rng() < p.missingBrickChance;
      for (let i = 0; i < P; i++) {
        let u = prof[i][0];
        const v = prof[i][1];
        if (u > w * 0.5) {
          u += (rng() - 0.5) * p.courseRelief; // weather the exposed outer half
          if (stepMissing) u -= p.brickDepth;
        }
        const radius = innerR + u;
        pos.push(radius * Math.cos(theta), y + v, radius * Math.sin(theta));
        uv.push(cumLen / p.brickLength, vCoord[i] / p.brickHeightTex);
        uv1.push(t, vCoord[i] / perTotal);
      }
    }
    for (let k = 0; k < M; k++) {
      for (let i = 0; i < P; i++) {
        const iN = (i + 1) % P;
        const tl = k * P + i;
        const tr = k * P + iN;
        const bl = (k + 1) * P + i;
        const br = (k + 1) * P + iN;
        idx.push(tl, bl, tr, tr, bl, br);
      }
    }

    const geo = this.makeGeometry(pos, uv, uv1, idx);
    ensureOutward(geo);
    this.bakeAO(geo);
    const mat = createMudBrickMaterial(p, true);
    this.brickMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'ramp';
    this.addPart(mesh);
  }

  // ------------------------------------------------------------------------
  //  SUMMIT — main drum + a smaller top drum (lathed, rounded rims)
  // ------------------------------------------------------------------------

  buildSummit() {
    const p = this.params;
    const cR = p.chamberRadius;
    const cH = p.chamberHeight;
    const tR = p.topDrumRadius;
    const tH = p.topDrumHeight;
    const c = p.edgeChamfer * 2;

    const profile = [
      new THREE.Vector2(0.001, 0),
      new THREE.Vector2(cR - c, 0),
      new THREE.Vector2(cR, c),
      new THREE.Vector2(cR, cH - c),
      new THREE.Vector2(cR - c, cH), // top rim of the main drum
      new THREE.Vector2(tR, cH), // step in to the smaller top drum
      new THREE.Vector2(tR, cH + tH - c),
      new THREE.Vector2(tR - c, cH + tH),
      new THREE.Vector2(0.001, cH + tH), // flat cap (open well simplified)
    ];
    const geo = new THREE.LatheGeometry(profile, p.chamberSegments);
    geo.setAttribute('uv1', new THREE.BufferAttribute(geo.attributes.uv.array.slice(), 2));

    const mat = createMudBrickMaterial(p, false);
    this.brickMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = this.yAt(1);
    mesh.name = 'summit';
    this.addPart(mesh);
  }

  // ------------------------------------------------------------------------
  //  Geometry + AO + stats plumbing
  // ------------------------------------------------------------------------

  makeGeometry(pos, uv, uv1, idx) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** Bake contact/underside AO into a vertex-colour attribute. */
  bakeAO(geo) {
    const p = this.params;
    const posAttr = geo.attributes.position;
    const nrmAttr = geo.attributes.normal;
    const n = posAttr.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = posAttr.getY(i);
      const ny = nrmAttr.getY(i);
      const contact = 1 - THREE.MathUtils.smoothstep(y - p.baseHeight, 0, p.aoContactRange);
      const under = Math.max(0, -ny);
      const ao = 1 - p.aoStrength * Math.min(1, Math.max(contact, under * 0.5));
      colors[i * 3] = ao;
      colors[i * 3 + 1] = ao;
      colors[i * 3 + 2] = ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  computeStats() {
    let tris = 0;
    let verts = 0;
    for (const m of this.meshes) {
      const g = m.geometry;
      verts += g.attributes.position.count;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
    this.stats = { triangles: tris, vertices: verts, drawCalls: this.meshes.length };
  }

  logStats() {
    const s = this.stats;
    console.log(
      `[Malwiya] triangles: ${s.triangles.toLocaleString()} | vertices: ${s.vertices.toLocaleString()} | draw calls: ${s.drawCalls} | budget: <60,000 tris, <50 calls`
    );
  }

  /** Dump every mesh under the minaret node and assert exactly one ramp. */
  logSceneGraph() {
    let rampCount = 0;
    const lines = [];
    this.traverse((o) => {
      if (o.isMesh) {
        const g = o.geometry;
        const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
        lines.push(`  - ${o.name || '(unnamed)'}: ${tris.toLocaleString()} tris`);
        if (o.name === 'ramp') rampCount++;
      }
    });
    console.log(`[Malwiya] scene graph under "${this.name}":\n${lines.join('\n')}`);
    console.log(`[Malwiya] ramp meshes: ${rampCount} (expected exactly 1)`);
  }

  // ------------------------------------------------------------------------
  //  GUI
  // ------------------------------------------------------------------------

  buildGUI(gui) {
    const f = gui.addFolder('Malwiya');
    const rebuild = () => this.rebuild();

    const base = f.addFolder('Base');
    base.add(this.params, 'baseSize', 20, 44, 0.5).onFinishChange(rebuild);
    base.add(this.params, 'baseHeight', 1, 8, 0.1).onFinishChange(rebuild);

    const tower = f.addFolder('Tower');
    tower.add(this.params, 'towerHeight', 25, 60, 1).onFinishChange(rebuild);
    tower.add(this.params, 'outerRadiusBottom', 6, 18, 0.5).name('base radius').onFinishChange(rebuild);
    tower.add(this.params, 'outerRadiusTop', 2, 9, 0.25).name('top radius').onFinishChange(rebuild);
    tower.add(this.params, 'coreRadialSegments', 16, 96, 1).onFinishChange(rebuild);
    tower.add(this.params, 'courseHeight', 0.3, 2, 0.05).onFinishChange(rebuild);

    const ramp = f.addFolder('Ramp');
    ramp.add(this.params, 'rampTurns', 1, 8, 1).onFinishChange(rebuild);
    ramp.add(this.params, 'rampWidth', 1, 5, 0.1).onFinishChange(rebuild);
    ramp.add(this.params, 'rampThickness', 0.3, 1.5, 0.05).onFinishChange(rebuild);
    ramp.add(this.params, 'segmentsPerTurn', 24, 200, 1).onFinishChange(rebuild);
    ramp.add(this.params, 'handedness', { CCW: -1, CW: 1 }).onFinishChange(rebuild);

    const summit = f.addFolder('Summit');
    summit.add(this.params, 'chamberRadius', 2, 7, 0.1).onFinishChange(rebuild);
    summit.add(this.params, 'chamberHeight', 2, 8, 0.2).onFinishChange(rebuild);
    summit.add(this.params, 'topDrumRadius', 1, 5, 0.1).onFinishChange(rebuild);
    summit.add(this.params, 'topDrumHeight', 1, 5, 0.2).onFinishChange(rebuild);

    const erosion = f.addFolder('Erosion');
    erosion.add(this.params, 'courseRelief', 0, 0.3, 0.01).onFinishChange(rebuild);
    erosion.add(this.params, 'slumpAmount', 0, 1, 0.05).onFinishChange(rebuild);
    erosion.add(this.params, 'missingBrickChance', 0, 0.2, 0.005).onFinishChange(rebuild);
    erosion.add(this.params, 'aoStrength', 0, 1, 0.05).name('AO strength').onFinishChange(rebuild);
    erosion.add(this.params, 'seed', 0, 9999, 1).onFinishChange(rebuild);

    const surf = f.addFolder('Surface');
    const live = (uni) => (v) => {
      for (const m of this.brickMaterials) m.userData.mudUniforms[uni].value = v;
    };
    surf.add(this.params, 'weathering', 0, 1, 0.02).onChange(live('uWeathering'));
    surf.add(this.params, 'cavityDark', 0, 1, 0.02).name('cavity dirt').onChange(live('uCavityDark'));
    surf.add(this.params, 'edgeWear', 0, 1, 0.02).name('edge wear').onChange(live('uEdgeWear'));
    surf.add(this.params, 'polish', 0, 1, 0.02).name('foot polish').onChange(live('uPolish'));
    surf.add(this.params, 'brickTexW', 0.2, 1.5, 0.05).name('brick width').onFinishChange(rebuild);
    surf.add(this.params, 'brickTexH', 0.1, 0.6, 0.02).name('course height').onFinishChange(rebuild);
  }
}

// --------------------------------------------------------------------------
//  Pure helpers
// --------------------------------------------------------------------------

/** Seeded PRNG so erosion is identical every rebuild for a given seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round every corner of a closed 2D profile into a small chamfer. */
function chamferProfile(pts, c) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const dp = [prev[0] - p[0], prev[1] - p[1]];
    const dn = [next[0] - p[0], next[1] - p[1]];
    const lp = Math.hypot(dp[0], dp[1]) || 1;
    const ln = Math.hypot(dn[0], dn[1]) || 1;
    const cp = Math.min(c, lp * 0.45);
    const cn = Math.min(c, ln * 0.45);
    out.push([p[0] + (dp[0] / lp) * cp, p[1] + (dp[1] / lp) * cp]);
    out.push([p[0] + (dn[0] / ln) * cn, p[1] + (dn[1] / ln) * cn]);
  }
  return out;
}

/** Flip index winding if a swept tube came out inside-out. */
function ensureOutward(geo) {
  const posArr = geo.attributes.position.array;
  const nrmArr = geo.attributes.normal.array;
  let far = -1;
  let farIdx = 0;
  for (let i = 0; i < posArr.length; i += 3) {
    const r = posArr[i] * posArr[i] + posArr[i + 2] * posArr[i + 2];
    if (r > far) { far = r; farIdx = i; }
  }
  const dot = posArr[farIdx] * nrmArr[farIdx] + posArr[farIdx + 2] * nrmArr[farIdx + 2];
  if (dot < 0) {
    const idx = geo.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const tmp = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = tmp;
    }
    geo.index.needsUpdate = true;
    geo.computeVertexNormals();
  }
}
