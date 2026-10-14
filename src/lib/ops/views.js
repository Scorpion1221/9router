// Read-only views for /api/ops/*. Everything here goes through an allowlist of
// fields: provider connections carry OAuth tokens, refresh tokens and upstream
// API keys in their data blob, and none of it may leave the server.
import { getProviderConnections, getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { getCombos } from "@/lib/db/repos/combosRepo.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getRequestMetricsSummary, getLastOkByConnection, REQUEST_METRICS_RETENTION_DAYS } from "@/lib/db/repos/requestMetricsRepo.js";
import { MODEL_LOCK_PREFIX } from "open-sse/services/accountFallback.js";
import { opsError } from "./auth.js";
import { redactSecrets, maskName } from "./redact.js";

const MAX_WINDOW_MS = REQUEST_METRICS_RETENTION_DAYS * 86400000;

/** Parse "15m" / "6h" / "2d" (or a plain number of minutes) into ms, capped to retention. */
export function parseSince(value, fallback = "1h") {
  const raw = String(value || fallback).trim();
  const m = /^(\d+)\s*([mhd]?)$/i.exec(raw);
  if (!m) throw opsError(400, `invalid --since '${raw}' (use e.g. 30m, 6h, 2d)`);
  const n = Number(m[1]);
  const unit = (m[2] || "m").toLowerCase();
  const ms = n * (unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000);
  if (ms <= 0) throw opsError(400, "--since must be positive");
  return Math.min(ms, MAX_WINDOW_MS);
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** Active model locks on a connection: [{ model, until }] (expired ones dropped). */
export function activeLocks(conn, now = Date.now()) {
  const out = [];
  for (const [k, v] of Object.entries(conn || {})) {
    if (!k.startsWith(MODEL_LOCK_PREFIX) || !v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > now) out.push({ model: k.slice(MODEL_LOCK_PREFIX.length) === "__all" ? "*" : k.slice(MODEL_LOCK_PREFIX.length), until: new Date(t).toISOString() });
  }
  return out.sort((a, b) => a.until.localeCompare(b.until));
}

/** Allowlisted public shape of a provider connection. */
export function publicConnection(c) {
  return {
    id: c.id,
    name: maskName(c.name || c.email || c.id),
    provider: c.provider,
    authType: c.authType,
    priority: c.priority ?? null,
    active: !!c.isActive,
    testStatus: c.testStatus || null,
    lastError: c.lastError ? redactSecrets(c.lastError) : null,
    lastErrorAt: c.lastErrorAt || null,
    errorCode: c.errorCode ?? null,
    backoffLevel: c.backoffLevel ?? null,
    expiresAt: c.expiresAt || c.tokenExpiresAt || null,
    locks: activeLocks(c),
  };
}

export async function listAccounts({ provider, since = "1h", withLastOk = false } = {}) {
  const windowMs = parseSince(since);
  const now = Date.now();
  const conns = await getProviderConnections(provider ? { provider } : {});
  const stats = await getRequestMetricsSummary({ kind: "attempt", since: now - windowMs, until: now, provider, groupBy: "connectionId" });
  const byConn = new Map(stats.rows.map((r) => [r.key, r]));
  // Last success can be older than the window: look across the whole retention
  // (only for the accounts view; status/check don't need it).
  const lastOkBy = withLastOk ? await getLastOkByConnection({ provider }) : new Map();
  return conns.map((c) => {
    const s = byConn.get(c.id);
    const pub = publicConnection(c);
    const locked = pub.locks.length > 0;
    return {
      ...pub,
      state: !pub.active ? "disabled" : locked ? "locked" : "ok",
      window: since,
      attempts: s?.total || 0,
      ok: s?.ok || 0,
      rateLimited: s?.status?.[429] || 0,
      errors: s?.error || 0,
      lastOkAt: iso(lastOkBy.get(c.id) || null),
    };
  });
}

export async function getAccount(id) {
  const c = await getProviderConnectionById(id);
  if (!c) return null;
  return c;
}

export async function listCombos() {
  const [combos, settings] = await Promise.all([getCombos(), getSettings()]);
  const strategies = settings.comboStrategies || {};
  return combos.map((c) => ({
    name: c.name,
    strategy: strategies[c.name]?.fallbackStrategy || settings.comboStrategy || "fallback",
    models: c.models,
  }));
}

/** Inference key metadata. Never the key itself. */
export async function listKeys() {
  const keys = await getApiKeys();
  return keys.map((k) => ({
    name: k.name || k.id,
    id: k.id,
    active: k.isActive,
    restricted: !!k.access?.restricted,
    allow: k.access?.restricted ? (k.access.allow || []) : [],
    createdAt: k.createdAt,
  }));
}

export async function healthSummary({ since = "1h", groupBy = null } = {}) {
  const windowMs = parseSince(since);
  const now = Date.now();
  const allowed = new Set([null, "hour", "model", "keyName", "errorType", "status"]);
  if (!allowed.has(groupBy)) throw opsError(400, `invalid --by '${groupBy}' (use hour, model, key, error, status)`);
  return getRequestMetricsSummary({ kind: "request", since: now - windowMs, until: now, groupBy });
}

export async function attemptErrors({ since = "1h" } = {}) {
  const windowMs = parseSince(since);
  const now = Date.now();
  const res = await getRequestMetricsSummary({ kind: "attempt", since: now - windowMs, until: now, groupBy: ["provider", "errorType"] });
  return res.rows.filter((r) => r.error + r.aborted + r.rejected > 0);
}

export async function usageBreakdown({ since = "24h", by = "model", model } = {}) {
  const windowMs = parseSince(since, "24h");
  const now = Date.now();
  const col = { model: "model", key: "keyName", "key,model": ["keyName", "model"] }[by];
  if (!col) throw opsError(400, `invalid --by '${by}' (use model, key, key,model)`);
  const res = await getRequestMetricsSummary({ kind: "request", since: now - windowMs, until: now, groupBy: col, model: model || undefined });
  return res.rows;
}
