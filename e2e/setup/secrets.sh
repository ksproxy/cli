#!/bin/bash
# Makes every secret of one e2e run in the volume at /secrets, one folder per container, each mounted only into its
# own container: ssh keys and host keys, database passwords, a CA, a certificate for each https or TLS server, bearer
# tokens, the users of Redis and RabbitMQ with hashed passwords, the passwords of Elasticsearch, the users of Kafka
# with their client files, and the tokens of the stand-in gh. Nothing is kept between runs: scripts/e2e.sh removes the
# volume at the end. runner/secrets.json lists every value, so that the driver can show that none of them leaks.
set -euo pipefail
umask 077

out=/secrets
work=$(mktemp -d)
for dir in runner web1 app1 db mcp-remote crm-db cache mongo mq grafana es kafka; do
  mkdir -p "$out/$dir"
done

key() {
  ssh-keygen -q -t ed25519 -N '' -C "$2" -f "$work/$1"
}
key runner_key e2e-runner
key app_key e2e-app
key web1_host web1
key app1_host app1

cp "$work/runner_key" "$out/runner/id_ed25519"
echo "web1 $(cut -d' ' -f1,2 "$work/web1_host.pub")" > "$out/runner/known_hosts"
cp "$work/web1_host" "$out/web1/host_key"
cp "$work/runner_key.pub" "$out/web1/authorized_keys"
cp "$work/app_key" "$out/web1/app_key"
echo "app1 $(cut -d' ' -f1,2 "$work/app1_host.pub")" > "$out/web1/known_hosts"
cp "$work/app1_host" "$out/app1/host_key"
cp "$work/app_key.pub" "$out/app1/authorized_keys"

# secret gives a new secret value; put writes a value to each of the files named after it.
secret() {
  openssl rand -hex 20
}
put() {
  local value=$1
  shift
  for file in "$@"; do
    printf '%s' "$value" > "$out/$file"
  done
}

# PostgreSQL.
put "$(secret)" db/postgres_password
ro=$(secret)
rw=$(secret)
put "$ro" db/agent_ro_password runner/shop_db_password
put "$rw" db/agent_rw_password runner/shop_db_rw_password

# MariaDB: root only from inside its container, and the two logins of the mysql examples.
put "$(secret)" crm-db/root_password
put "$(secret)" crm-db/agent_ro_password
cp "$out/crm-db/agent_ro_password" "$out/runner/crm_db_password"
put "$(secret)" crm-db/agent_rw_password
cp "$out/crm-db/agent_rw_password" "$out/runner/crm_db_rw_password"

# MongoDB: root for the image's setup, and the two users of the mongodb examples, given to the runner as
# connection strings.
put "$(secret)" mongo/root_password
mongo_ro=$(secret)
mongo_rw=$(secret)
put "$mongo_ro" mongo/agent_ro_password
put "$mongo_rw" mongo/agent_rw_password
put "mongodb://agent_ro:$mongo_ro@mongo:27017/shop" runner/orders_mongo_uri
put "mongodb://agent_rw:$mongo_rw@mongo:27017/shop" runner/orders_mongo_rw_uri

# Redis: the two ACL users of the redis examples, with the commands of their rules and PING, which ksproxy
# doctor sends (docs/DOCTOR.md). The server gets only the SHA-256 of each password.
cache_ro=$(secret)
cache_ops=$(secret)
put e2e-cache-reader runner/redis_user
put "$cache_ro" runner/redis_password
put e2e-cache-ops runner/redis_ops_user
put "$cache_ops" runner/redis_ops_password
sha256() {
  printf '%s' "$1" | openssl dgst -sha256 -r | cut -d' ' -f1
}
{
  echo 'user default off resetpass resetkeys resetchannels -@all'
  echo "user e2e-cache-reader on #$(sha256 "$cache_ro") resetkeys ~session:* resetchannels -@all +get +ttl +hgetall +scan +info +ping"
  echo "user e2e-cache-ops on #$(sha256 "$cache_ops") resetkeys %R~* ~cache:page:* ~feature:new-checkout resetchannels -@all +get +ttl +del +set +ping"
} > "$out/cache/users.acl"

# RabbitMQ: the two users of the rabbitmq examples, and e2e-seed, which publishes the seed messages from
# inside its container. The definitions hold the hashes of the passwords.
put e2e-mq-reader runner/mq_user
put "$(secret)" runner/mq_password
put e2e-mq-ops runner/mq_ops_user
put "$(secret)" runner/mq_ops_password
put "$(secret)" mq/seed_password
node /opt/ksproxy/e2e/setup/mq-definitions.js "$out/mq/definitions.json" "$out/runner/mq_password" \
  "$out/runner/mq_ops_password" "$out/mq/seed_password"

# The stand-in Grafana API: a token that may read, and one that may also add annotations.
put "$(secret)" grafana/viewer_token runner/grafana_token
put "$(secret)" grafana/editor_token runner/grafana_notes_token

# Elasticsearch: the password of elastic, which only the seed of its container uses, and the user of the target
# search-rw. The API key of es-logs is made by Elasticsearch at each run (e2e/images/es/start.sh).
put "$(secret)" es/elastic_password
put e2e-search runner/es_search_user
put "$(secret)" es/search_password runner/es_search_password

