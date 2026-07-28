import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createMudBrickMaterial } from '../shaders/mud/MudBrickMaterial.js';

/**
 * Malwiya — the procedural Great Mosque minaret of Samarra (848–852 CE).
 *
 * Nothing here is hand-modelled: every part is generated from the numbers in
 * `this.params`, so the whole tower re-derives itself when a GUI slider moves.
 *
 * Detail is built at three deliberate scales:
 *   MACRO — the tapering conical mass + the 5-turn helical ramp silhouette.
 *   MESO  — brick courses as real vertex displacement, plus erosion: rounded
 *           rims, base slumping (rain damage), and a few knocked-out bricks.
 *   MICRO — a SECOND UV set (attribute `uv1`) left on every mesh so a later
 *           material pass can add grain/pitting without touching geometry.
 *
 * Hard rule honoured: no perfectly sharp edges. Chamfers everywhere.
 */
export default class Malwiya extends THREE.Group {
  /**
   * @param {object} overrides - partial params to override the defaults.
   * @param {GUI}   [gui]      - optional lil-gui instance; if given, every
   *                             dimension gets a slider that rebuilds on change.
   */
  constructor(overrides = {}, gui = null) {
    super();
    this.name = 'Malwiya';

    // ---- Every tunable dimension lives here (no magic numbers elsewhere) ----
    this.params = Object.assign(
      {
        // Base platform (square)
        baseSize: 33, // m, side length
        baseHeight: 3, // m, thickness
        baseChamfer: 0.35, // m, rounded edge radius

        // Conical tower
        towerHeight: 52, // m
        radiusBottom: 16, // m
        radiusTop: 3, // m
        towerRadialSegments: 48, // faces around
        courseHeight: 0.65, // m per brick course -> drives vertical resolution

        // Helical ramp
        rampTurns: 5,
        rampWidth: 2.3, // m
        rampThickness: 0.5, // m, slab depth
        parapetHeight: 0.9, // m, outer wall above the walking surface
        parapetThickness: 0.35, // m
        segmentsPerTurn: 100, // sweep resolution
        handedness: -1, // -1 = counter-clockwise viewed from above
        edgeChamfer: 0.12, // m, corner rounding on the ramp cross-section

        // Summit chamber
        chamberRadius: 3.2, // m
        chamberHeight: 5, // m
        chamberSegments: 24,

        // Erosion (MESO)
        courseRelief: 0.06, // m, how far course displacement pushes
        slumpAmount: 0.6, // m, outward bulge at the very base
        missingBrickChance: 0.02, // 0..1 probability per candidate cell
        brickDepth: 0.18, // m, how deep a missing brick recesses

        // Baked ambient occlusion (MESO) — darkens contact areas so the base
        // and undersides read as "grounded" without a screen-space AO pass.
        aoStrength: 0.4, // 0..1, max darkening
        aoContactRange: 8, // m, how far up from the ground the darkening fades

        // Surface — procedural mud-brick material (see MudBrickMaterial.js)
        weathering: 0.4, // 0..1, dust build-up on upward faces
        brickTexW: 0.5, // m, brick width in the texture pattern
        brickTexH: 0.22, // m, course height in the texture pattern
        mortarWidth: 0.09, // fraction of a brick taken by mortar
        cavityDark: 0.5, // dirt darkening in the mortar lines
        edgeWear: 0.5, // brightening/smoothing of worn brick edges
        grainScale: 6.0, // frequency of the fine grain noise
        polish: 0.5, // roughness multiplier on trodden (up-facing) surfaces
        brickColorA: '#6f5230', // darker mud brick
        brickColorB: '#a07f52', // lighter mud brick
        mortarColor: '#b6a179', // pale mortar
        dustColor: '#cbb890', // wind-blown dust
        brickRough: 0.9,
        mortarRough: 1.0,

        // Material-pass tiling targets (used for UV scale, exposed for tuning)
        brickLength: 0.4, // m, one brick along its length
        brickHeightTex: 0.28, // m, one course tall

        seed: 1337, // deterministic erosion
      },
      overrides
    );

    // Meshes we own, so rebuild() can dispose + replace them cleanly.
    this.meshes = [];
    this.stats = { triangles: 0, vertices: 0, drawCalls: 0 };

    this.build();
    if (gui) this.buildGUI(gui);
  }

  // ------------------------------------------------------------------------
  //  Small math helpers
  // ------------------------------------------------------------------------

