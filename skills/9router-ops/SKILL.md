---
name: 9router-ops
description: Check and operate a 9router gateway with the `9r` CLI — health, success rate and latency, upstream account pool (locked / rate-limited accounts), remaining quota, which client uses which model, combo (fallback chain) edits, and an ok/warn/crit check for scheduled monitoring. Use when asked whether 9router is healthy, slow or failing, about account quota or 429s, or to set up 9router monitoring.
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
| How much quota is left? | `9r quota --provider claude` (all accounts + the order they are used in) / `9r quota <account name>` |
| Keep an account mostly for yourself | `9r accounts set <name> --role reserve --keep 30 [--release-before 12h]` (operate token) |
| Who still uses model X? | `9r usage --by key,model --model <substring>` |
| Routing config | `9r combos`, `9r combos show <name>`, `9r keys` |
| Change a combo's fallback chain | `9r combos add <name> <provider/model> [--at 1]`, `remove`, `set <name> --models a,b --strategy fallback`, `create`, `rename`, `delete <name> --yes` (admin token) |

Reading the numbers:
- `success` excludes client aborts (499) and rejected input (4xx). Those are not gateway faults.
- `ttftP50` / `ttftP90`: time to first byte of successful requests.
- An account in state `locked` is cooling down after an upstream error. `lockedFor` shows how long is left. An exhausted quota window locks it until that window resets (can be days); a reset seen by the 15-min quota poll or a manual reset lifts it early.
- With the `reset-first` strategy, `9r quota --provider` orders normal accounts by earliest weekly reset (spend quota before it expires); reserve accounts (`R1`, `R2`) only take traffic when no normal one can. `below keep` means an account is under its keep line.

Output is TOON. Errors are printed on stdout too, with a `help` line naming the fix.
