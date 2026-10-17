"use client";

// Limit reset dialog for the quota connection list (Claude limit resets, Codex
// reset credits). Opening it is read-only: it shows how many resets are left and
// runs the server's live check (prepare), which refuses a reset that would not
// apply and says what one would refill. Only "Use 1 reset" spends one (confirm,
// with the one-time code from the check). Same flow and double-spend protection as
// `9r resets use`; an attempt with no definite answer can only be retried with
// the same code.
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { formatFull, formatWhen } from "./quotaRouting";

const Ic = ({ name, className = "" }) => <span className={`ms material-symbols-outlined ${className}`} aria-hidden="true">{name}</span>;
Ic.propTypes = { name: PropTypes.string.isRequired, className: PropTypes.string };

async function call(url, init) {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || `HTTP ${res.status}`), { status: res.status });
  return data;
}

const when = (iso, now) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (t > now ? formatWhen(t, now) : "passed") : "—";
};

// The server's notes carry ISO times (shared with `9r resets`); show them as local time + countdown.
const humanize = (text, now) => String(text).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})/g, (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${formatFull(t)}${t > now ? ` (${formatWhen(t, now)})` : ""}` : iso;
});

export default function LimitResetDialog({ connection, onClose, onDone }) {
  const [view, setView] = useState(null);
  const [plan, setPlan] = useState(null);
  const [checkError, setCheckError] = useState(null);
  const [phase, setPhase] = useState("loading"); // loading | ready | spending | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  // Fixed when the dialog opens: the times shown describe that live check.
  const [now] = useState(() => Date.now());
  const kind = connection.provider === "codex" ? "Codex reset credit" : "Claude limit reset";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await call(`/api/providers/${connection.id}/resets`);
        if (cancelled) return;
        setView(v);
        if (v.readable === false || !(v.available > 0)) { setPhase("ready"); return; }
        try {
          const p = await call(`/api/providers/${connection.id}/resets/prepare`, { method: "POST" });
          if (!cancelled) setPlan(p);
        } catch (e) {
          // A refusal (409) is the useful answer here: why a reset can't help right now.
          if (!cancelled) setCheckError(e.message);
        }
        if (!cancelled) setPhase("ready");
      } catch (e) {
        if (!cancelled) { setError(e.message); setPhase("ready"); }
      }
    })();
    return () => { cancelled = true; };
  }, [connection.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && phase !== "spending") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  const spend = async () => {
    if (!plan?.confirm?.code) return;
    setPhase("spending");
    setError(null);
    try {
      const res = await call(`/api/providers/${connection.id}/resets/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: plan.confirm.code }),
      });
      setResult(res);
      // An attempt without an answer keeps its code: the retry button reuses it.
      if (res.outcome === "uncertain" && res.confirm?.code) setPlan((p) => ({ ...p, confirm: res.confirm }));
      setPhase(res.outcome === "uncertain" ? "ready" : "done");
      if (res.outcome !== "uncertain") onDone?.(res);
    } catch (e) {
      setError(e.message);
      setPhase("ready");
      onDone?.(null);
    }
  };

  const windows = plan?.current || view?.windows || [];
  const uncertain = result?.outcome === "uncertain";
  const canSpend = phase === "ready" && !!plan?.confirm?.code && (!result || uncertain);

  return (
    <div className="rdlg-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && phase !== "spending") onClose(); }}>
      <div className="rdlg" role="dialog" aria-modal="true" aria-label={`${kind}s`}>
        <div className="rdlg-head">
          <div>
            <h3>{connection.provider === "codex" ? "Codex reset credits" : "Claude limit resets"}</h3>
            <p>{connection.name || connection.email || connection.id}</p>
          </div>
          <button className="ib" type="button" aria-label="Close" onClick={onClose} disabled={phase === "spending"}><Ic name="close" /></button>
        </div>

        <div className="rdlg-body">
          {phase === "loading" && <p className="rdlg-muted"><Ic name="progress_activity" className="spin" /> Checking the account live…</p>}

          {view && (
            <div className="rdlg-stats">
              <span><b>{view.available ?? 0}</b> {view.available === 1 ? "reset" : "resets"} left</span>
              {view.useBy && <span>expires <b title={formatFull(Date.parse(view.useBy))}>{when(view.useBy, now)}</b></span>}
              {view.weeklyResetsAt && <span>weekly refills on its own <b title={formatFull(Date.parse(view.weeklyResetsAt))}>{when(view.weeklyResetsAt, now)}</b></span>}
            </div>
          )}

          {windows.length > 0 && (
            <table className="rdlg-win">
              <thead><tr><th>Window</th><th>Left</th><th>Resets</th></tr></thead>
              <tbody>
                {windows.map((w) => (
                  <tr key={w.name}><td>{w.name}</td><td className={w.remainingPct <= 0 ? "zero" : ""}>{w.remainingPct}%</td><td>{when(w.resetAt, now)}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          {view?.readable === false && <p className="rdlg-note warn">{view.message}</p>}
          {view && view.readable !== false && !(view.available > 0) && <p className="rdlg-note">No {kind}s on this account right now.</p>}
          {checkError && <p className="rdlg-note warn"><b>A reset can&apos;t help right now:</b> {checkError}</p>}

          {plan && !result && (
            <div className="rdlg-plan">
              <p><b>{plan.action}</b>: refills {(plan.refills || []).join(" + ") || "the account's limits"} now · {plan.resetsLeftAfter} left after.</p>
              {(plan.warnings || []).map((w) => <p key={w} className="rdlg-note warn"><Ic name="warning" /> {humanize(w, now)}</p>)}
              {(plan.notes || []).map((n) => <p key={n} className="rdlg-note">{humanize(n, now)}</p>)}
              <p className="rdlg-note">This cannot be undone.</p>
            </div>
          )}

          {result && !uncertain && (
            <p className={`rdlg-note ${result.outcome === "reset" ? "ok" : "warn"}`}>
              {result.outcome === "reset" ? <><b>Reset used.</b> {result.message || "The account is usable again."}</> : <><b>Not used:</b> {result.message}</>}
              {result.resetsLeft != null && <> · {result.resetsLeft} left</>}
            </p>
          )}
          {uncertain && <p className="rdlg-note warn"><b>No definite answer yet.</b> {result.message}</p>}
          {error && <p className="rdlg-note warn">{error}</p>}
        </div>

        <div className="rdlg-foot">
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={phase === "spending"}>{phase === "done" ? "Close" : "Cancel"}</button>
          {canSpend && (
            <button className="btn btn-danger" type="button" onClick={spend}>
              <Ic name="restart_alt" />{uncertain ? "Check again (same attempt)" : "Use 1 reset"}
            </button>
          )}
          {phase === "spending" && <button className="btn btn-danger" type="button" disabled><Ic name="progress_activity" className="spin" />Using…</button>}
        </div>
      </div>
    </div>
  );
}

LimitResetDialog.propTypes = {
  connection: PropTypes.shape({ id: PropTypes.string.isRequired, provider: PropTypes.string, name: PropTypes.string, email: PropTypes.string }).isRequired,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func,
};
