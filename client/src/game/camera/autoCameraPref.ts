/**
 * Persistence for the auto-camera on/off preference.
 *
 * localStorage is the single source of truth for whether the village camera
 * automatically follows active agents. Both TopBar (UI) and VillageScene read
 * it, but only TopBar writes (on user toggle) so write responsibility stays in
 * one place. Reads default to ON — the auto camera is the headline behaviour of
 * issue #38, and a fresh visitor should see it work without opting in.
 */

const STORAGE_KEY = 'agent-quest:autoCamera';

/** Read the persisted preference. Defaults to ON when unset or when storage is
 * unavailable (privacy mode, quota/security exceptions, non-browser test env). */
export function readAutoCameraPreference(): boolean {
  try {
    if (typeof window === 'undefined') return true;
    // Only an explicit 'off' disables it; anything else (including missing) is ON.
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Persist the preference. Swallows storage failures so a toggle never throws. */
export function writeAutoCameraPreference(enabled: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    /* storage unavailable — preference simply isn't persisted this session */
  }
}
