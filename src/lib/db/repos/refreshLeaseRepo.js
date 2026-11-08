// Cross-process OAuth refresh lease. Two 9router processes can share one data
// dir: during a rolling deploy both slots run for a while. Refresh tokens are
// single-use, so if both slots refresh the same token, the second refresh
// revokes the login.
//
// A lease is one row per connection with an owner and an expiry, taken with a
// single atomic UPSERT. A lease left behind by a crashed process expires on its
// own. The row holds no token material.
//
// This only works on file-backed adapters, where all processes see the same file.
// sql.js loads the file into memory and writes it back later, so a lease there
// only covers this process (which the in-process lock already does).
import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";

// Long enough for the slowest refresh call (fetch timeout plus the DB write that
// follows). Short enough that a crash only delays the next refresh a little.
export const REFRESH_LEASE_TTL_MS = 90_000;

// One id per process. On globalThis because Next bundles this module more than
// once, and every copy in a process must count as the same owner.
const OWNER = globalThis.__9rRefreshLeaseOwner ??= `${process.pid}-${randomUUID()}`;

export function refreshLeaseOwner() {
  return OWNER;
}

/** False on adapters whose writes other processes don't see (sql.js). */
export function refreshLeaseIsShared(db) {
  return db?.driver !== "sql.js";
}

// One atomic statement: insert, or take over only an expired lease or one we hold.
// Params: connectionId, owner, newExpiresAt, now.
export const REFRESH_LEASE_UPSERT_SQL = `INSERT INTO refreshLeases(connectionId, owner, expiresAt) VALUES(?, ?, ?)
     ON CONFLICT(connectionId) DO UPDATE SET owner = excluded.owner, expiresAt = excluded.expiresAt
     WHERE refreshLeases.expiresAt <= ? OR refreshLeases.owner = excluded.owner`;

/**
 * Take the lease for `connectionId`. It succeeds when there is no lease, when the
 * lease has expired, or when this process already holds it.
 * @returns {Promise<boolean>}
 */
export async function acquireRefreshLease(connectionId, { owner = OWNER, ttlMs = REFRESH_LEASE_TTL_MS, now = Date.now() } = {}) {
  const db = await getAdapter();
  const r = db.run(REFRESH_LEASE_UPSERT_SQL, [connectionId, owner, now + ttlMs, now]);
  return Number(r?.changes ?? 0) > 0;
}

/** Drop the lease if this owner still holds it. */
export async function releaseRefreshLease(connectionId, { owner = OWNER } = {}) {
  const db = await getAdapter();
  db.run(`DELETE FROM refreshLeases WHERE connectionId = ? AND owner = ?`, [connectionId, owner]);
}

/** The current lease, or null. For tests and diagnostics. */
export async function getRefreshLease(connectionId) {
  const db = await getAdapter();
  return db.get(`SELECT connectionId, owner, expiresAt FROM refreshLeases WHERE connectionId = ?`, [connectionId]) || null;
}
