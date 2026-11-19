import { describe, expect, it } from "vitest";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { translateRequest } from "../../open-sse/translator/index.js";

// Claude Code's built-in security paragraph (2.1.30x). Antigravity answers any system prompt
// containing the parenthesized tool list with a detail-free 429 RESOURCE_EXHAUSTED.
const CC_SECURITY = "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

function systemTextSentToAntigravity(model, systemContent) {
  const body = openaiToAntigravityRequest(model, {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "hi" },
    ],
  }, true);
  const finalBody = new AntigravityExecutor().transformRequest(model, body, true, {});
  return finalBody.request.systemInstruction.parts.map((p) => p.text).join("\n");
}

describe("Antigravity rewrites Claude Code's dual-use security sentence", () => {
  for (const model of ["gemini-4-neon-medium", "claude-opus-5-5"]) {
    it(`drops the parenthesized tool list for ${model}`, () => {
      const text = systemTextSentToAntigravity(model, `You are an agent.\n\n${CC_SECURITY}\n\n# Tone`);
      expect(text).not.toContain("C2 frameworks");
      expect(text).toContain("Dual-use security tools require clear authorization context: pentesting engagements");
      expect(text).toContain("Refuse requests for destructive techniques");
      expect(text).toContain("# Tone");
    });
  }

  it("rewrites it on the Claude-format path Claude Code uses", () => {
    const body = translateRequest("claude", "antigravity", "gemini-4-neon-medium", {
      model: "gemini-4-neon-medium",
      max_tokens: 1000,
      system: [{ type: "text", text: "You are an agent." }, { type: "text", text: CC_SECURITY }],
      messages: [{ role: "user", content: "hi" }],
    }, true, {});
    const finalBody = new AntigravityExecutor().transformRequest("gemini-4-neon-medium", body, true, {});
    const text = finalBody.request.systemInstruction.parts.map((p) => p.text).join("\n");
    expect(text).not.toContain("C2 frameworks");
    expect(text).toContain("Dual-use security tools require clear authorization context");
  });

  it("leaves other parentheses alone", () => {
    const text = systemTextSentToAntigravity("gemini-4-neon-medium", "Use tools (Read, Edit) when needed.");
    expect(text).toContain("Use tools (Read, Edit) when needed.");
  });
});
