// Vertex AI text embeddings
//
// Two model families with DIFFERENT endpoints:
//
//   :predict family (PaLM-style, supports batch via instances[])
//     - gemini-embedding-001
//     - text-embedding-005
//     - text-multilingual-embedding-002
//     Body:  { instances:[{content}, ...], parameters:{outputDimensionality} }
//     Resp:  { predictions:[{embeddings:{values,statistics:{token_count}}}, ...] }
//
//   :embedContent family (Gemini-style, NO batch endpoint on Vertex)
//     - gemini-embedding-2-preview
//     Body:  { content:{parts:[{text}]}, outputDimensionality }
//     Resp:  { embedding:{values:[...]} }
//     Multiple inputs require N sequential calls; we loop in fetchAll.
//
// Auth (mirrors executors/vertex.js):
//   SA JSON  → Bearer token, project-scoped {location}-aiplatform host
//   Raw key  → global aiplatform host with ?key=
// Token minting is handled upstream (services/tokenRefresh.js → refreshVertexToken),
// so credentials.accessToken is already populated by the time this adapter runs.
import { parseVertexSaJson, refreshVertexToken } from "../../services/tokenRefresh.js";

// Ensure SA-flow credentials have a fresh Bearer token before issuing requests.
// checkAndRefreshToken upstream only refreshes when `expiresAt` is set; freshly
// added Vertex SA connections have no expiresAt, so we mint on demand here.
// Mutates `creds` in place so subsequent calls in the same fetchAll loop reuse it.
async function ensureVertexAccessToken(creds, log) {
  const saJson = parseVertexSaJson(creds?.apiKey);
  if (!saJson) return; // raw-key flow, nothing to do
  if (creds.accessToken && creds.expiresAt && new Date(creds.expiresAt).getTime() - Date.now() > 60_000) {
    return; // still fresh
  }
  const minted = await refreshVertexToken(saJson, log);
  if (minted?.accessToken) {
    creds.accessToken = minted.accessToken;
    if (minted.expiresAt) {
      creds.expiresAt = new Date(minted.expiresAt).toISOString();
    }
  }
}

function isEmbedContentModel(model) {
  // gemini-embedding-2 family uses the Gemini embedContent protocol, not predict.
  return /^gemini-embedding-2/i.test(model);
}

function isSaFlow(creds) {
  return !!parseVertexSaJson(creds?.apiKey);
}

function resolveLocation(creds) {
  // Embedding endpoint location. `global` does NOT work for embeddings — must be
  // a real region. Prefer the dedicated embeddingLocation field, then the legacy
  // shared `location` field, then us-central1 as a sane default.
  return (
    creds?.providerSpecificData?.embeddingLocation ||
    creds?.providerSpecificData?.location ||
    "us-central1"
  );
}

function buildModelBase(model, creds) {
  const saJson = parseVertexSaJson(creds?.apiKey);
  if (saJson) {
    const projectId = saJson.project_id || creds?.providerSpecificData?.projectId;
    const location = resolveLocation(creds);
    return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}`;
  }
  // Raw key flow — global publishers endpoint
  return `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}`;
}

function appendKeyIfNeeded(url, creds) {
  if (isSaFlow(creds)) return url;
  const apiKey = creds?.apiKey || creds?.accessToken;
  if (!apiKey) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}key=${encodeURIComponent(apiKey)}`;
}

function buildHeadersFor(creds) {
  const headers = { "Content-Type": "application/json" };
  if (isSaFlow(creds) && creds?.accessToken) {
    headers["Authorization"] = `Bearer ${creds.accessToken}`;
  }
  return headers;
}

function parseDim(dimensions) {
  if (dimensions == null || dimensions === "") return null;
  const dim = Number(dimensions);
  return Number.isFinite(dim) && dim > 0 ? dim : null;
}

async function fetchOneEmbedContent({ model, creds, text, dimensions }) {
  const url = appendKeyIfNeeded(`${buildModelBase(model, creds)}:embedContent`, creds);
  const body = { content: { parts: [{ text: String(text) }] } };
  const dim = parseDim(dimensions);
  if (dim != null) body.outputDimensionality = dim;
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeadersFor(creds),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.text()).slice(0, 400) || msg; } catch { /* noop */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json?.embedding?.values || [];
}

export default {
  // :predict path (gemini-embedding-001, text-embedding-005, multilingual-002)
  buildUrl: (model, creds) => {
    const base = buildModelBase(model, creds);
    return appendKeyIfNeeded(`${base}:predict`, creds);
  },

  buildHeaders: (creds) => buildHeadersFor(creds),

  buildBody: (model, { input, dimensions }) => {
    const items = Array.isArray(input) ? input : [input];
    const instances = items.map((text) => ({ content: String(text) }));
    const body = { instances };
    const dim = parseDim(dimensions);
    if (dim != null) body.parameters = { outputDimensionality: dim };
    return body;
  },

  normalize: (responseBody, model) => {
    if (responseBody?.object === "list" && Array.isArray(responseBody.data)) {
      return responseBody;
    }
    const predictions = Array.isArray(responseBody?.predictions) ? responseBody.predictions : [];
    const data = predictions.map((p, idx) => ({
      object: "embedding",
      index: idx,
      embedding: p?.embeddings?.values || [],
    }));
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

  // Full request takeover — used for gemini-embedding-2-preview which requires
  // :embedContent (no batch endpoint available on Vertex for this model).
  fetchAll: async function ({ model, credentials, input, dimensions, log }) {
    await ensureVertexAccessToken(credentials, log);
    if (!isEmbedContentModel(model)) {
      // Signal core to fall back to buildUrl/buildBody path for non-gemini-2 models.
      // We do this by throwing a sentinel with a special marker that core treats
      // as "no-op" — but core doesn't support that, so instead only expose
      // fetchAll behavior for embedContent models. For others we rely on core
      // calling buildUrl/buildBody (fetchAll present means core ALWAYS uses it),
      // so we must delegate to predict ourselves here.
      return await predictFetch({ model, credentials, input, dimensions, log });
    }

    const items = Array.isArray(input) ? input : [input];
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const values = await fetchOneEmbedContent({
        model,
        creds: credentials,
        text: items[i],
        dimensions,
      });
      results.push({ object: "embedding", index: i, embedding: values });
    }
    log?.debug?.("EMBEDDINGS", `VERTEX embedContent | ${model} | count=${items.length}`);
    return {
      object: "list",
      data: results,
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  },
};

// :predict path used when fetchAll is invoked for non-gemini-2 models
async function predictFetch({ model, credentials, input, dimensions }) {
  const url = appendKeyIfNeeded(`${buildModelBase(model, credentials)}:predict`, credentials);
  const items = Array.isArray(input) ? input : [input];
  const requestBody = { instances: items.map((text) => ({ content: String(text) })) };
  const dim = parseDim(dimensions);
  if (dim != null) requestBody.parameters = { outputDimensionality: dim };

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeadersFor(credentials),
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.text()).slice(0, 400) || msg; } catch { /* noop */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const predictions = Array.isArray(json?.predictions) ? json.predictions : [];
  const data = predictions.map((p, idx) => ({
    object: "embedding",
    index: idx,
    embedding: p?.embeddings?.values || [],
  }));
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
}
