/**
 * Codex (OpenAI) usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: U("codex").url,
  resetCreditsUrl: U("codex").resetCreditsUrl,
  resetCreditsConsumeUrl: U("codex").resetCreditsConsumeUrl,
};

function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function errorMessage(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value.message === "string") return value.message;
  return JSON.stringify(value);
}

// Same order as the Codex executor (open-sse/executors/codex.js), so usage, resets
// and inference all bind to the same workspace.
function getCodexAccountId(providerSpecificData) {
  return providerSpecificData?.workspaceId || providerSpecificData?.chatgptAccountId || providerSpecificData?.accountId || null;
}

function getCodexRateLimitBody(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return snapshot.rate_limit && typeof snapshot.rate_limit === "object"
    ? snapshot.rate_limit
    : snapshot;
}

function windowSeconds(window) {
  const seconds = toFiniteNumber(window?.limit_window_seconds, NaN);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const minutes = toFiniteNumber(window?.window_minutes, NaN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
}

function formatCodexWindow(window) {
  const used = Math.max(0, Math.min(100, toFiniteNumber(window?.used_percent ?? window?.percent_used, 0)));
  let resetAt = parseResetTime(window?.reset_at ?? window?.resets_at ?? window?.resetAt ?? null);
  const resetAfter = toFiniteNumber(window?.reset_after_seconds, NaN);
  if (!resetAt && Number.isFinite(resetAfter) && resetAfter > 0) resetAt = new Date(Date.now() + resetAfter * 1000).toISOString();
  return {
    used,
    total: 100,
    remaining: Math.max(0, 100 - used),
    resetAt,
    windowSeconds: windowSeconds(window),
    unlimited: false,
  };
}

// "session" (5h) or "weekly" for a window. Primary/secondary is NOT 5h/weekly by
// position: Pro accounts now report only a weekly window, sent as primary.
function codexWindowKind(window, positional) {
  const seconds = windowSeconds(window);
  if (!seconds) return positional;
  return seconds >= 24 * 3600 ? "weekly" : "session";
}

function appendCodexQuotaWindows(quotas, prefix, snapshot) {
  const rateLimit = getCodexRateLimitBody(snapshot);
  if (!rateLimit) return false;

  const primary = rateLimit.primary_window || rateLimit.primary || snapshot.primary_window || snapshot.primary;
  const secondary = rateLimit.secondary_window || rateLimit.secondary || snapshot.secondary_window || snapshot.secondary;
  let added = false;

  for (const [window, positional] of [[primary, "session"], [secondary, "weekly"]]) {
    if (!window) continue;
    const kind = codexWindowKind(window, positional);
    const key = prefix ? `${prefix}_${kind}` : kind;
    if (quotas[key]) continue;
    quotas[key] = formatCodexWindow(window);
    added = true;
  }

  return added;
}

function getCodexReviewRateLimit(data) {
  if (data.code_review_rate_limit || data.review_rate_limit) {
    return data.code_review_rate_limit || data.review_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId.code_review || byLimitId.codex_review || byLimitId.review || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id === "code_review" || id === "codex_review" || id === "review" || id.includes("review");
  }) || null;
}

function getCodexSparkRateLimit(data) {
  if (data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit) {
    return data.spark_rate_limit || data.gpt_5_3_codex_spark_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId["gpt-5.3-codex-spark"] || byLimitId.gpt_5_3_codex_spark || byLimitId.spark || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id.includes("spark") || id.includes("5.3-codex-spark");
  }) || null;
}

export async function getCodexUsage(accessToken, proxyOptions = null, providerSpecificData = null) {
  try {
    const headers = {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    };
    // Without the binding, a login in several workspaces reports its default one.
    const accountId = getCodexAccountId(providerSpecificData);
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;
    const response = await proxyAwareFetch(CODEX_CONFIG.usageUrl, {
      method: "GET",
      headers,
    }, proxyOptions);

    if (!response.ok) {
      return { message: `Codex connected. Usage API temporarily unavailable (${response.status}).` };
    }

    const data = await response.json();
    const normalRateLimit = data.rate_limit || data.rate_limits || data.rate_limits_by_limit_id?.codex || {};
    const reviewRateLimit = getCodexReviewRateLimit(data);
    const sparkRateLimit = getCodexSparkRateLimit(data);
    const availableResetCredits = Math.max(0, toFiniteNumber(data.rate_limit_reset_credits?.available_count, 0));
    const quotas = {};

    appendCodexQuotaWindows(quotas, "", normalRateLimit);
    appendCodexQuotaWindows(quotas, "review", reviewRateLimit);
    appendCodexQuotaWindows(quotas, "spark", sparkRateLimit);

    return {
      fetchedAt: Date.now(),
      plan: data.plan_type || data.summary?.plan || "unknown",
      limitReached: getCodexRateLimitBody(normalRateLimit)?.limit_reached || false,
      reviewLimitReached: getCodexRateLimitBody(reviewRateLimit)?.limit_reached || false,
      sparkLimitReached: getCodexRateLimitBody(sparkRateLimit)?.limit_reached || false,
      resetCredits: { availableCount: availableResetCredits },
      quotas,
    };
  } catch (error) {
    throw new Error(`Failed to fetch Codex usage: ${error.message}`);
  }
}

export async function getCodexRateLimitResetCredits(accessToken, proxyOptions = null, providerSpecificData = null) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }

  const accountId = getCodexAccountId(providerSpecificData);
  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json",
    "OpenAI-Beta": "codex-1",
    "originator": "codex_cli_rs",
  };
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;

  const response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsUrl, {
    method: "GET",
    headers,
  }, proxyOptions);

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = errorMessage(data?.message || data?.error || data?.detail, `Codex reset credits API unavailable (${response.status}).`);
    throw new Error(message);
  }

  const credits = Array.isArray(data?.credits) ? data.credits : [];
  return {
    availableCount: Math.max(0, toFiniteNumber(data?.available_count ?? data?.availableCount, 0)),
    credits: credits.map((credit) => ({
      ...(typeof credit?.id === "string" && credit.id ? { id: credit.id } : {}),
      ...(typeof credit?.title === "string" && credit.title ? { title: credit.title } : {}),
      status: String(credit?.status || "unknown"),
      grantedAt: toIsoDate(credit?.granted_at ?? credit?.grantedAt),
      expiresAt: toIsoDate(credit?.expires_at ?? credit?.expiresAt),
    })),
  };
}

// Consume codes the Codex CLI knows; any other code is not a definite answer.
const CODEX_CONSUME_CODES = new Set(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]);
const CODEX_RESET_TIMEOUT_MS = 20000;

// Consume one Codex rate-limit reset credit (irreversible, spends 1 credit).
// redeemRequestId is the idempotency key: a retry of the same attempt must reuse it
// (the backend then answers already_redeemed instead of spending a second credit).
export async function consumeCodexRateLimitResetCredit(accessToken, redeemRequestId, proxyOptions = null, { providerSpecificData = null, creditId = null } = {}) {
  if (!accessToken) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }
  if (!redeemRequestId || typeof redeemRequestId !== "string") {
    throw new Error("A redeem request id is required to consume a Codex reset credit.");
  }

  // Same account binding as every other Codex call: without it a multi-workspace
  // login could spend the credit of (or reset) a different account.
  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  const accountId = getCodexAccountId(providerSpecificData);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;

  let response;
  let data = null;
  try {
    response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsConsumeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ redeem_request_id: redeemRequestId, ...(creditId ? { credit_id: creditId } : {}) }),
      signal: AbortSignal.timeout(CODEX_RESET_TIMEOUT_MS),
    }, proxyOptions);

    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    // The request may have reached the backend: the outcome is unknown, not a failure.
    return { ok: false, uncertain: true, noCredit: false, nothingToReset: false, alreadyRedeemed: false, status: response?.status ?? null, code: null, windowsReset: 0, message: `No answer from Codex: ${error.message}`, raw: null };
  }

  const code = data?.code || null;
  const windowsReset = toFiniteNumber(data?.windows_reset, 0);
  // already_redeemed: this same redeem id already reset the windows (idempotent success).
  const success = response.ok && (code === "reset" || code === "already_redeemed");

  return {
    ok: success,
    uncertain: !(response.ok && CODEX_CONSUME_CODES.has(code)),
    noCredit: response.ok && code === "no_credit",
    nothingToReset: response.ok && code === "nothing_to_reset",
    alreadyRedeemed: response.ok && code === "already_redeemed",
    status: response.status,
    code,
    windowsReset,
    message: data?.message || null,
    raw: data,
  };
}
