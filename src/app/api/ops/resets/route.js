import { opsRoute } from "@/lib/ops/auth.js";
import { listResets } from "@/lib/ops/resets.js";

export const dynamic = "force-dynamic";

// GET /api/ops/resets?provider=claude|codex — limit resets left on every active
// Claude / Codex account. Read-only; uses the cached usage reads.
export const GET = opsRoute("read", async (req) => {
  const provider = new URL(req.url).searchParams.get("provider") || null;
  return { accounts: await listResets({ provider }) };
});
