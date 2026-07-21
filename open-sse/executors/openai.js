import { DefaultExecutor } from "./default.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import { initState } from "../translator/index.js";
import { parseSSELine, formatSSE } from "../utils/streamHelpers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { isGpt5OrOSeriesModel } from "../translator/concerns/paramSupport.js";
import { SSE_DONE } from "../utils/sseConstants.js";

export class OpenAIExecutor extends DefaultExecutor {
  constructor() {
    super("openai");
  }

  shouldUseResponsesEndpoint(model, body) {
    const effort = body?.reasoning_effort ?? body?.reasoning?.effort;
    const hasFunctionTools = body?.tools?.some(tool => tool?.type === "function" || tool?.function) === true;
    // GPT-5/o-series default to reasoning when no effort is specified, and
    // OpenAI rejects function tools on /chat/completions in that default mode.
    // Only an explicit "none" is safe to keep on Chat Completions.
    return isGpt5OrOSeriesModel(model) && hasFunctionTools && effort !== "none";
  }

  async execute(options) {
    if (this.shouldUseResponsesEndpoint(options.model, options.body)) {
      options.log?.debug("OPENAI", `Using /v1/responses for tool reasoning on ${options.model}`);
      return this.executeWithResponsesEndpoint(options);
    }
    return super.execute(options);
  }

  async executeWithResponsesEndpoint({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.config.responsesUrl;
    const headers = this.buildHeaders(credentials, true);
    const normalizedBody = this.transformRequest(model, body, true, credentials);
    const transformedBody = openaiToOpenAIResponsesRequest(model, normalizedBody, true, credentials);

    log?.debug("OPENAI", "Sending translated request to /v1/responses");

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal
    }, proxyOptions);

    if (!response.ok) {
      return { response, url, headers, transformedBody };
    }

    const state = initState("openai-responses");
    state.model = model;

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const parsed = parseSSELine(line.trim());
          if (!parsed) continue;

          if (parsed.done) {
            if (stream === true) controller.enqueue(encoder.encode(SSE_DONE));
            continue;
          }

          const converted = openaiResponsesToOpenAIResponse(parsed, state);
          if (converted) controller.enqueue(encoder.encode(formatSSE(converted, "openai")));
        }
      },
      flush(controller) {
        const parsed = parseSSELine(buffer.trim());
        if (parsed && !parsed.done) {
          const converted = openaiResponsesToOpenAIResponse(parsed, state);
          if (converted) controller.enqueue(encoder.encode(formatSSE(converted, "openai")));
        }
      }
    });

    if (!response.body) {
      return { response: new Response("", { status: response.status, headers: response.headers }), url, headers, transformedBody };
    }

    return {
      response: new Response(response.body.pipeThrough(transformStream), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }),
      url,
      headers,
      transformedBody
    };
  }
}

export default OpenAIExecutor;
