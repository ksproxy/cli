#!/bin/sh
# The seed of the e2e cluster, which start.sh runs beside k3s. As admin (the kubeconfig that k3s writes, which never
# leaves this container), it:
#   - waits until the API server answers and the node is ready;
#   - applies shop.yaml and waits until the deployment web runs;
#   - makes a token of this run for lab-viewer and one for lab-deployer (2 hours), and writes for each a kubeconfig with
#     the token and the CA of the cluster to /kube, the volume that the runner reads: lab-viewer.yaml and
#     lab-deployer.yaml, owned by the user node of the runner (1000), mode 0600;
#   - waits until metrics-server has the usage of the pods of shop, which kubectl top pods needs.
# Then /tmp/seeded is made, which the health check waits for. When a step fails or takes too long, the seed shows the
# state of the cluster and stops k3s, so the container ends and the run fails at once.
set -eu
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

fail() {
  echo "seed: $*" >&2
  kubectl get nodes,pods --all-namespaces -o wide >&2 || true
  kubectl get events --all-namespaces >&2 || true
  kill -TERM 1
  exit 1
}

# until_ok SECONDS WHAT COMMAND...: runs COMMAND every 2 s until it succeeds, for at most SECONDS.
until_ok() {
  limit=$(($(date +%s) + $1))
  what=$2
  shift 2
  until "$@" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$limit" ]; then
      fail "timed out waiting for $what"
    fi
    sleep 2
  done
}

until_ok 180 'the API server' kubectl get --raw /readyz
until_ok 120 'the node to be ready' kubectl wait --for=condition=Ready node/k3s --timeout=5s
kubectl apply -f /e2e/shop.yaml
until_ok 180 'the deployment web' kubectl --namespace shop rollout status deployment/web --timeout=5s

ca=$(base64 -w 0 /var/lib/rancher/k3s/server/tls/server-ca.crt)
umask 077
for name in lab-viewer lab-deployer; do
  token=$(kubectl --namespace shop create token "$name" --duration 2h) || fail "no token for $name"
  cat > "/kube/$name.yaml" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: lab
  cluster:
    server: https://k3s:6443
    certificate-authority-data: $ca
users:
- name: $name
  user:
    token: $token
contexts:
- name: $name
  context:
    cluster: lab
    user: $name
    namespace: shop
current-context: $name
EOF
done
chown -R 1000:1000 /kube
chmod 0700 /kube

top_of_shop() {
  kubectl top pods --namespace shop --no-headers | grep -q '^web-'
}
until_ok 240 'the usage of the pods of shop in metrics-server' top_of_shop

touch /tmp/seeded
echo "seed: the cluster is ready"
