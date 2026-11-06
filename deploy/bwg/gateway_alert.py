"""Push a Feishu card when 9router's clients start getting errors, and once more when it ends.

Runs every minute from gateway-alert.timer. It reads what the gateway recorded about each
answer it gave a client (requestMetrics, kind=request) from the SQLite DB, opened
read-only, and keeps its own small state file.

  gateway_alert.py [--dry-run]                 # one live run (dry-run: print, keep state, no ping)
  gateway_alert.py --at "2026-11-06 17:27"     # what a past minute (UTC) would have sent; posts it
                                               # titled 【测试】, or prints it with --dry-run
  gateway_alert.py --replay 7                  # run the rules over past days, print every card title

Alerts:
  failing  In the last 5 min clients got >= 4 failed answers across >= 2 API keys, or one key
           got >= 6 with no success in between. A failed answer is a 5xx or 429, or a 4xx
           from upstream such as a combo whose last member answered 400 (Claude clients do
           not retry a 400, so the task stops). 401/403/404 (wrong key or model name) and
           499 (the client hung up) don't count. Repeats every 30 min while it lasts; one
           card once the rule has not matched for 10 min.
  down     No slot in the nginx upstream answers /api/health, 2 runs in a row. No request
           reaches requestMetrics then, so the rule above cannot see it.

Delivery reuses oauth_expiry_watch.py's Feishu bot and chat. With HC_PING_URL set, every
run pings it (".../fail" when the run or a send failed), so healthchecks.io notices a
dead host or timer. Cards carry key names, model names and status codes only.
"""
import argparse
import copy
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone

sys.dont_write_bytecode = True  # no __pycache__ in the checkout when run by hand
from oauth_expiry_watch import CST, DB, send  # noqa: E402  same bot, chat and DB path

STATE = "/var/lib/9router-alert/state.json"
UPSTREAM_CONF = "/etc/nginx/conf.d/9router-upstream.conf"

MIN = 60_000
WINDOW = 5 * MIN
MIN_FAILURES, MIN_KEYS = 4, 2
SOLO_FAILURES = 6
REPEAT = 30 * MIN
RECOVER = 10 * MIN
DOWN_RUNS = 2
NOT_COUNTED = (401, 403, 404, 499)

HINTS = {
    400: "400：上游拒绝了请求，客户端不会重试，任务直接停。常见原因是 combo 末位成员的渠道下线、或不支持某个参数，换掉那个成员。",
    429: "429：限流或配额用完（cc 号池耗尽、网关每日 token 配额）。",
    502: "502/504：上游超时或连不上。",
    503: "503：所有成员都不可用（账号全被锁、或熔断打开）。",
}


def hhmm(ms):
    return datetime.fromtimestamp(ms / 1000, CST).strftime("%m-%d %H:%M")


def mins(ms):
    return max(1, round(ms / MIN))


class Gateway:
    def __init__(self, path):
        self.db = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=10)
        self.names = dict(self.db.execute("select id, name from providerNodes"))

    def requests(self, t0, t1):
        return [dict(ts=ts, key=key or "(无 key)", model=model, status=status, outcome=outcome)
                for ts, key, model, status, outcome in self.db.execute(
                    "select ts, keyName, model, status, outcome from requestMetrics"
                    " where kind = 'request' and ts > ? and ts <= ?", (t0, t1))]

    def failed_attempts(self, t0, t1):
        return self.db.execute(
            "select provider, model, status, count(*) from requestMetrics where kind = 'attempt'"
            " and ts > ? and ts <= ? and outcome in ('error', 'rejected') and status != 499"
            " group by 1, 2, 3 order by 4 desc limit 6", (t0, t1)).fetchall()


def failed(r):
    return r["outcome"] in ("error", "rejected") and r["status"] not in NOT_COUNTED


