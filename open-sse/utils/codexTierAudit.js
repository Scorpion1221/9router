const TIERS = new Set(["auto", "default", "flex", "priority", "fast", "ultrafast"]);

const safeTier = (tier) => TIERS.has(tier) ? tier : "missing";
const safeModel = (model) => typeof model === "string" && /^[\w./-]{1,100}$/.test(model) ? model : "unknown";

// Record only tier metadata from Codex SSE; never log the request or response body.
export function createCodexTierAudit({ provider, model, body, clientRawRequest, finalBody, status, reqTag, log }) {
  if (provider !== "codex" || !log?.line) return null;

  let created = "missing";
  let completed = "missing";
  let terminal = "incomplete";
  let finished = false;

  return {
    observe(event) {
      if (event?.type === "response.created") created = safeTier(event.response?.service_tier);
      if (["response.completed", "response.done", "response.failed"].includes(event?.type)) {
        terminal = event.type;
        completed = safeTier(event.response?.service_tier);
        this.finish();
      }
    },
    finish() {
      if (finished) return;
      finished = true;
      log.line(reqTag, "⚡", `CODEX_TIER client_model=${safeModel(clientRawRequest?.body?.model || body?.model)} upstream_model=${safeModel(model)} client_tier=${safeTier(clientRawRequest?.body?.service_tier ?? body?.service_tier)} wire_tier=${safeTier(finalBody?.service_tier)} created_tier=${created} completed_tier=${completed} terminal=${terminal} http=${status}`);
    },
  };
}
