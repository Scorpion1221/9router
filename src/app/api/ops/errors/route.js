import { opsRoute } from "@/lib/ops/auth.js";
import { attemptErrors } from "@/lib/ops/views.js";

export const dynamic = "force-dynamic";

// GET /api/ops/errors?since=1h — failed upstream attempts by provider and error class.
export const GET = opsRoute("read", async (req) => {
  const since = new URL(req.url).searchParams.get("since") || "1h";
  return { since, rows: await attemptErrors({ since }) };
});
