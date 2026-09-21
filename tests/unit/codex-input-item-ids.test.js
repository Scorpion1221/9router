import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

const model = "gpt-6-astra";

describe("CodexExecutor replayed input item IDs", () => {
  it.each(["item_foreign", "unknown-prefix", "", "msg_known", "rs_known", "fc_known", "resp_known"])(
    "strips %j from all replayed item types without changing their payloads",
    (id) => {
      const input = [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "History" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking" }], encrypted_content: "opaque-reasoning" },
        { type: "function_call", call_id: "item_call_1", name: "lookup", arguments: '{"id":"item_argument"}' },
        { type: "function_call_output", call_id: "item_call_1", output: '{"id":"item_result"}' },
        { type: "custom_tool_call", call_id: "item_call_2", name: "apply_patch", input: "patch" },
        { type: "custom_tool_call_output", call_id: "item_call_2", output: "done" },
      ];
      const body = new CodexExecutor().transformRequest(model, {
        model,
        input: input.map((item) => ({ ...structuredClone(item), id })),
      }, true, {});

      expect(body.input).toEqual(input);
      expect(body.input.every((item) => !Object.hasOwn(item, "id"))).toBe(true);
      expect(body.store).toBe(false);
    },
  );

  it("preserves ID-free history and non-string IDs without throwing", () => {
    const input = [
      { role: "user", content: "Hello" },
      { type: "message", id: null, role: "assistant", content: "Hi" },
      { type: "message", id: 42, role: "user", content: "Continue" },
      null,
      ["nested-array"],
    ];
    const body = new CodexExecutor().transformRequest(model, {
      model, input: structuredClone(input),
    }, true, {});

    expect(body.input).toEqual(input);
  });

  it("still drops stored references while preserving ordinary string content", () => {
    const message = { type: "message", role: "user", content: "Continue" };
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: [
        "rs_stored", "fc_stored", "resp_stored", "msg_stored",
        { type: "item_reference", id: "item_foreign" },
        { type: "item_reference", id: "msg_stored" },
        "ordinary text", message,
      ],
    }, true, {});

    expect(body.input).toEqual(["ordinary text", message]);
  });

  it("also strips foreign IDs on the compact path", () => {
    const input = [{ type: "message", role: "assistant", content: "Summary" }];
    const body = new CodexExecutor().transformRequest(model, {
      model, _compact: true, input: [{ ...input[0], id: "item_foreign" }],
    }, true, {});

    expect(body.input).toEqual(input);
  });
});
