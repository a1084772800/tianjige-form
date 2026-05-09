// tools-dollhouse.js — top-down ortho view with cutaway slider.
// Switches the active camera to OrthographicCamera, positioned above the
// scene looking straight down. Cutaway slider sets a clip-plane Y so users
// can see inside rooms.

import * as THREE from "three";

export class DollhouseMode {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.enabled = false;
    this.ui = document.getElementById("cutaway");
    this.slider = document.getElementById("cutaway-slider");
    this.cutawayY = 1.0;
    this.clipPlane = null;
    this._slide = () => this.onSliderChange();
  }

  toggle(on) {
    this.enabled = on;
    if (on) {
      this.ui.classList.add("show");
      this.slider.addEventListener("input", this._slide);
      this.fitOrtho();
      this.applyClip();
    } else {
      this.ui.classList.remove("show");
      this.slider.removeEventListener("input", this._slide);
      this.clearClip();
    }
  }

  fitOrtho() {
    if (!this.ctrl.bbox) return;
    const bbox = this.ctrl.bbox.clone().applyMatrix4(this.ctrl.splatMesh.matrixWorld);
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    const aspect = innerWidth / innerHeight;
    // Frame the largest XZ extent
    const extent = Math.max(size.x, size.z) * 0.6;
    const cam = this.ctrl.orthoCam;
    cam.left = -extent * aspect;
    cam.right = extent * aspect;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 0.1;
    cam.far = Math.max(60, size.y * 4 + 20);
    cam.position.set(center.x, bbox.max.y + size.y * 1.5, center.z);
    cam.up.set(0, 0, -1);
    cam.lookAt(center.x, bbox.min.y, center.z);
    cam.updateProjectionMatrix();
  }

  onSliderChange() {
    this.cutawayY = +this.slider.value / 100;
    this.applyClip();
  }

  applyClip() {
    if (!this.ctrl.bbox || !this.ctrl.splatMesh) return;
    const bbox = this.ctrl.bbox.clone().applyMatrix4(this.ctrl.splatMesh.matrixWorld);
    const yMin = bbox.min.y;
    const yMax = bbox.max.y;
    const cutY = yMin + (yMax - yMin) * this.cutawayY;

    // Three.js global clipping (Spark splats may not respect this fully but ortho framing
    // is the primary effect; we still set it for native meshes/markers).
    this.ctrl.renderer.localClippingEnabled = true;
    this.ctrl.renderer.clippingPlanes = [
      new THREE.Plane(new THREE.Vector3(0, -1, 0), cutY)
    ];
  }

  clearClip() {
    this.ctrl.renderer.clippingPlanes = [];
    this.ctrl.renderer.localClippingEnabled = false;
  }
}
