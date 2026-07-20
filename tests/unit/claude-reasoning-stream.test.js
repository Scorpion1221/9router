import { describe, expect, it } from "vitest";

import { initState } from "../../open-sse/translator/index.js";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";

describe("Claude thinking stream to OpenAI", () => {
  it("emits thinking only as reasoning_content and keeps content clean", () => {
    const state = initState("openai");
    const events = [
      { type: "message_start", message: { id: "msg_1", model: "claude" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hidden thought" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "visible answer" } },
      { type: "content_block_stop", index: 1 },
    ];

    const chunks = events.flatMap(event => claudeToOpenAIResponse(event, state) || []);
    const deltas = chunks.map(chunk => chunk.choices?.[0]?.delta || {});

    expect(deltas.map(delta => delta.reasoning_content).filter(Boolean)).toEqual(["hidden thought"]);
    expect(deltas.map(delta => delta.content).filter(Boolean)).toEqual(["visible answer"]);
    expect(JSON.stringify(chunks)).not.toContain("<think>");
    expect(JSON.stringify(chunks)).not.toContain("</think>");
  });
});
