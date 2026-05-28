/**
 * Visual scale rules for hero sprites. Pure functions — no Phaser dependency
 * so unit tests can pin the visual contract without spinning up a scene.
 */

/**
 * Multiplicative scale applied to a sub-agent sprite relative to a regular
 * hero. 0.6 reads clearly as "companion / helper" — smaller than a full
 * session — while staying legible.
 */
export const SUBAGENT_SCALE_FACTOR = 0.6;

/**
 * Effective sprite scale for a hero, given the theme's base hero scale and
 * whether the hero is a sub-agent. Main session: returns `baseScale`.
 * Sub-agent: returns `baseScale * SUBAGENT_SCALE_FACTOR`.
 */
export function computeSpriteScale(baseScale: number, isSubagent: boolean): number {
  return isSubagent ? baseScale * SUBAGENT_SCALE_FACTOR : baseScale;
}
