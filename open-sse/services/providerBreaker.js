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

const DEFAULT_BREAKER = { threshold: 3, windowSec: 60, cooldownSec: 30 };

const positive = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);

export function resolveFailurePolicy(settings, provider) {
  const cfg = (settings?.providerStrategies || {})[provider] || {};
  const b = cfg.breaker || {};
  return {
    noLockOnTimeout: cfg.noLockOnTimeout === true,
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
