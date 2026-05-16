import { describe, it, expect } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";

function makeLog() {
  const events = [];
  const push = (level) => (tag, msg, extra) => events.push({ level, tag, msg, extra });
  return {
    events,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

function sseStream(chunks, { abort = false } = {}) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      if (abort) controller.error(new Error("ResponseAborted"));
      else controller.close();
    },
  });
}

function sseResponse(chunks, { abort = false, status = 200 } = {}) {
  return new Response(sseStream(chunks, { abort }), {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("handleComboChat — stream-aware fallback", () => {
  it("falls back when model 1 returns 200 + SSE but stream is all-noise then EOF", async () => {
    const callOrder = [];
    const handleSingleModel = async (_body, modelStr) => {
      callOrder.push(modelStr);
      if (modelStr === "p/m1") {
        // 200 OK, content-type SSE, but only a ping then EOF — the exact shape
        // of a broken upstream that combo used to forward as empty.
        return sseResponse([`event: ping\ndata: {}\n\n`]);
      }
      if (modelStr === "p/m2") {
        return sseResponse([
          `data: {"choices":[{"delta":{"content":"hello"}}]}\n\n`,
          `data: [DONE]\n\n`,
        ]);
      }
      throw new Error(`unexpected model ${modelStr}`);
    };

    const log = makeLog();
    const res = await handleComboChat({
      body: { model: "test-combo", stream: true },
      models: ["p/m1", "p/m2"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });

    expect(res.status).toBe(200);
    expect(callOrder).toEqual(["p/m1", "p/m2"]);

    const text = await res.text();
    expect(text).toContain(`"content":"hello"`);
    expect(text).toContain("[DONE]");

    // Verify we logged the m1-empty event explicitly.
    const warned = log.events.find(e => e.level === "warn" && /stream empty/.test(e.msg));
    expect(warned, "expected a warn log about empty stream").toBeTruthy();
  });

  it("falls back when model 1 stream aborts mid-flight before any real content", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "p/m1") {
        return sseResponse([`event: ping\ndata: {}\n\n`], { abort: true });
      }
      return sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`]);
    };

    const res = await handleComboChat({
      body: { stream: true },
      models: ["p/m1", "p/m2"],
      handleSingleModel,
      log: makeLog(),
    });

    expect(calls).toEqual(["p/m1", "p/m2"]);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(`"content":"ok"`);
  });

  it("commits to model 1 without probing JSON (non-SSE) responses", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      return new Response(JSON.stringify({ id: "m1", choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const res = await handleComboChat({
      body: { stream: false },
      models: ["p/m1", "p/m2"],
      handleSingleModel,
      log: makeLog(),
    });

    // Only m1 was tried — JSON path bypasses probe.
    expect(calls).toEqual(["p/m1"]);
    const obj = await res.json();
    expect(obj.id).toBe("m1");
  });

  it("commits to model 1 when its SSE stream yields real content immediately", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      return sseResponse([`data: {"choices":[{"delta":{"content":"yo"}}]}\n\n`]);
    };
    const res = await handleComboChat({
      body: { stream: true },
      models: ["p/m1", "p/m2"],
      handleSingleModel,
      log: makeLog(),
    });
    expect(calls).toEqual(["p/m1"]);
    const text = await res.text();
    expect(text).toContain(`"content":"yo"`);
  });

  it("can be disabled via probeStreamFirstByte=false (legacy behavior)", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      // Empty stream — without probing, combo will commit anyway.
      return sseResponse([]);
    };
    const res = await handleComboChat({
      body: { stream: true },
      models: ["p/m1", "p/m2"],
      handleSingleModel,
      log: makeLog(),
      probeStreamFirstByte: false,
    });
    expect(calls).toEqual(["p/m1"]);
    // Body should be empty (the legacy bug — we're verifying the opt-out works as documented)
    expect(await res.text()).toBe("");
  });
});
