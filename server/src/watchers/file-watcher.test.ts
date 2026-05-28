import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcher } from './file-watcher';
import { fsWatchDeliversEvents } from './fs-watch-probe';

// fs.watch event delivery is environment-dependent — macOS sandboxes and some
// CI containers suppress it. Integration tests that need a real OS event run
// only where events fire; the reaction logic is covered deterministically by
// the manual-scan tests below (and by scan-scheduler.test.ts) in every env.
const FS_WATCH = await fsWatchDeliversEvents();
const watchTest = FS_WATCH ? test : test.skip;
if (!FS_WATCH) {
  console.warn('[file-watcher.test] fs.watch events unavailable here — skipping fs.watch integration tests');
}

function makeClaudeDir(): { claudeDir: string; projectPath: string } {
  const claudeDir = mkdtempSync(join(tmpdir(), 'claude-watch-'));
  const projectPath = join(claudeDir, 'projects', 'proj-a');
  mkdirSync(projectPath, { recursive: true });
  return { claudeDir, projectPath };
}

function makeToolUseLine(tool: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: tool, input: {} }] },
    timestamp: new Date().toISOString(),
  });
}

// --- Deterministic logic tests: fs.watch disabled, scans driven manually ---

test('FileWatcher emits onNewSession then onSessionUpdate across manual scans', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();
  const file = join(projectPath, 'session-1.jsonl');
  writeFileSync(file, makeToolUseLine('Read') + '\n');

  const newSessions: string[] = [];
  const updates: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000,
    watchEnabled: false,
    onNewSession: (sid) => { newSessions.push(sid); },
    onSessionUpdate: (_sid, _path, newContent) => { updates.push(newContent); },
  });

  await watcher.start(); // initial scan discovers the existing file
  expect(newSessions).toEqual(['session-1']);
  expect(updates.length).toBe(0);

  appendFileSync(file, makeToolUseLine('Edit') + '\n');
  await watcher.scan();
  expect(updates.length).toBe(1);
  expect(updates[0]).toContain('Edit');

  watcher.stop();
});

test('FileWatcher holds back a partial trailing line on append until it completes', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();
  const file = join(projectPath, 'session-append.jsonl');
  writeFileSync(file, makeToolUseLine('Read') + '\n');

  const updates: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000,
    watchEnabled: false,
    onNewSession: () => {},
    onSessionUpdate: (_sid, _path, newContent) => { updates.push(newContent); },
  });

  await watcher.start();

  const partial = makeToolUseLine('Edit'); // no trailing newline — a mid-write snapshot
  appendFileSync(file, partial);
  await watcher.scan();
  expect(updates.length).toBe(0); // incomplete line not delivered yet

  appendFileSync(file, '\n');
  await watcher.scan();
  expect(updates.length).toBe(1);
  expect(updates[0]).toBe(partial + '\n'); // delivered once, in full

  watcher.stop();
});

test('FileWatcher holds back a partial trailing line on first discovery until it completes', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();
  const file = join(projectPath, 'session-fd.jsonl');
  const firstLine = makeToolUseLine('Read') + '\n';
  const partial = makeToolUseLine('Edit'); // no trailing newline
  // File already exists, caught mid-write, BEFORE the watcher's first scan.
  writeFileSync(file, firstLine + partial);

  const newSessions: string[] = [];
  const updates: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000,
    watchEnabled: false,
    onNewSession: (sid) => { newSessions.push(sid); },
    onSessionUpdate: (_sid, _path, newContent) => { updates.push(newContent); },
  });

  await watcher.start(); // first-sight discovery while the last line is partial
  expect(newSessions).toEqual(['session-fd']);
  expect(updates.length).toBe(0); // partial trailing line not consumed

  appendFileSync(file, '\n'); // the line completes
  await watcher.scan();
  expect(updates.length).toBe(1);
  expect(updates[0]).toBe(partial + '\n'); // previously-partial line delivered, not lost

  watcher.stop();
});

test('FileWatcher.start() survives a non-existent config dir (poll fallback)', async () => {
  const watcher = new FileWatcher({
    claudeDirs: ['/tmp/agent-quest-does-not-exist-xyz-9999'],
    pollIntervalMs: 60_000,
    onNewSession: () => {},
    onSessionUpdate: () => {},
  });

  await watcher.start(); // must not throw even though projects/ cannot be watched
  expect(watcher.getConfigDirs()).toEqual(['/tmp/agent-quest-does-not-exist-xyz-9999']);
  watcher.stop();
});

test('FileWatcher emits nothing after stop(), even if a later scan runs', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();
  const file = join(projectPath, 'session-stop.jsonl');
  writeFileSync(file, makeToolUseLine('Read') + '\n');

  const updates: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000,
    watchEnabled: false,
    onNewSession: () => {},
    onSessionUpdate: (_sid, _path, newContent) => { updates.push(newContent); },
  });

  await watcher.start();
  watcher.stop();

  appendFileSync(file, makeToolUseLine('Bash') + '\n');
  await watcher.scan(); // a stray/in-flight scan must not emit after stop
  expect(updates.length).toBe(0);
});

// --- fs.watch integration tests (skipped where OS events are unavailable) ---

watchTest('FileWatcher reacts to appends via fs.watch (no manual scan)', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();
  const file = join(projectPath, 'session-w1.jsonl');
  writeFileSync(file, makeToolUseLine('Read') + '\n');

  const updates: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000, // safety poll off — only fs.watch can fire
    watchDebounceMs: 20,
    onNewSession: () => {},
    onSessionUpdate: (_sid, _path, newContent) => { updates.push(newContent); },
  });

  await watcher.start();
  appendFileSync(file, makeToolUseLine('Edit') + '\n');
  await Bun.sleep(300);
  watcher.stop();

  expect(updates.length).toBe(1);
  expect(updates[0]).toContain('Edit');
});

watchTest('FileWatcher reacts to new files via fs.watch (no manual scan)', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();

  const newSessions: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000,
    watchDebounceMs: 20,
    onNewSession: (sid) => { newSessions.push(sid); },
    onSessionUpdate: () => {},
  });

  await watcher.start();
  writeFileSync(join(projectPath, 'session-w2.jsonl'), makeToolUseLine('Bash') + '\n');
  await Bun.sleep(300);
  watcher.stop();

  expect(newSessions).toContain('session-w2');
});
