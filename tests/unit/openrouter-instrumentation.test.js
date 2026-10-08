import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startOpenRouterSyncScheduler: vi.fn(),
  startBackgroundTokenRefresh: vi.fn(),
  ensureOutboundProxyInitialized: vi.fn(async () => true),
}));

vi.mock("../../open-sse/services/openrouterSync.js", () => ({
  startOpenRouterSyncScheduler: mocks.startOpenRouterSyncScheduler,
}));

vi.mock("../../src/sse/services/backgroundTokenRefresh.js", () => ({
  startBackgroundTokenRefresh: mocks.startBackgroundTokenRefresh,
}));

vi.mock("../../src/lib/network/initOutboundProxy.js", () => ({
  ensureOutboundProxyInitialized: mocks.ensureOutboundProxyInitialized,
}));

describe("OpenRouter instrumentation", () => {
  const originalRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
  });

  it("starts the refresh scheduler when the Node server boots", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await import("../../src/instrumentation.js");

    await register();

    expect(mocks.startOpenRouterSyncScheduler).toHaveBeenCalledTimes(1);
    expect(mocks.startOpenRouterSyncScheduler).toHaveBeenCalledWith({
      log: expect.objectContaining({
        info: expect.any(Function),
        warn: expect.any(Function),
      }),
    });
  });

  it("starts the OAuth background refresher at boot, not on first page render", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await import("../../src/instrumentation.js");

    await register();

    expect(mocks.startBackgroundTokenRefresh).toHaveBeenCalledTimes(1);
    // Outbound-proxy setting must be applied before the first refresh goes out.
    expect(mocks.ensureOutboundProxyInitialized.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.startBackgroundTokenRefresh.mock.invocationCallOrder[0]);
  });

  it("keeps booting when the refresher fails to start", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    mocks.startBackgroundTokenRefresh.mockImplementationOnce(() => { throw new Error("boom"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { register } = await import("../../src/instrumentation.js");

    await expect(register()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("[BG_TOKEN_REFRESH] start failed:", "boom");
    errSpy.mockRestore();
  });

  it("does not load the Node-only scheduler in the Edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await import("../../src/instrumentation.js");

    await register();

    expect(mocks.startOpenRouterSyncScheduler).not.toHaveBeenCalled();
    expect(mocks.startBackgroundTokenRefresh).not.toHaveBeenCalled();
  });
});
