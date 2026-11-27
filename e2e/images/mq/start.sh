#!/bin/bash
# Starts RabbitMQ and seeds it: once the node has booted, the user e2e-seed publishes three messages to the exchange
# orders, which routes them to the queue orders, through the plain management listener on 127.0.0.1. Then
# /tmp/seeded is made, which the health check waits for. The driver expects three messages in orders, for orders 41
# to 43.
set -euo pipefail

rabbitmq-server &
server=$!
trap 'kill -TERM "$server"; wait "$server"; exit 0' TERM INT

deadline=$((SECONDS + 180))
until rabbitmqctl --quiet await_startup >/dev/null 2>&1; do
  if [ "$SECONDS" -gt "$deadline" ]; then
    echo "rabbitmq did not boot within 180 s" >&2
    exit 1
  fi
  sleep 1
done

config=$(mktemp)
printf '%s\n' '[seed]' 'hostname = 127.0.0.1' 'port = 15672' 'username = e2e-seed' \
  "password = $(cat /secrets/seed_password)" > "$config"
for order in 41 42 43; do
  rabbitmqadmin --config "$config" --node seed publish exchange=orders routing_key=orders \
    payload="{\"order\": $order, \"status\": \"paid\"}" >/dev/null
done
rm -f "$config"
touch /tmp/seeded
echo "mq seeded"

wait "$server"
