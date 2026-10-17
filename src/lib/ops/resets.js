// Limit resets over the ops API: Claude's free "limit reset" grants (cedar_ember)
// and Codex's banked reset credits.
//
// Viewing is read-only. Spending one takes two calls:
//   prepare  re-reads the account live, refuses when the reset would do nothing
//            (or nothing useful), and returns what it would refill plus a one-time
//            code. Nothing is spent.
//   confirm  spends it with that code, after checking the offer has not changed.
// The idempotency key (Claude request_id / Codex redeem_request_id) is fixed at
// prepare, so retrying an attempt that got no definite answer can't spend twice.
import crypto from "node:crypto";
import "open-sse/index.js";
import { getProviderConnections, getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { getUsageForProvider, consumeClaudeResetGrant, consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { clearQuotaSnapshot } from "open-sse/services/quotaState.js";
import { opsError } from "./auth.js";
import { maskName, redactSecrets } from "./redact.js";

const PREPARE_TTL_MS = 5 * 60 * 1000;
// How long an attempt without a definite answer may be retried with the same key
// (Claude Code reuses an unsettled request_id for 10 minutes).
const RETRY_TTL_MS = 10 * 60 * 1000;
const MAX_WRONG_CODES = 5;
// How long a confirmed outcome is kept: the same code returns it, and a new prepare warns about it.
const RECENT_RESET_MS = 30 * 60 * 1000;
const WEEKLY_SOON_MS = 24 * 3600 * 1000;
const LIST_CONCURRENCY = 3;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// One pending reset per account, in the DB (kv scope "limitResets") so both
// rollout slots and a restarted process see the same entry and the same
// idempotency key. Mutations are compare-and-set on the stored entry; the busy
// set (process-local, on globalThis because Next bundles this module into several
// route chunks) stops two calls in this process from interleaving their awaits.
const KV_SCOPE = "limitResets";
const busy = globalThis.__9rResetsBusy ??= new Set();

async function readEntry(connectionId) {
  const db = await getAdapter();
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [KV_SCOPE, connectionId]);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/** Write `next` (or delete with null) only if the stored entry is still `expected`. */
async function swapEntry(connectionId, expected, next) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [KV_SCOPE, connectionId]);
    const current = row ? row.value : null;
    const want = expected ? JSON.stringify(expected) : null;
    if (current !== want) return;
    if (next) db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)", [KV_SCOPE, connectionId, JSON.stringify(next)]);
    else db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [KV_SCOPE, connectionId]);
    ok = true;
  });
  return ok;
}

/** An entry is live until it expires; an attempt without a definite answer stays live until its retry window ends. */
const isLive = (e, now = Date.now()) => !!e && e.expiresAt > now;
const isUnsettled = (e, now = Date.now()) => isLive(e, now) && !e.settled && (e.attempts > 0 || !!e.inFlightSince);

/**
 * True while a reset on this account may be in flight or unsettled. The dashboard
 * reset routes check it so a second surface can't spend with a fresh key.
 */
export async function hasUnsettledReset(connectionId) {
  return isUnsettled(await readEntry(connectionId).catch(() => null));
}

async function withAccountLock(connectionId, fn) {
  if (busy.has(connectionId)) throw opsError(409, "another reset call on this account is running; try again in a moment");
  busy.add(connectionId);
  try { return await fn(); } finally { busy.delete(connectionId); }
}

const CLAUDE_LIMIT_NAMES = {
  five_hour: "5h",
  seven_day: "weekly",
  seven_day_overage_included: "weekly",
  seven_day_opus: "weekly opus",
  seven_day_sonnet: "weekly sonnet",
};
const limitName = (c) => CLAUDE_LIMIT_NAMES[c] || String(c).replace(/^seven_day_/, "weekly ");
const limitNames = (list) => [...new Set((list || []).map(limitName))];
const ts = (iso) => (iso ? Date.parse(iso) : NaN);
const hours = (ms) => (ms >= 48 * 3600e3 ? `${Math.round(ms / 86400e3)}d` : `${Math.max(1, Math.round(ms / 3600e3))}h`);

