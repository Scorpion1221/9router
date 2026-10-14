// 9r — ops CLI for a remote 9router. AXI conventions: TOON on stdout (data,
// errors and next steps alike), nothing interactive, unknown flags rejected,
// exit 0 ok / 1 error / 2 usage. `9r check` exits 0 ok, 1 warn, 2 crit.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toToon } from "./toon.js";
import { api, CliError } from "./client.js";
import { readConfig, writeConfig, maskToken, normalizeEndpoint, CONFIG_FILE, TOKEN_RE } from "./config.js";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
import { VERSION } from "./version.js";

const out = (value) => process.stdout.write(toToon(value) + "\n");
const pct = (r) => (r == null ? null : `${(r * 100).toFixed(1)}%`);
const ms = (v) => (v == null ? null : v >= 10000 ? `${(v / 1000).toFixed(0)}s` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const ago = (iso) => {
  if (!iso) return null;
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return `in ${until(iso)}`;
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const until = (iso) => {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 86400)}d`;
};
const statusText = (obj) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ") || "-";
const binPath = () => {
  const p = fileURLToPath(new URL("../bin/9r.js", import.meta.url));
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

// ── flag parsing ────────────────────────────────────────────────────────────
function parseFlags(args, spec, cmd) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") { flags.help = true; continue; }
    if (!a.startsWith("--")) { positionals.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (!(name in spec)) {
      const valid = Object.keys(spec).map((k) => `--${k}`).join(", ") || "(none)";
      throw new CliError(`unknown flag --${name} for \`${cmd}\``, { help: [`valid flags for \`${cmd}\`: ${valid} (--help always allowed)`], exitCode: 2 });
    }
    if (spec[name] === "bool") { flags[name] = true; continue; }
    const value = inline ?? args[++i];
    if (value == null || value.startsWith("--")) throw new CliError(`--${name} needs a value`, { help: [`e.g. \`${cmd} --${name} <value>\``], exitCode: 2 });
    flags[name] = value;
  }
  return { flags, positionals };
}

// ── commands ────────────────────────────────────────────────────────────────
const COMMANDS = {};

COMMANDS.home = {
  flags: {},
  help: "9r — live gateway overview (same as `9r status`)",
  async run() {
    const cfg = readConfig();
    const head = { bin: binPath(), description: "Ops CLI for a remote 9router gateway: health, accounts, quota, usage, checks" };
    if (!cfg.endpoint || !cfg.token) {
      out({ ...head, status: "not configured", help: ["Run `9r config set --endpoint https://<gateway> --token <ops token>`", "Create the token in the dashboard: Settings → Ops tokens"] });
      return 0;
    }
    const s = await api("/status");
    out({ ...head, endpoint: cfg.endpoint, ...renderStatus(s), help: homeHelp(s) });
    return 0;
  },
};

function renderStatus(s) {
  const h = s.lastHour;
  return {
    gateway: { version: s.gateway.version, uptime: until(new Date(Date.now() + s.gateway.uptimeSec * 1000).toISOString()), draining: s.gateway.draining },
    lastHour: {
      requests: h.requests,
      success: pct(h.successRate),
      errors: h.errors,
      aborted: h.aborted,
      ttftP50: ms(h.ttftP50),
      ttftP90: ms(h.ttftP90),
    },
    pools: s.pools.map((p) => ({ provider: p.provider, accounts: p.total, ok: p.ok, locked: p.locked, disabled: p.disabled })),
  };
}

function homeHelp(s) {
  const help = [];
  const hot = s.pools.find((p) => p.locked > 0);
  if (hot) help.push(`Run \`9r accounts --provider ${hot.provider}\` to see locked accounts`);
  if (s.lastHour.errors > 0) help.push("Run `9r errors --since 1h` for upstream error breakdown");
  help.push("Run `9r health --since 24h --by hour` for the trend", "Run `9r check` for a thresholded ok/warn/crit verdict");
  return help.slice(0, 3);
}

COMMANDS.status = { ...COMMANDS.home, help: "9r status — gateway overview: version, last-hour success/latency, account pools" };
COMMANDS.status.run = async () => {
  out(renderStatus(await api("/status")));
  return 0;
};