def matches(rows):
    fails = [r for r in rows if failed(r)]
    by_key = Counter(r["key"] for r in fails)
    ok_keys = {r["key"] for r in rows if r["outcome"] == "ok"}
    solo = any(n >= SOLO_FAILURES and k not in ok_keys for k, n in by_key.items())
    return (len(fails) >= MIN_FAILURES and len(by_key) >= MIN_KEYS) or solo


def counts(c):
    return "、".join(f"{k} ×{n}" for k, n in c.most_common())


def failing_lines(gw, now):
    rows = gw.requests(now - WINDOW, now)
    fails = [r for r in rows if failed(r)]
    by_model = defaultdict(Counter)
    for r in fails:
        by_model[r["model"]][r["status"]] += 1
    lines = [
        f"**最近 5 分钟**：失败 {len(fails)} / {len(rows)} 次（成功率 {100 * (1 - len(fails) / max(1, len(rows))):.0f}%）",
        "**受影响的 key**：" + counts(Counter(r["key"] for r in fails)),
        "**combo / 模型**：" + "；".join(
            f"{m} " + " ".join(f"{s}×{n}" for s, n in sorted(c.items()))
            for m, c in sorted(by_model.items(), key=lambda kv: -sum(kv[1].values()))),
    ]
    attempts = gw.failed_attempts(now - WINDOW, now)
    if attempts:
        lines.append("**上游哪里失败**（单次尝试）\n" + "\n".join(
            f"- {gw.names.get(p, p)} · {m} → {s} ×{n}" for p, m, s, n in attempts))
    statuses = [s for s, _ in Counter(r["status"] for r in fails).most_common()]
    hints = dict.fromkeys(HINTS[503 if s == 503 else 502 if s in (502, 504) else s]
                          for s in statuses if s in (400, 429, 502, 503, 504))
    lines += list(hints)
    lines.append("排查：`9r errors --since 15m`、`9r health --since 1h --by error`")
    return lines


def card(title, template, lines, now):
    return {
        "schema": "2.0",
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": title}, "template": template},
        "body": {"elements": [
            {"tag": "markdown", "content": "\n".join(lines)},
            {"tag": "markdown", "text_size": "notation",
             "content": f"<font color='grey'>9router · 北京时间 {hhmm(now)} · 每分钟检查</font>"},
        ]},
    }


def probe_slots(conf=UPSTREAM_CONF):
    """True if any server in the nginx upstream answers /api/health; None without the file."""
    try:
        with open(conf) as f:
            servers = re.findall(r"^\s*server\s+([\w.:-]+)", f.read(), re.M)
    except OSError:
        return None
    for server in servers:  # live slot first
        try:
            with urllib.request.urlopen(f"http://{server}/api/health", timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            continue
    return False


def step(gw, state, now, probe=None):
    """Advance the alert state by one run. Returns (new_state, cards)."""
    state = copy.deepcopy(state)
    cards = []

    hit = matches(gw.requests(now - WINDOW, now))
    inc = state.get("failing")
    if inc:  # tally the whole incident for the recovery card
        for r in gw.requests(inc["counted"], now):
            if failed(r):
                inc["fails"] += 1
                inc["keys"][r["key"]] = inc["keys"].get(r["key"], 0) + 1
        inc["counted"] = now
    if hit and not inc:
        first = [r for r in gw.requests(now - WINDOW, now) if failed(r)]
        state["failing"] = {"start": min(r["ts"] for r in first), "last_hit": now, "last_push": now,
                            "counted": now, "fails": len(first), "keys": dict(Counter(r["key"] for r in first))}
        cards.append(card("🔴 9router：客户端请求在失败", "red", failing_lines(gw, now), now))
    elif hit:
        inc["last_hit"] = now
        if now - inc["last_push"] >= REPEAT:
            inc["last_push"] = now
            cards.append(card(f"🔴 9router：仍在失败（已 {mins(now - inc['start'])} 分钟）", "red",
                              failing_lines(gw, now), now))
    elif inc and now - inc["last_hit"] >= RECOVER:
        cards.append(card("✅ 9router：已恢复", "green", [
            f"失败从 {hhmm(inc['start'])} 持续到 {hhmm(inc['last_hit'])}（约 {mins(inc['last_hit'] - inc['start'])} 分钟），"
            f"之后 {RECOVER // MIN} 分钟没再触发。",
            f"期间失败 {inc['fails']} 次：{counts(Counter(inc['keys']))}"], now))
        state["failing"] = None

    if probe is not None:
        down = state.get("down") or {"fails": 0, "since": now, "alerted": False}
        if probe:
            if down["alerted"]:
                cards.append(card("✅ 9router：网关恢复响应", "green",
                                  [f"/api/health 从 {hhmm(down['since'])} 起无响应，现在恢复了。"], now))
            down = None
        else:
            down["fails"] += 1
            if down["fails"] >= DOWN_RUNS and not down["alerted"]:
                down["alerted"] = True
                cards.append(card("🔴 9router：网关无响应", "red", [
                    f"从 {hhmm(down['since'])} 起，nginx upstream 里的 slot 都不回 /api/health，客户端拿到的是 502。",
                    "排查：`deploy/bwg/rollout.sh status`、`docker logs --tail 50 9router-<slot>`"], now))
        state["down"] = down

    return state, cards



def load_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, path)


