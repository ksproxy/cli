#!/usr/bin/env bash
# Runs the end-to-end tests in Docker (see "End-to-end tests" in docs/DEVELOPMENT.md): saves the images that k3s runs,
# builds the images of e2e/compose.yaml, then runs each group of servers (a compose profile) from a clean state: starts
# its containers and waits until they are healthy, runs the driver in the runner, saves the logs to e2e/logs/GROUP when
# anything fails (with the logs of the servers that record each call), and removes the containers, networks and volumes
# of this compose project. The groups run one after the other because all the servers at once need more memory than a
# small Docker machine has.
# Exits with 1 when anything fails. Needs Docker with the compose plugin; downloads happen only while the images are
# built, and when an image that k3s runs is missing (see save_k3s_images).
#
# Behind a proxy that replaces TLS certificates, set NODE_EXTRA_CA_CERTS to the proxy's CA file, as for Node: the
# build uses it for the npm download only, and no image keeps it.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
logs="$root/e2e/logs"
groups=(a b c)
compose=(docker compose --project-name ksproxy-e2e --file "$root/e2e/compose.yaml")
# Every profile, so that a command sees the containers of every group.
every=()
for group in "${groups[@]}"; do
  every+=(--profile "$group")
done
began=$(date +%s)

# The images that the k3s of group c runs (see e2e/images/k3s/Dockerfile): the system images that its version names,
# and the image of the deployment web. They go to the build context airgap of the k3s image.
k3s_images=(rancher/mirrored-pause:3.10.2 rancher/mirrored-coredns-coredns:1.14.7 rancher/mirrored-metrics-server:v0.9.0
  redis:7-alpine)
airgap=$(mktemp -d)
export E2E_K3S_IMAGES="$airgap"

empty_ca=$(mktemp)
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$NODE_EXTRA_CA_CERTS" ]; then
  export E2E_BUILD_CA="$NODE_EXTRA_CA_CERTS"
else
  export E2E_BUILD_CA="$empty_ca"
fi

remove_all() {
  "${compose[@]}" "${every[@]}" down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
}
finish() {
  remove_all
  rm -f -- "$empty_ca"
  rm -rf -- "$airgap"
}
trap finish EXIT

# save_logs GROUP
save_logs() {
  local dir="$logs/$1"
  mkdir -p "$dir"
  "${compose[@]}" "${every[@]}" ps --all >"$dir/containers.txt" 2>&1 || true
  "${compose[@]}" "${every[@]}" logs --no-color --timestamps >"$dir/containers.log" 2>&1 || true
  "${compose[@]}" "${every[@]}" cp runner:/home/node/out "$dir/runner" >/dev/null 2>&1 || true
  # The logs of the servers that record each call: SERVICE:FOLDER:NAME IN THE LOGS.
  local entry service from to
  for entry in db:/pglog:postgres crm-db:/mylog:mariadb mongo:/mongolog:mongodb mq:/mqlog:rabbitmq \
    grafana:/httplog:http es:/eslog:elasticsearch kafka:/kafkalog:kafka k3s:/k3slog:kube-apiserver; do
    IFS=: read -r service from to <<<"$entry"
    "${compose[@]}" "${every[@]}" cp "$service:$from" "$dir/$to" >/dev/null 2>&1 || true
  done
  echo "e2e: logs of group $1 saved in $dir" >&2
}

# save_k3s_images: pulls each image of k3s_images that Docker does not have yet, for the platform of the Docker server,
# and saves them all to images.tar in the folder airgap. It is called with ||, where set -e does not apply, so each
# step returns on its own failure.
save_k3s_images() {
  local platform image
  platform=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}') || return 1
  for image in "${k3s_images[@]}"; do
    docker image inspect "$image" >/dev/null 2>&1 || docker pull --platform "$platform" "$image" || return 1
  done
  docker save --platform "$platform" --output "$airgap/images.tar" "${k3s_images[@]}"
}

# No logs of an earlier run.
rm -rf -- "$logs"

status=0
save_k3s_images || status=$?
if [ "$status" -eq 0 ]; then
  "${compose[@]}" "${every[@]}" build || status=$?
fi
failed=()
if [ "$status" -eq 0 ]; then
  for group in "${groups[@]}"; do
    # A clean start: no container or volume of an earlier group or run.
    remove_all
    started=$(date +%s)
    echo "e2e: group $group"
    result=0
    "${compose[@]}" --profile "$group" up --detach --wait --wait-timeout 300 --no-build --pull never || result=$?
    if [ "$result" -eq 0 ]; then
      "${compose[@]}" exec -T runner node /opt/ksproxy/e2e/driver/main.js "$group" || result=$?
    fi
    if [ "$result" -ne 0 ]; then
      save_logs "$group"
      failed+=("$group")
      status=1
    fi
    echo "e2e: group $group $([ "$result" -eq 0 ] && echo passed || echo FAILED) in $(($(date +%s) - started)) s"
  done
fi

seconds=$(($(date +%s) - began))
if [ "$status" -eq 0 ]; then
  echo "e2e: passed in ${seconds} s"
else
  echo "e2e: FAILED in ${seconds} s${failed[*]:+ (group ${failed[*]})}" >&2
  exit 1
fi
