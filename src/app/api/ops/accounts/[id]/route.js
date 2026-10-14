import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { resolveAccount, publicConnection } from "@/lib/ops/views.js";
import { updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { parsePolicyPatch, POLICY_FIELDS } from "open-sse/services/resetFirst.js";
import { isQuotaProvider } from "open-sse/services/quotaState.js";

export const dynamic = "force-dynamic";

// PATCH /api/ops/accounts/:id — selection policy of one account (reset-first):
// { poolRole: "normal"|"reserve", keepPct: 0-100, releaseBeforeHours: 0-168 }.
// Only these fields; null resets one to its default. Locks and tokens are untouched.
export const PATCH = opsRoute("operate", async (req, { params, token }) => {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw opsError(400, "body must be a JSON object");
  const unknown = Object.keys(body).filter((k) => !POLICY_FIELDS.includes(k));
  if (unknown.length) throw opsError(400, `unknown field(s): ${unknown.join(", ")} (allowed: ${POLICY_FIELDS.join(", ")})`);
  const { patch, error } = parsePolicyPatch(body);
  if (error) throw opsError(400, error);
  if (!Object.keys(patch).length) throw opsError(400, `nothing to change (send one of ${POLICY_FIELDS.join(", ")})`);

  const conn = await resolveAccount(id);
  if (!isQuotaProvider(conn.provider)) throw opsError(400, `selection policy applies to claude and codex accounts, not ${conn.provider}`);
  const before = publicConnection(conn);
  const updated = await updateProviderConnection(conn.id, patch);
  const after = publicConnection(updated);
  const changed = {};
  for (const k of POLICY_FIELDS) if (before[k] !== after[k]) changed[k] = { from: before[k], to: after[k] };
  console.log(`[ops] '${token.name}' set policy of ${after.name}: ${Object.keys(changed).join(", ") || "no change"}`);
  return { account: after, changed };
});
