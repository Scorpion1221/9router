// Antigravity Enterprise (Gemini Enterprise login) → Business AI Code.
import { describe, expect, it } from "vitest";
import { parseAntigravityKeyringValue, parseAntigravityEnterpriseBundle } from "../../src/lib/oauth/utils/antigravityEnterpriseCredentials.js";
import { toProviderConnectionResponse } from "../../src/lib/providerConnectionResponse.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";

const keyringJson = {
  token: { access_token: "ya29.a", token_type: "Bearer", refresh_token: "1//r", expiry: "2026-11-23T08:27:33Z" },
  auth_method: "gcp",
  project_id: "proj-x",
  region: "global",
  user_tier: "gcp-ge-plus-tier",
  tier_display_name: "Gemini Enterprise Plus",
};

const creds = {
  accessToken: "ya29.a",
  projectId: "proj-x",
  providerSpecificData: { userTier: "gcp-ge-plus-tier", region: "global" },
};

describe("antigravity-enterprise keychain import", () => {
  it("decodes the go-keyring base64 payload", () => {
    const raw = `go-keyring-base64:${Buffer.from(JSON.stringify(keyringJson)).toString("base64")}\n`;
    expect(parseAntigravityKeyringValue(raw)).toEqual({
      authMethod: "gcp",
      accessToken: "ya29.a",
      refreshToken: "1//r",
      expiresAt: "2026-11-23T08:27:33Z",
      projectId: "proj-x",
      region: "global",
      userTier: "gcp-ge-plus-tier",
      tierDisplayName: "Gemini Enterprise Plus",
    });
  });

  it("accepts a plain JSON value too", () => {
    expect(parseAntigravityKeyringValue(JSON.stringify(keyringJson)).projectId).toBe("proj-x");
  });
});

describe("antigravity-enterprise executor", () => {
  const executor = getExecutor("antigravity-enterprise");

  it("keeps no OAuth client in the registry (it is stored per connection)", () => {
    expect(PROVIDERS["antigravity-enterprise"].clientId).toBeUndefined();
    expect(PROVIDERS["antigravity-enterprise"].clientSecret).toBeUndefined();
  });

  it("does not refresh without a stored client", async () => {
    expect(await executor.refreshCredentials({ refreshToken: "1//r", providerSpecificData: {} })).toBeNull();
  });

  it("targets the BAIC location resource", () => {
    expect(executor.buildUrl("gemini-4-carbon-medium", true, 0, creds)).toBe(
      "https://businessaicode.googleapis.com/v1beta/projects/proj-x/locations/global:streamGenerateContent?alt=sse",
    );
    expect(executor.buildUrl("gemini-4-carbon-medium", false, 0, creds)).toBe(
      "https://businessaicode.googleapis.com/v1beta/projects/proj-x/locations/global:generateContent",
    );
  });

  it("refuses to build a URL without a project", () => {
    expect(() => executor.buildUrl("m", true, 0, { providerSpecificData: {} })).toThrow(/project/);
  });

  it("adds model + entitlement to the translated Gemini body", () => {
    const translated = translateRequest(
      FORMATS.OPENAI, FORMATS.GEMINI, "gemini-4-carbon-medium",
      { model: "gemini-4-carbon-medium", messages: [{ role: "user", content: "hi" }], stream: true },
      true, creds, "antigravity-enterprise",
    );
    const body = executor.transformRequest("gemini-4-carbon-medium", translated, true, creds);
    expect(body.model).toBe("gemini-4-carbon-medium");
    expect(body.entitlement).toEqual({ userTier: "gcp-ge-plus-tier" });
    expect(body.contents[0].parts[0].text).toBe("hi");
    // BAIC 400s on HarmCategory values it doesn't know.
    expect((body.safetySettings || []).map((x) => x.category)).not.toContain("HARM_CATEGORY_CIVIC_INTEGRITY");
  });

  it("replaces placeholder thought signatures with the skip marker, keeps real ones", () => {
    const body = executor.transformRequest("m", {
      contents: [
        { role: "model", parts: [{ functionCall: { name: "a", args: {} }, thoughtSignature: DEFAULT_THINKING_AG_SIGNATURE }] },
        { role: "model", parts: [{ functionCall: { name: "b", args: {} }, thoughtSignature: "real-sig" }] },
      ],
    }, true, creds);
    expect(body.contents[0].parts[0].thoughtSignature).toBe("skip_thought_signature_validator");
    expect(body.contents[1].parts[0].thoughtSignature).toBe("real-sig");
  });
});

