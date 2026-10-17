// Limit resets over the ops API (src/lib/ops/resets.js): viewing never spends,
// prepare refuses resets that would not apply, confirm needs the code from the
// same token, and an attempt without a definite answer can't spend twice.
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

const resets = await import("../../src/lib/ops/resets.js");

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

describe("viewing resets", () => {
  it("shows Claude grants without spending or leaking ids/tokens", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const view = await resets.getAccountResets("c1");
    expect(view).toMatchObject({ readable: true, available: 1, state: "usable now", refills: ["weekly"] });
    expect(view.grants[0]).toMatchObject({ label: "Weekly reset", resetsLeft: 1, offered: true });
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
    const text = JSON.stringify(view);
    expect(text).not.toContain("AT-SECRET");
    expect(text).not.toContain('"g1"');
  });

  it("labels grants that can't help: at-limit-only, blocked, cooldown", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ usableNow: false })], atLimit: false }));
    expect((await resets.getAccountResets("c1")).state).toBe("at limit only");
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ blocking: ["five_hour"] })] }));
    expect((await resets.getAccountResets("c1")).state).toMatch(/^blocked \(5h/);
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ cooldownUntil: iso(Date.now() + 60e3) }));
    expect((await resets.getAccountResets("c1")).state).toBe("cooldown");
  });

  it("says when the reset status can't be read (usage endpoint rate-limited)", async () => {
    m.getUsageForProvider.mockResolvedValue({ plan: "Unknown", message: "Claude connected. Usage API requires admin permissions." });
    const view = await resets.getAccountResets("c1");
    expect(view.readable).toBe(false);
  });

  it("lists Codex credits and other providers are refused", async () => {
    m.getUsageForProvider.mockResolvedValue(codexUsage());
    m.getCodexRateLimitResetCredits.mockResolvedValue(codexCredits(2));
    const view = await resets.getAccountResets("x1");
    expect(view).toMatchObject({ readable: true, available: 2, refills: ["5h", "weekly"] });
    expect(view.credits).toHaveLength(2);
    m.conns.set("o1", { id: "o1", provider: "openai", authType: "apikey", isActive: true });
    await expect(resets.getAccountResets("o1")).rejects.toMatchObject({ status: 400 });
  });
});

