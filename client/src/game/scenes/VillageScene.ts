import * as Phaser from 'phaser';
import { eventBridge } from '../EventBridge';
import { Building } from '../entities/Building';
import { Landmark } from '../entities/Landmark';
import { HeroSprite } from '../entities/HeroSprite';
import { BUILDING_DEFS, LANDMARK_DEFS, VILLAGE_GATE, WORLD_WIDTH, WORLD_HEIGHT, getBuildingForActivity } from '../data/building-layout';
import { TerrainRenderer } from '../terrain/TerrainRenderer';
import { renderMapConfig, drawPath, PATH_LAYER_DEPTH } from '../terrain/MapConfigRenderer';
import { ensureAssetsLoaded } from '../data/asset-loader';
import { buildRoadNetworkFromPaths, resetRoadNetwork } from '../data/road-network';
import { NpcSprite } from '../entities/NpcSprite';
import type { AgentState } from '../../types/agent';
import type { AssetManifest, MapConfig, BuildingPosition, NpcPlacement } from '../../editor/types/map';
import { SERVER_URL as API_BASE } from '../../config';
import { getActiveTheme, rebaseSavedScale } from '../themes/registry';
import { computeShowSourceBadge, computePartyOrder } from '../../presentation/agentPresentation';
import { AutoCameraController } from '../camera/AutoCameraController';
import { computeFitGoal } from '../camera/autoCameraPlanning';
import type { AutoCameraConfig, CameraTarget } from '../camera/autoCameraPlanning';
import type { AutoCameraTiming } from '../camera/autoCameraState';
import { readAutoCameraPreference } from '../camera/autoCameraPref';
import {
  reduceSelection,
  reduceManualDrag,
  reduceAutoCamToggle,
  reduceHeroRemoved,
  type CameraFollowState,
  type CameraFollowEffect,
} from './cameraFollowPolicy';
import {
  NIGHT_OVERLAY_DEPTH,
  RAIN_EMITTER_DEPTH,
  RAIN_SPLASH_DEPTH,
  RAIN_DARKEN_DEPTH,
} from '../renderDepth';

/** Set `cam.zoom` to `newZoom` while keeping the world point currently
 * under screen coordinates (sx, sy) pinned to the same screen spot.
 * Without this, Phaser's setZoom() zooms around the camera's center and
 * the map appears to slide while zooming. */
function zoomAroundPointer(cam: Phaser.Cameras.Scene2D.Camera, sx: number, sy: number, newZoom: number): void {
  const before = cam.getWorldPoint(sx, sy);
  cam.setZoom(newZoom);
  const after = cam.getWorldPoint(sx, sy);
  cam.scrollX += before.x - after.x;
  cam.scrollY += before.y - after.y;
}

/** Hide agents idle for longer than this from the Phaser scene (kept in PartyBar). */
const IDLE_HIDE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Grid spacing between heroes at the same building. */
const GRID_SPACING_X = 40;
const GRID_SPACING_Y = 35;

/** Maximum manual zoom (matches the wheel/pinch cap). */
const MAX_ZOOM = 1.5;

/** Village framing — the area both fitCamera() and the auto overview frame.
 * Shared so the manual fit and the auto overview can never drift apart. */
const VILLAGE_FIT_WIDTH = 1100;
const VILLAGE_FIT_HEIGHT = 700;
const VILLAGE_FIT_MARGIN = 0.85;

/** Auto-camera framing config — how it frames the village and active agents. */
const AUTO_CAMERA_CONFIG: AutoCameraConfig = {
  worldWidth: WORLD_WIDTH,
  worldHeight: WORLD_HEIGHT,
  villageWidth: VILLAGE_FIT_WIDTH,
  villageHeight: VILLAGE_FIT_HEIGHT,
  villageCenterX: WORLD_WIDTH / 2,
  villageCenterY: WORLD_HEIGHT / 2,
  overviewMargin: VILLAGE_FIT_MARGIN,
  groupMargin: 0.8,
  focusZoom: 1.15,
  maxZoom: MAX_ZOOM,
  minGroupWidth: 600,
  minGroupHeight: 400,
};

/** Auto-camera timing — debounce/idle/manual-pause windows (issue #38). */
const AUTO_CAMERA_TIMING: AutoCameraTiming = {
  manualResumeMs: 5000,
  idleOverviewMs: 8000,
  focusDebounceMs: 800,
};

/** Per-frame smoothing for the auto camera — gentle to avoid motion sickness. */
const AUTO_CAMERA_LERP = 0.08;
/** Camera follow smoothing for the selected hero (issue #44). */
const FOLLOW_LERP = 0.1;
const AUTO_CAMERA_MAX_ZOOM_DELTA = 0.02;

export class VillageScene extends Phaser.Scene {
  private buildings: Building[] = [];
  private landmarks: Landmark[] = [];
  private heroes = new Map<string, HeroSprite>();
  private onAgentsUpdated: ((agents: unknown) => void) | null = null;
  private onCameraFollow: ((agentId: unknown) => void) | null = null;
  private onCameraFit: (() => void) | null = null;
  private onSelectionChanged: ((agentId: unknown) => void) | null = null;
  private onBackgroundPointerDown: ((pointer: Phaser.Input.Pointer, hits: Phaser.GameObjects.GameObject[]) => void) | null = null;

