import { describe, it, expect } from 'bun:test';
import {
  computeCameraGoal,
  isWithinDeadzone,
  type AutoCameraConfig,
  type CameraTarget,
  type Viewport,
} from './autoCameraPlanning';

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

// Viewport smaller than the world so minZoom < 1 and clamps don't dominate.
const viewport: Viewport = { width: 1280, height: 800 };

describe('computeCameraGoal', () => {
  it('returns overview centered on the village with the fit zoom when no targets', () => {
    const goal = computeCameraGoal('overview', [], viewport, config);
    expect(goal.mode).toBe('overview');
    expect(goal.centerX).toBe(1400);
    expect(goal.centerY).toBe(900);
    // fit = min(1280/1100, 800/700) * 0.85 = min(1.163, 1.143) * 0.85 ≈ 0.971
    expect(goal.zoom).toBeCloseTo(0.971, 2);
  });

  it('focuses a single target at the configured focus zoom', () => {
    const goal = computeCameraGoal('focus', [{ x: 1000, y: 600 }], viewport, config);
    expect(goal.mode).toBe('focus');
    expect(goal.centerX).toBe(1000);
    expect(goal.centerY).toBe(600);
    expect(goal.zoom).toBe(1.15);
  });

  it('fits the bounding box of multiple targets in group mode', () => {
    const goal = computeCameraGoal(
      'group',
      [{ x: 800, y: 500 }, { x: 1600, y: 1100 }],
      viewport,
      config,
    );
    expect(goal.mode).toBe('group');
    expect(goal.centerX).toBe(1200);
    expect(goal.centerY).toBe(800);
    // spanX = 800, spanY = 600 → min(1280/800, 800/600)*0.8 = min(1.6,1.333)*0.8 ≈ 1.067
    expect(goal.zoom).toBeCloseTo(1.067, 2);
  });

  it('expands a tight group cluster to the minimum span so it does not over-zoom', () => {
    // Two nearly coincident targets — bbox span would be ~0 without the floor.
    const goal = computeCameraGoal(
      'group',
      [{ x: 1400, y: 900 }, { x: 1410, y: 905 }],
      viewport,
      config,
    );
    // span floored to 600x400 → min(1280/600, 800/400)*0.8 = min(2.133,2.0)*0.8 = 1.6 → clamped to maxZoom 1.5
    expect(goal.zoom).toBe(1.5);
    expect(goal.centerX).toBe(1405);
    expect(goal.centerY).toBeCloseTo(902.5, 1);
  });

  it('clamps zoom to maxZoom for a single focus that would exceed it', () => {
    const tight: AutoCameraConfig = { ...config, focusZoom: 2.0 };
    const goal = computeCameraGoal('focus', [{ x: 1400, y: 900 }], viewport, tight);
    expect(goal.zoom).toBe(1.5);
  });

  it('never zooms out past the world-cover minimum', () => {
    // A viewport larger than the world forces minZoom > the fit zoom.
    const bigView: Viewport = { width: 5600, height: 3600 };
    const goal = computeCameraGoal('overview', [], bigView, config);
    // minZoom = max(5600/2800, 3600/1800) = 2.0, so overview clamps up to 2.0.
    expect(goal.zoom).toBe(2.0);
  });

  it('clamps the focus center so the viewport stays inside world bounds', () => {
    // Target near the world edge; center should pull in by half the view span.
    const goal = computeCameraGoal('focus', [{ x: 0, y: 0 }], viewport, config);
    const halfViewW = viewport.width / goal.zoom / 2; // 1280/1.15/2 ≈ 556.5
    const halfViewH = viewport.height / goal.zoom / 2; // 800/1.15/2 ≈ 347.8
    expect(goal.centerX).toBeCloseTo(halfViewW, 1);
    expect(goal.centerY).toBeCloseTo(halfViewH, 1);
  });

  it('falls back to overview when focus mode has no targets', () => {
    const goal = computeCameraGoal('focus', [], viewport, config);
    expect(goal.mode).toBe('overview');
    expect(goal.centerX).toBe(1400);
  });

  it('falls back to overview when group mode has fewer than two targets', () => {
    const goal = computeCameraGoal('group', [{ x: 1000, y: 600 }], viewport, config);
    expect(goal.mode).toBe('overview');
  });
});

describe('isWithinDeadzone', () => {
  // Deadzone box is centred on `center`, sized to ratio × the on-screen world
  // extent (viewport / zoom). With viewport 1280×800, zoom 1, ratio 0.5 the
  // half-extents are 0.5 × (1280/1 / 2) = 320 in x and 0.5 × (800/1 / 2) = 200 in y.
  const center = { x: 1000, y: 600 };

  it('returns false when there are no targets (nothing to hold for)', () => {
    expect(isWithinDeadzone([], viewport, center, 1, 0.5)).toBe(false);
  });

  it('returns true when every target sits inside the deadzone box', () => {
    const targets: CameraTarget[] = [
      { x: 1000, y: 600 },
      { x: 1200, y: 700 },
      { x: 800, y: 500 },
    ];
    expect(isWithinDeadzone(targets, viewport, center, 1, 0.5)).toBe(true);
  });

  it('returns false when a target is outside the box on the x axis', () => {
    // halfW = 320 → x must stay within [680, 1320]. 1400 is outside.
    expect(isWithinDeadzone([{ x: 1400, y: 600 }], viewport, center, 1, 0.5)).toBe(false);
  });

  it('returns false when a target is outside the box on the y axis', () => {
    // halfH = 200 → y must stay within [400, 800]. 810 is outside.
    expect(isWithinDeadzone([{ x: 1000, y: 810 }], viewport, center, 1, 0.5)).toBe(false);
  });

  it('treats a target exactly on the boundary as inside', () => {
    // x = 1320 (= center + halfW), y = 800 (= center + halfH).
    expect(isWithinDeadzone([{ x: 1320, y: 800 }], viewport, center, 1, 0.5)).toBe(true);
  });

  it('shrinks the box as the camera zooms in (smaller on-screen world extent)', () => {
    // At zoom 2 the on-screen world extent halves: halfW = 0.5 × (1280/2 / 2) = 160.
    // x = 1200 is +200 from center → now outside, though it was inside at zoom 1.
    expect(isWithinDeadzone([{ x: 1200, y: 600 }], viewport, center, 1, 0.5)).toBe(true);
    expect(isWithinDeadzone([{ x: 1200, y: 600 }], viewport, center, 2, 0.5)).toBe(false);
  });

  it('shrinks the box as the ratio decreases (tighter follow box)', () => {
    // ratio 0.5 → halfW 320 (x=1300 inside); ratio 0.2 → halfW 128 (x=1300 outside).
    expect(isWithinDeadzone([{ x: 1300, y: 600 }], viewport, center, 1, 0.5)).toBe(true);
    expect(isWithinDeadzone([{ x: 1300, y: 600 }], viewport, center, 1, 0.2)).toBe(false);
  });
});
