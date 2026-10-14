// "reset-first" account order: spend the quota that expires first.
//
// Each account has a pool role (normal | reserve), a keep % (leave at least this
// much of every window unused) and releaseBeforeHours (in the last N hours before
// the weekly reset, keep no longer applies: unused quota is about to expire).
// Normal accounts go first, the one whose weekly window resets earliest leading;
// reserve accounts only take traffic when no normal account can, in priority order.
// Pure: reads only the in-memory quota snapshots and fields on the connection.
import { getQuotaSnapshot, windowAppliesTo, remainingPct } from "./quotaState.js";

const HOUR_MS = 3600 * 1000;

export const POOL_ROLES = ["normal", "reserve"];

// Policy fields live at the top level of the connection (not providerSpecificData,
// which an OAuth re-login replaces wholesale).
export const POLICY_FIELDS = ["poolRole", "keepPct", "releaseBeforeHours"];
const MAX_RELEASE_HOURS = 7 * 24;

/**
 * Validate a policy patch from an API body. Only the keys present are returned;
 * null resets a field to its default.
 * @returns {{ patch: object } | { error: string }}
 */
export function parsePolicyPatch(body) {
  const patch = {};
  if (body?.poolRole !== undefined) {
    if (body.poolRole !== null && !POOL_ROLES.includes(body.poolRole)) return { error: `poolRole must be one of ${POOL_ROLES.join(", ")}` };
    patch.poolRole = body.poolRole === "normal" ? null : body.poolRole;
  }
  if (body?.keepPct !== undefined) {
    const v = body.keepPct === null ? 0 : Number(body.keepPct);
    if (!Number.isInteger(v) || v < 0 || v > 100) return { error: "keepPct must be an integer from 0 to 100" };
    patch.keepPct = v || null;
  }
  if (body?.releaseBeforeHours !== undefined) {
    const v = body.releaseBeforeHours === null ? 0 : Number(body.releaseBeforeHours);
    if (!Number.isFinite(v) || v < 0 || v > MAX_RELEASE_HOURS) return { error: `releaseBeforeHours must be a number from 0 to ${MAX_RELEASE_HOURS}` };
    patch.releaseBeforeHours = v || null;
  }
  return { patch };
}

export function accountPolicy(conn) {
  const keep = Number(conn?.keepPct);
  const release = Number(conn?.releaseBeforeHours);
  return {
    role: conn?.poolRole === "reserve" ? "reserve" : "normal",
    keepPct: Number.isFinite(keep) ? Math.max(0, Math.min(100, keep)) : 0,
    releaseBeforeHours: Number.isFinite(release) ? Math.max(0, release) : 0,
  };
}

/**
 * Can this account take a request for `model` now, by its quota snapshot and policy?
 * @returns {{ ok: boolean, reason?: string, eligibleAt?: number|null, weeklyResetAt: number|null, windows: object }}
 */
export function assessAccount(conn, model, now = Date.now()) {
  const policy = accountPolicy(conn);
  const windows = getQuotaSnapshot(conn.id)?.windows || {};
  const weekly = windows["7d"];
  const weeklyResetAt = weekly?.resetAt && weekly.resetAt > now ? weekly.resetAt : null;
  const released = policy.releaseBeforeHours > 0 && weeklyResetAt !== null
    && weeklyResetAt - now <= policy.releaseBeforeHours * HOUR_MS;
  const keep = released ? 0 : policy.keepPct;

  let reason = null;
  let eligibleAt = null;
  for (const [key, w] of Object.entries(windows)) {
    if (!windowAppliesTo(key, model)) continue;
    const left = remainingPct(w, now);
    const exhausted = left <= 0;
    if (!exhausted && left >= keep) continue;
    // Blocked until this window resets, or (keep only) until the release window opens.
    let until = w.resetAt && w.resetAt > now ? w.resetAt : null;
    if (!exhausted && policy.releaseBeforeHours > 0 && weeklyResetAt) {
      const releaseAt = weeklyResetAt - policy.releaseBeforeHours * HOUR_MS;
      if (releaseAt > now && (until === null || releaseAt < until)) until = releaseAt;
    }
    if (reason === null || (until !== null && (eligibleAt === null || until > eligibleAt))) {
      reason = exhausted ? `${key} exhausted` : `${key} below keep ${keep}%`;
      eligibleAt = until;
    }
  }
  return reason === null
    ? { ok: true, weeklyResetAt, windows, policy, released }
    : { ok: false, reason, eligibleAt, weeklyResetAt, windows, policy, released };
}

/**
 * Order usable accounts. `connections` must already be filtered for locks and
 * sorted by priority (the tie-breaker).
 * @returns {{ order: Array<{conn, tier: "normal"|"reserve", assessment}>, blocked: Array<{conn, assessment}> }}
 */
export function rankResetFirst(connections, model, now = Date.now()) {
  const normal = [];
  const reserve = [];
  const blocked = [];
  connections.forEach((conn, index) => {
    const assessment = assessAccount(conn, model, now);
    if (!assessment.ok) { blocked.push({ conn, assessment }); return; }
    const entry = { conn, index, assessment };
    if (assessment.policy.role === "reserve") reserve.push(entry);
    else normal.push(entry);
  });
  // Earliest weekly reset first. Resets within the same hour count as a tie, so the
  // dashboard order decides between them. Unknown resets go after known ones.
  const bucket = (e) => e.assessment.weeklyResetAt === null ? Infinity : Math.floor(e.assessment.weeklyResetAt / HOUR_MS);
  normal.sort((a, b) => bucket(a) - bucket(b) || a.index - b.index);
  return {
    order: [
      ...normal.map((e) => ({ conn: e.conn, tier: "normal", assessment: e.assessment })),
      ...reserve.map((e) => ({ conn: e.conn, tier: "reserve", assessment: e.assessment })),
    ],
    blocked,
  };
}

/** Earliest time any blocked account becomes usable again (ms), or null if unknown. */
export function earliestEligibleAt(blocked) {
  let earliest = null;
  for (const { assessment } of blocked) {
    const t = assessment.eligibleAt;
    if (t && (earliest === null || t < earliest)) earliest = t;
  }
  return earliest;
}
