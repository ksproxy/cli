# MongoDB 7 for the e2e tests: the shop database of the mongodb examples of docs/EXAMPLES.md with its two users (see
# seed.js). Nothing is downloaded here. The server logs every operation to /mongolog/mongod.log (see compose.yaml), a
# volume that the runner reads, so that the driver can show which calls reached the server. The log file is made here,
# readable by the runner; the server appends to it.
FROM mongo:7

RUN install -d -o mongodb -g mongodb -m 0755 /mongolog \
 && install -o mongodb -g mongodb -m 0644 /dev/null /mongolog/mongod.log
COPY seed.js /docker-entrypoint-initdb.d/10-seed.js
RUN chmod 0644 /docker-entrypoint-initdb.d/10-seed.js