def ping(suffix=""):
    url = os.environ.get("HC_PING_URL")
    if not url:
        return
    try:
        urllib.request.urlopen(url.rstrip("/") + suffix, timeout=10).close()
    except Exception as exc:  # a missed ping is what healthchecks.io is there to notice
        print("healthchecks ping failed: %s" % type(exc).__name__, file=sys.stderr)


def redact(text):
    for secret in filter(None, (os.environ.get(k) for k in ("FEISHU_WEBHOOK", "FEISHU_APP_SECRET", "HC_PING_URL"))):
        text = text.replace(secret, "<redacted>")
    return text


def utc_ms(text):
    return int(datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", default=DB)
    parser.add_argument("--state", default=STATE)
    parser.add_argument("--dry-run", action="store_true", help="print cards instead of posting; keep state")
    parser.add_argument("--at", help='evaluate one past minute, "YYYY-MM-DD HH:MM" UTC, from an empty state')
    parser.add_argument("--replay", type=float, metavar="DAYS", help="print the cards past traffic would have sent")
    args = parser.parse_args()
    gw = Gateway(args.db)

    if args.replay:
        now = int(time.time() * 1000)
        state, n = {}, 0
        for t in range(now - int(args.replay * 86400_000), now + 1, MIN):
            state, cards = step(gw, state, t)
            for c in cards:
                n += 1
                print(hhmm(t), c["header"]["title"]["content"])
        print("%d cards in %g days" % (n, args.replay))
        return 0

    if args.at:
        _, cards = step(gw, {}, utc_ms(args.at))
        if not cards:
            print("no alert at %s UTC" % args.at)
        for c in cards:
            c["header"]["title"]["content"] = "【测试】" + c["header"]["title"]["content"]
            if args.dry_run:
                print(json.dumps(c, ensure_ascii=False, indent=1))
            else:
                send(c)
                print("sent: " + c["header"]["title"]["content"])
        return 0

    try:
        now = int(time.time() * 1000)
        state, cards = step(gw, load_state(args.state), now, probe_slots())
        for c in cards:
            if args.dry_run:
                print(json.dumps(c, ensure_ascii=False, indent=1))
            else:
                send(c)
                print("sent: " + c["header"]["title"]["content"])
        if not args.dry_run:
            save_state(args.state, state)  # only after every card went out: a failed send retries next run
            ping()
        return 0
    except Exception as exc:
        print("gateway alert failed: %s: %s" % (type(exc).__name__, redact(str(exc))), file=sys.stderr)
        if not args.dry_run:
            ping("/fail")
        return 2


if __name__ == "__main__":
    sys.exit(main())