describe("Claude: prepare + confirm", () => {
  it("prepare spends nothing and refuses a reset the server wouldn't apply", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ usableNow: false })], atLimit: false }));
    await expect(resets.prepareReset("c1", tokenA)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/only works at a usage limit/) });
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ blocking: ["five_hour"] })] }));
    await expect(resets.prepareReset("c1", tokenA)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/doesn't refill 5h/) });
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ offered: null }));
    await expect(resets.prepareReset("c1", tokenA)).rejects.toMatchObject({ status: 409 });
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
    expect(m.kv.size).toBe(0);
  });

  it("prepare warns when an anytime reset would throw away quota, and when the weekly reset is near", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage({
      grants: [grant({ useRequiresLimit: false, percentUsed: { seven_day: 30 } })],
      weeklyResetsAt: iso(Date.now() + 6 * HOUR),
      atLimit: false,
    }));
    const plan = await resets.prepareReset("c1", tokenA);
    expect(plan.spent).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/70% of its weekly limit is still left/);
    expect(plan.warnings.join(" ")).toMatch(/refills on its own in 6h/);
    expect(plan.confirm.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
  });

  it("confirm needs the right code from the same token", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const { confirm } = await resets.prepareReset("c1", tokenA);
    await expect(resets.confirmReset("c1", tokenA, "WRONG1")).rejects.toMatchObject({ status: 400 });
    await expect(resets.confirmReset("c1", tokenB, confirm.code)).rejects.toMatchObject({ status: 403 });
    await expect(resets.confirmReset("x1", tokenA, confirm.code)).rejects.toMatchObject({ status: 404 });
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
  });

  it("spends exactly once, lifts the quota lock and clears the code", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const { confirm } = await resets.prepareReset("c1", tokenA);
    m.consumeClaudeResetGrant.mockResolvedValue({ ok: true, uncertain: false, status: 200, result: "reset", resetsLeft: 0, cleared: ["seven_day"] });
    const res = await resets.confirmReset("c1", tokenA, confirm.code.toLowerCase());
    expect(res).toMatchObject({ outcome: "reset", spent: true, cleared: ["weekly"], resetsLeft: 0 });
    expect(m.consumeClaudeResetGrant).toHaveBeenCalledTimes(1);
    expect(m.consumeClaudeResetGrant.mock.calls[0][1]).toBe("g1");
    expect(m.liftQuotaLockNow).toHaveBeenCalledWith("c1");
    expect(m.clearQuotaSnapshot).toHaveBeenCalledWith("c1");
    // The same code again only returns the recorded outcome.
    expect(await resets.confirmReset("c1", tokenA, confirm.code)).toMatchObject({ outcome: "reset", spent: true });
    expect(m.consumeClaudeResetGrant).toHaveBeenCalledTimes(1);
  });

  it("does not spend when the offer changed between prepare and confirm", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const { confirm } = await resets.prepareReset("c1", tokenA);
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant(), grant({ id: "g2" })], offered: "g2" }));
    await expect(resets.confirmReset("c1", tokenA, confirm.code)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/different reset/) });
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
  });

  it("a definite refusal is reported as nothing spent", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const { confirm } = await resets.prepareReset("c1", tokenA);
    m.consumeClaudeResetGrant.mockResolvedValue({ ok: false, uncertain: false, status: 200, result: "not_limited", reason: "not_limited", resetsLeft: 1, cleared: [] });
    const res = await resets.confirmReset("c1", tokenA, confirm.code);
    expect(res).toMatchObject({ outcome: "refused", spent: false });
  });

  it("an attempt without an answer is retried with the same request id, or not at all if it landed", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const { confirm } = await resets.prepareReset("c1", tokenA);
    m.consumeClaudeResetGrant.mockResolvedValueOnce({ ok: false, uncertain: true, status: null, result: null, message: "No answer from Anthropic: timeout", cleared: [] });
    const first = await resets.confirmReset("c1", tokenA, confirm.code);
    expect(first).toMatchObject({ outcome: "uncertain", spent: "unknown", confirm: { code: confirm.code } });
    const requestId = m.consumeClaudeResetGrant.mock.calls[0][3].requestId;

    // A new prepare is refused while the attempt is unsettled.
    await expect(resets.prepareReset("c1", tokenA)).rejects.toMatchObject({ status: 409 });

    // Retry: the grant still has its reset, so it is sent again with the SAME id.
    m.consumeClaudeResetGrant.mockResolvedValueOnce({ ok: true, uncertain: false, status: 200, result: "reset", resetsLeft: 0, cleared: ["seven_day"] });
    const second = await resets.confirmReset("c1", tokenA, confirm.code);
    expect(second).toMatchObject({ outcome: "reset", spent: true });
    expect(m.consumeClaudeResetGrant.mock.calls[1][3].requestId).toBe(requestId);
  });

  it("a retry after the first attempt landed sends nothing", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ resetsLeft: 2, resetsTotal: 2 })] }));
    const { confirm } = await resets.prepareReset("c1", tokenA);
    m.consumeClaudeResetGrant.mockResolvedValueOnce({ ok: false, uncertain: true, status: 502, result: null, message: "bad gateway", cleared: [] });
    await resets.confirmReset("c1", tokenA, confirm.code);
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ resetsLeft: 1, resetsTotal: 2 })] }));
    const res = await resets.confirmReset("c1", tokenA, confirm.code);
    expect(res).toMatchObject({ outcome: "reset", spent: true, message: expect.stringMatching(/went through after all/) });
    expect(m.consumeClaudeResetGrant).toHaveBeenCalledTimes(1);
  });
});

