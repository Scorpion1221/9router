// Codex credits: once an account's included windows are used up, upstream keeps
// serving it from its credit balance instead of answering 429. The quota store
// tracks that balance (x-codex-credits-* headers + the usage poll), the pool view
// flags such accounts "onCredits", and the connection list keeps them in rotation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-codex-credits-"));
process.env.DATA_DIR = dataDir;

const {
  parseQuotaHeaders, recordQuotaHeaders, recordQuotaPoll, getQuotaSnapshot, creditsFromUsage,
  creditsUsable, __resetQuotaStateForTests,
} = await import("open-sse/services/quotaState.js");
const { statusOf } = await import("../../src/app/(dashboard)/dashboard/providers/[id]/quotaRouting.js");

const NOW = Date.parse("2026-11-08T14:50:00Z");
const S = (ms) => String(Math.floor(ms / 1000));
const h = (o) => new Headers(o);
const DAY = 86400e3;

// What prod's 429 for a 0-credit Pro account carried on 2026-11-08 (minus turn state).
const exhaustedNoCredits = {
  "x-codex-active-limit": "premium",
  "x-codex-primary-used-percent": "100",
  "x-codex-primary-window-minutes": "10080",
  "x-codex-primary-reset-at": S(NOW + 5 * DAY),
  "x-codex-secondary-used-percent": "0",
  "x-codex-secondary-window-minutes": "0",
  "x-codex-secondary-reset-at": "",
  "x-codex-credits-has-credits": "False",
  "x-codex-credits-balance": "0",
  "x-codex-credits-unlimited": "False",
};

beforeEach(() => __resetQuotaStateForTests());

describe("credit readings", () => {
  it("reads x-codex-credits-* the way the Codex CLI does (True/False, any case)", () => {
    const p = parseQuotaHeaders("codex", h({ ...exhaustedNoCredits, "x-codex-credits-has-credits": "True", "x-codex-credits-balance": "36325.14" }), NOW);
    expect(p.windows["7d"].usedPct).toBe(100);
    expect(p.credits).toMatchObject({ hasCredits: true, unlimited: false, balance: 36325.14, source: "headers" });
    expect(parseQuotaHeaders("codex", h(exhaustedNoCredits), NOW).credits).toMatchObject({ hasCredits: false, balance: 0 });
  });

  it("no credit headers → no credit reading; Claude never gets one", () => {
    expect(parseQuotaHeaders("codex", h({ "x-codex-primary-used-percent": "5", "x-codex-primary-window-minutes": "10080" }), NOW).credits).toBeNull();
    expect(parseQuotaHeaders("claude", h({ "x-codex-credits-has-credits": "true" }), NOW)).toBeNull();
  });

  it("an image call still records the account-wide balance but not its image window", () => {
    recordQuotaHeaders("codex", "c1", h({
      "x-codex-active-limit": "imagegen_premium",
      "x-codex-primary-used-percent": "90", "x-codex-primary-window-minutes": "10080",
      "x-codex-credits-has-credits": "true", "x-codex-credits-balance": "12",
    }));
    const snap = getQuotaSnapshot("c1");
    expect(snap.windows).toEqual({});
    expect(snap.credits).toMatchObject({ hasCredits: true, balance: 12 });
  });

  it("takes the poll's credits, and the newest reading wins", () => {
    const usage = { fetchedAt: NOW - 60e3, quotas: { weekly: { used: 100, windowSeconds: 604800, resetAt: null } }, credits: { hasCredits: true, unlimited: false, balance: 500 } };
    expect(creditsFromUsage("codex", usage)).toMatchObject({ hasCredits: true, balance: 500, source: "poll" });
    expect(creditsFromUsage("claude", usage)).toBeNull();
    expect(creditsFromUsage("codex", { ...usage, fetchedAt: undefined })).toBeNull();

    recordQuotaPoll("codex", "c1", usage);
    recordQuotaHeaders("codex", "c1", h({ ...exhaustedNoCredits, "x-codex-credits-has-credits": "true", "x-codex-credits-balance": "420" }));
    expect(getQuotaSnapshot("c1").credits).toMatchObject({ balance: 420, source: "headers" });
    recordQuotaPoll("codex", "c1", { ...usage, fetchedAt: NOW - 3600e3, credits: { hasCredits: true, balance: 999 } });
    expect(getQuotaSnapshot("c1").credits.balance).toBe(420); // older poll loses
  });

  it("credits are usable when there is a balance or the account is unlimited", () => {
    expect(creditsUsable({ hasCredits: true })).toBe(true);
    expect(creditsUsable({ hasCredits: false, unlimited: true })).toBe(true);
    expect(creditsUsable({ hasCredits: false, balance: 0 })).toBe(false);
    expect(creditsUsable(null)).toBe(false);
  });
});

