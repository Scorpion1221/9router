import { NextResponse } from "next/server";
import { listOpsTokens, createOpsToken, revokeOpsToken, OPS_SCOPES } from "@/lib/db/repos/opsTokensRepo.js";

export const dynamic = "force-dynamic";

// Dashboard management of ops tokens (behind the normal dashboard auth in
// dashboardGuard, like the rest of /api/settings). This is how the first token
// is issued; after that `9r token` can manage them with an admin token.

export async function GET() {
  return NextResponse.json({ tokens: await listOpsTokens(), scopes: OPS_SCOPES });
}

export async function POST(request) {
  const body = await request.json().catch(() => null);
  try {
    const { token, record } = await createOpsToken({ name: body?.name, scope: body?.scope || "read", expiresAt: body?.expiresAt || null });
    return NextResponse.json({ token, record }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: e.code === "NAME_TAKEN" ? 409 : 400 });
  }
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const res = await revokeOpsToken(id);
  if (!res.found) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (res.ambiguous) return NextResponse.json({ error: "ambiguous name; use the id" }, { status: 409 });
  return NextResponse.json({ revoked: res.record.name, alreadyRevoked: res.alreadyRevoked });
}
