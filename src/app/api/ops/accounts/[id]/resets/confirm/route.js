import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { resolveAccount } from "@/lib/ops/views.js";
import { maskName } from "@/lib/ops/redact.js";
import { confirmReset } from "@/lib/ops/resets.js";

export const dynamic = "force-dynamic";

// POST /api/ops/accounts/:id/resets/confirm { code } — step 2 of 2: spends the
// reset prepared in step 1 (irreversible). Same token as prepare, within 5 minutes.
export const POST = opsRoute("admin", async (req, { params, token }) => {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw opsError(400, "body must be a JSON object");
  const unknown = Object.keys(body).filter((k) => k !== "code");
  if (unknown.length) throw opsError(400, `unknown field(s): ${unknown.join(", ")} (allowed: code)`);
  if (typeof body.code !== "string" || !body.code) throw opsError(400, "code is required (from prepare)");
  const conn = await resolveAccount(id);
  console.log(`[ops] '${token.name}' confirming a limit reset on ${conn.provider}/${maskName(conn.name || conn.email || conn.id)}`);
  const res = await confirmReset(conn, token, body.code);
  console.log(`[ops] '${token.name}' limit reset on ${res.account.provider}/${res.account.name}: ${res.outcome} (spent: ${res.spent})`);
  return res;
});
