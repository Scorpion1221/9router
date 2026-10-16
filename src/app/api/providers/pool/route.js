import { NextResponse } from "next/server";
import { providerPoolView } from "@/lib/ops/poolView.js";
import { isQuotaProvider } from "open-sse/services/quotaState.js";

export const dynamic = "force-dynamic";

// GET /api/providers/pool?provider=claude — the gateway's account order and live
// quota for the dashboard connection list. Same view as /api/ops/quota, behind the
// dashboard session (/api/providers is cookie-protected) instead of an ops token.
// Reads in-memory state only; never calls upstream.
export async function GET(request) {
  const provider = new URL(request.url).searchParams.get("provider");
  if (!provider || !isQuotaProvider(provider)) {
    return NextResponse.json({ error: "provider must be claude or codex" }, { status: 400 });
  }
  try {
    return NextResponse.json(await providerPoolView(provider));
  } catch (error) {
    console.log("Error building provider pool view:", error?.message || error);
    return NextResponse.json({ error: "Failed to load pool" }, { status: 500 });
  }
}
