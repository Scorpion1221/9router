import { describe, it, expect } from "vitest";

import {
  normalizeMaxCompletionTokens,
  stripUnsupportedParams,
} from "../../open-sse/translator/concerns/paramSupport.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { AzureExecutor } from "../../open-sse/executors/azure.js";

describe("normalizeMaxCompletionTokens", () => {
  it("maps max_tokens for official OpenAI GPT-5 models", () => {
    const body = { max_tokens: 16384 };

    normalizeMaxCompletionTokens("openai", "gpt-5.6-sol", body);

    expect(body).toEqual({ max_completion_tokens: 16384 });
  });

  it("maps max_tokens for official OpenAI o-series models", () => {
    const body = { max_tokens: 4096 };

    normalizeMaxCompletionTokens("openai", "o4-mini", body);

    expect(body).toEqual({ max_completion_tokens: 4096 });
  });

  it("keeps an explicit max_completion_tokens value", () => {
    const body = { max_tokens: 4096, max_completion_tokens: 8192 };

    normalizeMaxCompletionTokens("openai", "gpt-5.6-sol", body);

    expect(body).toEqual({ max_completion_tokens: 8192 });
  });

  it("does not rewrite other providers or older OpenAI models", () => {
    const anthropicBody = { max_tokens: 4096 };
    const gpt4Body = { max_tokens: 4096 };

    normalizeMaxCompletionTokens("anthropic", "gpt-5.6-sol", anthropicBody);
    normalizeMaxCompletionTokens("openai", "gpt-4o", gpt4Body);

    expect(anthropicBody).toEqual({ max_tokens: 4096 });
    expect(gpt4Body).toEqual({ max_tokens: 4096 });
  });

  it("runs in the final OpenAI and Azure executor transforms", () => {
    const openai = new DefaultExecutor("openai");
    const azure = new AzureExecutor();

    expect(openai.transformRequest("gpt-5.6-sol", { max_tokens: 1024 })).toEqual({
      max_completion_tokens: 1024,
    });
    expect(azure.transformRequest("o3", { max_tokens: 2048 })).toEqual({
      max_completion_tokens: 2048,
    });
  });
});

describe("stripUnsupportedParams", () => {
  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("still drops unsupported GitHub model params", () => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", "gpt-5.4", body);

    expect(body).toEqual({ top_p: 1 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });
});
