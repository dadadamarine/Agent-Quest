import { describe, expect, test } from 'bun:test';
import { computeHeroDepths, SELECTED_HERO_DEPTH_BASE } from './heroDepth';
import { WORLD_HEIGHT } from '../data/building-layout';

// Night/rain atmospheric overlays live at depth 4997–5001 in VillageScene. The
// selected hero must read as "front of the crowd", never "above the weather".
const ATMOSPHERIC_OVERLAY_DEPTH = 4997;

describe('computeHeroDepths', () => {
  test('unselected depths track footY with the documented offsets', () => {
    const d = computeHeroDepths(500, false);
    expect(d.halo).toBe(500.4);
    expect(d.sprite).toBe(500.5);
    expect(d.bubbleBg).toBe(501.0);
    expect(d.nameText).toBe(501.1);
    expect(d.taskText).toBe(501.1);
    expect(d.activityMsgText).toBe(501.1);
    expect(d.indexText).toBe(501.2);
  });

  test('render order is preserved: halo < sprite < bubble < labels < index', () => {
    const d = computeHeroDepths(500, false);
    expect(d.halo).toBeLessThan(d.sprite);
    expect(d.sprite).toBeLessThan(d.bubbleBg);
    expect(d.bubbleBg).toBeLessThan(d.nameText);
    expect(d.nameText).toBeLessThanOrEqual(d.taskText);
    expect(d.taskText).toBeLessThanOrEqual(d.activityMsgText);
    expect(d.activityMsgText).toBeLessThan(d.indexText);
  });

  test('selected hero is lifted above any unselected hero at the bottom of the world', () => {
    // Largest plausible unselected footY: world floor plus a generous sprite half-height.
    const lowestUnselected = computeHeroDepths(WORLD_HEIGHT + 400, false);
    const selected = computeHeroDepths(0, true);
    expect(selected.halo).toBeGreaterThan(lowestUnselected.indexText);
  });

  test('selected hero stays below atmospheric overlays (night/rain)', () => {
    const selected = computeHeroDepths(WORLD_HEIGHT, true);
    expect(selected.indexText).toBeLessThan(ATMOSPHERIC_OVERLAY_DEPTH);
  });

  test('selected base ignores footY so it is stable regardless of position', () => {
    const a = computeHeroDepths(0, true);
    const b = computeHeroDepths(WORLD_HEIGHT, true);
    expect(a.sprite).toBe(b.sprite);
    expect(a.sprite).toBe(SELECTED_HERO_DEPTH_BASE + 0.5);
  });

  test('selected base preserves the same offset ordering', () => {
    const d = computeHeroDepths(123, true);
    expect(d.halo).toBeLessThan(d.sprite);
    expect(d.sprite).toBeLessThan(d.bubbleBg);
    expect(d.bubbleBg).toBeLessThan(d.indexText);
  });
});
