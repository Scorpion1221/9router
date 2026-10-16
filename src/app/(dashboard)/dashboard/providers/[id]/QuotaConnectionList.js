"use client";

// Connections card for providers whose accounts carry live quota (Claude, Codex).
// Markup and CSS (quotaConnections.css) are ported 1:1 from the approved preview:
// .preview/connections-a-refined.html for the header and list, and the summary bar
// and toolbar from .preview/connections-b-table.html.
import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import "./quotaConnections.css";
import {
  backAt, formatFull, formatWhen, formatDuration, parseUpstreamError, statusOf, rankWhenBack, weekBucket, rankNum,
  modelName, winLabel, windowWord, windowsOf,
} from "./quotaRouting";

const POLL_MS = 30 * 1000;
const DAY = 864e5;
const ts = (iso) => (iso ? Date.parse(iso) : null);

const STRATEGIES = [
  { value: "", label: "Default (global)" },
  { value: "fill-first", label: "Fill first" },
  { value: "round-robin", label: "Round robin" },
  { value: "reset-first", label: "Reset first" },
];

function usePoolView(providerId, connections, strategyKey) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);
  const signature = connections.map((c) => `${c.id}:${c.priority}:${c.isActive}:${c.poolRole}:${c.keepPct}:${c.releaseBeforeHours}`).join("|");
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
  }, [providerId, signature, strategyKey, nonce]);
  return { view, error, reload: () => setNonce((n) => n + 1) };
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const Ic = ({ name, className = "" }) => <span className={`ms material-symbols-outlined ${className}`} aria-hidden="true">{name}</span>;
Ic.propTypes = { name: PropTypes.string.isRequired, className: PropTypes.string };

const ago = (iso, now) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

function Tip({ text, children, as: Tag = "span", className, ...rest }) {
  return <Tag className={className} data-tip={text || undefined} {...rest}>{children}</Tag>;
}
Tip.propTypes = { text: PropTypes.string, children: PropTypes.node, as: PropTypes.string, className: PropTypes.string };