describe("getCodexUsage", () => {
  it("returns the credit balance from wham/usage", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({
          plan_type: "pro",
          rate_limit: { limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: Math.floor((NOW + DAY) / 1000) } },
          credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: "36493.4021035000" },
        }),
      })),
    }));
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    const usage = await getCodexUsage("token");
    expect(usage.credits).toEqual({ hasCredits: true, unlimited: false, balance: 36493.4021035 });
    expect(usage.quotas.weekly.used).toBe(100);
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });
});

describe("pool view", () => {
  it("flags an unlocked account at 0% with credits as onCredits, not one without", async () => {
    const { createProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");
    const { providerPoolView } = await import("../../src/lib/ops/poolView.js");
    const now = Date.now();
    const a = await createProviderConnection({ provider: "codex", authType: "oauth", name: "cx-credits", isActive: true, accessToken: "SECRET-A", priority: 1 });
    const b = await createProviderConnection({ provider: "codex", authType: "oauth", name: "cx-empty", isActive: true, accessToken: "SECRET-B", priority: 2 });
    const c = await createProviderConnection({ provider: "codex", authType: "oauth", name: "cx-fresh", isActive: true, accessToken: "SECRET-C", priority: 3 });
    const weekly = (used) => ({ weekly: { used, windowSeconds: 604800, resetAt: new Date(now + DAY).toISOString() } });
    recordQuotaPoll("codex", a.id, { fetchedAt: now, quotas: weekly(100), credits: { hasCredits: true, balance: 36000 } });
    recordQuotaPoll("codex", b.id, { fetchedAt: now, quotas: weekly(100), credits: { hasCredits: false, balance: 0 } });
    recordQuotaPoll("codex", c.id, { fetchedAt: now, quotas: weekly(90), credits: { hasCredits: true, balance: 50 } });

    const view = await providerPoolView("codex");
    const by = Object.fromEntries(view.accounts.map((x) => [x.name, x]));
    expect(by["cx-credits"]).toMatchObject({ onCredits: true, credits: { hasCredits: true, balance: 36000, source: "poll" } });
    expect(by["cx-empty"].onCredits).toBe(false);
    expect(by["cx-fresh"].onCredits).toBe(false); // still has included quota
    expect(JSON.stringify(view)).not.toMatch(/SECRET/);
  });
});

describe("connection list status", () => {
  const iso = (ms) => new Date(ms).toISOString();
  const acct = (o) => ({ id: o.name, active: true, priority: 1, role: "normal", keepPct: 0, state: "ready", windows: {}, modelWindows: [], ...o });
  const zeroWeek = { "7d": { remainingPct: 0, resetAt: iso(NOW + DAY) } };
  const ff = { strategy: "fill-first", now: NOW };

  it("fill-first: a 0% account serving on credits stays in rotation, marked on credits", () => {
    const s = statusOf(acct({ name: "baoqi", order: "1", windows: zeroWeek, onCredits: true, credits: { hasCredits: true, balance: 36325 } }), ff);
    expect(s).toMatchObject({ group: "rot", note: "on credits" });
    expect(s.tip).toMatch(/36,325 credits left/);
  });

  it("fill-first: a 0% account without credits is still shown as at its weekly limit", () => {
    const s = statusOf(acct({ name: "guo", order: "2", windows: zeroWeek, onCredits: false, credits: { hasCredits: false, balance: 0 } }), ff);
    expect(s).toMatchObject({ group: "wait", label: "Weekly limit" });
  });

  it("reset-first skips a 0% account even with credits, and says so", () => {
    const s = statusOf(acct({ name: "baoqi", state: "exhausted", eligibleAt: iso(NOW + DAY), windows: zeroWeek, credits: { hasCredits: true, balance: 100 } }),
      { strategy: "reset-first", servingReserve: false, now: NOW });
    expect(s.group).toBe("wait");
    expect(s.tip).toMatch(/reset first never spends them/);
  });
});
