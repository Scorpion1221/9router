#!/usr/bin/env bash
# Rolling deploy of 9router on a single Docker host behind nginx: start the new
# image in the idle slot,
# switch nginx to it once healthy, and let the old container finish its in-flight
# requests and exit on its own. One cutover, no request is cut.
#
# Two slots, blue and green: containers 9router-blue / 9router-green on a dedicated
# docker network with fixed IPs (SLOT_NET, 172.31.9.20 / .21), same image + volume
# + env, no published ports. nginx proxies to `upstream nine_router` in
# /etc/nginx/conf.d/9router-upstream.conf: the live slot as primary, the other as
# `backup`, both by container IP. Switching = rewrite that file + graceful reload:
# new requests go to the new slot, open ones finish on the old.
#
# Why container IPs, not published 127.0.0.1 ports: Docker's default userland proxy
# keeps accepting on a published port after the app inside stopped listening, then
# resets the connection — nginx can't retry a reset POST and returns 502. Straight
# to the container IP, a closed listener is a plain "connection refused", which
# nginx retries on `backup` for every method. That covers the one race a reload
# leaves: an old worker still receiving a slow upload when the old slot stops
# listening hands the request to the new slot instead of failing it. max_fails=0
# keeps the primary from being marked down by a transient error.
#
# The old container then gets SIGTERM with a long stop timeout. The app drains on
# SIGTERM (Next stops accepting connections and waits for in-flight requests; see
# src/lib/shutdown.js: dashboard SSE ends itself, background refresh stops) and
# exits when the last stream finishes. Only past DRAIN_TIMEOUT does docker kill it.
#
# Taken from kamal-proxy / docker-rollout and k8s practice:
#   - health gate before any traffic (kamal-proxy deploy): /api/health plus a real
#     /v1/models call with an active key; abort leaves the old slot untouched
#   - stop only after traffic moved (k8s preStop): nginx flips, a short settle so
#     requests already proxied have reached the old upstream, then SIGTERM
#   - drain bound sized to LLM streams, not the 10-30 s web default: the longest
#     /v1 request seen was 1081 s (proxy_read_timeout bounds gaps, not duration)
#   - instant rollback: the previous slot's container is stopped, not removed;
#     `rollout.sh rollback` starts it and flips back
#   - one locked command that refuses to run in a state it doesn't expect, and an
#     exit trap that leaves a consistent state if it is interrupted at any point
#   - refresh tokens are single-use: an overlap only starts in a window where no
#     refresh is due for longer than the overlap can last (oauth_handover.py due);
#     a new-code slot stops its background refresher the moment it gets SIGTERM
#
# Host-specific settings (nginx vhost files, paths) live in rollout.env next to this
# script — copy rollout.env.example; it is not committed. See README.md for the
# runbook.
#
#   rollout.sh            deploy 9router:local (build it first)
#   rollout.sh status     which slot is live, containers, in-flight counts
#   rollout.sh rollback   switch back to the previous slot's container
#   rollout.sh migrate    one-time: compose container "9router" -> slot green
#
# Run it detached so a dropped ssh session can't kill it halfway:
#   setsid nohup deploy/bwg/rollout.sh > /dev/null 2>&1 &
#   tail -f "$(ls -t "$LOG_DIR"/rollout-*.log | head -1)"
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=/dev/null
[ -f "$HERE/rollout.env" ] && . "$HERE/rollout.env"
cd "${REPO:-$(cd "$HERE/../.." && pwd)}"

# Everything below can be set in rollout.env (or the environment, e.g. to rehearse
# against a scratch nginx, network and volume). SITES has no default: it names
# this host's nginx vhost files.
[ -n "${SITES:-}" ] || { echo "SITES is not set — copy rollout.env.example to rollout.env" >&2; exit 2; }
read -r -a SITES <<<"$SITES"
UPSTREAM_CONF=${UPSTREAM_CONF:-/etc/nginx/conf.d/9router-upstream.conf}
read -r -a NGINX <<<"${NGINX_CMD:-nginx}"
VOL=${VOL:-9router_9router-data}
DB=${DB:-/var/lib/docker/volumes/$VOL/_data/db/data.sqlite}
IMAGE=${IMAGE:-9router:local}
PREFIX=${PREFIX:-9router}                 # slot containers: $PREFIX-blue / $PREFIX-green
LEGACY=${LEGACY:-9router}                 # compose container retired by `migrate`
LEGACY_PORT=${LEGACY_PORT:-20128}         # its published 127.0.0.1 port
LOG_DIR=${LOG_DIR:-/var/log/9router-rollout}   # run logs + nginx backups made by migrate
LOCK=${LOCK:-/run/lock/9router-rollout.lock}
SLOT_NET=${SLOT_NET:-9router-slots}
SLOT_SUBNET=${SLOT_SUBNET:-172.31.9.0/24}
APP_PORT=20128                            # the app's port inside every container
DRAIN_TIMEOUT=${DRAIN_TIMEOUT:-1500}      # s the old slot may take to finish streams
SETTLE=${SETTLE:-5}                       # s between nginx switch and SIGTERM to the old slot
declare -A IP=([blue]=${BLUE_IP:-172.31.9.20} [green]=${GREEN_IP:-172.31.9.21})

