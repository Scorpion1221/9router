import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { listOpsTokens, createOpsToken, revokeOpsToken, OPS_SCOPES } from "@/lib/db/repos/opsTokensRepo.js";

export const dynamic = "force-dynamic";

// GET /api/ops/tokens — list ops tokens (metadata only; admin).
export const GET = opsRoute("admin", async () => ({ tokens: await listOpsTokens() }));

// POST /api/ops/tokens {name, scope, expiresAt?} — returns the token once (admin).
export const POST = opsRoute("admin", async (req) => {
  const body = await req.json().catch(() => null);
  if (!body?.name) throw opsError(400, "name is required");
  if (body.scope && !OPS_SCOPES.includes(body.scope)) throw opsError(400, `scope must be one of ${OPS_SCOPES.join(", ")}`);
  try {
    const { token, record } = await createOpsToken({ name: body.name, scope: body.scope || "read", expiresAt: body.expiresAt || null });
    return { token, record };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw opsError(409, "token collision, retry");
    if (e.code === "NAME_TAKEN") throw opsError(409, e.message);
    throw opsError(400, e.message);
  }
});

// DELETE /api/ops/tokens?id=<id or name> — revoke (admin). Idempotent.
export const DELETE = opsRoute("admin", async (req, { token: caller }) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw opsError(400, "id is required");
  const res = await revokeOpsToken(id);
  if (!res.found) throw opsError(404, `no token '${id}'`);
  if (res.ambiguous) throw opsError(409, `'${id}' matches ${res.ambiguous} active tokens; use the id`);
  return { revoked: res.record.name, alreadyRevoked: res.alreadyRevoked, self: res.record.id === caller.id };
});