export function supportsResets(conn) {
  const authType = String(conn?.authType || "").replace(/_/g, "").toLowerCase();
  if (conn?.provider === "claude") return authType === "oauth";
  if (conn?.provider === "codex") return authType === "oauth" || authType === "accesstoken";
  return false;
}

function accountView(conn) {
  return { id: conn.id, name: maskName(conn.name || conn.email || conn.id), provider: conn.provider };
}

async function context(conn, { forceRefresh = false } = {}) {
  const proxyConfig = await resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };
  let fresh = conn;
  if (String(conn.authType).toLowerCase() === "oauth") {
    try {
      fresh = (await refreshAndUpdateCredentials(conn, forceRefresh, proxyOptions)).connection;
    } catch (e) {
      throw opsError(502, `credential refresh failed: ${redactSecrets(e?.message || e, 160)}`);
    }
  }
  return { conn: fresh, proxyOptions };
}

// A spend must not be silently resent over a direct connection when the proxy
// drops mid-request: with strictProxy that surfaces as "no answer" instead, and
// goes through the check-before-resend path.
const spendProxy = (ctx) => ({ ...ctx.proxyOptions, strictProxy: true });

async function readUsage(ctx, { force = false } = {}) {
  let usage;
  try {
    usage = await getUsageForProvider(ctx.conn, ctx.proxyOptions, { force });
  } catch (e) {
    throw opsError(502, `cannot read usage: ${redactSecrets(e?.message || e, 160)}`);
  }
  // A live read is as good as a poll for routing (and can lift a stale quota lock).
  const { applyQuotaReading } = await import("@/sse/services/quotaPoller.js");
  await applyQuotaReading(ctx.conn, usage).catch(() => {});
  return usage;
}

/** Normalized quota windows of a usage result: [{ name, remainingPct, resetAt }]. */
function usageWindows(provider, usage) {
  const out = [];
  for (const [key, q] of Object.entries(usage?.quotas || {})) {
    if (!q || typeof q !== "object") continue;
    const used = Number(q.used);
    if (!Number.isFinite(used)) continue;
    let name = key;
    if (provider === "claude") name = key === "session (5h)" ? "5h" : key === "weekly (7d)" ? "weekly" : key.replace(/^weekly (.+) \(7d\)$/, "weekly $1");
    else name = key === "session" ? "5h" : key.replace(/_session$/, " 5h").replace(/_weekly$/, " weekly");
    out.push({ name, remainingPct: Math.round(Math.max(0, 100 - used)), resetAt: q.resetAt || null });
  }
  return out;
}

// ── Claude ──────────────────────────────────────────────────────────────────

function claudeGrantState(g, rc, now) {
  if (g.resetsLeft <= 0) return "used up";
  if (g.paused) return "paused";
  if (g.endsAt && ts(g.endsAt) <= now) return "expired";
  if (g.startsAt && ts(g.startsAt) > now) return "not started";
  if (rc.cooldownUntil && ts(rc.cooldownUntil) > now) return "cooldown";
  if (g.blocking.length) return `blocked (${limitNames(g.blocking).join(" + ")} stays exhausted)`;
  if (g.usableNow) return g.useRequiresLimit ? "usable now" : "usable now (anytime)";
  return g.useRequiresLimit ? "at limit only" : "unavailable";
}

