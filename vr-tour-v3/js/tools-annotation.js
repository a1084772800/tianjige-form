// tools-annotation.js — renders manifest hotspots as DOM markers projected
// from world coords each frame. Click opens a content panel (text/image/video/
// link/nav). The "nav" type changes scene via SceneController.

import * as THREE from "three";

export class AnnotationLayer {
  constructor(ctrl, manifest) {
    this.ctrl = ctrl;
    this.manifest = manifest;
    this.markers = new Map();   // id -> { def, el }
    this.visible = true;

    const prev = ctrl.onFrame;
    ctrl.onFrame = (cam) => {
      if (prev) prev(cam);
      this.reproject();
    };
  }

  setVisible(v) {
    this.visible = v;
    this.markers.forEach(({ el }) => el.classList.toggle("hidden", !v));
  }

  refreshHotspots() {
    // Remove old
    this.markers.forEach(({ el }) => el.remove());
    this.markers.clear();
    const sceneDef = this.ctrl.currentSceneDef;
    if (!sceneDef) return;
    const list = sceneDef.hotspots || [];
    list.forEach(h => this.addMarker(h));
  }

  addMarker(def) {
    const el = document.createElement("div");
    el.className = "hotspot";
    el.dataset.id = def.id;
    el.dataset.type = def.type || "text";
    el.title = def.label || def.id;
    if (!this.visible) el.classList.add("hidden");
    document.body.appendChild(el);
    this.markers.set(def.id, { def, el });
  }

  reproject() {
    if (this.markers.size === 0) return;
    this.markers.forEach(({ def, el }) => {
      const p = new THREE.Vector3(...def.position);
      // Apply splat offset if set in scene def
      if (this.ctrl.currentSceneDef?.offset) {
        p.add(new THREE.Vector3(...this.ctrl.currentSceneDef.offset));
      }
      const s = this.ctrl.project(p);
      if (!s.visible) {
        el.style.display = "none";
      } else {
        el.style.display = "flex";
        el.style.left = s.x + "px";
        el.style.top = s.y + "px";
      }
    });
  }

  handleClick(id) {
    const entry = this.markers.get(id);
    if (!entry) return;
    const def = entry.def;
    if (def.type === "nav" && def.target_scene) {
      this.ctrl.loadScene(def.target_scene);
      return;
    }
    this.openPanel(def);
  }

  openPanel(def) {
    const content = document.getElementById("panel-content");
    let html = `<h3>${escapeHtml(def.label || def.id)}</h3>`;
    if (def.type === "text" && def.body) {
      html += `<p>${escapeHtml(def.body)}</p>`;
    } else if (def.type === "image" && def.src) {
      html += `<p>${escapeHtml(def.body || "")}</p><img src="${def.src}" alt="${escapeHtml(def.label || "")}">`;
    } else if (def.type === "video" && def.src) {
      html += `<video src="${def.src}" controls playsinline></video>`;
      if (def.body) html += `<p>${escapeHtml(def.body)}</p>`;
    } else if (def.type === "link" && def.url) {
      html += `<p>${escapeHtml(def.body || "")}</p><a href="${def.url}" target="_blank" rel="noopener">${escapeHtml(def.url)}</a>`;
    } else {
      html += `<p>${escapeHtml(def.body || "no content configured")}</p>`;
    }
    content.innerHTML = html;
    document.getElementById("panel").classList.add("show");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
