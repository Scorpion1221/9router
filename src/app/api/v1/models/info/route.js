import { resolveModelInfo } from "@/lib/modelInfo";
import { getKeyAccessContext, filterModelsListForKey } from "@/sse/services/keyAccess.js";
import { buildModelsList } from "../route.js";
import { startOpenRouterSyncScheduler } from "open-sse/services/openrouterSync.js";

const ALL_KINDS = ["llm", "image", "tts", "stt", "embedding", "imageToText", "webSearch", "webFetch"];

// Lazy-boot the OpenRouter sync scheduler the first time any model info is
// requested. Idempotent — subsequent calls return immediately.
let _booted = false;
function ensureScheduler() {
  if (_booted) return;
  _booted = true;
  startOpenRouterSyncScheduler({
    log: {
      info: (tag, msg) => console.log(`[${tag}] ${msg}`),
      warn: (tag, msg) => console.warn(`[${tag}] ${msg}`),
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/models/info?id={alias}/{modelId} — metadata for a single model
export async function GET(request) {
  ensureScheduler();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const kind = searchParams.get("kind");
  if (!id) {
    return Response.json(
      { error: { message: "Missing required query param: id (e.g. ?id=openai/dall-e-3)", type: "invalid_request_error" } },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  // Per-key access control: a restricted key gets 404 for models it may not call.
  const keyAccess = await getKeyAccessContext(request);
  const allowed = !keyAccess
    || (await filterModelsListForKey(keyAccess, await buildModelsList(ALL_KINDS))).some((m) => m.id === id);
  const info = allowed ? await resolveModelInfo(id, kind) : null;
  if (!info) {
    return Response.json(
      { error: { message: `Model not found: ${id}`, type: "not_found" } },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  return Response.json(info, { headers: { "Access-Control-Allow-Origin": "*" } });
}
