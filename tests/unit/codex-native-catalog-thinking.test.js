import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
const native = { id: "gpt-6-astra", capabilities: { reasoning: true, thinkingFormat: "openai", vision: true, contextWindow: 272000 }, reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningLevel: "medium" };

describe("native account metadata reaches Codex inference", () => {
  it("preserves all system/developer messages, text arrays, and their history positions", () => {
    const credentials = { codexModelMetadata: native };
    const translated = translateRequest("openai", "openai-responses", native.id, {
      model: native.id,
      messages: [
        { role: "system", content: [{ type: "text", text: "SYSTEM_START" }, { type: "text", text: "SYSTEM_TAIL" }] },
        { role: "developer", content: "DEVELOPER_PREFIX" },
        { role: "user", content: "HISTORY" },
        { role: "system", content: "LATER_SYSTEM" },
      ],
    }, true, credentials, "codex");
    const wire = new CodexExecutor().transformRequest(native.id, translated, true, credentials);
    expect(wire.instructions).toBe("SYSTEM_START\nSYSTEM_TAIL");
    expect(wire.input.map((item) => [item.role, item.content[0].text])).toEqual([
      ["developer", "DEVELOPER_PREFIX"], ["user", "HISTORY"], ["developer", "LATER_SYSTEM"],
    ]);
  });
  it.each(native.reasoningLevels)("preserves explicit %s through OpenAI chat translation and executor", (effort) => {
    const credentials = { codexModelMetadata: native };
    const translated = translateRequest("openai", "openai-responses", native.id, { model: native.id, messages: [{ role: "system", content: "KEEP_COMPLETE_SYSTEM" }, { role: "user", content: "hi" }], reasoning_effort: effort }, true, credentials, "codex");
    const wire = new CodexExecutor().transformRequest(native.id, translated, true, credentials);
    expect(wire.reasoning.effort).toBe(effort); expect(JSON.stringify(wire)).toContain("KEEP_COMPLETE_SYSTEM");
    expect(wire).not.toHaveProperty("codexModelMetadata");
  });
  it("preserves native Responses suffix effort without changing instructions/history", () => {
    const hints = {}; applyThinking("openai-responses", `${native.id}(ultra)`, hints, "codex", undefined, native);
    expect(hints.reasoning_effort).toBe("ultra");
    const wire = new CodexExecutor().transformRequest(native.id, { model: native.id, instructions: "SYSTEM_PREFIX", input: [{ role: "developer", content: "DEVELOPER_PREFIX" }, { role: "user", content: "HISTORY" }], reasoning: { effort: hints.reasoning_effort } }, true, { codexModelMetadata: native });
    expect(wire.reasoning.effort).toBe("ultra"); expect(wire.instructions).toBe("SYSTEM_PREFIX"); expect(JSON.stringify(wire.input)).toContain("DEVELOPER_PREFIX"); expect(JSON.stringify(wire.input)).toContain("HISTORY");
  });
  it("does not share reasoning levels across concurrent account credential objects", () => {
    const executor = new CodexExecutor();
    const first = executor.transformRequest(native.id, { model: native.id, input: "hi", reasoning_effort: "ultra" }, true, { codexModelMetadata: native });
    const second = executor.transformRequest(native.id, { model: native.id, input: "hi", reasoning_effort: "ultra" }, true, { codexModelMetadata: { ...native, reasoningLevels: ["low", "max"] } });
    expect(first.reasoning.effort).toBe("ultra"); expect(second.reasoning.effort).toBe("max");
  });
  it("keeps the existing low default when supported, and uses native default otherwise", () => {
    const executor = new CodexExecutor();
    expect(executor.transformRequest(native.id, { model: native.id, input: "hi" }, true, { codexModelMetadata: native }).reasoning.effort).toBe("low");
    expect(executor.transformRequest(native.id, { model: native.id, input: "hi" }, true, { codexModelMetadata: { ...native, reasoningLevels: ["high"], defaultReasoningLevel: "high" } }).reasoning.effort).toBe("high");
  });
});
