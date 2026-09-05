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
}
