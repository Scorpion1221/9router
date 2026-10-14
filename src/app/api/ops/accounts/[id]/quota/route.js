import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { scopeAllows } from "@/lib/db/repos/opsTokensRepo.js";
import { getConnectionQuota } from "@/lib/ops/quota.js";
import { resolveAccount } from "@/lib/ops/views.js";
import { maskName } from "@/lib/ops/redact.js";

export const dynamic = "force-dynamic";

// GET /api/ops/accounts/:id/quota?force=1 — :id is the connection id or its name.
// force=1 skips the provider-side usage cache and hits the upstream account
// directly, so it needs 'operate'; read tokens get the cached view.
export const GET = opsRoute("read", async (req, { params, token }) => {
  const { id } = await params;
  const conn = await resolveAccount(id);
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (force && !scopeAllows(token.scope, "operate")) throw opsError(403, "--refresh needs an 'operate' token (it calls the upstream account directly)");
  const quota = await getConnectionQuota(conn.id, { force });
  return { account: { id: conn.id, name: maskName(conn.name || conn.email || conn.id), provider: conn.provider }, ...quota };
});
