import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";

/**
 * Chat Completions clients (Hermes in OpenAI mode, any OpenAI SDK) talking to a
 * Claude upstream. Claude reports input_tokens EXCLUSIVE of cache, with the cache
 * read/write split out; the client expects prompt_tokens INCLUSIVE of cache and the
 * split in prompt_tokens_details. Before the fix:
 *  - streaming dropped prompt_tokens_details, so clients counted 0 cache;
 *  - stream:false reported only the uncached input_tokens as prompt_tokens;
 *  - the stored usage added the cache to an already-inclusive prompt (2x).
 */

const CLAUDE_USAGE = { input_tokens: 4, cache_read_input_tokens: 9395, cache_creation_input_tokens: 10, output_tokens: 7 };
const INCLUSIVE_PROMPT = 4 + 9395 + 10;

function claudeStream() {
  return [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 4, cache_read_input_tokens: 9395, cache_creation_input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
}

async function runStream(chunks) {
  const encoder = new TextEncoder();
  const input = chunks.map((c) => `event: ${c.type}\ndata: ${JSON.stringify(c)}\n\n`).join("");
  const stream = new ReadableStream({ start(c) { c.enqueue(encoder.encode(input)); c.close(); } });
  let stored;
  const onStreamComplete = (_content, usage) => { stored = usage; };
  const out = stream.pipeThrough(createSSETransformStreamWithLogger(
    FORMATS.CLAUDE, FORMATS.OPENAI, "claude", null, null, "claude-opus-5-5", null, null, onStreamComplete));
  const text = await new Response(out).text();
  const events = text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  return { events, stored };
}

describe("Claude upstream → Chat Completions client: cache usage", () => {
  it("streaming final chunk carries cache-inclusive prompt and the cache split", async () => {
    const { events } = await runStream(claudeStream());
    const usage = events.findLast((e) => e.usage)?.usage;
    expect(usage.prompt_tokens).toBe(INCLUSIVE_PROMPT + 2000);
    expect(usage.completion_tokens).toBe(7);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 9395, cache_creation_tokens: 10 });
  });

  it("streaming stores cache-inclusive prompt once (no double count)", async () => {
    const { stored } = await runStream(claudeStream());
    const canonical = canonicalizeUsage(stored);
    expect(canonical.prompt_tokens).toBe(INCLUSIVE_PROMPT);
    expect(canonical.cached_tokens).toBe(9395);
    expect(canonical.cache_creation_input_tokens).toBe(10);
  });

  it("message_delta repeating the cache fields (current Anthropic shape) still counts them once", async () => {
    const chunks = claudeStream();
    chunks[4] = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { ...CLAUDE_USAGE } };
    const { events, stored } = await runStream(chunks);
    expect(events.findLast((e) => e.usage).usage.prompt_tokens_details).toEqual({ cached_tokens: 9395, cache_creation_tokens: 10 });
    expect(canonicalizeUsage(stored).prompt_tokens).toBe(INCLUSIVE_PROMPT);
  });

  it("stream:false reports cache-inclusive prompt and the cache split", () => {
    const body = { id: "msg_2", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: CLAUDE_USAGE };
    const out = translateNonStreamingResponse(body, FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(out.usage.prompt_tokens).toBe(INCLUSIVE_PROMPT);
    expect(out.usage.completion_tokens).toBe(7);
    expect(out.usage.total_tokens).toBe(INCLUSIVE_PROMPT + 7);
    expect(out.usage.prompt_tokens_details).toEqual({ cached_tokens: 9395, cache_creation_tokens: 10 });
  });

  it("no cache fields → no prompt_tokens_details", () => {
    const body = { id: "msg_3", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 3 } };
    const out = translateNonStreamingResponse(body, FORMATS.CLAUDE, FORMATS.OPENAI);
    expect(out.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  });
});

describe("USAGE_BUFFER_TOKENS", () => {
  it("0 reports the upstream input count unpadded", async () => {
    const { vi } = await import("vitest");
    const prev = process.env.USAGE_BUFFER_TOKENS;
    process.env.USAGE_BUFFER_TOKENS = "0";
    vi.resetModules();
    try {
      const { addBufferToUsage } = await import("../../open-sse/utils/usageTracking.js");
      expect(addBufferToUsage({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }).prompt_tokens).toBe(100);
    } finally {
      if (prev === undefined) delete process.env.USAGE_BUFFER_TOKENS; else process.env.USAGE_BUFFER_TOKENS = prev;
      vi.resetModules();
    }
  });
});
