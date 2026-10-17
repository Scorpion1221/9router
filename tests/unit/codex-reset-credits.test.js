import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  getCodexRateLimitResetCredits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn(),
  hasUnsettledReset: vi.fn(async () => false),
}));

vi.mock("@/lib/ops/resets.js", () => ({ hasUnsettledReset: mocks.hasUnsettledReset }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getCodexRateLimitResetCredits: mocks.getCodexRateLimitResetCredits,
  consumeCodexRateLimitResetCredit: mocks.consumeCodexRateLimitResetCredit,
}));

describe("Codex reset credits", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("returns normalized reset credit expiry details", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        available_count: 2,
        credits: [
          {
            status: "available",
            granted_at: "2026-06-18T00:25:18Z",
            expires_at: "2026-07-18T00:25:18Z",
          },
          {
            status: "redeemed",
            granted_at: "bad-date",
            expires_at: null,
          },
        ],
      }),
    });

    const { getCodexRateLimitResetCredits } = await import("../../open-sse/services/usage/codex.js");
    const result = await getCodexRateLimitResetCredits("token", { strictProxy: false }, { workspaceId: "acct_123" });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/rate-limit-reset-credits"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "ChatGPT-Account-ID": "acct_123",
        }),
      }),
      { strictProxy: false },
    );
    expect(result).toEqual({
      availableCount: 2,
      credits: [
        {
          status: "available",
          grantedAt: "2026-06-18T00:25:18.000Z",
          expiresAt: "2026-07-18T00:25:18.000Z",
        },
        {
          status: "redeemed",
          grantedAt: null,
          expiresAt: null,
        },
      ],
    });
  });

  it("surfaces structured upstream errors as readable messages", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "Reset credits are unavailable for this account" } }),
    });

    const { getCodexRateLimitResetCredits } = await import("../../open-sse/services/usage/codex.js");
    await expect(getCodexRateLimitResetCredits("token")).rejects.toThrow("Reset credits are unavailable for this account");
  });

  it("GET refreshes OAuth credentials before returning reset credit details", async () => {
    const connection = {
      id: "conn_1",
      provider: "codex",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: { workspaceId: "acct_123" },
    };
    const refreshedConnection = { ...connection, accessToken: "new-token" };
    const resetCredits = {
      availableCount: 1,
      credits: [{ status: "available", grantedAt: "2026-06-18T00:25:18.000Z", expiresAt: "2026-07-18T00:25:18.000Z" }],
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local" });
    mocks.refreshAndUpdateCredentials.mockResolvedValue({ connection: refreshedConnection });
    mocks.getCodexRateLimitResetCredits.mockResolvedValue(resetCredits);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_1/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resetCredits);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledWith(
      connection,
      false,
      expect.objectContaining({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local", strictProxy: false }),
    );
    expect(mocks.getCodexRateLimitResetCredits).toHaveBeenCalledWith(
      "new-token",
      expect.objectContaining({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local", strictProxy: false }),
      { workspaceId: "acct_123" },
    );
  });

  it("GET force-refreshes OAuth credentials when reset credit fetch reports expired auth", async () => {
    const connection = {
      id: "conn_1",
      provider: "codex",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    };
    const refreshedConnection = { ...connection, accessToken: "new-token" };
    const forcedConnection = { ...connection, accessToken: "forced-token" };
    const resetCredits = { availableCount: 0, credits: [] };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.refreshAndUpdateCredentials
      .mockResolvedValueOnce({ connection: refreshedConnection })
      .mockResolvedValueOnce({ connection: forcedConnection });
    mocks.getCodexRateLimitResetCredits
      .mockRejectedValueOnce(new Error("Unauthorized 401"))
      .mockResolvedValueOnce(resetCredits);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_1/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resetCredits);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenNthCalledWith(1, connection, false, expect.any(Object));
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenNthCalledWith(2, refreshedConnection, true, expect.any(Object));
    expect(mocks.getCodexRateLimitResetCredits).toHaveBeenNthCalledWith(2, "forced-token", expect.any(Object), {});
  });

  it("POST returns 409 when there are no reset credits to consume", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_1",
      provider: "codex",
      authType: "access_token",
      accessToken: "token",
      providerSpecificData: {},
    });
    mocks.consumeCodexRateLimitResetCredit.mockResolvedValue({
      ok: false,
      noCredit: true,
      status: 200,
      code: "no_credit",
      windowsReset: 0,
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "no_credit",
      reset: false,
      windows_reset: 0,
      message: "No Codex reset credits available.",
    });
    expect(mocks.consumeCodexRateLimitResetCredit).toHaveBeenCalledWith(
      "token",
      expect.any(String),
      expect.objectContaining({ strictProxy: false }),
      { providerSpecificData: {} },
    );
  });

  it("POST refuses while a 9r attempt on the account is unsettled, without consuming", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn_1", provider: "codex", authType: "access_token", accessToken: "token", providerSpecificData: {} });
    mocks.hasUnsettledReset.mockResolvedValueOnce(true);
    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", { method: "POST" }), { params: Promise.resolve({ connectionId: "conn_1" }) });
    expect(response.status).toBe(409);
    expect(mocks.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("POST reports an unanswered consume as unknown, not as a failure", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ id: "conn_1", provider: "codex", authType: "access_token", accessToken: "token", providerSpecificData: {} });
    mocks.consumeCodexRateLimitResetCredit.mockResolvedValue({ ok: false, uncertain: true, status: null, code: null, windowsReset: 0, message: "No answer from Codex: timeout" });
    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", { method: "POST" }), { params: Promise.resolve({ connectionId: "conn_1" }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ reset: null, message: expect.stringMatching(/Couldn't confirm/) });
  });

  it("POST binds the consume call to the account and reports nothing_to_reset as 409", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_1",
      provider: "codex",
      authType: "access_token",
      accessToken: "token",
      providerSpecificData: { chatgptAccountId: "acct_9" },
    });
    mocks.consumeCodexRateLimitResetCredit.mockResolvedValue({
      ok: false,
      nothingToReset: true,
      status: 200,
      code: "nothing_to_reset",
      windowsReset: 0,
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "nothing_to_reset", reset: false });
    expect(mocks.consumeCodexRateLimitResetCredit.mock.calls[0][3]).toEqual({ providerSpecificData: { chatgptAccountId: "acct_9" } });
  });
});

