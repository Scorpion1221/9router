// Ops health/latency metrics (/api/ops/*). Two kinds of rows:
//   request — what the client got from one /v1 call (model = requested model or combo)
//   attempt — one upstream call on one account (provider/model/connection resolved)
// Buffered and flushed in batches so the hot path never waits on SQLite. No
// request or response content and no keys are stored: the client key is mapped
// to its name at flush time.
import { getAdapter } from "../driver.js";
import { onDrain, isDraining } from "@/lib/shutdown.js";

export const REQUEST_METRICS_RETENTION_DAYS = Number(process.env.REQUEST_METRICS_RETENTION_DAYS) || 7;
const FLUSH_INTERVAL_MS = 3000;
const BATCH_SIZE = 200;
const MAX_BUFFER = 5000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const KEY_NAMES_TTL_MS = 60 * 1000;

if (!global.__9rRequestMetrics) {
  global.__9rRequestMetrics = {
    buffer: [], timer: null, flushing: null, lastPrune: 0, drainHooked: false,
    keyNames: null, keyNamesAt: 0,
    // Unit tests that run the gateway must not write into the developer's DB.
    enabled: process.env.NODE_ENV !== "test",
  };
}
const state = global.__9rRequestMetrics;

const COLUMNS = ["ts", "kind", "provider", "model", "connectionId", "keyName", "endpoint", "stream", "status", "outcome",
  "errorType", "ttftMs", "totalMs"];
