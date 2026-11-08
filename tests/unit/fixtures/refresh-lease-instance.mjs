// One 9router "instance" for the refresh-lease race tests: its own process, its own
// DB handle on the shared DATA_DIR, its own lease owner. It refreshes one Claude
// connection through the real refreshProviderCredentials and prints the result.
//
// The Claude token endpoint is a fake: a tiny HTTP server in the test process
// (TOKEN_URL) that treats every refresh token as single-use.
// argv: <connectionId> <refreshToken held by this instance>
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL(`${process.env.NINEROUTER_ROOT}/tests/unit/fixtures/alias-hooks.mjs`).href, pathToFileURL("./"));

const [connectionId, heldRefreshToken] = process.argv.slice(2);
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).includes("anthropic") || String(url).includes("claude")
  ? realFetch(process.env.TOKEN_URL, init)
  : realFetch(url, init));

const root = process.env.NINEROUTER_ROOT;
const { refreshProviderCredentials } = await import(pathToFileURL(`${root}/open-sse/services/oauthCredentialManager.js`).href);
// Messages only (never token values) go to stderr, for test failure output.
const log = {
  info: (t, m) => process.stderr.write(`info ${m}\n`),
  warn: (t, m) => process.stderr.write(`warn ${m}\n`),
  error: (t, m) => process.stderr.write(`error ${m}\n`),
  debug() {},
};
const result = await refreshProviderCredentials("claude", { connectionId, refreshToken: heldRefreshToken }, log);
process.stdout.write(`${JSON.stringify(result ? { accessToken: result.accessToken, refreshToken: result.refreshToken } : null)}\n`);
process.exit(0);
