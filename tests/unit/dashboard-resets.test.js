// Dashboard limit-reset routes (/api/providers/:id/resets*): the same two-step
// flow as `9r resets use`, bound to the dashboard identity. Viewing spends nothing,
// a reset prepared in the dashboard can't be confirmed by an ops token (and back),
// and an attempt without a definite answer is retried with the same code only.
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  conns: new Map(),
  kv: new Map(),
  getUsageForProvider: vi.fn(),
  consumeClaudeResetGrant: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn(),
  getCodexRateLimitResetCredits: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection })),
  applyQuotaReading: vi.fn(async () => null),
  liftQuotaLockNow: vi.fn(async () => {}),
  clearQuotaSnapshot: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
// Minimal stand-in for the SQLite adapter: just the kv statements resets.js runs.
vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    get: (_sql, [scope, key]) => (m.kv.has(`${scope}/${key}`) ? { value: m.kv.get(`${scope}/${key}`) } : undefined),
    run: (sql, params) => {
      if (sql.startsWith("DELETE")) m.kv.delete(`${params[0]}/${params[1]}`);
      else m.kv.set(`${params[0]}/${params[1]}`, params[2]);
      return { changes: 1 };
    },
    transaction: (fn) => fn(),
  }),
}));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: vi.fn(async ({ provider } = {}) => [...m.conns.values()].filter((c) => !provider || c.provider === provider)),
  getProviderConnectionById: vi.fn(async (id) => m.conns.get(id) || null),
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: m.getUsageForProvider,
  consumeClaudeResetGrant: m.consumeClaudeResetGrant,
  consumeCodexRateLimitResetCredit: m.consumeCodexRateLimitResetCredit,
  getCodexRateLimitResetCredits: m.getCodexRateLimitResetCredits,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: m.refreshAndUpdateCredentials }));
vi.mock("open-sse/services/quotaState.js", () => ({ clearQuotaSnapshot: m.clearQuotaSnapshot }));
vi.mock("@/sse/services/quotaPoller.js", () => ({ applyQuotaReading: m.applyQuotaReading, liftQuotaLockNow: m.liftQuotaLockNow }));
vi.mock("../../src/lib/ops/auth.js", () => ({
  opsError: (status, message) => Object.assign(new Error(message), { status, expose: true }),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } }) },
}));

const resets = await import("../../src/lib/ops/resets.js");
const viewRoute = await import("../../src/app/api/providers/[id]/resets/route.js");
const prepareRoute = await import("../../src/app/api/providers/[id]/resets/prepare/route.js");
const confirmRoute = await import("../../src/app/api/providers/[id]/resets/confirm/route.js");
const listRoute = await import("../../src/app/api/providers/resets/route.js");

const ctx = (id) => ({ params: Promise.resolve({ id }) });
const post = (body) => new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const json = async (res) => ({ status: res.status, body: await res.json() });

const HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const tokenA = { id: "tok-a", name: "mbp", scope: "admin" };
const tokenB = { id: "tok-b", name: "other", scope: "admin" };

const claudeConn = { id: "c1", provider: "claude", authType: "oauth", name: "cc-one", isActive: true, accessToken: "AT-SECRET", providerSpecificData: {} };
const codexConn = { id: "x1", provider: "codex", authType: "oauth", name: "cx-one", isActive: true, accessToken: "AT-SECRET", providerSpecificData: { chatgptAccountId: "acct-1" } };

function grant(extra = {}) {
  return {
    id: "g1", label: "Weekly reset", resetsLeft: 1, resetsTotal: 1, startsAt: null, endsAt: iso(Date.now() + 10 * 24 * HOUR),
    clears: ["seven_day"], paused: false, usableNow: true, useRequiresLimit: true, blocking: [], percentUsed: { seven_day: 100 }, ...extra,
  };
}
function claudeUsage({ grants = [grant()], offered = "g1", cooldownUntil = null, weeklyResetsAt = iso(Date.now() + 4 * 24 * HOUR), atLimit = true } = {}) {
  const live = grants.filter((g) => !g.paused && g.resetsLeft > 0);
  return {
    fetchedAt: Date.now(),
    quotas: { "session (5h)": { used: 20, resetAt: iso(Date.now() + HOUR) }, "weekly (7d)": { used: 100, resetAt: weeklyResetsAt } },
    resetEligibility: { eligible: true, reason: null },
    resetCredits: {
      availableCount: live.reduce((n, g) => n + g.resetsLeft, 0),
      nextGrantId: offered || live[0]?.id || null,
      offeredGrantId: offered,
      expiresAt: null, clears: [], cooldownUntil, weeklyResetsAt, atLimit, exhausted: atLimit ? ["seven_day"] : [],
      grants,
    },
  };
}
function codexUsage({ weeklyUsed = 100, weeklyResetIn = 4 * 24 * HOUR, limitReached = true, available = 2 } = {}) {
  return {
    fetchedAt: Date.now(),
    limitReached,
    quotas: { session: { used: 10, resetAt: iso(Date.now() + HOUR) }, weekly: { used: weeklyUsed, resetAt: iso(Date.now() + weeklyResetIn) } },
    resetCredits: { availableCount: available },
  };
}
const codexCredits = (n = 2) => ({
  availableCount: n,
  credits: Array.from({ length: n }, (_, i) => ({ id: `cr${i}`, title: "Full reset", status: "available", grantedAt: iso(Date.now() - HOUR), expiresAt: iso(Date.now() + (i + 1) * 24 * HOUR) })).reverse(),
});

