// Threshold checks for scheduled monitoring (`9r check`). Each check returns
// ok | warn | crit with the numbers behind it; the overall level is the worst.
import { healthSummary, listAccounts } from "./views.js";

export const DEFAULT_THRESHOLDS = {
  since: "15m",
  minRequests: 20,          // below this, success rate is too noisy to judge
  successWarn: 0.97,
  successCrit: 0.9,
  ttftP90WarnMs: 15000,
  ttftP90CritMs: 45000,
  poolLockedWarn: 0.6,      // share of active accounts locked, per provider
  poolLockedCrit: 0.9,
};

const LEVEL = { ok: 0, warn: 1, crit: 2 };

function level(value, warn, crit, higherIsWorse = true) {
  if (value == null) return "ok";
  if (higherIsWorse) return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
  return value <= crit ? "crit" : value <= warn ? "warn" : "ok";
}

export async function runChecks(overrides = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides };
  const [health, accounts] = await Promise.all([healthSummary({ since: t.since }), listAccounts({ since: t.since })]);
  const h = health.rows[0] || { total: 0, ok: 0, error: 0, successRate: null, ttftP90: null };
  const checks = [];

  const enough = h.total >= t.minRequests;
  checks.push({
    name: "success_rate",
    level: enough ? level(h.successRate, t.successWarn, t.successCrit, false) : "ok",
    value: h.successRate == null ? null : Number(h.successRate.toFixed(4)),
    detail: `${h.ok} ok / ${h.ok + h.error} judged (${h.total} total) in ${t.since}${enough ? "" : `, under ${t.minRequests} requests: not judged`}`,
  });
  checks.push({
    name: "ttft_p90",
    level: enough ? level(h.ttftP90, t.ttftP90WarnMs, t.ttftP90CritMs) : "ok",
    value: h.ttftP90,
    detail: h.ttftP90 == null ? "no streamed successes" : `${h.ttftP90}ms p90 time to first byte`,
  });

  const pools = new Map();
  for (const a of accounts) {
    if (!a.active) continue;
    const p = pools.get(a.provider) || { active: 0, locked: 0 };
    p.active++;
    if (a.state === "locked") p.locked++;
    pools.set(a.provider, p);
  }
  for (const [provider, p] of pools) {
    if (p.active < 2) continue; // a single account being locked is normal backoff
    const share = p.locked / p.active;
    checks.push({
      name: `pool_${provider}`,
      level: level(share, t.poolLockedWarn, t.poolLockedCrit),
      value: Number(share.toFixed(2)),
      detail: `${p.locked}/${p.active} active accounts locked`,
    });
  }

  const worst = checks.reduce((acc, c) => (LEVEL[c.level] > LEVEL[acc] ? c.level : acc), "ok");
  return { level: worst, since: t.since, checks };
}
