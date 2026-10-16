// Connection list helpers for quota-routed providers: one status per account,
// one time per row, gateway-order grouping, and the summary bar counts.
import { describe, it, expect } from "vitest";
import {
  accountStatus, groupAccounts, poolSummary, formatWhen, formatDuration, parseUpstreamError,
} from "../../src/app/(dashboard)/dashboard/providers/[id]/quotaRouting.js";

const NOW = Date.parse("2026-10-16T14:05:00Z");
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;
const acct = (o) => ({ id: o.name, active: true, priority: 1, role: "normal", keepPct: 0, windows: {}, modelWindows: [], ...o });
const RAW_429 = '[429]: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed"}}';

describe("accountStatus", () => {
  it("names the window that blocks an account and gives one back time", () => {
    const s = accountStatus(acct({
      name: "zach", state: "locked", lockedUntil: iso(NOW + 52 * H), lastError: RAW_429,
      windows: { "5h": { remainingPct: 100 }, "7d": { remainingPct: 0, resetAt: iso(NOW + 52 * H) } },
    }), { strategy: "reset-first", now: NOW });
    expect(s).toMatchObject({ tone: "err", label: "Weekly limit", window: "7d", group: "waiting" });
    expect(s.back).toBe(NOW + 52 * H);
  });

  it("a 5h lock coming back today is amber, not red", () => {
    const s = accountStatus(acct({
      name: "haoyan", state: "locked", lockedUntil: iso(NOW + 1.5 * H),
      windows: { "5h": { remainingPct: 0, resetAt: iso(NOW + 1.5 * H) }, "7d": { remainingPct: 10 } },
    }), { now: NOW });
    expect(s).toMatchObject({ tone: "warn", label: "5h limit" });
  });

  it("never shows a usable badge for an account with 0% weekly quota", () => {
    const s = accountStatus(acct({ name: "changqing", state: "exhausted", eligibleAt: iso(NOW + 14 * H), windows: { "7d": { remainingPct: 0, resetAt: iso(NOW + 14 * H) } } }), { now: NOW });
    expect(s.group).toBe("waiting");
    expect(s.label).toBe("Weekly limit");
  });

  it("order 1 is in use; a reserve serves only when no normal account can", () => {
    expect(accountStatus(acct({ name: "a", order: "1", state: "ready" }), { now: NOW })).toMatchObject({ label: "In use", live: true });
    expect(accountStatus(acct({ name: "r", order: "R1", state: "ready" }), { now: NOW })).toMatchObject({ label: "Standby", tone: "reserve" });
    expect(accountStatus(acct({ name: "r", order: "R1", state: "ready" }), { servingReserve: true, now: NOW })).toMatchObject({ label: "In use" });
  });

  it("disabled wins over everything", () => {
    expect(accountStatus(acct({ name: "x", active: false, order: "1" }), { now: NOW })).toMatchObject({ label: "Disabled", group: "off" });
  });
});

describe("groupAccounts / poolSummary", () => {
  const accounts = [
    acct({ name: "b-out-later", priority: 1, state: "locked", lockedUntil: iso(NOW + 72 * H), windows: { "7d": { remainingPct: 0, resetAt: iso(NOW + 72 * H) } } }),
    acct({ name: "a-in-use", priority: 5, order: "1", state: "ready" }),
    acct({ name: "c-out-soon", priority: 2, state: "locked", lockedUntil: iso(NOW + 5 * 60e3), windows: { "5h": { remainingPct: 0, resetAt: iso(NOW + 5 * 60e3) } } }),
    acct({ name: "r1", priority: 12, order: "R1", role: "reserve", keepPct: 20, state: "ready" }),
    acct({ name: "off", priority: 3, active: false }),
  ];

  it("orders rows the way the gateway uses them", () => {
    const g = groupAccounts(accounts, { strategy: "reset-first", now: NOW });
    expect(g.rotation.map((r) => r.account.name)).toEqual(["a-in-use", "r1"]);
    expect(g.waiting.map((r) => r.account.name)).toEqual(["c-out-soon", "b-out-later"]);
    expect(g.off.map((r) => r.account.name)).toEqual(["off"]);
  });

  it("summary counts and next back", () => {
    const s = poolSummary(groupAccounts(accounts, { strategy: "reset-first", now: NOW }));
    expect(s).toMatchObject({ total: 5, usable: 1, reserve: 1, out: 2, disabled: 1 });
    expect(s.inUse.account.name).toBe("a-in-use");
    expect(s.next.account.name).toBe("c-out-soon");
  });

  it("under round robin an unlocked account is in rotation even without an order", () => {
    const g = groupAccounts([acct({ name: "x", state: "ready" })], { strategy: "round-robin", now: NOW });
    expect(g.rotation).toHaveLength(1);
  });
});

describe("formatting", () => {
  it("one time per row: countdown under a day, weekday beyond", () => {
    expect(formatWhen(NOW + 85 * 60e3, NOW)).toBe("in 1h 25m");
    expect(formatWhen(NOW + 3 * 24 * H, NOW)).not.toMatch(/^in /);
    expect(formatDuration(52 * H)).toBe("2d 4h");
  });

  it("parses the stored upstream error without rendering it", () => {
    expect(parseUpstreamError(RAW_429)).toMatchObject({ code: "429", type: "rate_limit_error" });
    expect(parseUpstreamError(null)).toBeNull();
  });
});
