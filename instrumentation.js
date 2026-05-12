// Next.js instrumentation hook — runs once per worker on cold start.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// Used here to kick off background services that don't belong in any
// request handler:
//   - OpenRouter model metadata sync (initial fetch + 24h refresh loop)

export async function register() {
  // Only run on the Node.js runtime (Next also boots an edge variant for middleware).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { startOpenRouterSyncScheduler } = await import("../open-sse/services/openrouterSync.js");
    const log = {
      info: (tag, msg) => console.log(`[${tag}] ${msg}`),
      warn: (tag, msg) => console.warn(`[${tag}] ${msg}`),
    };
    startOpenRouterSyncScheduler({ log });
    log.info("BOOT", "OpenRouter sync scheduler started");
  } catch (err) {
    console.warn("[BOOT] Failed to start OpenRouter sync:", err.message);
  }
}
