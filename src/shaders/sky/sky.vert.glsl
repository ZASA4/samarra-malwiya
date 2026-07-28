// The sky is a unit sphere kept centred on the camera and never rotated, so a
// vertex's object-space position IS the world view direction. We just pass that
// direction to the fragment shader; the fragment does all the atmosphere maths.
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Skybox trick: force the dome onto the far plane (z = w -> z/w = 1). Without
  // this, the tiny camera-centred sphere falls inside the near plane and gets
  // clipped away, leaving a black sky.
  gl_Position.z = gl_Position.w;
}
