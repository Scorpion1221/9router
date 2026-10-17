import { opsRoute } from "@/lib/ops/auth.js";
import { resolveAccount } from "@/lib/ops/views.js";
import { getAccountResets } from "@/lib/ops/resets.js";

export const dynamic = "force-dynamic";

// GET /api/ops/accounts/:id/resets — one account's limit resets: how many are
// left, what they refill, use-by dates and whether one is usable now. Read-only.
export const GET = opsRoute("read", async (_req, { params }) => {
  const { id } = await params;
  return getAccountResets(await resolveAccount(id));
});
