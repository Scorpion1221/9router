import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), proxy: vi.fn(), refresh: vi.fn(), persist: vi.fn(), connections: vi.fn(), rows: new Map(), db: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("@/lib/network/connectionProxy.js", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/lib/localDb.js", () => ({ getProviderConnections: mocks.connections }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.db }));
vi.mock("@/sse/services/tokenRefresh", () => ({ refreshCodexToken: mocks.refresh, updateProviderCredentials: mocks.persist }));
const { normalizeCodexModels, resolveCodexModels, getCodexModelCatalog, clearCodexModelMemoryCache } = await import("@/lib/codexModels.js");
const account = (id = "a", extra = {}) => ({ id, provider: "codex", isActive: true, accessToken: `secret-${id}`, providerSpecificData: { chatgptAccountId: `workspace-${id}` }, ...extra });
const manifest = (id = "gpt-6-astra", context = 272000) => ({ models: [{ slug: id, display_name: id, visibility: "list", supported_in_api: true, context_window: context, max_context_window: 872000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }], default_reasoning_level: "low", base_instructions: "PRIVATE_BASE_PROMPT" }] });
const ok = (body) => Response.json(body);
const modelsCalls = () => mocks.fetch.mock.calls.filter(([url]) => url.includes("/codex/models?"));

beforeEach(() => {
  vi.resetAllMocks(); mocks.rows.clear(); clearCodexModelMemoryCache();
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  vi.stubEnv("CODEX_MODELS_CLIENT_VERSION", "");
  mocks.db.mockResolvedValue({ get: (_sql, [scope, key]) => mocks.rows.has(`${scope}:${key}`) ? { value: mocks.rows.get(`${scope}:${key}`) } : undefined, run: (_sql, [scope, key, value]) => mocks.rows.set(`${scope}:${key}`, value) });
  mocks.proxy.mockResolvedValue({ connectionProxyEnabled: false });
  mocks.connections.mockResolvedValue([account()]);
  mocks.fetch.mockImplementation(async (url) => url.includes("registry.npmjs.org") ? ok({ name: "@openai/codex", version: "0.153.4" }) : ok(manifest()));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); clearCodexModelMemoryCache(); });

