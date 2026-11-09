import {
  createGitHubPrClient,
  type CiState,
  type GitHubPrClient,
  type GitHubPrError,
  type GitHubPrResult,
  type GitHubPrTarget,
  type PrCheckDetail,
  type PrLifecycle,
} from "./github";

export const VISIBLE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** First sight also counts as an entry: rapid leave/re-enter never spawns a storm. */
export const HOVER_REENTRY_THROTTLE_MS = 2_000;

export type GitHubPrSnapshot = Readonly<{
  target: GitHubPrTarget;
  url: string;
  title: string | null;
  lifecycle: PrLifecycle | "unknown";
  ci: CiState;
  checks: readonly PrCheckDetail[];
  reason: string | null;
  error: GitHubPrError | null;
  lastSuccessfulFetchAt: number | null;
  lastAttemptAt: number | null;
  refreshing: boolean;
}>;

export type GitHubPrCacheOptions = Readonly<{
  client?: GitHubPrClient;
  now?: () => number;
  onChange?: (snapshot: GitHubPrSnapshot) => void;
  concurrency?: number;
  /** Maximum unpinned history entries; visible entries are additional. */
  maxEntries?: number;
}>;

type Task = {
  entry: Entry;
  controller: AbortController;
  promise: Promise<GitHubPrSnapshot>;
  resolve: (snapshot: GitHubPrSnapshot) => void;
  reject: (error: unknown) => void;
  settled: boolean;
};
type Entry = { snapshot: GitHubPrSnapshot; task: Task | null };

/**
 * UI owns visibility and timers: call setVisible once per frame before firstSight
 * or refreshVisible; call hoverEntry on pointer entry.
 * There is no background polling here. Cache misses and stale redisplayed links
 * fetch immediately; refreshes become due 5 minutes after the last attempt
 * (including failures).
 * Unpinned history is LRU bounded (256 by default); visible entries are pinned,
 * including queued/running requests. Total entries <= maxEntries + visibleCount.
 * Shrinking visibility prunes excess history and aborts its outstanding work.
 * Expected failures clear stale colors/check details but retain lastSuccessfulFetchAt.
 */
export class GitHubPrCache {
  private readonly client: GitHubPrClient;
  private readonly now: () => number;
  private readonly onChange: GitHubPrCacheOptions["onChange"];
  private readonly concurrency: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();
  private visible = new Set<string>();
  private readonly queue: Task[] = [];
  private active = 0;
  private disposed = false;