  /** Auto camera — follows active agents; null until create(). */
  private autoCam: AutoCameraController | null = null;
  /**
   * Camera follow ownership (issue #44). Mutated only through the pure
   * cameraFollowPolicy reducers; effects are applied via applyFollowEffect.
   */
  private followState: CameraFollowState = {
    followedHeroId: null,
    userAutoCamEnabled: readAutoCameraPreference(),
  };
  private onAutoCameraToggle: ((on: unknown) => void) | null = null;
  /** Named so it can be removed in cleanup (the scene has several anonymous
   * 'update' listeners that can't be individually detached). */
  private onAutoCameraUpdate: ((time: number) => void) | null = null;
  /** Named resize handler so cleanup can detach it — otherwise a stale closure
   * survives scene restart and touches a destroyed camera on the next resize. */
  private onResize: ((gameSize: Phaser.Structs.Size) => void) | null = null;

  /** Tracks which hero IDs are at each building, in arrival order. */
  private buildingSlots = new Map<string, string[]>();

  /** Tracks which building each hero is currently assigned to. */
  private heroBuildingMap = new Map<string, string>();

  /** Atmospheric effects */
  private nightOverlay: Phaser.GameObjects.Graphics | null = null;
  private rainEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private rainEmitZone: Phaser.Geom.Rectangle | null = null;
  private rainSplashEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private rainSplashZone: Phaser.Geom.Rectangle | null = null;
  private rainDarkenOverlay: Phaser.GameObjects.Graphics | null = null;
  private lightningTimer: Phaser.Time.TimerEvent | null = null;
  private onNightToggle: ((on: unknown) => void) | null = null;
  private onRainToggle: ((on: unknown) => void) | null = null;

  /** Decorative NPCs placed via the map editor. */
  private editorNpcs: NpcSprite[] = [];

  /** Hero sprite scale — overridden by MapConfig settings if available. */
  /** Hero sprite scale — defaults to the active theme's baseline (0.5 for
   * Tiny Swords / CC0 edition). MapConfig-saved overrides are rebased
   * through `rebaseSavedScale` so they're stored once against the Tiny
   * Swords baseline and render proportionally under any theme. */
  private heroScale = getActiveTheme().heroScale;

  /** Spawn point used for new heroes. Overridden by MapConfig.spawn when present. */
  private heroSpawn: { x: number; y: number } = { x: VILLAGE_GATE.x, y: VILLAGE_GATE.y };

  /** True once bootstrapWorld() has finished spawning buildings. */
  private buildingsReady = false;

  /** Agent updates received before buildings were ready — replayed once ready. */
  private pendingAgentUpdate: AgentState[] | null = null;

  constructor() {
    super({ key: 'VillageScene' });
  }

  create(): void {
    // Out-of-map background: black so the area beyond world bounds reads as
    // empty space instead of a green field. The actual map fills the world
    // rect with its own ground layer (procedural or MapConfig tileset), so
    // this colour is only visible past the map edges or during zoom-out.
    this.cameras.main.setBackgroundColor('#000000');

    // Brightness boost — a subtle additive white overlay lifts the dark forest
    // tones so the village reads clearly as a PiP overlay in YouTube Shorts.
    const brightnessOverlay = this.add.rectangle(
      WORLD_WIDTH / 2, WORLD_HEIGHT / 2,
      WORLD_WIDTH, WORLD_HEIGHT,
      0xFFFFFF, 0.06,
    );
    brightnessOverlay.setBlendMode(Phaser.BlendModes.ADD);
    brightnessOverlay.setDepth(0.01);

    // Signal React that the village is up so it can reveal the HTML overlays
    // (TopBar, PartyBar, etc.) that should stay hidden during the BootScene.
    eventBridge.emit('village:ready');

    // Try to load a user-saved map from the editor; fall back to the procedural
    // terrain if none exists or the request fails. This is fire-and-forget —
    // the rest of create() (input, overlays, listeners) doesn't depend on it.
    void this.bootstrapWorld();

    // Set world bounds and fit the village into the viewport, then center the
    // map inside it. Anchoring on the world center (rather than a hardcoded
    // point near the gate) keeps the map visually centred regardless of the
    // fitted zoom level.
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.fitCamera();
    this.cameras.main.centerToBounds();

    // Auto camera — owns camera writes while enabled (issue #38). Starts from
    // the persisted preference (default ON). When enabled it smoothly takes
    // over from the initial fit above on the first update tick.
    this.autoCam = new AutoCameraController(this.cameras.main, {
      config: AUTO_CAMERA_CONFIG,
      timing: AUTO_CAMERA_TIMING,
      lerpFactor: AUTO_CAMERA_LERP,
      maxZoomDeltaPerFrame: AUTO_CAMERA_MAX_ZOOM_DELTA,
      centerEpsilon: 2,
      zoomEpsilon: 0.005,
      enabled: readAutoCameraPreference(),
    });

    // Reset follow state on (re)create so a restarted scene never inherits a
    // stale followedHeroId — otherwise reduceAutoCamToggle would treat the
    // scene as following and keep the freshly-built auto-cam disabled. Mirrors
    // the auto-cam being rebuilt just above.
    this.followState = {
      followedHeroId: null,
      userAutoCamEnabled: readAutoCameraPreference(),
    };

    this.onAutoCameraUpdate = (time: number) => {
      this.autoCam?.update(time);
    };
    this.events.on('update', this.onAutoCameraUpdate);

    // Re-fit when the browser/window resizes. While the auto camera is on it
    // owns framing, so only re-fit/center manually when it's off — otherwise a
    // resize would yank an active focus back to overview.
    this.onResize = (gameSize: Phaser.Structs.Size) => {
      try { if (!this.sys.isActive()) return; } catch { return; }
      this.cameras.main.setViewport(0, 0, gameSize.width, gameSize.height);
      if (this.autoCam?.enabled !== true) {
        this.fitCamera();
        this.cameras.main.centerToBounds();
      }
    };
    this.scale.on('resize', this.onResize);

    // Drag to pan (mouse + touch, with threshold to avoid interfering with building clicks)
    let dragStartX = 0;
    let dragStartY = 0;
    let isDragging = false;
    let pinchStartDist = 0;
    let pinchStartZoom = 0;

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      dragStartX = pointer.x;
      dragStartY = pointer.y;
      isDragging = false;
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown) return;
      // Skip if two fingers are touching (pinch gesture)
      if (this.input.pointer1.isDown && this.input.pointer2.isDown) return;