function claudeView(usage, now) {
  const windows = usageWindows("claude", usage);
  const rc = usage?.resetCredits;
  if (usage?.resetEligibility === undefined && !rc) {
    // Legacy fallback (the OAuth usage endpoint answered 429) carries no reset block.
    return { readable: false, message: redactSecrets(usage?.message || "reset status unavailable (usage endpoint rate-limited?); try again in a few minutes"), windows };
  }
  if (!rc) {
    const reason = usage?.resetEligibility?.reason;
    return { readable: true, available: 0, state: reason ? `not eligible (${reason})` : "no reset program on this account", grants: [], windows };
  }
  const grants = rc.grants.map((g) => ({
    label: g.label || "limit reset",
    resetsLeft: g.resetsLeft,
    resetsTotal: g.resetsTotal,
    refills: limitNames(g.clears),
    useBy: g.endsAt,
    startsAt: g.startsAt,
    state: claudeGrantState(g, rc, now),
    offered: g.id === rc.offeredGrantId,
    percentUsed: Object.fromEntries(Object.entries(g.percentUsed || {}).map(([k, v]) => [limitName(k), v])),
  }));
  const offered = grants.find((g) => g.offered);
  return {
    readable: true,
    available: rc.availableCount,
    state: offered ? offered.state : rc.availableCount > 0 ? "none on offer right now" : "none left",
    refills: offered?.refills || [],
    useBy: offered?.useBy || null,
    weeklyResetsAt: rc.weeklyResetsAt,
    cooldownUntil: rc.cooldownUntil && ts(rc.cooldownUntil) > now ? rc.cooldownUntil : null,
    atLimit: rc.atLimit,
    grants,
    windows,
  };
}

/** Why the offered Claude grant can't be spent now, or null when it can. */
function claudeRefusal(rc, now) {
  const grant = rc.grants.find((g) => g.id === rc.offeredGrantId);
  if (!grant) return rc.availableCount > 0 ? "no reset is on offer right now; try again in a minute" : "no usable limit resets left on this account";
  if (rc.cooldownUntil && ts(rc.cooldownUntil) > now) return `another reset was just started on this account; try again after ${rc.cooldownUntil}`;
  if (grant.paused) return "the reset on offer is paused";
  if (grant.endsAt && ts(grant.endsAt) <= now) return "the reset on offer has expired";
  if (grant.blocking.length) return `this reset doesn't refill ${limitNames(grant.blocking).join(" + ")}, so it can't unblock the account until that resets on its own`;
  if (!grant.usableNow) {
    return grant.useRequiresLimit
      ? "this reset only works at a usage limit, and the account isn't at one now (nothing would be used)"
      : "the server does not offer this reset right now";
  }
  return null;
}

function claudePlan(rc, windows, now) {
  const grant = rc.grants.find((g) => g.id === rc.offeredGrantId);
  const refills = limitNames(grant.clears);
  const warnings = [];
  const notes = [];
  const used = Object.entries(grant.percentUsed || {});
  if (!grant.useRequiresLimit && used.length) {
    const [limit, pct] = used.sort((a, b) => b[1] - a[1])[0];
    if (pct < 100) warnings.push(`the account is not at a limit: ${100 - pct}% of its ${limitName(limit)} limit is still left, which this reset throws away`);
  }
  const weeklyAt = ts(rc.weeklyResetsAt);
  if (Number.isFinite(weeklyAt)) {
    notes.push(`the weekly reset day stays ${rc.weeklyResetsAt}`);
    if (grant.clears.some((c) => c.startsWith("seven_day")) && weeklyAt - now < WEEKLY_SOON_MS && weeklyAt > now) {
      warnings.push(`the weekly limit refills on its own in ${hours(weeklyAt - now)}; a reset now only buys that much`);
    }
  }
  if (grant.endsAt) notes.push(`this reset is usable until ${grant.endsAt}`);
  return {
    action: "use 1 Claude limit reset",
    refills,
    resetsLeftAfter: Math.max(0, rc.availableCount - 1),
    current: windows,
    notes,
    warnings,
  };
}

// ── Codex ───────────────────────────────────────────────────────────────────

// A full reset refreshes the account's main windows (Pro accounts only have a weekly one).
function codexRefills(windows) {
  const main = windows.map((w) => w.name).filter((n) => n === "5h" || n === "weekly");
  return main.length ? main : ["5h", "weekly"];
}

