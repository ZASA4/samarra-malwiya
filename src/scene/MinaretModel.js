import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createMudBrickMaterial } from '../shaders/mud/MudBrickMaterial.js';
import { buildSummitPavilion } from './SummitPavilion.js';

/**
 * MinaretModel — loads the Sketchfab "Minaret of Samarra" GLTF and turns it into
 * OUR minaret: the model supplies the FORM, our shader supplies the SURFACE.
 *
 * Attribution: "The Minaret of Samarra, Iraq" by Chenzoss (Sketchfab), CC-BY-4.0.
 * See public/models/the_minaret_of_samarra_iraq/license.txt and README.md.
 *
 * Why we don't just call GLTFLoader.load():
 *   The model's baked PBR textures (~7 MB of baseColor/normal/roughness PNGs)
 *   are its weak point, and we throw them away. So we never download them:
 *     1. fetch the tiny scene.gltf JSON (4 KB),
 *     2. STRIP every material / texture / image / sampler from it,
 *     3. stream ONLY the geometry buffer (scene.bin, ~2.5 MB) with a real,
 *        byte-accurate progress callback,
 *     4. inline that buffer as a data: URI and parse the pure geometry.
 *   Result: ~2.5 MB downloaded instead of ~9.7 MB, and an honest progress bar.
 *
 * After parsing we:
 *   - log the bounding box, scale the whole thing so the tower is exactly 52 m,
 *     log the bounding box again, then seat the base on the ground (y = 0),
 *   - BAKE that scale into the geometry (not the Group) so world coordinates are
 *     in metres — the triplanar brick shader sizes its courses in world metres,
 *     so this is what keeps bricks physically sized,
 *   - bake a cheap contact-AO into vertex colours (undersides / base darken),
 *   - apply our procedural fired-brick material and enable shadows.
 *
 * This is a THREE.Group so Scene can add it like any other object; the real mesh
 * arrives asynchronously and fires onReady() when it is fully processed.
 */
export default class MinaretModel extends THREE.Group {
  /**
   * @param {object}   opts
   * @param {string}   opts.url          - URL of scene.gltf.
   * @param {number}   [opts.targetHeight=52] - final tower height in metres.
   * @param {boolean}  [opts.mirror=false]    - mirror on X to flip the spiral's
   *                                            handedness (chirality) if the
   *                                            model climbs the wrong way.
   * @param {(f:number,loaded:number,total:number)=>void} [opts.onProgress]
   * @param {(m:MinaretModel)=>void} [opts.onReady]
   * @param {(e:Error)=>void}        [opts.onError]
   * @param {GUI}      [opts.gui]        - lil-gui panel for live surface tuning.
   */
  constructor(opts = {}) {
    super();
    this.name = 'MinaretModel';

    this.url = opts.url;
    this.targetHeight = opts.targetHeight ?? 52;
    this.mirror = opts.mirror ?? false;
    this.onProgress = opts.onProgress;
    this.onReady = opts.onReady;
    this.onError = opts.onError;
    this.gui = opts.gui;

    // Fired-brick surface params (same palette the procedural Malwiya used, so
    // the visual language of the project is unchanged — only the FORM swapped).
    this.params = {
      // Contact-AO bake
      baseHeight: 0, // base sits on y = 0 after seating
      aoStrength: 0.4,
      aoContactRange: 8, // metres over which the base-contact shadow fades out

      // Surface (fired brick: warm buff/tan, hard edges)
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

      // Material relief: procedural bump in the shader. We do NOT sharpen the
      // scan geometry; we compensate here so the surface reads as fired brick.
      bumpScale: 0.7,
      grainRelief: 0.15,

      // Summit pavilion — the procedural open, blind-arch-niched crown that
      // replaces the GLTF's scan blob (see SummitPavilion.js and docs/reference).
      artifactZone: 1.6, // m: the scan blob occupies the top ~1.6 m of the raw mesh
      pavHeight: 4.0,
      pavWallThickness: 0.55,
      pavNiches: 12,
      pavNicheDepth: 0.32,
      pavRadialSegs: 96,
      pavHeightSegs: 32,
      pavRadiusScale: 0.98, // sit just inside the drum so it reads as stepped-in
    };

    this.meshes = [];
    this.materials = [];
    this.stats = { triangles: 0, vertices: 0, drawCalls: 0, loadMs: 0 };

    this._load();
  }

