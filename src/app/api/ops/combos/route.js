import { opsRoute } from "@/lib/ops/auth.js";
import { listCombos } from "@/lib/ops/views.js";

export const dynamic = "force-dynamic";

// GET /api/ops/combos — combo names, strategy and member chain.
export const GET = opsRoute("read", async () => ({ combos: await listCombos() }));