COMMANDS.health = {
  flags: { since: "value", by: "value" },
  help: [
    "9r health [--since 1h] [--by hour|model|key|error|status]",
    "Client-visible request outcomes. Aborts (client closed) and rejected requests (4xx from bad input) are not counted against success.",
    "  --since   window: 30m, 6h, 2d (default 1h, max 7d)",
    "  --by      group rows (default: one total row)",
    "examples:",
    "  9r health --since 24h --by hour",
    "  9r health --since 6h --by model",
  ].join("\n"),
  async run({ flags }) {
    const res = await api("/health", { query: { since: flags.since || "1h", by: flags.by } });
    if (!res.rows.length) { out({ health: `0 requests since ${res.since}` }); return 0; }
    out({
      since: res.since,
      rows: res.rows.map((r) => ({
        [flags.by || "scope"]: r.key, requests: r.total, success: pct(r.successRate), errors: r.error, aborted: r.aborted,
        rejected: r.rejected, ttftP50: ms(r.ttftP50), ttftP90: ms(r.ttftP90), statuses: statusText(r.status),
      })),
    });
    return 0;
  },
};

COMMANDS.accounts = {
  flags: { provider: "value", since: "value", state: "value" },
  help: [
    "9r accounts [--provider claude] [--since 1h] [--state ok|locked|disabled]",
    "Upstream account pool: state, lock expiry, attempts and 429s in the window, last success.",
    "examples:",
    "  9r accounts --provider claude",
    "  9r accounts --state locked",
  ].join("\n"),
  async run({ flags }) {
    const res = await api("/accounts", { query: { provider: flags.provider, since: flags.since || "1h" } });
    let list = res.accounts;
    if (flags.state) list = list.filter((a) => a.state === flags.state);
    if (!list.length) {
      out({ accounts: `0 accounts${flags.provider ? ` for provider ${flags.provider}` : ""}${flags.state ? ` in state ${flags.state}` : ""}` });
      return 0;
    }
    const rows = list.map((a) => ({
      name: a.name, provider: a.provider, state: a.state,
      lockedFor: a.locks.length ? until(a.locks[a.locks.length - 1].until) : null,
      attempts: a.attempts, ok: a.ok, r429: a.rateLimited, lastOk: ago(a.lastOkAt),
    }));
    const locked = list.filter((a) => a.state === "locked").length;
    out({
      count: `${list.length} accounts, ${locked} locked (window ${flags.since || "1h"})`,
      accounts: rows,
      help: [`Run \`9r quota <name>\` for an account's remaining quota`],
    });
    return 0;
  },
};

COMMANDS.quota = {
  flags: { refresh: "bool" },
  help: [
    "9r quota <account name or id> [--refresh]",
    "Remaining quota windows for one account (5h / weekly / per-model), as the dashboard shows them.",
    "  --refresh   bypass the provider-side cache",
    "examples:",
    "  9r quota huiqian-team",
  ].join("\n"),
  async run({ flags, positionals }) {
    const id = positionals[0];
    if (!id) throw new CliError("account name or id is required", { help: ["9r quota <name>  (list names with `9r accounts`)"], exitCode: 2 });
    const res = await api(`/accounts/${encodeURIComponent(id)}/quota`, { query: { force: flags.refresh ? 1 : null } });
    if (!res.supported || !res.rows.length) {
      out({ account: res.account.name, provider: res.account.provider, quota: res.message || "no quota data" });
      return 0;
    }
    out({
      account: res.account.name, provider: res.account.provider, plan: res.plan || null,
      windows: res.rows.map((r) => ({ name: r.name, remaining: `${r.remainingPct}%`, resetsIn: until(r.resetAt) })),
    });
    return 0;
  },
};

COMMANDS.errors = {
  flags: { since: "value" },
  help: "9r errors [--since 1h]\nFailed upstream attempts grouped by provider and error class (rate_limit, overloaded, empty_stream, stream_stall, …).",
  async run({ flags }) {
    const res = await api("/errors", { query: { since: flags.since || "1h" } });
    if (!res.rows.length) { out({ errors: `0 failed upstream attempts in ${res.since}` }); return 0; }
    out({ since: res.since, errors: res.rows.map((r) => ({ "provider | error": r.key, count: r.error + r.aborted + r.rejected, lastAt: ago(r.lastTs ? new Date(r.lastTs).toISOString() : null) })) });
    return 0;
  },
};

COMMANDS.usage = {
  flags: { since: "value", by: "value", model: "value" },
  help: [
    "9r usage [--since 24h] [--by model|key|key,model] [--model <substring>]",
    "Which client key calls which model, with success and latency.",
    "examples:",
    "  9r usage --by key,model --model opus-5",
  ].join("\n"),
  async run({ flags }) {
    const res = await api("/usage", { query: { since: flags.since || "24h", by: flags.by || "model", model: flags.model } });
    const rows = res.rows;
    if (!rows.length) { out({ usage: `0 requests in ${res.since}${flags.model ? ` matching '${flags.model}'` : ""}` }); return 0; }
    out({ since: res.since, rows: rows.map((r) => ({ [flags.by || "model"]: r.key, requests: r.total, success: pct(r.successRate), ttftP50: ms(r.ttftP50), lastAt: ago(r.lastTs ? new Date(r.lastTs).toISOString() : null) })) });
    return 0;
  },
};

