/**
 * Pure timing state machine for the auto camera.
 *
 * Decides which {@link AutoCameraMode} the camera should be in, given how many
 * agents are active and the current time. Implements the issue #38 timing
 * rules:
 *   - manual interaction pauses the auto camera for a while, then it resumes
 *   - a single active agent → `focus` (after a short debounce)
 *   - two or more active agents → `group`
 *   - zero active agents → stay put until an idle timeout, then `overview`
 *
 * Kept free of Phaser/time-source dependencies (the caller supplies `now`) so
 * the most fragile part of the feature — the timing — is unit-testable.
 */

import type { AutoCameraMode } from './autoCameraPlanning';

export interface AutoCameraTiming {
  /** How long manual zoom/pan pauses the auto camera before it resumes. */
  readonly manualResumeMs: number;
  /** How long after the last active agent the camera returns to overview. */
  readonly idleOverviewMs: number;
  /** How long a desired mode must hold before it's committed (anti-jitter). */
  readonly focusDebounceMs: number;
}

export interface AutoCameraState {
  readonly enabled: boolean;
  /** Timestamp of the last manual interaction; -Infinity means "never". */
  readonly lastManualMs: number;
  /** Timestamp when an agent was last active; -Infinity means "never". */
  readonly lastActiveMs: number;
  /** Currently committed mode (what the camera is actually doing). */
  readonly mode: AutoCameraMode;
  /** A mode waiting to be committed once it holds for `focusDebounceMs`. */
  readonly pendingMode: AutoCameraMode | null;
  /** When `pendingMode` was first requested. */
  readonly pendingSinceMs: number;
}

export interface AutoCameraStep {
  readonly state: AutoCameraState;
  /** True when the auto camera should not move this tick (disabled or paused
   * by a recent manual interaction). */
  readonly paused: boolean;
  /** The mode to realise this tick (the committed mode). */
  readonly mode: AutoCameraMode;
}

export function createInitialState(enabled: boolean): AutoCameraState {
  return {
    enabled,
    lastManualMs: -Infinity,
    lastActiveMs: -Infinity,
    mode: 'overview',
    pendingMode: null,
    pendingSinceMs: -Infinity,
  };
}

/** Map the active-agent count to the mode the camera should head toward. While
 * no agents are active, the camera holds its current mode until the idle
 * timeout elapses, then heads to overview. */
function desiredMode(
  state: AutoCameraState,
  activeCount: number,
  lastActiveMs: number,
  now: number,
  timing: AutoCameraTiming,
): AutoCameraMode {
  if (activeCount >= 2) return 'group';
  if (activeCount === 1) return 'focus';
  return now - lastActiveMs >= timing.idleOverviewMs ? 'overview' : state.mode;
}

/**
 * Advance the state machine one tick. Pure: same inputs → same output.
 *
 * @param activeCount number of agents currently active (status === 'active')
 * @param now current time in ms (Phaser scene time or Date.now())
 */
export function stepAutoCameraState(
  state: AutoCameraState,
  activeCount: number,
  now: number,
  timing: AutoCameraTiming,
): AutoCameraStep {
  // Track liveness even while paused/disabled, so the idle timer is accurate
  // the moment the auto camera resumes.
  const lastActiveMs = activeCount > 0 ? now : state.lastActiveMs;

  const paused = now - state.lastManualMs < timing.manualResumeMs;
  if (!state.enabled || paused) {
    return {
      state: { ...state, lastActiveMs },
      paused: true,
      mode: state.mode,
    };
  }

  const desired = desiredMode(state, activeCount, lastActiveMs, now, timing);

  // Debounce mode changes: a new desired mode must hold for focusDebounceMs
  // before it's committed, so a flickering active set doesn't whip the camera.
  let mode = state.mode;
  let pendingMode = state.pendingMode;
  let pendingSinceMs = state.pendingSinceMs;

  if (desired === mode) {
    pendingMode = null;
    pendingSinceMs = -Infinity;
  } else if (pendingMode !== desired) {
    pendingMode = desired;
    pendingSinceMs = now;
  } else if (now - pendingSinceMs >= timing.focusDebounceMs) {
    mode = desired;
    pendingMode = null;
    pendingSinceMs = -Infinity;
  }

  return {
    state: { ...state, lastActiveMs, mode, pendingMode, pendingSinceMs },
    paused: false,
    mode,
  };
}
