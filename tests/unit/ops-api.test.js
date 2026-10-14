// Ops API (/api/ops/*): ops-token auth, scopes, brute-force lockout, metrics
// aggregation and the allowlisted views. Runs against a throwaway DATA_DIR.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-ops-api-"));
process.env.DATA_DIR = dataDir;
// Trusted peer IP for the limiter (what custom-server.js stamps in production).
process.env.NINEROUTER_PEER_TOKEN = "peer-test";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json", ...(init.headers || {}) } }),
    next: () => new Response(null, { status: 200, headers: { "x-next": "1" } }),
  },
}));

const repo = await import("../../src/lib/db/repos/opsTokensRepo.js");
const metrics = await import("../../src/lib/db/repos/requestMetricsRepo.js");
const { createProviderConnection, updateProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");
const whoami = await import("../../src/app/api/ops/whoami/route.js");
const accountsRoute = await import("../../src/app/api/ops/accounts/route.js");
const healthRoute = await import("../../src/app/api/ops/health/route.js");
const checkRoute = await import("../../src/app/api/ops/check/route.js");
const tokensRoute = await import("../../src/app/api/ops/tokens/route.js");
const quotaRoute = await import("../../src/app/api/ops/accounts/[id]/quota/route.js");
const { proxy } = await import("../../src/dashboardGuard.js");

metrics.__test__.state.enabled = true;

let ip = 0;
const req = (url, token, { method = "GET", body, fromIp } = {}) => new Request(`http://localhost${url}`, {
  method,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "x-9r-peer-token": "peer-test",
    "x-9r-real-ip": fromIp || `10.0.0.${++ip}`,
    ...(body ? { "Content-Type": "application/json" } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});
const json = async (res) => ({ status: res.status, body: await res.json() });

let readToken, adminToken;

beforeAll(async () => {
  readToken = (await repo.createOpsToken({ name: "reader", scope: "read" })).token;
  adminToken = (await repo.createOpsToken({ name: "boss", scope: "admin" })).token;
});
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("ops tokens", () => {
  it("stores only a hash and shows the token once", async () => {
    const { token, record } = await repo.createOpsToken({ name: "once", scope: "read" });
    expect(token).toMatch(/^9rops_[A-Za-z0-9_-]{40,}$/);
    expect(JSON.stringify(record)).not.toContain(token.slice(10));
    const raw = fs.readFileSync(path.join(dataDir, "db", "data.sqlite")).toString("latin1");
    expect(raw).not.toContain(token);
  });

  it("rejects missing, wrong, revoked and expired tokens with the same 401", async () => {
    expect((await whoami.GET(req("/api/ops/whoami"))).status).toBe(401);
    expect((await whoami.GET(req("/api/ops/whoami", "9rops_nope"))).status).toBe(401);
    const { token } = await repo.createOpsToken({ name: "gone", scope: "read" });
    await repo.revokeOpsToken("gone");
    expect((await whoami.GET(req("/api/ops/whoami", token))).status).toBe(401);
    const old = await repo.createOpsToken({ name: "old", scope: "read", expiresAt: "2020-01-01T00:00:00Z" });
    expect((await whoami.GET(req("/api/ops/whoami", old.token))).status).toBe(401);
  });

  it("does not accept a dashboard cookie or an inference key", async () => {
    const r = new Request("http://localhost/api/ops/whoami", { headers: { cookie: "auth_token=x", "x-api-key": "sk-something" } });
    expect((await whoami.GET(r)).status).toBe(401);
  });

  it("enforces scope", async () => {
    expect((await whoami.GET(req("/api/ops/whoami", readToken))).status).toBe(200);
    expect((await tokensRoute.GET(req("/api/ops/tokens", readToken))).status).toBe(403);
    expect((await tokensRoute.GET(req("/api/ops/tokens", adminToken))).status).toBe(200);
  });

  it("locks out repeated wrong tokens from an IP, but never a valid one", async () => {
    for (let i = 0; i < 5; i++) await whoami.GET(req("/api/ops/whoami", "9rops_wrong", { fromIp: "203.0.113.9" }));
    const guess = await whoami.GET(req("/api/ops/whoami", "9rops_wrong-again", { fromIp: "203.0.113.9" }));
    expect(guess.status).toBe(429);
    expect(guess.headers.get("Retry-After")).toBeTruthy();
    // Behind a proxy many clients can share one bucket: a scanner must not lock out real tokens.
    expect((await whoami.GET(req("/api/ops/whoami", readToken, { fromIp: "203.0.113.9" }))).status).toBe(200);
  });

  it("does not count requests without an ops token toward the lockout", async () => {
    for (let i = 0; i < 8; i++) await whoami.GET(req("/api/ops/whoami", null, { fromIp: "203.0.113.20" }));
    expect((await whoami.GET(req("/api/ops/whoami", "9rops_wrong", { fromIp: "203.0.113.20" }))).status).toBe(401);
  });

  it("refuses a second live token with the same name and revokes the live one by name", async () => {
    const first = await repo.createOpsToken({ name: "rot", scope: "read" });
    await expect(repo.createOpsToken({ name: "rot", scope: "read" })).rejects.toThrow(/already exists/);
    await repo.revokeOpsToken("rot");
    const second = await repo.createOpsToken({ name: "rot", scope: "admin" });
    const res = await json(await tokensRoute.DELETE(req("/api/ops/tokens?id=rot", adminToken, { method: "DELETE" })));
    expect(res.body.alreadyRevoked).toBe(false);
    expect((await whoami.GET(req("/api/ops/whoami", second.token))).status).toBe(401);
    expect((await whoami.GET(req("/api/ops/whoami", first.token))).status).toBe(401);
  });

  it("needs an operate token to force a live quota refresh", async () => {
    const res = await quotaRoute.GET(req("/api/ops/accounts/acct-x/quota?force=1", readToken), { params: Promise.resolve({ id: "acct-x" }) });
    expect([403, 404]).toContain(res.status);
  });

  it("lets an admin issue and revoke tokens, idempotently", async () => {
    const created = await json(await tokensRoute.POST(req("/api/ops/tokens", adminToken, { method: "POST", body: { name: "cron", scope: "read" } })));
    expect(created.status).toBe(200);
    expect(created.body.token).toMatch(/^9rops_/);
    const r1 = await json(await tokensRoute.DELETE(req("/api/ops/tokens?id=cron", adminToken, { method: "DELETE" })));
    const r2 = await json(await tokensRoute.DELETE(req("/api/ops/tokens?id=cron", adminToken, { method: "DELETE" })));
    expect(r1.body.alreadyRevoked).toBe(false);
    expect(r2.body.alreadyRevoked).toBe(true);
  });
});

describe("dashboard guard", () => {
  it("passes /api/ops through to the route's own token check", async () => {
    const r = new Request("http://localhost/api/ops/status");
    r.nextUrl = new URL(r.url);
    r.cookies = { get: () => undefined };
    const res = await proxy(r);
    expect(res.headers.get("x-next")).toBe("1");
  });
});

describe("metrics and views", () => {
  it("aggregates client-visible outcomes and leaves aborts and rejections out of the success rate", async () => {
    const now = Date.now();
    const base = { kind: "request", model: "claude-opus-5-5-combos", stream: true };
    for (let i = 0; i < 8; i++) metrics.recordRequestMetric({ ...base, ts: now - 1000, status: 200, outcome: "ok", ttftMs: 1000 + i * 100 });
    metrics.recordRequestMetric({ ...base, ts: now - 1000, status: 503, outcome: "error", errorType: "unavailable" });
    metrics.recordRequestMetric({ ...base, ts: now - 1000, status: 499, outcome: "aborted", errorType: "client_abort" });
    metrics.recordRequestMetric({ ...base, ts: now - 1000, status: 400, outcome: "rejected", errorType: "bad_request" });
    const res = await json(await healthRoute.GET(req("/api/ops/health?since=1h", readToken)));
    const row = res.body.rows[0];
    expect(row.total).toBe(11);
    expect(row.successRate).toBeCloseTo(8 / 9);
    expect(row.aborted).toBe(1);
    expect(row.rejected).toBe(1);
    expect(row.ttftP90).toBe(1700);
  });

  it("never returns credentials from the accounts view", async () => {
    const conn = await createProviderConnection({
      provider: "claude", authType: "oauth", name: "acct-a", isActive: true,
      accessToken: "sk-ant-oat01-SECRET", refreshToken: "REFRESH-SECRET", apiKey: "sk-upstream-SECRET",
    });
    // An upstream error that echoes credentials (relay base URL with userinfo).
    await updateProviderConnection(conn.id, { lastError: "Request cannot be constructed from a URL that includes credentials: https://relay-user:SECRETPASS@relay.example.com/v1" });
    // Locks are written the way markAccountUnavailable does it.
    await updateProviderConnection(conn.id, { modelLock_x: new Date(Date.now() + 60000).toISOString() });
    metrics.recordRequestMetric({ kind: "attempt", provider: "claude", model: "x", connectionId: conn.id, status: 429, outcome: "error" });
    const res = await accountsRoute.GET(req("/api/ops/accounts?provider=claude", readToken));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/SECRET/);
    expect(text).toContain("relay.example.com"); // error text is kept, credentials are not
    const acct = JSON.parse(text).accounts.find((a) => a.name === "acct-a");
    expect(acct.state).toBe("locked");
    expect(acct.rateLimited).toBe(1);
  });

  it("check returns a verdict with numbers", async () => {
    const res = await json(await checkRoute.GET(req("/api/ops/check?since=1h&minRequests=1&successWarn=0.95&successCrit=0.5", readToken)));
    expect(res.status).toBe(200);
    expect(["ok", "warn", "crit"]).toContain(res.body.level);
    expect(res.body.checks.find((c) => c.name === "success_rate").level).toBe("warn");
  });

  it("rejects malformed windows", async () => {
    const res = await healthRoute.GET(req("/api/ops/health?since=yesterday", readToken));
    expect(res.status).toBe(400);
  });
});

describe("selection policy (reset-first)", () => {
  const accountRoute = () => import("../../src/app/api/ops/accounts/[id]/route.js");
  const poolRoute = () => import("../../src/app/api/ops/quota/route.js");
  let operateToken;
  beforeAll(async () => {
    operateToken = (await repo.createOpsToken({ name: "operator", scope: "operate" })).token;
  });
  const patch = async (id, token, body) => (await accountRoute()).PATCH(
    req(`/api/ops/accounts/${id}`, token, { method: "PATCH", body }), { params: Promise.resolve({ id }) });

  it("needs operate to change an account's policy, and writes only the policy fields", async () => {
    const conn = await createProviderConnection({
      provider: "claude", authType: "oauth", name: "acct-policy", isActive: true,
      accessToken: "sk-ant-oat01-SECRET", refreshToken: "REFRESH-SECRET",
    });
    await updateProviderConnection(conn.id, { modelLock___all: new Date(Date.now() + 60000).toISOString() });
    expect((await patch("acct-policy", readToken, { poolRole: "reserve" })).status).toBe(403);

    const res = await json(await patch("acct-policy", operateToken, { poolRole: "reserve", keepPct: 30, releaseBeforeHours: 12 }));
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ poolRole: "reserve", keepPct: 30, releaseBeforeHours: 12 });
    expect(Object.keys(res.body.changed).sort()).toEqual(["keepPct", "poolRole", "releaseBeforeHours"]);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET/);
    const { getProviderConnectionById } = await import("../../src/lib/db/repos/connectionsRepo.js");
    const stored = await getProviderConnectionById(conn.id);
    expect(stored).toMatchObject({ poolRole: "reserve", keepPct: 30, releaseBeforeHours: 12, refreshToken: "REFRESH-SECRET" });
    expect(Date.parse(stored.modelLock___all)).toBeGreaterThan(Date.now()); // locks untouched

    const again = await json(await patch("acct-policy", operateToken, { poolRole: "reserve" }));
    expect(again.body.changed).toEqual({});
  });

  it("rejects unknown fields, bad values and non-quota providers", async () => {
    expect((await patch("acct-policy", operateToken, { accessToken: "x" })).status).toBe(400);
    expect((await patch("acct-policy", operateToken, { keepPct: 150 })).status).toBe(400);
    expect((await patch("acct-policy", operateToken, {})).status).toBe(400);
    await createProviderConnection({ provider: "openai", authType: "apikey", name: "acct-openai", isActive: true, apiKey: "sk-SECRET" });
    expect((await patch("acct-openai", operateToken, { keepPct: 10 })).status).toBe(400);
    expect((await patch("no-such-account", operateToken, { keepPct: 10 })).status).toBe(404);
  });

  it("shows the pool with policy and order, without credentials", async () => {
    const res = await (await poolRoute()).GET(req("/api/ops/quota?provider=claude", readToken));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/SECRET/);
    const body = JSON.parse(text);
    expect(body.strategy).toBe("fill-first");
    const acct = body.accounts.find((a) => a.name === "acct-policy");
    expect(acct).toMatchObject({ role: "reserve", keepPct: 30, state: "locked" });
    expect((await (await poolRoute()).GET(req("/api/ops/quota?provider=openai", readToken))).status).toBe(400);
    expect((await (await poolRoute()).GET(req("/api/ops/quota", readToken))).status).toBe(400);
  });
});
