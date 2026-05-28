import type { AgentActivity } from '../../types/agent';

export interface BuildingDef {
  id: string;
  label: string;
  activity: AgentActivity;
  x: number;
  y: number;
  imageKey: string;
  scale: number;
  description: string;
  toolCalls: string[];
}

/**
 * World is much larger (2800x1800) so we can render a thick decorative forest
 * around the village. The **interactive** village itself stays compact — all
 * buildings fit inside a ~1100×700 area centred at (1400, 720) — so every
 * functional target remains on-screen at default zoom.
 */
export const WORLD_WIDTH = 2800;
export const WORLD_HEIGHT = 1800;

/**
 * Main village clear-zone (no forest inside here). Forest fills everything
 * outside this ellipse, with a secondary clearing around the NPC hamlet.
 */
export const CITY_CLEAR = { x: 1400, y: 780, rx: 520, ry: 420 };

/** Plaza/fountain anchor — drives road hub & heroes' visual centre. */
export const PLAZA = { x: 1400, y: 780 };

/**
 * Building coordinates follow the handle-issue workflow order to minimise hero
 * travel distance on the transitions that happen most often in practice:
 *
 * - Forge/Arena/Alchemist cluster tightly (≤ 201 px apart) because editing,
 *   running tests, and debugging cycle rapidly within a single task step.
 * - Library and Castle sit near the south gate so the first two steps of every
 *   task (read codebase, plan) require short walks from the spawn point.
 * - Chapel and Watchtower share the north-east corner because git operations
 *   and code review happen together at end-of-task, keeping that flow local.
 * - Tavern occupies the western plaza so idle heroes stay out of the active
 *   work zone and are visually distinct from agents in progress.
 */
export const BUILDING_DEFS: BuildingDef[] = [
  { id: 'library',    label: 'Library',    activity: 'reading',   x: 1150, y: 900,  imageKey: 'building-library',    scale: 0.52, description: 'Agents come here to read and search code',                toolCalls: ['Read', 'Grep', 'Glob'] },
  { id: 'castle',     label: 'Castle',     activity: 'thinking',  x: 1300, y: 700,  imageKey: 'building-castle',     scale: 0.46, description: 'Agents come here to think and reason',                    toolCalls: ['(AI thinking/planning)'] },
  { id: 'forge',      label: 'Forge',      activity: 'editing',   x: 1380, y: 880,  imageKey: 'building-forge',      scale: 0.42, description: 'Agents come here to write and edit code',                 toolCalls: ['Edit', 'Write'] },
  { id: 'arena',      label: 'Arena',      activity: 'bash',      x: 1560, y: 880,  imageKey: 'building-arena',      scale: 0.42, description: 'Agents come here to run commands and tests',              toolCalls: ['Bash'] },
  { id: 'alchemist',  label: 'Alchemist',  activity: 'debugging', x: 1470, y: 700,  imageKey: 'building-alchemist',  scale: 0.50, description: 'Agents come here to debug and fix errors',                toolCalls: ['(fixing after errors)'] },
  { id: 'chapel',     label: 'Chapel',     activity: 'git',       x: 1720, y: 560,  imageKey: 'building-chapel',     scale: 0.38, description: 'Agents come here to commit and push code',                toolCalls: ['git commit', 'git push', 'git merge'] },
  { id: 'watchtower', label: 'Watchtower', activity: 'reviewing', x: 1600, y: 450,  imageKey: 'building-watchtower', scale: 0.42, description: 'Agents come here to review code and dispatch subagents',  toolCalls: ['Agent', 'review'] },
  { id: 'tavern',     label: 'Tavern',     activity: 'idle',      x: 1250, y: 780,  imageKey: 'building-tavern',     scale: 0.50, description: 'Agents rest here while waiting for user input',           toolCalls: ['(idle/waiting)'] },
];

/** South gate — where heroes first spawn before walking into the village. */
export const VILLAGE_GATE = { x: 1400, y: 1130 };

/**
 * Small purple NPC village tucked into the NE forest, visually separated
 * from the main village by a strip of woods.
 */
export const NPC_VILLAGE = { x: 2420, y: 1430, radius: 180 };

export function getBuildingForActivity(activity: AgentActivity): BuildingDef {
  const building = BUILDING_DEFS.find((b) => b.activity === activity);
  return building ?? BUILDING_DEFS.find((b) => b.activity === 'idle')!;
}

/** Road styles shared with the editor's PathSegment palette. */
export type RoadStyle = 'main' | 'secondary' | 'trail' | 'plaza';

/**
 * A decorative road that visually ties a landmark into the village. It is drawn
 * behind the structures and is NOT part of the hero pathfinding graph — heroes
 * never walk to landmarks, so the connector exists for visual hierarchy only.
 * The last point should sit at the landmark base so the road meets the structure.
 */
export interface LandmarkConnector {
  points: Array<{ x: number; y: number }>;
  width: number;
  style: RoadStyle;
}

/**
 * A landmark is a fixed structure that exists for meaning, not for activity
 * routing. Unlike {@link BuildingDef} it has no `activity` — heroes never walk
 * to it, so it is deliberately excluded from {@link getBuildingForActivity}.
 * `seats` names the C-LEVEL roles the structure is reserved for; the renderer
 * lays out one marker per seat. `connector` is an optional decorative road.
 */
export interface LandmarkDef {
  id: string;
  label: string;
  x: number;
  y: number;
  imageKey: string;
  scale: number;
  description: string;
  seats: string[];
  connector?: LandmarkConnector;
}

/**
 * C-LEVEL Council — the executive/advisory tier (CEO, CFO, CSO, Architect),
 * distinct from the worker heroes that cycle through the activity buildings.
 *
 * Placed north-centre above the plaza so the south→north axis (gate → plaza →
 * worker buildings → council) reads as a vertical hierarchy with the council at
 * the apex. `y` stays inside the default camera view (the village fit is ~700px
 * tall centred on the plaza), so the citadel is on-screen without zooming out.
 * Detection/routing of live C-LEVEL agents into these seats is intentionally
 * out of scope — this reserves the space only.
 */
export const LANDMARK_DEFS: LandmarkDef[] = [
  {
    id: 'council',
    label: 'C-LEVEL',
    x: 1400,
    y: 480,
    imageKey: 'landmark-council',
    scale: 0.6,
    description: 'The C-LEVEL council — where the CEO, CFO, CSO, and Architect preside',
    seats: ['CEO', 'CFO', 'CSO', 'Architect'],
    // Ceremonial avenue straight up the central axis from the plaza hub to the
    // council base, completing the south→north hierarchy. Endpoint tracks the
    // council position above (1400, 480) — kept in sync by a unit test.
    connector: {
      points: [
        { x: PLAZA.x, y: PLAZA.y },
        { x: 1400, y: 480 },
      ],
      width: 48,
      style: 'main',
    },
  },
];
