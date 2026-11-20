import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { estimateJsonLength, jsonPreview, truncateJsonField } from "../../open-sse/utils/truncateJson.js";
import { estimateInputTokens, estimateUsage } from "../../open-sse/utils/usageTracking.js";
import { createCodexTierAudit } from "../../open-sse/utils/codexTierAudit.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";

describe("truncateJson — bounded size & preview without giant JSON.stringify", () => {
  it("returns a detached copy for small payloads within maxSize", () => {
    const src = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hello" }] };
    const out = truncateJsonField(src, 5120);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    src.messages[0].content = "mutated";
    expect(out.messages[0].content).toBe("hello");
  });

  it("truncates multi-MB payloads without invoking JSON.stringify on the full object", () => {
    const bigText = "a".repeat(200_000);
    const huge = {
      model: "claude-opus-5-5",
      messages: Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `${i}:${bigText}` })),
    };

    const stringifySpy = vi.spyOn(JSON, "stringify");
    const t0 = performance.now();
    const out = truncateJsonField(huge, 5120);
    const elapsed = performance.now() - t0;
    const maxStringifiedArgLen = stringifySpy.mock.calls.reduce((mx, [arg]) => {
      if (typeof arg === "string") return Math.max(mx, arg.length);
      return mx;
    }, 0);
    stringifySpy.mockRestore();

    expect(out._truncated).toBe(true);
    expect(out._originalSize).toBeGreaterThan(4_000_000);
    expect(out._preview.length).toBeLessThanOrEqual(200);
    expect(out._preview).toContain('"model":"claude-opus-5-5"');
    // Only tiny preview slices (<= 200 chars) should ever reach JSON.stringify.
    expect(maxStringifiedArgLen).toBeLessThanOrEqual(200);
    expect(elapsed).toBeLessThan(100);
  });

  it("handles circular references safely and is idempotent on already-truncated values", () => {
    const circ = { a: 1 };
    circ.self = circ;
    const out = truncateJsonField(circ, 5120);
    expect(out._truncated).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(truncateJsonField(out, 5120)).toBe(out);
  });

  it("estimateInputTokens supports objects without full stringify and numeric precomputed counts", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(4000) }] };
    const tokens = estimateInputTokens(body);
    expect(tokens).toBeGreaterThanOrEqual(1000);
    expect(estimateInputTokens(tokens)).toBe(tokens);
    const usage = estimateUsage(tokens, 400);
    expect(usage.prompt_tokens).toBeGreaterThanOrEqual(tokens);
    expect(usage.estimated).toBe(true);
  });

  it("estimateJsonLength and jsonPreview respect bounds on deep/wide payloads", () => {
    const obj = { k: "v".repeat(500) };
    expect(estimateJsonLength(obj, 100).exceeded).toBe(true);
    expect(jsonPreview(obj, 50).length).toBe(50);
  });
});

