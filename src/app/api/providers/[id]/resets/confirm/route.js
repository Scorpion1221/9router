import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { confirmReset } from "@/lib/ops/resets.js";
import { DASHBOARD_RESET_ACTOR } from "../actor.js";

export const dynamic = "force-dynamic";

// POST /api/providers/:id/resets/confirm { code } — step 2 of 2: spends the reset
// prepared in step 1 (irreversible). An attempt without a definite answer returns
// "uncertain" with the same code; retrying it checks before anything is resent.
export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.code !== "string" || !body.code) {
    return NextResponse.json({ error: "code is required (from prepare)" }, { status: 400 });
  }
  const conn = await getProviderConnectionById(id);
  if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  try {
    const res = await confirmReset(conn, DASHBOARD_RESET_ACTOR, body.code);
    console.log(`[dashboard] limit reset on ${res.account.provider}/${res.account.name}: ${res.outcome} (spent: ${res.spent})`);
    return NextResponse.json(res);
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to confirm the reset" }, { status: error.status || 500 });
  }
}
