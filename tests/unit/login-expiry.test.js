// Claude logins stop refreshing ~28 days after sign-in. The connection list flags
// them from reauthorizedAt/createdAt, and from the server-side dead-token stamp.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

const { loginExpiry } = await import("../../src/app/(dashboard)/dashboard/providers/[id]/quotaRouting.js");
const { toProviderConnectionResponse } = await import("../../src/lib/providerConnectionResponse.js");

const NOW = Date.parse("2026-11-06T02:00:00Z");
const H = 3600e3;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const claude = (o) => ({ provider: "claude", authType: "oauth", isActive: true, createdAt: iso(NOW - 10 * D), ...o });

describe("loginExpiry", () => {
  it("counts 28 days from the login and tiers by time left", () => {
    expect(loginExpiry(claude({ createdAt: iso(NOW - 10 * D) }), NOW)).toMatchObject({ tier: "ok", left: 18 * D });
    expect(loginExpiry(claude({ createdAt: iso(NOW - 22 * D) }), NOW)).toMatchObject({ tier: "soon", tone: "muted", tag: "6d left" });
    expect(loginExpiry(claude({ createdAt: iso(NOW - 26 * D) }), NOW)).toMatchObject({ tier: "warn", tag: "Expires 2d" });
    expect(loginExpiry(claude({ createdAt: iso(NOW - 27.5 * D) }), NOW)).toMatchObject({ tier: "err", tag: "Expires 12h" });
    expect(loginExpiry(claude({ createdAt: iso(NOW - 29 * D) }), NOW)).toMatchObject({ tier: "err", tag: "Due now" });
  });

  it("a re-authorize restarts the clock", () => {
    const e = loginExpiry(claude({ createdAt: iso(NOW - 40 * D), reauthorizedAt: iso(NOW - 2 * D) }), NOW);
    expect(e).toMatchObject({ tier: "ok", left: 26 * D });
    expect(e.tip).toContain("Re-authorized");
  });

  it("a rejected refresh token is expired whatever its age, most urgent first", () => {
    const dead = loginExpiry(claude({
      createdAt: iso(NOW - 3 * D), refreshTokenDead: true,
      refreshTokenDeadAt: iso(NOW - H), expiresAt: iso(NOW + 3 * H),
    }), NOW);
    expect(dead).toMatchObject({ tier: "dead", tone: "err", tag: "Login expired" });
    expect(dead.detail).toContain("current token works 3h more");
    const dueSoon = loginExpiry(claude({ createdAt: iso(NOW - 27.9 * D) }), NOW);
    expect(dead.rank).toBeLessThan(dueSoon.rank);
  });

  it("only Claude OAuth rows have a known limit", () => {
    expect(loginExpiry(claude({ provider: "codex" }), NOW)).toBeNull();
    expect(loginExpiry(claude({ authType: "apikey" }), NOW)).toBeNull();
    expect(loginExpiry(claude({ createdAt: undefined }), NOW)).toBeNull();
  });
});

describe("toProviderConnectionResponse dead-token flag", () => {
  const fp = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);

  it("flags a stamp that matches the current refresh token, and never sends the token", () => {
    const out = toProviderConnectionResponse(claude({ refreshToken: "rt-1", accessToken: "at-1", refreshTokenDeadFor: fp("rt-1") }));
    expect(out.refreshTokenDead).toBe(true);
    expect(out).not.toHaveProperty("refreshToken");
    expect(out).not.toHaveProperty("accessToken");
  });

  it("a re-login writes a new token, so the old stamp no longer flags it", () => {
    const out = toProviderConnectionResponse(claude({ refreshToken: "rt-2", refreshTokenDeadFor: fp("rt-1") }));
    expect(out).not.toHaveProperty("refreshTokenDead");
  });
});
