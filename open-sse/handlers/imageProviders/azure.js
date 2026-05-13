// Azure OpenAI image generation adapter.
//
// Azure exposes OpenAI-compatible image endpoints under the per-deployment URL
// shape, which differs from regular OpenAI in three ways:
//   1. URL is `{endpoint}/openai/deployments/{deployment}/images/generations?api-version=...`
//      — the model name is encoded in the deployment slug, not the body.
//   2. Auth header is `api-key: <key>`, NOT `Authorization: Bearer ...`.
//   3. `endpoint` / `apiVersion` / `deployment` come from the connection's
//      providerSpecificData (set when the user creates the Azure connection
//      via the AddApiKeyModal — same fields that the LLM executor already uses).
//
// `deployment` falls back to the model id, so a deployment named exactly
// after the model (e.g. "gpt-image-2") needs no extra config.
//
// Body shape mirrors OpenAI v1/images/generations: prompt, n, size, quality,
// style, response_format. Azure ignores `model` in the body (deployment
// determines the model), so we don't include it.

const DEFAULT_API_VERSION = "2024-10-01-preview";

export default {
  buildUrl: (model, creds) => {
    const endpoint = (creds?.providerSpecificData?.azureEndpoint || "").replace(/\/$/, "");
    const apiVersion = creds?.providerSpecificData?.apiVersion || DEFAULT_API_VERSION;
    const deployment = creds?.providerSpecificData?.deployment || model;
    if (!endpoint) {
      const e = new Error("Azure connection is missing 'azureEndpoint' (set it in the connection's provider-specific data).");
      e.status = 400;
      throw e;
    }
    return `${endpoint}/openai/deployments/${deployment}/images/generations?api-version=${apiVersion}`;
  },

  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json" };
    const apiKey = creds?.apiKey || creds?.accessToken;
    if (apiKey) headers["api-key"] = apiKey;
    const organization = creds?.providerSpecificData?.organization;
    if (organization) headers["OpenAI-Organization"] = organization;
    return headers;
  },

  buildBody: (model, body) => {
    const { prompt, n = 1, size = "1024x1024", quality, style, response_format } = body;
    // NOTE: no `model` field — Azure routes via deployment in the URL.
    const req = { prompt, n, size };
    if (quality) req.quality = quality;
    if (style) req.style = style;
    if (response_format) req.response_format = response_format;
    return req;
  },

  normalize: (responseBody) => responseBody,
};
