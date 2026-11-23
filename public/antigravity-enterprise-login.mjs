// Print the Antigravity Enterprise login JSON for 9Router's "Add Antigravity Enterprise
// account" dialog. Run on the Mac where the Antigravity app is signed in with a
// Workspace (Gemini Enterprise) account; no 9Router needed on that Mac:
//
//   curl -fsSL https://<your-9router>/antigravity-enterprise-login.mjs | node --input-type=module - | pbcopy
//
// It reads the app's keychain entry (service "gemini", account "antigravity"), finds the
// OAuth client compiled into the app that issued that login (checked against Google's
// token endpoint), and prints JSON to stdout. Nothing is sent anywhere else.
// The output contains a refresh token: treat it like a password.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const APP_BIN = "/Applications/Antigravity.app/Contents/Resources/bin/language_server";
const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };

if (process.platform !== "darwin") fail("Run this on the Mac where the Antigravity app is signed in.");

let raw;
try {
  raw = execFileSync("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], { encoding: "utf8" }).trim();
} catch {
  fail("No Antigravity login found in the keychain. Sign in to the Antigravity app first.");
}
if (raw.startsWith("go-keyring-base64:")) raw = Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8");
let login;
try { login = JSON.parse(raw); } catch { fail("The Antigravity keychain entry has an unexpected format."); }
if (login.auth_method !== "gcp" || !login.user_tier) fail("The Antigravity app is signed in with a personal account, not Gemini Enterprise.");
const refreshToken = login.token?.refresh_token;
if (!refreshToken || !login.project_id) fail("The Antigravity login has no refresh token or project. Sign in to the app again.");

let bin;
try { bin = readFileSync(APP_BIN).toString("latin1"); } catch { fail(`Antigravity.app not found (${APP_BIN}).`); }
const ids = [...new Set(bin.match(/\d{6,}-[a-z0-9]{32}\.apps\.googleusercontent\.com/g) || [])];
const secrets = [...new Set(bin.match(/GOCSPX-[A-Za-z0-9_-]{28}/g) || [])];

for (const clientId of ids) {
  for (const clientSecret of secrets) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    }).catch(() => null);
    if (!res?.ok) continue;
    process.stdout.write(`${JSON.stringify({
      type: "antigravity-enterprise",
      clientId,
      clientSecret,
      refreshToken,
      projectId: login.project_id,
      userTier: login.user_tier,
      region: login.region || "global",
      tierDisplayName: login.tier_display_name || "",
    }, null, 2)}\n`);
    process.stderr.write(`Copied the login of project ${login.project_id} (${login.tier_display_name || login.user_tier}).\n`);
    process.exit(0);
  }
}
fail("Google rejected the Antigravity login with every client in the app. Sign in to the Antigravity app again.");
