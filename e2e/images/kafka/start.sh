#!/bin/bash
# Starts the e2e broker and seeds it. The passwords of the run go into the PLAIN lines of each listener, in a private
# folder; the key and the certificate of the run make the PEM keystore of port 9093. The storage gets a new cluster id.
# Once the broker answers on the loopback listener, the user admin seeds it:
#   - the topic orders (3 partitions) with 6 messages, for orders 41 to 46, and payments (1 partition) with 2;
#   - the consumer groups billing on orders and search on payments, both at the earliest offsets, so both lag;
#   - the ACLs of the users of the examples: e2e-kafka-reader may describe every topic, with its configuration, and
#     every group; e2e-kafka-ops may describe every topic, with its configuration, create orders-retry, and read and
#     describe orders and the group billing. kafka-topics --describe also reads the configuration of the topic.
# Then /tmp/seeded is made, which the health check waits for. The driver expects the same values.
set -euo pipefail
umask 077

work=$(mktemp -d)
bin=/opt/kafka/bin
admin=$(cat /secrets/admin_password)
reader=$(cat /secrets/reader_password)
ops=$(cat /secrets/ops_password)
plain='org.apache.kafka.common.security.plain.PlainLoginModule required'
self="$plain username=\"admin\" password=\"$admin\" user_admin=\"$admin\";"
users="$plain user_e2e-kafka-reader=\"$reader\" user_e2e-kafka-ops=\"$ops\";"
{
  cat /opt/e2e/server.properties
  echo "ssl.keystore.location=$work/server.pem"
  echo "listener.name.sasl_ssl.plain.sasl.jaas.config=$users"
  echo "listener.name.internal.plain.sasl.jaas.config=$self"
  echo "listener.name.controller.plain.sasl.jaas.config=$self"
} > "$work/server.properties"
cat /secrets/server.key /secrets/server.crt > "$work/server.pem"
printf '%s\n' 'security.protocol=SASL_PLAINTEXT' 'sasl.mechanism=PLAIN' \
  "sasl.jaas.config=$plain username=\"admin\" password=\"$admin\";" > "$work/admin.properties"

cluster=$("$bin/kafka-storage.sh" random-uuid)
"$bin/kafka-storage.sh" format --cluster-id "$cluster" --config "$work/server.properties" >/dev/null

KAFKA_HEAP_OPTS='-Xms256m -Xmx256m' KAFKA_LOG4J_OPTS='-Dlog4j2.configurationFile=/opt/e2e/log4j2.yaml' \
  LOG_DIR=/tmp/kafka-logs EXTRA_ARGS='-name kafkaServer' "$bin/kafka-server-start.sh" "$work/server.properties" &
server=$!
trap 'kill -TERM "$server"; wait "$server"; exit 0' TERM INT

# A tool of Kafka as the user admin, on the loopback listener.
as_admin() {
  local tool=$1
  shift
  "$bin/$tool" --bootstrap-server 127.0.0.1:9092 --command-config "$work/admin.properties" "$@"
}
deadline=$((SECONDS + 180))
until as_admin kafka-topics.sh --list >/dev/null 2>&1; do
  if [ "$SECONDS" -gt "$deadline" ]; then
    echo "kafka did not start within 180 s" >&2
    exit 1
  fi
  sleep 1
done

as_admin kafka-topics.sh --create --topic orders --partitions 3 --replication-factor 1 >/dev/null
as_admin kafka-topics.sh --create --topic payments --partitions 1 --replication-factor 1 >/dev/null
for order in 41 42 43 44 45 46; do
  echo "{\"order\": $order, \"status\": \"paid\"}"
done | as_admin kafka-console-producer.sh --topic orders
printf '%s\n' '{"payment": 9001}' '{"payment": 9002}' | as_admin kafka-console-producer.sh --topic payments
as_admin kafka-consumer-groups.sh --reset-offsets --group billing --topic orders --to-earliest --execute >/dev/null
as_admin kafka-consumer-groups.sh --reset-offsets --group search --topic payments --to-earliest --execute >/dev/null
allow() {
  as_admin kafka-acls.sh --add --allow-principal "User:$1" "${@:2}" >/dev/null
}
allow e2e-kafka-reader --operation Describe --topic '*' --group '*'
allow e2e-kafka-reader --operation DescribeConfigs --topic '*'
allow e2e-kafka-ops --operation Describe --operation DescribeConfigs --topic '*'
allow e2e-kafka-ops --operation Create --topic orders-retry
allow e2e-kafka-ops --operation Read --operation Describe --topic orders --group billing
touch /tmp/seeded
echo "kafka seeded"

wait "$server"
