import { WORLD_HEIGHT } from './data/building-layout';

/**
 * Centralised render-depth bands. The hero-depth policy (heroDepth.ts) and the
 * scene's atmospheric overlays (VillageScene) share this one contract instead
 * of each hard-coding numbers, so the "selected hero sits above the crowd but
 * below the weather" invariant stays explicit and checkable.
 *
 * Layering, low → high:
 *   world objects   heroes & buildings sort by footY in [0, ~WORLD_HEIGHT]
 *   selected hero   lifted above the crowd, still below the overlays
 *   atmospheric     night dimmer + rain layers, on top of everything
 */

/** Base depth for the selected (followed) hero — above world objects, below overlays. */
export const SELECTED_HERO_DEPTH_BASE = WORLD_HEIGHT + 1000;

/** Rain darken plate — lowest of the atmospheric overlays. */
export const RAIN_DARKEN_DEPTH = 4997;
/** Night dimmer overlay. */
export const NIGHT_OVERLAY_DEPTH = 5000;
/** Rain splash particles (ground impacts). */
export const RAIN_SPLASH_DEPTH = 5000;
/** Falling rain particles — top of the stack. */
export const RAIN_EMITTER_DEPTH = 5001;
