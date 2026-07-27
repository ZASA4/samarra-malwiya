import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Stats from 'stats.js';

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

    // --- FPS meter -----------------------------------------------------------
    this.stats = new Stats();
    this.stats.showPanel(0); // 0 = frames per second
    this.stats.dom.style.position = 'absolute';
    this.stats.dom.style.top = '0';
    this.stats.dom.style.left = '0';
    this.container.appendChild(this.stats.dom);

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
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.MeshStandardMaterial({ color: 0xb08d57 }) // sandy tone
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    // --- Placeholder for the minaret ----------------------------------------
    // A tall box centred at the origin, lifted so it sits ON the ground.
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(20, 60, 20),
      new THREE.MeshStandardMaterial({ color: 0x9c7a4d })
    );
    box.position.y = 30; // half its height, so its base touches y=0
    this.scene.add(box);

    // --- Lighting ------------------------------------------------------------
    // Ambient: flat fill so nothing is pure black. Directional: the "sun",
    // giving shape and a shadow direction (sunset feel from a low angle).
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const sun = new THREE.DirectionalLight(0xffd8a8, 2.0);
    sun.position.set(100, 120, 60);
    this.scene.add(sun);
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
    this.stats.begin();
    const delta = this.clock.getDelta(); // seconds since last frame (for later)
    this.controls.update();              // required when damping is on
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
