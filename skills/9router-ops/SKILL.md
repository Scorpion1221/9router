---
name: 9router-ops
description: Check and operate a 9router gateway with the `9r` CLI — health, success rate and latency, upstream account pool (locked / rate-limited accounts), remaining quota, which client uses which model, and an ok/warn/crit check for scheduled monitoring. Use when asked whether 9router is healthy, slow or failing, about account quota or 429s, or to set up 9router monitoring.
---

# 9router ops (`9r`)

Needs `9r` configured with an ops token (`9r config show` verifies). Without it: `9r config set --endpoint https://<gateway> --token <ops token>`; the token is created in the dashboard under Settings → Ops tokens.

Start with `9r` (no arguments): it prints the live overview and suggests next commands.

| Question | Command |
|---|---|
| Is it healthy right now? | `9r check` (exit 0 ok, 1 warn, 2 crit, 3 could not check) |
| Getting slower / failing over time? | `9r health --since 24h --by hour` |
| Which model or client is failing? | `9r health --since 6h --by model` / `--by key` / `--by error` |
| Why are requests failing? | `9r errors --since 1h` |
| Are accounts locked or rate limited? | `9r accounts --provider claude` / `9r accounts --state locked` |
| How much quota is left? | `9r quota <account name>` |
| Who still uses model X? | `9r usage --by key,model --model <substring>` |
| Routing config | `9r combos`, `9r keys` |

Reading the numbers:
- `success` excludes client aborts (499) and rejected input (4xx). Those are not gateway faults.
- `ttftP50` / `ttftP90`: time to first byte of successful requests.
- An account in state `locked` is cooling down after an upstream error. `lockedFor` shows how long is left.

Output is TOON. Errors are printed on stdout too, with a `help` line naming the fix.