function codexView(usage, credits, now) {
  const windows = usageWindows("codex", usage);
  if (!usage?.quotas && usage?.message) return { readable: false, message: redactSecrets(usage.message), windows };
  const available = Number(credits?.availableCount ?? usage?.resetCredits?.availableCount ?? 0) || 0;
  const list = (credits?.credits || []).map((c) => ({
    label: c.title || "full reset",
    status: c.status,
    grantedAt: c.grantedAt,
    useBy: c.expiresAt,
    expired: !!(c.expiresAt && ts(c.expiresAt) <= now),
  }));
  const usable = list.filter((c) => c.status === "available" && !c.expired).sort((a, b) => (ts(a.useBy) || Infinity) - (ts(b.useBy) || Infinity));
  return {
    readable: true,
    available,
    state: available > 0 ? (usage?.limitReached ? "usable now (at limit)" : "usable") : "none left",
    refills: available > 0 ? codexRefills(windows) : [],
    useBy: usable[0]?.useBy || null,
    weeklyResetsAt: windows.find((w) => w.name === "weekly")?.resetAt || null,
    atLimit: usage?.limitReached === true,
    credits: credits ? list : undefined,
    windows,
  };
}

function codexPlan(view, now) {
  const warnings = [];
  const notes = ["moves the weekly reset to about 7 days after now (Codex re-anchors the weekly window on a reset)"];
  const weekly = view.windows.find((w) => w.name === "weekly");
  const weeklyAt = ts(weekly?.resetAt);
  if (Number.isFinite(weeklyAt) && weeklyAt > now && weeklyAt - now < WEEKLY_SOON_MS) {
    warnings.push(`the weekly window refills on its own in ${hours(weeklyAt - now)}; a reset now buys little and pushes the next weekly reset back`);
  }
  const roomy = view.windows.filter((w) => (w.name === "5h" || w.name === "weekly") && w.remainingPct > 0);
  if (!view.atLimit && roomy.length) {
    warnings.push(`the account is not at a limit (${roomy.map((w) => `${w.name} ${w.remainingPct}% left`).join(", ")}); that remaining usage is thrown away`);
  }
  if (view.useBy) notes.push(`spends the credit that expires first (${view.useBy})`);
  return {
    action: "use 1 Codex reset credit",
    refills: view.refills,
    resetsLeftAfter: Math.max(0, view.available - 1),
    current: view.windows,
    notes,
    warnings,
  };
}

async function codexCredits(ctx) {
  try {
    return await getCodexRateLimitResetCredits(ctx.conn.accessToken, ctx.proxyOptions, ctx.conn.providerSpecificData);
  } catch (e) {
    throw opsError(502, `cannot read Codex reset credits: ${redactSecrets(e?.message || e, 160)}`);
  }
}

// The credit the Codex CLI would spend: the available one that expires first.
function soonestCreditId(credits, now) {
  const usable = (credits?.credits || [])
    .filter((c) => c.id && c.status === "available" && !(c.expiresAt && ts(c.expiresAt) <= now))
    .sort((a, b) => (ts(a.expiresAt) || Infinity) - (ts(b.expiresAt) || Infinity));
  return usable[0]?.id || null;
}

// ── views ───────────────────────────────────────────────────────────────────

async function loadAccount(idOrConn) {
  const conn = typeof idOrConn === "string" ? await getProviderConnectionById(idOrConn) : idOrConn;
  if (!conn) throw opsError(404, "account not found");
  if (!supportsResets(conn)) throw opsError(400, `limit resets exist for Claude OAuth and Codex accounts, not ${conn.provider}/${conn.authType}`);
  return conn;
}

