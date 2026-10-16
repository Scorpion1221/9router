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
const SHORT = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const formatFull = (t) => FULL.format(new Date(t));

/** One time per row: a countdown inside 24h, weekday + time beyond it. */
export function formatWhen(t, now = Date.now()) {
  const d = t - now;
  if (d <= 0) return "now";
  if (d < DAY) return `in ${formatDuration(d)}`;
  return d > 6 * DAY ? FULL.format(new Date(t)) : SHORT.format(new Date(t));
}

const ts = (iso) => (iso ? Date.parse(iso) : null);

/** When an out-of-rotation account is usable again. */
export function backAt(account) {
  return ts(account.lockedUntil) || ts(account.eligibleAt);
}

function modelName(window) {
  const n = String(window).split(":")[1] || window;
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** The empty window that explains why an account is out (its reset matches the lock). */
function blockingWindow(account) {
  const t = backAt(account);
  const zero = [
    account.windows?.["5h"] && { key: "5h", ...account.windows["5h"] },
    account.windows?.["7d"] && { key: "7d", ...account.windows["7d"] },
    ...(account.modelWindows || []).map((w) => ({ key: w.window, ...w })),
  ].filter((w) => w && w.remainingPct != null && w.remainingPct <= 0);
  if (!zero.length) return null;
  if (t) zero.sort((x, y) => Math.abs((ts(x.resetAt) || 1e15) - t) - Math.abs((ts(y.resetAt) || 1e15) - t));
  return zero[0];
}

const limitLabel = (key) => (key === "5h" ? "5h limit" : key === "7d" ? "Weekly limit" : `${modelName(key)} weekly limit`);

/** Parse the stored upstream error ("[429]: {...}") into code / type / message. */
export function parseUpstreamError(raw) {
  if (!raw) return null;
  const code = (raw.match(/^\[(\d{3})\]/) || [])[1] || null;
  const type = (raw.match(/"error":\{"type":"([^"]+)"/) || [])[1] || (raw.match(/"type":"([^"]+)"/) || [])[1] || null;
  return { code, type, raw };
}

function errorLabel(raw) {
  const e = parseUpstreamError(raw);
  if (!e) return "Unavailable";
  if (e.code === "429") return "Rate limited";
  if (e.code === "401" || e.code === "403") return "Auth failed";
  if (e.code?.startsWith("5")) return "Upstream error";
  return "Unavailable";
}

/**
 * ONE status per account from the pool view.
 * tone: ok | warn | err | reserve | info | muted
 */
export function accountStatus(account, { strategy, servingReserve = false, now = Date.now() } = {}) {
  if (!account.active) return { tone: "muted", label: "Disabled", group: "off" };
  const order = account.order;
  if (order) {
    if (order === "1") return { tone: "ok", label: "In use", live: true, group: "rotation" };
    if (order.startsWith("R")) {
      if (servingReserve && order === "R1") return { tone: "ok", label: "In use", live: true, group: "rotation" };
      return { tone: "reserve", label: "Standby", group: "rotation" };
    }
    return { tone: "ok", label: order === "2" ? "Up next" : "Ready", group: "rotation" };
  }
  // Round robin shows no order; an account that is not locked is in rotation.
  if (strategy === "round-robin" && account.state === "ready") return { tone: "ok", label: "Ready", group: "rotation" };
  const t = backAt(account);
  if (account.state === "below keep") return { tone: "info", label: `Holding ${account.keepPct}%`, back: t, group: "waiting" };
  const win = blockingWindow(account);
  const tone = t && t - now < DAY ? "warn" : "err";
  return { tone, label: win ? limitLabel(win.key) : errorLabel(account.lastError), back: t, window: win?.key || null, group: "waiting" };
}

const rankOf = (order) => (!order ? Infinity : order.startsWith("R") ? 1000 + Number(order.slice(1)) : Number(order));

/** Gateway order: in rotation (by order), then waiting (by when back), then disabled. */
export function groupAccounts(accounts, { strategy, now = Date.now() } = {}) {
  const servingReserve = !accounts.some((a) => a.active && a.order === "1");
  const withStatus = accounts.map((a) => ({ account: a, status: accountStatus(a, { strategy, servingReserve, now }) }));
  const byPriority = (x, y) => (x.account.priority ?? 0) - (y.account.priority ?? 0);
  const rotation = withStatus.filter((r) => r.status.group === "rotation")
    .sort((x, y) => rankOf(x.account.order) - rankOf(y.account.order) || byPriority(x, y));
  const waiting = withStatus.filter((r) => r.status.group === "waiting")
    .sort((x, y) => (x.status.back || Infinity) - (y.status.back || Infinity) || byPriority(x, y));
  const off = withStatus.filter((r) => r.status.group === "off").sort(byPriority);
  return { rotation, waiting, off };
}

/** Summary counts + the next account to come back. */
export function poolSummary(groups) {
  const all = [...groups.rotation, ...groups.waiting, ...groups.off];
  const inUse = groups.rotation.find((r) => r.status.live) || null;
  const reserve = groups.rotation.filter((r) => r.status.tone === "reserve");
  const ready = groups.rotation.filter((r) => r.status.tone === "ok");
  const next = groups.waiting.find((r) => r.status.back) || null;
  return {
    total: all.length,
    usable: ready.length,
    reserve: reserve.length,
    out: groups.waiting.length,
    disabled: groups.off.length,
    inUse,
    next,
    strip: all,
  };
}

export const TONE_DOT = {
  ok: "bg-green-500",
  warn: "bg-amber-500",
  err: "bg-red-500",
  reserve: "bg-violet-500",
  info: "bg-blue-500",
  muted: "bg-gray-400 dark:bg-gray-500",
};

export const TONE_CHIP = {
  ok: "bg-green-500/10 text-green-700 dark:text-green-400",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  err: "bg-red-500/[0.08] text-red-600 dark:text-red-400",
  reserve: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  info: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  muted: "bg-black/[0.04] text-text-muted dark:bg-white/[0.06]",
};