mkdir -p "$LOG_DIR"
LOG=$LOG_DIR/rollout-$(date -u +%Y%m%dT%H%M%SZ).log
# -p: keep writing the log if the terminal goes away; the run itself ignores HUP.
exec > >(tee -p -a "$LOG" 2>/dev/null || tee -a "$LOG") 2>&1
trap '' HUP
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ABORT: $*"; exit 1; }

other() { [ "$1" = blue ] && echo green || echo blue; }
cname() { echo "$PREFIX-$1"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

# --- interruption safety -----------------------------------------------------
# STAGE says what an interrupted run must clean up. Before the nginx switch the
# new container goes; after it, the old one still gets its SIGTERM (detached, so
# the drain runs to completion without this shell).
STAGE=none NEW_C="" OLD_C=""
on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  case $STAGE in
    starting)
      log "interrupted before cutover: removing $NEW_C; $OLD_C stays live"
      docker rm -f "$NEW_C" >/dev/null 2>&1 || true ;;
    switched)
      log "interrupted after cutover: draining $OLD_C in the background"
      docker update --restart no "$OLD_C" >/dev/null 2>&1 || true
      setsid nohup docker stop -t "$DRAIN_TIMEOUT" "$OLD_C" >/dev/null 2>&1 & ;;
  esac
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

take_lock() {
  exec 9>"$LOCK"
  flock -n 9 || die "another rollout/swap run holds $LOCK"
}

# --- nginx -------------------------------------------------------------------
live_slot() {  # slot nginx sends traffic to: the non-backup server in the upstream file
  local ip
  ip=$(grep -E '^[[:space:]]*server ' "$UPSTREAM_CONF" 2>/dev/null | grep -v backup \
        | grep -oE '[0-9]+(\.[0-9]+){3}' | head -1) || true
  if [ "$ip" = "${IP[blue]}" ]; then echo blue
  elif [ "$ip" = "${IP[green]}" ]; then echo green
  else echo ""; fi
}

write_upstream() {  # PRIMARY_ADDR BACKUP_ADDR LABEL — atomic replace, validate, reload; restore on failure
  local tmp prev="" had=0
  if [ -f "$UPSTREAM_CONF" ]; then prev=$(cat "$UPSTREAM_CONF") || return 1; had=1; fi
  # Written beside, not inside, the include dir so nginx never reads a partial file.
  tmp=$(mktemp "$(dirname "$(dirname "$UPSTREAM_CONF")")/.9router-upstream.XXXX") || return 1
  cat > "$tmp" <<EOF || { rm -f "$tmp"; return 1; }
# Managed by $HERE/rollout.sh — live: $3
upstream nine_router {
    server $1 max_fails=0;
    server $2 backup;
}
EOF
  chmod 644 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$UPSTREAM_CONF" || { rm -f "$tmp"; return 1; }
  if "${NGINX[@]}" -t && "${NGINX[@]}" -s reload; then return 0; fi
  log "nginx -t / reload failed; restoring the previous upstream file"
  if [ "$had" = 1 ]; then printf '%s\n' "$prev" > "$UPSTREAM_CONF"; else rm -f "$UPSTREAM_CONF"; fi
  "${NGINX[@]}" -t && "${NGINX[@]}" -s reload || true
  return 1
}

switch_to() {  # SLOT
  write_upstream "${IP[$1]}:$APP_PORT" "${IP[$(other "$1")]}:$APP_PORT" "$1" || return 1
  [ "$(live_slot)" = "$1" ] || { log "upstream file does not show $1 live after the switch"; return 1; }
}

