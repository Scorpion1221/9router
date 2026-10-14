// Provider-wide quota + selection view for /api/ops/quota: every account's live
// windows (from response headers and the quota poller), its policy, and the order
// the gateway would use them in — computed by the same ranking the selector uses.
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { isModelLockActive, getBlockingLockUntil } from "open-sse/services/accountFallback.js";
import { getQuotaSnapshot, isQuotaProvider, remainingPct } from "open-sse/services/quotaState.js";
import { rankResetFirst, accountPolicy } from "open-sse/services/resetFirst.js";
import { publicConnection } from "./views.js";
import { opsError } from "./auth.js";

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function windowView(w, now) {
  if (!w) return null;
  return { remainingPct: Math.round(remainingPct(w, now)), resetAt: iso(w.resetAt), observedAt: iso(w.observedAt), source: w.source };
}

/** Effective strategy for a provider, as getProviderCredentials resolves it. */
export function effectiveStrategy(settings, provider) {
  return (settings.providerStrategies || {})[provider]?.fallbackStrategy || settings.fallbackStrategy || "fill-first";
}

export async function providerPoolView(provider, { model = null } = {}) {
  if (!isQuotaProvider(provider)) throw opsError(400, `quota view supports claude and codex, not '${provider}'`);
  const now = Date.now();
  const [settings, conns] = await Promise.all([getSettings(), getProviderConnections({ provider })]);
  const strategy = effectiveStrategy(settings, provider);
  // Locks are keyed by the exact model id the gateway called; accept a full id only.
  if (model && !/^[a-z0-9][a-z0-9._-]*-\d/i.test(model)) {
    throw opsError(400, `--model needs the full model id the gateway calls (e.g. claude-fable-5-1), not '${model}'`);
  }
  const active = conns.filter((c) => c.isActive);
  const unlocked = active.filter((c) => !isModelLockActive(c, model));
  const { order, blocked } = rankResetFirst(unlocked, model, now);
  const position = new Map();
  if (strategy === "reset-first") {
    let n = 0;
    let r = 0;
    for (const e of order) position.set(e.conn.id, e.tier === "reserve" ? `R${++r}` : String(++n));
  } else if (strategy === "fill-first") {
    unlocked.forEach((c, i) => position.set(c.id, String(i + 1)));
  }
  const blockedBy = new Map(blocked.map((b) => [b.conn.id, b.assessment]));

  const accounts = conns.map((c) => {
    const snap = getQuotaSnapshot(c.id);
    const lockUntil = getBlockingLockUntil(c, model);
    const block = blockedBy.get(c.id);
    let state = "ready";
    if (!c.isActive) state = "disabled";
    else if (lockUntil) state = "locked";
    else if (strategy === "reset-first" && block) state = block.reason.includes("keep") ? "below keep" : "exhausted";
    const modelWindows = Object.entries(snap?.windows || {})
      .filter(([k]) => k.includes(":"))
      .map(([k, w]) => ({ window: k, ...windowView(w, now) }));
    return {
      ...publicConnection(c),
      ...accountPolicy(c),
      order: position.get(c.id) || null,
      state,
      lockedUntil: lockUntil,
      eligibleAt: strategy === "reset-first" && block ? iso(block.eligibleAt) : null,
      windows: { "5h": windowView(snap?.windows?.["5h"], now), "7d": windowView(snap?.windows?.["7d"], now) },
      modelWindows,
      quotaUpdatedAt: iso(snap?.updatedAt),
    };
  });
  const rank = (a) => (a.order === null ? Infinity : a.order.startsWith("R") ? 1000 + Number(a.order.slice(1)) : Number(a.order));
  accounts.sort((a, b) => rank(a) - rank(b) || (a.priority ?? 0) - (b.priority ?? 0));
  return { provider, strategy, model, accounts };
}
