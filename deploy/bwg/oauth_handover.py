"""Move OAuth refresh-token ownership between two 9router databases.

Claude/Codex refresh tokens are single-use: whichever instance refreshes first
invalidates the other's copy, so exactly one instance may hold them at a time.
An instance without refresh tokens keeps serving on its current access tokens
(valid for hours); it just skips refreshing.

  export-strip DB OUT       remove refreshToken from every OAuth connection,
                            saving it (with the access token it pairs with)
                            to OUT (mode 600, must not exist yet).
  import DB IN [--if-newer] write those credentials into DB. --if-newer skips
                            rows whose own lastRefreshAt is already newer.
  status DB                 count OAuth connections holding a refresh token.
  due DB                    minutes until the next refresh would fire (active rows);
                            rows whose access token already expired are listed
                            under "stuck" instead of blocking.

stdout only ever carries counts; tokens go to OUT.
"""
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime

FIELDS = ("refreshToken", "accessToken", "expiresAt", "expiresIn", "lastRefreshAt", "idToken")

# Mirrors open-sse/providers/registry/{claude,codex,iflow}.js oauth.refreshLeadMs and
# codex oauth.maxRefreshAgeMs; background refresh uses max(lead, 30 min).
# Fallbacks only: due() reads the live value from the checkout's registry first, so an
# upstream change (codex went 5 days -> 10 min in v0.5.95) can't stall the gate.
LEAD_MS = {"claude": 14400000, "codex": 600000, "iflow": 86400000}
# The checkout whose registry holds the live refresh leads (this file is deploy/bwg/).
REPO = os.environ.get("NINEROUTER_REPO",
                      os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def lead_ms(provider, _cache={}):
    if provider not in _cache:
        v = LEAD_MS.get(provider, 0)
        try:
            src = open(os.path.join(REPO, "open-sse/providers/registry/%s.js" % provider)).read()
            # Literal or simple product, e.g. "600000" or "5 * 60 * 1000".
            m = re.search(r"refreshLeadMs:\s*([\d\s*]+?)\s*,", src)
            if m:
                v = 1
                for f in m.group(1).split("*"):
                    v *= int(f)
        except OSError:
            pass
        _cache[provider] = v
    return _cache[provider]
BG_FLOOR_MS = 30 * 60 * 1000
CODEX_MAX_AGE_MS = 691200000


def connect(path):
    db = sqlite3.connect(path, timeout=30, isolation_level=None)
    db.execute("pragma busy_timeout=30000")
    return db


def oauth_rows(db):
    return db.execute("select id, provider, name, data from providerConnections where authType='oauth'").fetchall()


def dump(d):
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))


def ms(v):
    # Mirrors open-sse oauthCredentialManager parseTimeMs: ISO strings or epoch s/ms.
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return v * 1000 if v < 1e12 else v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def export_strip(db_path, out_path):
    db = connect(db_path)
    out = {}
    db.execute("begin immediate")
    try:
        for cid, _, _, data in oauth_rows(db):
            d = json.loads(data)
            if not d.get("refreshToken"):
                continue
            out[cid] = {k: d[k] for k in FIELDS if d.get(k) is not None}
            del d["refreshToken"]
            db.execute("update providerConnections set data=? where id=?", (dump(d), cid))
        # Persist the tokens before committing the strip so a crash can't lose them.
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(out, f)
            f.flush()
            os.fsync(f.fileno())
        db.execute("commit")
    except BaseException:
        db.execute("rollback")
        raise
    print(json.dumps({"stripped": len(out)}))


def import_(db_path, in_path, if_newer):
    with open(in_path) as f:
        creds = json.load(f)
    db = connect(db_path)
    updated, skipped, missing = 0, 0, []
    db.execute("begin immediate")
    try:
        for cid, c in creds.items():
            row = db.execute("select data from providerConnections where id=?", (cid,)).fetchone()
            if not row:
                missing.append(cid)
                continue
            d = json.loads(row[0])
            if if_newer and d.get("refreshToken") and (d.get("lastRefreshAt") or "") >= (c.get("lastRefreshAt") or ""):
                skipped += 1
                continue
            d.update(c)
            db.execute("update providerConnections set data=? where id=?", (dump(d), cid))
            updated += 1
        db.execute("commit")
    except BaseException:
        db.execute("rollback")
        raise
    print(json.dumps({"updated": updated, "skipped": skipped, "missing": missing}))


def status(db_path):
    db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    n = sum(1 for _, _, _, data in oauth_rows(db) if json.loads(data).get("refreshToken"))
    print(json.dumps({"with_refresh_token": n}))


# "stuck" = active but its access token has already expired. Either refreshes have
# failed for the whole lead window (4 h claude, 30 min codex; usually a dead refresh
# token needing re-login) or no refresher ran. It doesn't block: waiting won't change
# it. An overdue row whose access token is still valid is likely being retried right
# now (429, 502), and when upstream recovers both containers would race the same
# single-use refresh token, so it keeps blocking. swap.sh additionally starts the
# temporary container with its background refresher off.
def due(db_path):
    db = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    now = time.time() * 1000
    best = None
    stuck = []
    rows = db.execute("select provider, name, data from providerConnections "
                      "where authType='oauth' and isActive=1").fetchall()
    for provider, name, data in rows:
        d = json.loads(data)
        if not d.get("refreshToken"):
            continue
        which = "%s/%s" % (provider, name)
        exp = ms(d.get("expiresAt") or d.get("tokenExpiresAt"))
        if exp is not None and exp < now:
            stuck.append({"which": which, "expired_minutes_ago": round((now - exp) / 60000, 1)})
            continue
        times = []
        if exp is not None:
            times.append(exp - max(lead_ms(provider), BG_FLOOR_MS))
        if provider == "codex":
            # Only the request path acts on max age; a missing stamp means "refresh on next use".
            last = ms(d.get("lastRefreshAt") or d.get("lastRefresh")
                      or (d.get("providerSpecificData") or {}).get("lastRefreshAt"))
            if last is not None:
                times.append(last + CODEX_MAX_AGE_MS)
        for t in times:
            if best is None or t < best[0]:
                best = (t, which)
    out = {"min_due_minutes": None, "which": None, "stuck": stuck}
    if best is not None:
        out.update(min_due_minutes=round((best[0] - now) / 60000, 1), which=best[1])
    print(json.dumps(out))


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "export-strip":
        export_strip(*args)
    elif cmd == "import":
        import_(args[0], args[1], "--if-newer" in args[2:])
    elif cmd == "status":
        status(args[0])
    elif cmd == "due":
        due(args[0])
    else:
        sys.exit("unknown command: %s" % cmd)
