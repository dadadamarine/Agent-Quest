import { describe, it, expect } from 'bun:test';
import {
  AutoCameraController,
  type AutoCameraControllerOptions,
  type ControllableCamera,
} from './AutoCameraController';
import type { AutoCameraConfig } from './autoCameraPlanning';
import type { AutoCameraTiming } from './autoCameraState';

const config: AutoCameraConfig = {
  worldWidth: 2800,
  worldHeight: 1800,
  villageWidth: 1100,
  villageHeight: 700,
  villageCenterX: 1400,
  villageCenterY: 900,
  overviewMargin: 0.85,
  maxZoom: 1.5,
};

const timing: AutoCameraTiming = {
  manualResumeMs: 5000,
  idleOverviewMs: 8000,
  focusDebounceMs: 800,
};

function makeOptions(enabled: boolean): AutoCameraControllerOptions {
  return {
    config,
    timing,
    lerpFactor: 0.2,
    maxZoomDeltaPerFrame: 0.05,
    centerEpsilon: 1,
    zoomEpsilon: 0.005,
    enabled,
  };
}

/** Mock camera that records writes and keeps midPoint/zoom consistent. */
function makeCamera(): ControllableCamera & { writes: number } {
  const cam = {
    width: 1280,
    height: 800,
    zoom: 1,
    _cx: 1400,
    _cy: 900,
    writes: 0,
    get midPoint() {
      return { x: this._cx, y: this._cy };
    },
    centerOn(x: number, y: number) {
      this._cx = x;
      this._cy = y;
      this.writes++;
    },
    setZoom(z: number) {
      // Phaser changes zoom without preserving the world-space midpoint; scroll
      // stays fixed until centerOn/pan writes it again.
      const scrollX = this._cx - this.width / this.zoom / 2;
      const scrollY = this._cy - this.height / this.zoom / 2;
      this.zoom = z;
      this._cx = scrollX + this.width / this.zoom / 2;
      this._cy = scrollY + this.height / this.zoom / 2;
      this.writes++;
    },
  };
  return cam;
}

