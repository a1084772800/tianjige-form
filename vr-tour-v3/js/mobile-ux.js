// mobile-ux.js — virtual joystick (move) + drag-to-look + pinch-to-zoom (FOV)
// + iOS DeviceOrientation gyro permission + tilt-to-look.

import * as THREE from "three";

export class MobileUX {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    this.isVRHeadset = /OculusBrowser|Quest|Oculus/i.test(navigator.userAgent);
    this.input = { x: 0, y: 0, active: false };
    this.MOVE_SPEED = 1.6;

    this.fov = 70;
    this.minFov = 35;
    this.maxFov = 92;

    this._loop = (t) => this.tick(t);
    this._lastT = 0;
  }

  attach() {
    if (!this.isTouch || this.isVRHeadset) return;
    this.attachJoystick();
    this.attachLookDrag();
    this.attachPinch();
    this.attachGyroPrompt();
    requestAnimationFrame(this._loop);
  }

  attachJoystick() {
    const joystick = document.getElementById("joystick");
    const knob = document.getElementById("joystick-knob");
    joystick.classList.add("show");

    const STICK_RADIUS = 32;
    let stickTouchId = null;
    let stickRect = null;

    const setKnob = (dx, dy) => {
      const mag = Math.hypot(dx, dy);
      let nx = dx, ny = dy;
      if (mag > STICK_RADIUS) { nx = dx * STICK_RADIUS / mag; ny = dy * STICK_RADIUS / mag; }
      knob.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
      this.input.x = nx / STICK_RADIUS;
      this.input.y = ny / STICK_RADIUS;
    };
    const reset = () => {
      knob.style.transform = "translate(-50%, -50%)";
      this.input.x = this.input.y = 0;
      this.input.active = false;
      joystick.classList.remove("active");
    };

    joystick.addEventListener("touchstart", e => {
      if (stickTouchId !== null) return;
      const t = e.changedTouches[0];
      stickTouchId = t.identifier;
      stickRect = joystick.getBoundingClientRect();
      this.input.active = true;
      joystick.classList.add("active");
      setKnob(t.clientX - (stickRect.left + stickRect.width/2),
              t.clientY - (stickRect.top + stickRect.height/2));
      e.preventDefault();
    }, { passive: false });

    document.addEventListener("touchmove", e => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickTouchId && stickRect) {
          setKnob(t.clientX - (stickRect.left + stickRect.width/2),
                  t.clientY - (stickRect.top + stickRect.height/2));
          e.preventDefault();
        }
      }
    }, { passive: false });

    const endTouch = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickTouchId) { stickTouchId = null; reset(); }
      }
    };
    document.addEventListener("touchend", endTouch, { passive: false });
    document.addEventListener("touchcancel", endTouch, { passive: false });
  }

  attachLookDrag() {
    let lookTouchId = null;
    let lookLast = { x: 0, y: 0 };

    document.addEventListener("touchstart", e => {
      for (const t of e.changedTouches) {
        const tgt = document.elementFromPoint(t.clientX, t.clientY);
        if (tgt && tgt.closest("#joystick, #cta, #vr-btn, #cta-btn, .tool-btn, .scene-pill, #panel, .hotspot, #cutaway")) continue;
        if (lookTouchId === null) {
          lookTouchId = t.identifier;
          lookLast.x = t.clientX;
          lookLast.y = t.clientY;
        }
      }
    }, { passive: true });

    document.addEventListener("touchmove", e => {
      for (const t of e.changedTouches) {
        if (t.identifier === lookTouchId) {
          const dx = t.clientX - lookLast.x;
          const dy = t.clientY - lookLast.y;
          lookLast.x = t.clientX;
          lookLast.y = t.clientY;
          this.ctrl.lookInput.yaw -= dx * 0.0034;
          this.ctrl.lookInput.pitch -= dy * 0.0034;
          this.ctrl.lookInput.pitch = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, this.ctrl.lookInput.pitch));
          e.preventDefault();
        }
      }
    }, { passive: false });

    const end = e => {
      for (const t of e.changedTouches) if (t.identifier === lookTouchId) lookTouchId = null;
    };
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", end, { passive: true });
  }

  attachPinch() {
    let last = null;
    document.addEventListener("touchstart", e => {
      if (e.touches.length === 2) {
        last = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    }, { passive: true });
    document.addEventListener("touchmove", e => {
      if (e.touches.length === 2 && last !== null) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const delta = (last - d) * 0.12;
        this.fov = Math.max(this.minFov, Math.min(this.maxFov, this.fov + delta));
        this.ctrl.camera.fov = this.fov;
        this.ctrl.camera.updateProjectionMatrix();
        last = d;
      } else {
        last = null;
      }
    }, { passive: true });
    document.addEventListener("touchend", () => { last = null; }, { passive: true });
  }

  attachGyroPrompt() {
    // iOS 11+ requires permission. We don't request automatically; show a small
    // prompt the first time a touch happens (one-time per session via sessionStorage).
    const ASKED = "v3_gyro_asked";
    const dlg = document.getElementById("perm-dialog");
    if (!dlg) return;

    const enable = () => {
      window.addEventListener("deviceorientation", e => this.onOrient(e), { passive: true });
    };

    const ask = async () => {
      if (sessionStorage.getItem(ASKED)) return;
      sessionStorage.setItem(ASKED, "1");

      if (typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function") {
        // iOS 13+
        dlg.classList.add("show");
        document.getElementById("perm-yes").onclick = async () => {
          dlg.classList.remove("show");
          try {
            const r = await DeviceOrientationEvent.requestPermission();
            if (r === "granted") enable();
          } catch (e) { console.warn("[mobile] gyro perm err", e); }
        };
        document.getElementById("perm-no").onclick = () => dlg.classList.remove("show");
      } else if ("DeviceOrientationEvent" in window) {
        // Android & legacy: enable directly
        enable();
      }
    };

    document.addEventListener("touchstart", ask, { once: true, passive: true });
  }

  onOrient(e) {
    if (this._lastGyro && Date.now() - this._lastGyro < 30) return;
    this._lastGyro = Date.now();
    // alpha = z compass; beta = front-back tilt; gamma = left-right tilt
    if (e.beta == null || e.gamma == null) return;
    // Use beta (front-back) as pitch, alpha or gamma as yaw delta
    if (this._gyroBase == null) {
      this._gyroBase = { alpha: e.alpha || 0, beta: e.beta };
      return;
    }
    const dy = (e.alpha - this._gyroBase.alpha) * Math.PI / 180;
    const dx = (e.beta - this._gyroBase.beta) * Math.PI / 180;
    // small smoothing factor
    this.ctrl.lookInput.yaw = this.ctrl.lookInput.yaw * 0.85 + (-dy) * 0.15;
    this.ctrl.lookInput.pitch = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2,
      this.ctrl.lookInput.pitch * 0.85 + (-dx + Math.PI/4) * 0.15));
  }

  tick(time) {
    requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, (time - (this._lastT || time)) / 1000);
    this._lastT = time;
    if (!this.input.active) return;
    if (Math.abs(this.input.x) < 0.12 && Math.abs(this.input.y) < 0.12) return;
    if (this.ctrl.mode !== "walk") return;

    const fwd = new THREE.Vector3();
    const rgt = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    this.ctrl.camera.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    rgt.crossVectors(fwd, up).normalize();

    const speed = this.MOVE_SPEED * this.ctrl.moveSpeedScale * dt;
    const dx = this.input.x * speed;
    const dy = this.input.y * speed;
    this.ctrl.rig.position.addScaledVector(fwd, -dy);
    this.ctrl.rig.position.addScaledVector(rgt, dx);

    const sb = this.ctrl.softBounds;
    this.ctrl.rig.position.x = Math.max(sb.minX, Math.min(sb.maxX, this.ctrl.rig.position.x));
    this.ctrl.rig.position.y = Math.max(sb.minY, Math.min(sb.maxY, this.ctrl.rig.position.y));
    this.ctrl.rig.position.z = Math.max(sb.minZ, Math.min(sb.maxZ, this.ctrl.rig.position.z));
  }
}
