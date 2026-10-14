// Quota locks lift when a fresh reading shows quota again (poll, dashboard, manual
// reset), but not from a reading taken before the lock, and short non-quota
// cooldowns are never touched.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { quotaLocksToLift, applyQuotaReading, liftQuotaLockNow } = await import("@/sse/services/quotaPoller.js");
const { __resetQuotaStateForTests, recordQuotaPoll } = await import("open-sse/services/quotaState.js");

const DAY = 86400e3;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const usage = (fetchedAt, extra = {}) => ({ fetchedAt, quotas: {
  "session (5h)": { used: 10, resetAt: iso(now + 3600e3) },
  "weekly (7d)": { used: 50, resetAt: iso(now + 3 * DAY) },
  ...extra,
} });

beforeEach(() => __resetQuotaStateForTests());

describe("lifting quota locks", () => {
  const conn = (extra) => ({ id: "c1", provider: "claude", lastErrorAt: iso(now - 60e3), ...extra });

  it("lifts the account lock on a reading newer than the 429", () => {
    const snap = recordQuotaPoll("claude", "c1", usage(now));
    expect(quotaLocksToLift(conn({ modelLock___all: iso(now + 3 * DAY) }), snap, now)).toEqual(["modelLock___all"]);
  });

  it("keeps it when the reading predates the 429 (cached usage)", () => {
    const snap = recordQuotaPoll("claude", "c1", usage(now - 5 * 60e3));
    expect(quotaLocksToLift(conn({ modelLock___all: iso(now + 3 * DAY) }), snap, now)).toEqual([]);
  });

  it("lifts a model-scoped quota lock when its scoped window refilled, never a short cooldown", () => {
    const snap = recordQuotaPoll("claude", "c1", usage(now, { "weekly opus (7d)": { used: 0, resetAt: iso(now + 3 * DAY) } }));
    const c = conn({ "modelLock_claude-opus-5-5": iso(now + 2 * DAY), "modelLock_claude-haiku-4-5": iso(now + 60e3) });
    expect(quotaLocksToLift(c, snap, now)).toEqual(["modelLock_claude-opus-5-5"]);
  });

  it("applyQuotaReading writes only the lifted keys", async () => {
    const update = vi.fn(async () => ({}));
    await applyQuotaReading(conn({ modelLock___all: iso(now + DAY) }), usage(now), { updateProviderConnection: update });
    expect(update).toHaveBeenCalledWith("c1", { modelLock___all: null });
  });

  it("a manual reset clears the account lock and model quota locks, not short cooldowns", async () => {
    let patch = null;
    const updateWith = vi.fn(async (_id, build) => { patch = build({
      modelLock___all: iso(now + 3 * DAY),
      "modelLock_claude-opus-5-5": iso(now + 2 * DAY),
      "modelLock_claude-haiku-4-5": iso(now + 60e3),
      "modelLock_old": iso(now - 60e3),
    }); });
    await liftQuotaLockNow("c1", { updateProviderConnectionWith: updateWith });
    expect(patch).toEqual({ modelLock___all: null, "modelLock_claude-opus-5-5": null });
  });
});
