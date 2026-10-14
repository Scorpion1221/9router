// Live quota parsing: Claude unified rate-limit headers, Codex x-codex-* headers
// (classified by window length, not position), usage-API polls, and the quota-429
// rejection that turns into a lock until the window resets.
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseQuotaHeaders, quotaRejectionFromHeaders, recordQuotaHeaders, recordQuotaPoll,
  getQuotaSnapshot, windowsFromUsage, windowAppliesTo, remainingPct, __resetQuotaStateForTests,
} from "open-sse/services/quotaState.js";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const S = (ms) => String(Math.floor(ms / 1000));
const h = (o) => new Headers(o);

beforeEach(() => __resetQuotaStateForTests());

describe("Claude headers", () => {
  const ok = h({
    "anthropic-ratelimit-unified-5h-utilization": "0.98",
    "anthropic-ratelimit-unified-5h-reset": S(NOW + 5 * 3600e3),
    "anthropic-ratelimit-unified-7d-utilization": "0.26",
    "anthropic-ratelimit-unified-7d-reset": S(NOW + 6 * 86400e3),
    "anthropic-ratelimit-unified-status": "allowed_warning",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
  });

  it("reads 0..1 utilization and unix-second resets into percent + ms", () => {
    const p = parseQuotaHeaders("claude", ok, NOW);
    expect(p.windows["5h"].usedPct).toBeCloseTo(98);
    expect(p.windows["7d"]).toMatchObject({ resetAt: Math.floor((NOW + 6 * 86400e3) / 1000) * 1000, source: "headers" });
    expect(p.status).toBe("allowed_warning");
  });

  it("ignores providers whose anthropic-ratelimit headers mean API-key limits", () => {
    expect(parseQuotaHeaders("anthropic", ok, NOW)).toBeNull();
    recordQuotaHeaders("anthropic-compatible-x", "c1", ok);
    expect(getQuotaSnapshot("c1")).toBeNull();
  });

  it("a weekly rejection locks the account until the weekly reset", () => {
    const reset = NOW + 3 * 86400e3;
    const q = quotaRejectionFromHeaders("claude", h({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-reset": S(reset),
      "anthropic-ratelimit-unified-7d-utilization": "1.0",
    }), NOW);
    expect(q).toEqual({ resetsAtMs: Math.floor(reset / 1000) * 1000, scope: "account", window: "seven_day" });
  });

  it("a model-scoped rejection (e.g. Opus weekly) only locks that model", () => {
    const q = quotaRejectionFromHeaders("claude", h({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
      "anthropic-ratelimit-unified-reset": S(NOW + 86400e3),
    }), NOW);
    expect(q.scope).toBe("model");
  });

  it("a 429 without a rejected status is not a quota lock (burst limit)", () => {
    expect(quotaRejectionFromHeaders("claude", ok, NOW)).toBeNull();
    expect(quotaRejectionFromHeaders("claude", h({}), NOW)).toBeNull();
  });
});

describe("Codex headers", () => {
  it("classifies by window minutes: a weekly window sent as primary is weekly", () => {
    const p = parseQuotaHeaders("codex", h({
      "x-codex-primary-used-percent": "50",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": S(NOW + 6 * 86400e3),
      "x-codex-secondary-used-percent": "0",
      "x-codex-secondary-window-minutes": "0",
      "x-codex-secondary-reset-at": "",
    }), NOW);
    expect(Object.keys(p.windows)).toEqual(["7d"]);
    expect(p.windows["7d"].usedPct).toBe(50);
  });

  it("reads both windows on accounts that still have a 5h one", () => {
    const p = parseQuotaHeaders("codex", h({
      "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "40", "x-codex-secondary-window-minutes": "10080",
    }), NOW);
    expect(p.windows["5h"].usedPct).toBe(10);
    expect(p.windows["7d"].usedPct).toBe(40);
  });

  it("does not let an image-generation bucket overwrite the main windows", () => {
    expect(parseQuotaHeaders("codex", h({
      "x-codex-active-limit": "imagegen_premium",
      "x-codex-primary-used-percent": "90", "x-codex-primary-window-minutes": "1440",
    }), NOW)).toBeNull();
  });
});

describe("snapshots", () => {
  it("merges header readings with polled model windows, newest reading wins per window", () => {
    recordQuotaPoll("claude", "c1", { fetchedAt: NOW - 1000, quotas: {
      "session (5h)": { used: 10, resetAt: new Date(NOW + 3600e3).toISOString() },
      "weekly (7d)": { used: 20, resetAt: new Date(NOW + 86400e3).toISOString() },
      "weekly fable (7d)": { used: 0, resetAt: new Date(NOW + 86400e3).toISOString() },
    } }, NOW - 1000);
    recordQuotaHeaders("claude", "c1", h({
      "anthropic-ratelimit-unified-7d-utilization": "0.5",
      "anthropic-ratelimit-unified-7d-reset": S(NOW + 86400e3),
    }));
    const snap = getQuotaSnapshot("c1");
    expect(snap.windows["7d"].usedPct).toBe(50);
    expect(snap.windows["7d"].source).toBe("headers");
    expect(snap.windows["5h"].usedPct).toBe(10);
    expect(snap.windows["7d:fable"].usedPct).toBe(0);
  });

  it("maps Codex usage keys by window length when provided", () => {
    const w = windowsFromUsage("codex", { fetchedAt: NOW, quotas: {
      session: { used: 30, windowSeconds: 604800, resetAt: null },
      spark_session: { used: 5, windowSeconds: 18000, resetAt: null },
    } }, NOW);
    expect(Object.keys(w).sort()).toEqual(["5h:spark", "7d"]);
  });

  it("a cached usage result keeps its fetch time and loses to newer header data", () => {
    recordQuotaHeaders("claude", "c1", h({ "anthropic-ratelimit-unified-7d-utilization": "1.0", "anthropic-ratelimit-unified-7d-reset": S(NOW + 86400e3) }));
    recordQuotaPoll("claude", "c1", { fetchedAt: NOW - 60e3, quotas: { "weekly (7d)": { used: 20, resetAt: null } } });
    expect(getQuotaSnapshot("c1").windows["7d"].usedPct).toBe(100);
    expect(windowsFromUsage("claude", { quotas: { "weekly (7d)": { used: 20 } } })).toBeNull(); // no fetch time → ignored
  });

  it("treats a window whose reset passed as refilled", () => {
    expect(remainingPct({ usedPct: 100, resetAt: NOW - 1 }, NOW)).toBe(100);
    expect(remainingPct({ usedPct: 100, resetAt: NOW + 1 }, NOW)).toBe(0);
  });

  it("model-scoped windows apply only to matching models", () => {
    expect(windowAppliesTo("7d", "claude-opus-5-5")).toBe(true);
    expect(windowAppliesTo("7d:fable", "claude-fable-5-1")).toBe(true);
    expect(windowAppliesTo("7d:fable", "claude-opus-5-5")).toBe(false);
  });

  it("never throws on junk headers", () => {
    expect(() => recordQuotaHeaders("claude", "c1", { get() { throw new Error("boom"); } })).not.toThrow();
    expect(() => recordQuotaHeaders("claude", "c1", null)).not.toThrow();
  });
});
