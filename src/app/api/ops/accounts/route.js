import { opsRoute } from "@/lib/ops/auth.js";
import { listAccounts } from "@/lib/ops/views.js";

export const dynamic = "force-dynamic";

// GET /api/ops/accounts?provider=claude&since=1h — pool state per upstream account.
export const GET = opsRoute("read", async (req) => {
  const q = new URL(req.url).searchParams;
  return { accounts: await listAccounts({ provider: q.get("provider") || undefined, since: q.get("since") || "1h", withLastOk: true }) };
});
