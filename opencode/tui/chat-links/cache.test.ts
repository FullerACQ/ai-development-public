import { describe, expect, test } from "bun:test";
import { GitHubPrCache, HOVER_REENTRY_THROTTLE_MS, VISIBLE_REFRESH_INTERVAL_MS, type GitHubPrSnapshot } from "./cache";
import { parseGitHubPrTarget, type GitHubPrClient, type GitHubPrResult, type GitHubPrTarget } from "./github";

function target(number = 1): GitHubPrTarget {
  const parsed = parseGitHubPrTarget(`https://github.com/owner/repo/pull/${number}`);
  if (parsed === null) throw new Error("Invalid test target");
  return parsed;
}

function successful(pr: GitHubPrTarget): GitHubPrResult {
  return { ok: true, value: {
    target: pr, url: pr.canonicalUrl, title: "A PR", lifecycle: "open", ci: "passed", ciReason: null,
    checks: [{ name: "build", outcome: "passed", url: "https://ci.example.com/build" }],
  } };
}

function controlledClient() {
  const calls: { target: GitHubPrTarget; signal: AbortSignal; resolve: (result: GitHubPrResult) => void }[] = [];
  const client: GitHubPrClient = {
    fetch(pr, signal) {
      if (signal === undefined) throw new Error("Cache requests require a signal");
      const deferred = Promise.withResolvers<GitHubPrResult>();
      calls.push({ target: pr, signal, resolve: deferred.resolve });
      return deferred.promise;
    },
  };
  return { client, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GitHubPrCache", () => {
  test("first sight dedupes all parallel requests for the canonical PR", async () => {
    const { client, calls } = controlledClient();
    const changes: GitHubPrSnapshot[] = [];
    const cache = new GitHubPrCache({ client, now: () => 100, onChange: (snapshot) => changes.push(snapshot) });
    const one = cache.firstSight(target());
    const tab = parseGitHubPrTarget("https://github.com/OWNER/REPO/pull/1/files#diff");
    if (tab === null) throw new Error("Invalid test target");
    const two = cache.firstSight(tab);
    expect(two).toBe(one);
    expect(cache.hoverEntry(target())).toBe(one);
    expect(calls).toHaveLength(1);
    expect(cache.get(target())?.refreshing).toBe(true);
    calls[0]!.resolve(successful(target()));
    const snapshot = await one;
    expect(snapshot).toMatchObject({ ci: "passed", lifecycle: "open", lastSuccessfulFetchAt: 100, refreshing: false });
    await cache.firstSight(target());
    expect(calls).toHaveLength(1);
    expect(changes).toHaveLength(2);
    cache.dispose();
  });

  test("hover entry throttles for 2s, then refreshes regardless of the 5-minute cadence", async () => {
    let now = 0;
    let calls = 0;
    const client: GitHubPrClient = { fetch: async (pr) => { calls++; return successful(pr); } };
    const cache = new GitHubPrCache({ client, now: () => now });
    await cache.firstSight(target());
    now = HOVER_REENTRY_THROTTLE_MS - 1;
    await cache.hoverEntry(target());
    expect(calls).toBe(1);
    now++;
    await cache.hoverEntry(target());
    expect(calls).toBe(2);
    now++;
    await cache.hoverEntry(target());
    expect(calls).toBe(2);
    cache.dispose();
  });

  test("redisplaying a stale target immediately refreshes and dedupes the visible timer", async () => {
    let now = 100;
    const { client, calls } = controlledClient();
    const cache = new GitHubPrCache({ client, now: () => now });
    const initial = cache.firstSight(target());
    calls[0]!.resolve(successful(target()));
    await initial;
    await flush();
    now += VISIBLE_REFRESH_INTERVAL_MS - 1;
    await cache.firstSight(target());
    expect(calls).toHaveLength(1);
    now++;
    const refreshed = cache.firstSight(target());
    expect(calls).toHaveLength(2);
    expect(cache.firstSight(target())).toBe(refreshed);
    const visible = cache.refreshVisible([target()]);
    expect(calls).toHaveLength(2);
    expect(cache.get(target())?.refreshing).toBe(true);
    calls[1]!.resolve(successful(target()));
    expect((await refreshed).lastSuccessfulFetchAt).toBe(now);
    expect((await visible)[0]?.lastSuccessfulFetchAt).toBe(now);
    cache.dispose();
  });

  test("redisplaying stale unavailable data retries without a hover or timer", async () => {
    let now = 0;
    let calls = 0;
    const cache = new GitHubPrCache({ now: () => now, client: {
      fetch: async (pr) => { calls++; return calls === 1
        ? { ok: false, error: { kind: "unavailable", message: "Network unavailable" } }
        : successful(pr);
      },
    } });
    expect((await cache.firstSight(target())).checks).toEqual([]);
    now = VISIBLE_REFRESH_INTERVAL_MS;
    const snapshot = await cache.firstSight(target());
    expect(calls).toBe(2);
    expect(snapshot.ci).toBe("passed");
    expect(snapshot.lastSuccessfulFetchAt).toBe(now);
    cache.dispose();
  });

  test("periodic refresh touches only visible targets and dedupes duplicate spans", async () => {
    let now = 0;
    const calls: number[] = [];
    const client: GitHubPrClient = { fetch: async (pr) => { calls.push(pr.number); return successful(pr); } };
    const cache = new GitHubPrCache({ client, now: () => now });
    await Promise.all([cache.firstSight(target(1)), cache.firstSight(target(2))]);
    now = VISIBLE_REFRESH_INTERVAL_MS - 1;
    await cache.refreshVisible([target(1)]);
    expect(calls).toEqual([1, 2]);
    now++;
    const snapshots = await cache.refreshVisible([target(1), target(1)]);
    expect(calls).toEqual([1, 2, 1]);
    expect(snapshots).toHaveLength(1);
    expect(cache.get(target(2))?.lastSuccessfulFetchAt).toBe(0);
    await cache.refreshVisible([]);
    expect(calls).toEqual([1, 2, 1]);
    cache.dispose();
  });

  test("subprocess concurrency stays at three while excess work queues", async () => {
    const { client, calls } = controlledClient();
    const cache = new GitHubPrCache({ client });
    const pending = [1, 2, 3, 4, 5].map((number) => cache.firstSight(target(number)));
    expect(calls.map((call) => call.target.number)).toEqual([1, 2, 3]);
    calls[0]!.resolve(successful(target(1)));
    await flush();
    expect(calls.map((call) => call.target.number)).toEqual([1, 2, 3, 4]);
    calls[1]!.resolve(successful(target(2)));
    await flush();
    expect(calls.map((call) => call.target.number)).toEqual([1, 2, 3, 4, 5]);
    for (const call of calls.slice(2)) call.resolve(successful(call.target));
    const snapshots = await Promise.all(pending);
    expect(snapshots.every((snapshot) => snapshot.ci === "passed")).toBe(true);
    cache.dispose();
  });

  test("257 visible PRs survive queued requests and repeated redraw/timer frames without a fetch storm", async () => {
    const { client, calls } = controlledClient();
    const visible = Array.from({ length: 257 }, (_item, index) => target(index + 1));
    const changes: GitHubPrSnapshot[] = [];
    const cache = new GitHubPrCache({ client, now: () => 100, onChange: (snapshot) => changes.push(snapshot) });
    cache.setVisible(visible);
    expect(calls).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(cache.get(visible[0]!)).toBeUndefined();
    const pending = visible.map((pr) => cache.firstSight(pr));
    expect(calls).toHaveLength(3);
    for (let frame = 0; frame < 3; frame++) {
      cache.setVisible([...visible]);
      visible.forEach((pr, index) => expect(cache.firstSight(pr)).toBe(pending[index]!));
    }
    const timer = cache.refreshVisible([...visible, visible[0]!]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.signal.aborted)).toBe(true);

    let resolved = 0;
    for (let wave = 0; wave < Math.ceil(visible.length / 3); wave++) {
      const batch = calls.slice(resolved);
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(3);
      resolved += batch.length;
      for (const call of batch) call.resolve(successful(call.target));
      await flush();
      // Completion-driven redraws repeat firstSight for settled and queued PRs.
      cache.setVisible(visible);
      visible.forEach((pr, index) => {
        const snapshot = cache.get(pr);
        expect(snapshot).toBeDefined();
        const request = cache.firstSight(pr);
        if (snapshot?.refreshing) expect(request).toBe(pending[index]!);
      });
    }
    expect(resolved).toBe(257);
    expect(calls).toHaveLength(257);
    expect(new Set(calls.map((call) => call.target.canonicalUrl)).size).toBe(257);
    expect(calls.every((call) => !call.signal.aborted)).toBe(true);
    expect((await Promise.all(pending)).every((snapshot) => snapshot.ci === "passed")).toBe(true);
    expect(await timer).toHaveLength(257);
    expect(changes).toHaveLength(257 * 2);
    await Promise.all(visible.map((pr) => cache.firstSight(pr)));
    expect(calls).toHaveLength(257);
    cache.dispose();
  });

  test("visibility shrink prunes excess history without fetching or evicting the remaining pin", async () => {
    const visible = Array.from({ length: 257 }, (_item, index) => target(index + 1));
    let calls = 0;
    const cache = new GitHubPrCache({ now: () => 100, client: {
      fetch: async (pr) => { calls++; return successful(pr); },
    } });
    cache.setVisible(visible);
    await Promise.all(visible.map((pr) => cache.firstSight(pr)));
    expect(calls).toBe(257);
    cache.setVisible([visible[0]!]);
    // 1 pin + 256 historical entries is within the additive capacity budget.
    cache.setVisible([]);
    expect(cache.get(visible[0]!)).toBeUndefined();
    expect(visible.slice(1).every((pr) => cache.get(pr) !== undefined)).toBe(true);
    expect(calls).toBe(257);
    cache.dispose();
  });

  test("canonical pins are exact and duplicate tab links do not change the history budget", async () => {
    let calls = 0;
    const cache = new GitHubPrCache({ maxEntries: 1, client: {
      fetch: async (pr) => { calls++; return successful(pr); },
    } });
    const tab = parseGitHubPrTarget("https://github.com/OWNER/REPO/pull/1/files#diff");
    if (tab === null) throw new Error("Invalid test target");
    function* pins(input: GitHubPrTarget) { yield target(1); yield input; }
    cache.setVisible(pins(tab));
    expect(calls).toBe(0);
    await cache.firstSight(target(1));
    await cache.firstSight(target(2));
    await cache.firstSight(target(3));
    expect(cache.get(target(1))).toBeDefined();
    expect(cache.get(target(2))).toBeUndefined();
    expect(cache.get(target(3))).toBeDefined();
    const before = calls;
    cache.setVisible([target(3)]);
    cache.setVisible([]);
    expect(cache.get(target(1))).toBeUndefined();
    expect(cache.get(target(3))).toBeDefined();
    expect(calls).toBe(before);
    cache.dispose();
  });

  test("adding pinned PRs preserves old in-flight work, then unpinning cancels excess active and queued history", async () => {
    const { client, calls } = controlledClient();
    const cache = new GitHubPrCache({ client, maxEntries: 1, concurrency: 1 });
    const old = cache.firstSight(target(1));
    cache.setVisible([target(2), target(3)]);
    const second = cache.firstSight(target(2));
    const third = cache.firstSight(target(3));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(false);
    expect(cache.firstSight(target(1))).toBe(old);
    expect(cache.firstSight(target(2))).toBe(second);
    // Restore the original LRU ordering without changing any requests.
    cache.get(target(2));
    cache.get(target(3));
    cache.setVisible([target(3)]);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect((await old).reason).toBe("PR cache entry evicted");
    expect(cache.firstSight(target(2))).toBe(second);
    cache.get(target(3));
    cache.setVisible([]);
    expect((await second).reason).toBe("PR cache entry evicted");
    expect(cache.get(target(1))).toBeUndefined();
    expect(cache.get(target(2))).toBeUndefined();
    // A late success from the aborted old client cannot resurrect the entry.
    calls[0]!.resolve(successful(target(1)));
    await flush();
    expect(calls.map((call) => call.target.number)).toEqual([1, 3]);
    expect(calls[1]!.signal.aborted).toBe(false);
    calls[1]!.resolve(successful(target(3)));
    expect((await third).ci).toBe("passed");
    expect(cache.get(target(1))).toBeUndefined();
    cache.dispose();
  });

  test("unavailable data clears stale colors and preserves last successful fetch time", async () => {
    let now = 10;
    let unavailable = false;
    const client: GitHubPrClient = { fetch: async (pr) => unavailable
      ? { ok: false, error: { kind: "authentication", message: "Authentication unavailable" } }
      : successful(pr),
    };
    const cache = new GitHubPrCache({ client, now: () => now });
    const initial = await cache.firstSight(target());
    expect(initial.checks).toEqual([{ name: "build", outcome: "passed", url: "https://ci.example.com/build" }]);
    now += HOVER_REENTRY_THROTTLE_MS;
    unavailable = true;
    const snapshot = await cache.hoverEntry(target());
    expect(snapshot).toMatchObject({
      ci: "unknown", lifecycle: "unknown", title: null, checks: [], reason: "Authentication unavailable",
      lastSuccessfulFetchAt: 10, lastAttemptAt: now, refreshing: false,
    });
    now += HOVER_REENTRY_THROTTLE_MS;
    unavailable = false;
    const recovered = await cache.hoverEntry(target());
    expect(recovered.lastSuccessfulFetchAt).toBe(now);
    expect(recovered.checks).toEqual(initial.checks);
    cache.dispose();
  });

  test("tooltip check failures and fetched time are published and cleared when a fetch fails", async () => {
    let now = 100;
    const { client, calls } = controlledClient();
    const changes: GitHubPrSnapshot[] = [];
    const cache = new GitHubPrCache({ client, now: () => now, onChange: (snapshot) => changes.push(snapshot) });
    const pending = cache.firstSight(target());
    const checks = [
      { name: "build (linux)", outcome: "failed", url: "https://ci.example.com/build" },
      { name: "integration tests", outcome: "pending", url: null },
    ] as const;
    calls[0]!.resolve({ ok: true, value: {
      target: target(), url: target().canonicalUrl, title: "A PR", lifecycle: "open", ci: "failed", ciReason: null, checks,
    } });
    const snapshot = await pending;
    expect(snapshot.checks).toEqual(checks);
    expect(snapshot.lastSuccessfulFetchAt).toBe(100);
    expect(changes.at(-1)?.checks).toEqual(checks);
    await flush();
    now += HOVER_REENTRY_THROTTLE_MS;
    const refresh = cache.hoverEntry(target());
    expect(cache.get(target())?.checks).toEqual(checks);
    calls[1]!.resolve({ ok: false, error: { kind: "unavailable", message: "Network unavailable" } });
    const failed = await refresh;
    expect(failed.checks).toEqual([]);
    expect(failed.ci).toBe("unknown");
    expect(failed.lastSuccessfulFetchAt).toBe(100);
    expect(changes.at(-1)?.checks).toEqual([]);
    cache.dispose();
  });

  test("dispose aborts running and queued work even if a client ignores its signal", async () => {
    const { client, calls } = controlledClient();
    const changes: GitHubPrSnapshot[] = [];
    const cache = new GitHubPrCache({ client, onChange: (snapshot) => changes.push(snapshot) });
    cache.setVisible([1, 2, 3, 4, 5].map((number) => target(number)));
    const pending = [1, 2, 3, 4, 5].map((number) => cache.firstSight(target(number)));
    expect(calls).toHaveLength(3);
    cache.dispose();
    cache.dispose();
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    const snapshots = await Promise.all(pending);
    expect(snapshots.every((snapshot) => snapshot.ci === "unknown" && snapshot.error?.kind === "aborted" && !snapshot.refreshing && snapshot.checks.length === 0)).toBe(true);
    for (const call of calls) call.resolve(successful(call.target));
    await flush();
    expect(calls).toHaveLength(3);
    expect(changes).toHaveLength(5);
    expect(cache.get(target())).toBeUndefined();
    expect((await cache.firstSight(target(6))).reason).toBe("PR cache disposed");
    expect((await cache.hoverEntry(target(6))).reason).toBe("PR cache disposed");
    cache.setVisible([target(6)]);
    expect(calls).toHaveLength(3);
    expect(cache.get(target(6))).toBeUndefined();
  });

  test("LRU capacity evicts the least recently read settled target", async () => {
    const cache = new GitHubPrCache({ maxEntries: 2, client: { fetch: async (pr) => successful(pr) } });
    await cache.firstSight(target(1));
    await cache.firstSight(target(2));
    cache.get(target(1));
    await cache.firstSight(target(3));
    expect(cache.get(target(1))).toBeDefined();
    expect(cache.get(target(2))).toBeUndefined();
    expect(cache.get(target(3))).toBeDefined();
    cache.dispose();
  });

  test("eviction aborts active requests and settles queued callers", async () => {
    const { client, calls } = controlledClient();
    const cache = new GitHubPrCache({ client, maxEntries: 2, concurrency: 1 });
    const first = cache.firstSight(target(1));
    const second = cache.firstSight(target(2));
    const third = cache.firstSight(target(3));
    expect(calls[0]!.signal.aborted).toBe(true);
    expect((await first).reason).toBe("PR cache entry evicted");
    calls[0]!.resolve({ ok: false, error: { kind: "aborted", message: "aborted" } });
    await flush();
    expect(calls[1]!.target.number).toBe(2);
    calls[1]!.resolve(successful(target(2)));
    await flush();
    calls[2]!.resolve(successful(target(3)));
    expect((await second).ci).toBe("passed");
    expect((await third).ci).toBe("passed");
    cache.dispose();
  });

  test("unexpected failures reject the caller and release the concurrency slot", async () => {
    const error = new TypeError("bad implementation");
    const cache = new GitHubPrCache({ concurrency: 1, client: {
      fetch: async (pr) => { if (pr.number === 1) throw error; return successful(pr); },
    } });
    const first = cache.firstSight(target(1));
    const second = cache.firstSight(target(2));
    await expect(first).rejects.toBe(error);
    expect((await second).ci).toBe("passed");
    cache.dispose();
  });
});