describe("consumeCodexRateLimitResetCredit", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  const respond = (body, status = 200) => mocks.proxyAwareFetch.mockResolvedValue({ ok: status < 400, status, text: async () => JSON.stringify(body) });

  it("sends the account header and credit id, and reads every documented code", async () => {
    const { consumeCodexRateLimitResetCredit } = await import("../../open-sse/services/usage/codex.js");
    respond({ code: "reset", windows_reset: 2 });
    const ok = await consumeCodexRateLimitResetCredit("t", "rid-1", null, { providerSpecificData: { chatgptAccountId: "acct_1" }, creditId: "cr_1" });
    expect(ok).toMatchObject({ ok: true, uncertain: false, windowsReset: 2 });
    const [, init] = mocks.proxyAwareFetch.mock.calls[0];
    expect(init.headers["ChatGPT-Account-ID"]).toBe("acct_1");
    expect(JSON.parse(init.body)).toEqual({ redeem_request_id: "rid-1", credit_id: "cr_1" });

    respond({ code: "already_redeemed", windows_reset: 0 });
    expect(await consumeCodexRateLimitResetCredit("t", "rid-1")).toMatchObject({ ok: true, alreadyRedeemed: true, uncertain: false });
    respond({ code: "nothing_to_reset", windows_reset: 0 });
    expect(await consumeCodexRateLimitResetCredit("t", "rid-2")).toMatchObject({ ok: false, nothingToReset: true, uncertain: false });
    respond({ code: "something_new", windows_reset: 1 });
    expect(await consumeCodexRateLimitResetCredit("t", "rid-3")).toMatchObject({ ok: false, uncertain: true });
  });

  it("a request that got no answer is uncertain, not a failure", async () => {
    const { consumeCodexRateLimitResetCredit } = await import("../../open-sse/services/usage/codex.js");
    mocks.proxyAwareFetch.mockRejectedValue(new Error("socket hang up"));
    expect(await consumeCodexRateLimitResetCredit("t", "rid-4")).toMatchObject({ ok: false, uncertain: true, status: null });
  });
});

describe("getCodexUsage account binding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  it("sends ChatGPT-Account-ID in the same order as the executor (workspaceId, chatgptAccountId, accountId)", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    mocks.proxyAwareFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ rate_limit: {} }) });
    await getCodexUsage("t", null, { chatgptAccountId: "ws-A", accountId: "ws-B" });
    expect(mocks.proxyAwareFetch.mock.calls[0][1].headers["ChatGPT-Account-ID"]).toBe("ws-A");
    await getCodexUsage("t", null, null);
    expect(mocks.proxyAwareFetch.mock.calls[1][1].headers["ChatGPT-Account-ID"]).toBeUndefined();
  });
});

