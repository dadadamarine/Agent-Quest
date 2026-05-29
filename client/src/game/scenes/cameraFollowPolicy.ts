/**
 * Camera ownership policy for hero follow mode.
 *
 * Three actors can write the camera in VillageScene: the AutoCameraController
 * (auto framing), Phaser's built-in follow (selected-hero tracking), and manual
 * drag. They are mutually exclusive — only one owns the camera at a time. This
 * pure reducer encodes the AUTO ↔ FOLLOW ↔ MANUAL transitions so they can be
 * unit-tested without a live scene. VillageScene is the Humble Object that
 * applies the returned {@link CameraFollowEffect} to the real Phaser camera and
 * AutoCameraController.
 *
 * Key invariant (issue #44): while following, auto-cam is forced off. The
 * user's auto-cam preference is tracked separately (`userAutoCamEnabled`) and
 * restored on exit, so a TopBar toggle made *during* follow is honoured instead
 * of being overwritten by a stale snapshot taken at follow entry.
 */

export interface CameraFollowState {
  /** Hero currently followed by the camera, or null when not following. */
  followedHeroId: string | null;
  /** Latest user intent for the auto-camera (mirrors the TopBar toggle). */
  userAutoCamEnabled: boolean;
}

export interface CameraFollowEffect {
  /** When non-null, the scene should call `cam.startFollow` on this hero. */
  startFollowHeroId: string | null;
  /** When true, the scene should call `cam.stopFollow`. */
  stopFollow: boolean;
  /** Value the scene should pass to `autoCam.setEnabled`. */
  autoCamEnabled: boolean;
}

interface Transition {
  state: CameraFollowState;
  effect: CameraFollowEffect;
}

function enter(state: CameraFollowState, heroId: string): Transition {
  return {
    state: { ...state, followedHeroId: heroId },
    effect: { startFollowHeroId: heroId, stopFollow: false, autoCamEnabled: false },
  };
}

function exit(state: CameraFollowState): Transition {
  return {
    state: { ...state, followedHeroId: null },
    effect: { startFollowHeroId: null, stopFollow: true, autoCamEnabled: state.userAutoCamEnabled },
  };
}

function noChange(state: CameraFollowState): Transition {
  // While following, the camera stays owned by Phaser follow (auto-cam off);
  // otherwise the auto-cam reflects the user's latest preference.
  const autoCamEnabled = state.followedHeroId !== null ? false : state.userAutoCamEnabled;
  return {
    state,
    effect: { startFollowHeroId: null, stopFollow: false, autoCamEnabled },
  };
}

/**
 * Selection changed. Enter follow when a hero that exists in the scene is
 * selected; otherwise (deselected, or selected id not present yet) fail closed
 * by exiting follow so the camera never tracks a stale or missing target.
 */
export function reduceSelection(
  state: CameraFollowState,
  selectedId: string | null,
  heroExists: boolean,
): Transition {
  if (selectedId !== null && heroExists) return enter(state, selectedId);
  return exit(state);
}

/** Manual camera drag — a deliberate take-over that releases follow. */
export function reduceManualDrag(state: CameraFollowState): Transition {
  if (state.followedHeroId === null) return noChange(state);
  return exit(state);
}

/**
 * TopBar auto-camera toggle. Always records the user's latest intent. While
 * following, that intent is only remembered (auto-cam stays off so it does not
 * fight the follow); when not following it applies immediately.
 */
export function reduceAutoCamToggle(state: CameraFollowState, on: boolean): Transition {
  const next: CameraFollowState = { ...state, userAutoCamEnabled: on };
  return noChange(next);
}

/** A hero was removed from the scene. Exit follow if it was the followed one. */
export function reduceHeroRemoved(state: CameraFollowState, removedId: string): Transition {
  if (state.followedHeroId !== removedId) return noChange(state);
  return exit(state);
}