  /** Cone radius at climb-progress t (0 = base, 1 = top). */
  coneRadius(t) {
    const p = this.params;
    return THREE.MathUtils.lerp(p.radiusBottom, p.radiusTop, t);
  }

  // ------------------------------------------------------------------------
  //  Build orchestration
  // ------------------------------------------------------------------------

  build() {
    this.mudMaterials = []; // refreshed each (re)build; filled by the part builders
    this.buildBase();
    this.buildTower();
    this.buildRamp();
    this.buildSummit();
    this.computeStats();
    this.logStats();
  }

  /** Dispose every mesh and rebuild from current params (GUI onChange). */
  rebuild() {
    for (const m of this.meshes) {
      this.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.meshes.length = 0;
    this.build();
  }

  /** Adds a finished mesh to the group and tracks it. */
  addPart(mesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------------
  //  BASE — chamfered square platform (RoundedBox = no sharp edges for free)
  // ------------------------------------------------------------------------

  buildBase() {
    const p = this.params;
    const geo = new RoundedBoxGeometry(
      p.baseSize,
      p.baseHeight,
      p.baseSize,
      2, // segments per chamfer (keeps triangle count tiny)
      p.baseChamfer
    );
    const mat = createMudBrickMaterial(p, false);
    this.mudMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = p.baseHeight / 2; // sit its base on the ground (y=0)
    mesh.name = 'base';
    this.addPart(mesh);
  }

  // ------------------------------------------------------------------------
  //  TOWER — manual grid so we control every vertex (courses, slump, pitting)
  // ------------------------------------------------------------------------

  buildTower() {
    const p = this.params;
    const baseTop = p.baseHeight;
    const R = p.towerRadialSegments; // faces around
    const H = Math.max(2, Math.round(p.towerHeight / p.courseHeight)); // rings up
    const gridW = R + 1; // +1 duplicated seam vertex so UVs don't wrap-tear
    const rng = mulberry32(p.seed);

    // Pre-pick which (ring,segment) cells lose a brick — deterministic.
    const missing = new Set();
    const candidates = R * H;
    const count = Math.round(candidates * p.missingBrickChance);
    for (let i = 0; i < count; i++) {
      const j = 1 + Math.floor(rng() * (H - 2)); // never the very top/bottom rim
      const s = Math.floor(rng() * R);
      missing.add(j * gridW + s);
    }

    const pos = [];
    const uv = []; // channel 0 — per-brick tiling
    const uv1 = []; // channel 1 — MICRO hook, whole-surface 0..1
    const idx = [];

    const bricksAround = Math.max(4, Math.round((2 * Math.PI * p.radiusBottom) / p.brickLength));

    for (let j = 0; j <= H; j++) {
      const t = j / H;
      const y = baseTop + t * p.towerHeight;

      // MESO course banding: alternate courses sit a hair prouder.
      const course = (j % 2 === 0 ? 1 : -1) * p.courseRelief;
      // MESO slump: mud bulges outward near the base (rain pools there).
      const slump = p.slumpAmount * Math.pow(1 - t, 3);
      // Chamfer the exposed top & bottom rims by tucking them inward.
      const rimTuck = j === 0 || j === H ? p.edgeChamfer : 0;

      for (let s = 0; s <= R; s++) {
        const a = (s / R) * Math.PI * 2;
        let radius = this.coneRadius(t) + course + slump - rimTuck;

        // Knock this vertex inward if it belongs to a missing-brick cell.
        if (missing.has(j * gridW + s)) radius -= p.brickDepth;

        pos.push(radius * Math.cos(a), y, radius * Math.sin(a));
        uv.push((s / R) * bricksAround, (p.towerHeight * t) / p.brickHeightTex);
        uv1.push(s / R, t);
      }
    }

    // Stitch quads. Winding (tl,bl,tr / tr,bl,br) faces outward (verified by
    // right-hand rule: local up × local tangent points along +radius).
    for (let j = 0; j < H; j++) {
      for (let s = 0; s < R; s++) {
        const tl = j * gridW + s;
        const tr = tl + 1;
        const bl = tl + gridW;
        const br = bl + 1;
        idx.push(tl, bl, tr, tr, bl, br);
      }
    }

    const geo = this.makeGeometry(pos, uv, uv1, idx);
    this.bakeAO(geo); // contact/underside darkening baked into vertex colours
    const mat = createMudBrickMaterial(this.params, true);
    this.mudMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'tower';
    this.addPart(mesh);
  }

  // ------------------------------------------------------------------------
  //  RAMP — sweep a chamfered rectangular profile along the helix by hand
  // ------------------------------------------------------------------------

  buildRamp() {
    const p = this.params;
    const baseTop = p.baseHeight;
    const halfW = p.rampWidth / 2;
    const th = p.rampThickness;
    const pw = p.parapetThickness;
    const ph = p.parapetHeight;

    // Cross-section corners in local (u = radial offset, v = vertical).
    // Walking surface is v=0; slab hangs to v=-th; parapet rises to v=+ph.
    const corners = [
      [-halfW, -th], // inner bottom
      [-halfW, 0], // inner top (walk surface begins, against the cone)
      [halfW - pw, 0], // walk surface out to parapet foot
      [halfW - pw, ph], // up the inner face of the parapet
      [halfW, ph], // over the parapet top
      [halfW, -th], // down the outer face
    ];
    const prof = chamferProfile(corners, p.edgeChamfer); // -> ~12 rounded pts
    const P = prof.length;

    // V coordinate = distance travelled around the profile / brick height.
    const vCoord = [0];
    let perim = 0;
    for (let i = 1; i < P; i++) {
      perim += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]);
      vCoord.push(perim);
    }
    const perTotal = perim + Math.hypot(prof[0][0] - prof[P - 1][0], prof[0][1] - prof[P - 1][1]);

    const M = Math.max(2, Math.round(p.rampTurns * p.segmentsPerTurn)); // steps
    const rng = mulberry32(p.seed ^ 0x9e37); // different stream from the tower

    const pos = [];
    const uv = [];
    const uv1 = [];
    const idx = [];

    let cumLen = 0; // accumulated arc-length along the centreline -> UV.U
    let prevCx = 0, prevCy = 0, prevCz = 0;

    for (let k = 0; k <= M; k++) {
      const t = k / M;
      const theta = p.handedness * 2 * Math.PI * p.rampTurns * t;
      const cr = this.coneRadius(t);
      // Inner edge tucks 0.1m INTO the cone so the seam merges (no z-fight gap).
      const centerR = cr + halfW - 0.1;
      const yWalk = baseTop + t * p.towerHeight;

      // Centreline point, for arc-length UVs.
      const cx = centerR * Math.cos(theta);
      const cz = centerR * Math.sin(theta);
      const cy = yWalk;
      if (k > 0) cumLen += Math.hypot(cx - prevCx, cy - prevCy, cz - prevCz);
      prevCx = cx; prevCy = cy; prevCz = cz;

      // MESO erosion: this whole step may have lost its outer brick.
      const stepMissing = rng() < p.missingBrickChance;

      for (let i = 0; i < P; i++) {
        let u = prof[i][0];
        const v = prof[i][1];

        // Only weather the OUTER half (u>0). The inner half hides on the cone.
        if (u > 0) {
          u += (rng() - 0.5) * p.courseRelief; // gentle course jitter
          if (stepMissing) u -= p.brickDepth; // recess a knocked-out brick
        }

        const radius = centerR + u;
        pos.push(radius * Math.cos(theta), yWalk + v, radius * Math.sin(theta));
        uv.push(cumLen / p.brickLength, vCoord[i] / p.brickHeightTex);
        uv1.push(t, vCoord[i] / perTotal); // MICRO: normalised along + around
      }
    }

    // Stitch the closed profile tube: connect point i to (i+1)%P across steps.
    for (let k = 0; k < M; k++) {
      for (let i = 0; i < P; i++) {
        const iNext = (i + 1) % P;
        const tl = k * P + i;
        const tr = k * P + iNext;
        const bl = (k + 1) * P + i;
        const br = (k + 1) * P + iNext;
        idx.push(tl, bl, tr, tr, bl, br);
      }
    }

    const geo = this.makeGeometry(pos, uv, uv1, idx);
    // Guarantee outward normals: if the tube came out inside-out, flip winding.
    ensureOutward(geo);
    this.bakeAO(geo); // darken the underside of the ramp + lowest turns

    const mat = createMudBrickMaterial(this.params, true);
    this.mudMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'ramp';
    this.addPart(mesh);
  }

