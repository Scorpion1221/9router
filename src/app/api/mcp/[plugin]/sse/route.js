import { registerSession, unregisterSession, findPlugin } from "@/lib/mcp/stdioSseBridge";
import { onDrain } from "@/lib/shutdown.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { plugin } = await params;
  if (!findPlugin(plugin)) {
    return new Response(`Unknown plugin: ${plugin}`, { status: 404 });
  }

  const encoder = new TextEncoder();
  let sid;
  let offDrain;

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk) => controller.enqueue(encoder.encode(chunk));
      sid = registerSession(plugin, send);
      // MCP SSE handshake: tell client where to POST messages.
      send(`event: endpoint\ndata: /api/mcp/${plugin}/message?sessionId=${sid}\n\n`);
      // Long-lived session: end it when the process starts draining so a deploy
      // isn't held open; the MCP client reconnects to the new instance.
      offDrain = onDrain(() => {
        if (sid) unregisterSession(plugin, sid);
        sid = null;
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (sid) unregisterSession(plugin, sid);
      offDrain?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
