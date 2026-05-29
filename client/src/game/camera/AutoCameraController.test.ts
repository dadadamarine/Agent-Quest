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
});