  // ------------------------------------------------------------------------
  //  SUMMIT — small cylindrical chamber, lathed so its rims are chamfered
  // ------------------------------------------------------------------------

  buildSummit() {
    const p = this.params;
    const r = p.chamberRadius;
    const h = p.chamberHeight;
    const c = p.edgeChamfer * 2; // rim rounding

    // 2D profile revolved around Y: rounded bottom rim, wall, rounded top,
    // then a shallow dome cap — never a sharp lip.
    const profile = [
      new THREE.Vector2(0.001, 0),
      new THREE.Vector2(r - c, 0),
      new THREE.Vector2(r, c),
      new THREE.Vector2(r, h - c),
      new THREE.Vector2(r - c, h),
      new THREE.Vector2(r * 0.55, h + c),
      new THREE.Vector2(0.001, h + r * 0.45),
    ];
    const geo = new THREE.LatheGeometry(profile, p.chamberSegments);
    // Lathe gives channel-0 UVs only; copy them into channel 1 as the hook.
    geo.setAttribute('uv1', new THREE.BufferAttribute(geo.attributes.uv.array.slice(), 2));

    const mat = createMudBrickMaterial(p, false);
    this.mudMaterials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = p.baseHeight + p.towerHeight; // stand it on the tower top
    mesh.name = 'summit';
    this.addPart(mesh);
  }

