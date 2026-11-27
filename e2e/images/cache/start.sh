#!/bin/sh
# Seeds the cache, then starts the server of the run. A first server listens only on a private socket, gets the keys
# of the redis examples, saves them to /data and stops; the server of the run (redis.conf) loads them. The seed:
# session:7f3a, session:9b1c and session:c0de hold a user id and live one hour; session:7f3a:cart is a hash; two cached
# pages; feature:new-checkout is off. The driver expects the same values.
set -eu

redis-server --port 0 --unixsocket /tmp/seed.sock --unixsocketperm 700 --save '' --appendonly no --dir /data &
seed=$!
tries=0
until redis-cli -s /tmp/seed.sock ping >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo "the seed server did not start" >&2
    exit 1
  fi
  sleep 0.1
done
redis-cli -s /tmp/seed.sock >/dev/null <<'EOF'
SET session:7f3a user:42 EX 3600
SET session:9b1c user:7 EX 3600
SET session:c0de user:13 EX 3600
HSET session:7f3a:cart sku-1042 2 sku-7 1
SET cache:page:home cached-home-page
SET cache:page:about cached-about-page
SET feature:new-checkout off
SAVE
EOF
redis-cli -s /tmp/seed.sock shutdown nosave >/dev/null 2>&1 || true
wait "$seed" || true
echo "cache seeded"

exec redis-server /usr/local/etc/redis/e2e.conf
