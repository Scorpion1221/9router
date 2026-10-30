"""Remind on Feishu before 9router's Claude OAuth logins hit their ~28-day limit.

A Claude refresh token stops working about 28 days after the login that issued it.
Rotating it every 4 hours does not extend that; only a fresh login does. On prod,
two logins from 2026-09-30 died at 27.8-28.3 days with invalid_grant.

The login time is reauthorizedAt, which the dashboard's Re-authorize sets in place.
A row that was never re-authorized uses createdAt instead: Claude rows carry no
email, so every plain login creates a new row.

  oauth_expiry_watch.py [--db DB] [--warn-days N] [--dry-run]

Posts one card if an active row is within --warn-days of its login time + 28 days. Rows
whose access token has already expired go on the card too: the refresher runs 4 h
ahead, so an expired token means the refresh failed. With nothing due, no message
is sent.

Delivery: with $FEISHU_APP_ID/$FEISHU_APP_SECRET/$FEISHU_CHAT_ID it is sent as that
app's bot to the chat (e.g. a DM with the bot); otherwise to $FEISHU_WEBHOOK. The DB
is opened read-only, and output carries only connection names and times.
"""
import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

DB = "/var/lib/docker/volumes/9router_9router-data/_data/db/data.sqlite"
LIFETIME = {"claude": timedelta(days=28)}
CST = timezone(timedelta(hours=8))
FEISHU_API = "https://open.feishu.cn/open-apis"


def ts(v):
    return datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None


def cst(t):
    return t.astimezone(CST).strftime("%m-%d %H:%M")


def scan(db_path, warn, now):
    db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    rows = db.execute(
        "select provider, name, coalesce(json_extract(data, '$.reauthorizedAt'), createdAt),"
        " json_extract(data, '$.expiresAt') from providerConnections"
        " where authType = 'oauth' and isActive = 1 and provider in (%s) order by createdAt"
        % ",".join("?" * len(LIFETIME)), list(LIFETIME)).fetchall()
    dead, due = [], []
    for provider, name, logged_in, expires_at in rows:
        expires_at = ts(expires_at)
        if expires_at and expires_at < now:
            dead.append((name, expires_at))
        elif ts(logged_in) + LIFETIME[provider] - now <= warn:
            due.append((name, ts(logged_in) + LIFETIME[provider]))
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
        {"tag": "markdown", "content": "处理：Dashboard → Providers → Claude，在该账号的 ⋯ 菜单里点 Re-authorize。"
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


def post_json(url, body, token=None):
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            reply = json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:  # Feishu answers API errors with a JSON body too
        reply = json.loads(exc.read() or b"{}")
    code = reply.get("code", reply.get("StatusCode", 0))
    if code != 0:
        raise RuntimeError("feishu rejected the request: code %s %s" % (code, reply.get("msg")))
    return reply


def send(card_body):
    """As the app bot to FEISHU_CHAT_ID when FEISHU_APP_ID is set, else to FEISHU_WEBHOOK."""
    if os.environ.get("FEISHU_APP_ID"):
        token = post_json(FEISHU_API + "/auth/v3/tenant_access_token/internal", {
            "app_id": os.environ["FEISHU_APP_ID"], "app_secret": os.environ["FEISHU_APP_SECRET"],
        })["tenant_access_token"]
        post_json(FEISHU_API + "/im/v1/messages?receive_id_type=chat_id", {
            "receive_id": os.environ["FEISHU_CHAT_ID"], "msg_type": "interactive",
            "content": json.dumps(card_body, ensure_ascii=False),
        }, token)
    else:
        post_json(os.environ["FEISHU_WEBHOOK"], {"msg_type": "interactive", "card": card_body})


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
    body = card(dead, due, now)
    if args.dry_run:
        print(json.dumps(body, ensure_ascii=False, indent=1))
        return 0
    try:
        send(body)
    except Exception as exc:  # never echo the webhook URL or app secret
        msg = str(exc)
        for secret in filter(None, (os.environ.get("FEISHU_WEBHOOK"), os.environ.get("FEISHU_APP_SECRET"))):
            msg = msg.replace(secret, "<redacted>")
        print("feishu send failed: %s: %s" % (type(exc).__name__, msg), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
