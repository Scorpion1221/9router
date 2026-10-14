import { opsRoute } from "@/lib/ops/auth.js";
import { listKeys } from "@/lib/ops/views.js";

export const dynamic = "force-dynamic";

// GET /api/ops/keys — inference key names and access restrictions (never the key).
export const GET = opsRoute("read", async () => ({ keys: await listKeys() }));
