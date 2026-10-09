// Background proactive OAuth token refresh — independent of inbound requests.
// Fail-open everywhere: tick errors and per-connection failures never kill the interval.

import * as log from "../utils/logger.js";
import { onDrain, isDraining } from "../../lib/shutdown.js";
import { getRefreshLeadMs } from "open-sse/services/tokenRefresh.js";
import { getCredentialExpiryMs } from "open-sse/services/oauthCredentialManager.js";

/** Refresh when expiry is within 30 minutes (or the provider on-request lead, whichever larger). */
export const BACKGROUND_REFRESH_LEAD_MS = 30 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 1000;
const SENSITIVE_PROVIDERS = new Set(["antigravity", "gemini-cli"]);

// Next bundles this module separately into instrumentation and into the app's server
// chunks, and each copy has its own module scope. The state lives on global so a
// second start from another copy is a no-op instead of a second interval refreshing
// the same single-use refresh tokens.
const state = global.__bgTokenRefreshState ??= {
  started: false,
  intervalHandle: null,
  initialTimeoutHandle: null,
  tickRunning: false,
  offDrain: null,
};

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (
    phase === "phase-production-build" ||
    phase === "phase-export" ||
    phase === "phase-static"
  ) {
    return true;
  }
  // Next.js build / static generation markers
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

/**
 * Pure selection: OAuth connections with a refreshToken whose access token
 * expires within max(provider on-request lead, BACKGROUND_REFRESH_LEAD_MS).
 *
 * @param {Array<object>} connections
 * @param {number} [nowMs]
 * @returns {Array<object>}
 */
export function selectConnectionsNeedingRefresh(connections, nowMs = Date.now()) {
  if (!Array.isArray(connections) || connections.length === 0) return [];

  const out = [];
  for (const conn of connections) {
    if (!conn) continue;

    const authType = String(conn.authType || "").toLowerCase().replace(/_/g, "");
    if (authType !== "oauth") continue;
    if (!conn.refreshToken) continue;

    const expiresAtMs = getCredentialExpiryMs(conn);
    if (expiresAtMs === null) continue;

    const providerLead = getRefreshLeadMs(conn.provider);
    const leadMs = Math.max(
      Number.isFinite(providerLead) ? providerLead : 0,
      BACKGROUND_REFRESH_LEAD_MS
    );

    if (expiresAtMs - nowMs < leadMs) {
      out.push(conn);
    }
  }
  return out;
}

async function loadActiveConnections() {
  // Dynamic import avoids circular load with db / app graph at module eval time.
  const { getProviderConnections } = await import("../../lib/db/repos/connectionsRepo.js");
  return getProviderConnections({ isActive: true });
}

async function refreshOne(connection) {
  // The tick's snapshot can be a minute old by the time this account comes up (accounts
  // are refreshed one by one with delays). If a request already rotated the refresh
  // token meanwhile, force-refreshing the snapshot would spend the old single-use token
  // again and get the session revoked, so work from the current row.
  const { getProviderConnectionById } = await import("../../lib/db/repos/connectionsRepo.js");
  const fresh = await getProviderConnectionById(connection.id);
  if (!fresh?.isActive || selectConnectionsNeedingRefresh([fresh]).length === 0) return null;
  const { checkAndRefreshToken } = await import("./tokenRefresh.js");
  return checkAndRefreshToken(fresh.provider, fresh, { force: true });
}

/**
 * One scheduler tick. Fail-open at top level and per connection.
 * @param {{ loadConnections?: Function, refreshConnection?: Function }} [deps]
 */
export async function runBackgroundTokenRefreshTick(deps = {}) {
  if (state.tickRunning) return;
  state.tickRunning = true;
  try {
    const load = deps.loadConnections || loadActiveConnections;
    const refresh = deps.refreshConnection || refreshOne;
    const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));

    const connections = await load();
    const due = selectConnectionsNeedingRefresh(connections, Date.now());

    if (due.length === 0) return;

    const baseSensitiveDelay = Number(process.env.BG_REFRESH_GOOGLE_DELAY_MS) || 12_000;
    const baseNormalDelay = Number(process.env.BG_REFRESH_DELAY_MS) || 1_500;

    for (let i = 0; i < due.length; i++) {
      const conn = due[i];
      try {
        await refresh(conn);
        log.info("BG_TOKEN_REFRESH", "Connection refresh finished", {
          id: conn.id,
          email: conn.email || conn.name || conn.id,
          provider: conn.provider,
        });
      } catch (err) {
        log.warn("BG_TOKEN_REFRESH", "Connection refresh failed (swallowed)", {
          id: conn?.id,
          email: conn?.email || conn?.name || conn?.id,
          provider: conn?.provider,
          error: err?.message ?? String(err),
        });
      }

      // Sequential delay between accounts to prevent bursting upstream providers (especially Google Cloud)
      if (i < due.length - 1) {
        const isSensitive = SENSITIVE_PROVIDERS.has(conn.provider);
        const baseDelay = isSensitive ? baseSensitiveDelay : baseNormalDelay;
        const jitter = isSensitive ? Math.floor(Math.random() * 4000) : 200;
        await sleep(baseDelay + jitter);
      }
    }
  } catch (err) {
    log.warn("BG_TOKEN_REFRESH", "Tick failed (swallowed)", {
      error: err?.message ?? String(err),
    });
  } finally {
    state.tickRunning = false;
  }
}

/**
 * Start the background interval. Safe to call multiple times (no-op if already started).
 * @param {{ intervalMs?: number }} [opts]
 * @returns {boolean} true if started this call
 */
export function startBackgroundTokenRefresh({ intervalMs } = {}) {
  if (state.started) return false;
  if (isTruthyEnv(process.env.DISABLE_BACKGROUND_TOKEN_REFRESH)) return false;
  if (isNonServerRuntime()) return false;
  if (isDraining()) return false;

  state.started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;

  const safeTick = () => {
    runBackgroundTokenRefreshTick().catch((err) => {
      log.warn("BG_TOKEN_REFRESH", "Unhandled tick rejection (swallowed)", {
        error: err?.message ?? String(err),
      });
    });
  };

  // First pass soon after boot so idle connections don't wait a full interval.
  state.initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (state.initialTimeoutHandle.unref) state.initialTimeoutHandle.unref();

  state.intervalHandle = setInterval(safeTick, period);
  if (state.intervalHandle.unref) state.intervalHandle.unref();

  log.info("BG_TOKEN_REFRESH", "Scheduler started", { intervalMs: period });
  // A draining instance leaves refreshing to the one replacing it: refresh tokens
  // are single-use, and two processes refreshing the same one revoke the session.
  if (!state.offDrain) state.offDrain = onDrain(stopBackgroundTokenRefresh);
  return true;
}

export function stopBackgroundTokenRefresh() {
  if (state.initialTimeoutHandle) {
    clearTimeout(state.initialTimeoutHandle);
    state.initialTimeoutHandle = null;
  }
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
  if (state.started) {
    state.started = false;
  }
}
