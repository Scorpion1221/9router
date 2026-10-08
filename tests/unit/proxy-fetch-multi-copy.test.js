/**
 * Next bundles open-sse/utils/proxyFetch.js more than once (instrumentation + route
 * chunks). The first copy patches globalThis.fetch; a later copy must still call the
 * real fetch, not that patch. Otherwise the patch re-runs proxyAwareFetch with
 * proxyOptions=null and an env proxy (HTTP_PROXY / outbound-proxy setting) replaces
 * the per-connection proxy. vi.resetModules() gives a second copy.
 */

import http from "node:http";
import net from "node:net";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

const nativeFetch = globalThis.fetch;
let origin;
let connProxy;
let envProxy;

// Tunneling forward proxy (undici's ProxyAgent sends CONNECT) that counts its use.
function startProxy() {
  const server = http.createServer();
  server.hits = 0;
  server.on("connect", (req, clientSocket, head) => {
    server.hits++;
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

beforeAll(async () => {
  origin = http.createServer((req, res) => res.end("origin"));
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  connProxy = await startProxy();
  envProxy = await startProxy();
});

afterAll(async () => {
  for (const s of [origin, connProxy, envProxy]) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("proxyFetch loaded as two bundle copies", () => {
  it("keeps the connection proxy when an env proxy is also set", async () => {
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${envProxy.address().port}`);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");

    await import("open-sse/utils/proxyFetch.js");
    expect(globalThis.fetch).not.toBe(nativeFetch);

    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    connProxy.hits = 0;
    envProxy.hits = 0;
    const res = await proxyAwareFetch(`http://127.0.0.1:${origin.address().port}/`, {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: `http://127.0.0.1:${connProxy.address().port}`,
      strictProxy: true,
    });

    expect(await res.text()).toBe("origin");
    expect(connProxy.hits).toBe(1);
    expect(envProxy.hits).toBe(0);
  });
});
