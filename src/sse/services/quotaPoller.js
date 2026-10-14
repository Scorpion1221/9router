// Quota poller for Claude OAuth / Codex accounts: reads each account's usage API
// every 15 minutes into the live quota store (open-sse/services/quotaState.js), and
// lifts a quota lock as soon as the windows it waited on show quota again (a manual
// reset, an early reset by the provider, or a lock that was set too long).
// Fail-open everywhere; stops on drain like the token refresher.

import * as log from "../utils/logger.js";
import { onDrain, isDraining } from "../../lib/shutdown.js";
import { recordQuotaPoll, isQuotaProvider, remainingPct, windowAppliesTo } from "open-sse/services/quotaState.js";
import { MODEL_LOCK_ALL, MODEL_LOCK_PREFIX } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;
const BETWEEN_ACCOUNTS_MS = 1500;

const state = global.__quotaPollerState ??= {
  started: false,
  intervalHandle: null,
  initialTimeoutHandle: null,
  tickRunning: false,
  offDrain: null,
};

function isTruthyEnv(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Accounts the poller covers: active Claude/Codex OAuth connections. */
export function selectPollableConnections(connections) {
  return (connections || []).filter((c) => c?.isActive !== false && isQuotaProvider(c.provider)
    && String(c.authType || "").replace(/_/g, "").toLowerCase() === "oauth");
}

/**
 * Lock keys on `conn` a fresh quota snapshot shows are no longer needed: the
 * account-wide lock when every account-wide window has quota left. Model locks are
 * left alone (they also come from non-quota errors) unless they are quota locks the
 * model-scoped windows cover; those expire on their own at the window reset.
 */
export function quotaLocksToLift(conn, snapshot, now = Date.now()) {
  if (!conn || !snapshot?.windows) return [];
  const lockedAt = Date.parse(conn.lastErrorAt || "") || 0;
  // Only trust readings upstream gave after the lock was set (a cached reading can predate the 429).
  const usable = (k) => snapshot.windows[k] && (snapshot.windows[k].observedAt || 0) > lockedAt
    && remainingPct(snapshot.windows[k], now) > 0;
  const lift = [];
  for (const [key, value] of Object.entries(conn)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !value) continue;
    const until = Date.parse(value);
    if (!(until > now)) continue;
    if (key === MODEL_LOCK_ALL) {
      const accountWide = ["5h", "7d"].filter((k) => snapshot.windows[k]);
      if (accountWide.length && accountWide.every(usable)) lift.push(key);
      continue;
    }
    // A model lock is only a quota lock when it outlasts every non-quota cooldown;
    // lift it when the model-scoped window it waits on (e.g. 7d:opus) has quota again.
    if (until - now <= MAX_RATE_LIMIT_COOLDOWN_MS) continue;
    const model = key.slice(MODEL_LOCK_PREFIX.length);
    const scoped = Object.keys(snapshot.windows).filter((k) => k.includes(":") && windowAppliesTo(k, model));
    if (scoped.length && scoped.every(usable) && ["5h", "7d"].every((k) => !snapshot.windows[k] || usable(k))) lift.push(key);
  }
  return lift;
}

/**
 * Feed a usage-API result into the quota store and lift any quota lock it disproves.
 * Used by the poller, the dashboard usage route and the manual reset routes.
 */
export async function applyQuotaReading(conn, usage, deps = {}) {
  if (!conn?.id || !isQuotaProvider(conn.provider)) return null;
  const snapshot = recordQuotaPoll(conn.provider, conn.id, usage);
  if (!snapshot) return null;
  const lift = quotaLocksToLift(conn, snapshot);
  if (lift.length) {
    const update = deps.updateProviderConnection
      || (await import("../../lib/db/repos/connectionsRepo.js")).updateProviderConnection;
    await update(conn.id, Object.fromEntries(lift.map((k) => [k, null])));
    log.info("QUOTA", `${conn.name || conn.id.slice(0, 8)} has quota again; lifted ${lift.join(", ")}`);
  }
  return snapshot;
}

