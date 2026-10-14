import { opsRoute } from "@/lib/ops/auth.js";
import { usageBreakdown } from "@/lib/ops/views.js";

export const dynamic = "force-dynamic";

// GET /api/ops/usage?since=24h&by=model|key|key,model — which client calls what.
export const GET = opsRoute("read", async (req) => {
  const q = new URL(req.url).searchParams;
  const since = q.get("since") || "24h";
  return { since, rows: await usageBreakdown({ since, by: q.get("by") || "model", model: q.get("model") || undefined }) };
});
