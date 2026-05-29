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
  groupMargin: 0.8,
  focusZoom: 1.15,
  maxZoom: 1.5,
  minGroupWidth: 600,
  minGroupHeight: 400,
};

const timing: AutoCameraTiming = {
  manualResumeMs: 5000,
  idleOverviewMs: 8000,
  focusDebounceMs: 800,
};

function makeOptions(enabled: boolean, deadzoneRatio = 0): AutoCameraControllerOptions {
  return {
    config,
    timing,
    lerpFactor: 0.2,
    maxZoomDeltaPerFrame: 0.05,
    centerEpsilon: 1,
    zoomEpsilon: 0.005,
    deadzoneRatio,
    enabled,
  };
}

/** Run enough frames to commit a mode (past focusDebounceMs) and let the lerp
 * settle the camera, so deadzone tests start from a steady focused view. */
function settle(controller: AutoCameraController): void {
  for (let t = 0; t <= 20_000; t += 100) controller.update(t);
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
      this.zoom = z;
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

  it('converges the camera toward a single active target over time', () => {
    const cam = makeCamera();
    const controller = new AutoCameraController(cam, makeOptions(true));
    controller.setActiveTargets([{ x: 600, y: 1200 }]);
    // Run enough frames to commit focus (debounce) and converge via lerp.
    for (let t = 0; t <= 20_000; t += 100) {
      controller.update(t);
    }
    // Focus zoom is 1.15; center should have moved well away from the start
    // (1400,900) toward the clamped target.
    expect(cam.zoom).toBeCloseTo(1.15, 1);
    expect(cam.midPoint.x).toBeLessThan(1400);
    expect(cam.midPoint.y).toBeGreaterThan(900);
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

  describe('deadzone (issue #50)', () => {
    it('holds the center while a focused hero only jitters inside the box', () => {
      const cam = makeCamera();
      const controller = new AutoCameraController(cam, makeOptions(true, 0.7));
      controller.setActiveTargets([{ x: 1400, y: 900 }]); // starts at the camera center
      settle(controller);
      const cx = cam.midPoint.x;
      const cy = cam.midPoint.y;
      // Nudge the hero a little — still well inside the 70% follow box.
      controller.setActiveTargets([{ x: cx + 30, y: cy + 20 }]);
      controller.update(20_100);
      expect(cam.midPoint.x).toBe(cx);
      expect(cam.midPoint.y).toBe(cy);
    });

    it('reframes once a focused hero leaves the box', () => {
      const cam = makeCamera();
      const controller = new AutoCameraController(cam, makeOptions(true, 0.7));
      controller.setActiveTargets([{ x: 1400, y: 900 }]);
      settle(controller);
      const cx = cam.midPoint.x;
      // Half-box at zoom 1.15 is ~0.7 × (1280/1.15/2) ≈ 389 px; 600 is outside.
      controller.setActiveTargets([{ x: cx + 600, y: 900 }]);
      controller.update(20_100);
      expect(cam.midPoint.x).toBeGreaterThan(cx);
    });

    it('does not apply the deadzone in overview (no tracked target)', () => {
      const cam = makeCamera();
      cam._cx = 100; // off the overview center so a write is observable
      cam._cy = 100;
      const controller = new AutoCameraController(cam, makeOptions(true, 0.7));
      controller.setActiveTargets([]); // zero active → overview
      for (let t = 0; t <= 9000; t += 100) controller.update(t); // past idleOverviewMs
      // Overview reframes toward the village center regardless of the deadzone.
      expect(cam.midPoint.x).toBeGreaterThan(100);
      expect(cam.midPoint.y).toBeGreaterThan(100);
    });

    it('bypasses the deadzone on a mode change so a fresh framing is not suppressed', () => {
      const cam = makeCamera();
      const controller = new AutoCameraController(cam, makeOptions(true, 0.7));
      controller.setActiveTargets([{ x: 1400, y: 900 }]); // focus, settles at center
      settle(controller);
      const cx = cam.midPoint.x;
      // Two heroes spread apart → group. Their midpoint is the camera center, so
      // both sit inside the old focus box, yet the mode change must still reframe
      // (group zoom differs), proving the deadzone is bypassed on the first frame.
      const zoomBefore = cam.zoom;
      controller.setActiveTargets([{ x: 900, y: 600 }, { x: 1900, y: 1200 }]);
      for (let t = 20_100; t <= 21_000; t += 100) controller.update(t); // commit group
      expect(cam.zoom).not.toBe(zoomBefore);
      void cx;
    });
  });
});
