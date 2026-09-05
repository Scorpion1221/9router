import { describe, expect, it, vi } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
}));

describe("OpenAI passthrough stream termination", () => {
  it.each([
    ["upstream sentinel", "data: [DONE]\n\n"],
    ["missing sentinel", ""],
    ["duplicate sentinel", "data: [DONE]\n\ndata: [DONE]\n\n"],
    ["sentinel without final newline", "data: [DONE]"],
  ])("emits exactly one DONE for %s", async (_name, input) => {
    const bytes = new TextEncoder().encode(input);
    const stream = new ReadableStream({
      start(controller) {
        // Exercise a network boundary inside the sentinel, not only whole lines.
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    }).pipeThrough(createPassthroughStreamWithLogger("openai"));

    const output = await new Response(stream).text();
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(output).toContain("data: [DONE]\n\n");
  });
});