# --- containers --------------------------------------------------------------
env_file() {  # compose-rendered env of the 9router service (same source as swap.sh)
  # compose config escapes a literal $ as $$; docker run --env-file takes values
  # verbatim, so undo it or a secret containing $ would differ from compose's.
  # shellcheck disable=SC2086
  docker compose ${COMPOSE_ARGS:-} --profile manual config --format json 9router | python3 -c '
import json, sys
env = json.load(sys.stdin)["services"]["9router"].get("environment") or {}
for k, v in sorted(env.items()):
    if v is not None:
        print(f"{k}={str(v).replace(chr(36) * 2, chr(36))}")'
}

ensure_net() {
  docker network inspect "$SLOT_NET" >/dev/null 2>&1 && return 0
  log "  creating docker network $SLOT_NET ($SLOT_SUBNET)"
  docker network create --subnet "$SLOT_SUBNET" "$SLOT_NET" >/dev/null
}

graceful_image() {  # IMAGE — 1 if the image drains on SIGTERM (has src/lib/shutdown.js)
  docker run --rm --entrypoint sh "$1" -c 'grep -rqlF __9rShutdown /app/.next/server' >/dev/null 2>&1 && echo 1 || echo 0
}

run_slot() {  # SLOT
  local slot=$1 envf rc=0
  envf=$(mktemp); chmod 600 "$envf"
  env_file > "$envf" || { rm -f "$envf"; return 1; }
  # shellcheck disable=SC2086
  docker run -d --name "$(cname "$slot")" --env-file "$envf" ${SLOT_RUN_ARGS:-} \
    --network "$SLOT_NET" --ip "${IP[$slot]}" \
    -v "$VOL":/app/data \
    --memory 3g --restart unless-stopped --stop-timeout 30 \
    --log-opt max-size=50m --log-opt max-file=5 \
    --label 9router.slot="$slot" --label 9router.image="$IMAGE" \
    --label 9router.graceful="$(graceful_image "$IMAGE")" \
    --health-cmd "node -e \"require('http').get('http://127.0.0.1:$APP_PORT/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"" \
    --health-interval 30s --health-timeout 5s --health-retries 5 --health-start-period 30s \
    "$IMAGE" >/dev/null || rc=$?
  rm -f "$envf"
  return $rc
}

healthy() {  # BASE_URL — boot + a real authenticated /v1 call
  local i k
  for i in $(seq 1 90); do
    curl -fsS -m 3 -o /dev/null "$1/api/health" 2>/dev/null && break
    [ "$i" = 90 ] && { log "  $1/api/health never answered"; return 1; }
    sleep 2
  done
  k=$(sqlite3 -readonly "$DB" "select key from apiKeys where isActive=1 and coalesce(accessRestricted,0)=0 order by createdAt limit 1")
  [ -n "$k" ] || { log "  no active unrestricted API key to test /v1/models with"; return 1; }
  # Key via stdin, not argv: other local users can read process arguments.
  [ "$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -H @- "$1/v1/models" <<<"Authorization: Bearer $k")" = 200 ] \
    || { log "  $1/v1/models did not return 200"; return 1; }
}

in_flight() {  # CONTAINER — established connections to the app port (inside the container's netns)
  local pid
  pid=$(docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null) || { echo 0; return 0; }
  [ "${pid:-0}" != 0 ] || { echo 0; return 0; }
  { nsenter -t "$pid" -n ss -Htni state established "( sport = :$APP_PORT )" 2>/dev/null || true; } \
    | awk '/lastsnd:|lastrcv:/ { s = r = 1e15
             for (i = 1; i <= NF; i++) {
               if ($i ~ /^lastsnd:/) s = substr($i, 9) + 0
               if ($i ~ /^lastrcv:/) r = substr($i, 9) + 0 }
             if (s < 900000 || r < 900000) n++ }
           END { print n + 0 }'
}

