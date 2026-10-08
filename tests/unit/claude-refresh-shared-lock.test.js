/**
 * Claude refresh tokens are single-use. Every path that refreshes them must share the
 * per-connection lock + dedup in open-sse/services/oauthCredentialManager.js, or two
 * concurrent refreshes (a 401 retry / usage poll / provider test racing the request
 * path or the background scheduler) spend the same token and the loser gets
 * invalid_grant, logging the account out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = globalThis.fetch;
let release;
let fetchMock;

function gatedTokenFetch() {
  // The first token call stays in flight until release(); any second call shows up in
  // fetchMock.mock.calls while the first one is still pending.
  const gate = new Promise((resolve) => { release = resolve; });
  fetchMock = vi.fn(async () => {
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28800 }),
      text: async () => "",
    };
  });
  globalThis.fetch = fetchMock;
}

beforeEach(() => {
  vi.resetModules();
  globalThis.__9rRefreshDedupCache?.clear();
  globalThis.__9rRefreshLocks?.clear();
  gatedTokenFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.doUnmock("@/lib/localDb");
  vi.resetModules();
});

describe("Claude refresh paths share one lock per connection", () => {
  it("DefaultExecutor.refreshCredentials (401 retry, usage, translator) joins a request-path refresh", async () => {
    const { refreshProviderCredentials } = await import("open-sse/services/oauthCredentialManager.js");
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const creds = { connectionId: "claude-conn-1", refreshToken: "rt-old" };

    const requestPath = refreshProviderCredentials("claude", { ...creds }, null);
    // A different (stale) refresh token, as a 401 retry holding an older snapshot would
    // have: the dedup cache (keyed on the token) can't merge these, only the lock can.
    const executorPath = new DefaultExecutor("claude").refreshCredentials({ ...creds, refreshToken: "rt-stale" }, null);
    await Promise.resolve();
    release();

    const [a, b] = await Promise.all([requestPath, executorPath]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("at-new");
    expect(b.accessToken).toBe("at-new");
    expect(b.refreshToken).toBe("rt-new");
  });

  it("DefaultExecutor.refreshCredentials still returns null without a refresh token", async () => {
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    await expect(new DefaultExecutor("claude").refreshCredentials({ accessToken: "x" }, null)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("provider connection test joins a request-path refresh instead of spending the token again", async () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    const connection = {
      id: "claude-conn-2",
      provider: "claude",
      authType: "oauth",
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: expired,
      providerSpecificData: {},
    };
    const updateProviderConnection = vi.fn(async () => ({}));
    vi.doMock("@/lib/localDb", () => ({
      getProviderConnectionById: vi.fn(async () => ({ ...connection })),
      updateProviderConnection,
    }));

    const { refreshProviderCredentials } = await import("open-sse/services/oauthCredentialManager.js");
    const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

    const requestPath = refreshProviderCredentials("claude", { connectionId: connection.id, refreshToken: "rt-old" }, null);
    const providerTest = testSingleConnection(connection.id);
    await new Promise((r) => setTimeout(r, 20));
    release();

    const [, result] = await Promise.all([requestPath, providerTest]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.valid).toBe(true);
    expect(result.refreshed).toBe(true);
    const saved = updateProviderConnection.mock.calls.at(-1)[1];
    expect(saved.accessToken).toBe("at-new");
    expect(saved.refreshToken).toBe("rt-new");
  });
});
