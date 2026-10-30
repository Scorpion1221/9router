/**
 * Re-authorizing a Claude connection in place (POST /api/oauth/claude/exchange
 * with connectionId): the row keeps its id/name/settings, gets fresh tokens and a
 * reauthorizedAt stamp, and a login for a different Anthropic account is refused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body, json: async () => body }),
  },
}));

const tokenData = vi.fn();
vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(async () => tokenData()),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

const rows = new Map();
const created = [];
vi.mock("@/models", () => ({
  createProviderConnection: vi.fn(async (d) => { created.push(d); return { id: "new-row", ...d }; }),
  getProviderConnectionById: vi.fn(async (id) => rows.get(id) || null),
  updateProviderConnection: vi.fn(async (id, patch) => {
    const merged = { ...rows.get(id), ...patch };
    rows.set(id, merged);
    return merged;
  }),
}));

vi.mock("@/lib/oauth/utils/server", () => Object.fromEntries(
  ["Codex", "Xai", "Trae", "Windsurf", "Zed", "XiaomiMimo"].flatMap((p) => [
    `start${p}Proxy`, `stop${p}Proxy`, `register${p}Session`, `get${p}SessionStatus`, `clear${p}Session`,
  ]).map((name) => [name, () => null]),
));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));

const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
const claude = (await import("../../src/lib/oauth/providers/claude.js")).default;

const exchange = (body, provider = "claude") =>
  POST(
    new Request(`http://localhost/api/oauth/${provider}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "c", redirectUri: "r", codeVerifier: "v", state: "s", ...body }),
    }),
    { params: Promise.resolve({ provider, action: "exchange" }) },
  );

const tokens = (accountUuid, accountEmail) => ({
  accessToken: "at-new",
  refreshToken: "rt-new",
  expiresIn: 28800,
  scope: "user:inference",
  providerSpecificData: { accountUuid, accountEmail, organizationUuid: "org-1" },
});

beforeEach(() => {
  rows.clear();
  created.length = 0;
  rows.set("row-1", {
    id: "row-1", provider: "claude", authType: "oauth", name: "shasha-team", priority: 3,
    accessToken: "at-old", refreshToken: "rt-old", createdAt: "2026-10-05T07:30:00.000Z",
    providerSpecificData: { proxyPoolId: "pool-a", accountUuid: "acct-shasha", accountEmail: "shasha@x.ai" },
  });
});

describe("claude mapTokens", () => {
  it("records the account and org from the token response", () => {
    const mapped = claude.mapTokens({
      access_token: "a", refresh_token: "r", expires_in: 28800, scope: "s",
      account: { uuid: "acct-1", email_address: "u@x.ai" }, organization: { uuid: "org-1" },
    });
    expect(mapped.providerSpecificData).toEqual({ accountUuid: "acct-1", accountEmail: "u@x.ai", organizationUuid: "org-1" });
    expect(mapped.email).toBeUndefined();
  });
});

describe("POST /api/oauth/claude/exchange with connectionId", () => {
  it("updates the same row in place and keeps its settings", async () => {
    tokenData.mockReturnValue(tokens("acct-shasha", "shasha@x.ai"));
    const res = await exchange({ connectionId: "row-1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, reauthorized: true, connection: { id: "row-1" } });
    expect(created).toHaveLength(0);
    const row = rows.get("row-1");
    expect(row).toMatchObject({ name: "shasha-team", priority: 3, accessToken: "at-new", refreshToken: "rt-new", testStatus: "active" });
    expect(row.providerSpecificData).toMatchObject({ proxyPoolId: "pool-a", accountUuid: "acct-shasha" });
    expect(Date.parse(row.reauthorizedAt)).toBeGreaterThan(Date.parse(row.createdAt));
    expect(Date.parse(row.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("refuses a login for a different account and leaves the row untouched", async () => {
    tokenData.mockReturnValue(tokens("acct-other", "other@x.ai"));
    const res = await exchange({ connectionId: "row-1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("other@x.ai");
    expect(rows.get("row-1").refreshToken).toBe("rt-old");
  });

  it("accepts and records the identity on a row that has none yet", async () => {
    rows.set("row-1", { ...rows.get("row-1"), providerSpecificData: { proxyPoolId: "pool-a" } });
    tokenData.mockReturnValue(tokens("acct-new", "new@x.ai"));
    const res = await exchange({ connectionId: "row-1" });

    expect(res.status).toBe(200);
    expect(rows.get("row-1").providerSpecificData).toMatchObject({ proxyPoolId: "pool-a", accountUuid: "acct-new", accountEmail: "new@x.ai" });
  });

  it("rejects an unknown row or one from another provider", async () => {
    tokenData.mockReturnValue(tokens("acct-shasha", "shasha@x.ai"));
    rows.set("codex-1", { id: "codex-1", provider: "codex", authType: "oauth", name: "cx" });

    expect((await exchange({ connectionId: "nope" })).status).toBe(404);
    expect((await exchange({ connectionId: "codex-1" })).status).toBe(404);
    expect(rows.get("codex-1").accessToken).toBeUndefined();
  });

  it("is refused for providers without in-place re-authorize", async () => {
    rows.set("gl-1", { id: "gl-1", provider: "gitlab", authType: "oauth", name: "gl" });
    tokenData.mockReturnValue({ accessToken: "a", refreshToken: "r", expiresIn: 60 });
    const res = await exchange({ connectionId: "gl-1" }, "gitlab");

    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it("answers a refused (stale or reused) code with 400 and a way out, not 500", async () => {
    tokenData.mockImplementation(() => {
      throw new Error('Token exchange failed: {"error": "invalid_grant", "error_description": "Code challenge failed."}');
    });
    const res = await exchange({ connectionId: "row-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/newest tab/);
    expect(rows.get("row-1").refreshToken).toBe("rt-old");
    tokenData.mockReset();
  });

  it("keeps other exchange failures as 500 with their message", async () => {
    tokenData.mockImplementation(() => { throw new Error("Token exchange failed: upstream down"); });
    const res = await exchange({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("upstream down");
    tokenData.mockReset();
  });

  it("still adds a new row when no connectionId is sent", async () => {
    tokenData.mockReturnValue(tokens("acct-shasha", "shasha@x.ai"));
    const res = await exchange({});

    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(rows.get("row-1").refreshToken).toBe("rt-old");
  });
});

describe("backfillClaudeIdentity", async () => {
  const { backfillClaudeIdentity } = await import("../../src/sse/services/quotaPoller.js");
  const identity = { accountUuid: "acct-9", accountEmail: "nine@x.ai", organizationUuid: "org-9" };

  const run = async (conn, current = conn, found = identity) => {
    const fetchIdentity = vi.fn(async () => found);
    let written = null;
    const updateProviderConnectionWith = vi.fn(async (id, build) => { written = build(current); });
    const ok = await backfillClaudeIdentity(conn, null, { fetchIdentity, updateProviderConnectionWith });
    return { ok, written, fetchIdentity };
  };

  it("fills the account into a row that has none, keeping its other settings", async () => {
    const conn = { id: "c1", provider: "claude", accessToken: "at", providerSpecificData: { proxyPoolId: "p" } };
    const { ok, written } = await run(conn);
    expect(ok).toBe(true);
    expect(written.providerSpecificData).toEqual({ proxyPoolId: "p", ...identity });
  });

  it("does not call the profile endpoint for rows that already know their account", async () => {
    const conn = { id: "c1", provider: "claude", accessToken: "at", providerSpecificData: { accountUuid: "acct-1" } };
    const { ok, fetchIdentity } = await run(conn);
    expect(ok).toBe(false);
    expect(fetchIdentity).not.toHaveBeenCalled();
  });

  it("skips other providers and failed lookups", async () => {
    expect((await run({ id: "x", provider: "codex", accessToken: "at" })).fetchIdentity).not.toHaveBeenCalled();
    const { ok, written } = await run({ id: "c1", provider: "claude", accessToken: "at" }, undefined, null);
    expect(ok).toBe(false);
    expect(written).toBeNull();
  });

  it("does not overwrite an account a login recorded in the meantime", async () => {
    const conn = { id: "c1", provider: "claude", accessToken: "at", providerSpecificData: {} };
    const current = { ...conn, providerSpecificData: { accountUuid: "acct-login" } };
    const { written } = await run(conn, current);
    expect(written).toBeNull();
  });
});
