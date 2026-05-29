import { SELECTED_HERO_DEPTH_BASE } from '../renderDepth';

export { SELECTED_HERO_DEPTH_BASE };

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
