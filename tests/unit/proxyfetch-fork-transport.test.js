/**
 * Fork guards on the shared transport (open-sse/utils/proxyFetch.js), each tied to a
 * production failure:
 *  - Happy eyeballs must follow the process flags. Prod slots have no IPv6 route and run
 *    with --no-network-family-autoselection; a hardcoded autoSelectFamily:true on the
 *    Agent overrides that flag and brings back the 250 ms "fetch failed" (2026-11-06).
 *  - Requests go through Node's fetch with our undici Agents, so global FormData bodies
 *    stay multipart and responses stay real `Response`s (the package's undici 8 fetch
 *    sent FormData as "[object FormData]").
 *  - A headers timeout is never replayed on a fresh socket (the upstream may already be
 *    generating and billing it).
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

const ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "NINEROUTER_TLS_ECDH_CURVE"];

let server;
let base;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ contentType: req.headers["content-type"] || null, body: body.slice(0, 200) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("undici");
  vi.resetModules();
});

function clearProxyEnv() {
  for (const k of ENV_KEYS) vi.stubEnv(k, "");
}

async function loadWithAgentSpy() {
  const seen = [];
  vi.doMock("undici", async () => {
    const actual = await vi.importActual("undici");
    class SpyAgent extends actual.Agent {
      constructor(opts) { seen.push(opts); super(opts); }
    }
    class SpyProxyAgent extends actual.ProxyAgent {
      constructor(opts) { seen.push(opts); super(opts); }
    }
    return { ...actual, Agent: SpyAgent, ProxyAgent: SpyProxyAgent };
  });
  const mod = await import("../../open-sse/utils/proxyFetch.js");
  mod.resetDirectDispatchersForTests();
  return { mod, seen };
}

describe("proxyFetch fork transport guards", () => {
  it("builds direct, fresh-retry and proxy Agents from Node's family-autoselection defaults", async () => {
    clearProxyEnv();
    const prevFamily = net.getDefaultAutoSelectFamily();
    const prevTimeout = net.getDefaultAutoSelectFamilyAttemptTimeout();
    try {
      // What --no-network-family-autoselection does on the prod slots.
      net.setDefaultAutoSelectFamily(false);
      net.setDefaultAutoSelectFamilyAttemptTimeout(500);
      const { mod, seen } = await loadWithAgentSpy();
      await mod.getDirectDispatcher(false);
      await mod.getFreshRetryDispatcher(false);
      await mod.proxyAwareFetch(`${base}/x`, {}, { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9" }).catch(() => {});

      expect(seen.length).toBeGreaterThanOrEqual(3);
      for (const opts of seen) {
        expect(opts.connect.autoSelectFamily).toBe(false);
        expect(opts.connect.autoSelectFamilyAttemptTimeout).toBe(500);
      }
    } finally {
      net.setDefaultAutoSelectFamily(prevFamily);
      net.setDefaultAutoSelectFamilyAttemptTimeout(prevTimeout);
    }
  });

  it("keeps Node's curve list unless NINEROUTER_TLS_ECDH_CURVE pins one", async () => {
    clearProxyEnv();
    let { mod, seen } = await loadWithAgentSpy();
    await mod.getDirectDispatcher(false);
    expect(seen[0].connect.ecdhCurve).toBe(tls.DEFAULT_ECDH_CURVE);

    vi.doUnmock("undici");
    vi.resetModules();
    vi.stubEnv("NINEROUTER_TLS_ECDH_CURVE", "X25519");
    ({ mod, seen } = await loadWithAgentSpy());
    await mod.getDirectDispatcher(false);
    expect(seen[0].connect.ecdhCurve).toBe("X25519");
  });

  it("sends a global FormData body as multipart and returns a real Response", async () => {
    clearProxyEnv();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const fd = new FormData();
    fd.append("model", "whisper-1");
    fd.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "a.wav");

    const res = await proxyAwareFetch(`${base}/upload`, { method: "POST", body: fd });
    expect(res).toBeInstanceOf(Response);
    const seen = await res.json();
    expect(seen.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen.body).toContain('name="model"');
    expect(seen.body).not.toContain("[object FormData]");
  });

  it("does not treat a headers timeout as a dead socket", async () => {
    const { isStaleSocketError } = await import("../../open-sse/utils/proxyFetch.js");
    expect(isStaleSocketError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(true);
  });
});
