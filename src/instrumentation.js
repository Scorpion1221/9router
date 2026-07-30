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
}
