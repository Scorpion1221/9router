import { ANTIGRAVITY_ENTERPRISE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT } from "../shared.js";

// Antigravity signed in with a Workspace / Gemini Enterprise account ("gcp" auth method).
// Traffic goes to Business AI Code (businessaicode.googleapis.com), not cloudcode-pa, and
// every call carries the account's license tier as `entitlement.userTier`.
// Each connection stores its own OAuth client (clientId/clientSecret in
// providerSpecificData) plus refresh token, pasted in the dashboard or read from the
// Antigravity desktop app on the same machine — no browser OAuth flow, no repo secret.
export default {
  id: "antigravity-enterprise",
  priority: 21,
  alias: "age",
  uiAlias: "age",
  display: {
    name: "Antigravity Enterprise",
    icon: "domain",
    color: "#D97706",
    website: "https://antigravity.google",
    notice: {
      text: "Uses the Gemini Enterprise login of the Antigravity desktop app. Read it on the Mac where Antigravity is signed in, then paste it here.",
    },
  },
  category: "oauth",
  serviceKinds: ["llm"],
  transport: {
    baseUrl: ANTIGRAVITY_ENTERPRISE_BASE_URL,
    format: "gemini",
    headers: {
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    },
    retry: {
      "429": { attempts: 3 },
      "500": { attempts: 3 },
      "503": { attempts: 3 },
    },
  },
  // Ids are BAIC "experience" names (model + thinking level). The bare modelId is
  // rejected as "not allowed by your administrator". Live list: :fetchConfig.
  models: [
    { id: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
    { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
    { id: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
    { id: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (Extra High)" },
    { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
    { id: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
    { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
    { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
    { id: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
    { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    // Bare names: BAIC only accepts an experience with a level, so these map to the
    // medium level (Pro has no medium; it maps to high, like Antigravity's own default).
    // A reasoning effort on the request still picks the matching level (getModelUpstreamId).
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon", upstreamModelId: "gemini-4-carbon-medium" },
    { id: "gemini-4-neon", name: "Gemini 4 Neon", upstreamModelId: "gemini-4-neon-medium" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", upstreamModelId: "gemini-4-hydrogen-medium" },
    { id: "gemini-4-argon", name: "Gemini 4 Argon", upstreamModelId: "gemini-4-argon-medium" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", upstreamModelId: "gemini-3.8-flash-medium" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", upstreamModelId: "gemini-3.7-flash-medium" },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", upstreamModelId: "gemini-3.6-flash-medium" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", upstreamModelId: "gemini-3.1-pro-high" },
  ],
  // Quota Tracker page: weekly project quota via :fetchQuotaStatus.
  features: {
    usage: true,
  },
  oauth: {
    tokenUrl: "https://oauth2.googleapis.com/token",
    refreshLeadMs: 300000,
  },
};
