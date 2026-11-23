import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { refreshGoogleToken } from "../services/tokenRefresh.js";
import {
  DEFAULT_THINKING_AG_SIGNATURE,
  DEFAULT_THINKING_CLAUDE_SIGNATURE,
  DEFAULT_THINKING_GEMINI_CLI_SIGNATURE,
  DEFAULT_THINKING_VERTEX_SIGNATURE,
} from "../config/defaultThinkingSignature.js";

// BAIC location when the keychain entry carries no region (the app writes "global").
export const ANTIGRAVITY_ENTERPRISE_DEFAULT_LOCATION = "global";
const BAIC_UNSUPPORTED_HARM_CATEGORIES = new Set(["HARM_CATEGORY_CIVIC_INTEGRITY"]);
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const SYNTHETIC_SIGNATURES = new Set([
  DEFAULT_THINKING_AG_SIGNATURE,
  DEFAULT_THINKING_GEMINI_CLI_SIGNATURE,
  DEFAULT_THINKING_VERTEX_SIGNATURE,
  DEFAULT_THINKING_CLAUDE_SIGNATURE,
]);

/** Resolve the BAIC location resource for a connection. */
export function baicLocationPath(credentials) {
  const projectId = credentials?.projectId || credentials?.providerSpecificData?.projectId;
  if (!projectId) throw new Error("Antigravity Enterprise connection has no project id. Re-import it from the Antigravity app.");
  const location = credentials?.providerSpecificData?.region || ANTIGRAVITY_ENTERPRISE_DEFAULT_LOCATION;
  return `projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}`;
}

/**
 * Antigravity Enterprise → Business AI Code (businessaicode.googleapis.com).
 *
 * The body is a plain Gemini GenerateContentRequest (translated by the shared
 * openai→gemini translator) plus `model` (an "experience" name such as
 * gemini-4-carbon-medium) and `entitlement.userTier` (the license tier the
 * Antigravity app recorded at sign-in, e.g. gcp-ge-plus-tier).
 */
export class AntigravityEnterpriseExecutor extends BaseExecutor {
  constructor() {
    super("antigravity-enterprise", PROVIDERS["antigravity-enterprise"]);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${this.config.baseUrl}/${baicLocationPath(credentials)}:${action}`;
  }

  transformRequest(model, body, stream, credentials) {
    const userTier = credentials?.providerSpecificData?.userTier;
    const out = { ...body, model };
    // BAIC's HarmCategory enum is older than the public Gemini API's: it 400s on
    // categories it doesn't know (e.g. CIVIC_INTEGRITY from the shared translator).
    if (Array.isArray(out.safetySettings)) {
      out.safetySettings = out.safetySettings.filter((s) => !BAIC_UNSUPPORTED_HARM_CATEGORIES.has(s?.category));
    }
    // When the real signature for a replayed tool call isn't cached, the shared
    // translator fills in a placeholder from another backend, which BAIC rejects
    // ("Invalid thought signature"); a missing one is rejected too. BAIC accepts
    // its own signatures and Gemini's documented skip marker, so swap placeholders.
    if (Array.isArray(out.contents)) {
      out.contents = out.contents.map((turn) => {
        if (!Array.isArray(turn?.parts) || !turn.parts.some((p) => SYNTHETIC_SIGNATURES.has(p?.thoughtSignature))) return turn;
        return {
          ...turn,
          parts: turn.parts.map((p) => (SYNTHETIC_SIGNATURES.has(p?.thoughtSignature) ? { ...p, thoughtSignature: SKIP_THOUGHT_SIGNATURE } : p)),
        };
      });
    }
    if (userTier) out.entitlement = { ...(body?.entitlement || {}), userTier };
    return out;
  }

  // The OAuth client is stored on the connection (imported with the refresh token),
  // not in the repo or the registry.
  async refreshCredentials(credentials, log) {
    const { clientId, clientSecret } = credentials?.providerSpecificData || {};
    if (!credentials?.refreshToken || !clientId || !clientSecret) {
      log?.warn?.("TOKEN_REFRESH", "Antigravity Enterprise connection has no stored OAuth client; re-import it");
      return null;
    }
    const result = await refreshGoogleToken(credentials.refreshToken, clientId, clientSecret, log);
    if (!result?.accessToken) return null;
    return { ...result, projectId: credentials.projectId };
  }
}

export default AntigravityEnterpriseExecutor;

/**
 * GET :fetchConfig — the account's admin controls and allowed "experiences" (models).
 * Used to validate an import and to build the live model list.
 * @returns {Promise<{models: Array<{id:string,name:string,modelId?:string,contextLength?:number,maxOutputTokens?:number}>}>}
 */
export async function fetchAntigravityEnterpriseConfig(credentials) {
  const config = PROVIDERS["antigravity-enterprise"];
  const userTier = credentials?.providerSpecificData?.userTier;
  const qs = userTier ? `?${new URLSearchParams({ "entitlement.userTier": userTier })}` : "";
  const res = await fetch(`${config.baseUrl}/${baicLocationPath(credentials)}:fetchConfig${qs}`, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "User-Agent": config.headers?.["User-Agent"],
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 300);
    try { message = JSON.parse(text)?.error?.message || message; } catch {}
    const err = new Error(`Business AI Code fetchConfig failed (${res.status}): ${message}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const models = (data?.availableExperiences || [])
    .filter((e) => e?.name)
    .map((e) => ({
      id: e.name,
      name: e.model?.displayName || e.name,
      modelId: e.model?.modelId,
      contextLength: e.model?.inputTokenLimit,
      maxOutputTokens: e.model?.outputTokenLimit,
    }));
  return { models };
}
