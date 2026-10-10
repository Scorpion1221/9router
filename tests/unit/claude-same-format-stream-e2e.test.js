// End-to-end regression for claude → claude streaming (Anthropic SDK clients that
// aren't Claude Code, e.g. Hermes). Same-format streams take the passthrough
// stream, not translateResponse, so this goes through handleChatCore and the
// real stream selection instead of unit-testing a single helper.
import { describe, it, expect, vi, beforeEach } from "vitest";

// proxyFetch captures globalThis.fetch at import, so the mock must be in place first.
const { fetchMock } = vi.hoisted(() => {
  const fetchMock = vi.fn();
  globalThis.fetch = (...args) => fetchMock(...args);
  return { fetchMock };
});

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const UPSTREAM = sse([
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG_A" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "terminal_ide", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\": " } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"ls\"}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  { type: "message_stop" },
]);

const BODY = {
  model: "claude-opus-5-5",
  max_tokens: 4096,
  stream: true,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "high" },
  tools: [{ name: "terminal", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  messages: [{ role: "user", content: [{ type: "text", text: "run ls" }] }],
};

const SDK_HEADERS = { "user-agent": "Anthropic/Python 0.87.0", "anthropic-beta": "interleaved-thinking-2025-05-14" };

let upstreamRequest;
let upstreamText;

const OAUTH = { accessToken: "sk-ant-oat01-test", connectionId: "c1" };
const tool = (name) => ({ name, description: "x", input_schema: { type: "object", properties: {} } });
const toolStream = (name, model = "claude-opus-5-5") => sse([
  { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
]);
const toolUseName = (events) => events.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use")?.content_block.name;

async function run(headers = SDK_HEADERS, { body = BODY, provider = "claude", model = "claude-opus-5-5", credentials = OAUTH } = {}) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const result = await handleChatCore({
    body: structuredClone(body),
    modelInfo: { provider, model },
    credentials,
    log,
    connectionId: "c1",
    clientRawRequest: { endpoint: "/v1/messages", body, headers },
    userAgent: headers["user-agent"],
    // What src/sse/handlers/chat.js passes for POST /v1/messages.
    sourceFormatOverride: "claude",
  });
  expect(result.success).toBe(true);
  const text = await result.response.text();
  const events = text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  return { text, events };
}

describe("claude → claude streaming (non-Claude-Code SDK client)", () => {
  beforeEach(() => {
    upstreamRequest = null;
    upstreamText = UPSTREAM;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url, opts = {}) => {
      upstreamRequest = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
      return new Response(upstreamText, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
  });

  it("restores cloaked tool names in the stream", async () => {
    const { events } = await run();
    // Request side cloaks the client tool for the OAuth account.
    expect(upstreamRequest.body.tools.map((t) => t.name)).toContain("terminal_ide");

    const toolStart = events.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(toolStart.content_block.name).toBe("terminal");
  });

  it("forwards signatures and tool argument deltas untouched", async () => {
    const { text, events } = await run();
    expect(events.find((e) => e.delta?.type === "signature_delta")?.delta.signature).toBe("SIG_A");
    const args = events.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("");
    expect(args).toBe("{\"command\": \"ls\"}");
    expect(text).not.toContain("terminal_ide");
  });

  it("keeps the client's thinking display on Opus 5.5 so summaries aren't redacted", async () => {
    await run();
    expect(upstreamRequest.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(upstreamRequest.headers["Anthropic-Beta"]).not.toContain("redact-thinking");
  });

  it("maps a cloaked name exactly once when the client declares both X and X_ide", async () => {
    upstreamText = toolStream("foo_ide_ide");
    const body = { ...BODY, tools: [tool("foo"), tool("foo_ide")] };
    const { events } = await run(SDK_HEADERS, { body });
    expect(toolUseName(events)).toBe("foo_ide");
  });

  it("leaves names that were never renamed alone (no suffix guessing)", async () => {
    // opencode fingerprint renames Bash → bash, so the stream carries a map,
    // but launch_ide is a real client tool and must come back unchanged.
    upstreamText = toolStream("launch_ide", "union-alpha");
    const body = { model: "union-alpha", max_tokens: 100, stream: true, tools: [tool("Bash"), tool("launch_ide")], messages: [{ role: "user", content: "hi" }] };
    const { events } = await run(SDK_HEADERS, { body, provider: "opencode", model: "union-alpha", credentials: {} });
    expect(toolUseName(events)).toBe("launch_ide");
  });

  it("does not touch Claude Code native passthrough", async () => {
    upstreamText = toolStream("terminal");
    const { events } = await run({ "user-agent": "claude-cli/2.1.0 (external, cli)" });
    expect(upstreamRequest.body.tools.map((t) => t.name)).toEqual(["terminal"]);
    expect(toolUseName(events)).toBe("terminal");
  });
});
