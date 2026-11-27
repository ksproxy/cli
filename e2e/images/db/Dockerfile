# PostgreSQL 17 for the e2e tests: the shop database of docs/EXAMPLES.md with its two roles. Every statement is logged
# to /pglog/postgresql.log (see compose.yaml), a volume that the runner reads, so the driver can show that a refused
# statement never reached the server. The folder is made here so that the volume takes its owner.
FROM postgres:17-bookworm

RUN install -d -o postgres -g postgres -m 0755 /pglog
COPY seed.sh /docker-entrypoint-initdb.d/10-seed.sh
