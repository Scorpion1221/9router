import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { checkAndRefreshToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { clearAccountError } from "@/sse/services/auth";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import * as log from "@/sse/utils/logger";

const CLI_TOKEN_SALT = "9r-cli-auth";

/**
 * Build credentials object for a specific connection (mirrors auth.js:getProviderCredentials
 * structure), so we can bypass routing and force the test through this exact connection.
 */
async function buildCredentialsForConnection(connection) {
  const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  return {
    apiKey: connection.apiKey,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    projectId: connection.projectId,
    connectionName: connection.displayName || connection.name || connection.email || connection.id,
    copilotToken: connection.providerSpecificData?.copilotToken,
    providerSpecificData: {
      ...(connection.providerSpecificData || {}),
      connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
      connectionProxyUrl: resolvedProxy.connectionProxyUrl,
      connectionNoProxy: resolvedProxy.connectionNoProxy,
      connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
      vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
    },
    connectionId: connection.id,
    testStatus: connection.testStatus,
    lastError: connection.lastError,
  };
}

/**
 * Direct (connection-locked) test path — calls the appropriate core handler with credentials
 * for the SPECIFIC connection, completely bypassing routing. Used by dashboard "Test model"
 * buttons that are scoped to one connection card.
 *
 * Returns the NextResponse to send back.
 */
async function runDirectTest({ connectionId, model, kind }) {
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) {
    return NextResponse.json({ ok: false, error: "Connection not found" }, { status: 404 });
  }

  // Strip provider prefix if present — core handlers expect bare model id + modelInfo.provider.
  const bareModel = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  const provider = connection.provider;
  const modelInfo = { provider, model: bareModel };

  const credentials = await checkAndRefreshToken(provider, await buildCredentialsForConnection(connection));

  const start = Date.now();

  try {
    let result;
    if (kind === "embedding") {
      result = await handleEmbeddingsCore({
        body: { model: `${provider}/${bareModel}`, input: "test" },
        modelInfo,
        credentials,
        log,
        onCredentialsRefreshed: async (newCreds) => updateProviderCredentials(connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        }),
        onRequestSuccess: async () => clearAccountError(connectionId, credentials, bareModel),
      });
    } else if (kind === "image") {
      result = await handleImageGenerationCore({
        body: { model: `${provider}/${bareModel}`, prompt: "a small red dot", n: 1, size: "1024x1024" },
        modelInfo,
        credentials,
        log,
        binaryOutput: false,
        onCredentialsRefreshed: async (newCreds) => updateProviderCredentials(connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        }),
        onRequestSuccess: async () => clearAccountError(connectionId, credentials, bareModel),
      });
    } else if (kind === "tts") {
      // For TTS the "model" id from the Models card is the raw OpenAI model name
      // (tts-1, tts-1-hd, gpt-4o-mini-tts). The OpenAI TTS adapter accepts that
      // single-segment form and picks a default voice. Other providers' adapters
      // also tolerate model-only input. Synthesize one short string and verify
      // we got binary audio back.
      result = await handleTtsCore({
        provider,
        model: bareModel,
        input: "test",
        credentials,
        responseFormat: "mp3",
        language: "",
      });
    } else if (kind === "stt") {
      // STT requires a real audio file to round-trip — there's no cheap ping. Tell
      // the user to use the Speech-to-Text Example card with a sample file instead.
      return NextResponse.json({
        ok: false,
        status: 400,
        error: "STT ping not supported — use the Speech-to-Text Example card with an audio file.",
      });
    } else {
      // chat
      result = await handleChatCore({
        body: { model: `${provider}/${bareModel}`, max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }] },
        modelInfo,
        credentials,
        connectionId,
        apiKey: null,
        log,
        onCredentialsRefreshed: async (newCreds) => updateProviderCredentials(connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        }),
        onRequestSuccess: async () => clearAccountError(connectionId, credentials, bareModel),
      });
    }

    const latencyMs = Date.now() - start;

    if (!result || result.success === false || result.success === undefined && !result.response) {
      const status = result?.status || 502;
      const errMsg = result?.error || "Unknown error";
      return NextResponse.json({ ok: false, latencyMs, status, error: `HTTP ${status}: ${String(errMsg).slice(0, 240)}` });
    }

    // result.response is a Response object — read body to validate
    const resp = result.response;
    const status = resp.status;
    const respCType = resp.headers?.get?.("content-type") || "";

    // For binary responses (TTS audio), don't try to JSON-parse.
    const isBinary = respCType.startsWith("audio/") || respCType.startsWith("image/") || respCType === "application/octet-stream";
    let rawText = "";
    let parsed = null;
    let bodySize = 0;
    if (isBinary) {
      const buf = await resp.arrayBuffer().catch(() => null);
      bodySize = buf?.byteLength || 0;
    } else {
      rawText = await resp.text().catch(() => "");
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}
      bodySize = rawText.length;
    }

    if (status >= 400) {
      const detail = parsed?.error?.message || parsed?.error || rawText;
      return NextResponse.json({ ok: false, latencyMs, status, error: `HTTP ${status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}` });
    }

    // Validate shape per kind
    if (kind === "embedding") {
      const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
      if (!hasEmbedding) return NextResponse.json({ ok: false, latencyMs, status, error: "Provider returned no embedding data" });
    } else if (kind === "image") {
      const hasImage = Array.isArray(parsed?.data) && parsed.data.length > 0 && (parsed.data[0]?.url || parsed.data[0]?.b64_json);
      if (!hasImage) return NextResponse.json({ ok: false, latencyMs, status, error: "Provider returned no image data" });
    } else if (kind === "tts") {
      // Accept either binary audio (>= 100 bytes) or a JSON envelope { audio, format }.
      const okBinary = isBinary && bodySize >= 100;
      const okJson = !isBinary && parsed?.audio && typeof parsed.audio === "string";
      if (!okBinary && !okJson) return NextResponse.json({ ok: false, latencyMs, status, error: "Provider returned no audio data" });
    } else {
      const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
      if (!hasChoices) return NextResponse.json({ ok: false, latencyMs, status, error: "Provider returned no completion choices" });
    }

    return NextResponse.json({ ok: true, latencyMs, error: null, status });
  } catch (err) {
    return NextResponse.json({ ok: false, latencyMs: Date.now() - start, error: err.message }, { status: 500 });
  }
}

