// Cross-process OAuth refresh lease. During a rolling deploy two 9router slots share
// one SQLite file. Claude/Codex refresh tokens are single-use, so the slots must
// never both spend the same one.
//
// - The lease SQL is checked on two separate SQLite connections to one file.
// - refreshProviderCredentials is raced from two real child processes on one data
//   dir (tests/unit/fixtures/refresh-lease-instance.mjs) against a fake token
//   endpoint that treats every refresh token as single-use.
// - A crashed holder's lease expires, and the next refresh goes through.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-refresh-lease-"));
process.env.DATA_DIR = dataDir;

const leaseRepo = await import("../../src/lib/db/repos/refreshLeaseRepo.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { createProviderConnection, getProviderConnectionById, updateProviderConnectionWith } = await import("../../src/lib/db/repos/connectionsRepo.js");
const { DATA_FILE } = await import("../../src/lib/db/paths.js");
const ocm = await import("open-sse/services/oauthCredentialManager.js");

const LEASE_SQL = leaseRepo.REFRESH_LEASE_UPSERT_SQL;

// A second connection to the same file, as another process would have. It must use
// the same SQLite library as the app's adapter: two SQLite copies in one process
// break POSIX file locks, and closing one handle deletes the WAL under the other.
async function openOther() {
  const { driver } = await getAdapter();
  const db = driver === "node:sqlite"
    ? new (await import("node:sqlite")).DatabaseSync(DATA_FILE)
    : new Database(DATA_FILE);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

const originalFetch = globalThis.fetch;
let tokenCalls;
let gate;

beforeEach(async () => {
  await getAdapter(); // creates the schema, refreshLeases included
  tokenCalls = [];
  gate = null;
  globalThis.__9rRefreshDedupCache?.clear();
  globalThis.__9rRefreshLocks?.clear();
  // Claude's token endpoint. Refresh tokens are single-use: the same one twice is invalid_grant.
  const spent = new Set();
  globalThis.fetch = vi.fn(async (_url, init) => {
    const { refresh_token: rt } = JSON.parse(init.body);
    tokenCalls.push(rt);
    if (gate) await gate;
    if (spent.has(rt)) {
      return { ok: false, status: 400, text: async () => '{"error":"invalid_grant","error_description":"Refresh token already used"}' };
    }
    spent.add(rt);
    const n = tokenCalls.length;
    return { ok: true, status: 200, json: async () => ({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 28800 }), text: async () => "" };
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  ocm.__setRefreshLeaseStoreForTests(undefined);
  vi.useRealTimers();
});

describe("lease SQL on one file, two connections", () => {
  it("only one holder at a time; the holder can renew; an expired lease can be taken over", async () => {
    const other = await openOther();
    try {
      const now = Date.now();
      expect(await leaseRepo.acquireRefreshLease("c-sql", { owner: "slot-a", now })).toBe(true);
      // The other "process" sees it and can't take it.
      expect(other.prepare(LEASE_SQL).run("c-sql", "slot-b", now + 90_000, now).changes).toBe(0);
      // The holder renews.
      expect(await leaseRepo.acquireRefreshLease("c-sql", { owner: "slot-a", now: now + 1000 })).toBe(true);
      // After expiry (crash: no renewals, no release) the other one takes it.
      const later = now + 1000 + leaseRepo.REFRESH_LEASE_TTL_MS + 1;
      expect(other.prepare(LEASE_SQL).run("c-sql", "slot-b", later + 90_000, later).changes).toBe(1);
      expect((await leaseRepo.getRefreshLease("c-sql")).owner).toBe("slot-b");
      // A stale holder can't release someone else's lease.
      await leaseRepo.releaseRefreshLease("c-sql", { owner: "slot-a" });
      expect((await leaseRepo.getRefreshLease("c-sql")).owner).toBe("slot-b");
    } finally {
      other.close();
    }
  });

  it("the lease table holds no token material", async () => {
    const cols = (await getAdapter()).all("PRAGMA table_info(refreshLeases)").map((c) => c.name);
    expect(cols.sort()).toEqual(["connectionId", "expiresAt", "owner"]);
  });
});

describe("two processes refreshing the same Claude login", () => {
  // A fake Claude token endpoint shared by both child processes. Refresh tokens are
  // single-use: presenting one twice is invalid_grant, as with the real endpoint.
  let server;
  let tokenUrl;
  let spentTokens;
  let holdFirst;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        const { refresh_token: rt } = JSON.parse(body || "{}");
        spentTokens.push(rt);
        if (holdFirst && spentTokens.length === 1) await holdFirst;
        res.setHeader("Content-Type", "application/json");
        if (spentTokens.indexOf(rt) !== spentTokens.length - 1) {
          res.statusCode = 400;
          res.end('{"error":"invalid_grant","error_description":"Refresh token already used"}');
          return;
        }
        const n = spentTokens.length;
        res.end(JSON.stringify({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 28800 }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    tokenUrl = `http://127.0.0.1:${server.address().port}/v1/oauth/token`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => { spentTokens = []; holdFirst = null; });

  const instance = (connectionId, heldRefreshToken) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "tests/unit/fixtures/refresh-lease-instance.mjs"), connectionId, heldRefreshToken], {
      cwd: ROOT,
      env: { ...process.env, NINEROUTER_ROOT: ROOT, DATA_DIR: dataDir, TOKEN_URL: tokenUrl, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = out.trim().split("\n").pop();
      try { resolve({ code, result: JSON.parse(line), err }); } catch { reject(new Error(`instance exited ${code}: ${err.slice(-600)}`)); }
    });
  });

  async function seed(name, extra = {}) {
    const conn = await createProviderConnection({
      provider: "claude", authType: "oauth", name, isActive: true,
      accessToken: "at-0", refreshToken: "rt-0", expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra,
    });
    return conn.id;
  }

  it("two processes refresh at once: the token is spent once and both end up with the new one", async () => {
    const id = await seed("proc-race");
    let release;
    holdFirst = new Promise((r) => { release = r; });
    const a = instance(id, "rt-0");
    await vi.waitFor(() => expect(spentTokens).toHaveLength(1), { timeout: 15_000, interval: 50 });
    const b = instance(id, "rt-0"); // same stale snapshot, separate process
    await new Promise((r) => setTimeout(r, 1500)); // b reaches the busy lease and polls
    expect(spentTokens).toEqual(["rt-0"]);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(spentTokens).toEqual(["rt-0"]); // exactly one upstream refresh
    expect(ra.result).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
    expect(rb.result).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
    // Saved under the lease, before it was released.
    expect(await getProviderConnectionById(id)).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
    expect(await leaseRepo.getRefreshLease(id)).toBeNull();
  }, 60_000);

  it("a process holding a stale snapshot adopts the stored tokens instead of spending its own", async () => {
    const id = await seed("proc-stale");
    expect((await instance(id, "rt-0")).result).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
    const late = await instance(id, "rt-0"); // still holds rt-0
    expect(spentTokens).toEqual(["rt-0"]);
    expect(late.result).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
  }, 60_000);

  it("with a stale snapshot and an expired stored access token, it refreshes with the stored token", async () => {
    const id = await seed("proc-stale-expired", { refreshToken: "rt-9", accessToken: "at-9", expiresAt: new Date(Date.now() - 1000).toISOString() });
    const r = await instance(id, "rt-0");
    expect(spentTokens).toEqual(["rt-9"]);
    expect(r.result).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
  }, 60_000);

  it("a lease left by a crashed process blocks spending until it expires", async () => {
    const id = await seed("proc-crash");
    const db = await getAdapter();
    // A lease held by a process that died without releasing it.
    db.run(leaseRepo.REFRESH_LEASE_UPSERT_SQL, [id, "crashed-slot", Date.now() + 25_000, Date.now()]);
    const blocked = await instance(id, "rt-0"); // waits up to 20 s, then gives up
    expect(blocked.result).toBeNull();
    expect(spentTokens).toEqual([]);
    // Expired now (no renewals from the dead process): the next refresh takes it over.
    db.run("UPDATE refreshLeases SET expiresAt = ? WHERE connectionId = ?", [Date.now() - 1, id]);
    const r = await instance(id, "rt-0");
    expect(spentTokens).toEqual(["rt-0"]);
    expect(r.result).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
  }, 60_000);

  it("does not overwrite a re-login that landed during the refresh", async () => {
    const id = await seed("proc-relogin");
    let release;
    holdFirst = new Promise((r) => { release = r; });
    const a = instance(id, "rt-0");
    await vi.waitFor(() => expect(spentTokens).toHaveLength(1), { timeout: 15_000, interval: 50 });
    await updateProviderConnectionWith(id, () => ({ refreshToken: "rt-relogin", accessToken: "at-relogin" }));
    release();
    await a;
    expect(await getProviderConnectionById(id)).toMatchObject({ refreshToken: "rt-relogin", accessToken: "at-relogin" });
  }, 60_000);
});

describe("fail-open", () => {
  it("without a lease store (sql.js, no DB) it refreshes as before", async () => {
    ocm.__setRefreshLeaseStoreForTests(null);
    const r = await ocm.refreshProviderCredentials("claude", { connectionId: "no-store", refreshToken: "rt-0" }, null);
    expect(tokenCalls).toEqual(["rt-0"]);
    expect(r).toMatchObject({ accessToken: "at-1" });
  });

  it("a broken lease table (not contention) does not block the refresh", async () => {
    ocm.__setRefreshLeaseStoreForTests({ acquire: async () => { throw new Error("no such table: refreshLeases"); }, release: async () => {}, read: async () => null, save: async () => {} });
    const r = await ocm.refreshProviderCredentials("claude", { connectionId: "broken", refreshToken: "rt-0" }, null);
    expect(r).toMatchObject({ accessToken: "at-1" });
  });

  it("SQLITE_BUSY is retried like a held lease, never refreshed around", async () => {
    const acquire = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))
      .mockResolvedValue(true);
    ocm.__setRefreshLeaseStoreForTests({ acquire, release: async () => {}, read: async () => null, save: async () => {}, ttlMs: 90_000 });
    const r = await ocm.refreshProviderCredentials("claude", { connectionId: "busy", refreshToken: "rt-0" }, null);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(tokenCalls).toEqual(["rt-0"]);
    expect(r).toMatchObject({ accessToken: "at-1" });
  });

  it("the real store reports sql.js as not shared", () => {
    expect(leaseRepo.refreshLeaseIsShared({ driver: "sql.js" })).toBe(false);
    expect(leaseRepo.refreshLeaseIsShared({ driver: "better-sqlite3" })).toBe(true);
  });

  it("the app's own lease store works end to end on this DB", async () => {
    ocm.__setRefreshLeaseStoreForTests(undefined);
    const conn = await createProviderConnection({ provider: "claude", authType: "oauth", name: "real-store", isActive: true, accessToken: "at-0", refreshToken: "rt-0" });
    const r = await ocm.refreshProviderCredentials("claude", { connectionId: conn.id, refreshToken: "rt-0" }, null);
    expect(r).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
    expect(await getProviderConnectionById(conn.id)).toMatchObject({ refreshToken: "rt-1" });
    expect(await leaseRepo.getRefreshLease(conn.id)).toBeNull();
  });
});
