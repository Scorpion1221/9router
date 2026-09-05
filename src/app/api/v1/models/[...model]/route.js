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

const LLM_KIND = "llm";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function json(data, options = {}) {
  return Response.json(data, {
    ...options,
    headers: {
      "Access-Control-Allow-Origin": "*",
      ...options.headers,
    },
  });
}

/**
 * GET /v1/models/{kind} - OpenAI-compatible models list filtered by capability.
 * GET /v1/models/{provider}/{model} - OpenAI-compatible single model lookup.
 * Supported kinds: image, tts, stt, embedding, image-to-text, web.
 */
export async function GET(_request, { params }) {
  try {
    const { model } = await params;
    const path = Array.isArray(model) ? model : [model];
    const identifier = path.filter(Boolean).join("/");
    const kindFilter = path.length === 1 ? KIND_SLUG_MAP[identifier] : null;

    if (kindFilter) {
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
      return json({ object: "list", data });
    }

    // Match the same LLM catalog exposed by GET /v1/models. A catch-all
    // parameter is required because provider-prefixed IDs contain a slash.
    const models = await buildModelsList([LLM_KIND]);
    const matchedModel = models.find((candidate) => candidate.id === identifier);

    if (!matchedModel) {
      return json(
        {
          error: {
            message: `The model '${identifier}' does not exist or you do not have access to it.`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        { status: 404 },
      );
    }

    return json(matchedModel);
  } catch (error) {
    console.log("Error fetching model:", error);
    return json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 },
    );
  }
}
