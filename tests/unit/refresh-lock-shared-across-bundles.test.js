/**
 * Next bundles the refresh lock + dedup modules once for instrumentation (background
 * refresher) and once for request routes. Both copies must see the same in-flight
 * refresh, or the same single-use refresh token is spent twice and the provider
 * revokes the session. vi.resetModules() between imports gives two separate copies.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  globalThis.__9rRefreshDedupCache?.clear();
  globalThis.__9rRefreshLocks?.clear();
});

describe("refresh dedup/lock shared across bundled module copies", () => {
  it("dedupRefresh: a second copy reuses the first copy's in-flight refresh", async () => {
    const { dedupRefresh: dedupA } = await import("open-sse/services/tokenRefresh/dedup.js");
    vi.resetModules();
    const { dedupRefresh: dedupB } = await import("open-sse/services/tokenRefresh/dedup.js");
    expect(dedupB).not.toBe(dedupA);

    let release;
    const fn = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const first = dedupA("claude", "rt-shared-1", fn);
    const second = dedupB("claude", "rt-shared-1", fn);
    release({ accessToken: "new" });

    await expect(first).resolves.toEqual({ accessToken: "new" });
    await expect(second).resolves.toEqual({ accessToken: "new" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("withCredentialRefreshLock: a second copy joins the first copy's lock", async () => {
    const { withCredentialRefreshLock: lockA } = await import("open-sse/services/oauthCredentialManager.js");
    vi.resetModules();
    const { withCredentialRefreshLock: lockB } = await import("open-sse/services/oauthCredentialManager.js");
    expect(lockB).not.toBe(lockA);

    let release;
    const fn = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const creds = { connectionId: "conn-shared-1" };
    const first = lockA("codex", creds, fn);
    const second = lockB("codex", creds, fn);
    await Promise.resolve();
    release("done");

    await expect(first).resolves.toBe("done");
    await expect(second).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
