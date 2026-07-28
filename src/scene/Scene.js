import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Stats from 'stats.js';
import GUI from 'lil-gui';
import MinaretModel from './MinaretModel.js';
import LoadingOverlay from './LoadingOverlay.js';
import Environment from './Environment.js';
// NOTE: Malwiya.js (the original procedural minaret) is kept in the repo for
// comparison but is no longer imported or rendered — the GLTF model replaces it.

/**
 * Scene owns the three "engine" objects (renderer, camera, clock), the
 * THREE.Scene graph, the orbit controls, the FPS meter, and the render loop.
 * main.js just news it up and calls start().
 */
export default class Scene {
  /** @param {HTMLElement} container - DOM element the canvas is added to. */
  constructor(container) {
    this.container = container;

    // --- Renderer ------------------------------------------------------------
    // antialias: smooth edges. Then film-like tone mapping + correct colour
    // space so brightness/colour look right instead of washed out.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Soft shadow maps — the helical ramp's spiral shadow is the hero image.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // soft variant is deprecated in r185
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Cap pixel ratio at 2: retina screens can report 3, which triples the
    // pixels we shade for almost no visual gain — a big perf win on the M3.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    // --- Scene + Camera ------------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1206); // dim so lighting reads

    // (fov, aspect, near, far). far=2000 comfortably covers our 400-unit orbit.
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.1,
      2000
    );
    this.camera.position.set(80, 60, 120); // start above and back from origin

    // --- Clock ---------------------------------------------------------------
    // Gives us delta time each frame so animation is frame-rate independent.
    this.clock = new THREE.Clock();

    // --- Controls ------------------------------------------------------------
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; // smooth, weighty motion
    this.controls.minDistance = 20;     // can't zoom inside the building
    this.controls.maxDistance = 400;    // can't fly off to infinity
    // Polar angle is measured from straight up (0) down to straight down (PI).
    // The horizon is PI/2; stopping just short keeps the camera above ground.
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    // The orbit target and camera distance are computed from the minaret's real
    // bounds in frameMinaret(), called once the structure exists (buildWorld).

    // --- FPS meter -----------------------------------------------------------
    this.stats = new Stats();
    this.stats.showPanel(0); // 0 = frames per second
    this.stats.dom.style.position = 'absolute';
    this.stats.dom.style.top = '0';
    this.stats.dom.style.left = '0';
    this.container.appendChild(this.stats.dom);

    // lil-gui panel — Malwiya registers all its dimension sliders here.
    this.gui = new GUI();

