import { opsRoute, opsError } from "@/lib/ops/auth.js";
import { getComboAdmin, updateComboAdmin, deleteComboAdmin } from "@/lib/ops/combosAdmin.js";

export const dynamic = "force-dynamic";

const UPDATE_FIELDS = ["name", "models", "kind", "strategy"];

// GET /api/ops/combos/:id — one combo by id or name, plus the API keys that allow it.
export const GET = opsRoute("read", async (_req, { params }) => {
  const { id } = await params;
  return { combo: await getComboAdmin(id) };
});

// PATCH /api/ops/combos/:id — change name / models / kind / strategy. Needs 'admin'
// (see POST /api/ops/combos).
export const PATCH = opsRoute("admin", async (req, { params, token }) => {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw opsError(400, "body must be a JSON object");
  const unknown = Object.keys(body).filter((k) => !UPDATE_FIELDS.includes(k));
  if (unknown.length) throw opsError(400, `unknown field(s): ${unknown.join(", ")} (allowed: ${UPDATE_FIELDS.join(", ")})`);
  if (!Object.keys(body).length) throw opsError(400, `nothing to change (send one of ${UPDATE_FIELDS.join(", ")})`);
  const res = await updateComboAdmin(id, body);
  console.log(`[ops] '${token.name}' updated combo ${res.combo.name}: ${Object.keys(res.changed).join(", ") || "no change"}`);
  return res;
});

// DELETE /api/ops/combos/:id — needs 'admin'. Idempotent: an
// already-deleted combo answers 200 with alreadyGone.
export const DELETE = opsRoute("admin", async (_req, { params, token }) => {
  const { id } = await params;
  const res = await deleteComboAdmin(id);
  if (res.deleted) console.log(`[ops] '${token.name}' deleted combo ${res.deleted}`);
  return res;
});
