"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import QuotaTable from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable";
import { formatResetTime, getRemainingPercentage } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";

// Same thresholds as the Quota Tracker's progress bars.
function tone(pct) {
  if (pct > 70) return { bar: "bg-green-500", text: "text-green-600 dark:text-green-400" };
  if (pct >= 30) return { bar: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400" };
  return { bar: "bg-red-500", text: "text-red-600 dark:text-red-400" };
}

const SUMMARY_ROWS = 3;

// Compact remaining-quota summary for one connection row; click to expand the
// full table (same component as the Quota Tracker).
export default function ConnectionQuota({ entry, loading, error, onRefresh }) {
  const [open, setOpen] = useState(false);
  const rows = (entry?.quotas || []).filter((q) => q?.name && q.name !== "error");

  if (!entry && loading) {
    return <div className="mt-1.5 h-4 w-40 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.08]" aria-label="Loading quota" />;
  }
  if (!entry && error) {
    return (
      <button type="button" onClick={onRefresh} className="mt-1 text-[11px] text-red-500 hover:underline" title={error}>
        Quota unavailable — retry
      </button>
    );
  }
  if (!rows.length) {
    return entry?.message ? <p className="mt-1 truncate text-[11px] text-text-muted" title={entry.message}>{entry.message}</p> : null;
  }

  const summary = rows.slice(0, SUMMARY_ROWS);
  return (
    <div className="mt-1.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-left"
        title={open ? "Hide quota details" : "Show quota details"}
        aria-expanded={open}
      >
        {summary.map((q) => {
          const pct = getRemainingPercentage(q);
          const t = tone(pct);
          const reset = formatResetTime(q.resetAt);
          return (
            <span key={q.name} className="flex min-w-0 items-center gap-1.5 text-[11px]">
              <span className="truncate text-text-muted">{q.name}</span>
              <span className="relative h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                <span className={`absolute inset-y-0 left-0 ${t.bar}`} style={{ width: `${Math.min(pct, 100)}%` }} />
              </span>
              <span className={`tabular-nums font-medium ${t.text}`}>{pct}%</span>
              {reset !== "-" && <span className="tabular-nums text-text-muted/70">· {reset}</span>}
            </span>
          );
        })}
        {rows.length > SUMMARY_ROWS && <span className="text-[11px] text-text-muted">+{rows.length - SUMMARY_ROWS}</span>}
        {loading && <span className="material-symbols-outlined animate-spin text-[12px] text-text-muted">progress_activity</span>}
        <span className="material-symbols-outlined text-[14px] text-text-muted">{open ? "expand_less" : "expand_more"}</span>
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-black/[0.06] p-2 dark:border-white/[0.08]">
          <QuotaTable quotas={rows} compact />
          <div className="mt-1 flex justify-end">
            <button type="button" onClick={onRefresh} disabled={loading} className="flex items-center gap-1 text-[11px] text-text-muted hover:text-primary disabled:opacity-50">
              <span className="material-symbols-outlined text-[13px]">refresh</span>
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

ConnectionQuota.propTypes = {
  entry: PropTypes.shape({
    quotas: PropTypes.array,
    message: PropTypes.string,
  }),
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRefresh: PropTypes.func.isRequired,
};