  // ------------------------------------------------------------------------
  //  Geometry + stats plumbing
  // ------------------------------------------------------------------------

  /** Pack raw arrays into an indexed BufferGeometry with two UV sets. */
  makeGeometry(pos, uv, uv1, idx) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); // channel 0
    g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2)); // channel 1
    g.setIndex(idx);
    g.computeVertexNormals(); // smooth normals; chamfers catch the highlights
    return g;
  }

  /**
   * Bake a cheap ambient-occlusion term into a vertex-colour attribute: darken
   * vertices near the ground contact and on downward-facing (under) surfaces.
   * Static and free at render time — enough to seat the tower in the sand and
   * shade the ramp's underside without a screen-space AO pass. The mesh material
   * must set `vertexColors: true` for it to take effect.
   */
  bakeAO(geo) {
    const p = this.params;
    const posAttr = geo.attributes.position;
    const nrmAttr = geo.attributes.normal;
    const n = posAttr.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = posAttr.getY(i);
      const ny = nrmAttr.getY(i);
      // 1 at the ground contact, fading to 0 by aoContactRange above the base.
      const contact = 1 - THREE.MathUtils.smoothstep(y - p.baseHeight, 0, p.aoContactRange);
      const under = Math.max(0, -ny); // down-facing surfaces are more occluded
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
      `[Malwiya] triangles: ${s.triangles.toLocaleString()} | ` +
        `vertices: ${s.vertices.toLocaleString()} | draw calls: ${s.drawCalls} ` +
        `| budget: <60,000 tris, <50 calls`
    );
  }

  // ------------------------------------------------------------------------
  //  GUI — every dimension, grouped, rebuilds the tower on change
  // ------------------------------------------------------------------------

  buildGUI(gui) {
    const f = gui.addFolder('Malwiya');
    const rebuild = () => this.rebuild();

    const base = f.addFolder('Base');
    base.add(this.params, 'baseSize', 20, 50, 0.5).onFinishChange(rebuild);
    base.add(this.params, 'baseHeight', 1, 8, 0.1).onFinishChange(rebuild);
    base.add(this.params, 'baseChamfer', 0, 1, 0.05).onFinishChange(rebuild);

    const tower = f.addFolder('Tower');
    tower.add(this.params, 'towerHeight', 20, 80, 1).onFinishChange(rebuild);
    tower.add(this.params, 'radiusBottom', 6, 25, 0.5).onFinishChange(rebuild);
    tower.add(this.params, 'radiusTop', 1, 10, 0.5).onFinishChange(rebuild);
    tower.add(this.params, 'towerRadialSegments', 12, 96, 1).onFinishChange(rebuild);
    tower.add(this.params, 'courseHeight', 0.3, 2, 0.05).onFinishChange(rebuild);

    const ramp = f.addFolder('Ramp');
    ramp.add(this.params, 'rampTurns', 1, 8, 1).onFinishChange(rebuild);
    ramp.add(this.params, 'rampWidth', 1, 5, 0.1).onFinishChange(rebuild);
    ramp.add(this.params, 'rampThickness', 0.2, 1.5, 0.05).onFinishChange(rebuild);
    ramp.add(this.params, 'parapetHeight', 0, 2, 0.05).onFinishChange(rebuild);
    ramp.add(this.params, 'parapetThickness', 0.1, 1, 0.05).onFinishChange(rebuild);
    ramp.add(this.params, 'segmentsPerTurn', 24, 200, 1).onFinishChange(rebuild);
    ramp.add(this.params, 'handedness', { CCW: -1, CW: 1 }).onFinishChange(rebuild);
    ramp.add(this.params, 'edgeChamfer', 0.02, 0.4, 0.01).onFinishChange(rebuild);

    const summit = f.addFolder('Summit');
    summit.add(this.params, 'chamberRadius', 1, 8, 0.1).onFinishChange(rebuild);
    summit.add(this.params, 'chamberHeight', 2, 12, 0.5).onFinishChange(rebuild);
    summit.add(this.params, 'chamberSegments', 8, 48, 1).onFinishChange(rebuild);

    const erosion = f.addFolder('Erosion');
    erosion.add(this.params, 'courseRelief', 0, 0.3, 0.01).onFinishChange(rebuild);
    erosion.add(this.params, 'slumpAmount', 0, 2, 0.05).onFinishChange(rebuild);
    erosion.add(this.params, 'missingBrickChance', 0, 0.2, 0.005).onFinishChange(rebuild);
    erosion.add(this.params, 'brickDepth', 0, 0.5, 0.02).onFinishChange(rebuild);
    erosion.add(this.params, 'aoStrength', 0, 1, 0.05).name('AO strength').onFinishChange(rebuild);
    erosion.add(this.params, 'aoContactRange', 1, 20, 0.5).name('AO range').onFinishChange(rebuild);
    erosion.add(this.params, 'seed', 0, 9999, 1).onFinishChange(rebuild);

    // Surface material — most controls update the shader uniforms live (no
    // rebuild); brick size changes the pattern so those rebuild.
    const surf = f.addFolder('Surface');
    const live = (key, uni) => (v) => {
      for (const m of this.mudMaterials) m.userData.mudUniforms[uni].value = v;
    };
    surf.add(this.params, 'weathering', 0, 1, 0.02).onChange(live('weathering', 'uWeathering'));
    surf.add(this.params, 'cavityDark', 0, 1, 0.02).name('cavity dirt').onChange(live('cavityDark', 'uCavityDark'));
    surf.add(this.params, 'edgeWear', 0, 1, 0.02).name('edge wear').onChange(live('edgeWear', 'uEdgeWear'));
    surf.add(this.params, 'polish', 0, 1, 0.02).name('foot polish').onChange(live('polish', 'uPolish'));
    surf.add(this.params, 'grainScale', 1, 20, 0.5).name('grain scale').onChange(live('grainScale', 'uGrainScale'));
    surf.add(this.params, 'brickTexW', 0.2, 1.5, 0.05).name('brick width').onFinishChange(rebuild);
    surf.add(this.params, 'brickTexH', 0.1, 0.6, 0.02).name('course height').onFinishChange(rebuild);
    surf.add(this.params, 'mortarWidth', 0.02, 0.25, 0.01).name('mortar').onFinishChange(rebuild);
  }
}