describe('AutoCameraController', () => {
  it('does not write to the camera while disabled', () => {
    const cam = makeCamera();
    const controller = new AutoCameraController(cam, makeOptions(false));
    controller.setActiveTargets([{ x: 500, y: 500 }]);
    controller.update(1000);
    controller.update(2000);
    expect(cam.writes).toBe(0);
  });

  it('does not write while paused by a manual interaction, then resumes', () => {
    const cam = makeCamera();
    const controller = new AutoCameraController(cam, makeOptions(true));
    controller.setActiveTargets([{ x: 500, y: 500 }]);
    controller.notifyManualInteraction(10_000);
    const before = cam.writes;
    controller.update(11_000); // within 5s pause
    expect(cam.writes).toBe(before);
    controller.update(16_000); // past pause
    expect(cam.writes).toBeGreaterThan(before);
  });

  it('converges the camera toward a hero that has roamed outside the village', () => {
    const cam = makeCamera();
    const controller = new AutoCameraController(cam, makeOptions(true));
    // Hero past the village on both axes (village rect x 850–1950, y 550–1250),
    // so the village+hero box extends down-left of the village center and the
    // camera converges that way.
    controller.setActiveTargets([{ x: 500, y: 1500 }]);
    for (let t = 0; t <= 20_000; t += 100) {
      controller.update(t);
    }
    // bbox (500,550)-(1950,1500) → center (1225, 1025), zoomed out from the
    // village-only fit. Camera has lerped well away from the start (1400,900).
    expect(cam.midPoint.x).toBeLessThan(1400);
    expect(cam.midPoint.y).toBeGreaterThan(900);
    expect(cam.zoom).toBeLessThan(0.971); // wider box than village-only
  });

  it('toggles enabled state', () => {
    const cam = makeCamera();
    const controller = new AutoCameraController(cam, makeOptions(true));
    expect(controller.enabled).toBe(true);
    controller.setEnabled(false);
    expect(controller.enabled).toBe(false);
    controller.setActiveTargets([{ x: 500, y: 500 }]);
    controller.update(1000);
    expect(cam.writes).toBe(0);
  });

  it('caps per-frame zoom change to avoid lurches', () => {
    const cam = makeCamera();
    cam.zoom = 0.5;
    const controller = new AutoCameraController(cam, makeOptions(true));
    controller.setActiveTargets([{ x: 1400, y: 900 }, { x: 1500, y: 1000 }]);
    // First unpaused frame after debounce commit.
    for (let t = 0; t <= 900; t += 100) controller.update(t);
    // Zoom moved toward the goal but by at most maxZoomDeltaPerFrame per call.
    expect(cam.zoom).toBeGreaterThan(0.5);
    expect(cam.zoom).toBeLessThanOrEqual(0.5 + 0.05 * 10 + 1e-9);
  });

  it('does not pan when only zoom needs to move toward the same center', () => {
    const cam = makeCamera(); // already centered on the village
    const controller = new AutoCameraController(cam, makeOptions(true));

    controller.setActiveTargets([]);
    controller.update(100);

    expect(cam.midPoint.x).toBe(1400);
    expect(cam.midPoint.y).toBe(900);
    expect(cam.zoom).toBeLessThan(1);
  });

  describe('village framing keeps the camera steady (issue #52)', () => {
    it('barely moves the center while a focused hero wanders inside the village', () => {
      const cam = makeCamera(); // starts at the village center (1400, 900)
      const controller = new AutoCameraController(cam, makeOptions(true));
      // Same live ref; the goal frames the village + this hero, so while the hero
      // stays inside the village the goal center is the village center and the
      // camera holds steady — no chasing, no lurch (the issue #52 complaint).
      const hero = { x: 1400, y: 900 };
      controller.setActiveTargets([hero]);
      for (let t = 0; t <= 20_000; t += 100) controller.update(t);
      const cx = cam.midPoint.x;
      const cy = cam.midPoint.y;
      hero.x = 1100; // a different spot, still well inside the village rect
      hero.y = 750;
      for (let t = 20_100; t <= 21_000; t += 100) controller.update(t);
      expect(Math.abs(cam.midPoint.x - cx)).toBeLessThan(1);
      expect(Math.abs(cam.midPoint.y - cy)).toBeLessThan(1);
    });

    it('pans smoothly (no jump) when a hero roams past the village edge', () => {
      const cam = makeCamera();
      const controller = new AutoCameraController(cam, makeOptions(true));
      const hero = { x: 1400, y: 900 };
      controller.setActiveTargets([hero]);
      for (let t = 0; t <= 20_000; t += 100) controller.update(t);
      const startX = cam.midPoint.x;
      // Hero walks far past the right edge. The goal shifts, and the camera
      // follows via the per-frame lerp — each step bounded, ending right of start.
      hero.x = 2700;
      let prevX = startX;
      let maxStep = 0;
      for (let t = 20_100; t <= 24_000; t += 100) {
        controller.update(t);
        maxStep = Math.max(maxStep, Math.abs(cam.midPoint.x - prevX));
        prevX = cam.midPoint.x;
      }
      expect(cam.midPoint.x).toBeGreaterThan(startX); // followed toward the hero
      expect(maxStep).toBeLessThan(120); // no single-frame jump (lerp-bounded)
    });
  });

  describe('holds the framing through a brief idle (ETC-50)', () => {
    it('keeps framing the last-active hero while idle, before idleOverviewMs elapses', () => {
      const cam = makeCamera();
      const controller = new AutoCameraController(cam, makeOptions(true));
      // A hero far outside the village makes the focus frame clearly distinct
      // from the village-only overview (wider box, lower zoom, shifted center).
      const hero = { x: 2700, y: 1600 };
      controller.setActiveTargets([hero]);
      for (let t = 0; t <= 20_000; t += 100) controller.update(t); // converge to focus
      const focusZoom = cam.zoom;
      const focusX = cam.midPoint.x;
      // Hero goes idle: the scene clears active targets. The timing machine keeps
      // the focus mode until idleOverviewMs (8000) elapses since the last active
      // tick (20000), so the camera should hold the framing, not drift to overview.
      controller.setActiveTargets([]);
      for (let t = 20_100; t <= 25_000; t += 100) controller.update(t); // 5s idle < 8s
      expect(Math.abs(cam.zoom - focusZoom)).toBeLessThan(0.02);
      expect(Math.abs(cam.midPoint.x - focusX)).toBeLessThan(30);
    });

    it('releases to the overview once idleOverviewMs has elapsed', () => {
      const cam = makeCamera();
      const controller = new AutoCameraController(cam, makeOptions(true));
      const hero = { x: 2700, y: 1600 };
      controller.setActiveTargets([hero]);
      for (let t = 0; t <= 20_000; t += 100) controller.update(t);
      const focusZoom = cam.zoom;
      // Idle long past idleOverviewMs (8000) after last active (20000): the mode
      // commits overview and the camera zooms in to the village-only frame.
      controller.setActiveTargets([]);
      for (let t = 20_100; t <= 40_000; t += 100) controller.update(t);
      expect(cam.zoom).toBeGreaterThan(focusZoom);
    });
  });
});
