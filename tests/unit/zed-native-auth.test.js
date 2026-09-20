// Acceptance suite for the Zed native-app auth fix.
// RUN WITH AN ISOLATED DB:  DATA_DIR=$(mktemp -d) npx vitest run unit/zed-native-auth.test.js
//
// Covers criteria:
//   1. Zed proxy starts
//   2. Stray callback (no params) MUST NOT kill session / stop proxy
//   3. Real callback (user_id + access_token) MUST complete session + save connection
//   4. RSA decrypt works (round-trip)
//   5. systemId identical authorize → exchange → stored connection
//   6. register-session failure is distinguishable (backend contract)
//   8. (backend) reopen/re-register creates a fresh session
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import {
  createZedNativeAuthData,
  parseZedCallbackPayload,
  decryptZedAccessToken,
} from "open-sse/shared/zedAuth.js";
import {
  startZedProxy,
  stopZedProxy,
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
} from "@/lib/oauth/utils/server.js";
import {
  generateAuthData,
  exchangeTokens,
} from "@/lib/oauth/providers/index.js";

const realFetch = globalThis.fetch;
const TOKEN = Buffer.alloc(48, 0x5a).toString("base64url");
const upstream = vi.hoisted(() => ({ status: 200, calls: [] }));
// Stub the transport boundary: proxyAwareFetch captures native fetch at import.
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, init) => {
    upstream.calls.push({ url: String(url), authorization: init.headers.Authorization });
    if (String(url) !== "https://cloud.zed.dev/client/users/me") throw new Error("Unexpected upstream call");
    if (upstream.status !== 200) return new Response("rejected", { status: upstream.status });
    return Response.json({ id: "user-123", email: "zed-native-test@example.com", default_organization_id: "org-test" });
  },
}));
beforeEach(() => {
  upstream.status = 200;
  upstream.calls.length = 0;
});
afterEach(() => {
  stopZedProxy();
  vi.restoreAllMocks();
});

async function startTestProxy() {
  const started = await startZedProxy(0); // random loopback port — parallel-safe
  expect(started.success).toBe(true);
  return started;
}

/** Simulate zed.dev: RSA-encrypt a plaintext token with the flow's public key. */
function encryptForCallback(publicKeyB64Url, plaintext, padding = crypto.constants.RSA_PKCS1_OAEP_PADDING) {
  const der = Buffer.from(String(publicKeyB64Url), "base64url");
  const key = crypto.createPublicKey({ key: der, format: "der", type: "pkcs1" });
  return crypto
    .publicEncrypt(
      { key, padding, oaepHash: "sha256" },
      Buffer.from(plaintext, "utf8"),
    )
    .toString("base64url");
}

describe("criterion 1 — Zed proxy starts", () => {
  it("binds 127.0.0.1 and reports a usable callback URL", async () => {
    const started = await startTestProxy();
    expect(started.port).toBeGreaterThan(0);
    expect(started.callbackUrl).toBe(`http://127.0.0.1:${started.port}/`);
  });
});

describe("criterion 4 — RSA decrypt works", () => {
  it("round-trips OAEP-SHA256 through the verifier slot", async () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const encrypted = encryptForCallback(auth.publicKey, TOKEN);
    expect(decryptZedAccessToken(encrypted, auth.privateKeyVerifier)).toBe(
      TOKEN,
    );
  });

  it("rejects a missing verifier instead of silently failing", () => {
    const auth = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const encrypted = encryptForCallback(auth.publicKey, "x");
    expect(() => decryptZedAccessToken(encrypted, null)).toThrow(
      /private key verifier/i,
    );
  });

  it("parser keeps strict validation (no weakened acceptance)", () => {
    expect(() => parseZedCallbackPayload("")).toThrow();
    expect(() => parseZedCallbackPayload("http://127.0.0.1:1/")).toThrow(
      /user_id and access_token/,
    );
    expect(() =>
      parseZedCallbackPayload("http://127.0.0.1:1/?user_id=only-user"),
    ).toThrow(/user_id and access_token/);
  });
});