export default function QuotaConnectionList({
  providerId, connections, strategyOverride, onStrategyChange, isSelected, onToggleSelect, onSelectAll, onClearSelection,
  onReorder, onToggleActive, onEdit, onDelete, onTest, onTestAll, onStopTestAll, testAllRunning, testAllSummary,
  onBulkDelete, onBulkProxy, onBulkToggle, autoPingFor, onToggleAutoPing, proxyPools, onUpdateProxy, oneByOneResults,
  onAdd, extraAddButtons,
}) {
  const { view, error, reload } = usePoolView(providerId, connections, strategyOverride);
  const now = useNow();
  const [mode, setMode] = useState("effective");
  const [open, setOpen] = useState(() => new Set());
  const [menuFor, setMenuFor] = useState(null);
  const [pinnedErr, setPinnedErr] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [toast, setToast] = useState(null);
  const rootRef = useRef(null);
  const tipRef = useRef(null);

  // Merge the gateway view (order, state, windows) onto the dashboard rows by id.
  const viewById = useMemo(() => new Map((view?.accounts || []).map((a) => [a.id, a])), [view]);
  const accounts = useMemo(() => connections.map((c) => {
    const v = viewById.get(c.id) || {};
    return {
      ...v, id: c.id, name: c.name || c.email || v.name || c.id, priority: c.priority, active: c.isActive !== false,
      role: c.poolRole === "reserve" ? "reserve" : "normal", keepPct: Number(c.keepPct) || 0,
      releaseBeforeHours: Number(c.releaseBeforeHours) || 0, lastError: c.lastError || null,
      order: v.order || null, state: v.state || (c.isActive === false ? "disabled" : "ready"),
      windows: v.windows || {}, modelWindows: v.modelWindows || [], conn: c,
    };
  }), [connections, viewById]);
  const strategy = view?.strategy || "fill-first";
  const isResetFirst = strategy === "reset-first";
  const effectiveMode = isResetFirst ? mode : "priority";
  const servingReserve = isResetFirst && !accounts.some((a) => a.active && a.order === "1");
  const withStatus = useMemo(() => {
    const rows = accounts.map((a) => ({ a, st: statusOf(a, { strategy, servingReserve, now }) }));
    if (isResetFirst) return rows;
    let n = 0;
    return rows
      .slice().sort((x, y) => x.a.priority - y.a.priority)
      .map((r) => {
        if (r.st.group !== "rot") return { ...r, a: { ...r.a, order: null } };
        const order = strategy === "round-robin" ? null : String(++n);
        const st = order === "1" ? { ...r.st, cls: "use", label: "In use", tip: "Fill first: the next request goes to the first usable account by priority" } : r.st;
        return { a: { ...r.a, order }, st };
      });
  }, [accounts, strategy, isResetFirst, servingReserve, now]);

  const groups = useMemo(() => {
    const byPriority = (x, y) => x.a.priority - y.a.priority;
    if (effectiveMode === "priority") return [{ key: "prio", rows: [...withStatus].sort(byPriority) }];
    return [
      { key: "rot", title: "In rotation", hint: "normal accounts by earliest weekly reset, then reserve", rows: withStatus.filter((r) => r.st.group === "rot").sort((x, y) => rankNum(x.a.order) - rankNum(y.a.order) || byPriority(x, y)) },
      { key: "wait", title: "Waiting for reset", hint: "sorted by when they come back", rows: withStatus.filter((r) => r.st.group === "wait").sort((x, y) => ((x.st.back || Infinity) - (y.st.back || Infinity)) || byPriority(x, y)) },
      { key: "off", title: "Disabled", hint: "", rows: withStatus.filter((r) => r.st.group === "off").sort(byPriority) },
    ].filter((g) => g.rows.length);
  }, [withStatus, effectiveMode]);

  const selectedCount = connections.filter((c) => isSelected(c.id)).length;

  // Close menus / pinned popovers on outside click and Escape.
  useEffect(() => {
    if (!menuFor && !pinnedErr) return undefined;
    const onDown = (e) => {
      if (menuFor && !e.target.closest?.(".menu-wrap")) setMenuFor(null);
      if (pinnedErr && !e.target.closest?.(".err-wrap")) setPinnedErr(null);
    };
    const onKey = (e) => { if (e.key === "Escape") { setMenuFor(null); setPinnedErr(null); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuFor, pinnedErr]);

  // Floating tooltip for [data-tip], as in the preview.
  useEffect(() => {
    const root = rootRef.current;
    const tip = tipRef.current;
    if (!root || !tip) return undefined;
    let current = null;
    const hide = () => { current = null; tip.classList.remove("show"); };
    const over = (e) => {
      const el = e.target.closest?.("[data-tip]");
      if (el === current) return;
      if (!el || !root.contains(el) || el.closest(".menu, .err-pop")) { hide(); return; }
      current = el;
      tip.textContent = el.getAttribute("data-tip");
      tip.classList.add("show");
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const x = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
      let y = r.top - th - 8;
      if (y < 8) y = r.bottom + 8;
      tip.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    };
    root.addEventListener("mouseover", over);
    root.addEventListener("mouseleave", hide);
    window.addEventListener("scroll", hide, { passive: true });
    return () => { root.removeEventListener("mouseover", over); root.removeEventListener("mouseleave", hide); window.removeEventListener("scroll", hide); };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const toggleOpen = (id) => setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const runTest = async (a) => {
    setMenuFor(null);
    setTestingId(a.id);
    try {
      const ok = await onTest(a.id);
      setToast(ok === false ? `${a.name}: test failed` : `${a.name}: test finished`);
    } finally { setTestingId(null); }
  };
  const copy = (text) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => setToast("Copied the raw upstream error"), () => setToast("Copy is blocked here"));
  };

  /* ---------- row pieces (same markup as the preview) ---------- */
  const rankPill = (a, st) => {
    if (st.group !== "rot") {
      const tip = !a.active ? "Disabled" : st.back ? `Out of rotation until ${formatFull(st.back)}` : "Out of rotation";
      return <Tip className="rank out" text={tip}>–</Tip>;
    }
    if (!a.order) return <Tip className="rank queue" text="Usable; round robin rotates between these">•</Tip>;
    if (a.order[0] === "R") return <Tip className="rank rsv" text={`Reserve #${a.order.slice(1)}: used only when no normal account can`}>{a.order}</Tip>;
    return <Tip className={`rank ${a.order === "1" ? "use" : "queue"}`} text={a.order === "1" ? "Gateway order 1: the next request goes here" : `Gateway order ${a.order}`}>{a.order}</Tip>;
  };

  const keepTip = (a) => `Keep ${a.keepPct}%: stops using this account once any window drops below ${a.keepPct}% left${a.releaseBeforeHours > 0 ? `. Ignored in the last ${a.releaseBeforeHours}h before the weekly reset` : ""}`;

  const nameCell = (a) => {
    const ap = autoPingFor ? autoPingFor(a.conn) : null;
    const pool = a.conn.providerSpecificData?.proxyPoolId;
    return (
      <>
        <div className="nm">
          <span className="nm-text" title={a.name}>{a.name}</span>
          {a.role === "reserve" && <Tip className="tag t-rsv" text="Reserve: only used when no normal account can take the request">Reserve</Tip>}
          {a.keepPct > 0 && <Tip className="tag" text={keepTip(a)}>Keep {a.keepPct}%</Tip>}
          <Ic name="expand_more" className="chev" />
        </div>
        <div className="meta">
          <Tip text={`Priority ${a.priority} (your drag order)`}>#{a.priority}</Tip>
          <span className="sep">·</span><span>{a.conn.authType === "oauth" ? "OAuth" : "API key"}</span>
          {ap?.on && <><span className="sep">·</span><span><Ic name="bolt" className="fill" /> Auto-ping</span></>}
          {pool && <><span className="sep">·</span><span>Proxy</span></>}
        </div>
      </>
    );
  };

  const errSentence = (a, st, e) => {
    const head = <b>{e.code || ""} {e.type || "error"}</b>;
    if (!a.order && a.state === "locked" && st.back) return <>Upstream answered {head}: the {windowWord(st.win || "7d")} quota is used up. 9router locked the account and tries again <b>{formatFull(st.back)}</b>.</>;
    if (!a.order && st.back) return <>Last reply was {head}. Usage data now shows the {windowWord(st.win || "7d")} window at 0%, so it is skipped until <b>{formatFull(st.back)}</b>.</>;
    return <>Last reply was {head}. The account has recovered since and is usable.</>;
  };

  const errDisclosure = (a, st) => {
    const e = parseUpstreamError(a.lastError);
    if (!e || !a.active) return null;
    return (
      <span className="err-wrap">
        <button className="err-i" type="button" aria-label="Show the upstream error" onClick={(ev) => { ev.stopPropagation(); setPinnedErr(pinnedErr === a.id ? null : a.id); }}><Ic name="info" /></button>
        <div className={`err-pop${pinnedErr === a.id ? " pinned" : ""}`} role="tooltip" onClick={(ev) => ev.stopPropagation()}>
          <div className="eh"><span className="code-pill">{e.code || "ERR"}</span><span className="et">{e.type || "upstream error"}</span><span className="es">last upstream reply</span></div>
          <p className="ep">{errSentence(a, st, e)}</p>
          {/* Rendered as text, never HTML: upstream errors are untrusted. */}
          <pre className="code">{e.raw}</pre>
          <div className="ef">
            <button className="link" type="button" onClick={() => copy(e.raw)}><Ic name="content_copy" />Copy raw</button>
            <button className="link" type="button" onClick={() => { setPinnedErr(null); toggleOpen(a.id); }}><Ic name="unfold_more" />Open details</button>
          </div>
        </div>
      </span>
    );
  };

  const statusCell = (a, st) => {
    const testing = testingId === a.id || oneByOneResults?.[a.id]?.state === "testing";
    if (testing) return <span className="chip t-info"><Ic name="progress_activity" className="spin" /><span className="lbl">Testing…</span></span>;
    return (
      <>
        <Tip className={`chip t-${st.tone}${st.cls ? ` ${st.cls}` : ""}`} text={st.tip}>
          <span className="dot" /><span className="lbl">{st.label}</span>
          {st.back && <span className="t">back {formatWhen(st.back, now)}</span>}
        </Tip>
        {st.group === "wait" && errDisclosure(a, st)}
      </>
    );
  };

  const bar = (a, w, key, st) => {
    const ql = <span className="ql">{key === "5h" ? "5h" : "Week"}</span>;
    if (!w || w.remainingPct == null) return <Tip as="div" className="q na" text="No reading yet">{ql}<span className="trk" /><span className="pct">—</span></Tip>;
    const p = Math.max(0, Math.min(100, Math.round(w.remainingPct)));
    let cls = "q";
    if (st.group === "rot" && a.active) cls += p < Math.max(15, a.keepPct + 10) ? " low" : " good";
    else if (a.active && st.win === key) cls += ` block t-${st.tone}`;
    const r = ts(w.resetAt);
    const tip = `${key === "5h" ? "5h window" : "Weekly window"} · ${p}% left · ${r ? (r > now ? `resets ${formatFull(r)}` : "reset passed") : "idle, starts with the next request"} · read ${ago(w.observedAt, now)}${a.keepPct > 0 ? ` · tick = keep ${a.keepPct}%` : ""}`;
    return (
      <Tip as="div" className={cls} text={tip}>
        {ql}
        <span className="trk"><span className="fill" style={{ width: `${p}%` }} />{a.keepPct > 0 && <i className="keep" style={{ left: `${a.keepPct}%` }} />}</span>
        <span className="pct">{p}%</span>
      </Tip>
    );
  };

  const modelChips = (a, st) => (a.modelWindows || []).filter((m) => m.remainingPct < 100).map((m) => {
    const p = Math.round(m.remainingPct);
    const tone = st.win === m.window ? st.tone : p <= 20 ? "warn" : "muted";
    return <Tip key={m.window} className={`mw t-${tone}`} text={`${modelName(m.window)} weekly window · ${p}% left${m.resetAt ? ` · resets ${formatFull(ts(m.resetAt))}` : ""}`}>{modelName(m.window)} {p}%</Tip>;
  });

  const menu = (a) => {
    const isOpen = open.has(a.id);
    const pools = proxyPools || [];
    const bound = a.conn.providerSpecificData?.proxyPoolId || null;
    return (
      <div className="menu" role="menu" onClick={(e) => e.stopPropagation()}>
        <button className="mi" type="button" role="menuitem" onClick={() => runTest(a)}><Ic name="network_check" />Test connection</button>
        {pools.length > 0 && (
          <>
            <button className="mi" type="button" role="menuitem" onClick={() => { setMenuFor(null); onUpdateProxy(a.id, null); }}><Ic name="lan" />No proxy{!bound && <span className="r">current</span>}</button>
            {pools.map((p) => (
              <button key={p.id} className="mi" type="button" role="menuitem" onClick={() => { setMenuFor(null); onUpdateProxy(a.id, p.id); }}><Ic name="lan" />Proxy: {p.name}{bound === p.id && <span className="r">current</span>}</button>
            ))}
          </>
        )}
        <button className="mi" type="button" role="menuitem" onClick={() => { setMenuFor(null); toggleOpen(a.id); }}><Ic name={isOpen ? "unfold_less" : "unfold_more"} />{isOpen ? "Hide details" : "Show details"}</button>
        {a.lastError && <button className="mi" type="button" role="menuitem" onClick={() => { setMenuFor(null); copy(a.lastError); }}><Ic name="content_copy" />Copy last error</button>}
        <div className="msep" />
        <button className="mi danger" type="button" role="menuitem" onClick={() => { setMenuFor(null); onDelete(a.id); }}><Ic name="delete" />Delete connection</button>
      </div>
    );
  };

  const actCell = (a) => {
    const ap = autoPingFor ? autoPingFor(a.conn) : null;
    const menuOpen = menuFor === a.id;
    return (
      <>
        {ap && (
          <Tip as="button" type="button" className={`ib${ap.on ? " on" : ""}`} aria-pressed={ap.on}
            text={ap.on ? "Auto-ping on: starts the next 5h window the moment it resets" : "Auto-ping off: when the 5h quota runs out, send a tiny request at reset so a new window starts right away"}
            onClick={() => onToggleAutoPing(a.id, !ap.on)}>
            <Ic name="bolt" />
          </Tip>
        )}
        <Tip as="button" type="button" className="ib" text="Edit name, role, keep %" onClick={() => onEdit(a.conn)}><Ic name="edit" /></Tip>
        <span className="menu-wrap">
          <Tip as="button" type="button" className={`ib${menuOpen ? " active" : ""}`} aria-haspopup="menu" aria-expanded={menuOpen}
            text={menuOpen ? undefined : "Test, proxy, details, delete"} onClick={() => setMenuFor(menuOpen ? null : a.id)}>
            <Ic name="more_horiz" />
          </Tip>
          {menuOpen && menu(a)}
        </span>
        <Tip as="button" type="button" role="switch" aria-checked={a.active} aria-label="Enabled" className={`sw${a.active ? " on" : ""}`}
          text={a.active ? "Enabled · click to disable" : "Disabled · click to enable"} onClick={() => onToggleActive(a.id, !a.active)}>
          <span />
        </Tip>
      </>
    );
  };

  const nowLine = (a, st) => {
    if (!a.active) return "Disabled: never selected.";
    if (a.order === "1") return "Gets the next request. Normal accounts go earliest weekly reset first.";
    if (a.order?.[0] === "R") return `Standby: takes traffic only when no normal account can${a.keepPct ? `, and stops at keep ${a.keepPct}%` : ""}.`;
    if (a.order) return `Ready, #${a.order} in line.`;
    if (st.group === "rot") return "Usable.";
    const w = windowWord(st.win || "7d");
    if (a.state === "locked") return <>Locked after a 429. Tried again <b>{st.back ? formatFull(st.back) : "later"}</b>, when the {w} window resets <span className="dim">({st.back ? `in ${formatDuration(st.back - now)}` : ""})</span>.</>;
    if (a.state === "exhausted") return <>Skipped: usage data shows the {w} window at 0%. Eligible again <b>{st.back ? formatFull(st.back) : "after reset"}</b>.</>;
    if (a.state === "below keep") return <>Skipped: below keep {a.keepPct}%. Eligible again <b>{st.back ? formatFull(st.back) : "after reset"}</b>.</>;
    return "Not in rotation.";
  };

  const backLine = (a) => {
    if (!isResetFirst) return null;
    const r = rankWhenBack(a, accounts);
    if (!r) return null;
    const wk = (x) => (weekBucket(x, r.t) === Infinity ? "new week" : formatWhen(ts(x.windows["7d"].resetAt), now));
    if (!r.known) return <>Expected #{r.pos}. Its next week only starts on first use, so it lines up behind accounts with a known reset.</>;
    if (r.pos === 1) return <>Expected <b>#1</b>: its week resets {wk(a)}{r.behind && <>, before {r.behind.name} <span className="dim">({wk(r.behind)})</span></>}, so reset-first spends it first.</>;
    return <>Expected #{r.pos}, behind {r.ahead.name} <span className="dim">(week resets {wk(r.ahead)})</span>.</>;
  };

  const details = (a, st) => {
    const back = st.back ? backLine(a) : null;
    const policy = <>{a.role === "reserve" ? "Reserve" : "Normal"} · keep {a.keepPct}%{a.releaseBeforeHours > 0 ? ` · ignore keep ${a.releaseBeforeHours}h before reset` : ""} <span className="dim">· priority #{a.priority}</span></>;
    const e = parseUpstreamError(a.lastError);
    return (
      <div className="details" onClick={(ev) => ev.stopPropagation()}>
        <section>
          <div className="dh">Quota windows</div>
          {windowsOf(a).length ? (
            <table className="wt">
              <thead><tr><th>Window</th><th>Left</th><th>Resets</th><th>Read</th></tr></thead>
              <tbody>
                {windowsOf(a).map((w) => {
                  const r = ts(w.resetAt);
                  return (
                    <tr key={w.key} className={st.win === w.key ? `hit t-${st.tone}` : ""}>
                      <td>{winLabel(w.key)}</td>
                      <td className="p">{Math.round(w.remainingPct)}%</td>
                      <td>{r ? (r > now ? <>{formatFull(r)} <span className="dim">· in {formatDuration(r - now)}</span></> : "passed") : <span className="dim">idle · starts on next request</span>}</td>
                      <td className="dim">{ago(w.observedAt, now)} · {w.source || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <p className="dim">No quota reading yet. It fills in from traffic and a 15-minute poll.</p>}
        </section>
        <section>
          <div className="dh">Routing</div>
          <dl className="kv">
            <dt>Now</dt><dd>{nowLine(a, st)}</dd>
            {back && <><dt>When back</dt><dd>{back}</dd></>}
            <dt>Policy</dt><dd>{policy}</dd>
          </dl>
        </section>
        {e && (
          <section className="wide">
            <div className="dh">Last upstream error<button className="link" type="button" onClick={() => copy(e.raw)}><Ic name="content_copy" />Copy</button></div>
            <pre className="code">{e.raw}</pre>
          </section>
        )}
        <div className="d-actions wide">
          <button className="btn btn-secondary sm" type="button" onClick={() => runTest(a)}><Ic name="network_check" />Test connection</button>
          <button className="btn btn-ghost sm" type="button" onClick={() => onEdit(a.conn)}><Ic name="edit" />Edit policy</button>
        </div>
      </div>
    );
  };

  /* ---------- drag to reorder (Priority view) ---------- */
  const dragRef = useRef(null);
  const [dropHint, setDropHint] = useState(null);
  const dragProps = (a) => ({
    draggable: effectiveMode === "priority",
    onDragStart: (e) => { dragRef.current = a.id; e.dataTransfer.effectAllowed = "move"; },
    onDragOver: (e) => {
      if (!dragRef.current || dragRef.current === a.id) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setDropHint({ id: a.id, after: e.clientY > r.top + r.height / 2 });
    },
    onDrop: (e) => {
      e.preventDefault();
      const from = dragRef.current;
      dragRef.current = null;
      const hint = dropHint;
      setDropHint(null);
      if (!from || !hint) return;
      const order = [...connections].sort((x, y) => x.priority - y.priority);
      const moving = order.find((c) => c.id === from);
      const rest = order.filter((c) => c.id !== from);
      let i = rest.findIndex((c) => c.id === hint.id);
      if (hint.after) i += 1;
      rest.splice(i, 0, moving);
      onReorder(rest);
      setToast("Priority saved. Gateway order recalculated.");
    },
    onDragEnd: () => { dragRef.current = null; setDropHint(null); },
  });

  const row = ({ a, st }) => {
    const isOpen = open.has(a.id);
    const cls = ["row", "grid",
      a.active ? "" : "is-off",
      isOpen ? "is-open" : "",
      menuFor === a.id ? "has-menu" : "",
      pinnedErr === a.id ? "has-pop" : "",
      isSelected(a.id) ? "is-sel" : "",
      testingId === a.id ? "is-testing" : "",
      dropHint?.id === a.id ? (dropHint.after ? "drop-after" : "drop-before") : ""].filter(Boolean).join(" ");
    return (
      <div key={a.id}>
        <div className={cls} role="row" aria-expanded={isOpen} {...dragProps(a)}
          onClick={(e) => { if (!e.target.closest("button, input, label, a, .menu, .err-pop")) toggleOpen(a.id); }}>
          <Tip as="div" className="c-drag" text="Drag to change priority"><Ic name="drag_indicator" /></Tip>
          <div className="c-check"><input type="checkbox" checked={isSelected(a.id)} onChange={() => onToggleSelect(a.id)} aria-label={`Select ${a.name}`} /></div>
          <div className="c-rank">{rankPill(a, st)}</div>
          <div className="c-name">{nameCell(a)}</div>
          <div className="c-status">{statusCell(a, st)}</div>
          <div className="c-quota">
            <div className="c-q5">{bar(a, a.windows["5h"], "5h", st)}</div>
            <div className="c-qw">{bar(a, a.windows["7d"], "7d", st)}{modelChips(a, st)}</div>
          </div>
          <div className="c-act">{actCell(a)}</div>
        </div>
        {isOpen && details(a, st)}
      </div>
    );
  };

  /* ---------- summary bar (from preview B) ---------- */
  const usable = withStatus.filter((r) => r.st.group === "rot" && r.st.tone === "ok").length;
  const reserve = withStatus.filter((r) => r.st.tone === "rsv").length;
  const out = withStatus.filter((r) => r.st.group === "wait");
  const soon = out.filter((r) => r.st.back && r.st.back - now < DAY).length;
  const disabled = withStatus.filter((r) => r.st.group === "off").length;
  const next = [...out].filter((r) => r.st.back).sort((x, y) => x.st.back - y.st.back)[0] || null;
  const proj = next ? rankWhenBack(next.a, accounts) : null;
  const inUse = withStatus.find((r) => r.st.cls === "use");
  const stripRows = [
    ...withStatus.filter((r) => r.st.group === "rot").sort((x, y) => rankNum(x.a.order) - rankNum(y.a.order)),
    ...out.slice().sort((x, y) => (x.st.back || Infinity) - (y.st.back || Infinity)),
    ...withStatus.filter((r) => r.st.group === "off"),
  ];

  const allSelected = connections.length > 0 && selectedCount === connections.length;
  const summaryUsable = isResetFirst ? usable : withStatus.filter((r) => r.st.group === "rot").length;

  return (
    <section className="qcl card" ref={rootRef} aria-label="Connections">
      <div className="card-head">
        <div className="title"><h2>Connections</h2><span className="count">{summaryUsable} / {connections.length} usable</span></div>
        <div className="tools">
          <label className="field">
            <Tip className="fl" text="Reset first spends the quota that expires first: normal accounts go earliest weekly reset first, reserve accounts only when no normal one can, and accounts under their keep % are skipped.">Strategy<Ic name="info" /></Tip>
            <select aria-label="Account strategy" value={strategyOverride || ""} onChange={async (e) => {
              const value = e.target.value || null;
              await onStrategyChange(value);
              reload();
              setToast(`Strategy: ${STRATEGIES.find((x) => x.value === (value || ""))?.label}. Order recalculated.`);
            }}>
              {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <Ic name="expand_more" className="chev2" />
          </label>
          <button className={`btn btn-secondary${testAllRunning ? " running" : ""}`} type="button" id="testAll" onClick={testAllRunning ? onStopTestAll : onTestAll}>
            <Ic name="sync" className={testAllRunning ? "spin" : ""} /><span>{testAllRunning ? "Testing… click to stop" : "Test Connection One-by-One"}</span>
          </button>
          {extraAddButtons}
          <button className="btn btn-primary" type="button" onClick={onAdd}><Ic name="add" />Add</button>
        </div>
      </div>

      <div className="bsum">
        <div className="bsum-stats">
          <span className="bstat"><i className="dot t-ok" /><b>{summaryUsable}</b>usable</span>
          {reserve > 0 && <span className="bstat"><i className="dot t-rsv" /><b>{reserve}</b>reserve</span>}
          <span className="bstat"><i className="dot t-err" /><b>{out.length}</b>out{soon > 0 && <span className="aux">· {soon} back within 24h</span>}</span>
          {disabled > 0 && <span className="bstat"><i className="dot t-muted" /><b>{disabled}</b>disabled</span>}
        </div>
        <div className="bsum-next">
          {!inUse && isResetFirst && <span><Ic name="warning" /> <b>No account can take requests</b></span>}
          {next && (
            <span>
              <Ic name="schedule" /> Next back <b>{next.a.name}</b> <span className="when" title={formatFull(next.st.back)}>{formatWhen(next.st.back, now)}</span>
              {proj && isResetFirst && <span>{proj.pos === 1 ? (inUse ? ` · takes over #1 from ${inUse.a.name}` : " · becomes #1") : ` · rejoins at #${proj.pos}`}</span>}
            </span>
          )}
        </div>
        <div className="bstrip" aria-hidden="true">
          {stripRows.map((r) => <i key={r.a.id} className={`t-${r.st.tone}`} title={`${r.a.name} · ${r.st.label}${r.st.back ? ` · back ${formatWhen(r.st.back, now)}` : ""}`} />)}
        </div>
      </div>

      <div className="btools">
        {selectedCount > 0 ? (
          <div className="bbulk">
            <span className="n">{selectedCount} selected</span>
            {(proxyPools || []).length > 0 && <button className="btn sm btn-ghost" type="button" onClick={onBulkProxy}><Ic name="lan" />Apply proxy</button>}
            <button className="btn sm btn-ghost" type="button" onClick={() => onBulkToggle(true)}><Ic name="toggle_on" />Enable</button>
            <button className="btn sm btn-ghost" type="button" onClick={() => onBulkToggle(false)}><Ic name="toggle_off" />Disable</button>
            <span className="vr" />
            <button className="btn sm danger-ghost" type="button" onClick={onBulkDelete}><Ic name="delete" />Delete</button>
            <button className="ib xs" type="button" title="Clear selection" onClick={onClearSelection}><Ic name="close" /></button>
          </div>
        ) : isResetFirst ? (
          <div className="bseg" role="tablist" aria-label="Row order">
            <button type="button" role="tab" aria-selected={mode === "effective"} className={mode === "effective" ? "on" : ""} onClick={() => setMode("effective")}><Ic name="route" />Gateway order</button>
            <button type="button" role="tab" aria-selected={mode === "priority"} className={mode === "priority" ? "on" : ""} onClick={() => setMode("priority")}><Ic name="drag_indicator" />Priority</button>
          </div>
        ) : <span />}
        <div className="bhint">
          {effectiveMode === "priority"
            ? <><Ic name="drag_indicator" />{isResetFirst ? "Drag to change priority. It breaks ties between accounts that reset in the same hour, and orders the reserves." : strategy === "round-robin" ? "Round robin rotates between usable accounts · drag sets the starting order" : "Fill first uses the first usable account by priority · drag to reorder"}</>
            : <><Ic name="route" /><span>Reset first: soonest weekly reset goes first</span><span className="sepdot">·</span><span>reserve last</span></>}
        </div>
      </div>

      {testAllSummary && (
        <div className="run-line">
          <span>Total <b>{testAllSummary.total}</b></span><span>Completed <b>{testAllSummary.completed}</b></span>
          <span>Passed <b>{testAllSummary.passed}</b></span><span>Failed <b>{testAllSummary.failed}</b></span>
          {testAllSummary.stopped && <span>Stopped</span>}
        </div>
      )}

      <div className={`list${effectiveMode === "priority" ? " priority" : ""}`} role="table" aria-label="Connections">
        <div className="lhead grid" role="row">
          <div className="c-drag" />
          <div className="c-check"><input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = selectedCount > 0 && !allSelected; }} onChange={onSelectAll} aria-label="Select all" /></div>
          <div className="c-rank"><Tip text="Gateway order: 1 gets the next request, R = reserve, – = out until its window resets">#</Tip></div>
          <div className="c-name">Account</div>
          <div className="c-status">Status</div>
          <div className="c-quota">
            <div className="c-q5"><Tip className="w" text="5-hour session quota left">5h</Tip><span className="n">Quota left</span></div>
            <div className="c-qw"><Tip className="w" text="Weekly (7-day) quota left. A tick marks the account's keep %">Week</Tip></div>
          </div>
          <div className="c-act" />
        </div>
        {effectiveMode === "priority" && isResetFirst && (
          <div className="ghead">Priority<span className="hint">Drag <Ic name="drag_indicator" /> to reorder. Under Reset first, priority only breaks ties and orders reserve accounts.</span></div>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            {g.title && <div className="ghead">{g.title}<span className="c">{g.rows.length}</span>{g.hint && <span className="hint">{g.hint}</span>}</div>}
            {g.rows.map(row)}
          </div>
        ))}
      </div>

      <div className="card-foot">
        <span>{error && !view ? `Live quota unavailable (${error})` : view ? `Live quota · refreshed every ${POLL_MS / 1000}s · strategy ${strategy}` : "Loading live quota…"}</span>
        <span className="legend">
          <span><i className="dot t-ok" />Usable now</span>
          <span><i className="dot t-warn" />Back within 24h</span>
          <span><i className="dot t-err" />Out a day or more</span>
          <span><i className="dot t-rsv" />Reserve</span>
        </span>
      </div>

      <div className="tip" ref={tipRef} role="tooltip" />
      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </section>
  );
}

QuotaConnectionList.propTypes = {
  providerId: PropTypes.string.isRequired,
  connections: PropTypes.array.isRequired,
  strategyOverride: PropTypes.string,
  onStrategyChange: PropTypes.func.isRequired,
  isSelected: PropTypes.func.isRequired,
  onToggleSelect: PropTypes.func.isRequired,
  onSelectAll: PropTypes.func.isRequired,
  onClearSelection: PropTypes.func.isRequired,
  onReorder: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onTest: PropTypes.func.isRequired,
  onTestAll: PropTypes.func.isRequired,
  onStopTestAll: PropTypes.func.isRequired,
  testAllRunning: PropTypes.bool,
  testAllSummary: PropTypes.object,
  onBulkDelete: PropTypes.func.isRequired,
  onBulkProxy: PropTypes.func.isRequired,
  onBulkToggle: PropTypes.func.isRequired,
  autoPingFor: PropTypes.func,
  onToggleAutoPing: PropTypes.func,
  proxyPools: PropTypes.array,
  onUpdateProxy: PropTypes.func.isRequired,
  oneByOneResults: PropTypes.object,
  onAdd: PropTypes.func.isRequired,
  extraAddButtons: PropTypes.node,
};