describe("streaming closures release multi-MB request bodies immediately", () => {
  it("createCodexTierAudit snapshots scalar metadata up front and does not read mutated bodies on finish()", () => {
    const lines = [];
    const body = { model: "gpt-6.2-sol", service_tier: "priority" };
    const clientRawRequest = { body: { model: "gpt-6.2-sol-combos", service_tier: "fast" } };
    const finalBody = { service_tier: "priority" };
    const audit = createCodexTierAudit({
      provider: "codex",
      model: "gpt-6.2-sol",
      body,
      clientRawRequest,
      finalBody,
      status: 200,
      reqTag: "G",
      log: { line: (...args) => lines.push(args.join(" ")) },
    });

    // Mutate after creation: finish() must reflect the snapshot taken up front.
    body.model = "mutated";
    clientRawRequest.body.model = "mutated";
    clientRawRequest.body.service_tier = "default";
    finalBody.service_tier = "default";

    audit.observe({ type: "response.created", response: { service_tier: "auto" } });
    audit.observe({ type: "response.completed", response: { service_tier: "default" } });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("client_model=gpt-6.2-sol-combos");
    expect(lines[0]).toContain("client_tier=fast");
    expect(lines[0]).toContain("wire_tier=priority");
  });

  it("createSSEStream pre-estimates input tokens up front instead of retaining body until finish", async () => {
    const body = { messages: [{ role: "user", content: "w".repeat(8000) }] };
    let completedUsage = null;
    const ts = createPassthroughStreamWithLogger(
      "openai",
      null,
      "gpt-test",
      "c1",
      body,
      (_content, usage) => { completedUsage = usage; }
    );

    // Clear body immediately after stream creation; fallback estimation must still match original size.
    body.messages = [];

    const enc = new TextEncoder();
    const writer = ts.writable.getWriter();
    const reader = ts.readable.getReader();
    const readAll = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();

    await writer.write(enc.encode('data: {"choices":[{"delta":{"content":"hello world"},"finish_reason":null}]}\n\n'));
    await writer.write(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
    await writer.write(enc.encode("data: [DONE]\n\n"));
    await writer.close();
    await readAll;

    expect(completedUsage).toBeTruthy();
    expect(completedUsage.estimated).toBe(true);
    expect(completedUsage.prompt_tokens).toBeGreaterThanOrEqual(2000);
  });

  it("buildOnStreamComplete pre-truncates oversized request bodies once and returns reusable snapshots", () => {
    const hugeBody = { model: "claude-opus-5-5", messages: [{ role: "user", content: "z".repeat(20_000) }] };
    const { streamDetailId, detailRequest, detailProviderRequest } = buildOnStreamComplete({
      provider: "claude",
      model: "claude-opus-5-5",
      connectionId: "c1",
      apiKey: "sk-test",
      requestStartTime: Date.now(),
      body: hugeBody,
      stream: true,
      finalBody: hugeBody,
      translatedBody: null,
      clientRawRequest: { endpoint: "/v1/messages", body: hugeBody },
    });

    expect(streamDetailId).toBeTruthy();
    expect(detailRequest._truncated).toBe(true);
    expect(detailProviderRequest._truncated).toBe(true);
    expect(detailRequest._originalSize).toBeGreaterThan(20_000);
  });
});

describe("SQLite usageRepo, requestDetailsRepo, requestMetricsRepo, and /api/usage/stream", () => {
  let tempDir;
  let originalDataDir;
  let db;
  let adapter;
  let detailsRepo;
  let metricsRepo;

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-perf-fixes-"));
    process.env.DATA_DIR = tempDir;
    delete global._statsEmitter;
    delete global._pendingRequests;
    delete global._recentRing;
    delete global._connectionMapCache;
    delete global._statsEmitTimers;
    delete global.__9rRequestMetrics;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
    const { getAdapter } = await import("@/lib/db/driver.js");
    adapter = await getAdapter();
    detailsRepo = await import("@/lib/db/repos/requestDetailsRepo.js");
    metricsRepo = await import("@/lib/db/repos/requestMetricsRepo.js");
    metricsRepo.__test__.state.enabled = true;
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("usageDaily stores exact lastUsed timestamps so getUsageStats('7d'/'all') needs no usageHistory scan", async () => {
    const ts1 = new Date(Date.now() - 60_000).toISOString();
    const ts2 = new Date(Date.now() - 10_000).toISOString();

    await db.saveRequestUsage({
      timestamp: ts1,
      provider: "claude",
      model: "claude-opus-5-5",
      connectionId: "conn-1",
      apiKey: "sk-key-alpha-11111111",
      endpoint: "/v1/messages",
      tokens: { prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 80 },
      status: "ok",
    });
    await db.saveRequestUsage({
      timestamp: ts2,
      provider: "claude",
      model: "claude-opus-5-5",
      connectionId: "conn-1",
      apiKey: "sk-key-alpha-11111111",
      endpoint: "/v1/messages",
      tokens: { prompt_tokens: 200, completion_tokens: 30, cache_read_input_tokens: 150 },
      status: "ok",
    });

    // Delete raw usageHistory rows: 7d / all must still return exact ISO lastUsed purely from usageDaily.
    adapter.run("DELETE FROM usageHistory");

    const stats7d = await db.getUsageStats("7d");
    expect(stats7d.totalRequests).toBe(2);
    expect(stats7d.totalCachedTokens).toBe(230);
    expect(stats7d.byModel["claude-opus-5-5 (claude)"].lastUsed).toBe(ts2);
    expect(Object.values(stats7d.byAccount)[0].lastUsed).toBe(ts2);
    expect(Object.values(stats7d.byApiKey)[0].lastUsed).toBe(ts2);
    expect(Object.values(stats7d.byEndpoint)[0].lastUsed).toBe(ts2);
  });

  it("getUsageStats('24h'/'today') SQL aggregation matches cached tokens, legacy input_tokens, malformed JSON, and last10Minutes", async () => {
    const now = Date.now();
    const t1 = new Date(now - 2 * 60_000).toISOString();
    const t2 = new Date(now - 60_000).toISOString();
    const t3 = new Date(now - 30_000).toISOString();

    await db.saveRequestUsage({
      timestamp: t1,
      provider: "claude",
      model: "claude-opus-5-5",
      connectionId: "c1",
      apiKey: "sk-team-aaaa-1111",
      endpoint: "/v1/messages",
      tokens: { prompt_tokens: 500, completion_tokens: 50, cache_read_input_tokens: 400 },
      status: "ok",
    });

    // Legacy row where promptTokens=0 but JSON tokens has input_tokens + cached_tokens
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, 0, 0, 0.5, 'ok', ?, '{}')`,
      [t2, "claude", "claude-opus-5-5", "c1", null, "/v1/messages", JSON.stringify({ input_tokens: 120, output_tokens: 30, cached_tokens: 90 })]
    );

    // Malformed JSON row must not crash SQL json_extract
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
       VALUES(?, ?, ?, ?, ?, ?, 10, 5, 0.1, 'ok', '{bad-json', '{}')`,
      [t3, "codex", "gpt-6.2-sol", "c2", "", "/v1/responses"]
    );

    const stats24h = await db.getUsageStats("24h");
    expect(stats24h.totalRequests).toBe(3);
    expect(stats24h.totalPromptTokens).toBe(500 + 120 + 10);
    expect(stats24h.totalCompletionTokens).toBe(50 + 30 + 5);
    expect(stats24h.totalCachedTokens).toBe(400 + 90);
    expect(stats24h.byModel["claude-opus-5-5 (claude)"].requests).toBe(2);
    expect(stats24h.byModel["claude-opus-5-5 (claude)"].lastUsed).toBe(t2);
    expect(stats24h.byApiKey["local-no-key"].requests).toBe(2);

    const last10Total = stats24h.last10Minutes.reduce((sum, b) => sum + b.requests, 0);
    expect(last10Total).toBe(3);

    const chart24h = await db.getChartData("24h");
    expect(chart24h).toHaveLength(24);
    expect(chart24h.reduce((sum, b) => sum + b.requests, 0)).toBe(3);

    const chartToday = await db.getChartData("today");
    expect(chartToday).toHaveLength(24);
    expect(chartToday.reduce((sum, b) => sum + b.requests, 0)).toBe(3);
  });

  it("saveRequestDetail eagerly truncates oversized payloads before entering writeBuffer", async () => {
    await db.updateSettings({ enableObservability: true, observabilityBatchSize: 50, observabilityFlushIntervalMs: 60_000 });
    const reqObj = {
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      messages: [{ role: "user", content: "q".repeat(30_000) }],
    };

    await db.saveRequestDetail({
      id: "eager-1",
      provider: "claude",
      model: "claude-opus-5-5",
      status: "success",
      request: reqObj,
      providerRequest: { blob: "p".repeat(30_000) },
      response: { content: "ok" },
    });

    // Caller's object must not be mutated.
    expect(reqObj.headers.authorization).toBe("Bearer secret");
    // Buffered entry must already be compact and truncated before DB flush.
    const buffered = detailsRepo.__test__.writeBuffer.find((r) => r.id === "eager-1");
    expect(buffered).toBeDefined();
    expect(buffered.request._truncated).toBe(true);
    expect(buffered.providerRequest._truncated).toBe(true);
    expect(buffered.request._preview).not.toContain("Bearer secret");
  });

  it("getLastOkByConnection uses idx_rm_conn_ts backwards seek per connectionId", async () => {
    const now = Date.now();
    metricsRepo.recordRequestMetric({ ts: now - 5000, kind: "attempt", provider: "claude", connectionId: "c1", status: 200, outcome: "ok" });
    metricsRepo.recordRequestMetric({ ts: now - 2000, kind: "attempt", provider: "claude", connectionId: "c1", status: 429, outcome: "error" });
    metricsRepo.recordRequestMetric({ ts: now - 3000, kind: "attempt", provider: "claude", connectionId: "c2", status: 200, outcome: "ok" });
    metricsRepo.recordRequestMetric({ ts: now - 1000, kind: "request", provider: "claude", connectionId: "c2", status: 200, outcome: "ok" });
    metricsRepo.recordRequestMetric({ ts: now - 1000, kind: "attempt", provider: "codex", connectionId: "c3", status: 200, outcome: "ok" });
    await metricsRepo.flushRequestMetrics();

    const fast = await metricsRepo.getLastOkByConnection({ provider: "claude", connectionIds: ["c1", "c2", "c3", "missing"] });
    expect(fast.get("c1")).toBe(now - 5000);
    expect(fast.get("c2")).toBe(now - 3000);
    expect(fast.has("c3")).toBe(false);
    expect(fast.has("missing")).toBe(false);

    // Must match fallback full-group query on the same provider.
    const fallback = await metricsRepo.getLastOkByConnection({ provider: "claude" });
    expect([...fast.entries()].sort()).toEqual([...fallback.entries()].sort());

    const plan = adapter.all(
      "EXPLAIN QUERY PLAN SELECT ts FROM requestMetrics WHERE connectionId = ? AND kind = 'attempt' AND outcome = 'ok' AND +provider = ? ORDER BY ts DESC LIMIT 1",
      ["c1", "claude"]
    );
    expect(plan.map((r) => r.detail).join(" ")).toContain("idx_rm_conn_ts");
    expect(plan.map((r) => r.detail).join(" ")).not.toContain("TEMP B-TREE");
  });

  it("/api/usage/stream pushes live in-memory fields without calling getUsageStats and cleans up listeners", async () => {
    const getUsageStatsSpy = vi.fn(() => { throw new Error("SSE stream must never call getUsageStats"); });
    const usageDbMod = await import("@/lib/usageDb");
    vi.doMock("@/lib/usageDb", () => ({
      ...usageDbMod,
      getUsageStats: getUsageStatsSpy,
    }));

    const { GET } = await import("@/app/api/usage/stream/route.js");
    const res = await GET();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(first.done).toBe(false);
    const payload = JSON.parse(decoder.decode(first.value).replace(/^data:\s*/, "").trim());
    expect(payload).toHaveProperty("activeRequests");
    expect(payload).toHaveProperty("recentRequests");
    expect(payload).toHaveProperty("errorProvider");
    expect(payload).toHaveProperty("pending");
    expect(getUsageStatsSpy).not.toHaveBeenCalled();

    expect(usageDbMod.statsEmitter.listenerCount("update")).toBe(1);
    expect(usageDbMod.statsEmitter.listenerCount("pending")).toBe(1);

    usageDbMod.trackPendingRequest("claude-opus-5-5", "claude", "c1", true);
    usageDbMod.statsEmitter.emit("update");

    const second = await reader.read();
    const payload2 = JSON.parse(decoder.decode(second.value).replace(/^data:\s*/, "").trim());
    expect(payload2.pending.byModel["claude-opus-5-5 (claude)"]).toBe(1);
    expect(getUsageStatsSpy).not.toHaveBeenCalled();

    await reader.cancel();
    expect(usageDbMod.statsEmitter.listenerCount("update")).toBe(0);
    expect(usageDbMod.statsEmitter.listenerCount("pending")).toBe(0);
    vi.doUnmock("@/lib/usageDb");
  });

  it("/api/usage/stream does not leak listeners if client cancels during initial send", async () => {
    let releaseInitial;
    const usageDbMod = await import("@/lib/usageDb");
    vi.doMock("@/lib/usageDb", () => ({
      ...usageDbMod,
      getActiveRequests: () => new Promise((resolve) => {
        releaseInitial = () => resolve({ activeRequests: [], recentRequests: [], errorProvider: "", pending: { byModel: {}, byAccount: {} } });
      }),
    }));

    const { GET } = await import("@/app/api/usage/stream/route.js");
    const res = await GET();
    expect(usageDbMod.statsEmitter.listenerCount("update")).toBe(1);

    await res.body.cancel();
    expect(usageDbMod.statsEmitter.listenerCount("update")).toBe(0);
    expect(usageDbMod.statsEmitter.listenerCount("pending")).toBe(0);

    releaseInitial();
    await new Promise((r) => setTimeout(r, 10));
    expect(usageDbMod.statsEmitter.listenerCount("update")).toBe(0);
    expect(usageDbMod.statsEmitter.listenerCount("pending")).toBe(0);
    vi.doUnmock("@/lib/usageDb");
  });

  it("SQLite adapters use non-blocking PASSIVE mode for periodic WAL checkpoints", () => {
    for (const file of [
      "src/lib/db/adapters/betterSqliteAdapter.js",
      "src/lib/db/adapters/nodeSqliteAdapter.js",
      "src/lib/db/adapters/bunSqliteAdapter.js",
    ]) {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const start = src.indexOf("setInterval(");
      const end = src.indexOf("CHECKPOINT_INTERVAL_MS", start);
      const timerBlock = src.slice(start, end);
      expect(timerBlock).toContain("wal_checkpoint(PASSIVE)");
      expect(timerBlock).not.toContain("wal_checkpoint(TRUNCATE)");
    }
  });
});
