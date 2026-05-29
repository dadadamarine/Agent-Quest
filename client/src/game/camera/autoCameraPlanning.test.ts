import { describe, it, expect } from 'bun:test';
import {
  computeCameraGoal,
  computeFitGoal,
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

describe('computeFitGoal', () => {
  // Village rectangle: center (1400, 900), half (550, 350) → corners (850,550)–(1950,1250).

  it('frames the village exactly like the overview when there are no heroes', () => {
    const goal = computeFitGoal([], viewport, config);
    expect(goal.centerX).toBe(1400);
    expect(goal.centerY).toBe(900);
    // Same fit math as the overview: min(1280/1100, 800/700) * 0.85 ≈ 0.971.
    expect(goal.zoom).toBeCloseTo(0.971, 2);
    // Identical to the auto-camera overview so the two never drift apart.
    const overview = computeCameraGoal('overview', [], viewport, config);
    expect(goal.zoom).toBeCloseTo(overview.zoom, 5);
    expect(goal.centerX).toBe(overview.centerX);
    expect(goal.centerY).toBe(overview.centerY);
  });

  it('keeps the village framing when every hero is already inside the village', () => {
    const insideHeroes: CameraTarget[] = [
      { x: 1000, y: 700 },
      { x: 1600, y: 1000 },
    ];
    const goal = computeFitGoal(insideHeroes, viewport, config);
    // Heroes are within the village rect, so the bounding box is unchanged.
    expect(goal.centerX).toBe(1400);
    expect(goal.centerY).toBe(900);
    expect(goal.zoom).toBeCloseTo(0.971, 2);
  });

  it('widens the bounding box and zooms out when heroes are outside the village', () => {
    // Heroes far left/right of the village push minX/maxX past the rect corners.
    const goal = computeFitGoal([{ x: 300, y: 900 }, { x: 2500, y: 900 }], viewport, config);
    // bbox X: 300–2500 (span 2200), Y: 550–1250 (village rect, span 700).
    expect(goal.centerX).toBe(1400);
    expect(goal.centerY).toBe(900);
    // min(1280/2200, 800/700) * 0.85 = 0.581818 * 0.85 ≈ 0.4945.
    expect(goal.zoom).toBeCloseTo(0.4945, 3);
  });

  it('clamps the center to world bounds when a lone hero sits near a corner', () => {
    const goal = computeFitGoal([{ x: 2700, y: 1600 }], viewport, config);
    // bbox X: 850–2700 (span 1850), Y: 550–1600 (span 1050).
    // zoom = min(1280/1850, 800/1050) * 0.85 = 0.691892 * 0.85 ≈ 0.5881.
    expect(goal.zoom).toBeCloseTo(0.5881, 3);
    // Raw center (1775, 1075); centerX clamps so the viewport stays inside the world.
    const halfViewW = viewport.width / (2 * goal.zoom);
    expect(goal.centerX).toBeCloseTo(config.worldWidth - halfViewW, 1);
    expect(goal.centerY).toBeCloseTo(1075, 1);
  });

  it('clamps zoom to maxZoom for a large viewport', () => {
    const bigView: Viewport = { width: 3000, height: 2000 };
    const goal = computeFitGoal([], bigView, config);
    // Raw fit would exceed maxZoom; it must clamp to 1.5.
    expect(goal.zoom).toBe(1.5);
  });

  it('clamps zoom to minZoom when heroes span the whole world', () => {
    const goal = computeFitGoal([{ x: 0, y: 0 }, { x: 2800, y: 1800 }], viewport, config);
    // bbox spans the world; raw fit drops below minZoom and must clamp up.
    const minZoom = Math.max(viewport.width / config.worldWidth, viewport.height / config.worldHeight);
    expect(goal.zoom).toBeCloseTo(minZoom, 5);
  });

  it('reports overview mode so the scene treats it as a framing goal', () => {
    const goal = computeFitGoal([{ x: 1000, y: 700 }], viewport, config);
    expect(goal.mode).toBe('overview');
  });
});
