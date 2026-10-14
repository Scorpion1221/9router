// ~/.9r/config.json (mode 600): { endpoint, token }. Env vars win:
// NINE_ROUTER_OPS_URL / NINE_ROUTER_OPS_TOKEN (handy for cron and CI).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = process.env.NINE_ROUTER_OPS_HOME || path.join(os.homedir(), ".9r");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const TOKEN_RE = /^9rops_[A-Za-z0-9_-]{40,60}$/;

export function readConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { /* none yet */ }
  const rawEndpoint = process.env.NINE_ROUTER_OPS_URL || file.endpoint || null;
  const rawToken = (process.env.NINE_ROUTER_OPS_TOKEN || file.token || "").trim() || null;
  let endpoint = null;
  let problem = null;
  // The env path gets the same checks as `config set` (https for remote hosts).
  try { endpoint = rawEndpoint ? normalizeEndpoint(rawEndpoint) : null; } catch (e) { problem = `endpoint: ${e.message}`; }
  if (rawToken && !TOKEN_RE.test(rawToken)) problem = problem || "token is not a valid ops token (expected 9rops_ followed by 43 characters, no spaces or line breaks)";
  return {
    endpoint,
    token: rawToken,
    problem,
    source: {
      endpoint: process.env.NINE_ROUTER_OPS_URL ? "env NINE_ROUTER_OPS_URL" : file.endpoint ? CONFIG_FILE : null,
      token: process.env.NINE_ROUTER_OPS_TOKEN ? "env NINE_ROUTER_OPS_TOKEN" : file.token ? CONFIG_FILE : null,
    },
  };
}

export function writeConfig(patch) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { /* new file */ }
  const next = { ...file, ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  fs.chmodSync(CONFIG_FILE, 0o600);
  return next;
}

export function maskToken(token) {
  if (!token) return null;
  return token.length > 14 ? `${token.slice(0, 10)}…${token.slice(-4)}` : "***";
}

export function normalizeEndpoint(raw) {
  let url = String(raw || "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "http:" && !local) throw new Error("refusing plain http to a remote host: the token would travel in clear text (use https)");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}
