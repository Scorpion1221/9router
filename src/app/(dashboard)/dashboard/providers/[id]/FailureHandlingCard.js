"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Card, Badge, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

// Stored in settings.providerStrategies[providerId]; read per request by
// open-sse/services/providerBreaker.js (resolveFailurePolicy).
const DEFAULT_BREAKER = { threshold: 3, windowSec: 60, cooldownSec: 30 };

export default function FailureHandlingCard({ providerId }) {
  const notify = useNotificationStore();
  const [expanded, setExpanded] = useState(false);
  const [noLockOnTimeout, setNoLockOnTimeout] = useState(false);
  const [breaker, setBreaker] = useState({ enabled: false, ...DEFAULT_BREAKER });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const cfg = (data.providerStrategies || {})[providerId] || {};
        setNoLockOnTimeout(cfg.noLockOnTimeout === true);
        setBreaker({ ...DEFAULT_BREAKER, ...(cfg.breaker || {}), enabled: cfg.breaker?.enabled === true });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async () => {
    const nums = ["threshold", "windowSec", "cooldownSec"];
    for (const k of nums) {
      const n = Number(breaker[k]);
      if (!Number.isFinite(n) || n <= 0) {
        notify.error(`${k} must be a positive number`);
        return;
      }
    }
    setSaving(true);
    try {
      // Re-read so keys other pages own (fallbackStrategy, sticky limit, …) survive.
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      const current = (settingsRes.ok ? await settingsRes.json() : {}).providerStrategies || {};
      const { noLockOnTimeout: _a, breaker: _b, ...kept } = current[providerId] || {};
      const override = { ...kept };
      if (noLockOnTimeout) override.noLockOnTimeout = true;
      if (breaker.enabled) {
        override.breaker = { enabled: true, threshold: Math.round(Number(breaker.threshold)), windowSec: Number(breaker.windowSec), cooldownSec: Number(breaker.cooldownSec) };
      }
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      if (!res.ok) {
        notify.error("Failed to save");
        return;
      }
      notify.success("Failure handling saved");
    } finally {
      setSaving(false);
    }
  }, [noLockOnTimeout, breaker, providerId, notify]);

  const active = noLockOnTimeout || breaker.enabled;
  const numberInput = (key, label, suffix) => (
    <label className="flex items-center gap-1.5 text-xs text-text-muted">
      {label}
      <input
        type="number"
        min={1}
        value={breaker[key]}
        disabled={!breaker.enabled}
        onChange={(e) => setBreaker((b) => ({ ...b, [key]: e.target.value }))}
        className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs focus:border-primary focus:outline-none disabled:opacity-50"
      />
      {suffix}
    </label>
  );

  return (
    <Card padding="xs">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="flex w-full items-center justify-between text-left">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">health_and_safety</span>
          <span className="text-sm font-semibold">Failure Handling</span>
          {active && <Badge variant="success" size="sm">Active</Badge>}
        </div>
        <span className="material-symbols-outlined text-text-muted">{expanded ? "expand_less" : "expand_more"}</span>
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-4 border-t border-border pt-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Don&apos;t lock on timeout</p>
              <p className="text-xs text-text-muted">
                When the upstream sends no response headers in time, skip the account for that request only instead of
                locking it. Use for relays with one account that are slow on long prompts, not broken.
              </p>
            </div>
            <Toggle checked={noLockOnTimeout} onChange={setNoLockOnTimeout} />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Circuit breaker</p>
                <p className="text-xs text-text-muted">
                  After repeated timeouts or 5xx errors, skip this provider for a while so combos move on at once. Then
                  one probe request goes through; a success closes the breaker. Kept in memory per process.
                </p>
              </div>
              <Toggle checked={breaker.enabled} onChange={(on) => setBreaker((b) => ({ ...b, enabled: on }))} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {numberInput("threshold", "Open after", "failures")}
              {numberInput("windowSec", "within", "s")}
              {numberInput("cooldownSec", "skip for", "s")}
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

FailureHandlingCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
