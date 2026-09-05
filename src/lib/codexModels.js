// Account-scoped Codex discovery. CLI release metadata is data only: never
// install/run a CLI, and never change the inference transport's version here.
import { createHash } from "node:crypto";
import { getAdapter } from "./db/driver.js";
import { getProviderConnections } from "./localDb.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveConnectionProxyConfig } from "./network/connectionProxy.js";
import { refreshCodexToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";

const SCOPE = "codexModelCatalog";
const TTL_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const VERSION_URL = "https://registry.npmjs.org/@openai/codex/latest";
const FALLBACK_VERSION = "0.153.4";
const memory = new Map();
const inflight = new Map();

async function readCache(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    const db = await getAdapter();
    const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, key]);
    if (row) {
      const value = JSON.parse(row.value);
      memory.set(key, value);
      return value;
    }
  } catch { /* Discovery must still work if persistent caching is unavailable. */ }
  return null;
}

async function writeCache(key, value) {
  memory.set(key, value);
  try {
    const db = await getAdapter();
    db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", [SCOPE, key, JSON.stringify(value)]);
  } catch { /* In-memory cache remains usable. No credentials are persisted here. */ }
}

async function clientVersion(forceRefresh) {
  const override = process.env.CODEX_MODELS_CLIENT_VERSION;
  if (override && /^\d+\.\d+\.\d+$/.test(override)) return override;
  const cached = await readCache("version");
  if (!forceRefresh && cached?.expiresAt > Date.now()) return cached.version;
  if (inflight.has("version")) return inflight.get("version");
  const request = (async () => {
    try {
      // Do not send account credentials or account-bound headers to npm.
      const response = await proxyAwareFetch(VERSION_URL, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Release metadata unavailable");
      const data = await response.json();
      if (data.name !== "@openai/codex" || !/^\d+\.\d+\.\d+$/.test(data.version)) {
        throw new Error("Invalid stable release metadata");
      }
      await writeCache("version", { version: data.version, expiresAt: Date.now() + TTL_MS });
      return data.version;
    } catch {
      const version = cached?.version || FALLBACK_VERSION;
      await writeCache("version", { version, expiresAt: Date.now() + RETRY_MS });
      return version;
    }
  })();
  inflight.set("version", request);
  try { return await request; } finally { inflight.delete("version"); }
}

export function normalizeCodexModels(data) {
  const entries = Array.isArray(data) ? data : data?.models || data?.data || [];
  if (!Array.isArray(entries)) return [];
  const models = new Map();
  for (const entry of entries) {
    const id = entry?.slug || entry?.id;
    if (typeof id !== "string" || !id.trim() || entry.visibility === "hide") continue;
    // supported_in_api=false does NOT exclude Codex OAuth models (e.g. Spark).
    // Whitelist metadata: manifests also contain private/base instructions.
    const model = { id, name: entry.display_name || entry.name || id, source: "codex", type: "llm" };
    if (Number.isFinite(entry.context_window) && entry.context_window > 0) model.contextWindow = entry.context_window;
    if (Number.isFinite(entry.max_output_tokens) && entry.max_output_tokens > 0) model.maxOutput = entry.max_output_tokens;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((item) => item?.effort).filter((level) => typeof level === "string") : [];
    if (levels?.length) model.reasoningLevels = levels;
    if (typeof entry.default_reasoning_level === "string") model.defaultReasoningLevel = entry.default_reasoning_level;
    model.capabilities = {
      ...getCapabilitiesForModel("codex", id),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutput ? { maxOutput: model.maxOutput } : {}),
      ...(levels.length ? { reasoning: true, thinkingFormat: "openai" } : {}),
      ...(Array.isArray(entry.input_modalities) ? { vision: entry.input_modalities.includes("image") } : {}),
    };
    models.set(id, model);
    if (!id.endsWith("-review")) {
      models.set(`${id}-review`, { ...model, id: `${id}-review`, name: `${model.name} Review`, upstreamModelId: id, quotaFamily: "review" });
    }
  }
  return [...models.values()];
}

export async function resolveCodexModels(connection, { forceRefresh = false } = {}) {
  if (!connection?.accessToken) return { models: [], source: "unavailable", warning: "No Codex access token" };
  const ps = connection.providerSpecificData || {};
  const account = ps.workspaceId || ps.chatgptAccountId || ps.accountId || "";
  const identity = `${connection.id || ""}:${account || connection.email || connection.accessToken}`;
  const key = `account:${createHash("sha256").update(identity).digest("hex")}`;
  const version = await clientVersion(forceRefresh);
  const cached = await readCache(key);
  if (!forceRefresh && cached?.retryAfter > Date.now()) return cached;
  if (!forceRefresh && cached?.expiresAt > Date.now() && cached.clientVersion === version) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const request = (async () => {
    try {
      const proxy = await resolveConnectionProxyConfig(ps);
      const fetchModels = (token) => proxyAwareFetch(
        `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,
        {
          headers: {
            Accept: "application/json", Authorization: `Bearer ${token}`, originator: "codex_cli_rs",
            ...(account ? { "ChatGPT-Account-ID": account } : {}),
          },
          signal: AbortSignal.timeout(10000),
        }, proxy,
      );
      let response = await fetchModels(connection.accessToken);
      if ((response.status === 401 || response.status === 403) && connection.refreshToken) {
        await response.body?.cancel();
        const refreshed = await refreshCodexToken(connection.refreshToken);
        if (refreshed?.accessToken) {
          await updateProviderCredentials(connection.id, refreshed);
          response = await fetchModels(refreshed.accessToken);
        }
      }
      if (!response.ok) throw new Error(`Codex catalog HTTP ${response.status}`);
      const models = normalizeCodexModels(await response.json());
      if (!models.length) throw new Error("Codex returned no visible models");
      const result = { models, source: "codex", clientVersion: version, fetchedAt: new Date().toISOString(), expiresAt: Date.now() + TTL_MS, stale: false };
      await writeCache(key, result);
      return result;
    } catch {
      // No raw upstream bodies/errors: they may contain credentials or prompts.
      const result = { ...cached, models: cached?.models || [], source: cached?.models?.length ? "codex" : "unavailable", stale: true, warning: "Codex discovery unavailable; retaining the last successful catalog", expiresAt: Date.now() + RETRY_MS, retryAfter: Date.now() + RETRY_MS };
      await writeCache(key, result);
      return result;
    }
  })();
  inflight.set(key, request);
  try { return await request; } finally { inflight.delete(key); }
}

// Both dashboard pickers and /v1/models use the same active-account union.
export async function getCodexModelCatalog(connections, options = {}) {
  const active = (connections || await getProviderConnections()).filter((c) => c.provider === "codex" && c.isActive !== false);
  const results = [];
  // Bound cold-start fan-out when a provider has many accounts.
  for (let index = 0; index < active.length; index += 3) {
    results.push(...await Promise.all(active.slice(index, index + 3).map((connection) => resolveCodexModels(connection, options))));
  }
  const union = new Map();
  for (const result of results) {
    for (const model of result.models) {
      const previous = union.get(model.id);
      if (!previous) union.set(model.id, { ...model });
      else if (previous.contextWindow && model.contextWindow) {
        previous.contextWindow = Math.min(previous.contextWindow, model.contextWindow);
        previous.capabilities = { ...previous.capabilities, contextWindow: previous.contextWindow };
      }
    }
  }
  return { models: [...union.values()], source: "codex", stale: results.some((r) => r.stale), clientVersion: results.find((r) => r.clientVersion)?.clientVersion || null };
}

export function clearCodexModelMemoryCache() {
  memory.clear();
  inflight.clear();
}
