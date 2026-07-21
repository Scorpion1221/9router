import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { OpenAIExecutor } from "../../open-sse/executors/openai.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

describe("OpenAIExecutor Responses routing", () => {
  const tool = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: {} },
    },
  };

  beforeEach(() => {
    proxyAwareFetch.mockReset();
  });

  it("routes GPT-5 function tools with reasoning to Responses", () => {
    const executor = new OpenAIExecutor();

    expect(executor.shouldUseResponsesEndpoint("gpt-5.6-sol", {
      tools: [tool],
    })).toBe(true);
    expect(executor.shouldUseResponsesEndpoint("gpt-5.6-sol", {
      tools: [tool],
      reasoning_effort: "medium",
    })).toBe(true);
    expect(executor.shouldUseResponsesEndpoint("o4-mini", {
      tools: [tool],
      reasoning: { effort: "high" },
    })).toBe(true);
  });

  it("keeps explicit no-reasoning, non-tool, and older-model requests on Chat Completions", () => {
    const executor = new OpenAIExecutor();

    expect(executor.shouldUseResponsesEndpoint("gpt-5.6-sol", {
      tools: [tool],
      reasoning_effort: "none",
    })).toBe(false);
    expect(executor.shouldUseResponsesEndpoint("gpt-5.6-sol", {
      reasoning_effort: "medium",
    })).toBe(false);
    expect(executor.shouldUseResponsesEndpoint("gpt-4o", {
      tools: [tool],
      reasoning_effort: "medium",
    })).toBe(false);
  });

  it("translates the request and converted Responses SSE back to Chat SSE", async () => {
    const upstreamSSE = [
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}',
      "data: [DONE]",
      "",
    ].join("\n");
    proxyAwareFetch.mockResolvedValue(new Response(upstreamSSE, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const executor = new OpenAIExecutor();
    const result = await executor.execute({
      model: "gpt-5.6-sol",
      body: {
        messages: [{ role: "developer", content: "Answer briefly" }, { role: "user", content: "hi" }],
        tools: [tool],
        reasoning_effort: "medium",
        max_tokens: 1024,
      },
      stream: true,
      credentials: { apiKey: "test-key" },
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    const requestBody = JSON.parse(init.body);
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(requestBody).toMatchObject({
      model: "gpt-5.6-sol",
      instructions: "Answer briefly",
      reasoning: { effort: "medium", summary: "auto" },
      max_output_tokens: 1024,
      stream: true,
    });
    expect(requestBody.max_tokens).toBeUndefined();
    expect(requestBody.max_completion_tokens).toBeUndefined();
    expect(requestBody.tools[0]).toMatchObject({ type: "function", name: "get_weather" });

    const responseText = await result.response.text();
    expect(responseText).toContain('"content":"ok"');
    expect(responseText).toContain('"finish_reason":"stop"');
    expect(responseText).toContain('"prompt_tokens":5');
    expect(responseText).toContain("data: [DONE]");
  });

  it("keeps the converted stream parseable for non-streaming Chat clients", async () => {
    const upstreamSSE = [
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}',
      "data: [DONE]",
      "",
    ].join("\n");
    proxyAwareFetch.mockResolvedValue(new Response(upstreamSSE, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const result = await new OpenAIExecutor().execute({
      model: "gpt-5.6-sol",
      body: {
        messages: [{ role: "user", content: "hi" }],
        tools: [tool],
        reasoning_effort: "medium",
      },
      stream: false,
      credentials: { apiKey: "test-key" },
    });

    const responseText = await result.response.text();
    expect(responseText).not.toContain("data: [DONE]");
    expect(parseSSEToOpenAIResponse(responseText, "gpt-5.6-sol"))
      .toMatchObject({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  });
});
