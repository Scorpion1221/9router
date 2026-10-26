// Client-disconnect propagation and upstream timeout handling.
//
// Production incident (2026-10-13): a cold-cache non-stream Opus request hit the
// 60s header timeout four times per account (249s each), the client gave up, and
// the gateway kept walking accounts and combo tiers for another 9-17 minutes.
// Combo tier 2 was also cut by an 8s first-content probe on a healthy relay.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only the test upstreams (https://x|a|b/...) reach fetchMock: modules imported here
// also make background fetches (model catalogs) that must not skew call counts.
const TEST_URL = /^https:\/\/[xab]\//;
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, ...rest) => (TEST_URL.test(String(url))
    ? fetchMock(url, ...rest)
    : Promise.resolve(new Response("{}", { status: 404 }))),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { probeFirstContent } = await import("../../open-sse/utils/streamProbe.js");
const { FETCH_CONNECT_TIMEOUT_MS, FETCH_NONSTREAM_TIMEOUT_MS, COMBO_PROBE_TIMEOUT_MS, STREAM_STALL_TIMEOUT_MS } =
  await import("../../open-sse/config/runtimeConfig.js");

const res = (status) => ({ status, headers: { get: () => "" } });
// A fetch that never answers; rejects with the abort reason, like undici does.
const hang = (_url, opts) => new Promise((_, reject) => {
  opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
});
const responseAborted = () => Object.assign(new Error("This operation was aborted"), { name: "ResponseAborted" });
const creds = { apiKey: "k" };
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("timeouts config", () => {
  it("gives non-stream requests a longer header budget than streams, under undici's 300s", () => {
    expect(FETCH_CONNECT_TIMEOUT_MS).toBe(60_000);
    expect(FETCH_NONSTREAM_TIMEOUT_MS).toBe(280_000);
    expect(FETCH_NONSTREAM_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it("probes combo streams for 60s, below the stall timeout", () => {
    expect(COMBO_PROBE_TIMEOUT_MS).toBe(60_000);
    expect(COMBO_PROBE_TIMEOUT_MS).toBeLessThan(STREAM_STALL_TIMEOUT_MS);
  });
});

describe("BaseExecutor — header timeout", () => {
  it("does not replay a timed-out request on the same url", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", timeoutMs: 20, retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockImplementation(hang);
    await expect(ex.execute({ model: "m", body: {}, stream: true, credentials: creds })).rejects.toThrow(/no response headers within 20ms/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("moves to the next url after a header timeout", async () => {
    const ex = new BaseExecutor("test", { baseUrls: ["https://a/api", "https://b/api"], timeoutMs: 20, retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockImplementationOnce(hang).mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: true, credentials: creds });
    expect(out.url).toBe("https://b/api");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats undici's own headers timeout the same way", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }));
    await expect(ex.execute({ model: "m", body: {}, stream: true, credentials: creds })).rejects.toThrow(/no response headers/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries real network errors", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: true, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits 280s for non-stream headers but 60s for streams", async () => {
    vi.useFakeTimers();
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockImplementation(hang);

    let nonStreamErr = null;
    ex.execute({ model: "m", body: {}, stream: false, credentials: creds }).catch((e) => { nonStreamErr = e; });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(nonStreamErr).toBeNull();
    await vi.advanceTimersByTimeAsync(220_000);
    expect(nonStreamErr?.message).toMatch(/within 280000ms \(stream=false\)/);

    let streamErr = null;
    ex.execute({ model: "m", body: {}, stream: true, credentials: creds }).catch((e) => { streamErr = e; });
    await vi.advanceTimersByTimeAsync(60_500);
    expect(streamErr?.message).toMatch(/within 60000ms \(stream=true\)/);
  });
});

describe("BaseExecutor — caller abort", () => {
  it("rethrows a client abort as-is, without retrying or sleeping", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 3000 } } });
    const ctrl = new AbortController();
    fetchMock.mockImplementation(hang);
    const started = Date.now();
    const run = ex.execute({ model: "m", body: {}, stream: false, credentials: creds, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(responseAborted()), 10);
    await expect(run).rejects.toMatchObject({ name: "ResponseAborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("stops retrying once the caller has gone", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    const ctrl = new AbortController();
    fetchMock.mockImplementation(async () => { ctrl.abort(); return res(502); });
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds, signal: ctrl.signal });
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function sseResponse(chunks, { hold = false } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      if (!hold) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("probeFirstContent", () => {
  it("passes as soon as Claude's message_start arrives", async () => {
    const resp = sseResponse(['event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n'], { hold: true });
    const probe = await probeFirstContent(resp, { timeoutMs: 1000 });
    expect(probe.ok).toBe(true);
  });

  it("reports bytes and elapsed time when only heartbeats arrive", async () => {
    const resp = sseResponse([": PING\n\n"], { hold: true });
    const probe = await probeFirstContent(resp, { timeoutMs: 30 });
    expect(probe).toMatchObject({ ok: false, reason: "timeout", bytes: 8 });
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(25);
  });

  it("uses the 60s default, not 8s, when no timeout is passed", async () => {
    vi.useFakeTimers();
    const resp = sseResponse([": PING\n\n"], { hold: true });
    let probe = null;
    probeFirstContent(resp).then((p) => { probe = p; });
    await vi.advanceTimersByTimeAsync(8_500);
    expect(probe).toBeNull();
    await vi.advanceTimersByTimeAsync(52_000);
    expect(probe).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("stops waiting as soon as the client aborts", async () => {
    const resp = sseResponse([], { hold: true });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    const started = Date.now();
    const probe = await probeFirstContent(resp, { timeoutMs: 60_000, signal: ctrl.signal });
    expect(probe).toMatchObject({ ok: false, reason: "aborted" });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("handleComboChat — slow first content", () => {
  it("keeps a healthy model whose first frame takes longer than 8s", async () => {
    vi.useFakeTimers();
    const slow = () => new Response(new ReadableStream({
      start(c) {
        setTimeout(() => c.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n')), 10_000);
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const tried = [];
    const run = handleComboChat({ body: {}, models: ["p/slow", "p/next"], handleSingleModel: async (_b, m) => { tried.push(m); return slow(); }, log: silentLog, comboName: "c" });
    await vi.advanceTimersByTimeAsync(10_500);
    const out = await run;
    expect(out.status).toBe(200);
    expect(tried).toEqual(["p/slow"]);
  });
});

describe("handleComboChat — client abort", () => {
  it("does not try the next model once the client has gone during the probe", async () => {
    const ctrl = new AbortController();
    const tried = [];
    const handleSingleModel = async (_b, m) => {
      tried.push(m);
      setTimeout(() => ctrl.abort(), 10);
      return sseResponse([], { hold: true });
    };
    const out = await handleComboChat({ body: {}, models: ["p/a", "p/b"], handleSingleModel, log: silentLog, comboName: "c", signal: ctrl.signal });
    expect(out.status).toBe(499);
    expect(tried).toEqual(["p/a"]);
  });

  it("stops waiting for answer content once the client has gone", async () => {
    // message_start passes the first-byte probe; the empty-content peek then waits
    // for text or a tool call and must not hold the stream for its full deadline.
    const ctrl = new AbortController();
    const tried = [];
    const handleSingleModel = async (_b, m) => {
      tried.push(m);
      setTimeout(() => ctrl.abort(), 10);
      return sseResponse(['event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n'], { hold: true });
    };
    const started = Date.now();
    const out = await handleComboChat({ body: {}, models: ["p/a", "p/b"], handleSingleModel, log: silentLog, comboName: "c", signal: ctrl.signal });
    expect(out.status).toBe(499);
    expect(tried).toEqual(["p/a"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not start at all when the client is already gone", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handleSingleModel = vi.fn();
    const out = await handleComboChat({ body: {}, models: ["p/a"], handleSingleModel, log: silentLog, comboName: "c", signal: ctrl.signal });
    expect(out.status).toBe(499);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });
});
