import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter } from "open-sse/handlers/imageProviders/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui", "veoaifree-web"]);

function recordImageRequestUsage({ provider, model, connectionId, apiKey, endpoint, usage }) {
  if (!usage || typeof usage !== "object") return;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
      !Number.isSafeInteger(completionTokens) || completionTokens < 0) {
    return;
  }

  saveRequestUsage({
    provider,
    model,
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    tokens: usage,
    status: "success",
  }).catch(() => {});
}

// /v1/images/edits form fields sent as strings that adapters expect as numbers.
const EDIT_NUMBER_FIELDS = ["n", "output_compression", "partial_images", "frame_count", "frame_duration_ms"];
const EDIT_IMAGE_FIELDS = new Set(["image", "image[]", "images", "images[]"]);

async function fileToDataUrl(file) {
  const buf = Buffer.from(await file.arrayBuffer());
  return `data:${file.type || "image/png"};base64,${buf.toString("base64")}`;
}

// One image reference from an edits request → data/http URL string. JSON bodies use
// `{ image_url }`; `file_id` points at the client's own Files API and cannot be resolved here.
function editRefToUrl(ref) {
  if (typeof ref === "string") return ref || null;
  if (ref && typeof ref === "object") {
    if (ref.file_id) {
      const err = new Error("Image 'file_id' references are not supported; send the image or an image_url");
      err.expose = true;
      throw err;
    }
    return ref.image_url || null;
  }
  return null;
}

/**
 * Parse an OpenAI /v1/images/edits request (multipart from the SDKs, or the JSON form) into
 * the body shape image adapters read: `images: [url]`, `mask: url`, `markup: url`.
 */
async function parseImageEditBody(request) {
  const contentType = request.headers.get("content-type") || "";
  let body;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    body = { images: [] };
    for (const [key, value] of form.entries()) {
      const v = typeof value === "string" ? value : await fileToDataUrl(value);
      if (EDIT_IMAGE_FIELDS.has(key)) body.images.push(v);
      else body[key] = v;
    }
    for (const f of EDIT_NUMBER_FIELDS) {
      if (typeof body[f] === "string" && body[f] !== "") body[f] = Number(body[f]);
    }
    if (typeof body.stream === "string") body.stream = body.stream === "true";
  } else {
    body = await request.json();
    const refs = [...(Array.isArray(body.images) ? body.images : []), ...(body.image ? [body.image] : [])];
    body.images = refs.map(editRefToUrl).filter(Boolean);
    delete body.image;
    for (const f of ["mask", "markup"]) {
      if (body[f] !== undefined) body[f] = editRefToUrl(body[f]) || undefined;
    }
  }
  return body;
}

/**
 * Handle image generation request
 * @param {Request} request
 * @param {{ edit?: boolean }} [options] - edit: request came in on /v1/images/edits
 */
export async function handleImageGeneration(request, { edit = false } = {}) {
  let body;
  if (edit) {
    try {
      body = await parseImageEditBody(request);
    } catch (error) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, error?.expose ? error.message : "Invalid image edit body (expected multipart/form-data or JSON)");
    }
    if (!body.images.length) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image");
    // The gateway answers with one JSON image (or its own SSE via Accept), not OpenAI's edit event stream.
    if (body.stream === true) return errorResponse(HTTP_STATUS.BAD_REQUEST, "stream=true is not supported on /v1/images/edits");
  } else {
    try {
      body = await request.json();
    } catch {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    }
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");

  // Per-key access control: requested target, before combo expansion.
  const keyAccessDenied = await enforceKeyAccess(await getKeyAccessContext(request), modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelImage(b, m, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname, edit }),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
    });
  }

  return handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname, edit });
}

async function handleSingleModelImage(body, modelStr, { wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint, edit = false } = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  // Edits must reach an adapter that sends the source images (and mask) upstream; others
  // would silently fall back to text-to-image.
  if (edit && !getImageAdapter(provider)?.supportsEdit) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support /v1/images/edits`);
  }

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: null,
      binaryOutput,
    });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed");
  }

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Skip accounts the adapter knows cannot generate images (e.g. ChatGPT Free on codex)
    // without locking them: they stay usable for chat.
    const adapter = getImageAdapter(provider);
    if (adapter?.canUseCredentials && !adapter.canUseCredentials(refreshedCredentials)) {
      log.info("IMAGE", `[${provider}/${model}] skip connection ${credentials.connectionId.slice(0, 8)}: plan not entitled to image generation`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = lastError || "No account entitled to image generation (ChatGPT Free plans are not supported)";
      lastStatus = lastStatus || HTTP_STATUS.FORBIDDEN;
      continue;
    }

    const result = await handleImageGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onUsage: (usage) => {
        recordImageRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint,
          usage,
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // Cookies that rotate on use (Clerk `__client`) are mutated in place by
        // the executor — persist the new value so the chain does not drift.
        if (refreshedCredentials.apiKey && refreshedCredentials.apiKey !== credentials.apiKey) {
          await updateProviderCredentials(credentials.connectionId, { apiKey: refreshedCredentials.apiKey });
        }
      }
    });

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
