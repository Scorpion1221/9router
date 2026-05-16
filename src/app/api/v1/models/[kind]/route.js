import { buildModelsList } from "../route.js";
import { resolveModelInfo } from "@/lib/modelInfo";

// URL slug → service kind(s). `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models/{kind} - OpenAI-compatible models list filtered by capability.
 * Supported kinds: image, tts, stt, embedding, image-to-text, web.
 */
export async function GET(_request, { params }) {
  try {
    const { kind } = await params;
    const kindFilter = KIND_SLUG_MAP[kind];

    if (!kindFilter) {
      return Response.json(
        {
          error: {
            message: `Unknown model kind: ${kind}. Supported: ${Object.keys(KIND_SLUG_MAP).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const baseData = await buildModelsList(kindFilter);
    // Enrich with OpenRouter-style extension fields (context_length,
    // max_completion_tokens, pricing) — same shape as /v1/models.
    const data = await Promise.all(baseData.map(async (m) => {
      try {
        const info = await resolveModelInfo(m.id);
        if (!info) return m;
        const out = { ...m };
        if (info.contextWindow) out.context_length = info.contextWindow;
        if (info.maxOutput) out.max_completion_tokens = info.maxOutput;
        if (info.pricing) {
          const perToken = (v) => (typeof v === "number" ? (v / 1_000_000).toString() : undefined);
          const pricing = {};
          if (info.pricing.input != null) pricing.prompt = perToken(info.pricing.input);
          if (info.pricing.output != null) pricing.completion = perToken(info.pricing.output);
          if (info.pricing.image != null) pricing.image = perToken(info.pricing.image);
          if (info.pricing.cached != null) pricing.input_cache_read = perToken(info.pricing.cached);
          if (info.pricing.cache_creation != null) pricing.input_cache_write = perToken(info.pricing.cache_creation);
          if (Object.keys(pricing).length) out.pricing = pricing;
        }
        return out;
      } catch { return m; }
    }));
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models by kind:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
