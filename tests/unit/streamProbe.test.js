import { describe, it, expect } from "vitest";

import { probeFirstContent, isStreamingSseResponse } from "../../open-sse/utils/streamProbe.js";

function sseResponse(body, { contentType = "text/event-stream" } = {}) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

function streamFromChunks(chunks, { eofAfter = true, delayMs = 0 } = {}) {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        controller.enqueue(typeof c === "string" ? new TextEncoder().encode(c) : c);
      }
      if (eofAfter) controller.close();
      // else: leave open — caller must close/cancel
    },
  });
}

function streamThatAborts(noiseChunks = []) {
  // Emits some noise chunks then errors out — simulates Anthropic ResponseAborted.
  return new ReadableStream({
    async start(controller) {
      for (const c of noiseChunks) {
        controller.enqueue(new TextEncoder().encode(c));
      }
      controller.error(new Error("ResponseAborted"));
    },
  });
}

describe("isStreamingSseResponse", () => {
  it("returns true for text/event-stream", () => {
    expect(isStreamingSseResponse(sseResponse(streamFromChunks([])))).toBe(true);
  });
  it("returns false for application/json", () => {
    expect(
      isStreamingSseResponse(sseResponse(streamFromChunks([]), { contentType: "application/json" }))
    ).toBe(false);
  });
  it("returns false when body is null", () => {
    const r = new Response(null, { headers: { "Content-Type": "text/event-stream" } });
    expect(isStreamingSseResponse(r)).toBe(false);
  });
});

describe("probeFirstContent", () => {
  it("returns ok=true and replays buffered chunks when real content arrives", async () => {
    const realDelta = `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n`;
    const resp = sseResponse(streamFromChunks([realDelta]));

    const result = await probeFirstContent(resp, { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(result.wrapped).toBeInstanceOf(Response);

    // Drain wrapped — must contain the real delta byte-for-byte.
    const text = await result.wrapped.text();
    expect(text).toBe(realDelta);
  });

  it("skips heartbeat/ping noise then succeeds on real content", async () => {
    const ping = `event: ping\ndata: {"type":"ping"}\n\n`;
    const comment = `: keepalive\n\n`;
    const realDelta = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`;
    const resp = sseResponse(streamFromChunks([ping, comment, realDelta]));

    const result = await probeFirstContent(resp, { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    const text = await result.wrapped.text();
    // All three chunks must be replayed in order — downstream parsers depend on full SSE.
    expect(text).toBe(ping + comment + realDelta);
  });

  it("returns ok=false with reason=empty when stream ends after only noise", async () => {
    const ping = `event: ping\ndata: {"type":"ping"}\n\n`;
    const resp = sseResponse(streamFromChunks([ping]));

    const result = await probeFirstContent(resp, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("returns ok=false with reason=empty when stream is fully empty", async () => {
    const resp = sseResponse(streamFromChunks([]));
    const result = await probeFirstContent(resp, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("returns ok=false with reason starting with 'error:' on upstream abort with only noise", async () => {
    const resp = sseResponse(streamThatAborts([`event: ping\ndata: {}\n\n`]));
    const result = await probeFirstContent(resp, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^error:/);
  });

  it("returns ok=false with reason=timeout when no chunk arrives before deadline", async () => {
    // Stream that never produces anything until well after the timeout.
    const resp = sseResponse(
      streamFromChunks([`data: {"x":1}\n\n`], { delayMs: 200 })
    );
    const result = await probeFirstContent(resp, { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("treats orphan [DONE] as noise", async () => {
    const done = `data: [DONE]\n\n`;
    const resp = sseResponse(streamFromChunks([done]));
    const result = await probeFirstContent(resp, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });
});
