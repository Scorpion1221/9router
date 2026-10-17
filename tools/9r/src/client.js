// Thin HTTP client for /api/ops/*. Translates every failure into a CliError
// with a next step, so no raw fetch/stack text reaches stdout.
import { readConfig } from "./config.js";

export class CliError extends Error {
  constructor(message, { help = [], exitCode = 1 } = {}) {
    super(message);
    this.help = help;
    this.exitCode = exitCode;
  }
}

const TIMEOUT_MS = Number(process.env.NINE_ROUTER_OPS_TIMEOUT_MS) || 60000;

export async function api(path, { method = "GET", body, query } = {}) {
  const cfg = readConfig();
  if (cfg.problem) throw new CliError(cfg.problem, { help: ["Fix it with `9r config set …` or the NINE_ROUTER_OPS_* env vars"], exitCode: 2 });
  if (!cfg.endpoint || !cfg.token) {
    throw new CliError("not configured: no endpoint or token", {
      help: ["Run `9r config set --endpoint https://<gateway> --token <ops token>`", "Create a token in the dashboard: Settings → Ops tokens"],
      exitCode: 2,
    });
  }
  const url = new URL(`${cfg.endpoint}/api/ops${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== "") url.searchParams.set(k, String(v));

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { "Content-Type": "application/json" } : {}), "User-Agent": "9r" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (e) {
    let reason = e?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000}s` : (e?.cause?.code || e?.message || "network error");
    reason = String(reason).split(cfg.token).join("<token>"); // never echo the token
    throw Object.assign(new CliError(`cannot reach ${cfg.endpoint}: ${reason}`, { help: ["Check the endpoint with `9r config show`"] }), { status: null, noAnswer: true });
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.ok) return data;

  const msg = data?.error || `HTTP ${res.status}`;
  if (res.status === 401) throw new CliError(`unauthorized: ${msg}`, { help: ["The token is wrong, revoked or expired. Set a new one: `9r config set --token <ops token>`"] });
  if (res.status === 403) throw new CliError(msg, { help: ["Use a token with a higher scope (operate/admin)"] });
  if (res.status === 429) throw new CliError(`locked out after failed attempts; retry in ${data?.retryAfter ?? "a few"}s`, { help: ["Fix the token first: `9r config show`"] });
  if (res.status === 404 && /^\/[a-z]/.test(path) && !data?.error) {
    throw new CliError("ops API not found on this gateway", { help: ["The gateway may be older than the ops API; deploy a newer 9router"] });
  }
  // A 5xx without the gateway's own JSON error (e.g. a proxy 502/504) means the
  // request may or may not have run.
  throw Object.assign(new CliError(msg, { exitCode: res.status === 400 ? 2 : 1 }), { status: res.status, noAnswer: res.status >= 500 && !data?.error });
}
