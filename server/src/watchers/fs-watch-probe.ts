import { watch, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Probe whether `fs.watch` actually delivers events in the current environment.
 *
 * The providers always wire up fs.watch and degrade to the safety-net poll when
 * events never arrive, so production is unaffected by the answer. But some
 * environments suppress filesystem event delivery entirely — notably macOS
 * sandboxes (seatbelt blocks FSEvents) and certain CI containers / network
 * filesystems. There the event-driven fast path can't be exercised, so the
 * integration tests that depend on it should be skipped rather than reported as
 * failures. The deterministic scheduler and manual-scan tests still cover the
 * reaction logic in every environment.
 */
export async function fsWatchDeliversEvents(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'fswatch-probe-'));
  let fired = false;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dir, { recursive: true }, () => { fired = true; });
  } catch {
    rmSyncSafe(dir);
    return false;
  }
  try {
    await Bun.sleep(20);
    writeFileSync(join(dir, 'probe.txt'), 'x');
    for (let i = 0; i < 25 && !fired; i++) await Bun.sleep(20);
  } finally {
    try { watcher.close(); } catch { /* already closed */ }
    rmSyncSafe(dir);
  }
  return fired;
}

function rmSyncSafe(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}
