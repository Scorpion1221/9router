import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { prepareReset } from "@/lib/ops/resets.js";
import { DASHBOARD_RESET_ACTOR } from "../actor.js";

export const dynamic = "force-dynamic";

// POST /api/providers/:id/resets/prepare — step 1 of 2 for the dashboard reset
// button. Re-reads the account live, refuses a reset that would not apply or
// help, and returns what it would refill, warnings and a one-time code.
// Spends nothing. Same checks and double-spend protection as `9r resets use`.
export async function POST(_request, { params }) {
  const { id } = await params;
  const conn = await getProviderConnectionById(id);
  if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  try {
    const res = await prepareReset(conn, DASHBOARD_RESET_ACTOR);
    console.log(`[dashboard] prepared a limit reset on ${res.account.provider}/${res.account.name} (nothing spent)`);
    return NextResponse.json(res);
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to check the reset" }, { status: error.status || 500 });
  }
}