      const dx = pointer.x - dragStartX;
      const dy = pointer.y - dragStartY;
      if (!isDragging && Math.abs(dx) + Math.abs(dy) > 8) {
        isDragging = true;
        // A manual pan releases hero follow (issue #44). Stop following first so
        // the scrollX/Y writes below are not overwritten by Phaser's follow.
        const { state, effect } = reduceManualDrag(this.followState);
        this.followState = state;
        this.applyFollowEffect(effect);
      }
      if (isDragging) {
        const cam = this.cameras.main;
        cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
        cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
        this.autoCam?.notifyManualInteraction(this.time.now);
      }
    });

    // Mouse wheel to zoom — anchored on the pointer. We capture the world
    // point under the cursor before changing zoom and then shift scroll so
    // that same world point lines up under the cursor afterwards; without
    // this the camera zooms around its current center, which feels like the
    // map is locked to the top-left corner while the viewport scales.
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, _gameObjects: unknown[], _deltaX: number, deltaY: number) => {
      const cam = this.cameras.main;
      const newZoom = Phaser.Math.Clamp(cam.zoom - deltaY * 0.001, this.minZoom(), MAX_ZOOM);
      zoomAroundPointer(cam, pointer.x, pointer.y, newZoom);
      this.autoCam?.notifyManualInteraction(this.time.now);
    });

    // Pinch to zoom (touch) — anchored on the midpoint between the two
    // pointers, same rationale as the wheel handler.
    this.input.addPointer(1); // enable second pointer for multi-touch
    this.events.on('update', () => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown) {
        const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        if (pinchStartDist === 0) {
          pinchStartDist = dist;
          pinchStartZoom = this.cameras.main.zoom;
        } else {
          const scale = dist / pinchStartDist;
          const newZoom = Phaser.Math.Clamp(pinchStartZoom * scale, this.minZoom(), MAX_ZOOM);
          const mx = (p1.x + p2.x) / 2;
          const my = (p1.y + p2.y) / 2;
          zoomAroundPointer(this.cameras.main, mx, my, newZoom);
          this.autoCam?.notifyManualInteraction(this.time.now);
        }
      } else {
        pinchStartDist = 0;
      }
    });

    // --- Night overlay ---
    this.nightOverlay = this.add.graphics();
    this.nightOverlay.fillStyle(0x000040, 0.35);
    // Pad beyond world bounds so the overlay still covers the screen when the
    // camera is zoomed out far enough to see past the map edges.
    this.nightOverlay.fillRect(-WORLD_WIDTH, -WORLD_HEIGHT, WORLD_WIDTH * 3, WORLD_HEIGHT * 3);
    // Depth must exceed the maximum Y-sorted sprite depth (~WORLD_HEIGHT) so
     // buildings and decorations placed near the bottom of the map stay covered.
    this.nightOverlay.setDepth(NIGHT_OVERLAY_DEPTH);
    this.nightOverlay.setVisible(false);

    this.onNightToggle = (on: unknown) => {
      try { if (!this.sys.isActive()) return; } catch { return; }
      this.nightOverlay?.setVisible(on as boolean);
    };
    eventBridge.on('effect:night:toggle', this.onNightToggle);

    // --- Rain particle emitter ---
    // Short thin raindrop texture with a soft gradient — small streaks feel
    // more natural than long lines.
    if (!this.textures.exists('raindrop')) {
      const canvasTex = this.textures.createCanvas('raindrop', 2, 7);
      if (canvasTex) {
        const ctx = canvasTex.getContext();
        const grad = ctx.createLinearGradient(0, 0, 0, 7);
        grad.addColorStop(0, 'rgba(210, 225, 245, 0.0)');
        grad.addColorStop(0.5, 'rgba(210, 225, 245, 0.7)');
        grad.addColorStop(1, 'rgba(230, 240, 255, 0.9)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 2, 7);
        canvasTex.refresh();
      }
    }

    // Ground splash texture — small bright dot that fades out
    if (!this.textures.exists('rainsplash')) {
      const splashTex = this.textures.createCanvas('rainsplash', 6, 6);
      if (splashTex) {
        const ctx = splashTex.getContext();
        const g = ctx.createRadialGradient(3, 3, 0, 3, 3, 3);
        g.addColorStop(0, 'rgba(220, 235, 255, 0.9)');
        g.addColorStop(1, 'rgba(220, 235, 255, 0.0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 6, 6);
        splashTex.refresh();
      }
    }

    // Emit above the current camera worldView; the Rectangle object is mutated
    // each frame so the rain always covers whatever portion of the map the
    // player is looking at (rain stays in world space, but tracks the camera).
    this.rainEmitZone = new Phaser.Geom.Rectangle(0, 0, WORLD_WIDTH, 1);
    // Drops fall across the entire viewport — lifespan calibrated to cover the
    // full visible height at typical zoom without dying prematurely.
    this.rainEmitter = this.add.particles(0, 0, 'raindrop', {
      emitZone: { source: this.rainEmitZone as unknown as Phaser.Types.GameObjects.Particles.RandomZoneSource, type: 'random' },
      speedY: { min: 650, max: 900 },
      speedX: { min: 70, max: 130 },
      lifespan: 2500,
      alpha: { start: 0.8, end: 0.7 },
      scale: { min: 0.7, max: 1.1 },
      rotate: 8,
      quantity: 7,
      frequency: 10,
      emitting: false,
    });
    this.rainEmitter.setDepth(RAIN_EMITTER_DEPTH);

    // Ground splashes — short-lived puffs emitted across the viewport floor.
    this.rainSplashZone = new Phaser.Geom.Rectangle(0, 0, WORLD_WIDTH, 1);
    this.rainSplashEmitter = this.add.particles(0, 0, 'rainsplash', {
      emitZone: { source: this.rainSplashZone as unknown as Phaser.Types.GameObjects.Particles.RandomZoneSource, type: 'random' },
      speedY: { min: -30, max: -10 },
      lifespan: 350,
      alpha: { start: 0.6, end: 0 },
      scale: { start: 0.4, end: 1.1 },
      quantity: 2,
      frequency: 45,
      emitting: false,
    });
    this.rainSplashEmitter.setDepth(RAIN_SPLASH_DEPTH);

    // Storm darkening overlay — activates with rain, independent from night mode.
    this.rainDarkenOverlay = this.add.graphics();
    this.rainDarkenOverlay.fillStyle(0x1a2a3a, 0.30);
    this.rainDarkenOverlay.fillRect(-WORLD_WIDTH, -WORLD_HEIGHT, WORLD_WIDTH * 3, WORLD_HEIGHT * 3);
    this.rainDarkenOverlay.setDepth(RAIN_DARKEN_DEPTH);
    this.rainDarkenOverlay.setVisible(false);

    // Keep emit zones aligned with the current camera worldView, but clamped
    // to the world bounds so rain doesn't fall outside the map when zoomed out.
    this.events.on('update', () => {
      if (this.rainEmitZone !== null) {
        const view = this.cameras.main.worldView;
        const margin = 80;
        // Drops drift right (~speedX.max * lifespan) after spawn — pull xEnd
        // back so drifted drops still die inside the world bounds.
        const driftCompensation = 325;
        const xStart = Math.max(0, view.x - margin);
        const xEnd = Math.min(WORLD_WIDTH - driftCompensation, view.x + view.width + margin);
        this.rainEmitZone.setTo(xStart, view.y - margin, Math.max(0, xEnd - xStart), 1);
      }
      if (this.rainSplashZone !== null) {
        const view = this.cameras.main.worldView;
        const bandTop = view.y + view.height * 0.72;
        const bandHeight = view.height * 0.26;
        const xStart = Math.max(0, view.x);
        const xEnd = Math.min(WORLD_WIDTH, view.x + view.width);
        this.rainSplashZone.setTo(xStart, bandTop, Math.max(0, xEnd - xStart), bandHeight);
      }
    });

    this.onRainToggle = (on: unknown) => {
      try { if (!this.sys.isActive()) return; } catch { return; }
      if (on as boolean) {
        this.rainEmitter?.start();
        this.rainSplashEmitter?.start();
        this.rainDarkenOverlay?.setVisible(true);
        this.scheduleLightning();
      } else {
        this.rainEmitter?.stop();
        this.rainSplashEmitter?.stop();
        this.rainDarkenOverlay?.setVisible(false);
        this.lightningTimer?.remove();
        this.lightningTimer = null;
      }
    };
    eventBridge.on('effect:rain:toggle', this.onRainToggle);

    // Listen for agent updates from React
    this.onAgentsUpdated = (agents: unknown) => {
      try { if (!this.sys.isActive()) return; } catch { return; }
      this.handleAgentUpdate(agents as AgentState[]);
    };
    eventBridge.on('agents:updated', this.onAgentsUpdated);

    // Pan the camera to a hero when the Activity Feed requests it
    // (user clicks an agent sprite in the feed).
    this.onCameraFollow = (agentId: unknown) => {
      if (typeof agentId !== 'string') return;
      try { if (!this.sys.isActive()) return; } catch { return; }
      const hero = this.heroes.get(agentId);
      if (hero === undefined) return;
      // A deliberate click-to-follow is a manual intent — pause the auto camera
      // so its update doesn't fight this pan tween.
      this.autoCam?.notifyManualInteraction(this.time.now);
      this.cameras.main.pan(hero.x, hero.y, 600, 'Sine.easeInOut');
    };
    eventBridge.on('camera:follow', this.onCameraFollow);

    // One-shot "fit view" (TopBar button): frame the whole village plus every
    // hero in a single smooth pan + zoom. Like camera:follow it is a manual
    // intent, so it pauses the auto camera rather than fighting its update.
    this.onCameraFit = () => {
      try { if (!this.sys.isActive()) return; } catch { return; }
      this.autoCam?.notifyManualInteraction(this.time.now);
      const cam = this.cameras.main;
      const heroTargets: CameraTarget[] = [];
      for (const hero of this.heroes.values()) {
        heroTargets.push({ x: hero.x, y: hero.y });
      }
      const goal = computeFitGoal(heroTargets, { width: cam.width, height: cam.height }, AUTO_CAMERA_CONFIG);
      // force=true so a fit always wins: it overrides an in-flight pan/zoom
      // (e.g. an Activity Feed camera:follow tween, or a rapid second click).
      // Without it Phaser ignores the request while another effect runs,
      // breaking the "one click = one reframe" contract.
      cam.pan(goal.centerX, goal.centerY, 500, 'Sine.easeInOut', true);
      cam.zoomTo(goal.zoom, 500, 'Sine.easeInOut', true);
    };
    eventBridge.on('camera:fit', this.onCameraFit);

    // Toggle the auto camera on/off (TopBar). Persistence is owned by TopBar;
    // the scene only applies the enabled flag. When turned off, the camera is
    // left wherever it is so the user keeps their current view.
    this.onAutoCameraToggle = (on: unknown) => {
      if (typeof on !== 'boolean') return;
      // Record the user's latest intent. While following, auto-cam stays off so
      // it does not fight the follow; the intent is restored on follow exit
      // (issue #44 — avoids a stale snapshot overwriting a mid-follow toggle).
      const { state, effect } = reduceAutoCamToggle(this.followState, on);
      this.followState = state;
      this.applyFollowEffect(effect);
    };
    eventBridge.on('camera:auto:toggle', this.onAutoCameraToggle);

    // Apply outline/tint to the selected hero whenever selection changes.
    this.onSelectionChanged = (agentId: unknown) => {
      const selectedId = typeof agentId === 'string' ? agentId : null;
      for (const [id, hero] of this.heroes) {
        hero.setSelected(id === selectedId);
      }
      // Enter follow on the selected hero (issue #44). Fail closed: if the id is
      // null or not yet in the scene, the reducer exits follow instead of
      // tracking a missing target.
      const heroExists = selectedId !== null && this.heroes.has(selectedId);
      const { state, effect } = reduceSelection(this.followState, selectedId, heroExists);
      this.followState = state;
      this.applyFollowEffect(effect);
    };
    eventBridge.on('selection:changed', this.onSelectionChanged);

    // Click on TRULY empty map (no interactive object at all) → deselect
    // whatever is currently selected. We used to emit this whenever the hit
    // wasn't a hero, but that racing with the building's own `building:clicked`
    // meant clicking a building wiped its info panel the moment it opened
    // (App.handleSelectAgent(null) clears `selectedBuildingId` too). Now the
    // building's own pointerdown is responsible for switching selection.
    this.onBackgroundPointerDown = (_p, hits) => {
      if (hits.length === 0) {
        eventBridge.emit('hero:clicked', null);
      }
    };
    this.input.on('pointerdown', this.onBackgroundPointerDown);

    const cleanup = () => {
      if (this.onAgentsUpdated !== null) {
        eventBridge.off('agents:updated', this.onAgentsUpdated);
        this.onAgentsUpdated = null;
      }
      if (this.onNightToggle !== null) {
        eventBridge.off('effect:night:toggle', this.onNightToggle);
        this.onNightToggle = null;
      }
      if (this.onRainToggle !== null) {
        eventBridge.off('effect:rain:toggle', this.onRainToggle);
        this.onRainToggle = null;
      }
      if (this.onCameraFollow !== null) {
        eventBridge.off('camera:follow', this.onCameraFollow);
        this.onCameraFollow = null;
      }
      if (this.onCameraFit !== null) {
        eventBridge.off('camera:fit', this.onCameraFit);
        this.onCameraFit = null;
      }
      if (this.onSelectionChanged !== null) {
        eventBridge.off('selection:changed', this.onSelectionChanged);
        this.onSelectionChanged = null;
      }
      if (this.onBackgroundPointerDown !== null) {
        this.input.off('pointerdown', this.onBackgroundPointerDown);
        this.onBackgroundPointerDown = null;
      }
      if (this.onAutoCameraToggle !== null) {
        eventBridge.off('camera:auto:toggle', this.onAutoCameraToggle);
        this.onAutoCameraToggle = null;
      }
      if (this.onAutoCameraUpdate !== null) {
        this.events.off('update', this.onAutoCameraUpdate);
        this.onAutoCameraUpdate = null;
      }
      if (this.onResize !== null) {
        this.scale.off('resize', this.onResize);
        this.onResize = null;
      }
      this.autoCam?.destroy();
      this.autoCam = null;
      this.lightningTimer?.remove();
      this.lightningTimer = null;
      for (const hero of this.heroes.values()) {
        hero.destroy();
      }
      this.heroes.clear();
      this.buildings = [];
      this.landmarks = [];
      this.buildingSlots.clear();
      this.heroBuildingMap.clear();
      for (const npc of this.editorNpcs) npc.destroy();
      this.editorNpcs = [];
    };
    this.events.on('shutdown', cleanup);
    this.events.on('destroy', cleanup);
  }

  // ---------------------------------------------------------------------------
  // World bootstrap — prefer saved MapConfig, fall back to procedural terrain
  // ---------------------------------------------------------------------------

  private async bootstrapWorld(): Promise<void> {
    let mapConfig: MapConfig | null = null;
    let manifest: AssetManifest | null = null;
    let mapStatus: number | string = 'n/a';
    let manifestStatus: number | string = 'n/a';
    let fetchError: unknown = null;
    try {
      const mapRes = await fetch(`${API_BASE}/api/map`);
      mapStatus = mapRes.status;
      if (mapRes.status === 200) {
        mapConfig = await mapRes.json() as MapConfig;

        // Single-theme project — the server lazy-migrates legacy ids to
        // 'tiny-swords-cc0' on load, so no runtime switch is possible.
        const activeTheme = getActiveTheme().id;

        // Fetch the asset manifest for the (now aligned) theme so
        // decorations/buildings referenced by mapConfig resolve correctly.
        const manRes = await fetch(`${API_BASE}/api/assets/manifest?theme=${encodeURIComponent(activeTheme)}`);
        manifestStatus = manRes.status;
        if (manRes.ok) manifest = await manRes.json() as AssetManifest;
      }
    } catch (err) {
      fetchError = err;
    }

    console.log('[VillageScene] bootstrapWorld', {
      mapStatus,
      manifestStatus,
      mapConfigLoaded: mapConfig !== null,
      manifestLoaded: manifest !== null,
      terrainTiles: mapConfig ? Object.keys(mapConfig.terrain ?? {}).length : 0,
      buildings: mapConfig?.buildings?.length ?? 0,
      mapName: mapConfig?.meta?.name,
      fetchError: fetchError ? String(fetchError) : null,
    });

    try { if (!this.sys.isActive()) return; } catch { return; }

    // Depth for landmark connector roads — must match the active terrain path's
    // own layer, which differs by render path: MapConfigRenderer puts paths at
    // PATH_LAYER_DEPTH (-400, above its -800 terrain), while the procedural
    // TerrainRenderer draws grass at ~-2 and roads at ~0. A fixed -400 would
    // sink the connector behind the procedural grass and make it invisible.
    let landmarkRoadDepth = PATH_LAYER_DEPTH;

    if (mapConfig !== null && manifest !== null) {
      console.log('[VillageScene] rendering SAVED map from /api/map');
      await ensureAssetsLoaded(this, manifest, mapConfig);
      try { if (!this.sys.isActive()) return; } catch { return; }
      renderMapConfig(this, mapConfig, manifest);
      this.spawnBuildings(mapConfig.buildings);

      // Build road network from editor paths so heroes follow painted roads
      buildRoadNetworkFromPaths(mapConfig.paths, mapConfig.buildings);

      // Apply hero scale from map settings
      if (mapConfig.settings?.heroScale) {
        this.heroScale = rebaseSavedScale(mapConfig.settings.heroScale);
      }

      // Always reassign so a reload of a slot without spawn reverts cleanly
      this.heroSpawn = mapConfig.spawn
        ? { x: mapConfig.spawn.x, y: mapConfig.spawn.y }
        : { x: VILLAGE_GATE.x, y: VILLAGE_GATE.y };

      // Spawn editor-placed decorative NPCs
      if (mapConfig.npcs && mapConfig.npcs.length > 0) {
        this.spawnEditorNpcs(mapConfig.npcs);
      }
    } else {
      console.warn('[VillageScene] FALLBACK → procedural TerrainRenderer', {
        reason: mapConfig === null ? 'mapConfig is null' : 'manifest is null',
        mapStatus,
        manifestStatus,
      });
      new TerrainRenderer(this).render();
      this.spawnBuildings(null);
      resetRoadNetwork();
      landmarkRoadDepth = 0; // procedural roads sit at ~0, above the -2 grass
    }

    // Landmarks (e.g. the C-LEVEL Council) render in both paths — they are not
    // editor-managed, so they are spawned unconditionally after the terrain
    // and activity buildings are in place.
    this.spawnLandmarks(landmarkRoadDepth);

    // Buildings are now spawned — process any buffered agent updates
    this.buildingsReady = true;
    if (this.pendingAgentUpdate !== null) {
      const pending = this.pendingAgentUpdate;
      this.pendingAgentUpdate = null;
      this.handleAgentUpdate(pending);
    }
  }

  /** Calculate zoom so the village area fills the viewport. Uses the same
   * framing constants as the auto overview (AUTO_CAMERA_CONFIG) so the two
   * stay in lockstep. */
  private fitCamera(): void {
    const cam = this.cameras.main;
    const zoomX = cam.width / VILLAGE_FIT_WIDTH;
    const zoomY = cam.height / VILLAGE_FIT_HEIGHT;
    cam.setZoom(Phaser.Math.Clamp(Math.min(zoomX, zoomY) * VILLAGE_FIT_MARGIN, this.minZoom(), MAX_ZOOM));
  }

  /**
   * Apply a {@link CameraFollowEffect} from the cameraFollowPolicy reducer to
   * the real camera and AutoCameraController (issue #44). VillageScene is the
   * Humble Object: all follow-state decisions live in the pure reducer, this
   * method only performs the side effects. Zoom is left untouched — only the
   * centre tracks the hero — so wheel/pinch zoom keeps working while following.
   */
  private applyFollowEffect(effect: CameraFollowEffect): void {
    const cam = this.cameras.main;
    if (effect.stopFollow) cam.stopFollow();
    if (effect.startFollowHeroId !== null) {
      const hero = this.heroes.get(effect.startFollowHeroId);
      if (hero !== undefined) {
        cam.startFollow(hero.followTarget, true, FOLLOW_LERP, FOLLOW_LERP);
      }
    }
    this.autoCam?.setEnabled(effect.autoCamEnabled);
  }

  /** Lower zoom bound: the larger of the two viewport/world ratios, so the
   * world always fully covers the viewport — zooming out past this would
   * expose the canvas background past the tile grid, which the user has
   * asked to avoid. */
  private minZoom(): number {
    const cam = this.cameras.main;
    if (WORLD_WIDTH <= 0 || WORLD_HEIGHT <= 0) return 0.35;
    return Math.max(cam.width / WORLD_WIDTH, cam.height / WORLD_HEIGHT);
  }

  /** Queue the next lightning strike at a random interval while rain is on. */
  private scheduleLightning(): void {
    this.lightningTimer?.remove();
    const delay = Phaser.Math.Between(5000, 13000);
    this.lightningTimer = this.time.delayedCall(delay, () => {
      this.triggerLightning();
      // Reschedule only if rain is still active.
      if (this.rainDarkenOverlay?.visible === true) this.scheduleLightning();
    });
  }

  /** Fire a bright camera flash, occasionally followed by a dimmer afterflash. */
  private triggerLightning(): void {
    try { if (!this.sys.isActive()) return; } catch { return; }
    const cam = this.cameras.main;
    cam.flash(140, 225, 232, 255, true);
    if (Math.random() < 0.55) {
      this.time.delayedCall(180, () => {
        try { if (!this.sys.isActive()) return; } catch { return; }
        cam.flash(90, 200, 215, 255, true);
      });
    }
  }

  private spawnBuildings(overrides: BuildingPosition[] | null): void {
    for (const def of BUILDING_DEFS) {
      const override = overrides?.find((p) => p.id === def.id);
      const resolved = override !== undefined
        ? { ...def, x: override.x, y: override.y }
        : def;
      this.buildings.push(new Building(this, resolved));
    }
  }

  private spawnLandmarks(roadDepth: number): void {
    // Connector roads first, on the active terrain's path layer (roadDepth) so
    // they sit behind every structure, NPC, and hero. These are decorative only
    // — landmarks are not part of the hero pathfinding graph.
    let roadContainer: Phaser.GameObjects.Container | null = null;
    for (const def of LANDMARK_DEFS) {
      if (def.connector === undefined) continue;
      if (roadContainer === null) {
        roadContainer = this.add.container(0, 0).setDepth(roadDepth);
      }
      drawPath(this, roadContainer, {
        id: `${def.id}-connector`,
        points: def.connector.points,
        width: def.connector.width,
        style: def.connector.style,
      });
    }

    for (const def of LANDMARK_DEFS) {
      this.landmarks.push(new Landmark(this, def));
    }
  }

  private spawnEditorNpcs(npcs: NpcPlacement[]): void {
    for (const npc of npcs) {
      const sprite = new NpcSprite(
        this,
        npc.unit,
        npc.color,
        npc.x,
        npc.y,
        npc.wanderRadius,
        Math.floor(Math.random() * 10000),
        rebaseSavedScale(npc.scale),
      );
      this.editorNpcs.push(sprite);
    }
  }

  // ---------------------------------------------------------------------------
  // Grid position calculation
  // ---------------------------------------------------------------------------

  private calcGridPositions(doorX: number, doorY: number, count: number): Array<{ x: number; y: number }> {
    if (count === 0) return [];
    if (count === 1) return [{ x: doorX, y: doorY }];

    const cols = Math.ceil(Math.sqrt(count));
    const positions: Array<{ x: number; y: number }> = [];
    const offsetX = ((cols - 1) * GRID_SPACING_X) / 2;

    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      positions.push({
        x: doorX - offsetX + col * GRID_SPACING_X,
        y: doorY + row * GRID_SPACING_Y,
      });
    }
    return positions;
  }

  // ---------------------------------------------------------------------------
  // Slot management
  // ---------------------------------------------------------------------------

  private addToSlot(buildingId: string, heroId: string): void {
    let slots = this.buildingSlots.get(buildingId);
    if (slots === undefined) {
      slots = [];
      this.buildingSlots.set(buildingId, slots);
    }
    if (!slots.includes(heroId)) {
      slots.push(heroId);
    }
    this.heroBuildingMap.set(heroId, buildingId);
  }

  private removeFromSlot(heroId: string): string | undefined {
    const oldBuildingId = this.heroBuildingMap.get(heroId);
    if (oldBuildingId !== undefined) {
      const slots = this.buildingSlots.get(oldBuildingId);
      if (slots !== undefined) {
        const idx = slots.indexOf(heroId);
        if (idx !== -1) slots.splice(idx, 1);
      }
      this.heroBuildingMap.delete(heroId);
    }
    return oldBuildingId;
  }

  private repositionBuilding(buildingId: string): void {
    const slots = this.buildingSlots.get(buildingId);
    if (slots === undefined || slots.length === 0) return;

    const buildingDef = BUILDING_DEFS.find((b) => b.id === buildingId);
    if (buildingDef === undefined) return;

    const building = this.buildings.find((b) => b.def.id === buildingId);
    const doorX = building?.doorX ?? buildingDef.x;
    const doorY = building?.doorY ?? buildingDef.y + 60;

    const positions = this.calcGridPositions(doorX, doorY, slots.length);

    for (let i = 0; i < slots.length; i++) {
      const hero = this.heroes.get(slots[i]!);
      if (hero === undefined) continue;
      const pos = positions[i]!;

      hero.gridBaseX = pos.x;
      hero.gridBaseY = pos.y;
      hero.moveTo(pos.x, pos.y, hero.currentActivity);
    }
  }

  // ---------------------------------------------------------------------------
  // Agent update handler
  // ---------------------------------------------------------------------------

  private handleAgentUpdate(agents: AgentState[]): void {
    // Defer processing until buildings are spawned — otherwise heroes walk
    // to the hardcoded BUILDING_DEFS positions instead of the map overrides.
    if (!this.buildingsReady) {
      this.pendingAgentUpdate = agents;
      return;
    }

    const now = Date.now();

    // App-level presentation projection passes `active` / `idle` / `waiting`,
    // gates `completed` behind the TopBar toggle, and filters out `error`. The
    // scene applies two additional local policies: hide `error` defensively,
    // and drop heroes idle longer than IDLE_HIDE_THRESHOLD_MS so the village
    // doesn't grow unbounded over a long-lived session. (Party labels are still
    // computed over the full projection above, so numbers match the Party Bar.)
    const visible = agents.filter((a) => {
      if (a.status === 'error') return false;
      if (a.status === 'idle' && now - a.lastEvent > IDLE_HIDE_THRESHOLD_MS) return false;
      return true;
    });

    // Mixed-provider mode: show source badges only when both Claude and Codex
    // have a LIVE hero. Computed by the shared `computeShowSourceBadge` helper
    // so this stays in lockstep with App.tsx — both call the same function
    // against the unfiltered `agents` snapshot.
    const showSourceBadge = computeShowSourceBadge(agents);

    // Track which buildings need repositioning so the visible-iteration pass
    // below can flag dirty buildings.
    const buildingsToReposition = new Set<string>();

    // Remove heroes no longer visible
    for (const [id, hero] of this.heroes) {
      if (!visible.some((a) => a.id === id)) {
        const oldBuilding = this.removeFromSlot(id);
        hero.destroy();
        this.heroes.delete(id);
        // Stop following a hero that just left the village (issue #44).
        const { state, effect } = reduceHeroRemoved(this.followState, id);
        this.followState = state;
        this.applyFollowEffect(effect);
        if (oldBuilding !== undefined) {
          this.repositionBuilding(oldBuilding);
        }
      }
    }

    // Sub-agents are ordinary heroes in the village — they take building slots
    // like everyone else. Their relationship to a parent is shown only by the
    // inherited party number ("1-a"), assigned below via computePartyOrder.
    for (const agent of visible) {
      const existing = this.heroes.get(agent.id);
      const buildingDef = getBuildingForActivity(agent.currentActivity);

      if (existing === undefined) {
        // New hero: spawn at the configured spawn point then take a slot.
        const hero = new HeroSprite(
          this,
          agent.id,
          agent.name,
          agent.heroClass,
          agent.heroColor,
          this.heroSpawn.x,
          this.heroSpawn.y,
          agent.isSubagent,
          agent.source,
        );
        hero.setHeroScale(this.heroScale);
        hero.setActivity(agent.currentActivity);
        hero.setStatus(agent.status);
        hero.setErrorTimestamp(agent.lastErrorAt);
        hero.updateDetail(agent.currentFile, agent.currentCommand);
        hero.updateTask(agent.currentTask);
        hero.setModel(agent.model);
        this.heroes.set(agent.id, hero);
        hero.setInteractiveForSelection(() => {
          eventBridge.emit('hero:clicked', agent.id);
        });

        this.addToSlot(buildingDef.id, agent.id);
        buildingsToReposition.add(buildingDef.id);
      } else {
        // Always update detail text (file/command changes even without activity change)
        existing.updateName(agent.name);
        existing.updateDetail(agent.currentFile, agent.currentCommand);
        existing.updateTask(agent.currentTask);
        existing.setStatus(agent.status);
        existing.setErrorTimestamp(agent.lastErrorAt);
        existing.setModel(agent.model);

        const currentBuildingId = this.heroBuildingMap.get(agent.id);
        if (currentBuildingId !== buildingDef.id) {
          // Hero changed building — update activity before repositioning
          existing.setActivity(agent.currentActivity);
          const oldBuilding = this.removeFromSlot(agent.id);
          this.addToSlot(buildingDef.id, agent.id);

          if (oldBuilding !== undefined) {
            buildingsToReposition.add(oldBuilding);
          }
          buildingsToReposition.add(buildingDef.id);
        } else if (existing.currentActivity !== agent.currentActivity) {
          // Same building, different activity — update label
          existing.setActivity(agent.currentActivity);
        }
      }
    }

    // Propagate mixed-mode state to every hero (including ones not touched by
    // this update), so the badge flips on/off as the fleet composition changes.
    for (const hero of this.heroes.values()) {
      hero.setSourceBadgeVisible(showSourceBadge);
    }

    // Assign party labels: top-level heroes get "1", "2", …; sub-agents inherit
    // their parent's number with a letter suffix ("1-a"). Label over the full
    // received projection (same input the Party Bar uses) rather than the
    // scene-local `visible` subset, so a hero's number matches the Party Bar row
    // even when the scene hides long-idle heroes. setIndex is a no-op for heroes
    // that were filtered out of the scene (they have no sprite).
    for (const { agent, label } of computePartyOrder(agents)) {
      this.heroes.get(agent.id)?.setIndex(label);
    }

    for (const buildingId of buildingsToReposition) {
      this.repositionBuilding(buildingId);
    }

    // Feed the auto camera the currently active heroes (status === 'active').
    // Collected after repositioning so the first focus uses the settled slot
    // position rather than the spawn point. HeroSprite satisfies CameraTarget
    // structurally (x/y getters), so the controller tracks moving heroes live.
    const activeHeroes: HeroSprite[] = [];
    for (const agent of visible) {
      if (agent.status !== 'active') continue;
      const hero = this.heroes.get(agent.id);
      if (hero !== undefined) activeHeroes.push(hero);
    }
    this.autoCam?.setActiveTargets(activeHeroes);
  }
}
