/**
 * Pure camera-goal computation for the auto camera.
 *
 * Given the set of active agent positions and the current viewport, decides
 * where the camera should center and how far it should zoom. Knows nothing
 * about Phaser, HeroSprite, or the scene — this keeps the policy testable and
 * lets {@link AutoCameraController} stay a thin adapter that just applies the
 * result smoothly.
 */

export type AutoCameraMode = 'overview' | 'focus' | 'group';

/** A point the camera can target. HeroSprite satisfies this structurally via
 * its `x`/`y` getters, so the controller can pass live sprites and read their
 * moving positions each frame. */
export interface CameraTarget {
  readonly x: number;
  readonly y: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface AutoCameraConfig {
  /** World bounds — used to derive the minimum zoom (so the viewport never
   * shows past the tile grid) and to clamp the goal center. */
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** Village footprint used for the overview fit (matches VillageScene.fitCamera). */
  readonly villageWidth: number;
  readonly villageHeight: number;
  /** Overview center (world center). */
  readonly villageCenterX: number;
  readonly villageCenterY: number;
  /** Margin applied to the overview fit so the village doesn't touch the edges. */
  readonly overviewMargin: number;
  /** Margin applied to the group fit (smaller = more padding around the group). */
  readonly groupMargin: number;
  /** Zoom used when a single agent is focused. */
  readonly focusZoom: number;
  /** Upper zoom bound (matches the manual wheel/pinch cap). */
  readonly maxZoom: number;
  /** Minimum span of a group's bounding box, so a tight cluster of agents
   * doesn't zoom all the way in. */
  readonly minGroupWidth: number;
  readonly minGroupHeight: number;
}

export interface CameraGoal {
  readonly mode: AutoCameraMode;
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

/** Clamp a center coordinate to a range. When the world is smaller than the
 * viewport (lo > hi), fall back to the midpoint (world center). */
function clampCenterCoord(value: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(Math.max(value, lo), hi);
}

/** Clamp zoom to [min, max] with the same semantics as Phaser.Math.Clamp:
 * when min > max (viewport larger than the world, so fully covering it needs a
 * zoom above the max cap), min wins — keeping the world covered takes priority
 * over the max-zoom cap, matching VillageScene.fitCamera's existing behaviour. */
function clampZoom(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Lowest zoom that still fully covers the viewport with the world, so zooming
 * out never exposes the canvas background past the tile grid. */
function minZoomFor(viewport: Viewport, config: AutoCameraConfig): number {
  if (config.worldWidth <= 0 || config.worldHeight <= 0) return 0.35;
  return Math.max(viewport.width / config.worldWidth, viewport.height / config.worldHeight);
}

/** Keep the goal center such that the viewport (in world units) stays inside
 * the world bounds — mirrors Phaser's camera-bounds clamping so the pure goal
 * agrees with what the camera can actually show. */
function clampCenter(
  centerX: number,
  centerY: number,
  zoom: number,
  viewport: Viewport,
  config: AutoCameraConfig,
): { centerX: number; centerY: number } {
  const halfViewW = viewport.width / zoom / 2;
  const halfViewH = viewport.height / zoom / 2;
  return {
    centerX: clampCenterCoord(centerX, halfViewW, config.worldWidth - halfViewW),
    centerY: clampCenterCoord(centerY, halfViewH, config.worldHeight - halfViewH),
  };
}

/**
 * Compute the camera goal for a given mode and the active targets.
 *
 * The mode is decided upstream (by the timing state machine) so the goal stays
 * stable across debounce/idle transitions; this function just realises that
 * mode against the current target positions. When a mode and the targets
 * disagree (e.g. `focus` mode mid-transition with zero targets), it falls back
 * to the overview so the camera always has a sensible place to be.
 */
export function computeCameraGoal(
  mode: AutoCameraMode,
  targets: readonly CameraTarget[],
  viewport: Viewport,
  config: AutoCameraConfig,
): CameraGoal {
  const minZoom = minZoomFor(viewport, config);
  const fitZoomToBounds = (z: number): number => clampZoom(z, minZoom, config.maxZoom);

  const focusTarget = targets[0];
  if (mode === 'focus' && focusTarget !== undefined) {
    const zoom = fitZoomToBounds(config.focusZoom);
    const { centerX, centerY } = clampCenter(focusTarget.x, focusTarget.y, zoom, viewport, config);
    return { mode: 'focus', centerX, centerY, zoom };
  }

  if (mode === 'group' && targets.length >= 2) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const target of targets) {
      if (target.x < minX) minX = target.x;
      if (target.y < minY) minY = target.y;
      if (target.x > maxX) maxX = target.x;
      if (target.y > maxY) maxY = target.y;
    }
    const spanX = Math.max(maxX - minX, config.minGroupWidth);
    const spanY = Math.max(maxY - minY, config.minGroupHeight);
    const zoom = fitZoomToBounds(Math.min(viewport.width / spanX, viewport.height / spanY) * config.groupMargin);
    const { centerX, centerY } = clampCenter((minX + maxX) / 2, (minY + maxY) / 2, zoom, viewport, config);
    return { mode: 'group', centerX, centerY, zoom };
  }

  // Overview (also the fallback when a focus/group mode lacks enough targets).
  const fitZoom = Math.min(
    viewport.width / config.villageWidth,
    viewport.height / config.villageHeight,
  ) * config.overviewMargin;
  const zoom = fitZoomToBounds(fitZoom);
  const { centerX, centerY } = clampCenter(
    config.villageCenterX,
    config.villageCenterY,
    zoom,
    viewport,
    config,
  );
  return { mode: 'overview', centerX, centerY, zoom };
}

/**
 * Frame the whole village plus every hero so a single "fit to view" action
 * always shows the map and all characters at once. The village rectangle is
 * always part of the bounding box, so the framing stays stable even when every
 * hero is clustered together (or there are none) — heroes can only widen the
 * box, never shrink it below the village footprint. Pure — unit-testable.
 *
 * Reuses the same clamp/margin helpers as the auto-camera overview so the
 * manual fit and the automatic framing never drift apart. Returns the
 * `'overview'` mode since a fit is a village-framing goal; callers only consume
 * `centerX`/`centerY`/`zoom` (the mode is informational, not an auto-camera state).
 */
export function computeFitGoal(
  heroTargets: readonly CameraTarget[],
  viewport: Viewport,
  config: AutoCameraConfig,
): CameraGoal {
  const minZoom = minZoomFor(viewport, config);
  const halfWidth = config.villageWidth / 2;
  const halfHeight = config.villageHeight / 2;

  let minX = config.villageCenterX - halfWidth;
  let maxX = config.villageCenterX + halfWidth;
  let minY = config.villageCenterY - halfHeight;
  let maxY = config.villageCenterY + halfHeight;
  for (const target of heroTargets) {
    if (target.x < minX) minX = target.x;
    if (target.x > maxX) maxX = target.x;
    if (target.y < minY) minY = target.y;
    if (target.y > maxY) maxY = target.y;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const zoom = clampZoom(
    Math.min(viewport.width / spanX, viewport.height / spanY) * config.overviewMargin,
    minZoom,
    config.maxZoom,
  );
  const { centerX, centerY } = clampCenter((minX + maxX) / 2, (minY + maxY) / 2, zoom, viewport, config);
  return { mode: 'overview', centerX, centerY, zoom };
}
