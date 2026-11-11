// anthropic-compatible gateways in front of Bedrock can reject Claude Desktop's deferred
// tools: the gateway adds the tool-search beta itself, and Bedrock answers
// 400 "unsupported beta header(s): tool-search-tool-2025-10-19". The executor then resends
// once with defer_loading removed (every tool loaded up front), on the same URL and account.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const BEDROCK_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error",
  message: "InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, RequestID: x, ValidationException: unsupported beta header(s): tool-search-tool-2025-10-19" } });
// Wording Bedrock switched to on 2026-11-11.
const BEDROCK_400_UNEXPECTED = JSON.stringify({ type: "error", error: { type: "invalid_request_error",
  message: "InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, RequestID: x, ValidationException: Unexpected value(s) `tool-search-tool-2025-10-19` for the `anthropic-beta` header. Please consult our documentation at ***.***.com/docs or try again without the header. (request id: y)" } });
const VALIDATION_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error",
  message: "InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, RequestID: x, ValidationException: Input validation failed. Check your request parameters and retry the request. (request id: y)" } });
const OTHER_400 =JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content: field required" } });

function res(status, text = "") {
  return new Response(text || "{}", { status, headers: { "content-type": "application/json" } });
}

const creds = { apiKey: "sk-test", connectionId: "c1", providerSpecificData: { baseUrl: "https://gw.invalid/anthropic/v1" } };
const body = () => ({
  model: "modelhub-claude/claude-opus-5-5",
  max_tokens: 64,
  tools: [
    { name: "Bash", description: "run", input_schema: { type: "object" } },
    { name: "mcp__srv__op1", description: "op", defer_loading: true, input_schema: { type: "object" } },
    { name: "mcp__srv__op2", description: "op", defer_loading: true, cache_control: { type: "ephemeral" }, input_schema: { type: "object" } },
  ],
  messages: [{ role: "user", content: "hi" }],
});
const sent = (i) => JSON.parse(fetchMock.mock.calls[i][1].body);

beforeEach(() => fetchMock.mockReset());

describe("anthropic-compatible: deferred-tools beta rejection", () => {
  it("resends once without defer_loading and returns that response", async () => {
    fetchMock.mockResolvedValueOnce(res(400, BEDROCK_400)).mockResolvedValueOnce(res(200));
    const ex = new DefaultExecutor("anthropic-compatible-test");
    const out = await ex.execute({ model: "modelhub-claude/claude-opus-5-5", body: body(), stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(0).tools.filter((t) => t.defer_loading)).toHaveLength(2);
    expect(sent(1).tools.some((t) => "defer_loading" in t)).toBe(false);
    expect(sent(1).tools.map((t) => t.name)).toEqual(["Bash", "mcp__srv__op1", "mcp__srv__op2"]);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
  });

  it("also resends on the 'Unexpected value(s) … anthropic-beta' wording", async () => {
    fetchMock.mockResolvedValueOnce(res(400, BEDROCK_400_UNEXPECTED)).mockResolvedValueOnce(res(200));
    const ex = new DefaultExecutor("anthropic-compatible-test");
    const out = await ex.execute({ model: "modelhub-claude/claude-opus-5-5", body: body(), stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).tools.some((t) => "defer_loading" in t)).toBe(false);
  });

  it("does not retry a Bedrock validation 400 that names no beta", async () => {
    fetchMock.mockResolvedValueOnce(res(400, VALIDATION_400));
    const ex = new DefaultExecutor("anthropic-compatible-test");
    const out = await ex.execute({ model: "modelhub-claude/claude-opus-5-5", body: body(), stream: false, credentials: creds });
    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry other 400s", async () => {
    fetchMock.mockResolvedValueOnce(res(400, OTHER_400));
    const ex = new DefaultExecutor("anthropic-compatible-test");
    const out = await ex.execute({ model: "modelhub-claude/claude-opus-5-5", body: body(), stream: false, credentials: creds });
    expect(out.response.status).toBe(400);
    expect(await out.response.text()).toContain("field required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when no tool is deferred", async () => {
    fetchMock.mockResolvedValueOnce(res(400, BEDROCK_400));
    const ex = new DefaultExecutor("anthropic-compatible-test");
    const b = body();
    b.tools = b.tools.map(({ defer_loading, ...t }) => t);
    const out = await ex.execute({ model: "modelhub-claude/claude-opus-5-5", body: b, stream: false, credentials: creds });
    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries at most once and passes the second rejection through", async () => {
    fetchMock.mockResolvedValueOnce(res(400, BEDROCK_400)).mockResolvedValueOnce(res(400, BEDROCK_400));
    const ex = new DefaultExecutor("anthropic-compatible-test");
    const out = await ex.execute({ model: "modelhub-claude/claude-opus-5-5", body: body(), stream: false, credentials: creds });
    expect(out.response.status).toBe(400);
    expect(await out.response.text()).toContain("tool-search-tool");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves non anthropic-compatible providers alone", async () => {
    fetchMock.mockResolvedValueOnce(res(400, BEDROCK_400));
    const ex = new DefaultExecutor("openai");
    const out = await ex.execute({ model: "gpt-x", body: body(), stream: false, credentials: { apiKey: "k" } });
    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("header timeout per provider", () => {
  it("gives anthropic-compatible gateways the longer streaming header budget", async () => {
    const { FETCH_CONNECT_TIMEOUT_MS, FETCH_GATEWAY_CONNECT_TIMEOUT_MS, FETCH_NONSTREAM_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js");
    expect(FETCH_GATEWAY_CONNECT_TIMEOUT_MS).toBeGreaterThan(FETCH_CONNECT_TIMEOUT_MS);
    expect(new DefaultExecutor("anthropic-compatible-test").connectTimeoutMs(true)).toBe(FETCH_GATEWAY_CONNECT_TIMEOUT_MS);
    expect(new DefaultExecutor("anthropic-compatible-test").connectTimeoutMs(false)).toBe(FETCH_NONSTREAM_TIMEOUT_MS);
    expect(new DefaultExecutor("openai").connectTimeoutMs(true)).toBe(FETCH_CONNECT_TIMEOUT_MS);
    expect(new DefaultExecutor("claude").connectTimeoutMs(true)).toBe(FETCH_CONNECT_TIMEOUT_MS);
  });
});
