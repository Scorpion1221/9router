import { NextResponse } from "next/server";
import { syncOpenRouterModels } from "open-sse/services/openrouterSync.js";
import { getModelMetadataMeta } from "@/lib/db";

const log = {
  info: (tag, msg) => console.log(`[${tag}] ${msg}`),
  warn: (tag, msg) => console.warn(`[${tag}] ${msg}`),
};

/**
 * GET /api/models/sync — current cache status (fetchedAt, count)
 */
export async function GET() {
  try {
    const meta = await getModelMetadataMeta();
    return NextResponse.json(meta || { fetchedAt: null, count: 0, source: null });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

/**
 * POST /api/models/sync — trigger an immediate refresh from OpenRouter.
 */
export async function POST() {
  try {
    const result = await syncOpenRouterModels({ log });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 502 });
  }
}
