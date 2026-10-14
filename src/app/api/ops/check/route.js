import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { runChecks, DEFAULT_THRESHOLDS } from "@/lib/ops/check.js";

export const dynamic = "force-dynamic";

// GET /api/ops/check?since=15m&successWarn=0.97... — thresholded health for
// scheduled monitoring. Always 200; the verdict is in `level` (ok|warn|crit).
export const GET = opsRoute("read", async (req) => {
  const q = new URL(req.url).searchParams;
  const overrides = {};
  for (const [k, def] of Object.entries(DEFAULT_THRESHOLDS)) {
    const v = q.get(k);
    if (v == null) continue;
    if (typeof def === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw opsError(400, `invalid ${k} '${v}'`);
      overrides[k] = n;
    } else overrides[k] = v;
  }
  return runChecks(overrides);
});
