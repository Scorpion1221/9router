/**
 * Stream "first-byte" probe — peek the first meaningful chunk of a streaming
 * Response without consuming it, so callers can decide whether the stream is
 * actually producing content before committing to forward it to the client.
 *
 * Why this exists: combo fallback used to treat HTTP 200 as "succeeded" and
 * immediately return the upstream Response to the client. If the upstream then
 * aborted mid-stream (e.g. Anthropic ResponseAborted with 0 bytes of useful
 * content), the client received an empty body and combo had no chance to try
 * the next model. probeFirstContent makes "succeeded" mean "stream actually
 * yielded non-noise bytes within the deadline".
 *
 * Pitfalls:
 *  - For SSE responses we must NOT consume the original body — the buffered
 *    chunk plus the remaining reader has to be re-assembled into a new
 *    ReadableStream that the caller forwards. The original response.body is
 *    locked once read; we expose a new Response in `wrapped`.
 *  - Heartbeat / keep-alive lines (`:keepalive`, blank ` data: `, OpenAI
 *    `[DONE]` with no preceding deltas, Claude `ping` events) are noise. We
 *    deliberately keep the noise filter conservative — any byte that doesn't
 *    look like a heartbeat counts. Format-specific delta detection can be
 *    layered on later if false-positives bite.
 *  - Deadline only covers the FIRST chunk. Once a real chunk arrives, we hand
 *    the rest of the stream off as-is. Mid-stream stalls are handled
 *    downstream by streamHandler's STREAM_STALL_TIMEOUT_MS.
 */

const DEFAULT_TIMEOUT_MS = 8000;

// Bytes that count as "no content yet" on an SSE stream. We err on the side of
// classifying ambiguous bytes as content (false-positive succeeded) rather
// than mis-classifying real content as noise (false-positive fallback). A
// real SSE delta is hundreds of bytes; heartbeats are tiny.
// Pre-parsed noise rules. Each rule checks one SSE line. Returning true means
// "this line carries no real content"; we keep scanning. If every line in the
// buffered text passes a rule, the whole chunk is noise.
function isNoiseSseLine(line, currentEvent) {
  if (line.startsWith(":")) return true;          // SSE comment / heartbeat
  if (line === "data: [DONE]") return true;       // OpenAI terminal sentinel
  if (line.startsWith("event:")) {
    return true; // event line itself never carries payload; payload is in the following data:
  }
  if (line.startsWith("data:")) {
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return true;
    // When we already know the surrounding event is ping/heartbeat/keep-alive,
    // its data: payload is noise regardless of body.
    if (currentEvent === "ping" || currentEvent === "heartbeat" || currentEvent === "keep-alive") {
      return true;
    }
    // Heuristic: tiny opaque payloads that are clearly heartbeat-shaped.
    // Anthropic occasionally emits `data: {"type":"ping"}` without a preceding
    // `event: ping` line (different SDK versions). Detect by payload content.
    if (/^\{\s*"type"\s*:\s*"ping"\s*\}$/.test(payload)) return true;
    return false;
  }
  // Unknown SSE field (id:, retry:, etc.) — not content but not signal either.
  // Treat as noise so we keep looking for the first real data: line.
  return true;
}

function isNoiseSseChunk(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let currentEvent = null;
  for (const line of lines) {
    // Track current event name so we can classify the following data: line.
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      // The event: line itself is structural, not content.
      continue;
    }
    const ok = isNoiseSseLine(line, currentEvent);
    // Event scope is single-frame: clear after we've classified one data: line
    // so a subsequent unrelated frame doesn't inherit the previous event name.
    // (We dropped blank lines during the split/filter step, which would have
    // been the natural frame separator.)
    if (line.startsWith("data:")) currentEvent = null;
    if (!ok) return false;
  }
  return true;
}

/**
 * Probe the first meaningful chunk of a streaming Response.
 *
 * @param {Response} response - The upstream response (must have a readable body).
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000] - Max ms to wait for first content chunk.
 * @param {(text: string) => boolean} [opts.isNoise] - Custom noise classifier.
 * @returns {Promise<{ ok: boolean, reason?: string, wrapped?: Response }>}
 *   - ok=true with wrapped Response (re-assembled, safe to forward to client)
 *   - ok=false with reason: "timeout" | "empty" | "no-body" | "error"
 */
export async function probeFirstContent(response, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isNoise = opts.isNoise || isNoiseSseChunk;

  if (!response || !response.body) {
    return { ok: false, reason: "no-body" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const collected = [];                 // raw Uint8Array chunks we've consumed during probe
  let collectedText = "";               // decoded so far (for noise check)
  let timeoutHandle = null;
  let timedOut = false;

  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      // Best-effort cancel — we'll surface the timeout regardless
      reader.cancel("probe-timeout").catch(() => {});
      resolve({ done: true, value: undefined, __timeout: true });
    }, timeoutMs);
  });

  try {
    while (true) {
      const { done, value, __timeout } = await Promise.race([
        reader.read().then(r => ({ ...r })),
        timeoutPromise,
      ]);

      if (__timeout) {
        return { ok: false, reason: "timeout" };
      }

      if (done) {
        // Stream ended during probe — no more bytes will come. If what we did
        // collect was all-noise (or empty), this is a fallback case.
        if (!collectedText || isNoise(collectedText)) {
          return { ok: false, reason: "empty" };
        }
        // Edge case: stream ended cleanly with real content already buffered.
        // Re-assemble and forward (the downstream pipe will see EOF immediately).
        return {
          ok: true,
          wrapped: buildWrappedResponse(response, collected, /* eof */ true, reader),
        };
      }

      if (value && value.byteLength > 0) {
        collected.push(value);
        // Decode incrementally — stream=true so multibyte sequences split across
        // chunks don't corrupt the noise check.
        collectedText += decoder.decode(value, { stream: true });

        if (!isNoise(collectedText)) {
          // Real content — stop probing, hand back a wrapped response that
          // replays the buffered chunks then continues from the live reader.
          return {
            ok: true,
            wrapped: buildWrappedResponse(response, collected, /* eof */ false, reader),
          };
        }
        // else: keep reading until real content or timeout/EOF
      }
    }
  } catch (err) {
    return { ok: false, reason: `error:${err?.message || String(err)}` };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Build a new Response that yields the buffered probe chunks first, then
 * continues consuming from the live reader. If eof=true, we just replay the
 * buffer and close.
 */
function buildWrappedResponse(original, bufferedChunks, eof, reader) {
  const replay = new ReadableStream({
    async start(controller) {
      for (const chunk of bufferedChunks) {
        controller.enqueue(chunk);
      }
      if (eof) {
        controller.close();
        return;
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(replay, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
}

/**
 * Heuristic: is this Response a streaming SSE body that we should probe?
 * Probing JSON responses is pointless (the whole body arrives at once).
 */
export function isStreamingSseResponse(response) {
  if (!response || !response.body) return false;
  const ct = response.headers?.get?.("content-type") || "";
  return ct.toLowerCase().includes("text/event-stream");
}
