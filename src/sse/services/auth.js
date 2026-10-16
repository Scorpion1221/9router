import { getProviderConnections, validateApiKey, updateProviderConnection, updateProviderConnectionWith, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getBlockingLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { MAX_QUOTA_LOCK_MS } from "open-sse/services/quotaState.js";
import { rankResetFirst, earliestEligibleAt } from "open-sse/services/resetFirst.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getBlockingLockUntil(c, model);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getBlockingLockUntil(c, model)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "reset-first") {
      // Spend the quota that expires first; reserve accounts only when no normal one can.
      // Reads in-memory quota snapshots only: this runs inside the selection mutex.
      const { order, blocked } = rankResetFirst(availableConnections, model);
      if (!order.length) {
        // Retry when the first account frees up: a quota window refills, a release
        // window opens, or a lock on one of the other accounts expires.
        const lockEnds = connections.filter((c) => !excludeSet.has(c.id))
          .map((c) => getBlockingLockUntil(c, model)).filter(Boolean).map((t) => new Date(t).getTime());
        const candidates = [earliestEligibleAt(blocked), ...lockEnds].filter(Boolean);
        const until = candidates.length ? Math.min(...candidates) : null;
        const retryAfter = new Date(until || Date.now() + 5 * 60 * 1000).toISOString();
        const reasons = blocked.map(({ conn: c, assessment: a }) => `${c.name || c.id?.slice(0, 8)}: ${a.reason}`).join("; ");
        log.warn("AUTH", `${provider} | reset-first: no usable account for ${model || "all"} (${formatRetryAfter(retryAfter)}) | ${reasons}`);
        // Account names (often upstream emails) and policies stay in the server log.
        return {
          allRateLimited: true,
          retryAfter,
          retryAfterHuman: formatRetryAfter(retryAfter),
          lastError: "No account has quota left (every account is exhausted or at its keep line)",
          lastErrorCode: 429,
        };
      }
      connection = order[0].conn;
      if (order[0].tier === "reserve") {
        log.info("AUTH", `${provider} | reset-first: no normal account usable, using reserve ${connection.name || connection.id?.slice(0, 8)}`);
      }
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, quota = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  let lockModel = githubResetAtMs ? null : model;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (quota?.resetsAtMs && quota.resetsAtMs > Date.now()) {
    // Quota window exhausted (Claude 5h/weekly, Codex usage limit): retrying before
    // its reset only collects more 429s, however far away the reset is.
    shouldFallback = true;
    cooldownMs = Math.min(quota.resetsAtMs - Date.now(), MAX_QUOTA_LOCK_MS);
    newBackoffLevel = 0;
    if (quota.scope === "account") lockModel = null;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(lockModel, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", quota?.resetsAtMs
    ? `${connName} locked ${lockKey} until ${new Date(Date.now() + cooldownMs).toISOString()} [${status}, quota ${quota.window}]`
    : `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks. Keys already null are
  // skipped: writing them anyway (with testStatus "active") wiped every lock on the
  // fresh row, including one another request had just set.
  const keysToClear = allLockKeys.filter(k => {
    const expiry = conn[k];
    if (!expiry) return false;
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    return new Date(expiry).getTime() <= now;             // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain. Decided again on the current
  // row: the snapshot is from selection time, and a concurrent request may have
  // locked the account since (testStatus "active" would wipe that lock too).
  await updateProviderConnectionWith(connectionId, (current) => {
    const stillLocked = Object.keys(current).some((k) => k.startsWith("modelLock_") && !(k in clearObj)
      && current[k] && new Date(current[k]).getTime() > Date.now());
    if (remainingActiveLocks.length || stillLocked) return clearObj;
    return { ...clearObj, testStatus: "active", lastError: null, errorCode: null, lastErrorAt: null, backoffLevel: 0 };
  });
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