beforeEach(() => {
  vi.clearAllMocks();
  m.kv.clear();
  resets.__test__.busy.clear();
  m.conns.clear();
  m.conns.set(claudeConn.id, { ...claudeConn });
  m.conns.set(codexConn.id, { ...codexConn });
  m.refreshAndUpdateCredentials.mockImplementation(async (connection) => ({ connection }));
});

describe("dashboard reset routes", () => {
  it("viewing and the batch counts spend nothing and don't leak tokens", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const view = await json(await viewRoute.GET(new Request("http://localhost/x"), ctx("c1")));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ available: 1 });
    const list = await json(await listRoute.GET(new Request("http://localhost/x?provider=claude")));
    expect(list.body.accounts).toEqual([expect.objectContaining({ id: "c1", available: 1 })]);
    expect(JSON.stringify([view.body, list.body])).not.toMatch(/SECRET|g1/);
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
    expect((await listRoute.GET(new Request("http://localhost/x?provider=openai"))).status).toBe(400);
  });

  it("prepare refuses a reset that would not help, and nothing is spent", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ usableNow: false })], atLimit: false }));
    const res = await json(await prepareRoute.POST(post(), ctx("c1")));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/isn't at one now/);
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
  });

  it("prepare then confirm spends exactly once; the same code only returns the outcome", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const prep = await json(await prepareRoute.POST(post(), ctx("c1")));
    expect(prep.status).toBe(200);
    expect(prep.body).toMatchObject({ spent: false, confirm: { code: expect.any(String) } });
    m.consumeClaudeResetGrant.mockResolvedValue({ ok: true, uncertain: false, status: 200, result: "reset", resetsLeft: 0, cleared: ["seven_day"] });
    const done = await json(await confirmRoute.POST(post({ code: prep.body.confirm.code }), ctx("c1")));
    expect(done.body).toMatchObject({ outcome: "reset", spent: true });
    await confirmRoute.POST(post({ code: prep.body.confirm.code }), ctx("c1"));
    expect(m.consumeClaudeResetGrant).toHaveBeenCalledTimes(1);
  });

  it("a dashboard prepare can't be confirmed by an ops token, nor an ops prepare by the dashboard", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const prep = await json(await prepareRoute.POST(post(), ctx("c1")));
    await expect(resets.confirmReset("c1", tokenA, prep.body.confirm.code)).rejects.toMatchObject({ status: 403 });
    m.kv.clear();
    const ops = await resets.prepareReset("c1", tokenA);
    const res = await json(await confirmRoute.POST(post({ code: ops.confirm.code }), ctx("c1")));
    expect(res.status).toBe(403);
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
  });

  it("an uncertain attempt keeps its code; retrying checks first and does not resend when it landed", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const prep = await json(await prepareRoute.POST(post(), ctx("c1")));
    m.consumeClaudeResetGrant.mockResolvedValue({ ok: false, uncertain: true, status: 502, message: "upstream timeout" });
    const first = await json(await confirmRoute.POST(post({ code: prep.body.confirm.code }), ctx("c1")));
    expect(first.body).toMatchObject({ outcome: "uncertain", spent: "unknown", confirm: { code: prep.body.confirm.code } });
    // The reset landed after all: the next read shows one fewer.
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ resetsLeft: 0 })] }));
    const again = await json(await confirmRoute.POST(post({ code: first.body.confirm.code }), ctx("c1")));
    expect(again.body).toMatchObject({ outcome: "reset" });
    expect(m.consumeClaudeResetGrant).toHaveBeenCalledTimes(1);
    // While an attempt was unsettled a fresh prepare is refused (no second key).
  });

  it("rejects a missing code and unknown accounts", async () => {
    expect((await confirmRoute.POST(post({}), ctx("c1"))).status).toBe(400);
    expect((await prepareRoute.POST(post(), ctx("nope"))).status).toBe(404);
  });
});