# Kafka: admin, the broker's own user, which only the broker and its seed use, on its loopback listeners; and the two
# users of the kafka examples, each with the client file that the examples name, over SASL_SSL with the CA of the run.
put "$(secret)" kafka/admin_password
kafka_reader=$(secret)
kafka_ops=$(secret)
put "$kafka_reader" kafka/reader_password
put "$kafka_ops" kafka/ops_password
client_file() {
  local plain='org.apache.kafka.common.security.plain.PlainLoginModule required'
  printf '%s\n' 'security.protocol=SASL_SSL' 'sasl.mechanism=PLAIN' \
    "sasl.jaas.config=$plain username=\"$2\" password=\"$3\";" \
    'ssl.truststore.type=PEM' 'ssl.truststore.location=/secrets/ca.crt' > "$out/runner/$1"
}
client_file kafka-read.properties e2e-kafka-reader "$kafka_reader"
client_file kafka-ops.properties e2e-kafka-ops "$kafka_ops"

# The command examples: the GitHub tokens of the two targets. The stand-in gh reads them to say which one it got.
put "$(secret)" runner/gh_read_token
put "$(secret)" runner/gh_triage_token

# A CA of this run, which only the runner and the servers that check it trust, and a certificate for each server name
# that is reached over https or TLS: also PostgreSQL (db) and MariaDB (crm-db), whose targets check it with caFile.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj '/CN=ksproxy e2e CA' \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
cert() {
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$1" \
    -keyout "$work/$1.key" -out "$work/$1.csr" 2>/dev/null
  printf '%s\n' "subjectAltName=DNS:$1" 'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature' 'extendedKeyUsage=serverAuth' > "$work/$1.ext"
  openssl x509 -req -in "$work/$1.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 2 \
    -extfile "$work/$1.ext" -out "$work/$1.crt" 2>/dev/null
  cp "$work/$1.crt" "$out/$1/server.crt"
  cp "$work/$1.key" "$out/$1/server.key"
}
for name in mcp-remote cache mq grafana es kafka db crm-db; do
  cert "$name"
done
cp "$work/ca.crt" "$out/runner/ca.crt"
cp "$work/ca.crt" "$out/cache/ca.crt"
cp "$work/ca.crt" "$out/mq/ca.crt"
cp "$work/ca.crt" "$out/es/ca.crt"
put "$(secret)" mcp-remote/token
cp "$out/mcp-remote/token" "$out/runner/mcp_token"

# Every secret value of the run. A private key is listed by the lines of its base64 body.
node /opt/ksproxy/e2e/setup/list-secrets.js "$out/runner/secrets.json" \
  "postgres password=$out/db/postgres_password" "agent_ro password=$out/db/agent_ro_password" \
  "agent_rw password=$out/db/agent_rw_password" "mcp token=$out/runner/mcp_token" \
  "mariadb root password=$out/crm-db/root_password" "mariadb agent_ro password=$out/crm-db/agent_ro_password" \
  "mariadb agent_rw password=$out/crm-db/agent_rw_password" "mongo root password=$out/mongo/root_password" \
  "mongo agent_ro password=$out/mongo/agent_ro_password" "mongo agent_rw password=$out/mongo/agent_rw_password" \
  "redis reader password=$out/runner/redis_password" "redis ops password=$out/runner/redis_ops_password" \
  "rabbitmq reader password=$out/runner/mq_password" "rabbitmq ops password=$out/runner/mq_ops_password" \
  "rabbitmq seed password=$out/mq/seed_password" "grafana viewer token=$out/grafana/viewer_token" \
  "grafana editor token=$out/grafana/editor_token" "elastic password=$out/es/elastic_password" \
  "es search password=$out/es/search_password" "kafka admin password=$out/kafka/admin_password" \
  "kafka reader password=$out/kafka/reader_password" "kafka ops password=$out/kafka/ops_password" \
  "gh read token=$out/runner/gh_read_token" "gh triage token=$out/runner/gh_triage_token" \
  "runner key=$work/runner_key" "app key=$work/app_key" "web1 host key=$work/web1_host" \
  "app1 host key=$work/app1_host" "CA key=$work/ca.key" "mcp-remote key=$work/mcp-remote.key" \
  "cache key=$work/cache.key" "mq key=$work/mq.key" "grafana key=$work/grafana.key" "es key=$work/es.key" \
  "kafka key=$work/kafka.key" "db key=$work/db.key" "crm-db key=$work/crm-db.key"

# Each folder belongs to the user that reads it: node (1000) in the runner, mcp-remote and grafana, elasticsearch (1000)
# in es, and appuser (1000) in kafka; postgres, mysql, mongodb and rabbitmq (999) in db, crm-db, mongo and mq; redis
# (999, group 1000) in cache; root on the ssh servers, which copy their files into place.
chown -R 1000:1000 "$out/runner" "$out/mcp-remote" "$out/grafana" "$out/es" "$out/kafka"
chown -R 999:999 "$out/db" "$out/crm-db" "$out/mongo" "$out/mq"
chown -R 999:1000 "$out/cache"
chmod 0700 "$out"/*
echo "secrets made"
