import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { clearKiroSessionReplayStore } from "../../open-sse/utils/kiroSessionReplay.js";

// Matches the real Hermes wire shape, including its GPT-5 system -> developer swap.
// An opt-in capture lets release validation replay real Hermes-generated requests
// without committing private prompts or requiring a Hermes installation in CI.
const prompt = `SYSTEM_BEGIN\n${"中文 context🙂\n".repeat(3000)}SYSTEM_MIDDLE\n${"instruction context\n".repeat(3000)}SYSTEM_END`;
const fixture = (role) => ({
  messages: [
    { role, content: prompt },
    { role: "user", content: "HISTORY_USER_CONTENT" },
    { role: "assistant", content: "ASSISTANT_CONTEXT", tool_calls: [
      { id: "call_hermes_fixture", type: "function", function: { name: "read_file", arguments: '{"path":"fixture.txt"}' } },
    ] },
    { role: "tool", tool_call_id: "call_hermes_fixture", content: "TOOL_OUTPUT_BEGIN\nFull tool output\nTOOL_OUTPUT_END" },
    { role: "assistant", content: "HISTORY_ASSISTANT_FINAL" },
    { role: "user", content: "CURRENT_USER_CONTEXT" },
  ],
  tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
});
const requests = process.env.HERMES_CAPTURE_FILE
  ? JSON.parse(readFileSync(process.env.HERMES_CAPTURE_FILE, "utf8"))
  : [fixture("system"), fixture("developer")];
const targets = [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE,
  FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY,
  FORMATS.KIRO, FORMATS.CURSOR, FORMATS.OLLAMA, FORMATS.COMMANDCODE];
const textParts = (value) => typeof value === "string" ? [value]
  : value && typeof value === "object" ? Object.values(value).flatMap(textParts) : [];

describe("Hermes full instruction/context preservation", () => {
  for (const [index, request] of requests.entries()) {
    for (const target of targets) {
      it(`keeps the entire Hermes instruction for request ${index} -> ${target}`, () => {
        clearKiroSessionReplayStore();
        const out = translateRequest(FORMATS.OPENAI, target,
          target === FORMATS.OPENAI_RESPONSES ? "gpt-5.5" : "claude-sonnet-4.6",
          structuredClone(request), true, { connectionId: `hermes-${index}-${target}` }, target);
        // Check byte content, not just one lucky persona keyword.
        expect(textParts(out).some(text => text.includes(request.messages[0].content))).toBe(true);
      });
    }
    for (const target of [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, FORMATS.KIRO]) {
      it(`keeps all Hermes history/tool-result text for request ${index} -> ${target}`, () => {
        clearKiroSessionReplayStore();
        const out = translateRequest(FORMATS.OPENAI, target, "claude-sonnet-4.6",
          structuredClone(request), true, { connectionId: `hermes-history-${index}-${target}` }, target);
        const texts = textParts(out);
        for (const message of request.messages.slice(1)) {
          if (typeof message.content === "string" && message.content) {
            expect(texts.some(text => text.includes(message.content))).toBe(true);
          }
        }
      });
    }
  }
});
