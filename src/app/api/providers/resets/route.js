import { NextResponse } from "next/server";
import { listResets } from "@/lib/ops/resets.js";

export const dynamic = "force-dynamic";

// GET /api/providers/resets?provider=claude|codex — resets left per account, for
// the counts on the dashboard connection list. Read-only, cached usage reads (same
// view as `9r resets`); behind the dashboard session.
export async function GET(request) {
  const provider = new URL(request.url).searchParams.get("provider");
  if (provider !== "claude" && provider !== "codex") {
    return NextResponse.json({ error: "provider must be claude or codex" }, { status: 400 });
  }
  try {
    const rows = await listResets({ provider });
    return NextResponse.json({
      accounts: rows.map((r) => ({ id: r.account.id, available: r.available ?? null, useBy: r.useBy || null, readable: r.readable !== false })),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to read resets" }, { status: error.status || 500 });
  }
}