COMMANDS.combos = {
  flags: {},
  help: "9r combos\nCombo names, strategy and member chain (fallback order).",
  async run() {
    const res = await api("/combos");
    if (!res.combos.length) { out({ combos: "0 combos configured" }); return 0; }
    out({ combos: res.combos.map((c) => ({ name: c.name, strategy: c.strategy, members: c.models.join(" → ") })) });
    return 0;
  },
};

COMMANDS.keys = {
  flags: {},
  help: "9r keys\nInference API key names and access restrictions (the keys themselves are never shown).",
  async run() {
    const res = await api("/keys");
    if (!res.keys.length) { out({ keys: "0 API keys" }); return 0; }
    out({ keys: res.keys.map((k) => ({ name: k.name, active: k.active, restricted: k.restricted, allow: k.allow.join(" ") || null })) });
    return 0;
  },
};

COMMANDS.check = {
  flags: { since: "value", "success-warn": "value", "success-crit": "value", "ttft-warn": "value", "ttft-crit": "value", "min-requests": "value" },
  help: [
    "9r check [--since 15m] [--success-warn 0.97] [--success-crit 0.9] [--ttft-warn 15000] [--ttft-crit 45000] [--min-requests 20]",
    "Thresholded verdict for scheduled monitoring. Exit code: 0 ok, 1 warn, 2 crit, 3 could not check (including bad flags).",
    "examples:",
    "  9r check",
    "  9r check --since 1h --success-warn 0.99",
  ].join("\n"),
  async run({ flags }) {
    const map = { since: "since", "success-warn": "successWarn", "success-crit": "successCrit", "ttft-warn": "ttftP90WarnMs", "ttft-crit": "ttftP90CritMs", "min-requests": "minRequests" };
    const query = Object.fromEntries(Object.entries(flags).filter(([k]) => map[k]).map(([k, v]) => [map[k], v]));
    for (const [k, v] of Object.entries(query)) {
      if (k !== "since" && !Number.isFinite(Number(v))) throw new CliError(`--${Object.keys(map).find((f) => map[f] === k)} must be a number`, { exitCode: 3 });
    }
    let res;
    try { res = await api("/check", { query }); }
    catch (e) { e.exitCode = 3; throw e; }
    const bad = res.checks.filter((c) => c.level !== "ok");
    out({
      level: res.level,
      since: res.since,
      checks: res.checks.map((c) => ({ name: c.name, level: c.level, value: c.value, detail: c.detail })),
      ...(bad.length ? { help: ["Run `9r errors` and `9r accounts --state locked` to see why"] } : {}),
    });
    return { ok: 0, warn: 1, crit: 2 }[res.level] ?? 3;
  },
};

COMMANDS.token = {
  flags: { scope: "value", expires: "value" },
  help: [
    "9r token list | create <name> [--scope read|operate|admin] [--expires 2026-12-31] | revoke <name or id>",
    "Manage ops tokens (needs an admin token). `create` prints the new token once.",
  ].join("\n"),
  async run({ flags, positionals }) {
    const [sub, arg] = positionals;
    if (sub === "list" || !sub) {
      const res = await api("/tokens");
      out({ tokens: res.tokens.map((t) => ({ name: t.name, scope: t.scope, prefix: t.prefix, state: t.revokedAt ? "revoked" : t.expiresAt && Date.parse(t.expiresAt) < Date.now() ? "expired" : "active", lastUsed: ago(t.lastUsedAt), lastIp: t.lastUsedIp })) });
      return 0;
    }
    if (sub === "create") {
      if (!arg) throw new CliError("token name is required", { help: ["9r token create <name> --scope read"], exitCode: 2 });
      const res = await api("/tokens", { method: "POST", body: { name: arg, scope: flags.scope || "read", expiresAt: flags.expires || null } });
      out({ created: res.record.name, scope: res.record.scope, token: res.token, note: "shown once; store it now" });
      return 0;
    }
    if (sub === "revoke") {
      if (!arg) throw new CliError("token name or id is required", { help: ["9r token revoke <name>"], exitCode: 2 });
      const res = await api("/tokens", { method: "DELETE", query: { id: arg } });
      out({ token: `${res.revoked} ${res.alreadyRevoked ? "already revoked (no-op)" : "revoked"}`, ...(res.self ? { warning: "that was the token this CLI uses" } : {}) });
      return 0;
    }
    throw new CliError(`unknown token subcommand '${sub}'`, { help: ["9r token list | create <name> | revoke <name>"], exitCode: 2 });
  },
};

