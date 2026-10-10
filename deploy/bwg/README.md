# Rolling deploy (single Docker host + nginx) — runbook

`rollout.sh` deploys 9router without cutting requests:
1. It starts the new image in the idle slot.
2. It switches nginx to that slot once it is healthy.
3. The old container finishes its in-flight requests (LLM streams can run for minutes) and exits on its own.

Design notes are in the header of `rollout.sh`.

How the old container drains, on the app side:
- `src/lib/shutdown.js`: SIGTERM drains instead of exiting.
- Dashboard SSE ends itself.
- The OAuth background refresher and auto-ping stop.

An image built before that change exits at once on SIGTERM. `rollout.sh` detects this
(container label `9router.graceful`) and waits for such a container to go idle before
stopping it.

| File | Purpose |
|---|---|
| `rollout.sh` | `deploy` (default), `status`, `rollback`, `migrate` (one-time) |
| `oauth_handover.py` | `due`: minutes until the next single-use OAuth refresh. Gates every overlap of two instances. Also used by the original host move. |
| `rollout.env.example` | Host settings. Copy to `rollout.env` (git-ignored). `SITES` is required. |

## Layout on the host

- Containers:
  - Two slots, `9router-blue` (172.31.9.20) and `9router-green` (172.31.9.21), on the docker network `9router-slots`.
  - No published ports.
  - Both use the same image, data volume (`9router_9router-data`) and env, rendered from the compose service.
- nginx:
  - `/etc/nginx/conf.d/9router-upstream.conf` defines `upstream nine_router`, with the live slot as primary and the other slot as `backup`.
  - The vhosts in `SITES` do `proxy_pass http://nine_router;`.
  - Switching rewrites the upstream file and reloads nginx.
- Why container IPs and not published ports:
  - With Docker's default userland proxy, a published port keeps accepting after the app inside stops listening, then resets the connection. nginx can't retry a reset POST.
  - Connecting to the container IP gives a plain "connection refused" instead, which nginx retries on `backup` for every method.
- Compose builds the image only. The service is inert (see migration step 8).

## Every deploy

```bash
cd /root/9router && git pull --ff-only origin develop
docker tag 9router:local 9router:rollback-$(date -u +%Y%m%d-%H%M)
docker compose build 9router > /tmp/9r-build.log 2>&1   # ~4 min, peak ~2.4 GB RAM
setsid nohup deploy/bwg/rollout.sh > /dev/null 2>&1 &
tail -f "$(ls -t /var/log/9router-rollout/rollout-*.log | head -1)"   # LOG_DIR from rollout.env
```

What the script does:
1. Waits until no OAuth refresh is due for 10 min.
2. Starts the idle slot and health-gates it: `/api/health` plus a keyed `/v1/models`.
3. Switches nginx.
4. Waits 5 s, then `docker stop -t 1500` on the old slot. The old slot exits as soon as its last stream ends.

Rules:
- Build before the overlap. Never build while two slots are running.
- Never run `docker compose up/down 9router` or `docker restart 9router-*`.
  - To restart: run `rollout.sh` with a re-tagged copy of the same image. It refuses to deploy the image that is already live.
- Find the process with `pgrep -f '^bash .*deploy/bwg/rollout.sh'`.
  - `pkill -f rollout.sh` also kills your own ssh session.
- `rollout.sh status` shows the live slot, both containers and their in-flight counts.
- Logs: `docker logs 9router-green`.
- Sockets: `nsenter -t $(docker inspect -f '{{.State.Pid}}' 9router-green) -n ss -tni`.

### Roll back

- `rollout.sh rollback` starts the previous slot's container (kept, stopped) and switches back.
  - If that container is still draining from the last deploy, the script waits for it.
  - To cut its remaining streams instead: `docker kill 9router-<slot>`.
- With no previous slot container (right after `migrate`):
  - Deploy an older image instead: `IMAGE=9router:rollback-<ts> deploy/bwg/rollout.sh`.

## One-time migration: compose container → slots

Done on the production host on 2026-10-10. It took 1 m 37 s with 0 failed requests; the old
container drained in 61 s. Kept for reference and for setting up another host.

