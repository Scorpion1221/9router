// handleChatCore cancels the upstream call when the client goes away before a
// stream is handed off, and reports it as 499 (never as a provider error).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
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

const log = { debug() {}, info() {}, warn() {}, error() {} };
const call = (clientSignal) => handleChatCore({
  body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
  modelInfo: { provider: "openai", model: "gpt-4o" },
  credentials: { apiKey: "k", providerSpecificData: {} },
  log,
  connectionId: "c1",
  clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
  clientSignal,
});

beforeEach(() => { executeMock.mockReset(); });

describe("handleChatCore — client disconnect", () => {
  it("aborts the in-flight upstream call and returns 499", async () => {
    const ctrl = new AbortController();
    let upstreamSignal = null;
    executeMock.mockImplementation(({ signal }) => {
      upstreamSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    setTimeout(() => ctrl.abort(Object.assign(new Error("aborted"), { name: "ResponseAborted" })), 10);

    const result = await call(ctrl.signal);

    expect(upstreamSignal.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
  });

  it("does not call the upstream when the client is already gone", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await call(ctrl.signal);
    expect(result.status).toBe(499);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("reports an executor's synthetic 5xx after the client left as 499", async () => {
    const ctrl = new AbortController();
    executeMock.mockImplementation(async () => {
      ctrl.abort();
      return { response: new Response('{"error":"Request aborted"}', { status: 500 }), url: "u", headers: {}, transformedBody: {} };
    });
    const result = await call(ctrl.signal);
    expect(result.status).toBe(499);
  });
});
