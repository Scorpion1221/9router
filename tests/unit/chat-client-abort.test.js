// Account walk stops when the client disconnects, and a client-caused failure
// never locks an account. Before the fix the gateway kept trying accounts for up
// to 17 minutes after a 499, and an abort mid-body came back as a 502 that
// cooled the account down and moved on to the next one.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  handleChatCore: vi.fn(),
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
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const account = (n) => ({ connectionId: `c${n}`, connectionName: `acc${n}`, accessToken: "t", providerSpecificData: {} });
const failure = (status) => ({ success: false, status, error: "boom", response: new Response("{}", { status }) });

function request(signal) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-x", messages: [{ role: "user", content: "hi" }] }),
    signal,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  mocks.getProviderCredentials.mockImplementation(async () => account(++n));
});

describe("handleSingleModelChat — client disconnect", () => {
  it("returns 499 without locking the account when the client left mid-request", async () => {
    const ctrl = new AbortController();
    let seenSignal = null;
    mocks.handleChatCore.mockImplementation(async ({ clientSignal }) => {
      seenSignal = clientSignal;
      ctrl.abort();
      // What a body read cut by the abort used to look like: a 502.
      return failure(502);
    });

    const out = await handleChat(request(ctrl.signal));

    expect(seenSignal?.aborted).toBe(true); // the client's signal reaches chatCore
    expect(out.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("cancels an already-built response when the client is gone", async () => {
    const ctrl = new AbortController();
    const cancel = vi.fn(async () => {});
    mocks.handleChatCore.mockImplementation(async () => {
      ctrl.abort();
      return { success: true, response: { body: { cancel } } };
    });

    const out = await handleChat(request(ctrl.signal));

    expect(out.status).toBe(499);
    expect(cancel).toHaveBeenCalled();
  });

  it("still falls back to the next account on a real upstream failure", async () => {
    mocks.handleChatCore
      .mockResolvedValueOnce(failure(502))
      .mockResolvedValueOnce({ success: true, response: new Response("ok", { status: 200 }) });

    const out = await handleChat(request(new AbortController().signal));

    expect(out.status).toBe(200);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
  });
});
