// OpenAI TTS — model format:
//   "<tts-model>/<voice>"        → e.g. "gpt-4o-mini-tts/alloy"
//   "<voice>"                    → e.g. "alloy"  (defaults to gpt-4o-mini-tts)
//   "<tts-model>"                → e.g. "tts-1"  (use this model + default voice "alloy")
import { Buffer } from "node:buffer";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const DEFAULT_TTS_MODEL = PROVIDER_MEDIA["openai"]?.ttsConfig?.defaultModel;

// Known OpenAI TTS model ids. Used to disambiguate single-segment inputs:
// `tts-1` is a model, `alloy` is a voice. Both arrive as `model` in the
// canonical (model-only) form like `openai/tts-1`.
const TTS_MODELS = new Set(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]);

export default {
  async synthesize(text, model, credentials, _responseFormat, _opts) {
    if (!credentials?.apiKey) throw new Error("No OpenAI API key configured");

    let ttsModel = DEFAULT_TTS_MODEL;
    let voice = "alloy";
    if (model && model.includes("/")) {
      const parts = model.split("/");
      if (parts.length === 2) [ttsModel, voice] = parts;
    } else if (model) {
      // Single segment: decide whether it's a model or a voice.
      if (TTS_MODELS.has(model)) {
        ttsModel = model; // keep default voice
      } else {
        voice = model; // legacy: treat as voice
      }
    }

    const baseUrl = (credentials.baseUrl || "https://api.openai.com").replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${credentials.apiKey}` },
      body: JSON.stringify({ model: ttsModel, voice, input: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString("base64"), format: "mp3" };
  },
};
