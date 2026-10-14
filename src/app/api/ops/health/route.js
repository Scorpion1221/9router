import { opsRoute } from "@/lib/ops/auth.js";
import { healthSummary } from "@/lib/ops/views.js";

export const dynamic = "force-dynamic";
const BY = { hour: "hour", model: "model", key: "keyName", error: "errorType", status: "status" };

// GET /api/ops/health?since=24h&by=hour|model|key|error|status — client-visible outcomes.
export const GET = opsRoute("read", async (req) => {
  const q = new URL(req.url).searchParams;
  const by = q.get("by");
  const res = await healthSummary({ since: q.get("since") || "1h", groupBy: by ? (BY[by] ?? by) : null });
  return { since: new Date(res.since).toISOString(), rows: res.rows };
});
