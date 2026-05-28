import { readdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { parseCodexLine, parseCodexSessionMeta } from '../parsers/codex-parser';
import { ScanScheduler } from '../watchers/scan-scheduler';
import type { ParsedEvent } from '../parsers/session-parser';
import type { AgentSource } from '../types';
import type { ProviderHandlers, SessionProvider } from './types';

export interface CodexProviderOptions {
  /** Defaults to `~/.codex`. */
  codexRoot?: string;
  /** Safety-net poll interval (ms). fs.watch drives the fast path; this only
   * catches events fs.watch missed. Default 4000. */
  scanIntervalMs?: number;
  /** Ignore rollout files whose mtime is older than this when first seen. Default 3h. */
  maxAgeMs?: number;
  /** Debounce window for coalescing fs.watch bursts before a rescan (ms). Default 100. */
  watchDebounceMs?: number;
  /** Attach fs.watch for instant reaction. Default true. Tests that drive scans
   * manually disable this to stay deterministic. */
  watchEnabled?: boolean;
}

interface TrackedFile {
  sessionId: string;
  sessionCwd: string;
  size: number;
}

export class CodexProvider implements SessionProvider {
  readonly source: AgentSource = 'codex';

  private readonly codexRoot: string;
  private readonly scanIntervalMs: number;
  private readonly maxAgeMs: number;
  private readonly watchDebounceMs: number;
  private readonly watchEnabled: boolean;
  private handlers: ProviderHandlers | null = null;
  private scheduler: ScanScheduler | null = null;
  private fsWatcher: FSWatcher | null = null;
  private tracked = new Map<string, TrackedFile>();
  /** Set when `start()` confirmed the codex root directory exists. Drives
   * `getConfigDirs()` — we must not advertise a non-existent install, otherwise
   * the client suppresses its missing-install banner. */
  private rootExists = false;

  constructor(opts: CodexProviderOptions = {}) {
    this.codexRoot = opts.codexRoot ?? join(homedir(), '.codex');
    this.scanIntervalMs = opts.scanIntervalMs ?? 4000;
    this.maxAgeMs = opts.maxAgeMs ?? 3 * 60 * 60_000;
    this.watchDebounceMs = opts.watchDebounceMs ?? 100;
    this.watchEnabled = opts.watchEnabled ?? true;
  }

  async start(handlers: ProviderHandlers): Promise<void> {
    this.handlers = handlers;

    const rootStat = await stat(this.codexRoot).catch(() => null);
    if (rootStat === null || !rootStat.isDirectory()) {
      console.log(`[CodexProvider] ${this.codexRoot} not found — provider inactive`);
      return;
    }
    this.rootExists = true;

    this.scheduler = new ScanScheduler({
      scan: () => this.traverse(),
      debounceMs: this.watchDebounceMs,
      pollMs: this.scanIntervalMs,
      label: 'CodexProvider',
    });

    // fs.watch is a best-effort fast path. A failed watch must never stop the
    // initial scan or the safety-net poll from running.
    if (this.watchEnabled) this.setupFsWatch();

    await this.scheduler.start();

    console.log(`[CodexProvider] watching ${this.codexRoot} (fs.watch + ${this.scanIntervalMs}ms safety poll)`);
  }

  /** Attach a recursive fs.watch to the sessions tree. Any event coalesces into
   * a debounced rescan. A missing sessions/ (or a platform that rejects the
   * watch) is tolerated — the safety-net poll still covers it. */
  private setupFsWatch(): void {
    const sessionsDir = join(this.codexRoot, 'sessions');
    try {
      this.fsWatcher = watch(sessionsDir, { recursive: true }, () => {
        this.scheduler?.request();
      });
      this.fsWatcher.on('error', (err) => {
        console.warn(`[CodexProvider] fs.watch error on ${sessionsDir} (poll fallback active):`, err);
      });
    } catch (err) {
      console.warn(`[CodexProvider] cannot watch ${sessionsDir} (poll fallback active):`, err);
    }
  }

  stop(): void {
    this.scheduler?.stop();
    this.scheduler = null;
    if (this.fsWatcher !== null) {
      try {
        this.fsWatcher.close();
      } catch {
        // Already closed or never opened — nothing to do.
      }
      this.fsWatcher = null;
    }
    this.handlers = null;
  }

  getConfigDirs(): readonly string[] {
    return this.rootExists ? [this.codexRoot] : [];
  }

  /** Guarded scan entry point. Routed through the scheduler so the fs.watch
   * fast path, the safety poll, and tests all share one re-entrancy guard.
   * Kept off the public SessionProvider surface — tests reach it via cast. */
  private async scan(): Promise<void> {
    if (this.scheduler !== null) {
      await this.scheduler.scanNow();
      return;
    }
    await this.traverse();
  }

  private async traverse(): Promise<void> {
    const sessionsDir = join(this.codexRoot, 'sessions');
    const files = await listRolloutFiles(sessionsDir).catch(() => [] as string[]);
    for (const filePath of files) {
      await this.processFile(filePath);
    }
  }

  private async processFile(filePath: string): Promise<void> {
    const handlers = this.handlers;
    if (handlers === null) return;

    const s = await stat(filePath).catch(() => null);
    if (s === null) return;

    const tracked = this.tracked.get(filePath);
    if (tracked === undefined) {
      // First time we see this file. Skip if too old.
      const age = Date.now() - s.mtimeMs;
      if (age > this.maxAgeMs) {
        // Remember size so we still react if it resumes later, but don't emit a start event.
        this.tracked.set(filePath, { sessionId: '', sessionCwd: '', size: s.size });
        return;
      }

      const contents = await Bun.file(filePath).text();
      const firstLine = contents.split('\n', 1)[0] ?? '';
      const meta = parseCodexSessionMeta(firstLine);
      if (meta === null) {
        // Malformed rollout (no session_meta as first line) — skip for now, recheck next poll.
        return;
      }
      // Parse only complete lines and track only their byte extent. fs.watch can
      // discover a rollout while Codex is still writing its final line; parsing
      // the whole file but recording the full size would either lose a truncated
      // line or re-deliver a complete-but-unterminated one once it gets its '\n'.
      // (No newline at all → fall back to s.size; the lone first line already
      // parsed cleanly enough to yield meta.)
      const lastCompleteNewline = contents.lastIndexOf('\n');
      const completePortion = lastCompleteNewline === -1
        ? contents
        : contents.slice(0, lastCompleteNewline + 1);
      const trackedSize = lastCompleteNewline === -1
        ? s.size
        : Buffer.byteLength(completePortion, 'utf8');
      const events: ParsedEvent[] = [];
      for (const line of completePortion.split('\n')) {
        if (line.trim() === '') continue;
        const ev = parseCodexLine(line, meta.id, meta.cwd);
        if (ev !== null) events.push(ev);
      }
      this.tracked.set(filePath, { sessionId: meta.id, sessionCwd: meta.cwd, size: trackedSize });
      if (this.handlers === null) return; // stop() landed mid-scan — don't emit
      await handlers.onSessionStart({
        source: this.source,
        sessionId: meta.id,
        configDir: this.codexRoot,
        events,
      });
      return;
    }

    // Follow-up scan.
    if (s.size <= tracked.size) return;

    // Stale-on-first-sight sentinel that just grew: the thread resumed after
    // our grace window. Discard the sentinel and re-run as a fresh discovery
    // (single hop, no infinite recursion — second call always finds a non-empty
    // tracked entry OR a real sessionId).
    if (tracked.sessionId === '') {
      this.tracked.delete(filePath);
      await this.processFile(filePath);
      return;
    }

    const fd = Bun.file(filePath);
    const newBytes = fd.slice(tracked.size, s.size);
    const newContent = await newBytes.text();

    // Guard against partial JSONL writes: if polling catches Codex mid-write,
    // the tail will not end with '\n'. Process only up to the last newline; hold
    // back the trailing partial bytes until the next scan completes the line.
    const lastNlIdx = newContent.lastIndexOf('\n');
    if (lastNlIdx === -1) {
      // No complete line yet — wait for next scan, don't advance.
      return;
    }
    const complete = newContent.slice(0, lastNlIdx + 1);

    const events: ParsedEvent[] = [];
    for (const line of complete.split('\n')) {
      if (line.trim() === '') continue;
      const ev = parseCodexLine(line, tracked.sessionId, tracked.sessionCwd);
      if (ev !== null) events.push(ev);
    }
    // Advance by the BYTE length of the processed chunk (not char length) —
    // required for UTF-8 content, safe for pure ASCII. `\n` is always 1 byte
    // so the offset lines up exactly with the file position.
    tracked.size += Buffer.byteLength(complete, 'utf8');

    if (events.length === 0) return;
    if (this.handlers === null) return; // stop() landed mid-scan — don't emit

    handlers.onSessionEvents({
      source: this.source,
      sessionId: tracked.sessionId,
      configDir: this.codexRoot,
      events,
    });
  }
}

async function listRolloutFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const entries = await readdir(root).catch(() => [] as string[]);
  const out: string[] = [];
  for (const e of entries) {
    const p = join(root, e);
    const s = await stat(p).catch(() => null);
    if (s === null) continue;
    if (s.isDirectory()) {
      const sub = await listRolloutFiles(p, depth + 1);
      out.push(...sub);
    } else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) {
      out.push(p);
    }
  }
  return out;
}
