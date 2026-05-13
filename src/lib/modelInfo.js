// Shared model-info resolution.
//
// Used by:
//   - GET /v1/models/info?id={alias}/{model}    — single-model lookup (9router native shape)
//   - GET /v1/model/info                         — aggregate listing (LiteLLM-compatible shape)
//
// Both endpoints feed off the same `resolveModelInfo()` so pricing / contextWindow
// behaviour stays consistent.

import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { lookupModelMetadata } from "open-sse/services/openrouterSync.js";

export const KIND_ENDPOINT = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  imageToText: "/v1/chat/completions",
  webSearch: "/v1/search",
  webFetch: "/v1/fetch",
};

const TTS_VOICES_API = new Set(["elevenlabs", "edge-tts", "deepgram", "inworld", "local-device"]);

/**
 * Build the 9router-native info object for a single model.
 * Merges static config with OpenRouter cache (silent on miss).
 */
export async function buildInfo({ alias, providerId, model, kind, providerInfo }) {
  const out = {
    id: `${alias}/${model.id}`,
    name: model.name || model.id,
    kind,
    owned_by: alias,
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (model.params) out.params = model.params;
  if (model.capabilities) out.capabilities = model.capabilities;
  if (model.options) out.options = model.options;
  if (model.dimensions) out.dimensions = model.dimensions;
  if (model.contextWindow) out.contextWindow = model.contextWindow;
  if (kind === "tts" && TTS_VOICES_API.has(providerId)) {
    out.voicesUrl = `/v1/audio/voices?provider=${providerId}`;
  }
  if (kind === "webSearch" && providerInfo?.searchConfig) {
    const cfg = providerInfo.searchConfig;
    if (cfg.searchTypes) out.searchTypes = cfg.searchTypes;
    if (cfg.maxMaxResults) out.maxResults = cfg.maxMaxResults;
    if (cfg.requiredOptions) out.required = cfg.requiredOptions;
  }

  // Merge OpenRouter cache (best-effort, silent on miss).
  try {
    const or = await lookupModelMetadata(providerId, model.id);
    if (or) {
      if (!out.contextWindow && or.contextWindow) out.contextWindow = or.contextWindow;
      if (or.maxOutput) out.maxOutput = or.maxOutput;
      const pricing = {};
      if (or.inputPrice != null) pricing.input = or.inputPrice;
      if (or.outputPrice != null) pricing.output = or.outputPrice;
      if (or.cachedPrice != null) pricing.cached = or.cachedPrice;
      if (or.cacheWritePrice != null) pricing.cache_creation = or.cacheWritePrice;
      if (or.reasoningPrice != null) pricing.reasoning = or.reasoningPrice;
      if (or.imagePrice != null) pricing.image = or.imagePrice;
      if (Object.keys(pricing).length) {
        out.pricing = pricing;
        out.pricingSource = "openrouter";
        out.pricingModelId = or.id;
      }
    }
  } catch { /* cache miss / db not ready — silent */ }
  return out;
}

/**
 * Resolve a single full model id ("{alias}/{model}") to its info object,
 * or null if unknown to both static config and OpenRouter cache.
 */
export async function resolveModelInfo(fullId) {
  if (!fullId || !fullId.includes("/")) return null;
  const slash = fullId.indexOf("/");
  const alias = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const providerInfo = AI_PROVIDERS[providerId];

  const list = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
  const m = list.find((x) => x.id === modelId);
  if (m) {
    const kind = m.type || "llm";
    return await buildInfo({ alias, providerId, model: m, kind, providerInfo });
  }

  const subs = [
    ["tts", providerInfo?.ttsConfig],
    ["stt", providerInfo?.sttConfig],
    ["embedding", providerInfo?.embeddingConfig],
  ];
  for (const [kind, cfg] of subs) {
    const sm = cfg?.models?.find((x) => x.id === modelId);
    if (sm) return await buildInfo({ alias, providerId, model: sm, kind, providerInfo });
  }

  if (modelId === "search" && providerInfo?.searchConfig) {
    return await buildInfo({
      alias, providerId, kind: "webSearch", providerInfo,
      model: { id: "search", name: `${providerInfo.name} Search`, params: ["query", "max_results", "country", "language", "time_range", "domain_filter", "search_type"] },
    });
  }
  if (modelId === "fetch" && providerInfo?.fetchConfig) {
    return await buildInfo({
      alias, providerId, kind: "webFetch", providerInfo,
      model: { id: "fetch", name: `${providerInfo.name} Fetch`, params: ["url", "format", "max_characters"] },
    });
  }

  // Last-resort OpenRouter probe for user-added passthrough models.
  try {
    const or = await lookupModelMetadata(providerId, modelId);
    if (or) {
      return await buildInfo({
        alias, providerId, kind: "llm", providerInfo,
        model: { id: modelId, name: or.name },
      });
    }
  } catch { /* silent */ }
  return null;
}

/**
 * Convert a 9router info object into a LiteLLM-shaped entry:
 *   { model_name, litellm_params: { model }, model_info: {...} }
 *
 * Pricing in LiteLLM is per-token (USD/token). 9router's OpenRouter cache stores
 * per-token already (see openrouterSync.js — values are raw OR price strings, USD/token),
 * so they map 1:1.
 *
 * Mode mapping:
 *   llm / imageToText -> "chat"
 *   embedding         -> "embedding"
 *   image             -> "image_generation"
 *   tts               -> "audio_speech"
 *   stt               -> "audio_transcription"
 *   webSearch         -> "search"  (LiteLLM has no canonical mode, use sentinel)
 *   webFetch          -> "fetch"
 */
const KIND_TO_LITELLM_MODE = {
  llm: "chat",
  imageToText: "chat",
  embedding: "embedding",
  image: "image_generation",
  tts: "audio_speech",
  stt: "audio_transcription",
  webSearch: "search",
  webFetch: "fetch",
};

export function toLiteLLMEntry(info) {
  if (!info) return null;
  // 9router stores pricing as USD per *million* tokens (see openrouterSync.js
  // `priceToPerMillion`). LiteLLM's protocol expects USD per *single* token,
  // so divide here at the boundary.
  const perToken = (v) => (typeof v === "number" ? v / 1_000_000 : undefined);
  const mi = {
    id: info.id,
    mode: KIND_TO_LITELLM_MODE[info.kind] || "chat",
  };
  if (info.contextWindow) {
    mi.max_tokens = info.contextWindow;
    mi.max_input_tokens = info.contextWindow;
  }
  if (info.maxOutput) mi.max_output_tokens = info.maxOutput;
  if (info.pricing) {
    if (info.pricing.input != null) mi.input_cost_per_token = perToken(info.pricing.input);
    if (info.pricing.output != null) mi.output_cost_per_token = perToken(info.pricing.output);
    if (info.pricing.cached != null) mi.cache_read_input_token_cost = perToken(info.pricing.cached);
    if (info.pricing.cache_creation != null) mi.cache_creation_input_token_cost = perToken(info.pricing.cache_creation);
    if (info.pricing.image != null) mi.input_cost_per_image = perToken(info.pricing.image);
  }
  if (info.pricingSource) mi.pricing_source = info.pricingSource;
  if (info.dimensions) mi.output_vector_size = info.dimensions;
  mi.litellm_provider = info.owned_by;
  mi.endpoint = info.endpoint;
  return {
    model_name: info.id,
    litellm_params: { model: info.id },
    model_info: mi,
  };
}
