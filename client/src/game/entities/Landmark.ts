import * as Phaser from 'phaser';
import type { LandmarkDef } from '../data/building-layout';
import { addCrispText } from '../text';
import { getActiveTheme } from '../themes/registry';

/**
 * A fixed, non-interactive structure that exists for meaning rather than
 * activity routing — currently the C-LEVEL Council. Unlike {@link Building} it
 * has no activity label; instead it shows its category name and one marker per
 * reserved seat. Heroes never walk here, so no `building:clicked` event is
 * emitted (the info panel resolves activity buildings only).
 */
export class Landmark {
  readonly def: LandmarkDef;
  readonly image: Phaser.GameObjects.Image;
  readonly label: Phaser.GameObjects.Text;
  readonly seatLabels: Phaser.GameObjects.Text[] = [];

  constructor(scene: Phaser.Scene, def: LandmarkDef) {
    this.def = def;

    this.image = scene.add.image(def.x, def.y, def.imageKey);
    this.image.setOrigin(0.5, 1); // bottom-center — matches building coordinate system
    const themeScale = getActiveTheme().getBuildingScale?.(def.id);
    this.image.setScale(themeScale ?? def.scale);

    // Hover affordance only — no click target, since landmarks have no
    // activity-building info panel to open.
    this.image.setInteractive({ useHandCursor: false });
    this.image.on('pointerover', () => this.image.setTint(0xeae0ff));
    this.image.on('pointerout', () => this.image.clearTint());

    // Depth by bottom edge so heroes sort correctly around the structure.
    this.image.setDepth(def.y);

    // Category label above the citadel. Silver-gold on slate reads as the
    // "executive" tier, distinct from the warm amber activity labels.
    const labelY = def.y - this.image.displayHeight - 10;
    this.label = addCrispText(scene, def.x, labelY, def.label.toUpperCase(), {
      fontSize: '18px',
      fontStyle: '700',
      color: '#E8D9A8',
      fontFamily: "'Fira Code', monospace",
      backgroundColor: 'rgba(30,27,45,0.72)',
      padding: { x: 7, y: 3 },
    }).setOrigin(0.5, 1).setDepth(def.y + 0.1);

    // Reserved seats — one marker per C-LEVEL role, laid out in a row on the
    // terrace just in front of (below) the citadel base.
    const seatCount = def.seats.length;
    const seatGap = 92;
    const rowY = def.y + 26;
    const startX = def.x - ((seatCount - 1) * seatGap) / 2;
    def.seats.forEach((role, index) => {
      const seat = addCrispText(scene, startX + index * seatGap, rowY, role, {
        fontSize: '13px',
        fontStyle: '600',
        color: '#E8D9A8',
        fontFamily: "'Fira Code', monospace",
        backgroundColor: 'rgba(30,27,45,0.65)',
        padding: { x: 5, y: 2 },
      }).setOrigin(0.5, 0.5).setDepth(def.y + 0.2);
      this.seatLabels.push(seat);
    });
  }
}