/** One account's reset status. Read-only: never spends anything. */
export async function getAccountResets(conn, { detail = true } = {}) {
  conn = await loadAccount(conn);
  const now = Date.now();
  const ctx = await context(conn);
  const usage = await readUsage(ctx);
  let credits = null;
  let creditsError = null;
  if (conn.provider === "codex" && detail) {
    try { credits = await codexCredits(ctx); } catch (e) { creditsError = e.message; }
  }
  const view = conn.provider === "claude" ? claudeView(usage, now) : codexView(usage, credits, now);
  if (creditsError) view.creditsError = creditsError;
  const p = await readEntry(conn.id).catch(() => null);
  return {
    account: accountView(conn),
    ...view,
    ...(isLive(p, now) && !p.settled ? { pending: { preparedBy: p.tokenName, expiresAt: new Date(p.expiresAt).toISOString(), attempts: p.attempts } } : {}),
    ...(isLive(p, now) && p.settled ? { lastOutcome: { by: p.tokenName, outcome: p.settled.outcome, spent: p.settled.spent } } : {}),
  };
}

/** Every Claude/Codex account's reset status (cached usage reads, no credit details). */
export async function listResets({ provider = null } = {}) {
  if (provider && provider !== "claude" && provider !== "codex") throw opsError(400, `limit resets exist for claude and codex, not '${provider}'`);
  const conns = (await getProviderConnections(provider ? { provider } : {})).filter((c) => c.isActive && supportsResets(c));
  const rows = new Array(conns.length);
  let next = 0;
  async function worker() {
    while (next < conns.length) {
      const i = next++;
      try {
        rows[i] = await getAccountResets(conns[i], { detail: false });
      } catch (e) {
        rows[i] = { account: accountView(conns[i]), readable: false, message: redactSecrets(e?.message || e, 160) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, conns.length) }, worker));
  return rows;
}

// ── prepare / confirm ───────────────────────────────────────────────────────

function newCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

