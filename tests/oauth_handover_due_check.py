#!/usr/bin/env python3
"""Exercise deploy/bwg/oauth_handover.py `due` against a throwaway DB (no prod data)."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "deploy", "bwg", "oauth_handover.py")
sys.path.insert(0, os.path.join(HERE, "..", "deploy", "bwg"))
import oauth_handover  # noqa: E402

iso = lambda dt: dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
now = datetime.now(timezone.utc)


def run(rows):
    with tempfile.TemporaryDirectory() as d:
        db = os.path.join(d, "t.sqlite")
        c = sqlite3.connect(db)
        c.execute("create table providerConnections (id text, provider text, authType text, name text, isActive int, data text)")
        for i, (name, data) in enumerate(rows):
            c.execute("insert into providerConnections values (?,?,?,?,?,?)", (str(i), "claude", "oauth", name, 1, json.dumps(data)))
        c.commit(); c.close()
        out = subprocess.run([sys.executable, SCRIPT, "due", db], capture_output=True, text=True, check=True,
                             env={**os.environ, "NINEROUTER_REPO": "/nonexistent"}).stdout
        return json.loads(out)


fp = oauth_handover.fingerprint
overdue = iso(now + timedelta(hours=3))  # inside the 4h claude lead → refresh already due
later = iso(now + timedelta(hours=7))

# 1. live overdue row blocks (negative minutes), no stuck
r = run([("a", {"refreshToken": "rt-a", "expiresAt": overdue})])
assert r["which"] == "claude/a" and r["min_due_minutes"] < 0 and r["stuck"] == [], r

# 2. same row with its current token stamped dead: no longer blocks, listed as stuck
r = run([("a", {"refreshToken": "rt-a", "expiresAt": overdue, "refreshTokenDeadFor": fp("rt-a"), "refreshTokenDeadCode": "invalid_grant"}),
         ("b", {"refreshToken": "rt-b", "expiresAt": later})])
assert r["which"] == "claude/b" and r["min_due_minutes"] > 100, r
assert r["stuck"][0]["which"] == "claude/a" and "invalid_grant" in r["stuck"][0]["reason"], r

# 3. re-login (new refresh token) makes the stale stamp irrelevant: blocks again
r = run([("a", {"refreshToken": "rt-a2", "expiresAt": overdue, "refreshTokenDeadFor": fp("rt-a")})])
assert r["which"] == "claude/a" and r["min_due_minutes"] < 0 and r["stuck"] == [], r

# 4. fingerprint matches the JS helper (sha256 hex, first 16)
import hashlib
assert fp("abc") == hashlib.sha256(b"abc").hexdigest()[:16]
print("oauth_handover due: all checks passed")
