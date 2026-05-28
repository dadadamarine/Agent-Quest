import { readdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { ScanScheduler } from './scan-scheduler';
import type { SubagentContext } from '../types';

export interface WatcherCallbacks {
  onNewSession: (
    sessionId: string,
    projectPath: string,
    /** Complete-line content the watcher already read (partial trailing line
     * held back). The provider parses this rather than re-reading, so its parse
     * extent matches the byte offset the watcher recorded — no re-delivery. */
    completeContent: string,
    configDir: string,
    subagentCtx: SubagentContext,
  ) => void | Promise<void>;
  onSessionUpdate: (
    sessionId: string,
    projectPath: string,
    newContent: string,
    configDir: string,
    subagentCtx: SubagentContext,
  ) => void;
}

export interface WatcherOptions extends WatcherCallbacks {
  /** Skip JSONL files whose mtime is older than this (ms). Default: 30 minutes. */
  maxAgeMs?: number;
  /** Claude config directories to watch. If omitted, auto-discovers ~/.claude* dirs with a projects/ subdir. */
  claudeDirs?: string[];
  /** Safety-net poll interval (ms). fs.watch drives the fast path; this only
   * catches events fs.watch missed. Default: 4000. */
  pollIntervalMs?: number;
  /** Debounce window for coalescing fs.watch bursts before a rescan (ms). Default: 100. */
  watchDebounceMs?: number;
  /** Attach fs.watch for instant reaction. Default: true. Tests that drive
   * scans manually disable this to stay deterministic. */
  watchEnabled?: boolean;
}

export class FileWatcher {
  private claudeDirs: string[];
  private fileSizes = new Map<string, number>();
  private callbacks: WatcherCallbacks;
  private maxAgeMs: number;
  private readonly pollIntervalMs: number;
  private readonly watchDebounceMs: number;
  private readonly watchEnabled: boolean;
  private scheduler: ScanScheduler | null = null;
  private fsWatchers: FSWatcher[] = [];
  private stopped = false;

  constructor(opts: WatcherOptions) {
    this.callbacks = opts;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 60 * 1000;
    this.claudeDirs = opts.claudeDirs ?? [];
    this.pollIntervalMs = opts.pollIntervalMs ?? 4000;
    this.watchDebounceMs = opts.watchDebounceMs ?? 100;
    this.watchEnabled = opts.watchEnabled ?? true;
  }

  /** Find every ~/.claudeXXX directory that contains a projects/ subdir. */
  static async autoDiscoverDirs(): Promise<string[]> {
    const home = homedir();
    let entries: string[];
    try {
      entries = await readdir(home);
    } catch {
      return [];
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith('.claude')) continue;
      const full = join(home, entry);
      const s = await stat(full).catch(() => null);
      if (s === null || !s.isDirectory()) continue;
      const projects = join(full, 'projects');
      const ps = await stat(projects).catch(() => null);
      if (ps !== null && ps.isDirectory()) {
        dirs.push(full);
      }
    }
    return dirs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.claudeDirs.length === 0) {
      this.claudeDirs = await FileWatcher.autoDiscoverDirs();
    }

    this.scheduler = new ScanScheduler({
      scan: () => this.scan(),
      debounceMs: this.watchDebounceMs,
      pollMs: this.pollIntervalMs,
      label: 'ClaudeProvider',
    });

    // fs.watch is a best-effort fast path. A failed watch must never stop the
    // initial scan or the safety-net poll from running.
    if (this.watchEnabled) this.setupFsWatchers();

    await this.scheduler.start();

    if (this.claudeDirs.length === 0) {
      // Per-provider diagnostic only. If *both* providers end up empty, the
      // bootstrap in index.ts prints a single aggregated warning.
      console.log('[ClaudeProvider] no ~/.claude* dir — provider inactive');
    } else {
      console.log(`[ClaudeProvider] watching ${this.claudeDirs.length} config dir(s) (fs.watch + ${this.pollIntervalMs}ms safety poll):`);
      for (const d of this.claudeDirs) console.log(`  - ${d}`);
    }
  }

  /** Attach a recursive fs.watch to each config dir's projects/ tree. Any event
   * coalesces into a debounced rescan. A missing projects/ (or a platform that
   * rejects the watch) is tolerated — the safety-net poll still covers it. */
  private setupFsWatchers(): void {
    for (const claudeDir of this.claudeDirs) {
      const projectsDir = join(claudeDir, 'projects');
      try {
        const fsWatcher = watch(projectsDir, { recursive: true }, () => {
          this.scheduler?.request();
        });
        fsWatcher.on('error', (err) => {
          console.warn(`[ClaudeProvider] fs.watch error on ${projectsDir} (poll fallback active):`, err);
        });
        this.fsWatchers.push(fsWatcher);
      } catch (err) {
        console.warn(`[ClaudeProvider] cannot watch ${projectsDir} (poll fallback active):`, err);
      }
    }
  }

  /** Config dirs currently being watched. Populated after start() completes. */
  getConfigDirs(): readonly string[] {
    return this.claudeDirs;
  }

  stop(): void {
    this.stopped = true;
    this.scheduler?.stop();
    this.scheduler = null;
    for (const fsWatcher of this.fsWatchers) {
      try {
        fsWatcher.close();
      } catch {
        // Already closed or never opened — nothing to do.
      }
    }
    this.fsWatchers = [];
  }

  async scan(): Promise<void> {
    for (const claudeDir of this.claudeDirs) {
      await this.scanConfigDir(claudeDir);
    }
  }

  private async scanConfigDir(claudeDir: string): Promise<void> {
    const projectsDir = join(claudeDir, 'projects');
    let projectDirs: string[];
    try {
      projectDirs = await readdir(projectsDir);
    } catch {
      return; // projects/ may not exist yet
    }

    for (const projectDir of projectDirs) {
      const projectPath = join(projectsDir, projectDir);
      const projectStat = await stat(projectPath).catch(() => null);
      if (projectStat === null || !projectStat.isDirectory()) continue;

      let files: string[];
      try {
        files = await readdir(projectPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          await this.processJsonlFile(
            join(projectPath, file),
            file.replace('.jsonl', ''),
            claudeDir,
            { isSubagent: false },
          );
          continue;
        }

        // Per-session subdirectories may contain subagent JSONLs at
        // <parentSessionId>/subagents/agent-*.jsonl. The directory name *is*
        // the parent session id — this is the anti-corruption boundary where
        // disk layout becomes domain metadata (`SubagentContext`).
        const parentSessionId = file;
        const subagentsDir = join(projectPath, parentSessionId, 'subagents');
        const subStat = await stat(subagentsDir).catch(() => null);
        if (subStat === null || !subStat.isDirectory()) continue;

        const subFiles = await readdir(subagentsDir).catch(() => null);
        if (subFiles === null) continue;

        for (const subFile of subFiles) {
          if (!subFile.endsWith('.jsonl')) continue;
          await this.processJsonlFile(
            join(subagentsDir, subFile),
            subFile.replace('.jsonl', ''),
            claudeDir,
            { isSubagent: true, parentSessionId },
          );
        }
      }
    }
  }

  private async processJsonlFile(
    filePath: string,
    sessionId: string,
    claudeDir: string,
    subagentCtx: SubagentContext,
  ): Promise<void> {
    const fileStat = await stat(filePath).catch(() => null);
    if (fileStat === null) return;
    // A stop() that lands during an in-flight scan must not emit afterwards.
    if (this.stopped) return;

    const previousSize = this.fileSizes.get(filePath);
    const currentSize = fileStat.size;

    if (previousSize === undefined) {
      // Skip stale session files (not modified recently)
      const ageMs = Date.now() - fileStat.mtimeMs;
      if (ageMs > this.maxAgeMs) {
        // Remember the size so we don't re-check every poll,
        // but still react if the file grows later (session resumes)
        this.fileSizes.set(filePath, currentSize);
        return;
      }
      // New session file. Read once and hand the provider only the complete
      // lines, recording exactly those bytes. A session discovered mid-write
      // would otherwise either lose its truncated trailing line (if we marked
      // the full size consumed) or re-deliver a complete-but-unterminated line
      // (if the provider re-read the whole file while we held the bytes back).
      const text = await Bun.file(filePath).text();
      const lastNewlineIndex = text.lastIndexOf('\n');
      const complete = lastNewlineIndex === -1 ? '' : text.slice(0, lastNewlineIndex + 1);
      this.fileSizes.set(filePath, Buffer.byteLength(complete, 'utf8'));
      if (this.stopped) return; // stop() landed during the awaited read — don't emit
      await this.callbacks.onNewSession(sessionId, filePath, complete, claudeDir, subagentCtx);
    } else if (currentSize > previousSize) {
      // File grew — read only the new bytes
      const fd = Bun.file(filePath);
      const newBytes = fd.slice(previousSize, currentSize);
      const newContent = await newBytes.text();

      // Guard against partial JSONL writes: an fs.watch-driven scan can catch
      // Claude mid-write, so the tail may not end with '\n'. Process only up to
      // the last newline and hold back the trailing partial bytes until a later
      // scan completes the line — otherwise advancing fileSizes past a half-line
      // would permanently drop the event on that line.
      const lastNewlineIndex = newContent.lastIndexOf('\n');
      if (lastNewlineIndex === -1) return; // no complete line yet — don't advance
      const complete = newContent.slice(0, lastNewlineIndex + 1);

      // Advance by the BYTE length of the processed chunk (not char length) so
      // the offset stays correct for multi-byte UTF-8 content.
      this.fileSizes.set(filePath, previousSize + Buffer.byteLength(complete, 'utf8'));
      if (this.stopped) return; // stop() landed during the awaited read — don't emit
      this.callbacks.onSessionUpdate(sessionId, filePath, complete, claudeDir, subagentCtx);
    }
  }
}
