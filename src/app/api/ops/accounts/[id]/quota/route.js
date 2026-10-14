import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { scopeAllows } from "@/lib/db/repos/opsTokensRepo.js";
import { getConnectionQuota } from "@/lib/ops/quota.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { maskName } from "@/lib/ops/redact.js";

export const dynamic = "force-dynamic";

// GET /api/ops/accounts/:id/quota?force=1 — :id is the connection id or its name.
// force=1 skips the provider-side usage cache and hits the upstream account
// directly, so it needs 'operate'; read tokens get the cached view.
export const GET = opsRoute("read", async (req, { params, token }) => {
  const { id } = await params;
  const conns = await getProviderConnections({});
  const matches = conns.filter((c) => c.id === id || c.name === id || c.email === id || maskName(c.name) === id);
  if (matches.length === 0) throw opsError(404, `no account '${id}'`);
  if (matches.length > 1) throw opsError(409, `'${id}' matches ${matches.length} accounts; use the id`);
  const conn = matches[0];
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (force && !scopeAllows(token.scope, "operate")) throw opsError(403, "--refresh needs an 'operate' token (it calls the upstream account directly)");
  const quota = await getConnectionQuota(conn.id, { force });
  return { account: { id: conn.id, name: maskName(conn.name || conn.email || conn.id), provider: conn.provider }, ...quota };
});
