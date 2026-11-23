import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { refreshGoogleToken } from "open-sse/services/tokenRefresh.js";

const execFileAsync = promisify(execFile);

// The Antigravity desktop app (Go language_server, zalando/go-keyring) stores its
// login as a generic keychain password: service "gemini", account "antigravity".
// Value: "go-keyring-base64:" + base64(JSON) →
//   { token: { access_token, refresh_token, expiry, token_type },
//     auth_method: "gcp" | ..., project_id, region, user_tier, tier_display_name }
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";
const GO_KEYRING_PREFIX = "go-keyring-base64:";

// The OAuth client that issued that refresh token is compiled into the app's
// language_server. It is read from the installed app, never stored in this repo.
const LANGUAGE_SERVER_PATHS = [
  "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
];
const CLIENT_ID_RE = /\d{6,}-[a-z0-9]{32}\.apps\.googleusercontent\.com/g;
const CLIENT_SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{28}/g;

export const ANTIGRAVITY_ENTERPRISE_BUNDLE_TYPE = "antigravity-enterprise";

/**
 * Parse the go-keyring payload. Exported for tests.
 * @param {string} raw
 */
export function parseAntigravityKeyringValue(raw) {
  let text = String(raw || "").trim();
  if (text.startsWith(GO_KEYRING_PREFIX)) {
    text = Buffer.from(text.slice(GO_KEYRING_PREFIX.length), "base64").toString("utf8");
  }
  const data = JSON.parse(text);
  const token = data?.token || {};
  return {
    authMethod: data?.auth_method || null,
    accessToken: token.access_token || null,
    refreshToken: token.refresh_token || null,
    expiresAt: token.expiry || null,
    projectId: data?.project_id || null,
    region: data?.region || null,
    userTier: data?.user_tier || null,
    tierDisplayName: data?.tier_display_name || null,
  };
}

/**
 * Validate a pasted credential bundle (the JSON the "read from this Mac" button
 * produces). Returns the normalized bundle or throws with a user-facing message.
 * @param {unknown} input
 */
export function parseAntigravityEnterpriseBundle(input) {
  let data = input;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { throw new Error("The pasted text is not valid JSON."); }
  }
  if (!data || typeof data !== "object") throw new Error("Paste the JSON read from the Antigravity app.");
  const pick = (k) => (typeof data[k] === "string" ? data[k].trim() : "");
  const bundle = {
    clientId: pick("clientId"),
    clientSecret: pick("clientSecret"),
    refreshToken: pick("refreshToken"),
    projectId: pick("projectId"),
    userTier: pick("userTier"),
    region: pick("region") || "global",
    tierDisplayName: pick("tierDisplayName"),
  };
  const missing = ["clientId", "clientSecret", "refreshToken", "projectId", "userTier"].filter((k) => !bundle[k]);
  if (missing.length) throw new Error(`Missing field(s): ${missing.join(", ")}.`);
  if (!/\.apps\.googleusercontent\.com$/.test(bundle.clientId)) throw new Error("clientId is not a Google OAuth client id.");
  if (!/^[a-z0-9-]+$/i.test(bundle.region)) throw new Error("region is invalid.");
  return bundle;
}

async function readKeychainLogin() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT, "-w"],
      { timeout: 15000 },
    ));
  } catch {
    return { error: "No Antigravity login found in the keychain. Sign in to the Antigravity app first." };
  }
  try {
    return { login: parseAntigravityKeyringValue(stdout) };
  } catch {
    return { error: "The Antigravity keychain entry has an unexpected format." };
  }
}

async function readEmbeddedClients() {
  for (const path of LANGUAGE_SERVER_PATHS) {
    let buf;
    try { buf = await readFile(path); } catch { continue; }
    const text = buf.toString("latin1");
    const ids = [...new Set(text.match(CLIENT_ID_RE) || [])];
    const secrets = [...new Set(text.match(CLIENT_SECRET_RE) || [])];
    if (ids.length && secrets.length) return { ids, secrets };
  }
  return null;
}

/**
 * Read the Antigravity desktop login on this machine and find the OAuth client that
 * issued it (by trying the app's embedded clients against Google's token endpoint).
 * macOS only. Returns a bundle for the import route, including a live refresh token —
 * callers must be local-only.
 */
export async function readLocalAntigravityEnterpriseBundle() {
  if (process.platform !== "darwin") {
    return { found: false, error: "Reading the Antigravity login is only supported on macOS. Read it on your Mac and paste it here." };
  }

  const { login, error } = await readKeychainLogin();
  if (error) return { found: false, error };

  if (login.authMethod !== "gcp" || !login.userTier) {
    return {
      found: false,
      error: "The Antigravity app is signed in with a personal account. Use the regular Antigravity provider for that, or sign in to the app with your Workspace account.",
    };
  }
  if (!login.refreshToken || !login.projectId) {
    return { found: false, error: "The Antigravity login is missing a refresh token or project. Sign in to the app again." };
  }

  const clients = await readEmbeddedClients();
  if (!clients) return { found: false, error: "Antigravity.app was not found in /Applications." };

  for (const clientId of clients.ids) {
    for (const clientSecret of clients.secrets) {
      const refreshed = await refreshGoogleToken(login.refreshToken, clientId, clientSecret, null);
      if (refreshed?.accessToken) {
        return {
          found: true,
          bundle: {
            type: ANTIGRAVITY_ENTERPRISE_BUNDLE_TYPE,
            clientId,
            clientSecret,
            refreshToken: refreshed.refreshToken || login.refreshToken,
            projectId: login.projectId,
            userTier: login.userTier,
            region: login.region || "global",
            tierDisplayName: login.tierDisplayName || "",
          },
        };
      }
    }
  }
  return { found: false, error: "Google rejected the Antigravity login with every client in the app. Sign in to the Antigravity app again, then retry." };
}