describe("criterion 2 — stray callback MUST NOT kill session", () => {
  it("bare GET / leaves session pending and proxy listening", async () => {
    const started = await startTestProxy();
    const auth = createZedNativeAuthData({}, { nativeAppPort: started.port });
    expect(
      registerZedSession({ state: "stray-state-1", codeVerifier: auth.privateKeyVerifier }),
    ).toBe(true);

    const res = await realFetch(`http://127.0.0.1:${started.port}/`);
    expect(res.status).toBe(200);

    // Session must still be pending (not poisoned to error)…
    const session = getZedSessionStatus("stray-state-1");
    expect(session).not.toBeNull();
    expect(session.status).toBe("pending");

    // …and the SAME server must still own the port (no silent restart).
    const again = await startZedProxy(0);
    expect(again.port).toBe(started.port);

    clearZedSession("stray-state-1");
  });

  it("GET /callback with unrelated params leaves session pending", async () => {
    const started = await startTestProxy();
    const auth = createZedNativeAuthData({}, { nativeAppPort: started.port });
    registerZedSession({ state: "stray-state-2", codeVerifier: auth.privateKeyVerifier });

    const res = await realFetch(`http://127.0.0.1:${started.port}/callback?foo=bar`);
    expect(res.status).toBe(200);

    const session = getZedSessionStatus("stray-state-2");
    expect(session).not.toBeNull();
    expect(session.status).toBe("pending");
    clearZedSession("stray-state-2");
  });
});

describe("criterion 3 — real callback completes session + saves connection", () => {
  it.each([crypto.constants.RSA_PKCS1_OAEP_PADDING, crypto.constants.RSA_PKCS1_PADDING])("padding %s: verified callback persists the token", async (padding) => {
    const started = await startTestProxy();
    const auth = createZedNativeAuthData({}, { nativeAppPort: started.port });
    const state = `real-state-${Date.now()}`;
    registerZedSession({ state, codeVerifier: auth.privateKeyVerifier, systemId: auth.systemId });

    const encrypted = encryptForCallback(auth.publicKey, TOKEN, padding);
    const cb = new URL(`http://127.0.0.1:${started.port}/`);
    cb.searchParams.set("user_id", "user-123");
    cb.searchParams.set("access_token", encrypted);
    const res = await realFetch(cb.toString());
    expect(res.status).toBe(200);

    const session = getZedSessionStatus(state);
    expect(session).not.toBeNull();
    expect(session.status).toBe("done");
    expect(upstream.calls).toEqual([{ url: "https://cloud.zed.dev/client/users/me", authorization: `user-123 ${TOKEN}` }]);
    expect(session.connectionId).toBeTruthy();

    const { getProviderConnectionById } = await import("@/models/index.js");
    const conn = await getProviderConnectionById(session.connectionId);
    expect(conn).toBeTruthy();
    expect(conn.provider).toBe("zed");
    expect(conn.accessToken).toBe(TOKEN);
    expect(conn.providerSpecificData?.userId).toBe("user-123");
    expect(conn.providerSpecificData?.systemId).toBe(auth.systemId);

    // Proxy stopped itself after the terminal outcome (no orphan listener).
    const again = await startZedProxy(0);
    expect(again.port).not.toBe(started.port);
    stopZedProxy();
  });
});

describe("criterion 5 — systemId stable authorize → exchange → stored", () => {
  it("generateAuthData exposes the systemId sent to zed.dev", async () => {
    const auth = await generateAuthData("zed", "http://127.0.0.1:59999/", {
      nativeAppPort: 59999,
    });
    const url = new URL(auth.authUrl);
    expect(url.searchParams.get("native_app_port")).toBe("59999");
    // The system_id embedded in the sign-in URL must be observable downstream.
    expect(auth.systemId).toBe(url.searchParams.get("system_id"));
    expect(auth.systemId).toBeTruthy();
  });

  it("exchange preserves the registered systemId (no regeneration)", async () => {
    const auth = await generateAuthData("zed", "http://127.0.0.1:59998/", {
      nativeAppPort: 59998,
    });
    // Public key always rides in the authorize URL (mirrors the real flow).
    const pubFromUrl = new URL(auth.authUrl).searchParams.get("native_app_public_key");
    expect(pubFromUrl).toBeTruthy();
    const enc2 = encryptForCallback(pubFromUrl, TOKEN);
    const tokens = await exchangeTokens(
      "zed",
      `/?user_id=u1&access_token=${encodeURIComponent(enc2)}`,
      null,
      auth.codeVerifier,
      auth.state,
      { systemId: auth.systemId },
    );
    expect(tokens.providerSpecificData.systemId).toBe(auth.systemId);
  });
});

