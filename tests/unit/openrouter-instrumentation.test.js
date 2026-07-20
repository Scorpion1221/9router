import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startOpenRouterSyncScheduler: vi.fn(),
}));

vi.mock("../../open-sse/services/openrouterSync.js", () => ({
  startOpenRouterSyncScheduler: mocks.startOpenRouterSyncScheduler,
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

  it("does not load the Node-only scheduler in the Edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await import("../../src/instrumentation.js");

    await register();

    expect(mocks.startOpenRouterSyncScheduler).not.toHaveBeenCalled();
  });
});
