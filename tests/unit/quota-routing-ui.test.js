// Connection list for quota-routed providers: one status per account (derived
// from the gateway view for every strategy), one time per row, and the helpers.
import { describe, it, expect } from "vitest";

const { statusOf, formatWhen, formatDuration, parseUpstreamError } = await import("../../src/app/(dashboard)/dashboard/providers/[id]/quotaRouting.js");

const NOW = Date.parse("2026-10-16T14:05:00Z");
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;
const acct = (o) => ({ id: o.name, active: true, priority: 1, role: "normal", keepPct: 0, windows: {}, modelWindows: [], ...o });
const RAW_429 = '[429]: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed"}}';
const rf = { strategy: "reset-first", servingReserve: false, now: NOW };

describe("statusOf (reset-first)", () => {
  it("names the window that blocks an account and gives one back time", () => {
    const s = statusOf(acct({
      name: "zach", state: "locked", lockedUntil: iso(NOW + 52 * H), lastError: RAW_429,
      windows: { "5h": { remainingPct: 100 }, "7d": { remainingPct: 0, resetAt: iso(NOW + 52 * H) } },
    }), rf);
    expect(s).toMatchObject({ tone: "err", label: "Weekly limit", win: "7d", group: "wait", back: NOW + 52 * H });
  });

  it("a 5h lock coming back today is amber", () => {
    const s = statusOf(acct({
      name: "haoyan", state: "locked", lockedUntil: iso(NOW + 1.5 * H),
      windows: { "5h": { remainingPct: 0, resetAt: iso(NOW + 1.5 * H) }, "7d": { remainingPct: 10 } },
    }), rf);
    expect(s).toMatchObject({ tone: "warn", label: "5h limit" });
  });

  it("order 1 is in use; a reserve serves only when no normal account can", () => {
    expect(statusOf(acct({ name: "a", order: "1", state: "ready" }), rf)).toMatchObject({ label: "In use", cls: "use" });
    expect(statusOf(acct({ name: "r", order: "R1", state: "ready" }), rf)).toMatchObject({ label: "Standby", tone: "rsv" });
    expect(statusOf(acct({ name: "r", order: "R1", state: "ready" }), { ...rf, servingReserve: true })).toMatchObject({ label: "In use" });
  });

  it("disabled wins over everything", () => {
    expect(statusOf(acct({ name: "x", active: false, order: "1" }), rf)).toMatchObject({ label: "Disabled", group: "off" });
  });
});

describe("statusOf (other strategies)", () => {
  it("an unlocked account with 0% weekly quota is not shown as usable under fill-first", () => {
    const s = statusOf(acct({ name: "changqing", state: "ready", order: "3", windows: { "7d": { remainingPct: 0, resetAt: iso(NOW + 14 * H) } } }),
      { strategy: "fill-first", now: NOW });
    expect(s).toMatchObject({ group: "wait", label: "Weekly limit", tone: "warn" });
  });

  it("an account with quota is ready under round robin", () => {
    expect(statusOf(acct({ name: "x", state: "ready", windows: { "7d": { remainingPct: 40 } } }), { strategy: "round-robin", now: NOW }))
      .toMatchObject({ group: "rot", label: "Ready" });
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
