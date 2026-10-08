import { describe, expect, it } from "vitest";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

// Haiku 5.5 joins the 5.x adaptive-thinking family with a 1M window. Without
// explicit rows it fell through to the generic claude-haiku-* pattern (budget
// thinking), and the passthrough normalizer rewrote Claude Code's adaptive
// thinking into a fixed 10k budget and dropped output_config.effort.
describe("Claude Haiku 5.5", () => {
  it("is listed for the claude provider", () => {
    expect(getModelsByProviderId("claude").some((model) => model.id === "claude-haiku-5-5")).toBe(true);
  });

  it.each(["claude-haiku-5-5", "claude-haiku-5.5"])("resolves %s to adaptive thinking with a 1M context", (model) => {
    expect(getCapabilitiesForModel("claude", model)).toMatchObject({
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it("keeps Haiku 4.5 on budget thinking", () => {
    expect(getCapabilitiesForModel("claude", "claude-haiku-4-5-20251001").thinkingFormat).toBe("claude-budget");
  });

  it("prices Haiku 5.5 at its published rate", () => {
    expect(getPricingForModel("claude", "claude-haiku-5-5")).toEqual({ input: 0.1, output: 0.5, cached: 0.01, reasoning: 0.5, cache_creation: 0.125 });
  });
});

describe("Claude Haiku 5.5 passthrough", () => {
  it("keeps adaptive thinking and effort from Claude Code", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } }, "claude-haiku-5-5");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "xhigh" });
  });

  it("still downgrades Haiku 4.5", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" }, output_config: { effort: "high" } }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(out.output_config).toBeUndefined();
  });
});

// Unlike Sonnet 5.5, Haiku 5.5 accepts thinking "disabled" and forced tool use
// (probed against api.anthropic.com), so neither is rewritten.
describe("Claude Haiku 5.5 request shape", () => {
  const prepare = (body) => prepareClaudeRequest({ max_tokens: 1024, messages: [{ role: "user", content: "hi" }], ...body }, "claude");

  it("leaves thinking disabled as is", () => {
    const body = prepare({ model: "claude-haiku-5-5", thinking: { type: "disabled" }, output_config: { effort: "max" } });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config.effort).toBe("max");
  });

  it("keeps forced tool choice", () => {
    const body = prepare({
      model: "claude-haiku-5-5",
      tools: [{ name: "add", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name: "add" },
    });
    expect(body.tool_choice).toEqual({ type: "tool", name: "add" });
  });
});
