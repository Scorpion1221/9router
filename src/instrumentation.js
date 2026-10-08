export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
  initConsoleLogCapture();

  const { startOpenRouterSyncScheduler } = await import("../open-sse/services/openrouterSync.js");
  startOpenRouterSyncScheduler({
    log: {
      info: (tag, msg) => console.log(`[${tag}] ${msg}`),
      warn: (tag, msg) => console.warn(`[${tag}] ${msg}`),
    },
  });

  // Server-only: lets capabilities.js read the synced catalog without pulling
  // node:fs into the dashboard's browser bundle.
  const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
  await installCatalogSource();

  const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
  startModelCatalogSync();

  // initializeApp also starts this, but only once a dynamic page renders, which can
  // be hours after boot; until then idle OAuth connections are never refreshed.
  // Fail-open: a rejected register() would turn every request into a 500.
  try {
    // Token refreshes must honor the dashboard outbound-proxy setting, which is
    // otherwise only applied when the root layout first renders.
    const { ensureOutboundProxyInitialized } = await import("@/lib/network/initOutboundProxy");
    await ensureOutboundProxyInitialized();
    const { startBackgroundTokenRefresh } = await import("@/sse/services/backgroundTokenRefresh.js");
    startBackgroundTokenRefresh();
  } catch (e) {
    console.error("[BG_TOKEN_REFRESH] start failed:", e?.message ?? e);
  }
}