describe("criterion 6 — register-session failure is distinguishable", () => {
  it("route reports { success: false } when the verifier is missing", async () => {
    const { POST } = await import("@/app/api/oauth/[provider]/[action]/route.js");
    const req = new Request("http://localhost/api/oauth/zed/register-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "no-verifier-state" }),
    });
    const res = await POST(req, {
      params: Promise.resolve({ provider: "zed", action: "register-session" }),
    });
    const data = await res.json();
    // Backend contract: failure must be explicit (modal is required to check it).
    expect(data.success).toBe(false);
  });
});

describe("criterion 8 (backend) — re-register creates a fresh session", () => {
  it("a new register supersedes the old state cleanly", async () => {
    const a = createZedNativeAuthData({}, { nativeAppPort: 1 });
    const b = createZedNativeAuthData({}, { nativeAppPort: 1 });
    registerZedSession({ state: "old-state", codeVerifier: a.privateKeyVerifier });
    registerZedSession({ state: "new-state", codeVerifier: b.privateKeyVerifier });

    expect(getZedSessionStatus("old-state")).toBeNull();
    const fresh = getZedSessionStatus("new-state");
    expect(fresh).not.toBeNull();
    expect(fresh.status).toBe("pending");
    expect(fresh.codeVerifier).toBe(b.privateKeyVerifier);
    clearZedSession("new-state");
  });
});

describe("criterion L — decrypt failure errors the session but keeps the server", () => {
  it("wrong-key token → session error, listener survives for the live attempt", async () => {
    const started = await startTestProxy();
    const live = createZedNativeAuthData({}, { nativeAppPort: started.port });
    const other = createZedNativeAuthData({}, { nativeAppPort: started.port });
    const state = `wrongkey-state-${Date.now()}`;
    registerZedSession({ state, codeVerifier: live.privateKeyVerifier });

    // Token encrypted for a DIFFERENT keypair (e.g. superseded popup).
    const bad = encryptForCallback(other.publicKey, TOKEN);
    const cb = new URL(`http://127.0.0.1:${started.port}/`);
    cb.searchParams.set("user_id", "user-123");
    cb.searchParams.set("access_token", bad);
    const res = await realFetch(cb.toString());
    expect(res.status).toBe(200);

    const session = getZedSessionStatus(state);
    expect(session).not.toBeNull();
    expect(session.status).toBe("error");
    expect(session.error).toMatch(/decrypt/i);

    // Server must still be alive (same port) for the live attempt.
    const again = await startZedProxy(0);
    expect(again.port).toBe(started.port);
    clearZedSession(state);
  });
});


describe("credential verification before persistence", () => {
  it.each([401, 403, 500])("upstream %s fails closed and allows a verified retry", async (status) => {
    const { getProviderConnections } = await import("@/models/index.js");
    const before = (await getProviderConnections({ provider: "zed" })).map((c) => c.id).sort();
    const started = await startTestProxy();
    const auth = createZedNativeAuthData({}, { nativeAppPort: started.port });
    const state = `verification-${status}`;
    registerZedSession({ state, codeVerifier: auth.privateKeyVerifier });
    const cb = new URL(`http://127.0.0.1:${started.port}/`);
    cb.searchParams.set("user_id", "user-123");
    cb.searchParams.set("access_token", encryptForCallback(auth.publicKey, TOKEN));
    upstream.status = status;
    await realFetch(cb);
    expect(getZedSessionStatus(state)).toMatchObject({ status: "error", error: "Zed credential verification failed; retry sign-in" });
    expect(getZedSessionStatus(state).connectionId).toBeUndefined();
    expect((await getProviderConnections({ provider: "zed" })).map((c) => c.id).sort()).toEqual(before);
    expect((await startZedProxy(0)).port).toBe(started.port);
    upstream.status = 200;
    await realFetch(cb);
    expect(getZedSessionStatus(state).status).toBe("done");
    clearZedSession(state);
  });
});
