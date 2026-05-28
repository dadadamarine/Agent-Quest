import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcher } from './file-watcher';

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

test('FileWatcher emits onSessionUpdate via fs.watch when a session file is appended', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();
  const file = join(projectPath, 'session-1.jsonl');
  writeFileSync(file, makeToolUseLine('Read') + '\n');

  const updates: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000, // disable the safety poll — only fs.watch may fire
    watchDebounceMs: 20,
    onNewSession: () => {},
    onSessionUpdate: (_sid, _path, newContent) => { updates.push(newContent); },
  });

  await watcher.start();
  appendFileSync(file, makeToolUseLine('Edit') + '\n');
  await Bun.sleep(200);
  watcher.stop();

  expect(updates.length).toBe(1);
  expect(updates[0]).toContain('Edit');
});

test('FileWatcher emits onNewSession via fs.watch for a file created after start', async () => {
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
  writeFileSync(join(projectPath, 'session-new.jsonl'), makeToolUseLine('Bash') + '\n');
  await Bun.sleep(200);
  watcher.stop();

  expect(newSessions).toContain('session-new');
});

test('FileWatcher holds back a partial trailing line until it completes', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();
  const file = join(projectPath, 'session-partial.jsonl');
  writeFileSync(file, makeToolUseLine('Read') + '\n');

  const updates: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000,
    watchDebounceMs: 20,
    onNewSession: () => {},
    onSessionUpdate: (_sid, _path, newContent) => { updates.push(newContent); },
  });

  await watcher.start();

  // Write a line WITHOUT a trailing newline — a mid-write snapshot.
  const partial = makeToolUseLine('Edit');
  appendFileSync(file, partial);
  await Bun.sleep(120);
  // Nothing should be delivered yet: the line is incomplete.
  expect(updates.length).toBe(0);

  // Complete the line.
  appendFileSync(file, '\n');
  await Bun.sleep(120);
  watcher.stop();

  // The completed line is delivered exactly once, in full.
  expect(updates.length).toBe(1);
  expect(updates[0]).toBe(partial + '\n');
});

test('FileWatcher stops emitting after stop()', async () => {
  const { claudeDir, projectPath } = makeClaudeDir();
  const file = join(projectPath, 'session-stop.jsonl');
  writeFileSync(file, makeToolUseLine('Read') + '\n');

  const updates: string[] = [];
  const watcher = new FileWatcher({
    claudeDirs: [claudeDir],
    pollIntervalMs: 60_000,
    watchDebounceMs: 20,
    onNewSession: () => {},
    onSessionUpdate: (_sid, _path, newContent) => { updates.push(newContent); },
  });

  await watcher.start();
  watcher.stop();

  appendFileSync(file, makeToolUseLine('Bash') + '\n');
  await Bun.sleep(150);

  expect(updates.length).toBe(0); // no watcher handle, no scheduled scan
});

test('FileWatcher.start() survives a non-existent config dir (poll fallback)', async () => {
  const watcher = new FileWatcher({
    claudeDirs: ['/tmp/agent-quest-does-not-exist-xyz-9999'],
    pollIntervalMs: 60_000,
    onNewSession: () => {},
    onSessionUpdate: () => {},
  });

  // Must not throw even though projects/ cannot be watched.
  await watcher.start();
  expect(watcher.getConfigDirs()).toEqual(['/tmp/agent-quest-does-not-exist-xyz-9999']);
  watcher.stop();
});
