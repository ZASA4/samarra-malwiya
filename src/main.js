import Scene from './scene/Scene.js';

// Entry point: find the container div, create the scene, start the loop.
const container = document.getElementById('app');
const scene = new Scene(container);
scene.start();