wait_refresh_quiet() {  # MINUTES — no single-use refresh token due while two instances overlap
  local need=$1 i m due
  for i in $(seq 1 120); do
    due=$(python3 "$HERE/oauth_handover.py" due "$DB")
    m=$(python3 -c 'import json,sys; v=json.load(sys.stdin)["min_due_minutes"]; print(9999 if v is None else int(v))' <<<"$due")
    if [ "$m" -ge "$need" ]; then
      python3 -c 'import json,sys
for x in json.load(sys.stdin).get("stuck") or []: print("  stuck: %(which)s access token expired %(expired_minutes_ago)s min ago (re-login?)" % x)' <<<"$due" \
        | while read -r l; do log "$l"; done || true
      return 0
    fi
    if [ $((i % 4)) = 1 ]; then log "  next OAuth refresh due in ${m} min; waiting for a ${need}-min quiet window"; fi
    sleep 30
  done
  return 1
}

wait_idle() {  # CONTAINER MAX_S — poll until nothing in flight
  local c=$1 max=$2 t0 quiet=0 n last=-60
  t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt "$max" ]; do
    n=$(in_flight "$c")
    if [ "$n" = 0 ]; then quiet=$((quiet + 1)); [ $quiet -ge 3 ] && return 0; else quiet=0; fi
    if [ $(( $(date +%s) - t0 - last )) -ge 60 ]; then last=$(( $(date +%s) - t0 )); log "  $c: $n in flight, ${last}s"; fi
    sleep 10
  done
  return 1
}

drain_and_stop() {  # CONTAINER — the app exits when its streams finish
  local c=$1 t0 n stop_pid
  docker update --restart no "$c" >/dev/null 2>&1 || true
  if [ "$(docker inspect -f '{{index .Config.Labels "9router.graceful"}}' "$c" 2>/dev/null)" != 1 ]; then
    # An image without the drain logic exits at once on SIGTERM: wait for it to go idle first.
    log "  $c runs an image that exits on SIGTERM; waiting for it to go idle first"
    wait_idle "$c" "$DRAIN_TIMEOUT" || log "  $c still busy after ${DRAIN_TIMEOUT}s; stopping anyway"
  fi
  t0=$(date +%s)
  log "  SIGTERM $c (in flight: $(in_flight "$c"); exits on its own when done, killed after ${DRAIN_TIMEOUT}s)"
  docker stop -t "$DRAIN_TIMEOUT" "$c" >/dev/null &
  stop_pid=$!
  while kill -0 "$stop_pid" 2>/dev/null; do
    sleep 30
    if kill -0 "$stop_pid" 2>/dev/null; then
      n=$(in_flight "$c"); log "  $c draining: $n in flight, $(( $(date +%s) - t0 ))s"
    fi
  done
  wait "$stop_pid" || true
  log "  $c exited after $(( $(date +%s) - t0 ))s (exit code $(docker inspect -f '{{.State.ExitCode}}' "$c" 2>/dev/null))"
}

preflight_common() {
  take_lock
  docker inspect 9router-swap >/dev/null 2>&1 && die "9router-swap exists (an unfinished swap.sh run) — finish or remove it first"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE not found"
}

# --- commands ----------------------------------------------------------------
cmd_status() {
  local live s c; live=$(live_slot)
  echo "live slot: ${live:-<none: upstream file missing>}  ($UPSTREAM_CONF)"
  for s in blue green; do
    c=$(cname "$s")
    if docker inspect "$c" >/dev/null 2>&1; then
      printf '  %-16s %-8s %-15s graceful=%s %-40s in_flight=%s %s\n' "$c" \
        "$(docker inspect -f '{{.State.Status}}' "$c")" "${IP[$s]}" \
        "$(docker inspect -f '{{index .Config.Labels "9router.graceful"}}' "$c")" \
        "$(docker inspect -f '{{index .Config.Labels "9router.image"}} {{.Image}}' "$c" | cut -c1-40)" \
        "$(in_flight "$c")" "$([ "$s" = "$live" ] && echo '<- live' || true)"
    else
      printf '  %-16s absent\n' "$c"
    fi
  done
  docker inspect "$LEGACY" >/dev/null 2>&1 && echo "  WARNING: compose container $LEGACY exists — slots are not the only instance"
  true
}

