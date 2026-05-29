/**
 * Auto-camera controller — the single owner of camera writes while enabled.
 *
 * Combines the pure {@link stepAutoCameraState} timing machine and the pure
 * {@link computeCameraGoal} planner, then applies the resulting goal to the
 * camera by smoothly interpolating center and zoom each frame (rather than
 * firing pan/zoomTo tweens, which would fight each other when the target keeps
 * moving). Manual zoom/pan and Activity-Feed follow pause it via
 * {@link notifyManualInteraction}; while disabled it touches nothing, leaving
 * the camera to the scene's fit/center logic.
 */

import {
  computeCameraGoal,
  type AutoCameraConfig,
  type CameraTarget,
} from './autoCameraPlanning';
import {
  createInitialState,
  stepAutoCameraState,
  type AutoCameraState,
  type AutoCameraTiming,
} from './autoCameraState';

/** The slice of a Phaser camera the controller needs. Narrowed to an interface
 * so the controller can be unit-tested with a plain mock. `midPoint` is the
 * camera's current world-space center (Phaser derives it from scroll+zoom), so
 * interpolation always starts from where the camera actually is — including
 * after the user manually panned during the pause. */
export interface ControllableCamera {
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  readonly midPoint: { readonly x: number; readonly y: number };
  centerOn(x: number, y: number): void;
  setZoom(zoom: number): void;
}

export interface AutoCameraControllerOptions {
  readonly config: AutoCameraConfig;
  readonly timing: AutoCameraTiming;
  /** Smoothing factor per frame for center+zoom (0–1). Smaller = gentler. */
  readonly lerpFactor: number;
  /** Max absolute zoom change per frame, to keep zoom transitions calm. */
  readonly maxZoomDeltaPerFrame: number;
  /** Snap (skip interpolation) once center/zoom are within these epsilons. */
  readonly centerEpsilon: number;
  readonly zoomEpsilon: number;
  readonly enabled: boolean;
}

export class AutoCameraController {
  private readonly camera: ControllableCamera;
  private readonly options: AutoCameraControllerOptions;
  private state: AutoCameraState;
  private targets: readonly CameraTarget[] = [];

  constructor(camera: ControllableCamera, options: AutoCameraControllerOptions) {
    this.camera = camera;
    this.options = options;
    this.state = createInitialState(options.enabled);
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.state = { ...this.state, enabled };
  }

  /** Active heroes to track. Pass live HeroSprite refs (they satisfy
   * CameraTarget via x/y getters) so moving agents are followed each frame. */
  setActiveTargets(targets: readonly CameraTarget[]): void {
    this.targets = targets;
  }

  /** Called on manual zoom/pan/drag (and Activity-Feed follow) to pause the
   * auto camera so the user stays in control for a while. */
  notifyManualInteraction(now: number): void {
    this.state = { ...this.state, lastManualMs: now };
  }

  /** Advance one frame. No-op (no camera writes) while disabled or paused.
   *
   * The goal frames the village plus the active heroes (see computeCameraGoal),
   * so it stays stable while heroes move inside the village and only shifts when
   * they roam past its edge. That makes a plain per-frame lerp toward the goal
   * smooth on its own — no deadzone hold/reframe split, which is what made the
   * camera feel like it lurched (issue #52). */
  update(now: number): void {
    const step = stepAutoCameraState(this.state, this.targets.length, now, this.options.timing);
    this.state = step.state;
    if (step.paused) return;

    const viewport = { width: this.camera.width, height: this.camera.height };
    const goal = computeCameraGoal(step.mode, this.targets, viewport, this.options.config);

    // Zoom first, then center — centerOn computes scroll against the new zoom.
    this.camera.setZoom(this.nextZoom(goal.zoom));
    const { x, y } = this.nextCenter(goal.centerX, goal.centerY);
    this.camera.centerOn(x, y);
  }

  private nextZoom(goalZoom: number): number {
    const current = this.camera.zoom;
    if (Math.abs(goalZoom - current) <= this.options.zoomEpsilon) return goalZoom;
    let next = current + (goalZoom - current) * this.options.lerpFactor;
    const delta = next - current;
    if (Math.abs(delta) > this.options.maxZoomDeltaPerFrame) {
      next = current + Math.sign(delta) * this.options.maxZoomDeltaPerFrame;
    }
    return next;
  }

  private nextCenter(goalX: number, goalY: number): { x: number; y: number } {
    const from = this.camera.midPoint;
    if (Math.hypot(goalX - from.x, goalY - from.y) <= this.options.centerEpsilon) {
      return { x: goalX, y: goalY };
    }
    const lerp = this.options.lerpFactor;
    return {
      x: from.x + (goalX - from.x) * lerp,
      y: from.y + (goalY - from.y) * lerp,
    };
  }

  destroy(): void {
    this.targets = [];
  }
}
