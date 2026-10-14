// reset-first account selection: earliest weekly reset first, reserve accounts last,
// keep lines and the release window, and quota locks that hold until the reset.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(async (_id, patch) => patch),
  updateProviderConnectionWith: vi.fn(async () => null),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
  updateProviderConnectionWith: mocks.updateProviderConnectionWith,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials, markAccountUnavailable, clearAccountError } = await import("@/sse/services/auth.js");
const { recordQuotaPoll, __resetQuotaStateForTests } = await import("open-sse/services/quotaState.js");
const { rankResetFirst, parsePolicyPatch } = await import("open-sse/services/resetFirst.js");
const { isModelLockActive, getBlockingLockUntil } = await import("open-sse/services/accountFallback.js");

const DAY = 86400e3;
const MODEL = "claude-opus-5-5";
const conn = (id, priority, extra = {}) => ({ id, name: id, provider: "claude", authType: "oauth", isActive: true, priority, accessToken: "t", ...extra });
const quota = (id, { s5h = 100, week = 100, weekResetIn = 3 * DAY, fable } = {}) => {
  const now = Date.now();
  recordQuotaPoll("claude", id, { fetchedAt: now, quotas: {
    "session (5h)": { used: 100 - s5h, resetAt: new Date(now + 3600e3).toISOString() },
    "weekly (7d)": { used: 100 - week, resetAt: new Date(now + weekResetIn).toISOString() },
    ...(fable !== undefined ? { "weekly fable (7d)": { used: 100 - fable, resetAt: new Date(now + weekResetIn).toISOString() } } : {}),
  } });
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetQuotaStateForTests();
  mocks.getSettings.mockResolvedValue({ providerStrategies: { claude: { fallbackStrategy: "reset-first" } } });
});

describe("reset-first", () => {
  it("picks the normal account whose weekly quota resets first, regardless of priority", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a", 1), conn("b", 2), conn("c", 3)]);
    quota("a", { weekResetIn: 6 * DAY });
    quota("b", { weekResetIn: 2 * DAY });
    quota("c", { weekResetIn: 4 * DAY });
    expect((await getProviderCredentials("claude", null, MODEL)).connectionId).toBe("b");
  });

  it("breaks a same-hour tie by priority and puts accounts without data after known ones", () => {
    const now = Date.now();
    quota("a", { weekResetIn: 2 * DAY + 60e3 });
    quota("b", { weekResetIn: 2 * DAY });
    const { order } = rankResetFirst([conn("x", 1), conn("a", 2), conn("b", 3)], MODEL, now);
    expect(order.map((e) => e.conn.id)).toEqual(["a", "b", "x"]);
  });

  it("skips exhausted windows and uses reserve accounts only when no normal one can", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("n1", 1), conn("r1", 2, { poolRole: "reserve" }), conn("n2", 3)]);
    quota("n1", { week: 0, weekResetIn: DAY });
    quota("r1", { weekResetIn: DAY });
    quota("n2", { s5h: 0 });
    expect((await getProviderCredentials("claude", null, MODEL)).connectionId).toBe("r1");
  });

  it("stops at the keep line, and releases it in the last hours before the weekly reset", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("r", 1, { poolRole: "reserve", keepPct: 30, releaseBeforeHours: 12 })]);
    quota("r", { s5h: 29, weekResetIn: 3 * DAY });
    const blocked = await getProviderCredentials("claude", null, MODEL);
    expect(blocked.allRateLimited).toBe(true);
    expect(new Date(blocked.retryAfter).getTime()).toBeGreaterThan(Date.now());

    __resetQuotaStateForTests();
    quota("r", { s5h: 29, weekResetIn: 6 * 3600e3 });
    expect((await getProviderCredentials("claude", null, MODEL)).connectionId).toBe("r");
  });

  it("returns 503-style allRateLimited (not null → 404) when policy excludes every account", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a", 1, { keepPct: 50 })]);
    quota("a", { week: 40 });
    const res = await getProviderCredentials("claude", null, MODEL);
    expect(res).toMatchObject({ allRateLimited: true });
  });

  it("a model-scoped window (Fable weekly) only blocks that model", () => {
    quota("a", { fable: 0 });
    expect(rankResetFirst([conn("a", 1)], "claude-fable-5-1").order).toHaveLength(0);
    expect(rankResetFirst([conn("a", 1)], MODEL).order).toHaveLength(1);
  });

  it("other strategies ignore the policy fields", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.getProviderConnections.mockResolvedValue([conn("a", 1, { poolRole: "reserve" }), conn("b", 2)]);
    quota("b", { weekResetIn: DAY });
    expect((await getProviderCredentials("claude", null, MODEL)).connectionId).toBe("a");
  });
});

