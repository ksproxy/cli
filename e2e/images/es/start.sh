#!/bin/bash
# Starts the e2e node and seeds it as the user elastic, whose password of the run the image's entrypoint sets
# (ELASTIC_PASSWORD_FILE). Once the node answers over https, the seed makes:
#   - the indices logs-2026.11 (3 documents, 2 with level error) and logs-2026.10 (2 documents), and products
#     (sku-1042, a desk lamp with stock 12; sku-7, a notebook with stock 40; sku-13, a pen with stock 100);
#   - the role products-rw (cluster monitor; read and index on products) and the user e2e-search with it, for the
#     target search-rw, with the password of the run;
#   - an API key for the target es-logs (cluster monitor; read, view_index_metadata and monitor on logs-*).
#     Elasticsearch makes the key, so the seed writes it to /esout/api_key, which the runner reads.
# Then /tmp/seeded is made, which the health check waits for. The driver expects the same values.
set -euo pipefail
umask 077

certs=/usr/share/elasticsearch/config/certs
work=$(mktemp -d)
printf 'user = "elastic:%s"\n' "$(cat "$certs/elastic_password")" > "$work/curlrc"

/usr/local/bin/docker-entrypoint.sh eswrapper &
server=$!
trap 'kill -TERM "$server"; wait "$server"; exit 0' TERM INT

# call METHOD PATH [BODY]: one request as elastic, over https with the CA of the run. A BODY of @FILE is read from FILE.
call() {
  local data=()
  if [ $# -gt 2 ]; then
    data=(--data-binary "$3")
  fi
  curl --config "$work/curlrc" --silent --show-error --fail-with-body --cacert "$certs/ca.crt" \
    --resolve es:9200:127.0.0.1 -X "$1" -H 'Content-Type: application/json' "https://es:9200$2" "${data[@]}"
}
deadline=$((SECONDS + 300))
until call GET '/_cluster/health?wait_for_status=yellow&timeout=5s' >/dev/null 2>&1; do
  if [ "$SECONDS" -gt "$deadline" ]; then
    echo "elasticsearch did not start within 300 s" >&2
    exit 1
  fi
  sleep 2
done

one_shard='"settings": {"number_of_shards": 1, "number_of_replicas": 0}'
logs='{'"$one_shard"', "mappings": {"properties": {"@timestamp": {"type": "date"}, "service": {"type": "keyword"},
  "level": {"type": "keyword"}, "message": {"type": "text"}}}}'
call PUT /logs-2026.11 "$logs" >/dev/null
call PUT /logs-2026.10 "$logs" >/dev/null
call PUT /products '{'"$one_shard"', "mappings": {"properties": {"name": {"type": "text"},
  "stock": {"type": "integer"}, "price": {"type": "float"}}}}' >/dev/null
cat > "$work/bulk.ndjson" <<'EOF'
{"index": {"_index": "logs-2026.11", "_id": "1"}}
{"@timestamp": "2026-11-24T10:00:00Z", "service": "checkout", "level": "error", "message": "payment timeout for order 41"}
{"index": {"_index": "logs-2026.11", "_id": "2"}}
{"@timestamp": "2026-11-24T10:05:00Z", "service": "checkout", "level": "info", "message": "order 42 paid"}
{"index": {"_index": "logs-2026.11", "_id": "3"}}
{"@timestamp": "2026-11-24T10:07:00Z", "service": "search", "level": "error", "message": "index products is slow"}
{"index": {"_index": "logs-2026.10", "_id": "1"}}
{"@timestamp": "2026-10-30T08:00:00Z", "service": "checkout", "level": "info", "message": "order 40 paid"}
{"index": {"_index": "logs-2026.10", "_id": "2"}}
{"@timestamp": "2026-10-31T09:00:00Z", "service": "search", "level": "warn", "message": "cache miss rate high"}
{"index": {"_index": "products", "_id": "sku-1042"}}
{"name": "Desk lamp", "stock": 12, "price": 39.5}
{"index": {"_index": "products", "_id": "sku-7"}}
{"name": "Notebook", "stock": 40, "price": 3.2}
{"index": {"_index": "products", "_id": "sku-13"}}
{"name": "Pen", "stock": 100, "price": 1.1}
EOF
bulk=$(call POST '/_bulk?refresh=true' "@$work/bulk.ndjson")
if [[ "$bulk" != *'"errors":false'* ]]; then
  echo "the seed documents were not all written: $bulk" >&2
  exit 1
fi

call POST /_security/role/products-rw '{"cluster": ["monitor"],
  "indices": [{"names": ["products"], "privileges": ["read", "index"]}]}' >/dev/null
search_password=$(cat "$certs/search_password")
call POST /_security/user/e2e-search "{\"password\": \"$search_password\", \"roles\": [\"products-rw\"]}" >/dev/null
key=$(call POST /_security/api_key '{"name": "es-logs", "role_descriptors": {"logs-read": {"cluster": ["monitor"],
  "indices": [{"names": ["logs-*"], "privileges": ["read", "view_index_metadata", "monitor"]}]}}}')
encoded=$(printf '%s' "$key" | grep -o '"encoded":"[^"]*"' | cut -d'"' -f4)
if [ -z "$encoded" ]; then
  echo "no API key was made" >&2
  exit 1
fi
printf '%s' "$encoded" > /esout/api_key
touch /tmp/seeded
echo "es seeded"

wait "$server"