  constructor(options: GitHubPrCacheOptions = {}) {
    // FALLBACK: the optional integrations use the specified production defaults.
    this.client = options.client ?? createGitHubPrClient();
    // FALLBACK: wall clock is used unless a test injects deterministic time.
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
    // FALLBACK: three subprocesses is the agreed concurrency budget.
    this.concurrency = options.concurrency ?? 3;
    // FALLBACK: 256 unpinned LRU entries bounds chat history without a new dependency.
    this.maxEntries = options.maxEntries ?? 256;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1
      || !Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("PR cache concurrency and capacity must be positive integers");
    }
  }

  get(target: GitHubPrTarget): GitHubPrSnapshot | undefined {
    const entry = this.entries.get(target.canonicalUrl);
    if (entry === undefined) return undefined;
    this.touch(entry);
    return entry.snapshot;
  }

  /** Replace exact canonical pins without creating entries, fetching, or touching LRU. */
  setVisible(targets: Iterable<GitHubPrTarget>): void {
    if (this.disposed) return;
    this.visible = new Set(Array.from(targets, (target) => target.canonicalUrl));
    this.pruneHistory();
  }

  firstSight(target: GitHubPrTarget): Promise<GitHubPrSnapshot> {
    if (this.disposed) return Promise.resolve(this.unavailable(target, "PR cache disposed"));
    const entry = this.entry(target);
    if (entry.task !== null) return entry.task.promise;
    if (entry.snapshot.lastAttemptAt !== null && this.now() - entry.snapshot.lastAttemptAt < VISIBLE_REFRESH_INTERVAL_MS) {
      return Promise.resolve(entry.snapshot);
    }
    return this.refresh(entry);
  }

  hoverEntry(target: GitHubPrTarget): Promise<GitHubPrSnapshot> {
    if (this.disposed) return Promise.resolve(this.unavailable(target, "PR cache disposed"));
    const entry = this.entry(target);
    if (entry.task !== null) return entry.task.promise;
    if (entry.snapshot.lastAttemptAt !== null && this.now() - entry.snapshot.lastAttemptAt < HOVER_REENTRY_THROTTLE_MS) {
      return Promise.resolve(entry.snapshot);
    }
    return this.refresh(entry);
  }

  refreshVisible(targets: Iterable<GitHubPrTarget>): Promise<readonly GitHubPrSnapshot[]> {
    const unique = new Map<string, GitHubPrTarget>();
    for (const target of targets) unique.set(target.canonicalUrl, target);
    return Promise.all([...unique.values()].map((target) => {
      if (this.disposed) return this.firstSight(target);
      const entry = this.entry(target);
      if (entry.task !== null) return entry.task.promise;
      if (entry.snapshot.lastAttemptAt !== null && this.now() - entry.snapshot.lastAttemptAt < VISIBLE_REFRESH_INTERVAL_MS) {
        return Promise.resolve(entry.snapshot);
      }
      return this.refresh(entry);
    }));
  }

  /** Idempotent; running and queued callers settle immediately with unknown. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) this.cancel(entry, "PR cache disposed");
    this.queue.length = 0;
    this.entries.clear();
    this.visible.clear();
  }

  private unavailable(target: GitHubPrTarget, reason: string): GitHubPrSnapshot {
    return {
      target, url: target.canonicalUrl, title: null, lifecycle: "unknown", ci: "unknown", checks: [], reason,
      error: { kind: "aborted", message: reason },
      lastSuccessfulFetchAt: null, lastAttemptAt: null, refreshing: false,
    };
  }

  private touch(entry: Entry): void {
    this.entries.delete(entry.snapshot.target.canonicalUrl);
    this.entries.set(entry.snapshot.target.canonicalUrl, entry);
  }

  private entry(target: GitHubPrTarget): Entry {
    const existing = this.entries.get(target.canonicalUrl);
    if (existing !== undefined) { this.touch(existing); return existing; }
    const entry: Entry = {
      snapshot: { ...this.unavailable(target, "PR status has not been fetched"), error: null }, task: null,
    };
    this.entries.set(target.canonicalUrl, entry);
    if (!this.visible.has(target.canonicalUrl)) this.pruneHistory();
    return entry;
  }

  private pruneHistory(): void {
    let unpinned = 0;
    for (const key of this.entries.keys()) {
      if (!this.visible.has(key)) unpinned++;
    }
    if (unpinned <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (this.visible.has(key)) continue;
      this.entries.delete(key);
      this.cancel(entry, "PR cache entry evicted");
      unpinned--;
      if (unpinned <= this.maxEntries) break;
    }
  }

  private publish(entry: Entry, snapshot: GitHubPrSnapshot): void {
    entry.snapshot = snapshot;
    if (!this.disposed && this.onChange !== undefined) this.onChange(snapshot);
  }

  private refresh(entry: Entry): Promise<GitHubPrSnapshot> {
    if (entry.task !== null) return entry.task.promise;
    // Promise.withResolvers is available in the plugin's Bun runtime.
    const deferred = Promise.withResolvers<GitHubPrSnapshot>();
    const task: Task = {
      entry, controller: new AbortController(), promise: deferred.promise,
      resolve: deferred.resolve, reject: deferred.reject, settled: false,
    };
    entry.task = task;
    this.queue.push(task);
    this.publish(entry, { ...entry.snapshot, refreshing: true, lastAttemptAt: this.now() });
    this.drain();
    return task.promise;
  }

  private drain(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      if (task.settled) continue;
      this.active++;
      this.client.fetch(task.entry.snapshot.target, task.controller.signal)
        .then((result) => this.complete(task, result))
        .catch((error: unknown) => {
          // Unexpected programmer errors propagate to the requesting UI caller.
          if (!task.settled) {
            task.settled = true;
            task.entry.task = null;
            task.entry.snapshot = { ...task.entry.snapshot, refreshing: false };
            task.reject(error);
          }
        })
        .finally(() => { this.active--; this.drain(); });
    }
  }

  private complete(task: Task, result: GitHubPrResult): void {
    if (task.settled || this.disposed) return;
    const previous = task.entry.snapshot;
    const snapshot: GitHubPrSnapshot = result.ok ? {
      ...previous, ...result.value, reason: result.value.ciReason, error: null,
      lastSuccessfulFetchAt: this.now(), refreshing: false,
    } : {
      ...previous, title: null, lifecycle: "unknown", ci: "unknown", checks: [], reason: result.error.message,
      error: result.error, refreshing: false,
    };
    task.entry.task = null;
    this.publish(task.entry, snapshot);
    task.settled = true;
    task.resolve(snapshot);
  }

  private cancel(entry: Entry, reason: string): void {
    const task = entry.task;
    if (task === null) return;
    task.settled = true;
    entry.task = null;
    task.controller.abort();
    const queuedIndex = this.queue.indexOf(task);
    if (queuedIndex !== -1) this.queue.splice(queuedIndex, 1);
    const snapshot = {
      ...this.unavailable(entry.snapshot.target, reason),
      lastSuccessfulFetchAt: entry.snapshot.lastSuccessfulFetchAt,
      lastAttemptAt: entry.snapshot.lastAttemptAt,
    };
    this.publish(entry, snapshot);
    task.resolve(snapshot);
  }
}