describe("Codex native manifest normalization", () => {
  it("retains Spark despite public API flag, filters hidden entries, and preserves review aliases", () => {
    const rows = normalizeCodexModels({ models: [...manifest().models, { slug: "gpt-5.3-codex-spark", supported_in_api: false, visibility: "list" }, { slug: "gpt-reserve", visibility: "hide" }, null, { slug: "" }] });
    expect(rows.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-astra-review", "gpt-5.3-codex-spark", "gpt-5.3-codex-spark-review"]);
    expect(rows[1]).toMatchObject({ upstreamModelId: "gpt-6-astra", quotaFamily: "review" });
  });
  it("uses default context, not advertised maximum; whitelists safe capabilities", () => {
    const [m] = normalizeCodexModels(manifest());
    expect(m).toMatchObject({ contextWindow: 272000, reasoningLevels: ["low", "ultra"], capabilities: { contextWindow: 272000, vision: true, reasoning: true } });
    expect(JSON.stringify(m)).not.toContain("PRIVATE_BASE_PROMPT");
    expect(m).not.toHaveProperty("max_context_window");
  });
  it.each([{}, { models: {} }, null, { models: [{ slug: "test", supported_reasoning_levels: {} }] }, { data: [{ id: "test", supported_reasoning_levels: [null, {}] }] }])("tolerates malformed/optional fields: %j", (body) => {
    expect(() => normalizeCodexModels(body)).not.toThrow();
  });
});

describe("account-scoped, version-aware discovery", () => {
  it("uses latest official stable version and never forwards account credentials to npm", async () => {
    const result = await resolveCodexModels(account());
    expect(result.clientVersion).toBe("0.153.4");
    expect(modelsCalls()[0]).toEqual([expect.stringContaining("client_version=0.153.4"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-a", "ChatGPT-Account-ID": "workspace-a" }) }), { connectionProxyEnabled: false }]);
    const release = mocks.fetch.mock.calls.find(([url]) => url.includes("registry.npmjs.org"));
    expect(release).toHaveLength(2); expect(release[1].headers).toBeUndefined();
    expect(JSON.stringify([...mocks.rows])).not.toMatch(/secret-a|workspace-a|PRIVATE_BASE_PROMPT/);
  });
  it("coalesces concurrent requests and caches across module-memory eviction", async () => {
    await Promise.all(Array.from({ length: 8 }, () => resolveCodexModels(account())));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    clearCodexModelMemoryCache(); await resolveCodexModels(account());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("does not share different accounts or changed workspaces", async () => {
    await resolveCodexModels(account()); await resolveCodexModels(account("b"));
    await resolveCodexModels(account("a", { providerSpecificData: { workspaceId: "changed" } }));
    expect(modelsCalls()).toHaveLength(3);
  });
  it("invalidates an otherwise fresh account cache when release metadata changes", async () => {
    await resolveCodexModels(account());
    vi.setSystemTime(Date.now() + 9 * 60_000); await resolveCodexModels(account("b"));
    vi.setSystemTime(Date.now() + 2 * 60_000);
    mocks.fetch.mockImplementation(async (url) => url.includes("registry.npmjs.org") ? ok({ name: "@openai/codex", version: "0.154.0" }) : ok(manifest("gpt-new")));
    const result = await resolveCodexModels(account("b"));
    expect(result.clientVersion).toBe("0.154.0"); expect(result.models[0].id).toBe("gpt-new");
    expect(modelsCalls().at(-1)[0]).toContain("client_version=0.154.0");
  });
  it("supports a pinned compatibility version without npm lookup", async () => {
    vi.stubEnv("CODEX_MODELS_CLIENT_VERSION", "0.153.0");
    expect((await resolveCodexModels(account())).clientVersion).toBe("0.153.0");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{ name: "wrong-package", version: "99.0.0" }, { name: "@openai/codex", version: "0.999.0-alpha.1" }])("rejects invalid release metadata and falls back safely: %j", async (metadata) => {
    mocks.fetch.mockImplementation(async (url) => url.includes("registry.npmjs.org") ? ok(metadata) : ok(manifest()));
    expect((await resolveCodexModels(account())).clientVersion).toBe("0.153.4");
  });
  it("retains last successful version when npm fails", async () => {
    mocks.fetch.mockImplementation(async (url) => url.includes("registry.npmjs.org") ? ok({ name: "@openai/codex", version: "0.154.0" }) : ok(manifest()));
    await resolveCodexModels(account()); vi.setSystemTime(Date.now() + 11 * 60_000);
    mocks.fetch.mockImplementation(async (url) => { if (url.includes("registry.npmjs.org")) throw new Error("offline"); return ok(manifest()); });
    expect((await resolveCodexModels(account())).clientVersion).toBe("0.154.0");
  });
  it("retains last good model catalog on outage, backs off, and recovers", async () => {
    await resolveCodexModels(account()); vi.setSystemTime(Date.now() + 11 * 60_000);
    mocks.fetch.mockRejectedValue(new Error("secret upstream diagnostic"));
    const stale = await resolveCodexModels(account());
    expect(stale).toMatchObject({ stale: true, models: [expect.objectContaining({ id: "gpt-6-astra" }), expect.anything()] });
    expect(JSON.stringify(stale)).not.toContain("secret upstream");
    const count = mocks.fetch.mock.calls.length; await resolveCodexModels(account()); expect(mocks.fetch).toHaveBeenCalledTimes(count);
    vi.setSystemTime(Date.now() + 61_000);
    mocks.fetch.mockImplementation(async (url) => url.includes("registry.npmjs.org") ? ok({ name: "@openai/codex", version: "0.153.4" }) : ok(manifest("gpt-recovered")));
    expect((await resolveCodexModels(account())).models[0].id).toBe("gpt-recovered");
  });
  it("does not erase last successful catalog on an empty or hidden-only response", async () => {
    await resolveCodexModels(account()); mocks.fetch.mockImplementation(async (url) => url.includes("registry.npmjs.org") ? ok({ name: "@openai/codex", version: "0.153.4" }) : ok({ models: [{ slug: "hidden", visibility: "hide" }] }));
    expect((await resolveCodexModels(account(), { forceRefresh: true })).models[0].id).toBe("gpt-6-astra");
  });
  it("refreshes OAuth on 401, persists it, and retries with account/proxy binding", async () => {
    mocks.refresh.mockResolvedValue({ accessToken: "renewed", expiresIn: 3600 });
    let attempts = 0; mocks.fetch.mockImplementation(async (url) => url.includes("registry.npmjs.org") ? ok({ name: "@openai/codex", version: "0.153.4" }) : ++attempts === 1 ? new Response("expired", { status: 401 }) : ok(manifest()));
    const result = await resolveCodexModels(account("a", { refreshToken: "refresh-secret" }));
    expect(result.stale).toBe(false); expect(mocks.refresh).toHaveBeenCalledWith("refresh-secret");
    expect(mocks.persist).toHaveBeenCalledWith("a", { accessToken: "renewed", expiresIn: 3600 });
    expect(modelsCalls().at(-1)[1].headers).toMatchObject({ Authorization: "Bearer renewed", "ChatGPT-Account-ID": "workspace-a" });
  });
  it("soft fails without credentials or persistent DB", async () => {
    expect((await resolveCodexModels({})).source).toBe("unavailable"); expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.db.mockRejectedValue(new Error("DB offline"));
    expect((await resolveCodexModels(account())).models[0].id).toBe("gpt-6-astra");
  });
  it("unions active accounts only and uses conservative native context", async () => {
    mocks.fetch.mockImplementation(async (url, options) => url.includes("registry.npmjs.org") ? ok({ name: "@openai/codex", version: "0.153.4" }) : ok(manifest("gpt-6-astra", options.headers.Authorization.endsWith("a") ? 272000 : 128000)));
    const catalog = await getCodexModelCatalog([account(), account("b"), account("c", { isActive: false }), account("d", { provider: "openai" })]);
    expect(modelsCalls()).toHaveLength(2); expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]).toMatchObject({ contextWindow: 128000, capabilities: { contextWindow: 128000 } });
  });
});
