import { describe, it, expect } from 'bun:test';
import {
  createInitialState,
  stepAutoCameraState,
  type AutoCameraState,
  type AutoCameraTiming,
} from './autoCameraState';

const timing: AutoCameraTiming = {
  manualResumeMs: 5000,
  idleOverviewMs: 8000,
  focusDebounceMs: 800,
};

/** Drive the machine through a sequence of (activeCount, now) ticks, returning
 * the final step. */
function run(
  state: AutoCameraState,
  ticks: ReadonlyArray<{ active: number; now: number }>,
): { state: AutoCameraState; mode: string; paused: boolean } {
  let s = state;
  let last = stepAutoCameraState(s, 0, 0, timing);
  for (const tick of ticks) {
    last = stepAutoCameraState(s, tick.active, tick.now, timing);
    s = last.state;
  }
  return { state: s, mode: last.mode, paused: last.paused };
}

describe('stepAutoCameraState', () => {
  it('starts in overview and stays paused when disabled', () => {
    const s = createInitialState(false);
    const step = stepAutoCameraState(s, 1, 1000, timing);
    expect(step.paused).toBe(true);
    expect(step.mode).toBe('overview');
  });

  it('commits focus after the debounce when a single agent is active', () => {
    const s = createInitialState(true);
    // Below debounce: still overview (pending focus).
    const early = stepAutoCameraState(s, 1, 100, timing);
    expect(early.mode).toBe('overview');
    // After debounce window: focus committed.
    const late = run(s, [
      { active: 1, now: 100 },
      { active: 1, now: 1000 },
    ]);
    expect(late.mode).toBe('focus');
  });

  it('commits group after the debounce when two or more agents are active', () => {
    const s = createInitialState(true);
    const result = run(s, [
      { active: 3, now: 0 },
      { active: 3, now: 900 },
    ]);
    expect(result.mode).toBe('group');
  });

  it('pauses for manualResumeMs after a manual interaction, then resumes', () => {
    let s = createInitialState(true);
    s = { ...s, lastManualMs: 10_000 };
    // 2s later — still paused.
    const paused = stepAutoCameraState(s, 1, 12_000, timing);
    expect(paused.paused).toBe(true);
    // 5s+ later — resumes (and begins debouncing toward focus).
    const resumed = stepAutoCameraState(s, 1, 15_001, timing);
    expect(resumed.paused).toBe(false);
  });

  it('returns to overview only after the idle timeout once no agents are active', () => {
    let s = createInitialState(true);
    // Establish focus with an active agent at t=0..1000.
    s = run(s, [{ active: 1, now: 0 }, { active: 1, now: 1000 }]).state;
    expect(s.mode).toBe('focus');

    // Agent goes idle at t=1000 (lastActiveMs=1000). Shortly after: holds focus.
    const soon = stepAutoCameraState(s, 0, 4000, timing);
    expect(soon.mode).toBe('focus');

    // Past idle timeout (1000 + 8000 = 9000) plus debounce: overview.
    let s2 = stepAutoCameraState(s, 0, 9001, timing).state; // desired overview pending
    const afterDebounce = stepAutoCameraState(s2, 0, 9900, timing); // 9001+? hold 800ms
    expect(afterDebounce.mode).toBe('overview');
  });

  it('tracks lastActiveMs even while paused so the idle timer is accurate on resume', () => {
    let s = createInitialState(true);
    s = { ...s, lastManualMs: 0 }; // paused until 5000
    const step = stepAutoCameraState(s, 2, 2000, timing);
    expect(step.paused).toBe(true);
    expect(step.state.lastActiveMs).toBe(2000);
  });

  it('is pure — same input yields same output', () => {
    const s = createInitialState(true);
    const a = stepAutoCameraState(s, 1, 500, timing);
    const b = stepAutoCameraState(s, 1, 500, timing);
    expect(a.mode).toBe(b.mode);
    expect(a.state).toEqual(b.state);
  });
});
