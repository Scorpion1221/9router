import { opsRoute } from "@/lib/ops/auth.js";

export const dynamic = "force-dynamic";

// GET /api/ops/whoami — the presented token's name and scope (connection check).
export const GET = opsRoute("read", async (_req, { token }) => ({
  token: { name: token.name, scope: token.scope, prefix: token.prefix, expiresAt: token.expiresAt },
}));