// POST /api/models/test - Ping a single model
// Body: { model: "prefix/id", kind?: "chat"|"embedding"|"image", connectionId?: string }
//   - If connectionId provided: directly test that connection (bypasses routing). Used by
//     dashboard model-card test buttons which are scoped to one connection.
//   - Otherwise: fall back to internal /v1/* fetch which uses routing (legacy behavior).
export async function POST(request) {
  try {
    const { model, kind, connectionId } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });

    if (connectionId) {
      return await runDirectTest({ connectionId, model, kind });
    }

    // Legacy: route through internal /v1/* (uses global routing)
    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    let apiKey = null;
    try {
      const keys = await getApiKeys();
      apiKey = keys.find((k) => k.isActive !== false)?.key || null;
    } catch {}

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);

    const start = Date.now();

    if (kind === "embedding") {
      const res = await fetch(`${baseUrl}/api/v1/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: "test" }),
        signal: AbortSignal.timeout(15000),
      });
      const latencyMs = Date.now() - start;
      const rawText = await res.text().catch(() => "");
      let parsed = null;
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

      if (!res.ok) {
        const detail = parsed?.error?.message || parsed?.error || rawText;
        return NextResponse.json({ ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status });
      }
      const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
      if (!hasEmbedding) {
        return NextResponse.json({ ok: false, latencyMs, status: res.status, error: "Provider returned no embedding data" });
      }
      return NextResponse.json({ ok: true, latencyMs, error: null, status: res.status });
    }

    // Default: chat completions
    const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 1,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;

    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      const error = `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`;
      return NextResponse.json({ ok: false, latencyMs, error, status: res.status });
    }

    const providerStatus = parsed?.status;
    const providerMsg = parsed?.msg || parsed?.message;
    const hasProviderErrorStatus = providerStatus !== undefined
      && providerStatus !== null
      && String(providerStatus) !== "200"
      && String(providerStatus) !== "0";
    if (hasProviderErrorStatus && providerMsg) {
      return NextResponse.json({
        ok: false,
        latencyMs,
        status: res.status,
        error: `Provider status ${providerStatus}: ${String(providerMsg).slice(0, 240)}`,
      });
    }

    if (parsed?.error) {
      const providerError = parsed?.error?.message || parsed?.error || "Provider returned an error";
      return NextResponse.json({
        ok: false,
        latencyMs,
        status: res.status,
        error: String(providerError).slice(0, 240),
      });
    }

    const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
    if (!hasChoices) {
      return NextResponse.json({
        ok: false,
        latencyMs,
        status: res.status,
        error: "Provider returned no completion choices for this model",
      });
    }

    return NextResponse.json({ ok: true, latencyMs, error: null, status: res.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