  // ------------------------------------------------------------------------
  //  Loading — strip textures, stream geometry with real progress, parse
  // ------------------------------------------------------------------------

  async _load() {
    const t0 = performance.now();
    try {
      const dir = this.url.slice(0, this.url.lastIndexOf('/') + 1);

      // 1. The GLTF JSON is tiny — grab it and drop everything about surfaces.
      const gltf = await fetch(this.url).then((r) => {
        if (!r.ok) throw new Error(`GLTF ${r.status} ${r.statusText}`);
        return r.json();
      });
      delete gltf.materials;
      delete gltf.textures;
      delete gltf.images;
      delete gltf.samplers;
      for (const mesh of gltf.meshes) {
        for (const prim of mesh.primitives) delete prim.material;
      }

      // 2. Stream the geometry buffer with a real byte-based progress bar.
      const binUrl = dir + gltf.buffers[0].uri;
      const bin = await this._fetchWithProgress(binUrl);

      // 3. Inline the buffer so the parser never touches the network again.
      gltf.buffers[0].uri = 'data:application/octet-stream;base64,' + base64FromBuffer(bin);

      // 4. Parse the now-textureless GLTF into a THREE scene graph.
      const loader = new GLTFLoader();
      const result = await new Promise((res, rej) =>
        loader.parse(JSON.stringify(gltf), dir, res, rej)
      );

      this._process(result.scene);
      this.stats.loadMs = performance.now() - t0;
      this._logStats();
      this.onReady?.(this);
    } catch (err) {
      console.error('[MinaretModel] load failed:', err);
      this.onError?.(err);
    }
  }

