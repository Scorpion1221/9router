#!/usr/bin/env bash
# Build 9router locally for linux/amd64 with docker buildx and stream the image
# to the production host over SSH — zero build CPU/RAM load on the gateway VPS.
#
# Usage:
#   deploy/bwg/build-and-push.sh                 # build linux/amd64 & load on bwg-9router
#   deploy/bwg/build-and-push.sh --deploy        # build, push, and run rollout.sh on host
#   deploy/bwg/build-and-push.sh --no-build      # push already-built local image
#   DEPLOY_HOST=my-vps deploy/bwg/build-and-push.sh
set -Eeuo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
cd "$REPO"

HOST=${DEPLOY_HOST:-bwg-9router}
REMOTE_REPO=${REMOTE_REPO:-/root/9router}
IMAGE=${IMAGE:-9router:local}
PLATFORM=${PLATFORM:-linux/amd64}
DO_BUILD=1
DO_DEPLOY=0

usage() {
  cat <<'EOF'
Usage: deploy/bwg/build-and-push.sh [options]

Options:
  --host <ssh-host>      SSH host alias (default: $DEPLOY_HOST or bwg-9router)
  --image <name:tag>     Image tag to build and load (default: 9router:local)
  --platform <platform>  Target platform for buildx (default: linux/amd64)
  --no-build             Skip local buildx step and push existing local image
  --deploy               Run deploy/bwg/rollout.sh on the host after image load
  -h, --help             Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host)     HOST=$2; shift 2 ;;
    --image)    IMAGE=$2; shift 2 ;;
    --platform) PLATFORM=$2; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --deploy)   DO_DEPLOY=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker not found in PATH"

if [ "$DO_BUILD" = 1 ]; then
  PKG_VER=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
  GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "dirty")
  APP_VERSION="${PKG_VER}-${GIT_SHA}"

  log "1/3 building $IMAGE ($PLATFORM, APP_VERSION=$APP_VERSION) locally via docker buildx..."
  docker buildx build \
    --platform "$PLATFORM" \
    --build-arg "APP_VERSION=$APP_VERSION" \
    -t "$IMAGE" \
    --load \
    .
else
  log "1/3 skipping build (--no-build), using existing local $IMAGE"
fi

LOCAL_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null) || die "local image $IMAGE not found"
LOCAL_ARCH=$(docker image inspect -f '{{.Architecture}}' "$IMAGE")
EXPECTED_ARCH=${PLATFORM#*/}
EXPECTED_ARCH=${EXPECTED_ARCH%%/*}
[ "$LOCAL_ARCH" = "$EXPECTED_ARCH" ] || die "image $IMAGE arch is '$LOCAL_ARCH', expected '$EXPECTED_ARCH' ($PLATFORM)"
LOCAL_SIZE=$(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1048576}')
log "    local image: ${LOCAL_ID:7:12} (arch=$LOCAL_ARCH, uncompressed=$LOCAL_SIZE)"

REMOTE_ID=$(ssh "$HOST" "docker image inspect -f '{{.Id}}' '$IMAGE' 2>/dev/null || true")
if [ "$REMOTE_ID" = "$LOCAL_ID" ]; then
  log "2/3 remote $HOST already has $IMAGE (${LOCAL_ID:7:12}); skipping transfer"
else
  if command -v zstd >/dev/null 2>&1 && ssh "$HOST" 'command -v zstd >/dev/null 2>&1'; then
    COMP_LOCAL=(zstd -T0 -3 -c)
    COMP_REMOTE="zstd -d"
    COMP_NAME="zstd"
  else
    COMP_LOCAL=(gzip -3 -c)
    COMP_REMOTE="gzip -d"
    COMP_NAME="gzip"
  fi

  log "2/3 streaming $IMAGE to $HOST ($COMP_NAME over ssh)..."
  docker save "$IMAGE" | "${COMP_LOCAL[@]}" | ssh -o ServerAliveInterval=30 "$HOST" "$COMP_REMOTE | docker load"

  REMOTE_ID=$(ssh "$HOST" "docker image inspect -f '{{.Id}}' '$IMAGE' 2>/dev/null || true")
  [ "$REMOTE_ID" = "$LOCAL_ID" ] || die "remote image ID mismatch after load (got '${REMOTE_ID:-<none>}', expected '$LOCAL_ID')"
  log "    loaded on $HOST: ${REMOTE_ID:7:12}"
fi

if [ "$DO_DEPLOY" = 1 ]; then
  log "3/3 starting rollout on $HOST..."
  ssh -o ServerAliveInterval=30 "$HOST" "cd '$REMOTE_REPO' && setsid nohup deploy/bwg/rollout.sh > /dev/null 2>&1 &"
  sleep 2
  log "    tailing rollout log (Ctrl+C stops tailing; rollout continues on host):"
  ssh -o ServerAliveInterval=30 "$HOST" '
    LOG=$(ls -t /var/log/9router-rollout/rollout-*.log 2>/dev/null | head -1)
    [ -n "$LOG" ] || { echo "no rollout log found" >&2; exit 1; }
    echo "log: $LOG"
    while true; do
      tail -n +1 "$LOG" | tail -n 30
      if grep -qE "(done:|ABORT:)" "$LOG"; then
        break
      fi
      sleep 5
    done
    grep -q "done:" "$LOG"
  '
else
  log "3/3 image ready on $HOST. Deploy with:"
  printf '    ssh %s "cd %s && setsid nohup deploy/bwg/rollout.sh > /dev/null 2>&1 &"\n' "$HOST" "$REMOTE_REPO"
fi
