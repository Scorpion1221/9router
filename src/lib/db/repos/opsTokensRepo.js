// Ops API tokens: bearer credentials for /api/ops/* (the 9r CLI, scheduled
// health checks). Deliberately separate from the /v1 inference keys, which are
// handed out to clients and must never grant gateway management.
//
// Only a SHA-256 of each token is stored. The plaintext is returned once by
// createOpsToken() and cannot be recovered afterwards.
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

export const OPS_TOKEN_PREFIX = "9rops_";
// read: status, quota, metrics. operate: reversible account actions. admin: config + tokens.
export const OPS_SCOPES = ["read", "operate", "admin"];
const SCOPE_RANK = { read: 1, operate: 2, admin: 3 };
// lastUsed is informational; don't write on every request.
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

export function hashOpsToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function scopeAllows(granted, required) {
  return (SCOPE_RANK[granted] || 0) >= (SCOPE_RANK[required] || Infinity);
}

function rowToToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt || null,
    revokedAt: row.revokedAt || null,
    lastUsedAt: row.lastUsedAt || null,
    lastUsedIp: row.lastUsedIp || null,
  };
}

export async function listOpsTokens() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM opsTokens ORDER BY createdAt ASC`).map(rowToToken);
}

/**
 * Create a token. Returns { token, record } — `token` is the only copy of the
 * plaintext.
 */
export async function createOpsToken({ name, scope = "read", expiresAt = null }) {
  const cleanName = String(name || "").trim();
  if (!cleanName || cleanName.length > 64) throw new Error("name is required (max 64 chars)");
  if (!OPS_SCOPES.includes(scope)) throw new Error(`scope must be one of ${OPS_SCOPES.join(", ")}`);
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error("expiresAt must be an ISO date");

  const token = OPS_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const record = {
    id: uuidv4(),
    name: cleanName,
    tokenHash: hashOpsToken(token),
    prefix: token.slice(0, OPS_TOKEN_PREFIX.length + 4),
    scope,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  };
  const db = await getAdapter();
  // Names are how tokens are revoked from the CLI, so a live name must be unique.
  if (db.get(`SELECT id FROM opsTokens WHERE name = ? AND revokedAt IS NULL`, [cleanName])) {
    throw Object.assign(new Error(`an active token named '${cleanName}' already exists; revoke it first or pick another name`), { code: "NAME_TAKEN" });
  }
  db.run(
    `INSERT INTO opsTokens (id, name, tokenHash, prefix, scope, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.name, record.tokenHash, record.prefix, record.scope, record.createdAt, record.expiresAt]
  );
  return { token, record: rowToToken(record) };
}

export async function revokeOpsToken(idOrName) {
  const db = await getAdapter();
  // Resolve among live tokens first, so an old revoked token with the same name
  // can never shadow the one that needs revoking.
  const live = db.all(`SELECT * FROM opsTokens WHERE (id = ? OR name = ?) AND revokedAt IS NULL`, [idOrName, idOrName]);
  if (live.length > 1) return { found: true, ambiguous: live.length };
  const row = live[0] || db.get(`SELECT * FROM opsTokens WHERE id = ? OR name = ? ORDER BY revokedAt DESC`, [idOrName, idOrName]);
  if (!row) return { found: false };
  if (row.revokedAt) return { found: true, alreadyRevoked: true, record: rowToToken(row) };
  const revokedAt = new Date().toISOString();
  db.run(`UPDATE opsTokens SET revokedAt = ? WHERE id = ?`, [revokedAt, row.id]);
  return { found: true, alreadyRevoked: false, record: rowToToken({ ...row, revokedAt }) };
}

/**
 * Resolve a presented token to its record, or null when unknown, revoked or
 * expired. Lookup is by hash (an index probe on a uniformly random digest, so
 * timing reveals nothing about stored tokens); the digest is still compared in
 * constant time as defence in depth.
 */
export async function verifyOpsToken(token, { ip = null } = {}) {
  if (typeof token !== "string" || !token.startsWith(OPS_TOKEN_PREFIX) || token.length > 200) return null;
  const digest = hashOpsToken(token);
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM opsTokens WHERE tokenHash = ?`, [digest]);
  if (!row) return null;
  const a = Buffer.from(row.tokenHash, "hex");
  const b = Buffer.from(digest, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null;

  const last = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
  if (Date.now() - last > LAST_USED_WRITE_INTERVAL_MS || row.lastUsedIp !== ip) {
    try {
      db.run(`UPDATE opsTokens SET lastUsedAt = ?, lastUsedIp = ? WHERE id = ?`, [new Date().toISOString(), ip, row.id]);
    } catch { /* bookkeeping only */ }
  }
  return rowToToken(row);
}