    // Build the visible contents, then wire up resizing.
    this.buildWorld();
    // Bind so `this` is correct when the browser calls these back.
    this.onResize = this.onResize.bind(this);
    this.tick = this.tick.bind(this);
    window.addEventListener('resize', this.onResize);
  }

  /** Ground, placeholder minaret, and lights. */
  buildWorld() {
    // --- Ground plane --------------------------------------------------------
    // 1000x1000, rotated flat. rotateX(-90deg) because a plane is born facing +Z.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.MeshStandardMaterial({ color: 0xb08d57 }) // sandy tone
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true; // catches the spiral shadow
    this.scene.add(this.ground);

    // --- The minaret (GLTF model) -------------------------------------------
    // Loads asynchronously: the group starts EMPTY and fills in when the GLTF
    // resolves. A LoadingOverlay shows real byte-progress from the download.
    this.overlay = new LoadingOverlay(this.container);
    const modelUrl =
      import.meta.env.BASE_URL + 'models/the_minaret_of_samarra_iraq/scene.gltf';
    this.minaret = new MinaretModel({
      url: modelUrl,
      targetHeight: 52, // metres — the real Malwiya's height
      mirror: false, // flip to true if the ramp spirals the wrong way (docs/reference)
      gui: this.gui,
      onProgress: (f, loaded, total) => this.overlay.setProgress(f, loaded, total),
      onReady: () => this.onMinaretReady(),
      onError: (e) => this.overlay.fail(e.message),
    });
    this.scene.add(this.minaret);

    // --- Lighting + sky ------------------------------------------------------
    // Environment owns the sun (sky + all four light sources) and the shadows.
    this.environment = new Environment(this.scene, this.gui);

    // Provisional framing so the empty scene isn't aimed at nothing; the real
    // fit happens in onMinaretReady() once the tower's true bounds are known.
    this.controls.target.set(0, 26, 0);
    this.controls.update();
    this.gui.add({ frame: () => this.frameMinaret() }, 'frame').name('Frame minaret');
    // Perf tooling for HARD RULE #3 (60fps at 4K). One click renders the scene
    // at a true 3840x2160 buffer for a few seconds and logs avg/min fps.
    this.benchmarking = false;
    this.gui.add({ bench: () => this.benchmark4K() }, 'bench').name('Benchmark 4K (5s)');
  }

  /** The GLTF has arrived and been restyled — frame it and dismiss the loader. */
  onMinaretReady() {
    this.frameMinaret();
    this.overlay.hide();
    // Report draw calls once the model is drawn (info is populated after a render).
    requestAnimationFrame(() => {
      const info = this.renderer.info.render;
      console.log(
        `[Scene] draw calls: ${info.calls} | triangles this frame: ${info.triangles.toLocaleString()} ` +
          `(colour + shadow passes) | budget: <50 calls`
      );
    });
  }

  /**
   * Force a real 4K (3840x2160) render for `seconds` and log the sustained fps.
   * updateStyle=false means the on-screen canvas is untouched — we only change
   * HOW MANY pixels the GPU shades, which is what the 4K budget is really about.
   * The main loop pauses (this.benchmarking) so only this loop draws.
   */
  benchmark4K(seconds = 5) {
    if (this.benchmarking) return;
    if (!this.minaret || this.minaret.children.length === 0) {
      console.warn('[perf] model not loaded yet — try again once the tower appears');
      return;
    }
    this.benchmarking = true;
    const prevPR = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(3840, 2160, false); // false = don't touch the CSS size
    this.camera.aspect = 3840 / 2160;
    this.camera.updateProjectionMatrix();

    let frames = 0;
    let minFps = Infinity;
    const start = performance.now();
    let last = start;
    const loop = () => {
      this.controls.update();
      this.environment.update(this.camera);
      this.renderer.render(this.scene, this.camera);
      const now = performance.now();
      if (frames > 0) minFps = Math.min(minFps, 1000 / (now - last)); // skip warm-up frame
      last = now;
      frames++;
      if (now - start < seconds * 1000) {
        requestAnimationFrame(loop);
      } else {
        const avg = frames / ((now - start) / 1000);
        const info = this.renderer.info.render;
        console.log(
          `[perf] 4K 3840x2160 for ${seconds}s: avg ${avg.toFixed(1)} fps, min ${minFps.toFixed(1)} fps ` +
            `| draw calls ${info.calls} | triangles ${info.triangles.toLocaleString()}`
        );
        // Restore the on-screen resolution and resume the normal loop.
        this.renderer.setPixelRatio(prevPR);
        this.onResize();
        this.benchmarking = false;
      }
    };
    requestAnimationFrame(loop);
  }

  /**
   * Fit the camera to the whole minaret:
   *  - bounding sphere of the minaret drives the fit distance + orbit target,
   *  - target sits at the structure's centre (tower mid-height), never origin,
   *  - near/far are derived from the real scene bounds so nothing clips.
   * Runs on startup and from the "Frame minaret" GUI button.
   */
  frameMinaret() {
    // The model loads asynchronously; do nothing until it actually has geometry.
    if (!this.minaret || this.minaret.children.length === 0) return;

    // Bounding sphere of the minaret ONLY — its centre is ~tower mid-height and
    // (because the ramp wraps symmetrically) horizontally over the origin.
    const box = new THREE.Box3().setFromObject(this.minaret);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = sphere.center;
    const radius = sphere.radius;

    // Aim the orbit target at that centre, not the ground.
    this.controls.target.copy(center);

    // Distance so the sphere fits inside the view. We fit whichever field of
    // view is tighter (vertical vs horizontal) so it still frames in a narrow,
    // portrait window. dist = r / sin(fov/2) is the sphere-fit formula.
    const margin = 1.25; // 25% breathing room around the tower
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fitDist = (radius * margin) / Math.sin(Math.min(vFov, hFov) / 2);

    // Keep the current viewing angle; only slide the camera along it to the fit
    // distance. That is what makes the button "re-centre" rather than teleport.
    const dir = new THREE.Vector3().subVectors(this.camera.position, center);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.7, 1); // fallback if degenerate
    dir.normalize();
    this.camera.position.copy(center).addScaledVector(dir, fitDist);

    // Near/far from the FULL scene bounds (includes the ground plane) so the
    // ground never clips and depth precision is far tighter than 0.1..2000.
    const sceneSphere = new THREE.Box3()
      .setFromObject(this.scene)
      .getBoundingSphere(new THREE.Sphere());
    this.camera.near = Math.max(0.1, fitDist - radius * 2);
    this.camera.far = fitDist + sceneSphere.radius * 2;
    this.camera.updateProjectionMatrix();

    // Aim the sun + tighten the shadow frustum around the same centre/size.
    if (this.environment) this.environment.focusOn(center, radius);

    this.controls.update(); // apply the new target + position immediately
  }

  /** Keep the render size and camera aspect matched to the window. */
  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix(); // must call after changing aspect
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  /** One frame: measured by Stats, advances controls, draws the scene. */
  tick() {
    // While the 4K benchmark owns the renderer, skip this loop's draw so the two
    // render loops don't fight (that would corrupt the fps measurement).
    if (this.benchmarking) {
      requestAnimationFrame(this.tick);
      return;
    }
    this.stats.begin();
    const delta = this.clock.getDelta(); // seconds since last frame (for later)
    this.controls.update();              // required when damping is on
    this.environment.update(this.camera); // keep the sky dome on the camera
    this.renderer.render(this.scene, this.camera);
    this.stats.end();
    // Ask the browser for the next frame — this is our render loop.
    requestAnimationFrame(this.tick);
  }

  /** Kick off the loop. */
  start() {
    this.tick();
  }
}
