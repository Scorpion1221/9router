import { describe, expect, it } from "vitest";

import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import claude from "../../open-sse/providers/registry/claude.js";
import bedrock from "../../open-sse/providers/registry/bedrock.js";

// Fable 5.2 rates from OpenRouter (anthropic/claude-fable-5.2, 2026-11-10), per 1M tokens.
const FABLE_5_2_PRICING = { input: 8, output: 40, cached: 0.2, reasoning: 40, cache_creation: 10 };

describe("Claude Fable 5.2", () => {
  it("is listed for Claude Code and Bedrock", () => {
    expect(claude.models.map((m) => m.id)).toContain("claude-fable-5-2");
    expect(bedrock.models.map((m) => m.id)).toContain("us.anthropic.claude-fable-5-2");
  });

  it("has its own static price instead of the Fable 5 or wildcard rate", () => {
    expect(getPricingForModel("claude", "claude-fable-5-2")).toEqual(FABLE_5_2_PRICING);
  });
});
