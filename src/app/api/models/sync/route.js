import { NextResponse } from "next/server";
import { syncOpenRouterModels, startOpenRouterSyncScheduler } from "open-sse/services/openrouterSync.js";
import { getModelMetadataMeta } from "@/lib/db";

const log = {
  info: (tag, msg) => console.log(`[${tag}] ${msg}`),
  warn: (tag, msg) => console.warn(`[${tag}] ${msg}`),
};

// Lazy-boot the scheduler on first request to this route. The scheduler is
// idempotent, so subsequent calls are no-ops. This sidesteps the Next.js
// standalone-build instrumentation.js gotcha (user instrumentation isn't
// always copied into .next/standalone reliably).
let _booted = false;
function ensureScheduler() {
  if (_booted) return;
  _booted = true;
  startOpenRouterSyncScheduler({ log });
}

/**
 * GET /api/models/sync — current cache status (fetchedAt, count)
 */
export async function GET() {
  ensureScheduler();
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
  ensureScheduler();
  try {
    const result = await syncOpenRouterModels({ log });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err.message || err) }, { status: 502 });
  }
}
