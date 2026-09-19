/**
 * Responses namespace tools (codex `collaboration`, `clock`, code-mode `functions`)
 * must expand into individual chat functions on the request and split back into
 * `name` + `namespace` on the response, so the client router can route the call.
 *
 * The name mapping is carried per request on `_namespaceTools`. It must never live
 * on a module or global object: the gateway serves many concurrent requests, and a
 * shared map lets one session's namespaces rewrite another session's tool calls.
 */
import { describe, expect, it } from "vitest";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { splitToolName } from "../../open-sse/translator/concerns/toolCall.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const userMsg = [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }];

const namespaceTool = (name, subs) => ({
  type: "namespace",
  name,
  description: `${name} tools`,
  tools: subs.map((s) => ({ type: "function", name: s, description: s, parameters: { type: "object" } })),
});

const translate = (tools, input = userMsg) =>
  openaiResponsesToOpenAIRequest("m", { input, tools }, true, null);

const toolNames = (out) => out.tools.map((t) => t.function.name);

/** Drive the streaming response translator for one tool call and return the emitted item. */
function streamToolCall(flatName, namespaceTools) {
  const state = { ...initState(FORMATS.OPENAI_RESPONSES), namespaceTools };
  const events = [
    { id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: flatName, arguments: "" } }] }, finish_reason: null }] },
    { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ].flatMap((c) => openaiToOpenAIResponsesResponse(c, state));
  return events.find((e) => e.event === "response.output_item.added" && e.data.item?.type === "function_call").data.item;
}

describe("Responses namespace tools — request", () => {
  it("expands a namespace tool into individual {ns}__{subtool} functions", () => {
    const out = translate([namespaceTool("collaboration", ["spawn_agent", "wait_agent", "list_agents"])]);
    expect(toolNames(out)).toEqual([
      "collaboration__spawn_agent",
      "collaboration__wait_agent",
      "collaboration__list_agents",
    ]);
  });

  it("carries the name mapping on the request, not on a global", () => {
    const out = translate([namespaceTool("clock", ["curr_time"])]);
    expect(out._namespaceTools).toEqual({
      wire: { clock__curr_time: "clock.curr_time" },
      ns: { curr_time: "clock" },
    });
    expect(globalThis.__CB_NS_TOOLS__).toBeUndefined();
    expect(globalThis.__CB_TOOL_MAP__).toBeUndefined();
  });

  it("leaves flat tool names unchanged and emits no mapping", () => {
    const out = translate([{ type: "function", name: "get_weather", description: "w", parameters: { type: "object" } }]);
    expect(toolNames(out)).toEqual(["get_weather"]);
    expect(out._namespaceTools).toBeUndefined();
  });

  it("replays a namespaced history call under the wire name it was declared with", () => {
    const out = translate(
      [namespaceTool("collaboration", ["wait_agent"])],
      [
        ...userMsg,
        { type: "function_call", call_id: "c1", name: "wait_agent", namespace: "collaboration", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    );
    const replayed = out.messages.find((m) => m.tool_calls)?.tool_calls[0];
    expect(replayed.function.name).toBe("collaboration__wait_agent");
    expect(toolNames(out)).toContain("collaboration__wait_agent");
  });
});

describe("Responses namespace tools — response", () => {
  it("splits a namespaced tool call back into name + namespace", () => {
    const { _namespaceTools } = translate([namespaceTool("collaboration", ["spawn_agent"])]);
    const item = streamToolCall("collaboration__spawn_agent", _namespaceTools);
    expect(item.name).toBe("spawn_agent");
    expect(item.namespace).toBe("collaboration");
  });

  it("routes a sub-tool answered by its bare name back to its namespace", () => {
    const { _namespaceTools } = translate([namespaceTool("collaboration", ["wait_agent"])]);
    const item = streamToolCall("wait_agent", _namespaceTools);
    expect(item.name).toBe("wait_agent");
    expect(item.namespace).toBe("collaboration");
  });

  it("treats the default `functions` namespace as no namespace", () => {
    const { _namespaceTools } = translate([namespaceTool("functions", ["shell"])]);
    const item = streamToolCall("functions__shell", _namespaceTools);
    expect(item.name).toBe("shell");
    expect(item.namespace).toBeUndefined();
  });

  it("omits `namespace` entirely for a plain tool", () => {
    const item = streamToolCall("get_weather", undefined);
    expect(item.name).toBe("get_weather");
    expect(item).not.toHaveProperty("namespace");
  });
});

describe("Responses namespace tools — request isolation", () => {
  it("does not let a concurrent session rewrite another session's namespace", () => {
    // Same sub-tool name, two different namespaces, both in flight.
    const a = translate([namespaceTool("collaboration", ["wait_agent"])]);
    const b = translate([namespaceTool("scheduler", ["wait_agent"])]);

    expect(streamToolCall("wait_agent", a._namespaceTools).namespace).toBe("collaboration");
    expect(streamToolCall("wait_agent", b._namespaceTools).namespace).toBe("scheduler");
  });

  it("does not inject a namespace into a client that never sent one", () => {
    translate([namespaceTool("collaboration", ["shell"])]);
    // A plain Responses client whose own flat tool happens to be called `shell`.
    const plain = translate([{ type: "function", name: "shell", description: "sh", parameters: { type: "object" } }]);
    expect(plain._namespaceTools).toBeUndefined();
    expect(streamToolCall("shell", plain._namespaceTools)).not.toHaveProperty("namespace");
  });
});

describe("splitToolName", () => {
  it("restores a dotted tool name that was sanitized for strict providers", () => {
    const map = { wire: { "mcp__search": "mcp.search" }, ns: {} };
    expect(splitToolName("mcp__search", map)).toEqual({ name: "search", namespace: "mcp" });
  });

  it("passes an unknown name through untouched", () => {
    expect(splitToolName("plain_tool", { wire: {}, ns: {} })).toEqual({ name: "plain_tool" });
  });
});