describe("Codex: prepare + confirm", () => {
  it("refuses with no credits; warns when the weekly window refills soon or quota is left", async () => {
    m.getUsageForProvider.mockResolvedValue(codexUsage({ available: 0 }));
    m.getCodexRateLimitResetCredits.mockResolvedValue({ availableCount: 0, credits: [] });
    await expect(resets.prepareReset("x1", tokenA)).rejects.toMatchObject({ status: 409 });

    m.getUsageForProvider.mockResolvedValue(codexUsage({ weeklyUsed: 40, weeklyResetIn: 5 * HOUR, limitReached: false }));
    m.getCodexRateLimitResetCredits.mockResolvedValue(codexCredits(2));
    const plan = await resets.prepareReset("x1", tokenA);
    expect(plan.warnings.join(" ")).toMatch(/refills on its own in 5h/);
    expect(plan.warnings.join(" ")).toMatch(/not at a limit/);
    expect(plan.notes.join(" ")).toMatch(/moves the weekly reset/);
    expect(m.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
  });

  it("spends the soonest-expiring credit, bound to the account", async () => {
    m.getUsageForProvider.mockResolvedValue(codexUsage());
    m.getCodexRateLimitResetCredits.mockResolvedValue(codexCredits(2));
    const { confirm } = await resets.prepareReset("x1", tokenA);
    m.consumeCodexRateLimitResetCredit.mockResolvedValue({ ok: true, uncertain: false, status: 200, code: "reset", windowsReset: 2 });
    const res = await resets.confirmReset("x1", tokenA, confirm.code);
    expect(res).toMatchObject({ outcome: "reset", spent: true, windowsReset: 2, resetsLeft: 1 });
    const [, , , opts] = m.consumeCodexRateLimitResetCredit.mock.calls[0];
    expect(opts).toMatchObject({ providerSpecificData: { chatgptAccountId: "acct-1" }, creditId: "cr0" });
  });

  it("nothing_to_reset is a refusal with nothing spent", async () => {
    m.getUsageForProvider.mockResolvedValue(codexUsage());
    m.getCodexRateLimitResetCredits.mockResolvedValue(codexCredits(1));
    const { confirm } = await resets.prepareReset("x1", tokenA);
    m.consumeCodexRateLimitResetCredit.mockResolvedValue({ ok: false, uncertain: false, nothingToReset: true, status: 200, code: "nothing_to_reset", windowsReset: 0 });
    expect(await resets.confirmReset("x1", tokenA, confirm.code)).toMatchObject({ outcome: "refused", spent: false });
  });

  it("a retry reuses the redeem id, and stops if the credit count already dropped", async () => {
    m.getUsageForProvider.mockResolvedValue(codexUsage());
    m.getCodexRateLimitResetCredits.mockResolvedValue(codexCredits(2));
    const { confirm } = await resets.prepareReset("x1", tokenA);
    m.consumeCodexRateLimitResetCredit.mockResolvedValueOnce({ ok: false, uncertain: true, status: null, code: null, windowsReset: 0, message: "No answer" });
    expect((await resets.confirmReset("x1", tokenA, confirm.code)).outcome).toBe("uncertain");
    const redeemId = m.consumeCodexRateLimitResetCredit.mock.calls[0][1];

    m.consumeCodexRateLimitResetCredit.mockResolvedValueOnce({ ok: true, uncertain: false, alreadyRedeemed: true, status: 200, code: "already_redeemed", windowsReset: 0 });
    const again = await resets.confirmReset("x1", tokenA, confirm.code);
    expect(again).toMatchObject({ outcome: "reset", spent: true });
    expect(m.consumeCodexRateLimitResetCredit.mock.calls[1][1]).toBe(redeemId);
  });

  it("a retry after the credit count dropped sends nothing", async () => {
    m.getUsageForProvider.mockResolvedValue(codexUsage());
    m.getCodexRateLimitResetCredits.mockResolvedValue(codexCredits(2));
    const { confirm } = await resets.prepareReset("x1", tokenA);
    m.consumeCodexRateLimitResetCredit.mockResolvedValueOnce({ ok: false, uncertain: true, status: null, code: null, windowsReset: 0, message: "No answer" });
    await resets.confirmReset("x1", tokenA, confirm.code);
    m.getCodexRateLimitResetCredits.mockResolvedValue(codexCredits(1));
    const res = await resets.confirmReset("x1", tokenA, confirm.code);
    expect(res).toMatchObject({ outcome: "reset", spent: "likely" });
    expect(m.consumeCodexRateLimitResetCredit).toHaveBeenCalledTimes(1);
  });
});

describe("shared state across slots and lost answers", () => {
  const entry = () => resets.__test__.readEntry("c1");

  it("keeps the pending entry in the DB, so another process sees it", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const { confirm } = await resets.prepareReset("c1", tokenA);
    const stored = await entry();
    expect(stored).toMatchObject({ code: confirm.code, grantId: "g1", attempts: 0, tokenId: "tok-a" });
    expect(JSON.stringify(stored)).not.toContain("AT-SECRET");
  });

  it("re-running a confirmed code returns the recorded outcome and sends nothing", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const { confirm } = await resets.prepareReset("c1", tokenA);
    m.consumeClaudeResetGrant.mockResolvedValue({ ok: true, uncertain: false, status: 200, result: "reset", resetsLeft: 0, cleared: ["seven_day"] });
    await resets.confirmReset("c1", tokenA, confirm.code);
    const again = await resets.confirmReset("c1", tokenA, confirm.code);
    expect(again).toMatchObject({ outcome: "reset", spent: true, message: expect.stringMatching(/recorded outcome/) });
    expect(m.consumeClaudeResetGrant).toHaveBeenCalledTimes(1);
  });

  it("a new prepare right after a reset warns that one was just used", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ resetsLeft: 2, resetsTotal: 2 })] }));
    const { confirm } = await resets.prepareReset("c1", tokenA);
    m.consumeClaudeResetGrant.mockResolvedValue({ ok: true, uncertain: false, status: 200, result: "reset", resetsLeft: 1, cleared: ["seven_day"] });
    await resets.confirmReset("c1", tokenA, confirm.code);
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ resetsLeft: 1, resetsTotal: 2 })] }));
    const plan = await resets.prepareReset("c1", tokenA);
    expect(plan.warnings[0]).toMatch(/already used on this account/);
  });

  it("an attempt whose process died mid-send is checked before anything is resent", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ resetsLeft: 2, resetsTotal: 2 })] }));
    const { confirm } = await resets.prepareReset("c1", tokenA);
    const e = await entry();
    // Simulate a slot that marked the send and was killed before recording the answer.
    await resets.__test__.swapEntry("c1", e, { ...e, inFlightSince: Date.now() - 5 * 60e3 });
    expect(await resets.hasUnsettledReset("c1")).toBe(true);
    // The reset had landed: the count dropped, so confirm settles without sending.
    m.getUsageForProvider.mockResolvedValue(claudeUsage({ grants: [grant({ resetsLeft: 1, resetsTotal: 2 })] }));
    const res = await resets.confirmReset("c1", tokenA, confirm.code);
    expect(res).toMatchObject({ outcome: "reset", spent: true });
    expect(m.consumeClaudeResetGrant).not.toHaveBeenCalled();
    expect(await resets.hasUnsettledReset("c1")).toBe(false);
  });

  it("a fresh in-flight send blocks a second confirm and a new prepare", async () => {
    m.getUsageForProvider.mockResolvedValue(claudeUsage());
    const { confirm } = await resets.prepareReset("c1", tokenA);
    const e = await entry();
    await resets.__test__.swapEntry("c1", e, { ...e, inFlightSince: Date.now() });
    await expect(resets.confirmReset("c1", tokenA, confirm.code)).rejects.toMatchObject({ status: 409 });
    await expect(resets.prepareReset("c1", tokenA)).rejects.toMatchObject({ status: 409 });
  });

  it("calls on one account in this process don't interleave", async () => {
    let release;
    m.getUsageForProvider.mockImplementationOnce(() => new Promise((r) => { release = () => r(claudeUsage()); }));
    const first = resets.prepareReset("c1", tokenA);
    await new Promise((r) => setTimeout(r, 0));
    await expect(resets.prepareReset("c1", tokenA)).rejects.toMatchObject({ status: 409 });
    release();
    await expect(first).resolves.toMatchObject({ spent: false });
  });

  it("prepare refuses if another slot changed the entry while it was checking", async () => {
    let release;
    m.getUsageForProvider.mockImplementationOnce(() => new Promise((r) => { release = () => r(claudeUsage()); }));
    const p = resets.prepareReset("c1", tokenA);
    await new Promise((r) => setTimeout(r, 0));
    m.kv.set("limitResets/c1", JSON.stringify({ connectionId: "c1", code: "OTHER1", attempts: 1, expiresAt: Date.now() + 60e3 }));
    release();
    await expect(p).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/changed while checking/) });
    expect(JSON.parse(m.kv.get("limitResets/c1")).code).toBe("OTHER1");
  });
});

