import { describe, test, expect } from 'bun:test';
import {
  BUILDING_DEFS,
  LANDMARK_DEFS,
  NPC_VILLAGE,
  PLAZA,
  VILLAGE_BOUNDS,
  VILLAGE_GATE,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  computeVillageBounds,
  getBuildingForActivity,
} from './building-layout';
import type { AgentActivity } from '../../types/agent';

const findCouncil = () => {
  const council = LANDMARK_DEFS.find((landmark) => landmark.id === 'council');
  if (council === undefined) throw new Error('council landmark missing from LANDMARK_DEFS');
  return council;
};

// Fail fast so every connector test reads as a clear assertion failure rather
// than a downstream TypeError on an undefined connector.
const findCouncilConnector = () => {
  const connector = findCouncil().connector;
  if (connector === undefined) throw new Error('council connector missing');
  if (connector.points.length < 2) throw new Error('council connector needs at least 2 points');
  return connector;
};

describe('LANDMARK_DEFS — C-LEVEL Council', () => {
  test('exposes a council landmark', () => {
    expect(LANDMARK_DEFS.map((landmark) => landmark.id)).toContain('council');
  });

  test('seats the four C-LEVEL roles in order', () => {
    expect(findCouncil().seats).toEqual(['CEO', 'CFO', 'CSO', 'Architect']);
  });

  test('sits north of the plaza (smaller y is further north)', () => {
    expect(findCouncil().y).toBeLessThan(PLAZA.y);
  });

  test('stays within the world bounds', () => {
    const council = findCouncil();
    expect(council.x).toBeGreaterThan(0);
    expect(council.x).toBeLessThan(WORLD_WIDTH);
    expect(council.y).toBeGreaterThan(0);
    expect(council.y).toBeLessThan(WORLD_HEIGHT);
  });

  test('declares a positive render scale', () => {
    expect(findCouncil().scale).toBeGreaterThan(0);
  });

  test('carries an image key and a human label', () => {
    const council = findCouncil();
    expect(council.imageKey.length).toBeGreaterThan(0);
    expect(council.label.length).toBeGreaterThan(0);
  });

  test('uses ids disjoint from the protected activity buildings', () => {
    const buildingIds = new Set(BUILDING_DEFS.map((building) => building.id));
    for (const landmark of LANDMARK_DEFS) {
      expect(buildingIds.has(landmark.id)).toBe(false);
    }
  });
});

describe('LANDMARK_DEFS — Council connector road', () => {
  test('the council declares a connector road with at least 2 points', () => {
    expect(() => findCouncilConnector()).not.toThrow();
  });

  test('connects the plaza hub to the council base along the central axis', () => {
    const council = findCouncil();
    const connector = findCouncilConnector();
    const start = connector.points[0]!;
    const end = connector.points[connector.points.length - 1]!;
    // starts at the plaza hub
    expect(start.x).toBe(PLAZA.x);
    expect(start.y).toBe(PLAZA.y);
    // ends at the council base — must track the council position
    expect(end.x).toBe(council.x);
    expect(end.y).toBe(council.y);
  });

  test('runs straight up a single vertical axis (constant x)', () => {
    const xs = new Set(findCouncilConnector().points.map((point) => point.x));
    expect(xs.size).toBe(1);
  });

  test('uses a valid road style and a positive width', () => {
    const connector = findCouncilConnector();
    expect(['main', 'secondary', 'trail', 'plaza']).toContain(connector.style);
    expect(connector.width).toBeGreaterThan(0);
  });

  test('stays within the world bounds', () => {
    for (const point of findCouncilConnector().points) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(WORLD_WIDTH);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(WORLD_HEIGHT);
    }
  });
});

describe('getBuildingForActivity — landmarks excluded from activity routing', () => {
  const activities: AgentActivity[] = [
    'reading',
    'thinking',
    'editing',
    'bash',
    'debugging',
    'git',
    'reviewing',
    'idle',
  ];

  test('never routes any activity to a landmark', () => {
    const landmarkIds = new Set(LANDMARK_DEFS.map((landmark) => landmark.id));
    for (const activity of activities) {
      const building = getBuildingForActivity(activity);
      expect(landmarkIds.has(building.id)).toBe(false);
    }
  });
});

describe('computeVillageBounds — tight village footprint (issue #63)', () => {
  const within = (
    point: { x: number; y: number },
    bounds: { centerX: number; centerY: number; width: number; height: number },
  ) =>
    Math.abs(point.x - bounds.centerX) <= bounds.width / 2 &&
    Math.abs(point.y - bounds.centerY) <= bounds.height / 2;

  test('matches the expected regression bounds for the current layout', () => {
    // Buildings + council bbox: x 1150–1720, y 450–900 → center (1435, 675),
    // span 570×450; + 140 padding per side → 850×730.
    expect(VILLAGE_BOUNDS).toEqual({
      centerX: 1435,
      centerY: 675,
      width: 850,
      height: 730,
    });
  });

  test('contains every activity building', () => {
    for (const building of BUILDING_DEFS) {
      expect(within(building, VILLAGE_BOUNDS)).toBe(true);
    }
  });

  test('contains the council landmark', () => {
    const council = findCouncil();
    expect(within({ x: council.x, y: council.y }, VILLAGE_BOUNDS)).toBe(true);
  });

  test('contains the top-row buildings the old fixed box dropped (watchtower, chapel)', () => {
    const watchtower = BUILDING_DEFS.find((b) => b.id === 'watchtower')!;
    const chapel = BUILDING_DEFS.find((b) => b.id === 'chapel')!;
    expect(within(watchtower, VILLAGE_BOUNDS)).toBe(true);
    expect(within(chapel, VILLAGE_BOUNDS)).toBe(true);
  });

  test('excludes the far NPC village and the south gate (kept tight)', () => {
    expect(within(NPC_VILLAGE, VILLAGE_BOUNDS)).toBe(false);
    expect(within(VILLAGE_GATE, VILLAGE_BOUNDS)).toBe(false);
  });

  test('is much narrower than the world and stays inside it', () => {
    expect(VILLAGE_BOUNDS.width).toBeLessThan(WORLD_WIDTH);
    expect(VILLAGE_BOUNDS.height).toBeLessThan(WORLD_HEIGHT);
    expect(VILLAGE_BOUNDS.centerX - VILLAGE_BOUNDS.width / 2).toBeGreaterThan(0);
    expect(VILLAGE_BOUNDS.centerY - VILLAGE_BOUNDS.height / 2).toBeGreaterThan(0);
  });

  test('computeVillageBounds is pure (same result each call)', () => {
    expect(computeVillageBounds()).toEqual(VILLAGE_BOUNDS);
  });
});
