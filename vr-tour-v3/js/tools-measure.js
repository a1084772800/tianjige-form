// tools-measure.js — point-to-point distance measurement.
// Click 1 = first marker, click 2 = second marker + line + distance label.
// Uses SceneController.raycastFromClient for world-space hits.

import * as THREE from "three";

export class MeasureTool {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.enabled = false;
    this.points = [];           // 3D world points
    this.markers = [];          // DOM elements
    this.line = null;           // DOM element
    this.label = null;          // DOM element
    this.ui = document.getElementById("measure-ui");
    this.val = document.getElementById("measure-val");
    this._click = (e) => this.onCanvasClick(e);

    // Re-project markers each frame (camera moves)
    if (ctrl.onFrame) {
      const prev = ctrl.onFrame;
      ctrl.onFrame = (cam) => { prev(cam); this.reproject(); };
    } else {
      ctrl.onFrame = () => this.reproject();
    }
  }

  toggle(on) {
    this.enabled = on;
    if (on) {
      this.ui.classList.add("show");
      this.ctrl.canvas.addEventListener("click", this._click);
    } else {
      this.ui.classList.remove("show");
      this.ctrl.canvas.removeEventListener("click", this._click);
      this.clear();
    }
  }

  clear() {
    this.points = [];
    this.markers.forEach(m => m.remove());
    this.markers = [];
    if (this.line) { this.line.remove(); this.line = null; }
    if (this.label) { this.label.remove(); this.label = null; }
    if (this.val) this.val.textContent = "0.00 m";
  }

  onCanvasClick(e) {
    if (!this.enabled) return;
    if (this.points.length >= 2) this.clear();
    const hit = this.ctrl.raycastFromClient(e.clientX, e.clientY);
    if (!hit) return;
    this.points.push(hit);
    const m = document.createElement("div");
    m.className = "measure-marker";
    document.body.appendChild(m);
    this.markers.push(m);
    if (this.points.length === 2) this.drawLine();
    this.reproject();
  }

  drawLine() {
    this.line = document.createElement("div");
    this.line.className = "measure-line";
    document.body.appendChild(this.line);
    this.label = document.createElement("div");
    this.label.className = "measure-label";
    document.body.appendChild(this.label);
  }

  reproject() {
    if (this.points.length === 0) return;
    const screen = this.points.map(p => this.ctrl.project(p));
    this.markers.forEach((m, i) => {
      m.style.left = screen[i].x + "px";
      m.style.top = screen[i].y + "px";
      m.style.display = screen[i].visible ? "block" : "none";
    });
    if (this.points.length === 2 && this.line && this.label) {
      const a = screen[0], b = screen[1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      this.line.style.left = a.x + "px";
      this.line.style.top = a.y + "px";
      this.line.style.width = len + "px";
      this.line.style.transform = `rotate(${angle}deg)`;
      this.line.style.display = (a.visible && b.visible) ? "block" : "none";

      const dist = this.points[0].distanceTo(this.points[1]);
      const meters = this.ctrl.scaleToMeters(dist);
      this.label.textContent = meters.toFixed(2) + " m";
      this.label.style.left = ((a.x + b.x) / 2) + "px";
      this.label.style.top = ((a.y + b.y) / 2) + "px";
      this.label.style.display = (a.visible && b.visible) ? "block" : "none";
      if (this.val) this.val.textContent = meters.toFixed(2) + " m";
    }
  }
}
