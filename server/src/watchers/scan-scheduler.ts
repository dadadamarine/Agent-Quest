export interface ScanSchedulerOptions {
  /**
   * The provider-owned scan routine. Must read only *new* bytes (size-diff
   * tracking) so that re-running it is idempotent — the scheduler may invoke it
   * again immediately to catch changes that arrived mid-scan.
   */
  scan: () => Promise<void>;
  /** Debounce window to coalesce fs.watch event bursts (ms). Default 100. */
  debounceMs?: number;
  /** Safety-net poll interval to catch events fs.watch missed (ms). Default 4000. */
  pollMs?: number;
  /** Label used in error logs (e.g. 'ClaudeProvider'). */
  label?: string;
}

/**
 * Drives a provider's scan routine from two sources — fast fs.watch events and
 * a slow safety-net poll — while owning the concurrency policy shared by every
 * file watcher: serialize overlapping scans, queue exactly one rescan for
 * changes that land mid-scan, and emit nothing once stopped.
 *
 * Each provider keeps its own directory traversal and parsing; only the
 * scheduling/guard invariant lives here so it can't drift between providers.
 */
export class ScanScheduler {
  private readonly scanFn: () => Promise<void>;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly label: string;

  private scanning = false;
  private rescanQueued = false;
  private stopped = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ScanSchedulerOptions) {
    this.scanFn = opts.scan;
    this.debounceMs = opts.debounceMs ?? 100;
    this.pollMs = opts.pollMs ?? 4000;
    this.label = opts.label ?? 'ScanScheduler';
  }

  /** Run an initial scan to completion, then arm the safety-net poll. */
  async start(): Promise<void> {
    await this.runGuarded();
    if (this.stopped) return;
    this.pollTimer = setInterval(() => {
      void this.runGuarded();
    }, this.pollMs);
  }

  /**
   * Request a scan in response to an fs.watch event. Trailing-edge debounced:
   * the first request arms a timer and the scan runs `debounceMs` later;
   * further requests within that window are coalesced into the same run, so a
   * burst of file writes produces a single scan.
   */
  request(): void {
    if (this.stopped || this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runGuarded();
    }, this.debounceMs);
  }

  /** Trigger an immediate guarded scan (initial scan path and tests). */
  async scanNow(): Promise<void> {
    await this.runGuarded();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async runGuarded(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) {
      // A scan is already in flight — record that the latest state still needs
      // a pass so the in-flight loop runs once more after it finishes.
      this.rescanQueued = true;
      return;
    }
    this.scanning = true;
    try {
      do {
        this.rescanQueued = false;
        try {
          await this.scanFn();
        } catch (err) {
          console.error(`[${this.label}] scan error:`, err);
        }
      } while (this.rescanQueued && !this.stopped);
    } finally {
      this.scanning = false;
    }
  }
}
