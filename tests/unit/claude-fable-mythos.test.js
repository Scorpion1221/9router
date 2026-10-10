import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";

// Fable 5/5.1 and Mythos 5/5.1 think adaptively and always: thinking "enabled"
// and "disabled" are rejected with 400. The 5.1 releases also reject forced
// tool_choice (any/tool); Fable 5 still accepts it.
const ALWAYS_ON = ["claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1"];
const NO_FORCED_TOOLS = ["claude-fable-5-1", "claude-mythos-5-1"];

describe("Claude Fable / Mythos capabilities", () => {
  it.each(ALWAYS_ON)("%s is always-on adaptive thinking", (model) => {
    expect(getCapabilitiesForModel("claude", model)).toMatchObject({
      thinkingFormat: "claude-adaptive",
      thinkingCanDisable: false,
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it("covers vendor-prefixed ids through the pattern", () => {
    expect(getCapabilitiesForModel("bedrock", "us.anthropic.claude-fable-5")).toMatchObject({
      thinkingFormat: "claude-adaptive",
      thinkingCanDisable: false,
    });
  });

  it.each(ALWAYS_ON)("%s never gets thinking enabled/disabled", (model) => {
    for (const body of [{ reasoning_effort: "high" }, { reasoning_effort: "none" }, { thinking: { type: "adaptive", display: "summarized" } }]) {
      const out = applyThinking("claude", model, structuredClone(body), "claude");
      expect(["enabled", "disabled"]).not.toContain(out.thinking?.type);
      expect(out.output_config?.effort).toBeTruthy();
    }
  });

  it("keeps the client's display on Fable 5", () => {
    const out = applyThinking("claude", "claude-fable-5", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" } }, "claude");
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "medium" });
  });
});

describe("forced tool_choice", () => {
  const prepare = (model, tool_choice) =>
    prepareClaudeRequest({ model, max_tokens: 1024, tool_choice, messages: [{ role: "user", content: "hi" }] }, "claude").tool_choice;

  it.each(NO_FORCED_TOOLS)("%s maps forced tool_choice to auto", (model) => {
    expect(prepare(model, { type: "any" })).toEqual({ type: "auto" });
    expect(prepare(model, { type: "tool", name: "run", disable_parallel_tool_use: true })).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("leaves Fable 5 forced tool_choice untouched", () => {
    expect(prepare("claude-fable-5", { type: "any" })).toEqual({ type: "any" });
  });

  it("covers the OpenAI-client path end to end on Fable 5.1", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-fable-5-1", {
      model: "claude-fable-5-1", reasoning_effort: "none", tool_choice: "required",
      tools: [{ type: "function", function: { name: "run", parameters: { type: "object", properties: {} } } }],
      messages: [{ role: "user", content: "hi" }],
    }, true, null, "claude");
    expect(out.thinking?.type).not.toBe("disabled");
    expect(out.tool_choice.type).toBe("auto");
  });
});
