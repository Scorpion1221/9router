// handleChat records one "request" row per client-visible outcome and one
// "attempt" row per upstream call, including streams that end later and
// account fallbacks. Metrics capture is mocked to an in-memory list.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  handleChatCore: vi.fn(),
  rows: [],
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/lib/db/repos/requestMetricsRepo.js", async (orig) => ({
  ...(await orig()),
  recordRequestMetric: (m) => mocks.rows.push(m),
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: (r) => r.headers.get("x-api-key"),
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const req = (stream) => new Request("http://localhost/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": "sk-client" },
  body: JSON.stringify({ model: "openai/gpt-x", stream, messages: [{ role: "user", content: "hi" }] }),
});
const account = (n) => ({ connectionId: `c${n}`, connectionName: `acc${n}`, accessToken: "t", providerSpecificData: {} });
const sse = () => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode("data: {}\n\n")); c.close(); },
}), { status: 200, headers: { "Content-Type": "text/event-stream" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.length = 0;
  let n = 0;
  mocks.getProviderCredentials.mockImplementation(async () => account(++n));
});

describe("request metrics capture", () => {
  it("records each failed attempt and the final client outcome for a non-stream fallback", async () => {
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 429, error: "rate", response: new Response("{}", { status: 429 }) })
      .mockResolvedValueOnce({ success: true, response: new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) });

    const out = await handleChat(req(false));
    expect(out.status).toBe(200);

    const attempts = mocks.rows.filter((r) => r.kind === "attempt");
    expect(attempts.map((a) => [a.connectionId, a.status, a.outcome])).toEqual([["c1", 429, "error"], ["c2", 200, "ok"]]);
    const requests = mocks.rows.filter((r) => r.kind === "request");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "openai/gpt-x", status: 200, outcome: "ok", apiKey: "sk-client", endpoint: "/v1/messages" });
  });

  it("records a streamed request only when the stream finishes", async () => {
    mocks.handleChatCore.mockImplementation(async ({ onStreamOutcome }) => ({ success: true, response: sse(), onStreamOutcome }));
    const out = await handleChat(req(true));
    expect(mocks.rows.filter((r) => r.kind === "request")).toHaveLength(0);
    await out.text();
    const request = mocks.rows.find((r) => r.kind === "request");
    expect(request).toMatchObject({ status: 200, outcome: "ok", stream: true });
    expect(request.ttftMs).toBeGreaterThanOrEqual(0);
  });

  it("counts a client cancelling the stream as aborted", async () => {
    mocks.handleChatCore.mockResolvedValue({
      success: true,
      response: new Response(new ReadableStream({ pull() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    });
    const out = await handleChat(req(true));
    await out.body.cancel();
    expect(mocks.rows.find((r) => r.kind === "request")).toMatchObject({ status: 499, outcome: "aborted", errorType: "client_abort" });
  });

  it("counts a stream whose upstream failed mid-way against the request", async () => {
    mocks.handleChatCore.mockImplementation(async ({ onStreamOutcome }) => ({
      success: true,
      response: new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: {}\n\n"));
          onStreamOutcome({ outcome: "error", status: 502, errorType: "stream_stall" }); // chatCore saw the stall
          c.close(); // the client still gets a clean end (in-band error frame)
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }));
    const out = await handleChat(req(true));
    await out.text();
    expect(mocks.rows.find((r) => r.kind === "request")).toMatchObject({ status: 502, outcome: "error", errorType: "stream_stall" });
  });

  it("does not count a client closing after a completed stream as an abort", async () => {
    // codex closes the socket on response.completed, before upstream EOF.
    mocks.handleChatCore.mockImplementation(async ({ onStreamOutcome }) => ({
      success: true,
      response: new Response(new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: {}\n\n"));
          onStreamOutcome({ outcome: "ok", status: 200 });
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }));
    const out = await handleChat(req(true));
    const reader = out.body.getReader();
    await reader.read();
    await reader.cancel();
    expect(mocks.rows.find((r) => r.kind === "request")).toMatchObject({ status: 200, outcome: "ok" });
  });

  it("measures TTFT from request arrival, including the wait for upstream headers", async () => {
    mocks.handleChatCore.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { success: true, response: sse() };
    });
    const out = await handleChat(req(true));
    await out.text();
    expect(mocks.rows.find((r) => r.kind === "request").ttftMs).toBeGreaterThanOrEqual(55);
  });

  it("records an attempt when the core throws", async () => {
    mocks.handleChatCore.mockRejectedValue(new Error("socket hang up"));
    await expect(handleChat(req(false))).rejects.toThrow();
    expect(mocks.rows.find((r) => r.kind === "attempt")).toMatchObject({ outcome: "error", errorType: "upstream_exception" });
  });

  it("does not record anything for requests rejected before routing", async () => {
    const bad = new Request("http://localhost/v1/messages", { method: "POST", body: "not json" });
    await handleChat(bad);
    expect(mocks.rows).toHaveLength(0);
  });
});
