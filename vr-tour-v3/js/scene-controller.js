// scene-controller.js — owns Three.js renderer, splat loading, camera rig,
// scene transitions, soft bounding box, and progressive download.
// Mode-agnostic: walk/measure/dollhouse handled by separate modules that
// read/write its public state.

import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls, SparkXr } from "@sparkjsdev/spark";

export class SceneController {
  constructor({ canvas, manifest }) {
    this.canvas = canvas;
    this.manifest = manifest;
    this.mode = "walk";

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e14);
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
    this.orthoCam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.xr.enabled = true;

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    // Camera rig (XR-friendly; camera lives inside)
    this.rig = new THREE.Group();
    this.scene.add(this.rig);
    this.rig.add(this.camera);

    this.splatMesh = null;
    this.currentSceneId = null;
    this.cutawayY = 1.0;  // 0..1 (1 = no cut)
    this.softBounds = { minX: -12, maxX: 12, minY: 0.2, maxY: 3, minZ: -12, maxZ: 12 };
    this.moveSpeedScale = 1.0;
    this.lookInput = { yaw: 0, pitch: 0 };
    this.frameCount = 0;
    this.lastFpsT = performance.now();
    this.fps = 0;
    this.onSceneChange = null;
    this.onFrame = null;

    addEventListener("resize", () => this.handleResize());

