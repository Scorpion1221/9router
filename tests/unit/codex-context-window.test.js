import { describe, expect, it } from "vitest";

import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { resolveModelInfo } from "../../src/lib/modelInfo.js";

const CODEX_272K_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-sol-review",
  "gpt-5.6-terra",
  "gpt-5.6-terra-review",
  "gpt-5.6-luna",
  "gpt-5.6-luna-review",
  "gpt-5.5",
  "gpt-5.5-review",
];

describe("Codex context window metadata", () => {
  it.each(CODEX_272K_MODELS)("reports cx/%s as 272k in provider capabilities", (model) => {
    expect(getCapabilitiesForModel("codex", model).contextWindow).toBe(272000);
  });

  it.each(CODEX_272K_MODELS)("keeps cx/%s at 272k before OpenRouter enrichment", async (model) => {
    const registryModel = PROVIDER_MODELS.cx.find((entry) => entry.id === model);
    expect(registryModel?.contextWindow).toBe(272000);

    const info = await resolveModelInfo(`cx/${model}`);
    expect(info?.contextWindow).toBe(272000);
  });

  it("does not reduce the official OpenAI API model context window", () => {
    expect(getCapabilitiesForModel("openai", "gpt-5.5").contextWindow).toBe(400000);
  });
});