cmd_deploy() {
  local live idle old new
  preflight_common
  live=$(live_slot); [ -n "$live" ] || die "no live slot in $UPSTREAM_CONF — run 'rollout.sh migrate' first"
  idle=$(other "$live"); old=$(cname "$live"); new=$(cname "$idle")
  docker inspect "$LEGACY" >/dev/null 2>&1 && die "compose container $LEGACY exists — remove it (see runbook) before deploying"
  running "$old" || die "live slot container $old is not running"
  running "$new" && die "$new is running but not live — previous slot still draining? check 'rollout.sh status'"
  [ "$(docker image inspect -f '{{.Id}}' "$IMAGE")" = "$(docker inspect -f '{{.Image}}' "$old")" ] \
    && die "$IMAGE is the image $old already runs — build first (or set IMAGE=)"
  [ "$(graceful_image "$IMAGE")" = 1 ] || log "  WARNING: $IMAGE has no drain-on-SIGTERM; its next replacement will wait for it to go idle"
  log "deploy $IMAGE ($(docker image inspect -f '{{.Id}}' "$IMAGE" | cut -c8-19)): $live -> $idle"

  # The overlap lasts until the new slot is healthy (old one stops refreshing at
  # SIGTERM right after), so a few minutes of quiet is enough.
  log "1/4 wait for a refresh-quiet window"
  wait_refresh_quiet 10 || die "no 10-min OAuth quiet window within an hour"

  log "2/4 start $new (${IP[$idle]})"
  ensure_net
  docker rm "$new" >/dev/null 2>&1 || true   # stopped previous release kept for rollback; superseded now
  STAGE=starting NEW_C=$new OLD_C=$old
  run_slot "$idle" || die "docker run $new failed"
  if ! healthy "http://${IP[$idle]}:$APP_PORT"; then
    log "$new not healthy — last log lines:"; docker logs --tail 30 "$new" 2>&1 | sed 's/^/    /'
    die "aborted before cutover; $old still live"
  fi

  log "3/4 switch nginx -> $idle"
  switch_to "$idle" || die "nginx switch failed; $old still live"
  STAGE=switched
  sleep "$SETTLE"

  log "4/4 drain $old"
  drain_and_stop "$old"
  STAGE=none
  log "done: $idle live, $old stopped (kept for 'rollout.sh rollback')"
}

cmd_rollback() {
  local live prev old new
  preflight_common
  live=$(live_slot); [ -n "$live" ] || die "no live slot"
  prev=$(other "$live"); old=$(cname "$live"); new=$(cname "$prev")
  docker inspect "$new" >/dev/null 2>&1 || die "no previous container $new to roll back to (after 'migrate' the first rollback is IMAGE=9router:rollback-<ts> rollout.sh)"
  if running "$new"; then
    log "  $new is still draining from the last deploy; waiting for it to exit (max ${DRAIN_TIMEOUT}s)"
    timeout "$DRAIN_TIMEOUT" docker wait "$new" >/dev/null || die "$new did not exit; 'docker kill $new' to cut its remaining streams, then retry"
  fi
  log "rollback: $live -> $prev ($(docker inspect -f '{{index .Config.Labels "9router.image"}} {{.Image}}' "$new" | cut -c1-40))"
  wait_refresh_quiet 10 || die "no OAuth quiet window"
  STAGE=starting NEW_C=$new OLD_C=$old
  docker start "$new" >/dev/null
  docker update --restart unless-stopped "$new" >/dev/null
  healthy "http://${IP[$prev]}:$APP_PORT" || { STAGE=none; docker stop -t 30 "$new" >/dev/null; die "$new not healthy after start; $old still live"; }
  switch_to "$prev" || { STAGE=none; docker stop -t 30 "$new" >/dev/null; die "nginx switch failed; $old still live"; }
  STAGE=switched
  sleep "$SETTLE"
  drain_and_stop "$old"
  STAGE=none
  log "done: $prev live"
}

