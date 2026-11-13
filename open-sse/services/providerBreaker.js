// Per-provider failure policy (settings.providerStrategies[provider]):
//
//   noLockOnTimeout  A header timeout skips the account for that request only instead of
//                    locking it. A relay node (one account in front of a gateway) is slow
//                    on cold multi-hundred-k prompts, not broken; a lock there fails every
//                    other request routed to it for the whole cooldown.
//   breaker          In-memory circuit breaker for the whole provider. After `threshold`
//                    failures (header timeouts, 5xx) within `windowSec`, requests skip the
//                    provider for `cooldownSec`; then one probe request goes through, and
//                    a success closes it. Nothing is written to the DB, so it never
//                    outlives the process or reaches the other rollout slot.
//   noServerTools    The upstream cannot run Anthropic's server-side tools (Bedrock: web search,
//                    web fetch, code execution, advisor, MCP connector). It rejects them or,
//                    worse, answers 200 without running them. See dropServerTools().

const DEFAULT_BREAKER = { threshold: 3, windowSec: 60, cooldownSec: 30 };

const positive = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);

export function resolveFailurePolicy(settings, provider) {
  const cfg = (settings?.providerStrategies || {})[provider] || {};
  const b = cfg.breaker || {};
  return {
    noLockOnTimeout: cfg.noLockOnTimeout === true,
    noServerTools: cfg.noServerTools === true,
    breaker: {
      enabled: b.enabled === true,
      threshold: Math.round(positive(b.threshold, DEFAULT_BREAKER.threshold)),
      windowMs: positive(b.windowSec, DEFAULT_BREAKER.windowSec) * 1000,
      cooldownMs: positive(b.cooldownSec, DEFAULT_BREAKER.cooldownSec) * 1000,
    },
  };
}

// provider → { failures: number[] (timestamps), openUntil, probeAt }
const state = new Map();
const get = (provider) => {
  if (!state.has(provider)) state.set(provider, { failures: [], openUntil: 0, probeAt: 0 });
  return state.get(provider);
};

// Is the provider closed for this request? After the cooldown, exactly one caller gets
// `probe: true`; others keep seeing it open until that probe settles (or itself times
// out after another cooldown, so an abandoned probe can't wedge the breaker).
export function breakerGate(provider, policy, now = Date.now()) {
  if (!policy?.breaker?.enabled) return { open: false, probe: false };
  const s = state.get(provider);
  if (!s || !s.openUntil) return { open: false, probe: false };
  if (now < s.openUntil) return { open: true, probe: false, retryAfterMs: s.openUntil - now };
  if (s.probeAt && now - s.probeAt < policy.breaker.cooldownMs) {
    return { open: true, probe: false, retryAfterMs: s.probeAt + policy.breaker.cooldownMs - now };
  }
  s.probeAt = now;
  return { open: false, probe: true };
}

// Returns true when this failure opens (or re-opens) the breaker.
export function recordProviderFailure(provider, policy, now = Date.now()) {
  if (!policy?.breaker?.enabled) return false;
  const { threshold, windowMs, cooldownMs } = policy.breaker;
  const s = get(provider);
  if (s.probeAt) {
    s.probeAt = 0;
    s.failures = [];
    s.openUntil = now + cooldownMs;
    return true;
  }
  s.failures = s.failures.filter((t) => now - t <= windowMs);
  s.failures.push(now);
  if (s.failures.length < threshold) return false;
  s.failures = [];
  s.openUntil = now + cooldownMs;
  return true;
}

export function recordProviderSuccess(provider) {
  const s = state.get(provider);
  if (!s) return;
  s.failures = [];
  s.openUntil = 0;
  s.probeAt = 0;
}

export function resetProviderBreakers() {
  state.clear();
}

// Anthropic tool `type` prefixes that run on Anthropic's side and that Bedrock does not
// offer. Tool search, bash, text editor, memory and computer use work there and stay.
const SERVER_TOOL_PREFIXES = ["web_search", "web_fetch", "code_execution", "advisor", "mcp_toolset"];
const isServerTool = (t) => typeof t?.type === "string" && SERVER_TOOL_PREFIXES.some((p) => t.type.startsWith(p));

// For a provider with `noServerTools`. A request whose only tools are server tools (e.g.
// Claude Code's WebSearch sub-call) cannot be served here: report `reject` with the dropped
// tool names so the caller answers with a request-scoped 400 the client's model can read and
// route around (e.g. another search tool), and a combo moves on to its next member. In a
// request that also carries other tools, the server tools are dropped instead so the rest
// of the turn still runs.
// Returns { reject, dropped: string[], body } — `body` is a copy when tools were dropped.
export function dropServerTools(body) {
  const tools = body?.tools;
  if (!Array.isArray(tools) || !tools.some(isServerTool)) return { reject: false, dropped: [], body };
  const dropped = [...new Set(tools.filter(isServerTool).map((t) => t.name || t.type))];
  const kept = tools.filter((t) => !isServerTool(t));
  if (kept.length === 0) return { reject: true, dropped, body };
  const next = { ...body, tools: kept };
  // A forced choice naming a dropped tool would be rejected upstream.
  const tc = body.tool_choice;
  if (tc?.type === "tool" && !kept.some((t) => t.name === tc.name)) delete next.tool_choice;
  // mcp_servers without its mcp_toolset is a validation error upstream.
  if (next.mcp_servers && !kept.some((t) => t.type === "mcp_toolset")) delete next.mcp_servers;
  return { reject: false, dropped, body: next };
}
