import { WORLD_HEIGHT } from '../data/building-layout';

/**
 * Depth offsets for a hero's sprite and its labels, applied on top of a layer
 * base. These mirror the original footY-based ordering so heroes and their
 * speech bubbles keep their relative stacking (halo behind sprite, labels in
 * front, index marker on top).
 */
const DEPTH_OFFSETS = {
  halo: 0.4,
  sprite: 0.5,
  bubbleBg: 1.0,
  nameText: 1.1,
  taskText: 1.1,
  activityMsgText: 1.1,
  indexText: 1.2,
} as const;

/**
 * Base depth for the currently selected (followed) hero. It lifts the hero
 * above every other world object — heroes and buildings sort by footY, whose
 * max is roughly WORLD_HEIGHT plus a sprite half-height — while staying *below*
 * the atmospheric overlays (night 5000, rain 4997–5001). The selected hero
 * should read as "front of the crowd", not "above the weather".
 */
export const SELECTED_HERO_DEPTH_BASE = WORLD_HEIGHT + 1000;

export interface HeroDepths {
  sprite: number;
  halo: number;
  bubbleBg: number;
  nameText: number;
  taskText: number;
  activityMsgText: number;
  indexText: number;
}

/**
 * Resolve the depth for a hero's sprite and labels.
 *
 * @param footY    World foot-y of the hero (`y + spriteDisplayHeight * 0.5`).
 * @param selected Whether the hero is the selected/followed one. Selected
 *                 heroes use a fixed base above the crowd; others sort by footY.
 */
export function computeHeroDepths(footY: number, selected: boolean): HeroDepths {
  const base = selected ? SELECTED_HERO_DEPTH_BASE : footY;
  return {
    halo: base + DEPTH_OFFSETS.halo,
    sprite: base + DEPTH_OFFSETS.sprite,
    bubbleBg: base + DEPTH_OFFSETS.bubbleBg,
    nameText: base + DEPTH_OFFSETS.nameText,
    taskText: base + DEPTH_OFFSETS.taskText,
    activityMsgText: base + DEPTH_OFFSETS.activityMsgText,
    indexText: base + DEPTH_OFFSETS.indexText,
  };
}