/**
 * Clear an account's locks right away after a manual reset that succeeded: the
 * account-wide one and model-scoped quota locks (a reset grant can also clear the
 * Opus/Sonnet/Fable weekly limits). Short non-quota cooldowns are left alone.
 */
export async function liftQuotaLockNow(connectionId, deps = {}) {
  const update = deps.updateProviderConnectionWith
    || (await import("../../lib/db/repos/connectionsRepo.js")).updateProviderConnectionWith;
  const now = Date.now();
  await update(connectionId, (current) => {
    const patch = {};
    for (const [key, value] of Object.entries(current)) {
      if (!key.startsWith(MODEL_LOCK_PREFIX) || !value) continue;
      if (key === MODEL_LOCK_ALL || Date.parse(value) - now > MAX_RATE_LIMIT_COOLDOWN_MS) patch[key] = null;
    }
    return Object.keys(patch).length ? patch : null;
  });
}

async function defaultPollOne(conn) {
  const { getProviderConnectionById } = await import("../../lib/db/repos/connectionsRepo.js");
  const { resolveConnectionProxyConfig } = await import("../../lib/network/connectionProxy.js");
  const { getUsageForProvider } = await import("open-sse/services/usage.js");
  const { refreshAndUpdateCredentials } = await import("../../app/api/usage/[connectionId]/route.js");
  // Work from the current row: a request may have rotated the single-use refresh token.
  let fresh = await getProviderConnectionById(conn.id);
  if (!fresh?.isActive) return;
  const proxyConfig = await resolveConnectionProxyConfig(fresh.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };
  ({ connection: fresh } = await refreshAndUpdateCredentials(fresh, false, proxyOptions));
  const usage = await getUsageForProvider(fresh, proxyOptions);
  await applyQuotaReading(fresh, usage);
}

async function defaultLoad() {
  const { getProviderConnections } = await import("../../lib/db/repos/connectionsRepo.js");
  return getProviderConnections({ isActive: true });
}

export async function runQuotaPollTick(deps = {}) {
  if (state.tickRunning) return;
  state.tickRunning = true;
  try {
    const load = deps.loadConnections || defaultLoad;
    const pollOne = deps.pollOne || defaultPollOne;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const targets = selectPollableConnections(await load());
    for (let i = 0; i < targets.length; i++) {
      if (isDraining()) return;
      try {
        await pollOne(targets[i]);
      } catch (err) {
        log.warn("QUOTA", "Quota poll failed (swallowed)", { id: targets[i]?.id, provider: targets[i]?.provider, error: err?.message ?? String(err) });
      }
      if (i < targets.length - 1) await sleep(BETWEEN_ACCOUNTS_MS);
    }
  } catch (err) {
    log.warn("QUOTA", "Quota poll tick failed (swallowed)", { error: err?.message ?? String(err) });
  } finally {
    state.tickRunning = false;
  }
}

export function startQuotaPoller({ intervalMs } = {}) {
  if (state.started) return false;
  if (isTruthyEnv(process.env.DISABLE_QUOTA_POLLER)) return false;
  if (typeof window !== "undefined" || process.env.NEXT_RUNTIME === "edge") return false;
  if (String(process.env.NEXT_PHASE || "").startsWith("phase-production-build")) return false;
  if (isDraining()) return false;

  state.started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs
    : Number(process.env.QUOTA_POLL_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const safeTick = () => { runQuotaPollTick().catch(() => {}); };
  state.initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  state.initialTimeoutHandle.unref?.();
  state.intervalHandle = setInterval(safeTick, period);
  state.intervalHandle.unref?.();
  log.info("QUOTA", "Quota poller started", { intervalMs: period });
  // Polling can refresh single-use OAuth tokens: a draining instance leaves it to its successor.
  if (!state.offDrain) state.offDrain = onDrain(stopQuotaPoller);
  return true;
}

export function stopQuotaPoller() {
  if (state.initialTimeoutHandle) { clearTimeout(state.initialTimeoutHandle); state.initialTimeoutHandle = null; }
  if (state.intervalHandle) { clearInterval(state.intervalHandle); state.intervalHandle = null; }
  state.started = false;
}
