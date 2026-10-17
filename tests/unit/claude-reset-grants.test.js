import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

const { parseClaudeResetGrants, consumeClaudeResetGrant } = await import("../../open-sse/services/usage/claude.js");

describe("parseClaudeResetGrants", () => {
  it("sums usable grants and picks next_grant_id", () => {
    const day = (n) => new Date(Date.now() + n * 86400e3).toISOString();
    const r = parseClaudeResetGrants({
      eligible: true,
      next_grant_id: "g2",
      grants: [
        { id: "g1", resets_left: 1, ends_at: day(2) },
        { id: "g2", resets_left: 2, ends_at: day(9), clears: ["five_hour", "seven_day"] },
        { id: "g3", resets_left: 5, paused: true },
      ],
    });
    expect(r).toMatchObject({ availableCount: 3, nextGrantId: "g2", offeredGrantId: "g2" });
    expect(r.expiresAt).toBe(r.grants[1].endsAt);
    expect(r.grants.map((g) => g.id)).toEqual(["g1", "g2", "g3"]); // modal lists paused too
    expect(r.grants[1].clears).toEqual(["five_hour", "seven_day"]);
  });
  it("does not count expired or not-yet-started grants as available", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      next_grant_id: null,
      grants: [
        { id: "old", resets_left: 1, ends_at: new Date(Date.now() - 3600e3).toISOString() },
        { id: "soon", resets_left: 1, starts_at: new Date(Date.now() + 3600e3).toISOString() },
      ],
    });
    expect(r.availableCount).toBe(0);
    expect(r.grants).toHaveLength(2); // still listed for the expiry modal
  });
  it("returns null when ineligible or missing", () => {
    expect(parseClaudeResetGrants(undefined)).toBeNull();
    expect(parseClaudeResetGrants({ eligible: false, grants: [] })).toBeNull();
  });
  it("keeps the fields that decide whether a reset would help", () => {
    const r = parseClaudeResetGrants({
      eligible: true,
      next_grant_id: null,
      at_limit: true,
      exhausted: ["seven_day"],
      grants: [{ id: "g1", resets_left: 1, usable_now: false, use_requires_limit: false, blocking: ["five_hour"], percent_used: { seven_day: 80, junk: "x" } }],
    });
    // No server offer: nothing is "offered" even though a grant has resets left.
    expect(r).toMatchObject({ offeredGrantId: null, atLimit: true, exhausted: ["seven_day"] });
    expect(r.grants[0]).toMatchObject({ usableNow: false, useRequiresLimit: false, blocking: ["five_hour"], percentUsed: { seven_day: 80 } });
  });
});

describe("consumeClaudeResetGrant", () => {
  beforeEach(() => vi.clearAllMocks());
  const profile = { ok: true, status: 200, json: async () => ({ organization: { uuid: "org-1" } }) };

  it("sends the caller's request id (the idempotency key) and reads the result", async () => {
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: "reset", resets_left: 0, cleared: ["seven_day"] }) });
    const res = await consumeClaudeResetGrant("tok", "g1", null, { requestId: "req-abc" });
    expect(res).toMatchObject({ ok: true, uncertain: false, resetsLeft: 0, cleared: ["seven_day"] });
    const [url, init] = mocks.proxyAwareFetch.mock.calls[1];
    expect(url).toContain("/api/organizations/org-1/reset_rate_limits");
    expect(JSON.parse(init.body)).toEqual({ program: "cedar_ember", grant_id: "g1", request_id: "req-abc" });
  });

  it("tells definite refusals from outcomes it can't be sure of", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(profile).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: "not_limited" }) });
    expect(await consumeClaudeResetGrant("tok", "g1")).toMatchObject({ ok: false, uncertain: false, result: "not_limited" });
    mocks.proxyAwareFetch.mockResolvedValueOnce(profile).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: "unavailable" }) });
    expect(await consumeClaudeResetGrant("tok", "g1")).toMatchObject({ ok: false, uncertain: true });
    mocks.proxyAwareFetch.mockResolvedValueOnce(profile).mockRejectedValueOnce(new Error("timeout"));
    expect(await consumeClaudeResetGrant("tok", "g1")).toMatchObject({ ok: false, uncertain: true, status: null });
  });

  it("refuses malformed ids before sending anything", async () => {
    await expect(consumeClaudeResetGrant("tok", "bad id")).rejects.toThrow(/grant id/);
    await expect(consumeClaudeResetGrant("tok", "g1", null, { requestId: "has space" })).rejects.toThrow(/request id/);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});