function codesMatch(a, b) {
  const x = Buffer.from(String(a || "").toUpperCase());
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Check one account's reset live and park it for confirmation. Spends nothing.
 * Refuses (409) when the reset would not apply or not help.
 */
export async function prepareReset(conn, token) {
  conn = await loadAccount(conn);
  return withAccountLock(conn.id, async () => {
    const prev = await readEntry(conn.id);
    const now = Date.now();
    if (isUnsettled(prev, now)) {
      const who = prev.tokenId === token.id ? "" : ` (prepared by '${prev.tokenName}')`;
      throw opsError(409, `an earlier attempt on this account got no definite answer${who}; retry it with its code (same idempotency key; it is checked before anything is resent) or wait until ${new Date(prev.expiresAt).toISOString()}`);
    }

    const ctx = await context(conn);
    const usage = await readUsage(ctx, { force: true });
    let plan;
    const entry = { connectionId: conn.id, provider: conn.provider, tokenId: token.id, tokenName: token.name, attempts: 0, wrongCodes: 0, inFlightSince: null };
    if (conn.provider === "claude") {
      const view = claudeView(usage, now);
      if (!view.readable) throw opsError(409, view.message);
      const rc = usage.resetCredits;
      if (!rc) throw opsError(409, view.state);
      const refusal = claudeRefusal(rc, now);
      if (refusal) throw opsError(409, refusal);
      const grant = rc.grants.find((g) => g.id === rc.offeredGrantId);
      plan = claudePlan(rc, view.windows, now);
      Object.assign(entry, { grantId: grant.id, baseline: grant.resetsLeft, requestId: crypto.randomUUID() });
    } else {
      const credits = await codexCredits(ctx);
      const view = codexView(usage, credits, now);
      if (!view.readable) throw opsError(409, view.message);
      if (view.available <= 0) throw opsError(409, "no Codex reset credits left on this account");
      plan = codexPlan(view, now);
      Object.assign(entry, { creditId: soonestCreditId(credits, now), baseline: view.available, requestId: crypto.randomUUID() });
    }
    // A reset that just went through (e.g. its answer never reached the CLI) must
    // not be mistaken for "nothing happened yet"; carried over by later prepares.
    const lastReset = prev?.settled?.outcome === "reset" && prev.settledAt ? { at: prev.settledAt, by: prev.tokenName } : prev?.lastReset || null;
    if (lastReset && now - lastReset.at < RECENT_RESET_MS) {
      entry.lastReset = lastReset;
      plan.warnings.unshift(`a reset was already used on this account at ${new Date(lastReset.at).toISOString()} (by '${lastReset.by}'); this would be another one`);
    }
    entry.code = newCode();
    entry.expiresAt = Date.now() + PREPARE_TTL_MS;
    // Another slot may have prepared or confirmed meanwhile: only replace what we checked.
    if (!(await swapEntry(conn.id, prev, entry))) throw opsError(409, "the reset state of this account changed while checking; run prepare again");
    return {
      account: accountView(conn),
      ...plan,
      spent: false,
      confirm: { code: entry.code, expiresAt: new Date(entry.expiresAt).toISOString() },
    };
  });
}

// What a confirm returns; also stored so re-running the same code returns it again.
async function settle(conn, entry, body) {
  const result = { account: accountView(conn), ...body };
  const settled = { ...entry, inFlightSince: null, settled: result, settledAt: Date.now(), expiresAt: Date.now() + RECENT_RESET_MS };
  await swapEntry(conn.id, entry, settled);
  if (body.outcome === "reset") {
    // The refilled account is usable now, not when its old lock would have expired.
    clearQuotaSnapshot(conn.id);
    const { liftQuotaLockNow } = await import("@/sse/services/quotaPoller.js");
    await liftQuotaLockNow(conn.id).catch(() => {});
  }
  return result;
}

async function keepForRetry(conn, entry, message) {
  const next = { ...entry, attempts: entry.attempts + 1, inFlightSince: null, expiresAt: Date.now() + RETRY_TTL_MS };
  await swapEntry(conn.id, entry, next);
  return {
    account: accountView(conn),
    outcome: "uncertain",
    spent: "unknown",
    message: `${message}. Retry with the same code: it checks whether this attempt landed and resends only with the same idempotency key`,
    confirm: { code: entry.code, expiresAt: new Date(next.expiresAt).toISOString() },
  };
}

// Drop a prepared entry that confirm decided not to send (nothing was spent).
async function discard(conn, entry) {
  await swapEntry(conn.id, entry, null);
}

const CLAUDE_REFUSED = {
  already_used: "that reset was already used",
  not_limited: "the account isn't at a usage limit; nothing was used",
  cooldown: "another reset was just started on this account; nothing was used",
  ineligible: "the account is not eligible for limit resets; nothing was used",
};

async function confirmClaude(conn, entry, sent) {
  const now = Date.now();
  // A retry, or an attempt whose process died mid-send: check before resending.
  const retry = entry.attempts > 0 || !!sent;
  const ctx = await context(conn, { forceRefresh: retry && entry.lastStatus === 401 });
  const usage = await readUsage(ctx, { force: true });
  const rc = usage?.resetCredits;
  if (usage?.resetEligibility === undefined && !rc) {
    // The usage endpoint cools down for a few minutes after a 429; keep the code alive meanwhile.
    const kept = { ...entry, inFlightSince: null, attempts: retry ? Math.max(1, entry.attempts) : 0, expiresAt: Math.max(entry.expiresAt, Date.now() + PREPARE_TTL_MS) };
    await swapEntry(conn.id, entry, kept);
    throw opsError(503, `could not re-read the reset status (usage endpoint rate-limited); nothing was sent. Retry the same code in a few minutes (valid until ${new Date(kept.expiresAt).toISOString()})`);
  }
  const grant = rc?.grants.find((g) => g.id === entry.grantId);
  // Before resending an attempt that got no answer, look whether it landed: never
  // risk a second spend on the strength of request_id dedup alone.
  if (retry && grant && grant.resetsLeft < entry.baseline) {
    return settle(conn, entry, { outcome: "reset", spent: true, message: `the earlier attempt went through after all (resets left ${entry.baseline} → ${grant.resetsLeft}); nothing more was sent`, resetsLeft: rc.availableCount, cleared: [] });
  }
  if (retry && !grant) {
    return settle(conn, entry, { outcome: "reset", spent: "likely", message: "the reset grant is gone from the account, most likely because the earlier attempt went through; nothing more was sent. Check with `9r resets show`", resetsLeft: rc?.availableCount ?? null, cleared: [] });
  }
  if (retry && rc.offeredGrantId !== entry.grantId) {
    return settle(conn, entry, { outcome: "refused", spent: false, message: "the earlier attempt did not go through (its resets are untouched) and that reset is no longer on offer; run prepare again" });
  }
  if (!retry) {
    const changed = !rc || rc.offeredGrantId !== entry.grantId ? "a different reset is on offer now"
      : claudeRefusal(rc, now) || (grant.resetsLeft !== entry.baseline ? `the reset count changed since prepare (${entry.baseline} → ${grant.resetsLeft})` : null);
    if (changed) {
      await discard(conn, entry);
      throw opsError(409, `${changed}; nothing was used. Run prepare again`);
    }
  }
  const marked = { ...entry, inFlightSince: Date.now() };
  if (!(await swapEntry(conn.id, entry, marked))) throw opsError(409, "the reset state of this account changed; nothing was sent. Check `9r resets show`");
  let res;
  try {
    res = await consumeClaudeResetGrant(ctx.conn.accessToken, entry.grantId, spendProxy(ctx), { requestId: entry.requestId });
  } catch (e) {
    // Thrown before the reset request went out (bad id, organization lookup failed).
    await swapEntry(conn.id, marked, { ...entry, inFlightSince: null });
    throw opsError(502, `${redactSecrets(e?.message || e, 160)}; nothing was sent. Retry the same code`);
  }
  const after = { ...marked, lastStatus: res.status };
  await swapEntry(conn.id, marked, after);
  if (res.ok) return settle(conn, after, { outcome: "reset", spent: true, cleared: limitNames(res.cleared), resetsLeft: res.resetsLeft });
  if (retry && res.result === "already_used") {
    return settle(conn, after, { outcome: "reset", spent: true, message: "the earlier attempt went through after all", cleared: [], resetsLeft: res.resetsLeft });
  }
  if (!res.uncertain) {
    return settle(conn, after, { outcome: "refused", spent: false, result: res.result, reason: res.reason, message: CLAUDE_REFUSED[res.result] || `not applied (${res.result})` });
  }
  return keepForRetry(conn, after, `couldn't confirm the reset went through (${redactSecrets(res.message || res.result || `HTTP ${res.status}`, 120)})`);
}

async function confirmCodex(conn, entry, sent) {
  const now = Date.now();
  const retry = entry.attempts > 0 || !!sent;
  const ctx = await context(conn, { forceRefresh: retry && entry.lastStatus === 401 });
  const credits = await codexCredits(ctx);
  // Same caution as Claude: if the credit count dropped, the earlier attempt most
  // likely landed, so don't send again (the backend would dedupe, but don't rely on it).
  if (retry && credits.availableCount < entry.baseline) {
    return settle(conn, entry, { outcome: "reset", spent: "likely", message: `reset credits went from ${entry.baseline} to ${credits.availableCount}, so the earlier attempt most likely went through; nothing more was sent. Check with \`9r resets show\``, resetsLeft: credits.availableCount });
  }
  if (!retry) {
    const changed = credits.availableCount <= 0 ? "no Codex reset credits left on this account"
      : credits.availableCount !== entry.baseline || (entry.creditId && soonestCreditId(credits, now) !== entry.creditId) ? "the reset credits changed since prepare" : null;
    if (changed) {
      await discard(conn, entry);
      throw opsError(409, `${changed}; nothing was used. Run prepare again`);
    }
  }
  const marked = { ...entry, inFlightSince: Date.now() };
  if (!(await swapEntry(conn.id, entry, marked))) throw opsError(409, "the reset state of this account changed; nothing was sent. Check `9r resets show`");
  let res;
  try {
    res = await consumeCodexRateLimitResetCredit(ctx.conn.accessToken, entry.requestId, spendProxy(ctx), {
      providerSpecificData: ctx.conn.providerSpecificData,
      creditId: entry.creditId,
    });
  } catch (e) {
    await swapEntry(conn.id, marked, { ...entry, inFlightSince: null });
    throw opsError(502, `${redactSecrets(e?.message || e, 160)}; nothing was sent. Retry the same code`);
  }
  const after = { ...marked, lastStatus: res.status };
  await swapEntry(conn.id, marked, after);
  if (res.ok) {
    return settle(conn, after, {
      outcome: "reset",
      spent: true,
      ...(res.alreadyRedeemed ? { message: "the earlier attempt went through after all" } : {}),
      windowsReset: res.windowsReset,
      // already_redeemed: this key spent one earlier, and the credits read predates it.
      resetsLeft: Math.max(0, credits.availableCount - 1),
    });
  }
  if (res.nothingToReset) return settle(conn, after, { outcome: "refused", spent: false, result: "nothing_to_reset", message: "usage doesn't need a reset right now; nothing was used" });
  if (res.noCredit) return settle(conn, after, { outcome: "refused", spent: false, result: "no_credit", message: "no reset credit available; nothing was used" });
  return keepForRetry(conn, after, `couldn't confirm the reset went through (${redactSecrets(res.message || res.code || `HTTP ${res.status}`, 120)})`);
}

// A send that started this long ago without being recorded belongs to a process
// that died mid-request; treat it as an attempt with no answer.
const STALE_SEND_MS = 2 * 60 * 1000;

/** Spend the reset parked by prepareReset. Needs its code, from the same token. */
export async function confirmReset(conn, token, code) {
  conn = await loadAccount(conn);
  return withAccountLock(conn.id, async () => {
    const entry = await readEntry(conn.id);
    const now = Date.now();
    if (!isLive(entry, now)) throw opsError(404, "nothing prepared for this account (or it expired); run prepare first");
    if (entry.tokenId !== token.id) throw opsError(403, `this reset was prepared by '${entry.tokenName}'; confirm it with the same token`);
    if (!codesMatch(code, entry.code)) {
      const next = { ...entry, wrongCodes: (entry.wrongCodes || 0) + 1 };
      // Too many wrong codes kill a fresh prepare; an attempt in progress keeps its key.
      await swapEntry(conn.id, entry, next.wrongCodes >= MAX_WRONG_CODES && !entry.attempts && !entry.inFlightSince ? null : next);
      throw opsError(400, "wrong confirmation code");
    }
    // Already settled: return the recorded outcome, never send again.
    if (entry.settled) return { ...entry.settled, message: [entry.settled.message, "(already confirmed; this is the recorded outcome)"].filter(Boolean).join(" ") };
    let sent = false;
    if (entry.inFlightSince) {
      if (now - entry.inFlightSince < STALE_SEND_MS) throw opsError(409, "this reset is being confirmed right now");
      sent = true;
    }
    const base = sent ? { ...entry, inFlightSince: null, attempts: Math.max(1, entry.attempts) } : entry;
    if (base !== entry && !(await swapEntry(conn.id, entry, base))) throw opsError(409, "the reset state of this account changed; try again");
    return conn.provider === "claude" ? confirmClaude(conn, base, sent) : confirmCodex(conn, base, sent);
  });
}

export const __test__ = { readEntry, swapEntry, busy, claudeView, claudeRefusal, codexView, usageWindows };