describe("antigravity-enterprise pasted bundle", () => {
  const good = {
    clientId: "123456-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com",
    clientSecret: "GOCSPX-test",
    refreshToken: "1//r",
    projectId: "proj-x",
    userTier: "gcp-ge-plus-tier",
  };

  it("accepts the JSON produced by Read from this Mac", () => {
    expect(parseAntigravityEnterpriseBundle(JSON.stringify(good))).toMatchObject({ ...good, region: "global" });
  });

  it("names the missing fields", () => {
    expect(() => parseAntigravityEnterpriseBundle({ ...good, refreshToken: "", userTier: "" })).toThrow(/refreshToken, userTier/);
  });

  it("rejects a non-Google client id and an odd region", () => {
    expect(() => parseAntigravityEnterpriseBundle({ ...good, clientId: "x" })).toThrow(/client id/);
    expect(() => parseAntigravityEnterpriseBundle({ ...good, region: "../x" })).toThrow(/region/);
  });

  it("never sends the stored client secret to the dashboard", () => {
    const out = toProviderConnectionResponse({
      provider: "antigravity-enterprise",
      accessToken: "a",
      refreshToken: "r",
      providerSpecificData: { clientId: good.clientId, clientSecret: "GOCSPX-test", userTier: "t" },
    });
    expect(out.providerSpecificData).toEqual({ clientId: good.clientId, userTier: "t" });
    expect(out.refreshToken).toBeUndefined();
  });
});

describe("antigravity-enterprise weekly quota", async () => {
  const { parseAntigravityEnterpriseQuota } = await import("../../open-sse/services/usage/antigravity-enterprise.js");
  const { recordQuotaPoll, getQuotaSnapshot, isQuotaProvider, __resetQuotaStateForTests } = await import("../../open-sse/services/quotaState.js");
  const { selectPollableConnections } = await import("../../src/sse/services/quotaPoller.js");
  const body = {
    groups: [{
      displayName: "Gemini Enterprise Quota",
      buckets: [{ bucketId: "gemini-enterprise-weekly", displayName: "Weekly", window: "weekly", resetTime: "2026-11-30T10:26:48Z", remainingFraction: 0.75 }],
    }],
    overageInfo: {},
  };

  it("maps the weekly bucket to a usage window", () => {
    const usage = parseAntigravityEnterpriseQuota(body, 1000);
    expect(usage.fetchedAt).toBe(1000);
    expect(usage.quotas.weekly).toMatchObject({ used: 25, remaining: 75, resetAt: "2026-11-30T10:26:48Z", windowSeconds: 604800 });
  });

  it("feeds the 7d window of the live quota store", () => {
    __resetQuotaStateForTests();
    expect(isQuotaProvider("antigravity-enterprise")).toBe(true);
    recordQuotaPoll("antigravity-enterprise", "c1", parseAntigravityEnterpriseQuota(body, Date.now()));
    const w = getQuotaSnapshot("c1").windows;
    expect(Object.keys(w)).toEqual(["7d"]);
    expect(w["7d"].usedPct).toBe(25);
    expect(w["7d"].resetAt).toBe(Date.parse("2026-11-30T10:26:48Z"));
  });

  it("is polled like Claude/Codex accounts", () => {
    const rows = [
      { id: "a", provider: "antigravity-enterprise", authType: "oauth", isActive: true },
      { id: "b", provider: "antigravity-enterprise", authType: "oauth", isActive: false },
      { id: "c", provider: "antigravity", authType: "oauth", isActive: true },
    ];
    expect(selectPollableConnections(rows).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("antigravity-enterprise model names and errors", async () => {
  const { getModelUpstreamId } = await import("../../open-sse/config/providerModels.js");
  const executor = getExecutor("antigravity-enterprise");

  it("maps bare names to a level BAIC accepts", () => {
    expect(getModelUpstreamId("age", "gemini-4-neon")).toBe("gemini-4-neon-medium");
    expect(getModelUpstreamId("age", "gemini-3.1-pro")).toBe("gemini-3.1-pro-high");
    expect(getModelUpstreamId("age", "gemini-4-neon", { reasoning_effort: "low" })).toBe("gemini-4-neon-low");
    expect(getModelUpstreamId("age", "gemini-4-carbon-high")).toBe("gemini-4-carbon-high");
  });

  it("sends the resolved upstream model, not the client's bare name", () => {
    const out = executor.transformRequest("gemini-4-neon", { model: "gemini-4-neon-medium", contents: [] }, true, creds);
    expect(out.model).toBe("gemini-4-neon-medium");
  });

  it("locks until RetryInfo on a quota 429", () => {
    const body = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3600s" }] } });
    const r = executor.parseError({ status: 429, headers: new Headers() }, body);
    expect(r.resetsAtMs - Date.now()).toBeGreaterThan(3590_000);
  });
});

describe("Gemini non-stream reply for a Responses client", async () => {
  const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
  it("comes back as a Responses object, not chat.completion", () => {
    const gemini = { candidates: [{ content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 }, modelVersion: "gemini-4-neon" };
    const out = translateNonStreamingResponse(gemini, FORMATS.GEMINI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out.output.flatMap((o) => o.content || []).find((c) => c.type === "output_text")?.text).toBe("pong");
    const claude = translateNonStreamingResponse(gemini, FORMATS.GEMINI, FORMATS.CLAUDE);
    expect(claude.type).toBe("message");
    expect(claude.content.find((c) => c.type === "text")?.text).toBe("pong");
    // Chat Completions clients are unchanged.
    expect(translateNonStreamingResponse(gemini, FORMATS.GEMINI, FORMATS.OPENAI).object).toBe("chat.completion");
  });
});
