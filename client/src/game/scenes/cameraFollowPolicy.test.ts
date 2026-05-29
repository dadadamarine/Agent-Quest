import { describe, expect, test } from 'bun:test';
import {
  reduceSelection,
  reduceManualDrag,
  reduceAutoCamToggle,
  reduceHeroRemoved,
  type CameraFollowState,
} from './cameraFollowPolicy';

const base = (over: Partial<CameraFollowState> = {}): CameraFollowState => ({
  followedHeroId: null,
  userAutoCamEnabled: true,
  ...over,
});

describe('reduceSelection', () => {
  test('selecting an existing hero enters follow and disables auto-cam', () => {
    const { state, effect } = reduceSelection(base(), 'hero-1', true);
    expect(state.followedHeroId).toBe('hero-1');
    expect(effect.startFollowHeroId).toBe('hero-1');
    expect(effect.autoCamEnabled).toBe(false);
    expect(effect.stopFollow).toBe(false);
  });

  test('deselecting (null) exits follow and restores user auto-cam preference', () => {
    const { state, effect } = reduceSelection(base({ followedHeroId: 'hero-1', userAutoCamEnabled: true }), null, false);
    expect(state.followedHeroId).toBeNull();
    expect(effect.stopFollow).toBe(true);
    expect(effect.startFollowHeroId).toBeNull();
    expect(effect.autoCamEnabled).toBe(true);
  });

  test('selecting an id not yet in the scene is fail-closed: exits follow', () => {
    const { state, effect } = reduceSelection(base({ followedHeroId: 'hero-1' }), 'hero-2', false);
    expect(state.followedHeroId).toBeNull();
    expect(effect.stopFollow).toBe(true);
    expect(effect.startFollowHeroId).toBeNull();
  });

  test('deselecting with auto-cam off keeps it off', () => {
    const { effect } = reduceSelection(base({ followedHeroId: 'hero-1', userAutoCamEnabled: false }), null, false);
    expect(effect.autoCamEnabled).toBe(false);
  });
});

describe('reduceManualDrag', () => {
  test('dragging while following exits follow and restores auto-cam', () => {
    const { state, effect } = reduceManualDrag(base({ followedHeroId: 'hero-1', userAutoCamEnabled: true }));
    expect(state.followedHeroId).toBeNull();
    expect(effect.stopFollow).toBe(true);
    expect(effect.autoCamEnabled).toBe(true);
  });

  test('dragging while not following is a no-op (no stopFollow churn)', () => {
    const { state, effect } = reduceManualDrag(base({ followedHeroId: null }));
    expect(state.followedHeroId).toBeNull();
    expect(effect.stopFollow).toBe(false);
    expect(effect.startFollowHeroId).toBeNull();
  });
});

describe('reduceAutoCamToggle', () => {
  test('toggling while following only records intent — auto-cam stays disabled', () => {
    const { state, effect } = reduceAutoCamToggle(base({ followedHeroId: 'hero-1', userAutoCamEnabled: false }), true);
    expect(state.userAutoCamEnabled).toBe(true);
    expect(state.followedHeroId).toBe('hero-1');
    expect(effect.autoCamEnabled).toBe(false);
    expect(effect.stopFollow).toBe(false);
  });

  test('a later exit restores the intent recorded during follow', () => {
    let state = base({ followedHeroId: 'hero-1', userAutoCamEnabled: true });
    // User turns auto-cam OFF while following.
    ({ state } = reduceAutoCamToggle(state, false));
    expect(state.userAutoCamEnabled).toBe(false);
    // Exiting follow must honour the latest OFF intent, not the stale ON snapshot.
    const { effect } = reduceManualDrag(state);
    expect(effect.autoCamEnabled).toBe(false);
  });

  test('toggling while not following applies directly', () => {
    const { effect } = reduceAutoCamToggle(base({ followedHeroId: null }), false);
    expect(effect.autoCamEnabled).toBe(false);
  });
});

describe('reduceHeroRemoved', () => {
  test('removing the followed hero exits follow', () => {
    const { state, effect } = reduceHeroRemoved(base({ followedHeroId: 'hero-1', userAutoCamEnabled: true }), 'hero-1');
    expect(state.followedHeroId).toBeNull();
    expect(effect.stopFollow).toBe(true);
    expect(effect.autoCamEnabled).toBe(true);
  });

  test('removing a different hero is a no-op', () => {
    const { state, effect } = reduceHeroRemoved(base({ followedHeroId: 'hero-1' }), 'hero-2');
    expect(state.followedHeroId).toBe('hero-1');
    expect(effect.stopFollow).toBe(false);
  });
});
