import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { providerPoolView } from "@/lib/ops/poolView.js";

export const dynamic = "force-dynamic";

// GET /api/ops/quota?provider=claude[&model=claude-opus-5-5] — live quota of every
// account of a provider, its selection policy, and the order the gateway uses them.
// Reads the gateway's in-memory quota state only; never calls upstream.
export const GET = opsRoute("read", async (req) => {
  const q = new URL(req.url).searchParams;
  const provider = q.get("provider");
  if (!provider) throw opsError(400, "provider is required (claude or codex)");
  return providerPoolView(provider, { model: q.get("model") || null });
});
