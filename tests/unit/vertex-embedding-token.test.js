// Vertex SA token mint on a fresh slot: one connect failure must not turn into a
// 401 that locks the only account (2026-11-06: stale DB token sent after a mint
// "fetch failed", then a 120 s modelLock on gemini-embedding-2-preview).
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeSaJson(email) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    type: "service_account",
    project_id: "test-project",
    client_email: email,
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function connectTimeout() {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  return err;
}

const quietLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("refreshVertexToken", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.clearAllMocks(); });

  it("retries once when the token request never got a response", async () => {
    const { refreshVertexToken } = await import("../../open-sse/services/tokenRefresh.js");
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce(Response.json({ access_token: "fresh", expires_in: 3600 }));

    const minted = await refreshVertexToken(makeSaJson("retry@test.iam.gserviceaccount.com"), quietLog);

    expect(minted?.accessToken).toBe("fresh");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(quietLog.warn.mock.calls[0][1]).toContain("ETIMEDOUT");
  });

  it("gives up after the second connect failure", async () => {
    const { refreshVertexToken } = await import("../../open-sse/services/tokenRefresh.js");
    globalThis.fetch = vi.fn().mockRejectedValue(connectTimeout());

    const minted = await refreshVertexToken(makeSaJson("down@test.iam.gserviceaccount.com"), quietLog);

    expect(minted).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(quietLog.error.mock.calls[0][1]).toContain("ETIMEDOUT");
  });

  it("does not retry when Google rejects the assertion", async () => {
    const { refreshVertexToken } = await import("../../open-sse/services/tokenRefresh.js");
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    const minted = await refreshVertexToken(makeSaJson("revoked@test.iam.gserviceaccount.com"), quietLog);

    expect(minted).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Vertex embedding adapter when the mint fails", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { globalThis.fetch = originalFetch; vi.doUnmock("../../open-sse/services/tokenRefresh.js"); });

  it("fails the request without sending the stored token", async () => {
    vi.doMock("../../open-sse/services/tokenRefresh.js", () => ({
      parseVertexSaJson: (key) => JSON.parse(key),
      refreshVertexToken: vi.fn().mockResolvedValue(null),
    }));
    const { default: adapter } = await import("../../open-sse/handlers/embeddingProviders/vertex.js");
    globalThis.fetch = vi.fn();

    const credentials = {
      apiKey: JSON.stringify({ type: "service_account", project_id: "p", client_email: "e", private_key: "k" }),
      accessToken: "stale-token-from-db",
    };
    const call = adapter.fetchAll({ model: "gemini-embedding-2-preview", credentials, input: "hi", log: quietLog });

    await expect(call).rejects.toMatchObject({ status: 503, noAccountLock: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("embeddings handler: gateway-side failures", () => {
  beforeEach(() => { vi.resetModules(); });

  it("skips the account for this request without locking it", async () => {
    const markAccountUnavailable = vi.fn();
    const getProviderCredentials = vi.fn()
      .mockResolvedValueOnce({ apiKey: "{}", connectionId: "conn-1", connectionName: "solvely-test" })
      .mockResolvedValueOnce(null);
    vi.doMock("../../src/sse/services/auth.js", () => ({
      getProviderCredentials,
      markAccountUnavailable,
      clearAccountError: vi.fn(),
      extractApiKey: () => null,
      isValidApiKey: vi.fn(),
    }));
    vi.doMock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
    vi.doMock("../../src/sse/services/model.js", () => ({
      getModelInfo: async () => ({ provider: "vertex", model: "gemini-embedding-2-preview" }),
    }));
    vi.doMock("../../open-sse/handlers/embeddingsCore.js", () => ({
      handleEmbeddingsCore: vi.fn().mockResolvedValue({
        success: false,
        status: 503,
        error: "[503]: Vertex: could not mint an access token from the service account",
        noAccountLock: true,
      }),
    }));
    vi.doMock("../../src/sse/utils/logger.js", () => ({
      request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
    }));
    vi.doMock("../../src/sse/services/tokenRefresh.js", () => ({
      updateProviderCredentials: vi.fn(),
      checkAndRefreshToken: async (_provider, credentials) => credentials,
    }));
    vi.doMock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));

    const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
    const res = await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: "vx/gemini-embedding-2-preview", input: "hello" }),
    }));

    expect(res.status).toBe(503);
    expect(markAccountUnavailable).not.toHaveBeenCalled();
    expect(getProviderCredentials.mock.calls[1][1]).toEqual(new Set(["conn-1"]));
  });
});
