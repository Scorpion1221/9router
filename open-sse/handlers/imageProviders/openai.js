// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { toImageUrl } from "./_base.js";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};
const imageUrl = (id) => imageCfg(id).baseUrl;

// Optional fields forwarded to POST /images/edits as-is. `stream`/`partial_images` are left out:
// the core parses one JSON response.
const EDIT_FIELDS = [
  "n", "size", "quality", "background", "output_format", "output_compression", "moderation",
  "input_fidelity", "complexity", "response_format", "user", "safety_identifier",
  "frame_count", "frame_duration_ms", "svg",
];

function collectRefs(body) {
  const list = [...(Array.isArray(body.images) ? body.images : []), body.image];
  return list.map(toImageUrl).filter(Boolean);
}

function buildEditBody(model, body, refs) {
  const req = { model, prompt: body.prompt, images: refs.map((image_url) => ({ image_url })) };
  const mask = toImageUrl(body.mask);
  const markup = toImageUrl(body.markup);
  if (mask) req.mask = { image_url: mask };
  if (markup) req.markup = { image_url: markup };
  for (const f of EDIT_FIELDS) if (body[f] !== undefined && body[f] !== "") req[f] = body[f];
  return req;
}

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  // Reference images go to the edits endpoint when the provider declares one.
  const isEdit = (body) => !!cfg.editUrl && collectRefs(body || {}).length > 0;
  return {
    supportsEdit: !!cfg.editUrl,
    buildUrl: (_model, _creds, body) => (isEdit(body) ? cfg.editUrl : imageUrl(providerId)),
    buildHeaders: (creds) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      return headers;
    },
    buildBody: (model, body) => {
      if (isEdit(body)) return buildEditBody(model, body, collectRefs(body));
      const {
        prompt,
        n = 1,
        size = "1024x1024",
        quality,
        style,
        response_format,
        output_format,
      } = body;
      const full = { model, prompt, n, size, output_format };
      if (quality) full.quality = quality;
      if (style) full.style = style;
      if (response_format) full.response_format = response_format;
      for (const field of ["output_format", "watermark", "prompt_extend"]) {
        if (cfg.bodyFields?.includes(field) && body[field] !== undefined) {
          full[field] = body[field];
        }
      }
      // bodyFields whitelist (e.g. xAI accepts only model/prompt/n/response_format)
      if (Array.isArray(cfg.bodyFields)) {
        const req = {};
        for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f];
        return req;
      }
      return full;
    },
    normalize: (responseBody) => responseBody,
  };
}
