import { describe, test, expect } from 'bun:test';
import {
  BUILDING_DEFS,
  LANDMARK_DEFS,
  PLAZA,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  getBuildingForActivity,
} from './building-layout';
import type { AgentActivity } from '../../types/agent';

const findCouncil = () => {
  const council = LANDMARK_DEFS.find((landmark) => landmark.id === 'council');
  if (council === undefined) throw new Error('council landmark missing from LANDMARK_DEFS');
  return council;
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
  test('the council declares a connector road', () => {
    expect(findCouncil().connector).toBeDefined();
  });

  test('connects the plaza hub to the council base along the central axis', () => {
    const council = findCouncil();
    const connector = council.connector!;
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
    const connector = findCouncil().connector!;
    const xs = new Set(connector.points.map((point) => point.x));
    expect(xs.size).toBe(1);
  });

  test('uses a valid road style and a positive width', () => {
    const connector = findCouncil().connector!;
    expect(['main', 'secondary', 'trail', 'plaza']).toContain(connector.style);
    expect(connector.width).toBeGreaterThan(0);
  });

  test('stays within the world bounds', () => {
    for (const point of findCouncil().connector!.points) {
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
