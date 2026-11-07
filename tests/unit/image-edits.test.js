// POST /v1/images/edits: request parsing (multipart + JSON) and per-provider upstream shape
// (Codex Responses image_generation tool, OpenAI /images/edits).
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  modelInfo: { provider: "codex", model: "gpt-image-2.6-flare" },
  credentials: null,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async (_provider, excluded) =>
    mocks.credentials && !excluded.has(mocks.credentials.connectionId) ? mocks.credentials : null,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => mocks.modelInfo,
  getComboModels: async () => null,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));

const { POST } = await import("../../src/app/api/v1/images/edits/route.js");

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
const MASK_DATA_URL = "data:image/png;base64,bWFzaw==";

const codexSse = (events) => new Response(
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
  { status: 200, headers: { "Content-Type": "text/event-stream" } },
);
const codexImage = () => codexSse([
  ["response.output_item.done", { item: { type: "image_generation_call", result: "ZWRpdGVk" } }],
  ["response.completed", { response: { usage: { input_tokens: 10, output_tokens: 20 } } }],
]);

function multipartEdit(fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, bytes, type] of files) fd.append(k, new Blob([bytes], { type }), `${k}.png`);
  return new Request("http://localhost/v1/images/edits", { method: "POST", body: fd });
}

const jsonEdit = (body) => new Request("http://localhost/v1/images/edits", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const upstreamBody = () => JSON.parse(global.fetch.mock.calls[0][1].body);

describe("POST /v1/images/edits", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
    mocks.markAccountUnavailable.mockClear();
    mocks.modelInfo = { provider: "codex", model: "gpt-image-2.6-flare" };
    mocks.credentials = {
      connectionId: "codex-conn",
      accessToken: "codex-token",
      providerSpecificData: { chatgptAccountId: "acct-1" },
    };
  });
  afterEach(() => { global.fetch = originalFetch; });

  it("sends a multipart edit with mask to the Codex image tool as an edit, without a reasoning block", async () => {
    global.fetch.mockResolvedValueOnce(codexImage());
    const res = await POST(multipartEdit(
      { model: "cx/gpt-image-2.6-flare", prompt: "make it blue", quality: "low", size: "1024x1024" },
      [["image", PNG_BYTES, "image/png"], ["mask", new Uint8Array([1]), "image/png"]],
    ));

    expect(res.status).toBe(200);
    expect((await res.json()).data[0].b64_json).toBe("ZWRpdGVk");
    const body = upstreamBody();
    expect(body.model).toBe("gpt-6-sol");
    // The host model's effort becomes the tool's complexity, which hosted gpt-image models reject.
    expect(body.reasoning).toBeNull();
    expect(body.tools).toEqual([{
      type: "image_generation",
      output_format: "png",
      action: "edit",
      model: "gpt-image-2.6-flare",
      size: "1024x1024",
      quality: "low",
      input_image_mask: { image_url: "data:image/png;base64,AQ==" },
    }]);
    const images = body.input[0].content.filter((c) => c.type === "input_image");
    expect(images).toEqual([{ type: "input_image", image_url: PNG_DATA_URL, detail: "high" }]);
  });

  it("accepts image[] multipart fields and JSON { images: [{ image_url }] } bodies", async () => {
    global.fetch.mockResolvedValueOnce(codexImage());
    await POST(multipartEdit({ model: "cx/gpt-image-2.6-flare", prompt: "p" }, [
      ["image[]", PNG_BYTES, "image/png"], ["image[]", PNG_BYTES, "image/webp"],
    ]));
    let images = upstreamBody().input[0].content.filter((c) => c.type === "input_image");
    expect(images.map((i) => i.image_url)).toEqual([PNG_DATA_URL, PNG_DATA_URL.replace("image/png", "image/webp")]);

    global.fetch.mockReset();
    global.fetch.mockResolvedValueOnce(codexImage());
    await POST(jsonEdit({ model: "cx/gpt-image-2.6-flare", prompt: "p", images: [{ image_url: PNG_DATA_URL }], mask: { image_url: MASK_DATA_URL } }));
    const body = upstreamBody();
    images = body.input[0].content.filter((c) => c.type === "input_image");
    expect(images.map((i) => i.image_url)).toEqual([PNG_DATA_URL]);
    expect(body.tools[0].input_image_mask).toEqual({ image_url: MASK_DATA_URL });
  });

  it("surfaces Codex SSE tool errors as 400 with the upstream message and does not lock the account", async () => {
    global.fetch.mockResolvedValueOnce(codexSse([
      ["error", { type: "error", error: { type: "image_generation_user_error", code: "invalid_value", message: "Complexity 'medium' is not supported for this image model.", param: "complexity" } }],
      ["response.failed", { response: { status: "failed", error: { type: "image_generation_user_error", message: "Complexity 'medium' is not supported for this image model." } } }],
    ]));
    const res = await POST(jsonEdit({ model: "cx/gpt-image-2.6-flare", prompt: "p", images: [{ image_url: PNG_DATA_URL }] }));

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Complexity 'medium' is not supported");
    // markAccountUnavailable decides locking; a 400 is request-scoped there (no lock).
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith("codex-conn", 400, expect.stringContaining("Complexity"), "codex", "gpt-image-2.6-flare");
  });

  it("rejects markup on Codex instead of silently dropping it", async () => {
    const res = await POST(jsonEdit({ model: "cx/gpt-image-2.6-flare", prompt: "p", images: [{ image_url: PNG_DATA_URL }], markup: { image_url: MASK_DATA_URL } }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("markup");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards OpenAI edits to /v1/images/edits as JSON image references", async () => {
    mocks.modelInfo = { provider: "openai", model: "gpt-image-2.6-flare" };
    mocks.credentials = { connectionId: "openai-conn", apiKey: "sk-test" };
    global.fetch.mockResolvedValueOnce(Response.json({ created: 1, data: [{ b64_json: "b3V0" }] }));

    const res = await POST(multipartEdit(
      { model: "openai/gpt-image-2.6-flare", prompt: "recolor", quality: "medium", complexity: "low", n: "2", output_compression: "80" },
      [["image", PNG_BYTES, "image/png"], ["markup", new Uint8Array([1]), "image/png"]],
    ));

    expect(res.status).toBe(200);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body)).toEqual({
      model: "gpt-image-2.6-flare",
      prompt: "recolor",
      images: [{ image_url: PNG_DATA_URL }],
      markup: { image_url: "data:image/png;base64,AQ==" },
      n: 2,
      quality: "medium",
      output_compression: 80,
      complexity: "low",
    });
  });

  it("rejects edits without an image, with file_id refs, with stream=true, or on providers that drop refs", async () => {
    const cases = [
      [jsonEdit({ model: "cx/gpt-image-2.6-flare", prompt: "p" }), "Missing required field: image"],
      [jsonEdit({ model: "cx/gpt-image-2.6-flare", prompt: "p", images: [{ file_id: "file-1" }] }), "file_id"],
      [jsonEdit({ model: "cx/gpt-image-2.6-flare", prompt: "p", images: [{ image_url: PNG_DATA_URL }], stream: true }), "stream=true"],
    ];
    for (const [req, msg] of cases) {
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(msg);
    }

    mocks.modelInfo = { provider: "xai", model: "grok-2-image" };
    const res = await POST(jsonEdit({ model: "xai/grok-2-image", prompt: "p", images: [{ image_url: PNG_DATA_URL }] }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("does not support /v1/images/edits");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
