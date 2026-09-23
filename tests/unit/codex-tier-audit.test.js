import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { createCodexTierAudit } from "../../open-sse/utils/codexTierAudit.js";

const sse = [
  'event: response.created',
  'data: {"type":"response.created","response":{"service_tier":"auto"}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"status":"completed","service_tier":"default"}}',
  '',
  'data: [DONE]',
  '',
].join("\n");

function audit(log) {
  return createCodexTierAudit({
    provider: "codex",
    model: "gpt-6-sol",
    body: { model: "gpt-6-sol-combos", service_tier: "priority", input: "secret prompt" },
    finalBody: { service_tier: "priority", input: "secret prompt", token: "secret key" },
    status: 200,
    reqTag: "🟢",
    log,
  });
}

function source(text) {
  return new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      controller.enqueue(bytes.slice(0, 37));
      controller.enqueue(bytes.slice(37));
      controller.close();
    },
  });
}

describe("Codex tier audit", () => {
  it("logs client, wire and final upstream tiers once without content", async () => {
    const log = { line: vi.fn() };
    const transformed = source(sse).pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex",
      null, null, "gpt-6-sol", null, null, null, null, null, null, null, audit(log),
    ));

    const output = await new Response(transformed).text();
    expect(output).toContain('"type":"response.completed"');
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(log.line).toHaveBeenCalledTimes(1);
    const entry = log.line.mock.calls[0][2];
    expect(entry).toContain("client_model=gpt-6-sol-combos upstream_model=gpt-6-sol");
    expect(entry).toContain("client_tier=priority wire_tier=priority created_tier=auto completed_tier=default terminal=response.completed http=200");
    expect(entry).not.toContain("secret");
  });

  it("observes passthrough terminal events without changing bytes", async () => {
    const log = { line: vi.fn() };
    const input = sse.replace(/\n$/, "");
    const transformed = source(input).pipeThrough(createPassthroughStreamWithLogger(
      "codex", null, "gpt-6-sol", null, null, null, null, audit(log),
    ));
    const output = await new Response(transformed).text();
    expect(output).toContain('"type":"response.completed"');
    expect(log.line).toHaveBeenCalledTimes(1);
    expect(log.line.mock.calls[0][2]).toContain("completed_tier=default");
  });

  it("observes Responses to Chat Completions translation used by Hermes", async () => {
    const log = { line: vi.fn() };
    const transformed = source(sse).pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "codex",
      null, null, "gpt-6-sol", null, null, null, null, null, null, null, audit(log),
    ));
    const output = await new Response(transformed).text();
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(log.line).toHaveBeenCalledTimes(1);
    expect(log.line.mock.calls[0][2]).toContain("wire_tier=priority created_tier=auto completed_tier=default");
  });

  it("observes forced-stream to JSON without exposing tier metadata in the result", async () => {
    const log = { line: vi.fn() };
    const result = await convertResponsesStreamToJson(source(sse), audit(log));
    expect(result.status).toBe("completed");
    expect(result).not.toHaveProperty("service_tier");
    expect(log.line).toHaveBeenCalledTimes(1);
    expect(log.line.mock.calls[0][2]).toContain("completed_tier=default");
  });

  it("reports missing tier and incomplete streams honestly", () => {
    const log = { line: vi.fn() };
    const tierAudit = createCodexTierAudit({ provider: "codex", model: "gpt-6-sol", body: {}, finalBody: {}, status: 200, reqTag: "🟢", log });
    tierAudit.observe({ type: "response.created", response: { service_tier: "auto" } });
    tierAudit.finish();
    tierAudit.finish();
    expect(log.line).toHaveBeenCalledTimes(1);
    expect(log.line.mock.calls[0][2]).toContain("client_tier=missing wire_tier=missing created_tier=auto completed_tier=missing terminal=incomplete");
  });
});