    this.sparkControls = new SparkControls({ canvas: this.renderer.domElement });
    this.xr = new SparkXr({ renderer: this.renderer });
    this._attachDesktopPanoLook();
  }

  // Desktop mouse-drag look (only used in panorama mode; no-op otherwise).
  _attachDesktopPanoLook() {
    let dragging = false, lx = 0, ly = 0;
    this.canvas.addEventListener("mousedown", (e) => {
      const isPano = this.currentSceneDef?.scene_type === "equirect" || this.currentSceneDef?.scene_type === "video";
      if (!isPano) return;
      dragging = true; lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener("mouseup", () => { dragging = false; });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this.lookInput.yaw -= dx * 0.0034;
      this.lookInput.pitch -= dy * 0.0034;
      this.lookInput.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.lookInput.pitch));
    });
    this.canvas.addEventListener("wheel", (e) => {
      const isPano = this.currentSceneDef?.scene_type === "equirect" || this.currentSceneDef?.scene_type === "video";
      if (!isPano) return;
      this.camera.fov = Math.max(35, Math.min(92, this.camera.fov + e.deltaY * 0.04));
      this.camera.updateProjectionMatrix();
      e.preventDefault();
    }, { passive: false });
  }

  handleResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    const aspect = innerWidth / innerHeight;
    const sz = 5;
    this.orthoCam.left = -sz * aspect;
    this.orthoCam.right = sz * aspect;
    this.orthoCam.top = sz;
    this.orthoCam.bottom = -sz;
    this.orthoCam.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  async init() {
    // VR availability ping
    if (navigator.xr) {
      try {
        const ok = await navigator.xr.isSessionSupported("immersive-vr");
        if (ok) document.getElementById("vr-btn")?.classList.add("show");
      } catch {}
    }
    document.getElementById("vr-btn")?.addEventListener("click", () => this.xr.enterXr?.());

    this.renderer.setAnimationLoop((t) => this.tick(t));
  }

  setMode(m) {
    this.mode = m;
    this.canvas.style.cursor = (m === "measure") ? "crosshair" : "default";
  }

  // Streaming download with progress callback ----------------------------
  async fetchSplat(url, sizeMb) {
    const loaderText = document.getElementById("loader-text");
    const loaderProg = document.getElementById("loader-progress");
    const loaderBarFill = document.getElementById("loader-bar-fill");
    const sceneLabel = this.manifest.scenes.find(s => s.splat_url === url)?.label || "scene";
    if (loaderText) loaderText.textContent = `loading: ${sceneLabel}`;
    if (loaderProg) loaderProg.textContent = "0%";
    if (loaderBarFill) loaderBarFill.style.width = "0%";

    const res = await fetch(url);
    if (!res.ok) throw new Error(`splat fetch ${res.status} for ${url}`);
    const total = +res.headers.get("content-length") || sizeMb * 1024 * 1024;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const pct = Math.min(99, Math.round(received / total * 100));
      if (loaderProg) loaderProg.textContent = `${pct}% (${(received / 1048576).toFixed(1)}MB)`;
      if (loaderBarFill) loaderBarFill.style.width = `${pct}%`;
    }
    const blob = new Blob(chunks);
    return URL.createObjectURL(blob);
  }

  async loadScene(sceneId) {
    const sceneDef = this.manifest.scenes.find(s => s.id === sceneId);
    if (!sceneDef) throw new Error(`scene ${sceneId} not in manifest`);
    if (this.currentSceneId === sceneId) return;
    this.currentSceneId = sceneId;

    this.canvas.style.transition = "opacity .3s";
    this.canvas.style.opacity = "0.18";

    if (this.splatMesh) { this.scene.remove(this.splatMesh); this.splatMesh = null; }
    if (this.panoMesh) { this.scene.remove(this.panoMesh); this.panoMesh.geometry?.dispose(); this.panoMesh.material?.map?.dispose?.(); this.panoMesh.material?.dispose(); this.panoMesh = null; }
    if (this.panoVideo) { try { this.panoVideo.pause(); this.panoVideo.removeAttribute("src"); this.panoVideo.load(); } catch {} this.panoVideo = null; }

    document.getElementById("loader")?.classList.remove("gone");
    const t = sceneDef.scene_type || "splat";
    if (t === "splat") return this._loadSceneSplat(sceneDef);
    if (t === "equirect") return this._loadSceneEquirect(sceneDef);
    if (t === "video") return this._loadSceneVideo(sceneDef);
    throw new Error(`unknown scene_type ${t}`);
  }

  async _loadSceneSplat(sceneDef) {
    let objUrl;
    try {
      objUrl = await this.fetchSplat(sceneDef.splat_url, sceneDef.size_mb);
    } catch (e) {
      const lt = document.getElementById("loader-text");
      if (lt) lt.textContent = "load failed: " + e.message.slice(0, 60);
      console.error("[scene] splat load fail", e);
      return;
    }
    this.splatMesh = new SplatMesh({
      url: objUrl,
      onLoad: () => {
        this.fitCamera(sceneDef);
        window.__splatReady = true;
        document.getElementById("loader")?.classList.add("gone");
        this.canvas.style.opacity = "1";
      }
    });
    this.splatMesh.position.set(...sceneDef.offset);
    this.scene.add(this.splatMesh);
    setTimeout(() => {
      document.getElementById("loader")?.classList.add("gone");
      this.canvas.style.opacity = "1";
    }, 1200);
    this.currentSceneDef = sceneDef;
    if (this.onSceneChange) this.onSceneChange(sceneDef.id);
  }

  async _loadSceneEquirect(sceneDef) {
    const lt = document.getElementById("loader-text");
    if (lt) lt.textContent = `loading: ${sceneDef.label}`;
    const tex = await new Promise((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.load(sceneDef.equirect_url, resolve, undefined, reject);
    }).catch(e => { if (lt) lt.textContent = "equirect load fail: " + e.message?.slice(0, 60); console.error(e); return null; });
    if (!tex) return;
    tex.colorSpace = THREE.SRGBColorSpace;
    this._buildPanoSphere(tex, sceneDef);
  }

  async _loadSceneVideo(sceneDef) {
    const lt = document.getElementById("loader-text");
    if (lt) lt.textContent = `loading: ${sceneDef.label}`;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.loop = true;
    v.muted = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.setAttribute("autoplay", "");
    v.preload = "auto";
    v.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(v);
    v.src = sceneDef.video_url;
    await new Promise((res, rej) => {
      v.addEventListener("loadeddata", res, { once: true });
      v.addEventListener("error", rej, { once: true });
      setTimeout(() => rej(new Error("video load timeout")), 20000);
    }).catch(e => { if (lt) lt.textContent = "video load fail: " + e.message?.slice(0, 60); console.error(e); });
    this.panoVideo = v;
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    this._buildPanoSphere(tex, sceneDef);
    try { await v.play(); } catch (e) { console.warn("video autoplay blocked", e); }
  }

  _buildPanoSphere(texture, sceneDef) {
    // Inside-facing sphere: scale.x = -1 inverts faces.
    const geo = new THREE.SphereGeometry(50, 64, 32);
    const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.x = -1;
    this.scene.add(mesh);
    this.panoMesh = mesh;

    // Camera rig sits at the sphere center; yaw=0 looks at the +Z (front-center)
    this.rig.position.set(0, 0, 0);
    this.lookInput.yaw = 0;
    this.lookInput.pitch = 0;
    this.rig.rotation.set(0, 0, 0);
    this.camera.rotation.set(0, 0, 0);

    // Soft bounds: keep camera at center (panorama is single-viewpoint).
    this.softBounds = { minX: -0.001, maxX: 0.001, minY: -0.001, maxY: 0.001, minZ: -0.001, maxZ: 0.001 };
    this.moveSpeedScale = 0;
    // Synthetic bbox so measure / dollhouse don't crash (they will be no-ops on pano).
    this.bbox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.bboxSize = new THREE.Vector3(2, 2, 2);

    document.getElementById("loader")?.classList.add("gone");
    this.canvas.style.opacity = "1";
    window.__splatReady = true;
    this.currentSceneDef = sceneDef;
    if (this.onSceneChange) this.onSceneChange(sceneDef.id);
  }

  fitCamera(sceneDef) {
    if (!this.splatMesh || !this.splatMesh.isInitialized) {
      // bbox not ready (LOD streaming) — fallback to start
      this.rig.position.set(...sceneDef.start);
      setTimeout(() => this.fitCamera(sceneDef), 2500);
      return;
    }
    try {
      const bbox = this.splatMesh.getBoundingBox(true);
      const valid = isFinite(bbox.min.x) && isFinite(bbox.max.x);
      if (!valid) {
        this.rig.position.set(...sceneDef.start);
        setTimeout(() => this.fitCamera(sceneDef), 2500);
        return;
      }
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());
      const worldCenter = center.clone()
        .applyQuaternion(this.splatMesh.quaternion)
        .add(this.splatMesh.position);

      // Use scene-defined start if it's within bbox, otherwise center
      const start = new THREE.Vector3(...sceneDef.start);
      const inside = start.x >= bbox.min.x + this.splatMesh.position.x && start.x <= bbox.max.x + this.splatMesh.position.x;
      this.rig.position.copy(inside ? start : worldCenter);

      // Aim along longer axis
      const aim = worldCenter.clone();
      if (size.x >= size.z) aim.x = bbox.min.x + this.splatMesh.position.x + size.x * 0.2;
      else aim.z = bbox.min.z + this.splatMesh.position.z + size.z * 0.2;
      this.rig.lookAt(aim);
      this.camera.rotation.set(0, 0, 0);
      this.lookInput.yaw = this.rig.rotation.y;
      this.lookInput.pitch = 0;

      // Soft bounds
      const shrink = 0.22;
      this.softBounds = {
        minX: bbox.min.x + this.splatMesh.position.x + size.x * shrink,
        maxX: bbox.max.x + this.splatMesh.position.x - size.x * shrink,
        minY: bbox.min.y + this.splatMesh.position.y + size.y * shrink,
        maxY: bbox.max.y + this.splatMesh.position.y - size.y * shrink,
        minZ: bbox.min.z + this.splatMesh.position.z + size.z * shrink,
        maxZ: bbox.max.z + this.splatMesh.position.z - size.z * shrink
      };
      this.moveSpeedScale = Math.min(2.5, Math.max(0.6, size.length() / 8));

      // Save bbox for dollhouse / measurement scale
      this.bbox = bbox;
      this.bboxSize = size;
    } catch (e) { console.warn("[scene] fitCamera err", e); }
  }

  tick(time) {
    const dt = Math.min(0.05, (time - (this._lastT || time)) / 1000);
    this._lastT = time;
    this.frameCount++;
    if (time - this.lastFpsT > 1000) {
      this.fps = this.frameCount * 1000 / (time - this.lastFpsT);
      this.frameCount = 0;
      this.lastFpsT = time;
    }

    if (this.mode === "dollhouse") {
      // Render with ortho cam (handled by DollhouseMode positioning the cam)
      this.renderer.render(this.scene, this.orthoCam);
      if (this.onFrame) this.onFrame(this.orthoCam);
      return;
    }

    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    const isPano = this.currentSceneDef?.scene_type === "equirect" || this.currentSceneDef?.scene_type === "video";
    if (isPano) {
      // Panorama: drive look from lookInput on both desktop & touch, ignore sparkControls.
      this.rig.position.set(0, 0, 0);
      this.rig.rotation.y = this.lookInput.yaw;
      this.camera.rotation.x = this.lookInput.pitch;
      this.camera.rotation.y = 0;
      this.camera.rotation.z = 0;
    } else if (!isTouch && this.mode === "walk") {
      this.sparkControls.update(this.rig, this.camera);
    } else if (this.mode === "walk") {
      this.rig.rotation.y = this.lookInput.yaw;
      this.camera.rotation.x = this.lookInput.pitch;
      this.camera.rotation.y = 0;
      this.camera.rotation.z = 0;
    }

    this.renderer.render(this.scene, this.camera);
    if (this.onFrame) this.onFrame(this.camera);
  }

  // Project 3D world point to 2D screen pixel coords ----------------------
  project(point3) {
    const v = point3.clone().project(this.activeCamera());
    return {
      x: (v.x * 0.5 + 0.5) * innerWidth,
      y: (-v.y * 0.5 + 0.5) * innerHeight,
      z: v.z,
      visible: v.z > -1 && v.z < 1
    };
  }

  activeCamera() {
    return this.mode === "dollhouse" ? this.orthoCam : this.camera;
  }

  // Convert a screen click to a world ray and intersect with splat bbox.
  // Returns world point or null.
  raycastFromClient(clientX, clientY) {
    if (!this.bbox) return null;
    const ndc = new THREE.Vector2(
      (clientX / innerWidth) * 2 - 1,
      -(clientY / innerHeight) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.activeCamera());

    // Build a Box3 in world coords (apply splat transform)
    const worldBox = this.bbox.clone().applyMatrix4(this.splatMesh.matrixWorld);
    const hit = new THREE.Vector3();
    const ok = ray.ray.intersectBox(worldBox, hit);
    if (ok) return hit;

    // Fallback: project ray onto Y plane at camera height
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.rig.position.y);
    const planeHit = new THREE.Vector3();
    ray.ray.intersectPlane(plane, planeHit);
    return planeHit;
  }

  scaleToMeters(distance) {
    return distance * (this.currentSceneDef?.scale_to_meters ?? 1.0);
  }
}