cmd_migrate() {
  # One-time: from the compose container "$LEGACY" on 127.0.0.1:$LEGACY_PORT, proxied
  # by a hard-coded proxy_pass, to slot containers behind the upstream file.
  # Traffic keeps flowing throughout:
  #   1. green starts (new image) on the slot network, health-gated
  #   2. nginx: upstream file (green primary, the legacy port as backup) and the
  #      vhosts pointed at it, in one validated reload
  #   3. the legacy container (old image: exits on SIGTERM, and its dashboard SSE
  #      never ends) gets no new traffic; wait until it is idle, then stop + rm it
  # Compose must already keep the service from starting (profile "manual"); after
  # this, make the compose service inert (see runbook) so nothing restarts it.
  local f bak
  preflight_common
  [ -f "$UPSTREAM_CONF" ] && die "$UPSTREAM_CONF exists — already migrated (use deploy)"
  docker inspect "$LEGACY" >/dev/null 2>&1 || die "compose container $LEGACY not found"
  grep -q 'profiles: \["manual"\]' "${COMPOSE_OVERRIDE:-docker-compose.override.yml}" \
    || die "add 'profiles: [\"manual\"]' to the 9router service in docker-compose.override.yml first"
  [ "$(docker image inspect -f '{{.Id}}' "$IMAGE")" != "$(docker inspect -f '{{.Image}}' "$LEGACY")" ] \
    || die "$IMAGE is the image $LEGACY already runs — build the new version first"
  [ "$(graceful_image "$IMAGE")" = 1 ] || die "$IMAGE has no drain-on-SIGTERM (src/lib/shutdown.js) — build the new version first"
  for f in "${SITES[@]}"; do
    grep -q "proxy_pass http://127.0.0.1:$LEGACY_PORT;" "$f" || die "$f does not proxy to 127.0.0.1:$LEGACY_PORT"
  done
  docker inspect "$(cname green)" >/dev/null 2>&1 && die "$(cname green) already exists"
  diff <(docker inspect "$LEGACY" -f '{{range .Config.Env}}{{println .}}{{end}}' \
           | grep -vE '^(PATH|NODE_VERSION|YARN_VERSION|NEXT_TELEMETRY_DISABLED)=' | grep . | sort) \
       <(env_file | sort) >/dev/null \
    || die "env rendered from compose differs from $LEGACY's (keys/values) — inspect before migrating"

  log "migrate: compose $LEGACY -> slot green ($IMAGE)"
  # Old code keeps refreshing until it is stopped: the overlap can last the whole
  # idle wait, so the quiet window has to cover it.
  local quiet=$(( (DRAIN_TIMEOUT + 300) / 60 ))
  log "1/4 wait for a ${quiet}-min refresh-quiet window"
  wait_refresh_quiet "$quiet" || die "no ${quiet}-min OAuth quiet window within an hour"

  log "2/4 start $(cname green) (${IP[green]})"
  ensure_net
  STAGE=starting NEW_C=$(cname green) OLD_C=""
  run_slot green || die "docker run $(cname green) failed"
  if ! healthy "http://${IP[green]}:$APP_PORT"; then
    docker logs --tail 30 "$(cname green)" 2>&1 | sed 's/^/    /'
    die "green not healthy; nothing changed"
  fi

  log "3/4 nginx -> upstream nine_router (green)"
  bak=$LOG_DIR/nginx-pre-rollout-$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p "$bak"; cp "${SITES[@]}" "$bak/"
  for f in "${SITES[@]}"; do
    sed -i -E "s#proxy_pass http://127\\.0\\.0\\.1:$LEGACY_PORT;#proxy_pass http://nine_router;#" "$f"
  done
  if ! write_upstream "${IP[green]}:$APP_PORT" "127.0.0.1:$LEGACY_PORT" green; then
    for f in "${SITES[@]}"; do cp "$bak/$(basename "$f")" "$f"; done
    "${NGINX[@]}" -t && "${NGINX[@]}" -s reload || true
    die "nginx switch failed; restored vhosts from $bak"
  fi
  STAGE=none   # from here an interruption leaves legacy as a harmless backup
  sleep "$SETTLE"

  log "4/4 retire $LEGACY (old image: exits on SIGTERM, so wait for it to go idle first)"
  log "  close dashboard tabs (Usage, Console Log): their SSE on $LEGACY never ends and keeps it 'busy'"
  docker update --restart no "$LEGACY" >/dev/null
  wait_idle "$LEGACY" "$DRAIN_TIMEOUT" || log "  $LEGACY still busy after ${DRAIN_TIMEOUT}s; stopping anyway"
  docker stop -t 30 "$LEGACY" >/dev/null
  docker rm "$LEGACY" >/dev/null
  # Legacy port is gone: make blue's address the backup, as every later deploy expects.
  switch_to green || log "  WARNING: could not rewrite the upstream backup to blue; next deploy fixes it"
  log "done: green live; next 'rollout.sh' deploys into blue (${IP[blue]}). nginx backup: $bak"
}

case ${1:-deploy} in
  deploy)   cmd_deploy ;;
  status)   cmd_status ;;
  rollback) cmd_rollback ;;
  migrate)  cmd_migrate ;;
  *) echo "usage: $0 [deploy|status|rollback|migrate]"; exit 2 ;;
esac
