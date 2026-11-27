# The image of the runner, which runs ksproxy and the driver, and of the one-shot service make-secrets, the second
# client (peer) and the remote MCP server. Built from the repository root (see compose.yaml). Downloads happen here, at
# build: postgresql-client-17 from apt.postgresql.org, @modelcontextprotocol/server-everything with its dependencies,
# and mariadb-client and openjdk-17-jre-headless from Debian. mongosh is copied from the image mongo:7, the Kafka
# command-line clients from the image apache/kafka, and kubectl from the image rancher/k3s.

# The signing key of apt.postgresql.org, as the postgres image already holds it.
FROM postgres:17-bookworm AS pgdg

# The Kafka clients: their scripts, their libraries and the log settings of the tools. They need Java 17 or later.
FROM apache/kafka:4.4.0 AS kafka

# The client of the kubernetes kind: k3s is one program that runs as kubectl when it is called by that name. The same
# version as the cluster in e2e/images/k3s.
FROM rancher/k3s:v1.37.2-k3s1 AS k3s

FROM node:24

COPY --from=pgdg /usr/local/share/keyrings/postgres.gpg.asc /usr/local/share/keyrings/postgres.gpg.asc

# node:24 already has openssh-client, openssl, script (util-linux) and ca-certificates. Its libpq-dev is pinned to
# the libpq of Debian, which postgresql-client-17 replaces, so it goes first. apt checks every package against the
# key, so the repository is read over plain http, as the postgres image does.
RUN set -eux; \
    echo 'deb [signed-by=/usr/local/share/keyrings/postgres.gpg.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get purge -y libpq-dev; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-17; \
    rm -rf /var/lib/apt/lists/*; \
    install -d -o node -g node -m 0700 /handoff /home/node/.ssh /home/node/out

# The MCP server, in the npx cache of the user node, so that npx runs it later with npm_config_offline=true and no
# network. It is started once here with the same words as in the inventory, so that the cache holds what that npx
# looks up; the server stops when its input ends. The build secret build_ca is the CA file of a proxy that replaces
# TLS certificates (scripts/e2e.sh passes NODE_EXTRA_CA_CERTS of the host, or an empty file); it is used for this
# download only and is not kept in the image.
USER node
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN --mount=type=secret,id=build_ca,uid=1000 \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npx -y @modelcontextprotocol/server-everything@2.3.1 stdio </dev/null

COPY --chown=root:root e2e/images/runner/user-config /home/node/.ssh/config

# The clients of the mysql and mongodb kinds: mariadb-client of Debian, which has the programs mariadb and mysql, and
# mongosh, one program that needs no other file. They come after the layers above, so that a change here keeps those.
USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends mariadb-client; \
    rm -rf /var/lib/apt/lists/*
COPY --from=mongo:7 /usr/bin/mongosh /usr/local/bin/mongosh

# The clients of the kafka kind, in /opt/kafka/bin as in the examples, and the Java runtime of Debian that they run on.
# ksproxy passes them no JAVA_HOME, so java must be on the PATH, as Debian puts it. ~/secrets is the folder of the
# examples' client files; here it is /secrets, where the files of the run are mounted.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends openjdk-17-jre-headless; \
    rm -rf /var/lib/apt/lists/*; \
    ln -s /secrets /home/node/secrets
COPY --from=kafka /opt/kafka/bin /opt/kafka/bin
COPY --from=kafka /opt/kafka/libs /opt/kafka/libs
COPY --from=kafka /opt/kafka/config/tools-log4j2.yaml /opt/kafka/config/tools-log4j2.yaml

# kubectl, for the kubernetes examples: the program of k3s by that name, which needs no other file. ~/.kube is where the
# examples keep their kubeconfigs; the driver copies those of the run there from /kube.
COPY --from=k3s /bin/k3s /usr/local/bin/kubectl
RUN install -d -o node -g node -m 0700 /home/node/.kube

# A stand-in for the GitHub CLI, for the command examples (see the file).
COPY --chmod=0755 e2e/images/runner/gh /usr/local/bin/gh

# ksproxy from this checkout, as "From a checkout" in the README, and the e2e scripts. These change most, so they come
# last.
COPY package.json /opt/ksproxy/package.json
COPY bin /opt/ksproxy/bin
COPY src /opt/ksproxy/src
COPY e2e/setup /opt/ksproxy/e2e/setup
COPY e2e/driver /opt/ksproxy/e2e/driver
RUN chmod 0644 /home/node/.ssh/config && ln -s /opt/ksproxy/bin/ksproxy.js /usr/local/bin/ksproxy
USER node
WORKDIR /home/node
