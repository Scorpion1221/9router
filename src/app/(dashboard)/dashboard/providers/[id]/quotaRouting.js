// Pure helpers for the quota-routed connection list (Claude/Codex): turn the
// /api/providers/pool view into one status per account, one time per row, and
// group rows the way the gateway uses them. No React here so it can be tested.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function formatDuration(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m}m`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }
  const hours = Math.round(m / 60);
  const d = Math.floor(hours / 24);
  const hh = hours % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

// English like the rest of the dashboard (the browser locale would mix in e.g. Chinese weekdays).
const FULL = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const formatFull = (t) => FULL.format(new Date(t));

/**
 * One time per row, always as a countdown ("in 1d 1h", "in 3h 20m"): how long is
 * left is what the list is read for. The absolute time is in tooltips (formatFull).
 */
export function formatWhen(t, now = Date.now()) {
  const d = t - now;
  if (d <= 0) return "now";
  return `in ${formatDuration(d)}`;
}

const ts = (iso) => (iso ? Date.parse(iso) : null);

/** When an out-of-rotation account is usable again. */
export function backAt(account) {
  return ts(account.lockedUntil) || ts(account.eligibleAt);
}

/** Parse the stored upstream error ("[429]: {...}") into code / type / message. */
export function parseUpstreamError(raw) {
  if (!raw) return null;
  const code = (raw.match(/^\[(\d{3})\]/) || [])[1] || null;
  const type = (raw.match(/"error":\{"type":"([^"]+)"/) || [])[1] || (raw.match(/"type":"([^"]+)"/) || [])[1] || null;
  return { code, type, raw };
}

export const modelName = (key) => { const n = String(key).split(":")[1] || key; return n.charAt(0).toUpperCase() + n.slice(1); };
export const winLabel = (key) => (key === "5h" ? "5h" : key === "7d" ? "Week" : `${modelName(key)} · week`);
export const limitLabel = (key) => (key === "5h" ? "5h limit" : key === "7d" ? "Weekly limit" : `${modelName(key)} weekly limit`);
export const windowWord = (key) => (key === "5h" ? "5h" : key === "7d" ? "weekly" : `${modelName(key)} weekly`);

export function windowsOf(a) {
  const out = [];
  if (a.windows?.["5h"]) out.push({ key: "5h", ...a.windows["5h"] });
  if (a.windows?.["7d"]) out.push({ key: "7d", ...a.windows["7d"] });
  (a.modelWindows || []).forEach((m) => out.push({ key: m.window, ...m }));
  return out;
}

// The empty window that explains why an account is out: its reset matches the lock.
export function blocking(a) {
  const t = backAt(a);
  const zero = windowsOf(a).filter((w) => w.remainingPct != null && w.remainingPct <= 0);
  if (!zero.length) return null;
  if (t) zero.sort((x, y) => Math.abs((ts(x.resetAt) || 1e15) - t) - Math.abs((ts(y.resetAt) || 1e15) - t));
  return zero[0];
}

export function errHuman(raw) {
  const e = parseUpstreamError(raw);
  if (!e) return "Unavailable";
  if (e.code === "429") return "Rate limited";
  if (e.code === "401" || e.code === "403") return "Auth failed";
  if (e.code?.startsWith("5")) return "Upstream error";
  return "Request failed";
}

// ONE status per account, derived from the gateway view.
export function statusOf(a, { strategy, servingReserve, now }) {
  if (!a.active) return { tone: "muted", label: "Disabled", group: "off", tip: "Disabled: the gateway never selects it" };
  // Other strategies don't skip an account whose window is empty; it still can't serve.
  const empty = strategy !== "reset-first" && a.state === "ready" ? blocking(a) : null;
  if (empty) {
    const r = ts(empty.resetAt);
    return { tone: r && r - now < DAY ? "warn" : "err", label: limitLabel(empty.key), back: r, win: empty.key, group: "wait", tip: `Usage shows the ${windowWord(empty.key)} window at 0%; ${strategy} still tries it and gets a 429${r ? ` · resets ${formatFull(r)}` : ""}` };
  }
  if (a.order) {
    if (a.order === "1") return { tone: "ok", cls: "use", label: "In use", group: "rot", tip: "The next request goes to this account" };
    if (a.order.startsWith("R")) {
      if (servingReserve && a.order === "R1") return { tone: "ok", cls: "use", label: "In use", group: "rot", tip: "No normal account can take requests, so the first reserve serves" };
      return { tone: "rsv", label: "Standby", group: "rot", tip: `Reserve: takes traffic only when no normal account can${a.keepPct ? `; never goes below keep ${a.keepPct}%` : ""}` };
    }
    return { tone: "ok", label: a.order === "2" ? "Up next" : "Ready", group: "rot", tip: "Takes over when the accounts above run out" };
  }
  if (strategy !== "reset-first" && a.state === "ready") return { tone: "ok", label: "Ready", group: "rot", tip: "Usable" };
  const t = backAt(a);
  if (a.state === "below keep") return { tone: "info", label: `Holding ${a.keepPct}%`, back: t, group: "wait", tip: `Below its keep ${a.keepPct}%: skipped to preserve quota${t ? ` until ${formatFull(t)}` : ""}` };
  const b = blocking(a);
  const tone = t && t - now < DAY ? "warn" : "err";
  const how = a.state === "locked" ? "Locked after a 429" : "Skipped: usage shows 0% left";
  return { tone, label: b ? limitLabel(b.key) : errHuman(a.lastError), back: t, win: b?.key || null, group: "wait", tip: `${how}${t ? ` · back ${formatFull(t)}` : ""}` };
}

export const rankNum = (o) => (!o ? Infinity : o[0] === "R" ? 1000 + Number(o.slice(1)) : Number(o));
export const weekBucket = (a, at) => { const r = ts(a.windows?.["7d"]?.resetAt); return r && r > at + 6e4 ? Math.round(r / HOUR) : Infinity; };

// Where would this account land once it is back (if nothing else changes)?
export function rankWhenBack(a, all) {
  const t = backAt(a);
  if (!t || !a.active || a.role === "reserve") return null;
  const pool = all.filter((x) => x.active && x.role !== "reserve" && (x === a || x.order || (backAt(x) && backAt(x) <= t)));
  pool.sort((x, y) => (weekBucket(x, t) - weekBucket(y, t)) || (x.priority - y.priority));
  const pos = pool.indexOf(a) + 1;
  return { pos, t, known: weekBucket(a, t) !== Infinity, ahead: pos > 1 ? pool[pos - 2] : null, behind: pool[pos] || null };
}