Pre-checks (read-only):
```bash
pgrep -a docker-proxy | grep 20128          # legacy published via docker-proxy (expected)
docker compose --profile manual config --format json 9router | grep -c '\$\$'   # must be 0
grep -c 'proxy_set_header Host' $SITES       # 1 each
ip -4 route | grep -c '^172\.31\.9\.'        # 0: slot subnet free
free -m
```

1. Build the new image:
   ```bash
   git pull --ff-only origin develop
   docker tag 9router:local 9router:rollback-$(date -u +%Y%m%d-%H%M)
   docker compose build 9router > /tmp/9r-build.log 2>&1
   ```
   Wait for it to finish and check `free -m`.
2. `cp deploy/bwg/rollout.env.example deploy/bwg/rollout.env` and set `SITES`.
3. Back up:
   ```bash
   cp -a /etc/nginx <backup dir>/nginx-pre-migrate-<ts>
   cp docker-compose.override.yml <backup dir>/
   ```
4. Add `profiles: ["manual"]` under `services: 9router:` in `docker-compose.override.yml`.
   Then check that `docker compose ps -a` still shows `9router` Up.
5. Close dashboard tabs (Usage, Console Log). Their SSE on the old container never ends and holds the drain.
6. Run the migration:
   ```bash
   setsid nohup deploy/bwg/rollout.sh migrate > /dev/null 2>&1 &
   ```
   Then tail the log. The script:
   1. Checks that env rendered from compose equals the running container's.
   2. Waits for an OAuth quiet window as long as the old container can keep refreshing (~30 min).
   3. Starts green and health-gates it.
   4. Points the vhosts at `upstream nine_router`: green primary, the old `127.0.0.1:20128` as backup.
   5. Waits until the old container is idle, then stops and removes it.
   6. Rewrites the backup to blue.
7. Verify:
   - `rollout.sh status`.
   - `grep -n '127.0.0.1:20128' $SITES` returns nothing.
   - A keyed `/v1/models` call through every domain returns 200.
8. Make the compose service inert. Do this only after step 6 has finished: earlier, a
   config change would make `compose up -d 9router` recreate the live legacy container.
   `profiles` alone does not stop an explicit `docker compose up -d 9router`.
   ```yaml
       ports: !override []
       restart: "no"
       command: ["sh", "-c", "echo '9router runs via deploy/bwg/rollout.sh' >&2; exit 1"]
   ```
   `docker compose build 9router` still works; `rollout.sh` only reads the service's
   environment.

### Undo the migration (back to compose + hard-coded proxy_pass)

Start from green live and no blue container. If blue is live, run `rollout.sh rollback`, then `docker rm 9router-blue`.

1. Wait for a quiet window: `python3 deploy/bwg/oauth_handover.py due <db>` must show `min_due_minutes` ≥ 30.
2. Optional, to go back to older code: `docker tag 9router:rollback-<ts> 9router:local`.
3. Remove the inert `ports/restart/command` and the `profiles` line from the override.
4. Run `docker compose up -d 9router`. It now listens on 127.0.0.1:20128.
5. Check `curl -fsS 127.0.0.1:20128/api/health` and a keyed `/v1/models` call.
6. Restore the vhosts from the backup taken in step 3 of the migration (`<LOG_DIR>/nginx-pre-rollout-<ts>/`):
   ```bash
   mv /etc/nginx/conf.d/9router-upstream.conf <backup dir>/
   nginx -t && systemctl reload nginx
   ```
   If `nginx -t` fails, move the upstream file back.
7. Drain green:
   ```bash
   docker update --restart no 9router-green
   docker stop -t 1500 9router-green
   docker rm 9router-green
   ```

## Known limits

- `DRAIN_TIMEOUT=1500`. The longest `/v1` request seen was 1081 s; anything still
  running at 1500 s is killed.
- Restarting `dockerd` restarts the containers and causes a short outage.
  - Cause: Docker `live-restore` is off on the production host.
  - Enabling it needs one dockerd restart.
- Rolling back to an image with a lower `SCHEMA_VERSION` runs it on the newer DB.
  - Columns are only ever added, so the old image still works.
  - Features keyed on the new columns are off while it runs. For example, per-key access control does not apply on images older than v0.5.99.
