// Vertex AI text embeddings — :predict
//
// Two auth flows (mirrors executors/vertex.js):
//   - SA JSON  → Bearer token, project-scoped path
//                https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:predict
//   - Raw key  → global publishers path with ?key=
//                https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:predict?key=KEY
//
// Token minting is handled upstream (services/tokenRefresh.js -> refreshVertexToken),
// so credentials.accessToken is already populated by the time this adapter runs.
import { parseVertexSaJson } from "../../services/tokenRefresh.js";

function isSaFlow(creds) {
  return !!parseVertexSaJson(creds?.apiKey);
}

function buildPredictUrl(model, creds) {
  const saJson = parseVertexSaJson(creds?.apiKey);
  if (saJson) {
    const projectId = saJson.project_id || creds?.providerSpecificData?.projectId;
    const location = creds?.providerSpecificData?.location || "us-central1";
    return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;
  }
  // Raw key flow — global publishers endpoint (no project_id needed)
  const apiKey = creds?.apiKey || creds?.accessToken;
  return `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:predict?key=${encodeURIComponent(apiKey)}`;
}

export default {
  buildUrl: (model, creds) => buildPredictUrl(model, creds),

  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json" };
    // SA JSON flow uses Bearer token; raw key flow puts key in URL
    if (isSaFlow(creds) && creds?.accessToken) {
      headers["Authorization"] = `Bearer ${creds.accessToken}`;
    }
    return headers;
  },

  buildBody: (model, { input, dimensions }) => {
    const items = Array.isArray(input) ? input : [input];
    const instances = items.map((text) => ({ content: String(text) }));
    const body = { instances };

    // Vertex calls it outputDimensionality; only honored by models that support it
    // (e.g. gemini-embedding-001, gemini-embedding-2). Other models ignore.
    if (dimensions != null && dimensions !== "") {
      const dim = Number(dimensions);
      if (Number.isFinite(dim) && dim > 0) {
        body.parameters = { outputDimensionality: dim };
      }
    }

    return body;
  },

  normalize: (responseBody, model) => {
    // Already OpenAI-shaped? pass through
    if (responseBody?.object === "list" && Array.isArray(responseBody.data)) {
      return responseBody;
    }

    // Vertex :predict response shape:
    //   { predictions: [ { embeddings: { values: [...], statistics: {...} } }, ... ] }
    const predictions = Array.isArray(responseBody?.predictions) ? responseBody.predictions : [];
    const data = predictions.map((p, idx) => ({
      object: "embedding",
      index: idx,
      embedding: p?.embeddings?.values || [],
    }));

    // Best-effort token usage from statistics
    let promptTokens = 0;
    for (const p of predictions) {
      const t = p?.embeddings?.statistics?.token_count;
      if (typeof t === "number") promptTokens += t;
    }

    return {
      object: "list",
      data,
      model,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    };
  },
};
