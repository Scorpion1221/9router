import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { __test__ as qoder } from "../../open-sse/executors/qoder.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import vertex from "../../open-sse/providers/registry/vertex.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("release merge fork compatibility", () => {
  it("keeps client thinking display with request-scoped native format metadata", () => {
    const body = { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } };
    const metadata = { capabilities: { reasoning: true, thinkingFormat: "claude-adaptive" } };
    applyThinking("openai", "account-native-model", body, "codex", undefined, metadata);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps every Responses instruction position while accepting upstream text-block normalization", () => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.5", {
      messages: [
        { role: "developer", content: [{ type: "text", text: "FIRST" }, { content: "SECOND" }] },
        { role: "user", content: "QUESTION" },
        { role: "developer", content: [{ content: "LATER_INSTRUCTION" }] },
        { role: "system", content: "FINAL_INSTRUCTION" },
      ],
    }, true);
    expect(out.instructions).toBe("FIRST\nSECOND");
    expect(out.input.map((m) => m.role)).toEqual(["user", "developer", "system"]);
    expect(out.input[1].content).toEqual([{ type: "input_text", text: "LATER_INSTRUCTION" }]);
    expect(out.input[2].content).toEqual([{ type: "input_text", text: "FINAL_INSTRUCTION" }]);
  });

  it("folds bare-block developer instructions without dropping the neighboring Claude user content", () => {
    const out = normalizeClaudePassthrough({
      system: "STABLE_SYSTEM",
      messages: [
        { role: "user", content: { type: "text", text: "USER_CONTENT" } },
        { role: "developer", content: { type: "text", text: "DEVELOPER_INSTRUCTION" } },
      ],
    }, "claude-sonnet-4.6");
    expect(out.system).toBe("STABLE_SYSTEM");
    expect(out.messages).toEqual([{ role: "user", content: [
      { type: "text", text: "USER_CONTENT" },
      { type: "text", text: "DEVELOPER_INSTRUCTION" },
    ] }]);
  });

  it("keeps Qoder developer instructions separate while retaining upstream image support", () => {
    const content = [{ type: "text", text: "IMAGE_QUESTION" }, { type: "image_url", image_url: { url: "https://example.test/image.png" } }];
    const out = qoder.normalizeMessages([
      { role: "system", content: "SYSTEM" },
      { role: "developer", content: [{ type: "text", text: "DEVELOPER" }] },
      { role: "user", content },
    ]);
    expect(out.systemText).toBe("SYSTEM\n\nDEVELOPER");
    expect(out.messages).toEqual([{ role: "user", content }]);
  });

  it("keeps the Codex transport User-Agent aligned with its declared compatibility version", () => {
    const headers = new CodexExecutor().buildHeaders({ accessToken: "test-only" }, true);
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["User-Agent"]).toContain(PROVIDERS.codex.cliVersion);
  });

  it("preserves Vertex embeddings when merging upstream video support", () => {
    expect(vertex.serviceKinds).toEqual(expect.arrayContaining(["llm", "embedding", "imageToText", "video"]));
    expect(vertex.embeddingConfig.models.some((m) => m.id === "gemini-embedding-001")).toBe(true);
    expect(vertex.videoConfig.baseUrl).toBe("https://aiplatform.googleapis.com");
  });
});