describe("quota locks", () => {
  it("lock the whole account until the window reset, past the 30-min cap", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a", 1)]);
    const resetsAtMs = Date.now() + 3 * DAY;
    await markAccountUnavailable("a", 429, "limit", "claude", MODEL, resetsAtMs, { resetsAtMs, scope: "account", window: "seven_day" });
    const patch = mocks.updateProviderConnection.mock.calls[0][1];
    expect(Object.keys(patch)).toContain("modelLock___all");
    expect(patch[`modelLock_${MODEL}`]).toBeUndefined();
    expect(Date.parse(patch.modelLock___all)).toBeGreaterThan(Date.now() + 2.9 * DAY);
  });

  it("a non-quota resetsAtMs keeps the 30-min cap", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a", 1)]);
    await markAccountUnavailable("a", 429, "limit", "claude", MODEL, Date.now() + DAY);
    const patch = mocks.updateProviderConnection.mock.calls[0][1];
    expect(Date.parse(patch[`modelLock_${MODEL}`])).toBeLessThanOrEqual(Date.now() + 30 * 60e3 + 1000);
  });

  it("an expired model lock no longer hides an active account-wide lock", () => {
    const c = { [`modelLock_${MODEL}`]: new Date(Date.now() - 1000).toISOString(), modelLock___all: new Date(Date.now() + DAY).toISOString() };
    expect(isModelLockActive(c, MODEL)).toBe(true);
    expect(getBlockingLockUntil(c, MODEL)).toBe(c.modelLock___all);
  });

  it("a success does not rewrite the row for locks that are already cleared", async () => {
    await clearAccountError("a", { _connection: { testStatus: "active", [`modelLock_${MODEL}`]: null } }, MODEL);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnectionWith).not.toHaveBeenCalled();
  });

  it("a success decided on a stale snapshot does not wipe a lock set meanwhile", async () => {
    const weekLock = new Date(Date.now() + 3 * DAY).toISOString();
    let written = null;
    mocks.updateProviderConnectionWith.mockImplementation(async (_id, build) => { written = build({ modelLock___all: weekLock, testStatus: "unavailable" }); return written; });
    await clearAccountError("a", { _connection: { testStatus: "unavailable", lastError: "old" } }, MODEL);
    expect(written.testStatus).toBeUndefined();
    expect(written.modelLock___all).toBeUndefined();
  });
});

describe("policy validation", () => {
  it("accepts valid fields and normalizes defaults to null", () => {
    expect(parsePolicyPatch({ poolRole: "reserve", keepPct: 30, releaseBeforeHours: 12 }).patch).toEqual({ poolRole: "reserve", keepPct: 30, releaseBeforeHours: 12 });
    expect(parsePolicyPatch({ poolRole: "normal", keepPct: 0, releaseBeforeHours: 0 }).patch).toEqual({ poolRole: null, keepPct: null, releaseBeforeHours: null });
  });
  it.each([{ poolRole: "vip" }, { keepPct: 101 }, { keepPct: 1.5 }, { releaseBeforeHours: -1 }, { releaseBeforeHours: 1000 }])("rejects %j", (body) => {
    expect(parsePolicyPatch(body).error).toBeTruthy();
  });
});
