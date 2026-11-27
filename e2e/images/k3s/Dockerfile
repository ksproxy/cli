# k3s for the e2e tests: the cluster of the kubernetes examples of docs/EXAMPLES.md, one server node, with the
# namespace shop, the deployment web and the two identities of the examples made at each run (see start.sh and
# seed.sh). The image is rancher/k3s; nothing is downloaded here. The images that the cluster runs come from the
# build context airgap: scripts/e2e.sh saves them there to images.tar (the system images that this version of k3s
# names, and redis:7-alpine for web), and k3s imports the file into its own image store when it starts, so no pod
# pulls an image. A new version of k3s may name other system images: update the list in scripts/e2e.sh with it.
FROM rancher/k3s:v1.37.2-k3s1

COPY --from=airgap images.tar /e2e/images.tar
COPY start.sh seed.sh shop.yaml audit-policy.yaml /e2e/
RUN chmod 0644 /e2e/images.tar /e2e/shop.yaml /e2e/audit-policy.yaml && chmod 0755 /e2e/start.sh /e2e/seed.sh

ENTRYPOINT ["/e2e/start.sh"]
