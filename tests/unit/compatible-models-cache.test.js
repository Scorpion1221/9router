import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ connections: vi.fn(), combos: vi.fn(), custom: vi.fn(), aliases: vi.fn(), disabled: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: db.connections,
  getCombos: db.combos,
  getCustomModels: db.custom,
  getModelAliases: db.aliases,
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: db.disabled }));

const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const originalFetch = global.fetch;

const connection = (name, extra = {}) => ({
  id: `cache-test-${name}`,
  provider: `openai-compatible-cache-test-${name}`,
  apiKey: `key-${name}`,
  isActive: true,
  providerSpecificData: { baseUrl: `https://${name}.test/v1`, prefix: name, ...extra },
});
const response = (...ids) => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) });
const ids = async () => (await buildModelsList(["llm"])).map((model) => model.id);

beforeEach(() => {
  vi.resetAllMocks();
  db.combos.mockResolvedValue([]);
  db.custom.mockResolvedValue([]);
  db.aliases.mockResolvedValue({});
  db.disabled.mockResolvedValue({});
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("compatible /v1/models discovery cache", () => {
  it("reuses a successful list and keeps the internal recursion guard", async () => {
    db.connections.mockResolvedValue([connection("reuse")]);
    global.fetch = vi.fn().mockResolvedValue(response("model-a"));

    expect(await ids()).toEqual(["reuse/model-a"]);
    expect(await ids()).toEqual(["reuse/model-a"]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("https://reuse.test/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ "x-9r-internal-models-fetch": "1" }),
    }));
    expect((await buildModelsList(["llm"], { skipDynamicFetch: true })).map((m) => m.id)).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("serves stale success immediately and refreshes without losing models on failure", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    db.connections.mockResolvedValue([connection("stale")]);
    global.fetch = vi.fn().mockResolvedValueOnce(response("model-a")).mockRejectedValueOnce(new Error("upstream down"));

    expect(await ids()).toEqual(["stale/model-a"]);
    now.mockReturnValue(1_000_000 + 5 * 60 * 1000 + 1);
    expect(await ids()).toEqual(["stale/model-a"]);
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(await ids()).toEqual(["stale/model-a"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("serves the old list while a successful refresh publishes new models", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(2_000_000);
    db.connections.mockResolvedValue([connection("update")]);
    global.fetch = vi.fn().mockResolvedValueOnce(response("old")).mockResolvedValueOnce(response("new"));

    expect(await ids()).toEqual(["update/old"]);
    now.mockReturnValue(2_000_000 + 5 * 60 * 1000 + 1);
    expect(await ids()).toEqual(["update/old"]);
    await vi.waitFor(async () => expect(await ids()).toEqual(["update/new"]));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes changed credentials and does not query explicit models", async () => {
    const first = connection("edited");
    db.connections.mockResolvedValue([first]);
    global.fetch = vi.fn().mockResolvedValueOnce(response("old")).mockResolvedValueOnce(response("new"));
    expect(await ids()).toEqual(["edited/old"]);

    db.connections.mockResolvedValue([{ ...first, apiKey: "changed-key" }]);
    expect(await ids()).toEqual(["edited/new"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    db.connections.mockResolvedValue([connection("pinned", { enabledModels: ["pinned/explicit"] })]);
    expect(await ids()).toEqual(["pinned/explicit"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds cold compatible discovery to three concurrent upstream requests", async () => {
    db.connections.mockResolvedValue(Array.from({ length: 5 }, (_, i) => connection(`parallel-${i}`)));
    let active = 0;
    let peak = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return response("model-a");
    });

    expect((await ids()).length).toBe(5);
    expect(global.fetch).toHaveBeenCalledTimes(5);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
