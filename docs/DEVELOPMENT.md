# Development: tests and coverage

The README has the short version. This page lists how the tests run, how to find code that no test reaches, the stand-in programs the tests use, and the end-to-end tests in Docker.

```
npm test
```

**Contents**

- [The layout](#the-layout)
- [Coverage](#coverage)
- [Stand-in programs](#stand-in-programs)
- [End-to-end tests](#end-to-end-tests)

## The layout

- The complete logic, module by module, is drawn as Mermaid diagrams in [LOGIC.md](LOGIC.md). `test/logic-docs.test.js` fails when a module or an exported function is missing from it.
- Each kind of target is one folder, and the core walks the list of kinds. How to add a kind is in [KINDS.md](KINDS.md).

```
src/kinds/index.js         the ordered list of kinds
src/kinds/<name>/index.js  one kind: ssh, kubernetes, local or one of the service kinds
src/kinds/<name>/*.js      the mechanics of that kind (master.js, cluster.js, folder.js)
src/kinds/engines/*.js     what several kinds share (http, http-service, command, resp, sql, sql-service, mcp-client, doctor)
src/*.js                   the core: inventory, start, tools, review, audit, cli
test/fixtures/kind-echo.js a test-only kind, the smallest example
```

## Coverage

- **No dependencies to install.** `package.json` has none, and tests use only `node:test` and `node:assert/strict`.
- **Coverage must stay at 100%.** `npm test` runs `node --test` with Node's built-in coverage over `src/` and `bin/`, and it fails when line, branch or function coverage is below 100%. A change that adds code needs tests that reach it.
- **Finding missed lines.** Run the suite with the coverage report and read the "uncovered lines" column. Quote the globs so Node, not the shell, expands them:

  ```
  node --test --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-include='bin/**' 'test/*.test.js'
  ```

- **Finding missed branches.** Branch gaps do not show up in that column. A file below 100% in "branch %" has an untested `if`, `?:`, `??` or `catch`, so read the code around its other lines. For a per-branch listing, add `--test-reporter=lcov --test-reporter-destination=coverage.lcov` and look for `BRDA` entries that end in `,0`.
- **Most tests call the code in the test's own process,** so the coverage counts. `start` and `main` take an optional last argument (a process-like object, and for `start` also the checkbox, the health probe and the close time limits), which the tests use to drive signals, streams and timers; the defaults are the real ones.
- **Only `bin/ksproxy.js` runs in a child process,** and its coverage reaches the report because those tests pass `NODE_V8_COVERAGE` through to the child.

## Stand-in programs

No test of `npm test` contacts a real server or cluster. `ssh` and `kubectl` are replaced through `KSPROXY_SSH` and `KSPROXY_KUBECTL` with the stubs in `test/fixtures/`. The service kinds have stand-ins too: `fake-psql.js`, `fake-mysql.js`, `fake-mongosh.js`, `fake-client.js` and `fake-kafka.js` for the client programs, `resp-server.js` for Redis, `mcp-server.js` for an MCP server, and `self-signed.js` for the TLS tests. The first four stubs are:

| Stub | What it does |
|---|---|
| `fake-ssh.js` | Creates and removes the control socket file and answers `-O check` and `-O exit`. It prints `ran <name> <command>` for an exec, and `fail` and `slow` commands give exit 3 and a 10 second wait. `KSPROXY_FAKE_SSH_CHECK_MS` delays each `-O check` answer, and `KSPROXY_FAKE_SSH_TRACE` appends `begin` and `end` to a file around it, which the health-check test uses to show that two checks never overlap. |
| `fake-kubectl.js` | Listens on the `--port` given to `proxy` and answers every request with `KSPROXY_FAKE_KUBECTL_STATUS` (default 200). For any other call it prints its arguments as JSON. |
| `fake-ssh-nostay.js` | Opens a master without leaving a socket, so `-O check` fails. |
| `fake-ssh-flood.js` | Prints 300000 bytes. |

- **No test touches your home folder.** Each test passes its own environment with `KSPROXY_CONFIG_DIR` and `KSPROXY_STATE_DIR` pointing into a fresh directory under `/tmp`.
- **Real programs in temporary folders.** The local-target tests run real programs (`cat`, `ls`, `env` and small node scripts) in temporary folders.

## End-to-end tests

The end-to-end tests run ksproxy against real programs and real servers, each in its own Docker container. They are not part of `npm test` or of its coverage, and they add no npm dependency.

```
scripts/e2e.sh
```

- **What they cover.** The `ssh`, `postgres`, `mysql`, `redis`, `mongodb`, `rabbitmq`, `http`, `elasticsearch`, `kafka`, `command`, `mcp` and `kubernetes` entries of [EXAMPLES.md](EXAMPLES.md) with their allowed and refused calls, sent through `ksproxy mcp` as an agent sends them; `jumps` to a server that only the first server reaches; a local MCP server through a pinned `npx`, and a remote one over https with a bearer token; `--listen`, called from a second container with the token, a wrong token and none; `ksproxy doctor`, and that neither `start` nor `doctor` leaves a process behind; the TLS of the `postgres` and `mysql` targets: each call uses TLS with the certificate checked against `caFile`, the server logs show TLS for every login, and targets without `caFile` (in a project of their own) are skipped by `start` and fail in `doctor` with the reason of [SERVICES.md](SERVICES.md#postgres), except a `require` target of psql, which works; an answer past the output limit: a long seeded log on `web1` read with `tail` gives its total size, the cut marker and its last line, and a large `postgres` result says that psql was stopped at the limit, with the hint of the kind; and that no secret of the run appears in an answer, the audit log, the session folder or the terminal of `start`.
- **Kubernetes.** The kubectl gate refuses `exec`, `port-forward`, `cp`, secrets, `create token`, `--kubeconfig`, `--context` and `--token`, and a scale outside 1 to 5. `rollout restart` makes a new pod, `scale` gives 3 ready pods and then 1 again, and `top pods` shows the usage that metrics-server measured. `kubectl proxy` itself refuses the paths for secrets, pod exec, attach and port-forward, and service account tokens, as [RULES.md](RULES.md#the-kubernetes-command-gate) says.
- **A refused call never reaches the server.** PostgreSQL and MariaDB log every statement, MongoDB every operation, the RabbitMQ management API, the http API and Elasticsearch every request, and the Kafka broker every decision of its authorizer, so the tests show that each allowed call is in the server's log and no refused one is. For Redis, the command statistics of the server show the same. For `command`, a stand-in `gh` records each run, so the tests show that an allowed call runs it with the token of its target and that a refused call never starts it. The Kubernetes API server writes an audit log of every request of the two identities of the examples, with its body, and of every request without a valid identity.
- **The account is the boundary.** Where a rule allows more than the account may do, the server refuses: a read-only transaction stops a function that writes in PostgreSQL and in MariaDB, the Redis ACL of a user stops a key that the rule `GET *` lets through, the API key of `es-logs` stops a search of `products` and of `.security`, the Kafka ACLs of `kafka-ops` stop `groups --describe --group search`, and the role `view` of `lab`, bound in the namespace `shop` only, stops `get pods -n kube-system` (403).
- **The servers.** PostgreSQL 17 with `psql` 17 and MariaDB 11.4 with `mariadb-client` 10.11 of Debian, both over TLS with a certificate of the CA of the run, one MariaDB target through the program `mysql` (which is the MariaDB client there) and two through `mariadb`; Redis 7 over TLS with an ACL user per target; MongoDB 7 with `mongosh` copied from its image; RabbitMQ 3.10.5 with its management API over https, an old version but the one at hand; a small stand-in for the Grafana API in plain Node over https, since the `http` kind needs https for any host but the machine itself; Elasticsearch 8.19, one node with security on and https, with an API key that it makes at each run; and Kafka 4.4 in KRaft mode, one node, with SASL PLAIN over TLS and ACLs, and the Kafka clients of its image on Java 17 of Debian. One node holds one copy of a partition, so `kafka-ops` has one more rule than the example, with `--replication-factor 1`.
- **The cluster.** k3s 1.37, one server node with `coredns` and `metrics-server` but without `traefik`, `servicelb` or `local-storage`. The namespace `shop` holds the deployment `web` (`redis:7-alpine`) and a ServiceAccount for each example: `lab-viewer` with the role `view` in `shop`, and `lab-deployer` with `view` and a role that may only patch the deployment `web` and its scale. Each gets a token at each run, in a kubeconfig with the CA of the cluster, which the driver puts in `~/.kube` of the runner as the examples name it; the admin's kubeconfig never leaves the k3s container. The runner's `kubectl` is the program of the same k3s, which runs as `kubectl` when it is called by that name.
- **Three groups.** All the servers at once need more memory than a small Docker machine has, so they run in three groups, compose profiles that `scripts/e2e.sh` runs one after the other, each from a clean state: `a` with `ssh`, `postgres`, `mysql`, `redis`, `mongodb`, `rabbitmq`, `http`, `mcp` and `--listen`, `b` with `elasticsearch`, `kafka` and `command`, and `c` with `kubernetes`. Each group has its own session, `doctor` and leak check.
- **One privileged container.** k3s runs containerd, the kubelet and kube-proxy, which mount file systems, make cgroups and network namespaces for the pods and write iptables rules, so its container is `privileged`. No other container has extra rights. Its network is internal like the others, and it holds no kernel modules, so it loads none into the Docker machine. GitHub's runners allow privileged containers.
- **No image is pulled during the run.** `scripts/e2e.sh` saves the images that k3s runs, its system images and `redis:7-alpine`, to a file in the build context of the k3s image, and k3s imports the file into its own image store when it starts. `web` has `imagePullPolicy: Never`, and its events show that the image was already on the node.
- **How a run goes.** `scripts/e2e.sh` saves the images that k3s runs, builds the images of `e2e/compose.yaml`, then for each group starts its containers with `docker compose up --wait`, runs the driver (`e2e/driver/main.js`, plain Node) in the runner container, and removes the containers, networks and volumes of the compose project `ksproxy-e2e`. It prints one line per check and exits with 1 when one fails; the logs of that group, the servers' logs included, are then in `e2e/logs/GROUP/`. Once the images are built, a run takes 2 to 3 minutes: 15 to 30 seconds for group `a`, 1 to 1.5 minutes for group `b`, where Elasticsearch takes about 30 seconds to start, and about 50 seconds for group `c`, where k3s takes about 40 seconds to start and to measure the usage of its pods.
- **What they need.** Docker with the compose plugin, the image `node:24`, and about 2 GB of memory: each group needs up to about 2 GB, the sum of the peaks of its containers; group `c` needs about 1 GB: k3s uses about 500 MB and its file cache fills the rest of its limit of 1 GB, and the runner uses up to about 230 MB. Each container also has a memory limit.
- **Downloads happen only at build:** the images `postgres:17-bookworm`, `mariadb:11.4`, `redis:7-alpine`, `mongo:7`, `rabbitmq:3.10.5-management`, `elasticsearch:8.19.25` and `apache/kafka:4.4.0`, `openssh-server`, `mariadb-client` and `openjdk-17-jre-headless` from Debian, `postgresql-client-17` from apt.postgresql.org, `@modelcontextprotocol/server-everything` with its dependencies, and `rancher/k3s:v1.37.2-k3s1` (85 MB). `scripts/e2e.sh` pulls the system images that this k3s names when Docker does not have them: `rancher/mirrored-pause:3.10.2`, `rancher/mirrored-coredns-coredns:1.14.7` and `rancher/mirrored-metrics-server:v0.9.0` (43 MB together). A new version of k3s may name other images: update the list in `scripts/e2e.sh` with it. The networks of the containers are internal, so nothing reaches the internet during the run, and no port is published to the host.
- **No real credential.** Every key, password, certificate and token is made for each run and removed with the volumes. The tokens of the ServiceAccounts are made by the cluster, and the leak check looks for them too, also in the audit log of the API server.
- **Behind a proxy that replaces TLS certificates,** set `NODE_EXTRA_CA_CERTS` to its CA file, as for Node. The build uses it for the npm download only, and no image keeps it. Such a proxy can break the download links of docker.elastic.co, so the Elasticsearch image is the copy on Docker Hub (the Docker Official Image).
- **On GitHub,** the workflow `e2e` runs `scripts/e2e.sh` when you start it by hand.