const INSERT_SQL = `INSERT INTO requestMetrics (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;

// Coarse error class from an HTTP status, shared by the request and attempt rows.
export function outcomeForStatus(status) {
  if (status >= 200 && status < 400) return "ok";
  if (status === 499) return "aborted";
  if (status === 429 || status >= 500) return "error";
  return "rejected";
}

export function errorTypeForStatus(status) {
  if (!status || status < 400) return null;
  if (status === 499) return "client_abort";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 422 || status === 413) return "bad_request";
  if (status === 404) return "not_found";
  if (status === 529) return "overloaded";
  if (status === 503) return "unavailable";
  if (status === 502 || status === 504) return "bad_gateway";
  return status >= 500 ? "upstream_5xx" : `http_${status}`;
}

const int = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const str = (v, max = 200) => (v == null || v === "" ? null : String(v).slice(0, max));

/**
 * Record one outcome. Never throws, never blocks the caller.
 * kind: "request" | "attempt"; outcome: "ok" | "error" | "aborted" | "rejected"
 * (rejected = the client's own request was refused, e.g. 400/403 — not a gateway fault).
 * `apiKey` (raw) is only held in memory until flush, where it becomes keyName.
 */
export function recordRequestMetric(m) {
  try {
    if (!state.enabled || !m || typeof m !== "object") return;
    if (state.buffer.length >= MAX_BUFFER) state.buffer.shift(); // keep the newest under DB trouble
    state.buffer.push({
      ts: int(m.ts) ?? Date.now(),
      kind: m.kind === "attempt" ? "attempt" : "request",
      provider: str(m.provider), model: str(m.model), connectionId: str(m.connectionId),
      apiKey: typeof m.apiKey === "string" && m.apiKey ? m.apiKey : null,
      endpoint: str(m.endpoint, 100),
      stream: m.stream == null ? null : (m.stream ? 1 : 0),
      status: int(m.status), outcome: str(m.outcome, 20), errorType: str(m.errorType, 60),
      ttftMs: int(m.ttftMs), totalMs: int(m.totalMs),
    });
    if (!state.drainHooked) {
      state.drainHooked = true;
      onDrain(() => { flushRequestMetrics().catch(() => {}); });
    }
    if (isDraining() || state.buffer.length >= BATCH_SIZE) {
      flushRequestMetrics().catch(() => {});
    } else if (!state.timer) {
      state.timer = setTimeout(() => { state.timer = null; flushRequestMetrics().catch(() => {}); }, FLUSH_INTERVAL_MS);
      state.timer.unref?.();
    }
  } catch { /* metrics must never affect a request */ }
}

function keyNameMap(db, { force = false } = {}) {
  if (!force && state.keyNames && Date.now() - state.keyNamesAt < KEY_NAMES_TTL_MS) return state.keyNames;
  const map = new Map();
  for (const r of db.all(`SELECT key, name, id FROM apiKeys`)) map.set(r.key, r.name || r.id);
  state.keyNames = map;
  state.keyNamesAt = Date.now();
  return map;
}

export async function flushRequestMetrics() {
  // A flush already running may not have picked up rows pushed after it began:
  // wait for it, then drain whatever is left, so readers always see every row.
  while (state.flushing) await state.flushing;
  if (state.buffer.length === 0) return;
  let release;
  state.flushing = new Promise((r) => { release = r; });
  try {
    const db = await getAdapter();
    // sql.js rewrites the whole DB file on every write: not a place for a
    // per-request metrics stream.
    if (db.driver === "sql.js") {
      if (state.enabled) console.warn("[requestMetrics] disabled on the sql.js driver (it rewrites the DB file on every write)");
      state.enabled = false;
      state.buffer.length = 0;
      return;
    }
    while (state.buffer.length) {
      const batch = state.buffer.splice(0, BATCH_SIZE);
      let names = keyNameMap(db);
      // A key created since the last refresh: reload once before calling it unknown.
      if (batch.some((m) => m.apiKey && !names.has(m.apiKey)) && Date.now() - state.keyNamesAt > 1000) names = keyNameMap(db, { force: true });
      db.transaction(() => {
        for (const m of batch) {
          const keyName = m.apiKey ? (names.get(m.apiKey) || "unknown-key") : null;
          db.run(INSERT_SQL, COLUMNS.map((c) => (c === "keyName" ? keyName : m[c])));
        }
      });
    }
    if (Date.now() - state.lastPrune > PRUNE_INTERVAL_MS) {
      state.lastPrune = Date.now();
      db.run(`DELETE FROM requestMetrics WHERE ts < ?`, [Date.now() - REQUEST_METRICS_RETENTION_DAYS * 86400000]);
    }
  } catch (e) {
    console.warn(`[requestMetrics] flush failed: ${e.message}`);
  } finally {
    state.flushing = null;
    release();
  }
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const GROUP_COLUMNS = new Set(["provider", "model", "connectionId", "keyName", "errorType", "status"]);

/**
 * Aggregate rows of one kind in [since, until]. Filters: provider, connectionId,
 * keyName, model (substring), outcome. groupBy: null | "hour" | a column, or a
 * list of columns (joined key).
 */
export async function getRequestMetricsSummary({ kind = "request", since, until = Date.now(), provider, connectionId, keyName, model, outcome, groupBy = null } = {}) {
  await flushRequestMetrics();
  const db = await getAdapter();
  const conds = ["kind = ?", "ts >= ?", "ts <= ?"];
  const params = [kind, since, until];
  if (provider) { conds.push("provider = ?"); params.push(provider); }
  if (connectionId) { conds.push("connectionId = ?"); params.push(connectionId); }
  if (keyName) { conds.push("keyName = ?"); params.push(keyName); }
  if (model) { conds.push("model LIKE ?"); params.push(`%${model}%`); }
  if (outcome) { conds.push("outcome = ?"); params.push(outcome); }
  const where = conds.join(" AND ");

  const groupCols = (Array.isArray(groupBy) ? groupBy : groupBy ? [groupBy] : []).filter((c) => c === "hour" || GROUP_COLUMNS.has(c));
  // Column names come from the allowlist above, never from the caller.
  const exprs = groupCols.map((c) => (c === "hour" ? "(ts / 3600000)" : `COALESCE(CAST(${c} AS TEXT), '-')`));
  const keyExpr = exprs.length ? exprs.join(" || ' | ' || ") : "'all'";
  const groupSql = exprs.length ? `GROUP BY ${exprs.join(", ")}` : "";

  // Counts and last-seen per group, in SQLite.
  const totals = db.all(
    `SELECT ${keyExpr} AS k, ${groupCols.includes("hour") ? "MIN(ts / 3600000) AS hourBucket," : ""}
       COUNT(*) AS total,
       SUM(outcome = 'ok') AS ok, SUM(outcome = 'aborted') AS aborted, SUM(outcome = 'rejected') AS rejected,
       SUM(outcome NOT IN ('ok', 'aborted', 'rejected') OR outcome IS NULL) AS error,
       MAX(CASE WHEN outcome = 'ok' THEN ts END) AS lastOkTs, MAX(ts) AS lastTs
     FROM requestMetrics WHERE ${where} ${groupSql}`,
    params
  );
  if (!exprs.length && totals[0] && !totals[0].total) totals.length = 0;
  const groups = new Map(totals.map((t) => [t.k, {
    key: groupCols.includes("hour") && groupCols.length === 1
      ? new Date(t.hourBucket * 3600000).toISOString().slice(0, 13) + ":00Z"
      : t.k,
    total: t.total, ok: t.ok || 0, error: t.error || 0, aborted: t.aborted || 0, rejected: t.rejected || 0,
    status: {}, errorTypes: {}, ttft: [], lastOkTs: t.lastOkTs ?? null, lastTs: t.lastTs ?? null,
  }]));
  // Histograms.
  for (const r of db.all(`SELECT ${keyExpr} AS k, status, COUNT(*) AS n FROM requestMetrics WHERE ${where} AND status IS NOT NULL ${exprs.length ? `GROUP BY ${exprs.join(", ")}, status` : "GROUP BY status"}`, params)) {
    const g = groups.get(r.k); if (g) g.status[r.status] = r.n;
  }
  for (const r of db.all(`SELECT ${keyExpr} AS k, errorType, COUNT(*) AS n FROM requestMetrics WHERE ${where} AND errorType IS NOT NULL ${exprs.length ? `GROUP BY ${exprs.join(", ")}, errorType` : "GROUP BY errorType"}`, params)) {
    const g = groups.get(r.k); if (g) g.errorTypes[r.errorType] = r.n;
  }
  // Percentiles need the values, but only of successful rows and one column.
  for (const r of db.all(`SELECT ${keyExpr} AS k, ttftMs FROM requestMetrics WHERE ${where} AND outcome = 'ok' AND ttftMs IS NOT NULL`, params)) {
    const g = groups.get(r.k); if (g) g.ttft.push(r.ttftMs);
  }

  const out = [...groups.values()].map((g) => {
    g.ttft.sort((a, b) => a - b);
    const judged = g.ok + g.error; // client aborts and rejected requests don't count against the gateway
    return {
      key: g.key, total: g.total, ok: g.ok, error: g.error, aborted: g.aborted, rejected: g.rejected,
      successRate: judged ? g.ok / judged : null,
      ttftP50: pct(g.ttft, 50), ttftP90: pct(g.ttft, 90), ttftP99: pct(g.ttft, 99),
      status: g.status, errorTypes: g.errorTypes, lastOkTs: g.lastOkTs, lastTs: g.lastTs,
    };
  });
  out.sort((a, b) => (groupCols.includes("hour") ? String(a.key).localeCompare(String(b.key)) : b.total - a.total));
  return { kind, since, until, rows: out };
}

/** Last successful upstream attempt per connection over the whole retention window. */
export async function getLastOkByConnection({ provider } = {}) {
  await flushRequestMetrics();
  const db = await getAdapter();
  const rows = db.all(
    `SELECT connectionId, MAX(ts) AS ts FROM requestMetrics
     WHERE kind = 'attempt' AND outcome = 'ok' AND connectionId IS NOT NULL ${provider ? "AND provider = ?" : ""}
     GROUP BY connectionId`,
    provider ? [provider] : []
  );
  return new Map(rows.map((r) => [r.connectionId, r.ts]));
}

export const __test__ = { state, pct };
