import { beforeEach, describe, expect, it, vi } from "vitest";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";
import { clearKiroSessionReplayStore } from "../../open-sse/utils/kiroSessionReplay.js";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";

const wireText = (payload) => [
  ...(payload.conversationState.history || []), payload.conversationState.currentMessage,
].map((m) => m.userInputMessage?.content || "").join("\n");
const auth = () => ({ connectionId: "offline-audit", rawHeaders: { "x-session-id": "offline-session" } });

beforeEach(() => { clearKiroSessionReplayStore(); vi.restoreAllMocks(); });

describe("Kiro instruction wire contract", () => {
  it("keeps OpenAI system and developer instructions in explicit instruction blocks", () => {
    const payload = openaiToKiroRequest("claude-sonnet-4.6", { messages: [
      { role: "system", content: "SYSTEM_MARKER" },
      { role: "developer", content: "DEVELOPER_MARKER" },
      { role: "user", content: "USER_MARKER" },
    ] }, true, auth());
    expect(payload).not.toHaveProperty("systemPrompt");
    expect(wireText(payload)).toContain("<instructions>\nSYSTEM_MARKER\n</instructions>");
    expect(wireText(payload)).toContain("<instructions>\nDEVELOPER_MARKER\n</instructions>");
  });

  it("replays the developer instruction on a follow-up that only supplies the latest user turn", () => {
    const credentials = auth();
    const first = openaiToKiroRequest("claude-sonnet-4.6", { messages: [
      { role: "developer", content: "DEVELOPER_MARKER" },
      { role: "user", content: "first" },
    ] }, true, credentials);
    const second = openaiToKiroRequest("claude-sonnet-4.6", { messages: [
      { role: "user", content: "second" },
    ] }, true, credentials);
    expect(second).not.toHaveProperty("systemPrompt");
    expect(wireText(second)).toContain("DEVELOPER_MARKER");
    expect(second.conversationState.history[0].userInputMessage.content).toBe(first.conversationState.currentMessage.userInputMessage.content);
  });

  it("keeps Claude system, thinking and agentic instructions in the frozen first turn", () => {
    const credentials = auth();
    const body = (text) => ({ system: [{ type: "text", text: "CLAUDE_SYSTEM_MARKER" }], thinking: { type: "enabled", budget_tokens: 4096 }, messages: [{ role: "user", content: text }] });
    const first = claudeToKiroRequest("claude-sonnet-4.6-agentic", body("first"), true, credentials);
    const second = claudeToKiroRequest("claude-sonnet-4.6-agentic", body("second"), true, credentials);
    for (const payload of [first, second]) {
      expect(payload).not.toHaveProperty("systemPrompt");
      expect(wireText(payload)).toContain("CLAUDE_SYSTEM_MARKER");
      expect(wireText(payload)).toContain("<max_thinking_length>4096</max_thinking_length>");
      expect(wireText(payload)).toContain("CHUNKED WRITE PROTOCOL");
    }
    expect(second.conversationState.history[0].userInputMessage.content).toBe(first.conversationState.currentMessage.userInputMessage.content);
  });

  it.each(["invalid_tool", "ellipsis", "short_final"])("does not reintroduce systemPrompt on a %s repair retry", async (kind) => {
    const executor = new KiroExecutor();
    const execute = vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({ response: new Response("") });
    vi.spyOn(executor, "readRecoverableIntegrityAttempt")
      .mockResolvedValueOnce({ kind, message: "synthetic incomplete response" })
      .mockResolvedValueOnce({ kind: "complete", bytes: new Uint8Array() });
    const body = openaiToKiroRequest("claude-sonnet-4.6", { messages: [{ role: "user", content: "test" }] }, true, auth());
    expect(body).not.toHaveProperty("systemPrompt");
    await executor.runIntegrityRecovery(new Response(""), { model: "claude-sonnet-4.6", body, credentials: {} }, { repairEnabled: true, maxBytes: 4096, stallTimeoutMs: 1000 });
    expect(execute).toHaveBeenCalledTimes(1);
    const retry = execute.mock.calls[0][0].body;
    expect(retry).not.toHaveProperty("systemPrompt");
    expect(wireText(retry)).toContain("<instructions>\nRetry");
    expect(retry.conversationState.history).toEqual(body.conversationState.history);
    expect(wireText(body)).not.toContain("<instructions>\nRetry");
  });
});
