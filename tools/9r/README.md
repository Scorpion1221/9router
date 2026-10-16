# 9r — ops CLI for a remote 9router

`9r` talks to a 9router gateway's ops API (`/api/ops/*`) with a Bearer **ops token**. It's built for AI agents and scheduled checks: output is [TOON](https://toonformat.dev), nothing is interactive, unknown flags are rejected, and exit codes mean something.

## Setup

1. In the dashboard: **Settings → Ops tokens → Create**. Pick a scope:
   - `read`: status, quota, metrics
   - `operate`: read plus reversible account actions
   - `admin`: everything, including combo edits and token management

   The token is shown once.
2. Install and point it at the gateway:

```bash
npm i -g ./tools/9r            # or: node tools/9r/bin/9r.js …
9r config set --endpoint https://your-gateway.example.com --token 9rops_…
9r config show                 # verifies the connection, token masked
```

Config lives in `~/.9r/config.json` (mode 600). `NINE_ROUTER_OPS_URL` and `NINE_ROUTER_OPS_TOKEN` override it, which is handy for cron. Plain `http://` is refused for remote hosts.

## Commands

| Command | What it answers |
|---|---|
| `9r` | Live overview: version, last-hour success and TTFT, account pools, next steps |
| `9r health --since 24h --by hour` | Client-visible success and latency. `--by model\|key\|error\|status` |
| `9r accounts --provider claude --state locked` | Upstream account pool: state, lock expiry, 429s, last success |
| `9r quota <account>` | Remaining quota windows (5h / weekly / per-model) |
| `9r errors --since 1h` | Failed upstream attempts by provider and error class |
| `9r usage --by key,model --model opus-5` | Which client key calls which model |
| `9r combos` | Combos: list, `show`, `create`, `set`, `add`, `remove`, `rename`, `delete` (writes need admin) |
| `9r keys` | API key names and restrictions (read-only). Keys are never shown |
| `9r check` | ok/warn/crit verdict. **Exit 0 ok, 1 warn, 2 crit, 3 could not check** |
| `9r token list\|create\|revoke` | Manage ops tokens (admin) |

`9r <command> --help` shows flags and examples.

Health counts two kinds of outcome:
- **request**: what the client got. Client aborts (499) and rejected input (4xx) are not counted against success.
- **attempt**: one upstream call on one account. Used by `accounts` and `errors`.

Metrics are kept for 7 days (`REQUEST_METRICS_RETENTION_DAYS`).

## Scheduled check example

```bash
9r check --since 15m || notify "9router: $(9r check --since 15m | head -1)"
```

## Security notes

- Ops tokens are separate from `/v1` API keys. A leaked inference key can't manage the gateway, and an ops token can't call models.
- Only a SHA-256 of each token is stored.
- Failed attempts lock the client IP out progressively, the same way as the dashboard login.
- `/api/ops/*` ignores cookies, so CSRF doesn't apply.
- Combo writes need an `admin` token: a restricted API key that allows a combo can call every member, so editing members changes what those keys reach. Every write is logged with the token name, and `rename`/`delete` warn about keys that list the combo.
- Responses use an allowlist. OAuth tokens, refresh tokens, upstream API keys and inference keys are never returned.
