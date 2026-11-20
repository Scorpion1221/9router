import { statsEmitter, getActiveRequests } from "@/lib/usageDb";
import { onDrain } from "@/lib/shutdown.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, sending: false, dirty: false, keepalive: null, send: null, offDrain: null };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) {
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.send);
    }
    if (state.keepalive) {
      clearInterval(state.keepalive);
      state.keepalive = null;
    }
    if (state.offDrain) {
      const off = state.offDrain;
      state.offDrain = null;
      off();
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      // UsageStats.js fetches period aggregates via REST and only reads live
      // in-memory fields from SSE. Pushing getActiveRequests() directly avoids
      // scanning SQLite on every request completion while a tab is open.
      state.send = async () => {
        if (state.closed) return;
        if (state.sending) {
          state.dirty = true;
          return;
        }
        state.sending = true;
        try {
          do {
            state.dirty = false;
            const live = await getActiveRequests();
            if (state.closed) return;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(live)}\n\n`));
          } while (state.dirty && !state.closed);
        } catch {
          cleanup();
        } finally {
          state.sending = false;
        }
      };

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.send);

      state.keepalive = setInterval(() => {
        if (state.closed) { cleanup(); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
      state.keepalive.unref?.();

      // A dashboard stream never ends on its own and would hold a deploy's drain
      // open; end it when the process starts draining. EventSource reconnects,
      // which lands on the new instance.
      state.offDrain = onDrain(() => {
        if (state.closed) return;
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      });

      await state.send();
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
