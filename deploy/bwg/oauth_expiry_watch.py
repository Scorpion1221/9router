"""Remind on Feishu before 9router's Claude OAuth logins hit their ~28-day limit.

A Claude refresh token stops working about 28 days after the login that issued it.
Rotating it every 4 hours does not extend that; only a fresh login does. On prod,
two logins from 2026-09-30 died at 27.8-28.3 days with invalid_grant.

Claude rows carry no email, so every login creates a new row. That makes createdAt
the login time.

  oauth_expiry_watch.py [--db DB] [--warn-days N] [--dry-run]

Posts one card if an active row is within --warn-days of createdAt + 28 days. Rows
whose access token has already expired go on the card too: the refresher runs 4 h
ahead, so an expired token means the refresh failed. With nothing due, no message
is sent.

The webhook comes from $FEISHU_WEBHOOK. The DB is opened read-only, and output
carries only connection names and times.
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

DB = "/var/lib/docker/volumes/9router_9router-data/_data/db/data.sqlite"
LIFETIME = {"claude": timedelta(days=28)}
CST = timezone(timedelta(hours=8))


def ts(v):
    return datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None


def cst(t):
    return t.astimezone(CST).strftime("%m-%d %H:%M")


def scan(db_path, warn, now):
    db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    rows = db.execute(
        "select provider, name, createdAt, json_extract(data, '$.expiresAt') from providerConnections"
        " where authType = 'oauth' and isActive = 1 and provider in (%s) order by createdAt"
        % ",".join("?" * len(LIFETIME)), list(LIFETIME)).fetchall()
    dead, due = [], []
    for provider, name, created, expires_at in rows:
        expires_at = ts(expires_at)
        if expires_at and expires_at < now:
            dead.append((name, expires_at))
        elif ts(created) + LIFETIME[provider] - now <= warn:
            due.append((name, ts(created) + LIFETIME[provider]))
    return dead, due


def card(dead, due, now):
    elements = []
    if dead:
        elements += [{"tag": "markdown", "content": "**已失效**（刷新失败）\n" + "\n".join(
            f"- {n}：{cst(t)} 起" for n, t in dead)}, {"tag": "hr"}]
    if due:
        elements += [{"tag": "markdown", "content": "**快到期**（按登录时间 + 28 天估算）\n" + "\n".join(
            f"- {n}：约 {cst(t)}（剩 {max(0, (t - now).total_seconds()) / 86400:.1f} 天）" for n, t in due)},
            {"tag": "hr"}]
    elements += [
        {"tag": "markdown", "content": "处理：Dashboard → Providers → Claude，删掉旧连接后重新登录。"
                                       "自动刷新不会延长 28 天，只有重新登录才重新计时。"},
        {"tag": "markdown", "content": f"<font color='grey'>9router · 检查于 {cst(now)}（北京时间） · 每天一次</font>",
         "text_size": "notation"},
    ]
    return {
        "schema": "2.0",
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text",
                             "content": f"⏰ 9router：{len(dead) + len(due)} 个 Claude 账号需要重新登录"},
                   "template": "red" if dead else "orange"},
        "body": {"elements": elements},
    }


def post(url, body):
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        reply = json.loads(response.read() or b"{}")
    code = reply.get("code", reply.get("StatusCode", 0))
    if code != 0:
        raise RuntimeError("feishu rejected the card: code %s %s" % (code, reply.get("msg")))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--db", default=DB)
    parser.add_argument("--warn-days", type=float, default=3)
    parser.add_argument("--dry-run", action="store_true", help="print the card instead of posting it")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    dead, due = scan(args.db, timedelta(days=args.warn_days), now)
    print(json.dumps({"dead": [n for n, _ in dead], "due": [n for n, _ in due]}, ensure_ascii=False))
    if not (dead or due):
        return 0
    body = {"msg_type": "interactive", "card": card(dead, due, now)}
    if args.dry_run:
        print(json.dumps(body, ensure_ascii=False, indent=1))
        return 0
    url = os.environ.get("FEISHU_WEBHOOK")
    if not url:
        print("FEISHU_WEBHOOK is not set", file=sys.stderr)
        return 2
    try:
        post(url, body)
    except Exception as exc:  # never echo the webhook URL
        print("feishu post failed: %s: %s" % (type(exc).__name__, str(exc).replace(url, "<redacted>")),
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
