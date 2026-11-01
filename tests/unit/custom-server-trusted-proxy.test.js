// TRUSTED_PROXY_IPS: a non-loopback reverse proxy (the docker bridge gateway nginx
// connects from) whose X-Real-IP becomes the client IP. Without it every client behind
// that proxy shares one login-limiter bucket. Needs a non-loopback local address so the
// socket peer is not 127.0.0.1; skipped on hosts without one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import os from "node:os";

const require = createRequire(import.meta.url);

const lanIp = Object.values(os.networkInterfaces()).flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

const servers = [];
let seenHeaders;

// Load custom-server.js with the given env and boot a server through it. Each load wraps
// the pristine http.createServer so the two configs don't stack.
async function boot(trustedProxyIps) {
  const original = http.createServer;
  process.env.TRUSTED_PROXY_IPS = trustedProxyIps;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");
  const server = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.end("ok");
  });
  http.createServer = original;
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  servers.push(server);
  return `http://${lanIp}:${server.address().port}`;
}

async function get(baseUrl, headers = {}) {
  await fetch(baseUrl, { headers });
  return seenHeaders;
}

describe.skipIf(!lanIp)("custom-server trusted proxy IPs", () => {
  let trusted;
  let untrusted;

  beforeAll(async () => {
    trusted = await boot(`10.255.255.1, ${lanIp}`);
    untrusted = await boot("");
  });

  afterAll(async () => {
    delete process.env.TRUSTED_PROXY_IPS;
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  });

  it("adopts X-Real-IP from a trusted proxy peer", async () => {
    const headers = await get(trusted, { "x-real-ip": "203.0.113.7" });

    expect(headers["x-9r-real-ip"]).toBe("203.0.113.7");
    expect(headers["x-9r-via-proxy"]).toBe("1");
  });

  it("ignores X-Forwarded-For from a trusted proxy peer (its first hop is client-supplied)", async () => {
    const headers = await get(trusted, { "x-forwarded-for": "198.51.100.1, 203.0.113.7" });

    expect(headers["x-9r-real-ip"]).toBe(lanIp);
    expect(headers["x-9r-via-proxy"]).toBe("1");
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });

  it("keys a peer outside the list on its socket address", async () => {
    const headers = await get(untrusted, { "x-real-ip": "203.0.113.7" });

    expect(headers["x-9r-real-ip"]).toBe(lanIp);
  });
});
