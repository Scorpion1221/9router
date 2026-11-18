import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: vi.fn(),
  combos: vi.fn(),
  settings: vi.fn(),
  combo: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.connections,
  getCombos: mocks.combos,
  getCustomModels: async () => [],
  getModelAliases: async () => ({}),
  getSettings: mocks.settings,
}));
vi.mock("@/lib/db", () => ({ getComboByName: mocks.combo }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("open-sse/services/openrouterSync.js", () => ({ lookupModelMetadata: async () => null }));

const { GET, buildModelsList } = await import("@/app/api/v1/models/route.js");

// An OpenAI-compatible node with no enabledModels: listing it fetches its remote /models.
const node = {
  id: "n1",
  provider: "openai-compatible-chat-test",
  isActive: true,
  apiKey: "sk-test",
  providerSpecificData: { prefix: "node", baseUrl: "https://upstream.invalid/v1" },
};
const combo = { id: "c1", name: "my-combo", models: ["node/model-a"] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connections.mockResolvedValue([node]);
  mocks.combos.mockResolvedValue([combo]);
  mocks.combo.mockImplementation(async (name) => (name === combo.name ? combo : null));
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] })));
  vi.stubGlobal("fetch", mocks.fetch);
});

async function listIds() {
  const response = await GET(new Request("http://localhost/v1/models"));
  expect(response.status).toBe(200);
  return (await response.json()).data.map((m) => m.id);
}

describe("/v1/models modelsListCombosOnly", () => {
  it("lists provider models next to combos by default", async () => {
    mocks.settings.mockResolvedValue({});
    const ids = await listIds();
    expect(ids).toContain("my-combo");
    expect(ids).toContain("node/model-a");
  });

  it("lists only combos when the setting is on, without fetching any upstream catalog", async () => {
    mocks.settings.mockResolvedValue({ modelsListCombosOnly: true });
    expect(await listIds()).toEqual(["my-combo"]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.connections).toHaveBeenCalled();
  });

  it("falls back to the full list when settings cannot be read", async () => {
    mocks.settings.mockRejectedValue(new Error("db down"));
    expect(await listIds()).toContain("node/model-a");
  });

  it("buildModelsList keeps combo limits in combos-only mode", async () => {
    const models = await buildModelsList(["llm"], { combosOnly: true });
    expect(models).toEqual([expect.objectContaining({ id: "my-combo", object: "model", owned_by: "combo" })]);
  });
});

describe("matchPattern regex cache", () => {
  it("returns the same answers on repeated calls with one pattern", async () => {
    const { matchPattern } = await import("open-sse/providers/pricing.js");
    for (let i = 0; i < 3; i++) {
      expect(matchPattern("claude-*-opus*", "Claude-3-Opus-20240229")).toBe(true);
      expect(matchPattern("claude-*-opus*", "gpt-6.2-sol")).toBe(false);
      expect(matchPattern("gpt-6.2*", "gpt-6.2-sol")).toBe(true);
      expect(matchPattern("a.b", "axb")).toBe(false);
    }
  });
});
