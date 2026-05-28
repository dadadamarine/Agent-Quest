import { test, expect } from 'bun:test';
import { ScanScheduler } from './scan-scheduler';

test('ScanScheduler runs the initial scan when started', async () => {
  let runs = 0;
  const scheduler = new ScanScheduler({
    scan: async () => { runs++; },
    debounceMs: 0,
    pollMs: 10_000,
  });
  await scheduler.start();
  expect(runs).toBe(1);
  scheduler.stop();
});

test('ScanScheduler never runs two scans concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const scheduler = new ScanScheduler({
    scan: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      runs++;
      await Bun.sleep(20);
      active--;
    },
    debounceMs: 0,
    pollMs: 10_000,
  });

  // Three overlapping scans: the first acquires the guard, the others queue.
  await Promise.all([scheduler.scanNow(), scheduler.scanNow(), scheduler.scanNow()]);
  scheduler.stop();

  expect(maxActive).toBe(1);            // guard serializes
  expect(runs).toBeGreaterThanOrEqual(1);
  expect(runs).toBeLessThanOrEqual(2);  // first pass + at most one queued rescan
});

test('ScanScheduler coalesces a burst of requests into a debounced scan', async () => {
  let runs = 0;
  const scheduler = new ScanScheduler({
    scan: async () => { runs++; },
    debounceMs: 30,
    pollMs: 10_000,
  });
  await scheduler.start();      // runs === 1 (initial)
  scheduler.request();
  scheduler.request();
  scheduler.request();          // burst within one debounce window
  await Bun.sleep(80);
  expect(runs).toBe(2);         // initial + exactly one coalesced scan
  scheduler.stop();
});

test('ScanScheduler.request() is a no-op after stop()', async () => {
  let runs = 0;
  const scheduler = new ScanScheduler({
    scan: async () => { runs++; },
    debounceMs: 10,
    pollMs: 10_000,
  });
  await scheduler.start();      // runs === 1
  scheduler.stop();
  scheduler.request();
  await Bun.sleep(40);
  expect(runs).toBe(1);         // no scan scheduled after stop
});

test('ScanScheduler stops the safety-net poll on stop()', async () => {
  let runs = 0;
  const scheduler = new ScanScheduler({
    scan: async () => { runs++; },
    debounceMs: 0,
    pollMs: 20,
  });
  await scheduler.start();      // runs === 1
  await Bun.sleep(50);          // a couple of poll ticks
  const afterPolling = runs;
  expect(afterPolling).toBeGreaterThan(1);
  scheduler.stop();
  await Bun.sleep(60);
  expect(runs).toBe(afterPolling); // poll no longer fires
});

test('ScanScheduler keeps running when a scan throws', async () => {
  let runs = 0;
  const scheduler = new ScanScheduler({
    scan: async () => {
      runs++;
      if (runs === 1) throw new Error('boom');
    },
    debounceMs: 5,
    pollMs: 10_000,
  });
  await scheduler.start();      // throws internally, caught — runs === 1
  expect(runs).toBe(1);
  scheduler.request();
  await Bun.sleep(40);
  expect(runs).toBe(2);         // recovered, next scan ran
  scheduler.stop();
});
