import { opsRoute } from "@/lib/ops/auth.js";
import { resolveAccount } from "@/lib/ops/views.js";
import { prepareReset } from "@/lib/ops/resets.js";

export const dynamic = "force-dynamic";

// POST /api/ops/accounts/:id/resets/prepare — step 1 of 2. Re-reads the account
// live and answers what a reset would refill, with warnings and a one-time code.
// Spends nothing. Needs 'admin': the code it returns can spend a reset.
export const POST = opsRoute("admin", async (_req, { params, token }) => {
  const { id } = await params;
  const res = await prepareReset(await resolveAccount(id), token);
  console.log(`[ops] '${token.name}' prepared a limit reset on ${res.account.provider}/${res.account.name} (nothing spent)`);
  return res;
});
