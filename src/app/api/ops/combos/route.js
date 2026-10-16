import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { listCombosAdmin, createComboAdmin } from "@/lib/ops/combosAdmin.js";

export const dynamic = "force-dynamic";

const CREATE_FIELDS = ["name", "models", "kind", "strategy"];

// GET /api/ops/combos — combo names, kind, strategy and member chain.
export const GET = opsRoute("read", async () => ({ combos: await listCombosAdmin() }));

// POST /api/ops/combos — create { name, models[], kind?, strategy? }. Needs 'admin':
// a restricted API key that lists a combo can call all of its members, so combo
// writes change what those keys reach.
export const POST = opsRoute("admin", async (req, { token }) => {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw opsError(400, "body must be a JSON object");
  const unknown = Object.keys(body).filter((k) => !CREATE_FIELDS.includes(k));
  if (unknown.length) throw opsError(400, `unknown field(s): ${unknown.join(", ")} (allowed: ${CREATE_FIELDS.join(", ")})`);
  const combo = await createComboAdmin(body);
  console.log(`[ops] '${token.name}' created combo ${combo.name} (${combo.models.length} models)`);
  return { combo };
});
