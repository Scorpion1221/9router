"use client";

// Connection list for providers whose accounts carry live quota (Claude, Codex):
// rows in the order the gateway uses them, one status and one time per account,
// short 5h / Week bars, the raw upstream error only on demand, and a summary bar.
// Priority view keeps drag-to-reorder (it is the tie-breaker under Reset first).
import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Tooltip } from "@/shared/components";
import SortableConnectionList from "./SortableConnectionList";
import {
  backAt, formatDuration, formatFull, formatWhen, groupAccounts, parseUpstreamError, poolSummary, TONE_CHIP, TONE_DOT,
} from "./quotaRouting";

const POLL_MS = 30 * 1000;

function usePoolView(providerId, connections) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  // Refetch when the list changes (toggle, reorder, policy edit) and on a timer.
  const signature = connections.map((c) => `${c.id}:${c.priority}:${c.isActive}:${c.poolRole}:${c.keepPct}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/providers/pool?provider=${encodeURIComponent(providerId)}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setView(data);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [providerId, signature]);
  return { view, error };
}

function useNow(intervalMs = 30 * 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function RankPill({ order, live }) {
  if (!order) return <span className="inline-grid h-[22px] min-w-[26px] place-items-center text-xs text-text-muted/70">–</span>;
  const reserve = order.startsWith("R");
  const cls = reserve
    ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
    : live
      ? "bg-green-500 text-white dark:text-green-950"
      : "bg-green-500/15 text-green-700 dark:text-green-400";
  return <span className={`inline-grid h-[22px] min-w-[26px] place-items-center rounded-md px-1.5 text-xs font-bold tabular-nums ${cls}`}>{order}</span>;
}
RankPill.propTypes = { order: PropTypes.string, live: PropTypes.bool };

function StatusChip({ status, now, testing }) {
  if (testing) {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-blue-500/10 px-2 text-xs font-semibold text-blue-700 dark:text-blue-400">
        <span className="material-symbols-outlined animate-spin text-[14px]">progress_activity</span>Testing…
      </span>
    );
  }
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs ${TONE_CHIP[status.tone]}`}
      title={status.back ? `Back ${formatFull(status.back)}` : undefined}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]} ${status.live ? "animate-pulse" : ""}`} />
      <span className="font-semibold">{status.label}</span>
      {status.back && <span className="text-text-muted tabular-nums">· back {formatWhen(status.back, now)}</span>}
    </span>
  );
}
StatusChip.propTypes = { status: PropTypes.object.isRequired, now: PropTypes.number.isRequired, testing: PropTypes.bool };

function QuotaBar({ label, window, keepPct, inRotation, blocking, tone, now }) {
  if (!window || window.remainingPct == null) {
    return (
      <div className="flex items-center gap-2" title="No reading yet">
        <span className="w-8 shrink-0 text-[11px] text-text-muted md:hidden">{label}</span>
        <span className="h-1.5 flex-1 rounded-full bg-[repeating-linear-gradient(90deg,var(--color-surface-3)_0_4px,transparent_4px_7px)]" />
        <span className="w-9 shrink-0 text-right text-xs text-text-muted">—</span>
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, Math.round(window.remainingPct)));
  const reset = window.resetAt ? Date.parse(window.resetAt) : null;
  const fill = !inRotation ? "bg-black/20 dark:bg-white/25" : pct < Math.max(15, keepPct + 10) ? "bg-amber-500" : "bg-green-500";
  const track = blocking ? (tone === "warn" ? "bg-amber-500/25" : "bg-red-500/25") : "bg-black/[0.08] dark:bg-white/[0.1]";
  const pctCls = blocking ? (tone === "warn" ? "font-semibold text-amber-600 dark:text-amber-400" : "font-semibold text-red-600 dark:text-red-400")
    : inRotation ? "text-text-main" : "text-text-muted";
  const title = `${label === "5h" ? "5h window" : "Weekly window"} · ${pct}% left · ${reset ? (reset > now ? `resets ${formatFull(reset)}` : "reset passed") : "starts with the next request"}${keepPct ? ` · tick = keep ${keepPct}%` : ""}`;
  return (
    <div className="flex items-center gap-2" title={title}>
      <span className="w-8 shrink-0 text-[11px] text-text-muted md:hidden">{label}</span>
      <span className={`relative h-1.5 min-w-10 flex-1 rounded-full ${track}`}>
        <span className={`absolute inset-y-0 left-0 rounded-full ${fill}`} style={{ width: `${pct}%` }} />
        {keepPct > 0 && <span className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 rounded-sm bg-text-main/80" style={{ left: `${keepPct}%` }} />}
      </span>
      <span className={`w-9 shrink-0 text-right text-xs tabular-nums ${pctCls}`}>{pct}%</span>
    </div>
  );
}
QuotaBar.propTypes = {
  label: PropTypes.string.isRequired, window: PropTypes.object, keepPct: PropTypes.number,
  inRotation: PropTypes.bool, blocking: PropTypes.bool, tone: PropTypes.string, now: PropTypes.number.isRequired,
};

function ErrorDisclosure({ raw }) {
  const e = parseUpstreamError(raw);
  if (!e) return null;
  return (
    <span className="group/err relative ml-1 inline-flex">
      <button type="button" className="grid size-6 place-items-center rounded-md text-text-muted hover:bg-black/5 hover:text-text-main dark:hover:bg-white/5" aria-label="Show the upstream error" onClick={(ev) => ev.stopPropagation()}>
        <span className="material-symbols-outlined text-[16px]">info</span>
      </button>
      <span className="invisible absolute left-0 top-full z-50 mt-1.5 w-[min(380px,80vw)] rounded-lg border border-border bg-surface p-3 opacity-0 shadow-xl transition-opacity group-hover/err:visible group-hover/err:opacity-100 group-focus-within/err:visible group-focus-within/err:opacity-100">
        <span className="flex items-center gap-2 text-xs">
          {e.code && <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono font-semibold text-red-600 dark:text-red-400">{e.code}</span>}
          <span className="font-mono font-semibold">{e.type || "upstream error"}</span>
          <span className="ml-auto text-[11px] text-text-muted">last upstream reply</span>
        </span>
        {/* Rendered as text, never HTML: upstream errors are untrusted. */}
        <span className="mt-2 block whitespace-pre-wrap break-all rounded-md bg-black/[0.04] p-2 font-mono text-[11px] leading-relaxed text-text-muted dark:bg-white/[0.04]">{e.raw}</span>
      </span>
    </span>
  );
}
ErrorDisclosure.propTypes = { raw: PropTypes.string };

function OverflowMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (ev) => { if (ref.current && !ref.current.contains(ev.target)) setOpen(false); };
    const onKey = (ev) => { if (ev.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title="More"
        className={`grid size-7 place-items-center rounded-md text-text-muted hover:bg-black/5 hover:text-text-main dark:hover:bg-white/5 ${open ? "bg-black/5 text-text-main dark:bg-white/5" : ""}`}>
        <span className="material-symbols-outlined text-[18px]">more_horiz</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded-lg border border-border bg-surface p-1 shadow-xl">
          {items.filter(Boolean).map((it) => it.separator ? (
            <div key={it.key} className="my-1 h-px bg-border" />
          ) : (
            <button key={it.key} type="button" role="menuitem" disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm disabled:opacity-50 ${it.danger ? "text-red-600 hover:bg-red-500/10 dark:text-red-400" : "hover:bg-black/5 dark:hover:bg-white/5"}`}>
              <span className={`material-symbols-outlined text-[17px] ${it.danger ? "" : "text-text-muted"}`}>{it.icon}</span>
              {it.label}
              {it.hint && <span className="ml-auto text-[11px] text-text-muted">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
OverflowMenu.propTypes = { items: PropTypes.array.isRequired };

function Details({ account, status, now }) {
  const windows = [
    account.windows?.["5h"] && { key: "5h", label: "5h", ...account.windows["5h"] },
    account.windows?.["7d"] && { key: "7d", label: "Week", ...account.windows["7d"] },
    ...(account.modelWindows || []).map((w) => ({ key: w.window, label: `${(w.window.split(":")[1] || "").replace(/^./, (c) => c.toUpperCase())} · week`, ...w })),
  ].filter(Boolean);
  const policy = `${account.role === "reserve" ? "Reserve" : "Normal"} · keep ${account.keepPct}%${account.releaseBeforeHours ? ` · ignore keep ${account.releaseBeforeHours}h before reset` : ""} · priority #${account.priority}`;
  return (
    <div className="mb-2 ml-[76px] mr-2 grid gap-4 rounded-lg border border-black/[0.06] bg-black/[0.015] p-3 text-xs dark:border-white/[0.06] dark:bg-white/[0.02] sm:grid-cols-[1.3fr_1fr]">
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Quota windows</div>
        {windows.length ? (
          <table className="w-full tabular-nums">
            <thead><tr className="text-left text-[11px] text-text-muted"><th className="pb-1 font-medium">Window</th><th className="pb-1 font-medium">Left</th><th className="pb-1 font-medium">Resets</th><th className="pb-1 font-medium">Read</th></tr></thead>
            <tbody>
              {windows.map((w) => {
                const r = w.resetAt ? Date.parse(w.resetAt) : null;
                const read = w.observedAt ? formatDuration(Math.max(MIN_MS, now - Date.parse(w.observedAt))) : "—";
                return (
                  <tr key={w.key} className={`border-t border-black/[0.05] dark:border-white/[0.05] ${status.window === w.key ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>
                    <td className="py-1 pr-2">{w.label}</td>
                    <td className="py-1 pr-2">{Math.round(w.remainingPct)}%</td>
                    <td className="py-1 pr-2">{r ? (r > now ? `${formatFull(r)} · in ${formatDuration(r - now)}` : "passed") : <span className="text-text-muted">starts on next request</span>}</td>
                    <td className="py-1 text-text-muted">{read} ago · {w.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="text-text-muted">No quota reading yet. It fills in from traffic and a 15-minute poll.</p>}
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Routing</div>
        <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1">
          <dt className="text-text-muted">Now</dt><dd>{status.back ? `${status.label}, back ${formatFull(status.back)}` : status.label}</dd>
          <dt className="text-text-muted">Policy</dt><dd>{policy}</dd>
        </dl>
        {account.lastError && (
          <>
            <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Last upstream error</div>
            <div className="whitespace-pre-wrap break-all rounded-md bg-black/[0.04] p-2 font-mono text-[11px] text-text-muted dark:bg-white/[0.04]">{account.lastError}</div>
          </>
        )}
      </div>
    </div>
  );
}
const MIN_MS = 60 * 1000;
Details.propTypes = { account: PropTypes.object.isRequired, status: PropTypes.object.isRequired, now: PropTypes.number.isRequired };

function SummaryBar({ summary, now, mode, onMode, strategy }) {
  const s = summary;
  const next = s.next;
  return (
    <div className="mb-2 rounded-xl border border-black/[0.06] bg-black/[0.015] px-4 py-3 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px] text-text-muted">
          <span className="inline-flex items-baseline gap-1.5"><span className="size-2 self-center rounded-full bg-green-500" /><b className="text-[15px] font-semibold tabular-nums text-text-main">{s.usable}</b>usable</span>
          {s.reserve > 0 && <span className="inline-flex items-baseline gap-1.5"><span className="size-2 self-center rounded-full bg-violet-500" /><b className="text-[15px] font-semibold tabular-nums text-text-main">{s.reserve}</b>reserve</span>}
          <span className="inline-flex items-baseline gap-1.5"><span className="size-2 self-center rounded-full bg-red-500" /><b className="text-[15px] font-semibold tabular-nums text-text-main">{s.out}</b>out</span>
          {s.disabled > 0 && <span className="inline-flex items-baseline gap-1.5"><span className="size-2 self-center rounded-full bg-gray-400" /><b className="text-[15px] font-semibold tabular-nums text-text-main">{s.disabled}</b>disabled</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-text-muted">
          {s.inUse ? (
            <span>In use <b className="font-semibold text-text-main">{s.inUse.account.name}</b>{s.inUse.account.role === "reserve" ? " (reserve)" : ""}</span>
          ) : <span className="font-semibold text-red-600 dark:text-red-400">No account can take requests</span>}
          {next && (
            <span className="inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-[16px]">schedule</span>
              Next back <b className="font-semibold text-text-main">{next.account.name}</b>
              <span className="font-semibold tabular-nums text-amber-600 dark:text-amber-400" title={formatFull(next.status.back)}>{formatWhen(next.status.back, now)}</span>
            </span>
          )}
          {strategy === "reset-first" && (
            <div className="inline-flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.06]" role="tablist" aria-label="List order">
              {[["gateway", "Gateway order", "The order the gateway uses right now"], ["priority", "Priority", "Your drag order: tie-break under Reset first and the order of reserve accounts"]].map(([key, label, tip]) => (
                <button key={key} type="button" role="tab" aria-selected={mode === key} title={tip} onClick={() => onMode(key)}
                  className={`h-6 rounded-md px-2.5 text-xs font-medium ${mode === key ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex h-1.5 gap-[3px]" aria-hidden="true">
        {s.strip.map((r) => (
          <i key={r.account.id} className={`flex-1 rounded-sm opacity-80 transition hover:scale-y-150 hover:opacity-100 ${TONE_DOT[r.status.tone]}`}
            title={`${r.account.name} · ${r.status.label}${r.status.back ? ` · back ${formatWhen(r.status.back, now)}` : ""}`} />
        ))}
      </div>
    </div>
  );
}
SummaryBar.propTypes = {
  summary: PropTypes.object.isRequired, now: PropTypes.number.isRequired, mode: PropTypes.string.isRequired,
  onMode: PropTypes.func.isRequired, strategy: PropTypes.string,
};

export default function QuotaConnectionList({
  providerId, connections, isSelected, onToggleSelect, onReorder, onToggleActive, onEdit, onDelete, onTest,
  autoPingFor, onToggleAutoPing, proxyPools, onUpdateProxy, oneByOneResults,
}) {
  const { view, error } = usePoolView(providerId, connections);
  const now = useNow();
  const [mode, setMode] = useState("gateway");
  const [open, setOpen] = useState(() => new Set());
  const [testingId, setTestingId] = useState(null);

  // Merge the gateway view (order, state, windows) onto the dashboard rows by id.
  const viewById = useMemo(() => new Map((view?.accounts || []).map((a) => [a.id, a])), [view]);
  const accounts = useMemo(() => connections.map((c) => {
    const v = viewById.get(c.id) || {};
    return {
      ...v, id: c.id, name: c.name || c.email || v.name, priority: c.priority, active: c.isActive !== false,
      role: c.poolRole === "reserve" ? "reserve" : "normal", keepPct: Number(c.keepPct) || 0,
      releaseBeforeHours: Number(c.releaseBeforeHours) || 0, lastError: c.lastError || null,
      state: v.state || (c.isActive === false ? "disabled" : "ready"), windows: v.windows || {}, modelWindows: v.modelWindows || [],
      conn: c,
    };
  }), [connections, viewById]);
  const strategy = view?.strategy || "fill-first";
  const groups = useMemo(() => groupAccounts(accounts, { strategy, now }), [accounts, strategy, now]);
  const summary = useMemo(() => poolSummary(groups), [groups]);
  const usePriority = mode === "priority" || strategy !== "reset-first";

  const toggleOpen = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const runTest = async (id) => {
    setTestingId(id);
    try { await onTest(id); } finally { setTestingId(null); }
  };

  const renderRow = ({ account, status }, dragHandle = null) => {
    const c = account.conn;
    const inRotation = status.group === "rotation";
    const oneByOne = oneByOneResults?.[c.id];
    const testing = testingId === c.id || oneByOne?.state === "testing";
    const pools = proxyPools || [];
    const boundPool = c.providerSpecificData?.proxyPoolId || null;
    const isOpen = open.has(c.id);
    const autoPing = autoPingFor ? autoPingFor(c) : null;
    const menu = [
      { key: "test", icon: "network_check", label: "Test connection", onClick: () => runTest(c.id), disabled: testing },
      pools.length ? { key: "proxy-none", icon: "lan", label: "Proxy: none", hint: !boundPool ? "current" : "", onClick: () => onUpdateProxy(c.id, null) } : null,
      ...pools.map((p) => ({ key: `proxy-${p.id}`, icon: "lan", label: `Proxy: ${p.name}`, hint: boundPool === p.id ? "current" : "", onClick: () => onUpdateProxy(c.id, p.id) })),
      { key: "details", icon: isOpen ? "unfold_less" : "unfold_more", label: isOpen ? "Hide details" : "Show details", onClick: () => toggleOpen(c.id) },
      { key: "sep", separator: true },
      { key: "delete", icon: "delete", label: "Delete connection", danger: true, onClick: () => onDelete(c.id) },
    ];
    return (
      <div key={c.id} className={!account.active ? "opacity-60" : ""}>
        <div
          className={`group grid min-h-[56px] cursor-pointer grid-cols-[20px_18px_30px_minmax(140px,1fr)_auto] items-center gap-x-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02] md:grid-cols-[20px_18px_30px_minmax(130px,0.8fr)_minmax(220px,1.3fr)_88px_112px_auto] ${isOpen ? "bg-black/[0.02] dark:bg-white/[0.03]" : ""}`}
          onClick={() => toggleOpen(c.id)}
        >
          <div className="flex w-5 items-center justify-center" onClick={(e) => e.stopPropagation()}>{dragHandle}</div>
          <div onClick={(e) => e.stopPropagation()} className="flex items-center">
            <input type="checkbox" checked={isSelected(c.id)} onChange={() => onToggleSelect(c.id)} aria-label={`Select ${account.name}`}
              className="size-4 rounded border-gray-300 text-primary focus:ring-primary" />
          </div>
          <RankPill order={strategy === "reset-first" ? account.order : (inRotation && account.order) || null} live={status.live} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13.5px] font-semibold" title={account.name}>{account.name}</span>
              {account.role === "reserve" && <span className="shrink-0 rounded-md bg-violet-500/15 px-1.5 text-[10.5px] font-semibold leading-[18px] text-violet-700 dark:text-violet-300">Reserve</span>}
              {account.keepPct > 0 && (
                <span className="shrink-0 rounded-md bg-black/[0.05] px-1.5 text-[10.5px] font-semibold leading-[18px] text-text-muted dark:bg-white/[0.07]"
                  title={`Stops routing here once any window has less than ${account.keepPct}% left${account.releaseBeforeHours ? `; ignored in the last ${account.releaseBeforeHours}h before the weekly reset` : ""}`}>
                  Keep {account.keepPct}%
                </span>
              )}
              <span className={`material-symbols-outlined text-[18px] text-text-muted transition ${isOpen ? "rotate-180 opacity-100" : "opacity-0 group-hover:opacity-100"}`}>expand_more</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-text-muted tabular-nums">
              <span title="Priority (your drag order)">#{c.priority}</span><span className="opacity-50">·</span><span>{c.authType === "oauth" ? "OAuth" : "API key"}</span>
              {autoPing?.on && <><span className="opacity-50">·</span><span>Auto-ping</span></>}
              {boundPool && <><span className="opacity-50">·</span><span>Proxy</span></>}
            </div>
            <div className="mt-1 flex items-center md:hidden"><StatusChip status={status} now={now} testing={testing} /></div>
          </div>
          <div className="hidden min-w-0 items-center md:flex">
            <StatusChip status={status} now={now} testing={testing} />
            {!inRotation && account.active && <ErrorDisclosure raw={account.lastError} />}
          </div>
          <div className="hidden md:block"><QuotaBar label="5h" window={account.windows["5h"]} keepPct={account.keepPct} inRotation={inRotation} blocking={status.window === "5h"} tone={status.tone} now={now} /></div>
          <div className="hidden min-w-0 flex-col gap-1 md:flex">
            <QuotaBar label="Week" window={account.windows["7d"]} keepPct={account.keepPct} inRotation={inRotation} blocking={status.window === "7d"} tone={status.tone} now={now} />
            {account.modelWindows.filter((w) => w.remainingPct < 100).map((w) => (
              <span key={w.window} className="self-start rounded bg-amber-500/10 px-1.5 text-[10.5px] font-semibold leading-[17px] text-amber-700 dark:text-amber-400"
                title={`${w.window} · ${Math.round(w.remainingPct)}% left`}>{(w.window.split(":")[1] || "").replace(/^./, (x) => x.toUpperCase())} {Math.round(w.remainingPct)}%</span>
            ))}
          </div>
          <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
            {autoPing && (
              <Tooltip text={autoPing.on ? "Auto-ping on: starts the next 5h window right after it resets" : "Auto-ping: when the 5h quota runs out, send a tiny request at reset so a new window starts right away"}>
                <button type="button" onClick={() => onToggleAutoPing(c.id, !autoPing.on)} aria-pressed={autoPing.on}
                  className={`grid size-7 place-items-center rounded-md hover:bg-black/5 dark:hover:bg-white/5 ${autoPing.on ? "text-primary" : "text-text-muted hover:text-text-main"}`}>
                  <span className="material-symbols-outlined text-[18px]">bolt</span>
                </button>
              </Tooltip>
            )}
            <button type="button" onClick={() => onEdit(c)} title="Edit name, role, keep %"
              className="grid size-7 place-items-center rounded-md text-text-muted hover:bg-black/5 hover:text-text-main dark:hover:bg-white/5">
              <span className="material-symbols-outlined text-[18px]">edit</span>
            </button>
            <OverflowMenu items={menu} />
            <button type="button" role="switch" aria-checked={account.active} onClick={() => onToggleActive(c.id, !account.active)}
              title={account.active ? "Enabled · click to disable" : "Disabled · click to enable"}
              className={`relative ml-1 h-[18px] w-[30px] shrink-0 rounded-full transition-colors ${account.active ? "bg-zinc-600 dark:bg-zinc-500" : "bg-zinc-200 dark:bg-zinc-700"}`}>
              <span className={`absolute top-[3px] size-3 rounded-full bg-white shadow transition-[left] ${account.active ? "left-[15px]" : "left-[3px]"}`} />
            </button>
          </div>
        </div>
        {isOpen && <Details account={account} status={status} now={now} />}
      </div>
    );
  };

  const Header = (
    <div className="hidden h-8 items-center gap-x-2.5 border-b border-black/[0.06] px-2 text-[11.5px] font-medium text-text-muted dark:border-white/[0.06] md:grid md:grid-cols-[20px_18px_30px_minmax(130px,0.8fr)_minmax(220px,1.3fr)_88px_112px_auto]">
      <span /><span />
      <span className="pl-2" title="Gateway order: 1 gets the next request, R = reserve, – = out until its window resets">#</span>
      <span>Account</span><span>Status</span>
      <span title="5-hour session quota left">5h</span>
      <span title="Weekly (7-day) quota left. A tick marks the account's keep %">Week</span>
      <span />
    </div>
  );

  const groupHead = (title, count, hint) => (
    <div className="flex items-baseline gap-2 px-2 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
      {title}<span className="tabular-nums text-text-main/70">{count}</span>
      {hint && <span className="ml-auto text-[11.5px] font-normal normal-case tracking-normal">{hint}</span>}
    </div>
  );

  return (
    <div className="min-w-0">
      {error && !view && <p className="mb-2 text-xs text-text-muted">Live quota unavailable ({error}); showing your priority order.</p>}
      <SummaryBar summary={summary} now={now} mode={mode} onMode={setMode} strategy={strategy} />
      {Header}
      {usePriority ? (
        <>
          {strategy === "reset-first" && groupHead("Priority", accounts.length, "Drag to reorder. Under Reset first, priority only breaks ties and orders reserve accounts.")}
          <SortableConnectionList
            connections={connections}
            onReorder={onReorder}
            className="flex min-w-0 flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]"
            renderRow={(conn, _index, dragHandle) => {
              const row = [...groups.rotation, ...groups.waiting, ...groups.off].find((r) => r.account.id === conn.id);
              return row ? renderRow(row, dragHandle) : null;
            }}
          />
        </>
      ) : (
        <>
          {groups.rotation.length > 0 && groupHead("In rotation", groups.rotation.length, "normal accounts by earliest weekly reset, then reserve")}
          {groups.rotation.map((r) => renderRow(r))}
          {groups.waiting.length > 0 && groupHead("Waiting for reset", groups.waiting.length, "sorted by when they come back")}
          {groups.waiting.map((r) => renderRow(r))}
          {groups.off.length > 0 && groupHead("Disabled", groups.off.length)}
          {groups.off.map((r) => renderRow(r))}
        </>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.05] px-2 pt-2.5 text-[11.5px] text-text-muted dark:border-white/[0.05]">
        <span>{view ? `Live quota · refreshed every ${POLL_MS / 1000}s` : "Loading live quota…"}</span>
        <span className="flex flex-wrap gap-x-3.5 gap-y-1">
          <span className="inline-flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-green-500" />Usable now</span>
          <span className="inline-flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-amber-500" />Back within 24h</span>
          <span className="inline-flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-red-500" />Out a day or more</span>
          <span className="inline-flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-violet-500" />Reserve</span>
        </span>
      </div>
    </div>
  );
}

QuotaConnectionList.propTypes = {
  providerId: PropTypes.string.isRequired,
  connections: PropTypes.array.isRequired,
  isSelected: PropTypes.func.isRequired,
  onToggleSelect: PropTypes.func.isRequired,
  onReorder: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onTest: PropTypes.func.isRequired,
  autoPingFor: PropTypes.func,
  onToggleAutoPing: PropTypes.func,
  proxyPools: PropTypes.array,
  onUpdateProxy: PropTypes.func.isRequired,
  oneByOneResults: PropTypes.object,
};
