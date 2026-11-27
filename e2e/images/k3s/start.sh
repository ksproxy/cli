#!/bin/sh
# Starts k3s as the one server node of the e2e cluster, with the seed (seed.sh) beside it.
#   - The images of the cluster are in /e2e/images.tar; k3s imports every file of agent/images when it starts.
#   - Only what the tests use runs: coredns and metrics-server, but not traefik, servicelb, local-storage, the Gateway
#     API resources, the Helm controller or the network policy controller.
#   - The API server writes its audit log to /k3slog/audit.log, with the policy of audit-policy.yaml. The file is made
#     first with mode 0644, so that the runner (the user node) may read it.
#   - The compose network is internal, so the container has no default route, from which k3s would take its address:
#     the address of eth0 is given to it.
# k3s runs as process 1 (exec), since it then moves the processes of the container into a cgroup of their own, which
# lets it use the cgroup v2 controllers.
set -eu

data=/var/lib/rancher/k3s
mkdir -p "$data/agent/images" /k3slog
ln -sf /e2e/images.tar "$data/agent/images/e2e.tar"
touch /k3slog/audit.log
chmod 0644 /k3slog/audit.log

address=$(ip -4 -o addr show dev eth0 | awk '{ split($4, a, "/"); print a[1] }')
if [ -z "$address" ]; then
  echo "start: eth0 has no IPv4 address" >&2
  exit 1
fi

/e2e/seed.sh &

exec k3s server \
  --node-name k3s \
  --node-ip "$address" \
  --advertise-address "$address" \
  --flannel-iface eth0 \
  --tls-san k3s \
  --disable traefik \
  --disable servicelb \
  --disable local-storage \
  --disable gateway-api-crd \
  --disable-helm-controller \
  --disable-network-policy \
  --kube-apiserver-arg audit-policy-file=/e2e/audit-policy.yaml \
  --kube-apiserver-arg audit-log-path=/k3slog/audit.log
