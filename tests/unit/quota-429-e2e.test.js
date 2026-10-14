// A Claude subscription 429 whose headers say the weekly window is exhausted
// travels from the real executor through chatCore as a quota rejection (lock the
// account until the reset), and every response's headers feed the live quota state.
// Codex usage windows are classified by length, not position.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock, default: fetchMock }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getQuotaSnapshot, __resetQuotaStateForTests } = await import("../../open-sse/services/quotaState.js");

const log = { debug() {}, info() {}, warn() {}, error() {} };
const reset = Math.floor((Date.now() + 3 * 86400e3) / 1000);

const call = () => handleChatCore({
  body: { model: "claude/claude-opus-5-5", stream: false, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
  modelInfo: { provider: "claude", model: "claude-opus-5-5" },
  credentials: { accessToken: "sk-ant-oat01-test", connectionId: "acc-1", providerSpecificData: {} },
  log,
  connectionId: "acc-1",
  clientRawRequest: { endpoint: "/v1/messages", body: {}, headers: {} },
  sourceFormatOverride: "claude",
});

beforeEach(() => { fetchMock.mockReset(); __resetQuotaStateForTests(); });

describe("Claude quota 429 → lock until reset", () => {
  it("returns a quota rejection with the weekly reset and records the window", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limit" } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "seven_day",
        "anthropic-ratelimit-unified-reset": String(reset),
        "anthropic-ratelimit-unified-7d-utilization": "1.0",
        "anthropic-ratelimit-unified-7d-reset": String(reset),
      },
    }));
    const result = await call();
    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.quota).toEqual({ resetsAtMs: reset * 1000, scope: "account", window: "seven_day" });
    expect(getQuotaSnapshot("acc-1").windows["7d"]).toMatchObject({ usedPct: 100, resetAt: reset * 1000 });
  });

  it("a burst 429 without the rejected status stays a normal backoff", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429, headers: { "content-type": "application/json" } }));
    const result = await call();
    expect(result.status).toBe(429);
    expect(result.quota).toBeUndefined();
  });
});

describe("Codex usage windows", () => {
  it("labels a weekly-only account's window as weekly, not 5h", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    fetchMock.mockResolvedValue(Response.json({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 604800, reset_after_seconds: 518400 }, secondary_window: null },
    }));
    const usage = await getCodexUsage("tok");
    expect(Object.keys(usage.quotas)).toEqual(["weekly"]);
    expect(usage.quotas.weekly).toMatchObject({ used: 50, windowSeconds: 604800 });
    expect(Date.parse(usage.quotas.weekly.resetAt)).toBeGreaterThan(Date.now() + 5 * 86400e3);
  });

  it("keeps 5h + weekly for accounts that have both", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    fetchMock.mockResolvedValue(Response.json({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: reset },
        secondary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: reset },
      },
    }));
    const usage = await getCodexUsage("tok");
    expect(usage.quotas.session.used).toBe(10);
    expect(usage.quotas.weekly.used).toBe(30);
  });
});
