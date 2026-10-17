import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { getAccountResets, supportsResets } from "@/lib/ops/resets.js";

export const dynamic = "force-dynamic";

// GET /api/providers/:id/resets — one Claude/Codex account's limit resets for the
// dashboard connection list: how many are left, what they refill, use-by dates.
// Read-only (same view as `9r resets show`); behind the dashboard session.
export async function GET(_request, { params }) {
  const { id } = await params;
  const conn = await getProviderConnectionById(id);
  if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  if (!supportsResets(conn)) return NextResponse.json({ error: "Limit resets exist for Claude OAuth and Codex accounts only" }, { status: 400 });
  try {
    return NextResponse.json(await getAccountResets(conn));
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to read resets" }, { status: error.status || 500 });
  }
}