COMMANDS.config = {
  flags: { endpoint: "value", token: "value" },
  help: [
    "9r config show | set [--endpoint https://gateway] [--token 9rops_… | --token -]",
    "`--token -` reads the token from stdin (keeps it out of shell history).",
    `Stored in ${CONFIG_FILE} (mode 600). Env NINE_ROUTER_OPS_URL / NINE_ROUTER_OPS_TOKEN override it.`,
  ].join("\n"),
  async run({ flags, positionals }) {
    const sub = positionals[0] || "show";
    if (sub === "set") {
      if (!flags.endpoint && !flags.token) throw new CliError("nothing to set", { help: ["9r config set --endpoint https://<gateway> --token <ops token>"], exitCode: 2 });
      const patch = {};
      if (flags.endpoint) {
        try { patch.endpoint = normalizeEndpoint(flags.endpoint); }
        catch (e) { throw new CliError(e.message, { exitCode: 2 }); }
      }
      if (flags.token) {
        let token = flags.token;
        // `--token -` reads it from stdin, keeping it out of argv and shell history.
        if (token === "-") token = (await readStdin()).trim();
        if (!TOKEN_RE.test(token)) throw new CliError("that is not an ops token (expected 9rops_ followed by 43 characters)", { help: ["Create one in the dashboard: Settings → Ops tokens"], exitCode: 2 });
        patch.token = token;
      }
      writeConfig(patch);
    } else if (sub !== "show") {
      throw new CliError(`unknown config subcommand '${sub}'`, { help: ["9r config show | set"], exitCode: 2 });
    }
    const cfg = readConfig();
    const view = { endpoint: cfg.endpoint, token: maskToken(cfg.token), file: CONFIG_FILE, endpointFrom: cfg.source.endpoint, tokenFrom: cfg.source.token, ...(cfg.problem ? { problem: cfg.problem } : {}) };
    if (cfg.endpoint && cfg.token && !cfg.problem) {
      try {
        const who = await api("/whoami");
        view.connection = `ok as '${who.token.name}' (${who.token.scope})`;
      } catch (e) {
        view.connection = `failed: ${e.message}`;
      }
    }
    out(view);
    return 0;
  },
};

// ── entry ───────────────────────────────────────────────────────────────────
const RENAMED = { "--json": "output is always TOON; there is no --json", "--provider-id": "use --provider" };

function globalHelp() {
  return [
    `9r ${VERSION} — ops CLI for a remote 9router gateway`,
    "commands:",
    "  9r                 live overview (status + next steps)",
    "  9r health          request success/latency (--since, --by hour|model|key|error|status)",
    "  9r accounts        upstream account pool state (--provider, --state)",
    "  9r quota <name>    remaining quota for one account",
    "  9r errors          failed upstream attempts by provider and error class",
    "  9r usage           requests by model / key (--by key,model --model opus)",
    "  9r combos | keys   routing config (read-only)",
    "  9r check           ok/warn/crit verdict for cron (exit 0/1/2)",
    "  9r token …         manage ops tokens (admin)",
    "  9r config …        endpoint + token",
    "Run `9r <command> --help` for flags and examples.",
  ].join("\n");
}

export async function main(argv) {
  const [first, ...rest] = argv;
  try {
    if (first === "--help" || first === "-h" || first === "help") { process.stdout.write(globalHelp() + "\n"); return 0; }
    for (const a of argv) if (RENAMED[a]) throw new CliError(`${a}: ${RENAMED[a]}`, { exitCode: 2 });
    const name = !first || first.startsWith("--") ? "home" : first;
    const cmd = COMMANDS[name];
    if (!cmd) throw new CliError(`unknown command '${first}'`, { help: [`commands: ${Object.keys(COMMANDS).filter((c) => c !== "home").join(", ")}`, "Run `9r --help`"], exitCode: 2 });
    let parsed;
    try { parsed = parseFlags(name === "home" ? argv : rest, cmd.flags, `9r ${name === "home" ? "" : name}`.trim()); }
    catch (e) { if (name === "check" && e instanceof CliError) e.exitCode = 3; throw e; }
    const { flags, positionals } = parsed;
    if (flags.help) { process.stdout.write((cmd.help || globalHelp()) + "\n"); return 0; }
    return await cmd.run({ flags, positionals });
  } catch (e) {
    if (e instanceof CliError) {
      out({ error: e.message, ...(e.help.length ? { help: e.help } : {}) });
      return e.exitCode;
    }
    out({ error: `unexpected failure: ${e?.message || e}`, help: ["Re-run; if it persists, check `9r config show`"] });
    return 1;
  }
}

export const __test__ = { parseFlags, renderStatus, path };
