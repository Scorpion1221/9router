import pkg from "../../../../../package.json" with { type: "json" };
import { opsRoute } from "@/lib/ops/auth.js";
import { healthSummary, listAccounts } from "@/lib/ops/views.js";
import { isDraining } from "@/lib/shutdown.js";

export const dynamic = "force-dynamic";

// GET /api/ops/status — one-call overview for agents and the 9r home view.
export const GET = opsRoute("read", async () => {
  const [hour, accounts] = await Promise.all([healthSummary({ since: "1h" }), listAccounts({ since: "1h" })]);
  const h = hour.rows[0] || { total: 0, ok: 0, error: 0, aborted: 0, rejected: 0, successRate: null, ttftP50: null, ttftP90: null };
  const byProvider = {};
  for (const a of accounts) {
    const p = (byProvider[a.provider] ??= { provider: a.provider, total: 0, ok: 0, locked: 0, disabled: 0 });
    p.total++;
    p[a.state === "ok" ? "ok" : a.state]++;
  }
  return {
    gateway: {
      version: pkg.version,
      commit: process.env.GIT_COMMIT || null,
      uptimeSec: Math.round(process.uptime()),
      draining: isDraining(),
    },
    lastHour: {
      requests: h.total, ok: h.ok, errors: h.error, aborted: h.aborted, rejected: h.rejected,
      successRate: h.successRate, ttftP50: h.ttftP50, ttftP90: h.ttftP90,
    },
    pools: Object.values(byProvider).sort((a, b) => b.total - a.total),
  };
});
