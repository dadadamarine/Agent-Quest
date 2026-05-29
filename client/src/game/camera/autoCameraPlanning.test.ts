import { describe, it, expect } from 'bun:test';
import {
  computeCameraGoal,
  type AutoCameraConfig,
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
  maxZoom: 1.5,
};

// Viewport smaller than the world so minZoom < 1 and clamps don't dominate.
const viewport: Viewport = { width: 1280, height: 800 };

// Village rectangle: center (1400, 900), half (550, 350) → corners (850,550)–(1950,1250).

describe('computeCameraGoal', () => {
  it('frames the village when there are no targets (overview)', () => {
    const goal = computeCameraGoal('overview', [], viewport, config);
    expect(goal.mode).toBe('overview');
    expect(goal.centerX).toBe(1400);
    expect(goal.centerY).toBe(900);
    // fit = min(1280/1100, 800/700) * 0.85 = min(1.163, 1.143) * 0.85 ≈ 0.971
    expect(goal.zoom).toBeCloseTo(0.971, 2);
  });

  it('keeps the village framing in focus when the hero is inside the village', () => {
    const goal = computeCameraGoal('focus', [{ x: 1000, y: 600 }], viewport, config);
    expect(goal.mode).toBe('focus');
    // Hero is within the village rect, so the bounding box is unchanged.
    expect(goal.centerX).toBe(1400);
    expect(goal.centerY).toBe(900);
    expect(goal.zoom).toBeCloseTo(0.971, 2);
  });

  it('widens the box and zooms out in focus when the hero roams past the village', () => {
    const goal = computeCameraGoal('focus', [{ x: 2700, y: 1600 }], viewport, config);
    expect(goal.mode).toBe('focus');
    // bbox X: 850–2700 (span 1850), Y: 550–1600 (span 1050).
    // zoom = min(1280/1850, 800/1050) * 0.85 = 0.691892 * 0.85 ≈ 0.5881.
    expect(goal.zoom).toBeCloseTo(0.5881, 3);
    // Raw center (1775, 1075); centerX clamps so the viewport stays inside the world.
    const halfViewW = viewport.width / goal.zoom / 2;
    expect(goal.centerX).toBeCloseTo(config.worldWidth - halfViewW, 1);
    expect(goal.centerY).toBeCloseTo(1075, 1);
  });

  it('frames the village plus the whole group in group mode', () => {
    const goal = computeCameraGoal(
      'group',
      [{ x: 800, y: 500 }, { x: 1600, y: 1100 }],
      viewport,
      config,
    );
    expect(goal.mode).toBe('group');
    // bbox: village (850,550)-(1950,1250) ∪ targets → (800,500)-(1950,1250). span 1150×750.
    // center ((800+1950)/2, (500+1250)/2) = (1375, 875).
    expect(goal.centerX).toBe(1375);
    expect(goal.centerY).toBe(875);
    // min(1280/1150, 800/750) * 0.85 = 1.06667 * 0.85 ≈ 0.9067.
    expect(goal.zoom).toBeCloseTo(0.9067, 3);
  });

  it('keeps the village framing in group when both heroes are inside it', () => {
    const goal = computeCameraGoal(
      'group',
      [{ x: 1200, y: 800 }, { x: 1500, y: 1000 }],
      viewport,
      config,
    );
    expect(goal.mode).toBe('group');
    // Both inside the village rect → bbox unchanged from the village.
    expect(goal.centerX).toBe(1400);
    expect(goal.centerY).toBe(900);
    expect(goal.zoom).toBeCloseTo(0.971, 2);
  });

  it('never zooms out past the world-cover minimum', () => {
    // A viewport larger than the world forces minZoom > the fit zoom.
    const bigView: Viewport = { width: 5600, height: 3600 };
    const goal = computeCameraGoal('overview', [], bigView, config);
    // minZoom = max(5600/2800, 3600/1800) = 2.0, so the fit clamps up to 2.0.
    expect(goal.zoom).toBe(2.0);
  });

  it('falls back to overview when focus mode has no targets', () => {
    const goal = computeCameraGoal('focus', [], viewport, config);
    expect(goal.mode).toBe('overview');
    expect(goal.centerX).toBe(1400);
    expect(goal.zoom).toBeCloseTo(0.971, 2);
  });

  it('falls back to overview when group mode has fewer than two targets', () => {
    const goal = computeCameraGoal('group', [{ x: 1000, y: 600 }], viewport, config);
    expect(goal.mode).toBe('overview');
    expect(goal.centerX).toBe(1400);
  });

  it('zooms out monotonically as a hero walks farther past the village edge', () => {
    // The goal must change continuously (no jump) so the controller's per-frame
    // lerp/zoom-clamp can follow smoothly — each step out widens the box and
    // lowers the zoom, never the reverse.
    const zoomAt = (x: number) =>
      computeCameraGoal('focus', [{ x, y: 900 }], viewport, config).zoom;
    const zoomEdge = zoomAt(1950); // village right edge — box == village
    const zoomMid = zoomAt(2200);
    const zoomFar = zoomAt(2500);
    expect(zoomEdge).toBeCloseTo(0.971, 2);
    expect(zoomMid).toBeLessThan(zoomEdge);
    expect(zoomFar).toBeLessThan(zoomMid);
  });
});
