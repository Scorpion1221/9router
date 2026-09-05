import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connections: vi.fn(), connection: vi.fn(), combos: vi.fn(), custom: vi.fn(), aliases: vi.fn(), disabled: vi.fn(), catalog: vi.fn(), resolve: vi.fn(), metadata: vi.fn(), combo: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: mocks.connections, getCombos: mocks.combos, getCustomModels: mocks.custom, getModelAliases: mocks.aliases }));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.connection }));
vi.mock("@/lib/db", () => ({ getComboByName: mocks.combo }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.disabled }));
vi.mock("@/lib/codexModels", () => ({ getCodexModelCatalog: mocks.catalog, resolveCodexModels: mocks.resolve }));
vi.mock("open-sse/services/openrouterSync.js", () => ({ lookupModelMetadata: mocks.metadata }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn(), refreshGoogleToken: vi.fn() }));
const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const { GET: dashboard } = await import("@/app/api/models/codex/route.js");
const { GET: accountRoute } = await import("@/app/api/providers/[id]/models/route.js");
const { resolveModelInfo } = await import("@/lib/modelInfo.js");
const active = [{ id: "a", provider: "codex", isActive: true }, { id: "b", provider: "codex", isActive: true }];
const native = { models: [{ id: "gpt-6-astra", name: "GPT 6 Astra", type: "llm", source: "codex", contextWindow: 272000, maxOutput: 64000, reasoningLevels: ["low", "ultra"], capabilities: { tools: true, reasoning: true, contextWindow: 272000, maxOutput: 64000 } }], source: "codex", clientVersion: "0.153.4", stale: false };
beforeEach(() => {
  vi.resetAllMocks(); mocks.connections.mockResolvedValue(active); mocks.connection.mockResolvedValue(active[0]); mocks.combos.mockResolvedValue([]); mocks.custom.mockResolvedValue([]); mocks.aliases.mockResolvedValue({}); mocks.disabled.mockResolvedValue({}); mocks.catalog.mockResolvedValue(native); mocks.resolve.mockResolvedValue(native); mocks.metadata.mockResolvedValue(null);
});

describe("shared native Codex catalog consumers", () => {
  it("dashboard endpoint returns safe native catalog and supports explicit refresh", async () => {
    const response = await dashboard(new Request("http://localhost/api/models/codex?refresh=true"));
    expect(await response.json()).toEqual(native);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.catalog).toHaveBeenCalledWith(undefined, { forceRefresh: true });
  });
  it("dashboard soft failure does not expose internal diagnostics", async () => {
    mocks.catalog.mockRejectedValue(new Error("private diagnostic"));
    const response = await dashboard(new Request("http://localhost/api/models/codex"));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private diagnostic");
  });
  it("per-account native endpoint uses the same resolver", async () => {
    const response = await accountRoute(new Request("http://localhost/api/providers/a/models"), { params: Promise.resolve({ id: "a" }) });
    expect(response.status).toBe(200); expect((await response.json()).models).toEqual(native.models);
    expect(mocks.resolve).toHaveBeenCalledWith(active[0]);
  });
  it("v1 lists GPT-6 from active-account union without a static entry and keeps native limits", async () => {
    const rows = await buildModelsList(["llm"]);
    expect(mocks.catalog).toHaveBeenCalledWith(active);
    expect(rows).toEqual([expect.objectContaining({ id: "cx/gpt-6-astra", context_length: 272000, max_completion_tokens: 64000 })]);
    expect(rows.some((m) => m.id === "cx/gpt-5.5")).toBe(false);
  });
  it("v1 preserves explicit model choices, custom models, aliases and disabled models", async () => {
    mocks.connections.mockResolvedValue([{ ...active[0], providerSpecificData: { enabledModels: ["cx/gpt-pinned"] } }]);
    mocks.custom.mockResolvedValue([{ providerAlias: "cx", id: "gpt-custom", type: "llm" }]);
    mocks.aliases.mockResolvedValue({ myalias: "cx/gpt-alias" });
    mocks.disabled.mockResolvedValue({ cx: ["gpt-custom"] });
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toEqual(["cx/gpt-pinned", "cx/gpt-alias"]);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it("v1 excludes disabled native GPT-6 and falls back on cold catalog failure", async () => {
    mocks.disabled.mockResolvedValue({ cx: ["gpt-6-astra"] });
    expect(await buildModelsList(["llm"])).toEqual([]);
    mocks.catalog.mockResolvedValue({ models: [], source: "unavailable" });
    expect((await buildModelsList(["llm"])).some((m) => m.id === "cx/gpt-5.5")).toBe(true);
  });
  it("preserves separately routed Codex image models", async () => {
    const rows = await buildModelsList(["image"]);
    expect(rows.some((m) => m.id === "cx/gpt-5.5-image")).toBe(true);
    expect(rows.some((m) => m.id === "cx/gpt-6-astra")).toBe(false);
  });
  it("native model info wins over incompatible reseller context and max-output limits", async () => {
    mocks.metadata.mockResolvedValue({ contextWindow: 1050000, maxOutput: 128000 });
    const info = await resolveModelInfo("cx/gpt-6-astra");
    expect(info).toMatchObject({ contextWindow: 272000, maxOutput: 64000, reasoningLevels: ["low", "ultra"] });
  });
});
