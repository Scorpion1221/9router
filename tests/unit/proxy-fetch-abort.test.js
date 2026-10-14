// proxyAwareFetch honors the caller's AbortSignal on the MITM DNS-bypass path
// (raw node:https to a resolved IP), and never resends a cancelled request
// direct after a proxy attempt.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "node:net";

const { resolve4Mock } = vi.hoisted(() => ({ resolve4Mock: vi.fn() }));

// Point the bypass's Google-DNS lookup at a local TCP server.
vi.mock("dns", async (orig) => {
  const real = await orig();
  class Resolver { setServers() {} resolve4(host, cb) { resolve4Mock(host).then((ips) => cb(null, ips), cb); } }
  return { ...real, default: { ...real, Resolver }, Resolver };
});

let connections = 0;
let server;
let port;

const sockets = new Set();

beforeEach(async () => {
  connections = 0;
  // Accepts the TLS ClientHello and never answers: the request just hangs.
  server = net.createServer((sock) => {
    connections++;
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  resolve4Mock.mockReset();
  resolve4Mock.mockResolvedValue(["127.0.0.1"]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

async function loadWithPort() {
  vi.resetModules();
  // createBypassRequest connects to HTTPS_PORT; route that to the local server.
  const realConnect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (p, host, cb) {
    if (p === 443 && host === "127.0.0.1") return realConnect.call(this, port, host, cb);
    return realConnect.apply(this, arguments);
  });
  return import("../../open-sse/utils/proxyFetch.js");
}

describe("proxyAwareFetch — MITM bypass honors abort", () => {
  it("rejects promptly and closes the socket when the caller aborts", async () => {
    const { proxyAwareFetch } = await loadWithPort();
    const ctrl = new AbortController();
    const started = Date.now();
    const run = proxyAwareFetch("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent", {
      method: "POST", body: "{}", signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(Object.assign(new Error("gone"), { name: "ResponseAborted" })), 50);
    await expect(run).rejects.toMatchObject({ name: "ResponseAborted" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(connections).toBe(1);
  });

  it("does not open a connection for an already-aborted signal", async () => {
    const { proxyAwareFetch } = await loadWithPort();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(proxyAwareFetch("https://daily-cloudcode-pa.googleapis.com/x", { method: "POST", body: "{}", signal: ctrl.signal }))
      .rejects.toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(0);
  });
});
