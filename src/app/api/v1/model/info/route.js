// GET /v1/model/info — LiteLLM-compatible aggregate model info.
//
// Mirrors LiteLLM's `/v1/model/info` shape:
//   { data: [{ model_name, litellm_params: {model}, model_info: {...} }] }
//
// Reuses `buildModelsList()` for the id list (so disabled models, custom
// models, combos, and active-connection filtering all behave the same as
// `/v1/models`) and `resolveModelInfo()` for per-model metadata + pricing.
//
// Optional query params:
//   ?kind=llm|image|tts|stt|embedding|imageToText|webSearch|webFetch
//        Filter to a single service kind. Default: all kinds.
//   ?model=<full_id>
//        Skip the listing step and return info for one specific model.

import { buildModelsList } from "../../models/route.js";
import { resolveModelInfo, toLiteLLMEntry } from "@/lib/modelInfo";
import { startOpenRouterSyncScheduler } from "open-sse/services/openrouterSync.js";

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

const ALL_KINDS = ["llm", "image", "tts", "stt", "embedding", "imageToText", "webSearch", "webFetch"];

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request) {
  ensureScheduler();
  try {
    const { searchParams } = new URL(request.url);
    const singleModel = searchParams.get("model");

    if (singleModel) {
      const info = await resolveModelInfo(singleModel);
      if (!info) {
        return Response.json(
          { error: { message: `Model not found: ${singleModel}`, type: "not_found" } },
          { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }
      return Response.json(
        { data: [toLiteLLMEntry(info)] },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const kindParam = searchParams.get("kind");
    const kindFilter = kindParam
      ? (ALL_KINDS.includes(kindParam) ? [kindParam] : null)
      : ALL_KINDS;

    if (!kindFilter) {
      return Response.json(
        { error: { message: `Unknown kind: ${kindParam}. Supported: ${ALL_KINDS.join(", ")}`, type: "invalid_request_error" } },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const list = await buildModelsList(kindFilter);

    // Resolve in parallel — each lookup is a cheap kv hit; most pages have <200 models.
    const entries = await Promise.all(
      list.map(async (m) => {
        const info = await resolveModelInfo(m.id);
        if (!info) {
          // Static config / OR cache both missed — emit a minimal entry so the
          // model still shows up. Useful for user-added passthrough models.
          return {
            model_name: m.id,
            litellm_params: { model: m.id },
            model_info: {
              id: m.id,
              mode: m.kind === "webSearch" ? "search"
                : m.kind === "webFetch" ? "fetch"
                : "chat",
              litellm_provider: m.owned_by,
            },
          };
        }
        return toLiteLLMEntry(info);
      }),
    );

    return Response.json(
      { data: entries.filter(Boolean) },
      { headers: { "Access-Control-Allow-Origin": "*" } },
    );
  } catch (error) {
    console.log("Error building /v1/model/info:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 },
    );
  }
}