// --------------------------------------------------------------------------
//  Module-level helpers (pure functions, no `this`)
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

/**
 * Round every corner of a closed 2D profile into a small chamfer: each corner
 * point is split into two points pulled toward its neighbours. This is why the
 * ramp has no sharp edges — 1200-year-old mud brick never does.
 */
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
    const cp = Math.min(c, lp * 0.45); // never overrun half an edge
    const cn = Math.min(c, ln * 0.45);
    out.push([p[0] + (dp[0] / lp) * cp, p[1] + (dp[1] / lp) * cp]);
    out.push([p[0] + (dn[0] / ln) * cn, p[1] + (dn[1] / ln) * cn]);
  }
  return out;
}

/**
 * Make sure a swept tube faces outward. We sample the face whose vertex sits
 * furthest from the Y axis; if its normal points back toward the axis, the
 * whole geometry is inside-out, so we reverse the index winding.
 */
function ensureOutward(geo) {
  const posArr = geo.attributes.position.array;
  const nrmArr = geo.attributes.normal.array;
  let far = -1;
  let farIdx = 0;
  for (let i = 0; i < posArr.length; i += 3) {
    const r = posArr[i] * posArr[i] + posArr[i + 2] * posArr[i + 2];
    if (r > far) { far = r; farIdx = i; }
  }
  // Dot the outward radial direction with that vertex's normal.
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