  /** fetch() that reports download progress from the response stream. */
  async _fetchWithProgress(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`bin ${resp.status} ${resp.statusText}`);
    const total = Number(resp.headers.get('Content-Length')) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      this.onProgress?.(total ? loaded / total : 0, loaded, total);
    }
    // Report a clean 100% even if Content-Length was missing.
    this.onProgress?.(1, loaded, total || loaded);

    const out = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out.buffer;
  }

  // ------------------------------------------------------------------------
  //  Processing — scale to 52 m, seat on ground, restyle
  // ------------------------------------------------------------------------

  _process(model) {
    // The GLTF's root node already stands the model upright (native Z-up -> our
    // Y-up). Make sure every node matrix is current before we measure it.
    model.updateMatrixWorld(true);

    // --- BEFORE bounding box (raw, pre-scale) -------------------------------
    const boxBefore = new THREE.Box3().setFromObject(model);
    const sizeBefore = boxBefore.getSize(new THREE.Vector3());
    console.log(
      `[MinaretModel] bbox BEFORE scale: ` +
        `min(${fmt(boxBefore.min)}) max(${fmt(boxBefore.max)}) ` +
        `size(${fmt(sizeBefore)}) height=${sizeBefore.y.toFixed(3)}`
    );

    // Uniform scale that makes the tower exactly targetHeight metres tall.
    const scale = this.targetHeight / sizeBefore.y;

    // Collect meshes and BAKE their world transform into the geometry, so the
    // whole thing lives in one flat space with no leftover node rotations.
    const meshes = [];
    model.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });

    for (const src of meshes) {
      const geo = src.geometry;
      geo.applyMatrix4(src.matrixWorld); // bake node hierarchy (the Z->Y rotation)
      geo.scale(scale, scale, scale); // bake the 52 m scale into vertices (metres)
      if (this.mirror) mirrorX(geo); // flip spiral chirality if requested

      // Trim attributes our shader never reads (no maps -> no uv/tangent needed).
      geo.deleteAttribute('tangent');
      geo.deleteAttribute('uv');
    }

    // Now measure the combined result and seat it: centre the tower axis on the
    // origin (X/Z) and drop the base onto y = 0 (no floating, no sinking).
    const combined = new THREE.Box3();
    for (const src of meshes) {
      src.geometry.computeBoundingBox();
      combined.union(src.geometry.boundingBox);
    }
    const center = combined.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(-center.x, -combined.min.y, -center.z);
    for (const src of meshes) src.geometry.translate(offset.x, offset.y, offset.z);

    // Build fresh meshes under THIS group (identity transform) so world-space
    // coordinates equal the geometry's metres — critical for the brick shader.
    for (const src of meshes) {
      const geo = src.geometry;
      this._clipSummitArtifact(geo); // remove the scan blob before we finalise
      geo.computeVertexNormals(); // consistent normals after all the baking
      this._bakeContactAO(geo);

      const mat = createMudBrickMaterial(this.params, true /* vertexColors */);
      // The model is a single-sided shell authored double-sided; keep both faces
      // so we never see through a wall, and cast shadows from the correct side.
      mat.side = THREE.DoubleSide;
      mat.shadowSide = THREE.FrontSide;
      this.materials.push(mat);

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'minaret';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.add(mesh);
      this.meshes.push(mesh);
    }

    // Replace the clipped summit with the authentic open, niched pavilion.
    this._buildPavilion();

    // --- AFTER bounding box (scaled + seated) -------------------------------
    const boxAfter = new THREE.Box3().setFromObject(this);
    const sizeAfter = boxAfter.getSize(new THREE.Vector3());
    console.log(
      `[MinaretModel] bbox AFTER scale: ` +
        `min(${fmt(boxAfter.min)}) max(${fmt(boxAfter.max)}) ` +
        `size(${fmt(sizeAfter)}) height=${sizeAfter.y.toFixed(3)} (target ${this.targetHeight}) ` +
        `| applied scale x${scale.toFixed(4)}`
    );

    this._computeStats();
    if (this.gui) this._buildGUI(this.gui);
  }

  /**
   * Bake a cheap ambient occlusion into a per-vertex colour attribute (the same
   * trick Malwiya used): darken where surfaces meet the ground and where they
   * face downward, so the base and ramp undersides feel grounded, not floaty.
   */
  _bakeContactAO(geo) {
    const p = this.params;
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const n = pos.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      const ny = nrm.getY(i);
      const contact = 1 - THREE.MathUtils.smoothstep(y - p.baseHeight, 0, p.aoContactRange);
      const under = Math.max(0, -ny);
      const ao = 1 - p.aoStrength * Math.min(1, Math.max(contact, under * 0.5));
      colors[i * 3] = ao;
      colors[i * 3 + 1] = ao;
      colors[i * 3 + 2] = ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  /**
   * Remove the scan artifact ("blob") that the GLTF ships baked into its single
   * mesh above the summit. Diagnosed as a self-contained connected component in
   * the top ~1.6 m: at that cut height NO triangle bridges it to the drum's cap,
   * so deleting its triangles cannot leave a hole. Radially compact (guarded by
   * maxR) so the wide cap disc below is never touched.
   */
  _clipSummitArtifact(geo) {
    const pos = geo.attributes.position;
    geo.computeBoundingBox();
    const clipY = geo.boundingBox.max.y - this.params.artifactZone; // top ~1.6 m
    const maxR = 2.6; // the blob is < 0.7 m; cap parts near this height are wider
    const above = (i) => pos.getY(i) > clipY;
    const near = (i) => Math.hypot(pos.getX(i), pos.getZ(i)) < maxR;

    const src = geo.index.array;
    const kept = [];
    let removed = 0;
    for (let t = 0; t < src.length; t += 3) {
      const a = src[t], b = src[t + 1], c = src[t + 2];
      // Remove only triangles fully inside the artifact zone (no bridging tris).
      if (above(a) && above(b) && above(c) && near(a) && near(b) && near(c)) {
        removed++;
        continue;
      }
      kept.push(a, b, c);
    }
    geo.setIndex(kept);
    geo.computeBoundingBox();
    console.log(
      `[MinaretModel] clipped summit blob: removed ${removed} tris above ` +
        `y=${clipY.toFixed(1)} m; tower now tops out at y=${geo.boundingBox.max.y.toFixed(2)} m`
    );
  }

  /**
   * Build the procedural open, blind-arch-niched pavilion and seat it on the
   * clipped tower top, matching docs/reference (samarra-05, samarra-10).
   */
  _buildPavilion() {
    const p = this.params;
    const main = this.meshes[0];
    const g = main.geometry;
    g.computeBoundingBox();
    const summitY = g.boundingBox.max.y;

    // Outer radius = the drum's radius just below the cap.
    const pos = g.attributes.position;
    let summitR = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > summitY - 1.2) {
        summitR = Math.max(summitR, Math.hypot(pos.getX(i), pos.getZ(i)));
      }
    }

    const mat = createMudBrickMaterial(p, true /* vertexColors */);
    mat.side = THREE.DoubleSide;
    mat.shadowSide = THREE.FrontSide;
    this.materials.push(mat);

    const pavilion = buildSummitPavilion(
      {
        baseY: summitY - 0.2, // overlap the cap slightly so there's no gap
        outerRadius: summitR * p.pavRadiusScale,
        wallThickness: p.pavWallThickness,
        height: p.pavHeight,
        nicheCount: p.pavNiches,
        nicheDepth: p.pavNicheDepth,
        radialSegments: p.pavRadialSegs,
        heightSegments: p.pavHeightSegs,
      },
      mat
    );
    this.add(pavilion);
    this.meshes.push(pavilion);
    console.log(
      `[MinaretModel] built summit pavilion: r=${(summitR * p.pavRadiusScale).toFixed(2)} m, ` +
        `h=${p.pavHeight} m, ${p.pavNiches} niches, base y=${(summitY - 0.2).toFixed(2)} m`
    );
  }

  // ------------------------------------------------------------------------
  //  Stats + GUI
  // ------------------------------------------------------------------------

  _computeStats() {
    let tris = 0;
    let verts = 0;
    for (const m of this.meshes) {
      const g = m.geometry;
      verts += g.attributes.position.count;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
    this.stats.triangles = tris;
    this.stats.vertices = verts;
    this.stats.drawCalls = this.meshes.length;
  }

  _logStats() {
    const s = this.stats;
    console.log(
      `[MinaretModel] triangles: ${s.triangles.toLocaleString()} | ` +
        `vertices: ${s.vertices.toLocaleString()} | draw calls: ${s.drawCalls} | ` +
        `load: ${s.loadMs.toFixed(0)} ms | budget: <60,000 tris, <50 calls`
    );
  }

  _buildGUI(gui) {
    const f = gui.addFolder('Minaret (model surface)');
    const live = (uni) => (v) => {
      for (const m of this.materials) m.userData.mudUniforms[uni].value = v;
    };
    f.add(this.params, 'weathering', 0, 1, 0.02).onChange(live('uWeathering'));
    f.add(this.params, 'cavityDark', 0, 1, 0.02).name('cavity dirt').onChange(live('uCavityDark'));
    f.add(this.params, 'edgeWear', 0, 1, 0.02).name('edge wear').onChange(live('uEdgeWear'));
    f.add(this.params, 'polish', 0, 1, 0.02).name('foot polish').onChange(live('uPolish'));
    // Procedural relief that compensates the photogrammetry smoothing.
    f.add(this.params, 'bumpScale', 0, 2, 0.05).name('brick relief').onChange(live('uBumpScale'));
    f.add(this.params, 'grainRelief', 0, 0.5, 0.01).name('grain relief').onChange(live('uGrainRelief'));
  }
}

// --------------------------------------------------------------------------
//  Pure helpers
// --------------------------------------------------------------------------

/** Format a Vector3 for logging: "x, y, z" with 2 decimals. */
function fmt(v) {
  return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
}

/**
 * Mirror a geometry across X to flip a helix's chirality. Rotation can't do this
 * (it preserves handedness); only an odd axis flip can. Flipping one axis also
 * inverts triangle winding, so we swap two indices per triangle to keep faces
 * outward, then recompute normals.
 */
function mirrorX(geo) {
  geo.scale(-1, 1, 1);
  const idx = geo.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  geo.index.needsUpdate = true;
  geo.computeVertexNormals();
}

/** Base64-encode an ArrayBuffer in chunks (avoids the arg-count limit of btoa). */
function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000; // 32 KB per String.fromCharCode call
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
