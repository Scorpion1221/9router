// Live quota per account (Claude OAuth, Codex): window usage from upstream response
// headers on every call plus a periodic usage-API poll, merged per window by
// observation time. In memory only (per process); the poll refills it after a
// restart. Also parses quota-exhausted 429s into an exact reset time for a lock.
//
// Window keys: "5h" and "7d" are account-wide; "7d:<scope>" / "5h:<scope>" only
// apply to models whose id contains <scope> (Claude "weekly fable", Codex spark).

const QUOTA_PROVIDERS = new Set(["claude", "codex"]);
const FIVE_HOURS_S = 5 * 3600;
const WEEK_S = 7 * 24 * 3600;
// A quota lock longer than this is treated as a bogus timestamp.
export const MAX_QUOTA_LOCK_MS = 8 * 24 * 3600 * 1000;

// On globalThis: Next bundles this module into several chunks (instrumentation,
// routes) and the poller, the request path and the dashboard must share one store.
const store = globalThis.__9rQuotaState ??= { snapshots: new Map() };

export function isQuotaProvider(provider) {
  return QUOTA_PROVIDERS.has(provider);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Window length in seconds → "5h" | "7d" | null (daily/credit buckets are ignored).
function lengthKey(seconds) {
  if (!seconds) return null;
  if (Math.abs(seconds - FIVE_HOURS_S) <= 600) return "5h";
  if (Math.abs(seconds - WEEK_S) <= 3600) return "7d";
  return null;
}

const getHeader = (headers, name) => {
  try { return headers?.get?.(name) ?? null; } catch { return null; }
};

/**
 * Parse the quota windows an upstream response reports in its headers.
 * Claude: anthropic-ratelimit-unified-{5h,7d}-{utilization 0..1, reset unix s}.
 * Codex: x-codex-{primary,secondary}-{used-percent, window-minutes, reset-at};
 * primary/secondary are classified by window length, never by position.
 * @returns {{ windows: object, status?: string, claim?: string, resetAtMs?: number } | null}
 */
export function parseQuotaHeaders(provider, headers, now = Date.now()) {
  if (!headers || !isQuotaProvider(provider)) return null;
  const windows = {};
  if (provider === "claude") {
    for (const [tag, key] of [["5h", "5h"], ["7d", "7d"]]) {
      const used = num(getHeader(headers, `anthropic-ratelimit-unified-${tag}-utilization`));
      const reset = num(getHeader(headers, `anthropic-ratelimit-unified-${tag}-reset`));
      if (used === null) continue;
      windows[key] = {
        usedPct: Math.max(0, Math.min(100, used * 100)),
        resetAt: reset ? reset * 1000 : null,
        observedAt: now,
        source: "headers",
      };
    }
    const status = getHeader(headers, "anthropic-ratelimit-unified-status");
    const claim = getHeader(headers, "anthropic-ratelimit-unified-representative-claim");
    const reset = num(getHeader(headers, "anthropic-ratelimit-unified-reset"));
    if (!Object.keys(windows).length && !status) return null;
    return { windows, status: status || null, claim: claim || null, resetAtMs: reset ? reset * 1000 : null };
  }

  // Codex: an image-generation call reports the image bucket in the same headers.
  const active = getHeader(headers, "x-codex-active-limit");
  if (active && /image/i.test(active)) return null;
  for (const slot of ["primary", "secondary"]) {
    const minutes = num(getHeader(headers, `x-codex-${slot}-window-minutes`));
    const key = lengthKey(minutes ? minutes * 60 : null);
    const used = num(getHeader(headers, `x-codex-${slot}-used-percent`));
    if (!key || used === null) continue;
    const reset = num(getHeader(headers, `x-codex-${slot}-reset-at`));
    windows[key] = {
      usedPct: Math.max(0, Math.min(100, used)),
      resetAt: reset ? reset * 1000 : null,
      observedAt: now,
      source: "headers",
    };
  }
  return Object.keys(windows).length ? { windows } : null;
}

// Claude representative claims that cover the whole account (vs one model family).
const CLAUDE_ACCOUNT_CLAIMS = new Set(["five_hour", "seven_day"]);
const CLAUDE_CLAIM_WINDOW = { five_hour: "5h", seven_day: "7d" };

/**
 * A quota-exhausted rejection from a 429's headers: when to retry and whether it
 * covers the account or only the requested model. Null when the 429 is not a
 * quota rejection (burst limits, missing headers): those keep the normal backoff.
 */
export function quotaRejectionFromHeaders(provider, headers, now = Date.now()) {
  if (provider !== "claude") return null;
  const parsed = parseQuotaHeaders(provider, headers, now);
  if (!parsed || parsed.status !== "rejected") return null;
  let resetsAtMs = parsed.resetAtMs;
  if (!resetsAtMs && parsed.claim) {
    resetsAtMs = parsed.windows[CLAUDE_CLAIM_WINDOW[parsed.claim]]?.resetAt || null;
  }
  if (!resetsAtMs || resetsAtMs <= now) return null;
  const scope = !parsed.claim || CLAUDE_ACCOUNT_CLAIMS.has(parsed.claim) ? "account" : "model";
  return { resetsAtMs, scope, window: parsed.claim || "unknown" };
}

function mergeWindows(prev, next) {
  const out = { ...(prev || {}) };
  for (const [key, w] of Object.entries(next || {})) {
    if (!out[key] || (w.observedAt || 0) >= (out[key].observedAt || 0)) out[key] = w;
  }
  return out;
}

/** Record the windows a response's headers carry. Sync and fail-open: never throws. */
export function recordQuotaHeaders(provider, connectionId, headers) {
  try {
    if (!connectionId || connectionId === "noauth" || !isQuotaProvider(provider)) return;
    const parsed = parseQuotaHeaders(provider, headers);
    if (!parsed || !Object.keys(parsed.windows).length) return;
    const prev = store.snapshots.get(connectionId);
    store.snapshots.set(connectionId, {
      provider,
      windows: mergeWindows(prev?.windows, parsed.windows),
      updatedAt: Date.now(),
    });
  } catch { /* quota tracking must never break a request */ }
}

/**
 * Normalize a usage-API result (open-sse/services/usage/{claude,codex}.js) into windows.
 * Claude keys: "session (5h)", "weekly (7d)", "weekly <scope> (7d)".
 * Codex keys: session/weekly and <scope>_session/<scope>_weekly, with windowSeconds.
 */
export function windowsFromUsage(provider, usage) {
  const quotas = usage?.quotas;
  if (!quotas || typeof quotas !== "object" || !isQuotaProvider(provider)) return null;
  // A cached usage result keeps the time upstream answered; without one it is unknown
  // and must lose to any real reading.
  const observedAt = Number.isFinite(usage.fetchedAt) ? usage.fetchedAt : 0;
  if (!observedAt) return null;
  const windows = {};
  const add = (key, q) => {
    const used = num(q?.used);
    if (!key || used === null) return;
    const reset = q.resetAt ? Date.parse(q.resetAt) : NaN;
    windows[key] = {
      usedPct: Math.max(0, Math.min(100, used)),
      resetAt: Number.isFinite(reset) ? reset : null,
      observedAt,
      source: "poll",
    };
  };
  for (const [name, q] of Object.entries(quotas)) {
    if (!q || typeof q !== "object") continue;
    if (provider === "claude") {
      if (name === "session (5h)") add("5h", q);
      else if (name === "weekly (7d)") add("7d", q);
      else {
        const m = /^weekly (.+) \(7d\)$/.exec(name);
        if (m) add(`7d:${m[1].trim().toLowerCase()}`, q);
      }
      continue;
    }
    const m = /^(?:(\w+)_)?(session|weekly)$/.exec(name);
    if (!m) continue;
    const len = lengthKey(num(q.windowSeconds)) || (m[2] === "session" ? "5h" : "7d");
    add(m[1] ? `${len}:${m[1]}` : len, q);
  }
  return Object.keys(windows).length ? windows : null;
}

/** Record a usage-API poll for one connection. Returns the merged snapshot or null. */
export function recordQuotaPoll(provider, connectionId, usage, now = Date.now()) {
  const windows = windowsFromUsage(provider, usage);
  if (!connectionId || !windows) return null;
  const prev = store.snapshots.get(connectionId);
  const snap = { provider, windows: mergeWindows(prev?.windows, windows), updatedAt: now, polledAt: now };
  store.snapshots.set(connectionId, snap);
  return snap;
}

export function getQuotaSnapshot(connectionId) {
  return store.snapshots.get(connectionId) || null;
}

export function clearQuotaSnapshot(connectionId) {
  store.snapshots.delete(connectionId);
}

/** Does window key `key` constrain requests for `model`? */
export function windowAppliesTo(key, model) {
  const i = key.indexOf(":");
  if (i < 0) return true;
  if (!model) return false;
  return String(model).toLowerCase().includes(key.slice(i + 1));
}

/**
 * Remaining % of a window now. A window whose reset time has passed is treated
 * as refilled (100) — the snapshot predates the reset.
 */
export function remainingPct(w, now = Date.now()) {
  if (!w) return null;
  if (w.resetAt && w.resetAt <= now) return 100;
  return Math.max(0, 100 - w.usedPct);
}

/** True when every window of `kind` in the snapshot is refilled (not exhausted). */
export function windowsRefilled(snapshot, keys, now = Date.now()) {
  if (!snapshot?.windows) return false;
  const present = keys.filter((k) => snapshot.windows[k]);
  if (!present.length) return false;
  return present.every((k) => remainingPct(snapshot.windows[k], now) > 0);
}

export function __resetQuotaStateForTests() {
  store.snapshots.clear();
}
